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


class PgLedgerSchemaLive(unittest.TestCase):
    @classmethod
    def command(cls, args, *, data=None, check=True, timeout=120, env=None):
        result = subprocess.run(args, input=data, capture_output=True, text=True,
                                encoding='utf-8', timeout=timeout, env=env)
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


class PgLedgerAdapterLive(PgLedgerSchemaLive):
    def test_public_pg_adapter(self):
        spool = ROOT / 'tmp/emr-b2-replace-20261023' / ('spool-' + self.token)
        result = self.command([os.environ['KIN_B2R_NODE'], '--max-old-space-size=3072',
                               str(ROOT / 'tests/emr/b/pg_ledger_api_test.cjs')],
                              env={**os.environ, 'DATABASE_URL': self.runtime_url,
                                   'KIN_B2R_WITNESS_URL': self.witness_url, 'KIN_B2R_SPOOL': str(spool)})
        print(result.stdout)


if __name__ == '__main__':
    unittest.main()
