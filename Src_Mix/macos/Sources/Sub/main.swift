// main.swift —— 可执行入口
//
// SwiftPM 可执行 target 用 main.swift 作为入口。这里手动装配 NSApplication 与
// AppDelegate(不走 @main / @NSApplicationMain,便于在纯 SPM 下构建运行)。

import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
