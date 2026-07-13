//! 构建脚本:编译时用 cbindgen 生成 C 头文件 include/wintermac_core.h,
//! 供 macOS(Swift 桥接头)与 Linux(GTK4)宿主引入。

use std::env;
use std::path::PathBuf;

fn main() {
    let crate_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR 未设置");
    let out = PathBuf::from(&crate_dir).join("include").join("wintermac_core.h");

    // 读取同目录下的 cbindgen.toml;失败时不阻断编译,仅告警。
    match cbindgen::generate(&crate_dir) {
        Ok(bindings) => {
            bindings.write_to_file(&out);
        }
        Err(e) => {
            println!("cargo:warning=cbindgen 头文件生成失败: {e}");
        }
    }

    println!("cargo:rerun-if-changed=src/lib.rs");
    println!("cargo:rerun-if-changed=cbindgen.toml");
}
