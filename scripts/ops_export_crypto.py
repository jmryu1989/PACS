"""Linux-only local encrypted export preparation; no upload or database restore."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile

import ops_export_inventory as inventory

AGE_SHA256 = 'eb7dd1b518f0a307c99cd97782623c5321da049154b04acd2d98d21aa7bc9b2c'
MAX_TOTAL = 512 * 1024**3
AGE_TIMEOUT = 900
BECH32 = '023456789acdefghjklmnpqrstuvwxyz'
RECIPIENT = re.compile('age1[' + BECH32 + ']{58}')
IDENTITY = re.compile('AGE-SECRET-KEY-1[' + BECH32.upper() + ']{58}')
RECEIPT_FIELDS = {'schema', 'inventory_sha256', 'source_git_sha', 'verifier_sha256',
                  'wrapper_sha256', 'age_sha256', 'recipient_sha256', 'plaintext', 'ciphertext'}


def require(value):
    if not value:
        raise ValueError('Encrypted export preparation refused')


def linux_only():
    require(sys.platform == 'linux')


def path_guard(path):
    path = Path(path).absolute()
    require('..' not in path.parts)
    require(not any(p.is_symlink() for p in (path, *path.parents)))
    return path


def private_dir(path):
    path = path_guard(path)
    info = path.stat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
            and stat.S_IMODE(info.st_mode) == 0o700)
    return path


def fd_private(info):
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.geteuid()
            and not stat.S_IMODE(info.st_mode) & 0o077)


@contextmanager
def read_private(path):
    path = path_guard(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        fd_private(os.fstat(stream.fileno()))
        yield stream


def read_small(path):
    with read_private(path) as stream:
        raw = stream.read(inventory.META_LIMIT + 1)
    require(len(raw) <= inventory.META_LIMIT)
    return raw


def create_file(path):
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb')


def sync(stream):
    stream.flush()
    os.fsync(stream.fileno())


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def hash_file(path):
    with read_private(path) as stream:
        digest, size = inventory.stream_digest(stream, MAX_TOTAL)
    return {'bytes': size, 'sha256': digest}


def source_hashes():
    return {'verifier_sha256': hashlib.sha256(Path(inventory.__file__).read_bytes()).hexdigest(),
            'wrapper_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}


def publish(pending, destination):
    # os.rename can replace an empty destination directory on Linux. Never replace
    # an existing result, even if another process creates it after our preflight.
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(pending), -100, os.fsencode(destination), 1) != 0:
        raise OSError(ctypes.get_errno(), 'Export publication refused')
    sync_directory(destination.parent)


@contextmanager
def workspace(destination, source):
    destination = Path(destination).absolute()
    parent = private_dir(destination.parent)
    require(re.fullmatch('[A-Za-z0-9][A-Za-z0-9_-]{0,63}', destination.name))
    require(source != parent and source not in parent.parents)
    require(not destination.exists() and not destination.is_symlink())
    pending = parent / ('.' + destination.name + '.pending')
    pending.mkdir(mode=0o700)  # Existing pending state belongs to an earlier run.
    pending.chmod(0o700)
    try:
        yield pending
    except BaseException:
        # Only our exclusively created directory is eligible for cleanup. A
        # post-rename fsync failure leaves the intact published result untouched.
        if pending.exists():
            private_dir(pending)
            require(shutil.rmtree.avoids_symlink_attacks)
            for path in pending.iterdir():
                if path.is_dir() and not path.is_symlink():
                    shutil.rmtree(path)
                else:
                    path.unlink()
            try:
                with create_file(pending / 'failure.json') as out:
                    out.write(b'{"prepared":false,"retry_requires_pending_inspection":true}\n')
                    sync(out)
            except OSError:
                pass  # Disk failure must not prevent removal of partial plaintext.
        raise


@contextmanager
def tool_fd(path):
    path = path_guard(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid in (0, os.geteuid())
                and not stat.S_IMODE(info.st_mode) & 0o022)
        require(inventory.stream_digest(stream, 32 * 1024**2)[0] == AGE_SHA256)
        stream.seek(0)
        yield fd


def age_run(age, source, output, *, recipient=None, identity=None):
    with tool_fd(age) as executable, read_private(source) as incoming, create_file(output) as outgoing:
        args = ['/proc/self/fd/' + str(executable)]
        passed = [executable]
        if recipient is not None:
            require(RECIPIENT.fullmatch(recipient))
            args += ['--encrypt', '-r', recipient]
        else:
            require(identity is not None)
            args += ['--decrypt', '-i', '/proc/self/fd/' + str(identity.fileno())]
            identity.seek(0)
            passed.append(identity.fileno())
        env = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'HOME': str(output.parent), 'TMPDIR': str(output.parent)}
        result = subprocess.run(args, stdin=incoming, stdout=outgoing, stderr=subprocess.DEVNULL,
                                pass_fds=passed, cwd=output.parent, env=env, timeout=AGE_TIMEOUT)
        require(result.returncode == 0)
        sync(outgoing)


class BoundReader:
    def __init__(self, stream, expected):
        self.stream, self.expected = stream, expected
        self.sha, self.count = hashlib.sha256(), 0
        self.before = os.fstat(stream.fileno())
        fd_private(self.before)
        require(self.before.st_size == expected['bytes'])

    def read(self, size):
        require(0 <= size <= 1024 * 1024)
        data = self.stream.read(size)
        self.count += len(data)
        self.sha.update(data)
        return data

    def finish(self):
        require(not self.stream.read(1))
        require(self.count == self.expected['bytes'] and self.sha.hexdigest() == self.expected['sha256'])
        after = os.fstat(self.stream.fileno())
        require((self.before.st_ino, self.before.st_size, self.before.st_mtime_ns) ==
                (after.st_ino, after.st_size, after.st_mtime_ns))


def pack(source, raw, body, target):
    require(sum(row['bytes'] for row in body['files'].values()) + len(raw) + 1024**2 <= MAX_TOTAL)
    with create_file(target) as out:
        # USTAR cannot encode an 8GiB member although inventory permits larger
        # components. GNU base-256 sizes preserve the fixed regular-file paths.
        with tarfile.open(fileobj=out, mode='w|', format=tarfile.GNU_FORMAT) as archive:
            info = tarfile.TarInfo('inventory.json')
            info.mode, info.size = 0o600, len(raw)
            archive.addfile(info, io.BytesIO(raw))
            for name, expected in sorted(body['files'].items()):
                inventory.relative(name)
                info = tarfile.TarInfo(name)
                info.mode, info.size = 0o600, expected['bytes']
                with read_private(source / name) as stream:
                    bound = BoundReader(stream, expected)
                    archive.addfile(info, bound)
                    bound.finish()
        sync(out)


def encode(value):
    return json.dumps(value, separators=(',', ':'), sort_keys=True).encode() + b'\n'


def seal(source, destination, age, recipient, expected):
    linux_only()
    require(type(recipient) is str and RECIPIENT.fullmatch(recipient))
    source = private_dir(source)
    verified = inventory.verify(source, expected)
    raw = read_small(source / 'inventory.json')
    body = inventory.parse_inventory(raw, expected)
    with workspace(destination, source) as pending:
        plaintext = pending / 'plaintext.tar'
        pack(source, raw, body, plaintext)
        original = hash_file(plaintext)
        age_run(age, plaintext, pending / 'payload.age', recipient=recipient)
        require(hash_file(plaintext) == original)
        receipt = dict(schema=1, inventory_sha256=expected, source_git_sha=verified['git_sha'],
                       age_sha256=AGE_SHA256, recipient_sha256=hashlib.sha256(recipient.encode()).hexdigest(),
                       plaintext=original, ciphertext=hash_file(pending / 'payload.age'), **source_hashes())
        receipt_raw = encode(receipt)
        with create_file(pending / 'receipt.json') as out:
            out.write(receipt_raw)
            sync(out)
        plaintext.unlink()
        sync_directory(pending)
        publish(pending, Path(destination).absolute())
    return {'encrypted_export_prepared': True, 'receipt_sha256': hashlib.sha256(receipt_raw).hexdigest(),
            'offsite_verified': False, 'restore_verified': False, 'deployment_authorized': False}


def parse_receipt(raw, expected):
    require(type(expected) is str and inventory.HEX.fullmatch(expected))
    require(hashlib.sha256(raw).hexdigest() == expected)
    body = inventory.parse(raw)
    require(type(body) is dict and set(body) == RECEIPT_FIELDS and type(body['schema']) is int and body['schema'] == 1)
    for field in ('inventory_sha256', 'verifier_sha256', 'wrapper_sha256', 'age_sha256', 'recipient_sha256'):
        require(type(body[field]) is str and inventory.HEX.fullmatch(body[field]))
    require(body['age_sha256'] == AGE_SHA256 and body['verifier_sha256'] == source_hashes()['verifier_sha256'])
    require(type(body['source_git_sha']) is str and re.fullmatch('[0-9a-f]{40}', body['source_git_sha']))
    for field in ('plaintext', 'ciphertext'):
        row = body[field]
        require(type(row) is dict and set(row) == {'bytes', 'sha256'})
        require(type(row['bytes']) is int and 0 < row['bytes'] <= MAX_TOTAL)
        require(type(row['sha256']) is str and inventory.HEX.fullmatch(row['sha256']))
    return body


def copy_bound(source, target, expected):
    with read_private(source) as incoming, create_file(target) as out:
        reader = BoundReader(incoming, expected)
        while reader.count < expected['bytes']:
            data = reader.read(min(1024 * 1024, expected['bytes'] - reader.count))
            require(data)
            out.write(data)
        reader.finish()
        sync(out)


@contextmanager
def identity_fd(path, folder):
    raw = read_small(path)
    lines = [row.strip() for row in raw.decode('ascii').splitlines() if row.strip() and not row.startswith('#')]
    require(len(lines) == 1 and IDENTITY.fullmatch(lines[0]))
    # An anonymous file avoids a second named private-key copy in failed output.
    with tempfile.TemporaryFile(dir=folder) as identity:
        identity.write((lines[0] + '\n').encode())
        identity.seek(0)
        yield identity


def unpack(plaintext, staging, expected):
    staging.mkdir(mode=0o700)
    with tarfile.open(plaintext, 'r:') as archive:
        first = archive.next()
        require(first is not None and first.name == 'inventory.json' and first.type == tarfile.REGTYPE
                and not first.pax_headers and 0 < first.size <= inventory.META_LIMIT)
        raw = archive.extractfile(first).read(inventory.META_LIMIT + 1)
        body = inventory.parse_inventory(raw, expected)
        with create_file(staging / 'inventory.json') as out:
            out.write(raw)
            sync(out)
        seen = set()
        while True:
            member = archive.next()
            if member is None:
                break
            name = inventory.relative(member.name)
            require(name in body['files'] and name not in seen and member.type == tarfile.REGTYPE
                    and not member.pax_headers and member.size == body['files'][name]['bytes'])
            seen.add(name)
            path = staging / name
            path.parent.mkdir(mode=0o700, exist_ok=True)
            with archive.extractfile(member) as incoming, create_file(path) as out:
                sha, count = hashlib.sha256(), 0
                while True:
                    data = incoming.read(1024 * 1024)
                    if not data:
                        break
                    count += len(data)
                    require(count <= member.size)
                    sha.update(data)
                    out.write(data)
                require(count == member.size and sha.hexdigest() == body['files'][name]['sha256'])
                sync(out)
        require(seen == set(body['files']))
    result = inventory.verify(staging, expected)
    for directory in (staging / 'snapshot', staging / 'host', staging / 'images', staging):
        sync_directory(directory)
    return result


def unseal(source, destination, age, identity, expected):
    linux_only()
    source = private_dir(source)
    require({p.name for p in source.iterdir()} == {'payload.age', 'receipt.json'})
    raw = read_small(source / 'receipt.json')
    receipt = parse_receipt(raw, expected)
    with workspace(destination, source) as pending:
        cipher = pending / 'ciphertext.age'
        copy_bound(source / 'payload.age', cipher, receipt['ciphertext'])
        plaintext = pending / 'plaintext.tar'
        with identity_fd(identity, pending) as key:
            age_run(age, cipher, plaintext, identity=key)
        require(hash_file(plaintext) == receipt['plaintext'])
        result = unpack(plaintext, pending / 'staging', receipt['inventory_sha256'])
        require(result['git_sha'] == receipt['source_git_sha'])
        with create_file(pending / 'receipt.json') as out:
            out.write(raw)
            sync(out)
        plaintext.unlink()
        cipher.unlink()
        sync_directory(pending)
        publish(pending, Path(destination).absolute())
    return {'decrypted_inventory_prepared': True, 'inventory_sha256': receipt['inventory_sha256'],
            'source_services_ready': result['source_services_ready'], 'offsite_verified': False,
            'restore_verified': False, 'deployment_authorized': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('seal', 'unseal'):
        command = sub.add_parser(name)
        for field in ('source', 'destination', 'age'):
            command.add_argument('--' + field, type=Path, required=True)
        command.add_argument('--inventory-sha256' if name == 'seal' else '--receipt-sha256', required=True)
        command.add_argument('--recipient' if name == 'seal' else '--identity', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'seal':
            result = seal(args.source, args.destination, args.age, args.recipient, args.inventory_sha256)
        else:
            result = unseal(args.source, args.destination, args.age, Path(args.identity), args.receipt_sha256)
        print(json.dumps(result))
        return 0
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({'prepared': False, 'error_type': type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
