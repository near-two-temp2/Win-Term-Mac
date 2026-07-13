// Keymap:Windows Terminal 键位 → 命令。
//
// 设计对照 Windows Terminal 的默认键位与"设计哲学":
//   - 高频操作给热键:拆分(Alt+Shift+ +/-)、切焦点(Alt+方向键)、调整大小(Alt+Shift+方向键)。
//   - 低频强力操作(交换/移动)不给热键,只通过命令面板触发(paletteOnly)。
//   - 命令面板:Ctrl+Shift+P;macOS 上 Ctrl 换成 Cmd(见 useCmd)。
//
// 本模块只做两件事:
//   1) 维护一份"命令目录"COMMANDS(id / 标题 / 热键描述 / 是否入面板 / 是否仅面板)。
//      命令面板(palette.js)直接消费这份目录来渲染可搜索列表。
//   2) 把键盘事件(KeyboardEvent 或等价的普通对象)匹配成命令 id(matchEvent)。
//
// 本模块不执行命令,只负责"事件 → 命令 id"的翻译;真正的动作绑定由集成层完成
// (见文件末尾 TODO 与 index.js)。同一份代码可在浏览器与 Node 自测下运行。

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // Node / 自测
  }
  if (typeof window !== 'undefined') {
    window.Keymap = api; // 浏览器渲染进程
  }
})(this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 平台检测:macOS 上把 Ctrl 换成 Cmd(meta)
  // ---------------------------------------------------------------------------
  function detectMac() {
    if (typeof navigator !== 'undefined' && navigator.platform) {
      return /Mac|iPhone|iPad/i.test(navigator.platform);
    }
    if (typeof process !== 'undefined' && process.platform) {
      return process.platform === 'darwin';
    }
    return false;
  }
  const IS_MAC = detectMac();

  // 主修饰键:WT 里写 Ctrl 的地方,mac 上用 Cmd(meta)。
  // binding.primary === true 表示"需要主修饰键":非 mac 判断 ctrlKey,mac 判断 metaKey。
  const PRIMARY = IS_MAC ? 'meta' : 'ctrl';

  // ---------------------------------------------------------------------------
  // 命令目录
  // ---------------------------------------------------------------------------
  // 每条命令:
  //   id         命令唯一标识(英文,供集成层 dispatch)
  //   title      命令面板中显示的标题
  //   category   分组标签(仅用于展示/过滤)
  //   binding    热键描述(null = 无热键);见 matchEvent 的匹配规则
  //   inPalette  是否出现在命令面板列表(默认 true)
  //   paletteOnly true = 只能从面板触发(交换/移动这类低频强力操作)
  //   args       预置参数(如方向),集成层执行时透传
  //
  // binding 字段:
  //   primary  需要主修饰键(Ctrl / mac 上 Cmd)
  //   alt      需要 Alt(mac 上为 Option)
  //   shift    需要 Shift
  //   key      归一化后的按键名(见 normalizeKey):
  //            'p' 'w' 'ArrowLeft' 'ArrowRight' 'ArrowUp' 'ArrowDown' 'Plus' 'Minus'
  function binding(opts) {
    return {
      primary: !!opts.primary,
      alt: !!opts.alt,
      shift: !!opts.shift,
      key: opts.key,
    };
  }

  const COMMANDS = [
    // ---- 命令面板本体 ----
    {
      id: 'palette.toggle',
      title: '命令面板 / Command Palette',
      category: '通用',
      // WT: Ctrl+Shift+P;mac: Cmd+Shift+P
      binding: binding({ primary: true, shift: true, key: 'p' }),
      inPalette: false, // 面板已开着时不必再列它
    },

    // ---- 拆分(高频热键)----
    {
      id: 'pane.split.right',
      title: '向右拆分窗格 / Split Pane Right',
      category: '窗格',
      // WT: Alt+Shift+ +(加号)
      binding: binding({ alt: true, shift: true, key: 'Plus' }),
      args: { orientation: 'row', newSide: 'second' },
    },
    {
      id: 'pane.split.down',
      title: '向下拆分窗格 / Split Pane Down',
      category: '窗格',
      // WT: Alt+Shift+ -(减号)
      binding: binding({ alt: true, shift: true, key: 'Minus' }),
      args: { orientation: 'column', newSide: 'second' },
    },

    // ---- 切焦点(高频热键,Alt+方向键)----
    {
      id: 'pane.focus.left',
      title: '焦点移到左侧窗格 / Focus Pane Left',
      category: '窗格',
      binding: binding({ alt: true, key: 'ArrowLeft' }),
      args: { direction: 'left' },
    },
    {
      id: 'pane.focus.right',
      title: '焦点移到右侧窗格 / Focus Pane Right',
      category: '窗格',
      binding: binding({ alt: true, key: 'ArrowRight' }),
      args: { direction: 'right' },
    },
    {
      id: 'pane.focus.up',
      title: '焦点移到上方窗格 / Focus Pane Up',
      category: '窗格',
      binding: binding({ alt: true, key: 'ArrowUp' }),
      args: { direction: 'up' },
    },
    {
      id: 'pane.focus.down',
      title: '焦点移到下方窗格 / Focus Pane Down',
      category: '窗格',
      binding: binding({ alt: true, key: 'ArrowDown' }),
      args: { direction: 'down' },
    },

    // ---- 调整大小(高频热键,Alt+Shift+方向键)----
    {
      id: 'pane.resize.left',
      title: '缩小/左移分隔 / Resize Pane Left',
      category: '窗格',
      binding: binding({ alt: true, shift: true, key: 'ArrowLeft' }),
      args: { direction: 'left' },
    },
    {
      id: 'pane.resize.right',
      title: '放大/右移分隔 / Resize Pane Right',
      category: '窗格',
      binding: binding({ alt: true, shift: true, key: 'ArrowRight' }),
      args: { direction: 'right' },
    },
    {
      id: 'pane.resize.up',
      title: '缩小/上移分隔 / Resize Pane Up',
      category: '窗格',
      binding: binding({ alt: true, shift: true, key: 'ArrowUp' }),
      args: { direction: 'up' },
    },
    {
      id: 'pane.resize.down',
      title: '放大/下移分隔 / Resize Pane Down',
      category: '窗格',
      binding: binding({ alt: true, shift: true, key: 'ArrowDown' }),
      args: { direction: 'down' },
    },

    // ---- 关闭窗格(热键)----
    {
      id: 'pane.close',
      title: '关闭当前窗格 / Close Pane',
      category: '窗格',
      // WT: Ctrl+Shift+W;mac: Cmd+Shift+W
      binding: binding({ primary: true, shift: true, key: 'w' }),
    },

    // ---- 低频强力操作:仅命令面板触发(无热键)----
    {
      id: 'pane.swap.left',
      title: '与左侧窗格交换 / Swap Pane Left',
      category: '窗格(面板)',
      // WT 的 swapPane 默认无热键
      binding: null,
      paletteOnly: true,
      args: { direction: 'left' },
    },
    {
      id: 'pane.swap.right',
      title: '与右侧窗格交换 / Swap Pane Right',
      category: '窗格(面板)',
      binding: null,
      paletteOnly: true,
      args: { direction: 'right' },
    },
    {
      id: 'pane.swap.up',
      title: '与上方窗格交换 / Swap Pane Up',
      category: '窗格(面板)',
      binding: null,
      paletteOnly: true,
      args: { direction: 'up' },
    },
    {
      id: 'pane.swap.down',
      title: '与下方窗格交换 / Swap Pane Down',
      category: '窗格(面板)',
      binding: null,
      paletteOnly: true,
      args: { direction: 'down' },
    },
    {
      id: 'pane.move.left',
      title: '移动窗格到左侧 / Move Pane Left',
      category: '窗格(面板)',
      binding: null,
      paletteOnly: true,
      args: { direction: 'left' },
    },
    {
      id: 'pane.move.right',
      title: '移动窗格到右侧 / Move Pane Right',
      category: '窗格(面板)',
      binding: null,
      paletteOnly: true,
      args: { direction: 'right' },
    },
    {
      id: 'pane.move.up',
      title: '移动窗格到上方 / Move Pane Up',
      category: '窗格(面板)',
      binding: null,
      paletteOnly: true,
      args: { direction: 'up' },
    },
    {
      id: 'pane.move.down',
      title: '移动窗格到下方 / Move Pane Down',
      category: '窗格(面板)',
      binding: null,
      paletteOnly: true,
      args: { direction: 'down' },
    },

    // ---- 最大化/还原:面板触发 ----
    {
      id: 'pane.maximize.toggle',
      title: '最大化 / 还原窗格 / Toggle Zoom Pane',
      category: '窗格(面板)',
      binding: null,
      paletteOnly: true,
    },
  ];

  // 快速索引:id → command
  const COMMAND_BY_ID = {};
  COMMANDS.forEach((c) => {
    COMMAND_BY_ID[c.id] = c;
  });

  // ---------------------------------------------------------------------------
  // 按键归一化:把 KeyboardEvent.key / .code 统一成 binding.key 使用的名字
  // ---------------------------------------------------------------------------
  // 加号/减号在不同布局与 Shift 状态下 event.key 可能是 '+'/'='、'-'/'_' 等,
  // 因此优先用 event.code(物理键位)判定,再回退到 event.key。
  function normalizeKey(ev) {
    const code = ev.code || '';
    const key = ev.key || '';

    // 方向键
    if (key === 'ArrowLeft' || code === 'ArrowLeft') return 'ArrowLeft';
    if (key === 'ArrowRight' || code === 'ArrowRight') return 'ArrowRight';
    if (key === 'ArrowUp' || code === 'ArrowUp') return 'ArrowUp';
    if (key === 'ArrowDown' || code === 'ArrowDown') return 'ArrowDown';

    // 加号:主键盘 '=' 键(Shift 后为 '+')或小键盘 '+'
    if (key === '+' || key === '=' || code === 'Equal' || code === 'NumpadAdd') {
      return 'Plus';
    }
    // 减号:主键盘 '-' 键或小键盘 '-'
    if (key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract') {
      return 'Minus';
    }

    // 字母:统一小写
    if (key && key.length === 1) return key.toLowerCase();
    // 回退到 code 里的字母(KeyP → p)
    const m = /^Key([A-Z])$/.exec(code);
    if (m) return m[1].toLowerCase();

    return key;
  }

  // ---------------------------------------------------------------------------
  // matchEvent:把键盘事件匹配成命令 id;无匹配返回 null
  // ---------------------------------------------------------------------------
  // 只匹配拥有 binding 且非 paletteOnly 的命令。
  function matchEvent(ev) {
    const primaryDown = PRIMARY === 'meta' ? !!ev.metaKey : !!ev.ctrlKey;
    // 非主修饰键的另一个(mac 上 ctrl,非 mac 上 meta):要求"不按下",避免误触
    const otherDown = PRIMARY === 'meta' ? !!ev.ctrlKey : !!ev.metaKey;
    const altDown = !!ev.altKey;
    const shiftDown = !!ev.shiftKey;
    const key = normalizeKey(ev);

    for (let i = 0; i < COMMANDS.length; i++) {
      const cmd = COMMANDS[i];
      const b = cmd.binding;
      if (!b || cmd.paletteOnly) continue;
      if (b.key !== key) continue;
      if (b.primary !== primaryDown) continue;
      if (b.alt !== altDown) continue;
      if (b.shift !== shiftDown) continue;
      // 需要主修饰键时,另一修饰键不能被按下;不需要主修饰键时,两者都不能按
      if (b.primary) {
        if (otherDown) continue;
      } else {
        if (primaryDown || otherDown) continue;
      }
      return cmd.id;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // 热键的人类可读描述(供命令面板右侧显示 "Alt+Shift++" 之类)
  // ---------------------------------------------------------------------------
  function describeBinding(b) {
    if (!b) return '';
    const parts = [];
    if (b.primary) parts.push(IS_MAC ? 'Cmd' : 'Ctrl');
    if (b.alt) parts.push(IS_MAC ? 'Option' : 'Alt');
    if (b.shift) parts.push('Shift');
    parts.push(keyLabel(b.key));
    return parts.join('+');
  }

  function keyLabel(key) {
    switch (key) {
      case 'ArrowLeft':
        return '←';
      case 'ArrowRight':
        return '→';
      case 'ArrowUp':
        return '↑';
      case 'ArrowDown':
        return '↓';
      case 'Plus':
        return '+';
      case 'Minus':
        return '-';
      default:
        return key ? key.toUpperCase() : '';
    }
  }

  // 面板要显示的命令(inPalette !== false)
  function paletteCommands() {
    return COMMANDS.filter((c) => c.inPalette !== false).map((c) => ({
      id: c.id,
      title: c.title,
      category: c.category || '',
      hotkey: describeBinding(c.binding),
      paletteOnly: !!c.paletteOnly,
      args: c.args || null,
    }));
  }

  // ---------------------------------------------------------------------------
  // 导出
  // ---------------------------------------------------------------------------
  const Keymap = {
    IS_MAC,
    PRIMARY,
    COMMANDS,
    COMMAND_BY_ID,
    matchEvent,
    normalizeKey,
    describeBinding,
    keyLabel,
    paletteCommands,
    getCommand: function (id) {
      return COMMAND_BY_ID[id] || null;
    },
  };

  // ---------------------------------------------------------------------------
  // 自测:node renderer/keymap.js
  // ---------------------------------------------------------------------------
  function selfTest() {
    let passed = 0;
    let failed = 0;
    function assert(cond, msg) {
      if (cond) passed++;
      else {
        failed++;
        console.error('  FAIL:', msg);
      }
    }
    // 构造事件:非 mac 语义(primary = ctrl)。为让测试稳定,直接按 PRIMARY 造修饰键。
    function ev(o) {
      const e = {
        ctrlKey: false,
        metaKey: false,
        altKey: !!o.alt,
        shiftKey: !!o.shift,
        key: o.key || '',
        code: o.code || '',
      };
      if (o.primary) {
        if (PRIMARY === 'meta') e.metaKey = true;
        else e.ctrlKey = true;
      }
      return e;
    }

    // 命令面板
    assert(matchEvent(ev({ primary: true, shift: true, key: 'p' })) === 'palette.toggle', '面板热键');

    // 拆分:用 code 判定加减号
    assert(
      matchEvent(ev({ alt: true, shift: true, key: '+', code: 'Equal' })) === 'pane.split.right',
      '右拆分 Alt+Shift++'
    );
    assert(
      matchEvent(ev({ alt: true, shift: true, key: '_', code: 'Minus' })) === 'pane.split.down',
      '下拆分 Alt+Shift+-'
    );

    // 切焦点:Alt+方向键
    assert(matchEvent(ev({ alt: true, key: 'ArrowLeft' })) === 'pane.focus.left', '焦点左');
    assert(matchEvent(ev({ alt: true, key: 'ArrowDown' })) === 'pane.focus.down', '焦点下');

    // 调整大小:Alt+Shift+方向键(注意不能被误判成切焦点)
    assert(
      matchEvent(ev({ alt: true, shift: true, key: 'ArrowRight' })) === 'pane.resize.right',
      '调整大小右'
    );
    assert(matchEvent(ev({ alt: true, key: 'ArrowRight' })) === 'pane.focus.right', '无 Shift 是切焦点');

    // 关闭
    assert(matchEvent(ev({ primary: true, shift: true, key: 'w' })) === 'pane.close', '关闭窗格');

    // 无匹配
    assert(matchEvent(ev({ key: 'a' })) === null, '普通键无匹配');
    assert(matchEvent(ev({ primary: true, key: 'p' })) === null, '缺 Shift 不匹配面板');

    // paletteOnly 命令没有热键、不参与 matchEvent
    assert(Keymap.getCommand('pane.swap.left').binding === null, 'swap 无热键');
    assert(Keymap.getCommand('pane.move.up').paletteOnly === true, 'move 仅面板');

    // 面板列表包含 swap/move,但不含 palette.toggle 自身
    const pal = paletteCommands();
    const ids = pal.map((c) => c.id);
    assert(ids.indexOf('pane.swap.left') >= 0, '面板含 swap');
    assert(ids.indexOf('pane.move.down') >= 0, '面板含 move');
    assert(ids.indexOf('palette.toggle') < 0, '面板不含自身');

    // describeBinding
    const desc = describeBinding(Keymap.getCommand('pane.split.right').binding);
    assert(/\+$/.test(desc) && /Shift/.test(desc), '拆分热键描述以 + 结尾且含 Shift:' + desc);

    console.log(`Keymap self-test: ${passed} passed, ${failed} failed (IS_MAC=${IS_MAC})`);
    return failed === 0;
  }

  Keymap._selfTest = selfTest;

  if (typeof module !== 'undefined' && module.exports && typeof require !== 'undefined') {
    if (require.main === module) {
      const ok = selfTest();
      if (typeof process !== 'undefined') process.exit(ok ? 0 : 1);
    }
  }

  // ---------------------------------------------------------------------------
  // TODO(集成层,见 index.js):
  //   在渲染进程 window 上安装 keydown 监听:
  //     const id = Keymap.matchEvent(ev);
  //     if (id) { ev.preventDefault(); dispatch(id, Keymap.getCommand(id).args); }
  //   dispatch 根据 id 前缀路由到 PaneCore:
  //     pane.split.*  → PaneCore.split(...)   pane.focus.*  → PaneCore.navigate(...)
  //     pane.resize.* → 调整所在 split 的 ratio  pane.close   → PaneCore.detach(...)
  //     palette.toggle→ Palette.toggle()
  //   swap/move/maximize 这类 paletteOnly 命令不在 keydown 里处理,只由面板执行回调触发。
  // ---------------------------------------------------------------------------

  return Keymap;
});
