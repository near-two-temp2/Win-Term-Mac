// 本文件是 paneui 的「渲染 / 交互」部分:把窗格树递归布局到像素矩形,逐叶子调用
// 其 LeafView.Layout,并在分裂节点之间画可拖拽的分隔条(拖动改比例)。焦点叶子
// 描一圈高亮边框。整合层每帧只需在窗格区域调用一次 Controller.Layout(gtx)。
package paneui

import (
	"image"

	"gioui.org/io/event"
	"gioui.org/io/pointer"
	"gioui.org/layout"
	"gioui.org/op"
	"gioui.org/op/clip"
	"gioui.org/op/paint"

	"winterm/pane"
)

// dividerHalf 是分隔条命中区的半宽(像素):可点击 / 拖动的范围为分隔线两侧各 4px。
const dividerHalf = 4

// dividerThick 是分隔线的可见粗细(像素)。
const dividerThick = 1

// focusBorder 是焦点叶子高亮边框的粗细(像素)。
const focusBorder = 2

// Layout 递归布局整棵窗格树并处理交互。应在窗格区域的 gtx 上每帧调用一次。
func (c *Controller) Layout(gtx layout.Context) layout.Dimensions {
	size := gtx.Constraints.Max
	if size.X <= 0 || size.Y <= 0 {
		return layout.Dimensions{Size: size}
	}

	// 首帧:若无焦点,把焦点落到第一个叶子。
	if !c.inited {
		c.inited = true
		if c.focused == nil {
			if leaves := c.tree.Leaves(); len(leaves) > 0 {
				c.setFocus(leaves[0])
			}
		}
	}

	// 1) 若有在途的程序化焦点请求,待目标视图真正报告持有焦点后才算“落定”。
	//    在落定前不采纳视图上报的焦点,避免旧视图尚未清空焦点态时被错误采纳。
	if c.pendingFocus != nil {
		if v := leafView(c.pendingFocus); v != nil && v.Focused() {
			c.pendingFocus = nil // 焦点已落定
		}
	}

	// 2) 同步用户点击造成的焦点变化(某个视图报告自己持有焦点)。
	c.syncFocusFromViews()

	// 3) 应用入队的窗格动作(此时有 gtx,焦点可在本帧末尾兑现)。
	if len(c.pending) > 0 {
		for _, a := range c.pending {
			c.Apply(a)
		}
		c.pending = c.pending[:0]
	}

	// 4) 校正焦点:若焦点叶子已不在树中(被关闭),回退到第一个叶子。
	c.ensureFocusValid()

	root := c.tree.Root
	if root == nil {
		return layout.Dimensions{Size: size}
	}

	full := image.Rectangle{Max: size}
	if c.maximized != nil && c.maximized.IsLeaf() {
		c.layoutLeaf(gtx, c.maximized, full)
	} else {
		c.layoutNode(gtx, root, full)
	}

	// 5) 兑现待处理的焦点请求。目标视图已在本帧登记过按键过滤器,焦点可路由;
	//    焦点变更是异步的,故持续请求直到步骤 1 观察到落定为止(重复请求无害)。
	if c.pendingFocus != nil {
		if v := leafView(c.pendingFocus); v != nil {
			v.RequestFocus(gtx)
		} else {
			c.pendingFocus = nil // 目标已失效(如被关闭)
		}
	}

	return layout.Dimensions{Size: size}
}

// syncFocusFromViews 采纳用户点击带来的焦点变化。当有程序化焦点请求在途
// (pendingFocus 非 nil)时跳过,避免与旧视图尚未清空的焦点态互相抢夺。
func (c *Controller) syncFocusFromViews() {
	if c.pendingFocus != nil {
		return
	}
	for _, leaf := range c.tree.Leaves() {
		if v := leafView(leaf); v != nil && v.Focused() && leaf != c.focused {
			c.focused = leaf
			return
		}
	}
}

// ensureFocusValid 保证 c.focused 仍是树中的叶子;被关闭等原因失效时回退。
func (c *Controller) ensureFocusValid() {
	if c.focused != nil {
		found := false
		c.tree.Walk(func(p *pane.Pane) bool {
			if p == c.focused {
				found = true
				return false
			}
			return true
		})
		if found {
			return
		}
	}
	if leaves := c.tree.Leaves(); len(leaves) > 0 {
		c.setFocus(leaves[0])
	} else {
		c.focused = nil
	}
}

// layoutNode 递归布局一个节点到矩形 r:叶子直接绘制,分裂节点先算子矩形再递归,
// 最后画分隔条。
func (c *Controller) layoutNode(gtx layout.Context, p *pane.Pane, r image.Rectangle) {
	if p == nil || r.Dx() <= 0 || r.Dy() <= 0 {
		return
	}
	if p.IsLeaf() {
		c.layoutLeaf(gtx, p, r)
		return
	}
	if p.Dir == pane.DirHorizontal {
		mid := r.Min.X + int(float64(r.Dx())*p.Ratio)
		c.layoutNode(gtx, p.First, image.Rect(r.Min.X, r.Min.Y, mid, r.Max.Y))
		c.layoutNode(gtx, p.Second, image.Rect(mid, r.Min.Y, r.Max.X, r.Max.Y))
		c.divider(gtx, p, r, mid, true)
	} else {
		mid := r.Min.Y + int(float64(r.Dy())*p.Ratio)
		c.layoutNode(gtx, p.First, image.Rect(r.Min.X, r.Min.Y, r.Max.X, mid))
		c.layoutNode(gtx, p.Second, image.Rect(r.Min.X, mid, r.Max.X, r.Max.Y))
		c.divider(gtx, p, r, mid, false)
	}
}

// layoutLeaf 在矩形 r 内绘制单个叶子:偏移到 r 左上角、约束设为 r 尺寸后调用其视图;
// 无有效视图时填充占位色。焦点叶子叠加高亮边框。
func (c *Controller) layoutLeaf(gtx layout.Context, p *pane.Pane, r image.Rectangle) {
	sz := image.Pt(r.Dx(), r.Dy())
	off := op.Offset(r.Min).Push(gtx.Ops)
	area := clip.Rect{Max: sz}.Push(gtx.Ops)

	if v := leafView(p); v != nil {
		cgtx := gtx
		cgtx.Constraints = layout.Exact(sz)
		v.Layout(cgtx)
	} else {
		paint.FillShape(gtx.Ops, c.theme.Placeholder, clip.Rect{Max: sz}.Op())
	}

	if p == c.focused {
		c.strokeBorder(gtx, sz)
	}

	area.Pop()
	off.Pop()
}

// strokeBorder 在 [0,0]-sz 的局部坐标里画一圈焦点边框(四条细矩形)。
func (c *Controller) strokeBorder(gtx layout.Context, sz image.Point) {
	w := focusBorder
	col := c.theme.FocusBorder
	fill := func(rr image.Rectangle) {
		paint.FillShape(gtx.Ops, col, clip.Rect(rr).Op())
	}
	fill(image.Rect(0, 0, sz.X, w))               // 上
	fill(image.Rect(0, sz.Y-w, sz.X, sz.Y))       // 下
	fill(image.Rect(0, 0, w, sz.Y))               // 左
	fill(image.Rect(sz.X-w, 0, sz.X, sz.Y))       // 右
}

// divider 处理并绘制一个分裂节点的分隔条:先消费上一帧攒下的拖拽事件更新比例,
// 再登记本帧的命中区(带 resize 光标)并画出分隔线。mid 为分隔线在 r 内的绝对
// 像素坐标(横向分裂时为 X,纵向为 Y),horizontal=true 表示竖直分隔线(左右分栏)。
func (c *Controller) divider(gtx layout.Context, split *pane.Pane, r image.Rectangle, mid int, horizontal bool) {
	// 命中区(绝对坐标):分隔线两侧各 dividerHalf 像素。
	var hit image.Rectangle
	if horizontal {
		hit = image.Rect(mid-dividerHalf, r.Min.Y, mid+dividerHalf, r.Max.Y)
	} else {
		hit = image.Rect(r.Min.X, mid-dividerHalf, r.Max.X, mid+dividerHalf)
	}

	// 消费拖拽事件。pointer 事件的 Position 相对于本 Layout 的原点(未额外偏移),
	// 与 r 处于同一坐标系,故可直接换算比例。
	for {
		ev, ok := gtx.Event(pointer.Filter{
			Target: split,
			Kinds:  pointer.Press | pointer.Drag | pointer.Release | pointer.Cancel,
		})
		if !ok {
			break
		}
		pe, ok := ev.(pointer.Event)
		if !ok {
			continue
		}
		switch pe.Kind {
		case pointer.Press:
			c.dragging[split] = true
		case pointer.Release, pointer.Cancel:
			delete(c.dragging, split)
		case pointer.Drag:
			if c.dragging[split] {
				if horizontal && r.Dx() > 0 {
					split.Ratio = clampRatio(float64(pe.Position.X-float32(r.Min.X)) / float64(r.Dx()))
				} else if !horizontal && r.Dy() > 0 {
					split.Ratio = clampRatio(float64(pe.Position.Y-float32(r.Min.Y)) / float64(r.Dy()))
				}
			}
		}
	}

	// 登记命中区并设置 resize 光标。
	st := clip.Rect(hit).Push(gtx.Ops)
	event.Op(gtx.Ops, split)
	if horizontal {
		pointer.CursorColResize.Add(gtx.Ops)
	} else {
		pointer.CursorRowResize.Add(gtx.Ops)
	}
	st.Pop()

	// 画可见分隔线。
	var line image.Rectangle
	if horizontal {
		line = image.Rect(mid, r.Min.Y, mid+dividerThick, r.Max.Y)
	} else {
		line = image.Rect(r.Min.X, mid, r.Max.X, mid+dividerThick)
	}
	paint.FillShape(gtx.Ops, c.theme.Divider, clip.Rect(line).Op())
}
