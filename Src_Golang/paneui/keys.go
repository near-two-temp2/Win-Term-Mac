// 本文件是 paneui 的「按键→和弦」桥:把 Gio 的 key.Event 翻译成 keymap.Chord,
// 便于整合层在 term.View.OnReserved 里做 km.Lookup 后交给 Controller.Enqueue。
// 只识别与窗格操作相关的键(方向键、字母、+/-、回车);其余返回 false,让整合层
// 把按键继续下发给 shell。
package paneui

import (
	"gioui.org/io/key"

	"winterm/keymap"
)

// ChordFromKey 把一次 Gio 按键翻成 keymap.Chord。ok=false 表示这不是一个我们
// 关心的和弦(整合层应放行,交给终端 / shell)。
func ChordFromKey(e key.Event) (keymap.Chord, bool) {
	k, ok := chordKey(e.Name)
	if !ok {
		return keymap.Chord{}, false
	}
	var m keymap.Mod
	if e.Modifiers.Contain(key.ModShift) {
		m |= keymap.ModShift
	}
	if e.Modifiers.Contain(key.ModAlt) {
		m |= keymap.ModAlt
	}
	if e.Modifiers.Contain(key.ModCtrl) {
		m |= keymap.ModCtrl
	}
	if e.Modifiers.Contain(key.ModSuper) || e.Modifiers.Contain(key.ModCommand) {
		m |= keymap.ModSuper
	}
	return keymap.Chord{Mods: m, Key: k}, true
}

// chordKey 把 Gio 的具名键映射到 keymap.Key。
//   - 方向键 / 回车:直接映射;
//   - 单个大写字母(Gio 恒为大写):作为字母键;
//   - "=" 或 "+"→KeyPlus(WT 的“+”拆分,US 键盘上是 Shift+=);"-"→KeyMinus。
func chordKey(n key.Name) (keymap.Key, bool) {
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
	s := string(n)
	if len(s) == 1 {
		switch r := s[0]; {
		case r >= 'A' && r <= 'Z':
			return keymap.Key(s), true
		case r == '=' || r == '+':
			return keymap.KeyPlus, true
		case r == '-':
			return keymap.KeyMinus, true
		}
	}
	return "", false
}
