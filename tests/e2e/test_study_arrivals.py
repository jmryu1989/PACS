# coding: utf-8
"""Native IF-V11 study-arrival polling with owned synthetic DICOM only."""
from __future__ import annotations

import io
from pathlib import Path
import time
import unittest
import uuid

from pydicom import dcmread
from pydicom.uid import CTImageStorage, generate_uid
from pynetdicom import AE
from playwright.sync_api import expect

from test_cine import CineE2E
from test_display_controls import DisplayControlsE2E
from test_prior_selection import canvas_ready


class StudyArrivalsE2E(DisplayControlsE2E):
    def shot(self, page, name):
        folder = Path(__file__).parent / "artifacts"; folder.mkdir(exist_ok=True)
        page.screenshot(path=str(folder / f"STUDY-ARRIVALS-{name}.png"), full_page=True)

    def study_row(self, fixture, actor="doctor"):
        result = self.stack.request("GET", "/studies", actor)
        self.assertEqual(200, result.status)
        return next(row for row in result.body["studies"] if row["uid"] == fixture.uid)

    def add_sop(self, fixture, instance_number=900):
        source_id = self.stack.first_instance_id(fixture.uid)
        data = dcmread(io.BytesIO(self.stack.orthanc_bytes(f"/instances/{source_id}/file")))
        sop = generate_uid()
        data.SOPInstanceUID = sop
        data.file_meta.MediaStorageSOPInstanceUID = sop
        data.InstanceNumber = instance_number
        # A new owned object is sent; no existing Orthanc object is rewritten.
        ae = AE(ae_title="HALLYM_CT")
        ae.add_requested_context(CTImageStorage, data.file_meta.TransferSyntaxUID)
        association = ae.associate("127.0.0.1", 4242, ae_title="KINLAB")
        self.assertTrue(association.is_established)
        try:
            self.assertEqual(0, association.send_c_store(data).Status)
        finally:
            association.release()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            lookup = self.stack.request("POST", "/dicom/lookup", "doctor", {"studyUid": fixture.uid, "sopUid": sop})
            if lookup.status == 200:
                return {"study": fixture.uid, "series": str(data.SeriesInstanceUID), "sop": sop, "id": lookup.body["id"]}
            time.sleep(.25)
        self.fail("New owned SOP did not reach the exact lookup API")

    def manual(self, page):
        page.locator("#worklist-refresh").select_option("0")
        page.wait_for_function("()=>!studyPageClient.busy")

    def automatic(self, page):
        page.bring_to_front()
        page.locator("#worklist-refresh").select_option("30")
        expect(page.locator("#worklist-refresh")).to_have_value("30")

    def wait_count(self, page, fixture, count, series=None):
        page.wait_for_function("value=>{const s=studies.find(x=>x.uid===value.uid);return s?.count===value.count&&(value.series==null||s.series===value.series)}",
                               arg={"uid": fixture.uid, "count": count, "series": series}, timeout=45000)

    def watch_notices(self, page):
        page.evaluate("""()=>{window.arrivalNotices=[];let last='';const toast=document.querySelector('#toast');
          new MutationObserver(()=>{const text=toast.textContent.trim(),shown=toast.classList.contains('show');
            if(!shown){last='';return}if(text&&text!==last){arrivalNotices.push(text);last=text}}).observe(toast,{attributes:true,childList:true,characterData:true,subtree:true});}""")

    def existing_originals_unchanged(self, before):
        after = self.originals()
        for path, digest in before.items():
            self.assertEqual(digest, after.get(path), path)

    def stable_view(self, page, timeout=15000):
        # Pixel contrast alone can precede the late workspace dock resize.  Keep
        # exact preservation assertions, but take them from settled native output.
        expect(page.locator("#kin-workspace-dock")).to_be_visible(timeout=timeout)
        deadline = time.monotonic() + timeout / 1000
        previous, repeats = None, 0
        while time.monotonic() < deadline:
            current = self.display(page)
            repeats = repeats + 1 if current == previous else 0
            if repeats >= 3:
                return current
            previous = current
            page.wait_for_timeout(250)
        self.fail("Native viewer output did not settle before the preservation snapshot")

    def stack_identity(self, page):
        return page.evaluate("""()=>{
          const id=services.viewportGridService.getState().activeViewportId;
          const viewport=services.cornerstoneViewportService.getCornerstoneViewport(id);
          const imageIds=viewport.getImageIds();
          return {imageIds,sops:imageIds.map(imageId=>cornerstone.metaData.get('instance',imageId)?.SOPInstanceUID||null),
            studies:imageIds.map(imageId=>cornerstone.metaData.get('instance',imageId)?.StudyInstanceUID||null)};
        }""")

    def test_arrivals_01_same_series_sop_updates_count_and_preserves_viewer_draft_hold_report_and_sources(self):
        fixture = self.ct("ARRIVAL-" + uuid.uuid4().hex[:12], "current", "20260801")
        self.seed_report(fixture)
        work = self.login(); self.select(work, fixture); self.manual(work); self.watch_notices(work)
        draft = "ARRIVAL UNSAVED DRAFT " + fixture.uid
        work.locator("#findings").fill(draft); work.locator("#quick").click()
        self.wait_state(work, fixture, lambda state: (state.get("draft") or {}).get("findings") == draft, timeout=25000)
        holder = self.state(fixture)["holder"]; self.assertEqual(self.stack.actor("doctor"), holder)
        versions, report_rows, originals = self.versions(fixture), self.report_rows(fixture), self.originals()
        before_row = self.study_row(fixture)
        work.locator("#image-opening-open").click()
        work.locator("#image-opening-target").select_option("window")
        work.locator("#image-opening-prior").set_checked(False)
        work.locator("#image-opening-limit").select_option("2")
        work.locator("#image-opening-done").click()
        with work.context.expect_page() as opened:
            work.locator("#m-filmbox").click()
        viewer = opened.value; viewer.wait_for_url("**/ohif/viewer?**"); canvas_ready(viewer, 1)
        viewer.wait_for_function("""()=>typeof kinViewerWindowOwner==='function'&&kinViewerWindowOwner()&&
          typeof kinViewerJobWorkspaceState==='function'&&!kinViewerJobWorkspaceState().busy&&
          typeof kinViewerHistoryWorkspaceState==='function'&&!kinViewerHistoryWorkspaceState().busy""")
        self.assertEqual([fixture.uid], viewer.evaluate("()=>new URL(location.href).searchParams.get('StudyInstanceUIDs').split(',')"))
        marker = viewer.evaluate("window.__arrivalDocument=crypto.randomUUID()")
        viewer.get_by_role("button", name="Comparison", exact=True).click()
        viewer.get_by_label("Job Title", exact=True).fill("ARRIVAL ORIGINAL UNSAVED JOB")
        before_view = self.stable_view(viewer); before_stack = self.stack_identity(viewer)
        self.assertEqual(4, len(before_stack["imageIds"])); self.assertEqual([fixture.uid] * 4, before_stack["studies"])
        self.assertTrue(all(before_stack["sops"])); self.assertEqual(4, len(set(before_stack["sops"])))

        added = self.add_sop(fixture)
        self.assertEqual(200, self.stack.request("POST", "/dicom/lookup", "doctor", {"studyUid": fixture.uid, "sopUid": added["sop"]}).status)
        work.evaluate("arrivalNotices=[]")
        self.automatic(work); self.wait_count(work, fixture, before_row["count"] + 1, before_row["series"])
        expect(work.locator("#toast")).to_contain_text("영상 또는 시리즈가 추가됐습니다")
        expect(work.locator("#findings")).to_have_value(draft)
        self.assertEqual(holder, self.state(fixture)["holder"]); self.assertEqual(versions, self.versions(fixture)); self.assertEqual(report_rows, self.report_rows(fixture))
        self.assertEqual(before_view, self.stable_view(viewer)); self.assertEqual(1, len(work.evaluate("arrivalNotices"))); self.assertEqual([], work.evaluate("arrivalNotices.filter(x=>x.includes('새 검사'))"))
        self.assertEqual(before_stack, self.stack_identity(viewer))
        expect(viewer.get_by_label("Job Title", exact=True)).to_have_value("ARRIVAL ORIGINAL UNSAVED JOB")
        self.assertTrue(viewer.evaluate("()=>kinViewerJobWorkspaceState().dirty"))

        work.locator("#viewer-windows-open").click()
        expect(work.locator("#viewer-windows-dialog")).to_be_visible()
        latest = work.locator('[data-window-index="0"][data-window-action="latest"]')
        expect(latest).to_be_enabled()
        with work.context.expect_page() as fresh_opened:
            latest.click()
        fresh = fresh_opened.value; fresh.wait_for_url("**/ohif/viewer?**"); canvas_ready(fresh, 1)
        fresh.wait_for_function("""()=>typeof kinViewerWindowOwner==='function'&&kinViewerWindowOwner()&&
          typeof kinViewerJobWorkspaceState==='function'&&!kinViewerJobWorkspaceState().busy&&
          typeof kinViewerHistoryWorkspaceState==='function'&&!kinViewerHistoryWorkspaceState().busy""")
        self.assertIsNone(fresh.evaluate("()=>window.__arrivalDocument||null"))
        self.assertNotEqual(marker, fresh.evaluate("window.__arrivalDocument=crypto.randomUUID()"))
        self.assertEqual([fixture.uid], fresh.evaluate("()=>new URL(location.href).searchParams.get('StudyInstanceUIDs').split(',')"))
        fresh_stack = self.stack_identity(fresh)
        self.assertEqual(5, len(fresh_stack["imageIds"])); self.assertEqual([fixture.uid] * 5, fresh_stack["studies"])
        self.assertEqual(1, fresh_stack["sops"].count(added["sop"])); self.assertNotIn(added["sop"], before_stack["sops"])
        self.assertEqual(set(before_stack["sops"]) | {added["sop"]}, set(fresh_stack["sops"]))
        self.assertEqual(before_stack, self.stack_identity(viewer)); self.assertEqual(before_view, self.stable_view(viewer))
        expect(viewer.get_by_label("Job Title", exact=True)).to_have_value("ARRIVAL ORIGINAL UNSAVED JOB")
        self.assertTrue(viewer.evaluate("()=>kinViewerJobWorkspaceState().dirty"))
        expect(work.locator("#findings")).to_have_value(draft)
        self.assertEqual(holder, self.state(fixture)["holder"]); self.assertEqual(versions, self.versions(fixture)); self.assertEqual(report_rows, self.report_rows(fixture))
        self.existing_originals_unchanged(originals); self.shot(work, "same-study")

    def test_arrivals_02_new_study_and_existing_growth_emit_one_combined_notice(self):
        current = self.ct("ARRIVAL-COMBINED-" + uuid.uuid4().hex[:10], "current", "20260801")
        page = self.login(); self.select(page, current); self.manual(page); self.watch_notices(page)
        before = self.study_row(current); self.add_sop(current)
        new_study = self.ct("ARRIVAL-NEW-" + uuid.uuid4().hex[:10], "new", "20260912")
        page.evaluate("arrivalNotices=[]")
        self.automatic(page)
        page.wait_for_function("value=>studies.some(s=>s.uid===value)", arg=new_study.uid, timeout=45000)
        self.wait_count(page, current, before["count"] + 1, before["series"])
        page.wait_for_function("()=>arrivalNotices.length===1", timeout=5000)
        notices = page.evaluate("arrivalNotices")
        self.assertEqual(1, len(notices)); self.assertIn("새 검사 1건이 도착했습니다", notices[0]); self.assertIn("영상 또는 시리즈가 추가됐습니다", notices[0])
        self.shot(page, "combined")

    def test_arrivals_03_manual_switch_discards_held_poll_and_explicit_refresh_recovers(self):
        fixture = self.ct("ARRIVAL-STALE-" + uuid.uuid4().hex[:10], "current", "20260801")
        page = self.login(); self.select(page, fixture); self.manual(page)
        draft = "ARRIVAL HELD RESPONSE DRAFT"; page.locator("#findings").fill(draft)
        before = self.study_row(fixture); self.add_sop(fixture); held = []
        self.watch_notices(page)
        def hold(route):
            held.append((route, route.fetch()))
        page.route("**/api/studies?*", hold); self.automatic(page)
        deadline = time.monotonic() + 45
        while not held and time.monotonic() < deadline:
            page.wait_for_timeout(100)
        self.assertEqual(1, len(held))
        self.assertEqual(before["count"] + 1, self.study_row(fixture)["count"])
        page.locator("#worklist-refresh").select_option("0")
        held[0][0].fulfill(response=held[0][1]); page.wait_for_function("()=>!studyPageClient.busy")
        self.assertEqual(before["count"], page.evaluate("uid=>studies.find(s=>s.uid===uid).count", fixture.uid))
        expect(page.locator("#findings")).to_have_value(draft)
        self.assertEqual([], page.evaluate("arrivalNotices.filter(x=>x.includes('추가됐습니다'))"))
        page.unroute("**/api/studies?*", hold); page.locator("#refresh").click()
        self.wait_count(page, fixture, before["count"] + 1, before["series"])
        expect(page.locator("#findings")).to_have_value(draft)
        self.shot(page, "stale-recovered")

    def test_arrivals_04_multiframe_is_one_instance_new_series_and_unchanged_poll_does_not_repeat(self):
        current = self.ct("ARRIVAL-MULTI-" + uuid.uuid4().hex[:10], "current", "20260801")
        other = self.ct("ARRIVAL-OTHER-" + uuid.uuid4().hex[:10], "other", "20260701")
        page = self.login(); self.select(page, current); self.manual(page); self.watch_notices(page)
        before, isolated = self.study_row(current), self.study_row(other)
        multi = CineE2E.series(self, current, 14, "ARRIVAL fourteen-frame series")
        self.assertEqual(200, self.stack.request("POST", "/dicom/lookup", "doctor", {"studyUid": current.uid, "sopUid": multi["sops"][0]}).status)
        page.evaluate("arrivalNotices=[]")
        self.automatic(page); self.wait_count(page, current, before["count"] + 1, before["series"] + 1)
        page.wait_for_function("()=>arrivalNotices.length===1", timeout=5000)
        self.assertEqual([isolated["count"], isolated["series"]], page.evaluate("uid=>{const s=studies.find(x=>x.uid===uid);return [s.count,s.series]}", other.uid))
        first = page.evaluate("arrivalNotices.slice()")
        page.wait_for_timeout(35000)
        self.assertEqual(first, page.evaluate("arrivalNotices"))
        self.shot(page, "multiframe")


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(StudyArrivalsE2E(name) for name in StudyArrivalsE2E.__dict__ if name.startswith("test_arrivals_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
