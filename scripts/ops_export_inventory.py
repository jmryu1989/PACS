"""Verify a private offline export inventory; never restore, load images or upload."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tarfile
import tempfile

from ops_backup import FILES
from ops_monitor import NAMES

HEX = re.compile(r'[0-9a-f]{64}')
IMAGE = re.compile(r'sha256:[0-9a-f]{64}')
META_LIMIT = 1024 * 1024
FILE_LIMIT = 128 * 1024**3
LAYER_LIMIT = 8 * 1024**3
HOST_FILES = {'host/' + name for name in ('collector.sh', 'crontab.txt', 'settings.json',
                                         'tls-fullchain.pem', 'tls-privkey.pem')}
SOURCE_FILES = ('docker-compose.yml', 'docker-compose.prod.yml', 'docker-compose.monitor.yml',
                'scripts/ops_backup.py', 'scripts/ops_monitor.py')


def require(value):
    if not value:
        raise ValueError('Invalid export inventory or component')


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def parse(raw):
    require(len(raw) <= META_LIMIT)
    return json.loads(raw, object_pairs_hook=unique, parse_constant=lambda value: require(False))


def relative(name):
    require(type(name) is str and 0 < len(name) < 256 and '\\' not in name and ':' not in name)
    require(all(part not in ('', '.', '..') for part in name.split('/')))
    require(not PurePosixPath(name).is_absolute() and not any(ord(c) < 32 for c in name))
    return name


def private(path, directory=False):
    info = path.lstat()
    require(not getattr(info, 'st_file_attributes', 0) & 0x400)
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
    if os.name == 'posix':
        require(info.st_uid == os.geteuid() and not stat.S_IMODE(info.st_mode) & 0o077)
    return info


def stream_digest(stream, limit=FILE_LIMIT):
    result, size = hashlib.sha256(), 0
    while True:
        chunk = stream.read(1024 * 1024)
        if not chunk:
            return result.hexdigest(), size
        size += len(chunk)
        require(size <= limit)
        result.update(chunk)


def file_record(path):
    before = private(path)
    require(0 < before.st_size <= FILE_LIMIT)
    with path.open('rb') as stream:
        digest, size = stream_digest(stream)
    after = path.stat()
    require((before.st_ino, before.st_size, before.st_mtime_ns) ==
            (after.st_ino, after.st_size, after.st_mtime_ns))
    return {'bytes': size, 'sha256': digest}


def metadata(path):
    require(private(path).st_size <= META_LIMIT)
    with path.open('rb') as stream:
        return parse(stream.read(META_LIMIT + 1))


def check_bundle(path, sha):
    # No checkout, templates, user Git configuration or inherited object stores.
    # An empty recipient also makes external prerequisites fail closed.
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT='0')
    with tempfile.TemporaryDirectory(prefix='kin-export-git-') as folder:
        def git(*args):
            result = subprocess.run(['git', '-C', folder, '-c', 'core.hooksPath=' + os.devnull, *args],
                                    env=env, capture_output=True, timeout=120)
            require(result.returncode == 0)
            return result.stdout.decode('utf-8')
        git('init', '--bare', '--template=')
        git('bundle', 'verify', str(path))
        refs = git('bundle', 'unbundle', str(path)).splitlines()
        require(any(line.split()[0] == sha for line in refs))
        require(git('cat-file', '-t', sha).strip() == 'commit')
        git('fsck', '--full', '--strict', '--no-reflogs', sha)
        for name in SOURCE_FILES:
            require(git('cat-file', '-t', sha + ':' + name).strip() == 'blob')
            require(re.fullmatch(r'100(?:644|755) blob [0-9a-f]{40}\t' + re.escape(name) + '\x00',
                                 git('ls-tree', '-z', sha, '--', name)))


def check_image(path, identity):
    require(type(identity) is str and IMAGE.fullmatch(identity))
    # Read members without extracting: image layer paths must never touch this host.
    with tarfile.open(path, 'r:') as archive:
        members = {}
        for member in archive:
            name = relative(member.name)
            require(name not in members and len(members) < 8192)
            require(member.isdir() or member.isfile())
            require(0 <= member.size <= FILE_LIMIT and member.offset_data + member.size <= path.stat().st_size)
            members[name] = member

        def data(name):
            relative(name)
            require(name in members and members[name].isfile() and members[name].size <= META_LIMIT)
            return archive.extractfile(members[name]).read()

        manifest = parse(data('manifest.json'))
        require(type(manifest) is list and len(manifest) == 1 and type(manifest[0]) is dict)
        config_name, layers = manifest[0]['Config'], manifest[0]['Layers']
        config_raw = data(config_name)
        config_id = 'sha256:' + hashlib.sha256(config_raw).hexdigest()
        config = parse(config_raw)
        require(type(layers) is list and len(layers) <= 256 and all(type(x) is str for x in layers))
        require(config.get('os') == 'linux' and type(config.get('architecture')) is str)
        rootfs = config.get('rootfs', {})
        require(rootfs.get('type') == 'layers')
        diff_ids = rootfs.get('diff_ids')
        require(type(diff_ids) is list and len(diff_ids) == len(layers))
        for name, expected in zip(layers, diff_ids):
            relative(name)
            require(type(expected) is str and IMAGE.fullmatch(expected))
            require(name in members and members[name].isfile())
            with archive.extractfile(members[name]) as stream:
                compressed = stream.read(2) == b'\x1f\x8b'
                stream.seek(0)
                if compressed:
                    with gzip.GzipFile(fileobj=stream) as expanded:
                        actual, _ = stream_digest(expanded, LAYER_LIMIT)
                else:
                    actual, _ = stream_digest(stream, LAYER_LIMIT)
            require('sha256:' + actual == expected)
        if identity == config_id:
            return

        # Containerd-backed Docker can identify the OCI index instead of config.
        # Follow only hashed descriptors present in this archive, never a URL.
        index = parse(data('index.json'))
        roots = index.get('manifests')
        require(type(roots) is list)
        selected = [item for item in roots if item.get('digest') == identity]
        require(len(selected) == 1)
        found, visited = False, set()

        def visit(descriptor, depth=0):
            nonlocal found
            require(type(descriptor) is dict and depth < 16)
            digest, size = descriptor.get('digest'), descriptor.get('size')
            require(type(digest) is str and IMAGE.fullmatch(digest) and type(size) is int and size >= 0)
            name = 'blobs/sha256/' + digest[7:]
            require(name in members and members[name].isfile() and members[name].size == size)
            with archive.extractfile(members[name]) as stream:
                require(stream_digest(stream)[0] == digest[7:])
            if digest in visited:
                return
            visited.add(digest)
            media = descriptor.get('mediaType', '')
            if media in ('application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'):
                body = parse(data(name))
                require(body.get('schemaVersion') == 2 and type(body.get('manifests')) is list)
                for child in body['manifests']:
                    visit(child, depth + 1)
            elif media in ('application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'):
                body = parse(data(name))
                require(body.get('schemaVersion') == 2 and type(body.get('layers')) is list)
                visit(body['config'], depth + 1)
                for child in body['layers']:
                    visit(child, depth + 1)
                if body['config'].get('digest') == config_id:
                    require(config_name == 'blobs/sha256/' + config_id[7:])
                    require(layers == ['blobs/sha256/' + child['digest'][7:] for child in body['layers']])
                    found = True
        visit(selected[0])
        require(found)


def parse_inventory(raw, expected_hash):
    require(type(expected_hash) is str and HEX.fullmatch(expected_hash))
    require(hashlib.sha256(raw).hexdigest() == expected_hash)
    body = parse(raw)
    require(type(body) is dict and set(body) == {'schema', 'git_sha', 'storage_mode', 'running_images', 'files'})
    require(type(body['schema']) is int and body['schema'] == 1 and body['storage_mode'] == 'local')
    sha, images, files = body['git_sha'], body['running_images'], body['files']
    require(type(sha) is str and re.fullmatch('[0-9a-f]{40}', sha))
    require(type(images) is dict and set(images) == set(NAMES))
    require(all(type(value) is str and IMAGE.fullmatch(value) for value in images.values()))
    expected = {'snapshot/' + name for name in (*FILES, 'manifest.json')} | HOST_FILES | {'source.bundle'}
    expected |= {'images/' + value[7:] + '.tar' for value in images.values()}
    require(type(files) is dict and set(files) == expected)
    for name, record in files.items():
        relative(name)
        require(type(record) is dict and set(record) == {'bytes', 'sha256'})
        require(type(record['bytes']) is int and 0 < record['bytes'] <= FILE_LIMIT)
        require(type(record['sha256']) is str and HEX.fullmatch(record['sha256']))
    return body


def verify(root, expected_hash):
    require(not any(p.is_symlink() or getattr(p.lstat(), 'st_file_attributes', 0) & 0x400
                    for p in (root, *root.parents)))
    root = root.resolve()
    private(root, directory=True)
    require(private(root / 'inventory.json').st_size <= META_LIMIT)
    with (root / 'inventory.json').open('rb') as stream:
        body = parse_inventory(stream.read(META_LIMIT + 1), expected_hash)
    sha, images, files = body['git_sha'], body['running_images'], body['files']
    expected = set(files)
    actual = set()
    for directory, dirs, names in os.walk(root, followlinks=False):
        private(Path(directory), directory=True)
        require(Path(directory).relative_to(root).as_posix() in ('.', 'snapshot', 'host', 'images'))
        require(len(dirs) + len(names) <= 64)
        for name in dirs:
            private(Path(directory) / name, directory=True)
        for name in names:
            path = Path(directory) / name
            private(path)
            actual.add(relative(path.relative_to(root).as_posix()))
        require(len(actual) <= len(expected) + 1)
    require(actual == expected | {'inventory.json'})
    for name, record in files.items():
        require(file_record(root / name) == record)
    snapshot = metadata(root / 'snapshot/manifest.json')
    require(type(snapshot.get('format')) is int and snapshot['format'] == 1 and snapshot.get('complete') is True)
    require(snapshot.get('git_sha') == sha and snapshot.get('git_dirty') is False and not snapshot.get('backup_error'))
    running = snapshot.get('running_images')
    require(type(running) is dict and set(running) == set(NAMES))
    require(all(type(running[name]) is dict and running[name].get('id') == images[name] for name in NAMES))
    require(snapshot.get('postgres_image') == images['kin-db'] and snapshot.get('orthanc_image') == images['kin-orthanc'])
    for field in ('sha256', 'bytes'):
        require(type(snapshot.get(field)) is dict and set(snapshot[field]) == set(FILES))
        require(all(type(snapshot[field][name]) is type(files['snapshot/' + name][field])
                    and snapshot[field][name] == files['snapshot/' + name][field] for name in FILES))
    check_bundle(root / 'source.bundle', sha)
    for identity in sorted(set(images.values())):
        check_image(root / ('images/' + identity[7:] + '.tar'), identity)
    require(hashlib.sha256((root / 'inventory.json').read_bytes()).hexdigest() == expected_hash)
    return {'inventory_verified': True, 'inventory_sha256': expected_hash, 'git_sha': sha,
            'file_count': len(files), 'image_count': len(set(images.values())),
            'source_services_ready': snapshot.get('ready') is True and snapshot.get('resume_failures') == [],
            'encrypted': False, 'offsite_verified': False, 'restore_verified': False,
            'deployment_authorized': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--inventory-sha256', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.directory, args.inventory_sha256)))
        return 0
    except Exception as error:
        print(json.dumps({'inventory_verified': False, 'error_type': type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
