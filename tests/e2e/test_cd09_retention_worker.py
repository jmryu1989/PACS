"""CD-09 real CLI/PG boundary, synthetic data only.

REQ-EMR-17 -> RISK-H-06 -> TEST-CD09-LEDGER-LIVE.
This verifies the implemented ledger-only phase, not image/purpose destruction.
Run through scripts/run-tests.py with the existing PgLedgerFixture admission.
"""
import json
from pathlib import Path
import secrets
import sys
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/emr/b'))
import pg_ledger_restore_test as pg


class RetentionWorkerLedgerLive(pg.PgLedgerFixture):
    def test_shipped_entry_expiry_hold_retry_and_incomplete_status(self):
        password = secrets.token_hex(24)
        self.sql(f"ALTER ROLE kin_emr_retention LOGIN PASSWORD '{password}'")
        # Only a new role on this fixture's isolated DB; never the API credential.
        url = self.runtime_url.replace('kin_runtime:' + self.runtime_password,
                                       'kin_emr_retention:' + password)
        expired, held, future = (str(uuid.uuid4()) for _ in range(3))
        for identity, at in [(expired, '2020-01-01'), (held, '2020-01-01'), (future, '2099-01-01')]:
            self.sql(f"SELECT emr_access.record_failure('{identity}',NULL,'{identity}',"
                     f"'{at}','ledger-unreachable')", 'kin_runtime')
        hold = str(uuid.uuid4())
        body = json.dumps(dict(holdId=hold, recordId=held, release=None,
                               basis='synthetic hold', actorId='fixture', at='2020-01-01T00:00:00Z'))
        self.sql(f"SELECT emr_access.place_hold('{hold}','{held}','{body}')", 'kin_runtime')
        first = self.image_command(['node', '/app/dist/emr-retention/entry.js'], {'DATABASE_URL': url})
        self.assertEqual(first.returncode, 1, first.stderr)
        result = json.loads(first.stdout)
        self.assertEqual(result['status'], 'incomplete')
        self.assertEqual(result['ledger']['deletedFailures'], 1)
        self.assertEqual(result['ledger']['retainedByDutyOrHold'], 1)
        remaining = self.sql("SELECT failure_id FROM emr_access.failure_entry ORDER BY failure_id").stdout.split()
        self.assertEqual(set(remaining), {held, future})
        self.assertEqual(self.sql(f"SELECT count(*) FROM emr_access.disposal_fact WHERE failure_id='{expired}'")
                         .stdout.strip(), '1')
        second = self.image_command(['node', '/app/dist/emr-retention/entry.js'], {'DATABASE_URL': url})
        self.assertEqual(second.returncode, 1, second.stderr)
        self.assertEqual(json.loads(second.stdout)['ledger']['deletedFailures'], 0)
        # A failed read must not produce a successful JSON run or erase more rows.
        refused = self.image_command(['node', '/app/dist/emr-retention/entry.js'],
                                     {'DATABASE_URL': self.runtime_url})
        self.assertEqual(refused.returncode, 1)
        self.assertEqual(refused.stdout.strip(), '')
        self.assertEqual(set(self.sql("SELECT failure_id FROM emr_access.failure_entry").stdout.split()),
                         {held, future})
