import assert from 'node:assert/strict';
import { buildCatalog, emptyText, filterCatalog, statusText } from '../extension/catalog.js';
import { applyOrder, exportLibrary, libraryWithEdits, validateLibrary } from '../extension/library.js';
import { credentialHint, hasCredential, redactCommand } from '../extension/sensitive.js';

const sources = [
  { revision: 'r1', library: { sourceId: 'ops', groups: [
    { id: 'mysql', name: 'MySQL', commands: [
      { id: 'm1', name: '主库写入', command: 'mysql -hdb -u a -phunter2xyz -A' },
      { id: 'm2', name: '只读', command: 'mysql -hdb -u b -A', color: 'blue' },
    ] },
    { id: 'deploy', name: '发布', commands: [
      { id: 'd1', name: '拉取代码', command: 'cd /opt/app && git pull' },
    ] },
  ] } },
  { revision: 'r2', library: { sourceId: 'local', groups: [
    { id: 'g', name: 'Local', commands: [{ id: 'l1', name: 'pwd', command: 'pwd' }] },
  ] } },
];

const catalog = buildCatalog(sources);
assert.equal(catalog.total, 4);
assert.deepEqual(catalog.groups.map(group => group.name), ['MySQL', '发布', 'Local']);
assert.equal(catalog.groups[0].commands[0].sourceId, 'ops');
assert.equal(catalog.groups[0].commands[0].revision, 'r1');
assert.equal(catalog.groups[0].commands[0].groupId, 'mysql');
assert.equal(catalog.groups[0].commands[1].color, 'blue');

// Keys must stay unique across sources that reuse group and command ids.
const colliding = buildCatalog([
  { revision: 'a', library: { sourceId: 'one', groups: [{ id: 'g', name: 'G', commands: [{ id: 'c', name: 'A', command: 'a' }] }] } },
  { revision: 'b', library: { sourceId: 'two', groups: [{ id: 'g', name: 'G', commands: [{ id: 'c', name: 'B', command: 'b' }] }] } },
]);
assert.notEqual(colliding.groups[0].commands[0].key, colliding.groups[1].commands[0].key);

// Case-insensitive over both the label and the command body.
assert.deepEqual(filterCatalog(catalog, '拉取').groups.flatMap(g => g.commands.map(c => c.name)), ['拉取代码']);
assert.deepEqual(filterCatalog(catalog, 'GIT PULL').groups.flatMap(g => g.commands.map(c => c.name)), ['拉取代码']);
assert.deepEqual(filterCatalog(catalog, 'mysql').groups.flatMap(g => g.commands.map(c => c.name)), ['主库写入', '只读']);
assert.equal(filterCatalog(catalog, 'zzz').groups.length, 0);
assert.equal(filterCatalog(catalog, '   ').groups.length, 3);

// The status line is single-line and never reflows the bar.
assert.deepEqual(statusText({ feedback: 'x', reason: 'y', loading: true, executing: true }), { level: 'error', text: 'x' });
assert.deepEqual(statusText({ reason: '当前标签有分屏。', loading: false, executing: false }), { level: 'error', text: '当前标签有分屏。' });
assert.equal(statusText({ loading: true }).text, '');
assert.equal(statusText({}).text, '');

assert.equal(emptyText({ total: 0, hasSites: true }).includes('命令库设置'), true);
assert.equal(emptyText({ total: 0, hasSites: false }).includes('授权'), true);
assert.equal(emptyText({ total: 3, filtered: true }), '没有匹配的命令。');
assert.equal(emptyText({ total: 3 }), '');

// Credential detection: warn on literal secrets, stay quiet on the safe forms.
const flagged = [
  'mysql -hdb -dbuser -phunter2xyz -A',
  'docker login -u me -psecret123',
  'redis-cli -a 0123456789abcdef0123',
  'curl https://user:pw123456@example.com/x',
  'export DB_PASSWORD=hunter2',
  'MYSQL_PWD=hunter2 mysql -hdb -u a',
  'REDISCLI_AUTH=abcdef123456 redis-cli ping',
  'curl -H "Authorization: Bearer abcdefghijklmnop1234"',
];
const quiet = [
  'pwd', 'pwd && whoami', 'df -h', 'git pull', 'sudo git pull',
  'mysql -hdb -uapp_user -p -A',
  'ssh -p2222 host',
  'ps aux --sort=-%mem | head -18',
  'printf %s local',
];
for (const command of flagged) assert.equal(hasCredential(command), true, command);
for (const command of quiet) assert.equal(hasCredential(command), false, command);

// Redaction must remove the secret and leave the rest of the command intact.
assert.equal(redactCommand('mysql -hdb -dbuser -phunter2xyz -A'), 'mysql -hdb -dbuser -p\u2022\u2022\u2022\u2022\u2022\u2022 -A');
assert.equal(redactCommand('export DB_PASSWORD=hunter2'), 'export DB_PASSWORD=\u2022\u2022\u2022\u2022\u2022\u2022');
assert.equal(redactCommand('curl https://user:pw123456@example.com/x'), 'curl https://user:\u2022\u2022\u2022\u2022\u2022\u2022@example.com/x');
for (const command of flagged) {
  const redacted = redactCommand(command);
  assert.equal(hasCredential(redacted), false, 'redaction must clear the finding: ' + redacted);
}
for (const command of quiet) assert.equal(redactCommand(command), command);

// Saved order wins; unseen items keep their place after the placed ones.
const items = ['a', 'b', 'c', 'd'].map(id => ({ id }));
assert.deepEqual(applyOrder(items, ['c', 'a']).map(item => item.id), ['c', 'a', 'b', 'd']);
assert.deepEqual(applyOrder(items, ['d', 'ghost', 'b', 'c', 'a']).map(item => item.id), ['d', 'b', 'c', 'a']);
assert.equal(applyOrder(items, undefined), items);

const base = {
  library: { version: 1, sourceId: 'ops', groups: [
    { id: 'g1', name: 'One', commands: [{ id: 'a', name: 'A', command: 'a' }, { id: 'b', name: 'B', command: 'b' }] },
    { id: 'g2', name: 'Two', commands: [{ id: 'c', name: 'C', command: 'c', color: 'blue' }] },
  ] },
  revision: 'r1',
};
const ordered = libraryWithEdits({ ...base, order: { groups: ['g2', 'g1'], commands: { g1: ['b', 'a'] } } });
assert.deepEqual(ordered.groups.map(group => group.id), ['g2', 'g1']);
assert.deepEqual(ordered.groups[1].commands.map(entry => entry.id), ['b', 'a']);
// Order survives edits and unrelated groups are untouched.
const edited = libraryWithEdits({
  ...base, order: { commands: { g1: ['b', 'a'] } },
  edits: { a: { groupId: 'g1', groupName: 'One', entry: { id: 'a', name: 'A2', command: 'a2' } } },
});
assert.deepEqual(edited.groups[0].commands.map(entry => entry.name), ['B', 'A2']);

// Export: one importable file with edits, colours and order applied, and ids kept unique across sources.
const colliding2 = {
  ops: { ...base, order: { groups: ['g2', 'g1'] }, colors: { a: 'green' } },
  local: { library: { version: 1, sourceId: 'local', groups: [] }, revision: 'r2',
    edits: { a: { groupId: 'g1', groupName: 'Mine', entry: { id: 'a', name: 'Mine', command: 'echo mine', mode: 'shell' }, imported: false } } },
};
const exported = exportLibrary(colliding2);
assert.deepEqual(exported.groups.map(group => group.name), ['Two', 'One', 'Mine']);
assert.equal(new Set(exported.groups.map(group => group.id)).size, 3);
assert.equal(new Set(exported.groups.flatMap(group => group.commands.map(entry => entry.id))).size, 4);
assert.equal(exported.groups[1].commands[0].color, 'green');
assert.equal(exported.groups[2].commands[0].mode, 'shell');
// The exported file passes the same validation as any import.
assert.deepEqual(validateLibrary(JSON.parse(JSON.stringify(exported))), exported);
assert.deepEqual(exportLibrary({}).groups, []);

console.log('Unit checks passed: catalog, filtering, status, empty states, credential detection and redaction, ordering and export.');