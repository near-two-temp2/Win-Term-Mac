// Command winterm 是 Src_Golang 方案的入口。
// 目标:打开窗口 → 显示一个真终端(跑 shell)→ 能敲命令 → 支持拆分 / Alt+方向切焦点
//       / Ctrl(Cmd)+Shift+P 命令面板。具体装配见 app.go(App)。
package main

import (
	"os"

	"gioui.org/app"
	"gioui.org/op"
	"gioui.org/unit"
)

// Windows 构建须知(修复「多弹一个控制台窗口」缺陷):
// Go 在 Windows 默认走 console 子系统,GUI 程序启动时链接器会为它附带一个黑色
// 控制台窗口,于是屏幕上出现「一个 Gio 窗口 + 一个控制台」两个窗口。本程序是纯
// GUI(Gio)应用:不向 stdout/stderr 打印任何内容、也不从控制台读输入(启动失败
// 只用退出码 os.Exit(1) 体现),因此可以安全地关掉控制台子系统。
//
// 修法:构建 Windows 产物时给链接器加 -H=windowsgui —— 只保留 Gio 窗口:
//
//	go build -ldflags "-H=windowsgui" ./...
//
// 该 flag 由 CI(build.yml 的 go build 步骤)统一注入;本文件仅作说明,代码本身
// 不依赖控制台。详见仓库根的 BUILD.md。
func main() {
	go func() {
		w := new(app.Window)
		w.Option(
			app.Title("Win-Term-Mac (Go)"),
			app.Size(unit.Dp(960), unit.Dp(600)),
		)
		if err := loop(w); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}()
	app.Main()
}

// loop 是 Gio 的事件主循环:每帧把上下文交给 App.Frame 渲染窗格树与浮层。
func loop(w *app.Window) error {
	a := newApp(w)
	defer a.Close()

	var ops op.Ops
	for {
		switch e := w.Event().(type) {
		case app.DestroyEvent:
			return e.Err
		case app.FrameEvent:
			gtx := app.NewContext(&ops, e)
			a.Frame(gtx)
			e.Frame(gtx.Ops)
		}
	}
}
