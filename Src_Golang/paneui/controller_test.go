package paneui

import (
	"testing"

	"gioui.org/layout"

	"winterm/keymap"
	"winterm/pane"
)

// fakeView 是满足 LeafView 的测试替身;逻辑测试不真正渲染,仅记录焦点态。
type fakeView struct {
	focused    bool
	reqCount   int
	laidOut    bool
}

func (f *fakeView) Layout(gtx layout.Context) layout.Dimensions {
	f.laidOut = true
	return layout.Dimensions{Size: gtx.Constraints.Max}
}
func (f *fakeView) Focused() bool                       { return f.focused }
func (f *fakeView) RequestFocus(gtx layout.Context)     { f.reqCount++ }

// newLeafFactory 返回一个每次产出带 fakeView 的新叶子的工厂。
func newLeafFactory(next *int) func() *pane.Pane {
	return func() *pane.Pane {
		*next++
		return pane.NewLeaf(*next, &fakeView{})
	}
}

func setup() (*Controller, *pane.Pane) {
	root := pane.NewLeaf(1, &fakeView{})
	tree := pane.NewTree(root)
	c := NewController(tree)
	id := 1
	c.NewLeaf = newLeafFactory(&id)
	c.SetFocus(root)
	return c, root
}

func TestSplitRightCreatesHorizontalSplitAndFocusesNew(t *testing.T) {
	c, root := setup()
	if !c.Apply(keymap.ActionSplitRight) {
		t.Fatal("SplitRight 应返回 true")
	}
	if c.tree.Root == nil || c.tree.Root.Kind != pane.Split || c.tree.Root.Dir != pane.DirHorizontal {
		t.Fatalf("根应为横向分裂节点,得到 %+v", c.tree.Root)
	}
	if c.tree.Root.First != root {
		t.Fatal("原叶子应成为分裂节点的 First")
	}
	if c.Focused() == root {
		t.Fatal("拆分后焦点应落到新叶子")
	}
	if got := len(c.tree.Leaves()); got != 2 {
		t.Fatalf("叶子数应为 2,得到 %d", got)
	}
}

func TestFocusNavigation(t *testing.T) {
	c, root := setup()
	c.Apply(keymap.ActionSplitRight) // 焦点在右侧新叶子
	if !c.Apply(keymap.ActionFocusLeft) {
		t.Fatal("FocusLeft 应返回 true")
	}
	if c.Focused() != root {
		t.Fatal("FocusLeft 后焦点应回到左侧原叶子")
	}
	// 已在最左,再向左应无处可去。
	if c.Apply(keymap.ActionFocusLeft) {
		t.Fatal("最左窗格再 FocusLeft 应返回 false")
	}
}

func TestResizeMovesRatio(t *testing.T) {
	c, root := setup()
	c.Apply(keymap.ActionSplitRight)
	split := c.tree.Root
	before := split.Ratio
	c.SetFocus(root) // 焦点回到左侧
	if !c.Apply(keymap.ActionResizeRight) {
		t.Fatal("ResizeRight 应返回 true")
	}
	afterRight := split.Ratio
	if afterRight <= before {
		t.Fatalf("ResizeRight 应增大比例:%v -> %v", before, afterRight)
	}
	if !c.Apply(keymap.ActionResizeLeft) {
		t.Fatal("ResizeLeft 应返回 true")
	}
	if split.Ratio >= afterRight {
		t.Fatalf("ResizeLeft 应减小比例:%v -> %v", afterRight, split.Ratio)
	}
}

func TestClosePaneKeepsLastLeaf(t *testing.T) {
	c, root := setup()
	// 只剩一个叶子时拒绝关闭。
	if c.Apply(keymap.ActionClosePane) {
		t.Fatal("最后一个叶子不应被关闭")
	}
	c.Apply(keymap.ActionSplitRight) // 现在 2 个叶子,焦点在新叶子
	closed := false
	c.OnCloseLeaf = func(p *pane.Pane) { closed = true }
	if !c.Apply(keymap.ActionClosePane) {
		t.Fatal("有两个叶子时应能关闭焦点叶子")
	}
	if !closed {
		t.Fatal("OnCloseLeaf 应被调用")
	}
	if got := len(c.tree.Leaves()); got != 1 {
		t.Fatalf("关闭后应剩 1 个叶子,得到 %d", got)
	}
	if c.Focused() != root {
		t.Fatal("关闭后焦点应落到剩下的叶子")
	}
}

func TestToggleMaximize(t *testing.T) {
	c, _ := setup()
	c.Apply(keymap.ActionSplitRight)
	f := c.Focused()
	if !c.Apply(keymap.ActionToggleMaximize) {
		t.Fatal("ToggleMaximize 应返回 true")
	}
	if c.maximized != f {
		t.Fatal("最大化后 maximized 应为焦点叶子")
	}
	c.Apply(keymap.ActionToggleMaximize)
	if c.maximized != nil {
		t.Fatal("再次切换应还原(maximized 归 nil)")
	}
}

func TestHandlesAndEnqueue(t *testing.T) {
	c, _ := setup()
	if c.Handles(keymap.ActionOpenPalette) {
		t.Fatal("OpenPalette 不应由本控制器处理")
	}
	if !c.Handles(keymap.ActionSplitRight) {
		t.Fatal("SplitRight 应由本控制器处理")
	}
	if c.Enqueue(keymap.ActionOpenPalette) {
		t.Fatal("Enqueue 不受理的动作应返回 false")
	}
	if !c.Enqueue(keymap.ActionSplitDown) {
		t.Fatal("Enqueue 受理的动作应返回 true")
	}
	if len(c.pending) != 1 {
		t.Fatalf("入队后 pending 应有 1 项,得到 %d", len(c.pending))
	}
}
