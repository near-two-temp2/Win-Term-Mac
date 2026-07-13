// 渲染进程 · IO/Bridge:PTY 与 xterm 之间的双向数据平面。
//
// 职责(本方案的 [io] 功能):
//   1) 键盘输入 → shell:term.onData(用户键入) -> ptyBridge.input(id, data)
//   2) shell 输出 → 终端:主进程推送 pty:data -> term.write(data)
//   3) 窗口/窗格 resize → pty:term 的 cols/rows -> ptyBridge.resize(id, cols, rows)
//   4) 会话退出 → 通知调用方并解绑
//
// 复用已有 PTY 代码:本模块不自建 IPC,完全走 preload.js 暴露的 window.ptyBridge
//   (create / input / resize / kill / onData / onExit),与 main 侧 pty.js 对齐。
//
// 为什么单独成模块(而非沿用 terminal.js 内联搬运):
//   terminal.js 里每个叶子各自 bridge.onData(...) 并用 `id === sessionId` 过滤,
//   N 个窗格时每个 PTY 数据包会被派发到 N 个监听器逐一比较 —— O(N)/包。
//   本模块在整个渲染进程只订阅一次 onData/onExit,用 Map<sessionId, session> 做
//   O(1) 路由,窗格越多优势越明显;同时把"创建/输入/尺寸/退出/回收"收敛成一个
//   带生命周期的 session 句柄。
//
// ── integrator(main / RustRender 无关,此处指 Electron 渲染入口)需要如何调用我 ──
//   在 index.html 里于 pane.js / terminal.js 之前(或之后均可,惰性初始化)引入:
//       <script src="renderer/io.js"></script>
//   然后有两种接入方式,二选一:
//
//   A) 让 terminal.js 的叶子改用本模块搬运数据(推荐,消除 O(N) 过滤):
//        在 createLeafTerminal 内部,不再自己 bridge.onData/create/onData,
//        而是:  const sess = IoBridge.connect(term, { shell, cwd, env, onExit });
//                fit 时调用 sess.syncSize(term);  dispose 时调用 sess.dispose();
//        sess.id 即 PTY 会话 id(异步就绪,connect 立即返回句柄)。
//
//   B) 直接对任意 xterm 实例接线(最小改动):
//        const sess = IoBridge.connect(term);        // 用默认 shell
//        window.addEventListener('resize', () => sess.syncSize(term));
//        // 卸载时:sess.dispose();  应用退出时:IoBridge.disposeAll();
//
//   term 需满足鸭子类型:term.write(data)、term.onData(cb)->{dispose()}、
//   可选 term.cols/term.rows(用于 syncSize)。真实 xterm.js 均满足。
//
// 同一份代码可在浏览器(挂到 window.IoBridge)运行,也可在 Node 下跑自测
//   (node renderer/io.js,使用内置 mock bridge / mock term)。

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // Node / 自测
  }
  if (typeof window !== 'undefined') {
    window.IoBridge = api; // 浏览器渲染进程
  }
})(this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 内部状态:单一订阅 + 会话表
  // ---------------------------------------------------------------------------
  // sessions: sessionId -> Session 实例(已拿到 PTY id 的会话)
  const sessions = new Map();

  let _bridge = null; // 绑定的 ptyBridge(默认 window.ptyBridge)
  let _installed = false; // 是否已安装全局 onData/onExit 派发
  let _offData = null; // 取消订阅函数
  let _offExit = null;

  // 解析要使用的桥接:优先显式 configure 注入的,否则回退 window.ptyBridge
  function resolveBridge() {
    if (_bridge) return _bridge;
    if (typeof window !== 'undefined' && window.ptyBridge) {
      _bridge = window.ptyBridge;
    }
    return _bridge;
  }

  // 安装一次性的全局派发:主进程 pty:data / pty:exit -> 按 id 路由到对应会话。
  // 幂等:重复调用只安装一次。桥接不可用时返回 false。
  function ensureInstalled() {
    if (_installed) return true;
    const bridge = resolveBridge();
    if (!bridge || typeof bridge.onData !== 'function') return false;

    _offData = bridge.onData(function (payload) {
      if (!payload) return;
      const s = sessions.get(payload.id);
      if (s) s._recv(payload.data);
    });
    _offExit = bridge.onExit(function (payload) {
      if (!payload) return;
      const s = sessions.get(payload.id);
      if (s) s._exit(payload.exitCode, payload.signal);
    });
    _installed = true;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Session:一个 PTY 会话与一个 term 的双向绑定 + 生命周期
  // ---------------------------------------------------------------------------
  function Session(term, options) {
    this.term = term;
    this.options = options || {};
    this.id = null; // 尚未创建时为 null;创建成功后为 PTY 会话 id
    this.disposed = false;
    this.exited = false;
    this._cleanups = []; // 解绑回调(term.onData 订阅等)
    this._readyCbs = []; // onReady 回调队列
    this._pendingSize = null; // 会话就绪前收到的 resize,就绪后补发一次
  }

  // 接收 PTY 输出 -> 写入终端(由全局派发调用)
  Session.prototype._recv = function (data) {
    if (this.disposed) return;
    const t = this.term;
    if (t && typeof t.write === 'function') t.write(data);
  };

  // 会话退出 -> 标记并回调;不主动 dispose,留给调用方决定是否保留窗格
  Session.prototype._exit = function (exitCode, signal) {
    if (this.disposed || this.exited) return;
    this.exited = true;
    // 退出后旧 id 不再有效,从路由表摘除,避免 id 复用时误投递
    if (this.id) sessions.delete(this.id);
    if (typeof this.options.onExit === 'function') {
      try {
        this.options.onExit(exitCode, signal);
      } catch (err) {
        /* 忽略回调异常 */
      }
    }
  };

  // 会话就绪后:注册路由、接线键盘输入、补发挂起的尺寸、触发 onReady
  Session.prototype._bindReady = function (id) {
    this.id = id;
    sessions.set(id, this);

    const bridge = resolveBridge();
    const self = this;

    // 键盘输入 -> PTY
    const t = this.term;
    if (t && typeof t.onData === 'function' && bridge && typeof bridge.input === 'function') {
      const sub = t.onData(function (data) {
        if (self.id && !self.disposed) bridge.input(self.id, data);
      });
      // xterm 的 onData 返回 IDisposable;也兼容直接返回函数的情况
      this._cleanups.push(function () {
        if (sub && typeof sub.dispose === 'function') sub.dispose();
        else if (typeof sub === 'function') sub();
      });
    }

    // 补发就绪前的最后一次尺寸,确保 shell 拿到正确 cols/rows
    if (this._pendingSize) {
      this.resize(this._pendingSize.cols, this._pendingSize.rows);
      this._pendingSize = null;
    }

    // 触发 onReady 回调
    const cbs = this._readyCbs.slice();
    this._readyCbs.length = 0;
    for (let i = 0; i < cbs.length; i++) {
      try {
        cbs[i](id);
      } catch (err) {
        /* 忽略 */
      }
    }
  };

  // 会话就绪回调;若已就绪则下一帧/立即触发
  Session.prototype.onReady = function (cb) {
    if (typeof cb !== 'function') return this;
    if (this.id) {
      cb(this.id);
    } else {
      this._readyCbs.push(cb);
    }
    return this;
  };

  Session.prototype.isReady = function () {
    return this.id !== null && !this.disposed;
  };

  // 程序化写入(等价于用户键入),用于粘贴/自动化
  Session.prototype.write = function (data) {
    const bridge = resolveBridge();
    if (this.id && !this.disposed && bridge && typeof bridge.input === 'function') {
      bridge.input(this.id, data);
    }
  };

  // 通知 PTY 调整网格尺寸;会话未就绪时暂存,就绪后补发
  Session.prototype.resize = function (cols, rows) {
    cols = cols | 0;
    rows = rows | 0;
    if (cols <= 0 || rows <= 0) return;
    if (this.disposed) return;
    if (!this.id) {
      this._pendingSize = { cols: cols, rows: rows };
      return;
    }
    const bridge = resolveBridge();
    if (bridge && typeof bridge.resize === 'function') {
      bridge.resize(this.id, cols, rows);
    }
  };

  // 便捷:从 term 读取当前 cols/rows 并同步给 PTY(FitAddon.fit 之后调用)
  Session.prototype.syncSize = function (term) {
    const t = term || this.term;
    if (!t) return;
    this.resize(t.cols, t.rows);
  };

  // 解绑一切并回收 PTY 会话
  Session.prototype.dispose = function () {
    if (this.disposed) return;
    this.disposed = true;
    for (let i = 0; i < this._cleanups.length; i++) {
      try {
        this._cleanups[i]();
      } catch (err) {
        /* 忽略 */
      }
    }
    this._cleanups.length = 0;
    if (this.id) {
      sessions.delete(this.id);
      const bridge = resolveBridge();
      if (bridge && typeof bridge.kill === 'function') bridge.kill(this.id);
      this.id = null;
    }
  };

  // ---------------------------------------------------------------------------
  // 公开 API
  // ---------------------------------------------------------------------------

  // 注入自定义桥接(测试用);不传则使用 window.ptyBridge。返回是否可用。
  function configure(bridge) {
    // 若已安装过旧桥接的派发,先卸载再切换
    if (_installed) {
      if (typeof _offData === 'function') _offData();
      if (typeof _offExit === 'function') _offExit();
      _installed = false;
      _offData = _offExit = null;
    }
    _bridge = bridge || null;
    return ensureInstalled();
  }

  // 桥接是否可用(供调用方决定是否提示用户 rebuild node-pty)
  function isAvailable() {
    const bridge = resolveBridge();
    return !!(bridge && typeof bridge.create === 'function');
  }

  // 把一个 term 连接到新的 PTY 会话,立即返回 Session 句柄(会话异步就绪)。
  //   term     xterm 实例(或鸭子类型:write / onData / cols / rows)
  //   options  { shell, cwd, env, args, term(名), cols, rows, onExit, onError }
  // 会话创建失败时:调用 options.onError(msg)(若提供),句柄保持未就绪。
  function connect(term, options) {
    options = options || {};
    const session = new Session(term, options);
    const bridge = resolveBridge();

    if (!bridge || typeof bridge.create !== 'function') {
      const msg = 'ptyBridge 不可用(请检查 preload.js 与 node-pty)';
      if (typeof options.onError === 'function') options.onError(msg);
      else if (term && typeof term.write === 'function') {
        term.write('\x1b[31m[错误] ' + msg + '\x1b[0m\r\n');
      }
      return session; // 未就绪句柄:后续 resize 会被暂存,dispose 安全
    }

    // 确保全局派发已安装,再创建会话(避免创建后、安装前丢失首包)
    ensureInstalled();

    // 初始尺寸:优先显式 options,其次读 term,兜底 80x24
    const cols = options.cols || (term && term.cols) || 80;
    const rows = options.rows || (term && term.rows) || 24;

    bridge
      .create({
        cols: cols,
        rows: rows,
        shell: options.shell,
        cwd: options.cwd,
        env: options.env,
        args: options.args,
        term: options.term,
      })
      .then(function (res) {
        if (session.disposed) {
          // 句柄在异步返回前已被销毁:立刻回收会话,避免泄漏
          if (res && res.ok && res.id && typeof bridge.kill === 'function') bridge.kill(res.id);
          return;
        }
        if (!res || !res.ok) {
          const msg = (res && res.error) || '未知错误';
          if (typeof options.onError === 'function') options.onError(msg);
          else if (term && typeof term.write === 'function') {
            term.write('\x1b[31m[错误] 无法创建终端会话: ' + msg + '\x1b[0m\r\n');
            term.write('\x1b[90m提示:请先 npm install 并 npm run rebuild 编译 node-pty。\x1b[0m\r\n');
          }
          return;
        }
        session._bindReady(res.id);
      })
      .catch(function (err) {
        if (session.disposed) return;
        const msg = (err && err.message) || String(err);
        if (typeof options.onError === 'function') options.onError(msg);
        else if (term && typeof term.write === 'function') {
          term.write('\x1b[31m[错误] 创建会话异常: ' + msg + '\x1b[0m\r\n');
        }
      });

    return session;
  }

  // 当前活跃会话数(已就绪的)
  function sessionCount() {
    return sessions.size;
  }

  // 回收所有会话(应用退出 / 页面卸载时调用)
  function disposeAll() {
    // 复制一份,避免遍历中 dispose 修改 Map
    const all = [];
    sessions.forEach(function (s) {
      all.push(s);
    });
    for (let i = 0; i < all.length; i++) all[i].dispose();
  }

  const IoBridge = {
    configure: configure,
    isAvailable: isAvailable,
    connect: connect,
    sessionCount: sessionCount,
    disposeAll: disposeAll,
    _sessions: sessions, // 便于调试/自测
  };

  // ---------------------------------------------------------------------------
  // 自测:node renderer/io.js
  // ---------------------------------------------------------------------------
  // 用 mock bridge / mock term 跑通:创建→就绪→输入→输出→resize→退出→dispose。
  function selfTest() {
    let passed = 0;
    let failed = 0;
    function assert(cond, msg) {
      if (cond) passed++;
      else {
        failed++;
        // eslint-disable-next-line no-console
        console.error('  FAIL:', msg);
      }
    }

    // ---- Mock bridge:模拟 preload.js 的 window.ptyBridge ----
    let dataCb = null;
    let exitCb = null;
    let seq = 0;
    const created = []; // 记录 create 调用
    const input = []; // 记录 input 调用
    const resized = []; // 记录 resize 调用
    const killed = []; // 记录 kill 调用

    const mockBridge = {
      create: function (opts) {
        created.push(opts);
        const id = 'sess-' + ++seq;
        // 同步 resolve,便于自测(真实为异步,逻辑不受影响)
        return Promise.resolve({ ok: true, id: id });
      },
      input: function (id, data) {
        input.push({ id: id, data: data });
      },
      resize: function (id, cols, rows) {
        resized.push({ id: id, cols: cols, rows: rows });
      },
      kill: function (id) {
        killed.push(id);
      },
      onData: function (cb) {
        dataCb = cb;
        return function () {
          dataCb = null;
        };
      },
      onExit: function (cb) {
        exitCb = cb;
        return function () {
          exitCb = null;
        };
      },
    };

    // ---- Mock term:模拟 xterm 的鸭子类型 ----
    function makeTerm() {
      const written = [];
      let onDataHandler = null;
      return {
        cols: 80,
        rows: 24,
        written: written,
        write: function (d) {
          written.push(d);
        },
        onData: function (cb) {
          onDataHandler = cb;
          return {
            dispose: function () {
              onDataHandler = null;
            },
          };
        },
        // 测试辅助:模拟用户键入
        _type: function (d) {
          if (onDataHandler) onDataHandler(d);
        },
        _hasHandler: function () {
          return onDataHandler !== null;
        },
      };
    }

    // 注入 mock 桥接
    assert(configure(mockBridge) === true, 'configure 安装成功');
    assert(isAvailable() === true, 'isAvailable 为真');
    assert(typeof dataCb === 'function' && typeof exitCb === 'function', '全局派发已订阅');

    // 连接一个会话
    const term = makeTerm();
    const sess = connect(term, { shell: '/bin/sh' });
    assert(created.length === 1, 'create 被调用一次');
    assert(created[0].cols === 80 && created[0].rows === 24, '初始尺寸取自 term');
    assert(sess.isReady() === false, '同步阶段尚未就绪');

    // 就绪前 resize 应被暂存
    sess.resize(100, 30);
    assert(resized.length === 0, '未就绪时 resize 暂存,不立即下发');

    // 等待 Promise 微任务队列 flush,再断言就绪后的行为
    return Promise.resolve()
      .then(function () {
        // 微任务:create().then 已执行 _bindReady
        assert(sess.isReady() === true, '会话已就绪');
        assert(sess.id === 'sess-1', 'id 正确');
        assert(sessionCount() === 1, '活跃会话计数为 1');
        assert(term._hasHandler(), '键盘输入已接线');
        // 暂存的尺寸应在就绪后补发
        assert(
          resized.length === 1 && resized[0].cols === 100 && resized[0].rows === 30,
          '就绪后补发暂存尺寸'
        );

        // 输出:PTY -> term
        dataCb({ id: 'sess-1', data: 'hello' });
        assert(term.written.indexOf('hello') >= 0, 'PTY 输出写入 term');
        // 非本会话 id 的数据不应写入
        dataCb({ id: 'other', data: 'nope' });
        assert(term.written.indexOf('nope') < 0, '异会话数据被忽略(O(1) 路由正确)');

        // 输入:用户键入 -> PTY
        term._type('ls\r');
        assert(
          input.length === 1 && input[0].id === 'sess-1' && input[0].data === 'ls\r',
          '键盘输入转发到 PTY'
        );

        // syncSize:从 term 读取尺寸下发
        term.cols = 120;
        term.rows = 40;
        sess.syncSize(term);
        assert(
          resized.length === 2 && resized[1].cols === 120 && resized[1].rows === 40,
          'syncSize 下发 term 当前尺寸'
        );

        // resize 非法值忽略
        sess.resize(0, 0);
        assert(resized.length === 2, '非法尺寸被忽略');

        // 退出:onExit 回调触发,并从路由表摘除
        let exitCode = null;
        sess.options.onExit = function (code) {
          exitCode = code;
        };
        exitCb({ id: 'sess-1', exitCode: 0 });
        assert(exitCode === 0, 'onExit 回调收到退出码');
        assert(sessionCount() === 0, '退出后从路由表摘除');
        assert(sess.exited === true, '会话标记为已退出');

        // dispose 幂等且安全
        sess.dispose();
        sess.dispose();
        assert(sess.disposed === true, 'dispose 后标记');

        // dispose 前就退出的会话不会重复 kill;测试"就绪后 dispose 触发 kill"
        const term2 = makeTerm();
        const sess2 = connect(term2, {});
        return Promise.resolve().then(function () {
          assert(sess2.isReady(), '第二个会话就绪');
          const idBefore = sess2.id;
          sess2.dispose();
          assert(killed.indexOf(idBefore) >= 0, 'dispose 回收 PTY 会话');
          assert(sessionCount() === 0, 'dispose 后无活跃会话');

          // disposeAll 覆盖
          connect(makeTerm(), {});
          connect(makeTerm(), {});
          return Promise.resolve().then(function () {
            assert(sessionCount() === 2, '两个新会话就绪');
            disposeAll();
            assert(sessionCount() === 0, 'disposeAll 清空');

            // eslint-disable-next-line no-console
            console.log('IoBridge self-test: ' + passed + ' passed, ' + failed + ' failed');
            return failed === 0;
          });
        });
      });
  }

  IoBridge._selfTest = selfTest;

  if (typeof module !== 'undefined' && module.exports && typeof require !== 'undefined') {
    if (require.main === module) {
      selfTest().then(function (ok) {
        if (typeof process !== 'undefined') process.exit(ok ? 0 : 1);
      });
    }
  }

  return IoBridge;
});
