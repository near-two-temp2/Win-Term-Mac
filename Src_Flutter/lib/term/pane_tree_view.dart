// Win-Term-Mac / Src_Flutter 方案 ——【term / 渲染】角色(窗格树视图)。
//
// terminal_session.dart 解决了“单个真终端”的显示与接线;pane.dart 提供了一棵
// 纯窗格二叉树(叶子只有 id)。本文件把两者缝合成 **可见、可操作** 的整体:
//
//   1) [TerminalSessionRegistry]:leaf.id -> [TerminalSession] 的注册表。
//      窗格树只认 id;这里按 id 惰性创建/持有真实终端会话,并负责回收进程。
//   2) [PaneTreeView]:递归把一棵 [Pane] 渲染成嵌套的 Row/Column,
//      叶子处放真实的 xterm [TerminalView](子进程输出直接可见、可敲命令),
//      分裂处放一条可拖拽的分隔条(拖动 = 调整该分裂的比例)。
//      叶子可点击聚焦,聚焦叶子有高亮边框;支持外部按 id 程序化聚焦
//      (给 Alt+方向键导航用)。
//
// 设计原则:
//   - 复用现成接口,不另造:会话用 TerminalSession,树用 pane.dart 的 Pane。
//   - 视图不改窗格树:拆分/交换/移动由上层调用 pane.dart 的纯操作重建新树,
//     再把新树喂回本视图;本视图只负责“把当前树画出来 + 汇报交互意图”。
//   - 分裂节点在纯模型里没有 id,故本视图用“路径 path(0=first,1=second)”
//     定位被拖拽的分裂,并通过 [onRatioChanged] 上报;配套静态方法
//     [PaneTreeView.updateRatioAt] 可据路径重算新树(键盘 resize 也能复用)。
//
// -----------------------------------------------------------------------------
// integrator 需要如何调用我(接线指引,入口文件 main.dart 由整合 agent 负责):
//
//   final registry = TerminalSessionRegistry();   // 全局持有一次
//   Pane root = const PaneLeaf('t1');              // 初始一个叶子
//   String focused = 't1';
//
//   // 在 build 里(通常配合 StatefulWidget + setState):
//   PaneTreeView(
//     root: root,
//     registry: registry,
//     focusedLeafId: focused,
//     onFocusLeaf: (id) => setState(() => focused = id),
//     onRatioChanged: (path, ratio) => setState(() {
//       root = PaneTreeView.updateRatioAt(root, path, ratio);
//     }),
//   );
//
//   // 处理 keymap.dart 的 PaneAction 时(拆分举例):
//   final newId = registry.newLeafId();
//   root = root.split(focused, PaneLeaf(newId), axis: SplitAxis.horizontal);
//   focused = newId;                 // 焦点跟到新窗格
//   // 关闭/移动导致叶子消失后,回收无主会话:
//   registry.retainOnly(root.leaves.map((l) => l.id));
//
// dispose:App 退出时 registry.disposeAll()(杀掉所有子进程)。

import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

import '../pane/pane.dart';
import 'terminal_session.dart';

/// leaf.id -> [TerminalSession] 的注册表:按 id 惰性创建并持有真实终端会话。
///
/// 窗格二叉树里的叶子只携带稳定 id,真正的 shell 进程/仿真器由本表托管。
/// 拆分/交换/移动只是重排 id,会话对象保持不变(进程不重启、回滚缓冲不丢);
/// 只有当某个叶子被真正删除时,才由 [disposeLeaf] / [retainOnly] 回收其进程。
class TerminalSessionRegistry {
  TerminalSessionRegistry({TerminalSession Function()? sessionFactory})
      : _sessionFactory = sessionFactory ?? TerminalSession.start;

  final TerminalSession Function() _sessionFactory;
  final Map<String, TerminalSession> _sessions = <String, TerminalSession>{};
  int _idCounter = 0;

  /// 生成一个全局唯一的新叶子 id(供上层拆分时使用)。
  String newLeafId() => 't${++_idCounter}';

  /// 取得某叶子的会话;不存在则用工厂惰性创建(此刻才真正 fork 出 shell)。
  TerminalSession sessionFor(String leafId) {
    final existing = _sessions[leafId];
    if (existing != null && !existing.isDisposed) return existing;
    final created = _sessionFactory();
    _sessions[leafId] = created;
    return created;
  }

  /// 是否已为该叶子创建过(仍存活的)会话。
  bool has(String leafId) {
    final s = _sessions[leafId];
    return s != null && !s.isDisposed;
  }

  /// 释放并移除某叶子的会话(杀掉其子进程)。叶子被关闭时调用。
  void disposeLeaf(String leafId) {
    _sessions.remove(leafId)?.dispose();
  }

  /// 只保留 [liveIds] 里仍存在的叶子,其余会话一律释放。
  ///
  /// 上层每次改动窗格树(关闭/移动导致叶子消失)后调用即可,
  /// 免去逐个追踪“哪个叶子没了”。
  void retainOnly(Iterable<String> liveIds) {
    final keep = liveIds.toSet();
    final dead = _sessions.keys.where((id) => !keep.contains(id)).toList();
    for (final id in dead) {
      _sessions.remove(id)?.dispose();
    }
  }

  /// 释放全部会话(App 退出时调用)。
  void disposeAll() {
    for (final s in _sessions.values) {
      s.dispose();
    }
    _sessions.clear();
  }
}

/// 把一棵 [Pane] 渲染成嵌套的可调整大小的窗格,叶子处显示真实终端。
class PaneTreeView extends StatefulWidget {
  const PaneTreeView({
    super.key,
    required this.root,
    required this.registry,
    this.focusedLeafId,
    this.onFocusLeaf,
    this.onRatioChanged,
    this.dividerThickness = 6.0,
    this.terminalTheme,
  });

  /// 当前要渲染的窗格树(纯模型,来自 pane.dart)。
  final Pane root;

  /// 会话注册表:按叶子 id 提供真实终端。
  final TerminalSessionRegistry registry;

  /// 当前聚焦的叶子 id(用于高亮 + 程序化聚焦其终端)。
  final String? focusedLeafId;

  /// 用户点击某叶子时回调(上层据此更新 focusedLeafId)。
  final ValueChanged<String>? onFocusLeaf;

  /// 拖动某分裂分隔条时回调:[path] 定位分裂节点(0=first,1=second),
  /// [ratio] 为该分裂 first 侧的新比例(已夹取)。上层用
  /// [PaneTreeView.updateRatioAt] 重建新树。
  final void Function(List<int> path, double ratio)? onRatioChanged;

  /// 分隔条厚度(像素)。
  final double dividerThickness;

  /// 终端配色主题(透传给 xterm)。
  final TerminalTheme? terminalTheme;

  @override
  State<PaneTreeView> createState() => _PaneTreeViewState();

  /// 按 [path] 定位分裂节点,返回把其 ratio 改为 [ratio] 后的新树。
  ///
  /// 纯函数,不改原树。路径越界/指向叶子时原样返回(容错)。
  /// 键盘 resize(Alt+Shift+方向)也可复用本方法。
  static Pane updateRatioAt(Pane root, List<int> path, double ratio) {
    if (path.isEmpty) {
      if (root is PaneSplit) return root.withRatio(ratio);
      return root;
    }
    if (root is! PaneSplit) return root;
    final step = path.first;
    final rest = path.sublist(1);
    if (step == 0) {
      return root.copyWith(first: updateRatioAt(root.first, rest, ratio));
    } else if (step == 1) {
      return root.copyWith(second: updateRatioAt(root.second, rest, ratio));
    }
    return root;
  }
}

class _PaneTreeViewState extends State<PaneTreeView> {
  /// 每个叶子 id 一个 FocusNode,跨重建保持,便于程序化聚焦其终端。
  final Map<String, FocusNode> _focusNodes = <String, FocusNode>{};

  FocusNode _focusNodeFor(String leafId) => _focusNodes.putIfAbsent(
        leafId,
        () => FocusNode(debugLabel: 'term:$leafId'),
      );

  @override
  void initState() {
    super.initState();
    _scheduleFocusSync();
  }

  @override
  void didUpdateWidget(covariant PaneTreeView oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 焦点叶子变化(如 Alt+方向键导航)时,把键盘焦点搬到对应终端。
    if (oldWidget.focusedLeafId != widget.focusedLeafId) {
      _scheduleFocusSync();
    }
    // 清理已从树中消失的叶子对应的 FocusNode。
    final live = widget.root.leaves.map((l) => l.id).toSet();
    final gone = _focusNodes.keys.where((id) => !live.contains(id)).toList();
    for (final id in gone) {
      _focusNodes.remove(id)?.dispose();
    }
  }

  void _scheduleFocusSync() {
    final id = widget.focusedLeafId;
    if (id == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final node = _focusNodes[id];
      if (node != null && !node.hasFocus) node.requestFocus();
    });
  }

  @override
  void dispose() {
    for (final node in _focusNodes.values) {
      node.dispose();
    }
    _focusNodes.clear();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return _buildNode(widget.root, const <int>[]);
  }

  /// 递归渲染:叶子 -> 终端;分裂 -> Row/Column + 可拖拽分隔条。
  Widget _buildNode(Pane node, List<int> path) {
    switch (node) {
      case PaneLeaf leaf:
        return _buildLeaf(leaf);
      case PaneSplit split:
        return _buildSplit(split, path);
    }
  }

  Widget _buildLeaf(PaneLeaf leaf) {
    final session = widget.registry.sessionFor(leaf.id);
    final focused = leaf.id == widget.focusedLeafId;
    final scheme = Theme.of(context).colorScheme;

    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapDown: (_) => widget.onFocusLeaf?.call(leaf.id),
      child: Container(
        decoration: BoxDecoration(
          border: Border.all(
            // 聚焦叶子用主题主色边框,其余用低调分隔色。
            color: focused ? scheme.primary : scheme.outlineVariant,
            width: focused ? 1.5 : 1.0,
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.all(4),
          child: TerminalView(
            session.terminal,
            focusNode: _focusNodeFor(leaf.id),
            // 只有当前聚焦叶子自动抢焦点,避免多个终端争抢。
            autofocus: focused,
            theme: widget.terminalTheme ?? TerminalThemes.defaultTheme,
          ),
        ),
      ),
    );
  }

  Widget _buildSplit(PaneSplit split, List<int> path) {
    final horizontal = split.axis == SplitAxis.horizontal;
    final thickness = widget.dividerThickness;

    return LayoutBuilder(
      builder: (context, constraints) {
        final total = horizontal ? constraints.maxWidth : constraints.maxHeight;
        // 扣掉分隔条厚度后,两侧按比例分配可用长度。
        final double avail =
            (total - thickness).clamp(0.0, double.infinity).toDouble();
        final double firstExtent = avail * split.ratio;
        final double secondExtent = avail - firstExtent;

        final firstChild = _sizedBranch(
          _buildNode(split.first, [...path, 0]),
          horizontal,
          firstExtent,
        );
        final secondChild = _sizedBranch(
          _buildNode(split.second, [...path, 1]),
          horizontal,
          secondExtent,
        );
        final divider = _SplitDivider(
          horizontal: horizontal,
          thickness: thickness,
          onDragExtent: (delta) {
            if (avail <= 0) return;
            final newFirst = (firstExtent + delta).clamp(0.0, avail);
            widget.onRatioChanged?.call(path, newFirst / avail);
          },
        );

        final children = <Widget>[firstChild, divider, secondChild];
        return horizontal
            ? Row(children: children)
            : Column(children: children);
      },
    );
  }

  /// 给分支套一个固定主轴长度(横=宽,竖=高)的盒子。
  Widget _sizedBranch(Widget child, bool horizontal, double extent) {
    return SizedBox(
      width: horizontal ? extent : null,
      height: horizontal ? null : extent,
      child: child,
    );
  }
}

/// 可拖拽的分裂分隔条:横向分裂 -> 竖直分隔条(左右拖);竖向分裂 -> 水平分隔条。
class _SplitDivider extends StatelessWidget {
  const _SplitDivider({
    required this.horizontal,
    required this.thickness,
    required this.onDragExtent,
  });

  /// 所属分裂是否为水平(左右并排)方向。
  final bool horizontal;
  final double thickness;

  /// 拖动回调:参数为沿主轴方向的位移增量(像素,右/下为正)。
  final ValueChanged<double> onDragExtent;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final cursor = horizontal
        ? SystemMouseCursors.resizeLeftRight
        : SystemMouseCursors.resizeUpDown;

    return MouseRegion(
      cursor: cursor,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onHorizontalDragUpdate:
            horizontal ? (d) => onDragExtent(d.delta.dx) : null,
        onVerticalDragUpdate:
            horizontal ? null : (d) => onDragExtent(d.delta.dy),
        child: SizedBox(
          width: horizontal ? thickness : null,
          height: horizontal ? null : thickness,
          child: Center(
            child: Container(
              // 分隔条中间画一条细线,给出可拖拽的视觉暗示。
              width: horizontal ? 1 : double.infinity,
              height: horizontal ? double.infinity : 1,
              color: scheme.outlineVariant,
            ),
          ),
        ),
      ),
    );
  }
}
