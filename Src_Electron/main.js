// 主进程入口:创建 BrowserWindow 并托管 PTY(伪终端)
// 说明:窗格树的业务逻辑在渲染进程,主进程只负责窗口与真实终端进程的桥接。

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');

// node-pty 用于生成真实 shell 进程;若原生模块未编译好,降级为 null 以保证窗口仍能启动
let pty = null;
try {
  pty = require('node-pty');
} catch (err) {
  console.warn('[main] node-pty 加载失败,终端功能不可用(请运行 npm run rebuild):', err.message);
}

// 记录所有已创建的 PTY 会话:id -> ptyProcess
const ptySessions = new Map();

// 根据平台选择默认 shell
function defaultShell() {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile('index.html');

  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  return win;
}

// ---- IPC:渲染进程 <-> PTY 桥接 ----

// 创建一个新的 PTY 会话,返回其 id
ipcMain.handle('pty:create', (event, opts = {}) => {
  if (!pty) {
    return { ok: false, error: 'node-pty 不可用' };
  }
  const id = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const shell = opts.shell || defaultShell();
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols: opts.cols || 80,
    rows: opts.rows || 24,
    cwd: opts.cwd || os.homedir(),
    env: process.env,
  });

  // 将 PTY 输出转发回对应的渲染进程
  ptyProcess.onData((data) => {
    event.sender.send('pty:data', { id, data });
  });
  ptyProcess.onExit(({ exitCode }) => {
    event.sender.send('pty:exit', { id, exitCode });
    ptySessions.delete(id);
  });

  ptySessions.set(id, ptyProcess);
  return { ok: true, id };
});

// 渲染进程键入 -> 写入 PTY
ipcMain.on('pty:input', (event, { id, data }) => {
  const p = ptySessions.get(id);
  if (p) p.write(data);
});

// 终端尺寸变化 -> 通知 PTY
ipcMain.on('pty:resize', (event, { id, cols, rows }) => {
  const p = ptySessions.get(id);
  if (p) {
    try {
      p.resize(cols, rows);
    } catch (err) {
      // 尺寸非法时忽略
    }
  }
});

// 关闭某个会话
ipcMain.on('pty:kill', (event, { id }) => {
  const p = ptySessions.get(id);
  if (p) {
    p.kill();
    ptySessions.delete(id);
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 退出前清理所有 PTY
  for (const p of ptySessions.values()) {
    try {
      p.kill();
    } catch (err) {
      // 忽略
    }
  }
  ptySessions.clear();
  if (process.platform !== 'darwin') app.quit();
});
