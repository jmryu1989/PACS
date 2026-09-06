"""Synthetic Orthanc worker; only invoked inside the disposable fixture image."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.request

LIMIT = 32 * 1024**2
HEX = re.compile('[0-9a-f]{64}')
UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}')
SAMPLES = {1024: b'SYNTHETIC C12K attachment\n', 1025: b'{"synthetic":"C12K"}\n'}
ROOT = Path('/work')


def require(value):
    if not value:
        raise ValueError('Synthetic Orthanc fixture refused')


def digest(raw):
    return dict(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())


def store_path(uid):
    require(type(uid) is str and UUID.fullmatch(uid))
    return 'store/'+uid[:2]+'/'+uid[2:4]+'/'+uid


def snapshot_contract(body):
    require(type(body) is dict and set(body) == {'instance', 'files', 'attachments'})
    require(type(body['instance']) is str and re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{8}){4}', body['instance']))
    require(type(body['attachments']) is list and len(body['attachments']) == 3)
    kinds, paths = set(), {'index/index'}
    for entry in body['attachments']:
        require(type(entry) is dict and set(entry) == {'file_type', 'uuid'})
        kind = entry['file_type']
        require(type(kind) is int and kind in {1, 1024, 1025} and kind not in kinds)
        kinds.add(kind)
        path = store_path(entry['uuid'])
        require(path not in paths)
        paths.add(path)
    require(type(body['files']) is dict and set(body['files']) == paths)
    for entry in body['files'].values():
        require(type(entry) is dict and set(entry) == {'bytes', 'sha256'}
                and type(entry['bytes']) is int and 0 < entry['bytes'] <= LIMIT
                and type(entry['sha256']) is str and HEX.fullmatch(entry['sha256']))
    require(sum(entry['bytes'] for entry in body['files'].values()) <= LIMIT)
    for entry in body['attachments']:
        if entry['file_type'] in SAMPLES:
            require(body['files'][store_path(entry['uuid'])] == digest(SAMPLES[entry['file_type']]))


def archive_files(raw, body):
    snapshot_contract(body)
    require(0 < len(raw) <= LIMIT and len(raw) % 512 == 0)
    expected = body['files']
    directories = {str(parent) for name in expected for parent in PurePosixPath(name).parents if str(parent) != '.'}
    files, seen, end = {}, set(), 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as archive:
        for member in archive:
            name = member.name
            # A closed file set also excludes SQLite WALs, config, links and
            # alternate spellings of paths. Never delegate extraction to tar.
            require(name not in seen and len(seen) < 32 and not member.pax_headers
                    and not member.issparse() and (member.isfile() or member.isdir()))
            seen.add(name)
            require(0 <= member.size <= LIMIT and member.offset_data+member.size <= len(raw))
            if member.isdir():
                require(name in directories and member.size == 0)
            else:
                require(name in expected)
                value = archive.extractfile(member).read(LIMIT+1)
                require(digest(value) == expected[name])
                files[name] = value
            end = member.offset_data + ((member.size+511)//512)*512
    require(set(files) == set(expected) and len(raw)-end >= 1024 and not any(raw[end:]))
    return files


def call(path, body=None, method=None):
    data = body if isinstance(body, bytes) else None if body is None else json.dumps(body).encode()
    request = urllib.request.Request('http://127.0.0.1:18042'+path, data=data, method=method)
    with urllib.request.urlopen(request, timeout=5) as response:
        require(response.status == 200)
        value = response.read(LIMIT+1)
        require(len(value) <= LIMIT)
        return value


def stop(process):
    process.terminate()
    try:
        require(process.wait(timeout=15) == 0)
    except BaseException:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        raise


def start():
    config = dict(Name='SYNTHETIC C12K', StorageDirectory=str(ROOT/'store'),
                  IndexDirectory=str(ROOT/'index'), Plugins=[], DicomServerEnabled=False,
                  RemoteAccessAllowed=False, AuthenticationEnabled=False, HttpPort=18042,
                  StorageCompression=False, StoreMD5ForAttachments=True, OverwriteInstances=False)
    (ROOT/'config.json').write_text(json.dumps(config))
    log = (ROOT/'orthanc.log').open('ab')
    try:
        process = subprocess.Popen(['Orthanc', str(ROOT/'config.json')], stdout=log, stderr=log)
    finally:
        log.close()
    try:
        deadline = time.monotonic()+30
        while time.monotonic() < deadline:
            require(process.poll() is None)
            try:
                system = json.loads(call('/system'))
                require(system['Version'] == '1.12.5')
                return process
            except (OSError, ValueError):
                time.sleep(.25)
        raise TimeoutError('Synthetic Orthanc readiness timeout')
    except BaseException:
        stop(process)
        raise


def observe(instance):
    index = ROOT/'index/index'
    before = digest(index.read_bytes())
    connection = sqlite3.connect(index.as_uri()+'?mode=ro', uri=True)
    try:
        require(connection.execute('PRAGMA integrity_check').fetchall() == [('ok',)])
        connection.row_factory = sqlite3.Row
        rows = [dict(row) for row in connection.execute('SELECT * FROM AttachedFiles')]
    finally:
        connection.close()
    require(digest(index.read_bytes()) == before and len(rows) == 3)
    files = {'index/index': before}
    attachments = []
    for row in sorted(rows, key=lambda row: row['fileType']):
        path = store_path(row['uuid'])
        value = (ROOT/path).read_bytes()
        # The pinned 1.12.5 SQLite profile records uncompressed attachments as 1.
        # Do not confuse this persisted value with a plugin API enum.
        require(row['compressionType'] == 1 and row['compressedSize'] == row['uncompressedSize'] == len(value)
                and row['compressedMD5'] == row['uncompressedMD5'] == hashlib.md5(value).hexdigest())
        files[path] = digest(value)
        attachments.append(dict(file_type=row['fileType'], uuid=row['uuid']))
    body = dict(instance=instance, files=files, attachments=attachments)
    snapshot_contract(body)
    actual = set()
    for directory in ('index', 'store'):
        for path in (ROOT/directory).rglob('*'):
            require(not path.is_symlink() and (path.is_file() or path.is_dir()))
            if path.is_file():
                actual.add(path.relative_to(ROOT).as_posix())
    require(actual == set(files))
    return body


def verify_rest(body, originals):
    instance = body['instance']
    require(json.loads(call('/instances')) == [instance])
    tags = json.loads(call('/instances/'+instance+'/simplified-tags'))
    require(tags['PatientID'] == 'SYNTHETIC-C12K' and tags['PatientName'] == 'SYNTHETIC^C12K')
    for entry in body['attachments']:
        kind = entry['file_type']
        path = '/file' if kind == 1 else '/attachments/'+str(kind)+'/data'
        value = call('/instances/'+instance+path)
        require(value == originals[store_path(entry['uuid'])])
        if kind == 1:
            require(value[128:132] == b'DICM')
        else:
            require(value == SAMPLES[kind])


def produce():
    process = start()
    try:
        created = json.loads(call('/tools/create-dicom', dict(Tags={
            'PatientID': 'SYNTHETIC-C12K', 'PatientName': 'SYNTHETIC^C12K', 'Modality': 'OT'}, Force=True)))
        instance = created['ID']
        for kind, data in SAMPLES.items():
            call('/instances/'+instance+'/attachments/'+str(kind), data, 'PUT')
    finally:
        # Only a gracefully stopped, reaped process yields a frozen snapshot.
        stop(process)
    body = observe(instance)
    with tarfile.open(ROOT/'store.tar', 'w', format=tarfile.USTAR_FORMAT) as archive:
        for name in sorted(body['files']):
            value = (ROOT/name).read_bytes()
            member = tarfile.TarInfo(name)
            member.size, member.mode = len(value), 0o600
            archive.addfile(member, io.BytesIO(value))
    originals = archive_files((ROOT/'store.tar').read_bytes(), body)
    process = start()
    try:
        verify_rest(body, originals)
    finally:
        stop(process)
    return body


def consume(body, raw):
    originals = archive_files(raw, body)
    require(not (ROOT/'store').exists() and not (ROOT/'index').exists())
    for name, value in originals.items():
        target = ROOT/name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with target.open('xb') as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(value)
    require(observe(body['instance']) == body)
    process = start()
    try:
        verify_rest(body, originals)
    finally:
        stop(process)
    return dict(instance=body['instance'], attachments=body['attachments'], rest_bytes_match=True,
                sqlite_integrity=True, uid=os.geteuid())


if __name__ == '__main__':
    require(os.geteuid() == 65534 and ROOT.is_dir())
    if sys.argv[1] == 'produce':
        result = produce()
    else:
        require(sys.argv[1] == 'consume' and len(sys.argv[2]) <= 8192)
        result = consume(json.loads(sys.argv[2]), sys.stdin.buffer.read(LIMIT+1))
    print(json.dumps(result, sort_keys=True))
