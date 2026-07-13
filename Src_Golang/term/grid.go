// Package term 承载终端会话:creack/pty 起 shell,接一个 VT 解析器维护字符网格,
// 并向渲染层暴露只读快照接口。本文件是 VT 解析器 + 网格(grid)部分。
//
// 说明:这里内置一个「够用的桩解析器」,只依赖标准库,保证无 cgo、可交叉编译、
// 能独立编译通过。它处理可打印字符、常见控制符(CR/LF/BS/TAB)、并吞掉大部分
// CSI/OSC 转义序列以免乱码污染网格,足以跑通单窗格 shell 的基本回显。
//
// TODO(vt-core): 生产实现应把本桩替换为成熟 VT 核 —— 纯 Go 的 vt10x /
// hinshun/vt,或 libvterm 的 cgo 绑定 —— 以支持完整的 SGR 颜色、滚动区、
// 光标属性、字符集切换等。替换时保持 Grid / Cell / Snapshot 的对外形状不变,
// 渲染层就无需改动。
package term

import "sync"

// Cell 网格中的一个字符单元。渲染层按此逐格绘制。
// 目前只带字形与一个占位的 SGR 属性位;颜色留给后续 VT 核补全。
type Cell struct {
	Rune rune // 该单元的字形;0 或空格表示空白
	Attr uint16 // SGR 属性占位(粗体/反显等),桩实现暂不填充
}

// Cursor 光标位置(0 基,行列)。
type Cursor struct {
	Row int
	Col int
}

// Grid 是固定行列的字符网格 + 光标状态。
// 所有导出方法都持有内部锁,读循环(写)与渲染层(读)可并发安全访问。
type Grid struct {
	mu     sync.RWMutex
	rows   int
	cols   int
	cells  []Cell // 长度 rows*cols,行主序
	cursor Cursor

	// parser 状态机:见 feed 中的转义序列处理
	state escState
}

// escState 是极简转义序列解析状态。
type escState int

const (
	stateGround  escState = iota // 普通字符流
	stateEsc                     // 刚读到 ESC(0x1b)
	stateCSI                     // ESC [ ... 直到最终字节
	stateOSC                     // ESC ] ... 直到 BEL 或 ST
)

// NewGrid 按给定行列创建空网格。cols/rows 不合法时回退到 80x24。
func NewGrid(cols, rows int) *Grid {
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	g := &Grid{rows: rows, cols: cols}
	g.cells = make([]Cell, rows*cols)
	return g
}

// Size 返回当前网格的列数与行数。
func (g *Grid) Size() (cols, rows int) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.cols, g.rows
}

// Resize 重设网格尺寸并尽量保留左上角已有内容。
func (g *Grid) Resize(cols, rows int) {
	if cols <= 0 || rows <= 0 {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	next := make([]Cell, rows*cols)
	// 拷贝重叠区域
	minRows := rows
	if g.rows < minRows {
		minRows = g.rows
	}
	minCols := cols
	if g.cols < minCols {
		minCols = g.cols
	}
	for r := 0; r < minRows; r++ {
		copy(next[r*cols:r*cols+minCols], g.cells[r*g.cols:r*g.cols+minCols])
	}
	g.cells = next
	g.rows = rows
	g.cols = cols
	if g.cursor.Row >= rows {
		g.cursor.Row = rows - 1
	}
	if g.cursor.Col >= cols {
		g.cursor.Col = cols - 1
	}
}

// Feed 把一段来自 PTY 的原始字节喂给解析器,推进网格状态。
// 由会话读循环调用;内部加锁,可与 Snapshot 并发。
func (g *Grid) Feed(p []byte) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, b := range p {
		g.step(b)
	}
}

// step 处理单个字节(已在锁内)。桩解析器:够跑通回显,不求完备。
func (g *Grid) step(b byte) {
	switch g.state {
	case stateEsc:
		switch b {
		case '[':
			g.state = stateCSI
		case ']':
			g.state = stateOSC
		default:
			// 其它两/三字节序列:简单吞掉引导字节后回到普通流
			g.state = stateGround
		}
		return
	case stateCSI:
		// CSI 参数字节 0x30-0x3f / 中间字节 0x20-0x2f,最终字节 0x40-0x7e 结束
		if b >= 0x40 && b <= 0x7e {
			g.state = stateGround
		}
		return
	case stateOSC:
		// OSC 以 BEL(0x07)或 ST(ESC \\)结束;这里简单地遇 BEL 收尾
		if b == 0x07 {
			g.state = stateGround
		}
		return
	}

	// stateGround:普通字符与控制符
	switch b {
	case 0x1b: // ESC
		g.state = stateEsc
	case '\n': // LF 换行
		g.lineFeed()
	case '\r': // CR 回到行首
		g.cursor.Col = 0
	case '\b': // BS 退格
		if g.cursor.Col > 0 {
			g.cursor.Col--
		}
	case '\t': // TAB 跳到下一个 8 列制表位
		next := (g.cursor.Col/8 + 1) * 8
		if next >= g.cols {
			next = g.cols - 1
		}
		g.cursor.Col = next
	case 0x07: // BEL 响铃,忽略
	default:
		if b >= 0x20 { // 可打印(桩:按 Latin-1 直取,UTF-8 组合留待真 VT 核)
			g.putRune(rune(b))
		}
	}
}

// putRune 在光标处写入一个字形并右移光标,越界则自动换行。
func (g *Grid) putRune(r rune) {
	if g.cursor.Col >= g.cols {
		g.cursor.Col = 0
		g.lineFeed()
	}
	idx := g.cursor.Row*g.cols + g.cursor.Col
	if idx >= 0 && idx < len(g.cells) {
		g.cells[idx] = Cell{Rune: r}
	}
	g.cursor.Col++
}

// lineFeed 光标下移一行,到底则整体上滚一行。
func (g *Grid) lineFeed() {
	if g.cursor.Row < g.rows-1 {
		g.cursor.Row++
		return
	}
	g.scrollUp()
}

// scrollUp 把整个网格上滚一行,底行清空。
func (g *Grid) scrollUp() {
	copy(g.cells, g.cells[g.cols:])
	bottom := g.cells[(g.rows-1)*g.cols:]
	for i := range bottom {
		bottom[i] = Cell{}
	}
}

// Snapshot 是网格的一次只读拷贝,供渲染层安全消费(不持锁绘制)。
type Snapshot struct {
	Cols   int
	Rows   int
	Cells  []Cell // 长度 Cols*Rows,行主序;调用方拥有此拷贝
	Cursor Cursor
}

// Snapshot 返回当前网格的深拷贝快照。渲染层每帧调用一次即可。
func (g *Grid) Snapshot() Snapshot {
	g.mu.RLock()
	defer g.mu.RUnlock()
	cp := make([]Cell, len(g.cells))
	copy(cp, g.cells)
	return Snapshot{
		Cols:   g.cols,
		Rows:   g.rows,
		Cells:  cp,
		Cursor: g.cursor,
	}
}

// CellAt 返回快照中指定行列的单元;越界返回空单元。
func (s Snapshot) CellAt(row, col int) Cell {
	if row < 0 || col < 0 || row >= s.Rows || col >= s.Cols {
		return Cell{}
	}
	return s.Cells[row*s.Cols+col]
}
