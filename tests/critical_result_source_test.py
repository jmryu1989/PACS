# coding: utf-8
"""TEST-S7-U1a-SERVICE SV11, the source half (contract S7-U1p section 2.3 SV11, section 3.2): the critical result sources
read the report only through ReportVersion rows, never the current Report body, a ReportDraft or the report preview.

REQ-S7-U1a-SOURCE-PIN -> RISK-S7-U1p-DRAFT-OR-LATEST / RISK-S7-CVR-SOURCE-BYPASS / RISK-S7-U1p-WIDENING -> this file and
tests/critical_result_service_test.cjs (whose PostgreSQL cases show that each answer carries its own pinned row).

Nothing here reads SQL or TypeScript by pattern (S7-U1a-R-001-F03, AGENTS 1-B.15). Two installed tools decide:
  1. TypeScript's compiler API (the development image of api/, KIN_TEST_API_DEV_IMAGE) parses every
     api/src/critical-result*.ts file and lists its imports, the $queryRaw/$executeRaw tagged templates with their literal
     parts, member names, string literals and identifiers. A raw query written another way (called as a function, an
     Unsafe variant, a template holding a template, a tag the check does not know) is refused, not read around.
  2. PostgreSQL 16 plans every template (EXPLAIN (VERBOSE, GENERIC_PLAN, FORMAT JSON), each ${...} a parameter) on a
     disposable postgres:16-alpine (--network none, tmpfs) holding every migration. The plan names each relation a
     statement scans, its alias and every column it outputs, filters or joins on, whatever alias, spacing or keyword case
     the statement is written with.
A file fails when a plan scans "ReportDraft" or reads a "Report" column other than uid and version (findings, conclusion
and recommendation are the current body; version is how the head is found), when it names a report, reportDraft or
reportPreview member (a Prisma delegate or the preview method; OrthancService.reportPreviewStudy, the original identity
read of section 3.1, is another name), a ReportDraft or report-preview string, fetch or require, or imports a module
outside the critical result's own list (the report preview controller, a pacs.service value, the consultation, question
and image request services, section 10.1). Which ReportVersion row a statement reads is the service test's to show: the
static check cannot tell the pinned version parameter from another one. Outside this check: a member reached by a key
computed at run time.
Each rule is shown on the real files and on probe modules this file writes itself (not cut from the product's text, so the
product's SQL may be rewritten in any equivalent form): equivalent spellings pass, each forbidden access fails.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import unittest
import uuid
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
SOURCES = sorted([*(ROOT / "api" / "src").glob("critical-result*.ts"), ROOT / "api/src/member-rights.ts"])
MIGRATIONS = sorted(p for p in (ROOT / "api" / "prisma" / "migrations").iterdir() if p.is_dir())
DEV_IMAGE = os.environ.get("KIN_TEST_API_DEV_IMAGE")
DATABASE = "kin_critical_result_source"
IMPORTS = {"@nestjs/common", "node:crypto", "crypto", "./member-rights", "./prisma.service", "./study-access.service", "./keycloak.service",
           "./orthanc.service", "./clinician-policy", "./critical-result-policy", "./critical-result.service"}
TYPE_ONLY_IMPORTS = {"./pacs.service"}
REPORT_COLUMNS = {"uid", "version"}
FORBIDDEN_MEMBERS = {"report", "reportDraft", "reportPreview", "$queryRawUnsafe", "$executeRawUnsafe"}
FORBIDDEN_TEXT = ("ReportDraft", "reportDraft", "report-preview", "reportPreview")
FORBIDDEN_IDENTIFIERS = {"fetch", "require", "XMLHttpRequest"}
SETTING = re.compile(r"SET LOCAL lock_timeout = '[0-9]+s'")
# plan nodes whose child scans PostgreSQL may give its physical target list (create_plan_recurse without CP_EXACT_TLIST)
WIDENING_PARENTS = {"Nested Loop", "Hash Join", "Merge Join", "Hash"}

# Runs in the development image: TypeScript's own parser over the texts on stdin ({label: {file: text}}).
EXTRACT = r"""
const ts = require('/app/node_modules/typescript');
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const RAW = new Set(['$queryRaw', '$executeRaw']);
const out = {};
for (const [label, files] of Object.entries(input)) {
  out[label] = {};
  for (const [name, text] of Object.entries(files)) {
    const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const r = { errors: sf.parseDiagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, ' ')), imports: [], templates: [],
      members: [], strings: [], identifiers: [], refused: [] };
    const line = node => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const holdsTemplate = node => { let found = false; const walk = n => { if (ts.isTemplateLiteral(n) || ts.isTaggedTemplateExpression(n)) found = true;
      else ts.forEachChild(n, walk); }; walk(node); return found; };
    const visit = node => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const clause = node.importClause, bound = [];
        if (clause && clause.name) bound.push(!!clause.isTypeOnly);
        if (clause && clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) bound.push(!!clause.isTypeOnly);
          else for (const el of clause.namedBindings.elements) bound.push(!!clause.isTypeOnly || !!el.isTypeOnly);
        }
        const typeOnly = ts.isExportDeclaration(node) ? !!node.isTypeOnly : bound.length > 0 && bound.every(Boolean);
        r.imports.push({ module: node.moduleSpecifier.text, typeOnly, line: line(node) });
      }
      if (ts.isImportEqualsDeclaration(node) || ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
        r.refused.push(line(node) + ': a module loaded another way than an import declaration');
      if (ts.isTaggedTemplateExpression(node)) {
        const tag = ts.isPropertyAccessExpression(node.tag) ? node.tag.name.text : ts.isIdentifier(node.tag) ? node.tag.text : null;
        const t = node.template;
        if (!RAW.has(tag)) r.refused.push(line(node) + ': a tagged template whose tag is not $queryRaw or $executeRaw: ' + node.tag.getText(sf));
        else if (ts.isTemplateExpression(t) && t.templateSpans.some(s => holdsTemplate(s.expression)))
          r.refused.push(line(node) + ': a ${...} of a raw query holds a template, which this check does not read');
        else r.templates.push({ tag, line: line(node),
          parts: ts.isNoSubstitutionTemplateLiteral(t) ? [t.text] : [t.head.text, ...t.templateSpans.map(s => s.literal.text)] });
      }
      if (ts.isPropertyAccessExpression(node)) {
        r.members.push(node.name.text);
        if (RAW.has(node.name.text) && !(ts.isTaggedTemplateExpression(node.parent) && node.parent.tag === node))
          r.refused.push(line(node) + ': ' + node.name.text + ' used other than as the tag of a template');
      }
      if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) r.members.push(node.argumentExpression.text);
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) r.strings.push(node.text);
      if (ts.isTemplateExpression(node)) r.strings.push(node.head.text, ...node.templateSpans.map(s => s.literal.text));
      // a name that refers to a binding, not a property or member name (this.studyAccess.require is StudyAccess's method)
      const named = node.parent && (ts.isPropertyAccessExpression(node.parent) || ts.isPropertyAssignment(node.parent)
        || ts.isMethodDeclaration(node.parent) || ts.isPropertyDeclaration(node.parent) || ts.isPropertySignature(node.parent)
        || ts.isMethodSignature(node.parent)) && node.parent.name === node;
      if (ts.isIdentifier(node) && !named) r.identifiers.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(sf);
    out[label][name] = r;
  }
}
process.stdout.write(JSON.stringify(out));
"""


def extract(variants: dict[str, dict[str, str]]) -> dict:
    """{label: {file: facts}} from TypeScript's parser, one container for every variant."""
    if not DEV_IMAGE:
        raise AssertionError("KIN_TEST_API_DEV_IMAGE must name the api development image (TypeScript compiler API)")
    run = subprocess.run(["docker", "run", "--rm", "-i", "--network", "none", "--read-only", "--entrypoint", "node", DEV_IMAGE,
                          "-e", EXTRACT], input=json.dumps(variants).encode("utf-8"), capture_output=True, timeout=300)
    if run.returncode:
        raise AssertionError("the TypeScript extraction failed: " + run.stderr.decode("utf-8", "replace")[:2000])
    return json.loads(run.stdout.decode("utf-8"))


class Database:
    """A disposable postgres:16-alpine with every migration, planning statements for the check."""

    def __init__(self) -> None:
        self.name = "kin-s7u1a-source-" + uuid.uuid4().hex[:12]
        made = subprocess.run(["docker", "run", "-d", "--name", self.name, "--network", "none", "--tmpfs", "/var/lib/postgresql/data",
                               "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=" + DATABASE, "postgres:16-alpine"],
                              capture_output=True, timeout=180)
        if made.returncode:
            raise AssertionError("postgres:16-alpine did not start: " + made.stderr.decode("utf-8", "replace"))
        try:
            deadline = time.monotonic() + 90
            while self.psql("SELECT 1", check=False).returncode:
                if time.monotonic() > deadline:
                    raise AssertionError("postgres:16-alpine did not answer")
                time.sleep(0.5)
            # every migration in the order Prisma applies them, in one session
            self.psql(b"\n".join((folder / "migration.sql").read_bytes() for folder in MIGRATIONS))
            self.plans: dict[str, list] = {}
            self.report_columns = set(self.psql("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' "
                                                "AND table_name = 'Report'").stdout.decode("utf-8").split())
        except BaseException:
            self.close()
            raise

    def psql(self, sql, check=True):
        # TCP to 127.0.0.1: the image's first-start server listens on the socket only, so this waits for the real one
        run = subprocess.run(["docker", "exec", "-i", self.name, "psql", "-XqAt", "-h", "127.0.0.1", "-U", "postgres", "-d", DATABASE,
                              "-v", "ON_ERROR_STOP=1"],
                             input=sql if isinstance(sql, bytes) else sql.encode("utf-8"), capture_output=True, timeout=120)
        if check and run.returncode:
            raise AssertionError("psql: " + run.stderr.decode("utf-8", "replace")[:2000])
        return run

    def plan(self, sql: str) -> list:
        """The plan of one statement; a statement the variants share is planned once."""
        if sql not in self.plans:
            self.plans[sql] = json.loads(self.psql("EXPLAIN (VERBOSE, GENERIC_PLAN, FORMAT JSON) " + sql).stdout.decode("utf-8"))
        return self.plans[sql]

    def close(self) -> None:
        subprocess.run(["docker", "rm", "-f", self.name], capture_output=True, timeout=120)


def plan_nodes(node):
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from plan_nodes(value)
    elif isinstance(node, list):
        for value in node:
            yield from plan_nodes(value)


def plan_texts(node, parent=None):
    """Every expression text of a plan that names what the statement reads: outputs, conditions and keys. A table scan
    under a join or a hash may return the whole row (PostgreSQL's physical target list) whatever the statement uses, so
    its Output is left out there; the join above it names the columns it takes, in its own Output and conditions."""
    if isinstance(node, dict):
        wide = "Relation Name" in node and parent in WIDENING_PARENTS
        for key, value in node.items():
            if key in ("Node Type", "Relation Name", "Schema", "Alias", "Parent Relationship") or key == "Output" and wide:
                continue
            yield from plan_texts(value, node.get("Node Type") if key == "Plans" else parent)
    elif isinstance(node, list):
        for value in node:
            yield from plan_texts(value, parent)
    elif isinstance(node, str):
        yield node


def statement_problems(db: Database, name: str, template: dict) -> list[str]:
    parts = template["parts"]
    sql = parts[0] + "".join(f"${number}{part}" for number, part in enumerate(parts[1:], 1))
    where = f"{name}:{template['line']}"
    normal = " ".join(sql.split())
    if normal.upper().startswith("SET "):
        return [] if SETTING.fullmatch(normal) else [f"{where}: a setting statement this check does not read: {normal[:80]}"]
    try:
        plan = db.plan(sql)
    except AssertionError as error:
        return [f"{where}: PostgreSQL does not plan the statement: {error}"]
    problems, aliases = [], set()
    relations = [node for node in plan_nodes(plan) if "Relation Name" in node]
    for node in relations:
        if node["Relation Name"] == "ReportDraft":
            problems.append(f"{where}: scans \"ReportDraft\", a personal draft")
        if node["Relation Name"] == "Report":
            aliases.add(node.get("Alias", "Report"))
    read = set()
    for alias in aliases:
        spelled = re.escape(alias) if re.fullmatch(r"[a-z_][a-z0-9_]*", alias) else re.escape('"' + alias + '"')
        read |= {column.strip('"') for text in plan_texts(plan)
                 for column in re.findall(rf"(?<![\w\"]){spelled}\.(\"[^\"]+\"|\w+)", text)}
    # With one relation in the statement, PostgreSQL prints its output columns without the alias (explain.c useprefix):
    # every column name of that one table is then that table's.
    if [node["Relation Name"] for node in relations] == ["Report"]:
        read |= {word.strip('"') for text in plan_texts(plan) for word in re.findall(r"\"[^\"]+\"|\b\w+\b", text)} & db.report_columns
    body = sorted(read - REPORT_COLUMNS)
    if body:
        problems.append(f"{where}: reads the current report body, \"Report\" columns {body}")
    return problems


def file_problems(name: str, facts: dict) -> list[str]:
    problems = [f"{name}: {error}" for error in facts["errors"]] + [f"{name}:{reason}" for reason in facts["refused"]]
    for item in facts["imports"]:
        allowed = item["module"] in IMPORTS or item["module"] in TYPE_ONLY_IMPORTS and item["typeOnly"]
        if not allowed:
            problems.append(f"{name}:{item['line']}: imports {item['module']!r}{'' if item['typeOnly'] else ' (a value)'}, outside the "
                            "critical result's own modules")
    for member in sorted(set(facts["members"]) & FORBIDDEN_MEMBERS):
        problems.append(f"{name}: names the member {member}")
    for text in sorted({t for t in facts["strings"] if any(word in t for word in FORBIDDEN_TEXT)}):
        problems.append(f"{name}: a string naming a draft or the preview: {text[:80]!r}")
    for identifier in sorted(set(facts["identifiers"]) & FORBIDDEN_IDENTIFIERS):
        problems.append(f"{name}: names {identifier}")
    return problems


def judge(db: Database, facts: dict) -> list[str]:
    problems = []
    for name, file in sorted(facts.items()):
        problems += file_problems(name, file)
        for template in file["templates"]:
            problems += statement_problems(db, name, template)
    return problems


PROBE = "critical-result.probe.ts"


def probe(body: str, imports: str = "") -> dict[str, str]:
    """A small api/src/critical-result*.ts module around one method body, judged on its own by the same rules as the real
    files. The probes are written here, not cut from the product's text, so the product's SQL can be rewritten in any
    equivalent way without touching this file."""
    return {PROBE: (imports + "import { Injectable } from '@nestjs/common';\n\n@Injectable()\nexport class CriticalResultProbe {\n"
                    "  constructor(private orthanc: any) {}\n\n  async read(tx: any, uid: string, version: number) {\n    "
                    + body + "\n  }\n}\n")}


EQUIVALENT = {
    "the head version read with aliases, AS, spacing and keyword case": probe(
        "return tx.$queryRaw`select   cur.version as \"headVersion\" , ver.action AS \"headAction\", ver.author AS \"headAuthor\",\n"
        "        ver.at AS \"headAt\"\n      FROM \"Report\" AS cur\n        LEFT JOIN \"ReportVersion\" AS ver\n"
        "          ON ver.uid = cur.uid AND ver.version = cur.version\n      WHERE cur.uid = ${uid}`;"),
    "the head version read with no alias": probe(
        "return tx.$queryRaw`SELECT \"Report\".version, \"ReportVersion\".action FROM \"Report\" LEFT JOIN \"ReportVersion\"\n"
        "      ON \"ReportVersion\".uid = \"Report\".uid AND \"ReportVersion\".version = \"Report\".version WHERE \"Report\".uid = ${uid}`;"),
    "a ReportVersion body with a table alias and another line layout": probe(
        "return tx.$queryRaw`SELECT pv.findings, pv.conclusion, pv.recommendation\n        FROM \"ReportVersion\" pv\n"
        "        WHERE pv.uid = ${uid} AND pv.version = ${version}`;"),
    "the original identity read of section 3.1": probe("return this.orthanc.reportPreviewStudy(uid);"),
}
# (probe, the reason the refusal must give)
FORBIDDEN = {
    "the head read also takes the current findings": (probe(
        "return tx.$queryRaw`SELECT r.version AS \"headVersion\", v.action AS \"headAction\", r.findings AS \"headFindings\"\n"
        "      FROM \"Report\" r LEFT JOIN \"ReportVersion\" v ON v.uid = r.uid AND v.version = r.version WHERE r.uid = ${uid}`;"),
        r"reads the current report body, \"Report\" columns \['findings'\]"),
    "the body read from Report": (probe("return tx.$queryRaw`SELECT findings, conclusion, recommendation FROM \"Report\" WHERE uid = ${uid}`;"),
        r"\"Report\" columns \['conclusion', 'findings', 'recommendation'\]"),
    # the second join is what the first depends on, so the planner cannot drop it as unused
    "Report joined again under another alias for its conclusion": (probe(
        "return tx.$queryRaw`SELECT r.version FROM \"Report\" AS cur LEFT JOIN \"Report\" r ON r.uid = cur.uid AND cur.conclusion <> ''\n"
        "      WHERE cur.uid = ${uid}`;"),
        r"\"Report\" columns \['conclusion'\]"),
    "a subquery reads the current body": (probe(
        "return tx.$queryRaw`SELECT (SELECT h.findings FROM \"Report\" h WHERE h.uid = ${uid}) AS findings, v.conclusion\n"
        "      FROM \"ReportVersion\" v WHERE v.uid = ${uid} AND v.version = ${version}`;"),
        r"\"Report\" columns \['findings'\]"),
    "every Report column": (probe("return tx.$queryRaw`SELECT * FROM \"Report\" WHERE uid = ${uid}`;"),
        r"\"Report\" columns \['conclusion', 'findings', 'recommendation', 'updatedAt', 'updatedBy'\]"),
    "a draft read in SQL": (probe("return tx.$queryRaw`SELECT findings FROM \"ReportDraft\" WHERE uid = ${uid}`;"),
        r"scans \"ReportDraft\", a personal draft"),
    "the draft delegate": (probe("return tx.reportDraft.findFirst({ where: { uid } });"), r"names the member reportDraft"),
    "the report delegate": (probe("return tx.report.findUnique({ where: { uid } });"), r"names the member report\b"),
    "the report preview controller imported": (probe("return ReportPreviewController;",
                                                     "import { ReportPreviewController } from './report-preview.controller';\n"),
        r"imports './report-preview\.controller' \(a value\)"),
    "the preview through a pacs.service value": (probe("return PacsService;", "import { PacsService } from './pacs.service';\n"),
        r"imports './pacs\.service' \(a value\)"),
    "the preview method": (probe("return (this as any).pacs.reportPreview(uid);"), r"names the member reportPreview"),
    "the preview route over HTTP": (probe("return fetch('http://127.0.0.1:3000/api/studies/' + uid + '/report-preview');"),
        r"a string naming a draft or the preview: '/report-preview'.*names fetch"),
    "an Unsafe raw query": (probe("return tx.$queryRawUnsafe('SELECT findings FROM \"Report\" WHERE uid = $1', uid);"),
        r"names the member \$queryRawUnsafe"),
    "a raw query called as a function": (probe("return tx.$queryRaw(Prisma.sql`SELECT findings FROM \"Report\"`);"),
        r"\$queryRaw used other than as the tag of a template"),
    "a template inside a raw query": (probe("return tx.$queryRaw`SELECT ${version ? `findings` : `version`} FROM \"Report\" WHERE uid = ${uid}`;"),
        r"a \$\{\.\.\.\} of a raw query holds a template"),
    "the question service imported": (probe("return ClinicianQuestionService;",
                                            "import { ClinicianQuestionService } from './clinician-question.service';\n"),
        r"imports './clinician-question\.service' \(a value\)"),
}


# D623: member eligibility is a DB module; it is also scanned above, never an unchecked report escape.
EQUIVALENT["member authority import"] = probe("return rightsUser(null);", "import { rightsUser } from './member-rights';\n")

class CriticalResultSourceTest(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.texts = {path.name: path.read_text(encoding="utf-8") for path in SOURCES}
        cls.db = Database()
        cls.addClassCleanup(cls.db.close)
        cls.facts = extract({"real": cls.texts, **EQUIVALENT, **{label: files for label, (files, _message) in FORBIDDEN.items()}})

    def test_01_the_real_sources_read_the_report_only_through_report_version(self) -> None:
        facts = self.facts["real"]
        self.assertTrue(facts, "no api/src/critical-result*.ts file")
        self.assertEqual(judge(self.db, facts), [])
        templates = [template for file in facts.values() for template in file["templates"]]
        self.assertGreater(len(templates), 0, "the check planned no statement")
        scanned = set()
        for template in templates:
            parts = template["parts"]
            sql = parts[0] + "".join(f"${number}{part}" for number, part in enumerate(parts[1:], 1))
            if not " ".join(sql.split()).upper().startswith("SET "):
                scanned |= {node["Relation Name"] for node in plan_nodes(self.db.plan(sql)) if "Relation Name" in node}
        print("CRITICAL_RESULT_SOURCE " + json.dumps({"files": sorted(facts), "templates": len(templates), "scanned": sorted(scanned),
              "imports": sorted({i["module"] for f in facts.values() for i in f["imports"]})}, sort_keys=True))

    def test_02_equivalent_spellings_pass(self) -> None:
        for label in EQUIVALENT:
            with self.subTest(equivalent=label):
                self.assertEqual(judge(self.db, self.facts[label]), [])

    def test_03_each_forbidden_access_fails_with_its_reason(self) -> None:
        reasons = {}
        for label, (_files, message) in FORBIDDEN.items():
            with self.subTest(forbidden=label):
                problems = judge(self.db, self.facts[label])
                self.assertTrue(problems, "passed")
                self.assertRegex(" | ".join(problems), message)
                reasons[label] = problems
        print("CRITICAL_RESULT_SOURCE_REFUSALS " + json.dumps({"equivalent_passed": sorted(EQUIVALENT), "refused": reasons},
                                                              ensure_ascii=True, sort_keys=True))


if __name__ == "__main__":
    unittest.main(verbosity=2)
