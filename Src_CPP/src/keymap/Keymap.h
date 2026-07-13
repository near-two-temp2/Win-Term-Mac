// Win-Term-Mac · C++ 方案 · keymap 角色
// Keymap:把「按键组合(KeyChord)」映射到「动作(ActionId)」,对齐 Windows
// Terminal 的默认键位。纯 C++17,不依赖 Qt,便于单元断言;Qt 事件 → KeyChord 的
// 翻译在集成层做(见文件末的 TODO 桩)。
//
// 设计哲学(与 WT 对齐):
//   - 高频操作给热键:拆分、调整大小、切焦点、最大化。
//   - 低频强力操作(交换/移动窗格)不给默认热键,只走命令面板(palette 角色)。
//     因此本 Keymap 的默认表里 **不** 绑定 SwapPane / MovePane —— 它们作为 ActionId
//     存在,供命令面板引用,但没有 KeyChord。
//
// 平台差异:WT 在 macOS 上把 Ctrl 换成 Cmd。为此引入「Primary」修饰键抽象——
//   Primary = Ctrl(Windows/Linux)/ Cmd(macOS)。Alt 保持字面 Alt(macOS 的 Option)。

#ifndef WTM_KEYMAP_KEYMAP_H
#define WTM_KEYMAP_KEYMAP_H

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wtm::keymap {

// ---- 动作 -------------------------------------------------------------------
// 一个动作 = 用户意图,与具体按键解耦。命令面板与热键表都引用这套 ID。
enum class ActionId {
    None = 0,

    // 拆分(高频热键):新窗格出现在哪一侧。
    SplitRight,        // WT: Alt+Shift++
    SplitDown,         // WT: Alt+Shift+-

    // 调整大小(高频热键):Alt+Shift+方向键。
    ResizeLeft,
    ResizeRight,
    ResizeUp,
    ResizeDown,

    // 切焦点(高频热键):Alt+方向键。
    FocusLeft,
    FocusRight,
    FocusUp,
    FocusDown,

    // 最大化 / 还原当前窗格(高频热键)。
    ToggleZoom,        // WT: Ctrl/Cmd+Shift+Enter(近似)

    // 关闭当前窗格(高频热键)。
    ClosePane,         // WT: Ctrl/Cmd+Shift+W

    // 呼出命令面板(高频热键)。
    ToggleCommandPalette,  // WT: Ctrl/Cmd+Shift+P

    // ---- 低频强力操作:仅命令面板触发,默认无热键 ----
    SwapPaneLeft,      // 与左侧相邻窗格交换
    SwapPaneRight,
    SwapPaneUp,
    SwapPaneDown,
    MovePaneLeft,      // 把当前窗格移动到某方向(Detach + Attach)
    MovePaneRight,
    MovePaneUp,
    MovePaneDown,
};

// 该动作是否「只允许命令面板触发」(不该出现在默认热键表里)。
bool IsPaletteOnly(ActionId id) noexcept;

// 动作的人类可读名(命令面板标题 & 调试)。英文,面向命令面板搜索。
const char* ActionTitle(ActionId id) noexcept;

// 动作归属的分类(命令面板分组:Pane / Focus / Resize / View)。
const char* ActionCategory(ActionId id) noexcept;

// ---- 修饰键 -----------------------------------------------------------------
// 位标志,可按位或。Primary 是平台抽象:解析时按平台落到 Ctrl 或 Cmd。
enum KeyModifier : std::uint8_t {
    ModNone    = 0,
    ModShift   = 1 << 0,
    ModAlt     = 1 << 1,   // macOS 的 Option
    ModPrimary = 1 << 2,   // Ctrl(Win/Linux)/ Cmd(macOS)
    ModCtrl    = 1 << 3,   // 字面 Ctrl(即使在 macOS 上也是 Control 键)
};

// ---- 按键码 -----------------------------------------------------------------
// 只列本方案默认键位用到的键,加少量常用键;需要时按注释扩充。
enum class KeyCode : std::uint16_t {
    Unknown = 0,

    // 字母(仅列默认表用到的;其余按需补)。
    P, W,

    // 符号:WT 拆分用 '+' / '-'。
    Plus,
    Minus,

    // 方向键。
    ArrowLeft,
    ArrowRight,
    ArrowUp,
    ArrowDown,

    // 其它常用。
    Enter,
    Escape,
    Tab,
    // TODO(keymap): 需要时补齐 A..Z / 数字 / F1..F12。
};

// ---- 按键组合 ---------------------------------------------------------------
struct KeyChord {
    std::uint8_t mods = ModNone;
    KeyCode key = KeyCode::Unknown;

    bool operator==(const KeyChord& o) const noexcept {
        return mods == o.mods && key == o.key;
    }
    bool operator!=(const KeyChord& o) const noexcept { return !(*this == o); }
};

// 当前编译目标是否 macOS(供修饰键解析 & 显示串使用)。
// 优先信任 CMake 注入的 WTM_PLATFORM_MACOS;否则回退到编译器宏。
bool IsMacPlatform() noexcept;

// 把 chord 渲染成给人看的短串,如 "Ctrl+Shift+P"(Win/Linux)/ "Cmd+Shift+P"
// (macOS)。命令面板右侧的快捷键提示用它。Primary 会按平台落成 Ctrl/Cmd。
std::string DescribeChord(const KeyChord& chord);

// ---- Keymap -----------------------------------------------------------------
// 小表,线性查找即可(键位数量级 < 50)。
class Keymap {
public:
    struct Binding {
        KeyChord chord;
        ActionId action = ActionId::None;
    };

    Keymap() = default;

    // 绑定一个热键。会拒绝 palette-only 动作(返回 false 且不写入),
    // 以保证「交换/移动只走命令面板」这条硬规则不被默认表破坏。
    bool Bind(const KeyChord& chord, ActionId action);

    // 查一个按键组合对应的动作;未命中返回 nullopt。
    std::optional<ActionId> Lookup(const KeyChord& chord) const;

    // 反查某动作绑定到的第一个 chord(命令面板拿去显示快捷键提示);
    // 无绑定(如 palette-only)返回 nullopt。
    std::optional<KeyChord> ChordFor(ActionId action) const;

    const std::vector<Binding>& Bindings() const noexcept { return bindings_; }

    // 生成 WT 默认键位表(macOS 上 Primary 自动落成 Cmd)。
    static Keymap DefaultKeymap();

private:
    std::vector<Binding> bindings_;
};

} // namespace wtm::keymap

#endif // WTM_KEYMAP_KEYMAP_H
