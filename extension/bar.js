// Injected into Luna as a dynamically registered content script.
// Deliberately plain: MV3 content scripts are not modules, so this file must
// stay import-free. Pure view logic (catalog.js, sensitive.js) is inlined by
// the worker before injection so the bar has no imports at all.
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
      all: initial; display: block; flex: 0 0 auto; min-width: 0;
      color-scheme: dark; color: #e6edf6; background: #172332;
      border-top: 1px solid #3c4e65; font: 12px/1.4 system-ui, -apple-system, sans-serif;
    }
    :host([data-floating]) { position: fixed; bottom: 0; inset-inline: 0; z-index: 1000; }

    .search {
      flex: 0 1 170px; min-width: 0; font: inherit; color: inherit;
      padding: 2px 7px; border-radius: 4px; border: 1px solid #2c3d50;
      background: #111c28; -webkit-appearance: none; appearance: none;
    }
    .search:focus { border-color: #6aa4ee; }
    .search:focus-visible, button:focus-visible { outline: 2px solid #6aa4ee; outline-offset: 1px; }
    .search:placeholder-shown { border-color: #2c3d50; }

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
      margin-inline-start: 12px;
    }
    .group:first-child > .group-start { margin-inline-start: 0; }
    .label { flex: 0 1 auto; max-width: 11em; color: #8fa9c6;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .command { max-width: 100%; min-width: 0; }

    button {
      font: inherit; padding: 3px 8px; color: inherit; cursor: pointer;
      border: 1px solid #526881; background: #27384c; border-radius: 4px;
      white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis;
    }
    button[data-color="blue"] { --button-bg: #184575; --button-border: #669de6; }
    button[data-color="green"] { --button-bg: #124c3c; --button-border: #63cba0; }
    button[data-color="amber"] { --button-bg: #513916; --button-border: #efbd68; }
    button[data-color="purple"] { --button-bg: #43285f; --button-border: #ba99e8; }
    button[data-color="red"] { --button-bg: #7d222b; --button-border: #ff9ca0; color: #fff3f4; }
    button[data-color] { background: var(--button-bg, #27384c); border-color: var(--button-border, #526881); }
    button:enabled:hover { filter: brightness(1.22); }
    button:disabled { opacity: .5; cursor: default; }
    button.armed { border-color: #ff9ca0; box-shadow: inset 0 0 0 1px #ff9ca0; }
    .settings { flex: none; }
    /* A left accent rather than a glyph: even a pseudo-element's text joins the
       accessible name, which would corrupt the button label. */
    button[data-credential] {
      box-shadow: inset 2px 0 0 #e0a34a;
      padding-inline-start: 7px;
    }

    /* Compact by design: the bar is terminal chrome, so the search and settings
       affordances must not eat a row of their own. The column keeps them out of
       the buttons' wrap calculation entirely. */
    .tools {
      display: inline-flex; align-items: center; gap: 4px;
      flex: 0 0 auto; padding: 4px 8px 5px 4px;
    }
    .icon {
      font: inherit; padding: 3px 6px; line-height: 1;
      border: 1px solid #2c3d50; background: #1b2837; color: #8fa9c6;
    }
    .icon:hover { color: #e6edf6; }
    /* The field only exists while filtering; otherwise it is a 26px affordance. */
    .search { display: none; }
    .tools[data-open] .search { display: block; flex: 1 1 190px; }
    .tools[data-open] .icon { display: none; }
    .status { padding: 0 8px 4px; color: #f2d399;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status:empty { display: none; }
    .status[data-level="error"]::before { content: '⚠  '; }
    .status[data-level="busy"] { color: #9fc6f5; }
    .status[data-level="ok"] { color: #7fb98f; }

    @media (max-width: 560px) {
      .bar { flex-wrap: wrap; }
      .groups { padding-inline-end: 8px; }
      .tools { margin-inline-start: auto; }
    }
  `);
  shadow.adoptedStyleSheets = [sheet];

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
  searchToggle.textContent = '/';
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
  settings.textContent = '\u2699';
  settings.title = '命令库设置';
  settings.setAttribute('aria-label', '命令库设置');

  const groupArea = document.createElement('div');
  groupArea.className = 'groups';

  // The reserved strip must track the real width of the tools, whatever the UI
  // language or zoom level turns out to be.


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
  // An error that vanishes in 80ms is the same as no error at all. Probe
  // updates keep arriving, so feedback owns a minimum display time.
  let feedbackUntil = 0;

  let feedbackTimer = 0;

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

  function expireFeedback() {
    // A newer state does not cancel a message the user has not read yet.
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

  const send = message => Promise.resolve(chrome.runtime.sendMessage(message))
    .then(response => response || { reason: '扩展暂不可用。' },
      () => ({ reason: '扩展暂不可用，请刷新 Luna 页面。' }));

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
    rows = [];
    for (const group of filtered.groups) {
      const section = document.createElement('div');
      section.className = 'group';
      section.setAttribute('role', 'group');
      section.setAttribute('aria-label', group.name);
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = group.name;
      label.title = group.name;
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
        section.append(cell);
        first = false;
        rows.push({
          button,
          length: entry.inputLength || Array.from(entry.command).length + 1,
          entry,
        });
      }
      fragment.append(section);
    }
    groupArea.replaceChildren(fragment);
    groupArea.scrollTop = scroll;
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
    // Hold a refusal long enough to read; a success stays silent.
    setFeedback(result.reason || '', result.reason ? 2500 : 0);
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
    expireFeedback();
    status = Object.assign({}, status, next);
    paintRows();
    paintStatus();
  }

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
    expireFeedback();
    const revisionKeyBefore = status.revisionKey;
    status = Object.assign({}, status, next, { revisionKey: revisionKeyBefore });
    paintRows();
    paintStatus();
    // A terminal appearing or disappearing can change which commands apply.
    if (catalogTimer) return;
    catalogTimer = setTimeout(() => { catalogTimer = 0; sync(); }, 300);
  });

  // The worker pushes a new catalogue whenever settings or permissions change,
  // so no tab has to poll for it.
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return;
    // A removed site or revoked permission detaches the page immediately
    // instead of waiting for the next user interaction.
    if (message.type === 'detach') {
      detached = true;
      host.remove();
      return;
    }
    if (message.type !== 'catalog') return;
    loading = false;
    if (message.hasSites !== undefined) status.hasSites = message.hasSites;
    if (message.catalog) {
      revisionKey = message.revisionKey;
      catalog = message.catalog;
      applyFilter();
    }
    respond?.({});
  });

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
  }, true);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) window.postMessage({ tag: 'sshpad/sample' }, location.origin);
  });

  if (/(^|\/)luna(?:\/|$)/.test(location.pathname)) {
    const layout = new CSSStyleSheet();
    // Let the terminal shrink so the bar never overlaps it.
    layout.replaceSync(':has(> [data-sshpad]) > .content-windows { min-height: 0; }');
    document.adoptedStyleSheets = document.adoptedStyleSheets.concat(layout);
    sync();
    setTimeout(sync, 300);
  }
})();