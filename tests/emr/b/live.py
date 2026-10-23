"""B2 PG candidate selection; REQ-B2R-01..07 -> RISK-B2R-01..07.

Historical selector names remain for the existing measurement/candidate callers.
The mapping below replaces the removed chain/seal mechanisms with real PG
boundaries. Each case owns a fresh synthetic database and the production image.
"""
import os
import sys
import unittest
import uuid
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import pg_ledger_restore_test as pg


class EmrBLedgerLive(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        pg.gate.require_live_run()
        if os.environ.get('KIN_TEST_API_IMAGE'):
            return
        # Candidate/measurement CI supplies a source checkout, as before B2.
        # Restore its production-image preparation instead of requiring worker-local Node paths.
        tag = 'kin-emrb-live:' + uuid.uuid4().hex[:12]
        pg.PgLedgerFixture.command(['docker', 'build', '--target', 'production',
            '--build-arg', 'VCS_REF=emr-b-live', '-t', tag, str(pg.ROOT / 'api')], timeout=1800)
        cls.addClassCleanup(pg.PgLedgerFixture.command, ['docker', 'image', 'rm', tag])
        os.environ['KIN_TEST_API_IMAGE'] = tag
        cls.addClassCleanup(os.environ.pop, 'KIN_TEST_API_IMAGE', None)

    def boundary(self, fixture, method):
        case=fixture(method)
        try:
            fixture.setUpClass()
            case.setUp()
            try: getattr(case,method)()
            finally: case.tearDown();case.doCleanups()
        finally:
            fixture.doClassCleanups()

    def test_b01_ledger_roles_and_restart(self):
        self.boundary(pg.PgLedgerSchemaLive,'test_pg_schema_atomicity_dedup_and_expiry')

    def test_b02_business_commit_and_failure_journal(self):
        self.boundary(pg.PgLedgerAdapterLive,'test_public_pg_adapter')

    def test_b03_idempotency_and_concurrent_append(self):
        self.boundary(pg.PgLedgerSchemaLive,'test_statutory_act_retry_binding')

    def test_b03b_concurrent_48_receipts(self):
        self.boundary(pg.PgLedgerConcurrencyLive,'test_concurrent_receipts')

    def test_b03c_warm_single_sustained_and_verification_plans(self):
        self.boundary(pg.PgLedgerPlanLive,'test_indexed_outcome_and_pending_plans')

    def test_b04_chain_tail_and_crash_recovery(self):
        # D1770: PG commit/outcome recovery replaces chain-tail recovery.
        self.boundary(pg.PgLedgerCrashLive,'test_process_cuts_and_settlement')

    def test_b05_expiry_checkpoint_and_holds(self):
        # D1794: independent row expiry replaces chain-prefix checkpoints.
        self.boundary(pg.PgLedgerHistoryRetentionLive,'test_history_endings_and_no_resurrection')

    def test_b06_complete_reload_and_clause_history(self):
        self.boundary(pg.PgLedgerContextLive,'test_actual_hold_clause_and_order_snapshot')

    def test_b07_migration_backup_restore_roles(self):
        self.boundary(pg.PgLedgerImportLive,'test_import_atomicity_and_restart')

    def test_b08_receipt_before_body(self):
        self.boundary(pg.PgLedgerAuthSuccessLive,'test_login_entry_atomic_publication')

    def test_b17_order_fact_history_and_classification(self):
        self.boundary(pg.PgLedgerRightsLive,'test_rights_and_isolation_atomic_publication')

    def test_b18_external_expiry_proof_and_torn_journal_restarts(self):
        # D1770: failure-only spool import/expiry replaces external proofs.
        self.boundary(pg.PgLedgerRetentionLive,'test_failure_expiry_and_delayed_spool_replay')

    def test_b19_backup_rehearsal_preserves_database_and_external_state(self):
        self.boundary(pg.PgLedgerNativeRestoreLive,'test_native_backup_private_recovery_and_selected_identity')


if __name__=='__main__':unittest.main()
