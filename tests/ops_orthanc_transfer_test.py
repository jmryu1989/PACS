"""REQ/RISK/TEST-C12K-01..05: frozen store, scope, isolation and failure refusals."""
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

import ops_orthanc_transfer_fixture as transfer
from ops_image_transfer_test import fixture as image_fixture, CONTEXT, TOKEN

worker = transfer.worker


def tar_bytes(files, extra=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for name, raw in files.items():
            member = tarfile.TarInfo(name); member.size = len(raw)
            archive.addfile(member, io.BytesIO(raw))
        if extra:
            archive.addfile(extra, io.BytesIO(b'x'*extra.size))
    return output.getvalue()


def fixture():
    config = dict(User='65534:65534', Entrypoint=['python3'], Cmd=transfer.CMD,
                  Labels={'kin.ci.orthanc': TOKEN, 'kin.ci.base': transfer.BASE})
    image_body, image_raw = image_fixture(config, tag='kin-ci-orthanc:'+TOKEN)
    attachments = [dict(file_type=kind, uuid=str(kind).zfill(8)+'-1111-1111-1111-111111111111') for kind in (1, 1024, 1025)]
    store = {'index/index': b'synthetic index for pure archive tests'}
    for item in attachments:
        store[worker.store_path(item['uuid'])] = worker.SAMPLES.get(item['file_type'], b'0'*128+b'DICMsynthetic')
    snapshot = dict(instance='aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee', attachments=attachments,
                    files={name: worker.digest(raw) for name, raw in store.items()})
    files = {'image.tar': image_raw, 'store.tar': tar_bytes(store)}
    body = dict(schema=1, code_sha=CONTEXT['code_sha'], run_id=CONTEXT['run_id'], run_attempt='1',
                producer_boot_id='22222222-2222-2222-2222-222222222222', token=TOKEN,
                image_id=image_body['image_id'], image_config_id=image_body['image_id'], base_image=transfer.BASE,
                files={name: worker.digest(raw) for name, raw in files.items()}, snapshot=snapshot)
    return body, files, config, store


class Pure(unittest.TestCase):
    def test_01_non_ci_refuses_before_any_docker_or_directory(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(transfer, 'command') as calls, \
             patch.object(transfer.image_transfer, 'command') as shared:
            with tempfile.TemporaryDirectory() as folder:
                target = Path(folder)/'not-created'
                for method, args in ((transfer.produce, [target]), (transfer.consume, [target, '0'*64])):
                    with self.assertRaises(ValueError): method(*args)
                self.assertFalse(target.exists())
            calls.assert_not_called(); shared.assert_not_called()

    def test_02_receipt_scope_identity_hash_and_caps(self):
        body, _, _, _ = fixture()
        def check(body):
            raw = json.dumps(body).encode()
            return transfer.parse_receipt(raw, transfer.image_transfer.sha(raw), CONTEXT)
        self.assertEqual(check(body), body)
        for change in ({'schema': True}, {'code_sha': 'c'*40}, {'run_id': '999'}, {'run_attempt': '2'},
                       {'producer_boot_id': CONTEXT['boot_id']}, {'token': 'no'}, {'image_config_id': 'no'},
                       {'base_image': 'orthanc:latest'}, {'snapshot': {}}, {'extra': 1}):
            with self.subTest(change=change), self.assertRaises(ValueError): check(dict(body, **change))
        for key in transfer.LIMITS:
            for size in (True, 0, transfer.LIMITS[key]+1):
                other = copy.deepcopy(body); other['files'][key]['bytes'] = size
                with self.assertRaises(ValueError): check(other)
        raw = json.dumps(body).encode()
        with self.assertRaises(ValueError): transfer.parse_receipt(raw, '0'*64, CONTEXT)
        for raw in (b'{"schema":1,"schema":1}', b'NaN', b' '*8193):
            with self.assertRaises(ValueError): transfer.parse_receipt(raw, transfer.image_transfer.sha(raw), CONTEXT)

    def test_03_archive_closed_paths_hashes_and_duplicates(self):
        body, files, _, store = fixture()
        self.assertEqual(worker.archive_files(files['store.tar'], body['snapshot']), store)
        for name in ('../escape', '/absolute', 'index/../escape', 'store\\escape', 'config.json', 'index/index-wal', 'index/index'):
            extra = tarfile.TarInfo(name); extra.size = 1
            with self.subTest(name=name), self.assertRaises(ValueError):
                worker.archive_files(tar_bytes(store, extra), body['snapshot'])
        for changed in ({}, dict(store, **{'index/index': b'changed'})):
            with self.assertRaises(ValueError): worker.archive_files(tar_bytes(changed), body['snapshot'])
        with self.assertRaises(ValueError): worker.archive_files(files['store.tar']+b'X'*512, body['snapshot'])
        with self.assertRaises(ValueError): worker.archive_files(b'0'*(worker.LIMIT+1), body['snapshot'])

    def test_04_links_devices_fifo_and_wrong_directory_refused(self):
        body, _, _, store = fixture()
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.FIFOTYPE, tarfile.DIRTYPE):
            extra = tarfile.TarInfo('unexpected'); extra.type = kind; extra.linkname = '/escape'
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                worker.archive_files(tar_bytes(store, extra), body['snapshot'])

    def test_05_snapshot_attachment_contract(self):
        body, _, _, _ = fixture()
        for change in ('missing', 'duplicate', 'bool', 'uuid', 'extra-file', 'sample'):
            other = copy.deepcopy(body['snapshot'])
            if change == 'missing': other['attachments'].pop()
            elif change == 'duplicate': other['attachments'][1] = other['attachments'][0]
            elif change == 'bool': other['attachments'][0]['file_type'] = True
            elif change == 'uuid': other['attachments'][0]['uuid'] = '../escape'
            elif change == 'extra-file': other['files']['config.json'] = next(iter(other['files'].values()))
            else: other['files'][worker.store_path(other['attachments'][1]['uuid'])]['sha256'] = '0'*64
            with self.subTest(change=change), self.assertRaises(ValueError): worker.snapshot_contract(other)

    def test_06_config_tag_architecture_and_layer_validation(self):
        body, files, config, _ = fixture()
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            for name, raw in files.items(): (folder/name).write_bytes(raw)
            transfer.verify_files(folder, body)
            for change in ({'User': 'root'}, {'Labels': {}}, {'Cmd': ['sh']}, {'Entrypoint': ['/bin/sh']}):
                with self.assertRaises(ValueError): transfer.settings(dict(config, **change), TOKEN)
            for args in (dict(tag='foreign:latest'), dict(corrupt_layer=True)):
                item, raw = image_fixture(config, **args); (folder/'image.tar').write_bytes(raw)
                with self.assertRaises(ValueError): transfer.image_config(folder/'image.tar', item['image_id'], TOKEN)

    def test_07_rest_full_bytes_even_when_http_success(self):
        body, _, _, store = fixture()
        instance = body['snapshot']['instance']
        def call(path):
            if path == '/instances': return json.dumps([instance]).encode()
            if path.endswith('/simplified-tags'): return b'{"PatientID":"SYNTHETIC-C12K","PatientName":"SYNTHETIC^C12K"}'
            return b'wrong bytes'
        with patch.object(worker, 'call', side_effect=call), self.assertRaises(ValueError): worker.verify_rest(body['snapshot'], store)

    def test_08_graceful_stop_failure_kills_and_never_freezes(self):
        process = Mock(); process.wait.side_effect = [subprocess.TimeoutExpired('Orthanc', 15), 0]; process.poll.return_value = None
        with self.assertRaises(subprocess.TimeoutExpired): worker.stop(process)
        process.kill.assert_called_once()
        with patch.object(worker, 'start', return_value=process), patch.object(worker, 'call', return_value=b'{"ID":"x"}'), \
             patch.object(worker, 'stop', side_effect=TimeoutError), patch.object(worker, 'observe') as observe:
            with self.assertRaises(TimeoutError): worker.produce()
            observe.assert_not_called()

    def test_09_container_is_nonroot_isolated_and_portless(self):
        with patch.object(transfer, 'command', return_value=b'65534\n') as calls:
            transfer.start_container('image', 'owned', TOKEN)
            args = calls.call_args_list[0].args[0]
            for flag in ('--user=65534:65534', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges'):
                self.assertIn(flag, args)
            self.assertFalse(any(flag in args for flag in ('-p', '-P', '--publish', '-v', '--mount', '--privileged')))


@unittest.skipUnless(sys.platform == 'linux', 'Linux private FD semantics')
class Linux(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.body, files, self.config, _ = fixture()
        for name, raw in files.items(): (self.root/name).write_bytes(raw)
        self.raw = json.dumps(self.body).encode(); (self.root/'receipt.json').write_bytes(self.raw)

    def tearDown(self): self.temp.cleanup()

    def consume(self):
        with patch.object(transfer.image_transfer, 'ci_context', return_value=CONTEXT):
            return transfer.consume(self.root, transfer.image_transfer.sha(self.raw))

    def test_10_download_links_fifo_oversize_and_private_copy(self):
        with tempfile.TemporaryDirectory() as output:
            output = Path(output)
            transfer.copy_download(self.root/'store.tar', output/'copy', worker.LIMIT)
            self.assertEqual((output/'copy').stat().st_mode & 0o777, 0o600)
            for kind in ('symlink', 'hardlink', 'fifo', 'oversize'):
                source = output/kind
                if kind == 'symlink': source.symlink_to(self.root/'store.tar')
                elif kind == 'hardlink': os.link(self.root/'store.tar', source)
                elif kind == 'fifo': os.mkfifo(source)
                else: source.write_bytes(b'x'*33)
                with self.subTest(kind=kind), self.assertRaises((ValueError, OSError)):
                    transfer.copy_download(source, output/(kind+'-copy'), 32)

    def test_11_bad_receipt_store_or_extra_never_loads(self):
        with patch.object(transfer, 'command') as calls, patch.object(transfer.image_transfer, 'inspect_image') as inspect:
            (self.root/'receipt.json').write_bytes(b'{}')
            with self.assertRaises(ValueError): self.consume()
            (self.root/'receipt.json').write_bytes(self.raw); (self.root/'store.tar').write_bytes(b'bad')
            with self.assertRaises(ValueError): self.consume()
            (self.root/'extra').write_bytes(b'x')
            with self.assertRaises(ValueError): self.consume()
            calls.assert_not_called(); inspect.assert_not_called()

    def test_12_existing_image_never_loaded_or_removed(self):
        with patch.object(transfer.image_transfer, 'inspect_image', return_value={'Id': self.body['image_id']}), \
             patch.object(transfer, 'command') as calls, patch.object(transfer, 'remove_image') as remove:
            with self.assertRaises(ValueError): self.consume()
            calls.assert_not_called(); remove.assert_not_called()

    def consume_mocked(self, fail=None):
        snapshot = self.body['snapshot']
        restored = dict(instance=snapshot['instance'], attachments=snapshot['attachments'],
                        rest_bytes_match=True, sqlite_integrity=True, uid=65534)
        with patch.object(transfer.image_transfer, 'inspect_image', side_effect=[None, {'Config': self.config}]), \
             patch.object(transfer, 'cached_layers', return_value=[]), \
             patch.object(transfer, 'command', return_value=json.dumps(restored).encode()), \
             patch.object(transfer, 'start_container', side_effect=fail), \
             patch.object(transfer.ops, 'remove_owned_if_present') as clean, patch.object(transfer, 'remove_image') as remove:
            if fail:
                with self.assertRaises(TimeoutError): self.consume()
            else:
                result = self.consume()
                self.assertTrue(result['synthetic_orthanc_restored'] and result['source_unchanged'])
                self.assertTrue(all(result[k] is False for k in ('full_restore_verified', 'offsite_backup_verified', 'deployment_authorized')))
            clean.assert_called_once_with('container', 'kin-rehearsal-'+TOKEN[:16], TOKEN)
            remove.assert_called_once_with(self.body['image_id'], TOKEN)

    def test_13_restore_result_boundaries_and_owned_cleanup(self): self.consume_mocked()

    def test_14_timeout_cleans_known_resources(self): self.consume_mocked(TimeoutError('injected'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
