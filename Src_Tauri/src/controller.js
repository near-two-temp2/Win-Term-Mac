// Win-Term-Mac · Tauri 方案 · 角色 cmd(命令面板 + 键位 装配 / 控制器)
//
// 职责:把 palette.js 的命令、keymap.js 的热键,真正接到 pane.js 的窗格二叉树上,
//       并驱动视图重排(relayout)。也就是 palette.js 末尾 ControllerShape 的实现:
//         split / moveFocus / resizePane / swapPane / movePane / toggleZoom / closePane
//       全部落到真实的树变换 + 终端视图迁移,而非 TODO 桩。
//
//   - 复用 pane.js 的纯逻辑(split/navigate/resize/swap/move/detach/layout),不另造一套。
//   - 复用 palette.js 的 Palette + wirePalette,keymap.js 的 attachKeymap。
//   - 复用「终端视图管理器」:兼容 term.js 的 createTermManager 与 bridge.js 的 createBridge
//     两种形态(方法名不同,内部做归一适配),由集成层择一注入。
//
//   纪律对齐:swap/move 仅命令面板可触发(paletteOnly,palette.js 已保证);
//             split/moveFocus/resizePane 既有热键也能从面板走。
//
// ─────────────────────────────────────────────────────────────────────────────
// integrator 需要如何调用我(接线指引,写在这里,避免改 main.js):
//
//   import PaneCore from "./pane.js";
//   import { createTermManager } from "./term.js";   // 或 createBridge from "./bridge.js"
//   import { mountController } from "./controller.js";
//
//   const container = document.getElementById("root");     // 窗格挂载容器(整屏)
//   const view = createTermManager({ shell: null });        // 或 createBridge({...})
//
//   const app = mountController({ container, view });        // 一步装配:建树 + 首绘 + 接热键/面板
//
//   // 若用 term.js:把它的 onFocus 回调接回来,让点击/Tab 聚焦也同步「当前窗格」:
//   //   createTermManager({ onFocus: (id) => app.notifyFocus(id) })
//   // bridge.js 无 onFocus,则由本控制器在切焦点/新建时主动 view.focus()。
//
//   // 命令面板热键 Ctrl/Cmd+Shift+P 已自动生效;窗口尺寸变化时:
//   window.addEventListener("resize", () => app.relayout());
//
// 返回的 app: { controller, palette, relayout, notifyFocus, getState, destroy }
// ─────────────────────────────────────────────────────────────────────────────

import PaneCore from "./pane.js";
import { Palette, wirePalette } from "./palette.js";
import { attachKeymap } from "./keymap.js";

// 每次 resizePane 命令 / 热键调整的比例步长。
const RESIZE_DELTA = 0.04;

// ─────────────────────────────────────────────────────────────────────────────
// 视图适配层:把 term.js(createTermManager)与 bridge.js(createBridge)两套
// 略有差异的方法名,归一成控制器需要的最小接口。
//   renderLeaf(leaf, host) : pane.layout 的回调
//   fitAll()               : 重排后统一适配
//   focus(id)              : 聚焦某窗格终端
//   reconcile(liveIds)     : 按存活叶子 id 回收其余会话(kill PTY)
//   focusedId()            : 视图自报的当前焦点(可能为 undefined)
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeView(view) {
  if (!view) throw new Error("normalizeView: 需要注入终端视图管理器(term.js / bridge.js)");
  const pick = (...names) => {
    for (const n of names) {
      if (typeof view[n] === "function") return view[n].bind(view);
    }
    return null;
  };
  const renderLeaf = pick("renderLeaf");
  if (!renderLeaf) throw new Error("normalizeView: 视图缺少 renderLeaf");
  const focus = pick("focus", "focusPane") ?? (() => {});
  const fitAll = pick("fitAll") ?? (() => {});
  const reconcile = pick("reconcile", "pruneStale") ?? (() => {});
  const focusedId = pick("getFocusedPaneId"); // 可能不存在(bridge.js 无)
  return { renderLeaf, focus, fitAll, reconcile, focusedId };
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯逻辑归约器(reducer):只操作 { root, focusId },不碰 DOM,便于 selfTest。
// 每个返回新的 { root, focusId };无法执行(边界 / 唯一叶子)时原样返回旧 state。
// ─────────────────────────────────────────────────────────────────────────────

// 方向 → 拆分轴:左右属于 row(竖直分隔),上下属于 column(水平分隔)。
const DIR_AXIS = { left: "row", right: "row", up: "column", down: "column" };
// 方向 → 在目标的哪一侧落子:左/上在前(before),右/下在后(after)。
const DIR_PLACE = { left: "before", up: "before", right: "after", down: "after" };
// resizePane:正向(right/down)增大当前窗格,反向(left/up)缩小。
const DIR_GROW = { left: -1, up: -1, right: 1, down: 1 };

export function reduceSplit(state, dir, newLeaf = PaneCore.makeLeaf()) {
  const root = PaneCore.split(state.root, state.focusId, dir, newLeaf);
  return { root, focusId: newLeaf.id };
}

export function reduceMoveFocus(state, dir) {
  const target = PaneCore.navigate(state.root, state.focusId, dir);
  if (!target) return state; // 已在边界
  return { root: state.root, focusId: target };
}

export function reduceResize(state, dir) {
  const axis = DIR_AXIS[dir];
  const grow = DIR_GROW[dir];
  if (!axis) return state;
  // resize() 里正 delta 恒为「增大当前叶子」;grow 决定增/减。
  const root = PaneCore.resize(state.root, state.focusId, axis, grow * RESIZE_DELTA);
  return { root, focusId: state.focusId };
}

export function reduceSwap(state, dir) {
  const target = PaneCore.navigate(state.root, state.focusId, dir);
  if (!target) return state;
  const root = PaneCore.swap(state.root, state.focusId, target);
  // 内容随节点走,焦点仍在同一 id(同一终端)上。
  return { root, focusId: state.focusId };
}

export function reduceMove(state, dir) {
  const target = PaneCore.navigate(state.root, state.focusId, dir);
  if (!target || target === state.focusId) return state;
  const axis = DIR_AXIS[dir];
  const place = DIR_PLACE[dir];
  const root = PaneCore.move(state.root, state.focusId, target, axis, { place });
  return { root, focusId: state.focusId };
}

export function reduceClose(state) {
  const all = PaneCore.leaves(state.root);
  if (all.length <= 1) return state; // 最后一个窗格不关(WT 语义:关的是标签页/窗口)
  const { root } = PaneCore.detach(state.root, state.focusId);
  // 焦点回落到剩余的第一个叶子。
  const fallback = PaneCore.leaves(root)[0];
  return { root, focusId: fallback ? fallback.id : null };
}

// ─────────────────────────────────────────────────────────────────────────────
// 控制器:持有 { root, focusId } 状态 + zoom 标志,负责调 reducer → 重排 → 聚焦。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 创建控制器(不含热键/面板装配;纯动作接口 + 重排)。
 * @param opts.container 窗格挂载容器(DOM)
 * @param opts.view      归一后的视图接口(见 normalizeView)或原始 term/bridge 管理器
 * @param opts.root      初始树(默认单叶子)
 * @param opts.resizeDelta 覆盖比例步长
 * @returns controller(实现 ControllerShape)+ relayout / notifyFocus / getState / setRoot
 */
export function createController(opts = {}) {
  const container = opts.container;
  const view = normalizeView(opts.view);
  const delta = opts.resizeDelta ?? RESIZE_DELTA;

  let root = opts.root ?? PaneCore.makeLeaf();
  let focusId = PaneCore.leaves(root)[0]?.id ?? null;
  let zoomId = null; // 非 null 时:只显示该叶子(最大化)

  const state = () => ({ root, focusId });

  // ── 重排:把当前树(或 zoom 时的单叶子)渲染进 container,并回收失效会话。──────
  function relayout() {
    // liveIds 恒以完整 root 计算:zoom 时其它窗格只是暂时不显示,PTY 不能被 kill。
    const liveIds = PaneCore.leaves(root).map((l) => l.id);
    let renderRoot = root;
    if (zoomId) {
      const zLeaf = PaneCore.findLeaf(root, zoomId);
      if (zLeaf) renderRoot = zLeaf; // 单叶子铺满
      else zoomId = null; // 目标已不存在,取消 zoom
    }
    if (!container) return; // 无 DOM(如 selfTest 环境):只维护状态
    PaneCore.layout(renderRoot, container, {
      renderLeaf: view.renderLeaf,
      onRatioChange: () => view.fitAll(),
    });
    view.fitAll();
    view.reconcile(liveIds);
    // 重排后把键盘焦点交还当前窗格(等布局完成再 focus,拿得到 textarea)。
    scheduleFocus();
  }

  let _focusQueued = false;
  function scheduleFocus() {
    if (_focusQueued) return;
    _focusQueued = true;
    const run = () => {
      _focusQueued = false;
      if (focusId) view.focus(focusId);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else run();
  }

  // 若视图自己能报告焦点(term.js),优先采信;否则用内部记录。
  function currentFocus() {
    if (view.focusedId) {
      const v = view.focusedId();
      if (v && PaneCore.findLeaf(root, v)) return v;
    }
    if (focusId && PaneCore.findLeaf(root, focusId)) return focusId;
    const first = PaneCore.leaves(root)[0];
    return first ? first.id : null;
  }

  // 外部(点击/Tab 聚焦)回调:同步当前窗格。
  function notifyFocus(id) {
    if (PaneCore.findLeaf(root, id)) focusId = id;
  }

  // 应用一个 reducer 结果:更新状态,必要时重排。
  function apply(next, { relayout: doRelayout = true } = {}) {
    const changed = next.root !== root || next.focusId !== focusId;
    root = next.root;
    focusId = next.focusId;
    if (doRelayout && changed) relayout();
    return changed;
  }

  // ── ControllerShape 实现 ─────────────────────────────────────────────────
  const controller = {
    // dir: "row"(右) | "column"(下)
    split(dir) {
      if (zoomId) return; // 最大化态下不拆分(先还原更符合直觉)
      apply(reduceSplit(currentFocusState(), dir));
    },
    // dir: left/right/up/down —— 换焦点,无需重排,只聚焦
    moveFocus(dir) {
      if (zoomId) return; // 最大化态下无「相邻」可切
      const next = reduceMoveFocus(currentFocusState(), dir);
      if (next.focusId !== focusId) {
        focusId = next.focusId;
        scheduleFocus();
      }
    },
    resizePane(dir) {
      if (zoomId) return;
      // resize 只改比例、树引用不变;仍需重排让 flex 与 PTY 尺寸跟上。
      apply(reduceResize(currentFocusState(), dir));
    },
    // 面板专用:与相邻窗格交换
    swapPane(dir) {
      if (zoomId) return;
      apply(reduceSwap(currentFocusState(), dir));
    },
    // 面板专用:移动到相邻侧
    movePane(dir) {
      if (zoomId) return;
      apply(reduceMove(currentFocusState(), dir));
    },
    // 最大化 / 还原当前窗格
    toggleZoom() {
      const id = currentFocus();
      if (!id) return;
      if (PaneCore.leaves(root).length <= 1) return; // 只有一个窗格,无所谓 zoom
      zoomId = zoomId ? null : id;
      relayout();
    },
    // 关闭当前窗格(最后一个不关);reconcile 会 kill 对应 PTY
    closePane() {
      if (zoomId) zoomId = null; // 关闭前先退出最大化
      apply(reduceClose(currentFocusState()));
    },
  };

  // 每次动作都以「实时焦点」为准(可能被点击改过)。
  function currentFocusState() {
    focusId = currentFocus();
    return { root, focusId };
  }

  return {
    controller,
    relayout,
    notifyFocus,
    getState: () => state(),
    setRoot(newRoot, newFocus) {
      root = newRoot;
      focusId = newFocus ?? PaneCore.leaves(newRoot)[0]?.id ?? null;
      zoomId = null;
      relayout();
    },
    get isZoomed() {
      return zoomId != null;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 一步装配:控制器 + 命令面板 + 热键。集成层最省事的入口。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param opts.container 窗格容器 DOM
 * @param opts.view      term.js / bridge.js 管理器实例
 * @param opts.root      初始树(默认单叶子)
 * @param opts.target    键位监听目标(默认 window)
 * @param opts.commands  覆盖命令表(默认 palette 内置)
 * @returns { controller, palette, relayout, notifyFocus, getState, destroy }
 */
export function mountController(opts = {}) {
  const app = createController(opts);
  const palette = new Palette({
    controller: app.controller,
    commands: opts.commands,
  });

  // 接热键:commandPalette → 开关面板;其余命令 → palette.execute(热键路径)。
  const detach = wirePalette({
    attachKeymap,
    palette,
    target: opts.target ?? (typeof window !== "undefined" ? window : undefined),
  });

  // 首绘。
  app.relayout();

  return {
    controller: app.controller,
    palette,
    relayout: app.relayout,
    notifyFocus: app.notifyFocus,
    getState: app.getState,
    setRoot: app.setRoot,
    get isZoomed() {
      return app.isZoomed;
    },
    // 卸载热键监听(应用销毁时)。
    destroy() {
      if (typeof detach === "function") detach();
      if (palette.open) palette.closePalette();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯逻辑自测(无 DOM):验证各 reducer 对窗格树的作用正确。
//   用法:import { selfTest } from "./controller.js"; selfTest();
// ─────────────────────────────────────────────────────────────────────────────

export function selfTest() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`[controller.selfTest] 断言失败: ${msg}`);
  };
  let n = 0;
  const check = (cond, msg) => {
    n += 1;
    assert(cond, msg);
  };

  // 初始单叶子。
  let st = { root: PaneCore.makeLeaf("root"), focusId: "root" };

  // split 向右:root | new,焦点移到新叶子。
  st = reduceSplit(st, "row", PaneCore.makeLeaf("b"));
  check(PaneCore.leaves(st.root).length === 2, "split 后两叶子");
  check(st.focusId === "b", "split 后焦点在新叶子 b");
  check(PaneCore.isSplit(st.root) && st.root.dir === "row", "根为 row 分裂");

  // 再向下拆 b:root | (b / c)
  st = reduceSplit(st, "column", PaneCore.makeLeaf("c"));
  check(PaneCore.leaves(st.root).length === 3, "再拆得三叶子");
  check(st.focusId === "c", "焦点在 c");

  // moveFocus:c 向上到 b
  st = reduceMoveFocus(st, "up");
  check(st.focusId === "b", "c 向上聚焦到 b");
  // 边界:root(最左)向左无相邻,焦点不变
  const beforeBoundary = { root: st.root, focusId: "root" };
  const afterBoundary = reduceMoveFocus(beforeBoundary, "left");
  check(afterBoundary.focusId === "root", "root 向左到边界焦点不变");

  // resize:焦点 b 向右增大,最近 row 祖先比例应变化
  st.focusId = "b";
  const bLoc = PaneCore.findParent(st.root, PaneCore.findLeaf(st.root, "b"));
  // b 的直接父是 column 分裂;resize row 会向上找到 root(row 分裂)
  const ratioBefore = st.root.ratio;
  st = reduceResize(st, "right");
  check(st.root.ratio !== ratioBefore, "resize right 改变了 row 祖先比例");
  void bLoc;

  // swap:交换 root 与 c(仅面板可触发,这里直接测 reducer)
  st.focusId = "root";
  const rightId = PaneCore.navigate(st.root, "root", "right");
  st = reduceSwap(st, "right");
  check(PaneCore.leaves(st.root).length === 3, "swap 不增减叶子");
  check(st.focusId === "root", "swap 后焦点仍在 root(内容随节点走)");
  void rightId;

  // move:把 root 移到 c 那侧一测(不崩、叶子数不变)
  const movable = { root: st.root, focusId: "root" };
  const target = PaneCore.navigate(movable.root, "root", "right");
  if (target) {
    const moved = reduceMove(movable, "right");
    check(PaneCore.leaves(moved.root).length === 3, "move 后叶子数不变");
    st = moved;
  }

  // close:关掉当前焦点叶子,叶子数 -1;最后一个不关
  const cntBefore = PaneCore.leaves(st.root).length;
  st = reduceClose(st);
  check(PaneCore.leaves(st.root).length === cntBefore - 1, "close 后少一个叶子");
  // 连关到只剩一个,再 close 应为 no-op
  while (PaneCore.leaves(st.root).length > 1) st = reduceClose(st);
  const lone = reduceClose(st);
  check(PaneCore.leaves(lone.root).length === 1, "最后一个窗格不可关");

  // eslint-disable-next-line no-console
  console.log(`[controller.selfTest] 通过 ${n} 项断言。`);
  return true;
}

export default {
  createController,
  mountController,
  normalizeView,
  reduceSplit,
  reduceMoveFocus,
  reduceResize,
  reduceSwap,
  reduceMove,
  reduceClose,
  selfTest,
};
