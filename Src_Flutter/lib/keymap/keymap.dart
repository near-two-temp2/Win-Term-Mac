// Win-Term-Mac / Src_Flutter 方案 ——【Palette】角色(键位部分)。
//
// 本文件把 Windows Terminal 的键位映射成一组“动作意图(PaneAction)”,并给出
// 跨平台的快捷键定义。设计遵循 WT 的哲学:
//   - 高频操作(拆分 / 调整大小 / 切焦点 / 打开命令面板)绑定热键;
//   - 低频强力操作(交换窗格 swapPane / 移动窗格 movePane)**不绑热键**,
//     只通过命令面板触发(见 command_palette.dart)。
//
// 平台差异(硬性要求):macOS 上把 Ctrl 换成 Cmd(meta)。Alt 在 macOS 上是
// Option 键,WT 的 Alt 系列热键在 macOS 上继续用 Alt,不改。
//
// 与 WT 默认键位的对应:
//   - 命令面板         Ctrl+Shift+P  (macOS: Cmd+Shift+P)
//   - 向右拆分         Alt+Shift++
//   - 向下拆分         Alt+Shift+-
//   - 调整大小         Alt+Shift+方向键
//   - 切换焦点         Alt+方向键
//   - 交换窗格 swap    (无热键,仅命令面板)
//   - 移动窗格 move    (无热键,仅命令面板)
//
// 本文件只产出“意图”与“快捷键表”,不直接改窗格树。上层把 PaneActionIntent
// 接到 Actions/Shortcuts,再调用 pane.dart 里的纯操作(split/swap/move/…)。

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// 用户可触发的窗格动作(意图)。
///
/// 这是键位表与命令面板共享的“动作词表”。带方向的动作用独立枚举值表达,
/// 便于直接映射到具体快捷键与命令项。
enum PaneAction {
  /// 打开/关闭命令面板(Ctrl/Cmd+Shift+P)。
  toggleCommandPalette,

  /// 向右拆分当前窗格(新窗格出现在右侧)。
  splitRight,

  /// 向下拆分当前窗格(新窗格出现在下方)。
  splitDown,

  /// 调整大小:把当前窗格与相邻分隔线向对应方向推。
  resizeUp,
  resizeDown,
  resizeLeft,
  resizeRight,

  /// 切换焦点:按几何相邻关系移动焦点。
  focusUp,
  focusDown,
  focusLeft,
  focusRight,

  /// 关闭当前窗格。
  closePane,

  /// 最大化 / 还原当前窗格(zoom)。
  toggleMaximizePane,

  /// 交换窗格 —— **仅命令面板触发**,不绑热键。
  swapPane,

  /// 移动窗格 —— **仅命令面板触发**,不绑热键。
  movePane,
}

/// 一个可通过 Flutter 快捷键系统派发的意图,携带具体 [PaneAction]。
///
/// 上层用 `Actions` 注册一个 `Action<PaneActionIntent>`,在其中根据
/// `intent.action` 分派到窗格树的具体纯操作。
class PaneActionIntent extends Intent {
  const PaneActionIntent(this.action);

  final PaneAction action;
}

/// 仅通过命令面板触发、**不应绑定热键**的动作集合。
///
/// [buildShortcuts] 会跳过这些动作;命令面板则据此判断“无热键”。
const Set<PaneAction> paletteOnlyActions = {
  PaneAction.swapPane,
  PaneAction.movePane,
};

/// WT 键位工厂:根据平台产出 Flutter 快捷键表。
///
/// 返回值可直接喂给 `Shortcuts(shortcuts: ...)`。所有条目的值都是
/// [PaneActionIntent],由上层的 Actions 统一消费。
class Keymap {
  const Keymap._();

  /// 构建 快捷键 -> 意图 的映射。
  ///
  /// [platform] 决定“主修饰键”:macOS 用 meta(Cmd),其余平台用 control。
  /// 只有主修饰键相关的绑定(命令面板)会随平台切换;Alt 系列保持不变。
  static Map<ShortcutActivator, Intent> buildShortcuts({
    required TargetPlatform platform,
  }) {
    final bool useMeta = platform == TargetPlatform.macOS;

    return <ShortcutActivator, Intent>{
      // 命令面板:Ctrl/Cmd + Shift + P。
      SingleActivator(
        LogicalKeyboardKey.keyP,
        control: !useMeta,
        meta: useMeta,
        shift: true,
      ): const PaneActionIntent(PaneAction.toggleCommandPalette),

      // 向右拆分:Alt+Shift++(同时兼容主键区 '=' 与小键盘 '+')。
      const SingleActivator(
        LogicalKeyboardKey.equal,
        alt: true,
        shift: true,
      ): const PaneActionIntent(PaneAction.splitRight),
      const SingleActivator(
        LogicalKeyboardKey.numpadAdd,
        alt: true,
        shift: true,
      ): const PaneActionIntent(PaneAction.splitRight),

      // 向下拆分:Alt+Shift+-(兼容主键区 '-' 与小键盘 '-')。
      const SingleActivator(
        LogicalKeyboardKey.minus,
        alt: true,
        shift: true,
      ): const PaneActionIntent(PaneAction.splitDown),
      const SingleActivator(
        LogicalKeyboardKey.numpadSubtract,
        alt: true,
        shift: true,
      ): const PaneActionIntent(PaneAction.splitDown),

      // 调整大小:Alt+Shift+方向键。
      const SingleActivator(
        LogicalKeyboardKey.arrowUp,
        alt: true,
        shift: true,
      ): const PaneActionIntent(PaneAction.resizeUp),
      const SingleActivator(
        LogicalKeyboardKey.arrowDown,
        alt: true,
        shift: true,
      ): const PaneActionIntent(PaneAction.resizeDown),
      const SingleActivator(
        LogicalKeyboardKey.arrowLeft,
        alt: true,
        shift: true,
      ): const PaneActionIntent(PaneAction.resizeLeft),
      const SingleActivator(
        LogicalKeyboardKey.arrowRight,
        alt: true,
        shift: true,
      ): const PaneActionIntent(PaneAction.resizeRight),

      // 切换焦点:Alt+方向键。
      const SingleActivator(
        LogicalKeyboardKey.arrowUp,
        alt: true,
      ): const PaneActionIntent(PaneAction.focusUp),
      const SingleActivator(
        LogicalKeyboardKey.arrowDown,
        alt: true,
      ): const PaneActionIntent(PaneAction.focusDown),
      const SingleActivator(
        LogicalKeyboardKey.arrowLeft,
        alt: true,
      ): const PaneActionIntent(PaneAction.focusLeft),
      const SingleActivator(
        LogicalKeyboardKey.arrowRight,
        alt: true,
      ): const PaneActionIntent(PaneAction.focusRight),

      // 注意:swapPane / movePane 故意不在此表内 —— 仅命令面板触发。
    };
  }

  /// 生成某动作的“人类可读热键标签”(用于命令面板右侧展示)。
  ///
  /// 无热键的动作(命令面板专属,或未定义)返回 null。macOS 用符号形式
  /// (⌘⇧P、⌥⇧+…),其余平台用 “Ctrl+Shift+P” 文字形式。
  static String? hotkeyLabelFor(PaneAction action, TargetPlatform platform) {
    if (paletteOnlyActions.contains(action)) return null;

    final bool mac = platform == TargetPlatform.macOS;
    // 修饰键符号:主修饰键随平台变(Cmd/Ctrl),Alt/Shift 随平台换符号。
    final String primary = mac ? '⌘' : 'Ctrl';
    final String alt = mac ? '⌥' : 'Alt';
    final String shift = mac ? '⇧' : 'Shift';
    final String join = mac ? '' : '+';

    String combo(List<String> parts) => parts.join(join);

    switch (action) {
      case PaneAction.toggleCommandPalette:
        return combo([primary, shift, 'P']);
      case PaneAction.splitRight:
        return combo([alt, shift, '+']);
      case PaneAction.splitDown:
        return combo([alt, shift, '-']);
      case PaneAction.resizeUp:
        return combo([alt, shift, '↑']);
      case PaneAction.resizeDown:
        return combo([alt, shift, '↓']);
      case PaneAction.resizeLeft:
        return combo([alt, shift, '←']);
      case PaneAction.resizeRight:
        return combo([alt, shift, '→']);
      case PaneAction.focusUp:
        return combo([alt, '↑']);
      case PaneAction.focusDown:
        return combo([alt, '↓']);
      case PaneAction.focusLeft:
        return combo([alt, '←']);
      case PaneAction.focusRight:
        return combo([alt, '→']);
      case PaneAction.closePane:
        // WT 默认 Ctrl+Shift+W;此处给出对应标签(绑定与否由上层决定)。
        return combo([primary, shift, 'W']);
      case PaneAction.toggleMaximizePane:
        // WT 无固定默认热键,主要走命令面板,这里不给标签。
        return null;
      case PaneAction.swapPane:
      case PaneAction.movePane:
        return null;
    }
  }
}
