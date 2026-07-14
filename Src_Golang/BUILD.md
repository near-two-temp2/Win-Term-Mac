# 构建说明(Golang 方案)

本方案是纯 Go 的 Gio GUI 终端。以下两点是跨平台构建 / 运行时必须知道的。

## Windows:必须关掉控制台子系统(否则会多弹一个窗口)

Go 在 Windows 默认使用 console 子系统,GUI 程序启动时会额外弹出一个黑色控制台
窗口,表现为「一个 Gio 窗口 + 一个控制台」两个窗口。本程序不读写控制台(见
`main.go` 顶部说明),因此构建 Windows 产物时必须给链接器加 `-H=windowsgui`:

```sh
go build -ldflags "-H=windowsgui" -o winterm.exe ./...
```

- macOS / Linux 无此问题,正常 `go build` 即可。
- CI 里由 `build.yml` 的 Windows `go build` 步骤统一注入该 `-ldflags`。

## Windows:目前没有真实 PTY(键盘录入不了的根因)

PTY 后端依赖 `github.com/creack/pty`,而该库 **v1.1.21 在 Windows 上不支持**:
其 `StartWithSize` 直接返回 `ErrUnsupported`。因此 `term/pty_windows.go` 用一个
桩(`startPTY` 返回 `errNoPTY`),`term.Start` 会失败,`app.go` 的 `newLeaf`
返回 `nil`,根窗格退化为一个「无 View 的占位叶子」——没有终端会话,也就没有任何
键盘输入目标,现象即「窗口能开、但敲不进字」。

要在 Windows 上真正能敲命令,需要接 **ConPTY**(`golang.org/x/sys/windows` 的
`CreatePseudoConsole` + 命名管道,自建满足 `*os.File` 读写语义的主端),替换
`pty_windows.go` 的桩即可,`session.go` 无需改动。这是独立的后续工作。

> macOS / Linux 上 `creack/pty` 正常,键盘输入链路(`term.View.processInput`
> → `keyToBytes` → `Session.Write` → PTY)已验证接通。
