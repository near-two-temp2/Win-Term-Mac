// Win-Term-Mac · C++ 方案 · term 角色
// TerminalSession:一个「终端会话」= 一个 shell 子进程 + 一块被解析出来的字符网格。
//
// 职责边界(本类只做这三件事):
//   1. 起 shell:forkpty(Unix)/ ConPTY(Windows)拉起一个交互式 shell,
//      拿到 PTY 主端句柄。
//   2. 解析:把 PTY 读到的字节喂给 libvterm,由它维护「网格 / 光标 / 属性」。
//   3. 暴露只读接口:cols/rows、cellAt(row,col)、光标位置、标题 —— 供 render
//      角色画、供 pane 角色布局。
//
// 明确不做:不画像素(render 角色)、不管窗格树(pane 角色)、不管键位注册
// (palette 角色)。输入侧只提供「把用户按键/文本送进这个会话」的原语。
//
// 一个叶子窗格(pane 二叉树的叶子)= 一个 TerminalSession。

#ifndef WTM_TERM_TERMINALSESSION_H
#define WTM_TERM_TERMINALSESSION_H

#include <QObject>
#include <QString>
#include <QStringList>
#include <QPoint>
#include <QSize>

#include <cstdint>
#include <cstddef>
#include <vector>
#include <atomic>
#include <thread>

// libvterm 的具体类型只在 .cpp 里用到,这里前置声明,保持头文件干净、
// 不把 <vterm.h> 泄漏给包含者(render/pane 角色包含本头不需要 libvterm)。
struct VTerm;
struct VTermScreen;

// Qt 的异步 PTY 读取(Unix)靠 QSocketNotifier;前置声明避免头文件重。
class QSocketNotifier;

namespace wtm {

// ---- 网格里一个字符格子的公开表示 ------------------------------------------
// 说明:这是「渲染友好」的快照结构,已经把 libvterm 内部的 VTermScreenCell
// 归一化过(颜色转成 RGB / 默认标记,属性摊平成 bool)。render 角色直接吃。

// 24-bit 颜色 + 「是否为默认前景/背景色」标记。
// isDefault=true 时 r/g/b 无意义,渲染方应回退到自己的主题默认色(palette 角色)。
struct Color {
    std::uint8_t r = 0;
    std::uint8_t g = 0;
    std::uint8_t b = 0;
    bool isDefault = true;
};

// 摊平后的字符属性(SGR 的子集,覆盖 WT 常用项)。
struct CellAttrs {
    bool bold = false;
    bool underline = false;
    bool italic = false;
    bool blink = false;
    bool reverse = false;   // 反显:渲染时前景/背景对调
    bool strike = false;
};

// 一个格子。宽字符(CJK/emoji)占两格:主格 width=2,其右邻格 width=0 为占位。
struct Cell {
    char32_t codepoint = U' ';  // 该格首个码点(合字/组合字的完整序列见 TODO)
    std::uint8_t width = 1;     // 1=半角, 2=全角主格, 0=全角的右占位格
    CellAttrs attrs;
    Color fg;
    Color bg;
};

// ---- 会话本体 --------------------------------------------------------------
// QObject:借 Qt 事件循环做异步 PTY 读取,并用 signal 通知上层「哪块脏了」,
// 让 render 角色只重绘变化区域(对齐 WT 的 damage 驱动重绘模型)。
class TerminalSession : public QObject {
    Q_OBJECT

public:
    explicit TerminalSession(QObject* parent = nullptr);
    ~TerminalSession() override;

    TerminalSession(const TerminalSession&) = delete;
    TerminalSession& operator=(const TerminalSession&) = delete;

    // ---- 生命周期 ----

    // 起一个 shell 会话。program 为空时按平台挑默认 shell
    // (Unix:$SHELL 或 /bin/sh;Windows:ComSpec 或 powershell,见 .cpp 的 TODO)。
    // cols/rows 为初始网格尺寸。成功返回 true。
    bool start(const QString& program = QString(),
               const QStringList& args = QStringList(),
               int cols = 80, int rows = 24);

    // 主动结束会话(kill 子进程 + 释放 PTY)。析构会自动调用。
    void shutdown();

    // 会话是否仍在运行(shell 未退出、PTY 未关闭)。
    bool isRunning() const { return running_; }

    // ---- 输入侧(把用户操作送进 shell)----
    // 这些最终都经 libvterm 的 output callback 写回 PTY 主端。

    // 送一段已经是「终端可理解」的文本(UTF-8);常规打字走这里。
    void sendText(const QString& text);

    // 送一个特殊键(方向键、Enter、Backspace、功能键……)带修饰键。
    // key 用本命名空间的 SpecialKey 枚举,内部映射到 libvterm 的键码,
    // 由 libvterm 生成正确的转义序列。
    enum class SpecialKey {
        Enter, Tab, Backspace, Escape,
        Up, Down, Left, Right,
        Home, End, PageUp, PageDown, Insert, Delete,
        // TODO(term): F1..F12 / Keypad —— 需要时补进 keyToVTermKey() 映射表。
    };
    enum KeyModifier : std::uint8_t {  // 可按位或
        ModNone  = 0,
        ModShift = 1 << 0,
        ModAlt   = 1 << 1,
        ModCtrl  = 1 << 2,
    };
    void sendKey(SpecialKey key, std::uint8_t mods = ModNone);

    // 兜底:直接把原始字节写进 PTY(粘贴、bracketed-paste 外层等)。
    void writeRaw(const char* bytes, std::size_t len);

    // ---- 尺寸 ----
    // 窗格被拉伸/分裂后由 pane/render 角色调用;会同步 PTY 的 winsize + libvterm。
    void resize(int cols, int rows);

    // ---- 只读网格接口(render 角色主要吃这几个)----
    int cols() const { return cols_; }
    int rows() const { return rows_; }
    QSize gridSize() const { return QSize(cols_, rows_); }

    // 取某格快照。越界返回一个默认空格(不抛异常,方便渲染循环)。
    const Cell& cellAt(int row, int col) const;

    // 光标:位置(row,col)、是否可见、是否处于聚焦(块状/条状由 render 决定)。
    QPoint cursorPos() const { return QPoint(cursorCol_, cursorRow_); } // (x=col, y=row)
    bool cursorVisible() const { return cursorVisible_; }

    // 当前会话标题(OSC 0/2 设置;WT 用它做标签页/窗格标题)。
    QString title() const { return title_; }

    // ---- 内部转发桥(仅供 .cpp 内的 libvterm C 回调调用,勿在业务代码里用)----
    // libvterm 的回调只拿得到 void* user,需要一条公开路径回到私有处理方法;
    // 这层薄封装即该路径。命名带 Fwd 以示「非公开 API」。
    void handleDamageFwd(int startRow, int endRow, int startCol, int endCol);
    void handleMoveCursorFwd(int row, int col, bool visible);
    void handleCursorVisibleFwd(bool visible);
    void handleBellFwd();
    void handleResizeFwd(int cols, int rows);
    void handleSetTitleFwd(const QString& title);
    void handleVTermOutputFwd(const char* bytes, std::size_t len);

signals:
    // 网格某个矩形区域内容变了(含边界,行列均为闭区间)。render 角色据此局部重绘。
    void damaged(int startRow, int endRow, int startCol, int endCol);
    // 光标移动。
    void cursorMoved(int row, int col);
    // 标题变化(OSC)。
    void titleChanged(const QString& title);
    // 响铃(BEL)。上层可视觉闪烁或系统提示。
    void bell();
    // 尺寸变化已应用(libvterm 自身触发的 resize,例如 DECCOLM)。
    void resized(int cols, int rows);
    // 子进程退出。exitCode 为 shell 退出码(拿不到时给 -1)。
    void childExited(int exitCode);

private:
    // ---- libvterm 回调的实例侧处理 ----
    // 真实的 VTermScreenCallbacks 转发函数(签名依赖 <vterm.h> 类型)全部放在
    // .cpp 里作为文件局部函数,从 user 指针拿回本实例后调用下面这几个方法,
    // 这样头文件就不必依赖 libvterm 的具体类型。
    void handleDamage(int startRow, int endRow, int startCol, int endCol);
    void handleMoveCursor(int row, int col, bool visible);
    void handleBell();
    void handleResize(int cols, int rows);
    void handleSetTitle(const QString& title);
    // libvterm 想往 PTY 写(键盘/回应序列)时的落地点。
    void handleVTermOutput(const char* bytes, std::size_t len);

    // 从 libvterm 屏幕把 [r0,r1]x[c0,c1] 刷进本地影子网格 grid_。
    void refreshCells(int startRow, int endRow, int startCol, int endCol);

    // ---- PTY 后端(平台相关,实现见 .cpp 的 #ifdef 分支)----
    bool spawnPty(const QString& program, const QStringList& args,
                  int cols, int rows);
    void closePty();
    void onPtyReadable();          // PTY 有数据可读 → 读出来喂 libvterm
    void feed(const char* data, std::size_t len);  // 喂字节进 vterm_input_write
    void applyPtyWinsize(int cols, int rows);      // 同步 TIOCSWINSZ / ConPTY resize

    // ---- 数据成员 ----
    VTerm* vt_ = nullptr;
    VTermScreen* screen_ = nullptr;

    int cols_ = 0;
    int rows_ = 0;
    std::vector<Cell> grid_;       // 行主序影子网格,size = cols_*rows_
    Cell emptyCell_;               // cellAt 越界时返回的哨兵

    int cursorRow_ = 0;
    int cursorCol_ = 0;
    bool cursorVisible_ = true;

    QString title_;
    bool running_ = false;

    // 平台句柄:用平台无关的整数/指针存,避免头文件拉 <windows.h>。
    // Unix:ptyMasterFd_ 是 master fd,childPid_ 是 shell 的 pid。
    // Windows:hPseudoConsole_/hPtyIn_/hPtyOut_/hChild_ 存 HANDLE / HPCON(as void*)。
    int  ptyMasterFd_ = -1;
    long childPid_ = -1;
    void* hPseudoConsole_ = nullptr;  // HPCON
    void* hPtyIn_ = nullptr;          // 写向 ConPTY 的管道写端
    void* hPtyOut_ = nullptr;         // 从 ConPTY 读的管道读端
    void* hChild_ = nullptr;          // 子进程 HANDLE

    QSocketNotifier* readNotifier_ = nullptr;  // Unix:监听 master fd 可读

    // Windows:ConPTY 无 fd 可交给 QSocketNotifier,改用后台线程阻塞 ReadFile,
    // 读到的字节经 QMetaObject::invokeMethod 回主线程 feed() 进 libvterm。
    // (feed 非线程安全,必须回主线程执行。)Unix 平台下这两个成员不使用。
    std::thread readThread_;
    std::atomic<bool> readThreadStop_{false};
};

} // namespace wtm

#endif // WTM_TERM_TERMINALSESSION_H
