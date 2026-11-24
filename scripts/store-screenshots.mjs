// Generates 1280x800 (24-bit RGB PNG, no alpha) screenshots for Chrome Web Store listing.
// Uses local Luna/KoKo fixtures with visual styling overlaid only for screenshots;
// does not modify tests/ or extension/.
import { once } from 'node:events';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url).pathname;
const outDir = join(root, 'docs/store');
const fixtureHtml = await readFile(join(root, 'tests/luna-fixture.html'), 'utf8');
const kokoHtml = await readFile(join(root, 'tests/koko-fixture.html'), 'utf8');

const lunaOverlay = `
<style>
  html, body { height: 100%; background: #14161a; color: #c8cdd6; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow: hidden; }
  .tab-bar { background: #1b1e24; border-bottom: 1px solid #2b303a; height: 38px; display: flex; align-items: flex-end; padding: 0 12px; gap: 4px; }
  .tabs ul { gap: 4px; }
  .tabs li { list-style: none; }
  .tabs li button {
    background: transparent; color: #8b94a3; border: 1px solid transparent; border-bottom: none;
    border-radius: 6px 6px 0 0; padding: 7px 16px; font-size: 12px; cursor: pointer;
  }
  .tabs li.active button { background: #0f1115; color: #e6ebf2; border-color: #2b303a; font-weight: 500; }
  #winContainer { height: calc(100vh - 38px) !important; background: #0f1115; }
  .content-windows { display: flex; flex: 1; min-height: 0; }
  elements-content-window { display: flex; flex: 1; min-height: 0; }
  .window.active { display: flex; flex: 1; min-height: 0; }
  .view, .sub-view, elements-connector-koko, elements-iframe { display: flex; flex: 1; min-height: 0; }
  iframe { border: none; width: 100%; height: 100%; flex: 1; }
  .content-footer { display: none; }
</style>
<script>
  window.addEventListener('DOMContentLoaded', () => {
    const btnA = document.querySelector('#View_A button');
    const btnB = document.querySelector('#View_B button');
    if (btnA) btnA.textContent = 'prod-app-01 (10.24.8.12)';
    if (btnB) btnB.textContent = 'prod-db-01 (10.24.8.20)';
  });
</script>
`;

const kokoOverlay = `
<style>
  html, body {
    margin: 0; height: 100%; background: #0f1115; color: #d8dee9;
    font: 14px/1.65 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    overflow: hidden;
  }
  #terminal-input { position: absolute; opacity: 0; pointer-events: none; }
  .mock-term { padding: 18px 22px; white-space: pre; }
  .muted { color: #6b7688; }
  .green { color: #8fbcbb; }
  .accent { color: #88c0d0; }
  .ok { color: #a3be8c; }
  .warn { color: #ebcb8b; }
  .cursor { display: inline-block; width: 8px; height: 15px; background: #d8dee9; vertical-align: -2px; margin-left: 2px; }
</style>
<div class="mock-term"><span class="muted">Last login: Tue Nov 24 17:42:10 2026 from 10.24.0.5</span>
<span class="muted">Welcome to JumpServer Luna SSH Session · prod-app-01 (Ubuntu 24.04.1 LTS)</span>

<span class="green">ops@prod-app-01</span>:<span class="accent">/opt/app</span>$ uptime &amp;&amp; whoami
 17:58:04 up 42 days,  6:19,  1 user,  load average: 0.41, 0.38, 0.35
ops

<span class="green">ops@prod-app-01</span>:<span class="accent">/opt/app</span>$ df -h / /var/log
Filesystem      Size  Used Avail Use% Mounted on
/dev/nvme0n1p1  120G   48G   67G  42% /
/dev/nvme1n1     80G   19G   57G  25% /var/log

<span class="green">ops@prod-app-01</span>:<span class="accent">/opt/app</span>$ systemctl status app --no-pager -n 4
<span class="ok">●</span> app.service - Application Backend Service
     Loaded: loaded (/etc/systemd/system/app.service; enabled)
     Active: <span class="ok">active (running)</span> since Mon 2026-11-23 09:15:22 CST; 1 day 8h ago
   Main PID: 18422 (node)
     Memory: 312.4M (peak: 348.0M)

<span class="green">ops@prod-app-01</span>:<span class="accent">/opt/app</span>$ <span class="cursor"></span></div>
`;

const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url.startsWith('/koko/connect/')) {
    res.end(kokoHtml + kokoOverlay);
  } else {
    res.end(fixtureHtml + lunaOverlay);
  }
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;

const scratch = await mkdtemp(join(tmpdir(), 'sshpad-store-'));
try {
  const extDir = join(scratch, 'extension');
  await cp(join(root, 'extension'), extDir, { recursive: true });
  const manifestPath = join(extDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(manifestPath, JSON.stringify(manifest));

  const ctx = await chromium.launchPersistentContext(join(scratch, 'profile'), {
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
    colorScheme: 'dark',
    viewport: { width: 1280, height: 800 },
  });

  const cdp = await ctx.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: extDir });
  const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');

  const options = await ctx.newPage();
  await options.setViewportSize({ width: 1280, height: 800 });
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.locator('#origin').fill(origin);
  await options.getByRole('button', { name: '添加或授权站点', exact: true }).click();
  await options.getByText(origin, { exact: true }).waitFor();

  await worker.evaluate(async () => {
    const mk = (id, name, command, color) => {
      const entry = { id, name, command };
      if (color) entry.color = color;
      return entry;
    };
    const library = {
      version: 1,
      sourceId: 'ops',
      groups: [
        {
          id: 'mysql',
          name: 'MySQL',
          commands: [
            mk('m1', '主库连接', 'mysql -hdb-master.internal -uapp -A -p', 'red'),
            mk('m2', '只读从库', 'mysql -hdb-replica.internal -ureadonly -A', 'blue'),
            mk('m3', '慢查询状态', 'mysql -e "SHOW PROCESSLIST;"'),
          ],
        },
        {
          id: 'deploy',
          name: '发布运维',
          commands: [
            mk('d1', '拉取代码', 'cd /opt/app && git pull'),
            mk('d2', '重启服务', 'systemctl restart app', 'amber'),
            mk('d3', '实时日志', 'tail -f /var/log/app/current.log'),
            mk('d4', 'Nginx 重载', 'nginx -t && systemctl reload nginx', 'teal'),
          ],
        },
        {
          id: 'diag',
          name: '系统诊断',
          commands: [
            mk('x1', '磁盘占用', 'df -h', 'green'),
            mk('x2', '内存排行', 'ps aux --sort=-%mem | head -18'),
            mk('x3', '系统负载', 'uptime && whoami', 'purple'),
            mk('x4', '监听端口', 'ss -tulpn'),
          ],
        },
      ],
    };
    await chrome.storage.local.set({
      libraries: { ops: { library, revision: 'r1', edits: {}, colors: {}, groupNames: {} } },
    });
  });

  await mkdir(outDir, { recursive: true });

  // Screenshot 1: Luna terminal with sshpad command bar at 1280x800
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/luna/`);
  await page.locator('aside[data-sshpad]').waitFor();
  await wait(1200);
  await page.screenshot({ path: join(outDir, 'screenshot-1-terminal.png') });

  // Screenshot 2: Options page at 1280x800 (replace 127.0.0.1 display with clean example domain)
  await options.reload();
  await wait(800);
  await options.evaluate((actualOrigin) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.includes(actualOrigin)) {
        node.nodeValue = node.nodeValue.replaceAll(actualOrigin, 'https://jump.example.com');
      }
    }
  }, origin);
  await options.screenshot({ path: join(outDir, 'screenshot-2-options.png') });

  console.log('Generated 1280x800 store screenshots in docs/store/');
  await ctx.close();
} finally {
  server.close();
  await rm(scratch, { recursive: true, force: true });
}
