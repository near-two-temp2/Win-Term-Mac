// Win-Term-Mac · C++ 方案 · palette 角色 实现
// 见 CommandPalette.h 顶部说明。本文件纯 C++17(模型层)。

#include "palette/CommandPalette.h"

#include <algorithm>
#include <array>
#include <cctype>

namespace wtm::palette {

namespace {

char LowerAscii(char c) {
    return static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
}

bool IsWordBoundary(const std::string& text, std::size_t i) {
    if (i == 0) return true;
    const char prev = text[i - 1];
    // 空格 / 分隔符之后,或小写→大写(驼峰)边界。
    if (prev == ' ' || prev == '-' || prev == '_' || prev == '.' || prev == '/')
        return true;
    const bool prevLower = (prev >= 'a' && prev <= 'z');
    const bool curUpper  = (text[i] >= 'A' && text[i] <= 'Z');
    return prevLower && curUpper;
}

} // namespace

// ---- 模糊匹配 ---------------------------------------------------------------

bool CommandPalette::FuzzyMatch(const std::string& query, const std::string& text,
                                int& score, std::vector<std::size_t>& highlights) {
    highlights.clear();
    score = 0;

    // 空查询:全部命中,给一个中性基准分(让后续按字母序稳定排序)。
    if (query.empty()) {
        score = 1;
        return true;
    }
    if (text.empty()) return false;

    std::size_t qi = 0;
    bool prevMatched = false;
    for (std::size_t ti = 0; ti < text.size() && qi < query.size(); ++ti) {
        if (LowerAscii(text[ti]) == LowerAscii(query[qi])) {
            highlights.push_back(ti);
            // 基础分。
            score += 1;
            // 词首命中加分(命令面板常见:输入 "sp" 命中 "Split Pane")。
            if (IsWordBoundary(text, ti)) score += 8;
            // 连续命中加分(整段前缀匹配得分最高)。
            if (prevMatched) score += 5;
            // 命中越靠前越好(轻微位置奖励)。
            if (ti < 8) score += static_cast<int>(8 - ti);
            ++qi;
            prevMatched = true;
        } else {
            prevMatched = false;
        }
    }

    if (qi != query.size()) {
        highlights.clear();
        score = 0;
        return false;   // 未能把 query 全部作为子序列匹配掉
    }
    // 整串前缀命中额外加分。
    if (!highlights.empty() && highlights.front() == 0) score += 10;
    return true;
}

// ---- 注册 / 默认命令 --------------------------------------------------------

std::size_t CommandPalette::Register(Command cmd) {
    commands_.push_back(std::move(cmd));
    return commands_.size() - 1;
}

void CommandPalette::BuildDefaultCommands(const keymap::Keymap& keymap,
                                          ActionDispatch dispatch) {
    dispatch_ = std::move(dispatch);
    commands_.clear();

    using keymap::ActionId;

    // 命令面板里应出现的动作全集(含 palette-only 的交换/移动)。
    static const std::array<std::pair<ActionId, const char*>, 20> kEntries = {{
        {ActionId::SplitRight,    "pane.split.right"},
        {ActionId::SplitDown,     "pane.split.down"},
        {ActionId::ClosePane,     "pane.close"},
        {ActionId::ToggleZoom,    "view.zoom.toggle"},
        {ActionId::FocusLeft,     "focus.left"},
        {ActionId::FocusRight,    "focus.right"},
        {ActionId::FocusUp,       "focus.up"},
        {ActionId::FocusDown,     "focus.down"},
        {ActionId::ResizeLeft,    "resize.left"},
        {ActionId::ResizeRight,   "resize.right"},
        {ActionId::ResizeUp,      "resize.up"},
        {ActionId::ResizeDown,    "resize.down"},
        // ---- 以下为 palette-only:默认无热键,仅命令面板触发 ----
        {ActionId::SwapPaneLeft,  "pane.swap.left"},
        {ActionId::SwapPaneRight, "pane.swap.right"},
        {ActionId::SwapPaneUp,    "pane.swap.up"},
        {ActionId::SwapPaneDown,  "pane.swap.down"},
        {ActionId::MovePaneLeft,  "pane.move.left"},
        {ActionId::MovePaneRight, "pane.move.right"},
        {ActionId::MovePaneUp,    "pane.move.up"},
        {ActionId::MovePaneDown,  "pane.move.down"},
    }};

    for (const auto& [action, id] : kEntries) {
        Command cmd;
        cmd.id = id;
        cmd.title = keymap::ActionTitle(action);
        cmd.category = keymap::ActionCategory(action);
        cmd.action = action;
        cmd.paletteOnly = keymap::IsPaletteOnly(action);
        // 快捷键提示:从 keymap 反查;palette-only 必然无绑定 → 留空。
        if (auto chord = keymap.ChordFor(action)) {
            cmd.shortcutHint = keymap::DescribeChord(*chord);
        }
        Register(std::move(cmd));
    }
}

// ---- 打开 / 关闭 ------------------------------------------------------------

void CommandPalette::Open() {
    open_ = true;
    query_.clear();
    Recompute();
}

void CommandPalette::Close() {
    open_ = false;
    query_.clear();
    results_.clear();
    selected_ = -1;
}

// ---- 搜索 -------------------------------------------------------------------

void CommandPalette::SetQuery(const std::string& query) {
    query_ = query;
    Recompute();
}

void CommandPalette::Recompute() {
    results_.clear();

    for (std::size_t i = 0; i < commands_.size(); ++i) {
        int score = 0;
        std::vector<std::size_t> hl;
        // 搜索面:标题为主,附带分类,让 "focus" 这类查询也能命中整组。
        std::string haystack = commands_[i].title;
        if (!commands_[i].category.empty()) {
            haystack += ' ';
            haystack += commands_[i].category;
        }
        if (FuzzyMatch(query_, haystack, score, hl)) {
            MatchResult mr;
            mr.index = i;
            mr.score = score;
            // 只保留落在 title 长度内的高亮(分类部分不高亮)。
            const std::size_t titleLen = commands_[i].title.size();
            for (std::size_t pos : hl) {
                if (pos < titleLen) mr.highlights.push_back(pos);
            }
            results_.push_back(std::move(mr));
        }
    }

    // 排序:得分降序;同分按分类、标题字母序稳定排列。
    std::stable_sort(results_.begin(), results_.end(),
        [this](const MatchResult& a, const MatchResult& b) {
            if (a.score != b.score) return a.score > b.score;
            const Command& ca = commands_[a.index];
            const Command& cb = commands_[b.index];
            if (ca.category != cb.category) return ca.category < cb.category;
            return ca.title < cb.title;
        });

    selected_ = results_.empty() ? -1 : 0;
}

// ---- 选择 -------------------------------------------------------------------

void CommandPalette::MoveSelection(int delta) {
    if (results_.empty()) {
        selected_ = -1;
        return;
    }
    const int n = static_cast<int>(results_.size());
    if (selected_ < 0) selected_ = 0;
    // 回绕(WT 命令面板上下键在首尾回环)。
    selected_ = ((selected_ + delta) % n + n) % n;
}

void CommandPalette::SetSelectedRow(int row) {
    if (row < 0 || row >= static_cast<int>(results_.size())) return;
    selected_ = row;
}

const Command* CommandPalette::SelectedCommand() const {
    if (selected_ < 0 || selected_ >= static_cast<int>(results_.size()))
        return nullptr;
    return &commands_[results_[selected_].index];
}

// ---- 触发 -------------------------------------------------------------------

bool CommandPalette::ActivateSelected() {
    const Command* cmd = SelectedCommand();
    if (!cmd) return false;
    if (dispatch_ && cmd->action != keymap::ActionId::None) {
        dispatch_(cmd->action);
    }
    Close();
    return true;
}

bool CommandPalette::ActivateRow(int row) {
    SetSelectedRow(row);
    return ActivateSelected();
}

} // namespace wtm::palette

// ============================================================================
// TODO(集成/渲染): 命令面板浮层 UI(薄 QWidget 层),挂在 MainWindow 之上。
//
// 计划(app/palette 角色在集成阶段落地):
//   class CommandPaletteWidget : public QWidget {
//     // - 顶部一个 QLineEdit:textChanged → palette.SetQuery(),重绘结果列表。
//     // - 下方 QListView / 自绘列表:每行 = 标题(高亮 MatchResult::highlights)
//     //   + 右对齐 shortcutHint(灰字);palette-only 行右侧留空。
//     // - 键盘:Up/Down → palette.MoveSelection(±1);Enter → palette.ActivateSelected();
//     //   Esc → palette.Close() 并隐藏浮层;点击某行 → palette.ActivateRow(row)。
//     // - 呼出:Keymap 命中 ToggleCommandPalette(Ctrl/Cmd+Shift+P)时
//     //   Open() 并 show()、居中于窗口、抢焦点到输入框。
//   };
//
// 动作派发(BuildDefaultCommands 的 dispatch 回调)在集成层实现,把 ActionId
// 落到 pane 二叉树:
//   - Split*   → focusedLeaf->Split(dir, 0.5, newLeaf)
//   - Focus*   → root->Navigate(focusedLeaf, dir)
//   - Resize*  → 调 focused 所在分裂节点的 SetDesiredSplitPosition(±step)
//   - Swap*    → Pane::Swap(focusedLeaf, root->Navigate(focusedLeaf, dir))
//   - Move*    → Pane::Move(focusedLeaf, targetLeaf, dir, 0.5)
//   - ToggleZoom / ClosePane → 对应 pane 操作
// 同一个 dispatch 也被 Keymap 命中的热键复用,保证热键与命令面板行为一致。
// ============================================================================
