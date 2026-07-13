//! wintermac_core —— 共享 Rust 内核的 C ABI 导出层
//!
//! 本文件只负责“边界”:把窗格二叉树的核心操作(create/destroy/split/swap/
//! navigate)以 `extern "C"` 稳定 ABI 暴露给 macOS(Swift)与 Linux(GTK4)宿主。
//! 具体的树结构与算法在 `pane` 模块中实现(由“内核窗格树”角色提供)。
//!
//! 内存约定:
//! - `wtm_tree_new` 返回一个不透明句柄指针(堆分配),宿主持有其所有权。
//! - 宿主用完后必须调用 `wtm_tree_free` 归还,否则泄漏。
//! - 除释放函数外,其余函数不获取句柄所有权,只借用。

mod pane;

use std::os::raw::c_int;
use std::ptr;

use pane::PaneTree;

/// 分裂 / 导航方向。数值与顺序需与宿主侧(Swift enum / C enum)保持一致。
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WtmDirection {
    Left = 0,
    Right = 1,
    Up = 2,
    Down = 3,
}

/// 操作结果码。0 = 成功,负值 = 失败。
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WtmStatus {
    Ok = 0,
    NullHandle = -1,
    InvalidPane = -2,
    InvalidArg = -3,
}

/// 不透明句柄:对宿主而言只是一个指针,内部结构不可见。
pub struct WtmTree {
    inner: PaneTree,
}

/// 叶子(终端窗格)标识。宿主用它把内核里的叶子与自己的终端视图对应起来。
pub type WtmPaneId = u64;

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

/// 创建一棵新的窗格树,初始为单个叶子(根)。
///
/// # 返回
/// 非空句柄指针;失败返回 null。调用方负责最终用 `wtm_tree_free` 释放。
#[no_mangle]
pub extern "C" fn wtm_tree_new(root_pane: WtmPaneId) -> *mut WtmTree {
    let tree = WtmTree {
        inner: PaneTree::new(root_pane),
    };
    Box::into_raw(Box::new(tree))
}

/// 销毁窗格树,释放全部内核侧内存。传入 null 为无操作。
///
/// # Safety
/// `handle` 必须来自 `wtm_tree_new`,且此前未被释放过。释放后不得再使用。
#[no_mangle]
pub unsafe extern "C" fn wtm_tree_free(handle: *mut WtmTree) {
    if handle.is_null() {
        return;
    }
    // 重新装箱以在作用域结束时 Drop。
    drop(Box::from_raw(handle));
}

// ---------------------------------------------------------------------------
// 核心操作
// ---------------------------------------------------------------------------

/// 分裂:把 `target` 叶子替换为一个分裂节点,新叶子 `new_pane` 落在 `dir` 一侧。
/// `ratio` 为分裂比例(0.0~1.0,first 子节点占比)。
///
/// # Safety
/// `handle` 必须是有效的、未释放的句柄。
#[no_mangle]
pub unsafe extern "C" fn wtm_tree_split(
    handle: *mut WtmTree,
    target: WtmPaneId,
    new_pane: WtmPaneId,
    dir: WtmDirection,
    ratio: f32,
) -> WtmStatus {
    let tree = match handle.as_mut() {
        Some(t) => t,
        None => return WtmStatus::NullHandle,
    };
    if !(0.0..=1.0).contains(&ratio) {
        return WtmStatus::InvalidArg;
    }
    // TODO(内核窗格树): 对接 PaneTree::split 的最终签名与错误类型。
    match tree.inner.split(target, new_pane, dir, ratio) {
        Ok(()) => WtmStatus::Ok,
        Err(_) => WtmStatus::InvalidPane,
    }
}

/// 交换:互换两个叶子在树中的位置(WT 的 swapPane)。
///
/// # Safety
/// `handle` 必须是有效的、未释放的句柄。
#[no_mangle]
pub unsafe extern "C" fn wtm_tree_swap(
    handle: *mut WtmTree,
    a: WtmPaneId,
    b: WtmPaneId,
) -> WtmStatus {
    let tree = match handle.as_mut() {
        Some(t) => t,
        None => return WtmStatus::NullHandle,
    };
    // TODO(内核窗格树): 对接 PaneTree::swap 的最终签名。
    match tree.inner.swap(a, b) {
        Ok(()) => WtmStatus::Ok,
        Err(_) => WtmStatus::InvalidPane,
    }
}

/// 导航:从 `from` 叶子出发,按 `dir` 找几何相邻的叶子。
///
/// 找到时把目标叶子 id 写入 `out_pane` 并返回 `Ok`;无相邻叶子返回
/// `InvalidPane`(`out_pane` 不变)。
///
/// # Safety
/// `handle` 必须有效;`out_pane` 必须指向可写的 `WtmPaneId`。
#[no_mangle]
pub unsafe extern "C" fn wtm_tree_navigate(
    handle: *const WtmTree,
    from: WtmPaneId,
    dir: WtmDirection,
    out_pane: *mut WtmPaneId,
) -> WtmStatus {
    let tree = match handle.as_ref() {
        Some(t) => t,
        None => return WtmStatus::NullHandle,
    };
    if out_pane.is_null() {
        return WtmStatus::InvalidArg;
    }
    // TODO(内核窗格树): 对接 PaneTree::navigate 的最终返回类型。
    match tree.inner.navigate(from, dir) {
        Some(target) => {
            ptr::write(out_pane, target);
            WtmStatus::Ok
        }
        None => WtmStatus::InvalidPane,
    }
}
