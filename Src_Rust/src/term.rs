// Win-Term-Mac / Src_Rust —— 角色【Terminal】。
//
// 职责:
//   1. 用 portable-pty 启动一个子 shell,拿到 master 端的读/写句柄。
//   2. 用 alacritty_terminal 解析子进程的输出字节流,维护一个终端网格(grid)。
//   3. 对外暴露一个只读的网格快照接口(snapshot),供 GPU 渲染层读取。
//
// 一个 `Terminal` 实例 = 窗格树里的一个叶子(one real terminal)。
// 渲染由上层的 wgpu/glyphon 完成;本文件只负责“仿真 + 数据”,渲染处留 TODO 桩。

use std::io::{Read, Write};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::Config;
use alacritty_terminal::vte::ansi::{Color, NamedColor, Processor};
use alacritty_terminal::Term;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

// ===========================================================================
// 对外的只读数据结构:渲染层读取这些即可,不需要碰 alacritty 的内部类型。
// ===========================================================================

/// 8-bit-per-channel 颜色。所有 alacritty 的具名/索引色都会被解析成 RGB。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    const fn new(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b }
    }
}

/// 网格中的一个单元格(一个字符 + 前景/背景色 + 样式位)。
#[derive(Clone, Copy, Debug)]
pub struct GridCell {
    pub c: char,
    pub fg: Rgb,
    pub bg: Rgb,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    /// 反显(前景背景互换)。渲染层可自行决定是渲染时互换,还是我们已互换。
    pub inverse: bool,
}

impl Default for GridCell {
    fn default() -> Self {
        Self {
            c: ' ',
            fg: DEFAULT_FG,
            bg: DEFAULT_BG,
            bold: false,
            italic: false,
            underline: false,
            inverse: false,
        }
    }
}

/// 光标位置(以单元格为单位)与可见性。
#[derive(Clone, Copy, Debug)]
pub struct CursorPos {
    pub col: usize,
    pub row: usize,
    pub visible: bool,
}

/// 某一时刻的整屏网格快照。行主序(row-major),`cells.len() == cols * rows`。
pub struct GridSnapshot {
    pub cols: usize,
    pub rows: usize,
    pub cells: Vec<GridCell>,
    pub cursor: CursorPos,
}

impl GridSnapshot {
    /// 取 (row, col) 处的单元格。越界返回 None。
    pub fn cell(&self, row: usize, col: usize) -> Option<&GridCell> {
        if row >= self.rows || col >= self.cols {
            return None;
        }
        self.cells.get(row * self.cols + col)
    }
}

// ===========================================================================
// alacritty 事件监听:本方案暂不消费事件(标题变化、响铃、剪贴板等)。
// TODO(integration): 若要支持“窗口标题跟随子进程”,在此把 Event 转发给上层。
// ===========================================================================

#[derive(Clone)]
struct EventProxy;

impl EventListener for EventProxy {
    fn send_event(&self, _event: Event) {
        // 目前忽略所有终端事件。
    }
}

// ===========================================================================
// Dimensions:alacritty 的 Term/Grid 需要知道行列数。
// 我们不使用 scrollback 之外的历史行,total_lines == screen_lines。
// ===========================================================================

#[derive(Clone, Copy)]
struct TermDimensions {
    columns: usize,
    screen_lines: usize,
}

impl Dimensions for TermDimensions {
    fn total_lines(&self) -> usize {
        self.screen_lines
    }

    fn screen_lines(&self) -> usize {
        self.screen_lines
    }

    fn columns(&self) -> usize {
        self.columns
    }
}

// ===========================================================================
// 终端实例
// ===========================================================================

/// 一个终端叶子:PTY 子进程 + alacritty 仿真网格。
pub struct Terminal {
    /// alacritty 终端状态机(持有网格)。
    term: Term<EventProxy>,
    /// VTE/ANSI 解析器:把字节喂给它,它驱动 `term` 更新。
    parser: Processor,
    /// PTY master 端;用于 resize。
    master: Box<dyn MasterPty + Send>,
    /// 向子进程写入(用户键入)。
    writer: Box<dyn Write + Send>,
    /// 子进程句柄;Drop 时确保回收。
    child: Box<dyn Child + Send + Sync>,
    /// 读线程通过 channel 把子进程输出块送过来。
    rx: Receiver<Vec<u8>>,
    cols: usize,
    rows: usize,
}

impl Terminal {
    /// 启动一个子 shell 并创建终端。`cols`/`rows` 为初始网格尺寸(单位:单元格)。
    ///
    /// `shell` 为 None 时按平台选默认 shell(读 $SHELL / 回退到常见 shell)。
    pub fn spawn(cols: usize, rows: usize, shell: Option<&str>) -> std::io::Result<Self> {
        let cols = cols.max(1);
        let rows = rows.max(1);

        // 1) 开一个 PTY。
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows as u16,
                cols: cols as u16,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(to_io_err)?;

        // 2) 在 slave 端拉起子 shell。
        let cmd = build_shell_command(shell);
        let child = pair.slave.spawn_command(cmd).map_err(to_io_err)?;
        // slave 句柄留在这里会阻止我们收到 EOF;spawn 之后即可丢弃。
        drop(pair.slave);

        // 3) 读端放到后台线程,把输出块通过 channel 送回主线程。
        let mut reader = pair.master.try_clone_reader().map_err(to_io_err)?;
        let writer = pair.master.take_writer().map_err(to_io_err)?;
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        thread::Builder::new()
            .name("pty-reader".into())
            .spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break, // 子进程退出,PTY 关闭。
                        Ok(n) => {
                            if tx.send(buf[..n].to_vec()).is_err() {
                                break; // 接收端(Terminal)已销毁。
                            }
                        }
                        Err(_) => break,
                    }
                }
            })?;

        // 4) 建立 alacritty 终端与解析器。
        let dims = TermDimensions {
            columns: cols,
            screen_lines: rows,
        };
        let term = Term::new(Config::default(), &dims, EventProxy);
        let parser = Processor::new();

        Ok(Self {
            term,
            parser,
            master: pair.master,
            writer,
            child,
            rx,
            cols,
            rows,
        })
    }

    /// 抽干 channel 中已到达的输出并喂给解析器,更新网格。
    ///
    /// 非阻塞。返回 true 表示本次有新数据处理(上层可据此决定是否重绘)。
    /// 每帧调用一次即可。
    pub fn pump(&mut self) -> bool {
        let mut dirty = false;
        loop {
            match self.rx.try_recv() {
                Ok(chunk) => {
                    // vte 0.13 的 Processor::advance 按单字节推进。
                    for &byte in &chunk {
                        self.parser.advance(&mut self.term, byte);
                    }
                    dirty = true;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break, // 读线程结束。
            }
        }
        dirty
    }

    /// 把用户输入的字节写给子进程(例如键盘产生的字符/控制序列)。
    pub fn write_input(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.writer.write_all(bytes)?;
        self.writer.flush()
    }

    /// 改变终端尺寸:同时调整 PTY(通知子进程 SIGWINCH)和仿真网格。
    pub fn resize(&mut self, cols: usize, rows: usize) {
        let cols = cols.max(1);
        let rows = rows.max(1);
        if cols == self.cols && rows == self.rows {
            return;
        }
        self.cols = cols;
        self.rows = rows;

        // 通知子进程新的窗口大小。
        let _ = self.master.resize(PtySize {
            rows: rows as u16,
            cols: cols as u16,
            pixel_width: 0,
            pixel_height: 0,
        });

        // 调整 alacritty 网格。
        self.term.resize(TermDimensions {
            columns: cols,
            screen_lines: rows,
        });
    }

    /// 当前网格的列数。
    pub fn cols(&self) -> usize {
        self.cols
    }

    /// 当前网格的行数。
    pub fn rows(&self) -> usize {
        self.rows
    }

    /// 子进程是否仍在运行。
    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// 生成整屏只读快照,供渲染层逐格绘制。
    ///
    /// 这是 Terminal 对外最核心的读取接口:GPU 渲染层只依赖 `GridSnapshot`,
    /// 不需要接触任何 alacritty 内部类型。
    // TODO(render): GPU 侧在拿到 snapshot 后,用 glyphon/cosmic-text 逐格排版:
    //   - 按 GridCell.c 塑形字形,fg/bg 上色,bold/italic/underline 应用样式;
    //   - inverse 时前景背景互换;
    //   - 依 CursorPos 在对应格子叠加光标块。
    //   本文件不做任何 GPU 调用,仅提供数据。
    pub fn snapshot(&self) -> GridSnapshot {
        let grid = self.term.grid();
        let cols = self.cols;
        let rows = self.rows;
        let mut cells = Vec::with_capacity(cols * rows);

        for row in 0..rows {
            let line = Line(row as i32);
            for col in 0..cols {
                let point = Point::new(line, Column(col));
                let src = &grid[point];
                cells.push(convert_cell(src));
            }
        }

        // 光标位置来自可渲染内容。display_offset 为 0 时(未向上滚动)
        // 光标行列可直接映射到屏幕坐标。
        let rc = self.term.renderable_content();
        let cursor = CursorPos {
            col: rc.cursor.point.column.0,
            row: rc.cursor.point.line.0.max(0) as usize,
            // Hidden 形状表示光标不可见。
            visible: rc.cursor.shape != alacritty_terminal::vte::ansi::CursorShape::Hidden,
        };

        GridSnapshot {
            cols,
            rows,
            cells,
            cursor,
        }
    }
}

// ===========================================================================
// 内部辅助
// ===========================================================================

/// 把 alacritty 的 Cell 转成对外的 GridCell(含颜色解析)。
fn convert_cell(cell: &alacritty_terminal::term::cell::Cell) -> GridCell {
    let flags = cell.flags;
    GridCell {
        c: cell.c,
        fg: resolve_color(cell.fg, ColorRole::Foreground),
        bg: resolve_color(cell.bg, ColorRole::Background),
        bold: flags.contains(Flags::BOLD),
        italic: flags.contains(Flags::ITALIC),
        underline: flags.intersects(Flags::UNDERLINE | Flags::DOUBLE_UNDERLINE),
        inverse: flags.contains(Flags::INVERSE),
    }
}

#[derive(Clone, Copy)]
enum ColorRole {
    Foreground,
    Background,
}

/// 默认前景 / 背景色(与 main.rs 里的清屏色调保持接近的深色主题)。
const DEFAULT_FG: Rgb = Rgb::new(0xd0, 0xd6, 0xdf);
const DEFAULT_BG: Rgb = Rgb::new(0x0b, 0x0e, 0x13);

/// 把 alacritty 的 Color(具名 / 索引 / 直接 RGB)解析为 Rgb。
fn resolve_color(color: Color, role: ColorRole) -> Rgb {
    match color {
        Color::Spec(rgb) => Rgb::new(rgb.r, rgb.g, rgb.b),
        Color::Indexed(idx) => ansi_256(idx),
        Color::Named(named) => named_color(named, role),
    }
}

/// 具名色 -> RGB。基础 16 色走标准调色板;前景/背景/光标给出深色主题默认值。
fn named_color(named: NamedColor, role: ColorRole) -> Rgb {
    use NamedColor::*;
    match named {
        Black => ansi_256(0),
        Red => ansi_256(1),
        Green => ansi_256(2),
        Yellow => ansi_256(3),
        Blue => ansi_256(4),
        Magenta => ansi_256(5),
        Cyan => ansi_256(6),
        White => ansi_256(7),
        BrightBlack => ansi_256(8),
        BrightRed => ansi_256(9),
        BrightGreen => ansi_256(10),
        BrightYellow => ansi_256(11),
        BrightBlue => ansi_256(12),
        BrightMagenta => ansi_256(13),
        BrightCyan => ansi_256(14),
        BrightWhite => ansi_256(15),
        // 前景系列。
        Foreground => DEFAULT_FG,
        // 背景系列。
        Background => DEFAULT_BG,
        // 光标默认取前景色;渲染层可自行覆盖。
        Cursor => DEFAULT_FG,
        // 兜底:按角色给默认色(覆盖 Dim*/Bright* 前景等其余具名色)。
        _ => match role {
            ColorRole::Foreground => DEFAULT_FG,
            ColorRole::Background => DEFAULT_BG,
        },
    }
}

/// 标准 xterm 256 色调色板解析。
///   0..16    -> 基础 16 色
///   16..232  -> 6x6x6 RGB 立方体
///   232..256 -> 24 级灰阶
fn ansi_256(idx: u8) -> Rgb {
    // 基础 16 色(常见终端主题的近似值)。
    const BASE16: [Rgb; 16] = [
        Rgb::new(0x00, 0x00, 0x00), // 0  black
        Rgb::new(0xcc, 0x33, 0x33), // 1  red
        Rgb::new(0x33, 0xaa, 0x33), // 2  green
        Rgb::new(0xcc, 0xaa, 0x33), // 3  yellow
        Rgb::new(0x33, 0x66, 0xcc), // 4  blue
        Rgb::new(0xaa, 0x44, 0xcc), // 5  magenta
        Rgb::new(0x33, 0xaa, 0xcc), // 6  cyan
        Rgb::new(0xcc, 0xcc, 0xcc), // 7  white
        Rgb::new(0x66, 0x66, 0x66), // 8  bright black
        Rgb::new(0xff, 0x55, 0x55), // 9  bright red
        Rgb::new(0x55, 0xdd, 0x55), // 10 bright green
        Rgb::new(0xff, 0xdd, 0x55), // 11 bright yellow
        Rgb::new(0x55, 0x88, 0xff), // 12 bright blue
        Rgb::new(0xdd, 0x66, 0xff), // 13 bright magenta
        Rgb::new(0x55, 0xdd, 0xff), // 14 bright cyan
        Rgb::new(0xff, 0xff, 0xff), // 15 bright white
    ];

    let i = idx as usize;
    if i < 16 {
        return BASE16[i];
    }
    if i < 232 {
        // 6x6x6 立方体。
        let n = (i - 16) as u8;
        let r = n / 36;
        let g = (n % 36) / 6;
        let b = n % 6;
        // 每级映射到 0/95/135/175/215/255。
        let level = |v: u8| -> u8 {
            if v == 0 {
                0
            } else {
                55 + v * 40
            }
        };
        return Rgb::new(level(r), level(g), level(b));
    }
    // 24 级灰阶:8, 18, ..., 238。
    let v = 8 + (i as u8 - 232) * 10;
    Rgb::new(v, v, v)
}

/// 按平台构造启动子 shell 的命令。
fn build_shell_command(shell: Option<&str>) -> CommandBuilder {
    let program = match shell {
        Some(s) => s.to_string(),
        None => default_shell(),
    };
    let mut cmd = CommandBuilder::new(program);
    // 继承当前工作目录,便于新窗格从同一位置起步。
    if let Ok(cwd) = std::env::current_dir() {
        cmd.cwd(cwd);
    }
    cmd
}

/// 选择默认 shell。
fn default_shell() -> String {
    if cfg!(windows) {
        // 优先 PowerShell,回退到 cmd。
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

/// 把 portable-pty 的错误(anyhow::Error)转成 std::io::Error。
fn to_io_err(e: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
}
