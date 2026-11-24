import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright';
import { validateLibrary } from '../extension/library.js';
import { parseSendString, usesSendString } from '../extension/send-string.js';

const fixture = await readFile(new URL('./luna-fixture.html', import.meta.url));
const terminal = await readFile(new URL('./koko-fixture.html', import.meta.url));
const serveFixture = (request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(request.url.startsWith('/koko/connect/') ? terminal : fixture);
};
const servers = [createServer(serveFixture), createServer(serveFixture)];
const [origin, otherOrigin] = await Promise.all(servers.map(async server => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}));
const scratch = await mkdtemp(join(tmpdir(), 'sshpad-test-'));
const source = new URL('../extension/', import.meta.url);
const extension = join(scratch, 'extension');
const contexts = [];

async function launch(path, profile) {
  const context = await chromium.launchPersistentContext(join(scratch, profile), {
    channel: 'chromium', headless: true, ignoreDefaultArgs: ['--disable-extensions'], colorScheme: 'dark',
    args: ['--enable-unsafe-extension-debugging'],
  });
  contexts.push(context);
  const browserCDP = await context.browser().newBrowserCDPSession();
  const { id } = await browserCDP.send('Extensions.loadUnpacked', { path });
  return [context, id, browserCDP];
}

async function until(fn, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await fn();
    if (result) return result;
    await wait(80);
  }
  throw new Error(`Timed out: ${description}`);
}

try {
  const [unpacked, originalId] = await launch(decodeURIComponent(source.pathname), 'original');
  const originalOptions = await unpacked.newPage();
  await originalOptions.goto(`chrome-extension://${originalId}/options.html`);
  await originalOptions.getByText('尚未授权 JumpServer 站点。').waitFor();
  const denied = await unpacked.newPage();
  await denied.goto(`${origin}/luna/`);
  assert.equal(await denied.locator('[data-sshpad]').count(), 0);
  await unpacked.close();

  await cp(source, extension, { recursive: true });
  const manifestPath = join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // The test-only copy pregrants loopback so Chrome's native modal does not
  // block a headless run. All registration, UI and execution code is unchanged.
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const [context, id, browserCDP] = await launch(extension, 'fixture-profile');
  const options = await context.newPage();
  const page = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.getByText('尚未授权 JumpServer 站点。').waitFor();
  async function addSite(site) {
    await options.locator('#origin').fill(site);
    await options.getByRole('button', { name: '添加或授权站点', exact: true }).click();
    await options.getByText(site, { exact: true }).waitFor();
  }
  await addSite(origin);
  // First-run path: the empty state can seed real commands with one click.
  await options.getByRole('button', { name: '用示例命令库试用' }).click();
  await options.getByText('示例命令已添加，可以按需修改或删除。').waitFor();
  await options.getByText('当前共 3 条快捷命令').waitFor();
  await options.getByLabel('全选命令').check();
  options.once('dialog', dialog => dialog.accept());
  await options.getByRole('button', { name: '删除所选' }).click();
  await options.getByText('已删除 3 条命令。').waitFor();
  const worker = context.serviceWorkers()[0];
  await worker.evaluate(async () => {
    const { sites } = await chrome.storage.local.get('sites');
    const [{ groups, ...legacySite }] = sites;
    await chrome.storage.local.set({ site: legacySite });
    await chrome.storage.local.remove('sites');
  });
  await options.reload();
  await options.getByText(origin, { exact: true }).waitFor();
  await addSite(otherOrigin);
  await options.getByText(origin, { exact: true }).waitFor();
  const example = JSON.parse(await readFile(new URL('../examples/commands.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateLibrary(example), example);
  for (const sourceId of ['local', '__proto__', 'nested/path']) {
    assert.throws(() => validateLibrary({ ...example, sourceId }));
  }
  const invalidColor = structuredClone(example);
  invalidColor.groups[0].commands[0].color = 'constructor';
  assert.throws(() => validateLibrary(invalidColor));
  const legacy = { ...example, sourceId: `securecrt-${'a'.repeat(32)}` };
  assert.equal(validateLibrary(legacy).sourceId, legacy.sourceId);

  const initial = {
    version: 1, sourceId: 'fixture-library',
    groups: [
      { id: 'group-one', name: 'First group', commands: [
        { id: 'path', name: 'Fixture path', command: 'pwd' },
        { id: 'user', name: 'Fixture user', command: 'whoami' },
      ] },
      { id: 'group-two', name: 'Second group', commands: [
        { id: 'echo', name: 'Fixture echo', command: 'echo fixture' },
      ] },
    ],
  };
  async function importFile(data, summary) {
    await options.bringToFront();
    await options.locator('#file').setInputFiles({
      name: 'fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)),
    });
    await options.getByText(summary, { exact: true }).waitFor();
    await options.getByRole('button', { name: '确认导入' }).click();
    await options.getByText('命令库已更新。').waitFor();
  }
  await importFile(initial, '新增 3 条 · 删除 0 条 · 修改 0 条');
  await importFile(initial, '新增 0 条 · 删除 0 条 · 修改 0 条');
  await options.getByText('当前共 3 条快捷命令').waitFor();
  const updated = structuredClone(initial);
  updated.groups[0].commands[0].command = 'pwd -P';
  updated.groups[0].commands.pop();
  updated.groups[1].commands.push({ id: 'date', name: 'Fixture date', command: 'date', color: 'amber' });
  await importFile(updated, '新增 1 条 · 删除 1 条 · 修改 1 条');

  await page.bringToFront();
  await page.goto(`${origin}/luna/`);
  await page.locator('#winContainer > [data-sshpad]').waitFor();
  assert(await page.locator('[data-sshpad]').evaluate(bar => {
    const { top, bottom } = bar.getBoundingClientRect();
    return top > innerHeight * 0.8 && bottom <= innerHeight;
  }));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Accessibility.enable');
  async function nodes() {
    return (await cdp.send('Accessibility.getFullAXTree')).nodes;
  }
  async function button(name, disabled = false) {
    return until(async () => (await nodes()).find(node => node.role?.value === 'button' && node.name?.value === name &&
      Boolean(node.properties?.find(property => property.name === 'disabled')?.value.value) === disabled), name);
  }
  async function commandQuad(name) {
    const node = await button(name);
    const { quads } = await cdp.send('DOM.getContentQuads', { backendNodeId: node.backendDOMNodeId });
    return quads[0];
  }
  async function click(name) {
    const [x1, y1, , , x3, y3] = await commandQuad(name);
    await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
  }
  async function status(text) {
    await until(async () => (await nodes()).some(node => String(node.name?.value).includes(text)), text);
  }
  const received = () => page.evaluate(() => window.received.map(({ id, command }) => [id, command]));
  const fixtureButtons = ['Fixture path', 'Fixture echo', 'Fixture date'];
  for (const name of fixtureButtons) await button(name);
  assert.deepEqual((await nodes()).filter(node => node.role?.value === 'button' && node.name?.value.startsWith('Fixture '))
    .map(node => node.name.value), fixtureButtons);
  await click('Fixture path');
  await until(async () => (await received()).length === 1, 'A received one submission');
  assert.deepEqual(await received(), [['A', 'pwd -P\r']]);
  await page.waitForFunction(() => document.activeElement === document.querySelector('#ko-A') &&
    document.activeElement.contentDocument.activeElement.id === 'terminal-input');
  await page.keyboard.type('fixture-user');
  assert.equal(await page.frameLocator('#ko-A').locator('#terminal-input').inputValue(), 'fixture-user');
  assert.equal(await page.frameLocator('#ko-B').locator('#terminal-input').inputValue(), '');
  assert.deepEqual(await received(), [['A', 'pwd -P\r']]);

  await page.getByRole('button', { name: 'Tab B' }).click();
  await page.waitForFunction(() => document.querySelector('#View_B.active'));
  // Wait for the displayed target sampled by the real extension to update.
  await wait(800);
  await click('Fixture echo');
  await until(async () => (await received()).length === 2, 'B received one submission');
  assert.deepEqual(await received(), [['A', 'pwd -P\r'], ['B', 'echo fixture\r']]);

  await page.evaluate(() => window.split());
  await button('Fixture path', true);
  await status('当前标签有分屏');
  await page.evaluate(() => document.querySelector('#extra-pane').remove());
  await button('Fixture path');

  // Change tabs during the real mouse click, ahead of the worker's send.
  await page.evaluate(() => document.addEventListener('click', event => {
    if (event.composedPath().some(node => node.dataset?.sshpad !== undefined)) window.activate('A');
  }, { capture: true, once: true }));
  await click('Fixture path');
  await status('当前 SSH 终端已切换');
  assert.equal((await received()).length, 2);

  await page.evaluate(() => { document.querySelector('#ko-A').contentWindow.state.connection.socket.readyState = WebSocket.CLOSED; });
  await button('Fixture path', true);
  await status('未连接或已断开');
  await page.evaluate(() => {
    document.querySelector('#ko-A').contentWindow.state.connection.socket.readyState = WebSocket.OPEN;
    document.querySelector('#winContainer').classList.remove('batch-input');
  });
  await status('Luna 未启用');
  await page.evaluate(() => {
    document.querySelector('#winContainer').classList.add('batch-input');
    document.querySelector('#ko-A').contentWindow.state.clipboard.defaultAccess.paste.enabled = false;
  });
  await status('KoKo 会话未允许');
  await button('Fixture path', true);

  await page.reload();
  await page.locator('#winContainer > [data-sshpad]').waitFor();
  await click('Fixture path');
  await until(async () => (await received()).length === 1, 'A received persisted command after page refresh');
  assert.deepEqual(await received(), [['A', 'pwd -P\r']]);
  async function saveCommand(name, command, setup) {
    if (setup) await setup();
    await options.getByLabel('命令名称').fill(name);
    await options.getByLabel('单行命令').fill(command);
    await options.getByRole('button', { name: '保存命令' }).click();
    await options.locator('#command-dialog').waitFor({ state: 'hidden' });
  }

  await options.bringToFront();
  await options.getByRole('button', { name: '添加命令' }).click();
  await saveCommand('Fixture manual', 'echo manual && whoami', async () => {
    await options.getByLabel('分组', { exact: true }).selectOption({ label: 'First group' });
    await options.getByRole('radio', { name: '绿色' }).check();
  });
  await options.getByRole('button', { name: '添加命令' }).click();
  await saveCommand('Fixture local', 'printf local', async () => {
    await options.getByLabel('分组', { exact: true }).selectOption({ label: '新建分组' });
    await options.getByLabel('新分组名称').fill('Local group');
  });
  await options.getByRole('button', { name: '编辑 Fixture path' }).click();
  await saveCommand('Fixture edited', 'pwd -L');
  options.once('dialog', dialog => dialog.accept());
  await options.getByRole('button', { name: '删除 Fixture echo' }).click();
  await options.getByRole('button', { name: '删除 Fixture echo' }).waitFor({ state: 'detached' });
  await options.getByText('当前共 4 条快捷命令').waitFor();

  // Upstream edits of locally edited and deleted records must not undo the local actions.
  const incoming = structuredClone(updated);
  incoming.groups[0].commands[0].command = 'pwd --';
  incoming.groups[1].commands[0].command = 'echo upstream';
  await importFile(incoming, '新增 0 条 · 删除 0 条 · 修改 0 条');
  await options.reload();
  await options.getByText('当前共 4 条快捷命令').waitFor();
  assert.equal(await options.getByRole('button', { name: '删除 Fixture echo' }).count(), 0);
  await page.bringToFront();
  await page.setViewportSize({ width: 330, height: 650 });
  await page.reload();
  const wrappedButtons = ['Fixture edited', 'Fixture manual', 'Fixture date', 'Fixture local'];
  const quads = await Promise.all(wrappedButtons.map(commandQuad));
  assert(quads.at(-1)[1] > quads[0][1], 'Later buttons wrap onto a lower row');
  assert(quads.every((quad, index) => index === 0 || quad[1] >= quads[index - 1][1]), 'Wrapping keeps command order');
  assert(quads.every(quad => quad[0] >= 0 && quad[2] <= 330), 'Buttons fit horizontally');
  assert.equal((await nodes()).filter(node => node.name?.value === 'Fixture echo').length, 0);
  await click('Fixture manual');
  await until(async () => (await received()).length === 1, 'Manual command sent');
  await click('Fixture edited');
  await until(async () => (await received()).length === 2, 'Edited command sent');
  assert.deepEqual(await received(), [['A', 'echo manual && whoami\r'], ['A', 'pwd -L\r']]);
  await options.bringToFront();
  const otherSite = options.locator('#site-list li').filter({ hasText: otherOrigin });
  await otherSite.getByRole('button', { name: '显示分组' }).click();
  await options.getByLabel('显示所有分组（含以后新增）').uncheck();
  await options.getByLabel('First group', { exact: true }).uncheck();
  await options.getByLabel('Local group', { exact: true }).uncheck();
  await options.getByRole('button', { name: '保存分组设置' }).click();
  await otherSite.getByText('已选 1 个分组').waitFor();
  const otherPage = await context.newPage();
  await otherPage.goto(`${otherOrigin}/luna/`);
  await otherPage.locator('[data-sshpad]').waitFor();
  const otherCDP = await context.newCDPSession(otherPage);
  const otherNames = async () => (await otherCDP.send('Accessibility.getFullAXTree')).nodes
    .filter(node => node.role?.value === 'button' && node.name?.value.startsWith('Fixture '))
    .map(node => node.name.value);
  await until(async () => (await otherNames()).length, 'Site-specific commands render');
  assert.deepEqual(await otherNames(), ['Fixture date']);
  await page.bringToFront();
  await button('Fixture manual');

  await options.bringToFront();
  const editDate = options.getByRole('button', { name: '编辑 Fixture date' });
  await editDate.click();
  assert(await options.getByRole('radio', { name: '琥珀色' }).isChecked());
  await options.getByRole('radio', { name: '红色' }).check();
  await options.getByRole('button', { name: '保存命令' }).click();
  await options.locator('#command-dialog').waitFor({ state: 'hidden' });
  await options.locator('.color-badge[data-color="red"]').getByText('红色').waitFor();
  await editDate.click();
  await options.getByRole('radio', { name: '默认' }).check();
  await options.getByRole('button', { name: '保存命令' }).click();
  await options.locator('.color-badge[data-color="red"]').waitFor({ state: 'detached' });
  await editDate.click();
  assert(await options.getByRole('radio', { name: '默认' }).isChecked());
  await options.getByRole('radio', { name: '红色' }).check();
  await options.getByRole('button', { name: '保存命令' }).click();
  await options.locator('#command-dialog').waitFor({ state: 'hidden' });

  async function renameGroup(oldName, newName) {
    await options.getByRole('button', { name: `重命名分组 ${oldName}` }).click();
    await options.getByLabel('分组名称', { exact: true }).fill(newName);
    await options.getByRole('button', { name: '保存分组名称' }).click();
    await options.getByRole('button', { name: `重命名分组 ${newName}` }).waitFor();
  }
  await renameGroup('Second group', 'Reviewed group');
  await renameGroup('Local group', 'Local renamed');
  await otherSite.getByRole('button', { name: '显示分组' }).click();
  assert(await options.getByLabel('Reviewed group', { exact: true }).isChecked());
  assert(!await options.getByLabel('Local renamed', { exact: true }).isChecked());
  await options.locator('#cancel-site-groups').click();

  incoming.groups[1].name = 'Upstream group';
  incoming.groups[1].commands.find(entry => entry.id === 'date').command = 'date -u';
  incoming.groups[1].commands.find(entry => entry.id === 'date').color = 'purple';
  await importFile(incoming, '新增 0 条 · 删除 0 条 · 修改 1 条');
  await options.reload();
  await options.getByRole('button', { name: '重命名分组 Reviewed group' }).waitFor();
  await options.locator('.color-badge[data-color="green"]').getByText('绿色').waitFor();
  await otherPage.bringToFront();
  assert.deepEqual(await otherNames(), ['Fixture date']);
  await page.bringToFront();
  await status('Reviewed group');
  await until(async () => {
    const current = (await nodes()).find(node => node.name?.value === 'Fixture date' && node.role?.value === 'button');
    if (!current) return false;
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: current.backendDOMNodeId });
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function () {
        return this.textContent === 'Fixture date' && this.title === 'Fixture date\\ndate -u' &&
          getComputedStyle(this).backgroundColor === 'rgb(125, 34, 43)';
      }`,
      returnByValue: true,
    });
    return result.value;
  }, 'Red command displays its original name and updated command');
  await click('Fixture date');
  await until(async () => (await received()).length === 3, 'Colored command submits once');
  assert.deepEqual((await received()).at(-1), ['A', 'date -u\r']);

  // ---- Event-driven refresh, filtering and credential confirmation ----
  // The bar must react to a library change pushed by the worker, with no poll.
  await page.bringToFront();
  const beforePush = await received();
  await options.bringToFront();
  await page.evaluate(() => { window.barSyncs = 0; });
  await options.getByRole('button', { name: '添加命令' }).click();
  await saveCommand('Fixture pushed', 'echo pushed');
  await page.bringToFront();
  await until(async () => (await nodes()).some(node => node.name?.value === 'Fixture pushed'), 'Pushed command appears');

  // Filtering narrows the bar without touching the terminal.
  const search = page.locator('aside[data-sshpad] input.search');
  await page.locator('aside[data-sshpad] button[aria-label="筛选快捷命令"]').click();
  await search.waitFor();
  await search.fill('pushed');
  await until(async () => {
    const names = (await nodes()).filter(node => node.role?.value === 'button' &&
      String(node.name?.value).startsWith('Fixture ')).map(node => node.name.value);
    return names.length === 1 && names[0] === 'Fixture pushed';
  }, 'Filtering keeps only the match');
  await search.press('Escape');
  await until(async () => (await nodes()).some(node => node.name?.value === 'Fixture date'), 'Escape restores the full bar');
  assert.equal(await search.isVisible(), false);

  // A shortcut carrying a literal secret needs a second click.
  await options.bringToFront();
  await options.getByRole('button', { name: '添加命令' }).click();
  await saveCommand('Fixture secret', 'MYSQL_PWD=hunter2 mysql -hdb -u a');
  await page.bringToFront();
  await button('Fixture secret');
  const secretBefore = (await received()).length;
  await click('Fixture secret');
  await status('再点一次提交');
  assert.equal((await received()).length, secretBefore, 'A credential shortcut does not fire on the first click');
  await click('Fixture secret');
  await until(async () => (await received()).length === secretBefore + 1, 'Second click submits the secret shortcut');
  assert.deepEqual((await received()).at(-1), ['A', 'MYSQL_PWD=hunter2 mysql -hdb -u a\r']);

  // Layout invariant: buttons and the tools column must never share pixels on
  // a row, and no wrapped row may end far short of the tools column.
  const layout = await page.evaluate(() => {
    const root = document.querySelector('[data-sshpad]').shadowRoot;
    const toolsEl = root.querySelector('.tools');
    const groupsEl = root.querySelector('.groups');
    const buttons = [...root.querySelectorAll('.groups button')];
    const toolsBox = toolsEl.getBoundingClientRect();
    const groupsBox = groupsEl.getBoundingClientRect();
    const rows = new Map();
    for (const button of buttons) {
      const box = button.getBoundingClientRect();
      const key = Math.round(box.top);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(box);
    }
    const overlap = buttons.some(button => {
      const box = button.getBoundingClientRect();
      return box.right > toolsBox.left + 1 && box.top < toolsBox.bottom && box.bottom > toolsBox.top;
    });
    return {
      overlap,
      withinGroups: buttons.every(button => button.getBoundingClientRect().right <= groupsBox.right + 1),
      rowCount: rows.size,
      hasTools: Boolean(toolsEl),
    };
  });
  assert.equal(layout.overlap, false, 'Buttons must not overlap the tools column');
  assert.equal(layout.withinGroups, true, 'Buttons must stay inside the wrapping column');

  await options.bringToFront();
  await options.getByLabel('全选命令').check();
  await options.getByText('已选 6 条').waitFor();
  await options.getByLabel('全选命令').uncheck();
  await options.getByLabel('选择分组 First group').check();
  await options.getByLabel('选择命令 Fixture local').check();
  await options.getByText('已选 5 条').waitFor();
  options.once('dialog', dialog => dialog.accept());
  await options.getByRole('button', { name: '删除所选' }).click();
  await options.getByText('已删除 5 条命令。').waitFor();
  await options.getByText('当前共 1 条快捷命令').waitFor();
  await importFile(incoming, '新增 0 条 · 删除 0 条 · 修改 0 条');
  await options.getByText('当前共 1 条快捷命令').waitFor();
  await otherSite.getByRole('button', { name: '移除站点' }).click();
  await otherSite.waitFor({ state: 'detached' });
  await otherPage.bringToFront();
  await otherPage.locator('[data-sshpad]').waitFor({ state: 'detached' });
  await otherPage.reload();
  assert.equal(await otherPage.locator('[data-sshpad]').count(), 0);
  await page.bringToFront();
  await button('Fixture date');
  await page.goto(`${origin}/outside/`);
  assert.equal(await page.locator('[data-sshpad]').count(), 0);

  // Reproduce the unpacked reload after an extension update. Chrome clears
  // dynamic registrations, while the authorized site and library persist.
  const updateManifest = { ...manifest, version: `${manifest.version}.1` };
  await writeFile(manifestPath, JSON.stringify(updateManifest));
  const reloaded = await browserCDP.send('Extensions.loadUnpacked', { path: extension });
  assert.equal(reloaded.id, id);
  const updatedOptions = await context.newPage();
  await updatedOptions.goto(`chrome-extension://${id}/options.html`);
  assert.equal(await updatedOptions.evaluate(() => chrome.runtime.getManifest().version), updateManifest.version);
  await until(() => updatedOptions.evaluate(async () => {
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: ['sshpad-bar'] });
    return registered.length === 1;
  }), 'Registered content script after an unpacked update');
  await updatedOptions.getByText('当前共 1 条快捷命令').waitFor();
  await page.bringToFront();
  await page.goto(`${origin}/luna/?login_to=fixture`);
  await button('Fixture date');
  // Run a Send String recipe from the command editor through the KoKo iframe.
  const sendString = String.raw`sudo git pull\n\pfixture-user`;
  assert.deepEqual(parseSendString(sendString + String.raw`\n`), parseSendString(sendString));
  assert(!usesSendString(sendString, 'shell'));
  assert(!usesSendString(String.raw`printf '%s' '\n\p'`));
  assert(!usesSendString(String.raw`printf \\n\p`));
  await updatedOptions.bringToFront();
  await updatedOptions.getByRole('button', { name: '添加命令' }).click();
  await updatedOptions.getByLabel('分组', { exact: true }).selectOption({ label: 'Reviewed group' });
  await updatedOptions.getByLabel('命令名称').fill('Fixture Send String');
  assert.equal(await updatedOptions.getByLabel('发送模式').inputValue(), 'auto');
  await updatedOptions.getByLabel('单行命令').fill(sendString);
  await updatedOptions.getByRole('button', { name: '保存命令' }).click();
  await updatedOptions.locator('#command-dialog').waitFor({ state: 'hidden' });
  await updatedOptions.reload();
  await updatedOptions.getByRole('button', { name: '编辑 Fixture Send String' }).click();
  assert.equal(await updatedOptions.getByLabel('发送模式').inputValue(), 'auto');
  assert.equal(await updatedOptions.getByLabel('单行命令').inputValue(), sendString);
  await updatedOptions.locator('#cancel-command').click();

  await page.bringToFront();
  await page.evaluate(() => {
    document.querySelector('#ko-A').contentWindow.state.clipboard.defaultAccess.paste.textLimit = 13;
  });
  await status('Reviewed group');
  await button('Fixture Send String', true);
  assert.deepEqual(await received(), []);
  await page.evaluate(() => {
    document.querySelector('#ko-A').contentWindow.state.clipboard.defaultAccess.paste.textLimit = 14;
  });
  await click('Fixture Send String');
  await until(async () => (await received()).length === 2, 'Send String submits both lines');
  assert.deepEqual(await received(), [['A', 'sudo git pull\r'], ['A', 'fixture-user\r']]);
  const delay = await page.evaluate(() => window.received[1].time - window.received[0].time);
  assert(delay >= 950, `Expected a one-second pause, measured ${delay} ms`);

  await click('Fixture Send String');
  await page.waitForFunction(() => window.received.length === 3, undefined, { timeout: 750 });
  await page.getByRole('button', { name: 'Tab B' }).click();
  await status('当前 SSH 终端已切换');
  assert.deepEqual(await received(), [['A', 'sudo git pull\r'], ['A', 'fixture-user\r'], ['A', 'sudo git pull\r']]);

  // ---- Reordering, undo, export and folding ----
  const barNames = async () => (await nodes()).filter(node => node.role?.value === 'button' &&
    String(node.name?.value).startsWith('Fixture ')).map(node => node.name.value);
  await updatedOptions.bringToFront();
  await updatedOptions.getByRole('button', { name: '添加命令' }).click();
  await updatedOptions.getByLabel('分组', { exact: true }).selectOption({ label: 'Reviewed group' });
  await updatedOptions.getByLabel('命令名称').fill('Fixture second');
  // The editor previews the button as it will appear on the bar.
  assert.equal(await updatedOptions.locator('#command-preview').textContent(), 'Fixture second');
  await updatedOptions.getByRole('radio', { name: '绿色' }).check();
  assert.equal(await updatedOptions.locator('#command-preview').getAttribute('data-tone'), 'green');
  await updatedOptions.getByLabel('单行命令').fill('echo second');
  await updatedOptions.getByRole('button', { name: '保存命令' }).click();
  await updatedOptions.locator('#command-dialog').waitFor({ state: 'hidden' });
  await page.bringToFront();
  await until(async () => (await barNames()).includes('Fixture second'), 'New command reaches the bar');
  const barBefore = await barNames();
  assert.deepEqual([...barBefore].sort(), ['Fixture Send String', 'Fixture date', 'Fixture second']);
  const secondAt = barBefore.indexOf('Fixture second');
  assert(secondAt > 0, 'The new command is not first, so it can move up');
  const moved = [...barBefore];
  [moved[secondAt - 1], moved[secondAt]] = [moved[secondAt], moved[secondAt - 1]];

  await updatedOptions.bringToFront();
  const handle = updatedOptions.getByRole('button', { name: '拖动排序 Fixture second' });
  await handle.focus();
  await handle.press('ArrowUp');
  await updatedOptions.getByText('顺序已保存。').waitFor();
  await page.bringToFront();
  await until(async () => (await barNames()).join() === moved.join(), 'Reorder reaches the bar');
  // The saved order survives a reload of the settings page.
  await updatedOptions.bringToFront();
  await updatedOptions.reload();
  const rowNames = () => updatedOptions.locator('.command-row .command-detail strong').allTextContents();
  assert.deepEqual(await rowNames(), moved);

  // Deleting no longer asks first; the toast offers Undo instead.
  await updatedOptions.getByRole('button', { name: '删除 Fixture second' }).click();
  await updatedOptions.getByText('命令已删除。').waitFor();
  assert.deepEqual(await rowNames(), moved.filter(name => name !== 'Fixture second'));
  await updatedOptions.getByRole('button', { name: '撤销' }).click();
  await updatedOptions.getByText('已撤销。').waitFor();
  assert.deepEqual(await rowNames(), moved);

  // Export writes one importable file that keeps the order and the colour.
  const [download] = await Promise.all([
    updatedOptions.waitForEvent('download'),
    updatedOptions.getByRole('button', { name: '导出 JSON' }).click(),
  ]);
  const exported = validateLibrary(JSON.parse(await readFile(await download.path(), 'utf8')));
  const exportedCommands = exported.groups.flatMap(group => group.commands);
  assert.deepEqual(exportedCommands.map(entry => entry.name), moved);
  assert.equal(exportedCommands.find(entry => entry.name === 'Fixture second').color, 'green');

  // A group folds from its label on the bar and the choice survives a reload.
  await page.bringToFront();
  await until(async () => (await barNames()).length === 3, 'All commands visible before folding');
  await click('Reviewed group');
  await until(async () => (await barNames()).length === 0, 'Folding hides the group commands');
  await page.reload();
  await page.locator('#winContainer > [data-sshpad]').waitFor();
  await until(async () => (await nodes()).some(node => node.role?.value === 'button' && node.name?.value === 'Reviewed group 3'), 'Folded group persists');
  assert.equal((await barNames()).length, 0);
  await click('Reviewed group 3');
  await until(async () => (await barNames()).length === 3, 'Unfolding restores the commands');

  // Dark footer chrome right above the bar is adopted; light surfaces are ignored.
  await page.evaluate(() => {
    document.querySelector('.footer-bar').style.backgroundColor = 'rgb(18, 22, 29)';
  });
  // Reloading the unpacked extension while Luna is already open hot-swaps the bar
  // in place without throwing Extension context invalidated or requiring refresh.
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: `${manifest.version}.2` }));
  await browserCDP.send('Extensions.loadUnpacked', { path: extension });
  await until(async () => await page.locator('[data-sshpad]').evaluate(
    bar => getComputedStyle(bar).backgroundColor === 'rgb(18, 22, 29)'), 'Hot-reloaded bar adopts Luna footer dark colour');
  assert.equal(await page.locator('[data-sshpad]').count(), 1, 'Only one bar remains after hot-reload');
  const beforeHotClick = (await received()).length;
  await click('Fixture date');
  await until(async () => (await received()).length === beforeHotClick + 1, 'Hot-reloaded bar submits without page refresh');
  assert.deepEqual(pageErrors, []);

  console.log('Chrome MV3 fixture passed: authorization scope, import/diff, order, A/B targeting, single CR, terminal focus for interactive input, split, race, disconnect, permissions, refresh, wrapping, and manual management, bulk delete, legacy settings, independent site groups, color presets and original button labels, group renaming, unpacked extension update, live hot-reload, footer colour adoption, and delayed Send String submissions, reordering, undo, export and folding.');
} finally {
  await Promise.allSettled(contexts.map(context => context.close()));
  for (const server of servers) server.close();
  await rm(scratch, { recursive: true, force: true });
}