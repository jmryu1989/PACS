# coding: utf-8
"""REQ-D01-SEARCH-APPLY (options kept per browser, institution and account; a session end discards the state)
-> RISK-S7-DEMO-ROWS-OWNERLESS-EMPTY / RISK-S7-DEMO-ROWS-STORE-LEAK / RISK-S7-DEMO-ROWS-END-BYPASS
-> TEST-S7-DEMO-ROWS-MODULE.

The worklist search module's public mount contract, as main.html uses it (KinWorklistSearch.mount({host, owner,
snapshot, render}) -> read/apply/change/clear), with the real file in Chromium. The page cannot produce an owner change
(the session only ever turns null while a page lives), so the owner cases live here; the page-level cases are in
tests/multi_institution_worklist_dom_test.py (T-01..T-04).

Harness (S7-DEMO-ROWS diagnosis test-plan §1.2, Astra S7-DEMO-ROWS-DIAG-R-001 F02):
  - one browser context per case; the context's only route fulfils the test's own synthetic HTTPS documents by exact URL
    (host.html, peer.html, sandboxed.html on https://kin-search.test; their bodies are the strings below) and aborts every
    other request, recording it as a violation that each case asserts empty (no network);
  - page A (host.html) carries the module, page B (peer.html) of the same context and origin sends the session signals;
    the module file is added after goto with add_script_tag, a re-mount is A.reload() and the same loading;
  - the browser's own localStorage, BroadcastChannel and storage events; the storage recorder (installed before any page
    script) calls the original Storage methods and only records the calls;
  - storage exceptions come only from sandboxed.html (Content-Security-Policy: sandbox allow-scripts, an opaque origin
    whose localStorage access the browser itself refuses with SecurityError), in their own cases M-01e and M-02x.
Assertions name the module's returned values and the controls by role and accessible name inside the host; no module
internal is read. M-00 checks the harness before the contract cases.

KIN_WORKLIST_SEARCH_JS (a file path) is the only override: the fitness run F-M1 points it at the base commit's module.
Synthetic values only; no server, no network, no credentials.
"""
import json
import os
import sys
import unittest
from pathlib import Path

from module_session_harness import activate
from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parents[1]
MODULE = Path(os.environ.get("KIN_WORKLIST_SEARCH_JS") or ROOT / "worklist-v0" / "hpacs-lite" / "worklist-search.js")
ORIGIN = "https://kin-search.test"
# The documents are the test's own. The icon link keeps the browser from asking for /favicon.ico.
HOST_HTML = ('<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,">'
             '<title>Synthetic search host</title></head><body><div role="toolbar" aria-label="Synthetic search host">'
             '</div></body></html>')
PEER_HTML = ('<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,">'
             '<title>Synthetic peer</title></head><body></body></html>')
DOCUMENTS = {ORIGIN + "/host.html": (HOST_HTML, {}),
             ORIGIN + "/peer.html": (PEER_HTML, {}),
             ORIGIN + "/sandboxed.html": (HOST_HTML, {"Content-Security-Policy": "sandbox allow-scripts"})}

OWNER_A = '["syn-inst","syn-sub-a"]'
OWNER_B = '["syn-inst","syn-sub-b"]'
OWNER_A_ELSEWHERE = '["syn-other-inst","syn-sub-a"]'
PREFIX = "kin-worklist-search:v1:"
STORED_MANUAL = '{"version":1,"mode":"manual","clearResults":true}'
UNREADABLE_SAVED = "저장된 검색 설정을 확인할 수 없어 기본값을 적용했습니다."
READ_FAILED = "검색 설정을 읽지 못해 기본값을 적용했습니다."
WRITE_FAILED = "검색 설정을 저장하지 못했습니다. 현재 창에만 적용합니다."
C1 = {"quick": "SYN-1", "cols": {"id": "SYN"}}
C2 = {"quick": "SYN-2", "cols": {"id": "SYN-2"}}
C3 = {"quick": "", "cols": {}}

# Calls the page makes on Storage, recorded before any page script runs; the original method is always called.
STORAGE_RECORDER = """(() => {
  const calls = [];
  Object.defineProperty(window, '__synStorageCalls', { value: calls });
  for (const name of ['getItem', 'setItem', 'removeItem', 'clear']) {
    const original = Storage.prototype[name];
    Storage.prototype[name] = function (...args) {
      calls.push([name, ...args.map(String)]);
      return original.apply(this, args);
    };
  }
})();"""
# The test's mount: the owner is a value the test changes, the snapshot is the test's current criteria, render counts.
MOUNT = """owner => {
  window.__synOwner = owner;
  window.__synCriteria = {};
  window.__synRenders = 0;
  window.__synView = KinWorklistSearch.mount({
    host: document.querySelector('[role=toolbar]'),
    owner: () => window.__synOwner,
    snapshot: () => window.__synCriteria,
    render: () => { window.__synRenders += 1; },
  });
}"""
# Listeners made after the mount: a message or event reaches the module's listener first (creation and registration
# order), so a read() taken here is the state after the module has handled the same signal.
PROBE = """() => {
  const seen = [];
  Object.defineProperty(window, '__synProbe', { value: seen });
  const channel = new BroadcastChannel('kin-session');
  channel.onmessage = e => seen.push({ signal: 'channel:' + JSON.stringify(e.data), read: window.__synView.read(window.__synCriteria) });
  window.addEventListener('storage', e => seen.push({ signal: 'storage:' + e.key + '=' + e.newValue, read: window.__synView.read(window.__synCriteria) }));
}"""


class Harness:
    """One case's context: the allow table, the violations and the pages."""

    def __init__(self, case, browser):
        self.case, self.violations, self.errors = case, [], []
        self.context = browser.new_context(locale="ko-KR")
        case.addCleanup(self.context.close)
        self.context.add_init_script(STORAGE_RECORDER)
        self.context.route("**/*", self.handle)

    def handle(self, route, request):
        document = DOCUMENTS.get(request.url)
        if document is None or request.method != "GET":
            self.violations.append(request.method + " " + request.url)
            return route.abort()
        body, headers = document
        return route.fulfill(status=200, content_type="text/html; charset=utf-8", headers=headers, body=body)

    def page(self, name):
        page = self.context.new_page()
        page.on("pageerror", lambda error: self.errors.append(f"{name}: {error}"))
        page.goto(ORIGIN + "/" + name)
        return page

    def module(self, page, owner, criteria=C1):
        activate(page)
        page.add_script_tag(content=MODULE.read_text(encoding="utf-8"))
        page.evaluate("() => { window.__synPreMount = window.__synStorageCalls.length; }")
        page.evaluate(MOUNT, owner)
        self.criteria(page, criteria)
        return Search(page)

    @staticmethod
    def criteria(page, value):
        page.evaluate("c => { window.__synCriteria = c; }", value)

    def finish(self):
        self.case.assertEqual([], self.violations, "requests outside the allow table")
        self.case.assertEqual([], self.errors, "page errors")


class Search:
    """The mounted module seen through its returned API and its controls (role and accessible name)."""

    def __init__(self, page):
        self.page = page
        host = page.get_by_role("toolbar", name="Synthetic search host")
        self.mode = host.get_by_role("combobox", name="Search Mode")
        self.search = host.get_by_role("button", name="Search", exact=True)
        self.clear_box = host.get_by_role("checkbox", name="Clear Results on Clear")
        self.status = host.get_by_role("status")

    def read(self, criteria):
        return self.page.evaluate("c => window.__synView.read(c)", criteria)

    def call(self, name):
        self.page.evaluate("name => window.__synView[name]()", name)

    def controls(self):
        return {"mode": self.mode.input_value(), "mode_disabled": self.mode.is_disabled(),
                "search_disabled": self.search.is_disabled(), "clear": self.clear_box.is_checked(),
                "clear_disabled": self.clear_box.is_disabled()}

    def calls_since_mount(self):
        return self.page.evaluate("() => window.__synStorageCalls.slice(window.__synPreMount)")

    def force_mode(self, value):
        # A change event reaching the module even on a disabled control (the module, not the browser, must refuse).
        self.mode.evaluate("(s, v) => { s.value = v; }", value)
        self.mode.dispatch_event("change")

    def stored(self):
        return self.page.evaluate("() => Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]))")


class WorklistSearchOwnerContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()
        print("S7-DEMO-ROWS module under test: " + str(MODULE))

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def harness(self):
        return Harness(self, self.browser)

    # ── M-00 harness fitness ──────────────────────────────────────────────────────────────────────────────────────
    def test_m00_harness_origin_storage_channel_and_sandbox(self):
        h = self.harness()
        a, b = h.page("host.html"), h.page("peer.html")
        for page in (a, b):
            self.assertEqual({"location": ORIGIN, "global": ORIGIN, "secure": True},
                             page.evaluate("() => ({location: location.origin, global: globalThis.origin, secure: isSecureContext})"))
        # Cross-page storage: A writes a test-only key, B reads and removes it, A sees the storage event.
        a.evaluate("""() => { window.__synEvents = []; addEventListener('storage', e => __synEvents.push([e.key, e.newValue]));
                       localStorage.setItem('syn-probe:storage', 'syn-1'); }""")
        self.assertEqual("syn-1", b.evaluate("() => localStorage.getItem('syn-probe:storage')"))
        b.evaluate("() => localStorage.removeItem('syn-probe:storage')")
        a.wait_for_function("() => __synEvents.some(e => e[0] === 'syn-probe:storage' && e[1] === null)", timeout=5000)
        # Cross-page BroadcastChannel delivery on a test-only channel.
        a.evaluate("() => { window.__synMessages = []; new BroadcastChannel('syn-probe').onmessage = e => __synMessages.push(e.data); }")
        b.evaluate("() => { const c = new BroadcastChannel('syn-probe'); c.postMessage({probe: 'syn-2'}); c.close(); }")
        a.wait_for_function("() => __synMessages.some(m => m.probe === 'syn-2')", timeout=5000)
        # The sandboxed document: URL origin is the HTTPS one, the security origin is opaque, storage access is refused.
        sandboxed = h.page("sandboxed.html")
        seen = sandboxed.evaluate("""() => { let storage = 'no exception';
            try { localStorage.getItem('syn-x'); } catch (e) { storage = e.name; }
            return {location: location.origin, global: globalThis.origin, storage}; }""")
        print("M-00 sandboxed.html: " + json.dumps(seen))
        self.assertEqual({"location": ORIGIN, "global": "null", "storage": "SecurityError"}, seen)
        # Counterexample: the first-draft loading (a new page, every request aborted, set_content) has no origin at all,
        # so it could not carry the storage and channel cases.
        blank = h.context.new_page()
        blank.route("**/*", lambda route: route.abort())
        blank.set_content(HOST_HTML)
        first_draft = blank.evaluate("""() => { let storage = 'no exception';
            try { localStorage.getItem('syn-x'); } catch (e) { storage = e.name; }
            return {url: location.href, location: location.origin, global: globalThis.origin, storage}; }""")
        print("M-00 first-draft loading: " + json.dumps(first_draft))
        self.assertEqual("about:blank", first_draft["url"])
        self.assertEqual(("null", "null"), (first_draft["location"], first_draft["global"]))
        self.assertNotEqual("no exception", first_draft["storage"])
        h.finish()

    # ── M-01 bound owner: behaviour kept ───────────────────────────────────────────────────────────────────────────
    def test_m01_bound_owner_saves_restores_separates_and_reports(self):
        h = self.harness()
        a = h.page("host.html")
        s = h.module(a, OWNER_A)
        key = PREFIX + OWNER_A
        self.assertEqual({"mode": "automatic", "mode_disabled": False, "search_disabled": False, "clear": False,
                          "clear_disabled": False}, s.controls())
        self.assertEqual({"criteria": C1, "empty": False, "pending": False}, s.read(C1))
        s.mode.select_option("manual")
        writes = [c for c in s.calls_since_mount() if c[0] != "getItem"]
        # The options' meaning is the contract; the serialization (key order, spaces) is the module's own business.
        self.assertEqual([["setItem", key]], [w[:2] for w in writes], "exactly one write, to this owner's key")
        manual_kept = {"version": 1, "mode": "manual", "clearResults": False}
        self.assertEqual(manual_kept, json.loads(writes[0][2]))
        self.assertEqual(manual_kept, json.loads(a.evaluate("k => localStorage.getItem(k)", key)))
        h.criteria(a, C2)
        self.assertEqual({"criteria": C1, "empty": False, "pending": True}, s.read(C2))
        s.call("apply")
        self.assertEqual({"criteria": C2, "empty": False, "pending": False}, s.read(C2))
        s.clear_box.check()
        self.assertEqual({"version": 1, "mode": "manual", "clearResults": True},
                         json.loads(a.evaluate("k => localStorage.getItem(k)", key)))
        # Re-mount on the same origin: the stored options come back, the Clear barrier holds until an explicit apply.
        a.reload()
        s = h.module(a, OWNER_A, C2)
        self.assertEqual({"mode": "manual", "mode_disabled": False, "search_disabled": False, "clear": True,
                          "clear_disabled": False}, s.controls())
        s.call("clear")
        self.assertTrue(s.read(C3)["empty"])
        self.assertTrue(s.read(C3)["empty"], "the barrier survives another read (refresh)")
        s.call("apply")
        self.assertEqual({"criteria": C2, "empty": False, "pending": False}, s.read(C2))
        # The same valid options written with another key order and spaces restore the same way (meaning, not bytes).
        a.evaluate("([k, v]) => localStorage.setItem(k, v)", [key, '{ "clearResults": true,\n "mode": "manual", "version": 1 }'])
        a.reload()
        s = h.module(a, OWNER_A, C2)
        self.assertEqual({"mode": "manual", "mode_disabled": False, "search_disabled": False, "clear": True,
                          "clear_disabled": False}, s.controls())
        expect(s.status).to_have_text("")
        # Stored values the module cannot use: the existing sentence, defaults.
        for bad in ("x" * 201, '{"version":1,"mode":"manual","clearResults":false,"patient":"SYN"}'):
            a.evaluate("([k, v]) => localStorage.setItem(k, v)", [key, bad])
            a.reload()
            s = h.module(a, OWNER_A)
            expect(s.status).to_have_text(UNREADABLE_SAVED)
            self.assertEqual("automatic", s.mode.input_value())
        h.finish()

    def test_m01e_bound_owner_storage_refused_by_the_browser(self):
        h = self.harness()
        page = h.page("sandboxed.html")
        s = h.module(page, OWNER_A)
        expect(s.status).to_have_text(READ_FAILED)
        self.assertEqual("automatic", s.mode.input_value())
        s.mode.select_option("manual")
        expect(s.status).to_have_text(WRITE_FAILED)
        h.criteria(page, C2)
        self.assertEqual({"criteria": C1, "empty": False, "pending": True}, s.read(C2), "Manual still separates in this window")
        h.finish()

    # ── M-02 owner absent at mount ─────────────────────────────────────────────────────────────────────────────────
    def test_m02_ownerless_reads_current_criteria_and_never_touches_storage(self):
        h = self.harness()
        a = h.page("host.html")
        other = PREFIX + OWNER_B
        a.evaluate("([k, v]) => localStorage.setItem(k, v)", [other, STORED_MANUAL])
        s = h.module(a, None)
        self.assertEqual({"criteria": C1, "empty": False, "pending": False}, s.read(C1))
        h.criteria(a, C2)
        s.call("change")
        self.assertEqual({"criteria": C2, "empty": False, "pending": False}, s.read(C2))
        s.call("apply")
        self.assertEqual({"criteria": C2, "empty": False, "pending": False}, s.read(C2))
        h.criteria(a, C3)
        s.call("clear")
        self.assertEqual({"criteria": C3, "empty": False, "pending": False}, s.read(C3))
        self.assertEqual({"mode": "automatic", "mode_disabled": True, "search_disabled": True, "clear": False,
                          "clear_disabled": True}, s.controls())
        expect(s.status).to_have_text("")
        s.force_mode("manual")
        self.assertEqual({"criteria": C3, "empty": False, "pending": False}, s.read(C3))
        self.assertEqual([], s.calls_since_mount(), "no Storage call after the mount")
        self.assertEqual({other: STORED_MANUAL}, s.stored(), "another account's value is untouched and no key is added")
        h.finish()

    def test_m02x_ownerless_with_storage_refused_by_the_browser(self):
        h = self.harness()
        page = h.page("sandboxed.html")
        s = h.module(page, None)
        self.assertEqual({"criteria": C1, "empty": False, "pending": False}, s.read(C1))
        expect(s.status).to_have_text("")
        h.finish()

    # ── M-03..M-05 owner changes after mount ───────────────────────────────────────────────────────────────────────
    def owner_change(self, before, after):
        h = self.harness()
        a = h.page("host.html")
        s = h.module(a, before)
        a.evaluate("o => { window.__synOwner = o; }", after)
        self.assertEqual({"criteria": C1, "empty": True, "pending": False}, s.read(C1), f"{before} -> {after}")
        if not s.mode.is_disabled():
            s.mode.select_option("manual")
        else:
            s.force_mode("manual")
        self.assertEqual([], [c for c in s.calls_since_mount() if c[0] != "getItem"], f"{before} -> {after}: no write")
        self.assertTrue(s.read(C1)["empty"])
        h.finish()

    def test_m03_owner_a_to_b(self):
        self.owner_change(OWNER_A, OWNER_B)
        self.owner_change(OWNER_A, OWNER_A_ELSEWHERE)   # preserving: the same sub at another institution

    def test_m04_ownerless_to_an_owner(self):
        self.owner_change(None, "X")

    def test_m05_owner_a_to_none(self):
        self.owner_change(OWNER_A, None)

    # ── M-06 session end and unrelated signals ─────────────────────────────────────────────────────────────────────
    def session_end(self, owner, signal):
        h = self.harness()
        a = h.page("host.html")
        b = h.page("peer.html")
        s = h.module(a, owner)
        a.evaluate(PROBE)
        before = (s.read(C1), s.controls())
        # Unrelated signals change nothing: read() at the moment the probe receives them equals the read before.
        b.evaluate("() => { const c = new BroadcastChannel('kin-session'); c.postMessage({type: 'other'}); c.close(); }")
        b.evaluate("() => { localStorage.setItem('syn-other', '1'); localStorage.removeItem('syn-other'); }")
        a.wait_for_function("() => __synProbe.length >= 3", timeout=5000)
        seen = a.evaluate("() => __synProbe.slice()")
        self.assertEqual(["channel:{\"type\":\"other\"}", "storage:syn-other=1", "storage:syn-other=null"],
                         [p["signal"] for p in seen])
        for probe in seen:
            self.assertEqual(before[0], probe["read"], f"owner {owner}: {probe['signal']} changed read()")
        self.assertEqual(before[1], s.controls(), f"owner {owner}: an unrelated signal changed the controls")
        # Unbound legacy notices do not end a document; the authority lifecycle does.
        if signal == "channel":
            b.evaluate("() => { const c = new BroadcastChannel('kin-session'); c.postMessage({type: 'session-ended', at: 1}); c.close(); }")
        else:
            b.evaluate("() => { localStorage.setItem('kin-session-ended', String(Date.now())); localStorage.removeItem('kin-session-ended'); }")
        a.wait_for_function("n => __synProbe.length > n", arg=len(seen), timeout=5000)
        self.assertEqual(before[1], s.controls(), "an unbound notice closed the module")
        a.evaluate("synEndPage()")
        expect(s.mode).to_be_disabled()
        expect(s.search).to_be_disabled()
        expect(s.clear_box).to_be_disabled()
        self.assertEqual({"criteria": C1, "empty": True, "pending": False}, s.read(C1), f"owner {owner}, {signal}")
        h.finish()

    def test_m06_session_end_and_unrelated_signals(self):
        for owner in (OWNER_A, None):
            for signal in ("channel", "storage"):
                self.session_end(owner, signal)

    # ── M-07 pagehide ──────────────────────────────────────────────────────────────────────────────────────────────
    def test_m07_pagehide_ends(self):
        for owner in (OWNER_A, None):
            h = self.harness()
            a = h.page("host.html")
            s = h.module(a, owner)
            a.evaluate("() => dispatchEvent(new PageTransitionEvent('pagehide'))")
            self.assertEqual({"criteria": C1, "empty": True, "pending": False}, s.read(C1), f"owner {owner}")
            h.finish()


if __name__ == "__main__":
    unittest.main(verbosity=2)
