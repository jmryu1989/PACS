"""U5S-REQ-08/13/15/17 -> RISK-LOST-TEXT/STALE-DRAFT -> real report page.

No source slicing: serve main.html and every shipped asset. Reuse the wire server
from the already migrated logout suite; all routes are intercepted, with no live stack.
These cases complement the detailed citation/cursor/structure component scenarios.
"""
import os
import time
import unittest
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
import auth_logout_dom_test as auth


class ReportSite(auth.Site):
    def write(self, body, account):
        status, answer = super().write(body, account)
        if status == 200 and body.get("insert"):
            inserted = {**body["insert"], "cid": "SYN-CITATION-1", "insertedBy": account["actor"],
                        "insertedAt": "2026-10-04T00:00:00.000Z"}
            self.rows[account["actor"]]["citations"].append(inserted["cid"])
            answer = {**self.envelope(account), "inserted": inserted}
        return status, answer


class ReportSessionPageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = ReportSite()
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 900})
        self.errors, self.dialogs = [], []
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.page.on("dialog", lambda d: (self.dialogs.append(d.message), d.dismiss()))
        self.page.clock.install()
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator("#rows")).to_contain_text(auth.PATIENT)

    def route(self, route, request):
        # Mutants are copies outside the product tree, served only for this test.
        override = os.environ.get("KIN_REPORT_PAGE_MAIN")
        if override and request.url == auth.MAIN_URL:
            return route.fulfill(body=Path(override).read_bytes(), content_type="text/html")
        return self.site.handle(route, request)

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors)
        self.assertEqual([], self.site.violations)

    def wait(self, predicate):
        until = time.monotonic() + 5
        while not predicate():
            if time.monotonic() > until:
                self.fail("server outcome not observed: " + repr(self.site.calls[-8:]))
            self.page.wait_for_timeout(20)

    def type_report(self, fields=auth.FIELDS):
        self.page.locator("#rows tr", has_text=auth.PATIENT).first.click()
        for key, value in fields.items():
            self.page.locator("#" + key).fill(value)

    def assert_text(self, fields=auth.FIELDS):
        for key, value in fields.items():
            expect(self.page.locator("#" + key)).to_have_value(value)

    def test_normal_autosave_is_bound_and_saves_every_field_without_a_dialog(self):
        self.type_report()
        self.page.clock.run_for(20001)
        self.wait(lambda: self.site.stored() == auth.FIELDS)
        self.assert_text()
        self.assertEqual([self.site.cookie], self.site.put_sessions)
        self.assertEqual("SYNEPOCH1:0", self.site.puts[0]["expectedRevision"])
        self.assertEqual([], self.dialogs)

    def test_a_held_save_and_later_typing_are_serial_and_keep_the_newer_text(self):
        self.type_report()
        self.site.put_answers = ["hold"]
        self.page.clock.run_for(20001)
        self.wait(lambda: len(self.site.held_puts) == 1)
        for key, value in auth.MORE.items():
            self.page.locator("#" + key).fill(value)
        self.page.clock.run_for(1000)
        self.assertEqual(1, len(self.site.puts))
        self.site.finish_put()
        self.wait(lambda: self.site.stored() == auth.FIELDS)
        self.assert_text(auth.MORE)
        self.page.clock.run_for(20001)
        self.wait(lambda: self.site.stored() == auth.MORE)
        self.assert_text(auth.MORE)
        self.assertEqual(["SYNEPOCH1:0", "SYNEPOCH1:1"], [p["expectedRevision"] for p in self.site.puts])
        self.assertEqual([], self.dialogs)

    def test_one_logout_click_waits_for_the_save_and_ends_automatically(self):
        self.type_report()
        self.site.put_answers = ["hold"]
        self.page.clock.run_for(20001)
        self.wait(lambda: len(self.site.held_puts) == 1)
        self.page.locator("#logout").click()
        self.assertEqual([], self.site.logouts)
        self.assertEqual([], self.dialogs)
        self.site.finish_put()
        self.wait(lambda: len(self.site.logouts) == 1)
        expect(self.page).to_have_url(auth.INDEX_URL)
        self.assertEqual(auth.FIELDS, self.site.stored())

    def test_another_documents_newer_draft_is_not_overwritten_and_local_text_stays(self):
        self.type_report()
        self.site.revs[auth.RAD["actor"]] = 1
        self.site.rows[auth.RAD["actor"]] = {**auth.MORE, "baseVersion": 0, "citations": [], "structured": []}
        self.page.clock.run_for(20001)
        self.wait(lambda: bool(self.site.draft_reads) and bool(self.site.puts))
        expect(self.page.locator("#b-draft-keep")).to_be_visible()
        self.assert_text()
        self.assertEqual(auth.MORE, self.site.stored())
        self.assertEqual(1, len(self.site.puts))

    def test_one_logout_event_waits_for_the_citation_and_preserves_it_exactly_once(self):
        self.type_report()
        block = "SYN cited finding"
        # Exercise the module's page callback; the detailed finding-picker UI has its own suite.
        self.assertTrue(self.page.evaluate("request => openCitePreview(request)", {
            "uid": auth.UID, "findingId": "SYN-FINDING", "findingRevision": 1, "sourceIndex": 0,
            "sourceLabel": "SYN source", "linkState": "current", "headRevision": None, "block": block}))
        self.site.put_answers = ["hold"]
        self.page.locator("#cite-preview-insert").click()
        self.wait(lambda: len(self.site.held_puts) == 1)
        # The busy modal covers the pointer target; dispatch the same single logout activation.
        self.page.locator("#logout").dispatch_event("click")
        self.assertEqual([], self.site.logouts)
        self.assertEqual([], self.dialogs)
        self.site.finish_put()
        self.wait(lambda: len(self.site.logouts) == 1)
        expect(self.page).to_have_url(auth.INDEX_URL)
        self.assertEqual({**auth.FIELDS, "findings": auth.FIELDS["findings"] + "\n" + block}, self.site.stored())
        self.assertEqual(["SYN-CITATION-1"], self.site.rows[auth.RAD["actor"]]["citations"])
        self.assertEqual(1, sum(bool(p.get("insert")) for p in self.site.puts))

    def test_a_plain_401_is_a_failed_request_and_keeps_the_document_and_text(self):
        self.type_report()
        self.site.put_answers = [(401, {"message": "synthetic request refusal"})]
        self.page.clock.run_for(20001)
        self.wait(lambda: bool(self.site.puts))
        expect(self.page.locator("#toast")).to_contain_text("서버 저장 실패")
        self.assert_text()
        self.assertEqual("active", self.page.evaluate("KinWorkContext.state()"))
        self.assertEqual([], self.site.logouts)
        self.assertEqual([], self.dialogs)


if __name__ == "__main__":
    unittest.main(verbosity=2)
