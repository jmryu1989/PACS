"""D03A additional live tests; run separately from the unchanged B2 14 tests.

python tests/e2e/test_prior_selection.py
Only new, owned synthetic CT studies are created and cleaned through the local guard.
"""
from __future__ import annotations

import hashlib
import re
import time
import unittest
import uuid
from urllib.parse import parse_qs, urlsplit

import numpy as np
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid
from pynetdicom import AE
from playwright.sync_api import expect

import test_worklist as base
from invariants_live import Fixture


def synthetic_ct(stack, patient, label, date, slices=16):
    """D00's asymmetric 256px phantom, with real StudyDate before C-STORE."""
    uid, series, frame = generate_uid(), generate_uid(), generate_uid()
    fixture = Fixture(uid, patient, "한림병원", "jmryu", "D03A-SYNTHETIC-" + label)
    # Register before the first write so any partial C-STORE is owned by cleanup.
    stack.active[uid] = fixture
    ae = AE(ae_title="HALLYM_CT")
    ae.add_requested_context(CTImageStorage, ExplicitVRLittleEndian)
    assoc = ae.associate("127.0.0.1", 4242, ae_title="KINLAB")
    if not assoc.is_established:
        raise RuntimeError("Local synthetic CT association failed")
    try:
        for z in range(slices):
            sop = generate_uid()
            meta = FileMetaDataset()
            meta.TransferSyntaxUID = ExplicitVRLittleEndian
            meta.MediaStorageSOPClassUID = CTImageStorage
            meta.MediaStorageSOPInstanceUID = sop
            meta.ImplementationClassUID = generate_uid()
            ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
            ds.is_little_endian, ds.is_implicit_VR = True, False
            ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, sop
            ds.SpecificCharacterSet = "ISO_IR 192"
            ds.PatientName, ds.PatientID = "D03A^SYNTHETIC", patient
            ds.PatientBirthDate, ds.PatientSex, ds.InstitutionName = "", "O", "한림병원"
            ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = uid, series, frame
            ds.StudyDate = ds.SeriesDate = date
            ds.StudyTime = ds.SeriesTime = "120000"
            ds.AccessionNumber, ds.StudyID = "D03A" + label, "D03A"
            ds.StudyDescription = ds.SeriesDescription = "D03A " + label
            ds.Modality, ds.SeriesNumber, ds.InstanceNumber = "CT", 1, z + 1
            ds.ImageType = ["ORIGINAL", "PRIMARY", "AXIAL"]
            ds.ImageOrientationPatient, ds.ImagePositionPatient = [1, 0, 0, 0, 1, 0], [0, 0, z * 2]
            ds.SliceLocation, ds.PixelSpacing = z * 2, [1, 1]
            ds.SliceThickness = ds.SpacingBetweenSlices = 2
            ds.Rows = ds.Columns = 256
            ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
            ds.BitsAllocated = ds.BitsStored = 16
            ds.HighBit, ds.PixelRepresentation = 15, 0
            ds.WindowCenter, ds.WindowWidth = -500, 1000
            ds.RescaleIntercept, ds.RescaleSlope, ds.RescaleType = -1000, 1, "HU"
            yy, xx = np.mgrid[:256, :256]
            pixels = np.where((xx - 125) ** 2 + (yy - 128) ** 2 < 95 ** 2, 300 + xx * 2, 0).astype(np.uint16)
            pixels[50:82, 45:88], pixels[145:171, 178:194], pixels[205:214, 60:120] = 950, 750, 500
            pixels[105:116, 35:45], pixels[190:200, 30:30 + (z + 1) * 9] = 1000, 1000
            ds.PixelData = pixels.astype("<u2").tobytes()
            status = assoc.send_c_store(ds)
            if status is None or status.Status != 0:
                raise RuntimeError("Synthetic CT C-STORE failed")
    finally:
        assoc.release()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        result = stack.request("GET", "/studies", "jmryu")
        if result.status == 200 and any(s.get("uid") == uid for s in result.body.get("studies", [])):
            break
        time.sleep(.25)
    else:
        raise RuntimeError("Synthetic CT did not reach the real API")
    if stack.request("PATCH", "/studies/" + uid, "jmryu", {"ss": "Verified"}).status != 200:
        raise RuntimeError("Synthetic CT verification failed")
    return fixture


def canvas_ready(page, count):
    page.wait_for_function("""count => {
        const cs = [...document.querySelectorAll('.cornerstone-canvas')];
        return cs.length === count && cs.every(c => {
            const ctx = c.getContext('2d');
            if (!ctx || !c.width || !c.height) return false;
            const d = ctx.getImageData(0, 0, c.width, c.height).data;
            let lo = 255, hi = 0;
            for (let i = 0; i < d.length; i += 16) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); }
            return hi - lo > 100;
        });
    }""", arg=count, timeout=60000)


class PriorSelectionE2E(base.WorklistE2E):
    def originals(self):
        hashes = {}
        for uid in self.stack.active:
            rows = self.stack._orthanc_request("POST", "/tools/lookup", uid.encode("ascii")).body
            orth_id = next(row["ID"] for row in rows if row["Type"] == "Study")
            for instance in self.stack._orthanc_request("GET", f"/studies/{orth_id}/instances").body:
                path = "/instances/" + instance["ID"] + "/file"
                hashes[path] = hashlib.sha256(self.stack.orthanc_bytes(path)).hexdigest()
        return hashes

    def viewer(self, page, row, expected):
        with page.context.expect_page(timeout=20000) as opened:
            row.dblclick()
        viewer = opened.value
        try:
            viewer.wait_for_url("**/ohif/viewer?**", timeout=30000)
            query = parse_qs(urlsplit(viewer.url).query)
            self.assertEqual(query["StudyInstanceUIDs"], [",".join(f.uid for f in expected)])
            self.assertEqual(query.get("hangingProtocolId"), ["@ohif/hpCompare"] if len(expected) == 2 else None)
            canvas_ready(viewer, len(expected))
            images = viewer.evaluate("""() => cornerstone.getRenderingEngines().filter(e => e.id !== '_thumbnails')
                .flatMap(e => e.getViewports().map(v => v.getCurrentImageId?.()))""")
            for fixture in expected:
                self.assertTrue(any(image and f"/studies/{fixture.uid}/" in image for image in images), fixture.uid)
                label = fixture.secret.rsplit("-", 1)[-1]
                expect(viewer.locator("body")).to_contain_text("D03A " + label)
                expect(viewer.locator("body")).to_contain_text({"past": "Jul 1, 2026", "current": "Aug 1, 2026", "future": "Sep 7, 2026"}[label])
            artifact = base.Path(__file__).parent / "artifacts"
            artifact.mkdir(exist_ok=True)
            viewer.screenshot(path=str(artifact / (self._testMethodName + "-" + expected[0].secret.rsplit("-", 1)[-1] + ".png")))
        finally:
            viewer.close()

    def test_d03a_past_current_future_real_dates(self):
        """TEST-D03A-PAST/COST: real StudyDate, actual pixels and exact selected image IDs."""
        patient = "D03A-" + uuid.uuid4().hex[:16]
        past = synthetic_ct(self.stack, patient, "past", "20260701")
        current = synthetic_ct(self.stack, patient, "current", "20260801")
        future = synthetic_ct(self.stack, patient, "future", "20260907")
        before = self.originals()
        page = self.login()
        for selected, expected in [(future, [future, current]), (current, [current, past]), (past, [past])]:
            row = self.select(page, selected)
            date = {past.uid: "2026-07-01", current.uid: "2026-08-01", future.uid: "2026-09-07"}[selected.uid]
            expect(row).to_contain_text(date)
            requests = []
            listener = lambda request: requests.append(request.url)
            page.on("request", listener)
            try:
                self.assertEqual(page.evaluate("uid => autoPrior(uid)", selected.uid), expected[1].uid if len(expected) == 2 else None)
            finally:
                page.remove_listener("request", listener)
            self.assertEqual(requests, [], "Selecting from already visible studies must not fetch")
            self.viewer(page, row, expected)
            self.assertEqual(self.state(selected)["rs"], "W")
            self.assertEqual(self.versions(selected), [])
            self.assertIsNone(self.state(selected).get("draft"))
        self.assertEqual(self.originals(), before)

    def test_d03a_manual_future_keeps_report_draft_and_history(self):
        """TEST-D03A-MANUAL: deliberate future comparison does not retarget reporting."""
        patient = "D03A-" + uuid.uuid4().hex[:16]
        current = synthetic_ct(self.stack, patient, "current", "20260801")
        future = synthetic_ct(self.stack, patient, "future", "20260907")
        self.seed_report(current)
        self.seed_report(future, action="approve")
        before = self.originals()
        history = {f.uid: self.versions(f) for f in [current, future]}
        page = self.login()
        self.select(page, current)
        draft = current.secret + " private draft"
        page.locator("#findings").fill(draft)
        page.locator("#quick").click()
        self.wait_state(page, current, lambda s: (s.get("draft") or {}).get("findings") == draft, timeout=25000)
        related = page.locator(f'#relrows tr[data-uid="{future.uid}"]')
        expect(related).to_contain_text("2026-09-07")
        self.viewer(page, related, [current, future])
        expect(page.locator(f'#rows tr[data-uid="{current.uid}"]')).to_have_class(re.compile(r"\bsel\b"))
        expect(page.locator("#findings")).to_have_value(draft)
        self.assertEqual(self.state(current)["findings"], current.secret)
        self.assertEqual(self.state(current)["draft"]["findings"], draft)
        self.assertIsNone(self.state(current, "doctor2").get("draft"))
        self.assertEqual(self.state(future)["rs"], "A")
        for fixture in [current, future]:
            self.assertEqual(self.versions(fixture), history[fixture.uid])
        self.assertEqual(self.originals(), before)


def load_tests(loader, tests, pattern):
    # Reuse the proven local guard/login/cleanup helpers without rerunning B2 here.
    return unittest.TestSuite(PriorSelectionE2E(name) for name in loader.getTestCaseNames(PriorSelectionE2E)
                              if name.startswith("test_d03a_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
