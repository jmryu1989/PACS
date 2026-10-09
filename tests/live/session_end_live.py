"""TEST-S7-U5-END-LIVE (SE-01..SE-11, SE-03b, SE-03c): the session end on the real stack - real BFF, nginx, PostgreSQL and the real
Keycloak login form driven by a browser. No mock of the form, the authorization endpoint or the callback.

REQ-S7-U5-SESSION-END (R1 under D621: explicit Log out ends its provider session too, and an ended provider
authentication never produces a product session again; R2: a login started to leave, to switch, or
from a browser that cannot say whether the person left, makes a session only from credentials entered after that press)
  -> RISK-S7-U5-SILENT-REENTRY -> TEST-S7-U5-END-LIVE (this file; the ordered races are tests/auth_session_service_test.cjs
  U5E-01..U5E-10, the landing table is tests/auth_entry_dom_test.py).
Design: session-end design v2 (2026-10-05) section 5, acceptance cases 6 and 7, and the pre-review's real-Keycloak list:
the provider frozen during a Log out (F6-C), the next person at an unfinished-logout landing and at Switch account (an
editable user name, never the previous doctor's fixed re-authentication screen - F5), the probe and fresh steps, the
same doctor's other PC untouched, a provider end racing a refresh (F2), and what `auth_time` does across a refresh.
SE-09/SE-10 (superseded provider-isolation expectations, adapted to D621): an administrator suspends a signed-in member.
DB rights refuse the browser and old Bearer while provider sessions remain alive. Activate requires a later authentication.
SE-11 keeps the C10 same-sid end contract using explicit Log out; provider member reconciliation belongs to U5b.
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
LiveStack admin identity jmryu) and SE-10 changes A through the same product member API; both put A back
enabled. Every other case only reads Keycloak and the database.

Owned data: the LiveStack test identities doctor (A) and doctor2 (B), their product sessions, their access rows, the
end marks (IdpSessionEnd) of their own provider sessions and A's isolation fact (MemberIsolation) - all removed at the
end. Nothing secret is printed: each case prints one line `S7-U5-END-LIVE {case, ...}` of names, counts and booleans.
On a browser wait timeout, `S7-U5-WAIT-DIAGNOSTIC` adds at most 64 KiB of route/status/console categories and a
public landing reason. Each event history keeps at most 64 entries. Bodies, cookies, tokens and arbitrary page text
are omitted; KIN_EVIDENCE_DIR also receives this JSON if configured. The original timeout still fails the case.

STATUS WHEN WRITTEN (2026-10-05): not run - this job had no stack (Docker was out of bounds). The first run on the
stack is its first execution; a harness error there is not evidence about the product. SE-01..SE-08 ran 8/8 on the
synthetic stack on 2026-10-06; SE-09 and SE-10 were added the same day and have NOT run (the stack was reserved for
another operator) - their first run is their first execution. SE-03b and SE-03c were added with the CE1 fix (fix round
5b, 2026-10-06); their result is in that round's run record, not here.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import unittest
from collections import deque
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright

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
    "test_10_db_suspension_refuses_both_browsers_while_provider_sso_stays_alive",
    "test_11_explicit_logout_ends_its_provider_session_and_the_next_same_sid_sso_lives",
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
# The provider answered a credentials submit: it left its form, or showed its form again with a message.
# The form's own field ids and Keycloak's message element - not its wording.
SUBMITTED = """() => !location.pathname.startsWith('/auth/realms/kin/login-actions/authenticate')
  || (document.readyState === 'complete' && !!document.querySelector('#input-error, .kc-feedback-text'))"""


# Keep only known routes: even a path or hostname can carry credentials. Raw query,
# fragment, userinfo, arbitrary body/console text and screenshots are never saved.
DIAGNOSTIC_ROUTES = frozenset({
    "/api/me", "/api/auth/login", "/api/auth/register", "/api/auth/callback",
    "/api/auth/logout", "/api/auth/entry",
    "/auth/realms/kin/protocol/openid-connect/auth", "/auth/realms/kin/protocol/openid-connect/logout",
    "/auth/realms/kin/login-actions/authenticate", "/auth/realms/kin/login-actions/restart",
    APP + "index.html", APP + "main.html", APP + "clinician.html",
})


def diagnostic_url(value: str) -> str:
    try:
        if len(value) > 4096:
            return "[omitted-url]"
        url = urlparse(value)
        if url.scheme in ("", "http", "https") and url.path in DIAGNOSTIC_ROUTES:
            return url.path
    except (TypeError, ValueError):
        pass
    return "[omitted-url]"


def diagnostic_auth_error(value: str) -> str | None:
    # These public landing reasons distinguish a refused re-entry from a stuck
    # navigation without retaining any OIDC query values.
    try:
        if len(value) <= 4096:
            reason = parse_qs(urlparse(value).query).get("auth_error", [None])[0]
            if reason in ("stale", "session_active", "entry_unconfirmed", "end_unconfirmed", "login_failed", "sso_unidentified"):
                return reason
    except (TypeError, ValueError):
        pass
    return None


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
        # Remove any provider change records owned by the test identities, including after a failed case.
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
        context.on("page", self.watch_page)
        self.contexts.append(context)
        return context, context.new_page()

    def watch_page(self, page):
        # A fixed-size history is available even when the hosted runner removes
        # KIN_EVIDENCE_DIR. No body read, extra request or completion wait is added.
        page.diagnostic = {key: deque(maxlen=64) for key in ("events", "auth_responses", "console_errors")}

        def navigated(frame):
            if frame == page.main_frame:
                page.diagnostic["events"].append({"kind": "navigation", "url": diagnostic_url(frame.url)})

        def response_seen(response):
            route = diagnostic_url(response.url)
            if route.startswith("/api/auth/") or route.startswith("/auth/realms/kin/"):
                method = response.request.method
                location = response.headers.get("location", "")
                page.diagnostic["auth_responses"].append({"url": route, "status": response.status,
                    "method": method if method in ("GET", "POST", "DELETE", "OPTIONS") else "other",
                    "location": diagnostic_url(location), "auth_error": diagnostic_auth_error(location)})

        def console(message):
            if message.type == "error":
                # Retain fixed browser categories, never a regex match that could
                # contain an arbitrary console payload disguised as an error code.
                codes = [code for code in ("net::ERR_FAILED", "net::ERR_ABORTED", "net::ERR_CONNECTION_REFUSED",
                         "net::ERR_NAME_NOT_RESOLVED", "net::ERR_TIMED_OUT") if code in message.text[:4096]]
                page.diagnostic["console_errors"].append({"kind": "console-error", "codes": codes,
                    "source": diagnostic_url(message.location.get("url", "")), "text": "omitted"})

        def observe(callback):
            def guarded(value):
                try:
                    callback(value)
                except Exception:
                    page.diagnostic["events"].append({"kind": "diagnostic-unavailable"})
            return guarded

        page.on("framenavigated", observe(navigated))
        page.on("response", observe(response_seen))
        page.on("requestfailed", observe(lambda request: page.diagnostic["events"].append(
            {"kind": "request-failed", "url": diagnostic_url(request.url)})))
        page.on("console", observe(console))
        page.on("pageerror", observe(lambda error: page.diagnostic["console_errors"].append({"kind": "page-error", "text": "omitted"})))

    def dump_wait_failure(self, page, wait: str):
        """Best-effort, bounded evidence; never replace or retry the original failure."""
        try:
            dump = {"case": self._testMethodName, "wait": wait, "url": diagnostic_url(page.url),
                    "auth_error": diagnostic_auth_error(page.url),
                    **{key: list(values) for key, values in page.diagnostic.items()}}
            encoded = json.dumps(dump, ensure_ascii=True)
            if len(encoded) > 65536:
                encoded = json.dumps({"case": self._testMethodName, "wait": wait, "omitted": "size-limit"})
            print("S7-U5-WAIT-DIAGNOSTIC " + encoded, flush=True)
            root = os.environ.get("KIN_EVIDENCE_DIR")
            if root:
                directory = Path(root)
                directory.mkdir(parents=True, exist_ok=True)
                (directory / (self._testMethodName + "-" + wait + ".json")).write_text(encoded + "\n", encoding="utf-8")
        except Exception:
            # The fallback line can fail too (a closed stdout pipe on a hosted runner); it must not replace the
            # caller's original wait failure, which is re-raised right after this returns.
            try:
                print("S7-U5-WAIT-DIAGNOSTIC unavailable", flush=True)
            except Exception:
                pass

    def settle(self, page) -> str:
        try:
            return page.wait_for_function(WHERE).json_value()
        except PlaywrightTimeoutError:
            self.dump_wait_failure(page, "WHERE")
            raise

    def press(self, page, selector: str) -> str:
        """One press of a landing button; where the browser is once the press has been answered."""
        try:
            page.evaluate(WATCH_NOTICE)
            page.click(selector)
            page.wait_for_function(ANSWERED)
        except PlaywrightTimeoutError:
            self.dump_wait_failure(page, "ANSWERED")
            raise
        return self.settle(page)

    def credentials(self, page, who: str, name: bool = True) -> str:
        if name:
            if page.locator("#username").is_visible():
                page.fill("#username", self.stack.username(self.logins[who]))
            else:
                # prompt=login with retained SSO fixes the username and asks only for the password.
                self.assertEqual(page.locator("#kc-attempted-username").inner_text().strip(),
                                 self.stack.username(self.logins[who]))
        page.fill("#password", self.stack.passwords[self.logins[who]])
        page.click("#kc-login")
        try:
            page.wait_for_function("() => !location.pathname.startsWith('/auth/realms/kin/login-actions/authenticate') || !!document.querySelector('#input-error')")
        except PlaywrightTimeoutError:
            self.dump_wait_failure(page, "SUBMITTED")
            raise
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

    def assert_latest_rights(self, context, member):
        answer = context.request.get(self.stack.proxy + "/api/me")
        self.assertEqual(answer.status, 200)
        body = answer.json()
        self.assertEqual((body["sub"], body["institution"], sorted(body["roles"])),
                         (member["id"], member["institution"], sorted(member["roles"])))

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
        result = self.stack.request("PATCH", f"/admin/users/{self.ids[who]}", "jmryu", {"enabled": enabled})
        if result.status == 200:
            # auth_time is in whole seconds; a new login must be strictly after this command's boundary.
            time.sleep(1.05)
        return result

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
        """D621: Suspend ends product access; Activate still refuses the old authentication."""
        context, page = self.profile()
        self.sign_in(page, "A")
        provider, old = self.provider_session_and_token("A")
        before = self.provider_alive("A")
        try:
            changed = self.stack.set_member_rights(self.ids["A"], enabled=False)
            self.assertFalse(changed["enabled"])
            self.assertEqual(self.me(context), (401, None))
            self.assertEqual(self.product_sessions("A"), 0)
            self.assertEqual(self.stack.bearer_request("GET", "/me", old).status, 401)
            self.assertEqual((self.provider_alive("A"), self.provider_enabled("A")), (before, True))
            self.assertEqual(self.end_requests(provider), [], "Suspend schedules no provider session end")
            self.assertEqual(self.ends("A"), [("auth.logout", "isolation")])
            activated = self.stack.set_member_rights(self.ids["A"], enabled=True)
            self.assertEqual(self.stack.bearer_request("GET", "/me", old).status, 401)
            page.goto(self.stack.proxy + "/api/auth/login")
            self.assertEqual(self.settle(page), "keycloak", "old SSO requires one fresh login")
            asked = len(context.asked)
            self.assertEqual(self.credentials(page, "A"), "main")
            self.assertEqual(context.asked[asked:], [], "one password submission must enter without another prompt")
            self.assertEqual(self.me(context), (200, self.ids["A"]))
            self.assert_latest_rights(context, activated)
            self.report("SE-09", product_revoked=True, provider_untouched=True, fresh_login=True)
        finally:
            self.stack.set_member_rights(self.ids["A"], enabled=True)

    def test_10_db_suspension_refuses_both_browsers_while_provider_sso_stays_alive(self):
        """SE-10 / D621 core: DB suspension refuses both browsers while their provider remains enabled and SSO stays alive."""
        first, page1 = self.profile()
        second, page2 = self.profile()
        self.sign_in(page1, "A")
        self.sign_in(page2, "A")
        alive = self.provider_alive("A")
        self.assertEqual(alive, 2)
        try:
            self.stack.set_member_rights(self.ids["A"], enabled=False)
            self.assertEqual(self.me(first), (401, None))
            self.assertEqual(self.me(second), (401, None))
            self.assertEqual(self.product_sessions("A"), 0)
            self.assertEqual((self.provider_alive("A"), self.provider_enabled("A")), (alive, True))
            self.assertEqual(self.ends("A"), [("auth.logout", "isolation")] * 2)
            activated = self.stack.set_member_rights(self.ids["A"], enabled=True)
            page2.goto(self.stack.proxy + "/api/auth/login")
            self.assertEqual(self.settle(page2), "keycloak")
            asked = len(second.asked)
            self.assertEqual(self.credentials(page2, "A"), "main")
            self.assertEqual(second.asked[asked:], [], "one password submission must enter without another prompt")
            self.assertEqual(self.me(second), (200, self.ids["A"]))
            self.assert_latest_rights(second, activated)
            self.assertEqual(self.me(first), (401, None), "Activate cannot revive the other PC's product session")
            self.report("SE-10", refused_browsers=2, provider_untouched=True)
        finally:
            self.stack.set_member_rights(self.ids["A"], enabled=True)

    def activate(self, who: str):
        return self.admin_sets_enabled(who, True)

    def test_11_explicit_logout_ends_its_provider_session_and_the_next_same_sid_sso_lives(self):
        """SE-11 / C10/D598: explicit Log out ends its own sid; the next person's SSO with that sid survives."""
        context, page = self.profile()
        spare = context.new_page()
        spare.goto(self.stack.proxy + "/api/auth/login")
        self.assertEqual(self.settle(spare), "keycloak")
        spare.close()
        self.sign_in(page, "A")
        self.assertTrue(self.keycloak_kept_the_login_screen(context))
        a_sid, old = self.provider_session_and_token("A")
        self.assertEqual(self.me(context), (200, self.ids["A"]))
        self.assertEqual(context.request.post(self.stack.proxy + "/api/auth/logout", headers={
            "X-KIN-CSRF": "1", "X-KIN-Session": page.evaluate("KinAuth.sessionId()")}).status, 204)
        self.wait("provider logout confirmed", lambda: self.provider_alive("A") == 0, 30)
        self.assertEqual(self.product_sessions("A"), 0)
        self.assertTrue(self.end_requests(a_sid) and all(state == "done" for state in self.end_requests(a_sid)))
        # This direct API logout has no browser fresh-flow proof. Separate its confirmed end from the
        # next plain authentication's whole second; U5E-21 tests same-second admission with a fresh proof.
        time.sleep(1.05)
        page.goto(self.stack.proxy + APP + "index.html")
        at = self.settle(page)
        if at == "landing":
            at = self.press(page, "#signin")
        self.assertEqual(at, "keycloak")
        self.assert_editable_form(page, "the next person's Login after Log out")
        asked = len(context.asked)
        entered = self.credentials(page, "B")
        if entered != "main":
            causes = psql('SELECT detail::jsonb->>\'cause\' FROM "AuditLog" WHERE target=\'' + self.ids["B"] +
                          '\' AND action=\'auth.login\' AND id > ' + str(self.audit_floor) + ' ORDER BY id;')
            self.report("SE-11-refused", sequence=["logout-confirmed", "plain-login", "password", entered],
                        asked=context.asked[asked:], causes=causes, path=urlparse(page.url).path)
        self.assertEqual(entered, "main")
        self.assertEqual(context.asked[asked:], [], "no second credential form")
        self.assertEqual(self.me(context), (200, self.ids["B"]))
        b_sid, _ = self.provider_session_and_token("B")
        self.assertEqual(b_sid, a_sid, "same-sid reuse is the required premise")
        self.assertEqual(self.stack.bearer_request("GET", "/me", old).status, 401)
        psql(f'UPDATE "AuthSession" SET "atExpiresAt" = now() - interval \'1 minute\' WHERE sub=\'{self.ids["B"]}\';')
        self.assertEqual((self.me(context), self.provider_alive("B"), self.refusals("B")), ((200, self.ids["B"]), 1, 0))
        premise = self.stack.kc_admin("DELETE", f"/sessions/{b_sid}")
        psql(f'UPDATE "AuthSession" SET "atExpiresAt" = now() - interval \'1 minute\' WHERE sub=\'{self.ids["B"]}\';')
        self.assertEqual((premise.status, self.provider_alive("B"), self.me(context)), (204, 0, (401, None)))
        self.report("SE-11", same_sid=True, ended_old_bearer_refused=True, held_end_released_after_new_sso="not coverable here")


if __name__ == "__main__":
    unittest.main(verbosity=2)
