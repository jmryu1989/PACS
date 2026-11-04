#!/usr/bin/env python3
"""Build the Product Information outputs from config/product-info.json, without network.

One source feeds both sides: the pages embed worklist-v0/hpacs-lite/product-info-data.js (so the facts open after
the network is gone) and the API compiles api/src/product-info-data.ts (GET /api/version reports the same facts
digest and product version, so a page served from another build shows Mismatch instead of a quiet agreement).

Both outputs also carry staticDigest, the digest of the files served under /worklist/ (the checkout's worklist-v0).
Those files are not in any image, so this digest is their build identity: it is computed from the files themselves
and shipped beside them, and the API compiles the one of its own build, so static files of build A beside an API of
build B read Mismatch even when the product facts agree. Any change under worklist-v0 therefore needs this
generator run again; --check fails until it is.

  python scripts/build-product-info.py            write both outputs
  python scripts/build-product-info.py --check    fail when an output is stale or the config breaks a rule
  python scripts/build-product-info.py build-args print KIN_REVISION / KIN_BUILD_TAG of this checkout's HEAD

The rules below refuse a config that would show a made-up number: a value only with status confirmed, a reason for
every other status, "발급 전" only for numbers that are issued (authorization, UDI-DI, UDI-PI), "해당 없음" only for
the conditional items, UDI-PI only with the confirmed product version it carries, a document only with a shipped
local file of the same product version, and no expert-use item at all (D-14: not displayed until decided).
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
CONFIG = Path('config/product-info.json')
PAGE_DATA = Path('worklist-v0/hpacs-lite/product-info-data.js')
API_DATA = Path('api/src/product-info-data.ts')
STATIC_TREE = Path('worklist-v0')
CRLF, LF = b'\r\n', b'\n'
NOTICE_FILES = {
    'privacy': 'worklist-v0/legal/privacy.html',
    'operator': 'worklist-v0/legal/operator-notice.html',
    # CD-02's generated notice (scripts/build-open-source-notices.py); linked, never copied.
    'open-source': 'worklist-v0/legal/open-source-notices.html',
    'accessibility': 'worklist-v0/legal/accessibility.html',
}

STATUS_LABELS = {'confirmed': 'Confirmed', 'unissued': 'Unissued', 'pending': 'Pending',
                 'not_applicable': 'Not Applicable', 'undetermined': 'Undetermined'}
SECTIONS = ('Manufacturer', 'Product', 'Version', 'UDI', 'Documents', 'Support', 'AI Information')
DETAIL_LABELS = {'address': 'Address', 'contact': 'Contact', 'origin': 'Manufacturing Origin',
                 'documentVersion': 'Document Version', 'version': 'Version'}
FIELD_KEYS = {'status', 'value', 'note', 'source', *DETAIL_LABELS, 'href', 'productVersion'}

CONFIRMED = 'confirmed'
NUMBER = {'confirmed', 'unissued'}
DECIDED = {'confirmed', 'pending'}
CONDITIONAL = {'confirmed', 'not_applicable', 'undetermined'}

# (config path, section, label, basis, allowed statuses, details a confirmed value must carry)
ROWS = (
    ('manufacturer.name', 'Manufacturer', 'Manufacturer Name', '디지털의료제품법 제22조제1호', DECIDED, ()),
    ('manufacturer.address', 'Manufacturer', 'Manufacturer Address', '디지털의료제품법 제22조제1호', DECIDED, ()),
    ('importer', 'Manufacturer', 'Importer', '디지털의료제품법 제22조제2호', CONDITIONAL, ('address', 'origin')),
    ('statutoryLabel', 'Product', 'Software Designation', '디지털의료제품법 제22조제5호', {CONFIRMED}, ()),
    ('product.authorization', 'Product', 'Authorization Number', '디지털의료제품법 제22조제3호', NUMBER, ()),
    ('product.name', 'Product', 'Product Name', '디지털의료제품법 제22조제3호', DECIDED, ()),
    ('product.model', 'Product', 'Model Name', '디지털의료제품법 제22조제3호', DECIDED, ()),
    ('manufacturing.serial', 'Product', 'Serial Number', '디지털의료제품법 제22조제4호', DECIDED, ()),
    ('manufacturing.date', 'Product', 'Manufacturing Date', '디지털의료제품법 제22조제4호', DECIDED, ()),
    ('version.product', 'Version', 'Product Version', '디지털의료제품법 제22조제4호', DECIDED, ()),
    ('udi.di', 'UDI', 'UDI-DI', '디지털의료제품법 제22조제7호, 표준코드 고시 제2조', NUMBER, ()),
    ('udi.pi', 'UDI', 'UDI-PI (Software Version)', '표준코드 고시 제2조·제5조③', NUMBER, ('version',)),
    ('documents.description', 'Documents', 'Product Description', '시행규칙 제33조②1호', DECIDED, ('documentVersion',)),
    ('documents.instructions', 'Documents', 'Instructions for Use', '시행규칙 제33조②2호', DECIDED, ('documentVersion',)),
    ('support.contact', 'Support', 'Error Reporting Contact', '시행규칙 제33조②3호', DECIDED, ()),
    ('support.maintenance', 'Support', 'Maintenance Contractor', '시행규칙 제33조②4호', CONDITIONAL, ('address', 'contact')),
    ('support.endOfSupport', 'Support', 'Expected End of Support', '보안지침 제15조②', DECIDED, ()),
    ('support.afterSupport', 'Support', 'Support Plan After End of Support', '보안지침 제15조②', DECIDED, ()),
    ('ai.engine', 'AI Information', 'Speech Recognition Engine', '시행규칙 제33조②5호', DECIDED, ()),
    ('ai.model', 'AI Information', 'Speech Recognition Model', '시행규칙 제33조②5호', DECIDED, ()),
    ('ai.training', 'AI Information', 'Training Method and Data', '시행규칙 제33조②5호가목', DECIDED, ()),
    ('ai.performance', 'AI Information', 'Expected Performance and Limits', '시행규칙 제33조②5호나목', DECIDED, ()),
    ('ai.cloud', 'AI Information', 'Third-Party Cloud Service', '시행규칙 제33조②5호다목', CONDITIONAL, ()),
    ('ai.changes', 'AI Information', 'Changes Under the Change Plan', '시행규칙 제33조②5호라목', CONDITIONAL, ()),
    ('ai.notice', 'AI Information', 'AI Use Notice', 'AI 기본법 제31조①, 같은 법 시행령 제23조①', DECIDED, ()),
)
DOCUMENTS = {'documents.description', 'documents.instructions'}
YEAR_MONTH = re.compile(r'(19|20)\d\d-(0[1-9]|1[0-2])')
DATE = re.compile(r'(19|20)\d\d-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?')
TAG = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}')
DOCUMENT_HREF = re.compile(r'/worklist/[A-Za-z0-9._/-]+\.html(#[A-Za-z0-9_-]+)?')


class ConfigError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise ConfigError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f'duplicate key {key!r}')
        result[key] = value
    return result


def text_ok(value, where):
    require(isinstance(value, str) and value.strip() == value and value, f'{where}: a non-empty trimmed string')
    require(unicodedata.normalize('NFC', value) == value, f'{where}: not NFC')
    require(not any(unicodedata.category(c) in ('Cc', 'Cf', 'Zl', 'Zp') for c in value), f'{where}: control character')
    return value


def walk_strings(node, where='config'):
    if isinstance(node, dict):
        for key, value in node.items():
            require('expert' not in key.lower(), f'{where}.{key}: no expert-use item (D-14)')
            yield from walk_strings(value, f'{where}.{key}')
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from walk_strings(value, f'{where}[{index}]')
    elif isinstance(node, str):
        yield where, node


def lookup(config, path):
    node = config
    for part in path.split('.'):
        require(isinstance(node, dict) and part in node, f'{path}: missing')
        node = node[part]
    require(isinstance(node, dict), f'{path}: an object')
    return node


def build_row(config, root, spec, product_version):
    path, section, label, basis, allowed, details = spec
    field = lookup(config, path)
    require(set(field) <= FIELD_KEYS, f'{path}: unknown keys {sorted(set(field) - FIELD_KEYS)}')
    status = field.get('status')
    require(status in allowed, f'{path}: status {status!r} is not one of {sorted(allowed)}')
    note = text_ok(field.get('note'), f'{path}.note')
    row = {'id': path, 'section': section, 'label': label, 'basis': basis, 'status': status,
           'statusLabel': STATUS_LABELS[status], 'value': None, 'note': note, 'details': [], 'href': None}
    if status != CONFIRMED:
        # A placeholder never carries a value: a reader must not mistake the reason for the fact.
        require(set(field) <= {'status', 'note', 'source'}, f'{path}: only a confirmed item carries values')
        if status == 'unissued':
            require(note.startswith('발급 전'), f'{path}: an unissued number reads 발급 전')
        if status == 'not_applicable':
            require(note.startswith('해당 없음'), f'{path}: not applicable states its basis after 해당 없음')
        return row
    row['value'] = text_ok(field.get('value'), f'{path}.value')
    for key in details:
        row['details'].append({'label': DETAIL_LABELS[key], 'value': text_ok(field.get(key), f'{path}.{key}')})
    extra = set(field) - {'status', 'value', 'note', 'source', 'href', 'productVersion', *details}
    require(not extra, f'{path}: keys {sorted(extra)} do not belong to this item')
    if path == 'manufacturing.date':
        require(YEAR_MONTH.fullmatch(row['value']), f'{path}: YYYY-MM')
    if path == 'support.endOfSupport':
        require(DATE.fullmatch(row['value']), f'{path}: YYYY-MM or YYYY-MM-DD')
    if path == 'udi.pi':
        # UDI-PI of standalone software is its version: never a version the product does not have.
        require(product_version is not None, f'{path}: needs the confirmed product version it identifies')
        require(row['details'][0]['value'] == product_version, f'{path}: version differs from the product version')
    if path in DOCUMENTS:
        href = text_ok(field.get('href'), f'{path}.href')
        # One document may hold both roles as separate sections, so a fragment names the section.
        require(DOCUMENT_HREF.fullmatch(href) and '..' not in href, f'{path}.href: a same-origin /worklist/ document')
        local = root / 'worklist-v0' / href[len('/worklist/'):].split('#', 1)[0]
        require(local.is_file(), f'{path}.href: {local.relative_to(root).as_posix()} is not shipped')
        require(product_version is not None and field.get('productVersion') == product_version,
                f'{path}: the document applies to another product version')
        row['href'] = href
    else:
        require('href' not in field and 'productVersion' not in field, f'{path}: only a document links')
    return row


def build_model(config, root=ROOT):
    require(isinstance(config, dict) and config.get('schema') == 1, 'schema 1')
    for where, value in walk_strings(config):
        require('전문가용' not in value, f'{where}: no expert-use text (D-14)')
    version = lookup(config, 'version.product')
    product_version = version.get('value') if version.get('status') == CONFIRMED else None
    rows = [build_row(config, root, spec, product_version) for spec in ROWS]
    notices = config.get('notices')
    require(isinstance(notices, list) and [n.get('id') for n in notices if isinstance(n, dict)] == list(NOTICE_FILES),
            'notices: exactly privacy, operator, open-source, accessibility')
    links = []
    for notice in notices:
        require(set(notice) == {'id', 'label', 'href'}, f'notice {notice.get("id")}: id, label, href')
        expected = NOTICE_FILES[notice['id']]
        require(notice['href'] == '/worklist/' + expected[len('worklist-v0/'):], f'notice {notice["id"]}: {expected}')
        require((root / expected).is_file(), f'notice {notice["id"]}: {expected} is not shipped')
        links.append({'id': notice['id'], 'label': text_ok(notice['label'], f'notice {notice["id"]}.label'),
                      'href': notice['href']})
    model = {'schema': 1, 'sections': list(SECTIONS), 'rows': rows, 'notices': links,
             'productVersion': {'status': version['status'], 'value': product_version}}
    digest = hashlib.sha256(json.dumps(model, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
                            .encode('utf-8')).hexdigest()
    return {**model, 'factsDigest': digest}


def static_digest(root=ROOT):
    """sha256 over every file under worklist-v0 (what /worklist/ serves) except the page data that carries the result.
    Paths are relative and sorted as text, and CRLF is read as LF, so a Windows checkout and the Linux server agree."""
    base = root / STATIC_TREE
    files = {path.relative_to(base).as_posix(): path for path in base.rglob('*')
             if path.is_file() and path.relative_to(root) != PAGE_DATA}
    lines = ''.join(f'{hashlib.sha256(files[name].read_bytes().replace(CRLF, LF)).hexdigest()}  {name}\n'
                    for name in sorted(files))
    return hashlib.sha256(lines.encode('utf-8')).hexdigest()


def page_bytes(model):
    body = json.dumps(model, ensure_ascii=False, indent=1, sort_keys=True)
    return ('// Generated by scripts/build-product-info.py from config/product-info.json and worklist-v0. Do not edit.\n'
            '// Loaded with the page, so Product Information opens after the network is gone (CD-01 C07);\n'
            '// staticDigest is the digest of the files served beside this one (CD-01 C05).\n'
            'window.KinProductInfoData = ' + body + ';\n').encode('utf-8')


def api_bytes(model):
    facts = {'factsDigest': model['factsDigest'], 'productVersion': model['productVersion'],
             'staticDigest': model['staticDigest']}
    return ('// Generated by scripts/build-product-info.py from config/product-info.json and worklist-v0. Do not edit.\n'
            '// The same digests the pages embed: GET /api/version reports them so a page from another build reads Mismatch.\n'
            'export const PRODUCT_FACTS = ' + json.dumps(facts, ensure_ascii=False, indent=2, sort_keys=True)
            + ' as const;\n').encode('utf-8')


def outputs(root=ROOT, config_bytes=None):
    raw = (root / CONFIG).read_bytes() if config_bytes is None else config_bytes
    model = build_model(json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object), root)
    model = {**model, 'staticDigest': static_digest(root)}
    return model, {PAGE_DATA: page_bytes(model), API_DATA: api_bytes(model)}


def git(root, *args):
    return subprocess.run(['git', '-C', str(root), *args], check=True, capture_output=True, text=True).stdout.strip()


def build_args(root=ROOT, allow_dirty=False):
    """The exact build facts of HEAD: its SHA and the one tag that points at it (none -> empty, never a nearby tag)."""
    revision = git(root, 'rev-parse', 'HEAD')
    require(re.fullmatch(r'[0-9a-f]{40}', revision), 'HEAD is not a commit SHA')
    require(allow_dirty or not git(root, 'status', '--porcelain', '--untracked-files=no'),
            'tracked working tree is dirty: the build would not be HEAD')
    tags = [t for t in git(root, 'tag', '--points-at', 'HEAD').splitlines() if t]
    require(len(tags) <= 1, f'several tags point at HEAD: {tags}')
    require(all(TAG.fullmatch(t) for t in tags), f'tag name outside {TAG.pattern}')
    return {'KIN_REVISION': revision, 'KIN_BUILD_TAG': tags[0] if tags else ''}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', nargs='?', choices=('build', 'build-args'), default='build')
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--allow-dirty', action='store_true')
    args = parser.parse_args(argv)
    try:
        if args.command == 'build-args':
            for key, value in build_args(args.root, args.allow_dirty).items():
                print(f'{key}={value}')
            return 0
        model, files = outputs(args.root)
    except (ConfigError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        print(f'product-info: {error}', file=sys.stderr)
        return 2
    stale = []
    for relative, body in files.items():
        path = args.root / relative
        if args.check:
            if not path.is_file() or path.read_bytes().replace(b'\r\n', b'\n') != body:
                stale.append(relative.as_posix())
        else:
            path.write_bytes(body)
    counts = {label: sum(r['status'] == key for r in model['rows']) for key, label in STATUS_LABELS.items()}
    print(json.dumps({'rows': len(model['rows']), 'statuses': counts, 'notices': len(model['notices']),
                      'factsDigest': model['factsDigest'], 'staticDigest': model['staticDigest'], 'stale': stale},
                     ensure_ascii=False))
    return 1 if stale else 0


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    raise SystemExit(main())
