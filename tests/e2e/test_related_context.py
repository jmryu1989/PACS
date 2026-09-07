# coding: utf-8
"""D03B: distinguish the report target from the related study and its date relation."""
from __future__ import annotations

import re
import unittest
import uuid

from playwright.sync_api import expect
import test_prior_selection as previous
from test_template_preservation import TemplatePreservationE2E


class RelatedContextE2E(previous.PriorSelectionE2E):
    report_rows = TemplatePreservationE2E.report_rows

    def ct(self, patient, label, date):
        return previous.synthetic_ct(self.stack, patient, label, date, slices=2)

    def related(self, page, fixture):
        return page.locator(f'#relrows tr[data-uid="{fixture.uid}"]')

    def refresh(self, page):
        with page.expect_response(lambda r: r.request.method == "GET" and r.url.endswith("/api/studies")):
            page.locator("#refresh").click()

    def source_writes(self, page):
        writes = []
        page.on("request", lambda r: writes.append(r.url) if r.method in ("POST", "PUT", "PATCH", "DELETE")
                and "/api/studies/" in r.url else None)
        return writes

    def test_d03b_01_real_dates_manual_comparison_keeps_report_target(self):
        """CONTEXT/TARGET: compare later CT while retaining the current report and private draft."""
        patient = "D03B-" + uuid.uuid4().hex[:16]
        current = self.ct(patient, "current", "20260801")
        past = self.ct(patient, "past", "20260701")
        same = self.ct(patient, "same", "20260801")
        future = self.ct(patient, "future", "20260907")
        self.seed_report(current)
        for fixture in (past, same, future):self.seed_report(fixture, action="approve")
        draft = "D03B private draft"
        self.assertEqual(self.stack.request("PUT", f"/studies/{current.uid}/report", "doctor",
                         dict(findings=draft, conclusion="", recommendation="", baseVersion=1)).status, 200)
        fixtures = (current, past, same, future)
        rows = {f.uid: self.report_rows(f) for f in fixtures}; originals = self.originals()
        page = self.login()
        expect(page.locator("#related-current")).to_have_text("판독 대상을 선택하세요")
        self.select(page, current)
        expected_current = page.locator("#related-current").inner_text()
        self.assertEqual(page.locator("#related-current").get_attribute("title"), expected_current)
        for part in ("판독 대상", patient, "2026-08-01", "CT", "D03A current"):
            self.assertIn(part, expected_current)
        self.assertEqual(page.locator("#relrows tr[data-uid]").count(), 3)
        writes = self.source_writes(page)
        for fixture, label in ((past, "과거"), (same, "같은 날짜 · 선후 미확인"), (future, "이후")):
            row = self.related(page, fixture)
            expect(row.locator("td").first).to_have_text(label + " · 비교")
            row.click()
            expect(row.locator("td").first).to_have_text(label + " · 👁 열람 중")
            expect(page.locator("#prior-findings")).to_have_text(fixture.secret)
            expect(page.locator("#prior-report-meta")).to_contain_text(label + " · ")
            expect(page.locator("#prior-report-meta")).to_contain_text(patient)
            self.assertEqual(page.locator("#prior-report-meta").get_attribute("title"),
                             page.locator("#prior-report-meta").inner_text())
            expect(page.locator("#related-current")).to_have_text(expected_current)
            expect(page.locator("#findings")).to_have_value(draft)
        expect(page.locator(".prior-report-head b")).to_have_text("관련 판독문")
        self.viewer(page, self.related(page, future), [current, future])
        expect(page.locator(f'#rows tr[data-uid="{current.uid}"]')).to_have_class(re.compile(r"\bsel\b"))
        expect(page.locator("#related-current")).to_have_text(expected_current)
        expect(page.locator("#findings")).to_have_value(draft)
        self.assertEqual(writes, [])
        for fixture in fixtures:self.assertEqual(self.report_rows(fixture), rows[fixture.uid])
        self.assertIsNone(self.state(current, "doctor2").get("draft"))
        self.assertEqual(self.originals(), originals)

    def test_d03b_02_unknown_dates_are_not_inferred_and_text_is_literal(self):
        """DATE/ORDER: fixture-only list variants do not rewrite DICOM or claim permission changes."""
        patient = "D03B-" + uuid.uuid4().hex[:16]
        current = self.ct(patient, "current", "20260801")
        target = self.ct(patient, "past", "20260701")
        unrelated = self.ct(patient + "-other", "other", "20260701")
        originals = self.originals(); rows = {f.uid: self.report_rows(f) for f in (current, target, unrelated)}
        variants = {current.uid: "20260801", target.uid: "20260701"}
        literal = '<img src=x onerror="window.d03bBad=1"> & synthetic'
        def dates(route):
            response = route.fetch(); data = response.json()
            for row in data["studies"]:
                if row["uid"] in variants:
                    row["date"] = variants[row["uid"]]
                    row["name"] = row["desc"] = literal
            route.fulfill(response=response, json=data)
        page = self.login(); page.route("**/api/studies", dates)
        self.addCleanup(page.unroute, "**/api/studies")
        self.refresh(page); self.select(page, current)
        expect(self.related(page, unrelated)).to_have_count(0)
        expect(page.locator("#related-current")).to_contain_text(literal)
        self.related(page, target).click()
        expect(page.locator("#prior-report-meta")).to_contain_text(literal)
        writes = self.source_writes(page)
        for current_date, target_date, label in (("20260801", "", "날짜 미확인"),
                ("20260801", "20260230", "날짜 미확인"), ("", "20260701", "날짜 미확인"),
                ("20260230", "20260701", "날짜 미확인"), ("20260801", "20260801", "같은 날짜 · 선후 미확인")):
            variants.update({current.uid: current_date, target.uid: target_date}); self.refresh(page)
            expect(self.related(page, target).locator("td").first).to_have_text(label + " · 👁 열람 중")
            expect(page.locator("#prior-report-meta")).to_contain_text(label + " · ")
            self.assertIsNone(page.evaluate("window.d03bBad"))
            expect(page.locator("#related-current img, #relrows img, #prior-report-meta img")).to_have_count(0)
        self.assertEqual(writes, [])
        for fixture in (current, target, unrelated):self.assertEqual(self.report_rows(fixture), rows[fixture.uid])
        self.assertEqual(self.originals(), originals)

    def test_d03b_03_delayed_reply_and_failure_keep_context_in_small_windows(self):
        """LATE/STALE: an older response cannot replace the newest A in related A-B-A navigation."""
        patient = "D03B-" + uuid.uuid4().hex[:16]
        current = self.ct(patient, "current", "20260801")
        past = self.ct(patient, "past", "20260701")
        future = self.ct(patient, "future", "20260907")
        for fixture in (past, future):self.seed_report(fixture, action="approve")
        rows = {f.uid: self.report_rows(f) for f in (current, past, future)}; originals = self.originals()
        page = self.login(); self.select(page, current); writes = self.source_writes(page)
        pending = []; pattern = f"**/api/studies/{past.uid}/report/versions"
        page.route(pattern, lambda route: pending.append(route))
        self.addCleanup(page.unroute, pattern)
        self.related(page, past).click()
        self.related(page, future).click()
        expect(page.locator("#prior-findings")).to_have_text(future.secret)
        expect(page.locator("#prior-report-meta")).to_contain_text("이후 · ")
        self.related(page, past).click()
        expect(page.locator("#prior-report-content")).not_to_be_visible()
        page.wait_for_timeout(100)
        self.assertEqual(len(pending), 2)
        reply = pending[1].fetch(); self.assertEqual(reply.status, 200); pending[1].fulfill(response=reply)
        expect(page.locator("#prior-findings")).to_have_text(past.secret)
        # Alter only this fixture's delayed response so accepting the stale payload would be observable.
        reply = pending[0].fetch(); old = reply.json(); old[0]["findings"] = "D03B stale response must stay hidden"
        pending[0].fulfill(response=reply, json=old)
        page.wait_for_timeout(150)
        expect(page.locator("#prior-findings")).to_have_text(past.secret)
        expect(page.locator("#prior-report-meta")).to_contain_text("과거 · ")
        fail_pattern = f"**/api/studies/{future.uid}/report/versions"
        page.route(fail_pattern, lambda route: route.fulfill(status=503, json={"message": "D03B synthetic failure"}))
        self.related(page, future).click()
        expect(page.locator("#prior-report-status")).to_contain_text("판독문 조회 실패")
        expect(page.locator("#prior-report-content")).not_to_be_visible()
        expect(page.locator("#prior-report-meta")).to_contain_text("이후 · ")
        page.unroute(fail_pattern); page.unroute(pattern)
        self.refresh(page)
        expect(page.locator("#prior-findings")).to_have_text(future.secret)
        folder = previous.base.Path(__file__).parent / "artifacts"; folder.mkdir(exist_ok=True)
        for height in (600, 1200):
            page.set_viewport_size(dict(width=900, height=height))
            for selector in ("#related-current", ".prior-report-head", "#prior-report-content"):
                expect(page.locator(selector)).to_be_in_viewport()
            self.related(page, future).scroll_into_view_if_needed()
            expect(self.related(page, future)).to_be_in_viewport()
            row = self.related(page, future).bounding_box()
            grid = page.locator(".related-list-pane .grid2").bounding_box()
            self.assertGreaterEqual(row["y"], grid["y"] - 1)
            self.assertLessEqual(row["y"] + row["height"], grid["y"] + grid["height"] + 1,
                                 "The reporting-target label must not consume the selected row's height")
            page.screenshot(path=str(folder / f"d03b-context-900x{height}.png"))
        self.assertEqual(writes, [])
        for fixture in (current, past, future):self.assertEqual(self.report_rows(fixture), rows[fixture.uid])
        self.assertEqual(self.originals(), originals)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(RelatedContextE2E(name) for name in loader.getTestCaseNames(RelatedContextE2E)
                              if name.startswith("test_d03b_"))


if __name__ == "__main__":unittest.main(verbosity=2)
