"""W5-PAGE-01..09 / W5-API-02/03 -> RISK-RELATED-INSERT-LOST-OR-DOUBLED -> TEST-W5-FLOW (candidate FLOW, live).

Real BFF, API, database and two synthetic studies of one patient: the Source has an approved report, the Target a typed
private draft. The reader opens Related Report mode from the Related row (the typed Target is saved first), selects the
first line of the Source's Findings, confirms the exact insertion at the end of the Target's Findings, and the reply of
the PUT that wrote it is lost. The page keeps the operation Result Unknown (never Draft Saved); Retry resends the same ID
and the same body, and the server replays the applied receipt without a second insertion; the receipt query reads the
same receipt. Back returns to the editor at the insertion end, Approve commits the inserted text, and reopening the
study shows it once; the receipt stays applied but no longer matches the cleared draft. The Source's versions and every
original DICOM instance are unchanged. Page-level outcomes (refused, discard tombstone, superseded, ID_REUSED, logout,
both layouts) are cases in tests/related_report_mode_dom_test.py; restart and lock order are W5-API's PostgreSQL cases.
"""
from __future__ import annotations

import sys
import unittest
import uuid

from playwright.sync_api import expect
from test_template_preservation import TemplatePreservationE2E

TARGET_OWN = "SYN W5 TARGET typed before the Related Report"
SOURCE_LINE = "SYN W5 SOURCE FINDING ONE"
SOURCE_FINDINGS = SOURCE_LINE + "\nSYN W5 SOURCE FINDING TWO"
INSERTED = "\n" + SOURCE_LINE


class RelatedReportModeE2E(TemplatePreservationE2E):
    def draft(self, fixture, insert_request_id=None):
        path = f"/studies/{fixture.uid}/draft" + (f"?insertRequestId={insert_request_id}" if insert_request_id else "")
        result = self.stack.request("GET", path, "doctor")
        self.assertEqual(result.status, 200)
        return result.body

    def test_w5_01_prior_insert_loss_check_back_commit_reopen(self):
        patient = "W5-" + uuid.uuid4().hex[:16]
        target, source = self.fixture(patient_id=patient), self.fixture(patient_id=patient)
        self.seed_report(source, action="approve", findings=SOURCE_FINDINGS)
        source_versions = self.versions(source)
        page = self.login()
        if not page.locator(".left").is_visible():
            page.get_by_role("button", name="Worklist", exact=True).click()
        self.select(page, target)
        page.locator("#findings").fill(TARGET_OWN)

        # The first related PUT reaches the server and writes; its reply never reaches the page.
        sent, lost = [], []

        def related_put(route):
            request = route.request
            body = request.post_data_json if request.method == "PUT" and request.post_data else None
            if not isinstance(body, dict) or "relatedInsert" not in body:
                route.fallback()
                return
            sent.append(body)
            if not lost:
                lost.append(route.fetch().status)
                route.abort("connectionreset")
                return
            route.fallback()

        page.route(lambda url: url.endswith(f"/studies/{target.uid}/report"), related_put)

        # Entry: the typed Target is saved first (W4 move gate), then the mode shows the Source read-only.
        row = page.locator(f'#relrows tr[data-uid="{source.uid}"]')
        expect(row).to_be_visible()
        row.locator("td").first.click()
        mode = page.locator("#related-mode")
        expect(mode).to_be_visible()
        expect(page.locator("#related-mode-title")).to_be_focused()
        expect(page.locator("#findings")).to_be_hidden()
        source_text = page.locator('#related-mode [data-related-source="findings"]')
        expect(source_text).to_have_text(SOURCE_FINDINGS)
        self.assertEqual(page.evaluate("selectedUid"), target.uid)
        self.assertEqual(self.draft(target)["snapshot"]["findings"], TARGET_OWN)

        # The reader selects the Source's first line and confirms the exact insertion.
        source_text.evaluate("""(node, length) => {
            const range = document.createRange(); range.setStart(node.firstChild, 0); range.setEnd(node.firstChild, length);
            const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        }""", len(SOURCE_LINE))
        page.locator("#related-mode-insert").click()
        dialog = page.locator("#related-insert-dialog")
        expect(dialog).to_be_visible()
        self.assertEqual(page.locator("#related-insert-text").text_content(), INSERTED)
        page.locator("#related-insert-confirm").click()
        notice = page.locator("#report-notice")
        expect(notice).to_contain_text("Result Unknown")
        self.assertEqual((len(sent), len(lost)), (1, 1))
        self.assertEqual(lost[0], 200, "the server applied the first PUT")
        self.assertEqual(page.locator("#findings").input_value(), TARGET_OWN + INSERTED)
        operation = sent[0]["relatedInsert"]
        self.assertEqual((operation["source"]["uid"], operation["section"], operation["text"]),
                         (source.uid, "findings", INSERTED))

        # Retry: the same ID and the same body; the server replays the applied receipt and inserts nothing again.
        page.locator("#report-notice-retry").click()
        expect(notice).to_be_hidden()
        self.assertEqual(len(sent), 2)
        self.assertEqual(sent[1], sent[0])
        self.assertEqual(page.locator("#findings").input_value(), TARGET_OWN + INSERTED)
        checked = self.draft(target, operation["insertRequestId"])
        receipt = checked["relatedInsert"]
        self.assertEqual((receipt["result"], receipt["state"], receipt["currentMatches"]), ("applied", "applied", True))
        self.assertEqual(checked["snapshot"]["findings"], TARGET_OWN + INSERTED)

        # Back: the editor returns at the insertion end; Approve commits the inserted text once.
        page.locator("#related-mode-back").click()
        expect(mode).to_be_hidden()
        findings = page.locator("#findings")
        expect(findings).to_be_focused()
        end = len(TARGET_OWN + INSERTED)
        self.assertEqual(findings.evaluate("node => [node.selectionStart, node.selectionEnd]"), [end, end])
        self.commit(page, target, "#b-approve", "A")
        self.assertEqual(self.versions(target)[-1]["findings"], TARGET_OWN + INSERTED)
        after = self.draft(target, operation["insertRequestId"])["relatedInsert"]
        self.assertEqual((after["state"], after["currentMatches"]), ("applied", False))

        # Reopened: the approved report has the inserted line once; the Source is untouched.
        page.reload()
        page.wait_for_url("**/worklist/hpacs-lite/main.html")
        self.select(page, target)
        expect(page.locator("#findings")).to_have_value(TARGET_OWN + INSERTED)
        self.assertEqual(self.versions(source), source_versions)
        self.assertEqual(len(sent), 2)


def load_tests(loader, tests, pattern):
    # Only this module's own cases; the inherited worklist/template cases run in their own modules.
    return unittest.TestSuite(RelatedReportModeE2E(name) for name in loader.getTestCaseNames(RelatedReportModeE2E)
                              if name.startswith("test_w5_"))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
