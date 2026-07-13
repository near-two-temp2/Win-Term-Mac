# Win-Term-Mac · Flutter 方案

> 一句话定位:**「一套 Dart 代码 + GPU 自绘 + 热重载开发爽」的快速跨平台候选**——用最短路径把窗格切分、命令面板、终端仿真做出可用效果,代价是手感非原生。

本方案是「多方案赛马」仓库中的 **Flutter 实现**,与 Rust(主力 A)、Mix(B)、CPP、Tauri、Golang、Electron 共 7 个实现并列,同一产品各写一遍做横向对比。

在赛马里,Flutter 扮演的角色是**「出效果最快的探路者」**:热重载让 UI 迭代极快,一套码直出三平台,适合先把交互原型跑通、验证产品手感;但它自绘一切(不走系统原生控件),这恰好是用户嫌弃 WezTerm 那类工具的同一类理由——所以它更可能是「快速验证」而非「最终交付」的选择。

---

## 一、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 语言 | Dart | 单一语言全平台;GC 语言,非系统级 |
| 框架 | Flutter Desktop | macOS / Linux / Windows 桌面端 |
| 渲染 | Skia / Impeller(GPU 自绘) | 所有像素自己画,跨平台完全一致 |
| VT/ANSI 仿真 | [xterm.dart](https://pub.dev/packages/xterm) | 纯 Dart 终端仿真库 |
| PTY | [flutter_pty](https://pub.dev/packages/flutter_pty) | 跨平台伪终端,拉起真实 shell |
| 窗格树 | Dart 递归 Widget | indirect 数据模型 + 递归 Split/Leaf Widget |
| 分隔条 | Draggable / GestureDetector | 拖动实时改比例 |
| 命令面板 | Overlay 浮层 + 可搜索 ListView | Flutter 做浮层极其简单 |
| 快捷键 | Shortcuts / Actions / Focus | Flutter 内置的键位与焦点体系 |

---

## 二、优点

- **一套码全平台**:一份 Dart 源码同时构建 macOS / Linux / Windows,维护成本最低。
- **GPU 自绘一致**:三平台像素级完全相同,不受各系统控件差异干扰。
- **热重载,出效果快**:改 UI 秒级看到结果,原型迭代速度在 7 方案里最快。
- **生态现成**:`xterm.dart` + `flutter_pty` 直接组合就能跑起一个终端,不用自己写 VT 解析和 PTY 桥接。
- **递归 Widget 天然契合二叉树**:窗格模型本身就是一棵树,Flutter 的 Widget 树递归组合与它是同构的,Split/Leaf 写起来非常顺。

---

## 三、缺点与风险(诚实版)

- **非原生手感(核心硬伤)**:全自绘意味着菜单、窗口 chrome、文本选区、右键菜单、滚动惯性都不遵循系统惯例。这正是用户想逃离 WezTerm 那类工具的理由——Flutter 在同一个坑里。对「追求原生手感」的项目目标,这是根本性的减分项。
- **Dart 语言**:相对小众,团队与生态不如主流系统语言;GC 带来的偶发停顿在高频刷新场景需要留意。
- **文本吞吐天花板偏低**:终端级高吞吐(大量滚动/刷屏)下,Skia 的文本绘制性能天花板中等,重压场景不如原生 GPU 文本方案。
- **Flutter Linux 桌面较新**:桌面端(尤其 Linux)成熟度不如移动端,窗口管理、输入法、多显示器等边角可能踩坑。
- **连字与复杂文字待验证**:等宽字体连字(ligatures)、CJK/Emoji/组合字符、双宽字符对齐等需要在 `xterm.dart` 上逐一验证,不能假设开箱即用。
- **性能天花板中等**:适合做到「流畅可用」,但要冲击原生级别的极致吞吐与低延迟会比较吃力。

---

## 四、核心体验

Win-Term-Mac 复刻 Windows Terminal 最出彩的上层体验,用户最看重三件事:**①自由切分窗格 ②通过命令面板交换/移动窗格 ③命令面板本身**。

### 4.1 窗格二叉树模型

与 WT(`src/cascadia/TerminalApp/Pane.cpp`)一致:每个节点要么是**叶子**(一个真实终端),要么是**分裂节点**(方向 横/竖 + 比例 0~1 + 两个子节点)。

数据模型(indirect,与渲染分离):

```dart
/// 分裂方向
enum SplitAxis { horizontal, vertical } // horizontal=左右分栏, vertical=上下分栏

/// 窗格节点:叶子 或 分裂
sealed class PaneNode {
  const PaneNode();
}

/// 叶子:承载一个真实终端(xterm.dart + flutter_pty)
class LeafPane extends PaneNode {
  final String id;
  final Terminal terminal;   // xterm.dart
  final Pty pty;             // flutter_pty
  LeafPane(this.id, this.terminal, this.pty);
}

/// 分裂:方向 + 比例(第一个子节点占比 0~1) + 两个子节点
class SplitPane extends PaneNode {
  final SplitAxis axis;
  double ratio;              // 0.0 ~ 1.0,可被分隔条拖动修改
  PaneNode first;
  PaneNode second;
  SplitPane({required this.axis, this.ratio = 0.5,
             required this.first, required this.second});
}
```

递归渲染 Widget(与数据模型同构):

```dart
class PaneView extends StatelessWidget {
  final PaneNode node;
  const PaneView(this.node, {super.key});

  @override
  Widget build(BuildContext context) {
    final n = node;
    if (n is LeafPane) {
      return TerminalView(n.terminal);          // xterm.dart 的终端视图
    }
    n as SplitPane;
    final horizontal = n.axis == SplitAxis.horizontal;
    return LayoutBuilder(builder: (ctx, c) {
      final total = horizontal ? c.maxWidth : c.maxHeight;
      final firstSize = total * n.ratio;
      final children = [
        SizedBox(
          width:  horizontal ? firstSize : null,
          height: horizontal ? null : firstSize,
          child: PaneView(n.first),              // 递归
        ),
        PaneDivider(                             // 分隔条:GestureDetector 拖动改 ratio
          axis: n.axis,
          onDrag: (delta) => /* setState: n.ratio += delta/total */ {},
        ),
        Expanded(child: PaneView(n.second)),     // 递归
      ];
      return horizontal ? Row(children: children) : Column(children: children);
    });
  }
}
```

核心操作(对应 WT 的 Pane 能力):`Split`(把一个叶子替换为 SplitPane)、`SwapPanes`(交换两个叶子引用)、`DetachPane / AttachPane`(摘下/挂载子树)、`NavigateDirection`(在树上按几何位置切焦点)、`Maximize / Restore`(临时把某叶子铺满,保留树结构)。分隔条拖动直接改对应 `SplitPane.ratio` 并 `setState`。

### 4.2 命令面板

用 `Overlay` 插一层半透明浮层,里面放一个 `TextField` + 可搜索的 `ListView`(命令项做模糊匹配)。这在 Flutter 里是最舒服的部分——浮层、动画、列表、键盘导航都是框架长项。

设计哲学承袭 WT:**高频操作给热键,低频强力操作收进命令面板**。`swapPane`(交换窗格)默认就没有热键,只能从命令面板走——这是刻意的,避免误触且保持键位表干净。

### 4.3 WT 键位表(macOS 上 Ctrl 换 Cmd)

| 操作 | Windows / Linux | macOS | 归属 |
| --- | --- | --- | --- |
| 命令面板 | `Ctrl+Shift+P` | `Cmd+Shift+P` | 热键 |
| 向右拆分 | `Alt+Shift++` | `Alt+Shift++` | 热键 |
| 向下拆分 | `Alt+Shift+-` | `Alt+Shift+-` | 热键 |
| 调整窗格大小 | `Alt+Shift+方向键` | `Alt+Shift+方向键` | 热键 |
| 切换焦点 | `Alt+方向键` | `Alt+方向键` | 热键 |
| **交换窗格 swapPane** | 无默认热键 | 无默认热键 | **仅命令面板** |
| 最大化/还原窗格 | 命令面板 | 命令面板 | 命令面板 |

> 说明:`swapPane` 属「低频强力操作」,遵循 WT 哲学不给默认热键,只走命令面板。

---

## 五、构建与 CI

- **CI**:GitHub Actions,三 runner(`macos-latest` / `ubuntu-latest` / `windows-latest`)并行。
- **装 Flutter**:用 [`subosito/flutter-action`](https://github.com/subosito/flutter-action) 安装指定 channel/版本的 Flutter。
- **开启桌面目标**:各 runner 先启用对应 desktop 目标(项目内需已 `flutter config --enable-macos-desktop` / `--enable-linux-desktop` / `--enable-windows-desktop`,并存在对应平台目录)。
- **构建命令**:分别 `flutter build macos` / `flutter build linux` / `flutter build windows`。
- **Linux 依赖**:ubuntu runner 需额外装 GTK/ninja/clang 等桌面构建依赖(`libgtk-3-dev` 等)。
- **Mac 分发**:免安全警告需 Apple 开发者账号做**签名 + 公证(notarization)**;否则用户首次打开会被 Gatekeeper 拦截。

---

## 六、里程碑

| 里程碑 | 目标 |
| --- | --- |
| **M0** | `flutter create` 桌面工程,三平台各自开出一个空窗口 |
| **M1** | 接入 `xterm.dart` + `flutter_pty`,单窗格跑起真实 shell |
| **M2** | 递归 Split Widget + 拖分隔条调大小 + 快捷键切焦点 |
| **M3** | 交换/移动窗格(SwapPanes / Detach-Attach)+ 命令面板浮层 |
| **M4** | 标签页 + 主题 + 配置文件 |

---

## 七、目录结构(占位)

```
Src_Flutter/
├── ReadMe.md                # 本文件
├── pubspec.yaml             # 依赖:xterm, flutter_pty ...(占位)
├── lib/
│   ├── main.dart            # 入口,开窗(占位)
│   ├── model/
│   │   └── pane_node.dart   # PaneNode / LeafPane / SplitPane(占位)
│   ├── widgets/
│   │   ├── pane_view.dart   # 递归 Split/Leaf 渲染(占位)
│   │   ├── pane_divider.dart# 分隔条拖动改比例(占位)
│   │   └── command_palette.dart # 命令面板浮层(占位)
│   ├── terminal/
│   │   └── session.dart     # xterm.dart + flutter_pty 桥接(占位)
│   └── keymap/
│       └── shortcuts.dart   # WT 键位映射(占位)
├── macos/                   # macOS 桌面目标(占位)
├── linux/                   # Linux 桌面目标(占位)
├── windows/                 # Windows 桌面目标(占位)
└── test/                    # 单测(占位)
```
