import { parseSendString, usesSendString } from './send-string.js';

const idPattern = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const controls = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u;
const credential = /(?:\$\{?[\w-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|credential)[\w-]*|(?:\{\{?|<|%|\[)[\w -]*(?:password|passwd|passphrase|secret|token|api[_-]?key|credential)[\w -]*(?:\}\}?|>|%|\]))/i;

export const commandColors = Object.freeze({
  default: '默认',
  blue: '蓝色',
  green: '绿色',
  amber: '琥珀色',
  purple: '紫色',
  red: '红色',
});

function validColor(value) {
  return typeof value === 'string' && Object.hasOwn(commandColors, value);
}

export function validateColor(value) {
  if (!validColor(value)) throw new Error('请选择预设颜色。');
}

function text(value, limit) {
  return typeof value === 'string' && value.length <= limit && value.trim() && !controls.test(value);
}

export function validateLibrary(input) {
  function requireValid(condition) {
    if (!condition) throw new Error('命令库格式错误或含有需要复核的命令。');
  }
  requireValid(input?.version === 1 && typeof input.sourceId === 'string' &&
    idPattern.test(input.sourceId) && input.sourceId !== 'local' && Array.isArray(input.groups));

  const groupIds = new Set();
  const commandIds = new Set();
  const groups = input.groups.map(group => {
    requireValid(typeof group?.id === 'string' && idPattern.test(group.id) && !groupIds.has(group.id) &&
      text(group.name, 1024) && Array.isArray(group.commands) && group.commands.length);
    groupIds.add(group.id);
    const names = new Set();
    const commands = group.commands.map(entry => {
      requireValid(typeof entry?.id === 'string' && idPattern.test(entry.id) && !commandIds.has(entry.id) &&
        text(entry.name, 1024) && !names.has(entry.name) &&
        (entry.color === undefined || validColor(entry.color)));
      validateCommand(entry.name, entry.command, entry.mode);
      commandIds.add(entry.id);
      names.add(entry.name);
      const clean = { id: entry.id, name: entry.name, command: entry.command };
      if (entry.mode === 'send-string' || entry.mode === 'shell') clean.mode = entry.mode;
      if (entry.color && entry.color !== 'default') clean.color = entry.color;
      return clean;
    });
    return { id: group.id, name: group.name, commands };
  });
  return { version: 1, sourceId: input.sourceId, groups };
}

export function validateName(value, label) {
  if (!text(value, 1024)) throw new Error(`请输入有效的${label}。`);
}

export function validateCommand(name, command, mode = 'auto') {
  validateName(name, '命令名称');
  if (!['auto', 'shell', 'send-string'].includes(mode)) throw new Error('请选择有效的发送模式。');
  if (!text(command, 65536) || credential.test(command)) {
    throw new Error('请输入单行文本，去掉换行、控制键和凭据占位符。');
  }
  if (usesSendString(command, mode)) parseSendString(command);
}

export function orderedSources(libraries) {
  const { local, ...imported } = libraries;
  return local ? [...Object.values(imported), local] : Object.values(imported);
}

export function libraryWithEdits({ library, edits = {}, groupNames = {}, colors = {} }) {
  const groups = new Map(library.groups.map(group => [group.id, {
    ...group,
    commands: new Map(group.commands.map(entry => [entry.id, entry])),
  }]));
  const originalGroups = new Map(library.groups.flatMap(group => group.commands.map(entry => [entry.id, group.id])));
  for (const [id, { groupId: savedGroup, groupName, entry }] of Object.entries(edits)) {
    const groupId = originalGroups.get(id) ?? savedGroup;
    let group = groups.get(groupId);
    if (entry && !group) {
      group = { id: groupId, name: groupName, commands: new Map() };
      groups.set(groupId, group);
    }
    if (entry) group.commands.set(id, entry);
    else group?.commands.delete(id);
  }
  return {
    ...library,
    groups: [...groups.values()].filter(group => group.commands.size).map(group => ({
      ...group,
      name: Object.hasOwn(groupNames, group.id) ? groupNames[group.id] : group.name,
      commands: [...group.commands.values()].map(entry => Object.hasOwn(colors, entry.id) ?
        { ...entry, color: colors[entry.id] } : entry),
    })),
  };
}

export function diffLibrary(previous, next) {
  const flatten = library => new Map((library?.groups ?? []).flatMap(group =>
    group.commands.map(entry => [entry.id, { ...entry, group: group.name, groupId: group.id }])));
  const oldEntries = flatten(previous);
  const newEntries = flatten(next);
  const changes = { added: [], removed: [], changed: [], reordered: false };
  for (const [id, entry] of newEntries) {
    const old = oldEntries.get(id);
    if (!old) changes.added.push(entry);
    else if (entry.command !== old.command || entry.name !== old.name || entry.group !== old.group ||
        entry.groupId !== old.groupId || (entry.mode ?? 'auto') !== (old.mode ?? 'auto') ||
        (entry.color ?? 'default') !== (old.color ?? 'default')) {
      changes.changed.push(entry);
    }
  }
  for (const [id, entry] of oldEntries) {
    if (!newEntries.has(id)) changes.removed.push(entry);
  }
  const oldOrder = [...oldEntries.keys()].filter(id => newEntries.has(id));
  const newOrder = [...newEntries.keys()].filter(id => oldEntries.has(id));
  changes.reordered = oldOrder.some((id, index) => id !== newOrder[index]);
  return changes;
}

export function readSite(value) {
  const url = new URL(value.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/') {
    throw new Error('请输入站点源地址，例如 https://jump.example.com，站点端口可选。');
  }
  return { origin: url.origin, permission: `${url.protocol}//${url.hostname}/*` };
}

export function groupKey(sourceId, groupId) {
  return `${sourceId}/${groupId}`;
}

export function visibleLibrary(library, groups) {
  if (groups === null) return library;
  return { ...library, groups: library.groups.filter(group => groups.includes(groupKey(library.sourceId, group.id))) };
}
