# coding: utf-8
"""Merge Exam · Split / Unmerge on the served stack, with run-unique synthetic studies of one synthetic patient.

  - three studies of one patient: Merge Exam in the Technician window (the same patient's same-day studies ticked, the
    selected study as Base) → the list shows the base row only, with `Merged ×3` and the Count of all three; the
    radiologist's viewer opens the three studies as one (one window, all three studies' images, no compare layout);
    a report saved on the merged exam carries the group; a merged study refuses a hold of its own (409 STUDY_MERGED);
    Split / Unmerge (before approval) restores the three rows; the saved report keeps its group and can only be Reset;
  - two studies merged, an image arriving later for the second: the merged exam counts it while merged and the second
    study keeps it after Unmerge; with the merged exam approved, Unmerge is refused in the window and by the server, and
    after Reset to Unread it goes through.

Run in CI: `python tests/measurement_ci.py --profile exam-merge`; on a development stack: `python tests/e2e/test_exam_merge.py`.
Synthetic only; the cleanup removes the groups this run wrote (the study fixtures' own cleanup removes the studies).
"""
import json
import re
import subprocess
import sys
import unittest
import uuid
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect

from test_worklist import ROOT, WorklistE2E, psql


def lit(value):
    return "'" + str(value).replace("'", "''") + "'"


class ExamMergeE2E(WorklistE2E):
    def patient(self, count):
        patient = "SYN-MERGE-" + uuid.uuid4().hex[:12]
        fixtures = [self.fixture(patient_id=patient) for _ in range(count)]
        uids = ",".join(lit(f.uid) for f in fixtures)

        def cleanup():
            groups = psql(f'SELECT DISTINCT "groupId" FROM "StudyGroupMember" WHERE "studyUid" IN ({uids})')
            if groups:
                ids = ",".join(lit(g) for g in groups)
                psql(f'DELETE FROM "StudyGroupMember" WHERE "groupId" IN ({ids}); DELETE FROM "StudyGroup" WHERE id IN ({ids});')
            psql(f'UPDATE "Report" SET "groupId"=NULL WHERE uid IN ({uids}); UPDATE "ReportVersion" SET "groupId"=NULL WHERE uid IN ({uids});')
        # Registered after the fixtures: runs before their own cleanup.
        self.addCleanup(cleanup)
        return patient, fixtures

    def technician(self, fixture):
        page = self.login("tech")
        page.locator("[data-tab=Technician]").click()
        self.select(page, fixture)
        page.wait_for_function(f"() => selectedUid === {json.dumps(fixture.uid)}")
        return page

    def rows(self, page):
        return page.eval_on_selector_all("#rows tr[data-uid]", "rows => rows.map(r => r.dataset.uid)")

    def listed(self, actor="doctor"):
        result = self.stack.request("GET", "/studies", actor)
        self.assertEqual(result.status, 200, result.text)
        return {row["uid"]: row for row in result.body["studies"]}

    def merge_in_window(self, page, base, others):
        page.locator("#t-merge-exam").click()
        w = page.locator("dialog[data-exam-window='merge']")
        for f in [base, *others]:
            expect(w.locator(f"tbody tr[data-uid='{f.uid}'] input[type=checkbox]")).to_be_checked()
        expect(w.locator(f"tbody tr[data-uid='{base.uid}'] input[type=radio]")).to_be_checked()
        expect(w.locator(".exam-merge-result")).to_contain_text(f"Result: 1 exam (base ")
        expect(w.locator(".exam-merge-result")).to_contain_text(f"The original grouping of {1 + len(others)} studies is kept")
        w.get_by_role("button", name="Merge", exact=True).click()
        expect(w).to_contain_text(f"Merged: {1 + len(others)} exams", timeout=30000)
        w.get_by_role("button", name="Close").click()
        expect(page.locator(f"#rows tr[data-uid='{base.uid}'] .exam-merged")).to_have_text(re.compile(rf"^Merged ×{1 + len(others)} · "), timeout=30000)

    def unmerge_window(self, page, base):
        page.locator(f"#rows tr[data-uid='{base.uid}']").click()
        page.wait_for_function(f"() => selectedUid === {json.dumps(base.uid)}")
        page.locator("#t-split-unmerge").click()
        w = page.locator("dialog[data-exam-window='unmerge']")
        expect(w.locator(".exam-merge-checks li")).to_have_count(3, timeout=30000)
        return w

    def test_exam_merge_01_three_studies_one_exam_viewer_report_unmerge(self):
        patient, (a, b, c) = self.patient(3)
        page = self.technician(a)
        self.merge_in_window(page, a, [b, c])
        rows = self.rows(page)
        self.assertIn(a.uid, rows)
        self.assertNotIn(b.uid, rows)
        self.assertNotIn(c.uid, rows)
        listed = self.listed()
        base = listed[a.uid]
        self.assertNotIn(b.uid, listed)
        self.assertEqual([m["uid"] for m in base["group"]["members"]], [a.uid, b.uid, c.uid])
        self.assertEqual(base["count"], sum(m["count"] for m in base["group"]["members"]))
        [group] = psql(f'SELECT id FROM "StudyGroup" WHERE "baseUid"={lit(a.uid)} AND "dissolvedAt" IS NULL')
        [audit] = psql(f'SELECT detail FROM "AuditLog" WHERE action=\'study.merge\' AND target={lit(a.uid)} ORDER BY id DESC LIMIT 1')
        self.assertEqual(json.loads(audit)["studies"], [a.uid, b.uid, c.uid])

        # The radiologist's viewer opens the three studies as one current study.
        reader = self.login()
        row = self.select(reader, a)
        with reader.context.expect_page(timeout=20000) as opened:
            row.dblclick()
        viewer = opened.value
        viewer.wait_for_url("**/ohif/viewer?**", timeout=30000)
        query = parse_qs(urlsplit(viewer.url).query)
        self.assertEqual(query["StudyInstanceUIDs"], [",".join([a.uid, b.uid, c.uid])])
        self.assertIsNone(query.get("hangingProtocolId"))
        viewer.wait_for_function("u => typeof services === 'object' && u.every(x => services.displaySetService.getActiveDisplaySets()"
                                 ".some(d => d.StudyInstanceUID === x))", arg=[a.uid, b.uid, c.uid], timeout=60000)
        viewer.close()

        # A report saved on the merged exam carries the group; a merged study has no report of its own while merged.
        self.seed_report(a, action="save", findings="SYNTHETIC MERGED FINDINGS")
        self.assertEqual(psql(f'SELECT "groupId" FROM "Report" WHERE uid={lit(a.uid)}'), [group])
        held = self.stack.request("POST", f"/studies/{b.uid}/hold", "doctor", {})
        self.assertEqual(held.status, 409, held.text)
        self.assertEqual(held.body["code"], "STUDY_MERGED")
        self.assertEqual(held.body["baseUid"], a.uid)

        # Unmerge before approval: allowed; the three studies are listed again.
        page.reload()
        page.locator("[data-tab=Technician]").click()
        self.select(page, a)
        w = self.unmerge_window(page, a)
        expect(w.locator(".exam-merge-checks li").first).to_have_text("✓ No report of the merged exam is approved now.")
        w.get_by_role("button", name="Unmerge", exact=True).click()
        expect(w).to_contain_text("Unmerged: 3 original exams restored", timeout=30000)
        w.get_by_role("button", name="Close").click()
        listed = self.listed()
        for f in (a, b, c):
            self.assertIn(f.uid, listed)
            self.assertNotIn("group", listed[f.uid])
        self.assertEqual(psql(f'SELECT count(*) FROM "StudyGroup" WHERE id={lit(group)} AND "dissolvedAt" IS NOT NULL'), ["1"])
        # The saved report keeps the exam it was written on; it is not approved as the base study's alone — Reset goes on.
        self.assertEqual(psql(f'SELECT "groupId" FROM "Report" WHERE uid={lit(a.uid)}'), [group])
        version = self.versions(a)[-1]["version"]
        refused = self.stack.request("POST", f"/studies/{a.uid}/report/commit", "doctor", {
            "action": "approve", "baseVersion": version, "findings": "SYNTHETIC MERGED FINDINGS", "conclusion": "", "recommendation": ""})
        self.assertEqual(refused.status, 409, refused.text)
        self.assertEqual(refused.body["code"], "EXAM_SCOPE_CHANGED")

    def test_exam_merge_02_late_image_and_approved_refusal(self):
        patient, (a, b) = self.patient(2)
        merged = self.stack.request("POST", "/exam-groups", "tech", {"baseUid": a.uid, "uids": [a.uid, b.uid]})
        self.assertEqual(merged.status, 200, merged.text)
        before = self.listed()[a.uid]["count"]
        # An image of the second study arrives after the merge: it is the merged exam's while merged.
        sent = subprocess.run([sys.executable, str(ROOT / "scripts" / "send_cstore.py"), "--institution", "한림병원",
                               "--name", "SYNTHETIC^LATE", "--id", patient, "--slices", "1", "--study-uid", b.uid,
                               "--instance-offset", "1"], cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=120)
        self.assertEqual(sent.returncode, 0, sent.stdout + sent.stderr)
        page = self.technician(a)
        row = None
        for _ in range(80):
            row = self.listed()[a.uid]
            if row["count"] == before + 1:
                break
            page.wait_for_timeout(250)
        self.assertEqual(row["count"], before + 1)
        # Approved now: Unmerge is refused in the window and by the server.
        self.seed_report(a, action="approve", findings="SYNTHETIC APPROVED MERGED")
        page.reload()
        page.locator("[data-tab=Technician]").click()
        self.select(page, a)
        w = self.unmerge_window(page, a)
        expect(w.locator(".exam-merge-checks li").first).to_contain_text("✗ This study has an approved report. Reset the report to Unread first.")
        expect(w.get_by_role("button", name="Unmerge", exact=True)).to_be_disabled()
        w.get_by_role("button", name="Close").click()
        group = merged.body["group"]["id"]
        refused = self.stack.request("POST", f"/exam-groups/{group}/dissolve", "tech", {})
        self.assertEqual(refused.status, 409, refused.text)
        self.assertEqual(refused.body["code"], "EXAM_GROUP_REFUSED")
        # Reset to Unread (the approved text kept in the history with its group), then Unmerge goes through.
        version = self.versions(a)[-1]["version"]
        reset = self.stack.request("POST", f"/studies/{a.uid}/report/commit", "doctor", {
            "action": "reset", "baseVersion": version, "reason": "SYNTHETIC unmerge", "findings": "", "conclusion": "",
            "recommendation": ""})
        self.assertEqual(reset.status, 201, reset.text)
        self.assertEqual(psql(f'SELECT "groupId" FROM "ReportVersion" WHERE uid={lit(a.uid)} AND action=\'discarded\''), [group])
        done = self.stack.request("POST", f"/exam-groups/{group}/dissolve", "tech", {})
        self.assertEqual(done.status, 200, done.text)
        listed = self.listed()
        # The late image stayed with its own study.
        self.assertEqual(listed[a.uid]["count"] + listed[b.uid]["count"], before + 1)
        self.assertNotIn("group", listed[a.uid])


def load_tests(loader, tests, pattern):
    return unittest.TestSuite([ExamMergeE2E("test_exam_merge_01_three_studies_one_exam_viewer_report_unmerge"),
                               ExamMergeE2E("test_exam_merge_02_late_image_and_approved_refusal")])


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
