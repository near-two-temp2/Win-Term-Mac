package control

import (
	"testing"

	"winterm/keymap"
	"winterm/pane"
)

// newTestController 建一个只含根叶子的树 + 控制器,NewLeaf 用递增 ID 造纯结构叶子。
func newTestController() (*Controller, *int) {
	root := pane.NewLeaf(1, nil)
	tree := pane.NewTree(root)
	next := 1
	ctrl := New(Config{
		Tree:    tree,
		Keymap:  keymap.DefaultKeymap(keymap.PlatformOther),
		Focused: root,
		NewLeaf: func() (*pane.Pane, error) {
			next++
			return pane.NewLeaf(next, nil), nil
		},
	})
	return ctrl, &next
}

func TestSplitFocusesNewLeaf(t *testing.T) {
	ctrl, _ := newTestController()
	root := ctrl.Focused()
	ctrl.Dispatch(keymap.ActionSplitRight)

	if got := len(ctrl.Tree().Leaves()); got != 2 {
		t.Fatalf("拆分后应有 2 个叶子,得到 %d", got)
	}
	if ctrl.Focused() == root {
		t.Fatalf("拆分后焦点应转到新叶子")
	}
	// 根现在应是横向分裂节点,新叶子为 Second。
	if r := ctrl.Tree().Root; r.Kind != pane.Split || r.Dir != pane.DirHorizontal {
		t.Fatalf("根应为横向分裂节点")
	}
	if ctrl.Tree().Root.Second != ctrl.Focused() {
		t.Fatalf("新叶子应位于 Second(右侧)")
	}
}

func TestMoveFocusNavigatesGeometry(t *testing.T) {
	ctrl, _ := newTestController()
	left := ctrl.Focused()
	ctrl.Dispatch(keymap.ActionSplitRight) // 焦点到右叶子
	right := ctrl.Focused()
	if left == right {
		t.Fatal("拆分应产生不同叶子")
	}
	ctrl.Dispatch(keymap.ActionFocusLeft)
	if ctrl.Focused() != left {
		t.Fatalf("FocusLeft 应回到左叶子")
	}
	ctrl.Dispatch(keymap.ActionFocusRight)
	if ctrl.Focused() != right {
		t.Fatalf("FocusRight 应到右叶子")
	}
}

func TestResizeGrowsFocused(t *testing.T) {
	ctrl, _ := newTestController()
	ctrl.Dispatch(keymap.ActionSplitRight) // 焦点在右叶子(Second)
	split := ctrl.Tree().Root
	before := split.Ratio
	// 焦点在 Second,ResizeLeft(负方向)应让它增大 → Ratio 减小。
	ctrl.Dispatch(keymap.ActionResizeLeft)
	if !(split.Ratio < before) {
		t.Fatalf("焦点在右侧时 ResizeLeft 应减小 Ratio: before=%v after=%v", before, split.Ratio)
	}
	// 再让焦点回左叶子,ResizeRight(正方向,焦点在 First)应增大 Ratio。
	ctrl.Dispatch(keymap.ActionFocusLeft)
	mid := split.Ratio
	ctrl.Dispatch(keymap.ActionResizeRight)
	if !(split.Ratio > mid) {
		t.Fatalf("焦点在左侧时 ResizeRight 应增大 Ratio: before=%v after=%v", mid, split.Ratio)
	}
}

func TestResizeClamped(t *testing.T) {
	ctrl, _ := newTestController()
	ctrl.Dispatch(keymap.ActionSplitRight)
	ctrl.Dispatch(keymap.ActionFocusLeft)
	// 反复增大,应被夹在 <=0.95。
	for i := 0; i < 50; i++ {
		ctrl.Dispatch(keymap.ActionResizeRight)
	}
	if r := ctrl.Tree().Root.Ratio; r > 0.95 {
		t.Fatalf("Ratio 应被夹到 0.95,得到 %v", r)
	}
}

func TestToggleMaximize(t *testing.T) {
	ctrl, _ := newTestController()
	ctrl.Dispatch(keymap.ActionSplitRight)
	f := ctrl.Focused()
	ctrl.Dispatch(keymap.ActionToggleMaximize)
	if ctrl.Maximized() != f {
		t.Fatalf("最大化后应记录焦点叶子")
	}
	ctrl.Dispatch(keymap.ActionToggleMaximize)
	if ctrl.Maximized() != nil {
		t.Fatalf("再次切换应还原(nil)")
	}
	// 拆分会退出最大化。
	ctrl.Dispatch(keymap.ActionToggleMaximize)
	ctrl.Dispatch(keymap.ActionSplitDown)
	if ctrl.Maximized() != nil {
		t.Fatalf("拆分应退出最大化")
	}
}

func TestClosePane(t *testing.T) {
	ctrl, _ := newTestController()
	root := ctrl.Focused()
	ctrl.Dispatch(keymap.ActionSplitRight)
	right := ctrl.Focused()

	var closed *pane.Pane
	ctrl.onClose = func(p *pane.Pane) { closed = p }

	ctrl.Dispatch(keymap.ActionClosePane) // 关右叶子
	if closed != right {
		t.Fatalf("OnClose 应收到被关叶子")
	}
	leaves := ctrl.Tree().Leaves()
	if len(leaves) != 1 || leaves[0] != root {
		t.Fatalf("关闭后应只剩根叶子,且树坍缩")
	}
	if ctrl.Focused() != root {
		t.Fatalf("焦点应转到剩余叶子")
	}
}

func TestSwapViaPalette(t *testing.T) {
	ctrl, _ := newTestController()
	a := ctrl.Focused()
	ctrl.Dispatch(keymap.ActionSplitRight)
	b := ctrl.Focused() // 右叶子,当前焦点=来源

	// 面板触发 swap:进入拾取态。
	ctrl.Dispatch(keymap.ActionSwapPane)
	if !ctrl.Picking() || ctrl.PendingAction() != keymap.ActionSwapPane {
		t.Fatalf("SwapPane 应进入拾取目标态")
	}
	// 记录交换前 First/Second。
	root := ctrl.Tree().Root
	if root.First != a || root.Second != b {
		t.Fatalf("交换前布局不符预期")
	}
	if !ctrl.PickTarget(a) {
		t.Fatalf("PickTarget 应成功交换")
	}
	if ctrl.Picking() {
		t.Fatalf("落地后应退出拾取态")
	}
	if root.First != b || root.Second != a {
		t.Fatalf("交换后 First/Second 应互换")
	}
}

func TestHandleChordLookup(t *testing.T) {
	ctrl, _ := newTestController()
	// Ctrl+Shift+P 应打开面板。
	ch := keymap.Chord{Mods: keymap.ModCtrl | keymap.ModShift, Key: "P"}
	if !ctrl.HandleChord(ch) {
		t.Fatalf("Ctrl+Shift+P 应被认领")
	}
	if !ctrl.PaletteOpen() {
		t.Fatalf("应已打开命令面板")
	}
	// 未绑定的组合不应被认领。
	if ctrl.HandleChord(keymap.Chord{Mods: keymap.ModCtrl, Key: "J"}) {
		t.Fatalf("未绑定组合不应被认领")
	}
}

func TestConfirmNormalCommand(t *testing.T) {
	ctrl, _ := newTestController()
	ctrl.OpenPalette()
	ctrl.Palette().SetQuery("splitRight")
	if !ctrl.ConfirmPalette() {
		t.Fatalf("应确认命令")
	}
	if len(ctrl.Tree().Leaves()) != 2 {
		t.Fatalf("确认 splitRight 应真的拆分出第二个叶子")
	}
}
