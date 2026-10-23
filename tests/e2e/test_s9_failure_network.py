"""SCN-S9-FAIL-01/03: real Reading Workspace draft and list request failures.

REQ-S9-U3-INPUT/NO-FALSE-SUCCESS/RECOVERY ->
RISK-S9-U3-LOST-INPUT/FALSE-SUCCESS/DUPLICATE-WRITE/STUCK -> TEST-S9-U3-NETWORK.
Only HTTP failures are injected. Successful replies, draft reads and PostgreSQL
records are real; no page composition, internal function calls or timer changes.
The 35 s autosave observation window is reused from SessionDraftBoundaries;
the 60 s workspace readiness window is reused from ReadingWorkspaceE2E.
Neither is a new product latency requirement. Run only on an admitted synthetic
stack through scripts/run-tests.py. Settings/viewer coverage is reused separately.
"""
import json
import re
import unittest
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect

import test_worklist as worklist


class FailureCases:
    """Shared observations for the two owned failure modules, with no test cases."""

    def draft(self, fixture):
        response = self.stack.request("GET", f"/studies/{fixture.uid}/draft", "doctor")
        self.assertEqual(response.status, 200, response.text)
        self.assertEqual(response.body["uid"], fixture.uid)
        return response.body

    def stored(self, fixture):
        # Compare complete rows, including revision/time and audit identity, so
        # an extra upsert cannot pass merely because the final text is the same.
        rows = {}
        for table, order in (("ReportDraft", "author"), ("Report", "uid"),
                             ("ReportVersion", "version")):
            rows[table] = [json.loads(row) for row in worklist.psql(
                f'SELECT to_jsonb(r)::text FROM "{table}" r '
                f"WHERE uid='{fixture.uid}' ORDER BY {order};")]
        rows["draft_audits"] = [json.loads(row) for row in worklist.psql(
            'SELECT to_jsonb(a)::text FROM "AuditLog" a '
            f"WHERE target='{fixture.uid}' AND action='report.draft' ORDER BY id;")]
        return rows

    def text_is(self, page, snapshot):
        for field in ("findings", "conclusion", "recommendation"):
            expect(page.locator("#" + field)).to_have_value(snapshot[field])

    def saved(self, page, fixture, snapshot):
        expect(page.locator("#draftmsg")).to_contain_text("Draft Saved", timeout=35000)
        self.text_is(page, snapshot)
        authority = self.draft(fixture)
        self.assertTrue(authority["present"])
        for field, value in snapshot.items():
            self.assertEqual(authority["snapshot"][field], value)
        return authority

    def workspace_with_draft(self):
        fixture = self.fixture()
        page = self.login()
        self.select(page, fixture)
        page.locator("#m-reading").click()
        expect(page.locator("#reading-frame")).to_be_visible()
        expect(page.locator("#reading-status")).to_contain_text("연결됨", timeout=60000)
        frame = page.locator("#reading-frame").element_handle().content_frame()
        self.assertEqual(parse_qs(urlsplit(frame.url).query)["StudyInstanceUIDs"], [fixture.uid])
        # Normal control: autosave reaches the real API before any fault exists.
        snapshot = {field: page.locator("#" + field).input_value()
                    for field in ("findings", "conclusion", "recommendation")}
        snapshot["findings"] = "SYNTHETIC baseline draft " + fixture.uid
        with page.expect_response(lambda r: r.request.method == "PUT"
                                  and r.url.endswith(f"/{fixture.uid}/report"), timeout=35000) as reply:
            page.locator("#findings").fill(snapshot["findings"])
        self.assertEqual(reply.value.status, 200)
        self.saved(page, fixture, snapshot)
        return page, fixture, snapshot

    def draft_failure(self, *, status=None, committed=False):
        page, fixture, snapshot = self.workspace_with_draft()
        before = self.stored(fixture)
        authority_before = self.draft(fixture)
        snapshot = dict(snapshot, findings="SYNTHETIC retained after failure " + fixture.uid)
        fault = {"active": True}
        writes, reads, committed_answers = [], [], []
        report_pattern = f"**/api/studies/{fixture.uid}/report"
        draft_pattern = f"**/api/studies/{fixture.uid}/draft"

        def write(route):
            if route.request.method != "PUT":
                route.continue_()
                return
            writes.append(route.request.post_data_json)
            if not fault["active"]:
                route.continue_()
            elif committed and not committed_answers:
                # Lose only the receipt after the real transaction committed.
                answer = route.fetch()
                self.assertEqual(answer.status, 200)
                committed_answers.append(answer.json())
                route.abort("failed")
            elif status is not None:
                route.fulfill(status=status, json={"message": "Synthetic draft service unavailable"})
            else:
                route.abort("failed")

        def read(route):
            reads.append(fault["active"])
            if fault["active"]:
                # An unavailable readback must not turn a lost receipt into success.
                route.abort("failed")
            else:
                route.continue_()

        page.route(report_pattern, write)
        if committed:
            page.route(draft_pattern, read)
        page.locator("#findings").fill(snapshot["findings"])
        expect(page.locator("#draftmsg")).to_contain_text(
            re.compile(r"Result Unknown|Save Failed"), timeout=35000)
        expect(page.locator("#draftmsg")).not_to_contain_text("Draft Saved")
        expect(page.locator("#findings")).to_be_editable()
        self.text_is(page, snapshot)
        self.assertTrue(writes, "The fault must intercept an actual draft PUT")
        failed_state = self.stored(fixture)
        if committed:
            self.assertEqual(len(committed_answers), 1)
            self.assertIn(True, reads, "Readback failure must actually be exercised")
            self.assertEqual(self.draft(fixture), committed_answers[0])
            self.assertEqual(len(failed_state["draft_audits"]), len(before["draft_audits"]) + 1)
        else:
            self.assertEqual(failed_state, before)
            self.assertEqual(self.draft(fixture), authority_before)

        # Let the existing autosave retry/reconcile, without calling its internals.
        fault["active"] = False
        self.saved(page, fixture, snapshot)
        after = self.stored(fixture)
        self.assertEqual(after["Report"], before["Report"])
        self.assertEqual(after["ReportVersion"], before["ReportVersion"])
        self.assertEqual(len(after["ReportDraft"]), 1)
        self.assertEqual(len(after["draft_audits"]), len(before["draft_audits"]) + 1)
        if committed:
            self.assertIn(False, reads)
            self.assertEqual(after, failed_state, "Receipt recovery must not write a second record")
            self.assertEqual(len(writes), 1, "Readback should settle the committed operation")
        else:
            self.assertGreater(len(writes), 1, "The failed operation must actually retry")
        page.unroute(report_pattern, write)
        if committed:
            page.unroute(draft_pattern, read)
        # A fresh document must recover the same persisted draft, without a commit.
        page.reload()
        expect(page.locator("#dbstat")).to_contain_text("DB Connected")
        self.select(page, fixture)
        self.text_is(page, snapshot)
        self.assertEqual(self.stored(fixture), after)

    def list_failure(self, *, status=None):
        fixture = self.fixture()
        page = self.login()
        self.select(page, fixture)
        self.open_toolbar_group(page, "#worklist-refresh")
        page.locator("#worklist-refresh").select_option("0")
        # The existing Manual option isolates the user-triggered list request.
        with page.expect_response(lambda r: r.request.method == "GET" and "/api/studies?" in r.url):
            page.locator("#refresh").click()
        expect(page.locator("#study-fetch-cancel")).not_to_be_visible()
        before = page.locator("#rows tr[data-uid]").evaluate_all("rows => rows.map(r => r.dataset.uid)")
        versions = self.versions(fixture)
        text = "SYNTHETIC list failure preserves editing " + fixture.uid
        page.locator("#findings").fill(text)
        new_fixture = self.fixture(patient_id=fixture.patient_id)
        calls = []

        def unavailable(route):
            calls.append(route.request.url)
            if status is None:
                route.abort("failed")
            else:
                route.fulfill(status=status, json={"message": "Synthetic list service unavailable"})

        pattern = "**/api/studies?*"
        page.route(pattern, unavailable)
        page.locator("#refresh").click()
        expect(page.locator("#err")).not_to_be_empty()
        expect(page.locator("#err")).to_be_visible()
        expect(page.locator("#study-fetch-resume")).to_be_visible()
        self.assertTrue(calls, "The failed request must reach the HTTP boundary")
        self.assertEqual(page.locator("#rows tr[data-uid]").evaluate_all(
            "rows => rows.map(r => r.dataset.uid)"), before)
        expect(page.locator(f'#rows tr[data-uid="{fixture.uid}"]')).to_have_class(re.compile(r"\bsel\b"))
        expect(page.locator("#findings")).to_have_value(text)
        expect(page.locator(f'#rows tr[data-uid="{new_fixture.uid}"]')).to_have_count(0)
        page.unroute(pattern, unavailable)
        with page.expect_response(lambda r: r.request.method == "GET" and "/api/studies?" in r.url) as reply:
            page.locator("#study-fetch-resume").click()
        self.assertEqual(reply.value.status, 200)
        expect(page.locator(f'#rows tr[data-uid="{new_fixture.uid}"]')).to_be_visible()
        expect(page.locator("#err")).to_be_empty()
        expect(page.locator("#study-fetch-resume")).not_to_be_visible()
        expect(page.locator(f'#rows tr[data-uid="{fixture.uid}"]')).to_have_class(re.compile(r"\bsel\b"))
        expect(page.locator("#findings")).to_have_value(text)
        self.assertEqual(self.versions(fixture), versions)


class S9FailureNetworkE2E(FailureCases, worklist.WorklistE2E):
    def test_network_01_draft_request_failure_preserves_input_and_retries(self):
        self.draft_failure()

    def test_network_02_committed_draft_lost_receipt_reconciles_without_duplicate(self):
        self.draft_failure(committed=True)

    def test_network_03_list_failure_preserves_rows_and_recovers(self):
        self.list_failure()


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(S9FailureNetworkE2E(name) for name in sorted(vars(S9FailureNetworkE2E))
                              if name.startswith("test_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
