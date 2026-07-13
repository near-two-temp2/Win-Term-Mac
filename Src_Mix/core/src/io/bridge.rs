//! bridge —— PTY 会话的 C ABI 导出
//!
//! 一个 [`WtmPty`] 句柄 = 一个 shell 跑在伪终端里的会话:主端 fd(master)+ 子进程 pid。
//! 主端 fd 被设为非阻塞,便于宿主把它挂进自己的事件循环(可读即有输出),
//! 所有读写都不会阻塞 UI 线程,因此内核侧不需要额外的读线程。
//!
//! 平台:真实实现走 Unix(macOS / Linux)的 `forkpty`;非 Unix 目标(例如在
//! Windows 开发机上 `cargo build`)编译为“功能不可用”的桩,保证整个 crate 仍可编译。
//!
//! 内存约定:`wtm_pty_spawn` 返回堆分配的句柄,宿主持有其所有权,用完必须
//! `wtm_pty_free`。除释放函数外,其余函数只借用句柄。

use std::os::raw::c_int;

/// 一个 PTY 会话句柄(不透明)。宿主只当它是指针。
///
/// Unix 下承载主端 fd 与子进程 pid;非 Unix 下为零大小占位。
pub struct WtmPty {
    #[cfg(unix)]
    master: c_int,
    #[cfg(unix)]
    pid: libc::pid_t,
    // 非 Unix:占位字段,保持类型非空且 ABI 稳定。
    #[cfg(not(unix))]
    _private: [u8; 0],
}

// ===========================================================================
// 生命周期:spawn / free
// ===========================================================================

/// 启动一个新的 PTY 会话:在伪终端里 `exec` 一个 shell。
///
/// - `program`:要执行的程序路径(C 字符串)。传 null 时用环境变量 `$SHELL`,
///   再退化到 `/bin/sh`。以 `execvp` 执行,故也接受 `PATH` 中的可执行名。
/// - `cols` / `rows`:初始终端尺寸(字符列数 / 行数)。
///
/// # 返回
/// 成功返回非空句柄;失败(fork/openpty 出错)返回 null。
///
/// # Safety
/// 若 `program` 非空,必须指向一个以 NUL 结尾的合法 C 字符串。
#[no_mangle]
pub unsafe extern "C" fn wtm_pty_spawn(
    program: *const std::os::raw::c_char,
    cols: u16,
    rows: u16,
) -> *mut WtmPty {
    #[cfg(unix)]
    {
        imp::spawn(program, cols, rows)
    }
    #[cfg(not(unix))]
    {
        let _ = (program, cols, rows);
        std::ptr::null_mut()
    }
}

/// 关闭 PTY 会话:向子进程发 SIGHUP、回收(reap)、关闭主端 fd,释放句柄。
/// 传入 null 为无操作。
///
/// # Safety
/// `handle` 必须来自 `wtm_pty_spawn` 且此前未被释放;释放后不得再使用。
#[no_mangle]
pub unsafe extern "C" fn wtm_pty_free(handle: *mut WtmPty) {
    if handle.is_null() {
        return;
    }
    let boxed = Box::from_raw(handle);
    #[cfg(unix)]
    {
        imp::shutdown(&boxed);
    }
    drop(boxed);
}

// ===========================================================================
// 数据面:read / write / fd
// ===========================================================================

/// 取主端 fd,供宿主把它加入事件循环(可读 = 有 shell 输出)。
///
/// 返回 -1 表示句柄为 null 或该平台不支持。宿主不应 `close` 这个 fd——它由
/// `wtm_pty_free` 负责关闭。
///
/// # Safety
/// `handle` 必须有效或为 null。
#[no_mangle]
pub unsafe extern "C" fn wtm_pty_fd(handle: *const WtmPty) -> c_int {
    match handle.as_ref() {
        None => -1,
        #[cfg(unix)]
        Some(p) => p.master,
        #[cfg(not(unix))]
        Some(_) => -1,
    }
}

/// 读取 shell 输出到 `buf`(最多 `cap` 字节),非阻塞。
///
/// # 返回
/// - `> 0`:实际读到的字节数(应交给终端解析/渲染器)。
/// - `0`  :当前无数据可读(EAGAIN),稍后再试。
/// - `< 0`:出错或 shell 已退出(EOF);宿主应 `wtm_pty_free` 收尾。
///
/// # Safety
/// `handle` 必须有效;`buf` 必须指向至少 `cap` 字节的可写内存。
#[no_mangle]
pub unsafe extern "C" fn wtm_pty_read(handle: *mut WtmPty, buf: *mut u8, cap: usize) -> isize {
    let p = match handle.as_ref() {
        Some(p) => p,
        None => return -1,
    };
    if buf.is_null() || cap == 0 {
        return -1;
    }
    #[cfg(unix)]
    {
        imp::read(p.master, buf, cap)
    }
    #[cfg(not(unix))]
    {
        let _ = p;
        -1
    }
}

/// 把键盘输入(`buf` 的前 `len` 字节)写给 shell,非阻塞。
///
/// # 返回
/// - `> 0`:实际写出的字节数(可能小于 `len`,宿主需自行续写剩余部分)。
/// - `0`  :内核缓冲已满(EAGAIN),稍后再试。
/// - `< 0`:出错(通常意味着 shell 已退出)。
///
/// # Safety
/// `handle` 必须有效;`buf` 必须指向至少 `len` 字节的可读内存。
#[no_mangle]
pub unsafe extern "C" fn wtm_pty_write(handle: *mut WtmPty, buf: *const u8, len: usize) -> isize {
    let p = match handle.as_ref() {
        Some(p) => p,
        None => return -1,
    };
    if buf.is_null() {
        return -1;
    }
    if len == 0 {
        return 0;
    }
    #[cfg(unix)]
    {
        imp::write(p.master, buf, len)
    }
    #[cfg(not(unix))]
    {
        let _ = p;
        -1
    }
}

// ===========================================================================
// 控制面:resize / 子进程状态
// ===========================================================================

/// 通知 PTY 终端尺寸变化(窗口或窗格被 resize 时调用)。
///
/// 内核会通过 `TIOCSWINSZ` 更新主端窗口大小,内核随即向前台进程组发送
/// `SIGWINCH`,shell/程序据此重排。
///
/// # 返回
/// 0 成功;-1 句柄为 null 或该平台不支持;-2 底层 ioctl 失败。
///
/// # Safety
/// `handle` 必须有效或为 null。
#[no_mangle]
pub unsafe extern "C" fn wtm_pty_resize(handle: *mut WtmPty, cols: u16, rows: u16) -> c_int {
    let p = match handle.as_ref() {
        Some(p) => p,
        None => return -1,
    };
    #[cfg(unix)]
    {
        imp::resize(p.master, cols, rows)
    }
    #[cfg(not(unix))]
    {
        let _ = (p, cols, rows);
        -1
    }
}

/// 查询子进程是否已退出;若已退出且 `out_code` 非空,写入退出码。
///
/// 用于宿主在读到 EOF 后确认会话结束、更新叶子状态。非阻塞(WNOHANG)。
///
/// # 返回
/// `true` = 子进程已退出;`false` = 仍在运行(或句柄无效 / 平台不支持)。
///
/// # Safety
/// `handle` 必须有效或为 null;`out_code` 为 null 或指向可写的 `c_int`。
#[no_mangle]
pub unsafe extern "C" fn wtm_pty_child_exited(handle: *mut WtmPty, out_code: *mut c_int) -> bool {
    let p = match handle.as_ref() {
        Some(p) => p,
        None => return false,
    };
    #[cfg(unix)]
    {
        imp::child_exited(p.pid, out_code)
    }
    #[cfg(not(unix))]
    {
        let _ = (p, out_code);
        false
    }
}

// ===========================================================================
// Unix 实现
// ===========================================================================
#[cfg(unix)]
mod imp {
    use super::WtmPty;
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_int, c_void};
    use std::ptr;

    /// 组装 winsize 结构。
    fn make_winsize(cols: u16, rows: u16) -> libc::winsize {
        libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        }
    }

    /// 见 `wtm_pty_spawn`。
    pub unsafe fn spawn(program: *const c_char, cols: u16, rows: u16) -> *mut WtmPty {
        // 在 fork 之前(父进程里、可安全分配)确定要执行的程序与 argv。
        let prog: CString = if program.is_null() {
            let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
            CString::new(sh).unwrap_or_else(|_| CString::new("/bin/sh").unwrap())
        } else {
            CStr::from_ptr(program).to_owned()
        };
        // argv 必须以 null 结尾;argv[0] 用程序自身路径。
        let argv: [*const c_char; 2] = [prog.as_ptr(), ptr::null()];

        let ws = make_winsize(cols, rows);
        let mut master: c_int = -1;
        // forkpty:父得到 master fd;子进程已 setsid、以从端为控制终端并 dup2 到 0/1/2。
        let pid = libc::forkpty(&mut master, ptr::null_mut(), ptr::null(), &ws);

        if pid < 0 {
            // fork/openpty 失败。
            return ptr::null_mut();
        }
        if pid == 0 {
            // ---- 子进程 ----
            // fork 之后仅调用 async-signal-safe 操作:直接 exec,失败则 _exit。
            libc::execvp(argv[0], argv.as_ptr());
            // 只有 exec 失败才会走到这里。
            libc::_exit(127);
        }

        // ---- 父进程 ----
        // 主端设为非阻塞,让 read/write 永不阻塞 UI 线程。
        let flags = libc::fcntl(master, libc::F_GETFL, 0);
        if flags >= 0 {
            libc::fcntl(master, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
        // 关闭 exec 时自动关掉主端,避免泄漏给未来子进程。
        libc::fcntl(master, libc::F_SETFD, libc::FD_CLOEXEC);

        Box::into_raw(Box::new(WtmPty { master, pid }))
    }

    /// 见 `wtm_pty_read`。
    pub unsafe fn read(master: c_int, buf: *mut u8, cap: usize) -> isize {
        let n = libc::read(master, buf as *mut c_void, cap);
        if n > 0 {
            return n as isize;
        }
        if n == 0 {
            // EOF:从端全部关闭,shell 已退出。
            return -1;
        }
        // n < 0:区分“暂时没数据”与真错误。
        match std::io::Error::last_os_error().raw_os_error() {
            Some(e) if e == libc::EAGAIN || e == libc::EWOULDBLOCK => 0,
            Some(e) if e == libc::EINTR => 0, // 被信号打断,按“稍后再试”处理
            _ => -1,
        }
    }

    /// 见 `wtm_pty_write`。
    pub unsafe fn write(master: c_int, buf: *const u8, len: usize) -> isize {
        let n = libc::write(master, buf as *const c_void, len);
        if n >= 0 {
            return n as isize;
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(e) if e == libc::EAGAIN || e == libc::EWOULDBLOCK => 0,
            Some(e) if e == libc::EINTR => 0,
            _ => -1,
        }
    }

    /// 见 `wtm_pty_resize`。
    pub unsafe fn resize(master: c_int, cols: u16, rows: u16) -> c_int {
        let ws = make_winsize(cols, rows);
        // TIOCSWINSZ 在不同平台的常量类型不一,用 `as _` 适配 ioctl 的 request 形参;
        // 第三个变参显式传裸指针,避免 C 变参的隐式转换歧义。
        let rc = libc::ioctl(master, libc::TIOCSWINSZ as _, &ws as *const libc::winsize);
        if rc == 0 {
            0
        } else {
            -2
        }
    }

    /// 见 `wtm_pty_child_exited`。
    pub unsafe fn child_exited(pid: libc::pid_t, out_code: *mut c_int) -> bool {
        let mut status: c_int = 0;
        let rc = libc::waitpid(pid, &mut status, libc::WNOHANG);
        if rc == pid {
            if !out_code.is_null() {
                // 尽力还原退出码:正常退出取低 8 位,被信号杀死记为 128+signo。
                let code = if libc::WIFEXITED(status) {
                    libc::WEXITSTATUS(status)
                } else if libc::WIFSIGNALED(status) {
                    128 + libc::WTERMSIG(status)
                } else {
                    -1
                };
                ptr::write(out_code, code);
            }
            true
        } else {
            // rc == 0:仍在运行;rc < 0:已被别处回收或出错,均视作“无需再收尾”。
            false
        }
    }

    /// 见 `wtm_pty_free`:发 SIGHUP、回收子进程、关闭主端 fd。
    pub unsafe fn shutdown(p: &WtmPty) {
        // 先礼后兵:SIGHUP 通常足以让 shell 退出。
        libc::kill(p.pid, libc::SIGHUP);
        // 非阻塞回收一次;若还没退出,再关闭主端 fd(从端 HUP 会促其退出)。
        let mut status: c_int = 0;
        let _ = libc::waitpid(p.pid, &mut status, libc::WNOHANG);
        if p.master >= 0 {
            libc::close(p.master);
        }
        // 最后阻塞式回收,避免僵尸进程(此时子进程因 HUP/fd 关闭会很快退出)。
        let _ = libc::waitpid(p.pid, &mut status, 0);
    }
}

// ===========================================================================
// 测试(仅 Unix:需要真的 fork 一个进程)
// ===========================================================================
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::thread::sleep;
    use std::time::{Duration, Instant};

    // 从 PTY 里跑一个打印固定字符串的命令,验证 read 能拿到它的输出。
    #[test]
    fn spawn_read_write_roundtrip() {
        // 用 /bin/sh -c 需要 argv 多参数;当前 spawn 只接单程序路径,
        // 因此改跑一个交互式 sh,再通过 write 把命令喂进去。
        let sh = CString::new("/bin/sh").unwrap();
        let pty = unsafe { wtm_pty_spawn(sh.as_ptr(), 80, 24) };
        assert!(!pty.is_null(), "spawn 应成功");

        // 写入一条命令:echo 一个独特标记,然后退出。
        let cmd = b"echo WTMTOKEN_OK\nexit\n";
        let mut off = 0usize;
        while off < cmd.len() {
            let w = unsafe { wtm_pty_write(pty, cmd[off..].as_ptr(), cmd.len() - off) };
            assert!(w >= 0, "write 不应出错");
            off += w as usize;
            if w == 0 {
                sleep(Duration::from_millis(5));
            }
        }

        // 轮询读取输出,直到看到标记或超时。
        let mut acc = Vec::new();
        let mut buf = [0u8; 1024];
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let n = unsafe { wtm_pty_read(pty, buf.as_mut_ptr(), buf.len()) };
            if n > 0 {
                acc.extend_from_slice(&buf[..n as usize]);
                if acc.windows(11).any(|w| w == b"WTMTOKEN_OK") {
                    break;
                }
            } else if n < 0 {
                break; // EOF
            } else {
                sleep(Duration::from_millis(10));
            }
            assert!(Instant::now() < deadline, "超时也没读到 echo 输出");
        }
        assert!(
            acc.windows(11).any(|w| w == b"WTMTOKEN_OK"),
            "应在 PTY 输出里看到 echo 的标记"
        );

        unsafe { wtm_pty_free(pty) };
    }

    #[test]
    fn resize_ok_on_live_pty() {
        let sh = CString::new("/bin/sh").unwrap();
        let pty = unsafe { wtm_pty_spawn(sh.as_ptr(), 80, 24) };
        assert!(!pty.is_null());
        assert_eq!(unsafe { wtm_pty_resize(pty, 120, 40) }, 0, "resize 应成功");
        unsafe { wtm_pty_free(pty) };
    }

    #[test]
    fn null_handle_is_safe() {
        assert_eq!(unsafe { wtm_pty_fd(std::ptr::null()) }, -1);
        let mut b = [0u8; 4];
        assert_eq!(
            unsafe { wtm_pty_read(std::ptr::null_mut(), b.as_mut_ptr(), 4) },
            -1
        );
        assert_eq!(
            unsafe { wtm_pty_write(std::ptr::null_mut(), b.as_ptr(), 4) },
            -1
        );
        assert_eq!(unsafe { wtm_pty_resize(std::ptr::null_mut(), 80, 24) }, -1);
        unsafe { wtm_pty_free(std::ptr::null_mut()) }; // 不应崩溃
    }
}
