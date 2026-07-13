// main 侧 PTY 管理器:用 node-pty 起真实 shell,并把 创建/输入/尺寸/关闭
// 通过 IPC 暴露给渲染进程。
//
// 设计:main.js 只需
//     const { PtyManager, registerPtyIpc } = require('./pty');
//     const ptyManager = new PtyManager();
//     registerPtyIpc(ipcMain, ptyManager);
// 即可获得与 preload.js(window.ptyBridge)对齐的全部 IPC 通道。
//
// 一个 PtyManager 可托管多个会话(id -> ptyProcess),对应窗格树里的多个叶子终端。

const os = require('os');

// node-pty 是原生模块,若未按当前 Electron ABI 编译好会加载失败;
// 此处降级为 null,让窗口仍能启动,并在 create 时返回明确错误。
let pty = null;
try {
  pty = require('node-pty');
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn('[pty] node-pty 加载失败,终端功能不可用(请运行 npm run rebuild):', err.message);
}

// 根据平台选择默认 shell(macOS/Linux 用 $SHELL,Windows 用 COMSPEC/powershell)
function defaultShell() {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

// 生成一个短小且足够唯一的会话 id
function nextSessionId() {
  return `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

class PtyManager {
  constructor() {
    // id -> ptyProcess
    this.sessions = new Map();
  }

  // node-pty 是否可用(渲染进程可据此提示用户 rebuild)
  isAvailable() {
    return !!pty;
  }

  // 创建一个会话。onData(data) / onExit({ exitCode, signal }) 为回调。
  // 返回 { ok, id } 或 { ok:false, error }。
  create(opts, onData, onExit) {
    if (!pty) {
      return { ok: false, error: 'node-pty 不可用(请先 npm install 并 npm run rebuild)' };
    }
    opts = opts || {};
    const id = nextSessionId();
    const shell = opts.shell || defaultShell();

    let ptyProcess;
    try {
      ptyProcess = pty.spawn(shell, opts.args || [], {
        name: opts.term || 'xterm-color',
        cols: opts.cols || 80,
        rows: opts.rows || 24,
        cwd: opts.cwd || os.homedir(),
        // 允许调用方在默认环境上叠加自定义变量
        env: Object.assign({}, process.env, opts.env || {}),
      });
    } catch (err) {
      return { ok: false, error: `无法启动 shell(${shell}): ${err.message}` };
    }

    ptyProcess.onData((data) => {
      if (typeof onData === 'function') onData(data);
    });
    ptyProcess.onExit((e) => {
      this.sessions.delete(id);
      if (typeof onExit === 'function') onExit(e || {});
    });

    this.sessions.set(id, ptyProcess);
    return { ok: true, id };
  }

  // 向会话写入用户输入
  write(id, data) {
    const p = this.sessions.get(id);
    if (p) p.write(data);
  }

  // 调整终端网格尺寸(cols/rows 非法时忽略)
  resize(id, cols, rows) {
    const p = this.sessions.get(id);
    if (!p) return;
    try {
      p.resize(Math.max(1, cols | 0), Math.max(1, rows | 0));
    } catch (err) {
      // 尺寸非法或进程已退出时忽略
    }
  }

  // 关闭单个会话
  kill(id) {
    const p = this.sessions.get(id);
    if (p) {
      try {
        p.kill();
      } catch (err) {
        // 忽略
      }
      this.sessions.delete(id);
    }
  }

  // 关闭所有会话(应用退出时调用)
  killAll() {
    for (const p of this.sessions.values()) {
      try {
        p.kill();
      } catch (err) {
        // 忽略
      }
    }
    this.sessions.clear();
  }
}

// 把 PtyManager 挂到 IPC 上。通道名与 preload.js 暴露的 ptyBridge 严格对齐:
//   pty:create (invoke) / pty:input (send) / pty:resize (send) / pty:kill (send)
//   pty:data / pty:exit  为主进程 -> 渲染进程的推送。
function registerPtyIpc(ipcMain, manager) {
  manager = manager || new PtyManager();

  ipcMain.handle('pty:create', (event, opts = {}) => {
    const sender = event.sender;
    const res = manager.create(
      opts,
      (data) => {
        // 会话可能在窗口销毁后仍产出数据,防止向已销毁的 sender 发送
        if (!sender.isDestroyed()) sender.send('pty:data', { id: res.id, data });
      },
      (e) => {
        if (!sender.isDestroyed()) {
          sender.send('pty:exit', { id: res.id, exitCode: e.exitCode, signal: e.signal });
        }
      }
    );
    return res;
  });

  ipcMain.on('pty:input', (event, { id, data }) => {
    manager.write(id, data);
  });

  ipcMain.on('pty:resize', (event, { id, cols, rows }) => {
    manager.resize(id, cols, rows);
  });

  ipcMain.on('pty:kill', (event, { id }) => {
    manager.kill(id);
  });

  return manager;
}

module.exports = { PtyManager, registerPtyIpc, defaultShell };
