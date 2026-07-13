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

# ---- 源码组织 ----
# 目前仅入口 + 占位窗口;pane/term/pty/render/palette 各子系统由其它角色补齐后
# 追加到这里(见下方 TODO)。
set(SOURCES
    src/main.cpp
)

qt_add_executable(wintermmac
    ${SOURCES}
)

target_include_directories(wintermmac PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_link_libraries(wintermmac PRIVATE
    Qt6::Widgets
)

# TODO(集成): 随子系统落地追加子目录/源文件,例如
#   add_subdirectory(src/pane)     # Pane 二叉树 + 分割/导航/交换
#   add_subdirectory(src/term)     # VT 仿真:libvterm 封装 或 移植 WT 核
#   add_subdirectory(src/pty)      # forkpty(Unix) / ConPTY(Windows)
#   add_subdirectory(src/render)   # GPU 渲染 + 字形图集
#   add_subdirectory(src/palette)  # 命令面板 + 键位注册
# 并把对应 target 链接进来。

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
