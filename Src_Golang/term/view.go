// 本文件是 term 包的「视图/渲染」部分:把一个 Session 的网格快照(Snapshot)
// 用 Gio 画成等宽字符网格,真正显示子进程输出;并接管键盘/指针输入,把按键
// 翻译成字节写回 PTY(见 input.go),从而"能显示输出、能敲命令"。
//
// 设计:View 是一个可复用的 Gio 组件,对应窗格树里的一个叶子(pane.Leaf)。
// 每个叶子的 Payload 挂一个 *View(其内含 *Session)。渲染层(整合 agent)在
// 布局出每个叶子的像素矩形后,用该矩形的约束调用 View.Layout(gtx) 即可。
//
// ┌─────────────────────── integrator(main.go)需要如何调用我 ───────────────────────┐
// │ 1) 建会话+视图(每个终端叶子一份):                                              │
// │      sess, err := term.Start(term.Options{})                                    │
// │      view := term.NewView(sess, shaper) // shaper 复用 main.go 里的 text.Shaper  │
// │      leaf := pane.NewLeaf(id, view)     // 把 view 挂到叶子 Payload             │
// │ 2) 每帧:对 tree.Layout() 得到的每个叶子矩形 r,构造受约束的子 gtx 再调用:      │
// │      // 把 gtx 的绘制原点平移到 r 左上角、约束设为 r 的宽高,然后:             │
// │      view.Layout(cgtx)                                                          │
// │    View 会自行:填背景 → 按当前尺寸算出 cols/rows 并 Resize 会话 → 逐行绘字     │
// │    → 画光标 → 处理本叶子的输入事件。                                            │
// │ 3) 焦点:用户点击某叶子会自动取得键盘焦点;也可调 view.RequestFocus(gtx) 主动给。│
// │ 4) 重绘:子进程输出是异步到达的,必须驱动 Gio 重画才能"看见"新输出。最简单做法 │
// │    是在主循环里对每个 sess 起一个 goroutine:for range 定时器 { w.Invalidate() }│
// │    或监听输出信号后 w.Invalidate()。View 不持有 *app.Window,故这一步在入口做。 │
// │ 5) 关闭:叶子被关时调用 sess.Close();View 无需额外清理。                        │
// └───────────────────────────────────────────────────────────────────────────────┘
package term

import (
	"image"
	"image/color"

	"gioui.org/font"
	"gioui.org/io/event"
	"gioui.org/io/key"
	"gioui.org/io/pointer"
	"gioui.org/layout"
	"gioui.org/op"
	"gioui.org/op/clip"
	"gioui.org/op/paint"
	"gioui.org/text"
	"gioui.org/unit"
	"gioui.org/widget"
)

// Theme 是终端的配色。零值不可用,请用 DefaultTheme()。
type Theme struct {
	Bg     color.NRGBA // 背景
	Fg     color.NRGBA // 前景(字形)
	Cursor color.NRGBA // 光标块(建议带 alpha 以做"反显"观感)
}

// DefaultTheme 返回一套深色默认配色。
func DefaultTheme() Theme {
	return Theme{
		Bg:     color.NRGBA{R: 0x12, G: 0x12, B: 0x14, A: 0xff},
		Fg:     color.NRGBA{R: 0xd0, G: 0xd0, B: 0xd4, A: 0xff},
		Cursor: color.NRGBA{R: 0x4e, G: 0xc9, B: 0x8a, A: 0x99},
	}
}

// View 是单个终端叶子的 Gio 视图:持有会话、字体与配色,负责绘制与输入。
// View 不是并发安全的,应只在 Gio 的 UI goroutine(帧循环)里访问。
type View struct {
	sess   *Session
	shaper *text.Shaper
	font   font.Font // 等宽字体;默认 Go Mono
	size   unit.Sp   // 字号
	theme  Theme

	focused bool // 是否持有键盘焦点(由 key.FocusEvent 维护)

	// OnReserved 让整合层截获"保留给窗格操作的热键"(如 WT 的 Alt+方向 切焦点、
	// Alt+Shift+± 拆分、Ctrl+Shift+P 命令面板)。终端持有焦点时这些按键会先到本
	// 视图;若 OnReserved 返回 true,视图就不把该键写给 shell(交由整合层执行窗格
	// 动作,通常 e→chord→keymap.Lookup 后驱动 pane 树)。为 nil 时所有键都发给 shell。
	OnReserved func(e key.Event) bool

	// 上一次测得的单元像素尺寸,供光标定位与 cols/rows 计算复用。
	cellW, cellH int
}

// NewView 用给定会话与 shaper 建视图。shaper 应复用入口处已装好字库的那个。
func NewView(sess *Session, shaper *text.Shaper) *View {
	return &View{
		sess:   sess,
		shaper: shaper,
		// gofont.Collection() 里等宽字体的 Typeface 为 "Go Mono"。
		font:  font.Font{Typeface: "Go Mono"},
		size:  unit.Sp(14),
		theme: DefaultTheme(),
	}
}

// Session 返回视图绑定的会话(整合层做关闭/写入等操作时用)。
func (v *View) Session() *Session { return v.sess }

// SetFont / SetFontSize / SetTheme 供整合层按需覆盖默认外观。
func (v *View) SetFont(f font.Font) { v.font = f }
func (v *View) SetFontSize(s unit.Sp) {
	if s > 0 {
		v.size = s
	}
}
func (v *View) SetTheme(t Theme) { v.theme = t }

// Focused 返回是否持有键盘焦点。
func (v *View) Focused() bool { return v.focused }

// RequestFocus 主动请求键盘焦点(例如新建/切换焦点窗格时由控制层调用)。
func (v *View) RequestFocus(gtx layout.Context) {
	gtx.Execute(key.FocusCmd{Tag: v})
}

// Layout 在 gtx.Constraints.Max 给定的矩形内绘制本终端并处理其输入。
// 返回占据的尺寸(通常等于约束最大值,即整块窗格)。
func (v *View) Layout(gtx layout.Context) layout.Dimensions {
	size := gtx.Constraints.Max
	if size.X <= 0 || size.Y <= 0 {
		return layout.Dimensions{Size: size}
	}

	// 1) 处理上一帧攒下的输入事件(焦点/按键/点击)。
	v.processInput(gtx, size)

	// 2) 量一个单元格的像素尺寸(等宽字体下所有字形同宽)。
	v.cellW, v.cellH = v.measureCell(gtx)

	// 3) 依当前像素尺寸推算 cols/rows,必要时同步 PTY 与网格。
	if v.cellW > 0 && v.cellH > 0 {
		cols := size.X / v.cellW
		rows := size.Y / v.cellH
		if cols < 1 {
			cols = 1
		}
		if rows < 1 {
			rows = 1
		}
		snapCols, snapRows := v.sess.Grid().Size()
		if cols != snapCols || rows != snapRows {
			// 忽略错误:会话已关闭时 Resize 返回 os.ErrClosed,下一帧自然停画。
			_ = v.sess.Resize(cols, rows)
		}
	}

	// 4) 限定绘制/命中区域为本窗格矩形,避免溢出到相邻窗格。
	areaClip := clip.Rect{Max: size}.Push(gtx.Ops)

	// 背景
	paint.FillShape(gtx.Ops, v.theme.Bg, clip.Rect{Max: size}.Op())

	// 注册本区域为指针事件目标(用于点击取焦点)。
	event.Op(gtx.Ops, v)

	// 5) 逐行绘制快照。
	snap := v.sess.Snapshot()
	if v.cellH > 0 {
		fgMat := colorMaterial(gtx, v.theme.Fg)
		for row := 0; row < snap.Rows; row++ {
			y := row * v.cellH
			if y >= size.Y {
				break
			}
			line := rowString(snap, row)
			if line == "" {
				continue
			}
			trans := op.Offset(image.Pt(0, y)).Push(gtx.Ops)
			lgtx := gtx
			lgtx.Constraints.Min = image.Point{}
			lgtx.Constraints.Max = image.Pt(1<<20, v.cellH)
			lbl := widget.Label{MaxLines: 1, Alignment: text.Start}
			lbl.Layout(lgtx, v.shaper, v.font, v.size, line, fgMat)
			trans.Pop()
		}
	}

	// 6) 光标块(仅在持有焦点时高亮;快照光标越界则不画)。
	if v.focused && v.cellW > 0 && v.cellH > 0 &&
		snap.Cursor.Row >= 0 && snap.Cursor.Row < snap.Rows &&
		snap.Cursor.Col >= 0 && snap.Cursor.Col < snap.Cols {
		cx := snap.Cursor.Col * v.cellW
		cy := snap.Cursor.Row * v.cellH
		rect := clip.Rect{
			Min: image.Pt(cx, cy),
			Max: image.Pt(cx+v.cellW, cy+v.cellH),
		}
		paint.FillShape(gtx.Ops, v.theme.Cursor, rect.Op())
	}

	areaClip.Pop()
	return layout.Dimensions{Size: size}
}

// processInput 拉取并处理属于本视图的输入事件:
//   - 指针按下 → 请求键盘焦点;
//   - 焦点变化 → 更新 focused;
//   - 按键按下 → 翻译成字节写回 PTY(见 input.go 的 keyToBytes)。
//
// 注意:本方法登记了字母/数字/具名键的 key.Filter,以 US 布局重建可打印字符,
// 保证不依赖 IME/EditEvent 即可敲 ASCII 命令。
// TODO(ime-layout): 完整的非 US 键盘布局与输入法(CJK)输入需要实现 Gio 的
// 编辑器 snippet 协议(key.SnippetCmd/SelectionCmd)并消费 key.EditEvent;
// 此处先覆盖 ASCII,复杂输入留待后续。
func (v *View) processInput(gtx layout.Context, size image.Point) {
	filters := inputFilters(v)
	for {
		ev, ok := gtx.Event(filters...)
		if !ok {
			break
		}
		switch e := ev.(type) {
		case key.FocusEvent:
			v.focused = e.Focus
		case pointer.Event:
			if e.Kind == pointer.Press {
				gtx.Execute(key.FocusCmd{Tag: v})
			}
		case key.Event:
			if e.State != key.Press {
				continue
			}
			// 先给整合层机会截获窗格热键;被认领则不下发到 shell。
			if v.OnReserved != nil && v.OnReserved(e) {
				continue
			}
			if b := keyToBytes(e); len(b) > 0 {
				// 会话关闭后写入返回错误,忽略即可。
				_, _ = v.sess.Write(b)
			}
		}
	}
	_ = size
}

// measureCell 量出等宽字体在当前字号下单个字形的像素宽高。
// 用一次"录制并丢弃"的布局来测量,不产生实际绘制。
func (v *View) measureCell(gtx layout.Context) (w, h int) {
	rec := op.Record(gtx.Ops)
	mgtx := gtx
	mgtx.Constraints.Min = image.Point{}
	mgtx.Constraints.Max = image.Pt(1<<20, 1<<20)
	lbl := widget.Label{MaxLines: 1, Alignment: text.Start}
	// "W" 在等宽字体里与其它字形同宽;取其推进宽度与行高。
	dims := lbl.Layout(mgtx, v.shaper, v.font, v.size, "W", colorMaterial(gtx, v.theme.Fg))
	rec.Stop() // 丢弃:不把录制的绘制指令加入 gtx.Ops
	return dims.Size.X, dims.Size.Y
}

// rowString 取快照第 row 行拼成字符串;空单元用空格填充,行尾空白裁掉以省绘制。
func rowString(s Snapshot, row int) string {
	if row < 0 || row >= s.Rows || s.Cols <= 0 {
		return ""
	}
	buf := make([]rune, s.Cols)
	last := -1
	for c := 0; c < s.Cols; c++ {
		r := s.Cells[row*s.Cols+c].Rune
		if r == 0 || r == ' ' {
			buf[c] = ' '
			continue
		}
		buf[c] = r
		last = c
	}
	if last < 0 {
		return ""
	}
	return string(buf[:last+1])
}

// colorMaterial 把一个颜色录成 op.CallOp,供 widget.Label 作为字形材质使用。
func colorMaterial(gtx layout.Context, c color.NRGBA) op.CallOp {
	m := op.Record(gtx.Ops)
	paint.ColorOp{Color: c}.Add(gtx.Ops)
	return m.Stop()
}
