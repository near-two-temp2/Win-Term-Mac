// Win-Term-Mac · C++ 方案 · pane 角色(UI 层)
// PaneTreeWidget:把已有的 wtm::pane::Pane 二叉树「接到真实视图」的容器 QWidget。
//   每个叶子窗格 = 一个 render::TerminalView(内含一个真实 shell 会话);本 widget
//   负责:布局(按 Pane 的 splitState/desiredSplitPosition 摆放各叶子视图)、
//   在兄弟之间画可拖拽的分隔条(拖动即改 desiredSplitPosition)、以及把
//   拆分(Alt+Shift+±)/ 切焦点(Alt+方向)/ 调整大小(Alt+Shift+方向)/ 最大化 /
//   关闭 / 交换 / 移动 等动作真正落到 Pane 树上。
//
// ── 关键设计:视图按「稳定会话 id」而非 Pane* 索引 ─────────────────────────────
//   Pane 的树操作会改变节点的 Pane* 身份:Split 把原会话「下沉」到一个新建子叶子;
//   Detach 的 AdoptFrom 把兄弟折叠进父节点(销毁兄弟节点)。但这些操作都是「搬运
//   LeafContent」——即 terminalId 始终跟着会话走。因此我们用 LeafContent.terminalId
//   作为 view 的键(views_: id → TerminalView*),任何树重构后只需重新遍历叶子、
//   按 id 找回视图重新摆放即可,视图/会话生命周期不受树结构变化影响。
//
// 复用的已有接口(不另造一套):
//   - 窗格树/操作:src/pane/Pane.h(Split / Swap / Detach / Attach / Move / Navigate /
//                 CollectLeaves / FindZoomed / SetDesiredSplitPosition ...)
//   - 叶子视图/会话:src/render/TerminalView.h(startShell / setFocus / titleChanged ...)
//   - 键位:src/keymap/Keymap.h(把 Qt 按键翻译成 ActionId,再交给 handleAction)
//
// ── 集成说明(integrator 需要如何调用我)─────────────────────────────────────
//   1) CMake:把 src/pane/Pane.cpp 与 src/pane/PaneTreeWidget.cpp 一并加入 SOURCES,
//      并链接 Qt6::Widgets(AUTOMOC 已开,本类有 Q_OBJECT)。keymap/ 与 render/ 与
//      term/ 的源文件也需在 SOURCES 里。
//   2) 用法:把 PaneTreeWidget 作为主窗口 centralWidget 即可:
//          auto* panes = new wtm::PaneTreeWidget(this);
//          setCentralWidget(panes);          // 首个叶子会自动起一个 shell
//   3) 命令面板 / keymap 派发:把 palette 的 ActionDispatch 直接接到本 widget:
//          palette.BuildDefaultCommands(keymap, [panes](keymap::ActionId a){
//              panes->handleAction(a);
//          });
//      本 widget 内部已对「落在焦点视图上的按键」装了 eventFilter,会用 keymap 把
//      Alt+Shift+± / Alt+方向 等 pane 类按键就地消化;未识别或非 pane 类按键(如
//      Ctrl/Cmd+Shift+P 呼出命令面板)会放行,交由集成层更高层处理。
//   4) 若要自定义会话的 shell/参数,调用 setSessionFactory 注入你自己的 view 工厂。

#ifndef WTM_PANE_PANETREEWIDGET_H
#define WTM_PANE_PANETREEWIDGET_H

#include <QWidget>
#include <QRect>

#include <cstdint>
#include <functional>
#include <unordered_map>
#include <vector>

#include "pane/Pane.h"
#include "keymap/Keymap.h"

class QPaintEvent;
class QResizeEvent;
class QShowEvent;
class QMouseEvent;

namespace wtm {

class TerminalView;

// 窗格树容器视图。承载 Pane 二叉树 + 每个叶子的 TerminalView,并把用户操作落到树上。
class PaneTreeWidget : public QWidget {
    Q_OBJECT

public:
    // 叶子视图工厂:为一个新叶子创建一个 TerminalView(内部应已 start 一个会话)。
    // 默认工厂 = new TerminalView(parent) + startShell()(默认 shell)。
    using SessionFactory = std::function<TerminalView*(QWidget* parent)>;

    explicit PaneTreeWidget(QWidget* parent = nullptr);
    ~PaneTreeWidget() override;

    PaneTreeWidget(const PaneTreeWidget&) = delete;
    PaneTreeWidget& operator=(const PaneTreeWidget&) = delete;

    // 用自定义工厂替换默认 shell 创建逻辑(需在首次布局前调用最稳妥)。
    void setSessionFactory(SessionFactory factory);

    // 替换键位表(默认 keymap::Keymap::DefaultKeymap())。
    void setKeymap(const keymap::Keymap& km) { keymap_ = km; }
    const keymap::Keymap& keymap() const noexcept { return keymap_; }

    // 用一棵外部构造好的窗格树替换当前树(会为所有叶子按需创建视图)。
    // 传入树里叶子的 LeafContent.terminalId 为 0 时会自动分配一个稳定 id。
    void setRoot(pane::Pane::Ptr root);

    pane::Pane* root() const noexcept { return root_.get(); }

    // 当前焦点叶子对应的视图(可能为 nullptr)。
    TerminalView* activeView() const;
    // 当前焦点叶子(可能为 nullptr)。
    pane::Pane* activeLeaf() const;

    // 把一个 keymap 动作落到窗格树上。返回是否被本 widget 处理(消化)。
    // pane/focus/resize/zoom/close/swap/move 会被处理;其余(如命令面板)返回 false。
    bool handleAction(keymap::ActionId action);

signals:
    // 焦点窗格标题变化(集成层可拿去更新窗口/标签标题)。
    void activeTitleChanged(const QString& title);
    // 试图关闭最后一个窗格(集成层可据此关闭窗口或忽略)。
    void lastPaneClosed();

protected:
    void paintEvent(QPaintEvent* e) override;
    void resizeEvent(QResizeEvent* e) override;
    void showEvent(QShowEvent* e) override;
    void mousePressEvent(QMouseEvent* e) override;
    void mouseMoveEvent(QMouseEvent* e) override;
    void mouseReleaseEvent(QMouseEvent* e) override;
    // 拦截落在叶子视图上的按键(pane 热键)与焦点变化(维护 activeTermId_)。
    bool eventFilter(QObject* obj, QEvent* event) override;

private:
    // 一条可拖拽的分隔条:所在像素矩形 + 其分裂节点的整体矩形 + 分裂节点指针 + 朝向。
    struct Handle {
        QRect bar;        // 分隔条本体(命中/绘制用)
        QRect nodeRect;   // 该分裂节点占据的整体矩形(拖动换算比例用)
        pane::Pane* node = nullptr;
        bool vertical = false;  // true=竖直分割线(左右),拖动改变 X;false=水平(上下)
    };

    // 重新布局:清空 handles_、按 Pane 树摆放所有叶子视图、隐藏离场视图。
    void relayout();
    // 递归摆放一个子树到像素矩形 r(叶子→setGeometry;分裂节点→留出 gutter 并记录 handle)。
    void layoutNode(pane::Pane* node, const QRect& r);
    // 摆放一个叶子:确保其视图存在并设几何、显示。
    void placeLeaf(pane::Pane* leaf, const QRect& r);

    // 取(或惰性创建)某叶子的视图。会给无 id 的叶子分配稳定 id。
    TerminalView* ensureView(pane::Pane* leaf);
    // 按会话 id 查视图。
    TerminalView* viewFor(std::uint32_t termId) const;
    // 删除已不再被任何叶子引用的视图(关闭窗格后清理)。
    void reapOrphanViews();

    // 把焦点交给当前 activeTermId_ 对应的视图。
    void focusActive();

    // 命中测试:pos 落在哪条分隔条上(返回 handles_ 下标,未命中 -1)。
    int handleAt(const QPoint& pos) const;

    // 各动作的落地实现。
    bool doSplit(pane::SplitDirection dir);
    bool doFocus(pane::Direction dir);
    bool doResize(pane::Direction dir);
    bool doToggleZoom();
    bool doClose();
    bool doSwap(pane::Direction dir);
    bool doMove(pane::Direction dir);

    // Qt 按键事件 → keymap::KeyChord(不可识别时返回 false)。
    static bool chordFromKeyEvent(const class QKeyEvent* e, keymap::KeyChord& out);
    // 该动作是否由本 widget 消化(pane 类);命令面板等返回 false。
    static bool isPaneAction(keymap::ActionId a) noexcept;

    // 本 widget 的内容区(去掉边距;当前无边距即 rect())。
    QRect contentRect() const;
    // 供 Pane::Navigate 用的像素外框。
    pane::Rect contentBounds() const;

    pane::Pane::Ptr root_;
    std::unordered_map<std::uint32_t, TerminalView*> views_;  // 会话 id → 视图
    std::uint32_t activeTermId_ = 0;
    std::uint32_t nextTermId_ = 1;

    keymap::Keymap keymap_;
    SessionFactory factory_;

    std::vector<Handle> handles_;
    int draggingHandle_ = -1;   // 正在拖动的分隔条下标(-1=未拖动)
    int hoveredHandle_ = -1;    // 悬停的分隔条下标(用于光标形状)
};

} // namespace wtm

#endif // WTM_PANE_PANETREEWIDGET_H
