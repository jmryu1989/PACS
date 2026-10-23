# coding: utf-8
"""TEST-S4-U2-ORDER-RECONCILIATION: vector coverage and compiled server boundaries.

The shared vectors run against the shipped TS rule and JS client in
order_reconciliation_server_test.cjs and order_reconciliation_test.cjs.
The completed source-shape proof and third rule implementation remain in Git history.
Tenant/role, paging, identity, migration and hosted-entry checks stay here.
"""
# S9-U0b RELIST: PACS permission/data assertions run compiled suites through pacs_source.
# Remaining non-PACS source checks are unchanged U0f carry-over.
from ci_workflows import WorkflowCatalog
from pacs_source import assert_behaviour
from page_source import read_page_source
import json
import re
import sys
import unittest
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
# the restore fixture's own data (its migration list, tables and synthetic rows); importing it runs nothing
import ops_product_transfer_fixture as restore_fixture  # noqa: E402

VECTORS = json.loads((ROOT / "tests" / "order_reconciliation_vectors.json").read_text(encoding="utf-8"))
OBSERVATION_VECTORS = json.loads((ROOT / "tests" / "study_observation_vectors.json").read_text(encoding="utf-8"))


def text(*parts):
    return (ROOT.joinpath(*parts)).read_text(encoding="utf-8").replace("\r\n", "\n")


SEED = text("api", "src", "seed.ts")
SCHEMA = text("api", "prisma", "schema.prisma")
MIGRATION_NAME = "20260924120000_order_accession"
MIGRATION = text("api", "prisma", "migrations", MIGRATION_NAME, "migration.sql")
MAIN = read_page_source(ROOT.joinpath("worklist-v0", "hpacs-lite", "main.html"))
CATALOG = WorkflowCatalog(ROOT)
WORKFLOW = CATALOG.text()


# Shared display phrases also occur in the observation contract.




PHRASE = VECTORS["phrases"]["orderWithoutImages"]
MARKER = VECTORS["marker"]




class VectorCoverage(unittest.TestCase):

    def test_the_vectors_cover_each_contract_case(self):
        names = {case["name"] for case in VECTORS["reconcile"]}
        for required in ("same_accession_two_institutions_hallym", "same_accession_two_institutions_kin_center",
                         "tele_received_study_never_pairs", "restricted_caller_zero_unlinked_orders",
                         "unrestricted_control_for_the_restricted_case", "seed_orders_are_never_comparable"):
            self.assertIn(required, names)
        by = {case["name"]: case for case in VECTORS["reconcile"]}
        # Contract test 1: the same accession exists in both institutions and only the owner pairs.
        hallym, kin = by["same_accession_two_institutions_hallym"], by["same_accession_two_institutions_kin_center"]
        self.assertEqual(hallym["orders"], kin["orders"])
        self.assertEqual(hallym["expect"][0]["candidates"], [])
        self.assertEqual(kin["expect"][0]["candidates"], ["2.25.202"])
        # Contract test 2: zero unlinked orders AND zero candidates for the restricted caller, while the
        # unrestricted control on the same rows has both.
        restricted = by["restricted_caller_zero_unlinked_orders"]["expect"]
        self.assertFalse([row for row in restricted if row["link"] == "unlinked"])
        control = by["unrestricted_control_for_the_restricted_case"]["expect"]
        self.assertTrue([row for row in control if row["link"] == "unlinked" and row["candidates"]])
        # Contract test 3 (server half): a seed order has no accession and never pairs.
        for row in by["seed_orders_are_never_comparable"]["expect"]:
            self.assertEqual((row["accession"], row["candidates"]), ("absent", []))

    def test_phrases_are_the_study_arrivals_phrases(self):
        self.assertEqual(VECTORS["phrases"]["orderWithoutImages"], OBSERVATION_VECTORS["phrases"]["orderWithoutImages"])
        self.assertEqual(VECTORS["phrases"]["observationUnavailable"], OBSERVATION_VECTORS["phrases"]["observationUnavailable"])
        # IF-W09: a failure is never worded as an order without images, and no label may say done.
        for case in VECTORS["transitions"]:
            if case["key"] == "observation_unavailable":
                self.assertNotIn(PHRASE, case["text"], case["name"])
            self.assertTrue(case["hidden"] or case["text"].startswith("Order Reconciliation · " + MARKER), case["name"])
            for line in [case["text"], *case["rows"]]:
                self.assertIsNone(re.search(r"완료|수신 완료|안정|received|complete|stable|Scheduled|예정", line, re.I), line)


# ── 3. Source pins ────────────────────────────────────────────────────────────────────────────────


class ServerPins(unittest.TestCase):
    def test_list_reads_the_order_side_on_the_completing_page_before_the_access_recheck(self):
        assert_behaviour('order_reconciliation_server_test.cjs', '^S4-U2 (paged list|failures)')

    def test_order_side_query_is_tenant_filtered_and_carries_no_patient_field(self):
        assert_behaviour('order_reconciliation_server_test.cjs', '^S4-U2 (full list|restricted)')

    def test_the_answer_uses_the_same_successful_enumeration_and_the_server_read_accession(self):
        assert_behaviour('order_reconciliation_server_test.cjs', '^S4-U2 (compiled|full list|failures)')


    def test_no_existing_write_or_response_path_gained_the_accession(self):
        assert_behaviour('order_reconciliation_server_test.cjs', '^S4-U2 bootstrap')
        assert_behaviour('pacs_source_behavior_test.cjs', '^U0B-IDENTITY-MATCH')
        self.assertNotIn("accession", SEED, "the product never invents a seed accession")

    def test_identity_enumeration_default_is_unchanged_and_accession_is_opt_in(self):
        # WORKLIST-SPLIT-UID (spec F05, D73): the request and the carried accession are asserted on the compiled public
        # studyIdentities() over a recording transport, not on its source text.
        assert_behaviour('study_source_test.cjs', '^TEST-WSU-01 enumeration default')
        assert_behaviour('order_reconciliation_server_test.cjs', '^S4-U2 paged list')


class MigrationPins(unittest.TestCase):
    def test_the_migration_is_one_nullable_column_and_nothing_else(self):
        self.assertTrue(MIGRATION.startswith("--"))
        self.assertEqual(1, MIGRATION.count("ADD COLUMN"))
        self.assertIn('ALTER TABLE "Order" ADD COLUMN "accession" TEXT;', MIGRATION)
        body = "\n".join(line for line in MIGRATION.splitlines() if not line.startswith("--"))
        for forbidden in ("DEFAULT", "NOT NULL", "UPDATE", "DELETE", "DROP", "INSERT", "TRUNCATE", "INDEX"):
            self.assertNotIn(forbidden, body)
        self.assertIn("BEGIN;", body)
        self.assertIn("COMMIT;", body)

    def test_the_schema_declares_the_column_nullable_without_default(self):
        block = re.search(r"model Order \{(.*?)\n\}", SCHEMA, re.S).group(1)
        self.assertRegex(block, r"\n  accession String\?\n")
        self.assertNotRegex(block, r"accession[^\n]*@default")

    def test_the_image_and_restore_bookkeeping_name_the_migration(self):
        production = text("tests", "production_image_test.py")
        fixture = text("tests", "ops_product_transfer_fixture.py")
        self.assertIn("'" + MIGRATION_NAME + "'", production)
        # S4-U3's gateway-receipt and then S4-U4's gateway-retry-request migrations follow this one: 29 files.
        # The order is pinned, not a position from the end, so the next additive migration moves only the count.
        # S5-U4a's 20260926120000_study_questions (StudyQuestion, StudyQuestionEntry) was that one: 30 files.
        # S5-U4c's 20260926130000_study_image_requests (StudyImageRequest, StudyImageRequestReceipt): 31 files.
        # S7-U1a's 20260928120000_critical_result (CriticalResult, CriticalResultEvent, CriticalResultReceipt): 32 files.
        # S7-U3a's 20260928130000_reader_assignment_scope (ReaderAssignment keyed by study and institution): 33 files.
        # S7-AUDIT-STORE's 20260930120000_audit_log_append_only (the AuditLog guard trigger): 34 files.
        # S7-U5's 20261004120000_draft_revision_session_entry (draft boundary and entry proof columns): 35 files.
        # S7-U5 session end's 20261005120000_idp_session_end (IdpSessionEnd, AuthSession.idpSid): 36 files.
        # S7-U5 member isolation's 20261005130000_member_isolation (MemberIsolation): 37 files.
        # S7-U5's 20261006120000_member_isolation_call (MemberIsolation's call in flight, three columns): 38 files.
        # S7-U5 D600's 20261007120000_provider_change (ProviderChange; the in-flight columns dropped): 39 files.
        self.assertIn("'api/prisma/migrations/" + MIGRATION_NAME + "/migration.sql',", fixture)
        self.assertIn("accession='SYNTHETIC-ACC-1'", fixture)
        self.assertIn("'ReportDraft', 'Order', 'UserFilter',", fixture)
        names = sorted(p.name for p in (ROOT / "api" / "prisma" / "migrations").iterdir() if p.is_dir())
        # the restore fixture applies every migration directory, in order: its list compared as data
        # (S7-U1a-B-R-001-F03: not the text of ops_product_transfer_test.py's count assertion)
        self.assertEqual(restore_fixture.MIGRATIONS, ["api/prisma/migrations/" + name + "/migration.sql" for name in names])
        self.assertIn("api/prisma/migrations/20261008120000_emr_b/migration.sql", restore_fixture.MIGRATIONS)
        later =[MIGRATION_NAME, "20260924130000_gateway_receipt", "20260924140000_gateway_retry_request"]
        self.assertEqual(names[names.index(MIGRATION_NAME):names.index(MIGRATION_NAME) + 3], later)


def between(source, start, end):
    head = source.index(start)
    return source[head:source.index(end, head + len(start))]


class ClientPins(unittest.TestCase):


    def test_the_order_panel_carries_the_engineering_marker_and_the_box(self):
        panel = between(MAIN, '<div class="panel order-p" style="display:none">', "</div><!-- /workrow -->")
        self.assertIn('<span id="order-source-status" class="rel-title" style="color:#ffb454"', panel)
        self.assertIn(">Engineering Only</span>", panel)
        box = panel.index('<details id="order-reconciliation"')
        self.assertLess(panel.index('<tbody id="orderrows"></tbody>'), box)
        self.assertLess(box, panel.index('<div class="statusbar"><span id="orderhint">'))
        self.assertIn('<summary id="order-reconciliation-summary"></summary><div id="order-reconciliation-list"></div></details>', panel)
        self.assertRegex(panel, r'<details id="order-reconciliation" [^>]*hidden>')
        # The Order List itself is not relabelled: the existing header and columns stay.
        self.assertIn("<div class=\"on\">Order List (RIS)</div>", panel)


class WorkflowPins(unittest.TestCase):
    def test_hosted_steps_select_the_new_tests_with_their_source_hashes(self):
        for needle in (
            "--run-dir tmp/workspace-ui-ci/order-reconciliation-source",
            "-- python3 -B tests/order_reconciliation_source_test.py",
            "--run-dir tmp/workspace-ui-ci/order-reconciliation-dom",
            "-B tests/order_reconciliation_dom_test.py",
            "--run-dir tmp/runtime-ci/order-reconciliation-client",
            "node --test tests/order_reconciliation_test.cjs",
            "--run-dir tmp/runtime-ci/order-reconciliation-server",
            "--entrypoint node kin-api:ci --test /tests/order_reconciliation_server_test.cjs",
        ):
            self.assertEqual(1, WORKFLOW.count(needle), needle)
        self.assertEqual(1, WORKFLOW.count("--file worklist-v0/hpacs-lite/order-reconciliation.js --file tests/worklist_arrivals_dom_test.py"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
