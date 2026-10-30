"""A1 real PG cells through the accepted B2 synthetic fixture (REQ-A-DURABLE).

A2/A3's real routes and their renderers remain joint acceptance cells.
"""
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/emr/b'))
from pg_ledger_restore_test import PgLedgerFixture


class LocalReadRecordingBoundary(PgLedgerFixture):
    def test_local_read_commit_readback_and_filter(self):
        driver = ROOT / 'tests/emr/a/local_read_test.cjs'
        env = {**os.environ, 'DATABASE_URL': self.runtime_url, 'KIN_B2R_WITNESS_URL': self.witness_url,
               'KIN_B2R_SPOOL': str(ROOT / 'tmp/module-a-01-2' / self.token / 'spool')}
        if self.image:
            args = ['docker', 'run', '--name', self.container + '-node', '--label', 'kin.b2r=' + self.token,
                    '--network', self.network, '--mount', 'type=bind,source=' + str(driver) + ',target=/app/local_read_test.cjs,readonly']
            for key, value in {**env, 'KIN_B2R_BUILD': '/app/dist', 'KIN_B2R_SPOOL': '/tmp/local-read-spool'}.items():
                if key in ('DATABASE_URL', 'KIN_B2R_WITNESS_URL', 'KIN_B2R_BUILD', 'KIN_B2R_SPOOL'):
                    args += ['-e', key + '=' + value]
            command = args + [self.image, 'node', '--test', '/app/local_read_test.cjs']
        else:
            command = [os.environ['KIN_B2R_NODE'], '--test', str(driver)]
        self.run_node_case(command, ROOT / 'tmp/module-a-01-2' / self.token, env=env, timeout=120)


if __name__ == '__main__':
    unittest.main(verbosity=2)
