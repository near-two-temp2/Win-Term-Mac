# Win-Term-Mac · Golang 实现方案

> 一句话定位:**实验性 / 对照方案**。用 Go 复刻 Windows Terminal 的上层体验,验证「简单语言 + 好并发」能否扛住终端这类重渲染负载。角色是「赛马」里的对照组——赌它多半更慢或被迫非原生,但要用它照出主力方案的价值。

本目录是「多方案赛马」仓库的 7 个实现之一。同一款产品(把 Windows Terminal 最出彩的上层体验——自由切分窗格、命令面板交换/移动窗格、命令面板本身——复刻到 macOS + Linux + Windows),用 Rust、Mix、C++、Flutter、Tauri、Golang、Electron 各写一遍做横向对比。本方案是 **Golang**。

---

## 一、技术栈

Go 有两条差异很大的路线,README 全程会并列比较,不藏着掖着。

| 维度 | 路线 A(纯 Go 原生 GUI) | 路线 B(Go 后端 + Web 前端) |
| --- | --- | --- |
| 语言 | Go 1.22+ | Go 1.22+ |
| GUI / 渲染 | Gio(`gioui.org`,immediate-mode GPU、纯 Go)或 Fyne(OpenGL) | Wails(Go + 系统 WebView)+ 前端 `xterm.js` |
| VT 仿真核 | `vt10x` / `hinshun/vt`,或 `libvterm` 的 cgo 绑定 | `xterm.js`(前端自带) |
| PTY | `creack/pty`(Unix 好用;Windows 走 ConPTY) | `creack/pty` |
| 字形 / 字体 | 多半要自己造字形图集(Gio/Fyne 文本能力一般) | 交给浏览器排版引擎 |
| 打包 | `go build`(纯 Go 可交叉编译);cgo 时须在原生 runner 上构建 | Wails CLI |
| 原生程度 | 名义原生,但渲染质量存疑 | **非原生**(本质是 web,和 Tauri 重叠) |
| 参照物 | 无严肃纯 Go GPU 终端先例 | Wave Terminal(Go + Web) |

**默认主推路线 A**(才符合「原生手感」的产品目标);路线 B 作为「最快出效果但会打脸」的保底备选。

---

## 二、优点

- **语言简单、上手门槛低**:团队新人能很快读懂、改动窗格树逻辑,适合当对照基准。
- **并发模型好**:每个 PTY / 终端会话一条 goroutine + channel,读写循环写起来干净自然,天然契合「多窗格多会话」。
- **编译快、工具链省心**:`go build` 秒级迭代;各 CI runner 自带 Go 工具链,零额外安装。
- **`creack/pty` 跨 Unix 好用**:macOS / Linux 的 PTY 处理成熟稳定,是 Go 在本项目里少数的强项。
- **纯 Go 可交叉编译**:只要不碰 cgo,一台机器就能出三平台产物。

---

## 三、缺点与风险(诚实版)

- **GPU / 原生 GUI / 文字渲染生态是明显短板**:这恰恰是本项目的瓶颈(GPU 文字渲染 + VT 仿真),而 Go 在这两块最弱。
- **没有成套轮子**:Rust 有 `alacritty_terminal`(VT 核)+ `glyphon`(GPU 文字)这种现成组合;Go 这边最耗时的部分要么自己造,要么退回 web。
- **好东西大多要 cgo**:靠谱的 VT 核(`libvterm`)和文字渲染常需 cgo 绑定,而 cgo 会让跨平台构建更脆(交叉编译失效、依赖系统库、CI 更麻烦)。
- **无严肃纯 Go GPU 终端先例**:这是很不好的信号——如果这条路真行得通,业界早该有人走出来了。
- **路线 B 等于变相 web 方案**:能最快出效果,但和 Tauri / Electron 高度重叠,背离「原生」初衷,拿它交差等于承认 Go 原生这条路没走通。
- **整体结论**:本方案多半 **比 Rust 慢,或被迫非原生**。它的价值在于「对照」,不在于「获胜」。

---

## 四、核心体验

### 4.1 窗格二叉树模型(Go struct)

与 WT 的 `Pane.cpp` 对齐:每个节点要么是**叶子**(承载一个真实终端会话),要么是**分裂节点**(方向 + 比例 + 两个子节点)。split / swap / navigate 全部写成对树的**纯函数**,与渲染、PTY 解耦,方便测试和对照。

```go
package pane

// Direction 分裂方向
type Direction int

const (
    Horizontal Direction = iota // 左右分(竖直分隔条)
    Vertical                    // 上下分(水平分隔条)
)

// Node 是二叉树节点:Leaf 与 Split 二选一(互斥)。
// Leaf != nil 表示叶子;否则为分裂节点。
type Node struct {
    // ---- 叶子态 ----
    Leaf *Terminal // 非空即为叶子;承载一个真实终端会话

    // ---- 分裂态 ----
    Dir   Direction
    Ratio float64 // 0~1,第一个子节点占比
    First  *Node
    Second *Node
}

// Terminal 一个真实终端会话(PTY + VT 核)
type Terminal struct {
    ID    string
    Title string
    // pty *os.File / vt 状态等由渲染层持有
}

func (n *Node) IsLeaf() bool { return n.Leaf != nil }

// Split 把 target 叶子替换为一个分裂节点,原叶子成为 First,新叶子成为 Second。
// 返回新树根(纯函数,不修改入参子树内容)。
func Split(root, target *Node, dir Direction, ratio float64, fresh *Terminal) *Node

// SwapPanes 交换两个叶子的内容(树结构不变)。WT 里默认只走命令面板。
func SwapPanes(root, a, b *Node) *Node

// NavigateDirection 从当前焦点叶子,按方向找到相邻叶子。
func NavigateDirection(root, focus *Node, dir NavDir) *Node

// DetachPane / AttachPane 移动窗格用:摘下一棵子树,再挂到别处。
func DetachPane(root, target *Node) (newRoot *Node, detached *Node)
func AttachPane(root, at *Node, sub *Node, dir Direction, ratio float64) *Node
```

设计要点:结构层(纯函数、可单测)和「渲染 + PTY goroutine」层严格分开。窗格操作只动树;树变了再由渲染层做增量重绘、分隔条命中测试和焦点高亮。

### 4.2 命令面板

产品三大卖点之一,也是 WT 设计哲学的核心:**高频操作给热键,低频强力操作收进命令面板**。典型如 `swapPane` 默认无热键,只能从命令面板触发。

- 一个可模糊搜索的命令列表(拆分、交换、移动、切标签、改主题……),回车执行。
- 路线 A:用 Gio/Fyne 画一个覆盖层 + 输入框 + 过滤列表。
- 路线 B:直接用前端组件实现,Go 侧只暴露命令注册表与执行入口。
- 命令统一走同一份「命令表」,和键位绑定共用底层动作,保证热键与面板行为一致。

### 4.3 WT 默认键位表

对齐 WT `defaults.json`。macOS 上把 `Ctrl` 换成 `Cmd`。

| 操作 | Windows / Linux | macOS | 说明 |
| --- | --- | --- | --- |
| 命令面板 | `Ctrl+Shift+P` | `Cmd+Shift+P` | 低频强力操作的总入口 |
| 向右拆分 | `Alt+Shift++` | `Alt+Shift++` | 竖直分隔条 |
| 向下拆分 | `Alt+Shift+-` | `Alt+Shift+-` | 水平分隔条 |
| 调整窗格大小 | `Alt+Shift+方向键` | `Alt+Shift+方向键` | 改变分裂比例 |
| 切换焦点 | `Alt+方向键` | `Alt+方向键` | NavigateDirection |
| 交换窗格 swapPane | **无默认热键** | **无默认热键** | 只走命令面板 |
| 最大化 / 还原窗格 | (可配置) | (可配置) | Maximize / Restore |

---

## 五、构建与 CI

- **GitHub Actions 三 runner 并行**:macOS / Linux / Windows 各一,分别产出原生产物。
- **纯 Go(路线 A 无 cgo / 或纯逻辑部分)**:可在单机交叉编译,CI 只需 `go build`,各 runner 自带 Go 工具链,零额外准备。
- **用 cgo 时(`libvterm` 绑定、部分 GPU 后端)**:交叉编译失效,**必须在对应原生 runner 上构建**——三 runner 并行的 CI 正好满足这一约束。
- **Windows PTY**:走 ConPTY(`creack/pty` 在 Windows 上的路径),需单独验证。
- **Mac 分发免警告**:需 Apple 账号做 **签名 + 公证**;未签名产物在 macOS 上会被 Gatekeeper 拦。

---

## 六、里程碑(以路线 A 为主)

| 阶段 | 目标 |
| --- | --- |
| **M0** | Gio 开窗,GPU 渲一行字——先确认纯 Go GUI 能把文字画清楚(这一步就可能劝退)。 |
| **M1** | 接 VT 核(`vt10x` / `hinshun` 或 `libvterm` cgo)+ `creack/pty`,跑通单窗格 shell。 |
| **M2** | Go struct 窗格树落地;分隔条拖动调大小;`Alt+方向键` 切焦点。 |
| **M3** | 交换 / 移动窗格 + 命令面板;`swapPane` 只从面板触发。 |
| **M4** | 标签页 / 主题 / 配置文件。 |

若 M0–M1 阶段文字渲染质量或吞吐明显不达标,则触发**路线 B 回退预案**(Wails + xterm.js),并在对照报告中如实记录「纯 Go 原生这条路没走通」。

---

## 七、目录结构(占位)

```
Src_Golang/
├── ReadMe.md              # 本文件
├── go.mod
├── go.sum
├── cmd/
│   └── wintermmac/        # main 入口(选择路线 A / B 的构建标签)
├── internal/
│   ├── pane/              # 窗格二叉树:Node/Leaf/Split + split/swap/navigate 纯函数
│   ├── term/              # VT 核封装(vt10x / libvterm cgo)+ 会话 goroutine
│   ├── pty/               # creack/pty 封装(Unix PTY / Windows ConPTY)
│   ├── command/           # 命令面板:命令注册表 + 模糊搜索 + 执行
│   ├── keymap/            # WT 键位绑定(Ctrl↔Cmd 适配)
│   └── config/            # 主题 / 配置文件
├── ui_gio/                # 路线 A:Gio 渲染层、分隔条、焦点高亮、面板覆盖层
├── ui_wails/              # 路线 B:Wails 后端 + xterm.js 前端(回退预案)
└── .github/workflows/     # 三 runner 并行 CI
```

> 说明:`ui_gio/` 与 `ui_wails/` 二选一为主线,另一个作对照 / 回退;`internal/` 下的窗格树、命令表、键位这些「与渲染无关的逻辑」两条路线共用。
