//! wintermac_linux —— Linux 宿主(GTK4)入口 / 装配层
//!
//! 职责边界:本 crate 只做“宿主 UI 壳”。窗格二叉树的真实状态与算法
//! (split/swap/navigate/…)在共享 Rust 内核 `wintermac_core` 里(C ABI:见
//! core/src/lib.rs 的 `wtm_*` 导出),本进程通过其 C ABI 驱动。
//!
//! 本文件是【整合 agent】的装配点,把四个功能队友的模块接线成一个可运行的 App:
//!   - termview.rs(term 角色):GTK4+VTE 真实终端视图,spawn shell、渲染输出、回写键盘;
//!   - panes.rs(panes 角色):把窗格二叉树映射为嵌套 GtkPaned,并自带键位控制器
//!     (Alt+Shift+± 拆分、Alt+方向 切焦点、Alt+Shift+方向 调比例),内部维护宿主镜像;
//!   - command.rs / keymap.rs / palette.rs(cmd 角色):Command 枚举 + PaneHost 契约 +
//!     可搜索命令面板(Ctrl+Shift+P),经 ffi `wtm_tree_*` 真调内核;
//!   - core 的 io/bridge(io 角色):PTY 桥接 `wtm_pty_*`。Linux 端由 VTE 自管 pty,
//!     故本壳不直接用 io 桥,仅通过依赖 core 让其符号可用(见文末 TODO)。
//!
//! 装配后 App 启动即可:开窗 → 显示真终端(跑 shell) → 敲命令 → Alt+Shift+±/Alt+方向
//! 拆分/切焦点 → Ctrl+Shift+P 打开命令面板。

// 队友模块声明(均为其独占的新文件,本文件只做装配,不改其内容)。
mod command;
mod keymap;
mod palette;
mod panes;
mod termview;

// 强制把 core 链接进本二进制:core 里 `#[no_mangle] pub extern "C" fn wtm_*`
// 的符号用于解析下方 ffi 模块手写的 `extern "C"` 声明(见 Cargo.toml 说明)。
#[allow(unused_extern_crates)]
extern crate wintermac_core;

use std::cell::Cell;
use std::rc::Rc;

use gtk4::prelude::*;
use gtk4::{
    glib, Application, ApplicationWindow, EventControllerKey, PropagationPhase,
};

use crate::command::{Command, PaneHost};
use crate::ffi::{WtmDirection, WtmPaneId, WtmTree};

/// 应用标识(反向域名风格)。
const APP_ID: &str = "dev.wintermac.linux";

/// 根叶子(初始唯一窗格)的 id。
const ROOT_PANE: WtmPaneId = 0;

// ---------------------------------------------------------------------------
// C ABI 桥:与 core/src/lib.rs 的 `wtm_*` 导出一一对应。
//
// 由 core(path 依赖,见 Cargo.toml)提供实现,本处只声明 ABI。数值必须与 core
// 侧 #[repr(C)] 枚举严格一致。panes.rs / termview.rs / command.rs / palette.rs 均
// 通过 `crate::ffi::*` 引用这些类型与函数。
// ---------------------------------------------------------------------------
#[allow(dead_code)]
pub mod ffi {
    use std::os::raw::c_int;

    /// 与 core 的 `WtmDirection` 对齐:Left=0, Right=1, Up=2, Down=3。
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub enum WtmDirection {
        Left = 0,
        Right = 1,
        Up = 2,
        Down = 3,
    }

    /// 与 core 的 `WtmStatus` 对齐:Ok=0,负值为错误。
    pub type WtmStatus = c_int;
    /// 与 core 的 `WtmPaneId` 对齐。
    pub type WtmPaneId = u64;

    /// 不透明句柄:对宿主不可见内部结构。
    #[repr(C)]
    pub struct WtmTree {
        _private: [u8; 0],
    }

    // 由 core 提供 `#[no_mangle]` 实现,链接期解析(见 main.rs 的 extern crate)。
    extern "C" {
        pub fn wtm_tree_new(root_pane: WtmPaneId) -> *mut WtmTree;
        pub fn wtm_tree_free(handle: *mut WtmTree);
        pub fn wtm_tree_split(
            handle: *mut WtmTree,
            target: WtmPaneId,
            new_pane: WtmPaneId,
            dir: WtmDirection,
            ratio: f32,
        ) -> WtmStatus;
        pub fn wtm_tree_swap(handle: *mut WtmTree, a: WtmPaneId, b: WtmPaneId) -> WtmStatus;
        pub fn wtm_tree_navigate(
            handle: *const WtmTree,
            from: WtmPaneId,
            dir: WtmDirection,
            out_pane: *mut WtmPaneId,
        ) -> WtmStatus;
    }
}

fn main() {
    let app = Application::builder().application_id(APP_ID).build();
    app.connect_activate(build_ui);
    app.run();
}

/// 构建主窗口并接线所有模块。
fn build_ui(app: &Application) {
    let window = ApplicationWindow::builder()
        .application(app)
        .title("Win-Term-Mac (Linux / GTK4)")
        .default_width(1024)
        .default_height(640)
        .build();

    // 1) 窗格布局 + 真实终端:PaneLayout 内部据宿主镜像渲染嵌套 GtkPaned,
    //    每个叶子是一个 VTE 终端(spawn shell、显示输出、回写键盘),并自带键位
    //    控制器(Alt+Shift+± 拆分、Alt+方向 切焦点、Alt+Shift+方向 调比例)。
    //    layout 必须保持存活(持有全部 TermView 与内部状态),故用 Rc 存入闭包。
    let layout = Rc::new(panes::PaneLayout::new(ROOT_PANE));
    window.set_child(Some(&layout.container()));

    // 2) 内核句柄:真正调用 core,建立一棵以 ROOT_PANE 为根的窗格树。命令面板
    //    执行的命令经 command::execute 作用其上(见 Host 实现)。
    let tree = unsafe { ffi::wtm_tree_new(ROOT_PANE) };

    // 3) 宿主契约:给 cmd 模块(命令面板)一个 PaneHost。焦点从 PaneLayout 读,
    //    命令的树操作打到内核句柄。见 Host 的 TODO 说明其与 PaneLayout 镜像的接缝。
    let host: Rc<dyn PaneHost> = Rc::new(Host {
        tree: Cell::new(tree),
        layout: layout.clone(),
        next_id: Cell::new(ROOT_PANE + 1),
    });

    // 4) 命令面板(Ctrl+Shift+P)。弹出层挂在窗口上。
    let palette = palette::CommandPalette::new(&window, host.clone());

    // 5) 只为 Ctrl+Shift+P 装一个捕获相位的键控制器 → 弹面板。
    //    注意:不用 keymap::install(它会同时接管 Alt+Shift+± / Alt+方向,与
    //    PaneLayout 自带的键位控制器重复派发)。这里复用 keymap::resolve 的纯查表
    //    逻辑,只在命中 OpenPalette 时吞事件;其余按键继续下发给 PaneLayout / VTE。
    install_palette_hotkey(&window, palette);

    // 6) 关闭窗口时归还内核句柄,避免泄漏。
    let tree_for_close = tree;
    window.connect_destroy(move |_| unsafe {
        ffi::wtm_tree_free(tree_for_close);
    });

    window.present();
}

/// 装一个仅识别 Ctrl+Shift+P 的键控制器,命中即弹命令面板;其余事件放行。
fn install_palette_hotkey(window: &ApplicationWindow, palette: palette::CommandPalette) {
    let controller = EventControllerKey::new();
    // Capture:窗口是 PaneLayout 容器的祖先,先于其拿到事件;只在命中面板热键时
    // Stop,其余 Proceed → 事件继续下行给 PaneLayout 的键控制器与 VTE 终端。
    controller.set_propagation_phase(PropagationPhase::Capture);
    controller.connect_key_pressed(move |_ctrl, key, _code, state| {
        match keymap::resolve(key, state) {
            Some(Command::OpenPalette) => {
                palette.present();
                glib::Propagation::Stop
            }
            // 其它命令交给 PaneLayout 自带的键位控制器处理,这里不重复派发。
            _ => glib::Propagation::Proceed,
        }
    });
    window.add_controller(controller);
}

// ===========================================================================
// PaneHost 适配器:桥接 cmd 模块(命令面板)与内核句柄 / PaneLayout。
//
// 接缝说明:本轮 PaneLayout(panes 角色)以“宿主镜像”为权威、自带键位驱动
// split/navigate/resize,并未对外暴露可编程的变更接口;而 cmd 模块的
// command::execute 直接打内核句柄。二者当前是两套“真相源”。因此:
//   - 交互式的拆分 / 切焦点 / 调比例 走 PaneLayout(键盘),UI 实时更新;
//   - 命令面板执行的命令打内核句柄,内核树随之变化,但暂无法回灌到 PaneLayout
//     的镜像(内核未导出“读整棵树”ABI,PaneLayout 也未暴露变更入口)。
// 待内核补 `读树` ABI 且 PaneLayout 暴露编程接口后,可让二者收敛为单一真相源:
//   on_tree_changed 里读内核树 → 重建 PaneLayout。以下相应方法均标 TODO(集成)。
// ===========================================================================
struct Host {
    /// 内核窗格树句柄(来自 ffi::wtm_tree_new)。
    tree: Cell<*mut WtmTree>,
    /// 窗格布局(真相源之一:焦点、终端视图)。
    layout: Rc<panes::PaneLayout>,
    /// 命令面板拆分时分配新叶子 id 的计数器。
    /// TODO(集成): 与 PaneLayout 内部 next_id 各自为政,接通后应统一分配。
    next_id: Cell<WtmPaneId>,
}

impl PaneHost for Host {
    fn tree(&self) -> *mut WtmTree {
        self.tree.get()
    }

    fn focused_pane(&self) -> Option<WtmPaneId> {
        Some(self.layout.focused())
    }

    fn set_focused_pane(&self, _id: WtmPaneId) {
        // TODO(集成): PaneLayout 暂未暴露“外部设焦点”接口。交互焦点由其键位控制器
        // 与终端 focus 事件维护;命令面板设焦点无法回灌。待 PaneLayout 暴露 setter。
    }

    fn alloc_pane_id(&self) -> WtmPaneId {
        let id = self.next_id.get();
        self.next_id.set(id + 1);
        id
    }

    fn pane_ids(&self) -> Vec<WtmPaneId> {
        // TODO(集成): PaneLayout 未暴露“枚举全部叶子 id”。命令面板的 swap/move
        // 选目标依赖它,故当前目标列表为空(swap/move 面板第二步暂无候选)。
        // 待 PaneLayout 暴露 pane_ids() 或内核导出读树 ABI 后补全。
        Vec::new()
    }

    fn on_tree_changed(&self) {
        // TODO(集成): 命令面板改动的是内核句柄;此处应据内核新树重建 PaneLayout,
        // 但内核未导出读树 ABI、PaneLayout 未暴露重建入口,暂无法回灌(见上方接缝说明)。
    }

    fn resize_focused(&self, _dir: WtmDirection) {
        // TODO(集成): 交互式调比例由 PaneLayout 的 Alt+Shift+方向 处理并实时生效;
        // 命令面板路径暂不重复实现(需 PaneLayout 暴露编程接口)。
    }

    fn move_focused(&self, _target: WtmPaneId, _dir: WtmDirection) {
        // TODO(内核): 待内核导出 wtm_tree_move 后实现;当前留桩。
    }
}
