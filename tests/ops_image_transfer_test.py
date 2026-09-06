"""REQ/RISK/TEST-C12I-01..05: refusals before Docker load; real transfer runs in CI."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import ops_image_transfer_fixture as transfer
from ops_export_inventory_test import image_fixture, make_tar, raw_json

TOKEN = 'a'*32
CONTEXT = dict(code_sha='b'*40, run_id='123', run_attempt='1', boot_id='11111111-1111-1111-1111-111111111111')


def fixture(config_changes=None, tag=None, corrupt_layer=False):
    _, parts = image_fixture()
    config = json.loads(parts[1][1])
    config['config'] = dict(User='65534:65534', Entrypoint=['/probe'], Labels={'kin.ci.fixture': TOKEN})
    config['config'].update(config_changes or {})
    raw = raw_json(config); identity = 'sha256:'+hashlib.sha256(raw).hexdigest()
    name = identity[7:]+'.json'
    layer = parts[2][1]
    if corrupt_layer:
        layer = layer[:-1]+bytes([layer[-1]^1])
    archive = make_tar([('manifest.json', raw_json([dict(Config=name, Layers=['layer.tar'],
                        RepoTags=[tag or 'kin-ci-restore:'+TOKEN])])), (name, raw), ('layer.tar', layer)])
    body = dict(schema=1, code_sha=CONTEXT['code_sha'], run_id=CONTEXT['run_id'], run_attempt='1',
                producer_boot_id='22222222-2222-2222-2222-222222222222', token=TOKEN, image_id=identity,
                archive_bytes=len(archive), archive_sha256=transfer.sha(archive), marker_sha256=transfer.sha(transfer.MARKER))
    return body, archive


class Pure(unittest.TestCase):
    def test_01_non_ci_refuses_before_docker(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(transfer, 'command') as command:
            with self.assertRaises(ValueError):
                transfer.ci_context()
            command.assert_not_called()

    def test_02_receipt_scope_and_separate_boot(self):
        body, _ = fixture()
        raw = raw_json(body)
        self.assertEqual(transfer.parse_receipt(raw, transfer.sha(raw), CONTEXT), body)
        for changes in ({'schema': True}, {'run_id': 'other'}, {'run_attempt': '2'}, {'code_sha': 'c'*40},
                        {'producer_boot_id': CONTEXT['boot_id']}, {'token': 'x'}, {'archive_bytes': True},
                        {'archive_bytes': transfer.LIMIT+1}, {'marker_sha256': '0'*64}, {'extra': True}):
            raw = raw_json(dict(body, **changes))
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                transfer.parse_receipt(raw, transfer.sha(raw), CONTEXT)

    def test_03_receipt_hash_duplicates_and_bounds(self):
        body, _ = fixture(); raw = raw_json(body)
        with self.assertRaises(ValueError):
            transfer.parse_receipt(raw, '0'*64, CONTEXT)
        for raw in (b'{"schema":1,"schema":1}', b'NaN', b' '*8193):
            with self.assertRaises(ValueError):
                transfer.parse_receipt(raw, transfer.sha(raw), CONTEXT)

    def test_04_complete_archive_and_config(self):
        body, raw = fixture()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'image.tar'; path.write_bytes(raw)
            transfer.check_archive(path, body)

    def test_05_layer_tag_and_unsafe_settings_rejected(self):
        cases = [dict(corrupt_layer=True), dict(tag='existing-user-tag:latest'),
                 dict(config_changes={'User': 'root'}), dict(config_changes={'Entrypoint': ['/bin/sh']}),
                 dict(config_changes={'Labels': {'kin.ci.fixture': 'other'}})]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'image.tar'
            for args in cases:
                body, raw = fixture(**args); path.write_bytes(raw)
                with self.subTest(args=args), self.assertRaises(ValueError):
                    transfer.check_archive(path, body)

    def test_06_archive_bytes_are_bound(self):
        body, raw = fixture()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'image.tar'; path.write_bytes(raw+b'extra')
            with self.assertRaises(ValueError):
                transfer.check_archive(path, body)


@unittest.skipUnless(sys.platform == 'linux', 'Linux artifact FD and private workspace')
class Consumer(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='kin-transfer-unit-')
        self.root = Path(self.temp.name)
        self.body, archive = fixture()
        (self.root/'image.tar').write_bytes(archive)
        self.receipt = raw_json(self.body)
        (self.root/'receipt.json').write_bytes(self.receipt)

    def tearDown(self):
        self.temp.cleanup()

    def consume(self):
        with patch.object(transfer, 'ci_context', return_value=CONTEXT):
            return transfer.consume(self.root, transfer.sha(self.receipt))

    def test_07_bad_receipt_never_inspects_or_loads(self):
        (self.root/'receipt.json').write_bytes(b'{}')
        with patch.object(transfer, 'inspect_image') as inspect, patch.object(transfer, 'command') as command:
            with self.assertRaises(ValueError):
                self.consume()
            inspect.assert_not_called(); command.assert_not_called()

    def test_08_bad_archive_never_inspects_or_loads(self):
        raw = (self.root/'image.tar').read_bytes()
        (self.root/'image.tar').write_bytes(raw[:-1]+b'x')
        with patch.object(transfer, 'inspect_image') as inspect, patch.object(transfer, 'command') as command:
            with self.assertRaises(ValueError):
                self.consume()
            inspect.assert_not_called(); command.assert_not_called()

    def test_09_existing_image_preserved(self):
        with patch.object(transfer, 'inspect_image', return_value={'Id': self.body['image_id']}), \
             patch.object(transfer, 'command') as command, patch.object(transfer, 'remove_image') as remove:
            with self.assertRaises(ValueError):
                self.consume()
            command.assert_not_called(); remove.assert_not_called()

    def test_10_success_and_cleanup(self):
        config = dict(User='65534:65534', Entrypoint=['/probe'], Labels={'kin.ci.fixture': TOKEN})
        def command(args, **kwargs):
            if args[1] == 'start': return transfer.MARKER
            if args[1] == 'inspect': return b'0\n'
            return b''
        with patch.object(transfer, 'inspect_image', side_effect=[None, {'Config': config}]), \
             patch.object(transfer, 'command', side_effect=command) as calls, \
             patch.object(transfer.ops, 'remove_owned_if_present') as clean, patch.object(transfer, 'remove_image') as remove:
            result = self.consume()
            self.assertTrue(result['synthetic_image_restored'])
            self.assertTrue(all(result[k] is False for k in ('full_restore_verified', 'offsite_backup_verified', 'deployment_authorized')))
            self.assertEqual(calls.call_args_list[0].args[0][:3], ['docker', 'image', 'load'])
            clean.assert_called_once_with('container', 'kin-rehearsal-'+TOKEN[:16], TOKEN)
            remove.assert_called_once_with(self.body['image_id'], TOKEN)

    def test_11_start_timeout_cleans_owned_resources(self):
        config = dict(User='65534:65534', Entrypoint=['/probe'], Labels={'kin.ci.fixture': TOKEN})
        def command(args, **kwargs):
            if args[1] == 'start': raise subprocess.TimeoutExpired(args, 10)
            return b''
        with patch.object(transfer, 'inspect_image', side_effect=[None, {'Config': config}]), \
             patch.object(transfer, 'command', side_effect=command), \
             patch.object(transfer.ops, 'remove_owned_if_present') as clean, patch.object(transfer, 'remove_image') as remove:
            with self.assertRaises(subprocess.TimeoutExpired):
                self.consume()
            clean.assert_called_once(); remove.assert_called_once()

    def test_12_links_and_extra_files_rejected(self):
        path = self.root/'extra'; path.write_bytes(b'extra')
        with self.assertRaises(ValueError): self.consume()
        path.unlink()
        (self.root/'image.tar').rename(path); (self.root/'image.tar').symlink_to(path)
        with self.assertRaises(ValueError): self.consume()
        (self.root/'image.tar').unlink(); os.link(path, self.root/'image.tar'); path.unlink()
        os.link(self.root/'image.tar', self.root/'hardlink')
        with tempfile.TemporaryDirectory() as folder, self.assertRaises(ValueError):
            transfer.copy_download(self.root/'image.tar', Path(folder)/'copy', transfer.LIMIT)


if __name__ == '__main__':
    unittest.main(verbosity=2)
