//! panes —— Linux(GTK4)窗格布局:把内核窗格二叉树映射为嵌套 GtkPaned
//!
//! 定位:这是「panes」角色的产物,负责“布局与交互”这一层:
//!   - 把一棵窗格二叉树(叶子 = 一个终端 TermView,分裂节点 = 方向 + 比例 + 两子树)
//!     递归渲染成嵌套的 `gtk4::Paned`;
//!   - 处理键位:向右/向下拆分(Alt+Shift+±)、切焦点(Alt+方向)、调整比例
//!     (Alt+Shift+方向);
//!   - 分隔条被用户拖动时,把新比例写回布局镜像,rebuild 时不丢失。
//!
//! 与内核的关系:窗格树的“真相”在共享 Rust 内核 `wintermac_core`(C ABI:见
//! core/src/lib.rs 的 `wtm_tree_*`)里。本模块维护一份 **宿主侧镜像** [`LayoutNode`]
//! ——因为内核当前只导出 new/free/split/swap/navigate,并未导出“读取整棵树结构”的
//! 接口,宿主无法据内核直接重建 GtkPaned 层级,故必须自持一份影子树来渲染。
//! 这与 macOS 端 `SplitTree.swift` 的做法一致:内核接通前,本地镜像即权威;接通后,
//! 本地镜像退化为“据内核返回结果重建 UI 的缓存”。每处该改走内核的地方都标了
//! `TODO(集成)`,把镜像的就地修改替换成对应的 `ffi::wtm_tree_*` 调用即可,
//! 本模块对外 API 不变。
//!
//! ---------------------------------------------------------------------------
//! integrator(main.rs / 集成 agent)需要如何调用我:
//!
//! 1) 在 main.rs 顶部加模块声明(与 termview 同级):
//!        mod termview;
//!        mod panes;
//!
//! 2) 在 build_ui 里用它替换现在的 GtkPaned + 两个 make_placeholder_pane。最简改法:
//!        let layout = panes::PaneLayout::new(0);   // 0 = 根叶子 id
//!        window.set_child(Some(&layout.container()));
//!        // 关键:layout 必须存活(它持有 Rc 内部状态与全部 TermView)。
//!        // 建议把它挂在某个随窗口存活的地方,例如:
//!        //     window.connect_destroy(move |_| drop(&layout));  // 或存进 app 级结构
//!        // 最简单可靠:用 Box::leak / 存入一个 static/OnceCell,或存进 window 的
//!        // unsafe qdata。此处不替你决定,交给集成 agent。
//!
//! 3) 键位控制器由 PaneLayout 自行安装在 container 上(捕获阶段),无需 main.rs 额外接线。
//!    命令面板(Ctrl+Shift+P)、swap/move 仍是别处的 TODO,不在本模块职责内。
//!
//! 4) 待内核 cdylib 就绪、ffi 的 `#[link]` 打开后:把本文件里 `TODO(集成)` 标出的
//!    三处(split / navigate / resize)从“改镜像”改为“调 ffi::wtm_tree_*,再据结果
//!    更新镜像并 rebuild”。届时 [`Inner::handle`] 存内核句柄。
//! ---------------------------------------------------------------------------

use gtk4::prelude::*;
use gtk4::{
    gdk, glib, Box as GtkBox, EventControllerFocus, EventControllerKey, Orientation, Paned,
    PropagationPhase, Widget,
};

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::ffi::{WtmDirection, WtmPaneId};
use crate::termview::TermView;

/// 拆分/调整比例的默认步进与钳制范围。
const DEFAULT_RATIO: f64 = 0.5;
const RESIZE_STEP: f64 = 0.05;
const RATIO_MIN: f64 = 0.05;
const RATIO_MAX: f64 = 0.95;

/// 浮点容差(导航几何判定用)。
const EPS: f64 = 1e-4;

// ===========================================================================
// 宿主侧窗格树镜像
// ===========================================================================

/// 窗格树节点(宿主镜像)。叶子承载一个终端,分裂节点持方向 + 比例 + 两子树。
///
/// `key` 是每个分裂节点的稳定标识,用于在“拖动分隔条 → 写回比例”时定位到具体节点
/// (rebuild 会重建全部 GtkPaned 控件,但 key 跟着镜像走,不随控件重建而变)。
#[derive(Clone)]
enum LayoutNode {
    Leaf(WtmPaneId),
    Split {
        /// GtkPaned 朝向:Horizontal = 左右并排(竖分隔条),Vertical = 上下堆叠。
        orient: Orientation,
        /// first 子节点占比,(0,1)。
        ratio: f64,
        /// 分裂节点稳定 id。
        key: u64,
        first: Box<LayoutNode>,
        second: Box<LayoutNode>,
    },
}

/// 单位坐标矩形,仅用于导航几何。
#[derive(Clone, Copy)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl LayoutNode {
    /// 就地把 `target` 叶子替换为分裂节点,新叶子 `new_id` 落在 `dir` 一侧。命中返回 true。
    fn split_leaf(
        &mut self,
        target: WtmPaneId,
        new_id: WtmPaneId,
        dir: WtmDirection,
        ratio: f64,
        key: u64,
    ) -> bool {
        match self {
            LayoutNode::Leaf(id) if *id == target => {
                let (orient, new_is_first) = split_layout(dir);
                let existing = LayoutNode::Leaf(*id);
                let fresh = LayoutNode::Leaf(new_id);
                let (first, second) = if new_is_first {
                    (fresh, existing)
                } else {
                    (existing, fresh)
                };
                *self = LayoutNode::Split {
                    orient,
                    ratio,
                    key,
                    first: Box::new(first),
                    second: Box::new(second),
                };
                true
            }
            LayoutNode::Leaf(_) => false,
            LayoutNode::Split { first, second, .. } => {
                first.split_leaf(target, new_id, dir, ratio, key)
                    || second.split_leaf(target, new_id, dir, ratio, key)
            }
        }
    }

    /// 把 key 指定的分裂节点比例设为 `r`(拖动分隔条时写回)。
    fn set_ratio(&mut self, key: u64, r: f64) {
        if let LayoutNode::Split {
            key: k,
            ratio,
            first,
            second,
            ..
        } = self
        {
            if *k == key {
                *ratio = r.clamp(RATIO_MIN, RATIO_MAX);
                return;
            }
            first.set_ratio(key, r);
            second.set_ratio(key, r);
        }
    }

    /// 调整比例:找到包含 `id` 的、方向为 `want` 的 **最近祖先分裂节点**,把其比例
    /// 加上 `delta`。返回子树是否包含 `id`。`done` 保证只改最近的那个。
    ///
    /// TODO(集成/语义): 精确的 WT 语义应“朝方向扩大焦点窗格”,符号取决于焦点在
    /// first 还是 second 侧。这里统一 Right/Down 增、Left/Up 减,视觉上可用,细节留后续。
    fn nudge_ratio(&mut self, id: WtmPaneId, want: Orientation, delta: f64, done: &mut bool) -> bool {
        match self {
            LayoutNode::Leaf(leaf) => *leaf == id,
            LayoutNode::Split {
                orient,
                ratio,
                first,
                second,
                ..
            } => {
                let in_first = first.nudge_ratio(id, want, delta, done);
                let contains = in_first || second.nudge_ratio(id, want, delta, done);
                if contains && !*done && *orient == want {
                    *ratio = (*ratio + delta).clamp(RATIO_MIN, RATIO_MAX);
                    *done = true;
                }
                contains
            }
        }
    }

    /// 计算每个叶子的矩形(单位坐标),供导航判定。
    fn layout_rects(&self) -> Vec<(WtmPaneId, Rect)> {
        let mut out = Vec::new();
        layout_rec(
            self,
            Rect {
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            },
            &mut out,
        );
        out
    }

    /// 导航:从 `from` 叶子出发,按 `dir` 找几何相邻叶子(与内核 navigate 同算法)。
    fn navigate(&self, from: WtmPaneId, dir: WtmDirection) -> Option<WtmPaneId> {
        let rects = self.layout_rects();
        let from_rect = rects.iter().find(|(id, _)| *id == from)?.1;
        let mut best: Option<(WtmPaneId, f64, f64)> = None; // (id, 距离, 重叠)
        for &(id, r) in &rects {
            if id == from {
                continue;
            }
            let (on_side, distance, overlap) = neighbor_metrics(dir, &from_rect, &r);
            if !on_side || overlap <= EPS {
                continue;
            }
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
}

/// 方向 → (GtkPaned 朝向, 新叶子是否为 first)。语义与内核 `split_layout` 一致。
fn split_layout(dir: WtmDirection) -> (Orientation, bool) {
    match dir {
        WtmDirection::Left => (Orientation::Horizontal, true),
        WtmDirection::Right => (Orientation::Horizontal, false),
        WtmDirection::Up => (Orientation::Vertical, true),
        WtmDirection::Down => (Orientation::Vertical, false),
    }
}

/// 递归给每个叶子分配矩形。
fn layout_rec(node: &LayoutNode, area: Rect, out: &mut Vec<(WtmPaneId, Rect)>) {
    match node {
        LayoutNode::Leaf(id) => out.push((*id, area)),
        LayoutNode::Split {
            orient,
            ratio,
            first,
            second,
            ..
        } => {
            let (fa, sa) = split_rect(area, *orient, *ratio);
            layout_rec(first, fa, out);
            layout_rec(second, sa, out);
        }
    }
}

/// 把矩形按朝向/比例切成 (first 区, second 区)。
fn split_rect(a: Rect, orient: Orientation, ratio: f64) -> (Rect, Rect) {
    match orient {
        // 左右并排。
        Orientation::Horizontal => {
            let fw = a.w * ratio;
            (
                Rect { x: a.x, y: a.y, w: fw, h: a.h },
                Rect { x: a.x + fw, y: a.y, w: a.w - fw, h: a.h },
            )
        }
        // 上下堆叠。
        _ => {
            let fh = a.h * ratio;
            (
                Rect { x: a.x, y: a.y, w: a.w, h: fh },
                Rect { x: a.x, y: a.y + fh, w: a.w, h: a.h - fh },
            )
        }
    }
}

/// 一维重叠长度。
fn overlap_1d(a0: f64, a1: f64, b0: f64, b1: f64) -> f64 {
    (a1.min(b1) - a0.max(b0)).max(0.0)
}

/// 候选矩形相对 from 在 dir 方向的邻接指标:(是否位于该侧, 间隙距离, 垂直重叠)。
fn neighbor_metrics(dir: WtmDirection, from: &Rect, cand: &Rect) -> (bool, f64, f64) {
    let from_r = from.x + from.w;
    let from_b = from.y + from.h;
    let cand_r = cand.x + cand.w;
    let cand_b = cand.y + cand.h;
    match dir {
        WtmDirection::Right => (
            cand.x >= from_r - EPS,
            cand.x - from_r,
            overlap_1d(from.y, from_b, cand.y, cand_b),
        ),
        WtmDirection::Left => (
            cand_r <= from.x + EPS,
            from.x - cand_r,
            overlap_1d(from.y, from_b, cand.y, cand_b),
        ),
        WtmDirection::Down => (
            cand.y >= from_b - EPS,
            cand.y - from_b,
            overlap_1d(from.x, from_r, cand.x, cand_r),
        ),
        WtmDirection::Up => (
            cand_b <= from.y + EPS,
            from.y - cand_b,
            overlap_1d(from.x, from_r, cand.x, cand_r),
        ),
    }
}

// ===========================================================================
// 布局控制器
// ===========================================================================

/// 内部可变状态。用 `Rc<RefCell<_>>` 在各 GTK 回调间共享。
struct Inner {
    /// 窗格树宿主镜像(内核接通前即权威)。
    tree: LayoutNode,
    /// 叶子 id → 终端视图。持有 TermView 以保活(GTK 只对控件持引用计数)。
    views: HashMap<WtmPaneId, TermView>,
    /// 当前焦点叶子。
    focused: WtmPaneId,
    /// 下一个叶子 id。TODO(集成): id 分配策略需与内核/其它宿主约定一致。
    next_id: WtmPaneId,
    /// 下一个分裂节点 key。
    next_key: u64,
    /// 外层稳定容器,rebuild 时把新根控件塞进它。
    container: GtkBox,
    // TODO(集成): 接通内核后在此持句柄:handle: *mut crate::ffi::WtmTree,
    //   new() 里 ffi::wtm_tree_new(root),Drop 里 ffi::wtm_tree_free(handle)。
}

/// 窗格布局:对外句柄。持有内部状态与外层容器。**必须保持存活**(见文件顶部说明)。
pub struct PaneLayout {
    inner: Rc<RefCell<Inner>>,
    container: GtkBox,
}

impl PaneLayout {
    /// 新建布局,根为单个叶子 `root`,并立刻 spawn 其终端。
    pub fn new(root: WtmPaneId) -> Self {
        let container = GtkBox::new(Orientation::Vertical, 0);
        container.set_hexpand(true);
        container.set_vexpand(true);

        let inner = Rc::new(RefCell::new(Inner {
            tree: LayoutNode::Leaf(root),
            views: HashMap::new(),
            focused: root,
            next_id: root + 1,
            next_key: 1,
            container: container.clone(),
        }));

        // TODO(集成): inner.borrow_mut().handle = unsafe { ffi::wtm_tree_new(root) };

        insert_view(&inner, root);
        rebuild(&inner);
        install_keys(&inner, &container);

        // 初始聚焦根叶子,使键盘直接落到终端。
        if let Some(v) = inner.borrow().views.get(&root) {
            v.widget().grab_focus();
        }

        PaneLayout { inner, container }
    }

    /// 返回可放进窗口(`window.set_child`)的顶层控件。
    pub fn container(&self) -> Widget {
        self.container.clone().upcast()
    }

    /// 当前焦点叶子 id(供命令面板 / 宿主查询)。
    pub fn focused(&self) -> WtmPaneId {
        self.inner.borrow().focused
    }
}

// ---------------------------------------------------------------------------
// 自由函数:所有可变操作都取 `&Rc<RefCell<Inner>>`,严格控制借用不跨 rebuild。
// ---------------------------------------------------------------------------

/// 新建一个终端视图并安装“聚焦即更新 focused”的控制器,存入 views。
fn insert_view(rc: &Rc<RefCell<Inner>>, id: WtmPaneId) {
    let view = TermView::new(id);
    let widget = view.widget().clone();

    // 该终端获得焦点时,把它记为当前焦点叶子(供 Alt+方向导航基准 / 拆分目标)。
    let focus = EventControllerFocus::new();
    let rc_focus = rc.clone();
    focus.connect_enter(move |_| {
        if let Ok(mut inner) = rc_focus.try_borrow_mut() {
            inner.focused = id;
        }
    });
    widget.add_controller(focus);

    rc.borrow_mut().views.insert(id, view);
}

/// 拆分当前焦点窗格:新叶子落在 `dir` 一侧,默认对半。
fn do_split(rc: &Rc<RefCell<Inner>>, dir: WtmDirection) {
    let new_id = {
        let mut inner = rc.borrow_mut();
        let target = inner.focused;
        let new_id = inner.next_id;
        let key = inner.next_key;

        // TODO(集成): 走内核 —— 先 ffi::wtm_tree_split(handle, target, new_id, dir, 0.5),
        //   状态为 Ok 再更新镜像;失败则不分配。此处直接改镜像。
        if !inner.tree.split_leaf(target, new_id, dir, DEFAULT_RATIO, key) {
            return; // target 不在树中(理论上不会发生)
        }
        inner.next_id += 1;
        inner.next_key += 1;
        inner.focused = new_id;
        new_id
    };

    insert_view(rc, new_id);
    rebuild(rc);

    if let Some(v) = rc.borrow().views.get(&new_id) {
        v.widget().grab_focus();
    }
}

/// 切焦点:按 `dir` 找几何相邻叶子,聚焦之(不改树,无需 rebuild)。
fn do_navigate(rc: &Rc<RefCell<Inner>>, dir: WtmDirection) {
    let target = {
        let inner = rc.borrow();
        // TODO(集成): 走内核 —— ffi::wtm_tree_navigate(handle, focused, dir, &mut out)。
        inner.tree.navigate(inner.focused, dir)
    };
    if let Some(t) = target {
        rc.borrow_mut().focused = t;
        if let Some(v) = rc.borrow().views.get(&t) {
            v.widget().grab_focus();
        }
    }
}

/// 调整大小:按 `dir` 微调焦点所属最近匹配分裂节点的比例,再 rebuild 应用。
fn do_resize(rc: &Rc<RefCell<Inner>>, dir: WtmDirection) {
    {
        let mut inner = rc.borrow_mut();
        let focused = inner.focused;
        // Left/Right 调左右分裂(Horizontal);Up/Down 调上下分裂(Vertical)。
        let (want, delta) = match dir {
            WtmDirection::Left => (Orientation::Horizontal, -RESIZE_STEP),
            WtmDirection::Right => (Orientation::Horizontal, RESIZE_STEP),
            WtmDirection::Up => (Orientation::Vertical, -RESIZE_STEP),
            WtmDirection::Down => (Orientation::Vertical, RESIZE_STEP),
        };
        // TODO(集成): 内核暂无 set-ratio API(见 keymap.md),故只改镜像;
        //   将来内核补 `wtm_tree_resize(handle, pane, dir, delta)` 后改走内核。
        let mut done = false;
        inner.tree.nudge_ratio(focused, want, delta, &mut done);
    }
    rebuild(rc);
}

/// 据镜像树重建 GtkPaned 层级,塞进外层容器。复用已存在的 TermView 控件(重新挂载)。
fn rebuild(rc: &Rc<RefCell<Inner>>) {
    let (container, root_widget) = {
        let inner = rc.borrow();
        // 先把所有叶子控件从旧父节点摘下,让它们可被重新挂载(GTK 要求控件无父才能 set child)。
        // TermView 仍被 views 持有,不会因摘除而销毁。
        for v in inner.views.values() {
            let w = v.widget();
            if w.parent().is_some() {
                w.unparent();
            }
        }
        let root = build_node(rc, &inner, &inner.tree);
        (inner.container.clone(), root)
    };

    // 清掉容器里的旧根(此时其后代叶子已被摘走),挂上新根。
    while let Some(child) = container.first_child() {
        container.remove(&child);
    }
    container.append(&root_widget);
}

/// 递归把镜像节点构造为 GTK 控件:叶子 → 复用 TermView 控件;分裂 → GtkPaned。
fn build_node(rc: &Rc<RefCell<Inner>>, inner: &Inner, node: &LayoutNode) -> Widget {
    match node {
        LayoutNode::Leaf(id) => inner
            .views
            .get(id)
            .expect("每个叶子都应有对应的 TermView")
            .widget()
            .clone(),

        LayoutNode::Split {
            orient,
            ratio,
            key,
            first,
            second,
        } => {
            let paned = Paned::new(*orient);
            paned.set_wide_handle(true);
            paned.set_hexpand(true);
            paned.set_vexpand(true);
            paned.set_resize_start_child(true);
            paned.set_resize_end_child(true);

            let start = build_node(rc, inner, first);
            let end = build_node(rc, inner, second);
            paned.set_start_child(Some(&start));
            paned.set_end_child(Some(&end));

            // 初始位置:控件映射(map)后才有真实尺寸,故延到 idle 里按比例设分隔条位置。
            let orient_for_map = *orient;
            let ratio_for_map = *ratio;
            paned.connect_map(move |p| {
                let p = p.clone();
                glib::idle_add_local_once(move || {
                    let dim = if orient_for_map == Orientation::Horizontal {
                        p.width()
                    } else {
                        p.height()
                    };
                    if dim > 1 {
                        p.set_position((dim as f64 * ratio_for_map) as i32);
                    }
                });
            });

            // 用户拖动分隔条:把新比例写回镜像,rebuild 时不丢失。
            let rc_notify = rc.clone();
            let orient_for_notify = *orient;
            let key_for_notify = *key;
            paned.connect_position_notify(move |p| {
                let dim = if orient_for_notify == Orientation::Horizontal {
                    p.width()
                } else {
                    p.height()
                };
                if dim > 1 {
                    let r = (p.position() as f64 / dim as f64).clamp(RATIO_MIN, RATIO_MAX);
                    if let Ok(mut inner) = rc_notify.try_borrow_mut() {
                        inner.tree.set_ratio(key_for_notify, r);
                    }
                }
            });

            paned.upcast()
        }
    }
}

/// 安装键位控制器(捕获阶段,抢在终端消费键之前):
///   Alt+Shift+±   → 向右 / 向下拆分
///   Alt+方向      → 切焦点
///   Alt+Shift+方向 → 调整比例
fn install_keys(rc: &Rc<RefCell<Inner>>, container: &GtkBox) {
    let controller = EventControllerKey::new();
    // 捕获阶段:VTE 终端会吞掉大量按键,须在其之前拦截我们的窗格快捷键。
    controller.set_propagation_phase(PropagationPhase::Capture);

    let rc = rc.clone();
    controller.connect_key_pressed(move |_, keyval, _keycode, state| {
        let alt = state.contains(gdk::ModifierType::ALT_MASK);
        if !alt {
            return glib::Propagation::Proceed;
        }
        let shift = state.contains(gdk::ModifierType::SHIFT_MASK);
        use gdk::Key;

        if shift {
            // Alt+Shift+方向 → 调整比例;Alt+Shift+± → 拆分。
            match keyval {
                Key::Left => {
                    do_resize(&rc, WtmDirection::Left);
                    return glib::Propagation::Stop;
                }
                Key::Right => {
                    do_resize(&rc, WtmDirection::Right);
                    return glib::Propagation::Stop;
                }
                Key::Up => {
                    do_resize(&rc, WtmDirection::Up);
                    return glib::Propagation::Stop;
                }
                Key::Down => {
                    do_resize(&rc, WtmDirection::Down);
                    return glib::Propagation::Stop;
                }
                // '+' 常见为 Shift+'=',键盘布局各异,plus/equal/小键盘加号都接受。
                Key::plus | Key::equal | Key::KP_Add => {
                    do_split(&rc, WtmDirection::Right);
                    return glib::Propagation::Stop;
                }
                Key::minus | Key::underscore | Key::KP_Subtract => {
                    do_split(&rc, WtmDirection::Down);
                    return glib::Propagation::Stop;
                }
                _ => {}
            }
        } else {
            // Alt+方向 → 切焦点。
            match keyval {
                Key::Left => {
                    do_navigate(&rc, WtmDirection::Left);
                    return glib::Propagation::Stop;
                }
                Key::Right => {
                    do_navigate(&rc, WtmDirection::Right);
                    return glib::Propagation::Stop;
                }
                Key::Up => {
                    do_navigate(&rc, WtmDirection::Up);
                    return glib::Propagation::Stop;
                }
                Key::Down => {
                    do_navigate(&rc, WtmDirection::Down);
                    return glib::Propagation::Stop;
                }
                _ => {}
            }
        }
        glib::Propagation::Proceed
    });

    container.add_controller(controller);
}

// ===========================================================================
// 测试:镜像树的纯逻辑(split / navigate / resize),不依赖 GTK。
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn split(node: &mut LayoutNode, target: WtmPaneId, new: WtmPaneId, dir: WtmDirection, key: u64) {
        assert!(node.split_leaf(target, new, dir, DEFAULT_RATIO, key));
    }

    #[test]
    fn split_right_then_navigate() {
        // 1 | 2 | 3
        let mut t = LayoutNode::Leaf(1);
        split(&mut t, 1, 2, WtmDirection::Right, 1);
        split(&mut t, 2, 3, WtmDirection::Right, 2);
        assert_eq!(t.navigate(1, WtmDirection::Right), Some(2));
        assert_eq!(t.navigate(2, WtmDirection::Right), Some(3));
        assert_eq!(t.navigate(3, WtmDirection::Right), None);
        assert_eq!(t.navigate(2, WtmDirection::Left), Some(1));
        assert_eq!(t.navigate(1, WtmDirection::Up), None);
    }

    #[test]
    fn split_down_puts_new_second() {
        let mut t = LayoutNode::Leaf(1);
        split(&mut t, 1, 2, WtmDirection::Down, 1);
        assert_eq!(t.navigate(1, WtmDirection::Down), Some(2));
        assert_eq!(t.navigate(2, WtmDirection::Up), Some(1));
    }

    #[test]
    fn grid_navigation() {
        // 上半 1|2,下半 3(整行)。
        let mut t = LayoutNode::Leaf(1);
        split(&mut t, 1, 3, WtmDirection::Down, 1);
        split(&mut t, 1, 2, WtmDirection::Right, 2);
        assert_eq!(t.navigate(1, WtmDirection::Right), Some(2));
        assert_eq!(t.navigate(1, WtmDirection::Down), Some(3));
        assert_eq!(t.navigate(2, WtmDirection::Down), Some(3));
        assert_eq!(t.navigate(3, WtmDirection::Up), Some(1));
    }

    #[test]
    fn set_ratio_and_nudge() {
        let mut t = LayoutNode::Leaf(1);
        split(&mut t, 1, 2, WtmDirection::Right, 7);
        t.set_ratio(7, 0.3);
        if let LayoutNode::Split { ratio, .. } = &t {
            assert!((*ratio - 0.3).abs() < 1e-9);
        } else {
            panic!("应为分裂节点");
        }
        // 焦点在 1(first),Right 使最近的 Horizontal 分裂比例 +step。
        let mut done = false;
        t.nudge_ratio(1, Orientation::Horizontal, RESIZE_STEP, &mut done);
        assert!(done);
        if let LayoutNode::Split { ratio, .. } = &t {
            assert!((*ratio - 0.35).abs() < 1e-9);
        }
    }

    #[test]
    fn layout_rects_partition_unit_square() {
        let mut t = LayoutNode::Leaf(1);
        split(&mut t, 1, 2, WtmDirection::Right, 1);
        split(&mut t, 2, 3, WtmDirection::Down, 2);
        let area: f64 = t.layout_rects().iter().map(|(_, r)| r.w * r.h).sum();
        assert!((area - 1.0).abs() < 1e-6);
    }
}
