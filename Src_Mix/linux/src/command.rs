//! command —— 命令表 + 派发(把动作真正作用到内核窗格树与视图)
//!
//! 定位:这是「cmd」角色的核心。它把 keymap.md 里列出的窗格动作
//! (拆分 / 切焦点 / 调整大小 / 交换 / 移动)收敛成一个 [`Command`] 枚举,
//! 并提供 [`execute`] 把每个动作翻译成对共享内核 C ABI(`wtm_tree_*`)的调用,
//! 调用成功后请宿主据新树重排视图。命令面板(见 `palette.rs`)与键位
//! (见 `keymap.rs`)都最终汇入本模块的 [`Command`] 与派发函数。
//!
//! 分工边界:
//! - 「窗格树的真相」在 `wintermac_core`(C ABI),本模块只负责*调用*它,不自己维护树。
//! - 「一个格子里的终端 / GtkPaned 层级」由 `termview.rs`(RustRender)负责;本模块通过
//!   [`PaneHost`] 抽象请宿主完成“据新树重建视图 / 设置焦点”,自己不碰具体控件。
//! - 「键盘事件抓取」由 `keymap.rs`(可与 RustInput 协作)负责,它解析出 [`Command`]
//!   后调本模块 [`execute`]。
//!
//! ---------------------------------------------------------------------------
//! integrator(main.rs / 集成 agent)需要如何调用我:
//!
//! 1) 在 main.rs 顶部加模块声明:
//!        mod command;
//!        mod keymap;
//!        mod palette;
//!
//! 2) 为你的宿主状态实现 [`PaneHost`](见下),它是本模块与你的视图/内核句柄之间
//!    的唯一契约。典型实现持有 `*mut ffi::WtmTree`、`focused: Cell<WtmPaneId>`、
//!    `next_id: Cell<WtmPaneId>`、`HashMap<WtmPaneId, TermView>`,并在
//!    `on_tree_changed` 里遍历内核树重建 GtkPaned(见 termview.rs 的 integrator 说明)。
//!
//! 3) 把宿主放进 `Rc<dyn PaneHost>`,交给 `keymap::install(&window, host.clone(), ..)`
//!    与 `palette::CommandPalette::new(&window, host.clone())`。
//! ---------------------------------------------------------------------------

use crate::ffi::{self, WtmDirection, WtmPaneId, WtmTree};

/// 拆分/移动默认比例(first 子节点占比)。后续可做成可配置。
pub const DEFAULT_RATIO: f32 = 0.5;

/// 一个可执行的窗格动作。keymap 与命令面板都产出它。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Command {
    /// 向右拆分(纵向分割条,新叶子在右)。热键 Alt+Shift++。
    SplitRight,
    /// 向下拆分(横向分割条,新叶子在下)。热键 Alt+Shift+-。
    SplitDown,
    /// 切焦点:左 / 右 / 上 / 下。热键 Alt+方向。
    FocusLeft,
    FocusRight,
    FocusUp,
    FocusDown,
    /// 调整大小:朝某方向挪动焦点窗格所在分裂条。热键 Alt+Shift+方向。
    ResizeLeft,
    ResizeRight,
    ResizeUp,
    ResizeDown,
    /// 打开命令面板。热键 Ctrl+Shift+P。
    OpenPalette,
    /// 交换窗格(WT swapPane)。**仅命令面板触发**,无默认热键。需要选目标。
    SwapPane,
    /// 移动 / 摘下窗格(WT move/detach)。**仅命令面板触发**,无默认热键。需要选目标。
    MovePane,
}

impl Command {
    /// 命令面板里显示的标题。
    pub fn title(self) -> &'static str {
        match self {
            Command::SplitRight => "拆分窗格:向右",
            Command::SplitDown => "拆分窗格:向下",
            Command::FocusLeft => "焦点:左",
            Command::FocusRight => "焦点:右",
            Command::FocusUp => "焦点:上",
            Command::FocusDown => "焦点:下",
            Command::ResizeLeft => "调整大小:左",
            Command::ResizeRight => "调整大小:右",
            Command::ResizeUp => "调整大小:上",
            Command::ResizeDown => "调整大小:下",
            Command::OpenPalette => "打开命令面板",
            Command::SwapPane => "交换窗格…",
            Command::MovePane => "移动窗格…",
        }
    }

    /// 面板搜索用的关键字(含英文别名,便于模糊搜索)。
    pub fn keywords(self) -> &'static str {
        match self {
            Command::SplitRight => "split pane right vertical 拆分 右",
            Command::SplitDown => "split pane down horizontal 拆分 下",
            Command::FocusLeft => "focus move left navigate 焦点 左",
            Command::FocusRight => "focus move right navigate 焦点 右",
            Command::FocusUp => "focus move up navigate 焦点 上",
            Command::FocusDown => "focus move down navigate 焦点 下",
            Command::ResizeLeft => "resize pane left 调整 大小 左",
            Command::ResizeRight => "resize pane right 调整 大小 右",
            Command::ResizeUp => "resize pane up 调整 大小 上",
            Command::ResizeDown => "resize pane down 调整 大小 下",
            Command::OpenPalette => "command palette 命令 面板",
            Command::SwapPane => "swap pane exchange 交换 窗格",
            Command::MovePane => "move detach pane 移动 摘下 窗格",
        }
    }

    /// 面板右侧显示的热键提示(无热键返回空串)。
    pub fn hotkey_hint(self) -> &'static str {
        match self {
            Command::SplitRight => "Alt+Shift++",
            Command::SplitDown => "Alt+Shift+-",
            Command::FocusLeft => "Alt+Left",
            Command::FocusRight => "Alt+Right",
            Command::FocusUp => "Alt+Up",
            Command::FocusDown => "Alt+Down",
            Command::ResizeLeft => "Alt+Shift+Left",
            Command::ResizeRight => "Alt+Shift+Right",
            Command::ResizeUp => "Alt+Shift+Up",
            Command::ResizeDown => "Alt+Shift+Down",
            Command::OpenPalette => "Ctrl+Shift+P",
            // 交换 / 移动:低频强力操作,刻意不给默认热键(与 WT 一致)。
            Command::SwapPane | Command::MovePane => "",
        }
    }

    /// 该命令在面板里选中后是否还需要“选一个目标窗格”(swap / move 需要)。
    pub fn needs_target(self) -> bool {
        matches!(self, Command::SwapPane | Command::MovePane)
    }

    /// 命令面板里应列出的全部命令(顺序即展示顺序)。
    pub fn palette_catalog() -> &'static [Command] {
        &[
            Command::SplitRight,
            Command::SplitDown,
            Command::FocusLeft,
            Command::FocusRight,
            Command::FocusUp,
            Command::FocusDown,
            Command::ResizeLeft,
            Command::ResizeRight,
            Command::ResizeUp,
            Command::ResizeDown,
            Command::SwapPane,
            Command::MovePane,
        ]
    }
}

/// 宿主契约:本模块通过它读焦点 / 分配 id / 拿内核句柄,并请宿主重建视图。
///
/// 由 integrator(main.rs 的宿主状态)实现。用 `Rc<dyn PaneHost>` 共享给
/// keymap 与 palette。
pub trait PaneHost {
    /// 内核窗格树句柄(来自 `ffi::wtm_tree_new`)。
    fn tree(&self) -> *mut WtmTree;

    /// 当前聚焦的叶子 id(无叶子时 None)。
    fn focused_pane(&self) -> Option<WtmPaneId>;

    /// 设置聚焦叶子(宿主据此把键盘焦点给对应 TermView)。
    fn set_focused_pane(&self, id: WtmPaneId);

    /// 分配一个新的、树中未用过的叶子 id(供拆分)。
    fn alloc_pane_id(&self) -> WtmPaneId;

    /// 当前树中所有叶子 id(供交换 / 移动的目标选择)。
    fn pane_ids(&self) -> Vec<WtmPaneId>;

    /// 内核树结构已变化:请宿主遍历新树、重建 GtkPaned 层级与 TermView 映射。
    fn on_tree_changed(&self);

    /// 调整焦点窗格大小(朝 `dir` 挪其所在分裂条)。
    ///
    /// 说明:内核 C ABI 目前没有“改 ratio”接口,几何真相在视图层的 GtkPaned,
    /// 因此该动作由宿主直接挪对应 GtkPaned 的分隔条位置实现。
    /// TODO(内核): 若日后内核提供 `wtm_tree_resize(handle, pane, dir, delta)`,
    /// 应改为先调内核、再据新 ratio 重排,以保持两侧一致。
    fn resize_focused(&self, dir: WtmDirection);

    /// 把焦点窗格移动(detach + 重挂)到 `target` 的 `dir` 一侧。
    ///
    /// 说明:内核 `pane` 模块已有 `move_pane` 逻辑,但 `core/src/lib.rs` 尚未
    /// 导出对应 C ABI。在导出前,该动作暂由宿主实现(可先做 detach 语义或留桩)。
    /// TODO(内核): 导出 `wtm_tree_move(handle, moving, target, dir, ratio)` 后,
    /// 应改为在本模块直接调用它,而非委托宿主。
    fn move_focused(&self, target: WtmPaneId, dir: WtmDirection);
}

// ---------------------------------------------------------------------------
// 派发:把 Command 变成对内核 / 宿主的真实调用
// ---------------------------------------------------------------------------

/// 执行一个“无需额外目标”的命令(拆分 / 切焦点 / 调整大小)。
///
/// `OpenPalette` 与需要目标的 `SwapPane` / `MovePane` 不由本函数处理:
/// - `OpenPalette` 由 keymap 的派发闭包直接弹面板;
/// - `SwapPane` / `MovePane` 由命令面板选完目标后调 [`execute_swap`] / [`execute_move`]。
///
/// 返回是否已处理(便于调用方决定兜底行为)。
pub fn execute(cmd: Command, host: &dyn PaneHost) -> bool {
    match cmd {
        Command::SplitRight => split(host, WtmDirection::Right),
        Command::SplitDown => split(host, WtmDirection::Down),
        Command::FocusLeft => focus(host, WtmDirection::Left),
        Command::FocusRight => focus(host, WtmDirection::Right),
        Command::FocusUp => focus(host, WtmDirection::Up),
        Command::FocusDown => focus(host, WtmDirection::Down),
        Command::ResizeLeft => host.resize_focused(WtmDirection::Left),
        Command::ResizeRight => host.resize_focused(WtmDirection::Right),
        Command::ResizeUp => host.resize_focused(WtmDirection::Up),
        Command::ResizeDown => host.resize_focused(WtmDirection::Down),
        // 下面这些不在此处理:交给面板 / keymap 上层。
        Command::OpenPalette | Command::SwapPane | Command::MovePane => return false,
    }
    true
}

/// 拆分:把焦点叶子按 `dir` 分裂,新叶子分配一个 id,成功后焦点移到新叶子。
fn split(host: &dyn PaneHost, dir: WtmDirection) {
    let Some(target) = host.focused_pane() else {
        return;
    };
    let new_id = host.alloc_pane_id();
    // SAFETY: host.tree() 是宿主持有的有效未释放句柄。
    let status = unsafe { ffi::wtm_tree_split(host.tree(), target, new_id, dir, DEFAULT_RATIO) };
    if status == 0 {
        host.on_tree_changed();
        host.set_focused_pane(new_id);
    }
}

/// 切焦点:从焦点叶子按 `dir` 找几何相邻叶子,找到就把焦点移过去。
fn focus(host: &dyn PaneHost, dir: WtmDirection) {
    let Some(from) = host.focused_pane() else {
        return;
    };
    let mut out: WtmPaneId = 0;
    // SAFETY: 句柄有效;out 指向栈上可写变量。
    let status = unsafe { ffi::wtm_tree_navigate(host.tree(), from, dir, &mut out as *mut WtmPaneId) };
    if status == 0 {
        host.set_focused_pane(out);
    }
}

/// 交换:把焦点叶子与 `target` 叶子承载的终端互换(布局不变)。命令面板专用。
pub fn execute_swap(target: WtmPaneId, host: &dyn PaneHost) {
    let Some(a) = host.focused_pane() else {
        return;
    };
    if a == target {
        return;
    }
    // SAFETY: 句柄有效。
    let status = unsafe { ffi::wtm_tree_swap(host.tree(), a, target) };
    if status == 0 {
        host.on_tree_changed();
    }
}

/// 移动:把焦点叶子移动到 `target` 的 `dir` 一侧。命令面板专用。
///
/// 目前委托宿主(见 [`PaneHost::move_focused`] 的 TODO)。一旦内核导出
/// `wtm_tree_move`,应把这里替换为直接的 FFI 调用 + `host.on_tree_changed()`。
pub fn execute_move(target: WtmPaneId, dir: WtmDirection, host: &dyn PaneHost) {
    let Some(moving) = host.focused_pane() else {
        return;
    };
    if moving == target {
        return;
    }
    host.move_focused(target, dir);
}
