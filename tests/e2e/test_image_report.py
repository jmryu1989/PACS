"""Image Report on the real stack: draw on the breast diagram, attach to the report draft, approve, and see the drawing of
that version in the print preview, the History and the clinician's report read.

Real BFF, API, database and signing, one synthetic study. The reader opens it, types Findings, opens Image Report, drags an
ellipse and places a Text label on the breast diagram, and presses Attach to Report (one draft write); Approve makes the
signed version that holds the drawing. The print preview (Print) shows it after Conclusion, History shows it on that
version, and the clinician's report read of the same study carries it. Window, marks, Text, backgrounds, saved images and
the view-only window are page cases in tests/image_report_dom_test.py; the draft and commit boundary is
tests/emr/d/image_report_pg_test.cjs.

Run in CI: `python tests/measurement_ci.py --profile image-report` (Focused integration, dispatch only); on a development
stack: `python tests/e2e/test_image_report.py`.
"""
from __future__ import annotations

import base64
import re
import sys
import unittest
import uuid

from playwright.sync_api import expect
from test_template_preservation import TemplatePreservationE2E

FINDINGS = "SYN IMAGE REPORT FINDINGS"
LABEL = "Mass 1.5 cm"


class ImageReportE2E(TemplatePreservationE2E):
    def drag(self, page, x0, y0, x1, y1):
        box = page.locator("#image-report-canvas").bounding_box()
        at = lambda fx, fy: (box["x"] + box["width"] * fx, box["y"] + box["height"] * fy)
        page.mouse.move(*at(x0, y0))
        page.mouse.down()
        for step in range(1, 6):
            page.mouse.move(*at(x0 + (x1 - x0) * step / 5, y0 + (y1 - y0) * step / 5))
        page.mouse.up()

    def test_image_report_01_draw_attach_approve_preview_history_and_clinician(self):
        patient = "IMG-" + uuid.uuid4().hex[:12]
        fixture = self.fixture(patient_id=patient)
        page = self.login()
        page.locator('#filterrow [data-f="id"]').fill(patient)
        row = page.locator(f'#rows tr[data-uid="{fixture.uid}"]')
        row.click()
        expect(row).to_have_class(re.compile(r"\bsel\b"))
        expect(page.locator("#findings")).to_be_editable()
        with page.expect_response(lambda r: r.request.method == "PUT" and r.url.endswith(f"/studies/{fixture.uid}/report")
                                  and FINDINGS in (r.request.post_data or ""), timeout=45000) as typed:
            page.locator("#findings").fill(FINDINGS)
        self.assertEqual(typed.value.status, 200)

        # Draw on the breast diagram and attach: one draft write carrying the drawing.
        page.locator("#report-image-report").click()
        dialog = page.locator("#image-report")
        expect(dialog).to_be_visible()
        expect(dialog.locator(".ir-study")).to_contain_text(patient)
        dialog.locator("label", has_text="Breast diagram").locator("input").check()
        dialog.locator("label", has_text="Ellipse").locator("input").check()
        self.drag(page, 0.62, 0.3, 0.74, 0.42)
        dialog.locator("label", has_text=re.compile(r"^\s*Text$")).locator("input").check()
        dialog.get_by_role("textbox", name="Text").fill(LABEL)
        box = page.locator("#image-report-canvas").bounding_box()
        page.mouse.click(box["x"] + box["width"] * 0.76, box["y"] + box["height"] * 0.36)
        with page.expect_response(lambda r: r.request.method == "PUT" and r.url.endswith(f"/studies/{fixture.uid}/report")
                                  and '"drawing"' in (r.request.post_data or "")) as attached:
            dialog.get_by_role("button", name="Attach to Report").click()
        self.assertEqual(attached.value.status, 200, attached.value.text()[:300])
        drawing_id = attached.value.json()["drawn"]["added"]
        expect(dialog.locator("#image-report-attached figure")).to_have_count(1)
        dialog.get_by_role("button", name="Close").click()
        expect(page.locator("#report-image-attached figure")).to_have_count(1)

        # Approve: the signed version holds the drawing.
        with page.expect_response(lambda r: r.request.method == "POST"
                                  and r.url.endswith(f"/studies/{fixture.uid}/report/commit")) as reply:
            page.locator("#b-approve").click()
        self.assertEqual(reply.value.status, 201, reply.value.text()[:300])
        version = self.versions(fixture)[-1]
        self.assertEqual(version["findings"], FINDINGS)
        self.assertEqual([d["id"] for d in version["drawings"]], [drawing_id])

        # History: the version shows its drawing.
        self.open_toolbar_group(page, "#b-history")
        page.locator("#b-history").click()
        picture = page.locator(f'#hist-body img[data-drawing="{drawing_id}"]')
        expect(picture).to_have_attribute("src", re.compile(r"^blob:"))
        page.locator("#hist-close").click()

        # Print preview: the drawing right after Conclusion.
        self.open_toolbar_group(page, "#b-print")
        page.locator("#b-print").click()
        paper = page.frame_locator("#report-preview iframe")
        expect(paper.locator("section.drawings h2")).to_contain_text("Image Report")
        expect(paper.locator("section.drawings img")).to_have_count(1)
        expect(paper.locator("section.drawings img")).to_have_attribute("src", re.compile(r"^blob:"))

        page.keyboard.press("Escape")
        expect(page.locator("#report-preview")).to_be_hidden()
        # The clinician's report read of the same study carries the drawing of that version.
        self.stack.create_test_identity("img-clinician", ["clinician"], "hallym")
        read = self.stack.request("GET", f"/clinician/studies/{fixture.uid}/report", "img-clinician")
        self.assertEqual(read.status, 200, str(read.body)[:300])
        self.assertEqual([d["id"] for d in read.body["drawings"]], [drawing_id])
        self.assertTrue(base64.b64decode(read.body["drawings"][0]["png"]).startswith(b"\x89PNG"))

        # An amendment that only removes the drawing: the text is unchanged, Approve is the amendment, the version before
        # it keeps the drawing.
        page.locator("#report-image-report").click()
        expect(dialog.locator("#image-report-attached figure")).to_have_count(1)
        # The approved report is mine and inside its amendment window: the window takes edits (it says why when it does not).
        expect(dialog.locator("#image-report-readonly")).to_have_text("")
        try:
            with page.expect_response(lambda r: r.request.method == "PUT" and r.url.endswith(f"/studies/{fixture.uid}/report")
                                      and '"removeDrawing"' in (r.request.post_data or "")) as removed:
                dialog.locator(f'#image-report-attached button[data-drawing="{drawing_id}"]').click()
        except Exception as error:
            raise AssertionError("Remove sent no draft write; the window says %r" % dialog.locator("#image-report-status").text_content()) from error
        self.assertEqual(removed.value.status, 200, removed.value.text()[:300])
        expect(dialog.locator("#image-report-attached figure")).to_have_count(0)
        dialog.get_by_role("button", name="Close").click()
        expect(page.locator("#b-approve")).to_be_enabled()
        with page.expect_response(lambda r: r.request.method == "POST"
                                  and r.url.endswith(f"/studies/{fixture.uid}/report/commit")) as amended:
            page.locator("#b-approve").click()
        self.assertEqual(amended.value.status, 201, amended.value.text()[:300])
        rows = self.versions(fixture)
        self.assertEqual((rows[-1]["action"], rows[-1]["findings"], rows[-1].get("drawings")), ("amend", FINDINGS, None))
        self.assertEqual([d["id"] for d in rows[-2]["drawings"]], [drawing_id])

def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ImageReportE2E(name) for name in loader.getTestCaseNames(ImageReportE2E)
                              if name.startswith('test_image_report_'))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
