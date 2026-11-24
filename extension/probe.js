// Runs in the Luna page's MAIN world. Registered by worker.js with world:'MAIN'.
//
// Its only job: answer "which KoKo terminal is the user looking at, and is it
// still connected?" and broadcast the answer to the bar. It never sends input.
// Command delivery always goes back through the worker, which re-samples and
// compares the target token, so nothing here is trusted for execution.
//
// The isolated-world bar cannot read KoKo's Pinia store (separate JS realm),
// which is why this has to live in the page's own world.
(() => {
  if (window.__lunaQuickSample) return;

  const MESSAGE = 'sshpad/state';
  const REQUEST = 'sshpad/sample';
  const KOKO_PATH = /\/koko\/connect\/?$/;
  const LUNA_PATH = /(^|\/)luna(?:\/|$)/;
  // Every upstream selector lives here and nowhere else. When JumpServer
  // changes its DOM, this table is the only thing that needs editing.
  const SELECTORS = {
    host: '[data-sshpad]',
    pane: '.sub-view',
    batchInput: '.batch-input',
  };
  const TICK = 1000;

  const fail = reason => ({ ok: false, reason, target: null, textLimit: 0 });

  function rendered(element) {
    if (!element) return false;
    if (typeof element.checkVisibility === 'function') {
      return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    return element.offsetParent !== null;
  }

  function kokoFrames() {
    const frames = [];
    for (const frame of document.querySelectorAll('iframe')) {
      let url;
      try { url = new URL(frame.src); } catch { continue; }
      if (url.origin !== location.origin || !KOKO_PATH.test(url.pathname)) continue;
      if (!rendered(frame)) continue;
      frames.push(frame);
    }
    return frames;
  }

  function piniaState(frameWindow) {
    try {
      const app = frameWindow.document.querySelector('#app');
      return app?.__vue_app__?.config?.globalProperties?.$pinia?.state?.value ?? null;
    } catch {
      return null;
    }
  }

  // Known path first. The bounded structural scan is the fallback that keeps
  // the extension alive if upstream renames or reshapes the store.
  function findConnection(state) {
    if (!state || typeof state !== 'object') return null;
    const direct = state.connection;
    if (direct && typeof direct.sessionId === 'string' && 'terminalId' in direct) return direct;
    const seen = new Set();
    const queue = [[state, 0]];
    while (queue.length) {
      const [node, depth] = queue.shift();
      if (!node || typeof node !== 'object' || seen.has(node) || seen.size > 200) continue;
      seen.add(node);
      let keys;
      try { keys = Object.keys(node); } catch { continue; }
      if (keys.includes('sessionId') && keys.includes('terminalId') && keys.includes('socket')) return node;
      if (depth >= 4) continue;
      for (const key of keys) {
        try {
          const value = node[key];
          if (value && typeof value === 'object' && !seen.has(value)) queue.push([value, depth + 1]);
        } catch { /* a reactive proxy getter can throw */ }
      }
    }
    return null;
  }

  function frameToken(frame) {
    if (!frame.id) frame.dataset.lqFrame ||= Math.random().toString(36).slice(2, 10);
    return frame.id || frame.dataset.lqFrame;
  }

  function sample() {
    if (!LUNA_PATH.test(location.pathname)) return fail('当前页面不是 Luna 终端。');
    // Inactive tabs keep their panes mounted, so only rendered ones count.
    const panes = [...document.querySelectorAll(SELECTORS.pane)].filter(rendered);
    if (panes.length > 1) return fail('当前标签有分屏。');
    const frames = kokoFrames();
    if (!frames.length) return fail('当前标签没有已连接的 SSH 终端。');
    if (frames.length > 1) return fail('当前标签的终端目标不明确。');
    if (!document.querySelector(SELECTORS.batchInput)) return fail('Luna 未启用当前标签的 SSH 命令发送。');

    const frame = frames[0];
    let frameWindow;
    try { frameWindow = frame.contentWindow; } catch { return fail('无法读取 KoKo 终端。'); }
    if (!frameWindow) return fail('KoKo SSH 终端尚未就绪。');

    const state = piniaState(frameWindow);
    if (!state) return fail('无法读取 KoKo 会话状态。');

    const connection = findConnection(state);
    if (!connection?.sessionId || !connection.terminalId || !connection.terminal) {
      return fail('当前 SSH 终端未连接或已断开。');
    }
    if (!connection.socket || connection.socket.readyState !== 1) {
      return fail('当前 SSH 终端未连接或已断开。');
    }
    if (state.terminal?.currentTab) return fail('当前 KoKo 会话目标不明确。');
    const paste = state.clipboard?.defaultAccess?.paste;
    if (paste?.enabled !== true || !Number.isSafeInteger(paste.textLimit) || paste.textLimit < 0) {
      return fail('KoKo 会话未允许粘贴命令。');
    }

    bindSocket(connection);
    return {
      ok: true,
      reason: '',
      target: JSON.stringify([frameToken(frame), connection.sessionId, connection.terminalId]),
      textLimit: paste.textLimit,
    };
  }

  // The socket can close without Luna or the DOM changing at all, so its own
  // events are the only trustworthy close signal.
  let boundSocket = null;
  function bindSocket(connection) {
    const socket = connection?.socket;
    if (!socket || socket === boundSocket || typeof socket.addEventListener !== 'function') return;
    boundSocket = socket;
    for (const type of ['open', 'close', 'error']) socket.addEventListener(type, schedule);
  }

  let timer = 0;
  let last = '';
  function publish(state) {
    const key = JSON.stringify(state);
    if (key === last) return;
    last = key;
    try {
      window.postMessage({ tag: MESSAGE, state }, location.origin);
    } catch { /* never let a hostile page break the probe */ }
  }

  function run() {
    try {
      publish(sample());
    } catch {
      publish(fail('无法核实 Luna 或 KoKo 的当前会话。'));
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = 0; run(); }, 80);
  }

  // Only structural changes matter; the terminal itself renders inside an
  // iframe and stays out of this observer.
  const observer = new MutationObserver(records => {
    for (const record of records) {
      const node = record.target instanceof Element ? record.target : record.target.parentElement;
      // Our own host re-renders on every state change; observing it would loop.
      if (node?.closest?.(SELECTORS.host)) continue;
      schedule();
      return;
    }
  });

  function start() {
    observer.observe(document.documentElement, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['class', 'hidden', 'style', 'src'],
    });
    for (const type of ['focusin', 'pointerdown', 'pageshow']) {
      addEventListener(type, schedule, { capture: true, passive: true });
    }
    addEventListener('popstate', schedule);
    addEventListener('hashchange', schedule);
    addEventListener('online', schedule);
    addEventListener('offline', schedule);
    document.addEventListener('visibilitychange', schedule);
    // Structural properties such as readyState change without any event, so a
    // cheap in-page tick backs the observer up. It costs no IPC and does not
    // wake the service worker.
    setInterval(() => { if (!document.hidden) run(); }, TICK);
    run();
  }

  addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.tag === REQUEST) run();
  });

  // Called by lunaOperation before every delivery so the token it compares is
  // the same one the bar displayed.
  window.__lunaQuickSample = sample;
  window.__lunaQuickProbeReady = true;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();