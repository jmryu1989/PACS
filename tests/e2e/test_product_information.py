# coding: utf-8
"""CD-01 Product Information on the served stack: three entries, the build facts, offline, notices, login footer.

REQ-CD01-PRODUCT-INFO -> RISK-CD01-FABRICATED-VALUE / RISK-CD01-MIXED-BUILD / RISK-CD01-OFFLINE -> TEST-CD01-E2E.
One user flow on the real proxy, API, Keycloak and the shipped pages (synthetic identities and one owned fixture):

  1. C06 GET /api/version without a session answers 200 with the build facts only, the facts digest the pages embed,
     and a revision that is null or this checkout's (KIN_EXPECTED_REVISION when given); a protected read still 401s.
  2. C01/C05 main.html: the build commit stamped on the served page is the API's; a reader with a draft in the report
     editor opens Product Information from the menu bar; the server check reads Match; closing returns focus, keeps
     the draft and sent no write.
  3. C07 admin.html, ready and never opened: the network is cut; the first open and a reopen show the embedded facts
     and Unverified.
  4. C01/C11 Clinician Home: the panel's Open Source Notices opens CD-02's generated file in a new tab, the home page
     stays signed in where it was.
  5. C11 the real Keycloak login page (the worklist's automatic entry lands there) shows the four notices, and each
     opens without a login loop.
Run only through scripts/run-tests.py on an isolated synthetic stack.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import ssl
import unittest
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from playwright.sync_api import expect

from test_worklist import WorklistE2E

ROOT = Path(__file__).resolve().parents[2]
FACTS = json.loads((ROOT / "api/src/product-info-data.ts").read_text(encoding="utf-8")
                   .split("=", 1)[1].rsplit(" as const;", 1)[0])
NOTICES = json.loads((ROOT / "config/product-info.json").read_text(encoding="utf-8"))["notices"]
WRITES = {"POST", "PUT", "PATCH", "DELETE"}
READS_BY_POST = {("POST", "/api/dicom/lookup")}


class ProductInformationE2E(WorklistE2E):
    def unauthenticated(self, path):
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        try:
            with urlopen(Request(self.stack.proxy + path, headers={"Accept": "application/json"}), context=context,
                         timeout=30) as response:
                return response.status, dict(response.headers), json.loads(response.read() or b"null")
        except HTTPError as error:
            return error.code, dict(error.headers), None

    def panel(self, page):
        dialog = page.get_by_role("dialog", name="Product Information")
        expect(dialog).to_be_visible()
        return dialog

    def check(self, dialog, label):
        expect(dialog.get_by_role("row").filter(has_text="Build Check")).to_contain_text(label)

    def clinician_login(self, actor):
        context = self.browser.new_context(ignore_https_errors=True, viewport={"width": 1600, "height": 1050})
        self.contexts.append(context)
        page = context.new_page()
        page.goto(self.stack.proxy + "/")
        try:
            page.locator("#username").fill(self.stack.username(actor))
            page.locator("#password").fill(self.stack.passwords[actor])
            page.locator("#kc-login").click()
        except Exception:
            raise RuntimeError("Real BFF clinician login could not be submitted") from None
        page.wait_for_url("**/worklist/hpacs-lite/clinician.html", timeout=30000)
        expect(page.locator("#actor")).to_contain_text(actor)
        return page

    def test_product_information_01_entries_version_offline_and_notices(self):
        # 1. The public build facts, and only those.
        status, headers, body = self.unauthenticated("/api/version")
        self.assertEqual(200, status)
        self.assertIn("no-store", headers.get("Cache-Control", ""))
        self.assertEqual({"schema", "factsDigest", "productVersion", "build"}, set(body))
        self.assertEqual({"revision", "tag"}, set(body["build"]))
        self.assertEqual((FACTS["factsDigest"], FACTS["productVersion"]), (body["factsDigest"], body["productVersion"]))
        expected = os.environ.get("KIN_EXPECTED_REVISION")
        if expected and re.fullmatch(r"[0-9a-f]{40}", expected):
            self.assertEqual(expected, body["build"]["revision"])
        else:
            self.assertTrue(body["build"]["revision"] is None or re.fullmatch(r"[0-9a-f]{40}", body["build"]["revision"]))
        self.assertEqual(401, self.unauthenticated("/api/studies")[0], "a protected read stays protected")

        # 2. main.html over a draft.
        fixture = self.fixture()
        page = self.login("doctor")
        self.select(page, fixture)
        draft = "CD-01 product information must not touch this draft"
        page.locator("#findings").fill(draft)
        versions = self.versions(fixture)
        rs = self.state(fixture).get("rs")
        requests = []
        page.on("request", lambda request: requests.append((request.method, urlsplit(request.url).path)))
        # C05: the commit the proxy stamped on the served page is the API's (both null on a stack built without one).
        stamped = page.evaluate("() => { const m = document.querySelector('meta[name=\"kin-build-revision\"]');"
                                " return m ? m.getAttribute('content') : null; }")
        self.assertEqual(body["build"]["revision"], stamped)
        entry = page.locator(".menubar").get_by_role("button", name="Product Information")
        expect(entry).to_have_count(1)
        entry.click()
        dialog = self.panel(page)
        self.check(dialog, "Match")
        expect(dialog.get_by_role("row").filter(has_text="Authorization Number")).to_contain_text("발급 전")
        page.keyboard.press("Escape")
        expect(dialog).to_have_count(0)
        self.assertEqual("m-product-info", page.evaluate("() => document.activeElement.id"))
        self.assertEqual(draft, page.locator("#findings").input_value())
        # The page keeps loading the selected study's thumbnails meanwhile; POST dicom/lookup is that loader's UID
        # lookup (a read the route matrix allows clinicians too), not a write. Every other non-GET would be one.
        self.assertEqual([], [r for r in requests if r[0] in WRITES and r not in READS_BY_POST],
                         "opening the panel writes nothing")
        self.assertIn(("GET", "/api/version"), requests)
        self.assertEqual((versions, rs), (self.versions(fixture), self.state(fixture).get("rs")),
                         "the study's report versions and state are as before")

        # 3. admin.html: ready, never opened, then offline.
        admin = self.login("jmryu")
        admin.goto(self.stack.proxy + "/worklist/hpacs-lite/admin.html")
        expect(admin.locator("#users td.username").first).to_be_visible()
        admin.context.set_offline(True)
        try:
            for attempt in ("first", "again"):
                with self.subTest(offline=attempt):
                    admin.locator("header").get_by_role("button", name="Product Information").click()
                    dialog = self.panel(admin)
                    self.check(dialog, "Unverified")
                    expect(dialog.get_by_role("row").filter(has_text="Serial Number")).to_contain_text("제조번호 확정 전")
                    dialog.get_by_role("button", name="Close").click()
                    expect(dialog).to_have_count(0)
        finally:
            admin.context.set_offline(False)

        # 4. Clinician Home: the notice opens in its own tab.
        actor = "cd01-clinician"
        self.stack.create_test_identity(actor, ["clinician"], "hallym")
        home = self.clinician_login(actor)
        home.get_by_role("button", name="Product Information").click()
        dialog = self.panel(home)
        self.check(dialog, "Match")
        with home.context.expect_page() as opened:
            dialog.get_by_role("link", name="Open Source Notices", exact=True).click()
        notice = opened.value
        notice.wait_for_load_state("domcontentloaded")
        self.assertEqual(self.stack.proxy + "/worklist/legal/open-source-notices.html", notice.url)
        expect(notice.locator("h1")).to_have_text("Open Source Notices")
        notice.close()
        home.keyboard.press("Escape")
        expect(home.locator("#actor")).to_contain_text(actor)
        self.assertTrue(home.url.endswith("/worklist/hpacs-lite/clinician.html"))

        # 5. The real login page.
        context = self.browser.new_context(ignore_https_errors=True, viewport={"width": 1280, "height": 900})
        self.contexts.append(context)
        login = context.new_page()
        login.goto(self.stack.proxy + "/")
        expect(login.locator("#username")).to_be_visible(timeout=30000)
        footer = login.get_by_role("navigation", name="Notices")
        expect(footer.get_by_role("link")).to_have_count(len(NOTICES))
        for notice in NOTICES:
            with self.subTest(notice=notice["id"]):
                link = footer.get_by_role("link", name=notice["label"], exact=True)
                self.assertEqual(notice["href"], link.get_attribute("href"))
                answer = context.request.get(self.stack.proxy + notice["href"], max_redirects=0)
                self.assertEqual(200, answer.status, notice["href"])
        with context.expect_page() as opened:
            footer.get_by_role("link", name="Privacy Policy", exact=True).click()
        privacy = opened.value
        privacy.wait_for_load_state("domcontentloaded")
        self.assertEqual(self.stack.proxy + "/worklist/legal/privacy.html", privacy.url)
        privacy.close()
        expect(login.locator("#username")).to_be_visible()


if __name__ == "__main__":
    unittest.main(verbosity=2)
