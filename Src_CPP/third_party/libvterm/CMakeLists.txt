# libvterm · vendored 静态库构建
# ----------------------------------------------------------------------------
# 背景:vcpkg 无 libvterm port、Windows 也没有系统包,故把上游源码(neovim
# 镜像的 v0.3.3,纯 C99)vendoring 进来,由本 CMake 直接编成静态库 `vterm`,
# 三平台(含 MSVC)统一构建,不再依赖 pkg-config / find_library。
#
# 关键点:上游用 perl(tbl2inc_c.pl / find-wide-chars.pl)在构建期把
# encoding/*.tbl 与 Unicode 宽字符表生成 *.inc。为避免构建期依赖 perl,
# 这些 *.inc 已在 vendoring 时预生成并一并入库(见 src/*.inc、
# src/encoding/*.inc)。生成脚本原样保留仅作 provenance,不参与构建。
cmake_minimum_required(VERSION 3.21)

project(vterm
    VERSION 0.3.3
    DESCRIPTION "libvterm (vendored) - abstract VT220/xterm/ECMA-48 emulation"
    LANGUAGES C)

# 上游要求 C99(见其 Makefile: -std=c99)。
set(VTERM_C_STANDARD 99)

# 仅编译库所需的翻译单元;bin/ 工具、测试、doc、perl 生成器均不入库。
set(VTERM_SOURCES
    src/encoding.c
    src/keyboard.c
    src/mouse.c
    src/parser.c
    src/pen.c
    src/screen.c
    src/state.c
    src/unicode.c
    src/vterm.c
)

add_library(vterm STATIC ${VTERM_SOURCES})

# 让 target 名可被 target_link_libraries(... vterm) 与命名空间写法通用。
add_library(vterm::vterm ALIAS vterm)

set_target_properties(vterm PROPERTIES
    C_STANDARD ${VTERM_C_STANDARD}
    C_STANDARD_REQUIRED ON
    C_EXTENSIONS OFF
    POSITION_INDEPENDENT_CODE ON   # 便于将来被 .so/.dylib 或 Qt 插件间接链接
)

# include/ 对外暴露(消费者 #include <vterm.h> / <vterm_keycodes.h>);
# src/ 仅供库内 .c 找 vterm_internal.h 等私有头,不外泄。
target_include_directories(vterm
    PUBLIC  ${CMAKE_CURRENT_SOURCE_DIR}/include
    PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src
)

# MSVC:snprintf/vsnprintf 在 VS2015+ 均为标准实现,这里关掉 CRT 的
# “secure”弃用告警噪音;并显式声明按 UTF-8 读取源码(encoding 表含非 ASCII)。
if(MSVC)
    target_compile_definitions(vterm PRIVATE _CRT_SECURE_NO_WARNINGS)
    target_compile_options(vterm PRIVATE /utf-8)
else()
    # 上游 Makefile 的告警面;非 MSVC 编译器(gcc/clang)沿用。
    target_compile_options(vterm PRIVATE -Wall)
endif()
