//! 键位映射(照搬 Windows Terminal 默认键位)。
//!
//! 本模块把「一次按键」翻译成一个抽象**动作** [`Action`],再由上层分发到
//! 窗格树(`pane`)或命令面板(`palette`)。这里只做纯粹的**逻辑映射**:
//! 不接触 winit 事件、不接触渲染。
//!
//! ## Windows Terminal 默认键位(据此实现)
//! - 命令面板:`Ctrl+Shift+P`(macOS 上 `Cmd+Shift+P`)。
//! - 右侧拆分:`Alt+Shift++`;下方拆分:`Alt+Shift+-`。
//! - 调整大小:`Alt+Shift+方向键`。
//! - 切换焦点:`Alt+方向键`。
//! - 交换窗格 `swapPane`:**默认无热键**,只通过命令面板触发。
//!
//! ## 平台差异
//! WT 在 macOS 上把 **Ctrl 换成 Cmd**(命令面板走 `Cmd+Shift+P`)。而基于
//! `Alt`(macOS 的 Option)的拆分/焦点/调整键在各平台保持一致。为此本模块引入
//! 一个抽象修饰键 [`Mod::Primary`]:Windows/Linux 上解析为 Ctrl,macOS 上解析为
//! Cmd。`Alt` 则直接用 [`Mod::Alt`],跨平台不变。

use crate::pane::{Direction, SplitDir};

// ======================================================================
// 平台
// ======================================================================

/// 运行平台。用于决定 [`Mod::Primary`] 到底是 Ctrl 还是 Cmd。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    /// Windows / Linux:主修饰键 = Ctrl。
    PcLike,
    /// macOS:主修饰键 = Cmd。
    Mac,
}

impl Platform {
    /// 探测当前编译目标平台。
    #[inline]
    pub fn current() -> Platform {
        if cfg!(target_os = "macos") {
            Platform::Mac
        } else {
            Platform::PcLike
        }
    }
}

// ======================================================================
// 修饰键与逻辑按键
// ======================================================================

/// 逻辑修饰键。`Primary` 会按平台落到 Ctrl(PC)或 Cmd(Mac)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mod {
    /// 主修饰键:Windows/Linux=Ctrl,macOS=Cmd。
    Primary,
    Shift,
    Alt,
}

/// 修饰键集合(小集合,直接用三个布尔位;顺序无关)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Mods {
    pub primary: bool,
    pub shift: bool,
    pub alt: bool,
}

impl Mods {
    pub const NONE: Mods = Mods {
        primary: false,
        shift: false,
        alt: false,
    };

    /// 从一组 [`Mod`] 构造修饰集合。
    pub fn of(mods: &[Mod]) -> Mods {
        let mut m = Mods::NONE;
        for x in mods {
            match x {
                Mod::Primary => m.primary = true,
                Mod::Shift => m.shift = true,
                Mod::Alt => m.alt = true,
            }
        }
        m
    }
}

/// 逻辑按键(与物理布局/winit 类型解耦)。
///
/// 整合阶段由上层把 `winit::keyboard::Key` 归一到这里(见 [`from_winit_stub`])。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Left,
    Right,
    Up,
    Down,
    /// 可打印字符键,统一按小写字母/符号存储(如 `'p'`、`'+'`、`'-'`)。
    Char(char),
}

/// 一次按键组合:修饰集合 + 主键。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyChord {
    pub mods: Mods,
    pub key: Key,
}

impl KeyChord {
    pub fn new(mods: &[Mod], key: Key) -> KeyChord {
        KeyChord {
            mods: Mods::of(mods),
            key,
        }
    }

    /// 生成可读文本(用于命令面板右侧显示热键提示)。
    /// `platform` 决定 Primary 显示成 `Ctrl` 还是 `Cmd`。
    pub fn display(&self, platform: Platform) -> String {
        let mut parts: Vec<String> = Vec::new();
        if self.mods.primary {
            parts.push(match platform {
                Platform::Mac => "Cmd".into(),
                Platform::PcLike => "Ctrl".into(),
            });
        }
        // 与 WT 文档一致的书写顺序:Primary, Alt, Shift, Key。
        if self.mods.alt {
            parts.push(match platform {
                Platform::Mac => "Option".into(),
                Platform::PcLike => "Alt".into(),
            });
        }
        if self.mods.shift {
            parts.push("Shift".into());
        }
        parts.push(match self.key {
            Key::Left => "Left".into(),
            Key::Right => "Right".into(),
            Key::Up => "Up".into(),
            Key::Down => "Down".into(),
            Key::Char(c) => c.to_uppercase().to_string(),
        });
        parts.join("+")
    }
}

// ======================================================================
// 动作
// ======================================================================

/// 抽象动作:键位与命令面板共同的输出。上层据此驱动 `pane` / `palette`。
///
/// 注意:`SwapPane` / `MovePane` 属于**低频强力操作**,WT 默认不给热键,
/// 只在命令面板里出现(见 `palette` 模块的 `Trigger::PaletteOnly`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// 拆分当前窗格。`Vertical`=右侧新窗格,`Horizontal`=下方新窗格。
    SplitPane { dir: SplitDir },
    /// 沿方向切换焦点(WT `moveFocus`)。
    MoveFocus { dir: Direction },
    /// 沿方向调整当前窗格大小(WT `resizePane`)。
    ResizePane { dir: Direction },
    /// 与相邻窗格交换位置(WT `swapPane`,仅命令面板触发)。
    SwapPane { dir: Direction },
    /// 把当前窗格移动到相邻位置(拖拽移动的键盘等价物,仅命令面板触发)。
    MovePane { dir: Direction },
    /// 最大化 / 还原当前窗格(WT `togglePaneZoom`)。
    TogglePaneZoom,
    /// 关闭当前窗格。
    ClosePane,
    /// 打开 / 关闭命令面板。
    ToggleCommandPalette,
}

// ======================================================================
// 默认键位表
// ======================================================================

/// 一条默认键位绑定:按键组合 -> 动作。
#[derive(Debug, Clone, Copy)]
pub struct Binding {
    pub chord: KeyChord,
    pub action: Action,
}

/// Windows Terminal 默认键位表。`Alt` 类绑定跨平台一致;`Primary` 类绑定
/// 会在 [`Keymap::resolve`] 时按平台解释为 Ctrl / Cmd。
pub fn default_bindings() -> Vec<Binding> {
    use Direction::*;
    use Key::*;
    use Mod::*;

    let b = |mods: &[Mod], key: Key, action: Action| Binding {
        chord: KeyChord::new(mods, key),
        action,
    };

    vec![
        // 命令面板:Ctrl+Shift+P(macOS: Cmd+Shift+P)。
        b(
            &[Primary, Shift],
            Char('p'),
            Action::ToggleCommandPalette,
        ),
        // 拆分:右侧 Alt+Shift++,下方 Alt+Shift+-。
        b(
            &[Alt, Shift],
            Char('+'),
            Action::SplitPane {
                dir: SplitDir::Vertical,
            },
        ),
        b(
            &[Alt, Shift],
            Char('-'),
            Action::SplitPane {
                dir: SplitDir::Horizontal,
            },
        ),
        // 切换焦点:Alt+方向键。
        b(&[Alt], Left, Action::MoveFocus { dir: Left }),
        b(&[Alt], Right, Action::MoveFocus { dir: Right }),
        b(&[Alt], Up, Action::MoveFocus { dir: Up }),
        b(&[Alt], Down, Action::MoveFocus { dir: Down }),
        // 调整大小:Alt+Shift+方向键。
        b(&[Alt, Shift], Left, Action::ResizePane { dir: Left }),
        b(&[Alt, Shift], Right, Action::ResizePane { dir: Right }),
        b(&[Alt, Shift], Up, Action::ResizePane { dir: Up }),
        b(&[Alt, Shift], Down, Action::ResizePane { dir: Down }),
        // 最大化 / 还原当前窗格。
        b(&[Primary, Shift], Char('z'), Action::TogglePaneZoom),
        // 关闭窗格:Ctrl+Shift+W(macOS: Cmd+Shift+W)。
        b(&[Primary, Shift], Char('w'), Action::ClosePane),
        // 注意:swapPane / movePane 默认无热键,只在命令面板出现。
    ]
}

/// 编译后的键位表:用于 O(n) 线性查找(表很小,无需哈希)。
///
/// 之所以不直接用 `HashMap<KeyChord, Action>`,是因为要在 `resolve` 时
/// 结合 `platform` 把逻辑修饰键落到具体物理键——保留原始 [`Binding`] 更直观。
pub struct Keymap {
    platform: Platform,
    bindings: Vec<Binding>,
}

impl Keymap {
    /// 用 WT 默认键位构造。
    pub fn wt_default(platform: Platform) -> Keymap {
        Keymap {
            platform,
            bindings: default_bindings(),
        }
    }

    /// 当前平台。
    #[inline]
    pub fn platform(&self) -> Platform {
        self.platform
    }

    /// 只读访问全部绑定(命令面板用它来给命令补上热键提示)。
    pub fn bindings(&self) -> &[Binding] {
        &self.bindings
    }

    /// 把一次按键解析成动作。找不到匹配返回 `None`(交回上层,例如把
    /// 普通字符透传给聚焦终端)。
    ///
    /// 由于 `Mod::Primary` 在存表时已是逻辑意义,这里直接按 [`Mods`] 比较即可:
    /// 上层在构造入参 `chord` 时,应已把物理 Ctrl(PC)/ Cmd(Mac)归一到
    /// `mods.primary`(见 [`from_winit_stub`])。
    pub fn resolve(&self, chord: KeyChord) -> Option<Action> {
        self.bindings
            .iter()
            .find(|bind| bind.chord == chord)
            .map(|bind| bind.action)
    }
}

// ======================================================================
// winit 归一化(整合桩)
// ======================================================================

/// TODO(integration): 把 winit 的键盘事件归一到本模块的 [`KeyChord`]。
///
/// 整合时需要在 `main.rs` 的 `WindowEvent::KeyboardInput` 分支里:
/// 1. 读取 `winit::event::Modifiers`(Ctrl/Cmd/Shift/Alt);
/// 2. 按 [`Platform`] 把物理主修饰键(PC 的 Ctrl 或 Mac 的 Cmd/SUPER)
///    折叠进 [`Mods::primary`];
/// 3. 把 `winit::keyboard::Key`(方向键 / 字符)映射到 [`Key`];
/// 4. 组装 [`KeyChord`] 后调 [`Keymap::resolve`]。
///
/// 这里仅给出签名占位,返回 `None`,避免在渲染/输入尚未接线时误触发动作。
#[allow(unused_variables)]
pub fn from_winit_stub(/* modifiers, logical_key */) -> Option<KeyChord> {
    // TODO(integration): 见上文步骤;当前恒返回 None。
    None
}

// ======================================================================
// 测试
// ======================================================================
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_palette_uses_primary_shift_p() {
        let km = Keymap::wt_default(Platform::PcLike);
        let chord = KeyChord::new(&[Mod::Primary, Mod::Shift], Key::Char('p'));
        assert_eq!(km.resolve(chord), Some(Action::ToggleCommandPalette));
    }

    #[test]
    fn split_right_and_down() {
        let km = Keymap::wt_default(Platform::Mac);
        let right = KeyChord::new(&[Mod::Alt, Mod::Shift], Key::Char('+'));
        let down = KeyChord::new(&[Mod::Alt, Mod::Shift], Key::Char('-'));
        assert_eq!(
            km.resolve(right),
            Some(Action::SplitPane {
                dir: SplitDir::Vertical
            })
        );
        assert_eq!(
            km.resolve(down),
            Some(Action::SplitPane {
                dir: SplitDir::Horizontal
            })
        );
    }

    #[test]
    fn alt_arrows_move_focus() {
        let km = Keymap::wt_default(Platform::PcLike);
        let chord = KeyChord::new(&[Mod::Alt], Key::Left);
        assert_eq!(
            km.resolve(chord),
            Some(Action::MoveFocus {
                dir: Direction::Left
            })
        );
    }

    #[test]
    fn alt_shift_arrows_resize() {
        let km = Keymap::wt_default(Platform::PcLike);
        let chord = KeyChord::new(&[Mod::Alt, Mod::Shift], Key::Up);
        assert_eq!(
            km.resolve(chord),
            Some(Action::ResizePane {
                dir: Direction::Up
            })
        );
    }

    #[test]
    fn swap_and_move_have_no_default_hotkey() {
        let km = Keymap::wt_default(Platform::PcLike);
        // 全表中不应出现 SwapPane / MovePane(它们只走命令面板)。
        for bind in km.bindings() {
            assert!(!matches!(bind.action, Action::SwapPane { .. }));
            assert!(!matches!(bind.action, Action::MovePane { .. }));
        }
    }

    #[test]
    fn display_reflects_platform_primary() {
        let chord = KeyChord::new(&[Mod::Primary, Mod::Shift], Key::Char('p'));
        assert_eq!(chord.display(Platform::PcLike), "Ctrl+Shift+P");
        assert_eq!(chord.display(Platform::Mac), "Cmd+Shift+P");
    }

    #[test]
    fn unmapped_chord_returns_none() {
        let km = Keymap::wt_default(Platform::PcLike);
        let chord = KeyChord::new(&[], Key::Char('a'));
        assert_eq!(km.resolve(chord), None);
    }
}
