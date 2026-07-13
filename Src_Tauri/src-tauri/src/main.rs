// Win-Term-Mac · Tauri 后端入口
// 职责:创建 Tauri 应用、注册 PTY 相关 IPC command。
// 前端通过 invoke 调用这些 command,PTY 输出通过 emit 事件流回前端。

// 生产环境下隐藏 Windows 控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// 声明 PTY 模块。真正的实现由 PTY 角色在 src/pty.rs 中提供:
// - spawn / 读循环(emit "pty://output")/ 写入 / resize / kill。
// TODO(集成): pty.rs 需导出下列 #[tauri::command],命名如与实现不一致时在此对齐。
mod pty;

fn main() {
    tauri::Builder::default()
        // 注册前端可 invoke 的 PTY 命令。
        // 这些命令的实现位于 pty.rs;此处只做装配。
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,  // 新开一个 PTY(对应一个窗格叶子),返回 pty_id
            pty::pty_write,  // 向指定 PTY 写入按键字节
            pty::pty_resize, // 窗格尺寸变化时调整 PTY 行列
            pty::pty_kill,   // 关闭窗格时销毁 PTY
        ])
        .run(tauri::generate_context!())
        .expect("启动 Win-Term-Mac 失败");
}
