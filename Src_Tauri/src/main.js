// Win-Term-Mac · Tauri 前端入口(集成装配)
//
// 职责:把四个角色模块接线成可交互的多窗格终端:
//   - term.js      createTermManager  → 每个窗格叶子一个真实 xterm + 后端 PTY(经 ipc.js)
//   - pane.js      窗格二叉树的树算法与 layout 渲染(被 controller 调用)
//   - palette.js   命令面板浮层(Ctrl/Cmd+Shift+P)
//   - keymap.js    热键表(拆分 / 切焦点 / 调大小 / 命令面板)
//   - controller.js mountController 一步装配:建树 + 首绘 + 接热键 + 接命令面板
//
// 启动后:窗口显示一个真终端(跑默认 shell)→ 可敲命令 →
//   Alt+Shift+加号 向右拆分 / Alt+Shift+减号 向下拆分 →
//   Alt+方向键 切焦点 → Alt+Shift+方向键 调整比例 →
//   Ctrl/Cmd+Shift+P 打开命令面板(含 swap/move/zoom/close)。

import { createTermManager } from "./term.js";
import { mountController } from "./controller.js";
import "@xterm/xterm/css/xterm.css";

// 窗格挂载容器:整屏根节点。controller 会用 PaneCore.layout 递归渲染进这里。
const container = document.getElementById("root");

// 终端视图管理器:注入给 controller 作为 renderLeaf 提供方。
// onFocus:xterm 被点击/键入获焦时,把「当前窗格」同步回控制器,
//          使 split/close 等「作用于当前窗格」的操作跟随鼠标焦点。
let app = null;
const tm = createTermManager({
  shell: null, // null → 后端 pty.rs 按平台选默认 shell(pwsh / bash / zsh)
  fontSize: 14,
  onFocus: (paneId) => {
    if (app) app.notifyFocus(paneId);
  },
});

// 一步装配:建初始单窗格树 + 首绘(起第一个真 PTY)+ 接热键 + 接命令面板。
app = mountController({
  container,
  view: tm,
  target: window, // 热键监听目标
});

// 窗口尺寸变化:让所有终端重新 fit 并把新 cols/rows 同步到后端 PTY。
// (term.js 内部已对每个 wrapper 装了 ResizeObserver;这里再兜一次底,
//  避免个别 WebView 不触发 ResizeObserver 的情况。)
window.addEventListener("resize", () => tm.fitAll());

// 应用整体销毁(窗口关闭)时,卸载热键并杀掉所有 PTY,避免子进程泄漏。
window.addEventListener("beforeunload", () => {
  try {
    app.destroy(); // 卸载热键监听 + 关闭可能打开的命令面板
  } catch (_) {
    /* ignore */
  }
  tm.disposeAll(); // 杀掉所有窗格的 PTY 子进程
});

// 便于在开发者控制台里手动检查状态 / 触发命令。
// eslint-disable-next-line no-undef
if (typeof window !== "undefined") {
  window.__wtm = { app, tm };
}

// TODO(集成): 若后续要持久化窗格布局(重启恢复),可在此序列化 app.getState().root
//              并在启动时通过 app.setRoot(restoredRoot) 恢复。
