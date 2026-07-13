// term 输入翻译与行拼接的纯逻辑单测。不依赖 Gio 的绘制,只覆盖字节映射与网格取行。
package term

import (
	"bytes"
	"testing"

	"gioui.org/io/key"
)

func TestKeyToBytes_LettersAndCtrl(t *testing.T) {
	cases := []struct {
		name key.Name
		mods key.Modifiers
		want []byte
	}{
		{"A", 0, []byte("a")},                // 默认小写
		{"A", key.ModShift, []byte("A")},     // Shift 大写
		{"C", key.ModCtrl, []byte{0x03}},     // Ctrl-C
		{"M", key.ModCtrl, []byte{0x0d}},     // Ctrl-M = CR
		{"1", 0, []byte("1")},                // 数字
		{"1", key.ModShift, []byte("!")},     // US Shift 符号
		{"A", key.ModAlt, []byte{0x1b, 'a'}}, // Alt 前缀 ESC
	}
	for _, c := range cases {
		got := keyToBytes(key.Event{Name: c.name, Modifiers: c.mods, State: key.Press})
		if !bytes.Equal(got, c.want) {
			t.Errorf("keyToBytes(%q,%v)=%v want %v", c.name, c.mods, got, c.want)
		}
	}
}

func TestKeyToBytes_NamedKeys(t *testing.T) {
	cases := []struct {
		name key.Name
		want []byte
	}{
		{key.NameReturn, []byte{'\r'}},
		{key.NameDeleteBackward, []byte{0x7f}},
		{key.NameTab, []byte{'\t'}},
		{key.NameEscape, []byte{0x1b}},
		{key.NameUpArrow, []byte("\x1b[A")},
		{key.NameLeftArrow, []byte("\x1b[D")},
	}
	for _, c := range cases {
		got := keyToBytes(key.Event{Name: c.name, State: key.Press})
		if !bytes.Equal(got, c.want) {
			t.Errorf("keyToBytes(%q)=%v want %v", c.name, got, c.want)
		}
	}
}

func TestRowString(t *testing.T) {
	s := Snapshot{Cols: 5, Rows: 1, Cells: []Cell{
		{Rune: 'h'}, {Rune: 'i'}, {}, {}, {},
	}}
	if got := rowString(s, 0); got != "hi" { // 行尾空白被裁掉
		t.Errorf("rowString=%q want %q", got, "hi")
	}
	if got := rowString(s, 9); got != "" { // 越界行返回空
		t.Errorf("rowString(oob)=%q want empty", got)
	}
}
