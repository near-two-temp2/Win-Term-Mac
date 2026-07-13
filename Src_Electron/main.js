// 主进程入口:创建 BrowserWindow 并托管 PTY(伪终端)
// 说明:窗格树的业务逻辑在渲染进程,主进程只负责窗口与真实终端进程的桥接。
//
// PTY 会话的生命周期与 IPC 通道统一由 pty.js 的 PtyManager/registerPtyIpc 提供:
//   - 单点管理多会话(id -> ptyProcess),与窗格树的多个叶子终端一一对应;
//   - onData/onExit 推送前带 sender.isDestroyed() 守卫,避免窗口关闭后 PTY 仍产
//     数据时向已销毁的 webContents 发送而抛 "Object has been destroyed"。
// 因此本文件不再自建 node-pty 会话表,消除与 pty.js 的重复实现。

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { PtyManager, registerPtyIpc } = require('./pty');

// 托管所有 PTY 会话;registerPtyIpc 把 create/input/resize/kill 通道接到它上面,
// 通道名与 preload.js 暴露的 window.ptyBridge 严格对齐。
const ptyManager = new PtyManager();
registerPtyIpc(ipcMain, ptyManager);

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

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 退出前清理所有 PTY,避免遗留孤儿 shell 进程
  ptyManager.killAll();
  if (process.platform !== 'darwin') app.quit();
});
