// 本文件是 control 包的核心「调度器」:把 keymap.Action / 命令面板的确认结果
// 落地到 pane.Tree 与焦点上。整合层(main.go)只需构造一个 Controller,把按键
// 交给它,并在它回调时给视图键盘焦点 / 触发重绘。
//
// ┌─────────────────────── integrator(main.go)需要如何调用我 ───────────────────────┐
// │ 1) 建控制器(窗格树 + 键表 + 新终端工厂 + 回调):                                 │
// │      km := keymap.DefaultKeymap(keymap.PlatformOther) // mac 用 PlatformMac       │
// │      ctrl := control.New(control.Config{                                          │
// │          Tree:    tree,                 // *pane.Tree,已含一个根叶子             │
// │          Keymap:  km,                                                             │
// │          Focused: tree.Root,            // 初始焦点叶子(可空,自动取第一个)     │
// │          NewLeaf: func() (*pane.Pane, error) {                                    │
// │              // 起一个新会话/视图并包成叶子(整合层的活,我不碰 term/pty)        │
// │              sess, err := term.Start(term.Options{}); if err != nil { … }         │
// │              return pane.NewLeaf(nextID(), term.NewView(sess, shaper)), nil       │
// │          },                                                                       │
// │          OnFocus:  func(p *pane.Pane) { /* view.RequestFocus 见下 */ },           │
// │          OnChange: func() { w.Invalidate() },     // 树/尺寸变了,重排+重绘       │
// │          OnClose:  func(p *pane.Pane) { /* sess.Close() */ },                     │
// │      })                                                                           │
// │ 2) 焦点视图收到按键时(term.View.OnReserved 里)先给我截获窗格键:                │
// │      view.OnReserved = func(e key.Event) bool {                                   │
// │          if ctrl.PaletteOpen() { return ctrl.HandlePaletteKey(e) } // 面板优先    │
// │          if ctrl.Picking()     { /* 面板拾取目标态,见 PickTarget */ }            │
// │          ch, ok := control.ChordFromGio(e); if !ok { return false }               │
// │          return ctrl.HandleChord(ch) // 命中窗格动作则吞掉,不发给 shell          │
// │      }                                                                            │
// │ 3) swap/move 只从面板触发:面板 Confirm 后我进入「拾取目标」态(Picking()==true),│
// │    整合层把用户下一次点击的叶子交给 ctrl.PickTarget(leaf) 落地。                  │
// │ 4) 渲染:每帧读 ctrl.Focused() 决定高亮/给焦点;ctrl.Maximized() 非空时只画该叶子。│
// └───────────────────────────────────────────────────────────────────────────────┘
package control

import (
	"winterm/keymap"
	"winterm/palette"
	"winterm/pane"
)

// NewLeafFunc 由整合层提供:创建一个「新的终端叶子」(内部起会话/视图并挂 Payload)。
// control 包不碰 term/pty,拆分时通过它拿到新叶子。返回 error 表示新建失败(拆分中止)。
type NewLeafFunc func() (*pane.Pane, error)

// Config 是 Controller 的装配参数。Tree、Keymap、NewLeaf 必填;回调可空(空即忽略)。
type Config struct {
	Tree    *pane.Tree
	Keymap  *keymap.Keymap
	Focused *pane.Pane  // 初始焦点叶子;为空时自动取树里第一个叶子
	NewLeaf NewLeafFunc // 拆分时用来生成新终端叶子

	// Commands 允许自定义命令集;为空则用 palette.DefaultCommands()。
	Commands []palette.Command

	// ResizeStep 是一次 Resize 动作调整分裂比例的步长;<=0 用默认 0.05。
	ResizeStep float64

	// 回调(均可空):
	OnFocus  func(*pane.Pane) // 焦点切到某叶子时调用(整合层据此给视图键盘焦点)
	OnChange func()           // 树结构 / 比例 / 最大化状态变化时调用(整合层重排+重绘)
	OnClose  func(*pane.Pane) // 某叶子被关闭时调用(整合层据此 sess.Close())
}

// Controller 持有装配后的运行时状态并对外提供动作调度。
// 非并发安全:应只在 UI goroutine(帧循环)里调用。
type Controller struct {
	tree    *pane.Tree
	km      *keymap.Keymap
	pal     *palette.Palette
	newLeaf NewLeafFunc

	focused   *pane.Pane
	maximized *pane.Pane // 非空表示该叶子处于最大化(整合层只画它)

	resizeStep float64

	// swap/move 的「拾取目标」子流程状态:面板确认 NeedsTarget 命令后置位,
	// 记录来源叶子与待执行动作,等整合层调用 PickTarget 落地。
	picking       bool
	pendingAction keymap.Action
	pendingSource *pane.Pane

	onFocus  func(*pane.Pane)
	onChange func()
	onClose  func(*pane.Pane)
}

// New 按 Config 装配一个 Controller。
func New(cfg Config) *Controller {
	cmds := cfg.Commands
	if cmds == nil {
		cmds = palette.DefaultCommands()
	}
	step := cfg.ResizeStep
	if step <= 0 {
		step = 0.05
	}
	c := &Controller{
		tree:       cfg.Tree,
		km:         cfg.Keymap,
		pal:        palette.New(cfg.Keymap, cmds),
		newLeaf:    cfg.NewLeaf,
		focused:    cfg.Focused,
		resizeStep: step,
		onFocus:    cfg.OnFocus,
		onChange:   cfg.OnChange,
		onClose:    cfg.OnClose,
	}
	if c.focused == nil && c.tree != nil {
		if ls := c.tree.Leaves(); len(ls) > 0 {
			c.focused = ls[0]
		}
	}
	return c
}

// ------------------------------ 只读访问 ------------------------------

// Tree 返回底层窗格树。
func (c *Controller) Tree() *pane.Tree { return c.tree }

// Keymap 返回键表。
func (c *Controller) Keymap() *keymap.Keymap { return c.km }

// Palette 返回命令面板(整合层用它渲染列表 / 读结果)。
func (c *Controller) Palette() *palette.Palette { return c.pal }

// Focused 返回当前焦点叶子(可能为 nil,例如全部关闭后)。
func (c *Controller) Focused() *pane.Pane { return c.focused }

// Maximized 返回当前最大化的叶子;无则 nil。整合层非空时只渲染该叶子。
func (c *Controller) Maximized() *pane.Pane { return c.maximized }

// PaletteOpen 返回命令面板是否打开。
func (c *Controller) PaletteOpen() bool { return c.pal.IsOpen() }

// Picking 返回是否处于 swap/move 的「拾取目标」子流程。
func (c *Controller) Picking() bool { return c.picking }

// PendingAction 返回拾取子流程中待执行的动作(SwapPane / MovePane);非拾取态为 ActionNone。
func (c *Controller) PendingAction() keymap.Action {
	if !c.picking {
		return keymap.ActionNone
	}
	return c.pendingAction
}

// SetFocus 直接把焦点设到某叶子(如用户点击某窗格时),并触发 OnFocus。
func (c *Controller) SetFocus(p *pane.Pane) {
	if p == nil || !p.IsLeaf() {
		return
	}
	c.focused = p
	c.fireFocus()
}

// ------------------------------ 键位入口 ------------------------------

// HandleChord 查表并执行窗格动作。命中并处理返回 true(整合层应吞掉此键,不发给 shell)。
func (c *Controller) HandleChord(ch keymap.Chord) bool {
	a, ok := c.km.Lookup(ch)
	if !ok {
		return false
	}
	return c.Dispatch(a)
}

// Dispatch 执行一个抽象动作。返回是否真的处理了该动作(即使无副作用,只要认领即 true)。
func (c *Controller) Dispatch(a keymap.Action) bool {
	switch a {
	case keymap.ActionOpenPalette:
		c.OpenPalette()
	case keymap.ActionSplitRight:
		c.splitPane(pane.DirHorizontal)
	case keymap.ActionSplitDown:
		c.splitPane(pane.DirVertical)
	case keymap.ActionFocusUp:
		c.moveFocus(pane.Up)
	case keymap.ActionFocusDown:
		c.moveFocus(pane.Down)
	case keymap.ActionFocusLeft:
		c.moveFocus(pane.Left)
	case keymap.ActionFocusRight:
		c.moveFocus(pane.Right)
	case keymap.ActionResizeUp:
		c.resizePane(pane.Up)
	case keymap.ActionResizeDown:
		c.resizePane(pane.Down)
	case keymap.ActionResizeLeft:
		c.resizePane(pane.Left)
	case keymap.ActionResizeRight:
		c.resizePane(pane.Right)
	case keymap.ActionToggleMaximize:
		c.toggleMaximize()
	case keymap.ActionClosePane:
		c.closePane()
	case keymap.ActionSwapPane:
		c.beginPick(keymap.ActionSwapPane)
	case keymap.ActionMovePane:
		c.beginPick(keymap.ActionMovePane)
	default:
		return false
	}
	return true
}

// ------------------------------ 命令面板 ------------------------------

// OpenPalette 打开命令面板(重置查询)。
func (c *Controller) OpenPalette() { c.pal.Open() }

// ConfirmPalette 取当前高亮命令并落地:
//   - 普通命令 → 立即 Dispatch 其 Action;
//   - NeedsTarget 命令(swap/move)→ 进入「拾取目标」子流程,等 PickTarget。
//
// 返回是否有命令被确认(无结果时 false)。
func (c *Controller) ConfirmPalette() bool {
	cmd, ok := c.pal.Confirm()
	if !ok {
		return false
	}
	if cmd.NeedsTarget {
		c.beginPick(cmd.Action)
		return true
	}
	c.Dispatch(cmd.Action)
	return true
}

// beginPick 进入 swap/move 的拾取目标态,记录来源为当前焦点。
func (c *Controller) beginPick(a keymap.Action) {
	if c.focused == nil {
		return
	}
	c.picking = true
	c.pendingAction = a
	c.pendingSource = c.focused
}

// CancelPick 取消拾取子流程(如用户按 Esc)。
func (c *Controller) CancelPick() {
	c.picking = false
	c.pendingAction = keymap.ActionNone
	c.pendingSource = nil
}

// PickTarget 用 target 作为 swap/move 的目标叶子完成子流程。
// 返回是否成功落地(非拾取态、目标非法、树操作被拒都返回 false)。
func (c *Controller) PickTarget(target *pane.Pane) bool {
	if !c.picking || c.pendingSource == nil || target == nil || !target.IsLeaf() {
		return false
	}
	src := c.pendingSource
	act := c.pendingAction
	c.CancelPick()

	var ok bool
	switch act {
	case keymap.ActionSwapPane:
		ok = c.tree.Swap(src, target)
	case keymap.ActionMovePane:
		// 默认把来源移到目标右侧(横分,新块在右),比例各半。
		ok = c.tree.Move(src, target, pane.DirHorizontal, 0.5, false)
	}
	if ok {
		// 结构变了可能使最大化叶子失效;保守起见退出最大化。
		c.clearMaximizeIfDetached()
		c.focused = src
		c.fireFocus()
		c.fireChange()
	}
	return ok
}

// ------------------------------ 具体动作 ------------------------------

// splitPane 把当前焦点叶子拆分:dir 决定方向,新叶子成为 Second(右/下),并接管焦点。
func (c *Controller) splitPane(dir pane.Dir) {
	if c.focused == nil || c.newLeaf == nil {
		return
	}
	leaf, err := c.newLeaf()
	if err != nil || leaf == nil {
		// TODO(diagnostics): 新建终端失败可上报状态栏;此处静默中止拆分。
		return
	}
	if c.tree.Split(c.focused, dir, 0.5, leaf) == nil {
		return
	}
	// 拆分后退出最大化(布局已变),焦点给新叶子。
	c.maximized = nil
	c.focused = leaf
	c.fireFocus()
	c.fireChange()
}

// moveFocus 按几何相邻把焦点移到某方向的叶子(WT 的 Alt+方向)。
func (c *Controller) moveFocus(dir pane.Direction) {
	if c.focused == nil {
		return
	}
	next := c.tree.Navigate(c.focused, dir)
	if next == nil || next == c.focused {
		return
	}
	c.focused = next
	c.fireFocus()
	c.fireChange() // 焦点高亮变化也需重绘
}

// resizePane 沿 dir 方向移动焦点叶子所在的分裂线,使焦点叶子朝该方向增大。
// 找不到匹配轴向的祖先分裂节点则无操作。
func (c *Controller) resizePane(dir pane.Direction) {
	if c.focused == nil {
		return
	}
	wantAxis := pane.DirHorizontal
	if dir == pane.Up || dir == pane.Down {
		wantAxis = pane.DirVertical
	}
	grow := dir == pane.Right || dir == pane.Down // 正方向

	// 第一趟:让焦点叶子朝 dir「增大」。
	// 正方向:焦点在 First(分裂线在其正侧),增大 First → Ratio 增。
	// 负方向:焦点在 Second(分裂线在其负侧),增大 Second → Ratio 减。
	for n := c.focused; n != nil && n.Parent != nil; n = n.Parent {
		p := n.Parent
		if p.Dir != wantAxis {
			continue
		}
		inFirst := p.First == n
		if grow && inFirst {
			c.nudge(p, +c.resizeStep)
			return
		}
		if !grow && !inFirst {
			c.nudge(p, -c.resizeStep)
			return
		}
	}
	// 第二趟(回退):焦点已在该轴的边缘,退化为从对侧收缩。
	for n := c.focused; n != nil && n.Parent != nil; n = n.Parent {
		p := n.Parent
		if p.Dir != wantAxis {
			continue
		}
		inFirst := p.First == n
		if grow && !inFirst {
			c.nudge(p, +c.resizeStep)
			return
		}
		if !grow && inFirst {
			c.nudge(p, -c.resizeStep)
			return
		}
	}
}

// nudge 把分裂节点的比例挪动 delta 并夹到 (0.05,0.95),然后触发重绘。
func (c *Controller) nudge(split *pane.Pane, delta float64) {
	const lo, hi = 0.05, 0.95
	r := split.Ratio + delta
	if r < lo {
		r = lo
	}
	if r > hi {
		r = hi
	}
	if r == split.Ratio {
		return
	}
	split.Ratio = r
	c.fireChange()
}

// toggleMaximize 切换当前焦点叶子的最大化状态。
func (c *Controller) toggleMaximize() {
	if c.focused == nil {
		return
	}
	if c.maximized == c.focused {
		c.maximized = nil
	} else {
		c.maximized = c.focused
	}
	c.fireChange()
}

// closePane 关闭当前焦点叶子:从树上摘下、通知整合层清理会话,并把焦点转给邻近叶子。
func (c *Controller) closePane() {
	if c.focused == nil {
		return
	}
	victim := c.focused
	if c.maximized == victim {
		c.maximized = nil
	}
	c.tree.Detach(victim)
	if c.onClose != nil {
		c.onClose(victim)
	}
	// 选一个新焦点:优先剩余叶子里的第一个。
	c.focused = nil
	if ls := c.tree.Leaves(); len(ls) > 0 {
		c.focused = ls[0]
	}
	// 若正处于拾取态且来源被关掉,则取消。
	if c.picking && c.pendingSource == victim {
		c.CancelPick()
	}
	c.fireFocus()
	c.fireChange()
}

// clearMaximizeIfDetached 在结构变动后,若最大化叶子已不在树里则清除最大化。
func (c *Controller) clearMaximizeIfDetached() {
	if c.maximized == nil {
		return
	}
	present := false
	c.tree.Walk(func(p *pane.Pane) bool {
		if p == c.maximized {
			present = true
			return false
		}
		return true
	})
	if !present {
		c.maximized = nil
	}
}

// ------------------------------ 回调触发 ------------------------------

func (c *Controller) fireFocus() {
	if c.onFocus != nil && c.focused != nil {
		c.onFocus(c.focused)
	}
}

func (c *Controller) fireChange() {
	if c.onChange != nil {
		c.onChange()
	}
}
