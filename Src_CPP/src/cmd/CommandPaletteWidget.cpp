// Win-Term-Mac · C++ 方案 · cmd 角色
// CommandPaletteWidget 实现。见 .h 顶部说明。

#include "cmd/CommandPaletteWidget.h"

#include <QLineEdit>
#include <QListWidget>
#include <QVBoxLayout>
#include <QKeyEvent>
#include <QShowEvent>
#include <QColor>
#include <QPalette>
#include <QString>
#include <QSignalBlocker>

namespace wtm {
namespace cmd {

namespace {
constexpr int kPaletteWidth  = 640;
constexpr int kPaletteHeight = 420;
} // namespace

CommandPaletteWidget::CommandPaletteWidget(QWidget* parent) : QWidget(parent) {
    // 作为浮层挂在 parent 之上:无边框、独立抢焦点。
    setWindowFlags(Qt::Popup);
    setAutoFillBackground(true);
    setFixedSize(kPaletteWidth, kPaletteHeight);

    // 深色外观,贴近 WT 命令面板。
    QPalette pal = palette();
    pal.setColor(QPalette::Window, QColor(0x25, 0x25, 0x26));
    pal.setColor(QPalette::Base, QColor(0x1e, 0x1e, 0x1e));
    pal.setColor(QPalette::Text, QColor(0xe0, 0xe0, 0xe0));
    pal.setColor(QPalette::WindowText, QColor(0xe0, 0xe0, 0xe0));
    pal.setColor(QPalette::Highlight, QColor(0x09, 0x47, 0x71));
    pal.setColor(QPalette::HighlightedText, QColor(0xff, 0xff, 0xff));
    setPalette(pal);

    auto* layout = new QVBoxLayout(this);
    layout->setContentsMargins(8, 8, 8, 8);
    layout->setSpacing(6);

    input_ = new QLineEdit(this);
    input_->setPlaceholderText(QStringLiteral("Type a command..."));
    input_->setClearButtonEnabled(true);
    layout->addWidget(input_);

    list_ = new QListWidget(this);
    list_->setUniformItemSizes(true);
    list_->setFocusPolicy(Qt::NoFocus);   // 焦点常驻输入框,方向键由 eventFilter 处理
    layout->addWidget(list_);

    // 输入即搜索。
    connect(input_, &QLineEdit::textChanged, this, &CommandPaletteWidget::onQueryChanged);
    // 输入框回车 = 触发当前选中项。
    connect(input_, &QLineEdit::returnPressed, this,
            &CommandPaletteWidget::activateCurrentRow);
    // 鼠标点击某行 = 触发该行。
    connect(list_, &QListWidget::itemClicked, this,
            [this](QListWidgetItem*) { activateCurrentRow(); });

    // 让输入框上的方向键 / Esc 被本类接管。
    input_->installEventFilter(this);

    hide();
}

CommandPaletteWidget::~CommandPaletteWidget() = default;

void CommandPaletteWidget::setCommands(const keymap::Keymap& keymap,
                                       palette::ActionDispatch dispatch) {
    model_.BuildDefaultCommands(keymap, std::move(dispatch));
}

// 兼顾 Qt::Popup 在点击面板外时会自动 hide 的情形:只有「模型开着且仍可见」
// 才算真正打开,否则协调器应恢复接管全局热键。
bool CommandPaletteWidget::isOpen() const { return model_.IsOpen() && isVisible(); }

void CommandPaletteWidget::openPalette() {
    model_.Open();
    // 阻断 textChanged 递归:先清空输入,再手动刷新一次。
    {
        QSignalBlocker block(input_);
        input_->clear();
    }
    refreshList();
    reposition();
    show();
    raise();
    input_->setFocus(Qt::PopupFocusReason);
}

void CommandPaletteWidget::closePalette() {
    if (!model_.IsOpen() && isHidden()) return;
    model_.Close();
    hide();
    emit closed();
}

void CommandPaletteWidget::onQueryChanged(const QString& text) {
    model_.SetQuery(text.toStdString());
    refreshList();
}

void CommandPaletteWidget::refreshList() {
    list_->clear();
    const auto& results = model_.Results();
    const auto& commands = model_.Commands();
    for (const auto& mr : results) {
        if (mr.index >= commands.size()) continue;
        const palette::Command& c = commands[mr.index];
        QString label = QString::fromStdString(c.title);
        if (!c.shortcutHint.empty()) {
            // 右侧快捷键提示;palette-only(swap/move)无提示,留空。
            label += QStringLiteral("\t") + QString::fromStdString(c.shortcutHint);
        }
        list_->addItem(label);
    }
    const int sel = model_.SelectedRow();
    if (sel >= 0 && sel < list_->count()) {
        list_->setCurrentRow(sel);
    }
}

void CommandPaletteWidget::moveSelection(int delta) {
    model_.MoveSelection(delta);
    const int sel = model_.SelectedRow();
    if (sel >= 0 && sel < list_->count()) {
        list_->setCurrentRow(sel);
    }
}

void CommandPaletteWidget::activateCurrentRow() {
    // 以列表当前行为准(鼠标点击 / 键盘选择都落到这里),同步进模型再触发。
    const int row = list_->currentRow();
    if (row >= 0) {
        model_.SetSelectedRow(row);
    }
    const bool fired = model_.ActivateSelected();   // 内部会 dispatch(action) 并 Close()
    if (fired) {
        hide();
        emit closed();
    }
}

bool CommandPaletteWidget::eventFilter(QObject* watched, QEvent* event) {
    if (watched == input_ && event->type() == QEvent::KeyPress) {
        auto* ke = static_cast<QKeyEvent*>(event);
        switch (ke->key()) {
            case Qt::Key_Up:
                moveSelection(-1);
                return true;
            case Qt::Key_Down:
                moveSelection(1);
                return true;
            case Qt::Key_Escape:
                closePalette();
                return true;
            default:
                break;
        }
    }
    return QWidget::eventFilter(watched, event);
}

void CommandPaletteWidget::keyPressEvent(QKeyEvent* event) {
    // 焦点若不在输入框(理论上很少),仍支持这几个键。
    switch (event->key()) {
        case Qt::Key_Up:     moveSelection(-1);       return;
        case Qt::Key_Down:   moveSelection(1);        return;
        case Qt::Key_Escape: closePalette();          return;
        case Qt::Key_Return:
        case Qt::Key_Enter:  activateCurrentRow();    return;
        default: break;
    }
    QWidget::keyPressEvent(event);
}

void CommandPaletteWidget::showEvent(QShowEvent* event) {
    QWidget::showEvent(event);
    reposition();
}

void CommandPaletteWidget::reposition() {
    QWidget* anchor = parentWidget();
    if (anchor == nullptr) return;
    // 居中于 parent 顶部偏上(约 15% 高度处),贴近 WT 面板位置。
    const QPoint topLeftGlobal = anchor->mapToGlobal(QPoint(0, 0));
    const int x = topLeftGlobal.x() + (anchor->width() - width()) / 2;
    const int y = topLeftGlobal.y() + anchor->height() / 8;
    move(qMax(0, x), qMax(0, y));
}

} // namespace cmd
} // namespace wtm
