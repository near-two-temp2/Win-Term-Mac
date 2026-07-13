//go:build !windows

// 本文件是 term 包 PTY 的【类 Unix 实现】:用 creack/pty 在 linux/darwin/*bsd 上
// 起一个带伪终端的子进程,并调整其窗口尺寸。仅本文件 import creack/pty,故其他
// 平台的构建不会引入该依赖。
package term

import (
	"os"
	"os/exec"

	"github.com/creack/pty"
)

// startPTY 启动 cmd 并返回 PTY 主端文件(读子进程输出 / 写键盘输入)。
func startPTY(cmd *exec.Cmd, cols, rows int) (*os.File, error) {
	ws := &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)}
	return pty.StartWithSize(cmd, ws)
}

// resizePTY 同步调整 PTY 的窗口尺寸(行列)。
func resizePTY(f *os.File, cols, rows int) error {
	return pty.Setsize(f, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
}
