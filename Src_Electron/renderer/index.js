// 渲染进程入口:初始化一个 xterm 终端,并接入主进程的 PTY 桥接。
// 说明:这是脚手架阶段,只启动单个终端。窗格树(split/swap/move/navigate)
// 将在后续由 pane-tree 模块接管 #pane-root,本文件届时降级为"单叶子"的创建逻辑。

/* global Terminal, FitAddon, WebglAddon */

(function bootstrap() {
  const host = document.getElementById('terminal');
  if (!host) {
    console.error('[renderer] 未找到 #terminal 容器');
    return;
  }

  // 1) 创建 xterm 实例
  const term = new Terminal({
    fontFamily: 'Menlo, Consolas, "Cascadia Mono", monospace',
    fontSize: 14,
    cursorBlink: true,
    allowProposedApi: true,
    theme: {
      background: '#1e1e1e',
      foreground: '#d4d4d4',
    },
  });

  // 2) FitAddon:让终端网格自适应容器尺寸
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  term.open(host);

  // 3) 尝试启用 WebGL 渲染以获得更好性能;失败则回退到默认 canvas
  try {
    const webgl = new WebglAddon.WebglAddon();
    term.loadAddon(webgl);
  } catch (err) {
    console.warn('[renderer] WebGL 渲染不可用,使用默认渲染:', err.message);
  }

  fitAddon.fit();

  // 4) 接入 PTY 桥接
  const bridge = window.ptyBridge;
  if (!bridge) {
    term.writeln('\x1b[31m[错误] ptyBridge 未注入,请检查 preload.js\x1b[0m');
    return;
  }

  let sessionId = null;

  // 订阅来自 PTY 的输出
  const offData = bridge.onData(({ id, data }) => {
    if (id === sessionId) term.write(data);
  });
  const offExit = bridge.onExit(({ id }) => {
    if (id === sessionId) {
      term.writeln('\r\n\x1b[90m[会话已结束]\x1b[0m');
    }
  });

  // 创建 PTY 会话,并把维度告知主进程
  bridge
    .create({ cols: term.cols, rows: term.rows })
    .then((res) => {
      if (!res || !res.ok) {
        term.writeln(`\x1b[31m[错误] 无法创建终端会话: ${res && res.error}\x1b[0m`);
        term.writeln('\x1b[90m提示:请先执行 npm install 与 npm run rebuild 编译 node-pty。\x1b[0m');
        return;
      }
      sessionId = res.id;

      // 用户键入 -> 转发给 PTY
      term.onData((data) => {
        if (sessionId) bridge.input(sessionId, data);
      });
    })
    .catch((err) => {
      term.writeln(`\x1b[31m[错误] 创建会话异常: ${err.message}\x1b[0m`);
    });

  // 5) 窗口尺寸变化时重新 fit 并同步给 PTY
  window.addEventListener('resize', () => {
    fitAddon.fit();
    if (sessionId) bridge.resize(sessionId, term.cols, term.rows);
  });

  // 6) 卸载时清理订阅
  window.addEventListener('beforeunload', () => {
    offData && offData();
    offExit && offExit();
    if (sessionId) bridge.kill(sessionId);
  });

  // TODO(pane-tree): 后续由窗格树模块接管——
  //   - split:把当前叶子替换为分裂节点(横/竖 + 比例)
  //   - swap / move / detach / attach:通过命令面板触发
  //   - navigate:Alt/Cmd + 方向键按几何相邻切焦点
  //   本文件的单终端初始化逻辑将被抽为 createLeafTerminal(host)。
})();
