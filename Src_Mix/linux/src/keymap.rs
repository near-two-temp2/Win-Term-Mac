//! keymap —— 键位解析 + GTK4 事件控制器装配
//!
//! 定位:「cmd」角色的键位一半。它把物理按键(gdk `Key` + `ModifierType`)解析成
//! [`Command`],再挂一个 `GtkEventControllerKey` 到窗口上,把命中的命令派发出去
//! (拆分 / 切焦点 / 调整大小走 `command::execute`;打开面板走宿主给的回调)。
//!
//! 键位来源:linux/keymap.md(与 WT 一致,macOS 端把 Ctrl 换 Cmd)。
//! - 拆分:Alt+Shift++(右) / Alt+Shift+-(下)
//! - 切焦点:Alt+方向
//! - 调整大小:Alt+Shift+方向
//! - 命令面板:Ctrl+Shift+P
//! - 交换 / 移动:**无默认热键**(仅命令面板),故本表不解析它们。
//!
//! 与 RustInput 的协作:若 RustInput 已装了自己的按键控制器,可只用 [`resolve`]
//! 做“键 → 命令”查表,把派发交给它;否则用 [`install`] 一步到位。两者只挑一个用,
//! 避免重复抓键。
//!
//! ---------------------------------------------------------------------------
//! integrator 需要如何调用我(main.rs):
//!     let host: Rc<dyn command::PaneHost> = ...;
//!     let palette = palette::CommandPalette::new(&window, host.clone());
//!     keymap::install(&window, host.clone(), move || palette.present());
//! 说明:控制器装在窗口上并用 Capture 传播相位——只在命中我方快捷键时吞掉事件,
//! 其余按键继续下发给 VTE 终端(敲命令不受影响)。
//! ---------------------------------------------------------------------------

use std::rc::Rc;

use gtk4::gdk::{Key, ModifierType};
use gtk4::glib;
use gtk4::prelude::*;
use gtk4::{EventControllerKey, PropagationPhase, Widget};

use crate::command::{self, Command, PaneHost};

/// 只保留我们关心的修饰键位(过滤掉 CapsLock / NumLock / Mod2 等噪声)。
fn normalize(state: ModifierType) -> ModifierType {
    state
        & (ModifierType::CONTROL_MASK
            | ModifierType::ALT_MASK
            | ModifierType::SHIFT_MASK
            | ModifierType::SUPER_MASK)
}

/// 把 (按键, 修饰) 解析为命令。无匹配返回 None(事件应继续下发给终端)。
///
/// 这是纯函数,便于单测,也便于 RustInput 复用而不引入本模块的 GTK 装配。
pub fn resolve(key: Key, state: ModifierType) -> Option<Command> {
    let m = normalize(state);
    let ctrl = m.contains(ModifierType::CONTROL_MASK);
    let alt = m.contains(ModifierType::ALT_MASK);
    let shift = m.contains(ModifierType::SHIFT_MASK);

    // 命令面板:Ctrl+Shift+P(macOS 端由宿主把 Ctrl 换 Cmd/SUPER,可自行扩展)。
    if ctrl && shift && !alt && matches!(key, Key::P | Key::p) {
        return Some(Command::OpenPalette);
    }

    // Alt+Shift+…:拆分(+ / -)与调整大小(方向键)。
    if alt && shift && !ctrl {
        return match key {
            // '+' 常需 Shift,故一并接受主键盘 '=' 与小键盘 '+'。
            Key::plus | Key::equal | Key::KP_Add => Some(Command::SplitRight),
            // '-' 加 Shift 在多数布局出 '_',一并接受。
            Key::minus | Key::underscore | Key::KP_Subtract => Some(Command::SplitDown),
            Key::Left => Some(Command::ResizeLeft),
            Key::Right => Some(Command::ResizeRight),
            Key::Up => Some(Command::ResizeUp),
            Key::Down => Some(Command::ResizeDown),
            _ => None,
        };
    }

    // Alt+方向:切焦点。
    if alt && !shift && !ctrl {
        return match key {
            Key::Left => Some(Command::FocusLeft),
            Key::Right => Some(Command::FocusRight),
            Key::Up => Some(Command::FocusUp),
            Key::Down => Some(Command::FocusDown),
            _ => None,
        };
    }

    None
}

/// 在 `widget`(通常是主窗口)上装一个按键控制器,把命中的命令派发出去。
///
/// - `host`:窗格宿主,拆分 / 切焦点 / 调整大小经 `command::execute` 作用其上。
/// - `open_palette`:命中 Ctrl+Shift+P 时调用(由 integrator 传“弹面板”闭包)。
pub fn install(
    widget: &impl IsA<Widget>,
    host: Rc<dyn PaneHost>,
    open_palette: impl Fn() + 'static,
) {
    let controller = EventControllerKey::new();
    // Capture:先于子控件(VTE)拿到事件,只在命中我方快捷键时吞掉。
    controller.set_propagation_phase(PropagationPhase::Capture);
    controller.connect_key_pressed(move |_ctrl, key, _code, state| match resolve(key, state) {
        Some(Command::OpenPalette) => {
            open_palette();
            glib::Propagation::Stop
        }
        Some(cmd) => {
            command::execute(cmd, &*host);
            glib::Propagation::Stop
        }
        None => glib::Propagation::Proceed,
    });
    widget.add_controller(controller);
}

// ---------------------------------------------------------------------------
// 测试:纯查表逻辑,不依赖 GTK 运行时。
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    const ALT: ModifierType = ModifierType::ALT_MASK;
    const SHIFT: ModifierType = ModifierType::SHIFT_MASK;
    const CTRL: ModifierType = ModifierType::CONTROL_MASK;

    #[test]
    fn split_bindings() {
        assert_eq!(resolve(Key::plus, ALT | SHIFT), Some(Command::SplitRight));
        assert_eq!(resolve(Key::equal, ALT | SHIFT), Some(Command::SplitRight));
        assert_eq!(resolve(Key::minus, ALT | SHIFT), Some(Command::SplitDown));
    }

    #[test]
    fn focus_bindings_need_alt_only() {
        assert_eq!(resolve(Key::Left, ALT), Some(Command::FocusLeft));
        assert_eq!(resolve(Key::Down, ALT), Some(Command::FocusDown));
        // 加 Shift 变成调整大小,不再是切焦点。
        assert_eq!(resolve(Key::Left, ALT | SHIFT), Some(Command::ResizeLeft));
    }

    #[test]
    fn palette_binding() {
        assert_eq!(resolve(Key::P, CTRL | SHIFT), Some(Command::OpenPalette));
    }

    #[test]
    fn plain_keys_pass_through() {
        // 无修饰的普通键不应命中任何命令(留给终端)。
        assert_eq!(resolve(Key::Left, ModifierType::empty()), None);
        assert_eq!(resolve(Key::a, ModifierType::empty()), None);
        // 修饰噪声(如 NumLock=Mod2)应被 normalize 忽略。
        assert_eq!(
            resolve(Key::Left, ALT | ModifierType::MOD2_MASK),
            Some(Command::FocusLeft)
        );
    }

    #[test]
    fn swap_and_move_have_no_hotkey() {
        // 交换 / 移动是面板专用,任何键位都不该解析出它们。
        for st in [ALT, SHIFT, CTRL, ALT | SHIFT, CTRL | SHIFT] {
            for k in [Key::s, Key::m, Key::x] {
                let r = resolve(k, st);
                assert_ne!(r, Some(Command::SwapPane));
                assert_ne!(r, Some(Command::MovePane));
            }
        }
    }
}
