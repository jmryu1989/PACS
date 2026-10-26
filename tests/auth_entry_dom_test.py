# coding: utf-8
"""U5S-REQ-06/09, amendments 1/2 -> U5S-RISK-SESSION -> U5S-ENTRY-DOM.

Real auth/gate/transport and clinician document; synthetic callback and API only.
The compiled server suite independently verifies the callback's destination, login
marker, cookie binding and atomic audit. Main uses a small
consumer of the public auth API: this suite does not claim full main-page coverage.
KIN_ENTRY_PAGES optionally supplies clinician.html/js from the parallel pages job;
KIN_ENTRY_AUTH supplies a copied auth.js for mutation testing. No source assertions.

S7-U5 session end (design v2 sections 3.1, 3.2 and 5-1; REQ-S7-U5-SESSION-END R2 -> RISK-S7-U5-SILENT-REENTRY ->
TEST-S7-U5-END-DOM): the landing table (what Login, Switch account and Register do by the origin of the end record,
whose session it names, what storage allows and what /api/me answers - the POST body and binding asserted, entry or
no entry asserted), A011 (Login is never gated on the identity provider's discovery) and A012 (a failed bootstrap
can recover in a fresh document; the arrival notice hides no real end state). Records are written the way auth.js
keeps them: one key per session
(`kin-session-end:<session>`) with an origin.
"""
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading
import unittest
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "worklist-v0" / "hpacs-lite"
PAGES = Path(os.environ.get("KIN_ENTRY_PAGES", ASSETS))
AUTH = Path(os.environ.get("KIN_ENTRY_AUTH", ASSETS / "auth.js"))
# KIN_ENTRY_LANDING supplies a copied index.html for mutation testing (as KIN_ENTRY_AUTH does for auth.js).
LANDING = Path(os.environ.get("KIN_ENTRY_LANDING", ASSETS / "index.html"))
BASE = "/worklist/hpacs-lite/"
PROOF = "SYN-single-entry-proof"
SESSION = "SYN-entry-session"
# The work page of this suite: a small consumer of the public auth API. It shows what auth.js hands a page while another
# window's Log out preparation is alive (init's onHold) the way a page would: as text.
MAIN = """<!doctype html><html><head><meta charset="utf-8"></head><body><p id="work" hidden>Worklist</p><p id="hold"></p>
<script src="auth.js"></script><script src="work-context.js"></script>
<script src="session-transport.js"></script><script>
KinWorkContext.follow(KinAuth);
(async () => {
  const identity = await KinAuth.init({retry:true, onHold: text => { document.getElementById('hold').textContent = text || ''; }});
  if (!identity || identity.state !== 'approved') return;
  const at = KinWorkContext.capture('document');
  const answer = await KinSessionTransport.page().request('/api/syn-work', { context: at });
  if (answer.ok) KinWorkContext.commit(at, () => document.getElementById('work').hidden = false);
})();
</script></body></html>"""
# localStorage that can be read but takes no write (a full store): every write is refused.
STORAGE_FULL = """(() => {
  const set = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (this === window.localStorage) throw new DOMException('SYN full', 'QuotaExceededError');
    return set.call(this, key, value);
  };
})();"""
OTHER = "S0-yesterday"
# The sentence a new document shows while another window's Log out preparation is alive (design 5-1 A017).
PREPARING = "다른 창에서 로그아웃을 준비하고 있습니다"
STORAGE_DENIED = """(() => {
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(window, name, { get() { throw new DOMException('SYN denied', 'SecurityError'); } });
  }
  Object.defineProperty(document, 'cookie', { get() { return ''; }, set() {} });
})();"""


class AuthEntryDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Chromium follows a fulfilled redirect outside Playwright's route handler.
        # A loopback server supplies the real 302 and the final document; API calls
        # still use the per-case route and cannot reach an external service.
        class EntryServer(BaseHTTPRequestHandler):
            def do_GET(self):
                path = urlparse(self.path).path
                if path == "/api/auth/callback":
                    self.send_response(302)
                    self.send_header("Location", BASE + cls.destination + "#kin-login")
                    self.end_headers()
                    return
                name = path.removeprefix(BASE)
                if name == "main.html":
                    content = MAIN.encode()
                elif name == "clinician.html":
                    content = (PAGES / name).read_bytes()
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(content)

            def log_message(self, *args):
                pass

        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), EntryServer)
        cls.origin = "http://127.0.0.1:" + str(cls.server.server_port)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.server_thread.join()

    def setUp(self):
        self.context = self.browser.new_context(service_workers="block")
        self.context.add_init_script("window.synClicks = 0; addEventListener('click', () => window.synClicks++);")
        self.page = self.context.new_page()
        self.page.set_default_timeout(5000)
        self.requests, self.entries, self.documents, self.dialogs, self.errors = [], [], [], [], []
        self.auth_states = []
        self.page.expose_function("synAuthState", lambda event: self.auth_states.append(event))
        self.roles = ["clinician"]
        self.me_code = None
        self.me_absent = False
        self.login_starts = []
        self.me_failures = []
        self.lose_entry = False
        self.real_landing = False
        self.refuse = False
        self.used = False
        self.held_entry = None
        self.hold_entry = False
        self.storage_denied = False
        self.entry_status = None
        # The identity provider's discovery document: 'ok', a status code, or 'hang' (never answered).
        self.discovery = "ok"
        self.discoveries = 0
        # Scripted answers of the next login starts (POST): (status, body) pairs; then the default location.
        self.start_answers = []
        self.held_me = None
        self.hold_me = False
        # Log out POSTs (the session each named) and whether their answer is lost.
        self.logouts = []
        self.logout_lost = False
        self.page.on("request", lambda request: self.documents.append(urlparse(request.url).path)
                     if request.is_navigation_request() else None)
        self.page.on("dialog", lambda dialog: (self.dialogs.append(dialog.message), dialog.dismiss()))
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.context.route("**/*", self.route)

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])
        self.assertEqual(self.dialogs, [])

    def route(self, route):
        request = route.request
        path = urlparse(request.url).path
        if path == "/api/auth/callback":
            return route.continue_()
        if path.startswith(BASE):
            name = path[len(BASE):]
            if name == "main.html":
                return route.fulfill(content_type="text/html", body=MAIN)
            if name == "index.html" and not self.real_landing:
                return route.fulfill(content_type="text/html", body="<!doctype html><p>Login</p>")
            source = AUTH if name == "auth.js" else LANDING if name == "index.html" \
                else (PAGES if name in ("clinician.html", "clinician.js") else ASSETS) / name
            if source.is_file():
                content_type = "text/html" if name.endswith(".html") else "application/javascript" if name.endswith(".js") else "image/svg+xml"
                content = source.read_bytes()
                if name == "auth.js":
                    content += b"\nKinAuth.onLifecycle(event => window.synAuthState(event));"
                return route.fulfill(content_type=content_type, body=content)
        if path.startswith("/api/"):
            self.requests.append((path, request.headers.get("x-kin-session")))
            if path == "/api/auth/entry":
                self.entries.append((request.post_data_json, request.headers, self.page.url))
                if self.hold_entry:
                    self.held_entry = route
                    return
                return self.answer_entry(route)
            if path in ("/api/auth/login", "/api/auth/register"):
                self.login_starts.append((request.method, request.headers, request.post_data, path))
                if request.method == "POST":
                    if self.start_answers:
                        status, body = self.start_answers.pop(0)
                        return route.fulfill(status=status, json=body)
                    return route.fulfill(json={"location": self.origin + "/auth/synthetic-login"})
                return route.fulfill(content_type="text/html", body="<p>Identity provider login</p>")
            if path == "/api/me":
                if self.hold_me:
                    self.held_me = route
                    return
                if self.me_absent:
                    return route.fulfill(status=401, json={})
                if self.me_failures:
                    failure = self.me_failures.pop(0)
                    if failure == "network":
                        return route.abort("failed")
                    if failure == "timeout":
                        return  # The shipped ten-second request deadline aborts this read.
                    return route.fulfill(status=failure, headers={"X-KIN-Auth-Code": "AUTH_IDP_UNAVAILABLE"}, json={})
                if self.me_code:
                    return route.fulfill(status=403, json={"code": self.me_code, "sessionId": SESSION})
                return route.fulfill(json={"sub": "SYN-sub", "actor": "SYN-doctor", "user": "SYN-doctor",
                                           "displayName": "SYN Doctor", "roles": self.roles, "kind": "member",
                                           "institution": "SYN-hospital", "sessionId": SESSION})
            if path == "/api/clinician/studies":
                return route.fulfill(json={"studies": [], "pagination": {"limit": 100, "offset": 0, "total": 0, "next": None}})
            if path == "/api/critical-results":
                return route.fulfill(json={"items": [], "nextCursor": None})
            if path == "/api/syn-work":
                return route.fulfill(json={"ok": True})
            if path == "/api/auth/logout":
                self.logouts.append(request.headers.get("x-kin-session"))
                if self.logout_lost:
                    return route.abort("failed")
                return route.fulfill(status=204, body="")
        if path == "/auth/synthetic-login":
            return route.fulfill(content_type="text/html", body="<p>Identity provider login</p>")
        if path == "/auth/realms/kin/.well-known/openid-configuration":
            self.discoveries += 1
            if self.discovery == "hang":
                return  # The shipped deadline ends this check.
            return route.fulfill(json={}) if self.discovery == "ok" else route.fulfill(status=self.discovery, json={})
        if path.startswith("/branding/"):
            return route.fulfill(body="", content_type="image/svg+xml")
        self.errors.append("Unexpected request: " + request.method + " " + path)
        route.abort()

    def answer_entry(self, route):
        if self.refuse or self.used:
            return route.fulfill(status=403, json={"code": "AUTH_ENTRY_REFUSED"})
        self.used = True
        if self.lose_entry:
            return route.abort("failed")
        if self.entry_status:
            return route.fulfill(status=self.entry_status, json={})
        return route.fulfill(json={"sessionId": SESSION})

    def starts(self):
        """The login starts so far: (method, path, the session the request named, its JSON body)."""
        return [(method, path.rsplit("/", 1)[1], headers.get("x-kin-session"), json.loads(body) if body else None)
                for method, headers, body, path in self.login_starts]

    def test_bootstrap_failure_lands_and_fresh_document_recovers(self):
        self.me_failures = [503]
        self.login()
        self.page.wait_for_url("**/index.html")
        self.login()
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "empty")
        self.assert_entry()

    def assert_entered_without_a_click(self, proofs=0):
        """The document is at work in the live session: nothing was pressed, the proof was not offered again, and no
        login start or logout went out."""
        self.assertEqual(len(self.entries), proofs)
        self.assertEqual(self.login_starts, [])
        self.assertFalse(any(path == "/api/auth/logout" for path, _ in self.requests))
        self.assertEqual(self.page.evaluate("window.synClicks"), 0)
        self.assertEqual(self.page.evaluate("KinAuth.sessionId()"), SESSION)





    def test_the_arrival_notice_hides_no_real_end_state(self):
        # A012: a recorded unfinished Log out wins the text and keeps Retry Log Out, whatever notice the address carried.
        self.landing(SESSION, status="unconfirmed", reason="network")
        expect(self.page.locator("#msg")).to_contain_text("서버에 연결하지 못해")
        expect(self.page.locator("#msg")).not_to_contain_text("업무 화면을 열지 않았습니다")
        expect(self.page.locator("#retry-logout")).to_be_visible()
        self.assertEqual(urlparse(self.page.url).query, "")
        self.assertEqual(self.requests, [("/api/me", None)], "the recorded end of this session still wins after bootstrap")

    def landing(self, record=None, query="?auth_error=stale", origin="logout", status="confirmed", reason=None,
                raw=None, script=None, expect_button=True):
        """The real landing in a browser that holds `record` (a session id) as an end record of that origin and status,
        or the raw storage entries `raw` ({key: text}). `script` is a further init script (after the seeding)."""
        self.real_landing = True
        entries = dict(raw or {})
        if record:
            value = {"session": record, "operation": 1, "status": status}
            if origin:
                value["origin"] = origin
            if reason:
                value["reason"] = reason
            entries["kin-session-end:" + record] = json.dumps(value)
        if entries:
            self.context.add_init_script("""if (!sessionStorage.getItem('syn-seeded')) {
              sessionStorage.setItem('syn-seeded','1');
              for (const [key, text] of Object.entries(%s)) localStorage.setItem(key, text);
            }""" % json.dumps(entries))
        if script:
            self.context.add_init_script(script)
        self.page.goto(self.origin + BASE + "index.html" + query)
        if expect_button:
            expect(self.page.locator('#signin')).to_be_enabled()


    def test_confirmation_login_with_own_end_starts_bound_explicit_login(self):
        self.landing(SESSION)
        self.page.locator('#signin').click()
        self.page.wait_for_url('**/auth/synthetic-login')
        self.assertEqual(len(self.login_starts), 1)
        method, headers, _, _ = self.login_starts[0]
        self.assertEqual(method, 'POST')
        self.assertEqual(headers.get('x-kin-session'), SESSION)
        self.assertIsNone(headers.get('x-kin-csrf'))
        self.assertEqual(self.starts(), [('POST', 'login', SESSION, {'intent': 'reauthenticate', 'reason': 'logout_unfinished'})])
        self.assertNotIn('active', [event['state'] for event in self.auth_states])

    def test_confirmation_login_with_untrusted_storage_starts_bound_explicit_login(self):
        self.context.add_init_script(STORAGE_DENIED)
        self.landing()
        self.page.locator('#signin').click()
        self.page.wait_for_url('**/auth/synthetic-login')
        self.assertEqual(len(self.login_starts), 1)
        self.assertEqual(self.starts(), [('POST', 'login', SESSION, {'intent': 'reauthenticate', 'reason': 'storage_untrusted'})])
        self.assertNotIn('active', [event['state'] for event in self.auth_states])

    def test_login_without_a_session_after_an_explicit_logout_declares_the_unfinished_logout(self):
        # The browser holds the person's Log out record and the server has no session (the day after an explicit Log
        # out): the start is the POST with the intent - unbound, there is no session to name - never the plain link.
        self.me_absent = True
        self.landing(OTHER)
        self.page.locator('#signin').click()
        self.page.wait_for_url('**/auth/synthetic-login')
        self.assertEqual(self.starts(), [('POST', 'login', None, {'intent': 'reauthenticate', 'reason': 'logout_unfinished'})])
        self.assertNotIn('active', [event['state'] for event in self.auth_states])

    def test_confirmation_transient_failure_allows_same_login_button_to_retry(self):
        self.me_failures = [503]
        self.landing(OTHER)
        self.assertEqual(self.login_starts, [])
        self.page.locator('#signin').click()
        expect(self.page.locator('#list-state')).to_have_attribute('data-state', 'empty')
        self.assertEqual(self.login_starts, [])

    def test_ordinary_landing_old_record_also_enters_without_revoking_live_session(self):
        self.landing(OTHER, query='', expect_button=False)
        expect(self.page.locator('#list-state')).to_have_attribute('data-state', 'empty')
        self.assertEqual(self.login_starts, [])

    def test_confirmation_network_failure_retries_bootstrap_without_starting_login(self):
        self.me_failures = ['network']
        self.landing(OTHER, expect_button=False)
        expect(self.page.locator('#list-state')).to_have_attribute('data-state', 'empty')
        self.assertEqual(self.login_starts, [])

    def login(self, destination="clinician.html", denied=True):
        type(self).destination = destination
        if denied and not self.storage_denied:
            self.context.add_init_script(STORAGE_DENIED)
            self.storage_denied = True
        self.page.goto(self.origin + "/api/auth/callback?code=SYN-code&state=SYN-state")

    def assert_entry(self):
        self.assertEqual(self.entries, [])
        self.assertEqual(self.requests[0], ("/api/me", None))
        for path, binding in self.requests[1:]:
            if path in ("/api/clinician/studies", "/api/syn-work"):
                self.assertEqual(binding, SESSION, path)
        self.assertEqual(self.page.evaluate("window.synClicks"), 0)


    def test_clinician_storage_denied_enters_final_page_once_without_click(self):
        self.login()
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "empty")
        expect(self.page.locator("#actor")).to_have_text("SYN Doctor")
        self.assertEqual(self.page.evaluate("KinAuth.lifecycle().state"), "active")
        self.assertEqual(self.page.evaluate("KinWorkContext.state()"), "active")
        self.assertEqual(self.documents, ["/api/auth/callback", BASE + "clinician.html"])
        self.page.evaluate("Promise.all([KinAuth.init(), KinAuth.init()])")
        self.assert_entry()

    def test_explicit_login_with_full_storage_or_unreadable_record_enters_once(self):
        for fault in (STORAGE_FULL, "localStorage.setItem('kin-session-end:old', '{unreadable');"):
            with self.subTest(fault=fault):
                self.renew()
                self.context.add_init_script(fault)
                self.login(denied=False)
                expect(self.page.locator('#list-state')).to_have_attribute('data-state', 'empty')
                self.assertEqual(self.page.evaluate('KinAuth.lifecycle().state'), 'active')
                self.assertEqual(urlparse(self.page.url).fragment, '')
                self.assert_entry()

    def test_callback_marker_is_consumed_and_does_not_bypass_its_session_end(self):
        self.login()
        expect(self.page.locator('#list-state')).to_have_attribute('data-state', 'empty')
        self.assertEqual(urlparse(self.page.url).fragment, '')
        self.page.reload()
        self.page.wait_for_url('**/index.html')
        self.renew()
        self.context.add_init_script("""localStorage.setItem('kin-session-end:' + %s, JSON.stringify({
            session: %s, operation: Date.now(), status: 'confirmed', origin: 'logout', reason: null }));"""
            % (json.dumps(SESSION), json.dumps(SESSION)))
        self.login(denied=False)
        self.page.wait_for_url('**/index.html')
        self.assertFalse(any(path == '/api/clinician/studies' for path, _ in self.requests))

    def test_reader_admin_and_mixed_destinations_unchanged(self):
        for roles in (["radiologist"], ["technician"], ["admin"], ["clinician", "radiologist"], ["clinician", "admin"]):
            with self.subTest(roles=roles):
                self.roles, self.used = roles, False
                self.entries.clear()
                self.requests.clear()
                self.login("main.html")
                expect(self.page.locator("#work")).to_be_visible()
                self.assertEqual(urlparse(self.page.url).path, BASE + "main.html")
                self.assert_entry()



    def test_bootstrap_current_roles_choose_the_work_document(self):
        self.roles = ["clinician"]
        self.login("main.html")
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "empty")
        self.assertEqual(urlparse(self.page.url).path, BASE + "clinician.html")
        self.assertEqual(self.entries, [])

    def test_pending_and_invalid_membership_display_no_work(self):
        for code, title in (("INSTITUTION_PENDING", "Pending Approval"), ("INSTITUTION_INVALID", "Account Setup Required")):
            with self.subTest(code=code):
                self.me_code, self.used = code, False
                self.entries.clear()
                self.requests.clear()
                self.login()
                expect(self.page.locator("#membership-title")).to_have_text(title)
                expect(self.page.locator("#home")).to_be_hidden()
                self.assertEqual(self.requests, [("/api/me", None)])
                self.assert_entry()

    def test_role_change_that_still_permits_clinician_document_keeps_entry(self):
        for roles in (["admin"], ["clinician", "radiologist"], ["clinician", "technician"]):
            with self.subTest(roles=roles):
                self.roles, self.used = roles, False
                self.entries.clear()
                self.requests.clear()
                self.login()
                expect(self.page.locator("#list-state")).to_have_attribute("data-state", "empty")
                self.assertEqual(self.page.evaluate("KinWorkContext.state()"), "active")
                self.assertEqual(urlparse(self.page.url).path, BASE + "clinician.html")
                self.assert_entry()

    def test_no_work_before_bootstrap_and_concurrent_init_shares_one_read(self):
        self.hold_me = True
        self.login()
        self.page.wait_for_function("typeof KinAuth !== 'undefined'")
        self.assertIsNotNone(self.held_me)
        self.page.evaluate("void KinAuth.init(); void KinAuth.init();")
        self.assertEqual(self.requests, [("/api/me", None)])
        self.assertEqual(self.page.evaluate("KinWorkContext.state()"), "unknown")
        self.hold_me = False
        self.held_me.fulfill(json={"sub": "SYN-sub", "actor": "SYN-doctor", "displayName": "SYN Doctor", "roles": self.roles, "kind": "member", "institution": "SYN-hospital", "sessionId": SESSION})
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "empty")
        self.assert_entry()


    # ── S7-U5 session end: the landing table (design 3.2 as amended by v2 and 5-1) ──

    def renew(self):
        """A new browser profile for the next row of a table."""
        self.assertEqual((self.errors, self.dialogs), ([], []))
        self.context.close()
        self.setUp()

    def record(self, session, **fields):
        """An end record as auth.js keeps it, as storage entries: one key per session."""
        # (a recent request number: auth.js drops server_end / replaced records older than the SSO lifetime)
        value = {"session": session, "operation": int(time.time() * 1000) - 60_000, "status": "confirmed", "origin": "logout", **fields}
        return {"kin-session-end:" + session: json.dumps({key: item for key, item in value.items() if item is not None})}

    def press(self, button, outcome):
        self.page.locator(button).click()
        if outcome[0] == "enter":
            expect(self.page.locator("#list-state")).to_have_attribute("data-state", "empty")
            self.assertEqual(self.starts(), [], "entered the live session: nothing was started or ended")
            self.assertEqual(self.page.evaluate("KinAuth.sessionId()"), SESSION)
        elif outcome[0] == "post":
            self.page.wait_for_url("**/auth/synthetic-login")
            self.assertEqual(self.starts(), [("POST",) + tuple(outcome[1:])])
            self.assertNotIn("x-kin-csrf", self.login_starts[0][1])
            self.assertNotIn("active", [event["state"] for event in self.auth_states], "no entry before the re-authentication")
        else:
            self.page.wait_for_url("**/api/auth/" + outcome[1])
            self.assertEqual(self.starts(), [("GET", outcome[1], None, None)])

    def test_landing_table(self):
        """What a new landing document does by itself and what its buttons do, by the origin of the end record, whose
        session it names, what storage allows and what /api/me answers (design 3.2)."""
        REAUTH = lambda reason: {"intent": "reauthenticate", "reason": reason}
        old = {"kin-session-end": json.dumps({"session": OTHER, "operation": 1, "status": "confirmed"})}
        own, other = (lambda **f: self.record(SESSION, **f)), (lambda **f: self.record(OTHER, **f))
        # label, storage entries, init script, session alive?, at load (what, /api/me requests), button, outcome
        table = (
            ("no record, a live session", {}, None, True, ("enter", 1), None, None),
            ("no record, no session", {}, None, False, ("login", 1), None, None),
            ("own logout, confirmed", own(), None, True, ("landing", 1), "#signin", ("post", "login", SESSION, REAUTH("logout_unfinished"))),
            ("own logout, unconfirmed", own(status="unconfirmed", reason="network"), None, True, ("landing", 1), "#signin",
             ("post", "login", SESSION, REAUTH("logout_unfinished"))),
            ("own logout, still ending", own(status="ending"), None, True, ("landing", 1), "#signin",
             ("post", "login", SESSION, REAUTH("logout_unfinished"))),
            ("another session's logout (yesterday), a live session", other(), None, True, ("enter", 1), None, None),
            ("another session's logout, no session", other(), None, False, ("landing", 1), "#signin",
             ("post", "login", None, REAUTH("logout_unfinished"))),
            ("another session ended by the server, a live session", other(origin="server_end"), None, True, ("enter", 1), None, None),
            ("another session ended by the server, no session", other(origin="server_end"), None, False, ("login", 1), None, None),
            ("another session replaced by a login", other(origin="replaced", status="unconfirmed", reason="replaced"), None, True,
             ("enter", 1), None, None),
            ("the live session recorded as ended by the server", own(origin="server_end"), None, True, ("landing", 1), "#signin",
             ("post", "login", SESSION, REAUTH("record_unreadable"))),
            ("a record without an origin", other(origin=None), None, True, ("landing", 0), "#signin",
             ("post", "login", SESSION, REAUTH("record_unreadable"))),
            ("a record from before the per-session keys", old, None, True, ("landing", 0), "#signin",
             ("post", "login", SESSION, REAUTH("record_unreadable"))),
            ("a record from before the per-session keys, no session", old, None, False, ("landing", 0), "#signin",
             ("post", "login", None, REAUTH("record_unreadable"))),
            ("a record that cannot be read", {"kin-session-end:" + OTHER: "{broken"}, None, True, ("landing", 0), "#signin",
             ("post", "login", SESSION, REAUTH("record_unreadable"))),
            ("storage that cannot be read", {}, STORAGE_DENIED, True, ("landing", 0), "#signin",
             ("post", "login", SESSION, REAUTH("storage_untrusted"))),
            ("storage that cannot be read, no session", {}, STORAGE_DENIED, False, ("landing", 0), "#signin",
             ("post", "login", None, REAUTH("storage_untrusted"))),
            ("storage that takes no write", {}, STORAGE_FULL, True, ("landing", 0), "#signin",
             ("post", "login", SESSION, REAUTH("storage_untrusted"))),
            ("Switch account, a live session", own(), None, True, ("landing", 1), "#switch",
             ("post", "login", SESSION, REAUTH("switch_account"))),
            ("Switch account, no session", other(), None, False, ("landing", 1), "#switch",
             ("post", "login", None, REAUTH("switch_account"))),
            ("Register, a live session", own(), None, True, ("landing", 1), "#register", ("post", "register", SESSION, None)),
            ("Register, no session", other(), None, False, ("landing", 1), "#register", ("get", "register")),
        )
        for label, entries, script, alive, (at_load, asked), button, outcome in table:
            with self.subTest(row=label):
                self.renew()
                self.me_absent = not alive
                self.landing(raw=entries, query="", script=script, expect_button=False)
                if at_load == "enter":
                    expect(self.page.locator("#list-state")).to_have_attribute("data-state", "empty")
                    self.assert_entered_without_a_click(proofs=0)
                elif at_load == "login":
                    self.page.wait_for_url("**/api/auth/login")
                    self.assertEqual((self.starts(), self.page.evaluate("window.synClicks")), ([("GET", "login", None, None)], 0))
                else:
                    expect(self.page.locator("#signin")).to_be_enabled()
                    self.page.wait_for_timeout(700)
                    self.assertEqual(urlparse(self.page.url).path, BASE + "index.html", "no entry and no login by itself")
                    self.assertEqual(self.starts(), [])
                if at_load == "landing":
                    self.assertEqual(len([1 for path, _ in self.requests if path == "/api/me"]), asked, "what the landing asked by itself")
                else:
                    self.assertEqual(self.requests[0], ("/api/me", None), "the ordinary entry asks the server once, unbound")
                if button:
                    self.press(button, outcome)

    def test_login_over_another_sessions_record_clears_that_record_only(self):
        # The explicit Login confirmed the live session: the earlier session's record is taken over, nothing else.
        self.landing(OTHER, query="", expect_button=False)
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "empty")
        self.assertEqual(self.page.evaluate("Object.keys(localStorage).filter(key => key.startsWith('kin-session-end'))"), [])
        self.assertEqual(self.starts(), [])

    def test_a_start_refused_for_a_changed_session_ends_nothing_and_asks_again(self):
        # The browser's session changed between the check and the start (another tab logged in): the server refuses.
        self.start_answers = [(409, {"code": "AUTH_SESSION_MISMATCH", "message": "SYN"})]
        self.landing(SESSION, query="")
        self.page.locator("#signin").click()
        expect(self.page.locator("#msg")).to_contain_text("로그인 세션이 바뀌어")
        self.assertEqual(urlparse(self.page.url).path, BASE + "index.html")

    # ── A011: the identity provider's discovery never gates Login ──

    def test_discovery_failure_does_not_disable_login_and_is_checked_again(self):
        self.discovery = 503
        self.me_absent = True
        self.landing(OTHER, query="")
        expect(self.page.locator("#signin")).to_be_enabled()
        expect(self.page.locator("#stat")).to_contain_text("연결하지 못했습니다")
        text = self.page.locator("body").inner_text()
        self.assertNotIn("docker", text.lower())
        self.assertNotIn("Keycloak", text)
        # The provider is back: the status line finds out when the person returns to the window - no reload. The return
        # comes right after the last check (SEB-F07): it is not dropped, it is done once that check's gap is over -
        # without a further event; and once connected, nothing asks again.
        self.discovery = "ok"
        self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(self.page.locator("#stat")).to_contain_text("연결됨", timeout=5000)
        asked = self.discoveries
        self.page.wait_for_timeout(3500)
        self.assertEqual(self.discoveries, asked, "connected: no further check")
        # ... and a live session is entered with /api/me alone, whatever the provider does.
        self.discovery = 503
        self.me_absent = False
        self.page.locator("#signin").click()
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "empty")
        self.assertEqual(self.starts(), [])

    def test_a_status_line_that_stays_unreachable_is_checked_once_per_return_and_never_polled(self):
        # SEB-F07, the opposite side: one deferred check per return to the window, no loop of checks.
        self.discovery = 503
        self.me_absent = True
        self.landing(OTHER, query="")
        expect(self.page.locator("#stat")).to_contain_text("연결하지 못했습니다")
        self.page.evaluate("window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange'))")
        self.page.wait_for_timeout(3600)
        after_return = self.discoveries
        self.page.wait_for_timeout(4000)
        self.assertEqual((after_return, self.discoveries), (2, 2), "the load's check and one check for the return; then none")
        self.assertEqual(self.starts(), [], "no move to the provider by itself")

    def test_discovery_that_never_answers_ends_by_its_deadline_and_login_stays_usable(self):
        self.discovery = "hang"
        self.me_absent = True
        self.landing(OTHER, query="")
        expect(self.page.locator("#signin")).to_be_enabled()
        self.assertNotIn("확인 중", self.page.locator("#signin").inner_text())
        expect(self.page.locator("#stat")).to_contain_text("연결하지 못했습니다", timeout=8000)
        self.me_absent = False
        self.page.locator("#signin").click()
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "empty")

    def test_login_that_needs_the_provider_does_not_leave_for_an_unreachable_one(self):
        # No session and nothing recorded: Login would go to the provider. It is unreachable: the person stays on the
        # landing with a sentence (not a proxy error page), and the same button works when it is back.
        self.discovery = 503
        self.me_absent = True
        self.landing(query="?auth_error=stale")
        self.page.locator("#signin").click()
        expect(self.page.locator("#msg")).to_contain_text("인증 서버에 연결하지 못했습니다")
        self.assertEqual((urlparse(self.page.url).path, self.starts()), (BASE + "index.html", []))
        self.discovery = "ok"
        self.page.locator("#signin").click()
        self.page.wait_for_url("**/api/auth/login")
        expect(self.page.locator("body")).to_contain_text("Identity provider login")

    # ── A017: `leaving` - Log Out pressed, not ended ──

    def work(self, page=None):
        page = page or self.page
        page.goto(self.origin + BASE + "main.html")
        expect(page.locator("#work")).to_be_visible()
        return page

    def end_records(self, page=None):
        return (page or self.page).evaluate("""Object.fromEntries(Object.keys(localStorage)
            .filter(key => key.startsWith('kin-session-end')).map(key => [key, JSON.parse(localStorage.getItem(key))]))""")

    def test_leaving_is_written_at_once_closes_nobody_and_only_its_own_cancel_removes_it(self):
        self.roles = ["radiologist"]
        first = self.work()
        second = self.work(self.context.new_page())
        second.evaluate("() => { window.synHeard = []; new BroadcastChannel('kin-session').onmessage = event => { window.synHeard.push(event.data.type); }; }")
        self.assertTrue(first.evaluate("KinAuth.leaving('P1')"))
        records = self.end_records(first)
        self.assertEqual(list(records), ["kin-session-end:" + SESSION])
        self.assertEqual({key: records["kin-session-end:" + SESSION][key] for key in ("session", "status", "origin", "preparation")},
                         {"session": SESSION, "status": "leaving", "origin": "logout", "preparation": "P1"})
        # Nobody is told, nobody closes: the other tab works on, and a tab opened now enters as usual (the window that
        # pressed Log Out is alive - its unsaved text must not be put at risk).
        second.evaluate("window.dispatchEvent(new Event('focus'))")
        second.wait_for_timeout(300)
        self.assertEqual((second.evaluate("KinAuth.lifecycle().state"), second.evaluate("window.synHeard"), first.evaluate("KinAuth.lifecycle().state")),
                         ("active", [], "active"))
        # A tab opened now follows the preparing pause (A017, SEB-F06): it says so, does not enter, and ends nothing.
        third = self.context.new_page()
        third.goto(self.origin + BASE + "main.html")
        expect(third.locator("#hold")).to_contain_text(PREPARING)
        third.wait_for_timeout(300)
        self.assertEqual((third.evaluate("KinAuth.lifecycle().state"), third.evaluate("KinAuth.endState()")), ("unknown", None))
        expect(third.locator("#work")).to_be_hidden()
        # Another preparation's cancel leaves it; its own cancel (Back to Editing) removes it and nothing else.
        first.evaluate("KinAuth.cancelLeaving('P-other')")
        self.assertEqual(self.end_records(first)["kin-session-end:" + SESSION]["status"], "leaving")
        first.evaluate("KinAuth.cancelLeaving('P1')")
        self.assertEqual(self.end_records(first), {})
        # ... and the waiting tab goes on into the same session by itself: no click.
        expect(third.locator("#work")).to_be_visible()
        expect(third.locator("#hold")).to_have_text("")
        self.assertEqual((third.evaluate("KinAuth.sessionId()"), third.evaluate("window.synClicks")), (SESSION, 0))
        self.assertEqual((self.login_starts, self.logouts), ([], []))

    def test_a_leaving_whose_window_is_gone_is_an_unfinished_logout(self):
        self.roles = ["radiologist"]
        self.real_landing = True
        first = self.work()
        self.assertTrue(first.evaluate("KinAuth.leaving('P2')"))
        first.close()
        # The next person opens the landing (or the work page): no entry by itself, although the session is alive.
        self.page = self.context.new_page()
        self.page.set_default_timeout(5000)
        self.requests.clear()
        self.auth_states.clear()
        self.page.goto(self.origin + BASE + "index.html")
        expect(self.page.locator("#msg")).to_contain_text("로그아웃을 시작한 창이 닫혀")
        expect(self.page.locator("#retry-logout")).to_be_visible()
        self.assertEqual(([("/api/me", None)], urlparse(self.page.url).path), (self.requests, BASE + "index.html"))
        # Login there is the re-authentication of the unfinished Log out, bound to that session.
        self.press("#signin", ("post", "login", SESSION, {"intent": "reauthenticate", "reason": "logout_unfinished"}))

    def test_logout_promotes_its_leaving_to_the_end_record(self):
        self.roles = ["radiologist"]
        first = self.work()
        first.evaluate("KinAuth.leaving('P3')")
        first.evaluate("void KinAuth.logout()")
        first.wait_for_url("**/index.html")
        record = self.end_records(first)["kin-session-end:" + SESSION]
        self.assertEqual((record["status"], record["origin"], record.get("preparation")), ("confirmed", "logout", None))
        self.assertEqual([path for path, _ in self.requests if path == "/api/auth/logout"], ["/api/auth/logout"])

    def test_a_new_landing_during_another_windows_preparation_waits_says_so_and_ends_nothing(self):
        # A017 / SEB-F06 on the real landing: it says the Log out is being prepared in another window and waits; Login
        # meanwhile neither enters nor ends anything. When that window completes its Log out, the landing shows the end.
        self.roles = ["radiologist"]
        self.real_landing = True
        first = self.work()
        self.assertTrue(first.evaluate("KinAuth.leaving('P6')"))
        landing = self.context.new_page()
        landing.goto(self.origin + BASE + "index.html")
        expect(landing.locator("#msg")).to_contain_text(PREPARING)
        landing.locator("#signin").click()
        landing.wait_for_timeout(500)
        expect(landing.locator("#msg")).to_contain_text(PREPARING)
        self.assertEqual((urlparse(landing.url).path, self.login_starts, self.logouts), (BASE + "index.html", [], []))
        self.assertEqual(landing.evaluate("KinAuth.lifecycle().state"), "unknown")
        first.evaluate("void KinAuth.logout()")
        expect(landing.locator("#msg")).to_contain_text("끝냈습니다")
        landing.wait_for_timeout(500)
        self.assertEqual((urlparse(landing.url).path, self.login_starts, self.logouts), (BASE + "index.html", [], [SESSION]))

    def test_untrusted_storage_with_a_live_preparation_waits_then_keeps_the_storage_rule(self):
        # SEB-F04: storage that takes no write (records fall back to cookies). A window of this browser (entered through
        # its login proof) prepares its Log out. A new landing waits for that preparation and ends nothing; when the
        # preparation is cancelled the storage rule still decides - no entry by itself, the explicit Login only.
        self.roles = ["radiologist"]
        self.login("main.html", denied=False)
        expect(self.page.locator("#work")).to_be_visible()
        first = self.page
        first.evaluate(STORAGE_FULL)
        self.context.add_init_script(STORAGE_FULL)
        self.assertTrue(first.evaluate("KinAuth.leaving('P7')"))
        self.assertIn("kin-session-end.", first.evaluate("document.cookie"))
        self.real_landing = True
        self.requests.clear()
        landing = self.context.new_page()
        landing.goto(self.origin + BASE + "index.html")
        expect(landing.locator("#msg")).to_contain_text(PREPARING)
        landing.locator("#signin").click()
        landing.wait_for_timeout(500)
        self.assertEqual((self.login_starts, self.logouts), ([], []), "the live preparation is neither ended nor re-authenticated")
        first.evaluate("KinAuth.cancelLeaving('P7')")
        expect(landing.locator("#msg")).to_contain_text("로그아웃 상태를 확인할 수 없어")
        landing.wait_for_timeout(700)
        self.assertEqual((urlparse(landing.url).path, landing.evaluate("KinAuth.lifecycle().state"), self.login_starts),
                         (BASE + "index.html", "unknown", []))
        self.assertEqual([path for path, _ in self.requests if path == "/api/me"], ["/api/me"], "only the Login press asked the server")

    def test_a_server_end_never_downgrades_the_same_sessions_logout(self):
        # SEB-F03 (design 5-0 item 8): the person pressed Log Out (its marker has origin logout) and a request then learns
        # that the server ended the session. The record keeps the person's origin, so a new landing stays at the explicit
        # Log out and starts no login by itself. (A server end alone does not stop new documents: the landing table.)
        self.roles = ["radiologist"]
        first = self.work()
        self.assertTrue(first.evaluate("KinAuth.leaving('P8')"))
        first.evaluate("KinAuth.authFailure({ session: KinAuth.sessionId(), code: 'AUTH_SESSION_ENDED' })")
        record = self.end_records(first)["kin-session-end:" + SESSION]
        self.assertEqual((record["status"], record["origin"]), ("confirmed", "logout"))
        first.close()
        self.real_landing = True
        self.me_absent = True
        self.page = self.context.new_page()
        self.page.set_default_timeout(5000)
        self.page.goto(self.origin + BASE + "index.html")
        expect(self.page.locator("#msg")).to_contain_text("끝냈습니다")
        self.page.wait_for_timeout(700)
        self.assertEqual((urlparse(self.page.url).path, self.starts()), (BASE + "index.html", []))

    def seed_once(self, entries):
        """Storage entries put once per browser profile (not again in each new tab, unlike landing())."""
        self.context.add_init_script("""if (!localStorage.getItem('syn-seeded-once')) {
          localStorage.setItem('syn-seeded-once', '1');
          for (const [key, text] of Object.entries(%s)) localStorage.setItem(key, text);
        }""" % json.dumps(entries))

    def test_a_stale_landings_retry_after_a_new_login_writes_no_record(self):
        # SEB-F05 (design 5-1 A014): tab A is the landing of an unfinished Log out of S0 (its POST was lost). Tab B logs
        # in (the live session; S0's record is taken over). Tab A's Retry Log Out - its POST lost too - is sent but does
        # not bring S0's record back: a new tab then enters the live session with no click.
        self.roles = ["radiologist"]
        self.real_landing = True
        self.me_absent = True
        self.seed_once(self.record(OTHER, status="unconfirmed", reason="network"))
        stale = self.page
        stale.goto(self.origin + BASE + "index.html")
        expect(stale.locator("#retry-logout")).to_be_visible()
        self.me_absent = False
        fresh = self.context.new_page()
        fresh.goto(self.origin + BASE + "index.html")
        fresh.wait_for_url("**/main.html")
        expect(fresh.locator("#work")).to_be_visible()
        self.assertEqual(self.end_records(fresh), {})
        self.logout_lost = True
        stale.locator("#retry-logout").click()
        # The notice before and after a lost retry is the same sentence: wait for the retry itself to end.
        expect(stale.locator("#retry-logout")).to_be_enabled()
        expect(stale.locator("#msg")).to_contain_text("서버에 연결하지 못해")
        self.assertEqual(self.logouts, [OTHER], "the Retry was sent, naming its own session")
        self.assertEqual(self.end_records(stale), {}, "no record of the old session is made again")
        third = self.context.new_page()
        third.goto(self.origin + BASE + "index.html")
        third.wait_for_url("**/main.html")
        expect(third.locator("#work")).to_be_visible()
        self.assertEqual((third.evaluate("KinAuth.sessionId()"), third.evaluate("window.synClicks"), self.starts()), (SESSION, 0, []))

    def test_the_retry_of_a_still_recorded_unfinished_logout_keeps_recording(self):
        # SEB-F05, the opposite side: the Log out is genuinely unfinished (its record is still here). Retry Log Out writes
        # its attempt and result as before - lost: still unconfirmed (and new tabs keep landing); answered: confirmed.
        self.real_landing = True
        self.me_absent = True
        self.seed_once(self.record(OTHER, status="unconfirmed", reason="network", operation=1))
        self.page.goto(self.origin + BASE + "index.html")
        self.logout_lost = True
        self.page.locator("#retry-logout").click()
        # The notice before and after a lost retry is the same sentence: wait for the retry itself to end.
        expect(self.page.locator("#retry-logout")).to_be_enabled()
        expect(self.page.locator("#msg")).to_contain_text("서버에 연결하지 못해")
        record = self.end_records()["kin-session-end:" + OTHER]
        self.assertEqual((record["status"], record["origin"], record.get("reason"), record["operation"] > 1), ("unconfirmed", "logout", "network", True))
        self.logout_lost = False
        self.page.locator("#retry-logout").click()
        expect(self.page.locator("#msg")).to_contain_text("끝냈습니다")
        self.assertEqual(self.end_records()["kin-session-end:" + OTHER]["status"], "confirmed")
        self.assertEqual(self.logouts, [OTHER, OTHER])


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
