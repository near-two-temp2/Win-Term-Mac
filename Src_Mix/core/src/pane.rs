//! pane —— 窗格二叉树内核逻辑
//!
//! 这是被 `lib.rs` 的 C ABI 层包装的纯逻辑核心。参照 Windows Terminal:
//! 一棵窗格树的每个节点要么是 **叶子**(一个真终端),要么是 **分裂节点**
//! (一个方向 + 一个比例 + first/second 两个子节点)。所有操作都是不依赖
//! 任何宿主/渲染状态的纯函数,便于跨 macOS(Swift)/ Linux(GTK4)复用与测试。
//!
//! 术语约定(避免 horizontal/vertical 的歧义):
//! - [`Orientation::Row`]:两个子节点 **左右** 并排,`first` 在左、`second` 在右。
//! - [`Orientation::Column`]:两个子节点 **上下** 堆叠,`first` 在上、`second` 在下。
//! - `ratio`:`first` 子节点占父区域的比例(0.0~1.0)。
//!
//! 几何坐标(仅用于 [`PaneTree::navigate`] 的相邻判定):单位矩形 `[0,1]×[0,1]`,
//! x 向右为正、y 向下为正(屏幕坐标系)。

use crate::{WtmDirection, WtmPaneId};

/// 浮点比较容差。用于导航时的边缘对齐/重叠判定。
const EPS: f32 = 1e-4;

/// 分裂节点的排列方向。见模块级文档中的术语约定。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Orientation {
    /// 左右并排:`first` 左,`second` 右。
    Row,
    /// 上下堆叠:`first` 上,`second` 下。
    Column,
}

/// 窗格树节点:叶子或分裂节点。
#[derive(Clone, Debug, PartialEq)]
pub enum Pane {
    /// 叶子:承载一个真终端,由宿主用 `id` 关联自己的终端视图。
    Leaf { id: WtmPaneId },
    /// 分裂节点:把一块区域按 `orient` + `ratio` 切成 `first` / `second` 两个子树。
    Split {
        orient: Orientation,
        /// `first` 子节点占比,取值 (0.0, 1.0)。
        ratio: f32,
        first: Box<Pane>,
        second: Box<Pane>,
    },
}

/// 窗格操作错误。C ABI 层会把这些映射为 `WtmStatus`。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PaneError {
    /// 目标叶子在树中不存在。
    PaneNotFound,
    /// 待插入的新叶子 id 已存在于树中(id 必须全局唯一)。
    DuplicateId,
    /// 比例超出 (0.0, 1.0) 开区间。
    InvalidRatio,
    /// 交换/移动的两个目标是同一个叶子。
    SamePane,
    /// 试图摘除整棵树唯一的根叶子。
    CannotDetachRoot,
}

/// 一块矩形区域(单位坐标)。仅用于导航几何计算。
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    /// 整棵树根区域:整个单位矩形。
    const ROOT: Rect = Rect {
        x: 0.0,
        y: 0.0,
        w: 1.0,
        h: 1.0,
    };
}

/// 窗格树。宿主每个 Tab 持有一棵,根节点初始为单个叶子。
#[derive(Clone, Debug, PartialEq)]
pub struct PaneTree {
    root: Pane,
}

impl PaneTree {
    /// 新建一棵树,根为单个叶子 `root_pane`。
    pub fn new(root_pane: WtmPaneId) -> Self {
        PaneTree {
            root: Pane::Leaf { id: root_pane },
        }
    }

    /// 只读访问根节点(供宿主遍历/渲染)。
    pub fn root(&self) -> &Pane {
        &self.root
    }

    /// 叶子数量。
    pub fn leaf_count(&self) -> usize {
        self.root.leaf_count()
    }

    /// 按 **中序**(先 first 后 second)收集全部叶子 id。
    pub fn walk(&self) -> Vec<WtmPaneId> {
        let mut out = Vec::new();
        self.root.walk_leaves(&mut |id| out.push(id));
        out
    }

    /// 树中是否存在叶子 `id`。
    pub fn contains(&self, id: WtmPaneId) -> bool {
        let mut found = false;
        self.root.walk_leaves(&mut |leaf| {
            if leaf == id {
                found = true;
            }
        });
        found
    }

    /// 分裂:把叶子 `target` 换成一个分裂节点,新叶子 `new_pane` 落在 `dir` 一侧。
    ///
    /// `ratio` 是 `first` 子节点占比;方向决定 first/second 与新旧叶子的对应。
    pub fn split(
        &mut self,
        target: WtmPaneId,
        new_pane: WtmPaneId,
        dir: WtmDirection,
        ratio: f32,
    ) -> Result<(), PaneError> {
        if !(EPS..=1.0 - EPS).contains(&ratio) {
            return Err(PaneError::InvalidRatio);
        }
        if self.contains(new_pane) {
            return Err(PaneError::DuplicateId);
        }
        let (orient, first_is_new) = split_layout(dir);
        if split_leaf(&mut self.root, target, new_pane, orient, ratio, first_is_new) {
            Ok(())
        } else {
            Err(PaneError::PaneNotFound)
        }
    }

    /// 交换:互换两个叶子在树中的内容(WT 的 swapPane)。
    ///
    /// 语义为交换叶子承载的终端(即交换 id),保持布局几何不变。
    pub fn swap(&mut self, a: WtmPaneId, b: WtmPaneId) -> Result<(), PaneError> {
        if a == b {
            return Err(PaneError::SamePane);
        }
        if !self.contains(a) || !self.contains(b) {
            return Err(PaneError::PaneNotFound);
        }
        // 单次遍历,每个叶子恰好访问一次;a≠b 保证不会二次翻转。
        self.root.walk_leaves_mut(&mut |id| {
            if *id == a {
                *id = b;
            } else if *id == b {
                *id = a;
            }
        });
        Ok(())
    }

    /// 摘下:把叶子 `id` 从树上移除,其父分裂节点由兄弟子树顶替(塌缩)。
    ///
    /// 这是拖拽移动(detach/attach)的“摘”一半。移除唯一根叶子会报错。
    pub fn detach(&mut self, id: WtmPaneId) -> Result<(), PaneError> {
        if !self.contains(id) {
            return Err(PaneError::PaneNotFound);
        }
        if matches!(self.root, Pane::Leaf { id: rid } if rid == id) {
            return Err(PaneError::CannotDetachRoot);
        }
        // 按值重建:把 id 所在叶子的父节点替换为其兄弟。
        let root = std::mem::replace(&mut self.root, Pane::Leaf { id: 0 });
        let (new_root, removed) = detach_rec(root, id);
        self.root = new_root;
        if removed {
            Ok(())
        } else {
            Err(PaneError::PaneNotFound)
        }
    }

    /// 移动:把叶子 `moving` 摘下,再在叶子 `target` 处按 `dir`/`ratio` 挂回。
    ///
    /// 等价于 WT 的 detach + attach,是拖拽移动窗格的基础操作。
    pub fn move_pane(
        &mut self,
        moving: WtmPaneId,
        target: WtmPaneId,
        dir: WtmDirection,
        ratio: f32,
    ) -> Result<(), PaneError> {
        if moving == target {
            return Err(PaneError::SamePane);
        }
        if !self.contains(moving) || !self.contains(target) {
            return Err(PaneError::PaneNotFound);
        }
        if !(EPS..=1.0 - EPS).contains(&ratio) {
            return Err(PaneError::InvalidRatio);
        }
        // 先摘下 moving(target 一定还在,因为 target≠moving)。
        self.detach(moving)?;
        // 再把 moving 作为新叶子分裂进 target。此时 moving 已不在树中,不会触发 DuplicateId。
        self.split(target, moving, dir, ratio)
    }

    /// 导航:从叶子 `from` 出发,按 `dir` 找几何上紧邻的叶子。
    ///
    /// 无相邻叶子时返回 `None`(例如已在该方向的边界)。
    pub fn navigate(&self, from: WtmPaneId, dir: WtmDirection) -> Option<WtmPaneId> {
        let layout = self.layout();
        let from_rect = layout.iter().find(|(id, _)| *id == from)?.1;

        let mut best: Option<(WtmPaneId, f32, f32)> = None; // (id, 距离, 垂直重叠量)
        for &(id, r) in &layout {
            if id == from {
                continue;
            }
            let (on_side, distance, overlap) = neighbor_metrics(dir, &from_rect, &r);
            if !on_side || overlap <= EPS {
                continue;
            }
            // 优先更近(距离小),距离相当再取重叠更大的。
            let better = match best {
                None => true,
                Some((_, bd, bo)) => {
                    distance < bd - EPS || ((distance - bd).abs() <= EPS && overlap > bo)
                }
            };
            if better {
                best = Some((id, distance, overlap));
            }
        }
        best.map(|(id, _, _)| id)
    }

    /// 计算每个叶子的矩形区域(单位坐标)。供导航与宿主渲染布局参考。
    pub fn layout(&self) -> Vec<(WtmPaneId, Rect)> {
        let mut out = Vec::new();
        layout_rec(&self.root, Rect::ROOT, &mut out);
        out
    }
}

impl Pane {
    /// 便捷构造叶子。
    pub fn leaf(id: WtmPaneId) -> Pane {
        Pane::Leaf { id }
    }

    /// 该节点是否为 id 恰为 `id` 的叶子。
    fn is_leaf_with(&self, id: WtmPaneId) -> bool {
        matches!(self, Pane::Leaf { id: lid } if *lid == id)
    }

    /// 叶子数量。
    pub fn leaf_count(&self) -> usize {
        match self {
            Pane::Leaf { .. } => 1,
            Pane::Split { first, second, .. } => first.leaf_count() + second.leaf_count(),
        }
    }

    /// 中序遍历所有叶子 id(只读)。
    fn walk_leaves(&self, visit: &mut dyn FnMut(WtmPaneId)) {
        match self {
            Pane::Leaf { id } => visit(*id),
            Pane::Split { first, second, .. } => {
                first.walk_leaves(visit);
                second.walk_leaves(visit);
            }
        }
    }

    /// 中序遍历所有叶子 id(可写,用于 swap)。
    fn walk_leaves_mut(&mut self, visit: &mut dyn FnMut(&mut WtmPaneId)) {
        match self {
            Pane::Leaf { id } => visit(id),
            Pane::Split { first, second, .. } => {
                first.walk_leaves_mut(visit);
                second.walk_leaves_mut(visit);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 纯函数辅助
// ---------------------------------------------------------------------------

/// 方向 → (分裂排列, 新叶子是否为 first)。
///
/// - Left  : 左右排列,新叶子在左(first)。
/// - Right : 左右排列,新叶子在右(second)。
/// - Up    : 上下排列,新叶子在上(first)。
/// - Down  : 上下排列,新叶子在下(second)。
fn split_layout(dir: WtmDirection) -> (Orientation, bool) {
    match dir {
        WtmDirection::Left => (Orientation::Row, true),
        WtmDirection::Right => (Orientation::Row, false),
        WtmDirection::Up => (Orientation::Column, true),
        WtmDirection::Down => (Orientation::Column, false),
    }
}

/// 就地把 `target` 叶子替换为分裂节点。命中返回 true。
fn split_leaf(
    node: &mut Pane,
    target: WtmPaneId,
    new_id: WtmPaneId,
    orient: Orientation,
    ratio: f32,
    first_is_new: bool,
) -> bool {
    match node {
        Pane::Leaf { id } if *id == target => {
            let existing = *id;
            let (first_id, second_id) = if first_is_new {
                (new_id, existing)
            } else {
                (existing, new_id)
            };
            *node = Pane::Split {
                orient,
                ratio,
                first: Box::new(Pane::Leaf { id: first_id }),
                second: Box::new(Pane::Leaf { id: second_id }),
            };
            true
        }
        Pane::Leaf { .. } => false,
        Pane::Split { first, second, .. } => {
            split_leaf(first, target, new_id, orient, ratio, first_is_new)
                || split_leaf(second, target, new_id, orient, ratio, first_is_new)
        }
    }
}

/// 按值递归摘除叶子 `id`:其父分裂节点被兄弟子树顶替。返回 (新子树, 是否已摘除)。
///
/// 顶层调用已保证 `id` 不是根叶子,因此叶子分支总能在某个父 Split 内被命中。
fn detach_rec(node: Pane, id: WtmPaneId) -> (Pane, bool) {
    match node {
        Pane::Leaf { .. } => (node, false),
        Pane::Split {
            orient,
            ratio,
            first,
            second,
        } => {
            if first.is_leaf_with(id) {
                return (*second, true); // 兄弟(second)顶替父节点
            }
            if second.is_leaf_with(id) {
                return (*first, true); // 兄弟(first)顶替父节点
            }
            let (new_first, removed) = detach_rec(*first, id);
            if removed {
                return (
                    Pane::Split {
                        orient,
                        ratio,
                        first: Box::new(new_first),
                        second,
                    },
                    true,
                );
            }
            let (new_second, removed) = detach_rec(*second, id);
            (
                Pane::Split {
                    orient,
                    ratio,
                    first: Box::new(new_first),
                    second: Box::new(new_second),
                },
                removed,
            )
        }
    }
}

/// 递归给每个叶子分配矩形区域。
fn layout_rec(node: &Pane, area: Rect, out: &mut Vec<(WtmPaneId, Rect)>) {
    match node {
        Pane::Leaf { id } => out.push((*id, area)),
        Pane::Split {
            orient,
            ratio,
            first,
            second,
        } => {
            let (fa, sa) = split_rect(area, *orient, *ratio);
            layout_rec(first, fa, out);
            layout_rec(second, sa, out);
        }
    }
}

/// 把矩形按方向/比例切成 (first 区, second 区)。
fn split_rect(area: Rect, orient: Orientation, ratio: f32) -> (Rect, Rect) {
    match orient {
        Orientation::Row => {
            let fw = area.w * ratio;
            (
                Rect {
                    x: area.x,
                    y: area.y,
                    w: fw,
                    h: area.h,
                },
                Rect {
                    x: area.x + fw,
                    y: area.y,
                    w: area.w - fw,
                    h: area.h,
                },
            )
        }
        Orientation::Column => {
            let fh = area.h * ratio;
            (
                Rect {
                    x: area.x,
                    y: area.y,
                    w: area.w,
                    h: fh,
                },
                Rect {
                    x: area.x,
                    y: area.y + fh,
                    w: area.w,
                    h: area.h - fh,
                },
            )
        }
    }
}

/// 一维区间 `[a0,a1]` 与 `[b0,b1]` 的重叠长度(可能为 0)。
fn overlap_1d(a0: f32, a1: f32, b0: f32, b1: f32) -> f32 {
    (a1.min(b1) - a0.max(b0)).max(0.0)
}

/// 计算候选矩形相对 from 在 `dir` 方向的邻接指标。
///
/// 返回 (是否位于该侧, 沿方向的间隙距离, 垂直方向重叠量)。
fn neighbor_metrics(dir: WtmDirection, from: &Rect, cand: &Rect) -> (bool, f32, f32) {
    let from_r = from.x + from.w;
    let from_b = from.y + from.h;
    let cand_r = cand.x + cand.w;
    let cand_b = cand.y + cand.h;
    match dir {
        WtmDirection::Right => {
            let on_side = cand.x >= from_r - EPS;
            let overlap = overlap_1d(from.y, from_b, cand.y, cand_b);
            (on_side, cand.x - from_r, overlap)
        }
        WtmDirection::Left => {
            let on_side = cand_r <= from.x + EPS;
            let overlap = overlap_1d(from.y, from_b, cand.y, cand_b);
            (on_side, from.x - cand_r, overlap)
        }
        WtmDirection::Down => {
            let on_side = cand.y >= from_b - EPS;
            let overlap = overlap_1d(from.x, from_r, cand.x, cand_r);
            (on_side, cand.y - from_b, overlap)
        }
        WtmDirection::Up => {
            let on_side = cand_b <= from.y + EPS;
            let overlap = overlap_1d(from.x, from_r, cand.x, cand_r);
            (on_side, from.y - cand_b, overlap)
        }
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // 构造一个横向三分布局:1 | 2 | 3(从左到右),便于导航测试。
    //   root = Row(ratio .5)[ 1 , Row(ratio .5)[ 2 , 3 ] ]
    fn row_three() -> PaneTree {
        let mut t = PaneTree::new(1);
        t.split(1, 2, WtmDirection::Right, 0.5).unwrap();
        t.split(2, 3, WtmDirection::Right, 0.5).unwrap();
        t
    }

    #[test]
    fn new_is_single_leaf() {
        let t = PaneTree::new(7);
        assert_eq!(t.leaf_count(), 1);
        assert_eq!(t.walk(), vec![7]);
        assert!(t.contains(7));
        assert!(!t.contains(8));
    }

    #[test]
    fn split_right_makes_split_node() {
        let mut t = PaneTree::new(1);
        t.split(1, 2, WtmDirection::Right, 0.5).unwrap();
        assert_eq!(t.leaf_count(), 2);
        assert_eq!(t.walk(), vec![1, 2]); // 1 在 first(左), 2 在 second(右)
        match t.root() {
            Pane::Split { orient, first, second, .. } => {
                assert_eq!(*orient, Orientation::Row);
                assert!(first.is_leaf_with(1));
                assert!(second.is_leaf_with(2));
            }
            _ => panic!("root 应为分裂节点"),
        }
    }

    #[test]
    fn split_left_puts_new_first() {
        let mut t = PaneTree::new(1);
        t.split(1, 2, WtmDirection::Left, 0.5).unwrap();
        assert_eq!(t.walk(), vec![2, 1]); // 新叶子 2 在左(first)
    }

    #[test]
    fn split_up_and_down_orientation() {
        let mut t = PaneTree::new(1);
        t.split(1, 2, WtmDirection::Down, 0.3).unwrap();
        match t.root() {
            Pane::Split { orient, first, second, .. } => {
                assert_eq!(*orient, Orientation::Column);
                assert!(first.is_leaf_with(1)); // Down: 旧在上
                assert!(second.is_leaf_with(2));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn split_rejects_bad_ratio_and_missing_target() {
        let mut t = PaneTree::new(1);
        assert_eq!(t.split(1, 2, WtmDirection::Right, 0.0), Err(PaneError::InvalidRatio));
        assert_eq!(t.split(1, 2, WtmDirection::Right, 1.0), Err(PaneError::InvalidRatio));
        assert_eq!(t.split(99, 2, WtmDirection::Right, 0.5), Err(PaneError::PaneNotFound));
    }

    #[test]
    fn split_rejects_duplicate_id() {
        let mut t = PaneTree::new(1);
        t.split(1, 2, WtmDirection::Right, 0.5).unwrap();
        assert_eq!(t.split(2, 1, WtmDirection::Right, 0.5), Err(PaneError::DuplicateId));
    }

    #[test]
    fn swap_exchanges_ids_keeps_shape() {
        let mut t = row_three();
        let before = t.layout();
        t.swap(1, 3).unwrap();
        assert_eq!(t.walk(), vec![3, 2, 1]); // 内容交换
        // 布局几何(矩形集合)不变,只是 id 互换。
        let after = t.layout();
        let rects_before: Vec<Rect> = before.iter().map(|(_, r)| *r).collect();
        let rects_after: Vec<Rect> = after.iter().map(|(_, r)| *r).collect();
        assert_eq!(rects_before, rects_after);
    }

    #[test]
    fn swap_errors() {
        let mut t = row_three();
        assert_eq!(t.swap(1, 1), Err(PaneError::SamePane));
        assert_eq!(t.swap(1, 99), Err(PaneError::PaneNotFound));
    }

    #[test]
    fn navigate_horizontal_chain() {
        let t = row_three(); // 1 | 2 | 3
        assert_eq!(t.navigate(1, WtmDirection::Right), Some(2));
        assert_eq!(t.navigate(2, WtmDirection::Right), Some(3));
        assert_eq!(t.navigate(3, WtmDirection::Right), None); // 已在右边界
        assert_eq!(t.navigate(2, WtmDirection::Left), Some(1));
        assert_eq!(t.navigate(1, WtmDirection::Left), None);
        // 纯横向布局中上下没有邻居。
        assert_eq!(t.navigate(2, WtmDirection::Up), None);
        assert_eq!(t.navigate(2, WtmDirection::Down), None);
    }

    #[test]
    fn navigate_grid_layout() {
        // 上半:1 | 2 ; 下半:3 (整行)。
        //   root = Column(.5)[ Row(.5)[1,2] , 3 ]
        let mut t = PaneTree::new(1);
        t.split(1, 3, WtmDirection::Down, 0.5).unwrap(); // 1 上, 3 下
        t.split(1, 2, WtmDirection::Right, 0.5).unwrap(); // 上半再切成 1|2
        assert_eq!(t.navigate(1, WtmDirection::Right), Some(2));
        assert_eq!(t.navigate(1, WtmDirection::Down), Some(3));
        assert_eq!(t.navigate(2, WtmDirection::Down), Some(3));
        assert_eq!(t.navigate(3, WtmDirection::Up), Some(1)); // 3 的上方与 1、2 都相邻,取更近/重叠更大者
    }

    #[test]
    fn detach_collapses_parent() {
        let mut t = row_three(); // Row[1, Row[2,3]]
        t.detach(3).unwrap(); // 兄弟 2 顶替内层 Row
        assert_eq!(t.leaf_count(), 2);
        assert_eq!(t.walk(), vec![1, 2]);
        assert!(!t.contains(3));
    }

    #[test]
    fn detach_root_leaf_errors() {
        let mut t = PaneTree::new(1);
        assert_eq!(t.detach(1), Err(PaneError::CannotDetachRoot));
        assert_eq!(t.detach(99), Err(PaneError::PaneNotFound));
    }

    #[test]
    fn move_pane_relocates() {
        let mut t = row_three(); // 1 | 2 | 3
        // 把 3 移到 1 的下方。
        t.move_pane(3, 1, WtmDirection::Down, 0.5).unwrap();
        assert_eq!(t.leaf_count(), 3);
        assert!(t.contains(3));
        // 现在 1 与 3 上下相邻。
        assert_eq!(t.navigate(1, WtmDirection::Down), Some(3));
        assert_eq!(t.navigate(3, WtmDirection::Up), Some(1));
    }

    #[test]
    fn move_pane_errors() {
        let mut t = row_three();
        assert_eq!(t.move_pane(1, 1, WtmDirection::Down, 0.5), Err(PaneError::SamePane));
        assert_eq!(t.move_pane(1, 99, WtmDirection::Down, 0.5), Err(PaneError::PaneNotFound));
    }

    #[test]
    fn walk_lists_all_leaves_in_order() {
        let t = row_three();
        assert_eq!(t.walk(), vec![1, 2, 3]);
        assert_eq!(t.leaf_count(), 3);
    }

    #[test]
    fn layout_rects_partition_unit_square() {
        let t = row_three();
        let area: f32 = t.layout().iter().map(|(_, r)| r.w * r.h).sum();
        assert!((area - 1.0).abs() < 1e-3, "叶子矩形面积之和应为 1,实际 {area}");
    }
}
