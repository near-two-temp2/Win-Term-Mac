// Win-Term-Mac · Tauri 后端 · PTY 角色
//
// 职责:用 portable-pty 跨平台起 shell,把「一个窗格叶子」映射成「一个 PTY 会话」。
//   - 前端按键  → invoke("pty_write")  → 写进 PTY
//   - PTY 输出  → 后台读线程 emit("pty://output") → 前端 listen 喂给对应 xterm 实例
//   - 尺寸变化  → invoke("pty_resize")
//   - 关闭窗格  → invoke("pty_kill")
//
// 每个 PTY 用一个自增 u32 id 标识,前端窗格树里的 leaf.termId 即此 id。
// 会话表用进程内全局单例持有,避免侵入 main.rs 的 .manage() 装配。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

// ── 事件名(与前端 src/ipc.js 约定一致)────────────────────────────────
// 输出流:每次从 PTY 读到字节就 emit 一次。
const EVENT_OUTPUT: &str = "pty://output";
// 退出通知:shell 结束 / 读到 EOF 时 emit 一次。
const EVENT_EXIT: &str = "pty://exit";

// ── 单个 PTY 会话 ──────────────────────────────────────────────────────
struct PtySession {
    // 主端句柄:用于 resize(读端/写端已分别 clone/take 出去)。
    master: Box<dyn MasterPty + Send>,
    // 写端:前端按键字节写这里。
    writer: Box<dyn Write + Send>,
    // 子进程:用于 kill。
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

// 进程内会话表:id -> 会话。
fn sessions() -> &'static Mutex<HashMap<u32, PtySession>> {
    static SESSIONS: OnceLock<Mutex<HashMap<u32, PtySession>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

// PTY id 自增源(从 1 开始,0 保留作「无效」)。
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

// ── 输出事件载荷 ───────────────────────────────────────────────────────
// data 走原始字节(Vec<u8>),避免多字节 UTF-8 被跨 read 边界切断时丢字符;
// 前端用 new Uint8Array(data) 直接喂给 xterm.js(其内部会做 VT/UTF-8 缓冲)。
#[derive(Clone, Serialize)]
struct PtyOutput {
    id: u32,
    data: Vec<u8>,
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: u32,
}

// 选一个默认 shell:优先环境变量,回落到平台常见值。
fn default_shell() -> String {
    if cfg!(windows) {
        // WT 默认走 PowerShell;这里用 COMSPEC(通常是 cmd.exe)作稳妥回落。
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

// ── command:新开一个 PTY(对应一个窗格叶子)────────────────────────────
// 返回 pty_id,前端据此在窗格树里记 leaf.termId,并按 id 路由输出事件。
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
) -> Result<u32, String> {
    let size = PtySize {
        rows: rows.unwrap_or(24),
        cols: cols.unwrap_or(80),
        pixel_width: 0,
        pixel_height: 0,
    };

    // 开一对 PTY(master/slave)。
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("openpty 失败: {e}"))?;

    // 在 slave 端拉起 shell。
    let cmd = CommandBuilder::new(shell.unwrap_or_else(default_shell));
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn shell 失败: {e}"))?;
    // slave 交给子进程后即可释放(master 仍持有以便 resize)。
    drop(pair.slave);

    // 分别取出读端 / 写端。
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader 失败: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer 失败: {e}"))?;

    // 分配 id,登记会话。
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    sessions().lock().unwrap().insert(
        id,
        PtySession {
            master: pair.master,
            writer,
            child,
        },
    );

    // 后台读线程:把 PTY 输出源源不断 emit 给前端。
    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF:shell 已退出。
                Ok(n) => {
                    let payload = PtyOutput {
                        id,
                        data: buf[..n].to_vec(),
                    };
                    // emit 失败(窗口已关等)时静默结束读循环。
                    if app_for_thread.emit(EVENT_OUTPUT, payload).is_err() {
                        break;
                    }
                }
                Err(_) => break, // 读错误(master 被 drop 等):结束。
            }
        }
        // 清理会话并通知前端该窗格已终止。
        sessions().lock().unwrap().remove(&id);
        let _ = app_for_thread.emit(EVENT_EXIT, PtyExit { id });
    });

    Ok(id)
}

// ── command:向指定 PTY 写入按键字节 ───────────────────────────────────
// 前端 term.onData 得到的字符串(含控制序列)原样写入 PTY 输入。
#[tauri::command]
pub fn pty_write(id: u32, data: String) -> Result<(), String> {
    let mut guard = sessions().lock().unwrap();
    let session = guard
        .get_mut(&id)
        .ok_or_else(|| format!("PTY {id} 不存在"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("写 PTY {id} 失败: {e}"))?;
    session
        .writer
        .flush()
        .map_err(|e| format!("flush PTY {id} 失败: {e}"))?;
    Ok(())
}

// ── command:窗格尺寸变化时调整 PTY 行列 ────────────────────────────────
// 前端 fit addon 算出新的 cols/rows 后调用,保证远端程序(vim/htop 等)排版正确。
#[tauri::command]
pub fn pty_resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let guard = sessions().lock().unwrap();
    let session = guard.get(&id).ok_or_else(|| format!("PTY {id} 不存在"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize PTY {id} 失败: {e}"))?;
    Ok(())
}

// ── command:关闭窗格时销毁 PTY ─────────────────────────────────────────
// 从会话表移除并 kill 子进程;master 随之 drop,读线程读到 EOF 后自行退出。
#[tauri::command]
pub fn pty_kill(id: u32) -> Result<(), String> {
    let mut session = sessions()
        .lock()
        .unwrap()
        .remove(&id)
        .ok_or_else(|| format!("PTY {id} 不存在"))?;
    // 尽力 kill;即便失败也已从表中移除,句柄 drop 会释放资源。
    let _ = session.child.kill();
    Ok(())
}
