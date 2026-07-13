// CoreBridge.swift —— Swift ↔ Rust 共享内核(C ABI)绑定层(桩)
//
// 这一层是 macOS 端与内核之间的唯一通道。内核以 C ABI 暴露:
//   wtm_tree_new / wtm_tree_free / wtm_tree_split / wtm_tree_swap / wtm_tree_navigate
// (见 core/src/lib.rs 与 cbindgen 产出的 wintermac_core.h)。
//
// 现状:CWinTermCore 这个 systemLibrary target 尚未接入(见 Package.swift 的 TODO),
// 所以此处只定义 Swift 侧的门面 API,内部先用 SplitTree 的本地镜像顶着,并在每个
// 方法上用 TODO 标出将来该调用的 C 函数。等头文件与静态库就位后,把本地实现替换成
// 真正的 FFI 调用即可,门面签名保持不变,UI 层无需改动。

import Foundation

/// 内核操作结果,镜像内核 `WtmStatus`。
public enum CoreStatus: Int32, Error {
    case ok = 0
    case nullHandle = -1
    case invalidPane = -2
    case invalidArg = -3
}

/// 窗格树的 Swift 门面。持有内核句柄(接通后为 `OpaquePointer`),对外暴露安全 API。
public final class CoreTree {
    // TODO(Bridge): 接通后改为 `private var handle: OpaquePointer?`,由 wtm_tree_new 返回。
    private var handle: OpaquePointer?

    /// 本地快照:接通前作为唯一数据源;接通后仅作为“据内核结果重建”的缓存镜像。
    public private(set) var snapshot: SplitTree

    /// 分配下一个叶子 id 的计数器。真实实现中 id 分配策略需与内核/宿主约定一致。
    private var nextPaneId: PaneId

    /// 创建一棵新树,初始为单个根叶子。
    public init(rootPane: PaneId = 0) {
        self.snapshot = .leaf(rootPane)
        self.nextPaneId = rootPane + 1
        // TODO(Bridge): self.handle = wtm_tree_new(rootPane)
        //   失败(返回 null)时应抛错或返回可失败初始化器。
        self.handle = nil
    }

    deinit {
        // TODO(Bridge): wtm_tree_free(handle)
        handle = nil
    }

    /// 分配一个新的叶子 id(供 split 使用)。
    public func allocatePaneId() -> PaneId {
        defer { nextPaneId += 1 }
        return nextPaneId
    }

    /// 分裂:把 `target` 叶子换成分裂节点,新叶子落在 `dir` 一侧。
    /// - Returns: 新叶子的 id。
    @discardableResult
    public func split(target: PaneId, direction dir: SplitDirection, ratio: Double = 0.5) throws -> PaneId {
        let newPane = allocatePaneId()
        // TODO(Bridge): let status = wtm_tree_split(handle, target, newPane, WtmDirection(dir), Float(ratio))
        //   将 status 映射为 CoreStatus;非 .ok 时 throw。
        guard let updated = snapshot.splittingLeaf(target, into: newPane, direction: dir, ratio: ratio) else {
            throw CoreStatus.invalidPane
        }
        snapshot = updated
        return newPane
    }

    /// 交换两个叶子(WT 的 swapPane,仅命令面板触发)。
    public func swap(_ a: PaneId, _ b: PaneId) throws {
        // TODO(Bridge): let status = wtm_tree_swap(handle, a, b); 映射并 throw。
        guard let updated = snapshot.swappingLeaves(a, b) else {
            throw CoreStatus.invalidPane
        }
        snapshot = updated
    }

    /// 导航:从 `from` 出发按 `dir` 找几何相邻叶子。找不到返回 nil。
    public func navigate(from: PaneId, direction dir: SplitDirection) -> PaneId? {
        // TODO(Bridge): 用 out 参数调用 wtm_tree_navigate:
        //   var out: WtmPaneId = 0
        //   let status = wtm_tree_navigate(handle, from, WtmDirection(dir), &out)
        //   return status == .ok ? out : nil
        //
        // 几何相邻的判定逻辑归内核所有,本地镜像暂不实现方向导航,统一返回 nil。
        return nil
    }
}
