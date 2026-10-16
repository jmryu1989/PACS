"""W4-PAGE-04/05/12 -> RISK-FIRST-ROW-JUMP / RISK-HIDDEN-RECOMMENDATION -> TEST-W4-FLOW (candidate FLOW, live).

Real BFF, API, database and three synthetic studies of one patient. The reader narrows the list to them, filters RS=W,
opens the middle study, inserts a personal template whose Recommendation has no field on screen, reads it in the
read-only notice and presses Approve & Next: the approval carries the three fields, the approved study leaves the W
filter and the selection goes to the row after it - not the first row. Reopening the approved study shows the
notice again. The detailed outcomes (refused, unknown, A -> B -> A, composition) are page cases in
tests/report_flow_dom_test.py.
"""
from __future__ import annotations

import re
import sys
import unittest
import uuid

from playwright.sync_api import expect
from test_template_preservation import TemplatePreservationE2E

RECOMMENDATION = "SYN W4 RECOMMENDATION follow-up in 3 months"


class W4ReportFlowE2E(TemplatePreservationE2E):
    def test_w4_01_approve_next_anchor_recommendation_roundtrip(self):
        patient = "W4-" + uuid.uuid4().hex[:16]
        studies = [self.fixture(patient_id=patient) for _ in range(3)]
        by_uid = {fixture.uid: fixture for fixture in studies}
        template = self.template(findings="SYN W4 FINDINGS", conclusion="SYN W4 CONCLUSION", recommendation=RECOMMENDATION)
        page = self.login()
        page.locator("#quick").fill(patient)
        rows = page.locator("#rows tr[data-uid]")
        expect(rows).to_have_count(3)
        page.select_option("#filterrow [data-f=rs]", "W")
        expect(rows).to_have_count(3)
        order = [row.get_attribute("data-uid") for row in rows.all()]
        middle, after = by_uid[order[1]], by_uid[order[2]]
        row = page.locator(f'#rows tr[data-uid="{middle.uid}"]')
        row.click()
        expect(row).to_have_class(re.compile(r"\bsel\b"))
        expect(page.locator("#recnote")).to_be_hidden()
        page.locator("#tpl-search").fill(template["title"])
        page.locator("#tplrows").get_by_text(template["title"], exact=True).dblclick()
        expect(page.locator("#findings")).to_have_value(re.compile("SYN W4 FINDINGS"))
        notice = page.locator("#recnote")
        expect(notice).to_be_visible()
        expect(notice.locator("summary")).to_have_text("Recommendation (existing value · read only)")
        notice.locator("summary").click()
        expect(page.locator("#recnote-text")).to_have_text(RECOMMENDATION)
        expected = page.locator("#findings").input_value()
        with page.expect_response(lambda r: r.request.method == "POST"
                                  and r.url.endswith(f"/studies/{middle.uid}/report/commit")) as reply:
            page.locator("#b-approve-next").click()
        self.assertEqual(reply.value.status, 201)
        self.assertEqual(reply.value.json()["state"]["rs"], "A")
        # The queue anchor: the row after the approved study, which has left the W filter.
        expect(page.locator(f'#rows tr[data-uid="{after.uid}"]')).to_have_class(re.compile(r"\bsel\b"))
        expect(page.locator(f'#rows tr[data-uid="{middle.uid}"]')).to_have_count(0)
        version = self.versions(middle)[-1]
        self.assertEqual((version["findings"], version["recommendation"]), (expected, RECOMMENDATION))
        self.assertEqual(self.state(middle)["rs"], "A")
        expect(notice).to_be_hidden()
        # Reopened (RS filter cleared): the approved report's hidden Recommendation is announced again.
        page.select_option("#filterrow [data-f=rs]", "")
        reopened = page.locator(f'#rows tr[data-uid="{middle.uid}"]')
        reopened.click()
        expect(reopened).to_have_class(re.compile(r"\bsel\b"))
        expect(notice).to_be_visible()
        notice.locator("summary").click()
        expect(page.locator("#recnote-text")).to_have_text(RECOMMENDATION)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
