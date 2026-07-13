// TerminalPaneView.swift —— macOS(AppKit + SwiftTerm)真实终端视图
//
// 定位:这是「term」角色在 macOS 端的产物。一个叶子窗格 = 一个 TerminalPaneView,
// 内部包一个 SwiftTerm 的 `LocalProcessTerminalView`。后者是一个 NSView 子类,自带
// pty + 本地子进程管理:调用 startProcess 后它 spawn 用户 shell,把子进程输出实时
// 渲染出来,并把键盘输入写回 pty ——「显示 shell 输出」「敲命令」由 SwiftTerm 原生
// 完成,无需我们自绘 Metal/CoreText。
//
// 与内核的关系:窗格二叉树的真相在 wintermac_core(C ABI)里,macOS 端经 CoreTree
// 门面驱动(见 CoreBridge.swift)。每个内核叶子 PaneId 对应一个 TerminalPaneView;
// AppDelegate 维护 id -> view 映射,并在内核返回新树后据此重建 NSSplitView 层级。
// 本视图不碰树,只负责“一个格子里的终端”。
//
// ---------------------------------------------------------------------------
// integrator(AppDelegate / 集成 agent)需要如何调用我:
//
// 1) 依赖:在 macos/Package.swift 里加 SwiftTerm 包并让 Sub target 依赖它:
//        dependencies: [
//            .package(url: "https://github.com/migueldeicaza/SwiftTerm", from: "1.2.0")
//        ],
//        // Sub target 的 dependencies: [.product(name: "SwiftTerm", package: "SwiftTerm")]
//    (若不接依赖,本文件不会被编译进产物,不影响现有骨架。)
//
// 2) 在 AppDelegate 里用它替换 makePlaceholderPane。最简改法(两格占位):
//        let p0 = TerminalPaneView(paneId: 0)   // 根叶子
//        let p1 = TerminalPaneView(paneId: 1)
//        splitView.addArrangedSubview(p0)       // TerminalPaneView 本身就是 NSView
//        splitView.addArrangedSubview(p1)
//    并把 p0/p1 存进 [PaneId: TerminalPaneView],避免被释放且便于后续增删/重排。
//
// 3) 遍历内核树建 UI 时:对每个叶子 id 建 TerminalPaneView(paneId:);对每个 split
//    节点建一层 NSSplitView(isVertical 由 SplitDirection 决定,分隔条初始位置由
//    ratio 决定)。
// ---------------------------------------------------------------------------
//
// 说明:本文件 `import SwiftTerm`。在 SwiftTerm 依赖接入前,该 import 无法解析,
// 因此本 target 需先加依赖(见上)。这是刻意为之——「真实终端」必须有真实后端。

import AppKit
import SwiftTerm

/// 一个终端窗格:承载 SwiftTerm 的本地进程终端,绑定到内核的一个叶子 id。
///
/// 直接继承 NSView,内部把 LocalProcessTerminalView 铺满自身,方便塞进 NSSplitView。
final class TerminalPaneView: NSView, LocalProcessTerminalViewDelegate {
    /// 关联的内核叶子 id(宿主用它把本视图与内核树对应)。
    let paneId: PaneId

    /// SwiftTerm 的本地进程终端视图(自带 pty + 子进程)。
    private let terminalView: LocalProcessTerminalView

    /// 子进程退出时的回调,交给宿主(通常触发对内核的 detach + 重排)。
    /// - 参数:退出的 paneId、退出码(可能为 nil)。
    var onProcessTerminated: ((PaneId, Int32?) -> Void)?

    /// 新建终端窗格并立刻 spawn 用户 shell。
    init(paneId: PaneId) {
        self.paneId = paneId
        self.terminalView = LocalProcessTerminalView(frame: .zero)
        super.init(frame: .zero)

        terminalView.processDelegate = self
        terminalView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(terminalView)
        NSLayoutConstraint.activate([
            terminalView.leadingAnchor.constraint(equalTo: leadingAnchor),
            terminalView.trailingAnchor.constraint(equalTo: trailingAnchor),
            terminalView.topAnchor.constraint(equalTo: topAnchor),
            terminalView.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])

        spawnShell()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("TerminalPaneView 仅支持代码构造")
    }

    /// 底层 SwiftTerm 视图(供高级操作:选择、缩放、主题等)。
    var terminal: LocalProcessTerminalView { terminalView }

    /// 程序化地把文本写入子进程 stdin(相当于替用户敲键)。
    func feedChild(_ text: String) {
        terminalView.send(txt: text)
    }

    /// spawn 用户默认 shell 作为终端子进程。
    private func spawnShell() {
        let shell = Self.userShell()
        // 以登录 shell 交互模式启动。SwiftTerm 会在需要时补默认 TERM 等环境变量。
        let env = Terminal.getEnvironmentVariables(termName: "xterm-256color")
        terminalView.startProcess(
            executable: shell,
            args: [],
            environment: env,
            execName: nil
        )
    }

    /// 取用户默认 shell:优先 $SHELL,回退 /bin/zsh(现代 macOS 默认),再回退 /bin/bash。
    private static func userShell() -> String {
        if let sh = ProcessInfo.processInfo.environment["SHELL"], !sh.isEmpty {
            return sh
        }
        for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
            if FileManager.default.fileExists(atPath: candidate) {
                return candidate
            }
        }
        return "/bin/sh"
    }

    // MARK: - LocalProcessTerminalViewDelegate

    /// 子进程尺寸变化(SwiftTerm 已同步 pty 大小,这里无需额外处理)。
    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}

    /// 终端标题变化。TODO(集成): 可上抛给宿主更新 Tab / 标题栏。
    func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}

    /// 工作目录变化(OSC 7)。TODO(集成): 可用于新窗格继承 cwd。
    func hostCurrentDirectoryUpdate(source: LocalProcessTerminalView, directory: String?) {}

    /// 子进程退出:通知宿主(通常据此对内核发起 detach 并重排控件)。
    func processTerminated(source: TerminalView, exitCode: Int32?) {
        onProcessTerminated?(paneId, exitCode)
    }
}
