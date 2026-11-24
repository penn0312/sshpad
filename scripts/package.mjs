// Builds the store-ready zip from extension/ only. No bundler, no deps.
// A Chrome Web Store upload must contain the extension and nothing else: no
// tests, no scripts, no local fixtures.
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const root = new URL('../', import.meta.url).pathname;
const source = join(root, 'extension');
const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xFFFFFFFF;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xFF] ^ (value >>> 8);
  return (value ^ 0xFFFFFFFF) >>> 0;
}

async function walk(directory) {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) entries.push(...await walk(full));
    else if (entry.isFile()) entries.push(full);
  }
  return entries;
}

// Entries must be sorted so repeated builds are byte-identical and diffable.
const files = (await walk(source)).sort((a, b) =>
  relative(source, a).split(sep).join('/').localeCompare(relative(source, b).split(sep).join('/')));

const chunks = [];
const central = [];
let offset = 0;

for (const file of files) {
  const name = Buffer.from(relative(source, file).split(sep).join('/'), 'utf8');
  const data = await readFile(file);
  const compressed = deflateRawSync(data, { level: 9 });
  // Fixed timestamp: the archive must not change just because it was rebuilt.
  const time = 0;
  const date = 0x2821; // 2000-01-01, the earliest value ZIP reliably accepts.
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  chunks.push(local, name, compressed);

  const next = Buffer.alloc(46);
  next.writeUInt32LE(0x02014b50, 0);
  next.writeUInt16LE(20, 4);
  next.writeUInt16LE(20, 6);
  next.writeUInt16LE(0x0800, 8);
  next.writeUInt16LE(8, 10);
  next.writeUInt16LE(time, 12);
  next.writeUInt16LE(date, 14);
  next.writeUInt32LE(crc, 16);
  next.writeUInt32LE(compressed.length, 20);
  next.writeUInt32LE(data.length, 24);
  next.writeUInt16LE(name.length, 28);
  next.writeUInt16LE(0, 30);
  next.writeUInt16LE(0, 32);
  next.writeUInt16LE(0, 34);
  next.writeUInt16LE(0, 36);
  next.writeUInt32LE(0, 38);
  next.writeUInt32LE(offset, 42);
  central.push(next, name);

  offset += local.length + name.length + compressed.length;
}

const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);

await mkdir(join(root, 'dist'), { recursive: true });
const target = join(root, 'dist', `sshpad-${manifest.version}.zip`);
await new Promise((resolve, reject) => {
  const stream = createWriteStream(target);
  stream.on('error', reject);
  stream.on('finish', resolve);
  stream.end(Buffer.concat([...chunks, directory, end]));
});

const size = (await stat(target)).size;
console.log(`built ${relative(root, target)} (${files.length} files, ${size} bytes)`);
