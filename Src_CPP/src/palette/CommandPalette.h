// Win-Term-Mac · C++ 方案 · palette 角色
// CommandPalette:可搜索的命令列表(对齐 WT 的 Ctrl/Cmd+Shift+P 命令面板)。
//
// 职责边界:
//   - 维护一份「命令(Command)」清单:每条命令 = 标题 + 分类 + 目标动作
//     (keymap::ActionId) + 可选快捷键提示。
//   - 提供模糊搜索 / 过滤 / 选中 / 触发。
//   - 触发时不直接操作窗格树,而是把 ActionId 交给一个「派发回调」——
//     真正把动作落到 Pane 二叉树上的胶水在集成层(app/pane 角色)实现。
//
// 硬规则落地:交换(swapPane)/ 移动(movePane)默认无热键,**只**能从这里触发。
//   BuildDefaultCommands 会把这些 palette-only 动作加进清单,而 keymap 默认表不绑它们。
//
// 本文件是纯 C++17 的「模型层」,不依赖 Qt,便于单元断言。真正的浮层 UI
// (输入框 + 结果列表 + 键盘上下选择)是一层薄 QWidget,见 .cpp 末尾 TODO 桩。

#ifndef WTM_PALETTE_COMMANDPALETTE_H
#define WTM_PALETTE_COMMANDPALETTE_H

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "keymap/Keymap.h"

namespace wtm::palette {

// 一条命令。id 稳定(可用于遥测/持久化),title 面向搜索与展示。
struct Command {
    std::string id;                              // 稳定标识,如 "pane.swap.left"
    std::string title;                           // 展示 & 搜索主键(英文)
    std::string category;                        // 分组:Pane / Focus / Resize / View
    std::string shortcutHint;                    // 右侧快捷键提示;palette-only 为空
    keymap::ActionId action = keymap::ActionId::None;
    bool paletteOnly = false;                    // 是否仅命令面板可触发
};

// 一条搜索命中:命令下标 + 匹配得分 + 命中的字符位置(供高亮)。
struct MatchResult {
    std::size_t index = 0;                       // 在 commands_ 里的下标
    int score = 0;                               // 越大越靠前
    std::vector<std::size_t> highlights;         // title 里被匹配到的字符位置
};

// 派发回调:命令被触发时,把目标动作交给集成层执行。
using ActionDispatch = std::function<void(keymap::ActionId)>;

class CommandPalette {
public:
    CommandPalette() = default;

    // 注册一条命令。返回其下标。
    std::size_t Register(Command cmd);

    // 用 keymap 生成 WT 风格默认命令集(拆分/焦点/大小/最大化/关闭
    // + palette-only 的交换/移动)。快捷键提示从 keymap 反查。
    // dispatch 会被存下来,供 Activate* 触发。
    void BuildDefaultCommands(const keymap::Keymap& keymap, ActionDispatch dispatch);

    const std::vector<Command>& Commands() const noexcept { return commands_; }

    // ---- 打开 / 关闭 ----
    bool IsOpen() const noexcept { return open_; }
    // 打开:清空查询、重算结果(全部命令按分类/标题排序)、选中第 0 条。
    void Open();
    void Close();

    // ---- 搜索 ----
    // 设置查询串并重算 results_(空串 = 展示全部)。会把选中项夹到有效范围。
    void SetQuery(const std::string& query);
    const std::string& Query() const noexcept { return query_; }

    // 当前过滤结果(已按得分/字母序排好)。
    const std::vector<MatchResult>& Results() const noexcept { return results_; }

    // ---- 选择 ----
    int SelectedRow() const noexcept { return selected_; }   // results_ 的下标;空则 -1
    void MoveSelection(int delta);                           // 上下移动并回绕
    void SetSelectedRow(int row);

    // 取当前选中项对应的 Command(无选中返回 nullptr)。
    const Command* SelectedCommand() const;

    // ---- 触发 ----
    // 触发当前选中项:调用 dispatch(action) 并关闭面板。返回是否触发成功。
    bool ActivateSelected();
    // 直接按结果行下标触发(鼠标点击用)。
    bool ActivateRow(int row);

    // 对外暴露的模糊匹配打分(静态,便于单测)。
    // 命中返回 true 并写回 score / highlights;不命中返回 false。
    // 规则:大小写不敏感的子序列匹配;连续命中、词首命中、前缀命中给加分。
    static bool FuzzyMatch(const std::string& query, const std::string& text,
                           int& score, std::vector<std::size_t>& highlights);

private:
    void Recompute();   // 依据 query_ 重建 results_ 并修正 selected_

    std::vector<Command> commands_;
    std::vector<MatchResult> results_;
    std::string query_;
    int selected_ = -1;
    bool open_ = false;
    ActionDispatch dispatch_;
};

} // namespace wtm::palette

#endif // WTM_PALETTE_COMMANDPALETTE_H
