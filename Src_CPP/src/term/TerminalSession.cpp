// Win-Term-Mac · C++ 方案 · term 角色
// TerminalSession 实现:libvterm 解析 + 平台 PTY 后端(forkpty / ConPTY)。
//
// 结构:
//   [A] libvterm 装配 + 回调转发
//   [B] 只读网格 / 输入原语
//   [C] PTY 后端(#ifdef 平台分支)
//
// 依赖:libvterm(<vterm.h>)。CMake 集成见文件末尾 TODO。

#include "term/TerminalSession.h"

#include <vterm.h>

#include <QSocketNotifier>
#include <QDebug>
#include <QByteArray>
#include <QMetaObject>

#include <cstring>
#include <cstdlib>
#include <cerrno>
#include <array>
#include <vector>
#include <string>

// 平台头:PTY 后端各自需要的系统 API。
#if defined(WTM_PLATFORM_WINDOWS) || defined(_WIN32)
#  define WTM_PTY_WINDOWS 1
#  include <windows.h>
#else
#  define WTM_PTY_UNIX 1
#  include <unistd.h>
#  include <fcntl.h>
#  include <signal.h>
#  include <sys/ioctl.h>
#  include <sys/wait.h>
#  include <termios.h>
// forkpty 在 Linux 是 <pty.h>,在 macOS/BSD 是 <util.h>。
#  if defined(__APPLE__)
#    include <util.h>
#  else
#    include <pty.h>
#  endif
#endif

namespace wtm {

// ============================================================================
// [A] libvterm 装配 + 回调转发
// ============================================================================

namespace {

// 把 libvterm 的 VTermColor 归一化成本方案的 Color(RGB + isDefault)。
// vt 需要传入以便把 indexed/default 色转成 RGB。
Color toColor(VTerm* vt, const VTermColor& c) {
    Color out;
    if (VTERM_COLOR_IS_DEFAULT_FG(&c) || VTERM_COLOR_IS_DEFAULT_BG(&c)) {
        out.isDefault = true;
        return out;
    }
    VTermColor rgb = c;
    // indexed → RGB(default 已在上面拦掉);vterm 提供就地转换。
    vterm_screen_convert_color_to_rgb(vterm_obtain_screen(vt), &rgb);
    out.isDefault = false;
    out.r = rgb.rgb.red;
    out.g = rgb.rgb.green;
    out.b = rgb.rgb.blue;
    return out;
}

} // namespace

// ---- 静态转发 thunk:libvterm 的 C 回调 → 实例方法 -------------------------
// VTermScreenCallbacks 的每个成员签名由 libvterm 规定,user 即我们注册时传的 this。

static int cbDamage(VTermRect rect, void* user) {
    auto* self = static_cast<TerminalSession*>(user);
    // libvterm 的 rect 是 [start_row,end_row) x [start_col,end_col) 半开区间;
    // 我们的内部处理用闭区间,故 end 减 1。
    self->handleDamageFwd(rect.start_row, rect.end_row - 1,
                          rect.start_col, rect.end_col - 1);
    return 1;
}

static int cbMoveCursor(VTermPos pos, VTermPos /*oldpos*/, int visible, void* user) {
    auto* self = static_cast<TerminalSession*>(user);
    self->handleMoveCursorFwd(pos.row, pos.col, visible != 0);
    return 1;
}

static int cbBell(void* user) {
    static_cast<TerminalSession*>(user)->handleBellFwd();
    return 1;
}

static int cbResize(int rows, int cols, void* user) {
    static_cast<TerminalSession*>(user)->handleResizeFwd(cols, rows);
    return 1;
}

static int cbSetTermProp(VTermProp prop, VTermValue* val, void* user) {
    auto* self = static_cast<TerminalSession*>(user);
    switch (prop) {
    case VTERM_PROP_TITLE:
        // val->string 是 VTermStringFragment(可能分片);简化:一次性取。
        // TODO(term): 处理分片标题(long title 会分多次回调);此处只接完整帧。
        if (val->string.str && val->string.len > 0) {
            self->handleSetTitleFwd(
                QString::fromUtf8(val->string.str,
                                  static_cast<int>(val->string.len)));
        }
        break;
    case VTERM_PROP_CURSORVISIBLE:
        self->handleCursorVisibleFwd(val->boolean != 0);
        break;
    default:
        break; // 其它 prop(鼠标模式/光标形状等)交给 render 角色后续处理
    }
    return 1;
}

// libvterm 想往 PTY 写字节(键盘输入的转义序列、DA/DSR 回应等)。
static void cbOutput(const char* s, size_t len, void* user) {
    static_cast<TerminalSession*>(user)->handleVTermOutputFwd(s, len);
}

// ---- 构造 / 析构 -----------------------------------------------------------

TerminalSession::TerminalSession(QObject* parent) : QObject(parent) {}

TerminalSession::~TerminalSession() {
    shutdown();
    if (vt_) {
        vterm_free(vt_);
        vt_ = nullptr;
    }
}

bool TerminalSession::start(const QString& program, const QStringList& args,
                            int cols, int rows) {
    if (running_) {
        qWarning("TerminalSession::start 已在运行,忽略重复启动");
        return false;
    }
    if (cols <= 0 || rows <= 0) { cols = 80; rows = 24; }

    // --- 1) 装配 libvterm ---
    vt_ = vterm_new(rows, cols);
    if (!vt_) return false;
    vterm_set_utf8(vt_, 1);
    // 键盘/回应输出的落点:写回 PTY。
    vterm_output_set_callback(vt_, &cbOutput, this);

    screen_ = vterm_obtain_screen(vt_);
    static const VTermScreenCallbacks kCallbacks = {
        /* damage      */ cbDamage,
        /* moverect    */ nullptr,   // 用 damage 覆盖即可,滚动优化后续再做
        /* movecursor  */ cbMoveCursor,
        /* settermprop */ cbSetTermProp,
        /* bell        */ cbBell,
        /* resize      */ cbResize,
        /* sb_pushline */ nullptr,   // TODO(term): scrollback —— 回滚缓冲后续实现
        /* sb_popline  */ nullptr,
    };
    vterm_screen_set_callbacks(screen_, &kCallbacks, this);
    vterm_screen_reset(screen_, 1);

    cols_ = cols;
    rows_ = rows;
    grid_.assign(static_cast<std::size_t>(cols_) * rows_, Cell{});

    // --- 2) 起 PTY + shell ---
    if (!spawnPty(program, args, cols, rows)) {
        vterm_free(vt_);
        vt_ = nullptr;
        screen_ = nullptr;
        return false;
    }

    running_ = true;
    return true;
}

void TerminalSession::shutdown() {
    if (!running_ && ptyMasterFd_ < 0 && !hChild_) return;
    closePty();
    running_ = false;
}

// ---- 回调:实例侧处理 ------------------------------------------------------

void TerminalSession::handleDamage(int startRow, int endRow,
                                   int startCol, int endCol) {
    refreshCells(startRow, endRow, startCol, endCol);
    emit damaged(startRow, endRow, startCol, endCol);
}

void TerminalSession::handleMoveCursor(int row, int col, bool visible) {
    cursorRow_ = row;
    cursorCol_ = col;
    cursorVisible_ = visible;
    emit cursorMoved(row, col);
}

void TerminalSession::handleBell() { emit bell(); }

void TerminalSession::handleResize(int cols, int rows) {
    if (cols == cols_ && rows == rows_) return;
    cols_ = cols;
    rows_ = rows;
    grid_.assign(static_cast<std::size_t>(cols_) * rows_, Cell{});
    // 尺寸变了,整屏刷一遍影子网格。
    refreshCells(0, rows_ - 1, 0, cols_ - 1);
    emit resized(cols, rows);
}

void TerminalSession::handleSetTitle(const QString& title) {
    title_ = title;
    emit titleChanged(title_);
}

void TerminalSession::handleVTermOutput(const char* bytes, std::size_t len) {
    writeRaw(bytes, len);
}

// 把 libvterm 屏幕的一块矩形刷进本地影子网格 grid_。
void TerminalSession::refreshCells(int startRow, int endRow,
                                   int startCol, int endCol) {
    if (!screen_) return;
    if (startRow < 0) startRow = 0;
    if (startCol < 0) startCol = 0;
    if (endRow >= rows_) endRow = rows_ - 1;
    if (endCol >= cols_) endCol = cols_ - 1;

    for (int r = startRow; r <= endRow; ++r) {
        for (int c = startCol; c <= endCol; ++c) {
            VTermPos pos{r, c};
            VTermScreenCell vc;
            Cell& out = grid_[static_cast<std::size_t>(r) * cols_ + c];
            if (vterm_screen_get_cell(screen_, pos, &vc) == 0) {
                out = Cell{};  // 取不到 → 空格
                continue;
            }
            // 码点:取首个(合字/组合序列的完整还原留 TODO)。
            out.codepoint = vc.chars[0] ? static_cast<char32_t>(vc.chars[0]) : U' ';
            out.width = static_cast<std::uint8_t>(vc.width);
            out.attrs.bold      = vc.attrs.bold;
            out.attrs.underline = vc.attrs.underline != 0;
            out.attrs.italic    = vc.attrs.italic;
            out.attrs.blink     = vc.attrs.blink;
            out.attrs.reverse   = vc.attrs.reverse;
            out.attrs.strike    = vc.attrs.strike;
            out.fg = toColor(vt_, vc.fg);
            out.bg = toColor(vt_, vc.bg);
        }
    }
}

// ---- thunk → 实例 的公开转发桥(供本文件的 static cb* 调用)----------------
// 注:头文件把处理方法声明为 private,而 static cb* 是文件局部自由函数,
// 需要能调到实例。这里提供一层同名 *Fwd 公开薄封装,声明见下方类外扩展。

// ============================================================================
// [B] 只读网格 / 输入原语
// ============================================================================

const Cell& TerminalSession::cellAt(int row, int col) const {
    if (row < 0 || col < 0 || row >= rows_ || col >= cols_) return emptyCell_;
    return grid_[static_cast<std::size_t>(row) * cols_ + col];
}

void TerminalSession::sendText(const QString& text) {
    if (!vt_) return;
    // 逐码点走 libvterm 键盘接口,让它按当前模式(应用键盘/bracketed 等)
    // 生成正确字节;输出经 cbOutput 落到 PTY。
    for (const QChar& qc : text) {
        // 简化:BMP 直送;补充平面留 TODO(需组 UTF-32 码点)。
        vterm_keyboard_unichar(vt_, qc.unicode(), VTERM_MOD_NONE);
    }
}

void TerminalSession::sendKey(SpecialKey key, std::uint8_t mods) {
    if (!vt_) return;
    VTermModifier m = VTERM_MOD_NONE;
    if (mods & ModShift) m = static_cast<VTermModifier>(m | VTERM_MOD_SHIFT);
    if (mods & ModAlt)   m = static_cast<VTermModifier>(m | VTERM_MOD_ALT);
    if (mods & ModCtrl)  m = static_cast<VTermModifier>(m | VTERM_MOD_CTRL);

    VTermKey vk = VTERM_KEY_NONE;
    switch (key) {
    case SpecialKey::Enter:     vk = VTERM_KEY_ENTER;    break;
    case SpecialKey::Tab:       vk = VTERM_KEY_TAB;      break;
    case SpecialKey::Backspace: vk = VTERM_KEY_BACKSPACE;break;
    case SpecialKey::Escape:    vk = VTERM_KEY_ESCAPE;   break;
    case SpecialKey::Up:        vk = VTERM_KEY_UP;       break;
    case SpecialKey::Down:      vk = VTERM_KEY_DOWN;     break;
    case SpecialKey::Left:      vk = VTERM_KEY_LEFT;     break;
    case SpecialKey::Right:     vk = VTERM_KEY_RIGHT;    break;
    case SpecialKey::Home:      vk = VTERM_KEY_HOME;     break;
    case SpecialKey::End:       vk = VTERM_KEY_END;      break;
    case SpecialKey::PageUp:    vk = VTERM_KEY_PAGEUP;   break;
    case SpecialKey::PageDown:  vk = VTERM_KEY_PAGEDOWN; break;
    case SpecialKey::Insert:    vk = VTERM_KEY_INS;      break;
    case SpecialKey::Delete:    vk = VTERM_KEY_DEL;      break;
    }
    vterm_keyboard_key(vt_, vk, m);
}

void TerminalSession::resize(int cols, int rows) {
    if (cols <= 0 || rows <= 0) return;
    if (cols == cols_ && rows == rows_) return;
    // 三处同步:libvterm(会触发 cbResize→handleResize 重建 grid_)、PTY winsize。
    if (vt_) vterm_set_size(vt_, rows, cols);
    applyPtyWinsize(cols, rows);
    // 兜底:若 vterm 未回调 resize(尺寸相同等),这里也保证本地一致。
    if (cols != cols_ || rows != rows_) handleResize(cols, rows);
}

void TerminalSession::feed(const char* data, std::size_t len) {
    if (!vt_ || len == 0) return;
    vterm_input_write(vt_, data, len);
    // libvterm 在 input_write 过程中同步触发 damage/movecursor 等回调,
    // 影子网格已在回调里更新完毕,无需额外 flush。
}

// ============================================================================
// [C] PTY 后端(平台分支)
// ============================================================================

#if defined(WTM_PTY_UNIX)

bool TerminalSession::spawnPty(const QString& program, const QStringList& args,
                               int cols, int rows) {
    struct winsize ws{};
    ws.ws_col = static_cast<unsigned short>(cols);
    ws.ws_row = static_cast<unsigned short>(rows);

    int master = -1;
    pid_t pid = forkpty(&master, nullptr, nullptr, &ws);
    if (pid < 0) {
        qWarning("TerminalSession: forkpty 失败");
        return false;
    }

    if (pid == 0) {
        // --- 子进程:exec shell ---
        // 选 shell:显式 program > $SHELL > /bin/sh。
        QByteArray prog = program.toLocal8Bit();
        const char* shell = prog.isEmpty() ? nullptr : prog.constData();
        if (!shell) shell = ::getenv("SHELL");
        if (!shell || !*shell) shell = "/bin/sh";

        // 组 argv:argv[0]=shell,其后接调用方 args。
        std::vector<QByteArray> holders;
        std::vector<char*> argv;
        holders.emplace_back(QByteArray(shell));
        argv.push_back(holders.back().data());
        for (const QString& a : args) {
            holders.emplace_back(a.toLocal8Bit());
            argv.push_back(holders.back().data());
        }
        argv.push_back(nullptr);

        // 声明我们是个够格的终端,让程序开彩色/交互特性。
        ::setenv("TERM", "xterm-256color", 1);

        ::execvp(shell, argv.data());
        // exec 只有失败才返回。
        ::_exit(127);
    }

    // --- 父进程 ---
    childPid_ = pid;
    ptyMasterFd_ = master;

    // master fd 设非阻塞,配合 QSocketNotifier 做事件驱动读取。
    int flags = ::fcntl(master, F_GETFL, 0);
    ::fcntl(master, F_SETFL, flags | O_NONBLOCK);

    readNotifier_ = new QSocketNotifier(master, QSocketNotifier::Read, this);
    QObject::connect(readNotifier_, &QSocketNotifier::activated,
                     this, [this]() { onPtyReadable(); });
    return true;
}

void TerminalSession::onPtyReadable() {
    if (ptyMasterFd_ < 0) return;
    std::array<char, 8192> buf;
    for (;;) {
        ssize_t n = ::read(ptyMasterFd_, buf.data(), buf.size());
        if (n > 0) {
            feed(buf.data(), static_cast<std::size_t>(n));
            if (static_cast<std::size_t>(n) < buf.size()) break; // 读干净了
            continue;
        }
        if (n < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) break; // 暂时没数据
            // 其它错误当作关闭。
        }
        // n == 0:EOF,shell 退出了。
        if (n == 0 || (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK)) {
            int status = 0;
            int code = -1;
            if (childPid_ > 0 && ::waitpid(childPid_, &status, WNOHANG) > 0) {
                code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
            }
            closePty();
            running_ = false;
            emit childExited(code);
            break;
        }
    }
}

void TerminalSession::writeRaw(const char* bytes, std::size_t len) {
    if (ptyMasterFd_ < 0 || len == 0) return;
    std::size_t off = 0;
    while (off < len) {
        ssize_t n = ::write(ptyMasterFd_, bytes + off, len - off);
        if (n > 0) { off += static_cast<std::size_t>(n); continue; }
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) continue; // 忙等一下
        break; // 写失败(管道断)
    }
}

void TerminalSession::applyPtyWinsize(int cols, int rows) {
    if (ptyMasterFd_ < 0) return;
    struct winsize ws{};
    ws.ws_col = static_cast<unsigned short>(cols);
    ws.ws_row = static_cast<unsigned short>(rows);
    ::ioctl(ptyMasterFd_, TIOCSWINSZ, &ws);
    // 内核会给前台进程组发 SIGWINCH,shell/程序据此重排。
}

void TerminalSession::closePty() {
    if (readNotifier_) {
        readNotifier_->setEnabled(false);
        readNotifier_->deleteLater();
        readNotifier_ = nullptr;
    }
    if (ptyMasterFd_ >= 0) {
        ::close(ptyMasterFd_);
        ptyMasterFd_ = -1;
    }
    if (childPid_ > 0) {
        // 温和收尾:HUP 让 shell 自己退;僵尸由 waitpid 回收。
        ::kill(childPid_, SIGHUP);
        int status = 0;
        ::waitpid(childPid_, &status, WNOHANG);
        childPid_ = -1;
    }
}

#elif defined(WTM_PTY_WINDOWS)

// ---- Windows ConPTY 后端 ---------------------------------------------------
// 思路(与 Unix 对称):CreatePseudoConsole 建伪终端,拿到 HPCON + 一对匿名管道;
// 用 STARTUPINFOEX + PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE 把 shell 挂到伪终端上;
// 起一个读线程从 hPtyOut_ 读字节,marshaling 回 Qt 线程后 feed() 进 libvterm。
//
// 下面是可编译的骨架 + TODO:管道创建 / 进程创建 / 读线程尚未逐行落地,
// 需要 pty 角色或本角色后续补齐(标注处均为明确 TODO,不是假装完成)。

bool TerminalSession::spawnPty(const QString& program, const QStringList& args,
                               int cols, int rows) {
    // 选 shell:显式 program > %ComSpec% > powershell.exe。
    QString shell = program;
    if (shell.isEmpty()) {
        const char* comspec = ::getenv("ComSpec");
        shell = comspec && *comspec ? QString::fromLocal8Bit(comspec)
                                    : QStringLiteral("powershell.exe");
    }
    Q_UNUSED(args);

    // --- 1) 建输入/输出管道 ---
    HANDLE inRead = nullptr, inWrite = nullptr;
    HANDLE outRead = nullptr, outWrite = nullptr;
    if (!::CreatePipe(&inRead, &inWrite, nullptr, 0) ||
        !::CreatePipe(&outRead, &outWrite, nullptr, 0)) {
        qWarning("TerminalSession(win): CreatePipe 失败");
        return false;
    }

    // --- 2) 建伪终端 ---
    COORD size;
    size.X = static_cast<SHORT>(cols);
    size.Y = static_cast<SHORT>(rows);
    HPCON hpc = nullptr;
    HRESULT hr = ::CreatePseudoConsole(size, inRead, outWrite, 0, &hpc);
    // ConPTY 建成后,它自己持有 inRead/outWrite,父进程侧可关掉这两端。
    ::CloseHandle(inRead);
    ::CloseHandle(outWrite);
    if (FAILED(hr)) {
        qWarning("TerminalSession(win): CreatePseudoConsole 失败");
        ::CloseHandle(inWrite);
        ::CloseHandle(outRead);
        return false;
    }

    hPseudoConsole_ = hpc;
    hPtyIn_  = inWrite;   // 我们写 → shell 读
    hPtyOut_ = outRead;   // shell 写 → 我们读

    // --- 3) 用 STARTUPINFOEX 把伪终端挂到子进程 ---
    // a) 先探测 attribute list 所需字节数(第一次调用必然「失败」并回填 size)。
    STARTUPINFOEXW si;
    ZeroMemory(&si, sizeof(si));
    si.StartupInfo.cb = sizeof(STARTUPINFOEXW);

    SIZE_T attrSize = 0;
    ::InitializeProcThreadAttributeList(nullptr, 1, 0, &attrSize);
    si.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
        ::HeapAlloc(::GetProcessHeap(), 0, attrSize));
    if (!si.lpAttributeList) {
        qWarning("TerminalSession(win): HeapAlloc(attr list) 失败");
        closePty();
        return false;
    }

    // b) 真初始化 + 绑定伪终端属性。
    if (!::InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &attrSize) ||
        !::UpdateProcThreadAttribute(
            si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
            hpc, sizeof(hpc), nullptr, nullptr)) {
        qWarning("TerminalSession(win): 初始化/绑定 ProcThreadAttributeList 失败");
        ::HeapFree(::GetProcessHeap(), 0, si.lpAttributeList);
        closePty();
        return false;
    }

    // c) 组命令行:shell + 透传 args(CreateProcessW 需要可写缓冲区)。
    QString cmdline = shell;
    for (const QString& a : args) {
        cmdline += QLatin1Char(' ');
        cmdline += a;
    }
    std::wstring wcmd = cmdline.toStdWString();
    std::vector<wchar_t> cmdBuf(wcmd.begin(), wcmd.end());
    cmdBuf.push_back(L'\0');

    // 声明我们是个够格的终端(与 Unix 侧对齐,让程序开彩色/交互特性)。
    ::SetEnvironmentVariableW(L"TERM", L"xterm-256color");

    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));
    const BOOL created = ::CreateProcessW(
        nullptr, cmdBuf.data(), nullptr, nullptr, FALSE,
        EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr,
        &si.StartupInfo, &pi);

    ::DeleteProcThreadAttributeList(si.lpAttributeList);
    ::HeapFree(::GetProcessHeap(), 0, si.lpAttributeList);

    if (!created) {
        qWarning("TerminalSession(win): CreateProcessW 失败(err=%lu)", ::GetLastError());
        closePty();
        return false;
    }

    hChild_ = pi.hProcess;      // 子进程 HANDLE(closePty 负责收尾)
    ::CloseHandle(pi.hThread);  // 主线程句柄用不到

    // --- 4) 读线程:阻塞 ReadFile(hPtyOut_) → 回主线程 feed() 进 libvterm ---
    readThreadStop_.store(false);
    HANDLE outHandle = reinterpret_cast<HANDLE>(hPtyOut_);
    readThread_ = std::thread([this, outHandle]() {
        std::array<char, 8192> buf;
        for (;;) {
            DWORD nread = 0;
            const BOOL ok = ::ReadFile(outHandle, buf.data(),
                                       static_cast<DWORD>(buf.size()), &nread, nullptr);
            if (!ok || nread == 0) break;   // 管道关闭 / EOF → shell 退出
            if (readThreadStop_.load()) break;
            // feed 非线程安全:把这段字节拷贝进 QByteArray,排队回主线程执行。
            QByteArray chunk(buf.data(), static_cast<int>(nread));
            QMetaObject::invokeMethod(this, [this, chunk]() {
                if (running_) feed(chunk.constData(),
                                   static_cast<std::size_t>(chunk.size()));
            }, Qt::QueuedConnection);
        }
        // EOF:回主线程宣告子进程退出(带退出码)。
        QMetaObject::invokeMethod(this, [this]() {
            if (!running_) return;
            DWORD code = 0;
            if (hChild_) ::GetExitCodeProcess(reinterpret_cast<HANDLE>(hChild_), &code);
            running_ = false;
            emit childExited(static_cast<int>(code));
        }, Qt::QueuedConnection);
    });

    return true;
}

void TerminalSession::onPtyReadable() {
    // Windows 侧走独立读线程,不用 QSocketNotifier;此函数在本平台不被调用。
    // 留空实现以满足链接。
}

void TerminalSession::writeRaw(const char* bytes, std::size_t len) {
    if (!hPtyIn_ || len == 0) return;
    DWORD written = 0;
    ::WriteFile(reinterpret_cast<HANDLE>(hPtyIn_), bytes,
                static_cast<DWORD>(len), &written, nullptr);
}

void TerminalSession::applyPtyWinsize(int cols, int rows) {
    if (!hPseudoConsole_) return;
    COORD size;
    size.X = static_cast<SHORT>(cols);
    size.Y = static_cast<SHORT>(rows);
    ::ResizePseudoConsole(reinterpret_cast<HPCON>(hPseudoConsole_), size);
}

void TerminalSession::closePty() {
    // 收尾顺序有讲究:ClosePseudoConsole 会阻塞到「所有输出被读完」,
    // 若读线程已停读则可能挂死。因此先关掉输出读端,让阻塞中的 ReadFile 立即返回、
    // 读线程退出并被 join,再 ClosePseudoConsole 才安全。
    readThreadStop_.store(true);

    if (hPtyOut_) {   // 关读端 → 唤醒/结束阻塞的 ReadFile
        ::CloseHandle(reinterpret_cast<HANDLE>(hPtyOut_));
        hPtyOut_ = nullptr;
    }
    if (readThread_.joinable()) {
        // 理论上不会从读线程自身调用本函数;万一如此则 detach 以免自 join 死锁。
        if (std::this_thread::get_id() == readThread_.get_id()) {
            readThread_.detach();
        } else {
            readThread_.join();
        }
    }
    if (hPseudoConsole_) {
        ::ClosePseudoConsole(reinterpret_cast<HPCON>(hPseudoConsole_));
        hPseudoConsole_ = nullptr;
    }
    if (hPtyIn_) { ::CloseHandle(reinterpret_cast<HANDLE>(hPtyIn_)); hPtyIn_ = nullptr; }
    if (hChild_) {
        ::TerminateProcess(reinterpret_cast<HANDLE>(hChild_), 0);
        ::CloseHandle(reinterpret_cast<HANDLE>(hChild_));
        hChild_ = nullptr;
    }
}

#endif // 平台分支

// ============================================================================
// thunk → 实例 的公开转发桥实现
// ============================================================================
// static cb* 只能拿到 void* user,需要一条公开路径调私有处理方法。
// 这里把 *Fwd 定义为 TerminalSession 的公开转发函数(声明在类外补充块)。

void TerminalSession::handleDamageFwd(int r0, int r1, int c0, int c1) { handleDamage(r0, r1, c0, c1); }
void TerminalSession::handleMoveCursorFwd(int r, int c, bool v) { handleMoveCursor(r, c, v); }
void TerminalSession::handleBellFwd() { handleBell(); }
void TerminalSession::handleResizeFwd(int cols, int rows) { handleResize(cols, rows); }
void TerminalSession::handleSetTitleFwd(const QString& t) { handleSetTitle(t); }
void TerminalSession::handleCursorVisibleFwd(bool v) {
    cursorVisible_ = v;
    emit cursorMoved(cursorRow_, cursorCol_);
}
void TerminalSession::handleVTermOutputFwd(const char* b, std::size_t n) { handleVTermOutput(b, n); }

} // namespace wtm

// ---- CMake 集成(已收口)---------------------------------------------------
// 顶层 CMakeLists.txt 现状:
//   1) libvterm 走 vendored 源码:add_subdirectory(third_party/libvterm) 编出
//      静态库 target `vterm`,并 target_link_libraries(wintermmac ... vterm)。
//      三平台(含 Windows/MSVC)统一构建,不再依赖 pkg-config / vcpkg。
//      (可用 -DWTM_USE_SYSTEM_VTERM=ON 强制回退系统库。)
//   2) 本文件已在 SOURCES:src/term/TerminalSession.cpp。
