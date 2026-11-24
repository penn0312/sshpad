import { lunaOperation } from './luna.js';
import { longestSubmission, parseSendString, usesSendString } from './send-string.js';
import { libraryWithEdits, orderedSources, readSite, validateColor, validateCommand, validateLibrary, validateName, visibleLibrary } from './library.js';
import { buildCatalog } from './catalog.js';
import { credentialHint } from './sensitive.js';

const scriptId = 'sshpad-bar';
const probeId = 'sshpad-probe';
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
let mutations = Promise.resolve();

function serialize(operation) {
  const result = mutations.then(operation);
  mutations = result.catch(() => {});
  return result;
}

function hasPermission(site) {
  return chrome.permissions.contains({ origins: [site.permission] });
}

async function readSites() {
  const { sites, site } = await chrome.storage.local.get(['sites', 'site']);
  // Versions before 1.2 stored one authorized site and showed every group.
  return sites ?? (site ? [{ ...site, groups: null }] : []);
}

async function syncBarRegistration(sites) {
  const configured = [...new Set(sites.map(site => site.permission))];
  const granted = await Promise.all(configured.map(permission => hasPermission({ permission })));
  const matches = configured.filter((_, index) => granted[index]).flatMap(permission => {
    const base = permission.slice(0, -1);
    return [`${base}*luna`, `${base}*luna/*`];
  });
  if (!matches.length) {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId, probeId] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map(item => item.id) });
    return;
  }
  const scripts = [
    // The probe must run in the page's own world: KoKo's Pinia store lives in
    // the iframe's JS realm, which the isolated-world bar cannot reach.
    { id: probeId, matches, js: ['probe.js'], runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true },
    { id: scriptId, matches, js: ['bar.js'], runAt: 'document_idle', persistAcrossSessions: true },
  ];
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId, probeId] });
  const stale = scripts.filter(script => {
    const current = existing.find(item => item.id === script.id);
    return !current || JSON.stringify(current.matches) !== JSON.stringify(script.matches);
  });
  if (stale.length) {
    const updates = stale.filter(script => existing.some(item => item.id === script.id));
    const additions = stale.filter(script => !existing.some(item => item.id === script.id));
    if (updates.length) await chrome.scripting.updateContentScripts(updates);
    if (additions.length) await chrome.scripting.registerContentScripts(additions);
  }
  return matches;
}

// Re-attaches the probe and the bar to Luna tabs that are already open, so an
// extension reload or a newly authorized site does not force a page refresh
// (which would drop live JumpServer SSH sessions).
async function attachOpenTabs(sites) {
  if (!sites.length) return;
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async tab => {
    if (tab.id === undefined || !tab.url) return;
    let url;
    try { url = new URL(tab.url); } catch { return; }
    if (!/(^|\/)luna(?:\/|$)/.test(url.pathname)) return;
    const site = sites.find(item => item.origin === url.origin);
    if (!site || !await hasPermission(site)) return;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      files: ['probe.js'],
    }).catch(() => {});
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['bar.js'],
    }).catch(() => {});
  }));
}

function restoreBarRegistration(reattach = false) {
  // Chrome can clear dynamic scripts when an unpacked extension is reloaded.
  serialize(async () => {
    const sites = await readSites();
    await syncBarRegistration(sites);
    if (reattach) await attachOpenTabs(sites);
  }).catch(error => {
    console.warn('Unable to restore Luna content script registration.', error);
  });
}

async function updateSite(message) {
  const sites = await readSites();
  const site = readSite(message.origin);
  const previous = sites.find(item => item.origin === site.origin);
  if (message.type === 'site-groups') {
    const { groups } = message;
    if (!previous) throw new Error('该站点已移除。');
    if (groups !== null && (!Array.isArray(groups) || groups.some(key => typeof key !== 'string'))) {
      throw new Error('分组选择无效。');
    }
    const next = sites.map(item => item === previous ? { ...item, groups } : item);
    await chrome.storage.local.set({ sites: next });
    return { sites: next };
  }

  const removing = message.type === 'remove-site';
  if (!removing && !await hasPermission(site)) throw new Error('请先在 Chrome 确认站点授权。');
  const next = removing ? sites.filter(item => item !== previous) :
    (previous ? sites : [...sites, { ...site, groups: null }]);

  await syncBarRegistration(next);
  await chrome.storage.local.set({ sites: next });
  if (removing && previous && !next.some(item => item.permission === previous.permission)) {
    await chrome.permissions.remove({ origins: [previous.permission] });
  } else if (!removing) {
    await attachOpenTabs([site]);
  }
  return { sites: next };
}

// The bar is a plain script with no imports, so every derived field it needs
// is computed here: send-string length budgets and credential warnings.
function decorate(catalog) {
  for (const group of catalog.groups) {
    group.commands = group.commands.map(entry => {
      const decorated = { ...entry, credential: credentialHint(entry.command)?.label ?? null };
      if (!usesSendString(entry.command, entry.mode)) return decorated;
      try {
        return { ...decorated, inputLength: longestSubmission(parseSendString(entry.command)) };
      } catch {
        // A malformed legacy entry remains editable and reports its error when clicked.
        return decorated;
      }
    });
  }
  return catalog;
}

const localSource = { library: { version: 1, sourceId: 'local', groups: [] }, revision: null };
// Lexicographically monotonic so chrome.storage.local's sorted object keys keep
// newly created groups and commands in exact creation order.
let idSeq = 0;
const newId = () => Date.now().toString(36).padStart(10, '0') +
  (idSeq = (idSeq + 1) % 1679616).toString(36).padStart(4, '0') +
  crypto.randomUUID().replaceAll('-', '').slice(0, 12);

function changeEntry(change, { previous, groups, edits, colors }) {
  const { sourceId, groupId, id, remove } = change;
  const group = groups.find(item => item.id === groupId);
  const existing = group?.commands.find(entry => entry.id === id);
  if ((id && !existing) || (remove && !existing) || (groupId && !group)) {
    throw new Error('此命令或分组已更新，请重新选择。');
  }
  const entryId = id ?? newId();
  const imported = Boolean(edits[entryId]?.imported ||
    previous.library.groups.some(item => item.commands.some(entry => entry.id === entryId)));
  if (remove) {
    delete colors[id];
    if (imported) {
      edits[id] = { groupId, groupName: group.name, entry: null, imported: true };
    } else {
      delete edits[id];
    }
    return;
  }
  const { name, command, mode = 'auto', color = 'default' } = change;
  const groupName = group?.name ?? change.groupName;
  validateCommand(name, command, mode);
  validateColor(color);
  if (!group) {
    if (sourceId !== 'local') throw new Error('请选择已有分组或填写新分组。');
    validateName(groupName, '分组名称');
    if (groups.some(item => item.name === groupName)) throw new Error('已有同名本地分组。');
  }
  if (group?.commands.some(entry => entry.id !== id && entry.name === name)) {
    throw new Error('该分组中已有同名命令。');
  }
  if (color !== (existing?.color ?? 'default')) colors[entryId] = color;
  if (!existing || existing.name !== name || existing.command !== command || (existing.mode ?? 'auto') !== mode) {
    const entry = { id: entryId, name, command };
    if (mode !== 'auto') entry.mode = mode;
    if (existing?.color && !Object.hasOwn(colors, entryId)) entry.color = existing.color;
    edits[entryId] = { groupId: group?.id ?? newId(), groupName, entry, imported };
  }
}

async function changeCommands(changes) {
  const { libraries = {} } = await chrome.storage.local.get('libraries');
  const touched = new Map();
  for (const change of changes) {
    const { sourceId, revision } = change;
    const source = Object.hasOwn(libraries, sourceId) ? libraries[sourceId] : null;
    const previous = source ?? (sourceId === 'local' ? localSource : null);
    if (!previous || previous.revision !== revision) throw new Error('命令库已更新，请重新选择。');
    if (!touched.has(sourceId)) {
      touched.set(sourceId, {
        groups: libraryWithEdits(previous).groups,
        edits: { ...previous.edits },
        colors: { ...previous.colors },
        previous,
      });
    }
    changeEntry(change, touched.get(sourceId));
  }
  for (const [sourceId, { edits, colors, previous }] of touched) {
    libraries[sourceId] = { ...previous, edits, colors, revision: crypto.randomUUID() };
  }
  await chrome.storage.local.set({ libraries });
  return { libraries };
}

async function renameGroup({ sourceId, groupId, revision, name }) {
  validateName(name, '分组名称');
  const { libraries = {} } = await chrome.storage.local.get('libraries');
  const source = Object.hasOwn(libraries, sourceId) ? libraries[sourceId] : undefined;
  if (!source || source.revision !== revision) throw new Error('命令库已更新，请重新打开分组。');
  const group = libraryWithEdits(source).groups.find(item => item.id === groupId);
  if (!group) throw new Error('找不到该分组。');
  if (group.name !== name) {
    libraries[sourceId] = { ...source, groupNames: { ...source.groupNames, [groupId]: name }, revision: crypto.randomUUID() };
    await chrome.storage.local.set({ libraries });
  }
  return { libraries };
}

// Persists a drag or keyboard reorder. `ids` must be exactly the current group
// ids (groupId === null) or the current command ids of one group, so a stale
// page can never drop or resurrect entries by reordering.
async function reorder({ sourceId, groupId = null, revision, ids }) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) {
    throw new Error('排序无效。');
  }
  const { libraries = {} } = await chrome.storage.local.get('libraries');
  const source = Object.hasOwn(libraries, sourceId) ? libraries[sourceId] : undefined;
  if (!source || source.revision !== revision) throw new Error('命令库已更新，请重新排序。');
  const groups = libraryWithEdits(source).groups;
  const current = groupId === null ? groups.map(group => group.id) :
    groups.find(group => group.id === groupId)?.commands.map(entry => entry.id);
  if (!current || current.length !== ids.length || current.some(id => !ids.includes(id))) {
    throw new Error('此分组已更新，请重新排序。');
  }
  const order = { ...source.order, commands: { ...source.order?.commands } };
  if (groupId === null) order.groups = ids;
  else order.commands[groupId] = ids;
  libraries[sourceId] = { ...source, order, revision: crypto.randomUUID() };
  await chrome.storage.local.set({ libraries });
  return { libraries };
}

// Undo for deletions. `before` holds the touched sources as they were (null when
// the source did not exist) and `expected` their revisions right after the
// change; if anything moved since, the undo is refused instead of clobbering it.
async function restoreSources({ before, expected }) {
  const plain = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!plain(before) || !plain(expected)) throw new Error('无法撤销。');
  const { libraries = {} } = await chrome.storage.local.get('libraries');
  for (const [id, revision] of Object.entries(expected)) {
    const current = Object.hasOwn(libraries, id) ? libraries[id] : undefined;
    if ((current?.revision ?? null) !== revision) throw new Error('命令库已更新，无法撤销。');
  }
  for (const [id, source] of Object.entries(before)) {
    if (source === null) delete libraries[id];
    else if (plain(source) && plain(source.library)) libraries[id] = { ...source, revision: crypto.randomUUID() };
    else throw new Error('无法撤销。');
  }
  await chrome.storage.local.set({ libraries });
  return { libraries };
}

async function optionsMessage(message) {
  if (message.type === 'settings') {
    const [sites, data] = await Promise.all([readSites(), chrome.storage.local.get('libraries')]);
    return { sites, ...data };
  }
  if (message.type === 'reorder') return serialize(() => reorder(message));
  if (message.type === 'restore') return serialize(() => restoreSources(message));
  if (message.type === 'rename-group') return serialize(() => renameGroup(message));
  if (message.type === 'change-command') return serialize(() => changeCommands([message]));
  if (message.type === 'delete-commands' && Array.isArray(message.targets) && message.targets.length) {
    return serialize(() => changeCommands(message.targets.map(target => ({ ...target, remove: true }))));
  }
  if (['site', 'remove-site', 'site-groups'].includes(message.type)) return serialize(() => updateSite(message));
  if (message.type === 'import') {
    const library = validateLibrary(message.library);
    return serialize(async () => {
      const { libraries = {} } = await chrome.storage.local.get('libraries');
      const previous = Object.hasOwn(libraries, library.sourceId) ? libraries[library.sourceId] : undefined;
      if ((previous?.revision ?? null) !== message.revision) {
        throw new Error('该来源已在另一窗口更新，请重新打开文件预览。');
      }
      if (JSON.stringify(previous?.library) !== JSON.stringify(library)) {
        libraries[library.sourceId] = { ...previous, library, revision: crypto.randomUUID() };
        await chrome.storage.local.set({ libraries });
      }
      return { saved: true };
    });
  }
  throw new Error('无法识别设置操作。');
}

async function terminalMessage(message, sender) {
  const url = new URL(sender.url);
  const sites = await readSites();
  const site = sites.find(item => item.origin === url.origin);
  if (!site || sender.frameId !== 0 || !sender.documentId || sender.tab?.id === undefined ||
      !/(^|\/)luna(?:\/|$)/.test(url.pathname) || !await hasPermission(site)) {
    return { reason: '当前页面尚未获准使用扩展。', unauthorized: true };
  }
  if (message.type === 'open-options') {
    await chrome.runtime.openOptionsPage();
    return {};
  }
  const { libraries = {} } = await chrome.storage.local.get('libraries');
  const libraryForSite = source => visibleLibrary(libraryWithEdits(source), site.groups);
  // The bar is a plain script with no imports, so every derived field it needs
  // is computed here: send-string length budgets and credential warnings.
  const catalogForSite = () => decorate(buildCatalog(orderedSources(libraries).map(source => (
    { library: libraryForSite(source), revision: source.revision }))));
  if (message.type === 'library') return { catalog: catalogForSite() };

  async function run(input, longestInput = 0) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
      world: 'MAIN',
      func: lunaOperation,
      args: [site.origin, message.target ?? null, input, longestInput],
    });
    return result?.result ?? { reason: '无法读取当前 Luna 页面。' };
  }

  if (message.type === 'status') {
    const result = await run(null);
    const revisionKey = JSON.stringify([site.groups, orderedSources(libraries).map(source => source.revision)]);
    return {
      ...result,
      revisionKey,
      hasSites: sites.length > 0,
      catalog: revisionKey === message.knownRevision ? undefined : catalogForSite(),
    };
  }
  if (message.type !== 'execute') return { reason: '无法识别扩展操作。' };

  const source = Object.hasOwn(libraries, message.sourceId) ? libraries[message.sourceId] : undefined;
  const entry = source && libraryForSite(source).groups.flatMap(group => group.commands).find(item => item.id === message.id);
  if (!entry || !message.target || source.revision !== message.revision) {
    return { reason: '本地命令库已更新，请重新点击。' };
  }
  if (!usesSendString(entry.command, entry.mode)) return run(entry.command);

  let steps;
  try {
    steps = parseSendString(entry.command);
  } catch (error) {
    return { reason: error.message };
  }
  let longestInput = longestSubmission(steps);
  for (const { input, delay } of steps) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const result = await run(input, longestInput);
    if (!result.sent) return result;
    longestInput = 0;
  }
  return { sent: true };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url || !message || typeof message !== 'object') return;
  const fromOptions = sender.url === chrome.runtime.getURL('options.html');
  storageReady.then(() => fromOptions ? optionsMessage(message) : terminalMessage(message, sender))
    .then(respond, error => {
      respond(fromOptions ? { error: error.message } : { reason: '扩展无法访问当前 Luna 页面。' });
    });
  return true;
});

// Storage changes used to be discovered by a 650ms poll in every tab. Pushing
// them keeps the bar correct while letting the service worker sleep.
let pushing = Promise.resolve();
async function pushCatalogs() {
  const [sites, { libraries = {} }] = await Promise.all([
    readSites(),
    chrome.storage.local.get('libraries'),
  ]);
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async tab => {
    if (tab.id === undefined || !tab.url) return;
    let origin;
    try { origin = new URL(tab.url).origin; } catch { return; }
    const site = sites.find(item => item.origin === origin);
    // A removed site or a revoked permission must tear the bar down at once,
    // not at the next user interaction.
    if (!site || !await hasPermission(site)) {
      if (/(^|\/)luna(?:\/|$)/.test(new URL(tab.url).pathname)) {
        await chrome.tabs.sendMessage(tab.id, { type: 'detach' }).catch(() => {});
      }
      return;
    }
    const libraryForSite = source => visibleLibrary(libraryWithEdits(source), site.groups);
    const catalog = decorate(buildCatalog(orderedSources(libraries).map(source => (
      { library: libraryForSite(source), revision: source.revision }))));
    const revisionKey = JSON.stringify([site.groups, orderedSources(libraries).map(source => source.revision)]);
    await chrome.tabs.sendMessage(tab.id, {
      type: 'catalog', catalog, revisionKey, hasSites: sites.length > 0,
    }).catch(() => {});
  }));
}

function schedulePush() {
  pushing = pushing.then(pushCatalogs).catch(error => {
    console.warn('Unable to push the command library to open Luna tabs.', error);
  });
  return pushing;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!changes.libraries && !changes.sites) return;
  schedulePush();
});

chrome.runtime.onInstalled.addListener(() => restoreBarRegistration(true));
chrome.runtime.onStartup.addListener(() => restoreBarRegistration(false));
chrome.permissions.onRemoved.addListener(() => restoreBarRegistration(false));
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());