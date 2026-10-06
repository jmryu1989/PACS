"""TEST-S7-U5-END-LIVE (SE-01..SE-10, SE-03b, SE-03c): the session end on the real stack - real BFF, nginx, PostgreSQL and the real
Keycloak login form driven by a browser. No mock of the form, the authorization endpoint or the callback.

REQ-S7-U5-SESSION-END (R1: whenever the product ends a product session the provider session ends too, and a provider
session the product decided to end never produces a product session again; R2: a login started to leave, to switch, or
from a browser that cannot say whether the person left, makes a session only from credentials entered after that press)
  -> RISK-S7-U5-SILENT-REENTRY -> TEST-S7-U5-END-LIVE (this file; the ordered races are tests/auth_session_service_test.cjs
  U5E-01..U5E-10, the landing table is tests/auth_entry_dom_test.py).
Design: session-end design v2 (2026-10-05) section 5, acceptance cases 6 and 7, and the pre-review's real-Keycloak list:
the provider frozen during a Log out (F6-C), the next person at an unfinished-logout landing and at Switch account (an
editable user name, never the previous doctor's fixed re-authentication screen - F5), the probe and fresh steps, the
same doctor's other PC untouched, a provider end racing a refresh (F2), and what `auth_time` does across a refresh.
SE-09/SE-10 (integration review F02, review of 8c2cf37 F-05): the administrator's isolation of a signed-in member on the
real provider (prompt=none, credentials and refresh refused; Activate lets the member in again), and the provider side of
the failed-listing path - a member disabled at the provider whose provider session was not logged out.
SE-03b/SE-03c (S1 real-screen counterexample 1, candidate-diag-S1 ce1-diagnosis): Keycloak names a new SSO by the browser's
authentication-session id, and a login screen left unfinished in that browser keeps the id alive past a login - the next
SSO of the browser, the next person's or the same doctor's, gets the ENDED SSO's id. The end mark must not refuse it
(it covers the ended SSO's authentication, not the id): the next person at an unfinished-logout landing in a profile that
once closed a login page (SE-03b), and the same doctor after an ordinary Log out in one tab that opened the app twice
before logging in (SE-03c), each enter with one credential entry; the ended SSO's token stays refused on the Bearer path.

Run only through the guarded runner, on the isolated synthetic stack, after the unit's migration is applied there:
    python scripts/run-tests.py --module tests/live/session_end_live.py --mode live --unit s7-u5-session-end --timeout 1800
Hosted CI: the `u5-session-end` profile of tests/measurement_ci.py (validate.yml s7-u5-session-contracts matrix), on
its own empty runner because SE-02 pauses Keycloak.
SE-02 pauses and unpauses the stack's own keycloak service for about four seconds (`docker compose pause keycloak`,
no restart, no configuration change). SE-09 suspends and activates doctor A through the product's admin route (as the
LiveStack admin identity jmryu) and SE-10 disables and enables doctor A through Keycloak's admin API; both put A back
enabled. Every other case only reads Keycloak and the database.

Owned data: the LiveStack test identities doctor (A) and doctor2 (B), their product sessions, their access rows, the
end marks (IdpSessionEnd) of their own provider sessions and A's isolation fact (MemberIsolation) - all removed at the
end. Nothing secret is printed: each case prints one line `S7-U5-END-LIVE {case, ...}` of names, counts and booleans.

STATUS WHEN WRITTEN (2026-10-05): not run - this job had no stack (Docker was out of bounds). The first run on the
stack is its first execution; a harness error there is not evidence about the product. SE-01..SE-08 ran 8/8 on the
synthetic stack on 2026-10-06; SE-09 and SE-10 were added the same day and have NOT run (the stack was reserved for
another operator) - their first run is their first execution. SE-03b and SE-03c were added with the CE1 fix (fix round
5b, 2026-10-06); their result is in that round's run record, not here.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import time
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import sync_playwright

from invariants_live import ROOT, psql, purge_user_audit
from session_support import cleanup_sessions, setup_stack

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CASES = (
    "test_01_log_out_ends_the_provider_session_and_login_meets_the_form",
    "test_02_provider_frozen_during_log_out_cannot_be_ridden_back_in",
    "test_03_next_person_at_an_unfinished_logout_logs_in_as_themselves",
    "test_03b_next_person_in_a_profile_that_kept_an_abandoned_login_page",
    "test_03c_the_same_doctor_logs_in_again_in_a_tab_that_opened_the_app_twice",
    "test_04_switch_account_shows_an_editable_name",
    "test_05_the_same_doctors_other_pc_keeps_working",
    "test_06_an_untrusted_browser_is_probed_then_asked_for_credentials",
    "test_07_a_provider_end_racing_a_refresh_still_ends_the_session",
    "test_08_what_auth_time_does_across_a_refresh",
    "test_09_an_isolated_member_cannot_come_back_until_activated",
    "test_10_a_member_disabled_at_the_provider_gets_nothing_from_a_live_provider_session",
    "test_11_an_isolation_ends_each_provider_session_by_its_id_and_the_next_sso_given_that_id_lives",
)
APP = "/worklist/hpacs-lite/"
STORAGE_DENIED = """(() => { for (const name of ['localStorage']) Object.defineProperty(window, name,
  { get() { throw new DOMException('SYN denied', 'SecurityError'); } }); })();"""
# What the Keycloak page in front of the person is (the product's theme keeps Keycloak's field ids).
FORM = """() => { const q = s => document.querySelector(s);
  const u = q('#username') || q('input[name=username]'), p = q('#password') || q('input[name=password]');
  const shown = el => !!el && el.type !== 'hidden' && el.offsetParent !== null;
  return { username: u ? { shown: shown(u), editable: !u.readOnly && !u.disabled, value: u.value } : null,
    password: shown(p), attempted: q('#kc-attempted-username')?.innerText?.trim() ?? null }; }"""
WHERE = """() => { const p = location.pathname;
  if (p.startsWith('/auth/realms/kin/')) return document.readyState === 'complete' ? 'keycloak' : null;
  if (/\\/index\\.html$/.test(p)) { const b = document.querySelector('#signin');
    return b && !document.documentElement.classList.contains('auto-entry') ? 'landing' : null; }
  if (/\\/(main|clinician)\\.html$/.test(p)) return typeof KinAuth !== 'undefined' && KinAuth.lifecycle().state === 'active' ? 'main' : null;
  return null; }"""
# A landing press is answered when the document leaves the landing (on its way to the provider or the work screen) or
# when the landing writes its answer into the notice line. The landing is itself the stable state before the press, so
# reading it right after the click would read the press's start, not its answer. The notice line is watched for any
# write, not for a changed text: a press that fails the same way twice ("the previous login's end is not confirmed yet")
# writes the same sentence again.
WATCH_NOTICE = """() => { window.kinTestNoticeWritten = false;
  new MutationObserver(() => { window.kinTestNoticeWritten = true; })
    .observe(document.querySelector('#msg'), { childList: true, characterData: true, subtree: true }); }"""
ANSWERED = """() => !/\\/index\\.html$/.test(location.pathname) || window.kinTestNoticeWritten === true"""
# The provider answered a credentials submit: it left its form, or showed its form again with a message (SE-09/SE-10:
# a disabled account). The form's own field ids and Keycloak's message element - not its wording.
SUBMITTED = """() => !location.pathname.startsWith('/auth/realms/kin/login-actions/authenticate')
  || (document.readyState === 'complete' && !!document.querySelector('#input-error, .kc-feedback-text'))"""


def compose_done(done: subprocess.CompletedProcess, verb: str) -> None:
    # The two Compose calls (SE-02) are written out where they run, each with its whole argv as a literal list: the CI
    # execution guard (TG-02) reads them there. cwd is the repository root and env is not passed, so Compose follows the
    # selection the guarded runner set (COMPOSE_PROJECT_NAME / COMPOSE_FILE) - only that synthetic stack, never a stack
    # this file names.
    if done.returncode:
        raise RuntimeError("harness: docker compose " + verb + " keycloak failed")


class SessionEndLive(unittest.TestCase):
    provider_sessions: list = []

    @classmethod
    def setUpClass(cls):
        declared = [name for name in sorted(vars(cls)) if name.startswith("test_")]
        if list(CASES) != declared:
            raise RuntimeError(f"CASES {CASES} differ from the declared cases {declared}")
        setup_stack(cls)
        cls.stack.provision_test_identities()
        cls.addClassCleanup(cls.purge)
        cls.ids = {"A": cls.stack.user_ids["doctor"], "B": cls.stack.user_ids["doctor2"]}
        cls.logins = {"A": "doctor", "B": "doctor2"}
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        cls.browser = cls.playwright.chromium.launch(headless=True)
        cls.addClassCleanup(cls.browser.close)

    @classmethod
    def purge(cls):
        cleanup_sessions(cls.stack)
        for user_id in cls.ids.values():
            purge_user_audit(user_id)
            cls.stack.kc_admin("POST", f"/users/{user_id}/logout")
        # Keycloak 26 session ids are base64url: '_' as well as '-'.
        owned = [value for value in cls.provider_sessions if re.fullmatch(r"[0-9A-Za-z_-]{8,64}", value)]
        if owned:
            psql('DELETE FROM "IdpSessionEnd" WHERE "idpSid" IN (' + ",".join(f"'{value}'" for value in owned) + ");")
            psql('DELETE FROM "ProviderChange" WHERE kind = \'end_session\' AND target IN (' + ",".join(f"'{value}'" for value in owned) + ");")
        # The provider change records of A's and B's isolation and re-activation (SE-09, SE-11).
        psql('DELETE FROM "ProviderChange" WHERE sub IN (' + ",".join(f"'{value}'" for value in cls.ids.values()) + ");")
        # SE-09's isolation fact of A (an Activate clears it; a case that stopped before it leaves it).
        psql('DELETE FROM "MemberIsolation" WHERE sub IN (' + ",".join(f"'{value}'" for value in cls.ids.values()) + ");")

    # ── a browser profile and what it asked ──
    def setUp(self):
        self.contexts = []
        for user_id in self.ids.values():
            self.stack.kc_admin("POST", f"/users/{user_id}/logout")
        cleanup_sessions(self.stack)
        # What this case wrote: end records after this floor and end marks of the provider sessions this case signed in
        # to. The append-only audit is not cleared between cases (the class end purges the owned rows); without the
        # floor an earlier case's Log out record would count as this case's.
        self.audit_floor = int(psql('SELECT coalesce(max(id), 0) FROM "AuditLog";')[0])
        self.case_sessions = {"A": [], "B": []}

    def tearDown(self):
        for context in self.contexts:
            context.close()

    def profile(self, script: str | None = None):
        context = self.browser.new_context(ignore_https_errors=True, locale="ko-KR")
        context.set_default_timeout(30000)
        if script:
            context.add_init_script(script)
        context.asked = []

        def note(request):
            url = urlparse(request.url)
            if url.path == "/api/auth/login" and request.method == "POST":
                body = json.loads(request.post_data or "{}")
                context.asked.append(("start", body.get("reason"), "x-kin-session" in request.headers))
            elif url.path.endswith("/protocol/openid-connect/auth"):
                context.asked.append(("authorize", parse_qs(url.query).get("prompt", [None])[0]))
        context.on("request", note)
        self.contexts.append(context)
        return context, context.new_page()

    def settle(self, page) -> str:
        return page.wait_for_function(WHERE).json_value()

    def press(self, page, selector: str) -> str:
        """One press of a landing button; where the browser is once the press has been answered."""
        page.evaluate(WATCH_NOTICE)
        page.click(selector)
        page.wait_for_function(ANSWERED)
        return self.settle(page)

    def credentials(self, page, who: str, name: bool = True) -> str:
        if name:
            page.fill("#username", self.stack.username(self.logins[who]))
        page.fill("#password", self.stack.passwords[self.logins[who]])
        page.click("#kc-login")
        page.wait_for_function("() => !location.pathname.startsWith('/auth/realms/kin/login-actions/authenticate') || !!document.querySelector('#input-error')")
        return self.settle(page)

    def sign_in(self, page, who: str, opens: int = 1) -> str:
        """Open the app; the ordinary entry goes to the provider's form by itself. `opens` > 1 opens the app's address that
        many times before typing (a second bookmark click: the earlier authorization is left unfinished). Returns the
        session id of the document."""
        for _ in range(opens):
            page.goto(self.stack.proxy + APP + "index.html")
            at = self.settle(page)
            if at == "landing":
                at = self.press(page, "#signin")
            self.assertEqual(at, "keycloak", "a browser without a session meets the provider's form")
        self.assertEqual(self.credentials(page, who), "main")
        for line in psql(f'SELECT coalesce("idpSid", \'\') FROM "AuthSession" WHERE sub=\'{self.ids[who]}\';'):
            self.assertTrue(line, "every session remembers its provider session")
            type(self).provider_sessions.append(line)
            self.case_sessions[who].append(line)
        return page.evaluate("KinAuth.sessionId()")

    # ── what the server and the provider hold ──
    def product_sessions(self, who: str) -> int:
        return int(psql(f'SELECT count(*) FROM "AuthSession" WHERE sub=\'{self.ids[who]}\';')[0])

    def provider_alive(self, who: str) -> int:
        answer = self.stack.kc_admin("GET", f"/users/{self.ids[who]}/sessions")
        return len(answer.body) if isinstance(answer.body, list) else -1

    def ends(self, who: str) -> list:
        """(action, cause) of the end records of this account written during this case."""
        rows = psql(f'SELECT action || E\'\\t\' || detail FROM "AuditLog" WHERE target=\'{self.ids[who]}\' '
                    f"AND action IN ('auth.logout','auth.session.expired') AND id > {self.audit_floor} ORDER BY id;")
        return [(row.split("\t")[0], json.loads(row.split("\t", 1)[1]).get("cause")) for row in rows]

    def marks(self, who: str) -> list:
        """(cause, confirmed) of the end marks of this account's provider sessions signed in to during this case."""
        owned = ",".join(f"'{value}'" for value in self.case_sessions[who]) or "''"
        return [tuple(row.split("\t")) for row in psql(
            f'SELECT cause || E\'\\t\' || ("confirmedAt" IS NOT NULL)::text FROM "IdpSessionEnd" WHERE "idpSid" IN ({owned}) ORDER BY "decidedAt";')]

    def wait(self, what: str, check, seconds: float = 15.0):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            if check():
                return
            time.sleep(0.2)
        self.fail("not observed within %.0f s: %s" % (seconds, what))

    def me(self, context) -> tuple:
        answer = context.request.get(self.stack.proxy + "/api/me", headers={"X-KIN-CSRF": "1"})
        body = answer.json() if "json" in (answer.headers.get("content-type") or "") else {}
        return answer.status, body.get("sub")

    def bearer_me(self, token: str) -> tuple:
        """`GET /api/me` with the access token as Bearer and no cookie (the guard's Bearer path): (status, sub or code)."""
        api = self.playwright.request.new_context(ignore_https_errors=True)
        try:
            answer = api.get(self.stack.proxy + "/api/me", headers={"Authorization": "Bearer " + token})
            body = answer.json() if "json" in (answer.headers.get("content-type") or "") else {}
            return answer.status, body.get("sub") if answer.status == 200 else body.get("code")
        finally:
            api.dispose()

    def provider_session_and_token(self, who: str) -> tuple:
        """(provider session id, stored access token) of the account's one product session; the id is owned by the case."""
        rows = psql(f'SELECT "idpSid" || E\'\\t\' || "accessToken" FROM "AuthSession" WHERE sub=\'{self.ids[who]}\';')
        self.assertEqual(len(rows), 1, who + " has one product session")
        idp, token = rows[0].split("\t")
        type(self).provider_sessions.append(idp)
        self.case_sessions[who].append(idp)
        return idp, token

    def end_requests(self, idp: str) -> list:
        """The states of the product's recorded end requests (ProviderChange) of one provider session, in order."""
        return psql(f'SELECT state FROM "ProviderChange" WHERE kind = \'end_session\' AND target = \'{idp}\' ORDER BY id;')

    def refusals(self, who: str) -> int:
        """Login refusals of this account as a provider session the product had ended, written during this case."""
        return int(psql(f'SELECT count(*) FROM "AuditLog" WHERE target=\'{self.ids[who]}\' AND id > {self.audit_floor} '
                        "AND action = 'auth.login' AND detail::json->>'cause' = 'idp_session_ended';")[0])

    def keycloak_kept_the_login_screen(self, context) -> bool:
        """Whether the browser's Keycloak authentication session holds an unfinished login screen after a login (its
        restart cookie outlives the login - ce1-diagnosis 3.4). A precondition, not a product rule."""
        return "KC_RESTART" in [cookie["name"] for cookie in context.cookies()]

    def report(self, case: str, **facts):
        print("S7-U5-END-LIVE " + json.dumps({"case": case, **facts}, ensure_ascii=False))

    def assert_editable_form(self, page, what: str):
        form = page.evaluate(FORM)
        self.assertTrue(form["username"] and form["username"]["shown"] and form["username"]["editable"], what + ": a user name can be typed")
        self.assertEqual((form["username"]["value"], form["attempted"]), ("", None), what + ": nobody's name is fixed on the form")
        self.assertTrue(form["password"], what)

    # ── isolation (SE-09, SE-10) ──
    def isolation(self, who: str) -> tuple:
        """(recorded, provider work done) of the account's isolation fact (MemberIsolation); (False, False): none."""
        rows = psql(f'SELECT ("providerDoneAt" IS NOT NULL)::text FROM "MemberIsolation" WHERE sub=\'{self.ids[who]}\';')
        return bool(rows), rows == ["true"]

    def provider_enabled(self, who: str):
        answer = self.stack.kc_admin("GET", f"/users/{self.ids[who]}")
        return answer.body.get("enabled") if isinstance(answer.body, dict) else None

    def admin_sets_enabled(self, who: str, enabled: bool):
        """The administrator's Suspend / Activate through the product's admin route (the stack's admin identity)."""
        return self.stack.request("PATCH", f"/admin/users/{self.ids[who]}", "jmryu", {"enabled": enabled})

    def callbacks(self, context) -> list:
        """The product callbacks this browser makes from now on: whether each carried a code, and the provider's error."""
        seen = []

        def note(request):
            url = urlparse(request.url)
            if url.path == "/api/auth/callback":
                query = parse_qs(url.query)
                seen.append({"code": "code" in query, "error": query.get("error", [None])[0]})
        context.on("request", note)
        return seen

    def probe_at_the_landing(self, context, page) -> str:
        """The recovery Login of a browser that cannot keep an end record (SE-06): no product cookie, the landing, one
        press - a prompt=none probe, then the fresh step. Where the press ends."""
        context.clear_cookies(name="kin_sid")
        page.goto(self.stack.proxy + APP + "index.html")
        self.assertEqual(self.settle(page), "landing", "an untrusted browser does not enter by itself")
        del context.asked[:]
        at = self.press(page, "#signin")
        self.assertEqual(context.asked, [("start", "storage_untrusted", False), ("authorize", "none"), ("authorize", "login")],
                         "the recovery Login probes with prompt=none, then asks for credentials")
        return at

    def refused_credentials(self, page, who: str) -> bool:
        """The account's correct credentials typed into the provider's form. True when the provider kept the person on
        its form with a message (a disabled account is not let in); the message's wording is Keycloak's, not asserted."""
        page.fill("#username", self.stack.username(self.logins[who]))
        page.fill("#password", self.stack.passwords[self.logins[who]])
        page.click("#kc-login")
        page.wait_for_function(SUBMITTED)
        return self.settle(page) == "keycloak" and page.evaluate("() => !!document.querySelector('#input-error, .kc-feedback-text')")

    # ── cases ──
    def test_01_log_out_ends_the_provider_session_and_login_meets_the_form(self):
        context, page = self.profile()
        self.sign_in(page, "A")
        started = time.monotonic()
        page.click("#logout")
        page.wait_for_url("**/index.html")
        took = time.monotonic() - started
        self.assertEqual(self.settle(page), "landing")
        self.assertIn("끝냈습니다", page.inner_text("#msg"))
        self.assertEqual((self.product_sessions("A"), self.ends("A")[-1]), (0, ("auth.logout", "logout")))
        # R1: the provider session is ended - by the product, confirmed in its mark - without the person waiting for it.
        self.wait("the provider session ended and the mark confirmed", lambda: self.provider_alive("A") == 0 and self.marks("A")[-1:] == [("logout", "true")])
        # The day after (or a minute after): one Login press, then credentials. Never a silent entry.
        self.assertEqual(self.press(page, "#signin"), "keycloak")
        self.assert_editable_form(page, "after a Log out")
        self.assertEqual(context.asked[-3:], [("start", "logout_unfinished", False), ("authorize", "none"), ("authorize", "login")],
                         "the explicit logout's Login declares its intent, probes, then asks for credentials")
        self.assertEqual(self.credentials(page, "A"), "main")
        self.report("SE-01", logout_seconds=round(took, 2), ends=len(self.ends("A")))

    def test_02_provider_frozen_during_log_out_cannot_be_ridden_back_in(self):
        """Acceptance 6 (F6-C): the provider does not answer while the Log out runs. The Log out is answered at once;
        afterwards the provider session may still be alive - and Login must not ride it."""
        context, page = self.profile()
        self.sign_in(page, "A")
        compose_done(subprocess.run(["docker", "compose", "pause", "keycloak"], cwd=ROOT, capture_output=True, text=True,
                                    timeout=60), "pause")
        try:
            started = time.monotonic()
            page.click("#logout")
            page.wait_for_url("**/index.html")
            took = time.monotonic() - started
            self.assertEqual(self.settle(page), "landing")
            self.assertLess(took, 2.0, "an ordinary Log out does not wait for the provider")
            self.assertEqual(self.product_sessions("A"), 0)
            time.sleep(3.5)
            # S7-U5 D600: past the product's 2 s wait the end request is kept open, not given up - its outcome is unknown
            # and the end is not confirmed while Keycloak holds it.
            a_sid = self.case_sessions["A"][-1]
            self.assertEqual((self.end_requests(a_sid), self.marks("A")), (["unknown"], [("logout", "false")]),
                             "the held end request stays unknown; the end unconfirmed")
        finally:
            compose_done(subprocess.run(["docker", "compose", "unpause", "keycloak"], cwd=ROOT, capture_output=True, text=True,
                                        timeout=60), "unpause")
        # Login right away: whether or not the retry has ended the provider session yet, nobody enters without the form.
        seen = []
        for _ in range(3):
            at = self.press(page, "#signin")
            seen.append(at)
            self.assertNotEqual(at, "main", "a silent re-entry as the previous doctor")
            if at == "keycloak":
                break
            # The landing said the previous login's end is not confirmed yet: the same button, a moment later.
            self.assertIn("이전 로그인 종료를 확인하지 못했습니다", page.inner_text("#msg"))
            time.sleep(2)
        self.assertEqual(seen[-1], "keycloak")
        self.assert_editable_form(page, "after a Log out the provider did not answer")
        self.wait("the provider session ended by the retry", lambda: self.provider_alive("A") == 0 and ("logout", "true") in self.marks("A"))
        self.assertEqual(self.ends("A"), [("auth.logout", "logout")], "one record of the end; retries add none")
        # The held request was answered once Keycloak ran again: that answer, its own, settled it.
        requests = self.end_requests(self.case_sessions["A"][-1])
        self.assertTrue(requests and all(state == "done" for state in requests), requests)
        self.report("SE-02", logout_seconds=round(took, 2), presses=len(seen), end_requests=len(requests))

    def unfinished_logout(self):
        """Doctor A at an unfinished-logout landing: the Log out POST never left the browser; both sessions are alive."""
        context, page = self.profile()
        self.sign_in(page, "A")
        context.route("**/api/auth/logout", lambda route: route.abort("connectionfailed"))
        page.click("#logout")
        page.wait_for_url("**/index.html")
        self.assertEqual(self.settle(page), "landing")
        self.assertTrue(page.is_visible("#retry-logout"))
        self.assertEqual((self.product_sessions("A"), self.provider_alive("A")), (1, 1))
        return context, page

    def test_03_next_person_at_an_unfinished_logout_logs_in_as_themselves(self):
        """Acceptance 7: the next person B presses Login once at doctor A's unfinished-logout landing."""
        context, page = self.unfinished_logout()
        self.assertEqual(self.press(page, "#signin"), "keycloak")
        self.assert_editable_form(page, "the next person's Login")
        self.assertEqual(context.asked[-2:], [("start", "logout_unfinished", True), ("authorize", "login")],
                         "a bound start with the intent, then the fresh step - no probe is needed after a confirmed end")
        self.assertEqual((self.product_sessions("A"), self.provider_alive("A"), self.ends("A")), (0, 0, [("auth.logout", "logout")]),
                         "A's sessions are ended before the form is shown; the record says logout, not account_switch")
        self.assertEqual(self.credentials(page, "B"), "main")
        self.assertEqual(self.me(context), (200, self.ids["B"]))
        self.assertEqual((self.product_sessions("A"), self.provider_alive("A"), self.product_sessions("B")), (0, 0, 1))
        self.report("SE-03", a_ends=self.ends("A"))

    def test_03b_next_person_in_a_profile_that_kept_an_abandoned_login_page(self):
        """S1 real-screen counterexample 1, round 2: the same as SE-03, in a profile that once opened a login page and
        closed it without logging in - so Keycloak gives the next SSO of this browser the id of the ended one. The next
        person B still enters as B with one credential entry; the ended SSO's token stays refused, B's is not."""
        context, page = self.profile()
        spare = context.new_page()
        spare.goto(self.stack.proxy + "/api/auth/login")
        self.assertEqual(self.settle(spare), "keycloak")
        # Closed, not left open: an open login page may finish its own login screen by itself (ce1-diagnosis 3.4).
        spare.close()
        self.sign_in(page, "A")
        self.assertTrue(self.keycloak_kept_the_login_screen(context), "precondition: the abandoned login screen outlived A's login")
        a_sid, a_token = self.provider_session_and_token("A")
        context.route("**/api/auth/logout", lambda route: route.abort("connectionfailed"))
        page.click("#logout")
        page.wait_for_url("**/index.html")
        self.assertEqual(self.settle(page), "landing")
        self.assertTrue(page.is_visible("#retry-logout"))
        self.assertEqual(self.press(page, "#signin"), "keycloak")
        self.assert_editable_form(page, "the next person's Login")
        self.assertEqual(context.asked[-2:], [("start", "logout_unfinished", True), ("authorize", "login")])
        asked = len(context.asked)
        self.assertEqual(self.credentials(page, "B"), "main", "B enters with one credential entry")
        self.assertEqual(context.asked[asked:], [], "no second form, no restarted flow")
        self.assertEqual(self.me(context), (200, self.ids["B"]))
        b_sid, b_token = self.provider_session_and_token("B")
        self.assertEqual(b_sid, a_sid, "precondition: Keycloak gave B's new SSO the ended SSO's id - else this case proves nothing")
        self.assertEqual((self.product_sessions("A"), self.provider_alive("A"), self.product_sessions("B"), self.provider_alive("B")),
                         (0, 0, 1, 1))
        self.assertEqual((self.ends("A"), self.refusals("B")), ([("auth.logout", "logout")], 0))
        # The Bearer path judges as the callback: same id, the ended SSO's token refused, the new SSO's accepted.
        self.assertEqual((self.bearer_me(a_token), self.bearer_me(b_token)), ((401, "AUTH_SESSION_ENDED"), (200, self.ids["B"])))
        self.report("SE-03b", same_sid=True)

    def test_03c_the_same_doctor_logs_in_again_in_a_tab_that_opened_the_app_twice(self):
        """ce1-diagnosis X6 with the same doctor: one tab opens the app's address twice before A types (a second bookmark
        click - the first login screen is left unfinished), A logs in; an ordinary Log out ends A's SSO; A comes back with
        one Login press and one credential entry, although Keycloak gives A's new SSO the ended SSO's id. The ended SSO's
        token stays refused, the new one is not."""
        context, page = self.profile()
        self.sign_in(page, "A", opens=2)
        self.assertTrue(self.keycloak_kept_the_login_screen(context), "precondition: the abandoned login screen outlived A's login")
        a_sid, a_token = self.provider_session_and_token("A")
        page.click("#logout")
        page.wait_for_url("**/index.html")
        self.assertEqual(self.settle(page), "landing")
        self.wait("A's provider session ended and the mark confirmed",
                  lambda: self.provider_alive("A") == 0 and self.marks("A")[-1:] == [("logout", "true")])
        asked = len(context.asked)
        self.assertEqual(self.press(page, "#signin"), "keycloak")
        self.assert_editable_form(page, "the same doctor's Login after a Log out")
        self.assertEqual(context.asked[asked:], [("start", "logout_unfinished", False), ("authorize", "none"), ("authorize", "login")])
        asked = len(context.asked)
        self.assertEqual(self.credentials(page, "A"), "main", "A enters with one credential entry")
        self.assertEqual(context.asked[asked:], [], "no second form, no restarted flow")
        self.assertEqual(self.me(context), (200, self.ids["A"]))
        again_sid, again_token = self.provider_session_and_token("A")
        self.assertEqual(again_sid, a_sid, "precondition: Keycloak gave A's new SSO the ended SSO's id - else this case proves nothing")
        self.assertEqual((self.product_sessions("A"), self.provider_alive("A"), self.ends("A"), self.refusals("A")),
                         (1, 1, [("auth.logout", "logout")], 0))
        self.assertEqual((self.bearer_me(a_token), self.bearer_me(again_token)), ((401, "AUTH_SESSION_ENDED"), (200, self.ids["A"])))
        self.report("SE-03c", same_sid=True)

    def test_04_switch_account_shows_an_editable_name(self):
        context, page = self.unfinished_logout()
        self.assertEqual(self.press(page, "#switch"), "keycloak")
        self.assert_editable_form(page, "Switch account")
        self.assertEqual(self.ends("A"), [("auth.logout", "account_switch")])
        # The switch is complete only when B's credentials made B's session in this browser - arriving at the form is not.
        self.assertEqual(self.credentials(page, "B"), "main")
        self.assertEqual(self.me(context), (200, self.ids["B"]))
        self.assertEqual((self.product_sessions("A"), self.provider_alive("A"), self.product_sessions("B")), (0, 0, 1))
        self.report("SE-04", a_ends=self.ends("A"))

    def test_05_the_same_doctors_other_pc_keeps_working(self):
        """Acceptance 3: two PCs of doctor A are two provider sessions; the Log out of one leaves the other, also after
        the other refreshed its token."""
        first, page1 = self.profile()
        second, page2 = self.profile()
        self.sign_in(page1, "A")
        self.sign_in(page2, "A")
        self.assertEqual((self.product_sessions("A"), self.provider_alive("A")), (2, 2))
        page1.click("#logout")
        page1.wait_for_url("**/index.html")
        self.wait("PC1's provider session ended", lambda: self.provider_alive("A") == 1)
        psql(f'UPDATE "AuthSession" SET "atExpiresAt" = now() - interval \'1 minute\' WHERE sub=\'{self.ids["A"]}\';')
        self.assertEqual(self.me(second), (200, self.ids["A"]), "PC2 refreshes and goes on")
        self.assertEqual(page2.evaluate("KinAuth.lifecycle().state"), "active")
        self.assertEqual((self.product_sessions("A"), self.provider_alive("A")), (1, 1))
        self.report("SE-05", ends=self.ends("A"))

    def test_06_an_untrusted_browser_is_probed_then_asked_for_credentials(self):
        """Acceptance 4: the browser cannot keep an end record, its product cookie is gone, doctor A's SSO is alive."""
        context, page = self.profile(STORAGE_DENIED)
        self.sign_in(page, "A")
        context.clear_cookies(name="kin_sid")
        page.goto(self.stack.proxy + APP + "index.html")
        self.assertEqual(self.settle(page), "landing", "an untrusted browser does not enter by itself")
        time.sleep(1)
        self.assertEqual(urlparse(page.url).path, APP + "index.html")
        del context.asked[:]
        self.assertEqual(self.press(page, "#signin"), "keycloak")
        self.assert_editable_form(page, "the recovery Login")
        self.assertEqual(context.asked, [("start", "storage_untrusted", False), ("authorize", "none"), ("authorize", "login")])
        # The probe identified A's SSO and ended it - with A's product session of that SSO - before the form.
        self.assertEqual((self.provider_alive("A"), self.product_sessions("A"), self.ends("A")), (0, 0, [("auth.logout", "reauthentication")]))
        self.assertEqual(self.credentials(page, "A"), "main")
        self.report("SE-06", asked=len(context.asked))

    def test_07_a_provider_end_racing_a_refresh_still_ends_the_session(self):
        """F2: an end that overlaps a refresh of the same provider session. Whatever the provider does with the overlap,
        the product's mark keeps that session out and the end is asked again until the form is what a login meets."""
        outcomes = []
        for attempt in range(5):
            context, page = self.profile()
            self.sign_in(page, "A")
            psql(f'UPDATE "AuthSession" SET "atExpiresAt" = now() - interval \'1 minute\' WHERE sub=\'{self.ids["A"]}\';')
            # A Log out and three requests that each need the refresh, at once.
            page.evaluate("""() => { const h = { 'X-KIN-CSRF': '1', 'X-KIN-Session': KinAuth.sessionId() };
              return Promise.allSettled([fetch('/api/auth/logout', { method: 'POST', headers: h }),
                fetch('/api/me', { headers: h }), fetch('/api/me', { headers: h }), fetch('/api/me', { headers: h })]); }""")
            self.wait("the product session ended", lambda: self.product_sessions("A") == 0)
            # A plain link login with this browser's provider cookies: it may get a code from a session that survived its
            # end - and must not get a product session from it.
            fresh = context.new_page()
            fresh.goto(self.stack.proxy + "/api/auth/login")
            at = self.settle(fresh)
            outcomes.append(at)
            self.assertNotEqual(at, "main", f"attempt {attempt}: a product session from an ended provider session")
            self.assertEqual(self.product_sessions("A"), 0)
            self.wait("the provider session ended", lambda: self.provider_alive("A") == 0, 30)
            context.close()
            self.contexts.remove(context)
        self.report("SE-07", outcomes=outcomes)

    def test_08_what_auth_time_does_across_a_refresh(self):
        """An observation the design asked for (the pre-review's section 3), not a rule of the product: whether the
        `auth_time` of the stored access token changes when the product refreshes it."""
        context, page = self.profile()
        self.sign_in(page, "A")
        read = lambda: psql(f'SELECT "accessToken" FROM "AuthSession" WHERE sub=\'{self.ids["A"]}\';')[0]
        claims = lambda token: json.loads(__import__("base64").urlsafe_b64decode(token.split(".")[1] + "=" * (-len(token.split(".")[1]) % 4)))
        before = claims(read())
        psql(f'UPDATE "AuthSession" SET "atExpiresAt" = now() - interval \'1 minute\' WHERE sub=\'{self.ids["A"]}\';')
        self.assertEqual(self.me(context)[0], 200)
        after = claims(read())
        self.assertNotEqual(before.get("jti"), after.get("jti"), "the token was refreshed")
        self.assertEqual(before.get("sid"), after.get("sid"), "a refresh continues its provider session")
        self.report("SE-08", auth_time_present=[("auth_time" in before), ("auth_time" in after)],
                    auth_time_same=before.get("auth_time") == after.get("auth_time"))

    def test_09_an_isolated_member_cannot_come_back_until_activated(self):
        """Integration review F02 / review of 8c2cf37 F-05: an administrator suspends doctor A while A is signed in, with
        the provider answering. The product records its fact first, ends A's product session and finishes the provider
        work in the same request - A's provider sessions end and A is disabled at the provider (the fact says done). A's
        browser is refused; its recovery Login probes with prompt=none and gets no code; A's correct credentials are
        refused by the provider. Activate clears the fact and A's credentials let A in again."""
        context, page = self.profile(STORAGE_DENIED)
        self.sign_in(page, "A")
        callbacks = self.callbacks(context)
        try:
            changed = self.admin_sets_enabled("A", False)
            self.assertEqual((changed.status, (changed.body or {}).get("enabled")), (200, False), changed.text)
            self.assertEqual(self.isolation("A"), (True, True), "the fact is recorded and its provider work is done")
            self.assertEqual(self.me(context), (401, None), "A's browser session is refused")
            self.assertEqual((self.product_sessions("A"), self.provider_alive("A"), self.provider_enabled("A")), (0, 0, False),
                             "A's product and provider sessions ended, A disabled at the provider")
            self.assertEqual(self.ends("A"), [("auth.logout", "isolation")])
            self.assertEqual([cause for cause, _ in self.marks("A")], ["isolation"], "A's provider session is marked ended")
            self.assertEqual(self.probe_at_the_landing(context, page), "keycloak")
            self.assertEqual([c for c in callbacks if c["code"]], [], "prompt=none gave no code for the isolated member")
            self.assertTrue(self.refused_credentials(page, "A"), "the provider refuses the isolated member's credentials")
            self.assertEqual((self.product_sessions("A"), [c for c in callbacks if c["code"]]), (0, []))
            activated = self.admin_sets_enabled("A", True)
            self.assertEqual((activated.status, (activated.body or {}).get("enabled")), (200, True), activated.text)
            self.assertEqual((self.isolation("A"), self.provider_enabled("A")), ((False, False), True),
                             "Activate cleared the fact and enabled A at the provider")
            self.assertEqual(self.credentials(page, "A", name=True), "main", "A's credentials let A in again")
            self.assertEqual(self.me(context), (200, self.ids["A"]))
            self.report("SE-09", probe_errors=[c["error"] for c in callbacks if not c["code"]], ends=self.ends("A"))
        finally:
            # A case that stopped before its Activate must not leave A suspended for the next case (owned data only).
            if self.isolation("A")[0] or self.provider_enabled("A") is False:
                psql(f'DELETE FROM "MemberIsolation" WHERE sub=\'{self.ids["A"]}\';')
                self.stack.kc_admin("PUT", f"/users/{self.ids['A']}", {"enabled": True})

    def test_10_a_member_disabled_at_the_provider_gets_nothing_from_a_live_provider_session(self):
        """Review of 8c2cf37 F-05, the provider side of the failed-listing path (the F deviation, D592): when the
        isolation's session listing fails, the cycle still disables the member but does not log it out as a whole, so the
        member's provider session (SSO) may live on while the member is disabled. The deviation's safety rests on the
        provider refusing that member. That state is made here through Keycloak's own admin API (disable, no logout): the
        harness can pause the whole of Keycloak (SE-02), not its admin API alone, and while Keycloak is paused every
        admin call of the product waits (an isolation's call until its bound) - the listing cannot fail while the disable
        succeeds - so the product path into this state is not coverable on this stack; the product half (fact first, rows
        ended, the cycle, one finisher, the Activate that waits for a call in flight) is U5E-13..U5E-20 of
        tests/auth_session_service_test.cjs. Asserted: with a provider session of A alive in
        each of two browsers, A's recovery Login probes with prompt=none and gets no code, A's credentials are refused,
        and the product's refresh of A's other session is refused (the session ends). Enabled again, A logs in."""
        first, page1 = self.profile()
        second, page2 = self.profile(STORAGE_DENIED)
        self.sign_in(page1, "A")
        self.sign_in(page2, "A")
        callbacks = self.callbacks(second)
        try:
            self.assertEqual(self.stack.kc_admin("PUT", f"/users/{self.ids['A']}", {"enabled": False}).status, 204)
            alive = self.provider_alive("A")   # an observation: whether the provider keeps a disabled member's sessions
            self.assertEqual(self.probe_at_the_landing(second, page2), "keycloak")
            self.assertEqual([c for c in callbacks if c["code"]], [], "prompt=none gave no code from the disabled member's provider session")
            self.assertTrue(self.refused_credentials(page2, "A"), "the provider refuses the disabled member's credentials")
            self.assertEqual([c for c in callbacks if c["code"]], [])
            psql(f'UPDATE "AuthSession" SET "atExpiresAt" = now() - interval \'1 minute\' WHERE sub=\'{self.ids["A"]}\';')
            self.assertEqual(self.me(first), (401, None), "the provider refused the refresh: the other browser's session ended")
            self.assertIn(("auth.session.expired", "refresh_failed"), self.ends("A"))
            self.assertEqual(self.stack.kc_admin("PUT", f"/users/{self.ids['A']}", {"enabled": True}).status, 204)
            self.assertEqual(self.credentials(page2, "A"), "main", "enabled again, A's credentials let A in")
            self.assertEqual(self.me(second), (200, self.ids["A"]))
            self.report("SE-10", provider_sessions_after_disable=alive, probe_errors=[c["error"] for c in callbacks if not c["code"]])
        finally:
            if self.provider_enabled("A") is False:
                self.stack.kc_admin("PUT", f"/users/{self.ids['A']}", {"enabled": True})

    def test_11_an_isolation_ends_each_provider_session_by_its_id_and_the_next_sso_given_that_id_lives(self):
        """S7-U5 D600 (fix round 6) on the real Keycloak, with the sid reuse of D598: doctor A is signed in on two PCs, one
        a profile that once closed a login page (so Keycloak gives that browser's next SSO the same id, SE-03b). The
        administrator suspends A: each of A's provider sessions is ended by its own id (an end request recorded per id and
        settled by its own answer; there is no whole-user logout). The next person B signs in in A's browser: B's new SSO
        gets the ended SSO's id, B enters with one credential entry and B's session survives a refresh - no end request of
        that id is left to land on it. The premise, shown on the real Keycloak: an end request of that id issued now ends
        B's SSO and B's refresh fails - which is why the product keeps an id closed while an end request of it is unknown.
        Not coverable here: an end request HELD while B's new SSO is made and released afterwards. This stack can pause only
        the whole Keycloak (SE-02), so no new SSO can be made while a request is held, and a Suspend reads the member from
        Keycloak before it ends a session, so a pause before it holds the Suspend itself; that order is U5E-24 of
        tests/auth_session_service_test.cjs (real PostgreSQL, a fake provider holding the request's effect and answer)."""
        context, page = self.profile()
        spare = context.new_page()
        spare.goto(self.stack.proxy + "/api/auth/login")
        self.assertEqual(self.settle(spare), "keycloak")
        spare.close()
        self.sign_in(page, "A")
        self.assertTrue(self.keycloak_kept_the_login_screen(context), "precondition: the abandoned login screen outlived A's login")
        a_sid, _ = self.provider_session_and_token("A")
        other, page2 = self.profile()
        self.sign_in(page2, "A")
        a_sids = list(dict.fromkeys(self.case_sessions["A"]))
        self.assertEqual((len(a_sids), self.provider_alive("A")), (2, 2), "A has two provider sessions")
        try:
            changed = self.admin_sets_enabled("A", False)
            self.assertEqual((changed.status, (changed.body or {}).get("enabled")), (200, False), changed.text)
            self.assertEqual((self.isolation("A"), self.product_sessions("A"), self.provider_alive("A")), ((True, True), 0, 0),
                             "isolated: the fact done, no product or provider session of A left")
            for sid in a_sids:
                requests = self.end_requests(sid)
                self.assertTrue(requests and all(state == "done" for state in requests), (sid, requests))
            # B in A's browser: the landing, Login, B's credentials.
            page.goto(self.stack.proxy + APP + "index.html")
            at = self.settle(page)
            if at == "landing":
                at = self.press(page, "#signin")
            self.assertEqual(at, "keycloak")
            self.assert_editable_form(page, "the next person's Login after the isolation")
            asked = len(context.asked)
            self.assertEqual(self.credentials(page, "B"), "main", "B enters with one credential entry")
            self.assertEqual(context.asked[asked:], [], "no second form, no restarted flow")
            self.assertEqual(self.me(context), (200, self.ids["B"]))
            b_sid, _ = self.provider_session_and_token("B")
            self.assertEqual(b_sid, a_sid, "precondition: Keycloak gave B's new SSO the ended SSO's id - else this case proves nothing")
            # B's session survives a refresh: nothing of the isolation is left to end that id.
            psql(f'UPDATE "AuthSession" SET "atExpiresAt" = now() - interval \'1 minute\' WHERE sub=\'{self.ids["B"]}\';')
            self.assertEqual((self.me(context), self.provider_alive("B"), self.refusals("B")), ((200, self.ids["B"]), 1, 0),
                             "B refreshes and B's provider session lives")
            # The premise on the real Keycloak: an end request of that id issued now ends B's SSO, and B's refresh fails.
            premise = self.stack.kc_admin("DELETE", f"/sessions/{b_sid}")
            psql(f'UPDATE "AuthSession" SET "atExpiresAt" = now() - interval \'1 minute\' WHERE sub=\'{self.ids["B"]}\';')
            ended_b = (premise.status, self.provider_alive("B"), self.me(context))
            self.assertEqual(ended_b, (204, 0, (401, None)), "a late end request of that id would end the next person's SSO")
            # Every change of A has its own answer by now (the disable answered with the Suspend's 200, A's end requests
            # done above; the premise's DELETE went to Keycloak directly and B's ended session is B's), so the FIRST press
            # must succeed: a 409 ACTIVATION_UNCONFIRMED here would be a real unconfirmed state, not one to press through.
            activated = self.admin_sets_enabled("A", True)
            self.assertEqual((activated.status, (activated.body or {}).get("enabled")), (200, True), activated.text)
            self.assertEqual((self.isolation("A"), self.provider_enabled("A")), ((False, False), True))
            self.report("SE-11", same_sid=True, a_provider_sessions=len(a_sids), activate_first_answer=activated.status,
                        held_end_released_after_new_sso="not coverable here")
        finally:
            if self.isolation("A")[0] or self.provider_enabled("A") is False:
                psql(f'DELETE FROM "MemberIsolation" WHERE sub=\'{self.ids["A"]}\';')
                self.stack.kc_admin("PUT", f"/users/{self.ids['A']}", {"enabled": True})


if __name__ == "__main__":
    unittest.main(verbosity=2)
