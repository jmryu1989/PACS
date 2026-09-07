"""D09A: real personal template editing and insertion into the current private draft.

Run separately from B2: python tests/e2e/test_template_preservation.py
"""
from __future__ import annotations

import hashlib
import unittest
import uuid

from playwright.sync_api import expect
import test_worklist as base


class TemplatePreservationE2E(base.WorklistE2E):
    def fixture(self, **kwargs):
        fixture = super().fixture(**kwargs)
        rows = self.stack._orthanc_request("POST", "/tools/lookup", fixture.uid.encode("ascii")).body
        study_id = next(row["ID"] for row in rows if row["Type"] == "Study")
        instances = self.stack._orthanc_request("GET", f"/studies/{study_id}/instances").body
        originals = {"/instances/" + row["ID"] + "/file": None for row in instances}
        for path in originals:
            originals[path] = hashlib.sha256(self.stack.orthanc_bytes(path)).hexdigest()
        self.addCleanup(self.check_originals, originals)
        return fixture

    def check_originals(self, originals):
        for path, digest in originals.items():
            self.assertEqual(hashlib.sha256(self.stack.orthanc_bytes(path)).hexdigest(), digest)

    def template(self, **changes):
        body = dict(title="D09A-" + uuid.uuid4().hex[:12], shortcut="d09" + uuid.uuid4().hex[:8],
                    modality="", bodypart="BRAIN", findings="Template findings\nsecond line",
                    conclusion="Template conclusion", recommendation="Template recommendation\nnext line", ord=73)
        body.update(changes)
        response = self.stack.request("POST", "/templates", "doctor", body)
        self.assertEqual(response.status, 201)
        self.addCleanup(self.remove_template, response.body["id"])
        return response.body

    def remove_template(self, template_id):
        self.assertEqual(self.stack.request("DELETE", f"/templates/{template_id}", "doctor").status, 200)

    def saved_template(self, template_id, actor="doctor"):
        response = self.stack.request("GET", "/prefs", actor)
        self.assertEqual(response.status, 200)
        return next((t for t in response.body["templates"] if t["id"] == template_id), None)

    def edit(self, page, title):
        page.locator("#tplrows").get_by_text(title, exact=True).click(button="right")
        page.locator("#ctx").get_by_text("수정", exact=True).click()
        expect(page.locator("#tplmodal")).to_be_visible()

    def save(self, page):
        with page.expect_response(lambda r: r.request.method == "POST" and r.url.endswith("/templates")) as reply:
            page.locator("#tpl-save").click()
        self.assertEqual(reply.value.status, 201)
        expect(page.locator("#tplmodal")).to_be_hidden()
        return reply.value.json()

    def report_rows(self, fixture):
        # Includes all authors' drafts and immutable versions, without leaking their text into logs.
        return {table: base.psql(f'SELECT to_jsonb(t)::text FROM "{table}" t WHERE uid=\'{fixture.uid}\' ORDER BY to_jsonb(t)::text;')
                for table in ("Report", "ReportDraft", "ReportVersion")}

    def test_d09a_01_edit_preserves_fields_cancel_failure_and_clear(self):
        """EDIT/LOSS: editing a title must round-trip existing fields and order."""
        original = self.template()
        page = self.login()
        page.locator("#quick").fill("D09A-NO-STUDY-" + uuid.uuid4().hex[:12])
        self.edit(page, original["title"])
        # A short window must keep both the scrolling fields and Save/Cancel reachable.
        page.set_viewport_size({"width": 900, "height": 600})
        expect(page.locator("#tpl-b")).to_have_value(original["bodypart"])
        expect(page.locator("#tpl-r")).to_have_value(original["recommendation"])
        page.locator("#tpl-t").fill(original["title"] + " edited")
        expect(page.locator("#tpl-save")).to_be_in_viewport()
        page.locator("#tpl-r").scroll_into_view_if_needed()
        folder = base.Path(__file__).parent / "artifacts"
        folder.mkdir(exist_ok=True)
        page.screenshot(path=str(folder / "D09A-template-edit.png"))
        self.save(page)
        expected = dict(original, title=original["title"] + " edited")
        self.assertEqual(self.saved_template(original["id"]), expected)
        fresh = self.login()
        self.edit(fresh, expected["title"])
        expect(fresh.locator("#tpl-b")).to_have_value(expected["bodypart"])
        expect(fresh.locator("#tpl-r")).to_have_value(expected["recommendation"])
        fresh.locator("#tpl-b").fill("CANCELLED")
        fresh.locator("#tpl-r").fill("Cancelled\ntext")
        fresh.locator("#tpl-cancel").click()
        self.assertEqual(self.saved_template(original["id"]), expected)
        self.edit(fresh, expected["title"])
        fresh.locator("#tpl-r").fill("Retry\nretained")
        fresh.route("**/api/templates", lambda route: route.fulfill(status=503, content_type="application/json", body='{"message":"Synthetic unavailable"}'))
        try:
            fresh.locator("#tpl-save").click()
            expect(fresh.locator("#toast")).to_contain_text("상용구 저장 실패")
            expect(fresh.locator("#tplmodal")).to_be_visible()
            expect(fresh.locator("#tpl-r")).to_have_value("Retry\nretained")
            self.assertEqual(self.saved_template(original["id"]), expected)
        finally:
            fresh.unroute("**/api/templates")
        self.save(fresh)
        expected["recommendation"] = "Retry\nretained"
        self.assertEqual(self.saved_template(original["id"]), expected)
        self.edit(fresh, expected["title"])
        fresh.locator("#tpl-b").fill("")
        fresh.locator("#tpl-r").fill("")
        self.save(fresh)
        self.assertEqual(self.saved_template(original["id"]), dict(expected, bodypart="", recommendation=""))

    def test_d09a_02_three_fields_current_draft_hold_and_empty(self):
        """INSERT/WRONGREPORT: related preview never becomes the insertion/commit target."""
        patient = "D09A-" + uuid.uuid4().hex[:16]
        current, prior = self.fixture(patient_id=patient), self.fixture(patient_id=patient)
        other = self.fixture()
        self.seed_report(current)
        self.seed_report(prior, action="approve")
        full = self.template()
        empty = self.template(findings="", conclusion="", recommendation="")
        prior_rows = self.report_rows(prior)
        current_rows = self.report_rows(current)
        page = self.login()
        self.select(page, current)
        page.locator(f'#relrows tr[data-uid="{prior.uid}"]').click()
        expect(page.locator("#prior-findings")).to_contain_text(prior.secret)
        commits = []
        # Observe actual requests; double-click is a draft edit, never a report commit.
        page.on("request", lambda r: commits.append(r.url) if "/report/commit" in r.url else None)
        with page.expect_response(lambda r: r.request.method == "POST" and r.url.endswith(f"/studies/{current.uid}/hold")) as hold:
            page.locator("#tplrows").get_by_text(full["title"], exact=True).dblclick()
        self.assertEqual(hold.value.status, 201)
        self.assertEqual(self.state(current)["holder"], self.stack.actor("doctor"))
        values = {"findings": current.secret + "\n" + full["findings"],
                  "conclusion": "E2E conclusion\n" + full["conclusion"], "recommendation": full["recommendation"]}
        for key, value in values.items():
            expect(page.locator("#" + key)).to_have_value(value)
        page.locator("#tplrows").get_by_text(empty["title"], exact=True).dblclick()
        for key, value in values.items():
            expect(page.locator("#" + key)).to_have_value(value)
        self.select(page, other)
        self.wait_state(page, current, lambda s: (s.get("draft") or {}).get("recommendation") == values["recommendation"])
        self.select(page, current)
        for key, value in values.items():
            expect(page.locator("#" + key)).to_have_value(value)
        self.assertIsNone(self.state(current, "doctor2").get("draft"))
        for table in ("Report", "ReportVersion"):
            self.assertEqual(self.report_rows(current)[table], current_rows[table])
        self.assertEqual(self.report_rows(prior), prior_rows)
        self.assertEqual(commits, [])

    def test_d09a_03_create_recommendation_shortcut_and_owner(self):
        """SHORTCUT/MIX: new multiline Recommendation expands only at its own caret."""
        fixture = self.fixture()
        self.seed_report(fixture)
        anchor = self.template(ord=73)
        page = self.login()
        self.select(page, fixture)
        page.locator("#tplrows").get_by_text(anchor["title"], exact=True).click(button="right")
        page.locator("#ctx").get_by_text("＋ 새 상용구", exact=True).click()
        title = "D09A <img src=x onerror=window.d09aBad=1> " + uuid.uuid4().hex[:8]
        shortcut = "new" + uuid.uuid4().hex[:8]
        for selector, value in {"#tpl-t": title, "#tpl-s": shortcut, "#tpl-b": "CHEST", "#tpl-f": "new findings",
                                "#tpl-c": "new conclusion", "#tpl-r": "First recommendation\nSecond line"}.items():
            page.locator(selector).fill(value)
        saved = self.save(page)
        self.addCleanup(self.remove_template, saved["id"])
        self.assertGreater(saved["ord"], anchor["ord"])
        self.assertEqual(saved["bodypart"], "CHEST")
        self.assertIsNone(self.saved_template(saved["id"], "doctor2"))
        expect(page.locator("#tplrows img")).to_have_count(0)
        self.assertIsNone(page.evaluate("window.d09aBad"))
        recommendation = page.locator("#recommendation")
        recommendation.fill("before " + shortcut + " after")
        recommendation.press("Home")
        for _ in range(len("before " + shortcut)):
            recommendation.press("ArrowRight")
        recommendation.press("Tab")
        expect(recommendation).to_have_value("before First recommendation\nSecond line after")
        expect(page.locator("#findings")).to_have_value(fixture.secret)
        expect(page.locator("#conclusion")).to_have_value("E2E conclusion")
        fresh = self.login()
        self.edit(fresh, title)
        expect(fresh.locator("#tpl-r")).to_have_value(saved["recommendation"])
        fresh.locator("#tpl-cancel").click()
        other = self.login("doctor2")
        expect(other.locator("#tplrows").get_by_text(title, exact=True)).to_have_count(0)

    def test_d09a_04_insertion_respects_filming_holder_and_hidden_prelim(self):
        """GUARD/LOCK: programmatic insertion cannot bypass readonly report fields."""
        template = self.template()
        filming, held, preliminary = self.fixture(), self.fixture(), self.fixture()
        self.patch(filming, ss="Unverified", em="N")
        self.assertEqual(self.stack.request("POST", f"/studies/{held.uid}/hold", "doctor2").status, 201)
        result = self.stack.request("POST", f"/studies/{preliminary.uid}/report/commit", "doctor2", {
            "action": "preliminary", "baseVersion": 0, "reviewer": self.stack.actor("jmryu"),
            "findings": preliminary.secret, "conclusion": "Private P", "recommendation": "Private recommendation"})
        self.assertEqual(result.status, 201)
        page = self.login()
        for fixture in (filming, held, preliminary):
            with self.subTest(case=fixture.uid):
                self.select(page, fixture)
                expect(page.locator("#findings")).to_have_js_property("readOnly", True)
                rows = self.report_rows(fixture)
                before = {key: page.locator("#" + key).input_value() for key in ("findings", "conclusion", "recommendation")}
                page.locator("#tplrows").get_by_text(template["title"], exact=True).dblclick()
                for key, value in before.items():
                    expect(page.locator("#" + key)).to_have_value(value)
                self.assertEqual(self.report_rows(fixture), rows)
        tech = self.login("tech")
        self.select(tech, filming)
        expect(tech.locator("#findings")).to_have_js_property("readOnly", True)
        expect(tech.locator("#tplrows tr[data-i]")).to_have_count(0)
        tech.locator('[data-tab="Technician"]').click()
        expect(tech.locator(".s-template")).to_be_hidden()
        expect(tech.locator(".report-p")).to_be_hidden()


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(TemplatePreservationE2E(name) for name in loader.getTestCaseNames(TemplatePreservationE2E)
                              if name.startswith("test_d09a_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
