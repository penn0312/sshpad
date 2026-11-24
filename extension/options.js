import { commandColors, diffLibrary, exportLibrary, libraryWithEdits, orderedSources, validateCommand, validateLibrary, validateName } from './library.js';
import { setupSites } from './site-settings.js';

const view = id => document.getElementById(id);
let pending = null;
let fileSelection = 0;
let libraries = {};
let editing = null;
let renaming = null;
let mutating = false;
let query = '';
let collapsed = new Set();
let collapseMode = false;

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response.error) throw new Error(response.error);
  return response;
}

// Library-level feedback. A deletion also gets an Undo button next to the text
// and keeps it for a while; everything else is a plain message.
let sayTimer = 0;
function say(text, undo) {
  const node = view('manage-status');
  clearTimeout(sayTimer);
  node.replaceChildren();
  if (!text) return;
  const message = document.createElement('span');
  message.textContent = text;
  node.append(message);
  if (!undo) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'toast-action';
  button.textContent = '撤销';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      showLibraries((await request({ type: 'restore', ...undo })).libraries);
      say('已撤销。');
    } catch (error) {
      say(error.message);
    }
  });
  node.append(button);
  sayTimer = setTimeout(() => say(''), 10000);
}

// What an undo needs: the sources that changed, as they were, and the revision
// each one has now so the worker can refuse if anything moved in between.
function undoFor(previous, next) {
  const before = {};
  const expected = {};
  for (const id of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (previous[id]?.revision === next[id]?.revision) continue;
    before[id] = previous[id] ?? null;
    expected[id] = next[id]?.revision ?? null;
  }
  return { before, expected };
}

const siteSettings = setupSites(request);
let commandChecks = [];
let groupChecks = [];

function updateSelection() {
  function summarize(checkbox, commands) {
    const selected = commands.filter(item => item.checkbox.checked).length;
    checkbox.checked = commands.length > 0 && commands.length === selected;
    checkbox.indeterminate = selected > 0 && selected < commands.length;
    return selected;
  }
  for (const group of groupChecks) summarize(group.checkbox, group.commands);
  const count = summarize(view('select-all'), commandChecks);
  view('selection-count').textContent = `已选 ${count} 条`;
  view('delete-selected').disabled = !count || mutating;
}

function toggleSelection(commands, checked) {
  for (const item of commands) item.checkbox.checked = checked;
  updateSelection();
}

view('select-all').addEventListener('change', event => toggleSelection(commandChecks, event.target.checked));
view('delete-selected').addEventListener('click', async () => {
  const targets = commandChecks.filter(item => item.checkbox.checked).map(item => item.target);
  if (!targets.length || mutating) return;
  mutating = true;
  updateSelection();
  try {
    const previous = libraries;
    const result = await request({ type: 'delete-commands', targets });
    showLibraries(result.libraries);
    say(`已删除 ${targets.length} 条命令。`, undoFor(previous, result.libraries));
  } catch (error) {
    say(error.message);
  } finally {
    mutating = false;
    updateSelection();
  }
});

// ---- Reordering ----------------------------------------------------------
// Drag with the mouse, or focus a handle and press the arrow keys. Both move the
// real DOM node first (instant feedback) and then persist the resulting order.
let dragging = null;
let sorting = false;
let focusKey = null;
let commitTimer = 0;

async function persistOrder(message, snapshot) {
  sorting = true;
  try {
    showLibraries((await request({ type: 'reorder', ...message })).libraries);
  } catch (error) {
    say(error.message);
    showLibraries(libraries);
  } finally {
    sorting = false;
  }
  if (snapshot) say('顺序已保存。');
}

function makeSortable({ item, handle, siblings, ids, message }) {
  const order = ids();
  const commit = () => {
    const next = ids();
    if (next.length === order.length && next.every((id, index) => id === order[index])) return;
    persistOrder({ ...message(), ids: next }, true);
  };
  handle.addEventListener('pointerdown', () => { item.draggable = true; });
  handle.addEventListener('pointerup', () => { if (!dragging) item.draggable = false; });
  item.addEventListener('dragstart', event => {
    if (!item.draggable || sorting) { event.preventDefault(); return; }
    event.stopPropagation();
    dragging = item;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', '');
    requestAnimationFrame(() => item.classList.add('dragging'));
  });
  item.addEventListener('dragover', event => {
    if (!dragging || dragging === item || !siblings(dragging).includes(item)) return;
    event.preventDefault();
    event.stopPropagation();
    const box = item.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    item.parentNode.insertBefore(dragging, after ? item.nextSibling : item);
  });
  item.addEventListener('dragend', event => {
    if (dragging !== item) return;
    event.stopPropagation();
    dragging = null;
    item.draggable = false;
    item.classList.remove('dragging');
    commit();
  });
  handle.addEventListener('keydown', event => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    if (sorting) return;
    const list = siblings(item);
    const index = list.indexOf(item);
    const target = list[index + (event.key === 'ArrowUp' ? -1 : 1)];
    if (!target) return;
    item.parentNode.insertBefore(item, event.key === 'ArrowUp' ? target : target.nextSibling);
    handle.focus();
    focusKey = handle.dataset.key;
    clearTimeout(commitTimer);
    commitTimer = setTimeout(commit, 350);
  });
}

function dragHandle(label, key) {
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'drag-handle';
  handle.dataset.key = key;
  handle.title = '拖动排序，或聚焦后按 ↑ ↓';
  handle.setAttribute('aria-label', label);
  return handle;
}

function matchesQuery(entry, groupName) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return entry.name.toLowerCase().includes(needle) ||
    entry.command.toLowerCase().includes(needle) ||
    groupName.toLowerCase().includes(needle);
}

function showLibraries(next = {}) {
  libraries = next;
  siteSettings.setLibraries(next);
  commandChecks = [];
  groupChecks = [];
  const fragment = document.createDocumentFragment();
  const groupSorters = [];
  const rowSorters = [];
  let count = 0;
  for (const source of orderedSources(libraries)) {
    for (const group of libraryWithEdits(source).groups) {
      const visible = group.commands.filter(entry => matchesQuery(entry, group.name));
      if (query && !visible.length) continue;
      const section = document.createElement('section');
      section.className = 'command-group';
      const isCollapsed = !query && collapsed.has(group.id);
      if (isCollapsed) section.dataset.collapsed = '';
      const title = document.createElement('h3');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'disclosure';
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
      toggle.setAttribute('aria-label', `${isCollapsed ? '展开' : '折叠'}分组 ${group.name}`);
      toggle.textContent = isCollapsed ? '\u25B8' : '\u25BE';
      toggle.addEventListener('click', () => {
        if (collapsed.has(group.id)) collapsed.delete(group.id);
        else collapsed.add(group.id);
        showLibraries(libraries);
      });
      const groupLabel = document.createElement('label');
      groupLabel.className = 'checkbox';
      const groupCheck = document.createElement('input');
      groupCheck.type = 'checkbox';
      groupCheck.setAttribute('aria-label', `选择分组 ${group.name}`);
      const groupCount = document.createElement('span');
      groupCount.className = 'group-count';
      groupCount.textContent = String(group.commands.length);
      groupLabel.append(groupCheck, ` ${group.name} `, groupCount);
      title.append(toggle, groupLabel);
      const groupHeader = document.createElement('header');
      groupHeader.className = 'group-header';
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'secondary';
      rename.textContent = '重命名';
      rename.setAttribute('aria-label', `重命名分组 ${group.name}`);
      const groupTarget = { sourceId: source.library.sourceId, groupId: group.id, revision: source.revision };
      rename.addEventListener('click', () => openGroupEditor(group.name, groupTarget));
      section.dataset.source = groupTarget.sourceId;
      section.dataset.id = group.id;
      if (!query) {
        const handle = dragHandle(`拖动排序分组 ${group.name}`, `group:${groupTarget.sourceId}/${group.id}`);
        groupHeader.append(handle, title, rename);
        const sections = () => [...view('command-list').querySelectorAll(':scope > .command-group')]
          .filter(node => node.dataset.source === groupTarget.sourceId);
        groupSorters.push(() => makeSortable({
          item: section, handle, siblings: sections,
          ids: () => sections().map(node => node.dataset.id),
          message: () => ({ sourceId: groupTarget.sourceId, groupId: null, revision: libraries[groupTarget.sourceId]?.revision }),
        }));
      } else {
        groupHeader.append(title, rename);
      }
      const groupCommands = [];
      groupChecks.push({ checkbox: groupCheck, commands: groupCommands });
      groupCheck.addEventListener('change', () => toggleSelection(groupCommands, groupCheck.checked));
      const list = document.createElement('ul');
      for (const entry of visible) {
        const row = document.createElement('li');
        row.className = 'command-row';
        row.dataset.id = entry.id;
        const detail = document.createElement('div');
        detail.className = 'command-detail';
        const name = document.createElement('strong');
        name.textContent = entry.name;
        const command = document.createElement('code');
        command.textContent = entry.command;
        const heading = document.createElement('div');
        heading.className = 'command-heading';
        heading.append(name);
        if (entry.color && entry.color !== 'default') {
          const badge = document.createElement('span');
          badge.className = 'color-badge';
          badge.dataset.color = entry.color;
          badge.textContent = commandColors[entry.color];
          heading.append(badge);
        }
        detail.append(heading, command);
        const controls = document.createElement('div');
        controls.className = 'controls';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'secondary';
        edit.textContent = '编辑';
        edit.setAttribute('aria-label', `编辑 ${entry.name}`);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'secondary danger';
        remove.textContent = '删除';
        remove.setAttribute('aria-label', `删除 ${entry.name}`);
        const target = { ...groupTarget, id: entry.id };
        edit.addEventListener('click', () => openEditor(entry, target));
        remove.addEventListener('click', () => deleteCommand(entry, target));
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.setAttribute('aria-label', `选择命令 ${entry.name}`);
        checkbox.addEventListener('change', updateSelection);
        const check = { checkbox, target };
        commandChecks.push(check);
        groupCommands.push(check);
        controls.append(edit, remove);
        if (query) {
          row.append(checkbox, detail, controls);
        } else {
          const handle = dragHandle(`拖动排序 ${entry.name}`, `command:${groupTarget.sourceId}/${group.id}/${entry.id}`);
          row.append(handle, checkbox, detail, controls);
          const rowsOf = () => [...list.children];
          rowSorters.push(() => makeSortable({
            item: row, handle, siblings: rowsOf,
            ids: () => rowsOf().map(node => node.dataset.id),
            message: () => ({ sourceId: groupTarget.sourceId, groupId: group.id, revision: libraries[groupTarget.sourceId]?.revision }),
          }));
        }
        list.append(row);
        count += 1;
      }
      section.append(groupHeader, list);
      fragment.append(section);
    }
  }
  const total = orderedSources(libraries)
    .reduce((sum, source) => sum + libraryWithEdits(source).groups
      .reduce((inner, group) => inner + group.commands.length, 0), 0);
  view('count').textContent = query
    ? `匹配 ${count} 条 / 共 ${total} 条`
    : `当前共 ${total} 条快捷命令`;
  view('command-list').replaceChildren(fragment);
  // Sorters read the live DOM order, so they are wired once everything is attached.
  for (const wire of [...groupSorters, ...rowSorters]) wire();
  if (focusKey) {
    view('command-list').querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
    focusKey = null;
  }
  view('selection-controls').hidden = !total;
  view('library-tools').hidden = !total;
  view('empty-state').hidden = total > 0;
  view('add-command').disabled = false;
  view('export-library').disabled = !total;
  updateSelection();
}

function openGroupEditor(name, target) {
  if (mutating) return;
  renaming = target;
  view('group-name').value = name;
  view('group-error').textContent = '';
  view('group-dialog').showModal();
  view('group-name').select();
}

view('cancel-group').addEventListener('click', () => view('group-dialog').close());
view('group-dialog').addEventListener('cancel', event => {
  if (mutating) event.preventDefault();
});
view('group-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (mutating || !renaming) return;
  mutating = true;
  view('save-group').disabled = true;
  view('cancel-group').disabled = true;
  try {
    const name = view('group-name').value.trim();
    validateName(name, '分组名称');
    const result = await request({ type: 'rename-group', ...renaming, name });
    view('group-dialog').close();
    showLibraries(result.libraries);
    say('分组名称已保存。');
  } catch (error) {
    view('group-error').textContent = error.message;
  } finally {
    mutating = false;
    view('save-group').disabled = false;
    view('cancel-group').disabled = false;
    updateSelection();
  }
});

for (const [color, labelText] of Object.entries(commandColors)) {
  const label = document.createElement('label');
  label.className = 'color-choice';
  label.dataset.color = color;
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'color';
  radio.value = color;
  radio.defaultChecked = color === 'default';
  label.append(radio, labelText);
  view('color-choices').append(label);
}

// Live stand-in for the real bar button, so a colour or a name can be judged
// before it is saved.
function updatePreview() {
  const preview = view('command-preview');
  preview.textContent = view('command-name').value.trim() || '命令名称';
  preview.dataset.tone = view('command-form').elements.color.value || 'default';
}
view('command-name').addEventListener('input', updatePreview);
view('command-form').addEventListener('change', event => {
  if (event.target.name === 'color') updatePreview();
});

view('export-library').addEventListener('click', () => {
  try {
    const library = exportLibrary(libraries);
    const total = library.groups.reduce((sum, group) => sum + group.commands.length, 0);
    const url = URL.createObjectURL(new Blob([JSON.stringify(library, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `sshpad-commands-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say(`已导出 ${total} 条命令。`);
  } catch (error) {
    say(error.message);
  }
});

function toggleNewGroup() {
  const creatingGroup = view('command-group').value === '';
  view('new-group-field').hidden = !creatingGroup;
  view('new-group').required = creatingGroup;
}

function updateCommandMode() {
  const mode = view('command-mode').value;
  const sendString = mode === 'send-string';
  view('command-text-label').textContent = sendString ? '发送字符串内容' : '单行命令';
  view('auto-mode-help').hidden = mode !== 'auto';
  view('command-help').hidden = mode !== 'shell';
  view('send-string-help').hidden = !sendString;
}

function openEditor(entry, target) {
  if (mutating) return;
  editing = entry ? target : null;
  view('command-form').reset();
  const selector = view('command-group');
  selector.replaceChildren();
  for (const source of orderedSources(libraries)) {
    for (const group of libraryWithEdits(source).groups) {
      selector.append(new Option(group.name, `${source.library.sourceId}/${group.id}`));
    }
  }
  selector.append(new Option('新建分组', ''));
  selector.disabled = Boolean(entry);
  if (entry) selector.value = `${target.sourceId}/${target.groupId}`;
  toggleNewGroup();
  view('command-title').textContent = entry ? '编辑命令' : '添加命令';
  view('command-name').value = entry?.name ?? '';
  view('command-mode').value = entry?.mode ?? 'auto';
  view('command-text').value = entry?.command ?? '';
  updateCommandMode();
  view('command-form').elements.color.value = entry?.color ?? 'default';
  updatePreview();
  view('command-error').textContent = '';
  view('command-dialog').showModal();
  view('command-name').focus();
}

async function deleteCommand(entry, target) {
  if (mutating) return;
  mutating = true;
  try {
    const previous = libraries;
    const result = await request({ type: 'change-command', ...target, remove: true });
    showLibraries(result.libraries);
    say('命令已删除。', undoFor(previous, result.libraries));
  } catch (error) {
    say(error.message);
  } finally {
    mutating = false;
  }
}

view('add-command').addEventListener('click', () => openEditor());
view('command-group').addEventListener('change', toggleNewGroup);
view('command-mode').addEventListener('change', updateCommandMode);
view('cancel-command').addEventListener('click', () => view('command-dialog').close());
view('command-dialog').addEventListener('cancel', event => {
  if (mutating) event.preventDefault();
});
view('command-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (mutating) return;
  mutating = true;
  view('save-command').disabled = true;
  view('cancel-command').disabled = true;
  try {
    const name = view('command-name').value.trim();
    const command = view('command-text').value;
    const mode = view('command-mode').value;
    validateCommand(name, command, mode);
    const [sourceId = 'local', groupId = null] = view('command-group').value.split('/').filter(Boolean);
    const target = editing ?? { sourceId, groupId, revision: libraries[sourceId]?.revision ?? null };
    const groupName = view('new-group').value.trim();
    const color = new FormData(event.currentTarget).get('color');
    const result = await request({ type: 'change-command', ...target, name, command, mode, groupName, color });
    view('command-dialog').close();
    showLibraries(result.libraries);
    say(editing ? '命令已保存。' : '命令已添加。');
  } catch (error) {
    view('command-error').textContent = error.message;
  } finally {
    mutating = false;
    view('save-command').disabled = false;
    view('cancel-command').disabled = false;
    updateSelection();
  }
});

function clearPreview() {
  fileSelection += 1;
  pending = null;
  view('preview').hidden = true;
  view('changes').replaceChildren();
}

view('file').addEventListener('change', async () => {
  clearPreview();
  view('import-status').textContent = '';
  const selected = fileSelection;
  const file = view('file').files[0];
  if (!file) return;
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('JSON 文件超过 8 MiB。');
    let input;
    try {
      input = JSON.parse(await file.text());
    } catch {
      throw new Error('无法读取有效的 JSON 文件。');
    }
    const library = validateLibrary(input);
    const { libraries = {} } = await request({ type: 'settings' });
    if (selected !== fileSelection) return;
    const previous = Object.hasOwn(libraries, library.sourceId) ? libraries[library.sourceId] : undefined;
    pending = { library, revision: previous?.revision ?? null };
    const diff = diffLibrary(previous && libraryWithEdits(previous),
      libraryWithEdits({ ...previous, library }));
    view('summary').textContent = `新增 ${diff.added.length} 条 · 删除 ${diff.removed.length} 条 · 修改 ${diff.changed.length} 条` +
      (diff.reordered ? ' · 顺序有变动' : '');
    for (const [title, changes] of [['新增', diff.added], ['删除', diff.removed], ['修改', diff.changed]]) {
      if (!changes.length) continue;
      const list = document.createElement('ul');
      const heading = document.createElement('strong');
      heading.textContent = title;
      for (const entry of changes) {
        const item = document.createElement('li');
        item.textContent = `${entry.group} · ${entry.name}`;
        list.append(item);
      }
      view('changes').append(heading, list);
    }
    view('preview').hidden = false;
  } catch (error) {
    if (selected === fileSelection) view('import-status').textContent = error.message;
  }
});

view('cancel').addEventListener('click', () => {
  clearPreview();
  view('file').value = '';
});

view('save').addEventListener('click', async () => {
  if (!pending) return;
  view('save').disabled = true;
  view('cancel').disabled = true;
  view('file').disabled = true;
  try {
    await request({ type: 'import', ...pending });
    clearPreview();
    view('file').value = '';
    showLibraries((await request({ type: 'settings' })).libraries);
    view('import-status').textContent = '命令库已更新。';
  } catch (error) {
    view('import-status').textContent = error.message;
  } finally {
    view('save').disabled = false;
    view('cancel').disabled = false;
    view('file').disabled = false;
  }
});

view('library-search').addEventListener('input', event => {
  query = event.target.value.trim();
  showLibraries(libraries);
});
view('collapse-groups').addEventListener('change', event => {
  collapseMode = event.target.checked;
  collapsed = new Set();
  if (collapseMode) {
    for (const source of orderedSources(libraries)) {
      for (const group of libraryWithEdits(source).groups) collapsed.add(group.id);
    }
  }
  showLibraries(libraries);
});
view('add-first').addEventListener('click', () => view('add-command').click());
// Shipped with the extension so a first run needs no file picking at all.
const EXAMPLE = {
  version: 1,
  sourceId: 'example-team',
  groups: [{
    id: 'shell-basics',
    name: '示例分组',
    commands: [
      { id: 'working-directory', name: '当前目录', command: 'pwd' },
      { id: 'current-user', name: '当前用户', command: 'whoami' },
      { id: 'disk', name: '磁盘占用', command: 'df -h' },
    ],
  }],
};

view('load-example').addEventListener('click', async () => {
  try {
    await request({ type: 'import', library: validateLibrary(EXAMPLE), revision: null });
    showLibraries((await request({ type: 'settings' })).libraries);
    say('示例命令已添加，可以按需修改或删除。');
  } catch (error) {
    say(error.message);
  }
});

try {
  const { sites, libraries } = await request({ type: 'settings' });
  siteSettings.showSites(sites);
  showLibraries(libraries);
} catch (error) {
  view('site-status').textContent = error.message;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.libraries) showLibraries(changes.libraries.newValue);
});


// Highlight the nav entry of the section nearest the top of the viewport.
{
  const links = [...document.querySelectorAll('nav a[data-nav]')];
  const sections = links.map(link => view(link.dataset.nav));
  const mark = () => {
    let current = 0;
    sections.forEach((section, index) => {
      if (section.getBoundingClientRect().top <= innerHeight * 0.35) current = index;
    });
    links.forEach((link, index) => {
      if (index === current) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  };
  addEventListener('scroll', mark, { passive: true });
  addEventListener('resize', mark);
  mark();
}
