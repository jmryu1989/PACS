"""Offline synthetic export refusals; Git bundles are real, Docker is never invoked."""
import copy
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import ops_export_inventory as export


def raw_json(value):
    return json.dumps(value, separators=(',', ':')).encode()


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_bytes(data)
    path.chmod(0o600)


def make_tar(parts):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as archive:
        for name, data in parts:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return output.getvalue()


def image_fixture(compressed=False):
    layer = make_tar([('synthetic', b'not patient data')])
    config = raw_json({'os': 'linux', 'architecture': 'amd64', 'rootfs': {'type': 'layers',
                        'diff_ids': ['sha256:' + hashlib.sha256(layer).hexdigest()]}})
    identity = 'sha256:' + hashlib.sha256(config).hexdigest()
    config_name = identity[7:] + '.json'
    parts = [('manifest.json', raw_json([{'Config': config_name, 'Layers': ['layer.tar'], 'RepoTags': []}])),
             (config_name, config), ('layer.tar', gzip.compress(layer) if compressed else layer)]
    return identity, parts


def oci_fixture():
    _, classic = image_fixture(compressed=True)
    parts = []
    def descriptor(data, media):
        digest = hashlib.sha256(data).hexdigest()
        parts.append(('blobs/sha256/' + digest, data))
        return {'mediaType': 'application/vnd.oci.image.' + media, 'digest': 'sha256:' + digest, 'size': len(data)}
    config = descriptor(classic[1][1], 'config.v1+json')
    layer = descriptor(classic[2][1], 'layer.v1.tar+gzip')
    manifest = descriptor(raw_json({'schemaVersion': 2, 'config': config, 'layers': [layer]}), 'manifest.v1+json')
    index = descriptor(raw_json({'schemaVersion': 2, 'manifests': [manifest]}), 'index.v1+json')
    parts.extend([('index.json', raw_json({'schemaVersion': 2, 'manifests': [index]})),
                  ('manifest.json', raw_json([{'Config': 'blobs/sha256/' + config['digest'][7:],
                                              'Layers': ['blobs/sha256/' + layer['digest'][7:]], 'RepoTags': []}]))])
    return index['digest'], parts


class ExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workspace = tempfile.TemporaryDirectory(prefix='kin-export-test-')
        cls.base = Path(cls.workspace.name)
        cls.repo = cls.base / 'source'
        cls.repo.mkdir()
        cls.git('init', '--template=')
        for name in export.SOURCE_FILES:
            write(cls.repo / name, b'synthetic source fixture\n')
        cls.git('add', '--', *export.SOURCE_FILES)
        cls.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture')
        cls.sha = cls.git('rev-parse', 'HEAD').strip()
        cls.bundle = cls.base / 'source.bundle'
        cls.git('bundle', 'create', str(cls.bundle), 'HEAD')

    @classmethod
    def git(cls, *args):
        env = {key: value for key, value in os.environ.items() if not key.upper().startswith('GIT_')}
        env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
        return subprocess.check_output(['git', '-C', str(cls.repo), '-c', 'core.hooksPath=' + os.devnull, *args],
                                       env=env, stderr=subprocess.DEVNULL).decode()

    @classmethod
    def tearDownClass(cls):
        # Git object files can be read-only on Windows; relax only the temporary fixture.
        for path in cls.base.rglob('*'):
            if path.is_file():
                path.chmod(0o600)
        cls.workspace.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='kin-export-inventory-')
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.identity, self.parts = image_fixture()
        self.images = {name: self.identity for name in export.NAMES}
        for name in export.FILES:
            write(self.root / 'snapshot' / name, b'synthetic ' + name.encode())
        for name in export.HOST_FILES:
            write(self.root / name, b'synthetic host configuration, not a real key')
        write(self.root / 'source.bundle', self.bundle.read_bytes())
        self.image_path = 'images/' + self.identity[7:] + '.tar'
        write(self.root / self.image_path, make_tar(self.parts))
        self.snapshot = {'format': 1, 'complete': True, 'git_sha': self.sha, 'git_dirty': False,
                         'postgres_image': self.identity, 'orthanc_image': self.identity,
                         'running_images': {key: {'id': value} for key, value in self.images.items()},
                         'sha256': {}, 'bytes': {}, 'ready': True, 'resume_failures': []}
        for name in export.FILES:
            record = export.file_record(self.root / 'snapshot' / name)
            for field in ('bytes', 'sha256'):
                self.snapshot[field][name] = record[field]
        self.body = {'schema': 1, 'git_sha': self.sha, 'storage_mode': 'local',
                     'running_images': self.images, 'files': {}}
        self.refresh()

    def tearDown(self):
        for path in self.root.rglob('*'):
            if not path.is_symlink():
                path.chmod(0o700 if path.is_dir() else 0o600)
        self.temp.cleanup()

    def refresh(self):
        write(self.root / 'snapshot/manifest.json', raw_json(self.snapshot))
        self.body['files'] = {p.relative_to(self.root).as_posix(): export.file_record(p)
                              for p in self.root.rglob('*') if p.is_file() and p.name != 'inventory.json'}
        return self.seal()

    def seal(self):
        raw = raw_json(self.body)
        write(self.root / 'inventory.json', raw)
        self.expected = hashlib.sha256(raw).hexdigest()
        return self.expected

    def verify(self):
        return export.verify(self.root, self.expected)

    def test_01_complete_set_is_read_only_and_not_restore_authority(self):
        before = {p.relative_to(self.root).as_posix(): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        result = self.verify()
        self.assertTrue(result['inventory_verified'])
        self.assertTrue(result['source_services_ready'])
        for name in ('encrypted', 'offsite_verified', 'restore_verified', 'deployment_authorized'):
            self.assertFalse(result[name])
        self.assertEqual(before, {p.relative_to(self.root).as_posix(): p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_02_resume_failure_does_not_discard_complete_snapshot(self):
        self.snapshot.update(ready=False, resume_failures=['kin-api'])
        self.refresh()
        result = self.verify()
        self.assertTrue(result['inventory_verified'])
        self.assertFalse(result['source_services_ready'])

    def test_03_each_required_component_is_required(self):
        for name in list(self.body['files']):
            with self.subTest(name=name):
                record = self.body['files'].pop(name)
                self.seal()
                with self.assertRaises(ValueError): self.verify()
                self.body['files'][name] = record

    def test_04_unlisted_file_and_empty_directory_are_refused(self):
        extra = self.root / 'unintended-private-key'
        write(extra, b'not a real secret')
        with self.assertRaises(ValueError): self.verify()
        extra.unlink()
        (self.root / 'unexpected').mkdir(mode=0o700)
        with self.assertRaises(ValueError): self.verify()

    def test_05_checksum_size_and_separate_manifest_hash(self):
        write(self.root / 'snapshot/.env', b'changed')
        with self.assertRaises(ValueError): self.verify()
        with self.assertRaises(ValueError): export.verify(self.root, '0' * 64)
        with self.assertRaises(ValueError): export.verify(self.root, '--unsafe')

    def test_06_json_duplicate_keys_types_modes_and_paths(self):
        with self.assertRaises(ValueError): export.parse(b'{"schema":1,"schema":1}')
        with self.assertRaises(ValueError): export.parse(b'{"x":NaN}')
        for path in ('../x', '/x', 'x//y', 'x/./y', 'C:/x', 'x\\y', 'x\ny'):
            with self.subTest(path=path), self.assertRaises(ValueError): export.relative(path)
        for field, value in (('schema', True), ('storage_mode', 'object'), ('git_sha', 'HEAD')):
            original = self.body[field]
            self.body[field] = value; self.seal()
            with self.assertRaises(ValueError): self.verify()
            self.body[field] = original

    def test_07_snapshot_completion_sha_dirty_and_image_conflicts(self):
        for field, value in (('complete', False), ('format', True), ('git_sha', 'a'*40),
                             ('git_dirty', True), ('postgres_image', 'sha256:'+'0'*64),
                             ('backup_error', {'stage': 'dump'})):
            original = copy.deepcopy(self.snapshot)
            self.snapshot[field] = value; self.refresh()
            with self.subTest(field=field), self.assertRaises(ValueError): self.verify()
            self.snapshot = original

    def test_08_missing_or_changed_snapshot_file_is_not_masked_by_inventory(self):
        self.snapshot['bytes']['kin.dump'] += 1
        self.refresh()
        with self.assertRaises(ValueError): self.verify()

    def test_09_image_config_and_layer_corruption_rejected_even_if_resealed(self):
        for index in (1, 2):
            parts = list(self.parts)
            name, data = parts[index]
            parts[index] = (name, data + b'changed')
            write(self.root / self.image_path, make_tar(parts)); self.refresh()
            with self.subTest(index=index), self.assertRaises((ValueError, json.JSONDecodeError)): self.verify()

    def test_10_tar_paths_duplicate_and_links_refused_without_extraction(self):
        for extra in ('../escaped', self.parts[1][0], '/absolute'):
            write(self.root / self.image_path, make_tar(self.parts + [(extra, b'x')]))
            with self.subTest(extra=extra), self.assertRaises(ValueError): export.check_image(self.root / self.image_path, self.identity)
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as archive:
            link = tarfile.TarInfo('linked'); link.type = tarfile.SYMTYPE; link.linkname = '/etc/passwd'; archive.addfile(link)
        write(self.root / self.image_path, stream.getvalue())
        with self.assertRaises(ValueError): export.check_image(self.root / self.image_path, self.identity)

    def test_11_compressed_layer_and_expansion_limit(self):
        identity, parts = image_fixture(compressed=True)
        write(self.root / self.image_path, make_tar(parts))
        export.check_image(self.root / self.image_path, identity)
        with patch.object(export, 'LAYER_LIMIT', 100), self.assertRaises(ValueError):
            export.check_image(self.root / self.image_path, identity)

    def test_12_git_bundle_wrong_sha_and_corruption(self):
        with self.assertRaises(ValueError): export.check_bundle(self.root / 'source.bundle', '0'*40)
        write(self.root / 'source.bundle', self.bundle.read_bytes()[:-30])
        with self.assertRaises(ValueError): export.check_bundle(self.root / 'source.bundle', self.sha)

    def test_13_incremental_bundle_rejected_in_empty_recipient(self):
        write(self.repo / 'extra', b'next commit')
        self.git('add', '--', 'extra')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'increment')
        partial = self.root / 'partial.bundle'
        self.git('bundle', 'create', str(partial), self.sha + '..HEAD')
        with self.assertRaises(ValueError): export.check_bundle(partial, self.git('rev-parse', 'HEAD').strip())

    def test_14_hardlink_and_symlink_refused(self):
        path = self.root / 'snapshot/.env'
        other = self.root / 'linked'
        os.link(path, other)
        with self.assertRaises(ValueError): self.verify()
        other.unlink()
        # Simulate symlink metadata on Windows where creation needs extra privileges.
        with patch.object(Path, 'is_symlink', return_value=True), self.assertRaises(ValueError): self.verify()

    def test_15_private_permissions_and_limits(self):
        with patch.object(export, 'META_LIMIT', 10), self.assertRaises(ValueError): self.verify()
        if os.name == 'posix':
            (self.root / 'snapshot/.env').chmod(0o644)
            with self.assertRaises(ValueError): self.verify()
        else:
            original = Path.lstat
            def public(path, *args, **kwargs):
                info = original(path, *args, **kwargs)
                from types import SimpleNamespace
                return SimpleNamespace(st_mode=info.st_mode, st_nlink=info.st_nlink, st_file_attributes=0x400)
            with patch.object(Path, 'lstat', public), self.assertRaises(ValueError): self.verify()

    def test_16_cli_redacts_supplied_paths_and_never_executes_docker(self):
        result = subprocess.run([sys.executable, str(Path(export.__file__)), str(self.root/'PRIVATE_SENTINEL'),
                                 '--inventory-sha256', self.expected], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('PRIVATE_SENTINEL', result.stderr + result.stdout)
        self.assertFalse(json.loads(result.stderr)['inventory_verified'])
        real = subprocess.run
        def guarded(args, **kwargs):
            self.assertEqual(args[0], 'git')
            return real(args, **kwargs)
        with patch.object(export.subprocess, 'run', guarded): self.verify()

    def test_17_oci_index_identity_connects_exact_config_and_layers(self):
        identity, parts = oci_fixture()
        write(self.root / self.image_path, make_tar(parts))
        export.check_image(self.root / self.image_path, identity)
        with self.assertRaises(ValueError): export.check_image(self.root / self.image_path, 'sha256:'+'0'*64)
        # Replacing a blob while keeping its name and root identity must fail.
        name, data = parts[2]
        parts[2] = (name, data.replace(b'"schemaVersion":2', b'"schemaVersion":3'))
        write(self.root / self.image_path, make_tar(parts))
        with self.assertRaises(ValueError): export.check_image(self.root / self.image_path, identity)

    def test_18_oci_missing_descriptor_blob_and_wrong_size(self):
        identity, parts = oci_fixture()
        write(self.root / self.image_path, make_tar([row for i, row in enumerate(parts) if i != 2]))
        with self.assertRaises(ValueError): export.check_image(self.root / self.image_path, identity)
        index = json.loads(parts[-2][1]); index['manifests'][0]['size'] += 1
        parts[-2] = ('index.json', raw_json(index))
        write(self.root / self.image_path, make_tar(parts))
        with self.assertRaises(ValueError): export.check_image(self.root / self.image_path, identity)

    def test_19_truncated_archive_and_physical_component_absence(self):
        data = make_tar(self.parts)
        write(self.root / self.image_path, data[:1000])
        with self.assertRaises((ValueError, tarfile.TarError)):
            export.check_image(self.root / self.image_path, self.identity)
        (self.root / 'snapshot/kin.dump').unlink()
        with self.assertRaises(ValueError): self.verify()

    def test_20_source_missing_required_overlay_is_refused(self):
        (self.repo / 'docker-compose.monitor.yml').unlink()
        self.git('add', '--', 'docker-compose.monitor.yml')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'missing overlay')
        bundle = self.root / 'missing-overlay.bundle'
        self.git('bundle', 'create', str(bundle), 'HEAD')
        with self.assertRaises(ValueError): export.check_bundle(bundle, self.git('rev-parse', 'HEAD').strip())


if __name__ == '__main__':
    unittest.main(verbosity=2)
