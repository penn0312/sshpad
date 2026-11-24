import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from scripts.sync_securecrt import Review, atomic_write, export, read_rules


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'sync_securecrt.py'


def send(command, label):
    payload = command.replace('\\', '\\\\').replace(',', r'\,')
    return f' SEND,{payload},{label},,,0,0,\n'


def block(name, *rows):
    return f'Z:"{name}"={len(rows):08x}\n' + ''.join(rows)


class SyncTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.config = self.root / 'Config'
        self.config.mkdir()
        self.bar = self.config / 'ButtonBarV5.ini'

    def test_groups_counts_escapes_and_filtering(self):
        self.bar.write_text(
            'S:"Button Bar List"="First","Demo navigation","Second"\n'
            + block('Second', send(r'echo "foo,bar"\r\n', r'Name\, second'), send(r'echo \\n\n', 'Literal'))
            + block('Demo navigation', send(r'192.168.100.10\r', 'Navigation'), send(r'pwd\n', 'Keep'))
            + block('First', send(r'pwd\r', 'Path'), send(r'10.1.2.3\n', 'Ordinary IP')),
            encoding='utf-8-sig',
        )
        commands = self.config / 'Commands'
        commands.mkdir()
        (commands / '__FolderData__.ini').write_text(
            block('Folder List V2') + block('Session List V2', ' Zulu\n', ' Alpha\n'), encoding='utf-8-sig',
        )
        for name in ('Alpha', 'Zulu'):
            (commands / f'{name}.ini').write_text(
                'D:"Is Command List"=00000001\n' + block(name, send('echo fixture', 'Command')), encoding='utf-16',
            )
        _, unfiltered, _ = export(self.config)
        self.assertEqual(unfiltered, {'read': 8, 'ready': 8})
        rules = self.root / 'rules.json'
        rules.write_text('{"excludePrivateIpGroups":["Demo navigation"]}')
        data, totals, _ = export(self.config, read_rules(rules))
        subprocess.run([sys.executable, str(SCRIPT), '--config-dir', str(self.config),
                        '--rules', str(rules), '--dry-run'], check=True, capture_output=True)
        self.assertEqual([group['name'] for group in data['groups']], [
            'First', 'Demo navigation', 'Second', 'Command Manager / Zulu', 'Command Manager / Alpha',
        ])
        self.assertEqual(totals, {'read': 8, 'ready': 7, 'skipped': 1})
        first, _, second, *_ = data['groups']
        self.assertEqual([entry['command'] for entry in first['commands']], ['pwd', '10.1.2.3'])
        self.assertEqual(second['commands'][0]['name'], 'Name, second')
        self.assertEqual([entry['command'] for entry in second['commands']], ['echo "foo,bar"', r'echo \n'])

    def test_review_and_collision_records_are_excluded(self):
        self.bar.write_text(block('Example',
            send(r'echo test\p\r', 'Wait'), send(r'echo test\rwhoami\n', 'Internal'),
            send(r'pwd\r\r', 'Double submit'), send(r'pwd\t', 'Tab'), send(r'pwd\q', 'Unknown'),
            send(r'pwd\v', 'Clipboard'), send(r'echo ${TEST_PASSWORD}', 'Credential'),
            send('echo\x1b[A', 'Control'), ' SEND,too few\n',
            send('pwd', 'Duplicate'), send('pwd', 'Duplicate'),
            send('pwd', 'Collision'), send('whoami', 'Collision'),
            ' SCRIPT,ignored,Fixture,,,0,0,\n',
        ))
        data, totals, _ = export(self.config)
        self.assertEqual(totals, {'read': 14, 'review': 9, 'ready': 1, 'skipped': 2, 'conflicts': 2})
        self.assertEqual(data['groups'][0]['commands'][0]['name'], 'Duplicate')

    def test_dry_run_and_repeat_atomic_export(self):
        self.bar.write_text(block('Example', send('echo fixture-private', 'Fixture')))
        output = self.root / '.local' / 'commands.json'
        args = [sys.executable, str(SCRIPT), '--config-dir', str(self.config)]
        preview = subprocess.run([*args, '--dry-run'], check=True, text=True, capture_output=True)
        self.assertIn('可同步 1 条', preview.stdout)
        self.assertNotIn('fixture-private', preview.stdout)
        self.assertFalse(output.exists())
        subprocess.run([*args, '--output', str(output)], check=True, capture_output=True)
        previous = output.read_bytes()
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        subprocess.run([*args, '--output', str(output)], check=True, capture_output=True)
        self.assertEqual(previous, output.read_bytes())
        self.assertEqual(list(output.parent.iterdir()), [output])
        self.assertEqual(json.loads(previous)['version'], 1)

    def test_invalid_counts_leave_previous_file_intact(self):
        self.bar.write_text('Z:"Broken"=00000002\n' + send('pwd', 'Fixture'))
        with self.assertRaises(Review):
            export(self.config)
        output = self.root / 'commands.json'
        atomic_write(output, {'version': 1})
        run = subprocess.run([sys.executable, str(SCRIPT), '--config-dir', str(self.config), '--output', str(output)],
                             text=True, capture_output=True)
        self.assertEqual(run.returncode, 1)
        self.assertEqual(json.loads(output.read_text()), {'version': 1})

    def test_input_directory_cannot_be_written(self):
        self.bar.write_text(block('Example', send('pwd', 'Fixture')))
        output = self.config / 'commands.json'
        run = subprocess.run([sys.executable, str(SCRIPT), '--config-dir', str(self.config), '--output', str(output)],
                             text=True, capture_output=True)
        self.assertEqual(run.returncode, 1)
        self.assertFalse(output.exists())
