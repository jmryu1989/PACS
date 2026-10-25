#!/usr/bin/env python3
"""Inventory public MG/XA files and import unchanged originals into an EMPTY local test Orthanc.

This is preparation, not clinical acceptance. No downloads, header rewriting or cleanup.
The caller records commands with scripts/record-run.py and supplies a hang timeout.
"""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit

import pydicom
import requests

ROOT = Path(__file__).resolve().parents[1]


def provenance(*scripts):
    return {'head_sha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
            'git_status': subprocess.check_output(['git', 'status', '--porcelain=v1'], cwd=ROOT, text=True),
            'scripts_sha256': {Path(p).resolve().relative_to(ROOT).as_posix(): digest(p) for p in scripts}}


def local_use_policy(manifest, source):
    # Older collector manifests express this restriction in their scope/licence.
    basis = [str(obj.get(key, '')) for obj in (manifest, source)
             for key in ('scope', 'purpose', 'licence', 'usage_restriction') if obj.get(key)]
    restricted = any(obj.get('local_only') is True for obj in (manifest, source)) or any(
        phrase in text.lower() for text in basis
        for phrase in ('local test use only', 'local evaluation only', 'local internal testing only', 'local-internal-only'))
    return {'local_only': restricted, 'use_policy_basis': basis}


def use_limits(rows, endpoint):
    restricted = [r['sop'] for r in rows if r.get('local_only')]
    if restricted:
        local_endpoint(endpoint)
    return {'local_only_sops': restricted,
            'artifacts_scope': 'LOCAL_INTERNAL_ONLY: originals, screenshots and traces must remain local'
            if restricted else 'Retain original manifest citations and use restrictions'}


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def write_json(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with Path(path).open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def values(ds, keyword):
    """Preserve nested standard attributes without inferring kind from descriptions."""
    found = []
    for element in ds.iterall():
        if element.keyword == keyword:
            value = element.value
            if not isinstance(value, (str, bytes)) and hasattr(value, '__iter__'):
                value = [str(x) for x in value]
            else:
                value = str(value)
            if value not in found:
                found.append(value)
    return found


def inventory(root, sets=None):
    root = Path(root).resolve()
    rows, errors, sources = [], [], []
    counts = Counter()
    registered = {}
    for folder in sorted(root.iterdir()):
        if sets and folder.name not in sets:
            continue
        manifest = folder / 'manifest.json'
        if not manifest.is_file():
            continue
        body = json.loads(manifest.read_text(encoding='utf-8'))
        sources.append({'path': str(manifest), 'sha256': digest(manifest),
                        'scope': body.get('scope', body.get('purpose'))})
        for study in body.get('studies', []) + body.get('repository_studies', []):
            if study.get('folder'):
                registered[(folder / study['folder']).resolve()] = study
        # studies/repositories are the collector's accepted outputs. Raw ZIPs,
        # source clones and quarantine must not masquerade as additional cases.
        for area in ('studies', 'repositories'):
            for path in sorted((folder / area).rglob('*')):
                if not path.is_file():
                    continue
                with path.open('rb') as stream:
                    stream.seek(128)
                    part10 = stream.read(4) == b'DICM'
                if path.suffix.lower() != '.dcm' and not part10:
                    continue
                try:
                    # The accepted pydicom repository includes preamble-less DICOM
                    # datasets. Read those with pydicom, then require a real SOP class;
                    # otherwise an arbitrary .dcm file could look like an empty dataset.
                    ds = pydicom.dcmread(path, stop_before_pixels=True, force=not part10)
                    if not ds.get('SOPClassUID'):
                        raise ValueError('No SOPClassUID in the DICOM dataset')
                    modality = str(ds.get('Modality', 'UNKNOWN'))
                    counts[modality] += 1
                    if modality not in ('MG', 'XA', 'RF'):
                        continue
                    source = next((registered[p] for p in path.parents if p in registered), {})
                    row = {'path': path.relative_to(root).as_posix(), 'bytes': path.stat().st_size,
                           'sha256': digest(path), 'set': folder.name,
                           'collection': source.get('collection'), 'source': source.get('source'),
                           'citations': source.get('required_citations', []),
                           'quarantined': source.get('quarantined', False),
                           'registered_public_tcia': source.get('source') == 'TCIA',
                           'registered_public_sample': source.get('source') == 'TCIA' or source.get('public_sample') is True,
                           'source_url': source.get('source_url'), 'licence': source.get('licence'),
                           'licence_url': source.get('licence_url'),
                           'modality': modality, 'patient': str(ds.get('PatientID', '')),
                           'study': str(ds.get('StudyInstanceUID', '')),
                           'date': str(ds.get('StudyDate', '')),
                           'series': str(ds.get('SeriesInstanceUID', '')),
                           'sop': str(ds.get('SOPInstanceUID', '')),
                           'sop_class': str(ds.get('SOPClassUID', '')),
                           'transfer_syntax': str(ds.file_meta.TransferSyntaxUID),
                           'frames': int(ds.get('NumberOfFrames', 1)),
                           'rows': int(ds.get('Rows', 0)), 'columns': int(ds.get('Columns', 0)),
                           'bits': int(ds.get('BitsAllocated', 0)),
                           'photometric': str(ds.get('PhotometricInterpretation', '')),
                           'attributes': {k: values(ds, k) for k in (
                               'ImageLaterality', 'FrameLaterality', 'Laterality', 'ViewPosition', 'ViewCodeSequence',
                               'ImageType', 'FrameType', 'DerivationDescription',
                               'FrameTime', 'FrameTimeVector', 'FrameIncrementPointer',
                               'CineRate', 'RecommendedDisplayFrameRate', 'SeriesDescription',
                               'PixelSpacing', 'ImagerPixelSpacing', 'ImagePositionPatient')},
                           **local_use_policy(body, source)}
                    rows.append(row)
                except Exception as error:
                    errors.append({'path': path.relative_to(root).as_posix(), 'error': str(error)})
    groups = []
    for key in sorted({(r['set'], r['collection'] or 'unregistered', r['modality']) for r in rows}):
        selected = [r for r in rows if (r['set'], r['collection'] or 'unregistered', r['modality']) == key]
        groups.append({'set': key[0], 'collection': key[1], 'modality': key[2],
                       'studies': len({r['study'] for r in selected}), 'objects': len(selected),
                       'frames': sum(r['frames'] for r in selected),
                       'multiframe_objects': sum(r['frames'] > 1 for r in selected),
                       'bytes': sum(r['bytes'] for r in selected)})
    return {'root': str(root), **provenance(__file__),
        'scope': 'accepted studies/repositories; raw archives, source clones and quarantine excluded',
        'sources': sources, 'all_modality_counts': dict(counts), 'groups': groups,
        'files': rows, 'parse_errors': errors,
        'xa_cine_available': any(r['modality'] == 'XA' and r['frames'] > 1 for r in rows)}


def selected_files(body, studies, sops=None):
    wanted = set(studies)
    rows = [r for r in body['files'] if r['study'] in wanted]
    if sops:
        rows=[r for r in rows if r['sop'] in set(sops)]
        if {r['sop'] for r in rows} != set(sops):
            raise ValueError('Select existing SOP UIDs from the selected studies')
    if not wanted or {r['study'] for r in rows} != wanted:
        raise ValueError('Select existing study UIDs from this inventory')
    for row in rows:
        if not row.get('registered_public_sample', row.get('registered_public_tcia')) or row['quarantined']:
            raise ValueError('Not an accepted public sample: ' + row['path'])
        path = (Path(body['root']) / row['path']).resolve()
        if not path.is_relative_to(Path(body['root']).resolve()) or digest(path) != row['sha256']:
            raise ValueError('Source missing or changed: ' + row['path'])
    return rows


def local_endpoint(url):
    parsed = urlsplit(url)
    if (parsed.scheme not in ('http', 'https') or
            parsed.hostname not in ('localhost', '127.0.0.1', '::1') or
            parsed.username or parsed.password):
        raise ValueError('Only an explicitly selected local synthetic endpoint is supported')
    return parsed


def verify_orthanc_target(project, url, timeout):
    """Catch an accidental original-volume/port selection before any upload."""
    parsed = local_endpoint(url)
    if not project or project == 'pacs-starter-kit':
        raise ValueError('Select the isolated synthetic Compose project')
    ids = subprocess.check_output(['docker', 'ps', '-q', '--filter',
        'label=com.docker.compose.project=' + project, '--filter',
        'label=com.docker.compose.service=orthanc'], text=True, timeout=timeout).split()
    if len(ids) != 1:
        raise ValueError('Expected one running synthetic Orthanc container')
    info = json.loads(subprocess.check_output(['docker', 'inspect', ids[0]],
                                            text=True, timeout=timeout))[0]
    ports = info['NetworkSettings']['Ports'].get('8042/tcp') or []
    if not any(int(p['HostPort']) == (parsed.port or (443 if parsed.scheme == 'https' else 80)) for p in ports):
        raise ValueError('Endpoint does not match this synthetic Orthanc published port')
    data = [m for m in info['Mounts'] if m['Destination'] == '/var/lib/orthanc/db']
    if len(data) != 1 or data[0]['Type'] != 'volume' or not data[0]['Name'].startswith(project + '_'):
        raise ValueError('Orthanc data must use its own synthetic project volume')
    return {'project': project, 'container': info['Id'], 'data_volume': data[0]['Name'], 'url': url}


def load_samples(args):
    body = json.loads(Path(args.inventory).read_text(encoding='utf-8'))
    rows = selected_files(body, args.study, args.sop)
    target = verify_orthanc_target(args.synthetic_project, args.orthanc, args.timeout)
    # Synthetic credentials only. Never read the product checkout's .env.
    session = requests.Session()
    session.auth = (os.environ['MGXA_ORTHANC_USER'], os.environ['MGXA_ORTHANC_PASSWORD'])
    session.trust_env = False
    base = args.orthanc.rstrip('/')
    response = session.get(base + '/studies', timeout=args.timeout)
    response.raise_for_status()
    if response.json():
        raise ValueError('Use an empty synthetic Orthanc; this loader never deletes existing studies')
    result = {**provenance(__file__), 'use_limits': use_limits(rows, args.orthanc),
              'inventory_head_sha': body['head_sha'], 'inventory': str(Path(args.inventory).resolve()),
              'inventory_sha256': digest(args.inventory), 'target': target, 'uploads': [],
              'status': 'RUNNING', 'cleanup': 'No automatic deletion; retain this owned project for inspection'}
    # Exclusive result creation happens before the first write, so partial uploads survive failure.
    write_json(args.output, result)
    try:
        for row in rows:
            with (Path(body['root']) / row['path']).open('rb') as stream:
                response = session.post(base + '/instances', data=stream,
                    headers={'Content-Type': 'application/dicom'}, timeout=args.timeout)
            response.raise_for_status()
            receipt = response.json()
            if receipt.get('Status') != 'Success':
                raise RuntimeError('Upload did not create the selected original: ' + str(receipt))
            uploaded = {'source': row, 'orthanc': receipt, 'original_readback': 'NOT_RUN'}
            result['uploads'].append(uploaded)
            with session.get(base + '/instances/' + receipt['ID'] + '/file',
                             stream=True, timeout=args.timeout) as original:
                original.raise_for_status()
                h = hashlib.sha256()
                for block in original.iter_content(1024 * 1024):
                    h.update(block)
            uploaded['readback_sha256'] = h.hexdigest()
            if h.hexdigest() != row['sha256']:
                raise RuntimeError('Stored original differs: ' + row['path'])
            uploaded['original_readback'] = 'PASS'
            Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        result['status'] = 'LOADED_ORIGINALS_ONLY'
    except Exception as error:
        result.update(status='FAIL', error=str(error))
        raise
    finally:
        Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    inv = sub.add_parser('inventory')
    inv.add_argument('--root', required=True)
    inv.add_argument('--output', required=True)
    inv.add_argument('--set', action='append', help='Inventory only these named sample sets')
    load = sub.add_parser('load')
    load.add_argument('--inventory', required=True)
    load.add_argument('--study', action='append', required=True)
    load.add_argument('--sop', action='append', help='Optionally import only these explicit originals, not complete studies')
    load.add_argument('--synthetic-project', required=True)
    load.add_argument('--orthanc', required=True)
    load.add_argument('--timeout', type=float, required=True, help='Request hang timeout from host measurements')
    load.add_argument('--output', required=True)
    args = parser.parse_args()
    if args.action == 'inventory':
        result = inventory(args.root, args.set)
        write_json(args.output, result)
        print(json.dumps({'files': len(result['files']), 'groups': result['groups'],
                          'parse_errors': len(result['parse_errors'])}))
        return int(bool(result['parse_errors']))
    load_samples(args)
    print('Selected originals loaded and read back; viewer acceptance NOT_RUN')
    return 0


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    raise SystemExit(main())
