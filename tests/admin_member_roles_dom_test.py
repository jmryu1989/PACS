# coding: utf-8
"""REQ-S5-U5a-CLINICIAN-ROLE-ROUNDTRIP -> RISK-S5-U5a-SILENT-ROLE-DROP / RISK-S5-U5a-LABEL-RULE -> TEST-S5-U5a-DOM.

The Members console (worklist-v0/hpacs-lite/admin.html) replaces a member's whole role list on save
(PATCH roles). Before S5-U5a it drew three role checkboxes and sent only the checked ones, so a member
holding clinician lost it with no error. Until Astra S5-U5a-F01 every Save also re-sent approvalState,
institution, roles and verificationOverride. AdminService.patchUser treats any of approvalState=APPROVED,
institution or roles as a membership write: it isolates the member first (sessions deleted, Keycloak
logout) and fills the fields it did not receive from its current values. So a Save with nothing changed
ended the member's sessions, and an institution-only edit put back a role list another admin had changed
after this page read the list. This harness loads the shipped admin.html, auth.js and
study-access-admin.js unchanged from a synthetic origin, answers /api/me and /api/admin/users from an
in-test store that sorts roles as AdminService.row() does and, like patchUser, keeps the fields a PATCH
leaves out, and records every PATCH body:

  01  clinician-only, mixed, legacy and suspended members: Save with nothing changed (also after a
      padded institution, a role unchecked and checked again, or the e-mail override alone) sends no
      request, says so in Korean and keeps the dialog open; the reopened dialog shows the same roles.
  02  a mixed {clinician, radiologist} member: a role change sends {roles} and nothing else; clinician
      stays when the admin changes another role and goes only when the admin unchecks it.
  03  a role this page does not draw (a server role list ahead of the page) is shown read-only, counts
      in the unchanged comparison and is sent back with a role change; it never leaks into the next
      member's dialog or save; its text is never markup.
  04  a PENDING member is approved as clinician from the keyboard with the override (approvalState,
      institution, roles, verificationOverride); an INVALID member is approved by adding one role
      (approvalState, roles: the institution it already has is not sent).
  05  every item of S5-U5a wording_acceptance.english_required (24) reads as the English label below,
      static (read while the first list request is held) and script-rendered; no button, heading,
      badge or header link has Hangul; the new role labels are not below 12px.
  06  explanations, tooltips, confirmations and errors stay Korean; member data is not translated.
  07  controls: the pre-fix role handling (no clinician checkbox, admin.html:446 submit) and a
      checked-only submit are served through the same route and must drop roles exactly as the risk
      says, so cases 01-03 cannot pass on a page that drops roles.
  08  partial edits over a newer server state: institution only -> {institution}, and roles another
      admin set after the list read stay; roles only -> {roles}, and the institution another admin set
      stays; the override rides on an APPROVED member's edit without approvalState.
  09  control: the c59e039 submit (all four fields on every Save) is served through the same route and
      must PATCH on an unchanged Save and overwrite the newer roles, so cases 01 and 08 cannot pass on a
      harness that misses the request or a store that ignores it.

Synthetic data only (SYN-* names): no server, no network, no credentials. A request the harness does
not answer is aborted and fails the case. The service half (approve [clinician] -> mixed -> revoke on
the real API and Keycloak) is tests/clinician_policy_live.py test_03, hosted only.
"""
import copy
from pathlib import Path
import re
import sys
import time
import unicodedata
import unittest
from urllib.parse import parse_qs, unquote, urlparse

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"


def lf_text(path):
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


ADMIN_HTML = lf_text(HPACS / "admin.html")
ORIGIN = "https://members.test"
PAGE_PATH = "/worklist/hpacs-lite/admin.html"
SCRIPTS = {
    "/worklist/hpacs-lite/auth.js": lf_text(HPACS / "auth.js"),
    "/worklist/hpacs-lite/study-access-admin.js": lf_text(HPACS / "study-access-admin.js"),
}
INSTITUTION = "SYN-INST-A"
ME = {"sub": "SYN-ADMIN-SUB", "user": "syn-admin", "displayName": "SYN Admin", "roles": ["admin"],
      "institution": INSTITUTION}
FUTURE_ROLE = "syn-future-role"
# A role name is data. AdminService.row() filters roles to APP_ROLES today, so this cannot arrive
# from the real server; it checks that the new read-only role display renders text, not markup.
HOSTILE_ROLE = '<img src=x onerror="document.body.dataset.pwned=1">'


def member(uid, username, roles, name, state="APPROVED", enabled=True, institution=INSTITUTION):
    return {"id": uid, "username": username, "email": f"{username}@members.test", "emailVerified": True,
            "name": name, "institution": institution, "roles": sorted(roles), "enabled": enabled,
            "approvalState": state}


USERS = [
    member("SYN-U-CLIN", "syn-clinician", ["clinician"], "SYN Clinician"),
    member("SYN-U-MIXED", "syn-mixed", ["clinician", "radiologist"], "SYN Mixed"),
    member("SYN-U-FUTURE", "syn-future", ["radiologist", FUTURE_ROLE, HOSTILE_ROLE], "SYN Future"),
    member("SYN-U-LEGACY", "syn-legacy", ["admin", "radiologist", "technician"], "홍길동 SYN"),
    member("SYN-U-SUSPENDED", "syn-suspended", ["technician"], "SYN Suspended", enabled=False),
    member("SYN-U-INVALID", "syn-invalid", [], "SYN Invalid", state="INVALID"),
    member("SYN-U-PENDING", "syn-pending", [], "SYN Pending", state="PENDING", institution=None),
]

# stage5-units.json S5-U5a wording_acceptance.english_required, item by item. The line numbers are
# admin.html before this unit (489c326 = 657cd77 for this file).
ENGLISH_REQUIRED = [
    ("title", ":6 <title>", "Members — KIN"),
    ("h1", ":87 h1", "Members"),
    ("createTitle", ":130 h2", "Create Member"),
    ("membershipTitle", ":147 h2 #membership-title (static)", "Approve Member"),
    ("membershipTitleScript", ":275 #membership-title (script: PENDING, other)", ("Approve Member", "Change Membership")),
    ("passwordTitle", ":170 h2", "Temporary Password"),
    ("logout", ":91 button", "Log out"),
    ("refresh", ":104 button", "Refresh"),
    ("openCreate", ":105 button", "Create Member"),
    ("previous", ":120 button", "Previous"),
    ("next", ":122 button", "Next"),
    ("createCancel", ":139 button", "Cancel"),
    ("createSubmit", ":140 button", "Create"),
    ("membershipCancel", ":162 button", "Cancel"),
    ("membershipSubmit", ":163 button", "Save"),
    ("closePassword", ":174 button", "Confirm & Close"),
    ("openAction", ":337 action() (PENDING, other)", ("Approve", "Change Membership")),
    ("revokeAction", ":339 action()", "Revoke Approval"),
    ("tempAction", ":340 action()", "Temp Password"),
    ("emailAction", ":341 action()", "Email Reset Link"),
    ("suspendAction", ":343 action()", "Suspend"),
    ("activateAction", ":344 action()", "Activate"),
    ("pendingBadge", ":102 #pending-badge (static)", "Pending 0"),
    ("pendingBadgeScript", ":383 #pending-badge (script, one PENDING member)", "Pending 1"),
]

STATIC_LABELS = """() => { const t = selector => document.querySelector(selector).textContent;
  return {title: document.title, h1: t('header h1'), createTitle: t('#create-dialog h2'),
    membershipTitle: t('#membership-title'), passwordTitle: t('#password-dialog h2'), logout: t('#logout'),
    refresh: t('#refresh'), openCreate: t('#open-create'), previous: t('#previous'), next: t('#next'),
    createCancel: t('#create-dialog [data-close]'), createSubmit: t('#create-dialog button[type=submit]'),
    membershipCancel: t('#membership-dialog [data-close]'), membershipSubmit: t('#membership-dialog button[type=submit]'),
    closePassword: t('#close-password'), pendingBadge: t('#pending-badge'), worklist: t('header a.button-link'),
    rows: document.querySelectorAll('#users tr').length}; }"""

DIALOG = """() => ({
  title: document.querySelector('#membership-title').textContent,
  institution: document.querySelector('#membership-form input[name="institution"]').value,
  checked: [...document.querySelectorAll('#membership-roles input[name="role"]')].filter(i => i.checked).map(i => i.value),
  unmanaged: [...document.querySelectorAll('#membership-roles label.unmanaged')].map(label => {
    const input = label.querySelector('input');
    return {text: label.textContent, title: label.title, checked: input.checked, disabled: input.disabled,
            named: input.hasAttribute('name'), elements: label.querySelectorAll('*').length}; }),
  message: document.querySelector('#membership-message').textContent,
  open: document.querySelector('#membership-dialog').open})"""

# UXR-SP-34 / UXR-G-18: the words UXR-SP-34 names for core screens. The full used/avoided list is in
# canvas/boards/Regulatory.dc.html L51-58, which this unit does not read.
AVOIDED = re.compile(r"진단|검출|판정|우선순위|diagnos|detect|priorit|\bAI\b", re.IGNORECASE)

NO_CHANGE = "변경된 내용이 없어 저장하지 않았습니다."

CLINICIAN_CHECKBOX = '          <label><input type="checkbox" name="role" value="clinician">임상의</label>\n'
SHIPPED_ROLES = (
    "        const roles = [\n"
    "          ...roleInputs().filter(input => input.checked).map(input => input.value),\n"
    "          ...base.unmanaged,\n"
    "        ];\n"
)
# admin.html:446 before S5-U5a, verbatim.
PRE_FIX_ROLES = "        const roles = [...form.querySelectorAll('input[name=\"role\"]:checked')].map(input => input.value);\n"
CHECKED_ONLY_ROLES = (
    "        const roles = [\n"
    "          ...roleInputs().filter(input => input.checked).map(input => input.value),\n"
    "        ];\n"
)
SHIPPED_BODY = (
    "        const body = {};\n"
    "        if (base.approvalState !== \"APPROVED\") body.approvalState = \"APPROVED\";\n"
    "        if (institution !== base.institution) body.institution = institution;\n"
    "        if (!sameRoles(roles, base.roles)) body.roles = roles;\n"
)
# The PATCH body of admin.html:452-457 before S5-U5a and :482-487 at c59e039, the same four fields.
FULL_BODY = (
    "        const body = {\n"
    "          approvalState: \"APPROVED\",\n"
    "          institution: form.elements.institution.value,\n"
    "          roles,\n"
    "          verificationOverride: form.elements.verificationOverride.checked,\n"
    "        };\n"
)


def has_hangul(text):
    return any(unicodedata.name(ch, "").startswith("HANGUL") for ch in text)


def variant(edits):
    text = ADMIN_HTML
    for old, new in edits:
        found = text.count(old)
        if found != 1:
            raise AssertionError(f"setup: {old!r} occurs {found} times in admin.html")
        text = text.replace(old, new)
    return text


class AdminMemberRolesDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.variants = {
            "pre-fix": variant([(CLINICIAN_CHECKBOX, ""), (SHIPPED_ROLES, PRE_FIX_ROLES), (SHIPPED_BODY, FULL_BODY)]),
            "checked-only": variant([(SHIPPED_ROLES, CHECKED_ONLY_ROLES)]),
            "full-body": variant([(SHIPPED_BODY, FULL_BODY)]),
        }
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.users = copy.deepcopy(USERS)
        self.admin_body = ADMIN_HTML
        self.patches, self.resets, self.unexpected, self.errors = [], [], [], []
        self.list_reads = 0
        self.held_lists = None
        self.patch_error = None
        self.page = self.browser.new_page(viewport={"width": 1280, "height": 900})
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.route("**/*", self.route)

    def tearDown(self):
        self.page.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.unexpected, "requests the harness does not answer")

    # ── synthetic origin ──
    def route(self, route):
        request = route.request
        url = urlparse(request.url)
        method, path = request.method, url.path
        if f"{url.scheme}://{url.netloc}" != ORIGIN:
            self.unexpected.append(f"{method} {request.url}")
            route.abort()
            return
        if method == "GET" and path == PAGE_PATH:
            route.fulfill(body=self.admin_body, content_type="text/html; charset=utf-8")
            return
        if method == "GET" and path in SCRIPTS:
            route.fulfill(body=SCRIPTS[path], content_type="application/javascript; charset=utf-8")
            return
        if path == "/favicon.ico":
            route.fulfill(status=404, body="")
            return
        if path.startswith("/api/") and request.headers.get("x-kin-csrf") != "1":
            self.unexpected.append(f"{method} {path} without X-KIN-CSRF")
            route.abort()
            return
        if method == "GET" and path == "/api/me":
            route.fulfill(json=ME)
            return
        if method == "GET" and path == "/api/admin/users" and parse_qs(url.query) == {"page": ["1"]}:
            self.list_reads += 1
            if self.held_lists is not None:
                self.held_lists.append(route)
                return
            route.fulfill(json=self.listing())
            return
        found = re.fullmatch(r"/api/admin/users/([^/]+)(/reset-password)?", path)
        user = found and next((u for u in self.users if u["id"] == unquote(found.group(1))), None)
        if user and method == "PATCH" and not found.group(2):
            body = request.post_data_json
            self.patches.append((user["id"], body))
            if self.patch_error:
                route.fulfill(status=self.patch_error[0], json=self.patch_error[1])
                return
            self.apply(user, body)
            route.fulfill(json=user)
            return
        if user and method == "POST" and found.group(2):
            body = request.post_data_json
            self.resets.append((user["id"], body))
            reply = dict(user, temporaryPassword="SYN-TEMPORARY-VALUE") if body.get("mode") == "temp" else user
            route.fulfill(json=reply)
            return
        self.unexpected.append(f"{method} {request.url}")
        route.abort()

    def listing(self):
        return {"page": 1, "pageSize": 25, "total": len(self.users),
                "pendingCount": sum(u["approvalState"] == "PENDING" for u in self.users),
                "users": copy.deepcopy(self.users)}

    @staticmethod
    def apply(user, body):
        # The part of AdminService.patchUser this page reaches: an approval or membership write takes
        # the institution and roles it did not receive from the stored member (patchUser :252-253) and
        # replaces the whole role list, returned deduplicated and sorted as row() does.
        if body.get("approvalState") == "PENDING":
            user.update(approvalState="PENDING", institution=None, roles=[])
        elif body.get("approvalState") == "APPROVED" or "roles" in body or "institution" in body:
            user.update(approvalState="APPROVED", institution=body.get("institution", user["institution"]),
                        roles=sorted(set(body.get("roles", user["roles"]))))
        elif "enabled" in body:
            user["enabled"] = body["enabled"]

    # ── page helpers ──
    def wait_until(self, predicate, what, timeout=10.0):
        # Sync-API route handlers run on this thread while wait_for_timeout blocks.
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail(f"{what}: not observed within {timeout:.0f}s")
            self.page.wait_for_timeout(10)

    def load(self, body=None):
        if body is not None:
            self.admin_body = body
        self.page.goto(ORIGIN + PAGE_PATH)
        expect(self.page.locator("#users td.username")).to_have_count(len(self.users))

    def user(self, username):
        return next(u for u in self.users if u["username"] == username)

    def row(self, username):
        exact = re.compile("^" + re.escape(username) + "$")
        return self.page.locator("#users tr").filter(has=self.page.locator("td.username", has_text=exact))

    def roles_cell(self, username):
        return self.row(username).locator("td").nth(3)

    def actions(self, username):
        return self.row(username).locator("td.actions button").all_text_contents()

    def open_membership(self, username, label="Change Membership"):
        self.row(username).get_by_role("button", name=label, exact=True).click()
        self.page.wait_for_function("() => document.querySelector('#membership-dialog').open")

    def dialog(self):
        return self.page.evaluate(DIALOG)

    def cancel(self):
        self.page.locator("#membership-dialog [data-close]").click()
        self.page.wait_for_function("() => !document.querySelector('#membership-dialog').open")

    def message_shown(self):
        return self.page.evaluate("() => document.querySelector('#message').classList.contains('show')")

    def save(self, reload=True):
        before, reads = len(self.patches), self.list_reads
        # Rows replaced by the reload lose this mark, so the next click never lands on a row being redrawn.
        self.page.evaluate("() => document.querySelectorAll('#users tr').forEach(r => { r.dataset.harnessStale = '1'; })")
        self.page.locator("#membership-dialog button[type=submit]").click()
        self.wait_until(lambda: len(self.patches) == before + 1, "the membership PATCH")
        if reload:
            self.wait_until(lambda: self.list_reads > reads, "the member list reload after the PATCH")
            self.page.wait_for_function(
                "() => document.querySelector('#users tr') && !document.querySelector('#users tr[data-harness-stale]')")
        return self.patches[-1][1]

    def save_unchanged(self):
        before, reads = len(self.patches), self.list_reads
        self.page.locator("#membership-dialog button[type=submit]").click()
        # The notice is written after the comparison and nothing is awaited before it, so once it shows the
        # submit handler has taken the no-request branch. Each case also checks self.patches at its end.
        expect(self.page.locator("#membership-message")).to_have_text(NO_CHANGE)
        self.assertTrue(self.dialog()["open"], "an unchanged Save keeps the dialog open")
        self.assertEqual((before, reads), (len(self.patches), self.list_reads), "an unchanged Save sends nothing")

    def set_role(self, role, on):
        self.page.locator(f'#membership-roles input[name="role"][value="{role}"]').set_checked(on)

    def set_institution(self, value):
        self.page.locator('#membership-form input[name="institution"]').fill(value)

    def set_override(self, on):
        self.page.locator('#membership-form input[name="verificationOverride"]').set_checked(on)

    # ── cases ──
    def test_01_unchanged_save_sends_nothing_and_the_role_set_survives(self):
        # S5-U5a-F01: patchUser isolates the member (sessions deleted, Keycloak logout) on any approval or
        # membership field, so a Save that changes nothing must not send one.
        self.load()
        cases = (("syn-clinician", ["clinician"], "clinician"),
                 ("syn-mixed", ["radiologist", "clinician"], "clinician, radiologist"),
                 ("syn-legacy", ["radiologist", "technician", "admin"], "admin, radiologist, technician"),
                 ("syn-suspended", ["technician"], "technician"))
        for username, roles, cell in cases:
            with self.subTest(member=username):
                expect(self.roles_cell(username)).to_have_text(cell)
                self.open_membership(username)
                seen = self.dialog()
                self.assertEqual(("Change Membership", INSTITUTION, roles, []),
                                 (seen["title"], seen["institution"], seen["checked"], seen["unmanaged"]))
                self.save_unchanged()
                self.cancel()
                self.open_membership(username)
                seen = self.dialog()
                self.assertEqual((roles, ""), (seen["checked"], seen["message"]))
                self.cancel()
                expect(self.roles_cell(username)).to_have_text(cell)

        # Edits that come back to the loaded values are no change either: the institution is compared
        # trimmed, the roles as a set, and the e-mail override is not a field on its own.
        self.open_membership("syn-mixed")
        self.set_institution(f"  {INSTITUTION}  ")
        self.set_role("clinician", False)
        self.set_role("clinician", True)
        self.set_override(True)
        self.save_unchanged()
        self.cancel()

        self.assertEqual([], self.patches)
        self.assertEqual(1, self.list_reads)
        self.assertEqual(USERS, self.users)
        self.assertFalse(self.message_shown())

    def test_02_mixed_member_role_change_sends_roles_only_and_keeps_clinician(self):
        self.load()
        steps = (("technician added", {"technician": True}, ["radiologist", "clinician"],
                  ["radiologist", "technician", "clinician"]),
                 ("clinician unchecked by the admin", {"clinician": False}, ["radiologist", "technician", "clinician"],
                  ["radiologist", "technician"]))
        for label, edits, shown, sent in steps:
            with self.subTest(step=label):
                self.open_membership("syn-mixed")
                self.assertEqual(shown, self.dialog()["checked"])
                for role, on in edits.items():
                    self.set_role(role, on)
                self.assertEqual({"roles": sent}, self.save())
                self.assertEqual(sorted(sent), self.user("syn-mixed")["roles"])
                self.assertEqual(("APPROVED", INSTITUTION),
                                 (self.user("syn-mixed")["approvalState"], self.user("syn-mixed")["institution"]))
                expect(self.roles_cell("syn-mixed")).to_have_text(", ".join(sorted(sent)))
        self.assertFalse(self.message_shown())

    def test_03_unmanaged_roles_are_shown_read_only_sent_back_and_never_leak(self):
        self.load()
        self.open_membership("syn-future")
        seen = self.dialog()
        self.assertEqual(["radiologist"], seen["checked"])
        self.assertEqual([HOSTILE_ROLE, FUTURE_ROLE], [item["text"] for item in seen["unmanaged"]])
        for item in seen["unmanaged"]:
            # Checked and disabled, no name (never a form value), one child element (the input only).
            self.assertEqual((True, True, False, 1), (item["checked"], item["disabled"], item["named"], item["elements"]))
            self.assertTrue(has_hangul(item["title"]), item["title"])
        self.assertIsNone(self.page.evaluate("() => document.body.dataset.pwned ?? null"))
        # The page lists the unmanaged roles after the checked ones, the server sorted them: still no change.
        self.save_unchanged()
        self.cancel()

        self.open_membership("syn-future")
        self.set_role("radiologist", False)
        self.set_role("clinician", True)
        self.assertEqual({"roles": ["clinician", HOSTILE_ROLE, FUTURE_ROLE]}, self.save())
        self.assertEqual(sorted(["clinician", HOSTILE_ROLE, FUTURE_ROLE]), self.user("syn-future")["roles"])

        self.open_membership("syn-clinician")
        seen = self.dialog()
        self.assertEqual((["clinician"], []), (seen["checked"], seen["unmanaged"]))
        self.set_role("technician", True)
        self.assertEqual({"roles": ["technician", "clinician"]}, self.save())
        self.assertIsNone(self.page.evaluate("() => document.body.dataset.pwned ?? null"))

    def test_04_pending_and_invalid_members_are_approved_explicitly(self):
        self.load()
        expect(self.page.locator("#pending-badge")).to_have_text("Pending 1")
        self.row("syn-pending").get_by_role("button", name="Approve", exact=True).focus()
        self.page.keyboard.press("Enter")
        self.page.wait_for_function("() => document.querySelector('#membership-dialog').open")
        seen = self.dialog()
        self.assertEqual(("Approve Member", "", [], []), (seen["title"], seen["institution"], seen["checked"], seen["unmanaged"]))
        self.set_institution(INSTITUTION)
        self.page.get_by_role("checkbox", name="임상의", exact=True).check()
        self.set_override(True)
        self.assertEqual({"approvalState": "APPROVED", "institution": INSTITUTION, "roles": ["clinician"],
                          "verificationOverride": True}, self.save())
        expect(self.row("syn-pending").locator("td").nth(4)).to_have_text("APPROVED")
        expect(self.roles_cell("syn-pending")).to_have_text("clinician")
        expect(self.page.locator("#pending-badge")).to_have_text("Pending 0")

        # INVALID here is one institution and no role: the approval adds the role and keeps the institution.
        self.open_membership("syn-invalid")
        seen = self.dialog()
        self.assertEqual(("Change Membership", INSTITUTION, []), (seen["title"], seen["institution"], seen["checked"]))
        self.set_role("radiologist", True)
        self.assertEqual({"approvalState": "APPROVED", "roles": ["radiologist"]}, self.save())
        self.assertEqual(("APPROVED", INSTITUTION, ["radiologist"]),
                         tuple(self.user("syn-invalid")[key] for key in ("approvalState", "institution", "roles")))
        expect(self.row("syn-invalid").locator("td").nth(4)).to_have_text("APPROVED")
        self.assertFalse(self.message_shown())

    def test_05_english_required_labels_static_and_script_rendered(self):
        self.assertEqual(24, len(ENGLISH_REQUIRED))
        self.held_lists = []
        self.page.goto(ORIGIN + PAGE_PATH)
        self.wait_until(lambda: len(self.held_lists) == 1, "the first member list request")
        static = self.page.evaluate(STATIC_LABELS)
        self.assertEqual(0, static["rows"], "static labels must be read before the list renders")
        held, self.held_lists = self.held_lists, None
        held[0].fulfill(json=self.listing())
        expect(self.page.locator("#users td.username")).to_have_count(len(self.users))

        actions = {name: self.actions(name) for name in ("syn-pending", "syn-clinician", "syn-suspended", "syn-invalid")}
        self.assertEqual({
            "syn-pending": ["Approve", "Temp Password", "Email Reset Link", "Suspend"],
            "syn-clinician": ["Change Membership", "Revoke Approval", "Temp Password", "Email Reset Link", "Suspend",
                              "Study Access"],
            "syn-suspended": ["Change Membership", "Revoke Approval", "Temp Password", "Email Reset Link", "Activate"],
            "syn-invalid": ["Change Membership", "Temp Password", "Email Reset Link", "Suspend"],
        }, actions)
        self.open_membership("syn-pending", "Approve")
        pending_title = self.dialog()["title"]
        self.cancel()
        self.open_membership("syn-clinician")
        other_title = self.dialog()["title"]
        self.cancel()

        observed = {key: static[key] for key in (
            "title", "h1", "createTitle", "membershipTitle", "passwordTitle", "logout", "refresh", "openCreate",
            "previous", "next", "createCancel", "createSubmit", "membershipCancel", "membershipSubmit",
            "closePassword", "pendingBadge")}
        observed.update(
            membershipTitleScript=(pending_title, other_title),
            openAction=(actions["syn-pending"][0], actions["syn-clinician"][0]),
            revokeAction=actions["syn-clinician"][1], tempAction=actions["syn-clinician"][2],
            emailAction=actions["syn-clinician"][3], suspendAction=actions["syn-clinician"][4],
            activateAction=actions["syn-suspended"][4],
            pendingBadgeScript=self.page.locator("#pending-badge").text_content())
        self.assertEqual({key for key, _, _ in ENGLISH_REQUIRED}, set(observed))
        for key, ref, expected in ENGLISH_REQUIRED:
            with self.subTest(ref=ref):
                self.assertEqual(expected, observed[key])
                for text in observed[key] if isinstance(observed[key], tuple) else (observed[key],):
                    self.assertFalse(has_hangul(text), text)

        # The header link to the worklist is a menu under AGENTS §4 as well (not in the packet list).
        self.assertEqual("Worklist", static["worklist"])
        self.open_membership("syn-future")
        sweep = self.page.evaluate(
            "() => [document.title, ...[...document.querySelectorAll('button, h1, h2, .badge, header a')].map(e => e.textContent)]")
        self.assertEqual([], [text for text in sweep if has_hangul(text)])
        new_text = [*sweep, *[item["title"] for item in self.dialog()["unmanaged"]], "임상의"]
        self.assertEqual([], [text for text in new_text if AVOIDED.search(text)])
        sizes = self.page.evaluate(
            "() => [...document.querySelectorAll('#membership-roles label')].map(l => parseFloat(getComputedStyle(l).fontSize))")
        self.assertEqual(6, len(sizes))
        self.assertTrue(all(size >= 12 for size in sizes), sizes)
        self.cancel()

    def test_06_guidance_stays_korean_and_member_data_is_not_translated(self):
        self.load()
        kept = self.page.evaluate("""() => ({
          placeholder: document.querySelector('#search').placeholder,
          secretWarning: document.querySelector('.secret-warning').textContent,
          legend: document.querySelector('#membership-roles legend').textContent,
          roleLabels: [...document.querySelectorAll('#membership-roles input[name="role"]')].map(i => i.parentElement.textContent),
          override: document.querySelector('input[name="verificationOverride"]').parentElement.textContent,
          headers: [...document.querySelectorAll('thead th')].map(th => th.textContent),
          invalid: document.querySelector('#users .warning')?.textContent ?? null})""")
        self.assertEqual({
            "placeholder": "아이디, 이름, 이메일",
            "secretWarning": "이 창을 닫으면 다시 볼 수 없습니다. 안전한 방법으로 회원에게 전달하세요.",
            "legend": "역할",
            "roleLabels": ["판독의", "방사선사", "관리자", "임상의"],
            "override": "대면 확인으로 이메일 검증 예외 승인",
            "headers": ["아이디", "이름 / 이메일", "기관", "역할", "상태", "작업"],
            "invalid": "기관·역할 설정을 확인하세요",
        }, kept)
        expect(self.row("syn-legacy").locator("td").nth(1)).to_contain_text("홍길동 SYN")
        expect(self.roles_cell("syn-legacy")).to_have_text("admin, radiologist, technician")

        self.open_membership("syn-clinician")
        self.set_role("clinician", False)
        self.page.locator("#membership-dialog button[type=submit]").click()
        expect(self.page.locator("#membership-message")).to_have_text("역할을 한 개 이상 선택하세요.")
        self.assertTrue(self.dialog()["open"])
        self.assertEqual([], self.patches)
        self.cancel()
        # A blank institution passes the required attribute but trims to nothing: refused before any request.
        self.open_membership("syn-clinician")
        self.set_institution("   ")
        self.page.locator("#membership-dialog button[type=submit]").click()
        expect(self.page.locator("#membership-message")).to_have_text("기관을 입력하세요.")
        self.assertTrue(self.dialog()["open"])
        self.assertEqual([], self.patches)
        self.cancel()

        self.row("syn-clinician").get_by_role("button", name="Email Reset Link", exact=True).click()
        expect(self.page.locator("#message")).to_have_text("비밀번호 변경 메일을 보냈습니다.")
        self.row("syn-clinician").get_by_role("button", name="Temp Password", exact=True).click()
        expect(self.page.locator("#temporary-password")).to_have_text("SYN-TEMPORARY-VALUE")
        self.page.get_by_role("button", name="Confirm & Close", exact=True).click()
        self.page.wait_for_function("() => !document.querySelector('#password-dialog').open")
        expect(self.page.locator("#temporary-password")).to_have_text("")
        self.assertEqual([("SYN-U-CLIN", {"mode": "email"}), ("SYN-U-CLIN", {"mode": "temp"})], self.resets)

        # A refusal is shown as the server wrote it; the store is unchanged.
        self.patch_error = (400, {"statusCode": 400, "message": "허용되지 않은 역할입니다"})
        self.open_membership("syn-mixed")
        self.set_role("technician", True)
        self.assertEqual({"roles": ["radiologist", "technician", "clinician"]}, self.save(reload=False))
        expect(self.page.locator("#message")).to_have_text("허용되지 않은 역할입니다")
        self.assertEqual(["clinician", "radiologist"], self.user("syn-mixed")["roles"])

        self.page.locator("#search").fill("SYN-NO-SUCH-MEMBER")
        expect(self.page.locator("#users td.empty")).to_have_text("조건에 맞는 회원이 없습니다.")

    def test_07_controls_pre_fix_and_checked_only_submits_drop_roles_silently(self):
        # The expected outputs are the defect, asserted exactly: a harness that observes nothing fails here.
        self.load(self.variants["pre-fix"])
        self.open_membership("syn-mixed")
        self.assertEqual(["radiologist"], self.save()["roles"], "pre-fix: the mixed member's clinician is dropped")
        self.assertFalse(self.message_shown(), "pre-fix: the drop is silent")
        self.open_membership("syn-clinician")
        self.page.locator("#membership-dialog button[type=submit]").click()
        expect(self.page.locator("#membership-message")).to_have_text("역할을 한 개 이상 선택하세요.")
        self.assertEqual(1, len(self.patches), "pre-fix: a clinician-only member cannot be saved")
        self.cancel()

        self.users, self.patches = copy.deepcopy(USERS), []
        self.load(self.variants["checked-only"])
        self.open_membership("syn-future")
        self.assertEqual(["radiologist"], self.save()["roles"], "checked-only: the unmanaged roles are dropped")

    def test_08_partial_edits_send_only_the_edited_field_and_keep_newer_server_values(self):
        self.load()
        # Another admin adds technician after this page read the list; this page edits the institution only.
        self.user("syn-mixed")["roles"] = ["clinician", "radiologist", "technician"]
        self.open_membership("syn-mixed")
        seen = self.dialog()
        self.assertEqual((INSTITUTION, ["radiologist", "clinician"]), (seen["institution"], seen["checked"]))
        self.set_institution(" SYN-INST-B ")
        self.assertEqual({"institution": "SYN-INST-B"}, self.save())
        self.assertEqual(("SYN-INST-B", ["clinician", "radiologist", "technician"]),
                         (self.user("syn-mixed")["institution"], self.user("syn-mixed")["roles"]))
        expect(self.roles_cell("syn-mixed")).to_have_text("clinician, radiologist, technician")

        # Another admin moves the legacy member to another institution; this page edits the roles only.
        self.user("syn-legacy")["institution"] = "SYN-INST-C"
        self.open_membership("syn-legacy")
        self.assertEqual(INSTITUTION, self.dialog()["institution"])
        self.set_role("technician", False)
        self.assertEqual({"roles": ["radiologist", "admin"]}, self.save())
        self.assertEqual(("SYN-INST-C", ["admin", "radiologist"]),
                         (self.user("syn-legacy")["institution"], self.user("syn-legacy")["roles"]))
        expect(self.row("syn-legacy").locator("td").nth(2)).to_have_text("SYN-INST-C")

        # The e-mail override rides on an APPROVED member's edit; approvalState is not sent again.
        self.open_membership("syn-clinician")
        self.set_institution("SYN-INST-B")
        self.set_override(True)
        self.assertEqual({"institution": "SYN-INST-B", "verificationOverride": True}, self.save())
        self.assertEqual(("SYN-INST-B", ["clinician"]),
                         (self.user("syn-clinician")["institution"], self.user("syn-clinician")["roles"]))
        self.assertEqual(3, len(self.patches))
        self.assertFalse(self.message_shown())

    def test_09_control_full_body_submit_patches_unchanged_saves_and_overwrites_newer_roles(self):
        # The expected outputs are the defect (S5-U5a-F01), asserted exactly.
        self.load(self.variants["full-body"])
        self.open_membership("syn-clinician")
        self.assertEqual({"approvalState": "APPROVED", "institution": INSTITUTION, "roles": ["clinician"],
                          "verificationOverride": False}, self.save(), "full-body: an unchanged Save is a PATCH")
        self.user("syn-mixed")["roles"] = ["clinician", "radiologist", "technician"]
        self.open_membership("syn-mixed")
        self.set_institution("SYN-INST-B")
        self.assertEqual(["radiologist", "clinician"], self.save()["roles"])
        self.assertEqual(["clinician", "radiologist"], self.user("syn-mixed")["roles"],
                         "full-body: the technician another admin added is overwritten")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
