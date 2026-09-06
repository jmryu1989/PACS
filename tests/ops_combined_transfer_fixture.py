"""Restore one synthetic DB/Orthanc snapshot across hosted CI jobs only."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import traceback
import uuid

import ops_database_transfer_fixture as pg
import ops_orthanc_transfer_fixture as orth

image_transfer, inventory, ops = orth.image_transfer, orth.inventory, orth.ops
require, command, record = orth.require, orth.command, orth.record
COMPONENTS = {'postgres': pg, 'orthanc': orth}
LIMITS = {'postgres-image.tar': 512*1024**2, 'orthanc-image.tar': 2*1024**3,
          'kin.dump': 16*1024**2, 'keycloak.dump': 16*1024**2, 'store.tar': 32*1024**2}
RECEIPT_LIMIT = 16*1024
DISK_RESERVE = 9*1024**3
FIELDS = {'schema', 'code_sha', 'run_id', 'run_attempt', 'producer_boot_id', 'token',
          'images', 'files', 'snapshot', 'relation'}
SELECT = 'SELECT file_type,instance,sha256 FROM fixture_attachment ORDER BY file_type'


def disk_preflight():
    # The artifact directory and Python's private copies can live on different
    # filesystems; checking only /tmp would miss a full RUNNER_TEMP mount.
    paths = {'artifact': os.environ['RUNNER_TEMP'], 'private_copy': tempfile.gettempdir()}
    free = {key: shutil.disk_usage(path).free for key, path in paths.items()}
    print(json.dumps({'temporary_disk_free_bytes': free, 'minimum_free_bytes': DISK_RESERVE}), flush=True)
    require(all(value >= DISK_RESERVE for value in free.values()))


def expected_rows(snapshot):
    orth.worker.snapshot_contract(snapshot)
    return ''.join(str(entry['file_type'])+'|'+snapshot['instance']+'|'+
        snapshot['files'][orth.worker.store_path(entry['uuid'])]['sha256']+'\n'
        for entry in sorted(snapshot['attachments'], key=lambda entry: entry['file_type'])).encode()


def relation(snapshot):
    return dict(rows_per_database=3, rows_sha256=image_transfer.sha(expected_rows(snapshot)))


def parse_receipt(raw, expected, expected_relation, context):
    require(type(expected) is str and inventory.HEX.fullmatch(expected)
            and len(raw) <= RECEIPT_LIMIT and image_transfer.sha(raw) == expected)
    body = inventory.parse(raw)
    require(type(body) is dict and set(body) == FIELDS and type(body['schema']) is int and body['schema'] == 1)
    require(all(body[key] == context[key] for key in ('code_sha', 'run_id', 'run_attempt')))
    require(type(body['producer_boot_id']) is str and image_transfer.UUID.fullmatch(body['producer_boot_id'])
            and body['producer_boot_id'] != context['boot_id'])
    require(type(body['token']) is str and re.fullmatch('[0-9a-f]{32}', body['token']))
    require(type(body['images']) is dict and set(body['images']) == set(COMPONENTS))
    for component, module in COMPONENTS.items():
        item = body['images'][component]
        require(type(item) is dict and set(item) == {'image_id', 'config_id', 'base'})
        require(item['base'] == module.BASE and all(type(item[key]) is str and inventory.IMAGE.fullmatch(item[key])
                for key in ('image_id', 'config_id')))
    require(body['images']['postgres']['image_id'] != body['images']['orthanc']['image_id'])
    require(type(body['files']) is dict and set(body['files']) == set(LIMITS))
    for name, entry in body['files'].items():
        require(type(entry) is dict and set(entry) == {'bytes', 'sha256'}
                and type(entry['bytes']) is int and 0 < entry['bytes'] <= LIMITS[name]
                and type(entry['sha256']) is str and inventory.HEX.fullmatch(entry['sha256']))
    require(type(expected_relation) is str and inventory.HEX.fullmatch(expected_relation))
    require(type(body['relation']) is dict and body['relation'] == relation(body['snapshot'])
            and type(body['relation']['rows_per_database']) is int
            and body['relation']['rows_sha256'] == expected_relation)
    return body


def verify_files(folder, body):
    for name, limit in LIMITS.items():
        require(record(folder/name, limit) == body['files'][name])
    token, images = body['token'], body['images']
    require(pg.image_config(folder/'postgres-image.tar', images['postgres']['image_id'], token) == images['postgres']['config_id'])
    config, orth_layers = orth.image_config(folder/'orthanc-image.tar', images['orthanc']['image_id'], token)
    require(config == images['orthanc']['config_id'])
    with tarfile.open(folder/'postgres-image.tar', 'r:') as archive:
        manifest = inventory.parse(archive.extractfile('manifest.json').read())
        pg_layers = inventory.parse(archive.extractfile(manifest[0]['Config']).read())['rootfs']['diff_ids']
    for db in pg.DATABASES:
        with (folder/(db+'.dump')).open('rb') as incoming:
            require(incoming.read(5) == b'PGDMP')
    orth.worker.archive_files((folder/'store.tar').read_bytes(), body['snapshot'])
    return pg_layers+orth_layers


def names(token):
    require(type(token) is str and re.fullmatch('[0-9a-f]{32}', token))
    return {key: 'kin-rehearsal-'+token[:16]+suffix for key, suffix in
            (('postgres', '-pg'), ('orthanc', '-orthanc'))}


def tags(token):
    names(token)
    return dict(postgres='kin-ci-database:'+token, orthanc='kin-ci-orthanc:'+token)


def owned_tag_identity(tag, module, token):
    result = subprocess.run(['docker', 'image', 'inspect', tag], capture_output=True, timeout=30)
    if result.returncode:
        require(result.returncode == 1 and 'no such image' in result.stderr.decode(errors='replace').lower())
        return None
    found = inventory.parse(result.stdout)
    require(type(found) is list and len(found) == 1 and type(found[0].get('Id')) is str
            and inventory.IMAGE.fullmatch(found[0]['Id']) and tag in (found[0].get('RepoTags') or []))
    module.settings(found[0].get('Config'), token)
    return found[0]['Id']


def cleanup(token, identities, resolve_tags=False):
    # One failed ownership check must not stop cleanup of other known resources.
    # Never remove bases/cache, and never guess an image ID after a build timeout.
    failures = []
    for name in names(token).values():
        try:
            ops.remove_owned_if_present('container', name, token)
        except Exception as error:
            failures.append(error)
    for key, module in COMPONENTS.items():
        try:
            identity = identities.get(key)
            if identity is None and resolve_tags:
                identity = owned_tag_identity(tags(token)[key], module, token)
            if identity is not None:
                module.remove_image(identity, token)
        except Exception as error:
            failures.append(error)
    if failures:
        raise RuntimeError('Combined fixture owned cleanup failed') from failures[0]


def build_postgres(token):
    with tempfile.TemporaryDirectory(prefix='kin-ci-combined-pg-') as folder:
        folder = Path(folder)
        image_transfer.write(folder/'Dockerfile', ('FROM '+pg.BASE+'\nUSER 70:70\n'
            'LABEL kin.ci.database="'+token+'" kin.ci.base="'+pg.BASE+'"\n').encode())
        command(['docker', 'build', '--pull', '--platform=linux/amd64', '--network=none',
                 '--iidfile', str(folder/'iid'), '-t', tags(token)['postgres'], str(folder)], timeout=180)
        identity = (folder/'iid').read_text().strip()
        require(inventory.IMAGE.fullmatch(identity))
        return identity


def create_databases(name, snapshot):
    rows = expected_rows(snapshot).decode().splitlines()
    # All values were constrained to fixed numeric kinds and hexadecimal IDs.
    # This synthetic SQL path never accepts patient data or arbitrary identifiers.
    values = ','.join('('+row.split('|')[0]+",'"+row.split('|')[1]+"','"+row.split('|')[2]+"')" for row in rows)
    sql = 'CREATE TABLE fixture_attachment(file_type integer PRIMARY KEY, instance text NOT NULL, sha256 text NOT NULL); INSERT INTO fixture_attachment VALUES'+values+';'
    for db in pg.DATABASES:
        command(['docker', 'exec', name, 'createdb', '-U', 'postgres', db])
        command(['docker', 'exec', name, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', sql])


def verify_rows(name, snapshot):
    expected, result = expected_rows(snapshot), {}
    for db in pg.DATABASES:
        actual = command(['docker', 'exec', name, 'psql', '-U', 'postgres', '-d', db,
                          '-v', 'ON_ERROR_STOP=1', '-At', '-c', SELECT])
        require(actual == expected)
        result[db] = dict(count=len(actual.splitlines()), sha256=image_transfer.sha(actual))
    return result


def produce(destination):
    context = image_transfer.ci_context()
    disk_preflight()
    token, identities = uuid.uuid4().hex, {}
    resources = names(token)
    destination.mkdir(mode=0o700)
    try:
        identities['orthanc'] = orth.build_image(token)
        identities['postgres'] = build_postgres(token)
        images = {}
        for key, module in COMPONENTS.items():
            path = destination/(key+'-image.tar')
            orth.bounded_output(['docker', 'image', 'save', tags(token)[key]], path, LIMITS[path.name], timeout=180)
            config = module.image_config(path, identities[key], token)
            images[key] = dict(image_id=identities[key], config_id=config[0] if key == 'orthanc' else config, base=module.BASE)
        orth.start_container(identities['orthanc'], resources['orthanc'], token)
        snapshot = inventory.parse(command(['docker', 'exec', resources['orthanc'], 'python3', '/fixture.py', 'produce'], timeout=90))
        orth.worker.snapshot_contract(snapshot)
        orth.bounded_output(['docker', 'exec', resources['orthanc'], 'cat', '/work/store.tar'], destination/'store.tar', LIMITS['store.tar'], timeout=30)
        pg.start_database(identities['postgres'], resources['postgres'], token)
        create_databases(resources['postgres'], snapshot)
        rows = verify_rows(resources['postgres'], snapshot)
        for db in pg.DATABASES:
            orth.bounded_output(['docker', 'exec', resources['postgres'], 'pg_dump', '-U', 'postgres', '-Fc', db],
                                destination/(db+'.dump'), LIMITS[db+'.dump'], timeout=60)
        body = dict(schema=1, code_sha=context['code_sha'], run_id=context['run_id'], run_attempt=context['run_attempt'],
                    producer_boot_id=context['boot_id'], token=token, images=images, snapshot=snapshot, relation=relation(snapshot),
                    files={name: record(destination/name, limit) for name, limit in LIMITS.items()})
        verify_files(destination, body)
        require(verify_rows(resources['postgres'], snapshot) == rows)
        raw = json.dumps(body, sort_keys=True).encode()
        require(len(raw) <= RECEIPT_LIMIT)
        image_transfer.write(destination/'receipt.json', raw)
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
            output.write('receipt_sha256='+image_transfer.sha(raw)+'\nrelation_sha256='+body['relation']['rows_sha256']+'\n')
        return dict(synthetic_combined_archive_prepared=True, images=images, files=body['files'], snapshot=snapshot, rows=rows)
    finally:
        cleanup(token, identities, resolve_tags=True)


def consume(source, expected, expected_relation):
    context = image_transfer.ci_context()
    disk_preflight()
    require(not source.is_symlink() and source.is_dir() and {path.name for path in source.iterdir()} == set(LIMITS) | {'receipt.json'})
    with tempfile.TemporaryDirectory(prefix='kin-ci-combined-restore-') as folder:
        folder = Path(folder)
        orth.copy_download(source/'receipt.json', folder/'receipt.json', RECEIPT_LIMIT)
        body = parse_receipt((folder/'receipt.json').read_bytes(), expected, expected_relation, context)
        for name, limit in LIMITS.items():
            orth.copy_download(source/name, folder/name, limit)
        layers = verify_files(folder, body)
        identities = {key: body['images'][key]['image_id'] for key in COMPONENTS}
        # Both checks precede the try/finally that owns loaded images. An existing
        # image must never be loaded over or included in our cleanup set.
        absent = [image_transfer.inspect_image(identity) is None for identity in identities.values()]
        require(all(absent))
        cache = orth.cached_layers(layers)
        token, resources = body['token'], names(body['token'])
        try:
            for key, module in COMPONENTS.items():
                command(['docker', 'image', 'load', '--input', str(folder/(key+'-image.tar'))], timeout=120)
                loaded = image_transfer.inspect_image(identities[key])
                require(loaded is not None)
                module.settings(loaded.get('Config'), token)
            pg.start_database(identities['postgres'], resources['postgres'], token)
            for db in pg.DATABASES:
                command(['docker', 'exec', resources['postgres'], 'createdb', '-U', 'postgres', db])
                with (folder/(db+'.dump')).open('rb') as incoming:
                    command(['docker', 'exec', '-i', resources['postgres'], 'pg_restore', '-U', 'postgres', '-d', db,
                             '--no-owner', '--no-privileges', '--exit-on-error'], stdin=incoming)
            rows = verify_rows(resources['postgres'], body['snapshot'])
            orth.start_container(identities['orthanc'], resources['orthanc'], token)
            with (folder/'store.tar').open('rb') as incoming:
                restored = inventory.parse(command(['docker', 'exec', '-i', resources['orthanc'], 'python3', '/fixture.py',
                    'consume', json.dumps(body['snapshot'], sort_keys=True)], stdin=incoming, timeout=90))
            require(restored == dict(instance=body['snapshot']['instance'], attachments=body['snapshot']['attachments'],
                    rest_bytes_match=True, sqlite_integrity=True, uid=65534))
            verify_files(folder, body)
            require(all(record(source/name, limit) == body['files'][name] for name, limit in LIMITS.items()))
            require(record(source/'receipt.json', RECEIPT_LIMIT)['sha256'] == expected)
        finally:
            cleanup(token, identities)
    return dict(synthetic_combined_restored=True, images=body['images'], postgres_rows=rows, orthanc=restored,
                relation_sha256=body['relation']['rows_sha256'], producer_boot_id=body['producer_boot_id'],
                consumer_boot_id=context['boot_id'], both_images_originally_absent=True, source_unchanged=True,
                preexisting_image_referenced_layers=cache, unreferenced_layer_cache_verified=False,
                base_labels_are_producer_declarations=True, full_restore_verified=False,
                offsite_backup_verified=False, deployment_authorized=False,
                unverified=['product_schema', 'api_keycloak_authentication', 'reporting_viewer',
                            'tls', 'cron', 'encryption_keys', 'external_destination'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['produce', 'consume'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('--receipt-sha256')
    parser.add_argument('--relation-sha256')
    args = parser.parse_args()
    try:
        result = produce(args.directory) if args.mode == 'produce' else consume(args.directory, args.receipt_sha256, args.relation_sha256)
        print(json.dumps(result))
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as output:
            output.write('```json\n'+json.dumps(result, indent=2)+'\n```\n')
        return 0
    except Exception as error:
        print(json.dumps({'synthetic_combined_restored': False, 'error_type': type(error).__name__}), file=sys.stderr)
        traceback.print_exc()
        if isinstance(error, subprocess.CalledProcessError):
            print((error.stderr or b'')[-4096:].decode(errors='replace'), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
