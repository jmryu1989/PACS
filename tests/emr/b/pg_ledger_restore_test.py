"""REQ-B2R-01/02/03/05: real PG boundary, small owned synthetic fixture.

This stage test is not API, crash, native-restore or first-site qualification.
The runner's live admission is required even though no production stack is used.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests'))
import live_test_gate as gate


class PgLedgerFixture(unittest.TestCase):
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
                            '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'ledger_fixture'],
                           data=prefix + statement, check=check)

    @classmethod
    def setUpClass(cls):
        gate.require_live_run()
        cls.token = uuid.uuid4().hex[:12]
        cls.container = 'emr-b2r-schema-' + cls.token
        cls.network = cls.container + '-net'
        print('owned fixture label: kin.b2r=' + cls.token)
        cls.created_container = cls.created_network = False
        cls.addClassCleanup(cls.cleanup)
        password = secrets.token_hex(24)
        cls.command(['docker', 'network', 'create', '--label', 'kin.b2r=' + cls.token, cls.network])
        cls.created_network = True
        cls.command(['docker', 'run', '-d', '--name', cls.container, '--label', 'kin.b2r=' + cls.token,
                     '--network', cls.network, '--memory', '512m', '--memory-swap', '512m', '--cpus', '2',
                     '--tmpfs', '/var/lib/postgresql/data:rw,size=128m',
                     '--tmpfs', '/var/lib/postgresql/emr-access:rw,size=64m',
                     '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD=' + password,
                     '-e', 'POSTGRES_DB=ledger_fixture', 'postgres:16-alpine'])
        cls.created_container = True
        for _ in range(60):
            if cls.command(['docker', 'exec', cls.container, 'pg_isready', '-U', 'postgres'], check=False).returncode == 0:
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
                     '-U', 'postgres', '-d', 'ledger_fixture'], data=provision)
        port = cls.command(['docker', 'port', cls.container, '5432/tcp']).stdout.strip().rsplit(':', 1)[1]
        node = os.environ['KIN_B2R_NODE']
        prisma_cli = os.environ['KIN_B2R_PRISMA_CLI']
        env = {**os.environ, 'DATABASE_URL': f'postgresql://postgres:{password}@127.0.0.1:{port}/ledger_fixture'}
        cls.witness_url = env['DATABASE_URL']
        cls.runtime_url = f'postgresql://kin_runtime:{cls.runtime_password}@127.0.0.1:{port}/ledger_fixture'
        result = cls.command([node, '--max-old-space-size=3072', prisma_cli, 'migrate', 'deploy',
                              '--schema', str(ROOT / 'api/prisma/schema.prisma')], env=env, check=False)
        if result.returncode:
            print(cls.sql('SELECT migration_name, logs FROM public._prisma_migrations WHERE finished_at IS NULL;').stdout)
            print(cls.command(['docker', 'logs', '--tail', '50', cls.container]).stderr)
            raise RuntimeError(result.stderr[-2000:])
        print('normal migrate deploy completed:', '20261023180000_emr_pg_ledger' in result.stdout)

    @classmethod
    def cleanup(cls):
        failures = []
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
        if failures:
            raise RuntimeError('; '.join(failures))

class PgLedgerSchemaLive(PgLedgerFixture):
    def test_pg_schema_atomicity_dedup_and_expiry(self):
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
        spool = ROOT / 'tmp/emr-b2-replace-20261023' / ('spool-' + self.token)
        result = self.command([os.environ['KIN_B2R_NODE'], '--max-old-space-size=3072',
                               str(ROOT / 'tests/emr/b/pg_ledger_api_test.cjs')],
                              env={**os.environ, 'DATABASE_URL': self.runtime_url,
                                   'KIN_B2R_WITNESS_URL': self.witness_url, 'KIN_B2R_SPOOL': str(spool)})
        print(result.stdout)


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
