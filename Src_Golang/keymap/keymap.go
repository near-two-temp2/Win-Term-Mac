// Package keymap 把 Windows Terminal 的窗格键位映射到本方案的抽象动作(Action)。
//
// 设计哲学(与 WT 一致):高频操作给热键,低频强力操作(交换/移动窗格)
// 不绑热键、只走命令面板。因此本包只登记高频热键;SwapPane / MovePane 作为
// 动作存在但默认不出现在键表里,由 palette 包触发。
//
// 平台差异:WT 原生是 Windows,Ctrl 系热键在 macOS 上按约定换成 Cmd(Super)。
// Alt(macOS 的 Option)保持不变。DefaultKeymap 按平台自动完成这一替换。
package keymap

import "sort"

// Action 是与具体键位解耦的高层意图。渲染/控制层据此驱动窗格树操作。
type Action int

const (
	ActionNone Action = iota

	// 命令面板
	ActionOpenPalette // 打开可搜索命令面板(WT: Ctrl+Shift+P)

	// 拆分(把当前叶子换成分裂节点)
	ActionSplitRight // 向右拆分,新窗格在右(WT: Alt+Shift++)
	ActionSplitDown  // 向下拆分,新窗格在下(WT: Alt+Shift+-)

	// 切换焦点(按几何相邻)
	ActionFocusUp    // WT: Alt+Up
	ActionFocusDown  // WT: Alt+Down
	ActionFocusLeft  // WT: Alt+Left
	ActionFocusRight // WT: Alt+Right

	// 调整大小(移动分裂线)
	ActionResizeUp    // WT: Alt+Shift+Up
	ActionResizeDown  // WT: Alt+Shift+Down
	ActionResizeLeft  // WT: Alt+Shift+Left
	ActionResizeRight // WT: Alt+Shift+Right

	// 最大化 / 还原
	ActionToggleMaximize // WT: Ctrl+Shift+Enter(切换当前窗格全屏)

	// 关闭当前窗格
	ActionClosePane // WT: Ctrl+Shift+W

	// 低频强力操作:默认无热键,仅命令面板触发(见 palette 包)。
	ActionSwapPane // 交换两个窗格
	ActionMovePane // 移动窗格到别处
)

// String 返回动作的稳定英文名,便于日志与命令面板展示。
func (a Action) String() string {
	switch a {
	case ActionOpenPalette:
		return "OpenPalette"
	case ActionSplitRight:
		return "SplitRight"
	case ActionSplitDown:
		return "SplitDown"
	case ActionFocusUp:
		return "FocusUp"
	case ActionFocusDown:
		return "FocusDown"
	case ActionFocusLeft:
		return "FocusLeft"
	case ActionFocusRight:
		return "FocusRight"
	case ActionResizeUp:
		return "ResizeUp"
	case ActionResizeDown:
		return "ResizeDown"
	case ActionResizeLeft:
		return "ResizeLeft"
	case ActionResizeRight:
		return "ResizeRight"
	case ActionToggleMaximize:
		return "ToggleMaximize"
	case ActionClosePane:
		return "ClosePane"
	case ActionSwapPane:
		return "SwapPane"
	case ActionMovePane:
		return "MovePane"
	default:
		return "None"
	}
}

// Mod 是修饰键位掩码(可按位组合)。
type Mod uint8

const (
	ModShift Mod = 1 << iota
	ModAlt       // macOS 上即 Option
	ModCtrl      // 抽象层的“主修饰键”;macOS 上由 DefaultKeymap 换成 ModSuper
	ModSuper     // macOS 的 Cmd / 其他平台的 Meta 键
)

// has 判断掩码是否包含某修饰位。
func (m Mod) has(x Mod) bool { return m&x != 0 }

// Key 是与布局无关的按键标识(大写字母 / 方向键名 / 具名符号)。
// 例:"P" "Up" "Down" "Left" "Right" "Enter" "W" "Plus" "Minus"。
type Key string

const (
	KeyUp    Key = "Up"
	KeyDown  Key = "Down"
	KeyLeft  Key = "Left"
	KeyRight Key = "Right"
	KeyEnter Key = "Enter"
	KeyPlus  Key = "Plus"  // WT 的 “+” 拆分键
	KeyMinus Key = "Minus" // WT 的 “-” 拆分键
)

// Chord 是一次热键组合:一组修饰键 + 一个主键。
type Chord struct {
	Mods Mod
	Key  Key
}

// Platform 区分需要 Ctrl→Cmd 替换的平台。
type Platform int

const (
	PlatformOther Platform = iota // Windows / Linux:Ctrl 保持 Ctrl
	PlatformMac                   // macOS:Ctrl 换成 Cmd(Super)
)

// Binding 把一个 Chord 绑定到一个 Action。
type Binding struct {
	Chord  Chord
	Action Action
}

// baseBindings 用抽象修饰键(ModCtrl 表示“主修饰键”)描述 WT 的高频热键。
// 低频的 SwapPane / MovePane 有意不在此列——它们只经命令面板触发。
var baseBindings = []Binding{
	{Chord{ModCtrl | ModShift, "P"}, ActionOpenPalette},

	{Chord{ModAlt | ModShift, KeyPlus}, ActionSplitRight},
	{Chord{ModAlt | ModShift, KeyMinus}, ActionSplitDown},

	{Chord{ModAlt, KeyUp}, ActionFocusUp},
	{Chord{ModAlt, KeyDown}, ActionFocusDown},
	{Chord{ModAlt, KeyLeft}, ActionFocusLeft},
	{Chord{ModAlt, KeyRight}, ActionFocusRight},

	{Chord{ModAlt | ModShift, KeyUp}, ActionResizeUp},
	{Chord{ModAlt | ModShift, KeyDown}, ActionResizeDown},
	{Chord{ModAlt | ModShift, KeyLeft}, ActionResizeLeft},
	{Chord{ModAlt | ModShift, KeyRight}, ActionResizeRight},

	{Chord{ModCtrl | ModShift, KeyEnter}, ActionToggleMaximize},
	{Chord{ModCtrl | ModShift, "W"}, ActionClosePane},
}

// translateMods 按平台把抽象的 ModCtrl 换成实际修饰键:
// macOS 上 Ctrl→Cmd(Super),其余平台保持 Ctrl。
func translateMods(m Mod, plat Platform) Mod {
	if plat == PlatformMac && m.has(ModCtrl) {
		m = (m &^ ModCtrl) | ModSuper
	}
	return m
}

// Keymap 是 Chord→Action 的查表结构。
type Keymap struct {
	Platform Platform
	table    map[Chord]Action
}

// DefaultKeymap 生成指定平台的默认键表(已完成 Ctrl→Cmd 替换)。
func DefaultKeymap(plat Platform) *Keymap {
	km := &Keymap{Platform: plat, table: make(map[Chord]Action, len(baseBindings))}
	for _, b := range baseBindings {
		c := Chord{Mods: translateMods(b.Chord.Mods, plat), Key: b.Chord.Key}
		km.table[c] = b.Action
	}
	return km
}

// Lookup 查询某个 Chord 对应的动作;未绑定返回 (ActionNone, false)。
func (k *Keymap) Lookup(c Chord) (Action, bool) {
	a, ok := k.table[c]
	return a, ok
}

// Bind 覆盖或新增一条绑定(供用户自定义键位)。传入的 Chord 视为已是实际修饰键。
func (k *Keymap) Bind(c Chord, a Action) {
	if k.table == nil {
		k.table = make(map[Chord]Action)
	}
	k.table[c] = a
}

// Unbind 移除一条绑定。
func (k *Keymap) Unbind(c Chord) {
	delete(k.table, c)
}

// Bindings 返回当前所有绑定,按动作名排序,便于展示“快捷键一览”。
func (k *Keymap) Bindings() []Binding {
	out := make([]Binding, 0, len(k.table))
	for c, a := range k.table {
		out = append(out, Binding{Chord: c, Action: a})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Action.String() < out[j].Action.String()
	})
	return out
}

// ChordFor 返回触发某动作的第一个 Chord(用于在命令面板旁显示热键提示)。
// 无绑定(如 SwapPane / MovePane)返回 (Chord{}, false)。
func (k *Keymap) ChordFor(a Action) (Chord, bool) {
	for c, act := range k.table {
		if act == a {
			return c, true
		}
	}
	return Chord{}, false
}

// String 返回 Chord 的人类可读文本,如 "Ctrl+Shift+P" / "Cmd+Shift+Enter" / "Alt+Left"。
// 顺序固定为 Ctrl/Cmd → Alt → Shift → Key,便于稳定展示。
func (c Chord) String() string {
	var s string
	add := func(part string) {
		if s != "" {
			s += "+"
		}
		s += part
	}
	if c.Mods.has(ModSuper) {
		add("Cmd")
	}
	if c.Mods.has(ModCtrl) {
		add("Ctrl")
	}
	if c.Mods.has(ModAlt) {
		add("Alt")
	}
	if c.Mods.has(ModShift) {
		add("Shift")
	}
	add(keyLabel(c.Key))
	return s
}

// keyLabel 把具名键转成展示符号。
func keyLabel(k Key) string {
	switch k {
	case KeyPlus:
		return "+"
	case KeyMinus:
		return "-"
	default:
		return string(k)
	}
}
