//! palette —— 可搜索命令面板(GTK4 Popover + 过滤列表)
//!
//! 定位:「cmd」角色的面板一半,复刻 WT 的命令面板(Ctrl+Shift+P)。
//! 一个可搜索的弹出层:顶部 `GtkSearchEntry`,下面一个随输入过滤的 `GtkListBox`。
//! 高频动作(拆分 / 切焦点 / 调整大小)也能在这里搜到并执行;**交换 / 移动窗格
//! 只在这里触发**(无默认热键)——选中它们后面板切到第二步“选目标窗格”。
//!
//! 所有动作最终都汇入 `command` 模块的派发函数,真正作用到内核窗格树与视图。
//!
//! ---------------------------------------------------------------------------
//! integrator 需要如何调用我(main.rs):
//!     let host: Rc<dyn command::PaneHost> = ...;
//!     let palette = palette::CommandPalette::new(&window, host.clone());
//!     // 交给 keymap 的“打开面板”回调:
//!     keymap::install(&window, host.clone(), move || palette.present());
//! 说明:CommandPalette 内部是 `Rc`,`present()` 每次弹出都会重置到第一步并清空搜索框。
//! ---------------------------------------------------------------------------

use std::cell::RefCell;
use std::rc::Rc;

use gtk4::prelude::*;
use gtk4::{
    Align, Box as GtkBox, Label, ListBox, ListBoxRow, Orientation, PolicyType, Popover,
    PositionType, ScrolledWindow, SearchEntry, SelectionMode,
};

use crate::command::{self, Command, PaneHost};
use crate::ffi::{WtmDirection, WtmPaneId};

/// 面板当前处于哪一步。
#[derive(Clone, Copy)]
enum Phase {
    /// 第一步:列出全部命令。
    Commands,
    /// 第二步:已选中需要目标的命令(swap / move),正在选目标窗格。
    PickTarget(Command),
}

/// 列表某一行被激活时要做的事。与当前可见行一一对应(Copy 便于取用)。
#[derive(Clone, Copy)]
enum RowAction {
    /// 立即执行(拆分 / 切焦点 / 调整大小)。
    Run(Command),
    /// 进入“选目标”第二步(swap / move)。
    BeginTarget(Command),
    /// 已选好目标,执行带目标的命令。
    WithTarget(Command, WtmPaneId),
}

/// 命令面板句柄(内部 `Rc`,可克隆进闭包)。
#[derive(Clone)]
pub struct CommandPalette {
    inner: Rc<Inner>,
}

struct Inner {
    popover: Popover,
    entry: SearchEntry,
    list: ListBox,
    host: Rc<dyn PaneHost>,
    phase: RefCell<Phase>,
    /// 与当前可见行索引对齐的动作表。
    actions: RefCell<Vec<RowAction>>,
}

/// 过滤前的一条候选(标题 + 副标题 + 搜索用文本 + 动作)。
struct Candidate {
    title: String,
    subtitle: String,
    haystack: String,
    action: RowAction,
}

impl CommandPalette {
    /// 新建面板并把它的弹出层挂到 `parent`(通常是主窗口)上。
    pub fn new(parent: &impl IsA<gtk4::Widget>, host: Rc<dyn PaneHost>) -> Self {
        let entry = SearchEntry::builder()
            .placeholder_text("搜索命令…")
            .build();

        let list = ListBox::builder()
            .selection_mode(SelectionMode::Single)
            .build();

        let scrolled = ScrolledWindow::builder()
            .hscrollbar_policy(PolicyType::Never)
            .vscrollbar_policy(PolicyType::Automatic)
            .min_content_width(420)
            .min_content_height(320)
            .child(&list)
            .build();

        let vbox = GtkBox::builder()
            .orientation(Orientation::Vertical)
            .spacing(6)
            .margin_top(8)
            .margin_bottom(8)
            .margin_start(8)
            .margin_end(8)
            .build();
        vbox.append(&entry);
        vbox.append(&scrolled);

        let popover = Popover::builder()
            .autohide(true)
            .has_arrow(false)
            .position(PositionType::Bottom)
            .child(&vbox)
            .build();
        popover.set_parent(parent);

        let inner = Rc::new(Inner {
            popover,
            entry,
            list,
            host,
            phase: RefCell::new(Phase::Commands),
            actions: RefCell::new(Vec::new()),
        });

        // 注意:下面的信号闭包各持一个 Rc<Inner> 强引用,与 Inner 持有的 GTK 控件
        // 形成一个引用环。面板是应用级单例、生命周期与窗口一致,这里刻意不打破环。
        {
            let w = inner.clone();
            inner.entry.connect_search_changed(move |_| refresh(&w));
        }
        {
            // 回车:执行当前第一条可见行(常见的“搜完直接回车”体验)。
            let w = inner.clone();
            inner.entry.connect_activate(move |_| {
                if w.list.row_at_index(0).is_some() {
                    dispatch(&w, 0);
                }
            });
        }
        {
            let w = inner.clone();
            inner.list.connect_row_activated(move |_, row| {
                dispatch(&w, row.index());
            });
        }

        CommandPalette { inner }
    }

    /// 弹出面板:重置到第一步、清空搜索框、填充命令、聚焦搜索框。
    pub fn present(&self) {
        *self.inner.phase.borrow_mut() = Phase::Commands;
        self.inner.entry.set_text("");
        refresh(&self.inner);
        self.inner.popover.popup();
        self.inner.entry.grab_focus();
    }
}

/// 依当前阶段 + 搜索文本,重建列表行与动作表。
fn refresh(inner: &Rc<Inner>) {
    let candidates = build_candidates(inner);
    let query = inner.entry.text().to_string().to_lowercase();
    let tokens: Vec<&str> = query.split_whitespace().collect();

    // 清空旧行。
    while let Some(child) = inner.list.first_child() {
        inner.list.remove(&child);
    }
    let mut actions = inner.actions.borrow_mut();
    actions.clear();

    for cand in candidates {
        if !tokens.is_empty() && !tokens.iter().all(|t| cand.haystack.contains(t)) {
            continue;
        }
        inner.list.append(&make_row(&cand.title, &cand.subtitle));
        actions.push(cand.action);
    }
    drop(actions);

    // 默认高亮第一行,方便直接回车。
    if let Some(row) = inner.list.row_at_index(0) {
        inner.list.select_row(Some(&row));
    }
}

/// 生成当前阶段的全部候选(未过滤)。
fn build_candidates(inner: &Rc<Inner>) -> Vec<Candidate> {
    match *inner.phase.borrow() {
        Phase::Commands => Command::palette_catalog()
            .iter()
            .map(|&cmd| Candidate {
                title: cmd.title().to_string(),
                subtitle: cmd.hotkey_hint().to_string(),
                haystack: format!("{} {}", cmd.title(), cmd.keywords()).to_lowercase(),
                action: if cmd.needs_target() {
                    RowAction::BeginTarget(cmd)
                } else {
                    RowAction::Run(cmd)
                },
            })
            .collect(),
        Phase::PickTarget(cmd) => {
            let focused = inner.host.focused_pane();
            inner
                .host
                .pane_ids()
                .into_iter()
                .filter(|id| Some(*id) != focused)
                .map(|id| Candidate {
                    title: format!("目标窗格 {id}"),
                    subtitle: match cmd {
                        Command::SwapPane => "与当前窗格交换".to_string(),
                        Command::MovePane => "移动到其右侧".to_string(),
                        _ => String::new(),
                    },
                    haystack: format!("pane 窗格 {id}"),
                    action: RowAction::WithTarget(cmd, id),
                })
                .collect()
        }
    }
}

/// 处理某一行被激活。
fn dispatch(inner: &Rc<Inner>, index: i32) {
    if index < 0 {
        return;
    }
    let action = inner.actions.borrow().get(index as usize).copied();
    let Some(action) = action else {
        return;
    };
    match action {
        RowAction::Run(cmd) => {
            command::execute(cmd, &*inner.host);
            inner.popover.popdown();
        }
        RowAction::BeginTarget(cmd) => {
            // 切到第二步:选目标窗格。
            *inner.phase.borrow_mut() = Phase::PickTarget(cmd);
            inner.entry.set_text("");
            refresh(inner);
            inner.entry.grab_focus();
        }
        RowAction::WithTarget(cmd, target) => {
            match cmd {
                Command::SwapPane => command::execute_swap(target, &*inner.host),
                // TODO(方向选择): 移动方向暂固定为“右侧”。更完整的 UI 应在第二步
                // 让用户选方向(上/下/左/右);待内核导出 wtm_tree_move 后一并完善。
                Command::MovePane => {
                    command::execute_move(target, WtmDirection::Right, &*inner.host)
                }
                _ => {}
            }
            inner.popover.popdown();
        }
    }
}

/// 造一行:标题在左,副标题(热键/说明)在右且置灰。
fn make_row(title: &str, subtitle: &str) -> ListBoxRow {
    let hbox = GtkBox::builder()
        .orientation(Orientation::Horizontal)
        .spacing(12)
        .margin_top(4)
        .margin_bottom(4)
        .margin_start(6)
        .margin_end(6)
        .build();

    let title_label = Label::builder()
        .label(title)
        .halign(Align::Start)
        .hexpand(true)
        .xalign(0.0)
        .build();
    hbox.append(&title_label);

    if !subtitle.is_empty() {
        let sub_label = Label::builder()
            .label(subtitle)
            .halign(Align::End)
            .build();
        sub_label.add_css_class("dim-label");
        hbox.append(&sub_label);
    }

    ListBoxRow::builder().child(&hbox).build()
}
