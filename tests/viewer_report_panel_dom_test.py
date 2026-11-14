# coding: utf-8
"""The viewer window's Report Editor tab (read-only) and Open in Reading Screen.

The separate viewer window's tool dock gets a third tab, Report Editor: a read-only mirror of the current patient tab's
report (Live text from the reading screen, the reader's own saved draft, or the saved report; nothing when the server
hides it or answers for another study or patient), with Refresh and Open in Reading Screen. The reading screen stays the
only place that writes, saves, approves or holds.

ViewerReportPanel: two pages of one routed https origin stand in for the list document that linked the viewer window and
for that viewer window. Real: the dock (viewer-workspace-dock.js), the OHIF extension that mounts the panel
(config/ohif/report-panel.js), the panel (viewer-report-panel.js), the editor link (viewer-editor-link.js), the list's
window registry and its channel relay (viewer-windows.js) and the document gate (work-context.js). Stand-ins, named:
the viewer's session verdict (kinViewerSession: writer or read-only, its owner), the end notice (kinViewerOnEnd), the
patient tabs' snapshot/subscribe (KinViewerPatientTabs), the viewer's GET /api/studies?uids= (answered or held by the
test), OHIF's border-box default (its Tailwind base), the list page's report target, its three report fields and its
select() result.

ReadingScreenOpen: the real split reading screen (the harness of tests/auth_logout_dom_test.py) answers the same
kin-editor-open request with its own select() and study-move gate (reading-workspace.js, feature-mounts.js).
"""
import json
import re
import unittest
import uuid
from pathlib import Path

import auth_logout_dom_test as h
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FILES = ROOT / "worklist-v0" / "hpacs-lite"
EXTENSION = ROOT / "config" / "ohif" / "report-panel.js"
ORIGIN = "https://kin-report-panel.test"
UID_A = "1.2.826.0.1.3680043.10.7720.1"
UID_B = "1.2.826.0.1.3680043.10.7720.2"
UID_C = "1.2.826.0.1.3680043.10.7720.3"
OWNER = ["SYN-INST", "SYN-RAD-SUB"]
TEXT_A = "Scattered fibroglandular densities. SYN-A BI-RADS 1."
TEXT_B = "Heterogeneously dense breasts. SYN-B BI-RADS 1."
LIVE_A = "SYN-A typed in the reading screen, not saved yet"
TABS = [
    {"key": "SYN-INST|SYN-P-001", "studies": [UID_A], "patient": {"name": "SYN PATIENT ALPHA", "id": "SYN-P-001", "age": "46Y", "sex": "F"}},
    {"key": "SYN-INST|SYN-P-002", "studies": [UID_B], "patient": {"name": "SYN PATIENT BRAVO", "id": "SYN-P-002", "age": "51Y", "sex": "F"}},
    {"key": "SYN-INST|SYN-P-003", "studies": [UID_C], "patient": {"name": "SYN PATIENT CHARLIE", "id": "SYN-P-003", "age": "60Y", "sex": "F"}},
]


def state(**extra):
    value = {"rs": "W", "version": 0, "findings": "", "conclusion": "", "recommendation": "", "prelimHidden": False,
             "draft": None, "repDoc": None, "confirm": None}
    value.update(extra)
    return value


def row(uid, key, value):
    return {"uid": uid, "sourcePatientKey": key, "name": "SYN", "id": key.split("|")[1], "modality": "MG", "state": value}


ROWS = {
    # A: the reader's own saved draft over saved version 1.
    UID_A: row(UID_A, TABS[0]["key"], state(rs="T", version=1, findings="SYN-A SAVED v1", conclusion="SYN-A SAVED C",
                                            draft={"findings": TEXT_A, "conclusion": "SYN-A CONCLUSION", "recommendation": "SYN-A REC",
                                                   "baseVersion": 1, "at": "2026-11-11T01:02:00.000Z"})),
    # B: approved report.
    UID_B: row(UID_B, TABS[1]["key"], state(rs="A", version=2, findings=TEXT_B, conclusion="SYN-B CONCLUSION",
                                            recommendation="", repDoc="SYN DOCTOR", confirm="2026-11-10 09:00")),
    UID_C: row(UID_C, TABS[2]["key"], state()),
}

VIEWER_HTML = """<!doctype html><html><head><title>SYN viewer</title>
<style>*,::before,::after{box-sizing:border-box}html,body{margin:0}#root{height:100vh}.flex{background:#000}</style></head>
<body><div id="root"><div><div class="bar" style="height:30px">bar</div><div class="flex" id="syn-images" style="height:100%">images</div></div></div></body></html>"""
LIST_HTML = "<!doctype html><html><head><title>SYN list</title></head><body></body></html>"

STORAGE_RECORDER = """(() => { window.__writes = [];
  for (const proto of [Storage.prototype]) { const set = proto.setItem;
    proto.setItem = function (k, v) { window.__writes.push([String(k), String(v)]); return set.call(this, k, v); }; }
  const put = IDBObjectStore.prototype.put, add = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.put = function (v, k) { window.__writes.push(['idb', JSON.stringify(v)]); return put.call(this, v, k); };
  IDBObjectStore.prototype.add = function (v, k) { window.__writes.push(['idb', JSON.stringify(v)]); return add.call(this, v, k); };
  window.__posts = []; const post = BroadcastChannel.prototype.postMessage;
  BroadcastChannel.prototype.postMessage = function (m) { window.__posts.push([this.name, m && m.type]); return post.call(this, m); };
})()"""

LIST_SETUP = """args => {
  KinWorkContext.follow({ onLifecycle(listener) { listener({ state: 'active', session: 'S' }); } });
  const owner = JSON.stringify(args.owner);
  window.__registry = KinViewerWindows.create({ storage: sessionStorage, owner: () => owner,
    newId: () => crypto.randomUUID(), origin: location.origin, describe: () => null });
  for (const id of ['findings', 'conclusion', 'recommendation']) {
    const field = document.createElement('textarea'); field.id = id; field.value = args.body[id] || ''; document.body.append(field);
  }
  window.__target = args.target; window.__listed = args.listed; window.__selects = []; window.__how = 'clear';
  const reader = { owner: () => owner, target: () => window.__target, modal: () => !!document.querySelector('dialog[open]'),
    field: id => document.getElementById(id), usable: f => f.isConnected && !!f.getClientRects().length && !f.disabled,
    session: (who, uid) => 'list|' + who + '|' + uid };
  window.kinReadingEditorReply = m => KinViewerWindows.editorReply(m, reader);
  // The page's select(uid) stand-in: its result is the case's (current-study.js statuses); 'clear' and 'saved' move.
  let opening = false;
  const openReader = { ...reader, busy: () => opening, listed: uid => window.__listed.includes(uid),
    select: uid => {
      window.__selects.push(uid);
      const how = window.__how;
      if (how === 'never') return new Promise(() => {});
      if (how === 'slow') return new Promise(resolve => setTimeout(() => { window.__target = uid; resolve({ status: 'saved', uid }); }, 1500));
      if (how === 'elsewhere') return { status: 'clear', uid };
      if (how === 'clear' || how === 'saved' || how === 'same') { window.__target = uid; return { status: how, uid }; }
      return { status: how, uid };
    },
    focus: () => document.getElementById('findings').focus() };
  window.kinReadingEditorOpen = m => { const answer = KinViewerWindows.editorOpen(m, openReader); if (opening) return answer;
    opening = true; return Promise.resolve(answer).finally(() => { opening = false; }); };
  return window.__registry.linked('/ohif/viewer?StudyInstanceUIDs=' + args.studies.join(','), 0);
}"""

VIEWER_SETUP = """args => {
  KinWorkContext.follow({ onLifecycle(listener) { listener({ state: 'active', session: 'S' }); } });
  let role = args.role; const changes = new Set(), ends = [];
  window.kinViewerSession = { owner: () => args.owner, readOnly: () => role === 'read-only', ended: () => role === 'refused',
    writer: () => role === 'writer', decide: () => Promise.resolve(role),
    onChange(f) { changes.add(f); return () => changes.delete(f); } };
  window.kinViewerOnEnd = run => { ends.push(run); return { close() {} }; };
  window.__endSession = () => { role = 'refused'; for (const run of ends) run(); for (const f of [...changes]) f('refused'); };
  const listeners = new Set(); let current = args.tabs[0], sequence = 1;
  window.KinViewerPatientTabs = {
    snapshot: () => current && { key: current.key, studyUIDs: [...current.studies], patient: { ...current.patient }, sequence },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  window.__switchTab = i => { current = args.tabs[i]; sequence++; for (const l of [...listeners]) l(KinViewerPatientTabs.snapshot()); };
  // GET /api/studies?uids= : answered at once from the case's rows, or held until the test answers it.
  window.__rows = args.rows; window.__hold = false; window.__calls = []; window.__served = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, init) => {
    const text = String(url);
    if (!text.startsWith('/api/studies?uids=')) return realFetch(url, init);
    const uid = decodeURIComponent(text.split('uids=')[1]);
    window.__served.push(uid);
    const reply = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const answer = () => reply({ studies: window.__rows[uid] ? [window.__rows[uid]] : [] });
    if (!window.__hold) return Promise.resolve(answer());
    return new Promise(resolve => window.__calls.push({ uid, answer: body => resolve(reply(body)), fail: () => resolve(new Response('{}', { status: 503 })) }));
  };
  for (const id of ['kin-viewer-history', 'kin-viewer-layout']) {
    const p = document.createElement('details'); p.id = id; p.open = true;
    p.innerHTML = '<summary>' + id + '</summary><p>' + id + '</p>'; document.body.append(p);
  }
  window.__dock = () => KinViewerWorkspaceDock(window, { owner: () => JSON.stringify(args.owner), allowed: () => true });
  window.__extension = kinCreateViewerReportPanel();
}"""

SOURCE = "() => document.querySelector('#kin-viewer-report')?.dataset.source || ''"
VALUES = "() => ['findings','conclusion','recommendation'].map(k => document.getElementById('kin-viewer-report-' + k)?.value ?? null)"


class ViewerReportPanel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.errors = []
        self.context = self.browser.new_context(viewport={"width": 1280, "height": 900}, locale="ko-KR", timezone_id="Asia/Seoul")
        self.context.add_init_script(STORAGE_RECORDER)
        self.context.route(ORIGIN + "/**", self.serve)

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")

    def serve(self, route):
        path = route.request.url.split(ORIGIN, 1)[1].split("?", 1)[0].split("#", 1)[0]
        if path.startswith("/worklist/hpacs-lite/") and path.endswith(".js"):
            return route.fulfill(body=(FILES / path.rsplit("/", 1)[-1]).read_bytes(), content_type="text/javascript; charset=utf-8")
        if path == "/ohif/viewer":
            return route.fulfill(body=VIEWER_HTML, content_type="text/html; charset=utf-8")
        if path == "/list":
            return route.fulfill(body=LIST_HTML, content_type="text/html; charset=utf-8")
        return route.fulfill(status=404, body="")

    def page(self):
        page = self.context.new_page()
        page.set_default_timeout(10000)
        page.on("pageerror", lambda error: self.errors.append(f"{page.url}: {error}"))
        return page

    def list_page(self, target=UID_A, listed=(UID_A, UID_B, UID_C), body=None, storage=None):
        page = self.page()
        page.goto(ORIGIN + "/list")
        if storage:
            page.evaluate("items => { for (const [k, v] of Object.entries(items)) sessionStorage.setItem(k, v); }", storage)
        for name in ("work-context.js", "viewer-windows.js"):
            page.add_script_tag(path=str(FILES / name))
        body = body if body is not None else {"findings": LIVE_A, "conclusion": "SYN-A LIVE C", "recommendation": ""}
        link = page.evaluate(LIST_SETUP, dict(owner=OWNER, target=target, listed=list(listed), body=body, studies=[UID_A]))
        return page, link

    def viewer(self, link="/ohif/viewer?StudyInstanceUIDs=" + UID_A, role="writer", dock_first=True, rows=None):
        page = self.page()
        page.goto(ORIGIN + link)
        for name in ("work-context.js", "viewer-workspace-dock.js"):
            page.add_script_tag(path=str(FILES / name))
        page.add_script_tag(path=str(EXTENSION))
        page.evaluate(VIEWER_SETUP, dict(owner=OWNER, role=role, tabs=TABS, rows=rows or ROWS))
        if dock_first:
            page.evaluate("() => { window.__dock(); window.__extension.onModeEnter(); }")
        else:
            page.evaluate("() => { window.__extension.onModeEnter(); }")
            page.wait_for_function("() => !!document.getElementById('kin-viewer-report')")
            page.evaluate("() => { window.__dock(); }")
        if role == "writer":
            page.wait_for_function("() => document.querySelectorAll('#kin-workspace-dock nav > button[aria-controls]').length === 3")
        return page

    @staticmethod
    def tabs(page):
        return page.evaluate("() => [...document.querySelectorAll('#kin-workspace-dock nav > button[aria-controls]')].map(b => [b.textContent, b.getAttribute('aria-controls')])")

    @staticmethod
    def open_tab(page):
        page.get_by_role("button", name="Report Editor", exact=True).click()
        expect(page.locator("#kin-viewer-report")).to_be_visible()

    @staticmethod
    def wait_source(page, kind):
        page.wait_for_function("k => (document.querySelector('#kin-viewer-report')?.dataset.source || '') === k", arg=kind)

    # ① three tabs in order; the panel may come before or after the dock; a mode re-entry keeps it
    def test_01_report_editor_is_the_third_tab_whichever_mounts_first_and_after_a_mode_reentry(self):
        expected = [["Measurements", "kin-viewer-history"], ["Comparison", "kin-viewer-layout"], ["Report Editor", "kin-viewer-report"]]
        for dock_first in (True, False):
            page = self.viewer(dock_first=dock_first)
            self.assertEqual(expected, self.tabs(page), dock_first)
            # The two tool tabs still open their own panels.
            page.get_by_role("button", name="Comparison", exact=True).click()
            expect(page.locator("#kin-viewer-layout")).to_be_visible()
            expect(page.locator("#kin-viewer-report")).to_be_hidden()
            self.open_tab(page)
            expect(page.locator("#kin-viewer-layout")).to_be_hidden()
            # OHIF re-enters the mode: new tool panels, the extension enters again; one Report Editor tab and panel.
            page.evaluate("""() => { for (const id of ['kin-viewer-history', 'kin-viewer-layout']) { document.getElementById(id).remove();
                const p = document.createElement('details'); p.id = id; p.innerHTML = '<summary>s</summary>'; document.body.append(p); }
                window.__extension.onModeExit(); window.__extension.onModeEnter(); window.__dock(); }""")
            self.assertEqual(expected, self.tabs(page))
            self.assertEqual(1, page.locator("#kin-viewer-report").count())
            expect(page.locator("#kin-viewer-report")).to_be_visible()
            page.close()

    # ② the reader's own saved draft, read only, selectable
    def test_02_my_draft_shows_in_three_read_only_fields_that_can_be_selected(self):
        page = self.viewer()
        self.assertEqual([], page.evaluate("() => window.__served"), "a closed tab reads nothing")
        self.open_tab(page)
        self.wait_source(page, "draft")
        self.assertEqual([TEXT_A, "SYN-A CONCLUSION", "SYN-A REC"], page.evaluate(VALUES))
        expect(page.locator("#kin-viewer-report-source")).to_have_text(re.compile(r"^My Draft — 서버에 저장된 내 초안 \(저장 10:02\)$"))
        expect(page.locator("#kin-viewer-report-patient")).to_have_text("SYN PATIENT ALPHA · SYN-P-001 · MG")
        expect(page.locator("#kin-viewer-report-state")).to_have_text("In Progress")
        expect(page.locator("#kin-viewer-report")).to_contain_text("Read Only")
        for key in ("findings", "conclusion", "recommendation"):
            field = page.locator("#kin-viewer-report-" + key)
            self.assertTrue(field.evaluate("e => e.readOnly"), key)
            expect(field).to_have_attribute("aria-readonly", "true")
        findings = page.locator("#kin-viewer-report-findings")
        findings.click()
        page.keyboard.type("SHOULD NOT APPEAR")
        page.keyboard.press("Backspace")
        expect(findings).to_have_value(TEXT_A)
        selected = findings.evaluate("e => { e.focus(); e.select(); return e.value.slice(e.selectionStart, e.selectionEnd); }")
        self.assertEqual(TEXT_A, selected)
        # The panel never writes or saves: its only server call is the read, of this study.
        self.assertEqual([UID_A], page.evaluate("() => window.__served"))

    # ③ the patient tab decides the study; a late answer for an earlier tab is dropped
    def test_03_switching_patient_tabs_shows_only_that_patients_text_and_drops_late_answers(self):
        page = self.viewer()
        self.open_tab(page)
        self.wait_source(page, "draft")
        page.evaluate("() => window.__switchTab(1)")
        self.wait_source(page, "approved")
        values = page.evaluate(VALUES)
        self.assertEqual(TEXT_B, values[0])
        self.assertNotIn(TEXT_A, json.dumps(values))
        expect(page.locator("#kin-viewer-report-source")).to_have_text("Approved — SYN DOCTOR · 2026-11-10 09:00")
        expect(page.locator("#kin-viewer-report-patient")).to_have_text("SYN PATIENT BRAVO · SYN-P-002 · MG")
        page.evaluate("() => window.__switchTab(0)")
        self.wait_source(page, "draft")
        self.assertEqual(TEXT_A, page.evaluate(VALUES)[0])
        self.assertNotIn(TEXT_B, json.dumps(page.evaluate(VALUES)))
        # A -> B -> A with the first A answer held: B and then the second A are drawn; the first A answer, arriving
        # last with other text, is dropped.
        page.evaluate("() => { window.__hold = true; window.__calls = []; }")
        page.get_by_role("button", name="Refresh", exact=True).click()
        page.wait_for_function("() => window.__calls.length === 1")
        page.evaluate("() => window.__switchTab(1)")
        expect(page.locator("#kin-viewer-report-findings")).to_have_value("")
        page.wait_for_function("() => window.__calls.length === 2")
        page.evaluate("uid => window.__calls[1].answer({ studies: [window.__rows[uid]] })", UID_B)
        self.wait_source(page, "approved")
        # The first A answer arrives while B is shown: nothing of A appears.
        stale = dict(ROWS[UID_A]); stale["state"] = dict(stale["state"], draft=dict(stale["state"]["draft"], findings="SYN-A STALE"))
        page.evaluate("body => window.__calls[0].answer({ studies: [body] })", stale)
        page.wait_for_timeout(300)
        self.assertEqual(TEXT_B, page.evaluate(VALUES)[0])
        page.evaluate("() => window.__switchTab(0)")
        page.wait_for_function("() => window.__calls.length === 3")
        page.evaluate("uid => window.__calls[2].answer({ studies: [window.__rows[uid]] })", UID_A)
        self.wait_source(page, "draft")
        self.assertEqual(TEXT_A, page.evaluate(VALUES)[0])
        # Refresh twice: the earlier answer, arriving after the later one, is dropped too.
        page.get_by_role("button", name="Refresh", exact=True).click()
        page.get_by_role("button", name="Refresh", exact=True).click()
        page.wait_for_function("() => window.__calls.length === 5")
        page.evaluate("uid => window.__calls[4].answer({ studies: [window.__rows[uid]] })", UID_A)
        page.evaluate("body => window.__calls[3].answer({ studies: [body] })", stale)
        page.wait_for_timeout(300)
        self.assertEqual(TEXT_A, page.evaluate(VALUES)[0])
        # A failed read says so and shows no text.
        page.get_by_role("button", name="Refresh", exact=True).click()
        page.wait_for_function("() => window.__calls.length === 6")
        page.evaluate("() => window.__calls[5].fail()")
        expect(page.locator("#kin-viewer-report-status")).to_have_text("판독문을 불러오지 못했습니다. Refresh를 누르세요.")
        self.assertEqual(["", "", ""], page.evaluate(VALUES))

    # ④ Live from the linked reading screen; a refusal falls back to the server's text
    def test_04_live_text_from_the_linked_reading_screen_and_the_server_text_when_it_refuses(self):
        listing, link = self.list_page(target=UID_A)
        page = self.viewer(link=link)
        self.open_tab(page)
        self.wait_source(page, "live")
        self.assertEqual([LIVE_A, "SYN-A LIVE C", ""], page.evaluate(VALUES))
        expect(page.locator("#kin-viewer-report-source")).to_have_text("Live — 판독 화면에서 쓰는 중인 글")
        # Typing continues in the reading screen: the panel follows on its 5 s re-read without a server call.
        served = len(page.evaluate("() => window.__served"))
        listing.fill("#findings", LIVE_A + " MORE")
        page.wait_for_function("t => document.getElementById('kin-viewer-report-findings').value === t", arg=LIVE_A + " MORE", timeout=12000)
        self.assertEqual(served, len(page.evaluate("() => window.__served")))
        # The reading screen's target is another study: no Live for this one, the server's draft shows, no error.
        listing.evaluate("uid => { window.__target = uid; }", UID_B)
        page.get_by_role("button", name="Refresh", exact=True).click()
        self.wait_source(page, "draft")
        self.assertEqual(TEXT_A, page.evaluate(VALUES)[0])
        expect(page.locator("#kin-viewer-report-status")).to_have_text("")
        # The list is gone: still the server's text.
        listing.close()
        page.get_by_role("button", name="Refresh", exact=True).click()
        page.wait_for_timeout(3000)
        self.assertEqual("draft", page.evaluate(SOURCE))

    # ⑤ hiding comes first
    def test_05_hidden_preliminary_missing_uid_and_another_patient_key_show_no_text(self):
        listing, link = self.list_page(target=UID_A)
        hidden = dict(ROWS[UID_A]); hidden["state"] = state(rs="P", version=2, prelimHidden=True)
        page = self.viewer(link=link, rows={UID_A: hidden, UID_B: ROWS[UID_B]})
        self.open_tab(page)
        self.wait_source(page, "hidden")
        # The reading screen's Live text for this study is hidden too.
        page.wait_for_timeout(500)
        self.assertEqual("hidden", page.evaluate(SOURCE))
        self.assertEqual(["", "", ""], page.evaluate(VALUES))
        expect(page.locator("#kin-viewer-report-source")).to_have_text("Hidden — 다른 판독의의 예비 판독(RS: P)입니다")
        expect(page.locator("#kin-viewer-report-state")).to_have_text("")
        for rows in ({}, {UID_A: dict(ROWS[UID_A], sourcePatientKey="SYN-INST|SYN-P-999")}):
            page.evaluate("rows => { window.__rows = rows; }", rows)
            page.get_by_role("button", name="Refresh", exact=True).click()
            self.wait_source(page, "none")
            page.wait_for_timeout(500)
            self.assertEqual("none", page.evaluate(SOURCE), "Live is not shown without the study's own row")
            self.assertEqual(["", "", ""], page.evaluate(VALUES))
            expect(page.locator("#kin-viewer-report-source")).to_have_text("No Report — 이 검사에는 아직 판독문이 없습니다")

    # ⑥ Open in Reading Screen
    def open_click(self, page):
        page.get_by_role("button", name="Open in Reading Screen", exact=True).click()

    def test_06_open_in_reading_screen_moves_only_the_linked_list_and_says_what_happened(self):
        listing, link = self.list_page(target=UID_B)
        stored = listing.evaluate("() => Object.fromEntries(Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)]))")
        # A duplicated list tab: the same window group, its own document; it never answers this window.
        other, other_link = self.list_page(target=UID_B, storage=stored)
        self.assertNotEqual(re.search(r"kin-window-list=([0-9a-f-]+)", other_link).group(1), re.search(r"kin-window-list=([0-9a-f-]+)", link).group(1))
        page = self.viewer(link=link)
        self.open_tab(page)
        status = page.locator("#kin-viewer-report-status")
        button = page.get_by_role("button", name="Open in Reading Screen", exact=True)
        # Success: the list's select() moved to A and the caret is in Findings.
        self.open_click(page)
        expect(status).to_have_text("판독 화면이 SYN PATIENT ALPHA 검사로 옮겨졌습니다 — 판독 화면 창에서 입력하세요.")
        self.assertEqual([UID_A], listing.evaluate("() => window.__selects"))
        self.assertEqual("findings", listing.evaluate("() => document.activeElement.id"))
        self.assertEqual([], other.evaluate("() => window.__selects"), "the other list document asked nothing of its page")
        # Already there (same).
        listing.evaluate("() => { window.__how = 'same'; }")
        self.open_click(page)
        expect(status).to_contain_text("검사로 옮겨졌습니다")
        # The page's gate refused: the text it holds is not confirmed saved.
        listing.evaluate("uid => { window.__target = uid; window.__how = 'refused'; }", UID_B)
        self.open_click(page)
        expect(status).to_have_text("판독 화면이 검사를 옮기지 못했습니다 (쓰던 글 저장 대기·거절). 판독 화면에서 확인하세요.")
        # Composing (IME) and another selection.
        listing.evaluate("() => { window.__how = 'composing'; }")
        self.open_click(page)
        expect(status).to_have_text("판독 화면이 검사를 옮기지 못했습니다 (글자 조합 중). 판독 화면에서 확인하세요.")
        listing.evaluate("() => { window.__how = 'elsewhere'; }")
        self.open_click(page)
        expect(status).to_have_text("판독 화면이 검사를 옮기지 못했습니다 (다른 검사가 선택됨). 판독 화면에서 확인하세요.")
        listing.evaluate("() => { const d = document.createElement('dialog'); document.body.append(d); d.showModal(); }")
        self.open_click(page)
        expect(status).to_have_text("판독 화면이 검사를 옮기지 못했습니다 (대화상자가 열려 있음). 판독 화면에서 확인하세요.")
        listing.evaluate("() => document.querySelector('dialog').remove()")
        # A study that is not a row of the list.
        listing.evaluate("uid => { window.__listed = [uid]; window.__how = 'clear'; }", UID_B)
        self.open_click(page)
        expect(status).to_have_text("판독 화면이 검사를 옮기지 못했습니다 (목록에 없는 검사). 판독 화면에서 확인하세요.")
        listing.evaluate("uids => { window.__listed = uids; }", [UID_A, UID_B, UID_C])
        # A slow save: the button stays locked until the answer; a second request meanwhile is refused as busy.
        listing.evaluate("() => { window.__how = 'slow'; window.__selects = []; }")
        self.open_click(page)
        expect(button).to_be_disabled()
        expect(status).to_have_text("판독 화면에 요청하는 중입니다.")
        busy = page.evaluate("""uid => new Promise(resolve => { const link = kinViewerEditorLink({ studies: [uid],
            owner: () => kinViewerSession.owner(), live: () => true }); link.open(uid).then(resolve); })""", UID_A)
        self.assertEqual({"ok": False, "reason": "busy"}, busy)
        expect(status).to_contain_text("검사로 옮겨졌습니다", timeout=5000)
        expect(button).to_be_enabled()
        self.assertEqual([UID_A], listing.evaluate("() => window.__selects"))
        # No answer in 6 s: unknown, never called a move.
        listing.evaluate("() => { window.__how = 'never'; }")
        self.open_click(page)
        expect(button).to_be_disabled()
        page.wait_for_timeout(4500)
        expect(status).to_have_text("판독 화면에 요청하는 중입니다.")
        expect(status).to_have_text("판독 화면의 응답이 없습니다. 옮겨졌는지 판독 화면에서 확인하세요.", timeout=4000)
        expect(button).to_be_enabled()
        self.assertNotIn("kin-editor-opened", json.dumps(other.evaluate("() => window.__posts")))

    def test_06b_without_a_linking_list_there_is_no_reading_screen_to_ask(self):
        page = self.viewer()
        self.open_tab(page)
        self.open_click(page)
        expect(page.locator("#kin-viewer-report-status")).to_have_text(
            "연결된 판독 화면이 없습니다. 목록 창에서 이 검사를 고르면 판독문을 쓸 수 있습니다.")
        self.wait_source(page, "draft")

    # ⑦ no tab in the reading screen's frame or in a read-only session
    def test_07_no_report_editor_tab_in_a_frame_or_a_read_only_session(self):
        page = self.viewer(role="read-only")
        page.wait_for_timeout(500)
        self.assertEqual(2, len(self.tabs(page)))
        self.assertEqual(0, page.locator("#kin-viewer-report").count(), "the extension mounts nothing in a read-only session")
        # The reading screen's frame: the extension stops at window.top !== window; the frame's dock keeps two tabs even
        # with a stored Report Editor choice.
        host = self.page()
        host.goto(ORIGIN + "/list")
        host.evaluate("""src => new Promise(resolve => { const f = document.createElement('iframe'); f.src = src; f.onload = resolve;
            f.style.cssText = 'width:900px;height:600px'; document.body.append(f); })""", "/ohif/viewer?StudyInstanceUIDs=" + UID_A)
        frame = host.frames[1]
        for name in ("work-context.js", "viewer-workspace-dock.js"):
            frame.add_script_tag(path=str(FILES / name))
        frame.add_script_tag(path=str(EXTENSION))
        frame.evaluate("owner => localStorage.setItem('kin-viewer-dock:v1:' + JSON.stringify(owner), JSON.stringify({ version: 2, placement: 'bottom', panel: 2, autoHide: false }))", OWNER)
        frame.evaluate(VIEWER_SETUP, dict(owner=OWNER, role="writer", tabs=TABS, rows=ROWS))
        frame.evaluate("() => { window.__extension.onModeEnter(); window.__dock(); }")
        frame.wait_for_timeout(500)
        self.assertEqual(0, frame.locator("#kin-viewer-report").count())
        self.assertEqual(2, frame.evaluate("() => document.querySelectorAll('#kin-workspace-dock nav > button[aria-controls]').length"))
        self.assertFalse(frame.evaluate("() => document.body.classList.contains('kin-dock-open')"))

    # ⑧ nothing stored; the end of the session empties the panel and stops its reads
    def test_08_the_text_is_never_stored_and_the_session_end_empties_the_panel_and_its_timer(self):
        listing, link = self.list_page(target=UID_A)
        page = self.viewer(link=link)
        self.open_tab(page)
        self.wait_source(page, "live")
        page.get_by_role("button", name="Refresh", exact=True).click()
        page.evaluate("() => window.__switchTab(1)")
        self.wait_source(page, "approved")
        writes = json.dumps(page.evaluate("() => window.__writes"), ensure_ascii=False)
        for text in (TEXT_A, TEXT_B, LIVE_A, "SYN-A CONCLUSION", "SYN-B CONCLUSION"):
            self.assertNotIn(text, writes)
        page.evaluate("() => window.__switchTab(0)")
        self.wait_source(page, "live")
        page.evaluate("() => window.__endSession()")
        self.assertEqual(["", "", ""], page.evaluate(VALUES))
        self.assertEqual("ended", page.evaluate(SOURCE))
        expect(page.get_by_role("button", name="Open in Reading Screen", exact=True)).to_be_disabled()
        expect(page.get_by_role("button", name="Refresh", exact=True)).to_be_disabled()
        asked = lambda: sum(1 for name, kind in page.evaluate("() => window.__posts") if kind == "kin-editor-request")
        before, served = asked(), len(page.evaluate("() => window.__served"))
        page.wait_for_timeout(5600)
        self.assertEqual(before, asked(), "the 5 s Live re-read stopped")
        self.assertEqual(served, len(page.evaluate("() => window.__served")))
        self.assertEqual(["", "", ""], page.evaluate(VALUES))

    # ⑨ the open dock takes room from the images; it never covers them
    def test_09_the_open_report_editor_reserves_its_room_below_the_images(self):
        page = self.viewer()
        self.open_tab(page)
        self.wait_source(page, "draft")
        box = page.evaluate("""() => { const root = document.getElementById('root').getBoundingClientRect(),
            images = document.getElementById('syn-images').getBoundingClientRect(),
            dock = document.getElementById('kin-workspace-dock').getBoundingClientRect(),
            panel = document.getElementById('kin-viewer-report').getBoundingClientRect();
            return { rootBottom: root.bottom, imagesBottom: images.bottom, dockTop: dock.top, panelTop: panel.top, panelHeight: panel.height, height: innerHeight }; }""")
        self.assertLessEqual(box["imagesBottom"], box["dockTop"] + 0.5, box)
        self.assertLessEqual(box["rootBottom"], box["dockTop"] + 0.5, box)
        self.assertGreater(box["panelHeight"], 100, box)
        self.assertGreaterEqual(box["panelTop"], box["dockTop"], box)
        # Top placement: the dock is above, the images below it.
        page.evaluate("() => { const s = document.getElementById('kin-dock-placement'); s.value = 'top'; s.onchange(); }")
        box = page.evaluate("""() => ({ imagesTop: document.getElementById('syn-images').getBoundingClientRect().top,
            dockBottom: document.getElementById('kin-workspace-dock').getBoundingClientRect().bottom })""")
        self.assertGreaterEqual(box["imagesTop"] + 0.5, box["dockBottom"], box)

    # Late answers across a logout preparation, a relink and an Open answer for a tab no longer shown
    def test_10_an_answer_from_before_a_cancelled_logout_preparation_is_not_drawn_and_the_panel_reads_again(self):
        page = self.viewer()
        self.open_tab(page)
        self.wait_source(page, "draft")
        page.evaluate("() => { window.__hold = true; window.__calls = []; }")
        page.get_by_role("button", name="Refresh", exact=True).click()
        page.wait_for_function("() => window.__calls.length === 1")
        page.evaluate("() => { const p = KinWorkContext.prepare({}); KinWorkContext.cancelPreparation(p); }")
        page.wait_for_function("() => window.__calls.length === 2")
        stale = dict(ROWS[UID_A]); stale["state"] = dict(stale["state"], draft=dict(stale["state"]["draft"], findings="SYN-A BEFORE PREPARATION"))
        page.evaluate("body => window.__calls[0].answer({ studies: [body] })", stale)
        page.wait_for_timeout(300)
        self.assertEqual("loading", page.evaluate(SOURCE))
        self.assertEqual(["", "", ""], page.evaluate(VALUES))
        page.evaluate("uid => window.__calls[1].answer({ studies: [window.__rows[uid]] })", UID_A)
        self.wait_source(page, "draft")
        self.assertEqual(TEXT_A, page.evaluate(VALUES)[0])

    def test_11_a_relinked_window_drops_the_earlier_link_answer_and_reads_again(self):
        listing, link = self.list_page(target=UID_B)
        page = self.viewer(link=link)
        page.evaluate("() => { window.__hold = true; window.__calls = []; }")
        self.open_tab(page)
        page.wait_for_function("() => window.__calls.length === 1")
        page.evaluate("""() => { const hash = new URLSearchParams(location.hash.slice(1)); hash.set('kin-window-list', crypto.randomUUID());
            history.replaceState(null, '', location.pathname + location.search + '#' + hash.toString());
            dispatchEvent(new Event('kin-window-link-changed')); }""")
        page.wait_for_function("() => window.__calls.length === 2")
        stale = dict(ROWS[UID_A]); stale["state"] = dict(stale["state"], draft=dict(stale["state"]["draft"], findings="SYN-A EARLIER LINK"))
        page.evaluate("body => window.__calls[0].answer({ studies: [body] })", stale)
        page.wait_for_timeout(300)
        self.assertEqual("loading", page.evaluate(SOURCE))
        page.evaluate("uid => window.__calls[1].answer({ studies: [window.__rows[uid]] })", UID_A)
        self.wait_source(page, "draft")
        self.assertEqual(TEXT_A, page.evaluate(VALUES)[0])

    def test_12_an_open_answer_arriving_after_the_patient_tab_changed_is_not_told_on_the_new_tab(self):
        listing, link = self.list_page(target=UID_B)
        page = self.viewer(link=link)
        self.open_tab(page)
        listing.evaluate("() => { window.__how = 'slow'; }")
        self.open_click(page)
        status = page.locator("#kin-viewer-report-status")
        expect(status).to_have_text("판독 화면에 요청하는 중입니다.")
        page.evaluate("() => window.__switchTab(1)")
        listing.wait_for_function("uid => window.__target === uid", arg=UID_A, timeout=5000)
        expect(page.get_by_role("button", name="Open in Reading Screen", exact=True)).to_be_enabled()
        page.wait_for_timeout(300)
        expect(status).to_have_text("")
        self.assertNotIn("SYN PATIENT ALPHA", page.locator("#kin-viewer-report").inner_text())


class ReadingScreenOpen(h.LogoutDOMTest):
    """The real reading screen answers kin-editor-open through its own select() and study-move gate."""

    def fresh_context(self, site=True):
        super().fresh_context(site)
        self.site.second_study = True

    def owner(self):
        return self.page.evaluate("() => KinWorkspaceLayout.key(KinAuth.session()).slice(KinWorkspaceLayout.PREFIX.length)")

    def ask(self, uid, owner=None):
        request = str(uuid.uuid4())
        return self.page.evaluate("""m => Promise.resolve(window.kinReadingEditorOpen(m))""",
                                  {"type": "kin-editor-open", "request": request, "owner": owner or self.owner(), "uid": uid, "list": "L"})

    def test_open_selects_the_study_and_puts_the_caret_in_findings(self):
        self.open_main()
        answer = self.ask(h.UID)
        self.assertEqual("ok", answer["result"], answer)
        expect(self.page.locator("#clinical")).to_contain_text(h.PATIENT)
        self.assertEqual("findings", self.page.evaluate("() => document.activeElement.id"))
        answer = self.ask(h.UID_B)
        self.assertEqual("ok", answer["result"], answer)
        expect(self.page.locator("#clinical")).to_contain_text(h.PATIENT_B)
        self.assertEqual("findings", self.page.evaluate("() => document.activeElement.id"))
        # Another login, and a study that is not in the list, are refused without moving.
        self.assertEqual("session", self.ask(h.UID, owner='["X","Y"]')["reason"])
        self.assertEqual("unlisted", self.ask("1.2.826.0.1.3680043.10.7707.99")["reason"])
        expect(self.page.locator("#clinical")).to_contain_text(h.PATIENT_B)

    def test_text_the_server_has_not_confirmed_keeps_the_study_and_refuses(self):
        self.open_main()
        self.site.put_answers = [(503, {"code": "SYN_DOWN", "message": "SYN server down"})] * 8
        self.select_and_type()
        # A second request while the first waits for the page's save is refused as busy.
        request = str(uuid.uuid4())
        answers = self.page.evaluate("""args => Promise.all([
            Promise.resolve(window.kinReadingEditorOpen({ type: 'kin-editor-open', request: args.a, owner: args.owner, uid: args.uid, list: 'L' })),
            Promise.resolve(window.kinReadingEditorOpen({ type: 'kin-editor-open', request: args.b, owner: args.owner, uid: args.uid, list: 'L' }))])""",
                                     {"a": request, "b": str(uuid.uuid4()), "owner": self.owner(), "uid": h.UID_B})
        self.assertEqual(["refused", "refused"], [a["result"] for a in answers], answers)
        self.assertEqual("saving", answers[0]["reason"], answers)
        self.assertEqual("busy", answers[1]["reason"], answers)
        expect(self.page.locator("#findings")).to_have_value(h.FIELDS["findings"])
        expect(self.page.locator("#clinical")).to_contain_text(h.PATIENT)

    def test_a_withdrawn_opening_leaves_the_page_on_its_study_after_the_late_save(self):
        """A viewer that stopped waiting (kin-editor-open-cancel, viewer-windows.js -> kinReadingEditorCancel) drops the move
        still waiting for the page's save: the save completes later and the page stays on its study."""
        self.open_main()
        self.site.put_answers = ["hold"]
        self.select_and_type()
        request = str(uuid.uuid4())
        self.page.evaluate("""args => { window.__opening = Promise.resolve(window.kinReadingEditorOpen({ type: 'kin-editor-open',
            request: args.request, owner: args.owner, uid: args.uid, list: 'L' })); }""",
                           {"request": request, "owner": self.owner(), "uid": h.UID_B})
        self.page.evaluate("args => window.kinReadingEditorCancel({ type: 'kin-editor-open-cancel', request: args.request, uid: args.uid, list: 'L' })",
                           {"request": request, "uid": h.UID_B})
        self.wait_until(lambda: self.site.held_puts, "the page's save on the wire")
        self.site.finish_put()
        answer = self.page.evaluate("() => window.__opening")
        self.assertEqual("refused", answer["result"], answer)
        expect(self.page.locator("#clinical")).to_contain_text(h.PATIENT)
        self.page.wait_for_timeout(300)
        expect(self.page.locator("#clinical")).to_contain_text(h.PATIENT)
        expect(self.page.locator("#findings")).to_have_value(h.FIELDS["findings"])
        self.assertEqual(h.FIELDS, self.site.stored())
    def test_appearance_shows_what_the_reading_frame_dock_applied_for_report_editor(self):
        """The reading screen's frame has no Report Editor tab: choosing it there applies Collapsed, and Appearance says so."""
        self.open_main()
        self.page.evaluate("""owner => { const frame = document.createElement('iframe'); frame.id = 'reading-frame'; document.body.append(frame);
            const w = frame.contentWindow, d = w.document; d.body.innerHTML = '<div id="root"><div></div></div>';
            for (const id of ['kin-viewer-history', 'kin-viewer-layout']) { const p = d.createElement('details'); p.id = id; d.body.append(p); }
            w.KinWorkContext = KinWorkContext; KinViewerWorkspaceDock(w, { owner: () => owner, allowed: () => true }); }""", self.owner())
        # The opener sits in a closed menu; its own click handler opens the dialog.
        self.page.evaluate("() => document.getElementById('reading-appearance-open').click()")
        self.page.select_option("#reading-dock-panel", "2")
        expect(self.page.locator("#reading-dock-panel")).to_have_value("-1")
        self.assertEqual(-1, self.page.evaluate("() => document.getElementById('reading-frame').contentWindow.document.getElementById('kin-workspace-dock').preference().panel"))
        self.assertEqual(2, self.page.locator("#reading-frame").content_frame.locator("#kin-workspace-dock nav > button[aria-controls]").count())

def load_tests(loader, tests, pattern):
    suite = loader.loadTestsFromTestCase(ViewerReportPanel)
    suite.addTests(ReadingScreenOpen(name) for name in ReadingScreenOpen.__dict__ if name.startswith("test_"))
    return suite


if __name__ == "__main__":
    unittest.main(verbosity=2)
