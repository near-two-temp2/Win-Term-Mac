# Win-Term-Mac · C++ 方案

> **角色定位:性能天花板最高、且能直接复用 Windows Terminal C++ 内核的「重武器」方案。**
> Kitty、Windows Terminal 本身都是 C/C++ 写的,可行性早已被证明。代价是轮子少、要手拼、开发慢——它是能砸穿性能上限的重锤,不是抢跑冲线的短跑鞋。

本目录是「多方案赛马」中的 **CPP** 实现。同一款产品(把 Windows Terminal 最出彩的上层体验——自由切分窗格、命令面板交换/移动窗格、命令面板本身——复刻到 macOS + Linux + Windows)用 7 种技术栈各写一遍做对比:Rust(A 主力)、Mix(B)、**CPP(本方案)**、Flutter、Tauri、Golang、Electron。

---

## 一、技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| UI 框架 | **Qt 6**(QWidget / QML) | 跨平台近原生窗口、菜单、事件循环开箱即用;或退一步走 **Dear ImGui / 自绘** 换取更强控制 |
| VT/ANSI 仿真 | **libvterm**(小型 C 库,Neovim 在用)或移植本仓库 `terminal/src` 里 WT 的 **TerminalCore / buffer / parser** | 后者是纯 C++、无 UI 依赖,是 WT 里最可移植的部分 |
| 文字 / 字形 | Qt 自带文本,或 **HarfBuzz**(shaping)+ **FreeType**(栅格化)+ 自建 GPU 字形图集 | 追求极致时走后者 |
| GPU | Qt RHI / OpenGL / **Metal-cpp** / Vulkan | 依平台取舍 |
| PTY | Unix:`forkpty(3)`;Windows:**ConPTY** | 平台各写一套后端 |
| 窗格树 | 自写 C++ 二叉树类 | mirror WT 的 `Pane`:`_firstChild` / `_secondChild` / `_splitState` / `_desiredSplitPosition` |
| 构建 | CMake + vcpkg / aqtinstall | Mac 上可产 universal(lipo) |

---

## 二、优点

- **极致性能与内存控制**:C++ 直控内存布局、零成本抽象、可手写 SIMD/GPU 路径,帧延迟与内存占用可做到最优,这是七方案里的性能上限。
- **可直接移植/参考 WT 成熟 C++ 内核**:本项目根目录 `terminal/` 就是克隆的 WT 源码。TerminalCore、buffer、parser 都是经年打磨过的纯 C++,能省掉「从零重写 VT 仿真」这块最脏最累的活。
- **Qt 提供跨平台近原生窗口/菜单**:三大平台一套代码,窗口、菜单栏、快捷键、HiDPI、输入法都有成熟支持,不用逐平台手搓。
- **生态老牌稳定**:libvterm、HarfBuzz、FreeType、Qt 全是跑了十几年的工业级库,踩坑资料充足。

---

## 三、缺点与风险(诚实版)

- **无内存安全**:没有 Rust 的借用检查兜底,越界、悬垂指针、data race、use-after-free 全靠人和工具(ASan/UBSan/Valgrind)防,长期是最大隐患。
- **轮子少、开发最慢之一**:缺少 Rust「装上即用」的成套 crate。VT 核、文字渲染、PTY、字形图集大多要手工拼装和调试,这是七方案里开发速度最慢的梯队。
- **Qt 授权要当心**:Qt 是 LGPL/商业双授权。动态链接 LGPL 版一般没问题,但**静态链接或商用分发**需要认真过一遍合规(本项目不谈开源协议,但工程上必须留意)。
- **WT 内核偏 Windows 风味**:WT 的渲染栈原生绑 DirectWrite/Direct2D,移植到 Mac(Metal)/Linux 有真实摩擦;而 **C++/WinRT 那部分(UI、Pane.cpp 的 WinRT 绑定)基本不可移植**,只能参考其树结构逻辑,重写一遍。
- **手拼栈的整合成本**:libvterm + HarfBuzz + FreeType + 自绘 GPU 图集之间的接缝(光标、宽字符、ligature、emoji、行高)需要大量自己调,没有一个统一框架替你兜住。

---

## 四、核心体验

### 4.1 窗格二叉树模型

沿用 WT 的模型(见 `terminal/src/cascadia/TerminalApp/Pane.cpp`):每个节点要么是**叶子**(一个真终端),要么是**分裂节点**(一个方向 + 一个比例 + 两个子节点)。C++ 类结构参考:

```cpp
enum class SplitDirection { Horizontal, Vertical };

class Pane {
public:
    // ---- 叶子:承载真正的终端会话 ----
    std::shared_ptr<TerminalSession> _terminal;   // 仅叶子非空

    // ---- 分裂节点:两个子 + 方向 + 比例 ----
    std::shared_ptr<Pane> _firstChild;            // 上 / 左
    std::shared_ptr<Pane> _secondChild;           // 下 / 右
    SplitDirection        _splitState;            // 横 / 竖
    float                 _desiredSplitPosition;  // 0.0 ~ 1.0

    bool isLeaf() const { return _terminal != nullptr; }

    // 核心操作(mirror WT)
    std::shared_ptr<Pane> Split(SplitDirection dir, float ratio,
                                std::shared_ptr<TerminalSession> newTerm);
    void  SwapPanes(std::shared_ptr<Pane> a, std::shared_ptr<Pane> b); // 只交换叶子内容/子树
    std::shared_ptr<Pane> DetachPane(std::shared_ptr<Pane> target);    // 摘出子树
    void  AttachPane(std::shared_ptr<Pane> p, SplitDirection dir);     // 挂回
    Pane* NavigateDirection(Direction dir);                            // 方向切焦点
    void  Maximize();  void  Restore();                                // 最大化/还原
    void  ResizeChild(float delta);                                    // 调整比例
};
```

渲染侧:叶子对应一块 GPU 绘制的终端网格;分裂节点按 `_splitState` + `_desiredSplitPosition` 把父矩形切两半递归下发。分割条既可用 `QSplitter`(省事),也可自绘拖拽条(更贴 WT 手感)。

### 4.2 命令面板(Command Palette)

用户最看重的三件事——①自由切分窗格 ②通过命令面板交换/移动窗格 ③命令面板本身——都围绕它。设计哲学:**高频操作给热键,低频强力操作(尤其 swapPane)收进命令面板**。面板 = 一个模糊搜索的动作列表,把上面 `Pane` 的每个操作注册成一条可搜索命令。

### 4.3 WT 默认键位表(macOS 上 `Ctrl` 换 `Cmd`)

| 操作 | 默认热键 | 备注 |
| --- | --- | --- |
| 打开命令面板 | `Ctrl+Shift+P` | mac:`Cmd+Shift+P` |
| 向右拆分 | `Alt+Shift++` | |
| 向下拆分 | `Alt+Shift+-` | |
| 调整窗格大小 | `Alt+Shift+方向键` | |
| 切换焦点 | `Alt+方向键` | |
| 最大化/还原窗格 | (走命令面板/菜单) | |
| **交换窗格 swapPane** | **无默认热键** | **只走命令面板** |

---

## 五、构建与 CI

- **构建系统**:CMake。依赖用 **vcpkg**(libvterm/HarfBuzz/FreeType 等)或 **aqtinstall**(Qt)拉取。
- **GitHub Actions 三 runner 并行**:macOS / Linux / Windows 各一,runner 自带 C++ 编译器(MSVC / clang / gcc)。
- **平台差异**:
  - Windows PTY 走 ConPTY,Unix 走 `forkpty`,编译期分流。
  - macOS 产 **universal 二进制**(arm64 + x86_64,`lipo` 合并)。
  - **Mac 免警告分发需 Apple 账号签名 + 公证**(codesign + notarytool)。
- **内存卫生**:CI 里挂 ASan/UBSan 跑一遍冒烟测试,弥补 C++ 无内存安全的短板。

---

## 六、里程碑

| 阶段 | 目标 |
| --- | --- |
| **M0** | Qt 开窗:三平台各能弹出一个空窗口 |
| **M1** | 接 libvterm(或移植 WT 核)+ `forkpty`/ConPTY,跑起单窗格 shell |
| **M2** | `Pane` 二叉树类 + `QSplitter`/自绘分割 + 调大小 + `Alt+方向` 切焦点 |
| **M3** | 交换/移动窗格 + 命令面板(swapPane 走面板) |
| **M4** | 标签页 + 主题 + 配置文件 |

---

## 七、目录结构(占位)

```
Src_CPP/
├── ReadMe.md              # 本文件
├── CMakeLists.txt         # 顶层构建
├── vcpkg.json             # 依赖清单(占位)
├── src/
│   ├── main.cpp           # 入口 + Qt 开窗
│   ├── app/               # 应用/窗口/标签页
│   ├── pane/              # Pane 二叉树 + 分割/导航/交换
│   ├── term/              # VT 仿真:libvterm 封装 或 移植的 WT 核
│   ├── pty/               # forkpty(Unix) / ConPTY(Windows) 后端
│   ├── render/            # GPU 渲染 + 字形图集(HarfBuzz/FreeType)
│   └── palette/           # 命令面板 + 键位注册
├── assets/                # 字体/主题/图标(占位)
└── .github/workflows/     # 三 runner CI(占位)
```

> 说明:以上为规划占位,随实现推进补齐。本方案的价值在于「把性能做到极限、且尽量复用 `terminal/` 里 WT 的 C++ 内核」——慢是它的代价,快是它的回报。
