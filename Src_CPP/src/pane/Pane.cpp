// Win-Term-Mac · C++ 方案 · PaneCore 实现
// 见 Pane.h 的设计说明。核心是纯 C++ 二叉树,无渲染依赖。

#include "pane/Pane.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <limits>

namespace wtm::pane {

namespace {
// 浮点比较容差(布局用归一化坐标或像素都够用)。
constexpr double kEps = 1e-9;

double Clamp01(double v) {
    if (v < 0.0) return 0.0;
    if (v > 1.0) return 1.0;
    return v;
}
} // namespace

uint32_t Pane::NextId() noexcept {
    static std::atomic<uint32_t> counter{1};
    return counter.fetch_add(1, std::memory_order_relaxed);
}

Pane::Pane(LeafContent content)
    : id_(NextId()), content_(std::move(content)) {}

bool Pane::IsLeaf() const noexcept {
    return firstChild_ == nullptr && secondChild_ == nullptr;
}

void Pane::SetDesiredSplitPosition(double pos) noexcept {
    desiredSplitPosition_ = Clamp01(pos);
}

Pane* Pane::Root() noexcept {
    Pane* node = this;
    while (node->parent_ != nullptr) {
        node = node->parent_;
    }
    return node;
}

// ---- 拆分方向解析 ----

void Pane::ResolveSplit(SplitDirection dir, const Rect& sizeHint,
                        SplitState& state, bool& newIsFirst) {
    if (dir == SplitDirection::Automatic) {
        // 长边决定:宽>高 → 竖直分割(左右);否则 → 水平分割(上下)。
        dir = (sizeHint.width >= sizeHint.height) ? SplitDirection::Right
                                                  : SplitDirection::Down;
    }
    switch (dir) {
    case SplitDirection::Left:
        state = SplitState::Vertical;
        newIsFirst = true;   // 新窗格在左
        break;
    case SplitDirection::Right:
        state = SplitState::Vertical;
        newIsFirst = false;  // 新窗格在右
        break;
    case SplitDirection::Up:
        state = SplitState::Horizontal;
        newIsFirst = true;   // 新窗格在上
        break;
    case SplitDirection::Down:
    default:
        state = SplitState::Horizontal;
        newIsFirst = false;  // 新窗格在下
        break;
    }
}

Pane* Pane::SplitInto(SplitState state, double pos, bool newIsFirst, Ptr incoming) {
    // 前置:this 必须是叶子。原会话下沉成一个新叶子。
    auto existing = std::make_unique<Pane>();
    existing->content_ = std::move(content_);
    existing->parent_ = this;

    incoming->parent_ = this;
    Pane* newPanePtr = incoming.get();

    if (newIsFirst) {
        firstChild_ = std::move(incoming);
        secondChild_ = std::move(existing);
    } else {
        firstChild_ = std::move(existing);
        secondChild_ = std::move(incoming);
    }

    content_ = LeafContent{};   // this 已不再是叶子
    splitState_ = state;
    desiredSplitPosition_ = Clamp01(pos);
    return newPanePtr;
}

Pane* Pane::Split(SplitDirection dir, double splitPosition, LeafContent newLeaf) {
    if (!IsLeaf()) {
        return nullptr;   // 只能对叶子拆分
    }
    SplitState state;
    bool newIsFirst;
    ResolveSplit(dir, layout_, state, newIsFirst);
    return SplitInto(state, splitPosition, newIsFirst,
                     std::make_unique<Pane>(std::move(newLeaf)));
}

// ---- 交换 ----

void Pane::ReparentChildren() noexcept {
    if (firstChild_) firstChild_->parent_ = this;
    if (secondChild_) secondChild_->parent_ = this;
}

bool Pane::IsRelated(const Pane* a, const Pane* b) noexcept {
    for (const Pane* p = b; p != nullptr; p = p->parent_) {
        if (p == a) return true;
    }
    for (const Pane* p = a; p != nullptr; p = p->parent_) {
        if (p == b) return true;
    }
    return false;
}

bool Pane::Swap(Pane* a, Pane* b) {
    if (a == nullptr || b == nullptr || a == b) {
        return false;
    }
    // 祖先/后代之间交换会破坏树结构,拒绝(镜像 WT 的约束)。
    if (IsRelated(a, b)) {
        return false;
    }
    // 交换节点“身份”:子树 + 会话 + 分裂参数;保留各自的 parent_ / id_ / layout_ 槽位。
    std::swap(a->firstChild_, b->firstChild_);
    std::swap(a->secondChild_, b->secondChild_);
    std::swap(a->splitState_, b->splitState_);
    std::swap(a->desiredSplitPosition_, b->desiredSplitPosition_);
    std::swap(a->content_, b->content_);
    std::swap(a->zoomed_, b->zoomed_);
    a->ReparentChildren();
    b->ReparentChildren();
    return true;
}

// ---- 摘下 / 挂上 / 移动 ----

void Pane::AdoptFrom(Ptr source) noexcept {
    content_ = std::move(source->content_);
    splitState_ = source->splitState_;
    desiredSplitPosition_ = source->desiredSplitPosition_;
    zoomed_ = source->zoomed_;
    firstChild_ = std::move(source->firstChild_);
    secondChild_ = std::move(source->secondChild_);
    ReparentChildren();
    // 保留自身 id_ / parent_:节点在树中的“位置”不变,只是内容换了。
}

Pane::Ptr Pane::Detach(Pane* target) {
    if (target == nullptr) {
        return nullptr;
    }
    Pane* parent = target->parent_;
    if (parent == nullptr) {
        return nullptr;   // 根不可摘
    }
    const bool targetIsFirst = (parent->firstChild_.get() == target);

    Ptr detached = std::move(targetIsFirst ? parent->firstChild_ : parent->secondChild_);
    Ptr sibling = std::move(targetIsFirst ? parent->secondChild_ : parent->firstChild_);

    detached->parent_ = nullptr;

    // 兄弟顶替:parent 折叠成 sibling(原地,parent 的槽位不变)。
    parent->AdoptFrom(std::move(sibling));
    return detached;
}

Pane* Pane::Attach(SplitDirection dir, double splitPosition, Ptr subtree) {
    if (!IsLeaf() || subtree == nullptr) {
        return nullptr;   // 与 Split 对称,只挂到叶子上
    }
    SplitState state;
    bool newIsFirst;
    ResolveSplit(dir, layout_, state, newIsFirst);
    return SplitInto(state, splitPosition, newIsFirst, std::move(subtree));
}

Pane* Pane::Move(Pane* movingPane, Pane* targetLeaf,
                 SplitDirection dir, double splitPosition) {
    if (movingPane == nullptr || targetLeaf == nullptr) {
        return nullptr;
    }
    // 调用方须保证 targetLeaf 不在 movingPane 子树内、也不是其将被折叠的父节点。
    Ptr detached = Detach(movingPane);
    if (detached == nullptr) {
        return nullptr;
    }
    return targetLeaf->Attach(dir, splitPosition, std::move(detached));
}

// ---- 遍历 ----

void Pane::WalkTree(const Visitor& fn) {
    fn(*this);
    if (firstChild_) firstChild_->WalkTree(fn);
    if (secondChild_) secondChild_->WalkTree(fn);
}

void Pane::WalkTree(const ConstVisitor& fn) const {
    fn(*this);
    if (firstChild_) firstChild_->WalkTree(fn);
    if (secondChild_) secondChild_->WalkTree(fn);
}

void Pane::CollectLeaves(std::vector<Pane*>& out) {
    if (IsLeaf()) {
        out.push_back(this);
        return;
    }
    if (firstChild_) firstChild_->CollectLeaves(out);
    if (secondChild_) secondChild_->CollectLeaves(out);
}

Pane* Pane::FindZoomed() {
    Pane* found = nullptr;
    WalkTree([&](Pane& p) {
        if (found == nullptr && p.IsLeaf() && p.IsZoomed()) {
            found = &p;
        }
    });
    return found;
}

// ---- 布局 ----

void Pane::ComputeLayout(Rect bounds) {
    layout_ = bounds;
    if (IsLeaf()) {
        return;
    }
    if (splitState_ == SplitState::Vertical) {
        // 左右并排
        const double w1 = bounds.width * desiredSplitPosition_;
        if (firstChild_) {
            firstChild_->ComputeLayout({bounds.x, bounds.y, w1, bounds.height});
        }
        if (secondChild_) {
            secondChild_->ComputeLayout(
                {bounds.x + w1, bounds.y, bounds.width - w1, bounds.height});
        }
    } else {
        // 上下堆叠(Horizontal)
        const double h1 = bounds.height * desiredSplitPosition_;
        if (firstChild_) {
            firstChild_->ComputeLayout({bounds.x, bounds.y, bounds.width, h1});
        }
        if (secondChild_) {
            secondChild_->ComputeLayout(
                {bounds.x, bounds.y + h1, bounds.width, bounds.height - h1});
        }
    }
}

// ---- 方向导航 ----

Pane* Pane::Navigate(Pane* from, Direction dir, Rect bounds) {
    if (from == nullptr || dir == Direction::None) {
        return nullptr;
    }
    Pane* root = Root();
    root->ComputeLayout(bounds);

    std::vector<Pane*> leaves;
    root->CollectLeaves(leaves);

    const Rect f = from->layout_;
    const bool horizontal = (dir == Direction::Left || dir == Direction::Right);

    Pane* best = nullptr;
    double bestOverlap = 0.0;
    double bestGap = std::numeric_limits<double>::max();
    double bestPerp = std::numeric_limits<double>::max();

    for (Pane* leaf : leaves) {
        if (leaf == from) continue;
        const Rect c = leaf->layout_;

        // 1) 必须整体位于目标方向的一侧。
        double gap;   // 沿导航轴的间距(越小越近)
        switch (dir) {
        case Direction::Left:
            if (c.right() > f.x + kEps) continue;
            gap = f.x - c.right();
            break;
        case Direction::Right:
            if (c.x + kEps < f.right()) continue;
            gap = c.x - f.right();
            break;
        case Direction::Up:
            if (c.bottom() > f.y + kEps) continue;
            gap = f.y - c.bottom();
            break;
        case Direction::Down:
        default:
            if (c.y + kEps < f.bottom()) continue;
            gap = c.y - f.bottom();
            break;
        }
        if (gap < -kEps) continue;

        // 2) 在垂直于导航轴的方向上要有重叠,否则不算相邻。
        double overlap;
        double perp;   // 中心在垂直轴上的偏差(用于打破平局)
        if (horizontal) {
            overlap = std::min(f.bottom(), c.bottom()) - std::max(f.y, c.y);
            perp = std::abs(f.centerY() - c.centerY());
        } else {
            overlap = std::min(f.right(), c.right()) - std::max(f.x, c.x);
            perp = std::abs(f.centerX() - c.centerX());
        }
        if (overlap <= kEps) continue;

        // 3) 择优:先最近(gap),再重叠最多,再中心最贴合。
        const bool better =
            (gap + kEps < bestGap) ||
            (std::abs(gap - bestGap) <= kEps && overlap > bestOverlap + kEps) ||
            (std::abs(gap - bestGap) <= kEps &&
             std::abs(overlap - bestOverlap) <= kEps && perp < bestPerp);

        if (best == nullptr || better) {
            best = leaf;
            bestGap = gap;
            bestOverlap = overlap;
            bestPerp = perp;
        }
    }
    return best;
}

} // namespace wtm::pane


// ============================================================================
// 自测:定义 WTM_PANE_SELFTEST 编译本文件即可得到一个断言 split/swap/navigate 的
// 独立可执行入口(不与 app 的 main 冲突)。例如:
//   c++ -std=c++17 -DWTM_PANE_SELFTEST -I src src/pane/Pane.cpp -o pane_selftest
// ============================================================================
#ifdef WTM_PANE_SELFTEST

#include <cassert>
#include <cstdio>

using namespace wtm::pane;

int main() {
    // --- Split:单叶子拆成左右两块 ---
    auto root = std::make_unique<Pane>(LeafContent{1, "A"});
    assert(root->IsLeaf());

    Pane* paneB = root->Split(SplitDirection::Right, 0.5, LeafContent{2, "B"});
    assert(paneB != nullptr);
    assert(!root->IsLeaf());
    assert(root->GetSplitState() == SplitState::Vertical);
    // 原会话 A 应下沉到 firstChild,新会话 B 在 secondChild。
    assert(root->FirstChild()->Content().terminalId == 1);
    assert(root->SecondChild()->Content().terminalId == 2);
    assert(paneB == root->SecondChild());
    assert(paneB->Parent() == root.get());

    // 叶子计数 = 2
    {
        std::vector<Pane*> leaves;
        root->CollectLeaves(leaves);
        assert(leaves.size() == 2);
    }

    // --- 再拆:把 B 向下拆出 C ---
    Pane* paneA = root->FirstChild();
    Pane* paneC = paneB->Split(SplitDirection::Down, 0.5, LeafContent{3, "C"});
    assert(paneB->GetSplitState() == SplitState::Horizontal);
    assert(paneC->Content().terminalId == 3);
    {
        std::vector<Pane*> leaves;
        root->CollectLeaves(leaves);
        assert(leaves.size() == 3);
    }
    // paneB 现在是分裂节点;它的第一个子承载会话 2。
    Pane* leafB = paneB->FirstChild();
    assert(leafB->Content().terminalId == 2);

    // --- Swap:交换 A 与 C 两个叶子的会话 ---
    assert(Pane::Swap(paneA, paneC));
    assert(paneA->Content().terminalId == 3);
    assert(paneC->Content().terminalId == 1);
    // 祖先/后代之间交换应被拒绝。
    assert(!Pane::Swap(root.get(), paneA));
    assert(!Pane::Swap(paneB, leafB));

    // --- Navigate:布局 root=[0,0,1,1],从 A(左)向右应到达 B 或 C 一侧 ---
    // 结构:root(V) = [ A | B(H)=[ leafB / leafC ] ]
    root->ComputeLayout({0.0, 0.0, 1.0, 1.0});
    Pane* rightOfA = root->Navigate(paneA, Direction::Right);
    assert(rightOfA != nullptr);
    assert(rightOfA == leafB || rightOfA == paneC);
    // 从 leafB(右上)向下应到 leafC(右下)。
    Pane* belowB = root->Navigate(leafB, Direction::Down);
    assert(belowB == paneC);
    // 从 leafB 向左应回到 A。
    Pane* leftOfB = root->Navigate(leafB, Direction::Left);
    assert(leftOfB == paneA);
    // 最左侧再往左没有邻居。
    assert(root->Navigate(paneA, Direction::Left) == nullptr);

    // --- Detach + Attach(= Move 的组成)---
    Ptr detachedC = Pane::Detach(paneC);
    assert(detachedC != nullptr);
    // 摘掉 C 后,paneB 折叠成原 leafB(会话 2)。
    {
        std::vector<Pane*> leaves;
        root->CollectLeaves(leaves);
        assert(leaves.size() == 2);
    }
    // 把 C 重新挂回 A 的下方。
    Pane* reattached = paneA->Attach(SplitDirection::Down, 0.5, std::move(detachedC));
    assert(reattached != nullptr);
    assert(reattached->Content().terminalId == 1);   // 被摘下的子树里 C 存的是会话 1
    {
        std::vector<Pane*> leaves;
        root->CollectLeaves(leaves);
        assert(leaves.size() == 3);
    }

    std::puts("PaneCore self-test passed.");
    return 0;
}

#endif  // WTM_PANE_SELFTEST
