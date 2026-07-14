// Win-Term-Mac / Src_Rust —— 角色【Input】:键盘事件 -> PTY 字节流。
//
// 职责:
//   把 winit 的一次按键([`KeyEvent`] + [`ModifiersState`])翻译成“应当写入
//   聚焦终端 PTY 的字节序列”。也就是终端里 `stdin` 该收到什么。
//
// 与 keymap 的分工(重要):
//   - `keymap.rs` 负责【窗格操作热键】(拆分/切焦点/命令面板…),它把按键解析成
//     抽象 `Action`,由上层驱动窗格树 / 命令面板,**不产生写入终端的字节**。
//   - 本模块只负责【送进终端的输入】:可见字符、回车、退格、Tab、Esc、方向键、
//     Ctrl+字母控制码 等。
//
//   两者存在交集(例如 `Alt+方向键` 既是 WT 的 moveFocus 热键,又可被终端解释为
//   meta+方向键)。**优先级由 lead 在 main.rs 决定**:约定的调用顺序是——
//     1. 先用 keymap 解析:`keymap.resolve(chord)` 得到 `Some(Action)` 则消费按键,
//        本模块不再参与;
//     2. keymap 返回 `None`(不是热键)时,再调用本模块 [`key_to_bytes`],
//        把结果 `write_input` 给聚焦终端。
//   这样热键永远优先,剩下的才当作终端输入,不会冲突。
//
// 集成示例(供 lead 在 `WindowEvent::KeyboardInput` 分支参考):
// ```ignore
// WindowEvent::KeyboardInput { event, .. } => {
//     // 1) 先看是不是窗格热键(伪代码,chord 归一见 keymap::from_winit_stub)。
//     if let Some(action) = keymap.resolve(chord_from(&event, self.mods)) {
//         self.dispatch(action);
//         return;
//     }
//     // 2) 不是热键 -> 当作终端输入。
//     if let Some(bytes) = input::key_to_bytes(&event, self.mods) {
//         let _ = self.focused_terminal().write_input(&bytes);
//     }
// }
// ```

use winit::event::{ElementState, KeyEvent};
use winit::keyboard::{Key, ModifiersState, NamedKey};

/// 把一次 winit 按键翻译成要写入 PTY 的字节序列。
///
/// 返回:
///   - `Some(bytes)`:这次按键应向终端写入 `bytes`;
///   - `None`:这次按键不产生终端输入(松开事件、纯修饰键、无映射的功能键等)。
///
/// 约定:
///   - 只处理**按下**(`ElementState::Pressed`,含自动重复);松开返回 `None`。
///   - 调用前 lead 应已确认这**不是** keymap 热键(见文件头“与 keymap 的分工”)。
///
/// 覆盖范围:可见字符(含 shift/布局,走 `event.text`)、Enter=`\r`、
/// Backspace=`0x7f`、Tab=`\t`(Shift+Tab=`ESC [ Z`)、Esc=`0x1b`、
/// 方向键(CSI `ESC [ A/B/C/D`)、常用编辑/导航键(Home/End/PageUp/PageDown/
/// Delete/Insert)、Ctrl+字母 -> 控制码(如 Ctrl+C=`0x03`)、Alt 前缀(meta,
/// `ESC` + 字节)。
pub fn key_to_bytes(event: &KeyEvent, mods: ModifiersState) -> Option<Vec<u8>> {
    // 只在按下(含系统自动重复)时产生输入。
    if event.state != ElementState::Pressed {
        return None;
    }

    let ctrl = mods.control_key();
    let alt = mods.alt_key();
    let shift = mods.shift_key();
    // super/Cmd(Windows 键 / macOS Command)一律不视作终端输入前缀:
    // 它要么是窗口管理器 / 系统快捷键,要么是 keymap 的 Primary(mac)。
    let logo = mods.super_key();

    match &event.logical_key {
        // -------------------------------------------------------------------
        // 具名功能键。
        // -------------------------------------------------------------------
        Key::Named(named) => named_key_to_bytes(*named, ctrl, alt, shift, logo),

        // -------------------------------------------------------------------
        // 字符键(字母、数字、符号)。
        // -------------------------------------------------------------------
        Key::Character(s) => {
            // 带 super/Cmd 的组合交给系统 / keymap,不作为终端输入。
            if logo {
                return None;
            }

            // Ctrl+字符 -> 控制码(Ctrl+C=0x03、Ctrl+[=0x1b 等)。
            // 注意:此时若还按着 Alt,则在控制码前再加 ESC(meta)。
            if ctrl {
                if let Some(code) = ctrl_char_to_code(s) {
                    return Some(maybe_meta(alt, vec![code]));
                }
                // Ctrl 组合但没有对应控制码(如 Ctrl+方向键已在具名分支处理,
                // 这里多为 Ctrl+数字等)——不产生输入,交回上层。
                return None;
            }

            // 普通可见字符:优先用 winit 已按布局/Shift 组合好的 `text`,
            // 这样能正确得到大写字母、`@`/`#` 等 shift 符号、非 US 布局字符。
            let text = event
                .text
                .as_ref()
                .map(|t| t.as_str())
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| s.as_str());

            if text.is_empty() {
                return None;
            }
            Some(maybe_meta(alt, text.as_bytes().to_vec()))
        }

        // Dead(组合死键)/ Unidentified 等:winit 0.30 在部分键盘布局 / IME
        // 直出场景下,logical_key 不是 Character,但 `text` 仍带可打印字符。
        // 带 Ctrl/Super 的交回上层;否则只要有文本就照送,保证非常规布局也能录入。
        _ => {
            if ctrl || logo {
                return None;
            }
            let text = event
                .text
                .as_ref()
                .map(|t| t.as_str())
                .filter(|t| !t.is_empty())?;
            Some(maybe_meta(alt, text.as_bytes().to_vec()))
        }
    }
}

/// 具名键 -> 字节。`ctrl/alt/shift/logo` 为当前修饰键状态。
fn named_key_to_bytes(
    named: NamedKey,
    ctrl: bool,
    alt: bool,
    shift: bool,
    logo: bool,
) -> Option<Vec<u8>> {
    // 带 super/Cmd 的具名键交给系统 / keymap。
    if logo {
        return None;
    }

    match named {
        // 回车:发送 CR(0x0D)。多数 shell / 行编辑期望 `\r`;
        // 终端在需要时会自行做 CR->CRLF 转换。
        NamedKey::Enter => Some(maybe_meta(alt, vec![b'\r'])),

        // 退格:发送 DEL(0x7f),与主流终端默认(erase = ^?)一致。
        // Ctrl+Backspace 常用于“删词”,惯例发送 BS(0x08);此处照此实现。
        NamedKey::Backspace => {
            let b = if ctrl { 0x08 } else { 0x7f };
            Some(maybe_meta(alt, vec![b]))
        }

        // Tab / Shift+Tab。Shift+Tab 发送 CBT:`ESC [ Z`(反向制表)。
        NamedKey::Tab => {
            if shift {
                Some(b"\x1b[Z".to_vec())
            } else {
                Some(maybe_meta(alt, vec![b'\t']))
            }
        }

        // Esc:0x1b。
        NamedKey::Escape => Some(vec![0x1b]),

        // 空格:Ctrl+Space 惯例发送 NUL(0x00);否则普通空格。
        // (多数情况下 Space 会走字符分支的 `text`,这里作为兜底。)
        NamedKey::Space => {
            let b = if ctrl { 0x00 } else { b' ' };
            Some(maybe_meta(alt, vec![b]))
        }

        // 方向键:普通光标键模式(DECCKM 复位)下为 CSI `ESC [ A/B/C/D`。
        // TODO(app-cursor): 应用光标键模式(DECCKM 置位,如全屏程序)下应改用
        //   `ESC O A/B/C/D`。该模式状态在 term(alacritty)里,本函数当前拿不到;
        //   集成时可由 lead 传入模式标志,或改为查询聚焦 Terminal 后再决定。
        // TODO(modified-arrows): 带修饰的方向键(如 Ctrl+Left=`ESC [ 1;5D`)暂未细分,
        //   目前忽略修饰、发送基础 CSI。需要“按词移动”时再补 `ESC [ 1;<mod>X` 编码。
        NamedKey::ArrowUp => Some(b"\x1b[A".to_vec()),
        NamedKey::ArrowDown => Some(b"\x1b[B".to_vec()),
        NamedKey::ArrowRight => Some(b"\x1b[C".to_vec()),
        NamedKey::ArrowLeft => Some(b"\x1b[D".to_vec()),

        // 导航 / 编辑键。Home/End 用 CSI H/F;其余用 `ESC [ n ~` 形式。
        NamedKey::Home => Some(b"\x1b[H".to_vec()),
        NamedKey::End => Some(b"\x1b[F".to_vec()),
        NamedKey::Insert => Some(b"\x1b[2~".to_vec()),
        NamedKey::Delete => Some(b"\x1b[3~".to_vec()),
        NamedKey::PageUp => Some(b"\x1b[5~".to_vec()),
        NamedKey::PageDown => Some(b"\x1b[6~".to_vec()),

        // TODO(function-keys): F1..F12 的编码(F1=`ESC O P` … F5=`ESC [ 15~` …)
        //   较琐碎且带修饰变体,暂不实现;需要时在此补齐。
        _ => None,
    }
}

/// Ctrl+字符 -> 控制码。仅处理能产生控制码的键,其余返回 `None`。
///
/// 规则(与 xterm/VT 一致):
///   - 字母 a..z / A..Z -> 0x01..0x1a(Ctrl+A=1 … Ctrl+Z=26)
///   - `@` -> 0x00,`[` -> 0x1b,`\` -> 0x1c,`]` -> 0x1d,`^` -> 0x1e,`_` -> 0x1f
///   - 数字里常见的:`2`->0x00(=Ctrl+@),`3`->0x1b,`4`->0x1c,`5`->0x1d,
///     `6`->0x1e,`7`->0x1f,`8`->0x7f
fn ctrl_char_to_code(s: &str) -> Option<u8> {
    // 取组合的第一个字符(Ctrl 组合基本都是单字符)。
    let c = s.chars().next()?;
    match c {
        'a'..='z' => Some((c as u8) - b'a' + 1), // Ctrl+A=1 … Ctrl+Z=26
        'A'..='Z' => Some((c as u8) - b'A' + 1),
        '@' => Some(0x00),
        '[' => Some(0x1b),
        '\\' => Some(0x1c),
        ']' => Some(0x1d),
        '^' => Some(0x1e),
        '_' => Some(0x1f),
        ' ' => Some(0x00),
        '2' => Some(0x00),
        '3' => Some(0x1b),
        '4' => Some(0x1c),
        '5' => Some(0x1d),
        '6' => Some(0x1e),
        '7' => Some(0x1f),
        '8' => Some(0x7f),
        _ => None,
    }
}

/// Alt(meta)修饰:xterm 惯例是在字节序列前加一个 ESC(0x1b)。
/// `alt == false` 时原样返回。
fn maybe_meta(alt: bool, mut bytes: Vec<u8>) -> Vec<u8> {
    if alt {
        let mut out = Vec::with_capacity(bytes.len() + 1);
        out.push(0x1b);
        out.append(&mut bytes);
        out
    } else {
        bytes
    }
}

// ======================================================================
// 测试:只覆盖不依赖 winit 事件构造的纯逻辑(控制码 / meta 前缀)。
// key_to_bytes 需要真实 KeyEvent(winit 未导出便捷构造器),留待集成期人工验证。
// ======================================================================
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ctrl_letters_map_to_control_codes() {
        assert_eq!(ctrl_char_to_code("c"), Some(0x03)); // Ctrl+C
        assert_eq!(ctrl_char_to_code("C"), Some(0x03)); // 大小写等价
        assert_eq!(ctrl_char_to_code("a"), Some(0x01));
        assert_eq!(ctrl_char_to_code("z"), Some(0x1a));
        assert_eq!(ctrl_char_to_code("d"), Some(0x04)); // Ctrl+D = EOF
    }

    #[test]
    fn ctrl_symbols_map_to_control_codes() {
        assert_eq!(ctrl_char_to_code("["), Some(0x1b)); // Ctrl+[ = Esc
        assert_eq!(ctrl_char_to_code("@"), Some(0x00));
        assert_eq!(ctrl_char_to_code("\\"), Some(0x1c));
        assert_eq!(ctrl_char_to_code("_"), Some(0x1f));
    }

    #[test]
    fn ctrl_unmapped_returns_none() {
        assert_eq!(ctrl_char_to_code("`"), None);
        assert_eq!(ctrl_char_to_code(""), None);
    }

    #[test]
    fn meta_prefixes_escape() {
        assert_eq!(maybe_meta(true, vec![b'x']), vec![0x1b, b'x']);
        assert_eq!(maybe_meta(false, vec![b'x']), vec![b'x']);
        assert_eq!(maybe_meta(true, vec![b'\r']), vec![0x1b, b'\r']);
    }
}
