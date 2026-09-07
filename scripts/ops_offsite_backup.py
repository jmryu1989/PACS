"""Default-off transfer of a sealed export; never create buckets or restore a DB."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import parse_qsl, unquote, urlsplit
import uuid

import ops_export_crypto as private
import ops_export_inventory as inventory
import ops_storage_collect as storage

ENDPOINT = 'https://objectstorage.kr-central-2.kakaocloud.com'
REGION = 'kr-central-2'
FIELDS = {'schema', 'enabled', 'endpoint', 'region', 'bucket', 'prefix', 'credentials_file'}
DISABLED = dict(enabled=False, skipped=True, reason='external_backup_disabled',
                transfer_verified=False, restore_verified=False, deployment_authorized=False)
TIME_LIMIT = 900
CHUNK = 1024 * 1024


def require(value):
    if not value:
        raise ValueError('External backup refused')


def configuration(raw):
    body = inventory.parse(raw)
    require(type(body) is dict and {'schema', 'enabled'} <= set(body) <= FIELDS)
    require(type(body['schema']) is int and body['schema'] == 1 and type(body['enabled']) is bool)
    if not body['enabled']:
        return body
    require(set(body) == FIELDS and body['endpoint'] == ENDPOINT and body['region'] == REGION)
    require(type(body['bucket']) is str and re.fullmatch('[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', body['bucket']))
    require(type(body['prefix']) is str and re.fullmatch('[a-z0-9][a-z0-9/_-]{0,127}/', body['prefix']))
    require('//' not in body['prefix'])
    require(type(body['credentials_file']) is str and Path(body['credentials_file']).is_absolute())
    return body


class RequestGuard:
    """Do not let SDK redirects, environment configuration or retries widen scope."""
    def __init__(self, config, keys):
        self.config, self.keys = config, set(keys)
        self.started, self.requests = time.monotonic(), 0

    def check_time(self):
        require(time.monotonic() - self.started < TIME_LIMIT)

    def __call__(self, request, **kwargs):
        self.check_time()
        self.requests += 1
        require(self.requests <= 40000)
        parsed = urlsplit(request.url)
        require(parsed.scheme == 'https' and parsed.netloc == urlsplit(ENDPOINT).netloc
                and parsed.username is None and parsed.password is None and not parsed.fragment)
        require(unquote(parsed.path) in {'/' + self.config['bucket'] + '/' + key for key in self.keys})
        query = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=False)
        require(len(query) == len(dict(query)))
        params = dict(query)
        name = kwargs.get('event_name', '').removeprefix('before-send.s3.')
        allowed = {'PutObject': ('PUT', set()), 'GetObject': ('GET', set()),
                   'CreateMultipartUpload': ('POST', {'uploads'}),
                   'UploadPart': ('PUT', {'uploadId', 'partNumber'}),
                   'CompleteMultipartUpload': ('POST', {'uploadId'}),
                   'AbortMultipartUpload': ('DELETE', {'uploadId'})}
        require(name in allowed and (request.method, set(params)) == allowed[name])
        if 'uploadId' in params:
            require(bool(params['uploadId']))
        if 'partNumber' in params:
            require(params['partNumber'].isdigit() and 1 <= int(params['partNumber']) <= 10000)
        if name == 'CreateMultipartUpload':
            require(params['uploads'] == '')
        if name == 'GetObject':
            require(request.body in (None, b'', ''))


def sdk_client(config, secret, keys):
    require({name: importlib.metadata.version(name) for name in storage.VERSIONS} == storage.VERSIONS)
    import boto3
    from botocore.config import Config
    client = boto3.session.Session().client(
        's3', endpoint_url=ENDPOINT, region_name=REGION, verify=True,
        aws_access_key_id=secret['access_key_id'], aws_secret_access_key=secret['secret_access_key'],
        aws_session_token=secret.get('session_token'),
        config=Config(signature_version='s3v4', connect_timeout=3, read_timeout=15, proxies={},
                      retries={'total_max_attempts': 2, 'mode': 'standard'},
                      request_checksum_calculation='when_required', response_checksum_validation='when_required',
                      s3={'addressing_style': 'path'}))
    guard = RequestGuard(config, keys)
    client.meta.events.register('before-send.s3.*', guard)
    return client, guard


def upload(client, bucket, key, stream):
    from boto3.s3.transfer import TransferConfig
    # One sequential multipart upload bounds memory and avoids concurrent retries.
    client.upload_fileobj(stream, bucket, key, ExtraArgs={'ContentType': 'application/octet-stream'},
                          Config=TransferConfig(multipart_threshold=64 * 1024**2,
                                                multipart_chunksize=64 * 1024**2,
                                                use_threads=False))


def readback(client, guard, bucket, key, expected):
    guard.check_time()
    response = client.get_object(Bucket=bucket, Key=key)
    body = response.get('Body')
    require(body is not None)
    try:
        require(response.get('ResponseMetadata', {}).get('HTTPStatusCode') == 200)
        require(type(response.get('ContentLength')) is int and response['ContentLength'] == expected['bytes'])
        digest, size = hashlib.sha256(), 0
        while size <= expected['bytes']:
            guard.check_time()
            chunk = body.read(min(CHUNK, expected['bytes'] - size + 1))
            if not chunk:
                break
            require(type(chunk) is bytes)
            size += len(chunk)
            require(size <= expected['bytes'])
            digest.update(chunk)
        require(size == expected['bytes'] and digest.hexdigest() == expected['sha256'])
    finally:
        body.close()


def run(config_path, source=None, receipt_sha256=None, destination=None, *, factory=None, uploader=None):
    # OFF is a cost boundary: do not even resolve a source, output or secret path.
    with Path(config_path).open('rb') as stream:
        raw = stream.read(inventory.META_LIMIT + 1)
    config = configuration(raw)
    if not config['enabled']:
        return dict(DISABLED)
    private.linux_only()
    require(private.read_small(config_path) == raw)
    private.private_dir(Path(config_path).absolute().parent)
    require(source is not None and destination is not None)
    source = private.private_dir(source)
    require({p.name for p in source.iterdir()} == {'payload.age', 'receipt.json'})
    receipt_raw = private.read_small(source / 'receipt.json')
    receipt = private.parse_receipt(receipt_raw, receipt_sha256)
    require(private.hash_file(source / 'payload.age') == receipt['ciphertext'])
    with private.read_private(source / 'payload.age') as stream:
        require(stream.read(22) == b'age-encryption.org/v1\n')
    secret = storage.credentials(storage.bound_small(Path(config['credentials_file'])))
    run_id = uuid.uuid4().hex
    prefix = config['prefix'] + receipt_sha256 + '/' + run_id + '/'
    keys = [prefix + 'payload.age', prefix + 'receipt.json']
    records = [receipt['ciphertext'], {'bytes': len(receipt_raw), 'sha256': receipt_sha256}]
    # The private snapshot decouples SDK file seeks from the caller's source files.
    with private.workspace(destination, source) as pending:
        private.copy_bound(source / 'payload.age', pending / 'payload.age', receipt['ciphertext'])
        with private.create_file(pending / 'receipt.json') as out:
            out.write(receipt_raw)
            private.sync(out)
        client, guard = (factory or sdk_client)(config, secret, keys)
        try:
            for name, key, record in zip(('payload.age', 'receipt.json'), keys, records):
                guard.check_time()
                with private.read_private(pending / name) as stream:
                    (uploader or upload)(client, config['bucket'], key, stream)
                readback(client, guard, config['bucket'], key, record)
            result = dict(enabled=True, skipped=False, transfer_verified=True, restore_verified=False,
                          deployment_authorized=False, receipt_sha256=receipt_sha256,
                          endpoint=ENDPOINT, region=REGION, bucket=config['bucket'], keys=keys,
                          ciphertext=receipt['ciphertext'], run_id=run_id)
            with private.create_file(pending / 'result.json') as out:
                out.write(private.encode(result))
                private.sync(out)
            private.publish(pending, Path(destination).absolute())
        finally:
            client.close()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path(__file__).with_name('backup-offsite.example.json'))
    parser.add_argument('--source', type=Path)
    parser.add_argument('--receipt-sha256')
    parser.add_argument('--destination', type=Path)
    args = parser.parse_args()
    try:
        result = run(args.config, args.source, args.receipt_sha256, args.destination)
        # Object coordinates belong in the private result file, not scheduled logs.
        print(json.dumps({key: result[key] for key in
                          ('enabled', 'skipped', 'transfer_verified', 'restore_verified', 'deployment_authorized')}))
        return 0
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({'transfer_verified': False, 'error_type': type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
