"""D1824 C2/B2 transaction, historical signature and native restore boundary.

Owned disposable PostgreSQL only, through the existing live runner/fixture.
"""
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/emr/b'))
import pg_ledger_restore_test as pg


class ServerSigningPg(pg.PgLedgerFixture):
    database_name = 'c2_signing_test'

    def test_signing_and_restore(self):
        logs = ROOT / 'tmp/emr-d-online' / ('c2-' + self.token)
        logs.mkdir(parents=True)
        secrets = logs / 'secrets'
        secrets.mkdir()

        def run(restored):
            secret_path = '/c2-secret' if self.image else str(secrets)
            env = {'C2_TEST_DATABASE_URL': self.witness_url, 'C2_TEST_RUNTIME_URL': self.runtime_url,
                   'C2_TEST_SECRET_DIR': secret_path,
                   'C2_TEST_EXPECTED_PATH': secret_path + '/expected.json',
                   'C2_TEST_RESTORED': '1' if restored else '0'}
            if self.image:
                command = ['docker', 'run', '--rm', '--network', self.network,
                           '-v', str(ROOT / 'tests/emr/c') + ':/tests:ro',
                           '-v', str(secrets) + ':/c2-secret', '-e', 'KIN_D_API=/app']
                for key, value in env.items():
                    command += ['-e', key + '=' + value]
                command += ['--entrypoint', 'node', self.image, '--test', '/tests/server_signing_pg_test.cjs']
                result = self.command(command, check=False)
            else:
                result = self.command([os.environ['KIN_B2R_NODE'], '--test',
                                       str(ROOT / 'tests/emr/c/server_signing_pg_test.cjs')],
                                      env={**os.environ, **env}, check=False)
            phase = 'restored' if restored else 'original'
            (logs / (phase + '.stdout')).write_text(result.stdout, encoding='utf-8')
            (logs / (phase + '.stderr')).write_text(result.stderr, encoding='utf-8')
            print('C2/B2 raw logs:', logs, phase)
            self.assertEqual(result.returncode, 0, result.stdout[-3000:] + result.stderr[-1000:])

        run(False)
        self.command(['docker', 'exec', self.container, 'pg_dump', '-U', self.admin_user,
                      '-Fc', '-f', '/tmp/c2.dump', self.database_name])
        self.command(['docker', 'exec', self.container, 'pg_restore', '-U', self.admin_user,
                      '--exit-on-error', '--clean', '--if-exists', '--single-transaction',
                      '-d', self.database_name, '/tmp/c2.dump'])
        run(True)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main()
