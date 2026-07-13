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
//   1) Focus.onKeyEvent 复用 Keymap.buildShortcuts 的键位表,拦截冒泡上来的
//      热键并分派到控制器:拆分 / 切焦点(Alt+方向)/ 调整大小(Alt+Shift+方向)
//      / 命令面板(Ctrl/Cmd+Shift+P)/ 关闭 / 最大化。终端侧配套放行这些组合
//      (见 term/terminal_session.dart),否则会被 xterm 的输入处理器吃掉。
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
import 'package:flutter/services.dart';
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

  /// 当前平台的窗格键位表(每次 build 依平台刷新);[_handleKeyEvent] 据此匹配。
  Map<ShortcutActivator, Intent> _shortcuts =
      const <ShortcutActivator, Intent>{};

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
  // 装配:Focus.onKeyEvent 热键拦截 + 视图
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final platform = Theme.of(context).platform;
    // 依平台刷新键位表(macOS 用 Cmd,其余用 Ctrl;Alt 系列不变),
    // 供 [_handleKeyEvent] 匹配冒泡上来的按键。
    _shortcuts = Keymap.buildShortcuts(platform: platform);

    // 热键接线的关键:用 Focus.onKeyEvent 在按键沿焦点链冒泡到本节点时拦截
    // 窗格热键。焦点终端(xterm TerminalView)是本 Focus 的后代且持有主焦点,
    // 按键先到它;它对「非自身文本输入」的组合返回 ignored 后,事件才冒泡到
    // 这里。其中 Alt+方向、Alt+Shift+± / 方向、Ctrl+Shift+P 默认会被 xterm 的
    // Alt/Ctrl 输入处理器翻译成转义序列并消费掉 —— 已在 TerminalSession 侧改用
    // 放行这些组合的输入处理器(见 term/terminal_session.dart),因此它们也能
    // 冒泡到此处被拦截,返回 handled;其余按键返回 ignored,原样交给终端。
    return Focus(
      // 不抢占键盘焦点:主焦点留给终端以保证正常输入;本节点仅作为焦点链上的
      // 热键拦截器存在(canRequestFocus:false 不影响它作为祖先接收冒泡按键)。
      canRequestFocus: false,
      onKeyEvent: _handleKeyEvent,
      child: ListenableBuilder(
        listenable: _controller,
        builder: (context, _) => _buildBody(),
      ),
    );
  }

  /// 焦点链冒泡到本节点时的按键拦截:命中窗格热键则分派并「吃掉」(handled),
  /// 其余按键放行(ignored)给终端 / 上层。
  KeyEventResult _handleKeyEvent(FocusNode node, KeyEvent event) {
    // 只在按下 / 长按重复时匹配;抬起不触发,避免同一次按键重复分派。
    if (event is KeyUpEvent) return KeyEventResult.ignored;

    final keyboard = HardwareKeyboard.instance;
    for (final entry in _shortcuts.entries) {
      if (!entry.key.accepts(event, keyboard)) continue;
      final intent = entry.value;
      if (intent is PaneActionIntent) {
        _dispatch(intent.action);
        return KeyEventResult.handled;
      }
    }
    return KeyEventResult.ignored;
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
