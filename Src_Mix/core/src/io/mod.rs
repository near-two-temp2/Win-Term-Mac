//! io —— 终端 I/O 桥接层(PTY 双向管道)
//!
//! 本模块与 `pane`(窗格二叉树)平级,是共享 Rust 内核里负责“真实终端 I/O”
//! 的一半:它把一个 shell 跑在伪终端(PTY)里,并以 C ABI 把三件事暴露给宿主:
//!   1. 键盘输入 → 写给 shell        (`wtm_pty_write`)
//!   2. shell 输出 → 喂给终端渲染     (`wtm_pty_read` + `wtm_pty_fd`)
//!   3. 窗口/窗格 resize → 通知 PTY   (`wtm_pty_resize`)
//!
//! 与窗格树的关系:`pane` 管的是“布局”(哪个叶子在哪),本模块管的是“每个叶子
//! 背后那个真终端的字节流”。宿主自己维护 `WtmPaneId → *mut WtmPty` 的映射:
//! 每当 `wtm_tree_split` 生出一个新叶子,就 `wtm_pty_spawn` 一个 PTY 挂上去;
//! 叶子被 detach 时 `wtm_pty_free`。两套 API 解耦,内核不强绑定二者。
//!
//! ---------------------------------------------------------------------------
//! integrator(整合 agent)需要如何调用我:
//!
//! 1) 在 core/src/lib.rs 顶部的模块声明区加一行:
//!        mod io;
//!    (无需 `pub`;`#[no_mangle]` 的 C 符号会照常从 cdylib 导出,cbindgen 也会
//!     把 `bridge.rs` 里的 `wtm_pty_*` 函数写进 include/wintermac_core.h。)
//!
//! 2) core/Cargo.toml 需要 `libc`(我已在 [dependencies] 加好:`libc = "0.2"`)。
//!
//! 3) 宿主侧典型接线(伪代码,事件驱动、零轮询):
//!        let pty = wtm_pty_spawn(NULL, cols, rows);   // NULL → $SHELL 或 /bin/sh
//!        let fd  = wtm_pty_fd(pty);                    // 把 fd 加入事件循环监听“可读”
//!        // 可读回调里:  n = wtm_pty_read(pty, buf, cap);  n>0 → 交给终端解析器
//!        //             n<0 → shell 已退出,wtm_pty_free 收尾
//!        // 键入回调里:  wtm_pty_write(pty, bytes, len)
//!        // 窗格 resize:  wtm_pty_resize(pty, cols, rows)
//!    - macOS:用 `DispatchSource.makeReadSource(fileDescriptor: fd)`。
//!    - GTK4 :用 `glib::unix_fd_add_local(fd, IOCondition::IN, ...)`。
//! ---------------------------------------------------------------------------

pub mod bridge;
