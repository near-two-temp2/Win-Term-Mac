// Win-Term-Mac · C++ 方案 · PaneCore
// 窗格二叉树内核。镜像 Windows Terminal 的 Pane 结构:
//   节点 = 叶子(承载一个真实终端会话) 或 分裂节点(方向 + 比例 + first/second 两个子节点)。
// 本文件是纯 C++17,不依赖 Qt,便于单元断言;渲染/终端接入由上层(render/term)负责。
//
// 术语对齐 WT:
//   splitState        —— None(叶子) / Vertical(竖直分割线,左右并排) / Horizontal(水平分割线,上下堆叠)
//   desiredSplitPosition —— 0~1,第一个子占分裂轴的比例
//   firstChild/secondChild —— 两个子树

#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace wtm::pane {

// 分裂状态:与 WT 的 SplitState 对齐。
enum class SplitState {
    None,        // 叶子,无分裂
    Vertical,    // 竖直分割线 → 左右两块
    Horizontal   // 水平分割线 → 上下两块
};

// 拆分方向(高频热键触发):新窗格出现在哪一侧。
//   WT 默认:Right = Alt+Shift++,Down = Alt+Shift+-
enum class SplitDirection {
    Right,
    Down,
    Left,
    Up,
    Automatic   // 按当前尺寸自动选长边;由 Split 解析成具体方向
};

// 焦点导航方向(Alt/Cmd + 方向键)。
enum class Direction { None, Left, Right, Up, Down };

// 归一化/像素皆可的矩形;ComputeLayout 用它给每个节点算几何位置。
struct Rect {
    double x = 0.0;
    double y = 0.0;
    double width = 0.0;
    double height = 0.0;

    double right() const { return x + width; }
    double bottom() const { return y + height; }
    double centerX() const { return x + width * 0.5; }
    double centerY() const { return y + height * 0.5; }
};

// 叶子承载的终端会话占位。
// TODO(term/pty): 把 terminalId 换成真实 TerminalControl* / 会话句柄。
struct LeafContent {
    uint32_t terminalId = 0;   // 占位:未来指向真实 PTY/VT 会话
    std::string title;         // 调试 & 命令面板展示用
};

class Pane {
public:
    using Ptr = std::unique_ptr<Pane>;
    using Visitor = std::function<void(Pane&)>;
    using ConstVisitor = std::function<void(const Pane&)>;

    // 构造一个叶子(默认空会话)。
    explicit Pane(LeafContent content = {});
    ~Pane() = default;

    Pane(const Pane&) = delete;
    Pane& operator=(const Pane&) = delete;

    // ---- 查询 ----
    bool IsLeaf() const noexcept;
    SplitState GetSplitState() const noexcept { return splitState_; }
    double GetDesiredSplitPosition() const noexcept { return desiredSplitPosition_; }
    void SetDesiredSplitPosition(double pos) noexcept;

    Pane* Parent() const noexcept { return parent_; }
    Pane* FirstChild() const noexcept { return firstChild_.get(); }
    Pane* SecondChild() const noexcept { return secondChild_.get(); }
    uint32_t Id() const noexcept { return id_; }

    const LeafContent& Content() const noexcept { return content_; }
    LeafContent& Content() noexcept { return content_; }

    // 定位到树根(this 也可能就是根)。
    Pane* Root() noexcept;

    // ---- 核心操作 ----

    // 把这个叶子拆成分裂节点。返回新建的那个叶子。
    // 仅能对叶子调用;this 原地变成分裂节点,原会话下沉到其中一个子叶子(镜像 WT)。
    Pane* Split(SplitDirection dir, double splitPosition, LeafContent newLeaf);

    // 交换两个窗格(叶子或整棵子树都可),并修正 parent 指针。
    // 命令面板 swapPane 触发(默认无热键)。返回是否成功(祖先/后代关系拒绝)。
    static bool Swap(Pane* a, Pane* b);

    // 摘下一棵子树连同其会话,并原地折叠其父节点(兄弟顶替父的位置)。
    // 返回被摘下的、独立自持的子树;若 target 是根则返回 nullptr。拖拽移动的基础。
    static Ptr Detach(Pane* target);

    // 把一棵已存在的子树挂到本叶子上(等价于用现成子树做一次 split)。返回挂上的子树根指针。
    Pane* Attach(SplitDirection dir, double splitPosition, Ptr subtree);

    // 移动 = Detach + Attach。返回移动后 movingPane 的新位置指针,失败返回 nullptr。
    // 注意:Detach 会原地折叠 movingPane 的父节点,调用方须保证 targetLeaf 不在被移动子树内。
    static Pane* Move(Pane* movingPane, Pane* targetLeaf,
                      SplitDirection dir, double splitPosition);

    // 方向键导航:从 from 叶子出发,按几何相邻找目标叶子。找不到返回 nullptr。
    // bounds 是根的外框(默认单位方框);内部会重算布局。
    Pane* Navigate(Pane* from, Direction dir, Rect bounds = {0.0, 0.0, 1.0, 1.0});

    // 前序遍历整棵子树。
    void WalkTree(const Visitor& fn);
    void WalkTree(const ConstVisitor& fn) const;

    // 收集本子树所有叶子(按前序)。
    void CollectLeaves(std::vector<Pane*>& out);

    // ---- 布局 ----
    // 给定外框,递归给每个节点算矩形(存入 layout_)。
    void ComputeLayout(Rect bounds);
    const Rect& Layout() const noexcept { return layout_; }

    // ---- 最大化 / 还原(仅记录状态,真正的独占渲染交给上层) ----
    void SetZoomed(bool z) noexcept { zoomed_ = z; }
    bool IsZoomed() const noexcept { return zoomed_; }
    // 在本子树里找当前被最大化的叶子(没有则 nullptr)。
    Pane* FindZoomed();

private:
    // 把 dir(可能是 Automatic)解析成 (state, 新窗格是否放 firstChild)。
    // sizeHint 用于 Automatic:宽>高则竖直分割(左右),否则水平分割(上下)。
    static void ResolveSplit(SplitDirection dir, const Rect& sizeHint,
                             SplitState& state, bool& newIsFirst);

    // 把本叶子原地变成分裂节点:原会话下沉成一个子叶子,incoming 作为另一个子。
    Pane* SplitInto(SplitState state, double pos, bool newIsFirst, Ptr incoming);

    // 修正直接子节点的 parent_ 指针指回 this。
    void ReparentChildren() noexcept;

    // 把 source 的内容/子树整体搬进 this(this 的子槽须已为空),用于折叠。
    void AdoptFrom(Ptr source) noexcept;

    // a 是否是 b 的祖先或后代(含相等);Swap 用它拒绝非法交换。
    static bool IsRelated(const Pane* a, const Pane* b) noexcept;

    static uint32_t NextId() noexcept;

    // ---- 状态 ----
    uint32_t id_ = 0;
    SplitState splitState_ = SplitState::None;
    double desiredSplitPosition_ = 0.5;  // 0~1

    Ptr firstChild_;
    Ptr secondChild_;
    Pane* parent_ = nullptr;   // 非拥有

    LeafContent content_;      // 仅叶子有意义
    bool zoomed_ = false;

    Rect layout_;              // 最近一次 ComputeLayout 的结果
};

} // namespace wtm::pane
