// Win-Term-Mac · C++ 方案 · cmd 角色
// CommandPaletteWidget:命令面板的浮层 UI(薄 QWidget),包住 palette::CommandPalette
// 模型层。对齐 Windows Terminal 的 Ctrl/Cmd+Shift+P 面板:顶部一个搜索框,下方
// 结果列表(标题 + 右侧灰色快捷键提示),键盘上下选择、Enter 触发、Esc 关闭。
//
// 职责边界:只做「输入框 + 结果列表 + 选择/触发」这层 UI,以及把模型选中项的
//   动作交回派发回调。真正把动作落到窗格树的逻辑在 CommandCoordinator(同属 cmd 角色)。
//   交换 / 移动窗格没有默认热键 —— 它们只作为命令出现在本面板里(见 palette 模型的
//   BuildDefaultCommands),因此本面板是触发 swap/move 的唯一入口。
//
// ── 集成说明(integrator 需要如何调用我)────────────────────────────────────
//   一般不用直接 new 本类:CommandCoordinator 会持有并管理一个实例,
//   在命中 ToggleCommandPalette 热键时 openPalette()。
//   若要单独用:
//       auto* pal = new wtm::cmd::CommandPaletteWidget(mainWindow);
//       pal->setCommands(keymap, [ctrl](keymap::ActionId a){ ctrl->dispatch(a); });
//       pal->openPalette();   // 居中于 parent、抢焦点到输入框
//   构建:把 src/cmd/CommandPaletteWidget.cpp 加入 CMake SOURCES(AUTOMOC 处理
//         Q_OBJECT);链接 Qt6::Widgets;并一并编入 palette/CommandPalette.cpp。

#ifndef WTM_CMD_COMMANDPALETTEWIDGET_H
#define WTM_CMD_COMMANDPALETTEWIDGET_H

#include <QWidget>

#include "palette/CommandPalette.h"
#include "keymap/Keymap.h"

class QLineEdit;
class QListWidget;
class QEvent;
class QObject;
class QKeyEvent;

namespace wtm {
namespace cmd {

class CommandPaletteWidget : public QWidget {
    Q_OBJECT

public:
    explicit CommandPaletteWidget(QWidget* parent = nullptr);
    ~CommandPaletteWidget() override;

    CommandPaletteWidget(const CommandPaletteWidget&) = delete;
    CommandPaletteWidget& operator=(const CommandPaletteWidget&) = delete;

    // 用 keymap 生成 WT 风格默认命令集,并登记动作派发回调(命令被触发时调用)。
    void setCommands(const keymap::Keymap& keymap, palette::ActionDispatch dispatch);

    // 打开:清空查询、重算结果、居中于 parent、显示并把焦点抢到输入框。
    void openPalette();
    // 关闭:隐藏浮层并复位模型。
    void closePalette();

    bool isOpen() const;

signals:
    // 面板关闭(无论是触发命令还是 Esc)。集成层可据此把焦点还给当前终端。
    void closed();

protected:
    // 拦截输入框上的 Up/Down/Enter/Esc(单行编辑默认不处理方向键与 Esc)。
    bool eventFilter(QObject* watched, QEvent* event) override;
    void keyPressEvent(QKeyEvent* event) override;
    void showEvent(QShowEvent* event) override;

private:
    void onQueryChanged(const QString& text);
    void refreshList();          // 依模型 Results() 重建列表并同步选中行
    void moveSelection(int delta);
    void activateCurrentRow();   // 触发当前选中命令
    void reposition();           // 居中于 parent 顶部偏上

    palette::CommandPalette model_;
    QLineEdit*   input_ = nullptr;
    QListWidget* list_  = nullptr;
};

} // namespace cmd
} // namespace wtm

#endif // WTM_CMD_COMMANDPALETTEWIDGET_H
