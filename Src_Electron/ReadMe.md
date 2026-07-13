# Win-Term-Mac · Electron 实现方案

> **一句话定位:对照基线(baseline)——生态最成熟、出花哨 UI 最快,但也是最重、最吃内存、最不原生的那个,恰恰是本项目想让用户逃离的东西。保留它,只为给其他六个方案提供一把「性能与体验的量尺」,不作为推荐落地方案。**

在「多方案赛马」里,Electron 扮演的是**反面参照物**。它证明「一套 Web 代码跑三端」有多容易,也顺便证明了这条捷径的代价。Hyper 终端就是 Electron 写的,以卡、以重、以吃内存闻名——用户之所以启动 Win-Term-Mac 这个项目,想要的正是「原生手感 + 高性能」,而这两点几乎是 Electron 的天然短板。所以本方案的价值不在于「赢」,而在于**当作基准线**:其他方案的启动速度、内存占用、重输出流畅度,都可以拿它来对比「好了多少」。

---

## 一、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 应用外壳 | **Electron**(Chromium + Node.js) | 一套 Web 技术栈打包成三端桌面应用 |
| 终端仿真 | **xterm.js** + `xterm-addon-webgl` | VS Code 集成终端同款,VT 序列解析 + 渲染现成 |
| 前端框架 | 任意(React / Svelte / vanilla) | 与终端解耦,本方案默认 vanilla + 轻量状态管理即可 |
| 伪终端 (PTY) | **node-pty** | Node 原生模块,跨平台伪终端,把真实 shell 接进来 |
| 窗格布局 | HTML/CSS(flex/grid)+ 拖拽分隔条 | 每个窗格挂一个独立的 xterm.js 实例 |
| 窗格树 | 前端 JS 二叉树 | 与 DOM 树天然映射,增删分裂节点即操作 DOM |
| 命令面板 | 可搜索的浮层(overlay) | 纯前端组件,叠在窗格之上 |
| 打包 | **electron-builder** | 各平台产出对应安装包(dmg / AppImage / nsis 等) |

**为什么是 xterm.js + node-pty:** 这是 Web 终端的黄金组合,VS Code 的集成终端就是这套。VT 仿真、光标、选区、滚动缓冲、WebGL 渲染,xterm.js 全部现成;node-pty 负责在各操作系统上开真实伪终端。二者相加,意味着「终端」这一最难啃的部分几乎零自研成本——这也是 Electron 方案唯一无可争议的优势。

---

## 二、优点

- **生态最成熟、轮子最多。** npm 上几乎任何 UI 需求都有现成包,浮层、拖拽、图标、主题、动画,不用自己造。
- **终端能力开箱即用。** xterm.js + node-pty 与 VS Code 同源,踩过的坑别人早踩完了,文档与社区问答海量。
- **出花哨 UI 最快。** CSS + DOM 做窗格布局、做命令面板浮层,是所有方案里迭代速度最快的,做原型、截图、演示极其顺手。
- **真·一套代码跨三端。** macOS / Linux / Windows 共用同一份渲染层代码,平台差异主要落在 node-pty 与打包环节。
- **调试体验好。** Chromium DevTools 直接可用,布局、性能、内存都能可视化排查。

---

## 三、缺点与风险(诚实版)

- **打包体积巨大:动辄几百 MB。** 每个安装包都捆绑了一整个 Chromium 运行时。相比原生方案几 MB 到几十 MB 的产物,这是数量级的差距。
- **内存占用高。** 一个 Chromium 渲染进程起步就吃掉几十到上百 MB;多窗格 = 多 xterm.js 实例,内存随窗格数线性膨胀。
- **性能最差,重输出易卡。** 面对 `yes`、大日志刷屏、`cat` 大文件这类高吞吐输出,DOM/Canvas/WebGL 渲染管线容易掉帧甚至卡死——这正是 Hyper 被诟病的通病。WebGL addon 能缓解但治不了本。
- **最不原生。** 无论怎么调,滚动惯性、字体渲染、窗口行为都带着一股「Web 味」,和 macOS 原生控件的手感有本质差距。
- **与项目初衷正面冲突。** 用户想要「轻快、原生」,Electron 给的是「重、Web」。这不是调优能弥合的方向性矛盾——**这也正是它作为「反面基线」的意义所在**。
- **node-pty 是原生模块。** 需要在对应平台的 runner 上编译,Electron 版本升级时可能需要 rebuild,存在 ABI 不匹配的维护负担。
- **安全面更大。** 引入 Node.js + 远程内容渲染能力,需谨慎处理 `contextIsolation` / `nodeIntegration`,否则易踩安全坑。

---

## 四、核心体验

用户最看重的三件事:**①自由切分窗格 ②通过命令面板交换/移动窗格 ③命令面板本身**。下面说明 Electron 方案如何实现,并对齐 Windows Terminal(WT)的既有事实。

### 4.1 窗格二叉树模型(JS/DOM 布局)

沿用 WT 的窗格模型(源自 `src/cascadia/TerminalApp/Pane.cpp`):窗格是一棵**二叉树**,每个节点要么是**叶子**(一个真实终端),要么是**分裂节点**(方向 横/竖 + 分割比例 0~1 + 两个子节点)。

在 Electron 里,这棵树直接映射到 DOM:

```
分裂节点 (split, 方向=vertical, 比例=0.5)
├── 叶子 A  →  <div class="pane"> 挂 xterm.js 实例 #A </div>
└── 分裂节点 (split, 方向=horizontal, 比例=0.6)
    ├── 叶子 B  →  <div class="pane"> 挂 xterm.js 实例 #B </div>
    └── 叶子 C  →  <div class="pane"> 挂 xterm.js 实例 #C </div>
```

- **分裂节点** → 一个 flex 容器,`flex-direction` 对应横/竖,两个子元素按 `flex-grow` = 比例 分配空间,中间夹一根**可拖拽的分隔条**(divider)。
- **叶子** → 一个挂载了 xterm.js 实例的容器 `<div>`,背后由一个 node-pty 进程喂数据。
- **操作即改树 + reflow DOM:**
  - `Split`(分裂):把一个叶子替换成分裂节点,叶子降级为其一个子节点,另一子节点是新建终端。
  - `SwapPanes`(交换):交换两个叶子在树上的挂载位置(命令面板触发,见 4.2)。
  - `DetachPane / AttachPane`(拆出/吸附):把子树从一处摘下,挂到另一处。
  - `NavigateDirection`(切焦点):按方向在树上找相邻叶子。
  - `Maximize / Restore`(最大化/还原):临时让某叶子独占容器,记住原树结构以便还原。
- **拖拽分隔条** = 实时修改对应分裂节点的比例值,并触发 xterm.js 的 `fit` 重排(reflow)。DOM 天然承载树结构,是 Electron 方案相对轻松的一环。

### 4.2 命令面板(Command Palette)

- 形态:一个**可搜索的浮层**,`Ctrl/Cmd+Shift+P` 唤起,叠在所有窗格之上,带模糊搜索输入框 + 命令列表。
- 承载「低频但强力」的操作。**尤其是 `swapPane`——它在 WT 里默认没有热键,只能走命令面板**,本方案严格保留这一设计:交换/移动窗格通过命令面板选择目标完成。
- 实现上就是一个前端组件:命令注册表 + 模糊匹配(如 fzf 风格)+ 键盘上下选择 + 回车执行。npm 生态里这类组件极多,是 Electron「出 UI 快」优势的直接体现。

### 4.3 WT 键位表(默认键位,macOS 上 Ctrl → Cmd)

设计哲学承袭 WT:**高频操作给热键,低频强力操作收进命令面板**。

| 功能 | Windows / Linux | macOS | 备注 |
| --- | --- | --- | --- |
| 打开命令面板 | `Ctrl+Shift+P` | `Cmd+Shift+P` | 一切低频操作的入口 |
| 向右拆分窗格 | `Alt+Shift++` | `Alt+Shift++` | 垂直分割 |
| 向下拆分窗格 | `Alt+Shift+-` | `Alt+Shift+-` | 水平分割 |
| 调整窗格大小 | `Alt+Shift+方向键` | `Alt+Shift+方向键` | 改分割比例 |
| 切换焦点窗格 | `Alt+方向键` | `Alt+方向键` | 树上找相邻叶子 |
| **交换窗格 (swapPane)** | **无热键** | **无热键** | **只能走命令面板** |
| 最大化 / 还原窗格 | (可按需绑定) | (可按需绑定) | Maximize/Restore |

> 说明:以上默认键位对齐 WT 的 `defaults.json`。`swapPane` 无默认热键是 WT 的有意设计,本方案照搬。

---

## 五、构建与 CI

- **打包工具:electron-builder**,在三个平台各自产出对应安装包(macOS `.dmg` / Linux `.AppImage`、`.deb` / Windows `.nsis`)。
- **GitHub Actions 三 runner 并行**:`macos-latest`、`ubuntu-latest`、`windows-latest` 各自构建各自平台的产物。
- **node-pty 是原生模块,必须在对应平台的原生 runner 上编译**——这正好是三 runner 并行方案能满足的前提:每个平台的原生二进制在其对应 runner 上就地编出,避免交叉编译的坑。Electron 版本升级后需重新 rebuild 原生模块。
- **macOS 分发免安全警告**:需要 Apple 开发者账号做**代码签名 + 公证(notarization)**。electron-builder 支持在 CI 里配置签名与公证流程(需注入证书与凭据)。
- 产物体积提醒:每个安装包都会包含完整 Chromium,几百 MB 属正常现象——这也是对照基线要如实展示给团队看的一项「成本数据」。

---

## 六、里程碑

| 阶段 | 目标 | 内容 |
| --- | --- | --- |
| **M0** | 开窗塞终端 | Electron 起一个窗口,塞进一个 xterm.js 实例,能显示 |
| **M1** | 接上真 shell | node-pty 开伪终端接系统 shell,把输出喂给 xterm.js,双向可交互 |
| **M2** | 窗格布局 | HTML/CSS(flex/grid)搭窗格布局 + 拖拽分隔条 + 快捷键切焦点 |
| **M3** | 交换/移动 + 命令面板 | 命令面板浮层落地,`swapPane` / 移动窗格走命令面板,二叉树增删改完善 |
| **M4** | 完善体验 | 标签页(Tabs)、主题、配置文件 |

---

## 七、目录结构(占位)

> 以下为规划占位,随实现推进再落地。

```
Src_Electron/
├── ReadMe.md              # 本文件
├── package.json           # 依赖与 electron-builder 配置(占位)
├── electron-builder.yml   # 三端打包 / 签名 / 公证配置(占位)
├── src/
│   ├── main/              # 主进程:窗口管理、node-pty 生命周期、IPC(占位)
│   │   ├── main.ts
│   │   └── pty.ts         # node-pty 封装,每窗格一个 PTY
│   ├── preload/           # 预加载脚本:contextBridge 暴露安全 API(占位)
│   │   └── preload.ts
│   └── renderer/          # 渲染进程:UI 全在这里(占位)
│       ├── index.html
│       ├── pane-tree.ts   # 窗格二叉树模型 + DOM reflow
│       ├── terminal.ts    # xterm.js 实例封装 + webgl addon
│       ├── command-palette.ts  # 命令面板浮层 + 模糊搜索
│       └── keymap.ts      # WT 键位表映射(Ctrl↔Cmd)
└── build/                 # 图标、公证脚本等打包资源(占位)
```

---

> **再次强调定位**:本方案是「多方案赛马」中的**对照基线**。它跑得起来、做得快、生态好,但重、吃内存、不原生——把它留在赛道上,是为了让其他方案每一分「更轻、更快、更原生」都有一个可量化的参照。不推荐作为最终落地方案。
