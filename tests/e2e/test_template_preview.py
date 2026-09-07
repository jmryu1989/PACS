"""D09B real personal-template search, text preview and guarded insertion.

Run separately: python tests/e2e/test_template_preview.py
"""
from __future__ import annotations

import unittest
import uuid

from playwright.sync_api import expect
import test_template_preservation as previous


class TemplatePreviewE2E(previous.TemplatePreservationE2E):
    def preview(self, page, template, keyboard=False):
        button = page.locator("#tplrows").get_by_role("button", name="상용구 미리보기: " + template["title"], exact=True)
        if keyboard:
            button.focus()
            button.press("Enter")
        else:
            button.click()
        expect(page.locator("#tpl-preview")).to_be_visible()

    def report_values(self, page):
        return {key: page.locator("#" + key).input_value() for key in ("findings", "conclusion", "recommendation")}

    def test_d09b_01_search_fields_literal_terms_clear_and_modality(self):
        """FIND/FILTER: local AND search composes with the current-modality checkbox."""
        prefix = "D09B-" + uuid.uuid4().hex[:8]
        ct = self.template(title=prefix + " Alpha [a.*]", modality="CT", bodypart="Chest")
        mr = self.template(title=prefix + " Beta", modality="MR", bodypart="BRAIN")
        general = self.template(title=prefix + " General", modality="", bodypart="Chest")
        originals = {t["id"]: self.saved_template(t["id"]) for t in (ct, mr, general)}
        fixture = self.fixture()
        page = self.login()
        self.select(page, fixture)
        rows_before = self.report_rows(fixture)
        writes = []
        page.on("request", lambda r: writes.append(r.url) if r.method in ("POST", "PUT", "PATCH", "DELETE")
                and ("/templates" in r.url or "/report" in r.url or "/draft" in r.url or r.url.endswith("/hold")) else None)
        search = page.locator("#tpl-search")
        search.fill(prefix)
        expect(page.locator("#tplrows tr[data-i]")).to_have_count(2)
        expect(page.locator("#tplrows").get_by_text(mr["title"], exact=True)).to_have_count(0)
        page.locator("#t-mod").uncheck()
        expect(page.locator("#tplrows tr[data-i]")).to_have_count(3)
        for query, title in [("  ALPHA   chest  ", ct["title"]), ("[a.*]", ct["title"]),
                             (mr["shortcut"].upper(), mr["title"]), (prefix + " BRAIN", mr["title"]),
                             (prefix + " MR", mr["title"])]:
            search.fill(query)
            expect(page.locator("#tplrows tr[data-i]")).to_have_count(1)
            expect(page.locator("#tplrows").get_by_text(title, exact=True)).to_be_visible()
        page.locator("#t-mod").check()
        expect(page.locator("#tplrows tr[data-i]")).to_have_count(0)
        expect(page.locator("#tplrows")).to_contain_text("조건에 맞는 상용구가 없습니다")
        search.fill("no result " + uuid.uuid4().hex)
        page.locator("#tpl-search-clear").click()
        expect(search).to_have_value("")
        expect(search).to_be_focused()
        expect(page.locator("#tplrows").get_by_text(ct["title"], exact=True)).to_be_visible()
        expect(page.locator("#tplrows").get_by_text(general["title"], exact=True)).to_be_visible()
        self.assertEqual(writes, [])
        self.assertEqual(self.report_rows(fixture), rows_before)
        self.assertEqual({key: self.saved_template(key) for key in originals}, originals)

    def test_d09b_02_preview_text_keyboard_short_window_and_no_write(self):
        """PREVIEW/TEXT: opening and closing the modal never edits a report or executes text."""
        template = self.template(title="D09B <img src=x onerror=window.d09bBad=1> " + uuid.uuid4().hex[:8],
                                 findings="\n".join("Synthetic line " + str(n) for n in range(35)),
                                 conclusion="", recommendation="<script>window.d09bBad=1</script>\nSecond line")
        fixture = self.fixture()
        self.seed_report(fixture)
        page = self.login()
        self.select(page, fixture)
        page.set_viewport_size({"width": 900, "height": 600})
        before = self.report_rows(fixture)
        values = self.report_values(page)
        self.preview(page, template, keyboard=True)
        expect(page.locator("#tpl-preview-title")).to_contain_text(template["title"])
        expect(page.locator("#tpl-preview-meta")).to_contain_text(template["bodypart"])
        expect(page.locator("#tpl-preview-target")).to_contain_text(fixture.patient_id)
        expect(page.locator("#tpl-preview-findings")).to_have_text(template["findings"])
        expect(page.locator("#tpl-preview-conclusion")).to_have_text("(내용 없음)")
        expect(page.locator("#tpl-preview-recommendation")).to_have_text(template["recommendation"])
        expect(page.locator("#tpl-preview img, #tpl-preview script")).to_have_count(0)
        self.assertIsNone(page.evaluate("window.d09bBad"))
        page.locator("#tpl-preview-close").focus()
        page.keyboard.press("Shift+Tab")
        content = page.locator("#tpl-preview .tpl-preview-body")
        expect(content).to_be_focused()
        content.press("End")
        expect(content).not_to_have_js_property("scrollTop", 0)
        expect(page.locator("#tpl-preview-recommendation")).to_be_in_viewport()
        for selector in ("#tpl-preview-target", "#tpl-preview-close", "#tpl-preview-insert"):
            expect(page.locator(selector)).to_be_in_viewport()
        folder = previous.base.Path(__file__).parent / "artifacts"
        folder.mkdir(exist_ok=True)
        page.screenshot(path=str(folder / "D09B-template-preview.png"))
        page.keyboard.press("Tab")
        expect(page.locator("#tpl-preview-close")).to_be_focused()
        page.keyboard.press("Tab")
        expect(page.locator("#tpl-preview-insert")).to_be_focused()
        page.keyboard.press("Tab")
        expect(content).to_be_focused()
        page.keyboard.press("Escape")
        expect(page.locator("#tpl-preview")).to_be_hidden()
        self.assertEqual(self.report_values(page), values)
        self.assertEqual(self.report_rows(fixture), before)
        self.assertEqual(self.saved_template(template["id"]), template)

    def test_d09b_03_preview_current_draft_prior_and_selection_invalidation(self):
        """TARGET/WRONGREPORT: insert what was previewed into current, then invalidate on A-B-A."""
        patient = "D09B-" + uuid.uuid4().hex[:16]
        current, prior = self.fixture(patient_id=patient), self.fixture(patient_id=patient)
        self.seed_report(current)
        self.seed_report(prior, action="approve")
        template = self.template()
        current_rows, prior_rows = self.report_rows(current), self.report_rows(prior)
        page = self.login()
        self.select(page, current)
        page.locator(f'#relrows tr[data-uid="{prior.uid}"]').click()
        expect(page.locator("#prior-findings")).to_contain_text(prior.secret)
        self.preview(page, template)
        expect(page.locator("#tpl-preview-target")).to_have_attribute("data-uid", current.uid)
        with page.expect_response(lambda r: r.request.method == "POST" and r.url.endswith(f"/studies/{current.uid}/hold")) as hold:
            page.locator("#tpl-preview-insert").click()
        self.assertEqual(hold.value.status, 201)
        expect(page.locator("#tpl-preview")).to_be_hidden()
        expected = {"findings": current.secret + "\n" + template["findings"],
                    "conclusion": "E2E conclusion\n" + template["conclusion"], "recommendation": template["recommendation"]}
        self.assertEqual(self.report_values(page), expected)
        self.select(page, prior)
        self.wait_state(page, current, lambda s: (s.get("draft") or {}).get("recommendation") == expected["recommendation"])
        self.select(page, current)
        self.assertEqual(self.report_values(page), expected)
        self.preview(page, template)
        # Explicit selection events represent navigation arriving while a modal is open.
        # They exercise the real row/select handlers without changing application variables.
        page.locator(f'#rows tr[data-uid="{prior.uid}"]').dispatch_event("click")
        page.locator(f'#rows tr[data-uid="{current.uid}"]').dispatch_event("click")
        expect(page.locator("#tpl-preview")).to_be_hidden()
        expect(page.locator("#tpl-preview-insert")).to_be_disabled()
        page.locator("#tpl-preview-insert").dispatch_event("click")
        self.assertEqual(self.report_values(page), expected)
        for table in ("Report", "ReportVersion"):
            self.assertEqual(self.report_rows(current)[table], current_rows[table])
        self.assertEqual(self.report_rows(prior), prior_rows)
        self.assertIsNone(self.state(current, "doctor2").get("draft"))

    def test_d09b_04_preview_guards_and_empty_content_feedback(self):
        """GUARD/LOCK: the new button shares filming/hold/P and empty-content rejection."""
        full = self.template()
        empty = self.template(findings="", conclusion="", recommendation="")
        filming, held, preliminary, normal = (self.fixture() for _ in range(4))
        self.patch(filming, ss="Unverified", em="N")
        self.assertEqual(self.stack.request("POST", f"/studies/{held.uid}/hold", "doctor2").status, 201)
        response = self.stack.request("POST", f"/studies/{preliminary.uid}/report/commit", "doctor2", {
            "action": "preliminary", "baseVersion": 0, "reviewer": self.stack.actor("jmryu"),
            "findings": preliminary.secret, "conclusion": "Private P", "recommendation": "Private recommendation"})
        self.assertEqual(response.status, 201)
        page = self.login()
        self.preview(page, full)
        expect(page.locator("#tpl-preview-insert")).to_be_disabled()
        expect(page.locator("#tpl-preview-status")).to_contain_text("검사를 선택하세요")
        page.locator("#tpl-preview-close").click()
        for fixture in (filming, held, preliminary):
            self.select(page, fixture)
            expect(page.locator("#findings")).to_have_js_property("readOnly", True)
            before, values = self.report_rows(fixture), self.report_values(page)
            self.preview(page, full)
            expect(page.locator("#tpl-preview-insert")).to_be_disabled()
            # Disabled styling cannot be the only gate: invoke the click handler as well.
            page.locator("#tpl-preview-insert").dispatch_event("click")
            page.locator("#tpl-preview-close").click()
            self.assertEqual(self.report_rows(fixture), before)
            self.assertEqual(self.report_values(page), values)
        self.select(page, normal)
        before, values = self.report_rows(normal), self.report_values(page)
        self.preview(page, empty)
        expect(page.locator("#tpl-preview-status")).to_have_text("삽입할 내용이 없습니다")
        expect(page.locator("#tpl-preview-insert")).to_be_disabled()
        page.locator("#tpl-preview-close").click()
        page.locator("#tplrows").get_by_text(empty["title"], exact=True).dblclick()
        expect(page.locator("#toast")).to_contain_text("삽입할 내용이 없습니다")
        self.assertEqual(self.report_rows(normal), before)
        self.assertEqual(self.report_values(page), values)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(TemplatePreviewE2E(name) for name in loader.getTestCaseNames(TemplatePreviewE2E)
                              if name.startswith("test_d09b_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
