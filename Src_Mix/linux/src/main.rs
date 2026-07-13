//! wintermac_linux —— Linux 宿主(GTK4)入口
//!
//! 职责边界:本 crate 只做“宿主 UI 壳”。窗格二叉树的真实状态与算法
//! (split/swap/navigate/…)全部在共享 Rust 内核 `wintermac_core` 里,
//! 本进程通过其 C ABI(见 core/src/lib.rs 的 `wtm_*` 导出)驱动。
//!
//! 当前阶段:只搭出一个 GtkApplicationWindow,内部用 GtkPaned 摆两个
//! 占位窗格(将来替换为真正的 VTE 终端视图)。热键与命令面板见 keymap.md。

use gtk4::prelude::*;
use gtk4::{Application, ApplicationWindow, Label, Orientation, Paned};

/// 应用标识(反向域名风格)。
const APP_ID: &str = "dev.wintermac.linux";

// ---------------------------------------------------------------------------
// C ABI 桥:与 core/src/lib.rs 的 `wtm_*` 导出一一对应。
//
// 手写声明是过渡方案,便于在内核 cdylib 就绪前保持结构自洽。最终应改为
// 由 cbindgen 生成的 wintermac_core.h + bindgen 自动产出(见 Cargo.toml 注释)。
// 数值必须与 core 侧 #[repr(C)] 枚举严格一致。
// ---------------------------------------------------------------------------
#[allow(dead_code)]
mod ffi {
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

    // TODO(集成): 待 wintermac_core 的 cdylib 产物就绪后再启用真实链接。
    // 现在若打开 `#[link]` 而无库文件,链接会失败,故先注释保持可编译。
    // #[link(name = "wintermac_core")]
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

    // TODO(集成): 在这里(或 window 关闭时)调用 ffi::wtm_tree_new /
    // wtm_tree_free 管理内核句柄的生命周期。当前占位不实际调用。

    app.run();
}

/// 构建主窗口:一个 ApplicationWindow,内部放一个横向 GtkPaned 作为占位窗格布局。
fn build_ui(app: &Application) {
    let window = ApplicationWindow::builder()
        .application(app)
        .title("Win-Term-Mac (Linux / GTK4)")
        .default_width(1024)
        .default_height(640)
        .build();

    // 占位:GtkPaned 用一根可拖动的分隔条把窗口切成两半。
    // 这对应内核里“一个横向分裂节点 + 两个叶子”的最简形态。
    // TODO(渲染): 用真正的终端视图(如 VTE 的 Terminal 控件)替换这两个 Label。
    let paned = Paned::builder()
        .orientation(Orientation::Horizontal)
        .position(512)
        .wide_handle(true)
        .build();

    paned.set_start_child(Some(&make_placeholder_pane("pane 0")));
    paned.set_end_child(Some(&make_placeholder_pane("pane 1")));

    // TODO(交互): 挂上 GtkShortcutController / GtkEventControllerKey,
    // 把 keymap.md 里的键位映射到对内核的 split/swap/navigate 调用,
    // 再据内核返回的新树结构增删 / 重排 GtkPaned 层级。
    // 命令面板(Ctrl+Shift+P)后续用一个可搜索的弹出层实现。

    window.set_child(Some(&paned));
    window.present();
}

/// 生成一个占位窗格控件(将来会是终端视图)。
fn make_placeholder_pane(text: &str) -> Label {
    Label::builder()
        .label(text)
        .hexpand(true)
        .vexpand(true)
        .build()
}
