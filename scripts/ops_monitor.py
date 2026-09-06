"""Read-only host collector and credential-free external availability probe."""
from __future__ import annotations

import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit
from urllib.request import build_opener, HTTPSHandler, HTTPRedirectHandler, ProxyHandler

NAMES = ('kin-api', 'kin-keycloak', 'kin-orthanc', 'kin-db', 'kin-proxy')
MAX_AGE = 180
MAINTENANCE = 600
BACKUP_AGE = 30 * 3600
LIMIT = 1024 * 1024


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read_json(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > LIMIT:
        raise ValueError('Invalid status file')
    return json.loads(path.read_text(encoding='utf-8'))


def atomic_json(path, value, mode=0o600):
    if path.is_symlink():
        raise ValueError('Symlink output refused')
    fd, name = tempfile.mkstemp(prefix='.kin-monitor-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
            os.chmod(name, mode)
            json.dump(value, stream, separators=(',', ':'))
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def timestamp(value):
    stamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if stamp.tzinfo is None:
        raise ValueError('Timezone required')
    return int(stamp.timestamp())


def backup_status(root, lock_path, now):
    rows = []
    # Only manifests are read: dumps, .env, patient counts and archives never leave host.
    for entry in root.iterdir():
        if re.fullmatch(r'\d{8}-\d{6}-[a-f0-9]{8}', entry.name):
            if entry.is_symlink() or not entry.is_dir():
                raise ValueError('Invalid backup directory')
            rows.append(read_json(entry / 'manifest.json'))
    if not rows:
        return ['backup_missing'], 0
    rows.sort(key=lambda row: timestamp(row['created_utc']))
    latest = rows[-1]
    created = timestamp(latest['created_utc'])
    if created > now + 60 or any(row.get('format') != 1 for row in rows):
        raise ValueError('Invalid backup metadata')
    good = [timestamp(row['created_utc']) for row in rows
            if row.get('complete') is True and row.get('ready') is True
            and not row.get('resume_failures') and not row.get('backup_error')]
    faults = [] if good and 0 <= now - max(good) <= BACKUP_AGE else ['backup_stale']
    failed = (latest.get('ready') is False or latest.get('backup_error')
              or latest.get('resume_failures'))
    until = 0
    if lock_path.exists() and not lock_path.is_symlink() and lock_path.is_file():
        started = int(lock_path.stat().st_mtime)
        # An operations lock alone may belong to deployment or be stale. Require
        # a matching unfinished backup too; expiry never moves with each poll.
        if (not failed and latest.get('ready') is None and
                0 <= now - started < MAINTENANCE and
                started - 60 <= created <= now):
            until = min(started + MAINTENANCE, created + MAINTENANCE)
    if failed or (latest.get('ready') is not True and not until):
        faults.append('backup_failed')
    return faults, until


def inspect_containers(names=NAMES):
    fmt = ('{"name":{{json .Name}},"id":{{json .Id}},'
           '"running":{{json .State.Running}},"restarting":{{json .State.Restarting}},'
           '"restarts":{{json .RestartCount}},'
           '"health":{{with index .State "Health"}}{{json .Status}}{{else}}"none"{{end}}}')
    # Older Docker treats an absent .State.Health key as a template error;
    # index returns nil, so services without Docker HEALTHCHECK remain observable.
    result = subprocess.run(['docker', 'inspect', '--format', fmt, *names],
                            capture_output=True, timeout=20, check=True)
    return [json.loads(line) for line in result.stdout.decode().splitlines()]


def host_status(rows, previous, now, until):
    by_name = {row['name'].lstrip('/'): row for row in rows}
    if len(rows) != len(NAMES) or set(by_name) != set(NAMES):
        raise ValueError('Missing/duplicate containers')
    faults, snapshot = [], {}
    for name in NAMES:
        row = by_name[name]
        old = previous.get('containers', {}).get(name, {})
        events = [t for t in old.get('events', []) if now - 300 <= t <= now]
        if row['id'] == old.get('id'):
            delta = row['restarts'] - old.get('restarts', row['restarts'])
            if delta > 0:
                events.extend([now] * min(delta, 3))
        else:
            events = []
        snapshot[name] = {'id': row['id'], 'restarts': row['restarts'], 'events': events[-3:]}
        paused_writer = until > now and name in NAMES[:3]
        if not paused_writer:
            if row['running'] is not True or row['health'] not in ('none', 'healthy'):
                faults.append('service_unready')
            if row['restarting'] is True or len(events) >= 3:
                faults.append('restart_loop')
    return sorted(set(faults)), snapshot


def prepare_dir(path, mode):
    # Dedicated output directories only. Never chmod a pre-existing user's folder.
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('Symlink directory refused')
    path.mkdir(mode=mode, parents=True, exist_ok=True)
    info = path.stat()
    if not path.is_dir() or (os.name == 'posix' and
            (info.st_uid != os.geteuid() or (info.st_mode & 0o777) != mode)):
        raise ValueError('Output directory ownership/permissions mismatch')


def collect(repo, backups, state_dir, public_dir):
    import fcntl
    prepare_dir(state_dir, 0o700)
    prepare_dir(public_dir, 0o755)
    if state_dir.resolve() == public_dir.resolve():
        raise ValueError('Private and public paths must differ')
    lock_path = state_dir / 'collector.lock'
    if lock_path.is_symlink():
        raise ValueError('Symlink lock refused')
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        now, faults, snapshot, until = int(time.time()), [], {}, 0
        try:
            previous_path = state_dir / 'state.json'
            previous = read_json(previous_path) if previous_path.exists() else {}
            if not isinstance(previous, dict):
                raise ValueError('Invalid collector history')
            faults, until = backup_status(backups, repo / '.kin-ops.lock', now)
            host_faults, snapshot = host_status(inspect_containers(), previous, now, until)
            faults.extend(host_faults)
            if shutil.disk_usage(backups).free < 2 * 1024 ** 3:
                faults.append('disk_low')
        except Exception:
            # No raw exception: Docker/config/manifest errors can contain secrets.
            faults.append('collector_failed')
            until = 0
        faults = sorted(set(faults))
        atomic_json(state_dir / 'state.json', {'checked_at': now, 'faults': faults, 'containers': snapshot})
        status = {'schema': 1, 'checked_at': now, 'ok': not faults,
                  'maintenance_until': until if not faults else 0}
        atomic_json(public_dir / 'status.json', status, 0o644)
        print(json.dumps({'ok': not faults, 'faults': faults}))
        return 1 if faults else 0


def origin_url(origin):
    parsed = urlsplit(origin)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in ('', '/')):
        raise ValueError('HTTPS origin without credentials/path required')
    return origin.rstrip('/')


def fetch(url):
    # Never follow a redirect to a login page/third party and mistake HTTP200 for readiness.
    opener = build_opener(ProxyHandler({}), NoRedirect(), HTTPSHandler(context=ssl.create_default_context()))
    with opener.open(url, timeout=8) as response:
        data = response.read(LIMIT + 1)
        if response.status != 200 or len(data) > LIMIT:
            raise ValueError('Invalid probe response')
        return data


def probe(origin, now=None, get=fetch):
    origin = origin_url(origin)
    now = int(time.time()) if now is None else now
    faults, maintenance = [], False
    try:
        status = json.loads(get(origin + '/ops-status.json'))
        if (set(status) != {'schema', 'checked_at', 'ok', 'maintenance_until'}
                or type(status['schema']) is not int or status['schema'] != 1
                or type(status['checked_at']) is not int or type(status['ok']) is not bool
                or type(status['maintenance_until']) is not int
                or not -30 <= now - status['checked_at'] <= MAX_AGE
                or not 0 <= status['maintenance_until'] <= status['checked_at'] + MAINTENANCE):
            raise ValueError('Invalid/frozen collector status')
        if not status['ok']:
            faults.append('host_unhealthy')
        maintenance = status['ok'] and now < status['maintenance_until']
    except Exception:
        faults.append('collector_unavailable')
    if not maintenance:
        checks = (
            ('api', '/api/health', lambda data: json.loads(data).get('ok') is True and json.loads(data).get('auth') is True),
            ('identity', '/auth/realms/kin/.well-known/openid-configuration',
             lambda data: json.loads(data).get('issuer') == origin + '/auth/realms/kin'),
            ('worklist', '/worklist/hpacs-lite/index.html', lambda data: b'KinAuth' in data),
        )
        for code, path, validate in checks:
            try:
                if not validate(get(origin + path)):
                    raise ValueError('Wrong response')
            except Exception:
                faults.append(code + '_unavailable')
    return {'ok': not faults, 'maintenance': maintenance, 'faults': faults, 'checked_at': now}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    host = sub.add_parser('collect')
    for field in ('repo', 'backups', 'state-dir', 'public-dir'):
        host.add_argument('--' + field, type=Path, required=True)
    outside = sub.add_parser('probe')
    outside.add_argument('--origin', required=True)
    outside.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'collect':
        return collect(args.repo, args.backups, args.state_dir, args.public_dir)
    result = probe(args.origin)
    if not result['ok']:
        time.sleep(15)
        result = probe(args.origin)
    atomic_json(args.output, result)
    print(json.dumps(result))
    # The notifier must run for both healthy and unhealthy results. Probe failures
    # are data; unexpected execution failures still fail the workflow step.
    return 0


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    try:
        sys.exit(main())
    except Exception as error:
        print('monitor execution failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(2)
