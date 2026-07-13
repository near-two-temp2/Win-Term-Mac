// Command winterm 是 Src_Golang 方案的入口。
// 目标:用 Gio 打开一个窗口,渲染一行占位文字,验证 UI 主循环可跑通。
// 后续窗格树 / VT 核 / pty 会挂到这个主循环里。
package main

import (
	"os"

	"gioui.org/app"
	"gioui.org/font/gofont"
	"gioui.org/layout"
	"gioui.org/op"
	"gioui.org/text"
	"gioui.org/unit"
	"gioui.org/widget/material"
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

// loop 是 Gio 的事件主循环:接收帧事件,布局并绘制占位文字。
func loop(w *app.Window) error {
	th := material.NewTheme()
	th.Shaper = text.NewShaper(text.WithCollection(gofont.Collection()))

	var ops op.Ops
	for {
		switch e := w.Event().(type) {
		case app.DestroyEvent:
			return e.Err
		case app.FrameEvent:
			gtx := app.NewContext(&ops, e)

			// TODO(pane-tree): 此处将来替换为窗格树的渲染(叶子=终端,分裂节点=递归布局)。
			// 现在仅居中显示一行占位文字,证明主循环与 GPU 渲染可用。
			layout.Center.Layout(gtx, func(gtx layout.Context) layout.Dimensions {
				lbl := material.H4(th, "Win-Term-Mac · Go/Gio 脚手架就绪")
				lbl.Alignment = text.Middle
				return lbl.Layout(gtx)
			})

			e.Frame(gtx.Ops)
		}
	}
}
