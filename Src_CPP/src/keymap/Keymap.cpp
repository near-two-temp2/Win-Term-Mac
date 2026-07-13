// Win-Term-Mac · C++ 方案 · keymap 角色 实现
// 见 Keymap.h 顶部说明。本文件纯 C++17。

#include "keymap/Keymap.h"

namespace wtm::keymap {

// ---- 动作元数据 -------------------------------------------------------------

bool IsPaletteOnly(ActionId id) noexcept {
    switch (id) {
        case ActionId::SwapPaneLeft:
        case ActionId::SwapPaneRight:
        case ActionId::SwapPaneUp:
        case ActionId::SwapPaneDown:
        case ActionId::MovePaneLeft:
        case ActionId::MovePaneRight:
        case ActionId::MovePaneUp:
        case ActionId::MovePaneDown:
            return true;
        default:
            return false;
    }
}

const char* ActionTitle(ActionId id) noexcept {
    switch (id) {
        case ActionId::SplitRight:           return "Split Pane Right";
        case ActionId::SplitDown:            return "Split Pane Down";
        case ActionId::ResizeLeft:           return "Resize Pane Left";
        case ActionId::ResizeRight:          return "Resize Pane Right";
        case ActionId::ResizeUp:             return "Resize Pane Up";
        case ActionId::ResizeDown:           return "Resize Pane Down";
        case ActionId::FocusLeft:            return "Move Focus Left";
        case ActionId::FocusRight:           return "Move Focus Right";
        case ActionId::FocusUp:              return "Move Focus Up";
        case ActionId::FocusDown:            return "Move Focus Down";
        case ActionId::ToggleZoom:           return "Toggle Pane Zoom";
        case ActionId::ClosePane:            return "Close Pane";
        case ActionId::ToggleCommandPalette: return "Toggle Command Palette";
        case ActionId::SwapPaneLeft:         return "Swap Pane Left";
        case ActionId::SwapPaneRight:        return "Swap Pane Right";
        case ActionId::SwapPaneUp:           return "Swap Pane Up";
        case ActionId::SwapPaneDown:         return "Swap Pane Down";
        case ActionId::MovePaneLeft:         return "Move Pane Left";
        case ActionId::MovePaneRight:        return "Move Pane Right";
        case ActionId::MovePaneUp:           return "Move Pane Up";
        case ActionId::MovePaneDown:         return "Move Pane Down";
        case ActionId::None:                 return "";
    }
    return "";
}

const char* ActionCategory(ActionId id) noexcept {
    switch (id) {
        case ActionId::SplitRight:
        case ActionId::SplitDown:
        case ActionId::ClosePane:
        case ActionId::SwapPaneLeft:
        case ActionId::SwapPaneRight:
        case ActionId::SwapPaneUp:
        case ActionId::SwapPaneDown:
        case ActionId::MovePaneLeft:
        case ActionId::MovePaneRight:
        case ActionId::MovePaneUp:
        case ActionId::MovePaneDown:
            return "Pane";
        case ActionId::ResizeLeft:
        case ActionId::ResizeRight:
        case ActionId::ResizeUp:
        case ActionId::ResizeDown:
            return "Resize";
        case ActionId::FocusLeft:
        case ActionId::FocusRight:
        case ActionId::FocusUp:
        case ActionId::FocusDown:
            return "Focus";
        case ActionId::ToggleZoom:
        case ActionId::ToggleCommandPalette:
            return "View";
        case ActionId::None:
            return "";
    }
    return "";
}

// ---- 平台判定 ---------------------------------------------------------------

bool IsMacPlatform() noexcept {
#if defined(WTM_PLATFORM_MACOS)
    return true;
#elif defined(__APPLE__)
    return true;
#else
    return false;
#endif
}

// ---- 显示串 -----------------------------------------------------------------

namespace {

const char* KeyName(KeyCode key) noexcept {
    switch (key) {
        case KeyCode::P:          return "P";
        case KeyCode::W:          return "W";
        case KeyCode::Plus:       return "+";
        case KeyCode::Minus:      return "-";
        case KeyCode::ArrowLeft:  return "Left";
        case KeyCode::ArrowRight: return "Right";
        case KeyCode::ArrowUp:    return "Up";
        case KeyCode::ArrowDown:  return "Down";
        case KeyCode::Enter:      return "Enter";
        case KeyCode::Escape:     return "Esc";
        case KeyCode::Tab:        return "Tab";
        case KeyCode::Unknown:    return "";
    }
    return "";
}

} // namespace

std::string DescribeChord(const KeyChord& chord) {
    const bool mac = IsMacPlatform();
    std::string out;
    auto add = [&out](const char* token) {
        if (!out.empty()) out += "+";
        out += token;
    };

    // 顺序对齐常见习惯:Primary(Ctrl/Cmd)→ Alt/Option → Shift → Ctrl(字面)。
    if (chord.mods & ModPrimary) add(mac ? "Cmd" : "Ctrl");
    if (chord.mods & ModAlt)     add(mac ? "Option" : "Alt");
    if (chord.mods & ModShift)   add("Shift");
    if (chord.mods & ModCtrl)    add("Ctrl");

    const char* k = KeyName(chord.key);
    if (k[0] != '\0') add(k);
    return out;
}

// ---- Keymap -----------------------------------------------------------------

bool Keymap::Bind(const KeyChord& chord, ActionId action) {
    // 硬规则:交换/移动等强力操作不给默认热键。
    if (IsPaletteOnly(action)) return false;
    // 覆盖同一 chord 的旧绑定,保持「一个 chord 一个动作」。
    for (auto& b : bindings_) {
        if (b.chord == chord) {
            b.action = action;
            return true;
        }
    }
    bindings_.push_back(Binding{chord, action});
    return true;
}

std::optional<ActionId> Keymap::Lookup(const KeyChord& chord) const {
    for (const auto& b : bindings_) {
        if (b.chord == chord) return b.action;
    }
    return std::nullopt;
}

std::optional<KeyChord> Keymap::ChordFor(ActionId action) const {
    for (const auto& b : bindings_) {
        if (b.action == action) return b.chord;
    }
    return std::nullopt;
}

Keymap Keymap::DefaultKeymap() {
    Keymap km;

    // 命令面板:Ctrl/Cmd + Shift + P。
    km.Bind({ModPrimary | ModShift, KeyCode::P}, ActionId::ToggleCommandPalette);

    // 拆分:Alt + Shift + '+' / '-'(WT 默认)。
    km.Bind({ModAlt | ModShift, KeyCode::Plus},  ActionId::SplitRight);
    km.Bind({ModAlt | ModShift, KeyCode::Minus}, ActionId::SplitDown);

    // 调整大小:Alt + Shift + 方向键。
    km.Bind({ModAlt | ModShift, KeyCode::ArrowLeft},  ActionId::ResizeLeft);
    km.Bind({ModAlt | ModShift, KeyCode::ArrowRight}, ActionId::ResizeRight);
    km.Bind({ModAlt | ModShift, KeyCode::ArrowUp},    ActionId::ResizeUp);
    km.Bind({ModAlt | ModShift, KeyCode::ArrowDown},  ActionId::ResizeDown);

    // 切焦点:Alt + 方向键。
    km.Bind({ModAlt, KeyCode::ArrowLeft},  ActionId::FocusLeft);
    km.Bind({ModAlt, KeyCode::ArrowRight}, ActionId::FocusRight);
    km.Bind({ModAlt, KeyCode::ArrowUp},    ActionId::FocusUp);
    km.Bind({ModAlt, KeyCode::ArrowDown},  ActionId::FocusDown);

    // 最大化 / 还原:Ctrl/Cmd + Shift + Enter(近似 WT zoom)。
    km.Bind({ModPrimary | ModShift, KeyCode::Enter}, ActionId::ToggleZoom);

    // 关闭窗格:Ctrl/Cmd + Shift + W。
    km.Bind({ModPrimary | ModShift, KeyCode::W}, ActionId::ClosePane);

    // 注意:SwapPane* / MovePane* 故意不绑定 —— 只走命令面板(见 IsPaletteOnly)。
    return km;
}

} // namespace wtm::keymap
