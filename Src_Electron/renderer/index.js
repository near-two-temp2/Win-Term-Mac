// 渲染进程入口:装配窗格树视图。
// 之前是单个 xterm 的脚手架;现在交给 PaneManager(renderer/panes.js)统一驱动——
// 它内部用 PaneCore(pane.js)建二叉树布局、用 LeafTerminal(terminal.js)为每个叶子
// 建真实终端并接 PTY、用 Keymap(keymap.js)+ Palette(palette.js)接好热键与命令面板。
//
// 因此本文件只需一句 create 即可拿到:
//   - 启动即一个跑 shell 的真终端(可敲命令);
//   - Alt+Shift+±   拆分窗格;
//   - Alt+方向      切焦点;Alt+Shift+方向 调比例;
//   - Ctrl/Cmd+Shift+P  打开命令面板(swap/move/maximize/close 等)。
//
// 依赖:index.html 需在本文件之前依次引入
//   xterm/插件(Terminal/FitAddon/WebglAddon)→ pane.js → keymap.js → palette.js → terminal.js → panes.js。
// 桥接:window.ptyBridge 由 preload.js 注入;主进程 main.js 负责 node-pty 会话。

/* global PaneManager */

(function bootstrap() {
  const container = document.getElementById('pane-root');
  if (!container) {
    console.error('[renderer] 未找到 #pane-root 容器');
    return;
  }

  if (typeof PaneManager === 'undefined' || typeof PaneManager.create !== 'function') {
    console.error('[renderer] PaneManager 未加载,请检查 index.html 的脚本引入顺序');
    return;
  }

  // 建立可交互窗格视图。PaneManager 内部会:
  //   建根叶子 → onLeafMount 创建 xterm+PTY 并聚焦 → 安装捕获阶段 keydown → 建命令面板。
  const manager = PaneManager.create({
    container,
    // 透传给 LeafTerminal 的终端选项(shell/cwd 走主进程默认;主题与基线保持一致)。
    termOptions: {
      fontFamily: 'Menlo, Consolas, "Cascadia Mono", monospace',
      fontSize: 14,
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
      },
    },
  });

  // 暴露到 window,便于调试与后续(标签层/主进程)接线;非必需。
  window.__paneManager = manager;

  // 页面卸载时回收监听与命令面板(各叶子终端会各自 dispose 其 PTY 会话)。
  window.addEventListener('beforeunload', () => {
    if (manager && typeof manager.destroy === 'function') manager.destroy();
  });

  // 关闭最后一个窗格:PaneManager 默认执行 window.close()(关掉唯一窗格即关窗)。
  //   若接入标签层需改为"保留窗口 / 新建标签"等策略,给 create 传 onLastPaneClosed 回调即可,例如:
  //     PaneManager.create({ container, onLastPaneClosed: (leaf) => tabLayer.closeCurrentTab() });
  //
  // 备注:PTY↔xterm 的数据平面由 renderer/io.js(window.IoBridge)承担——整个渲染进程
  //   只订阅一次 pty:data/pty:exit 并按 sessionId 做 O(1) 路由;LeafTerminal(terminal.js)
  //   内部已接入,无需 integrator 额外装配。
})();
