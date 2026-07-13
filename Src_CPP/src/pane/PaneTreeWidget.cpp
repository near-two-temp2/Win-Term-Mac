// Win-Term-Mac · C++ 方案 · pane 角色(UI 层)实现
// 设计说明见 PaneTreeWidget.h。本文件把 Pane 二叉树的几何/操作与 Qt 视图打通。

#include "pane/PaneTreeWidget.h"

#include "render/TerminalView.h"

#include <QPainter>
#include <QPaintEvent>
#include <QResizeEvent>
#include <QShowEvent>
#include <QMouseEvent>
#include <QKeyEvent>
#include <QFocusEvent>

#include <algorithm>
#include <cmath>

namespace wtm {

namespace {
// 分隔条像素厚度(兄弟之间预留的可拖拽间隙)。
constexpr int kGutter = 6;
// 单个窗格的最小像素边长(拖动/调整时不让某侧塌到不可见)。
constexpr int kMinPanePx = 48;
// Alt+Shift+方向 调整大小时每次挪动的比例步长。
constexpr double kResizeStep = 0.03;

// 背景 / 分隔条 / 悬停高亮 颜色(深色终端配色)。
const QColor kBgColor(0x0a, 0x0a, 0x0a);
const QColor kGutterColor(0x2b, 0x2b, 0x2b);
const QColor kGutterHot(0x3d, 0x6a, 0xa8);   // 悬停/拖动时的强调色

double clampRatio(double v, double lo, double hi) {
    if (lo > hi) return 0.5;               // 空间过小时退化到中点
    return std::min(hi, std::max(lo, v));
}
} // namespace

// ---- 构造 / 析构 -----------------------------------------------------------

PaneTreeWidget::PaneTreeWidget(QWidget* parent)
    : QWidget(parent), keymap_(keymap::Keymap::DefaultKeymap()) {
    setAutoFillBackground(false);
    setMouseTracking(true);                 // 悬停时切换分隔条光标
    setFocusPolicy(Qt::StrongFocus);

    // 默认视图工厂:每个新叶子起一个默认 shell 的 TerminalView。
    factory_ = [](QWidget* p) -> TerminalView* {
        auto* v = new TerminalView(p);
        v->startShell();                    // 起默认 shell(随后按几何 resize)
        return v;
    };

    // 初始一个根叶子(承载首个会话),分配稳定 id。
    root_ = std::make_unique<pane::Pane>(
        pane::LeafContent{nextTermId_, std::string()});
    activeTermId_ = nextTermId_;
    ++nextTermId_;
}

PaneTreeWidget::~PaneTreeWidget() {
    // 视图是 this 的子对象,Qt 会自动析构;这里只清理映射。
    views_.clear();
}

void PaneTreeWidget::setSessionFactory(SessionFactory factory) {
    if (factory) factory_ = std::move(factory);
}

// ---- 外部换树 --------------------------------------------------------------

void PaneTreeWidget::setRoot(pane::Pane::Ptr root) {
    if (!root) return;
    // 先销毁旧视图(其会话随之关闭)。
    for (auto& kv : views_) {
        if (kv.second) kv.second->deleteLater();
    }
    views_.clear();
    root_ = std::move(root);

    // 为所有叶子分配 id(若为 0)并记录一个作为初始焦点。
    activeTermId_ = 0;
    std::vector<pane::Pane*> leaves;
    root_->CollectLeaves(leaves);
    for (pane::Pane* leaf : leaves) {
        if (leaf->Content().terminalId == 0) {
            leaf->Content().terminalId = nextTermId_++;
        } else {
            nextTermId_ = std::max(nextTermId_, leaf->Content().terminalId + 1);
        }
        if (activeTermId_ == 0) activeTermId_ = leaf->Content().terminalId;
    }
    relayout();
    focusActive();
}

// ---- 焦点叶子解析 ----------------------------------------------------------

pane::Pane* PaneTreeWidget::activeLeaf() const {
    if (!root_) return nullptr;
    pane::Pane* found = nullptr;
    const std::uint32_t want = activeTermId_;
    root_->WalkTree([&](pane::Pane& p) {
        if (!found && p.IsLeaf() && p.Content().terminalId == want) {
            found = &p;
        }
    });
    return found;
}

TerminalView* PaneTreeWidget::activeView() const {
    return viewFor(activeTermId_);
}

TerminalView* PaneTreeWidget::viewFor(std::uint32_t termId) const {
    auto it = views_.find(termId);
    return it == views_.end() ? nullptr : it->second;
}

// ---- 视图创建 --------------------------------------------------------------

TerminalView* PaneTreeWidget::ensureView(pane::Pane* leaf) {
    std::uint32_t id = leaf->Content().terminalId;
    if (id == 0) {
        id = nextTermId_++;
        leaf->Content().terminalId = id;
    }
    auto it = views_.find(id);
    if (it != views_.end()) return it->second;

    TerminalView* v = factory_(this);
    if (!v) return nullptr;
    v->setProperty("wtmTermId", id);
    v->installEventFilter(this);            // 抢先拦截 pane 热键 + 追踪焦点

    // 会话标题变化时:若是当前焦点窗格,透传给集成层。
    connect(v, &TerminalView::titleChanged, this, [this, id](const QString& t) {
        if (id == activeTermId_) emit activeTitleChanged(t);
    });
    // 子进程退出:关闭该窗格(等价于用户按 ClosePane)。
    connect(v, &TerminalView::sessionExited, this, [this, id](int) {
        if (id == activeTermId_) {
            doClose();
        }
        // 非焦点窗格退出的自动回收留待后续 relayout 的 reap;此处从简。
    });

    views_[id] = v;
    return v;
}

void PaneTreeWidget::reapOrphanViews() {
    if (!root_) return;
    std::vector<pane::Pane*> leaves;
    root_->CollectLeaves(leaves);
    std::vector<std::uint32_t> live;
    live.reserve(leaves.size());
    for (pane::Pane* leaf : leaves) live.push_back(leaf->Content().terminalId);

    for (auto it = views_.begin(); it != views_.end();) {
        const bool alive =
            std::find(live.begin(), live.end(), it->first) != live.end();
        if (!alive) {
            if (it->second) it->second->deleteLater();
            it = views_.erase(it);
        } else {
            ++it;
        }
    }
}

// ---- 布局 ------------------------------------------------------------------

QRect PaneTreeWidget::contentRect() const {
    return QRect(0, 0, width(), height());
}

pane::Rect PaneTreeWidget::contentBounds() const {
    return pane::Rect{0.0, 0.0, static_cast<double>(width()),
                      static_cast<double>(height())};
}

void PaneTreeWidget::relayout() {
    if (!root_) return;
    handles_.clear();

    // 先隐藏所有视图;下面只显示被摆放到的那些(离场/最大化时其余保持隐藏)。
    for (auto& kv : views_) {
        if (kv.second) kv.second->hide();
    }

    const QRect area = contentRect();
    if (area.width() <= 0 || area.height() <= 0) return;

    // 最大化:某个叶子被 zoom 时独占整块,其余隐藏、无分隔条。
    if (pane::Pane* zoomed = root_->FindZoomed()) {
        if (zoomed->IsLeaf()) {
            placeLeaf(zoomed, area);
            update();
            return;
        }
    }

    layoutNode(root_.get(), area);
    update();
}

void PaneTreeWidget::layoutNode(pane::Pane* node, const QRect& r) {
    if (!node) return;
    if (node->IsLeaf()) {
        placeLeaf(node, r);
        return;
    }

    const bool vertical = (node->GetSplitState() == pane::SplitState::Vertical);
    const double pos = node->GetDesiredSplitPosition();

    if (vertical) {
        // 左右并排,中间一条竖直分隔条。
        const int avail = std::max(0, r.width() - kGutter);
        const double lo = avail > 0 ? static_cast<double>(kMinPanePx) / avail : 0.0;
        const double hi = 1.0 - lo;
        const int w1 = static_cast<int>(std::lround(avail * clampRatio(pos, lo, hi)));

        const QRect r1(r.x(), r.y(), w1, r.height());
        const QRect bar(r.x() + w1, r.y(), kGutter, r.height());
        const QRect r2(r.x() + w1 + kGutter, r.y(),
                       r.width() - w1 - kGutter, r.height());

        handles_.push_back(Handle{bar, r, node, true});
        layoutNode(node->FirstChild(), r1);
        layoutNode(node->SecondChild(), r2);
    } else {
        // 上下堆叠,中间一条水平分隔条。
        const int avail = std::max(0, r.height() - kGutter);
        const double lo = avail > 0 ? static_cast<double>(kMinPanePx) / avail : 0.0;
        const double hi = 1.0 - lo;
        const int h1 = static_cast<int>(std::lround(avail * clampRatio(pos, lo, hi)));

        const QRect r1(r.x(), r.y(), r.width(), h1);
        const QRect bar(r.x(), r.y() + h1, r.width(), kGutter);
        const QRect r2(r.x(), r.y() + h1 + kGutter,
                       r.width(), r.height() - h1 - kGutter);

        handles_.push_back(Handle{bar, r, node, false});
        layoutNode(node->FirstChild(), r1);
        layoutNode(node->SecondChild(), r2);
    }
}

void PaneTreeWidget::placeLeaf(pane::Pane* leaf, const QRect& r) {
    TerminalView* v = ensureView(leaf);
    if (!v) return;
    v->setGeometry(r);
    v->show();
}

// ---- 绘制:背景 + 分隔条 ---------------------------------------------------

void PaneTreeWidget::paintEvent(QPaintEvent* /*e*/) {
    QPainter p(this);
    p.fillRect(rect(), kBgColor);           // 间隙/空白处的底色

    for (int i = 0; i < static_cast<int>(handles_.size()); ++i) {
        const bool hot = (i == draggingHandle_) || (i == hoveredHandle_);
        p.fillRect(handles_[i].bar, hot ? kGutterHot : kGutterColor);
    }
}

// ---- 尺寸 / 显示 -----------------------------------------------------------

void PaneTreeWidget::resizeEvent(QResizeEvent* /*e*/) {
    relayout();
}

void PaneTreeWidget::showEvent(QShowEvent* /*e*/) {
    relayout();
    focusActive();
}

// ---- 分隔条拖动 ------------------------------------------------------------

int PaneTreeWidget::handleAt(const QPoint& pos) const {
    for (int i = 0; i < static_cast<int>(handles_.size()); ++i) {
        if (handles_[i].bar.contains(pos)) return i;
    }
    return -1;
}

void PaneTreeWidget::mousePressEvent(QMouseEvent* e) {
    if (e->button() == Qt::LeftButton) {
        const int idx = handleAt(e->pos());
        if (idx >= 0) {
            draggingHandle_ = idx;
            e->accept();
            return;
        }
    }
    QWidget::mousePressEvent(e);
}

void PaneTreeWidget::mouseMoveEvent(QMouseEvent* e) {
    if (draggingHandle_ >= 0 &&
        draggingHandle_ < static_cast<int>(handles_.size())) {
        const Handle& h = handles_[draggingHandle_];
        const QRect& nr = h.nodeRect;
        double ratio;
        if (h.vertical) {
            const double denom = std::max(1, nr.width());
            ratio = (e->pos().x() - nr.x()) / denom;
        } else {
            const double denom = std::max(1, nr.height());
            ratio = (e->pos().y() - nr.y()) / denom;
        }
        h.node->SetDesiredSplitPosition(clampRatio(ratio, 0.02, 0.98));
        relayout();
        e->accept();
        return;
    }

    // 非拖动:悬停在分隔条上时切换光标形状。
    const int idx = handleAt(e->pos());
    if (idx != hoveredHandle_) {
        hoveredHandle_ = idx;
        update();
    }
    if (idx >= 0) {
        setCursor(handles_[idx].vertical ? Qt::SplitHCursor : Qt::SplitVCursor);
    } else {
        unsetCursor();
    }
    QWidget::mouseMoveEvent(e);
}

void PaneTreeWidget::mouseReleaseEvent(QMouseEvent* e) {
    if (draggingHandle_ >= 0) {
        draggingHandle_ = -1;
        e->accept();
        return;
    }
    QWidget::mouseReleaseEvent(e);
}

// ---- 焦点 ------------------------------------------------------------------

void PaneTreeWidget::focusActive() {
    if (TerminalView* v = activeView()) {
        v->setFocus(Qt::OtherFocusReason);
    }
}

// ---- 事件过滤:pane 热键 + 焦点追踪 ---------------------------------------

bool PaneTreeWidget::eventFilter(QObject* obj, QEvent* event) {
    if (event->type() == QEvent::KeyPress) {
        auto* ke = static_cast<QKeyEvent*>(event);
        keymap::KeyChord chord;
        if (chordFromKeyEvent(ke, chord)) {
            if (auto act = keymap_.Lookup(chord)) {
                if (isPaneAction(*act) && handleAction(*act)) {
                    return true;            // 已消化,不再下发给视图/子进程
                }
            }
        }
        return false;                       // 放行:交给视图当作输入送进 shell
    }
    if (event->type() == QEvent::FocusIn) {
        bool ok = false;
        const std::uint32_t id = obj->property("wtmTermId").toUInt(&ok);
        if (ok && id != 0) activeTermId_ = id;
        return false;
    }
    return QWidget::eventFilter(obj, event);
}

// ---- 动作派发 --------------------------------------------------------------

bool PaneTreeWidget::isPaneAction(keymap::ActionId a) noexcept {
    using A = keymap::ActionId;
    switch (a) {
    case A::SplitRight:  case A::SplitDown:
    case A::FocusLeft:   case A::FocusRight: case A::FocusUp: case A::FocusDown:
    case A::ResizeLeft:  case A::ResizeRight: case A::ResizeUp: case A::ResizeDown:
    case A::ToggleZoom:  case A::ClosePane:
    case A::SwapPaneLeft: case A::SwapPaneRight:
    case A::SwapPaneUp:   case A::SwapPaneDown:
    case A::MovePaneLeft: case A::MovePaneRight:
    case A::MovePaneUp:   case A::MovePaneDown:
        return true;
    default:
        return false;                       // ToggleCommandPalette / None 等放行
    }
}

bool PaneTreeWidget::handleAction(keymap::ActionId action) {
    using A = keymap::ActionId;
    using D = pane::Direction;
    using S = pane::SplitDirection;
    switch (action) {
    case A::SplitRight:    return doSplit(S::Right);
    case A::SplitDown:     return doSplit(S::Down);

    case A::FocusLeft:     return doFocus(D::Left);
    case A::FocusRight:    return doFocus(D::Right);
    case A::FocusUp:       return doFocus(D::Up);
    case A::FocusDown:     return doFocus(D::Down);

    case A::ResizeLeft:    return doResize(D::Left);
    case A::ResizeRight:   return doResize(D::Right);
    case A::ResizeUp:      return doResize(D::Up);
    case A::ResizeDown:    return doResize(D::Down);

    case A::ToggleZoom:    return doToggleZoom();
    case A::ClosePane:     return doClose();

    case A::SwapPaneLeft:  return doSwap(D::Left);
    case A::SwapPaneRight: return doSwap(D::Right);
    case A::SwapPaneUp:    return doSwap(D::Up);
    case A::SwapPaneDown:  return doSwap(D::Down);

    case A::MovePaneLeft:  return doMove(D::Left);
    case A::MovePaneRight: return doMove(D::Right);
    case A::MovePaneUp:    return doMove(D::Up);
    case A::MovePaneDown:  return doMove(D::Down);

    default:               return false;
    }
}

// ---- 拆分 ------------------------------------------------------------------

bool PaneTreeWidget::doSplit(pane::SplitDirection dir) {
    pane::Pane* leaf = activeLeaf();
    if (!leaf || !leaf->IsLeaf()) return false;

    // 新叶子分配一个稳定会话 id;原会话(及其 id/视图)会被 Split 下沉到另一子叶子。
    const std::uint32_t newId = nextTermId_++;
    pane::Pane* newPane =
        leaf->Split(dir, 0.5, pane::LeafContent{newId, std::string()});
    if (!newPane) return false;

    activeTermId_ = newId;                   // 焦点跟随新窗格(对齐 WT)
    relayout();                              // ensureView 会为新叶子起一个新会话
    focusActive();
    return true;
}

// ---- 切焦点 ----------------------------------------------------------------

bool PaneTreeWidget::doFocus(pane::Direction dir) {
    pane::Pane* leaf = activeLeaf();
    if (!leaf) return false;
    pane::Pane* target = root_->Navigate(leaf, dir, contentBounds());
    if (!target) return false;              // 该方向没有相邻窗格
    activeTermId_ = target->Content().terminalId;
    focusActive();
    update();
    return true;
}

// ---- 调整大小(挪最近的同朝向祖先分裂线)---------------------------------

bool PaneTreeWidget::doResize(pane::Direction dir) {
    pane::Pane* leaf = activeLeaf();
    if (!leaf) return false;

    const bool wantVertical = (dir == pane::Direction::Left ||
                               dir == pane::Direction::Right);
    // 向上找最近的、朝向匹配的分裂祖先。
    pane::Pane* split = nullptr;
    for (pane::Pane* p = leaf->Parent(); p != nullptr; p = p->Parent()) {
        const bool isV = (p->GetSplitState() == pane::SplitState::Vertical);
        if (isV == wantVertical) { split = p; break; }
    }
    if (!split) return false;

    const double step =
        (dir == pane::Direction::Right || dir == pane::Direction::Down)
            ? kResizeStep : -kResizeStep;
    split->SetDesiredSplitPosition(split->GetDesiredSplitPosition() + step);
    relayout();
    return true;
}

// ---- 最大化 / 还原 ---------------------------------------------------------

bool PaneTreeWidget::doToggleZoom() {
    pane::Pane* leaf = activeLeaf();
    if (!leaf) return false;
    const bool wasZoomed = leaf->IsZoomed();
    // 先清掉所有 zoom,保证同一时刻至多一个(FindZoomed 取首个)。
    root_->WalkTree([](pane::Pane& p) { p.SetZoomed(false); });
    leaf->SetZoomed(!wasZoomed);
    relayout();
    focusActive();
    return true;
}

// ---- 关闭 ------------------------------------------------------------------

bool PaneTreeWidget::doClose() {
    pane::Pane* leaf = activeLeaf();
    if (!leaf) return false;
    if (leaf == root_.get()) {
        // 仅剩最后一个窗格:交由集成层决定(关窗/忽略)。
        emit lastPaneClosed();
        return true;
    }

    const std::uint32_t closingId = leaf->Content().terminalId;
    // Detach 会把兄弟折叠进父节点(原地),被摘下的叶子随返回值销毁。
    pane::Pane::Ptr detached = pane::Pane::Detach(leaf);
    // detached 及其视图不再属于树:回收视图/会话。
    if (auto it = views_.find(closingId); it != views_.end()) {
        if (it->second) it->second->deleteLater();
        views_.erase(it);
    }

    // 选一个存活叶子作为新焦点(取第一个)。
    std::vector<pane::Pane*> leaves;
    root_->CollectLeaves(leaves);
    activeTermId_ = leaves.empty() ? 0 : leaves.front()->Content().terminalId;

    reapOrphanViews();
    relayout();
    focusActive();
    return true;
}

// ---- 交换 ------------------------------------------------------------------

bool PaneTreeWidget::doSwap(pane::Direction dir) {
    pane::Pane* leaf = activeLeaf();
    if (!leaf) return false;
    pane::Pane* target = root_->Navigate(leaf, dir, contentBounds());
    if (!target || target == leaf) return false;

    // 交换会互换两叶子的 LeafContent(含会话 id);焦点会话 id 不变,视图随之易位。
    if (!pane::Pane::Swap(leaf, target)) return false;
    relayout();
    focusActive();
    return true;
}

// ---- 移动 ------------------------------------------------------------------

bool PaneTreeWidget::doMove(pane::Direction dir) {
    pane::Pane* leaf = activeLeaf();
    if (!leaf) return false;
    pane::Pane* target = root_->Navigate(leaf, dir, contentBounds());
    if (!target || target == leaf) return false;

    // 安全约束(见 Pane.h):若 target 是 leaf 的兄弟,Detach 会把它折叠销毁 →
    // 那样 Attach 到已销毁节点是 UB。此情形退化为交换(视觉等价、且安全)。
    pane::Pane* parent = leaf->Parent();
    if (parent &&
        (parent->FirstChild() == target || parent->SecondChild() == target)) {
        if (!pane::Pane::Swap(leaf, target)) return false;
        relayout();
        focusActive();
        return true;
    }

    // Move = Detach(leaf) + target->Attach(leaf子树)。会话 id 随内容迁移,视图不变。
    pane::Pane* moved = pane::Pane::Move(leaf, target, dir, 0.5);
    if (!moved) return false;
    relayout();
    focusActive();
    return true;
}

// ---- Qt 按键 → KeyChord ---------------------------------------------------

bool PaneTreeWidget::chordFromKeyEvent(const QKeyEvent* e, keymap::KeyChord& out) {
    using KC = keymap::KeyCode;
    using KM = keymap::KeyModifier;

    const Qt::KeyboardModifiers qm = e->modifiers();
    const bool mac = keymap::IsMacPlatform();

    std::uint8_t mods = KM::ModNone;
    if (qm & Qt::ShiftModifier)   mods |= KM::ModShift;
    if (qm & Qt::AltModifier)     mods |= KM::ModAlt;
    if (qm & Qt::ControlModifier) {
        mods |= KM::ModCtrl;
        if (!mac) mods |= KM::ModPrimary;   // Win/Linux:Primary = Ctrl
    }
    if (qm & Qt::MetaModifier) {
        if (mac) mods |= KM::ModPrimary;    // macOS:Primary = Cmd(Meta)
        else     mods |= KM::ModCtrl;
    }

    KC key = KC::Unknown;
    switch (e->key()) {
    case Qt::Key_P:          key = KC::P; break;
    case Qt::Key_W:          key = KC::W; break;
    // Alt+Shift+= 常产出 '+';不同布局可能给 Key_Plus 或 Key_Equal,都归一到 Plus。
    case Qt::Key_Plus:
    case Qt::Key_Equal:      key = KC::Plus; break;
    // Alt+Shift+- 可能给 Key_Minus 或 Key_Underscore。
    case Qt::Key_Minus:
    case Qt::Key_Underscore: key = KC::Minus; break;
    case Qt::Key_Left:       key = KC::ArrowLeft; break;
    case Qt::Key_Right:      key = KC::ArrowRight; break;
    case Qt::Key_Up:         key = KC::ArrowUp; break;
    case Qt::Key_Down:       key = KC::ArrowDown; break;
    case Qt::Key_Return:
    case Qt::Key_Enter:      key = KC::Enter; break;
    case Qt::Key_Escape:     key = KC::Escape; break;
    case Qt::Key_Tab:        key = KC::Tab; break;
    default:                 return false;
    }

    out.mods = mods;
    out.key = key;
    return true;
}

} // namespace wtm
