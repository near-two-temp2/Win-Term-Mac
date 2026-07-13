// Win-Term-Mac · C++ 方案 入口
// M0 目标:三平台各弹出一个空窗口,中央放一块占位终端 widget。
// 真正的 VT 仿真 / 窗格树 / 命令面板由 term、pane、palette 等角色补齐。

#include <QApplication>
#include <QMainWindow>
#include <QLabel>
#include <QWidget>
#include <QVBoxLayout>
#include <QFont>
#include <QPalette>
#include <QColor>

namespace wtm {

// 占位终端 widget。
// TODO(term/render): 用真正的终端网格(libvterm 或移植 WT TerminalCore
// + GPU 字形图集)替换本占位;此处只画一块深色底 + 提示文字,证明开窗成功。
class PlaceholderTerminal : public QWidget {
public:
    explicit PlaceholderTerminal(QWidget* parent = nullptr) : QWidget(parent) {
        setAutoFillBackground(true);

        // 深色终端底色
        QPalette pal = palette();
        pal.setColor(QPalette::Window, QColor(0x1e, 0x1e, 0x1e));
        pal.setColor(QPalette::WindowText, QColor(0xcc, 0xcc, 0xcc));
        setPalette(pal);

        auto* layout = new QVBoxLayout(this);
        layout->setContentsMargins(16, 16, 16, 16);

        auto* label = new QLabel(
            QStringLiteral("wintermmac · 占位终端\n"
                           "TODO: 接入 VT 仿真 + PTY(term/pty 角色)"),
            this);
        label->setAlignment(Qt::AlignTop | Qt::AlignLeft);

        QFont mono(QStringLiteral("Menlo"));
        mono.setStyleHint(QFont::Monospace);
        mono.setPointSize(12);
        label->setFont(mono);

        layout->addWidget(label);
        layout->addStretch();
    }
};

// 主窗口:承载(未来的)标签页 + 窗格树。
// TODO(app/pane): 中央 widget 换成窗格树根容器(QSplitter 或自绘分割条),
// 并接入命令面板(Ctrl/Cmd+Shift+P)与 WT 默认键位。
class MainWindow : public QMainWindow {
public:
    MainWindow() {
        setWindowTitle(QStringLiteral("Win-Term-Mac (C++/Qt)"));
        resize(1024, 640);
        setCentralWidget(new PlaceholderTerminal(this));
    }
};

} // namespace wtm

int main(int argc, char* argv[]) {
    QApplication app(argc, argv);
    QApplication::setApplicationName(QStringLiteral("wintermmac"));

    wtm::MainWindow window;
    window.show();

    return app.exec();
}
