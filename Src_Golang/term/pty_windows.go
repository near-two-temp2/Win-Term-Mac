//go:build windows

// 本文件是 term 包 PTY 的【Windows ConPTY 实现】:用 Windows 伪控制台
// (Pseudo Console)在 Windows 上起一个真实的交互式 shell,并把它的输入/输出
// 桥接成与 Unix 侧(pty_unix.go)完全一致的接口 —— 一个可读可写的 *os.File +
// resizePTY,从而 session.go 无需任何改动即可三平台通用。
//
// ── 为什么需要"桥接" ──────────────────────────────────────────────────────────
// Unix 的 PTY 主端是一个【双工】字符设备:同一个 fd 既能 Read(子进程输出)又能
// Write(键盘输入)。ConPTY 却把两个方向拆成两条【单工匿名管道】:一条我们写、
// 供 ConPTY 读入(输入);一条 ConPTY 写、供我们读出(输出)。而 session.go 只
// 认一个 *os.File 同时读写。为对齐该契约,这里额外建一条【双工命名管道】:一端
// (sessionEnd)作为 startPTY 的返回值交给 session.go 读写,另一端(bridgeEnd)
// 由两个后台 goroutine 与 ConPTY 的两条匿名管道对拷:
//     session 写 sessionEnd → bridgeEnd 读到 → 写入 ConPTY 输入管道
//     ConPTY 输出管道 → 我们读到 → 写入 bridgeEnd → session 从 sessionEnd 读到
//
// ── 生命周期 ────────────────────────────────────────────────────────────────
// session.go 的 Close() 只做两件事:关 sessionEnd + Kill 子进程;它没有给 ConPTY
// 额外资源(伪控制台句柄、匿名管道、属性列表、进程句柄)留清理钩子。因此本文件
// 自管生命周期:一个 waiter goroutine 等子进程退出、bridge 的读 goroutine 感知
// sessionEnd 被关,任一触发即执行一次 teardown(sync.Once):终止子进程 → 关输入端
// → ClosePseudoConsole(触发输出端 EOF)→ 等输出排空 → 关 bridgeEnd(令 session 的
// Read 收到 EOF,readLoop 优雅退出)→ 释放其余句柄。关闭顺序刻意"先解阻塞再关句柄"
// 以避免死锁。
package term

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// 下列常量按 Win32 文档直接给出,避免依赖某个 x/sys 版本是否导出它们。
const (
	_PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016 // ProcThreadAttribute:伪控制台
	_EXTENDED_STARTUPINFO_PRESENT        = 0x00080000 // CreateProcess:使用 STARTUPINFOEX
	_CREATE_UNICODE_ENVIRONMENT          = 0x00000400 // 环境块为 UTF-16
	_PIPE_ACCESS_DUPLEX                  = 0x00000003 // 命名管道:双工
	_PIPE_TYPE_BYTE                      = 0x00000000 // 命名管道:字节流
	_PIPE_WAIT                           = 0x00000000 // 命名管道:阻塞模式
	_FILE_FLAG_OVERLAPPED                = 0x40000000 // 重叠 I/O(让 os.File 走 Go 轮询器,Close 可中断阻塞读)
	_FILE_FLAG_FIRST_PIPE_INSTANCE       = 0x00080000 // 命名管道:必须是首个实例
	_pipeBufSize                         = 64 * 1024  // 桥接命名管道单向缓冲
)

// pipeSeq 为桥接命名管道生成进程内唯一名字,避免并发建会话时重名。
var pipeSeq uint64

// conPTY 保存一个 ConPTY 会话的全部 Windows 资源与桥接状态,并负责一次性清理。
type conPTY struct {
	hpc      windows.Handle // 伪控制台句柄(ClosePseudoConsole 会连带关闭它)
	hProcess windows.Handle // 子进程句柄(CreateProcess 返回,含 TERMINATE/SYNCHRONIZE 权限)

	outR *os.File // ConPTY 输出端(我们读)
	inW  *os.File // ConPTY 输入端(我们写)

	bridge  *os.File // 桥接命名管道:我方一端(后台 goroutine 用)
	session *os.File // 桥接命名管道:交给 session.go 的一端(仅作 resize 映射键;由 session 负责关)

	attrList *windows.ProcThreadAttributeListContainer // PROC_THREAD_ATTRIBUTE 列表(需存活到 CreateProcess 之后)

	doneOut chan struct{} // 输出对拷 goroutine 结束信号(排空后才可关 bridge,避免截断尾部输出)
	once    sync.Once     // 保证 teardown 只执行一次
}

// ptyRegistry 以返回给 session 的 *os.File 为键,映射到其 conPTY,供 resizePTY 查询。
var ptyRegistry sync.Map // map[*os.File]*conPTY

// startPTY 启动 cmd 描述的 shell 于一个新建的伪控制台中,返回一个双工 *os.File:
// 对它 Read 得到子进程输出、对它 Write 送入键盘输入(语义与 Unix 侧一致)。
// 它同时把 cmd.Process 设为该子进程,使 session.go 的 cmd.Wait()/Kill() 正常工作。
func startPTY(cmd *exec.Cmd, cols, rows int) (_ *os.File, retErr error) {
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}

	// ① 建两条匿名管道:输入(我们写 inW,ConPTY 读 inR)与输出(ConPTY 写 outW,我们读 outR)。
	var inR, inW, outR, outW windows.Handle
	if err := windows.CreatePipe(&inR, &inW, nil, 0); err != nil {
		return nil, os.NewSyscallError("CreatePipe(in)", err)
	}
	if err := windows.CreatePipe(&outR, &outW, nil, 0); err != nil {
		windows.CloseHandle(inR)
		windows.CloseHandle(inW)
		return nil, os.NewSyscallError("CreatePipe(out)", err)
	}
	// 失败清理:凡尚未移交/包装的裸句柄在出错路径统一关闭。
	closeIfErr := func(h *windows.Handle) {
		if retErr != nil && *h != 0 {
			windows.CloseHandle(*h)
			*h = 0
		}
	}
	defer closeIfErr(&inW)
	defer closeIfErr(&outR)

	// ② 用 inR/outW 建伪控制台;ConPTY 会复制这两个句柄,创建成功后即可关掉原句柄。
	var hpc windows.Handle
	size := windows.Coord{X: int16(cols), Y: int16(rows)}
	if err := windows.CreatePseudoConsole(size, inR, outW, 0, &hpc); err != nil {
		windows.CloseHandle(inR)
		windows.CloseHandle(outW)
		windows.CloseHandle(inW)
		windows.CloseHandle(outR)
		return nil, os.NewSyscallError("CreatePseudoConsole", err)
	}
	windows.CloseHandle(inR)
	windows.CloseHandle(outW)
	inR, outW = 0, 0
	defer func() {
		if retErr != nil {
			windows.ClosePseudoConsole(hpc)
		}
	}()

	// ③ 组装 STARTUPINFOEX,挂上"伪控制台"进程线程属性。
	attrList, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return nil, os.NewSyscallError("NewProcThreadAttributeList", err)
	}
	defer func() {
		if retErr != nil {
			attrList.Delete()
		}
	}()
	// 伪控制台属性的"值"就是 HPCON 句柄本身(按值传入,size 为句柄大小)。
	if err := attrList.Update(
		_PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
		unsafe.Pointer(hpc), //nolint:govet // hpc 是句柄值非 Go 指针,无 GC 安全问题
		unsafe.Sizeof(hpc),
	); err != nil {
		return nil, os.NewSyscallError("UpdateProcThreadAttribute", err)
	}

	var siEx windows.StartupInfoEx
	siEx.StartupInfo.Cb = uint32(unsafe.Sizeof(siEx))
	siEx.ProcThreadAttributeList = attrList.List()

	// ④ 构造命令行 / 环境块 / 工作目录。
	cmdLine, err := windows.UTF16FromString(makeCmdLine(cmd.Args))
	if err != nil {
		return nil, errors.New("term: 命令行含非法字符: " + err.Error())
	}
	envBlock, err := makeEnvBlock(cmd.Env)
	if err != nil {
		return nil, err
	}
	var dirPtr *uint16
	if cmd.Dir != "" {
		if dirPtr, err = windows.UTF16PtrFromString(cmd.Dir); err != nil {
			return nil, errors.New("term: 工作目录含非法字符: " + err.Error())
		}
	}

	// ⑤ 起子进程。inheritHandles=false:ConPTY 通过属性传递句柄,无需句柄继承。
	var pi windows.ProcessInformation
	err = windows.CreateProcess(
		nil,             // appName:由命令行首个词决定并按 PATH 搜索(powershell.exe / cmd.exe)
		&cmdLine[0],     // commandLine(可写缓冲)
		nil, nil,        // 进程/线程安全属性
		false,           // 不继承句柄
		_EXTENDED_STARTUPINFO_PRESENT|_CREATE_UNICODE_ENVIRONMENT,
		envBlock,        // 环境块
		dirPtr,          // 工作目录
		&siEx.StartupInfo,
		&pi,
	)
	if err != nil {
		return nil, os.NewSyscallError("CreateProcess", err)
	}
	// 线程句柄用不到,立即关闭;进程句柄留给 teardown 用于终止/等待。
	windows.CloseHandle(pi.Thread)

	// ⑥ 建双工命名管道作为交给 session 的"单一 *os.File",并把 ConPTY 两条管道包成 *os.File。
	bridgeEnd, sessionEnd, err := newDuplexPipe()
	if err != nil {
		windows.TerminateProcess(pi.Process, 1)
		windows.CloseHandle(pi.Process)
		return nil, err
	}

	c := &conPTY{
		hpc:      hpc,
		hProcess: pi.Process,
		outR:     os.NewFile(uintptr(outR), "conpty-out"),
		inW:      os.NewFile(uintptr(inW), "conpty-in"),
		bridge:   bridgeEnd,
		session:  sessionEnd,
		attrList: attrList,
		doneOut:  make(chan struct{}),
	}
	// 交给 c 管理后,这些句柄不再由本函数的出错清理接管。
	outR, inW = 0, 0

	// 让 session.go 的 cmd.Wait()/Kill() 有 Process 可用。FindProcess 句柄具备
	// SYNCHRONIZE(Wait 可用);其 Kill 权限视 Go 版本而定,真正的终止由 teardown 兜底。
	if p, e := os.FindProcess(int(pi.ProcessId)); e == nil {
		cmd.Process = p
	}

	ptyRegistry.Store(sessionEnd, c)

	// ⑦ 启动桥接与生命周期 goroutine。
	// A:session→ConPTY 输入。sessionEnd 被关时 bridge 读失败返回,顺带触发 teardown(覆盖 Close 路径)。
	go func() {
		_, _ = io.Copy(c.inW, c.bridge)
		c.teardown()
	}()
	// B:ConPTY 输出→session。ClosePseudoConsole 后 outR 收到 EOF 结束,排空后放行关 bridge。
	go func() {
		_, _ = io.Copy(c.bridge, c.outR)
		close(c.doneOut)
	}()
	// waiter:子进程退出(自然退出或被 Kill)即触发 teardown(覆盖子进程主动退出路径)。
	go func() {
		_, _ = windows.WaitForSingleObject(c.hProcess, windows.INFINITE)
		c.teardown()
	}()

	return sessionEnd, nil
}

// resizePTY 通过返回给 session 的 *os.File 找到其伪控制台并调整行列尺寸。
func resizePTY(f *os.File, cols, rows int) error {
	v, ok := ptyRegistry.Load(f)
	if !ok {
		return errors.New("term: resize 目标不是有效的 ConPTY 会话(可能已关闭)")
	}
	c := v.(*conPTY)
	return windows.ResizePseudoConsole(c.hpc, windows.Coord{X: int16(cols), Y: int16(rows)})
}

// teardown 一次性回收整个 ConPTY 会话。刻意的顺序:先终止子进程并关输入端解阻塞,
// 再 ClosePseudoConsole 让输出端 EOF,等输出排空后关 bridge(令 session 的 Read 得到
// EOF、readLoop 退出),最后释放剩余句柄。多次调用安全(sync.Once)。
func (c *conPTY) teardown() {
	c.once.Do(func() {
		ptyRegistry.Delete(c.session)

		// 确保子进程终止(覆盖 Close 路径;子进程已退出则为无害的 no-op)。
		windows.TerminateProcess(c.hProcess, 1)

		// 关输入端:停止向 ConPTY 送入,并解开桥接读 goroutine 可能的阻塞。
		_ = c.inW.Close()

		// 关伪控制台:触发 conhost 冲刷并关闭输出端 → outR 收到 EOF。
		windows.ClosePseudoConsole(c.hpc)

		// 等输出对拷排空,避免截断子进程最后的输出;加超时兜底,绝不永久阻塞。
		select {
		case <-c.doneOut:
		case <-time.After(5 * time.Second):
		}

		_ = c.outR.Close()
		_ = c.bridge.Close() // 令 session 端 Read 收到 EOF,readLoop 优雅退出

		c.attrList.Delete()
		windows.CloseHandle(c.hProcess)
		// 注意:c.session 由 session.go 的 Close() 负责关闭,这里不重复关。
	})
}

// newDuplexPipe 建一条【双工】命名管道并返回其两端(均为可读可写的 *os.File)。
// 用 FILE_FLAG_OVERLAPPED 让 os.File 走 Go 运行时轮询器,从而在一端被阻塞读时另一处
// Close 能干净地中断它(Unix 匿名管道天然双工,Windows 需借命名管道实现同等语义)。
func newDuplexPipe() (bridge, session *os.File, err error) {
	name := `\\.\pipe\winterm-conpty-` +
		itoa(int(windows.GetCurrentProcessId())) + `-` +
		itoa(int(atomic.AddUint64(&pipeSeq, 1)))
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, nil, err
	}

	server, err := windows.CreateNamedPipe(
		namePtr,
		_PIPE_ACCESS_DUPLEX|_FILE_FLAG_OVERLAPPED|_FILE_FLAG_FIRST_PIPE_INSTANCE,
		_PIPE_TYPE_BYTE|_PIPE_WAIT,
		1, // 单实例
		_pipeBufSize, _pipeBufSize,
		0,   // 默认超时
		nil, // 默认安全属性(不可继承)
	)
	if err != nil {
		return nil, nil, os.NewSyscallError("CreateNamedPipe", err)
	}

	client, err := windows.CreateFile(
		namePtr,
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		0,   // 不共享
		nil, // 不可继承
		windows.OPEN_EXISTING,
		_FILE_FLAG_OVERLAPPED,
		0,
	)
	if err != nil {
		windows.CloseHandle(server)
		return nil, nil, os.NewSyscallError("CreateFile(pipe)", err)
	}

	// 客户端已通过 CreateFile 连接;server 端可直接使用(必要时 ConnectNamedPipe 返回
	// ERROR_PIPE_CONNECTED,视为已连接)。
	bridge = os.NewFile(uintptr(server), name+`\bridge`)
	session = os.NewFile(uintptr(client), name+`\session`)
	return bridge, session, nil
}

// makeCmdLine 按 Windows CommandLineToArgvW 的引用规则把 argv 拼成单条命令行。
func makeCmdLine(args []string) string {
	var b strings.Builder
	for i, a := range args {
		if i > 0 {
			b.WriteByte(' ')
		}
		argvQuote(a, &b)
	}
	return b.String()
}

// argvQuote 按 "Everyone quotes command line arguments the wrong way" 的算法为单个
// 参数加引号/转义,保证 CommandLineToArgvW 能还原出原始参数。
func argvQuote(arg string, b *strings.Builder) {
	if arg != "" && !strings.ContainsAny(arg, " \t\n\v\"") {
		b.WriteString(arg)
		return
	}
	b.WriteByte('"')
	for i := 0; i < len(arg); i++ {
		nBackslash := 0
		for i < len(arg) && arg[i] == '\\' {
			i++
			nBackslash++
		}
		switch {
		case i == len(arg):
			// 结尾的反斜杠需成对加倍,以免转义收尾引号。
			for j := 0; j < nBackslash*2; j++ {
				b.WriteByte('\\')
			}
			b.WriteByte('"')
			return
		case arg[i] == '"':
			// 引号前的反斜杠加倍,再补一个转义引号本身。
			for j := 0; j < nBackslash*2+1; j++ {
				b.WriteByte('\\')
			}
			b.WriteByte('"')
		default:
			for j := 0; j < nBackslash; j++ {
				b.WriteByte('\\')
			}
			b.WriteByte(arg[i])
		}
	}
}

// makeEnvBlock 把 []string 环境变量转成 CreateProcess 需要的 UTF-16 双 NUL 结尾环境块。
func makeEnvBlock(env []string) (*uint16, error) {
	var block []uint16
	for _, e := range env {
		// 跳过含内嵌 NUL 的非法项;每项以 UTF16FromString 的尾随 NUL 作分隔。
		u, err := windows.UTF16FromString(e)
		if err != nil {
			continue
		}
		block = append(block, u...)
	}
	// 追加终止 NUL;空环境块表示为两个 NUL。
	if len(block) == 0 {
		block = []uint16{0, 0}
	} else {
		block = append(block, 0)
	}
	return &block[0], nil
}

// itoa 是一个不引入 strconv 的极小整数转十进制实现(仅用于管道命名)。
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
