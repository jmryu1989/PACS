#!/usr/bin/env python3
"""Create a fresh local public-sample fixture, then import, bind and log in.

Run under the host's exclusive heavy slot. Secrets stay in the selected local tmp
directory; retain failed runs and volumes for inspection. This never uses .env.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time

import requests
import yaml
from playwright.sync_api import sync_playwright

from mgxa_acceptance import ROOT, load_samples, provenance, write_json
from mgxa_viewer_check import verify_proxy


def fixture_compose(directory, project, image, https_port, orthanc_port):
    compose = yaml.safe_load((ROOT/'docker-compose.yml').read_text(encoding='utf-8'))
    for name, service in compose['services'].items():
        service.pop('container_name', None)
        service['restart'] = 'no'
        if 'build' in service:
            if name in ('api', 'api-migrate'):
                service.pop('build')
                service['image'] = image
            else:
                service['build'] = (ROOT/service['build']).as_posix()
        service['ports'] = {'proxy': [f'127.0.0.1:{https_port}:443'],
                            'orthanc': [f'127.0.0.1:{orthanc_port}:8042']}.get(name, [])
        mounts = []
        for mount in service.get('volumes', []):
            if mount.startswith('./'):
                source, target, *flags = mount.split(':')
                if name in ('api', 'api-migrate'):
                    continue
                source = directory/'realm.json' if source == './keycloak/kin-realm.json' else ROOT/source
                mounts.append({'type': 'bind', 'source': source.resolve().as_posix(),
                               'target': target, 'read_only': True})
            else:
                mounts.append(mount)
        service['volumes'] = mounts
    # No external or explicitly named volume can inherit original storage.
    compose['volumes'] = {name: {} for name in compose.get('volumes', {})}
    compose['name'] = project
    return compose


def command(directory, project):
    return ['docker', 'compose', '--env-file', str(directory/'stack.env'),
            '-p', project, '-f', str(directory/'compose.yml')]


def fixture_realm(origin, password):
    realm = json.loads((ROOT/'keycloak/kin-realm.json').read_text(encoding='utf-8'))
    realm['users'] = [u for u in realm['users'] if u.get('serviceAccountClientId')]
    realm['users'].append({'username': 'mgxa-doctor', 'email': 'mgxa-doctor@example.invalid',
        'firstName': 'Synthetic', 'lastName': 'MGXA', 'enabled': True, 'emailVerified': True,
        'realmRoles': ['radiologist'], 'groups': ['/kin-center'],
        'credentials': [{'type': 'password', 'value': password, 'temporary': False}]})
    for client in realm['clients']:
        if client['clientId'] == 'kin-bff':
            client['redirectUris'] = [origin+'/api/auth/callback']
        if client['clientId'] == 'kin-web':
            client.update(rootUrl=origin, redirectUris=[origin+'/*'], webOrigins=[origin])
    return realm


def run(cmd, timeout, **kwargs):
    return subprocess.run(cmd, timeout=timeout, check=True, **kwargs)


def setup(args, directory):
    project = args.project
    if not project.startswith('mgxa-'):
        raise ValueError('Use an owned mgxa- synthetic project name')
    for resource in ('container', 'volume', 'network'):
        existing = subprocess.check_output(['docker', resource, 'ls', '-q', '--filter',
            'label=com.docker.compose.project='+project], text=True, timeout=args.timeout).strip()
        if existing:
            raise ValueError('Use a fresh project; existing synthetic resources are retained')
    directory.mkdir(parents=True, exist_ok=False)
    facts = provenance(__file__, ROOT/'scripts/mgxa_acceptance.py', ROOT/'scripts/mgxa_viewer_check.py')
    image = project+':'+facts['head_sha']
    credentials = {key: secrets.token_hex(32) for key in (
        'POSTGRES_PASSWORD', 'ORTHANC_PASS', 'KC_ADMIN_PASSWORD', 'KC_CLIENT_SECRET',
        'KC_WEB_SECRET', 'KIN_COOKIE_SECRET', 'KIN_EMR_RUNTIME_PASSWORD', 'DOCTOR_PASSWORD')}
    origin = f'https://localhost:{args.https_port}'
    credentials.update(PUBLIC_PORT=str(args.https_port), PUBLIC_ORIGIN=origin)
    write_json(directory/'credentials.json', credentials)
    (directory/'stack.env').write_text('\n'.join(k+'='+v for k,v in credentials.items())+'\n', encoding='utf-8')
    write_json(directory/'realm.json', fixture_realm(origin, credentials['DOCTOR_PASSWORD']))
    (directory/'compose.yml').write_text(yaml.safe_dump(
        fixture_compose(directory, project, image, args.https_port, args.orthanc_port), sort_keys=False), encoding='utf-8')
    write_json(directory/'fixture.json', {**facts, 'project': project, 'origin': origin,
        'orthanc': f'http://localhost:{args.orthanc_port}', 'image': image, 'status': 'PREPARING'})
    # Compose interpolation must use these generated values, even if the shell
    # contains variables from a different developer stack.
    env = {**os.environ, **credentials}
    run(['docker', 'build', '--target', 'production', '--build-arg', 'VCS_REF='+facts['head_sha'],
         '-t', image, str(ROOT/'api')], args.timeout)
    cmd = command(directory, project)
    run(cmd+['up', '-d', '--wait', 'db'], args.timeout, env=env)
    run(cmd+['exec', '-T', 'db', 'createdb', '-U', 'kin', 'keycloak'], args.timeout, env=env)
    run(cmd+['up', '-d', '--build'], args.timeout, env=env)
    session = requests.Session()
    session.trust_env = False
    requests.packages.urllib3.disable_warnings()
    deadline = time.monotonic()+args.request_timeout
    while True:
        try:
            response = session.get(origin+'/api/health', verify=False, timeout=args.request_timeout)
            if response.ok and response.json().get('memberRights') == 'ready':
                break
        except requests.RequestException:
            pass
        if time.monotonic() >= deadline:
            raise TimeoutError('Synthetic HTTPS/memberRights readiness')
        time.sleep(1)
    run(cmd+['ps'], args.timeout, env=env)
    facts.update(project=project, origin=origin, orthanc=f'http://localhost:{args.orthanc_port}',
                 image=image, status='READY')
    (directory/'fixture.json').write_text(json.dumps(facts, indent=2)+'\n', encoding='utf-8')
    print('Synthetic HTTPS ready; public originals not loaded')


def load_and_login(args, directory):
    fixture = json.loads((directory/'fixture.json').read_text(encoding='utf-8'))
    if fixture['status'] != 'READY':
        raise ValueError('Synthetic setup is incomplete')
    credentials = json.loads((directory/'credentials.json').read_text(encoding='utf-8'))
    os.environ.update(MGXA_ORTHANC_USER='admin', MGXA_ORTHANC_PASSWORD=credentials['ORTHANC_PASS'])
    args.synthetic_project, args.orthanc = fixture['project'], fixture['orthanc']
    load_samples(args)
    loaded = json.loads(Path(args.output).read_text(encoding='utf-8'))
    studies = sorted({r['source']['study'] for r in loaded['uploads']})
    cmd = command(directory, fixture['project'])
    # Only UIDs read back by the loader are bound in the freshly owned database.
    sql = 'INSERT INTO "StudyState" (uid,"institutionId","updatedAt") VALUES '+','.join(
        "('%s','kin-center',NOW())" % uid.replace("'", "''") for uid in studies)+ \
        ' ON CONFLICT (uid) DO UPDATE SET "institutionId"=EXCLUDED."institutionId";'
    run(cmd+['exec', '-T', 'db', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'kin', '-d', 'kin'],
        args.timeout, input=sql, text=True, env={**os.environ, **credentials})
    verify_proxy(fixture['project'], fixture['origin'], args.timeout)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=['--enable-unsafe-swiftshader'])
        try:
            context = browser.new_context(ignore_https_errors=True)
            page = context.new_page()
            page.set_default_timeout(args.browser_timeout*1000)
            page.goto(fixture['origin']+'/')
            try:
                page.locator('#username').fill('mgxa-doctor')
                page.locator('#password').fill(credentials['DOCTOR_PASSWORD'])
                # Submit with the normal keyboard path: desktop Chromium can
                # stall its click-stability wait on this static login page.
                page.locator('#password').press('Enter')
            except Exception:
                raise RuntimeError('Synthetic doctor login form failed (credential omitted)') from None
            page.wait_for_url('**/worklist/hpacs-lite/main.html')
            context.storage_state(path=str(directory/'storage-state.json'))
        finally:
            browser.close()
    write_json(directory/'binding-login.json', {**provenance(__file__), 'studies': studies,
        'institution': 'kin-center', 'normal_bff_login': 'PASS', 'product_acceptance': 'NOT_RUN'})
    print('Public originals bound; synthetic doctor storage state created')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    setup_parser = sub.add_parser('setup')
    load_parser = sub.add_parser('load-login')
    for child in (setup_parser, load_parser):
        child.add_argument('--directory', required=True, help='New local directory under this checkout tmp/')
        child.add_argument('--timeout', required=True, type=float, help='Command hang timeout from host measurements')
    setup_parser.add_argument('--project', required=True)
    setup_parser.add_argument('--https-port', required=True, type=int)
    setup_parser.add_argument('--orthanc-port', required=True, type=int)
    setup_parser.add_argument('--request-timeout', required=True, type=float)
    load_parser.add_argument('--inventory', required=True)
    load_parser.add_argument('--study', required=True, action='append')
    load_parser.add_argument('--sop', action='append')
    load_parser.add_argument('--output', required=True)
    load_parser.add_argument('--browser-timeout', required=True, type=float)
    args = parser.parse_args()
    directory = Path(args.directory).resolve()
    if not directory.is_relative_to(ROOT/'tmp'):
        raise ValueError('Keep synthetic credentials/storage state under local checkout tmp/')
    if args.action == 'setup':
        setup(args, directory)
    else:
        load_and_login(args, directory)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    main()
