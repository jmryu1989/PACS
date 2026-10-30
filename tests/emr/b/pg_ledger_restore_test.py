"""B2 replacement boundaries on owned synthetic PostgreSQL fixtures.

Select the required role, HTTP, consumer, restore or first-site class explicitly.
The runner's live admission is required even though no production stack is used.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests'))
import live_test_gate as gate

# Linux numbers: the runner is Linux and a container reports a signal death as 128+N.
SIGNALS = {4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE', 9: 'SIGKILL', 11: 'SIGSEGV', 15: 'SIGTERM'}
# node --test exits 1 for a file whose process died and names the signal only in its report.
TAP_SIGNAL = re.compile(r"signal: '(SIG[A-Z0-9]+)'")
# Run by the same node (or image) that died, so the record names the runtime and engine it loaded.
RUNTIME = ("const fs=require('fs'),path=require('path');let engines;"
           "try{engines=fs.readdirSync(path.join(process.argv[1],'node_modules/.prisma/client')).filter(n=>n.includes('engine'))}"
           "catch(error){engines=String(error.message)}"
           "console.log(JSON.stringify({node:process.version,openssl:process.versions.openssl,engines}))")


class PgLedgerFixture(unittest.TestCase):
    admin_user = 'postgres'
    database_name = 'ledger_fixture'
    disk_storage = False
    pg_memory = '512m'
    backup_project = False
    @classmethod
    def command(cls, args, *, data=None, check=True, timeout=120, env=None, cwd=None):
        result = subprocess.run(args, input=data, capture_output=True, text=True,
                                encoding='utf-8', timeout=timeout, env=env, cwd=cwd)
        if check and result.returncode:
            raise RuntimeError(result.stderr[-2000:] or result.stdout[-2000:])
        return result

    @classmethod
    def sql(cls, statement, role=None, check=True):
        prefix = ('SET ROLE ' + role + ';\n') if role else ''
        return cls.command(['docker', 'exec', '-i', cls.container, 'psql', '-X', '-q', '-t', '-A',
                            '-v', 'ON_ERROR_STOP=1', '-U', cls.admin_user, '-d', cls.database_name],
                           data=prefix + statement, check=check)

    @classmethod
    def image_args(cls, command, env, *, remove=True):
        # This is the same compiled product boundary on a second authorized host.
        # One exact run-owned container uses only this fixture's private network.
        args = ['docker', 'run', *(['--rm'] if remove else []), '--name', cls.container + '-node',
                '--label', 'kin.b2r=' + cls.token,
                '--network', cls.network, '--memory', '1536m', '--memory-swap', '1536m', '--cpus', '2',
                '--mount', 'type=bind,source=' + str(ROOT / 'tests/emr/b/pg_ledger_api_test.cjs')
                + ',target=/app/pg_ledger_api_test.cjs,readonly']
        for key, value in env.items():
            args.extend(['-e', key + '=' + value])
        return args + [cls.image] + command

    @classmethod
    def image_command(cls, command, env):
        return cls.command(cls.image_args(command, env), check=False)

    def run_node_case(self, command, evidence, *, env=None, timeout=120, label='node'):
        """Run one node child, streaming its output into evidence so a timeout keeps it.

        A docker command names the run-owned self.container + '-node' without --rm: a failed
        run's exit state is read from the stopped container, which is removed here afterwards
        (cleanup() remains the backstop). A failure is reported, never retried.
        """
        evidence.mkdir(parents=True, exist_ok=True)
        name = command[command.index('--name') + 1] if command[0] == 'docker' else None
        stdout, stderr = evidence / (label + '.stdout.log'), evidence / (label + '.stderr.log')
        try:
            with stdout.open('wb') as out, stderr.open('wb') as err:
                try:
                    code = subprocess.run(command, stdout=out, stderr=err, env=env, timeout=timeout).returncode
                except subprocess.TimeoutExpired:
                    code = None
            output = stdout.read_text(encoding='utf-8', errors='replace')
            errors = stderr.read_text(encoding='utf-8', errors='replace')
            print(output)
            if code == 0:
                return
            found = TAP_SIGNAL.search(output + errors)
            number = -code if code is not None and code < 0 else code - 128 if name and code and code > 128 else None
            signal = found.group(1) if found else SIGNALS.get(number, 'SIG' + str(number)) if number else None
            self.native_evidence(evidence, label, command, name)
            headline = (('NATIVE_CRASH ' + signal) if signal else
                        ('TIMEOUT after %ds' % timeout) if code is None else ('exit %d' % code)) + ' ' + str(evidence)
            print(headline)
            if os.environ.get('GITHUB_STEP_SUMMARY'):
                with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as summary:
                    summary.write(headline + '\n')
            self.fail(headline + '\n' + errors[-2000:] + output[-2000:])
        finally:
            if name:
                observed = self.command(['docker', 'inspect', '--format', '{{ index .Config.Labels "kin.b2r" }}', name], check=False)
                if observed.returncode == 0 and observed.stdout.strip() == self.token:
                    self.command(['docker', 'rm', '-f', '-v', name], check=False)

    def native_evidence(self, evidence, label, command, name):
        def keep(suffix, args, tail=None):
            # Each record is written even when its source is missing; only a success's output is returned.
            row = None
            try:
                row = subprocess.run(args, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=60)
                text = row.stdout + row.stderr + ('' if row.returncode == 0 else '[exit %d]\n' % row.returncode)
            except (OSError, subprocess.TimeoutExpired) as error:
                text = 'unavailable: %s\n' % error
            if tail:
                text = '\n'.join(text.splitlines()[-tail:]) + '\n'
            (evidence / (label + suffix)).write_text(text, encoding='utf-8')
            return row.stdout if row and row.returncode == 0 else ''
        state = keep('.inspect.json', ['docker', 'inspect', '--format', '{{json .State}} {{.Id}}', name]) if name else ''
        # The runner grants passwordless sudo; elsewhere the refusal itself is recorded.
        keep('.dmesg.txt', ['sudo', '-n', 'dmesg', '-T'], tail=40)
        versions = {}
        if self.image:
            versions['image'] = keep('.image.txt', ['docker', 'image', 'inspect', '--format', '{{.Id}}', self.image]).strip()
            runtime = keep('.runtime.json', ['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'node',
                                             self.image, '-e', RUNTIME, '/app'])
        else:
            runtime = keep('.runtime.json', [command[0], '-e', RUNTIME, str(ROOT / 'api')])
        try:
            versions['runtime'] = json.loads(runtime)
        except ValueError:
            versions['runtime'] = runtime
        cpu = Path('/proc/cpuinfo')
        versions['cpu'] = next((line.split(':', 1)[1].strip() for line in cpu.read_text().splitlines()
                                if line.startswith('model name')), None) if cpu.exists() else None
        (evidence / (label + '.versions.json')).write_text(json.dumps(versions, indent=2), encoding='utf-8')
        # The container's own cgroup goes with it; its parent slice and this runner's keep the oom counts.
        groups = []
        if Path('/proc/self/cgroup').exists():
            groups.append(Path('/sys/fs/cgroup' + Path('/proc/self/cgroup').read_text().splitlines()[0].split(':', 2)[2]))
        if state.strip():
            groups.append(Path('/sys/fs/cgroup/system.slice/docker-' + state.split()[-1] + '.scope'))
        groups.append(Path('/sys/fs/cgroup/system.slice'))
        lines = []
        for group in groups:
            for item in ('memory.events', 'memory.peak'):
                try:
                    lines.append('== %s/%s\n%s' % (group, item, (group / item).read_text().strip()))
                except OSError as error:
                    lines.append('== %s/%s unavailable: %s' % (group, item, error))
        (evidence / (label + '.cgroup.txt')).write_text('\n'.join(lines) + '\n', encoding='utf-8')

    def node_case(self, case):
        evidence = ROOT / 'tmp/emr-b2-replace-20261023' / (case + '-' + self.token)
        if self.image:
            command = self.image_args(['node', '--max-old-space-size=3072', '/app/pg_ledger_api_test.cjs'], {
                'DATABASE_URL': self.runtime_url, 'KIN_B2R_WITNESS_URL': self.witness_url,
                'KIN_B2R_BUILD': '/app/dist', 'KIN_B2R_CASE': case, 'KIN_B2R_SPOOL': '/tmp/b2r-failure-spool',
            }, remove=False)
            env = None
        else:
            command = [os.environ['KIN_B2R_NODE'], '--max-old-space-size=3072', str(ROOT / 'tests/emr/b/pg_ledger_api_test.cjs')]
            env = {**os.environ, 'DATABASE_URL': self.runtime_url, 'KIN_B2R_CASE': case,
                   'KIN_B2R_WITNESS_URL': self.witness_url, 'KIN_B2R_SPOOL': str(evidence)}
        self.run_node_case(command, evidence, env=env)

    @classmethod
    def setUpClass(cls):
        gate.require_live_run()
        # Every case writes its evidence below this parent; a fresh checkout (CI) does not have it yet.
        (ROOT / 'tmp/emr-b2-replace-20261023').mkdir(parents=True, exist_ok=True)
        cls.token = uuid.uuid4().hex[:12]
        cls.container = 'emr-b2r-schema-' + cls.token
        cls.network = cls.container + '-net'
        print('owned fixture label: kin.b2r=' + cls.token)
        cls.created_container = cls.created_network = False
        cls.created_volumes = []
        cls.addClassCleanup(cls.cleanup)
        password = secrets.token_hex(24)
        cls.command(['docker', 'network', 'create', '--label', 'kin.b2r=' + cls.token, cls.network])
        cls.created_network = True
        storage = ['--tmpfs', '/var/lib/postgresql/data:rw,size=128m',
                   '--tmpfs', '/var/lib/postgresql/emr-access:rw,size=64m']
        if cls.disk_storage:
            storage = []
            for suffix, target in [('data','/var/lib/postgresql/data'),('ledger','/var/lib/postgresql/emr-access')]:
                name=cls.container+'-'+suffix
                cls.command(['docker','volume','create','--label','kin.b2r='+cls.token,name])
                cls.created_volumes.append(name)
                storage.extend(['--mount','type=volume,source='+name+',target='+target])
        cls.project_labels = []
        if cls.backup_project:
            cls.config_root = ROOT / 'tmp/emr-b2-replace-20261023' / ('backup-config-' + cls.token)
            cls.config_root.mkdir()
            cls.project_labels = ['--label', 'com.docker.compose.project=' + cls.container,
                                  '--label', 'com.docker.compose.project.working_dir=' + str(cls.config_root)]
        cls.command(['docker', 'run', '-d', '--name', cls.container, '--label', 'kin.b2r=' + cls.token,
                     *cls.project_labels,
                     '--network', cls.network, '--memory', cls.pg_memory, '--memory-swap', cls.pg_memory, '--cpus', '2',
                     *storage,
                     '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD=' + password,
                     '-e', 'POSTGRES_DB=' + cls.database_name, '-e', 'POSTGRES_USER=' + cls.admin_user, 'postgres:16-alpine'])
        cls.created_container = True
        for _ in range(60):
            # The image's temporary initdb server has only a Unix socket. Wait
            # for the final TCP listener so provisioning cannot race its stop.
            if cls.command(['docker', 'exec', cls.container, 'pg_isready', '-h', '127.0.0.1', '-U', cls.admin_user], check=False).returncode == 0:
                break
            time.sleep(0.25)
        else:
            raise RuntimeError('Owned PostgreSQL did not start')
        cls.command(['docker', 'exec', '-u', 'root', cls.container, 'sh', '-c',
                     'mkdir /var/lib/postgresql/emr-access/ts && chown postgres:postgres /var/lib/postgresql/emr-access/ts'])
        provision = cls.command([sys.executable, str(ROOT / 'scripts/emr-compose.py'), 'sql', 'provision']).stdout
        cls.runtime_password = secrets.token_hex(24)
        cls.command(['docker', 'exec', '-i', '-e', 'KIN_EMR_RUNTIME_PASSWORD=' + cls.runtime_password,
                     cls.container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
                     '-U', cls.admin_user, '-d', cls.database_name], data=provision)
        port = cls.command(['docker', 'port', cls.container, '5432/tcp']).stdout.strip().rsplit(':', 1)[1]
        cls.image = os.environ.get('KIN_TEST_API_IMAGE')
        env = {**os.environ, 'DATABASE_URL': f'postgresql://{cls.admin_user}:{password}@127.0.0.1:{port}/{cls.database_name}'}
        cls.witness_url = env['DATABASE_URL']
        cls.runtime_url = f'postgresql://kin_runtime:{cls.runtime_password}@127.0.0.1:{port}/{cls.database_name}'
        if cls.image:
            cls.witness_url = f'postgresql://{cls.admin_user}:{password}@{cls.container}:5432/{cls.database_name}'
            cls.runtime_url = f'postgresql://kin_runtime:{cls.runtime_password}@{cls.container}:5432/{cls.database_name}'
            result = cls.image_command(['node', '--max-old-space-size=3072', '/app/node_modules/prisma/build/index.js',
                                        'migrate', 'deploy'], {'DATABASE_URL': cls.witness_url})
        else:
            result = cls.command([os.environ['KIN_B2R_NODE'], '--max-old-space-size=3072',
                                  os.environ['KIN_B2R_PRISMA_CLI'], 'migrate', 'deploy',
                                  '--schema', str(ROOT / 'api/prisma/schema.prisma')], env=env, check=False)
        if result.returncode:
            evidence = ROOT / 'tmp/emr-b2-replace-20261023' / ('migration-' + cls.token)
            evidence.mkdir()
            logs = cls.command(['docker', 'logs', cls.container])
            (evidence / 'postgres.log').write_text(logs.stdout + logs.stderr, encoding='utf-8')
            (evidence / 'migration.stdout').write_text(result.stdout, encoding='utf-8')
            (evidence / 'migration.stderr').write_text(result.stderr, encoding='utf-8')
            print('Migration failure logs preserved:', evidence)
            raise RuntimeError(result.stderr[-2000:])
        print('normal migrate deploy completed:', '20261023180000_emr_pg_ledger' in result.stdout)

    @classmethod
    def cleanup(cls):
        failures = []
        if hasattr(cls, 'container'):
            name = cls.container + '-node'
            observed = cls.command(['docker', 'inspect', '--format', '{{ index .Config.Labels "kin.b2r" }}', name], check=False)
            if observed.returncode == 0:
                if observed.stdout.strip() != cls.token:
                    raise RuntimeError('Node fixture ownership differs; preserved')
                if cls.command(['docker', 'rm', '-f', '-v', name], check=False).returncode:
                    failures.append('node fixture cleanup failed')
        if cls.created_container:
            # Exact run-owned name and label, never a shared stack or source volume.
            observed = cls.command(['docker', 'inspect', '--format', '{{ index .Config.Labels "kin.b2r" }}', cls.container])
            if observed.stdout.strip() != cls.token:
                raise RuntimeError('Owned fixture label differs; preserved')
            result = cls.command(['docker', 'rm', '-f', '-v', cls.container], check=False)
            if result.returncode:
                failures.append('container cleanup failed')
        if cls.created_network:
            result = cls.command(['docker', 'network', 'rm', cls.network], check=False)
            if result.returncode:
                failures.append('network cleanup failed')
        for volume in getattr(cls,'created_volumes',[]):
            observed=cls.command(['docker','volume','inspect','--format','{{ index .Labels "kin.b2r" }}',volume])
            if observed.stdout.strip()!=cls.token:raise RuntimeError('Owned fixture volume label differs; preserved')
            if cls.command(['docker','volume','rm',volume],check=False).returncode:failures.append('volume cleanup failed')
        if failures:
            raise RuntimeError('; '.join(failures))

class PgLedgerRoleLive(PgLedgerFixture):
    def test_real_append_only_roles_red_green(self):
        event, operation, attempt = (str(uuid.uuid4()) for _ in range(3))
        payload = json.dumps(dict(eventId=event,occurredAt='2026-10-24T00:00:00.000Z',
            userId={'status':'unresolved','reason':'not-authenticated'},result='succeeded',
            targets=[dict(kind='report-version',recordId={'status':'known','value':'SYNTHETIC-role'},
                          versionId={'status':'known','value':'1'})]))
        literal = "'" + payload.replace("'", "''") + "'"
        self.sql(f"SELECT emr_access.admit_operation('{operation}','{attempt}',{literal},'기재')",'kin_runtime')
        self.sql(f"BEGIN; SELECT emr_access.lock_operation('{operation}'); "
            f"SELECT emr_access.append_operation('{operation}','{attempt}',{literal},'기재',NULL,NULL,NULL); COMMIT;",'kin_runtime')
        self.assertEqual(json.loads(self.sql(f"SELECT emr_access.operation_result('{operation}')",'kin_runtime').stdout)['outcome'],'committed')
        statement="UPDATE emr_access.access_entry SET recorded_at='2026-10-24T00:00:00Z'"
        def update_refused():
            result=self.sql('BEGIN; '+statement+'; ROLLBACK;', 'kin_runtime',check=False)
            self.assertNotEqual(result.returncode,0,'runtime must not update ledger rows')
        # Accidental permission grant is the omission mutant. Its transaction is
        # rolled back so the candidate's real row remains available for green.
        self.sql('GRANT UPDATE ON emr_access.access_entry TO kin_runtime')
        try:
            with self.assertRaises(AssertionError): update_refused()
        finally:
            self.sql('REVOKE UPDATE ON emr_access.access_entry FROM kin_runtime')
        update_refused()
        for statement in ['DELETE FROM emr_access.access_entry','TRUNCATE emr_access.access_entry']:
            self.assertNotEqual(self.sql('BEGIN; '+statement+'; ROLLBACK;','kin_runtime',check=False).returncode,0)
        self.assertEqual(len(json.loads(self.sql(f"SELECT emr_access.operation_result('{operation}')",'kin_runtime').stdout)['entries']),2)
        print('PASS real PG runtime append/read; UPDATE omission mutant red; UPDATE/DELETE/TRUNCATE candidate green')


class PgLedgerSchemaLive(PgLedgerFixture):
    def test_statutory_act_retry_binding(self):
        """D1792 delta only: identical payload/stream cannot change its statutory act."""
        definition = self.sql("SELECT pg_get_functiondef('emr_access.admit_operation(uuid,uuid,text,text)'::regprocedure);").stdout.strip()
        mutant = definition.replace("p_act || ':' || p_payload", 'p_payload')
        self.assertNotEqual(mutant, definition)

        def exercise(expect_refusal):
            operation, attempt = str(uuid.uuid4()), str(uuid.uuid4())
            payload = json.dumps(dict(eventId=str(uuid.uuid4()), occurredAt='2026-10-23T00:00:00.000Z',
                userId={'status': 'unresolved', 'reason': 'not-authenticated'}, result='succeeded', targets=[]))
            quoted = "'" + payload.replace("'", "''") + "'"
            admit = f"SELECT emr_access.admit_operation('{operation}','{attempt}',{quoted},'none');"
            self.assertEqual(self.sql(admit, 'kin_runtime').stdout.strip(), operation)
            changed = admit.replace("'none'", "'열람'")
            result = self.sql(changed, 'kin_runtime', check=False)
            if expect_refusal:
                self.assertNotEqual(result.returncode, 0, 'A retry must preserve its statutory act')
                self.assertNotEqual(self.sql(changed.replace(operation, str(uuid.uuid4())).replace(attempt, str(uuid.uuid4())),
                    'kin_runtime', check=False).returncode, 0)
                self.assertNotEqual(self.sql(f"SELECT emr_access.append_operation('{operation}','{attempt}',{quoted},'열람',NULL,NULL,NULL);",
                    'kin_runtime', check=False).returncode, 0)
                self.assertEqual(self.sql(admit, 'kin_runtime').stdout.strip(), operation)
            return result.returncode

        try:
            self.sql(mutant)
            with self.assertRaises(AssertionError):
                exercise(True)
        finally:
            self.sql(definition)
        exercise(True)
        print(json.dumps({'status': 'PASS', 'delta': 'statutory act binding',
            'red': 'admission omission accepts changed act; behavioral refusal assertion fails',
            'green': 'same K, new K/logical event, and append reject changed act; exact retry succeeds'}))

    def test_pg_schema_atomicity_dedup_and_expiry(self):
        declared = json.loads((ROOT/'emr/units/b.json').read_text(encoding='utf-8'))
        installed = json.loads(self.sql("SELECT json_agg(c.relname ORDER BY c.relname) FROM pg_class c "
            "JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='emr_access' AND c.relkind IN ('r','p');").stdout)
        self.assertEqual(installed, sorted(declared['deployment']['tables']), 'Installed catalog must match the declaration')
        q = lambda s: "'" + s.replace("'", "''") + "'"
        event = dict(eventId=str(uuid.uuid4()), occurredAt='2020-01-01T00:00:00.000Z',
                     userId={'status': 'unresolved', 'reason': 'not-authenticated'}, result='succeeded',
                     targets=[dict(kind='report', recordId={'status': 'known', 'value': 'synthetic-record'},
                                   versionId={'status': 'known', 'value': 'v1'})])
        payload = json.dumps(event, separators=(',', ':'))
        op, attempt = str(uuid.uuid4()), str(uuid.uuid4())
        admit = f"SELECT emr_access.admit_operation('{op}','{attempt}',{q(payload)},'기재');"
        self.assertEqual(self.sql(admit, 'kin_runtime').stdout.strip(), op)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            duplicates = list(pool.map(lambda _: self.sql(admit, 'kin_runtime').stdout.strip(), range(2)))
        self.assertEqual(duplicates, [op, op])
        changed = payload.replace('v1', 'v2')
        self.assertNotEqual(self.sql(admit.replace(q(payload), q(changed)), 'kin_runtime', check=False).returncode, 0)
        self.sql('CREATE TABLE public.b2r_business(id text PRIMARY KEY); GRANT SELECT,INSERT ON public.b2r_business TO kin_runtime;')
        append = f"SELECT emr_access.append_operation('{op}','{attempt}',{q(payload)},'기재','fixture','effect','v1');"
        rolled_back = self.sql(f"BEGIN; SELECT emr_access.lock_operation('{op}'); INSERT INTO public.b2r_business VALUES ('effect'); {append} SELECT 1/0; COMMIT;", 'kin_runtime', check=False)
        self.assertNotEqual(rolled_back.returncode, 0)
        self.assertEqual(self.sql('SELECT (SELECT count(*) FROM public.b2r_business)+(SELECT count(*) FROM emr_access.access_entry)+(SELECT count(*) FROM emr_access.attempt_outcome);').stdout.strip(), '0')
        self.sql(f"BEGIN; SELECT emr_access.lock_operation('{op}'); INSERT INTO public.b2r_business VALUES ('effect'); {append} COMMIT;", 'kin_runtime')
        self.assertEqual(self.sql('SELECT (SELECT count(*) FROM public.b2r_business)::text || \',\' || (SELECT count(*) FROM emr_access.access_entry)::text || \',\' || (SELECT count(*) FROM emr_access.attempt_outcome)::text;').stdout.strip(), '1,2,1')
        before = json.loads(self.sql(f"SELECT emr_access.operation_result('{op}');", 'kin_runtime').stdout)
        self.assertEqual(json.loads(self.sql(append, 'kin_runtime').stdout), before)
        self.assertEqual(json.loads(self.sql(f"SELECT emr_access.settle_operation('{op}');", 'kin_runtime').stdout), before)
        self.assertEqual(self.sql("SELECT count(*) FROM emr_access.storage_placement() WHERE tablespace <> 'kin_emr_access';").stdout.strip(), '0')
        for sql in ['DELETE FROM emr_access.access_entry', 'UPDATE emr_access.operation SET pending=true',
                    'TRUNCATE emr_access.attempt', "SELECT emr_access.expire_entry('" + before['entries'][0]['entryId'] + "')"]:
            self.assertNotEqual(self.sql(sql, 'kin_runtime', check=False).returncode, 0)
        viewing = next(e['entryId'] for e in before['entries'] if e['stream'] == 'viewing')
        self.assertEqual(self.sql(f"SELECT emr_access.expire_entry('{viewing}');", 'kin_emr_retention').stdout.strip(), 't')
        replay = json.loads(self.sql(append, 'kin_runtime').stdout)
        self.assertTrue(next(e['expired'] for e in replay['entries'] if e['stream'] == 'viewing'))
        self.assertEqual(self.sql('SELECT count(*) FROM public.b2r_business;').stdout.strip(), '1')
        new_attempt = str(uuid.uuid4())
        self.assertEqual(self.sql(admit.replace(attempt, new_attempt).replace(op, str(uuid.uuid4())), 'kin_runtime').stdout.strip(), op)
        self.assertEqual(self.sql('SELECT count(*) FROM emr_access.access_entry;').stdout.strip(), '1')


class PgLedgerAdapterLive(PgLedgerFixture):
    def test_public_pg_adapter(self):
        self.node_case('adapter')


class PgLedgerFailureFilesLive(unittest.TestCase):
    def test_real_enospc_fsync_and_partial_restart(self):
        gate.require_live_run()
        token=uuid.uuid4().hex[:12];name='emr-b2r-spool-'+token
        evidence=ROOT/'tmp/emr-b2-replace-20261023'/('failure-files-'+token);evidence.mkdir()
        args=['docker','run','--rm','--name',name,'--label','kin.b2r='+token,'--network','none',
              '--memory','1536m','--memory-swap','1536m','--cpus','2',
              '--tmpfs','/failure:rw,size=64m,mode=1777', # Existing JOURNAL_MAX_BYTES; fill only this owned mount.
              '--mount','type=bind,source='+str(ROOT/'tests/emr/b/pg_ledger_api_test.cjs')+',target=/app/pg_ledger_api_test.cjs,readonly',
              '-e','KIN_B2R_CASE=failure-files','-e','KIN_B2R_SPOOL=/failure','-e','KIN_B2R_BUILD=/app/dist',
              os.environ['KIN_TEST_API_IMAGE'],'node','--max-old-space-size=3072','/app/pg_ledger_api_test.cjs']
        try:
            with (evidence/'node.stdout').open('wb') as out,(evidence/'node.stderr').open('wb') as err:
                result=subprocess.run(args,stdout=out,stderr=err,timeout=120)
            self.assertEqual(result.returncode,0,(evidence/'node.stderr').read_text(errors='replace')[-2000:])
        finally:
            found=PgLedgerFixture.command(['docker','ps','-aq','--filter','name=^/'+name+'$','--filter','label=kin.b2r='+token]).stdout.strip()
            if found:PgLedgerFixture.command(['docker','rm','-f','-v',name])


class PgLedgerConcurrencyLive(PgLedgerFixture):
    def test_concurrent_receipts(self):
        self.node_case('concurrency')


class PgLedgerCrashLive(PgLedgerFixture):
    def test_process_cuts_and_settlement(self):
        self.node_case('crash')


class PgLedgerContextLive(PgLedgerFixture):
    def test_actual_hold_clause_and_order_snapshot(self):
        self.node_case('context')


class PgLedgerPlanLive(PgLedgerFixture):
    disk_storage=True
    pg_memory='2g'  # Existing first-site A11 PostgreSQL allowance.

    def test_indexed_outcome_and_pending_plans(self):
        # The first declared numeric rung, on actual tables and installed indexes.
        count=100000
        self.sql(f"""INSERT INTO emr_access.operation(operation_id,event_id,content_sha256,actor_sha256,streams,pending)
          SELECT md5('plan-operation-'||n)::uuid,'synthetic-plan-'||n,repeat('a',64),repeat('b',64),ARRAY['viewing'],false
          FROM generate_series(1,{count}) n;
          INSERT INTO emr_access.attempt_outcome(operation_id,outcome) SELECT operation_id,'negative' FROM emr_access.operation;
          ANALYZE emr_access.operation; ANALYZE emr_access.attempt_outcome;""")
        selected=self.sql("SELECT md5('plan-operation-50000')::uuid").stdout.strip()
        evidence=ROOT/'tmp/emr-b2-replace-20261023'/('plans-'+self.token);evidence.mkdir()
        for name,query in [('key',f"SELECT * FROM emr_access.operation WHERE operation_id='{selected}'"),
                           ('pending',"SELECT operation_id FROM emr_access.operation WHERE pending ORDER BY admitted_at,operation_id LIMIT 128")]:
            plan=json.loads(self.sql('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+query).stdout)
            (evidence/(name+'.json')).write_text(json.dumps(plan,indent=2))
            def nodes(p):
                yield p
                for child in p.get('Plans',[]):yield from nodes(child)
            self.assertTrue(any('Index' in n['Node Type'] for n in nodes(plan[0]['Plan'])),name)
        self.assertEqual(json.loads(self.sql(f"SELECT emr_access.operation_result('{selected}')",'kin_runtime').stdout)['outcome'],'negative')
        self.assertEqual(self.sql('SELECT count(*) FROM emr_access.operation').stdout.strip(),str(count))


class PgLedgerFirstSiteLive(PgLedgerFixture):
    """D1806 item 8: one 6M-key, 600s run and one API+PG kill/restart."""
    disk_storage = True
    pg_memory = '2g'  # Existing A11 PG allocation; API/VM RAM is measured, not gated.

    def test_first_site_and_restart(self):
        evidence = ROOT / 'tmp/emr-b2-replace-20261023' / ('first-site-' + self.token)
        evidence.mkdir()
        seed_start = time.monotonic()
        # Terminal synthetic dual-stream operations populate the actual key
        # indexes. This is 6M keys, not 6M retained clinical payloads.
        for first in range(1, 3000001, 100000):
            last = first + 99999
            self.sql(f"""BEGIN;
                INSERT INTO emr_access.operation(operation_id,event_id,content_sha256,actor_sha256,streams,pending)
                SELECT md5('scale-'||n)::uuid,'synthetic-scale-'||n,repeat('a',64),repeat('b',64),
                       ARRAY['viewing','history'],false FROM generate_series({first},{last}) n;
                INSERT INTO emr_access.attempt(stream,attempt_id,operation_id)
                SELECT stream,md5('scale-'||n)::uuid,md5('scale-'||n)::uuid
                FROM generate_series({first},{last}) n CROSS JOIN unnest(ARRAY['viewing','history']) stream;
                INSERT INTO emr_access.attempt_outcome(operation_id,outcome)
                SELECT md5('scale-'||n)::uuid,'negative' FROM generate_series({first},{last}) n;
                COMMIT;""")
        self.sql('ANALYZE emr_access.operation; ANALYZE emr_access.attempt; ANALYZE emr_access.attempt_outcome;')
        keys = int(self.sql('SELECT count(*) FROM emr_access.attempt').stdout.strip())
        self.assertEqual(keys, 6000000)
        seed = {'streamAttemptKeys': keys, 'operations': 3000000, 'seconds': time.monotonic()-seed_start,
                'contents': 'synthetic terminal negative operations; no retained clinical payload population'}
        (evidence/'seed.json').write_text(json.dumps(seed,indent=2))
        name = self.container + '-node'
        config = {'DEPLOYMENT_MODE':'production','AUTH_REQUIRED':'true',
            'KC_ISSUER':'http://127.0.0.1:9/realms/synthetic','KC_JWKS_URL':'http://127.0.0.1:9/jwks',
            'KC_ADMIN_URL':'http://127.0.0.1:9','KC_AUDIENCE':'synthetic-api',
            'KC_WEB_SECRET':secrets.token_hex(32),'KIN_COOKIE_SECRET':secrets.token_hex(32),
            'KC_CLIENT_SECRET':secrets.token_hex(32),'ORTHANC_URL':'http://127.0.0.1:9',
            'ORTHANC_USER':'synthetic','ORTHANC_PASS':secrets.token_hex(32),
            'PUBLIC_ORIGIN':'https://synthetic.invalid','KIN_EMR_STATE_DIR':'/tmp/emr-state',
            'DATABASE_URL':self.runtime_url,'KIN_B2R_BUILD':'/app/dist',
            'KIN_B2R_CASE':'scale-server','KIN_B2R_SPOOL':'/tmp/emr-state/outage'}
        args=['docker','run','-d','--name',name,'--label','kin.b2r='+self.token,'--network',self.network]
        for filename in ['pg_ledger_api_test.cjs','pg_ledger_profile.cjs']:
            args += ['--mount','type=bind,source='+str(ROOT/'tests/emr/b'/filename)+',target=/app/'+filename+',readonly']
        for key,value in config.items(): args += ['-e',key+'='+value]
        self.command(args+[self.image,'node','/app/pg_ledger_api_test.cjs'])
        result=None
        deadline=time.monotonic()+900  # Hang timeout, not a workload/pass budget.
        while time.monotonic()<deadline:
            logs=self.command(['docker','logs',name],check=False)
            lines=[line for line in logs.stdout.splitlines() if line.startswith('B2R_SCALE_RESULT ')]
            if lines:
                result=json.loads(lines[-1].split(' ',1)[1]);break
            state=json.loads(self.command(['docker','inspect',name]).stdout)[0]['State']
            if not state['Running']:
                self.fail('Scale API exited: '+logs.stderr[-1500:]+logs.stdout[-1500:])
            time.sleep(2)
        (evidence/'api.log').write_text(logs.stdout+logs.stderr)
        self.assertIsNotNone(result,'Scale workload did not finish')
        memory={line.split(':')[0]:line.split(':')[1].strip() for line in Path('/proc/meminfo').read_text().splitlines()}
        result['vmRamBytes']=int(memory['MemTotal'].split()[0])*1024
        disk=self.command(['docker','exec',self.container,'du','-sk',
            '/var/lib/postgresql/data','/var/lib/postgresql/emr-access']).stdout
        result['diskBytes']=sum(int(line.split()[0])*1024 for line in disk.splitlines())
        result['seed']=seed
        self.command(['docker','kill','--signal','KILL',name,self.container])
        started=time.monotonic()
        self.command(['docker','start',self.container])
        while time.monotonic()-started<300:
            if self.command(['docker','exec',self.container,'pg_isready','-U',self.admin_user],check=False).returncode==0:
                break
            time.sleep(.5)
        self.command(['docker','start',name])
        ready=False
        while time.monotonic()-started<300:
            logs=self.command(['docker','logs',name],check=False)
            if '"phase":"restarted"' in logs.stdout:
                ready=True;break
            time.sleep(.5)
        result['restartToReadySeconds']=time.monotonic()-started
        result['restartReady']=ready
        result['reverifyTrigger']='A11-SITE-RESIZE-D1732: verify first-site assumptions before use and before a larger site'
        (evidence/'result.json').write_text(json.dumps(result,indent=2))
        (evidence/'api.log').write_text(logs.stdout+logs.stderr)
        self.assertTrue(ready,'API and PG must recover within 300 seconds')
        self.assertEqual(result['completed'],1200)
        self.assertEqual(result['errors'],[])
        self.assertLessEqual(result['admissionP95Ms'],100)
        self.assertLessEqual(result['durableReceiptP95Ms'],500)
        self.assertEqual(int(self.sql('SELECT count(*) FROM emr_access.attempt').stdout.strip()),6002400)
        print(json.dumps(result))


class PgLedgerRequestWorkLive(PgLedgerFixture):
    def test_request_identity_and_drain(self):
        self.node_case('request-work')


class PgLedgerAuthFailureLive(PgLedgerFixture):
    def test_auth_failure_http_and_projection(self):
        self.node_case('auth-failure')


class PgLedgerAuthSuccessLive(PgLedgerFixture):
    def test_login_entry_atomic_publication(self):
        self.node_case('auth-success')


class PgLedgerAuthEndLive(PgLedgerFixture):
    def test_session_ending_atomic_publication(self):
        self.node_case('auth-end')


class PgLedgerRightsLive(PgLedgerFixture):
    def test_rights_and_isolation_atomic_publication(self):
        self.node_case('rights')


class PgLedgerImportLive(PgLedgerFixture):
    def test_import_atomicity_and_restart(self):
        self.node_case('rights-import')


class PgLedgerStartupLive(PgLedgerFixture):
    def test_real_application_start_resume_and_stop(self):
        import urllib.request
        import urllib.error
        from unittest.mock import patch
        sys.path.insert(0, str(ROOT / 'scripts'))
        import ops_backup as ops
        evidence = ROOT / 'tmp/emr-b2-replace-20261023' / ('startup-' + self.token)
        evidence.mkdir()
        compose_file = evidence / 'compose.json'
        name = None
        config = {'DEPLOYMENT_MODE':'production','AUTH_REQUIRED':'true',
            'KC_ISSUER':'http://127.0.0.1:9/realms/synthetic','KC_JWKS_URL':'http://127.0.0.1:9/jwks',
            'KC_ADMIN_URL':'http://127.0.0.1:9','KC_AUDIENCE':'synthetic-api',
            'KC_WEB_SECRET':secrets.token_hex(32),'KIN_COOKIE_SECRET':secrets.token_hex(32),
            'KC_CLIENT_SECRET':secrets.token_hex(32),'ORTHANC_URL':'http://127.0.0.1:9',
            'ORTHANC_USER':'synthetic','ORTHANC_PASS':secrets.token_hex(32),
            'PUBLIC_ORIGIN':'https://synthetic.invalid','KIN_EMR_STATE_DIR':'/var/lib/kin-emr',
            'NODE_OPTIONS':'--max-old-space-size=3072'}
        def start(url):
            nonlocal name
            compose_file.write_text(json.dumps({'services': {'api': {
                'image': self.image, 'labels': {'kin.b2r': self.token},
                'environment': {**config, 'DATABASE_URL': url},
                'mem_limit': '1536m', 'memswap_limit': '1536m',
                'ports': ['127.0.0.1::3000'], 'networks': ['fixture']}},
                'networks': {'fixture': {'external': True, 'name': self.network}}}), encoding='utf-8')
            # Real image CMD; Compose inherits this run's COMPOSE_PROJECT_NAME.
            with patch.dict(os.environ, {'COMPOSE_FILE': str(compose_file)}):
                subprocess.run(['docker','compose','up','-d','api'], cwd=ROOT,
                               capture_output=True, text=True, check=True, timeout=120)
                name = subprocess.run(['docker','compose','ps','-aq','api'], cwd=ROOT,
                                      capture_output=True, text=True, check=True, timeout=30).stdout.strip()
        def inspect():
            return json.loads(self.command(['docker','inspect',name]).stdout)[0]
        def logs(label):
            row=self.command(['docker','logs',name],check=False)
            (evidence/(label+'.log')).write_text(row.stdout+row.stderr,encoding='utf-8')
        start(self.witness_url)
        deadline=time.monotonic()+60
        while inspect()['State']['Running'] and time.monotonic()<deadline: time.sleep(.1)
        rejected=inspect();logs('wrong-role')
        self.assertFalse(rejected['State']['Running'],'Installer credentials must not open the API')
        self.assertNotEqual(rejected['State']['ExitCode'],0)
        self.command(['docker','rm',name])
        start(self.runtime_url)
        self.addCleanup(self.command, ['docker','rm','-f',name])
        observations=[]
        for phase in ['initial-start','backup-resume']:
            # Docker may allocate a different ephemeral host port on restart.
            port=inspect()['NetworkSettings']['Ports']['3000/tcp'][0]['HostPort']
            origin='http://127.0.0.1:'+port
            health=None
            deadline=time.monotonic()+60
            while time.monotonic()<deadline:
                try:
                    with urllib.request.urlopen(origin+'/api/health',timeout=2) as response:
                        health=json.load(response)
                    if health.get('ok') is True:break
                except (OSError,ValueError):pass
                if not inspect()['State']['Running']:break
                time.sleep(.1)
            else:health=None
            logs(phase)
            self.assertIsNotNone(health,'Actual AppModule did not become ready')
            self.assertTrue(health['auth'])
            # Invoke the backup driver's real readiness command against this
            # fixture's resumed API through its owning Compose project.
            def owned_run(args, **kwargs):
                self.assertEqual(args[:3], ['docker', 'exec', ops.ROLE_KEYS['api']])
                with patch.dict(os.environ, {'COMPOSE_FILE': str(compose_file)}):
                    return subprocess.run(['docker','compose','exec','-T','api',*args[3:]], cwd=ROOT,
                                          capture_output=True, text=True, check=True, **kwargs)
            with patch.object(ops, 'run', side_effect=owned_run):
                ops.resumed_ledger_ready(30)
            with self.assertRaises(urllib.error.HTTPError) as refused:
                urllib.request.urlopen(origin+'/api/studies',timeout=2)
            self.assertEqual(refused.exception.code,401)
            self.command(['docker','stop','--time','20',name],timeout=30)
            stopped=inspect()['State'];logs(phase+'-stopped')
            self.assertFalse(stopped['OOMKilled'])
            self.assertIn(stopped['ExitCode'],[0,143],stopped) # Nest re-emits SIGTERM after shutdown hooks.
            self.assertNotIn('Shutdown did not complete cleanly',(evidence/(phase+'-stopped.log')).read_text())
            observations.append({'phase':phase,'health':health,'exit':stopped['ExitCode']})
            if phase=='initial-start':self.command(['docker','start',name])
        (evidence/'observations.json').write_text(json.dumps(observations,indent=2),encoding='utf-8')
        print('PASS actual production CMD/AppModule: wrong-role refusal, HTTP readiness, protected 401, stop and resume')


class PgLedgerClinicalHttpLive(PgLedgerFixture):
    def test_real_clinical_http_fail_closed(self):
        self.node_case('clinical-http')


class PgLedgerRetentionLive(PgLedgerFixture):
    def test_failure_expiry_and_delayed_spool_replay(self):
        current, expired, held = [str(uuid.uuid4()) for _ in range(3)]
        event = str(uuid.uuid4())
        for failure, at in [(current, 'now()'), (expired, "'2020-02-29T00:00:00Z'"), (held, "'2020-01-01T00:00:00Z'")]:
            self.sql(f"SELECT emr_access.record_failure('{failure}',NULL,'{event}',{at},'ledger-unreachable');", 'kin_runtime')
        definition = self.sql("SELECT pg_get_functiondef('emr_access.expire_failure(uuid)'::regprocedure);").stdout
        mutant = definition.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION', 1).replace(
            "IF emr_access.civil_period_end(f.occurred_at,2)>clock_timestamp() THEN", 'IF false THEN')
        self.assertNotEqual(mutant, definition)
        try:
            self.sql(mutant)
            # Roll back the mutant's early deletion while retaining its actual wrong result.
            red = self.sql(f"BEGIN; SELECT emr_access.expire_failure('{current}'); ROLLBACK;", 'kin_emr_retention', check=False)
            self.assertEqual(red.returncode, 0)
            with self.assertRaises(AssertionError):
                self.assertNotEqual(red.returncode, 0, 'Unexpired failure must be refused')
        finally:
            self.sql(definition.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION', 1))
        self.assertNotEqual(self.sql(f"SELECT emr_access.expire_failure('{current}');", 'kin_emr_retention', check=False).returncode, 0)
        self.assertNotEqual(self.sql(f"SELECT emr_access.expire_failure('{expired}');", 'kin_runtime', check=False).returncode, 0)
        self.assertEqual(self.sql(f"SELECT emr_access.expire_failure('{expired}');", 'kin_emr_retention').stdout.strip(), 't')
        self.sql(f"SELECT emr_access.record_failure('{expired}',NULL,'{event}','2020-02-29T00:00:00Z','ledger-unreachable');", 'kin_runtime')
        self.assertEqual(self.sql(f"SELECT count(*) FROM emr_access.failure_entry WHERE failure_id='{expired}';").stdout.strip(), '0')
        self.assertNotEqual(self.sql(f"SELECT emr_access.record_failure('{expired}',NULL,'{event}','2020-02-29T00:00:00Z','capacity');", 'kin_runtime', check=False).returncode, 0)
        hold = str(uuid.uuid4())
        body = dict(holdId=hold, recordId=event, basis='synthetic retention hold', actorId='fixture', at='2020-01-01T00:00:00Z', release=None)
        encoded = json.dumps(body)
        self.sql(f"SELECT emr_access.place_hold('{hold}','{event}','{encoded}');", 'kin_runtime')
        self.assertNotEqual(self.sql(f"SELECT emr_access.expire_failure('{held}');", 'kin_emr_retention', check=False).returncode, 0)
        body['release'] = dict(at='2026-10-23T00:00:00Z', actorId='fixture', reason='synthetic hold ended')
        encoded = json.dumps(body)
        self.sql(f"SELECT emr_access.release_hold('{hold}','{encoded}');", 'kin_runtime')
        self.assertEqual(self.sql(f"SELECT emr_access.expire_failure('{held}');", 'kin_emr_retention').stdout.strip(), 't')
        self.assertEqual(self.sql(f"SELECT count(*) FROM emr_access.disposal_fact WHERE failure_id IN ('{expired}','{held}') AND basis='retention-elapsed' AND disposed_at IS NOT NULL;").stdout.strip(), '2')
        print(json.dumps({'status': 'PASS', 'boundary': 'actual SQL failure expiry, hold and duplicate spool import',
            'red': 'early-expiry mutant accepts an unexpired failure', 'disposal': 'expired failure rows deleted and disposal facts retained'}))


class PgLedgerRetentionAdapterLive(PgLedgerFixture):
    def test_actual_history_graph_to_row_expiry(self):
        self.node_case('retention-adapter')


class PgLedgerHistoryRetentionLive(PgLedgerFixture):
    def test_history_endings_and_no_resurrection(self):
        event, operation, attempt = (str(uuid.uuid4()) for _ in range(3))
        targets = [dict(kind='report-version', recordId={'status':'known','value':'record-'+str(i)},
            versionId={'status':'known','value':'v1'}) for i in range(2)]
        payload = json.dumps(dict(eventId=event,occurredAt='2020-01-01T00:00:00Z',
            userId={'status':'unresolved','reason':'not-authenticated'},result='succeeded',targets=targets))
        literal = "'" + payload.replace("'", "''") + "'"
        self.sql(f"SELECT emr_access.admit_operation('{operation}','{attempt}',{literal},'기재')", 'kin_runtime')
        self.sql(f"SELECT emr_access.append_operation('{operation}','{attempt}',{literal},'기재',NULL,NULL,NULL)", 'kin_runtime')
        history = self.sql(f"SELECT entry_id FROM emr_access.entry_receipt WHERE operation_id='{operation}' AND stream='history'").stdout.strip()
        view = self.sql(f"SELECT entry_id FROM emr_access.entry_receipt WHERE operation_id='{operation}' AND stream='viewing'").stdout.strip()
        endings = [dict(recordId='record-'+str(i),versionId='v1',kind='report-version',endsAt='2025-01-01T00:00:00Z',
                        evidenceId='synthetic-H-ending') for i in range(2)]
        def expire(ends, check=False):
            encoded = json.dumps(ends).replace("'", "''")
            return self.sql(f"SELECT emr_access.expire_entry('{history}','{encoded}'::jsonb)", 'kin_emr_retention', check=check)
        self.assertNotEqual(self.sql(f"SELECT emr_access.expire_entry('{history}')", 'kin_emr_retention', check=False).returncode,0)
        for incomplete in ([], endings[:1], [*endings[:1],{**endings[1],'versionId':'v2'}],
                           [*endings[:1],{**endings[1],'endsAt':'2030-01-01T00:00:00Z'}]):
            self.assertNotEqual(expire(incomplete).returncode,0)
        hold = str(uuid.uuid4())
        body = dict(holdId=hold,recordId='record-0',basis='synthetic actual hold',actorId='fixture',at='2020-01-01T00:00:00Z',release=None)
        self.sql(f"SELECT emr_access.place_hold('{hold}','record-0','{json.dumps(body)}')", 'kin_runtime')
        self.assertNotEqual(expire(endings).returncode,0)
        released = {**body,'release':{'holdId':hold,'evidenceId':'synthetic-release'}}
        self.sql(f"SELECT emr_access.release_hold('{hold}','{json.dumps(released)}')", 'kin_runtime')
        definition = self.sql("SELECT pg_get_functiondef('emr_access.expire_entry(uuid,jsonb)'::regprocedure)").stdout
        mutant = definition.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1).replace("IF e.retention_class='record-history' THEN", 'IF false THEN')
        self.assertNotEqual(mutant,definition)
        try:
            self.sql(mutant)
            red=self.sql(f"BEGIN;SELECT emr_access.expire_entry('{history}');ROLLBACK",'kin_emr_retention',check=False)
            with self.assertRaises(AssertionError):
                self.assertNotEqual(red.returncode,0,'Unknown record ending must preserve history')
        finally:
            self.sql(definition.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1))
        self.assertEqual(expire(endings,check=True).stdout.strip(),'t')
        self.assertEqual(self.sql(f"SELECT emr_access.expire_entry('{view}')",'kin_emr_retention').stdout.strip(),'t')
        self.assertEqual(self.sql(f"SELECT count(*) FROM emr_access.access_entry WHERE event_id='{event}'").stdout.strip(),'0')
        self.assertEqual(self.sql(f"SELECT count(*) FROM emr_access.disposal_fact WHERE entry_id IN ('{history}','{view}')").stdout.strip(),'2')
        self.sql(f"SELECT emr_access.append_operation('{operation}','{attempt}',{literal},'기재',NULL,NULL,NULL)", 'kin_runtime')
        self.assertEqual(self.sql(f"SELECT count(*) FROM emr_access.access_entry WHERE event_id='{event}'").stdout.strip(),'0')
        outcome = json.loads(self.sql(f"SELECT emr_access.operation_result('{operation}')",'kin_runtime').stdout)
        self.assertEqual(outcome['outcome'],'committed')
        self.assertTrue(all(e['expired'] for e in outcome['entries']))
        print('PASS history: unknown/partial/future/held refused; row DELETE; minimal receipt; no retry resurrection; D1794 backups age by rotation')


class PgLedgerRestoreSweepLive(PgLedgerFixture):
    def test_restored_expiry_before_business_use(self):
        events = []
        for act, at, kind in [('none','2020-01-01T00:00:00Z','system-operation'),
                              ('수정','2024-01-01T00:00:00Z','identity-access'),
                              ('기재','2010-01-01T00:00:00Z','report-version')]:
            event, operation, attempt = (str(uuid.uuid4()) for _ in range(3))
            targets = [dict(kind=kind,recordId={'status':'known','value':'synthetic-record'},
                           versionId={'status':'known','value':'v1'})]
            payload=json.dumps(dict(eventId=event,occurredAt=at,userId={'status':'unresolved','reason':'not-authenticated'},
                result='succeeded',action='rights.changed' if kind=='identity-access' else 'write',targets=targets))
            literal="'"+payload.replace("'","''")+"'"
            self.sql(f"SELECT emr_access.admit_operation('{operation}','{attempt}',{literal},'{act}')",'kin_runtime')
            self.sql(f"SELECT emr_access.append_operation('{operation}','{attempt}',{literal},'{act}',NULL,NULL,NULL)",'kin_runtime')
            events.append((event,operation))
        failure,held=(str(uuid.uuid4()) for _ in range(2))
        for value in (failure,held):
            self.sql(f"SELECT emr_access.record_failure('{value}',NULL,'{value}','2020-01-01','ledger-unreachable')",'kin_runtime')
        hold=str(uuid.uuid4());body=json.dumps(dict(holdId=hold,recordId=held,release=None,
            basis='synthetic actual hold',actorId='fixture',at='2020-01-01T00:00:00Z'))
        self.sql(f"SELECT emr_access.place_hold('{hold}','{held}','{body}')",'kin_runtime')
        self.assertEqual(self.sql("SELECT has_function_privilege('kin_runtime','emr_access.restore_expiry_sweep(jsonb)','EXECUTE')").stdout.strip(),'f')
        definition=self.sql("SELECT pg_get_functiondef('emr_access.restore_expiry_sweep(jsonb)'::regprocedure)").stdout
        mutant=definition.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1).replace('unknown_history:=unknown_history+1','unknown_history:=unknown_history')
        self.assertNotEqual(mutant,definition)
        try:
            self.sql(mutant)
            red=json.loads(self.sql('BEGIN;SELECT emr_access.restore_expiry_sweep();ROLLBACK','kin_emr_retention').stdout)
            with self.assertRaises(AssertionError):
                self.assertEqual(red['historyRetainedUnknownLifetime'],1,'Retained unknown history must be counted')
        finally:self.sql(definition.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1))
        first=json.loads(self.sql('SELECT emr_access.restore_expiry_sweep()','kin_emr_retention').stdout)
        self.assertEqual((first['ran'],first['complete'],first['historyRetainedUnknownLifetime']),(True,True,1))
        self.assertEqual((first['deletedEntries'],first['deletedFailures'],first['retainedByDutyOrHold']),(2,1,1))
        self.assertEqual(self.sql(f"SELECT count(*) FROM emr_access.access_entry WHERE event_id='{events[1][0]}'").stdout.strip(),'1','rights keep their three-year floor')
        history=self.sql(f"SELECT entry_id FROM emr_access.access_entry WHERE event_id='{events[2][0]}' AND stream='history'").stdout.strip()
        self.assertTrue(history,'Unknown-lifetime history must remain in the restored database')
        # Actual H graph/classification is independently exercised by the H
        # adapter case; this SQL boundary receives that complete ending result.
        endings=json.dumps({history:[dict(recordId='synthetic-record',versionId='v1',kind='report-version',
            endsAt='2015-01-01T00:00:00Z',evidenceId='synthetic-verified-H-graph')]})
        final=json.loads(self.sql(f"SELECT emr_access.restore_expiry_sweep('{endings}')",'kin_emr_retention').stdout)
        self.assertEqual((final['complete'],final['deletedEntries'],final['historyRetainedUnknownLifetime']),(True,1,0))
        self.assertEqual(self.sql(f"SELECT count(*) FROM emr_access.failure_entry WHERE failure_id='{held}'").stdout.strip(),'1')
        print('PASS restore sweep: actual row expiry; rights/hold retained; unknown history retained/counted; count-omission mutant red')


class PgLedgerImportCliLive(PgLedgerFixture):
    def test_actual_cli_import_publication_retry_and_process_exit(self):
        """CONSUMER-01: the shipped CLI, real PG and Keycloak HTTP boundary.

        The provider is synthetic; no realm, account or original database is used.
        Separate PG observations prove import commit precedes roster publication.
        """
        script = r"""
const assert=require('node:assert/strict'),http=require('node:http'),{spawn}=require('node:child_process');
const {PrismaClient}=require('/app/node_modules/@prisma/client');
const witness=new PrismaClient({datasources:{db:{url:process.env.KIN_B2R_WITNESS_URL}}});
const subject='synthetic-cli-member', observed=[], requests=[];
let publicationFails=true, server;
async function state(){
  const [row]=await witness.$queryRawUnsafe(`SELECT json_build_object(
    'entries',(SELECT count(*) FROM emr_access.access_entry WHERE retention_class='rights3y'),
    'markers',(SELECT count(*) FROM public."MemberRightsImport"),
    'rights',(SELECT count(*) FROM public."MemberRights")) AS state`);
  return row.state;
}
async function cli(env,args=[]){
  const child=spawn(process.execPath,['--max-old-space-size=3072','/app/prisma/import-member-rights.cjs',...args],
    {env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  const timer=setTimeout(()=>child.kill('SIGKILL'),120000); // Existing fixture command timeout.
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  clearTimeout(timer);return {code,out,err};
}
(async()=>{
  server=http.createServer((req,res)=>{(async()=>{
    const url=new URL(req.url,'http://synthetic.invalid');requests.push(req.method+' '+url.pathname);
    const send=(code,value)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    if(req.method==='POST'&&url.pathname.endsWith('/protocol/openid-connect/token'))
      return send(200,{access_token:'synthetic-provider-token',expires_in:3600});
    const user={id:subject,username:subject,email:'synthetic@example.test',emailVerified:true,enabled:false};
    if(req.method==='GET'&&url.pathname.endsWith('/users'))return send(200,[user]);
    if(req.method==='GET'&&url.pathname.endsWith('/users/'+subject))return send(200,user);
    if(req.method==='GET'&&url.pathname.endsWith('/groups'))return send(200,[{name:'synthetic-hospital'}]);
    if(req.method==='GET'&&url.pathname.endsWith('/role-mappings/realm'))return send(200,[{name:'radiologist'}]);
    if(req.method==='PUT'&&url.pathname.endsWith('/users/'+subject)){
      let body='';for await(const chunk of req)body+=chunk;
      assert.deepEqual(JSON.parse(body),{enabled:true});
      observed.push(await state());return send(publicationFails?503:204,null);
    }
    send(404,{error:'unexpected synthetic provider request'});
  })().catch(error=>{res.writeHead(500);res.end();console.error(error);});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  // The deployed import checks effective database privileges only in production mode.
  const env={DEPLOYMENT_MODE:'production',KC_ADMIN_URL:origin,KC_REALM:'synthetic',KC_ISSUER:origin+'/realms/synthetic',
    KC_CLIENT_ID:'synthetic-cli',KC_CLIENT_SECRET:require('node:crypto').randomBytes(24).toString('hex'),
    KIN_EMR_STATE_DIR:'/tmp/synthetic-cli-state'};
  const first=await cli(env);assert.equal(first.code,0,first.err);
  assert.equal(observed.length,1);assert.deepEqual(observed[0],{entries:1,markers:1,rights:1});
  let change=await witness.providerChange.findFirst({where:{sub:subject,kind:'credentials'}});
  assert.equal(change.state,'unknown','provider outage remains a recorded unresolved publication');
  assert.equal((await witness.memberRights.findUnique({where:{sub:subject}})).suspended,true);
  const before=requests.length, repeated=await cli(env);assert.equal(repeated.code,0,repeated.err);
  assert.equal(requests.length,before,'completed import does not reread or republish the realm');
  assert.deepEqual(await state(),observed[0],'restart cannot create another legal event');
  publicationFails=false;
  const retry=await cli(env,['--retry-roster']);assert.equal(retry.code,0,retry.err);
  change=await witness.providerChange.findUnique({where:{id:change.id}});assert.equal(change.state,'done');
  assert.deepEqual(await state(),observed[0]);
  const calls=requests.length;
  const refused=await cli({...env,DATABASE_URL:process.env.KIN_B2R_WITNESS_URL});
  assert.equal(refused.code,1);assert.equal(requests.length,calls,'installer role refused before provider work');
  console.log('PASS actual CLI: atomic rights import, committed-before-publication, outage/retry, restart, cleanup exit and wrong-role refusal');
})().finally(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await witness.$disconnect();})
  .catch(error=>{console.error(error);process.exitCode=1;});
"""
        self.run_node_case(self.image_args(['node', '--max-old-space-size=3072', '-e', script], {
            'DATABASE_URL': self.runtime_url, 'KIN_B2R_WITNESS_URL': self.witness_url,
        }, remove=False), ROOT / 'tmp/emr-b2-replace-20261023' / ('import-cli-' + self.token))


class PgLedgerNativeRestoreLive(PgLedgerFixture):
    admin_user = 'kin'
    database_name = 'kin'

    def test_native_backup_private_recovery_and_selected_identity(self):
        import io
        import sqlite3
        import tarfile
        import shutil
        from datetime import datetime, timezone
        from unittest.mock import patch
        sys.path.insert(0, str(ROOT / 'scripts'))
        import ops_backup as ops
        evidence = ROOT / 'tmp/emr-b2-replace-20261023' / ('native-restore-' + self.token)
        evidence.mkdir()
        snapshot = evidence / 'snapshot'
        snapshot.mkdir()
        # B2R-REV-01 / D1796: Opus's 2020 record-history fault must survive
        # native recovery without blocking it, and be counted in the receipt.
        old_event, old_operation, old_attempt = (str(uuid.uuid4()) for _ in range(3))
        old_payload = json.dumps(dict(eventId=old_event, occurredAt='2020-01-01T00:00:00Z',
            userId={'status':'unresolved','reason':'not-authenticated'}, result='succeeded', action='write',
            targets=[dict(kind='report-version',recordId={'status':'known','value':'SYNTHETIC-old'},
                          versionId={'status':'known','value':'v1'})]))
        old_literal = "'" + old_payload.replace("'", "''") + "'"
        self.sql(f"SELECT emr_access.admit_operation('{old_operation}','{old_attempt}',{old_literal},'기재')",'kin_runtime')
        self.sql(f"SELECT emr_access.append_operation('{old_operation}','{old_attempt}',{old_literal},'기재',NULL,NULL,NULL)",'kin_runtime')
        event, operation, attempt, failure = (str(uuid.uuid4()) for _ in range(4))
        payload = json.dumps(dict(eventId=event,occurredAt=datetime.now(timezone.utc).isoformat(),
            userId={'status':'unresolved','reason':'not-authenticated'},result='succeeded',
            targets=[dict(kind='report-version',recordId={'status':'known','value':'SYNTHETIC-restore'},
                          versionId={'status':'known','value':'1'})]))
        literal = "'" + payload.replace("'", "''") + "'"
        self.sql(f"SELECT emr_access.admit_operation('{operation}','{attempt}',{literal},'기재')", 'kin_runtime')
        self.sql(f"""BEGIN; SET LOCAL ROLE kin_runtime;
          INSERT INTO public."ReportVersion"(uid,version,action,findings,author) VALUES('SYNTHETIC-restore',1,'save','SYNTHETIC only','synthetic-doctor');
          SELECT emr_access.append_operation('{operation}','{attempt}',{literal},'기재','ReportVersion','SYNTHETIC-restore','1'); COMMIT;""")
        self.sql('CREATE DATABASE keycloak')
        expired_failure = str(uuid.uuid4())
        self.sql(f"SELECT emr_access.record_failure('{expired_failure}',NULL,'synthetic-expired-access','2020-01-01','ledger-unreachable')",'kin_runtime')
        self.command(['docker','exec',self.container,'psql','-X','-U','kin','-d','keycloak','-v','ON_ERROR_STOP=1',
                      '-c',"CREATE TABLE synthetic_realm(id text PRIMARY KEY); INSERT INTO synthetic_realm VALUES ('B2-owned-fixture')"])
        started = time.monotonic()
        def dump(args, name):
            with (snapshot / name).open('wb') as output:
                result = subprocess.run(args,stdout=output,stderr=subprocess.PIPE,timeout=120)
                self.assertEqual(result.returncode,0,result.stderr.decode(errors='replace')[-500:])
        dump(['docker','exec',self.container,'pg_dumpall','-U','kin','--roles-only','--no-role-passwords'], 'cluster-roles.sql')
        for database in ('kin','keycloak'):
            dump(['docker','exec',self.container,'pg_dump','-U','kin','-d',database,'--encoding=UTF8','-Fc','--create'],database+'.dump')
        catalog = ops.emr_catalog(self.container,'kin')
        ops.write_json(snapshot/'emr-catalog.json',catalog)
        spool = dict(id=failure,operationId=None,eventId=None,at=datetime.now(timezone.utc).isoformat(),cause='ledger-unreachable')
        uid = int(self.image_command(['id','-u'],{}).stdout.strip())
        gid = int(self.image_command(['id','-g'],{}).stdout.strip())
        with tarfile.open(snapshot/'emr-state.tgz','w:gz') as archive:
            for name in ('.','outage'):
                directory=tarfile.TarInfo(name);directory.type=tarfile.DIRTYPE
                directory.uid=uid;directory.gid=gid;directory.mode=0o700;archive.addfile(directory)
            data=(json.dumps(spool)+'\n').encode();entry=tarfile.TarInfo('outage/failure-spool.jsonl');entry.size=len(data);entry.mode=0o600
            entry.uid=uid;entry.gid=gid
            archive.addfile(entry,io.BytesIO(data))
        index=evidence/'synthetic-index'
        with sqlite3.connect(index) as db:
            db.execute('CREATE TABLE AttachedFiles(uuid TEXT, compressedSize INTEGER)')
        with tarfile.open(snapshot/'orthanc.tgz','w:gz') as archive:archive.add(index,arcname='index')
        for name in ops.FILES[3:]: (snapshot/name).write_text('synthetic fixture only\n')
        def image_id(name):
            return self.command(['docker','image','inspect',name,'--format','{{.Id}}']).stdout.strip()
        orthanc=os.environ.get('KIN_TEST_ORTHANC_IMAGE','orthancteam/orthanc:24.12.0')
        manifest=dict(format=1,complete=True,created_utc=datetime.now(timezone.utc).isoformat(),git_sha='synthetic-current-source',
            postgres_image=image_id('postgres:16-alpine'),orthanc_image=image_id(orthanc),
            running_images={'kin-api':{'id':image_id(self.image)}},
            counts={d:ops.counts(self.container,d,'kin') for d in ('kin','keycloak')},
            emr={'same_pause':True,'tablespace':'kin_emr_access','installation_id':catalog['ledger']['installation_id'],
                 'schema_version':'pg-ledger-1','recovery_point':'logical snapshot while this owned source has no writers'})
        components=ops.backup_components(manifest)
        manifest['sha256']={n:ops.digest(snapshot/n) for n in components}
        manifest['bytes']={n:(snapshot/n).stat().st_size for n in components}
        ops.write_json(snapshot/'manifest.json',manifest)
        source_before={n:ops.digest(snapshot/n) for n in (*components,'manifest.json')}
        observed={}
        original=ops.temporary_run
        def witness(args, **kwargs):
            result=original(args,**kwargs)
            if args[-1]==ops.EMR_RECOVERY_SCRIPT:
                restored=args[args.index('--network')+1].removeprefix('container:')
                sql=f"""SELECT json_build_object('entries',(SELECT count(*) FROM emr_access.access_entry WHERE operation_id='{operation}'),
                  'outcomes',(SELECT count(*) FROM emr_access.attempt_outcome WHERE operation_id='{operation}' AND outcome='committed'),
                  'clinical',(SELECT count(*) FROM public."ReportVersion" WHERE uid='SYNTHETIC-restore' AND version=1 AND findings='SYNTHETIC only'),
                  'spool_imported',(SELECT count(*) FROM emr_access.failure_entry WHERE failure_id='{failure}'))"""
                observed.update(json.loads(self.command(['docker','exec',restored,'psql','-X','-U','postgres','-d','kin','-qAt','-c',sql]).stdout))
            return result
        actual_catalog = ops.emr_catalog
        actual_expiry = ops.restored_emr_expiry
        def expiry_witness(container, user):
            receipt = actual_expiry(container, user)
            row = ops.psql_json(container, 'kin', f"SELECT json_build_object('count',count(*),"
                f"'payload',min(payload)) FROM emr_access.access_entry WHERE event_id='{old_event}' AND stream='history'", user)
            self.assertEqual(row, {'count':1,'payload':old_payload}, 'Restore must preserve the unknown-lifetime history row')
            observed['old_history_retained'] = row['count']
            return receipt
        def catalog_witness(container, user):
            value = actual_catalog(container, user)
            if container != self.container:
                ops.write_json(evidence / ('restored-catalog-' + container + '.json'), value)
            return value
        with patch.object(ops,'temporary_run',side_effect=witness), patch.object(ops,'emr_catalog',side_effect=catalog_witness), \
                patch.object(ops,'restored_emr_expiry',side_effect=expiry_witness):
            ops.rehearse(snapshot)
        self.assertEqual(observed,dict(entries=2,outcomes=1,clinical=1,spool_imported=1,old_history_retained=1))
        reports=[json.loads(p.read_text()) for p in snapshot.glob('rehearsal-*.json')]
        self.assertTrue(reports[-1]['success']);self.assertEqual(reports[-1]['cleanup_failures'],[])
        sweep=reports[-1]['emr']['expiry_sweep']
        self.assertIs(sweep['ran'],True);self.assertIs(sweep['complete'],True)
        self.assertEqual(sweep['historyRetainedUnknownLifetime'],1)
        self.assertEqual(sweep['deletedFailures'],1)
        self.assertEqual(self.sql(f"SELECT count(*) FROM emr_access.failure_entry WHERE failure_id='{expired_failure}'").stdout.strip(),'1','Source backup fixture is preserved')
        wrong=evidence/'wrong-selected-installation';shutil.copytree(snapshot,wrong)
        other={**catalog,'ledger':{**catalog['ledger'],'installation_id':str(uuid.uuid4())}}
        ops.write_json(wrong/'emr-catalog.json',other)
        manifest['sha256']['emr-catalog.json']=ops.digest(wrong/'emr-catalog.json')
        ops.write_json(wrong/'manifest.json',manifest)
        with self.assertRaisesRegex(RuntimeError,'owner/ACL/roles/tablespace differ'):ops.rehearse(wrong)
        self.assertEqual(source_before,{n:ops.digest(snapshot/n) for n in source_before})
        self.assertEqual(ops.emr_catalog(self.container,'kin'),catalog)
        ops.write_json(evidence/'result.json',dict(status='PASS',source_preserved=True,observed=observed,
            seconds=time.monotonic()-started,backup_bytes=sum(manifest['bytes'].values()),
            recovery_point=manifest['created_utc'],rpo='selected synthetic quiescent snapshot; deployment schedule not measured',
            backup_storage='owned fixture directory; deployment separate-storage qualification remains SCALE-01'))


class PgLedgerProbeLive(PgLedgerFixture):
    """OPS-01: the shipped operating probe and independent SQL, without a test HTTP endpoint.

    This uses the compiled candidate on the host. Production-image and HTTP acceptance remain separate cells.
    """
    def test_operational_probe_pg_outcomes_and_readiness(self):
        sys.path.insert(0, str(ROOT / 'scripts'))
        import ops_emr_probe as probe
        import ops_emr_introduction as intro
        evidence = ROOT / 'tmp/emr-b2-replace-20261023' / ('probe-' + self.token)
        evidence.mkdir()
        sequence = 0

        def invoke(operation, value, *, url=None, script=None, success=True):
            nonlocal sequence
            sequence += 1
            result = self.command([os.environ['KIN_B2R_NODE'], '--max-old-space-size=3072', '-e',
                                   script or probe.PROBE_SCRIPT, operation, json.dumps(value)],
                                  check=False, cwd=ROOT / 'api', env={**os.environ,
                                  'DATABASE_URL': url or self.runtime_url, 'KIN_EMR_STATE_DIR': str(evidence / 'spool')})
            (evidence / f'{sequence:02d}.stdout').write_text(result.stdout, encoding='utf-8')
            (evidence / f'{sequence:02d}.stderr').write_text(result.stderr, encoding='utf-8')
            if success:
                self.assertEqual(result.returncode, 0, result.stdout[-1000:] + result.stderr[-1000:])
                return intro.result_line(result.stdout.encode())
            return result

        def payload():
            return {'event': probe.probe_event({'study': 'SYNTHETIC-pg-probe', 'institution': 'synthetic-hospital',
                                                'event_id': str(uuid.uuid4())}),
                    'keys': {'operationId': str(uuid.uuid4()), 'attemptId': str(uuid.uuid4())}}

        # A real missing-readiness regression is the red witness. The same assertion
        # below refuses the healthy probe with installer credentials and no legal entry.
        removed_check = probe.PROBE_SCRIPT.replace('await verifyRuntimeConnection(db);',
                                                   "({role:'kin_runtime',relations:1});")
        self.assertNotEqual(removed_check, probe.PROBE_SCRIPT)
        mutant = payload()
        red = invoke('append', mutant, url=self.witness_url, script=removed_check, success=False)
        self.assertEqual(red.returncode, 0, red.stdout[-1000:])
        red_assertion_failed = False
        try:
            self.assertNotEqual(red.returncode, 0, 'Installer probe must be refused')
        except AssertionError:
            red_assertion_failed = True
        self.assertTrue(red_assertion_failed)
        self.assertEqual(self.sql("SELECT count(*) FROM emr_access.access_entry WHERE event_id='" +
                                  mutant['event']['eventId'] + "';").stdout.strip(), '1')
        refused = payload()
        green = invoke('append', refused, url=self.witness_url, success=False)
        self.assertNotEqual(green.returncode, 0, 'Installer probe must be refused')
        self.assertEqual(intro.result_line(green.stdout.encode())['error'], 'EmrRuntimeRefused')
        self.assertEqual(self.sql("SELECT count(*) FROM emr_access.access_entry WHERE event_id='" +
                                  refused['event']['eventId'] + "';").stdout.strip(), '0')

        value = payload()
        first = invoke('append', value)
        restart = {'eventId': value['event']['eventId'], 'operationId': first['outcome']['operationId']}
        second = invoke('restart', restart)
        checked = probe.verify(first, second, restart['eventId'])
        self.assertEqual(checked['added'], 1)
        again, third = invoke('append', value), invoke('restart', restart)
        self.assertEqual(probe.verify(again, third, restart['eventId'])['added'], 0)
        self.assertEqual(first['outcome'], third['outcome'])
        independent = json.loads(self.sql("SELECT json_build_object('entries', (SELECT count(*) FROM emr_access.access_entry "
            "WHERE event_id='" + restart['eventId'] + "'), 'outcomes', (SELECT count(*) FROM emr_access.attempt_outcome "
            "WHERE operation_id='" + restart['operationId'] + "'), 'failures', (SELECT count(*) FROM emr_access.failure_entry));").stdout)
        self.assertEqual(independent, {'entries': 1, 'outcomes': 1, 'failures': 0})
        (evidence / 'witness.json').write_text(json.dumps(independent, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'status': 'PASS', 'boundary': 'actual compiled operating probe + independent PostgreSQL',
                          'red': 'missing-readiness mutant admits installer; refusal assertion fails',
                          'green': 'installer refused before append; runtime append/replay/two new processes retain one outcome',
                          'evidence': str(evidence.relative_to(ROOT)), 'production_image': 'NOT_RUN', 'http': 'NOT_RUN'}))


if __name__ == '__main__':
    unittest.main()
