// Package iobridge 是 PTY 双向 IO 桥:把上层的键盘事件编码成终端字节流写给
// shell,把窗口像素尺寸换算成行列通知 pty,并向渲染层提供“需要重绘”的信号。
//
// 目录名为 io、包名为 iobridge:导入路径是 "winterm/io",但引用时用包名
// iobridge(例:import "winterm/io" 后写 iobridge.New(...))。
//
// 本文件是「输入编码器」部分:实现与 xterm 兼容的按键→字节序列映射
// (方向键 CSI、Ctrl 控制字符、Alt 前缀 ESC、功能键等)。这是本模块最核心的
// 新增逻辑;IO 收发的另一半(启动 shell、读输出喂网格、Write/Resize)复用
// term.Session,不重复造轮子。
//
// 光标键模式说明:这里按「普通(normal)光标键模式」输出 CSI 序列(ESC[A 等)。
// TODO(app-cursor-mode): 当 VT 核支持 DECCKM(应用光标键模式)后,应在该模式下
// 把方向键/Home/End 改成 SS3 形式(ESC O A 等)。
package iobridge

import (
	"fmt"

	"winterm/keymap"
)

const esc = 0x1b // ESC 控制字符

// NamedKey 是不产生普通文本的具名功能键。文本输入走 KeyEvent.Rune,不用这里。
type NamedKey uint8

const (
	KeyNone      NamedKey = iota // 非具名键:表示这是一次文本(Rune)输入
	KeyEnter                     // 回车 / Return
	KeyTab                       // 制表
	KeyBackspace                 // 退格
	KeyEscape                    // Esc
	KeyUp
	KeyDown
	KeyRight
	KeyLeft
	KeyHome
	KeyEnd
	KeyInsert
	KeyDelete
	KeyPageUp
	KeyPageDown
	KeyF1
	KeyF2
	KeyF3
	KeyF4
	KeyF5
	KeyF6
	KeyF7
	KeyF8
	KeyF9
	KeyF10
	KeyF11
	KeyF12
)

// KeyEvent 是与具体 GUI 框架(Gio 等)解耦的一次按键。
// integrator 负责把 gioui.org/io/key 的事件翻译成本结构:
//   - 具名功能键:置 Name(此时 Rune 忽略);
//   - 文本/字符输入:置 Rune、Name 留 KeyNone。
//
// Mods 复用 keymap.Mod 的位掩码(ModShift/ModAlt/ModCtrl/ModSuper),避免另立一套。
type KeyEvent struct {
	Name NamedKey
	Rune rune
	Mods keymap.Mod
}

// 便捷的修饰位判断。
func hasShift(m keymap.Mod) bool { return m&keymap.ModShift != 0 }
func hasAlt(m keymap.Mod) bool   { return m&keymap.ModAlt != 0 }
func hasCtrl(m keymap.Mod) bool  { return m&keymap.ModCtrl != 0 }
func hasSuper(m keymap.Mod) bool { return m&keymap.ModSuper != 0 }

// Encode 把一次按键编码为要写入 PTY 的字节序列。
// 返回 nil 表示“不产生 PTY 字节”(例如带 Cmd/Super 的组合是应用级快捷键,
// 应由命令面板 / keymap 处理,而不是发给 shell)。
func Encode(ev KeyEvent) []byte {
	// Cmd/Super(macOS 的 Command)组合一律视为应用快捷键,不下发给 shell。
	if hasSuper(ev.Mods) {
		return nil
	}
	if ev.Name != KeyNone {
		return encodeNamed(ev.Name, ev.Mods)
	}
	if ev.Rune != 0 {
		return encodeRune(ev.Rune, ev.Mods)
	}
	return nil
}

// modCode 计算 xterm 修饰键编码:1 + Shift(1) + Alt(2) + Ctrl(4)。
// 返回 1 表示无修饰(输出未修饰形式)。
func modCode(m keymap.Mod) int {
	code := 1
	if hasShift(m) {
		code += 1
	}
	if hasAlt(m) {
		code += 2
	}
	if hasCtrl(m) {
		code += 4
	}
	return code
}

// csiCursor 生成方向键 / Home / End 的 CSI 序列。
// 无修饰:ESC [ <final>;带修饰:ESC [ 1 ; <code> <final>。
func csiCursor(final byte, m keymap.Mod) []byte {
	c := modCode(m)
	if c == 1 {
		return []byte{esc, '[', final}
	}
	return []byte(fmt.Sprintf("\x1b[1;%d%c", c, final))
}

// csiTilde 生成 Insert/Delete/PageUp/PageDown/F5+ 这类“数字 ~”序列。
// 无修饰:ESC [ <num> ~;带修饰:ESC [ <num> ; <code> ~。
func csiTilde(num int, m keymap.Mod) []byte {
	c := modCode(m)
	if c == 1 {
		return []byte(fmt.Sprintf("\x1b[%d~", num))
	}
	return []byte(fmt.Sprintf("\x1b[%d;%d~", num, c))
}

// ss3Func 生成 F1–F4 的序列:无修饰用 SS3(ESC O P/Q/R/S),
// 带修饰用 ESC [ 1 ; <code> <final>。
func ss3Func(final byte, m keymap.Mod) []byte {
	c := modCode(m)
	if c == 1 {
		return []byte{esc, 'O', final}
	}
	return []byte(fmt.Sprintf("\x1b[1;%d%c", c, final))
}

// withAlt 在字节序列前加 ESC(Meta/Alt 前缀),用于非 CSI 的简单键。
func withAlt(b []byte, m keymap.Mod) []byte {
	if hasAlt(m) {
		return append([]byte{esc}, b...)
	}
	return b
}

// encodeNamed 编码具名功能键。
func encodeNamed(k NamedKey, m keymap.Mod) []byte {
	switch k {
	case KeyEnter:
		// 回车发 CR;Alt+Enter 前缀 ESC。
		return withAlt([]byte{'\r'}, m)
	case KeyTab:
		// Shift+Tab 走反向制表 CSI Z;普通 Tab 发 HT,Alt 前缀 ESC。
		if hasShift(m) {
			return []byte{esc, '[', 'Z'}
		}
		return withAlt([]byte{'\t'}, m)
	case KeyBackspace:
		// 约定退格发 DEL(0x7f);Ctrl+Backspace 发 BS(0x08);Alt 前缀 ESC。
		if hasCtrl(m) {
			return withAlt([]byte{0x08}, m&^keymap.ModCtrl)
		}
		return withAlt([]byte{0x7f}, m)
	case KeyEscape:
		return withAlt([]byte{esc}, m)
	case KeyUp:
		return csiCursor('A', m)
	case KeyDown:
		return csiCursor('B', m)
	case KeyRight:
		return csiCursor('C', m)
	case KeyLeft:
		return csiCursor('D', m)
	case KeyHome:
		return csiCursor('H', m)
	case KeyEnd:
		return csiCursor('F', m)
	case KeyInsert:
		return csiTilde(2, m)
	case KeyDelete:
		return csiTilde(3, m)
	case KeyPageUp:
		return csiTilde(5, m)
	case KeyPageDown:
		return csiTilde(6, m)
	case KeyF1:
		return ss3Func('P', m)
	case KeyF2:
		return ss3Func('Q', m)
	case KeyF3:
		return ss3Func('R', m)
	case KeyF4:
		return ss3Func('S', m)
	case KeyF5:
		return csiTilde(15, m)
	case KeyF6:
		return csiTilde(17, m)
	case KeyF7:
		return csiTilde(18, m)
	case KeyF8:
		return csiTilde(19, m)
	case KeyF9:
		return csiTilde(20, m)
	case KeyF10:
		return csiTilde(21, m)
	case KeyF11:
		return csiTilde(23, m)
	case KeyF12:
		return csiTilde(24, m)
	}
	return nil
}

// encodeRune 编码普通字符输入。
//   - Ctrl+字母/符号 → 对应控制字节(如 Ctrl+C=0x03);
//   - Alt+字符 → 在字符的 UTF-8 前加 ESC;
//   - 其余 → 字符的 UTF-8 编码。
func encodeRune(r rune, m keymap.Mod) []byte {
	var b []byte
	if hasCtrl(m) {
		if c, ok := ctrlByte(r); ok {
			b = []byte{c}
		} else {
			// 无法映射为控制字节的 Ctrl 组合:退化为原字符。
			b = []byte(string(r))
		}
	} else {
		b = []byte(string(r))
	}
	if hasAlt(m) {
		b = append([]byte{esc}, b...)
	}
	return b
}

// ctrlByte 返回 Ctrl+r 对应的控制字节。
// 字母 a–z / A–Z → 1–26;外加常见符号:空格/@=NUL,[ \ ] ^ _ ? 等。
func ctrlByte(r rune) (byte, bool) {
	switch {
	case r >= 'a' && r <= 'z':
		return byte(r-'a') + 1, true
	case r >= 'A' && r <= 'Z':
		return byte(r-'A') + 1, true
	case r == ' ' || r == '@':
		return 0, true // NUL
	case r == '[':
		return 27, true // ESC
	case r == '\\':
		return 28, true // FS
	case r == ']':
		return 29, true // GS
	case r == '^':
		return 30, true // RS
	case r == '_':
		return 31, true // US
	case r == '?':
		return 127, true // DEL
	}
	return 0, false
}
