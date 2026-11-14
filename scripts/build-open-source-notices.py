#!/usr/bin/env python3
"""Build the shipped notice/inventory from repository declarations, without network.

License originals are curated separately in legal/licenses/catalog.json; a changed
version cannot borrow the previous version's texts. --check checks reproducibility;
--require-complete additionally fails for missing originals or source metadata.
"""
from __future__ import annotations

import argparse
import ast
from collections import Counter
import hashlib
from html import escape
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
LEGAL = Path('worklist-v0/legal')
SECTIONS = ('API', 'Gateway', 'OHIF', 'Containers', 'Orthanc', 'ASR')
MISSING = '원문 미확보'


def compose_documents(documents):
    """Use the existing API YAML parser; runtime CI always installs the API lock.

    Compose's !override/!reset tags affect merging, not the declared image values
    inventoried here. Preserve those tagged values without applying a merge.
    """
    script = '''const fs = require('node:fs');
const YAML = require(process.argv[1]);
const schema = YAML.DEFAULT_SCHEMA.extend(['!override', '!reset'].flatMap(tag =>
  ['sequence', 'mapping', 'scalar'].map(kind => new YAML.Type(tag, {kind, construct: value => value}))));
const documents = JSON.parse(fs.readFileSync(0, 'utf8'));
const result = Object.fromEntries(Object.entries(documents).map(([path, source]) =>
  [path, YAML.load(source, {schema})]));
process.stdout.write(JSON.stringify(result));'''
    result = subprocess.run(['node', '-e', script, str(ROOT / 'api/node_modules/js-yaml')],
                            input=json.dumps(documents), capture_output=True, text=True,
                            encoding='utf-8', timeout=30)
    if result.returncode:
        raise RuntimeError('Compose YAML parser failed: ' + result.stderr)
    return json.loads(result.stdout)


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode('utf-8')


def repository_files(root):
    # Include new product inputs before commit, but never local run evidence.
    result = subprocess.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
                            cwd=root, capture_output=True, check=True, timeout=30)
    return sorted(p for p in set(result.stdout.decode('utf-8').split('\0'))
                  if p and not p.startswith('tmp/') and (root / p).is_file())


def collect(root, files=None, source_offer='link'):
    files = repository_files(root) if files is None else sorted(files)
    catalog_path = root / LEGAL / 'licenses/catalog.json'
    catalog = read_json(catalog_path) if catalog_path.exists() else {'components': {}}
    inputs, rows = {}, []

    def input_bytes(path):
        # Git checkouts may use CRLF; inventory hashes describe LF-normalized text.
        data = (root / path).read_bytes().replace(b'\r\n', b'\n')
        inputs[path] = hashlib.sha256(data).hexdigest()
        return data

    def add(section, name, version, origin, license_name='', **extra):
        key = name + '@' + version
        record = catalog.get('components', {}).get(key, {})
        originals, missing = [], []
        for item in record.get('files', []):
            path = str(LEGAL / 'licenses' / item['path']).replace('\\', '/')
            if not (root / path).is_file():
                missing.append(path)
                continue
            body = input_bytes(path)
            if not body.strip() or hashlib.sha256(body).hexdigest() != item['sha256']:
                missing.append(path)
                continue
            originals.append(item)
        if not originals:
            missing.append('라이선스·저작권·해당 NOTICE 원문')
        missing.extend(record.get('missing', []))
        rows.append(dict(section=section, name=name, version=version, origin=origin,
                         license=license_name or record.get('license') or 'Unverified',
                         supplier=record.get('supplier', 'Unverified'),
                         originals=originals, missing=missing,
                         notes=record.get('notes', []),
                         source=record.get('source', ''), **extra))

    if catalog_path.exists():
        input_bytes((LEGAL / 'licenses/catalog.json').as_posix())
    for path in files:
        if path == 'api/package-lock.json' or (path.startswith('gateway/') and path.endswith('package-lock.json')):
            lock = json.loads(input_bytes(path))
            for location, item in sorted(lock.get('packages', {}).items()):
                if not location:
                    continue
                name = item.get('name') or location.rsplit('node_modules/', 1)[-1]
                add('API' if path.startswith('api/') else 'Gateway', name, item.get('version', 'Unverified'),
                    path + ':' + location, item.get('license', ''),
                    scope='Development' if item.get('dev') else 'Runtime',
                    resolved=item.get('resolved', ''), integrity=item.get('integrity', ''))
        elif path.startswith(('gateway/', 'api/print/')) and re.fullmatch(r'requirements[^/]*\.txt', Path(path).name):
            # api/print: the Film / DICOM Print helper's Python packages in the API image (hash-pinned, one per line).
            section = 'API' if path.startswith('api/') else 'Gateway'
            declared = []
            for line in input_bytes(path).decode('utf-8').splitlines():
                line = re.sub(r'\s+--hash=\S+', '', line.split('#', 1)[0]).strip()
                if not line:
                    continue
                match = re.fullmatch(r'([\w.-]+)==([^;\s]+)(?:\s*;.*)?', line)
                if match:
                    declared.append([match[1], match[2]])
                    add(section, match[1], match[2], path, scope='Declared dependency')
                else:
                    add(section, line, 'Unverified', path, scope='Unresolved requirement')
            resolution = catalog.get('requirement_resolutions', {}).get(path, {})
            provenance = LEGAL / 'licenses' / resolution.get('provenance', '')
            resolved = ((root / provenance).is_file() and
                        hashlib.sha256(input_bytes(provenance.as_posix())).hexdigest() == resolution.get('provenance_sha256'))
            if (not resolved or resolution.get('sha256') != inputs[path] or
                    sorted(resolution.get('packages', [])) != sorted(declared)):
                add(section, 'unpinned transitive dependencies of ' + path, 'Unverified', path,
                    scope='Unresolved transitive dependencies')
                rows[-1]['missing'].append('현재 requirements에 대응하는 전체 의존성 해석 기록')

    images = {}
    compose_paths = [p for p in files if re.search(r'(^|/)docker-compose[^/]*\.ya?ml$', p)]
    compose = compose_documents({p: input_bytes(p).decode('utf-8') for p in compose_paths}) if compose_paths else {}
    for path in files:
        if path in compose:
            document = compose[path] or {}
            for service, value in (document.get('services') or {}).items():
                if isinstance(value, dict) and value.get('image'):
                    images.setdefault(value['image'], []).append(path + ':' + service)
        elif Path(path).name == 'Dockerfile' or Path(path).name.startswith('Dockerfile.'):
            stages = set()
            for line in input_bytes(path).decode('utf-8').splitlines():
                tokens = line.strip().split()
                if not tokens or tokens[0].upper() != 'FROM':
                    continue
                tokens = [x for x in tokens[1:] if not x.startswith('--')]
                image = tokens[0]
                if image.lower() not in stages and image != 'scratch':
                    images.setdefault(image, []).append(path)
                if len(tokens) >= 3 and tokens[1].upper() == 'AS':
                    stages.add(tokens[2].lower())
    for reference, origins in sorted(images.items()):
        # This declaration selects our locally built API test image, not a
        # third-party distribution. Its dependencies come from the API lock.
        if reference == '${KIN_TEST_API_IMAGE:-kin-api:c1-candidate}':
            continue
        image_name, _, digest = reference.partition('@')
        image_tag = image_name.rsplit(':', 1)[1] if ':' in image_name.rsplit('/', 1)[-1] else None
        if image_tag:
            image_name = image_name.rsplit(':', 1)[0]
        if '$' in reference:
            # A runtime override is a declaration, not an observed image pin.
            image_name, image_tag, digest = None, None, None
        add('Containers', reference, reference, ', '.join(sorted(origins)),
            image_name=image_name, image_tag=image_tag, digest=digest or None,
            unresolved_interpolation='$' in reference,
            scope='Build/test' if all(p.startswith('tests/') for p in origins) else 'Declared image')
        add('Containers', 'Distribution packages in ' + reference, reference,
            ', '.join(sorted(origins)), scope='Unresolved image package inventory')
        rows[-1]['missing'].append('이미지 OS 패키지 및 Dockerfile의 apt-get/apk 추가 패키지 전체 목록·개별 원문')
        if image_name == 'orthancteam/orthanc':
            rows[-1]['missing'].append('Orthanc/plugin 바이너리에 포함된 제3자 라이브러리 목록·개별 원문')

    # This upstream matrix is tied to the exact image tag, not to a guessed
    # Orthanc version (the image tag is a bundle release date).
    matrix_path = LEGAL / 'licenses/orthanc-build-matrix-24.12.0.json'
    orthanc_images = [x for x in images if x.startswith('orthancteam/orthanc:')]
    for reference in orthanc_images:
        if reference == 'orthancteam/orthanc:24.12.0' and (root / matrix_path).exists():
            matrix = json.loads(input_bytes(matrix_path.as_posix()))
            for component in matrix['components']:
                add('Orthanc', component['name'], component['tag'], reference,
                    source_tag=component['tag'], upstream_source=component['source'])
        else:
            add('Orthanc', 'Orthanc bundle source metadata', reference, reference)

    # Pinned extracted assets can carry webpack license text and JSON metadata.
    # Never substitute a current upstream OHIF dependency list for the shipped build.
    ohif_metadata = [p for p in files if 'ohif' in p.lower() and
                     Path(p).name.lower() in ('third-party-licenses.json', 'license-report.json')]
    for path in ohif_metadata:
        metadata = json.loads(input_bytes(path))
        for component in metadata['components']:
            add('OHIF', component['name'], component['version'], path, component.get('license', ''))
    if not ohif_metadata:
        add('OHIF', 'OHIF embedded build', ', '.join(orthanc_images) or 'Unverified',
            'tools/minhoon-studio/dev/extract_ohif.py', scope='Embedded viewer')
        rows[-1]['missing'].append('libOrthancOHIF.so 내 고정 OHIF 빌드의 의존성 목록·라이선스 메타데이터·NOTICE')

    pins_path = 'scripts/asr_engine_attest.py'
    if pins_path in files:
        tree = ast.parse(input_bytes(pins_path).decode('utf-8'))
        pins = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
                    and any(isinstance(t, ast.Name) and t.id == 'PINS' for t in n.targets))
        add('ASR', pins['engine_name'], pins['engine_tag'], pins_path,
            commit=pins['engine_commit'], tag_object=pins['engine_tag_object'])
        add('ASR', pins['model_file'], pins['model_revision'], pins_path,
            repository=pins['model_repo'], sha256=pins['model_sha256'])

    # A file-list plus content scan records the scope of the no-local-source claim.
    # Application config/client references are not upstream source modifications.
    source_files, patches, checked_files = [], [], []
    source_extensions = {'.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.patch', '.diff'}
    for path in files:
        if Path(path).suffix.lower() not in source_extensions:
            continue
        checked_files.append(path)
        body = input_bytes(path).decode('utf-8', errors='replace')
        if 'orthanc' in path.lower() or re.search(r'OrthancPlugin|OrthancFramework|orthanc[-/](?:plugins|sources)', body, re.I):
            source_files.append(path)
        if Path(path).suffix.lower() in {'.patch', '.diff'} and re.search('orthanc|ohif', body, re.I):
            patches.append(path)
    modification = dict(checked_extensions=sorted(source_extensions), source_files=source_files,
                        patches=patches, checked_files=checked_files,
                        statement='수정 여부 확인 필요' if source_files or patches else 'Halo 수정 없음',
                        scope='저장소의 Orthanc/plugin C/C++ 원본 및 patch/diff 파일명·본문 검색 범위. 이미지 내부 수정 여부는 별도 확인 대상입니다. '
                              '제품 설정 변경은 별도입니다: config/ohif.js를 /etc/orthanc/ohif.js에 마운트한 kinCreate 확장, '
                              'proxy/nginx.conf.template의 sub_filter OHIF HTML 브랜딩, config/orthanc.json 설정이 적용됩니다.')
    rows.sort(key=lambda r: (SECTIONS.index(r['section']), r['name'], r['version'], r['origin']))
    return dict(schema_version=1, source_offer=source_offer, inputs=inputs,
                components=rows, counts=dict(Counter(r['section'] for r in rows)),
                modification=modification,
                complete=not any(r['missing'] for r in rows) and not source_files and not patches and source_offer == 'link')


def render(document):
    e = lambda value: escape(str(value), quote=True)
    lines = ['<!DOCTYPE html>', '<!-- Generated by scripts/build-open-source-notices.py; do not edit. -->',
             '<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
             '<title>Open Source Notices — HALO PACS</title><link rel="stylesheet" href="legal.css">',
             '<style>th { white-space: nowrap; }</style></head>',
             '<body><a class="skip" href="#content">본문으로 이동</a><div class="page"><main id="content">',
             '<h1>Open Source Notices</h1>',
             '<p>저장소에 선언된 구성요소와 개발·시험용 이미지도 함께 표시합니다. 실행 중인 설치본의 실측 목록은 아닙니다. '
             '확인되지 않은 이미지 내부 패키지와 requirements 간접 의존성은 미확보 행으로 표시합니다.</p>',
             '<p>원문 미확보 항목은 고지 준비 실패로 집계합니다. 목록 생성이나 재현성 검사의 성공이 배포 의무의 완료를 뜻하지 않습니다.</p>',
             '<p><a href="licenses/components.json">Component inventory (JSON)</a></p>',
             '<nav aria-label="Sections">' + ' · '.join('<a href="#' + s.lower() + '">' + s + '</a>' for s in SECTIONS) + '</nav>',
             '<p>전체 ' + str(len(document['components'])) + '개 중 원문 미확보 ' +
             str(sum(bool(r['missing']) for r in document['components'])) + '개입니다.</p>']
    for section in SECTIONS:
        rows = [r for r in document['components'] if r['section'] == section]
        lines += [f'<h2 id="{section.lower()}">{section}</h2>', '<div class="table-scroll" tabindex="0" role="region" aria-label="' + section + '">',
                  f'<table><caption>{section}: {len(rows)}</caption><thead><tr>' +
                  ''.join('<th scope="col">' + h + '</th>' for h in ('Component', 'Version', 'License', 'Supplier', 'Input', 'Originals', 'Source')) + '</tr></thead><tbody>']
        for row in rows:
            originals = '<br>'.join('<a href="licenses/' + e(f['path']) + '">' + e(f['name']) + '</a>' for f in row['originals'])
            if row['notes']:
                originals += '<br>' + '<br>'.join(e(note) for note in row['notes'])
            if row['missing']:
                originals += '<br>' + MISSING + ': ' + e('; '.join(row['missing']))
            source = row.get('upstream_source') or row['source']
            source = source.removeprefix('git+').removesuffix('.git')
            if source.startswith('git://'):
                source = 'https://' + source[6:]
            source_html = ('<a href="' + e(source) + '">' + e(row.get('source_tag') or 'Source') + '</a>'
                           if source.startswith(('https://', 'http://')) else e(source or 'Unverified'))
            lines.append('<tr>' + ''.join('<td>' + e(row[k]) + '</td>' for k in ('name', 'version', 'license', 'supplier', 'origin')) +
                         '<td>' + originals + '</td><td>' + source_html + '</td></tr>')
        lines += ['</tbody></table></div>']
    lines += ['<h2>Source Offer</h2>']
    if document['source_offer'] == 'link':
        lines.append('<p>기본 소스 제공 방식은 공개 저장소 링크입니다. 위 Orthanc 항목은 고정 이미지의 빌드 목록에 기록된 정확한 upstream 태그를 연결합니다.</p>')
        lines.append('<p>GPLv3/AGPLv3 §6(d)에 따라 외부 서버 링크를 사용해도 필요한 기간 동안 소스 접근을 유지할 책임은 배포자에게 있습니다. '
                     '링크 제공이 중단되면 대응 소스 미러 또는 유효한 서면 제공 방식으로 보완하며, 서면 방식은 사용 전에 제공 기간·연락처·비용을 설정해야 합니다.</p>')
    else:
        lines.append('<p>서면 제공 문안: 배포받은 GPL/AGPL 구성요소의 해당 버전 전체 대응 소스를 요청에 따라 제공합니다. '
                     '제공 기간·비용·연락처 및 빌드 자료를 배포 전에 확정해야 하며, 이 미확정 문안 자체를 유효한 서면 제공 약정으로 사용하지 않습니다.</p>')
    m = document['modification']
    lines += ['<p>' + e(m['statement'] + ' — ' + m['scope']) + '</p>',
              '<p>검색 대상 확장자: ' + e(', '.join(m['checked_extensions'])) + '; 발견 파일: ' + e(', '.join(m['source_files'] + m['patches']) or '없음') + '</p>',
              '<h2>Completeness</h2>', '<p>' + ('확보된 원문을 목록에 묶었습니다.' if document['complete'] else '원문 미확보 또는 수정 확인이 남아 있어 완료로 판정하지 않습니다.') + '</p>',
              '</main></div></body></html>']
    return ('\n'.join(lines) + '\n').encode('utf-8')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--require-complete', action='store_true')
    parser.add_argument('--source-offer', choices=('link', 'written'), default='link')
    args = parser.parse_args(argv)
    data = collect(args.root, source_offer=args.source_offer)
    outputs = {LEGAL / 'licenses/components.json': json_bytes(data), LEGAL / 'open-source-notices.html': render(data)}
    stale = []
    for relative, body in outputs.items():
        path = args.root / relative
        if args.check:
            if not path.is_file() or path.read_bytes().replace(b'\r\n', b'\n') != body:
                stale.append(relative.as_posix())
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
    missing = sum(bool(r['missing']) for r in data['components'])
    print(json.dumps(dict(counts=data['counts'], missing_originals=missing, complete=data['complete'], stale=stale), ensure_ascii=False))
    return 1 if stale or (args.require_complete and not data['complete']) else 0


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    raise SystemExit(main())
