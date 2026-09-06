"""REQ/RISK/TEST-C12J-01..05: synthetic archive refusal and restore boundaries."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import ops_database_transfer_fixture as transfer
from ops_image_transfer_test import fixture as image_fixture, CONTEXT, TOKEN


def fixture():
    settings = dict(User='70:70', Entrypoint=['docker-entrypoint.sh'], Cmd=['postgres'],
                    Labels={'kin.ci.database': TOKEN, 'kin.ci.base': transfer.BASE})
    image_body, archive = image_fixture(settings, tag='kin-ci-database:'+TOKEN)
    files = {'image.tar': archive, 'kin.dump': b'PGDMPsynthetic kin', 'keycloak.dump': b'PGDMPsynthetic keycloak'}
    body = dict(schema=1, code_sha=CONTEXT['code_sha'], run_id=CONTEXT['run_id'], run_attempt='1',
                producer_boot_id='22222222-2222-2222-2222-222222222222', token=TOKEN,
                image_id=image_body['image_id'], image_config_id=image_body['image_id'], base_image=transfer.BASE,
                files={name: dict(bytes=len(raw), sha256=transfer.image_transfer.sha(raw)) for name, raw in files.items()},
                rows={db: dict(count=3, sha256=transfer.image_transfer.sha(transfer.EXPECTED)) for db in transfer.DATABASES})
    return body, files, settings


class Pure(unittest.TestCase):
    def test_01_non_ci_refuses_both_modes_before_mutation(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(transfer, 'command') as calls:
            for method, args in ((transfer.produce, [Path('not-created')]), (transfer.consume, [Path('absent'), '0'*64])):
                with self.assertRaises(ValueError): method(*args)
            calls.assert_not_called()

    def test_02_receipt_scope_image_and_rows(self):
        body, _, _ = fixture()
        def check(value):
            raw = json.dumps(value).encode()
            return transfer.parse_receipt(raw, transfer.image_transfer.sha(raw), CONTEXT)
        self.assertEqual(check(body), body)
        for change in ({'schema': True}, {'code_sha': 'c'*40}, {'run_id': 'other'}, {'run_attempt': '2'},
                       {'producer_boot_id': CONTEXT['boot_id']}, {'token': 'no'}, {'image_config_id': 'no'},
                       {'base_image': 'postgres:latest'}, {'rows': {}}, {'extra': 1}):
            with self.subTest(change=change), self.assertRaises(ValueError): check(dict(body, **change))

    def test_03_receipt_hash_size_duplicate_and_file_set(self):
        body, _, _ = fixture(); raw = json.dumps(body).encode()
        with self.assertRaises(ValueError): transfer.parse_receipt(raw, '0'*64, CONTEXT)
        for raw in (b'{"schema":1,"schema":1}', b'NaN', b' '*8193):
            with self.assertRaises(ValueError): transfer.parse_receipt(raw, transfer.image_transfer.sha(raw), CONTEXT)
        for change in ({}, dict(body['files'], extra=body['files']['kin.dump']),
                       dict(body['files'], **{'kin.dump': {'bytes': True, 'sha256': 'a'*64}}),
                       dict(body['files'], **{'image.tar': {'bytes': 513*1024**2, 'sha256': 'a'*64}})):
            raw = json.dumps(dict(body, files=change)).encode()
            with self.assertRaises(ValueError): transfer.parse_receipt(raw, transfer.image_transfer.sha(raw), CONTEXT)

    def test_04_real_archive_and_dump_hash_validation(self):
        body, files, _ = fixture()
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            for name, raw in files.items(): (folder/name).write_bytes(raw)
            transfer.verify_files(folder, body)
            (folder/'kin.dump').write_bytes(b'changed')
            with self.assertRaises(ValueError): transfer.verify_files(folder, body)

    def test_05_bad_image_settings_and_full_row_content(self):
        _, _, settings = fixture()
        for change in ({'User': 'root'}, {'Labels': {}}, {'Cmd': ['sh']}, {'Entrypoint': ['/bin/sh']}):
            with self.assertRaises(ValueError): transfer.settings(dict(settings, **change), TOKEN)
        with patch.object(transfer, 'query', return_value=transfer.EXPECTED.replace(b'beta', b'evil')):
            with self.assertRaises(ValueError): transfer.verify_rows('owned')

    def test_06_failed_readiness_is_bounded(self):
        with patch.object(transfer, 'command') as calls, patch.object(transfer.time, 'monotonic', side_effect=[0, 61]):
            with self.assertRaises(TimeoutError): transfer.start_database('sha256:'+'a'*64, 'owned', TOKEN)
            self.assertEqual(len(calls.call_args_list), 2)


@unittest.skipUnless(sys.platform == 'linux', 'Linux private FD semantics')
class Linux(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.body, files, self.settings = fixture()
        for name, raw in files.items(): (self.root/name).write_bytes(raw)
        self.raw = json.dumps(self.body).encode(); (self.root/'receipt.json').write_bytes(self.raw)

    def tearDown(self): self.temp.cleanup()

    def consume(self):
        with patch.object(transfer.image_transfer, 'ci_context', return_value=CONTEXT):
            return transfer.consume(self.root, transfer.image_transfer.sha(self.raw))

    def test_07_stream_copy_is_private_and_does_not_overwrite(self):
        with tempfile.TemporaryDirectory() as output:
            target = Path(output)/'copy'
            transfer.copy_download(self.root/'image.tar', target, transfer.LIMITS['image.tar'])
            self.assertEqual(target.read_bytes(), (self.root/'image.tar').read_bytes())
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError): transfer.copy_download(self.root/'image.tar', target, 1024**2)

    def test_08_links_oversize_and_special_file_refused(self):
        with tempfile.TemporaryDirectory() as output:
            output = Path(output)
            for kind in ('symlink', 'hardlink', 'fifo', 'oversize'):
                source = output/kind
                if kind == 'symlink': source.symlink_to(self.root/'kin.dump')
                elif kind == 'hardlink': os.link(self.root/'kin.dump', source)
                elif kind == 'fifo': os.mkfifo(source)
                else: source.write_bytes(b'x'*33)
                with self.subTest(kind=kind), self.assertRaises((ValueError, OSError)):
                    transfer.copy_download(source, output/(kind+'-copy'), 32)

    def test_09_invalid_receipt_or_dump_never_loads(self):
        with patch.object(transfer.image_transfer, 'inspect_image') as inspect, patch.object(transfer, 'command') as calls:
            (self.root/'receipt.json').write_bytes(b'{}')
            with self.assertRaises(ValueError): self.consume()
            (self.root/'receipt.json').write_bytes(self.raw)
            (self.root/'kin.dump').write_bytes(b'bad')
            with self.assertRaises(ValueError): self.consume()
            inspect.assert_not_called(); calls.assert_not_called()

    def test_10_existing_image_preserved(self):
        with patch.object(transfer.image_transfer, 'inspect_image', return_value={'Id': self.body['image_id']}), \
             patch.object(transfer, 'command') as calls, patch.object(transfer, 'remove_image') as remove:
            with self.assertRaises(ValueError): self.consume()
            calls.assert_not_called(); remove.assert_not_called()

    def consume_mocked(self, fail=None):
        with patch.object(transfer.image_transfer, 'inspect_image', side_effect=[None, {'Config': self.settings}]), \
             patch.object(transfer, 'command') as calls, patch.object(transfer, 'start_database', side_effect=fail), \
             patch.object(transfer, 'query', return_value=transfer.EXPECTED), \
             patch.object(transfer.ops, 'remove_owned_if_present') as clean, patch.object(transfer, 'remove_image') as remove:
            if fail:
                with self.assertRaises(TimeoutError): self.consume()
            else:
                result = self.consume()
                self.assertTrue(result['synthetic_database_restored'] and result['source_unchanged'])
                self.assertEqual(result['rows'], self.body['rows'])
                self.assertTrue(all(result[k] is False for k in ('full_restore_verified', 'offsite_backup_verified', 'deployment_authorized')))
                restores = [c.args[0] for c in calls.call_args_list if 'pg_restore' in c.args[0]]
                self.assertEqual(len(restores), 2)
            clean.assert_called_once_with('container', 'kin-rehearsal-'+TOKEN[:16], TOKEN)
            remove.assert_called_once_with(self.body['image_id'], TOKEN)

    def test_11_mocked_restore_full_rows_and_cleanup(self): self.consume_mocked()

    def test_12_readiness_timeout_cleans_loaded_image_and_container(self): self.consume_mocked(TimeoutError('injected'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
