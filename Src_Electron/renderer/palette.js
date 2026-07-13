// Palette:命令面板浮层 + 可搜索命令列表。
//
// 设计对照 Windows Terminal 的命令面板(Ctrl+Shift+P / mac Cmd+Shift+P):
//   - 居中浮层:一个搜索输入框 + 一个可过滤的命令列表。
//   - 键盘优先:↑/↓ 移动高亮,Enter 执行,Esc 关闭;打开即聚焦输入框。
//   - swapPane / movePane 这类"低频强力操作"默认没有热键,只能从这里触发——
//     它们在命令目录里标了 paletteOnly,同样出现在列表中并可搜索。
//
// 本模块只管"选中一条命令"这件事:命中后调用 onExecute(command),由集成层去真正
// 执行(调用 PaneCore.swap / move 等)。命令数据默认来自 Keymap.paletteCommands(),
// 也可由调用方注入自定义列表。
//
// DOM 部分依赖 document,仅浏览器可用;纯函数 fuzzyScore / filterCommands 可在 Node 自测。

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // Node / 自测
  }
  if (typeof window !== 'undefined') {
    window.Palette = api; // 浏览器渲染进程
  }
})(this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 模糊匹配:纯函数,便于自测
  // ---------------------------------------------------------------------------
  // 子序列匹配:query 的字符需按顺序出现在 text 中。返回分数(越大越好)或 -1(不匹配)。
  // 加分项:连续命中、词首命中(空格或分隔符之后)、越靠前越好。
  function fuzzyScore(text, query) {
    if (!query) return 0; // 空查询:全部命中(分数相同,保持原序)
    const t = text.toLowerCase();
    const q = query.toLowerCase();
    let ti = 0;
    let qi = 0;
    let score = 0;
    let prevMatched = false;
    while (ti < t.length && qi < q.length) {
      if (t[ti] === q[qi]) {
        score += 1;
        if (prevMatched) score += 3; // 连续命中加分
        const prevCh = ti > 0 ? t[ti - 1] : ' ';
        if (prevCh === ' ' || prevCh === '/' || prevCh === '(' || prevCh === '·') {
          score += 5; // 词首命中加分
        }
        score += Math.max(0, 5 - ti * 0.1); // 越靠前越好(轻微)
        qi++;
        prevMatched = true;
      } else {
        prevMatched = false;
      }
      ti++;
    }
    return qi === q.length ? score : -1;
  }

  // 用命令的 title + category + id 组成可搜索文本,过滤并按分数排序。
  function filterCommands(commands, query) {
    const scored = [];
    for (let i = 0; i < commands.length; i++) {
      const c = commands[i];
      const hay = `${c.title} ${c.category || ''} ${c.id}`;
      const s = fuzzyScore(hay, query || '');
      if (s >= 0) scored.push({ cmd: c, score: s, order: i });
    }
    // 分数降序;同分保持原始顺序(稳定)
    scored.sort((a, b) => (b.score - a.score) || (a.order - b.order));
    return scored.map((x) => x.cmd);
  }

  // ===========================================================================
  // DOM 浮层
  // ===========================================================================
  // createPalette(opts):
  //   opts.commands   命令数组(默认取 window.Keymap.paletteCommands());
  //                   每条:{ id, title, category, hotkey, paletteOnly, args }
  //   opts.onExecute  function(command) 选中并回车/点击后回调
  //   opts.container  浮层挂载父元素(默认 document.body)
  // 返回:{ open, close, toggle, isOpen, setCommands, destroy }
  function createPalette(opts) {
    opts = opts || {};
    if (typeof document === 'undefined') {
      throw new Error('createPalette 需要 DOM 环境');
    }

    let commands = opts.commands || defaultCommands();
    const onExecute = typeof opts.onExecute === 'function' ? opts.onExecute : function () {};
    const container = opts.container || document.body;

    let open = false;
    let filtered = [];
    let activeIndex = 0;

    // ---- 构建 DOM(样式内联,避免依赖外部 CSS)----
    const overlay = document.createElement('div');
    overlay.className = 'cmd-palette-overlay';
    setStyles(overlay, {
      position: 'fixed',
      inset: '0',
      display: 'none',
      alignItems: 'flex-start',
      justifyContent: 'center',
      background: 'rgba(0,0,0,0.35)',
      zIndex: '9999',
    });

    const box = document.createElement('div');
    box.className = 'cmd-palette';
    setStyles(box, {
      marginTop: '12vh',
      width: 'min(680px, 90vw)',
      maxHeight: '60vh',
      display: 'flex',
      flexDirection: 'column',
      background: '#252526',
      color: '#d4d4d4',
      border: '1px solid #3c3c3c',
      borderRadius: '8px',
      boxShadow: '0 12px 48px rgba(0,0,0,0.55)',
      overflow: 'hidden',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      fontSize: '14px',
    });

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cmd-palette-input';
    input.placeholder = '输入命令… / Type a command…';
    input.setAttribute('spellcheck', 'false');
    setStyles(input, {
      boxSizing: 'border-box',
      width: '100%',
      padding: '12px 14px',
      border: 'none',
      borderBottom: '1px solid #3c3c3c',
      background: 'transparent',
      color: '#ffffff',
      fontSize: '15px',
      outline: 'none',
    });

    const list = document.createElement('div');
    list.className = 'cmd-palette-list';
    setStyles(list, {
      overflowY: 'auto',
      flex: '1 1 auto',
    });

    box.appendChild(input);
    box.appendChild(list);
    overlay.appendChild(box);
    container.appendChild(overlay);

    // ---- 渲染列表 ----
    function renderList() {
      filtered = filterCommands(commands, input.value);
      if (activeIndex >= filtered.length) activeIndex = filtered.length - 1;
      if (activeIndex < 0) activeIndex = 0;

      // 清空
      while (list.firstChild) list.removeChild(list.firstChild);

      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = '无匹配命令 / No matching commands';
        setStyles(empty, { padding: '14px', color: '#888' });
        list.appendChild(empty);
        return;
      }

      filtered.forEach((cmd, i) => {
        const row = document.createElement('div');
        row.className = 'cmd-palette-row';
        row.dataset.index = String(i);
        setStyles(row, {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          padding: '9px 14px',
          cursor: 'pointer',
          background: i === activeIndex ? '#094771' : 'transparent',
        });

        const left = document.createElement('div');
        setStyles(left, { display: 'flex', flexDirection: 'column', minWidth: '0' });

        const titleEl = document.createElement('div');
        titleEl.textContent = cmd.title;
        setStyles(titleEl, {
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        });

        const catEl = document.createElement('div');
        // paletteOnly 命令加个小标记,呼应"只能从面板触发"
        catEl.textContent = cmd.category + (cmd.paletteOnly ? ' · 仅面板' : '');
        setStyles(catEl, { fontSize: '11px', color: '#9a9a9a', marginTop: '2px' });

        left.appendChild(titleEl);
        left.appendChild(catEl);

        const hotkeyEl = document.createElement('div');
        hotkeyEl.textContent = cmd.hotkey || '';
        setStyles(hotkeyEl, {
          flex: '0 0 auto',
          fontSize: '12px',
          color: '#b5cea8',
          fontFamily: 'Menlo, Consolas, monospace',
        });

        row.appendChild(left);
        row.appendChild(hotkeyEl);

        row.addEventListener('mousemove', () => {
          if (activeIndex !== i) {
            activeIndex = i;
            renderList();
          }
        });
        row.addEventListener('mousedown', (e) => {
          e.preventDefault(); // 防止输入框失焦
          activeIndex = i;
          execActive();
        });

        list.appendChild(row);
      });

      scrollActiveIntoView();
    }

    function scrollActiveIntoView() {
      const rows = list.querySelectorAll('.cmd-palette-row');
      const el = rows[activeIndex];
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest' });
      }
    }

    function execActive() {
      const cmd = filtered[activeIndex];
      closePalette();
      if (cmd) onExecute(cmd);
    }

    // ---- 打开/关闭 ----
    function openPalette() {
      if (open) return;
      open = true;
      input.value = '';
      activeIndex = 0;
      overlay.style.display = 'flex';
      renderList();
      // 聚焦要等浮层可见
      setTimeout(() => input.focus(), 0);
    }
    function closePalette() {
      if (!open) return;
      open = false;
      overlay.style.display = 'none';
    }
    function togglePalette() {
      if (open) closePalette();
      else openPalette();
    }

    // ---- 事件 ----
    input.addEventListener('input', () => {
      activeIndex = 0;
      renderList();
    });

    input.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          if (filtered.length) {
            activeIndex = (activeIndex + 1) % filtered.length;
            renderList();
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (filtered.length) {
            activeIndex = (activeIndex - 1 + filtered.length) % filtered.length;
            renderList();
          }
          break;
        case 'Enter':
          e.preventDefault();
          execActive();
          break;
        case 'Escape':
          e.preventDefault();
          closePalette();
          break;
        default:
          break;
      }
    });

    // 点击浮层空白处关闭
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) closePalette();
    });

    return {
      open: openPalette,
      close: closePalette,
      toggle: togglePalette,
      isOpen: function () {
        return open;
      },
      setCommands: function (next) {
        commands = next || [];
        if (open) renderList();
      },
      destroy: function () {
        closePalette();
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      },
    };
  }

  // 默认命令来源:Keymap 的面板命令目录(浏览器里 window.Keymap 已加载)
  function defaultCommands() {
    if (typeof window !== 'undefined' && window.Keymap && window.Keymap.paletteCommands) {
      return window.Keymap.paletteCommands();
    }
    return [];
  }

  function setStyles(el, styles) {
    for (const k in styles) {
      if (Object.prototype.hasOwnProperty.call(styles, k)) el.style[k] = styles[k];
    }
  }

  // ---------------------------------------------------------------------------
  // 导出
  // ---------------------------------------------------------------------------
  const Palette = {
    createPalette,
    fuzzyScore,
    filterCommands,
  };

  // ---------------------------------------------------------------------------
  // 自测:node renderer/palette.js(只测纯函数,不碰 DOM)
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

    // 子序列匹配
    assert(fuzzyScore('Split Pane Right', 'spr') > 0, '子序列命中 spr');
    assert(fuzzyScore('Split Pane Right', 'xyz') === -1, '不匹配返回 -1');
    assert(fuzzyScore('anything', '') === 0, '空查询命中');

    // 连续/词首命中应比分散命中得分高
    const contScore = fuzzyScore('Swap Pane', 'swap');
    const scatterScore = fuzzyScore('Show With Alpha Panel', 'swap');
    assert(contScore > scatterScore, '连续词首命中分更高');

    // filterCommands:过滤 + 排序
    const cmds = [
      { id: 'pane.swap.left', title: '与左侧窗格交换 Swap Pane Left', category: '窗格', paletteOnly: true },
      { id: 'pane.split.right', title: '向右拆分窗格 Split Pane Right', category: '窗格' },
      { id: 'pane.close', title: '关闭当前窗格 Close Pane', category: '窗格' },
    ];
    const r1 = filterCommands(cmds, 'swap');
    assert(r1.length === 1 && r1[0].id === 'pane.swap.left', 'swap 只命中交换命令');

    const r2 = filterCommands(cmds, '');
    assert(r2.length === 3, '空查询返回全部');

    const r3 = filterCommands(cmds, 'pane');
    assert(r3.length === 3, 'pane 命中全部(标题/ id 都含)');

    // 可用 id 搜索
    const r4 = filterCommands(cmds, 'split.right');
    assert(r4[0].id === 'pane.split.right', '可按 id 搜索');

    console.log(`Palette self-test: ${passed} passed, ${failed} failed`);
    return failed === 0;
  }

  Palette._selfTest = selfTest;

  if (typeof module !== 'undefined' && module.exports && typeof require !== 'undefined') {
    if (require.main === module) {
      const ok = selfTest();
      if (typeof process !== 'undefined') process.exit(ok ? 0 : 1);
    }
  }

  // ---------------------------------------------------------------------------
  // TODO(集成层,见 index.js):
  //   const palette = Palette.createPalette({
  //     onExecute: (cmd) => dispatch(cmd.id, cmd.args),  // 路由到 PaneCore
  //   });
  //   window.addEventListener('keydown', (ev) => {
  //     if (Keymap.matchEvent(ev) === 'palette.toggle') { ev.preventDefault(); palette.toggle(); }
  //   });
  //   面板选中 swapPane/movePane 时,dispatch 里用 PaneCore.navigate 找方向上的目标叶子,
  //   再调用 PaneCore.swap / PaneCore.move,然后 layout.render()。
  // ---------------------------------------------------------------------------

  return Palette;
});
