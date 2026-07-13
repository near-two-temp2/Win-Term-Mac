// 预加载脚本:在隔离上下文中向渲染进程暴露受控的 PTY 桥接 API
// 渲染进程通过 window.ptyBridge 调用,而无需直接访问 Node/Electron 内部。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ptyBridge', {
  // 创建一个新的终端会话,返回 { ok, id } 或 { ok:false, error }
  create: (opts) => ipcRenderer.invoke('pty:create', opts),

  // 向指定会话写入用户输入
  input: (id, data) => ipcRenderer.send('pty:input', { id, data }),

  // 通知会话调整终端网格尺寸
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),

  // 关闭会话
  kill: (id) => ipcRenderer.send('pty:kill', { id }),

  // 订阅 PTY 输出;返回取消订阅函数
  onData: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('pty:data', listener);
    return () => ipcRenderer.removeListener('pty:data', listener);
  },

  // 订阅 PTY 退出事件;返回取消订阅函数
  onExit: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('pty:exit', listener);
    return () => ipcRenderer.removeListener('pty:exit', listener);
  },
});
