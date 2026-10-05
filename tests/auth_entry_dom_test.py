# coding: utf-8
"""U5S-REQ-06/09, amendments 1/2 -> U5S-RISK-SESSION -> U5S-ENTRY-DOM.

Real auth/gate/transport and clinician document; synthetic callback and API only.
The compiled server suite independently verifies the callback's destination, proof
expiry, cookie binding, single consumption and atomic audit. Main uses a small
consumer of the public auth API: this suite does not claim full main-page coverage.
KIN_ENTRY_PAGES optionally supplies clinician.html/js from the parallel pages job;
KIN_ENTRY_AUTH supplies a copied auth.js for mutation testing. No source assertions.
"""
import os
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
BASE = "/worklist/hpacs-lite/"
PROOF = "SYN-single-entry-proof"
SESSION = "SYN-entry-session"
MAIN = """<!doctype html><html><body><p id="work" hidden>Worklist</p>
<script src="auth.js"></script><script src="work-context.js"></script>
<script src="session-transport.js"></script><script>
KinWorkContext.follow(KinAuth);
(async () => {
  const identity = await KinAuth.init({retry:true});
  if (!identity || identity.state !== 'approved') return;
  const at = KinWorkContext.capture('document');
  const answer = await KinSessionTransport.page().request('/api/syn-work', { context: at });
  if (answer.ok) KinWorkContext.commit(at, () => document.getElementById('work').hidden = false);
})();
</script></body></html>"""
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
                    self.send_header("Location", BASE + cls.destination + "#kin-entry=" + PROOF)
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
            source = AUTH if name == "auth.js" else (PAGES if name in ("clinician.html", "clinician.js") else ASSETS) / name
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
            if path == "/api/auth/login":
                self.login_starts.append((request.method, request.headers, request.post_data))
                if request.method == "POST":
                    return route.fulfill(json={"location": self.origin + "/auth/synthetic-login"})
                return route.fulfill(content_type="text/html", body="<p>Identity provider login</p>")
            if path == "/api/me":
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
        if path == "/auth/synthetic-login":
            return route.fulfill(content_type="text/html", body="<p>Identity provider login</p>")
        if path == "/auth/realms/kin/.well-known/openid-configuration":
            return route.fulfill(json={})
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
        return route.fulfill(json={"sessionId": SESSION})

    def test_consumed_proof_reconfirms_same_session_after_transient_failure(self):
        for failure in (503, 500, "network", "timeout"):
            with self.subTest(failure=failure):
                self.used = False
                self.entries.clear()
                self.requests.clear()
                self.me_failures = [failure]
                self.roles = ['radiologist']
                self.login('main.html')
                expect(self.page.locator("#work")).to_be_visible(timeout=15000)
                self.assert_entry()
                self.assertEqual([binding for path, binding in self.requests if path == "/api/me"], [SESSION, SESSION])

    def assert_uncertain_landing_recovers(self):
        self.page.wait_for_url("**/index.html*", timeout=15000)
        expect(self.page.locator("#msg")).to_contain_text("확인하지 못해")
        expect(self.page.locator("#msg")).not_to_contain_text("이미 사용")
        expect(self.page.locator("#msg")).not_to_contain_text("만료")
        self.assertEqual(len(self.entries), 1)
        self.assertNotIn("active", [event["state"] for event in self.auth_states])
        self.me_failures.clear()
        self.page.locator("#signin").click()
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "empty")
        self.assertFalse(any(path in ("/api/auth/login", "/api/auth/logout") for path, _ in self.requests))
        self.assertEqual(len(self.entries), 1)

    def test_consumed_proof_budget_exhaustion_login_reconfirms_without_revocation(self):
        self.real_landing = True
        self.me_failures = [503] * 4
        self.login(denied=False)
        self.page.wait_for_url("**/index.html*", timeout=15000)
        self.assertEqual([binding for path, binding in self.requests if path == "/api/me"], [SESSION] * 4)
        self.assert_uncertain_landing_recovers()

    def test_lost_entry_answer_login_reconfirms_without_resending_proof_or_revoking(self):
        self.real_landing = self.lose_entry = True
        self.login(denied=False)
        self.assert_uncertain_landing_recovers()

    def landing(self, record=None, query="?auth_error=entry_unconfirmed"):
        self.real_landing = True
        if record:
            import json
            self.context.add_init_script("""if (!sessionStorage.getItem('syn-seeded')) {
              sessionStorage.setItem('syn-seeded','1');
              localStorage.setItem('kin-session-end',JSON.stringify(%s));
            }""" % json.dumps({"session": record, "operation": 1, "status": "confirmed"}))
        self.page.goto(self.origin + BASE + "index.html" + query)
        expect(self.page.locator('#signin')).to_be_enabled()

    def test_lost_entry_with_old_end_record_enters_on_first_login_and_clears_only_old_record(self):
        self.landing("S0-yesterday")
        self.page.reload()
        self.page.locator('#signin').click()
        expect(self.page.locator('#list-state')).to_have_attribute('data-state', 'empty')
        self.assertEqual(self.page.evaluate("localStorage.getItem('kin-session-end')"), None)
        self.assertNotIn('kin-session-end=', self.page.evaluate('document.cookie'))
        self.assertEqual(self.login_starts, [])
        self.assertEqual(self.page.evaluate('KinAuth.sessionId()'), SESSION)

    def test_confirmation_login_with_own_end_starts_bound_explicit_login(self):
        self.landing(SESSION)
        self.page.locator('#signin').click()
        self.page.wait_for_url('**/auth/synthetic-login')
        self.assertEqual(len(self.login_starts), 1)
        method, headers, _ = self.login_starts[0]
        self.assertEqual(method, 'POST')
        self.assertEqual(headers.get('x-kin-session'), SESSION)
        self.assertEqual(headers.get('x-kin-csrf'), '1')
        self.assertNotIn('active', [event['state'] for event in self.auth_states])

    def test_confirmation_login_with_untrusted_storage_starts_bound_explicit_login(self):
        self.context.add_init_script(STORAGE_DENIED)
        self.landing()
        self.page.locator('#signin').click()
        self.page.wait_for_url('**/auth/synthetic-login')
        self.assertEqual(len(self.login_starts), 1)
        method, headers, _ = self.login_starts[0]
        self.assertEqual((method, headers.get('x-kin-session')), ('POST', SESSION))
        self.assertNotIn('active', [event['state'] for event in self.auth_states])

    def test_confirmation_login_without_cookie_session_starts_ordinary_login(self):
        self.me_absent = True
        self.landing('S0-yesterday')
        self.page.locator('#signin').click()
        self.page.wait_for_url('**/api/auth/login*')
        self.assertEqual([start[0] for start in self.login_starts], ['GET'])
        self.assertNotIn('active', [event['state'] for event in self.auth_states])

    def test_confirmation_transient_failure_allows_same_login_button_to_retry(self):
        self.landing('S0-yesterday')
        self.me_failures = [503]
        self.page.locator('#signin').click()
        expect(self.page.locator('#msg')).to_contain_text('다시 누르세요')
        self.page.wait_for_timeout(1200)
        self.assertEqual(self.requests, [('/api/me', None)])
        self.assertEqual(self.login_starts, [])
        self.page.locator('#signin').click()
        expect(self.page.locator('#list-state')).to_have_attribute('data-state', 'empty')
        self.assertEqual(self.login_starts, [])

    def test_ordinary_landing_old_record_also_enters_without_revoking_live_session(self):
        self.landing('S0-yesterday', query='')
        self.page.locator('#signin').click()
        expect(self.page.locator('#list-state')).to_have_attribute('data-state', 'empty')
        self.assertEqual(self.login_starts, [])

    def test_refused_proof_on_landing_can_confirm_live_session_with_login(self):
        self.refuse = True
        self.landing(query='#kin-entry=refused-proof')
        expect(self.page.locator('#msg')).to_contain_text('다시 로그인')
        self.page.locator('#signin').click()
        expect(self.page.locator('#list-state')).to_have_attribute('data-state', 'empty')
        self.assertEqual(self.login_starts, [])
        self.assertEqual(len(self.entries), 1)

    def test_consumed_proof_definitive_refusal_does_not_retry(self):
        self.me_code = "AUTH_SESSION_MISMATCH"
        self.login(denied=False)
        self.page.wait_for_url("**/index.html")
        self.assertEqual(self.requests, [("/api/auth/entry", None), ("/api/me", SESSION)])
        self.assertNotIn("active", [event["state"] for event in self.auth_states])

    def login(self, destination="clinician.html", denied=True):
        type(self).destination = destination
        if denied and not self.storage_denied:
            self.context.add_init_script(STORAGE_DENIED)
            self.storage_denied = True
        self.page.goto(self.origin + "/api/auth/callback?code=SYN-code&state=SYN-state")

    def assert_entry(self):
        self.assertEqual(len(self.entries), 1)
        body, headers, url = self.entries[0]
        self.assertEqual(body, {"proof": PROOF})
        self.assertEqual(headers.get("x-kin-csrf"), "1")
        self.assertNotIn("x-kin-session", headers)
        self.assertNotIn("#", url, "fragment is removed before consumption")
        self.assertNotIn(PROOF, headers.get("referer", ""))
        for path, binding in self.requests:
            if path in ("/api/me", "/api/clinician/studies", "/api/syn-work"):
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

    def test_refused_proof_opens_nothing_even_with_reliable_storage(self):
        self.refuse = True
        self.login(denied=False)
        self.page.wait_for_url("**/index.html")
        self.assertEqual(self.requests, [("/api/auth/entry", None)])
        self.assertEqual(len(self.entries), 1)

    def test_replay_opens_nothing_and_reload_never_reuses_proof(self):
        self.login()
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "empty")
        self.page.reload()
        self.page.wait_for_url("**/index.html")
        self.assertEqual(len(self.entries), 1)
        self.requests.clear()
        self.page.goto(self.origin + BASE + "clinician.html#kin-entry=" + PROOF)
        self.page.wait_for_url("**/index.html")
        self.assertEqual(self.requests, [("/api/auth/entry", None)])
        self.assertEqual(len(self.entries), 2)

    def test_role_change_cannot_activate_or_forward_to_another_document(self):
        for destination, roles in (("main.html", ["clinician"]), ("clinician.html", ["radiologist"]),
                                   ("clinician.html", ["technician"])):
            with self.subTest(destination=destination, roles=roles):
                self.roles, self.used = roles, False
                self.entries.clear()
                self.requests.clear()
                self.auth_states.clear()
                self.login(destination)
                # Observe the authority before a mistaken redirect can discard the document.
                self.page.wait_for_function("true")
                self.assertNotIn("active", [event["state"] for event in self.auth_states])
                if destination == "clinician.html":
                    self.page.wait_for_url("**/index.html")
                else:
                    self.page.wait_for_function("KinAuth.endState().reason !== null")
                    self.assertEqual(self.page.evaluate("KinWorkContext.state()"), "unknown")
                    expect(self.page.locator("#work")).to_be_hidden()
                self.assertEqual(self.requests, [("/api/auth/entry", None), ("/api/me", SESSION)])
                self.assert_entry()

    def test_pending_and_invalid_membership_display_no_work(self):
        for code, title in (("INSTITUTION_PENDING", "Pending Approval"), ("INSTITUTION_INVALID", "Account Setup Required")):
            with self.subTest(code=code):
                self.me_code, self.used = code, False
                self.entries.clear()
                self.requests.clear()
                self.login()
                expect(self.page.locator("#membership-title")).to_have_text(title)
                expect(self.page.locator("#home")).to_be_hidden()
                self.assertEqual(self.requests, [("/api/auth/entry", None), ("/api/me", SESSION)])
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

    def test_no_work_before_entry_answer_and_concurrent_init_consumes_once(self):
        self.hold_entry = True
        self.login()
        self.page.wait_for_function("typeof KinAuth !== 'undefined'")
        self.assertIsNotNone(self.held_entry)
        self.page.evaluate("void KinAuth.init(); void KinAuth.init();")
        self.assertEqual(self.requests, [("/api/auth/entry", None)])
        self.assertEqual(self.page.evaluate("KinWorkContext.state()"), "unknown")
        self.assertNotIn("#", self.page.url)
        self.answer_entry(self.held_entry)
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "empty")
        self.assert_entry()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
