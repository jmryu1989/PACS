"""REQUEST_FACTS RF-1/3/4/6, using B2's owned synthetic PG fixture.

This does not close Module A's protected clinical read or the real nginx cell.
"""
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/emr/b'))
from pg_ledger_restore_test import PgLedgerFixture


class RequestFactsLive(PgLedgerFixture):
    def test_registered_admin_signed_guard_session_and_current_authorization(self):
        driver = ROOT / 'tests/emr/request/request_facts_pg_test.cjs'
        evidence = ROOT / 'tmp/request-auth/request-facts-01' / self.token
        env = {**os.environ, 'DATABASE_URL': self.runtime_url, 'KIN_B2R_WITNESS_URL': self.witness_url,
               'KIN_B2R_SPOOL': str(evidence)}
        if self.image:
            args = ['docker', 'run', '--name', self.container + '-node', '--label', 'kin.b2r=' + self.token,
                    '--network', self.network, '--memory', '1536m', '--memory-swap', '1536m', '--cpus', '2',
                    '--mount', 'type=bind,source=' + str(driver) + ',target=/app/request_facts_pg_test.cjs,readonly']
            for key, value in {**env, 'KIN_B2R_BUILD': '/app/dist', 'KIN_B2R_SPOOL': '/tmp/request-facts'}.items():
                if key in ('DATABASE_URL', 'KIN_B2R_WITNESS_URL', 'KIN_B2R_BUILD', 'KIN_B2R_SPOOL'):
                    args += ['-e', key + '=' + value]
            command = args + [self.image, 'node', '/app/request_facts_pg_test.cjs']
        else:
            command = [os.environ['KIN_B2R_NODE'], str(driver)]
        self.run_node_case(command, evidence, env=env, timeout=120)


if __name__ == '__main__':
    unittest.main(verbosity=2)
