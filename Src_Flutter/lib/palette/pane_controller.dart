// Win-Term-Mac / Src_Flutter 方案 ——【Palette / 装配】角色(窗格控制器)。
//
// pane.dart 提供了一棵“纯”窗格二叉树(只做不可变变换,不持有焦点/会话)。
// 本文件把那棵纯树包成一个 **有状态、可监听** 的控制器 [PaneController]:
//   - 持有「当前树 root + 当前焦点叶子 focusedLeafId + 最大化叶子 maximizedLeafId」;
//   - 把 keymap.dart 里的 [PaneAction] 意图落地成对树的真实变换
//     (split / swap / move / navigate 焦点 / resize 比例 / close / zoom);
//   - 用 [TerminalSessionRegistry] 惰性新建叶子会话、回收无主会话(关闭/移动后)。
//
// 复用原则(不另造轮子):
//   - 所有结构变换都直接调用 pane.dart 的纯操作(split/swap/move/detach/navigate);
//   - 分裂比例的按路径更新复用 term/pane_tree_view.dart 的
//     [PaneTreeView.updateRatioAt](拖拽分隔条与键盘 resize 共用同一条通路)。
//
// 本控制器 **不碰 UI**:命令面板浮层、快捷键 Shortcuts/Actions 的装配在
// palette/pane_workspace.dart。二者通过本控制器的公开方法交互。
//
// swap / move 需要“第二个目标窗格”,控制器只暴露 [swap] / [move] 两个纯方法;
// “先选目标再执行”的两段式交互由 pane_workspace.dart 用命令面板驱动。

import 'package:flutter/foundation.dart';

import '../pane/pane.dart';
import '../term/pane_tree_view.dart';

/// 窗格工作区的可监听状态机。
///
/// 监听者(通常是 pane_workspace.dart 里的 `ListenableBuilder`)在
/// [notifyListeners] 后重建视图。所有会改变树/焦点的方法都会在改动后通知。
class PaneController extends ChangeNotifier {
  PaneController({
    required this.registry,
    Pane? initialRoot,
    String? initialFocusId,
    this.resizeStep = 0.04,
  }) {
    _root = initialRoot ?? PaneLeaf(registry.newLeafId());
    // 初始焦点:显式指定且存在则用之,否则取第一个叶子。
    final wanted = initialFocusId;
    _focusedLeafId = (wanted != null && _root.containsLeaf(wanted))
        ? wanted
        : _root.leaves.first.id;
  }

  /// 会话注册表:按叶子 id 惰性建 shell、回收无主会话。
  final TerminalSessionRegistry registry;

  /// 每次键盘 resize 调整的比例步长(相对所在分裂,0~1)。
  final double resizeStep;

  late Pane _root;
  late String _focusedLeafId;
  String? _maximizedLeafId;

  /// 当前窗格树(纯模型)。
  Pane get root => _root;

  /// 当前聚焦叶子 id。
  String get focusedLeafId => _focusedLeafId;

  /// 当前被最大化(zoom)的叶子 id;为空表示正常平铺。
  String? get maximizedLeafId => _maximizedLeafId;

  /// 是否处于最大化状态。
  bool get isMaximized => _maximizedLeafId != null;

  // ---------------------------------------------------------------------------
  // 焦点
  // ---------------------------------------------------------------------------

  /// 直接把焦点设到某叶子(点击窗格 / 程序化聚焦)。
  void focusLeaf(String id) {
    if (_focusedLeafId == id) return;
    if (!_root.containsLeaf(id)) return;
    _focusedLeafId = id;
    notifyListeners();
  }

  /// 按几何相邻关系移动焦点(Alt+方向键)。命中相邻窗格返回 true。
  bool moveFocus(PaneDirection direction) {
    final next = _root.navigate(_focusedLeafId, direction);
    if (next == null || next == _focusedLeafId) return false;
    _focusedLeafId = next;
    notifyListeners();
    return true;
  }

  // ---------------------------------------------------------------------------
  // 拆分
  // ---------------------------------------------------------------------------

  /// 沿 [axis] 拆分当前焦点窗格,新窗格出现在右/下(second),焦点跟到新窗格。
  ///
  /// 返回新叶子 id。会退出最大化(拆分在 zoom 态下无意义)。
  String splitFocused(SplitAxis axis, {double ratio = 0.5}) {
    final newId = registry.newLeafId();
    _root = _root.split(_focusedLeafId, PaneLeaf(newId), axis: axis, ratio: ratio);
    _focusedLeafId = newId;
    _maximizedLeafId = null;
    notifyListeners();
    return newId;
  }

  // ---------------------------------------------------------------------------
  // 交换 / 移动(需要第二个目标窗格;由上层的目标选择器提供 otherId)
  // ---------------------------------------------------------------------------

  /// 把焦点窗格与 [otherId] 窗格交换位置(内容随之互换)。焦点留在原位置的 id 上。
  ///
  /// 注意:swap 只换叶子承载的 id(即换终端会话),两个格子的几何位置不变;
  /// 交换后让焦点跟随“原焦点会话”到它的新位置,更符合直觉。
  void swap(String otherId) {
    if (otherId == _focusedLeafId) return;
    if (!_root.containsLeaf(otherId)) return;
    _root = _root.swap(_focusedLeafId, otherId);
    // swap 后焦点会话 id 不变,但它现在坐在原来 otherId 的格子里;
    // 焦点仍指向同一个会话 id,视图会把高亮画到它的新位置上。
    notifyListeners();
  }

  /// 把焦点窗格摘下,挂到 [targetId] 窗格处并沿 [axis] 重新分裂。焦点跟随移动。
  void move(String targetId, SplitAxis axis, {double ratio = 0.5}) {
    if (targetId == _focusedLeafId) return;
    if (!_root.containsLeaf(targetId)) return;
    final moving = _focusedLeafId;
    final next = _root.move(moving, targetId, axis: axis, ratio: ratio);
    if (identical(next, _root)) return; // move 未生效(如唯一叶子)
    _root = next;
    // 焦点会话 id 没变,仍指向被移动的那个;它现在坐在目标旁边。
    _maximizedLeafId = null;
    notifyListeners();
  }

  // ---------------------------------------------------------------------------
  // 调整大小(键盘 Alt+Shift+方向)
  // ---------------------------------------------------------------------------

  /// 沿 [direction] 推动“离焦点最近的、方向匹配的分裂分隔条”。
  ///
  /// 语义(与命令面板文案一致):把相邻分隔线朝该方向推 [resizeStep]。
  ///   - 左右:找最近的水平分裂(竖直分隔条),right → 分隔条右移(first 变大),
  ///     left → 左移;
  ///   - 上下:找最近的竖直分裂(水平分隔条),down → 下移(first 变大),up → 上移。
  /// 找不到匹配朝向的祖先分裂时什么都不做(如整棵树只有一个叶子)。
  void resizeFocused(PaneDirection direction) {
    final path = _pathToLeaf(_root, _focusedLeafId);
    if (path == null || path.isEmpty) return;

    final wantHorizontal =
        direction == PaneDirection.left || direction == PaneDirection.right;
    // 分隔条右/下移 = first 侧比例增大。
    final positive =
        direction == PaneDirection.right || direction == PaneDirection.down;

    // 从最深的祖先分裂往根方向找第一个朝向匹配者。
    for (var depth = path.length - 1; depth >= 0; depth--) {
      final prefix = path.sublist(0, depth); // 指向某个分裂节点的路径
      final node = _nodeAt(_root, prefix);
      if (node is! PaneSplit) continue;
      final isHorizontal = node.axis == SplitAxis.horizontal;
      if (isHorizontal != wantHorizontal) continue;

      final newRatio =
          (node.ratio + (positive ? resizeStep : -resizeStep)).clamp(0.05, 0.95);
      _root = PaneTreeView.updateRatioAt(_root, prefix, newRatio.toDouble());
      notifyListeners();
      return;
    }
  }

  /// 按路径设置某分裂的比例(供拖拽分隔条 [PaneTreeView.onRatioChanged] 回调)。
  void setRatioAt(List<int> path, double ratio) {
    _root = PaneTreeView.updateRatioAt(_root, path, ratio);
    notifyListeners();
  }

  // ---------------------------------------------------------------------------
  // 关闭 / 最大化
  // ---------------------------------------------------------------------------

  /// 关闭焦点窗格:摘掉它、父分裂坍缩、焦点转移到相邻窗格,并回收其 shell 进程。
  ///
  /// 若它是最后一个窗格则忽略(不允许关到空)。
  void closeFocused() {
    final closing = _focusedLeafId;
    final res = _root.detach(closing);
    if (res == null || res.tree == null) return; // 唯一叶子,拒绝关闭

    // 摘除前先在旧树里挑一个几何相邻窗格作为新焦点。
    String? next;
    for (final d in PaneDirection.values) {
      final n = _root.navigate(closing, d);
      if (n != null && n != closing) {
        next = n;
        break;
      }
    }

    _root = res.tree!;
    _focusedLeafId = (next != null && _root.containsLeaf(next))
        ? next
        : _root.leaves.first.id;
    if (_maximizedLeafId == closing) _maximizedLeafId = null;

    registry.disposeLeaf(closing); // 杀掉被关闭窗格的子进程
    notifyListeners();
  }

  /// 最大化 / 还原焦点窗格(zoom):在“只显示焦点窗格”与“正常平铺”间切换。
  void toggleMaximize() {
    _maximizedLeafId =
        _maximizedLeafId == _focusedLeafId ? null : _focusedLeafId;
    notifyListeners();
  }

  // ---------------------------------------------------------------------------
  // 内部工具
  // ---------------------------------------------------------------------------

  /// 求某叶子在树中的路径(0=first,1=second);找不到返回 null。
  static List<int>? _pathToLeaf(Pane node, String id) {
    switch (node) {
      case PaneLeaf leaf:
        return leaf.id == id ? <int>[] : null;
      case PaneSplit split:
        final f = _pathToLeaf(split.first, id);
        if (f != null) return <int>[0, ...f];
        final s = _pathToLeaf(split.second, id);
        if (s != null) return <int>[1, ...s];
        return null;
    }
  }

  /// 沿路径取节点(越界/中途遇叶子则返回当前所至节点)。
  static Pane _nodeAt(Pane node, List<int> path) {
    var cur = node;
    for (final step in path) {
      if (cur is! PaneSplit) return cur;
      cur = step == 0 ? cur.first : cur.second;
    }
    return cur;
  }
}
