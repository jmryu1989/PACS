# coding: utf-8
"""CD-01 Product Information panel (worklist-v0/hpacs-lite/product-info.js) in an isolated synthetic page.

REQ-CD01-PRODUCT-INFO -> RISK-CD01-FABRICATED-VALUE / RISK-CD01-OFFLINE -> TEST-CD01-DOM.
The shipped product-info.js and product-info-data.js (or data built by scripts/build-product-info.py from a synthetic
config) are loaded unchanged into a host page beside a draft field; GET /api/version is answered per case; the
legal documents are the shipped files. Each case: input -> the branch observed on the page -> the result asserted.

  01  C02/C09/C10/C12 the shipped facts: every section and statutory item, the placeholders' Korean reasons,
      separate end-of-support schedule and after-support plan, AI training method and data, no expert-use item;
      headers and states English, explanations Korean.
  02  C06/C07 the server's build commit: shown as the server gave it; a server built without one, an error, a
      malformed answer and a network failure read unknown; a late answer for a closed panel is not painted on the
      reopened one.
  03  C07 after the page is ready and the network is cut, the first open and a reopen show the embedded facts and
      an unknown server build, without any request succeeding.
  04  C03 a hostile config value is shown as text and runs nothing; a confirmed synthetic value replaces its
      placeholder and nothing else.
  05  C04 a pending document links nowhere; a confirmed synthetic one links to its shipped file, which opens.
  06  C11 the four notice links are the config's, same origin, open in a new tab and leave the page as it was;
      the Keycloak theme script appends the same four links to a login page.
  07  C01 keyboard: Enter on the trigger opens with focus on Close, Escape closes and returns focus; the draft is
      unchanged, nothing is written and no browser dialog appears.
  09  C01/C07 closing and reopening inside one task (button and Escape's cancel), and Escape then Enter from the
      keyboard: the closed panel's late close event leaves the reopened panel open.

Synthetic data only; no server, no credentials.
"""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
SPEC = importlib.util.spec_from_file_location("build_product_info", ROOT / "scripts" / "build-product-info.py")
product = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(product)
CONFIG = json.loads((ROOT / "config" / "product-info.json").read_text(encoding="utf-8"))


def built(config, root=ROOT):
    """The generator's model and page data for a config (documents resolved under root)."""
    model, files = product.outputs(root, json.dumps(config, ensure_ascii=False).encode("utf-8"))
    return model, files[product.PAGE_DATA]


MODEL, DATA = built(CONFIG)
ORIGIN = "https://product.test"
BASE = "/worklist/hpacs-lite/"
HOST = """<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>SYN host</title></head><body>
<button type="button" id="before">SYN Before</button>
<button type="button" id="trigger" data-product-info>Product Information</button>
<textarea id="draft">SYN draft</textarea>
<script src="product-info-data.js"></script><script src="product-info.js"></script></body></html>"""
LOGIN = """<!doctype html><html><head><meta charset="utf-8"><title>SYN login</title></head><body class="login-pf">
<div class="login-pf-page"><form id="kc-form-login"><input id="username"></form></div>
<script src="/auth/resources/legal-links.js"></script></body></html>"""
HANGUL = re.compile(r"[가-힣]")
SHA = "0123456789abcdef0123456789abcdef01234567"
# The panel as a reader sees it: each section's heading and its rows (item, status, detail).
READ_PANEL = """() => { const dialog = document.querySelector('dialog[open]'); if (!dialog) return null;
  const sections = [...dialog.querySelectorAll('section')].map(section => ({
    heading: section.querySelector('h3').textContent,
    head: [...section.querySelectorAll('th')].map(th => th.textContent),
    rows: [...section.querySelectorAll('tbody tr')].map(tr => [...tr.cells].map(td => td.textContent)),
    links: [...section.querySelectorAll('a')].map(a => ({text: a.textContent, href: a.getAttribute('href'),
      target: a.target, rel: a.rel}))}));
  return {title: dialog.querySelector('h2').textContent, sections, text: dialog.textContent,
    modal: dialog.matches(':modal')}; }"""


def version_answer(revision=SHA):
    return {"schema": 1, "build": {"revision": revision}}


class ProductInfoDomTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.data = DATA
        self.version = ("json", version_answer())
        self.held = []
        self.requests, self.unexpected, self.errors, self.dialogs = [], [], [], []
        self.extra_files = {}
        self.context = self.browser.new_context(viewport={"width": 1280, "height": 900})
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", lambda dialog: (self.dialogs.append(dialog.message), dialog.dismiss()))
        self.page.on("request", lambda request: self.requests.append((request.method, urlparse(request.url).path)))

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.unexpected, "requests the harness does not answer")
        self.assertEqual([], self.dialogs, "browser dialogs")

    def route(self, route):
        url = urlparse(route.request.url)
        path = url.path
        if f"{url.scheme}://{url.netloc}" != ORIGIN:
            self.unexpected.append(route.request.url)
            return route.abort()
        if path == BASE + "host.html":
            return route.fulfill(body=HOST, content_type="text/html; charset=utf-8")
        if path == "/auth/login.html":
            return route.fulfill(body=LOGIN, content_type="text/html; charset=utf-8")
        if path == "/auth/resources/legal-links.js":
            return route.fulfill(path=str(ROOT / "keycloak/themes/kin-login/login/resources/js/legal-links.js"),
                                 content_type="application/javascript; charset=utf-8")
        if path == BASE + "product-info-data.js":
            return route.fulfill(body=self.data, content_type="application/javascript; charset=utf-8")
        if path == BASE + "product-info.js":
            return route.fulfill(path=str(HPACS / "product-info.js"), content_type="application/javascript; charset=utf-8")
        if path == "/api/version" and route.request.method == "GET":
            kind, body = self.version
            if kind == "held":
                self.held.append(route)
                return None
            if kind == "abort":
                return route.abort("failed")
            if kind == "status":
                return route.fulfill(status=body, json={"message": "SYN"})
            return route.fulfill(json=body, headers={"Cache-Control": "no-store"})
        if path in self.extra_files:
            return route.fulfill(body=self.extra_files[path], content_type="text/html; charset=utf-8")
        if path.startswith("/worklist/legal/"):
            local = ROOT / "worklist-v0" / path[len("/worklist/"):]
            if local.is_file():
                kind = "text/css" if local.suffix == ".css" else "application/javascript" if local.suffix == ".js" else "text/html"
                return route.fulfill(path=str(local), content_type=kind + "; charset=utf-8")
        if path.startswith("/kin-brand/"):
            return route.fulfill(status=404, body="")
        self.unexpected.append(f"{route.request.method} {path}")
        return route.abort()

    # ── helpers ──
    def open_host(self):
        self.page.goto(ORIGIN + BASE + "host.html")
        expect(self.page.locator("#trigger")).to_be_visible()

    def open_panel(self):
        self.page.locator("#trigger").click()
        dialog = self.page.get_by_role("dialog", name="Product Information")
        expect(dialog).to_be_visible()
        return dialog

    def wait_build(self, label):
        expect(self.page.get_by_role("dialog").get_by_role("row").filter(has_text="Server Build")).to_contain_text(label)
        return self.panel()

    def panel(self):
        return self.page.evaluate(READ_PANEL)

    def rows(self, panel):
        return {row[0]: row for section in panel["sections"] for row in section["rows"]}

    def close(self):
        self.page.keyboard.press("Escape")
        expect(self.page.get_by_role("dialog")).to_have_count(0)

    # ── cases ──
    def test_01_shipped_facts_every_item_in_its_state(self):
        self.open_host()
        self.open_panel()
        panel = self.wait_build("Confirmed")
        self.assertTrue(panel["modal"])
        self.assertEqual(["Manufacturer", "Product", "Version", "UDI", "Documents", "Support", "AI Information", "Notices"],
                         [section["heading"] for section in panel["sections"]])
        rows = self.rows(panel)
        expected = {"Manufacturer Name": "Pending", "Manufacturer Address": "Confirmed", "Importer": "Not Applicable",
                    "Software Designation": "Confirmed", "Authorization Number": "Unissued", "Product Name": "Confirmed",
                    "Model Name": "Pending", "Serial Number": "Pending", "Manufacturing Date": "Pending",
                    "Product Version": "Pending", "Server Build": "Confirmed",
                    "UDI-DI": "Unissued", "UDI-PI (Software Version)": "Unissued",
                    "Product Description": "Pending", "Instructions for Use": "Pending",
                    "Error Reporting Contact": "Pending", "Maintenance Contractor": "Undetermined",
                    "Expected End of Support": "Pending", "Support Plan After End of Support": "Pending",
                    "Speech Recognition Engine": "Confirmed", "Speech Recognition Model": "Confirmed",
                    "Training Method and Data": "Pending", "Expected Performance and Limits": "Pending",
                    "Third-Party Cloud Service": "Undetermined", "Changes Under the Change Plan": "Undetermined",
                    "AI Use Notice": "Pending"}
        self.assertEqual(expected, {label: row[1] for label, row in rows.items()})
        for label, phrase in (("Authorization Number", "발급 전"), ("UDI-DI", "발급 전"), ("UDI-PI (Software Version)", "발급 전"),
                              ("Serial Number", "제조번호 확정 전"), ("Manufacturing Date", "제조 연월 확정 전"),
                              ("Expected End of Support", "일정 미확정"), ("Support Plan After End of Support", "지원계획 미확정"),
                              ("Training Method and Data", "확정 전"), ("AI Use Notice", "고지 문구 확정 전"),
                              ("Instructions for Use", "문서 확정 전"), ("Product Description", "문서 확정 전")):
            with self.subTest(item=label):
                self.assertTrue(rows[label][2].startswith(phrase), rows[label][2])
        self.assertIn("디지털의료기기소프트웨어", rows["Software Designation"][2])
        # The server's commit is shown whole, as the server gave it.
        self.assertTrue(rows["Server Build"][2].startswith(SHA), rows["Server Build"][2])
        # No expert-use item, badge or placeholder anywhere (D-14).
        self.assertNotIn("전문가용", panel["text"])
        self.assertNotRegex(panel["text"], r"(?i)expert")
        for section in panel["sections"][:-1]:
            self.assertEqual(["Item", "Status", "Detail", "Basis"], section["head"])
            for row in section["rows"]:
                self.assertFalse(HANGUL.search(row[0]) or HANGUL.search(row[1]), row[:2])
                self.assertTrue(HANGUL.search(row[2]), row)
        self.assertEqual([("GET", "/api/version")], [r for r in self.requests if r[1].startswith("/api/")])

    def test_02_server_build_commit_as_given_or_unknown(self):
        self.open_host()
        other = "fedcba9876543210fedcba9876543210fedcba98"
        # Whatever commit the server reports is shown; nothing is compared with the page.
        self.version = ("json", version_answer(other))
        self.open_panel()
        rows = self.rows(self.wait_build("Confirmed"))
        self.assertTrue(rows["Server Build"][2].startswith(other), rows["Server Build"][2])
        self.close()
        cases = [
            ("no-commit", ("json", version_answer(None)), "빌드 식별 없음"),
            ("error", ("status", 503), "확인하지 못했습니다"),
            ("malformed", ("json", {"schema": 1, "build": "SYN"}), "확인하지 못했습니다"),
            ("short", ("json", version_answer(SHA[:12])), "확인하지 못했습니다"),
            ("network", ("abort", None), "확인하지 못했습니다"),
        ]
        for name, answer, reason in cases:
            with self.subTest(case=name):
                self.version = answer
                self.open_panel()
                detail = self.rows(self.wait_build("Unknown"))["Server Build"][2]
                self.assertTrue(detail.startswith("unknown"), detail)
                self.assertIn(reason, detail)
                self.close()
        # A -> closed -> B: the first panel's late answer never reaches the reopened panel.
        self.version = ("held", None)
        self.open_panel()
        self.close()
        self.open_panel()
        self.wait_build("Checking")
        self.assertEqual(2, len(self.held))
        first, second = self.held
        first.fulfill(json=version_answer(other))
        self.page.wait_for_timeout(200)
        self.wait_build("Checking")
        second.fulfill(json=version_answer())
        rows = self.rows(self.wait_build("Confirmed"))
        self.assertTrue(rows["Server Build"][2].startswith(SHA), rows["Server Build"][2])
        self.close()

    def test_03_offline_first_open_and_reopen(self):
        self.open_host()
        self.page.wait_for_load_state("load")
        before = len(self.requests)
        # The network is gone: the browser is offline and anything that still reaches the origin fails, so no answer
        # (not even a stale one routed by this harness) can make the panel look verified.
        self.context.set_offline(True)
        self.version = ("abort", None)
        failed = []
        self.page.on("requestfailed", lambda request: failed.append(urlparse(request.url).path))
        for attempt in ("first", "again"):
            with self.subTest(open=attempt):
                self.open_panel()
                rows = self.rows(self.wait_build("Unknown"))
                self.assertEqual("Unissued", rows["Authorization Number"][1])
                self.assertTrue(rows["Serial Number"][2].startswith("제조번호 확정 전"))
                self.assertTrue(rows["Server Build"][2].startswith("unknown"), rows["Server Build"][2])
                self.close()
        # The only thing the panel asked for was the server check, and each attempt failed.
        self.assertEqual([], [r for r in self.requests[before:] if r[1] != "/api/version"])
        self.assertEqual(["/api/version", "/api/version"], failed)
        self.assertEqual(self.page.locator("#draft").input_value(), "SYN draft")

    def test_04_hostile_text_is_text_and_a_confirmed_value_replaces_its_placeholder(self):
        hostile = '<img src=x onerror="document.body.dataset.pwned=1">SYN & "상호"'
        config = copy.deepcopy(CONFIG)
        config["manufacturer"]["name"] = {"status": "confirmed", "value": hostile, "note": "SYN 상호입니다. <b>bold</b>"}
        _, self.data = built(config)
        self.version = ("json", version_answer())
        self.open_host()
        self.open_panel()
        rows = self.rows(self.wait_build("Confirmed"))
        self.assertEqual(("Confirmed", hostile + "SYN 상호입니다. <b>bold</b>"), tuple(rows["Manufacturer Name"][1:3]))
        self.assertEqual(0, self.page.locator("dialog img, dialog b").count())
        self.assertIsNone(self.page.evaluate("() => document.body.dataset.pwned || null"))
        # Only that item changed: every other row is the shipped one.
        shipped = {row["label"]: row["statusLabel"] for row in MODEL["rows"]}
        shipped["Manufacturer Name"] = "Confirmed"
        self.assertEqual(shipped, {label: rows[label][1] for label in shipped})

    def test_05_documents_link_only_when_confirmed(self):
        self.open_host()
        panel = self.open_panel() and self.wait_build("Confirmed")
        documents = next(s for s in panel["sections"] if s["heading"] == "Documents")
        self.assertEqual([], documents["links"], "a pending document links nowhere")
        self.close()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for notice in product.NOTICE_FILES.values():
                (root / notice).parent.mkdir(parents=True, exist_ok=True)
                (root / notice).write_text("<title>SYN</title>", encoding="utf-8")
            (root / "worklist-v0/docs").mkdir(parents=True)
            (root / "worklist-v0/docs/syn-ifu.html").write_text("x", encoding="utf-8")
            config = copy.deepcopy(CONFIG)
            config["version"]["product"] = {"status": "confirmed", "value": "1.0.0-syn", "note": "SYN 출시 버전입니다."}
            config["documents"]["instructions"] = {"status": "confirmed", "value": "SYN 사용자 취급설명서", "documentVersion": "IFU-SYN-1",
                                                   "href": "/worklist/docs/syn-ifu.html", "productVersion": "1.0.0-syn",
                                                   "note": "SYN 승인 본문입니다."}
            _, self.data = built(config, root)
        self.extra_files["/worklist/docs/syn-ifu.html"] = "<!doctype html><title>SYN IFU 1.0.0-syn</title><h1>SYN IFU</h1>"
        self.version = ("json", version_answer())
        self.page.reload()
        self.open_panel()
        panel = self.wait_build("Confirmed")
        documents = next(s for s in panel["sections"] if s["heading"] == "Documents")
        self.assertEqual([{"text": "Open Document", "href": "/worklist/docs/syn-ifu.html", "target": "_blank", "rel": "noopener"}],
                         documents["links"])
        rows = self.rows(panel)
        self.assertIn("Document Version: IFU-SYN-1", rows["Instructions for Use"][2])
        self.assertEqual("Pending", rows["Product Description"][1])
        with self.context.expect_page() as opened:
            self.page.get_by_role("link", name="Open Document").click()
        expect(opened.value).to_have_title("SYN IFU 1.0.0-syn")
        opened.value.close()

    def test_06_notices_same_origin_new_tab_and_login_theme(self):
        self.open_host()
        self.page.locator("#draft").fill("SYN draft kept")
        panel = self.open_panel() and self.wait_build("Confirmed")
        notices = next(s for s in panel["sections"] if s["heading"] == "Notices")
        self.assertEqual([(n["label"], n["href"]) for n in MODEL["notices"]],
                         [(link["text"], link["href"]) for link in notices["links"]])
        titles = {"privacy": "KIN 개인정보 처리방침", "operator": "사업자·운영자 고지",
                  "open-source": "Open Source Notices", "accessibility": "접근성 안내"}
        for notice in MODEL["notices"]:
            with self.subTest(notice=notice["id"]):
                link = self.page.get_by_role("dialog").get_by_role("link", name=notice["label"], exact=True)
                self.assertEqual(("_blank", "noopener"), (link.get_attribute("target"), link.get_attribute("rel")))
                with self.context.expect_page() as opened:
                    link.click()
                tab = opened.value
                tab.wait_for_load_state("domcontentloaded")
                self.assertEqual(ORIGIN + notice["href"], tab.url)
                expect(tab.locator("h1")).to_have_text(titles[notice["id"]])
                tab.close()
        # The open-source notice is CD-02's generated file, its incomplete state shown as generated.
        generated = (ROOT / "worklist-v0/legal/licenses/components.json")
        if not json.loads(generated.read_text(encoding="utf-8"))["complete"]:
            self.assertIn("완료로 판정하지 않습니다", (ROOT / "worklist-v0/legal/open-source-notices.html").read_text(encoding="utf-8"))
        self.close()
        self.assertEqual("SYN draft kept", self.page.locator("#draft").input_value())
        # The login theme appends the same four links once.
        login = self.context.new_page()
        login.goto(ORIGIN + "/auth/login.html")
        footer = login.get_by_role("navigation", name="Notices")
        expect(footer.get_by_role("link")).to_have_count(4)
        self.assertEqual([[n["label"], n["href"], "_blank"] for n in MODEL["notices"]],
                         login.evaluate("""() => [...document.querySelectorAll('nav[aria-label=Notices] a')]
                           .map(a => [a.textContent, a.getAttribute('href'), a.target])"""))
        self.assertEqual(1, login.locator("#kc-form-login").count())
        login.close()

    def test_07_keyboard_focus_and_no_side_effects(self):
        self.open_host()
        self.page.locator("#draft").fill("SYN draft before")
        self.page.locator("#before").focus()
        self.page.keyboard.press("Tab")
        self.assertEqual("trigger", self.page.evaluate("() => document.activeElement.id"))
        self.page.keyboard.press("Enter")
        expect(self.page.get_by_role("dialog", name="Product Information")).to_be_visible()
        self.assertEqual("Close", self.page.evaluate("() => document.activeElement.textContent"))
        self.wait_build("Confirmed")
        self.close()
        self.assertEqual("trigger", self.page.evaluate("() => document.activeElement.id"))
        # Opening twice from the keyboard and closing with the button.
        self.page.keyboard.press(" ")
        self.page.get_by_role("button", name="Close").click()
        expect(self.page.get_by_role("dialog")).to_have_count(0)
        self.assertEqual("SYN draft before", self.page.locator("#draft").input_value())
        # Closed, the page has no extra table, heading or button: the panel exists only while open.
        self.assertEqual([0, 0, 2], self.page.evaluate("""() => [document.querySelectorAll('table').length,
          document.querySelectorAll('h2, h3').length, document.querySelectorAll('button').length]"""))
        self.assertEqual({("GET", "/api/version")}, {r for r in self.requests if r[1].startswith("/api/")})

    def test_09_a_late_close_event_leaves_the_reopened_panel_open(self):
        self.open_host()
        dialog = self.page.get_by_role("dialog", name="Product Information")
        for how in ("button", "cancel"):
            with self.subTest(close=how):
                self.open_panel()
                self.wait_build("Confirmed")
                # Close and reopen in one task: the closed dialog's native close event is still queued when the
                # new panel opens, and it fires afterwards.
                self.page.evaluate("""how => { const old = document.querySelector('dialog[open]');
                  if (how === 'button') old.querySelector('#product-info-close').click();
                  else old.dispatchEvent(new Event('cancel', {cancelable: true}));
                  document.querySelector('#trigger').click(); }""", how)
                self.page.evaluate("() => new Promise(resolve => setTimeout(resolve, 100))")
                expect(dialog).to_have_count(1)
                expect(dialog).to_be_visible()
                self.assertTrue(self.page.evaluate("() => window.KinProductInfo.isOpen()"))
                self.close()
        # The keyboard sequence the Clinician Home regression used: Escape, then Enter on the trigger.
        self.page.locator("#trigger").focus()
        self.page.keyboard.press("Enter")
        expect(dialog).to_be_visible()
        self.page.keyboard.press("Escape")
        self.page.keyboard.press("Enter")
        self.page.evaluate("() => new Promise(resolve => setTimeout(resolve, 100))")
        expect(dialog).to_have_count(1)
        expect(dialog).to_be_visible()
        self.close()
        self.assertEqual("SYN draft", self.page.locator("#draft").input_value())


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
