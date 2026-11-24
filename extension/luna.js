// Runs as a single synchronous operation in the Luna document's main world.
// The wrapper must be self-contained for chrome.scripting.executeScript.
//
// Target discovery lives in probe.js, which is already running in this world.
// This function re-samples through it so the token it verifies is produced by
// the same code that fed the bar, and falls back to scanning directly if the
// probe was not injected (older registration, or a page that loaded first).
export function lunaOperation(origin, expectedTarget, command, longestInput = 0) {
  const fail = reason => ({ reason });
  if (location.origin !== origin) return fail('站点或页面已切换。');

  try {
    const state = typeof window.__lunaQuickSample === 'function' ? window.__lunaQuickSample() : null;
    if (!state) return fail('Luna 页面探测未就绪，请刷新页面。');
    if (!state.ok) return fail(state.reason);

    if (command === null) return { target: state.target, textLimit: state.textLimit };

    if (state.target !== expectedTarget) return fail('当前 SSH 终端已切换，请重新点击。');
    if (typeof command !== 'string' || !command.trim() || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(command)) {
      return fail('命令必须是可提交的单行文本。');
    }

    const data = command + '\r';
    if (state.textLimit > 0 && Math.max(longestInput, Array.from(data).length) > state.textLimit) {
      return fail('命令长度超过 KoKo 的粘贴限制。');
    }

    const frames = [...document.querySelectorAll('iframe')].filter(frame => {
      let url;
      try { url = new URL(frame.src); } catch { return false; }
      return url.origin === location.origin && /\/koko\/connect\/?$/.test(url.pathname) &&
        (typeof frame.checkVisibility !== 'function' || frame.checkVisibility({ checkVisibilityCSS: true }));
    });
    if (frames.length !== 1) return fail('当前标签的终端目标不明确。');
    const frameWindow = frames[0].contentWindow;
    if (!frameWindow) return fail('KoKo SSH 终端尚未就绪。');

    // Same one-frame CMD message as ElementIframeComponent.sendCommand.
    // KoKo still handles the paste ACL and terminal socket delivery.
    frameWindow.postMessage({ name: 'CMD', data }, origin);
    // Restore xterm focus for any prompt produced by the command.
    frameWindow.postMessage({ name: 'FOCUS' }, origin);
    return { sent: true };
  } catch {
    return fail('无法核实 Luna 或 KoKo 的当前会话。');
  }
}
