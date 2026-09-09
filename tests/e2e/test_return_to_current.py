# coding: utf-8
"""D03C: return from related viewing without moving or reloading the report target."""
from __future__ import annotations

import json
import re
import unittest
import uuid
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect
import test_related_context as previous
from test_prior_selection import canvas_ready


class ReturnToCurrentE2E(previous.RelatedContextE2E):
    def pair(self):
        patient = "D03C-" + uuid.uuid4().hex[:16]
        current = self.ct(patient, "current", "20260801")
        related = self.ct(patient, "future", "20260907")
        self.seed_report(current)
        self.seed_report(related, action="approve")
        return current, related

    def thumbnail_ready(self, page):
        expect(page.locator("#thumbwrap img")).to_have_count(1)
        page.wait_for_function("document.querySelector('#thumbwrap img')?.naturalWidth > 0")

    def return_with_thumbnail(self, page, current):
        with page.expect_request(lambda r: r.url.endswith("/api/dicom/lookup")
                                 and r.post_data_json.get("studyUid") == current.uid):
            page.locator("#related-return").click()
        self.thumbnail_ready(page)
        expect(page.locator("#related-return")).to_be_disabled()
        expect(page.locator("#relrows tr.related-selected")).to_have_count(0)
        expect(page.locator("#prior-report-meta")).to_have_text("")
        expect(page.locator("#prior-report-meta")).to_have_attribute("title", "")
        expect(page.locator("#prior-report-content")).not_to_be_visible()
        expect(page.locator("#prior-findings")).to_have_text("")
        expect(page.locator("#clinical")).to_contain_text("D03A current")

    def test_d03c_01_return_restores_real_current_viewer_and_preserves_draft(self):
        """RETURN/TARGET: no report movement/write accompanies the explicit viewing-only return."""
        current, related = self.pair()
        values = dict(findings="D03C private findings", conclusion="D03C private conclusion",
                      recommendation="D03C private recommendation")
        self.assertEqual(self.stack.request("PUT", f"/studies/{current.uid}/report", "doctor",
                         dict(values, baseVersion=1)).status, 200)
        originals = self.originals(); rows = {f.uid: self.report_rows(f) for f in (current, related)}
        page = self.login(); self.select(page, current); self.thumbnail_ready(page)
        writes = self.source_writes(page)
        self.related(page, related).click(); self.thumbnail_ready(page)
        expect(page.locator("#clinical")).to_contain_text("D03A future")
        expect(page.locator("#prior-findings")).to_have_text(related.secret)
        # Re-selecting the same reporting row remains inert; the separate return action supplies the missing path.
        self.select(page, current)
        expect(page.locator("#clinical")).to_contain_text("D03A future")
        self.return_with_thumbnail(page, current)
        for name,value in values.items():expect(page.locator("#" + name)).to_have_value(value)
        expect(page.locator(f'#rows tr[data-uid="{current.uid}"]')).to_have_class(re.compile(r"\bsel\b"))
        with page.context.expect_page() as opened:
            page.locator("#thumbwrap img").dblclick()
        viewer = opened.value
        try:
            viewer.wait_for_url("**/ohif/viewer?**"); canvas_ready(viewer, 1)
            query = parse_qs(urlsplit(viewer.url).query)
            self.assertEqual(query["StudyInstanceUIDs"], [current.uid])
            self.assertNotIn("hangingProtocolId", query)
            images = viewer.evaluate("""() => cornerstone.getRenderingEngines().filter(e => e.id !== '_thumbnails')
                .flatMap(e => e.getViewports().map(v => v.getCurrentImageId?.()))""")
            self.assertEqual(len(images), 1); self.assertIn(f"/studies/{current.uid}/", images[0])
        finally:viewer.close()
        self.assertEqual(writes, [])
        for fixture in (current, related):self.assertEqual(self.report_rows(fixture), rows[fixture.uid])
        self.assertEqual(self.originals(), originals)

    def test_d03c_02_delayed_related_responses_cannot_reenter_after_return(self):
        """LATE/STALE: cancel owned metadata and invalidate related-report generations on return."""
        current, related = self.pair(); originals = self.originals()
        rows = {f.uid: self.report_rows(f) for f in (current, related)}
        page = self.login(); self.select(page, current); self.thumbnail_ready(page)
        reports, thumbnails, failed = [], [], []
        report_pattern = f"**/api/studies/{related.uid}/report/versions"
        thumb_pattern = f"**/dicom-web/studies/{related.uid}/instances"
        page.route(report_pattern, lambda route: reports.append(route))
        page.route(thumb_pattern, lambda route: thumbnails.append(route))
        self.addCleanup(page.unroute, report_pattern); self.addCleanup(page.unroute, thumb_pattern)
        page.on("requestfailed", lambda r: failed.append(r.url) if f"/studies/{related.uid}/instances" in r.url else None)
        writes = self.source_writes(page)
        self.related(page, related).click(); page.wait_for_timeout(100)
        self.assertEqual(len(reports), 1); self.assertEqual(len(thumbnails), 1)
        self.return_with_thumbnail(page, current)
        self.assertTrue(failed, "Return must cancel this fixture's pending thumbnail request")
        reply = thumbnails[0].fetch(); self.assertEqual(reply.status, 200); thumbnails[0].fulfill(response=reply)
        page.unroute(thumb_pattern)
        reply = reports[0].fetch(); self.assertEqual(reply.status, 200); reports[0].fulfill(response=reply)
        page.wait_for_timeout(150)
        expect(page.locator("#prior-findings")).to_have_text("")
        expect(page.locator("#prior-report-meta")).to_have_text("")
        expect(page.locator("#clinical")).to_contain_text("D03A current")
        self.related(page, related).click(); page.wait_for_timeout(100)
        self.return_with_thumbnail(page, current)
        self.related(page, related).click(); page.wait_for_timeout(100)
        self.assertEqual(len(reports), 3)
        reply = reports[2].fetch(); reports[2].fulfill(response=reply)
        expect(page.locator("#prior-findings")).to_have_text(related.secret)
        reply = reports[1].fetch(); stale = reply.json(); stale[0]["findings"] = "D03C old generation"
        reports[1].fulfill(response=reply, json=stale); page.wait_for_timeout(150)
        expect(page.locator("#prior-findings")).to_have_text(related.secret)
        expect(page.locator("#prior-report-meta")).to_contain_text("이후 · ")
        self.assertEqual(writes, [])
        for fixture in (current, related):self.assertEqual(self.report_rows(fixture), rows[fixture.uid])
        self.assertEqual(self.originals(), originals)

    def test_d03c_03_keyboard_return_keeps_input_hold_and_disabled_guards(self):
        """INPUT/LOSS: the viewing action does not reload dirty fields or release their existing owner."""
        current, related = self.pair(); originals = self.originals()
        page = self.login(); expect(page.locator("#related-return")).to_be_disabled()
        self.select(page, current); expect(page.locator("#related-return")).to_be_disabled()
        self.related(page, related).click()
        expect(page.locator("#prior-findings")).to_have_text(related.secret)
        values = dict(findings="D03C newly typed findings", conclusion="D03C newly typed conclusion",
                      recommendation="D03C newly typed recommendation")
        for name,value in values.items():page.locator("#" + name).fill(value)
        self.wait_state(page, current, lambda s: s.get("holder") == self.stack.actor("doctor"))
        rows = {f.uid: self.report_rows(f) for f in (current, related)}
        requests = []; page.on("request", lambda r: requests.append((r.method,r.url)) if "/api/studies/" in r.url else None)
        folder = previous.previous.base.Path(__file__).parent / "artifacts"; folder.mkdir(exist_ok=True)
        page.set_viewport_size(dict(width=900,height=600))
        expect(page.locator("#related-return")).to_be_in_viewport(ratio=1)
        page.screenshot(path=str(folder / "d03c-return-900x600.png"))
        page.locator("#related-return").focus(); page.locator("#related-return").press("Enter")
        expect(page.locator("#related-current")).to_be_focused()
        expect(page.locator("#related-return")).to_be_disabled()
        expect(page.locator("#clinical")).to_contain_text("D03A current")
        for name,value in values.items():expect(page.locator("#" + name)).to_have_value(value)
        self.assertEqual(self.state(current)["holder"], self.stack.actor("doctor"))
        # Routine autosave may independently persist these freshly typed fields; return must not commit/release.
        self.assertFalse(any(method in ("POST","PATCH","DELETE") for method,url in requests))
        after = self.report_rows(current)
        for table in ("Report","ReportVersion"):self.assertEqual(after[table], rows[current.uid][table])
        for row in after["ReportDraft"]:
            saved = json.loads(row)
            for name,value in values.items():self.assertEqual(saved[name],value)
        self.assertEqual(self.report_rows(related),rows[related.uid])
        page.set_viewport_size(dict(width=900,height=1200))
        expect(page.locator("#related-return")).to_be_in_viewport(ratio=1)
        page.screenshot(path=str(folder / "d03c-return-900x1200.png"))
        self.related(page, related).click(); expect(page.locator("#related-return")).to_be_enabled()
        def missing_current(route):
            response = route.fetch(); data = response.json()
            data["studies"] = [s for s in data["studies"] if s["uid"] != current.uid]
            data["pagination"]["total"] = len(data["studies"])
            route.fulfill(response=response,json=data)
        page.route("**/api/studies?*",missing_current); self.addCleanup(page.unroute,"**/api/studies?*")
        self.refresh(page)
        expect(page.locator("#related-current")).to_have_text("판독 대상을 선택하세요")
        expect(page.locator("#related-return")).to_be_disabled()
        before = page.locator("#clinical").inner_text()
        page.locator("#related-return").dispatch_event("click")
        self.assertEqual(page.locator("#clinical").inner_text(), before)
        self.assertEqual(self.originals(), originals)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ReturnToCurrentE2E(name) for name in loader.getTestCaseNames(ReturnToCurrentE2E)
                              if name.startswith("test_d03c_"))


if __name__ == "__main__":unittest.main(verbosity=2)
