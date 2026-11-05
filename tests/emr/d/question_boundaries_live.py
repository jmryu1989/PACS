"""CD-09 W-Q: question writes on an isolated PostgreSQL fixture with the real HTTP, C2 and B2 stack.

Synthetic fixture only (tests/emr/b PgLedgerFixture). The node script observes holders, waiters and row
ownership on the database before each product answer; its WQ-WITNESS lines are the raw evidence.

    python -B scripts/run-tests.py --module tests/emr/d/question_boundaries_live.py --mode live --unit cd09wq-question-pg --timeout 900
"""
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/emr/b'))
import pg_ledger_restore_test as pg


class QuestionBoundariesPg(pg.PgLedgerFixture):
    script = 'question_boundaries_pg_test.cjs'
    # Hang timeout for the node child (several cases wait out the 3 s lock bound on purpose).
    node_timeout = 600

    def test_question_boundaries_http(self):
        logs = ROOT / 'tmp/emr-d-online' / ('question-' + self.token)
        logs.mkdir(parents=True)
        env = {'DATABASE_URL': self.runtime_url, 'KIN_D_WITNESS_URL': self.witness_url,
               'KIN_D_SPOOL': '/tmp/question-spool' if self.image else str(logs / 'spool')}
        if self.image:
            command = ['docker', 'run', '--name', self.container + '-node', '--label', 'kin.b2r=' + self.token,
                       '--network', self.network,
                       '-v', str(ROOT / 'tests/emr/d') + ':/tests:ro', '-e', 'KIN_D_API=/app']
            for key, value in env.items():
                command += ['-e', key + '=' + value]
            command += ['--entrypoint', 'node', self.image, '--test', '/tests/' + self.script]
        else:
            command = [os.environ['KIN_B2R_NODE'], '--test', str(ROOT / 'tests/emr/d' / self.script)]
        print('Question boundaries raw logs:', logs)
        self.run_node_case(command, logs, env={**os.environ, **env}, timeout=self.node_timeout)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main()
