//! 命令面板(照搬 Windows Terminal 的 Command Palette)。
//!
//! 一个可搜索的命令列表:用户按 `Ctrl/Cmd+Shift+P` 打开,输入关键字做模糊
//! 过滤,回车执行选中项。设计哲学与 WT 一致——**高频操作给热键,低频强力
//! 操作(交换/移动窗格)收进这里**。
//!
//! 本模块只负责命令面板的**纯逻辑**:命令清单、模糊过滤、选中态、回车产出
//! 一个 [`Action`]。不接触渲染(覆盖层绘制)与输入事件解析——那些由上层组合。
//!
//! ## 触发来源
//! 每条命令带一个 [`Trigger`] 标注它「本来」是否有热键:
//! - `Hotkey(chord)`:同时也能通过键位触发(面板里顺带显示提示)。
//! - `PaletteOnly`:**仅命令面板触发**。`swapPane` 与 `movePane` 属于此类
//!   ——WT 默认不给它们热键。

use crate::keymap::{Key, KeyChord, Mod, Platform};
use crate::pane::{Direction, SplitDir};

// 复用 keymap 里的抽象动作,保持键位与面板输出同构。
pub use crate::keymap::Action;

/// 命令的触发来源标注。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// 也可用热键触发;面板里显示这个组合作为提示。
    Hotkey(KeyChord),
    /// 仅命令面板触发(WT 里如 `swapPane` / `movePane`)。
    PaletteOnly,
}

/// 一条命令项。
#[derive(Debug, Clone)]
pub struct Command {
    /// 稳定标识(便于测试与遥测,不参与展示)。
    pub id: &'static str,
    /// 展示标题(命令面板列表主文本)。
    pub title: &'static str,
    /// 回车后产出的动作。
    pub action: Action,
    /// 触发来源标注。
    pub trigger: Trigger,
}

impl Command {
    /// 该命令是否为「仅面板触发」。
    #[inline]
    pub fn is_palette_only(&self) -> bool {
        matches!(self.trigger, Trigger::PaletteOnly)
    }

    /// 生成右侧热键提示(仅 `Hotkey` 有);`platform` 决定 Ctrl/Cmd 字样。
    pub fn hotkey_hint(&self, platform: Platform) -> Option<String> {
        match self.trigger {
            Trigger::Hotkey(chord) => Some(chord.display(platform)),
            Trigger::PaletteOnly => None,
        }
    }
}

/// 默认命令清单(WT 默认命令的子集,聚焦窗格操作)。
pub fn default_commands() -> Vec<Command> {
    use Direction::*;

    // 小工具:构造带热键提示的命令(热键与 keymap 默认表保持一致)。
    let hot = |mods: &[Mod], key: Key| Trigger::Hotkey(KeyChord::new(mods, key));

    vec![
        // ---- 拆分:有热键 ----
        Command {
            id: "splitPane.right",
            title: "Split pane: Right",
            action: Action::SplitPane {
                dir: SplitDir::Vertical,
            },
            trigger: hot(&[Mod::Alt, Mod::Shift], Key::Char('+')),
        },
        Command {
            id: "splitPane.down",
            title: "Split pane: Down",
            action: Action::SplitPane {
                dir: SplitDir::Horizontal,
            },
            trigger: hot(&[Mod::Alt, Mod::Shift], Key::Char('-')),
        },
        // ---- 交换窗格 swapPane:仅面板触发 ----
        Command {
            id: "swapPane.left",
            title: "Swap pane: Left",
            action: Action::SwapPane { dir: Left },
            trigger: Trigger::PaletteOnly,
        },
        Command {
            id: "swapPane.right",
            title: "Swap pane: Right",
            action: Action::SwapPane { dir: Right },
            trigger: Trigger::PaletteOnly,
        },
        Command {
            id: "swapPane.up",
            title: "Swap pane: Up",
            action: Action::SwapPane { dir: Up },
            trigger: Trigger::PaletteOnly,
        },
        Command {
            id: "swapPane.down",
            title: "Swap pane: Down",
            action: Action::SwapPane { dir: Down },
            trigger: Trigger::PaletteOnly,
        },
        // ---- 移动窗格 movePane:仅面板触发 ----
        Command {
            id: "movePane.left",
            title: "Move pane: Left",
            action: Action::MovePane { dir: Left },
            trigger: Trigger::PaletteOnly,
        },
        Command {
            id: "movePane.right",
            title: "Move pane: Right",
            action: Action::MovePane { dir: Right },
            trigger: Trigger::PaletteOnly,
        },
        Command {
            id: "movePane.up",
            title: "Move pane: Up",
            action: Action::MovePane { dir: Up },
            trigger: Trigger::PaletteOnly,
        },
        Command {
            id: "movePane.down",
            title: "Move pane: Down",
            action: Action::MovePane { dir: Down },
            trigger: Trigger::PaletteOnly,
        },
        // ---- 切换焦点 moveFocus:有热键 ----
        Command {
            id: "moveFocus.left",
            title: "Move focus: Left",
            action: Action::MoveFocus { dir: Left },
            trigger: hot(&[Mod::Alt], Key::Left),
        },
        Command {
            id: "moveFocus.right",
            title: "Move focus: Right",
            action: Action::MoveFocus { dir: Right },
            trigger: hot(&[Mod::Alt], Key::Right),
        },
        Command {
            id: "moveFocus.up",
            title: "Move focus: Up",
            action: Action::MoveFocus { dir: Up },
            trigger: hot(&[Mod::Alt], Key::Up),
        },
        Command {
            id: "moveFocus.down",
            title: "Move focus: Down",
            action: Action::MoveFocus { dir: Down },
            trigger: hot(&[Mod::Alt], Key::Down),
        },
        // ---- 调整大小 resizePane:有热键 ----
        Command {
            id: "resizePane.left",
            title: "Resize pane: Left",
            action: Action::ResizePane { dir: Left },
            trigger: hot(&[Mod::Alt, Mod::Shift], Key::Left),
        },
        Command {
            id: "resizePane.right",
            title: "Resize pane: Right",
            action: Action::ResizePane { dir: Right },
            trigger: hot(&[Mod::Alt, Mod::Shift], Key::Right),
        },
        Command {
            id: "resizePane.up",
            title: "Resize pane: Up",
            action: Action::ResizePane { dir: Up },
            trigger: hot(&[Mod::Alt, Mod::Shift], Key::Up),
        },
        Command {
            id: "resizePane.down",
            title: "Resize pane: Down",
            action: Action::ResizePane { dir: Down },
            trigger: hot(&[Mod::Alt, Mod::Shift], Key::Down),
        },
        // ---- 其他窗格操作 ----
        Command {
            id: "togglePaneZoom",
            title: "Toggle pane zoom (maximize / restore)",
            action: Action::TogglePaneZoom,
            trigger: hot(&[Mod::Primary, Mod::Shift], Key::Char('z')),
        },
        Command {
            id: "closePane",
            title: "Close pane",
            action: Action::ClosePane,
            trigger: hot(&[Mod::Primary, Mod::Shift], Key::Char('w')),
        },
    ]
}

/// 一次过滤后的命中项:命令在原清单中的下标 + 排序分。
#[derive(Debug, Clone, Copy, PartialEq)]
struct Hit {
    index: usize,
    score: i32,
}

/// 命令面板运行态(纯逻辑,可被上层的渲染/输入层驱动)。
pub struct CommandPalette {
    /// 全部命令(顺序即默认展示顺序)。
    commands: Vec<Command>,
    /// 是否可见(打开状态)。
    visible: bool,
    /// 当前查询串(小写归一后存储)。
    query: String,
    /// 过滤后的命中列表(对 `commands` 的下标 + 分数),已按分数降序。
    filtered: Vec<Hit>,
    /// 当前选中项在 `filtered` 中的位置。
    selected: usize,
}

impl Default for CommandPalette {
    fn default() -> Self {
        CommandPalette::new(default_commands())
    }
}

impl CommandPalette {
    /// 用给定命令清单构造(关闭状态)。
    pub fn new(commands: Vec<Command>) -> CommandPalette {
        let mut p = CommandPalette {
            commands,
            visible: false,
            query: String::new(),
            filtered: Vec::new(),
            selected: 0,
        };
        p.recompute();
        p
    }

    // ------------------------------------------------------------------
    // 开关
    // ------------------------------------------------------------------

    /// 是否处于打开状态。
    #[inline]
    pub fn is_visible(&self) -> bool {
        self.visible
    }

    /// 打开面板:清空查询、重置选中、显示全部命令。
    pub fn open(&mut self) {
        self.visible = true;
        self.query.clear();
        self.recompute();
    }

    /// 关闭面板(不产出动作)。
    pub fn close(&mut self) {
        self.visible = false;
    }

    /// 响应 `ToggleCommandPalette`:开则关、关则开。
    pub fn toggle(&mut self) {
        if self.visible {
            self.close();
        } else {
            self.open();
        }
    }

    // ------------------------------------------------------------------
    // 查询与选中
    // ------------------------------------------------------------------

    /// 当前查询串。
    #[inline]
    pub fn query(&self) -> &str {
        &self.query
    }

    /// 设置查询串并重算过滤结果(选中回到首项)。
    pub fn set_query(&mut self, q: &str) {
        self.query = q.to_lowercase();
        self.recompute();
    }

    /// 在查询串尾追加一个字符(供输入层逐字驱动)。
    pub fn push_char(&mut self, c: char) {
        for lc in c.to_lowercase() {
            self.query.push(lc);
        }
        self.recompute();
    }

    /// 删除查询串尾字符(Backspace)。
    pub fn pop_char(&mut self) {
        self.query.pop();
        self.recompute();
    }

    /// 选中项下移一格(到底则停在末项)。
    pub fn select_next(&mut self) {
        if self.filtered.is_empty() {
            return;
        }
        if self.selected + 1 < self.filtered.len() {
            self.selected += 1;
        }
    }

    /// 选中项上移一格(到顶则停在首项)。
    pub fn select_prev(&mut self) {
        self.selected = self.selected.saturating_sub(1);
    }

    /// 当前过滤后的命中命令(按分数降序,用于渲染列表)。
    pub fn visible_commands(&self) -> Vec<&Command> {
        self.filtered
            .iter()
            .map(|hit| &self.commands[hit.index])
            .collect()
    }

    /// 当前选中的命令(过滤结果为空时为 `None`)。
    pub fn selected_command(&self) -> Option<&Command> {
        self.filtered
            .get(self.selected)
            .map(|hit| &self.commands[hit.index])
    }

    /// 当前选中项在过滤列表中的位置(供渲染高亮)。
    #[inline]
    pub fn selected_index(&self) -> usize {
        self.selected
    }

    /// 回车执行:取出选中命令的动作并关闭面板。无命中返回 `None`。
    pub fn accept(&mut self) -> Option<Action> {
        let action = self.selected_command().map(|c| c.action);
        if action.is_some() {
            self.close();
        }
        action
    }

    // ------------------------------------------------------------------
    // 内部:过滤
    // ------------------------------------------------------------------

    /// 依据当前 `query` 重算 `filtered` 与 `selected`。
    fn recompute(&mut self) {
        self.filtered.clear();
        if self.query.is_empty() {
            // 空查询:显示全部,保持默认顺序(分数置 0)。
            for i in 0..self.commands.len() {
                self.filtered.push(Hit { index: i, score: 0 });
            }
        } else {
            for (i, cmd) in self.commands.iter().enumerate() {
                if let Some(score) = fuzzy_score(&cmd.title.to_lowercase(), &self.query) {
                    self.filtered.push(Hit { index: i, score });
                }
            }
            // 分数降序;同分保持原始顺序(稳定排序)。
            self.filtered.sort_by(|a, b| {
                b.score.cmp(&a.score).then(a.index.cmp(&b.index))
            });
        }
        self.selected = 0;
    }
}

/// 子序列模糊匹配打分:`query` 的每个字符需按序出现在 `text` 里。
///
/// 命中返回 `Some(score)`(分数越大越好),否则 `None`。评分启发式:
/// - 连续匹配加权(相邻命中额外加分);
/// - 词首/分隔后命中额外加分(贴合「按首字母缩写搜」的直觉);
/// - 总长越短的标题相对更优(轻微偏置)。
///
/// 入参 `text` 与 `query` 都应已小写归一。
fn fuzzy_score(text: &str, query: &str) -> Option<i32> {
    if query.is_empty() {
        return Some(0);
    }
    let text: Vec<char> = text.chars().collect();
    let query: Vec<char> = query.chars().collect();

    let mut ti = 0usize;
    let mut qi = 0usize;
    let mut score = 0i32;
    let mut prev_matched = false;
    let mut prev_char: Option<char> = None;

    while ti < text.len() && qi < query.len() {
        let tc = text[ti];
        if tc == query[qi] {
            score += 1;
            if prev_matched {
                score += 3; // 连续命中奖励
            }
            let at_word_start =
                prev_char.map_or(true, |p| p == ' ' || p == ':' || p == '-' || p == '.');
            if at_word_start {
                score += 5; // 词首命中奖励
            }
            qi += 1;
            prev_matched = true;
        } else {
            prev_matched = false;
        }
        prev_char = Some(tc);
        ti += 1;
    }

    if qi == query.len() {
        // 短标题轻微加分,让更精炼的命中排前。
        Some(score - (text.len() as i32) / 32)
    } else {
        None
    }
}

// ======================================================================
// 测试
// ======================================================================
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swap_and_move_are_palette_only() {
        for cmd in default_commands() {
            if cmd.id.starts_with("swapPane") || cmd.id.starts_with("movePane") {
                assert!(
                    cmd.is_palette_only(),
                    "{} 应为仅面板触发",
                    cmd.id
                );
                assert!(cmd.hotkey_hint(Platform::PcLike).is_none());
            }
        }
    }

    #[test]
    fn split_commands_expose_hotkey_hint() {
        let cmds = default_commands();
        let right = cmds.iter().find(|c| c.id == "splitPane.right").unwrap();
        assert_eq!(right.hotkey_hint(Platform::PcLike).as_deref(), Some("Alt+Shift++"));
    }

    #[test]
    fn open_shows_all_commands() {
        let mut p = CommandPalette::default();
        assert!(!p.is_visible());
        p.open();
        assert!(p.is_visible());
        assert_eq!(p.visible_commands().len(), default_commands().len());
    }

    #[test]
    fn query_filters_and_ranks() {
        let mut p = CommandPalette::default();
        p.open();
        p.set_query("swap");
        let vis = p.visible_commands();
        assert!(!vis.is_empty());
        // 过滤后应全部是 swapPane 命令。
        assert!(vis.iter().all(|c| c.id.starts_with("swapPane")));
    }

    #[test]
    fn accept_returns_action_and_closes() {
        let mut p = CommandPalette::default();
        p.open();
        p.set_query("swap pane: left");
        let action = p.accept();
        assert_eq!(
            action,
            Some(Action::SwapPane {
                dir: Direction::Left
            })
        );
        assert!(!p.is_visible());
    }

    #[test]
    fn selection_moves_within_bounds() {
        let mut p = CommandPalette::default();
        p.open();
        // 空查询下有多条命令。
        assert!(p.visible_commands().len() > 1);
        assert_eq!(p.selected_index(), 0);
        p.select_prev(); // 已在顶,保持 0
        assert_eq!(p.selected_index(), 0);
        p.select_next();
        assert_eq!(p.selected_index(), 1);
    }

    #[test]
    fn empty_query_keeps_default_order() {
        let mut p = CommandPalette::default();
        p.open();
        let vis = p.visible_commands();
        assert_eq!(vis[0].id, default_commands()[0].id);
    }

    #[test]
    fn no_match_yields_empty_and_none_accept() {
        let mut p = CommandPalette::default();
        p.open();
        p.set_query("zzznotacommand");
        assert!(p.visible_commands().is_empty());
        assert_eq!(p.accept(), None);
        // accept 无命中不应关闭面板。
        assert!(p.is_visible());
    }

    #[test]
    fn push_and_pop_char_drive_query() {
        let mut p = CommandPalette::default();
        p.open();
        p.push_char('S');
        p.push_char('w');
        assert_eq!(p.query(), "sw");
        p.pop_char();
        assert_eq!(p.query(), "s");
    }
}
