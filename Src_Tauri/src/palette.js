// Win-Term-Mac · Tauri 方案 · 角色 Palette
// 职责:命令面板浮层(Ctrl/Cmd+Shift+P 唤出)+ 可搜索命令列表。复刻 WT 的设计哲学:
//       高频操作有热键(见 keymap.js),低频强力操作(交换 swapPane / 移动 movePane)
//       不给热键、只从命令面板触发。
//
// 本模块只负责:命令注册表 + 浮层 UI(搜索框 + 模糊过滤 + 键盘/鼠标选择)+ 派发。
// 具体“对窗格树做什么”由集成层通过 controller(动作接口)注入;这里给出默认命令表,
// 每条命令的 run() 调用 controller 上对应的方法(带 TODO 桩,便于集成层接线)。
//
// 依赖:keymap.js(仅用于在列表右侧展示命令的默认快捷键)。不直接依赖 xterm / Tauri。

import { chordForCommand, formatChord } from "./keymap.js";

// ---------------------------------------------------------------------------
// 默认命令表
// ---------------------------------------------------------------------------
//
// 每条命令:
//   id         与 keymap.js 的命令 id 对齐(用于反查快捷键)
//   title      面板里显示的名字
//   category   分组前缀(仅展示用)
//   keywords   额外可搜索关键词(中英混排,提升可发现性)
//   paletteOnly true 表示该命令“只应从面板触发”(swapPane / movePane)
//   run(ctx)   执行体;ctx = { controller, palette }
//
// 说明:swapPane / movePane 需要一个“方向”参数(与哪个相邻窗格交换/移动到哪一侧)。
// WT 里 swapPane 带方向、默认无热键。这里为四个方向各注册一条独立命令,全部 paletteOnly。

/**
 * 生成默认命令表。controller 是集成层注入的动作接口(见文件末尾 ControllerShape 说明)。
 * 未注入某方法时,命令仍可显示,执行时打印 TODO 提示而不崩溃。
 */
export function buildDefaultCommands() {
  const call = (ctx, method, ...args) => {
    const fn = ctx.controller && ctx.controller[method];
    if (typeof fn === "function") return fn.apply(ctx.controller, args);
    // TODO(集成 · panes/term/): 把 controller.<method> 接到 pane.js 的对应操作 + ipc.js。
    // eslint-disable-next-line no-console
    console.warn(`[palette] controller.${method}(${args.join(", ")}) 未接线(TODO 桩)。`);
    return undefined;
  };

  const dirs = ["left", "right", "up", "down"];
  const dirLabel = { left: "左", right: "右", up: "上", down: "下" };

  const cmds = [
    // —— 拆分(高频,也有热键)——
    {
      id: "splitPane.right",
      title: "拆分窗格:向右",
      category: "窗格",
      keywords: "split right 右侧 竖直",
      run: (ctx) => call(ctx, "split", "row"),
    },
    {
      id: "splitPane.down",
      title: "拆分窗格:向下",
      category: "窗格",
      keywords: "split down 下方 水平",
      run: (ctx) => call(ctx, "split", "column"),
    },

    // —— 切焦点 / 调整大小(高频,有热键;也可从面板走)——
    ...dirs.map((d) => ({
      id: `moveFocus.${d}`,
      title: `切换焦点:${dirLabel[d]}`,
      category: "焦点",
      keywords: `focus navigate 焦点 ${d}`,
      run: (ctx) => call(ctx, "moveFocus", d),
    })),
    ...dirs.map((d) => ({
      id: `resizePane.${d}`,
      title: `调整大小:${dirLabel[d]}`,
      category: "窗格",
      keywords: `resize 大小 ${d}`,
      run: (ctx) => call(ctx, "resizePane", d),
    })),

    // —— 交换窗格 swapPane(低频强力,仅面板)——
    ...dirs.map((d) => ({
      id: `swapPane.${d}`,
      title: `交换窗格:与${dirLabel[d]}侧`,
      category: "窗格",
      keywords: `swap 交换 ${d}`,
      paletteOnly: true,
      run: (ctx) => call(ctx, "swapPane", d),
    })),

    // —— 移动窗格 movePane(低频强力,仅面板)——
    ...dirs.map((d) => ({
      id: `movePane.${d}`,
      title: `移动窗格:到${dirLabel[d]}侧`,
      category: "窗格",
      keywords: `move detach attach 移动 ${d}`,
      paletteOnly: true,
      run: (ctx) => call(ctx, "movePane", d),
    })),

    // —— 其它 ——
    {
      id: "togglePaneZoom",
      title: "最大化/还原当前窗格",
      category: "窗格",
      keywords: "maximize restore zoom 最大化 还原",
      run: (ctx) => call(ctx, "toggleZoom"),
    },
    {
      id: "closePane",
      title: "关闭当前窗格",
      category: "窗格",
      keywords: "close 关闭 kill",
      run: (ctx) => call(ctx, "closePane"),
    },
  ];

  return cmds;
}

// ---------------------------------------------------------------------------
// 模糊搜索:子序列匹配 + 简单打分
// ---------------------------------------------------------------------------

/**
 * 判断 query 是否为 text 的(忽略大小写)子序列,并返回一个分数(越小越靠前)。
 * 命中返回 { score, positions },未命中返回 null。positions 用于高亮标题命中字符。
 */
export function fuzzyMatch(query, text) {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const positions = [];
  let ti = 0;
  let score = 0;
  let lastHit = -1;
  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi];
    let found = -1;
    for (; ti < t.length; ti += 1) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
    }
    if (found === -1) return null; // 有字符对不上,整体不匹配
    positions.push(found);
    // 连续命中不加惩罚;跳字符按间隔加分(越分散越差)
    if (lastHit >= 0) score += found - lastHit - 1;
    lastHit = found;
    ti = found + 1;
  }
  // 越早开始命中越好(轻微加权)
  score += positions[0] * 0.1;
  return { score, positions };
}

/**
 * 对命令表按 query 过滤并排序。空 query 返回全部(保持原序)。
 * 匹配范围:title + category + keywords + id;高亮只针对 title。
 * @returns [{ command, score, positions }]
 */
export function filterCommands(commands, query) {
  if (!query || !query.trim()) {
    return commands.map((command) => ({ command, score: 0, positions: [] }));
  }
  const out = [];
  for (const command of commands) {
    const hay = `${command.title} ${command.category ?? ""} ${command.keywords ?? ""} ${command.id}`;
    const m = fuzzyMatch(query.trim(), hay);
    if (!m) continue;
    // 标题上单独再算一次高亮位置(命中标题时更准)
    const titleMatch = fuzzyMatch(query.trim(), command.title);
    out.push({
      command,
      score: m.score,
      positions: titleMatch ? titleMatch.positions : [],
    });
  }
  out.sort((a, b) => a.score - b.score);
  return out;
}

// ---------------------------------------------------------------------------
// 浮层样式(自包含注入,避免依赖外部 CSS)
// ---------------------------------------------------------------------------

const STYLE_ID = "wtm-palette-style";
const CSS = `
.wtm-palette-overlay {
  position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: flex-start; justify-content: center;
  background: rgba(0,0,0,0.35);
  font-family: Menlo, Consolas, "Segoe UI", system-ui, sans-serif;
}
.wtm-palette-panel {
  margin-top: 12vh; width: min(560px, 90vw);
  background: #252526; color: #d4d4d4;
  border: 1px solid #3c3c3c; border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  overflow: hidden; display: flex; flex-direction: column;
}
.wtm-palette-input {
  border: none; outline: none;
  background: #1e1e1e; color: #d4d4d4;
  font-size: 15px; padding: 12px 14px;
  border-bottom: 1px solid #3c3c3c;
}
.wtm-palette-input::placeholder { color: #6a6a6a; }
.wtm-palette-list {
  list-style: none; margin: 0; padding: 4px;
  max-height: 50vh; overflow-y: auto;
}
.wtm-palette-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 10px; border-radius: 5px; cursor: pointer; gap: 12px;
}
.wtm-palette-item[aria-selected="true"] { background: #094771; }
.wtm-palette-item .wtm-title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wtm-palette-item .wtm-title mark { background: transparent; color: #4fc1ff; font-weight: 600; }
.wtm-palette-item .wtm-cat { color: #808080; font-size: 12px; }
.wtm-palette-item .wtm-key {
  color: #9cdcfe; font-size: 12px; white-space: nowrap;
  border: 1px solid #3c3c3c; border-radius: 4px; padding: 1px 6px;
}
.wtm-palette-empty { padding: 16px; color: #808080; text-align: center; }
`;

function ensureStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/** 把命中位置渲染成带 <mark> 高亮的标题 HTML(已做 HTML 转义)。 */
function highlightTitle(title, positions) {
  const set = new Set(positions);
  let html = "";
  for (let i = 0; i < title.length; i += 1) {
    const ch = title[i]
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    html += set.has(i) ? `<mark>${ch}</mark>` : ch;
  }
  return html;
}

// ---------------------------------------------------------------------------
// Palette:命令面板浮层
// ---------------------------------------------------------------------------

export class Palette {
  /**
   * @param opts.commands   命令表;默认 buildDefaultCommands()
   * @param opts.controller 动作接口(注入 run 用);见文件末尾 ControllerShape
   * @param opts.parent     浮层挂载点;默认 document.body
   */
  constructor(opts = {}) {
    this.commands = opts.commands ?? buildDefaultCommands();
    this.controller = opts.controller ?? null;
    this.parent = opts.parent ?? (typeof document !== "undefined" ? document.body : null);

    this.open = false;
    this.selected = 0;
    this.results = [];

    this._overlay = null;
    this._input = null;
    this._list = null;
    this._onKeyDown = this._onKeyDown.bind(this);
  }

  /** 设置/更新动作接口(集成层接线用)。 */
  setController(controller) {
    this.controller = controller;
  }

  /** 打开面板并聚焦搜索框。 */
  openPalette() {
    if (this.open) return;
    ensureStyle();
    this._build();
    this.open = true;
    this._input.value = "";
    this._refresh("");
    this._input.focus();
  }

  /** 关闭面板并清理 DOM。 */
  closePalette() {
    if (!this.open) return;
    this.open = false;
    if (this._overlay && this._overlay.parentNode) {
      this._overlay.parentNode.removeChild(this._overlay);
    }
    this._overlay = null;
    this._input = null;
    this._list = null;
  }

  /** 开/关切换(供 commandPalette 命令 / 热键调用)。 */
  toggle() {
    if (this.open) this.closePalette();
    else this.openPalette();
  }

  /** 执行一条命令(可由外部按 id 直接触发热键命令,paletteOnly 命令会被拒绝)。 */
  execute(command, { fromPalette = false } = {}) {
    const cmd = typeof command === "string" ? this.commands.find((c) => c.id === command) : command;
    if (!cmd) {
      // eslint-disable-next-line no-console
      console.warn(`[palette] 未知命令: ${command}`);
      return;
    }
    if (cmd.paletteOnly && !fromPalette) {
      // swapPane/movePane 只允许从面板触发,拒绝热键直呼
      // eslint-disable-next-line no-console
      console.warn(`[palette] 命令 ${cmd.id} 仅限命令面板触发。`);
      return;
    }
    try {
      cmd.run({ controller: this.controller, palette: this });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[palette] 执行 ${cmd.id} 失败:`, err);
    }
  }

  // —— 内部:构建 DOM ——

  _build() {
    const overlay = document.createElement("div");
    overlay.className = "wtm-palette-overlay";
    // 点击遮罩空白处关闭
    overlay.addEventListener("mousedown", (ev) => {
      if (ev.target === overlay) this.closePalette();
    });

    const panel = document.createElement("div");
    panel.className = "wtm-palette-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "命令面板");

    const input = document.createElement("input");
    input.className = "wtm-palette-input";
    input.type = "text";
    input.placeholder = "输入命令…(↑↓ 选择,Enter 执行,Esc 关闭)";
    input.addEventListener("input", () => this._refresh(input.value));
    input.addEventListener("keydown", this._onKeyDown);

    const list = document.createElement("ul");
    list.className = "wtm-palette-list";

    panel.appendChild(input);
    panel.appendChild(list);
    overlay.appendChild(panel);
    this.parent.appendChild(overlay);

    this._overlay = overlay;
    this._input = input;
    this._list = list;
  }

  // —— 内部:过滤 + 渲染 ——

  _refresh(query) {
    this.results = filterCommands(this.commands, query);
    this.selected = 0;
    this._render();
  }

  _render() {
    const list = this._list;
    if (!list) return;
    list.innerHTML = "";
    if (this.results.length === 0) {
      const empty = document.createElement("li");
      empty.className = "wtm-palette-empty";
      empty.textContent = "无匹配命令";
      list.appendChild(empty);
      return;
    }
    this.results.forEach((res, i) => {
      const { command, positions } = res;
      const li = document.createElement("li");
      li.className = "wtm-palette-item";
      li.setAttribute("aria-selected", i === this.selected ? "true" : "false");

      const title = document.createElement("span");
      title.className = "wtm-title";
      title.innerHTML = highlightTitle(command.title, positions);

      const right = document.createElement("span");
      right.style.display = "flex";
      right.style.alignItems = "center";
      right.style.gap = "10px";

      if (command.category) {
        const cat = document.createElement("span");
        cat.className = "wtm-cat";
        cat.textContent = command.category;
        right.appendChild(cat);
      }
      // 展示默认快捷键(paletteOnly 命令一般没有,留空)
      const chord = chordForCommand(command.id);
      if (chord) {
        const key = document.createElement("span");
        key.className = "wtm-key";
        key.textContent = formatChord(chord);
        right.appendChild(key);
      }

      li.appendChild(title);
      li.appendChild(right);
      li.addEventListener("mouseenter", () => {
        this.selected = i;
        this._syncSelection();
      });
      li.addEventListener("mousedown", (ev) => {
        ev.preventDefault(); // 别让输入框失焦
        this._confirm(i);
      });
      list.appendChild(li);
    });
  }

  _syncSelection() {
    const items = this._list?.querySelectorAll(".wtm-palette-item");
    if (!items) return;
    items.forEach((el, i) => {
      el.setAttribute("aria-selected", i === this.selected ? "true" : "false");
      if (i === this.selected) el.scrollIntoView({ block: "nearest" });
    });
  }

  _confirm(index) {
    const res = this.results[index];
    if (!res) return;
    this.closePalette();
    // 关闭后再执行,避免命令里再操作 DOM 时与面板打架
    this.execute(res.command, { fromPalette: true });
  }

  _onKeyDown(ev) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      this.closePalette();
      return;
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      if (this.results.length) {
        this.selected = (this.selected + 1) % this.results.length;
        this._syncSelection();
      }
      return;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (this.results.length) {
        this.selected = (this.selected - 1 + this.results.length) % this.results.length;
        this._syncSelection();
      }
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      this._confirm(this.selected);
    }
  }
}

// ---------------------------------------------------------------------------
// 与 keymap 的胶合:一个即插即用的接线器(集成层可直接用)
// ---------------------------------------------------------------------------

/**
 * 把 keymap 的 attachKeymap 与 Palette 接起来:
 *   - commandPalette 命令 → 切换面板
 *   - 其它命令        → palette.execute(commandId)(热键路径,paletteOnly 会被拒)
 *
 * @param opts.attachKeymap keymap.js 的 attachKeymap 函数(由集成层传入,避免这里硬依赖装配副作用)
 * @param opts.palette      Palette 实例
 * @param opts.target       监听目标,默认 window
 * @returns 卸载函数
 */
export function wirePalette({ attachKeymap, palette, target = window }) {
  if (typeof attachKeymap !== "function") {
    throw new Error("wirePalette: 需要传入 keymap.attachKeymap");
  }
  return attachKeymap(target, (command) => {
    if (command === "commandPalette") {
      palette.toggle();
      return true;
    }
    palette.execute(command); // 非面板命令走热键路径
    return true;
  });
}

// ---------------------------------------------------------------------------
// ControllerShape —— 集成层需要实现的动作接口(仅文档,便于接线)
// ---------------------------------------------------------------------------
//
// controller = {
//   split(dir)         // dir: "row"(右) | "column"(下) —— 调 pane.split() 后重排 + ipc.spawnPty()
//   moveFocus(dir)     // dir: left/right/up/down —— 调 pane.navigate() 换焦点并 term.focus()
//   resizePane(dir)    // dir: left/right/up/down —— 换算成 axis+delta 调 pane.resize() 后重排 + resizePty()
//   swapPane(dir)      // 面板专用:navigate 找相邻叶子 → pane.swap() → 重排 + ipc.attachTerminal()
//   movePane(dir)      // 面板专用:navigate 找目标 → pane.move() → 重排 + ipc.attachTerminal()
//   toggleZoom()       // 最大化/还原当前窗格(maximize/restore)
//   closePane()        // pane.detach() 坍缩 + ipc.killPty()
// }
//
// TODO(集成 · panes/term/): 在应用入口构造 Palette + controller,再 wirePalette 接热键。

export default {
  Palette,
  buildDefaultCommands,
  filterCommands,
  fuzzyMatch,
  wirePalette,
};
