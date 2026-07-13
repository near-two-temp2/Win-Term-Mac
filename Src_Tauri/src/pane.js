// Win-Term-Mac · Tauri 方案 · 角色 PaneCore
// 职责:用纯 JS 对象表示"窗格二叉树",复刻 Windows Terminal 的窗格模型与核心操作,
//       并把这棵树布局成 DOM(flex + 可拖拽分隔条)。不依赖 xterm/Tauri,可独立自测。
//
// 数据模型(对齐已核实的 WT 事实):
//   叶子 leaf  : { kind: "leaf",  id, term }        —— 对应一个真终端(term 由集成层塞入)
//   分裂 split : { kind: "split", dir, ratio, first, second }
//       dir   : "row"    左右并排(分隔条竖直,对应 WT 的"右侧拆分")
//               "column" 上下堆叠(分隔条水平,对应 WT 的"下方拆分")
//       ratio : 0~1,first 子节点占父容器主轴的比例
//       first / second : 两个子节点(leaf 或 split)
//
// 约定:所有会改变树"根引用"的操作(split/detach/move)都返回新的根节点;
//       调用方必须用返回值替换自己持有的 root。就地改写子节点是允许的。

// ---------------------------------------------------------------------------
// 构造与查询
// ---------------------------------------------------------------------------

let _autoId = 0;

/** 生成一个进程内唯一的窗格 id(集成层也可自带 id)。 */
export function nextPaneId() {
  _autoId += 1;
  return `pane-${_autoId}`;
}

/** 新建一个叶子节点。term 为可选的真终端句柄(集成层注入)。 */
export function makeLeaf(id = nextPaneId(), term = null) {
  return { kind: "leaf", id, term };
}

/** 新建一个分裂节点。 */
export function makeSplit(dir, first, second, ratio = 0.5) {
  if (dir !== "row" && dir !== "column") {
    throw new Error(`makeSplit: dir 必须是 "row" | "column",收到 ${dir}`);
  }
  return { kind: "split", dir, ratio: clampRatio(ratio), first, second };
}

export const isLeaf = (n) => !!n && n.kind === "leaf";
export const isSplit = (n) => !!n && n.kind === "split";

/** 把 ratio 夹到 (0,1) 的合理区间,避免出现 0 宽窗格。 */
function clampRatio(r) {
  const MIN = 0.05;
  const MAX = 0.95;
  if (!Number.isFinite(r)) return 0.5;
  return Math.min(MAX, Math.max(MIN, r));
}

/** 深度优先遍历整棵树,对每个节点调用 visitor(node, parent, depth)。 */
export function walk(root, visitor, parent = null, depth = 0) {
  if (!root) return;
  visitor(root, parent, depth);
  if (isSplit(root)) {
    walk(root.first, visitor, root, depth + 1);
    walk(root.second, visitor, root, depth + 1);
  }
}

/** 收集所有叶子节点(按 first→second 的自然顺序)。 */
export function leaves(root) {
  const out = [];
  walk(root, (n) => {
    if (isLeaf(n)) out.push(n);
  });
  return out;
}

/** 按 id 查找叶子;找不到返回 null。 */
export function findLeaf(root, id) {
  let hit = null;
  walk(root, (n) => {
    if (isLeaf(n) && n.id === id) hit = n;
  });
  return hit;
}

/** 查找某节点的父分裂节点及它所在的分支("first"|"second");根节点返回 null。 */
export function findParent(root, target) {
  let found = null;
  walk(root, (n) => {
    if (isSplit(n)) {
      if (n.first === target) found = { parent: n, branch: "first" };
      else if (n.second === target) found = { parent: n, branch: "second" };
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// split —— 把一个叶子换成分裂节点(WT 的核心操作)
// ---------------------------------------------------------------------------

/**
 * 在 targetId 指定的叶子处拆分。
 * @param root       当前根
 * @param targetId   要拆分的叶子 id
 * @param dir        "row"(右侧拆分)| "column"(下方拆分)
 * @param newLeaf    新叶子节点;默认自动生成
 * @param opts.place "after"(新叶子在 second,默认,对应"往右/往下开")| "before"
 * @param opts.ratio 新分裂节点的比例
 * @returns 新的根节点
 */
export function split(root, targetId, dir, newLeaf = makeLeaf(), opts = {}) {
  const place = opts.place === "before" ? "before" : "after";
  const ratio = opts.ratio ?? 0.5;
  const target = findLeaf(root, targetId);
  if (!target) throw new Error(`split: 找不到叶子 ${targetId}`);

  // 原叶子保留在一侧,新叶子在另一侧
  const first = place === "after" ? target : newLeaf;
  const second = place === "after" ? newLeaf : target;
  const splitNode = makeSplit(dir, first, second, ratio);

  return replaceNode(root, target, splitNode);
}

/**
 * 把树中的 oldNode 原地替换为 newNode。若 oldNode 就是根,直接返回 newNode。
 * @returns 新的根节点
 */
export function replaceNode(root, oldNode, newNode) {
  if (root === oldNode) return newNode;
  const loc = findParent(root, oldNode);
  if (!loc) throw new Error("replaceNode: 目标不在树中");
  loc.parent[loc.branch] = newNode;
  return root;
}

// ---------------------------------------------------------------------------
// swap —— 交换两个叶子(WT 命令面板 swapPane)
// ---------------------------------------------------------------------------

/** 交换两个叶子在树中的位置(内容随节点一起走)。返回根(根引用不变)。 */
export function swap(root, idA, idB) {
  if (idA === idB) return root;
  const a = findLeaf(root, idA);
  const b = findLeaf(root, idB);
  if (!a || !b) throw new Error(`swap: 找不到叶子 ${!a ? idA : idB}`);

  const la = findParent(root, a);
  const lb = findParent(root, b);
  // 两个都非根才能交换;根一定是唯一叶子的场景不会走到这
  if (!la || !lb) throw new Error("swap: 叶子无父节点(根叶子无法交换)");

  la.parent[la.branch] = b;
  lb.parent[lb.branch] = a;
  return root;
}

// ---------------------------------------------------------------------------
// detach / attach / move —— 摘下、挂上、移动(拖拽移动的基础)
// ---------------------------------------------------------------------------

/**
 * 摘下一个叶子。它的兄弟节点顶替父分裂节点的位置(树自动坍缩)。
 * @returns { root, node } —— 新根 + 被摘下的叶子节点(游离)
 */
export function detach(root, targetId) {
  const node = findLeaf(root, targetId);
  if (!node) throw new Error(`detach: 找不到叶子 ${targetId}`);
  const loc = findParent(root, node);
  if (!loc) {
    // 摘的是根叶子:树变空
    return { root: null, node };
  }
  const sibling = loc.branch === "first" ? loc.parent.second : loc.parent.first;
  // 用兄弟顶替父分裂节点
  const newRoot = replaceNode(root, loc.parent, sibling);
  return { root: newRoot, node };
}

/**
 * 把一个游离节点(通常是 detach 出来的叶子)挂到 targetId 叶子旁边。
 * 语义等价于在 target 处 split,并把 detached 放到新腾出的一侧。
 * @returns 新的根节点
 */
export function attach(root, targetId, detached, dir, opts = {}) {
  const place = opts.place === "before" ? "before" : "after";
  const ratio = opts.ratio ?? 0.5;
  const target = findLeaf(root, targetId);
  if (!target) throw new Error(`attach: 找不到叶子 ${targetId}`);
  if (!root) return detached; // 空树:游离节点成为新根

  const first = place === "after" ? target : detached;
  const second = place === "after" ? detached : target;
  const splitNode = makeSplit(dir, first, second, ratio);
  return replaceNode(root, target, splitNode);
}

/**
 * 移动一个窗格:把 movingId 从原位摘下,挂到 targetId 旁。
 * 这是拖拽移动 / moveePane 的基础组合。
 * @returns 新的根节点
 */
export function move(root, movingId, targetId, dir, opts = {}) {
  if (movingId === targetId) return root;
  const { root: afterDetach, node } = detach(root, movingId);
  if (!afterDetach) throw new Error("move: 无法移动唯一的根叶子");
  // 若目标恰好被坍缩没了(理论上不会,因为 target != moving),findLeaf 会兜底报错
  return attach(afterDetach, targetId, node, dir, opts);
}

// ---------------------------------------------------------------------------
// 几何计算与 navigate —— 按方向找相邻焦点(WT 的 Alt+方向键)
// ---------------------------------------------------------------------------

/**
 * 给定根容器矩形,递归算出每个叶子的矩形(相对坐标,单位任意)。
 * @returns Map<leafId, {x, y, w, h}>
 */
export function computeRects(root, rect = { x: 0, y: 0, w: 1, h: 1 }) {
  const map = new Map();
  (function recur(node, r) {
    if (!node) return;
    if (isLeaf(node)) {
      map.set(node.id, { ...r });
      return;
    }
    if (node.dir === "row") {
      const w1 = r.w * node.ratio;
      recur(node.first, { x: r.x, y: r.y, w: w1, h: r.h });
      recur(node.second, { x: r.x + w1, y: r.y, w: r.w - w1, h: r.h });
    } else {
      const h1 = r.h * node.ratio;
      recur(node.first, { x: r.x, y: r.y, w: r.w, h: h1 });
      recur(node.second, { x: r.x, y: r.y + h1, w: r.w, h: r.h - h1 });
    }
  })(root, rect);
  return map;
}

/**
 * 从 fromId 出发,朝 direction("left"|"right"|"up"|"down")找几何上最近的相邻叶子。
 * 判据:目标必须整体位于该方向,且在垂直轴上与源有重叠;取该方向上间距最小、
 *       重叠最多者。找不到返回 null(已在边界)。
 */
export function navigate(root, fromId, direction) {
  const rects = computeRects(root);
  const from = rects.get(fromId);
  if (!from) return null;

  const fromCX = from.x + from.w / 2;
  const fromCY = from.y + from.h / 2;
  let best = null;
  let bestScore = Infinity;

  for (const [id, r] of rects) {
    if (id === fromId) continue;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;

    let inDir = false;
    let overlap = 0;
    let gap = 0;

    if (direction === "left" || direction === "right") {
      // 主轴 x:目标中心必须在正确一侧
      inDir = direction === "left" ? cx < fromCX : cx > fromCX;
      // 垂直轴 y 上的重叠量
      overlap =
        Math.min(from.y + from.h, r.y + r.h) - Math.max(from.y, r.y);
      gap = Math.abs(cx - fromCX);
    } else if (direction === "up" || direction === "down") {
      inDir = direction === "up" ? cy < fromCY : cy > fromCY;
      overlap =
        Math.min(from.x + from.w, r.x + r.w) - Math.max(from.x, r.x);
      gap = Math.abs(cy - fromCY);
    } else {
      throw new Error(`navigate: 未知方向 ${direction}`);
    }

    if (!inDir || overlap <= 0) continue;
    // 评分:优先重叠多(减分),其次间距近(加分)。间距为主,重叠为次要修正。
    const score = gap - overlap * 0.001;
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// resize —— 调整某个分裂节点的比例(WT 的 Alt+Shift+方向键)
// ---------------------------------------------------------------------------

/**
 * 找到 leafId 最近的、方向与 axis 匹配的祖先分裂节点,把其 ratio 增加 delta。
 * @param axis "row" 调左右分隔;"column" 调上下分隔
 * @returns 新的根(根引用不变)
 */
export function resize(root, leafId, axis, delta) {
  const leaf = findLeaf(root, leafId);
  if (!leaf) throw new Error(`resize: 找不到叶子 ${leafId}`);
  // 向上找第一个 dir===axis 的祖先
  let cur = leaf;
  while (true) {
    const loc = findParent(root, cur);
    if (!loc) return root; // 没有匹配方向的祖先,忽略
    if (loc.parent.dir === axis) {
      // first 分支增大 ratio,second 分支反向
      const sign = loc.branch === "first" ? 1 : -1;
      loc.parent.ratio = clampRatio(loc.parent.ratio + sign * delta);
      return root;
    }
    cur = loc.parent;
  }
}

// ---------------------------------------------------------------------------
// layout —— 把树渲染成 DOM(flex + 可拖拽分隔条)
// ---------------------------------------------------------------------------

const DIVIDER_PX = 6; // 分隔条厚度

/**
 * 把窗格树渲染进 container。
 * @param root      窗格树根
 * @param container 目标 DOM 容器(会被清空)
 * @param opts.renderLeaf (leaf, hostEl) => void  由集成层把 xterm 挂到 hostEl
 * @param opts.onRatioChange (splitNode, newRatio) => void  拖拽分隔条时回调(集成层据此重排/写回)
 * @returns Map<leafId, HTMLElement>  每个叶子的宿主元素(供集成层 term.open / fit)
 */
export function layout(root, container, opts = {}) {
  const hosts = new Map();
  container.innerHTML = "";
  container.style.position = "relative";
  if (!root) return hosts;

  const el = buildNode(root, hosts, opts);
  el.style.width = "100%";
  el.style.height = "100%";
  container.appendChild(el);
  return hosts;
}

/** 递归构造单个节点的 DOM。 */
function buildNode(node, hosts, opts) {
  if (isLeaf(node)) {
    const host = document.createElement("div");
    host.className = "pane-leaf";
    host.dataset.paneId = node.id;
    host.style.width = "100%";
    host.style.height = "100%";
    host.style.overflow = "hidden";
    hosts.set(node.id, host);
    // TODO(集成 · term/): opts.renderLeaf 里把 new Terminal().open(host) 接进来,
    // 并保存 fitAddon 以便 resize 后重新 fit。
    if (typeof opts.renderLeaf === "function") opts.renderLeaf(node, host);
    return host;
  }

  // split 节点:用 flex 容器 + 两个子 + 中间分隔条
  const box = document.createElement("div");
  box.className = "pane-split";
  box.style.display = "flex";
  box.style.flexDirection = node.dir === "row" ? "row" : "column";
  box.style.width = "100%";
  box.style.height = "100%";

  const firstWrap = wrapChild(node.first, node.ratio, node.dir, hosts, opts);
  const secondWrap = wrapChild(
    node.second,
    1 - node.ratio,
    node.dir,
    hosts,
    opts,
  );
  const divider = buildDivider(node, box, firstWrap, secondWrap, opts);

  box.appendChild(firstWrap);
  box.appendChild(divider);
  box.appendChild(secondWrap);
  return box;
}

/** 用一个 flex 子容器包住子节点,按比例分配主轴尺寸。 */
function wrapChild(child, flexRatio, dir, hosts, opts) {
  const wrap = document.createElement("div");
  wrap.style.flex = `${flexRatio} ${flexRatio} 0`;
  wrap.style.position = "relative";
  wrap.style.overflow = "hidden";
  wrap.style.minWidth = dir === "row" ? "0" : "";
  wrap.style.minHeight = dir === "column" ? "0" : "";
  wrap.appendChild(buildNode(child, hosts, opts));
  return wrap;
}

/** 构造可拖拽分隔条,拖动时改 flex 比例并回调 onRatioChange。 */
function buildDivider(node, box, firstWrap, secondWrap, opts) {
  const divider = document.createElement("div");
  divider.className = "pane-divider";
  const horizontal = node.dir === "row";
  divider.style.flex = `0 0 ${DIVIDER_PX}px`;
  divider.style.cursor = horizontal ? "col-resize" : "row-resize";
  divider.style.background = "#333";
  divider.style.userSelect = "none";
  divider.style.zIndex = "5";

  let dragging = false;

  const onMove = (ev) => {
    if (!dragging) return;
    const rect = box.getBoundingClientRect();
    const total = horizontal ? rect.width : rect.height;
    if (total <= 0) return;
    const pos = horizontal ? ev.clientX - rect.left : ev.clientY - rect.top;
    const ratio = clampRatio(pos / total);
    node.ratio = ratio;
    firstWrap.style.flex = `${ratio} ${ratio} 0`;
    secondWrap.style.flex = `${1 - ratio} ${1 - ratio} 0`;
    if (typeof opts.onRatioChange === "function") {
      opts.onRatioChange(node, ratio);
    }
    ev.preventDefault();
  };
  const onUp = () => {
    dragging = false;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  divider.addEventListener("mousedown", (ev) => {
    dragging = true;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    ev.preventDefault();
  });

  return divider;
}

// ---------------------------------------------------------------------------
// 断言式自测 —— 运行 selfTest() 可在无浏览器环境下验证纯逻辑(不含 DOM 部分)
// ---------------------------------------------------------------------------

function assert(cond, msg) {
  if (!cond) throw new Error(`[pane.selfTest] 断言失败: ${msg}`);
}

/**
 * 纯逻辑自测(不触碰 DOM)。通过则返回 true 并打印计数,失败抛错。
 * 用法:import { selfTest } from "./pane.js"; selfTest();
 * 或 node 环境下:node -e "import('./src/pane.js').then(m=>m.selfTest())"
 */
export function selfTest() {
  let n = 0;
  const check = (cond, msg) => {
    n += 1;
    assert(cond, msg);
  };

  // 1) 构造 + split
  let root = makeLeaf("a");
  check(isLeaf(root) && root.id === "a", "初始为叶子 a");
  root = split(root, "a", "row", makeLeaf("b")); // a | b
  check(isSplit(root) && root.dir === "row", "split 后根为 row 分裂");
  check(root.first.id === "a" && root.second.id === "b", "a 在左,b 在右");
  check(leaves(root).length === 2, "两个叶子");

  // 2) 再拆:b 下方开 c  =>  a | (b / c)
  root = split(root, "b", "column", makeLeaf("c"));
  check(leaves(root).length === 3, "三个叶子");
  const bLoc = findParent(root, findLeaf(root, "b"));
  check(bLoc.parent.dir === "column", "b 的父为 column 分裂");

  // 3) 几何:a 占左半;b、c 各占右半的上下
  let rects = computeRects(root);
  check(Math.abs(rects.get("a").w - 0.5) < 1e-9, "a 宽度 0.5");
  check(rects.get("b").y < rects.get("c").y, "b 在 c 上方");

  // 4) navigate
  check(navigate(root, "a", "right") === "b", "a 向右到 b(几何最近)");
  check(navigate(root, "b", "left") === "a", "b 向左到 a");
  check(navigate(root, "b", "down") === "c", "b 向下到 c");
  check(navigate(root, "c", "up") === "b", "c 向上到 b");
  check(navigate(root, "a", "left") === null, "a 向左到边界(null)");

  // 5) swap:交换 a 与 c
  root = swap(root, "a", "c");
  rects = computeRects(root);
  // c 现在应在最左半
  check(Math.abs(rects.get("c").w - 0.5) < 1e-9, "swap 后 c 占左半");
  // c 右侧的 b、a 在垂直重叠与间距上完全对称,右邻取先遇到者即可(两者皆合法)
  check(["a", "b"].includes(navigate(root, "c", "right")), "swap 后 c 右邻为右半窗格之一");

  // 6) detach:摘掉 a,兄弟 b 顶替 => c | b
  const d = detach(root, "a");
  root = d.root;
  check(d.node.id === "a", "摘下的是 a");
  check(leaves(root).length === 2, "detach 后两个叶子");
  check(findLeaf(root, "a") === null, "a 已不在树中");

  // 7) attach:把 a 挂回 b 下方 => c | (b / a)
  root = attach(root, "b", d.node, "column");
  check(leaves(root).length === 3, "attach 后三个叶子");
  check(navigate(root, "b", "down") === "a", "a 挂到 b 下方");

  // 8) move:把 a 移到 c 右侧
  root = move(root, "a", "c", "row", { place: "after" });
  check(findLeaf(root, "a") !== null, "move 后 a 仍在");
  check(leaves(root).length === 3, "move 不增减叶子");

  // 9) resize:调整某叶子最近的 row 祖先分裂比例
  const rzLeaf = leaves(root)[0].id;
  const rzAncestor = findParent(root, findLeaf(root, rzLeaf)).parent;
  const ratioBefore = rzAncestor.dir === "row" ? rzAncestor.ratio : null;
  root = resize(root, rzLeaf, "row", 0.1);
  if (ratioBefore !== null) {
    check(rzAncestor.ratio !== ratioBefore, "resize 改变了最近 row 祖先的比例");
  }

  // 10) walk 计数:节点总数 = 叶子数*2 - 1(满二叉)
  let total = 0;
  walk(root, () => (total += 1));
  check(total === leaves(root).length * 2 - 1, "满二叉节点数自洽");

  // eslint-disable-next-line no-console
  console.log(`[pane.selfTest] 通过 ${n} 项断言,当前叶子 ${leaves(root).length} 个。`);
  return true;
}

// 便捷默认导出:集成层可 `import PaneCore from "./pane.js"`
export default {
  nextPaneId,
  makeLeaf,
  makeSplit,
  isLeaf,
  isSplit,
  walk,
  leaves,
  findLeaf,
  findParent,
  split,
  replaceNode,
  swap,
  detach,
  attach,
  move,
  computeRects,
  navigate,
  resize,
  layout,
  selfTest,
};
