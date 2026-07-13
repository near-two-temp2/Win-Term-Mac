// Package paneui 把 pane 包的窗格二叉树接到真实的 Gio 视图上:递归布局每个叶子、
// 在分裂节点之间画可拖拽的分隔条、并把窗格热键(拆分 / 切焦点 / 调整大小 /
// 最大化 / 关闭)落到树上。它不自造终端与键位——叶子的 Payload 复用 term.View,
// 键位复用 keymap 包,树操作复用 pane.Tree。
//
// ┌───────────────────── integrator(main.go)需要如何调用我 ─────────────────────┐
// │ 1) 建树与控制器(每个叶子的 Payload 挂一个 *term.View,它天然满足 LeafView):   │
// │      root := pane.NewLeaf(1, term.NewView(sess, shaper))                       │
// │      tree := pane.NewTree(root)                                                │
// │      ctrl := paneui.NewController(tree)                                        │
// │      // 拆分时如何造新叶子(起会话 + 建视图 + 包成叶子),由整合层提供:        │
// │      ctrl.NewLeaf = func() *pane.Pane {                                        │
// │          sess, _ := term.Start(term.Options{})                                │
// │          return pane.NewLeaf(nextID(), term.NewView(sess, shaper))            │
// │      }                                                                         │
// │      ctrl.OnCloseLeaf = func(p *pane.Pane) { /* sess.Close() 等清理 */ }       │
// │ 2) 把窗格热键从终端视图里“截走”:每个 term.View 设置 OnReserved,               │
// │    命中窗格动作时入队并返回 true(表示不下发给 shell):                        │
// │      view.OnReserved = func(e key.Event) bool {                               │
// │          if ch, ok := paneui.ChordFromKey(e); ok {                            │
// │              if a, ok := km.Lookup(ch); ok { return ctrl.Enqueue(a) }         │
// │          }                                                                     │
// │          return false                                                         │
// │      }                                                                         │
// │    注:OpenPalette 等非本控制器负责的动作,Enqueue 返回 false,整合层可另行处理。│
// │ 3) 每帧渲染:在窗格区域的 gtx 上调用一次即可,控制器自会递归布局全部叶子:      │
// │      ctrl.Layout(gtx)                                                          │
// │    入队的动作会在这里(有 gtx 时)统一生效,焦点切换也在这里请求键盘焦点。      │
// │ 4) 重绘:异步的 shell 输出仍需整合层驱动 w.Invalidate()(对各会话起定时器轮询,   │
// │    见 app.go 的 watch),本控制器不持有 *app.Window。                            │
// └───────────────────────────────────────────────────────────────────────────────┘
package paneui

import (
	"image/color"

	"gioui.org/layout"

	"winterm/keymap"
	"winterm/pane"
)

// LeafView 是一个叶子窗格的可渲染视图。term.View 天然满足本接口
// (Layout / Focused / RequestFocus 三个方法),故无需 import term,避免耦合。
type LeafView interface {
	// Layout 在 gtx.Constraints.Max 给定的矩形内绘制该终端并处理其输入。
	Layout(gtx layout.Context) layout.Dimensions
	// Focused 返回该视图是否当前持有键盘焦点(用户点击会改变它)。
	Focused() bool
	// RequestFocus 主动请求键盘焦点(切焦点 / 新建窗格后由控制器调用)。
	RequestFocus(gtx layout.Context)
}

// Theme 是窗格框架(非终端内容)的配色:分隔条、焦点边框、空视图占位背景。
type Theme struct {
	Divider     color.NRGBA // 分裂节点之间的分隔条
	FocusBorder color.NRGBA // 当前焦点叶子的高亮边框
	Placeholder color.NRGBA // 叶子无有效 View 时的占位填充
}

// DefaultTheme 返回一套与 term.DefaultTheme 深色系相配的默认配色。
func DefaultTheme() Theme {
	return Theme{
		Divider:     color.NRGBA{R: 0x33, G: 0x33, B: 0x3a, A: 0xff},
		FocusBorder: color.NRGBA{R: 0x4e, G: 0xc9, B: 0x8a, A: 0xcc},
		Placeholder: color.NRGBA{R: 0x0a, G: 0x0a, B: 0x0c, A: 0xff},
	}
}

// Controller 持有窗格树与交互状态,负责把树渲染成视图并把窗格动作落到树上。
// 它只应在 Gio 的 UI goroutine(帧循环)里访问,非并发安全。
type Controller struct {
	tree  *pane.Tree
	theme Theme

	focused      *pane.Pane // 当前焦点叶子(控制器内部维护的权威值)
	pendingFocus *pane.Pane // 待请求键盘焦点的叶子;在 Layout 里(有 gtx 时)兑现
	maximized    *pane.Pane // 非 nil 时只渲染该叶子(全屏);对应 ToggleMaximize

	dragging   map[*pane.Pane]bool // 正在被拖动的分裂节点(其分隔条被按住)
	pending    []keymap.Action     // 入队待应用的窗格动作(来自 OnReserved)
	resizeStep float64             // 每次键盘 Resize 调整的比例步长
	inited     bool                // 是否已完成首帧初始化(设定初始焦点)

	// NewLeaf 由整合层提供:创建一个新的终端叶子(起会话 + 建视图 + 包成叶子)。
	// 为 nil 时拆分动作静默失败。
	NewLeaf func() *pane.Pane
	// OnCloseLeaf 由整合层提供:一个叶子被关闭(从树上摘下)后调用,用于清理会话。
	OnCloseLeaf func(*pane.Pane)
}

// NewController 用一棵已建好的树创建控制器。
func NewController(tree *pane.Tree) *Controller {
	return &Controller{
		tree:       tree,
		theme:      DefaultTheme(),
		dragging:   make(map[*pane.Pane]bool),
		resizeStep: 0.03,
	}
}

// Tree 返回底层窗格树。
func (c *Controller) Tree() *pane.Tree { return c.tree }

// Focused 返回当前焦点叶子(可能为 nil)。
func (c *Controller) Focused() *pane.Pane { return c.focused }

// SetFocus 设定焦点叶子,并安排在下一帧请求键盘焦点。
func (c *Controller) SetFocus(p *pane.Pane) { c.setFocus(p) }

// SetTheme 覆盖窗格框架配色。
func (c *Controller) SetTheme(t Theme) { c.theme = t }

// setFocus 更新内部焦点并登记待请求键盘焦点。
func (c *Controller) setFocus(p *pane.Pane) {
	c.focused = p
	c.pendingFocus = p
}

// Handles 返回某动作是否由本控制器负责(拆分 / 切焦点 / 调整大小 / 最大化 / 关闭)。
// OpenPalette、SwapPane、MovePane 等不在此列(交由整合层 / 命令面板处理)。
func (c *Controller) Handles(a keymap.Action) bool {
	switch a {
	case keymap.ActionSplitRight, keymap.ActionSplitDown,
		keymap.ActionFocusUp, keymap.ActionFocusDown,
		keymap.ActionFocusLeft, keymap.ActionFocusRight,
		keymap.ActionResizeUp, keymap.ActionResizeDown,
		keymap.ActionResizeLeft, keymap.ActionResizeRight,
		keymap.ActionToggleMaximize, keymap.ActionClosePane:
		return true
	}
	return false
}

// Enqueue 把一个窗格动作入队,留待下一次 Layout(有 gtx)时生效。
// 若该动作不归本控制器管,返回 false(整合层据此决定是否另行处理 / 下发 shell)。
func (c *Controller) Enqueue(a keymap.Action) bool {
	if !c.Handles(a) {
		return false
	}
	c.pending = append(c.pending, a)
	return true
}

// Apply 立即把一个动作作用到树上(纯逻辑,不需要 gtx;焦点变更在下一帧兑现)。
// 返回是否发生了改变。整合层通常用 Enqueue 而非直接 Apply。
func (c *Controller) Apply(a keymap.Action) bool {
	switch a {
	case keymap.ActionSplitRight:
		return c.split(pane.DirHorizontal)
	case keymap.ActionSplitDown:
		return c.split(pane.DirVertical)
	case keymap.ActionFocusUp:
		return c.focusDir(pane.Up)
	case keymap.ActionFocusDown:
		return c.focusDir(pane.Down)
	case keymap.ActionFocusLeft:
		return c.focusDir(pane.Left)
	case keymap.ActionFocusRight:
		return c.focusDir(pane.Right)
	case keymap.ActionResizeUp:
		return c.resize(pane.Up)
	case keymap.ActionResizeDown:
		return c.resize(pane.Down)
	case keymap.ActionResizeLeft:
		return c.resize(pane.Left)
	case keymap.ActionResizeRight:
		return c.resize(pane.Right)
	case keymap.ActionToggleMaximize:
		return c.toggleMaximize()
	case keymap.ActionClosePane:
		return c.closeFocused()
	}
	return false
}

// Swap 交换两个叶子的位置(供命令面板的 SwapPane 触发)。
func (c *Controller) Swap(a, b *pane.Pane) bool { return c.tree.Swap(a, b) }

// Move 把 target 移到 dest 旁(供命令面板的 MovePane 触发)。
func (c *Controller) Move(target, dest *pane.Pane, dir pane.Dir, ratio float64, nodeFirst bool) bool {
	return c.tree.Move(target, dest, dir, ratio, nodeFirst)
}

// split 把当前焦点叶子按 dir 拆分,新叶子取得焦点。
func (c *Controller) split(dir pane.Dir) bool {
	if c.focused == nil || c.NewLeaf == nil {
		return false
	}
	nl := c.NewLeaf()
	if nl == nil {
		return false
	}
	c.maximized = nil // 结构变化时退出最大化,避免视图与树不一致
	c.tree.Split(c.focused, dir, 0.5, nl)
	c.setFocus(nl)
	return true
}

// focusDir 沿方向把焦点切到几何相邻的叶子。
func (c *Controller) focusDir(dir pane.Direction) bool {
	if c.focused == nil {
		return false
	}
	if t := c.tree.Navigate(c.focused, dir); t != nil {
		c.setFocus(t)
		return true
	}
	return false
}

// resize 沿方向移动最近的、方向匹配的分隔条(键盘调整大小)。
func (c *Controller) resize(dir pane.Direction) bool {
	if c.focused == nil {
		return false
	}
	horizontal := dir == pane.Left || dir == pane.Right
	sp := ancestorSplit(c.focused, horizontal)
	if sp == nil {
		return false
	}
	step := c.resizeStep
	if dir == pane.Left || dir == pane.Up {
		step = -step
	}
	sp.Ratio = clampRatio(sp.Ratio + step)
	return true
}

// toggleMaximize 切换当前焦点叶子的全屏显示。
func (c *Controller) toggleMaximize() bool {
	if c.focused == nil {
		return false
	}
	if c.maximized == c.focused {
		c.maximized = nil
	} else {
		c.maximized = c.focused
	}
	return true
}

// closeFocused 关闭当前焦点叶子;树上只剩一个叶子时拒绝(不关最后一个)。
func (c *Controller) closeFocused() bool {
	if c.focused == nil || len(c.tree.Leaves()) <= 1 {
		return false
	}
	victim := c.focused
	// 摘下前先按几何相邻挑一个新焦点(顺序:左→上→右→下)。
	next := c.tree.Navigate(victim, pane.Left)
	if next == nil {
		next = c.tree.Navigate(victim, pane.Up)
	}
	if next == nil {
		next = c.tree.Navigate(victim, pane.Right)
	}
	if next == nil {
		next = c.tree.Navigate(victim, pane.Down)
	}
	c.tree.Detach(victim)
	if c.maximized == victim {
		c.maximized = nil
	}
	if c.OnCloseLeaf != nil {
		c.OnCloseLeaf(victim)
	}
	if next == nil {
		if leaves := c.tree.Leaves(); len(leaves) > 0 {
			next = leaves[0]
		}
	}
	c.setFocus(next)
	return true
}

// ancestorSplit 从 p 上溯,返回最近的、方向匹配(横=horizontal)的分裂祖先。
func ancestorSplit(p *pane.Pane, horizontal bool) *pane.Pane {
	for n := p; n != nil; n = n.Parent {
		par := n.Parent
		if par == nil {
			continue
		}
		if (par.Dir == pane.DirHorizontal) == horizontal {
			return par
		}
	}
	return nil
}

// leafView 从叶子取出其可渲染视图;非叶子或类型不符返回 nil。
func leafView(p *pane.Pane) LeafView {
	if p == nil || !p.IsLeaf() {
		return nil
	}
	v, _ := p.Payload.(LeafView)
	return v
}

// clampRatio 把比例限制在 (0.05,0.95),与 pane 包内部约束一致,避免零宽子窗格。
func clampRatio(r float64) float64 {
	const lo, hi = 0.05, 0.95
	if r < lo {
		return lo
	}
	if r > hi {
		return hi
	}
	return r
}
