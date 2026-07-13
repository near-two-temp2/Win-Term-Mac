// Package control 是「命令面板 + 键位」的装配层:把 keymap 的抽象动作(Action)、
// palette 的命令面板、以及 pane 的窗格树三者接线到一起,让 SplitPane / SwapPane /
// MovePane / MoveFocus / ResizePane 真正作用到窗格树与视图。
//
// 分工(与既有代码复用,不另造一套):
//   - 窗格树结构操作:直接调用 pane.Tree 的 Split/Swap/Move/Detach/Navigate。
//   - 键位表:直接用 keymap.DefaultKeymap 与 keymap.Lookup。
//   - 命令面板:直接用 palette.Palette(搜索、排序、Confirm 都在那儿)。
//
// 本包只负责“动作 → 树/焦点的落地”,以及把 Gio 的按键事件翻成 keymap.Chord。
//
// 本文件是「Gio 按键 → keymap.Chord」翻译器:让整合层能把持有焦点视图收到的
// key.Event 直接查表成窗格动作。
package control

import (
	"gioui.org/io/key"

	"winterm/keymap"
)

// ChordFromGio 把一次 Gio 按键事件翻成 keymap.Chord。
// 返回的 ok=false 表示该键不是我们关心的窗格键(整合层应把它继续发给 shell)。
//
// 修饰键按物理键忠实映射:Cmd(macOS 的 Command)→ ModSuper,Ctrl → ModCtrl,
// 以便与 keymap.DefaultKeymap 生成的平台表对上(mac 表里主修饰键已是 Super)。
func ChordFromGio(e key.Event) (keymap.Chord, bool) {
	k, ok := keyFromGio(e.Name)
	if !ok {
		return keymap.Chord{}, false
	}
	return keymap.Chord{Mods: modsFromGio(e.Modifiers), Key: k}, true
}

// modsFromGio 把 Gio 的修饰位翻成 keymap.Mod。Cmd/Command 归一到 Super。
func modsFromGio(m key.Modifiers) keymap.Mod {
	var out keymap.Mod
	if m.Contain(key.ModShift) {
		out |= keymap.ModShift
	}
	if m.Contain(key.ModAlt) {
		out |= keymap.ModAlt
	}
	if m.Contain(key.ModCtrl) {
		out |= keymap.ModCtrl
	}
	if m.Contain(key.ModSuper) || m.Contain(key.ModCommand) {
		out |= keymap.ModSuper
	}
	return out
}

// keyFromGio 把 Gio 的 key.Name 翻成 keymap.Key。只覆盖窗格键位用得到的键:
// 方向键、Enter、字母,以及拆分用的 “+”(= 键)/ “-”。其余返回 false。
func keyFromGio(n key.Name) (keymap.Key, bool) {
	switch n {
	case key.NameUpArrow:
		return keymap.KeyUp, true
	case key.NameDownArrow:
		return keymap.KeyDown, true
	case key.NameLeftArrow:
		return keymap.KeyLeft, true
	case key.NameRightArrow:
		return keymap.KeyRight, true
	case key.NameReturn, key.NameEnter:
		return keymap.KeyEnter, true
	}
	// 单字符键:字母原样(Gio 恒为大写),= → Plus,- → Minus。
	s := string(n)
	if len(s) == 1 {
		r := s[0]
		switch {
		case r >= 'A' && r <= 'Z':
			return keymap.Key(s), true
		case r == '=' || r == '+':
			return keymap.KeyPlus, true
		case r == '-':
			return keymap.KeyMinus, true
		}
	}
	return keymap.Key(""), false
}
