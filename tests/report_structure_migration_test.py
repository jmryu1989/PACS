"""TEST-S3-STRUCT-MIGRATION: the additive migration, the bounds, the NULL-writing rules and the
places a new column can silently leak or silently vanish.

Textual, host-pure: no database, no container, no network. What this file proves is that the SOURCE
says the right thing; whether PostgreSQL raises the CHECK carrying the constraint name, and whether
a dump/restore really round-trips the column, are real-database facts proved by the hosted restore
and image jobs.

Why textual assertions are worth having here: the three failures this unit can cause are all
invisible at runtime until it is too late - a column that no SELECT names (the evidence is gone), an
`update` that omits instead of clearing (the clear silently did nothing), and a `select` that names
a row wholesale (the column leaks through a response that never gated it).
"""
# S9-U0b RELIST: PACS permission/data assertions run compiled suites through pacs_source.
# Remaining non-PACS source checks are unchanged U0f carry-over.
# Byte pins are confined to the explicit move/SQL provenance contract (pacs_split_contract.cjs);
# real PostgreSQL locking and constraint behaviour still require the existing hosted suites.
from pacs_source import assert_behaviour
import json
import pathlib
import re
import sys
import unittest

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
# the restore fixture's own data (its migration list, tables and synthetic rows); importing it runs nothing
import ops_product_transfer_fixture as restore_fixture  # noqa: E402

MIGRATION_DIR = ROOT / "api" / "prisma" / "migrations" / "20260921120000_report_structure"
MIGRATION = (MIGRATION_DIR / "migration.sql").read_text(encoding="utf-8")
SCHEMA = (ROOT / "api" / "prisma" / "schema.prisma").read_text(encoding="utf-8")
CONTROLLER = (ROOT / "api" / "src" / "pacs.controller.ts").read_text(encoding="utf-8")
PURE = (ROOT / "api" / "src" / "report-structure.ts").read_text(encoding="utf-8")
INVARIANTS = (ROOT / "tests" / "invariants_live.py").read_text(encoding="utf-8")
PRODUCTION = (ROOT / "tests" / "production_image_test.py").read_text(encoding="utf-8")

CHECKS = ("ReportDraft_structured_check", "ReportVersion_structured_check")


class ReportStructureMigration(unittest.TestCase):
    def test_the_migration_is_additive_and_nothing_else(self) -> None:
        self.assertEqual(MIGRATION.count("ADD COLUMN"), 2)
        for table in ("ReportDraft", "ReportVersion"):
            self.assertIn(f'ALTER TABLE "{table}" ADD COLUMN "structured" JSONB;', MIGRATION)
        for forbidden in ("DROP ", "DELETE ", "UPDATE ", "TRUNCATE", "NOT NULL", "DEFAULT"):
            self.assertNotIn(forbidden, MIGRATION, f"{forbidden} has no place in an additive migration")
        self.assertTrue(MIGRATION.strip().startswith("--"))
        self.assertIn("BEGIN;", MIGRATION)
        self.assertIn("COMMIT;", MIGRATION)

    def test_both_checks_allow_null_and_bound_the_same_two_numbers(self) -> None:
        # A CHECK yields UNKNOWN for NULL, which passes; saying it out loud is what keeps every row
        # written before this migration legal forever.
        for name in CHECKS:
            self.assertIn(f'ADD CONSTRAINT "{name}"', MIGRATION)
        self.assertEqual(MIGRATION.count('IS NULL OR'), 2)
        self.assertEqual(MIGRATION.count("jsonb_array_length(\"structured\") <= 64"), 2)
        self.assertEqual(MIGRATION.count("octet_length(convert_to(\"structured\"::text, 'UTF8')) <= 65536"), 2)
        self.assertEqual(MIGRATION.count("ELSE false END) IS TRUE);"), 2)
        limits = re.search(r"REPORT_STRUCTURE_LIMITS = Object\.freeze\((\{[^}]*\})\)", PURE)
        self.assertIsNotNone(limits)
        self.assertIn("entries: 64", limits.group(1))
        self.assertIn("bytes: 65536", limits.group(1))
        self.assertIn("renderedText: 512", limits.group(1))

    def test_the_schema_declares_both_columns_nullable(self) -> None:
        for model in ("ReportDraft", "ReportVersion"):
            block = re.search(r"model " + model + r" \{(.*?)\n\}", SCHEMA, re.S)
            self.assertIsNotNone(block, model)
            self.assertRegex(block.group(1), r"structured\s+Json\?")
        # No mirror on Report: two places holding the same fact is how they come to disagree.
        report = re.search(r"model Report \{(.*?)\n\}", SCHEMA, re.S).group(1)
        self.assertNotIn("structured", report)

    def test_the_service_maps_our_check_names_and_only_ours(self) -> None:
        assert_behaviour('report_structure_test.cjs', '^(our CHECK|B1 the forced release)')


    def test_an_empty_list_is_cleared_with_DbNull_and_never_by_omission(self) -> None:
        # A1. `Prisma.JsonNull` would store the JSON value null - neither an array nor SQL NULL - and a key left out of
        # an update preserves whatever was there, so "I cleared it" would be false.
        # S7-U5: the draft is written in one place (`storeDraft`) from the whole snapshot, so there is no "request did
        # not mention it" branch left: an update always names the column, a new row omits an empty one.
        assert_behaviour('report_structure_test.cjs', '^A1 ')
    def test_every_writer_of_a_version_row_carries_the_column(self) -> None:
        # P1/P2: three writers exist - commit, reset's preserved row, and the admin force discard.
        assert_behaviour('report_structure_test.cjs', '^(commit keeps|reset carries|force discard)')

    def test_the_force_discard_select_names_the_column(self) -> None:
        # A raw SELECT that forgets the column destroys the evidence while preserving the sentence,
        # and nothing at runtime would say so.
        assert_behaviour('report_structure_test.cjs', '^force discard')

    def test_the_commit_lock_reads_both_json_columns_in_one_statement(self) -> None:
        # S7-U5: the caller's row is locked and read once (`ownDraft`), by the draft write and the commit alike.
        assert_behaviour('pacs_split_test.cjs', '^(U0B-STRUCT-NORMAL|U0B-HISTORY)')

    def test_no_existing_response_gained_the_column(self) -> None:
        # P9/P15: `versions()` selects by name and `toClient` projects five draft fields. If either
        # started returning rows wholesale, this column would leave through a surface that never
        # gated it.
        assert_behaviour('report_citation_test.cjs', '^the history response')
        assert_behaviour('pacs_source_behavior_test.cjs', '^U0B-PROJECTION')
    def test_the_one_new_route_is_declared_where_the_live_suite_checks_it(self) -> None:
        self.assertIn("@Get('studies/:uid/report/structure')", CONTROLLER)
        self.assertIn('("GET", "studies/:uid/report/structure"): Route(Kind.REPORT, "structure")', INVARIANTS)
        self.assertEqual(CONTROLLER.count("report/structure"), 1)

    def test_the_migration_is_in_the_image_and_transfer_bookkeeping(self) -> None:
        self.assertIn("20260921120000_report_structure", PRODUCTION)
        fixture = (ROOT / "tests" / "ops_product_transfer_fixture.py").read_text(encoding="utf-8")
        self.assertIn("api/prisma/migrations/20260921120000_report_structure/migration.sql", fixture)

    def test_the_transfer_fixture_carries_a_real_value_in_both_tables(self) -> None:
        # P5/B5: with every fixture value NULL, a dump that dropped the column would pass on NULLs.
        fixture = (ROOT / "tests" / "ops_product_transfer_fixture.py").read_text(encoding="utf-8")
        self.assertRegex(fixture, r"structured=structured if number == 2 else None")
        self.assertRegex(fixture, r"structured=structured if number == 1 else None")
        self.assertIn("SYNTHETIC-ITEM choice = alpha", fixture)
        # The restore fixture applies every migration directory, in order, this one included: its list compared as data
        # (S7-U1a-B-R-001-F03: not the text of ops_product_transfer_test.py's count assertion).
        # S4-U2's order-accession migration moved the count from 26 to 27 in the same commit,
        # S4-U3's gateway-receipt migration from 27 to 28 in its own, and S4-U4's gateway-retry-request
        # migration from 28 to 29 in its own.
        # S5-U4a's 20260926120000_study_questions (StudyQuestion, StudyQuestionEntry) moved it from 29 to 30.
        # S5-U4c's 20260926130000_study_image_requests (StudyImageRequest, StudyImageRequestReceipt) from 30 to 31.
        # S7-U1a's 20260928120000_critical_result (CriticalResult, CriticalResultEvent, CriticalResultReceipt) from 31 to 32.
        # S7-U3a's 20260928130000_reader_assignment_scope (ReaderAssignment keyed by study and institution) from 32 to 33.
        # S7-AUDIT-STORE's 20260930120000_audit_log_append_only (the AuditLog guard trigger) from 33 to 34.
        # S7-U5's 20261004120000_draft_revision_session_entry (draft boundary and entry proof columns) from 34 to 35.
        # S7-U5 session end's 20261005120000_idp_session_end (IdpSessionEnd, AuthSession.idpSid) from 35 to 36.
        # S7-U5 member isolation's 20261005130000_member_isolation (MemberIsolation) from 36 to 37.
        # S7-U5's 20261006120000_member_isolation_call (MemberIsolation's call in flight, three columns) from 37 to 38.
        # S7-U5 D600's 20261007120000_provider_change (ProviderChange; the in-flight columns dropped) from 38 to 39.
        names = sorted(p.name for p in (ROOT / "api" / "prisma" / "migrations").iterdir() if p.is_dir())
        self.assertEqual(restore_fixture.MIGRATIONS, ["api/prisma/migrations/" + name + "/migration.sql" for name in names])
        self.assertIn(MIGRATION_DIR.name, names)
        self.assertIn("api/prisma/migrations/20261008120000_emr_b/migration.sql", restore_fixture.MIGRATIONS)


if __name__ == "__main__":
    unittest.main(verbosity=2)
