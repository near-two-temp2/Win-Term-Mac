// Win-Term-Mac · Tauri 方案 · 角色 [panes] · 工作区编排器(Workspace / 窗格控制器)
//
// 职责:把已有的「窗格二叉树(pane.js)」接到「真实终端视图 + 键位」上,成为可交互的窗格 UI。
//   - 持有当前窗格树 root,负责每次结构变化后调用 PaneCore.layout() 重排 DOM;
//   - 实现 palette.js 约定的 ControllerShape(split / moveFocus / resizePane /
//     swapPane / movePane / toggleZoom / closePane),既供命令面板调用,也供热键调用;
//   - 装配 keymap.js:Alt+Shift+± 拆分、Alt+方向 切焦点、Alt+Shift+方向 调大小、Mod+Shift+W 关闭;
//   - 焦点跟踪与高亮:点击/键盘切焦点都会更新「当前窗格」,并把边框高亮画到对应叶子上;
//   - 分隔条拖拽调比例已由 pane.js layout() 内建(onRatioChange 回调里 fit 终端),本模块复用。
//
// 复用而非重造:窗格树的一切算法(split/swap/move/navigate/resize/computeRects/layout)
//   全部走 pane.js;终端的创建/迁移/PTY 走「渲染器」(term.js 的 createTermManager 或
//   bridge.js 的 createBridge,二者都提供 renderLeaf)。本模块不碰它们的实现,只做编排。
//
// ─────────────────────────────────────────────────────────────────────────────
// integrator 需要如何调用我(接线指引,写在这里避免动 main.js):
//
//   import PaneCore from "./pane.js";
//   import { createTermManager } from "./term.js";        // 或 createBridge from "./bridge.js"
//   import { attachKeymap } from "./keymap.js";
//   import { createWorkspace } from "./workspace.js";
//   import { Palette, wirePalette } from "./palette.js";   // 可选:命令面板
//
//   const container = document.getElementById("root");
//   const tm = createTermManager({ shell: null });         // 提供 renderLeaf 的渲染器
//
//   const ws = createWorkspace({
//     container,
//     renderer: tm,               // 需含 renderLeaf;可选 focusPane/focus、fitAll、reconcile/pruneStale
//     attachKeys: true,           // 内建热键(拆分/切焦点/调大小/关闭)。若改用 palette.wirePalette 驱动
//                                 //   热键,则设 false,避免和 wirePalette 的 keymap 监听重复吞键。
//     onCommandPalette: () => palette.toggle(),  // 命中命令面板热键时回调(把面板交给 integrator)
//   });
//   ws.mount();                    // 首次渲染 + 装监听 + 聚焦首个窗格
//
//   // 命令面板复用同一套动作:
//   const palette = new Palette({ controller: ws.controller });
//   // 若想让面板里的 swapPane/movePane 也能用,直接把 ws.controller 交给它即可(上一行)。
//   // 若 attachKeys:false,则由 wirePalette 统一接管热键 + 面板:
//   //   wirePalette({ attachKeymap, palette });   // palette.execute 会调用 ws.controller.*
//
// 说明:renderer 的方法名做了兼容适配 —— 聚焦 focusPane|focus、对账 reconcile|pruneStale,
//       均可缺省(缺省则降级,不报错)。
// ─────────────────────────────────────────────────────────────────────────────

import PaneCore from "./pane.js";
import { attachKeymap } from "./keymap.js";

// 每次键盘「调整大小」命令改变比例的步进(占父容器主轴的比例)。
const RESIZE_STEP = 0.04;

// 焦点高亮样式(自包含注入,避免依赖外部 CSS)。
const STYLE_ID = "wtm-workspace-style";
const FOCUS_CLASS = "wtm-pane-focused";
const CSS = `
.pane-leaf { box-sizing: border-box; }
.pane-leaf.${FOCUS_CLASS} {
  outline: 2px solid #4fc1ff;
  outline-offset: -2px;
}
.pane-divider:hover { background: #4fc1ff !important; }
`;

function ensureStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

// 方向 → 移动语义(movePane 用):把当前窗格挪到目标窗格的哪一侧。
//   [分裂方向, 放置位置]  —— 与 pane.attach/move 的 (dir, {place}) 对齐。
const MOVE_MAP = Object.freeze({
  left: ["row", "before"],
  right: ["row", "after"],
  up: ["column", "before"],
  down: ["column", "after"],
});

/**
 * 创建一个工作区编排器。
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container           窗格根容器(会被 layout 反复清空重建)。
 * @param {object}      opts.renderer            终端渲染器,需含 renderLeaf(leaf, host)。
 *                                               可选:focusPane|focus(id)、fitAll()、reconcile|pruneStale(ids)。
 * @param {object}      [opts.initialRoot]       初始窗格树;默认单个叶子。
 * @param {boolean}     [opts.attachKeys=true]   是否内建热键监听(见文件头接线说明)。
 * @param {EventTarget} [opts.keyTarget=window]  热键监听目标。
 * @param {number}      [opts.resizeStep]        键盘调大小步进,默认 RESIZE_STEP。
 * @param {()=>void}    [opts.onCommandPalette]  命中命令面板热键时回调(integrator 接面板)。
 * @param {(id:string|null)=>void} [opts.onFocusChange]  焦点窗格变化回调。
 * @param {(root:object)=>void}    [opts.onTreeChange]   窗格树结构变化回调(供持久化/调试)。
 * @returns 工作区句柄(见文件末尾 return)。
 */
export function createWorkspace(opts = {}) {
  const container = opts.container;
  if (!container) throw new Error("createWorkspace: 需要 opts.container");
  const renderer = opts.renderer;
  if (!renderer || typeof renderer.renderLeaf !== "function") {
    throw new Error("createWorkspace: opts.renderer 需提供 renderLeaf(leaf, host)");
  }
  const resizeStep = opts.resizeStep ?? RESIZE_STEP;
  const keyTarget = opts.keyTarget ?? (typeof window !== "undefined" ? window : null);

  // ── 渲染器方法适配(term.js 与 bridge.js 命名略有差异)────────────────────────
  const rFocus = (id) => {
    const fn = renderer.focusPane || renderer.focus;
    if (typeof fn === "function") fn.call(renderer, id);
  };
  const rFitAll = () => {
    if (typeof renderer.fitAll === "function") renderer.fitAll();
  };
  const rReconcile = (ids) => {
    const fn = renderer.reconcile || renderer.pruneStale;
    if (typeof fn === "function") fn.call(renderer, ids);
  };

  // ── 状态 ──────────────────────────────────────────────────────────────────
  let root = opts.initialRoot ?? PaneCore.makeLeaf();
  let focusedId = null; // 当前焦点窗格 id
  let zoomedId = null; // 非 null 时只显示该窗格(最大化)
  let hosts = new Map(); // 最近一次 layout 产出的 leafId -> host 元素
  let detachKeys = null; // 热键卸载函数

  // ── 焦点 DOM 监听(点击/聚焦任意窗格 → 更新焦点)。渲染器无关:靠 data-pane-id。──
  const onDomFocus = (ev) => {
    const el = ev.target && ev.target.closest && ev.target.closest("[data-pane-id]");
    if (!el) return;
    const id = el.dataset.paneId;
    // 来自 DOM 的聚焦:更新状态与高亮,但不再回调 renderer.focus(避免与 term.focus 形成回环)。
    setFocus(id, { refocusTerm: false });
  };

  // ── 焦点设置 ────────────────────────────────────────────────────────────────
  function setFocus(id, { refocusTerm = true } = {}) {
    if (!id || !PaneCore.findLeaf(root, id)) return;
    const changed = id !== focusedId;
    focusedId = id;
    applyFocusHighlight();
    if (refocusTerm) rFocus(id);
    if (changed && typeof opts.onFocusChange === "function") opts.onFocusChange(id);
  }

  // 把高亮类打到当前焦点叶子的 host 上(每次 layout 后需重打,因为 DOM 被重建)。
  function applyFocusHighlight() {
    const nodes = container.querySelectorAll(".pane-leaf");
    nodes.forEach((el) => {
      el.classList.toggle(FOCUS_CLASS, el.dataset.paneId === focusedId);
    });
  }

  // 焦点窗格已消失(被关闭/坍缩)时,回落到任意存活叶子。
  function ensureFocusValid() {
    if (focusedId && PaneCore.findLeaf(root, focusedId)) return;
    const first = PaneCore.leaves(root)[0];
    focusedId = first ? first.id : null;
  }

  // ── 核心:重排 ──────────────────────────────────────────────────────────────
  // 把 root(或 zoom 时的单叶子视图)布局进 container,并对账回收已移除的终端。
  function render() {
    ensureFocusValid();
    // zoom:只渲染被最大化的叶子;其余叶子的终端 wrapper 暂时脱离 DOM(渲染器保活,不销毁)。
    let displayRoot = root;
    if (zoomedId) {
      const z = PaneCore.findLeaf(root, zoomedId);
      displayRoot = z || root;
    }

    hosts = PaneCore.layout(displayRoot, container, {
      renderLeaf: renderer.renderLeaf.bind(renderer),
      // 拖分隔条改比例后:节点 ratio 已就地更新,这里只需让所有终端重新 fit。
      onRatioChange: () => rFitAll(),
    });

    // 对账用「完整树」的叶子集合(而非 zoom 后的单叶子),避免把被最大化时隐藏的窗格误杀。
    rReconcile(PaneCore.leaves(root).map((l) => l.id));
    applyFocusHighlight();
    rFitAll();
    if (typeof opts.onTreeChange === "function") opts.onTreeChange(root);
  }

  // ── ControllerShape:拆分 ────────────────────────────────────────────────────
  // dir: "row"(向右)| "column"(向下)。在当前焦点窗格处拆分,新窗格取得焦点。
  function split(dir) {
    const target = currentTargetId();
    if (!target) return;
    if (dir !== "row" && dir !== "column") return;
    if (zoomedId) zoomedId = null; // 拆分时退出最大化,以便看到新窗格
    const newLeaf = PaneCore.makeLeaf();
    root = PaneCore.split(root, target, dir, newLeaf, { place: "after" });
    render();
    setFocus(newLeaf.id, { refocusTerm: true });
  }

  // ── ControllerShape:切焦点 ──────────────────────────────────────────────────
  // dir: left/right/up/down。按几何相邻找目标窗格并聚焦。
  function moveFocus(dir) {
    const from = currentTargetId();
    if (!from) return;
    const targetId = PaneCore.navigate(root, from, dir);
    if (targetId) setFocus(targetId, { refocusTerm: true });
  }

  // ── ControllerShape:调整大小 ────────────────────────────────────────────────
  // dir: left/right/up/down。right/down 使当前窗格变大,left/up 使其变小。
  function resizePane(dir) {
    const target = currentTargetId();
    if (!target) return;
    const axis = dir === "left" || dir === "right" ? "row" : "column";
    const delta = dir === "right" || dir === "down" ? resizeStep : -resizeStep;
    root = PaneCore.resize(root, target, axis, delta); // 就地改 ratio,返回同一 root
    render();
    setFocus(target, { refocusTerm: false }); // 保持焦点,不抢终端焦点
  }

  // ── ControllerShape:交换窗格(命令面板 swapPane)──────────────────────────────
  // 与 dir 方向上的相邻窗格交换位置(内容随节点一起走,PTY 不重开)。
  function swapPane(dir) {
    const from = currentTargetId();
    if (!from) return;
    const targetId = PaneCore.navigate(root, from, dir);
    if (!targetId || targetId === from) return;
    root = PaneCore.swap(root, from, targetId);
    render();
    // 焦点跟随「同一个 id」:该窗格换到了新位置,焦点仍在它身上。
    setFocus(from, { refocusTerm: true });
  }

  // ── ControllerShape:移动窗格(命令面板 movePane)──────────────────────────────
  // 把当前窗格从原位摘下,挂到 dir 方向相邻窗格的对应侧。
  function movePane(dir) {
    const from = currentTargetId();
    if (!from) return;
    const targetId = PaneCore.navigate(root, from, dir);
    if (!targetId || targetId === from) return;
    const spec = MOVE_MAP[dir];
    if (!spec) return;
    const [splitDir, place] = spec;
    root = PaneCore.move(root, from, targetId, splitDir, { place });
    render();
    setFocus(from, { refocusTerm: true });
  }

  // ── ControllerShape:最大化 / 还原当前窗格 ──────────────────────────────────
  function toggleZoom() {
    const target = currentTargetId();
    if (!target) return;
    zoomedId = zoomedId ? null : target;
    render();
    setFocus(target, { refocusTerm: true });
  }

  // ── ControllerShape:关闭当前窗格 ────────────────────────────────────────────
  // 摘掉焦点窗格(兄弟顶替,树坍缩);对账会 kill 掉它的 PTY。最后一个窗格不关。
  function closePane() {
    const target = currentTargetId();
    if (!target) return;
    if (PaneCore.leaves(root).length <= 1) return; // 保留至少一个窗格
    if (zoomedId === target) zoomedId = null;
    // 关闭前先算好一个「就近的下一个焦点」:优先其几何右/下邻,退而取任意其它叶子。
    const nextCandidate =
      PaneCore.navigate(root, target, "right") ||
      PaneCore.navigate(root, target, "down") ||
      PaneCore.navigate(root, target, "left") ||
      PaneCore.navigate(root, target, "up") ||
      PaneCore.leaves(root).find((l) => l.id !== target)?.id ||
      null;
    const res = PaneCore.detach(root, target);
    root = res.root ?? PaneCore.makeLeaf(); // 理论上不会为 null(已挡最后一个)
    focusedId = null; // 交给 ensureFocusValid / 下面重设
    render(); // reconcile 在此 kill 掉被摘窗格的 PTY
    if (nextCandidate && PaneCore.findLeaf(root, nextCandidate)) {
      setFocus(nextCandidate, { refocusTerm: true });
    } else {
      const first = PaneCore.leaves(root)[0];
      if (first) setFocus(first.id, { refocusTerm: true });
    }
  }

  // 当前操作目标:优先焦点窗格;焦点无效时回落首个叶子。
  function currentTargetId() {
    if (focusedId && PaneCore.findLeaf(root, focusedId)) return focusedId;
    const first = PaneCore.leaves(root)[0];
    return first ? first.id : null;
  }

  // ── 命令 id → 动作分发(供内建热键使用;命名与 keymap.js/palette.js 对齐)──────
  function dispatchCommand(command) {
    switch (command) {
      case "commandPalette":
        if (typeof opts.onCommandPalette === "function") opts.onCommandPalette();
        return true;
      case "splitPane.right":
        split("row");
        return true;
      case "splitPane.down":
        split("column");
        return true;
      case "moveFocus.left":
        moveFocus("left");
        return true;
      case "moveFocus.right":
        moveFocus("right");
        return true;
      case "moveFocus.up":
        moveFocus("up");
        return true;
      case "moveFocus.down":
        moveFocus("down");
        return true;
      case "resizePane.left":
        resizePane("left");
        return true;
      case "resizePane.right":
        resizePane("right");
        return true;
      case "resizePane.up":
        resizePane("up");
        return true;
      case "resizePane.down":
        resizePane("down");
        return true;
      case "closePane":
        closePane();
        return true;
      default:
        // swapPane.* / movePane.* 等无默认热键的命令:不在此拦截,放行(false)。
        return false;
    }
  }

  // controller:交给 palette.js(其 buildDefaultCommands 的 run() 会调这些方法)。
  const controller = {
    split,
    moveFocus,
    resizePane,
    swapPane,
    movePane,
    toggleZoom,
    closePane,
  };

  // ── 挂载:首次渲染 + 装 DOM 焦点监听 + 可选热键 ──────────────────────────────
  function mount() {
    ensureStyle();
    container.addEventListener("focusin", onDomFocus, true);
    container.addEventListener("mousedown", onDomFocus, true);
    render();
    // 初始聚焦首个窗格。
    const first = PaneCore.leaves(root)[0];
    if (first) setFocus(first.id, { refocusTerm: true });
    if (opts.attachKeys !== false && keyTarget) {
      detachKeys = attachKeymap(keyTarget, (command) => dispatchCommand(command));
    }
    return handle;
  }

  // ── 卸载:移除监听。(终端/PTY 由渲染器的 disposeAll 收尾,不在此越界处理。)──────
  function destroy() {
    container.removeEventListener("focusin", onDomFocus, true);
    container.removeEventListener("mousedown", onDomFocus, true);
    if (detachKeys) {
      detachKeys();
      detachKeys = null;
    }
  }

  const handle = {
    mount,
    destroy,
    render,
    controller,
    dispatchCommand, // 供不想用内建 attachKeymap 的 integrator 自行接线
    getRoot: () => root,
    setRoot: (r) => {
      root = r;
      render();
    },
    getFocusedId: () => focusedId,
    focus: (id) => setFocus(id, { refocusTerm: true }),
    getHosts: () => hosts,
    isZoomed: () => zoomedId != null,
  };
  return handle;
}

export default { createWorkspace };
