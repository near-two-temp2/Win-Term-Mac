// Win-Term-Mac · C++ 方案 · render 角色
// TerminalView:把一个 TerminalSession 的字符网格真正画到屏幕上的 QWidget,
// 并把键盘输入转发回该会话。一个叶子窗格 = 一个 TerminalView(内含一个会话)。
//
// 职责边界(本类只做「视图」这一件事):
//   1. 渲染:用等宽字体把 session 的网格(cellAt / 光标 / 颜色 / 属性)逐格画出;
//      订阅 session 的 damaged/cursorMoved/resized/bell/titleChanged 信号做局部重绘。
//   2. 输入:keyPressEvent → 翻译成 session 的输入原语(sendText/sendKey/writeRaw),
//      让子进程真正收到按键。
//   3. 尺寸:widget 像素尺寸 / 字符格尺寸 → 反推 cols/rows,resizeEvent 里同步给 session
//      (进而同步 PTY winsize)。
//
// 明确不做:不解析 VT(term 角色的 TerminalSession 做)、不管窗格树/布局
// (pane 角色做)、不注册全局热键(keymap/palette 角色做)。分裂/切焦点等热键由
// 集成层在更高层拦截;落到本 widget 的按键都视为「喂给子进程的输入」。
//
// ── 集成说明(integrator 需要如何调用我)────────────────────────────────────
//   构建:把 src/render/TerminalView.cpp 加入 CMake 的 SOURCES(AUTOMOC 已开,
//         Q_OBJECT 会被 moc 处理);链接 Qt6::Widgets 即可,无额外依赖。
//   典型用法(每个叶子窗格一份):
//       auto* session = new wtm::TerminalSession(this);
//       session->start();                 // 起默认 shell(80x24,随后按 view 尺寸 resize)
//       auto* view = new wtm::TerminalView(this);
//       view->setSession(session);        // view 不接管 session 生命周期(见下)
//       // 把 view 作为该叶子的中央 widget 放进 pane 布局容器即可。
//   或用便捷入口(view 自建并持有一个会话):
//       auto* view = new wtm::TerminalView(this);
//       view->startShell();               // 内部 new + start;view 负责析构它
//   生命周期:setSession 传入的会话默认由调用方负责释放;startShell 自建的会话由
//   view 释放。若希望 view 接管外部会话,setSession(session, /*takeOwnership=*/true)。
//   焦点:view 默认 StrongFocus;点击/Tab 进入即可打字。集成层若要用 Alt+方向做
//   切焦点等,应在 eventFilter/更高层先行拦截,未被拦截的按键才会到达本 widget。

#ifndef WTM_RENDER_TERMINALVIEW_H
#define WTM_RENDER_TERMINALVIEW_H

#include <QWidget>
#include <QFont>
#include <QColor>
#include <QString>

#include "term/TerminalSession.h"

class QTimer;
class QPaintEvent;
class QKeyEvent;
class QResizeEvent;
class QFocusEvent;
class QInputMethodEvent;

namespace wtm {

// 终端渲染视图。深色底、等宽字体、块状光标,damage 驱动局部重绘。
class TerminalView : public QWidget {
    Q_OBJECT

public:
    explicit TerminalView(QWidget* parent = nullptr);
    ~TerminalView() override;

    TerminalView(const TerminalView&) = delete;
    TerminalView& operator=(const TerminalView&) = delete;

    // 绑定一个已存在的会话。takeOwnership=true 时 view 负责其析构。
    // 会断开旧会话的信号并连接新会话;随后按当前尺寸同步一次 cols/rows。
    void setSession(TerminalSession* session, bool takeOwnership = false);
    TerminalSession* session() const noexcept { return session_; }

    // 便捷入口:内部 new 一个 TerminalSession 并 start() 默认 shell,view 持有之。
    // 返回该会话(失败返回 nullptr)。program/args 透传给 TerminalSession::start。
    TerminalSession* startShell(const QString& program = QString(),
                                const QStringList& args = QStringList());

    // ---- 外观 ----
    void setTerminalFont(const QFont& font);   // 会重算格子尺寸并按新格数 resize 会话
    QFont terminalFont() const { return font_; }

    // 默认前景/背景色(Color::isDefault 的格子回退到这里)。
    void setDefaultColors(const QColor& fg, const QColor& bg);

    // 当前视图能容纳的字符网格尺寸(由像素尺寸 / 格子尺寸算出)。
    int columns() const noexcept { return cols_; }
    int viewRows() const noexcept { return rows_; }

    // 建议尺寸:给 pane 布局一个合理初值(约 80x24 个格子)。
    QSize sizeHint() const override;

signals:
    // 会话标题变化时透传(集成层可拿去更新标签页/窗格标题)。
    void titleChanged(const QString& title);
    // 子进程退出(集成层可据此关闭/回收该叶子窗格)。
    void sessionExited(int exitCode);

protected:
    void paintEvent(QPaintEvent* e) override;
    void keyPressEvent(QKeyEvent* e) override;
    void resizeEvent(QResizeEvent* e) override;
    void focusInEvent(QFocusEvent* e) override;
    void focusOutEvent(QFocusEvent* e) override;
    void inputMethodEvent(QInputMethodEvent* e) override;   // IME 输入(中文等)

private slots:
    void onDamaged(int startRow, int endRow, int startCol, int endCol);
    void onCursorMoved(int row, int col);
    void onBell();
    void onResized(int cols, int rows);
    void onTitleChanged(const QString& title);
    void onChildExited(int exitCode);
    void onBlinkTick();

private:
    // 从字体度量刷新单元格像素尺寸(cellW_/cellH_/baseline_)。
    void recomputeCellMetrics();
    // 依据当前 widget 像素尺寸算出可容纳的 cols/rows,并同步给会话。
    void syncGridSizeToSession();
    // 把网格坐标 (row,col) 的一块矩形转成像素 QRect(供局部重绘)。
    QRect cellsToPixels(int startRow, int endRow, int startCol, int endCol) const;
    // 把会话里的 Color(带 isDefault)解析成 QColor。
    QColor resolveColor(const Color& c, bool foreground) const;
    // 连接 / 断开当前会话的信号。
    void connectSession();
    void disconnectSession();

    TerminalSession* session_ = nullptr;
    bool ownsSession_ = false;

    // 字体与格子度量。
    QFont font_;
    int cellW_ = 8;       // 单格宽(像素,取自 horizontalAdvance('M'))
    int cellH_ = 16;      // 单格高(像素,取自 line spacing)
    int baseline_ = 12;   // 文本基线偏移(从格顶到基线)

    // 视图当前网格尺寸(可能与会话的略有出入,取二者交集绘制)。
    int cols_ = 80;
    int rows_ = 24;

    // 主题默认色。
    QColor defaultFg_{0xcc, 0xcc, 0xcc};
    QColor defaultBg_{0x1e, 0x1e, 0x1e};
    QColor cursorColor_{0xcc, 0xcc, 0xcc};

    // 光标闪烁。
    QTimer* blinkTimer_ = nullptr;
    bool blinkOn_ = true;
    bool focused_ = false;
};

} // namespace wtm

#endif // WTM_RENDER_TERMINALVIEW_H
