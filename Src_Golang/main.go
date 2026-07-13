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
