// AppDelegate.swift —— AppKit 应用入口与主窗口骨架
//
// 这是 macOS 原生前端的最小可运行外壳:一个 NSWindow,里面放一个 NSSplitView
// 作为窗格容器的占位。真正的终端渲染(Metal + CoreText)与窗格树 → NSSplitView
// 的映射尚未实现,此处只搭出可编译、可显示窗口的骨架。
//
// 数据流(目标形态):
//   用户操作(热键/命令面板) → CoreTree(Swift 门面) → C ABI → Rust 内核
//   → 内核返回新树结构 → 本类据快照重建 NSSplitView 层级。
//
// 键位(见 ReadMe 第 5.3 节,macOS 上 Ctrl→Cmd):
//   命令面板 Cmd+Shift+P;向右拆分 Alt+Shift++;向下拆分 Alt+Shift+-;
//   调整大小 Alt+Shift+方向键;切焦点 Alt+方向键;交换窗格无热键(仅命令面板)。
// 这些将来通过 NSMenu / NSEvent 本地监视器绑定,当前未接。

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?

    /// 窗格树门面。当前用本地镜像顶着,后续接入内核(见 CoreBridge)。
    private let tree = CoreTree(rootPane: 0)

    func applicationDidFinishLaunching(_ notification: Notification) {
        let contentRect = NSRect(x: 0, y: 0, width: 1024, height: 640)
        let window = NSWindow(
            contentRect: contentRect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Win-Term-Mac (Mix / Ghostty 模式)"
        window.center()

        // NSSplitView 占位:未来据 tree.snapshot 递归构建真实的分裂层级。
        let splitView = NSSplitView(frame: contentRect)
        splitView.isVertical = true                 // 竖向分割条 = 左右并排(对应 left/right 分裂)
        splitView.dividerStyle = .thin
        splitView.autoresizingMask = [.width, .height]

        // TODO(Panes): 把下面两个占位面板替换为“遍历 SplitTree 生成的窗格视图”。
        //   每个叶子最终是一个终端视图(Metal 渲染 / 评估 SwiftTerm),
        //   每个 split 节点对应一层 NSSplitView(isVertical 由 direction 决定,
        //   分割条初始位置由 ratio 决定)。
        splitView.addArrangedSubview(makePlaceholderPane(title: "Pane 0 (root leaf)"))
        splitView.addArrangedSubview(makePlaceholderPane(title: "Pane 1 (placeholder)"))

        window.contentView = splitView
        window.makeKeyAndOrderFront(nil)
        self.window = window

        NSApp.activate(ignoringOtherApps: true)

        // 冒烟自检:走一遍本地镜像的 split/swap,确认门面链路通(仅日志,不影响 UI)。
        runModelSmokeCheck()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    // MARK: - 占位视图

    private func makePlaceholderPane(title: String) -> NSView {
        let view = NSView()
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.textBackgroundColor.cgColor

        let label = NSTextField(labelWithString: title)
        label.textColor = .secondaryLabelColor
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
        return view
    }

    // MARK: - 模型自检(临时)

    private func runModelSmokeCheck() {
        do {
            let newLeaf = try tree.split(target: 0, direction: .right, ratio: 0.5)
            try tree.swap(0, newLeaf)
            NSLog("[Sub] model smoke check ok, leaves = \(tree.snapshot.leafIds())")
        } catch {
            NSLog("[Sub] model smoke check failed: \(error)")
        }
    }
}
