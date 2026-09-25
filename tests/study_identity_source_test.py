# coding: utf-8
"""TEST-S4-U5-STUDY-IDENTITY source (stdlib only; no browser, container, database, Node or network).

What this file proves, and nothing more (review M-2):
  1. tests/study_identity_vectors.json is well formed and carries every named example of the reviewed contract
     (section 3.2 + N-2 + N-3). The expected values are hand-authored; the product rule is judged against them by
     the compiled TS in kin-api:ci (tests/study_identity_server_test.cjs) and the client summary by
     tests/study_identity_test.cjs. There is deliberately no Python model of the rule here: a second implementation
     would agree with itself and prove nothing about api/src/study-identity.ts.
  2. Source pins that the shipped files still carry the reviewed decisions: the tenant-pinned second Order read and
     its position, relations only from server-read tags, no Order value in the answer, the M-1/N-1 shape checks after
     every existing refusal, unchanged write sites and neighbour surfaces, the client allowlist/escaping, the truthful
     Modify path, the QIDO restore after Unmatch, list invalidation, the guarded Order List refresh, the M-3 wording,
     the forbidden-word table, the one new live method and the hosted steps that run the real code.
What it cannot see: whether TypeScript compiles, the browser renders, or PostgreSQL/Orthanc behave as the source says.
"""
import hashlib
import json
import math
import re
import sys
import unicodedata
import unittest
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]


def text(*parts):
    return ROOT.joinpath(*parts).read_text(encoding="utf-8").replace("\r\n", "\n")


VECTORS = json.loads(text("tests", "study_identity_vectors.json"))
RULE = text("api", "src", "study-identity.ts")
SERVICE = text("api", "src", "pacs.service.ts")
CONTROLLER = text("api", "src", "pacs.controller.ts")
U2_RULE = text("api", "src", "order-reconciliation.ts")
U2_CLIENT = text("worklist-v0", "hpacs-lite", "order-reconciliation.js")
CLIENT = text("worklist-v0", "hpacs-lite", "study-identity.js")
MAIN = text("worklist-v0", "hpacs-lite", "main.html")
WORKFLOW = text(".github", "workflows", "validate.yml")
LIVE = text("tests", "invariants_live.py")
SEED = text("api", "src", "seed.ts")

RELATIONS = {"match", "mismatch", "not_comparable"}
FIELDS = ["accession", "patientId", "patientName", "birth", "sex"]
PATIENT_FIELDS = ["patientId", "patientName", "birth", "sex"]
# Contract section 4.2: no U5 label, title or guidance may carry these. The one exception is the reviewed Same Value
# title, which says in so many words that it is NOT a patient confirmation.
FORBIDDEN = ["Reset", "판독 취소", "Addendum", "추가 판독", "재작성", "다른 환자입니다", "같은 환자", "동일 환자",
             "확인됨", "confirmed", "완료", "Unmatched"]
NEGATION = "같은 환자임을 확인한 것은 아닙니다."


def between(source, start, end):
    head = source.index(start)
    return source[head:source.index(end, head + len(start))]


def sha(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def js_function(source, name):
    """The DOM harness scanner (tests/worklist_arrivals_dom_test.py); a quote in a comment breaks it there too."""
    start = source.index("function " + name + "(")
    brace = source.index("{", start)
    depth, quote, escaped = 0, None, False
    for index in range(brace, len(source)):
        char = source[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in "'\"`":
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise ValueError(name)


def forbidden_hits(value):
    value = value.replace(NEGATION, "")
    return [word for word in FORBIDDEN if word in value]


# ── 1. Vector file well-formedness (never a model of the rule) ─────────────────────────────────────────────────

class VectorFile(unittest.TestCase):
    def test_relation_vectors_are_closed_unique_and_cover_each_field_three_ways(self):
        self.assertEqual(VECTORS["source"], "engineering_only")
        self.assertEqual(sorted(VECTORS["fields"]), sorted(FIELDS))
        self.assertEqual({(v["order"], v["tag"]) for v in VECTORS["fields"].values()},
                         {("accession", "00080050"), ("patientId", "00100020"), ("name", "00100010"),
                          ("birth", "00100030"), ("sex", "00100040")})
        ids = [case["id"] for case in VECTORS["relations"]]
        self.assertEqual(len(ids), len(set(ids)))
        seen = {field: set() for field in FIELDS}
        for case in VECTORS["relations"]:
            with self.subTest(case["id"]):
                self.assertLessEqual(set(case), {"id", "field", "order", "dicom", "dicomElement", "expect", "why"})
                self.assertIn(case["field"], FIELDS)
                self.assertIn(case["expect"], RELATIONS)
                self.assertTrue(case["order"] is None or isinstance(case["order"], str))
                self.assertTrue(case["dicom"] is None or isinstance(case["dicom"], str))
                if "dicomElement" in case:
                    self.assertIsNone(case["dicom"])
                    self.assertIsInstance(case["dicomElement"].get("Value"), list)
                self.assertTrue(case["why"].strip())
                seen[case["field"]].add(case["expect"])
        for field in FIELDS:
            self.assertEqual(seen[field], RELATIONS, field)

    def test_every_reviewed_example_is_present(self):
        ids = {case["id"] for case in VECTORS["relations"]}
        self.assertEqual(set(VECTORS["required"]) - ids, set())
        by = {case["id"]: case for case in VECTORS["relations"]}
        # Contract 3.2 rows, by their values (so a renamed id cannot drop one).
        rows = {(c["field"], c["order"], c["dicom"], c["expect"]) for c in VECTORS["relations"]}
        for row in (("accession", None, "CS250925101010", "not_comparable"), ("accession", "A-100", " A-100 ", "match"),
                    ("accession", "a-100", "A-100", "mismatch"), ("accession", "A-100", None, "not_comparable"),
                    ("patientId", "00123", "123", "mismatch"), ("patientId", "P-1001", "p-1001", "mismatch"),
                    ("patientId", "P-1001", "P-1001 ", "match"), ("patientName", "KIM CHULSOO", "KIM^CHULSOO", "match"),
                    ("patientName", "KIM CHULSOO", "Kim^Chulsoo^^^", "match"),
                    ("patientName", "KIM CHULSOO", "KIM^CHUL SOO", "mismatch"),
                    ("birth", "1962-03-04", "19620304", "match"), ("birth", "1962-03-04", "19620403", "mismatch"),
                    ("birth", "1962-03-04", "1962", "not_comparable"), ("birth", "1962-02-30", "19620302", "not_comparable"),
                    ("birth", "1962.03.04", "19620304", "not_comparable"), ("birth", "", "19800101", "not_comparable"),
                    ("sex", "m ", "M", "match"), ("sex", "F", "M", "mismatch"), ("sex", "F", "O", "not_comparable")):
            self.assertIn(row, rows, row)
        # N-2: the component-boundary equality is written down as accepted, not left implicit.
        self.assertEqual((by["pn-component-boundary"]["order"], by["pn-component-boundary"]["dicom"],
                          by["pn-component-boundary"]["expect"]), ("KIM CHUL^SOO", "KIM^CHUL SOO", "match"))

    def test_the_unicode_and_calendar_vectors_really_exercise_what_they_name(self):
        """Source adequacy of the file, not the rule: each named hazard is present in the data."""
        by = {case["id"]: case for case in VECTORS["relations"]}
        nfd = by["pn-nfd-nfc"]
        self.assertNotEqual(nfd["order"], nfd["dicom"])
        self.assertNotEqual(unicodedata.normalize("NFC", nfd["order"]), nfd["order"])
        self.assertEqual(unicodedata.normalize("NFC", nfd["order"]), nfd["dicom"])
        self.assertEqual(unicodedata.normalize("NFC", by["pn-no-transliteration"]["order"]), nfd["dicom"])
        fold = by["pn-ascii-fold-only"]
        self.assertEqual(fold["order"].upper(), fold["dicom"])            # full Unicode upper would call it equal
        self.assertNotEqual(fold["order"], fold["dicom"])
        ideographic = by["pn-ideographic-only"]["dicomElement"]["Value"][0]
        self.assertEqual(set(ideographic), {"Ideographic"})                # no Alphabetic group at all
        # N-3: the invalid dates are real calendar holes, and the valid leap days are real.
        for case_id, valid in (("birth-not-a-date", False), ("birth-leap-1900", False), ("birth-april-31", False),
                               ("birth-month-13", False), ("birth-leap-2000", True), ("birth-leap-2024", True)):
            year, month, day = (int(part) for part in by[case_id]["order"].split("-"))
            leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
            days = [31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
            self.assertEqual(valid, 1 <= month <= 12 and 1 <= day <= days[month - 1], case_id)

    def test_summary_rows_are_internally_consistent(self):
        ids = [case["id"] for case in VECTORS["summary"]]
        self.assertEqual(len(ids), len(set(ids)))
        for case in VECTORS["summary"]:
            with self.subTest(case["id"]):
                self.assertEqual(sorted(case["identity"]), sorted(FIELDS))
                self.assertLessEqual(set(case["identity"].values()), RELATIONS)
                patient = any(case["identity"][field] == "mismatch" for field in PATIENT_FIELDS)
                accession = case["identity"]["accession"] == "mismatch"
                self.assertEqual((case["patientMismatch"], case["accessionMismatch"]), (patient, accession))
                self.assertEqual(case["text"], "DICOM Identity" + (" · Patient Mismatch" if patient else "")
                                 + (" · Accession Mismatch" if accession else ""))
        self.assertTrue({(c["patientMismatch"], c["accessionMismatch"]) for c in VECTORS["summary"]}
                        >= {(False, False), (True, False), (False, True), (True, True)})

    def test_overlay_vectors_name_the_reviewed_shape(self):
        ids = [case["id"] for case in VECTORS["overlay"]]
        self.assertEqual(len(ids), len(set(ids)))
        by = {case["id"]: case for case in VECTORS["overlay"]}
        self.assertTrue(by["null-clears"]["expect"] and by["null-clears"]["value"] is None)
        self.assertEqual(by["probe-row-state"]["value"],
                         {"matched": "<img data-u5-probe>", "rs": "A", "uid": "1.2.3", "sourcePatientKey": "x"})
        self.assertFalse(by["probe-row-state"]["expect"])
        self.assertTrue(math.isinf(by["age-infinite"]["value"]["age"]) and not by["age-infinite"]["expect"])
        self.assertEqual(list(by["proto-key"]["value"]), ["__proto__"])
        self.assertTrue(all(isinstance(case["expect"], bool) for case in VECTORS["overlay"]))


# ── 2. Server source pins ─────────────────────────────────────────────────────────────────────────────────────

BASE_SHA256 = {
    # Unchanged at b6a317c (S4-U5 base): route table, the U2 rule/client and the untouched neighbour methods.
    "controller": "8a862bd2db7bee98406f89d89289e04d4665213c91830fa416cf968bd5b0db23",
    "u2_rule": "45a916d3d2cfa37b3e4d9dc04d5e7f2ee9dc6a86451249ed799aab40bc300dbd",
    "u2_client": "47abd1d5a00a69d37a8c7977e5f31c9d3a9ce16ca04a43d5fd8830a4369963d3",
    "unmatch": "d38480a356f864fb8084bedfe0f632a4d2541047ccff26cdd5dd57f6a7ed92cb",
    "removeState": "a5c691d2367cd86ed3d9a607075b028e80753145cf2483618fd392b949cb5e04",
    "bootstrap": "2c8ae6afa501225b6b9c808f75065daafc5afd5e93013e43909b5bf4f200fbd9",
    "toClient": "7a10e0e6f6cc5e487140f4b55d3a55b4b01214236b886819b2cf7e7ead7682a3",
}
# StudyState/Order/report write call sites in pacs.service.ts at b6a317c. U5 adds reads only.
BASE_WRITES = {"studyState.update(": 8, "studyState.updateMany(": 1, "studyState.create(": 3, "studyState.delete(": 1,
               "order.update(": 2, "order.updateMany(": 2, "order.createMany(": 1}


class RulePins(unittest.TestCase):
    def test_the_rule_module_is_pure_and_reads_only_what_it_is_given(self):
        self.assertIn("import { accessionRelation, ORDER_RECONCILIATION_SOURCE } from './order-reconciliation';", RULE)
        self.assertEqual(re.findall(r"^import .*$", RULE, re.M),
                         ["import { accessionRelation, ORDER_RECONCILIATION_SOURCE } from './order-reconciliation';",
                          "import type { AccessionRelation } from './order-reconciliation';"])
        code = "\n".join(line for line in RULE.splitlines() if not line.strip().startswith(("*", "//", "/*")))
        for banned in (".ov", ".orig", "parse(", "prisma", "this.", "process.env", "fetch(", "require(", "report",
                       "Date(", "Date.parse", "toLowerCase", "localeCompare", "toLocaleUpperCase"):
            self.assertNotIn(banned, code, banned)
        select = between(RULE, "export const ORDER_IDENTITY_SELECT = {", "} as const;")
        self.assertEqual(sorted(re.findall(r"(\w+): true", select)),
                         sorted(["oid", "institutionId", "studyUid", "matched", "accession", "patientId", "name", "birth", "sex"]))

    def test_the_pair_guard_and_the_closed_answer(self):
        rule = between(RULE, "export function orderIdentity(", "\n}\n")
        for needle in ("if (!study || study.institutionId !== me || study.matched !== 'M' || !study.orderOid) return null;",
                       "if (!order || order.oid !== study.orderOid || order.institutionId !== me || order.matched !== 'M'",
                       "|| order.studyUid !== study.uid) return null;",
                       "accession: accessionRelation(order.accession, tag('00080050')),",
                       "patientId: accessionRelation(order.patientId, tag('00100020')),",
                       "patientName: relate(nameKey(order.name), nameKey(tag('00100010'))),",
                       "birth: relate(birthKey(order.birth), birthKey(tag('00100030'))),",
                       "sex: relate(sexKey(order.sex), sexKey(tag('00100040'))),"):
            self.assertEqual(1, rule.count(needle), needle)
        answer = between(rule, "return {", "};")
        self.assertEqual(re.findall(r"^\s*(\w+):", answer, re.M),
                         ["source", "oid", "accession", "patientId", "patientName", "birth", "sex"])
        # The relation never carries an Order or DICOM value: every key but oid is a relation of two keys.
        self.assertNotIn("order.name,", answer)
        self.assertNotIn("tag('00100010'),", answer.replace("nameKey(tag('00100010'))", ""))

    def test_the_normalizations_are_the_reviewed_ones(self):
        self.assertIn("return text(value).normalize('NFC').replace(/\\^/g, ' ').replace(/\\s+/g, ' ').trim()\n"
                      "    .replace(/[a-z]+/g, part => part.toUpperCase());", RULE)
        birth = between(RULE, "export function birthKey(", "\n}\n")
        self.assertIn("/^(\\d{4})(\\d{2})(\\d{2})$/.exec(raw) ?? /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(raw)", birth)
        self.assertIn("const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);", birth)
        self.assertIn("const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];", RULE)
        self.assertIn("return key === 'M' || key === 'F' ? key : '';", RULE)

    def test_the_overlay_shape_is_the_reviewed_allowlist(self):
        self.assertIn("export const OVERLAY_KEYS = ['id', 'name', 'sex', 'birth', 'age', 'desc', 'ward', 'date', 'acc', 'modality'] as const;", RULE)
        shape = between(RULE, "export function overlayShape(", "\n}\n")
        for needle in ("if (value === null) return true;",
                       "Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)",
                       "(typeof item === 'string' || (key === 'age' && typeof item === 'number' && Number.isFinite(item)))"):
            self.assertIn(needle, shape)
        self.assertEqual(MAIN.count('const OVERLAY_KEYS = ["id", "name", "sex", "birth", "age", "desc", "ward", "date", "acc", "modality"];'), 1)


class ServicePins(unittest.TestCase):
    def test_one_tenant_pinned_identity_read_before_the_access_recheck(self):
        listing = between(SERVICE, "  async listStudies(c: Caller, query?: any) {", "  private notObserved(")
        self.assertIn("import { ORDER_IDENTITY_SELECT, orderIdentity, overlayShape, OVERLAY_RULE_TEXT } from './study-identity';", SERVICE)
        self.assertEqual(SERVICE.count("ORDER_IDENTITY_SELECT"), 2)                  # import + the one read
        read = listing.index("const identityOrders = linked.length ? await this.prisma.order.findMany({\n"
                             "      where: { oid: { in: linked }, institutionId: me }, select: ORDER_IDENTITY_SELECT }) : [];")
        collect = listing.index(".filter(s => s?.institutionId === me && s.matched === 'M' && s.orderOid).map(s => s.orderOid))];")
        self.assertIn("const linked = [...new Set(pageUids.map(uid => byUid.get(uid))", listing)
        details = listing.index("for (const state of details) byUid.set(state.uid, state);")
        loop = listing.index("for (const st of sourceRows) {")
        current = listing.index("const current = await this.prisma.studyState.findMany({ where: { uid: { in: pageUids } },")
        unchanged = listing.index("await this.studyAccess.unchanged(c,access);")
        self.assertTrue(details < collect < read < loop < current < unchanged)
        self.assertEqual(listing.count("this.prisma.order.findMany("), 1)
        # Own rows only; the relation is judged on the same `st` the row's acc/id/name/birth/sex come from.
        self.assertIn("orderIdentity: s.institutionId === me\n"
                      "          ? orderIdentity(me, s, identityByOid.get(s.orderOid), key => OrthancService.tag(st, key)) : null,", listing)
        self.assertEqual(listing.count("identityByOid"), 2)
        self.assertEqual(listing.count("identityOrders"), 2)
        added = listing[listing.index("// S4-U5: the orders this page"):listing.index("const sourceRows =")]
        for banned in (".ov", ".orig", "parse(", "report", "Draft", "update", "create", "delete"):
            self.assertNotIn(banned, added)
        # The return statement and the U2 order stay exactly as they were.
        self.assertIn("return { studies: out, serverTime: new Date().toISOString(), observedAt,\n"
                      "      ...(notObserved === undefined ? {} : { notObserved }),\n"
                      "      ...(orderReconciliation === undefined ? {} : { orderReconciliation }), ...(page ? { pagination: window.pagination } : {}) };",
                      listing)

    def test_no_order_value_leaves_and_no_new_route_or_bootstrap_change(self):
        self.assertEqual(sha(CONTROLLER), BASE_SHA256["controller"])
        self.assertEqual(sha(between(SERVICE, "  async bootstrap(c: Caller, query?: any) {", "\n  }\n")), BASE_SHA256["bootstrap"])
        self.assertEqual(sha(between(SERVICE, "function toClient(", "\n}\n")), BASE_SHA256["toClient"])
        self.assertNotIn("orderIdentity", between(SERVICE, "  async bootstrap(c: Caller, query?: any) {", "\n  }\n"))
        self.assertEqual(sha(U2_RULE), BASE_SHA256["u2_rule"])
        self.assertEqual(sha(U2_CLIENT), BASE_SHA256["u2_client"])
        # The U2 pin on accession-bearing code lines keeps holding: the select lives in the rule module (N-9).
        code = [line.strip() for line in SERVICE.splitlines()
                if "accession" in line and not line.strip().startswith(("*", "//", "/*"))]
        self.assertEqual(len(code), 2)
        self.assertNotIn("accession", SEED)

    def test_write_sites_and_neighbour_methods_are_unchanged(self):
        for token, count in BASE_WRITES.items():
            self.assertEqual(SERVICE.count(token), count, token)
        self.assertEqual(sha(between(SERVICE, "  async unmatch(uid: string, c: Caller) {", "\n  }\n")), BASE_SHA256["unmatch"])
        self.assertEqual(sha(between(SERVICE, "  async removeState(uid: string, c: Caller) {", "\n  }\n")), BASE_SHA256["removeState"])

    def test_m1_overlay_shape_is_last_in_patch_after_every_existing_refusal(self):
        patch = between(SERVICE, "  async patchState(uid: string, body: any, c: Caller) {", "\n  }\n")
        order = [patch.index(needle) for needle in (
            "const owned = REPORT_OWNED_FIELDS.filter(k => body[k] !== undefined);",
            "if (TECHNICIAN_FIELDS.some(k => body[k] !== undefined)) need(c.roles, 'technician', '검사 정보 변경');",
            "const prev = await this.gate(uid,c,tx);",
            "throw new ForbiddenException('원격판독으로 받은 검사의 촬영·환자 정보는 보유 기관만 바꿀 수 있습니다');",
            "`예비 판독(RS: P) 중입니다. ${prev?.preReviewer ?? '지정된 판독의'}만 다룰 수 있습니다.`);",
            "if (body.ov !== undefined) data.ov = dump(body.ov);",
            "if (!Object.keys(data).length) throw new BadRequestException('바꿀 필드가 없습니다');",
            "if (body.ov !== undefined) {\n      const rs = prev?.rs ?? 'W';",
            "throw new BadRequestException(`판독 전(RS: W)인 검사만 환자·검사 정보를 수정할 수 있습니다 (현재 RS: ${rs})`);",
            "if (!overlayShape(body.ov))\n        throw new BadRequestException(`환자·검사 정보(ov) 형식이 잘못되었습니다 — ${OVERLAY_RULE_TEXT}`);\n    }",
            "const saved = await tx.studyState.update({ where: { uid }, data });")]
        self.assertEqual(order, sorted(order))
        self.assertEqual(patch.count("overlayShape("), 1)

    def test_n1_claimed_original_shape_is_after_every_existing_match_check(self):
        match = between(SERVICE, "  async match(uid: string, oid: string, patient: any, c: Caller) {", "\n  }\n")
        order = [match.index(needle) for needle in (
            "need(c.roles, 'technician', '오더 매칭');",
            "if (order.institutionId !== me) throw new BadRequestException('오더를 찾을 수 없습니다');",
            "const prev = await this.gate(uid, c);",
            "throw new ForbiddenException('원격판독으로 받은 검사는 매칭할 수 없습니다 (보유 기관의 일입니다)');",
            "throw new BadRequestException(`판독 전(RS: W)인 검사만 매칭할 수 있습니다 (현재 RS: ${prev.rs})`);",
            "if (!overlayShape(patient?.orig ?? null))\n      throw new BadRequestException(`원래 정보(orig) 형식이 잘못되었습니다 — ${OVERLAY_RULE_TEXT}`);",
            "const orig = parse(prev?.orig) ?? patient?.orig ?? null;",
            "state = await this.prisma.$transaction(async tx => {")]
        self.assertEqual(order, sorted(order))
        # Mismatch or identity never refuses: nothing from study-identity but the shape check is used here.
        for banned in ("orderIdentity", "nameKey", "birthKey", "sexKey"):
            self.assertNotIn(banned, match)
        self.assertIn("export const OVERLAY_RULE_TEXT = `허용 키 ${OVERLAY_KEYS.join(', ')} · 값은 문자열(age는 유한한 숫자도 가능)`;", RULE)

    def test_nb1_match_age_is_coerced_by_the_overlay_rule_without_a_new_refusal(self):
        """T-NB1-1: pins the text only; the stored value per input is T-NB1-2 on the hosted stack."""
        match = between(SERVICE, "  async match(uid: string, oid: string, patient: any, c: Caller) {", "\n  }\n")
        line = "      age: overlayShape({ age: patient?.age }) ? patient.age : '', desc: order.descr, ward: order.ward,\n"
        self.assertEqual(match.count(line), 1)
        self.assertNotIn("patient?.age ?? ''", SERVICE)
        self.assertEqual(match.count("overlayShape("), 2)       # the N-1 orig refusal + this coercion, nothing new
        refusal = match.index("if (!overlayShape(patient?.orig ?? null))\n      throw new BadRequestException(`원래 정보(orig) 형식이 잘못되었습니다 — ${OVERLAY_RULE_TEXT}`);")
        self.assertTrue(refusal < match.index(line) < match.index("state = await this.prisma.$transaction(async tx => {"))


# ── 3. Client source pins ─────────────────────────────────────────────────────────────────────────────────────

class ClientPins(unittest.TestCase):
    def test_the_module_reads_only_the_answer_and_the_response_row(self):
        code = "\n".join(line for line in CLIENT.splitlines() if not line.strip().startswith(("*", "//", "/*")))
        for banned in ("localStorage", "sessionStorage", "SEED_ORDERS", "kin-orders", "fetch(", "XMLHttpRequest",
                       "document.", "innerHTML", ".ov", ".orig", "window."):
            self.assertNotIn(banned, code, banned)
        self.assertIsNone(re.search(r"\borders\b", code))
        self.assertIn("const SOURCE='engineering_only',MARKER='Engineering Only',OBSERVATION_UNAVAILABLE='관측 불가';", CLIENT)
        self.assertIn("const IDENTITY_KEYS=['accession','birth','oid','patientId','patientName','sex','source'];", CLIENT)
        self.assertIn("rows.set(row.uid,{tags:{uid:row.uid,acc:textOf(row.acc),id:textOf(row.id),name:textOf(row.name),", CLIENT)
        view = js_function(CLIENT, "view")
        self.assertIn("else if(matched==='U')key='no_linked_order';", view)
        self.assertIn("else if(matched==='M'&&row.order.state==='identity'&&row.order.identity.oid===own.oid)key='linked';", view)
        self.assertIn("else key='unknown';", view)

    def test_m3_the_pn_row_names_its_group(self):
        self.assertIn("label:'Patient Name · Alphabetic',field:'patientName',absent:'Alphabetic Absent',", CLIENT)
        self.assertIn("const NAME_SCOPE='Patient Name은 Alphabetic 그룹만 읽고 표시하고 비교합니다. Ideographic·Phonetic 표기는 표시하지도 비교하지도 않습니다.';", CLIENT)
        self.assertIn("title=RELATION_TITLE[identity[tag.field]]+(tag.key==='name'?' '+NAME_SCOPE:'');", CLIENT)
        self.assertEqual(CLIENT.count("absent:'Absent'"), 6)

    def test_labels_titles_and_guidance_carry_no_forbidden_word(self):
        literals = re.findall(r"'((?:[^'\\\n]|\\.)*)'", CLIENT)
        self.assertTrue(any("Same Value" in item for item in literals))
        for item in literals:
            self.assertEqual(forbidden_hits(item), [], item)
        self.assertEqual(CLIENT.count(NEGATION), 1)
        panel = between(MAIN, '<details id="study-identity"', "</details>")
        note = between(MAIN, '<div class="note">※ 판독 전(RS: W)인 검사만 수정 가능.', "</div>")
        for item in (panel, note):
            self.assertEqual(forbidden_hits(item), [], item)
        # The seeded mutation of the review (M14/M15) must be caught by this very check.
        self.assertEqual(forbidden_hits("판독 취소(Reset) 후 다시 매칭하세요"), ["Reset", "판독 취소"])
        self.assertEqual(forbidden_hits("다른 환자입니다"), ["다른 환자입니다"])

    def test_main_wires_the_panel_through_the_observation_only(self):
        self.assertIn('  <script src="order-reconciliation.js"></script>\n  <script src="study-identity.js"></script>\n', MAIN)
        self.assertIn("    let studyIdentityModel = window.KinStudyIdentity?.start?.() ?? null;", MAIN)
        self.assertEqual(MAIN.count("studyIdentityModel = "), 3)   # declaration + apply + correction
        apply = js_function(MAIN, "applyObservation")
        self.assertLess(apply.index("applyStudyIdentity(next.ok ? result : null);"), apply.index("renderObservation();"))
        failure = js_function(MAIN, "markObservationUnavailable")
        self.assertLess(failure.index("applyStudyIdentity(null);"), failure.index("renderObservation();"))
        self.assertEqual(MAIN.count("applyStudyIdentity("), 3)
        self.assertIn('</table>` : "No clinical information provided.";\n      renderStudyIdentity();\n      renderObservation();\n    }\n', MAIN)
        # render() redraws the panel last: the poll merges row state after it reports the observation.
        self.assertIn("      renderChips();\n      // S4-U5: the poll merges row state after it reports the observation, so the identity panel is redrawn here\n"
                      "      // too; its stale rule reads that merged state (a correction answer or a newer poll), never an older one.\n"
                      "      renderStudyIdentity();\n    }\n", MAIN)
        self.assertEqual(MAIN.count("renderStudyIdentity();"), 4)   # applyStudyIdentity, renderClinical, render, correction
        render = js_function(MAIN, "renderStudyIdentity")
        for banned in ("innerHTML", "api(", "fetch(", "toast(", "localStorage", "sessionStorage", "saveApp(", "SEED_ORDERS"):
            self.assertNotIn(banned, render)
        self.assertIn("KinStudyIdentity.view(studyIdentityModel, s.uid, appState[s.uid] ?? {})", render)
        self.assertIn("if (!box || !studyIdentityModel) return;", render)
        self.assertIn("value.textContent = `${row.tag} ${row.label}: ${row.value}`;", render)
        panel = between(MAIN, '<div id="study-receipt"', "</section>")
        self.assertRegex(panel, r'<details id="study-identity" [^>]*hidden>')
        for child in ("study-identity-summary", "study-identity-order", "study-identity-tags", "study-identity-guidance"):
            self.assertIn('id="%s"' % child, panel)
        self.assertNotIn("<button", between(MAIN, '<details id="study-identity"', "</details>"))

    def test_m1_client_containment_overlay_allowlist_and_escaped_cells(self):
        state = js_function(MAIN, "applyState")
        self.assertNotIn("Object.assign(s, a.ov)", state)
        self.assertIn("for (const key of OVERLAY_KEYS) if (overlayValue(key, a.ov?.[key])) s[key] = a.ov[key];", state)
        self.assertTrue(state.rstrip().endswith("s[key] = a.ov[key];\n      return s;\n    }"))
        self.assertIn('    const overlayValue = (key, value) => typeof value === "string" || (key === "age" && Number.isFinite(value));', MAIN)
        self.assertIn('      ts: s => `<span class="ts ts-${esc(s.ts)}">${esc(s.ts)}</span>`,', MAIN)
        self.assertIn('      matched: s => `<span class="mt ${esc(s.matched)}">${esc(s.matched)}</span>`,', MAIN)
        cells = between(MAIN, "    const CELL = {", "\n    };")
        self.assertIsNone(re.search(r"\$\{s\.(ts|matched)\}", cells))

    def test_modify_waits_for_the_answer_and_repaints_from_the_server(self):
        save = js_function(MAIN, "saveModify")
        server = save[save.index("if (serverMode || offline) {"):save.index("} else {")]
        wait = server.index("ok = await saveApp(uid, { ov }) === true;")
        for later in ("if (!ok) {", "applyState(row);", "noteIdentityCorrection(uid, true);"):
            self.assertLess(wait, server.index(later), later)
        for early in ("Object.assign(s", "a.ov =", "a.orig", "toast(", "render("):
            self.assertNotIn(early, server[:wait], early)
        self.assertLess(save.index("} else {"), save.index('toast("검사 정보를 수정했습니다");'))
        self.assertIn('if (serverMode) { commitEpoch++; listLoadSequence++; load(); }', save)
        self.assertEqual(MAIN.count('$("#m-save").addEventListener("click", saveModify);'), 1)
        self.assertEqual(MAIN.count('$("#m-save")'), 1)
        app = js_function(MAIN, "saveApp")
        self.assertIn("return api(\"PATCH\", `/studies/${encodeURIComponent(uid)}`, body)\n"
                      "        .then(st => { appState[uid] = mergePolledState(uid, st); syncStudy(uid); render(); })\n"
                      "        .then(() => true)", app)
        self.assertIn("render(); refreshRight();\n          return false;", app)
        self.assertNotIn("localStorage에만", MAIN)
        self.assertIn("수정 내용은 화면 표시용 덮어쓰기로 서버에 저장되며 Orthanc 원본 DICOM과 오더 비교 결과는 바뀌지 않습니다.", MAIN)

    def test_match_and_unmatch_invalidate_lists_and_unmatch_repaints_from_qido(self):
        match = js_function(MAIN, "doMatch")
        unmatch = js_function(MAIN, "doUnmatch")
        for body in (match, unmatch):
            server = body[body.index("if (serverMode) {"):body.index("} else {")]
            self.assertLess(server.index("} catch (e) {"), server.index("commitEpoch++; listLoadSequence++;"))
            self.assertIn("noteIdentityCorrection(s.uid, true); load(); refreshOrders();", server)
            self.assertIn("noteIdentityCorrection(s.uid, false);", server)
        # M-4.6: the two projection literals stay verbatim.
        self.assertIn("appState[s.uid] = { ...a, ...st };", match)
        self.assertIn("appState[s.uid] = { ...a, ...st, ov: undefined };", unmatch)
        self.assertNotIn("st.orig", unmatch)
        self.assertIn("KinStudyIdentity.tags(studyIdentityModel, s.uid)", unmatch)
        self.assertIn("age: ageOf(fmtD(read.birth), s.date), desc: read.desc });", unmatch)
        self.assertIn('alert("매칭 실패: " + e.message);', match)
        self.assertIn('alert("매칭 해제 실패: " + e.message);', unmatch)
        self.assertIn("patient: { age: ov.age, orig: claimed } });", match)
        self.assertIn("for (const key of OVERLAY_KEYS) if (overlayValue(key, orig?.[key])) claimed[key] = orig[key];", match)

    def test_order_list_refresh_is_server_only_guarded_and_latest_wins(self):
        refresh = js_function(MAIN, "refreshOrders")
        self.assertTrue(refresh.startswith("function refreshOrders() {\n      if (!serverMode) { renderOrders(); return; }"))
        for needle in ("const token = ++orderRefreshSequence;", 'answer = await api("GET", "/bootstrap?states=omit");',
                       "if (token !== orderRefreshSequence || !serverMode) return;",
                       "answer.me?.institution !== myInstitution", "orders = answer.orders;",
                       "if (!orders.some(o => o.oid === selectedOid)) selectedOid = null;"):
            self.assertEqual(1, refresh.count(needle), needle)
        for banned in ("SEED_ORDERS", "localStorage", "saveOrders", "markObservationUnavailable", "kin-orders"):
            self.assertNotIn(banned, refresh)
        self.assertEqual(MAIN.count('$("#o-refresh").addEventListener("click", refreshOrders);'), 1)
        self.assertEqual(MAIN.count('$("#o-refresh")'), 1)

    def test_m4_pinned_tokens_do_not_move(self):
        # gatewayReceipt 5 -> 6 at S4-F01V: the Not Observed item reads its own receipt (gateway_retry_source_test.py).
        for token, count in (("gatewayReceipt", 6), ("SEED_ORDERS", 2), ("applyObservation(", 3),
                             ("markObservationUnavailable(", 4), ("applyOrderReconciliation(", 3),
                             ("renderOrderReconciliation(", 2), ("orderReconciliationModel =", 2), ('id="b-print"', 1),
                             ("mergePolledState(", 7)):
            self.assertEqual(MAIN.count(token), count, token)


# ── 4. Live method and hosted wiring ──────────────────────────────────────────────────────────────────────────

class LiveAndWorkflowPins(unittest.TestCase):
    def test_the_one_live_method_holds_the_required_cells(self):
        name = "    def test_s4u5_order_identity_qido_only_w_gates_and_report_preservation(self) -> None:"
        self.assertEqual(LIVE.count(name), 1)
        method = between(LIVE, name, "    def test_zzz_known_failure_concurrent_commit_must_not_return_500")
        for needle in ("SYNTHETIC-S4U5-", "to_jsonb(t)=", "\"orderIdentity\"", "\"not_comparable\"",
                       "{\"ov\": PROBE}", "환자·검사 정보(ov) 형식이 잘못되었습니다", "원래 정보(orig) 형식이 잘못되었습니다",
                       "예비 판독(RS: P) 중입니다. ", "판독 전(RS: W)인 검사만 환자·검사 정보를 수정할 수 있습니다 (현재 RS: ",
                       "판독 전(RS: W)인 검사만 매칭할 수 있습니다 (현재 RS: ", "판독 전(RS: W)인 검사만 매칭을 풀 수 있습니다 (현재 RS: ",
                       "md5(", '\\"ReportDraft\\"', '\\"ReportVersion\\"', '\\"Report\\"', "FORGED-ORIG", "states=omit",
                       "self.preliminary(p, author=\"doctor\", reviewer=\"jmryu\")", "self.assert_snapshot_unchanged("):
            self.assertIn(needle, method, needle)
        self.assertIn("('tests/invariants_live.py', 83)", text("tests", "execution_selection_test.py"))
        self.assertIn('("invariants_live.py", None, "candidate-invariants", 83),', text("tests", "candidate_ci.py"))

    def test_hosted_steps_run_the_real_code_with_source_hashes(self):
        for needle in (
            "--run-dir tmp/workspace-ui-ci/study-identity-source",
            "-- python3 -B tests/study_identity_source_test.py",
            "--run-dir tmp/workspace-ui-ci/study-identity-dom",
            "-B tests/study_identity_dom_test.py",
            "--run-dir tmp/runtime-ci/study-identity-client",
            "node --test tests/study_identity_test.cjs",
            "--run-dir tmp/runtime-ci/study-identity-server",
            "--entrypoint node kin-api:ci --test /tests/study_identity_server_test.cjs",
            "tmp/runtime-ci/study-identity-client/",
            "tmp/runtime-ci/study-identity-server/",
        ):
            self.assertEqual(1, WORKFLOW.count(needle), needle)
        server = next(line for line in WORKFLOW.splitlines() if "tmp/runtime-ci/study-identity-server --cwd" in line)
        for source in ("api/src/study-identity.ts", "api/src/pacs.service.ts", "api/src/orthanc.service.ts",
                       "tests/study_identity_vectors.json", "tests/study_identity_server_test.cjs"):
            self.assertIn("--file " + source, server)
        dom = next(line for line in WORKFLOW.splitlines() if "tmp/workspace-ui-ci/study-identity-dom --cwd" in line)
        for source in ("worklist-v0/hpacs-lite/main.html", "worklist-v0/hpacs-lite/study-identity.js",
                       "tests/worklist_arrivals_dom_test.py", "tests/study_identity_dom_test.py"):
            self.assertIn("--file " + source, dom)
        # Existing jobs only (no new job, profile or image): the runtime job builds kin-api:ci before the server step.
        self.assertLess(WORKFLOW.index("-t kin-api:ci api"), WORKFLOW.index("/tests/study_identity_server_test.cjs"))
        self.assertLess(WORKFLOW.index("\n  measurements:\n"), WORKFLOW.index("tests/study_identity_dom_test.py"))
        self.assertLess(WORKFLOW.index("tests/study_identity_dom_test.py"), WORKFLOW.index("\n  volume-rendering:\n"))


class Encoding(unittest.TestCase):
    CHANGED = ["api/src/study-identity.ts", "api/src/pacs.service.ts", "worklist-v0/hpacs-lite/study-identity.js",
               "worklist-v0/hpacs-lite/main.html", "tests/study_identity_vectors.json", "tests/study_identity_source_test.py",
               "tests/study_identity_test.cjs", "tests/study_identity_server_test.cjs", "tests/study_identity_dom_test.py",
               "tests/worklist_arrivals_dom_test.py", "tests/study_observation_test.py", "tests/order_reconciliation_source_test.py",
               "tests/invariants_live.py", "tests/execution_selection_test.py", "tests/candidate_ci.py",
               "tests/candidate_ci_test.py", ".github/workflows/validate.yml", "tests/README.md"]

    def test_changed_files_are_strict_utf8_without_bom_or_bare_cr(self):
        for path in self.CHANGED:
            with self.subTest(path):
                data = (ROOT / path).read_bytes()
                self.assertFalse(data.startswith(b"\xef\xbb\xbf"))
                self.assertNotIn("\r", data.decode("utf-8").replace("\r\n", "\n"))
        self.assertEqual([b for b in (ROOT / "tests" / "study_identity_vectors.json").read_bytes() if b > 127], [],
                         "the vector file spells non-ASCII as \\u escapes so no editor can renormalize the NFD case")


if __name__ == "__main__":
    unittest.main(verbosity=2)
