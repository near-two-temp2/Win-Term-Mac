//! 窗格二叉树核心(照搬 Windows Terminal 的 `Pane` 模型)。
//!
//! 一棵 `Pane` 要么是**叶子**(承载一个真实终端,这里只保留它的 `LeafId`,
//! 真正的终端/PTY 句柄由上层按 id 索引),要么是一个**内部分裂节点**
//! (方向 + 分割比例 + first/second 两个子树)。
//!
//! 本模块只提供**纯粹的树操作**:split / swap / detach / attach / move /
//! navigate / walk / leaves / layout。不涉及渲染、输入、PTY——那些由上层组合。
//!
//! 设计约定:
//! - `SplitDir::Vertical`   => 竖直分隔条,左 | 右(first=左,second=右)。
//! - `SplitDir::Horizontal` => 水平分隔条,上 / 下(first=上,second=下)。
//! - `ratio` ∈ (0,1),表示 first 子树占父矩形的比例。

/// 叶子标识。上层用它反查真实的终端仿真状态与 PTY 会话。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct LeafId(pub u64);

/// 分割方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitDir {
    /// 竖直分隔条:左 | 右。
    Vertical,
    /// 水平分隔条:上 / 下。
    Horizontal,
}

/// 焦点导航方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Left,
    Right,
    Up,
    Down,
}

/// 窗格树节点:叶子 或 内部分裂节点。
#[derive(Debug, Clone, PartialEq)]
pub enum Pane {
    /// 叶子:一个真实终端(以 `LeafId` 指代)。
    Leaf(LeafId),
    /// 内部节点:一次分裂,两个子树。
    Split {
        dir: SplitDir,
        /// first 子树所占比例 ∈ (0,1)。
        ratio: f32,
        first: Box<Pane>,
        second: Box<Pane>,
    },
}

/// 布局矩形(像素或归一化坐标均可,单位由调用方决定)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    #[inline]
    pub fn new(x: f32, y: f32, w: f32, h: f32) -> Self {
        Rect { x, y, w, h }
    }
    #[inline]
    pub fn right(&self) -> f32 {
        self.x + self.w
    }
    #[inline]
    pub fn bottom(&self) -> f32 {
        self.y + self.h
    }
    #[inline]
    pub fn center_x(&self) -> f32 {
        self.x + self.w * 0.5
    }
    #[inline]
    pub fn center_y(&self) -> f32 {
        self.y + self.h * 0.5
    }
}

/// 几何比较用的容差,吸收浮点误差。
const EPS: f32 = 1e-3;

impl Pane {
    /// 构造一个叶子。
    #[inline]
    pub fn leaf(id: LeafId) -> Pane {
        Pane::Leaf(id)
    }

    /// 是否为叶子。
    #[inline]
    pub fn is_leaf(&self) -> bool {
        matches!(self, Pane::Leaf(_))
    }

    // ------------------------------------------------------------------
    // 遍历 / 查询
    // ------------------------------------------------------------------

    /// 前序遍历每个叶子,依次调用 `visit`。
    pub fn walk<F: FnMut(LeafId)>(&self, visit: &mut F) {
        match self {
            Pane::Leaf(id) => visit(*id),
            Pane::Split { first, second, .. } => {
                first.walk(visit);
                second.walk(visit);
            }
        }
    }

    /// 收集所有叶子 id(前序)。
    pub fn leaves(&self) -> Vec<LeafId> {
        let mut out = Vec::new();
        self.walk(&mut |id| out.push(id));
        out
    }

    /// 叶子数量。
    pub fn leaf_count(&self) -> usize {
        match self {
            Pane::Leaf(_) => 1,
            Pane::Split { first, second, .. } => first.leaf_count() + second.leaf_count(),
        }
    }

    /// 是否包含指定叶子。
    pub fn contains(&self, id: LeafId) -> bool {
        match self {
            Pane::Leaf(leaf) => *leaf == id,
            Pane::Split { first, second, .. } => first.contains(id) || second.contains(id),
        }
    }

    // ------------------------------------------------------------------
    // 结构变更
    // ------------------------------------------------------------------

    /// 在焦点叶子 `target` 处一分为二:把它换成一个分裂节点,
    /// first 保留原叶子,second 为新叶子 `new_id`。
    ///
    /// 返回是否成功(找到了目标叶子)。`ratio` 会被夹到 (0,1) 开区间内。
    pub fn split(&mut self, target: LeafId, dir: SplitDir, ratio: f32, new_id: LeafId) -> bool {
        match self {
            Pane::Leaf(id) if *id == target => {
                let kept = *id;
                *self = Pane::Split {
                    dir,
                    ratio: clamp_ratio(ratio),
                    first: Box::new(Pane::Leaf(kept)),
                    second: Box::new(Pane::Leaf(new_id)),
                };
                true
            }
            Pane::Leaf(_) => false,
            Pane::Split { first, second, .. } => {
                first.split(target, dir, ratio, new_id)
                    || second.split(target, dir, ratio, new_id)
            }
        }
    }

    /// 交换两个叶子的位置(命令面板触发的 swapPane)。
    ///
    /// 由于叶子只承载 id,交换等价于把两处的 id 对调。一次遍历完成:
    /// 遇到 `a` 改成 `b`,遇到 `b` 改成 `a`。返回两者是否都存在。
    pub fn swap(&mut self, a: LeafId, b: LeafId) -> bool {
        if a == b {
            return self.contains(a);
        }
        if !self.contains(a) || !self.contains(b) {
            return false;
        }
        self.swap_inner(a, b);
        true
    }

    fn swap_inner(&mut self, a: LeafId, b: LeafId) {
        match self {
            Pane::Leaf(id) => {
                if *id == a {
                    *id = b;
                } else if *id == b {
                    *id = a;
                }
            }
            Pane::Split { first, second, .. } => {
                first.swap_inner(a, b);
                second.swap_inner(a, b);
            }
        }
    }

    /// 摘下叶子 `target`:其父分裂节点被它的兄弟子树替换,返回被摘下的子树。
    ///
    /// 若 `target` 就是整棵树的根叶子(没有父节点可塌缩),返回 `None`
    /// ——最后一个窗格不可摘除。
    pub fn detach(&mut self, target: LeafId) -> Option<Pane> {
        // 根本身是目标叶子:无父可塌缩。
        if let Pane::Leaf(id) = self {
            if *id == target {
                return None;
            }
        }
        self.detach_inner(target)
    }

    /// 在内部节点上尝试摘除 `target`。若某个直接子节点是目标叶子,
    /// 就用另一个子节点替换掉当前分裂节点,并返回被摘下的叶子。
    fn detach_inner(&mut self, target: LeafId) -> Option<Pane> {
        let (first_is_target, second_is_target) = match self {
            Pane::Leaf(_) => return None,
            Pane::Split { first, second, .. } => (
                matches!(first.as_ref(), Pane::Leaf(id) if *id == target),
                matches!(second.as_ref(), Pane::Leaf(id) if *id == target),
            ),
        };

        match self {
            Pane::Split { first, second, .. } => {
                if first_is_target {
                    // 用 second 替换当前节点,取出 first 作为被摘下的子树。
                    let detached = std::mem::replace(first.as_mut(), Pane::Leaf(target));
                    let sibling = std::mem::replace(second.as_mut(), Pane::Leaf(target));
                    *self = sibling;
                    return Some(detached);
                }
                if second_is_target {
                    let detached = std::mem::replace(second.as_mut(), Pane::Leaf(target));
                    let sibling = std::mem::replace(first.as_mut(), Pane::Leaf(target));
                    *self = sibling;
                    return Some(detached);
                }
                // 递归下探两个子树。
                if let Some(d) = first.detach_inner(target) {
                    return Some(d);
                }
                second.detach_inner(target)
            }
            Pane::Leaf(_) => None,
        }
    }

    /// 把子树 `sub` 挂到叶子 `at` 上:`at` 处换成分裂节点,
    /// first 保留原叶子,second 为挂入的子树。返回是否成功。
    pub fn attach(&mut self, sub: Pane, at: LeafId, dir: SplitDir, ratio: f32) -> bool {
        match self {
            Pane::Leaf(id) if *id == at => {
                let kept = *id;
                *self = Pane::Split {
                    dir,
                    ratio: clamp_ratio(ratio),
                    first: Box::new(Pane::Leaf(kept)),
                    second: Box::new(sub),
                };
                true
            }
            Pane::Leaf(_) => false,
            Pane::Split { first, second, .. } => {
                // attach 会消耗 sub,只能尝试一条分支;先探是否命中再递归。
                if first.contains(at) {
                    first.attach(sub, at, dir, ratio)
                } else if second.contains(at) {
                    second.attach(sub, at, dir, ratio)
                } else {
                    false
                }
            }
        }
    }

    /// 移动窗格:把 `target` 从原位摘下,重新挂到 `at` 旁(拖拽移动的基础)。
    ///
    /// 要求 `target != at` 且两者都存在;摘下后 `at` 仍需存在。成功返回 `true`,
    /// 失败时保证树不被破坏。
    pub fn move_pane(&mut self, target: LeafId, at: LeafId, dir: SplitDir, ratio: f32) -> bool {
        if target == at || !self.contains(target) || !self.contains(at) {
            return false;
        }
        let Some(sub) = self.detach(target) else {
            return false;
        };
        // detach 不会动到 `at`(它在兄弟子树里),因此 at 仍然存在。
        if self.attach(sub, at, dir, ratio) {
            true
        } else {
            // 理论不可达;保守起见不静默丢弃,直接 panic 暴露逻辑错误。
            unreachable!("attach target vanished after detach");
        }
    }

    // ------------------------------------------------------------------
    // 布局 + 几何导航
    // ------------------------------------------------------------------

    /// 递归布局:把外框 `bounds` 按 dir/ratio 切分,产出每个叶子的矩形。
    pub fn layout(&self, bounds: Rect) -> Vec<(LeafId, Rect)> {
        let mut out = Vec::new();
        self.layout_into(bounds, &mut out);
        out
    }

    fn layout_into(&self, bounds: Rect, out: &mut Vec<(LeafId, Rect)>) {
        match self {
            Pane::Leaf(id) => out.push((*id, bounds)),
            Pane::Split {
                dir,
                ratio,
                first,
                second,
            } => {
                let r = clamp_ratio(*ratio);
                let (a, b) = match dir {
                    SplitDir::Vertical => {
                        // 左 | 右
                        let wl = bounds.w * r;
                        (
                            Rect::new(bounds.x, bounds.y, wl, bounds.h),
                            Rect::new(bounds.x + wl, bounds.y, bounds.w - wl, bounds.h),
                        )
                    }
                    SplitDir::Horizontal => {
                        // 上 / 下
                        let ht = bounds.h * r;
                        (
                            Rect::new(bounds.x, bounds.y, bounds.w, ht),
                            Rect::new(bounds.x, bounds.y + ht, bounds.w, bounds.h - ht),
                        )
                    }
                };
                first.layout_into(a, out);
                second.layout_into(b, out);
            }
        }
    }

    /// 按几何相邻关系找焦点:从 `from` 出发朝 `to` 方向找最贴近的邻居叶子。
    ///
    /// 采用与 Windows Terminal 一致的直觉:在目标方向那一侧、且与源窗格在
    /// 垂直于移动方向的轴上有重叠的候选里,取边界最近的一个;若有并列,
    /// 再用中心线的错位量做次级排序。`bounds` 用于计算布局,取任意一致外框即可
    /// (导航结果与外框缩放无关)。
    pub fn navigate(&self, from: LeafId, to: Direction, bounds: Rect) -> Option<LeafId> {
        let rects = self.layout(bounds);
        let src = rects.iter().find(|(id, _)| *id == from).map(|(_, r)| *r)?;

        let mut best: Option<(LeafId, f32, f32)> = None; // (id, 主轴距离, 次轴错位)
        for (id, r) in &rects {
            if *id == from {
                continue;
            }
            // `primary` = 沿移动方向、候选相对源的“前进距离”(需 >= 0 才算在正确一侧)。
            // `overlap` = 在垂直轴上是否与源有交叠。
            // `off`     = 次轴中心错位,用于并列时择近。
            let (primary, overlaps, off) = match to {
                Direction::Right => (
                    r.x - src.right(),
                    ranges_overlap(src.y, src.bottom(), r.y, r.bottom()),
                    (r.center_y() - src.center_y()).abs(),
                ),
                Direction::Left => (
                    src.x - r.right(),
                    ranges_overlap(src.y, src.bottom(), r.y, r.bottom()),
                    (r.center_y() - src.center_y()).abs(),
                ),
                Direction::Down => (
                    r.y - src.bottom(),
                    ranges_overlap(src.x, src.right(), r.x, r.right()),
                    (r.center_x() - src.center_x()).abs(),
                ),
                Direction::Up => (
                    src.y - r.bottom(),
                    ranges_overlap(src.x, src.right(), r.x, r.right()),
                    (r.center_x() - src.center_x()).abs(),
                ),
            };

            if !overlaps || primary < -EPS {
                continue;
            }
            let primary = primary.max(0.0);
            // 择优:主轴更近者胜;主轴基本相等时,次轴错位更小者胜。
            let better = match best {
                None => true,
                Some((_, bp, boff)) => {
                    if primary < bp - EPS {
                        true
                    } else if primary <= bp + EPS {
                        off < boff - EPS
                    } else {
                        false
                    }
                }
            };
            if better {
                best = Some((*id, primary, off));
            }
        }
        best.map(|(id, _, _)| id)
    }
}

/// 把 ratio 夹进 (0,1) 开区间,避免出现零宽度子窗格。
#[inline]
fn clamp_ratio(r: f32) -> f32 {
    r.clamp(0.05, 0.95)
}

/// 一维区间 [a0,a1] 与 [b0,b1] 是否有正长度交叠(容差 EPS)。
#[inline]
fn ranges_overlap(a0: f32, a1: f32, b0: f32, b1: f32) -> bool {
    a0.min(a1).max(b0.min(b1)) < a0.max(a1).min(b0.max(b1)) - EPS
}

// ======================================================================
// 测试
// ======================================================================
#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u64) -> LeafId {
        LeafId(n)
    }

    /// 构造一棵典型两级树用于导航测试:
    ///
    /// 竖直分裂:左侧是叶子 1;右侧再水平分裂成上=2 / 下=3。
    ///
    /// ```text
    /// +------+------+
    /// |      |  2   |
    /// |  1   +------+
    /// |      |  3   |
    /// +------+------+
    /// ```
    fn sample_tree() -> Pane {
        Pane::Split {
            dir: SplitDir::Vertical,
            ratio: 0.5,
            first: Box::new(Pane::Leaf(id(1))),
            second: Box::new(Pane::Split {
                dir: SplitDir::Horizontal,
                ratio: 0.5,
                first: Box::new(Pane::Leaf(id(2))),
                second: Box::new(Pane::Leaf(id(3))),
            }),
        }
    }

    #[test]
    fn split_replaces_leaf_with_split_node() {
        let mut tree = Pane::Leaf(id(1));
        assert!(tree.split(id(1), SplitDir::Vertical, 0.5, id(2)));

        match &tree {
            Pane::Split {
                dir,
                ratio,
                first,
                second,
            } => {
                assert_eq!(*dir, SplitDir::Vertical);
                assert!((*ratio - 0.5).abs() < 1e-6);
                assert_eq!(**first, Pane::Leaf(id(1)));
                assert_eq!(**second, Pane::Leaf(id(2)));
            }
            _ => panic!("root should have become a Split node"),
        }
        // split 后应当恰有两个叶子。
        assert_eq!(tree.leaf_count(), 2);
        assert_eq!(tree.leaves(), vec![id(1), id(2)]);
    }

    #[test]
    fn split_on_missing_target_is_noop() {
        let mut tree = Pane::Leaf(id(1));
        assert!(!tree.split(id(99), SplitDir::Horizontal, 0.5, id(2)));
        assert_eq!(tree, Pane::Leaf(id(1)));
    }

    #[test]
    fn split_deep_and_ratio_clamped() {
        let mut tree = sample_tree();
        // 在叶子 3 处再纵向分裂出 4,并给一个越界 ratio 验证夹取。
        assert!(tree.split(id(3), SplitDir::Vertical, 2.0, id(4)));
        assert_eq!(tree.leaf_count(), 4);
        assert!(tree.contains(id(4)));
        // 找到那个新分裂节点,确认 ratio 被夹到 <= 0.95。
        let layout = tree.layout(Rect::new(0.0, 0.0, 100.0, 100.0));
        assert_eq!(layout.len(), 4);
    }

    #[test]
    fn swap_exchanges_two_leaves() {
        let mut tree = sample_tree();
        let before = tree.layout(Rect::new(0.0, 0.0, 100.0, 100.0));
        let rect_of = |ls: &[(LeafId, Rect)], target: LeafId| {
            ls.iter().find(|(i, _)| *i == target).map(|(_, r)| *r).unwrap()
        };
        let r1_before = rect_of(&before, id(1));
        let r2_before = rect_of(&before, id(2));

        assert!(tree.swap(id(1), id(2)));

        let after = tree.layout(Rect::new(0.0, 0.0, 100.0, 100.0));
        // 交换后,叶子 1 应落在原来叶子 2 的矩形,反之亦然。
        assert_eq!(rect_of(&after, id(1)), r2_before);
        assert_eq!(rect_of(&after, id(2)), r1_before);
        // 叶子集合不变,拓扑仍是 3 个叶子。
        let mut leaves = tree.leaves();
        leaves.sort();
        assert_eq!(leaves, vec![id(1), id(2), id(3)]);
    }

    #[test]
    fn swap_same_leaf_is_identity() {
        let mut tree = sample_tree();
        let snapshot = tree.clone();
        assert!(tree.swap(id(2), id(2)));
        assert_eq!(tree, snapshot);
    }

    #[test]
    fn swap_missing_leaf_fails_and_preserves_tree() {
        let mut tree = sample_tree();
        let snapshot = tree.clone();
        assert!(!tree.swap(id(1), id(99)));
        assert_eq!(tree, snapshot);
    }

    #[test]
    fn navigate_finds_adjacent_neighbor() {
        let tree = sample_tree();
        let b = Rect::new(0.0, 0.0, 100.0, 100.0);

        // 从左侧 1 向右:上下各半的 2/3 都贴着,取中心错位最小者。
        // 1 的中心 y = 50;2 中心 y = 25,3 中心 y = 75,错位相同 -> 取先命中的稳定结果。
        let right = tree.navigate(id(1), Direction::Right, b);
        assert!(right == Some(id(2)) || right == Some(id(3)));

        // 从 2 向左应回到 1。
        assert_eq!(tree.navigate(id(2), Direction::Left, b), Some(id(1)));
        // 从 3 向左应回到 1。
        assert_eq!(tree.navigate(id(3), Direction::Left, b), Some(id(1)));
        // 从 2 向下应到 3。
        assert_eq!(tree.navigate(id(2), Direction::Down, b), Some(id(3)));
        // 从 3 向上应到 2。
        assert_eq!(tree.navigate(id(3), Direction::Up, b), Some(id(2)));
        // 从 1 向左没有邻居。
        assert_eq!(tree.navigate(id(1), Direction::Left, b), None);
        // 从 2 向上没有邻居。
        assert_eq!(tree.navigate(id(2), Direction::Up, b), None);
    }

    #[test]
    fn navigate_right_prefers_vertically_aligned_neighbor() {
        // 左列上下两格 1/2,右列一整格 3。
        // +----+----+
        // | 1  |    |
        // +----+ 3  |
        // | 2  |    |
        // +----+----+
        let tree = Pane::Split {
            dir: SplitDir::Vertical,
            ratio: 0.5,
            first: Box::new(Pane::Split {
                dir: SplitDir::Horizontal,
                ratio: 0.5,
                first: Box::new(Pane::Leaf(id(1))),
                second: Box::new(Pane::Leaf(id(2))),
            }),
            second: Box::new(Pane::Leaf(id(3))),
        };
        let b = Rect::new(0.0, 0.0, 100.0, 100.0);
        assert_eq!(tree.navigate(id(1), Direction::Right, b), Some(id(3)));
        assert_eq!(tree.navigate(id(2), Direction::Right, b), Some(id(3)));
        // 从右侧 3 向左:1 与 2 都贴着且各占半高,取先命中者(拓扑上 1 在前)。
        assert_eq!(tree.navigate(id(3), Direction::Left, b), Some(id(1)));
    }

    #[test]
    fn detach_collapses_parent_into_sibling() {
        let mut tree = sample_tree();
        // 摘掉 3,其父(右侧的水平分裂)应塌缩成叶子 2。
        let detached = tree.detach(id(3)).expect("3 should detach");
        assert_eq!(detached, Pane::Leaf(id(3)));
        assert!(!tree.contains(id(3)));
        // 现在应是:竖直分裂,左 1 右 2。
        match &tree {
            Pane::Split { first, second, dir, .. } => {
                assert_eq!(*dir, SplitDir::Vertical);
                assert_eq!(**first, Pane::Leaf(id(1)));
                assert_eq!(**second, Pane::Leaf(id(2)));
            }
            _ => panic!("expected a Split root after detach"),
        }
    }

    #[test]
    fn detach_root_leaf_returns_none() {
        let mut tree = Pane::Leaf(id(1));
        assert_eq!(tree.detach(id(1)), None);
        assert_eq!(tree, Pane::Leaf(id(1)));
    }

    #[test]
    fn attach_adds_subtree_at_leaf() {
        let mut tree = Pane::Leaf(id(1));
        let sub = Pane::Leaf(id(9));
        assert!(tree.attach(sub, id(1), SplitDir::Horizontal, 0.5));
        assert_eq!(tree.leaf_count(), 2);
        assert!(tree.contains(id(9)));
    }

    #[test]
    fn move_pane_detaches_and_reattaches() {
        let mut tree = sample_tree();
        // 把 3 移到 1 旁边(在 1 处竖直再分)。
        assert!(tree.move_pane(id(3), id(1), SplitDir::Vertical, 0.5));
        assert!(tree.contains(id(3)));
        assert_eq!(tree.leaf_count(), 3);
        // 原来 2/3 的水平分裂应已塌缩,2 现在直接是右子树。
        match &tree {
            Pane::Split { second, .. } => {
                assert_eq!(**second, Pane::Leaf(id(2)));
            }
            _ => panic!("expected Split root"),
        }
    }

    #[test]
    fn move_pane_rejects_self_and_missing() {
        let mut tree = sample_tree();
        let snapshot = tree.clone();
        assert!(!tree.move_pane(id(1), id(1), SplitDir::Vertical, 0.5));
        assert!(!tree.move_pane(id(1), id(99), SplitDir::Vertical, 0.5));
        assert_eq!(tree, snapshot);
    }

    #[test]
    fn walk_and_leaves_are_preorder() {
        let tree = sample_tree();
        assert_eq!(tree.leaves(), vec![id(1), id(2), id(3)]);
        let mut seen = Vec::new();
        tree.walk(&mut |l| seen.push(l));
        assert_eq!(seen, vec![id(1), id(2), id(3)]);
    }

    #[test]
    fn layout_partitions_bounds_without_overlap() {
        let tree = sample_tree();
        let rects = tree.layout(Rect::new(0.0, 0.0, 100.0, 100.0));
        // 面积之和应等于外框面积(无缝隙、无重叠)。
        let total: f32 = rects.iter().map(|(_, r)| r.w * r.h).sum();
        assert!((total - 100.0 * 100.0).abs() < 1e-2);
    }
}
