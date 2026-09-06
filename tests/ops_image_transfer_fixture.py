"""Synthetic image transfer between hosted CI jobs; never an operational loader."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
import ops_backup as ops
import ops_export_inventory as inventory

LIMIT = 16 * 1024**2
MARKER = b'KIN-SYNTHETIC-IMAGE-RESTORE\n'
FIELDS = {'schema', 'code_sha', 'run_id', 'run_attempt', 'producer_boot_id', 'token', 'image_id',
          'archive_bytes', 'archive_sha256', 'marker_sha256'}
UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}')


def require(value):
    if not value:
        raise ValueError('Synthetic image fixture refused')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def command(args, timeout=60, **kwargs):
    return subprocess.run(args, cwd=ROOT, check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=timeout, **kwargs).stdout


def ci_context():
    # These flags prevent accidental local use; they are not an authorization
    # boundary against a hostile process with this runner's user privileges.
    require(sys.platform == 'linux' and os.environ.get('GITHUB_ACTIONS') == 'true'
            and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
            and os.environ.get('GITHUB_REPOSITORY') == 'jmryu1989/PACS')
    body = {key: os.environ[env] for key, env in
            [('code_sha', 'GITHUB_SHA'), ('run_id', 'GITHUB_RUN_ID'), ('run_attempt', 'GITHUB_RUN_ATTEMPT')]}
    require(re.fullmatch('[0-9a-f]{40}', body['code_sha']))
    require(all(re.fullmatch('[0-9]{1,20}', body[key]) for key in ('run_id', 'run_attempt')))
    require(command(['git', 'rev-parse', 'HEAD']).decode().strip() == body['code_sha'])
    body['boot_id'] = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    require(UUID.fullmatch(body['boot_id']))
    ops.require_local_docker()
    return body


def parse_receipt(raw, expected, context):
    require(type(expected) is str and inventory.HEX.fullmatch(expected) and len(raw) <= 8192 and sha(raw) == expected)
    body = inventory.parse(raw)
    require(type(body) is dict and set(body) == FIELDS and type(body['schema']) is int and body['schema'] == 1)
    require(all(body[key] == context[key] for key in ('code_sha', 'run_id', 'run_attempt')))
    require(type(body['producer_boot_id']) is str and UUID.fullmatch(body['producer_boot_id'])
            and body['producer_boot_id'] != context['boot_id'])
    require(type(body['token']) is str and re.fullmatch('[0-9a-f]{32}', body['token']))
    require(type(body['image_id']) is str and inventory.IMAGE.fullmatch(body['image_id']))
    require(type(body['archive_bytes']) is int and 0 < body['archive_bytes'] <= LIMIT)
    require(type(body['archive_sha256']) is str and inventory.HEX.fullmatch(body['archive_sha256']))
    require(body['marker_sha256'] == sha(MARKER))
    return body


def settings(config, token):
    require(type(config) is dict and config.get('User') == '65534:65534'
            and config.get('Entrypoint') == ['/probe'] and config.get('Cmd') in (None, [])
            and (config.get('Labels') or {}).get('kin.ci.fixture') == token)


def check_archive(path, body):
    require(path.stat().st_size == body['archive_bytes'] and path.stat().st_size <= LIMIT)
    require(sha(path.read_bytes()) == body['archive_sha256'])
    inventory.check_image(path, body['image_id'])
    with tarfile.open(path, 'r:') as archive:
        manifest = inventory.parse(archive.extractfile('manifest.json').read())
        require(manifest[0].get('RepoTags') == ['kin-ci-restore:'+body['token']])
        config = inventory.parse(archive.extractfile(manifest[0]['Config']).read())
        settings(config.get('config'), body['token'])


def inspect_image(identity):
    result = subprocess.run(['docker', 'image', 'inspect', identity], cwd=ROOT, capture_output=True, timeout=30)
    if result.returncode:
        require(result.returncode == 1 and 'no such image' in result.stderr.decode(errors='replace').lower())
        return None
    items = json.loads(result.stdout)
    require(type(items) is list and len(items) == 1 and items[0].get('Id') == identity)
    return items[0]


def remove_image(identity, token):
    image = inspect_image(identity)
    if image is not None:
        settings(image.get('Config'), token)
        command(['docker', 'image', 'rm', identity])


def write(path, raw):
    with path.open('xb') as output:
        output.write(raw)
    path.chmod(0o600)


def produce(destination):
    context = ci_context()
    token, identity = uuid.uuid4().hex, None
    tag = 'kin-ci-restore:'+token
    destination.mkdir(mode=0o700)
    try:
        with tempfile.TemporaryDirectory(prefix='kin-ci-image-build-') as folder:
            folder = Path(folder)
            write(folder/'probe.c', b'#include <stdio.h>\nint main(void){return puts("KIN-SYNTHETIC-IMAGE-RESTORE")<0;}\n')
            command(['gcc', '-static', '-O2', '-o', str(folder/'probe'), str(folder/'probe.c')])
            write(folder/'Dockerfile', ('FROM scratch\nCOPY probe /probe\nUSER 65534:65534\n'
                  'ENTRYPOINT ["/probe"]\nLABEL kin.ci.fixture="'+token+'"\n').encode())
            command(['docker', 'build', '--network=none', '--iidfile', str(folder/'iid'), '-t', tag, str(folder)], timeout=120)
            identity = (folder/'iid').read_text().strip()
            require(inventory.IMAGE.fullmatch(identity))
        # Saving by immutable ID can omit RepoTags; save the unique owned tag
        # while still checking the complete archive against the expected ID.
        command(['docker', 'image', 'save', '--output', str(destination/'image.tar'), tag])
        (destination/'image.tar').chmod(0o600)
        require(0 < (destination/'image.tar').stat().st_size <= LIMIT)
        body = dict(schema=1, code_sha=context['code_sha'], run_id=context['run_id'], run_attempt=context['run_attempt'],
                    producer_boot_id=context['boot_id'], token=token, image_id=identity,
                    archive_bytes=(destination/'image.tar').stat().st_size,
                    archive_sha256=sha((destination/'image.tar').read_bytes()), marker_sha256=sha(MARKER))
        check_archive(destination/'image.tar', body)
        raw = json.dumps(body, sort_keys=True).encode()
        write(destination/'receipt.json', raw)
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
            output.write('receipt_sha256='+sha(raw)+'\n')
        return dict(synthetic_archive_prepared=True, image_id=identity, archive_bytes=body['archive_bytes'])
    finally:
        if identity is not None:
            remove_image(identity, token)


def copy_download(source, target, limit):
    # Artifact downloads are public synthetic files (usually mode 644). Copy a
    # bounded regular FD into our private workspace before archive inspection.
    require(not source.is_symlink())
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as incoming:
        info = os.fstat(incoming.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.geteuid()
                and 0 < info.st_size <= limit)
        raw = incoming.read(limit+1)
        require(len(raw) == info.st_size)
    write(target, raw)


def consume(source, expected):
    context = ci_context()
    require(not source.is_symlink() and source.is_dir() and {p.name for p in source.iterdir()} == {'image.tar', 'receipt.json'})
    with tempfile.TemporaryDirectory(prefix='kin-ci-image-restore-') as folder:
        folder = Path(folder)
        copy_download(source/'receipt.json', folder/'receipt.json', 8192)
        body = parse_receipt((folder/'receipt.json').read_bytes(), expected, context)
        copy_download(source/'image.tar', folder/'image.tar', LIMIT)
        check_archive(folder/'image.tar', body)
        identity, token = body['image_id'], body['token']
        require(inspect_image(identity) is None)
        name = 'kin-rehearsal-'+token[:16]
        try:
            command(['docker', 'image', 'load', '--input', str(folder/'image.tar')])
            image = inspect_image(identity)
            require(image is not None)
            settings(image.get('Config'), token)
            command(['docker', 'create', '--name', name, '--label', 'kin.ops.run='+token,
                     '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                     '--pids-limit=32', '--memory=64m', '--cpus=1', identity])
            output = command(['docker', 'start', '--attach', name], timeout=10)
            require(output == MARKER and command(['docker', 'inspect', '--format', '{{.State.ExitCode}}', name]).strip() == b'0')
        finally:
            try:
                ops.remove_owned_if_present('container', name, token)
            finally:
                remove_image(identity, token)
    return dict(synthetic_image_restored=True, image_id=identity, producer_boot_id=body['producer_boot_id'],
                consumer_boot_id=context['boot_id'], originally_absent=True, marker_sha256=sha(output),
                full_restore_verified=False, offsite_backup_verified=False, deployment_authorized=False)


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
        print(json.dumps({'synthetic_image_restored': False, 'error_type': type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
