// Win-Term-Mac · Tauri 前端入口(M0)
// 职责:初始化一个 xterm.js 终端实例并挂载 WebGL addon,渲染到 #term-host。
// 后续:PTY 接线(term/)、窗格二叉树(panes/)、命令面板(palette/)、键位(keymap/)分属其它角色。

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

// 创建一个基础终端实例。主题/字体等后续在 term/ 里做成可配置。
const term = new Terminal({
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

// 自适应容器尺寸的 addon。
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

// 挂载到 DOM。
const host = document.getElementById("term-host");
term.open(host);

// WebGL 渲染 addon(提性能)。部分 WebView(尤其 Linux WebKitGTK)可能不支持,
// 失败时回退到默认渲染,避免整屏黑。
try {
  const webgl = new WebglAddon();
  webgl.onContextLoss(() => webgl.dispose());
  term.loadAddon(webgl);
} catch (err) {
  console.warn("[Win-Term-Mac] WebGL addon 不可用,回退默认渲染:", err);
}

// 首次适配 + 跟随窗口尺寸变化。
fitAddon.fit();
window.addEventListener("resize", () => fitAddon.fit());

// M0 占位输出:证明终端 UI 正常。M1 起接真实 PTY。
term.writeln("Win-Term-Mac · Tauri 方案");
term.writeln("M0: xterm.js 已就绪(尚未接 PTY)。");

// TODO(集成 · term/): 通过 Tauri invoke("pty_spawn") 起 PTY,
// listen("pty://output") 把字节写进 term,term.onData 通过 invoke("pty_write") 回传按键。
// TODO(集成 · panes/): 用窗格二叉树替换单一 #term-host,每个叶子一个 Terminal 实例。
