// Win-Term-Mac · C++ 方案 · cmd 角色(命令面板 + 键位接线)· 装配核心
//
// CommandCoordinator:把 keymap(键位模型)、palette(命令面板)、pane(窗格二叉树)、
//   io(终端 IO 桥)四个已有子系统「装配」到一起,让 split / swap / move / focus /
//   resize / zoom / close 这些意图真正作用到窗格树与终端视图。
//
//   数据流:
//     QKeyEvent ──translateKeyEvent──▶ KeyChord ──Keymap.Lookup──▶ ActionId
//       ├─ ActionId::ToggleCommandPalette → 开/关 CommandPaletteWidget
//       └─ 其它 ActionId ─────────────────▶ dispatch(action) ─▶ 落到 Pane 树 + Bridge
//     命令面板里选中一条命令 → 同一个 dispatch(action)(swap/move 只有这条路)。
//
//   谁拥有什么:
//     - 本协调器「拥有」窗格二叉树的根(root_,unique_ptr)与命令面板浮层 widget。
//     - 「不拥有」PaneTerminalBridge 与承载窗格的 container(由集成层持有)。
//
// 硬规则落地:
//   - swap / move 无默认热键(Keymap::Bind 会拒绝绑定它们),只能经命令面板触发。
//   - 高频操作(split / focus / resize / zoom / close / 呼出面板)走热键 + 面板双通道,
//     两条路都汇入同一个 dispatch(),行为一致。
//
// ── 集成说明(integrator 需要如何调用我)────────────────────────────────────
//   构建:把 src/cmd/*.cpp 全部加入 CMake SOURCES(AUTOMOC 处理 Q_OBJECT),并确保
//         已编入 keymap/、palette/、pane/、io/、render/、term/ 的对应 .cpp,链接 Qt6::Widgets。
//   典型接线(集成层在 MainWindow 里):
//       // container 是承载所有终端视图的中央 QWidget(窗格都 setGeometry 到它的坐标系)。
//       auto* bridge = new wtm::io::PaneTerminalBridge(this);
//       auto* coord  = new wtm::cmd::CommandCoordinator(bridge, container, this);
//       coord->initialize();                 // 建根叶子 + 接终端 + 布局 + 抢焦点
//       // 1) 全局热键:在 MainWindow 上装事件过滤器,把按键先给协调器过一遍。
//       qApp->installEventFilter(coord);     // 或 mainWindow->installEventFilter(coord)
//       // 2) 容器尺寸变化时重排(驱动 PTY resize):
//       //    在 container 的 resizeEvent 里调 coord->relayout();
//       // 3) 关注最后一个窗格关闭(据此关标签/关窗):
//       connect(coord, &wtm::cmd::CommandCoordinator::lastPaneClosed, this, [...]{ ... });
//   备注:协调器给它 attachLeaf 出来的每个 TerminalView 都装了事件过滤器,用来
//         (a)截获全局热键、(b)跟踪点击焦点。因此 installEventFilter(coord) 主要
//         用于「面板未打开且尚无终端聚焦」时也能吃到热键;二者并存不冲突(已去重)。

#ifndef WTM_CMD_COMMANDCOORDINATOR_H
#define WTM_CMD_COMMANDCOORDINATOR_H

#include <QObject>
#include <QString>
#include <QStringList>

#include <cstdint>
#include <memory>

#include "keymap/Keymap.h"
#include "pane/Pane.h"

class QWidget;
class QEvent;

namespace wtm {

namespace io { class PaneTerminalBridge; }

namespace cmd {

class CommandPaletteWidget;

class CommandCoordinator : public QObject {
    Q_OBJECT

public:
    // bridge / container 均不被本类接管(集成层持有其生命周期)。
    CommandCoordinator(io::PaneTerminalBridge* bridge, QWidget* container,
                       QObject* parent = nullptr);
    ~CommandCoordinator() override;

    CommandCoordinator(const CommandCoordinator&) = delete;
    CommandCoordinator& operator=(const CommandCoordinator&) = delete;

    // 建根叶子并接一份终端、装配 keymap + 命令面板、首次布局并把焦点给根终端。
    // 失败(shell 起不来)返回 false;此时 root_ 仍是一个空叶子。
    bool initialize(const QString& program = QString(),
                    const QStringList& args = QStringList());

    // 容器尺寸变化 / 结构变化后重排所有终端视图(含 zoom 独占处理)。
    void relayout();

    // 把一个 ActionId 落到窗格树 + 视图。命令面板与热键共用它。
    void dispatch(keymap::ActionId action);

    // 供集成层查询 / 调试。
    pane::Pane* root() const noexcept { return root_.get(); }
    pane::Pane* focusedLeaf() const noexcept { return focused_; }
    const keymap::Keymap& keymap() const noexcept { return keymap_; }

    // 主动呼出 / 关闭命令面板(热键之外的入口,如菜单项)。
    void openCommandPalette();

    // 集成层若自行管理焦点,可用它告知「当前聚焦的是哪个终端」。
    void notifyFocusedTerminal(std::uint32_t terminalId);

signals:
    // 焦点窗格变化,带上其 terminalId(集成层可更新标题栏 / 高亮边框)。
    void focusedPaneChanged(std::uint32_t terminalId);
    // 最后一个窗格被关闭(集成层据此关标签 / 关窗)。
    void lastPaneClosed();

protected:
    // 全局热键截获 + 终端视图点击焦点跟踪。
    bool eventFilter(QObject* watched, QEvent* event) override;

private:
    // ---- 动作实现(每个都保证结束时 focused_ 仍是合法叶子)----
    void doSplit(pane::SplitDirection dir);
    void doFocus(pane::Direction dir);
    void doResize(pane::Direction dir);
    void doSwap(pane::Direction dir);
    void doMove(pane::Direction dir);
    void doToggleZoom();
    void doClosePane();

    // ---- 工具 ----
    // 给一个叶子接终端并登记事件过滤器(点击焦点跟踪)。返回是否成功。
    bool attachTerminal(pane::Pane& leaf);
    // 把焦点交给某叶子:更新 focused_、让其视图抢焦点、发 focusedPaneChanged。
    void focusLeaf(pane::Pane* leaf);
    // 容器像素外框(供 Navigate / 布局用)。
    pane::Rect containerBounds() const;
    // 修正 focused_:若已失效或不是叶子,回落到某个合法叶子。
    void ensureFocusValid();
    // 子树里前序第一个叶子。
    static pane::Pane* firstLeaf(pane::Pane* node);
    // terminalId -> 树中承载它的叶子(线性查找,窗格数量级很小)。
    pane::Pane* leafForTerminal(std::uint32_t terminalId) const;

    io::PaneTerminalBridge* bridge_ = nullptr;   // 不拥有
    QWidget* container_ = nullptr;               // 不拥有

    std::unique_ptr<pane::Pane> root_;           // 拥有:窗格二叉树根
    pane::Pane* focused_ = nullptr;              // 当前聚焦叶子(root_ 子树内的裸指针)

    keymap::Keymap keymap_;
    CommandPaletteWidget* palette_ = nullptr;    // 拥有(以 container 顶层窗口为 Qt 父)

    double resizeStep_ = 0.05;                   // 每次 resize 调整的分裂比例步长
};

} // namespace cmd
} // namespace wtm

#endif // WTM_CMD_COMMANDCOORDINATOR_H
