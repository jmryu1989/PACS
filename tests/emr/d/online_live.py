"""D-T1/T2/T4/T5: real PG/B2 and C2 signing, synthetic fixture only.

OnlineClinicalPg exercises storage/signing; ReportCommitPg and ClinicalRoutesPg
use actual Nest HTTP controllers, AuthGuard, C2 and B2. Only the external identity
and study sources are synthetic. Served pages are exercised separately. The
fixture applies the normal production migrations, including C2 and D.
"""
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/emr/b'))
import pg_ledger_restore_test as pg


class OnlineClinicalPg(pg.PgLedgerFixture):
    def test_online_record_boundary(self):
        self.sql('''          CREATE TABLE public.d_online_projection(version_id text PRIMARY KEY, body text);
          GRANT INSERT, SELECT ON public.d_online_projection TO kin_runtime;''')
        logs = ROOT / 'tmp/emr-d-online' / ('pg-' + self.token)
        logs.mkdir(parents=True)

        def run(restored):
            env = {'DATABASE_URL': self.runtime_url, 'KIN_D_WITNESS_URL': self.witness_url,
                   'KIN_D_SPOOL': '/tmp/d-spool' if self.image else str(logs / 'spool'),
                   'KIN_D_EXPECTED_PATH': '/evidence/expected.json' if self.image else str(logs / 'expected.json'),
                   'KIN_D_RESTORED': '1' if restored else '0'}
            if self.image:
                command = ['docker', 'run', '--rm', '--network', self.network, '--tmpfs', '/tmp',
                           '-v', str(ROOT / 'tests/emr/d') + ':/tests:ro',
                           '-v', str(logs) + ':/evidence', '-e', 'KIN_D_API=/app']
                for key, value in env.items():
                    command += ['-e', key + '=' + value]
                command += ['--entrypoint', 'node', self.image, '--test', '/tests/online_pg_test.cjs']
                result = self.command(command, check=False)
            else:
                result = self.command([os.environ['KIN_B2R_NODE'], '--test',
                                       str(ROOT / 'tests/emr/d/online_pg_test.cjs')],
                                      env={**os.environ, **env}, check=False)
            phase = 'restored' if restored else 'original'
            (logs / (phase + '.stdout')).write_text(result.stdout, encoding='utf-8')
            (logs / (phase + '.stderr')).write_text(result.stderr, encoding='utf-8')
            print('D online raw logs:', logs, phase)
            self.assertEqual(result.returncode, 0, result.stdout[-3000:] + result.stderr[-1000:])

        run(False)
        self.command(['docker', 'exec', self.container, 'pg_dump', '-U', self.admin_user,
                      '-Fc', '-f', '/tmp/d.dump', self.database_name])
        self.command(['docker', 'exec', self.container, 'pg_restore', '-U', self.admin_user,
                      '--exit-on-error', '--clean', '--if-exists', '--single-transaction',
                      '-d', self.database_name, '/tmp/d.dump'])
        run(True)


class ReportCommitPg(pg.PgLedgerFixture):
    script = 'report_commit_pg_test.cjs'
    def test_report_commit_http(self):
        self.run_http_script()

    def run_http_script(self):
        logs = ROOT / 'tmp/emr-d-online' / ('report-' + self.token)
        logs.mkdir(parents=True)
        env = {'DATABASE_URL': self.runtime_url, 'KIN_D_WITNESS_URL': self.witness_url,
               'KIN_D_SPOOL': '/tmp/report-spool' if self.image else str(logs / 'spool')}
        if self.image:
            command = ['docker', 'run', '--rm', '--network', self.network,
                       '-v', str(ROOT / 'tests/emr/d') + ':/tests:ro', '-e', 'KIN_D_API=/app']
            for key, value in env.items():
                command += ['-e', key + '=' + value]
            command += ['--entrypoint', 'node', self.image, '--test', '/tests/' + self.script]
            result = self.command(command, check=False)
        else:
            result = self.command([os.environ['KIN_B2R_NODE'], '--test', str(ROOT / 'tests/emr/d' / self.script)],
                                  env={**os.environ, **env}, check=False)
        (logs / 'stdout.log').write_text(result.stdout, encoding='utf-8')
        (logs / 'stderr.log').write_text(result.stderr, encoding='utf-8')
        print('Report commit HTTP raw logs:', logs)
        self.assertEqual(result.returncode, 0, result.stdout[-3000:] + result.stderr[-1000:])


class ClinicalRoutesPg(pg.PgLedgerFixture):
    script = 'routes_pg_test.cjs'

    def test_clinical_routes_http(self):
        ReportCommitPg.run_http_script(self)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main()
