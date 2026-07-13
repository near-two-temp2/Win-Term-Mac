# Win-Term-Mac · 方案A:Rust 实现(主力推荐 / 首选)

> 一句话定位:**赛马里的主力推荐方案**——用纯 Rust 单语言、自绘 GPU UI,复刻 Windows Terminal 最出彩的上层体验(自由切分窗格 / 命令面板交换移动窗格 / 命令面板本身),是七个方案里唯一同时满足「原生手感 + 极高性能 + 一套码跨平台 + 开发还挺快」的选项。

本方案是整个多方案仓库的**首选押注**。其余六个方案(Mix / CPP / Flutter / Tauri / Golang / Electron)与本方案并行开发、横向对比,各自位于 `Src_ALL/Src_XXX/`。

---

## 一、它在赛马里的角色

| 维度 | Rust 方案的取舍 |
| --- | --- |
| 语言 | 纯 Rust 单语言,**无 FFI、无 cgo、无跨语言胶水** |
| UI 路线 | 自绘 UI(与 WezTerm / Rio 同款架构),不套系统控件 |
| 原生感 | ~90%(核心区域自绘做到像素级可控,外围 chrome 需补特化) |
| 性能 | 极高(GPU 直绘 + 零 GC + Rust 零成本抽象) |
| 跨平台 | 一套代码同时出 macOS / Linux / Windows |
| 开发体验 | 在 Windows 上即可 `cargo run` 当场看效果,三大深坑均有现成 crate |

设计取向就一句:**该自己写的(窗格树、命令面板、交互手感)自己写,不该重造的轮子(VT 仿真、PTY、文字整形)全部直接用成熟 crate**。

---

## 二、技术栈

全部是 Rust crate,零跨语言依赖:

| 关注点 | 选型 | 说明 |
| --- | --- | --- |
| 窗口 + 输入事件 | **winit** | 跨平台窗口/键鼠/IME 事件循环 |
| GPU 底座 | **wgpu** | Mac 走 Metal、Linux 走 Vulkan、Windows 走 D3D12,后端对开发者透明 |
| 文字渲染 | **glyphon + cosmic-text** | GPU 字形图集 + 字体回退 / 连字 / emoji shaping,拿来即用,省掉最耗时的一块 |
| VT / ANSI 仿真内核 | **alacritty_terminal** | 成熟的 VT100/xterm 状态机,直接用,不手写终端仿真 |
| 跨平台 PTY | **portable-pty** | WezTerm 抽出的 crate,一套 API 搞定三平台伪终端 |
| 窗格树 / 切分 / 交换 / 导航 | **自己写** | Rust 递归 enum 二叉树,照搬 WT 的 `Pane` 模型 |

> 三大历史深坑——终端仿真、PTY、文字整形——在 Rust 生态里都有直接可用的成熟 crate,这是本方案「开发还挺快」的底气。

---

## 三、优点

- **纯一门语言**:从窗口、渲染到业务逻辑全是 Rust,没有 FFI/cgo 边界,调试、重构、CI 都简单。
- **原生感 ~90%**:核心终端与窗格区域自绘,手感、动画、分隔条拖拽全部可控到帧。
- **极高性能**:GPU 直绘、无 GC、无运行时开销;高频滚动/重绘场景对本方案最友好。
- **一套码全平台**:同一份代码在三大 runner 上出包,不需要为每个平台分叉 UI 逻辑。
- **Windows 上就能开发**:`cargo run` 即可在本机看到跨平台效果,反馈闭环短。
- **深坑全有现成件**:仿真(alacritty_terminal)、PTY(portable-pty)、文字(glyphon+cosmic-text)三块最烧时间的地方直接站在巨人肩上。

---

## 四、缺点与风险(诚实版)

- **外围 chrome 不是 100% 原生**:菜单栏、窗口装饰、无障碍(accessibility)、IME 在自绘架构下不是系统原生控件,尤其 **macOS 需要单独补原生特化**(原生菜单、原生标题栏行为、VoiceOver 支持等),这部分是纯手工活。
- **窗格的绘制与交互全靠自己实现**:切分、拖拽分隔条、焦点导航、交换动画都得手写——不过这**正是本项目的核心价值所在**,而非纯负担。
- **cosmic-text 有吞吐上限**:绝大多数场景够用;但在极限文字吞吐(海量刷屏)下若成为瓶颈,可能需要自定义渲染管线兜底,属于后期优化风险。
- **自绘 UI 的通病**:平台约定俗成的小细节(右键菜单风格、系统级快捷键、拖放、深浅色跟随)需要逐项对齐,长尾打磨成本不低。
- **无障碍是硬骨头**:自绘意味着屏幕阅读器无法自动读到内容,若要做到位需接入各平台 accessibility API,工作量单列。

---

## 五、要复刻的核心体验

用户最看重三件事:**① 自由切分窗格 ② 通过命令面板交换/移动窗格 ③ 命令面板本身**。下面是复刻蓝本。

### 5.1 窗格模型:二叉树(照搬 WT)

事实核验:Windows Terminal 的窗格模型是一棵二叉树(源码 `src/cascadia/TerminalApp/Pane.cpp`)。每个节点要么是**叶子**(承载一个真实终端),要么是**内部分裂节点**(方向 横/竖 + 分割比例 0~1 + 两个子节点)。核心操作有:`Split`、`SwapPanes`、`DetachPane` / `AttachPane`、`NavigateDirection`(按几何相邻关系找焦点)、`Maximize` / `Restore`。

Rust 里用递归(indirect)enum 直接表达这棵树:

```rust
/// 分割方向
enum SplitDir {
    Vertical,   // 左 | 右
    Horizontal, // 上 / 下
}

/// 窗格树节点:叶子 或 内部分裂节点
enum Pane {
    /// 叶子:一个真实终端(仿真状态 + PTY)
    Leaf {
        id: PaneId,
        terminal: TerminalHandle, // alacritty_terminal 实例
        pty: PtyHandle,           // portable-pty 会话
    },
    /// 内部节点:一次分裂,两个子树
    Split {
        dir: SplitDir,
        ratio: f32,               // 0.0 ~ 1.0,分隔条位置
        first: Box<Pane>,         // 左 / 上
        second: Box<Pane>,        // 右 / 下
    },
}

impl Pane {
    /// 在焦点叶子处一分为二
    fn split(&mut self, target: PaneId, dir: SplitDir) { /* ... */ }
    /// 交换两个窗格(命令面板触发)
    fn swap(&mut self, a: PaneId, b: PaneId) { /* ... */ }
    /// 摘下 / 挂上一个窗格(移动)
    fn detach(&mut self, target: PaneId) -> Pane { /* ... */ }
    fn attach(&mut self, sub: Pane, at: PaneId, dir: SplitDir) { /* ... */ }
    /// 按几何相邻找焦点
    fn navigate(&self, from: PaneId, to: Direction) -> Option<PaneId> { /* ... */ }
    /// 最大化 / 还原
    fn maximize(&mut self, target: PaneId) { /* ... */ }
}
```

布局时递归下降:对 `Split` 节点按 `dir` 和 `ratio` 把父矩形切成两块分给子节点,叶子拿到最终像素矩形后交给渲染层画终端网格。分隔条拖拽 = 改对应 `Split` 的 `ratio` 并重排。

### 5.2 命令面板(Command Palette)

- 快捷键 `Cmd/Ctrl + Shift + P` 唤起。
- 一个模糊搜索列表,聚合所有可执行动作(切分、交换、移动、导航、最大化、新标签、切主题……)。
- **低频但强力的操作(交换窗格 / 移动窗格)优先走命令面板**——这与 WT 的设计哲学一致:高频操作给热键,低频强力操作收进面板,避免热键爆炸。
- 复刻要点:即时模糊匹配、键盘全程可达、动作可带参数(如「向右交换」)、可扩展的动作注册表。

### 5.3 WT 键位表(核实自 defaults.json)

| 操作 | Windows / Linux | macOS | 备注 |
| --- | --- | --- | --- |
| 命令面板 | `Ctrl+Shift+P` | `Cmd+Shift+P` | 唤起面板 |
| 向右拆分窗格 | `Alt+Shift++` | `Alt+Shift++` | 默认复制当前会话 |
| 向下拆分窗格 | `Alt+Shift+-` | `Alt+Shift+-` | 默认复制当前会话 |
| 调整窗格大小 | `Alt+Shift+方向键` | `Alt+Shift+方向键` | 移动分隔条 |
| 切换焦点 | `Alt+方向键` | `Alt+方向键` | 按几何相邻导航 |
| **交换窗格 swapPane** | **默认无热键** | **默认无热键** | **只通过命令面板触发** |

设计哲学落地:macOS 上把 `Ctrl` 映射为 `Cmd`;`swapPane` 刻意不给默认热键,强制走命令面板,正好凸显「命令面板交换窗格」这一核心卖点。

---

## 六、构建与 CI

### 本地开发
```bash
# 三大平台通用,Windows 上也能直接跑起来看跨平台效果
cargo run
cargo build --release
```
各平台 runner 自带 `rustup`,**近零环境配置**。

### GitHub Actions(三 runner 并行出包)
在 `ubuntu-latest` / `macos-latest` / `windows-latest` 上并行构建:

- **Linux**:`cargo build --release`,wgpu 走 Vulkan;打包为可执行文件 / AppImage。
- **Windows**:`cargo build --release`,wgpu 走 D3D12。
- **macOS**:分别编 `aarch64-apple-darwin` 和 `x86_64-apple-darwin` 两个 target,再用 `lipo` 合成 **universal 二进制**,装进 `.app`。

```yaml
# macOS universal 二进制(示意)
- run: |
    rustup target add aarch64-apple-darwin x86_64-apple-darwin
    cargo build --release --target aarch64-apple-darwin
    cargo build --release --target x86_64-apple-darwin
    lipo -create -output win-term-mac \
      target/aarch64-apple-darwin/release/win-term-mac \
      target/x86_64-apple-darwin/release/win-term-mac
```

### macOS 分发签名(注意成本)
Mac 上想让用户下载后**不弹安全警告**,需要 Apple 开发者账号(**$99/年**)对 `.app` 做**签名 + 公证(notarization)**。没有账号也能自用,但分发体验会被 Gatekeeper 拦。

---

## 七、里程碑 M0 → M4

| 里程碑 | 目标 | 预估 |
| --- | --- | --- |
| **M0** | winit + wgpu 开一个窗口,glyphon 渲出一行字 | ~半天 |
| **M1** | 接入 alacritty_terminal + portable-pty,跑起一个真实 shell | 1–2 天 |
| **M2** | Pane 二叉树 + 切分 + 拖拽分隔条调大小 + `Alt+方向键` 切焦点 | — |
| **M3** | 交换 / 移动窗格 + `Cmd/Ctrl+Shift+P` 命令面板(核心卖点闭环) | — |
| **M4** | 标签页 + 主题 + 配置文件 + 完整 WT 键位对齐 | — |

M0/M1 快速见效验证技术栈可行性;M2/M3 是本项目真正的价值区(窗格 + 命令面板);M4 补齐日用完整度。

---

## 八、目录结构(占位)

```
Src_Rust/
├─ ReadMe.md              # 本文件
├─ Cargo.toml             # crate 依赖:winit / wgpu / glyphon / cosmic-text /
│                         #             alacritty_terminal / portable-pty
├─ src/
│  ├─ main.rs             # 入口:事件循环 + 应用状态
│  ├─ app.rs              # 顶层 App:窗口、标签、全局状态
│  ├─ render/             # wgpu + glyphon 渲染层
│  │  ├─ mod.rs
│  │  ├─ gpu.rs           # wgpu 设备 / surface / 帧循环
│  │  └─ text.rs          # glyphon + cosmic-text 文字整形与图集
│  ├─ pane/               # 窗格二叉树(核心自研)
│  │  ├─ tree.rs          # Pane enum:split / swap / detach / attach / navigate
│  │  └─ layout.rs        # 递归布局:ratio → 像素矩形 + 分隔条拖拽
│  ├─ terminal/           # 终端会话
│  │  ├─ emu.rs           # alacritty_terminal 封装
│  │  └─ pty.rs           # portable-pty 封装
│  ├─ command_palette/    # 命令面板(核心自研)
│  │  ├─ palette.rs       # 模糊搜索 UI
│  │  └─ actions.rs       # 动作注册表:切分 / 交换 / 移动 / 导航 ...
│  ├─ input/              # 键位映射(含 macOS Ctrl→Cmd)
│  │  └─ keymap.rs
│  └─ config/             # 配置与主题
│     └─ mod.rs
├─ assets/                # 字体 / 图标 / 默认主题
└─ .github/workflows/     # 三 runner 并行 CI + macOS universal 打包
   └─ build.yml
```
