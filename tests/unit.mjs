import assert from 'node:assert/strict';
import { buildCatalog, emptyText, filterCatalog, statusText } from '../extension/catalog.js';
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

console.log('Unit checks passed: catalog, filtering, status, empty states, credential detection and redaction.');