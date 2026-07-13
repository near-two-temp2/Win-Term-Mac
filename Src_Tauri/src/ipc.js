// Win-Term-Mac · Tauri 前端 · IPC 桥(Terminal 角色)
//
// 把后端 pty.rs 的 PTY 会话与前端 xterm.js 实例双向连通:
//   - 按键:xterm term.onData(str) → invoke("pty_write") → PTY 输入
//   - 输出:listen("pty://output") → 按 id 路由 → term.write(Uint8Array)
//   - 尺寸:invoke("pty_resize");关闭:invoke("pty_kill")
//
// 后端每个 PTY 用一个数字 id 标识,对应窗格树里 leaf.termId。
// 本模块维护 id -> xterm 实例的路由表,并只装一个全局输出监听器分发数据。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// 事件名(与后端 pty.rs 常量一致)。
const EVENT_OUTPUT = "pty://output";
const EVENT_EXIT = "pty://exit";

// id -> { term, onExit } 路由表。
const registry = new Map();

// 全局监听器只装一次。
let listenersReady = null;

// 惰性初始化输出/退出事件监听。多次调用只装一次。
function ensureListeners() {
  if (listenersReady) return listenersReady;
  listenersReady = Promise.all([
    // PTY 输出:payload = { id, data: number[] }。
    listen(EVENT_OUTPUT, (event) => {
      const { id, data } = event.payload;
      const entry = registry.get(id);
      if (!entry) return; // 该窗格可能已关闭。
      // 原始字节喂给 xterm;其内部完成 VT 解析与跨块的 UTF-8 缓冲。
      entry.term.write(new Uint8Array(data));
    }),
    // PTY 退出:payload = { id }。
    listen(EVENT_EXIT, (event) => {
      const { id } = event.payload;
      const entry = registry.get(id);
      if (!entry) return;
      registry.delete(id);
      if (typeof entry.onExit === "function") entry.onExit(id);
    }),
  ]);
  return listenersReady;
}

// 起一个新 PTY 并把它接到给定的 xterm 实例上。
//
// term    : 已 open() 到 DOM 的 xterm.js Terminal 实例
// options : { cols, rows, shell?, onExit? }
//           不传 cols/rows 时用 term.cols/term.rows。
// 返回:后端分配的 pty id(填进窗格树 leaf.termId)。
export async function spawnPty(term, options = {}) {
  await ensureListeners();

  const cols = options.cols ?? term.cols ?? 80;
  const rows = options.rows ?? term.rows ?? 24;

  const id = await invoke("pty_spawn", {
    cols,
    rows,
    shell: options.shell ?? null,
  });

  registry.set(id, { term, onExit: options.onExit });

  // 键入:xterm 产出的字符串(含控制序列)原样回传 PTY。
  const dataDisposable = term.onData((str) => {
    invoke("pty_write", { id, data: str }).catch((err) => {
      console.error(`[ipc] pty_write(${id}) 失败:`, err);
    });
  });

  // 记住 disposable,detach 时释放监听,避免泄漏。
  const entry = registry.get(id);
  if (entry) entry.dataDisposable = dataDisposable;

  return id;
}

// 把一个已存在的 PTY 重新绑定到某个 xterm 实例。
// 用于窗格 Swap/Move:窗格挪位后 termId 不变,只是换了承载的 term/DOM。
export function attachTerminal(id, term, onExit) {
  const prev = registry.get(id);
  // 解绑旧 term 的按键监听(若有)。
  if (prev?.dataDisposable) prev.dataDisposable.dispose();

  const dataDisposable = term.onData((str) => {
    invoke("pty_write", { id, data: str }).catch((err) => {
      console.error(`[ipc] pty_write(${id}) 失败:`, err);
    });
  });

  registry.set(id, { term, onExit, dataDisposable });
}

// 手动向 PTY 写入(一般用不到;按键已由 spawnPty/attachTerminal 自动接好)。
export function writePty(id, data) {
  return invoke("pty_write", { id, data });
}

// 窗格尺寸变化后同步 PTY 行列。调用方通常在 fit() 之后传 term.cols/term.rows。
export function resizePty(id, cols, rows) {
  return invoke("pty_resize", { id, cols, rows }).catch((err) => {
    console.error(`[ipc] pty_resize(${id}) 失败:`, err);
  });
}

// 关闭窗格时销毁 PTY 并清理本地路由。
export function killPty(id) {
  const entry = registry.get(id);
  if (entry?.dataDisposable) entry.dataDisposable.dispose();
  registry.delete(id);
  return invoke("pty_kill", { id }).catch((err) => {
    console.error(`[ipc] pty_kill(${id}) 失败:`, err);
  });
}
