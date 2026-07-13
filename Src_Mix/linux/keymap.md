# Linux(GTK4)键位映射:WT 键位 → 动作 → 内核调用

复刻 Windows Terminal 的窗格体验。Linux 沿用 WT 的 `Ctrl` 主修饰键
(macOS 端把 `Ctrl` 换成 `Cmd`,此表右列一并标注对照)。

设计哲学(与 WT 一致):高频操作给热键,低频强力操作(交换 / 移动窗格)
收进命令面板,不占默认热键。

## 高频:有默认热键

| 动作 | Linux / Windows 键位 | macOS 键位 | 内核 C ABI 调用 |
|------|----------------------|-----------|-----------------|
| 向右拆分(纵向分裂) | `Alt+Shift++` | `Cmd+Opt+Shift++` | `wtm_tree_split(dir=Right)` |
| 向下拆分(横向分裂) | `Alt+Shift+-` | `Cmd+Opt+Shift+-` | `wtm_tree_split(dir=Down)` |
| 焦点移左 | `Alt+Left` | `Cmd+Opt+Left` | `wtm_tree_navigate(dir=Left)` |
| 焦点移右 | `Alt+Right` | `Cmd+Opt+Right` | `wtm_tree_navigate(dir=Right)` |
| 焦点移上 | `Alt+Up` | `Cmd+Opt+Up` | `wtm_tree_navigate(dir=Up)` |
| 焦点移下 | `Alt+Down` | `Cmd+Opt+Down` | `wtm_tree_navigate(dir=Down)` |
| 调整大小 · 左 | `Alt+Shift+Left` | `Cmd+Opt+Shift+Left` | 调整所属分裂节点 ratio(TODO 内核 API) |
| 调整大小 · 右 | `Alt+Shift+Right` | `Cmd+Opt+Shift+Right` | 同上 |
| 调整大小 · 上 | `Alt+Shift+Up` | `Cmd+Opt+Shift+Up` | 同上 |
| 调整大小 · 下 | `Alt+Shift+Down` | `Cmd+Opt+Shift+Down` | 同上 |
| 打开命令面板 | `Ctrl+Shift+P` | `Cmd+Shift+P` | 宿主 UI(见下) |

## 低频强力:仅命令面板触发(无默认热键)

| 动作 | 触发方式 | 内核 C ABI 调用 |
|------|----------|-----------------|
| 交换窗格 swapPane | 命令面板 | `wtm_tree_swap(a, b)` |
| 移动 / 摘下窗格 move/detach | 命令面板(拖拽的基础) | 摘下 + 重挂(TODO 内核 API) |
| 最大化 / 还原窗格 | 命令面板 | maximize/restore(TODO 内核 API) |

## 方向枚举对照(务必与 core 保持一致)

core 侧 `WtmDirection`:`Left=0`、`Right=1`、`Up=2`、`Down=3`。
本表所有 `dir=…` 均按此数值传参。

## 说明

- 拆分比例 `ratio` 取 `0.0~1.0`(first 子节点占比),默认 `0.5`。
- 上表键位为默认值;后续应做成可配置(参照 WT 的 actions/keybindings)。
- 命令面板在 GTK4 里计划用一个可搜索的弹出层(GtkPopover + 过滤列表)实现,
  条目 = 动作;这是当前的 TODO 桩,尚未接线。
