//go:build windows

// 本文件是 term 包 PTY 的【Windows 桩实现】:Windows 上不走 creack/pty(其伪终端
// 依赖 Unix 的 forkpty/ioctl),因此这里提供不引入任何 PTY 依赖的桩,保证
// `GOOS=windows go build` 一定能过。startPTY 直接返回错误,上层(app.go 的
// newLeaf)会据此静默回退到占位窗格,窗口仍能打开。
//
// TODO(windows-conpty): 后续应接 Windows 的 ConPTY —— 用 golang.org/x/sys/windows
// 的 CreatePseudoConsole + 命名管道自建一个满足 *os.File 读写语义的主端,替换本桩,
// 即可在 Windows 上获得与 Unix 同等的真实终端体验。保持 startPTY/resizePTY 的签名
// 不变,则 session.go 无需改动。
package term

import (
	"errors"
	"os"
	"os/exec"
)

// errNoPTY 表示当前(Windows)构建未启用 PTY。
var errNoPTY = errors.New("term: 本构建在 Windows 上未启用 PTY(见 pty_windows.go 的 ConPTY TODO)")

// startPTY 在 Windows 桩里始终返回 errNoPTY(参数留空以对齐 Unix 版签名)。
func startPTY(_ *exec.Cmd, _, _ int) (*os.File, error) {
	return nil, errNoPTY
}

// resizePTY 在 Windows 桩里始终返回 errNoPTY。
func resizePTY(_ *os.File, _, _ int) error {
	return errNoPTY
}
