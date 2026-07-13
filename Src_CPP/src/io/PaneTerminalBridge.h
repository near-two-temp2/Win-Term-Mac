// Win-Term-Mac · C++ 方案 · io 角色
// PaneTerminalBridge:窗格树 <-> 真实 shell 会话 的 IO 桥。
//
// 职责边界(本类是「IO 编排层」,不重复造终端也不造窗格):
//   1. 生命周期绑定:给一个叶子窗格(pane::Pane 叶)接一份真实终端
//      —— 复用 render 角色的 TerminalView(内含 term 角色的 TerminalSession + PTY)。
//      把新会话的 id 写回 LeafContent.terminalId,建立 terminalId <-> view 的登记表。
//   2. resize -> PTY 的总漏斗:窗口缩放 / 分裂 / 交换后,窗格树的几何变了,
//      本桥用 Pane::ComputeLayout 把树布局解析成像素矩形,逐叶 setGeometry 给对应 view;
//      view 的 resizeEvent 会把新 cols/rows 同步给 TerminalSession,后者再同步 PTY winsize。
//      => 「窗口 resize -> 通知 pty」在多窗格场景下的唯一入口就是 applyLayout()。
//   3. 输入路由(复用会话输入原语):把文本/焦点投递到指定叶子;可选「广播输入」
//      (WT 的 broadcast input:一次键入喂给所有活动叶子)。键盘按键的翻译仍由
//      TerminalView::keyPressEvent 负责,本桥只做「哪个会话该收」的路由与焦点。
//   4. 信号上抛:会话标题变化 / 子进程退出,带上 terminalId 抛给集成层,
//      让它更新窗格标题或关闭/回收该叶子。
//
// 明确不做:不解析 VT(term 做)、不画像素/不翻译按键字节(render 做)、
// 不实现窗格树算法(pane 做)、不注册热键(keymap/palette 做)。
//
// ── 集成说明(integrator 需要如何调用我)────────────────────────────────────
//   构建:把 src/io/PaneTerminalBridge.cpp 加入 CMake 的 SOURCES(AUTOMOC 已开,
//         Q_OBJECT 会被 moc 处理)。无新依赖 —— 仅经 TerminalView 间接用 Qt6::Widgets,
//         并依赖 pane/Pane.h(纯 C++,已在 include 路径内)。同时需把
//         src/render/TerminalView.cpp 与 src/term/TerminalSession.cpp 一并编入,
//         并链接 libvterm(见 TerminalSession.cpp 末尾的 CMake TODO)。
//   典型接线(集成层持有一个 PaneTerminalBridge 成员 bridge_,和窗格树根 root_):
//       // 1) 建根叶子并接终端:
//       auto* view = bridge_.attachLeaf(*rootLeaf, centralContainer);  // 起默认 shell
//       // 2) 每当窗口/分裂/交换导致布局变化,推一次几何(驱动 PTY resize):
//       bridge_.applyLayout(*root_, centralContainer->rect());
//       // 3) 分裂:pane 角色 Split() 产生新叶子后,给新叶子接终端,再 applyLayout:
//       pane::Pane* leaf = paneToSplit->Split(dir, 0.5, {});
//       bridge_.attachLeaf(*leaf, centralContainer);
//       bridge_.applyLayout(*root_, centralContainer->rect());
//       // 4) 关注退出/标题:
//       connect(&bridge_, &wtm::io::PaneTerminalBridge::paneExited, this,
//               [this](uint32_t id, int){ /* 关闭该叶子并 applyLayout */ });
//   焦点:各 TerminalView 默认 StrongFocus,点击即可打字;Alt+方向切焦点由集成层
//         在更高层拦截后调用 bridge_.focusLeaf(id)。
//   生命周期:attachLeaf 创建的 view 以 container 为 Qt 父对象(Qt 负责析构);
//         本桥仅持弱引用登记,view 被销毁时自动从登记表摘除。detachLeaf() 主动收尾。

#ifndef WTM_IO_PANETERMINALBRIDGE_H
#define WTM_IO_PANETERMINALBRIDGE_H

#include <QObject>
#include <QHash>
#include <QList>
#include <QString>
#include <QStringList>
#include <QRect>

#include <cstdint>

#include "pane/Pane.h"

class QWidget;

namespace wtm {

class TerminalView;
class TerminalSession;

namespace io {

// 窗格树 <-> shell 会话 的 IO 编排桥。QObject:用信号把「带 id 的」标题/退出上抛。
class PaneTerminalBridge : public QObject {
    Q_OBJECT

public:
    explicit PaneTerminalBridge(QObject* parent = nullptr);
    ~PaneTerminalBridge() override;

    PaneTerminalBridge(const PaneTerminalBridge&) = delete;
    PaneTerminalBridge& operator=(const PaneTerminalBridge&) = delete;

    // ---- 生命周期绑定 ----

    // 给一个叶子窗格接一份真实终端:内部 new TerminalView(container) + startShell()。
    // 成功时:分配一个 terminalId,写回 leaf.Content().terminalId,登记 id->view,
    //   连接 view 的 titleChanged/sessionExited 以带 id 上抛;返回该 view。
    // 失败(shell 起不来):删除半成品 view,返回 nullptr,leaf 不被改动。
    // 注:仅对叶子有意义;若传入非叶子节点,直接返回 nullptr。
    TerminalView* attachLeaf(pane::Pane& leaf, QWidget* container,
                             const QString& program = QString(),
                             const QStringList& args = QStringList());

    // 主动收尾一个叶子的终端:结束 shell 并销毁其 view(Qt deleteLater)。
    // 幂等:未知 id 直接返回。销毁不清空 LeafContent.terminalId(由 pane 角色决定去留)。
    void detachLeaf(std::uint32_t terminalId);

    // ---- 查询 ----
    TerminalView*    viewFor(std::uint32_t terminalId) const;
    TerminalSession* sessionFor(std::uint32_t terminalId) const;
    bool             hasTerminal(std::uint32_t terminalId) const;
    QList<std::uint32_t> liveTerminals() const;

    // ---- resize -> PTY 的总漏斗 ----

    // 用 Pane::ComputeLayout 把窗格树解析成像素矩形,逐叶把几何推给对应 view。
    // view.setGeometry 触发 resizeEvent -> session.resize -> PTY winsize。
    // 窗口缩放 / 分裂 / 交换 / 最大化 之后都应调它一次。
    // pixelBounds 是承载窗格的容器像素区域(通常 container->rect())。
    void applyLayout(pane::Pane& root, const QRect& pixelBounds);

    // ---- 输入路由(复用 TerminalSession 输入原语)----

    // 把焦点交给某叶子的 view(随后键盘输入经 view->session 落到该 shell)。
    void focusLeaf(std::uint32_t terminalId);

    // 直接把文本投递给某叶子的会话(粘贴 / 编程式输入;不经过 view 的按键翻译)。
    void sendTextToLeaf(std::uint32_t terminalId, const QString& text);

    // 广播输入(WT broadcast input):把同一段文本喂给所有活动叶子。
    void broadcastText(const QString& text);

signals:
    // 某叶子会话标题变了(OSC);集成层可更新窗格/标签标题。
    void paneTitleChanged(std::uint32_t terminalId, const QString& title);
    // 某叶子 shell 退出;集成层据此关闭并回收该窗格(随后再 applyLayout)。
    void paneExited(std::uint32_t terminalId, int exitCode);

private:
    std::uint32_t nextId() noexcept;

    // id -> view 的弱引用登记(view 的所有权在 Qt 父对象即 container 手里)。
    QHash<std::uint32_t, TerminalView*> views_;
    std::uint32_t idSeq_ = 0;
};

} // namespace io
} // namespace wtm

#endif // WTM_IO_PANETERMINALBRIDGE_H
