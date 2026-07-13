// 渲染进程 · 叶子终端:把一个 DOM 宿主元素变成 xterm 终端,并接入主进程 PTY。
//
// 一个"叶子"= 一个 LeafTerminal 实例。它负责:
//   - 创建 xterm(+ FitAddon 自适应 + 可选 WebglAddon 加速);
//   - 通过 window.ptyBridge 创建 PTY 会话,双向搬运数据:
//       PTY.onData  -> term.write     (终端输出)
//       term.onData -> bridge.input   (用户键入)
//   - fit() 时把新的 cols/rows 同步给 PTY(bridge.resize);
//   - dispose() 时解绑 IPC 订阅并 kill 会话。
//
// 与 PaneCore(pane.js)集成:createLayout 的 onLeafMount(leaf) 里对
// leaf.el 调用 createLeafTerminal,把返回的句柄存到 leaf.data;onResize 里
// 对每个叶子的句柄调用 fit()。见文件末尾的 attachToPaneLayout 便捷封装。
//
// 依赖(由 index.html 以 UMD 方式挂到 window):Terminal / FitAddon / WebglAddon。
// 桥接依赖(由 preload.js 注入):window.ptyBridge。

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // 便于 Node 侧做纯逻辑引用/自测
  }
  if (typeof window !== 'undefined') {
    window.LeafTerminal = api; // 浏览器渲染进程
  }
})(this, function () {
  'use strict';

  const DEFAULT_THEME = {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
  };

  // 创建一个绑定到 host 元素的终端叶子。
  //   host     承载终端的 DOM 元素(应已挂到文档中并具有尺寸)
  //   options  { fontFamily, fontSize, theme, shell, cwd, env, onExit, onTitle, onFocus }
  //            onFocus(): 该终端获得键盘焦点时回调(供窗格树标记当前焦点窗格)
  // 返回句柄:{ id, term, fit, focus, write, dispose, isReady }
  function createLeafTerminal(host, options) {
    options = options || {};

    const bridge = typeof window !== 'undefined' ? window.ptyBridge : null;

    // 1) xterm 实例
    const term = new Terminal({
      fontFamily: options.fontFamily || 'Menlo, Consolas, "Cascadia Mono", monospace',
      fontSize: options.fontSize || 14,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: options.scrollback || 5000,
      theme: options.theme || DEFAULT_THEME,
    });

    // 2) FitAddon:让终端网格随容器尺寸自适应
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    term.open(host);

    // 3) 尝试 WebGL 加速,失败则回退默认渲染
    try {
      const webgl = new WebglAddon.WebglAddon();
      // WebGL 上下文丢失(GPU 驱动重置、显卡切换、长时间隐藏)时自动卸载加速插件,
      // 让 xterm 回退到默认 canvas/DOM 渲染,避免终端变白屏。
      if (typeof webgl.onContextLoss === 'function') {
        webgl.onContextLoss(() => {
          try {
            webgl.dispose();
          } catch (e) {
            /* 忽略 */
          }
        });
      }
      term.loadAddon(webgl);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[terminal] WebGL 不可用,使用默认渲染:', err.message);
    }

    // 首次 fit(host 需已有尺寸;若为 0 会在后续 onResize 再 fit)
    safeFit();

    let sessionId = null;
    let disposed = false;
    const cleanups = [];

    // 容器尺寸变化时自动 fit:用 ResizeObserver 让终端网格跟随窗格布局/窗口尺寸变化,
    // 不必依赖外部显式调用 fit()。用 rAF 合并高频回调,避免拖拽分隔条时频繁 resize。
    if (typeof ResizeObserver !== 'undefined') {
      let rafPending = false;
      const ro = new ResizeObserver(() => {
        if (rafPending) return;
        rafPending = true;
        const run = () => {
          rafPending = false;
          fit();
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else run();
      });
      ro.observe(host);
      cleanups.push(() => ro.disconnect());
    }

    // 焦点上报:用户点击 / Tab 进入该终端时通知调用方(供窗格树标记当前焦点窗格,
    // navigate / swap / move 均以焦点窗格为基准)。xterm 的可聚焦元素是其内部 textarea。
    if (typeof options.onFocus === 'function' && term.textarea) {
      const onFocusEl = () => options.onFocus();
      term.textarea.addEventListener('focus', onFocusEl);
      cleanups.push(() => {
        if (term.textarea) term.textarea.removeEventListener('focus', onFocusEl);
      });
    }

    // 若桥接缺失,直接给出提示并返回一个"空壳"句柄
    if (!bridge) {
      term.writeln('\x1b[31m[错误] ptyBridge 未注入,请检查 preload.js\x1b[0m');
      return handle();
    }

    // 4) 订阅主进程推送的 PTY 输出 / 退出
    const offData = bridge.onData(({ id, data }) => {
      if (id === sessionId) term.write(data);
    });
    const offExit = bridge.onExit(({ id, exitCode }) => {
      if (id === sessionId) {
        term.writeln(`\r\n\x1b[90m[会话已结束 code=${exitCode}]\x1b[0m`);
        sessionId = null;
        if (typeof options.onExit === 'function') options.onExit(exitCode);
      }
    });
    cleanups.push(offData, offExit);

    // 5) 创建 PTY 会话,把当前维度告知主进程
    bridge
      .create({
        cols: term.cols,
        rows: term.rows,
        shell: options.shell,
        cwd: options.cwd,
        env: options.env,
      })
      .then((res) => {
        if (disposed) {
          // 组件已在异步返回前被销毁:立刻回收会话
          if (res && res.ok) bridge.kill(res.id);
          return;
        }
        if (!res || !res.ok) {
          term.writeln(`\x1b[31m[错误] 无法创建终端会话: ${res && res.error}\x1b[0m`);
          term.writeln('\x1b[90m提示:请先执行 npm install 与 npm run rebuild 编译 node-pty。\x1b[0m');
          return;
        }
        sessionId = res.id;
        // 用户键入 -> 转发给 PTY
        const inputSub = term.onData((data) => {
          if (sessionId) bridge.input(sessionId, data);
        });
        cleanups.push(() => inputSub.dispose());
        // 会话建立后再 fit 一次并同步尺寸,确保 shell 拿到正确的 cols/rows
        fit();
      })
      .catch((err) => {
        if (!disposed) term.writeln(`\x1b[31m[错误] 创建会话异常: ${err.message}\x1b[0m`);
      });

    // 可选:标题变化回调(供标签/窗格标题使用)
    if (typeof options.onTitle === 'function') {
      const titleSub = term.onTitleChange((t) => options.onTitle(t));
      cleanups.push(() => titleSub.dispose());
    }

    // ---- 内部方法 ----

    function safeFit() {
      try {
        fitAddon.fit();
      } catch (err) {
        // host 尺寸为 0 等情况下 fit 会抛错,忽略
      }
    }

    // fit + 把新尺寸同步给 PTY
    function fit() {
      if (disposed) return;
      safeFit();
      if (sessionId) bridge.resize(sessionId, term.cols, term.rows);
    }

    function focus() {
      term.focus();
    }

    function write(data) {
      term.write(data);
    }

    // 解绑一切并回收会话
    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const fn of cleanups) {
        try {
          if (typeof fn === 'function') fn();
        } catch (err) {
          /* 忽略 */
        }
      }
      if (sessionId) {
        bridge.kill(sessionId);
        sessionId = null;
      }
      try {
        term.dispose();
      } catch (err) {
        /* 忽略 */
      }
    }

    function handle() {
      return {
        get id() {
          return sessionId;
        },
        term,
        fit,
        focus,
        write,
        dispose,
        isReady: () => sessionId !== null,
      };
    }

    return handle();
  }

  // 便捷封装:把叶子终端接到 PaneCore.createLayout 的钩子上。
  // 用法(在 index.js 里):
  //   const layout = PaneCore.createLayout(root, LeafTerminal.paneHooks({ ...opts }));
  // 它会在叶子首次挂载时创建终端并存到 leaf.data,并在布局尺寸变化时 fit 所有终端。
  function paneHooks(termOptions) {
    termOptions = termOptions || {};
    const userOnFocus = typeof termOptions.onFocus === 'function' ? termOptions.onFocus : null;

    let layoutRef = null; // 由 onResize 捕获,供焦点回写用
    let pendingFocus = null; // 首次 render 前发生的焦点事件,延迟到有 state 时应用

    // 把某叶子标记为当前焦点窗格:写入 state.focus 并轻量更新高亮(不整树重渲染)。
    function setFocus(leaf) {
      if (!layoutRef) {
        pendingFocus = leaf;
        return;
      }
      if (layoutRef.focus === leaf) return;
      layoutRef.focus = leaf;
      updateFocusHighlight(layoutRef);
    }

    return {
      // PaneCore 为叶子创建 el 后回调
      onLeafMount(leaf) {
        const leafOptions = Object.assign({}, termOptions, {
          onFocus: function () {
            setFocus(leaf);
            if (userOnFocus) userOnFocus(leaf);
          },
        });
        leaf.data = createLeafTerminal(leaf.el, leafOptions);
        // 新叶子获得焦点(贴合 WT:拆分后焦点落到新窗格)
        if (leaf.data && typeof leaf.data.focus === 'function') {
          // 交给下一帧,确保 DOM 已布局
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => leaf.data.focus());
          }
        }
      },
      // 布局尺寸变化后回调:对所有叶子终端 fit
      onResize(state) {
        if (!state || typeof state.root === 'undefined') return;
        layoutRef = state;
        if (pendingFocus) {
          state.focus = pendingFocus;
          pendingFocus = null;
          updateFocusHighlight(state);
        }
        forEachLeafTerminal(state.root, (h) => h.fit());
      },
    };
  }

  // 轻量更新焦点高亮:只切换叶子 el 上的 'pane-focused' class(与 pane.js 约定一致),
  // 不触发整棵树重渲染,避免每次切焦点都重新 fit 导致抖动。
  function updateFocusHighlight(state) {
    if (!state || !state.root) return;
    forEachLeaf(state.root, (leaf) => {
      if (leaf.el && leaf.el.classList) {
        leaf.el.classList.toggle('pane-focused', leaf === state.focus);
      }
    });
  }

  // 遍历树上的所有叶子节点(节点本身,非终端句柄)。与 PaneCore 结构约定解耦。
  function forEachLeaf(node, fn) {
    if (!node) return;
    if (node.type === 'leaf') {
      fn(node);
      return;
    }
    forEachLeaf(node.first, fn);
    forEachLeaf(node.second, fn);
  }

  // 遍历树,对每个持有终端句柄的叶子执行 fn。与 PaneCore 结构解耦(只看 type/data)。
  function forEachLeafTerminal(node, fn) {
    if (!node) return;
    if (node.type === 'leaf') {
      if (node.data && typeof node.data.fit === 'function') fn(node.data);
      return;
    }
    forEachLeafTerminal(node.first, fn);
    forEachLeafTerminal(node.second, fn);
  }

  // integrator 需要如何调用我(在 index.js 里,不要改本文件):
  //   1) index.html 需先以 UMD 挂载 Terminal / FitAddon / WebglAddon 到 window,
  //      并加载 renderer/pane.js(PaneCore)、renderer/terminal.js(本模块)。
  //   2) 建布局:
  //        const layout = PaneCore.createLayout(document.getElementById('pane-root'),
  //                                             LeafTerminal.paneHooks({ shell, cwd, fontSize }));
  //        layout.setRoot(PaneCore.makeLeaf());   // 初始单终端
  //      paneHooks 已把"终端获得焦点 -> layout.focus = 该叶子 + 高亮"接好,
  //      因此 navigate/swap/move 可直接以 layout.focus 作为当前窗格基准。
  //   3) 拆分后:layout.setRoot(PaneCore.split(...)) 会触发 onLeafMount 建新终端并自动聚焦;
  //      本模块用 ResizeObserver 自动 fit,通常无需再手动调 fit。
  //   4) index.html 需为 .pane-focused 提供一条高亮样式(如 outline),否则焦点无视觉反馈。
  return { createLeafTerminal, paneHooks, forEachLeafTerminal, forEachLeaf, updateFocusHighlight };
});
