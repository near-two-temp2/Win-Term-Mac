// Win-Term-Mac · C++ 方案 · cmd 角色 · 装配核心 实现
// 见 CommandCoordinator.h 顶部说明。本文件把 ActionId 落到窗格树 + 终端视图。

#include "cmd/CommandCoordinator.h"

#include "cmd/CommandPaletteWidget.h"
#include "cmd/QtKeyTranslator.h"
#include "io/PaneTerminalBridge.h"
#include "render/TerminalView.h"

#include <QWidget>
#include <QEvent>
#include <QKeyEvent>
#include <QRect>

#include <optional>
#include <vector>

namespace wtm {
namespace cmd {

// ---- 构造 / 析构 -----------------------------------------------------------

CommandCoordinator::CommandCoordinator(io::PaneTerminalBridge* bridge,
                                       QWidget* container, QObject* parent)
    : QObject(parent), bridge_(bridge), container_(container) {
    keymap_ = keymap::Keymap::DefaultKeymap();
}

CommandCoordinator::~CommandCoordinator() = default;

// ---- 初始化 ----------------------------------------------------------------

bool CommandCoordinator::initialize(const QString& program, const QStringList& args) {
    root_ = std::make_unique<pane::Pane>(pane::LeafContent{});
    focused_ = root_.get();

    // 命令面板浮层:以 container 的顶层窗口为 Qt 父,便于居中与置顶。
    QWidget* top = container_ ? container_->window() : nullptr;
    palette_ = new CommandPaletteWidget(top);
    palette_->setCommands(keymap_, [this](keymap::ActionId a) { dispatch(a); });
    // 面板关闭后把焦点还给当前终端。
    connect(palette_, &CommandPaletteWidget::closed, this,
            [this]() { focusLeaf(focused_); });

    bool ok = false;
    if (bridge_ && container_) {
        ok = attachTerminal(*root_);
        relayout();
        focusLeaf(root_.get());
    }
    return ok;
}

// ---- 布局 ------------------------------------------------------------------

pane::Rect CommandCoordinator::containerBounds() const {
    pane::Rect r;
    if (container_) {
        const QRect cr = container_->rect();
        r.x = 0.0;
        r.y = 0.0;
        r.width = static_cast<double>(cr.width());
        r.height = static_cast<double>(cr.height());
    }
    return r;
}

void CommandCoordinator::relayout() {
    if (!bridge_ || !container_ || !root_) return;

    // zoom:被最大化的叶子独占容器,其余视图隐藏(渲染层不自己处理 zoom,由此实现)。
    if (pane::Pane* z = root_->FindZoomed()) {
        const std::uint32_t zid = z->Content().terminalId;
        const auto ids = bridge_->liveTerminals();
        for (std::uint32_t id : ids) {
            TerminalView* v = bridge_->viewFor(id);
            if (!v) continue;
            if (id == zid) {
                v->setGeometry(container_->rect());
                v->show();
                v->raise();
            } else {
                v->hide();
            }
        }
        return;
    }

    // 常规:交给 IO 桥按窗格树几何逐叶 setGeometry(会驱动 PTY resize)。
    bridge_->applyLayout(*root_, container_->rect());
}

// ---- 终端接入 / 焦点 -------------------------------------------------------

bool CommandCoordinator::attachTerminal(pane::Pane& leaf) {
    if (!bridge_ || !container_) return false;
    TerminalView* view = bridge_->attachLeaf(leaf, container_);
    if (!view) return false;
    // 给视图装事件过滤器:截获全局热键 + 跟踪点击焦点。
    view->installEventFilter(this);
    return true;
}

void CommandCoordinator::focusLeaf(pane::Pane* leaf) {
    if (!leaf || !leaf->IsLeaf()) return;
    focused_ = leaf;
    const std::uint32_t id = leaf->Content().terminalId;
    if (bridge_ && id != 0) {
        bridge_->focusLeaf(id);
    }
    emit focusedPaneChanged(id);
}

pane::Pane* CommandCoordinator::firstLeaf(pane::Pane* node) {
    while (node && !node->IsLeaf()) {
        node = node->FirstChild();
    }
    return node;
}

void CommandCoordinator::ensureFocusValid() {
    if (focused_ && focused_->IsLeaf()) return;
    focused_ = firstLeaf(root_.get());
}

pane::Pane* CommandCoordinator::leafForTerminal(std::uint32_t terminalId) const {
    if (!root_ || terminalId == 0) return nullptr;
    pane::Pane* found = nullptr;
    root_->WalkTree([&](pane::Pane& p) {
        if (!found && p.IsLeaf() && p.Content().terminalId == terminalId) {
            found = &p;
        }
    });
    return found;
}

void CommandCoordinator::notifyFocusedTerminal(std::uint32_t terminalId) {
    if (pane::Pane* leaf = leafForTerminal(terminalId)) {
        focused_ = leaf;
        emit focusedPaneChanged(terminalId);
    }
}

// ---- 命令面板 --------------------------------------------------------------

void CommandCoordinator::openCommandPalette() {
    if (palette_) palette_->openPalette();
}

// ---- 派发 ------------------------------------------------------------------

void CommandCoordinator::dispatch(keymap::ActionId action) {
    using keymap::ActionId;
    ensureFocusValid();
    if (!focused_) return;

    switch (action) {
        case ActionId::SplitRight: doSplit(pane::SplitDirection::Right); break;
        case ActionId::SplitDown:  doSplit(pane::SplitDirection::Down);  break;

        case ActionId::FocusLeft:  doFocus(pane::Direction::Left);  break;
        case ActionId::FocusRight: doFocus(pane::Direction::Right); break;
        case ActionId::FocusUp:    doFocus(pane::Direction::Up);    break;
        case ActionId::FocusDown:  doFocus(pane::Direction::Down);  break;

        case ActionId::ResizeLeft:  doResize(pane::Direction::Left);  break;
        case ActionId::ResizeRight: doResize(pane::Direction::Right); break;
        case ActionId::ResizeUp:    doResize(pane::Direction::Up);    break;
        case ActionId::ResizeDown:  doResize(pane::Direction::Down);  break;

        case ActionId::SwapPaneLeft:  doSwap(pane::Direction::Left);  break;
        case ActionId::SwapPaneRight: doSwap(pane::Direction::Right); break;
        case ActionId::SwapPaneUp:    doSwap(pane::Direction::Up);    break;
        case ActionId::SwapPaneDown:  doSwap(pane::Direction::Down);  break;

        case ActionId::MovePaneLeft:  doMove(pane::Direction::Left);  break;
        case ActionId::MovePaneRight: doMove(pane::Direction::Right); break;
        case ActionId::MovePaneUp:    doMove(pane::Direction::Up);    break;
        case ActionId::MovePaneDown:  doMove(pane::Direction::Down);  break;

        case ActionId::ToggleZoom: doToggleZoom(); break;
        case ActionId::ClosePane:  doClosePane();  break;

        case ActionId::ToggleCommandPalette: openCommandPalette(); break;
        case ActionId::None: break;
    }
}

// ---- 各动作实现 ------------------------------------------------------------

void CommandCoordinator::doSplit(pane::SplitDirection dir) {
    if (!focused_ || !focused_->IsLeaf()) return;
    // 分裂前先按当前几何算一次布局,给 Automatic 及后续 attach 一个合理的尺寸提示。
    if (root_) root_->ComputeLayout(containerBounds());

    // Split:focused_ 原地变分裂节点,原会话下沉成子叶,newLeaf 是新叶。
    pane::Pane* newLeaf = focused_->Split(dir, 0.5, pane::LeafContent{});
    if (!newLeaf) return;

    if (!attachTerminal(*newLeaf)) {
        // 新终端起不来:把刚分裂出的新叶折叠掉,恢复成分裂前的单叶。
        pane::Pane::Ptr dropped = pane::Pane::Detach(newLeaf);
        (void)dropped;   // 析构即回收
        ensureFocusValid();
        relayout();
        return;
    }
    relayout();
    focusLeaf(newLeaf);   // 焦点跟到新窗格(对齐 WT)
}

void CommandCoordinator::doFocus(pane::Direction dir) {
    if (!root_ || !focused_) return;
    pane::Pane* target = root_->Navigate(focused_, dir, containerBounds());
    if (target) focusLeaf(target);
}

void CommandCoordinator::doResize(pane::Direction dir) {
    if (!focused_) return;
    // 目标分裂轴:左右 → Vertical 分裂线;上下 → Horizontal 分裂线。
    const bool horizontal = (dir == pane::Direction::Left || dir == pane::Direction::Right);
    const pane::SplitState wantState =
        horizontal ? pane::SplitState::Vertical : pane::SplitState::Horizontal;

    // 从焦点向上找最近的、分裂轴匹配的祖先,移动它的分隔条。
    for (pane::Pane* p = focused_; p != nullptr; p = p->Parent()) {
        pane::Pane* parent = p->Parent();
        if (!parent || parent->GetSplitState() != wantState) continue;

        // 分隔条移动方向:Right/Down 增大 first 比例,Left/Up 减小。
        const double delta =
            (dir == pane::Direction::Right || dir == pane::Direction::Down)
                ? resizeStep_
                : -resizeStep_;
        parent->SetDesiredSplitPosition(parent->GetDesiredSplitPosition() + delta);
        relayout();
        return;
    }
    // 没有匹配轴的祖先(如整棵树只有一个方向的分裂):无操作。
}

void CommandCoordinator::doSwap(pane::Direction dir) {
    if (!root_ || !focused_) return;
    pane::Pane* target = root_->Navigate(focused_, dir, containerBounds());
    if (!target || target == focused_) return;
    if (!pane::Pane::Swap(focused_, target)) return;
    // 交换的是「内容」(含 terminalId):focused_ 节点现在装着 target 的旧会话,
    // 反之亦然。焦点跟随用户原来那个会话 → 落到 target 节点。
    relayout();
    focusLeaf(target);
}

void CommandCoordinator::doMove(pane::Direction dir) {
    if (!root_ || !focused_) return;
    pane::Pane* target = root_->Navigate(focused_, dir, containerBounds());
    if (!target || target == focused_) return;

    // Move 会 Detach(focused_) 从而原地折叠其父节点。若 target 恰是 focused_ 的
    // 直接兄弟叶,则折叠时兄弟节点会被销毁 —— 折叠后其内容落到「父节点」上。
    // 这种情况改为把 focused_ 挂到折叠后的父节点(此时它已是叶子)。
    pane::Pane* parent = focused_->Parent();
    pane::SplitDirection sdir =
        (dir == pane::Direction::Left)  ? pane::SplitDirection::Left  :
        (dir == pane::Direction::Right) ? pane::SplitDirection::Right :
        (dir == pane::Direction::Up)    ? pane::SplitDirection::Up    :
                                          pane::SplitDirection::Down;

    pane::Pane* sibling = nullptr;
    if (parent) {
        sibling = (parent->FirstChild() == focused_) ? parent->SecondChild()
                                                     : parent->FirstChild();
    }

    pane::Pane* moved = nullptr;
    if (target == sibling) {
        // 折叠父节点后,parent 变成叶子(承载原兄弟会话),把 focused_ 挂上去。
        pane::Pane::Ptr detached = pane::Pane::Detach(focused_);
        if (!detached || !parent) return;
        moved = parent->Attach(sdir, 0.5, std::move(detached));
    } else {
        moved = pane::Pane::Move(focused_, target, sdir, 0.5);
    }
    if (!moved) return;

    relayout();
    focusLeaf(moved);   // moved 就是被移动的那个叶(指针未变)
}

void CommandCoordinator::doToggleZoom() {
    if (!focused_ || !focused_->IsLeaf()) return;
    focused_->SetZoomed(!focused_->IsZoomed());
    relayout();
    // 保持焦点在被(取消)最大化的窗格上。
    focusLeaf(focused_);
}

void CommandCoordinator::doClosePane() {
    if (!focused_ || !focused_->IsLeaf() || !root_) return;
    const std::uint32_t id = focused_->Content().terminalId;

    // 只剩一个窗格:关掉它的终端并通知集成层(由其决定关标签 / 关窗)。
    if (focused_ == root_.get()) {
        if (bridge_ && id != 0) bridge_->detachLeaf(id);
        emit lastPaneClosed();
        return;
    }

    pane::Pane* parent = focused_->Parent();
    // 先摘下焦点子树(会把 parent 原地折叠成其兄弟),再回收其终端与节点。
    pane::Pane::Ptr detached = pane::Pane::Detach(focused_);
    if (bridge_ && id != 0) bridge_->detachLeaf(id);
    detached.reset();   // 销毁被摘下的叶节点

    // 新焦点:落到折叠后 parent 子树里的第一个叶子。
    focused_ = firstLeaf(parent);
    ensureFocusValid();
    relayout();
    focusLeaf(focused_);
}

// ---- 事件过滤:全局热键 + 点击焦点跟踪 -------------------------------------

bool CommandCoordinator::eventFilter(QObject* watched, QEvent* event) {
    // 点击 / Tab 让某终端视图获得焦点 → 同步 focused_(据视图找对应叶子)。
    if (event->type() == QEvent::FocusIn) {
        if (auto* view = qobject_cast<TerminalView*>(watched)) {
            const std::uint32_t id = bridge_ ? [&]() -> std::uint32_t {
                for (std::uint32_t tid : bridge_->liveTerminals()) {
                    if (bridge_->viewFor(tid) == view) return tid;
                }
                return 0;
            }() : 0;
            if (id != 0) {
                if (pane::Pane* leaf = leafForTerminal(id)) {
                    focused_ = leaf;
                    emit focusedPaneChanged(id);
                }
            }
        }
        return QObject::eventFilter(watched, event);
    }

    if (event->type() == QEvent::KeyPress) {
        auto* ke = static_cast<QKeyEvent*>(event);
        // 面板打开时不抢按键(面板自己处理)。
        if (palette_ && palette_->isOpen()) {
            return QObject::eventFilter(watched, event);
        }
        std::optional<keymap::KeyChord> chord = translateKeyEvent(ke);
        if (chord) {
            if (std::optional<keymap::ActionId> action = keymap_.Lookup(*chord)) {
                dispatch(*action);
                return true;   // 命中热键:消费掉,不再喂给终端
            }
        }
        // 未命中:放行,交给 TerminalView 当普通输入。
    }
    return QObject::eventFilter(watched, event);
}

} // namespace cmd
} // namespace wtm
