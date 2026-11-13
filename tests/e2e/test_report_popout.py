"""The report pop-up window on the real stack: Pop Out, typing saved as the draft, Pin, a real approval and Dock.

Real BFF, API, database and two synthetic studies of one patient. The reader opens the first, presses Pop Out (Chromium's
Document Picture-in-Picture window, a second page of the context), types Findings and Conclusion there and waits for the
page's draft autosave to store them; turns Pin on and presses Approve in the window: the server approves that text (RS A,
a new version), the selection goes to the second study and the window stays with that study's empty editor. Dock puts the
editor back in its place. The refused/unknown/last-study cases, Pin off, the in-page box and Clinical Info Copy/Paste are
page cases in tests/report_popout_dom_test.py.

Run in CI: `python tests/measurement_ci.py --profile report-window` (Focused integration, dispatch only); on a development
stack: `python tests/e2e/test_report_popout.py`.
"""
from __future__ import annotations

import re
import sys
import unittest
import uuid

from playwright.sync_api import expect
from test_template_preservation import TemplatePreservationE2E

FINDINGS = "SYN POP-OUT FINDINGS typed in the report window"
CONCLUSION = "SYN POP-OUT CONCLUSION"


class ReportPopoutE2E(TemplatePreservationE2E):
    def test_report_popout_01_window_typing_draft_pin_approve_next_and_dock(self):
        patient = "POP-" + uuid.uuid4().hex[:16]
        studies = [self.fixture(patient_id=patient) for _ in range(2)]
        by_uid = {fixture.uid: fixture for fixture in studies}
        page = self.login()
        page.locator('#filterrow [data-f="id"]').fill(patient)
        rows = page.locator("#rows tr[data-uid]")
        expect(rows).to_have_count(2)
        order = [row.get_attribute("data-uid") for row in rows.all()]
        first, second = by_uid[order[0]], by_uid[order[1]]
        row = page.locator(f'#rows tr[data-uid="{first.uid}"]')
        row.click()
        expect(row).to_have_class(re.compile(r"\bsel\b"))
        expect(page.locator("#findings")).to_be_editable()

        with page.context.expect_page() as opened:
            page.locator("#report-popout").click()
        window = opened.value
        expect(window.locator("#findings")).to_be_visible()
        expect(page.locator(".report-window-place")).to_contain_text("Report is open in a pop-up window")
        self.assertIsNone(page.evaluate("() => document.getElementById('findings')"), "the editor moved, not copied")

        # Typing in the window is the page's own edit: the autosave stores it as this reader's draft.
        with page.expect_response(lambda r: r.request.method == "PUT" and r.url.endswith(f"/studies/{first.uid}/report")
                                  and FINDINGS in (r.request.post_data or ""), timeout=45000) as saved:
            window.locator("#findings").fill(FINDINGS)
            window.locator("#conclusion").fill(CONCLUSION)
        self.assertEqual(saved.value.status, 200)

        window.locator("#report-window-pin").click()
        expect(window.locator("#report-window-pin")).to_have_attribute("aria-pressed", "true")
        with page.expect_response(lambda r: r.request.method == "POST"
                                  and r.url.endswith(f"/studies/{first.uid}/report/commit")) as reply:
            window.locator("#report-window-approve").click()
        self.assertEqual(reply.value.status, 201)
        self.assertEqual(reply.value.json()["state"]["rs"], "A")
        version = self.versions(first)[-1]
        self.assertEqual((version["findings"], version["conclusion"]), (FINDINGS, CONCLUSION))
        self.assertEqual(self.state(first)["rs"], "A")
        # Pin on: the window stays and takes the next study.
        expect(page.locator(f'#rows tr[data-uid="{second.uid}"]')).to_have_class(re.compile(r"\bsel\b"))
        expect(window.locator("#findings")).to_have_value("")
        self.assertEqual(2, len(page.context.pages))

        window.locator("#report-window-dock").click()
        page.wait_for_function("() => !documentPictureInPicture.window")
        expect(page.locator(".report-compose #report-editor #findings")).to_be_visible()
        expect(page.locator(".report-window-place")).to_be_hidden()
        self.assertNotEqual(self.state(second)["rs"], "A")


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ReportPopoutE2E(name) for name in loader.getTestCaseNames(ReportPopoutE2E)
                              if name.startswith('test_report_popout_'))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
