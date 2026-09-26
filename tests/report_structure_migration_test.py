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
import json
import pathlib
import re
import sys
import unittest

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parents[1]
MIGRATION_DIR = ROOT / "api" / "prisma" / "migrations" / "20260921120000_report_structure"
MIGRATION = (MIGRATION_DIR / "migration.sql").read_text(encoding="utf-8")
SCHEMA = (ROOT / "api" / "prisma" / "schema.prisma").read_text(encoding="utf-8")
SERVICE = (ROOT / "api" / "src" / "pacs.service.ts").read_text(encoding="utf-8")
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
        names = re.search(r"const STRUCTURE_CHECKS = \[(.*?)\];", SERVICE, re.S)
        self.assertIsNotNone(names)
        self.assertEqual(sorted(re.findall(r"'([^']+)'", names.group(1))), sorted(CHECKS))
        # Three catch sites, the same three the citation column has: the draft write, the budget's
        # own refusal and the commit.
        self.assertEqual(SERVICE.count("isStructureCheck(error)") + SERVICE.count("isStructureCheck(e)"), 2)
        self.assertIn("structureLimit()", SERVICE)
        self.assertIn("REPORT_STRUCTURE_LIMIT", SERVICE)

    def test_every_limit_wrapper_call_names_a_method_that_exists(self) -> None:
        # B1: the candidate renamed the wrapper at its definition and at one of two call sites, so
        # `this.citationChecked` survived in forceDiscardDrafts and the API stopped compiling
        # (TS2339) - the image build fails before any compiled test runs, and an emitted build would
        # throw TypeError on every admin force-discard. A name check is cheap; tsc is not local.
        defined = set(re.findall(r"private async (\w+Checked)<", SERVICE))
        called = set(re.findall(r"this\.(\w+Checked)\(", SERVICE))
        self.assertEqual(defined, {"reportLimitChecked"})
        self.assertEqual(called - defined, set(), "a call to a wrapper that does not exist")
        self.assertEqual(SERVICE.count("this.reportLimitChecked("), 2,
                         "both writers of a version row - putReport and forceDiscardDrafts")
        self.assertEqual(SERVICE.count("citationChecked"), 0, "the old name must not survive")
        for owner in ("async putReport(", "async forceDiscardDrafts("):
            start = SERVICE.index(owner)
            end = SERVICE.index("\n  async ", start + len(owner))
            self.assertIn("this.reportLimitChecked(", SERVICE[start:end], owner)

    def test_the_rendered_sentence_is_cut_and_joined_never_pattern_replaced(self) -> None:
        # B2: `String.replace(needle, replacement)` expands `$$`, `$&`, '$`' and "$'" inside the
        # REPLACEMENT, so a value containing a dollar came out as something the reader never typed -
        # the stored `value` and the stored `renderedText` then say different things.
        client = (ROOT / "worklist-v0" / "hpacs-lite" / "report-structure.js").read_text(encoding="utf-8")
        for name, text, slot in (("report-structure.ts", PURE, "STRUCTURE_VALUE_SLOT"),
                                 ("report-structure.js", client, "VALUE_SLOT")):
            with self.subTest(file=name):
                render = text[text.index("function renderItem("):]
                render = render[:render.index("\n}") + 2] if name.endswith(".ts") else render[:render.index("\n    }") + 6]
                self.assertNotIn(".replace(", render, "a string replacement re-reads $ in the value")
                self.assertIn("indexOf(" + slot + ")", render)
                self.assertIn("slice(", render)

    def test_an_empty_list_is_cleared_with_DbNull_and_never_by_omission(self) -> None:
        # A1. `Prisma.JsonNull` would store the JSON value null - neither an array nor SQL NULL - and
        # `{}` on an update preserves whatever was there, so "I cleared it" would be false.
        self.assertEqual(SERVICE.count("{ structured: Prisma.DbNull }"), 1, "the explicit clear")
        self.assertEqual(SERVICE.count("structured: Prisma.JsonNull"), 0, "JsonNull is the trap")
        self.assertEqual(SERVICE.count("structured: null"), 0, "a JS null is the same trap")
        update = re.search(r"const structuredUpdate = (.*?);\n", SERVICE, re.S)
        self.assertIsNotNone(update)
        self.assertIn("!structure ? {}", update.group(1), "no request change must omit")
        create = re.search(r"const structuredCreate = (.*?);\n", SERVICE, re.S)
        self.assertIsNotNone(create)
        self.assertIn("entries.length", create.group(1))
        self.assertIn("{}", create.group(1), "create has nothing to clear, so it omits")

    def test_every_writer_of_a_version_row_carries_the_column(self) -> None:
        # P1/P2: three writers exist - commit, reset's preserved row, and the admin force discard.
        self.assertIn("...(structured.length ? { structured } : {})", SERVICE)
        self.assertIn("...(headStructured.length ? { structured: headStructured } : {})", SERVICE)
        self.assertIn("...(d.structured === null || d.structured === undefined ? {} : { structured: d.structured })",
                      SERVICE)

    def test_the_force_discard_select_names_the_column(self) -> None:
        # A raw SELECT that forgets the column destroys the evidence while preserving the sentence,
        # and nothing at runtime would say so.
        select = re.search(r'SELECT uid, author, findings, conclusion, recommendation, "baseVersion",(.*?)FROM "ReportDraft"',
                           SERVICE, re.S)
        self.assertIsNotNone(select)
        self.assertIn("structured", select.group(1))
        self.assertIn("citations", select.group(1))

    def test_the_commit_lock_reads_both_json_columns_in_one_statement(self) -> None:
        self.assertIn('SELECT citations, structured FROM "ReportDraft"', SERVICE)
        self.assertIn('SELECT structured FROM "ReportDraft"', SERVICE)

    def test_no_existing_response_gained_the_column(self) -> None:
        # P9/P15: `versions()` selects by name and `toClient` projects five draft fields. If either
        # started returning rows wholesale, this column would leave through a surface that never
        # gated it.
        versions = re.search(r"return this\.prisma\.reportVersion\.findMany\((.*?)\}\);", SERVICE, re.S)
        self.assertIsNotNone(versions)
        self.assertNotIn("structured", versions.group(1))
        to_client = re.search(r"draft: \(hidden \|\| !d\) \? null : \{(.*?)\},\n", SERVICE, re.S)
        self.assertIsNotNone(to_client)
        self.assertNotIn("structured", to_client.group(1))

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
        transfer_test = (ROOT / "tests" / "ops_product_transfer_test.py").read_text(encoding="utf-8")
        # S4-U2's order-accession migration moved the pinned count from 26 to 27 in the same commit,
        # S4-U3's gateway-receipt migration from 27 to 28 in its own, and S4-U4's gateway-retry-request
        # migration from 28 to 29 in its own.
        # S5-U4a's 20260926120000_study_questions (StudyQuestion, StudyQuestionEntry) moved it from 29 to 30.
        self.assertIn("self.assertEqual(len(transfer.MIGRATIONS), 30)", transfer_test)

    def test_the_synthetic_catalog_never_reaches_product_code(self) -> None:
        # P6/P7. The seam is one instance property a test overwrites on its own instance; anything
        # else (env var, header, route) would make invented clinical content reachable from the
        # product. P12 made it a validated property pair - still one seam, now with a gate on it.
        self.assertIn("protected get structureCatalog()", SERVICE)
        self.assertIn("protected set structureCatalog(", SERVICE)
        self.assertIn("validateCatalog(next);", SERVICE,
                      "the setter is the gate; an unchecked catalog must not be installable")
        self.assertEqual(SERVICE.count("SYN-"), 0, "no synthetic item may be named in the service")
        self.assertEqual(PURE.count("SYN-"), 0, "nor in the pure module")
        self.assertEqual(PURE.count("process.env"), 0, "no environment-variable seam")
        self.assertEqual(SERVICE.count("svc.structureCatalog"), 0)
        # The literal is brace-matched with string contents skipped, not regex-scraped: `[^\]]*`
        # stops at the first `]`, and every shipped template contains `{value}`. A truncated
        # extraction here would turn the leak assertion below into a test of nothing.
        # (The same scanner, with its own corner-case cases, lives in report_structure_vectors_test.)
        anchor = "STRUCTURE_CATALOG: readonly StructureTemplate[] = Object.freeze("
        at = PURE.index(anchor)
        start = PURE.index("[", at + len(anchor))
        depth, quote, escaped, end = 0, False, False, -1
        for i in range(start, len(PURE)):
            ch = PURE[i]
            if quote:
                # `\"` closes nothing and `\\` closes the escape, so the previous character's state
                # has to be consumed BEFORE this one is judged.
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    quote = False
                continue
            if ch == '"':
                quote = True
            elif ch in "[{":
                depth += 1
            elif ch in "]}":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        self.assertGreater(end, start, "the shipped catalog literal is never closed")
        catalog = json.loads(PURE[start:end])
        self.assertIsInstance(catalog, list, "the shipped catalog must be strict JSON in an array")
        self.assertEqual(json.dumps(catalog, ensure_ascii=False).count("SYN-"), 0,
                         "no synthetic fixture may be reachable from the shipped catalog")


if __name__ == "__main__":
    unittest.main(verbosity=2)
