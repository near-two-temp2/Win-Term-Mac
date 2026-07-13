// 本文件是 term 包的会话(Session)部分:用 creack/pty 起一个 shell 子进程,
// 后台 goroutine 持续读 PTY 输出并喂给 VT 解析器维护网格,同时向上层暴露:
//   - Snapshot():取网格只读快照供渲染
//   - Write():把键盘输入写回 PTY
//   - Resize():同步 PTY 与网格尺寸
//   - Close()/Wait()/Done():生命周期管理
//
// 并发模型对齐 README:每个终端会话一条读循环 goroutine + channel,读写解耦。
package term

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime"
	"sync"

	"github.com/creack/pty"
)

// Options 描述一个会话的启动参数。零值即用平台默认 shell、80x24。
type Options struct {
	Shell string   // 可执行文件路径;为空则按平台推断
	Args  []string // 传给 shell 的参数
	Env   []string // 环境变量;为空则继承当前进程 os.Environ()
	Cols  int      // 初始列数;<=0 用 80
	Rows  int      // 初始行数;<=0 用 24
	Dir   string   // 工作目录;为空则继承当前
}

// Session 是一个活着的终端会话:pty + 子进程 + 网格。
type Session struct {
	opts Options

	cmd  *exec.Cmd
	ptmx *os.File // PTY 主端;读子进程输出 / 写键盘输入
	grid *Grid

	closeOnce sync.Once
	done      chan struct{} // 读循环退出后关闭
	waitErr   error         // 子进程退出错误,done 关闭后可读
}

// Grid 暴露底层网格(用于测试或高级消费者);常规渲染请用 Snapshot()。
func (s *Session) Grid() *Grid { return s.grid }

// Snapshot 返回当前网格快照,供渲染层每帧消费。
func (s *Session) Snapshot() Snapshot { return s.grid.Snapshot() }

// Done 返回一个在读循环结束(通常因子进程退出或 Close)后被关闭的 channel。
func (s *Session) Done() <-chan struct{} { return s.done }

// Start 按 opts 启动一个 shell 会话并开始读循环。
func Start(opts Options) (*Session, error) {
	if opts.Cols <= 0 {
		opts.Cols = 80
	}
	if opts.Rows <= 0 {
		opts.Rows = 24
	}
	if opts.Shell == "" {
		opts.Shell = defaultShell()
	}

	cmd := exec.Command(opts.Shell, opts.Args...)
	if len(opts.Env) > 0 {
		cmd.Env = opts.Env
	} else {
		cmd.Env = os.Environ()
	}
	if opts.Dir != "" {
		cmd.Dir = opts.Dir
	}

	ws := &pty.Winsize{Rows: uint16(opts.Rows), Cols: uint16(opts.Cols)}
	ptmx, err := pty.StartWithSize(cmd, ws)
	if err != nil {
		return nil, err
	}

	s := &Session{
		opts: opts,
		cmd:  cmd,
		ptmx: ptmx,
		grid: NewGrid(opts.Cols, opts.Rows),
		done: make(chan struct{}),
	}

	go s.readLoop()
	return s, nil
}

// readLoop 持续从 PTY 主端读输出并喂给网格,直到 EOF / 出错 / 被关闭。
func (s *Session) readLoop() {
	defer close(s.done)
	buf := make([]byte, 32*1024)
	for {
		n, err := s.ptmx.Read(buf)
		if n > 0 {
			s.grid.Feed(buf[:n])
		}
		if err != nil {
			// PTY 关闭时通常返回 EOF 或已关闭的文件错误,均视为正常终止。
			if !errors.Is(err, io.EOF) && !errors.Is(err, os.ErrClosed) {
				// TODO(diagnostics): 非预期读错误可上报到日志/状态栏。
				_ = err
			}
			break
		}
	}
	// 读循环结束后回收子进程,记录退出状态供 Wait() 读取。
	s.waitErr = s.cmd.Wait()
}

// Write 把键盘输入原样写入 PTY(交给子进程/行规程处理回显与信号)。
func (s *Session) Write(p []byte) (int, error) {
	if s.ptmx == nil {
		return 0, os.ErrClosed
	}
	return s.ptmx.Write(p)
}

// WriteString 是 Write 的字符串便捷封装。
func (s *Session) WriteString(str string) (int, error) {
	return s.Write([]byte(str))
}

// Resize 同步调整 PTY 窗口与内部网格尺寸(如分隔条拖动改变了窗格大小)。
func (s *Session) Resize(cols, rows int) error {
	if cols <= 0 || rows <= 0 {
		return errors.New("term: resize 尺寸必须为正")
	}
	if s.ptmx == nil {
		return os.ErrClosed
	}
	ws := &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)}
	if err := pty.Setsize(s.ptmx, ws); err != nil {
		return err
	}
	s.grid.Resize(cols, rows)
	return nil
}

// Wait 阻塞直到子进程退出并返回其退出错误。内部会等待读循环收尾。
func (s *Session) Wait() error {
	<-s.done
	return s.waitErr
}

// Close 主动关闭会话:关 PTY 主端会让读循环收到 EOF 从而优雅退出。
// 幂等,可多次调用。
func (s *Session) Close() error {
	var err error
	s.closeOnce.Do(func() {
		if s.ptmx != nil {
			err = s.ptmx.Close()
		}
		// 若子进程仍在,尝试终止以免残留(读循环里的 Wait 负责回收)。
		if s.cmd != nil && s.cmd.Process != nil {
			_ = s.cmd.Process.Kill()
		}
	})
	return err
}

// defaultShell 按平台推断默认交互式 shell。
func defaultShell() string {
	if runtime.GOOS == "windows" {
		// TODO(windows-conpty): creack/pty 在 Windows 走 ConPTY,需单独验证;
		// 这里先给 powershell,失败由 Start 的错误暴露给上层回退。
		if ps := os.Getenv("COMSPEC"); ps != "" {
			return ps
		}
		return "powershell.exe"
	}
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh
	}
	return "/bin/sh"
}
