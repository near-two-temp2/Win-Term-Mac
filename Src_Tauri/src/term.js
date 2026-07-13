// Win-Term-Mac · Tauri 方案 · 角色 term(终端视图 / 渲染)
//
// 职责:把 xterm.js 终端组件接到窗格叶子上,真正显示子进程输出、接收键入、跟随尺寸。
//   - 每个窗格叶子(pane.js 的 leaf)对应一个 xterm 实例 + 一个后端 PTY(pty.rs)。
//   - 复用 ipc.js 完成 PTY 起停/读写/尺寸(不自己造一套 IPC)。
//   - 作为 pane.js layout() 的 renderLeaf 回调接入窗格二叉树;分裂/交换/移动后
//     叶子只是换了承载的 DOM host,本模块把「持久包裹层」搬过去,保证 xterm 实例与
//     PTY 绑定、滚动缓冲、光标状态全程不丢(不重开终端、不重起 shell)。
//
// ── integrator 需要如何调用我(接线说明)────────────────────────────────
// 入口文件(main.js)不要改我这里的实现,按下面接线即可:
//
//   import { createTermManager } from "./term.js";
//   import PaneCore from "./pane.js";
//
//   const tm = createTermManager({ shell: null, fontSize: 14 });
//   let root = PaneCore.makeLeaf();                 // 初始单窗格
//   const container = document.getElementById("root");
//
//   function render() {
//     const hosts = PaneCore.layout(root, container, {
//       renderLeaf: tm.renderLeaf,                  // ← 把叶子渲染成真终端
//       onRatioChange: () => tm.fitAll(),           // 拖动分隔条后重新适配
//     });
//     // 清理已从树上消失的叶子对应的终端 + PTY:
//     tm.reconcile(PaneCore.leaves(root).map((l) => l.id));
//   }
//   render();
//
//   // 命令面板 / 键位 controller 里:
//   //   split : root = PaneCore.split(root, tm.getFocusedPaneId(), dir, PaneCore.makeLeaf()); render();
//   //   close : { const id = tm.getFocusedPaneId(); ... 改 root ...; render(); }  // reconcile 会 killPty
//   //   swap/move/resize/navigate 同理:改 root → render();切焦点用 tm.focusPane(id)。
//
// 说明:renderLeaf 只负责「有则搬、无则建」;真正的 kill(销毁 PTY)由 reconcile 按
//       当前树里还存在的叶子 id 做差集完成,避免叶子被 detach 后 PTY 泄漏。
// ------------------------------------------------------------------------

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

import { spawnPty, resizePty, killPty } from "./ipc.js";

// 默认主题 / 字体(集成层可通过 createTermManager 覆盖)。
const DEFAULT_FONT_FAMILY =
  'Menlo, Consolas, "DejaVu Sans Mono", "Cascadia Mono", monospace';
const DEFAULT_FONT_SIZE = 14;
const DEFAULT_THEME = Object.freeze({
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
});

// resize → pty_resize 的防抖(拖分隔条时避免刷屏)。单位 ms。
const RESIZE_DEBOUNCE_MS = 60;

/**
 * 创建一个终端管理器。返回一组绑定好的方法,paneId ↔ 终端视图的注册表被闭包持有。
 *
 * @param cfg.shell      默认 shell(传给 PTY;null → 后端按平台选默认)
 * @param cfg.fontFamily 字体
 * @param cfg.fontSize   字号
 * @param cfg.theme      xterm 主题对象
 * @param cfg.onExit     (paneId, ptyId) => void  某窗格的 shell 退出时回调(可选)
 * @param cfg.onFocus    (paneId) => void         某终端获得焦点时回调(可选,便于同步「焦点窗格」)
 * @param cfg.onSpawn    (paneId, ptyId) => void  PTY 起好后回调(可选)
 */
export function createTermManager(cfg = {}) {
  const shell = cfg.shell ?? null;
  const fontFamily = cfg.fontFamily ?? DEFAULT_FONT_FAMILY;
  const fontSize = cfg.fontSize ?? DEFAULT_FONT_SIZE;
  const theme = cfg.theme ?? DEFAULT_THEME;

  // paneId -> TermView。TermView 见下方 createView。
  const registry = new Map();
  // 最近获得焦点的 paneId(供 split/close 等「作用于当前窗格」的操作使用)。
  let focusedPaneId = null;

  // ── 单个终端视图 ──────────────────────────────────────────────────────
  // wrapper 是「持久包裹层」:xterm 的 DOM 建在它内部;re-layout 时把它 appendChild
  // 到新 host(appendChild 会移动节点),从而保住终端实例与 PTY 绑定不丢。
  function createView(leaf) {
    const paneId = leaf.id;

    const term = new Terminal({
      fontFamily,
      fontSize,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // 持久包裹层:占满 host,xterm 挂进它。
    const wrapper = document.createElement("div");
    wrapper.className = "term-wrapper";
    wrapper.dataset.paneId = paneId;
    wrapper.style.width = "100%";
    wrapper.style.height = "100%";
    wrapper.style.position = "relative";
    wrapper.style.overflow = "hidden";

    const view = {
      paneId,
      term,
      fitAddon,
      wrapper,
      ptyId: null,
      webgl: null,
      resizeObserver: null,
      resizeTimer: null,
      disposed: false,
      focusDisposable: null,
    };
    registry.set(paneId, view);

    // 先把 wrapper 放进一个临时脱离文档的位置也可以,但为拿到尺寸,open 时它需已在 DOM;
    // 因此真正的 open() 延迟到 renderLeaf 里 host 就位后进行。见 attachToHost。
    return view;
  }

  // 把 xterm 真正 open 到 wrapper(仅首次);随后起 PTY、装 addon、监听焦点与尺寸。
  function bootView(view) {
    const { term, fitAddon, wrapper, paneId } = view;

    term.open(wrapper);

    // WebGL 渲染 addon(提性能);部分 WebView(尤其 Linux WebKitGTK)不支持,回退默认渲染。
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        view.webgl = null;
      });
      term.loadAddon(webgl);
      view.webgl = webgl;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[term] pane ${paneId} WebGL 不可用,回退默认渲染:`, err);
    }

    // 焦点跟踪:xterm 的 textarea 获焦点时,记为当前焦点窗格。
    view.focusDisposable = term.onData(() => {
      // onData 触发说明该终端正在被键入,肯定是焦点所在。
      markFocused(paneId);
    });
    // 更精确:直接监听 textarea 的 focus 事件(点击/Tab 聚焦也算)。
    if (term.textarea) {
      term.textarea.addEventListener("focus", () => markFocused(paneId));
    }

    // 首次适配一次(此刻 wrapper 已在 DOM,应能拿到尺寸)。
    safeFit(view);

    // 起后端 PTY,并把输出/键入接到本 term(ipc.js 内部完成 onData→pty_write 与
    // pty://output→term.write 的双向接线)。
    spawnPty(term, {
      cols: term.cols,
      rows: term.rows,
      shell,
      onExit: (ptyId) => {
        if (view.disposed) return;
        // shell 退出:给出可见提示,并回调集成层(不自动清理树,交给集成层决定)。
        try {
          term.write(`\r\n\x1b[90m[进程已退出 · pty ${ptyId}]\x1b[0m\r\n`);
        } catch (_) {
          /* term 可能已 dispose */
        }
        if (typeof cfg.onExit === "function") cfg.onExit(paneId, ptyId);
      },
    })
      .then((ptyId) => {
        if (view.disposed) {
          // 视图在 PTY 起好前就被销毁了:立刻 kill,避免泄漏。
          killPty(ptyId);
          return;
        }
        view.ptyId = ptyId;
        // 回写到叶子上(view.leaf 在 renderLeaf 里存下),便于集成层 / 其它角色按 id 找到 PTY。
        if (view.leaf) view.leaf.termId = ptyId;
        if (typeof cfg.onSpawn === "function") cfg.onSpawn(paneId, ptyId);
        // PTY 起好后按当前尺寸同步一次,防止首帧 cols/rows 与后端默认值不一致。
        scheduleResizeSync(view);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[term] pane ${paneId} 起 PTY 失败:`, err);
        try {
          term.write(`\r\n\x1b[31m[无法启动终端: ${err}]\x1b[0m\r\n`);
        } catch (_) {
          /* ignore */
        }
      });

    // 尺寸自适应:观察 wrapper(它 100% 跟随 host,拖分隔条/窗口变化都会触发)。
    const ro = new ResizeObserver(() => scheduleResizeSync(view));
    ro.observe(wrapper);
    view.resizeObserver = ro;
  }

  // 防抖地 fit 并把新的 cols/rows 同步给后端 PTY。
  function scheduleResizeSync(view) {
    if (view.disposed) return;
    if (view.resizeTimer) clearTimeout(view.resizeTimer);
    view.resizeTimer = setTimeout(() => {
      view.resizeTimer = null;
      if (view.disposed) return;
      safeFit(view);
      if (view.ptyId != null) {
        resizePty(view.ptyId, view.term.cols, view.term.rows);
      }
    }, RESIZE_DEBOUNCE_MS);
  }

  // fit() 在容器尺寸为 0(隐藏/未布局)时会抛错,吞掉即可。
  function safeFit(view) {
    try {
      view.fitAddon.fit();
    } catch (_) {
      /* 尺寸未就绪,忽略本次 */
    }
  }

  function markFocused(paneId) {
    if (focusedPaneId === paneId) return;
    focusedPaneId = paneId;
    if (typeof cfg.onFocus === "function") cfg.onFocus(paneId);
  }

  // ── 对外:pane.js layout() 的 renderLeaf 回调 ──────────────────────────
  // 有则搬(把持久 wrapper 移进新 host),无则建(创建视图 + open + 起 PTY)。
  function renderLeaf(leaf, host) {
    let view = registry.get(leaf.id);
    if (!view) {
      view = createView(leaf);
      view.leaf = leaf; // 存引用,起好 PTY 后回写 leaf.termId
      host.appendChild(view.wrapper);
      // wrapper 已入 DOM,可以 open + 起 PTY。
      bootView(view);
    } else {
      view.leaf = leaf;
      // re-layout:把持久 wrapper 移动到新的 host(appendChild 会自动从旧父节点摘走)。
      if (view.wrapper.parentElement !== host) {
        host.appendChild(view.wrapper);
      }
      // 位置/尺寸可能变了,重新适配一次。
      scheduleResizeSync(view);
    }
    // 让叶子上同时挂着「终端句柄」,与 pane.js leaf.term 字段对齐。
    leaf.term = view.term;
  }

  // ── 对外:焦点 ────────────────────────────────────────────────────────
  function focusPane(paneId) {
    const view = registry.get(paneId);
    if (!view) return;
    view.term.focus();
    markFocused(paneId);
  }

  function getFocusedPaneId() {
    // 若记录的焦点窗格已不存在(被关闭),回落到任意一个存活窗格。
    if (focusedPaneId && registry.has(focusedPaneId)) return focusedPaneId;
    const first = registry.keys().next();
    return first.done ? null : first.value;
  }

  function getPtyId(paneId) {
    return registry.get(paneId)?.ptyId ?? null;
  }

  function getTerminal(paneId) {
    return registry.get(paneId)?.term ?? null;
  }

  // ── 对外:适配所有终端(拖分隔条 / 窗口 resize 后调用)──────────────────
  function fitAll() {
    for (const view of registry.values()) scheduleResizeSync(view);
  }

  // ── 对外:销毁单个窗格的终端 + PTY ────────────────────────────────────
  function disposePane(paneId) {
    const view = registry.get(paneId);
    if (!view) return;
    view.disposed = true;
    if (view.resizeTimer) clearTimeout(view.resizeTimer);
    if (view.resizeObserver) view.resizeObserver.disconnect();
    if (view.focusDisposable) {
      try {
        view.focusDisposable.dispose();
      } catch (_) {
        /* ignore */
      }
    }
    if (view.ptyId != null) killPty(view.ptyId); // 通知后端销毁 PTY 子进程
    try {
      view.term.dispose();
    } catch (_) {
      /* ignore */
    }
    if (view.wrapper.parentElement) view.wrapper.remove();
    registry.delete(paneId);
    if (focusedPaneId === paneId) focusedPaneId = null;
  }

  // ── 对外:对账 —— 传入当前树里「仍存在」的叶子 id 集合,销毁其余(已被移除的)窗格。
  // 集成层每次 render() 后调用一次,即可自动回收被 close/detach 掉的终端与 PTY。
  function reconcile(liveIds) {
    const live = new Set(liveIds);
    for (const paneId of Array.from(registry.keys())) {
      if (!live.has(paneId)) disposePane(paneId);
    }
  }

  // ── 对外:整体销毁(窗口关闭等)────────────────────────────────────────
  function disposeAll() {
    for (const paneId of Array.from(registry.keys())) disposePane(paneId);
    focusedPaneId = null;
  }

  return {
    renderLeaf,
    focusPane,
    getFocusedPaneId,
    getPtyId,
    getTerminal,
    fitAll,
    disposePane,
    reconcile,
    disposeAll,
  };
}

export default { createTermManager };
