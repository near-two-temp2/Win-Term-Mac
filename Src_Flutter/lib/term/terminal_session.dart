// Win-Term-Mac / Src_Flutter 方案 ——【Terminal】角色。
//
// 本文件负责“单个真实终端”这一最小单元:用 xterm.dart 的 [Terminal] 做 VT 仿真 +
// 渲染,用 flutter_pty 的 [Pty] 起一个真实 shell 进程,并把两者双向连通:
//   PTY --输出字节--> Terminal.write(解码后的文本)  (进程 → 屏幕)
//   Terminal.onOutput(用户键入) --> Pty.write(编码后的字节) (键盘 → 进程)
//   Terminal.onResize --> Pty.resize  (窗口尺寸变化同步给 PTY)
//
// 在窗格二叉树里,每个“叶子(leaf)”就对应一个 [TerminalSession];
// 分裂/交换/移动等操作只搬动叶子,不销毁其底层进程,因此本类被设计成
// 可长期持有、可反复嵌入到不同位置的 UI 中。

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_pty/flutter_pty.dart';
import 'package:xterm/xterm.dart';

/// 一个终端会话:xterm 仿真器 + 底层 PTY shell 进程的组合体。
///
/// 典型用法:
/// ```dart
/// final session = TerminalSession.start();
/// // ... 把 session 放进窗格树的某个叶子 ...
/// EmbeddedTerminalView(session: session); // 嵌入 UI
/// // ... 不再需要时:
/// session.dispose();
/// ```
///
/// 生命周期由持有者(窗格树)负责:创建时 [start],彻底移除叶子时 [dispose]。
class TerminalSession {
  TerminalSession._({
    required this.terminal,
    required this.pty,
    required this.shellCommand,
  });

  /// xterm.dart 的仿真器实例,也是渲染 [TerminalView] 时要传入的对象。
  final Terminal terminal;

  /// 底层 PTY(伪终端)进程句柄。
  final Pty pty;

  /// 实际启动的 shell 可执行文件路径(便于日志/调试)。
  final String shellCommand;

  /// 会话是否已被释放(避免重复 dispose 或释放后误用)。
  bool _disposed = false;
  bool get isDisposed => _disposed;

  /// 进程退出码的 Future(进程结束后完成)。用于外层决定是否自动关闭叶子。
  Future<int> get exitCode => pty.exitCode;

  /// 启动一个新的终端会话。
  ///
  /// - [shell]:要启动的可执行文件;为空时按平台自动挑选默认 shell。
  /// - [arguments]:传给 shell 的参数。
  /// - [workingDirectory]:进程工作目录;为空则继承当前进程。
  /// - [environment]:附加/覆盖的环境变量(会与 [Platform.environment] 合并)。
  /// - [columns] / [rows]:初始终端尺寸(列数/行数)。真实尺寸随后由
  ///   [Terminal.onResize] 驱动同步,这里只是启动时的初值。
  /// - [maxLines]:xterm 回滚缓冲的最大行数。
  factory TerminalSession.start({
    String? shell,
    List<String> arguments = const [],
    String? workingDirectory,
    Map<String, String>? environment,
    int columns = 80,
    int rows = 24,
    int maxLines = 10000,
  }) {
    final terminal = Terminal(maxLines: maxLines);

    final resolvedShell = shell ?? _defaultShell();
    final resolvedEnv = <String, String>{
      ...Platform.environment,
      // 让程序知道自己跑在支持真彩色的终端里。
      'TERM': 'xterm-256color',
      if (environment != null) ...environment,
    };

    final pty = Pty.start(
      resolvedShell,
      arguments: arguments,
      environment: resolvedEnv,
      workingDirectory: workingDirectory ?? _defaultWorkingDirectory(),
      columns: columns,
      rows: rows,
    );

    final session = TerminalSession._(
      terminal: terminal,
      pty: pty,
      shellCommand: resolvedShell,
    );
    session._wire();
    return session;
  }

  /// 把 PTY 与 Terminal 双向接线。只应被调用一次(在 [start] 内)。
  void _wire() {
    // 进程输出(字节流)→ 解码为文本 → 写进仿真器。
    // 用 allowMalformed 容忍跨读取边界被切断的多字节 UTF-8 序列,避免抛异常。
    const decoder = Utf8Decoder(allowMalformed: true);
    pty.output.listen(
      (Uint8List data) {
        if (_disposed) return;
        terminal.write(decoder.convert(data));
      },
      onError: (Object error, StackTrace stackTrace) {
        // PTY 读取出错(通常发生在进程收尾阶段),记录但不崩溃。
        debugPrint('TerminalSession pty.output error: $error');
      },
      cancelOnError: false,
    );

    // 用户键入(仿真器产生的字符串)→ 编码为字节 → 写回进程。
    terminal.onOutput = (String data) {
      if (_disposed) return;
      pty.write(const Utf8Encoder().convert(data));
    };

    // 终端可视尺寸变化 → 同步给 PTY,让 shell/程序拿到正确的 winsize。
    terminal.onResize = (int width, int height, int pixelWidth, int pixelHeight) {
      if (_disposed) return;
      // flutter_pty 的 resize 参数顺序为 (rows, columns)。
      pty.resize(height, width);
    };

    // 进程退出后,在仿真器里给出可见提示(而不是留一个静默死掉的黑框)。
    pty.exitCode.then((int code) {
      if (_disposed) return;
      terminal.write('\r\n\x1b[90m[进程已退出,退出码 $code]\x1b[0m\r\n');
    }).catchError((Object _) {
      // 忽略:dispose 抢先或平台不报退出码的情况。
    });
  }

  /// 手动向底层进程写入原始字节(例如注入命令、粘贴)。
  void writeBytes(Uint8List data) {
    if (_disposed) return;
    pty.write(data);
  }

  /// 手动向底层进程写入一段文本(自动 UTF-8 编码)。
  void writeString(String data) {
    if (_disposed) return;
    pty.write(const Utf8Encoder().convert(data));
  }

  /// 释放会话:杀掉进程并标记为已释放。
  ///
  /// 幂等:重复调用无副作用。窗格树彻底删除某个叶子时调用。
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    // 解除仿真器回调,避免释放后仍向已死进程写入。
    terminal.onOutput = null;
    terminal.onResize = null;
    try {
      pty.kill();
    } catch (error) {
      debugPrint('TerminalSession pty.kill error: $error');
    }
  }

  /// 按平台挑选一个合理的默认 shell。
  static String _defaultShell() {
    if (Platform.isWindows) {
      // 优先 PowerShell(与 WT 默认一致),回退到 COMSPEC/cmd.exe。
      final env = Platform.environment;
      return env['COMSPEC'] ?? 'powershell.exe';
    }
    // macOS / Linux:尊重用户的 $SHELL,回退到 /bin/bash。
    return Platform.environment['SHELL'] ?? '/bin/bash';
  }

  /// 默认工作目录:用户主目录(拿不到则让 PTY 用进程默认目录)。
  static String? _defaultWorkingDirectory() {
    final env = Platform.environment;
    return env['HOME'] ?? env['USERPROFILE'];
  }
}

/// 可嵌入的终端视图封装。
///
/// 对外只暴露一个 [TerminalSession],内部渲染 xterm.dart 的 [TerminalView]。
/// 窗格树把它塞进任意叶子位置即可;它不持有会话生命周期(不在 dispose 时杀进程),
/// 因为同一个会话可能在移动/交换过程中被从一处卸载、再挂到另一处。
class EmbeddedTerminalView extends StatelessWidget {
  const EmbeddedTerminalView({
    super.key,
    required this.session,
    this.autofocus = false,
    this.padding = const EdgeInsets.all(4),
    this.backgroundOpacity = 1.0,
    this.theme,
  });

  /// 要渲染的终端会话。
  final TerminalSession session;

  /// 是否在挂载时自动抢占键盘焦点。
  ///
  /// 注意:窗格导航(Alt/⌥+方向键切焦点)应由上层焦点管理器统一控制,
  /// 这里的 autofocus 只用于“首次只有一个窗格”这类简单场景。
  final bool autofocus;

  /// 视图内边距。
  final EdgeInsets padding;

  /// 背景不透明度(接近 WT 的 acrylic/透明背景时可调低)。
  final double backgroundOpacity;

  /// 终端配色主题;为空时用 xterm 默认。
  final TerminalTheme? theme;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: padding,
      child: TerminalView(
        session.terminal,
        autofocus: autofocus,
        backgroundOpacity: backgroundOpacity,
        theme: theme ?? TerminalThemes.defaultTheme,
        // TODO(集成): 焦点、右键菜单、粘贴、超链接点击等交互接线,
        // 由上层窗格/焦点管理器统一注入(避免每个叶子各自为政)。
      ),
    );
  }
}
