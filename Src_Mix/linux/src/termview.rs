//! termview —— Linux(GTK4 + VTE)真实终端视图
//!
//! 定位:这是「term」角色的产物。一个叶子窗格 = 一个 [`TermView`],内部包一个
//! VTE `Terminal` 控件。VTE 本身就是一个终端仿真器:它开一个 pty、spawn 用户的
//! shell 子进程,把子进程输出实时渲染到控件上,并把键盘输入直接写回 pty ——
//! 因此「显示 shell 输出」「敲命令」这两件事由 VTE 原生完成,无需自绘。
//!
//! 与内核的关系:窗格二叉树的真相在 `wintermac_core`(C ABI)里。每个内核叶子
//! `WtmPaneId` 对应一个 `TermView`;宿主维护 `id -> TermView` 映射,并在内核返回
//! 新树结构后据此增删/重排控件。TermView 自身不碰树,只负责“一个格子里的终端”。
//!
//! ---------------------------------------------------------------------------
//! integrator(main.rs / 集成 agent)需要如何调用我:
//!
//! 1) 依赖:我已在 linux/Cargo.toml 追加 `vte4`。若版本报错,按注释调整。
//!
//! 2) 在 main.rs 顶部加一行模块声明:
//!        mod termview;
//!
//! 3) 用它替换 `make_placeholder_pane`。最简改法(两格占位):
//!        let t0 = termview::TermView::new(0);   // pane id 0 = 根叶子
//!        let t1 = termview::TermView::new(1);
//!        paned.set_start_child(Some(t0.widget()));
//!        paned.set_end_child(Some(t1.widget()));
//!    并把 t0/t1 存起来(见下)以免被 Drop。
//!
//! 4) 生命周期:`widget()` 返回的控件被 GTK 容器持有引用,但 `TermView` 结构体
//!    本身要由宿主保存(例如 `HashMap<WtmPaneId, TermView>`),否则栈上变量一出
//!    作用域就 Drop 了。控件本体是引用计数的 GObject,Drop TermView 不会立刻销毁
//!    控件,但请以 map 为准做增删。
//!
//! 5) 遍历内核树建 UI 时:对每个叶子 id 调 `TermView::new(id)`;对每个 split 节点
//!    建一个 `gtk4::Paned`(orientation 由 WtmDirection 决定,position 由 ratio 决定)。
//! ---------------------------------------------------------------------------

use gtk4::prelude::*;
use gtk4::{gio, glib, PolicyType, ScrolledWindow, Widget};
use vte4::prelude::*;
use vte4::{PtyFlags, Terminal};

use std::path::{Path, PathBuf};

use crate::ffi::WtmPaneId;

/// 默认回滚行数(向上翻历史)。
const SCROLLBACK_LINES: u32 = 10_000;

/// 默认等宽字体描述(Pango 语法)。宿主将来可做成可配置。
const DEFAULT_FONT: &str = "monospace 11";

/// 一个终端窗格:VTE 终端 + 其滚动容器,绑定到内核的一个叶子 id。
pub struct TermView {
    /// 关联的内核叶子 id(宿主用它把本视图与内核树对应)。
    pane_id: WtmPaneId,
    /// VTE 终端控件本体(GObject,引用计数)。
    terminal: Terminal,
    /// 顶层可插入布局的容器(带滚动条)。
    root: ScrolledWindow,
}

impl TermView {
    /// 新建一个终端窗格并立刻 spawn 用户 shell。
    ///
    /// spawn 失败(极少见)不会 panic:失败信息会 `feed` 到终端上显示,便于排查。
    pub fn new(pane_id: WtmPaneId) -> Self {
        let terminal = Terminal::new();
        terminal.set_scrollback_lines(SCROLLBACK_LINES as i64);
        terminal.set_cursor_blink_mode(vte4::CursorBlinkMode::On);
        terminal.set_hexpand(true);
        terminal.set_vexpand(true);
        terminal.set_font(Some(&gtk4::pango::FontDescription::from_string(DEFAULT_FONT)));

        // 用 ScrolledWindow 包裹:VTE 在 GTK4 下实现了 Scrollable,可直接提供滚动条。
        let root = ScrolledWindow::builder()
            .hexpand(true)
            .vexpand(true)
            .hscrollbar_policy(PolicyType::Never)
            .vscrollbar_policy(PolicyType::Automatic)
            .child(&terminal)
            .build();

        let view = TermView {
            pane_id,
            terminal,
            root,
        };
        view.spawn_shell();
        view.install_child_exited_handler();
        view
    }

    /// 关联的内核叶子 id。
    pub fn pane_id(&self) -> WtmPaneId {
        self.pane_id
    }

    /// 返回可放入 GtkPaned / 窗格容器的顶层控件。
    pub fn widget(&self) -> &Widget {
        self.root.upcast_ref::<Widget>()
    }

    /// 底层 VTE 终端(供高级操作:选择、复制、字体缩放等)。
    pub fn terminal(&self) -> &Terminal {
        &self.terminal
    }

    /// 直接把字节写到「显示」上(不经子进程)。用于打印宿主横幅 / 提示。
    /// 注意 VTE 期望 `\r\n` 而非单独的 `\n`。
    pub fn feed_display(&self, bytes: &[u8]) {
        self.terminal.feed(bytes);
    }

    /// 把字节写入子进程 stdin(相当于替用户“敲键”)。用于程序化输入命令。
    pub fn feed_child(&self, bytes: &[u8]) {
        self.terminal.feed_child(bytes);
    }

    /// spawn 用户默认 shell 作为终端子进程。
    fn spawn_shell(&self) {
        let shell = user_shell();
        // vte4 0.8 的 spawn_async argv 形参是 &[&str],把 shell 路径转成 &str。
        let shell_str = shell.to_str().unwrap_or("/bin/sh");
        let cwd = home_dir();
        let terminal_for_cb = self.terminal.clone();

        self.terminal.spawn_async(
            PtyFlags::DEFAULT,
            cwd.as_deref(),                 // working_directory
            &[shell_str],                   // argv: 只有 shell 本身(登录 shell 交互模式)
            &[],                            // envv: 空 = 继承父进程环境
            glib::SpawnFlags::DEFAULT,
            || {},                          // child_setup: 无需额外设置
            -1,                             // timeout: 不限时
            gio::Cancellable::NONE,         // cancellable: 不取消
            move |result| match result {
                Ok(_pid) => { /* spawn 成功;后续输出由 VTE 自动渲染 */ }
                Err(err) => {
                    let msg = format!("\r\n[termview] 无法启动 shell: {err}\r\n");
                    terminal_for_cb.feed(msg.as_bytes());
                }
            },
        );
    }

    /// 子进程退出时的处理:目前只在终端上留一行提示。
    ///
    /// TODO(集成): 将来应回调宿主 —— 让宿主对内核发起 detach(移除该叶子并塌缩
    /// 父分裂节点),再据新树重排控件。此处不直接碰内核,避免越权。
    fn install_child_exited_handler(&self) {
        self.terminal.connect_child_exited(move |term, status| {
            let msg = format!("\r\n[进程已退出,状态码 {status}] 按窗格关闭键关闭\r\n");
            term.feed(msg.as_bytes());
        });
    }
}

/// 取用户默认 shell:优先 `$SHELL`,回退 `/bin/bash`,再回退 `/bin/sh`。
fn user_shell() -> PathBuf {
    if let Ok(sh) = std::env::var("SHELL") {
        if !sh.is_empty() {
            return PathBuf::from(sh);
        }
    }
    for candidate in ["/bin/bash", "/bin/sh"] {
        if Path::new(candidate).exists() {
            return PathBuf::from(candidate);
        }
    }
    PathBuf::from("/bin/sh")
}

/// 取用户家目录作为 shell 的初始工作目录(取不到则用 None = 继承)。
fn home_dir() -> Option<String> {
    std::env::var("HOME").ok().filter(|h| !h.is_empty())
}
