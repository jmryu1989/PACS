"""U5S-REQ-06/09/11/13/17 -> U5S-RISK-SESSION/DRAFT/APPLY -> S01/S02/S04/S08/S09/S11.

Real main document, BFF, Keycloak and database. UI actions drive editing/logout;
response interception delays delivery or injects a request failure, never a fake success.
The viewer case opens the real viewer window from the list and holds it through a cancelled logout preparation.
"""
import json
from pathlib import Path
import sys
import unittest

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "live"))
import test_worklist as worklist
from session_support import Session, setup_stack


class SessionDraftBoundaries(worklist.WorklistE2E):
    @classmethod
    def setUpClass(cls):
        setup_stack(cls)
        worklist.require_local_targets(cls.stack)
        cls.pw = sync_playwright().start()
        cls.addClassCleanup(cls.pw.stop)
        cls.browser = cls.pw.chromium.launch()
        cls.addClassCleanup(cls.browser.close)

    def profile(self, session=None):
        context = self.browser.new_context(ignore_https_errors=True, viewport={"width": 1600, "height": 1050})
        self.contexts.append(context)
        if session:
            context.add_cookies([{"name": "kin_sid", "value": session.sid(), "url": self.stack.proxy,
                                  "httpOnly": True, "secure": True, "sameSite": "Strict"}])
        return context

    def open_main(self, context, fragment=""):
        page = context.new_page()
        page.set_default_timeout(15000)
        page.goto(self.stack.proxy + "/worklist/hpacs-lite/main.html" + fragment)
        expect(page.locator("#dbstat"), "U5_ENTRY_ACTIVE").to_contain_text("DB Connected")
        return page

    def test_entry_valid_session_and_second_tab_require_no_click(self):
        session = Session(self.stack).login(self)
        context = self.profile(session)
        dialogs = []
        context.on("page", lambda p: p.on("dialog", lambda d: (dialogs.append(d.type), d.dismiss())))
        first = self.open_main(context)
        second = self.open_main(context)
        for page in (first, second):
            expect(page.locator("#logout")).to_be_visible()
            expect(page.locator("dialog[open]")).to_have_count(0)
        self.assertEqual(dialogs, [])
        self.assertEqual(session.json("GET", "/api/me")[0], 200)

    def test_no_session_starts_real_idp_login_automatically(self):
        page = self.profile().new_page()
        page.goto(self.stack.proxy + "/worklist/hpacs-lite/main.html")
        expect(page.locator("#username"), "U5_AUTO_LOGIN").to_be_visible(timeout=20000)
        expect(page.locator("#password")).to_be_visible()
        self.assertIn("/auth/realms/kin/", page.url)

    def test_entry_proof_consumed_automatically_once(self):
        session = Session(self.stack).login(self)
        context = self.profile(session)
        responses = []
        context.on("response", lambda r: responses.append(r.status) if r.url.endswith("/api/auth/entry") else None)
        page = self.open_main(context, "#kin-entry=" + session.proof)
        self.assertNotIn("kin-entry", page.url)
        self.assertEqual(responses, [200], "U5_ENTRY_PROOF")
        replay = context.request.post(self.stack.api + "/auth/entry", data={"proof": session.proof},
                                      headers={"X-KIN-CSRF": "1"})
        self.assertEqual(replay.status, 403)
        self.assertEqual(replay.json()["code"], "AUTH_ENTRY_REFUSED")

    def test_open_edit_autosave_reload_restores_draft(self):
        fixture = self.fixture()
        session = Session(self.stack).login(self)
        page = self.open_main(self.profile(session))
        self.select(page, fixture)
        with page.expect_response(lambda r: r.request.method == "PUT" and r.url.endswith(f"/{fixture.uid}/report"),
                                  timeout=35000) as saved:
            page.locator("#findings").fill("Synthetic draft survives reload")
        self.assertEqual(saved.value.status, 200)
        self.assertEqual(saved.value.json()["snapshot"]["findings"], "Synthetic draft survives reload")
        page.reload()
        expect(page.locator("#dbstat")).to_contain_text("DB Connected")
        self.select(page, fixture)
        expect(page.locator("#findings")).to_have_value("Synthetic draft survives reload")

    def test_one_click_logout_saves_draft_and_ends_the_second_tab(self):
        fixture = self.fixture()
        session = Session(self.stack).login(self)
        context = self.profile(session)
        first, second = self.open_main(context), self.open_main(context)
        self.select(first, fixture)
        pending = []
        def hold_saved_answer(route):
            if route.request.method == "PUT":
                answer = route.fetch()
                self.assertEqual(answer.status, 200)
                pending.append((route, answer))
            else:
                route.continue_()
        first.route("**/api/studies/*/report", hold_saved_answer)
        first.locator("#findings").fill("Synthetic draft saved by logout")
        for _ in range(140):
            first.wait_for_timeout(250)
            if pending:
                break
        self.assertEqual(len(pending), 1, "A real autosave is awaiting its response")
        dialogs, writes = [], []
        first.on("dialog", lambda d: (dialogs.append(d.type), d.dismiss()))
        context.on("request", lambda r: writes.append(r.url) if r.method == "POST" and r.url.endswith("/auth/logout") else None)
        with first.expect_response(lambda r: r.request.method == "POST" and r.url.endswith("/auth/logout")) as ended:
            first.locator("#logout").click()
            self.assertEqual(writes, [], "Logout must wait for the in-flight save")
            route, answer = pending.pop()
            route.fulfill(response=answer)
        self.assertEqual(ended.value.status, 204)
        for page in (first, second):
            expect(page.locator("#logout")).not_to_be_visible()
        self.assertEqual(dialogs, [])
        self.assertEqual(len(writes), 1)
        result = self.stack.request("GET", f"/studies/{fixture.uid}/draft", "doctor")
        self.assertEqual(result.status, 200)
        self.assertEqual(result.body["snapshot"]["findings"], "Synthetic draft saved by logout")

    def test_failed_preparation_back_to_editing_preserves_text_and_session(self):
        fixture = self.fixture()
        session = Session(self.stack).login(self)
        page = self.open_main(self.profile(session))
        self.select(page, fixture)
        page.locator("#findings").fill("Synthetic text retained after request failure")
        def unavailable(route):
            if route.request.method == "PUT":
                route.fulfill(status=503, content_type="application/json",
                              body=json.dumps({"code": "REPORT_DRAFT_UNAVAILABLE"}))
            else:
                route.continue_()
        page.route("**/api/studies/*/report", unavailable)
        page.locator("#logout").click()
        page.get_by_role("button", name="Back to Editing", exact=True).click()
        expect(page.locator("dialog[open]")).to_have_count(0)
        expect(page.locator("#findings")).to_have_value("Synthetic text retained after request failure")
        expect(page.locator("#findings")).to_be_editable()
        self.assertEqual(session.json("GET", "/api/me")[0], 200)

    def settled_image(self, canvas, same_as=None):
        """The canvas picture once it stops changing (and, when given, once it is that earlier picture again)."""
        previous = None
        for _ in range(60):
            current = canvas.screenshot()
            if current == previous and same_as in (None, current):
                return current
            previous = current
            canvas.page.wait_for_timeout(500)
        self.fail("The viewer canvas did not settle" + (" on the picture it showed before" if same_as else ""))

    def test_wait_viewer_preparation_cancel_preserves_document_canvas_and_report(self):
        fixture = self.fixture()
        session = Session(self.stack).login(self)
        page = self.open_main(self.profile(session))
        self.select(page, fixture)
        with page.context.expect_page() as opened:
            page.locator(f'#rows tr[data-uid="{fixture.uid}"]').dblclick()
        viewer = opened.value
        viewer.wait_for_url("**/ohif/viewer?**", timeout=30000)
        canvas = viewer.locator(".cornerstone-canvas").first
        expect(canvas).to_be_visible(timeout=60000)
        # An allocated but blank canvas is not a shown image: real CT pixels have a range of grey values.
        viewer.wait_for_function("""() => {
            const canvas = document.querySelector('.cornerstone-canvas'), context = canvas?.getContext('2d');
            if (!context || !canvas.width || !canvas.height) return false;
            const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let min = 255, max = 0;
            for (let i = 0; i < data.length; i += 16) { min = Math.min(min, data[i]); max = Math.max(max, data[i]); }
            return max - min > 40;
        }""", timeout=60000)
        before_url = viewer.url
        before_image = self.settled_image(canvas)
        viewer.evaluate("window.kinE2eSameDocument = true")
        page.locator("#findings").fill("Synthetic viewer preservation")
        page.route("**/api/studies/*/report", lambda route: route.fulfill(
            status=503, content_type="application/json", body='{"code":"REPORT_DRAFT_UNAVAILABLE"}')
            if route.request.method == "PUT" else route.continue_())
        page.locator("#logout").click()
        # The preparation really ran and its save was refused before it is cancelled.
        expect(page.get_by_role("button", name="Retry", exact=True)).to_be_visible()
        page.get_by_role("button", name="Back to Editing", exact=True).click()
        expect(page.locator("dialog[open]")).to_have_count(0)
        self.assertFalse(viewer.is_closed())
        expect(canvas).to_be_visible()
        self.assertEqual(viewer.url, before_url)
        self.assertTrue(viewer.evaluate("window.kinE2eSameDocument === true"), "the viewer document was replaced")
        self.settled_image(canvas, same_as=before_image)
        expect(page.locator("#findings")).to_have_value("Synthetic viewer preservation")


def load_tests(loader, tests, pattern):
    # Inherited worklist helpers do not imply a second execution of its entire suite.
    return unittest.TestSuite(SessionDraftBoundaries(name) for name in sorted(vars(SessionDraftBoundaries))
                              if name.startswith("test_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
