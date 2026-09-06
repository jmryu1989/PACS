"""Collect bounded S3 listings into private offline evidence; never move objects."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import parse_qsl, unquote_to_bytes, urlsplit

import ops_export_crypto as private
import ops_export_inventory as inventory
import ops_storage_reconcile as core

WORKER_TIMEOUT = 120
REQUEST_LIMIT = 20000
LOCK = Path(__file__).with_name('requirements-storage-sdk.txt')
VERSIONS = {'boto3': '1.43.89', 'botocore': '1.43.89', 'jmespath': '1.1.0',
            'python-dateutil': '2.9.0.post0', 's3transfer': '0.19.2', 'six': '1.17.0', 'urllib3': '2.7.0'}
AUTHORITY = dict(content_verified=False, provider_verified=False, snapshot_consistency_verified=False,
                 restore_verified=False, migration_authorized=False)
CONFIG_FIELDS = {'schema', 'endpoint', 'region', 'bucket', 'prefix', 'expected_owner',
                 'credentials_file', 'storage_profile'}


def require(value):
    if not value:
        raise ValueError('Storage collection refused')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def parse(raw):
    return json.loads(raw, object_pairs_hook=inventory.unique,
                      parse_constant=lambda value: require(False))


def config_body(raw):
    body = parse(raw)
    require(type(body) is dict and set(body) in (CONFIG_FIELDS, CONFIG_FIELDS | {'ca_file', 'ca_sha256'}))
    require(type(body['schema']) is int and body['schema'] == 1)
    require(type(body['endpoint']) is str and len(body['endpoint']) <= 2048
            and all(32 < ord(c) < 127 for c in body['endpoint']))
    endpoint = urlsplit(body['endpoint'])
    require(endpoint.scheme == 'https' and endpoint.hostname and endpoint.username is None
            and endpoint.password is None and endpoint.path in ('', '/')
            and not endpoint.query and not endpoint.fragment and '\\' not in body['endpoint'])
    require(endpoint.port is None or 1 <= endpoint.port <= 65535)
    require(type(body['region']) is str and re.fullmatch('[a-z0-9][a-z0-9-]{0,62}', body['region']))
    core.scope(body['bucket'], body['prefix'])
    require(type(body['expected_owner']) is str and re.fullmatch('[0-9]{12}', body['expected_owner']))
    require(body['storage_profile'] == core.PROFILE and body['storage_profile']['client_encryption'] is False)
    for field in ('credentials_file', 'ca_file'):
        if field in body:
            require(type(body[field]) is str and Path(body[field]).is_absolute())
    if 'ca_sha256' in body:
        require(type(body['ca_sha256']) is str and inventory.HEX.fullmatch(body['ca_sha256']))
    return body


def credentials(raw):
    body = parse(raw)
    required = {'access_key_id', 'secret_access_key'}
    require(type(body) is dict and set(body) in (required, required | {'session_token'}))
    require(all(type(v) is str and 0 < len(v) <= 8192 and all(32 < ord(c) < 127 for c in v)
                for v in body.values()))
    return body


def bound_small(path, expected=None):
    path = private.path_guard(path)
    private.private_dir(path.parent)
    raw = private.read_small(path)
    if expected is not None:
        require(type(expected) is str and inventory.HEX.fullmatch(expected) and digest(raw) == expected)
    return raw


def decode(value):
    # Explicit EncodingType=url disables botocore's automatic decoding. Tokens
    # are opaque; only Prefix and Key pass through this exact-once conversion.
    require(type(value) is str and value.isascii() and not re.search(r'%(?![0-9A-Fa-f]{2})', value))
    return unquote_to_bytes(value).decode('utf-8', errors='strict')


def normalize(response, requested):
    require(type(response) is dict and set(response) <= core.PAGE_FIELDS | {'EncodingType', 'ResponseMetadata'})
    metadata = response.get('ResponseMetadata')
    require(type(metadata) is dict and type(metadata.get('HTTPStatusCode')) is int
            and metadata['HTTPStatusCode'] == 200 and response.get('EncodingType') == 'url')
    page = {k: v for k, v in response.items() if k in core.PAGE_FIELDS}
    page['Prefix'] = decode(page.get('Prefix'))
    entries = page.get('Contents', [])
    require(type(entries) is list and len(entries) <= 1000)
    projected = []
    for entry in entries:
        require(type(entry) is dict and {'Key', 'Size'} <= set(entry) <= core.OBJECT_FIELDS)
        projected.append({'Key': decode(entry['Key']), 'Size': entry['Size']})
    page['Contents'] = projected
    return {'request_token': requested, 'response': page}


class RequestGuard:
    def __init__(self, config):
        self.config, self.token, self.attempts = config, None, 0

    def __call__(self, request, **kwargs):
        self.attempts += 1
        require(self.attempts <= REQUEST_LIMIT and kwargs.get('event_name') == 'before-send.s3.ListObjectsV2'
                and request.method == 'GET' and request.body in (None, b'', ''))
        actual, endpoint = urlsplit(request.url), urlsplit(self.config['endpoint'])
        require(actual.scheme == endpoint.scheme and actual.netloc == endpoint.netloc
                and actual.path == '/' + self.config['bucket'] and not actual.fragment)
        query = parse_qsl(actual.query, keep_blank_values=True, strict_parsing=True, errors='strict')
        expected = {'list-type': '2', 'prefix': self.config['prefix'], 'max-keys': '1000', 'encoding-type': 'url'}
        if self.token is not None:
            expected['continuation-token'] = self.token
        require(len(query) == len(expected) and dict(query) == expected)
        headers = {k.lower(): v.decode('ascii') if isinstance(v, bytes) else v for k, v in request.headers.items()}
        require(headers.get('x-amz-expected-bucket-owner') == self.config['expected_owner'])


def sdk_client(config, secret, ca):
    actual = {name: importlib.metadata.version(name) for name in VERSIONS}
    require(actual == VERSIONS)
    import boto3
    from botocore.config import Config
    client = boto3.session.Session().client(
        's3', endpoint_url=config['endpoint'], region_name=config['region'], verify=ca,
        aws_access_key_id=secret['access_key_id'], aws_secret_access_key=secret['secret_access_key'],
        aws_session_token=secret.get('session_token'),
        config=Config(signature_version='s3v4', connect_timeout=3, read_timeout=5,
                      retries={'total_max_attempts': 2, 'mode': 'standard'}, proxies={},
                      s3={'addressing_style': 'path'}))
    guard = RequestGuard(config)
    client.meta.events.register('before-send.s3.*', guard)
    return client, guard


def collect_pages(client, guard, config):
    state = core.ListingState(config['bucket'], config['prefix'])
    body = dict(schema=1, bucket=config['bucket'], prefix=config['prefix'], profile=core.PROFILE, pages=[])
    size = len(private.encode(body))
    while not state.done:
        require(state.pages < core.PAGE_LIMIT)
        guard.token = state.next_token
        args = dict(Bucket=config['bucket'], Prefix=config['prefix'], MaxKeys=1000,
                    ExpectedBucketOwner=config['expected_owner'], EncodingType='url')
        if guard.token is not None:
            args['ContinuationToken'] = guard.token
        response = client.list_objects_v2(**args)
        page = normalize(response, guard.token)
        state.add(page)
        size += len(private.encode(page))
        require(size <= core.LIST_LIMIT)
        body['pages'].append(page)
    state.finish()
    raw = private.encode(body)
    core.listing(raw, digest(raw), config['bucket'], config['prefix'])
    return raw, len(state.objects), state.pages


def write_json(path, value):
    with private.create_file(path) as out:
        out.write(private.encode(value)); private.sync(out)


def utc():
    return datetime.now(timezone.utc).isoformat()


def worker(pending):
    private.linux_only()
    require(sys.version_info >= (3, 10) and sys.prefix != sys.base_prefix)
    private.private_dir(Path(sys.prefix))
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024**2, 512 * 1024**2))
    resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
    private.private_dir(pending)
    request = parse(bound_small(pending/'request.json'))
    require(type(request) is dict and set(request) == {'config_sha256', 'credentials_sha256', 'sdk_lock_sha256'})
    require(digest(LOCK.read_bytes()) == request['sdk_lock_sha256'])
    config = config_body(bound_small(pending/'config.json', request['config_sha256']))
    secret = credentials(bound_small(config['credentials_file'], request['credentials_sha256']))
    ca = True
    if 'ca_file' in config:
        bound_small(pending/'ca.pem', config['ca_sha256'])
        ca = str(pending/'ca.pem')
    started = utc()
    client, guard = sdk_client(config, secret, ca)
    try:
        raw, objects, pages = collect_pages(client, guard, config)
    finally:
        client.close()
    receipt = dict(schema=1, config_sha256=request['config_sha256'], sdk_lock_sha256=request['sdk_lock_sha256'],
                   sdk_versions=VERSIONS, scope={k: config[k] for k in
                       ('endpoint', 'region', 'bucket', 'prefix', 'expected_owner')},
                   started_at=started, ended_at=utc(), request_attempts=guard.attempts,
                   listing_sha256=digest(raw), listed_objects=objects, pages=pages,
                   collection_complete=True, **AUTHORITY)
    with private.create_file(pending/'listing.json') as out:
        out.write(raw); private.sync(out)
    write_json(pending/'receipt.json', receipt)


def run_worker(pending):
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'HOME': str(pending), 'TMPDIR': str(pending),
           'PYTHONNOUSERSITE': '1', 'AWS_EC2_METADATA_DISABLED': 'true',
           'AWS_CONFIG_FILE': '/dev/null', 'AWS_SHARED_CREDENTIALS_FILE': '/dev/null'}
    # Reap the child before the context can remove its files, including Ctrl-C.
    with subprocess.Popen([sys.executable, '-B', str(Path(__file__).absolute()), '_worker', str(pending)],
                          env=env, cwd=pending, stdin=subprocess.DEVNULL,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as process:
        try:
            require(process.wait(timeout=WORKER_TIMEOUT) == 0)
        except BaseException:
            process.kill()
            process.wait()
            raise


def collect(config_path, config_hash, destination):
    private.linux_only()
    require(sys.version_info >= (3, 10) and sys.prefix != sys.base_prefix)
    private.private_dir(Path(sys.prefix))
    raw = bound_small(config_path, config_hash)
    config = config_body(raw)
    secret_raw = bound_small(config['credentials_file'])
    credentials(secret_raw)
    request = dict(config_sha256=config_hash, credentials_sha256=digest(secret_raw), sdk_lock_sha256=digest(LOCK.read_bytes()))
    del secret_raw
    with private.workspace(destination, Path(config_path).absolute()) as pending:
        with private.create_file(pending/'config.json') as out:
            out.write(raw); private.sync(out)
        write_json(pending/'request.json', request)
        if 'ca_file' in config:
            ca = bound_small(config['ca_file'], config['ca_sha256'])
            with private.create_file(pending/'ca.pem') as out:
                out.write(ca); private.sync(out)
        run_worker(pending)
        receipt = parse(bound_small(pending/'receipt.json'))
        require(type(receipt) is dict and set(receipt) == {'schema', 'config_sha256', 'sdk_lock_sha256', 'sdk_versions',
                'scope', 'started_at', 'ended_at', 'request_attempts', 'listing_sha256', 'listed_objects', 'pages',
                'collection_complete'} | set(AUTHORITY))
        require(type(receipt['schema']) is int and receipt['schema'] == 1
                and receipt['collection_complete'] is True and all(receipt[k] is False for k in AUTHORITY))
        require(receipt['config_sha256'] == config_hash and receipt['sdk_lock_sha256'] == request['sdk_lock_sha256']
                and receipt['sdk_versions'] == VERSIONS and receipt['scope'] == {k: config[k] for k in
                    ('endpoint', 'region', 'bucket', 'prefix', 'expected_owner')})
        for field in ('started_at', 'ended_at'):
            require(type(receipt[field]) is str and datetime.fromisoformat(receipt[field]).utcoffset().total_seconds() == 0)
        require(receipt['ended_at'] >= receipt['started_at'])
        core.input_size(pending/'listing.json', core.LIST_LIMIT)
        with private.read_private(pending/'listing.json') as stream:
            listing_raw = stream.read(core.LIST_LIMIT+1)
        objects, pages = core.listing(listing_raw, receipt['listing_sha256'], config['bucket'], config['prefix'])
        require(core.integer(receipt['request_attempts'], pages, REQUEST_LIMIT)
                and core.integer(receipt['pages'], 1, core.PAGE_LIMIT) and receipt['pages'] == pages
                and core.integer(receipt['listed_objects'], 0, core.ITEM_LIMIT) and receipt['listed_objects'] == len(objects))
        for name in ('config.json', 'request.json', 'ca.pem'):
            path = pending/name
            if path.exists():
                path.unlink()
        require({p.name for p in pending.iterdir()} == {'listing.json', 'receipt.json'})
        private.sync_directory(pending)
        private.publish(pending, Path(destination).absolute())
    return dict(collection_complete=True, listing_sha256=receipt['listing_sha256'],
                listed_objects=len(objects), pages=pages, request_attempts=receipt['request_attempts'], **AUTHORITY)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '_worker':
        try:
            worker(Path(sys.argv[2])); return 0
        except (Exception, KeyboardInterrupt):
            return 1  # SDK errors can contain endpoint keys and credentials.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['collect'])
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--config-sha256', required=True)
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(collect(args.config, args.config_sha256, args.destination)))
        return 0
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({'collection_complete': False, 'error_type': type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
