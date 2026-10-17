# coding: utf-8
"""W5-PAGE-01..10, the client side of W5-API-02/03 -> RISK-WS2/WS4/WS5/WS7 -> TEST W5 Related Report mode (delivered page).

Design v5 section 1 (D1244: "이전 판독문 보며 쓰기" required), the O4 answer D1423 (R1 receipt, R2 one native edit under a
one-shot admission, R3 the operation outlives the mode, R6 three generations) and the W5-API wire contract (02c8a87 report
`wire_contract`, the r1 review's `handover_to_w5_ui`, #180's identity codes) as the D1473 addendum reads them.

The page is the delivered split page: main.html, its bundle and every shipped asset, against a synthetic origin. W5-UI
Phase A (D1477/D1480): main.html does not yet tag the mode's asset, so the page under test is the delivered main.html with
the insertions of tests/fixtures/w5-ui/related-mode-page.json applied (the exact bytes Phase B writes into main.html), served
through the **/main.html route the W4 mutant composer uses; the mode's two new files are served from the tree by a static()
override beside the logout suite's allowlist. Phase B deletes both (PH2.4). Nothing here edits a product file.

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
from urllib.parse import parse_qs

import auth_logout_dom_test as h
import report_flow_dom_test as rf
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
LITE = ROOT / "worklist-v0/hpacs-lite"
FIXTURE = ROOT / "tests/fixtures/w5-ui/related-mode-page.json"
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
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def compose_page(text=None):
    """The delivered main.html with the Phase B insertions; every anchor must match exactly once (else setup fails)."""
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    html = text if text is not None else (ROOT / fixture["page"]).read_text(encoding="utf-8")
    for item in fixture["insertions"]:
        if html.count(item["anchor"]) != 1:
            raise AssertionError("W5 page fixture anchor does not match exactly once: " + item["anchor"][:80])
        html = html.replace(item["anchor"], item["anchor"] + item["text"], 1)
    return html


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
        return {"owner": h.owner_of(account), "uid": uid, **rest, "citationIds": sorted(body["citationIds"]),
                "structureIds": sorted(body["structureIds"]), "relatedInsert": ri}

    @staticmethod
    def proposal_row(body):
        return {**{k: body[k] for k in FIELDS}, "baseVersion": body["baseVersion"],
                "citations": list(body["citationIds"]), "structured": list(body["structureIds"])}

    def matches(self, uid, rec):
        return (rec["state"] == "applied" and self.revision_of(uid) == rec["appliedRevision"]
                and self.store[uid]["row"] == rec["row"])

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
        if not isinstance(text, str) or "\r" in text or not text.strip("\n") or not isinstance(offset, int):
            return self.invalid("text")
        if body[section][offset:] != text:
            return self.invalid("offset")
        if ri["intent"] == "discard" and not isinstance(ri.get("expectedReceiptRevision"), int):
            return self.invalid("expectedReceiptRevision")
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
        if reason is None and body["expectedRevision"] != self.revision_of(uid):
            reason = "DRAFT_CONFLICT"
        if reason is None:
            row = self.store[uid]["row"]
            seed = {**{k: body[k] for k in FIELDS}, section: body[section][:offset]}
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
                parts = src.get("parts") or []
                blocks = [head[p["field"]].replace("\r\n", "\n")[p["start"]:p["end"]] for p in parts]
                prefix = "" if offset == 0 or body[section][:offset].endswith("\n") else "\n"
                if prefix + "\n\n".join(blocks) != text:
                    return self.invalid("text")
        if reason is not None:
            if rec is None:
                rec = {"id": rid, "binding": binding, "requestHash": sha(binding), "proposalHash": sha(self.proposal_row(body)),
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
        rec = rec or {"id": rid, "binding": binding, "requestHash": sha(binding), "proposalHash": sha(self.proposal_row(body)),
                      "expectedRevision": body["expectedRevision"], "receiptRevision": 1}
        rec.update(state="applied", reason=None, appliedRevision=self.revision_of(uid), row=dict(st["row"]))
        self.receipts[rid] = rec
        return 200, {**env(), "relatedInsert": self.receipt_view(uid, rec)}

    def related_check(self, uid, rid, account):
        rec = self.receipts.get(rid)
        if rec is not None and rec["binding"]["owner"] != h.owner_of(account):
            view = {**self.receipt_view(uid, None, rid), "reason": "ID_REUSED"}
        else:
            view = self.receipt_view(uid, rec, rid)
        return 200, {**self.envelope_of(uid, account), "relatedInsert": view}

    def api(self, route, request, method, path, query):
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

    def static(self, route, path):
        # Phase A only (PH1.4): the mode's two files are not in the logout suite's allowlist until main.html tags them.
        name = path[len(h.BASE):] if path.startswith(h.BASE) else None
        if name in ("related-report-mode.js", "related-report-mode.css"):
            h.SERVED.add("worklist-v0/hpacs-lite/" + name)
            return route.fulfill(status=200, content_type=h.TYPES[Path(name).suffix], body=(LITE / name).read_bytes())
        return super().static(route, path)


# One Ctrl+Z / Ctrl+Shift+Z in the focused field, as the keyboard sends it (native history).
class RelatedModePage(unittest.TestCase):
    """REQ W5-PAGE-01..10 on the delivered split page with the Phase B markup; only HTTP is synthetic."""
    bundle_source = None
    html_source = None       # a mutant's main.html (already composed)
    asset_source = None      # (file, body): one shipped asset outside the bundle served as a one-off copy
    viewport = {"width": 1400, "height": 900}

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        cls.page_html = compose_page()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = W5Site()
        self.context = self.browser.new_context(viewport=self.viewport, locale="ko-KR", timezone_id="Asia/Seoul")
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
        html = self.html_source if self.html_source is not None else self.page_html
        self.context.route("**/main.html", lambda route: route.fulfill(body=html, content_type="text/html; charset=utf-8"))
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
                      "READ ONLY"):
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
        self.page.keyboard.press("Control+Alt+3")
        self.settle()
        expect(self.mode()).to_be_hidden()        # Back returned the Viewed Study to the Target: nothing to open
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
