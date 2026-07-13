// Win-Term-Mac · C++ 方案 · cmd 角色(命令面板 + 键位接线)
// QtKeyTranslator:把 Qt 的 QKeyEvent 翻译成 keymap 的平台无关 KeyChord。
//
// 为什么需要它:keymap::Keymap 是纯 C++ 模型层(不认识 Qt),它按 KeyChord
// 查动作。真实事件来自 Qt。本文件是二者之间唯一的翻译点,属于 cmd(装配)角色。
//
// 平台约定(与 keymap 的 Primary 抽象对齐):
//   - Primary = Ctrl(Win/Linux)/ Cmd(macOS)。Qt 默认在 macOS 上互换 Ctrl/Meta,
//     因此 Qt::ControlModifier 在两端都对应「Primary」(mac 上即 Cmd 键)。
//   - Alt        = Qt::AltModifier(macOS 的 Option)。
//   - Shift      = Qt::ShiftModifier。
//   - 字面 Ctrl  = Qt::MetaModifier(mac 上是真正的 Control 键;其它平台是 Meta/Win 键)。
//
// 本文件依赖 Qt(QKeyEvent)与 keymap(KeyChord),不碰窗格树 / 终端。

#ifndef WTM_CMD_QTKEYTRANSLATOR_H
#define WTM_CMD_QTKEYTRANSLATOR_H

#include <optional>

#include "keymap/Keymap.h"

class QKeyEvent;

namespace wtm {
namespace cmd {

// 把一个 QKeyEvent 翻译成 KeyChord。
//   - 修饰键位掩码按上面的平台约定归一化。
//   - 键码只覆盖 keymap::KeyCode 里列出的键;无法识别的键返回 nullopt
//     (调用方应把这类按键当作「喂给子进程的普通输入」放行)。
std::optional<keymap::KeyChord> translateKeyEvent(const QKeyEvent* event);

} // namespace cmd
} // namespace wtm

#endif // WTM_CMD_QTKEYTRANSLATOR_H
