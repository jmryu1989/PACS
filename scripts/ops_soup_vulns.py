#!/usr/bin/env python3
"""Query OSV for CD-02 components and append one monitoring run to JSONL.

--timeout is one overall query deadline in seconds, solely to stop stalled work.
Run a single writer per output file. Scheduling and impact adjudication are external.
Notifications use ops_notify's existing GH_TOKEN/GITHUB_REPOSITORY/KIN_RUN_URL.
"""
import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import sys
import time
from urllib.request import Request, build_opener

import ops_notify

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_COMPONENTS = ROOT / 'worklist-v0/legal/licenses/components.json'
OSV_QUERY = 'https://api.osv.dev/v1/query'
urlopen = build_opener(ops_notify.NoRedirect()).open


def package_query(row):
    # CD-02 records the lock/requirements origin, not an ecosystem field. Do not
    # guess an image's OS packages or use a bundle tag as an application version.
    origin = row.get('origin', '')
    if re.fullmatch(r'(?:api|gateway/.+)/package-lock\.json:node_modules/.+', origin):
        ecosystem = 'npm'
        exact = r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?'
    elif re.fullmatch(r'gateway/.*/requirements[^/]*\.txt', origin):
        ecosystem = 'PyPI'
        exact = r'(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[a-zA-Z0-9.]+)?'
    else:
        return None, '미조회: 패키지 생태계·이름의 근거가 없음(이미지 내부 패키지는 개별 목록 필요)'
    if not re.fullmatch(exact, row['version']):
        return None, '미조회: 정확한 패키지 버전이 아님'
    return {'package': {'ecosystem': ecosystem, 'name': row['name']}, 'version': row['version']}, None


def post_osv(payload, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('Query deadline exceeded')
    request = Request(OSV_QUERY, data=json.dumps(payload).encode('utf-8'),
                      headers={'Content-Type': 'application/json'}, method='POST')
    with urlopen(request, timeout=remaining) as response:
        return json.load(response)


def query_component(payload, deadline):
    findings, pages = {}, set()
    while True:
        data = post_osv(payload, deadline)
        if not isinstance(data, dict) or 'error' in data or 'code' in data:
            raise ValueError('Invalid OSV response')
        vulnerabilities = data.get('vulns', [])
        if not isinstance(vulnerabilities, list):
            raise ValueError('Invalid vulnerability list')
        for vuln in vulnerabilities:
            if not isinstance(vuln, dict) or not isinstance(vuln.get('id'), str) or not vuln['id']:
                raise ValueError('Missing vulnerability identifier')
            # Preserve the provider's severity/vector without calculating a score
            # or treating an OSV version match as a product impact determination.
            severity = vuln.get('severity') or (vuln.get('database_specific') or {}).get('severity') or '미제공'
            findings[vuln['id']] = dict(identifier=vuln['id'], aliases=vuln.get('aliases', []),
                                       severity=severity, impact='미판정')
        token = data.get('next_page_token')
        if not token:
            return list(findings.values())
        if not isinstance(token, str) or token in pages:
            raise ValueError('Invalid OSV pagination')
        pages.add(token)
        payload = {**payload, 'page_token': token}


def previous_keys(path):
    keys = set()
    if not path.exists():
        return keys
    with path.open(encoding='utf-8') as stream:
        for line in stream:
            record = json.loads(line)
            if record.get('schema_version') != 1 or not isinstance(record.get('components'), list):
                raise ValueError('Invalid monitoring history')
            if (record.get('notification') or {}).get('status') == 'FAILED':
                continue
            for row in record['components']:
                for finding in row.get('findings') or []:
                    keys.add((row['component'], row['version'], finding['identifier']))
    return keys


def append_record(path, record):
    path.parent.mkdir(parents=True, exist_ok=True)
    # Even a damaged final line is retained verbatim; the failure record starts
    # on its own line. Invalid history is never silently used as an empty history.
    with path.open('a+b') as stream:
        stream.seek(0, os.SEEK_END)
        if stream.tell():
            stream.seek(-1, os.SEEK_END)
            if stream.read(1) != b'\n':
                stream.write(b'\n')
        stream.write((json.dumps(record, ensure_ascii=False) + '\n').encode('utf-8'))
        stream.flush()
        os.fsync(stream.fileno())


def send_notification(count, checked_at):
    return ops_notify.notify_soup(
        ops_notify.GitHub(os.environ['GH_TOKEN'], os.environ['GITHUB_REPOSITORY']),
        count, checked_at, os.environ['KIN_RUN_URL'])


def scan(source, out, timeout):
    now = datetime.now(timezone.utc)
    record = dict(schema_version=1, date=now.isoformat(), source='https://api.osv.dev',
                  status='COMPLETED', components=[], queried=0, unqueried=0, failed=0,
                  found=None, new_items=None, observed_findings=0, observed_new_items=0,
                  notification={'status': 'NOT_NEEDED'})
    deadline = time.monotonic() + timeout
    try:
        known = previous_keys(out)
        document = json.loads(source.read_text(encoding='utf-8'))
        rows = document['components']
        if document.get('schema_version') != 1 or not isinstance(rows, list) or not rows:
            raise ValueError('Invalid component inventory')
        for row in rows:
            if not isinstance(row, dict) or any(not isinstance(row.get(k), str) or not row[k] for k in ('name', 'version', 'origin')):
                raise ValueError('Invalid component row')
    except Exception as error:
        record.update(status='FAILED', error=type(error).__name__)
        append_record(out, record)
        return record

    observed, new = set(), set()
    for component in rows:
        row = dict(component=component['name'], version=component['version'], origin=component['origin'],
                   scope=component.get('scope'), section=component.get('section'),
                   status='NOT_QUERIED', findings=None, impact='미판정')
        record['components'].append(row)
        payload, reason = package_query(component)
        if payload is None:
            row['reason'] = reason
            record['unqueried'] += 1
            continue
        row['ecosystem'] = payload['package']['ecosystem']
        try:
            row['findings'] = query_component(payload, deadline)
            row['status'] = 'QUERIED'
            record['queried'] += 1
            for finding in row['findings']:
                key = (row['component'], row['version'], finding['identifier'])
                observed.add(key)
                if key not in known:
                    new.add(key)
        except Exception as error:
            row.update(status='FAILED', error=type(error).__name__)
            record['failed'] += 1
    record.update(observed_findings=len(observed), observed_new_items=len(new))
    if record['failed']:
        record['status'] = 'FAILED'
    else:
        record.update(found=len(observed), new_items=len(new))
    if new:
        try:
            result = send_notification(len(new), int(now.timestamp()))
            record['notification'] = dict(status='SENT', result=result)
        except Exception as error:
            record.update(status='FAILED', notification=dict(status='FAILED', error=type(error).__name__))
    append_record(out, record)
    return record


def positive_timeout(value):
    seconds = float(value)
    if not math.isfinite(seconds) or seconds <= 0:
        raise argparse.ArgumentTypeError('시간 제한은 유한한 양수여야 합니다.')
    return seconds


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--components', type=Path, default=DEFAULT_COMPONENTS)
    parser.add_argument('--out', type=Path, required=True, help='추가 전용 JSONL 경로')
    parser.add_argument('--timeout', type=positive_timeout, required=True, help='전체 OSV 조회 멈춤 방지 제한(초)')
    args = parser.parse_args(argv)
    try:
        if args.components.resolve() == args.out.resolve():
            raise ValueError('Inventory and history must be separate')
        record = scan(args.components, args.out, args.timeout)
        print(json.dumps({key: value for key, value in record.items() if key != 'components'}, ensure_ascii=False))
        return 0 if record['status'] == 'COMPLETED' else 1
    except Exception as error:
        # A storage failure cannot be recorded to the failed storage itself.
        print(json.dumps(dict(status='FAILED', error=type(error).__name__)))
        return 1


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.exit(main())
