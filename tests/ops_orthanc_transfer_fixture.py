"""Hosted CI Orthanc image and frozen synthetic store transfer; no operational inputs."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import traceback
import uuid

import ops_database_transfer_fixture as database
import ops_orthanc_transfer_worker as worker

image_transfer = database.image_transfer
ops, inventory = database.ops, database.inventory
require, command = database.require, database.command
record, copy_download = database.record, database.copy_download
BASE = 'orthancteam/orthanc@sha256:31b5e84b5ce30e8c771337bdbb333999db90a9a53cf78f85b9a632ded0357b07'
# Classic Docker saves these pinned layers uncompressed (~1.75GB); containerd
# saves compressed blobs (~684MB). Both must fit a finite, measured profile.
LIMITS = {'image.tar': 2*1024**3, 'store.tar': worker.LIMIT}
FIELDS = {'schema', 'code_sha', 'run_id', 'run_attempt', 'producer_boot_id', 'token',
          'image_id', 'image_config_id', 'base_image', 'files', 'snapshot'}
CMD = ['-c', 'import time; time.sleep(3600)']


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
    worker.snapshot_contract(body['snapshot'])
    return body


def settings(config, token):
    require(type(config) is dict and config.get('User') == '65534:65534'
            and config.get('Entrypoint') == ['python3'] and config.get('Cmd') == CMD
            and (config.get('Labels') or {}).get('kin.ci.orthanc') == token
            and (config.get('Labels') or {}).get('kin.ci.base') == BASE)


def image_config(path, identity, token):
    inventory.check_image(path, identity)
    with tarfile.open(path, 'r:') as archive:
        manifest = inventory.parse(archive.extractfile('manifest.json').read())
        require(manifest[0].get('RepoTags') == ['kin-ci-orthanc:'+token])
        raw = archive.extractfile(manifest[0]['Config']).read()
        config = inventory.parse(raw)
        require(config.get('architecture') == 'amd64')
        settings(config.get('config'), token)
        return 'sha256:'+image_transfer.sha(raw), config['rootfs']['diff_ids']


def verify_files(folder, body):
    for name, limit in LIMITS.items():
        require(record(folder/name, limit) == body['files'][name])
    config_id, layers = image_config(folder/'image.tar', body['image_id'], body['token'])
    require(config_id == body['image_config_id'])
    worker.archive_files((folder/'store.tar').read_bytes(), body['snapshot'])
    return layers


def cached_layers(expected):
    # Docker exposes layers referenced by images, not every orphaned build-cache
    # blob. Report that observable subset without claiming an empty layer cache.
    identities = set(command(['docker', 'image', 'ls', '--quiet', '--no-trunc']).decode().split())
    require(len(identities) <= 512)
    found = set()
    for identity in sorted(identities):
        require(inventory.IMAGE.fullmatch(identity))
        item = image_transfer.inspect_image(identity)
        if item:
            found.update((item.get('RootFS') or {}).get('Layers', []))
    return sorted(set(expected) & found)


def remove_image(identity, token):
    found = image_transfer.inspect_image(identity)
    if found is not None:
        settings(found.get('Config'), token)
        command(['docker', 'image', 'rm', identity])


def start_container(identity, name, token):
    command(['docker', 'create', '--name', name, '--label', 'kin.ops.run='+token,
             '--user=65534:65534', '--network=none', '--read-only', '--cap-drop=ALL',
             '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=256m', '--cpus=1',
             '--tmpfs', '/work:rw,nosuid,nodev,uid=65534,gid=65534,mode=0700,size=128m',
             '--tmpfs', '/tmp:rw,nosuid,nodev,uid=65534,gid=65534,mode=0700,size=8m', identity])
    command(['docker', 'start', name])
    require(command(['docker', 'exec', name, 'id', '-u']).strip() == b'65534')


def build_image(token):
    with tempfile.TemporaryDirectory(prefix='kin-ci-orthanc-build-') as folder:
        folder = Path(folder)
        image_transfer.write(folder/'worker.py', Path(worker.__file__).read_bytes())
        # The private build input is 0600 on Linux. Explicit read-only image
        # permissions keep the synthetic worker readable by UID65534 on both
        # Linux and Windows build hosts without granting runtime root.
        image_transfer.write(folder/'Dockerfile', ('FROM '+BASE+'\nCOPY --chmod=0444 worker.py /fixture.py\n'
            'USER 65534:65534\nENTRYPOINT ["python3"]\nCMD '+json.dumps(CMD)+'\n'
            'LABEL kin.ci.orthanc="'+token+'" kin.ci.base="'+BASE+'"\n').encode())
        command(['docker', 'build', '--pull', '--platform=linux/amd64', '--network=none',
                 '--iidfile', str(folder/'iid'), '-t', 'kin-ci-orthanc:'+token, str(folder)], timeout=240)
        identity = (folder/'iid').read_text().strip()
        require(inventory.IMAGE.fullmatch(identity))
        return identity


def produce(destination):
    context = image_transfer.ci_context()
    token, identity = uuid.uuid4().hex, None
    name = 'kin-rehearsal-'+token[:16]
    destination.mkdir(mode=0o700)
    try:
        identity = build_image(token)
        command(['docker', 'image', 'save', '--output', str(destination/'image.tar'), 'kin-ci-orthanc:'+token], timeout=120)
        (destination/'image.tar').chmod(0o600)
        print(json.dumps({'observed_image_archive_bytes': (destination/'image.tar').stat().st_size}), flush=True)
        record(destination/'image.tar', LIMITS['image.tar'])
        config_id, _ = image_config(destination/'image.tar', identity, token)
        start_container(identity, name, token)
        snapshot = inventory.parse(command(['docker', 'exec', name, 'python3', '/fixture.py', 'produce'], timeout=90))
        worker.snapshot_contract(snapshot)
        with (destination/'store.tar').open('xb') as output:
            os.fchmod(output.fileno(), 0o600)
            subprocess.run(['docker', 'exec', name, 'cat', '/work/store.tar'], check=True,
                           stdout=output, stderr=subprocess.PIPE, timeout=30)
        body = dict(schema=1, code_sha=context['code_sha'], run_id=context['run_id'], run_attempt=context['run_attempt'],
                    producer_boot_id=context['boot_id'], token=token, image_id=identity, image_config_id=config_id,
                    base_image=BASE, files={file: record(destination/file, cap) for file, cap in LIMITS.items()}, snapshot=snapshot)
        verify_files(destination, body)
        raw = json.dumps(body, sort_keys=True).encode()
        require(len(raw) <= 8192)
        image_transfer.write(destination/'receipt.json', raw)
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
            output.write('receipt_sha256='+image_transfer.sha(raw)+'\n')
        return dict(synthetic_orthanc_archive_prepared=True, image_id=identity, files=body['files'], snapshot=snapshot)
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
    with tempfile.TemporaryDirectory(prefix='kin-ci-orthanc-restore-') as folder:
        folder = Path(folder)
        copy_download(source/'receipt.json', folder/'receipt.json', 8192)
        body = parse_receipt((folder/'receipt.json').read_bytes(), expected, context)
        for file, cap in LIMITS.items():
            copy_download(source/file, folder/file, cap)
        layers = verify_files(folder, body)
        identity, token = body['image_id'], body['token']
        require(image_transfer.inspect_image(identity) is None)
        cache = cached_layers(layers)
        name = 'kin-rehearsal-'+token[:16]
        try:
            command(['docker', 'image', 'load', '--input', str(folder/'image.tar')], timeout=120)
            loaded = image_transfer.inspect_image(identity)
            require(loaded is not None)
            settings(loaded.get('Config'), token)
            start_container(identity, name, token)
            with (folder/'store.tar').open('rb') as incoming:
                restored = inventory.parse(command(['docker', 'exec', '-i', name, 'python3', '/fixture.py',
                    'consume', json.dumps(body['snapshot'], sort_keys=True)], stdin=incoming, timeout=90))
            require(restored == dict(instance=body['snapshot']['instance'], attachments=body['snapshot']['attachments'],
                    rest_bytes_match=True, sqlite_integrity=True, uid=65534))
            verify_files(folder, body)
            require(all(record(source/file, cap) == body['files'][file] for file, cap in LIMITS.items()))
            require(image_transfer.sha((source/'receipt.json').read_bytes()) == expected)
        finally:
            try:
                ops.remove_owned_if_present('container', name, token)
            finally:
                remove_image(identity, token)
    return dict(synthetic_orthanc_restored=True, image_id=identity, image_config_id=body['image_config_id'],
                producer_boot_id=body['producer_boot_id'], consumer_boot_id=context['boot_id'],
                originally_absent=True, preexisting_image_referenced_layers=cache,
                base_label_is_producer_declaration=True, unreferenced_layer_cache_verified=False,
                source_unchanged=True, restored=restored, full_restore_verified=False,
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
        print(json.dumps({'synthetic_orthanc_restored': False, 'error_type': type(error).__name__}), file=sys.stderr)
        # Only fixed synthetic commands enter this fixture. Preserve the failing
        # validation location so a hosted-only format mismatch can be diagnosed.
        traceback.print_exc()
        if isinstance(error, subprocess.CalledProcessError):
            print((error.stderr or b'')[-4096:].decode(errors='replace'), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
