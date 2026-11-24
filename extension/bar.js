// Injected into Luna as a dynamically registered content script.
// Deliberately plain: MV3 content scripts are not modules, so this file must
// stay import-free. The few view rules it shares with catalog.js (filtering)
// are mirrored here; the worker computes everything else the bar needs.
(() => {
  const host = document.createElement('aside');
  host.dataset.sshpad = '';
  host.setAttribute('aria-label', 'SSH 命令面板');
  // Open, so the bar can be inspected in devtools when someone reports a
  // JumpServer version that renders it wrong.
  const shadow = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host {
      all: initial; display: block; flex: 0 0 auto; min-width: 0; position: relative;
      color-scheme: dark;
      /* Design tokens. Luna's terminal chrome is near-black; --bg also adopts
         Luna's adjacent footer colour at runtime when it is an opaque dark tone. */
      --bg: #141920;
      --sunken: #0e1218;
      --line: #2a3442;
      --line-soft: #232c38;
      --text: #e6edf6;
      --muted: #8fa2b8;
      --btn: #212a36;
      --btn-line: #3d4d61;
      --accent: #6aa4ee;
      --danger: #ff9ca0;
      --warn: #e0a34a;
      --ok: #7fb98f;
      --busy: #9fc6f5;
      color: var(--text); background: var(--bg);
      border-top: 1px solid var(--line); font: 12px/1.4 system-ui, -apple-system, sans-serif;
    }
    :host([data-floating]) { position: fixed; bottom: 0; inset-inline: 0; z-index: 1000; }
    [hidden] { display: none !important; }

    .search {
      flex: 0 1 170px; min-width: 0; font: inherit; color: inherit;
      padding: 2px 7px; border-radius: 4px; border: 1px solid var(--line-soft);
      background: var(--sunken); -webkit-appearance: none; appearance: none;
    }
    .search:focus { border-color: var(--accent); }
    .search:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

    .bar { display: flex; align-items: flex-start; gap: 4px; }
    .groups {
      display: flex; flex: 1 1 auto; flex-wrap: wrap; gap: 4px 6px; min-width: 0;
      max-height: 35vh; overflow: auto; padding: 4px 0 5px 8px;
      align-content: flex-start;
    }
    .group { display: contents; }
    /* display:contents lets the buttons pack tightly across lines while the
       group label stays glued to the group's first button. Groups are separated
       by space, not a rule: against coloured buttons a hairline reads as an
       artefact rather than as structure. */
    .group-start {
      display: inline-flex; align-items: center; max-width: 100%; min-width: 0;
      margin-inline-start: 12px; gap: 4px;
    }
    .group:first-child > .group-start { margin-inline-start: 0; }
    .command { max-width: 100%; min-width: 0; }

    button {
      font: inherit; padding: 3px 8px; color: inherit; cursor: pointer; position: relative;
      border: 1px solid var(--btn-line); background: var(--btn); border-radius: 4px;
      white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis;
      transition: filter .12s, border-color .12s, box-shadow .12s;
    }
    /* Colour presets. The dark values are the original palette. */
    button[data-color="blue"] { --button-bg: #184575; --button-border: #669de6; }
    button[data-color="green"] { --button-bg: #124c3c; --button-border: #63cba0; }
    button[data-color="amber"] { --button-bg: #513916; --button-border: #efbd68; }
    button[data-color="purple"] { --button-bg: #43285f; --button-border: #ba99e8; }
    button[data-color="red"] { --button-bg: #7d222b; --button-border: #ff9ca0; --button-fg: #fff3f4; }
    button[data-color] { background: var(--button-bg, var(--btn)); border-color: var(--button-border, var(--btn-line)); color: var(--button-fg, inherit); }
    button:enabled:hover { filter: brightness(1.12) saturate(1.1); }
    button:disabled { opacity: .5; cursor: default; }

    /* Left accent rather than a glyph: even a pseudo-element's text joins the
       accessible name, which would corrupt the button label. */
    button[data-credential] { box-shadow: inset 2px 0 0 var(--warn); padding-inline-start: 7px; }

    /* A credential shortcut asks for a second click: pulse the ring and drain a
       bar along the bottom edge so the 4 second window is visible. */
    button.armed { border-color: var(--danger); box-shadow: 0 0 0 2px var(--danger); animation: pulse .9s ease-in-out infinite; }
    button.armed::after {
      content: ''; position: absolute; left: 0; bottom: 0; height: 2px; width: 100%;
      background: var(--danger); transform-origin: left; animation: drain 4s linear forwards;
    }
    /* Send feedback without touching the label: success flashes green, a refusal
       shakes. Neither changes the button's text or size. */
    button[data-result="ok"] { animation: sent .8s ease-out; }
    button[data-result="error"] { animation: shake .35s ease-in-out; }
    @keyframes pulse { 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--danger) 45%, transparent); } }
    @keyframes drain { to { transform: scaleX(0); } }
    @keyframes sent {
      0% { box-shadow: 0 0 0 0 var(--ok); border-color: var(--ok); }
      30% { box-shadow: 0 0 0 3px var(--ok); border-color: var(--ok); }
      100% { box-shadow: 0 0 0 0 transparent; }
    }
    @keyframes shake { 20%, 60% { translate: -2px 0; } 40%, 80% { translate: 2px 0; } }
    @media (prefers-reduced-motion: reduce) {
      button.armed, button.armed::after, button[data-result] { animation: none; }
      button.armed::after { transform: none; }
    }

    /* Group label doubles as the fold toggle. */
    .label {
      flex: 0 1 auto; max-width: 11em; padding: 3px 4px; color: var(--muted);
      border: 0; background: none; display: inline-flex; align-items: center; gap: 4px;
    }
    .label:enabled:hover { color: var(--text); filter: none; }
    .label::before {
      content: ''; flex: none; width: 0; height: 0;
      border: 4px solid transparent; border-top-color: currentColor; border-bottom-width: 0;
      transition: rotate .12s;
    }
    .label[aria-expanded="false"]::before { rotate: -90deg; }
    .count {
      flex: none; font-size: 10px; padding: 0 5px; border-radius: 8px;
      border: 1px solid var(--line); color: var(--muted);
    }

    /* Compact by design: the bar is terminal chrome, so the search and settings
       affordances must not eat a row of their own. The column keeps them out of
       the buttons' wrap calculation entirely. */
    .tools {
      display: inline-flex; align-items: center; gap: 4px;
      flex: 0 0 auto; padding: 4px 8px 5px 4px;
    }
    .icon {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 3px 5px; line-height: 1;
      border: 1px solid var(--line-soft); background: var(--sunken); color: var(--muted);
    }
    .icon svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .icon:hover { color: var(--text); }
    /* The field only exists while filtering; otherwise it is a small affordance. */
    .search { display: none; }
    .tools[data-open] .search { display: block; flex: 1 1 190px; }
    .tools[data-open] .icon[data-role="search"] { display: none; }

    /* The status floats over the terminal's edge instead of taking a row, so a
       message appearing or clearing never moves the terminal. */
    .status {
      position: absolute; bottom: calc(100% + 6px); inset-inline-start: 8px;
      max-width: calc(100% - 16px); box-sizing: border-box; padding: 4px 10px;
      border-radius: 6px; border: 1px solid var(--line); border-inline-start-width: 3px;
      background: var(--bg); color: var(--text); box-shadow: 0 4px 14px rgb(0 0 0 / .25);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; pointer-events: none;
    }
    .status:empty { display: none; }
    .status[data-level="error"] { border-color: var(--warn); color: var(--warn); }
    .status[data-level="busy"] { border-color: var(--busy); color: var(--busy); }
    .status[data-level="ok"] { border-color: var(--ok); color: var(--ok); }
    .status[data-level="idle"] { color: var(--muted); }

    @media (max-width: 560px) {
      .bar { flex-wrap: wrap; }
      .groups { padding-inline-end: 8px; }
      .tools { margin-inline-start: auto; }
    }
  `);
  shadow.adoptedStyleSheets = [sheet];

  const SVG = 'http://www.w3.org/2000/svg';
  function icon(parts) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    for (const [tag, attributes] of parts) {
      const node = document.createElementNS(SVG, tag);
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
      svg.append(node);
    }
    return svg;
  }
  const SEARCH_ICON = [['circle', { cx: 7, cy: 7, r: 4.5 }], ['path', { d: 'M10.5 10.5 14 14' }]];
  const SETTINGS_ICON = [
    ['path', { d: 'M2 4.5h6M12 4.5h2M2 11.5h2M8 11.5h6' }],
    ['circle', { cx: 10, cy: 4.5, r: 1.8 }], ['circle', { cx: 6, cy: 11.5, r: 1.8 }],
  ];

  const tools = document.createElement('span');
  tools.className = 'tools';

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'search';
  search.placeholder = '筛选命令';
  search.setAttribute('aria-label', '筛选快捷命令');
  const searchToggle = document.createElement('button');
  searchToggle.type = 'button';
  searchToggle.className = 'icon';
  searchToggle.dataset.role = 'search';
  searchToggle.append(icon(SEARCH_ICON));
  searchToggle.title = '筛选命令（快捷键 /）';
  searchToggle.setAttribute('aria-label', '筛选快捷命令');
  const openSearch = () => {
    tools.dataset.open = '';
    search.focus();
  };
  const closeSearch = () => {
    delete tools.dataset.open;
    search.value = '';
    applyFilter();
  };
  searchToggle.addEventListener('click', event => {
    if (event.isTrusted) openSearch();
  });
  tools.append(searchToggle, search);

  const settings = document.createElement('button');
  settings.type = 'button';
  settings.className = 'icon';
  settings.append(icon(SETTINGS_ICON));
  settings.title = '命令库设置';
  settings.setAttribute('aria-label', '命令库设置');

  const groupArea = document.createElement('div');
  groupArea.className = 'groups';

  tools.append(settings);

  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.append(groupArea, tools);

  const notice = document.createElement('div');
  notice.className = 'status';
  notice.setAttribute('role', 'status');

  shadow.append(bar, notice);

  let detached = false;
  let catalog = { groups: [], total: 0 };
  let filtered = catalog;
  let rows = [];
  let status = {};
  let revisionKey;
  let loading = true;
  let executing = false;
  let feedback = '';
  let armed = null;
  let armedTimer = 0;
  let catalogTimer = 0;
  let feedbackTimer = 0;

  // Folded groups survive reloads. Only opaque group ids are stored, in the
  // page's own localStorage, so nothing sensitive is exposed to the page.
  const FOLD_KEY = 'sshpad:folded';
  const folded = new Set();
  try {
    for (const id of JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')) folded.add(String(id));
  } catch { /* storage may be blocked; folding then lasts for the page only */ }
  function saveFolded() {
    try { localStorage.setItem(FOLD_KEY, JSON.stringify([...folded])); } catch { /* ignore */ }
  }

  // The probe only posts on change, so expiry cannot be lazy: it needs its own
  // timer, otherwise a stale message sits on screen until the next event.
  function setFeedback(text, holdMs) {
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = 0;
    feedback = text;
    if (!holdMs) return;
    feedbackTimer = setTimeout(() => {
      feedbackTimer = 0;
      feedback = '';
      paintStatus();
    }, holdMs);
  }

  // Where the bar docks. Tried in order; the last resort is fixed positioning on
  // <body>, so an upstream layout change degrades to a floating bar instead of
  // no bar at all.
  const MOUNT = [
    'app-root elements-content > #content > #winContainer',
    '#winContainer',
    'app-root elements-content > #content',
  ];

  function mountPoint() {
    for (const selector of MOUNT) {
      const node = document.querySelector(selector);
      if (node) return node;
    }
    return null;
  }

  function parseRgb(value) {
    const match = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,/\s]+([\d.]+))?\s*\)$/.exec(value || '');
    if (!match) return null;
    const [, r, g, b, a = '1'] = match;
    return { r: Number(r), g: Number(g), b: Number(b), a: Number(a) };
  }

  // Match Luna's own footer bar right above us when it paints an opaque dark
  // surface; otherwise keep the built-in near-black terminal palette.
  function syncChromeColor() {
    const prev = host.previousElementSibling;
    const candidates = [
      prev?.querySelector?.('.footer-bar'),
      prev?.querySelector?.('.content-footer'),
      prev,
      host.parentElement,
    ];
    for (const node of candidates) {
      if (!node) continue;
      const rgb = parseRgb(getComputedStyle(node).backgroundColor);
      if (!rgb || rgb.a < 0.95) continue;
      if (rgb.r <= 56 && rgb.g <= 64 && rgb.b <= 76) {
        host.style.setProperty('--bg', `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`);
        return;
      }
    }
    host.style.removeProperty('--bg');
  }

  const life = new AbortController();

  // Accessing chrome.runtime.id itself can throw synchronously once Chrome
  // invalidates an old content-script context, so keep it behind its own guard.
  function contextAlive() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function stop() {
    detached = true;
    life.abort();
    if (catalogTimer) { clearTimeout(catalogTimer); catalogTimer = 0; }
    if (feedbackTimer) { clearTimeout(feedbackTimer); feedbackTimer = 0; }
    disarm();
  }

  // After the extension is reloaded or updated, an older instance in the page
  // either gets superseded by the newly injected bar or stops cleanly here.
  let orphaned = false;
  function orphan() {
    if (orphaned) return;
    orphaned = true;
    stop();
    status = { reason: '扩展已更新或重新加载，请刷新 Luna 页面。' };
    feedback = '';
    paintRows();
    paintStatus();
  }

  const send = async message => {
    if (orphaned) return { reason: '扩展已更新或重新加载，请刷新 Luna 页面。' };
    if (!contextAlive()) {
      orphan();
      return { reason: '扩展已更新或重新加载，请刷新 Luna 页面。' };
    }
    try {
      return (await chrome.runtime.sendMessage(message)) || { reason: '扩展暂不可用。' };
    } catch (error) {
      const dead = !contextAlive() || /context invalidated/i.test(String(error?.message ?? error));
      if (dead) {
        orphan();
        return { reason: '扩展已更新或重新加载，请刷新 Luna 页面。' };
      }
      return { reason: '扩展暂不可用，请刷新 Luna 页面。' };
    }
  };


  function emptyFor() {
    if (search.value.trim()) return filtered.total ? '' : '没有匹配的命令。';
    if (catalog.total) return '';
    return status.hasSites === false
      ? '先在扩展设置里授权 JumpServer 站点。'
      : '当前站点没有显示的命令，点「命令库设置」添加。';
  }

  function paintStatus() {
    let level = 'ok';
    let text = '';
    if (feedback) { level = 'error'; text = feedback; }
    else if (executing) { level = 'busy'; text = '正在提交…'; }
    else if (loading) { level = 'idle'; }
    else if (status.reason) { level = 'error'; text = status.reason; }
    else { level = 'idle'; text = emptyFor(); }
    if (notice.textContent !== text) notice.textContent = text;
    if (notice.dataset.level !== level) notice.dataset.level = level;
  }

  function disarm() {
    if (armedTimer) clearTimeout(armedTimer);
    armedTimer = 0;
    if (armed) armed.classList.remove('armed');
    armed = null;
  }

  function paintRows() {
    for (const row of rows) {
      const tooLong = status.textLimit > 0 && row.length > status.textLimit;
      row.button.disabled = executing || !status.target || tooLong;
      row.button.title = tooLong
        ? row.entry.command
        : row.entry.name + '\n' + row.entry.command;
      row.button.setAttribute('aria-description', tooLong
        ? '命令长度超过 KoKo 的粘贴限制。'
        : (row.entry.credential ? '包含' + row.entry.credential + '，需要点击两次确认' : ''));
    }
  }

  function render() {
    const scroll = groupArea.scrollTop;
    const fragment = document.createDocumentFragment();
    const filtering = Boolean(search.value.trim());
    rows = [];
    for (const group of filtered.groups) {
      const fold = !filtering && folded.has(group.id);
      const section = document.createElement('div');
      section.className = 'group';
      section.setAttribute('role', 'group');
      section.setAttribute('aria-label', group.name);
      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'label';
      label.setAttribute('aria-expanded', String(!fold));
      label.title = filtering ? group.name : group.name + (fold ? '（点击展开）' : '（点击折叠）');
      label.append(group.name);
      if (fold) {
        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = String(group.commands.length);
        label.append(count);
      }
      label.addEventListener('click', event => {
        if (!event.isTrusted || filtering) return;
        if (folded.has(group.id)) folded.delete(group.id);
        else folded.add(group.id);
        saveFolded();
        render();
        paintRows();
      });
      let first = true;
      for (const entry of group.commands) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.color = entry.color || 'default';
        button.textContent = entry.name;
        const danger = entry.credential;
        if (danger) {
          button.dataset.credential = danger;
          button.setAttribute('aria-description', '包含' + danger);
        }
        button.addEventListener('click', event => {
          if (!event.isTrusted || executing || !status.target || button.disabled) return;
          onClick(entry, button, danger);
        });
        // The label and its first button share one flex item so a wrap never
        // strands a group name at the end of a line.
        const cell = document.createElement('span');
        cell.className = first ? 'group-start' : 'command';
        if (first) cell.append(label);
        cell.append(button);
        cell.hidden = !first && fold;
        if (first && fold) button.hidden = true;
        section.append(cell);
        first = false;
        // A folded button leaves the accessibility tree and the tab order, so it
        // must also stay out of the rows that paintRows() enables.
        if (!fold) {
          rows.push({
            button,
            length: entry.inputLength || Array.from(entry.command).length + 1,
            entry,
          });
        }
      }
      fragment.append(section);
    }
    groupArea.replaceChildren(fragment);
    groupArea.scrollTop = scroll;
  }

  // Result flash on the button that was clicked. It is cosmetic only and goes
  // away by itself; a rebuilt button simply loses it.
  function flash(button, result) {
    button.dataset.result = result;
    setTimeout(() => { if (button.dataset.result === result) delete button.dataset.result; }, 900);
  }

  async function onClick(entry, button, danger) {
    // A shortcut that will paste a literal secret gets one confirming click
    // first; everything else submits immediately.
    if (danger && armed !== button) {
      disarm();
      armed = button;
      button.classList.add('armed');
      setFeedback('再点一次提交「' + entry.name + '」（' + danger + '）', 4000);
      paintStatus();
      armedTimer = setTimeout(() => { disarm(); setFeedback(''); paintStatus(); }, 4000);
      return;
    }
    disarm();
    executing = true;
    setFeedback('');
    paintStatus();
    paintRows();
    let result;
    try {
      result = await send({
        type: 'execute', id: entry.id, sourceId: entry.sourceId,
        revision: entry.revision, target: status.target,
      });
    } finally {
      executing = false;
    }
    if (detached) return;
    // Hold a refusal long enough to read; a success stays silent in the status
    // line and shows as a short flash on the button instead.
    setFeedback(result.reason || '', result.reason ? 2500 : 0);
    if (button.isConnected) flash(button, result.reason ? 'error' : 'ok');
    paintStatus();
    paintRows();
    setTimeout(sync, 120);
  }

  // Kept local so the bar stays import-free; the rules mirror catalog.js.
  function applyFilter() {
    const needle = search.value.trim().toLowerCase();
    if (!needle) {
      filtered = catalog;
      render();
      paintRows();
      paintStatus();
      return;
    }
    const groups = [];
    let total = 0;
    for (const group of catalog.groups) {
      const commands = group.commands.filter(entry =>
        entry.name.toLowerCase().includes(needle) ||
        entry.command.toLowerCase().includes(needle));
      if (!commands.length) continue;
      total += commands.length;
      groups.push({ id: group.id, name: group.name, commands });
    }
    filtered = { groups, total };
    render();
    paintRows();
    paintStatus();
  }

  async function sync() {
    if (detached) return;
    const next = await send({ type: 'status', knownRevision: revisionKey });
    if (detached) return;
    if (next.unauthorized || !/(^|\/)luna(?:\/|$)/.test(location.pathname)) {
      host.remove();
      return;
    }
    loading = false;
    if (next.catalog) {
      revisionKey = next.revisionKey;
      catalog = next.catalog;
      applyFilter();
    } else if (next.revisionKey !== undefined) {
      revisionKey = next.revisionKey;
    }
    const container = mountPoint();
    host.toggleAttribute('data-floating', !container);
    const parent = container || document.body;
    if (host.parentNode !== parent) parent.append(host);
    syncChromeColor();
    status = Object.assign({}, status, next);
    paintRows();
    paintStatus();
  }

  // Tear down any previous bar instance before attaching our own listeners, so
  // hot-reloading the extension swaps the bar in place without a page refresh.
  document.dispatchEvent(new CustomEvent('sshpad:supersede'));
  for (const stale of document.querySelectorAll('aside[data-sshpad]')) stale.remove();
  document.addEventListener('sshpad:supersede', () => {
    stop();
    host.remove();
  }, { signal: life.signal });

  // The MAIN-world probe posts state straight from the page, so the bar reacts
  // without asking the worker anything. Sending still goes through the worker.
  addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data && event.data.tag !== 'sshpad/state') return;
    const state = event.data && event.data.state;
    if (!state || detached) return;
    loading = false;
    const next = {
      target: state.target,
      textLimit: state.textLimit,
      reason: state.ok ? '' : state.reason,
    };
    const revisionKeyBefore = status.revisionKey;
    status = Object.assign({}, status, next, { revisionKey: revisionKeyBefore });
    paintRows();
    paintStatus();
    // A terminal appearing or disappearing can change which commands apply.
    if (catalogTimer) return;
    catalogTimer = setTimeout(() => { catalogTimer = 0; sync(); }, 300);
  }, { signal: life.signal });

  // The worker pushes a new catalogue whenever settings or permissions change,
  // so no tab has to poll for it.
  if (contextAlive()) {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (detached) return;
      try {
        if (sender?.id !== chrome.runtime?.id || !message || typeof message !== 'object') return;
      } catch {
        orphan();
        return;
      }
      // A removed site or revoked permission detaches the page immediately
      // instead of waiting for the next user interaction.
      if (message.type === 'detach') {
        stop();
        host.remove();
        return;
      }
      if (message.type !== 'catalog') return;
      loading = false;
      if (message.hasSites !== undefined) status.hasSites = message.hasSites;
      if (message.catalog) {
        revisionKey = message.revisionKey;
        status.revisionKey = message.revisionKey;
        catalog = message.catalog;
        applyFilter();
      }
      respond?.({});
    });
  }

  search.addEventListener('input', applyFilter);
  search.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    closeSearch();
    search.blur();
  });
  search.addEventListener('blur', () => {
    // Collapse back to the icon once the user leaves an empty field.
    if (!search.value.trim()) closeSearch();
  });

  settings.addEventListener('click', event => {
    if (event.isTrusted) send({ type: 'open-options' });
  });

  // "/" opens the filter, the way terminal-adjacent tools do, but never while
  // the user is typing into a field.
  addEventListener('keydown', event => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    const active = document.activeElement;
    if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return;
    event.preventDefault();
    openSearch();
    search.select();
  }, { capture: true, signal: life.signal });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) window.postMessage({ tag: 'sshpad/sample' }, location.origin);
  }, { signal: life.signal });

  if (/(^|\/)luna(?:\/|$)/.test(location.pathname)) {
    if (!document.documentElement.hasAttribute('data-sshpad-layout')) {
      document.documentElement.setAttribute('data-sshpad-layout', '');
      const layout = new CSSStyleSheet();
      // Let the terminal shrink so the bar never overlaps it.
      layout.replaceSync(':has(> [data-sshpad]) > .content-windows { min-height: 0; }');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, layout];
    }
    window.postMessage({ tag: 'sshpad/sample' }, location.origin);
    sync();
    setTimeout(sync, 300);
  }
})();
