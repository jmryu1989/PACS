# coding: utf-8
"""Worklist request and approval columns on the served stack: a study matched to a run-unique synthetic order shows the
order's request time, department, physician and patient class in ReqDate, ReqDept, ReqDoc and Pt Class; Approve puts the
approval time in Confirm and the Confirmed filter keeps the row; Reset to Unread empties Confirm and the row is Not
Confirmed again.

Run in CI: `python tests/measurement_ci.py --profile worklist-request-columns`; on a development stack:
`python tests/e2e/test_worklist_request_columns.py`. Synthetic only: a run-unique study and order; cleanup unmatches and
removes the order (the study fixture's own cleanup removes the study).
"""
import json
import sys
import unittest
import uuid
from datetime import datetime, timedelta, timezone

from playwright.sync_api import expect

from test_worklist import WorklistE2E, psql


def lit(value):
    return "'" + str(value).replace("'", "''") + "'"


class WorklistRequestColumnsE2E(WorklistE2E):
    def cell(self, page, uid, key):
        index = page.locator("#heads th").evaluate_all("(els, k) => els.findIndex(e => e.dataset.key === k)", key)
        self.assertGreaterEqual(index, 0, key + " is a shown column")
        return page.locator(f'#rows tr[data-uid="{uid}"]').locator("td").nth(index)

    def local(self, page, iso):
        """`iso` as the browser's local YYYY-MM-DD HH:mm, from the browser's own zone offset for that moment."""
        offset = page.evaluate("t => new Date(t).getTimezoneOffset()", iso)
        moment = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc) - timedelta(minutes=offset)
        return moment.strftime("%Y-%m-%d %H:%M")

    def test_request_columns_01_matched_order_values_and_confirm_after_approve_and_reset(self):
        fixture = self.fixture()
        oid = "SYNTHETIC-reqcols-" + uuid.uuid4().hex

        def cleanup():
            self.stack.request("POST", "/unmatch", "tech", {"uid": fixture.uid})
            for value in psql('SELECT to_jsonb(t)::text FROM "Order" t WHERE oid=' + lit(oid)):
                row = json.loads(value)
                self.assertTrue(row["name"].startswith("SYNTHETIC"))
                self.assertEqual(psql('DELETE FROM "Order" t WHERE to_jsonb(t)=' + lit(value) + "::jsonb RETURNING oid"), [oid])
        self.addCleanup(cleanup)
        psql('INSERT INTO "Order" (oid,"institutionId","patientId",name,sex,birth,sched,modality,descr,ward,"reqDoc",'
             '"reqAt","reqDept","ptClass") VALUES (' + ",".join(lit(v) for v in [
                 oid, "hallym", fixture.patient_id, "SYNTHETIC REQUEST COLUMNS", "O", "", "20260910", "CT", "SYNTHETIC CT", "",
                 "SYNTHETIC ORDER DOC", "2026-11-12 00:40:00", "SYNTHETIC Neurology", "E"]) + ")")
        matched = self.stack.request("POST", "/match", "tech", {"uid": fixture.uid, "oid": oid, "patient": {}})
        self.assertEqual(matched.status, 201, matched.text)

        page = self.login()
        self.select(page, fixture)
        heads = page.locator("#heads th").evaluate_all("els => els.map(e => e.dataset.key)")
        self.assertEqual(heads[heads.index("rs"):heads.index("rs") + 2], ["rs", "confirm"])
        self.assertEqual(heads[heads.index("name"):heads.index("name") + 5], ["name", "reqDate", "reqDept", "reqDoc", "ptClass"])
        expect(self.cell(page, fixture.uid, "reqDate")).to_have_text(self.local(page, "2026-11-12T00:40:00Z"))
        expect(self.cell(page, fixture.uid, "reqDept")).to_have_text("SYNTHETIC Neurology")
        expect(self.cell(page, fixture.uid, "reqDoc")).to_have_text("SYNTHETIC ORDER DOC")
        expect(self.cell(page, fixture.uid, "ptClass")).to_have_text("ER")
        expect(self.cell(page, fixture.uid, "confirm")).to_have_text("")
        row = page.locator(f'#rows tr[data-uid="{fixture.uid}"]')
        confirm_filter = page.locator('#filterrow select[data-f="confirm"]')
        confirm_filter.select_option("Confirmed")
        expect(row).to_have_count(0)
        confirm_filter.select_option("Not Confirmed")
        expect(row).to_have_count(1)
        confirm_filter.select_option("")
        page.locator('#filterrow select[data-f="ptClass"]').select_option("ER")
        expect(row).to_have_count(1)
        page.locator('#filterrow select[data-f="ptClass"]').select_option("")

        # Approve: Confirm shows the stored approval time in the browser's zone, at once.
        row.click()
        page.locator("#findings").fill(fixture.secret)
        self.commit(page, fixture, "#b-approve", "A")
        approved_at = self.state(fixture)["approvedAt"]
        self.assertTrue(approved_at)
        expect(self.cell(page, fixture.uid, "confirm")).to_have_text(self.local(page, approved_at))
        self.assertRegex(self.cell(page, fixture.uid, "confirm").inner_text(), r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$")
        confirm_filter.select_option("Confirmed")
        expect(row).to_have_count(1)
        confirm_filter.select_option("")
        page.reload()
        self.select(page, fixture)
        expect(self.cell(page, fixture.uid, "confirm")).to_have_text(self.local(page, approved_at))

        # Reset to Unread: Confirm is empty and the row is Not Confirmed.
        self.open_toolbar_group(page, "#b-unread")
        page.locator("#b-unread").click()
        page.locator("#reason-choices").get_by_text("내용 정정 필요", exact=True).click()
        self.commit(page, fixture, "#reason-ok", "W")
        expect(self.cell(page, fixture.uid, "confirm")).to_have_text("")
        confirm_filter = page.locator('#filterrow select[data-f="confirm"]')
        confirm_filter.select_option("Not Confirmed")
        expect(row).to_have_count(1)
        confirm_filter.select_option("Confirmed")
        expect(row).to_have_count(0)
        confirm_filter.select_option("")
        self.assertIsNone(self.state(fixture)["approvedAt"])


def load_tests(loader, tests, pattern):
    return unittest.TestSuite([WorklistRequestColumnsE2E("test_request_columns_01_matched_order_values_and_confirm_after_approve_and_reset")])


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
