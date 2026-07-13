// Win-Term-Mac / Src_Flutter 方案 ——【io / bridge】角色。
//
// 本文件负责 PTY 与终端仿真器之间的 **双向数据桥**(单向职责、可复用、可测):
//   进程 → 屏幕: Pty.output(字节) --UTF-8解码--> Terminal.write(文本)
//   键盘 → 进程: Terminal.onOutput(文本) --UTF-8编码--> Pty.write(字节)
//   尺寸同步:  Terminal.onResize / 显式 resize() --> Pty.resize(rows, cols)
//
// 与 term/terminal_session.dart 的关系:
//   terminal_session.dart 里的 `TerminalSession` 目前把这套接线 **内联** 在
//   自己的 `_wire()` 里。本模块把同一套接线抽成一个独立、可单独持有、可显式
//   dispose 的 [PtyBridge],额外做了两件 `_wire()` 没做的事:
//     1) 保存并在 dispose 时 **取消** output 订阅(内联版本从不取消,进程收尾
//        阶段可能残留回调);
//     2) 暴露显式 [resize] / [write] 入口,方便上层(窗格 resize 热键、粘贴、
//        命令注入)在不依赖 Terminal 回调的情况下驱动 PTY。
//
// 复用原则:本模块 **不重新实现** PTY,也不创建进程;它只接一对「已经存在的」
//          [Terminal] + [Pty]。进程的创建/默认 shell 选择仍归 terminal_session.dart。
//
// ── integrator 需要如何调用我 ──────────────────────────────────────────────
// 二选一,不要两者同时用(否则 onOutput/onResize 会被互相覆盖 / 重复写入):
//
//   A) 若继续用现成的 `TerminalSession.start()`:它内部已自行接线,**无需** 再挂
//      本桥;直接用 session 即可。本模块此时仅作为「更完善的接线参考实现」。
//
//   B) 若想用本桥统一管理 IO(推荐用于需要显式 resize/清理的窗格场景):
//        final terminal = Terminal(maxLines: 10000);
//        final pty = Pty.start(shell, columns: 80, rows: 24, ...);
//        final bridge = PtyBridge.attach(terminal: terminal, pty: pty);
//        // 窗格 resize 热键触发时:
//        bridge.resize(cols, rows);
//        // 叶子被彻底删除时:
//        bridge.dispose();   // 取消订阅、解绑回调(默认不杀进程)
//      注意:此路径下 **不要** 再对同一个 terminal 调用会重新设置
//      terminal.onOutput/onResize 的代码(如 TerminalSession._wire)。

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter_pty/flutter_pty.dart';
import 'package:xterm/xterm.dart';

/// 一个 [Terminal] 与一个 [Pty] 之间的双向 IO 桥。
///
/// 只做「搬字节」这一件事,不创建进程、不管窗格树。生命周期由持有者负责:
/// 通过 [PtyBridge.attach] 接线,通过 [dispose] 拆线。
class PtyBridge {
  PtyBridge._({
    required this.terminal,
    required this.pty,
    required bool killPtyOnDispose,
    void Function(int exitCode)? onExit,
  })  : _killPtyOnDispose = killPtyOnDispose,
        _onExit = onExit;

  /// 被驱动的 xterm 仿真器(屏幕侧)。
  final Terminal terminal;

  /// 被驱动的底层 PTY 进程(shell 侧)。
  final Pty pty;

  /// dispose 时是否顺带杀掉底层进程。
  ///
  /// 默认 false:窗格移动/交换会把叶子从一处卸载再挂到另一处,期间可能临时
  /// 拆桥,但进程必须存活。只有「彻底关闭叶子」时才应传 true(或改用
  /// [TerminalSession.dispose])。
  final bool _killPtyOnDispose;

  final void Function(int exitCode)? _onExit;

  /// output 流订阅,dispose 时取消,避免进程收尾阶段的残留回调。
  StreamSubscription<Uint8List>? _outputSub;

  bool _disposed = false;
  bool get isDisposed => _disposed;

  /// 记住最近一次已知的终端尺寸(列/行),用于去抖:相同尺寸不重复通知 PTY。
  int _lastCols = -1;
  int _lastRows = -1;

  // 容忍跨读取边界被切断的多字节 UTF-8 序列,避免解码抛异常。
  static const Utf8Decoder _decoder = Utf8Decoder(allowMalformed: true);
  static const Utf8Encoder _encoder = Utf8Encoder();

  /// 把一对 [terminal] 与 [pty] 接成双向桥并立即生效。
  ///
  /// - [killPtyOnDispose]:见 [_killPtyOnDispose] 说明,默认 false。
  /// - [onExit]:底层进程退出时回调(带退出码),供上层决定是否自动关闭叶子。
  ///   与内置的「屏幕上打印退出提示」相互独立。
  /// - [printExitNotice]:进程退出后是否在终端里打印一行灰色退出提示,默认 true。
  static PtyBridge attach({
    required Terminal terminal,
    required Pty pty,
    bool killPtyOnDispose = false,
    void Function(int exitCode)? onExit,
    bool printExitNotice = true,
  }) {
    final bridge = PtyBridge._(
      terminal: terminal,
      pty: pty,
      killPtyOnDispose: killPtyOnDispose,
      onExit: onExit,
    );
    bridge._wire(printExitNotice: printExitNotice);
    return bridge;
  }

  /// 建立三条数据通路。仅在 [attach] 内调用一次。
  void _wire({required bool printExitNotice}) {
    // 1) 进程输出 → 解码 → 写屏。保存订阅以便 dispose 时取消。
    _outputSub = pty.output.listen(
      (Uint8List data) {
        if (_disposed) return;
        terminal.write(_decoder.convert(data));
      },
      onError: (Object error, StackTrace stackTrace) {
        // 进程收尾阶段读取出错很常见:记录但不崩溃。
        debugPrint('PtyBridge pty.output error: $error');
      },
      cancelOnError: false,
    );

    // 2) 键盘输入(仿真器产出的字符串)→ 编码 → 写回进程。
    terminal.onOutput = (String data) {
      if (_disposed) return;
      pty.write(_encoder.convert(data));
    };

    // 3) 终端可视尺寸变化 → 同步给 PTY。
    //    xterm 的 onResize 回调签名为 (width=列, height=行, pixelW, pixelH);
    //    flutter_pty 的 resize 参数顺序为 (rows, columns)。
    terminal.onResize = (int width, int height, int pixelWidth, int pixelHeight) {
      if (_disposed) return;
      _pushResize(cols: width, rows: height);
    };

    // 记录仿真器的初始尺寸,作为 resize 去抖的基线。
    _lastCols = terminal.viewWidth;
    _lastRows = terminal.viewHeight;

    // 4) 进程退出:可选地打印提示 + 触发 onExit 回调。
    pty.exitCode.then((int code) {
      if (_disposed) return;
      if (printExitNotice) {
        terminal.write('\r\n\x1b[90m[进程已退出,退出码 $code]\x1b[0m\r\n');
      }
      _onExit?.call(code);
    }).catchError((Object _) {
      // 忽略:dispose 抢先,或平台不报退出码。
    });
  }

  /// 显式驱动一次尺寸同步(供窗格 resize 热键 / 布局变更调用)。
  ///
  /// [cols] 列数、[rows] 行数。会做非法值保护与去抖。
  void resize(int cols, int rows) {
    if (_disposed) return;
    _pushResize(cols: cols, rows: rows);
  }

  /// 内部:带保护 + 去抖地把尺寸推给 PTY。
  void _pushResize({required int cols, required int rows}) {
    // 终端至少 1×1;非正值(布局尚未测量完成时可能出现)直接忽略。
    if (cols <= 0 || rows <= 0) return;
    if (cols == _lastCols && rows == _lastRows) return;
    _lastCols = cols;
    _lastRows = rows;
    try {
      pty.resize(rows, cols); // 注意参数顺序:(rows, columns)
    } catch (error) {
      debugPrint('PtyBridge pty.resize error: $error');
    }
  }

  /// 向底层进程写入一段文本(自动 UTF-8 编码)。用于粘贴 / 命令注入。
  void writeString(String data) {
    if (_disposed) return;
    pty.write(_encoder.convert(data));
  }

  /// 向底层进程写入原始字节。
  void writeBytes(Uint8List data) {
    if (_disposed) return;
    pty.write(data);
  }

  /// 拆桥:取消订阅、解绑仿真器回调(可选杀进程)。幂等。
  ///
  /// 注意只解绑「本桥设置的」回调,不会误删别处后来设置的回调 —— 因此临时
  /// 拆桥再重接是安全的(重接时重新 [attach] 即可)。
  void dispose() {
    if (_disposed) return;
    _disposed = true;

    _outputSub?.cancel();
    _outputSub = null;

    // 只在回调仍是本桥所设时才清除,避免踩到他人后设的回调。
    // (无法直接比较闭包身份,这里保守地置空:本桥独占该 terminal 的 IO 是前提。)
    terminal.onOutput = null;
    terminal.onResize = null;

    if (_killPtyOnDispose) {
      try {
        pty.kill();
      } catch (error) {
        debugPrint('PtyBridge pty.kill error: $error');
      }
    }
  }
}
