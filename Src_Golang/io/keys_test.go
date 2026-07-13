package iobridge

import (
	"bytes"
	"testing"

	"winterm/keymap"
)

func TestEncodeNamed(t *testing.T) {
	cases := []struct {
		name string
		ev   KeyEvent
		want []byte
	}{
		{"Enter", KeyEvent{Name: KeyEnter}, []byte{'\r'}},
		{"AltEnter", KeyEvent{Name: KeyEnter, Mods: keymap.ModAlt}, []byte{esc, '\r'}},
		{"Tab", KeyEvent{Name: KeyTab}, []byte{'\t'}},
		{"ShiftTab", KeyEvent{Name: KeyTab, Mods: keymap.ModShift}, []byte{esc, '[', 'Z'}},
		{"Backspace", KeyEvent{Name: KeyBackspace}, []byte{0x7f}},
		{"CtrlBackspace", KeyEvent{Name: KeyBackspace, Mods: keymap.ModCtrl}, []byte{0x08}},
		{"Escape", KeyEvent{Name: KeyEscape}, []byte{esc}},
		{"Up", KeyEvent{Name: KeyUp}, []byte("\x1b[A")},
		{"Down", KeyEvent{Name: KeyDown}, []byte("\x1b[B")},
		{"Right", KeyEvent{Name: KeyRight}, []byte("\x1b[C")},
		{"Left", KeyEvent{Name: KeyLeft}, []byte("\x1b[D")},
		{"CtrlLeft", KeyEvent{Name: KeyLeft, Mods: keymap.ModCtrl}, []byte("\x1b[1;5D")},
		{"ShiftUp", KeyEvent{Name: KeyUp, Mods: keymap.ModShift}, []byte("\x1b[1;2A")},
		{"Home", KeyEvent{Name: KeyHome}, []byte("\x1b[H")},
		{"End", KeyEvent{Name: KeyEnd}, []byte("\x1b[F")},
		{"Delete", KeyEvent{Name: KeyDelete}, []byte("\x1b[3~")},
		{"PageUp", KeyEvent{Name: KeyPageUp}, []byte("\x1b[5~")},
		{"CtrlDelete", KeyEvent{Name: KeyDelete, Mods: keymap.ModCtrl}, []byte("\x1b[3;5~")},
		{"F1", KeyEvent{Name: KeyF1}, []byte("\x1bOP")},
		{"F5", KeyEvent{Name: KeyF5}, []byte("\x1b[15~")},
		{"F12", KeyEvent{Name: KeyF12}, []byte("\x1b[24~")},
	}
	for _, c := range cases {
		got := Encode(c.ev)
		if !bytes.Equal(got, c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestEncodeRune(t *testing.T) {
	cases := []struct {
		name string
		ev   KeyEvent
		want []byte
	}{
		{"a", KeyEvent{Rune: 'a'}, []byte("a")},
		{"CtrlC", KeyEvent{Rune: 'c', Mods: keymap.ModCtrl}, []byte{0x03}},
		{"CtrlD", KeyEvent{Rune: 'd', Mods: keymap.ModCtrl}, []byte{0x04}},
		{"CtrlSpace", KeyEvent{Rune: ' ', Mods: keymap.ModCtrl}, []byte{0x00}},
		{"AltA", KeyEvent{Rune: 'a', Mods: keymap.ModAlt}, []byte{esc, 'a'}},
		{"UTF8", KeyEvent{Rune: '中'}, []byte("中")},
	}
	for _, c := range cases {
		got := Encode(c.ev)
		if !bytes.Equal(got, c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestEncodeSuperIgnored(t *testing.T) {
	// Cmd/Super 组合是应用级快捷键,不应产生 PTY 字节。
	if got := Encode(KeyEvent{Rune: 'c', Mods: keymap.ModSuper}); got != nil {
		t.Errorf("Super+c 应返回 nil,got %v", got)
	}
}

func TestCellsFor(t *testing.T) {
	cols, rows := CellsFor(800, 480, 8, 16)
	if cols != 100 || rows != 30 {
		t.Errorf("CellsFor: got %dx%d, want 100x30", cols, rows)
	}
	// 下限保护:极小像素也至少 1x1。
	if c, r := CellsFor(1, 1, 8, 16); c != 1 || r != 1 {
		t.Errorf("CellsFor floor: got %dx%d, want 1x1", c, r)
	}
}
