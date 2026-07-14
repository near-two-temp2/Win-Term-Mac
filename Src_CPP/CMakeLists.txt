# Win-Term-Mac · C++ 方案 顶层构建
# 目标:三平台开出一个空窗口(M0),中央放占位终端 widget。
cmake_minimum_required(VERSION 3.21)

project(WinTermMac
    VERSION 0.1.0
    DESCRIPTION "Windows Terminal 窗格体验复刻 (C++/Qt6 方案)"
    LANGUAGES CXX)

# ---- C++17,mirror WT 的可移植内核所需 ----
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# 未显式指定时给个默认构建类型,方便单人开发
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE "Debug" CACHE STRING "Build type" FORCE)
endif()

# Qt 的 moc / uic / rcc 自动跑
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTOUIC ON)
set(CMAKE_AUTORCC ON)

# ---- Qt6:先找 Widgets(近原生窗口/菜单/事件循环)----
find_package(Qt6 REQUIRED COMPONENTS Widgets)

# ---- libvterm(term 角色的 VT 解析核)----
# 三平台统一改用 vendored 源码:third_party/libvterm 自带上游 v0.3.3(纯 C99)
# 并由其 CMakeLists.txt 编成静态库 target `vterm`(见该目录说明)。原因:
# vcpkg 无 libvterm port、Windows 也没有系统包,靠 pkg-config/find_library
# 会在 Windows 上直接 FATAL。vendoring 后不再依赖系统/vcpkg 的 libvterm,
# Windows 也能一把构建;Unix 亦无需再 apt/brew 装 libvterm-dev。
#
# 允许高级用户强制回退系统库:-DWTM_USE_SYSTEM_VTERM=ON 时改走 pkg-config/
# find_library 老路径(便于发行版打包接系统共享库)。默认 OFF = 用 vendored。
option(WTM_USE_SYSTEM_VTERM "Link the system/vcpkg libvterm instead of the vendored copy" OFF)

if(WTM_USE_SYSTEM_VTERM)
    find_package(PkgConfig QUIET)
    if(PkgConfig_FOUND)
        pkg_check_modules(VTERM QUIET vterm)
    endif()

    if(NOT VTERM_FOUND)
        find_path(VTERM_INCLUDE_DIRS NAMES vterm.h)
        find_library(VTERM_LIBRARIES NAMES vterm)
        if(VTERM_INCLUDE_DIRS AND VTERM_LIBRARIES)
            set(VTERM_FOUND TRUE)
        endif()
    endif()

    if(NOT VTERM_FOUND)
        message(FATAL_ERROR
            "WTM_USE_SYSTEM_VTERM=ON but libvterm not found. Install it "
            "(apt install libvterm-dev / brew install libvterm) or point CMake "
            "at it via VTERM_INCLUDE_DIRS and VTERM_LIBRARIES; or set "
            "WTM_USE_SYSTEM_VTERM=OFF to use the vendored copy.")
    endif()
else()
    # vendored:构建静态库 target `vterm`,include/link 全走它导出的属性。
    add_subdirectory(third_party/libvterm)
    set(VTERM_LIBRARIES vterm)          # 已带 PUBLIC include,无需再设 INCLUDE_DIRS
    set(VTERM_INCLUDE_DIRS "")
endif()

# ---- 源码组织(整合层收口:各角色 .cpp 汇总到一个可执行目标)----
# 各角色仅在自己的新文件里实现,CMake 接线由本整合层统一维护。
set(SOURCES
    src/main.cpp
    src/term/TerminalSession.cpp      # term  : shell 子进程 + libvterm 解析
    src/render/TerminalView.cpp       # render: 逐格渲染 + 键盘转发
    src/pane/Pane.cpp                 # pane  : 窗格二叉树 + 分裂/导航/交换
    src/keymap/Keymap.cpp             # keymap: 键位模型(WT 默认键位)
    src/palette/CommandPalette.cpp    # palette: 命令面板模型(含 swap/move 命令)
    src/io/PaneTerminalBridge.cpp     # io   : 窗格 <-> shell IO 编排桥
    src/cmd/QtKeyTranslator.cpp       # cmd  : QKeyEvent -> KeyChord
    src/cmd/CommandPaletteWidget.cpp  # cmd  : 命令面板浮层 UI
    src/cmd/CommandCoordinator.cpp    # cmd  : 顶层装配(keymap+palette+pane+io)
)

qt_add_executable(wintermmac
    ${SOURCES}
)

target_include_directories(wintermmac PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${VTERM_INCLUDE_DIRS}
)

target_link_libraries(wintermmac PRIVATE
    Qt6::Widgets
    ${VTERM_LIBRARIES}
)

# pkg-config 可能给出编译/链接目录(静态库路径等)。
if(VTERM_LIBRARY_DIRS)
    target_link_directories(wintermmac PRIVATE ${VTERM_LIBRARY_DIRS})
endif()

# ---- 平台差异桩(编译期分流,PTY 后端由 pty/ 角色实现)----
if(WIN32)
    # ConPTY 后端(Windows)
    target_compile_definitions(wintermmac PRIVATE WTM_PLATFORM_WINDOWS)
elseif(APPLE)
    # forkpty 后端(macOS);后续产 universal 二进制在此配置 CMAKE_OSX_ARCHITECTURES
    target_compile_definitions(wintermmac PRIVATE WTM_PLATFORM_MACOS)
else()
    # forkpty 后端(Linux)
    target_compile_definitions(wintermmac PRIVATE WTM_PLATFORM_LINUX)
endif()
