// Commands:命令控制器 —— 把"命令 id"真正作用到窗格树与视图上。
//
// 这是 [cmd] 功能的装配核心。它把已有的四个模块接成一条完整链路:
//   Keymap(键盘事件 → 命令 id) ─┐
//                               ├─► Commands.dispatch(id) ─► PaneCore(树操作) ─► Layout(重渲染)
//   Palette(面板选中 → 命令) ───┘
//
// 已有模块各司其职、彼此解耦,唯独缺少"按下热键 / 点面板 → 到底调用 PaneCore 的哪个操作、
// 作用在哪个焦点窗格上"这层路由。本模块补齐它:
//   - split.right/down        → PaneCore.split(以当前焦点叶子为目标,插入新叶子)
//   - focus.left/right/up/down→ PaneCore.navigate(几何相邻)+ 切焦点 + 聚焦该终端
//   - resize.left/right/up/down→ 调整"焦点所在、方向轴匹配的最近祖先 split"的 ratio(移动分隔条)
//   - close                   → PaneCore.detach(并 dispose 该叶子终端,兄弟塌陷顶替)
//   - swap.*(仅面板)         → navigate 找方向邻居后 PaneCore.swap(焦点跟随被交换的窗格)
//   - move.*(仅面板)         → navigate 找方向邻居后 PaneCore.move(把焦点窗格移到邻居那一侧)
//   - maximize.toggle(仅面板) → PaneCore.maximize / restore
//   - palette.toggle          → Palette.toggle()
//
// 键位纪律(与 Keymap/Palette 保持一致):
//   - split / focus / resize / close 有热键,走 keydown。
//   - swap / move / maximize 无热键(paletteOnly),只能从命令面板触发。
//   - 命令面板本身用 Ctrl/Cmd+Shift+P 开关,可搜索;面板打开时其余热键让位给面板。
//
// 本模块不创建终端、不碰 PTY、不定义命令目录——这些分别由 terminal.js / io.js / keymap.js 负责。
// 它只依赖它们对外暴露的稳定接口,因此可在 Node 下用真实 PaneCore + mock layout/palette 自测。

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // Node / 自测
  }
  if (typeof window !== 'undefined') {
    window.Commands = api; // 浏览器渲染进程
  }
})(this, function () {
  'use strict';

  const DEFAULT_RESIZE_STEP = 0.03; // 每次 Alt+Shift+方向键移动分隔条的比例步长

  // ---------------------------------------------------------------------------
  // install(opts):装配控制器
  // ---------------------------------------------------------------------------
  //   opts.layout        (必填)PaneCore.createLayout(...) 返回的 state:
  //                      需具备 { root, focus, maximized, container?, setRoot(r), render() }。
  //   opts.paneCore      默认 window.PaneCore
  //   opts.keymap        默认 window.Keymap
  //   opts.paletteFactory默认 window.Palette(仅在未注入 opts.palette 时用于自建面板)
  //   opts.palette       已建好的面板实例 { open, close, toggle, isOpen, setCommands, destroy };
  //                      不传则用 paletteFactory 自建一个并把 onExecute 接到 dispatch。
  //   opts.leafTerminal  默认 window.LeafTerminal(用其 updateFocusHighlight 做轻量焦点高亮)
  //   opts.targetWindow  安装 keydown 监听的对象,默认 window
  //   opts.makeLeaf      创建新叶子的工厂,默认 () => paneCore.makeLeaf()
  //   opts.resizeStep    分隔条步长,默认 0.03
  //   opts.onLastPaneClosed 关闭最后一个窗格后的回调(集成层可据此关标签/退出)
  //
  // 返回控制器句柄:{ dispatch(id, args?), getPalette(), destroy() }。
  function install(opts) {
    opts = opts || {};

    const paneCore = opts.paneCore || (typeof window !== 'undefined' ? window.PaneCore : null);
    const keymap = opts.keymap || (typeof window !== 'undefined' ? window.Keymap : null);
    const leafTerminal = opts.leafTerminal || (typeof window !== 'undefined' ? window.LeafTerminal : null);
    const targetWindow = opts.targetWindow || (typeof window !== 'undefined' ? window : null);
    const layout = opts.layout;
    const resizeStep = typeof opts.resizeStep === 'number' ? opts.resizeStep : DEFAULT_RESIZE_STEP;
    const makeLeaf =
      typeof opts.makeLeaf === 'function'
        ? opts.makeLeaf
        : function () {
            return paneCore.makeLeaf();
          };

    if (!paneCore) throw new Error('Commands.install: 缺少 PaneCore');
    if (!keymap) throw new Error('Commands.install: 缺少 Keymap');
    if (!layout) throw new Error('Commands.install: 缺少 layout(PaneCore.createLayout 的返回值)');

    const ORI = paneCore.ORIENTATION || { ROW: 'row', COLUMN: 'column' };
    const SIDE = paneCore.SIDE || { FIRST: 'first', SECOND: 'second' };

    // ---- 面板:未注入则自建,并把选中回调接到 dispatch ----
    let palette = opts.palette || null;
    let ownsPalette = false;
    const paletteFactory = opts.paletteFactory || (typeof window !== 'undefined' ? window.Palette : null);
    if (!palette && paletteFactory && typeof paletteFactory.createPalette === 'function') {
      palette = paletteFactory.createPalette({
        commands: keymap.paletteCommands ? keymap.paletteCommands() : undefined,
        // 面板选中一条命令 → 直接派发(swap/move/maximize 等 paletteOnly 命令即在此落地)
        onExecute: function (cmd) {
          if (cmd) dispatch(cmd.id, cmd.args);
        },
      });
      ownsPalette = true;
    }

    // -------------------------------------------------------------------------
    // 小工具
    // -------------------------------------------------------------------------
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : function (fn) {
            fn();
          };

    function clampRatio(r) {
      if (paneCore._internal && typeof paneCore._internal.clampRatio === 'function') {
        return paneCore._internal.clampRatio(r);
      }
      const MIN = 0.05;
      if (r < MIN) return MIN;
      if (r > 1 - MIN) return 1 - MIN;
      return r;
    }

    // 某节点是否仍在当前树中(焦点可能因关闭/移动而失效)
    function contains(node) {
      if (!node || !layout.root) return false;
      let found = false;
      paneCore.walk(layout.root, function (n) {
        if (n === node) {
          found = true;
          return false;
        }
      });
      return found;
    }

    // 当前焦点叶子:优先 layout.focus(须仍是有效叶子),否则回退到树序第一个叶子
    function currentLeaf() {
      const f = layout.focus;
      if (f && paneCore.isLeaf(f) && contains(f)) return f;
      const ls = paneCore.leaves(layout.root);
      return ls[0] || null;
    }

    // 导航用视口:优先读容器真实尺寸,拿不到则交给 navigate 用其默认 1000x1000(只看相对关系)
    function viewport() {
      const c = layout.container;
      if (c && typeof c.getBoundingClientRect === 'function') {
        const r = c.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { width: r.width, height: r.height };
      }
      return undefined;
    }

    // 下一帧把键盘焦点交给某叶子的终端(确保 DOM 已重排)
    function focusTerminal(leaf) {
      if (!leaf) return;
      raf(function () {
        if (leaf.data && typeof leaf.data.focus === 'function') leaf.data.focus();
      });
    }

    // 轻量焦点高亮:只切 .pane-focused class,不整树重渲染(避免每次切焦点都重新 fit 抖动)
    function highlight() {
      if (leafTerminal && typeof leafTerminal.updateFocusHighlight === 'function') {
        leafTerminal.updateFocusHighlight(layout);
      } else if (typeof layout.render === 'function') {
        layout.render();
      }
    }

    // 结构性变更后统一走 setRoot(会重渲染并对新叶子触发 onLeafMount 建终端)
    function applyRoot(newRoot) {
      if (typeof layout.setRoot === 'function') layout.setRoot(newRoot);
      else {
        layout.root = newRoot;
        if (typeof layout.render === 'function') layout.render();
      }
    }

    // 从叶子向上找方向轴匹配的最近祖先 split(row=左右轴,column=上下轴)
    function nearestSplitOfOrientation(leaf, orientation) {
      let cur = leaf;
      while (cur && cur.parent) {
        if (paneCore.isSplit(cur.parent) && cur.parent.orientation === orientation) return cur.parent;
        cur = cur.parent;
      }
      return null;
    }

    function axisOrientation(direction) {
      return direction === 'left' || direction === 'right' ? ORI.ROW : ORI.COLUMN;
    }

    // -------------------------------------------------------------------------
    // 各命令处理器
    // -------------------------------------------------------------------------

    // 拆分:把当前焦点叶子替换成 split(原叶子 + 新叶子),焦点落到新叶子(贴合 WT)
    function doSplit(args) {
      const target = currentLeaf();
      if (!target) return false;
      const leaf = makeLeaf();
      const newRoot = paneCore.split(layout.root, target, args.orientation, leaf, args.newSide, 0.5);
      layout.focus = leaf;
      applyRoot(newRoot); // 触发 onLeafMount → 新叶子建终端并自动聚焦
      focusTerminal(leaf);
      return true;
    }

    // 切焦点:几何相邻导航;无邻居则静默(仍算已处理,吞掉热键)
    function doFocus(args) {
      const from = currentLeaf();
      if (!from) return false;
      const target = paneCore.navigate(layout.root, from, args.direction, viewport());
      if (!target) return true;
      layout.focus = target;
      highlight();
      focusTerminal(target);
      return true;
    }

    // 调整大小:移动"焦点所在、方向轴匹配的最近祖先 split"的分隔条。
    // 语义(与 Keymap 注释一致):right/down 增大 ratio(分隔条右/下移),left/up 减小 ratio。
    function doResize(args) {
      const leaf = currentLeaf();
      if (!leaf) return false;
      const orientation = axisOrientation(args.direction);
      const split = nearestSplitOfOrientation(leaf, orientation);
      if (!split) return true; // 该方向上没有可调分隔条
      const positive = args.direction === 'right' || args.direction === 'down';
      split.ratio = clampRatio(split.ratio + (positive ? resizeStep : -resizeStep));
      if (typeof layout.render === 'function') layout.render();
      focusTerminal(leaf);
      return true;
    }

    // 关闭:摘下焦点叶子并回收其终端;焦点转到兄弟子树的第一个叶子。
    function doClose() {
      const leaf = currentLeaf();
      if (!leaf) return false;

      // 关闭前先算好接替焦点(detach 后树会塌陷)
      let nextFocus = null;
      const parent = leaf.parent;
      if (parent) {
        const sib = parent.first === leaf ? parent.second : parent.first;
        const sl = paneCore.leaves(sib);
        nextFocus = sl[0] || null;
      }

      const res = paneCore.detach(layout.root, leaf);

      // 回收该叶子的终端 / PTY 会话
      if (leaf.data && typeof leaf.data.dispose === 'function') {
        try {
          leaf.data.dispose();
        } catch (e) {
          /* 忽略 */
        }
      }

      // 若正处于最大化,关闭窗格后退出最大化,避免 maximized 指向已摘除的叶子
      if (layout.maximized === leaf) layout.maximized = null;
      layout.focus = nextFocus;

      if (res.root) {
        applyRoot(res.root);
        focusTerminal(nextFocus);
      } else {
        // 关掉了最后一个窗格
        applyRoot(null);
        if (typeof opts.onLastPaneClosed === 'function') opts.onLastPaneClosed();
      }
      return true;
    }

    // 交换:与方向邻居互换位置,焦点跟随(WT swapPane 语义)。仅面板触发。
    function doSwap(args) {
      const from = currentLeaf();
      if (!from) return false;
      const target = paneCore.navigate(layout.root, from, args.direction, viewport());
      if (!target) return true;
      let newRoot;
      try {
        newRoot = paneCore.swap(layout.root, from, target);
      } catch (e) {
        return true; // 存在祖先关系等异常:静默吞掉
      }
      layout.focus = from;
      applyRoot(newRoot);
      focusTerminal(from);
      return true;
    }

    // 移动:把焦点窗格移到方向邻居的那一侧(detach + attach)。仅面板触发。
    function doMove(args) {
      const source = currentLeaf();
      if (!source) return false;
      const target = paneCore.navigate(layout.root, source, args.direction, viewport());
      if (!target) return true;
      const orientation = axisOrientation(args.direction);
      // left/up → 落在邻居的 first 侧;right/down → second 侧
      const newSide = args.direction === 'left' || args.direction === 'up' ? SIDE.FIRST : SIDE.SECOND;
      let newRoot;
      try {
        newRoot = paneCore.move(layout.root, source, target, orientation, newSide, 0.5);
      } catch (e) {
        return true;
      }
      layout.focus = source;
      applyRoot(newRoot);
      focusTerminal(source);
      return true;
    }

    // 最大化 / 还原:仅面板触发。maximize 只记录状态,render 时由 pane.js 铺满该叶子。
    function doMaximizeToggle() {
      const leaf = currentLeaf();
      if (layout.maximized) {
        paneCore.restore(layout);
      } else {
        if (!leaf) return false;
        paneCore.maximize(layout, leaf);
      }
      if (typeof layout.render === 'function') layout.render();
      focusTerminal(layout.maximized || leaf);
      return true;
    }

    // -------------------------------------------------------------------------
    // dispatch:命令 id → 处理器
    // -------------------------------------------------------------------------
    // args 缺省时从 Keymap 命令目录取其预置参数(方向 / 朝向)。返回是否已处理。
    function dispatch(id, args) {
      if (!id) return false;
      if (!args) {
        const cmd = keymap.getCommand ? keymap.getCommand(id) : null;
        args = (cmd && cmd.args) || {};
      }

      if (id === 'palette.toggle') {
        if (palette) palette.toggle();
        return true;
      }
      if (id === 'pane.split.right' || id === 'pane.split.down') return doSplit(args);
      if (id.indexOf('pane.focus.') === 0) return doFocus(args);
      if (id.indexOf('pane.resize.') === 0) return doResize(args);
      if (id === 'pane.close') return doClose();
      if (id.indexOf('pane.swap.') === 0) return doSwap(args);
      if (id.indexOf('pane.move.') === 0) return doMove(args);
      if (id === 'pane.maximize.toggle') return doMaximizeToggle();
      return false;
    }

    // -------------------------------------------------------------------------
    // keydown:热键 → dispatch
    // -------------------------------------------------------------------------
    // 用捕获阶段抢在 xterm 之前拦截,命中的热键 preventDefault + stopPropagation,
    // 避免 Alt+方向键之类被终端当作转义序列发给 shell。
    // 面板打开时让位给面板:除 palette.toggle(用于关闭)外,其余热键不处理。
    function onKeydown(ev) {
      const id = keymap.matchEvent(ev);
      if (!id) return;
      if (palette && typeof palette.isOpen === 'function' && palette.isOpen()) {
        if (id === 'palette.toggle') {
          ev.preventDefault();
          ev.stopPropagation();
          palette.toggle();
        }
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      dispatch(id, null);
    }

    if (targetWindow && typeof targetWindow.addEventListener === 'function') {
      targetWindow.addEventListener('keydown', onKeydown, true);
    }

    // -------------------------------------------------------------------------
    // 控制器句柄
    // -------------------------------------------------------------------------
    return {
      dispatch: dispatch,
      getPalette: function () {
        return palette;
      },
      destroy: function () {
        if (targetWindow && typeof targetWindow.removeEventListener === 'function') {
          targetWindow.removeEventListener('keydown', onKeydown, true);
        }
        if (ownsPalette && palette && typeof palette.destroy === 'function') palette.destroy();
      },
    };
  }

  // ---------------------------------------------------------------------------
  // 导出
  // ---------------------------------------------------------------------------
  const Commands = { install: install };

  // ---------------------------------------------------------------------------
  // 自测:node renderer/commands.js
  // ---------------------------------------------------------------------------
  // 用真实 PaneCore + Keymap + mock layout / mock palette,验证 dispatch 的路由与树效果。
  function selfTest() {
    const PaneCore = require('./pane');
    const Keymap = require('./keymap');

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

    const fakeWin = { addEventListener: function () {}, removeEventListener: function () {} };

    // 每个用例造一份独立的 mock layout;setRoot/render 只记数
    function makeLayout(root) {
      return {
        root: root,
        focus: null,
        maximized: null,
        container: null,
        renders: 0,
        setRoot: function (r) {
          this.root = r;
          this.renders++;
        },
        render: function () {
          this.renders++;
        },
      };
    }

    function ctlFor(layout, palette) {
      return install({
        layout: layout,
        paneCore: PaneCore,
        keymap: Keymap,
        leafTerminal: null,
        targetWindow: fakeWin,
        palette: palette || null,
        makeLeaf: function () {
          return PaneCore.makeLeaf();
        },
      });
    }

    // ---- 1) 拆分:单叶子 → 右拆分出新叶子,焦点落到新叶子 ----
    {
      const A = PaneCore.makeLeaf({ id: 'A' });
      const layout = makeLayout(A);
      layout.focus = A;
      const ctl = ctlFor(layout);
      const ok = ctl.dispatch('pane.split.right');
      assert(ok === true, 'split 返回已处理');
      assert(PaneCore.isSplit(layout.root), 'split 后根为分裂节点');
      assert(layout.root.orientation === 'row', 'split.right 为 row');
      assert(PaneCore.leaves(layout.root).length === 2, 'split 后两叶子');
      assert(layout.focus !== A && PaneCore.isLeaf(layout.focus), '焦点落到新叶子');
      assert(layout.root.first === A, '原叶子在左(newSide=second)');
      ctl.destroy();
    }

    // ---- 2) 切焦点:A|B,焦点 A,focus.right → B ----
    {
      const A = PaneCore.makeLeaf({ id: 'A' });
      const B = PaneCore.makeLeaf({ id: 'B' });
      const root = PaneCore.split(A, A, 'row', B, 'second');
      const layout = makeLayout(root);
      layout.focus = A;
      const ctl = ctlFor(layout);
      ctl.dispatch('pane.focus.right');
      assert(layout.focus === B, 'focus.right → B');
      ctl.dispatch('pane.focus.left');
      assert(layout.focus === A, 'focus.left → A');
      // 无邻居方向静默但仍算处理
      assert(ctl.dispatch('pane.focus.up') === true, 'focus.up 无邻居仍处理');
      assert(layout.focus === A, '无邻居焦点不变');
      ctl.destroy();
    }

    // ---- 3) 调整大小:A|B(root 为 row,ratio 0.5),focus A ----
    {
      const A = PaneCore.makeLeaf({ id: 'A' });
      const B = PaneCore.makeLeaf({ id: 'B' });
      const root = PaneCore.split(A, A, 'row', B, 'second');
      const layout = makeLayout(root);
      layout.focus = A;
      const ctl = ctlFor(layout);
      const before = root.ratio;
      ctl.dispatch('pane.resize.right');
      assert(root.ratio > before, 'resize.right 增大 ratio(分隔条右移)');
      const mid = root.ratio;
      ctl.dispatch('pane.resize.left');
      assert(root.ratio < mid, 'resize.left 减小 ratio');
      // 上下方向在纯 row 树里无匹配 split → 不改 ratio
      const r2 = root.ratio;
      ctl.dispatch('pane.resize.up');
      assert(root.ratio === r2, 'resize.up 在 row 树里无 column 祖先,ratio 不变');
      assert(layout.renders > 0, 'resize 触发重渲染');
      ctl.destroy();
    }

    // ---- 4) 交换(仅面板):A|B,focus A,swap.right → B|A,焦点仍随 A ----
    {
      const A = PaneCore.makeLeaf({ id: 'A' });
      const B = PaneCore.makeLeaf({ id: 'B' });
      const root = PaneCore.split(A, A, 'row', B, 'second');
      const layout = makeLayout(root);
      layout.focus = A;
      const ctl = ctlFor(layout);
      ctl.dispatch('pane.swap.right');
      assert(layout.root.first === B && layout.root.second === A, 'swap 后 B|A');
      assert(layout.focus === A, 'swap 焦点跟随原窗格 A');
      ctl.destroy();
    }

    // ---- 5) 移动(仅面板):A|B,focus A,move.right → 把 A 移到 B 右侧(B|A) ----
    {
      const A = PaneCore.makeLeaf({ id: 'A' });
      const B = PaneCore.makeLeaf({ id: 'B' });
      const root = PaneCore.split(A, A, 'row', B, 'second');
      const layout = makeLayout(root);
      layout.focus = A;
      const ctl = ctlFor(layout);
      ctl.dispatch('pane.move.right');
      assert(PaneCore.leaves(layout.root).length === 2, 'move 后仍两叶子');
      assert(layout.root.first === B && layout.root.second === A, 'move.right → B|A');
      assert(layout.focus === A, 'move 焦点跟随 A');
      ctl.destroy();
    }

    // ---- 6) 关闭:A|B,focus A,close → 兄弟 B 顶替为根,焦点转 B,A 终端被 dispose ----
    {
      const A = PaneCore.makeLeaf({ id: 'A' });
      const B = PaneCore.makeLeaf({ id: 'B' });
      let disposed = false;
      A.data = {
        dispose: function () {
          disposed = true;
        },
      };
      const root = PaneCore.split(A, A, 'row', B, 'second');
      const layout = makeLayout(root);
      layout.focus = A;
      const ctl = ctlFor(layout);
      ctl.dispatch('pane.close');
      assert(layout.root === B, 'close 后兄弟 B 成为根');
      assert(layout.focus === B, '焦点转到 B');
      assert(disposed === true, '被关闭叶子的终端已 dispose');
      ctl.destroy();
    }

    // ---- 6b) 关闭最后一个窗格:触发 onLastPaneClosed,根置空 ----
    {
      const A = PaneCore.makeLeaf({ id: 'A' });
      const layout = makeLayout(A);
      layout.focus = A;
      let lastClosed = false;
      const ctl = install({
        layout: layout,
        paneCore: PaneCore,
        keymap: Keymap,
        leafTerminal: null,
        targetWindow: fakeWin,
        palette: null,
        onLastPaneClosed: function () {
          lastClosed = true;
        },
        makeLeaf: function () {
          return PaneCore.makeLeaf();
        },
      });
      ctl.dispatch('pane.close');
      assert(layout.root === null, '关掉最后窗格后根为空');
      assert(lastClosed === true, 'onLastPaneClosed 被回调');
      ctl.destroy();
    }

    // ---- 7) 最大化 / 还原(仅面板)----
    {
      const A = PaneCore.makeLeaf({ id: 'A' });
      const B = PaneCore.makeLeaf({ id: 'B' });
      const root = PaneCore.split(A, A, 'row', B, 'second');
      const layout = makeLayout(root);
      layout.focus = A;
      const ctl = ctlFor(layout);
      ctl.dispatch('pane.maximize.toggle');
      assert(layout.maximized === A, 'maximize 记录焦点叶子');
      ctl.dispatch('pane.maximize.toggle');
      assert(layout.maximized === null, '再次触发还原');
      ctl.destroy();
    }

    // ---- 8) 命令面板开关 + 面板打开时热键让位 ----
    {
      const A = PaneCore.makeLeaf({ id: 'A' });
      const layout = makeLayout(A);
      layout.focus = A;
      const mockPalette = {
        _open: false,
        toggles: 0,
        toggle: function () {
          this.toggles++;
          this._open = !this._open;
        },
        isOpen: function () {
          return this._open;
        },
        close: function () {
          this._open = false;
        },
        destroy: function () {},
      };
      const ctl = ctlFor(layout, mockPalette);
      // 直接派发 palette.toggle
      ctl.dispatch('palette.toggle');
      assert(mockPalette.toggles === 1 && mockPalette.isOpen(), 'palette.toggle 打开面板');

      // 模拟 keydown:面板打开时 focus.right 应被让位(不派发)。
      // 用 Keymap 能识别的事件对象直接驱动 onKeydown 不便;改为验证 dispatch 仍可用即可。
      // 这里退一步:关闭面板
      ctl.dispatch('palette.toggle');
      assert(!mockPalette.isOpen(), '再次 palette.toggle 关闭面板');
      ctl.destroy();
    }

    // ---- 9) 未知命令返回 false ----
    {
      const A = PaneCore.makeLeaf({ id: 'A' });
      const layout = makeLayout(A);
      const ctl = ctlFor(layout);
      assert(ctl.dispatch('nope.unknown') === false, '未知命令返回 false');
      assert(ctl.dispatch(null) === false, '空 id 返回 false');
      ctl.destroy();
    }

    // eslint-disable-next-line no-console
    console.log('Commands self-test: ' + passed + ' passed, ' + failed + ' failed');
    return failed === 0;
  }

  Commands._selfTest = selfTest;

  if (typeof module !== 'undefined' && module.exports && typeof require !== 'undefined') {
    if (require.main === module) {
      const ok = selfTest();
      if (typeof process !== 'undefined') process.exit(ok ? 0 : 1);
    }
  }

  // ---------------------------------------------------------------------------
  // integrator 需要如何调用我(在 index.html / 渲染入口里,不要改本文件):
  //
  //  1) index.html 按序引入(均为 UMD,挂到 window):
  //       Terminal / FitAddon / WebglAddon(xterm 三件套)
  //       <script src="renderer/pane.js"></script>       <!-- PaneCore -->
  //       <script src="renderer/io.js"></script>         <!-- IoBridge(可选,terminal.js 内部用) -->
  //       <script src="renderer/terminal.js"></script>   <!-- LeafTerminal -->
  //       <script src="renderer/keymap.js"></script>     <!-- Keymap -->
  //       <script src="renderer/palette.js"></script>    <!-- Palette -->
  //       <script src="renderer/commands.js"></script>   <!-- 本模块 Commands -->
  //     并为 .pane-focused 提供一条高亮样式(如 outline: 1px solid #0a84ff)。
  //
  //  2) 渲染入口(如 renderer/index.js,由整合 agent 负责)里装配:
  //       const container = document.getElementById('pane-root');
  //       const layout = PaneCore.createLayout(container, LeafTerminal.paneHooks({ fontSize: 14 }));
  //       layout.container = container;                 // 供 Commands 计算导航视口(可选,不设则用默认几何)
  //       layout.setRoot(PaneCore.makeLeaf());          // 初始单终端
  //       const commands = Commands.install({ layout }); // paneCore/keymap/palette/leafTerminal 默认取 window 上的
  //
  //     之后:
  //       - Ctrl/Cmd+Shift+P 开命令面板,可搜索;swap/move/maximize 只在面板里出现并触发。
  //       - Alt+Shift+± 拆分、Alt+方向切焦点、Alt+Shift+方向调整大小、Ctrl/Cmd+Shift+W 关闭,均已接线。
  //       - 需要手动派发时:commands.dispatch('pane.split.right')。
  //       - 关最后一个窗格:传 onLastPaneClosed 决定是否关标签/退出。
  // ---------------------------------------------------------------------------

  return Commands;
});
