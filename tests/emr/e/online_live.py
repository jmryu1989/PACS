"""E-T1/T2: actual B2 PostgreSQL plus HTTP; synthetic source protocol only.

The three tables below are the evidence-port fixture, not a shipped E migration.
Full nginx/OHIF, persistent image storage and actual DICOM decoder acceptance
remain separate checks until the shared writer supplies their assembly.
"""
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/emr/b'))
import pg_ledger_restore_test as pg


class OnlineImagePg(pg.PgLedgerFixture):
    def test_fixed_image_http(self):
        self.sql('''
          CREATE TABLE public.e_response(event_id uuid PRIMARY KEY, manifest jsonb, copies jsonb);
          CREATE TABLE public.e_transfer(event_id uuid, body jsonb);
          CREATE TABLE public.e_copy_end(event_id uuid, body jsonb);
          GRANT INSERT, SELECT ON public.e_response, public.e_transfer TO kin_runtime;
        ''')
        logs = ROOT / 'tmp/emr-e-online' / ('pg-' + self.token)
        logs.mkdir(parents=True)
        env = {'DATABASE_URL': self.runtime_url, 'KIN_E_WITNESS_URL': self.witness_url,
               'KIN_E_SPOOL': '/tmp/e-spool' if self.image else str(logs / 'spool')}
        if self.image:
            command = ['docker', 'run', '--rm', '--name', self.container + '-node',
                       '--label', 'kin.b2r=' + self.token, '--network', self.network, '--tmpfs', '/tmp',
                       '-v', str(ROOT / 'tests/emr/e') + ':/tests:ro', '-e', 'KIN_E_API=/app']
            for key, value in env.items():
                command += ['-e', key + '=' + value]
            command += ['--entrypoint', 'node', self.image, '--test', '/tests/stream_pg_test.cjs']
            result = self.command(command, check=False)
        else:
            result = self.command([os.environ['KIN_B2R_NODE'], str(ROOT / 'tests/emr/e/stream_pg_test.cjs')],
                                  env={**os.environ, **env}, check=False)
        (logs / 'stdout.log').write_text(result.stdout, encoding='utf-8')
        (logs / 'stderr.log').write_text(result.stderr, encoding='utf-8')
        print('E PG/HTTP logs:', logs)
        self.assertEqual(result.returncode, 0, result.stdout[-1800:] + result.stderr[-1000:])


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main()
