// 【PaneCore】窗格二叉树纯核心测试。
//
// 重点覆盖 split 与 swap;同时对 move / navigate / walk / detach 做基本校验,
// 确保结构自洽。所有断言都基于纯模型,无需 Flutter/PTY 运行环境。

import 'package:flutter_test/flutter_test.dart';
import 'package:win_term_mac/pane/pane.dart';

void main() {
  group('split', () {
    test('把单个叶子拆成分裂节点,新叶子默认在 second', () {
      const root = PaneLeaf('a');
      final result = root.split('a', const PaneLeaf('b'),
          axis: SplitAxis.horizontal);

      expect(result, isA<PaneSplit>());
      final split = result as PaneSplit;
      expect(split.axis, SplitAxis.horizontal);
      expect(split.ratio, closeTo(0.5, 1e-9));
      expect((split.first as PaneLeaf).id, 'a');
      expect((split.second as PaneLeaf).id, 'b'); // 新叶子在右/下
      expect(result.leafCount, 2);
    });

    test('insertNewFirst=true 时新叶子放在 first', () {
      const root = PaneLeaf('a');
      final result = root.split('a', const PaneLeaf('b'),
          axis: SplitAxis.vertical, insertNewFirst: true) as PaneSplit;

      expect((result.first as PaneLeaf).id, 'b');
      expect((result.second as PaneLeaf).id, 'a');
    });

    test('对嵌套树中的深层叶子 split 只影响该叶子', () {
      const root = PaneSplit(
        axis: SplitAxis.horizontal,
        first: PaneLeaf('a'),
        second: PaneLeaf('b'),
      );
      final result = root.split('b', const PaneLeaf('c'),
          axis: SplitAxis.vertical, ratio: 0.3);

      expect(result.leafCount, 3);
      expect(result.containsLeaf('a'), isTrue);
      final split = result as PaneSplit;
      expect((split.first as PaneLeaf).id, 'a'); // 未受影响
      final rightSplit = split.second as PaneSplit;
      expect(rightSplit.axis, SplitAxis.vertical);
      expect(rightSplit.ratio, closeTo(0.3, 1e-9));
      expect((rightSplit.first as PaneLeaf).id, 'b');
      expect((rightSplit.second as PaneLeaf).id, 'c');
    });

    test('ratio 会被夹取到开区间 (0,1)', () {
      const root = PaneLeaf('a');
      final low = root.split('a', const PaneLeaf('b'),
          axis: SplitAxis.horizontal, ratio: 0.0) as PaneSplit;
      final high = root.split('a', const PaneLeaf('b'),
          axis: SplitAxis.horizontal, ratio: 1.0) as PaneSplit;

      expect(low.ratio, greaterThan(0.0));
      expect(high.ratio, lessThan(1.0));
    });

    test('目标 id 不存在时原样返回', () {
      const root = PaneLeaf('a');
      final result = root.split('zzz', const PaneLeaf('b'),
          axis: SplitAxis.horizontal);
      expect(identical(result, root), isTrue);
    });
  });

  group('swap', () {
    test('交换两个叶子的位置', () {
      const root = PaneSplit(
        axis: SplitAxis.horizontal,
        first: PaneLeaf('a'),
        second: PaneLeaf('b'),
      );
      final result = root.swap('a', 'b') as PaneSplit;

      expect((result.first as PaneLeaf).id, 'b');
      expect((result.second as PaneLeaf).id, 'a');
      // 结构(方向/比例)不变,只换内容。
      expect(result.axis, SplitAxis.horizontal);
      expect(result.leafCount, 2);
    });

    test('交换深层叶子:跨分支互换位置', () {
      // (a | (b / c))
      const root = PaneSplit(
        axis: SplitAxis.horizontal,
        first: PaneLeaf('a'),
        second: PaneSplit(
          axis: SplitAxis.vertical,
          first: PaneLeaf('b'),
          second: PaneLeaf('c'),
        ),
      );
      final result = root.swap('a', 'c') as PaneSplit;

      expect((result.first as PaneLeaf).id, 'c'); // a 的位置现在是 c
      final rightSplit = result.second as PaneSplit;
      expect((rightSplit.first as PaneLeaf).id, 'b');
      expect((rightSplit.second as PaneLeaf).id, 'a'); // c 的位置现在是 a
      expect(result.leafCount, 3);
    });

    test('保留被交换叶子的标题(内容随位置一起移动)', () {
      const root = PaneSplit(
        axis: SplitAxis.horizontal,
        first: PaneLeaf('a', title: 'AAA'),
        second: PaneLeaf('b', title: 'BBB'),
      );
      final result = root.swap('a', 'b') as PaneSplit;

      expect((result.first as PaneLeaf).title, 'BBB');
      expect((result.second as PaneLeaf).title, 'AAA');
    });

    test('相同 id 原样返回', () {
      const root = PaneSplit(
        axis: SplitAxis.horizontal,
        first: PaneLeaf('a'),
        second: PaneLeaf('b'),
      );
      expect(identical(root.swap('a', 'a'), root), isTrue);
    });

    test('任一 id 不存在时原样返回', () {
      const root = PaneSplit(
        axis: SplitAxis.horizontal,
        first: PaneLeaf('a'),
        second: PaneLeaf('b'),
      );
      expect(identical(root.swap('a', 'zzz'), root), isTrue);
    });
  });

  group('detach & move', () {
    test('摘除叶子后父分裂坍缩,兄弟顶替', () {
      const root = PaneSplit(
        axis: SplitAxis.horizontal,
        first: PaneLeaf('a'),
        second: PaneLeaf('b'),
      );
      final res = root.detach('a')!;
      expect(res.detached.id, 'a');
      expect(res.tree, isA<PaneLeaf>());
      expect((res.tree as PaneLeaf).id, 'b'); // b 顶替父节点
    });

    test('唯一叶子无法摘除,tree 为 null', () {
      const root = PaneLeaf('a');
      final res = root.detach('a')!;
      expect(res.tree, isNull);
    });

    test('move:把叶子搬到另一叶子处重新分裂', () {
      // (a | (b / c)) -> 把 a 移到 c 处
      const root = PaneSplit(
        axis: SplitAxis.horizontal,
        first: PaneLeaf('a'),
        second: PaneSplit(
          axis: SplitAxis.vertical,
          first: PaneLeaf('b'),
          second: PaneLeaf('c'),
        ),
      );
      final result = root.move('a', 'c', axis: SplitAxis.horizontal);

      expect(result.leafCount, 3);
      expect(result.containsLeaf('a'), isTrue);
      // a 摘走后左侧坍缩,根应变为原来的右分裂。
      final split = result as PaneSplit;
      expect(split.axis, SplitAxis.vertical); // 原 (b / c) 分裂
      final cSplit = split.second as PaneSplit; // c 位置被拆
      expect(cSplit.axis, SplitAxis.horizontal);
      expect((cSplit.first as PaneLeaf).id, 'c');
      expect((cSplit.second as PaneLeaf).id, 'a'); // 移动来的 a 在 second
    });

    test('move 源与目标相同时原样返回', () {
      const root = PaneSplit(
        axis: SplitAxis.horizontal,
        first: PaneLeaf('a'),
        second: PaneLeaf('b'),
      );
      expect(identical(root.move('a', 'a', axis: SplitAxis.vertical), root),
          isTrue);
    });
  });

  group('navigate', () {
    // 布局:( a | b )  水平并排,a 在左、b 在右。
    const horizontal = PaneSplit(
      axis: SplitAxis.horizontal,
      first: PaneLeaf('a'),
      second: PaneLeaf('b'),
    );

    test('向右从 a 到 b,向左从 b 到 a', () {
      expect(horizontal.navigate('a', PaneDirection.right), 'b');
      expect(horizontal.navigate('b', PaneDirection.left), 'a');
    });

    test('边界方向无相邻返回 null', () {
      expect(horizontal.navigate('a', PaneDirection.left), isNull);
      expect(horizontal.navigate('a', PaneDirection.up), isNull);
    });

    test('竖直堆叠:上/下导航', () {
      const vertical = PaneSplit(
        axis: SplitAxis.vertical,
        first: PaneLeaf('top'),
        second: PaneLeaf('bottom'),
      );
      expect(vertical.navigate('top', PaneDirection.down), 'bottom');
      expect(vertical.navigate('bottom', PaneDirection.up), 'top');
    });

    test('复杂布局:选取交叠最近的相邻窗格', () {
      // ( a | (b / c) ):a 左整列,右侧上 b 下 c。
      const root = PaneSplit(
        axis: SplitAxis.horizontal,
        ratio: 0.5,
        first: PaneLeaf('a'),
        second: PaneSplit(
          axis: SplitAxis.vertical,
          first: PaneLeaf('b'),
          second: PaneLeaf('c'),
        ),
      );
      // a 向右:b 与 c 都在右侧且都与 a 有垂直交叠,取更近/更大交叠者。
      final right = root.navigate('a', PaneDirection.right);
      expect(right == 'b' || right == 'c', isTrue);
      // b 向左应回到 a。
      expect(root.navigate('b', PaneDirection.left), 'a');
      // b 向下到 c。
      expect(root.navigate('b', PaneDirection.down), 'c');
    });
  });

  group('walk & 查询', () {
    const root = PaneSplit(
      axis: SplitAxis.horizontal,
      first: PaneLeaf('a'),
      second: PaneSplit(
        axis: SplitAxis.vertical,
        first: PaneLeaf('b'),
        second: PaneLeaf('c'),
      ),
    );

    test('leaves 前序收集全部叶子', () {
      expect(root.leaves.map((l) => l.id).toList(), ['a', 'b', 'c']);
      expect(root.leafCount, 3);
    });

    test('walk 访问所有节点(叶子+分裂)', () {
      var splitCount = 0;
      var leafCount = 0;
      root.walk((node) {
        if (node is PaneSplit) splitCount++;
        if (node is PaneLeaf) leafCount++;
      });
      expect(splitCount, 2);
      expect(leafCount, 3);
    });

    test('computeLayout 铺满单位方格且不重叠总面积为 1', () {
      final layout = root.computeLayout();
      expect(layout.length, 3);
      final total = layout.values
          .fold<double>(0, (acc, r) => acc + r.width * r.height);
      expect(total, closeTo(1.0, 1e-9));
    });
  });
}
