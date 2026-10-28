# coding: utf-8
"""KEY-ADMIN Members page: the admin's Signing Key action and dialog.

Loads the shipped admin.html and its scripts unchanged from a synthetic origin; /api/me, the member list and
/api/admin/users/:id/signing-key are answered by an in-memory model of the server contract (the server itself is
tests/emr/c/key_admin_live.py). Checked: which members offer the action, the exact commands the dialog sends for
create/rotate/retire, the required reason and retire confirmation, and that a lost or refused answer is never
drawn as a changed key (the page asks for Reload instead).
"""
import copy
from pathlib import Path
import re
import sys
import time
import unittest
from urllib.parse import parse_qs, unquote, urlparse
import uuid

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"


def lf_text(path):
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


ORIGIN = "https://signing-keys.test"
PAGE_PATH = "/worklist/hpacs-lite/admin.html"
SCRIPTS = {"/worklist/hpacs-lite/" + name: lf_text(HPACS / name) for name in (
    "auth.js", "work-context.js", "session-transport.js", "study-access-admin.js", "signing-key-admin.js",
    "admin-access-review.js", "held-sources-admin.js")}
INSTITUTION = "SYN-INST-A"
ME = {"sub": "SYN-ADMIN-SUB", "user": "syn-admin", "displayName": "SYN Admin", "roles": ["admin"],
      "institution": INSTITUTION, "sessionId": "SYN-SESSION-ADMIN"}


def member(uid, username, roles, state="APPROVED", enabled=True, institution=INSTITUTION):
    return {"id": uid, "username": username, "email": f"{username}@keys.test", "emailVerified": True,
            "name": username.upper(), "institution": institution, "roles": sorted(roles), "enabled": enabled,
            "approvalState": state}


USERS = [
    member("SYN-U-RAD", "syn-radiologist", ["radiologist"]),
    member("SYN-U-CLIN", "syn-clinician", ["clinician"]),
    member("SYN-U-TECH", "syn-suspended-tech", ["technician"], enabled=False),
    member("SYN-U-ADMIN", "syn-admin-only", ["admin"]),
    member("SYN-U-OTHER", "syn-other-rad", ["radiologist"], institution="SYN-INST-B"),
    member("SYN-U-PENDING", "syn-pending", [], state="PENDING", institution=None),
]


class AdminSigningKeyDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.users = copy.deepcopy(USERS)
        self.keys = {}          # member id -> [registration], newest first (the server's doctorKeys order)
        self.commands, self.reads, self.unexpected, self.errors = [], [], [], []
        self.post_reply = None  # None: apply as the server does; else ('abort',) or (status, body)
        self.page = self.browser.new_page(viewport={"width": 1280, "height": 900})
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.route("**/*", self.route)

    def tearDown(self):
        self.page.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.unexpected, "requests the harness does not answer")

    # ── synthetic origin and the server's key contract ──
    def view(self, uid):
        keys = self.keys.get(uid, [])
        return {"subject": uid, "institutionId": INSTITUTION,
                "current": next((k["kid"] for k in keys if k["status"] == "active"), None), "keys": copy.deepcopy(keys)}

    def apply(self, uid, body):
        keys, at = self.keys.setdefault(uid, []), "2026-10-26T00:00:%02d.000Z" % len(self.commands)
        current = next((k for k in keys if k["status"] == "active"), None)
        if body["action"] == "provision" and (current or body["expectedKid"] is not None):
            return 409, {"code": "KeyManagementConflict", "message": "서명키 상태가 바뀌었습니다. 다시 불러온 뒤 확인하세요."}
        if body["action"] != "provision" and (not current or current["kid"] != body["expectedKid"]):
            return 409, {"code": "KeyManagementConflict", "message": "서명키 상태가 바뀌었습니다. 다시 불러온 뒤 확인하세요."}
        if current:
            current.update(status="revoked", endedAt=at)
        if body["action"] in ("provision", "replace"):
            keys.insert(0, {"kid": str(uuid.uuid4()), "status": "active", "registeredAt": at, "endedAt": None})
        return 201, self.view(uid)

    def route(self, route):
        request = route.request
        url = urlparse(request.url)
        method, path = request.method, url.path
        if f"{url.scheme}://{url.netloc}" != ORIGIN:
            self.unexpected.append(f"{method} {request.url}")
            route.abort()
            return
        if method == "GET" and path == PAGE_PATH:
            route.fulfill(body=lf_text(HPACS / "admin.html"), content_type="text/html; charset=utf-8")
            return
        if method == "GET" and path in SCRIPTS:
            route.fulfill(body=SCRIPTS[path], content_type="application/javascript; charset=utf-8")
            return
        if path == "/favicon.ico":
            route.fulfill(status=404, body="")
            return
        if method == "GET" and path == "/api/me":
            route.fulfill(json=ME)
            return
        if method == "GET" and path == "/api/admin/users" and parse_qs(url.query) == {"page": ["1"]}:
            route.fulfill(json={"page": 1, "pageSize": 25, "total": len(self.users),
                                "pendingCount": sum(u["approvalState"] == "PENDING" for u in self.users),
                                "users": copy.deepcopy(self.users)})
            return
        found = re.fullmatch(r"/api/admin/users/([^/]+)/signing-key", path)
        if found:
            uid = unquote(found.group(1))
            if method == "GET":
                self.reads.append(uid)
                route.fulfill(json=self.view(uid))
                return
            if method == "POST":
                body = request.post_data_json
                self.commands.append((uid, body))
                if self.post_reply == ("abort",):
                    self.apply(uid, body)   # committed, but the answer is lost
                    route.abort()
                    return
                status, reply = self.post_reply or self.apply(uid, body)
                route.fulfill(status=status, json=reply)
                return
        self.unexpected.append(f"{method} {request.url}")
        route.abort()

    # ── page helpers ──
    def wait_until(self, predicate, what, timeout=10.0):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail(f"{what}: not observed within {timeout:.0f}s")
            self.page.wait_for_timeout(10)

    def load(self):
        self.page.goto(ORIGIN + PAGE_PATH)
        expect(self.page.locator("#users td.username")).to_have_count(len(self.users))

    def row(self, username):
        exact = re.compile("^" + re.escape(username) + "$")
        return self.page.locator("#users tr").filter(has=self.page.locator("td.username", has_text=exact))

    def open_keys(self, username):
        reads = len(self.reads)
        self.row(username).get_by_role("button", name="Signing Key", exact=True).click()
        self.wait_until(lambda: len(self.reads) == reads + 1, "the dialog's key read")
        expect(self.dialog.locator("[data-status]")).not_to_have_text("Loading")

    @property
    def dialog(self):
        return self.page.locator("#signing-key-dialog")

    def button(self, name):
        return self.dialog.get_by_role("button", name=name, exact=True)

    def visible_actions(self):
        return [b.inner_text() for b in self.dialog.locator("[data-action]").all() if b.is_visible()]

    def act(self, name, reason="합성 변경 사유"):
        commands = len(self.commands)
        self.dialog.locator('input[name="reason"]').fill(reason)
        self.button(name).click()
        self.wait_until(lambda: len(self.commands) == commands + 1, f"the {name} command")
        expect(self.dialog.locator("[data-status]")).not_to_have_text("Saving")
        return self.commands[-1][1]

    # ── cases ──
    def test_01_only_own_institution_clinical_members_offer_signing_key(self):
        self.load()
        offered = {u["username"]: self.row(u["username"]).get_by_role("button", name="Signing Key", exact=True).count()
                   for u in self.users}
        self.assertEqual({"syn-radiologist": 1, "syn-clinician": 1, "syn-suspended-tech": 1,
                          "syn-admin-only": 0, "syn-other-rad": 0, "syn-pending": 0}, offered)

    def test_02_create_rotate_retire_send_exact_commands_and_show_the_server_answer(self):
        self.load()
        self.open_keys("syn-radiologist")
        self.assertEqual(["SYN-U-RAD"], self.reads)
        expect(self.dialog.locator("[data-status]")).to_contain_text("No Active Key")
        self.assertEqual(["Create Key"], self.visible_actions())
        # The reason is required: nothing is sent without one.
        self.button("Create Key").click()
        self.page.wait_for_timeout(100)
        self.assertEqual([], self.commands)
        self.assertEqual({"action": "provision", "expectedKid": None, "reason": "신규 판독의 서명키"},
                         self.act("Create Key", "신규 판독의 서명키"))
        first = self.keys["SYN-U-RAD"][0]["kid"]
        expect(self.dialog.locator("[data-status]")).to_contain_text("Active Key · " + first)
        self.assertEqual(["Rotate Key", "Retire Key"], self.visible_actions())
        self.assertEqual("", self.dialog.locator('input[name="reason"]').input_value())
        self.assertEqual({"action": "replace", "expectedKid": first, "reason": "정기 교체"}, self.act("Rotate Key", "정기 교체"))
        second = self.keys["SYN-U-RAD"][0]["kid"]
        expect(self.dialog.locator("tbody tr")).to_have_count(2)
        expect(self.dialog.locator("tbody tr").nth(1)).to_contain_text("Retired")
        # Retire asks first; a declined confirmation sends nothing.
        self.page.once("dialog", lambda d: d.dismiss())
        self.dialog.locator('input[name="reason"]').fill("퇴직")
        self.button("Retire Key").click()
        self.page.wait_for_timeout(100)
        self.assertEqual(2, len(self.commands))
        self.page.once("dialog", lambda d: d.accept())
        self.assertEqual({"action": "revoke", "expectedKid": second, "reason": "퇴직"}, self.act("Retire Key", "퇴직"))
        expect(self.dialog.locator("[data-status]")).to_contain_text("No Active Key")
        self.assertEqual(["Create Key"], self.visible_actions())
        self.button("Close").click()
        expect(self.dialog).to_have_count(0)

    def test_03_a_lost_answer_is_not_drawn_and_reload_shows_what_the_server_holds(self):
        self.load()
        self.open_keys("syn-clinician")
        self.post_reply = ("abort",)
        self.act("Create Key")
        expect(self.dialog.locator("[data-status]")).to_contain_text("Reload")
        expect(self.dialog.locator("tbody tr")).to_have_count(0)
        for button in self.dialog.locator("[data-action]").all():
            self.assertTrue(button.is_hidden() or button.is_disabled())
        self.post_reply = None
        reads = len(self.reads)
        self.button("Reload").click()
        self.wait_until(lambda: len(self.reads) == reads + 1, "the Reload read")
        expect(self.dialog.locator("[data-status]")).to_contain_text("Active Key · " + self.keys["SYN-U-CLIN"][0]["kid"])
        self.assertEqual(["Rotate Key", "Retire Key"], self.visible_actions())

    def test_04_a_conflict_or_refusal_asks_for_reload_before_another_change(self):
        self.load()
        self.open_keys("syn-radiologist")
        self.post_reply = (409, {"code": "KeyManagementConflict", "message": "서명키 상태가 바뀌었습니다. 다시 불러온 뒤 확인하세요."})
        self.act("Create Key")
        expect(self.dialog.locator("[data-status]")).to_contain_text("서명키 상태가 바뀌었습니다")
        self.assertEqual([], self.visible_actions())
        self.post_reply = (403, {"message": "현재 소속 기관의 임상 기록 권한을 확인할 수 없습니다."})
        reads = len(self.reads)
        self.button("Reload").click()
        self.wait_until(lambda: len(self.reads) == reads + 1, "the Reload read")
        self.act("Create Key")
        expect(self.dialog.locator("[data-status]")).to_contain_text("임상 기록 권한")
        self.assertEqual([], self.visible_actions())
        self.assertEqual({}, {uid: keys for uid, keys in self.keys.items() if keys})


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main()
