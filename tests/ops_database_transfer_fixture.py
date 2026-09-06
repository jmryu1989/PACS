"""Hosted CI synthetic PostgreSQL transfer only; never an operational restorer."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

import ops_image_transfer_fixture as image_transfer

ops = image_transfer.ops
inventory = image_transfer.inventory
require = image_transfer.require
command = image_transfer.command
BASE = 'postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685'
DATABASES = ('kin', 'keycloak')
LIMITS = {'image.tar': 512*1024**2, 'kin.dump': 16*1024**2, 'keycloak.dump': 16*1024**2}
FIELDS = {'schema', 'code_sha', 'run_id', 'run_attempt', 'producer_boot_id', 'token',
          'image_id', 'image_config_id', 'base_image', 'files', 'rows'}
SQL = "CREATE TABLE fixture(id integer PRIMARY KEY, value text NOT NULL); INSERT INTO fixture VALUES(1,'alpha'),(2,'beta'),(3,'gamma');"
SELECT = 'SELECT id,value FROM fixture ORDER BY id'
EXPECTED = b'1|alpha\n2|beta\n3|gamma\n'


def record(path, limit):
    require(0 < path.stat().st_size <= limit)
    with path.open('rb') as incoming:
        digest, size = inventory.stream_digest(incoming, limit)
    require(size == path.stat().st_size)
    return dict(bytes=size, sha256=digest)


def copy_download(source, target, limit):
    # A service image is much larger than the C12I probe: never read it all into
    # memory. Only a bounded regular FD is copied into the private workspace.
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as incoming:
        before = os.fstat(incoming.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == os.geteuid()
                and 0 < before.st_size <= limit)
        size = 0
        with target.open('xb') as output:
            os.fchmod(output.fileno(), 0o600)
            while True:
                chunk = incoming.read(min(1024**2, limit-size+1))
                if not chunk:
                    break
                size += len(chunk)
                require(size <= limit)
                output.write(chunk)
        after = os.fstat(incoming.fileno())
        require(size == before.st_size and (before.st_ino, before.st_size, before.st_mtime_ns) ==
                (after.st_ino, after.st_size, after.st_mtime_ns))


def parse_receipt(raw, expected, context):
    require(type(expected) is str and inventory.HEX.fullmatch(expected) and len(raw) <= 8192
            and image_transfer.sha(raw) == expected)
    body = inventory.parse(raw)
    require(type(body) is dict and set(body) == FIELDS and type(body['schema']) is int and body['schema'] == 1)
    require(all(body[key] == context[key] for key in ('code_sha', 'run_id', 'run_attempt')))
    require(type(body['producer_boot_id']) is str and image_transfer.UUID.fullmatch(body['producer_boot_id'])
            and body['producer_boot_id'] != context['boot_id'])
    require(type(body['token']) is str and re.fullmatch('[0-9a-f]{32}', body['token']))
    require(all(type(body[key]) is str and inventory.IMAGE.fullmatch(body[key]) for key in ('image_id', 'image_config_id')))
    require(body['base_image'] == BASE and type(body['files']) is dict and set(body['files']) == set(LIMITS))
    for name, entry in body['files'].items():
        require(type(entry) is dict and set(entry) == {'bytes', 'sha256'}
                and type(entry['bytes']) is int and 0 < entry['bytes'] <= LIMITS[name]
                and type(entry['sha256']) is str and inventory.HEX.fullmatch(entry['sha256']))
    require(body['rows'] == {db: {'count': 3, 'sha256': image_transfer.sha(EXPECTED)} for db in DATABASES})
    require(all(type(body['rows'][db]['count']) is int for db in DATABASES))
    return body


def settings(config, token):
    require(type(config) is dict and config.get('User') == '70:70'
            and config.get('Entrypoint') == ['docker-entrypoint.sh'] and config.get('Cmd') == ['postgres']
            and (config.get('Labels') or {}).get('kin.ci.database') == token
            and (config.get('Labels') or {}).get('kin.ci.base') == BASE)


def image_config(path, identity, token):
    inventory.check_image(path, identity)
    with tarfile.open(path, 'r:') as archive:
        manifest = inventory.parse(archive.extractfile('manifest.json').read())
        require(manifest[0].get('RepoTags') == ['kin-ci-database:'+token])
        raw = archive.extractfile(manifest[0]['Config']).read()
        config = inventory.parse(raw)
        require(config.get('architecture') == 'amd64')
        settings(config.get('config'), token)
        return 'sha256:'+image_transfer.sha(raw)


def verify_files(folder, body):
    for name, limit in LIMITS.items():
        require(record(folder/name, limit) == body['files'][name])
    require(image_config(folder/'image.tar', body['image_id'], body['token']) == body['image_config_id'])
    for database in DATABASES:
        with (folder/(database+'.dump')).open('rb') as incoming:
            require(incoming.read(5) == b'PGDMP')


def remove_image(identity, token):
    found = image_transfer.inspect_image(identity)
    if found is not None:
        settings(found.get('Config'), token)
        command(['docker', 'image', 'rm', identity])


def start_database(identity, name, token):
    command(['docker', 'create', '--name', name, '--label', 'kin.ops.run='+token,
             '--user=70:70', '--network=none', '--read-only', '--cap-drop=ALL',
             '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=256m', '--cpus=1',
             '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,uid=70,gid=70,mode=0700,size=128m',
             '--tmpfs', '/var/run/postgresql:rw,nosuid,uid=70,gid=70,mode=0770,size=8m',
             '--tmpfs', '/tmp:rw,nosuid,size=8m', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', identity])
    command(['docker', 'start', name])
    deadline = time.monotonic()+60
    while time.monotonic() < deadline:
        ready = subprocess.run(['docker', 'exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
                               capture_output=True, timeout=5)
        if ready.returncode == 0:
            require(command(['docker', 'exec', name, 'id', '-u']).strip() == b'70')
            return
        time.sleep(.5)
    raise TimeoutError('Synthetic PostgreSQL readiness timeout')


def query(name, database):
    return command(['docker', 'exec', name, 'psql', '-U', 'postgres', '-d', database,
                    '-v', 'ON_ERROR_STOP=1', '-At', '-c', SELECT])


def verify_rows(name):
    result = {}
    for database in DATABASES:
        observed = query(name, database)
        require(observed == EXPECTED)
        result[database] = dict(count=len(observed.splitlines()), sha256=image_transfer.sha(observed))
    return result


def produce(destination):
    context = image_transfer.ci_context()
    token, identity = uuid.uuid4().hex, None
    name, tag = 'kin-rehearsal-'+token[:16], 'kin-ci-database:'+token
    destination.mkdir(mode=0o700)
    try:
        with tempfile.TemporaryDirectory(prefix='kin-ci-pg-build-') as folder:
            folder = Path(folder)
            image_transfer.write(folder/'Dockerfile', ('FROM '+BASE+'\nUSER 70:70\n'
                'LABEL kin.ci.database="'+token+'" kin.ci.base="'+BASE+'"\n').encode())
            command(['docker', 'build', '--pull', '--platform=linux/amd64', '--network=none',
                     '--iidfile', str(folder/'iid'), '-t', tag, str(folder)], timeout=180)
            identity = (folder/'iid').read_text().strip()
            require(inventory.IMAGE.fullmatch(identity))
        command(['docker', 'image', 'save', '--output', str(destination/'image.tar'), tag], timeout=120)
        (destination/'image.tar').chmod(0o600)
        require(0 < (destination/'image.tar').stat().st_size <= LIMITS['image.tar'])
        config_id = image_config(destination/'image.tar', identity, token)
        start_database(identity, name, token)
        for database in DATABASES:
            command(['docker', 'exec', name, 'createdb', '-U', 'postgres', database])
            command(['docker', 'exec', name, 'psql', '-U', 'postgres', '-d', database,
                     '-v', 'ON_ERROR_STOP=1', '-c', SQL])
            path = destination/(database+'.dump')
            with path.open('xb') as output:
                os.fchmod(output.fileno(), 0o600)
                subprocess.run(['docker', 'exec', name, 'pg_dump', '-U', 'postgres', '-Fc', database],
                               check=True, stdout=output, stderr=subprocess.PIPE, timeout=60)
        body = dict(schema=1, code_sha=context['code_sha'], run_id=context['run_id'], run_attempt=context['run_attempt'],
                    producer_boot_id=context['boot_id'], token=token, image_id=identity, image_config_id=config_id,
                    base_image=BASE, files={file: record(destination/file, cap) for file, cap in LIMITS.items()},
                    rows=verify_rows(name))
        verify_files(destination, body)
        require(verify_rows(name) == body['rows'])
        raw = json.dumps(body, sort_keys=True).encode()
        image_transfer.write(destination/'receipt.json', raw)
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
            output.write('receipt_sha256='+image_transfer.sha(raw)+'\n')
        return dict(synthetic_database_archive_prepared=True, image_id=identity, files=body['files'], rows=body['rows'])
    finally:
        try:
            ops.remove_owned_if_present('container', name, token)
        finally:
            if identity is not None:
                remove_image(identity, token)


def consume(source, expected):
    context = image_transfer.ci_context()
    require(not source.is_symlink() and source.is_dir() and
            {path.name for path in source.iterdir()} == set(LIMITS) | {'receipt.json'})
    with tempfile.TemporaryDirectory(prefix='kin-ci-pg-restore-') as folder:
        folder = Path(folder)
        copy_download(source/'receipt.json', folder/'receipt.json', 8192)
        body = parse_receipt((folder/'receipt.json').read_bytes(), expected, context)
        for file, cap in LIMITS.items():
            copy_download(source/file, folder/file, cap)
        verify_files(folder, body)
        identity, token = body['image_id'], body['token']
        require(image_transfer.inspect_image(identity) is None)
        name = 'kin-rehearsal-'+token[:16]
        try:
            command(['docker', 'image', 'load', '--input', str(folder/'image.tar')], timeout=120)
            loaded = image_transfer.inspect_image(identity)
            require(loaded is not None)
            settings(loaded.get('Config'), token)
            start_database(identity, name, token)
            for database in DATABASES:
                command(['docker', 'exec', name, 'createdb', '-U', 'postgres', database])
                with (folder/(database+'.dump')).open('rb') as incoming:
                    command(['docker', 'exec', '-i', name, 'pg_restore', '-U', 'postgres', '-d', database,
                             '--no-owner', '--no-privileges', '--exit-on-error'], stdin=incoming)
            rows = verify_rows(name)
            require(rows == body['rows'])
            verify_files(folder, body)
            require(all(record(source/file, cap) == body['files'][file] for file, cap in LIMITS.items()))
            require(image_transfer.sha((source/'receipt.json').read_bytes()) == expected)
        finally:
            try:
                ops.remove_owned_if_present('container', name, token)
            finally:
                remove_image(identity, token)
    return dict(synthetic_database_restored=True, image_id=identity, image_config_id=body['image_config_id'],
                producer_boot_id=body['producer_boot_id'], consumer_boot_id=context['boot_id'],
                originally_absent=True, source_unchanged=True, rows=rows, full_restore_verified=False,
                offsite_backup_verified=False, deployment_authorized=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['produce', 'consume'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('--receipt-sha256')
    args = parser.parse_args()
    try:
        result = produce(args.directory) if args.mode == 'produce' else consume(args.directory, args.receipt_sha256)
        print(json.dumps(result))
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as output:
            output.write('```json\n'+json.dumps(result, indent=2)+'\n```\n')
        return 0
    except Exception as error:
        print(json.dumps({'synthetic_database_restored': False, 'error_type': type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
