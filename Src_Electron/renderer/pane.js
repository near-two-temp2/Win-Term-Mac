// PaneCore:窗格二叉树(叶子/分裂)+ 核心操作 + DOM 布局(flex + 拖拽分隔条)。
//
// 设计对照 Windows Terminal:
//   - 节点 = 叶子(一个真终端)或 分裂节点(orientation + ratio + first/second)。
//   - orientation: 'row'  → 子节点左右并排(竖直分隔条),对应 WT 的"右侧拆分"。
//                  'column'→ 子节点上下堆叠(水平分隔条),对应 WT 的"下方拆分"。
//   - ratio: 0~1,first 子节点占据的比例。
//   - 核心操作:split / swap / detach / attach / move / navigate / walk / maximize / restore。
//
// 本模块与 xterm/PTY 解耦:叶子只持有一个 DOM 宿主元素(el)和任意业务数据(data)。
// 谁来往 el 里塞终端,由调用方通过 onLeafMount 回调决定(见 index.js 的集成 TODO)。
//
// 同一份代码既可在浏览器(挂到 window.PaneCore)运行,也可在 Node 下跑自测。

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // Node / 自测
  }
  if (typeof window !== 'undefined') {
    window.PaneCore = api; // 浏览器渲染进程
  }
})(this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 常量
  // ---------------------------------------------------------------------------
  const ORIENTATION = { ROW: 'row', COLUMN: 'column' };
  const SIDE = { FIRST: 'first', SECOND: 'second' };
  const MIN_RATIO = 0.05; // 分隔条拖拽时子节点最小比例,避免窗格被压没
  const DIVIDER_PX = 6; // 分隔条厚度(像素)

  let _idSeq = 1;
  function nextId(prefix) {
    return `${prefix}-${_idSeq++}`;
  }

  // ---------------------------------------------------------------------------
  // 节点构造
  // ---------------------------------------------------------------------------

  // 创建一个叶子节点。el 可为空(自测时不需要 DOM)。
  function makeLeaf(opts) {
    opts = opts || {};
    return {
      type: 'leaf',
      id: opts.id || nextId('leaf'),
      el: opts.el || null, // DOM 宿主(.pane-leaf)
      data: opts.data || null, // 调用方业务数据(如 xterm 实例、PTY 会话 id)
      parent: null,
    };
  }

  // 创建一个分裂节点。first/second 为两棵子树。
  function makeSplit(orientation, first, second, ratio) {
    const node = {
      type: 'split',
      id: nextId('split'),
      orientation: orientation === ORIENTATION.COLUMN ? ORIENTATION.COLUMN : ORIENTATION.ROW,
      ratio: clampRatio(typeof ratio === 'number' ? ratio : 0.5),
      first: first,
      second: second,
      el: null, // .pane-split 容器
      dividerEl: null, // 分隔条
      parent: null,
    };
    if (first) first.parent = node;
    if (second) second.parent = node;
    return node;
  }

  function clampRatio(r) {
    if (r < MIN_RATIO) return MIN_RATIO;
    if (r > 1 - MIN_RATIO) return 1 - MIN_RATIO;
    return r;
  }

  function isLeaf(n) {
    return n && n.type === 'leaf';
  }
  function isSplit(n) {
    return n && n.type === 'split';
  }

  // ---------------------------------------------------------------------------
  // 遍历 / 查找
  // ---------------------------------------------------------------------------

  // 深度优先遍历。visitor(node, depth) 返回 false 可中止对该子树的下探。
  function walk(node, visitor, depth) {
    depth = depth || 0;
    if (!node) return;
    const cont = visitor(node, depth);
    if (cont === false) return;
    if (isSplit(node)) {
      walk(node.first, visitor, depth + 1);
      walk(node.second, visitor, depth + 1);
    }
  }

  // 收集所有叶子(按从左到右、从上到下的树序)。
  function leaves(root) {
    const out = [];
    walk(root, (n) => {
      if (isLeaf(n)) out.push(n);
    });
    return out;
  }

  function findLeafById(root, id) {
    let found = null;
    walk(root, (n) => {
      if (isLeaf(n) && n.id === id) {
        found = n;
        return false;
      }
    });
    return found;
  }

  // 定位某节点在其父节点中的位置('first' / 'second' / null=根)。
  function sideOf(node) {
    const p = node && node.parent;
    if (!p) return null;
    return p.first === node ? SIDE.FIRST : SIDE.SECOND;
  }

  // ---------------------------------------------------------------------------
  // split:把一个叶子替换成分裂节点(原叶子 + 新叶子)
  // ---------------------------------------------------------------------------
  // 返回新的根(根可能因替换而改变)。
  //   target      要拆分的叶子
  //   orientation 'row' | 'column'
  //   newSide     新叶子放在 'first' 还是 'second'(默认 'second',贴合 WT 右/下拆分)
  //   ratio       新分裂节点的 first 比例(默认 0.5)
  function split(root, target, orientation, newLeaf, newSide, ratio) {
    if (!isLeaf(target)) throw new Error('split: target 必须是叶子');
    if (!isLeaf(newLeaf)) throw new Error('split: newLeaf 必须是叶子');
    newSide = newSide === SIDE.FIRST ? SIDE.FIRST : SIDE.SECOND;

    const parent = target.parent;
    let first, second;
    if (newSide === SIDE.FIRST) {
      first = newLeaf;
      second = target;
    } else {
      first = target;
      second = newLeaf;
    }
    const splitNode = makeSplit(orientation, first, second, ratio);

    if (!parent) {
      // target 原本是根
      splitNode.parent = null;
      return splitNode;
    }
    // 把 splitNode 挂到 target 原来的位置
    replaceChild(parent, target, splitNode);
    return root; // 根不变
  }

  // 注意:只改写指针,不清空 oldChild.parent。因为在 split/attach 中,oldChild(即
  // 被拆分的目标叶子)此时已成为 newChild 的子节点,其 parent 已由 makeSplit 正确指向
  // newChild——若在此清空会破坏刚建立的关系。oldChild 的 parent 由各调用方按需维护。
  function replaceChild(parent, oldChild, newChild) {
    if (parent.first === oldChild) parent.first = newChild;
    else if (parent.second === oldChild) parent.second = newChild;
    else throw new Error('replaceChild: oldChild 不是 parent 的子节点');
    newChild.parent = parent;
  }

  // ---------------------------------------------------------------------------
  // swap:交换两个节点在树中的位置(WT 的 swapPane)
  // ---------------------------------------------------------------------------
  // 支持交换任意两个节点(通常是叶子)。不允许一个是另一个的祖先。
  function swap(root, a, b) {
    if (!a || !b || a === b) return root;
    if (isAncestor(a, b) || isAncestor(b, a)) {
      throw new Error('swap: 不能交换存在祖先关系的两个节点');
    }
    const pa = a.parent;
    const pb = b.parent;
    const sa = sideOf(a);
    const sb = sideOf(b);

    // 先摘下,避免同父交换时相互覆盖
    if (pa) pa[sa] = null;
    if (pb) pb[sb] = null;

    if (pa) {
      pa[sa] = b;
      b.parent = pa;
    } else {
      b.parent = null;
    }
    if (pb) {
      pb[sb] = a;
      a.parent = pb;
    } else {
      a.parent = null;
    }

    // 若任一方原本是根,则新根是换上去的节点
    if (!pa) return b;
    if (!pb) return a;
    return root;
  }

  function isAncestor(maybeAncestor, node) {
    let cur = node && node.parent;
    while (cur) {
      if (cur === maybeAncestor) return true;
      cur = cur.parent;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // detach:摘下一个叶子;其兄弟节点顶替父分裂节点的位置(树塌陷)
  // ---------------------------------------------------------------------------
  // 返回 { root, detached }。detached.parent 会被清空,可再 attach。
  function detach(root, target) {
    const parent = target.parent;
    if (!parent) {
      // 摘掉根:树变空
      target.parent = null;
      return { root: null, detached: target };
    }
    const sibling = parent.first === target ? parent.second : parent.first;
    target.parent = null;

    const grand = parent.parent;
    sibling.parent = grand;
    if (!grand) {
      // 父分裂原本是根 → 兄弟成为新根
      return { root: sibling, detached: target };
    }
    replaceChild(grand, parent, sibling);
    return { root: root, detached: target };
  }

  // ---------------------------------------------------------------------------
  // attach:把一个游离节点挂到某个目标叶子处(等价于以该节点做 split)
  // ---------------------------------------------------------------------------
  function attach(root, target, orientation, node, newSide, ratio) {
    if (!isLeaf(target)) throw new Error('attach: target 必须是叶子');
    newSide = newSide === SIDE.FIRST ? SIDE.FIRST : SIDE.SECOND;

    const parent = target.parent;
    let first, second;
    if (newSide === SIDE.FIRST) {
      first = node;
      second = target;
    } else {
      first = target;
      second = node;
    }
    const splitNode = makeSplit(orientation, first, second, ratio);
    if (!parent) return splitNode; // target 是根
    replaceChild(parent, target, splitNode);
    return root;
  }

  // ---------------------------------------------------------------------------
  // move:把 source 叶子移动到 target 叶子旁边(detach + attach)
  // ---------------------------------------------------------------------------
  // 这是拖拽移动窗格的基础。source 与 target 不能相同。
  function move(root, source, target, orientation, newSide, ratio) {
    if (source === target) return root;
    if (isAncestor(source, target)) {
      throw new Error('move: source 是 target 的祖先,无法移动');
    }
    const res = detach(root, source);
    let newRoot = res.root;
    // detach 可能改变了 target 所在的根,但 target 节点引用仍有效
    newRoot = attach(newRoot, target, orientation, source, newSide, ratio);
    return newRoot;
  }

  // ---------------------------------------------------------------------------
  // computeRects:纯函数,根据树与视口尺寸算出每个叶子的矩形
  // ---------------------------------------------------------------------------
  // 供 navigate 使用(不依赖 DOM,方便自测)。返回 Map<leaf, {x,y,w,h}>。
  function computeRects(node, x, y, w, h, out) {
    out = out || new Map();
    if (!node) return out;
    if (isLeaf(node)) {
      out.set(node, { x: x, y: y, w: w, h: h });
      return out;
    }
    if (node.orientation === ORIENTATION.ROW) {
      const fw = w * node.ratio;
      computeRects(node.first, x, y, fw, h, out);
      computeRects(node.second, x + fw, y, w - fw, h, out);
    } else {
      const fh = h * node.ratio;
      computeRects(node.first, x, y, w, fh, out);
      computeRects(node.second, x, y + fh, w, h - fh, out);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // navigate:从某叶子按方向('left'/'right'/'up'/'down')找几何相邻的叶子
  // ---------------------------------------------------------------------------
  // viewport 默认 1000x1000(navigate 只看相对关系,绝对尺寸无关紧要)。
  function navigate(root, from, direction, viewport) {
    viewport = viewport || { width: 1000, height: 1000 };
    const rects = computeRects(root, 0, 0, viewport.width, viewport.height);
    const src = rects.get(from);
    if (!src) return null;

    const srcCx = src.x + src.w / 2;
    const srcCy = src.y + src.h / 2;

    let best = null;
    let bestPrimary = Infinity;
    let bestOverlap = -Infinity;

    rects.forEach((r, leaf) => {
      if (leaf === from) return;
      let primary; // 沿导航轴的间距(越小越近)
      let overlap; // 垂直于导航轴的重叠量(越大越对齐)
      switch (direction) {
        case 'left':
          if (r.x + r.w > src.x + 1e-6) return; // 必须在左侧
          primary = src.x - (r.x + r.w);
          overlap = rangeOverlap(src.y, src.h, r.y, r.h);
          break;
        case 'right':
          if (r.x < src.x + src.w - 1e-6) return;
          primary = r.x - (src.x + src.w);
          overlap = rangeOverlap(src.y, src.h, r.y, r.h);
          break;
        case 'up':
          if (r.y + r.h > src.y + 1e-6) return;
          primary = src.y - (r.y + r.h);
          overlap = rangeOverlap(src.x, src.w, r.x, r.w);
          break;
        case 'down':
          if (r.y < src.y + src.h - 1e-6) return;
          primary = r.y - (src.y + src.h);
          overlap = rangeOverlap(src.x, src.w, r.x, r.w);
          break;
        default:
          return;
      }
      if (overlap <= 0) return; // 要求垂直方向有交叠,才算真正相邻
      // 优先选间距最近的;间距相近时选重叠最多的
      if (
        primary < bestPrimary - 1e-6 ||
        (Math.abs(primary - bestPrimary) <= 1e-6 && overlap > bestOverlap)
      ) {
        best = leaf;
        bestPrimary = primary;
        bestOverlap = overlap;
      }
    });

    // 消除未使用变量告警
    void srcCx;
    void srcCy;
    return best;
  }

  // 一维区间 [a, a+al] 与 [b, b+bl] 的重叠长度
  function rangeOverlap(a, al, b, bl) {
    return Math.min(a + al, b + bl) - Math.max(a, b);
  }

  // ---------------------------------------------------------------------------
  // maximize / restore:把某叶子标记为最大化(渲染层据此只显示它)
  // ---------------------------------------------------------------------------
  // 这里只维护状态,真正的"铺满"由 layout 渲染时读取 state.maximized 处理。
  function maximize(state, leaf) {
    state.maximized = leaf;
  }
  function restore(state) {
    state.maximized = null;
  }

  // ===========================================================================
  // DOM 布局:把树渲染成嵌套 flex 容器 + 可拖拽分隔条
  // ===========================================================================
  // 该部分依赖 document,仅在浏览器可用。渲染是"重建式"的:每次 layout 会重挂
  // 已有叶子的 el(不销毁 el 内部的终端),因此 el 应由调用方长期持有。
  //
  // hooks:
  //   onLeafMount(leaf)  首次为叶子创建 el 时回调(调用方在此 new Terminal 等)
  //   onResize()         布局尺寸变化后回调(调用方据此 fit 终端 / resize PTY)

  function createLayout(container, hooks) {
    hooks = hooks || {};
    const state = {
      root: null,
      container: container,
      hooks: hooks,
      maximized: null,
      focus: null,
    };

    state.setRoot = function (root) {
      state.root = root;
      render(state);
      return state;
    };
    state.render = function () {
      render(state);
    };
    state.getState = function () {
      return state;
    };
    return state;
  }

  function ensureLeafEl(state, leaf) {
    if (leaf.el) return leaf.el;
    const el = document.createElement('div');
    el.className = 'pane-leaf';
    el.dataset.paneId = leaf.id;
    el.style.position = 'relative';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.overflow = 'hidden';
    leaf.el = el;
    // 关键:此处不能立即回调 onLeafMount。buildNode 尚未把 el 挂进 container,
    // 此刻 el 仍是游离(detached)、0 尺寸的。若在此创建 xterm 并启用 WebGL,会在一个
    // 未连接文档、尺寸为 0 的 canvas 上初始化 GL 上下文——在无独显、走 SwiftShader 软件
    // 渲染的环境(如 Windows Server)会直接拖垮渲染/GPU 进程,表现为空白窗口、进程数骤降。
    // 因此改为登记到"待挂载队列",由 render() 在 append(元素已连接文档并具尺寸)之后统一回调。
    if (typeof state.hooks.onLeafMount === 'function') {
      if (!state._pendingMounts) state._pendingMounts = [];
      state._pendingMounts.push(leaf);
    }
    return el;
  }

  // 冲刷待挂载队列:此时叶子 el 均已随整棵子树 append 进 container(已连接文档、有尺寸),
  // 可安全创建终端并启用 WebGL。须在 notifyResize 之前调用,确保 fit 时终端已存在。
  function flushMounts(state) {
    const pending = state._pendingMounts;
    state._pendingMounts = null;
    if (!pending || typeof state.hooks.onLeafMount !== 'function') return;
    for (let i = 0; i < pending.length; i++) {
      state.hooks.onLeafMount(pending[i]);
    }
  }

  function render(state) {
    const container = state.container;
    if (!container) return;
    // 清空但不销毁叶子 el(叶子 el 会在 buildNode 中被重新 append)
    while (container.firstChild) container.removeChild(container.firstChild);

    if (!state.root) return;

    // 本次 render 新建叶子的挂载回调会先入队,待 append 后再统一冲刷(见 ensureLeafEl)。
    state._pendingMounts = [];

    // 最大化:只渲染被最大化的叶子,铺满容器
    if (state.maximized && isLeaf(state.maximized)) {
      const el = ensureLeafEl(state, state.maximized);
      el.style.width = '100%';
      el.style.height = '100%';
      container.appendChild(el);
      flushMounts(state);
      notifyResize(state);
      return;
    }

    const dom = buildNode(state, state.root);
    dom.style.width = '100%';
    dom.style.height = '100%';
    container.appendChild(dom);
    flushMounts(state);
    notifyResize(state);
  }

  function buildNode(state, node) {
    if (isLeaf(node)) {
      const el = ensureLeafEl(state, node);
      el.style.flex = '1 1 auto';
      // 焦点高亮
      el.classList.toggle('pane-focused', node === state.focus);
      return el;
    }
    // 分裂容器
    const box = document.createElement('div');
    box.className = 'pane-split';
    box.dataset.paneId = node.id;
    box.style.display = 'flex';
    box.style.flexDirection = node.orientation; // 'row' | 'column'
    box.style.width = '100%';
    box.style.height = '100%';
    node.el = box;

    const firstDom = buildNode(state, node.first);
    const secondDom = buildNode(state, node.second);

    const pct = (node.ratio * 100).toFixed(4);
    const restPct = ((1 - node.ratio) * 100).toFixed(4);
    // 用 flex-basis 表达比例;分隔条占固定像素
    firstDom.style.flex = `0 0 calc(${pct}% - ${DIVIDER_PX / 2}px)`;
    secondDom.style.flex = `0 0 calc(${restPct}% - ${DIVIDER_PX / 2}px)`;
    firstDom.style.overflow = 'hidden';
    secondDom.style.overflow = 'hidden';

    const divider = buildDivider(state, node);

    box.appendChild(firstDom);
    box.appendChild(divider);
    box.appendChild(secondDom);
    return box;
  }

  function buildDivider(state, node) {
    const divider = document.createElement('div');
    divider.className = 'pane-divider';
    const isRow = node.orientation === ORIENTATION.ROW;
    divider.style.flex = `0 0 ${DIVIDER_PX}px`;
    divider.style.background = 'rgba(255,255,255,0.08)';
    divider.style.cursor = isRow ? 'col-resize' : 'row-resize';
    divider.style.userSelect = 'none';
    divider.style.zIndex = '5';
    node.dividerEl = divider;

    divider.addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      const box = node.el;
      const rect = box.getBoundingClientRect();
      const total = isRow ? rect.width : rect.height;
      const origin = isRow ? rect.left : rect.top;

      function onMove(e) {
        const pos = isRow ? e.clientX : e.clientY;
        let ratio = (pos - origin) / total;
        node.ratio = clampRatio(ratio);
        applyRatio(node);
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        notifyResize(state); // 拖拽结束后统一 fit 一次,避免高频抖动
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    return divider;
  }

  // 拖拽过程中只更新 flex-basis,不重建 DOM(性能)
  function applyRatio(node) {
    if (!node.el) return;
    const first = node.el.children[0];
    const second = node.el.children[2];
    if (!first || !second) return;
    const pct = (node.ratio * 100).toFixed(4);
    const restPct = ((1 - node.ratio) * 100).toFixed(4);
    first.style.flex = `0 0 calc(${pct}% - ${DIVIDER_PX / 2}px)`;
    second.style.flex = `0 0 calc(${restPct}% - ${DIVIDER_PX / 2}px)`;
  }

  function notifyResize(state) {
    if (typeof state.hooks.onResize === 'function') {
      // 交给下一帧,确保浏览器已完成 flex 布局
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => state.hooks.onResize(state));
      } else {
        state.hooks.onResize(state);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 导出
  // ---------------------------------------------------------------------------
  const PaneCore = {
    ORIENTATION,
    SIDE,
    // 构造
    makeLeaf,
    makeSplit,
    // 查询
    isLeaf,
    isSplit,
    walk,
    leaves,
    findLeafById,
    sideOf,
    isAncestor,
    // 核心操作
    split,
    swap,
    detach,
    attach,
    move,
    navigate,
    maximize,
    restore,
    computeRects,
    // 布局
    createLayout,
    _internal: { clampRatio, rangeOverlap, replaceChild },
  };

  // ---------------------------------------------------------------------------
  // 自测:node renderer/pane.js 直接运行
  // ---------------------------------------------------------------------------
  function selfTest() {
    let passed = 0;
    let failed = 0;
    function assert(cond, msg) {
      if (cond) {
        passed++;
      } else {
        failed++;
        console.error('  FAIL:', msg);
      }
    }

    // 构造:单叶子作根
    let a = makeLeaf({ id: 'A' });
    let rootTree = a;
    assert(leaves(rootTree).length === 1, '初始单叶子');

    // split:A 向右拆出 B(A|B)
    let b = makeLeaf({ id: 'B' });
    rootTree = split(rootTree, a, ORIENTATION.ROW, b, SIDE.SECOND);
    assert(isSplit(rootTree), 'split 后根为分裂节点');
    assert(rootTree.first === a && rootTree.second === b, 'A 在左 B 在右');
    assert(a.parent === rootTree && b.parent === rootTree, 'parent 指针正确');

    // split:B 向下拆出 C(B 上 / C 下)
    let c = makeLeaf({ id: 'C' });
    rootTree = split(rootTree, b, ORIENTATION.COLUMN, c, SIDE.SECOND);
    assert(leaves(rootTree).length === 3, '现在三个叶子');
    // 布局:A 占左半;右半上 B 下 C
    let rects = computeRects(rootTree, 0, 0, 100, 100);
    assert(rects.get(a).w === 50, 'A 宽度 50');
    assert(rects.get(b).y === 0 && rects.get(c).y === 50, 'B 上 C 下');

    // navigate:从 A 向右应到 B(A 与 B 上半重叠)
    assert(navigate(rootTree, a, 'right') === b, 'A→right→B');
    // 从 B 向左应回 A
    assert(navigate(rootTree, b, 'left') === a, 'B→left→A');
    // 从 B 向下到 C
    assert(navigate(rootTree, b, 'down') === c, 'B→down→C');
    // 从 A 向左无邻居
    assert(navigate(rootTree, a, 'left') === null, 'A→left→null');

    // swap:交换 A 与 C
    rootTree = swap(rootTree, a, c);
    assert(rootTree.first === c, 'swap 后 C 在左');
    rects = computeRects(rootTree, 0, 0, 100, 100);
    assert(rects.get(c).w === 50 && rects.get(c).x === 0, 'C 占左半');
    assert(rects.get(a).x === 50 && rects.get(a).y === 50, 'A 到右下');

    // detach:摘下 B,兄弟 A 顶替
    let det = detach(rootTree, b);
    rootTree = det.root;
    assert(det.detached === b && b.parent === null, 'B 已摘下');
    assert(leaves(rootTree).length === 2, '摘下后剩两叶子(C, A)');
    // 现在结构:root(row) = [C, A]
    assert(rootTree.first === c && rootTree.second === a, '塌陷后 C|A');

    // attach / move:把 B 移回到 A 右侧
    rootTree = attach(rootTree, a, ORIENTATION.ROW, b, SIDE.SECOND);
    assert(leaves(rootTree).length === 3, 'attach 后三叶子');
    assert(a.parent.second === b, 'B 挂在 A 右');

    // move:把 C 移到 B 下方
    rootTree = move(rootTree, c, b, ORIENTATION.COLUMN, SIDE.SECOND);
    assert(leaves(rootTree).length === 3, 'move 后仍三叶子');
    assert(b.parent.second === c || b.parent.first === c, 'C 与 B 同父');

    // walk 计数
    let count = 0;
    walk(rootTree, () => {
      count++;
    });
    assert(count === leaves(rootTree).length + countSplits(rootTree), 'walk 覆盖全部节点');

    // maximize / restore 状态
    let st = { maximized: null };
    maximize(st, a);
    assert(st.maximized === a, 'maximize 记录');
    restore(st);
    assert(st.maximized === null, 'restore 清空');

    // ratio 边界
    assert(clampRatio(0) === MIN_RATIO, 'ratio 下界');
    assert(clampRatio(1) === 1 - MIN_RATIO, 'ratio 上界');

    console.log(`PaneCore self-test: ${passed} passed, ${failed} failed`);
    return failed === 0;
  }

  function countSplits(root) {
    let n = 0;
    walk(root, (x) => {
      if (isSplit(x)) n++;
    });
    return n;
  }

  PaneCore._selfTest = selfTest;

  // 在 Node 下直接执行本文件时跑自测
  if (typeof module !== 'undefined' && module.exports && typeof require !== 'undefined') {
    if (require.main === module) {
      const ok = selfTest();
      if (typeof process !== 'undefined') process.exit(ok ? 0 : 1);
    }
  }

  return PaneCore;
});
