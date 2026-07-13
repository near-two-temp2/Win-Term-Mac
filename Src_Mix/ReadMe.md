# Win-Term-Mac · Mix 实现(方案B)

> 一句话定位:把 Windows Terminal 最出彩的上层体验(自由切分窗格、命令面板交换/移动窗格、命令面板本身)复刻到 macOS + Linux(+Windows),追求原生手感与高性能。
>
> **本方案角色:方案B「Mix / Ghostty 模式」——共享内核 + 各平台原生 UI,追求 Mac + Linux 双端满分原生手感的「终极质量」路线,代价是多语言 + 两套 UI + 出效果最慢。**

本仓库是「多方案赛马」:同一款产品用 7 种技术栈各写一个实现来对比(Rust 方案A主力、**Mix 方案B(本目录)**、CPP、Flutter、Tauri、Golang、Electron)。本文件只描述 Mix 方案。

---

## 一、这套方案是什么

参照物是 **Ghostty**(Zig 内核 + Swift/AppKit + GTK4)。核心思想只有一句:

> **UI-agnostic 的共享内核只写一次,每个平台各写一套真正的原生 UI。**

- 窗格二叉树逻辑、VT 仿真这类「与界面无关」的核心,用 **Rust** 写一遍,导出 **C ABI**,两端共用。
- macOS 用 **Swift + AppKit** 做真正的 Cocoa 应用;Linux 用 **GTK4** 做真正的 GNOME 原生应用。
- 两端通过 C ABI 各写一层绑定去调内核。

这条路线是业界公认最高质量的做法(Ghostty 已经证明可行),但也是本仓库 7 个方案里**出效果最慢**的一个。它更适合作为「以后要做像素级原生打磨」的长期路线,而不是最快看到东西的起点。

---

## 二、技术栈

| 层 | 技术选型 | 说明 |
|---|---|---|
| 共享内核 | **Rust** | 窗格二叉树 + Split/Swap/Navigate/Detach 逻辑;VT 仿真 |
| 仿真复用 | **alacritty_terminal** | 内核内部复用其成熟的 VT 解析/网格,避免重造轮子 |
| 对外接口 | **C ABI + cbindgen** | 由 cbindgen 从 Rust 自动导出 C 头文件,作为唯一稳定边界 |
| macOS UI | **Swift + AppKit** | 原生窗口/菜单/标签;窗格用 NSView / NSSplitView |
| macOS 渲染 | **Metal + CoreText** | GPU 渲染 + 原生字形排版;或直接评估 SwiftTerm 作为现成终端视图 |
| Linux UI | **GTK4**(gtk4-rs 或 C) | 原生 GNOME 应用;窗格用 GtkPaned |
| Linux 渲染 | **OpenGL / Vulkan** | GPU 渲染 |
| 跨语言桥 | **Swift↔核 / GTK↔核** | 各端各写一层绑定,统一走 C ABI |
| CI | GitHub Actions | ubuntu / macos runner 各一套构建脚本 |

> Windows 端在本方案里是次要目标:C ABI 内核天然可跨平台,但 Windows 若也要原生手感需再写第三套 UI(WinUI/Win32),默认不在本方案的主力范围内。

---

## 三、优点

- **Mac 和 Linux 都是满分原生手感。** 这是方案A(单一 Rust GUI 框架)做不到的:每端都用各自平台最正统的 UI 工具箱,窗口行为、菜单、快捷键、无障碍、输入法、字体渲染全部是系统原生的。
- **内核只写一次。** 窗格树、split、swap、navigate、仿真这些最容易出 bug、最需要打磨的核心逻辑,两端共用同一份 Rust 代码,行为天然一致。
- **架构最「正统」。** UI-agnostic 内核 + 平台原生前端,是业界公认的最高质量终端架构,Ghostty 已经背书了这条路线的可行性。
- **边界清晰。** C ABI 是一道硬边界,内核和 UI 可以独立演进、独立测试。

---

## 四、缺点与风险(诚实版)

- **要写两套 UI,工作量约翻倍。** 每加一个窗格相关功能,Mac(AppKit)和 Linux(GTK4)都要各实现一遍,包括最麻烦的窗格视图层:Mac 用 NSView/NSSplitView、Linux 用 GtkPaned,分别对齐同一套内核语义。
- **至少三门语言。** Rust(内核)+ Swift(Mac)+ GTK 侧(Rust gtk4-rs 或 C)。团队要同时具备三条技术线的能力,招人和维护成本高。
- **FFI 边界易出 bug。** C ABI 两侧的内存所有权、生命周期、字符串编码、回调线程约束都要人肉维护,一旦搞错就是内存损坏/悬垂指针/崩溃这类难查的问题,而非编译期能拦住的错误。
- **出效果最慢。** 本仓库 7 个方案里,这是最晚能跑出「可演示的完整体验」的一个。M0~M3 都还在打地基,真正的窗格体验要到 M4/M5 才成型。
- **Mac 分发要钱要账号。** 免安全警告分发需要 Apple 开发者账号做签名 + 公证,否则用户会被 Gatekeeper 拦。
- **双端一致性是持续负担。** 两套原生 UI 天然会在细节上漂移(动画、拖拽手感、边距),需要长期对齐。

---

## 五、核心体验

三个用户最看重的点:①自由切分窗格 ②通过命令面板交换/移动窗格 ③命令面板本身。下面是这套体验背后的模型与键位。

### 5.1 窗格二叉树模型

复刻 Windows Terminal 的窗格模型(参照 `src/cascadia/TerminalApp/Pane.cpp`),这部分逻辑**只在 Rust 内核里实现一次**:

- **节点 = 叶子 或 分裂节点。**
  - **叶子**:一个真正的终端实例。
  - **分裂节点**:方向(横/竖)+ 比例(0~1)+ 两个子节点。
- **支持的操作**(全部在内核,经 C ABI 暴露给两端 UI):
  - `Split` 切分
  - `SwapPanes` 交换两个窗格
  - `DetachPane` / `AttachPane` 拆下/挂上窗格
  - `NavigateDirection` 方向切焦点
  - `Maximize` / `Restore` 最大化/还原

Mac 端把这棵树映射到 NSView/NSSplitView,Linux 端映射到 GtkPaned,但**树本身是同一份**。

### 5.2 命令面板

命令面板是 WT 设计哲学的核心:**高频操作给热键,低频但强力的操作(交换/移动窗格)收进命令面板。** 因此 `SwapPanes` 这类操作默认没有热键,只走命令面板——本方案严格沿用这一设计。

### 5.3 WT 默认键位表

沿用 WT `defaults.json` 的默认键位。macOS 上 `Ctrl` 一律换成 `Cmd`。

| 操作 | Windows/Linux | macOS |
|---|---|---|
| 命令面板 | `Ctrl+Shift+P` | `Cmd+Shift+P` |
| 向右拆分 | `Alt+Shift++` | `Alt+Shift++` |
| 向下拆分 | `Alt+Shift+-` | `Alt+Shift+-` |
| 调整窗格大小 | `Alt+Shift+方向键` | `Alt+Shift+方向键` |
| 切换焦点 | `Alt+方向键` | `Alt+方向键` |
| **交换窗格 SwapPane** | **无热键(仅命令面板)** | **无热键(仅命令面板)** |

---

## 六、构建与 CI

GitHub Actions 三 runner(ubuntu / macos / windows-latest)并行,本方案主力用前两个,各一套构建脚本:

- **macos runner**:用预装 Xcode 编 Swift UI + Rust 内核(cbindgen 生成头文件,Swift 桥接),产出 Cocoa 应用。免安全警告分发需 Apple 账号做签名 + 公证。
- **ubuntu runner**:先装 GTK4 开发库,再编 Rust 内核 + GTK4 前端(gtk4-rs 或 C),产出原生 Linux 应用。
- **共享步骤**:内核(Rust)在两端都要先构建为静态/动态库并生成 C 头文件,再交给各端 UI 链接。

> 因为是两套原生构建,CI 里几乎没有共用的打包步骤,内核是唯一的共享编译单元。

---

## 七、里程碑

| 里程碑 | 目标 |
|---|---|
| **M0** | 定义 C ABI 内核接口(Pane 树 + 仿真的对外函数签名) |
| **M1** | 内核复用 alacritty_terminal 跑通 VT 仿真 |
| **M2** | Mac 端 Swift + AppKit 单窗格终端 |
| **M3** | Linux 端 GTK4 单窗格终端 |
| **M4** | 两端各接窗格树 UI + 切分(NSSplitView / GtkPaned) |
| **M5** | 交换/移动窗格 + 命令面板 |
| **之后** | 逐平台像素级原生打磨 |

进度节奏提醒:M0~M3 都在打地基,完整窗格体验要到 M4/M5 才成型,这也是本方案「出效果最慢」的直接原因。

---

## 八、目录结构(占位)

```
Src_Mix/
├── ReadMe.md                # 本文件
├── core/                    # 【共享内核】Rust,唯一写一次的核心
│   ├── src/
│   │   ├── pane_tree.rs     # 窗格二叉树:Split/Swap/Navigate/Detach
│   │   ├── vt/              # VT 仿真(复用 alacritty_terminal)
│   │   └── ffi.rs           # C ABI 导出层
│   ├── cbindgen.toml        # 生成 C 头文件的配置
│   └── include/             # cbindgen 产出的 .h(供两端引用)
├── macos/                   # 【Mac 原生 UI】Swift + AppKit + Metal
│   ├── App/                 # 窗口/菜单/标签
│   ├── Panes/               # NSView / NSSplitView 映射窗格树
│   ├── Renderer/            # Metal + CoreText
│   ├── Bridge/              # Swift ↔ C ABI 绑定
│   └── CommandPalette/      # 命令面板
├── linux/                   # 【Linux 原生 UI】GTK4
│   ├── app/                 # GtkApplication
│   ├── panes/               # GtkPaned 映射窗格树
│   ├── renderer/            # OpenGL / Vulkan
│   ├── bridge/              # GTK ↔ C ABI 绑定(gtk4-rs 或 C)
│   └── command_palette/     # 命令面板
├── scripts/
│   ├── build-macos.sh       # macos runner 构建脚本
│   └── build-linux.sh       # ubuntu runner 构建脚本
└── .github/workflows/       # CI(可指向仓库根统一工作流)
```

> 以上为占位结构,随实现推进调整。核心原则不变:`core/` 只写一次,`macos/` 与 `linux/` 各写一套原生 UI。
