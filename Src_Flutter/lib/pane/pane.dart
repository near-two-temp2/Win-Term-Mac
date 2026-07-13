// Win-Term-Mac / Src_Flutter 方案 ——【PaneCore】角色。
//
// 本文件是窗格模型的“纯核心”:用密封类(sealed class)把窗格表示成一棵
// 二叉树,并提供 split / swap / move / navigate / walk 等 **纯** 操作。
//
// 纯核心的含义:
//   - 不依赖 Flutter、xterm.dart、flutter_pty 等任何 UI / IO;
//   - 所有变换操作都返回“新树”,不原地修改(便于撤销、diff、测试);
//   - 叶子只持有一个稳定的 `id`(以及可选标题),真正的终端会话/渲染
//     由其它角色按 `id` 关联,这里完全不碰。
//
// 与 Windows Terminal 的对应关系:
//   - 叶子(PaneLeaf) = 一个真终端;
//   - 分裂节点(PaneSplit) = 方向(横/竖) + 比例(0~1) + first/second 两个子节点;
//   - split:把某个叶子换成一个分裂节点;
//   - swap:交换两个叶子的位置(内容随之互换);
//   - move:摘下一个叶子再挂到别处(拖拽移动的基础);
//   - navigate:按几何相邻关系找焦点(Alt/Cmd+方向键);
//   - walk:遍历整棵树。

import 'dart:math' as math;

/// 分裂方向。
///
/// 命名遵循 Flutter 的 Row/Column 直觉:
///   - [horizontal]:子节点沿水平方向排开 —— first = 左,second = 右
///     (对应 WT 的 splitRight,分隔线是竖直的);
///   - [vertical]:子节点沿竖直方向堆叠 —— first = 上,second = 下
///     (对应 WT 的 splitDown,分隔线是水平的)。
enum SplitAxis {
  /// 左右并排(first=左 / second=右)。
  horizontal,

  /// 上下堆叠(first=上 / second=下)。
  vertical,
}

/// 几何导航方向(方向键切焦点用)。
enum PaneDirection { up, down, left, right }

/// 轴对齐矩形,取值域为单位方格 [0,1]×[0,1]。
///
/// 只用于几何计算(navigate / 布局预览),不含像素单位。
class Rect {
  const Rect(this.left, this.top, this.width, this.height);

  final double left;
  final double top;
  final double width;
  final double height;

  double get right => left + width;
  double get bottom => top + height;
  double get centerX => left + width / 2;
  double get centerY => top + height / 2;

  @override
  String toString() =>
      'Rect(l:$left, t:$top, w:$width, h:$height)';
}

/// 摘除操作的结果:摘除后的新树 + 被摘下来的叶子。
///
/// 当整棵树只有一个叶子、无法摘除时,[tree] 为 null。
class DetachResult {
  const DetachResult(this.tree, this.detached);

  /// 摘除该叶子后剩下的树;若被摘的是唯一叶子则为 null。
  final Pane? tree;

  /// 被摘下来的叶子。
  final PaneLeaf detached;
}

/// 窗格二叉树节点(密封基类)。
///
/// 只有两种实现:[PaneLeaf](叶子)与 [PaneSplit](分裂)。
/// 所有变换方法都是纯函数,返回新的树,不修改 `this`。
sealed class Pane {
  const Pane();

  // ---------------------------------------------------------------------------
  // 查询
  // ---------------------------------------------------------------------------

  /// 深度优先(前序)遍历所有叶子。
  Iterable<PaneLeaf> get leaves sync* {
    switch (this) {
      case PaneLeaf leaf:
        yield leaf;
      case PaneSplit split:
        yield* split.first.leaves;
        yield* split.second.leaves;
    }
  }

  /// 叶子数量。
  int get leafCount => leaves.length;

  /// 按 id 查找叶子;找不到返回 null。
  PaneLeaf? findLeaf(String id) {
    for (final leaf in leaves) {
      if (leaf.id == id) return leaf;
    }
    return null;
  }

  /// 是否包含指定 id 的叶子。
  bool containsLeaf(String id) => findLeaf(id) != null;

  /// 遍历整棵树(前序:先访问当前节点,再访问子节点)。
  ///
  /// 与 WT 的 walk 语义一致:用于收集/统计/渲染整棵树。
  void walk(void Function(Pane node) visit) {
    visit(this);
    if (this is PaneSplit) {
      final split = this as PaneSplit;
      split.first.walk(visit);
      split.second.walk(visit);
    }
  }

  // ---------------------------------------------------------------------------
  // 变换(纯函数,返回新树)
  // ---------------------------------------------------------------------------

  /// 把 id 为 [targetId] 的叶子拆分成一个分裂节点。
  ///
  /// 原叶子与新叶子 [newLeaf] 成为该分裂节点的两个子节点。默认新叶子放在
  /// second(右/下),与 WT “新窗格出现在右侧/下方” 的默认一致;
  /// 传 [insertNewFirst] = true 则放在 first。
  ///
  /// [ratio] 为 first 子节点占用的比例(0~1),会被夹取到 (0,1) 开区间。
  /// 找不到目标叶子时原样返回(不抛异常,便于上层容错)。
  Pane split(
    String targetId,
    PaneLeaf newLeaf, {
    required SplitAxis axis,
    double ratio = 0.5,
    bool insertNewFirst = false,
  }) {
    final r = _clampRatio(ratio);
    switch (this) {
      case PaneLeaf leaf:
        if (leaf.id != targetId) return this;
        return PaneSplit(
          axis: axis,
          ratio: r,
          first: insertNewFirst ? newLeaf : leaf,
          second: insertNewFirst ? leaf : newLeaf,
        );
      case PaneSplit split:
        final newFirst = split.first.split(
          targetId,
          newLeaf,
          axis: axis,
          ratio: ratio,
          insertNewFirst: insertNewFirst,
        );
        if (!identical(newFirst, split.first)) {
          return split.copyWith(first: newFirst);
        }
        final newSecond = split.second.split(
          targetId,
          newLeaf,
          axis: axis,
          ratio: ratio,
          insertNewFirst: insertNewFirst,
        );
        if (!identical(newSecond, split.second)) {
          return split.copyWith(second: newSecond);
        }
        return this;
    }
  }

  /// 交换两个叶子 [idA] 与 [idB] 的位置(它们承载的终端内容随之互换)。
  ///
  /// 两个 id 必须都存在且不同,否则原样返回。对应 WT 的 swapPane。
  Pane swap(String idA, String idB) {
    if (idA == idB) return this;
    final a = findLeaf(idA);
    final b = findLeaf(idB);
    if (a == null || b == null) return this;
    // 遍历替换:遇到 a 放 b、遇到 b 放 a。
    return _mapLeaves((leaf) {
      if (leaf.id == idA) return b;
      if (leaf.id == idB) return a;
      return leaf;
    });
  }

  /// 摘下 id 为 [targetId] 的叶子。
  ///
  /// 该叶子的父分裂节点会“坍缩”,由其兄弟子树顶替父节点的位置。
  /// 若该叶子是整棵树中唯一的叶子(无父节点可坍缩),返回的
  /// [DetachResult.tree] 为 null。找不到目标叶子返回 null。
  DetachResult? detach(String targetId) {
    final result = _detach(targetId);
    if (result == null) return null;
    return DetachResult(result.$1, result.$2);
  }

  /// 把 id 为 [sourceId] 的叶子移动到 id 为 [targetId] 的叶子处,
  /// 在目标位置沿 [axis] 方向重新分裂并挂上源叶子。
  ///
  /// 这是“拖拽移动窗格”的纯模型基础:先 detach 源,再在剩余树里对目标
  /// split。若源/目标相同、任一不存在、或源是唯一叶子,则原样返回。
  Pane move(
    String sourceId,
    String targetId, {
    required SplitAxis axis,
    double ratio = 0.5,
    bool insertSourceFirst = false,
  }) {
    if (sourceId == targetId) return this;
    if (!containsLeaf(sourceId) || !containsLeaf(targetId)) return this;

    final detached = detach(sourceId);
    if (detached == null || detached.tree == null) return this;

    final remaining = detached.tree!;
    // detach 后目标必须仍然存在(理论上一定在,除非源==目标,已排除)。
    if (!remaining.containsLeaf(targetId)) return this;

    return remaining.split(
      targetId,
      detached.detached,
      axis: axis,
      ratio: ratio,
      insertNewFirst: insertSourceFirst,
    );
  }

  // ---------------------------------------------------------------------------
  // 几何导航
  // ---------------------------------------------------------------------------

  /// 计算每个叶子在给定 [bounds] 内的矩形(默认单位方格)。
  ///
  /// 返回 叶子id -> 矩形 的映射,供渲染预览与 [navigate] 使用。
  Map<String, Rect> computeLayout([
    Rect bounds = const Rect(0, 0, 1, 1),
  ]) {
    final out = <String, Rect>{};
    _layout(bounds, out);
    return out;
  }

  /// 从 [fromId] 出发,按 [direction] 找几何上相邻的叶子 id。
  ///
  /// 语义对齐 WT 的 Alt/Cmd+方向键:在目标方向一侧、且与当前窗格在垂直
  /// 方向上有交叠的候选里,取边缘最近的那个;没有则返回 null。
  String? navigate(String fromId, PaneDirection direction) {
    final layout = computeLayout();
    final from = layout[fromId];
    if (from == null) return null;

    String? best;
    double bestPrimary = double.infinity; // 主轴距离(越小越近)
    double bestOverlap = -double.infinity; // 交叠长度(越大越好,用于打平)

    layout.forEach((id, rect) {
      if (id == fromId) return;

      final double primaryGap; // 目标方向上的间距(需 >= 0 才算在该侧)
      final double overlap; // 垂直方向交叠长度
      switch (direction) {
        case PaneDirection.left:
          primaryGap = from.left - rect.right;
          overlap = _overlap(from.top, from.bottom, rect.top, rect.bottom);
        case PaneDirection.right:
          primaryGap = rect.left - from.right;
          overlap = _overlap(from.top, from.bottom, rect.top, rect.bottom);
        case PaneDirection.up:
          primaryGap = from.top - rect.bottom;
          overlap = _overlap(from.left, from.right, rect.left, rect.right);
        case PaneDirection.down:
          primaryGap = rect.top - from.bottom;
          overlap = _overlap(from.left, from.right, rect.left, rect.right);
      }

      // 必须在目标方向一侧(允许极小的浮点误差),且有正向交叠。
      if (primaryGap < -_eps) return;
      if (overlap <= _eps) return;

      final gap = math.max(0.0, primaryGap);
      if (gap < bestPrimary - _eps ||
          (gap <= bestPrimary + _eps && overlap > bestOverlap)) {
        best = id;
        bestPrimary = gap;
        bestOverlap = overlap;
      }
    });

    return best;
  }

  // ---------------------------------------------------------------------------
  // 内部实现
  // ---------------------------------------------------------------------------

  /// 对每个叶子应用 [transform],重建整棵树(结构不变,只换叶子)。
  Pane _mapLeaves(PaneLeaf Function(PaneLeaf leaf) transform) {
    switch (this) {
      case PaneLeaf leaf:
        return transform(leaf);
      case PaneSplit split:
        return split.copyWith(
          first: split.first._mapLeaves(transform),
          second: split.second._mapLeaves(transform),
        );
    }
  }

  /// 递归摘除;返回 (剩余树, 被摘叶子)。剩余树为 null 表示当前节点整体被摘。
  (Pane?, PaneLeaf)? _detach(String targetId) {
    switch (this) {
      case PaneLeaf leaf:
        if (leaf.id == targetId) return (null, leaf);
        return null;
      case PaneSplit split:
        final fromFirst = split.first._detach(targetId);
        if (fromFirst != null) {
          final rest = fromFirst.$1;
          // first 子树被摘空 -> 由 second 顶替本分裂节点。
          if (rest == null) return (split.second, fromFirst.$2);
          return (split.copyWith(first: rest), fromFirst.$2);
        }
        final fromSecond = split.second._detach(targetId);
        if (fromSecond != null) {
          final rest = fromSecond.$1;
          if (rest == null) return (split.first, fromSecond.$2);
          return (split.copyWith(second: rest), fromSecond.$2);
        }
        return null;
    }
  }

  /// 递归布局:把 [bounds] 按分裂比例切分,写入叶子矩形到 [out]。
  void _layout(Rect bounds, Map<String, Rect> out) {
    switch (this) {
      case PaneLeaf leaf:
        out[leaf.id] = bounds;
      case PaneSplit split:
        final r = split.ratio;
        switch (split.axis) {
          case SplitAxis.horizontal:
            final w1 = bounds.width * r;
            split.first._layout(
              Rect(bounds.left, bounds.top, w1, bounds.height),
              out,
            );
            split.second._layout(
              Rect(bounds.left + w1, bounds.top, bounds.width - w1,
                  bounds.height),
              out,
            );
          case SplitAxis.vertical:
            final h1 = bounds.height * r;
            split.first._layout(
              Rect(bounds.left, bounds.top, bounds.width, h1),
              out,
            );
            split.second._layout(
              Rect(bounds.left, bounds.top + h1, bounds.width,
                  bounds.height - h1),
              out,
            );
        }
    }
  }

  static const double _eps = 1e-9;

  /// 两个一维区间 [a0,a1] 与 [b0,b1] 的交叠长度(可能为负)。
  static double _overlap(double a0, double a1, double b0, double b1) =>
      math.min(a1, b1) - math.max(a0, b0);

  static double _clampRatio(double ratio) =>
      ratio.clamp(_eps, 1 - _eps).toDouble();
}

/// 叶子:承载一个真终端。
///
/// 只保存稳定的 [id](供 swap/move/navigate 定位)以及可选 [title]。
/// 真正的终端会话、PTY、渲染由其它角色按 [id] 关联,这里不涉及。
final class PaneLeaf extends Pane {
  const PaneLeaf(this.id, {this.title});

  /// 稳定标识,全树内唯一。
  final String id;

  /// 可选显示标题。
  final String? title;

  PaneLeaf copyWith({String? id, String? title}) =>
      PaneLeaf(id ?? this.id, title: title ?? this.title);

  @override
  bool operator ==(Object other) =>
      other is PaneLeaf && other.id == id && other.title == title;

  @override
  int get hashCode => Object.hash(id, title);

  @override
  String toString() => 'PaneLeaf($id)';
}

/// 分裂:两个子窗格 + 方向 + 比例。
final class PaneSplit extends Pane {
  const PaneSplit({
    required this.axis,
    required this.first,
    required this.second,
    this.ratio = 0.5,
  });

  /// 分裂方向(横/竖)。
  final SplitAxis axis;

  /// first 子节点占用的比例(0~1);另一侧为 1-ratio。
  final double ratio;

  /// 第一个子节点(横=左 / 竖=上)。
  final Pane first;

  /// 第二个子节点(横=右 / 竖=下)。
  final Pane second;

  PaneSplit copyWith({
    SplitAxis? axis,
    double? ratio,
    Pane? first,
    Pane? second,
  }) =>
      PaneSplit(
        axis: axis ?? this.axis,
        ratio: ratio ?? this.ratio,
        first: first ?? this.first,
        second: second ?? this.second,
      );

  /// 返回调整比例后的新分裂节点(夹取到开区间)。
  PaneSplit withRatio(double newRatio) =>
      copyWith(ratio: Pane._clampRatio(newRatio));

  @override
  String toString() =>
      'PaneSplit(${axis.name}, ratio:$ratio, $first | $second)';
}
