# coding: utf-8
"""W9UI-V (order 01-multi-study-view.md) -> V-ENTRY / V-RESOLVE / V-PAGES / V-WINDOW / V-DISPLAY / V-REPORT / V-LIFECYCLE
-> TEST W9 Multi-Study View on the delivered page.

The page is the delivered split page: the checkout's unmodified main.html, its generated bundle and every asset they
reference (multi-study-view.js/.css included), served by the logout suite's static handler from its allowlist against a
synthetic origin (auth_logout_dom_test.Site through the W4 FlowSite). Nothing here edits a product file, composes a page,
injects markup or adds a script tag.

What is synthetic, and only that:
  - SYNTHETIC RESOLVE: POST /api/studies/viewing-set/resolve is answered at the HTTP boundary by W9Site in the W9-API wire
    shape (ab531c5 multi-study-view.service.ts: ready / partial / rejected members, codes, 503 W9_AUDIT_UNAVAILABLE). The
    bound product returns 503 for any ready member until Module A binds ViewingSetAccess, so every ready answer here is
    SYNTHETIC; tests/e2e/test_multi_study_view.py meets the real server.
  - SYNTHETIC VIEWER: /ohif/viewer is a stand-in document carrying the four workspace-state hooks the launcher reads
    (owner, annotation/job state, Frame Coverage confirm), so the launcher's own guards decide each navigation. The URL
    the page navigates to is the product's. The stand-in posts nothing by itself: the display cases post the viewer half of
    the channel protocol (`kin-w9:<opening>`) themselves, labelled SYNTHETIC VIEWER EVENT. The real renderer observer
    (viewer-multi-study.js on the real OHIF) is the e2e suite's.
  - A popup-blocking browser (window.open answering null) is the browser API stubbed by an init script, like the logout
    suite's clipboard.
Every member answer, request body and window URL is read from the wire or the browser, never from page internals; page
state is read only through what a person sees (the host's text, buttons, the row selection) and the public W4 selection.
"""
import json
import re
import sys
import time
import unittest
from urllib.parse import parse_qs, urlparse

import auth_logout_dom_test as h
import report_flow_dom_test as rf
from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
UID_E = "1.2.826.0.1.3680043.10.7707.5"
UID_F = "1.2.826.0.1.3680043.10.7707.6"
ALPHA, OTHER = "SYN PATIENT ALPHA", "SYN PATIENT OMEGA"
# (uid, name, patient id, date, modality, description, accession) - five studies of one patient, one of another.
W9_STUDIES = (
    (h.UID, ALPHA, "SYN-P-001", "20261005", "CT", "SYN CT CHEST 5", "SYNACC05"),
    (h.UID_B, ALPHA, "SYN-P-001", "20261004", "CT", "SYN CT CHEST 4", "SYNACC04"),
    (rf.UID_C, ALPHA, "SYN-P-001", "20261003", "MR", "SYN MR BRAIN 3", "SYNACC03"),
    (rf.UID_D, ALPHA, "SYN-P-001", "20261002", "CT", "SYN CT CHEST 2", "SYNACC02"),
    (UID_E, ALPHA, "SYN-P-001", "20261001", "CR", "SYN CR CHEST 1", "SYNACC01"),
    (UID_F, OTHER, "SYN-P-009", "20261001", "CT", "SYN CT OTHER", "SYNACC09"),
)
KEY = h.INSTITUTION + "|SYN-P-001"
UUID4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
BODY_KEYS = ["compositionId", "expectedSourcePatientKey", "generation", "requestId", "studyUids"]
# The page's own words for the states this file reads (compared, never parsed).
AUDIT = "열람 기록을 저장하지 못했습니다. 잠시 후 Retry로 다시 시도하세요."
GENERIC = "검사 정보를 확인하지 못했습니다. 잠시 후 Retry로 다시 시도하세요."
MISMATCH = "원본 환자 ID가 다른 검사는 함께 열 수 없습니다. 선택 목록을 확인하세요."
MEMBER_LF = "이 검사의 영상을 불러오지 못했습니다. Retry로 다시 시도하세요."
MODE_REASON = "Related Report 모드에서는 쓸 수 없습니다"
BUSY = "기존 영상 창에 저장하지 않은 표식이나 작업 내용"
POPUP_BLOCKED = "영상 창이 차단되었습니다."
NO_POPUP = """(() => { const open = window.open.bind(window);
  window.__synBlockPopups = false;
  window.open = (...args) => window.__synBlockPopups ? null : open(...args); })();"""
# SYNTHETIC VIEWER: the workspace-state hooks the launcher reads before replacing a viewer (viewer-launch.js
# ohifPopupState / kinViewerFrameCoverageConfirm). `__synDirty` stands for unsaved viewer work.
VIEWER_STAND_IN = """<!doctype html><title>SYN viewer stand-in</title><body><p>SYN viewer</p>
<script>window.__synDirty=false;window.kinViewerWindowOwner=()=>%s;
window.kinViewerHistoryWorkspaceState=()=>({busy:false,dirty:window.__synDirty});
window.kinViewerJobWorkspaceState=()=>({busy:false,dirty:false});window.kinViewerFrameCoverageConfirm=()=>true;</script></body>"""


class W9Site(rf.FlowSite):
    """The W4 flow site with one patient's five studies (and one other patient's) and the W9 resolve wire."""

    def __init__(self):
        super().__init__(1)
        self.flow = tuple((uid, name, patient) for uid, name, patient, *_ in W9_STUDIES)
        self.meta = {uid: {"date": date, "modality": modality, "desc": desc, "acc": acc, "id": patient, "name": name}
                     for uid, name, patient, date, modality, desc, acc in W9_STUDIES}
        self.store = {uid: {"revs": 0, "row": None, "report": {"version": 0, "rs": "W"}} for uid, _, _ in self.flow}
        self.resolves, self.resolve_answers, self.held_resolves = [], [], []
        self.viewer_loads, self.viewer_owner = [], None

    def list_body(self, account, rename=None):
        body = super().list_body(account, rename)
        for row in body["studies"]:
            m = self.meta[row["uid"]]
            row.update(date=m["date"], modality=m["modality"], desc=m["desc"], acc=m["acc"], id=m["id"], name=m["name"],
                       sourcePatientKey=h.INSTITUTION + "|" + m["id"])
        return body

    def handle(self, route, request):
        if urlparse(request.url).path == "/ohif/viewer":
            self.viewer_loads.append(request.url)
            return route.fulfill(body=VIEWER_STAND_IN % json.dumps(self.viewer_owner),
                                 content_type="text/html; charset=utf-8")
        return super().handle(route, request)

    def reply(self, body, spec):
        """SYNTHETIC RESOLVE in the W9-API wire shape. spec: 'ready', {uid: code} (those members fail), 'malformed', or a
        (status, body) refusal."""
        if isinstance(spec, tuple):
            return spec
        errors = spec if isinstance(spec, dict) else {}
        members = []
        for ordinal, uid in enumerate(body["studyUids"]):
            if uid in errors:
                members.append({"uid": uid, "ordinal": ordinal, "status": "error", "code": errors[uid]})
                continue
            m = self.meta[uid]
            members.append({"uid": uid, "ordinal": ordinal, "status": "ready", "accessRef": f"SYN-REF-{body['requestId']}-{ordinal}",
                            "metadata": {"patientId": m["id"], "patientName": m["name"], "institutionName": "SYN Hospital A",
                                         "studyDate": m["date"], "modalities": [m["modality"]], "description": m["desc"],
                                         "accession": m["acc"]}})
        ready = [m for m in members if m["status"] == "ready"]
        answer = {"compositionId": body["compositionId"], "generation": body["generation"], "requestId": body["requestId"],
                  "sourcePatientKey": KEY if ready else None,
                  "scopeStatus": "ready" if len(ready) == len(members) else "partial" if ready else "rejected",
                  "members": members}
        if spec == "malformed":
            answer["members"] = members[:-1]
        return 200, answer

    def api(self, route, request, method, path, query):
        if method == "POST" and path == "/api/studies/viewing-set/resolve":
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            body = request.post_data_json
            self.resolves.append(body)
            spec = self.resolve_answers.pop(0) if self.resolve_answers else "ready"
            if spec == "hold":
                return self.held_resolves.append((route, body))
            return self.answer(route, *self.reply(body, spec))
        return super().api(route, request, method, path, query)

    def finish_resolve(self, spec="ready", index=0):
        route, body = self.held_resolves.pop(index)
        self.answer(route, *self.reply(body, spec))


class MultiStudyViewPage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = W9Site()
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR", timezone_id="Asia/Seoul")
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
        self.context.add_init_script(NO_POPUP)
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.errors, self.dialogs, self.popups = [], [], []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", lambda dialog: (self.dialogs.append(dialog.message), dialog.accept()))
        self.context.on("page", lambda page: self.popups.append(page))
        self.page.clock.install()

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.site.violations, "requests the synthetic origin does not answer")

    # ── driving the page through its controls ──
    def open(self):
        self.page.goto(h.MAIN_URL)
        expect(self.page.locator("#rows")).to_contain_text(ALPHA)
        self.site.viewer_owner = self.page.evaluate(
            "() => KinViewerOpening.key(KinAuth.session()).slice(KinViewerOpening.PREFIX.length)")

    def visible_order(self):
        return self.page.evaluate("() => [...document.querySelectorAll('#rows tr[data-uid]')].map(tr => tr.dataset.uid)")

    def row(self, uid):
        return self.page.locator(f'#rows tr[data-uid="{uid}"]')

    def choose(self, *uids):
        for uid in uids:
            self.row(uid).click(modifiers=["Control"])

    def target(self):
        return self.page.evaluate("() => selectedUid")

    def wait(self, predicate, what, timeout=10.0):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > deadline:
                self.fail(f"{what}: not observed; last requests {self.site.calls[-8:]}")
            self.page.wait_for_timeout(20)

    def host(self):
        return self.page.locator("#multi-study")

    def status(self):
        return self.page.locator("#multi-study-status")

    def member(self, uid):
        return self.page.locator(f'#multi-study-members li[data-uid="{uid}"]')

    def right_click(self, uid):
        row = self.row(uid)
        box = row.evaluate("tr => { const r = tr.getBoundingClientRect(); return { x: r.x, y: r.y }; }")
        row.dispatch_event("contextmenu", {"clientX": box["x"] + 5, "clientY": box["y"] + 5, "button": 2})

    def menu_labels(self):
        return self.page.evaluate("() => getComputedStyle(document.querySelector('#ctx')).display === 'none' ? null"
                                  " : [...document.querySelectorAll('#ctx [data-i]')].map(e => e.textContent)")

    def viewer(self):
        """The one viewer window the page opened (a popup page of this context)."""
        self.wait(lambda: self.popups, "a viewer window")
        return self.popups[-1]

    def viewer_studies(self, popup=None):
        """The studies and hanging protocol of the viewer window's current URL (as the browser holds it)."""
        url = urlparse((popup or self.viewer()).url)
        q = parse_qs(url.query)
        return (q.get("StudyInstanceUIDs", [""])[0].split(","), q.get("hangingProtocolId", [None])[0],
                parse_qs(url.fragment).get("kin-w9", [None])[0])

    def wait_viewer(self, studies):
        self.wait(lambda: self.viewer().url.startswith(h.ORIGIN + "/ohif/viewer")
                  and self.viewer_studies()[0] == list(studies), f"the viewer showing {studies}")

    def open_set(self, uids, answer="ready"):
        """Choose exactly `uids` and press the toolbar's Open Selected Studies; returns the resolve body."""
        clear = self.page.locator("#multi-selection-clear")
        if clear.is_enabled():
            clear.click()
        self.choose(*uids)
        before = len(self.site.resolves)
        self.site.resolve_answers.append(answer)
        self.page.locator("#multi-selection-open-set").click()
        self.wait(lambda: len(self.site.resolves) > before, "the resolve")
        return self.site.resolves[-1]

    def press(self, selector):
        before = len(self.site.resolves)
        self.page.locator(selector).click()
        self.wait(lambda: len(self.site.resolves) > before, "the resolve of " + selector)
        return self.site.resolves[-1]

    def post_viewer_event(self, popup, opening, message):
        """SYNTHETIC VIEWER EVENT: the viewer half of the opening's channel, as viewer-multi-study.js posts it."""
        popup.evaluate("([name, message]) => { const c = new BroadcastChannel(name); c.postMessage(message); c.close(); }",
                       ["kin-w9:" + opening, {**message, "opening": opening}])

    def clinical_writes(self):
        return (len(self.site.flow_puts), len(self.site.flow_commits), len(self.site.holds), len(self.site.releases))

    # ── V-ENTRY ──
    def test_three_entries_one_action_frozen_visible_order_and_no_target_move(self):
        self.open()
        order = self.visible_order()
        self.assertEqual(6, len(order))
        self.row(order[2]).click()
        self.wait(lambda: self.target() == order[2], "the Reading Target")
        set_ = order[:5]
        self.choose(*set_)
        expect(self.page.locator("#multi-selection-open-set")).to_be_enabled()
        writes, calls = self.clinical_writes(), len(self.site.calls)
        # The selected rows' menu: one selection-scoped item, offered before any select (no move, save or hold).
        self.right_click(order[0])
        self.wait(lambda: self.menu_labels() is not None, "the selection menu")
        self.assertEqual(["Open Selected Studies"], self.menu_labels())
        self.assertEqual(order[2], self.target(), "opening the menu moved the Reading Target")
        self.assertEqual(writes, self.clinical_writes())
        self.assertEqual([], [c for c in self.site.calls[calls:] if c[0] != "GET"])
        self.page.locator("#ctx [data-i]", has_text="Open Selected Studies").click()
        self.wait(lambda: self.site.resolves, "the resolve from the menu")
        body = self.site.resolves[-1]
        self.assertEqual(BODY_KEYS, sorted(body))
        # The visible order, the included Reading Target moved first, the others' relative order kept.
        self.assertEqual([order[2], order[0], order[1], order[3], order[4]], body["studyUids"])
        self.assertEqual((1, None), (body["generation"], body["expectedSourcePatientKey"]))
        self.assertTrue(UUID4.match(body["compositionId"]) and UUID4.match(body["requestId"]))
        self.wait_viewer([order[2], order[0]])
        self.assertEqual("@ohif/hpCompare", self.viewer_studies()[1])
        self.assertEqual(order[2], self.target())
        self.assertEqual(writes, self.clinical_writes(), "an Open wrote a clinical row")
        expect(self.status()).to_contain_text("Ready")
        expect(self.page.locator("#multi-study-summary")).to_have_text("Studies 5 · Page 1/3 · Pages")
        # Selection Details carries the same action; it opens the frozen selection as it is now.
        self.page.locator("#multi-selection-details").click()
        dialog = self.page.locator("#multi-selection-dialog")
        expect(dialog.locator("[data-open-set]")).to_be_enabled()
        before = len(self.site.resolves)
        dialog.locator("[data-open-set]").click()
        self.wait(lambda: len(self.site.resolves) > before, "the resolve from Selection Details")
        self.assertEqual(body["studyUids"], self.site.resolves[-1]["studyUids"])
        self.assertNotEqual(body["compositionId"], self.site.resolves[-1]["compositionId"], "a new Open is a new composition")

    def test_the_action_follows_the_wire_bound_and_never_truncates(self):
        self.open()
        order = self.visible_order()
        button = self.page.locator("#multi-selection-open-set")
        expect(button).to_be_disabled()
        # The Selected toolbar keeps the action whole in view at first paint, also where the list column is narrow and the
        # toolbar line wraps (the Study Panel first-paint comparisons take this one button out: W9_VIEW_NODES there).
        for width, height in ((1920, 1080), (1366, 768), (900, 1200), (768, 1024)):
            with self.subTest(width=width, height=height):
                self.page.set_viewport_size({"width": width, "height": height})
                expect(button).to_be_in_viewport(ratio=1)
        self.page.set_viewport_size({"width": 1400, "height": 900})
        self.choose(order[0])
        expect(button).to_be_disabled()
        self.assertIn("2개 이상", button.get_attribute("title"))
        self.choose(order[1])
        expect(button).to_be_enabled()
        # One selected row is not a multi-selection: the ordinary row menu (after its select) is what opens.
        self.page.locator("#multi-selection-clear").click()
        self.choose(order[3])
        self.right_click(order[3])
        self.wait(lambda: self.menu_labels() is not None, "the ordinary row menu")
        self.assertNotIn("Open Selected Studies", self.menu_labels())

    def test_a_selection_change_closes_the_selection_menu_and_sends_nothing(self):
        self.open()
        order = self.visible_order()
        self.choose(order[0], order[1])
        self.right_click(order[0])
        self.wait(lambda: self.menu_labels() is not None, "the selection menu")
        # A -> B -> A by keyboard while the menu is open: Space deselects and reselects a row (two changes).
        self.row(order[2]).focus()
        self.page.keyboard.press("Space")
        self.assertIsNone(self.menu_labels(), "the menu offered for the old selection stayed open")
        self.page.keyboard.press("Space")
        self.assertIsNone(self.menu_labels())
        self.assertEqual([], self.site.resolves)

    def test_merge_split_exam_placeholder_is_gone_from_the_technician_menu(self):
        technician = {**h.RAD, "roles": ["admin", "radiologist", "technician"]}
        self.site.account = technician
        self.open()
        self.page.locator("[data-tab=Technician]").click()
        order = self.visible_order()
        self.row(order[0]).click()
        self.wait(lambda: self.target() == order[0], "the selection")
        self.right_click(order[0])
        self.wait(lambda: self.menu_labels() is not None, "the technician row menu")
        self.assertNotIn("Merge / Split Exam", self.menu_labels())
        self.assertNotIn("Open Selected Studies", self.menu_labels())

    # ── V-RESOLVE: nothing launches before every member of the first answer is ready ──
    def test_first_answers_that_are_not_all_ready_open_nothing_and_close_only_the_own_blank_window(self):
        self.open()
        order = self.visible_order()
        cases = (
            ({order[1]: "W9_LOAD_FAILED"}, "Not Opened", "선택한 검사를 모두 확인하지 못해"),
            ({uid: "W9_MEMBER_UNAVAILABLE" for uid in order[:3]}, "Not Opened", "열 수 있는 검사를 확인하지 못했습니다"),
            ("malformed", "Load Failed", GENERIC),
            ((503, {"code": "W9_AUDIT_UNAVAILABLE", "message": "SYN"}), "Load Failed", AUDIT),
            ((503, {"message": "SYN uncoded"}), "Load Failed", GENERIC),
            ((409, {"code": "W9_PATIENT_MISMATCH", "message": "SYN"}), "Context Changed", MISMATCH),
        )
        self.choose(*order[:3])
        for answer, state, text in cases:
            with self.subTest(answer=answer):
                popups = len(self.popups)
                self.site.resolve_answers.append(answer)
                self.page.locator("#multi-selection-open-set").click()
                self.wait(lambda: len(self.popups) > popups, "the reserved blank window")
                expect(self.status()).to_contain_text(state)
                expect(self.status()).to_contain_text(text)
                self.wait(lambda: self.popups[-1].is_closed(), "the own blank window closed")
                self.assertEqual([], self.site.viewer_loads, "a viewer was navigated")
                self.assertIsNone(self.target())
        # The member codes of a partial first answer are shown per member, with ordinal only for the failed one.
        self.site.resolve_answers.append({order[1]: "W9_SCOPE_EXCLUDED"})
        self.page.locator("#multi-selection-open-set").click()
        expect(self.member(order[1])).to_contain_text("Study 2")
        expect(self.member(order[1])).to_contain_text("Access Restricted")
        expect(self.member(order[1])).not_to_contain_text("SYNACC")
        expect(self.member(order[0])).to_contain_text("SYNACC05")
        # Retry of the unadmitted set: the same whole N, still without an expected key, a new requestId.
        last = self.site.resolves[-1]
        body = self.press(f'#multi-study-members li[data-uid="{order[1]}"] [data-action=retry]')
        self.assertEqual((last["studyUids"], last["compositionId"], None), (body["studyUids"], body["compositionId"],
                                                                             body["expectedSourcePatientKey"]))
        self.assertNotEqual(last["requestId"], body["requestId"])
        self.wait_viewer(order[:2])

    # ── V-PAGES ──
    def test_fixed_pages_keep_the_odd_member_compare_and_back_resolve_the_frozen_n(self):
        self.open()
        order = self.visible_order()
        first = self.open_set(order[:5])
        n = first["studyUids"]
        self.wait_viewer(n[:2])
        # The selection the set came from changes; the admitted N does not.
        self.page.locator("#multi-selection-clear").click()
        for selector, studies, summary in (("#multi-study-next", n[2:4], "Page 2/3"), ("#multi-study-next", n[4:], "Page 3/3")):
            body = self.press(selector)
            self.assertEqual((n, KEY, first["compositionId"], 1), (body["studyUids"], body["expectedSourcePatientKey"],
                                                                   body["compositionId"], body["generation"]))
            self.assertNotEqual(first["requestId"], body["requestId"])
            self.wait_viewer(studies)
            expect(self.page.locator("#multi-study-summary")).to_contain_text(summary)
        # The last odd member opens alone: no comparison study, no comparison hanging protocol.
        self.assertEqual((None,), self.viewer_studies()[1:2])
        expect(self.page.locator("#multi-study-next")).to_be_disabled()
        # Compare Two: the order of choosing, the second (an earlier page's) on the right; choosing alone sends nothing.
        calls = len(self.site.resolves)
        self.member(n[4]).locator("[data-action=pick]").check()
        self.member(n[0]).locator("[data-action=pick]").check()
        self.assertEqual(calls, len(self.site.resolves))
        self.press("#multi-study-compare")
        self.wait_viewer([n[4], n[0]])
        self.assertEqual("@ohif/hpCompare", self.viewer_studies()[1])
        expect(self.page.locator("#multi-study-summary")).to_contain_text("Compare")
        self.press("#multi-study-pages")
        self.wait_viewer(n[4:])
        expect(self.page.locator("#multi-study-summary")).to_have_text("Studies 5 · Page 3/3 · Pages")
        body = self.press("#multi-study-prev")
        self.assertEqual(n, body["studyUids"])
        self.wait_viewer(n[2:4])
        # A filter that hides frozen members: the set and its next resolve are unchanged, no row is made up.
        self.page.locator("#quick").fill("SYN-P-009")
        self.page.keyboard.press("Enter")
        body = self.press("#multi-study-prev")
        self.assertEqual(n, body["studyUids"])
        self.wait_viewer(n[:2])
        expect(self.member(n[0])).to_contain_text("SYNACC05")

    # ── V-WINDOW: error slots, single-member retry, busy viewer, blocked popup ──
    def test_admitted_partial_keeps_the_failed_slot_and_retry_opens_only_that_member(self):
        self.open()
        order = self.visible_order()
        n = self.open_set(order[:5])["studyUids"]
        self.wait_viewer(n[:2])
        self.site.resolve_answers.append({n[2]: "W9_LOAD_FAILED"})
        self.press("#multi-study-next")
        self.wait_viewer([n[3]])
        expect(self.status()).to_contain_text("Partial")
        expect(self.member(n[2])).to_contain_text("Load Failed")
        expect(self.member(n[2])).to_contain_text(MEMBER_LF)
        expect(self.member(n[2])).not_to_contain_text("SYNACC")
        partner = self.viewer()
        partner.evaluate("() => { document.body.dataset.kept = 'partner'; }")
        calls = len(self.site.resolves)
        self.member(n[2]).locator('[data-action=retry]').click()
        expect(self.status()).to_contain_text("Not Opened")
        self.assertEqual(calls, len(self.site.resolves), "a full window manager must refuse before resolve")
        self.assertEqual([n[3]], self.viewer_studies(partner)[0])
        self.assertEqual('partner', partner.locator('body').get_attribute('data-kept'))
        # The reader frees the sole viewer slot; Retry can now open the failed UID alone.
        partner.close()
        body = self.press(f'#multi-study-members li[data-uid="{n[2]}"] [data-action=retry]')
        self.assertEqual((n, KEY), (body["studyUids"], body["expectedSourcePatientKey"]))
        self.wait_viewer([n[2]])
        expect(self.page.locator("#multi-study-summary")).to_contain_text("Page 2/3 · Single Study")
        self.press("#multi-study-pages")
        self.wait_viewer(n[2:4])

    def test_a_viewer_with_unsaved_work_is_kept_and_its_members_say_not_opened(self):
        self.open()
        order = self.visible_order()
        n = self.open_set(order[:5])["studyUids"]
        self.wait_viewer(n[:2])
        popup = self.viewer()
        popup.wait_for_load_state()
        popup.evaluate("() => { window.__synDirty = true; }")
        loads = len(self.site.viewer_loads)
        self.press("#multi-study-next")
        expect(self.member(n[2])).to_contain_text("Not Opened")
        expect(self.member(n[2])).to_contain_text(BUSY)
        self.assertEqual(n[:2], self.viewer_studies(popup)[0], "the viewer with unsaved work was replaced")
        self.assertEqual(loads, len(self.site.viewer_loads))
        expect(self.page.locator("#multi-study-identity")).to_contain_text("Viewing: Study 1, Study 2")
        popup.evaluate("() => { window.__synDirty = false; }")
        self.press(f'#multi-study-members li[data-uid="{n[2]}"] [data-action=retry]')
        self.wait_viewer([n[2]])

    def test_a_new_ready_set_keeps_the_admitted_set_when_the_viewer_refuses_replacement(self):
        self.open()
        order = self.visible_order()
        original = self.open_set(order[:3])['studyUids']
        self.wait_viewer(original[:2])
        popup = self.viewer()
        popup.evaluate("() => { window.__synDirty = true; document.body.dataset.kept = 'admitted'; }")
        candidate = self.open_set(order[2:5])['studyUids']
        expect(self.status()).to_contain_text('Not Opened')
        self.assertEqual(original, self.page.locator('#multi-study-members li').evaluate_all('(rows) => rows.map(r => r.dataset.uid)'))
        self.assertEqual(original[:2], self.viewer_studies(popup)[0])
        self.assertEqual('admitted', popup.locator('body').get_attribute('data-kept'))
        popup.evaluate('() => { window.__synDirty = false; }')
        body = self.press('#multi-study-retry')
        self.assertEqual(candidate, body['studyUids'])
        self.wait_viewer(candidate[:2])
        self.assertEqual(candidate, self.page.locator('#multi-study-members li').evaluate_all('(rows) => rows.map(r => r.dataset.uid)'))

    def test_a_blocked_popup_sends_no_resolve_and_retry_reserves_in_its_own_click(self):
        self.open()
        order = self.visible_order()
        self.choose(*order[:3])
        self.page.evaluate("() => { window.__synBlockPopups = true; }")
        self.page.locator("#multi-selection-open-set").click()
        expect(self.status()).to_contain_text("Popup Blocked")
        expect(self.status()).to_contain_text(POPUP_BLOCKED)
        self.assertEqual([], self.site.resolves)
        self.page.evaluate("() => { window.__synBlockPopups = false; }")
        self.press("#multi-study-retry")
        self.wait_viewer(self.site.resolves[-1]["studyUids"][:2])

    # ── V-DISPLAY: only this opening's renderer reports count ──
    def test_displayed_only_from_the_current_openings_own_member_event(self):
        self.open()
        order = self.visible_order()
        n = self.open_set(order[:5])["studyUids"]
        self.wait_viewer(n[:2])
        popup = self.viewer()
        opening = self.viewer_studies(popup)[2]
        self.assertTrue(UUID4.match(opening or ""), "the opening id travels in the viewer URL fragment")
        expect(self.member(n[0])).to_contain_text("Loading")
        # SYNTHETIC VIEWER EVENT: the partner's image only.
        self.post_viewer_event(popup, opening, {"type": "displayed", "study": n[1], "series": "1.2.3", "sop": "1.2.3.4", "frame": 1})
        expect(self.member(n[1])).to_contain_text("Displayed")
        expect(self.member(n[0])).to_contain_text("Loading")
        # A member's event without an original reference is no evidence.
        self.post_viewer_event(popup, opening, {"type": "displayed", "study": n[0]})
        self.page.wait_for_timeout(100)
        expect(self.member(n[0])).to_contain_text("Loading")
        # The reused 45-second display bound, from the accepted opening.
        self.page.clock.run_for(45001)
        expect(self.member(n[0])).to_contain_text("Unverified")
        expect(self.member(n[1])).to_contain_text("Displayed")
        self.post_viewer_event(popup, opening, {"type": "displayed", "study": n[0], "series": "1.2.3", "sop": "1.2.3.5", "frame": 1})
        self.page.wait_for_timeout(100)
        expect(self.member(n[0])).to_contain_text("Unverified")
        # A -> B -> A: a late event of the old opening, for a member of the new one, changes nothing.
        self.press("#multi-study-next")
        self.wait_viewer(n[2:4])
        new = self.viewer_studies(popup)[2]
        self.assertNotEqual(opening, new)
        self.post_viewer_event(popup, opening, {"type": "displayed", "study": n[2], "series": "1.2.3", "sop": "1.2.3.6", "frame": 1})
        self.page.wait_for_timeout(100)
        expect(self.member(n[2])).to_contain_text("Loading")
        self.post_viewer_event(popup, new, {"type": "no-images", "study": n[3]})
        expect(self.member(n[3])).to_contain_text("No Images")
        self.post_viewer_event(popup, new, {"type": "failed"})
        expect(self.member(n[2])).to_contain_text("Unverified")
        expect(self.member(n[3])).to_contain_text("Unverified")

    def test_whole_renderer_failure_invalidates_displayed_members_even_after_the_display_bound(self):
        self.open()
        n = self.open_set(self.visible_order()[:2])["studyUids"]
        self.wait_viewer(n)
        popup = self.viewer()
        opening = self.viewer_studies(popup)[2]
        event = {"type": "displayed", "study": n[0], "series": "1.2.3", "sop": "1.2.3.4", "frame": 1}
        self.post_viewer_event(popup, opening, event)
        expect(self.member(n[0])).to_contain_text("Displayed")
        self.page.clock.run_for(45001)
        self.post_viewer_event(popup, opening, {"type": "failed"})
        for value in n:
            expect(self.member(value)).to_contain_text("Unverified")
        self.post_viewer_event(popup, opening, event)
        expect(self.member(n[0])).to_contain_text("Unverified")

    def test_the_viewer_strip_intents_page_through_the_same_bounded_commands(self):
        self.open()
        order = self.visible_order()
        n = self.open_set(order[:5])["studyUids"]
        self.wait_viewer(n[:2])
        popup = self.viewer()
        opening = self.viewer_studies(popup)[2]
        before = len(self.site.resolves)
        self.post_viewer_event(popup, opening, {"type": "intent", "action": "previous"})
        self.page.wait_for_timeout(100)
        self.assertEqual(before, len(self.site.resolves), "Previous on the first page")
        self.post_viewer_event(popup, opening, {"type": "intent", "action": "next"})
        self.wait(lambda: len(self.site.resolves) > before, "the strip's Next")
        self.wait_viewer(n[2:4])

    # ── V-REPORT ──
    def test_viewing_never_writes_or_retargets_and_select_for_reporting_goes_through_w4(self):
        self.open()
        order = self.visible_order()
        self.row(order[0]).click()
        self.wait(lambda: self.target() == order[0], "the Reading Target")
        self.page.locator("#findings").fill("SYN typed before W9")
        self.page.clock.run_for(20001)          # W4's own autosave period (work-exit.js AUTOSAVE_MS) writes the text
        self.wait(lambda: self.site.flow_puts, "the autosave")
        self.page.wait_for_timeout(200)
        # Page time stands still from here: no W4 autosave or hold heartbeat can be counted as a write of W9's.
        self.page.clock.pause_at((self.page.evaluate("Date.now()") + 100) / 1000)
        writes = self.clinical_writes()
        n = self.open_set(order[1:5])["studyUids"]      # the Reading Target is outside N
        self.wait_viewer(n[:2])
        self.press("#multi-study-next")
        self.wait_viewer(n[2:4])
        self.assertEqual((order[0], "SYN typed before W9"), (self.target(), self.page.locator("#findings").input_value()))
        self.assertEqual(writes, self.clinical_writes(), "viewing wrote a clinical row")
        expect(self.page.locator("#multi-study-identity")).to_contain_text("Reading Target: " + ALPHA)
        # The explicit move: W4's guarded select of that member; the composition stays.
        self.member(n[3]).locator("[data-action=report]").click()
        self.wait(lambda: self.target() == n[3], "W4 moved the Reading Target")
        expect(self.host()).to_be_visible()
        expect(self.member(n[3])).to_contain_text("Reading Target")
        # An ordinary W4 move ends the composition.
        self.row(order[5]).click()
        self.wait(lambda: self.target() == order[5], "the ordinary move")
        expect(self.host()).to_be_hidden()

    def test_related_report_mode_blocks_select_for_reporting_but_not_image_navigation(self):
        self.open()
        order = self.visible_order()
        self.row(order[0]).click()
        self.wait(lambda: self.target() == order[0], "the Reading Target")
        n = self.open_set(order[:5])["studyUids"]
        self.wait_viewer(n[:2])
        report = self.member(n[2]).locator("[data-action=report]")
        expect(report).to_be_enabled()
        # W5: the Related row opens the Related Report mode for that study; W9 says the mode's own reason.
        self.page.locator(f'#relrows tr[data-uid="{order[1]}"] td').first.click()
        expect(self.page.locator("#related-mode")).to_be_visible()
        expect(report).to_be_disabled()
        self.assertIn(MODE_REASON, report.get_attribute("title"))
        # Image navigation stays usable and neither leaves the mode nor moves the Target.
        self.press("#multi-study-next")
        self.wait_viewer(n[2:4])
        expect(self.page.locator("#related-mode")).to_be_visible()
        self.assertEqual(order[0], self.target())
        self.page.locator("#related-mode-back").click()
        expect(self.page.locator("#related-mode")).to_be_hidden()
        expect(report).to_be_enabled()

    def test_workspace_preference_uses_the_frame_with_a_target_and_a_window_without_one(self):
        self.open()
        self.page.evaluate("""() => { const key = KinViewerOpening.key(KinAuth.session());
          const value = JSON.stringify({ ...imageOpening.snapshot(), listTarget: 'workspace' });
          localStorage.setItem(key, value); dispatchEvent(new StorageEvent('storage', { key, newValue: value })); }""")
        self.assertEqual("workspace", self.page.evaluate("() => imageOpening.snapshot().listTarget"))
        order = self.visible_order()
        # No Reading Target: the members open in the viewer window; no report UID is made up for a workspace pane.
        n = self.open_set(order[1:4])["studyUids"]
        self.wait_viewer(n[:2])
        self.assertEqual(0, self.page.locator("#reading-frame").count())
        self.page.locator("#multi-study-close").click()
        # With a Reading Target: the Reading Workspace frame takes the members as its own 1/2-study input.
        self.row(order[0]).click()
        self.wait(lambda: self.target() == order[0], "the Reading Target")
        popups = len(self.popups)
        n = self.open_set(order[1:4])["studyUids"]
        frame = self.page.locator("#reading-frame")
        self.wait(lambda: frame.count() == 1 and "StudyInstanceUIDs=" in (frame.get_attribute("src") or ""), "the workspace frame")
        src = urlparse(frame.get_attribute("src"))
        self.assertEqual(n[:2], parse_qs(src.query)["StudyInstanceUIDs"][0].split(","))
        self.assertTrue(UUID4.match(parse_qs(src.fragment)["kin-w9"][0]))
        self.assertEqual(popups, len(self.popups), "a window was opened beside the workspace")
        self.assertEqual(order[0], self.target())
        self.press("#multi-study-next")
        self.wait(lambda: parse_qs(urlparse(frame.get_attribute("src") or "").query).get("StudyInstanceUIDs") == [n[2]],
                  "the workspace frame showing the odd last member")

    def test_retry_preserves_the_workspace_partner_document_and_uses_the_free_window_slot(self):
        self.open()
        self.page.locator('#toolbar-view > summary').click()
        self.page.locator('#image-opening-open').click()
        self.page.locator('#image-opening-target').select_option('workspace')
        self.page.locator('#image-opening-done').click()
        order = self.visible_order()
        self.row(order[0]).click()
        self.wait(lambda: self.target() == order[0], 'the Reading Target')
        n = self.open_set(order[:5])["studyUids"]
        frame = self.page.locator('#reading-frame')
        self.wait(lambda: frame.count() and n[0] in (frame.get_attribute('src') or ''), 'the pair in the workspace')
        self.site.resolve_answers.append({n[2]: 'W9_LOAD_FAILED'})
        self.press('#multi-study-next')
        self.wait(lambda: n[3] in (frame.get_attribute('src') or ''), 'the ready partner in the workspace')
        self.wait(lambda: any(n[3] in f.url for f in self.page.frames), 'the partner document navigation')
        partner = next(f for f in self.page.frames if '/ohif/viewer' in f.url)
        partner.evaluate("() => { document.body.dataset.kept = 'workspace-partner'; }")
        old_src = frame.get_attribute('src')
        opening = parse_qs(urlparse(old_src).fragment)['kin-w9'][0]
        self.post_viewer_event(partner, opening, {'type': 'displayed', 'study': n[3], 'series': '1.2.3', 'sop': '1.2.3.4', 'frame': 1})
        expect(self.member(n[3])).to_contain_text('Displayed')
        body = self.press(f'#multi-study-members li[data-uid="{n[2]}"] [data-action=retry]')
        self.assertEqual(n, body['studyUids'])
        self.wait_viewer([n[2]])
        self.assertEqual(old_src, frame.get_attribute('src'))
        self.assertEqual('workspace-partner', partner.locator('body').get_attribute('data-kept'))
        expect(self.member(n[3])).to_contain_text('Displayed')
        expect(self.member(n[3])).to_contain_text('Viewing')
        # A retained document still owns its events; failure of the retry window cannot invalidate its partner.
        popup = self.viewer()
        self.post_viewer_event(popup, self.viewer_studies(popup)[2], {'type': 'failed'})
        expect(self.member(n[2])).to_contain_text('Unverified')
        expect(self.member(n[3])).to_contain_text('Displayed')
        old_retry = self.viewer_studies(popup)[2]
        count = len(self.popups)
        self.press(f'#multi-study-members li[data-uid="{n[2]}"] [data-action=retry]')
        self.wait(lambda: self.viewer_studies(popup)[2] != old_retry, 'a new opening in the same singleton window')
        self.assertEqual(count, len(self.popups))
        self.assertEqual(old_src, frame.get_attribute('src'))
        self.assertEqual('workspace-partner', partner.locator('body').get_attribute('data-kept'))
        expect(self.member(n[3])).to_contain_text('Displayed')
        self.post_viewer_event(popup, old_retry, {'type': 'failed'})
        expect(self.member(n[2])).to_contain_text('Loading')
        self.post_viewer_event(partner, opening, {'type': 'failed'})
        expect(self.member(n[3])).to_contain_text('Unverified')

    # ── V-LIFECYCLE ──
    def test_a_late_answer_after_a_newer_action_and_the_session_end(self):
        self.open()
        order = self.visible_order()
        n = self.open_set(order[:5])["studyUids"]
        self.wait_viewer(n[:2])
        self.site.resolve_answers.append("hold")
        self.press("#multi-study-next")
        # Close ends the composition while its resolve is out; the late answer opens nothing.
        self.page.locator("#multi-study-close").click()
        expect(self.host()).to_be_hidden()
        self.site.finish_resolve()
        self.page.wait_for_timeout(200)
        self.assertEqual(n[:2], self.viewer_studies()[0])
        # A new Open, then the session ends: the next request's refusal closes the page and the composition with it.
        n = self.open_set(order[:5])["studyUids"]
        self.wait_viewer(n[:2])
        # Refuse this resolve at the HTTP boundary. Revoking the whole synthetic session before clicking races the
        # page's session polling: it can correctly leave for the landing before the button is clicked.
        self.site.resolve_answers.append((401, {"code": "AUTH_SESSION_ENDED"}))
        self.page.locator("#multi-study-next").click()
        self.page.wait_for_url(h.INDEX_URL + "**")
        expect(self.host()).to_be_hidden()


if __name__ == "__main__":
    unittest.main()
