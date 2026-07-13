// Win-Term-Mac / Src_Flutter 方案入口(整合 agent 负责)。
//
// 本文件把四个功能模块接线成一个可运行的桌面终端 App:
//   - term/terminal_session.dart   —— 单个真终端(xterm + flutter_pty)。
//   - term/pane_tree_view.dart      —— 会话注册表 + 把窗格树画成真终端。
//   - pane/pane.dart                —— 纯窗格二叉树模型(split/swap/move/navigate)。
//   - keymap/keymap.dart            —— WT 键位 -> PaneAction 意图。
//   - palette/command_palette.dart  —— 可搜索命令面板浮层。
//   - palette/pane_controller.dart  —— 把意图落到窗格树的有状态控制器。
//   - palette/pane_workspace.dart   —— 键位 + 命令面板 + 分屏渲染的总装 Widget。
//
// 接线方式(遵循各模块顶部的 integrator 指引):
//   1) 在 State 里持有唯一的 TerminalSessionRegistry(App 生命周期内只建一次);
//   2) Scaffold.body 放一个 PaneWorkspace(registry: registry),即获得:
//      真终端显示 + 敲命令 + 拆分(Alt+Shift+±)+ Alt+方向切焦点 +
//      Ctrl/Cmd+Shift+P 命令面板 + 拖拽分隔条调比例;
//   3) App 释放时 registry.disposeAll() 杀掉所有子进程。
//
// 注意:命令面板需要 Navigator/Overlay 上下文,PaneWorkspace 处于 MaterialApp
// 之下即可满足。
//
// 说明:窗格工作区统一走 palette 版实现(带命令面板两段式 swap/move 目标
//   选择器)。历史上曾有一份等价的 pane/pane_workspace.dart,现已删除以避免
//   两套逻辑分叉;pane/ 目录只保留纯窗格模型 pane.dart。

import 'package:flutter/material.dart';

import 'palette/pane_workspace.dart';
import 'term/pane_tree_view.dart';

void main() {
  // TODO(集成): 若引入 window_manager/bitsdojo_window 之类的桌面窗口库,
  //   在此做窗口标题/初始尺寸/无边框标题栏等初始化(需先 ensureInitialized)。
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

/// 主窗口外壳:标题栏 + 窗格工作区。
///
/// 用 StatefulWidget 持有唯一的 [TerminalSessionRegistry](按叶子 id 托管真实
/// shell 进程),并在 [dispose] 时统一回收所有子进程。
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  /// 全 App 唯一的会话注册表:拆分/交换/移动只重排 id,进程随会话长存;
  /// 只有关闭叶子或退出 App 时才真正杀进程。
  final TerminalSessionRegistry _registry = TerminalSessionRegistry();

  @override
  void dispose() {
    // App 退出:杀掉所有 shell 子进程。
    _registry.disposeAll();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Win-Term-Mac · Flutter'),
        titleTextStyle: const TextStyle(
          fontSize: 14,
          color: Color(0xFFCCCCCC),
        ),
        toolbarHeight: 40,
        // 提示:命令面板走 Ctrl/Cmd+Shift+P(由 PaneWorkspace 内部接线)。
      ),
      body: Padding(
        padding: const EdgeInsets.all(6),
        // 窗格工作区:自带键位 / 命令面板 / 分屏渲染,一行即接入。
        child: PaneWorkspace(registry: _registry),
      ),
    );
  }
}
