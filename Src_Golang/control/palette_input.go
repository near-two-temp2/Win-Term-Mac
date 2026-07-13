// 本文件让命令面板「开箱可用」:把 Gio 的按键事件直接驱动面板的搜索/导航/确认,
// 整合层无需另接一个文本编辑器控件。面板打开时,整合层把焦点视图收到的按键先交给
// HandlePaletteKey;返回 true 表示已被面板消费(不下发给 shell、也不走窗格键)。
package control

import (
	"gioui.org/io/key"
)

// HandlePaletteKey 在命令面板打开时处理一次按键。约定只处理 Press。
// 语义:
//   - Esc            → 关闭面板;
//   - Enter/Return   → 确认当前高亮命令(见 ConfirmPalette);
//   - ↑ / ↓          → 上下移动高亮;
//   - Backspace      → 删除查询串末尾一个字符;
//   - 可打印字符      → 追加到查询串(按 US 布局重建,含 Shift 符号)。
//
// 返回是否消费了该键。面板未打开时一律返回 false。
func (c *Controller) HandlePaletteKey(e key.Event) bool {
	if !c.pal.IsOpen() || e.State != key.Press {
		return false
	}
	switch e.Name {
	case key.NameEscape:
		c.pal.Close()
		return true
	case key.NameReturn, key.NameEnter:
		c.ConfirmPalette()
		return true
	case key.NameUpArrow:
		c.pal.MoveSelection(-1)
		return true
	case key.NameDownArrow:
		c.pal.MoveSelection(+1)
		return true
	case key.NameDeleteBackward:
		q := []rune(c.pal.Query())
		if len(q) > 0 {
			c.pal.SetQuery(string(q[:len(q)-1]))
		}
		return true
	}
	if r, ok := printableRune(e); ok {
		c.pal.SetQuery(c.pal.Query() + string(r))
		return true
	}
	// 其它按键(纯修饰键、功能键等):面板打开时一律吞掉,避免漏到 shell。
	return true
}

// printableRune 按 US 布局把一次按键还原成可打印字符。字母默认小写、Shift 大写;
// 数字/符号按 Shift 映射。非可打印键返回 (0,false)。
func printableRune(e key.Event) (rune, bool) {
	s := string(e.Name)
	if len(s) != 1 {
		if e.Name == key.NameSpace {
			return ' ', true
		}
		return 0, false
	}
	r := rune(s[0])
	shift := e.Modifiers.Contain(key.ModShift)
	// 带 Ctrl/Alt/Cmd 的组合不当作文本输入。
	if e.Modifiers.Contain(key.ModCtrl) || e.Modifiers.Contain(key.ModAlt) ||
		e.Modifiers.Contain(key.ModSuper) || e.Modifiers.Contain(key.ModCommand) {
		return 0, false
	}
	if r >= 'A' && r <= 'Z' {
		if !shift {
			r += 'a' - 'A' // Gio 具名字母恒为大写,默认转小写
		}
		return r, true
	}
	if shift {
		if m, ok := usShift[r]; ok {
			return m, true
		}
	}
	return r, true
}

// usShift 是 US 键盘按住 Shift 时数字/符号键的字符映射(与 term 包保持一致)。
var usShift = map[rune]rune{
	'1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^',
	'7': '&', '8': '*', '9': '(', '0': ')',
	'-': '_', '=': '+', '[': '{', ']': '}', '\\': '|',
	';': ':', '\'': '"', ',': '<', '.': '>', '/': '?', '`': '~',
}
