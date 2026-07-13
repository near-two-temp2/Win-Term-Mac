// 本文件是【整合层 / 装配】:把四个功能模块接线成一个能跑的应用。
// 只属于入口/装配,不改任何模块内部文件。
//
// 复用关系(不另造一套):
//   - term.View   :单个终端叶子的渲染 + 键盘/指针输入 + PTY 写回 + Resize(自带)。
//   - paneui      :窗格树的 Gio 渲染(递归布局 / 可拖拽分隔条 / 焦点边框 / 点击切焦点)
//                   以及窗格动作(拆分 / 切焦点 / 调整大小 / 最大化 / 关闭)与焦点权威。
//                   因为 paneui.Layout 依据其内部 focused/maximized 渲染,故它必须是
//                   窗格动作的唯一执行者,应用即以它为准。
//   - palette     :命令面板的命令集 + 模糊搜索 + 选中态(数据与算法)。
//   - keymap      :Chord→Action 键表(按平台自动 Ctrl→Cmd)。
//   - pane        :窗格二叉树本体(Split/Swap/Move/Navigate 等)。
//
// 去重说明:早期曾并行存在 control(另一套窗格动作 + 焦点/最大化 + 命令面板调度)
// 与 io/iobridge(另一套输入编码 + 尺寸换算 + 重绘轮询)两个包,与 paneui / term.View
// 功能重叠,若同时启用会出现「两个 controller 争夺焦点/最大化」的双写问题。为避免分叉,
// 现已删除这两个包,统一以 paneui 为唯一窗格 controller、命令面板直接驱动 palette.Palette
// 并把确认动作回灌 paneui;终端叶子的输入/尺寸/重绘直接用 term.View 自带的
// processInput / Resize 与本文件的定时 Invalidate。
//
// 已知局限(TODO):
//   - swap/move 目标拾取目前用键盘模态(Alt+方向选目标 + Enter 确认);鼠标点击拾取待补。
//   - VT 桩解析器无 SGR 颜色;非 US 布局 / IME(CJK)输入需后续接 EditEvent。
package main

import (
	"image"
	"image/color"
	"runtime"
	"time"

	"gioui.org/app"
	"gioui.org/font/gofont"
	"gioui.org/io/key"
	"gioui.org/layout"
	"gioui.org/op/clip"
	"gioui.org/op/paint"
	"gioui.org/text"
	"gioui.org/unit"
	"gioui.org/widget/material"

	"winterm/keymap"
	"winterm/palette"
	"winterm/pane"
	"winterm/paneui"
	"winterm/term"
)

// App 持有整个应用的运行时状态。仅在 Gio 的 UI goroutine(帧循环)里访问。
type App struct {
	w      *app.Window
	shaper *text.Shaper
	th     *material.Theme
	km     *keymap.Keymap

	tree  *pane.Tree
	panes *paneui.Controller
	pal   *palette.Palette

	nextID int

	// swap/move 的「拾取目标」模态状态。
	picking bool
	pendAct keymap.Action
	pendSrc *pane.Pane
}

// newApp 装配应用:建字体/主题/键表/命令面板,起第一个终端叶子并建窗格控制器。
func newApp(w *app.Window) *App {
	a := &App{w: w}
	a.shaper = text.NewShaper(text.WithCollection(gofont.Collection()))
	a.th = material.NewTheme()
	a.th.Shaper = a.shaper
	a.km = keymap.DefaultKeymap(defaultPlatform())
	a.pal = palette.NewDefault(a.km)

	root := a.newLeaf()
	if root == nil {
		// 起不了 shell 会话:仍建一棵空树,窗口会画占位背景。
		// TODO(diagnostics): 把启动失败显示到状态栏而非静默。
		root = pane.NewLeaf(a.bumpID(), nil)
	}
	a.tree = pane.NewTree(root)
	a.panes = paneui.NewController(a.tree)
	a.panes.NewLeaf = a.newLeaf         // 拆分时的新叶子工厂
	a.panes.OnCloseLeaf = a.closeLeaf   // 关闭叶子时清理会话
	a.panes.SetFocus(root)
	return a
}

// defaultPlatform 按运行平台选键表变体(mac 上 Ctrl 系热键换成 Cmd)。
func defaultPlatform() keymap.Platform {
	if runtime.GOOS == "darwin" {
		return keymap.PlatformMac
	}
	return keymap.PlatformOther
}

func (a *App) bumpID() int { a.nextID++; return a.nextID }

// newLeaf 创建一个新的终端叶子:起会话 → 建视图 → 挂 OnReserved → 起重绘轮询。
// 供 paneui 拆分时回调,也用于首个根叶子。会话起不来返回 nil(拆分静默失败)。
func (a *App) newLeaf() *pane.Pane {
	sess, err := term.Start(term.Options{})
	if err != nil {
		// TODO(diagnostics): 起 shell 失败应上报;此处返回 nil 让上层静默中止。
		return nil
	}
	v := term.NewView(sess, a.shaper)
	v.OnReserved = a.onReserved
	a.watch(sess)
	return pane.NewLeaf(a.bumpID(), v)
}

// closeLeaf 关闭一个被摘下的叶子对应的会话。
func (a *App) closeLeaf(p *pane.Pane) {
	if v := viewOf(p); v != nil {
		_ = v.Session().Close()
	}
}

// viewOf 从叶子取出 *term.View;非叶子或无视图返回 nil。
func viewOf(p *pane.Pane) *term.View {
	if p == nil || !p.IsLeaf() {
		return nil
	}
	v, _ := p.Payload.(*term.View)
	return v
}

// watch 为一个会话起一条重绘轮询 goroutine:子进程输出是异步到达的,必须驱动
// Gio 重画才能「看见」新输出。会话结束(Done)后自行退出。
func (a *App) watch(sess *term.Session) {
	go func() {
		t := time.NewTicker(33 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-sess.Done():
				a.w.Invalidate()
				return
			case <-t.C:
				a.w.Invalidate()
			}
		}
	}()
}

// Close 在窗口销毁时关闭所有会话。
func (a *App) Close() {
	if a.tree == nil {
		return
	}
	for _, leaf := range a.tree.Leaves() {
		if v := viewOf(leaf); v != nil {
			_ = v.Session().Close()
		}
	}
}

// Frame 渲染一帧:先画窗格树,再叠加拾取提示 / 命令面板浮层。
func (a *App) Frame(gtx layout.Context) {
	size := gtx.Constraints.Max

	// 窗口底色(窗格会各自填满,这里兜底避免空隙透白)。
	paint.FillShape(gtx.Ops, color.NRGBA{R: 0x0a, G: 0x0a, B: 0x0c, A: 0xff},
		clip.Rect{Max: size}.Op())

	// 窗格树:递归布局全部叶子、画分隔条、应用入队动作、兑现焦点。
	a.panes.Layout(gtx)

	// 拾取目标模态提示。
	if a.picking {
		a.layoutHint(gtx, "拾取目标窗格: Alt+方向移动焦点, Enter 确认, Esc 取消")
	}

	// 命令面板浮层。
	if a.pal.IsOpen() {
		a.layoutPalette(gtx)
	}
}

// ------------------------------ 输入路由 ------------------------------

// onReserved 挂到每个 term.View 的 OnReserved:在按键写给 shell 之前先给整合层
// 截获窗格热键 / 命令面板 / 拾取目标。返回 true 表示已认领(不下发 shell)。
// term.View 只在 key.Press 时调用本函数。
func (a *App) onReserved(e key.Event) bool {
	// 命令面板打开时:所有按键都归面板。
	if a.pal.IsOpen() {
		a.handlePaletteKey(e)
		return true
	}
	// 拾取目标模态:方向键移焦点、Enter 确认、Esc 取消,其余吞掉。
	if a.picking {
		return a.handlePickKey(e)
	}
	// 普通态:翻成和弦查键表。
	ch, ok := paneui.ChordFromKey(e)
	if !ok {
		return false // 非窗格键,放行给 shell
	}
	act, ok := a.km.Lookup(ch)
	if !ok {
		return false
	}
	switch act {
	case keymap.ActionOpenPalette:
		a.pal.Open()
		a.w.Invalidate()
		return true
	case keymap.ActionSwapPane, keymap.ActionMovePane:
		// 低频强力操作默认无热键,仅命令面板触发;这里不认领。
		return false
	}
	// 其余(拆分/切焦点/调整大小/最大化/关闭)交给 paneui 执行。
	if a.panes.Enqueue(act) {
		a.w.Invalidate()
		return true
	}
	return false
}

// handlePaletteKey 在命令面板打开时驱动其搜索/导航/确认。
func (a *App) handlePaletteKey(e key.Event) {
	switch e.Name {
	case key.NameEscape:
		a.pal.Close()
	case key.NameReturn, key.NameEnter:
		a.confirmPalette()
	case key.NameUpArrow:
		a.pal.MoveSelection(-1)
	case key.NameDownArrow:
		a.pal.MoveSelection(+1)
	case key.NameDeleteBackward:
		q := []rune(a.pal.Query())
		if len(q) > 0 {
			a.pal.SetQuery(string(q[:len(q)-1]))
		}
	default:
		if r, ok := printableRune(e); ok {
			a.pal.SetQuery(a.pal.Query() + string(r))
		}
	}
	a.w.Invalidate()
}

// confirmPalette 落地当前高亮命令:普通命令回灌 paneui;swap/move 进入拾取模态。
func (a *App) confirmPalette() {
	cmd, ok := a.pal.Confirm() // 内部已关闭面板
	if !ok {
		return
	}
	if cmd.NeedsTarget {
		a.beginPick(cmd.Action)
		return
	}
	// SplitRight/Down、Focus*、Resize*、ToggleMaximize、ClosePane 均由 paneui 执行。
	a.panes.Enqueue(cmd.Action)
	a.w.Invalidate()
}

// handlePickKey 处理拾取目标模态下的按键。返回 true(模态全部吞掉)。
func (a *App) handlePickKey(e key.Event) bool {
	switch e.Name {
	case key.NameEscape:
		a.cancelPick()
		a.w.Invalidate()
		return true
	case key.NameReturn, key.NameEnter:
		a.commitPick()
		a.w.Invalidate()
		return true
	}
	// 允许用方向键在窗格间移动焦点来选目标。
	if ch, ok := paneui.ChordFromKey(e); ok {
		if act, ok := a.km.Lookup(ch); ok {
			switch act {
			case keymap.ActionFocusUp, keymap.ActionFocusDown,
				keymap.ActionFocusLeft, keymap.ActionFocusRight:
				a.panes.Enqueue(act)
				a.w.Invalidate()
			}
		}
	}
	return true
}

// beginPick 进入拾取目标模态,来源为当前焦点叶子。
func (a *App) beginPick(act keymap.Action) {
	src := a.panes.Focused()
	if src == nil {
		return
	}
	a.picking = true
	a.pendAct = act
	a.pendSrc = src
}

// commitPick 用当前焦点叶子作为目标完成 swap/move。
func (a *App) commitPick() {
	tgt := a.panes.Focused()
	if a.pendSrc != nil && tgt != nil && tgt != a.pendSrc {
		switch a.pendAct {
		case keymap.ActionSwapPane:
			a.panes.Swap(a.pendSrc, tgt)
		case keymap.ActionMovePane:
			// 默认把来源移到目标右侧(横分,新块在右),比例各半。
			a.panes.Move(a.pendSrc, tgt, pane.DirHorizontal, 0.5, false)
		}
	}
	a.cancelPick()
}

func (a *App) cancelPick() {
	a.picking = false
	a.pendAct = keymap.ActionNone
	a.pendSrc = nil
}

// printableRune 按 US 布局把一次按键还原成可打印字符(供命令面板搜索)。
// 字母默认小写、Shift 大写;数字/符号按 Shift 映射。带 Ctrl/Alt/Cmd 不算文本。
func printableRune(e key.Event) (rune, bool) {
	if e.Modifiers.Contain(key.ModCtrl) || e.Modifiers.Contain(key.ModAlt) ||
		e.Modifiers.Contain(key.ModSuper) || e.Modifiers.Contain(key.ModCommand) {
		return 0, false
	}
	if e.Name == key.NameSpace {
		return ' ', true
	}
	s := string(e.Name)
	if len(s) != 1 {
		return 0, false
	}
	r := rune(s[0])
	shift := e.Modifiers.Contain(key.ModShift)
	if r >= 'A' && r <= 'Z' {
		if !shift {
			r += 'a' - 'A' // Gio 具名字母恒为大写
		}
		return r, true
	}
	if shift {
		if m, ok := usShiftKeys[r]; ok {
			return m, true
		}
	}
	return r, true
}

// usShiftKeys 是 US 键盘 Shift 态数字/符号映射(与 term 包保持一致)。
var usShiftKeys = map[rune]rune{
	'1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^',
	'7': '&', '8': '*', '9': '(', '0': ')',
	'-': '_', '=': '+', '[': '{', ']': '}', '\\': '|',
	';': ':', '\'': '"', ',': '<', '.': '>', '/': '?', '`': '~',
}

// ------------------------------ 浮层渲染 ------------------------------

// layoutHint 在窗口顶部居中画一条提示横幅。
func (a *App) layoutHint(gtx layout.Context, msg string) {
	layout.N.Layout(gtx, func(gtx layout.Context) layout.Dimensions {
		return layout.UniformInset(unit.Dp(8)).Layout(gtx, func(gtx layout.Context) layout.Dimensions {
			return fillBox(gtx, color.NRGBA{R: 0x2d, G: 0x2d, B: 0x35, A: 0xf0}, 6,
				func(gtx layout.Context) layout.Dimensions {
					return layout.UniformInset(unit.Dp(8)).Layout(gtx, func(gtx layout.Context) layout.Dimensions {
						lbl := material.Label(a.th, unit.Sp(13), msg)
						lbl.Color = color.NRGBA{R: 0xe0, G: 0xe0, B: 0xe4, A: 0xff}
						lbl.MaxLines = 1
						return lbl.Layout(gtx)
					})
				})
		})
	})
}

// layoutPalette 画命令面板:半透明遮罩 + 居中面板(查询行 + 结果列表)。
func (a *App) layoutPalette(gtx layout.Context) {
	// 遮罩
	paint.FillShape(gtx.Ops, color.NRGBA{A: 0x99}, clip.Rect{Max: gtx.Constraints.Max}.Op())

	layout.Center.Layout(gtx, func(gtx layout.Context) layout.Dimensions {
		// 限定面板宽度。
		w := gtx.Constraints.Max.X * 3 / 4
		if w > 720 {
			w = 720
		}
		if w < 240 {
			w = gtx.Constraints.Max.X
		}
		gtx.Constraints.Min.X = w
		gtx.Constraints.Max.X = w
		return fillBox(gtx, color.NRGBA{R: 0x1e, G: 0x1e, B: 0x22, A: 0xff}, 8,
			func(gtx layout.Context) layout.Dimensions {
				return layout.UniformInset(unit.Dp(10)).Layout(gtx, a.paletteContent)
			})
	})
}

// paletteContent 画查询行与结果列表(竖直排列)。
func (a *App) paletteContent(gtx layout.Context) layout.Dimensions {
	var children []layout.FlexChild

	// 查询行:"> 用户输入_"
	query := "› " + a.pal.Query() + "▏"
	children = append(children, layout.Rigid(func(gtx layout.Context) layout.Dimensions {
		return layout.Inset{Bottom: unit.Dp(8)}.Layout(gtx, func(gtx layout.Context) layout.Dimensions {
			lbl := material.Label(a.th, unit.Sp(16), query)
			lbl.Color = color.NRGBA{R: 0xf0, G: 0xf0, B: 0xf4, A: 0xff}
			lbl.MaxLines = 1
			return lbl.Layout(gtx)
		})
	}))

	// 结果列表(最多展示 12 条)。
	results := a.pal.Results()
	sel := a.pal.Selected()
	const maxRows = 12
	for i, r := range results {
		if i >= maxRows {
			break
		}
		i, r := i, r
		children = append(children, layout.Rigid(func(gtx layout.Context) layout.Dimensions {
			return a.paletteRow(gtx, r, i == sel)
		}))
	}
	if len(results) == 0 {
		children = append(children, layout.Rigid(func(gtx layout.Context) layout.Dimensions {
			lbl := material.Label(a.th, unit.Sp(14), "(无匹配命令)")
			lbl.Color = color.NRGBA{R: 0x80, G: 0x80, B: 0x88, A: 0xff}
			return lbl.Layout(gtx)
		}))
	}

	return layout.Flex{Axis: layout.Vertical}.Layout(gtx, children...)
}

// paletteRow 画一条结果行:标题居左、热键居右;选中项加高亮底色。
func (a *App) paletteRow(gtx layout.Context, r palette.Result, selected bool) layout.Dimensions {
	content := func(gtx layout.Context) layout.Dimensions {
		return layout.UniformInset(unit.Dp(5)).Layout(gtx, func(gtx layout.Context) layout.Dimensions {
			return layout.Flex{Axis: layout.Horizontal, Alignment: layout.Middle}.Layout(gtx,
				layout.Flexed(1, func(gtx layout.Context) layout.Dimensions {
					lbl := material.Label(a.th, unit.Sp(14), r.Command.Title)
					if selected {
						lbl.Color = color.NRGBA{R: 0xff, G: 0xff, B: 0xff, A: 0xff}
					} else {
						lbl.Color = color.NRGBA{R: 0xc8, G: 0xc8, B: 0xcc, A: 0xff}
					}
					lbl.MaxLines = 1
					return lbl.Layout(gtx)
				}),
				layout.Rigid(func(gtx layout.Context) layout.Dimensions {
					if r.Hotkey == "" {
						return layout.Dimensions{}
					}
					lbl := material.Label(a.th, unit.Sp(12), r.Hotkey)
					lbl.Color = color.NRGBA{R: 0x88, G: 0x88, B: 0x90, A: 0xff}
					lbl.MaxLines = 1
					return lbl.Layout(gtx)
				}),
			)
		})
	}
	if selected {
		return fillBox(gtx, color.NRGBA{R: 0x2d, G: 0x4f, B: 0x3e, A: 0xff}, 4, content)
	}
	return content(gtx)
}

// fillBox 在 content 尺寸的背后填一个圆角底色(用 layout.Stack 实现)。
func fillBox(gtx layout.Context, bg color.NRGBA, radius int, content layout.Widget) layout.Dimensions {
	return layout.Stack{}.Layout(gtx,
		layout.Expanded(func(gtx layout.Context) layout.Dimensions {
			sz := gtx.Constraints.Min
			rr := clip.UniformRRect(image.Rectangle{Max: sz}, radius)
			paint.FillShape(gtx.Ops, bg, rr.Op(gtx.Ops))
			return layout.Dimensions{Size: sz}
		}),
		layout.Stacked(content),
	)
}
