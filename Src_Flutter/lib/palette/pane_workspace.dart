// Win-Term-Mac / Src_Flutter 方案 ——【Palette / 装配】角色(工作区装配件)。
//
// 本文件是【cmd】功能的“总装”:把已有的四块零件缝到一起,做成一个可直接嵌入
// 主窗口 body 的、完全可操作的窗格工作区 [PaneWorkspace]:
//
//   keymap.dart        —— 快捷键表 + PaneAction 意图词表;
//   command_palette.dart—— 可搜索的命令面板浮层;
//   pane_controller.dart—— 把意图落到窗格树的有状态控制器;
//   pane_tree_view.dart —— 把窗格树画成真终端 + 可拖拽分隔条。
//
// 装配内容:
//   1) Shortcuts(Keymap.buildShortcuts) + Actions(PaneActionIntent) 把热键接到
//      控制器:拆分 / 切焦点(Alt+方向)/ 调整大小(Alt+Shift+方向)/ 命令面板
//      (Ctrl/Cmd+Shift+P)/ 关闭 / 最大化。
//   2) 命令面板:Ctrl/Cmd+Shift+P 打开,复用 defaultPaletteCommands;可搜索。
//   3) swap / move **仅命令面板触发**,且是两段式:先在面板选“交换/移动窗格”,
//      面板关闭后再弹出“目标窗格选择器”(同样是可搜索的命令面板),选中目标后
//      才真正 swap/move —— 满足“swap/move 无热键、仅面板触发”的硬性要求。
//   4) 最大化(zoom)时只渲染焦点窗格铺满整块区域(复用 EmbeddedTerminalView)。
//
// -----------------------------------------------------------------------------
// integrator 需要如何调用我(入口 main.dart 由整合 agent 负责,勿改):
//
//   final registry = TerminalSessionRegistry();   // 全局持有一次
//   // 在主窗口 body 里:
//   PaneWorkspace(registry: registry)             // 就这一行,自带键位/面板/分屏
//
//   // 若想自己掌控初始树 / 复用外部控制器:
//   final controller = PaneController(registry: registry);
//   PaneWorkspace(registry: registry, controller: controller);
//
//   // App 退出时:registry.disposeAll();(杀掉所有子进程)
//   // 注意:命令面板需要一个 Navigator/Overlay 上下文 —— 确保 PaneWorkspace 处于
//   //       MaterialApp 之下(通常都满足)。
// -----------------------------------------------------------------------------

import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

import '../keymap/keymap.dart';
import '../pane/pane.dart';
import '../term/pane_tree_view.dart';
import '../term/terminal_session.dart';
import 'command_palette.dart';
import 'pane_controller.dart';

/// 可直接嵌入的窗格工作区:键位 + 命令面板 + 分屏渲染一体化。
class PaneWorkspace extends StatefulWidget {
  const PaneWorkspace({
    super.key,
    required this.registry,
    this.controller,
    this.terminalTheme,
  });

  /// 会话注册表(按叶子 id 托管真实 shell)。若未提供 [controller],
  /// 本组件会用它内部新建一个 [PaneController]。
  final TerminalSessionRegistry registry;

  /// 外部控制器;为空时内部自建(并在 dispose 时释放)。
  final PaneController? controller;

  /// 终端配色主题(透传给 xterm 视图)。
  final TerminalTheme? terminalTheme;

  @override
  State<PaneWorkspace> createState() => _PaneWorkspaceState();
}

class _PaneWorkspaceState extends State<PaneWorkspace> {
  late final PaneController _controller;
  bool _ownsController = false;

  /// 命令面板是否已打开(避免热键连按叠开多个)。
  bool _paletteOpen = false;

  /// 第一段面板里选了 swap/move 时暂存的意图;面板关闭后据此进入第二段。
  PaneAction? _pendingTargetAction;

  @override
  void initState() {
    super.initState();
    final provided = widget.controller;
    if (provided != null) {
      _controller = provided;
    } else {
      _controller = PaneController(registry: widget.registry);
      _ownsController = true;
    }
  }

  @override
  void dispose() {
    if (_ownsController) _controller.dispose();
    super.dispose();
  }

  // ---------------------------------------------------------------------------
  // 意图分派:热键 / 命令面板都汇聚到这里
  // ---------------------------------------------------------------------------

  /// 处理一个 [PaneAction](来自快捷键 Actions 或命令面板某条命令)。
  void _dispatch(PaneAction action) {
    switch (action) {
      case PaneAction.toggleCommandPalette:
        _openCommandPalette();
      case PaneAction.splitRight:
        _controller.splitFocused(SplitAxis.horizontal);
      case PaneAction.splitDown:
        _controller.splitFocused(SplitAxis.vertical);
      case PaneAction.focusUp:
        _controller.moveFocus(PaneDirection.up);
      case PaneAction.focusDown:
        _controller.moveFocus(PaneDirection.down);
      case PaneAction.focusLeft:
        _controller.moveFocus(PaneDirection.left);
      case PaneAction.focusRight:
        _controller.moveFocus(PaneDirection.right);
      case PaneAction.resizeUp:
        _controller.resizeFocused(PaneDirection.up);
      case PaneAction.resizeDown:
        _controller.resizeFocused(PaneDirection.down);
      case PaneAction.resizeLeft:
        _controller.resizeFocused(PaneDirection.left);
      case PaneAction.resizeRight:
        _controller.resizeFocused(PaneDirection.right);
      case PaneAction.closePane:
        _controller.closeFocused();
      case PaneAction.toggleMaximizePane:
        _controller.toggleMaximize();
      case PaneAction.swapPane:
      case PaneAction.movePane:
        // 两段式:仅记下意图,真正的“目标窗格选择器”在第一段面板 **完全关闭
        // 之后** 才打开(见 _openCommandPalette),避免两个浮层抢同一帧、
        // 也避免第一段面板的关闭动画尚未结束时误判 _paletteOpen。
        _pendingTargetAction = action;
    }
  }

  // ---------------------------------------------------------------------------
  // 命令面板(第一段:选命令)
  // ---------------------------------------------------------------------------

  Future<void> _openCommandPalette() async {
    if (_paletteOpen) return;
    _paletteOpen = true;
    _pendingTargetAction = null;
    try {
      await showCommandPalette(
        context,
        commands: defaultPaletteCommands(dispatch: _dispatch),
        hintText: '输入命令…(试试“拆分 / 交换 / 移动 / 焦点”)',
      );
    } finally {
      _paletteOpen = false;
    }

    // 第一段面板已完全关闭。若刚才选的是 swap/move,再进入第二段目标选择器。
    final pending = _pendingTargetAction;
    _pendingTargetAction = null;
    if (pending != null && mounted) {
      await _openTargetPicker(pending);
    }
  }

  // ---------------------------------------------------------------------------
  // 目标选择器(第二段:swap / move 选目标窗格)
  // ---------------------------------------------------------------------------

  Future<void> _openTargetPicker(PaneAction action) async {
    if (_paletteOpen) return;

    final targets = _targetCommands(action);
    if (targets.isEmpty) {
      // 只有一个窗格,没有可交换/移动的目标。给个轻提示,不弹空面板。
      final messenger = ScaffoldMessenger.maybeOf(context);
      messenger?.showSnackBar(
        const SnackBar(
          content: Text('当前只有一个窗格,先拆分出更多窗格再试'),
          duration: Duration(milliseconds: 1600),
        ),
      );
      return;
    }

    _paletteOpen = true;
    try {
      final verb = action == PaneAction.swapPane ? '交换' : '移动';
      await showCommandPalette(
        context,
        commands: targets,
        hintText: '选择要$verb的目标窗格…',
      );
    } finally {
      _paletteOpen = false;
    }
  }

  /// 为 swap/move 构造“目标窗格”命令列表(排除焦点自身)。
  List<PaletteCommand> _targetCommands(PaneAction action) {
    final focused = _controller.focusedLeafId;
    final swap = action == PaneAction.swapPane;

    // 稳定顺序 + 序号,便于“1/2/3…”式快速定位。
    final others =
        _controller.root.leaves.where((l) => l.id != focused).toList();

    final commands = <PaletteCommand>[];
    for (var i = 0; i < others.length; i++) {
      final leaf = others[i];
      final displayName = leaf.title ?? '窗格 ${leaf.id}';
      commands.add(
        PaletteCommand(
          id: 'pane.target.${leaf.id}',
          title: '${i + 1}. $displayName',
          subtitle: swap ? '与焦点窗格互换位置' : '把焦点窗格移动到它右侧',
          keywords: [leaf.id, displayName, '${i + 1}'],
          icon: swap ? Icons.swap_horiz : Icons.open_with,
          onInvoke: () {
            if (swap) {
              _controller.swap(leaf.id);
            } else {
              // TODO(增强): 目标方向(右/下/左/上)可再加一层选择;
              //   当前默认水平(新位置在目标右侧),已能验证 move 通路。
              _controller.move(leaf.id, SplitAxis.horizontal);
            }
          },
        ),
      );
    }
    return commands;
  }

  // ---------------------------------------------------------------------------
  // 装配:Shortcuts + Actions + 视图
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final platform = Theme.of(context).platform;

    // 键位优先级说明(留给 term / 整合角色):
    //   Flutter 的 Shortcuts 按“焦点叶子 → 祖先”的顺序派发按键,焦点终端
    //   (xterm TerminalView)会先拿到事件。像 Alt+方向、Alt+Shift+方向 这类
    //   组合,在真终端里本身也是合法输入(会被编码成转义序列发给 shell)。
    //   若希望它们始终当作“窗格快捷键”(WT 的行为),需要终端角色对这些组合
    //   返回 KeyEventResult.ignored(放行给祖先 Shortcuts)。本装配已正确注册
    //   快捷键;“谁先吃到键”由终端是否放行决定。
    //   TODO(集成): 在 TerminalView 外层用 Focus.onKeyEvent 过滤掉 keymap 里的
    //     组合键并返回 ignored,或配置 xterm 不消费这些组合。
    return Shortcuts(
      shortcuts: Keymap.buildShortcuts(platform: platform),
      child: Actions(
        actions: <Type, Action<Intent>>{
          PaneActionIntent: CallbackAction<PaneActionIntent>(
            onInvoke: (intent) {
              _dispatch(intent.action);
              return null;
            },
          ),
        },
        // FocusScope 提供一个稳定的作用域,但不用 autofocus 抢焦点 ——
        // 初始焦点交给 PaneTreeView 里“焦点叶子”的终端(它自带 autofocus),
        // 这样键盘输入能直接进入 shell。
        child: FocusScope(
          child: ListenableBuilder(
            listenable: _controller,
            builder: (context, _) => _buildBody(),
          ),
        ),
      ),
    );
  }

  Widget _buildBody() {
    final maxId = _controller.maximizedLeafId;
    if (maxId != null) {
      // 最大化:只渲染焦点窗格,铺满整块区域(复用现成的可嵌入终端视图)。
      final session = widget.registry.sessionFor(maxId);
      return EmbeddedTerminalView(
        key: ValueKey('maximized:$maxId'),
        session: session,
        autofocus: true,
        theme: widget.terminalTheme,
      );
    }

    return PaneTreeView(
      root: _controller.root,
      registry: widget.registry,
      focusedLeafId: _controller.focusedLeafId,
      onFocusLeaf: _controller.focusLeaf,
      onRatioChanged: _controller.setRatioAt,
      terminalTheme: widget.terminalTheme,
    );
  }
}
