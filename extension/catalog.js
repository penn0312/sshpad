// Pure view logic shared by the bar. No DOM and no chrome APIs so it can be
// unit-tested in Node and reused if the bar is ever rendered differently.

export const MAX_BUTTONS = 400;

export function buildCatalog(sources) {
  const groups = [];
  let total = 0;
  for (const source of sources ?? []) {
    for (const group of source.library?.groups ?? []) {
      const commands = group.commands.slice(0, MAX_BUTTONS - total).map(entry => ({
        ...entry,
        sourceId: source.library.sourceId,
        revision: source.revision,
        groupId: group.id,
        groupName: group.name,
        key: source.library.sourceId + '\u0000' + group.id + '\u0000' + entry.id,
      }));
      if (!commands.length) continue;
      total += commands.length;
      groups.push({ id: source.library.sourceId + '\u0000' + group.id, name: group.name, commands });
      if (total >= MAX_BUTTONS) return { groups, total, truncated: true };
    }
  }
  return { groups, total, truncated: false };
}

// Case-insensitive substring over the button label and the command body, which
// is what people actually remember. Never matches on secrets we already hide.
export function matches(entry, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return entry.name.toLowerCase().includes(needle) || entry.command.toLowerCase().includes(needle);
}

export function filterCatalog(catalog, query) {
  const needle = String(query ?? '').trim();
  if (!needle) return catalog;
  const groups = [];
  for (const group of catalog.groups) {
    const commands = group.commands.filter(entry => matches(entry, needle));
    if (commands.length) groups.push({ ...group, commands });
  }
  return { ...catalog, groups, filtered: true };
}

// One line, always. The bar is 20px of chrome under someone's terminal; the
// status must never reflow it.
export function statusText({ reason, feedback, loading, executing }) {
  if (feedback) return { level: 'error', text: feedback };
  if (executing) return { level: 'busy', text: '正在提交…' };
  if (loading) return { level: 'idle', text: '' };
  if (reason) return { level: 'error', text: reason };
  return { level: 'ok', text: '' };
}

export function emptyText({ total, filtered, hasSites }) {
  if (filtered) return '没有匹配的命令。';
  if (total) return '';
  return hasSites ? '当前站点没有显示的命令，点「命令库设置」添加。' : '先在扩展设置里授权 JumpServer 站点。';
}
