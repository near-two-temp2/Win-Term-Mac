// SplitTree.swift —— 用 Swift 值类型(enum)镜像内核的窗格二叉树
//
// 定位:这是内核窗格树在 macOS 端的“影子模型”。真正的树与算法(split/swap/
// navigate/detach/attach)由 Rust 共享内核持有,经 C ABI 暴露(见 core/ 的
// wtm_tree_* 函数)。本文件不是权威数据源,只是:
//   1. 让 AppKit 视图层(NSSplitView 映射)有一个类型安全的 Swift 结构可读;
//   2. 把内核的 WtmDirection / WtmPaneId 等概念用 Swift 惯用法表达;
//   3. 在 Bridge 尚未接通前,提供纯 Swift 的本地操作以便先跑 UI。
//
// 约定:enum 判别值必须与内核 `WtmDirection`(Left=0/Right=1/Up=2/Down=3)一致,
// 否则 FFI 传参会错位。

import Foundation

/// 叶子标识,对应内核 `WtmPaneId`(u64)。宿主用它把内核叶子与本地终端视图对应。
public typealias PaneId = UInt64

/// 分裂 / 导航方向。原始值与内核 `WtmDirection` 严格对齐。
public enum SplitDirection: Int32 {
    case left = 0
    case right = 1
    case up = 2
    case down = 3

    /// 分裂时的几何朝向:left/right 为竖向分割条(左右并排),up/down 为横向。
    public var isHorizontalArrangement: Bool {
        switch self {
        case .left, .right: return true
        case .up, .down: return false
        }
    }
}

/// 窗格二叉树。节点要么是叶子(一个真终端),要么是分裂节点。
///
/// 用 `indirect enum` 表达递归值类型:复制即深拷贝,天然无共享可变状态,
/// 适合做 UI 侧的快照/diff。真正的增删改仍应下发给内核,再据返回结果重建此快照。
public indirect enum SplitTree {
    /// 叶子:一个终端窗格。
    case leaf(PaneId)

    /// 分裂节点:方向 + 比例(first 子节点占比,0.0~1.0)+ 两个子树。
    case split(direction: SplitDirection, ratio: Double, first: SplitTree, second: SplitTree)
}

// MARK: - 只读遍历(walk)

public extension SplitTree {
    /// 深度优先遍历所有叶子 id(WT 的 walk)。
    func leafIds() -> [PaneId] {
        switch self {
        case let .leaf(id):
            return [id]
        case let .split(_, _, first, second):
            return first.leafIds() + second.leafIds()
        }
    }

    /// 树里是否包含某叶子。
    func contains(_ id: PaneId) -> Bool {
        switch self {
        case let .leaf(leafId):
            return leafId == id
        case let .split(_, _, first, second):
            return first.contains(id) || second.contains(id)
        }
    }
}

// MARK: - 本地镜像操作(仅在 Bridge 未接通时占位使用)
//
// 这些方法在 Swift 侧就地重算一份新树,返回值类型的新快照。它们只是为了让 UI
// 在没有内核的情况下也能演示切分/交换的效果;一旦 Bridge 接通,权威操作走内核,
// 本地只做“据内核结果重建快照”,以避免两侧语义漂移。

public extension SplitTree {
    /// 本地镜像:把 `target` 叶子换成一个分裂节点,新叶子落在 `dir` 一侧。
    /// - Returns: 成功返回新树;找不到 target 返回 nil。
    func splittingLeaf(_ target: PaneId, into newPane: PaneId,
                       direction dir: SplitDirection, ratio: Double) -> SplitTree? {
        switch self {
        case let .leaf(id) where id == target:
            let clampedRatio = min(max(ratio, 0.0), 1.0)
            // 新叶子在 left/up 一侧 → 作为 first;在 right/down 一侧 → 作为 second。
            let existing = SplitTree.leaf(id)
            let fresh = SplitTree.leaf(newPane)
            switch dir {
            case .left, .up:
                return .split(direction: dir, ratio: clampedRatio, first: fresh, second: existing)
            case .right, .down:
                return .split(direction: dir, ratio: clampedRatio, first: existing, second: fresh)
            }
        case .leaf:
            return nil
        case let .split(d, r, first, second):
            if let newFirst = first.splittingLeaf(target, into: newPane, direction: dir, ratio: ratio) {
                return .split(direction: d, ratio: r, first: newFirst, second: second)
            }
            if let newSecond = second.splittingLeaf(target, into: newPane, direction: dir, ratio: ratio) {
                return .split(direction: d, ratio: r, first: first, second: newSecond)
            }
            return nil
        }
    }

    /// 本地镜像:交换两个叶子在树中的位置(WT 的 swapPane)。
    /// - Returns: 两个叶子都存在时返回新树,否则返回 nil。
    func swappingLeaves(_ a: PaneId, _ b: PaneId) -> SplitTree? {
        guard a != b, contains(a), contains(b) else { return nil }
        func relabel(_ node: SplitTree) -> SplitTree {
            switch node {
            case let .leaf(id):
                if id == a { return .leaf(b) }
                if id == b { return .leaf(a) }
                return node
            case let .split(d, r, first, second):
                return .split(direction: d, ratio: r, first: relabel(first), second: relabel(second))
            }
        }
        return relabel(self)
    }
}
