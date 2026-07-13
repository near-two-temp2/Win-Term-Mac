// Win-Term-Mac · C++ 方案 · io 角色
// PaneTerminalBridge 实现:窗格树 <-> shell 会话 的 IO 编排。
// 设计说明见 PaneTerminalBridge.h。复用 render 的 TerminalView 与 term 的
// TerminalSession(内含 PTY),本文件不直接碰 PTY 系统调用。

#include "io/PaneTerminalBridge.h"

#include "render/TerminalView.h"
#include "term/TerminalSession.h"

#include <QWidget>

#include <cmath>
#include <vector>

namespace wtm {
namespace io {

// ---- 构造 / 析构 -----------------------------------------------------------

PaneTerminalBridge::PaneTerminalBridge(QObject* parent) : QObject(parent) {}

PaneTerminalBridge::~PaneTerminalBridge() {
    // 主动收尾所有仍在登记的终端。detachLeaf 会从 views_ 摘除,故拷贝 key 遍历。
    const QList<std::uint32_t> ids = views_.keys();
    for (std::uint32_t id : ids) {
        detachLeaf(id);
    }
}

std::uint32_t PaneTerminalBridge::nextId() noexcept {
    // 从 1 起:0 保留为 LeafContent.terminalId 的「未接终端」默认值。
    return ++idSeq_;
}

// ---- 生命周期绑定 ----------------------------------------------------------

TerminalView* PaneTerminalBridge::attachLeaf(pane::Pane& leaf, QWidget* container,
                                             const QString& program,
                                             const QStringList& args) {
    if (!leaf.IsLeaf()) return nullptr;   // 只有叶子承载会话

    auto* view = new TerminalView(container);
    // startShell 内部 new TerminalSession 并 start();view 接管其生命周期。
    TerminalSession* session = view->startShell(program, args);
    if (!session) {
        delete view;                       // shell 起不来:回滚半成品
        return nullptr;
    }

    const std::uint32_t id = nextId();
    leaf.Content().terminalId = id;        // 把 id 写回窗格树(填上占位)
    views_.insert(id, view);

    // 带 id 上抛标题 / 退出。
    QObject::connect(view, &TerminalView::titleChanged, this,
                     [this, id](const QString& t) { emit paneTitleChanged(id, t); });
    QObject::connect(view, &TerminalView::sessionExited, this,
                     [this, id](int code) { emit paneExited(id, code); });
    // view 若被外部(如 Qt 父对象析构)销毁,自动从登记表摘除,避免悬垂。
    QObject::connect(view, &QObject::destroyed, this,
                     [this, id]() { views_.remove(id); });

    return view;
}

void PaneTerminalBridge::detachLeaf(std::uint32_t terminalId) {
    auto it = views_.find(terminalId);
    if (it == views_.end()) return;
    TerminalView* view = it.value();
    views_.erase(it);
    if (view) {
        // 先断本桥与该 view 的连接(避免 deleteLater 期间再触发 destroyed lambda 找不到 key)。
        QObject::disconnect(view, nullptr, this, nullptr);
        if (TerminalSession* s = view->session()) {
            s->shutdown();                 // 结束 shell + 释放 PTY
        }
        view->deleteLater();
    }
}

// ---- 查询 ------------------------------------------------------------------

TerminalView* PaneTerminalBridge::viewFor(std::uint32_t terminalId) const {
    return views_.value(terminalId, nullptr);
}

TerminalSession* PaneTerminalBridge::sessionFor(std::uint32_t terminalId) const {
    TerminalView* v = viewFor(terminalId);
    return v ? v->session() : nullptr;
}

bool PaneTerminalBridge::hasTerminal(std::uint32_t terminalId) const {
    return views_.contains(terminalId);
}

QList<std::uint32_t> PaneTerminalBridge::liveTerminals() const {
    return views_.keys();
}

// ---- resize -> PTY 的总漏斗 -------------------------------------------------

void PaneTerminalBridge::applyLayout(pane::Pane& root, const QRect& pixelBounds) {
    if (pixelBounds.width() <= 0 || pixelBounds.height() <= 0) return;

    // 1) 让 pane 角色按像素外框把整棵树的几何算好(存进各节点 layout_)。
    pane::Rect bounds;
    bounds.x = static_cast<double>(pixelBounds.x());
    bounds.y = static_cast<double>(pixelBounds.y());
    bounds.width = static_cast<double>(pixelBounds.width());
    bounds.height = static_cast<double>(pixelBounds.height());
    root.ComputeLayout(bounds);

    // 2) 逐叶把矩形推给对应 view;setGeometry 触发 resizeEvent -> session.resize -> PTY。
    std::vector<pane::Pane*> leaves;
    root.CollectLeaves(leaves);
    for (pane::Pane* leaf : leaves) {
        if (!leaf) continue;
        TerminalView* view = viewFor(leaf->Content().terminalId);
        if (!view) continue;               // 尚未接终端的叶子(如刚 Split 出来)跳过

        const pane::Rect& r = leaf->Layout();
        const int x = static_cast<int>(std::lround(r.x));
        const int y = static_cast<int>(std::lround(r.y));
        const int w = static_cast<int>(std::lround(r.width));
        const int h = static_cast<int>(std::lround(r.height));
        view->setGeometry(x, y, qMax(1, w), qMax(1, h));
        view->show();
    }
}

// ---- 输入路由 --------------------------------------------------------------

void PaneTerminalBridge::focusLeaf(std::uint32_t terminalId) {
    if (TerminalView* v = viewFor(terminalId)) {
        v->setFocus(Qt::OtherFocusReason);
    }
}

void PaneTerminalBridge::sendTextToLeaf(std::uint32_t terminalId, const QString& text) {
    if (TerminalSession* s = sessionFor(terminalId)) {
        if (s->isRunning()) s->sendText(text);
    }
}

void PaneTerminalBridge::broadcastText(const QString& text) {
    for (TerminalView* v : views_) {
        if (!v) continue;
        if (TerminalSession* s = v->session()) {
            if (s->isRunning()) s->sendText(text);
        }
    }
}

} // namespace io
} // namespace wtm
