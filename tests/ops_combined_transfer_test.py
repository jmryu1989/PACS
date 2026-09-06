"""REQ/RISK/TEST-C12L-01..05: snapshot binding, limits and owned cleanup."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import ops_combined_transfer_fixture as transfer
from ops_database_transfer_test import fixture as pg_fixture
from ops_orthanc_transfer_test import fixture as orth_fixture, tar_bytes
from ops_image_transfer_test import CONTEXT, TOKEN

orth, pg, worker = transfer.orth, transfer.pg, transfer.orth.worker


def fixture():
    database, dumps, pg_config = pg_fixture()
    image, store, orth_config, _ = orth_fixture()
    files = {'postgres-image.tar': dumps['image.tar'], 'orthanc-image.tar': store['image.tar'],
             'kin.dump': dumps['kin.dump'], 'keycloak.dump': dumps['keycloak.dump'], 'store.tar': store['store.tar']}
    images = {key: dict(image_id=value['image_id'], config_id=value['image_config_id'], base=value['base_image'])
              for key, value in (('postgres', database), ('orthanc', image))}
    body = dict(schema=1, code_sha=CONTEXT['code_sha'], run_id=CONTEXT['run_id'], run_attempt='1',
                producer_boot_id=image['producer_boot_id'], token=TOKEN, images=images,
                files={name: worker.digest(raw) for name, raw in files.items()}, snapshot=image['snapshot'],
                relation=transfer.relation(image['snapshot']))
    return body, files, pg_config, orth_config


def check(body, relation_sha=None):
    raw = json.dumps(body).encode()
    return transfer.parse_receipt(raw, transfer.image_transfer.sha(raw),
        relation_sha or body['relation']['rows_sha256'], CONTEXT)


class Pure(unittest.TestCase):
    def test_01_non_ci_before_any_mutation(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(transfer, 'command') as calls, \
             patch.object(transfer, 'disk_preflight') as disk, tempfile.TemporaryDirectory() as folder:
            target = Path(folder)/'not-created'
            for method, args in ((transfer.produce, [target]), (transfer.consume, [target, '0'*64, '0'*64])):
                with self.assertRaises(ValueError): method(*args)
            self.assertFalse(target.exists()); calls.assert_not_called(); disk.assert_not_called()

    def test_02_scope_and_two_distinct_pinned_images(self):
        body, _, _, _ = fixture(); self.assertEqual(check(body), body)
        for change in ({'schema': True}, {'code_sha': 'c'*40}, {'run_id': 'other'}, {'run_attempt': '2'},
                       {'producer_boot_id': CONTEXT['boot_id']}, {'token': 'bad'}, {'extra': 1}):
            with self.subTest(change=change), self.assertRaises(ValueError): check(dict(body, **change))
        for key in transfer.COMPONENTS:
            for change in ({'image_id': 'bad'}, {'config_id': 'bad'}, {'base': 'image:latest'}, {'extra': 1}):
                other = copy.deepcopy(body); other['images'][key].update(change)
                with self.assertRaises(ValueError): check(other)
        other = copy.deepcopy(body); other['images']['postgres']['image_id'] = other['images']['orthanc']['image_id']
        with self.assertRaises(ValueError): check(other)

    def test_03_exact_inventory_typed_caps_and_strict_receipt(self):
        body, _, _, _ = fixture()
        for name in transfer.LIMITS:
            for size in (True, 0, transfer.LIMITS[name]+1):
                other = copy.deepcopy(body); other['files'][name]['bytes'] = size
                with self.assertRaises(ValueError): check(other)
        for files in ({}, dict(body['files'], extra=body['files']['kin.dump'])):
            with self.assertRaises(ValueError): check(dict(body, files=files))
        for raw in (b'{"schema":1,"schema":1}', b'NaN', b' '*16385):
            with self.assertRaises(ValueError): transfer.parse_receipt(raw, transfer.image_transfer.sha(raw), '0'*64, CONTEXT)
        raw = json.dumps(body).encode()
        with self.assertRaises(ValueError): transfer.parse_receipt(raw, '0'*64, body['relation']['rows_sha256'], CONTEXT)

    def test_04_independent_relation_rejects_resealed_other_snapshot(self):
        body, _, _, _ = fixture(); other = copy.deepcopy(body)
        other['snapshot']['instance'] = 'ffffffff-ffffffff-ffffffff-ffffffff-ffffffff'
        other['relation'] = transfer.relation(other['snapshot'])
        self.assertEqual(check(other), other)
        with self.assertRaises(ValueError): check(other, body['relation']['rows_sha256'])
        for value in ({}, dict(body['relation'], rows_per_database=True), dict(body['relation'], rows_sha256='0'*64)):
            raw = json.dumps(dict(body, relation=value)).encode()
            with self.assertRaises(ValueError):
                transfer.parse_receipt(raw, transfer.image_transfer.sha(raw), body['relation']['rows_sha256'], CONTEXT)

    def test_05_rows_use_instance_and_every_attachment_digest(self):
        body, _, _, _ = fixture(); snapshot = body['snapshot']
        actual = transfer.expected_rows(snapshot).decode().splitlines()
        self.assertEqual(len(actual), 3)
        for row, item in zip(actual, sorted(snapshot['attachments'], key=lambda item: item['file_type'])):
            self.assertEqual(row, str(item['file_type'])+'|'+snapshot['instance']+'|'+snapshot['files'][worker.store_path(item['uuid'])]['sha256'])
        reversed_snapshot = dict(snapshot, attachments=list(reversed(snapshot['attachments'])))
        self.assertEqual(transfer.expected_rows(reversed_snapshot), transfer.expected_rows(snapshot))

    def test_06_equal_count_wrong_actual_rows_refused(self):
        body, _, _, _ = fixture(); expected = transfer.expected_rows(body['snapshot'])
        with patch.object(transfer, 'command', side_effect=[expected, expected.replace(b'aaaaaaaa', b'ffffffff')]):
            with self.assertRaises(ValueError): transfer.verify_rows('owned', body['snapshot'])

    def test_07_mixed_images_dumps_and_valid_foreign_store_refused(self):
        body, files, _, _ = fixture()
        _, _, _, foreign_store = orth_fixture()
        foreign_store['index/index'] = b'another valid synthetic snapshot index'
        foreign_body = copy.deepcopy(body)
        foreign_body['snapshot']['files']['index/index'] = worker.digest(foreign_store['index/index'])
        foreign_tar = tar_bytes(foreign_store)
        worker.archive_files(foreign_tar, foreign_body['snapshot'])
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, raw in files.items(): (root/name).write_bytes(raw)
            transfer.verify_files(root, body)
            for name, changed in (('postgres-image.tar', files['orthanc-image.tar']),
                                  ('kin.dump', b'PGDMPother valid-scope fixture bytes'), ('store.tar', foreign_tar)):
                (root/name).write_bytes(changed)
                with self.assertRaises(ValueError): transfer.verify_files(root, body)
                (root/name).write_bytes(files[name])
            other = copy.deepcopy(body); other['files']['store.tar'] = worker.digest(foreign_tar)
            (root/'store.tar').write_bytes(foreign_tar)
            with self.assertRaises(ValueError): transfer.verify_files(root, other)

    def test_08_cleanup_attempts_every_resource_after_one_failure(self):
        body, _, _, _ = fixture(); identities = {key: value['image_id'] for key, value in body['images'].items()}
        with patch.object(transfer.ops, 'remove_owned_if_present', side_effect=[ValueError('foreign owner'), None]) as containers, \
             patch.object(pg, 'remove_image', side_effect=ValueError('foreign image')) as postgres, \
             patch.object(orth, 'remove_image') as orthanc:
            with self.assertRaises(RuntimeError): transfer.cleanup(TOKEN, identities)
            self.assertEqual(containers.call_count, 2); postgres.assert_called_once(); orthanc.assert_called_once()

    def test_09_unknown_build_id_resolves_only_valid_owned_tag(self):
        body, _, config, _ = fixture(); identity = body['images']['postgres']['image_id']; tag = transfer.tags(TOKEN)['postgres']
        found = dict(Id=identity, RepoTags=[tag], Config=config)
        def invoke(value):
            result = subprocess.CompletedProcess([], 0, json.dumps([value]).encode(), b'')
            with patch.object(transfer.subprocess, 'run', return_value=result):
                return transfer.owned_tag_identity(tag, pg, TOKEN)
        self.assertEqual(invoke(found), identity)
        for changed in (dict(found, RepoTags=['foreign:latest']), dict(found, Config=dict(config, Labels={}))):
            with self.assertRaises(ValueError): invoke(changed)
        with patch.object(transfer.ops, 'remove_owned_if_present'), \
             patch.object(transfer, 'owned_tag_identity', side_effect=[identity, None]) as resolve, \
             patch.object(pg, 'remove_image') as remove, patch.object(orth, 'remove_image') as absent:
            transfer.cleanup(TOKEN, {}, resolve_tags=True)
            self.assertEqual(resolve.call_count, 2); remove.assert_called_once_with(identity, TOKEN); absent.assert_not_called()

    def test_10_disk_shortage_precedes_build_or_load(self):
        for low in ('artifact', 'private_copy'):
            def usage(path):
                is_low = (path == 'artifact-filesystem') == (low == 'artifact')
                return Mock(free=transfer.DISK_RESERVE + (-1 if is_low else 1))
            with patch.object(transfer.image_transfer, 'ci_context', return_value=CONTEXT), \
                 patch.dict(os.environ, {'RUNNER_TEMP': 'artifact-filesystem'}), \
                 patch.object(transfer.shutil, 'disk_usage', side_effect=usage) as disk, \
                 patch.object(orth, 'build_image') as build, patch.object(transfer, 'command') as calls:
                with self.assertRaises(ValueError): transfer.produce(Path('not-created'))
                with self.assertRaises(ValueError): transfer.consume(Path('absent'), '0'*64, '0'*64)
                self.assertEqual(disk.call_count, 4)
                build.assert_not_called(); calls.assert_not_called()

    def test_11_worker_strict_json_and_nonzero_stop(self):
        for raw in ('{"instance":1,"instance":2}', '{"a":NaN}', '{"a":Infinity}', ' '*8193):
            with self.assertRaises(ValueError): worker.strict_json(raw)
        process = Mock(); process.wait.return_value = 17; process.poll.return_value = 17
        with self.assertRaises(ValueError): worker.stop(process)
        process.terminate.assert_called_once(); process.kill.assert_not_called()
        with patch.object(worker, 'start', return_value=process), patch.object(worker, 'call', return_value=b'{"ID":"x"}'), \
             patch.object(worker, 'observe') as observe:
            with self.assertRaises(ValueError): worker.produce()
            observe.assert_not_called()


@unittest.skipUnless(sys.platform == 'linux', 'Linux private FD and pipe semantics')
class Linux(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.body, files, self.pg_config, self.orth_config = fixture()
        for name, raw in files.items(): (self.root/name).write_bytes(raw)
        self.raw = json.dumps(self.body).encode(); (self.root/'receipt.json').write_bytes(self.raw)

    def tearDown(self): self.temp.cleanup()

    def consume(self):
        with patch.object(transfer.image_transfer, 'ci_context', return_value=CONTEXT), patch.object(transfer, 'disk_preflight'):
            return transfer.consume(self.root, transfer.image_transfer.sha(self.raw), self.body['relation']['rows_sha256'])

    def test_12_bad_input_never_inspects_loads_or_cleans(self):
        with patch.object(transfer, 'command') as calls, patch.object(transfer.image_transfer, 'inspect_image') as inspect, \
             patch.object(transfer, 'cleanup') as clean:
            for name, raw in (('receipt.json', b'{}'), ('store.tar', b'bad'), ('extra', b'x')):
                path = self.root/name; old = path.read_bytes() if path.exists() else None; path.write_bytes(raw)
                with self.assertRaises(ValueError): self.consume()
                path.unlink() if old is None else path.write_bytes(old)
            calls.assert_not_called(); inspect.assert_not_called(); clean.assert_not_called()

    def test_13_either_existing_image_prevents_all_loads_and_cleanup(self):
        for present in ([None, {'Id': 'existing'}], [{'Id': 'existing'}, None]):
            with patch.object(transfer.image_transfer, 'inspect_image', side_effect=present) as inspect, \
                 patch.object(transfer, 'command') as calls, patch.object(transfer, 'cleanup') as clean:
                with self.assertRaises(ValueError): self.consume()
                self.assertEqual(inspect.call_count, 2); calls.assert_not_called(); clean.assert_not_called()

    def mocked(self, failure=None):
        snapshot = self.body['snapshot']; rows = transfer.expected_rows(snapshot)
        restored = dict(instance=snapshot['instance'], attachments=snapshot['attachments'],
                        rest_bytes_match=True, sqlite_integrity=True, uid=65534)
        def command(args, **kwargs):
            if failure == 'second-load' and args[:3] == ['docker', 'image', 'load'] and 'orthanc-image.tar' in args[-1]:
                raise subprocess.TimeoutExpired(args, 1)
            if 'psql' in args:
                return rows.replace(b'aaaaaaaa', b'ffffffff') if failure == 'wrong-rows' else rows
            if 'consume' in args:
                if failure == 'worker-timeout': raise subprocess.TimeoutExpired(args, 1)
                if failure == 'source-change': (self.root/'kin.dump').write_bytes(b'changed')
                return json.dumps(restored).encode()
            return b''
        with patch.object(transfer.image_transfer, 'inspect_image', side_effect=[None, None, {'Config': self.pg_config}, {'Config': self.orth_config}]), \
             patch.object(orth, 'cached_layers', return_value=[]), patch.object(transfer, 'command', side_effect=command), \
             patch.object(pg, 'start_database'), patch.object(orth, 'start_container'), patch.object(transfer, 'cleanup') as clean:
            if failure:
                with self.assertRaises((ValueError, subprocess.TimeoutExpired)): self.consume()
            else:
                result = self.consume()
                self.assertTrue(result['synthetic_combined_restored'] and result['source_unchanged'])
                self.assertEqual(set(result['postgres_rows']), {'kin', 'keycloak'})
                self.assertTrue(all(result[key] is False for key in ('full_restore_verified', 'offsite_backup_verified', 'deployment_authorized')))
            clean.assert_called_once_with(TOKEN, {key: value['image_id'] for key, value in self.body['images'].items()})

    def test_14_success_preserves_original_and_scope(self): self.mocked()

    def test_15_partial_load_and_worker_timeout_cleanup(self):
        for failure in ('second-load', 'worker-timeout'):
            with self.subTest(failure=failure): self.mocked(failure)

    def test_16_wrong_restored_rows_and_source_mutation_refuse_success(self):
        for failure in ('wrong-rows', 'source-change'):
            with self.subTest(failure=failure): self.mocked(failure)

    def test_17_bounded_output_private_no_overwrite_and_stderr_drain(self):
        path = self.root/'output'
        orth.bounded_output([sys.executable, '-c', 'import sys; sys.stderr.write("e"*100000); sys.stdout.write("ok")'], path, 2)
        self.assertEqual(path.read_bytes(), b'ok'); self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError): orth.bounded_output([sys.executable, '-c', 'pass'], path, 2)

    def test_18_output_overflow_timeout_empty_and_nonzero_are_bounded(self):
        cases = [('overflow', 'import sys; sys.stdout.write("x"*1000000)', ValueError),
                 ('timeout', 'import time; time.sleep(30)', subprocess.TimeoutExpired),
                 ('empty', 'pass', ValueError),
                 ('nonzero', 'import sys; sys.stderr.write("e"*100000); sys.exit(7)', subprocess.CalledProcessError)]
        for name, script, error in cases:
            path = self.root/name
            with self.subTest(name=name), self.assertRaises(error) as caught:
                orth.bounded_output([sys.executable, '-c', script], path, 1024, timeout=.5 if name == 'timeout' else 5)
            self.assertLessEqual(path.stat().st_size, 1024)
            if name == 'nonzero': self.assertEqual(len(caught.exception.stderr), 4096)


if __name__ == '__main__':
    unittest.main(verbosity=2)
