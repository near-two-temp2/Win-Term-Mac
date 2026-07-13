// Win-Term-Mac · C++ 方案 入口(整合层)
//
// 本文件是「整合 agent」的地盘:把四个功能角色产出的模块装配起来,让 App 启动后
//   能真正:开窗 → 显示一个跑着 shell 的真终端 → 敲命令 → 切分 / Alt+方向切焦点 →
//   Ctrl/Cmd+Shift+P 呼出命令面板。
//
// 装配拓扑(自底向上,复用各角色既有接口,不另造一套):
//   term    : TerminalSession   —— 一个 shell 子进程 + libvterm 解析出的字符网格。
//   render  : TerminalView      —— 把某个 session 逐格画出并转发键盘输入的 QWidget。
//   pane    : pane::Pane        —— 窗格二叉树(叶=终端,分裂节点=方向+比例+两子)。
//   io      : PaneTerminalBridge—— 窗格树 <-> 真实 shell 的 IO 编排(attach/layout/route)。
//   cmd     : CommandCoordinator—— 顶层装配:keymap + 命令面板 + 窗格树 + IO 桥的总控。
//
//   main 只做「接线」:建中央容器 → 建 bridge → 建 coordinator → initialize()
//   → 安装全局事件过滤器(热键)→ 容器 resize 时 relayout()(驱动 PTY winsize)。
//   所有窗格 / 终端 / 面板逻辑都在 coordinator 里,main 不重复实现。

#include <QApplication>
#include <QMainWindow>
#include <QWidget>
#include <QResizeEvent>
#include <QLabel>
#include <QVBoxLayout>
#include <QFont>
#include <QPalette>
#include <QColor>
#include <QString>
#include <QStringList>

#include "io/PaneTerminalBridge.h"
#include "cmd/CommandCoordinator.h"

namespace wtm {

// 中央容器:承载所有终端视图(coordinator 把各叶子 view setGeometry 到本容器坐标系)。
// 它唯一的职责是把自身尺寸变化转告 coordinator,由后者重排窗格几何 → 驱动 PTY resize。
class PaneHost : public QWidget {
public:
    explicit PaneHost(QWidget* parent = nullptr) : QWidget(parent) {
        setAutoFillBackground(true);
        QPalette pal = palette();
        pal.setColor(QPalette::Window, QColor(0x1e, 0x1e, 0x1e));
        setPalette(pal);
        // 让容器本身不抢键盘焦点,输入应落到具体的终端视图上。
        setFocusPolicy(Qt::NoFocus);
    }

    // coordinator 在容器之后创建,故用 setter 回填。
    void setCoordinator(cmd::CommandCoordinator* coord) { coord_ = coord; }

protected:
    void resizeEvent(QResizeEvent* e) override {
        QWidget::resizeEvent(e);
        if (coord_) coord_->relayout();   // 唯一的「窗口 resize → 通知 pty」漏斗(经 IO 桥)
    }

private:
    cmd::CommandCoordinator* coord_ = nullptr;   // 不拥有(MainWindow 持有其生命周期)
};

// 主窗口:承载中央窗格容器 + 装配 IO 桥与命令协调器。
class MainWindow : public QMainWindow {
public:
    MainWindow() {
        setWindowTitle(QStringLiteral("Win-Term-Mac (C++/Qt)"));
        resize(1024, 640);

        host_ = new PaneHost(this);
        setCentralWidget(host_);

        // IO 桥:窗格 <-> shell 会话。以 MainWindow 为 Qt 父,随窗口析构。
        bridge_ = new io::PaneTerminalBridge(this);

        // 命令协调器:顶层装配。bridge / host 不被它接管,由本窗口持有。
        coord_ = new cmd::CommandCoordinator(bridge_, host_, this);
        host_->setCoordinator(coord_);

        // 建根叶子 + 接一份终端(起默认 shell)+ 首次布局 + 抢焦点。
        // 失败(如 Windows ConPTY 尚为 TODO 桩,shell 起不来)时展示占位提示。
        const bool ok = coord_->initialize();
        if (!ok) {
            showStartupFallback();
        }

        // 全局热键:窗口级事件过滤器,让 Split / Focus / 命令面板等热键在
        // 「面板未开且尚无终端聚焦」时也能被 coordinator 吃到。
        // (coordinator 另给每个 TerminalView 单独装了过滤器,二者已去重、并存不冲突。)
        installEventFilter(coord_);

        // 标题跟随聚焦窗格的会话标题(OSC 标题)。
        connect(bridge_, &io::PaneTerminalBridge::paneTitleChanged, this,
                [this](std::uint32_t, const QString& title) {
                    if (!title.isEmpty()) {
                        setWindowTitle(QStringLiteral("Win-Term-Mac — ") + title);
                    }
                });

        // 最后一个窗格关闭 → 关窗。
        connect(coord_, &cmd::CommandCoordinator::lastPaneClosed, this,
                [this]() { close(); });
    }

private:
    // shell 起不来时的占位:说明可能原因(而非静默黑屏)。
    void showStartupFallback() {
        auto* layout = new QVBoxLayout(host_);
        layout->setContentsMargins(16, 16, 16, 16);
        auto* label = new QLabel(
            QStringLiteral(
                "wintermmac · 无法启动 shell\n"
                "可能原因:Windows ConPTY 后端仍为 TODO(见 term/TerminalSession.cpp),\n"
                "或未链接 libvterm。Unix(forkpty)路径下应正常起 shell。"),
            host_);
        label->setAlignment(Qt::AlignTop | Qt::AlignLeft);
        QFont mono(QStringLiteral("Menlo"));
        mono.setStyleHint(QFont::Monospace);
        mono.setPointSize(12);
        label->setFont(mono);
        QPalette lp = label->palette();
        lp.setColor(QPalette::WindowText, QColor(0xcc, 0xcc, 0xcc));
        label->setPalette(lp);
        layout->addWidget(label);
        layout->addStretch();
    }

    PaneHost* host_ = nullptr;                 // 中央容器(Qt 子对象,随窗口析构)
    io::PaneTerminalBridge* bridge_ = nullptr; // IO 桥(Qt 子对象)
    cmd::CommandCoordinator* coord_ = nullptr; // 命令协调器(Qt 子对象)
};

} // namespace wtm

int main(int argc, char* argv[]) {
    QApplication app(argc, argv);
    QApplication::setApplicationName(QStringLiteral("wintermmac"));

    wtm::MainWindow window;
    window.show();

    return app.exec();
}
