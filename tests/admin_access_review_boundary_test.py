"""REQ-EMR-15/19 -> RISK-F-05 -> TEST-ACCESS-REVIEW-BOUNDARY.

Reuse B2's owned, synthetic PostgreSQL install and its normal runtime reader.
Never connects to a configured application database or production fixture.
"""
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests/emr/b'))
from pg_ledger_restore_test import PgLedgerFixture


class AccessReviewBoundary(PgLedgerFixture):
    def test_real_nest_and_pg_review(self):
        source = ROOT / 'tests/admin_access_review_boundary_test.cjs'
        env = {**os.environ, 'DATABASE_URL': self.runtime_url, 'KIN_B2R_WITNESS_URL': self.witness_url,
               'KIN_B2R_SPOOL': str(ROOT / 'tmp/access-review/spool'),
               'NODE_PATH': str(ROOT / 'api/node_modules'), 'KIN_ACCESS_REVIEW_BUILD': str(ROOT / 'api/dist')}
        if self.image:
            command = ['docker', 'run', '--rm', '--name', self.container + '-node', '--label', 'kin.b2r=' + self.token,
                       '--network', self.network, '--mount', 'type=bind,source=' + str(source) + ',target=/app/access-review.cjs,readonly',
                       '-e', 'DATABASE_URL=' + self.runtime_url, '-e', 'KIN_B2R_WITNESS_URL=' + self.witness_url,
                       '-e', 'KIN_ACCESS_REVIEW_BUILD=/app/dist', '-e', 'KIN_B2R_SPOOL=/tmp/access-review-spool',
                       self.image, 'node', '/app/access-review.cjs']
        else:
            command = [os.environ['KIN_B2R_NODE'], str(source)]
        result = self.command(command, env=env, check=False, timeout=120)
        print(result.stdout); print(result.stderr)
        self.assertEqual(result.returncode, 0)


if __name__ == '__main__': unittest.main()
