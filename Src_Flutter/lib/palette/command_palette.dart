// Win-Term-Mac / Src_Flutter 方案 ——【Palette】角色(命令面板部分)。
//
// 本文件实现“命令面板”浮层:一个可搜索的命令列表(仿 WT 的 Ctrl/Cmd+Shift+P),
// 用来触发窗格动作。与 WT 的设计哲学一致:
//   - 高频操作(拆分/调整/切焦点)主要靠热键,但也在此列出,方便发现;
//   - 低频强力操作 —— **交换窗格 swapPane / 移动窗格 movePane** —— 只在这里出现,
//     不绑定任何热键(见 keymap.dart 的 paletteOnlyActions)。
//
// 本文件只管“选命令”这件事:呈现浮层、搜索过滤、回车执行回调。真正修改窗格树
// 的逻辑由每个命令的 onInvoke 回调承接(上层接线时提供),这里用 TODO 桩标注。

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../keymap/keymap.dart';

/// 命令面板里的一条命令。
///
/// 一条命令要么关联到一个 [PaneAction](便于自动显示热键标签),要么是纯自定义
/// 项。搜索会同时匹配 [title]、[subtitle] 与 [keywords]。
class PaletteCommand {
  const PaletteCommand({
    required this.id,
    required this.title,
    this.subtitle,
    this.keywords = const [],
    this.action,
    this.hotkeyLabel,
    this.onInvoke,
    this.icon,
  });

  /// 稳定标识(去重 / 埋点用)。
  final String id;

  /// 主标题(列表主文本)。
  final String title;

  /// 副标题 / 说明(列表次要文本)。
  final String? subtitle;

  /// 额外搜索关键字(中英混合、别名等),不显示但参与匹配。
  final List<String> keywords;

  /// 关联的窗格动作;为空表示纯自定义命令。
  final PaneAction? action;

  /// 覆盖显示的热键标签;为空时回退到 [action] 对应的标签。
  final String? hotkeyLabel;

  /// 执行回调。选中并回车 / 点击时调用。
  ///
  /// TODO(集成): 上层在构造命令时把它接到窗格控制器,例如
  ///   onInvoke: () => paneController.dispatch(action)。
  final VoidCallback? onInvoke;

  /// 可选前导图标。
  final IconData? icon;

  /// 计算该命令最终展示的热键标签(优先自定义,其次按 action 推导)。
  String? resolveHotkeyLabel(TargetPlatform platform) {
    if (hotkeyLabel != null) return hotkeyLabel;
    final a = action;
    if (a == null) return null;
    return Keymap.hotkeyLabelFor(a, platform);
  }

  /// 供搜索匹配的全部文本(小写)。
  String get _haystack =>
      [title, subtitle ?? '', ...keywords].join(' ').toLowerCase();
}

/// 命令面板默认命令集。
///
/// [dispatch] 是统一的动作分派器:每个内置命令的 onInvoke 都会调用
/// `dispatch(action)`。上层只需提供一个把 [PaneAction] 落到窗格树的实现。
/// 注意:swapPane / movePane 只在这里出现,没有对应热键。
List<PaletteCommand> defaultPaletteCommands({
  required void Function(PaneAction action) dispatch,
}) {
  PaletteCommand cmd(
    String id,
    String title,
    PaneAction action, {
    String? subtitle,
    List<String> keywords = const [],
    IconData? icon,
  }) =>
      PaletteCommand(
        id: id,
        title: title,
        subtitle: subtitle,
        keywords: keywords,
        action: action,
        icon: icon,
        onInvoke: () => dispatch(action),
      );

  return [
    // —— 拆分 ——
    cmd('split.right', '向右拆分窗格', PaneAction.splitRight,
        subtitle: '在右侧新建一个终端',
        keywords: ['split', 'right', 'pane', '拆分', '分屏'],
        icon: Icons.border_vertical),
    cmd('split.down', '向下拆分窗格', PaneAction.splitDown,
        subtitle: '在下方新建一个终端',
        keywords: ['split', 'down', 'pane', '拆分', '分屏'],
        icon: Icons.border_horizontal),

    // —— 交换 / 移动:命令面板专属,无热键 ——
    cmd('pane.swap', '交换窗格', PaneAction.swapPane,
        subtitle: '与另一个窗格互换位置(仅命令面板)',
        keywords: ['swap', 'exchange', 'pane', '交换', '互换'],
        icon: Icons.swap_horiz),
    cmd('pane.move', '移动窗格', PaneAction.movePane,
        subtitle: '把当前窗格摘下并挂到别处(仅命令面板)',
        keywords: ['move', 'detach', 'attach', 'pane', '移动', '搬移'],
        icon: Icons.open_with),

    // —— 切换焦点 ——
    cmd('focus.left', '焦点移到左侧窗格', PaneAction.focusLeft,
        keywords: ['focus', 'left', '焦点', '导航']),
    cmd('focus.right', '焦点移到右侧窗格', PaneAction.focusRight,
        keywords: ['focus', 'right', '焦点', '导航']),
    cmd('focus.up', '焦点移到上方窗格', PaneAction.focusUp,
        keywords: ['focus', 'up', '焦点', '导航']),
    cmd('focus.down', '焦点移到下方窗格', PaneAction.focusDown,
        keywords: ['focus', 'down', '焦点', '导航']),

    // —— 调整大小 ——
    cmd('resize.left', '缩放:向左', PaneAction.resizeLeft,
        keywords: ['resize', 'left', '调整大小']),
    cmd('resize.right', '缩放:向右', PaneAction.resizeRight,
        keywords: ['resize', 'right', '调整大小']),
    cmd('resize.up', '缩放:向上', PaneAction.resizeUp,
        keywords: ['resize', 'up', '调整大小']),
    cmd('resize.down', '缩放:向下', PaneAction.resizeDown,
        keywords: ['resize', 'down', '调整大小']),

    // —— 其它 ——
    cmd('pane.maximize', '最大化 / 还原窗格', PaneAction.toggleMaximizePane,
        subtitle: '临时铺满其它窗格(zoom)',
        keywords: ['maximize', 'zoom', 'restore', '最大化', '还原'],
        icon: Icons.fullscreen),
    cmd('pane.close', '关闭当前窗格', PaneAction.closePane,
        keywords: ['close', 'kill', '关闭'],
        icon: Icons.close),
  ];
}

/// 对命令做子串 + 子序列匹配打分,返回过滤 + 排序后的结果。
///
/// 空查询原样返回。评分越低越靠前:优先“标题前缀命中”、其次“任意子串命中”、
/// 最后“模糊子序列命中”。用于命令面板输入框实时过滤。
List<PaletteCommand> filterPaletteCommands(
  String query,
  List<PaletteCommand> commands,
) {
  final q = query.trim().toLowerCase();
  if (q.isEmpty) return List.of(commands);

  final scored = <(int, int, PaletteCommand)>[]; // (score, 原始下标, 命令)
  for (var i = 0; i < commands.length; i++) {
    final c = commands[i];
    final score = _scoreCommand(q, c);
    if (score != null) scored.add((score, i, c));
  }
  scored.sort((a, b) {
    final byScore = a.$1.compareTo(b.$1);
    return byScore != 0 ? byScore : a.$2.compareTo(b.$2); // 打平保持原顺序
  });
  return [for (final e in scored) e.$3];
}

/// 单条命令的匹配分;不匹配返回 null。分值越小优先级越高。
int? _scoreCommand(String q, PaletteCommand c) {
  final title = c.title.toLowerCase();
  if (title.startsWith(q)) return 0; // 标题前缀,最优
  final hay = c._haystack;
  final idx = hay.indexOf(q);
  if (idx >= 0) return 10 + idx; // 子串命中,越靠前越优
  if (_isSubsequence(q, hay)) return 1000; // 模糊子序列兜底
  return null;
}

/// 判断 [needle] 是否为 [haystack] 的子序列(按序、可不连续)。
bool _isSubsequence(String needle, String haystack) {
  var j = 0;
  for (var i = 0; i < haystack.length && j < needle.length; i++) {
    if (haystack.codeUnitAt(i) == needle.codeUnitAt(j)) j++;
  }
  return j == needle.length;
}

/// 弹出命令面板浮层,返回用户选中的命令(取消则为 null)。
///
/// 选中后本函数只负责关闭浮层并返回命令;是否调用 [PaletteCommand.onInvoke]
/// 交给调用方决定(默认由 [CommandPalette] 内部在选中时调用)。
Future<PaletteCommand?> showCommandPalette(
  BuildContext context, {
  required List<PaletteCommand> commands,
  String hintText = '输入命令…',
}) {
  return showGeneralDialog<PaletteCommand>(
    context: context,
    barrierDismissible: true,
    barrierLabel: '命令面板',
    barrierColor: Colors.black54,
    transitionDuration: const Duration(milliseconds: 120),
    pageBuilder: (ctx, _, __) {
      return CommandPalette(commands: commands, hintText: hintText);
    },
    transitionBuilder: (ctx, anim, _, child) {
      final curved =
          CurvedAnimation(parent: anim, curve: Curves.easeOutCubic);
      return FadeTransition(
        opacity: curved,
        child: SlideTransition(
          position: Tween<Offset>(
            begin: const Offset(0, -0.02),
            end: Offset.zero,
          ).animate(curved),
          child: child,
        ),
      );
    },
  );
}

/// 命令面板浮层组件。
///
/// 顶部一个搜索框,下面是实时过滤的命令列表。支持:
///   - 输入过滤(子串 + 模糊子序列);
///   - ↑/↓ 移动高亮、Enter 执行、Esc 关闭;
///   - 点击某项执行。
/// 执行时先调用命令的 [PaletteCommand.onInvoke],再以该命令 pop 关闭浮层。
class CommandPalette extends StatefulWidget {
  const CommandPalette({
    super.key,
    required this.commands,
    this.hintText = '输入命令…',
  });

  final List<PaletteCommand> commands;
  final String hintText;

  @override
  State<CommandPalette> createState() => _CommandPaletteState();
}

class _CommandPaletteState extends State<CommandPalette> {
  final TextEditingController _controller = TextEditingController();
  final FocusNode _searchFocus = FocusNode();
  final ScrollController _scrollController = ScrollController();

  late List<PaletteCommand> _filtered = List.of(widget.commands);
  int _highlighted = 0;

  @override
  void dispose() {
    _controller.dispose();
    _searchFocus.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  void _onQueryChanged(String value) {
    setState(() {
      _filtered = filterPaletteCommands(value, widget.commands);
      // 查询变化后把高亮重置到第一项,符合直觉。
      _highlighted = 0;
    });
  }

  void _moveHighlight(int delta) {
    if (_filtered.isEmpty) return;
    setState(() {
      _highlighted = (_highlighted + delta) % _filtered.length;
      if (_highlighted < 0) _highlighted += _filtered.length;
    });
  }

  void _invokeHighlighted() {
    if (_filtered.isEmpty) return;
    _invoke(_filtered[_highlighted]);
  }

  void _invoke(PaletteCommand command) {
    // 先执行动作回调,再关闭浮层并把命令回传给 showCommandPalette 调用方。
    command.onInvoke?.call();
    Navigator.of(context).pop(command);
  }

  KeyEventResult _handleKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    switch (event.logicalKey) {
      case LogicalKeyboardKey.arrowDown:
        _moveHighlight(1);
        return KeyEventResult.handled;
      case LogicalKeyboardKey.arrowUp:
        _moveHighlight(-1);
        return KeyEventResult.handled;
      case LogicalKeyboardKey.enter:
      case LogicalKeyboardKey.numpadEnter:
        _invokeHighlighted();
        return KeyEventResult.handled;
      case LogicalKeyboardKey.escape:
        Navigator.of(context).pop();
        return KeyEventResult.handled;
      default:
        return KeyEventResult.ignored;
    }
  }

  @override
  Widget build(BuildContext context) {
    final platform = Theme.of(context).platform;
    final scheme = Theme.of(context).colorScheme;

    return Align(
      alignment: const Alignment(0, -0.55),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24),
        child: Material(
          color: Colors.transparent,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 640, maxHeight: 460),
            child: Container(
              decoration: BoxDecoration(
                color: scheme.surface,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: scheme.outlineVariant),
                boxShadow: const [
                  BoxShadow(
                    color: Colors.black54,
                    blurRadius: 24,
                    offset: Offset(0, 8),
                  ),
                ],
              ),
              child: Focus(
                autofocus: true,
                onKeyEvent: _handleKey,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _buildSearchField(scheme),
                    const Divider(height: 1),
                    Flexible(child: _buildList(platform, scheme)),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildSearchField(ColorScheme scheme) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      child: TextField(
        controller: _controller,
        focusNode: _searchFocus,
        autofocus: true,
        onChanged: _onQueryChanged,
        onSubmitted: (_) => _invokeHighlighted(),
        style: const TextStyle(fontSize: 15),
        decoration: InputDecoration(
          prefixIcon: const Icon(Icons.search, size: 20),
          hintText: widget.hintText,
          border: InputBorder.none,
          isCollapsed: true,
          contentPadding: const EdgeInsets.symmetric(vertical: 8),
        ),
      ),
    );
  }

  Widget _buildList(TargetPlatform platform, ColorScheme scheme) {
    if (_filtered.isEmpty) {
      return const Padding(
        padding: EdgeInsets.all(24),
        child: Text('没有匹配的命令', style: TextStyle(color: Colors.grey)),
      );
    }
    return ListView.builder(
      controller: _scrollController,
      shrinkWrap: true,
      padding: const EdgeInsets.symmetric(vertical: 4),
      itemCount: _filtered.length,
      itemBuilder: (context, index) {
        final c = _filtered[index];
        final selected = index == _highlighted;
        final hotkey = c.resolveHotkeyLabel(platform);
        return _CommandTile(
          command: c,
          selected: selected,
          hotkeyLabel: hotkey,
          onTap: () => _invoke(c),
          onHover: () => setState(() => _highlighted = index),
        );
      },
    );
  }
}

/// 单条命令的列表项。
class _CommandTile extends StatelessWidget {
  const _CommandTile({
    required this.command,
    required this.selected,
    required this.hotkeyLabel,
    required this.onTap,
    required this.onHover,
  });

  final PaletteCommand command;
  final bool selected;
  final String? hotkeyLabel;
  final VoidCallback onTap;
  final VoidCallback onHover;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return MouseRegion(
      onEnter: (_) => onHover(),
      child: InkWell(
        onTap: onTap,
        child: Container(
          color: selected ? scheme.primary.withValues(alpha: 0.14) : null,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
          child: Row(
            children: [
              if (command.icon != null) ...[
                Icon(command.icon, size: 18, color: scheme.onSurfaceVariant),
                const SizedBox(width: 12),
              ],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      command.title,
                      style: const TextStyle(fontSize: 14),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    if (command.subtitle != null)
                      Text(
                        command.subtitle!,
                        style: TextStyle(
                          fontSize: 12,
                          color: scheme.onSurfaceVariant,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                  ],
                ),
              ),
              if (hotkeyLabel != null) ...[
                const SizedBox(width: 12),
                _HotkeyChip(label: hotkeyLabel!),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// 热键标签小胶囊(命令面板右侧)。
class _HotkeyChip extends StatelessWidget {
  const _HotkeyChip({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(5),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 11,
          color: scheme.onSurfaceVariant,
          fontFeatures: const [FontFeature.tabularFigures()],
        ),
      ),
    );
  }
}
