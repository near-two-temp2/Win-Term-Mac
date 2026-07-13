// Package pane 实现 Win-Term-Mac 的窗格二叉树,复刻 Windows Terminal 的窗格模型。
//
// 模型:每个窗格是一棵二叉树的节点。
//   - 叶子(Leaf):承载一个真实终端(Payload,渲染/pty 由上层挂接)。
//   - 分裂节点(Split):方向 Dir(横/竖)+ 比例 Ratio(First 占的比例,0~1)
//     + 两个子节点 First / Second。
//
// 核心操作:Split(把叶子换成分裂节点)、Swap(交换两个窗格)、
// Move(摘下再挂上,拖拽移动的基础)、Navigate(按几何相邻找焦点)、
// Walk(遍历)。Detach / Attach 作为 Move 的两个半步单独导出,供拖拽使用。
package pane

import "math"

// Kind 区分节点是叶子还是分裂节点。
type Kind int

const (
	Leaf  Kind = iota // 叶子:一个真终端
	Split             // 分裂节点:两个子窗格
)

// Dir 是分裂节点的切分方向。
type Dir int

const (
	// DirHorizontal:子窗格左右并排(竖直分割线),First=左,Second=右。
	// 对应 WT 的“向右拆分”。
	DirHorizontal Dir = iota
	// DirVertical:子窗格上下堆叠(水平分割线),First=上,Second=下。
	// 对应 WT 的“向下拆分”。
	DirVertical
)

// Direction 是方向键导航的四个方向。
type Direction int

const (
	Up Direction = iota
	Down
	Left
	Right
)

// Pane 是窗格树的节点。叶子与分裂节点复用同一 struct,由 Kind 区分。
type Pane struct {
	Kind Kind

	// 叶子字段(Kind==Leaf 时有效)
	ID      int // 稳定标识,便于测试与命令面板引用
	Payload any // 终端句柄等,渲染层挂接;PaneCore 不关心其类型

	// 分裂字段(Kind==Split 时有效)
	Dir    Dir
	Ratio  float64 // First 占据的比例,取值 (0,1)
	First  *Pane
	Second *Pane

	// 父指针,便于 Swap / Detach / Navigate 上溯。根节点为 nil。
	Parent *Pane
}

// NewLeaf 创建一个叶子窗格。
func NewLeaf(id int, payload any) *Pane {
	return &Pane{Kind: Leaf, ID: id, Payload: payload}
}

// IsLeaf 返回该节点是否为叶子。
func (p *Pane) IsLeaf() bool { return p != nil && p.Kind == Leaf }

// Tree 持有根节点。Split / Detach 可能改变根,故树级操作挂在 Tree 上。
type Tree struct {
	Root *Pane
}

// NewTree 用一个叶子作为根创建树。
func NewTree(root *Pane) *Tree { return &Tree{Root: root} }

// clampRatio 把比例限制在 (0,1) 的合理区间,避免出现零宽子窗格。
func clampRatio(r float64) float64 {
	const lo, hi = 0.05, 0.95
	if r <= 0 || math.IsNaN(r) {
		return 0.5
	}
	if r < lo {
		return lo
	}
	if r > hi {
		return hi
	}
	return r
}

// slotOf 返回指向 p 在其父节点(或根)中占据的槽位的指针,
// 便于原地替换。p 必须属于本树。
func (t *Tree) slotOf(p *Pane) **Pane {
	if p.Parent == nil {
		return &t.Root
	}
	if p.Parent.First == p {
		return &p.Parent.First
	}
	return &p.Parent.Second
}

// sibling 返回分裂节点中 child 的另一半;若 child 不是 parent 的子节点返回 nil。
func sibling(parent, child *Pane) *Pane {
	if parent == nil {
		return nil
	}
	if parent.First == child {
		return parent.Second
	}
	if parent.Second == child {
		return parent.First
	}
	return nil
}

// Split 把叶子 target 替换为一个分裂节点:target 成为 First,newLeaf 成为 Second。
// dir 决定切分方向,ratio 是 First 占的比例。返回新建的分裂节点。
// 保持 target 与 newLeaf 的指针身份不变(焦点、渲染缓存因此稳定)。
func (t *Tree) Split(target *Pane, dir Dir, ratio float64, newLeaf *Pane) *Pane {
	if target == nil || newLeaf == nil {
		return nil
	}
	split := &Pane{
		Kind:   Split,
		Dir:    dir,
		Ratio:  clampRatio(ratio),
		First:  target,
		Second: newLeaf,
		Parent: target.Parent,
	}
	// 把 target 在父/根中的槽位换成 split。
	*t.slotOf(target) = split
	target.Parent = split
	newLeaf.Parent = split
	return split
}

// isAncestor 判断 a 是否为 b 的祖先(含 a==b)。
func isAncestor(a, b *Pane) bool {
	for n := b; n != nil; n = n.Parent {
		if n == a {
			return true
		}
	}
	return false
}

// Swap 交换 a 与 b 在树中的位置(通常用于交换两个叶子,对应 WT 的 swapPane)。
// 若二者相同、或一方是另一方的祖先,则不做改动并返回 false。
func (t *Tree) Swap(a, b *Pane) bool {
	if a == nil || b == nil || a == b {
		return false
	}
	if isAncestor(a, b) || isAncestor(b, a) {
		return false
	}
	sa := t.slotOf(a)
	sb := t.slotOf(b)
	*sa, *sb = b, a
	a.Parent, b.Parent = b.Parent, a.Parent
	return true
}

// Detach 把 target 从树上摘下:其父分裂节点坍缩,兄弟节点顶替父节点的位置。
// 返回被摘下的 target(Parent 置空),可再交给 Attach。摘下根节点则清空树。
func (t *Tree) Detach(target *Pane) *Pane {
	if target == nil {
		return nil
	}
	parent := target.Parent
	if parent == nil {
		t.Root = nil
		return target
	}
	sib := sibling(parent, target)
	// 用兄弟顶替 parent 在祖父(或根)中的槽位。
	*t.slotOf(parent) = sib
	if sib != nil {
		sib.Parent = parent.Parent
	}
	target.Parent = nil
	parent.Parent = nil
	return target
}

// Attach 把已摘下的 node 挂到 at 上:对 at 做一次分裂。
// nodeFirst 为 true 时 node 成为 First(位于左/上),否则成为 Second(右/下)。
// 返回新建的分裂节点。
func (t *Tree) Attach(at, node *Pane, dir Dir, ratio float64, nodeFirst bool) *Pane {
	if at == nil || node == nil {
		return nil
	}
	first, second := at, node
	if nodeFirst {
		first, second = node, at
	}
	split := &Pane{
		Kind:   Split,
		Dir:    dir,
		Ratio:  clampRatio(ratio),
		First:  first,
		Second: second,
		Parent: at.Parent,
	}
	*t.slotOf(at) = split
	at.Parent = split
	node.Parent = split
	return split
}

// Move 把 target 移动到 dest 旁边(先 Detach 再 Attach),是拖拽移动窗格的基础。
// 若 dest 在 target 的子树内、或二者相同,则拒绝并返回 false。
func (t *Tree) Move(target, dest *Pane, dir Dir, ratio float64, nodeFirst bool) bool {
	if target == nil || dest == nil || target == dest {
		return false
	}
	if isAncestor(target, dest) {
		return false
	}
	t.Detach(target)
	t.Attach(dest, target, dir, ratio, nodeFirst)
	return true
}

// Rect 是归一化坐标下的矩形([0,1]×[0,1]),用于几何导航与布局。
type Rect struct {
	X0, Y0, X1, Y1 float64
}

// Layout 把整棵树布局到单位矩形,返回每个节点(含分裂节点)的矩形。
// 渲染层可直接按此比例映射到像素。
func (t *Tree) Layout() map[*Pane]Rect {
	out := make(map[*Pane]Rect)
	var walk func(p *Pane, r Rect)
	walk = func(p *Pane, r Rect) {
		if p == nil {
			return
		}
		out[p] = r
		if p.Kind == Leaf {
			return
		}
		if p.Dir == DirHorizontal {
			mid := r.X0 + (r.X1-r.X0)*p.Ratio
			walk(p.First, Rect{r.X0, r.Y0, mid, r.Y1})
			walk(p.Second, Rect{mid, r.Y0, r.X1, r.Y1})
		} else {
			mid := r.Y0 + (r.Y1-r.Y0)*p.Ratio
			walk(p.First, Rect{r.X0, r.Y0, r.X1, mid})
			walk(p.Second, Rect{r.X0, mid, r.X1, r.Y1})
		}
	}
	walk(t.Root, Rect{0, 0, 1, 1})
	return out
}

// spanOverlap 返回一维区间 [a0,a1] 与 [b0,b1] 的重叠长度(可为负,表示不重叠)。
func spanOverlap(a0, a1, b0, b1 float64) float64 {
	return math.Min(a1, b1) - math.Max(a0, b0)
}

// Navigate 从 from 出发,沿 dir 方向找几何上相邻的叶子(对应 WT 的 Alt+方向键切焦点)。
// 规则:候选叶子须整体落在该方向一侧,且在垂直于该方向的轴上与 from 有重叠;
// 取最近的一个,重叠更多者优先。找不到返回 nil。
func (t *Tree) Navigate(from *Pane, dir Direction) *Pane {
	if from == nil || t.Root == nil {
		return nil
	}
	rects := t.Layout()
	fr, ok := rects[from]
	if !ok {
		return nil
	}
	const eps = 1e-9
	var best *Pane
	var bestPrimary, bestOverlap float64
	for p, r := range rects {
		if p == from || p.Kind != Leaf {
			continue
		}
		var inDir bool
		var primary, overlap float64
		switch dir {
		case Right:
			inDir = r.X0 >= fr.X1-eps
			primary = r.X0 - fr.X1
			overlap = spanOverlap(fr.Y0, fr.Y1, r.Y0, r.Y1)
		case Left:
			inDir = r.X1 <= fr.X0+eps
			primary = fr.X0 - r.X1
			overlap = spanOverlap(fr.Y0, fr.Y1, r.Y0, r.Y1)
		case Down:
			inDir = r.Y0 >= fr.Y1-eps
			primary = r.Y0 - fr.Y1
			overlap = spanOverlap(fr.X0, fr.X1, r.X0, r.X1)
		case Up:
			inDir = r.Y1 <= fr.Y0+eps
			primary = fr.Y0 - r.Y1
			overlap = spanOverlap(fr.X0, fr.X1, r.X0, r.X1)
		}
		if !inDir || overlap <= eps {
			continue
		}
		better := best == nil ||
			primary < bestPrimary-eps ||
			(math.Abs(primary-bestPrimary) <= eps && overlap > bestOverlap)
		if better {
			best, bestPrimary, bestOverlap = p, primary, overlap
		}
	}
	return best
}

// Walk 前序遍历所有节点(叶子与分裂节点)。fn 返回 false 可提前终止。
func (t *Tree) Walk(fn func(*Pane) bool) {
	var walk func(p *Pane) bool
	walk = func(p *Pane) bool {
		if p == nil {
			return true
		}
		if !fn(p) {
			return false
		}
		if p.Kind == Split {
			if !walk(p.First) {
				return false
			}
			if !walk(p.Second) {
				return false
			}
		}
		return true
	}
	walk(t.Root)
}

// Leaves 按从左到右、从上到下的顺序返回所有叶子。
func (t *Tree) Leaves() []*Pane {
	var out []*Pane
	t.Walk(func(p *Pane) bool {
		if p.Kind == Leaf {
			out = append(out, p)
		}
		return true
	})
	return out
}

// Find 按 ID 查找叶子;找不到返回 nil。
func (t *Tree) Find(id int) *Pane {
	var found *Pane
	t.Walk(func(p *Pane) bool {
		if p.Kind == Leaf && p.ID == id {
			found = p
			return false
		}
		return true
	})
	return found
}
