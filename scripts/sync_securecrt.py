#!/usr/bin/env python3
"""Export local, single-line SecureCRT SEND records for the Luna extension."""

import argparse
from collections import Counter
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import tempfile
import unicodedata


DEFAULT_CONFIG = Path.home() / 'Library/Application Support/VanDyke/SecureCRT/Config'
FIELD = re.compile(r'^([A-Z]):"((?:[^"\\]|\\.)*)"=(.*)$')
LOCAL_RULES = Path(__file__).resolve().parents[1] / '.local' / 'securecrt-rules.json'
PRIVATE_NETWORKS = tuple(map(ipaddress.ip_network, ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')))
CREDENTIAL = re.compile(
    r'(?ix)(?:\$\{?[\w-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|credential)[\w-]*'
    r'|(?:\{\{?|<|%|\[)[\w -]*(?:password|passwd|passphrase|secret|token|api[_-]?key|credential)[\w -]*(?:\}\}?|>|%|\]))'
)


class Review(ValueError):
    pass


def read_ini(path):
    raw = path.read_bytes()
    encoding = 'utf-16' if raw.startswith((b'\xff\xfe', b'\xfe\xff')) else 'utf-8-sig'
    return raw.decode(encoding).replace('\r\n', '\n').split('\n')


def fields(text, *, quoted=False):
    """Split VanDyke's comma list, undoing the INI escape layer once."""
    result = []
    current = []
    in_quotes = False
    index = 0
    while index < len(text):
        char = text[index]
        if char == '\\':
            index += 1
            if index == len(text) or text[index] not in '\\,"':
                raise Review('未知 INI 转义')
            current.append(text[index])
        elif quoted and char == '"':
            in_quotes = not in_quotes
        elif char == ',' and not in_quotes:
            result.append(''.join(current))
            current = []
        else:
            current.append(char)
        index += 1
    if in_quotes:
        raise Review('字段引号未闭合')
    result.append(''.join(current))
    return result


def ini_name(text):
    # A quoted key or folder-list row is a single value, even if it has a comma.
    return fields('"' + text + '"', quoted=True)[0]


def parse_ini(path):
    settings = {}
    blocks = []
    rows = None
    for line in read_ini(path):
        match = FIELD.fullmatch(line)
        if match:
            kind, key, value = match.groups()
            name = ini_name(key)
            rows = None
            if kind == 'Z':
                rows = []
                count = int(value, 16) if re.fullmatch(r'[0-9a-fA-F]{8}', value) else None
                blocks.append((name, count, rows))
            else:
                settings[name] = value
        elif line.startswith((' ', '\t')) and rows is not None:
            rows.append(line[1:])
        elif line and not line.startswith(('#', ';')):
            raise Review('无法识别 INI 结构')
    return settings, blocks


def command_files(directory):
    names = sorted(directory.iterdir(), key=lambda entry: entry.name.casefold())
    index = directory / '__FolderData__.ini'
    order = {}
    if index.is_file() and not index.is_symlink():
        _, blocks = parse_ini(index)
        for name, count, rows in blocks:
            if name not in ('Folder List V2', 'Session List V2'):
                continue
            if count != len(rows):
                raise Review('Command Manager 索引条数不一致')
            for row in rows:
                order.setdefault(ini_name(row), len(order))
    for entry in sorted(names, key=lambda item: order.get(item.stem, len(order))):
        if entry.is_symlink() or entry == index:
            continue
        if entry.is_dir():
            yield from command_files(entry)
        elif entry.is_file() and entry.suffix.lower() == '.ini':
            yield entry


def single_line(send):
    output = []
    index = 0
    while index < len(send):
        char = send[index]
        index += 1
        if char == '\\':
            if index == len(send):
                raise Review('未知 SEND 转义')
            escape = send[index]
            index += 1
            if escape == 'p':
                raise Review('包含等待')
            if escape not in ('\\', 'r', 'n'):
                raise Review('控制键、替换变量或未知 SEND 转义')
            char = {'\\': '\\', 'r': '\r', 'n': '\n'}[escape]
        output.append(char)
    command = re.sub(r'(?:\r\n|[\r\n])\Z', '', ''.join(output), count=1)
    if not command.strip() or any(unicodedata.category(char) in {'Cc', 'Cs', 'Zl', 'Zp'} for char in command):
        raise Review('空命令、内部换行或控制键')
    if CREDENTIAL.search(command):
        raise Review('包含凭据占位符')
    return command


def private_ip_only(command):
    try:
        address = ipaddress.IPv4Address(command.strip())
    except ipaddress.AddressValueError:
        return False
    return any(address in network for network in PRIVATE_NETWORKS)


def stable_id(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=True).encode('ascii')).hexdigest()[:32]


def export(config, exclude_ip_groups=frozenset()):
    bar = config / 'ButtonBarV5.ini'
    if bar.is_symlink() or not bar.is_file():
        raise Review('找不到常规 ButtonBarV5.ini 文件')
    settings, blocks = parse_ini(bar)
    if 'Button Bar List' in settings:
        order = {name: index for index, name in enumerate(fields(settings['Button Bar List'], quoted=True))}
        blocks.sort(key=lambda block: order.get(block[0], len(order)))
    inputs = [(bar, blocks)]
    command_dir = config / 'Commands'
    if command_dir.is_dir() and not command_dir.is_symlink():
        for path in command_files(command_dir):
            flags, blocks = parse_ini(path)
            if flags.get('Is Command List') == '00000001':
                inputs.append((path, blocks))

    totals = Counter()
    reasons = Counter()
    groups = {}
    candidates = {}
    collisions = set()
    for path, blocks in inputs:
        for name, count, rows in blocks:
            if count != len(rows):
                raise Review('命令分组的记录数与声明不符')
            relative = path.relative_to(config).as_posix()
            group_id = stable_id([relative, name])
            display = name if path == bar else ' / '.join(('Command Manager', *path.relative_to(command_dir).parent.parts, name))
            group = groups.setdefault(group_id, {'id': group_id, 'name': display, 'commands': []})
            for row in rows:
                totals['read'] += 1
                if row.partition(',')[0] != 'SEND':
                    totals['skipped'] += 1
                    reasons['非 SEND 类型'] += 1
                    continue
                try:
                    parsed = fields(row)
                    if len(parsed) != 8 or not parsed[2].strip() or any(
                        unicodedata.category(char) in {'Cc', 'Cs', 'Zl', 'Zp'} for char in parsed[2] + display
                    ):
                        raise Review('SEND 字段不完整或名称无效')
                    command = single_line(parsed[1])
                except Review as exc:
                    totals['review'] += 1
                    reasons[str(exc)] += 1
                    continue
                if path == bar and name in exclude_ip_groups and private_ip_only(command):
                    totals['skipped'] += 1
                    reasons['按规则排除的内网 IPv4 按钮'] += 1
                    continue
                label = parsed[2]
                entry = {'id': stable_id([group_id, label]), 'name': label, 'command': command}
                key = (group_id, label)
                if key in collisions:
                    totals['conflicts'] += 1
                elif key not in candidates:
                    candidates[key] = entry
                elif candidates[key]['command'] == command:
                    totals['skipped'] += 1
                    reasons['相同分组内完全重复'] += 1
                else:
                    del candidates[key]
                    collisions.add(key)
                    totals['conflicts'] += 2

    for (group_id, _), entry in candidates.items():
        groups[group_id]['commands'].append(entry)
    totals['ready'] = len(candidates)
    return {
        'version': 1,
        'sourceId': 'securecrt-' + stable_id(str(config)),
        'groups': [group for group in groups.values() if group['commands']],
    }, totals, reasons


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as file:
            temporary = Path(file.name)
            json.dump(data, file, ensure_ascii=False, indent=2)
            file.write('\n')
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def read_rules(path):
    try:
        rules = json.loads(path.read_text(encoding='utf-8-sig'))
    except json.JSONDecodeError:
        raise Review('过滤规则必须为有效的 JSON') from None
    names = rules.get('excludePrivateIpGroups', []) if isinstance(rules, dict) else None
    if not isinstance(names, list) or any(not isinstance(name, str) or not name for name in names):
        raise Review('excludePrivateIpGroups 必须是分组名称的数组')
    return frozenset(names)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config-dir', type=Path, default=DEFAULT_CONFIG)
    parser.add_argument('--rules', type=Path, help='可选的本地过滤规则 JSON')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--dry-run', action='store_true')
    mode.add_argument('--output', type=Path)
    args = parser.parse_args()
    config = args.config_dir.expanduser().resolve()
    try:
        rules_path = args.rules.expanduser() if args.rules else None
        if rules_path is None and config == DEFAULT_CONFIG.resolve() and LOCAL_RULES.is_file():
            rules_path = LOCAL_RULES
        names = read_rules(rules_path) if rules_path else frozenset()
        data, totals, reasons = export(config, names)
        if args.output:
            output = args.output.expanduser()
            if output.suffix.lower() != '.json' or output.resolve().is_relative_to(config):
                raise Review('输出需为配置目录之外的 .json 文件')
            atomic_write(output, data)
    except (Review, OSError, UnicodeError) as exc:
        message = str(exc) if isinstance(exc, Review) else '无法读写文件或输入编码不受支持'
        parser.exit(1, f'同步失败：{message}\n')
    print(f"读取 {totals['read']} 条｜可同步 {totals['ready']} 条｜需复核 {totals['review']} 条｜"
          f"跳过 {totals['skipped']} 条｜冲突 {totals['conflicts']} 条")
    for reason, count in reasons.items():
        print(f'  {reason}：{count} 条')
    if args.output:
        print('已原子写入本地命令库。')


if __name__ == '__main__':
    main()
