# Win-Term-Mac · Tauri 方案

> 一句话定位:**出效果最快的正经方案**——前端直接用 VS Code 同款的 xterm.js 画终端,后端用 Rust 管 PTY,系统 WebView 打包,包体比 Electron 小得多。专门用来「快速打样、验证窗格手感」,代价是网页渲染、非原生、性能中等。

在「多方案赛马」里,Tauri 是那匹**最先冲出效果**的马:窗格布局是 HTML/CSS、命令面板是 web 浮层、终端是现成的 xterm.js,几乎每一块都有极成熟的轮子。它的价值不在于最终形态多惊艳,而在于**用最短时间把「自由切分窗格 + 命令面板交换窗格」这套核心交互跑起来给人用**,为其他更重的原生方案(Rust / C++ / Flutter)当参照系和交互探针。

---

## 一、技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 外壳 | **Tauri**(Rust 后端 + 系统 WebView) | 无 Chromium,包体小、内存占用低;后端是原生 Rust |
| 前端终端 | **xterm.js** + `xterm-addon-webgl` | VT 仿真 + 渲染全帮你搞定,VS Code 同款;WebGL addon 提性能 |
| 前端框架 | 任意(vanilla / Svelte / React) | 建议 Svelte 或 vanilla,减少体积与心智负担 |
| 窗格布局 | HTML/CSS(flex/grid)+ 拖拽分隔条 | 每个窗格是一个 xterm.js 实例;分隔条类似 split.js |
| 命令面板 | 可搜索 web 浮层 | 就是个带模糊搜索的 overlay,几行搞定 |
| 后端 PTY | Rust **`portable-pty`** | 跨平台起 shell,通过 Tauri IPC/事件把数据流喂给前端 |
| 窗格树逻辑 | 前端 JS(推荐)或 Rust 后端 | DOM 树天然映射二叉树,放前端最省事 |
| IPC | Tauri `invoke`(命令)+ `emit/listen`(事件流) | 键入走 command,PTY 输出走 event 流回前端 |

---

## 二、优点

- **出效果最快**:核心三件套(终端 / 窗格 / 命令面板)在 web 世界都有极成熟的实现,M0→M3 推进极快。
- **xterm.js 极成熟**:连字(ligatures)、主题、选择、链接识别、性能 addon(WebGL/Canvas)全部现成,VT 仿真这块几乎零成本。
- **窗格 = HTML/CSS 布局**:flex/grid 天然表达嵌套分裂,拖拽调比例用现成方案即可,DOM 树直接就是窗格二叉树。
- **命令面板 = web 浮层**:模糊搜索 + 键盘导航是 web 的强项,几十行代码就能做出手感不错的 palette。
- **后端可复用 `portable-pty`**:与 Rust 主力方案共享同一套 PTY 认知,后端逻辑不浪费。
- **比 Electron 轻得多**:用系统 WebView,不打包 Chromium,安装包和内存都小一大截。

---

## 三、缺点与风险(诚实说)

- **网页渲染、非原生手感**——这恰恰是本产品用户想逃离的东西。滚动惯性、字体渲染、选区行为都带 web 味,再怎么调也难有原生终端那种「贴手」感。
- **重输出时 IPC 是性能瓶颈**:`yes`、`cat 大文件`、大量刷屏时,PTY→Rust→IPC→xterm.js 这条链路的序列化/跨进程开销会显现,可能掉帧或延迟。需要做批处理、节流、二进制传输等优化,但天花板就在那儿。
- **各平台 WebView 不一致**:macOS 用 WKWebView、Windows 用 WebView2、**Linux 用 WebKitGTK**。三套引擎行为、性能、渲染都有差异,尤其 **Linux 的 WebKitGTK 常有渲染 bug 和性能问题**,是最大不确定项。
- **桌面级细节偏 web 味**:原生菜单、无障碍(a11y)、输入法(IME)、系统级快捷键这些桌面深水区,在 WebView 里都要额外费劲对齐,且很难做到 100% 原生。
- **性能中等,是「验证机」不是「终态机」**:适合证明交互设计成立,不适合当作追求极致性能的最终交付。

---

## 四、核心体验

这是所有 7 个方案都要复刻的三样东西,也是评审的主战场。

### 4.1 窗格二叉树模型

对齐 Windows Terminal 的事实模型(`src/cascadia/TerminalApp/Pane.cpp`):一棵**二叉树**,节点要么是**叶子**(一个真终端 = 一个 xterm.js 实例),要么是**分裂节点**(方向 横/竖 + 比例 0~1 + 两个子节点)。

需要支持的操作:`Split`(拆分)、`SwapPanes`(交换)、`DetachPane/AttachPane`(拆离/吸附)、`NavigateDirection`(切焦点)、`Maximize/Restore`(最大化/还原)。

**Tauri/JS/DOM 布局思路**——DOM 结构天然就是这棵二叉树:

```
叶子  → <div class="pane"><div class="xterm-host"></div></div>
分裂  → <div class="split split--h">   // 横向分裂(左右)
          <子A/>
          <div class="divider"></div>   // 拖拽分隔条
          <子B/>
        </div>
        <div class="split split--v">…</div>  // 纵向分裂(上下)
```

数据结构(前端 JS 持有,DOM 只是它的渲染):

```js
// 叶子
{ id, type: 'leaf', termId }          // termId 对应后端一个 PTY
// 分裂节点
{ id, type: 'split', dir: 'h'|'v', ratio: 0.5, a: <node>, b: <node> }
```

- **Split**:把目标叶子替换成一个 `split` 节点,原叶子当 `a`,新建叶子当 `b`,同时请求后端 spawn 一个新 PTY。
- **调整比例**:拖 `divider` 改 `ratio`,用 CSS `flex-basis` / `grid-template` 把比例落到样式上。
- **SwapPanes**:在树上交换两个叶子的位置(或直接交换其 `termId`),重渲染即可——**这是命令面板的招牌动作**。
- **Navigate/Maximize**:切焦点 = 按几何关系找相邻叶子并 `focus`;最大化 = 临时把某叶子提到全区域(记住原树,还原时还回去)。

用 CSS `flex`(单层左右/上下)或 `grid`,配合递归组件渲染整棵树即可;比例变化只改样式、不重建 DOM,交换只挪节点、不销毁 PTY。

### 4.2 命令面板

`Ctrl/Cmd+Shift+P` 唤起的可搜索浮层,是本产品的灵魂——**低频但强力的操作(尤其 swapPane)收进这里**。实现上就是一个 overlay `<div>` + 输入框 + 模糊搜索过滤命令列表 + 上下键选中 + 回车执行。命令项形如 `{ id, title, keywords, run() }`,`run` 里调用 4.1 的树操作。web 做这个几乎零门槛,还能顺手做出高亮匹配、最近使用排序等体验。

### 4.3 WT 键位表(默认键位)

沿用 Windows Terminal 的设计哲学:**高频操作给热键,低频强力操作收进命令面板**。macOS 上把 `Ctrl` 换成 `Cmd`。

| 操作 | Windows/Linux | macOS | 备注 |
| --- | --- | --- | --- |
| 命令面板 | `Ctrl+Shift+P` | `Cmd+Shift+P` | 灵魂入口 |
| 向右拆分 | `Alt+Shift++` | `Alt+Shift++` | Split(竖直分隔线) |
| 向下拆分 | `Alt+Shift+-` | `Alt+Shift+-` | Split(水平分隔线) |
| 调整窗格大小 | `Alt+Shift+方向键` | `Alt+Shift+方向键` | 改分裂比例 |
| 切换焦点 | `Alt+方向键` | `Alt+方向键` | NavigateDirection |
| **交换窗格 SwapPanes** | **无默认热键** | **无默认热键** | **只走命令面板** |
| 最大化/还原窗格 | (可自定义) | (可自定义) | Maximize/Restore |

> 注意:WT 的 `swapPane` **默认没有热键**,只能通过命令面板触发——这正是「命令面板交换窗格」成为核心卖点的原因,本方案必须如实还原这一点。

---

## 五、构建与 CI

- **打包**:用官方 **`tauri-apps/tauri-action`**,在 GitHub Actions 三 runner(macOS / Windows / Linux)**并行**构建,各自产出安装包(`.dmg` / `.msi`·`.exe` / `.deb`·`.AppImage`)。
- **Linux 依赖**:CI 里需要先装 **`webkit2gtk`**(以及 `libgtk`、`libayatana-appindicator` 等)相关系统依赖,否则构建失败——这是 Tauri on Linux 的固定动作。
- **Mac 分发免警告**:需要 **Apple 开发者账号做签名 + 公证(notarization)**,否则用户首次打开会被 Gatekeeper 拦。签名证书与公证凭据以 CI secrets 注入。
- 前端构建产物在打包前由前端工具链(Vite 等)先编译好,再交给 Tauri 嵌入。

---

## 六、里程碑

| 里程碑 | 目标 | 交付物 |
| --- | --- | --- |
| **M0** | `tauri init` 开窗,前端塞进一个 xterm.js | 能开窗、能看到一个终端 UI(未接 PTY) |
| **M1** | Rust `portable-pty` 接一个真 shell,IPC 把输出喂给 xterm.js | 一个能用的真终端(单窗格) |
| **M2** | HTML/CSS 窗格布局 + 拖拽分隔条 + 快捷键切焦点 | 能自由横竖切分、拖比例、Alt+方向键切焦点 |
| **M3** | 交换/移动窗格 + 命令面板浮层 | **核心卖点跑通**:命令面板里 SwapPanes |
| **M4** | 标签页 + 主题 + 配置 | 更完整的日常可用形态 |

---

## 七、目录结构(占位)

```
Src_Tauri/
├── ReadMe.md                 # 本文件
├── src-tauri/                # Rust 后端(Tauri)
│   ├── Cargo.toml
│   ├── tauri.conf.json       # 窗口/权限/打包配置
│   └── src/
│       ├── main.rs           # 入口、注册 IPC command
│       ├── pty.rs            # portable-pty:spawn / 读写 / 事件流
│       └── ipc.rs           # invoke 命令 + emit 输出流
├── src/                      # 前端
│   ├── index.html
│   ├── main.(ts|js)         # 应用入口
│   ├── term/                # xterm.js 实例封装、WebGL addon、主题
│   ├── panes/               # 窗格二叉树:数据结构 + 递归渲染 + 分隔条拖拽
│   ├── palette/             # 命令面板浮层(搜索 / 快捷键 / 命令注册)
│   └── keymap/              # WT 默认键位 + macOS Cmd 映射
├── package.json             # 前端依赖与构建脚本
└── (CI 见仓库根 .github/workflows,使用 tauri-action)
```

> 注:以上为规划占位结构,随实现推进调整。
