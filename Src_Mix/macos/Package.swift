// swift-tools-version:5.9
// macOS 原生前端(Swift + AppKit)的 SwiftPM 清单。
//
// 说明:
// - 本 package 只搭骨架,渲染(Metal + CoreText)与真实终端仿真尚未接入。
// - 窗格树的“真相”在 Rust 共享内核里,经 C ABI(见 core/cbindgen 产出的
//   wintermac_core.h)暴露。macOS 端后续将新增一个 `CWinTermCore` systemLibrary
//   target 来引入该头文件并链接 libwintermac_core,再由 Bridge 层做 Swift 绑定。
//   当前阶段用 SplitTree.swift 里的纯 Swift 值类型镜像内核语义,便于先把 UI 跑起来。

import PackageDescription

let package = Package(
    name: "Sub",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "Sub", targets: ["Sub"])
    ],
    targets: [
        // TODO(Bridge): 接入内核时新增以下 systemLibrary target 并让 Sub 依赖它:
        //
        //   .systemLibrary(name: "CWinTermCore", path: "Sources/CWinTermCore")
        //
        // 其 module.modulemap 指向 core/ 生成的 wintermac_core.h,
        // linkerSettings 里 -L 到 target/release、-l wintermac_core。
        .executableTarget(
            name: "Sub",
            path: "Sources/Sub",
            // TODO(Bridge/term): TerminalPaneView.swift 依赖外部包 SwiftTerm(见其文件头)。
            //   在把 SwiftTerm 加入本 package 的 dependencies 并让本 target 依赖它之前,
            //   先把该文件排除在编译之外,使当前占位骨架(AppDelegate + 占位面板)可独立
            //   `swift build`。接入 SwiftTerm 后删掉此 exclude,并在 AppDelegate 里用
            //   TerminalPaneView 替换 makePlaceholderPane。
            exclude: ["TerminalPaneView.swift"]
        )
    ]
)
