"""Optional, gated local authentication fixture: fresh credentials, names, network and volumes.

REQ-EMR-07 -> RISK-EMR-ORIGINAL-FIXTURE -> B2 AuthAuditLive/LogoutOrderLive.
The default hosted suites still use their existing externally provisioned stack. This fixture owns only its generated
Compose project; it refuses occupied loopback ports and never starts, stops, inspects secrets or removes another project.
"""
import json
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
import subprocess
import time
from urllib.request import urlopen

import yaml
import live_test_gate as gate
from measurement_ci import sanitize

ROOT = Path(__file__).resolve().parents[1]


def start_if_requested(case):
    if os.environ.get('KIN_TEST_OWNED_AUTH_HTTP') != '1':
        return
    gate.require_live_run()
    fixture = OwnedAuthStack()
    case.addClassCleanup(fixture.close)
    fixture.start()


class OwnedAuthStack:
    def __init__(self):
        self.project = 'kin-emrb-r9b-' + secrets.token_hex(6)
        self.out = ROOT / 'tmp/emr-b2/runs' / ('r9-http-' + self.project)
        self.out.mkdir(parents=True, exist_ok=False)
        self.values = {key: secrets.token_hex(32) for key in (
            'POSTGRES_PASSWORD', 'KIN_EMR_RUNTIME_PASSWORD', 'ORTHANC_PASS', 'KC_ADMIN_PASSWORD',
            'KC_CLIENT_SECRET', 'KC_WEB_SECRET', 'KIN_COOKIE_SECRET')}
        self.previous = {}
        self.started = False
        self.command = ['docker', 'compose', '-p', self.project]
        self.env = {**os.environ, **self.values, 'COMPOSE_PROJECT_NAME': self.project,
                    'COMPOSE_FILE': str(self.out / 'compose.yml'), 'COMPOSE_ENV_FILES': '',
                    'PUBLIC_ORIGIN': 'https://localhost:9443', 'PUBLIC_PORT': '9443',
                    'KIN_EMR_MANAGING_INSTITUTION': 'synthetic-emrb-r9', 'KIN_EMR_PROXY_HOST': 'proxy',
                    'KIN_SYNTHETIC_REALM': '1', 'KIN_TEST_PROXY': 'https://localhost:9443',
                    'KIN_TEST_API': 'https://localhost:9443/api', 'KIN_TEST_ORTHANC': 'http://127.0.0.1:8042',
                    'KIN_TEST_TOKEN_URL': 'http://127.0.0.1:8080/auth/realms/kin/protocol/openid-connect/token'}

    def run(self, name, args, timeout=600, check=True):
        result = subprocess.run(args, cwd=ROOT, env=self.env, capture_output=True, timeout=timeout)
        output = (result.stdout + result.stderr).decode('utf-8', 'replace')
        output = sanitize(output, self.values.values())
        # nginx's request line contains OIDC callback codes and state even though no response body is logged.
        output = re.sub(r'(/[^\s?"<>]*)\?[^\s"<>]*', r'\1?[REDACTED QUERY]', output)
        (self.out / (name + '.log')).write_text(output, encoding='utf-8')
        print('OWNED_AUTH_HTTP ' + name + ' exit=' + str(result.returncode), flush=True)
        if check and result.returncode:
            raise RuntimeError('Owned authentication fixture ' + name + ' failed; sanitized log: ' + str(self.out))
        return result

    def start(self):
        for port in (9443, 8080, 8042, 3000):
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', port))
        config = yaml.safe_load((ROOT / 'docker-compose.yml').read_text(encoding='utf-8'))
        for name, service in config['services'].items():
            service['container_name'] = self.project + '-' + name
            service['restart'] = 'no'
            service['labels'] = {'kin.emrb.r9.http': self.project, 'kin.emrb.live': self.project}
            if 'build' in service:
                build = service['build']
                if isinstance(build, str):
                    service['build'] = {'context': str(ROOT / build)}
                else:
                    build['context'] = str(ROOT / build['context'])
            mounts = []
            for mount in service.get('volumes', []):
                source, target = mount.split(':', 1)
                if source.startswith('.'):
                    mounts.append({'type': 'bind', 'source': str((ROOT / source).resolve()),
                                   'target': target.removesuffix(':ro'), 'read_only': target.endswith(':ro')})
                else:
                    mounts.append(mount)
            service['volumes'] = mounts
            service.pop('ports', None)
        for name, port, target in [('proxy', 9443, 443), ('keycloak', 8080, 8080), ('orthanc', 8042, 8042), ('api', 3000, 3000)]:
            config['services'][name]['ports'] = [f'127.0.0.1:{port}:{target}']
        image = os.environ['KIN_TEST_API_IMAGE']
        for name in ('api', 'api-migrate'):
            service = config['services'][name]
            service.pop('build', None)
            service['image'] = image
            service['volumes'] = ['emr-state:/var/lib/kin-emr'] if name == 'api' else []
        config['services']['api-migrate']['command'] = ['sh', '/app/start-production.sh', 'migrate']
        config['services']['api']['environment']['DEPLOYMENT_MODE'] = 'production'
        # Docker Desktop does not publish ports of an internal bridge. Use a new bridge with loopback-only published
        # ports; no existing network, volume, account or connection target is reused.
        config['networks'] = {'default': {'labels': {'kin.emrb.r9.http': self.project}}}
        config['volumes'] = {name: {'labels': {'kin.emrb.r9.http': self.project}} for name in config['volumes']}
        (self.out / 'compose.yml').write_text(yaml.safe_dump(config, allow_unicode=True), encoding='utf-8')
        assert all(service['container_name'].startswith(self.project + '-') for service in config['services'].values())
        for key, value in self.env.items():
            if os.environ.get(key) != value:
                self.previous[key] = os.environ.get(key)
                os.environ[key] = value
        self.started = True
        self.run('database', self.command + ['up', '-d', '--wait', 'db'])
        self.run('database-tcp', self.command + ['exec', '-T', 'db', 'sh', '-c',
                 'for n in $(seq 1 60); do pg_isready -h 127.0.0.1 -U kin && exit 0; sleep 1; done; exit 1'], timeout=70)
        self.run('keycloak-database', self.command + ['exec', '-T', 'db', 'createdb', '-U', 'kin', 'keycloak'])
        self.run('stack', self.command + ['up', '-d', '--build'], timeout=900)
        for endpoint in ('/api/health', '/auth/realms/kin/.well-known/openid-configuration'):
            deadline = time.monotonic() + 240
            while True:
                try:
                    with urlopen('https://localhost:9443' + endpoint, context=ssl._create_unverified_context(), timeout=5) as response:
                        assert response.status == 200
                        if endpoint == '/api/health':
                            assert json.loads(response.read()).get('memberRights') == 'ready'
                    break
                except Exception:
                    if time.monotonic() >= deadline:
                        raise RuntimeError('Owned authentication stack readiness failed')
                    time.sleep(1)
        from live_admin_credential import ensure_imported_admin_credential
        password = ensure_imported_admin_credential('http://127.0.0.1:8080/auth/admin/realms/kin', self.values['KC_ADMIN_PASSWORD'])
        self.values['KIN_LIVE_IMPORTED_ADMIN_PASSWORD'] = password
        self.previous['KIN_LIVE_IMPORTED_ADMIN_PASSWORD'] = os.environ.get('KIN_LIVE_IMPORTED_ADMIN_PASSWORD')
        os.environ['KIN_LIVE_IMPORTED_ADMIN_PASSWORD'] = password
        (self.out / 'isolation.json').write_text(json.dumps({'project': self.project, 'ports': 'loopback only',
            'credentials': 'generated in memory', 'network': 'new bridge, no existing network reused', 'volumes': 'new project volumes',
            'original_resources_touched': False}, indent=2) + '\n')

    def close(self):
        try:
            if self.started:
                try:
                    self.run('service-logs', self.command + ['logs', '--no-color'], check=False)
                finally:
                    self.run('cleanup', self.command + ['down', '--volumes', '--remove-orphans'], timeout=180)
                for kind, argv in [('containers', ['ps', '-aq']), ('volumes', ['volume', 'ls', '-q']), ('networks', ['network', 'ls', '-q'])]:
                    result = self.run('remaining-' + kind, ['docker', *argv, '--filter', 'label=kin.emrb.r9.http=' + self.project])
                    if result.stdout.strip():
                        raise RuntimeError('Owned authentication cleanup left ' + kind)
        finally:
            for key, value in self.previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
