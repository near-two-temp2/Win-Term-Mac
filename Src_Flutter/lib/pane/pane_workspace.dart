// Win-Term-Mac / Src_Flutter 方案 ——【panes / 窗格工作区】角色。
//
// pane.dart 提供了一棵纯窗格二叉树(split/swap/move/navigate 等纯操作),
// pane_tree_view.dart 把树渲染成可见、可拖拽分隔条、可点击聚焦的视图,
// keymap.dart 把 WT 键位映射成 PaneActionIntent,command_palette.dart 负责命令面板。
//
// 但这些都是“零件”:谁来持有“当前是哪棵树、焦点在哪个叶子、是否 zoom”,
// 谁来把一次 Alt+Shift++ 变成 root = root.split(...) 并把焦点跟过去?
// —— 就是本文件。它是把二叉树“接到真实视图 + 真实键盘”的粘合层:
//
//   1) [PaneController]:唯一的可变状态源(ChangeNotifier)。持有 root 树、
//      focusedLeafId、是否最大化;对外只暴露语义化操作与一个统一的
//      [PaneController.dispatch](PaneAction) —— 键盘与命令面板都走它。
//      所有树变换都委托给 pane.dart 的纯操作,变换后回收无主会话并通知刷新。
//
//   2) [PaneWorkspace]:开箱即用的挂载点。内部用 Shortcuts + Actions 把
//      keymap.dart 的快捷键接到 controller.dispatch,用 PaneTreeView 渲染
//      controller 的当前树,并在 toggleCommandPalette 时弹出命令面板。
//      整合 agent 只需在 main.dart 里放一个 [PaneWorkspace] 即可。
//
// 设计原则:不重复造轮子。渲染复用 PaneTreeView;树操作复用 pane.dart;
// 键位表复用 Keymap;命令表复用 defaultPaletteCommands。本文件只写“状态机 + 接线”。
//
// -----------------------------------------------------------------------------
// integrator 需要如何调用我(入口文件 main.dart 由整合 agent 负责):
//
//   import 'package:win_term_mac/pane/pane_workspace.dart';
//   // ...
//   home: const Scaffold(body: PaneWorkspace()),   // 就这一行,内部自持状态
//
// 若想自己持有/驱动状态(例如从命令面板外部触发动作),可显式建 controller:
//
//   final controller = PaneController();            // initState 里建
//   PaneWorkspace(controller: controller);          // 传进去
//   controller.dispatch(PaneAction.splitRight);     // 外部也能驱动
//   // dispose 里:controller.dispose();
//
// 注意(键盘焦点):xterm 的 TerminalView 会吞掉大量按键。Alt 系列组合键一般能
// 冒泡到上层 Shortcuts,但若某平台上 Alt+方向被终端消费,integrator 可改用
// 全局快捷键或在 xterm 层放行这些组合键;本层的接线本身已就绪。

import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

import '../keymap/keymap.dart';
import '../palette/command_palette.dart';
import '../term/pane_tree_view.dart';
import 'pane.dart';

/// 焦点/最大化/树变换的唯一状态源。
///
/// 持有一棵 [Pane] 树与当前焦点叶子 id,并把 [PaneAction] 落成对 pane.dart
/// 纯操作的调用。是 [ChangeNotifier]:任何变更后 notifyListeners,
/// 由 [PaneWorkspace] 监听并重建视图。
class PaneController extends ChangeNotifier {
  PaneController({
    TerminalSessionRegistry? registry,
    Pane? initialRoot,
    double resizeStep = 0.04,
  })  : registry = registry ?? TerminalSessionRegistry(),
        _resizeStep = resizeStep {
    // 初始树:给定则用给定的,否则开一个单叶子(id 由注册表统一发号)。
    if (initialRoot != null) {
      _root = initialRoot;
      _focusedLeafId = initialRoot.leaves.first.id;
    } else {
      final firstId = this.registry.newLeafId();
      _root = PaneLeaf(firstId);
      _focusedLeafId = firstId;
    }
  }

  /// 会话注册表:叶子 id -> 真实终端会话。变换后据此回收无主会话。
  final TerminalSessionRegistry registry;

  /// 键盘 resize(Alt+Shift+方向)每次调整的比例步长。
  final double _resizeStep;

  late Pane _root;
  late String _focusedLeafId;
  bool _maximized = false;

  /// 当前完整窗格树(纯模型)。
  Pane get root => _root;

  /// 当前聚焦叶子 id。
  String get focusedLeafId => _focusedLeafId;

  /// 是否处于最大化(zoom)状态。
  bool get isMaximized => _maximized;

  /// 供视图渲染的“有效树”:最大化时只渲染焦点叶子(会话仍复用,不重启进程),
  /// 否则渲染完整树。
  Pane get displayRoot =>
      _maximized ? PaneLeaf(_focusedLeafId) : _root;

  // ---------------------------------------------------------------------------
  // 统一分派:键盘与命令面板都调用它。
  // ---------------------------------------------------------------------------

  /// 把一个 [PaneAction] 落成具体状态变更。命令面板开关不在此处理
  /// (它需要 BuildContext 弹浮层),由 [PaneWorkspace] 拦截。
  void dispatch(PaneAction action) {
    switch (action) {
      case PaneAction.splitRight:
        splitFocused(SplitAxis.horizontal);
      case PaneAction.splitDown:
        splitFocused(SplitAxis.vertical);
      case PaneAction.focusUp:
        moveFocus(PaneDirection.up);
      case PaneAction.focusDown:
        moveFocus(PaneDirection.down);
      case PaneAction.focusLeft:
        moveFocus(PaneDirection.left);
      case PaneAction.focusRight:
        moveFocus(PaneDirection.right);
      case PaneAction.resizeUp:
        resizeFocused(PaneDirection.up);
      case PaneAction.resizeDown:
        resizeFocused(PaneDirection.down);
      case PaneAction.resizeLeft:
        resizeFocused(PaneDirection.left);
      case PaneAction.resizeRight:
        resizeFocused(PaneDirection.right);
      case PaneAction.closePane:
        closeFocused();
      case PaneAction.toggleMaximizePane:
        toggleMaximize();
      case PaneAction.swapPane:
        swapFocusedWithNext();
      case PaneAction.movePane:
        moveFocusedToNext();
      case PaneAction.toggleCommandPalette:
        // 由 PaneWorkspace 处理(需要 context 弹浮层);此处忽略。
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // 切分(Alt+Shift+±)
  // ---------------------------------------------------------------------------

  /// 沿 [axis] 拆分当前焦点叶子,新叶子出现在右/下,并把焦点跟到新叶子。
  void splitFocused(SplitAxis axis) {
    final newId = registry.newLeafId();
    final next = _root.split(_focusedLeafId, PaneLeaf(newId), axis: axis);
    if (identical(next, _root)) return; // 焦点叶子不存在等异常情况,静默。
    _root = next;
    _focusedLeafId = newId; // WT 语义:焦点跟到新窗格。
    _maximized = false; // 拆分后退出 zoom,展示新布局。
    _afterStructureChange();
  }

  // ---------------------------------------------------------------------------
  // 切焦点(Alt+方向)
  // ---------------------------------------------------------------------------

  /// 按几何相邻关系把焦点移到 [direction] 方向的窗格(无相邻则不动)。
  void moveFocus(PaneDirection direction) {
    final target = _root.navigate(_focusedLeafId, direction);
    if (target == null || target == _focusedLeafId) return;
    focusLeaf(target);
  }

  /// 直接聚焦某个叶子(点击或程序化调用)。
  void focusLeaf(String leafId) {
    if (leafId == _focusedLeafId) return;
    if (!_root.containsLeaf(leafId)) return;
    _focusedLeafId = leafId;
    notifyListeners();
  }

  // ---------------------------------------------------------------------------
  // 调整比例:鼠标拖分隔条 + 键盘 resize(Alt+Shift+方向)
  // ---------------------------------------------------------------------------

  /// 鼠标拖动分隔条的回调:按 [path] 定位分裂节点,把其 first 侧比例设为 [ratio]。
  void setRatioAt(List<int> path, double ratio) {
    final next = PaneTreeView.updateRatioAt(_root, path, ratio);
    if (identical(next, _root)) return;
    _root = next;
    notifyListeners();
  }

  /// 键盘 resize:把焦点窗格朝 [direction] 一侧的相邻分隔条推一步。
  ///
  /// 规则:找到焦点叶子在该方向一侧的“最近分隔条”——即离焦点最深、轴向匹配、
  /// 且焦点位于其“朝向 direction 的那一侧”的祖先分裂,推动其比例即可让焦点变大。
  ///   - 右/下:焦点在该分裂的 first,推分隔条远离焦点 => ratio 增大;
  ///   - 左/上:焦点在该分裂的 second,推分隔条远离焦点 => ratio 减小。
  void resizeFocused(PaneDirection direction) {
    final path = _pathToLeaf(_root, _focusedLeafId);
    if (path == null) return;

    final bool wantHorizontal =
        direction == PaneDirection.left || direction == PaneDirection.right;
    final targetAxis =
        wantHorizontal ? SplitAxis.horizontal : SplitAxis.vertical;
    // 焦点应处于该分裂朝向 direction 的一侧:右/下 => first(0),左/上 => second(1)。
    final bool wantFirstChild =
        direction == PaneDirection.right || direction == PaneDirection.down;
    final int wantStep = wantFirstChild ? 0 : 1;
    final double sign = wantFirstChild ? 1.0 : -1.0;

    // 从叶子往根方向找“最深”的匹配祖先:遍历 path 的每个前缀分裂节点。
    List<int>? bestSplitPath;
    Pane node = _root;
    for (var i = 0; i < path.length; i++) {
      if (node is! PaneSplit) break;
      final step = path[i];
      if (node.axis == targetAxis && step == wantStep) {
        bestSplitPath = path.sublist(0, i); // 该分裂节点自身的路径。
      }
      node = step == 0 ? node.first : node.second;
    }
    if (bestSplitPath == null) return; // 该方向无可推的分隔条(已到边缘)。

    final split = _nodeAt(_root, bestSplitPath) as PaneSplit;
    final newRatio = (split.ratio + sign * _resizeStep).clamp(0.05, 0.95);
    setRatioAt(bestSplitPath, newRatio.toDouble());
  }

  // ---------------------------------------------------------------------------
  // 关闭 / 最大化
  // ---------------------------------------------------------------------------

  /// 关闭当前焦点窗格;其兄弟顶替位置,焦点落到相邻窗格。
  /// 若只剩最后一个窗格则保留(终端应至少有一个窗格),不做任何事。
  void closeFocused() {
    if (_root.leafCount <= 1) return;
    final detached = _root.detach(_focusedLeafId);
    if (detached == null || detached.tree == null) return;
    _root = detached.tree!;
    // 焦点落到剩余树的第一个叶子(简单可预期;后续可改成“空间上最近”)。
    _focusedLeafId = _root.leaves.first.id;
    _maximized = false;
    _afterStructureChange();
  }

  /// 切换最大化(zoom):把焦点窗格临时铺满,再次调用还原布局。
  void toggleMaximize() {
    if (_root.leafCount <= 1) return; // 单窗格无需 zoom。
    _maximized = !_maximized;
    notifyListeners();
  }

  // ---------------------------------------------------------------------------
  // 交换 / 移动(命令面板专属,无热键)
  // ---------------------------------------------------------------------------
  //
  // WT 的 swapPane / movePane 需要用户挑一个目标窗格。当前没有目标选择 UI,
  // 这里退而取“阅读顺序里的下一个窗格”作为目标,行为真实可用而非空桩。
  // TODO(集成): 接入目标选择器(高亮候选 + 方向键选定)后,把 _nextLeafId
  //              换成用户选中的目标 id 即可。

  /// 把焦点窗格与阅读顺序中的下一个窗格互换内容。
  void swapFocusedWithNext() {
    final other = _nextLeafId(_focusedLeafId);
    if (other == null) return;
    final next = _root.swap(_focusedLeafId, other);
    if (identical(next, _root)) return;
    _root = next;
    // swap 只换内容不改结构,焦点 id 语义上跟随“内容”移动到 other 位置。
    _focusedLeafId = other;
    notifyListeners();
  }

  /// 把焦点窗格摘下,挂到阅读顺序中的下一个窗格处(向右分裂)。
  void moveFocusedToNext() {
    final other = _nextLeafId(_focusedLeafId);
    if (other == null) return;
    final next = _root.move(_focusedLeafId, other, axis: SplitAxis.horizontal);
    if (identical(next, _root)) return;
    _root = next;
    _maximized = false;
    _afterStructureChange();
  }

  // ---------------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------------

  /// 结构性变更(增删/移动叶子)后:回收无主会话 + 通知刷新。
  void _afterStructureChange() {
    registry.retainOnly(_root.leaves.map((l) => l.id));
    // 兜底:确保焦点仍指向存在的叶子。
    if (!_root.containsLeaf(_focusedLeafId)) {
      _focusedLeafId = _root.leaves.first.id;
    }
    notifyListeners();
  }

  /// 阅读顺序(前序)中位于 [id] 之后的叶子 id;到末尾则回绕到第一个。
  /// 只有一个叶子时返回 null。
  String? _nextLeafId(String id) {
    final ids = _root.leaves.map((l) => l.id).toList();
    if (ids.length < 2) return null;
    final i = ids.indexOf(id);
    if (i < 0) return null;
    return ids[(i + 1) % ids.length];
  }

  /// 从 [root] 到目标叶子的路径(每步 0=first / 1=second);找不到返回 null。
  static List<int>? _pathToLeaf(Pane root, String id) {
    final path = <int>[];
    bool dfs(Pane node) {
      switch (node) {
        case PaneLeaf leaf:
          return leaf.id == id;
        case PaneSplit split:
          path.add(0);
          if (dfs(split.first)) return true;
          path.removeLast();
          path.add(1);
          if (dfs(split.second)) return true;
          path.removeLast();
          return false;
      }
    }

    return dfs(root) ? path : null;
  }

  /// 按 [path] 取节点;越界返回 null。
  static Pane? _nodeAt(Pane root, List<int> path) {
    Pane node = root;
    for (final step in path) {
      if (node is! PaneSplit) return null;
      node = step == 0 ? node.first : node.second;
    }
    return node;
  }

  @override
  void dispose() {
    registry.disposeAll();
    super.dispose();
  }
}

/// 开箱即用的窗格工作区:把 [PaneController] + 键位 + 命令面板 + 树视图接成整体。
///
/// integrator 直接把它放进 Scaffold.body 即可获得:切分/拖拽调比例/方向键切焦点/
/// 命令面板(交换、移动、最大化、关闭)全部可用的多窗格终端。
class PaneWorkspace extends StatefulWidget {
  const PaneWorkspace({
    super.key,
    this.controller,
    this.terminalTheme,
  });

  /// 外部提供的控制器;为空则本组件自建并自管其生命周期。
  final PaneController? controller;

  /// 终端配色主题(透传给 PaneTreeView / xterm)。
  final TerminalTheme? terminalTheme;

  @override
  State<PaneWorkspace> createState() => _PaneWorkspaceState();
}

class _PaneWorkspaceState extends State<PaneWorkspace> {
  late final PaneController _controller;
  bool _ownsController = false;
  bool _paletteOpen = false; // 防止重复弹出命令面板。

  @override
  void initState() {
    super.initState();
    final provided = widget.controller;
    if (provided != null) {
      _controller = provided;
    } else {
      _controller = PaneController();
      _ownsController = true;
    }
  }

  @override
  void dispose() {
    if (_ownsController) _controller.dispose();
    super.dispose();
  }

  /// 键位分派:命令面板需要 context,单独拦下;其余交给 controller.dispatch。
  void _onAction(PaneAction action) {
    if (action == PaneAction.toggleCommandPalette) {
      _openCommandPalette();
      return;
    }
    _controller.dispatch(action);
  }

  Future<void> _openCommandPalette() async {
    if (_paletteOpen) return;
    _paletteOpen = true;
    try {
      await showCommandPalette(
        context,
        commands: defaultPaletteCommands(dispatch: _controller.dispatch),
      );
    } finally {
      _paletteOpen = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final platform = Theme.of(context).platform;

    // 键位 -> 意图(Keymap 复用);意图 -> 回调(落到 _onAction)。
    return Shortcuts(
      shortcuts: Keymap.buildShortcuts(platform: platform),
      child: Actions(
        actions: <Type, Action<Intent>>{
          PaneActionIntent: CallbackAction<PaneActionIntent>(
            onInvoke: (intent) {
              _onAction(intent.action);
              return null;
            },
          ),
        },
        child: Focus(
          autofocus: true,
          // 焦点放在最外层,保证 Shortcuts 能收到未被终端消费的组合键。
          child: AnimatedBuilder(
            animation: _controller,
            builder: (context, _) {
              return PaneTreeView(
                root: _controller.displayRoot,
                registry: _controller.registry,
                focusedLeafId: _controller.focusedLeafId,
                onFocusLeaf: _controller.focusLeaf,
                onRatioChanged: _controller.setRatioAt,
                terminalTheme: widget.terminalTheme,
              );
            },
          ),
        ),
      ),
    );
  }
}
