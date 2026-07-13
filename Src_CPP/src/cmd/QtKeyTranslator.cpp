// Win-Term-Mac · C++ 方案 · cmd 角色
// QtKeyTranslator 实现。见 .h 顶部说明。

#include "cmd/QtKeyTranslator.h"

#include <QKeyEvent>

namespace wtm {
namespace cmd {

namespace {

// Qt 修饰键 -> keymap 修饰位。
std::uint8_t translateMods(Qt::KeyboardModifiers m) {
    std::uint8_t mods = keymap::ModNone;
    if (m & Qt::ShiftModifier)   mods |= keymap::ModShift;
    if (m & Qt::AltModifier)     mods |= keymap::ModAlt;
    if (m & Qt::ControlModifier) mods |= keymap::ModPrimary;  // mac 上即 Cmd
    if (m & Qt::MetaModifier)    mods |= keymap::ModCtrl;      // mac 上即真正的 Control
    return mods;
}

// Qt::Key -> keymap::KeyCode。只覆盖默认键位表用到的键。
keymap::KeyCode translateKey(int key) {
    using keymap::KeyCode;
    switch (key) {
        case Qt::Key_P:          return KeyCode::P;
        case Qt::Key_W:          return KeyCode::W;
        // '+' 常由 Shift+'=' 打出:两个物理键都归一到 Plus,让 Alt+Shift++ 稳定命中。
        case Qt::Key_Plus:
        case Qt::Key_Equal:      return KeyCode::Plus;
        // '-' 与 Shift+'-'('_')都归一到 Minus。
        case Qt::Key_Minus:
        case Qt::Key_Underscore: return KeyCode::Minus;
        case Qt::Key_Left:       return KeyCode::ArrowLeft;
        case Qt::Key_Right:      return KeyCode::ArrowRight;
        case Qt::Key_Up:         return KeyCode::ArrowUp;
        case Qt::Key_Down:       return KeyCode::ArrowDown;
        case Qt::Key_Return:
        case Qt::Key_Enter:      return KeyCode::Enter;
        case Qt::Key_Escape:     return KeyCode::Escape;
        case Qt::Key_Tab:        return KeyCode::Tab;
        default:                 return KeyCode::Unknown;
    }
}

} // namespace

std::optional<keymap::KeyChord> translateKeyEvent(const QKeyEvent* event) {
    if (event == nullptr) return std::nullopt;

    const keymap::KeyCode code = translateKey(event->key());
    if (code == keymap::KeyCode::Unknown) {
        return std::nullopt;   // 交给下游当普通输入
    }
    keymap::KeyChord chord;
    chord.key = code;
    chord.mods = translateMods(event->modifiers());
    return chord;
}

} // namespace cmd
} // namespace wtm
