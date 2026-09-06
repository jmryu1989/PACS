"""Linux real-age preparation/refusal tests; Windows runs the platform contract only."""
import errno
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import ops_export_crypto as crypto
import ops_export_inventory as inventory
import ops_export_inventory_test as fixtures
from ops_export_inventory_test import make_tar, write


class PlatformTests(unittest.TestCase):
    def test_01_windows_refuses_before_data_or_tool_access(self):
        with patch.object(crypto.sys, 'platform', 'win32'), patch.object(crypto, 'private_dir') as access:
            with self.assertRaises(ValueError): crypto.seal(Path('missing'), Path('output'), Path('age'), 'bad', '0'*64)
            with self.assertRaises(ValueError): crypto.unseal(Path('missing'), Path('output'), Path('age'), Path('key'), '0'*64)
            access.assert_not_called()

    def test_02_recipient_and_identity_reject_plugins_passphrases_and_newlines(self):
        for text in ('age-plugin-test', 'ssh-ed25519 anything', '-p', 'age1'+'q'*58+'\n', 'AGE-SECRET-KEY-1'+'Q'*58):
            self.assertIsNone(crypto.RECIPIENT.fullmatch(text))
        self.assertIsNotNone(crypto.RECIPIENT.fullmatch('age1'+'q'*58))
        self.assertIsNotNone(crypto.IDENTITY.fullmatch('AGE-SECRET-KEY-1'+'Q'*58))

    def test_03_receipt_requires_separate_hash_and_strict_schema(self):
        raw = b'{"schema":true}'
        for digest in ('0'*64, hashlib.sha256(raw).hexdigest(), '--unsafe'):
            with self.assertRaises(ValueError): crypto.parse_receipt(raw, digest)

    def test_04_cli_errors_do_not_echo_paths(self):
        result = subprocess.run([sys.executable, str(Path(crypto.__file__)), 'seal', '--source', 'PRIVATE_SENTINEL',
            '--destination', 'PRIVATE_SENTINEL', '--age', 'PRIVATE_SENTINEL', '--recipient', 'bad',
            '--inventory-sha256', '0'*64], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('PRIVATE_SENTINEL', result.stdout + result.stderr)
        self.assertFalse(json.loads(result.stderr)['prepared'])


@unittest.skipUnless(sys.platform == 'linux', 'Real preparation requires Linux permissions and renameat2')
class CryptoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        incoming = Path(os.environ['KIN_TEST_AGE']).absolute()
        fixtures.ExportTests.setUpClass()
        folder = fixtures.ExportTests.base / 'tools'
        folder.mkdir(mode=0o700)
        # Windows bind mounts expose permissive modes even when mounted read-only.
        # Reproduce a protected Linux installation in the fixture, not weaker checks.
        for name in ('age', 'age-keygen'):
            shutil.copyfile(incoming.with_name(name), folder/name)
            (folder/name).chmod(0o500)
        cls.age = folder / 'age'
        cls.keygen = folder / 'age-keygen'
        # Both binaries came from the pinned official Linux archive, not PATH.
        assert hashlib.sha256(cls.keygen.read_bytes()).hexdigest() == '0a0009db842259d6717f7eeb30acb6b90d2a2eb924c6acd0a0db0ca1f1537899'

    @classmethod
    def tearDownClass(cls):
        fixtures.ExportTests.tearDownClass()

    def setUp(self):
        self.fixture = fixtures.ExportTests()
        self.fixture.setUp()
        self.source = self.fixture.root
        self.temp = tempfile.TemporaryDirectory(prefix='kin-crypto-tests-')
        self.output = Path(self.temp.name)
        self.output.chmod(0o700)
        self.key = self.output / 'identity.txt'
        subprocess.run([str(self.keygen), '-o', str(self.key)], check=True, capture_output=True)
        self.recipient = subprocess.check_output([str(self.keygen), '-y', str(self.key)]).decode().strip()
        self.original = {str(p.relative_to(self.source)): p.read_bytes() for p in self.source.rglob('*') if p.is_file()}

    def tearDown(self):
        self.fixture.tearDown()
        self.temp.cleanup()

    def seal(self, name='sealed'):
        return crypto.seal(self.source, self.output / name, self.age, self.recipient, self.fixture.expected)

    def unseal(self, digest, name='opened', source='sealed', identity=None):
        return crypto.unseal(self.output / source, self.output / name, self.age, identity or self.key, digest)

    def assert_failed(self, name):
        self.assertFalse((self.output / name).exists())
        pending = self.output / ('.'+name+'.pending')
        self.assertEqual({p.name for p in pending.iterdir()}, {'failure.json'})
        self.assertFalse(json.loads((pending/'failure.json').read_text())['prepared'])

    def assert_original(self):
        self.assertEqual(self.original, {str(p.relative_to(self.source)): p.read_bytes()
                                        for p in self.source.rglob('*') if p.is_file()})

    def test_01_real_age_roundtrip_and_exact_private_staging(self):
        result = self.seal()
        self.assertTrue(result['encrypted_export_prepared'])
        self.assertEqual({p.name for p in (self.output/'sealed').iterdir()}, {'payload.age', 'receipt.json'})
        opened = self.unseal(result['receipt_sha256'])
        self.assertTrue(opened['decrypted_inventory_prepared'])
        for field in ('offsite_verified', 'restore_verified', 'deployment_authorized'):
            self.assertFalse(opened[field]); self.assertFalse(result[field])
        staging = self.output/'opened/staging'
        self.assertEqual(self.original, {str(p.relative_to(staging)): p.read_bytes() for p in staging.rglob('*') if p.is_file()})
        for path in (self.output/'opened').rglob('*'):
            self.assertEqual(path.stat().st_mode & 0o777, 0o700 if path.is_dir() else 0o600)
        self.assert_original()

    def test_02_ready_false_snapshot_roundtrips_without_restore_authority(self):
        self.fixture.snapshot.update(ready=False, resume_failures=['kin-api'])
        self.fixture.refresh()
        opened = self.unseal(self.seal()['receipt_sha256'])
        self.assertFalse(opened['source_services_ready'])

    def test_03_changed_shrunk_grown_inputs_after_verify_never_publish(self):
        path = self.source/'snapshot/.env'
        original = path.read_bytes()
        real = inventory.verify
        for index, replacement in enumerate((b'x'*len(original), original[:-1], original+b'extra')):
            name = 'changed'+str(index)
            def changed(*args, **kwargs):
                result = real(*args, **kwargs)
                path.write_bytes(replacement)
                return result
            with self.subTest(index=index), patch.object(inventory, 'verify', changed), self.assertRaises(ValueError):
                self.seal(name)
            self.assert_failed(name)
            path.write_bytes(original)
        self.assert_original()

    def test_04_symlink_swap_after_verify_never_reads_target(self):
        path = self.source/'snapshot/.env'
        held = self.output/'original-env'
        real = inventory.verify
        def changed(*args, **kwargs):
            result = real(*args, **kwargs)
            path.rename(held); path.symlink_to(held)
            return result
        with patch.object(inventory, 'verify', changed), self.assertRaises(ValueError): self.seal()
        self.assert_failed('sealed')
        path.unlink(); held.rename(path)
        self.assert_original()

    def test_05_inventory_replaced_after_verify_is_bound_to_original_hash(self):
        real = inventory.verify
        def changed(*args, **kwargs):
            result = real(*args, **kwargs)
            (self.source/'inventory.json').write_bytes(b'{}')
            return result
        with patch.object(inventory, 'verify', changed), self.assertRaises(ValueError): self.seal()
        self.assertFalse((self.output/'.sealed.pending').exists())

    def test_06_disk_failure_removes_plaintext_and_preserves_source(self):
        def no_space(source, raw, body, target):
            write(target, b'partial plaintext')
            raise OSError(errno.ENOSPC, 'synthetic disk full')
        with patch.object(crypto, 'pack', no_space), self.assertRaises(OSError): self.seal()
        self.assert_failed('sealed'); self.assert_original()

    def test_07_failed_age_timeout_and_interrupt_do_not_publish(self):
        for index, error in enumerate((ValueError('age failed'), subprocess.TimeoutExpired('age', 1), KeyboardInterrupt())):
            def failed(age, source, output, **kwargs):
                write(output, b'partial output')
                raise error
            name='fail'+str(index)
            with self.subTest(index=index), patch.object(crypto, 'age_run', failed), self.assertRaises(type(error)):
                self.seal(name)
            self.assert_failed(name)
        self.assert_original()

    def test_08_wrong_age_binary_cannot_run(self):
        wrong = self.output/'fake-age'
        write(wrong, b'#!/bin/sh\ntouch SHOULD_NOT_EXIST\n'); wrong.chmod(0o700)
        with self.assertRaises(ValueError):
            crypto.seal(self.source, self.output/'sealed', wrong, self.recipient, self.fixture.expected)
        self.assert_failed('sealed')
        self.assertFalse((self.output/'SHOULD_NOT_EXIST').exists())

    def test_09_wrong_receipt_hash_or_payload_is_refused_before_age(self):
        result = self.seal()
        with self.assertRaises(ValueError): self.unseal('0'*64)
        payload = self.output/'sealed/payload.age'
        payload.write_bytes(payload.read_bytes()[:-1])
        with patch.object(crypto, 'age_run') as run, self.assertRaises(ValueError): self.unseal(result['receipt_sha256'])
        run.assert_not_called(); self.assert_failed('opened')

    def test_10_wrong_key_and_identity_formats_refused(self):
        result = self.seal()
        wrong = self.output/'wrong.txt'
        subprocess.run([str(self.keygen), '-o', str(wrong)], check=True, capture_output=True)
        with self.assertRaises(ValueError): self.unseal(result['receipt_sha256'], identity=wrong)
        self.assert_failed('opened')
        write(wrong, b'AGE-PLUGIN-SYNTHETIC-1INVALID\n')
        with self.assertRaises(ValueError): self.unseal(result['receipt_sha256'], name='plugin', identity=wrong)
        self.assert_failed('plugin')

    def test_11_authenticated_tail_failure_cleans_partial_plaintext(self):
        # Extend a component so age must write multiple authenticated chunks.
        data = b'synthetic only\n'*100000
        write(self.source/'snapshot/kin.dump', data)
        self.fixture.snapshot['bytes']['kin.dump'] = len(data)
        self.fixture.snapshot['sha256']['kin.dump'] = hashlib.sha256(data).hexdigest()
        self.fixture.refresh()
        self.seal()
        payload = self.output/'sealed/payload.age'
        raw = bytearray(payload.read_bytes()); raw[-1] ^= 1; payload.write_bytes(raw)
        receipt_path = self.output/'sealed/receipt.json'
        receipt = json.loads(receipt_path.read_bytes())
        receipt['ciphertext'] = crypto.hash_file(payload)
        receipt_path.write_bytes(crypto.encode(receipt))
        digest = hashlib.sha256(receipt_path.read_bytes()).hexdigest()
        with self.assertRaises(ValueError): self.unseal(digest)
        self.assert_failed('opened')

    def test_12_existing_result_and_pending_are_not_overwritten(self):
        result = self.seal()
        before = (self.output/'sealed/payload.age').read_bytes()
        with self.assertRaises(ValueError): self.seal()
        self.assertEqual(before, (self.output/'sealed/payload.age').read_bytes())
        pending = self.output/'.blocked.pending'; pending.mkdir(mode=0o700)
        write(pending/'retained', b'previous run')
        with self.assertRaises(FileExistsError): self.seal('blocked')
        self.assertEqual((pending/'retained').read_bytes(), b'previous run')
        self.unseal(result['receipt_sha256'])
        with self.assertRaises(ValueError): self.unseal(result['receipt_sha256'])

    def test_13_public_parent_source_identity_and_symlink_refused(self):
        self.output.chmod(0o755)
        with self.assertRaises(ValueError): self.seal()
        self.output.chmod(0o700)
        result = self.seal()
        self.key.chmod(0o644)
        with self.assertRaises(ValueError): self.unseal(result['receipt_sha256'])
        self.assert_failed('opened')
        linked = self.output/'linked'; linked.symlink_to(self.output/'sealed')
        with self.assertRaises(ValueError): self.unseal(result['receipt_sha256'], name='linkedout', source='linked')

    def test_14_no_replace_even_when_destination_appears_during_publication(self):
        real = crypto.publish
        def race(pending, destination):
            destination.mkdir(mode=0o700)
            write(destination/'other-result', b'untouched')
            real(pending, destination)
        with patch.object(crypto, 'publish', race), self.assertRaises(OSError): self.seal()
        self.assertEqual((self.output/'sealed/other-result').read_bytes(), b'untouched')
        self.assertEqual({p.name for p in (self.output/'.sealed.pending').iterdir()}, {'failure.json'})

    def test_15_fsync_failure_before_publish_and_after_rename(self):
        with patch.object(crypto, 'sync', side_effect=OSError(errno.ENOSPC, 'full')), self.assertRaises(OSError): self.seal()
        self.assert_failed('sealed')
        real = crypto.sync_directory
        def late(path):
            if path == self.output: raise OSError(errno.EIO, 'durability uncertain')
            return real(path)
        with patch.object(crypto, 'sync_directory', late), self.assertRaises(OSError): self.seal('late')
        self.assertEqual({p.name for p in (self.output/'late').iterdir()}, {'receipt.json','payload.age'})
        self.assertFalse((self.output/'.late.pending').exists())

    def test_16_tar_paths_duplicates_links_and_missing_members_are_rejected(self):
        raw = (self.source/'inventory.json').read_bytes()
        entries = [('inventory.json', raw)] + [(name, (self.source/name).read_bytes()) for name in sorted(self.fixture.body['files'])]
        variants = [entries + [('../escaped', b'x')], entries + [entries[1]], entries[:-1]]
        for index, members in enumerate(variants):
            path = self.output/('bad'+str(index)+'.tar'); write(path, make_tar(members))
            stage = self.output/('stage'+str(index))
            with self.subTest(index=index), self.assertRaises(ValueError): crypto.unpack(path, stage, self.fixture.expected)
        self.assertFalse((self.output/'escaped').exists())
        stream=io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as archive:
            info=tarfile.TarInfo('inventory.json'); info.type=tarfile.SYMTYPE; info.linkname='/etc/passwd'; archive.addfile(info)
        write(self.output/'linked.tar',stream.getvalue())
        with self.assertRaises(ValueError): crypto.unpack(self.output/'linked.tar',self.output/'linked-stage',self.fixture.expected)

    def test_17_wrong_plaintext_hash_never_unpacks(self):
        self.seal()
        path=self.output/'sealed/receipt.json'; body=json.loads(path.read_bytes()); body['plaintext']['sha256']='0'*64
        path.write_bytes(crypto.encode(body))
        with patch.object(crypto,'unpack') as extract, self.assertRaises(ValueError):
            self.unseal(hashlib.sha256(path.read_bytes()).hexdigest())
        extract.assert_not_called();self.assert_failed('opened')

    def test_18_process_uses_fixed_executable_fd_and_no_identity_argument_on_seal(self):
        real=subprocess.run; calls=[]
        def guarded(args, **kwargs):
            calls.append((args,kwargs))
            return real(args,**kwargs)
        with patch.object(crypto.subprocess,'run',guarded): self.seal()
        age_calls=[call for call in calls if call[0][0].startswith('/proc/self/fd/')]
        self.assertEqual(len(age_calls),1)
        self.assertNotIn('-i',age_calls[0][0]);self.assertNotIn(str(self.key),age_calls[0][0])
        self.assertTrue(age_calls[0][1]['pass_fds'])
        self.assertTrue(all(call[0][0]=='git' or call[0][0].startswith('/proc/self/fd/') for call in calls))

    def test_19_input_changes_during_stream_are_refused(self):
        path = self.source/'snapshot/kin.dump'
        original = b'synthetic dump bytes\n'*100000
        write(path, original)
        self.fixture.snapshot['bytes']['kin.dump'] = len(original)
        self.fixture.snapshot['sha256']['kin.dump'] = hashlib.sha256(original).hexdigest()
        self.fixture.refresh()
        real = crypto.BoundReader.read
        for index, replacement in enumerate((b'x'*len(original), original[:50000], original+b'extra')):
            changed = []
            def racing(reader, size):
                data = real(reader, size)
                if reader.expected['sha256'] == hashlib.sha256(original).hexdigest() and not changed:
                    path.write_bytes(replacement)
                    changed.append(True)
                return data
            name = 'stream'+str(index)
            with self.subTest(index=index), patch.object(crypto.BoundReader, 'read', racing), self.assertRaises((ValueError, OSError)):
                self.seal(name)
            self.assertTrue(changed); self.assert_failed(name)
            path.write_bytes(original)

    def test_20_cli_real_roundtrip_and_failed_extraction_cleanup(self):
        base = [sys.executable, '-B', str(Path(crypto.__file__))]
        sealed = subprocess.run(base+['seal', '--source', str(self.source), '--destination', str(self.output/'sealed'),
            '--age', str(self.age), '--recipient', self.recipient, '--inventory-sha256', self.fixture.expected],
            capture_output=True, text=True, check=True)
        digest = json.loads(sealed.stdout)['receipt_sha256']
        opened = subprocess.run(base+['unseal', '--source', str(self.output/'sealed'), '--destination', str(self.output/'opened'),
            '--age', str(self.age), '--identity', str(self.key), '--receipt-sha256', digest],
            capture_output=True, text=True, check=True)
        self.assertTrue(json.loads(opened.stdout)['decrypted_inventory_prepared'])
        self.assertNotIn(self.key.read_text(), sealed.stdout+sealed.stderr+opened.stdout+opened.stderr)
        def fail_extract(plaintext, staging, expected):
            staging.mkdir(mode=0o700)
            write(staging/'partial', b'partial plaintext')
            raise ValueError('invalid archive')
        with patch.object(crypto, 'unpack', fail_extract), self.assertRaises(ValueError):
            self.unseal(digest, name='extractfail')
        self.assert_failed('extractfail'); self.assert_original()


if __name__ == '__main__':
    unittest.main(verbosity=2)
