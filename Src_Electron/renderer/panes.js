// PaneManager:窗格 UI 控制器 —— 把已有的 pane 二叉树接到真实视图。
//
// 这是 [panes] 功能的"胶水层":此前各模块都已就绪但彼此未联通——
//   PaneCore(pane.js)      提供二叉树 + split/swap/move/navigate + DOM 布局 + 拖拽分隔条;
//   LeafTerminal(terminal) 提供 paneHooks:叶子挂载时建 xterm+PTY,并把焦点回写到 state.focus;
//   Keymap(keymap.js)      把键盘事件翻译成命令 id(Alt+Shift+± 拆分 / Alt+方向 切焦点 / …);
//   Palette(palette.js)    命令面板,swap/move/maximize 这类无热键操作从这里触发。
// 本模块负责把它们连起来:安装 keydown 监听 → matchEvent → dispatch → 调用 PaneCore 操作
// → layout 重渲染,并把命令面板接到同一套 dispatch。
//
// 因此本模块实现了任务要求的三件事:
//   1) 切分:Alt+Shift+±  → PaneCore.split(焦点叶子, 横/竖) → 新叶子自动建终端并聚焦。
//   2) 拖拽分隔条调比例:复用 PaneCore 布局里内建的分隔条拖拽;另加 Alt+Shift+方向 键盘调比例。
//   3) Alt+方向切焦点:PaneCore.navigate(焦点叶子, 方向) → 聚焦几何相邻窗格。
// 另附:关闭窗格、swap/move/maximize(命令面板)。
//
// 与拆分/关闭相关的终端生命周期(建/销毁)已由 LeafTerminal.paneHooks 与 leaf.data.dispose 覆盖,
// 本模块只在关闭时显式 dispose 被摘掉那个叶子的终端。
//
// ── integrator(renderer/index.js)需要如何调用我(不要改本文件)──
//   1) index.html 里在 xterm/插件之后、本文件之前依次引入:
//        <script src="renderer/pane.js"></script>       <!-- PaneCore -->
//        <script src="renderer/keymap.js"></script>      <!-- Keymap  -->
//        <script src="renderer/palette.js"></script>     <!-- Palette -->
//        <script src="renderer/terminal.js"></script>    <!-- LeafTerminal -->
//        <script src="renderer/panes.js"></script>       <!-- 本模块 PaneManager -->
//      并把 renderer/index.js 的单终端 bootstrap 换成一句:
//        window.PaneManager.create({ container: document.getElementById('pane-root') });
//      (#pane-root 里原来的 <div id="terminal"> 可删掉;本模块会自己建叶子容器。)
//   2) create 返回 manager 句柄:{ layout, palette, dispatch, destroy, getFocusLeaf }。
//      keydown 监听与命令面板均已在 create 内装好,通常无需 integrator 再做别的。
//   3) 焦点高亮样式(.pane-focused)本模块会自动注入一条 <style>,无需改 index.html。
//
// 同一份代码既可在浏览器(window.PaneManager)运行,也可在 Node 下跑纯逻辑自测
//   (node renderer/panes.js,只测方向映射/邻居选择等不依赖 DOM 的部分)。

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // Node / 自测
  }
  if (typeof window !== 'undefined') {
    window.PaneManager = api; // 浏览器渲染进程
  }
})(this, function () {
  'use strict';

  const RESIZE_STEP = 0.04; // 键盘 Alt+Shift+方向 每次调整的比例步进
  const DIVIDER_PX = 6; // 与 pane.js 的分隔条厚度保持一致,便于 live 调比例时算 flex-basis
  const STYLE_ID = 'pane-manager-style';

  // ---------------------------------------------------------------------------
  // 纯逻辑:方向 → 拆分/导航语义(可在 Node 自测,不依赖 DOM)
  // ---------------------------------------------------------------------------

  // 方向 → 该方向上"相邻分隔条"所属分裂节点的朝向。
  //   左右 → 竖直分隔(row 分裂);上下 → 水平分隔(column 分裂)。
  function orientationForDirection(direction) {
    return direction === 'left' || direction === 'right' ? 'row' : 'column';
  }

  // 键盘调整大小:方向 → 比例增量符号。
  //   分裂节点的 ratio 表示 first(左/上)子节点占比。
  //   'right'/'down' 把分隔条往右/下推 → first 变大 → +;'left'/'up' → -。
  function resizeDeltaSign(direction) {
    return direction === 'right' || direction === 'down' ? 1 : -1;
  }

  // move 命令:方向 → { orientation, newSide }(把 source 贴到 target 的哪一侧)。
  //   左/上 → 放在 first;右/下 → 放在 second。
  function attachSpecForDirection(direction) {
    return {
      orientation: orientationForDirection(direction),
      newSide: direction === 'left' || direction === 'up' ? 'first' : 'second',
    };
  }

  // 从某叶子向上找最近的、朝向匹配的分裂祖先(供键盘调整大小定位分隔条)。
  function nearestSplitAncestor(PaneCore, leaf, orientation) {
    let cur = leaf && leaf.parent;
    while (cur) {
      if (PaneCore.isSplit(cur) && cur.orientation === orientation) return cur;
      cur = cur.parent;
    }
    return null;
  }

  function clampRatio(r) {
    const MIN = 0.05;
    if (r < MIN) return MIN;
    if (r > 1 - MIN) return 1 - MIN;
    return r;
  }

  // ---------------------------------------------------------------------------
  // 依赖解析:浏览器取 window.*,Node 自测取 require
  // ---------------------------------------------------------------------------
  function resolveDeps(overrides) {
    overrides = overrides || {};
    const w = typeof window !== 'undefined' ? window : {};
    const deps = {
      PaneCore: overrides.PaneCore || w.PaneCore,
      LeafTerminal: overrides.LeafTerminal || w.LeafTerminal,
      Keymap: overrides.Keymap || w.Keymap,
      Palette: overrides.Palette || w.Palette,
    };
    return deps;
  }

  // ---------------------------------------------------------------------------
  // 注入焦点高亮样式(自包含,避免依赖 index.html)
  // ---------------------------------------------------------------------------
  function ensureStyle() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    // 焦点窗格描一圈高亮;分隔条 hover 提示可拖拽。
    style.textContent = [
      '.pane-leaf { outline: 1px solid transparent; outline-offset: -1px; }',
      '.pane-leaf.pane-focused { outline: 1px solid #007acc; }',
      '.pane-divider:hover { background: rgba(0,122,204,0.5) !important; }',
    ].join('\n');
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // create:构建一套可交互的窗格视图,返回 manager 句柄
  // ---------------------------------------------------------------------------
  //   opts.container    窗格树挂载的 DOM 根(必填,浏览器环境)
  //   opts.termOptions  透传给 LeafTerminal 的终端选项({ shell, cwd, fontSize, theme, ... })
  //   opts.initialRoot  可选,初始树(默认单叶子)
  //   opts._deps        可选,测试时注入依赖(PaneCore/LeafTerminal/Keymap/Palette)
  function create(opts) {
    opts = opts || {};
    const deps = resolveDeps(opts._deps);
    const PaneCore = deps.PaneCore;
    const LeafTerminal = deps.LeafTerminal;
    const Keymap = deps.Keymap;
    const Palette = deps.Palette;

    if (!PaneCore) throw new Error('PaneManager.create: 缺少 PaneCore(请先加载 renderer/pane.js)');
    if (typeof document === 'undefined') {
      throw new Error('PaneManager.create 需要 DOM 环境(浏览器渲染进程)');
    }
    if (!opts.container) throw new Error('PaneManager.create: 缺少 container');
    if (!LeafTerminal) throw new Error('PaneManager.create: 缺少 LeafTerminal(请先加载 renderer/terminal.js)');

    ensureStyle();

    // 1) 建布局:onLeafMount 建终端并聚焦,onResize 自适应 —— 都由 LeafTerminal.paneHooks 提供。
    const hooks = LeafTerminal.paneHooks(opts.termOptions || {});
    const layout = PaneCore.createLayout(opts.container, hooks);

    // 2) 初始根:默认单叶子(=单终端)
    const initialRoot = opts.initialRoot || PaneCore.makeLeaf();
    layout.setRoot(initialRoot);

    // 当前焦点叶子:优先 state.focus(由终端聚焦事件回写),否则回退到第一个叶子。
    function getFocusLeaf() {
      const st = layout.getState ? layout.getState() : layout;
      const all = PaneCore.leaves(st.root);
      if (st.focus && all.indexOf(st.focus) >= 0) return st.focus;
      return all[0] || null;
    }

    // 把焦点落到某叶子:聚焦其终端(会经由 onFocus 回写 state.focus + 高亮)。
    function focusLeaf(leaf) {
      if (!leaf) return;
      const st = layout.getState ? layout.getState() : layout;
      st.focus = leaf;
      if (LeafTerminal.updateFocusHighlight) LeafTerminal.updateFocusHighlight(st);
      if (leaf.data && typeof leaf.data.focus === 'function') {
        // 交给下一帧,确保 DOM 已就位(尤其刚 setRoot 之后)
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => leaf.data.focus());
        else leaf.data.focus();
      }
    }

    // ---- live 调整某分裂节点的比例:直接改 flex-basis,不整树重渲染(不丢焦点、无闪烁)。
    // 终端会经自身 ResizeObserver 自动 fit,无需手动调 fit。
    function applyLiveRatio(node) {
      if (!node || !node.el) return;
      const first = node.el.children[0];
      const second = node.el.children[2];
      if (!first || !second) return;
      const pct = (node.ratio * 100).toFixed(4);
      const restPct = ((1 - node.ratio) * 100).toFixed(4);
      first.style.flex = '0 0 calc(' + pct + '% - ' + DIVIDER_PX / 2 + 'px)';
      second.style.flex = '0 0 calc(' + restPct + '% - ' + DIVIDER_PX / 2 + 'px)';
    }

    // -------------------------------------------------------------------------
    // dispatch:命令 id + 参数 → PaneCore 操作
    // -------------------------------------------------------------------------
    function dispatch(id, args) {
      args = args || {};
      const st = layout.getState ? layout.getState() : layout;
      const focus = getFocusLeaf();

      switch (id) {
        // ---- 拆分:Alt+Shift+±(args: { orientation, newSide }) ----
        case 'pane.split.right':
        case 'pane.split.down': {
          if (!focus) return true;
          const newLeaf = PaneCore.makeLeaf();
          st.focus = newLeaf; // 乐观置焦点;onLeafMount 建好终端后会再聚焦一次
          const newRoot = PaneCore.split(st.root, focus, args.orientation, newLeaf, args.newSide);
          layout.setRoot(newRoot); // 触发 onLeafMount 建新终端并自动聚焦
          return true;
        }

        // ---- 切焦点:Alt+方向(args: { direction }) ----
        case 'pane.focus.left':
        case 'pane.focus.right':
        case 'pane.focus.up':
        case 'pane.focus.down': {
          if (!focus) return true;
          const target = PaneCore.navigate(st.root, focus, args.direction, viewport());
          if (target) focusLeaf(target);
          return true;
        }

        // ---- 键盘调整大小:Alt+Shift+方向(args: { direction }) ----
        case 'pane.resize.left':
        case 'pane.resize.right':
        case 'pane.resize.up':
        case 'pane.resize.down': {
          if (!focus) return true;
          const orient = orientationForDirection(args.direction);
          const node = nearestSplitAncestor(PaneCore, focus, orient);
          if (!node) return true; // 该方向没有可调的分隔条
          node.ratio = clampRatio(node.ratio + resizeDeltaSign(args.direction) * RESIZE_STEP);
          applyLiveRatio(node);
          return true;
        }

        // ---- 关闭当前窗格:Ctrl/Cmd+Shift+W ----
        case 'pane.close': {
          if (!focus) return true;
          const all = PaneCore.leaves(st.root);
          if (all.length <= 1) {
            // 关闭最后一个窗格:先回收其终端 / PTY 会话,再决定窗口去留。
            //   - 若集成层传入 onLastPaneClosed(如标签层要保留窗口/新建标签),交给它裁决;
            //   - 否则默认关闭当前窗口(window.close 触发主进程 window-all-closed →
            //     PtyManager.killAll → 非 macOS 下退出应用),贴合"关掉唯一窗格即关窗"的直觉。
            if (focus.data && typeof focus.data.dispose === 'function') focus.data.dispose();
            if (typeof opts.onLastPaneClosed === 'function') {
              opts.onLastPaneClosed(focus);
            } else if (typeof window !== 'undefined' && typeof window.close === 'function') {
              window.close();
            }
            return true;
          }
          const sibling = siblingLeaf(PaneCore, focus);
          const res = PaneCore.detach(st.root, focus);
          if (focus.data && typeof focus.data.dispose === 'function') focus.data.dispose();
          if (st.maximized === focus) PaneCore.restore(st);
          st.focus = sibling || null;
          layout.setRoot(res.root);
          if (sibling) focusLeaf(sibling);
          return true;
        }

        // ---- 交换:命令面板(args: { direction }) ----
        case 'pane.swap.left':
        case 'pane.swap.right':
        case 'pane.swap.up':
        case 'pane.swap.down': {
          if (!focus) return true;
          const target = PaneCore.navigate(st.root, focus, args.direction, viewport());
          if (!target || target === focus) return true;
          const newRoot = PaneCore.swap(st.root, focus, target);
          st.focus = focus; // 交换后仍聚焦原窗格(其在树中的位置已变)
          layout.setRoot(newRoot);
          focusLeaf(focus);
          return true;
        }

        // ---- 移动:命令面板(args: { direction }) ----
        case 'pane.move.left':
        case 'pane.move.right':
        case 'pane.move.up':
        case 'pane.move.down': {
          if (!focus) return true;
          const target = PaneCore.navigate(st.root, focus, args.direction, viewport());
          if (!target || target === focus) return true;
          const spec = attachSpecForDirection(args.direction);
          const newRoot = PaneCore.move(st.root, focus, target, spec.orientation, spec.newSide);
          st.focus = focus;
          layout.setRoot(newRoot);
          focusLeaf(focus);
          return true;
        }

        // ---- 最大化 / 还原:命令面板 ----
        case 'pane.maximize.toggle': {
          if (!focus) return true;
          if (st.maximized === focus) PaneCore.restore(st);
          else PaneCore.maximize(st, focus);
          layout.render();
          focusLeaf(focus);
          return true;
        }

        // ---- 命令面板开关 ----
        case 'palette.toggle': {
          if (palette) palette.toggle();
          return true;
        }

        default:
          return false; // 未识别的命令:交回给调用方
      }
    }

    // 供 navigate 使用的视口尺寸(用真实容器尺寸更准;navigate 只看相对关系,兜底也可)。
    function viewport() {
      const c = opts.container;
      const w = (c && c.clientWidth) || 1000;
      const h = (c && c.clientHeight) || 1000;
      return { width: w, height: h };
    }

    // -------------------------------------------------------------------------
    // 命令面板:onExecute 直接路由到 dispatch
    // -------------------------------------------------------------------------
    let palette = null;
    if (Palette && typeof Palette.createPalette === 'function') {
      palette = Palette.createPalette({
        onExecute: function (cmd) {
          dispatch(cmd.id, cmd.args);
        },
      });
    }

    // -------------------------------------------------------------------------
    // 键盘监听:捕获阶段安装在 window,先于 xterm 的 textarea 处理器拦截热键
    // -------------------------------------------------------------------------
    function handleKeyEvent(ev) {
      if (!Keymap || typeof Keymap.matchEvent !== 'function') return false;
      const id = Keymap.matchEvent(ev);
      if (!id) return false;

      // 命令面板已打开时:只允许再次按面板热键把它关掉;其余热键让面板自行处理(不拦截)。
      if (palette && palette.isOpen()) {
        if (id === 'palette.toggle') {
          ev.preventDefault();
          palette.toggle();
          return true;
        }
        return false;
      }

      ev.preventDefault();
      if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
      dispatch(id, Keymap.getCommand ? (Keymap.getCommand(id) || {}).args : undefined);
      return true;
    }

    const keyListener = function (ev) {
      handleKeyEvent(ev);
    };
    // 捕获阶段:window → target,先于 xterm 内部的 keydown 处理器执行,可靠拦截 Alt/Ctrl 组合键。
    window.addEventListener('keydown', keyListener, true);

    // 页面卸载时回收(终端会话由各叶子 dispose;此处解绑监听与面板)。
    function destroy() {
      window.removeEventListener('keydown', keyListener, true);
      if (palette && typeof palette.destroy === 'function') palette.destroy();
    }

    return {
      layout: layout,
      palette: palette,
      dispatch: dispatch,
      handleKeyEvent: handleKeyEvent,
      getFocusLeaf: getFocusLeaf,
      destroy: destroy,
    };
  }

  // 返回焦点叶子被 detach 后顶上来的兄弟叶子(取兄弟子树里的第一个叶子)。
  function siblingLeaf(PaneCore, leaf) {
    const p = leaf && leaf.parent;
    if (!p) return null;
    const sib = p.first === leaf ? p.second : p.first;
    if (!sib) return null;
    if (PaneCore.isLeaf(sib)) return sib;
    const inner = PaneCore.leaves(sib);
    return inner[0] || null;
  }

  // ---------------------------------------------------------------------------
  // 导出
  // ---------------------------------------------------------------------------
  const PaneManager = {
    create: create,
    // 暴露纯逻辑,便于集成层复用与自测
    orientationForDirection: orientationForDirection,
    resizeDeltaSign: resizeDeltaSign,
    attachSpecForDirection: attachSpecForDirection,
    nearestSplitAncestor: nearestSplitAncestor,
    siblingLeaf: siblingLeaf,
  };

  // ---------------------------------------------------------------------------
  // 自测:node renderer/panes.js(只测不依赖 DOM 的纯逻辑)
  // ---------------------------------------------------------------------------
  function selfTest() {
    let passed = 0;
    let failed = 0;
    function assert(cond, msg) {
      if (cond) passed++;
      else {
        failed++;
        // eslint-disable-next-line no-console
        console.error('  FAIL:', msg);
      }
    }

    // 方向 → 朝向
    assert(orientationForDirection('left') === 'row', 'left → row');
    assert(orientationForDirection('right') === 'row', 'right → row');
    assert(orientationForDirection('up') === 'column', 'up → column');
    assert(orientationForDirection('down') === 'column', 'down → column');

    // 调整大小符号
    assert(resizeDeltaSign('right') === 1, 'right → +');
    assert(resizeDeltaSign('down') === 1, 'down → +');
    assert(resizeDeltaSign('left') === -1, 'left → -');
    assert(resizeDeltaSign('up') === -1, 'up → -');

    // move 贴附规格
    assert(attachSpecForDirection('left').newSide === 'first', 'move left → first');
    assert(attachSpecForDirection('right').newSide === 'second', 'move right → second');
    assert(attachSpecForDirection('up').orientation === 'column', 'move up → column');

    // 结合 PaneCore 验证 nearestSplitAncestor / siblingLeaf(Node 下 require 真实树实现)
    let PaneCore = null;
    try {
      PaneCore = require('./pane.js');
    } catch (e) {
      /* 浏览器/无文件时跳过这部分 */
    }
    if (PaneCore) {
      const a = PaneCore.makeLeaf({ id: 'A' });
      const b = PaneCore.makeLeaf({ id: 'B' });
      let tree = PaneCore.split(a, a, 'row', b, 'second'); // A | B (row split root)
      const c = PaneCore.makeLeaf({ id: 'C' });
      tree = PaneCore.split(tree, b, 'column', c, 'second'); // B 上 / C 下(column split)

      // 从 C 向上找 row 祖先 = 根;找 column 祖先 = 内层
      const rowAnc = nearestSplitAncestor(PaneCore, c, 'row');
      const colAnc = nearestSplitAncestor(PaneCore, c, 'column');
      assert(rowAnc === tree, 'C 的最近 row 祖先是根');
      assert(colAnc && colAnc.orientation === 'column', 'C 的最近 column 祖先朝向正确');
      assert(colAnc !== tree, 'column 祖先是内层而非根');

      // 兄弟叶子:B 与 C 同父(column 分裂),B 的兄弟是 C
      assert(siblingLeaf(PaneCore, b) === c, 'B 的兄弟是 C');
      // A 的兄弟是 (B|C) 子树 → 取其第一个叶子 B
      assert(siblingLeaf(PaneCore, a) === b, 'A 的兄弟子树第一个叶子是 B');
    }

    // eslint-disable-next-line no-console
    console.log('PaneManager self-test: ' + passed + ' passed, ' + failed + ' failed');
    return failed === 0;
  }

  PaneManager._selfTest = selfTest;

  if (typeof module !== 'undefined' && module.exports && typeof require !== 'undefined') {
    if (require.main === module) {
      const ok = selfTest();
      if (typeof process !== 'undefined') process.exit(ok ? 0 : 1);
    }
  }

  return PaneManager;
});
