# coding: utf-8
"""FC-076 Attach Document on the served stack: a radiologist attaches a JPG and a PDF from the Radiology row menu of the
real worklist; the viewer shows the picture as a Secondary Capture series that draws and the PDF in its document handler
with the uploaded bytes; an administrator's withdrawal keeps the originals in the archive and takes both out of the
viewer's series, the SOP lookup and the worklist's counts.

Run in CI: `python tests/measurement_ci.py --profile attach-document` (validate.yml worklist-ux-measurements); on a
development stack: `python tests/e2e/test_attach_document.py`. Synthetic only: a run-unique study; cleanup removes its
attachment rows and their audit rows (the study fixture's own cleanup removes the study and its objects).
"""
from __future__ import annotations

import base64
import io
import re
import unittest
import uuid

import pydicom
from playwright.sync_api import expect

from invariants_live import AUDIT_GUARD_OFF, AUDIT_GUARD_ON, psql
from test_dicom_pdf import DicomPdfE2E, PDF_CLASS, synthetic_pdf


class AttachDocumentE2E(DicomPdfE2E):
    # FC-076: a 16x8 synthetic JPEG (one flat colour) as a PC picture or scanner output would be.
    ATTACH_JPEG = base64.b64decode(
        "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDgKKKK+eP2E//Z")

    @staticmethod
    def known_png():
        """A 4x2 RGB PNG whose eight pixels are distinct, known colours; returns the PNG and its pixels row by row."""
        import struct, zlib
        colours = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0), (0, 255, 255), (255, 0, 255), (40, 80, 120), (250, 200, 10)]
        pixels = b"".join(bytes(c) for c in colours)
        raw = b"".join(b"\x00" + pixels[y * 12:(y + 1) * 12] for y in range(2))
        chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
        png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 2, 8, 2, 0, 0, 0))
               + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
        return png, pixels

    def attached_rows(self, uid):
        if not re.fullmatch(r"[0-9.]+", uid): raise RuntimeError("Refusing an unexpected synthetic value in SQL")
        rows = psql(f"""SELECT "fileName" || '|' || kind || '|' || id || '|' || "sopInstanceUid" || '|' || "seriesInstanceUid" || '|'
          || coalesce("orthancId",'') || '|' || state FROM "StudyAttachment" WHERE uid='{uid}' ORDER BY "fileName";""")
        return {row.split("|")[0]: dict(zip(("name", "kind", "id", "sop", "series", "orthanc", "state"), row.split("|"))) for row in rows if row}

    def shown_pixels(self, page, sop, size):
        """Wait until the active viewport shows `sop` at `size`; return the first pixels of the image it decoded."""
        page.wait_for_function("""([s,w,h])=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);
          const id=v?.getCurrentImageId?.(); const d=id&&v.getImageData?.()?.dimensions; return !!id&&id.includes(s)&&!!d&&d[0]===w&&d[1]===h;}""",
                               arg=[sop, size[0], size[1]], timeout=60000)
        return page.evaluate("""()=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);
          const image=v.getCornerstoneImage?.()||v.csImage; return Array.from(image.getPixelData().slice(0,24));}""")

    def test_attach_01_jpg_png_and_pdf_open_in_the_viewer_and_a_withdrawal_takes_them_out(self):
        """FC-076 live: a radiologist attaches a JPG, a PNG of known pixels and a PDF from the Radiology row menu; Orthanc
        holds the PNG's pixels exactly and the viewer decodes them for the attached SOP; the JPG is a Secondary Capture
        stack at its size; the PDF opens with its bytes. After the withdrawal none is offered, the SOP lookup is refused
        and the worklist counts are back."""
        fixture = self.ct("ATTACH-" + uuid.uuid4().hex[:12], "current", "20260801")
        def cleanup():
            if not re.fullmatch(r"[0-9.]+", fixture.uid): raise RuntimeError("Refusing an unexpected synthetic value in SQL")
            psql(f"""BEGIN; DELETE FROM "StudyAttachment" WHERE uid='{fixture.uid}'; {AUDIT_GUARD_OFF}
              DELETE FROM "AuditLog" WHERE target='{fixture.uid}' AND action LIKE 'study.attachment.%'; {AUDIT_GUARD_ON} COMMIT;""")
        self.addCleanup(cleanup)
        pdf = synthetic_pdf(["KIN ATTACHED PAGE 1"])
        known, known_pixels = self.known_png()
        work = self.login(); row = self.select(work, fixture)
        counts = lambda answer: next((s["series"], s["count"]) for s in answer.body["studies"] if s["uid"] == fixture.uid)
        series_before = counts(self.stack.request("GET", "/studies?uids=" + fixture.uid, "doctor"))
        box = row.evaluate("tr => { const r = tr.getBoundingClientRect(); return { x: r.x, y: r.y }; }")
        row.dispatch_event("contextmenu", {"clientX": box["x"] + 5, "clientY": box["y"] + 5, "button": 2})
        item = work.locator("#ctx [data-i]").filter(has_text=re.compile("^Attach Document$"))
        with work.expect_file_chooser() as chooser:
            item.click()
        chooser.value.set_files([{"name": "scan.jpg", "mimeType": "image/jpeg", "buffer": self.ATTACH_JPEG},
                                 {"name": "known.png", "mimeType": "image/png", "buffer": known},
                                 {"name": "referral.pdf", "mimeType": "application/pdf", "buffer": pdf}])
        dialog = work.locator("#attach-document")
        expect(dialog).to_be_visible()
        dialog.locator("#attach-send").click()
        expect(dialog.locator(".attach-files .attach-result")).to_have_text(["Attached"] * 3, timeout=60000)
        expect(dialog.locator(".attach-attached li")).to_have_count(3)
        rows = self.attached_rows(fixture.uid)
        self.assertEqual({"scan.jpg": "stored", "known.png": "stored", "referral.pdf": "stored"}, {k: r["state"] for k, r in rows.items()})
        self.assertEqual((series_before[0] + 3, series_before[1] + 3),
                         counts(self.stack.request("GET", "/studies?uids=" + fixture.uid, "doctor")), "one series of one image each")
        stored = pydicom.dcmread(io.BytesIO(self.stack.orthanc_bytes(f"/instances/{rows['referral.pdf']['orthanc']}/file")))
        self.assertEqual((str(stored.SOPClassUID), stored.SeriesDescription), (PDF_CLASS, "Attached Document"))
        self.assertEqual(stored.EncapsulatedDocument.rstrip(b"\0"), pdf.rstrip(b"\0"))
        picture = pydicom.dcmread(io.BytesIO(self.stack.orthanc_bytes(f"/instances/{rows['scan.jpg']['orthanc']}/file")))
        self.assertEqual((str(picture.SOPClassUID), picture.Rows, picture.Columns), ("1.2.840.10008.5.1.4.1.1.7", 8, 16))
        self.assertEqual(str(picture.StudyInstanceUID), fixture.uid)
        exact = pydicom.dcmread(io.BytesIO(self.stack.orthanc_bytes(f"/instances/{rows['known.png']['orthanc']}/file")))
        self.assertEqual((exact.Rows, exact.Columns, exact.SamplesPerPixel), (2, 4, 3))
        self.assertEqual(bytes(exact.PixelData)[:len(known_pixels)], known_pixels, "Orthanc holds the PNG's pixels exactly")
        dialog.locator("#attach-cancel").click()
        # The viewer: each picture is a stack series showing its own SOP; the PNG's decoded pixels are the known ones.
        page = self.launch_pdf_viewer(work, [fixture])
        image = self.place(page, {"sop": rows["scan.jpg"]["sop"]})
        self.assertEqual(image["handler"], "@ohif/extension-default.sopClassHandlerModule.stack")
        self.shown_pixels(page, rows["scan.jpg"]["sop"], (16, 8))
        self.place(page, {"sop": rows["known.png"]["sop"]})
        self.assertEqual(list(known_pixels), self.shown_pixels(page, rows["known.png"]["sop"], (4, 2)), "the viewer decodes the attached pixels")
        document = self.place(page, {"sop": rows["referral.pdf"]["sop"]})
        self.assertEqual(document["handler"], "@ohif/extension-dicom-pdf.sopClassHandlerModule.dicom-pdf")
        self.object_url(page)
        source = {"pdf": f"/instances/{rows['referral.pdf']['orthanc']}/pdf"}
        read = self.bound_read(page, source)
        self.assertEqual(read.status, 200); self.assertEqual(read.body().rstrip(b"\0"), pdf.rstrip(b"\0"))
        page.close()
        # The withdrawal (an administrator of the owning institution) keeps the originals and takes them out.
        for name in rows:
            answer = self.stack.request("POST", f"/studies/{fixture.uid}/attachments/{rows[name]['id']}/withdraw", "jmryu",
                                        {"reason": "SYN wrong document"})
            self.assertEqual(answer.status, 200, answer.text)
        self.assertEqual({"withdrawn"}, {r["state"] for r in self.attached_rows(fixture.uid).values()})
        self.assertEqual(series_before, counts(self.stack.request("GET", "/studies?uids=" + fixture.uid, "doctor")))
        self.assertEqual(200, self.stack._orthanc_request("GET", f"/instances/{rows['referral.pdf']['orthanc']}").status, "the original stays")
        page = self.launch_pdf_viewer(work, [fixture])
        offered = page.evaluate("()=>services.displaySetService.getActiveDisplaySets().map(d=>d.SOPInstanceUID)")
        for name in rows: self.assertNotIn(rows[name]["sop"], offered, name)
        page.close()
        for name in rows:
            lookup = self.stack.request("POST", "/dicom/lookup", "doctor", {"studyUid": fixture.uid, "sopUid": rows[name]["sop"]})
            self.assertEqual(403, lookup.status, f"a withdrawn {name} is not looked up for the viewer")


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(AttachDocumentE2E(name) for name in loader.getTestCaseNames(AttachDocumentE2E) if name.startswith("test_attach_"))


if __name__ == "__main__": unittest.main(verbosity=2)