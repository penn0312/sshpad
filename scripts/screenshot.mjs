
import { once } from 'node:events';
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright';

const root = process.argv[2];
const fixture = await readFile(join(root, 'tests/luna-fixture.html'));
const terminal = await readFile(join(root, 'tests/koko-fixture.html'));
const serve = (req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(req.url.startsWith('/koko/connect/') ? terminal : fixture); };
const server = createServer(serve);
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;

const scratch = await mkdtemp(join(tmpdir(), 'shot-'));
const extDir = join(scratch, 'extension');
await cp(join(root, 'extension'), extDir, { recursive: true });
const mp = join(extDir, 'manifest.json');
const manifest = JSON.parse(await readFile(mp, 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(mp, JSON.stringify(manifest));

const ctx = await chromium.launchPersistentContext(join(scratch, 'profile'), {
  channel: 'chromium', headless: true, ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging'], colorScheme: 'dark', viewport: { width: 1100, height: 300 } });
const cdp = await ctx.browser().newBrowserCDPSession();
const { id } = await cdp.send('Extensions.loadUnpacked', { path: extDir });
const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');

const options = await ctx.newPage();
await options.goto('chrome-extension://' + id + '/options.html');
await options.locator('#origin').fill(origin);
await options.getByRole('button', { name: '添加或授权站点', exact: true }).click();
await options.getByText(origin, { exact: true }).waitFor();

await worker.evaluate(async () => {
  const mk = (id, name, command, color) => { const e = { id, name, command }; if (color) e.color = color; return e; };
  const library = { version: 1, sourceId: 'ops', groups: [
    { id: 'mysql', name: 'MySQL', commands: [
      mk('m1', '主库写入', 'mysql -hdb.10.0.0.8 -uapp -A', 'red'),
      mk('m2', '只读连接', 'mysql -hdb.10.0.0.9 -ureadonly -A', 'blue'),
    ]},
    { id: 'deploy', name: '发布', commands: [
      mk('d1', '拉取代码', 'cd /opt/app && git pull'),
      mk('d2', '重启服务', 'systemctl restart app', 'amber'),
      mk('d3', '查看日志', 'tail -f /var/log/app/current.log'),
    ]},
    { id: 'diag', name: '诊断', commands: [
      mk('x1', '磁盘占用', 'df -h', 'green'),
      mk('x2', '内存排序', 'ps aux --sort=-%mem | head -18'),
      mk('x3', '负载', 'uptime && whoami', 'purple'),
    ]},
  ] };
  await chrome.storage.local.set({ libraries: { ops: { library, revision: 'r1', edits: {}, colors: {}, groupNames: {} } } });
});

const page = await ctx.newPage();
await page.goto(origin + '/luna/');
await page.locator('aside[data-sshpad]').waitFor();
await wait(1400);
const bar = page.locator('aside[data-sshpad]');
await mkdir(join(root, 'docs/images'), { recursive: true });
await bar.screenshot({ path: join(root, 'docs/images/bar.png') });

// Settings page shot, cropped to the library section.
await options.setViewportSize({ width: 900, height: 1100 });
await options.reload();
await wait(700);
await options.locator('section').nth(1).screenshot({ path: join(root, 'docs/images/settings.png') });
console.log('shots written');
await ctx.close(); server.close();