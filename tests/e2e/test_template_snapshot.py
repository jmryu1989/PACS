# coding: utf-8
"""D09E: asynchronous source changes cannot erase the independence of a copied template editor."""
from __future__ import annotations

import unittest
import uuid

from playwright.sync_api import expect
import test_report_template as previous


class TemplateSnapshotE2E(previous.ReportTemplateE2E):
    def new_title(self):
        return "D09E-" + uuid.uuid4().hex[:12]

    def refresh(self, page):
        # Existing UI event may arrive while an editor is open; do not change app variables.
        with page.expect_response(lambda r: r.request.method == "GET" and r.url.endswith("/api/studies")):
            page.locator("#refresh").dispatch_event("click")

    def test_d09e_01_delayed_draft_discard_preserves_copied_editor(self):
        """SNAPSHOT/LOSS: a real pending discard may finish after the user opens the template editor."""
        fixture = self.fixture()
        values = dict(findings="Copied draft\nsecond line", conclusion="Copied conclusion",
                      recommendation="Copied recommendation\nlast line")
        response = self.stack.request("PUT", f"/studies/{fixture.uid}/report", "doctor", dict(values, baseVersion=0))
        self.assertEqual(response.status, 200)
        page = self.login(); self.select(page, fixture)
        expect(page.locator("#findings")).to_have_value(values["findings"])
        pending = []
        pattern = f"**/api/studies/{fixture.uid}/draft"
        page.route(pattern, lambda route: pending.append(route))
        try:
            page.once("dialog", lambda dialog: dialog.accept())
            with page.expect_request(lambda r: r.method == "DELETE" and r.url.endswith(f"/studies/{fixture.uid}/draft")):
                page.locator("#b-draft-discard").click()
            self.capture(page)
            title = self.new_title(); page.locator("#tpl-t").fill(title)
            self.assertEqual(len(pending), 1)
            reply = pending[0].fetch()
            self.assertEqual(reply.status, 200)
            pending[0].fulfill(response=reply)
            for field in values:expect(page.locator("#" + field)).to_have_value("")
            expect(page.locator("#b-report-template")).to_be_disabled()
            for key, field in [("findings", "f"), ("conclusion", "c"), ("recommendation", "r")]:
                expect(page.locator("#tpl-" + field)).to_have_value(values[key])
            expect(page.locator("#tpl-t")).to_have_value(title)
            expect(page.locator("#tpl-save")).to_be_enabled()
            # The user explicitly discarded the source draft. Snapshot saving must add no further source write.
            after_discard = self.report_rows(fixture)
            self.assertEqual(after_discard["ReportDraft"], [])
            writes = self.template_writes(page)
            source_writes = []
            page.on("request", lambda r: source_writes.append(r.url) if r.method in ("POST", "PUT", "PATCH", "DELETE")
                    and f"/studies/{fixture.uid}/" in r.url else None)
            page.locator("#tpl-f").fill(values["findings"] + "\nReviewed")
            saved = self.remember(self.save(page))
            self.assertEqual(saved["findings"], values["findings"] + "\nReviewed")
            for field in ("conclusion", "recommendation"):self.assertEqual(saved[field], values[field])
            self.assertEqual(saved["owner"], self.stack.actor("doctor"))
            self.assertIsNone(self.saved_template(saved["id"], "doctor2"))
            self.assertEqual(len(writes), 1); self.assertEqual(source_writes, [])
            self.assertEqual(self.report_rows(fixture), after_discard)
            fresh = self.login(); fresh.locator("#tpl-search").fill(title)
            fresh.locator("#tplrows").get_by_role("button", name="상용구 미리보기: " + title, exact=True).click()
            expect(fresh.locator("#tpl-preview-findings")).to_have_text(saved["findings"])
        finally:
            page.unroute(pattern)

    def test_d09e_02_missing_source_refuses_even_with_copied_content(self):
        """ACCESS/STALE: removing the source from a synthetic list response is not permission to save it."""
        fixture = self.fixture(); self.seed_report(fixture)
        before = self.report_rows(fixture)
        page = self.login(); self.select(page, fixture); self.capture(page)
        title = self.new_title(); page.locator("#tpl-t").fill(title)
        writes = self.template_writes(page)
        def without_source(route):
            reply = route.fetch(); data = reply.json()
            data["studies"] = [row for row in data["studies"] if row["uid"] != fixture.uid]
            route.fulfill(response=reply, json=data)
        page.route("**/api/studies", without_source)
        try:
            self.refresh(page)
            expect(page.locator(f'#rows tr[data-uid="{fixture.uid}"]')).to_have_count(0)
            expect(page.locator("#tplmodal")).to_be_visible()
            expect(page.locator("#tpl-save")).to_be_disabled()
            page.locator("#tpl-save").dispatch_event("click")
            expect(page.locator("#toast")).to_have_class("show err")
            expect(page.locator("#tpl-source")).to_contain_text("출처 검사를 확인할 수 없습니다")
            expect(page.locator("#tpl-f")).to_have_value(fixture.secret)
            expect(page.locator("#tpl-t")).to_have_value(title)
            self.assertEqual(writes, [])
            self.assertEqual(self.report_rows(fixture), before)
        finally:
            page.unroute("**/api/studies")
        self.refresh(page)
        expect(page.locator("#tpl-save")).to_be_enabled()
        self.remember(self.save(page))
        self.assertEqual(len(writes), 1)
        self.assertEqual(self.report_rows(fixture), before)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(TemplateSnapshotE2E(name) for name in loader.getTestCaseNames(TemplateSnapshotE2E)
                              if name.startswith("test_d09e_"))


if __name__ == "__main__":unittest.main(verbosity=2)
