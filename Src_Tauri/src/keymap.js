// Win-Term-Mac · Tauri 方案 · 角色 Keymap
// 职责:把 Windows Terminal 的键位映射成一组“命令 id”,并处理跨平台修饰键差异
//       (Windows/Linux 的 Ctrl → macOS 的 Cmd)。本模块是纯映射逻辑 + 一个可选的
//       keydown 监听装配器,不依赖 xterm / Tauri / DOM 结构,可独立自测。
//
// 设计对齐已核实的 WT 事实:
//   命令面板    Ctrl+Shift+P            → commandPalette
//   右侧拆分    Alt+Shift++             → splitPane.right
//   下方拆分    Alt+Shift+-             → splitPane.down
//   调整大小    Alt+Shift+方向键         → resizePane.{left,right,up,down}
//   切焦点      Alt+方向键               → moveFocus.{left,right,up,down}
//   关闭窗格    Ctrl+Shift+W            → closePane
//   交换窗格 swapPane / 移动窗格 movePane:WT 默认无热键,只走命令面板(见 palette.js)。
//
// macOS 上把“主修饰键”从 Ctrl 换成 Cmd:默认键表里用抽象 token "Mod" 表示主修饰键,
// resolveChord() 按平台把 event.ctrlKey(win/linux)或 event.metaKey(mac)归一成 "Mod"。
// Alt(mac 上的 Option)在两个平台保持一致,不做替换。

// ---------------------------------------------------------------------------
// 平台探测
// ---------------------------------------------------------------------------

/** 尽量稳健地判断是否 macOS(浏览器/WebView 环境)。 */
function detectMac() {
  if (typeof navigator === "undefined") return false;
  const plat =
    navigator.userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent ||
    "";
  return /mac|iphone|ipad|ipod/i.test(plat);
}

export const isMac = detectMac();

// ---------------------------------------------------------------------------
// 默认键表(WT 键位 → 命令 id)
// ---------------------------------------------------------------------------
//
// chord 语法:修饰键固定顺序 "Mod" → "Alt" → "Shift",再接一个主键,用 "+" 连接。
//   "Mod"   平台主修饰键:win/linux = Ctrl,mac = Cmd(Meta)
//   "Alt"   Alt / Option
//   "Shift" Shift
// 主键 token:字母大写(如 "P" "W");方向键 "ArrowLeft/Right/Up/Down";
//            加号 "Plus";减号 "Minus";其余特殊键用其 KeyboardEvent.key(如 "Escape")。

export const defaultKeymap = Object.freeze([
  { chord: "Mod+Shift+P", command: "commandPalette" },

  { chord: "Alt+Shift+Plus", command: "splitPane.right" },
  { chord: "Alt+Shift+Minus", command: "splitPane.down" },

  { chord: "Alt+Shift+ArrowLeft", command: "resizePane.left" },
  { chord: "Alt+Shift+ArrowRight", command: "resizePane.right" },
  { chord: "Alt+Shift+ArrowUp", command: "resizePane.up" },
  { chord: "Alt+Shift+ArrowDown", command: "resizePane.down" },

  { chord: "Alt+ArrowLeft", command: "moveFocus.left" },
  { chord: "Alt+ArrowRight", command: "moveFocus.right" },
  { chord: "Alt+ArrowUp", command: "moveFocus.up" },
  { chord: "Alt+ArrowDown", command: "moveFocus.down" },

  { chord: "Mod+Shift+W", command: "closePane" },
]);

// ---------------------------------------------------------------------------
// 事件 → chord 归一化
// ---------------------------------------------------------------------------

/**
 * 把 KeyboardEvent 的主键归一成 token;若事件本身只是按下修饰键,返回 null。
 */
function normalizeKey(event) {
  const k = event.key;
  if (k === "Control" || k === "Alt" || k === "Shift" || k === "Meta") {
    return null; // 单独按修饰键,不构成 chord
  }
  if (k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown") {
    return k;
  }
  // 加/减号在不同布局下 event.key 可能是 "+"/"="、"-"/"_",统一归一
  if (k === "+" || k === "=") return "Plus";
  if (k === "-" || k === "_") return "Minus";
  if (k.length === 1) return k.toUpperCase();
  return k; // Escape / Enter / Tab / F1 …
}

/**
 * 把一个 KeyboardEvent 归一成 chord 字符串(与 defaultKeymap 的 chord 同格式)。
 * 平台主修饰键(Ctrl/Cmd)统一记作 "Mod"。纯修饰键事件返回 null。
 */
export function resolveChord(event) {
  const key = normalizeKey(event);
  if (key == null) return null;
  const parts = [];
  const primary = isMac ? event.metaKey : event.ctrlKey;
  if (primary) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

// ---------------------------------------------------------------------------
// 查表:构建 chord→command 索引 + 反向 command→chord
// ---------------------------------------------------------------------------

/** 由键表构建 { byChord: Map, byCommand: Map } 双向索引。 */
export function buildIndex(keymap = defaultKeymap) {
  const byChord = new Map();
  const byCommand = new Map();
  for (const { chord, command } of keymap) {
    byChord.set(chord, command);
    if (!byCommand.has(command)) byCommand.set(command, chord);
  }
  return { byChord, byCommand };
}

const defaultIndex = buildIndex(defaultKeymap);

/** 由 KeyboardEvent 查出命令 id;无匹配返回 null。 */
export function lookup(event, index = defaultIndex) {
  const chord = resolveChord(event);
  if (!chord) return null;
  return index.byChord.get(chord) ?? null;
}

/** 由命令 id 反查其默认 chord(用于命令面板右侧展示快捷键);无则 null。 */
export function chordForCommand(command, index = defaultIndex) {
  return index.byCommand.get(command) ?? null;
}

// ---------------------------------------------------------------------------
// 展示:把 chord 格式化成给人看的字符串(mac 用符号,其余用文字)
// ---------------------------------------------------------------------------

const TOKEN_LABEL = {
  Mod: () => (isMac ? "⌘" : "Ctrl"),
  Alt: () => (isMac ? "⌥" : "Alt"),
  Shift: () => (isMac ? "⇧" : "Shift"),
  Plus: () => "+",
  Minus: () => "−",
  ArrowLeft: () => "←",
  ArrowRight: () => "→",
  ArrowUp: () => "↑",
  ArrowDown: () => "↓",
};

/** 把 chord 字符串(如 "Alt+Shift+ArrowRight")格式化为展示串(如 "Alt+Shift+→")。 */
export function formatChord(chord) {
  if (!chord) return "";
  const labels = chord.split("+").map((t) => (TOKEN_LABEL[t] ? TOKEN_LABEL[t]() : t));
  return isMac ? labels.join("") : labels.join("+");
}

// ---------------------------------------------------------------------------
// 装配器:在某个 DOM target 上挂 keydown 监听,命中键表就回调
// ---------------------------------------------------------------------------

/**
 * 在 target(默认 window)上安装键位监听。命中键表的按键会调用
 * handler(commandId, event);handler 返回 true(或调用 preventDefault)表示已处理,
 * 此时本装配器会自动 preventDefault + stopPropagation,避免按键漏进终端。
 *
 * @returns 卸载函数;调用后移除监听。
 */
export function attachKeymap(target = window, handler, index = defaultIndex) {
  const onKeyDown = (event) => {
    const command = lookup(event, index);
    if (!command) return;
    const handled = handler(command, event);
    // handler 明确返回 false 表示“不拦截,放行给终端”;否则默认吞掉按键
    if (handled !== false) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  target.addEventListener("keydown", onKeyDown, true);
  return () => target.removeEventListener("keydown", onKeyDown, true);
}

// ---------------------------------------------------------------------------
// 纯逻辑自测(无 DOM 依赖;伪造 event 对象即可)
// ---------------------------------------------------------------------------

/** 用于自测:构造一个最小 KeyboardEvent 替身。 */
function fakeEvent({ key, ctrl = false, meta = false, alt = false, shift = false }) {
  return { key, ctrlKey: ctrl, metaKey: meta, altKey: alt, shiftKey: shift };
}

/** 纯逻辑自测。通过返回 true,失败抛错。 */
export function selfTest() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`[keymap.selfTest] 断言失败: ${msg}`);
  };

  // resolveChord 基本用例(以非 mac 的主修饰键 Ctrl 触发 "Mod")
  const idx = defaultIndex;
  if (!isMac) {
    assert(lookup(fakeEvent({ key: "P", ctrl: true, shift: true }), idx) === "commandPalette",
      "Ctrl+Shift+P → commandPalette");
  } else {
    assert(lookup(fakeEvent({ key: "P", meta: true, shift: true }), idx) === "commandPalette",
      "Cmd+Shift+P → commandPalette(mac)");
  }
  assert(lookup(fakeEvent({ key: "+", alt: true, shift: true }), idx) === "splitPane.right",
    "Alt+Shift++ → splitPane.right");
  assert(lookup(fakeEvent({ key: "-", alt: true, shift: true }), idx) === "splitPane.down",
    "Alt+Shift+- → splitPane.down");
  assert(lookup(fakeEvent({ key: "ArrowRight", alt: true }), idx) === "moveFocus.right",
    "Alt+→ → moveFocus.right");
  assert(lookup(fakeEvent({ key: "ArrowUp", alt: true, shift: true }), idx) === "resizePane.up",
    "Alt+Shift+↑ → resizePane.up");

  // 单独按修饰键不构成 chord
  assert(resolveChord(fakeEvent({ key: "Shift", shift: true })) === null,
    "单独 Shift 不构成 chord");

  // 反查 + 格式化
  assert(chordForCommand("moveFocus.left", idx) === "Alt+ArrowLeft", "反查 moveFocus.left");
  assert(formatChord("Alt+ArrowLeft").includes(isMac ? "←" : "Alt"), "formatChord 含预期符号");

  // swapPane/movePane 无默认热键(只走命令面板)
  assert(chordForCommand("swapPane.left", idx) === null, "swapPane 无默认热键");
  assert(chordForCommand("movePane.left", idx) === null, "movePane 无默认热键");

  // eslint-disable-next-line no-console
  console.log(`[keymap.selfTest] 通过。平台 isMac=${isMac}。`);
  return true;
}

export default {
  isMac,
  defaultKeymap,
  resolveChord,
  buildIndex,
  lookup,
  chordForCommand,
  formatChord,
  attachKeymap,
  selfTest,
};
