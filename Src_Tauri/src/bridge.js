// Win-Term-Mac · Tauri 前端 · 角色 [io] · 终端-PTY 生命周期桥
//
// 定位:把「窗格叶子(pane.js 的 leaf + 它的 DOM 宿主)」与「一个真 PTY 会话」
//       绑成一个可管理的整体,专注 PTY 双向数据流:
//         · 键盘输入  → 写给 shell   (term.onData → invoke pty_write,由 ipc.js 接好)
//         · shell 输出 → 喂给终端    (listen pty://output → term.write,由 ipc.js 分发)
//         · 容器 resize → 通知 pty   (ResizeObserver → fitAddon.fit → invoke pty_resize)
//
// 复用而非重造:底层 invoke/emit 已由 src/ipc.js 实现,本模块只做「xterm 实例
//   生命周期 + fit/resize 编排 + 与窗格树 relayout 的协作」。不碰 ipc.js,不碰入口。
//
// 与 pane.js 的接口对齐:
//   pane.layout(root, container, { renderLeaf, onRatioChange }) 会为每个叶子建一个
//   宿主 div 并回调 renderLeaf(leaf, host)。本模块导出的 bridge.renderLeaf 正是它的实现;
//   对同一个 leaf.id 幂等:首次为其创建 Terminal+PTY,relayout(swap/move/split 后重绘)
//   时把已存在的 term 的 DOM 原地迁移到新宿主,PTY 会话不断、历史不丢。
//
// ─────────────────────────────────────────────────────────────────────────────
// integrator 需要如何调用我(接线指引,写在这里避免动 main.js):
//
//   import PaneCore from "./pane.js";
//   import { createBridge } from "./bridge.js";
//
//   const bridge = createBridge({
//     shell: null,                 // 可选:覆盖默认 shell
//     onExit: (paneId) => {        // 可选:某窗格 shell 退出时的收尾(通常 detach 该叶子并重绘)
//       // const d = PaneCore.detach(root, paneId); root = d.root; relayout();
//     },
//   });
//
//   function relayout() {
//     PaneCore.layout(root, container, {
//       renderLeaf: bridge.renderLeaf,               // ← 把叶子接上终端+PTY
//       onRatioChange: () => bridge.fitAll(),        // 拖分隔条后重新 fit 全部
//     });
//     bridge.fitAll();                                // 每次重绘后统一 fit + 通知 pty
//     bridge.pruneStale(PaneCore.leaves(root).map((l) => l.id)); // 清掉已不在树中的会话
//   }
//
//   // 焦点:切焦点命令命中后
//   bridge.focus(activeLeafId);
//   // 关闭窗格命令:先杀 PTY 再从树摘除
//   bridge.close(paneId);
//
// 说明:leaf 上会被写入 leaf.term(xterm 实例)与 leaf.termId(后端 PTY id),
//       与 ipc.js 注释里的约定一致,便于 palette/命令层按 id 定位。
// ─────────────────────────────────────────────────────────────────────────────

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

import { spawnPty, resizePty, killPty } from "./ipc.js";

// 默认终端外观(与 main.js 的 M0 实例保持一致,后续可做成可配置)。
const DEFAULT_TERM_OPTIONS = Object.freeze({
  fontFamily:
    'Menlo, Consolas, "DejaVu Sans Mono", "Cascadia Mono", monospace',
  fontSize: 14,
  cursorBlink: true,
  allowProposedApi: true,
  theme: {
    background: "#1e1e1e",
    foreground: "#d4d4d4",
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 桥实例:持有 paneId -> session 的表,统一编排 fit/resize/关闭。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 创建一个终端-PTY 桥。
 * @param {object} config
 * @param {string|null} [config.shell]   覆盖后端默认 shell(不传走平台默认)。
 * @param {object}      [config.termOptions] 覆盖 xterm 构造选项(浅合并)。
 * @param {(paneId:string)=>void} [config.onExit]  某窗格 shell 退出时回调(集成层收尾)。
 * @returns 桥对象(见下方导出的方法)。
 */
export function createBridge(config = {}) {
  const shell = config.shell ?? null;
  const termOptions = { ...DEFAULT_TERM_OPTIONS, ...(config.termOptions || {}) };
  const onExitHook = typeof config.onExit === "function" ? config.onExit : null;

  // paneId(string) -> session
  // session = { paneId, term, fit, ptyId, host, observer, ready, disposed }
  const sessions = new Map();

  // ── 尝试挂 WebGL addon,失败则回退默认渲染(某些 WebView 不支持)。────────────
  function tryWebgl(term) {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[bridge] WebGL addon 不可用,回退默认渲染:", err);
    }
  }

  // ── fit 单个会话并把新行列同步给 PTY。宿主无尺寸时安全跳过。────────────────────
  function fitSession(session) {
    if (!session || session.disposed) return;
    try {
      session.fit.fit();
    } catch {
      // 宿主还没布局(width/height=0)时 fit 会抛,忽略,等下一次 relayout/observer。
      return;
    }
    if (session.ptyId != null) {
      const cols = session.term.cols;
      const rows = session.term.rows;
      if (cols > 0 && rows > 0) resizePty(session.ptyId, cols, rows);
    }
  }

  // ── renderLeaf:pane.layout 的回调实现,对 leaf.id 幂等。────────────────────────
  //    首次:建 Terminal + FitAddon(+WebGL)→ open 到 host → spawn PTY → 装 ResizeObserver。
  //    复用(relayout):把已存在 term 的根 DOM 原地迁移到新 host,PTY 不重开。
  function renderLeaf(leaf, host) {
    const existing = sessions.get(leaf.id);

    if (existing && !existing.disposed) {
      // relayout:迁移旧 term 的 DOM 到新宿主,并把 observer 换到新宿主上。
      reparent(existing, host);
      // 回填 leaf 引用(pane.js 可能重建了 leaf 对象引用,但 id 不变)。
      leaf.term = existing.term;
      leaf.termId = existing.ptyId;
      // 下一帧 fit:等新宿主完成布局拿到真实尺寸。
      scheduleFit(existing);
      return existing;
    }

    // 首次创建。
    const term = new Terminal(termOptions);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    tryWebgl(term);

    const session = {
      paneId: leaf.id,
      term,
      fit,
      ptyId: null,
      host,
      observer: null,
      ready: null,
      disposed: false,
    };
    sessions.set(leaf.id, session);

    // 先 fit 一次拿到初始 cols/rows,再按此尺寸 spawn PTY,避免 shell 以 80x24 起后再抖动。
    try {
      fit.fit();
    } catch {
      /* 宿主暂无尺寸,spawnPty 会用 term 默认 cols/rows 兜底 */
    }

    // spawn:reuse ipc.spawnPty —— 它内部装好输出监听、按键 onData→pty_write 回传。
    session.ready = spawnPty(term, {
      cols: term.cols,
      rows: term.rows,
      shell,
      onExit: (id) => handleExit(leaf.id, id),
    })
      .then((id) => {
        if (session.disposed) {
          // 会话在 spawn 完成前已被关闭:立刻收尸,别泄漏后端 PTY。
          killPty(id);
          return null;
        }
        session.ptyId = id;
        leaf.term = term;
        leaf.termId = id;
        // spawn 后再同步一次尺寸,确保后端 PTY 与前端一致。
        fitSession(session);
        return id;
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[bridge] spawnPty(${leaf.id}) 失败:`, err);
        return null;
      });

    // 容器尺寸变化(拖分隔条 / 窗口 resize)→ 自动 fit + 通知 PTY。
    attachObserver(session, host);

    return session;
  }

  // ── 把已存在 term 的根 DOM 迁到新宿主。────────────────────────────────────────
  function reparent(session, newHost) {
    const el = session.term.element; // xterm 的根容器 div
    if (el && el.parentElement !== newHost) {
      newHost.appendChild(el); // appendChild 会自动从旧父摘下,历史/滚动缓冲不丢
    }
    session.host = newHost;
    attachObserver(session, newHost); // observer 重新盯新宿主
  }

  // ── 在宿主上装 ResizeObserver;换宿主时先断开旧的。─────────────────────────────
  function attachObserver(session, host) {
    if (session.observer) session.observer.disconnect();
    if (typeof ResizeObserver === "undefined") {
      session.observer = null;
      return; // 环境无 ResizeObserver:退化为仅靠 fitAll()/relayout 驱动。
    }
    const observer = new ResizeObserver(() => scheduleFit(session));
    observer.observe(host);
    session.observer = observer;
  }

  // ── 合并同一帧内的多次 fit 请求,避免抖动。────────────────────────────────────
  function scheduleFit(session) {
    if (session.disposed || session._fitQueued) return;
    session._fitQueued = true;
    const run = () => {
      session._fitQueued = false;
      fitSession(session);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else run();
  }

  // ── shell 退出(EOF):清本地会话并回调集成层收尾。──────────────────────────────
  function handleExit(paneId, ptyId) {
    const session = sessions.get(paneId);
    if (session && !session.disposed) {
      // 输出监听已由 ipc.js 在退出时自行注销;这里只标记会话失效。
      session.ptyId = null;
    }
    if (onExitHook) onExitHook(paneId, ptyId);
  }

  // ── 关闭某个窗格:杀 PTY + 拆终端 + 断 observer。─────────────────────────────
  function close(paneId) {
    const session = sessions.get(paneId);
    if (!session) return;
    session.disposed = true;
    if (session.observer) {
      session.observer.disconnect();
      session.observer = null;
    }
    if (session.ptyId != null) {
      killPty(session.ptyId); // ipc.killPty 内部会 dispose onData 监听并 invoke pty_kill
    } else if (session.ready) {
      // 还没拿到 id 就被关:等 spawn 落地后由 renderLeaf 里的 disposed 分支收尸。
      session.ready.then((id) => {
        if (id != null) killPty(id);
      });
    }
    try {
      session.term.dispose();
    } catch {
      /* 忽略重复 dispose */
    }
    sessions.delete(paneId);
  }

  // ── 清理已不在窗格树中的会话(relayout 后按存活 id 列表对账)。──────────────────
  function pruneStale(aliveIds) {
    const alive = new Set(aliveIds);
    for (const paneId of [...sessions.keys()]) {
      if (!alive.has(paneId)) close(paneId);
    }
  }

  // ── fit 全部会话(每次 relayout 后调用,统一把尺寸推给各 PTY)。─────────────────
  function fitAll() {
    for (const session of sessions.values()) scheduleFit(session);
  }

  // ── 聚焦某窗格的终端。────────────────────────────────────────────────────────
  function focus(paneId) {
    const session = sessions.get(paneId);
    if (session && !session.disposed) {
      try {
        session.term.focus();
      } catch {
        /* 忽略 */
      }
    }
  }

  // ── 取某窗格的后端 PTY id(供命令层按需定位)。─────────────────────────────────
  function ptyIdOf(paneId) {
    return sessions.get(paneId)?.ptyId ?? null;
  }

  // ── 全部销毁(应用关闭时)。──────────────────────────────────────────────────
  function disposeAll() {
    for (const paneId of [...sessions.keys()]) close(paneId);
  }

  return {
    renderLeaf, // 传给 pane.layout 的 opts.renderLeaf
    fitAll,
    focus,
    close,
    pruneStale,
    ptyIdOf,
    disposeAll,
    // 便于调试/测试:只读暴露会话表大小。
    get size() {
      return sessions.size;
    },
  };
}

export default { createBridge };
