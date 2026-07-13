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
  //   options  { fontFamily, fontSize, theme, shell, cwd, env, onExit, onTitle }
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
    return {
      // PaneCore 为叶子创建 el 后回调
      onLeafMount(leaf) {
        leaf.data = createLeafTerminal(leaf.el, termOptions);
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
        forEachLeafTerminal(state.root, (h) => h.fit());
      },
    };
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

  return { createLeafTerminal, paneHooks, forEachLeafTerminal };
});
