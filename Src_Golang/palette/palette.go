// Package palette 实现 Win-Term-Mac 的命令面板(对应 WT 的 Ctrl+Shift+P)。
//
// 职责:登记一组可搜索命令,对用户输入做模糊匹配并排序;把选中的命令翻译成
// 一个高层动作(keymap.Action)交回控制层执行。本包不直接操作窗格树 —— 那是
// 控制层的事,面板只负责“选出要做什么”。
//
// 设计哲学:交换窗格(SwapPane)、移动窗格(MovePane)属低频强力操作,
// 按 WT 约定不给热键、只从命令面板触发。它们在此登记为 NeedsTarget 命令:
// 面板确认后,控制层还需引导用户选择第二个(目标)窗格再落地。
package palette

import (
	"sort"
	"strings"

	"winterm/keymap"
)

// Command 是命令面板中的一条命令。
type Command struct {
	// ID 稳定英文标识,便于测试与配置引用。
	ID string
	// Title 展示名(可中文)。
	Title string
	// Keywords 额外的可搜索关键词(别名 / 拼音 / 英文),提升召回。
	Keywords []string
	// Action 选中后交给控制层的高层动作。
	Action keymap.Action
	// NeedsTarget 为 true 表示确认命令后还需再选一个目标窗格
	// (如 SwapPane / MovePane)。控制层据此进入“拾取目标”子流程。
	NeedsTarget bool
}

// Result 是一次搜索命中的命令及其信息。
type Result struct {
	Command Command
	Score   int    // 越大越靠前
	Hotkey  string // 该命令的热键提示;无热键(如 SwapPane)为空
}

// DefaultCommands 返回默认命令集。传入 keymap 以便为有热键的命令附上提示文本;
// 传 nil 则不显示热键(逻辑不受影响)。
func DefaultCommands() []Command {
	return []Command{
		{ID: "splitRight", Title: "向右拆分窗格", Keywords: []string{"split", "right", "vertical", "分屏", "拆分"}, Action: keymap.ActionSplitRight},
		{ID: "splitDown", Title: "向下拆分窗格", Keywords: []string{"split", "down", "horizontal", "分屏", "拆分"}, Action: keymap.ActionSplitDown},

		{ID: "focusUp", Title: "焦点移到上方窗格", Keywords: []string{"focus", "up", "焦点", "导航"}, Action: keymap.ActionFocusUp},
		{ID: "focusDown", Title: "焦点移到下方窗格", Keywords: []string{"focus", "down", "焦点", "导航"}, Action: keymap.ActionFocusDown},
		{ID: "focusLeft", Title: "焦点移到左侧窗格", Keywords: []string{"focus", "left", "焦点", "导航"}, Action: keymap.ActionFocusLeft},
		{ID: "focusRight", Title: "焦点移到右侧窗格", Keywords: []string{"focus", "right", "焦点", "导航"}, Action: keymap.ActionFocusRight},

		{ID: "resizeLeft", Title: "调整窗格大小(向左)", Keywords: []string{"resize", "left", "大小", "调整"}, Action: keymap.ActionResizeLeft},
		{ID: "resizeRight", Title: "调整窗格大小(向右)", Keywords: []string{"resize", "right", "大小", "调整"}, Action: keymap.ActionResizeRight},
		{ID: "resizeUp", Title: "调整窗格大小(向上)", Keywords: []string{"resize", "up", "大小", "调整"}, Action: keymap.ActionResizeUp},
		{ID: "resizeDown", Title: "调整窗格大小(向下)", Keywords: []string{"resize", "down", "大小", "调整"}, Action: keymap.ActionResizeDown},

		{ID: "toggleMaximize", Title: "最大化 / 还原窗格", Keywords: []string{"maximize", "zoom", "全屏", "最大化", "还原"}, Action: keymap.ActionToggleMaximize},
		{ID: "closePane", Title: "关闭当前窗格", Keywords: []string{"close", "kill", "关闭"}, Action: keymap.ActionClosePane},

		// 低频强力操作:仅面板触发,需再选目标窗格。
		{ID: "swapPane", Title: "交换窗格…", Keywords: []string{"swap", "exchange", "交换"}, Action: keymap.ActionSwapPane, NeedsTarget: true},
		{ID: "movePane", Title: "移动窗格…", Keywords: []string{"move", "relocate", "移动"}, Action: keymap.ActionMovePane, NeedsTarget: true},
	}
}

// Palette 是命令面板的状态机:持有命令集、当前查询与过滤结果、选中项。
type Palette struct {
	km       *keymap.Keymap
	commands []Command
	query    string
	results  []Result
	selected int  // 当前高亮的结果下标
	open     bool // 面板是否处于打开状态
}

// New 创建命令面板。km 可为 nil(此时不显示热键提示)。
func New(km *keymap.Keymap, commands []Command) *Palette {
	p := &Palette{km: km, commands: commands}
	p.refilter()
	return p
}

// NewDefault 用默认命令集创建面板。
func NewDefault(km *keymap.Keymap) *Palette {
	return New(km, DefaultCommands())
}

// Open 打开面板并重置查询与选中项。
func (p *Palette) Open() {
	p.open = true
	p.query = ""
	p.selected = 0
	p.refilter()
}

// Close 关闭面板。
func (p *Palette) Close() { p.open = false }

// IsOpen 返回面板是否打开。
func (p *Palette) IsOpen() bool { return p.open }

// Query 返回当前查询串。
func (p *Palette) Query() string { return p.query }

// SetQuery 设置查询串并重新过滤,选中项回到第一条。
func (p *Palette) SetQuery(q string) {
	p.query = q
	p.selected = 0
	p.refilter()
}

// Results 返回当前过滤后的结果(已排序)。
func (p *Palette) Results() []Result { return p.results }

// Selected 返回当前高亮的下标(可能为 -1 表示无结果)。
func (p *Palette) Selected() int {
	if len(p.results) == 0 {
		return -1
	}
	return p.selected
}

// MoveSelection 上下移动高亮(delta 通常为 +1 / -1),在结果范围内循环。
func (p *Palette) MoveSelection(delta int) {
	n := len(p.results)
	if n == 0 {
		return
	}
	p.selected = ((p.selected+delta)%n + n) % n
}

// Confirm 取当前高亮的命令并关闭面板;无结果返回 (Command{}, false)。
// 返回的命令若 NeedsTarget=true,控制层还需引导用户选择目标窗格。
func (p *Palette) Confirm() (Command, bool) {
	if len(p.results) == 0 {
		return Command{}, false
	}
	cmd := p.results[p.selected].Command
	p.open = false
	return cmd, true
}

// refilter 根据当前 query 重新计算并排序结果。
// 空查询时展示全部命令(按标题稳定排序)。
func (p *Palette) refilter() {
	p.results = p.results[:0]
	q := strings.TrimSpace(p.query)
	if q == "" {
		for _, c := range p.commands {
			p.results = append(p.results, Result{Command: c, Score: 0, Hotkey: p.hotkey(c)})
		}
		sort.SliceStable(p.results, func(i, j int) bool {
			return p.results[i].Command.Title < p.results[j].Command.Title
		})
		p.clampSelected()
		return
	}
	for _, c := range p.commands {
		if s, ok := scoreCommand(c, q); ok {
			p.results = append(p.results, Result{Command: c, Score: s, Hotkey: p.hotkey(c)})
		}
	}
	// 分数降序;同分按标题字典序,保证结果稳定。
	sort.SliceStable(p.results, func(i, j int) bool {
		if p.results[i].Score != p.results[j].Score {
			return p.results[i].Score > p.results[j].Score
		}
		return p.results[i].Command.Title < p.results[j].Command.Title
	})
	p.clampSelected()
}

// clampSelected 保证选中项落在有效范围。
func (p *Palette) clampSelected() {
	if p.selected >= len(p.results) {
		p.selected = len(p.results) - 1
	}
	if p.selected < 0 {
		p.selected = 0
	}
}

// hotkey 返回某命令的热键提示;无 keymap 或无绑定返回空串。
func (p *Palette) hotkey(c Command) string {
	if p.km == nil {
		return ""
	}
	if ch, ok := p.km.ChordFor(c.Action); ok {
		return ch.String()
	}
	return ""
}

// scoreCommand 对单条命令按查询打分:取 Title 与各 Keyword 中的最高分。
// 未命中返回 (0,false)。
func scoreCommand(c Command, query string) (int, bool) {
	q := strings.ToLower(query)
	best, hit := 0, false
	consider := func(text string, weight int) {
		if s, ok := fuzzyScore(strings.ToLower(text), q); ok {
			s += weight
			if s > best {
				best = s
			}
			hit = true
		}
	}
	consider(c.Title, 6)  // 标题命中加权更高
	consider(c.ID, 4)     // ID 命中次之
	for _, kw := range c.Keywords {
		consider(kw, 0)
	}
	return best, hit
}

// fuzzyScore 计算 query 作为 text 子序列的匹配分:
//   - 命中一个字符 +1
//   - 连续命中额外 +2(奖励紧凑匹配)
//   - 命中出现在词首(开头或紧跟分隔符/空格)额外 +3
//
// query 必须是 text 的子序列才算命中;否则返回 (0,false)。
func fuzzyScore(text, query string) (int, bool) {
	if query == "" {
		return 0, true
	}
	tr := []rune(text)
	qr := []rune(query)
	score, qi, prevMatched := 0, 0, false
	for ti := 0; ti < len(tr) && qi < len(qr); ti++ {
		if tr[ti] != qr[qi] {
			prevMatched = false
			continue
		}
		score++
		if prevMatched {
			score += 2
		}
		if ti == 0 || isBoundary(tr[ti-1]) {
			score += 3
		}
		prevMatched = true
		qi++
	}
	if qi != len(qr) {
		return 0, false
	}
	return score, true
}

// isBoundary 判断某字符是否为词的分隔符(空格 / 常见标点)。
func isBoundary(r rune) bool {
	switch r {
	case ' ', '-', '_', '/', '.', '(', ')':
		return true
	default:
		return false
	}
}
