package pane

import "testing"

// newTree 构造一棵只有一个叶子的树,便于各用例复用。
func newTree(id int) (*Tree, *Pane) {
	root := NewLeaf(id, nil)
	return NewTree(root), root
}

// checkParents 校验所有分裂节点的子节点父指针一致,确保操作后树仍自洽。
func checkParents(t *testing.T, tree *Tree) {
	t.Helper()
	if tree.Root != nil && tree.Root.Parent != nil {
		t.Fatalf("root Parent 应为 nil,实际 %p", tree.Root.Parent)
	}
	tree.Walk(func(p *Pane) bool {
		if p.Kind != Split {
			return true
		}
		if p.First == nil || p.Second == nil {
			t.Fatalf("分裂节点存在空子节点")
		}
		if p.First.Parent != p {
			t.Fatalf("First 父指针错误")
		}
		if p.Second.Parent != p {
			t.Fatalf("Second 父指针错误")
		}
		return true
	})
}

func TestSplitRootBecomesSplitNode(t *testing.T) {
	tree, root := newTree(1)
	leaf2 := NewLeaf(2, nil)

	split := tree.Split(root, DirHorizontal, 0.6, leaf2)

	if split == nil || split.Kind != Split {
		t.Fatalf("Split 应返回分裂节点")
	}
	if tree.Root != split {
		t.Fatalf("分裂后根应指向新分裂节点")
	}
	if split.First != root || split.Second != leaf2 {
		t.Fatalf("target 应为 First,newLeaf 应为 Second")
	}
	if split.Dir != DirHorizontal || split.Ratio != 0.6 {
		t.Fatalf("方向/比例未正确写入,得到 dir=%d ratio=%v", split.Dir, split.Ratio)
	}
	if root.Parent != split || leaf2.Parent != split {
		t.Fatalf("子节点父指针未指向分裂节点")
	}
	checkParents(t, tree)
}

func TestSplitLeafKeepsPointerIdentity(t *testing.T) {
	tree, root := newTree(1)
	leaf2 := NewLeaf(2, nil)
	tree.Split(root, DirVertical, 0.5, leaf2)

	// 再对已有叶子 leaf2 做一次分裂,验证非根叶子也能正确替换。
	leaf3 := NewLeaf(3, nil)
	split2 := tree.Split(leaf2, DirHorizontal, 0.3, leaf3)

	if split2.Parent != tree.Root {
		t.Fatalf("嵌套分裂节点的父应为原根分裂节点")
	}
	if tree.Root.Second != split2 {
		t.Fatalf("原 Second 槽位应被新分裂节点替换")
	}
	if split2.First != leaf2 || split2.Second != leaf3 {
		t.Fatalf("嵌套分裂的子节点顺序不对")
	}
	// leaf2 指针身份应保持不变(仍是同一对象)。
	if leaf2.Kind != Leaf || leaf2.ID != 2 {
		t.Fatalf("被分裂的叶子指针身份被破坏")
	}
	leaves := tree.Leaves()
	if len(leaves) != 3 {
		t.Fatalf("应有 3 个叶子,实际 %d", len(leaves))
	}
	checkParents(t, tree)
}

func TestSplitClampsRatio(t *testing.T) {
	tree, root := newTree(1)
	split := tree.Split(root, DirHorizontal, 5.0, NewLeaf(2, nil))
	if split.Ratio <= 0 || split.Ratio >= 1 {
		t.Fatalf("越界比例应被夹紧到 (0,1),实际 %v", split.Ratio)
	}
}

func TestSwapTwoLeaves(t *testing.T) {
	tree, root := newTree(1)
	leaf2 := NewLeaf(2, nil)
	tree.Split(root, DirHorizontal, 0.5, leaf2) // root=左, leaf2=右
	split := tree.Root

	if !tree.Swap(root, leaf2) {
		t.Fatalf("Swap 应成功")
	}
	if split.First != leaf2 || split.Second != root {
		t.Fatalf("两叶子未在父节点内交换位置")
	}
	if leaf2.Parent != split || root.Parent != split {
		t.Fatalf("交换后父指针应仍指向同一分裂节点")
	}
	checkParents(t, tree)
}

func TestSwapAcrossDifferentParents(t *testing.T) {
	// 构造:root 横分为 [A | B],再把 B 竖分为 [B / C]。
	// 交换 A 与 C(位于不同父节点)。
	tree, a := newTree(1)
	b := NewLeaf(2, nil)
	tree.Split(a, DirHorizontal, 0.5, b)
	rootSplit := tree.Root
	c := NewLeaf(3, nil)
	bSplit := tree.Split(b, DirVertical, 0.5, c)

	if !tree.Swap(a, c) {
		t.Fatalf("跨父交换应成功")
	}
	if rootSplit.First != c {
		t.Fatalf("A 的槽位应换成 C")
	}
	if bSplit.Second != a {
		t.Fatalf("C 的槽位应换成 A")
	}
	if c.Parent != rootSplit || a.Parent != bSplit {
		t.Fatalf("跨父交换后父指针未更新")
	}
	checkParents(t, tree)
}

func TestSwapRejectsAncestor(t *testing.T) {
	tree, root := newTree(1)
	leaf2 := NewLeaf(2, nil)
	split := tree.Split(root, DirHorizontal, 0.5, leaf2)
	// split 是 root 的祖先,应拒绝。
	if tree.Swap(split, root) {
		t.Fatalf("祖先与后代交换应被拒绝")
	}
	if tree.Swap(root, root) {
		t.Fatalf("自交换应被拒绝")
	}
}
