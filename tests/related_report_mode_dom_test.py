# coding: utf-8
"""W5-PAGE-01..10, the client side of W5-API-02/03 -> RISK-WS2/WS4/WS5/WS7 -> TEST W5 Related Report mode (delivered page).

Design v5 section 1 (D1244: "이전 판독문 보며 쓰기" required), the O4 answer D1423 (R1 receipt, R2 one native edit under a
one-shot admission, R3 the operation outlives the mode, R6 three generations) and the W5-API wire contract (02c8a87 report
`wire_contract`, the r1 review's `handover_to_w5_ui`, #180's identity codes) as the D1473 addendum reads them.

The page is the delivered split page: the checkout's unmodified main.html, its generated bundle and every asset they
reference (related-report-mode.js/.css included), served by the logout suite's static handler from its allowlist against a
synthetic origin (W5 Phase B: no composed page, no fixture insertion, no Related-only asset route). A fault control of
related_report_mode_mutants.py serves one identified faulty copy of a real asset; the positive control never does.
Nothing here edits a product file.

W5Site extends the W4 FlowSite (the logout suite's wire boundary) with: three studies of one patient (a Target and two
Sources with approve/addendum ReportVersions) and one of another patient; the relatedInsert branch of PUT report
(receipt-first judgement, CAS, seed and Source checks, refused/applied/discarded receipts, ID_REUSED, SUPERSEDED, 400
shapes) and the receipt-bearing GET draft?insertRequestId. Every answer can be held, dropped, lost after the write or
replaced, so the page meets each outcome through its own controls.
"""
import hashlib
import io
import json
import re
import sys
import time
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import auth_logout_dom_test as h
import report_flow_dom_test as rf
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
LITE = ROOT / "worklist-v0/hpacs-lite"
FIELDS = tuple(h.FIELDS)
UID_A, UID_B, UID_C, UID_D = h.UID, h.UID_B, rf.UID_C, rf.UID_D
ALPHA, DELTA = "SYN PATIENT ALPHA", "SYN PATIENT DELTA"
# (uid, name, patient id, date, modality, description, accession)
W5_STUDIES = (
    (UID_A, ALPHA, "SYN-P-001", "20261003", "CT", "SYN CT CHEST CURRENT", "SYNACCA001"),
    (UID_B, ALPHA, "SYN-P-001", "20260901", "CT", "SYN CT CHEST PRIOR", "SYNACCB002"),
    (UID_C, ALPHA, "SYN-P-001", "20250801", "MR", "SYN MR CHEST OLDER", "SYNACCC003"),
    (UID_D, DELTA, "SYN-P-004", "20261002", "CT", "SYN CT OTHER PATIENT", "SYNACCD004"),
)
PRIOR_B = {"findings": "SYN prior B finding one.\nSYN prior B finding two.", "conclusion": "SYN prior B conclusion.",
           "recommendation": "SYN prior B recommendation: follow-up."}
PRIOR_C = {"findings": "SYN prior C addendum finding.", "conclusion": "SYN prior C conclusion.", "recommendation": ""}
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
MODE_REASON = "Related Report 모드에서는 쓸 수 없습니다"
PENDING_REASON = "Related Report에서 넣은 글의 저장 결과를 아직 확인하지 못했습니다"


def sha(value):
    # JSON.stringify's compact UTF-8 serialization of the frozen canonical tuples (02c8a87).
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    text = "".join(f"\\u{ord(c):04x}" if 0xD800 <= ord(c) <= 0xDFFF else c for c in text)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def utf16_slice(text, start, end=None):
    raw = text.encode("utf-16-le", errors="surrogatepass")
    return raw[start * 2:None if end is None else end * 2].decode("utf-16-le", errors="surrogatepass")


def insertion_text(version, parts, seed):
    blocks = []
    for part in parts:
        text = re.sub(r"\r\n?", "\n", version[part["field"]])
        units = text.encode("utf-16-le", errors="surrogatepass")
        size = len(units) // 2
        def splits(at):
            return (0 < at < size and 0xD800 <= int.from_bytes(units[(at-1)*2:at*2], "little") <= 0xDBFF
                    and 0xDC00 <= int.from_bytes(units[at*2:(at+1)*2], "little") <= 0xDFFF)
        if part["end"] > size or splits(part["start"]) or splits(part["end"]):
            return None
        blocks.append(utf16_slice(text, part["start"], part["end"]))
    return ("" if not seed or seed.endswith("\n") else "\n") + "\n\n".join(blocks)


def proposal_tuple(body):
    return ["related-insert-proposal-v1", *(body[k] for k in FIELDS), body["baseVersion"],
            sorted(body["citationIds"], key=lambda s: s.encode('utf-16-be', errors='surrogatepass')),
            sorted(body["structureIds"], key=lambda s: s.encode('utf-16-be', errors='surrogatepass'))]


def request_hash(body):
    r, owner = body["relatedInsert"], body["expectedOwner"]
    epoch, revision = body["expectedRevision"].split(":")
    s = r["source"]
    return sha(["related-insert-v1", r["insertRequestId"], owner["institution"], owner["sub"], owner["author"], r["targetUid"],
                epoch, int(revision), s["uid"], s["version"], s["action"], [[p["field"], p["start"], p["end"]] for p in s["parts"]],
                r["targetBaseVersion"], r["seedKind"], r["section"], r["position"], r["offset"], r["text"],
                r["selectionSeq"], r["contentRevision"], r["sourceGeneration"], proposal_tuple(body)])


def wire_request(text="😀", end=2, seed=""):
    return {"expectedOwner": h.owner_of(h.RAD), "expectedRevision": W5Site().revision_of(UID_A),
            "findings": seed + text, "conclusion": "", "recommendation": "", "baseVersion": 0,
            "citationIds": [], "structureIds": [], "relatedInsert": {
                "intent": "apply", "insertRequestId": "12345678-0000-4000-8000-123456789012",
                "source": {"uid": UID_B, "version": 1, "action": "approve",
                           "parts": [{"field": "findings", "start": 0, "end": end}]},
                "targetUid": UID_A, "targetBaseVersion": 0, "section": "findings", "position": "end",
                "offset": len(seed.encode("utf-16-le")) // 2, "text": text,
                "selectionSeq": 1, "contentRevision": 1, "sourceGeneration": 1, "seedKind": "report-head" if seed else "empty"}}


class W5Site(rf.FlowSite):
    """FlowSite with one patient's Target and Sources, their ReportVersions and the W5-API relatedInsert contract."""

    def __init__(self):
        super().__init__(3)
        self.flow = tuple((uid, name, patient) for uid, name, patient, *_ in W5_STUDIES)
        self.meta = {uid: {"date": date, "modality": modality, "desc": desc, "acc": acc}
                     for uid, _, _, date, modality, desc, acc in W5_STUDIES}
        self.store = {uid: {"revs": 0, "row": None, "report": {"version": 0, "rs": "W"}} for uid, _, _ in self.flow}
        self.store[UID_B]["report"] = {"version": 1, "rs": "A", **PRIOR_B}
        self.store[UID_C]["report"] = {"version": 2, "rs": "A", **PRIOR_C}
        self.versions = {
            UID_B: [self.version_row(UID_B, 1, "approve", PRIOR_B)],
            UID_C: [self.version_row(UID_C, 2, "addendum", PRIOR_C),
                    self.version_row(UID_C, 1, "approve", {"findings": "SYN prior C original.", "conclusion": "", "recommendation": ""})],
        }
        self.receipts = {}                 # insertRequestId -> stored receipt (binding, state, revisions, proposal)
        self.related_puts = []             # (uid, body) of every relatedInsert PUT that reached the server
        self.related_answers = []          # "ok" | "hold" | "abort" | "lost" | (status, body), one per relatedInsert PUT
        self.held_related = []             # (route, uid, body, account)
        self.checks = []                   # (uid, insertRequestId) of every receipt Check
        self.check_answers = []            # "ok" | "abort" | "hold" | (status, body)
        self.held_checks = []              # (route, uid, id, account)
        self.version_reads = []            # uid of every versions read
        self.version_answers = {}          # uid -> list of "hold" | "abort" | (status, body)
        self.held_versions = []            # (route, uid)
        self.refuse_reason = None          # a business refusal the server answers to the next applies (e.g. TARGET_HELD)
        self.identity_issues = []          # uids the list reports as split (WORKLIST-SPLIT-UID)

    @staticmethod
    def version_row(uid, version, action, texts):
        return {"id": f"SYN-V-{uid[-1]}-{version}", "uid": uid, "version": version, "action": action, **texts,
                "reason": None, "author": "syn-rad2@synthetic.test", "at": f"2026-09-0{version}T10:00:00.000Z"}

    # ── the list ──
    def list_body(self, account, rename=None):
        rows = []
        for uid, name, patient in self.flow:
            if uid in self.hidden or uid in self.identity_issues:
                continue
            row = self.study_row(account, h.UID, name, patient)
            row.update(uid=uid, date=self.meta[uid]["date"], modality=self.meta[uid]["modality"],
                       desc=self.meta[uid]["desc"], acc=self.meta[uid]["acc"])
            row["state"] = self.state_of(uid, account)
            rows.append(row)
        body = {"studies": rows, "serverTime": "2026-10-03T00:00:00.000Z", "observedAt": "2026-10-03T00:00:00.000Z",
                "notObserved": [], "pagination": {"owner": [h.INSTITUTION, account["sub"]], "limit": 100, "offset": 0,
                                                  "total": len(rows), "next": None}}
        body["identityIssues"] = [{"uid": uid, "code": "STUDY_IDENTITY_UNRESOLVED"} for uid in self.identity_issues]
        return body

    # ── the W5-API relatedInsert contract (synthetic) ──
    def head_of(self, uid):
        rep = self.store[uid]["report"]
        return {k: rep.get(k, "") for k in FIELDS}, rep["version"]

    def binding_of(self, uid, body, account):
        ri = {k: v for k, v in body["relatedInsert"].items() if k not in ("intent", "expectedReceiptRevision")}
        rest = {k: body[k] for k in ("expectedRevision", *FIELDS, "baseVersion")}
        return {"owner": h.owner_of(account), "uid": uid, **rest,
                "citationIds": sorted(body["citationIds"], key=lambda s: s.encode('utf-16-be', errors='surrogatepass')),
                "structureIds": sorted(body["structureIds"], key=lambda s: s.encode('utf-16-be', errors='surrogatepass')), "relatedInsert": ri}

    @staticmethod
    def proposal_row(body):
        return {**{k: body[k] for k in FIELDS}, "baseVersion": body["baseVersion"],
                "citations": list(body["citationIds"]), "structured": list(body["structureIds"])}

    def matches(self, uid, rec):
        row = self.store[uid]["row"]
        return (rec["state"] == "applied" and self.revision_of(uid) == rec["appliedRevision"] and row is not None
                and sha(proposal_tuple({**row, "citationIds": row["citations"], "structureIds": row["structured"]})) == rec["proposalHash"])

    def receipt_view(self, uid, rec, rid=None):
        if rec is None:
            return {"insertRequestId": rid, "result": "unknown", "state": None, "requestHash": None, "proposalHash": None,
                    "expectedRevision": None, "appliedRevision": None, "receiptRevision": None, "currentMatches": False,
                    "discardable": False, "reason": "RECEIPT_ABSENT"}
        applied = rec["state"] == "applied"
        matches = self.matches(uid, rec)
        return {"insertRequestId": rec["id"], "result": ("applied" if matches else "unknown") if applied else "refused",
                "state": rec["state"], "requestHash": rec["requestHash"], "proposalHash": rec["proposalHash"],
                "expectedRevision": rec["expectedRevision"], "appliedRevision": rec["appliedRevision"],
                "receiptRevision": rec["receiptRevision"], "currentMatches": matches,
                "discardable": rec["state"] == "refused", "reason": ("SUPERSEDED" if applied and not matches else rec["reason"])}

    def invalid(self, field):
        return 400, {"code": "RELATED_INSERT_INVALID", "field": field, "message": "SYN-SERVER-WORDING invalid " + field}

    def related_put(self, uid, body, account):
        """The relatedInsert branch of PUT report: owner first, shape, then the receipt before the CAS (R1)."""
        if body.get("expectedOwner") != h.owner_of(account):
            return 409, {"code": "REPORT_DRAFT_OWNER_CHANGED", "message": "SYN-SERVER-WORDING owner"}
        ri = body.get("relatedInsert")
        if not isinstance(ri, dict) or ri.get("intent") not in ("apply", "discard"):
            return self.invalid("intent")
        for field in ('citationIds', 'structureIds'):
            if len(set(body[field])) != len(body[field]):
                return self.invalid(field)
        rid = ri.get("insertRequestId")
        if not isinstance(rid, str) or not UUID.match(rid):
            return self.invalid("insertRequestId")
        if "insert" in body or "structure" in body:
            return self.invalid("relatedInsert")
        if ri.get("targetUid") != uid or ri.get("section") not in ("findings", "conclusion") or ri.get("position") != "end":
            return self.invalid("target")
        if ri.get("targetBaseVersion") != body.get("baseVersion"):
            return self.invalid("targetBaseVersion")
        text, section, offset = ri.get("text"), ri.get("section"), ri.get("offset")
        if not isinstance(text, str) or "\r" in text or not text.strip() or type(offset) is not int or offset < 0:
            return self.invalid("text")
        if utf16_slice(body[section], offset) != text:
            return self.invalid("offset")
        if ri["intent"] == "discard" and (type(ri.get("expectedReceiptRevision")) is not int or ri["expectedReceiptRevision"] < 1):
            return self.invalid("expectedReceiptRevision")
        parts = ri["source"].get("parts")
        previous = -1
        if not isinstance(parts, list) or not 1 <= len(parts) <= 3:
            return self.invalid("source.parts")
        for p in parts:
            if (not isinstance(p, dict) or set(p) != {"field", "start", "end"} or p["field"] not in FIELDS
                    or FIELDS.index(p["field"]) <= previous or type(p["start"]) is not int or type(p["end"]) is not int
                    or not 0 <= p["start"] < p["end"] <= 2147483647):
                return self.invalid("source.parts")
            previous = FIELDS.index(p["field"])
        if uid in self.identity_issues:
            return 409, {"code": "STUDY_IDENTITY_UNRESOLVED"}
        binding = self.binding_of(uid, body, account)
        rec = self.receipts.get(rid)
        if rec is not None and rec["binding"] != binding:
            return 409, {"code": "ID_REUSED", "message": "SYN-SERVER-WORDING id reused"}
        env = lambda: self.envelope_of(uid, account)
        if ri["intent"] == "discard":
            if rec is None:
                return 409, {"code": "RELATED_INSERT_NOT_DISCARDABLE", "message": "SYN absent", **env(),
                             "relatedInsert": self.receipt_view(uid, None, rid)}
            if rec["state"] == "discarded":
                return 200, {**env(), "relatedInsert": self.receipt_view(uid, rec)}
            if rec["state"] == "applied":
                return 409, {"code": "RELATED_INSERT_NOT_DISCARDABLE", "message": "SYN applied", **env(),
                             "relatedInsert": self.receipt_view(uid, rec)}
            if rec["receiptRevision"] != ri["expectedReceiptRevision"]:
                return 409, {"code": "RELATED_INSERT_RECEIPT_CHANGED", "message": "SYN changed", **env(),
                             "relatedInsert": self.receipt_view(uid, rec)}
            rec.update(state="discarded", reason="INSERT_DISCARDED", receiptRevision=rec["receiptRevision"] + 1)
            return 200, {**env(), "relatedInsert": self.receipt_view(uid, rec)}
        if rec is not None and rec["state"] == "applied":
            view = self.receipt_view(uid, rec)
            if view["currentMatches"]:
                return 200, {**env(), "relatedInsert": view}
            return 409, {"code": "RELATED_INSERT_SUPERSEDED", "message": "SYN superseded", **env(), "relatedInsert": view}
        if rec is not None and rec["state"] == "discarded":
            return 409, {"code": "RELATED_INSERT_DISCARDED", "message": "SYN discarded", **env(),
                         "relatedInsert": self.receipt_view(uid, rec)}
        reason = self.refuse_reason
        if ri["source"]["uid"] in self.identity_issues:
            return 409, {"code": "STUDY_IDENTITY_UNRESOLVED"}
        if reason is None and body["expectedRevision"] != self.revision_of(uid):
            reason = "DRAFT_CONFLICT"
        if reason is None:
            row = self.store[uid]["row"]
            seed = {**{k: body[k] for k in FIELDS}, section: utf16_slice(body[section], 0, offset)}
            if row is not None:
                same = (ri["seedKind"] == "private-draft" and all(row[k] == seed[k] for k in FIELDS)
                        and row["baseVersion"] == body["baseVersion"] and sorted(row["citations"]) == sorted(body["citationIds"])
                        and sorted(row["structured"]) == sorted(body["structureIds"]))
            else:
                head, version = self.head_of(uid)
                kind = "report-head" if any(head.values()) else "empty"
                same = (ri["seedKind"] == kind and all(head[k] == seed[k] for k in FIELDS) and version == body["baseVersion"]
                        and not body["citationIds"] and not body["structureIds"])
            if not same:
                reason = "SEED_CHANGED"
        if reason is None:
            src = ri["source"]
            versions = self.versions.get(src.get("uid"), [])
            head = max(versions, key=lambda v: v["version"]) if versions else None
            if not head or head["version"] != src.get("version") or head["action"] != src.get("action"):
                reason = "SOURCE_CHANGED"
            else:
                if insertion_text(head, parts, utf16_slice(body[section], 0, offset)) != text:
                    return self.invalid("text")
        if reason is not None:
            if rec is None:
                rec = {"id": rid, "binding": binding, "requestHash": request_hash(body), "proposalHash": sha(proposal_tuple(body)),
                       "expectedRevision": body["expectedRevision"], "appliedRevision": None, "state": "refused",
                       "receiptRevision": 1, "reason": reason, "row": None}
                self.receipts[rid] = rec
            elif rec["reason"] != reason:
                rec.update(reason=reason, receiptRevision=rec["receiptRevision"] + 1)
            return 409, {"code": "RELATED_INSERT_REFUSED", "message": "SYN refused " + reason, **env(),
                         "relatedInsert": self.receipt_view(uid, rec)}
        st = self.store[uid]
        st["revs"] += 1
        st["row"] = self.proposal_row(body)
        if rec is not None:
            rec["receiptRevision"] += 1
        rec = rec or {"id": rid, "binding": binding, "requestHash": request_hash(body), "proposalHash": sha(proposal_tuple(body)),
                      "expectedRevision": body["expectedRevision"], "receiptRevision": 1}
        rec.update(state="applied", reason=None, appliedRevision=self.revision_of(uid), row=dict(st["row"]))
        self.receipts[rid] = rec
        return 200, {**env(), "relatedInsert": self.receipt_view(uid, rec)}

    def related_check(self, uid, rid, account):
        if uid in self.identity_issues:
            return 409, {"code": "STUDY_IDENTITY_UNRESOLVED"}
        rec = self.receipts.get(rid)
        if rec is not None and (rec["binding"]["owner"] != h.owner_of(account) or rec["binding"]["uid"] != uid):
            view = {**self.receipt_view(uid, None, rid), "result": "refused", "reason": "ID_REUSED"}
        else:
            view = self.receipt_view(uid, rec, rid)
        return 200, {**self.envelope_of(uid, account), "relatedInsert": view}

    def api(self, route, request, method, path, query):
        # FlowSite handles bootstrap before the inherited generic hold queue.
        # Park that read here so delayed Reload Report exercises the real continuation.
        if method == "GET" and path in self.held_gets:
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            return self.held_gets[path].append(route)
        found = re.fullmatch(r"/api/studies/([^/]+)/(report|draft|report/versions)", path)
        if found and found.group(1) in self.store:
            uid, what = found.groups()
            if method == "GET" and what == "report/versions" and uid in self.versions:
                account, refused = self.authenticate(request)
                if refused:
                    return self.refuse(route, *refused)
                self.version_reads.append(uid)
                queue = self.version_answers.get(uid) or []
                reply = queue.pop(0) if queue else "ok"
                if reply == "hold":
                    return self.held_versions.append((route, uid))
                if reply == "abort":
                    return route.abort("connectionreset")
                if reply != "ok":
                    return self.answer(route, *reply)
                return route.fulfill(json=sorted(self.versions[uid], key=lambda v: -v["version"]))
            if method == "GET" and what == "draft" and "insertRequestId" in parse_qs(query):
                account, refused = self.authenticate(request)
                if refused:
                    return self.refuse(route, *refused)
                rid = parse_qs(query)["insertRequestId"][0]
                self.checks.append((uid, rid))
                reply = self.check_answers.pop(0) if self.check_answers else "ok"
                if reply == "hold":
                    return self.held_checks.append((route, uid, rid, account))
                if reply == "abort":
                    return route.abort("connectionreset")
                if reply != "ok":
                    return self.answer(route, *reply)
                return self.answer(route, *self.related_check(uid, rid, account))
            if method == "PUT" and what == "report":
                body = request.post_data_json
                if isinstance(body, dict) and "relatedInsert" in body:
                    account, refused = self.authenticate(request)
                    if refused:
                        return self.refuse(route, *refused)
                    self.calls.append(("PUT-related", path))
                    self.related_puts.append((uid, body))
                    reply = self.related_answers.pop(0) if self.related_answers else "ok"
                    if reply == "hold":
                        return self.held_related.append((route, uid, body, account))
                    if reply == "abort":
                        return route.abort("connectionreset")
                    if reply == "lost":
                        self.related_put(uid, body, account)
                        return route.abort("connectionreset")
                    if reply != "ok":
                        return self.answer(route, *reply)
                    return self.answer(route, *self.related_put(uid, body, account))
        return super().api(route, request, method, path, query)

    def finish_related(self, index=0, lost=False):
        route, uid, body, account = self.held_related.pop(index)
        answer = self.related_put(uid, body, account)
        if lost:
            route.abort("connectionreset")
        else:
            self.answer(route, *answer)
        return answer[0]

    def finish_versions(self, index=0):
        route, uid = self.held_versions.pop(index)
        route.fulfill(json=sorted(self.versions[uid], key=lambda v: -v["version"]))


# One Ctrl+Z / Ctrl+Shift+Z in the focused field, as the keyboard sends it (native history).
class RelatedModePage(unittest.TestCase):
    """REQ W5-PAGE-01..10 on the delivered split page; only HTTP is synthetic."""
    bundle_source = None     # a fault control's bundle (related_report_mode_mutants.py)
    asset_source = None      # (file, body): one shipped asset outside the bundle served as a one-off copy
    viewport = {"width": 1400, "height": 900}

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = W5Site()
        self.context = self.browser.new_context(viewport=self.viewport, locale="ko-KR", timezone_id="Asia/Seoul")
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
        if self.bundle_source is not None:
            self.context.route("**/main-split.bundle.js", lambda route: route.fulfill(
                body=self.bundle_source, content_type="text/javascript; charset=utf-8"))
        if self.asset_source is not None:
            self.context.route("**/" + self.asset_source[0], lambda route: route.fulfill(
                body=self.asset_source[1], content_type="text/javascript; charset=utf-8"))
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.page.set_default_navigation_timeout(30000)
        self.errors, self.dialogs = [], []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", lambda dialog: (self.dialogs.append(dialog.message), dialog.accept()))
        self.page.clock.install()

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.site.violations, "requests the synthetic origin does not answer")

    # ── driving the page ──
    def open(self):
        self.page.goto(h.MAIN_URL)
        expect(self.page.locator(f'#rows tr[data-uid="{UID_D}"]')).to_be_visible()

    def open_target(self, uid=UID_A):
        self.page.locator(f'#rows tr[data-uid="{uid}"]').click()
        self.wait(lambda: self.js("selectedUid") == uid, "the Target opens")
        expect(self.page.locator("#findings")).to_be_editable()
        self.wait(lambda: self.js("draftClient.lists(selectedUid) !== null"), "the Target's draft baseline")

    def js(self, expression, arg=None):
        return self.page.evaluate(expression) if arg is None else self.page.evaluate(expression, arg)

    def wait(self, predicate, what, timeout=10.0):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > deadline:
                self.fail(f"{what}: not observed; last requests {self.site.calls[-8:]}")
            self.page.wait_for_timeout(20)

    def settle(self, ms=150):
        self.page.wait_for_timeout(ms)

    def related_row(self, uid):
        return self.page.locator(f'#relrows tr[data-uid="{uid}"]')

    def mode(self):
        return self.page.locator("#related-mode")

    def notice(self):
        return self.page.locator("#report-notice")

    def enter(self, uid=UID_B, ready=True):
        self.related_row(uid).locator("td").first.click()
        expect(self.mode()).to_be_visible()
        if ready:
            self.wait(lambda: self.page.locator('[data-related-source="findings"]').text_content() != "", "the Source text")

    def source_text(self, field):
        return self.page.locator(f'[data-related-source="{field}"]').text_content()

    def open_insert(self):
        self.page.locator("#related-mode-insert").click()
        expect(self.page.locator("#related-insert-dialog")).to_be_visible()
        expect(self.page.locator("#related-insert-confirm")).to_be_enabled()

    def insert(self, section="findings"):
        self.open_insert()
        if section != "findings":
            self.page.locator(f'#related-insert-dialog input[value="{section}"]').check()
        self.page.locator("#related-insert-confirm").click()

    def op_state(self, uid=UID_A):
        return self.js("uid => relatedInserts.get(uid)?.state ?? null", uid)

    def value(self, field="findings"):
        return self.page.locator("#" + field).input_value()

    def stored(self, uid=UID_A):
        return self.site.stored_of(uid)

    def editor_hidden(self):
        return self.js("() => { const e = document.querySelector('.redit'); return [e.hidden, e.inert]; }")

    def back(self):
        self.page.locator("#related-mode-back").click()
        expect(self.mode()).to_be_hidden()

    def whole(self):
        return PRIOR_B["findings"] + "\n\n" + PRIOR_B["conclusion"] + "\n\n" + PRIOR_B["recommendation"]

    def autosave(self):
        """The page's own 20 s autosave stores the typed text and the draft line knows it (no W5 path involved)."""
        self.page.clock.run_for(20001)
        self.wait(lambda: self.stored() is not None and not self.js("reportConverge.has(selectedUid)")
                  and self.js("!draftClient.busy(selectedUid)"), "the autosave")

    # ── PAGE-01/02/03: entry, the two cards, the Source ──
    def test_w5_entry_from_a_clean_target_shows_two_cards_hides_the_editor_and_focuses_the_title(self):
        self.open()
        # Phase B startup order: the mode is mounted before its first eager consumer. Both CVR areas call `blocked()` while
        # they mount; had the mode not existed yet, their mount would have failed into the page's fallback toast.
        self.assertEqual([True, True, True], self.js("[relatedMode.active() === false, criticalResults !== null, "
                                                     "criticalInbox !== null]"))
        self.open_target()
        writes = len(self.site.flow_puts)
        self.enter()
        expect(self.page.locator("#related-mode-title")).to_be_focused()
        self.assertEqual([True, True], self.editor_hidden(), "the editor host is hidden and inert")
        self.assertEqual((UID_A, UID_B), (self.js("selectedUid"), self.js("relatedUid")), "Source never becomes the Target")
        target = self.page.locator("#related-mode-target").inner_text()
        for value in (ALPHA, "SYN-P-001", "SYN Hospital A", "2026-10-03", "SYN CT CHEST CURRENT", "SYNACCA001", "v0 · RS W", "No Draft"):
            self.assertIn(value, target)
        source = self.page.locator("#related-mode-source")
        expect(source).to_have_attribute("aria-label", "Related Report (read only)")
        for value in (ALPHA, "SYN-P-001", "SYN Hospital A", "2026-09-01", "SYN CT CHEST PRIOR", "SYNACCB002", "v1 · Approved",
                      "READ ONLY", "syn-rad2@synthetic.test", "2026-09-01 10:00"):
            self.assertIn(value, source.inner_text())
        self.assertEqual((PRIOR_B["findings"], PRIOR_B["conclusion"], PRIOR_B["recommendation"]),
                         tuple(self.source_text(f) for f in ("findings", "conclusion", "recommendation")))
        self.assertEqual(writes, len(self.site.flow_puts), "a clean Target enters without a write")
        self.assertEqual([], self.site.related_puts)
        self.assertEqual("", self.value(), "the Source never reaches the Target's editor")

    def test_w5_entry_with_unsaved_text_saves_first_and_enters_only_after_the_save_is_confirmed(self):
        self.open()
        self.open_target()
        self.page.locator("#findings").fill("SYN A typed before")
        self.site.put_answers = ["hold"]
        self.related_row(UID_B).locator("td").first.click()
        self.wait(lambda: self.site.held_flow_puts, "the Target's draft write")
        self.settle()
        expect(self.mode()).to_be_hidden()
        self.site.finish_flow_put()
        expect(self.mode()).to_be_visible()
        self.assertEqual({"findings": "SYN A typed before", "conclusion": "", "recommendation": ""}, self.stored())
        self.assertIn("Draft Saved", self.page.locator("#related-mode-target").inner_text())

    def test_w5_a_second_entry_while_the_first_waits_is_the_one_that_enters(self):
        """Reentrant entry: the reader clicks B, then C, while both entries wait for what decides the Target's text (an
        approval out); when it answers, only the later choice (C) opens — the earlier entry never takes the mode first."""
        self.open()
        self.open_target()
        self.site.commit_answers = ["hold"]
        self.page.locator("#b-approve").click()
        self.wait(lambda: self.site.held_flow_commits, "the approval out")
        self.related_row(UID_B).locator("td").first.click()
        self.settle(200)
        self.related_row(UID_C).locator("td").first.click()
        self.settle(300)
        expect(self.mode()).to_be_hidden()
        self.site.finish_flow_commit()
        expect(self.mode()).to_be_visible()
        self.wait(lambda: self.source_text("findings") == PRIOR_C["findings"], "C's text")
        self.settle(300)
        self.assertEqual(UID_C, self.js("relatedUid"))
        expect(self.page.locator("#related-mode-source")).to_contain_text("SYN MR CHEST OLDER")

    def test_w5_entry_refused_save_stays_with_the_notice_and_retry_enters_after_the_cause_is_gone(self):
        self.open()
        self.open_target()
        self.page.locator("#findings").fill("SYN A refused")
        self.site.put_answers = [(403, {"code": "REPORT_FORBIDDEN", "message": "SYN refused write"})]
        self.related_row(UID_B).locator("td").first.click()
        expect(self.notice()).to_contain_text("Save Failed")
        expect(self.notice()).to_contain_text("Related Report 모드로 들어가지 않았습니다")
        expect(self.mode()).to_be_hidden()
        self.assertEqual(([False, False], UID_A), (self.editor_hidden(), self.js("selectedUid")))
        self.assertEqual("SYN A refused", self.value())
        self.page.locator("#report-notice-retry").click()
        expect(self.mode()).to_be_visible()
        self.assertEqual((UID_A, UID_B), (self.js("selectedUid"), self.js("relatedUid")))
        self.assertEqual({"findings": "SYN A refused", "conclusion": "", "recommendation": ""}, self.stored())

    def test_w5_entry_unknown_save_stays_and_check_reads_then_enters(self):
        self.open()
        self.open_target()
        self.page.locator("#findings").fill("SYN A unknown")
        self.site.put_answers = ["lost"]
        self.site.draft_read_answers = ["abort"]
        self.related_row(UID_B).locator("td").first.click()
        expect(self.notice()).to_contain_text("Result Unknown")
        expect(self.mode()).to_be_hidden()
        writes = len(self.site.flow_puts)
        self.page.locator("#report-notice-check").click()
        expect(self.mode()).to_be_visible()
        self.assertEqual(writes, len(self.site.flow_puts), "Check is a read")

    def test_w5_entry_during_composition_does_not_enter(self):
        self.open()
        self.open_target()
        self.page.locator("#findings").focus()
        cdp = self.context.new_cdp_session(self.page)
        cdp.send("Input.imeSetComposition", {"text": "한", "selectionStart": 1, "selectionEnd": 1})
        self.page.evaluate("uid => enterRelatedMode(uid, { focus: true })", UID_B)
        expect(self.notice()).to_contain_text("글자 조합")
        self.settle()
        expect(self.mode()).to_be_hidden()
        cdp.send("Input.insertText", {"text": "한"})

    def test_w5_entry_waits_for_an_approval_in_flight_and_enters_only_after_its_answer(self):
        """Clean but deciding: nothing unconfirmed is typed (the move gate alone would answer clear), yet an approval is out;
        the entry waits for its answer within the same bound (D1423 R2)."""
        self.open()
        self.open_target()
        self.site.commit_answers = ["hold"]
        self.page.locator("#b-approve").click()
        self.wait(lambda: self.site.held_flow_commits, "the approval out")
        self.related_row(UID_B).locator("td").first.click()
        self.settle(300)
        expect(self.mode()).to_be_hidden()
        self.site.finish_flow_commit()
        expect(self.mode()).to_be_visible()
        self.assertEqual("A", self.site.store[UID_A]["report"]["rs"])

    def test_w5_source_states_load_failed_restricted_none_and_a_late_answer_after_a_source_move(self):
        self.open()
        self.open_target()
        self.site.version_answers[UID_B] = [(503, {"code": "SYN_DOWN", "message": "SYN down"})]
        self.enter(ready=False)
        expect(self.page.locator("#related-mode-source")).to_contain_text("Load Failed")
        expect(self.page.locator("#related-mode-insert")).to_be_disabled()
        self.page.locator("#related-mode-source button", has_text="Retry").click()
        self.wait(lambda: self.source_text("findings") == PRIOR_B["findings"], "the Source after Retry")
        # Access Restricted (403) is not a load failure; a late answer of an earlier read never replaces a newer one.
        self.site.version_answers[UID_C] = ["hold"]
        self.related_row(UID_C).locator("td").first.click()
        self.wait(lambda: self.site.held_versions, "C's read out")
        self.site.version_answers[UID_B] = [(403, {"code": "STUDY_ACCESS_DENIED", "message": "SYN denied"})]
        self.related_row(UID_B).locator("td").first.click()
        expect(self.page.locator("#related-mode-source")).to_contain_text("Access Restricted")
        self.site.finish_versions()
        self.settle()
        expect(self.page.locator("#related-mode-source")).to_contain_text("Access Restricted")
        self.assertEqual("", self.source_text("findings"), "C's late answer is not shown for B")
        expect(self.page.locator("#prior-report-status")).to_contain_text("Access Restricted")
        expect(self.page.locator("#prior-report-content")).to_be_hidden()
        self.assertNotIn(PRIOR_C["findings"], self.page.locator("#prior-findings").text_content(), "nor in the Related Report pane")
        self.assertEqual(UID_B, self.js("relatedUid"))

    def test_w5_source_is_the_current_approved_head_only(self):
        """An approve followed by a later reset is no current report: the mode shows no Source text and offers no Insert."""
        self.site.versions[UID_B] = [self.site.version_row(UID_B, 2, "reset", {k: "" for k in FIELDS}),
                                     self.site.version_row(UID_B, 1, "approve", PRIOR_B)]
        self.open()
        self.open_target()
        self.enter(ready=False)
        expect(self.page.locator("#related-mode-source")).to_contain_text("승인된 판독문이 없습니다")
        self.assertEqual("", self.source_text("findings"))
        expect(self.page.locator("#related-mode-insert")).to_be_disabled()

    def test_w5b_recommendation_shows_only_with_text_and_a_whole_insert_carries_only_what_is_shown(self):
        """W-07b (gap report: hide when empty). Findings and Conclusion are the report's sections. A stored Recommendation is
        shown read-only only when it has text, in the mode and in the Related Report pane alike; an empty one shows no heading.
        A whole-report Insert carries exactly the sections on screen, and the Target's own hidden Recommendation is kept."""
        self.open()
        self.open_target()
        sections = self.page.locator("#related-mode .related-mode-section h4:visible")
        pane = self.page.locator(".prior-report-section h4:visible")
        self.enter()
        expect(sections).to_have_text(["Findings", "Conclusion", "Recommendation"])
        expect(pane).to_have_text(["Findings", "Conclusion", "Recommendation"])
        expect(self.page.locator('#related-mode [data-related-source="recommendation"]')).to_have_text(PRIOR_B["recommendation"])
        # C's approved addendum has no Recommendation: neither place shows the heading, the two sections stay.
        self.related_row(UID_C).locator("td").first.click()
        self.wait(lambda: self.source_text("findings") == PRIOR_C["findings"], "C's text")
        expect(sections).to_have_text(["Findings", "Conclusion"])
        expect(pane).to_have_text(["Findings", "Conclusion"])
        self.open_insert()
        shown = PRIOR_C["findings"] + "\n\n" + PRIOR_C["conclusion"]
        expect(self.page.locator("#related-insert-text")).to_have_text(shown)
        self.page.locator("#related-insert-confirm").click()
        self.wait(lambda: self.op_state() == "applied", "the applied receipt")
        ri = self.site.related_puts[-1][1]["relatedInsert"]
        self.assertEqual(["findings", "conclusion"], [p["field"] for p in ri["source"]["parts"]], "no invisible Source field")
        self.assertEqual({"findings": shown, "conclusion": "", "recommendation": ""}, self.stored())
        # Back to B: its Recommendation is shown again (the value was never dropped).
        self.related_row(UID_B).locator("td").first.click()
        self.wait(lambda: self.source_text("findings") == PRIOR_B["findings"], "B's text")
        expect(sections).to_have_text(["Findings", "Conclusion", "Recommendation"])

    def test_w5_source_text_is_text_and_unresolved_studies_never_enter(self):
        self.site.versions[UID_B] = [self.site.version_row(UID_B, 1, "approve", {
            "findings": '<img src=x onerror="window.__synXss=1">SYN', "conclusion": "", "recommendation": ""})]
        self.open()
        self.open_target()
        self.enter()
        self.assertEqual('<img src=x onerror="window.__synXss=1">SYN', self.source_text("findings"))
        self.assertIsNone(self.js("window.__synXss ?? null"))
        self.assertEqual(0, self.page.locator("#related-mode img").count())
        # WORKLIST-SPLIT-UID mid-mode: the Source the list now reports as split is unavailable — no text, no Insert, Back works.
        self.site.identity_issues = [UID_B]
        self.page.locator("#refresh").click()
        self.wait(lambda: self.js("uid => appState[uid]?.identityUnresolved === true", UID_B), "the Source's identity issue")
        expect(self.page.locator("#related-mode-source")).to_contain_text("지금 목록에 없어")
        self.assertEqual("", self.source_text("findings"))
        expect(self.page.locator("#related-mode-insert")).to_be_disabled()
        self.back()
        # A Target the list reports as split never enters the mode (and is never a Target at all).
        self.site.identity_issues = [UID_A]
        self.page.locator("#refresh").click()
        self.wait(lambda: self.js("uid => appState[uid]?.identityUnresolved === true", UID_A), "the Target's identity issue")
        self.js("uid => enterRelatedMode(uid, { focus: true })", UID_C)
        self.settle()
        expect(self.mode()).to_be_hidden()
        self.assertEqual([], self.site.related_puts)

    # ── PAGE-04/05: one reviewed Insert, its receipt ──
    def test_w5_insert_applies_once_with_its_receipt_and_back_returns_to_the_insertion_end(self):
        self.open()
        self.open_target()
        self.enter()
        self.open_insert()
        expect(self.page.locator("#related-insert-text")).to_have_text(self.whole())
        expect(self.page.locator("#related-insert-target")).to_contain_text(ALPHA)
        self.page.locator("#related-insert-confirm").click()
        self.wait(lambda: self.op_state() == "applied", "the applied receipt")
        self.assertEqual(1, len(self.site.related_puts), "one request")
        uid, body = self.site.related_puts[0]
        ri = body["relatedInsert"]
        self.assertTrue(UUID.match(ri["insertRequestId"]))
        self.assertEqual(("apply", UID_A, "findings", "end", 0, self.whole(), "empty", UID_B, 1, "approve"),
                         (ri["intent"], ri["targetUid"], ri["section"], ri["position"], ri["offset"], ri["text"], ri["seedKind"],
                          ri["source"]["uid"], ri["source"]["version"], ri["source"]["action"]))
        self.assertEqual([{"field": "findings", "start": 0, "end": len(PRIOR_B["findings"])},
                          {"field": "conclusion", "start": 0, "end": len(PRIOR_B["conclusion"])},
                          {"field": "recommendation", "start": 0, "end": len(PRIOR_B["recommendation"])}], ri["source"]["parts"])
        self.assertEqual((body["baseVersion"], [], []), (ri["targetBaseVersion"], body["citationIds"], body["structureIds"]))
        self.assertEqual({"findings": self.whole(), "conclusion": "", "recommendation": ""}, self.stored())
        self.assertEqual([], [p for p in self.site.flow_puts if "relatedInsert" not in p[1]], "no ordinary draft write")
        self.assertEqual("applied", self.site.receipts[ri["insertRequestId"]]["state"])
        expect(self.page.locator("#related-mode-target")).to_contain_text("Draft Saved")
        expect(self.page.locator("#related-mode-status")).to_contain_text("삽입됨")
        self.assertFalse(self.js("reportConverge.has(selectedUid)"), "saved: the receipt and the whole draft match")
        expect(self.page.locator("#related-mode-title")).to_be_focused()
        self.back()
        expect(self.page.locator("#findings")).to_be_focused()
        self.assertEqual(self.whole(), self.value())
        self.assertEqual([len(self.whole())] * 2, self.js("[$('#findings').selectionStart, $('#findings').selectionEnd]"))
        self.assertEqual([False, False], self.editor_hidden())
        # Native history: one Undo removes the insertion, Redo puts it back (W6 frame unchanged).
        self.page.keyboard.press("Control+z")
        self.assertEqual("", self.value())
        self.page.keyboard.press("Control+Shift+z")
        self.assertEqual(self.whole(), self.value())

    def test_w5_insert_of_a_selection_into_conclusion_keeps_the_line_rule_and_the_hidden_recommendation(self):
        self.site.templates = [rf.TEMPLATE]
        self.open()
        self.open_target()
        # The hidden Recommendation gets its value through a real template application, then the autosave stores it.
        if not self.page.locator("#tplrows tr", has_text=rf.TEMPLATE["title"]).first.is_visible():
            self.page.locator("[data-study-panel-tab=templates]").first.click()
        self.page.locator("#tplrows tr", has_text=rf.TEMPLATE["title"]).first.dblclick()
        self.wait(lambda: self.value("recommendation") == rf.TEMPLATE["recommendation"], "the template's Recommendation")
        self.autosave()
        self.enter()
        # Select from the middle of the Source Conclusion into its Recommendation.
        self.js("""() => { const c = document.querySelector('[data-related-source="conclusion"]').firstChild;
          const r = document.querySelector('[data-related-source="recommendation"]').firstChild;
          const range = document.createRange(); range.setStart(c, 4); range.setEnd(r, 8);
          const s = document.getSelection(); s.removeAllRanges(); s.addRange(range); }""")
        self.insert("conclusion")
        self.wait(lambda: self.op_state() == "applied", "applied")
        ri = self.site.related_puts[0][1]["relatedInsert"]
        expected = "\n" + PRIOR_B["conclusion"][4:] + "\n\n" + PRIOR_B["recommendation"][:8]
        self.assertEqual(("conclusion", "private-draft", len(rf.TEMPLATE["conclusion"]), expected),
                         (ri["section"], ri["seedKind"], ri["offset"], ri["text"]))
        self.assertEqual([{"field": "conclusion", "start": 4, "end": len(PRIOR_B["conclusion"])},
                          {"field": "recommendation", "start": 0, "end": 8}], ri["source"]["parts"])
        self.assertEqual({"findings": rf.TEMPLATE["findings"], "conclusion": rf.TEMPLATE["conclusion"] + expected,
                          "recommendation": rf.TEMPLATE["recommendation"]}, self.stored())
        self.assertEqual(rf.TEMPLATE["recommendation"], self.value("recommendation"), "the Target Recommendation is untouched")

    def test_w5_lost_answer_is_unknown_and_check_promotes_only_with_the_receipt_and_the_whole_draft(self):
        self.open()
        self.open_target()
        self.enter()
        self.site.related_answers = ["lost"]
        self.insert()
        expect(self.notice()).to_contain_text("Result Unknown")
        self.assertEqual("unknown", self.op_state())
        self.assertTrue(self.js("reportConverge.has(selectedUid)"), "unknown is never saved")
        expect(self.page.locator("#report-notice-check")).to_be_visible()
        expect(self.page.locator("#report-notice-retry")).to_be_visible()
        expect(self.page.locator("#report-notice-discard")).to_be_hidden()
        # A Check whose answer is lost too stays unknown; the next one reads the applied receipt and the matching draft.
        self.site.check_answers = ["abort"]
        self.page.locator("#report-notice-check").click()
        self.wait(lambda: len(self.site.checks) == 1, "the first Check")
        self.settle()
        self.assertEqual("unknown", self.op_state())
        self.page.locator("#report-notice-check").click()
        self.wait(lambda: self.op_state() == "applied", "the Check's applied receipt")
        expect(self.notice()).to_be_hidden()
        self.assertEqual(1, len(self.site.related_puts), "Check sent no write")
        self.assertFalse(self.js("reportConverge.has(selectedUid)"))
        self.assertEqual(self.whole(), self.value())

    def test_w5_same_text_without_a_receipt_is_never_saved(self):
        """The server holds the very proposal text but has no receipt (another window wrote it): Check finds RECEIPT_ABSENT
        and the operation stays unknown — text equality is not the receipt."""
        self.open()
        self.open_target()
        self.enter()
        self.site.related_answers = ["abort"]
        self.insert()
        expect(self.notice()).to_contain_text("Result Unknown")
        rf.ReportFlowPage.another_window_writes(self, UID_A, self.whole())
        self.page.locator("#report-notice-check").click()
        self.wait(lambda: len(self.site.checks) == 1, "the Check")
        self.settle()
        self.assertEqual("unknown", self.op_state())
        self.assertTrue(self.js("reportConverge.has(selectedUid)"))
        expect(self.notice()).to_contain_text("Result Unknown")

    def test_w5_unknown_retry_resends_the_same_id_and_body_and_inserts_once(self):
        self.open()
        self.open_target()
        self.enter()
        self.site.related_answers = ["abort"]
        self.insert()
        expect(self.notice()).to_contain_text("Result Unknown")
        self.page.locator("#report-notice-retry").click()
        self.wait(lambda: self.op_state() == "applied", "applied by the same-ID Retry")
        self.assertEqual(2, len(self.site.related_puts))
        self.assertEqual(self.site.related_puts[0][1], self.site.related_puts[1][1], "the same frozen body")
        self.assertEqual(self.whole(), self.value(), "inserted once")
        self.assertEqual({"findings": self.whole(), "conclusion": "", "recommendation": ""}, self.stored())

    def test_w5_lost_then_retry_replays_the_applied_receipt_without_a_second_insertion(self):
        self.open()
        self.open_target()
        self.enter()
        self.site.related_answers = ["lost"]
        self.insert()
        expect(self.notice()).to_contain_text("Result Unknown")
        revs = self.site.store[UID_A]["revs"]
        self.page.locator("#report-notice-retry").click()
        self.wait(lambda: self.op_state() == "applied", "the replayed receipt")
        self.assertEqual(revs, self.site.store[UID_A]["revs"], "the replay wrote nothing")
        self.assertEqual(self.whole(), self.value())

    def test_w5_refused_retry_after_the_cause_and_discard_fences_before_the_inverse_edit(self):
        self.open()
        self.open_target()
        self.enter()
        self.site.refuse_reason = "TARGET_HELD"
        self.insert()
        expect(self.notice()).to_contain_text("Save Failed")
        expect(self.notice()).to_contain_text("다른 판독의가 이 검사를 판독 중입니다")
        expect(self.page.locator("#report-notice-discard")).to_be_visible()
        self.assertEqual(self.whole(), self.value(), "refused keeps the inserted text")
        rid = self.site.related_puts[0][1]["relatedInsert"]["insertRequestId"]
        self.assertEqual(("refused", 1), (self.site.receipts[rid]["state"], self.site.receipts[rid]["receiptRevision"]))
        # Retry after the cause: the same ID at the original CAS applies.
        self.site.refuse_reason = None
        self.page.locator("#report-notice-retry").click()
        self.wait(lambda: self.op_state() == "applied", "applied by Retry")
        self.assertEqual("applied", self.site.receipts[rid]["state"])
        self.assertEqual(self.whole(), self.value())

    def test_w5_discard_insert_tombstone_first_then_exactly_the_inserted_span_is_removed(self):
        self.open()
        self.open_target()
        self.page.locator("#findings").fill("SYN A seed line")
        self.autosave()
        self.enter()
        self.site.refuse_reason = "SOURCE_UNAVAILABLE"
        self.insert()
        expect(self.page.locator("#report-notice-discard")).to_be_visible()
        self.site.related_answers = ["hold"]
        self.page.locator("#report-notice-discard").click()
        self.wait(lambda: self.site.held_related, "the discard out")
        self.assertEqual("SYN A seed line\n" + self.whole(), self.value(), "nothing removed before the tombstone")
        held_body = self.site.held_related[0][2]
        self.assertEqual(("discard", 1), (held_body["relatedInsert"]["intent"], held_body["relatedInsert"]["expectedReceiptRevision"]))
        self.site.finish_related()
        self.wait(lambda: self.op_state() == "discarded", "the tombstone")
        self.assertEqual("SYN A seed line", self.value(), "the exact span is removed after the tombstone")
        self.assertFalse(self.js("reportConverge.has(selectedUid)"), "the editor holds the saved seed again")
        rid = held_body["relatedInsert"]["insertRequestId"]
        self.assertEqual("discarded", self.site.receipts[rid]["state"])
        self.assertEqual({"findings": "SYN A seed line", "conclusion": "", "recommendation": ""}, self.stored())
        # A late Retry of the discarded ID inserts nothing.
        self.assertEqual(409, self.site.related_put(UID_A, self.site.related_puts[0][1], h.RAD)[0])

    def test_w5_superseded_insert_goes_to_the_explicit_conflict_review_never_reapplied(self):
        self.open()
        self.open_target()
        self.enter()
        self.site.related_answers = ["lost"]
        self.insert()
        expect(self.notice()).to_contain_text("Result Unknown")
        # Another document of the same account writes after the lost apply: the receipt is historical now.
        rf.ReportFlowPage.another_window_writes(self, UID_A, "SYN other window", base_version=0)
        self.page.locator("#report-notice-check").click()
        self.wait(lambda: self.op_state() == "superseded", "SUPERSEDED")
        expect(self.page.locator("#b-draft-keep")).to_be_visible()
        expect(self.page.locator("#b-draft-load")).to_be_visible()
        self.assertEqual(1, len(self.site.related_puts), "never re-applied")
        self.assertEqual(self.whole(), self.value(), "the current text stays")
        self.back()
        self.page.locator("#b-draft-keep").click()
        self.wait(lambda: self.stored() == {"findings": self.whole(), "conclusion": "", "recommendation": ""},
                  "the explicit Keep This Text write")
        self.assertEqual(1, len(self.site.related_puts), "the explicit choice is an ordinary write, not the insert")


    def test_w5_id_reused_and_a_refused_request_shape_go_to_the_explicit_review_without_a_new_id(self):
        self.open()
        self.open_target()
        self.enter()
        self.site.related_answers = [(409, {"code": "ID_REUSED", "message": "SYN reused"})]
        self.insert()
        self.wait(lambda: self.op_state() == "id-reused", "ID_REUSED")
        expect(self.page.locator("#b-draft-keep")).to_be_visible()
        expect(self.notice()).to_contain_text("Draft Conflict")
        self.assertEqual(1, len(self.site.related_puts), "no new ID, no resend")
        self.assertEqual(self.whole(), self.value())
        self.wait(lambda: self.page.locator("#b-draft-keep").is_enabled(), "the review has the server's draft to choose against")
        self.page.clock.run_for(20001)      # the autosave tick: a review conflict ends only by the reader's choice
        self.settle(300)
        self.assertEqual([], [p for p in self.site.flow_puts if "relatedInsert" not in p[1]], "no ordinary write by itself")

    def test_w5_session_access_and_server_failures_are_unknown_never_proof_of_no_insert(self):
        """401/403/404/503, STUDY_ACCESS_CHANGED and #180's STUDY_IDENTITY_UNRESOLVED leave the operation unknown with the
        original request: no Discard (only a refused receipt is discardable), Check/Retry resend nothing new."""
        self.open()
        self.open_target()
        self.enter()
        answers = [(503, {"code": "REPORT_DRAFT_UNAVAILABLE", "message": "SYN busy"}),
                   (403, {"code": "STUDY_ACCESS_DENIED", "message": "SYN"}), (404, {"message": "SYN"}),
                   (409, {"code": "STUDY_ACCESS_CHANGED", "message": "SYN"}),
                   (409, {"code": "STUDY_IDENTITY_UNRESOLVED", "message": "SYN"}), "ok"]
        self.site.related_answers = list(answers)
        self.insert()
        for index in range(len(answers) - 1):
            self.wait(lambda: self.op_state() == "unknown" and len(self.site.related_puts) == index + 1, f"unknown {index}")
            expect(self.page.locator("#report-notice-discard")).to_be_hidden()
            self.assertTrue(self.js("reportConverge.has(selectedUid)"))
            self.page.locator("#report-notice-retry").click()
        self.wait(lambda: self.op_state() == "applied", "applied at last")
        bodies = [body for _, body in self.site.related_puts]
        self.assertEqual(1, len({json.dumps(b, sort_keys=True) for b in bodies}), "every resend is the same frozen body")
        self.assertEqual(self.whole(), self.value())

    def test_w5_discard_lost_reply_is_checked_then_reverted_and_later_edits_are_never_reverted(self):
        self.open()
        self.open_target()
        self.enter()
        self.site.refuse_reason = "SOURCE_CHANGED"
        self.insert()
        expect(self.page.locator("#report-notice-discard")).to_be_visible()
        self.site.related_answers = ["lost"]
        self.page.locator("#report-notice-discard").click()
        self.wait(lambda: self.op_state() == "discard-unknown", "the lost discard")
        self.assertEqual(self.whole(), self.value(), "no inverse edit before the tombstone is known")
        self.page.locator("#report-notice-check").click()
        self.wait(lambda: self.op_state() == "discarded", "the tombstone read")
        self.assertEqual("", self.value())
        # A second Insert, refused, then edited after Back: the confirmed discard does not overwrite the later text.
        self.insert()
        expect(self.page.locator("#report-notice-discard")).to_be_visible()
        self.back()
        self.page.locator("#findings").press("End")
        self.page.keyboard.type(" SYN later")
        self.page.locator("#report-notice-discard").click()
        self.wait(lambda: self.op_state() == "discarded", "the second tombstone")
        self.assertEqual(self.whole() + " SYN later", self.value(), "later edits stay; the reader decides")
        expect(self.page.locator("#b-draft-keep")).to_be_visible()
        writes = len(self.site.flow_puts)
        self.page.clock.run_for(20001)
        self.settle(300)
        self.assertEqual(writes, len(self.site.flow_puts), "no automatic write of the discarded insert's text")

    def test_w5_a_discard_that_lost_to_an_applied_retry_elsewhere_keeps_the_text_as_applied(self):
        """Retry versus Discard: when the apply wins (another document retried the same request), the discard is refused
        as not discardable and the page settles the applied operation — no inverse edit."""
        self.open()
        self.open_target()
        self.enter()
        self.site.refuse_reason = "TARGET_HELD"
        self.insert()
        expect(self.page.locator("#report-notice-discard")).to_be_visible()
        self.site.refuse_reason = None
        uid, body = self.site.related_puts[0]
        self.assertEqual(200, self.site.related_put(uid, body, h.RAD)[0], "the same request applied by another document")
        self.page.locator("#report-notice-discard").click()
        self.wait(lambda: self.op_state() == "applied", "applied wins")
        self.assertEqual(self.whole(), self.value())
        self.assertFalse(self.js("reportConverge.has(selectedUid)"))

    # ── PAGE-08: every report command waits for Back; the operation holds the Target's writes ──
    def test_w5_mode_blocks_every_report_command_shortcut_and_late_writer(self):
        self.site.templates = [rf.TEMPLATE]
        self.open()
        self.open_target()
        self.enter()
        calls = len(self.site.calls)
        for button in ("#b-approve", "#b-approve-next", "#b-save", "#b-prelim", "#b-transcribe", "#b-addendum", "#b-defer",
                       "#b-unread", "#b-clear", "#b-paste"):
            control = self.page.locator(button)
            self.assertTrue(control.is_disabled(), button)
            self.assertIn(MODE_REASON, control.get_attribute("title") or "", button)
        self.assertIn(MODE_REASON, self.page.locator("#b-mark-cvr").get_attribute("title") or "")
        # The handlers refuse as well when called past the disabled state (keys, other documents, a late callback).
        self.assertFalse(self.js("KinReportCommands.finalize()"), "Ctrl+S runs nothing in the mode")
        self.assertFalse(self.page.evaluate(rf.CTRL_S.replace("#findings", "#related-mode-title")), "the browser default stays")
        self.js("() => { commitReport('approve'); commitReport('save'); }")
        self.js("() => insertTemplate(templates[0])")
        self.js("() => document.querySelector('#b-clear').click()")
        self.js("() => discardDraft()")
        self.assertFalse(self.js("() => editReport([{ field: 'findings', start: 0, end: 0, text: 'SYN late writer' }])"),
                         "a late editor write without the admission is refused")
        self.settle(300)
        self.assertEqual([], self.site.flow_commits)
        self.assertEqual([], self.site.flow_puts)
        self.assertEqual("", self.value())
        self.assertEqual(self.js("reportWriteBlock()"), self.js("relatedMode.reason()"))
        writes = [c for c in self.site.calls[calls:] if c[0] != "GET"]
        self.assertEqual([], [c for c in writes if c[1].endswith(("/report", "/report/commit", "/draft"))])

    def test_w5_pending_insert_holds_decisions_and_the_move_until_check_settles_then_the_move_continues(self):
        self.open()
        self.open_target()
        self.enter()
        self.site.related_answers = ["lost"]
        self.insert()
        expect(self.notice()).to_contain_text("Result Unknown")
        self.back()
        self.assertTrue(self.page.locator("#b-approve").is_disabled())
        self.assertIn(PENDING_REASON, self.page.locator("#b-approve").get_attribute("title"))
        self.js("() => commitReport('approve')")
        self.page.clock.run_for(20001)      # the autosave timer: nothing ordinary for this text
        self.settle(300)
        self.assertEqual(([], []), (self.site.flow_commits, [p for p in self.site.flow_puts if "relatedInsert" not in p[1]]))
        # A row click on another study: the move waits; the one Notice speaks for the operation (Check reads its receipt).
        self.page.locator(f'#rows tr[data-uid="{UID_D}"]').click()
        expect(self.notice()).to_contain_text("이 삽입이 확인된 뒤에 이어 갑니다")
        self.assertEqual(UID_A, self.js("selectedUid"))
        self.page.locator("#report-notice-check").click()
        self.wait(lambda: self.js("selectedUid") == UID_D, "the move continues once the insert is confirmed")
        self.assertEqual({"findings": self.whole(), "conclusion": "", "recommendation": ""}, self.stored(UID_A))
        # It was the operation's receipt Check that confirmed it (the W4 draft read compares text only: never enough here).
        self.assertEqual((1, "applied"), (len(self.site.checks), self.op_state(UID_A)))

    def test_w5_back_after_an_unknown_insert_keeps_later_typing_and_a_late_check_saves_only_the_insert(self):
        self.open()
        self.open_target()
        self.enter()
        self.site.related_answers = ["lost"]
        self.insert()
        expect(self.notice()).to_contain_text("Result Unknown")
        self.back()
        expect(self.page.locator("#findings")).to_be_focused()
        self.page.keyboard.type(" SYN typed after Back")
        self.page.locator("#report-notice-check").click()
        self.wait(lambda: self.op_state() == "applied", "the late Check")
        self.assertEqual(self.whole() + " SYN typed after Back", self.value(), "the late answer never overwrites later typing")
        self.assertTrue(self.js("reportConverge.has(selectedUid)"), "the later typing is still unconfirmed")
        revision = self.site.revision_of(UID_A)
        self.page.clock.run_for(20001)
        self.wait(lambda: self.stored() == {"findings": self.whole() + " SYN typed after Back", "conclusion": "",
                                            "recommendation": ""}, "the ordinary autosave of the later typing")
        ordinary = [body for _, body in self.site.flow_puts if "relatedInsert" not in body]
        self.assertEqual(revision, ordinary[-1]["expectedRevision"], "on the applied revision")

    def test_w5_back_is_never_refused_when_a_refresh_leaves_the_target_out_of_the_list(self):
        """A refresh that no longer lists the Target (paged out, filtered, removed) never strands the reader in the mode:
        Back to Current Draft still brings the editor back, visible and focused, with its text."""
        self.open()
        self.open_target()
        self.page.locator("#findings").fill("SYN A kept")
        self.autosave()
        self.enter()
        self.site.hidden.add(UID_A)
        lists = self.site.count("GET", "/api/studies")
        self.page.get_by_role("group", name="Refresh").get_by_role("button", name="Refresh", exact=True).click()
        self.wait(lambda: self.site.count("GET", "/api/studies") > lists, "the refresh")
        self.settle(300)
        expect(self.page.locator("#related-current")).to_have_text("판독 대상을 선택하세요")
        self.back()
        self.assertEqual([False, False], self.editor_hidden())
        expect(self.page.locator("#findings")).to_be_focused()
        self.assertEqual("SYN A kept", self.value())

    def test_w5_return_to_current_leaves_the_mode_and_gives_the_viewing_back_to_the_target(self):
        self.open()
        self.open_target()
        self.page.locator("#findings").fill("SYN A kept")
        self.autosave()
        self.enter()
        self.page.locator("#related-return").click()
        expect(self.mode()).to_be_hidden()
        self.assertEqual([False, False], self.editor_hidden())
        expect(self.page.locator("#findings")).to_be_focused()
        self.assertEqual((UID_A, None), (self.js("selectedUid"), self.js("relatedUid")))
        expect(self.page.locator("#prior-findings")).to_have_text("")
        self.assertEqual("SYN A kept", self.value())

    def test_w5_clean_navigation_closes_the_mode_and_moves_and_prev_next_stay_available(self):
        self.open()
        self.open_target()
        self.enter()
        self.assertTrue(self.page.locator("#b-next").is_enabled())
        self.page.locator(f'#rows tr[data-uid="{UID_D}"]').click()
        self.wait(lambda: self.js("selectedUid") == UID_D, "the clean move")
        expect(self.mode()).to_be_hidden()
        self.assertEqual([False, False], self.editor_hidden())
        self.assertIsNone(self.js("relatedUid"))

    def test_w5b_the_common_command_block_carries_the_mode_reason_and_next_prev_leave_through_the_gate(self):
        """W4F-05 on the real mode (moved from report_flow_dom_test's W5_REASON stand-in, W5 Phase B). In the mode the
        common block answers the mode's reason for Approve, Ctrl+S (Finalize) and Approve & Next, and nothing commits;
        Next and Prev are not report commands there: they leave through the move gate, which for a clean Target closes the
        mode and switches in the same event."""
        self.open()
        self.open_target()
        self.enter()
        reasons = self.js("['approve', 'finalize', 'finalize-next', 'next', 'prev'].map(c => reportCommandBlocked(c))")
        self.assertEqual([self.js("relatedMode.reason()")] * 3 + [None, None], reasons)
        self.assertFalse(self.js("KinReportCommands.finalize()"))
        self.js("() => approveAndNext()")
        self.settle(300)
        self.assertEqual(([], UID_A), (self.site.flow_commits, self.js("selectedUid")))
        expect(self.mode()).to_be_visible()
        moved = self.js("() => { document.querySelector('#b-next').click(); return selectedUid; }")
        self.assertNotEqual(UID_A, moved, "Next switches in the same event")
        expect(self.mode()).to_be_hidden()
        self.assertEqual([False, False], self.editor_hidden())
        self.assertEqual([], self.site.flow_commits)

    def test_w5_back_without_insert_restores_caret_selection_direction_scroll_and_undo(self):
        self.open()
        self.open_target()
        # A window tall enough for the editor host to scroll the report (1400x1100: a 153 px host over 612 px of text).
        self.page.set_viewport_size({"width": 1400, "height": 1100})
        lines = "\n".join(f"SYN line {i}" for i in range(30))
        self.page.locator("#findings").fill(lines)
        self.autosave()
        start = lines.index("SYN line 17")
        self.page.locator("#findings").focus()
        # A backward selection in the middle of the report, scrolled into view the way the editor itself keeps it.
        self.js("""start => { const f = $('#findings'); f.setSelectionRange(start, start + 11, 'backward');
          const h = document.querySelector('.redit'), lh = parseFloat(getComputedStyle(f).lineHeight) || 16;
          h.scrollTop = f.offsetTop - h.offsetTop + 15 * lh; }""", start)
        self.settle(300)
        scrolls = "() => [document.querySelector('.redit'), ...document.querySelectorAll('.report-p, .right, .split')].map(e => e.scrollTop)"
        before = self.js(scrolls)
        self.enter()
        self.page.keyboard.press("Escape")
        expect(self.mode()).to_be_hidden()
        expect(self.page.locator("#findings")).to_be_focused()
        self.assertEqual([start, start + 11, "backward"],
                         self.js("[$('#findings').selectionStart, $('#findings').selectionEnd, $('#findings').selectionDirection]"))
        self.settle(300)
        self.assertEqual(before, self.js(scrolls))
        self.assertEqual(lines, self.value())
        # Undo still reaches the typing made before the mode (the same nodes and history).
        self.page.keyboard.press("Control+z")
        self.assertNotEqual(lines, self.value())

    def viewer_stand_in(self):
        """Only the viewer document is a stand-in (W4's VIEWER_STAND_IN); a comparison URL carries '@ohif/hpCompare', so the
        route is a regular expression rather than a glob."""
        viewer = []
        self.context.route(re.compile(r".*/ohif/viewer.*"), lambda route, request: (viewer.append(request.url), route.fulfill(
            body=rf.VIEWER_STAND_IN, content_type="text/html; charset=utf-8")))
        return viewer

    def enter_reading(self):
        viewer = self.viewer_stand_in()
        self.page.locator("#m-reading").click()
        self.wait(lambda: viewer, "the viewer document request")
        self.wait(lambda: self.js("() => { const f = document.querySelector('#reading-frame'); return !!f && !f.hidden && !f.inert; }"),
                  "the usable viewer frame")
        return viewer

    def test_w5_escape_closes_the_confirmation_first_then_leaves_and_the_keys_enter_and_back(self):
        viewer = self.viewer_stand_in()
        self.open()
        self.open_target()
        # The explicit image action views the Related study without the mode; Ctrl+Alt+3 then opens the mode on it.
        self.page.locator(f'[data-related-open="{UID_B}"]').click()
        self.wait(lambda: viewer, "Compare Images")
        self.page.bring_to_front()
        expect(self.mode()).to_be_hidden()
        self.page.locator("#findings").focus()
        self.page.keyboard.press("Control+Alt+3")
        expect(self.mode()).to_be_visible()
        expect(self.page.locator("#related-mode-title")).to_be_focused()
        self.wait(lambda: self.source_text("findings") == PRIOR_B["findings"], "the Source")
        self.open_insert()
        self.page.keyboard.press("Escape")
        expect(self.page.locator("#related-insert-dialog")).to_be_hidden()
        expect(self.mode()).to_be_visible()
        expect(self.page.locator("#related-mode-insert")).to_be_focused()
        self.page.keyboard.press("Escape")
        expect(self.mode()).to_be_hidden()
        expect(self.page.locator("#findings")).to_be_focused()
        # Back keeps the Source viewed: its report stays in the Related Report pane beside the editor (reading while writing),
        # and Related Report opens the mode on it again.
        self.assertEqual((UID_A, UID_B), (self.js("selectedUid"), self.js("relatedUid")))
        expect(self.page.locator("#prior-findings")).to_have_text(PRIOR_B["findings"])
        self.page.keyboard.press("Control+Alt+3")
        expect(self.mode()).to_be_visible()
        expect(self.page.locator("#related-mode-title")).to_be_focused()
        self.page.keyboard.press("Control+Alt+4")
        expect(self.mode()).to_be_hidden()
        expect(self.page.locator("#findings")).to_be_focused()
        self.page.locator(f'[data-related-open="{UID_C}"]').click()
        self.wait(lambda: self.js("relatedUid") == UID_C, "Compare Images C views C")
        self.page.bring_to_front()
        self.page.locator("#findings").focus()
        self.page.keyboard.press("Control+Alt+3")
        expect(self.mode()).to_be_visible()
        self.page.keyboard.press("Control+Alt+4")
        expect(self.mode()).to_be_hidden()
        expect(self.page.locator("#findings")).to_be_focused()
        self.assertEqual([], self.site.related_puts)

    def test_w5_source_move_inside_the_mode_keeps_the_pending_operation_and_its_source(self):
        self.open()
        self.open_target()
        self.enter()
        self.site.related_answers = ["abort"]
        self.insert()
        expect(self.notice()).to_contain_text("Result Unknown")
        self.related_row(UID_C).locator("td").first.click()
        self.wait(lambda: self.source_text("findings") == PRIOR_C["findings"], "the moved Source")
        expect(self.mode()).to_be_visible()
        expect(self.page.locator("#related-mode-insert")).to_be_disabled()   # a second Insert waits for the first
        self.page.locator("#report-notice-retry").click()
        self.wait(lambda: self.op_state() == "applied", "the original operation applied")
        ri = self.site.related_puts[-1][1]["relatedInsert"]
        self.assertEqual((UID_B, 1), (ri["source"]["uid"], ri["source"]["version"]), "the Retry kept its own Source")
        self.assertEqual(self.whole(), self.value())

    def test_w5_native_edit_refusal_restores_hidden_inert_and_focus_and_sends_nothing(self):
        self.open()
        self.open_target()
        self.enter()
        self.open_insert()
        # A focus listener makes the field read-only in the middle of the native edit (a hold arriving at that moment).
        self.js("() => document.addEventListener('focus', e => { if (e.target.id === 'findings') e.target.readOnly = true; }, { capture: true, once: true })")
        self.page.locator("#related-insert-confirm").click()
        expect(self.page.locator("#related-insert-dialog")).to_be_visible()
        expect(self.page.locator("#related-insert-error")).to_contain_text("넣지 못했습니다")
        self.assertEqual([True, True], self.editor_hidden())
        self.assertEqual("", self.value())
        self.assertEqual([], self.site.related_puts)
        self.assertIsNone(self.op_state())
        self.assertTrue(self.js("document.querySelector('#related-insert-dialog').contains(document.activeElement)"))

    def test_w5_reentrant_writes_during_the_native_edit_are_refused_and_the_text_is_exactly_the_insertion(self):
        self.site.templates = [rf.TEMPLATE]
        self.open()
        self.open_target()
        self.enter()
        self.open_insert()
        self.js("""() => {
          const once = { capture: true, once: true };
          document.addEventListener('focus', e => { if (e.target.id === 'findings') { window.__synTemplate = insertTemplate(templates[0]); stashReport(); } }, once);
          document.addEventListener('input', e => { if (e.target.id === 'findings') { window.__synInput = editReport([{ field: 'conclusion', start: 0, end: 0, text: 'SYN reentrant' }]); stashReport(); } }, once);
        }""")
        self.page.locator("#related-insert-confirm").click()
        self.wait(lambda: self.op_state() == "applied", "applied")
        self.assertEqual((False, False), (self.js("window.__synTemplate"), self.js("window.__synInput")))
        self.assertEqual((self.whole(), "", ""), (self.value(), self.value("conclusion"), self.value("recommendation")))
        self.assertEqual([], [p for p in self.site.flow_puts if "relatedInsert" not in p[1]])
        self.assertEqual(1, len(self.site.related_puts))
        self.assertEqual([True, True], self.editor_hidden(), "the mode's restriction is back")

    def test_w5_double_click_no_longer_opens_images_and_compare_images_opens_target_and_source(self):
        viewer = self.viewer_stand_in()
        self.open()
        self.open_target()
        self.related_row(UID_C).locator("td").first.dblclick()
        self.settle(400)
        self.assertEqual([], viewer, "a double click opens no viewer")
        expect(self.mode()).to_be_visible()
        self.page.locator(f'[data-related-open="{UID_B}"]').click()
        self.wait(lambda: viewer, "the explicit Compare Images")
        self.assertIn(UID_A + "," + UID_B, viewer[-1].replace("%2C", ",").replace("%2c", ","))
        self.assertEqual(UID_A, self.js("selectedUid"))

    def test_w5_logout_with_an_unknown_insert_reads_the_receipt_and_never_preserves_it_as_a_draft(self):
        self.open()
        self.open_target()
        self.enter()
        self.site.related_answers = ["abort"]
        self.insert()
        expect(self.notice()).to_contain_text("Result Unknown")
        self.page.locator("#logout").click()
        panel = self.page.locator("dialog.kin-logout")
        expect(panel).to_contain_text("Related Report에서 넣은 글의 저장 결과를 확인하지 못해")
        self.assertEqual(1, len(self.site.checks), "one receipt Check with the preparation")
        self.assertEqual([], [p for p in self.site.flow_puts if "relatedInsert" not in p[1]], "never an ordinary preserve")
        self.assertEqual([], self.site.logouts)
        panel.get_by_role("button", name="Back to Editing").click()
        expect(panel).to_have_count(0)
        self.page.locator("#report-notice-retry").click()
        self.wait(lambda: self.op_state() == "applied", "applied")
        self.page.locator("#logout").click()
        self.wait(lambda: self.site.logouts, "the logout after the insert was confirmed")

    def test_w5_logout_after_a_lost_answer_confirms_the_applied_receipt_and_logs_out(self):
        self.open()
        self.open_target()
        self.enter()
        self.site.related_answers = ["lost"]
        self.insert()
        expect(self.notice()).to_contain_text("Result Unknown")
        self.page.locator("#logout").click()
        self.wait(lambda: self.site.logouts, "the logout")
        self.assertEqual(1, len(self.site.checks))
        self.assertEqual([], [p for p in self.site.flow_puts if "relatedInsert" not in p[1]])

    def test_w5_reading_workspace_parity_enter_insert_and_back_with_the_workspace_keys(self):
        self.open()
        self.open_target()
        self.enter_reading()
        self.page.locator(f'[data-related-open="{UID_B}"]').click()
        self.wait(lambda: self.js("relatedUid") == UID_B, "Compare Images in the workspace")
        self.page.get_by_role("button", name="Related Report", exact=True).click()
        expect(self.mode()).to_be_visible()
        self.assertTrue(self.js("document.body.classList.contains('reading')"))
        self.wait(lambda: self.source_text("findings") == PRIOR_B["findings"], "the Source in the workspace")
        self.insert()
        self.wait(lambda: self.op_state() == "applied", "applied in the workspace")
        frame_key = """() => { const doc = document.querySelector('#reading-frame').contentDocument;
          const e = new KeyboardEvent('keydown', { key: '4', code: 'Digit4', ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
          doc.querySelector('.cornerstone-canvas').dispatchEvent(e); return e.defaultPrevented; }"""
        self.page.evaluate(frame_key)
        expect(self.mode()).to_be_hidden()
        expect(self.page.locator("#findings")).to_be_focused()
        self.assertEqual(self.whole(), self.value())

    def test_w5_reading_workspace_panels_follow_the_mode_keys_as_they_follow_the_panes(self):
        """Related Report from the open list overlay shows a Related panel the reader hid and closes the overlay (as it does
        for the pane); Report Editor from the overlay leaves the mode and closes it (as it does for the editor)."""
        self.open()
        self.open_target()
        self.enter_reading()
        self.page.locator(f'[data-related-open="{UID_B}"]').click()
        self.wait(lambda: self.js("relatedUid") == UID_B, "Compare Images in the workspace")
        self.page.bring_to_front()
        self.page.locator("#reading-related-toggle").click()
        expect(self.page.locator("#reading-related-region")).to_be_hidden()
        list_open = "document.body.classList.contains('reading-list-open')"
        self.page.locator("#findings").focus()
        self.page.keyboard.press("Control+Alt+1")
        expect(self.page.locator("#quick")).to_be_focused()
        self.assertTrue(self.js(list_open))
        self.page.keyboard.press("Control+Alt+3")
        expect(self.mode()).to_be_visible()
        expect(self.page.locator("#related-mode-title")).to_be_focused()
        expect(self.page.locator("#reading-related-region")).to_be_visible()
        self.assertFalse(self.js(list_open))
        self.page.keyboard.press("Control+Alt+1")
        expect(self.page.locator("#quick")).to_be_focused()
        self.page.keyboard.press("Control+Alt+4")
        expect(self.mode()).to_be_hidden()
        expect(self.page.locator("#findings")).to_be_focused()
        self.assertFalse(self.js(list_open))


    def test_w5r2_source_card_includes_signer_and_time(self):
        self.open();self.open_target();self.enter()
        text=self.page.locator('#related-mode-source').inner_text()
        print('SOURCE_CARD '+json.dumps(text),flush=True)
        self.assertIn('syn-rad2@synthetic.test',text,'PAGE_03: Source signer must be visible')
        self.assertIn('2026-09-01 10:00',text,'PAGE_03: Source signing time must be visible')
        self.open_insert()
        confirmation = self.page.locator('#related-insert-dialog').inner_text()
        for value in ('v1', 'Approved', 'syn-rad2@synthetic.test', '2026-09-01 10:00'):
            self.assertIn(value, confirmation, 'PAGE_03: confirmation provenance')

    def prepare_refused_source_issue(self):
        self.open();self.open_target();self.enter()
        self.site.refuse_reason='TARGET_HELD';self.insert()
        self.wait(lambda:self.op_state()=='refused','refused insertion')
        self.site.identity_issues=[UID_B]
        self.page.locator('#refresh').click()
        self.wait(lambda:self.js('uid => appState[uid]?.identityUnresolved === true',UID_B),'source flagged unresolved')
        self.site.refuse_reason=None
        for name in ('#report-notice-retry', '#report-notice-discard'):
            button = self.page.locator(name)
            self.assertTrue(not button.is_visible() or not button.is_enabled(), 'W5A-03: unresolved Source disables writing controls')
        return len(self.site.related_puts)

    def test_w5r2_retry_keeps_operation_when_frozen_source_unresolved(self):
        count=self.prepare_refused_source_issue()
        button=self.page.locator('#report-notice-retry')
        if button.is_visible() and button.is_enabled(): button.click()
        self.settle(300)
        self.assertEqual(count,len(self.site.related_puts),'PH1_5: Retry must not write while original Source is unresolved')
        self.assertEqual('refused',self.op_state(),'pending operation stays until identity resolution')

    def test_w5r2_discard_keeps_operation_when_frozen_source_unresolved(self):
        count=self.prepare_refused_source_issue()
        button=self.page.locator('#report-notice-discard')
        if button.is_visible() and button.is_enabled(): button.click()
        self.settle(300)
        self.assertEqual(count,len(self.site.related_puts),'PH1_5: Discard must not write while original Source is unresolved')
        self.assertEqual('refused',self.op_state(),'pending operation stays until identity resolution')

    def test_w5r2_queued_retry_rechecks_source_before_send(self):
        self.open();self.open_target();self.enter()
        self.site.related_answers=['abort'];self.insert()
        self.wait(lambda:self.op_state()=='unknown','unknown insertion')
        # Public list refresh has flagged the original Source by the time the user retries.
        self.site.identity_issues=[UID_B];self.page.locator('#refresh').click()
        self.wait(lambda:self.js('uid => appState[uid]?.identityUnresolved === true',UID_B),'source unresolved')
        before=len(self.site.related_puts)
        retry=self.page.locator('#report-notice-retry')
        if retry.is_visible() and retry.is_enabled(): retry.click()
        self.settle(300)
        self.assertEqual(before,len(self.site.related_puts),'PH1_5: unresolved Source blocks unknown Retry too')

    def test_w5r2_first_receipt_hash_must_match_frozen_request(self):
        self.open();self.open_target();self.enter()
        original=self.site.receipt_view
        def wrong_hash(*args,**kwargs):
            result=original(*args,**kwargs)
            if result['state']=='applied':
                result={**result,'requestHash':'0'*64,'proposalHash':'f'*64}
            return result
        self.site.receipt_view=wrong_hash
        self.insert();self.settle(400)
        print('FIRST_HASH_OUTCOME '+str(self.op_state()),flush=True)
        self.assertEqual('unknown',self.op_state(),'D1473: first receipt hashes must match the locally frozen request/proposal')

    def test_w5r2_incomplete_applied_receipt_must_stay_unknown(self):
        self.open();self.open_target();self.enter()
        original=self.site.receipt_view
        def incomplete(*args,**kwargs):
            result=original(*args,**kwargs)
            if result['state']=='applied':
                result={**result,'expectedRevision':None,'receiptRevision':None}
            return result
        self.site.receipt_view=incomplete
        self.insert();self.settle(400)
        print('INCOMPLETE_RECEIPT_OUTCOME '+str(self.op_state()),flush=True)
        self.assertEqual('unknown',self.op_state(),'D1473: incomplete applied receipt must not retire the operation')

    def test_w5r2_cvr_unknown_retry_is_blocked_in_related_mode(self):
        self.site.store[UID_A]['report']={'version':1,'rs':'T','findings':'SYN Target report','conclusion':'','recommendation':''}
        owner=[h.INSTITUTION,h.RAD['sub']];posts=[]
        def route_cvr(route,request):
            url=request.url
            if request.method=='POST' and url.endswith('/critical-results'):
                posts.append(request.post_data_json);route.abort('connectionreset');return
            if '/critical-result-recipients' in url:
                route.fulfill(json={'owner':owner,'uid':UID_A,'sendable':True,'reason':None,
                    'source':{'version':1,'action':'save','author':h.RAD['actor'],'at':'2026-09-01T10:00:00.000Z','final':False},
                    'recipients':[{'sub':'12345678-0000-4000-8000-123456789012','actor':'syn-cvr@synthetic.test','name':'SYN Recipient','role':'clinician'}]});return
            if '/critical-results?' in url:
                route.fulfill(json={'owner':owner,'view':'sent','items':[],'nextCursor':None,'pending':0});return
            route.fulfill(status=404,json={'code':'SYN_NOT_FOUND','message':'Synthetic result absent'})
        self.context.route(re.compile(r'.*/api/(?:studies/[^/]+/critical-result(?:-recipients|s)|critical-results)(?:[/?].*)?$'),route_cvr)
        self.open();self.open_target()
        self.page.locator('#report-more').click()
        self.page.locator('#b-mark-cvr').click()
        self.page.locator('#cvr-send-recipient').select_option('12345678-0000-4000-8000-123456789012')
        self.page.locator('#cvr-send-message').fill('SYN review message')
        self.page.locator('#cvr-send-submit').click()
        self.wait(lambda:len(posts)==1,'original CVR POST')
        expect(self.page.locator('#cvr-send-check')).to_be_visible()
        self.page.locator('#cvr-send-close').click()
        self.enter()
        retry=self.page.locator('#cvr-sent-attempts').get_by_role('button',name='Check Again')
        expect(retry).to_be_visible()
        if retry.is_enabled(): retry.click()
        self.settle(300)
        print('CVR_POSTS_IN_MODE '+str(len(posts)),flush=True)
        self.assertEqual(1,len(posts),'PAGE_08: CVR Check Again must not send while Related Report mode is active')
        self.back()
        retry.click()
        self.wait(lambda: len(posts) == 2, 'retry after Back')
        self.assertEqual(posts[0], posts[1], 'the original unknown attempt survives mode admission')

    def r2_refused(self):
        self.open();self.open_target();self.enter();self.site.refuse_reason='TARGET_HELD';self.insert()
        self.wait(lambda:self.op_state()=='refused','refused receipt');self.site.refuse_reason=None
        return self.value()

    def test_w5r2_incomplete_tombstone_cannot_inverse_the_native_insert(self):
        text=self.r2_refused();original=self.site.receipt_view
        def missing(*args,**kwargs):
            result=original(*args,**kwargs)
            if result['state']=='discarded':result={**result,'requestHash':None,'proposalHash':None,'expectedRevision':None,'receiptRevision':None}
            return result
        self.site.receipt_view=missing
        self.page.locator('#report-notice-discard').click();self.settle(300)
        print('INCOMPLETE_TOMBSTONE '+json.dumps({'state':self.op_state(),'insert_text_preserved':self.value()==text}),flush=True)
        self.assertEqual('discard-unknown',self.op_state(),'D1473: incomplete tombstone is not authority to retire and inverse the insertion')
        self.assertTrue(self.value()==text,'The native inserted text must remain for Check')

    def test_w5r2_source_identity_is_rechecked_when_discard_reply_arrives(self):
        text=self.r2_refused();self.site.related_answers=['hold']
        self.page.locator('#report-notice-discard').click()
        self.wait(lambda:len(self.site.held_related)==1,'discard request held')
        self.site.identity_issues=[UID_B];self.page.locator('#refresh').click()
        self.wait(lambda:self.js('uid => appState[uid]?.identityUnresolved === true',UID_B),'Source is now unresolved')
        self.site.finish_related();self.settle(300)
        print('LATE_DISCARD_UNRESOLVED_SOURCE '+json.dumps({'state':self.op_state(),'insert_text_preserved':self.value()==text}),flush=True)
        self.assertTrue(self.value()==text,'PH1.5: no inverse native edit after the original Source became unresolved')
        self.assertEqual('discard-unknown',self.op_state(),'Retain the pending operation until a complete list resolves Source identity')


    def test_w5r2_check_and_retry_compare_both_frozen_hashes(self):
        self.open(); self.open_target(); self.enter()
        self.site.related_answers = ['lost']; self.insert()
        self.wait(lambda: self.op_state() == 'unknown', 'lost apply')
        frozen = self.site.related_puts[0][1]
        original = self.site.receipt_view
        for control in ('#report-notice-check', '#report-notice-retry'):
            for field in ('requestHash', 'proposalHash'):
                with self.subTest(control=control, field=field):
                    self.site.receipt_view = lambda *a, **kw: {**original(*a, **kw), field: '0' * 64}
                    self.page.locator(control).click(); self.settle(200)
                    self.assertEqual('unknown', self.op_state(), 'W5A-01: every reply binds both local canonical digests')
                    self.assertEqual(self.whole(), self.value())
        self.assertTrue(all(body == frozen for _, body in self.site.related_puts), 'Retry retains the frozen body')
        self.site.receipt_view = original
        _, complete = self.site.related_check(UID_A, self.site.related_puts[0][1]['relatedInsert']['insertRequestId'], h.RAD)
        self.site.check_answers = [(503, complete)]
        self.page.locator('#report-notice-check').click(); self.settle(200)
        self.assertEqual('unknown', self.op_state(), 'a 503 with receipt-shaped data is not application proof')
        self.page.locator('#report-notice-check').click()
        self.wait(lambda: self.op_state() == 'applied', 'complete matching proof')

    def test_w5r2_applied_proof_fields_are_required_individually(self):
        self.open(); self.open_target(); self.enter()
        self.site.related_answers = ['lost']; self.insert()
        self.wait(lambda: self.op_state() == 'unknown', 'lost apply')
        original = self.site.receipt_view
        for field, value in [('expectedRevision', None), ('expectedRevision', 0), ('expectedRevision', 'OTHER:0'),
                             ('receiptRevision', None), ('receiptRevision', 0), ('receiptRevision', 1.5),
                             ('receiptRevision', '1'), ('appliedRevision', None), ('appliedRevision', 'SYNEPOCH1:99')]:
            with self.subTest(field=field, value=value):
                self.site.receipt_view = lambda *a, **kw: {**original(*a, **kw), field: value}
                self.page.locator('#report-notice-check').click(); self.settle(200)
                self.assertEqual('unknown', self.op_state(), 'W5A-02: incomplete or mismatched proof stays unknown')
                self.assertEqual(self.whole(), self.value())
        self.site.receipt_view = original
        self.page.locator('#report-notice-check').click()
        self.wait(lambda: self.op_state() == 'applied', 'complete receipt resolves')

    def test_w5r2_tombstone_proof_fields_are_required_individually(self):
        text = self.r2_refused()
        original = self.site.receipt_view
        for field, value in [('expectedRevision', None), ('receiptRevision', None), ('requestHash', None),
                             ('proposalHash', None), ('reason', None), ('discardable', True), ('result', 'unknown')]:
            with self.subTest(field=field):
                self.site.receipt_view = lambda *a, **kw: {**original(*a, **kw), field: value}
                self.page.locator('#report-notice-discard').click(); self.settle(200)
                self.assertEqual('discard-unknown', self.op_state(), 'W5A-02: complete tombstone required')
                self.assertEqual(text, self.value(), 'no native inverse without proof')
        self.site.receipt_view = original
        self.page.locator('#report-notice-check').click()
        self.wait(lambda: self.op_state() == 'discarded', 'complete tombstone resolves')
        self.assertEqual('', self.value())

    def test_w5r2_incomplete_refusal_never_enables_discard(self):
        self.open(); self.open_target(); self.enter()
        self.site.refuse_reason = 'TARGET_HELD'
        original = self.site.receipt_view
        self.site.receipt_view = lambda *a, **kw: {**original(*a, **kw), 'expectedRevision': None}
        self.insert(); self.wait(lambda: self.op_state() == 'unknown', 'incomplete refusal')
        for field in ('requestHash', 'proposalHash', 'receiptRevision', 'reason'):
            with self.subTest(field=field):
                self.site.receipt_view = lambda *a, **kw: {**original(*a, **kw), field: None}
                self.page.locator('#report-notice-retry').click(); self.settle(200)
                self.assertEqual('unknown', self.op_state(), 'W5A-02: incomplete refused receipt is not discard authority')
                self.assertFalse(self.page.locator('#report-notice-discard').is_visible())
                self.assertEqual(self.whole(), self.value())
        self.site.receipt_view = original
        self.page.locator('#report-notice-retry').click()
        self.wait(lambda: self.op_state() == 'refused', 'complete refused proof')
        expect(self.page.locator('#report-notice-discard')).to_be_enabled()

    def test_w5r2_source_identity_on_inverse_focus_after_back_keeps_operation(self):
        text = self.r2_refused(); self.back()
        self.js('''uid => document.querySelector('#findings').addEventListener('focus', () => {
          appState[uid] = {...appState[uid], identityUnresolved: true};
        }, {once: true})''', UID_B)
        self.page.locator('#report-notice-discard').click(); self.settle(200)
        self.assertTrue(self.js('uid => Boolean(appState[uid]?.identityUnresolved)', UID_B), 'focus listener ran')
        self.assertEqual(text, self.value(), 'W5A-03: final frame admission keeps native text')
        self.assertEqual('discard-unknown', self.op_state(), 'W5A-03: identity changed during native admission; keep operation')
        self.page.locator('#refresh').click()
        self.wait(lambda: not self.js('uid => Boolean(appState[uid]?.identityUnresolved)', UID_B), 'complete list resolves Source')
        self.page.locator('#report-notice-check').click()
        self.wait(lambda: self.op_state() == 'discarded', 'same tombstone resolves')
        self.assertEqual('', self.value())

    def test_w5r2_unresolved_source_blocks_direct_check_and_send_then_recovers_same_id(self):
        self.open(); self.open_target(); self.enter()
        self.site.related_answers = ['abort']; self.insert()
        self.wait(lambda: self.op_state() == 'unknown', 'unknown apply')
        frozen = self.site.related_puts[0][1]
        self.site.identity_issues = [UID_B]; self.page.locator('#refresh').click()
        self.wait(lambda: self.js('appState[relatedUid]?.identityUnresolved === true'), 'Source unresolved')
        self.js('() => { const op = relatedInserts.get(selectedUid); relatedInsertRetry(op); relatedInsertCheck(op); relatedInsertSend(op, "apply"); }')
        self.settle(200)
        self.assertEqual((1, 0), (len(self.site.related_puts), len(self.site.checks)), 'W5A-03: entry points block unresolved identities')
        self.assertEqual('unknown', self.op_state())
        self.site.identity_issues = []; self.page.locator('#refresh').click()
        self.wait(lambda: not self.js('Boolean(appState[relatedUid]?.identityUnresolved)'), 'complete list resolves Source')
        self.page.locator('#report-notice-retry').click()
        self.wait(lambda: self.op_state() == 'applied', 'same operation resumes')
        self.assertEqual(frozen, self.site.related_puts[-1][1])

    def test_w5r2_identity_is_rechecked_after_digest_await_before_transport(self):
        self.open(); self.open_target(); self.enter()
        self.site.related_answers = ['abort']; self.insert()
        self.wait(lambda: self.op_state() == 'unknown', 'unknown apply')
        self.js('''() => {
          const original = crypto.subtle.digest.bind(crypto.subtle);
          window.digestReleases = [];
          crypto.subtle.digest = (...args) => new Promise(resolve => digestReleases.push(() => resolve(original(...args))));
          window.restoreDigest = () => { crypto.subtle.digest = original; digestReleases.forEach(release => release()); };
        }''')
        self.page.locator('#report-notice-retry').click()
        self.wait(lambda: self.js('digestReleases.length') == 2, 'digest computation held')
        self.site.identity_issues = [UID_B]; self.page.locator('#refresh').click()
        self.wait(lambda: self.js('appState[relatedUid]?.identityUnresolved === true'), 'Source unresolved during queued write')
        self.js('restoreDigest()'); self.settle(200)
        self.assertEqual(1, len(self.site.related_puts), 'W5A-03: final admission after hashing')
        self.assertEqual('unknown', self.op_state())
        self.assertEqual(self.whole(), self.value())

    def test_w5r2_late_applied_receipt_waits_for_frozen_source_resolution(self):
        self.open(); self.open_target(); self.enter()
        self.site.related_answers = ['hold']; self.insert()
        self.wait(lambda: bool(self.site.held_related), 'apply held')
        _, uid, body, account = self.site.held_related[0]
        self.assertEqual(200, self.site.related_put(uid, body, account)[0], 'server applied before identity update')
        self.site.identity_issues = [UID_B]; self.page.locator('#refresh').click()
        self.wait(lambda: self.js('appState[relatedUid]?.identityUnresolved === true'), 'Source unresolved')
        self.site.finish_related(); self.settle(200)
        self.assertEqual('unknown', self.op_state(), 'W5A-03: late reply cannot retire while Source unresolved')
        self.assertEqual(self.whole(), self.value())
        self.site.identity_issues = []; self.page.locator('#refresh').click()
        self.wait(lambda: not self.js('Boolean(appState[relatedUid]?.identityUnresolved)'), 'complete list resolves Source')
        self.page.locator('#report-notice-check').click()
        self.wait(lambda: self.op_state() == 'applied', 'same receipt resolves after identity')

    def test_w5r2_wire_unicode_and_canonical_digest_vectors(self):
        # These digest values are outputs of the exported 02c8a87 server helpers, not product source pins.
        vectors = [
            ('😀X', '😀', 2, '', '743ee4f5d052aa8f7dceb63f7f3e415a41025bc9b20664cfa15b227923f36ef2',
             'd4eadb61a17f325ccb848db261cbd380e8e791b3ccbda6c0a9987d426bb9e99c'),
            ('A\rB', 'A\nB', 3, '', 'c36f5f310cd4013b1b8553bd12a27a4607fe98f5ebfeaf4537ea4b0e4a687965',
             '5633c859b7f67c720d2aabcbee934dbb6ca584097b02153e1214921ca1621a84'),
            ('😀X', '\n😀', 2, 'Seed 😀', '2b4ae2d1e8e2b0168f624bdb915cdfe27263f29d0894ea2dfb907cf8b1d4f061',
             'abd774a3196fcd8154ec26b4602b5fa9256965c3b4096487c757d05bc9999952'),
        ]
        for source, text, end, seed, request_digest, proposal_digest in vectors:
            with self.subTest(source=source, seed=seed):
                site = W5Site(); body = wire_request(text, end, seed)
                site.versions[UID_B][0]['findings'] = source
                if seed: site.store[UID_A]['report']['findings'] = seed
                status, answer = site.related_put(UID_A, body, h.RAD)
                self.assertEqual(200, status, 'W5A-06: same UTF-16/CR contract as frozen server')
                self.assertEqual(request_digest, answer['relatedInsert']['requestHash'], 'W5A-06: canonical request tuple')
                self.assertEqual(proposal_digest, answer['relatedInsert']['proposalHash'], 'W5A-06: canonical proposal tuple')
        body = wire_request(); body['citationIds'] = ['z', 'a']; body['structureIds'] = ['s2', 's1']
        body['recommendation'] = 'Keep "quote"\u2028e\u0301'
        self.assertEqual('77beb36e118b577e4a8e3ccae928f161dff0981427ae880e504f52027c537414', request_hash(body))
        self.assertEqual('f0d9feb28a583fdae40b35b95983bbde5fc78f2eff6b7782920503936559795c', sha(proposal_tuple(body)))
        body['relatedInsert'].update(intent='discard', expectedReceiptRevision=4)
        body['citationIds'].reverse(); body['structureIds'].reverse()
        self.assertEqual('77beb36e118b577e4a8e3ccae928f161dff0981427ae880e504f52027c537414', request_hash(body))
        version = {'findings': '😀X\r\nY', 'conclusion': 'A\rB', 'recommendation': 'R'}
        self.assertEqual('\n😀X\nY\n\nA\nB\n\nR', insertion_text(version,
            [{'field': 'findings', 'start': 0, 'end': 5}, {'field': 'conclusion', 'start': 0, 'end': 3},
             {'field': 'recommendation', 'start': 0, 'end': 1}], 'seed'))
        for start, end in [(0, 1), (1, 2), (0, 99)]:
            self.assertIsNone(insertion_text(version, [{'field': 'findings', 'start': start, 'end': end}], ''),
                              'split surrogate and out-of-range selections are refused')

    def test_w5r2_runtime_assets_are_the_current_sources(self):
        # D73/B6: byte identity itself is the provenance requirement here, not a constraint on product behavior.
        # Hash the HTTP bodies actually served, rather than treating the recorder HEAD as the runtime subject.
        self.open()
        names = ['main.html', 'main-split.bundle.js', 'report-draft-client.js', 'critical-result-send.js', 'critical-result-inbox.js', 'related-report-mode.js']
        observed = self.js('''async names => {
          const result = {};
          for (const name of names) {
            const bytes = await (await fetch(name)).arrayBuffer();
            result[name] = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
              b => b.toString(16).padStart(2, '0')).join('');
          }
          return result;
        }''', names)
        for name in names:
            expected = (LITE / name).read_bytes()
            self.assertEqual(hashlib.sha256(expected).hexdigest(), observed[name], 'W5A-07: current runtime source ' + name)
        print('W5-UI-RUNTIME-SOURCES ' + json.dumps({'subject': 'unmodified working sources of the checkout',
                                                  'served_sha256': observed}), flush=True)

    def r3_id_vectors(self, field):
        # W5R3-WIRE-11: independently executed 02c8a87 relatedRequestHash/relatedProposalHash.
        # Synthetic helper inputs, not a claim that these IDs can be persisted as citation keys.
        expected = {
            'citationIds': [
                ('860dab4271b8e6ec1657835575a1b5ca351db2f21df39a23350198ba07f4f0ba', 'b4ae9e6253a5e9072235fe13383a0bbd929cca4b42391487c5cdc317a7a20a66'),
                ('336c0d0cb9e3bf7c7423cca6e515e9d01764f1152ae6dfaaa432f2b35d97ba6d', '2642273828e036cddcd66fca6d993a045197f74915a67dc77385fe827341e3f5'),
                ('a205c477e2021b82126cd530cd502aa809c97a5e0d6f3752f8751bcdab6a9441', 'e356bb58cfc165f01e625688801905156a7489ead6a0bad15ed081a90ed26481')],
            'structureIds': [
                ('588471c544c35d3eb8b2ea9fcb37c4736ef101234c8795d1a38d009303f9d508', 'ca74ddf4f60aa4cf148f42d5966857406723c20a21b2178951ed2711a61c5154'),
                ('1ad184993c8085e2dbf3c3cf82771ace4640e3148ed935017efb51ed3e472222', 'fa17ccfca45ec7d58b4e03aea0af2b942023b920b46d776bf353bfd8f08daff4'),
                ('77f4ee87ddd506f7399099eeeb950344817e0cc2f8ee4d9ebca27f1cdd177a63', '052894bb98acfa6f0cc45426f4565606e1d2a9191945af9d281b27e47e754de4')],
        }
        for ids, hashes in zip([['a', 'z'], ['\U00010000', '\uffff'], ['\ud800', '\uffff']], expected[field]):
            for values in (ids, list(reversed(ids))):
                with self.subTest(field=field, ids=ascii(values)):
                    body = wire_request()
                    body[field] = values
                    self.assertEqual(ids, self.site.binding_of(UID_A, body, h.RAD)[field], 'wire binding uses JS UTF-16 order')
                    self.assertEqual(hashes, (request_hash(body), sha(proposal_tuple(body))))
        body = wire_request()
        body[field] = ['duplicate', 'duplicate']
        self.assertEqual(400, self.site.related_put(UID_A, body, h.RAD)[0], 'duplicate evidence IDs remain invalid')

    def test_w5r3_citation_ids_match_frozen_utf16_hashes(self):
        self.r3_id_vectors('citationIds')

    def test_w5r3_structure_ids_match_frozen_utf16_hashes(self):
        self.r3_id_vectors('structureIds')

    def r3_inventory(self, reading=False):
        # W5R3-ADMIT-07/08: real registered callbacks, delayed clipboard and native editor admission.
        self.site.templates = [{**rf.TEMPLATE, 'shortcut': 'synr3'}]
        self.site.store[UID_A]['report'] = {'version': 1, 'rs': 'T', 'findings': 'synr3',
                                          'conclusion': 'SYN kept conclusion', 'recommendation': ''}
        self.open()
        self.open_target()
        if reading:
            self.enter_reading()
        self.js("""() => {
          window.r3Pin = dictationContext('findings');
          window.r3Native = reportFrame.capture('findings', {start:0,end:5});
          Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{
            readText:()=>new Promise(resolve=>window.r3Paste=resolve),
            writeText:text=>{window.r3Copied=text;return Promise.resolve();}}});
          document.querySelector('#b-paste').dispatchEvent(new MouseEvent('click'));
          document.querySelector('#b-report-template').dispatchEvent(new MouseEvent('click'));
        }""")
        self.page.locator('#tpl-t').fill('SYN from Target')
        self.assertTrue(self.js("typeof window.r3Paste === 'function'"), 'clipboard was actually pending')
        self.js('uid => enterRelatedMode(uid)', UID_B)
        expect(self.mode()).to_be_visible()
        before = {k: self.value(k) for k in FIELDS}
        start = len(self.site.calls)
        # Save as Template was opened before the mode: the final Save rechecks admission.
        self.page.locator('#tpl-save').dispatch_event('click')
        self.assertIn(MODE_REASON, self.page.locator('#tpl-source').text_content())
        self.js('closeTemplateEditor(false)')
        for selector in ('#b-save', '#b-transcribe', '#b-approve', '#b-approve-next', '#b-addendum',
                         '#b-clear', '#b-paste', '#b-report-template', '#b-draft-discard', '#b-draft-load', '#b-report-reload'):
            with self.subTest(entry=selector, reading=reading):
                self.page.locator(selector).dispatch_event('click')
                self.settle(30)
                self.assertEqual(before, {k: self.value(k) for k in FIELDS})
        for selector in ('#b-unread', '#b-defer'):
            self.page.locator(selector).dispatch_event('click')
            self.page.locator('#reason-choices input').first.check(force=True)
            self.page.locator('#reason-ok').dispatch_event('click')
        # Direct continuations carry valid reasons/peer values; the shared command rejects before dispatch.
        for action in ('save', 'approve', 'preliminary', 'addendum', 'reset', 'defer'):
            self.js("action => commitReport(action, 'SYN explicit reason', 'SYN peer')", action)
        self.assertFalse(self.js('KinReportCommands.finalize()'))
        self.js("() => { document.querySelector('#related-mode-title').focus(); }")
        self.page.keyboard.press('Control+s')
        # Remap the registered Finalize command through the real shortcuts editor.
        self.context.route('**/api/workspace-shortcuts', lambda route: route.fulfill(status=503, json={'message':'SYN unavailable'}))
        self.page.locator('#workspace-shortcuts-edit').dispatch_event('click')
        self.page.locator('#workspace-shortcut-finalize').focus()
        self.page.keyboard.press('Control+Alt+t')
        self.page.locator('#workspace-shortcuts-apply').click()
        self.assertEqual('Control+Alt+KeyT', self.js('KinWorkspaceShortcuts.readV2(workspaceStorage, workspaceOwner.slice(KinWorkspaceLayout.PREFIX.length)).finalize'))
        self.page.locator('#related-mode-title').focus()
        self.page.keyboard.press('Control+Alt+t')
        if reading:
            canvas = self.page.frame_locator('#reading-frame').locator('.cornerstone-canvas')
            canvas.focus()
            self.page.keyboard.press('Control+Alt+t')
        self.assertFalse(self.js('() => insertTemplate(templates[0])'))
        self.js("() => { const e=document.querySelector('#findings');e.setSelectionRange(5,5);e.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})); }")
        self.assertFalse(self.js("() => dictationInsert({...window.r3Pin, expectedValue:window.r3Pin.value,text:'SYN delayed dictation'})"))
        self.assertFalse(self.js("() => editReport([{field:'findings',at:window.r3Native,text:'SYN delayed edit'}])"))
        self.js("window.r3Paste('SYN delayed clipboard')")
        self.js("() => { void stashReport(); window.dispatchEvent(new Event('online')); }")
        self.page.clock.fast_forward(21000)
        self.settle(300)
        self.assertEqual(before, {k: self.value(k) for k in FIELDS})
        writes = [c for c in self.site.calls[start:] if c[0] != 'GET' and c[1].endswith(('/report','/report/commit','/draft','/templates'))]
        self.assertEqual([], writes, 'no report/template write, including autosave/reconnect')
        self.assertEqual([], self.site.flow_commits)
        self.assertEqual([], self.site.flow_puts)
        self.assertIn(MODE_REASON, self.js('reportWriteBlock()'))
        # Read-only copy still reads the retained Target; the mode never replaces it with Source.
        self.page.locator('#b-copy').dispatch_event('click')
        self.assertIn(before['findings'], self.js('window.r3Copied'))
        self.assertNotIn(PRIOR_B['findings'], self.js('window.r3Copied'))
        self.back()
        self.page.locator('#findings').focus()
        self.page.keyboard.press('Control+Alt+t')
        self.wait(lambda: len(self.site.flow_commits) == 1, 'the registered remapped command after Back')
        self.assertEqual((UID_A, 'approve', before['findings']),
                         (self.site.flow_commits[0][0], self.site.flow_commits[0][1]['action'], self.site.flow_commits[0][1]['findings']))

    def test_w5r3_report_inventory_normal(self):
        self.r3_inventory()

    def test_w5r3_report_inventory_reading(self):
        self.r3_inventory(reading=True)

    def test_w5r3_reload_started_before_mode_cannot_replace_target_in_mode(self):
        # W5R3-ADMIT-07: the actual Reload Report continuation, not only its entry gate.
        self.site.store[UID_A]['report'] = {'version': 1, 'rs': 'T', 'findings': 'SYN original Target',
                                          'conclusion': '', 'recommendation': ''}
        self.open()
        self.open_target()
        if getattr(self, 'r3_reading', False):
            self.enter_reading()
        before = self.value()
        held = self.site.held_gets['/api/bootstrap'] = []
        self.js('() => { void reloadServerReport(); }')
        self.wait(lambda: bool(held), 'the pre-mode reload read')
        self.js('uid => enterRelatedMode(uid)', UID_B)
        expect(self.mode()).to_be_visible()
        self.site.store[UID_A]['report'] = {'version': 2, 'rs': 'T', 'findings': 'SYN late remote replacement',
                                          'conclusion': '', 'recommendation': ''}
        held.pop(0).fulfill(json={'states': {UID_A: self.site.state_of(UID_A, h.RAD)}})
        self.settle(300)
        expect(self.mode()).to_be_visible()
        self.assertEqual(before, self.value(), 'a pre-mode Reload Report must not replace the Related-mode Target')

    def test_w5r3_late_reload_reading(self):
        self.r3_reading = True
        self.test_w5r3_reload_started_before_mode_cannot_replace_target_in_mode()

    # ── W5R3B-05: the W5-UI r3 supplemental cases (Astra review-w5-ui-r3-20261021, D1672), promoted from the external
    # drivers into this suite: ADMIT-07 auxiliary/conflict 4, ADMIT-08 recovery/lease 6, ADMIT-09 recipient page 4 and the
    # complete-page sender 8, each in the default Workspace and in body.reading. Oracles are what reaches the synthetic
    # wire (requests, bodies, lease hold/release paths, receipts) and what the reader sees (field values, the selected
    # worklist row, notices, statuses, titles). Private page state is used only to open a pane through its own callback,
    # to enter the mode the way the row/key paths do, to wait for the page's own convergence before the next step, and for
    # the one D1656 synthetic retained-nonselected boundary (labelled below); it is never what a case judges.
    B05_REASON_WITH_BACK = "Related Report 모드에서는 쓸 수 없습니다 — Back to Current Draft로 돌아간 뒤 사용하세요."
    B05_RID = "87654321-0000-4000-8000-123456789012"
    B05_RECIPIENT = {"sub": "12345678-0000-4000-8000-123456789012", "actor": "syn-cvr@synthetic.test",
                     "name": "SYN Recipient", "role": "clinician"}

    def b05_worklist(self, reading):
        """In body.reading the worklist is an overlay the reader opens from the reading bar."""
        if reading:
            toggle = self.page.locator("#reading-bar").get_by_role("button", name="Worklist", exact=True)
            if toggle.get_attribute("aria-expanded") == "false":
                toggle.click()

    def b05_selected(self):
        return self.page.locator("#rows tr.sel").get_attribute("data-uid")

    def b05_autosaved(self, uid, text, what):
        self.page.clock.run_for(20001)
        self.wait(lambda: (self.site.stored_of(uid) or {}).get("findings") == text
                  and not self.js("u => reportConverge.has(u)", uid), what)

    def b05_holds(self, uid=UID_A):
        return sum(path.endswith("/" + uid + "/hold") for path in self.site.holds)

    def b05_releases(self, uid=UID_A):
        return sum(path.endswith("/" + uid + "/release") for path, _ in self.site.releases)

    def b05_writes(self, start):
        return [c for c in self.site.calls[start:] if c[0] != "GET"]

    # ADMIT-07: report auxiliaries opened before the mode refuse their write with the mode's reason, nothing is written.
    def b05_auxiliary(self, reading):
        self.site.templates = [rf.TEMPLATE]
        self.site.store[UID_A]["report"] = {"version": 1, "rs": "T", "findings": "SYN retained Target",
                                            "conclusion": "", "recommendation": ""}
        self.open()
        self.open_target()
        if reading:
            self.enter_reading()
        # Setup: each pane opened through the page's own entry callback with a valid input.
        request = {"uid": UID_A, "findingId": "f-1", "findingRevision": 2, "sourceIndex": 0, "sourceLabel": "SYN source",
                   "linkState": "current", "headRevision": None, "block": "SYN citation text"}
        self.js("r => openCitePreview(r)", request)
        expect(self.page.locator("#cite-preview-insert")).to_be_enabled()
        self.page.locator("#tplrows [data-tpl-preview]").first.dispatch_event("click")
        expect(self.page.locator("#tpl-preview-insert")).to_be_enabled()
        self.js("openStructure()")
        self.page.locator("#struct-value-text").fill("SYN acquisition note")
        expect(self.page.locator("#struct-apply")).to_be_enabled()
        self.js("""() => openStaleRebase(selectedUid, selectionSeq, {status:409, body:{
            code:'REPORT_DRAFT_STALE',draftBaseVersion:1,head:{version:2,updatedBy:'SYN reader',
            findings:'SYN approved text',conclusion:'',recommendation:''}}})""")
        expect(self.page.locator("#stale-rebase")).to_be_enabled()
        self.js("uid => enterRelatedMode(uid)", UID_B)
        expect(self.mode()).to_be_visible()
        before = {k: self.value(k) for k in FIELDS}
        start = len(self.site.calls)
        for button, status in (("#cite-preview-insert", "#cite-preview-status"), ("#tpl-preview-insert", "#tpl-preview-status"),
                               ("#struct-apply", "#struct-status"), ("#stale-rebase", "#stale-status")):
            with self.subTest(button=button, reading=reading):
                self.page.locator(button).dispatch_event("click")
                self.settle(50)
                expect(self.page.locator(status)).to_contain_text(MODE_REASON)
                self.assertEqual(before, {k: self.value(k) for k in FIELDS})
        self.assertEqual([], self.b05_writes(start), "no auxiliary write in the mode")
        self.js("() => { closeCitePreview(false); closeTemplatePreview(false); closeStructure(); closeStaleRebase(); }")
        self.back()
        self.assertEqual(before, {k: self.value(k) for k in FIELDS})
        self.assertEqual([], self.b05_writes(start), "Back writes nothing by itself")

    def test_w5r3b05_auxiliary_normal(self):
        self.b05_auxiliary(False)

    def test_w5r3b05_auxiliary_reading(self):
        self.b05_auxiliary(True)

    # ADMIT-07: a superseded insert's explicit conflict review cannot be decided inside the mode; after Back it can.
    def b05_conflict(self, reading):
        self.open()
        self.open_target()
        if reading:
            self.enter_reading()
            self.js("uid => enterRelatedMode(uid)", UID_B)
            expect(self.mode()).to_be_visible()
            self.wait(lambda: self.source_text("findings") == PRIOR_B["findings"], "the Source text")
        else:
            self.enter()
        self.site.related_answers = ["lost"]
        self.insert()
        expect(self.notice()).to_contain_text("Result Unknown")
        rf.ReportFlowPage.another_window_writes(self, UID_A, "SYN other window", base_version=0)
        self.page.locator("#report-notice-check").click()
        keep, load = self.page.locator("#b-draft-keep"), self.page.locator("#b-draft-load")
        expect(keep).to_be_visible()
        expect(load).to_be_visible()
        self.assertEqual(1, len(self.site.related_puts), "never re-applied")
        before, start = self.value(), len(self.site.calls)
        stored = self.stored()
        for button in ("#b-draft-keep", "#b-draft-load", "#b-report-reload"):
            with self.subTest(button=button, reading=reading):
                self.page.locator(button).dispatch_event("click")
                self.settle(80)
                self.assertEqual(before, self.value())
                expect(keep).to_be_visible()
                expect(load).to_be_visible()
        # The reload command explains itself with the mode's reason and its Back guidance (§4 wording, whole sentence).
        expect(self.page.locator("#toast")).to_have_text(self.B05_REASON_WITH_BACK)
        self.assertEqual([], self.b05_writes(start), "no conflict decision is written in the mode")
        self.assertEqual(stored, self.stored())
        self.back()
        keep.click()
        self.wait(lambda: self.stored() == {"findings": self.whole(), "conclusion": "", "recommendation": ""},
                  "the explicit Keep This Text write after Back")
        self.assertEqual(1, len(self.site.related_puts), "the explicit choice is an ordinary write, not the insert")

    def test_w5r3b05_conflict_normal(self):
        self.b05_conflict(False)

    def test_w5r3b05_conflict_reading(self):
        self.b05_conflict(True)

    # ADMIT-08: an off-target edit retained through an outage is recovered on the selected study after reconnect.
    def b05_current_recovery(self, reading):
        self.open()
        self.open_target()
        self.open_target(UID_D)
        if reading:
            self.enter_reading()
        self.page.locator("#findings").fill("SYN original other-study text")
        self.b05_autosaved(UID_D, "SYN original other-study text", "ordinary other-study autosave")
        # Two failed polls are not an outage lifetime: the reconnect bootstrap also fails until released.
        outage = {"active": True, "bootstrap_refused": 0}
        original_api = self.site.api

        def api(route, request, method, path, query):
            if outage["active"] and method == "GET" and path == "/api/bootstrap":
                outage["bootstrap_refused"] += 1
                return self.site.answer(route, 503, {"code": "SYN_OUTAGE"})
            return original_api(route, request, method, path, query)

        self.site.api = api
        self.site.list_answers = [(500, {"code": "SYN_OUTAGE"})] * 2
        self.page.clock.run_for(61000)
        expect(self.page.locator("#dbstat")).to_contain_text("서버 연결 끊김")
        self.assertEqual([], self.site.list_answers)
        self.assertGreaterEqual(outage["bootstrap_refused"], 1)
        self.page.locator("#findings").fill("SYN retained off-target edit")
        puts_before = len(self.site.flow_puts)
        self.b05_worklist(reading)
        self.page.locator(f'#rows tr[data-uid="{UID_A}"]').click()
        expect(self.notice()).to_contain_text("서버 연결이 끊겨 저장할 수 없습니다")
        self.assertEqual(UID_D, self.b05_selected(), "the move waits; the edited study stays selected")
        self.assertEqual("SYN retained off-target edit", self.value())
        self.assertEqual(puts_before, len(self.site.flow_puts), "nothing is written during the outage")
        self.site.put_answers = ["hold"]
        outage["active"] = False
        self.page.clock.run_for(16000)
        expect(self.page.locator("#dbstat")).to_contain_text("DB Connected")
        self.wait(lambda: bool(self.site.held_flow_puts), "the selected study's reconnect write")
        route, uid, body, account = self.site.held_flow_puts.pop(0)
        self.assertEqual((UID_D, "SYN retained off-target edit"), (uid, body["findings"]))
        self.site.answer(route, *self.site.write_of(uid, body, account))
        self.wait(lambda: not self.js("u => reportConverge.has(u)", UID_D), "the recovery's answer")
        self.assertEqual("SYN retained off-target edit", self.site.stored_of(UID_D)["findings"])
        self.assertEqual([], [p for p in self.site.flow_puts if p[0] == UID_A], "the other study is never written")
        self.b05_worklist(reading)
        self.open_target(UID_A)
        self.assertEqual(UID_A, self.b05_selected())

    def test_w5r3b05_current_study_recovery_normal(self):
        self.b05_current_recovery(False)

    def test_w5r3b05_current_study_recovery_reading(self):
        self.b05_current_recovery(True)

    # ADMIT-08 boundary (D1656): a retained nonselected draft is recovered while Related mode stays on its Target; the
    # Related insertion, receipt Check, lease and explicit save behave as usual. UI reachability is NOT claimed.
    def b05_retained_boundary(self, reading):
        self.open()
        self.open_target(UID_D)
        self.page.locator("#findings").fill("SYN original other-study text")
        self.b05_autosaved(UID_D, "SYN original other-study text", "ordinary other-study autosave")
        self.open_target(UID_A)
        if reading:
            self.enter_reading()
        self.js("uid => enterRelatedMode(uid)", UID_B)
        expect(self.mode()).to_be_visible()
        self.wait(lambda: self.source_text("findings") == PRIOR_B["findings"], "the Source text")
        before = {k: self.value(k) for k in FIELDS}
        # Synthetic boundary state (D1656 fixture; setup only): D carries a retained, not yet converged draft.
        self.js("""uid => {
            const draft = {...appState[uid].draft, findings:'SYN retained off-target edit'};
            appState[uid] = {...appState[uid], draft};
            draftClient.keep(uid, draft);
            reportConverge.add(uid);
        }""", UID_D)
        self.site.put_answers = ["hold"]
        self.js("window.dispatchEvent(new Event('online'))")
        self.page.clock.run_for(21000)
        self.wait(lambda: bool(self.site.held_flow_puts), "the retained nonselected write in the mode")
        self.assertEqual(UID_A, self.b05_selected())
        expect(self.mode()).to_be_visible()
        route, uid, body, account = self.site.held_flow_puts.pop(0)
        self.assertEqual((UID_D, "SYN retained off-target edit"), (uid, body["findings"]))
        self.site.answer(route, *self.site.write_of(uid, body, account))
        self.wait(lambda: not self.js("u => reportConverge.has(u)", UID_D), "the off-target recovery's answer")
        self.assertEqual("SYN retained off-target edit", self.site.stored_of(UID_D)["findings"])
        self.js("() => { void stashReport(); window.dispatchEvent(new Event('online')); }")
        self.page.clock.run_for(21000)
        self.settle()
        self.assertEqual([], [p for p in self.site.flow_puts if p[0] == UID_A], "the Related Target has no ordinary draft write")
        self.assertEqual(before, {k: self.value(k) for k in FIELDS})
        self.site.related_answers = ["lost"]
        self.insert()
        expect(self.notice()).to_contain_text("Result Unknown")
        self.assertEqual(1, len(self.site.related_puts))
        proposal = self.site.related_puts[0][1]
        request_id = proposal["relatedInsert"]["insertRequestId"]
        self.page.locator("#report-notice-check").click()
        expect(self.page.locator("#related-mode-target")).to_contain_text("Draft Saved")
        expect(self.notice()).to_be_hidden()
        self.assertEqual("applied", self.site.receipts[request_id]["state"])
        self.assertEqual(1, len(self.site.related_puts), "the receipt Check never repeats the insertion")
        self.assertEqual({k: proposal[k] for k in FIELDS}, self.stored())
        self.assertEqual([], [p for p in self.site.flow_puts if p[0] == UID_A])
        holds = self.b05_holds()
        self.page.clock.run_for(61000)
        self.wait(lambda: self.b05_holds() > holds, "the insertion's reading lease keeps renewing")
        self.back()
        self.page.locator("#b-save").dispatch_event("click")
        self.wait(lambda: len(self.site.flow_commits) == 1, "the explicit report save after Back")
        self.assertEqual(UID_A, self.site.flow_commits[0][0])
        self.wait(lambda: {k: self.site.store[UID_A]["report"][k] for k in FIELDS} == {k: proposal[k] for k in FIELDS},
                  "the saved report")
        self.wait(lambda: not self.js("commitInFlight"), "the save's answer")
        # A successful commit is a terminal lease boundary: no renewal before or after leaving.
        holds = self.b05_holds()
        self.page.clock.run_for(61000)
        self.settle()
        self.assertEqual(holds, self.b05_holds(), "a committed Target's lease is not renewed")
        self.b05_worklist(reading)
        self.open_target(UID_D)
        self.assertEqual("SYN retained off-target edit", self.value())
        self.page.clock.run_for(61000)
        self.settle()
        self.assertEqual(holds, self.b05_holds(), "leaving a committed Target cannot renew its completed lease")
        self.assertEqual({k: proposal[k] for k in FIELDS}, {k: self.site.store[UID_A]["report"][k] for k in FIELDS})

    def test_w5r3b05_synthetic_retained_nonselected_boundary_normal(self):
        self.b05_retained_boundary(False)

    def test_w5r3b05_synthetic_retained_nonselected_boundary_reading(self):
        self.b05_retained_boundary(True)

    # ADMIT-08: an uncommitted Target lease renews through the mode and is released once when the reader leaves.
    def b05_uncommitted_lease(self, reading):
        self.open()
        self.open_target(UID_A)
        if reading:
            self.enter_reading()
        self.page.locator("#findings").fill("SYN autosaved lease-preservation text")
        self.b05_autosaved(UID_A, "SYN autosaved lease-preservation text", "the ordinary autosave")
        self.wait(lambda: self.b05_holds() >= 1, "editing claims the Target lease")
        self.js("uid => enterRelatedMode(uid)", UID_B)
        expect(self.mode()).to_be_visible()
        self.wait(lambda: self.source_text("findings") == PRIOR_B["findings"], "the Source text")
        writes, holds = len(self.site.flow_puts), self.b05_holds()
        self.page.clock.run_for(61000)
        self.wait(lambda: self.b05_holds() > holds, "the uncommitted lease keeps renewing in the mode")
        self.assertEqual(writes, len(self.site.flow_puts), "the mode makes no ordinary Target write")
        self.assertEqual([], self.site.flow_commits, "an ordinary autosave is not a report commit")
        releases = self.b05_releases()
        self.back()
        self.b05_worklist(reading)
        self.open_target(UID_D)
        self.wait(lambda: self.b05_releases() == releases + 1, "leaving the uncommitted Target releases its lease once")
        holds = self.b05_holds()
        self.page.clock.run_for(61000)
        self.settle()
        self.assertEqual(holds, self.b05_holds(), "navigation stops the old Target's renewal")
        self.assertEqual(releases + 1, self.b05_releases())
        self.assertEqual("SYN autosaved lease-preservation text", self.site.stored_of(UID_A)["findings"])
        self.assertEqual([], self.site.flow_commits)

    def test_w5r3b05_uncommitted_lease_navigation_normal(self):
        self.b05_uncommitted_lease(False)

    def test_w5r3b05_uncommitted_lease_navigation_reading(self):
        self.b05_uncommitted_lease(True)

    # ADMIT-09: a received critical result's Acknowledge / Check Again kept from before the mode refuses in it, Back sends
    # nothing, and the reader's explicit click after Back acknowledges (or retries the same unknown request).
    def b05_received(self, reading, unknown=False):
        import critical_result_recipient_dom_test as recipient
        owner = [h.INSTITUTION, h.RAD["sub"]]
        server = recipient.RecipientServer(owner)
        record = server.add(recipient.rec(141, case="R2"))
        posts, held_retries = [], []

        def route(route, request):
            url = urlparse(request.url)
            query = parse_qs(url.query)
            if request.method == "POST":
                posts.append(request.post_data_json)
                if unknown:
                    if len(posts) == 1:
                        route.abort("connectionreset")
                        return
                    status, body = server.refuse(404, "CRITICAL_RESULT_NOT_FOUND")
                    held_retries.append((route, status, {**body, "message": "SYN ACK retry refused"}))
                    return
                status, body = server.ack(record["id"], request.post_data_json)
            elif query.get("view") == ["sent"]:
                status, body = 200, {"owner": owner, "view": "sent", "items": [], "nextCursor": None, "pending": 0}
            else:
                status, body = server.handle(recipient.kind_of(request.method, url.path), url.path, query, None)
            route.fulfill(status=status, json=body)

        self.context.route(re.compile(r".*/api/critical-results(?:[/?].*)?$"), route)
        self.open()
        self.open_target()
        pane = self.page.locator("#cvr-inbox-p")
        pane.get_by_role("button", name="Show Received", exact=True).click()
        ack = pane.get_by_role("button", name="Acknowledge", exact=True)
        expect(ack).to_be_visible()
        if unknown:
            ack.click()
            self.wait(lambda: len(posts) == 1, "the original ACK reached transport")
            control = pane.get_by_role("button", name="Check Again", exact=True)
            expect(control).to_be_visible()
        else:
            control = ack
        retained = control.element_handle()
        try:
            if reading:
                self.enter_reading()
            self.js("uid => enterRelatedMode(uid)", UID_B)
            expect(self.mode()).to_be_visible()
            self.js("""() => { window.b05Allocations = 0; const uuid = crypto.randomUUID.bind(crypto);
                crypto.randomUUID = () => { window.b05Allocations++; return uuid(); }; }""")
            retained.dispatch_event("click")
            self.settle(100)
            self.assertEqual(1 if unknown else 0, len(posts), "the mode sends no acknowledgement")
            self.assertEqual(0, self.js("window.b05Allocations"), "the mode allocates no request ID")
            self.assertTrue(retained.evaluate("e => e.disabled"))
            self.assertIn("Related Report", retained.get_attribute("title"))
            expect(pane).to_contain_text(MODE_REASON)
            # D1821: the list the reader opened lies over the report area (in body.reading it covers the mode's Back
            # button), so Back is the Report Editor key here, which is the same Back.
            self.page.keyboard.press("Control+Alt+4")
            expect(self.mode()).to_be_hidden()
            self.settle(100)
            self.assertEqual(1 if unknown else 0, len(posts), "Back does not acknowledge")
            retained.dispatch_event("click")
            self.wait(lambda: len(posts) == (2 if unknown else 1), "the explicit ACK after Back")
            if unknown:
                self.assertEqual(posts[0], posts[1], "Check Again resends the same request")
                self.assertEqual(1, len(held_retries))
                expect(pane.get_by_role("button", name="Check Again", exact=True)).to_be_disabled()
                held_route, held_status, held_body = held_retries.pop()
                held_route.fulfill(status=held_status, json=held_body)
                expect(pane).to_contain_text("SYN ACK retry refused")
                expect(pane).to_contain_text("Acknowledgement status unknown")
                expect(pane.get_by_role("button", name="Check Again", exact=True)).to_be_enabled()
            else:
                self.assertEqual(1, posts[0]["revision"], "the ACK names the revision the row showed")
                expect(pane).to_contain_text("Acknowledged")
        finally:
            retained.dispose()

    # W5B-REVIEW-01 / D1821 (Minhoon): the received Critical Results list opens as an overlay over the report area. Opening
    # it does not shrink the Related Report mode (its box keeps its place and size); the list is visible, on top at its
    # own centre, and Hide Received closes it with the mode unchanged.
    # The box inside its report column (the click on the toggle may scroll the column into view; that is not a resize).
    BOX = """selector => { const r = document.querySelector(selector).getBoundingClientRect(),
      p = document.querySelector(".report-p"), c = p.getBoundingClientRect();
      return [Math.round(r.top - c.top + p.scrollTop), Math.round(r.height)]; }"""
    ON_TOP = """selector => { const e = document.querySelector(selector), r = e.getBoundingClientRect();
      const x = r.left + r.width / 2, y = Math.max(r.top, 0) + Math.min(r.height, innerHeight) / 2;
      const hit = document.elementFromPoint(x, y); return !!hit && e.contains(hit); }"""

    def received_list_overlays_the_mode(self, reading):
        self.b05_cvr_page()
        self.open()
        self.open_target()
        if reading:
            self.enter_reading()
        self.enter()
        self.settle(200)
        before = self.js(self.BOX, "#related-mode")
        toggle = self.page.locator("#cvr-inbox-toggle")
        toggle.click()
        expect(toggle).to_have_text("Hide Received")
        body = self.page.locator("#cvr-inbox-body")
        expect(body).to_be_visible()
        self.settle(200)
        after = self.js(self.BOX, "#related-mode")
        self.assertGreaterEqual(after[1], before[1] - 1, f"the mode shrank when the list opened: {before} -> {after}")
        self.assertEqual(before[0], after[0], "the mode stays where it was in its column")
        body.scroll_into_view_if_needed()
        expect(body).to_be_in_viewport()
        self.assertTrue(self.js(self.ON_TOP, "#cvr-inbox-body"), "the opened list is drawn over the report area")
        expect(toggle).to_be_in_viewport()
        toggle.click()
        expect(body).to_be_hidden()
        expect(toggle).to_have_text("Show Received")
        self.settle(200)
        self.assertEqual(before, self.js(self.BOX, "#related-mode"), "closing the list gives the same mode")
        expect(self.mode()).to_be_visible()

    # D1822: what used to open the list by itself (here: the synthetic site does not answer the received-list read, the
    # S7-U2a failure) only marks the bar; the list stays closed and the report being written is never covered: Findings
    # and Approve are on top at their own centre, typing goes into Findings, and in the mode Insert and Back are on top and
    # work. The reader then opens the list with Show Received, which clears the mark.
    def self_opened_list_leaves_the_report_usable(self, reading):
        self.open()
        self.open_target()
        if reading:
            self.enter_reading()
        expect(self.page.locator("#cvr-inbox-p")).to_have_attribute("data-state", "failed")
        for selector in ("#findings", "#b-approve"):
            self.page.locator(selector).scroll_into_view_if_needed()
            self.assertTrue(self.js(self.ON_TOP, selector), f"{selector} is covered by the list that opened by itself")
        self.page.locator("#findings").fill("SYN typed under a self-opened list")
        self.assertEqual("SYN typed under a self-opened list", self.value())
        self.enter()
        for selector in ("#related-mode-insert", "#related-mode-back"):
            self.page.locator(selector).scroll_into_view_if_needed()
            self.assertTrue(self.js(self.ON_TOP, selector), f"{selector} is covered by the list that opened by itself")
        self.open_insert()
        self.page.locator("#related-insert-cancel").click()
        self.back()
        expect(self.page.locator("#findings")).to_be_focused()
        self.assertEqual("SYN typed under a self-opened list", self.value())
        expect(self.page.locator("#cvr-inbox-p")).to_have_attribute("data-attention", "true")
        expect(self.page.locator("#cvr-inbox-body")).to_be_hidden()
        self.page.locator("#cvr-inbox-toggle").click()
        expect(self.page.locator("#cvr-inbox-body")).to_be_visible()
        expect(self.page.locator("#cvr-inbox-p")).not_to_have_attribute("data-attention", "true")

    def test_w5b_self_opened_list_leaves_the_report_usable_normal(self):
        self.self_opened_list_leaves_the_report_usable(False)

    def test_w5b_self_opened_list_leaves_the_report_usable_reading(self):
        self.self_opened_list_leaves_the_report_usable(True)

    def test_w5b_received_list_overlays_the_mode_normal(self):
        self.received_list_overlays_the_mode(False)

    def test_w5b_received_list_overlays_the_mode_reading(self):
        self.received_list_overlays_the_mode(True)

    # Minhoon 2-2 / PR238 F1-F7: real served-page arrivals and native pointer/keyboard input.
    # These are the reviewer's four viewport sizes, each in normal and reading layouts.
    ARRIVAL_VIEWPORTS = ((1400, 900), (1366, 768), (1920, 1080), (1080, 1920))
    CARET_VISIBLE = r"""(id) => {
      const ta = document.getElementById(id), s = getComputedStyle(ta), mirror = document.createElement('div');
      for (const name of ['boxSizing', 'paddingTop', 'paddingLeft', 'paddingRight', 'paddingBottom', 'borderTopWidth',
        'borderLeftWidth', 'borderRightWidth', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize'])
        mirror.style[name] = s[name];
      Object.assign(mirror.style, {position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word', width: ta.getBoundingClientRect().width + 'px', left: '0', top: '0'});
      mirror.textContent = ta.value.slice(0, ta.selectionEnd);
      const end = document.createElement('span'); end.textContent = '\u200b'; mirror.append(end); document.body.append(mirror);
      const r = ta.getBoundingClientRect(), line = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.2;
      const x = r.left + end.offsetLeft + 1 - ta.scrollLeft, y = r.top + end.offsetTop - ta.scrollTop + line / 2;
      mirror.remove();
      return document.elementFromPoint(x, y) === ta;
    }"""

    def install_arrivals(self, records=()):
        import critical_result_recipient_dom_test as recipient
        owner = [h.INSTITUTION, h.RAD["sub"]]
        self.arrival_server = recipient.RecipientServer(owner)
        self.arrival_server.add(*records)
        self.arrival_reads, self.arrival_posts = [], []
        pattern = re.compile(r".*/api/critical-results(?:[/?].*)?$")
        self.context.unroute(pattern)

        def received(route, request):
            url = urlparse(request.url)
            query = parse_qs(url.query)
            if request.method == "POST":
                self.arrival_posts.append(request.post_data_json)
            if query.get("view") == ["sent"]:
                status, body = 200, {"owner": owner, "view": "sent", "items": [], "nextCursor": None, "pending": 0}
            else:
                status, body = self.arrival_server.handle(recipient.kind_of(request.method, url.path), url.path, query,
                                                        request.post_data_json)
                self.arrival_reads.append(body)
            route.fulfill(status=status, json=body)

        self.context.route(pattern, received)
        return recipient

    def poll_arrivals(self):
        count = len(self.arrival_reads)
        self.page.clock.fast_forward(60000)
        self.wait(lambda: len(self.arrival_reads) > count, "the page polls received reports")
        self.settle()

    def visible_arrival(self, n):
        row = self.page.get_by_role("listitem").filter(has_text=f"SYN-PT-{n}")
        expect(row).to_have_count(1)
        # Text in a clipped DOM node is insufficient: the heading, identity and action must actually be on screen.
        for part in (row.get_by_text("Pending ACK", exact=True), row.get_by_text(re.compile(f"^Patient: SYN-PT-{n}")),
                     row.get_by_role("button", name="Acknowledge", exact=True)):
            self.assertTrue(part.evaluate("""e => {
              const r = e.getBoundingClientRect();
              return [0.25, 0.5, 0.75].every(f => {
                const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height * f);
                return hit && e.contains(hit);
              });
            }"""), f"arrival {n}: {part} is clipped or covered")

    def arrival_preserves_the_draft(self, reading):
        for width, height in self.ARRIVAL_VIEWPORTS:
            for field in ("findings", "conclusion"):
                with self.subTest(viewport=(width, height), reading=reading, field=field):
                    self.page.set_viewport_size({"width": width, "height": height})
                    recipient = self.install_arrivals()
                    self.open()
                    self.open_target()
                    if reading:
                        self.enter_reading()
                    body = self.page.locator("#cvr-inbox-body")
                    expect(body).to_be_hidden()
                    findings = self.page.locator("#findings")
                    findings.fill("\n".join(f"SYN finding line {i}" for i in range(30)))
                    self.page.locator("#conclusion").fill("SYN impression line 1\nSYN impression line 2")
                    self.autosave()
                    target = self.page.locator("#" + field)
                    target.click()
                    self.page.keyboard.press("Control+End")
                    self.assertTrue(self.js(self.CARET_VISIBLE, field), "caret is visible before arrival")
                    snapshot = """() => ({uid: selectedUid, fields: ['findings', 'conclusion', 'recommendation'].map(id => {
                      const e = document.getElementById(id); return [e.value, e.selectionStart, e.selectionEnd, e.selectionDirection,
                        e.scrollTop, e.scrollLeft]; }), active: document.activeElement.id,
                      scroll: [scrollX, scrollY, document.querySelector('.report-p').scrollTop]})"""
                    before, box = self.js(snapshot), self.js(self.BOX, ".redit")
                    self.arrival_server.add(recipient.rec(181, case="R2"))
                    self.poll_arrivals()
                    expect(body).to_be_visible()
                    self.visible_arrival(181)
                    self.assertEqual(before, self.js(snapshot), "arrival keeps draft, selection, focus and scroll")
                    self.assertEqual(box, self.js(self.BOX, ".redit"), "arrival does not move or resize the editor")
                    self.assertTrue(self.js(self.CARET_VISIBLE, field), "arrival leaves the typing line visible")
                    value = target.input_value()
                    self.page.keyboard.type(" typed")
                    self.assertEqual(value + " typed", target.input_value())
                    self.assertTrue(self.js(self.CARET_VISIBLE, field))
                    self.arrival_server.add(recipient.rec(182, case="R2"))
                    after_typing = self.js(snapshot)
                    self.poll_arrivals()
                    self.visible_arrival(182)
                    expect(body).to_have_count(1)
                    self.assertEqual(after_typing, self.js(snapshot), "another arrival reuses the overlay without taking focus")
                    # Actual mouse close followed by actual typing, including Space. No programmatic refocus.
                    close = self.page.get_by_role("button", name="Hide Received", exact=True).bounding_box()
                    self.page.mouse.click(close["x"] + close["width"] / 2, close["y"] + close["height"] / 2)
                    expect(body).to_be_hidden()
                    expect(target).to_be_focused()
                    self.page.keyboard.type(" and more text")
                    self.assertEqual(value + " typed and more text", target.input_value())
                    expect(body).to_be_hidden()
                    self.poll_arrivals()
                    expect(body).to_be_hidden()
                    self.arrival_server.records.pop(recipient.rid(182))
                    self.arrival_server.add(recipient.rec(183, case="R2"))
                    before_reopen = self.js(snapshot)
                    self.poll_arrivals()
                    self.visible_arrival(183)
                    self.assertEqual(before_reopen, self.js(snapshot), "a same-count arrival keeps the doctor's place")
                    self.assertEqual(box, self.js(self.BOX, ".redit"))
                    self.page.keyboard.press("Escape")
                    expect(body).to_be_hidden()
                    expect(target).to_be_focused()
                    self.page.keyboard.type(" after escape")
                    self.assertEqual(value + " typed and more text after escape", target.input_value())
                    self.arrival_server.add(recipient.rec(184, case="R2"))
                    self.poll_arrivals()
                    expect(body).to_be_visible()
                    self.page.keyboard.press("Tab")
                    expect(body).to_be_hidden()
                    self.assertTrue(self.js("""() => {
                      const e = document.activeElement, r = e.getBoundingClientRect();
                      return e.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
                    }"""), "native Tab reaches an uncovered control")
                    self.assertEqual([], self.arrival_posts, "displaying or closing an arrival never acknowledges it")

    def test_w5b_arrival_preserves_the_draft_normal(self):
        self.arrival_preserves_the_draft(False)

    def test_w5b_arrival_preserves_the_draft_reading(self):
        self.arrival_preserves_the_draft(True)

    def test_w5b_arrival_close_keeps_the_selection_made_while_open(self):
        recipient = self.install_arrivals()
        self.open()
        self.open_target()
        target = self.page.locator("#findings")
        target.fill("SYN before arrival")
        self.autosave()
        target.click()
        self.page.keyboard.press("Control+End")
        self.arrival_server.add(recipient.rec(181, case="R2"))
        self.poll_arrivals()
        self.page.keyboard.type(" and continuing\nSYN next line")
        self.assertTrue(self.js(self.CARET_VISIBLE, "findings"), "new lines remain visible while typing")
        for _ in "line":
            self.page.keyboard.press("Shift+ArrowLeft")
        before = target.evaluate("e => [e.value, e.selectionStart, e.selectionEnd, e.selectionDirection]")
        self.page.get_by_role("button", name="Hide Received", exact=True).click()
        expect(target).to_be_focused()
        self.assertEqual(before, target.evaluate("e => [e.value, e.selectionStart, e.selectionEnd, e.selectionDirection]"))
        self.page.keyboard.type("word")
        self.assertEqual(before[0][:before[1]] + "word" + before[0][before[2]:], target.input_value())

    def test_w5b_arrival_keeps_dialog_then_related_mode_escape_priority(self):
        for reading in (False, True):
            with self.subTest(reading=reading):
                recipient = self.install_arrivals()
                self.open()
                self.open_target()
                if reading:
                    self.enter_reading()
                self.page.locator("#findings").fill("SYN draft retained")
                self.autosave()
                self.enter()
                self.open_insert()
                focused = self.js("document.activeElement.id")
                before = self.js(self.BOX, "#related-mode")
                self.arrival_server.add(recipient.rec(181, case="R2"))
                self.poll_arrivals()
                self.assertEqual(focused, self.js("document.activeElement.id"))
                self.assertEqual(before, self.js(self.BOX, "#related-mode"))
                self.assertTrue(self.js(self.ON_TOP, "#related-insert-confirm"))
                self.page.keyboard.press("Escape")
                expect(self.page.locator("#related-insert-dialog")).to_be_hidden()
                expect(self.mode()).to_be_visible()
                expect(self.page.locator("#cvr-inbox-body")).to_be_visible()
                self.page.keyboard.press("Escape")
                expect(self.mode()).to_be_hidden()
                expect(self.page.locator("#findings")).to_be_focused()
                self.assertEqual("SYN draft retained", self.value())
                expect(self.page.locator("#cvr-inbox-body")).to_be_visible()
                self.page.keyboard.press("Escape")
                expect(self.page.locator("#cvr-inbox-body")).to_be_hidden()
                self.assertEqual([], self.arrival_posts)

    def test_w5b_load_is_not_arrival_and_newest_uses_previous_poll(self):
        import critical_result_recipient_dom_test as recipient
        for full in (True, False):
            with self.subTest(full=full):
                self.install_arrivals([recipient.rec(150, case="R2" if full else "R3", full=full)])
                self.open()
                self.poll_arrivals()
                body = self.page.locator("#cvr-inbox-body")
                expect(body).to_be_hidden()
                self.page.reload()
                self.poll_arrivals()
                expect(body).to_be_hidden()
                self.page.get_by_role("button", name="Show Received", exact=True).click()
                self.page.get_by_role("region", name="Critical Results Details", exact=True).get_by_role("button", name="Show All", exact=True).click()
                self.settle()
                self.page.get_by_role("button", name="Hide Received", exact=True).click()
                # Same pending count: an old pending leaves, while a pending and a still newer cancelled record arrive.
                self.arrival_server.records[recipient.rid(150)].update(state="cancelled", revision=2,
                    cancelledAt=recipient.iso(151), cancelReason="SYN old cancelled")
                self.arrival_server.add(recipient.rec(161, case="R2"), recipient.rec(162, case="R2", state="cancelled",
                    cancelledAt=recipient.iso(163), cancelReason="SYN newest cancelled"))
                self.poll_arrivals()
                expect(body).to_be_visible()
                self.visible_arrival(161)
                self.page.get_by_role("button", name="Hide Received", exact=True).click()
                self.poll_arrivals()
                expect(body).to_be_hidden()
                self.assertEqual([], self.arrival_posts)

    # W5B-REVIEW-02: the worklist's own ways to the report editor (Enter on the current row, its keyboard activation, the
    # row menu's 판독문 작성으로) are Report Editor in the mode too: the mode closes and the editor returns with the
    # Target, its text and its caret, as Ctrl+Alt+4 does.
    def editor_entry_in_the_mode(self, act):
        self.open()
        self.open_target()
        self.page.locator("#findings").fill("SYN A kept for the editor entry")
        self.page.locator("#findings").evaluate("node => node.setSelectionRange(5, 9)")
        self.autosave()
        self.enter()
        act()
        expect(self.mode()).to_be_hidden()
        expect(self.page.locator("#findings")).to_be_focused()
        self.assertEqual([False, False], self.editor_hidden())
        self.assertEqual((UID_A, "SYN A kept for the editor entry"), (self.js("selectedUid"), self.value()))
        self.assertEqual([5, 9], self.js("[$('#findings').selectionStart, $('#findings').selectionEnd]"))

    def test_w5b_row_menu_report_editor_leaves_the_mode(self):
        def act():
            self.page.locator(f'#rows tr[data-uid="{UID_A}"]').click(button="right")
            self.page.locator("#ctx [data-i]", has_text="판독문 작성으로").click()
        self.editor_entry_in_the_mode(act)

    def test_w5b_enter_on_the_current_row_leaves_the_mode(self):
        def act():
            self.page.locator(f'#rows tr[data-uid="{UID_A}"]').click()
            self.page.keyboard.press("Enter")
        self.editor_entry_in_the_mode(act)

    def test_w5r3b05_received_normal(self):
        self.b05_received(False)

    def test_w5r3b05_received_reading(self):
        self.b05_received(True)

    def test_w5r3b05_received_unknown_normal(self):
        self.b05_received(False, True)

    def test_w5r3b05_received_unknown_reading(self):
        self.b05_received(True, True)

    # Complete-page sender parity: a send/cancel/supersede input opened before the mode survives the mode's repaints,
    # its confirmation refuses before any request ID, Back sends nothing, and the explicit confirmation after Back sends
    # the retained input once (the synthetic server refuses it, so the outcome is a displayed refusal).
    def b05_cvr_page(self):
        self.b05_posts, self.b05_hold_candidates, self.b05_held_candidates = [], False, []
        self.context.add_init_script("""(() => {
          const old = crypto.randomUUID.bind(crypto);
          window.b05UuidCount = 0;
          crypto.randomUUID = () => { window.b05UuidCount++; return old(); };
        })();""")
        self.site.store[UID_A]["report"] = {"version": 1, "rs": "T", "findings": "SYN Target report",
                                            "conclusion": "", "recommendation": ""}
        owner = [h.INSTITUTION, h.RAD["sub"]]
        source = {"version": 1, "action": "save", "author": h.RAD["actor"], "at": "2026-09-01T10:00:00.000Z", "final": False}
        item = {"id": self.B05_RID, "studyUid": UID_A, "state": "created", "revision": 1, "createdAt": source["at"],
                "replacedBy": None, "supersedes": None, "view": "sender",
                "recipient": {k: self.B05_RECIPIENT[k] for k in ("actor", "name", "role")},
                "study": {"uid": UID_A, "name": ALPHA, "id": "SYN-P-001", "birth": "19600101", "date": "20261003"},
                "message": "SYN earlier message", "source": {**source, "current": True, "reason": None},
                "delivery": "readable", "acknowledgedAt": None, "cancelledAt": None, "supersededAt": None, "cancelReason": None}

        def cvr(route, request):
            parsed = urlparse(request.url)
            if request.method == "POST":
                self.b05_posts.append({"path": parsed.path, "body": request.post_data_json})
                return route.fulfill(status=404, json={"code": "CRITICAL_RESULT_NOT_FOUND", "message": "SYN definitive refusal"})
            if parsed.path.endswith("/critical-result-recipients"):
                answer = {"owner": owner, "uid": parsed.path.split("/")[-2], "sendable": True, "reason": None,
                          "source": source, "recipients": [self.B05_RECIPIENT]}
                if self.b05_hold_candidates:
                    self.b05_held_candidates.append((route, answer))
                    return
                return route.fulfill(json=answer)
            if parsed.path.endswith("/critical-results"):
                received = parse_qs(parsed.query).get("view") == ["received"]
                return route.fulfill(json={"owner": owner, "view": "received" if received else "sent",
                                           "items": [] if received else [item], "nextCursor": None,
                                           "pending": 0 if received else 1})
            return route.fulfill(status=404, json={"code": "CRITICAL_RESULT_NOT_FOUND", "message": "SYN absent read"})

        self.context.route(re.compile(r".*/api/(?:studies/[^/]+/critical-result(?:-recipients|s)|critical-results)(?:[/?].*)?$"), cvr)

    def b05_sender_parity(self, action, reading=False, held=False):
        self.b05_cvr_page()
        self.open()
        self.open_target()
        self.wait(lambda: not self.page.locator("#b-mark-cvr").is_disabled(), "Mark CVR ready")
        if reading:
            self.enter_reading()
        row = self.page.locator(f'#cvr-sent-rows tr[data-id="{self.B05_RID}"]')
        form = self.page.locator(f'#cvr-sent-rows tr[data-form="{self.B05_RID}"]')
        label = {"create": "Send", "cancel": "Cancel Delivery", "supersede": "Supersede"}[action]
        if action == "create":
            self.page.locator("#report-more").click()
            self.page.locator("#b-mark-cvr").click()
            self.page.locator("#cvr-send-recipient").select_option(self.B05_RECIPIENT["sub"])
            field, confirm = self.page.locator("#cvr-send-message"), self.page.locator("#cvr-send-submit")
        else:
            self.page.get_by_role("button", name="Show Sent", exact=True).click()
            expect(row).to_be_visible()
            self.b05_hold_candidates = held
            row.get_by_role("button", name=label, exact=True).click()
            field, confirm = form.locator("textarea"), form.get_by_role("button", name=label, exact=True)
            if held:
                self.wait(lambda: bool(self.b05_held_candidates), "the candidate read held before the mode")
        field.fill("SYN retained full-page input")
        retained = field.element_handle()
        try:
            if not held:
                expect(confirm).to_be_enabled()
            before = self.js("window.b05UuidCount")
            self.js("uid => enterRelatedMode(uid)", UID_B)
            expect(self.mode()).to_be_visible()
            # The mode's deliberate title focus is PAGE-01's; a repaint after this explicit focus must keep it.
            field.focus()
            for route, answer in self.b05_held_candidates:
                route.fulfill(json=answer)
            self.b05_held_candidates.clear()
            self.b05_hold_candidates = False
            if held:
                # The late Source answer lands inside the mode: it must not enable the confirmation by itself (before any
                # later list repaint could hide that).
                self.settle(100)
                expect(confirm).to_be_disabled()
                self.assertEqual(self.B05_REASON_WITH_BACK, confirm.get_attribute("title"))
            if action != "create":
                self.page.locator("#cvr-sent-refresh").dispatch_event("click")
            self.settle(100)
            self.assertTrue(retained.evaluate("e => e.isConnected"), "the preopened input survives the mode/read repaint")
            self.assertTrue(retained.evaluate("e => document.activeElement === e"), "the repaint keeps the focused input")
            confirm.dispatch_event("click")
            self.settle(100)
            self.assertEqual(before, self.js("window.b05UuidCount"), "a blocked confirmation creates no attempt ID")
            self.assertEqual([], self.b05_posts, "a blocked confirmation never transmits")
            expect(field).to_have_value("SYN retained full-page input")
            expect(confirm).to_be_disabled()
            self.assertEqual(self.B05_REASON_WITH_BACK, confirm.get_attribute("title"))
            box = self.page.locator("#cvr-send" if action == "create" else "#cvr-sent-p")
            expect(box.get_by_text(self.B05_REASON_WITH_BACK, exact=True).first).to_be_visible()
            outcome = self.page.locator("#cvr-send-status" if action == "create" else "#cvr-sent-attempts")
            for word in ("Delivered", "Not delivered", "Not cancelled", "status unknown", "Cancelled"):
                self.assertNotIn(word, outcome.inner_text(), "a blocked confirmation shows no outcome")
            # Back is the mode's own control; the modal Send dialog covers it, so it is activated as a DOM click.
            self.page.locator("#related-mode-back").dispatch_event("click")
            expect(self.mode()).to_be_hidden()
            self.settle(50)
            self.assertEqual([], self.b05_posts, "Back never sends")
            self.assertEqual(before, self.js("window.b05UuidCount"), "Back never allocates a request")
            expect(confirm).to_be_enabled()
            confirm.click()
            self.wait(lambda: len(self.b05_posts) == 1, "the explicit confirmation after Back")
            post = self.b05_posts[0]
            path = (f"/api/studies/{UID_A}/critical-results" if action == "create"
                    else f"/api/critical-results/{self.B05_RID}/{action}")
            self.assertEqual(path, post["path"])
            self.assertEqual("SYN retained full-page input", post["body"]["reason" if action == "cancel" else "message"])
            self.assertTrue(UUID.match(post["body"]["requestId"]))
            refused = self.page.locator("#cvr-send-status" if action == "create" else "#cvr-sent-attempts li")
            expect(refused).to_be_visible()
            expect(refused).to_contain_text("Not cancelled" if action == "cancel" else "Not delivered")
            expect(refused).to_contain_text("SYN definitive refusal")
            expect(refused).to_contain_text("CRITICAL_RESULT_NOT_FOUND")
        finally:
            retained.dispose()

    def test_w5r3b05_sender_create_normal(self):
        self.b05_sender_parity("create")

    def test_w5r3b05_sender_create_reading(self):
        self.b05_sender_parity("create", reading=True)

    def test_w5r3b05_sender_cancel_normal(self):
        self.b05_sender_parity("cancel")

    def test_w5r3b05_sender_cancel_reading(self):
        self.b05_sender_parity("cancel", reading=True)

    def test_w5r3b05_sender_supersede_normal(self):
        self.b05_sender_parity("supersede")

    def test_w5r3b05_sender_supersede_reading(self):
        self.b05_sender_parity("supersede", reading=True)

    def test_w5r3b05_sender_supersede_late_source_normal(self):
        self.b05_sender_parity("supersede", held=True)

    def test_w5r3b05_sender_supersede_late_source_reading(self):
        self.b05_sender_parity("supersede", reading=True, held=True)


def run_mutants():
    from related_report_mode_mutants import run
    return run()


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    args = sys.argv[1:]
    if args == ["--mutants"]:
        return run_mutants()
    names = args or unittest.defaultTestLoader.getTestCaseNames(RelatedModePage)
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(RelatedModePage(n) for n in names))
    print("W5-UI-DOM-SERVED " + json.dumps(sorted(h.SERVED)), flush=True)
    return 0 if result.wasSuccessful() and not result.skipped else 1


if __name__ == "__main__":
    raise SystemExit(main())
