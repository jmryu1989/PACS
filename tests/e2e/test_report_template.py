# coding: utf-8
"""D09C: capture only the current report into a reviewed new personal template."""
from __future__ import annotations

import unittest
import uuid

from playwright.sync_api import expect
import test_template_preservation as previous


class ReportTemplateE2E(previous.TemplatePreservationE2E):
    def draft(self, fixture, **changes):
        values = dict(findings="Current draft\nsecond line", conclusion="Current conclusion",
                      recommendation="Current recommendation\nlast line")
        values.update(changes)
        result = self.stack.request("PUT", f"/studies/{fixture.uid}/report", "doctor", dict(values, baseVersion=1))
        self.assertEqual(result.status, 200)
        return values

    def capture(self, page):
        page.locator("#b-report-template").click()
        expect(page.locator("#tplmodal")).to_be_visible()

    def remember(self, saved):
        self.addCleanup(self.remove_template, saved["id"])
        return saved

    def new_title(self):
        return "D09C-" + uuid.uuid4().hex[:12]

    def template_writes(self, page):
        writes = []
        page.on("request", lambda r: writes.append(r) if r.method == "POST" and r.url.endswith("/templates") else None)
        return writes

    def test_d09c_01_current_draft_to_new_personal_template_and_relogin(self):
        """CAPTURE/MIX: prior stays separate; saving a new template never commits its source."""
        patient = self.new_title()
        current, prior = self.fixture(patient_id=patient), self.fixture(patient_id=patient)
        self.seed_report(current)
        self.seed_report(prior, action="approve")
        values = self.draft(current)
        anchor = self.template()
        originals = {f.uid: self.report_rows(f) for f in (current, prior)}
        page = self.login()
        self.select(page, current)
        page.locator(f'#relrows tr[data-uid="{prior.uid}"]').click()
        expect(page.locator("#prior-findings")).to_contain_text(prior.secret)
        writes = self.template_writes(page)
        self.capture(page)
        expect(page.locator("#tpl-source")).to_have_attribute("data-uid", current.uid)
        expect(page.locator("#tpl-source")).to_contain_text(current.patient_id)
        for key, field in [("findings", "f"), ("conclusion", "c"), ("recommendation", "r")]:
            expect(page.locator("#tpl-" + field)).to_have_value(values[key])
        for field in ("t", "s", "b"):
            expect(page.locator("#tpl-" + field)).to_have_value("")
        expect(page.locator("#tpl-m")).to_have_value("CT")
        self.assertEqual(writes, [])
        title = self.new_title()
        page.locator("#tpl-t").fill(title)
        page.locator("#tpl-f").fill("Reusable findings\nreviewed")
        saved = self.remember(self.save(page))
        self.assertEqual(len(writes), 1)
        payload = writes[0].post_data_json
        self.assertFalse({"id", "owner", "uid", "patientId", "name", "acc"}.intersection(payload))
        self.assertNotEqual(saved["id"], anchor["id"])
        self.assertEqual(saved["ord"], anchor["ord"] + 1)
        self.assertEqual(saved["owner"], self.stack.actor("doctor"))
        self.assertEqual(self.saved_template(anchor["id"]), anchor)
        self.assertIsNone(self.saved_template(saved["id"], "doctor2"))
        fresh = self.login()
        fresh.locator("#tpl-search").fill(title)
        fresh.locator("#tplrows").get_by_role("button", name="상용구 미리보기: " + title, exact=True).click()
        expect(fresh.locator("#tpl-preview-findings")).to_have_text("Reusable findings\nreviewed")
        expect(fresh.locator("#tpl-preview-recommendation")).to_have_text(values["recommendation"])
        for fixture in (current, prior):
            self.assertEqual(self.report_rows(fixture), originals[fixture.uid])

    def test_d09c_02_cancel_validation_failure_preserves_reviewed_text(self):
        """REVIEW/LOSS: preparation and cancellation write nothing; failed saves keep all input."""
        fixture = self.fixture()
        self.seed_report(fixture)
        values = self.draft(fixture, findings="\n".join("Synthetic line " + str(n) for n in range(35)),
                            recommendation="<script>window.d09cBad=1</script>\nReview this wording")
        duplicate = self.template()
        before = self.report_rows(fixture)
        page = self.login()
        self.select(page, fixture)
        report_writes = []
        page.on("request", lambda r: report_writes.append(r.url) if r.method in ("POST", "PUT", "PATCH", "DELETE")
                and ("/report" in r.url or r.url.endswith("/hold")) else None)
        writes = self.template_writes(page)
        for escape in (False, True):
            self.capture(page)
            page.locator("#tpl-t").fill("Cancelled")
            if escape:
                page.keyboard.press("Escape")
            else:
                page.locator("#tpl-cancel").click()
            expect(page.locator("#tplmodal")).to_be_hidden()
            expect(page.locator("#tpl-f")).to_have_value("")
        self.assertEqual(writes, [])
        page.set_viewport_size({"width": 900, "height": 600})
        self.capture(page)
        page.locator("#tpl-save").click()
        expect(page.locator("#toast")).to_contain_text("제목은 비울 수 없습니다")
        title = self.new_title()
        page.locator("#tpl-t").fill(title)
        page.locator("#tpl-s").fill(duplicate["shortcut"])
        page.locator("#tpl-save").click()
        expect(page.locator("#toast")).to_contain_text("쓰고 있습니다")
        self.assertEqual(writes, [])
        page.locator("#tpl-s").fill("")
        page.locator("#tpl-r").scroll_into_view_if_needed()
        for selector in ("#tpl-source", "#tpl-r", "#tpl-save", "#tpl-cancel"):
            expect(page.locator(selector)).to_be_in_viewport()
        expect(page.locator("#tpl-r")).to_have_value(values["recommendation"])
        expect(page.locator("#tplmodal script, #tplmodal img")).to_have_count(0)
        self.assertIsNone(page.evaluate("window.d09cBad"))
        folder = previous.base.Path(__file__).parent / "artifacts"
        folder.mkdir(exist_ok=True)
        page.screenshot(path=str(folder / "D09C-report-template.png"))
        page.route("**/api/templates", lambda route: route.fulfill(status=503, content_type="application/json", body='{"message":"Synthetic unavailable"}'))
        try:
            page.locator("#tpl-save").click()
            expect(page.locator("#toast")).to_contain_text("상용구 저장 실패")
            expect(page.locator("#tplmodal")).to_be_visible()
            expect(page.locator("#tpl-t")).to_have_value(title)
            expect(page.locator("#tpl-r")).to_have_value(values["recommendation"])
            expect(page.locator("#tpl-save")).to_be_enabled()
        finally:
            page.unroute("**/api/templates")
        saved = self.remember(self.save(page))
        self.assertEqual(saved["recommendation"], values["recommendation"])
        self.assertEqual(report_writes, [])
        self.assertEqual(self.report_rows(fixture), before)

    def test_d09c_03_selection_invalidation_pending_and_refresh_failure(self):
        """SESSION/STALE: late success cannot close a newer editor or cause a retry duplicate."""
        patient = self.new_title()
        first, second = self.fixture(patient_id=patient), self.fixture(patient_id=patient)
        for fixture in (first, second):
            self.seed_report(fixture)
        before = {f.uid: self.report_rows(f) for f in (first, second)}
        page = self.login()
        self.select(page, first)
        writes = self.template_writes(page)
        self.capture(page)
        page.locator("#tpl-t").fill("Stale")
        for fixture in (second, first):
            page.locator(f'#rows tr[data-uid="{fixture.uid}"]').dispatch_event("click")
        expect(page.locator("#tplmodal")).to_be_hidden()
        expect(page.locator("#tpl-f")).to_have_value("")
        page.locator("#tpl-save").dispatch_event("click")
        self.assertEqual(writes, [])
        self.capture(page)
        delayed_title = self.new_title()
        page.locator("#tpl-t").fill(delayed_title)
        pending = []
        page.route("**/api/templates", lambda route: pending.append(route))
        try:
            page.locator("#tpl-save").click()
            expect(page.locator("#tpl-save")).to_be_disabled()
            expect(page.locator("#tpl-f")).to_be_disabled()
            page.locator("#tpl-save").dispatch_event("click")
            self.assertEqual(len(pending), 1)
            page.locator(f'#rows tr[data-uid="{second.uid}"]').dispatch_event("click")
            expect(page.locator("#tplmodal")).to_be_hidden()
            self.capture(page)
            page.locator("#tpl-t").fill("New editor input")
            response = pending[0].fetch()
            saved = self.remember(response.json())
            pending[0].fulfill(response=response)
            expect(page.locator("#tplrows").get_by_text(delayed_title, exact=True)).to_be_visible()
            expect(page.locator("#tplmodal")).to_be_visible()
            expect(page.locator("#tpl-t")).to_have_value("New editor input")
            expect(page.locator("#tpl-f")).to_have_value(second.secret)
            self.assertEqual(saved["findings"], first.secret)
            self.assertEqual(len(writes), 1)
        finally:
            page.unroute("**/api/templates")
        page.locator("#tpl-cancel").click()
        self.capture(page)
        title = self.new_title()
        page.locator("#tpl-t").fill(title)
        page.route("**/api/prefs", lambda route: route.fulfill(status=503, content_type="application/json", body='{"message":"Synthetic refresh failure"}'))
        try:
            saved = self.remember(self.save(page))
            expect(page.locator("#toast")).to_contain_text("상용구는 저장됐지만 목록 갱신에 실패")
            page.locator("#tpl-save").dispatch_event("click")
            self.assertEqual(len(writes), 2)
            prefs = self.stack.request("GET", "/prefs", "doctor")
            matches = [t for t in prefs.body["templates"] if t["title"] == title]
            self.assertEqual([t["id"] for t in matches], [saved["id"]])
        finally:
            page.unroute("**/api/prefs")
        for fixture in (first, second):
            self.assertEqual(self.report_rows(fixture), before[fixture.uid])

    def test_d09c_04_guards_late_hold_and_approved_history(self):
        """GUARD/LOCK: both handlers enforce locks; an approved source remains immutable."""
        filming, held, preliminary, normal, empty, approved = (self.fixture() for _ in range(6))
        for fixture in (filming, held, normal):
            self.seed_report(fixture)
        self.seed_report(approved, action="approve")
        self.patch(filming, ss="Unverified", em="N")
        self.assertEqual(self.stack.request("POST", f"/studies/{held.uid}/hold", "doctor2").status, 201)
        response = self.stack.request("POST", f"/studies/{preliminary.uid}/report/commit", "doctor2", {
            "action": "preliminary", "baseVersion": 0, "reviewer": self.stack.actor("jmryu"),
            "findings": preliminary.secret, "conclusion": "Private P", "recommendation": ""})
        self.assertEqual(response.status, 201)
        page = self.login()
        writes = self.template_writes(page)
        expect(page.locator("#b-report-template")).to_be_disabled()
        page.locator("#b-report-template").dispatch_event("click")
        expect(page.locator("#tplmodal")).to_be_hidden()
        for fixture in (filming, held, preliminary, empty):
            self.select(page, fixture)
            before = self.report_rows(fixture)
            expect(page.locator("#b-report-template")).to_be_disabled()
            page.locator("#b-report-template").dispatch_event("click")
            expect(page.locator("#tplmodal")).to_be_hidden()
            self.assertEqual(self.report_rows(fixture), before)
        self.select(page, normal)
        before = self.report_rows(normal)
        self.capture(page)
        page.locator("#tpl-t").fill("Must not save")
        self.assertEqual(self.stack.request("POST", f"/studies/{normal.uid}/hold", "doctor2").status, 201)
        # Refresh is a real UI event arriving while the editor is open.
        page.locator("#refresh").dispatch_event("click")
        expect(page.locator("#findings")).to_have_js_property("readOnly", True)
        expect(page.locator("#tpl-save")).to_be_disabled()
        page.locator("#tpl-save").dispatch_event("click")
        expect(page.locator("#toast")).to_have_class("show err")
        self.assertEqual(writes, [])
        self.assertEqual(self.report_rows(normal), before)
        page.locator("#tpl-cancel").click()
        self.select(page, approved)
        before = self.report_rows(approved)
        self.capture(page)
        page.locator("#tpl-t").fill(self.new_title())
        self.remember(self.save(page))
        self.assertEqual(self.report_rows(approved), before)
        self.assertEqual(self.state(approved)["rs"], "A")
        tech = self.login("tech")
        self.select(tech, approved)
        expect(tech.locator("#b-report-template")).to_be_disabled()
        tech.locator("#b-report-template").dispatch_event("click")
        expect(tech.locator("#tplmodal")).to_be_hidden()
        self.assertEqual(self.stack.request("POST", "/templates", "tech", {"title": self.new_title(), "findings": "Denied"}).status, 403)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ReportTemplateE2E(name) for name in loader.getTestCaseNames(ReportTemplateE2E)
                              if name.startswith("test_d09c_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
