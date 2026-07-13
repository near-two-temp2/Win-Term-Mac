// Win-Term-Mac / Src_Flutter 方案入口。
//
// 本文件属于【Scaffold】角色:只负责搭出一个可运行的 Flutter 桌面 App 骨架,
// 主窗口里放一个占位的终端区域。真正的窗格二叉树、xterm.dart 仿真、flutter_pty
// 接线由其他角色在各自文件里实现,这里仅用 TODO 桩标注集成点。

import 'package:flutter/material.dart';

void main() {
  // TODO(集成): 在这里做桌面窗口初始化(窗口标题/尺寸、快捷键上下文等)。
  runApp(const WinTermMacApp());
}

/// App 根组件。
class WinTermMacApp extends StatelessWidget {
  const WinTermMacApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Win-Term-Mac',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark(useMaterial3: true),
      home: const HomeShell(),
    );
  }
}

/// 主窗口外壳:标题栏 + 窗格区域。
///
/// 目前窗格区域只放一个占位终端。后续这里会被窗格二叉树(PaneTree)的
/// 渲染组件替换 —— 由分裂/交换/移动/导航等操作驱动。
class HomeShell extends StatelessWidget {
  const HomeShell({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Win-Term-Mac · Flutter'),
        // TODO(集成): 命令面板入口(Ctrl/Cmd+Shift+P)按钮 + 键盘绑定。
      ),
      body: const Padding(
        padding: EdgeInsets.all(8),
        // TODO(集成): 用窗格二叉树的渲染组件替换这个占位区域。
        child: TerminalPanePlaceholder(),
      ),
    );
  }
}

/// 占位终端窗格。
///
/// 仅用于展示布局位置。真实实现应把这里替换成 xterm.dart 的 TerminalView,
/// 并通过 flutter_pty 接一个真实 shell 进程。
class TerminalPanePlaceholder extends StatelessWidget {
  const TerminalPanePlaceholder({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFF0C0C0C), // WT 默认背景近似色
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: const Color(0xFF3A3A3A)),
      ),
      child: const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.terminal, size: 48, color: Color(0xFF808080)),
            SizedBox(height: 12),
            Text(
              '终端占位区',
              style: TextStyle(
                color: Color(0xFFCCCCCC),
                fontFamily: 'monospace',
              ),
            ),
            SizedBox(height: 4),
            Text(
              'TODO: 接入 xterm.dart + flutter_pty',
              style: TextStyle(color: Color(0xFF808080), fontSize: 12),
            ),
          ],
        ),
      ),
    );
  }
}
