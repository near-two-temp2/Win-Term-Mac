// Win-Term-Mac · C++ 方案 · render 角色
// TerminalView 实现:QPainter 逐格绘制 + 键盘输入转发 + 尺寸联动。
// 设计说明见 TerminalView.h。仅依赖 Qt6::Widgets 与 term/TerminalSession.h。

#include "render/TerminalView.h"

#include <QPainter>
#include <QPaintEvent>
#include <QKeyEvent>
#include <QResizeEvent>
#include <QFocusEvent>
#include <QInputMethodEvent>
#include <QTimer>
#include <QFontMetrics>
#include <QFontDatabase>
#include <QChar>

#include <utility>   // std::swap

namespace wtm {

namespace {
// 光标闪烁周期(毫秒)。对齐常见终端约 500ms。
constexpr int kBlinkIntervalMs = 530;
} // namespace

// ---- 构造 / 析构 -----------------------------------------------------------

TerminalView::TerminalView(QWidget* parent) : QWidget(parent) {
    setAutoFillBackground(false);          // 背景我们自己画(整块深色底)
    setFocusPolicy(Qt::StrongFocus);       // 可点击/Tab 获得焦点后打字
    setAttribute(Qt::WA_InputMethodEnabled, true);  // 允许 IME(中文等)
    setAttribute(Qt::WA_OpaquePaintEvent, true);    // 我们铺满整块,免系统擦背景
    setCursor(Qt::IBeamCursor);

    // 选一个平台等宽字体作默认。QFontDatabase 的固定间距字体最稳妥。
    QFont mono = QFontDatabase::systemFont(QFontDatabase::FixedFont);
    if (mono.pointSize() < 1) mono.setPointSize(12);
    mono.setStyleHint(QFont::Monospace, QFont::PreferQuality);
    font_ = mono;
    recomputeCellMetrics();

    blinkTimer_ = new QTimer(this);
    blinkTimer_->setInterval(kBlinkIntervalMs);
    connect(blinkTimer_, &QTimer::timeout, this, &TerminalView::onBlinkTick);
}

TerminalView::~TerminalView() {
    disconnectSession();
    if (ownsSession_ && session_) {
        delete session_;
        session_ = nullptr;
    }
}

// ---- 会话绑定 --------------------------------------------------------------

void TerminalView::setSession(TerminalSession* session, bool takeOwnership) {
    if (session_ == session) {
        ownsSession_ = takeOwnership;
        return;
    }
    disconnectSession();
    if (ownsSession_ && session_) {
        delete session_;
    }
    session_ = session;
    ownsSession_ = takeOwnership;
    connectSession();
    if (session_) {
        // 让会话网格对齐当前视图像素尺寸。
        syncGridSizeToSession();
        emit titleChanged(session_->title());
    }
    update();
}

TerminalSession* TerminalView::startShell(const QString& program,
                                          const QStringList& args) {
    auto* s = new TerminalSession(this);
    // 先按当前视图尺寸估算初始网格,减少启动后的一次 reflow。
    recomputeCellMetrics();
    int c = qMax(1, width()  / qMax(1, cellW_));
    int r = qMax(1, height() / qMax(1, cellH_));
    if (width() <= 0 || height() <= 0) { c = 80; r = 24; }
    if (!s->start(program, args, c, r)) {
        delete s;
        return nullptr;
    }
    setSession(s, /*takeOwnership=*/true);
    return s;
}

void TerminalView::connectSession() {
    if (!session_) return;
    connect(session_, &TerminalSession::damaged,      this, &TerminalView::onDamaged);
    connect(session_, &TerminalSession::cursorMoved,  this, &TerminalView::onCursorMoved);
    connect(session_, &TerminalSession::bell,         this, &TerminalView::onBell);
    connect(session_, &TerminalSession::resized,      this, &TerminalView::onResized);
    connect(session_, &TerminalSession::titleChanged, this, &TerminalView::onTitleChanged);
    connect(session_, &TerminalSession::childExited,  this, &TerminalView::onChildExited);
}

void TerminalView::disconnectSession() {
    if (!session_) return;
    disconnect(session_, nullptr, this, nullptr);
}

// ---- 外观 ------------------------------------------------------------------

void TerminalView::setTerminalFont(const QFont& font) {
    font_ = font;
    recomputeCellMetrics();
    syncGridSizeToSession();
    update();
}

void TerminalView::setDefaultColors(const QColor& fg, const QColor& bg) {
    defaultFg_ = fg;
    defaultBg_ = bg;
    cursorColor_ = fg;
    update();
}

void TerminalView::recomputeCellMetrics() {
    QFontMetrics fm(font_);
    // 等宽字体下 horizontalAdvance('M') 即列宽;取 max 防个别字体给 0。
    cellW_ = qMax(1, fm.horizontalAdvance(QLatin1Char('M')));
    cellH_ = qMax(1, fm.height());
    baseline_ = fm.ascent();
}

QSize TerminalView::sizeHint() const {
    return QSize(cellW_ * 80, cellH_ * 24);
}

// ---- 尺寸联动 --------------------------------------------------------------

void TerminalView::syncGridSizeToSession() {
    if (cellW_ <= 0 || cellH_ <= 0) return;
    int c = qMax(1, width()  / cellW_);
    int r = qMax(1, height() / cellH_);
    cols_ = c;
    rows_ = r;
    if (session_ && session_->isRunning()) {
        session_->resize(c, r);   // 内部同步 libvterm + PTY winsize
    }
}

void TerminalView::resizeEvent(QResizeEvent* /*e*/) {
    syncGridSizeToSession();
    update();
}

// ---- 绘制 ------------------------------------------------------------------

QRect TerminalView::cellsToPixels(int startRow, int endRow,
                                  int startCol, int endCol) const {
    const int x = startCol * cellW_;
    const int y = startRow * cellH_;
    const int w = (endCol - startCol + 1) * cellW_;
    const int h = (endRow - startRow + 1) * cellH_;
    return QRect(x, y, w, h);
}

QColor TerminalView::resolveColor(const Color& c, bool foreground) const {
    if (c.isDefault) return foreground ? defaultFg_ : defaultBg_;
    return QColor(c.r, c.g, c.b);
}

void TerminalView::paintEvent(QPaintEvent* e) {
    QPainter p(this);
    p.setFont(font_);

    // 整块铺底(含没有会话时的空视图)。
    p.fillRect(rect(), defaultBg_);

    if (!session_) return;

    const int gc = session_->cols();
    const int gr = session_->rows();
    if (gc <= 0 || gr <= 0) return;

    // 只重绘暴露区域覆盖到的格子(damage → update(rect) 后这里收窄范围)。
    const QRect clip = e->rect();
    int r0 = qMax(0, clip.top()    / cellH_);
    int r1 = qMin(gr - 1, clip.bottom() / cellH_);
    int c0 = qMax(0, clip.left()   / cellW_);
    int c1 = qMin(gc - 1, clip.right()  / cellW_);

    const QPoint cur = session_->cursorPos();   // x=col, y=row
    const bool showCursor = focused_ && session_->cursorVisible() && blinkOn_;

    for (int row = r0; row <= r1; ++row) {
        for (int col = c0; col <= c1; ++col) {
            const Cell& cell = session_->cellAt(row, col);

            // 宽字符右占位格(width==0):已被主格覆盖,跳过。
            if (cell.width == 0) continue;

            const int cw = (cell.width == 2) ? cellW_ * 2 : cellW_;
            const QRect cellRect(col * cellW_, row * cellH_, cw, cellH_);

            // 反显:前景/背景对调(对齐 VT 的 reverse)。
            QColor fg = resolveColor(cell.fg, /*foreground=*/true);
            QColor bg = resolveColor(cell.bg, /*foreground=*/false);
            if (cell.attrs.reverse) std::swap(fg, bg);

            // 光标覆盖到本格:块状光标 = 用光标色铺底、底色写字(近似 WT 聚焦块光标)。
            const bool underCursor = showCursor && row == cur.y() && col == cur.x();
            if (underCursor) {
                bg = cursorColor_;
                fg = defaultBg_;
            }

            // 背景(非默认底才铺,减少无谓填充;默认底已由整块 fillRect 铺过)。
            if (bg != defaultBg_) {
                p.fillRect(cellRect, bg);
            }

            // 字形。空格 / NUL 只画背景。
            if (cell.codepoint != U' ' && cell.codepoint != 0) {
                QFont f = font_;
                if (cell.attrs.bold)   f.setBold(true);
                if (cell.attrs.italic) f.setItalic(true);
                p.setFont(f);
                p.setPen(fg);

                const char32_t cp = cell.codepoint;
                const QString glyph = QString::fromUcs4(&cp, 1);
                p.drawText(cellRect.x(), row * cellH_ + baseline_, glyph);
            }

            // 下划线 / 删除线。
            if (cell.attrs.underline || cell.attrs.strike) {
                p.setPen(fg);
                if (cell.attrs.underline) {
                    const int uy = row * cellH_ + baseline_ + 1;
                    p.drawLine(cellRect.x(), uy, cellRect.right(), uy);
                }
                if (cell.attrs.strike) {
                    const int sy = row * cellH_ + cellH_ / 2;
                    p.drawLine(cellRect.x(), sy, cellRect.right(), sy);
                }
            }
        }
    }

    // 失焦时用空心框标记光标位置(对齐多数终端「非活动窗格空心光标」)。
    if (!focused_ && session_->cursorVisible()) {
        const int cx = cur.x() * cellW_;
        const int cy = cur.y() * cellH_;
        p.setPen(cursorColor_);
        p.setBrush(Qt::NoBrush);
        p.drawRect(QRect(cx, cy, cellW_ - 1, cellH_ - 1));
    }
}

// ---- 会话信号 → 局部重绘 ---------------------------------------------------

void TerminalView::onDamaged(int startRow, int endRow, int startCol, int endCol) {
    update(cellsToPixels(startRow, endRow, startCol, endCol));
}

void TerminalView::onCursorMoved(int row, int col) {
    // 重绘旧/新光标所在行足矣;简化为重绘两格所在的整行。
    update(cellsToPixels(row, row, 0, qMax(0, cols_ - 1)));
    // 光标一动即重置闪烁为「亮」,并让计时器从头计。
    blinkOn_ = true;
    if (focused_) blinkTimer_->start();
    update(QRect(col * cellW_, row * cellH_, cellW_, cellH_));
}

void TerminalView::onBell() {
    // 视觉响铃:整块快速反色一帧(简化)。此处仅重绘,真正的 flash 留 TODO。
    // TODO(render): 可加一个短促的反相 overlay 动画;当前先安静地忽略声音。
    update();
}

void TerminalView::onResized(int cols, int rows) {
    cols_ = cols;
    rows_ = rows;
    update();
}

void TerminalView::onTitleChanged(const QString& title) {
    emit titleChanged(title);   // 透传给集成层
}

void TerminalView::onChildExited(int exitCode) {
    blinkTimer_->stop();
    emit sessionExited(exitCode);
    update();
}

void TerminalView::onBlinkTick() {
    blinkOn_ = !blinkOn_;
    if (!session_) return;
    const QPoint cur = session_->cursorPos();
    update(QRect(cur.x() * cellW_, cur.y() * cellH_, cellW_, cellH_));
}

// ---- 焦点 ------------------------------------------------------------------

void TerminalView::focusInEvent(QFocusEvent* /*e*/) {
    focused_ = true;
    blinkOn_ = true;
    blinkTimer_->start();
    update();
}

void TerminalView::focusOutEvent(QFocusEvent* /*e*/) {
    focused_ = false;
    blinkTimer_->stop();
    update();
}

// ---- 键盘输入 → 会话 -------------------------------------------------------

void TerminalView::keyPressEvent(QKeyEvent* e) {
    if (!session_ || !session_->isRunning()) {
        QWidget::keyPressEvent(e);
        return;
    }

    const Qt::KeyboardModifiers qm = e->modifiers();
    // 组装 TerminalSession 的修饰位。
    std::uint8_t mods = TerminalSession::ModNone;
    if (qm & Qt::ShiftModifier)   mods |= TerminalSession::ModShift;
    if (qm & Qt::AltModifier)     mods |= TerminalSession::ModAlt;
    if (qm & Qt::ControlModifier) mods |= TerminalSession::ModCtrl;

    // 1) 特殊键 → sendKey(由 libvterm 生成正确转义序列)。
    using SK = TerminalSession::SpecialKey;
    bool handled = true;
    switch (e->key()) {
    case Qt::Key_Return:
    case Qt::Key_Enter:      session_->sendKey(SK::Enter, mods);     break;
    case Qt::Key_Tab:        session_->sendKey(SK::Tab, mods);       break;
    case Qt::Key_Backtab:    session_->sendKey(SK::Tab, mods | TerminalSession::ModShift); break;
    case Qt::Key_Backspace:  session_->sendKey(SK::Backspace, mods); break;
    case Qt::Key_Escape:     session_->sendKey(SK::Escape, mods);    break;
    case Qt::Key_Up:         session_->sendKey(SK::Up, mods);        break;
    case Qt::Key_Down:       session_->sendKey(SK::Down, mods);      break;
    case Qt::Key_Left:       session_->sendKey(SK::Left, mods);      break;
    case Qt::Key_Right:      session_->sendKey(SK::Right, mods);     break;
    case Qt::Key_Home:       session_->sendKey(SK::Home, mods);      break;
    case Qt::Key_End:        session_->sendKey(SK::End, mods);       break;
    case Qt::Key_PageUp:     session_->sendKey(SK::PageUp, mods);    break;
    case Qt::Key_PageDown:   session_->sendKey(SK::PageDown, mods);  break;
    case Qt::Key_Insert:     session_->sendKey(SK::Insert, mods);    break;
    case Qt::Key_Delete:     session_->sendKey(SK::Delete, mods);    break;
    default:                 handled = false;                        break;
    }
    if (handled) { e->accept(); return; }

    // 2) Ctrl+字母/常见控制组合 → 直接送控制字节(sendText 不带修饰,故这里手动)。
    if ((qm & Qt::ControlModifier) && !(qm & Qt::AltModifier)) {
        const int k = e->key();
        char ctrl = 0;
        if (k >= Qt::Key_A && k <= Qt::Key_Z) {
            ctrl = static_cast<char>((k - Qt::Key_A) + 1);      // ^A..^Z = 0x01..0x1a
        } else {
            switch (k) {
            case Qt::Key_Space:        ctrl = 0x00; break;      // ^@ / NUL
            case Qt::Key_BracketLeft:  ctrl = 0x1b; break;      // ^[ = ESC
            case Qt::Key_Backslash:    ctrl = 0x1c; break;      // ^\
            case Qt::Key_BracketRight: ctrl = 0x1d; break;      // ^]
            case Qt::Key_AsciiCircum:  ctrl = 0x1e; break;      // ^^
            case Qt::Key_Underscore:   ctrl = 0x1f; break;      // ^_
            default: break;
            }
        }
        if (ctrl != 0 || k == Qt::Key_Space) {
            session_->writeRaw(&ctrl, 1);
            e->accept();
            return;
        }
    }

    // 3) 普通可打印文本。Alt+字符 → ESC 前缀(meta 语义),其余直送。
    const QString text = e->text();
    if (!text.isEmpty()) {
        if ((qm & Qt::AltModifier) && !(qm & Qt::ControlModifier)) {
            const char esc = 0x1b;
            session_->writeRaw(&esc, 1);
        }
        session_->sendText(text);
        e->accept();
        return;
    }

    QWidget::keyPressEvent(e);
}

// ---- IME(中文等)---------------------------------------------------------

void TerminalView::inputMethodEvent(QInputMethodEvent* e) {
    if (session_ && session_->isRunning() && !e->commitString().isEmpty()) {
        session_->sendText(e->commitString());
    }
    e->accept();
    // 预编辑串(未上屏)的内嵌显示留 TODO(render):当前只在提交时送出。
}

} // namespace wtm
