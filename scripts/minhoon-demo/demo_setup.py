#!/usr/bin/env python3
"""Laptop side of the synthetic remote demo (D1872). Called step by step by deploy.ps1; synthetic data only.

  prepare    secrets + realm for the public origin; passwords go ONLY to <evidence>/credentials.json
  inventory  public CT (TCIA TCGA-KIRC) + MG DBT/2D (TCIA EA1141) + XA cine (GDCMData) rows, one inventory
  stage      which originals the VM sample cache lacks, and the inventory rewritten to that cache; deploy.ps1 ships
             the missing files and runs the checkout's mgxa_acceptance.py load next to the EMPTY demo Orthanc
  bind       bind the read-back study UIDs to kin-center and provision synthetic signing keys
  seed       synthetic prior reports approved through the real BFF/API by the seeding reader account

The VM is reached only through ssh to vm-run's own run directory (scripts/minhoon-demo/vm/ctl.sh); no docker
object is created outside the vm-run stack.
"""
import argparse
import json
from pathlib import Path
import secrets
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import mgxa_acceptance  # noqa: E402  (reused loader: empty-target check, upload, SHA-256 read-back, receipts)

EVIDENCE_KEY = 'C:/Users/norne/PACS/kin-key.pem'
KNOWN_HOSTS = 'C:/Users/norne/PACS/tmp/astra-control/evidence/interim-release-prep-20261012/rehearsal-known_hosts'
VM = 'ubuntu@210.109.80.52'
INSTITUTION = 'kin-center'
ACCOUNTS = {
    # role key -> (username, realm roles, display first/last). Usernames must start with kin-test-: the synthetic
    # signing fixture tests/emr/d/provision_synthetic.cjs only provisions owned synthetic members.
    'reader': ('kin-test-minhoon', ['radiologist'], 'Minhoon', 'Reader (demo)'),
    'clinician': ('kin-test-clinician', ['clinician'], 'Clinician', 'Viewer (demo)'),
    'seed': ('kin-test-prior-reader', ['radiologist'], 'Prior', 'Reader (synthetic)'),
}
# Public samples (manifests under tmp/dicom-samples keep the citations/licences). Current first, prior second.
CT_STUDIES = {
    'TCGA-CW-5580': ['tcia-20261004/studies/TCGA-KIRC/TCGA-CW-5580/1992-06-01-5683806674',
                     'tcia-20261004/studies/TCGA-KIRC/TCGA-CW-5580/1992-02-25-9858725517'],
    'TCGA-B8-A54F': ['tcia-20261004/studies/TCGA-KIRC/TCGA-B8-A54F/2006-01-12-2809330707',
                     'tcia-20261004/studies/TCGA-KIRC/TCGA-B8-A54F/2005-08-03-8034510943'],
}
MG_PATIENT = 'EA1141-4339969'
MG_SETS = ['tcia-ea1141-dbt-20261009']
XA_SET = 'xa-cine-20261024'
XA_SOP = '999.999.1.19941016.083000.5.104'
SEED_TEXT = {
    'findings': '[합성 시연용 판독문] 실제 판독이 아니며 시연 화면 확인을 위해 작성한 문장입니다.\n'
                '이전 검사 판독문이 Related Report에 표시되는지 확인하는 용도입니다.',
    'conclusion': '시연용 이전 판독 — 임상 판단에 사용하지 마십시오.',
    'recommendation': '',
}


def ssh_opts():
    return ['-i', EVIDENCE_KEY, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'UserKnownHostsFile=' + KNOWN_HOSTS]


def ctl(name, *args, stdin=None, timeout=300):
    cmd = ['ssh', *ssh_opts(), VM, 'bash', f'/srv/kin-heavy/runs/{name}/demo/ctl.sh', name, *args]
    done = subprocess.run(cmd, input=stdin, capture_output=True, text=True, encoding='utf-8', timeout=timeout)
    if done.returncode:
        raise RuntimeError(f'ctl {args[0]} exit={done.returncode}: {done.stderr.strip()[-2000:]}')
    return done.stdout


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


# ---------------------------------------------------------------- prepare
def prepare(args):
    evidence, stage = Path(args.evidence), Path(args.stage)
    stage.mkdir(parents=True, exist_ok=False)
    infra = {key: secrets.token_hex(32) for key in (
        'POSTGRES_PASSWORD', 'ORTHANC_PASS', 'KC_ADMIN_PASSWORD', 'KC_CLIENT_SECRET',
        'KC_WEB_SECRET', 'KIN_COOKIE_SECRET', 'KIN_EMR_RUNTIME_PASSWORD')}
    # Readable test passwords (typed by a doctor on a Korean keyboard): ASCII letters/digits only.
    passwords = {role: 'Demo-' + secrets.token_urlsafe(9).replace('-', 'x').replace('_', 'y') for role in ACCOUNTS}
    origin = args.origin.rstrip('/')
    credentials = {
        'purpose': 'D1872 synthetic remote demo; test passwords for synthetic accounts only. Send separately.',
        'origin': origin, 'run_name': args.name, 'sha': args.sha,
        'accounts': {role: {'username': ACCOUNTS[role][0], 'password': passwords[role],
                            'roles': ACCOUNTS[role][1], 'institution': INSTITUTION} for role in ACCOUNTS},
        'infrastructure': infra,
    }
    path = evidence / 'credentials.json'
    with path.open('x', encoding='utf-8') as stream:
        json.dump(credentials, stream, ensure_ascii=False, indent=2)
    env = {**infra, 'PUBLIC_PORT': '443', 'PUBLIC_ORIGIN': origin}
    (stage / 'stack.env').write_text(''.join(f'{k}={v}\n' for k, v in env.items()), encoding='utf-8', newline='\n')
    realm = json.loads(Path(args.realm_source).read_text(encoding='utf-8'))
    # Same reduction as scripts/mgxa_fixture.py: no shipped people, only the service account and our synthetic members.
    realm['users'] = [u for u in realm['users'] if u.get('serviceAccountClientId')]
    for role, (username, roles, first, last) in ACCOUNTS.items():
        realm['users'].append({'username': username, 'email': username + '@example.invalid',
            'firstName': first, 'lastName': last, 'enabled': True, 'emailVerified': True,
            'realmRoles': roles, 'groups': ['/' + INSTITUTION],
            'credentials': [{'type': 'password', 'value': passwords[role], 'temporary': False}]})
    for client in realm['clients']:
        if client['clientId'] == 'kin-bff':
            client['redirectUris'] = [origin + '/api/auth/callback']
        if client['clientId'] == 'kin-web':
            client.update(rootUrl=origin, redirectUris=[origin + '/*'], webOrigins=[origin])
    (stage / 'realm.json').write_text(json.dumps(realm, ensure_ascii=False), encoding='utf-8', newline='\n')
    print(json.dumps({'credentials': str(path), 'stage': str(stage),
                      'accounts': {r: a[0] for r, a in ACCOUNTS.items()}}))


# ---------------------------------------------------------------- inventory
def ct_rows(root):
    """Inventory rows for the selected CT studies in mgxa_acceptance's row shape (it scans MG/XA/RF only)."""
    import pydicom
    manifest_path = root / 'tcia-20261004' / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    registered = {(root / 'tcia-20261004' / s['folder']).resolve(): s for s in manifest['studies'] if s.get('folder')}
    rows = []
    for folders in CT_STUDIES.values():
        for folder in folders:
            study_dir = (root / folder).resolve()
            source = registered.get(study_dir)
            if not source:
                raise ValueError('CT folder not registered in the TCIA manifest: ' + folder)
            for path in sorted(study_dir.rglob('*.dcm')):
                ds = pydicom.dcmread(path, stop_before_pixels=True)
                rows.append({'path': path.relative_to(root).as_posix(), 'bytes': path.stat().st_size,
                    'sha256': mgxa_acceptance.digest(path), 'set': 'tcia-20261004',
                    'collection': source.get('collection'), 'source': source.get('source'),
                    'citations': source.get('required_citations', []), 'quarantined': False,
                    'registered_public_tcia': source.get('source') == 'TCIA',
                    'registered_public_sample': source.get('source') == 'TCIA',
                    'licence': (source.get('licenses') or [{}])[0].get('name'),
                    'modality': str(ds.get('Modality', '')), 'patient': str(ds.get('PatientID', '')),
                    'study': str(ds.StudyInstanceUID), 'date': str(ds.get('StudyDate', '')),
                    'series': str(ds.SeriesInstanceUID), 'sop': str(ds.SOPInstanceUID),
                    'sop_class': str(ds.SOPClassUID), 'transfer_syntax': str(ds.file_meta.TransferSyntaxUID),
                    'frames': int(ds.get('NumberOfFrames', 1)), 'rows': int(ds.get('Rows', 0)),
                    'columns': int(ds.get('Columns', 0)), 'attributes': {},
                    **mgxa_acceptance.local_use_policy(manifest, source)})
    return rows, {'path': str(manifest_path), 'sha256': mgxa_acceptance.digest(manifest_path),
                  'scope': manifest.get('scope', manifest.get('purpose'))}


def inventory(args):
    root = Path(args.samples).resolve()
    sets = MG_SETS + ([] if args.skip_xa else [XA_SET])
    body = mgxa_acceptance.inventory(root, sets)
    keep = [r for r in body['files'] if (r['modality'] == 'MG' and r['patient'] == MG_PATIENT)
            or (r['modality'] == 'XA' and r['sop'] == XA_SOP)]
    ct, ct_source = ct_rows(root)
    body['files'] = keep + ct
    body['sources'].append(ct_source)
    body['scope'] = 'D1872 demo selection: ' + ', '.join(CT_STUDIES) + ', ' + MG_PATIENT + ('' if args.skip_xa else ', XA ' + XA_SOP)
    studies = sorted({r['study'] for r in body['files']})
    body['demo'] = {
        'ct_current_prior': {p: [str(sorted({r['study'] for r in ct if r['path'].startswith(f)})[0]) for f in fs]
                             for p, fs in CT_STUDIES.items()},
        'mg_studies_by_date': sorted({(r['date'], r['study']) for r in keep if r['modality'] == 'MG'}, reverse=True),
        'xa_study': sorted({r['study'] for r in keep if r['modality'] == 'XA'}),
        'studies': studies,
        'use_policy_flags': sorted({(r['set'], r['local_only']) for r in body['files']}),
    }
    Path(args.output).write_text(json.dumps(body, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    by = {}
    for r in body['files']:
        by.setdefault(r['modality'], [0, 0])
        by[r['modality']][0] += 1
        by[r['modality']][1] += r['bytes']
    print(json.dumps({'studies': len(studies), 'by_modality': by, 'parse_errors': len(body['parse_errors'])}))
    return int(bool(body['parse_errors']))


# ---------------------------------------------------------------- stage + bind
VM_CACHE = '/srv/kin-heavy/demo-samples'


def stage(args):
    """Files the VM sample cache lacks (by path and size) and the inventory rewritten to the cache root.

    Sizes only pick what to ship; the VM loader re-hashes every selected original against the inventory before upload.
    """
    body = json.loads(Path(args.inventory).read_text(encoding='utf-8'))
    have = dict(line.split('\t', 1) for line in Path(args.listing).read_text(encoding='utf-8').splitlines() if '\t' in line)
    need = [r['path'] for r in body['files'] if have.get(r['path']) != str(r['bytes'])]
    Path(args.need).write_text(''.join(p + '\n' for p in need), encoding='utf-8', newline='\n')
    body['laptop_root'] = body['root']
    body['root'] = VM_CACHE
    Path(args.output).write_text(json.dumps(body, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps({'files': len(body['files']), 'cached': len(body['files']) - len(need), 'to_ship': len(need),
                      'to_ship_bytes': sum(r['bytes'] for r in body['files'] if r['path'] in set(need))}))


def bind(args):
    body = json.loads(Path(args.inventory).read_text(encoding='utf-8'))
    loaded = json.loads(Path(args.load_result).read_text(encoding='utf-8'))
    started = time.monotonic()
    if loaded.get('status') != 'LOADED_ORIGINALS_ONLY' or not all(u['original_readback'] == 'PASS' for u in loaded['uploads']):
        raise RuntimeError('VM load is incomplete: ' + str(loaded.get('status')) + ' ' + str(loaded.get('error')))
    studies = sorted({u['source']['study'] for u in loaded['uploads']})
    if studies != body['demo']['studies'] or len(loaded['uploads']) != len(body['files']):
        raise RuntimeError('Read-back studies/objects differ from the selection')
    # Same binding as scripts/mgxa_fixture.py: only read-back UIDs, in the demo's own database. ss defaults to Verified.
    sql = 'INSERT INTO "StudyState" (uid,"institutionId","updatedAt") VALUES ' + ','.join(
        "('%s','%s',NOW())" % (uid.replace("'", "''"), INSTITUTION) for uid in studies) + \
        ' ON CONFLICT (uid) DO UPDATE SET "institutionId"=EXCLUDED."institutionId";\n' \
        'SELECT uid, "institutionId", ss, rs FROM "StudyState" ORDER BY uid;\n'
    bound = ctl(args.name, 'sql', stdin=sql)
    keys = {role: ctl(args.name, 'provision', ACCOUNTS[role][0]).strip() for role in ACCOUNTS}
    summary = {'uploaded_objects': len(loaded['uploads']), 'bytes': sum(u['source']['bytes'] for u in loaded['uploads']),
               'readback_pass': sum(u['original_readback'] == 'PASS' for u in loaded['uploads']),
               'studies': studies, 'bound': bound, 'signing_keys': keys,
               'seconds': round(time.monotonic() - started, 1), 'use_limits': loaded['use_limits']}
    write_json(Path(args.output), summary)
    print(json.dumps({k: v for k, v in summary.items() if k not in ('bound', 'studies')}, ensure_ascii=False))


# ---------------------------------------------------------------- seed (also used by demo_verify.py)
def login(context, origin, username, password, timeout_ms):
    page = context.new_page()
    page.set_default_timeout(timeout_ms)
    page.goto(origin + '/')
    page.locator('#username').fill(username)
    page.locator('#password').fill(password)
    page.locator('#kc-login').click()
    page.wait_for_url('**/worklist/hpacs-lite/*.html*')
    page.wait_for_load_state('networkidle')
    return page


API_CALL = """async ({method, path, body}) => {
  const me = await (await fetch('/api/me', {credentials: 'same-origin'})).json();
  const headers = {'X-KIN-Session': me.sessionId, 'X-KIN-CSRF': '1'};
  if (body !== null) headers['Content-Type'] = 'application/json';
  const r = await fetch('/api' + path, {method, headers, credentials: 'same-origin',
    body: body === null ? undefined : JSON.stringify(body)});
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return {status: r.status, json, text: json ? null : text.slice(0, 2000)};
}"""


def api(page, method, path, body=None):
    return page.evaluate(API_CALL, {'method': method, 'path': path, 'body': body})


def seed(args):
    from playwright.sync_api import sync_playwright
    credentials = json.loads(Path(args.credentials).read_text(encoding='utf-8'))
    body = json.loads(Path(args.inventory).read_text(encoding='utf-8'))
    priors = [pair[1] for pair in body['demo']['ct_current_prior'].values()]
    mg = body['demo']['mg_studies_by_date']
    if len(mg) > 1:
        priors.append(mg[-1][1])
    seed_account = credentials['accounts']['seed']
    results = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            context = browser.new_context(ignore_https_errors=True)
            page = login(context, credentials['origin'], seed_account['username'], seed_account['password'], args.timeout * 1000)
            for uid in priors:
                draft = api(page, 'GET', f'/studies/{uid}/draft')
                if draft['status'] != 200:
                    results.append({'uid': uid, 'step': 'draft', **draft})
                    continue
                commit = api(page, 'POST', f'/studies/{uid}/report/commit', {
                    'action': 'approve', 'baseVersion': 0, **SEED_TEXT,
                    'expectedOwner': draft['json']['owner'], 'expectedRevision': draft['json']['revision']})
                results.append({'uid': uid, 'step': 'approve', 'status': commit['status'],
                                'rs': ((commit['json'] or {}).get('state') or {}).get('rs'),
                                'error': None if commit['status'] < 300 else (commit['json'] or commit['text'])})
        finally:
            browser.close()
    write_json(Path(args.output), {'seeded_by': seed_account['username'], 'text': SEED_TEXT, 'results': results})
    ok = all(r.get('step') == 'approve' and r['status'] < 300 for r in results)
    print(json.dumps({'priors': len(priors), 'approved': sum(r.get('status', 999) < 300 for r in results), 'ok': ok}))
    return 0 if ok else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='action', required=True)
    p = sub.add_parser('prepare')
    p.add_argument('--evidence', required=True)
    p.add_argument('--stage', required=True)
    p.add_argument('--origin', required=True)
    p.add_argument('--realm-source', required=True, help="The deployed SHA's keycloak/kin-realm.json")
    p.add_argument('--name', required=True)
    p.add_argument('--sha', required=True)
    i = sub.add_parser('inventory')
    i.add_argument('--samples', required=True)
    i.add_argument('--output', required=True)
    i.add_argument('--skip-xa', action='store_true')
    g = sub.add_parser('stage')
    g.add_argument('--inventory', required=True)
    g.add_argument('--listing', required=True, help='ctl.sh cache-list output')
    g.add_argument('--need', required=True)
    g.add_argument('--output', required=True, help='Inventory rewritten to the VM cache root')
    b = sub.add_parser('bind')
    b.add_argument('--name', required=True)
    b.add_argument('--inventory', required=True)
    b.add_argument('--load-result', required=True)
    b.add_argument('--output', required=True)
    s = sub.add_parser('seed')
    s.add_argument('--credentials', required=True)
    s.add_argument('--inventory', required=True)
    s.add_argument('--timeout', type=float, required=True)
    s.add_argument('--output', required=True)
    args = parser.parse_args()
    return {'prepare': prepare, 'inventory': inventory, 'stage': stage, 'bind': bind, 'seed': seed}[args.action](args) or 0


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    raise SystemExit(main())
