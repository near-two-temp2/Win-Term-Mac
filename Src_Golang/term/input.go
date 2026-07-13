// 本文件是 term 视图的「输入翻译」部分:把 Gio 的按键事件(key.Event)翻译成
// 要写回 PTY 的原始字节 —— 具名键(方向/回车/退格/功能键)→ 转义序列或控制字节;
// 可打印键 → 按 US 布局重建字符(含 Shift 大小写与符号)与 Ctrl+字母 控制字符。
//
// 之所以不走 EditEvent/IME,是为了在最少依赖下先把 ASCII 命令敲通(见 view.go
// processInput 里的 TODO)。这里的函数是纯逻辑,便于单测。
package term

import (
	"gioui.org/io/event"
	"gioui.org/io/key"
	"gioui.org/io/pointer"
)

// inputFilters 返回本视图要订阅的事件过滤器集合:
//   - 焦点变化;
//   - 指针按下(取焦点);
//   - 一批按键(字母/数字/常用符号/具名键),均带可选修饰键以便读取 Ctrl/Alt/Shift。
func inputFilters(tag any) []event.Filter {
	fs := []event.Filter{
		key.FocusFilter{Target: tag},
		pointer.Filter{Target: tag, Kinds: pointer.Press},
	}
	opt := key.ModCtrl | key.ModShift | key.ModAlt | key.ModSuper | key.ModCommand
	add := func(n key.Name) {
		fs = append(fs, key.Filter{Focus: tag, Name: n, Optional: opt})
	}
	// 字母
	for r := 'A'; r <= 'Z'; r++ {
		add(key.Name(string(r)))
	}
	// 数字
	for r := '0'; r <= '9'; r++ {
		add(key.Name(string(r)))
	}
	// 具名/编辑键
	for _, n := range namedKeys {
		add(n)
	}
	// 常用可打印符号键(其 Name 即字面字符)
	for _, r := range punctKeys {
		add(key.Name(string(r)))
	}
	return fs
}

// namedKeys 是需要转义序列/控制字节的具名键。
var namedKeys = []key.Name{
	key.NameReturn, key.NameEnter,
	key.NameDeleteBackward, key.NameDeleteForward,
	key.NameTab, key.NameEscape, key.NameSpace,
	key.NameUpArrow, key.NameDownArrow, key.NameLeftArrow, key.NameRightArrow,
	key.NameHome, key.NameEnd, key.NamePageUp, key.NamePageDown,
	key.NameF1, key.NameF2, key.NameF3, key.NameF4, key.NameF5, key.NameF6,
	key.NameF7, key.NameF8, key.NameF9, key.NameF10, key.NameF11, key.NameF12,
}

// punctKeys 是 Gio 以字面字符作为 Name 的可打印符号键(非 Shift 态)。
var punctKeys = []rune{
	'-', '=', '[', ']', '\\', ';', '\'', ',', '.', '/', '`',
}

// usShift 是 US 键盘上按住 Shift 时数字/符号键的字符映射。
var usShift = map[rune]rune{
	'1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^',
	'7': '&', '8': '*', '9': '(', '0': ')',
	'-': '_', '=': '+', '[': '{', ']': '}', '\\': '|',
	';': ':', '\'': '"', ',': '<', '.': '>', '/': '?', '`': '~',
}

// keyToBytes 把一次按键(应为 Press)翻译成写回 PTY 的字节;无对应则返回 nil。
func keyToBytes(e key.Event) []byte {
	ctrl := e.Modifiers.Contain(key.ModCtrl)
	shift := e.Modifiers.Contain(key.ModShift)
	alt := e.Modifiers.Contain(key.ModAlt)

	// 先处理具名键(不受 US 重建影响)。
	if b := namedKeyBytes(e.Name); b != nil {
		return withAlt(b, alt)
	}

	// 可打印键:Name 为单个字符。
	rs := []rune(string(e.Name))
	if len(rs) != 1 {
		return nil
	}
	r := rs[0]

	// 字母:Ctrl+字母 → 控制字符(C0);否则按 Shift 决定大小写。
	if r >= 'A' && r <= 'Z' {
		if ctrl {
			return withAlt([]byte{byte(r-'A') + 1}, alt) // Ctrl-A=0x01 … Ctrl-Z=0x1a
		}
		if !shift {
			r = r + ('a' - 'A') // Gio 具名字母恒为大写,默认转小写
		}
		return withAlt([]byte(string(r)), alt)
	}

	// 数字/符号:Ctrl 组合多无通用字节,忽略;否则按 US 布局(含 Shift)输出。
	if ctrl {
		return nil
	}
	if shift {
		if m, ok := usShift[r]; ok {
			r = m
		}
	}
	return withAlt([]byte(string(r)), alt)
}

// namedKeyBytes 把具名键映射为控制字节或转义序列。
func namedKeyBytes(n key.Name) []byte {
	switch n {
	case key.NameReturn, key.NameEnter:
		return []byte{'\r'}
	case key.NameDeleteBackward:
		return []byte{0x7f} // DEL,多数行规程用它作退格
	case key.NameDeleteForward:
		return []byte("\x1b[3~")
	case key.NameTab:
		return []byte{'\t'}
	case key.NameEscape:
		return []byte{0x1b}
	case key.NameSpace:
		return []byte{' '}
	case key.NameUpArrow:
		return []byte("\x1b[A")
	case key.NameDownArrow:
		return []byte("\x1b[B")
	case key.NameRightArrow:
		return []byte("\x1b[C")
	case key.NameLeftArrow:
		return []byte("\x1b[D")
	case key.NameHome:
		return []byte("\x1b[H")
	case key.NameEnd:
		return []byte("\x1b[F")
	case key.NamePageUp:
		return []byte("\x1b[5~")
	case key.NamePageDown:
		return []byte("\x1b[6~")
	case key.NameF1:
		return []byte("\x1bOP")
	case key.NameF2:
		return []byte("\x1bOQ")
	case key.NameF3:
		return []byte("\x1bOR")
	case key.NameF4:
		return []byte("\x1bOS")
	case key.NameF5:
		return []byte("\x1b[15~")
	case key.NameF6:
		return []byte("\x1b[17~")
	case key.NameF7:
		return []byte("\x1b[18~")
	case key.NameF8:
		return []byte("\x1b[19~")
	case key.NameF9:
		return []byte("\x1b[20~")
	case key.NameF10:
		return []byte("\x1b[21~")
	case key.NameF11:
		return []byte("\x1b[23~")
	case key.NameF12:
		return []byte("\x1b[24~")
	default:
		return nil
	}
}

// withAlt 实现 Alt/Meta 键:按惯例在序列前加一个 ESC 前缀。
func withAlt(b []byte, alt bool) []byte {
	if !alt || len(b) == 0 {
		return b
	}
	out := make([]byte, 0, len(b)+1)
	out = append(out, 0x1b)
	return append(out, b...)
}
