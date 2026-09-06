"""Compare private offline Orthanc index/listing snapshots; never contact storage."""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import time

import ops_export_crypto as private
import ops_export_inventory as inventory

INDEX_LIMIT = 512 * 1024**2
LIST_LIMIT = 64 * 1024**2
ITEM_LIMIT = 100000
PAGE_LIMIT = 10000
UUID = r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
PROFILE = {'orthanc': '1.12.5', 'storage_plugin': '2.5.0', 'structure': 'flat', 'client_encryption': False}
COLUMNS = {'id', 'fileType', 'uuid', 'compressedSize', 'uncompressedSize', 'compressionType',
           'uncompressedMD5', 'compressedMD5'}
PAGE_FIELDS = {'Name', 'Prefix', 'KeyCount', 'MaxKeys', 'IsTruncated', 'Contents',
               'ContinuationToken', 'NextContinuationToken'}
OBJECT_FIELDS = {'Key', 'Size', 'ETag', 'LastModified', 'StorageClass', 'ChecksumAlgorithm',
                 'ChecksumType', 'Owner', 'RestoreStatus'}


def require(value):
    if not value:
        raise ValueError('Offline storage reconciliation refused')


def integer(value, lower, upper):
    return type(value) is int and lower <= value <= upper


def token(value):
    return type(value) is str and 0 < len(value) <= 4096 and all(ord(c) >= 32 for c in value)


def scope(bucket, prefix):
    require(type(bucket) is str and re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', bucket))
    require(type(prefix) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9/_-]{0,126}/', prefix))
    require('//' not in prefix)


def listing(raw, expected, bucket, prefix):
    scope(bucket, prefix)
    require(type(expected) is str and inventory.HEX.fullmatch(expected))
    require(len(raw) <= LIST_LIMIT and hashlib.sha256(raw).hexdigest() == expected)
    body = json.loads(raw, object_pairs_hook=inventory.unique, parse_constant=lambda value: require(False))
    require(type(body) is dict and set(body) == {'schema', 'bucket', 'prefix', 'profile', 'pages'})
    require(type(body['schema']) is int and body['schema'] == 1 and body['bucket'] == bucket and body['prefix'] == prefix)
    require(type(body['profile']) is dict and body['profile'] == PROFILE and body['profile']['client_encryption'] is False)
    pages = body['pages']
    require(type(pages) is list and 0 < len(pages) <= PAGE_LIMIT)
    objects, seen_tokens, requested = {}, set(), None
    for number, envelope in enumerate(pages):
        require(type(envelope) is dict and set(envelope) == {'request_token', 'response'})
        require(envelope['request_token'] == requested)
        page = envelope['response']
        require(type(page) is dict and set(page) <= PAGE_FIELDS)
        require(page.get('Name') == bucket and page.get('Prefix') == prefix)
        require(type(page.get('IsTruncated')) is bool)
        require(integer(page.get('MaxKeys'), 1, 1000))
        require(page.get('ContinuationToken') == requested)
        entries = page.get('Contents', [])
        require(type(entries) is list and integer(page.get('KeyCount'), 0, page['MaxKeys'])
                and page['KeyCount'] == len(entries))
        for entry in entries:
            require(type(entry) is dict and {'Key', 'Size'} <= set(entry) <= OBJECT_FIELDS)
            key = entry['Key']
            require(type(key) is str and key.startswith(prefix) and len(key.encode('utf-8')) <= 1024
                    and all(ord(c) >= 32 for c in key) and key not in objects)
            require(integer(entry['Size'], 0, 2**63-1))
            objects[key] = entry['Size']
            require(len(objects) <= ITEM_LIMIT)
        if page['IsTruncated']:
            requested = page.get('NextContinuationToken')
            require(token(requested) and requested not in seen_tokens and number < len(pages)-1)
            seen_tokens.add(requested)
        else:
            require('NextContinuationToken' not in page and number == len(pages)-1)
    return objects, len(pages)


def rows_from_index(path):
    # Only an independently hash-checked copy is opened immutable. Never use
    # immutable on a live database whose WAL might contain committed records.
    connection = sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', timeout=1)
    deadline, steps = time.monotonic()+10, 0
    def progress():
        nonlocal steps
        steps += 1
        return int(steps > 10000 or time.monotonic() > deadline)
    connection.set_progress_handler(progress, 1000)
    try:
        connection.execute('PRAGMA query_only=ON')
        connection.execute('PRAGMA trusted_schema=OFF')
        schema = connection.execute("SELECT type,sql FROM sqlite_master WHERE name='AttachedFiles'").fetchall()
        require(len(schema) == 1 and schema[0][0] == 'table' and 'VIRTUAL' not in schema[0][1].upper())
        require({row[1] for row in connection.execute('PRAGMA table_info(AttachedFiles)')} == COLUMNS)
        require(connection.execute('PRAGMA integrity_check(1)').fetchall() == [('ok',)])
        connection.row_factory = sqlite3.Row
        rows = [dict(row) for row in connection.execute('SELECT * FROM AttachedFiles LIMIT ?', (ITEM_LIMIT+1,))]
        require(len(rows) <= ITEM_LIMIT)
        return validate_rows(rows)
    finally:
        connection.close()


def validate_rows(rows):
    require(type(rows) is list and len(rows) <= ITEM_LIMIT)
    uuids, identities = set(), set()
    for row in rows:
        require(type(row) is dict and set(row) == COLUMNS)
        require(integer(row['id'], 0, 2**63-1) and integer(row['fileType'], 1, 65535))
        require(type(row['uuid']) is str and re.fullmatch(UUID, row['uuid']))
        require(row['uuid'] not in uuids and (row['id'], row['fileType']) not in identities)
        uuids.add(row['uuid']); identities.add((row['id'], row['fileType']))
        for field in ('compressedSize', 'uncompressedSize'):
            require(integer(row[field], 0, 2**63-1))
        require(integer(row['compressionType'], 0, 2**31-1))
        for field in ('compressedMD5', 'uncompressedMD5'):
            require(row[field] is None or type(row[field]) is str and
                    (row[field] == '' or re.fullmatch('[0-9a-f]{32}', row[field])))
    return rows


def compare(rows, objects, prefix):
    by_uuid = defaultdict(list)
    unknown_objects = []
    for key, size in objects.items():
        match = re.fullmatch('('+UUID+r')(\.[A-Za-z0-9.]{1,20})', key[len(prefix):])
        if match is None:
            unknown_objects.append(key)
        else:
            by_uuid[match[1]].append({'key': key, 'size': size, 'suffix': match[2]})
    details = {'missing': [], 'size_mismatch': [], 'unsupported': [], 'ambiguous': [],
               'orphan_candidates': [], 'unknown_objects': sorted(unknown_objects)}
    by_type = {}
    indexed = {row['uuid'] for row in rows}
    for row in rows:
        kind = str(row['fileType'])
        counts = by_type.setdefault(kind, dict(indexed=0, missing=0, size_mismatch=0, unsupported=0, ambiguous=0))
        counts['indexed'] += 1
        matches = by_uuid.get(row['uuid'], [])
        record = {'uuid': row['uuid'], 'fileType': row['fileType'], 'objects': matches}
        # UUID and the index identify the type. Suffixes are only a support check
        # for this observed profile, never a way to infer an orphan's fileType.
        observed = {1: '.dcm', 1024: '.unk', 1025: '.unk'}.get(row['fileType'])
        unsupported = observed is None or row['compressionType'] != 1 or row['compressedSize'] != row['uncompressedSize']
        if unsupported or any(item['suffix'] != observed for item in matches):
            details['unsupported'].append(record); counts['unsupported'] += 1
        if not matches:
            details['missing'].append(record); counts['missing'] += 1
        elif len(matches) != 1:
            details['ambiguous'].append(record); counts['ambiguous'] += 1
        elif matches[0]['size'] != row['compressedSize']:
            details['size_mismatch'].append(record); counts['size_mismatch'] += 1
    for uuid in sorted(set(by_uuid)-indexed):
        details['orphan_candidates'].extend(by_uuid[uuid])
    totals = {name: len(items) for name, items in details.items()}
    return {'comparison_consistent': not any(totals.values()), 'counts': totals,
            'by_file_type': by_type, 'details': details}


def input_size(path, maximum):
    private.private_dir(path.absolute().parent)
    with private.read_private(path) as stream:
        size = os.fstat(stream.fileno()).st_size
        require(0 < size <= maximum)
    return size


def reconcile(index, index_hash, listing_path, listing_hash, bucket, prefix, destination):
    private.linux_only()
    scope(bucket, prefix)
    require(type(index_hash) is str and inventory.HEX.fullmatch(index_hash))
    index = private.path_guard(index)
    require(not any(path.exists() or path.is_symlink() for path in
                    (index.with_name(index.name+suffix) for suffix in ('-wal', '-shm', '-journal'))))
    size = input_size(index, INDEX_LIMIT)
    input_size(listing_path, LIST_LIMIT)
    with private.read_private(listing_path) as stream:
        raw = stream.read(LIST_LIMIT+1)
    objects, pages = listing(raw, listing_hash, bucket, prefix)
    with tempfile.TemporaryDirectory(prefix='kin-reconcile-') as folder:
        copied = Path(folder)/'index.sqlite'
        private.copy_bound(index, copied, {'bytes': size, 'sha256': index_hash})
        rows = rows_from_index(copied)
    result = compare(rows, objects, prefix)
    summary = {key: value for key, value in result.items() if key != 'details'}
    summary.update(reconciliation_complete=True, pages=pages, indexed_attachments=len(rows), listed_objects=len(objects),
                   content_verified=False, provider_verified=False, snapshot_consistency_verified=False,
                   restore_verified=False, migration_authorized=False)
    report = dict(schema=1, index_sha256=index_hash, listing_sha256=listing_hash, bucket=bucket, prefix=prefix,
                  profile=PROFILE, **summary, details=result['details'])
    with private.workspace(destination, index) as pending:
        with private.create_file(pending/'report.json') as out:
            out.write(private.encode(report)); private.sync(out)
        private.sync_directory(pending)
        private.publish(pending, Path(destination).absolute())
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('index', 'listing', 'destination'):
        parser.add_argument('--'+name, type=Path, required=True)
    for name in ('index-sha256', 'listing-sha256', 'bucket', 'prefix'):
        parser.add_argument('--'+name, required=True)
    args = parser.parse_args()
    try:
        result = reconcile(args.index, args.index_sha256, args.listing, args.listing_sha256,
                           args.bucket, args.prefix, args.destination)
        print(json.dumps(result))
        return 0 if result['comparison_consistent'] else 2
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({'reconciliation_complete': False, 'error_type': type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
