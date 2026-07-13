// 本文件是 iobridge 的「桥接器」部分:把一个终端会话(term.Session,通常挂在
// 某个 pane.Pane 叶子的 Payload 上)与三条 IO 通路连起来——
//   1) 键盘输入:integrator 把 GUI 按键翻成 KeyEvent → SendKey → 编码 → 写 PTY;
//   2) shell 输出:term.Session 的读循环已把输出喂进网格,这里提供“内容变化 →
//      需要重绘”的信号,方便渲染层按需刷新;
//   3) 窗口尺寸:把像素宽高按字符单元大小换算成行列 → 通知 pty 与网格。
//
// ============================ integrator 接线说明 ============================
// 导入(注意路径 winterm/io、包名 iobridge):
//     import iobridge "winterm/io"
//
// 1. 每个叶子 pane 起一个会话并建桥:
//        sess, _ := term.Start(term.Options{Cols: cols, Rows: rows})
//        leaf.Payload = sess                 // 叶子承载会话
//        br := iobridge.New(sess)            // 或 iobridge.NewFromPane(leaf)
//        br.SetCellSize(cellW, cellH)        // 一个字符格的像素宽高(由字体度量得到)
//
// 2. Gio 主循环里,把「焦点叶子」对应的 br 作为输入目标:
//        - 收到 key.Event(按下)→ 翻成 iobridge.KeyEvent → br.SendKey(ev)
//        - 收到 key.EditEvent / 文本 → br.SendText(s)
//        - 窗格尺寸变化(像素)→ br.Resize(pxW, pxH)
//
// 3. 重绘:启动一次 watcher,把它的信号接到 app.Window.Invalidate():
//        redraw, stop := br.WatchRedraw(16 * time.Millisecond)
//        go func(){ for range redraw { w.Invalidate() } }()
//        // 退出时 stop()
//    TODO(push-notify): 现为「快照指纹轮询」以避免改动 term.Session;若日后给
//    Session 增加输出回调,应改成推送式,去掉轮询。
// ===========================================================================

package iobridge

import (
	"errors"
	"hash/fnv"
	"sync"
	"time"

	"winterm/pane"
	"winterm/term"
)

// Bridge 绑定一个终端会话,提供输入/尺寸/重绘三条通路。并发安全:
// SendKey/SendText 直接转发到 term.Session(其内部对 PTY 写加锁),
// Resize 只读本结构里由 SetCellSize 设置的单元尺寸(简单场景足够)。
type Bridge struct {
	sess *term.Session

	// 一个字符单元的像素尺寸,用于 Resize 的像素→行列换算。
	cellW, cellH int
}

// New 用一个已启动的会话创建桥。cellW/cellH 默认 0,需调 SetCellSize 后才能用
// 像素版 Resize(在此之前可直接用 ResizeCells)。
func New(sess *term.Session) *Bridge {
	return &Bridge{sess: sess}
}

// NewFromPane 从叶子 pane 的 Payload 取出 *term.Session 建桥。
// Payload 不是会话时返回错误。
func NewFromPane(p *pane.Pane) (*Bridge, error) {
	sess, ok := SessionOf(p)
	if !ok {
		return nil, errors.New("iobridge: pane 无有效的 *term.Session Payload")
	}
	return New(sess), nil
}

// SessionOf 从叶子 pane 取会话句柄;非叶子或类型不符返回 (nil,false)。
func SessionOf(p *pane.Pane) (*term.Session, bool) {
	if p == nil || !p.IsLeaf() {
		return nil, false
	}
	s, ok := p.Payload.(*term.Session)
	return s, ok
}

// Session 返回底层会话句柄。
func (b *Bridge) Session() *term.Session { return b.sess }

// SetCellSize 记录单个字符格的像素宽高(由字体度量提供),供像素版 Resize 换算。
func (b *Bridge) SetCellSize(cellW, cellH int) {
	if cellW > 0 {
		b.cellW = cellW
	}
	if cellH > 0 {
		b.cellH = cellH
	}
}

// -------------------------------- 输入 --------------------------------

// SendKey 编码一次按键并写入 PTY。返回写入的字节数;若该键不产生 PTY 字节
// (如空事件或 Cmd/Super 快捷键)返回 (0,nil)。
func (b *Bridge) SendKey(ev KeyEvent) (int, error) {
	p := Encode(ev)
	if len(p) == 0 {
		return 0, nil
	}
	return b.sess.Write(p)
}

// SendText 原样写入一段文本(用于粘贴、输入法提交的字符串)。
func (b *Bridge) SendText(s string) (int, error) {
	if s == "" {
		return 0, nil
	}
	return b.sess.WriteString(s)
}

// SendRunes 写入一串字符(逐个按 UTF-8 编码,不含修饰键)。
func (b *Bridge) SendRunes(rs []rune) (int, error) {
	if len(rs) == 0 {
		return 0, nil
	}
	return b.sess.WriteString(string(rs))
}

// SendBytes 直接写入原始字节(高级用途:如整段粘贴的字节流)。
func (b *Bridge) SendBytes(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	return b.sess.Write(p)
}

// -------------------------------- 尺寸 --------------------------------

// ResizeCells 直接按行列通知 pty 与网格(cols/rows 必须为正)。
func (b *Bridge) ResizeCells(cols, rows int) error {
	return b.sess.Resize(cols, rows)
}

// Resize 按像素宽高换算成行列并通知 pty。需先 SetCellSize。
// 换算:cols=⌊pxW/cellW⌋、rows=⌊pxH/cellH⌋,并各自下限取 1。
func (b *Bridge) Resize(pxW, pxH int) error {
	if b.cellW <= 0 || b.cellH <= 0 {
		return errors.New("iobridge: 未设置单元像素尺寸,先调用 SetCellSize")
	}
	cols := pxW / b.cellW
	rows := pxH / b.cellH
	if cols < 1 {
		cols = 1
	}
	if rows < 1 {
		rows = 1
	}
	return b.sess.Resize(cols, rows)
}

// CellsFor 是纯换算辅助:给定像素与单元尺寸,返回行列(不触碰会话)。
// integrator 布局阶段可用它预算尺寸。cellW/cellH<=0 时返回 (0,0)。
func CellsFor(pxW, pxH, cellW, cellH int) (cols, rows int) {
	if cellW <= 0 || cellH <= 0 {
		return 0, 0
	}
	cols = pxW / cellW
	rows = pxH / cellH
	if cols < 1 {
		cols = 1
	}
	if rows < 1 {
		rows = 1
	}
	return cols, rows
}

// -------------------------------- 重绘 --------------------------------

// WatchRedraw 启动一个后台轮询:每隔 interval 取一次网格快照指纹,变化时向返回的
// channel 投递一个(合并的)重绘信号;会话结束(Done)时投递最后一次并退出。
// 返回的 stop() 用于提前停止 watcher(幂等)。
//
// channel 缓冲为 1 且非阻塞投递:即便渲染层来不及消费也不会阻塞,只是把多次
// 变化合并成一次重绘,符合“脏标记 + 每帧最多重绘一次”的常见做法。
func (b *Bridge) WatchRedraw(interval time.Duration) (<-chan struct{}, func()) {
	if interval <= 0 {
		interval = 16 * time.Millisecond
	}
	ch := make(chan struct{}, 1)
	stop := make(chan struct{})
	var once sync.Once
	stopOnce := func() { once.Do(func() { close(stop) }) }

	signal := func() {
		select {
		case ch <- struct{}{}:
		default: // 已有待处理信号,合并即可
		}
	}

	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		var last uint64
		for {
			select {
			case <-stop:
				return
			case <-b.sess.Done():
				signal() // 进程退出后再刷一帧(显示最终输出/退出提示)
				return
			case <-t.C:
				fp := fingerprint(b.sess.Snapshot())
				if fp != last {
					last = fp
					signal()
				}
			}
		}
	}()

	return ch, stopOnce
}

// fingerprint 对快照做一个廉价指纹(FNV-1a),用于探测“内容是否变化”。
// 覆盖每个单元的字形与属性,以及光标位置与网格尺寸。
func fingerprint(s term.Snapshot) uint64 {
	h := fnv.New64a()
	var b [8]byte
	putU := func(v uint64) {
		for i := 0; i < 8; i++ {
			b[i] = byte(v >> (8 * i))
		}
		h.Write(b[:])
	}
	putU(uint64(s.Cols))
	putU(uint64(s.Rows))
	putU(uint64(s.Cursor.Row))
	putU(uint64(s.Cursor.Col))
	for _, c := range s.Cells {
		putU(uint64(uint32(c.Rune)) | uint64(c.Attr)<<32)
	}
	return h.Sum64()
}
