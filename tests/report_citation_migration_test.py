"""TEST-S3-U2a-CITATION-MIGRATION: the additive migration, its bounds and the leak boundary.

REQ-S3-U2a-CITATION-BACKEND -> RISK-S3-CITATION-LEAK/CHECK-AS-500/DESTRUCTIVE-MIGRATION
-> TEST-S3-U2a-CITATION-MIGRATION.

Four failures this file is here to catch, each of which has a real cost and none of which needs a
database to see:

1. A CHECK copied from the findings migration rejects NULL, because `(CASE ... ELSE false END) IS
   TRUE` is false for NULL. Every existing row and every old-client write would then be refused.
2. The application bound is measured in a shorter JS serialization than the database's canonical
   jsonb text, so the service accepts what the CHECK refuses and the refusal surfaces as a 500.
3. A constraint is renamed, so the service's narrow name-based 409 mapping stops recognising it -
   the person is told the server broke instead of "remove a citation".
4. `versions()` or `toClient` starts carrying the new column, widening a read surface that was
   never re-gated for finding readability.

Pure: reads source files, no stack, no container, no network, no database.
"""
import pathlib
import re
import sys
import unittest

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parents[1]
MIGRATION_NAME = "20260920120000_report_citations"
MIGRATION = ROOT / "api" / "prisma" / "migrations" / MIGRATION_NAME / "migration.sql"
SCHEMA = ROOT / "api" / "prisma" / "schema.prisma"
SERVICE = ROOT / "api" / "src" / "pacs.service.ts"
PURE = ROOT / "api" / "src" / "report-citation.ts"
IMAGE_TEST = ROOT / "tests" / "production_image_test.py"
TRANSFER = ROOT / "tests" / "ops_product_transfer_fixture.py"
COLUMNS = ("ReportDraft", "ReportVersion")


def body_of(source: str, opening: str) -> str:
    """The text from `opening` to its matching closing brace."""
    start = source.index(opening)
    depth = 0
    for index in range(start, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise AssertionError("unbalanced braces after " + opening)


class SourceCase(unittest.TestCase):
    """Shared readers. No test lives here, so the cases below run once each, not once per subclass."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.sql = MIGRATION.read_text(encoding="utf-8")
        cls.schema = SCHEMA.read_text(encoding="utf-8")
        cls.service = SERVICE.read_text(encoding="utf-8")
        cls.pure = PURE.read_text(encoding="utf-8")

    def constraint(self, table: str) -> str:
        match = re.search(rf'CONSTRAINT "{table}_citations_check" CHECK \((.*)\);', self.sql)
        self.assertIsNotNone(match, f"{table} has no named citations CHECK")
        return match.group(1)


class MigrationTests(SourceCase):
    def statements(self) -> list[str]:
        without_comments = "\n".join(
            line for line in self.sql.splitlines() if not line.strip().startswith("--"))
        return [statement.strip() for statement in without_comments.split(";") if statement.strip()]

    def test_the_migration_is_additive_only(self) -> None:
        for statement in self.statements():
            with self.subTest(statement[:60]):
                head = statement.upper()
                self.assertTrue(
                    head.startswith("BEGIN") or head.startswith("COMMIT")
                    or head.startswith("ALTER TABLE"),
                    "only BEGIN/COMMIT/ALTER TABLE belong in an additive migration")
                for forbidden in ("DROP", "DELETE", "UPDATE ", "TRUNCATE", "CREATE TABLE", "NOT NULL", "DEFAULT"):
                    self.assertNotIn(forbidden, head, f"{forbidden} would not be additive")

    def test_both_columns_are_added_as_nullable_jsonb(self) -> None:
        for table in COLUMNS:
            with self.subTest(table):
                self.assertIn(f'ALTER TABLE "{table}" ADD COLUMN "citations" JSONB', self.sql)

    def test_each_check_allows_null_out_loud(self) -> None:
        # A CHECK accepts UNKNOWN, so `(CASE ... ELSE false END) IS TRUE` is FALSE for NULL and
        # would refuse every row written before this migration.
        for table in COLUMNS:
            with self.subTest(table):
                clause = self.constraint(table)
                self.assertIn('"citations" IS NULL OR', clause,
                              "NULL is the old behaviour and has to stay legal")
                self.assertIn("IS TRUE", clause, "a definite true is still required for an array")
                self.assertIn("ELSE false END", clause)

    def test_each_check_bounds_entries_and_canonical_bytes(self) -> None:
        for table in COLUMNS:
            with self.subTest(table):
                clause = self.constraint(table)
                self.assertIn("jsonb_typeof(\"citations\") = 'array'", clause)
                self.assertIn('jsonb_array_length("citations") <= 64', clause)
                # The canonical PostgreSQL jsonb text form in UTF-8 bytes - never a shorter
                # application serialization, or the service would pass what this refuses.
                self.assertIn('octet_length(convert_to("citations"::text, \'UTF8\')) <= 65536', clause)

    def test_the_service_maps_exactly_these_constraint_names(self) -> None:
        names = re.search(r"const CITATION_CHECKS = \[([^\]]*)\]", self.service)
        self.assertIsNotNone(names, "the service no longer names the constraints it maps")
        mapped = set(re.findall(r"'([^']+)'", names.group(1)))
        self.assertEqual(mapped, {f"{table}_citations_check" for table in COLUMNS},
                         "a renamed constraint turns the named 409 back into a 500")

    def test_the_application_limits_equal_the_database_bounds(self) -> None:
        limits = re.search(r"REPORT_CITATION_LIMITS = Object\.freeze\((\{[^}]*\})\)", self.pure)
        self.assertIsNotNone(limits)
        self.assertIn("entries: 64", limits.group(1))
        self.assertIn("bytes: 65536", limits.group(1))

    def test_the_limit_is_measured_by_the_database(self) -> None:
        # The one place the service decides whether a citation array fits has to ask PostgreSQL,
        # because that is the only measure the CHECK agrees with.
        budget = body_of(self.service, "private async citationBudget(")
        self.assertIn("octet_length(convert_to(", budget)
        self.assertIn("::jsonb::text, 'UTF8')", budget)
        self.assertNotIn("JSON.stringify", budget)
        self.assertNotIn("Buffer.byteLength", budget)

    def test_the_refusal_is_named_and_never_routes_an_old_tab_into_the_reload_branch(self) -> None:
        limit = body_of(self.service, "const citationLimit = () =>")
        self.assertIn("REPORT_CITATION_LIMIT", limit)
        # An old tab branches on this substring and then overwrites the editor from the server.
        self.assertNotIn("저장했습니다", limit)
        self.assertIn("제거", limit, "the message has to name the way out")


class SchemaTests(SourceCase):
    def test_both_models_gain_an_optional_json_column(self) -> None:
        for model in COLUMNS:
            with self.subTest(model):
                block = body_of(self.schema, f"model {model} ")
                self.assertRegex(block, r"citations\s+Json\?")

    def test_no_mirror_and_no_new_table(self) -> None:
        report = body_of(self.schema, "model Report ")
        self.assertNotIn("citations", report,
                         "a Report mirror would let the same fact disagree with itself")
        self.assertNotIn("model ReportCitation", self.schema, "no linking table")

    def test_the_migration_is_registered_where_restores_read_it(self) -> None:
        # 2026-09-09: a migration landed without these two lists and CI runtime failed for 12 commits.
        self.assertIn(MIGRATION_NAME, IMAGE_TEST.read_text(encoding="utf-8"))
        transfer = TRANSFER.read_text(encoding="utf-8")
        self.assertIn(f"api/prisma/migrations/{MIGRATION_NAME}/migration.sql", transfer)
        tables = re.search(r"TABLES = sorted\(\[(.*?)\]\)", transfer, re.S)
        self.assertIsNotNone(tables)
        self.assertNotIn("ReportCitation", tables.group(1), "the table list must not grow")

    def test_the_restore_fixture_actually_carries_a_citation(self) -> None:
        transfer = TRANSFER.read_text(encoding="utf-8")
        self.assertIn("citations=citation if number == 2 else None", transfer)
        self.assertIn("citations=citation if number == 1 else None", transfer)


class LeakBoundaryTests(SourceCase):
    def test_versions_selects_its_columns_explicitly_and_omits_citations(self) -> None:
        versions = body_of(self.service, "async versions(")
        self.assertIn("select: {", versions, "a whole-row history response would carry citations")
        self.assertNotIn("citations", versions)

    def test_to_client_is_untouched(self) -> None:
        # The 30-second poll and the bootstrap payload both go through here. Nothing about
        # citations - not the bodies and not a count - may enter it.
        self.assertNotIn("citations", body_of(self.service, "function toClient("))

    def test_the_draft_projection_still_lists_its_fields(self) -> None:
        to_client = body_of(self.service, "function toClient(")
        for field in ("findings: d.findings", "baseVersion: d.baseVersion"):
            self.assertIn(field, to_client)

    def test_the_dedicated_read_regates_finding_readability(self) -> None:
        read = body_of(self.service, "async reportCitations(")
        self.assertIn("canReadPrelim", read, "the report gate has to be re-applied here")
        self.assertIn("readableFindings", read, "the narrower finding gate is the point of this read")
        self.assertIn("RepeatableRead", read, "head and draft must come from one snapshot")
        self.assertIn("studyAccess.prepare(c)", read,
                      "lineage authorization has to be prepared before the transaction")

    def test_the_read_asks_one_row_at_a_time(self) -> None:
        # head + draft can name 128 distinct findings while each row is individually legal. Asking
        # for all of them at once trips the 64 cap of the very query that lists the cids, so the
        # signer told to "remove some" cannot see what to remove.
        read = body_of(self.service, "async reportCitations(")
        self.assertNotIn("entries * 2", read, "one call for both rows can ask for 128 ids and trip the 64 cap")
        self.assertIn("for (const ids of [findingIds(head), findingIds(mine)])", read)

    def test_the_commit_locks_the_draft_row_it_deletes(self) -> None:
        # Reading the draft's citations unlocked and deleting the row later loses a same-author
        # insertion that lands in between - the user's own confirmed work.
        commit = body_of(self.service, "async commitReport(")
        statement = 'FROM "ReportDraft" WHERE uid = ${uid} AND author = ${c.actor} FOR UPDATE'
        # assertIn first: a missing lock has to read as this failure, not as a ValueError from index().
        self.assertIn(statement, commit, "the commit must take the row lock the insertion also takes")
        lock = commit.index(statement)
        self.assertLess(lock, commit.index("reportDraft.deleteMany"))
        self.assertLess(commit.index('FROM "Report" WHERE uid = ${uid} FOR UPDATE'), lock,
                        "one lock order for every path: StudyState, Report, then my draft")

    def test_the_forced_release_retry_is_inside_the_same_mapping(self) -> None:
        # S3-structured-report renamed this wrapper to `reportLimitChecked` because it now maps two
        # CHECK families, not one. The assertion is the same one: the retry leg must sit INSIDE the
        # mapping, or a CHECK raised by the second attempt escapes as a 500.
        force = body_of(self.service, "async forceDiscardDrafts(")
        self.assertIn("this.reportLimitChecked(", force)
        self.assertNotIn("this.citationChecked(", force, "the old name must not survive anywhere")
        self.assertIn("if (e?.code !== 'P2002')", force)
        self.assertLess(force.index("this.reportLimitChecked("), force.index("if (e?.code !== 'P2002')"),
                        "a CHECK raised by the retry would otherwise surface as a 500")

    def test_both_counts_use_one_equivalence(self) -> None:
        counts = body_of(self.pure, "export function sameTextCounts(")
        self.assertIn("comparisonKey(", counts)
        self.assertNotIn("normalizeForCompare(", counts)
        self.assertIn("blockLines(text).join(", body_of(self.pure, "export function comparisonKey("))

    def test_the_runtime_harness_cannot_lose_its_own_failure(self) -> None:
        """The first hosted run of that case reported only 'docker run failed (exit 1)': the script
        set process.exitCode and ops.run raised before anything was printed, so the one fact pin A1
        asks for - what the driver actually raised - was lost in exactly the failing case."""
        whole = (ROOT / "tests" / "viewer_migration_test.py").read_text(encoding="utf-8")
        # Only the citation harness; the older fixed-image case in the same file keeps its own tail.
        harness = whole[whole.index("CITATION_PRELUDE = "):whole.index("def test_workspace_shortcuts")]
        self.assertIn("console.log('SCRIPT-FAILED '", harness, "a failing script must say why on stdout")
        self.assertNotIn("process.exitCode", harness, "a non-zero exit makes ops.run swallow the output")
        self.assertEqual(harness.count("report(async()=>{"), 2, "both scripts must go through the reporting tail")
        for receipt in ("first", "second"):
            printed = harness.index("print(%s)" % receipt)
            self.assertLess(printed, harness.index("self.assertNotIn('SCRIPT-FAILED', %s" % receipt),
                            "print the output, then refuse the marker, then look for the sentinels")
        # The lock proof must rest on the signed cid set, not on a rejection or on elapsed time.
        self.assertIn("signed=2 entries", harness)
        self.assertNotIn("assert.ok(blocked", harness, "an arbitrary rejection proves nothing about the lock")

    def test_the_insertion_prepares_access_outside_the_transaction(self) -> None:
        put = body_of(self.service, "async putReport(")
        prepare = put.index("studyAccess.prepare(c)")
        scope = put.index("this.scopeWrite(")
        self.assertLess(prepare, scope,
                        "inside the transaction `allowed` cannot prepare and answers 409 instead")


if __name__ == "__main__":
    unittest.main(verbosity=2)
