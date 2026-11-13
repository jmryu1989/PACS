# coding: utf-8
"""Technician Order List on the served stack, with run-unique synthetic studies and orders.

  - an unapproved study: Match… against an order of the same patient carrying an accession, the result read back (the
    order's accession while matched, Mt M, ReqDoc from the order), then Unmatch… with a reason: the archive's accession
    again, and the reason in the unmatch audit row;
  - Delete Order on that order (now unmatched): the mark with the reason on the order row, the order off the list, then
    Undo brings it back;
  - an approved study matched to its order: Unmatch… is refused by the server and the window says so; it stays matched;
    the Report tab shows its approved text and Copy Report;
  - Scheduled: an order of today for a patient with no study today is No images yet.

Run in CI: `python tests/measurement_ci.py --profile technician-orders`; on a development stack:
`python tests/e2e/test_technician_orders.py`. Synthetic only; cleanup unmatches and removes the orders (the study
fixtures' own cleanup removes the studies).
"""
import json
import sys
import unittest
import uuid

from playwright.sync_api import expect

from test_worklist import WorklistE2E, psql


def lit(value):
    return "'" + str(value).replace("'", "''") + "'"


class TechnicianOrdersE2E(WorklistE2E):
    def order(self, patient_id, sched="20260910", accession=None):
        oid = "SYNTHETIC-techord-" + uuid.uuid4().hex
        psql('INSERT INTO "Order" (oid,"institutionId","patientId",name,sex,birth,sched,modality,descr,ward,"reqDoc",accession) VALUES ('
             + ",".join(lit(v) for v in [oid, "hallym", patient_id, "SYNTHETIC TECHNICIAN ORDER", "O", "", sched, "CT",
                                         "SYNTHETIC ORDER CT", "SYNWARD", "SYNTHETIC ORDER DOC"]) + "," + (lit(accession) if accession else "NULL") + ")")

        def cleanup():
            for value in psql('SELECT to_jsonb(t)::text FROM "Order" t WHERE oid=' + lit(oid)):
                row = json.loads(value)
                if row["studyUid"]:
                    self.stack.request("POST", "/unmatch", "tech", {"uid": row["studyUid"]})
                self.assertTrue(row["name"].startswith("SYNTHETIC"))
                self.assertEqual(psql('DELETE FROM "Order" WHERE oid=' + lit(oid) + " RETURNING oid"), [oid])
        self.addCleanup(cleanup)
        return oid

    def technician(self, fixture):
        page = self.login("tech")
        page.locator("[data-tab=Technician]").click()
        self.select(page, fixture)
        page.locator(f'#rows tr[data-uid="{fixture.uid}"]').click()
        page.wait_for_function(f"() => selectedUid === {json.dumps(fixture.uid)}")
        page.locator('.order-p .filters input[data-o="id"]').fill(fixture.patient_id)
        return page

    def window_rows(self, window):
        return {r[0]: r[1:] for r in window.locator("table tbody tr").evaluate_all(
            "rows => rows.map(r => [...r.children].map(td => td.textContent))")}

    def test_technician_orders_01_match_unmatch_delete_report_scheduled(self):
        fixture = self.fixture()
        accession = "SYNACC" + uuid.uuid4().hex[:10].upper()
        oid = self.order(fixture.patient_id, accession=accession)
        page = self.technician(fixture)
        source_acc = page.evaluate(f"() => studies.find(s => s.uid === {json.dumps(fixture.uid)}).acc")
        page.locator(f'#orderrows tr[data-oid="{oid}"]').click()

        # Match…: compared, matched, and the result read back from the server.
        page.locator("#order-actions").get_by_role("button", name="Match…", exact=True).click()
        w = page.locator("dialog[data-order-window='order-match']")
        rows = self.window_rows(w)
        self.assertEqual([source_acc, accession, "≠"], rows["Accession"])
        self.assertEqual("✓", rows["Patient ID"][2])
        w.get_by_role("button", name="Match", exact=True).click()
        expect(w).to_contain_text("After (read back)", timeout=30000)
        result = self.window_rows(w)
        self.assertEqual([source_acc, accession], result["Accession"])
        self.assertEqual(["U", "M"], result["Mt"])
        w.get_by_role("button", name="Close").click()
        self.assertEqual("M", self.state(fixture)["matched"])
        self.assertEqual([accession, source_acc, "SYNTHETIC ORDER DOC"], page.evaluate(
            f"() => {{ const s = studies.find(x => x.uid === {json.dumps(fixture.uid)}); return [s.acc, s.sourceAcc, s.reqDoc]; }}"))

        # Unmatch… with a reason: the archive's accession again, the reason in the audit row.
        page.locator("#order-actions").get_by_role("button", name="Unmatch…", exact=True).click()
        w = page.locator("dialog[data-order-window='order-unmatch']")
        w.get_by_label("Reason").fill("SYNTHETIC linked to the wrong order")
        w.get_by_role("button", name="Unmatch", exact=True).click()
        expect(w).to_contain_text("Restored (read back)", timeout=30000)
        self.assertEqual([accession, source_acc], self.window_rows(w)["Accession"])
        w.get_by_role("button", name="Close").click()
        self.assertEqual("U", self.state(fixture)["matched"])
        [detail] = psql('SELECT detail FROM "AuditLog" WHERE action=\'unmatch\' AND target=' + lit(fixture.uid) + " ORDER BY id DESC LIMIT 1")
        self.assertEqual("SYNTHETIC linked to the wrong order", json.loads(detail)["reason"])

        # Delete Order and Undo.
        page.locator(f'#orderrows tr[data-oid="{oid}"]').click()
        page.locator("#order-actions").get_by_role("button", name="Delete Order", exact=True).click()
        w = page.locator("dialog[data-order-window='order-delete']")
        w.get_by_label("Reason").fill("SYNTHETIC duplicate order")
        w.get_by_role("button", name="Delete Order").click()
        expect(page.locator(f'#orderrows tr[data-oid="{oid}"]')).to_have_count(0, timeout=30000)
        [removed] = psql('SELECT "removeReason" FROM "Order" WHERE oid=' + lit(oid) + ' AND "removedAt" IS NOT NULL')
        self.assertEqual("SYNTHETIC duplicate order", removed)
        page.locator("#order-actions .order-status").get_by_role("button", name="Undo").click()
        expect(page.locator(f'#orderrows tr[data-oid="{oid}"]')).to_have_count(1, timeout=30000)
        self.assertEqual(psql('SELECT oid FROM "Order" WHERE oid=' + lit(oid) + ' AND "removedAt" IS NULL'), [oid])

        # Another study, matched and then approved: Unmatch… is refused by the server, in the window.
        approved = self.fixture()
        oid2 = self.order(approved.patient_id)
        matched = self.stack.request("POST", "/match", "tech", {"uid": approved.uid, "oid": oid2, "patient": {}})
        self.assertEqual(matched.status, 201, matched.text)
        self.seed_report(approved, action="approve", findings="SYNTHETIC APPROVED FINDINGS")
        page.close()
        page = self.technician(approved)
        page.locator("#order-actions").get_by_role("button", name="Unmatch…", exact=True).click()
        w = page.locator("dialog[data-order-window='order-unmatch']")
        w.get_by_label("Reason").fill("SYNTHETIC should be refused")
        w.get_by_role("button", name="Unmatch", exact=True).click()
        expect(w.locator(".order-note.err")).to_contain_text("Not unmatched", timeout=30000)
        w.get_by_role("button", name="Close").click()
        self.assertEqual("M", self.state(approved)["matched"])

        # Report tab: the approved text, read only, with Copy Report.
        page.locator(".order-p .reltabs > div", has_text="Report").click()
        pane = page.locator("#order-pane")
        expect(pane.locator("[data-report-state=approved]")).to_have_text("Approved")
        expect(pane).to_contain_text("SYNTHETIC APPROVED FINDINGS")
        self.assertEqual(1, pane.get_by_role("button", name="Copy Report").count())
        page.locator(".order-p .reltabs > div", has_text="Order List (RIS)").click()

        # Scheduled: an order of today for a patient with no study today.
        today = page.evaluate("() => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }")
        today_oid = self.order("SYNTHETIC-NOSTUDY-" + uuid.uuid4().hex[:8], sched=today + " 09:00")
        page.locator(".order-p .reltabs > div", has_text="Scheduled").click()
        row = pane.locator(f'tr[data-oid="{today_oid}"]')
        expect(row).to_have_count(1, timeout=30000)
        expect(row.locator("td").nth(5)).to_have_text("No images yet")
        row.click()
        expect(pane.locator(".order-detail")).to_contain_text("No images yet")


def load_tests(loader, tests, pattern):
    return unittest.TestSuite([TechnicianOrdersE2E("test_technician_orders_01_match_unmatch_delete_report_scheduled")])


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
