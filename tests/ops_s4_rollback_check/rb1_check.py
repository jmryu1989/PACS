"""RISK-RB-1, hosted synthetic only: does the previous API image start through its real
entrypoint on a database the current image has already migrated?

A rollback on the server starts revision 17980d5 through start-production.sh (`set -eu`,
`prisma migrate deploy`, then `exec node`) against a `_prisma_migrations` table that also holds
the later migrations that image has never seen. The Stage-1 rehearsal bypassed that path with
`--entrypoint node`, so it says nothing about it. Here the previous image runs its own
Entrypoint and CMD unmodified; only the separately labelled secondary probes override them.

Scope: one networkless disposable PostgreSQL, synthetic rows only, no credential, no server.
`run` records facts and raw logs. `report` turns only the primary facts into the job status;
that status is not an acceptance, the recorded evidence is judged separately.

Usage (s4-rollback-entrypoint-check.yml is the only caller):
  rb1_check.py run --previous-image REF --current-image REF --postgres-image REF
                   --previous-revision SHA --current-revision SHA --out NEW_DIR
  rb1_check.py report SUMMARY_JSON
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = 1
# Row counts named by the work order: the current tree has 29 migration directories, 17980d5 has 23.
EXPECTED_CURRENT_ROWS = 29
EXPECTED_PREVIOUS_ROWS = 23
START_CMD = ['sh', '/app/start-production.sh']
# The exact migrate line of start-production.sh, for the isolated secondary probe only.
MIGRATE_LINE = './node_modules/.bin/prisma migrate deploy'
STATUS_LINE = './node_modules/.bin/prisma migrate status'
STARTED = 'Nest application successfully started'
# Any of these means node was exec'd, which set -eu allows only after migrate deploy exited 0.
NODE_MARKERS = ('Starting Nest application', STARTED, '[KIN API]')
# Prisma's own success lines; they separate "migrate failed" from "node died before logging".
PRISMA_SUCCESS = ('No pending migrations to apply', 'successfully applied')
PRISMA_ERROR = re.compile(r'\bP\d{4}\b')
RESTRICT_LINE = re.compile(rb'\\(?:un)?restrict [^\s]+')
HEX40 = re.compile(r'[0-9a-f]{40}')
DATABASE = re.compile(r'[a-z][a-z0-9_]{0,30}')
ENV_KEY = re.compile(r'[A-Z_][A-Z0-9_]*')
SECRET_KEYS = frozenset({'KC_WEB_SECRET', 'KIN_COOKIE_SECRET', 'ORTHANC_PASS', 'KC_CLIENT_SECRET'})
HISTORY_FIELDS = ('id', 'migration_name', 'checksum', 'started_at', 'finished_at',
                  'rolled_back_at', 'applied_steps_count', 'logs_null')
HISTORY_SQL = ('SELECT id,migration_name,checksum,started_at,finished_at,rolled_back_at,'
               'applied_steps_count,(logs IS NULL) FROM "_prisma_migrations" '
               'ORDER BY migration_name COLLATE "C",id')
SYNTHETIC_ORDER = 'SYN-RB1-ORDER-1'
SYNTHETIC_ACCESSION = 'SYN-RB1-ACC-1'
SYNTHETIC_WARD = 'SYN-RB1-WARD'
UPDATED_WARD = 'SYN-RB1-WARD-UPDATED-BY-PREVIOUS'
SEED_SQL = ('INSERT INTO "Order" (oid,"institutionId","patientId",name,sex,birth,sched,modality,'
            'descr,ward,"reqDoc",accession) VALUES (' + ','.join("'" + v + "'" for v in (
                SYNTHETIC_ORDER, 'SYNTHETIC-hospital', 'SYN-RB1-PID', 'SYNTHETIC^RB1', 'O',
                '19000101', '2026-09-26 00:00', 'OT', 'SYNTHETIC RB-1 order', SYNTHETIC_WARD,
                'SYNTHETIC-doctor', SYNTHETIC_ACCESSION)) + ')')
ORDER_SQL = ('SELECT coalesce(accession,\'<null>\'),ward FROM "Order" WHERE oid=\'' + SYNTHETIC_ORDER + "'")

# Read inside each image: what it will actually run, not what the checkout says.
IMAGE_SCRIPT = r"""
const fs=require('fs'),crypto=require('crypto');
const dir='prisma/migrations',script=fs.readFileSync('start-production.sh');
console.log(JSON.stringify({
 prisma:require('prisma/package.json').version,
 prisma_client:require('@prisma/client/package.json').version,
 migrations:fs.readdirSync(dir).filter(n=>fs.statSync(dir+'/'+n).isDirectory()).sort(),
 start_script_sha256:crypto.createHash('sha256').update(script).digest('hex'),
 start_script:script.toString('utf8')}));
"""
# Env is deliberately not read: the container config holds the generated throwaway values.
CREATED_FORMAT = ('{"cmd":{{json .Config.Cmd}},"entrypoint":{{json .Config.Entrypoint}},'
                  '"path":{{json .Path}},"args":{{json .Args}}}')
PROBE_SCRIPT = (
    "fetch('http://127.0.0.1:3000'+process.env.RB1_PATH).then(async r=>{const t=await r.text();"
    "console.log(JSON.stringify({status:r.status,body:t.slice(0,4096)}))})"
    ".catch(e=>{console.log(JSON.stringify({error:String((e&&e.cause&&e.cause.code)||(e&&e.name)||'error')}));"
    "process.exitCode=2})")
# The previous image's own compiled Prisma client against a row carrying a column it does not model.
ORDER_SCRIPT = r"""
const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient(),oid=process.env.RB1_ORDER,ward=process.env.RB1_WARD;
(async()=>{
 const row=await p.order.findUnique({where:{oid}});
 const all=await p.order.findMany({select:{oid:true}});
 const updated=row?await p.order.update({where:{oid},data:{ward}}):null;
 console.log(JSON.stringify({found:!!row,keys:row?Object.keys(row).sort():null,
  accession_key_present:!!row&&Object.prototype.hasOwnProperty.call(row,'accession'),
  find_many_count:all.length,update_returned_ward:updated?updated.ward:null}));
})().catch(e=>{console.log(JSON.stringify({error:String((e&&e.code)||(e&&e.name)||'error'),
  message:String((e&&e.message)||'').slice(0,2000)}));process.exitCode=1}).finally(()=>p.$disconnect());
"""


class HarnessError(RuntimeError):
    """The sequence could not be observed; distinct from an observed failure of the image."""


def require(condition, message):
    if not condition:
        raise HarnessError(message)


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def api_env(database, token=secrets.token_hex):
    # Same shape as tests/production_image_test.py, which both revisions boot with. The Keycloak
    # and Orthanc endpoints are deliberately unreachable: /api/health needs neither.
    require(DATABASE.fullmatch(database), 'invalid synthetic database name')
    return {
        'DATABASE_URL': 'postgresql://postgres@127.0.0.1:5432/' + database,
        'DEPLOYMENT_MODE': 'production', 'AUTH_REQUIRED': 'true',
        'KC_ISSUER': 'http://127.0.0.1:1/auth/realms/kin',
        'KC_JWKS_URL': 'http://127.0.0.1:1/certs', 'KC_AUDIENCE': 'kin-api',
        'KC_WEB_SECRET': token(16), 'KIN_COOKIE_SECRET': token(32),
        'PUBLIC_ORIGIN': 'http://127.0.0.1:3000',
        'ORTHANC_USER': 'disposable-ci-only', 'ORTHANC_PASS': token(16),
        'KC_ADMIN_URL': 'http://127.0.0.1:1/auth', 'KC_REALM': 'kin',
        'KC_CLIENT_ID': 'kin-api', 'KC_CLIENT_SECRET': token(16),
    }


def env_file_text(env):
    lines = []
    for key, value in env.items():
        require(type(key) is str and ENV_KEY.fullmatch(key), 'invalid environment key')
        require(type(value) is str and not any(c in value for c in '\r\n\0'), 'invalid environment value')
        lines.append(key + '=' + value + '\n')
    return ''.join(lines)


def public_env(env):
    # Generated throwaway values still stay out of the evidence; only their presence is recorded.
    return {key: '<generated>' if key in SECRET_KEYS else value for key, value in env.items()}


def parse_json_line(raw):
    lines = [line for line in raw.decode('utf-8', errors='replace').splitlines() if line.strip()]
    if not lines:
        return None
    try:
        return json.loads(lines[-1])
    except ValueError:
        return None


def evaluate_health(raw):
    probe = parse_json_line(raw)
    if type(probe) is not dict:
        return {'healthy': False, 'status': None, 'body': None, 'error': 'unparsable probe output'}
    if 'error' in probe:
        return {'healthy': False, 'status': None, 'body': None, 'error': str(probe['error'])}
    status, text = probe.get('status'), probe.get('body')
    try:
        body = json.loads(text) if type(text) is str else None
    except ValueError:
        body = None
    healthy = (status == 200 and type(body) is dict and body.get('ok') is True
               and body.get('auth') is True)
    return {'healthy': healthy, 'status': status, 'body': body if body is not None else text, 'error': None}


def created_process(created):
    """The argv Docker execs for a created container: Path followed by Args."""
    if type(created) is not dict or type(created.get('path')) is not str or type(created.get('args')) is not list:
        return None
    return [created['path'], *created['args']]


def entrypoint_unmodified(image_config, created):
    # The production start is the image's own Entrypoint (inherited from node:22-slim, whose
    # docker-entrypoint.sh execs its arguments) followed by CMD. Both must reach the created
    # container unchanged, and CMD must still be the start script.
    if type(image_config) is not dict or type(created) is not dict:
        return False
    entrypoint = image_config.get('entrypoint') or []
    return (image_config.get('cmd') == START_CMD and created.get('cmd') == START_CMD
            and (created.get('entrypoint') or []) == entrypoint
            and created_process(created) == [*entrypoint, *START_CMD])


def classify_boot(stdout, stderr, state, health):
    text = (stdout + b'\n' + stderr).decode('utf-8', errors='replace')
    healthy = type(health) is dict and health.get('healthy') is True
    node_reached = healthy or any(marker in text for marker in NODE_MARKERS)
    prisma_succeeded = any(marker in text for marker in PRISMA_SUCCESS)
    running = type(state) is dict and state.get('Running') is True
    exit_code = state.get('ExitCode') if type(state) is dict and not running else None
    if node_reached:
        inferred, basis = 0, 'node ran; set -eu execs node only after migrate deploy exits 0'
    elif prisma_succeeded:
        inferred, basis = 0, 'prisma printed its success line; node exited before logging'
    elif type(state) is dict and not running and type(exit_code) is int:
        inferred, basis = exit_code, 'exited before node output; under set -eu this is migrate deploy status'
    else:
        inferred, basis = None, 'undetermined: no node output and the container had not exited'
    return {
        'node_reached': node_reached, 'nest_started': STARTED in text,
        'prisma_no_pending_line': PRISMA_SUCCESS[0] in text,
        'prisma_applied_line': PRISMA_SUCCESS[1] in text,
        'prisma_error_codes': sorted(set(PRISMA_ERROR.findall(text))),
        'container_running_at_poll_end': running, 'container_exit_code_at_poll_end': exit_code,
        'migrate_deploy_exit_inferred': inferred, 'migrate_deploy_exit_basis': basis,
        'stdout_sha256': sha256(stdout), 'stderr_sha256': sha256(stderr),
    }


def normalize_schema_dump(raw):
    """Drop only pg_dump's \\restrict/\\unrestrict lines before comparing two schema dumps.

    Since 16.10 pg_dump brackets plain output with those two lines and a key that is random per
    run, so two dumps of one unchanged schema would otherwise never hash equal.
    """
    kept = [line for line in raw.split(b'\n') if not RESTRICT_LINE.fullmatch(line.rstrip(b'\r'))]
    return b'\n'.join(kept), raw.count(b'\n') + 1 - len(kept)


def parse_history(raw):
    rows = []
    for line in raw.decode('utf-8').splitlines():
        if not line:
            continue
        fields = line.split('|')
        require(len(fields) == len(HISTORY_FIELDS), 'unexpected _prisma_migrations row shape')
        rows.append(dict(zip(HISTORY_FIELDS, fields)))
    return rows


def history_facts(rows, image_migrations, expected_count):
    names = [row['migration_name'] for row in rows]
    return {
        'count': len(rows), 'expected_count': expected_count,
        'count_matches': len(rows) == expected_count,
        'names': names, 'names_match_image_migrations': names == list(image_migrations),
        'duplicate_names': sorted({name for name in names if names.count(name) > 1}),
        'all_finished': all(row['finished_at'] for row in rows),
        'none_rolled_back': not any(row['rolled_back_at'] for row in rows),
        'all_logs_null': all(row['logs_null'] == 't' for row in rows),
    }


def report_failures(summary):
    if type(summary) is not dict or summary.get('schema') != SCHEMA:
        return ['summary schema is not ' + str(SCHEMA)]
    facts = summary.get('facts')
    if type(facts) is not dict:
        return ['summary has no facts']
    reasons = []
    if summary.get('harness_complete') is not True:
        reasons.append('harness incomplete: ' + '; '.join(map(str, summary.get('harness_errors') or ['unknown'])))
    checks = (
        ('current_precondition_met', True, 'the current image did not leave a healthy migrated database'),
        ('previous_entrypoint_unmodified', True, 'the previous image did not run its own Entrypoint and CMD'),
        ('previous_migrate_deploy_exit_inferred', 0, 'the previous entrypoint migrate deploy did not exit 0'),
        ('previous_migrate_deploy_exit_isolated', 0, 'the isolated previous migrate deploy did not exit 0'),
        ('previous_healthy_on_migrated_db', True, 'the previous image did not become healthy'),
        ('history_unchanged_by_previous_boot', True, 'the previous boot changed _prisma_migrations'),
        ('schema_unchanged_by_previous_boot', True, 'the previous boot changed the schema'),
        ('history_unchanged_by_isolated_probes', True, 'the isolated probes changed _prisma_migrations'),
    )
    for key, expected, message in checks:
        value = facts.get(key)
        # `type` keeps True from passing as 1 and 0 from passing as False.
        if type(value) is not type(expected) or value != expected:
            reasons.append(message + ' (' + key + '=' + json.dumps(value) + ')')
    return reasons


class Recorder:
    """Every docker/git/psql command, with raw stdout/stderr, exit and timing, in its own folder."""

    def __init__(self, root):
        self.root = root
        self.count = 0
        self.index = []

    def run(self, name, argv, *, timeout=120, check=False):
        self.count += 1
        folder = self.root / 'steps' / ('%03d-%s' % (self.count, name))
        folder.mkdir(parents=True, exist_ok=False)
        started, clock = utc_now(), time.monotonic()
        stdout, stderr, code, error = b'', b'', None, None
        try:
            result = subprocess.run(argv, cwd=str(ROOT), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, timeout=timeout)
            stdout, stderr, code = result.stdout, result.stderr, result.returncode
        except subprocess.TimeoutExpired as expired:
            stdout, stderr, error = expired.stdout or b'', expired.stderr or b'', 'timeout'
        except OSError as failure:
            error = type(failure).__name__
        (folder / 'stdout.log').write_bytes(stdout)
        (folder / 'stderr.log').write_bytes(stderr)
        entry = {'step': self.count, 'name': name, 'argv': list(argv), 'started_at_utc': started,
                 'ended_at_utc': utc_now(), 'duration_seconds': round(time.monotonic() - clock, 3),
                 'exit': code, 'error': error, 'folder': folder.relative_to(self.root).as_posix(),
                 'stdout_sha256': sha256(stdout), 'stderr_sha256': sha256(stderr),
                 'stdout_bytes': len(stdout), 'stderr_bytes': len(stderr)}
        (folder / 'step.json').write_text(json.dumps(entry, indent=2) + '\n', encoding='utf-8')
        self.index.append(entry)
        if check and code != 0:
            raise HarnessError('%s failed (exit %s, %s)' % (name, code, error or 'no launch error'))
        return stdout, stderr, entry


class Sequence:
    def __init__(self, args, out):
        self.args, self.out = args, out
        self.recorder = Recorder(out)
        self.owned = []
        self.env_dir = Path(tempfile.mkdtemp(prefix='kin-rb1-env-'))
        self.db = None

    # ---- containers -------------------------------------------------------------------------
    def name(self, suffix):
        # kin-rehearsal-* plus the kin.ops.run label is what ops_backup.remove_owned accepts.
        token = uuid.uuid4().hex
        name = 'kin-rehearsal-' + token[:16] + '-' + suffix
        self.owned.append((name, token))
        return name, token

    def env_file(self, database):
        # One file per container, outside the artifact, so no generated value reaches the evidence.
        path = self.env_dir / (database + '-' + uuid.uuid4().hex[:12] + '.env')
        descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as handle:
            handle.write(env_file_text(api_env(database)))
        return path

    def inspect_state(self, name, step):
        stdout, _, entry = self.recorder.run(step, ['docker', 'inspect', '--format', '{{json .State}}', name])
        if entry['exit'] != 0:
            return None
        try:
            return json.loads(stdout)
        except ValueError:
            return None

    def psql(self, step, database, sql, check=True):
        return self.recorder.run(step, ['docker', 'exec', self.db, 'psql', '-X', '-U', 'postgres', '-d', database,
                                        '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql], check=check)

    def history(self, step, database):
        stdout, _, _ = self.psql(step, database, HISTORY_SQL)
        return stdout, parse_history(stdout)

    def schema_dump(self, step, database):
        stdout, _, _ = self.recorder.run(step, ['docker', 'exec', self.db, 'pg_dump', '-U', 'postgres',
                                                '--schema-only', '--no-owner', '-d', database], check=True)
        normalized, dropped = normalize_schema_dump(stdout)
        return {'raw_sha256': sha256(stdout), 'normalized_sha256': sha256(normalized), 'restrict_lines_dropped': dropped}

    # ---- stages -----------------------------------------------------------------------------
    def image_facts(self, role, reference, revision):
        stdout, _, _ = self.recorder.run(role + '-image-inspect', ['docker', 'image', 'inspect', reference], check=True)
        body = json.loads(stdout)[0]
        config = body.get('Config') or {}
        label = (config.get('Labels') or {}).get('org.opencontainers.image.revision')
        require(label == revision, role + ' image revision label is not ' + revision)
        name, token = self.name(role[:4] + '-image')
        stdout, _, _ = self.recorder.run(role + '-image-contents', [
            'docker', 'run', '--rm', '--name', name, '--label', 'kin.ops.run=' + token, '--network', 'none',
            '--entrypoint', 'node', body['Id'], '-e', IMAGE_SCRIPT], check=True)
        contents = parse_json_line(stdout)
        require(type(contents) is dict and type(contents.get('migrations')) is list, role + ' image contents unreadable')
        return {'reference': reference, 'id': body['Id'], 'revision_label': label, 'user': config.get('User'),
                'cmd': config.get('Cmd'), 'entrypoint': config.get('Entrypoint'),
                'working_dir': config.get('WorkingDir'), **contents}

    def wait_database(self):
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            # TCP readiness excludes the image's temporary init server (see ops_backup.rehearse).
            ready = subprocess.run(['docker', 'exec', self.db, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            if ready.returncode == 0:
                self.recorder.run('database-ready', ['docker', 'exec', self.db, 'pg_isready', '-h', '127.0.0.1',
                                                     '-U', 'postgres'], check=True)
                return
            time.sleep(0.5)
        raise HarnessError('synthetic PostgreSQL readiness timed out')

    def poll_health(self, name, label, limit=180):
        # Individual polls go to one JSON-lines file instead of hundreds of step folders.
        log = self.out / 'steps' / (label + '-health-polls.jsonl')
        started, attempts, health, reason = time.monotonic(), 0, None, 'timeout'
        with log.open('x', encoding='utf-8') as polls:
            while time.monotonic() - started < limit:
                attempts += 1
                try:
                    probe = subprocess.run(['docker', 'exec', '-e', 'RB1_PATH=/api/health', name, 'node', '-e',
                                            PROBE_SCRIPT], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
                    code, stdout, stderr = probe.returncode, probe.stdout, probe.stderr
                except subprocess.TimeoutExpired:
                    code, stdout, stderr = None, b'', b'probe timeout'
                health = evaluate_health(stdout)
                polls.write(json.dumps({'attempt': attempts, 'at_utc': utc_now(), 'exit': code,
                                        'stdout': stdout.decode('utf-8', 'replace')[:2048],
                                        'stderr': stderr.decode('utf-8', 'replace')[:2048],
                                        'healthy': health['healthy']}) + '\n')
                if health['healthy']:
                    reason = 'healthy'
                    break
                try:
                    running = subprocess.run(['docker', 'inspect', '--format', '{{.State.Running}}', name],
                                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15).stdout
                except subprocess.TimeoutExpired:
                    running = b''
                if running.strip() == b'false':
                    reason = 'exited'
                    break
                time.sleep(1)
        return {**(health or evaluate_health(b'')), 'attempts': attempts, 'ended_because': reason,
                'elapsed_seconds': round(time.monotonic() - started, 3),
                'polls_log': log.relative_to(self.out).as_posix()}

    def boot(self, label, image, database, observe=None):
        """Create with the image's own Entrypoint and CMD (no override, no command) and watch it."""
        name, token = self.name(label)
        self.recorder.run(label + '-create', ['docker', 'create', '--name', name, '--label', 'kin.ops.run=' + token,
                                              '--network', 'container:' + self.db,
                                              '--env-file', str(self.env_file(database)), image], check=True)
        # What the daemon will exec, read back from the created container rather than assumed.
        stdout, _, _ = self.recorder.run(label + '-created-process', ['docker', 'inspect', '--format', CREATED_FORMAT,
                                                                      name], check=True)
        created = parse_json_line(stdout)
        require(type(created) is dict, label + ' created container process unreadable')
        self.recorder.run(label + '-start', ['docker', 'start', name], check=True)
        health = self.poll_health(name, label)
        state = self.inspect_state(name, label + '-state-at-poll-end')
        observations = {}
        if observe is not None and health['healthy']:
            observations = observe(name)
        self.recorder.run(label + '-stop', ['docker', 'stop', '--time', '10', name], timeout=60)
        final = self.inspect_state(name, label + '-state-after-stop')
        stdout, stderr, logs = self.recorder.run(label + '-logs', ['docker', 'logs', name], timeout=60, check=True)
        self.recorder.run(label + '-logs-timestamps', ['docker', 'logs', '--timestamps', name], timeout=60)
        facts = classify_boot(stdout, stderr, state, health)
        return {'container': name, 'created': created, 'created_process': created_process(created),
                'health': health, 'state_at_poll_end': state, 'state_after_stop': final,
                'logs_step': logs['folder'], 'observations': observations, **facts}

    def observe_previous(self, name):
        found = {}
        for path in ('/api/studies', '/api/me'):
            stdout, _, entry = self.recorder.run('previous-http' + path.replace('/', '-'), [
                'docker', 'exec', '-e', 'RB1_PATH=' + path, name, 'node', '-e', PROBE_SCRIPT], timeout=30)
            probe = parse_json_line(stdout)
            found[path] = {'status': probe.get('status') if type(probe) is dict else None,
                           'expected_status': 401, 'step': entry['folder']}
        stdout, _, entry = self.recorder.run('previous-order-client', [
            'docker', 'exec', '-e', 'RB1_ORDER=' + SYNTHETIC_ORDER, '-e', 'RB1_WARD=' + UPDATED_WARD,
            name, 'node', '-e', ORDER_SCRIPT], timeout=60)
        found['order_client'] = {'exit': entry['exit'], 'result': parse_json_line(stdout), 'step': entry['folder']}
        return found

    def isolated(self, label, image, database, line):
        name, token = self.name(label)
        stdout, stderr, entry = self.recorder.run(label, [
            'docker', 'run', '--rm', '--name', name, '--label', 'kin.ops.run=' + token,
            '--network', 'container:' + self.db, '--env-file', str(self.env_file(database)),
            '--entrypoint', 'sh', image, '-c', line], timeout=180)
        return {'command': line, 'exit': entry['exit'], 'error': entry['error'], 'step': entry['folder'],
                'stdout_sha256': sha256(stdout), 'stderr_sha256': sha256(stderr),
                'prisma_error_codes': sorted(set(PRISMA_ERROR.findall(
                    (stdout + b'\n' + stderr).decode('utf-8', 'replace'))))}

    def execute(self, summary):
        args, record, facts = self.args, self.recorder.run, summary['facts']
        record('docker-version', ['docker', 'version', '--format', '{{json .}}'])
        for rev, key in ((args.previous_revision, 'previous'), (args.current_revision, 'current')):
            stdout, _, _ = record(key + '-api-tree', ['git', 'rev-parse', rev + ':api'], check=True)
            summary['source'][key + '_api_tree'] = stdout.decode().strip()
        stdout, _, _ = record('head-api-tree', ['git', 'rev-parse', 'HEAD', 'HEAD:api'], check=True)
        summary['source']['head'], summary['source']['head_api_tree'] = stdout.decode().split()[:2]
        # Images are built from worktrees at the two revisions; this only shows the branch adds no api change.
        facts['head_api_tree_equals_current'] = summary['source']['head_api_tree'] == summary['source']['current_api_tree']

        images = summary['images']
        images['previous'] = self.image_facts('previous', args.previous_image, args.previous_revision)
        images['current'] = self.image_facts('current', args.current_image, args.current_revision)
        previous, current = images['previous'], images['current']
        facts['previous_migrations_in_image'] = len(previous['migrations'])
        facts['current_migrations_in_image'] = len(current['migrations'])

        self.db, token = self.name('db')
        record('database-create', ['docker', 'create', '--name', self.db, '--label', 'kin.ops.run=' + token,
                                   '--network', 'none', '--tmpfs', '/var/lib/postgresql/data',
                                   '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=kin',
                                   args.postgres_image], check=True)
        record('database-start', ['docker', 'start', self.db], check=True)
        self.wait_database()
        record('database-version', ['docker', 'exec', self.db, 'postgres', '--version'])
        record('control-database-create', ['docker', 'exec', self.db, 'createdb', '-U', 'postgres', 'kin_control'],
               check=True)

        # 1. The current image migrates the empty database through its own entrypoint.
        stage = summary['stages']['current_boot'] = self.boot('current-boot', current['id'], 'kin')
        raw_h0, rows = self.history('history-after-current', 'kin')
        stage['history'] = history_facts(rows, current['migrations'], EXPECTED_CURRENT_ROWS)
        facts['current_migrated_rows'] = len(rows)
        facts['current_precondition_met'] = (stage['health']['healthy'] and stage['history']['count_matches']
                                             and stage['history']['names_match_image_migrations']
                                             and stage['history']['all_finished']
                                             and stage['history']['none_rolled_back'])
        if not facts['current_precondition_met']:
            raise HarnessError('current image did not leave a healthy %d-row database' % EXPECTED_CURRENT_ROWS)
        previous_names = set(previous['migrations'])
        facts['db_rows_unknown_to_previous_image'] = [n for n in stage['history']['names'] if n not in previous_names]

        # 2. A synthetic order row that carries the column 17980d5 does not model.
        self.psql('seed-synthetic-order', 'kin', SEED_SQL)
        schema_before = self.schema_dump('schema-before-previous', 'kin')

        # 3. The previous image, its own Entrypoint and CMD unmodified, on that database.
        stage = summary['stages']['previous_boot'] = self.boot('previous-boot', previous['id'], 'kin',
                                                                observe=self.observe_previous)
        facts['previous_entrypoint_unmodified'] = entrypoint_unmodified(previous, stage['created'])
        facts['previous_migrate_deploy_exit_inferred'] = stage['migrate_deploy_exit_inferred']
        facts['previous_healthy_on_migrated_db'] = stage['health']['healthy']
        facts['previous_health'] = {key: stage['health'][key] for key in ('status', 'body', 'error', 'ended_because')}
        facts['previous_container_exit_code_at_poll_end'] = stage['container_exit_code_at_poll_end']
        facts['previous_prisma_error_codes'] = stage['prisma_error_codes']
        raw_h1, rows = self.history('history-after-previous', 'kin')
        stage['history'] = history_facts(rows, current['migrations'], EXPECTED_CURRENT_ROWS)
        schema_after = self.schema_dump('schema-after-previous', 'kin')
        stdout, _, entry = self.psql('order-after-previous', 'kin', ORDER_SQL, check=False)
        stage['observations']['order_row_after'] = {'row': stdout.decode('utf-8', 'replace').strip(),
                                                    'expected': SYNTHETIC_ACCESSION + '|' + UPDATED_WARD,
                                                    'step': entry['folder']}
        facts['history_unchanged_by_previous_boot'] = raw_h0 == raw_h1
        facts['schema_unchanged_by_previous_boot'] = (schema_before['normalized_sha256']
                                                      == schema_after['normalized_sha256'])
        facts['history_sha256'] = {'after_current': sha256(raw_h0), 'after_previous': sha256(raw_h1)}
        facts['schema_sha256'] = {'before_previous': schema_before, 'after_previous': schema_after}

        # 4. Secondary: the same migrate line alone, for an exit code that is read, not inferred.
        probes = summary['stages']['previous_isolated'] = {
            'migrate_deploy': self.isolated('previous-isolated-migrate-deploy', previous['id'], 'kin', MIGRATE_LINE),
            'migrate_status': self.isolated('previous-isolated-migrate-status', previous['id'], 'kin', STATUS_LINE),
        }
        raw_h2, _ = self.history('history-after-isolated', 'kin')
        facts['previous_migrate_deploy_exit_isolated'] = probes['migrate_deploy']['exit']
        facts['previous_migrate_status_exit_isolated'] = probes['migrate_status']['exit']
        facts['history_unchanged_by_isolated_probes'] = raw_h1 == raw_h2
        facts['history_sha256']['after_isolated'] = sha256(raw_h2)
        boot = summary['stages']['previous_boot']
        facts['previous_migrate_deploy_log_sha256'] = {
            'entrypoint_container_stdout': boot['stdout_sha256'], 'entrypoint_container_stderr': boot['stderr_sha256'],
            'isolated_stdout': probes['migrate_deploy']['stdout_sha256'],
            'isolated_stderr': probes['migrate_deploy']['stderr_sha256']}

        # 5. Control: the previous image on its own fresh database, so a failure above is not
        #    this harness's environment.
        stage = summary['stages']['control_previous_fresh_db'] = self.boot('control-previous', previous['id'],
                                                                           'kin_control')
        _, rows = self.history('history-control', 'kin_control')
        stage['history'] = history_facts(rows, previous['migrations'], EXPECTED_PREVIOUS_ROWS)
        facts['control_previous_healthy_on_fresh_db'] = stage['health']['healthy']

    def cleanup(self, summary):
        sys.path.insert(0, str(ROOT / 'scripts'))
        import ops_backup
        for name, token in reversed(self.owned):
            try:
                ops_backup.remove_owned_if_present('container', name, token)
            except Exception as failure:  # keep removing the rest; the runner is disposable anyway
                summary['cleanup_errors'].append(name + ': ' + str(failure))
        for path in self.env_dir.iterdir():
            path.unlink()
        self.env_dir.rmdir()


def run(args):
    for key in ('previous_revision', 'current_revision'):
        require(HEX40.fullmatch(getattr(args, key)), key + ' must be a full commit SHA')
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=False)
    summary = {
        'schema': SCHEMA, 'check': 'RISK-RB-1 previous API image, real entrypoint, on a current-migrated DB',
        'code_sha': os.environ.get('GITHUB_SHA'), 'run_id': os.environ.get('GITHUB_RUN_ID'),
        'run_attempt': os.environ.get('GITHUB_RUN_ATTEMPT'), 'started_at_utc': utc_now(),
        'revisions': {'previous': args.previous_revision, 'current': args.current_revision},
        'postgres_image': args.postgres_image, 'api_env': public_env(api_env('kin')),
        'source': {}, 'images': {}, 'stages': {}, 'facts': {},
        'harness_complete': False, 'harness_errors': [], 'cleanup_errors': [],
    }
    sequence = Sequence(args, out)
    try:
        sequence.execute(summary)
        summary['harness_complete'] = True
    except Exception as failure:  # recorded, never swallowed: the report step turns it into a failure
        summary['harness_errors'].append(type(failure).__name__ + ': ' + str(failure))
    finally:
        try:
            sequence.cleanup(summary)
        finally:
            summary['ended_at_utc'] = utc_now()
            summary['steps'] = sequence.recorder.index
            summary['report_failures'] = report_failures(summary)
            (out / 'rb1-check-summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
    return 0 if summary['harness_complete'] else 2


def report(path):
    summary = json.loads(Path(path).read_text(encoding='utf-8'))
    reasons = report_failures(summary)
    facts = summary.get('facts') if type(summary) is dict else None
    print(json.dumps({'facts': facts, 'failures': reasons}, indent=2))
    return 1 if reasons else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)
    sequence = commands.add_parser('run')
    for option in ('previous-image', 'current-image', 'postgres-image', 'previous-revision',
                   'current-revision', 'out'):
        sequence.add_argument('--' + option, required=True)
    summary = commands.add_parser('report')
    summary.add_argument('summary')
    args = parser.parse_args(argv)
    if args.command == 'run':
        return run(args)
    return report(args.summary)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.exit(main())
