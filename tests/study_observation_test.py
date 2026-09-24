# coding: utf-8
"""S4-U1b receipt display: axis A assignment, axis B KIN observation, axis C Gateway report.

Pure stdlib, no browser, no Node, no stack. Three kinds of evidence and nothing more:
  1. tests/study_observation_vectors.json judged by an independent Python model of the rules
     (session-local change, resets, departure, failure keeps, cold start, label table, reasons,
     IF-W09 phrases). The shipped JS is judged against the SAME file by tests/study_arrivals_test.cjs
     in the CI runtime job; a green run here is a spec check, not runtime proof of the JS or TS.
  2. Source pins that the shipped files still carry the decisions the model describes (server
     absence surface, failure paths in main.html, the page client hand-off).
  3. The first S4 touch of main.html keeps every Stage 3 anchor: the id, top-level function and
     $('#...') selector inventories of the pre-S4 blob (e15c69c) are pinned by digest, and only the
     named S4-U1b additions may appear. The mutant scripts' own --anchors-only checks are run
     beside this file by the same CI step.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import unittest
from collections import Counter
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
VECTORS = json.loads((ROOT / "tests" / "study_observation_vectors.json").read_text(encoding="utf-8"))
ARRIVALS = ROOT / "worklist-v0" / "hpacs-lite" / "study-arrivals.js"
PAGES = ROOT / "worklist-v0" / "hpacs-lite" / "study-pages.js"
MAIN = ROOT / "worklist-v0" / "hpacs-lite" / "main.html"
SERVICE = ROOT / "api" / "src" / "pacs.service.ts"
HARNESS = ROOT / "tests" / "worklist_arrivals_dom_test.py"
NATIVE = ROOT / "tests" / "e2e" / "test_study_arrivals.py"
LIVE = ROOT / "tests" / "invariants_live.py"
CJS = ROOT / "tests" / "study_arrivals_test.cjs"
CHANGED = (ARRIVALS, PAGES, MAIN, SERVICE, HARNESS, NATIVE, LIVE, CJS, Path(__file__).resolve(),
           ROOT / "tests" / "study_observation_vectors.json")

UID = re.compile(r"\d+(?:\.\d+)+", re.ASCII)
BANNED = re.compile("|".join(VECTORS["banned"]), re.IGNORECASE)
PHRASES = VECTORS["phrases"]


# ── independent model ──

def parse_time(value):
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def valid_count(value):
    return value is None or (type(value) is int and 0 <= value <= 2 ** 53 - 1)


def start():
    return {"owner": None, "observedAt": None, "available": None, "rows": {}, "notObserved": None}


def compare(previous, current):
    if previous is None or previous["count"] is None or current["count"] is None:
        return None
    if (previous["series"] is None) != (current["series"] is None):
        return None
    series = current["series"] is not None
    if current["count"] < previous["count"] or (series and current["series"] < previous["series"]):
        return "decreased"
    if current["count"] > previous["count"] or (series and current["series"] > previous["series"]):
        return "increased"
    return "no_observed_change"


def succeeded(model, owner, observed_at, studies, not_observed):
    """Returns the next model or None when the answer is not an observation."""
    if parse_time(observed_at) is None:
        return None
    values = {}
    for uid, count, series in studies:
        if not UID.fullmatch(uid) or len(uid) > 64 or uid in values or not valid_count(count) or not valid_count(series):
            return None
        values[uid] = {"count": count, "series": series}
    absent = None
    if not_observed is not None:
        absent, seen = [], set()
        for uid, origin, created in not_observed:
            if not UID.fullmatch(uid) or uid in seen or uid in values or not origin or len(origin) > 32 or parse_time(created) is None:
                return None
            seen.add(uid)
            absent.append({"uid": uid, "origin": origin, "createdAt": created})
    key = json.dumps(owner)
    continues = model["owner"] == key and (model["observedAt"] is None or parse_time(observed_at) >= parse_time(model["observedAt"]))
    prior = model["rows"] if continues else {}
    rows = {}
    for uid, value in values.items():
        previous = prior.get(uid)
        kind = compare(previous, value)
        row = {"count": value["count"], "series": value["series"], "observedAt": observed_at, "change": None,
               "valueSince": None if value["count"] is None else observed_at, "changedAt": None,
               "needsCheck": False, "decreasedAt": None}
        if kind == "no_observed_change":
            row.update(change={"kind": kind, "since": previous["valueSince"]}, valueSince=previous["valueSince"],
                       changedAt=previous["changedAt"], needsCheck=previous["needsCheck"], decreasedAt=previous["decreasedAt"])
        elif kind:
            row.update(change={"kind": kind, "since": previous["observedAt"]}, changedAt=observed_at,
                       needsCheck=kind == "decreased" or previous["needsCheck"],
                       decreasedAt=observed_at if kind == "decreased" else previous["decreasedAt"])
        rows[uid] = row
    return {"owner": key, "observedAt": observed_at, "available": True, "rows": rows, "notObserved": absent}


def failed(model):
    return {**model, "available": False}


def study(model, uid):
    row = model["rows"].get(uid)
    absent = next((item for item in model["notObserved"] or [] if item["uid"] == uid), None)
    if model["available"] is False:
        last = None
        if row:
            last = {"count": row["count"], "series": row["series"], "observedAt": row["observedAt"]}
        elif absent:
            last = {"notObserved": True, "observedAt": model["observedAt"]}
        return {"state": "observation_unavailable", "last": last, "changedAt": row["changedAt"] if row else None,
                "needsCheck": bool(row and row["needsCheck"]), "decreasedAt": row["decreasedAt"] if row else None}
    if model["available"] is not True:
        return {"state": "not_attempted"}
    if row:
        return {"state": "observed", **{k: row[k] for k in ("count", "series", "observedAt", "change", "changedAt", "needsCheck", "decreasedAt")}}
    if absent:
        return {"state": "not_observed", "observedAt": model["observedAt"], "origin": absent["origin"], "createdAt": absent["createdAt"]}
    return {"state": "outside_list"}


def summary(model):
    needs = sum(1 for row in model["rows"].values() if row["needsCheck"])
    tail = " · Needs Check %d" % needs if needs else ""
    if model["available"] is False:
        text = PHRASES["observationUnavailable"] + (" · 마지막 관측 %s 유지" % model["observedAt"] if model["observedAt"] else "") + tail
        return {"key": "observation_unavailable", "text": text, "needsCheck": needs}
    if model["available"] is not True:
        return {"key": "not_attempted", "text": "", "needsCheck": needs}
    absent = model["notObserved"]
    part = " · Not Observed Unknown" if absent is None else (" · Not Observed %d" % len(absent) if absent else "")
    return {"key": "observed", "text": "Observed " + model["observedAt"] + part + tail, "needsCheck": needs}


def held(count, at):
    return ("KIN 보유 개수 모름" if count is None else "KIN 보유 %d건" % count) + "(%s)" % at


def observation_text(b):
    state = b["state"]
    if state == "observed":
        return held(b["count"], b["observedAt"])
    if state == "not_observed":
        return "Not Observed(%s)" % b["observedAt"]
    if state == "observation_unavailable":
        last = b["last"]
        if not last:
            return PHRASES["observationUnavailable"]
        if last.get("notObserved"):
            return PHRASES["observationUnavailable"] + " · 마지막 관측(%s) Not Observed" % last["observedAt"]
        return PHRASES["observationUnavailable"] + " · 마지막 " + held(last["count"], last["observedAt"])
    return {"outside_list": "Outside Observed List", "not_attempted": ""}[state]


def change_text(b):
    if b["state"] != "observed" or not b.get("change"):
        return None
    kind, since = b["change"]["kind"], b["change"]["since"]
    return {"increased": "이 세션에서 관측한 변화: 증가(%s 이후)" % since,
            "decreased": "이 세션에서 관측한 변화: 감소(%s 이후) · Needs Check" % since,
            "no_observed_change": "이 세션에서 관측한 변화 없음(%s 이후)" % since}[kind]


def gateway(receipt, b):
    if receipt is None:
        return "No Gateway Report", []
    m, n = receipt.get("successCount"), receipt.get("localCount")
    ok_count = lambda v: type(v) is int and v >= 0
    if receipt.get("phase") not in VECTORS["phases"] or not ok_count(m) or not ok_count(n) or m > n \
            or parse_time(receipt.get("serverReceivedAt")) is None:
        return "Gateway 보고 형식을 확인할 수 없습니다", ["receipt_unreadable"]
    reasons = []
    k = b["count"] if b["state"] == "observed" else None
    if k is not None and k < m:
        reasons.append("kin_below_reported")
    if b["state"] == "not_observed" and m >= 1:
        reasons.append("not_observed_with_reported_transfer")
    if b.get("changedAt") and parse_time(receipt["serverReceivedAt"]) < parse_time(b["changedAt"]):
        reasons.append("receipt_older_than_change")
    return "Gateway 보고(%s): 병원 보유 %d건 중 %d건 전송" % (receipt["serverReceivedAt"], n, m), reasons


def labels(assignment, b, receipt):
    a = {"assigned": "Institution Assigned", "unassigned": "Institution Unmatched"}[assignment]
    g, reasons = gateway(receipt, b)
    reasons = (["decreased_in_session"] if b.get("needsCheck") else []) + reasons
    return {"assignment": a, "observation": observation_text(b), "change": change_text(b), "gateway": g, "reasons": reasons}


def run(steps):
    model = start()
    for index, step in enumerate(steps):
        if step.get("fail"):
            model = failed(model)
            continue
        o = step["ok"]
        nxt = succeeded(model, o["owner"], o["observedAt"], [tuple(r) for r in o["studies"]],
                        None if o["notObserved"] is None else [tuple(r) for r in o["notObserved"]])
        if nxt is None:
            return {"invalidAt": index, "model": model}
        model = nxt
    return {"model": model}


class Sequences(unittest.TestCase):
    def test_sequences_match_the_shared_vectors(self):
        for sequence in VECTORS["sequences"]:
            with self.subTest(sequence["id"]):
                outcome = run(sequence["steps"])
                if "invalidAt" in sequence:
                    self.assertEqual(sequence["invalidAt"], outcome.get("invalidAt"))
                    continue
                self.assertNotIn("invalidAt", outcome)
                for uid, expected in sequence["expect"].items():
                    actual = study(outcome["model"], uid)
                    for key, value in expected.items():
                        self.assertEqual(value, actual.get(key), "%s.%s" % (uid, key))
                if "model" in sequence:
                    model = outcome["model"]
                    self.assertEqual(sequence["model"]["observedAt"], model["observedAt"])
                    uids = None if model["notObserved"] is None else [r["uid"] for r in model["notObserved"]]
                    self.assertEqual(sequence["model"]["notObservedUids"], uids)
                got = summary(outcome["model"])
                for key, value in sequence["summary"].items():
                    self.assertEqual(value, got[key], key)

    def test_the_seven_accepted_vectors_are_each_named_by_a_sequence_or_case(self):
        ids = " ".join(s["id"] for s in VECTORS["sequences"]) + " " + " ".join(r["id"] for r in VECTORS["reasonCases"])
        for needle in ("leaving the list", "failure keeps", "cold failure", "not_observed", "known->unknown", "complete"):
            self.assertIn(needle, ids)


class LabelTable(unittest.TestCase):
    def test_every_combination_maps_to_the_table_and_carries_no_completion_word(self):
        rows = 0
        for assignment, a_text in VECTORS["assignmentText"].items():
            for name, b in VECTORS["observations"].items():
                for receipt_name, receipt in VECTORS["receipts"].items():
                    rows += 1
                    got = labels(assignment, b, receipt)
                    self.assertEqual(a_text, got["assignment"])
                    self.assertEqual(VECTORS["observationText"][name], got["observation"], name)
                    self.assertEqual(VECTORS["changeText"].get(name), got["change"], name)
                    self.assertEqual(VECTORS["gatewayText"][receipt_name], got["gateway"], receipt_name)
                    for text in (got["assignment"], got["observation"], got["change"] or "", got["gateway"]):
                        self.assertIsNone(BANNED.search(text), (assignment, name, receipt_name, text))
                    # axis C never changes axis B
                    self.assertEqual(got["observation"], labels("assigned", b, None)["observation"])
                    if receipt and receipt.get("phase") in VECTORS["phases"]:
                        for phase in VECTORS["phases"]:
                            self.assertEqual(got["gateway"], labels(assignment, b, {**receipt, "phase": phase})["gateway"])
        self.assertEqual(2 * 13 * 9, rows)

    def test_needs_check_reasons(self):
        for case in VECTORS["reasonCases"]:
            with self.subTest(case["id"]):
                got = labels("assigned", VECTORS["observations"][case["observation"]], VECTORS["receipts"][case["receipt"]])
                self.assertEqual(case["reasons"], got["reasons"])

    def test_if_w09_three_phrases_are_distinct(self):
        values = list(PHRASES.values())
        self.assertEqual(["영상 없는 주문", "관측 불가", "뷰어 로딩 실패"], values)
        for a in values:
            for b in values:
                if a != b:
                    self.assertNotIn(a, b)
        for name, b in VECTORS["observations"].items():
            text = observation_text(b)
            self.assertEqual(name.startswith("unavailable_"), PHRASES["observationUnavailable"] in text, name)
            self.assertNotIn(PHRASES["orderWithoutImages"], text)
            self.assertNotIn(PHRASES["viewerLoadFailed"], text)

    def test_the_label_texts_never_print_zero_for_unknown(self):
        for name in ("observed_unknown", "unavailable_last_unknown"):
            self.assertNotIn("0건", VECTORS["observationText"][name])
        self.assertIn("0건", VECTORS["observationText"]["observed_0"])


def body(text, start, end):
    head = text.index(start)
    return text[head:text.index(end, head)]


class SourcePins(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.arrivals = ARRIVALS.read_text(encoding="utf-8").replace("\r\n", "\n")
        cls.pages = PAGES.read_text(encoding="utf-8").replace("\r\n", "\n")
        cls.main = MAIN.read_text(encoding="utf-8").replace("\r\n", "\n")
        cls.service = SERVICE.read_text(encoding="utf-8").replace("\r\n", "\n")

    def test_module_carries_the_rules_the_model_mirrors(self):
        for needle in (
            "if(!previous||previous.count===null||current.count===null||(previous.series===null)!==(current.series===null))return null;",
            "const prior=base.owner===owner&&(base.observedAt===null||Date.parse(at)>=Date.parse(base.observedAt))?base.rows:new Map();",
            "if(value===null||value===undefined)return {rows:null};",
            "return {...base,available:false};",
            "const K=b.state==='observed'?b.count:null,comparable=K!==null;",
            "if(b.state==='not_observed'&&M>=1)reasons.push('not_observed_with_reported_transfer');",
            "if(b.changedAt&&Date.parse(receipt.serverReceivedAt)<Date.parse(b.changedAt))reasons.push('receipt_older_than_change');",
            "const BANNED=/완료|수신 완료|안정|다 옴|received|complete|stable/i;",
            "const PHRASES=Object.freeze({orderWithoutImages:'영상 없는 주문',observationUnavailable:'관측 불가',viewerLoadFailed:'뷰어 로딩 실패'});",
        ):
            self.assertEqual(1, self.arrivals.count(needle), needle)
        # S4-U1a stays: the growth diff and the null-as-unknown count are untouched.
        self.assertIn("const added=(before,after)=>before!==null&&after!==null&&after>before?after-before:0;", self.arrivals)
        self.assertNotIn("||0", self.arrivals.replace(" ", ""))
        self.assertNotIn("localStorage", self.arrivals)
        self.assertNotIn("sessionStorage", self.arrivals)

    def test_server_absence_surface_is_decided_from_the_whole_successful_enumeration(self):
        listing = body(self.service, "  async listStudies(c: Caller, query?: any) {", "  /** 프론트가 켜질 때")
        qido = listing.index("const qido = page ? await this.orthanc.studyIdentities(")
        at = listing.index("const observedAt = new Date().toISOString();")
        states = listing.index("const states = page ? await this.prisma.studyState.findMany({")
        self.assertTrue(qido < at < states)
        self.assertIn("select: { uid:true, institutionId:true, teleInstitutionId:true, origin:true, createdAt:true },", listing)
        self.assertIn("const notObserved = !page || window.pagination?.next === null ? this.notObserved(qido, states, me, access, observedAt) : undefined;", listing)
        self.assertLess(listing.index("await this.studyAccess.unchanged(c,access);"), listing.index("const notObserved = "))
        self.assertIn("observedAt,\n      ...(notObserved === undefined ? {} : { notObserved }),", listing)
        absent = body(self.service, "  private notObserved(", "\n  }\n")
        for needle in ("if (!Array.isArray(qido)) return null;", "if (!uid) return null;",
                       "if (s.institutionId !== me || present.has(s.uid) || !this.studyAccess.matches(access, s.uid)) continue;",
                       "if (!(s.createdAt instanceof Date) || typeof s.origin !== 'string') return null;",
                       "if (createdAt > observedAt) continue;",
                       "out.push({ uid: s.uid, origin: s.origin, createdAt });"):
            self.assertIn(needle, absent)
        # uid + origin + createdAt only: no patient field can leave through this surface.
        pushed = absent.split("out.push({")[1].split("})")[0]
        self.assertEqual(["uid", "origin", "createdAt"], re.findall(r"(?:^|,)\s*([A-Za-z_]\w*)", pushed))
        self.assertIn("const out: { uid: string; origin: string; createdAt: string }[] = [];", absent)
        # S4-U1a numeric 0 vs null stays.
        self.assertIn("count: qidoCount(st, '00201208'),", self.service)
        self.assertIn("series: qidoCount(st, '00201206'),", self.service)

    def test_page_client_hands_over_only_the_completing_page_observation(self):
        self.assertIn("if (page.next === null) draft.observation = { observedAt: data.observedAt, notObserved: data.notObserved };", self.pages)
        self.assertIn("const result = { studies:draft.rows, owner:[...owner], observation:draft.observation ?? null };", self.pages)

    def test_main_reports_observations_only_after_the_generation_checks_and_failures_empty_nothing(self):
        self.assertEqual(3, self.main.count("applyObservation("))              # definition + load + poll
        self.assertEqual(4, self.main.count("markObservationUnavailable("))    # definition + offline + load + poll
        load = body(self.main, "    async function load(options = {}) {", "      try {\n        const res = await fetch(\"/dicom-web/studies")
        offline = body(load, "      if (offline) {", "      try {")
        self.assertNotIn("studies = []", offline)
        self.assertIn("markObservationUnavailable();", offline)
        self.assertLess(load.index("if (loadSequence !== listLoadSequence || commitInFlight || epoch !== commitEpoch) return;\n        /**"),
                        load.index("applyObservation(r);"))
        self.assertIn("if (!e.stale && e.code !== 'STUDY_LIST_CHANGED') markObservationUnavailable();", load)
        poll = body(self.main, "    function startPolling() {", "    let pollFails = 0;")
        self.assertLess(poll.index("if (generation !== pollGeneration || commitInFlight || epoch !== commitEpoch) return;\n          pollFails = 0;"),
                        poll.index("applyObservation(r);"))
        self.assertLess(poll.index("if (e.stale || e.code === 'STUDY_LIST_CHANGED') return;"), poll.index("markObservationUnavailable();"))
        self.assertLess(poll.index("markObservationUnavailable();"), poll.index("if (++pollFails >= 2) goOffline(e);"))
        # The per-poll observation time stays out of #clinical, whose text Stage 3 tests hold still.
        clinical = body(self.main, "    function renderClinical() {", "    function applyObservation(")
        self.assertNotIn("receipt-", clinical)
        self.assertIn("renderObservation();\n    }", clinical)
        receipt = body(self.main, '<div id="study-receipt"', "</section>")
        self.assertLess(self.main.index('id="clinical"'), self.main.index('id="study-receipt"'))
        self.assertIn('role="group"', receipt)
        # No optimistic toast and no new persistence for observations.
        render = body(self.main, "    function renderObservation() {", "\n    }\n")
        for banned in ("toast(", "localStorage", "sessionStorage", "api(", "fetch("):
            self.assertNotIn(banned, render)
        self.assertIn("gateway: null", render)


# Pre-S4 inventory of main.html at e15c69c (sorted (key, count) JSON, sha256). Only these additions may appear.
BASE = {
    "ids": (270, "86d2f513367bc8871d250f0b87980a462bc0f13cfefca2236dc586571d85fa05"),
    "functions": (208, "bf3d33f654827fad09b2c0731878300c435b1912290c08e5cecbfd446dde81f8"),
    "selectors": (243, "35ee2f7aee41fec8c867b22deb7b631f3441e55679b90657948937b3d9ccb743"),
}
ADDED = {
    "ids": {"not-observed": 1, "not-observed-summary": 1, "not-observed-list": 1, "observation-status": 1,
            "study-receipt": 1, "receipt-assignment": 1, "receipt-observation": 1, "receipt-gateway": 1},
    "functions": {"applyObservation": 1, "markObservationUnavailable": 1, "renderObservation": 1},
    "selectors": {"#observation-status": 1, "#not-observed": 1, "#not-observed-summary": 1, "#not-observed-list": 1,
                  "#study-receipt": 1, "#receipt-observation": 2, "#receipt-assignment": 2, "#receipt-gateway": 2},
}
# S4-U2 order reconciliation surface; tests/order_reconciliation_source_test.py pins what each one does.
for _kind, _extra in {
    "ids": {"order-source-status": 1, "order-reconciliation": 1, "order-reconciliation-summary": 1,
            "order-reconciliation-list": 1},
    "functions": {"applyOrderReconciliation": 1, "renderOrderReconciliation": 1},
    "selectors": {"#order-reconciliation": 1, "#order-reconciliation-summary": 2, "#order-reconciliation-list": 1},
}.items():
    assert not set(_extra) & set(ADDED[_kind]), _kind
    ADDED[_kind].update(_extra)


def inventory(text):
    text = text.replace("\r\n", "\n")
    return {
        "ids": Counter(re.findall(r'\bid="([^"$]+)"', text)),
        "functions": Counter(re.findall(r"^ {4}(?:async )?function ([A-Za-z_$][\w$]*)\(", text, re.M)),
        "selectors": Counter(re.findall(r"\$\(\s*[\"'](#[A-Za-z][\w-]*)", text)),
    }


def extract_function(source, name):
    """Same scanner as tests/worklist_arrivals_dom_test.py; a stray quote in a comment breaks it there too."""
    start = source.index(f"function {name}(")
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


class Stage3Anchors(unittest.TestCase):
    def test_pre_s4_inventory_is_intact_and_only_named_additions_appear(self):
        current = inventory(MAIN.read_text(encoding="utf-8"))
        for kind, (keys, digest) in BASE.items():
            with self.subTest(kind):
                rest = Counter(current[kind])
                for key, count in ADDED[kind].items():
                    self.assertEqual(count, rest.pop(key, 0), key)
                self.assertEqual(keys, len(rest))
                self.assertEqual(digest, hashlib.sha256(json.dumps(sorted(rest.items()), ensure_ascii=False).encode()).hexdigest())
        main = MAIN.read_text(encoding="utf-8")
        self.assertEqual(1, main.count('id="b-print"'))

    def test_the_poll_harness_slices_the_shipped_functions_whole(self):
        main = MAIN.read_text(encoding="utf-8").replace("\r\n", "\n")
        for name, last in (("startPolling", "}, seconds * 1000);"), ("applyObservation", "renderObservation();"),
                           ("markObservationUnavailable", "renderObservation();"),
                           ("renderObservation", '$("#receipt-gateway").title = labels.gateway.title;')):
            sliced = extract_function(main, name)
            self.assertIn(last, sliced[-160:], name)
            self.assertTrue(sliced.rstrip().endswith("}"), name)
        harness = HARNESS.read_text(encoding="utf-8")
        for name in ("applyObservation", "markObservationUnavailable", "renderObservation"):
            self.assertIn('"%s"' % name, harness)


class Encoding(unittest.TestCase):
    def test_changed_files_are_strict_utf8_without_bom_or_bare_cr(self):
        for path in CHANGED:
            with self.subTest(path.name):
                data = path.read_bytes()
                self.assertFalse(data.startswith(b"\xef\xbb\xbf"))
                text = data.decode("utf-8")
                self.assertNotIn("\r", text.replace("\r\n", "\n"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
