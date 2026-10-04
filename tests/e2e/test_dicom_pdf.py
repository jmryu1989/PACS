# coding: utf-8
"""Native DICOM PDF display and explicit source-document opening boundaries."""
from __future__ import annotations

import io
import json
import time
import unittest
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import EncapsulatedPDFStorage, ExplicitVRLittleEndian, generate_uid
from pynetdicom import AE
from playwright.sync_api import expect
from pypdf import PdfReader

from test_viewer_layout import ViewerLayoutE2E


PDF_CLASS = str(EncapsulatedPDFStorage)


def synthetic_pdf(labels):
    """Return a small deterministic PDF with one extractable ASCII label per page."""
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", None,
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for label in labels:
        page_number = len(objects) + 1
        content_number = page_number + 1
        kids.append(f"{page_number} 0 R")
        escaped = label.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream = f"BT /F1 18 Tf 72 720 Td ({escaped}) Tj ET\n".encode("ascii")
        objects.extend([
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_number} 0 R >>".encode("ascii"),
            b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"endstream",
        ])
    objects[1] = f"<< /Type /Pages /Count {len(labels)} /Kids [{' '.join(kids)}] >>".encode("ascii")
    result = bytearray(b"%PDF-1.4\n%KINPDF\n"); offsets = [0]
    for number, body in enumerate(objects, 1):
        offsets.append(len(result)); result.extend(f"{number} 0 obj\n".encode("ascii") + body + b"\nendobj\n")
    xref = len(result); result.extend(f"xref\n0 {len(objects)+1}\n0000000000 65535 f \n".encode("ascii"))
    for offset in offsets[1:]: result.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    result.extend(f"trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii"))
    if len(result) % 2: result.extend(b"\n")
    return bytes(result)


class DicomPdfE2E(ViewerLayoutE2E):
    # Full Chromium's new headless mode renders PDFs; headless-shell downloads them.
    browser_channel = "chromium"

    def pdf_source(self, fixture, labels, title, mime="application/pdf", payload=None):
        original = pydicom.dcmread(io.BytesIO(self.stack.orthanc_bytes(
            "/instances/" + self.stack.first_instance_id(fixture.uid) + "/file")))
        series, sop = generate_uid(), generate_uid(); payload = synthetic_pdf(labels) if payload is None else payload
        if len(payload) % 2: payload += b"\n"
        meta = FileMetaDataset(); meta.TransferSyntaxUID = ExplicitVRLittleEndian
        meta.MediaStorageSOPClassUID = EncapsulatedPDFStorage; meta.MediaStorageSOPInstanceUID = sop
        meta.ImplementationClassUID = generate_uid()
        data = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
        for key in ("PatientName", "PatientID", "PatientBirthDate", "PatientSex", "InstitutionName",
                    "StudyInstanceUID", "StudyDate", "StudyTime", "AccessionNumber", "StudyID", "StudyDescription"):
            setattr(data, key, getattr(original, key, ""))
        data.is_little_endian, data.is_implicit_VR = True, False
        data.SOPClassUID, data.SOPInstanceUID = EncapsulatedPDFStorage, sop
        data.SeriesInstanceUID, data.Modality, data.SeriesNumber, data.InstanceNumber = series, "DOC", 70, 1
        data.SpecificCharacterSet = "ISO_IR 192"; data.SeriesDescription = data.DocumentTitle = title
        data.ContentDate, data.ContentTime, data.BurnedInAnnotation = "20260912", "120000", "NO"
        data.ConversionType, data.MIMETypeOfEncapsulatedDocument = "WSD", mime
        data.EncapsulatedDocument = payload
        ae = AE(ae_title="HALLYM_CT"); ae.add_requested_context(EncapsulatedPDFStorage, ExplicitVRLittleEndian)
        assoc = ae.associate("127.0.0.1", 4242, ae_title="KINLAB"); self.assertTrue(assoc.is_established)
        try: self.assertEqual(assoc.send_c_store(data).Status, 0)
        finally: assoc.release()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            found = self.stack._orthanc_request("POST", "/tools/lookup", sop.encode("ascii"))
            if found.status == 200 and any(row.get("Type") == "Instance" for row in found.body): break
            time.sleep(.25)
        else: self.fail("Synthetic PDF did not reach Orthanc")
        return dict(study=fixture.uid, series=series, sop=sop, title=title, mime=mime,
                    payload=payload, labels=labels,
                    pdf="/instances/" + next(row["ID"] for row in found.body if row.get("Type")=="Instance") + "/pdf",
                    rendered=f"/dicom-web/studies/{fixture.uid}/series/{series}/instances/{sop}/rendered")

    def launch_pdf_viewer(self, worklist, fixtures):
        page = worklist.context.new_page()
        # The raw /instances/{id}/pdf address answers only a session-bound request, and the viewer shows the bytes it
        # read as a blob of its own. What each document shows is therefore checked on the viewer's own reads.
        self.pdf_reads = reads = []
        page.on("response", lambda response: reads.append(response)
                if response.request.method == "GET" and urlsplit(response.url).path.endswith("/pdf") else None)
        page.goto(self.stack.proxy + "/ohif/viewer?StudyInstanceUIDs=" + ",".join(f.uid for f in fixtures))
        page.wait_for_function("()=>typeof services==='object' && services.displaySetService.getActiveDisplaySets().length>0", timeout=60000)
        self.open_layout_tools(page)
        return page

    def display_set(self, page, source):
        page.wait_for_function("s=>services.displaySetService.getActiveDisplaySets().some(d=>d.SOPInstanceUID===s)", arg=source["sop"], timeout=60000)
        return page.evaluate("""s=>{const d=services.displaySetService.getActiveDisplaySets().find(x=>x.SOPInstanceUID===s);
          return {id:d.displaySetInstanceUID,handler:d.SOPClassHandlerId,study:d.StudyInstanceUID,series:d.SeriesInstanceUID,sop:d.SOPInstanceUID};}""", source["sop"])

    def place(self, page, source, index=0):
        display = self.display_set(page, source)
        page.evaluate("""([id,index])=>{const grid=services.viewportGridService,state=grid.getState();
          const cells=[...state.viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x),viewportId=cells[index].viewportId;
          grid.setDisplaySetsForViewport({viewportId,displaySetInstanceUIDs:[id]});grid.setActiveViewportId(viewportId);}""", [display["id"], index])
        return display

    def object_url(self, page, index=0, expected=None):
        """The native PDF object's address: a blob of this origin that the viewer still owns."""
        obj = page.locator('[data-cy=viewport-grid] > div').nth(index).locator('object[type="application/pdf"]')
        expect(obj).to_be_attached(timeout=60000)
        if expected:
            page.wait_for_function("([node,url])=>node.data===url", arg=[obj.element_handle(),expected], timeout=60000)
        else:
            page.wait_for_function("node=>node.data.startsWith('blob:'+location.origin+'/')&&KinViewerResource.has(node.data)",
                                   arg=obj.element_handle(), timeout=60000)
        return obj.evaluate("node=>node.data")

    def read_paths(self):
        return {urlsplit(response.url).path for response in self.pdf_reads}

    def bound_read(self, page, source):
        """The viewer's own session-bound read of this source."""
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            found = [response for response in self.pdf_reads if urlsplit(response.url).path == source["pdf"]]
            if found: return found[-1]
            page.wait_for_timeout(100)
        self.fail("The viewer did not read the source PDF")

    def wait_until(self, page, ready, message):
        """A route handler runs after the request event; wait for what it records instead of reading it at once."""
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if ready(): return
            page.wait_for_timeout(50)
        self.fail(message)

    def source_dialog(self, page):
        return page.locator('dialog:has(iframe[title="Source PDF"])')

    def assert_source_dialog(self, page, pages):
        """Source PDF opened inside the viewer on a viewer-owned blob; no window was created."""
        dialog = self.source_dialog(page); expect(dialog).to_be_visible(timeout=30000)
        address = dialog.locator("iframe").get_attribute("src")
        self.assertTrue(address.startswith("blob:" + self.stack.proxy + "/"), address)
        self.assertTrue(page.evaluate("url=>KinViewerResource.has(url)", address))
        self.assertEqual(len(page.context.pages), pages)
        return dialog, address

    def close_source_dialog(self, page, dialog, address):
        dialog.get_by_role("button", name="Close").click(); expect(dialog).to_have_count(0)
        self.assertFalse(page.evaluate("url=>KinViewerResource.has(url)", address))

    def assert_preserved(self, worklist, fixture, draft, rows, originals, holder):
        expect(worklist.locator("#findings")).to_have_value(draft)
        self.assertEqual(self.state(fixture).get("holder"), holder)
        self.assertEqual(self.report_rows(fixture), rows); self.assertEqual(self.originals(), originals)

    def test_pdf_01_native_handler_object_and_exact_three_page_source(self):
        fixture = self.ct("PDF-NATIVE-" + uuid.uuid4().hex[:12], "current", "20260801")
        source = self.pdf_source(fixture, ["KIN PDF PAGE 1", "KIN PDF PAGE 2", "KIN PDF PAGE 3"], "PDF Three Pages")
        self.seed_report(fixture); draft = "PDF PRIVATE DRAFT"
        self.assertEqual(self.stack.request("POST", f"/studies/{fixture.uid}/hold", "doctor").status, 201)
        saved = self.stack.request("PUT", f"/studies/{fixture.uid}/report", "doctor",
                                   {"baseVersion":1,"findings":draft,"conclusion":"","recommendation":""})
        self.assertEqual(saved.status,200,saved.text); rows = self.report_rows(fixture)
        work = self.login(); self.select(work, fixture)
        expect(work.locator("#findings")).to_have_value(draft)
        self.assertEqual(self.state(fixture)['draft']['findings'],draft)
        originals = self.originals(); holder = self.state(fixture)["holder"]
        page = self.launch_pdf_viewer(work, [fixture]); display = self.place(page, source)
        self.assertEqual(display, dict(id=display["id"], handler="@ohif/extension-dicom-pdf.sopClassHandlerModule.dicom-pdf",
                                      study=source["study"], series=source["series"], sop=source["sop"]))
        self.object_url(page)
        response = self.bound_read(page, source); self.assertEqual(response.status, 200)
        self.assertEqual(self.read_paths(), {source["pdf"]})
        self.assertTrue(response.headers.get("content-type", "").startswith("application/pdf")); self.assertEqual(response.body(), source["payload"])
        pdf = PdfReader(io.BytesIO(response.body())); self.assertEqual(len(pdf.pages), 3)
        self.assertEqual([p.extract_text().strip() for p in pdf.pages], source["labels"])
        expect(page.locator("#kin-source-pdf")).to_be_visible(); expect(page.locator("#kin-source-pdf")).to_contain_text("Current source PDF")
        expect(page.locator("#kin-source-pdf-open")).to_be_enabled()
        self.assert_preserved(work, fixture, draft, rows, originals, holder)
        self.shot(page,"source-pdf-native")

    def test_pdf_02_two_native_pdf_cells_replace_and_late_source_resolution(self):
        fixture = self.ct("PDF-TWO-" + uuid.uuid4().hex[:12], "current", "20260801")
        first = self.pdf_source(fixture, ["FIRST PDF PAGE 1", "FIRST PDF PAGE 2"], "PDF First")
        second = self.pdf_source(fixture, ["SECOND PDF PAGE 1", "SECOND PDF PAGE 2"], "PDF Second")
        page = self.launch_pdf_viewer(self.login(), [fixture]); self.grid(page, 2)
        # Each cell's blob is made from the one read that its placement caused, so the order of reads says which
        # document a cell shows.
        self.place(page, first, 0); first_url = self.object_url(page, 0)
        self.assertEqual(self.read_paths(), {first["pdf"]}); self.assertEqual(self.bound_read(page, first).body(), first["payload"])
        self.place(page, second, 1); second_url = self.object_url(page, 1)
        self.assertEqual(self.read_paths(), {first["pdf"], second["pdf"]}); self.assertEqual(self.bound_read(page, second).body(), second["payload"])
        page.wait_for_function("()=>document.querySelectorAll('object[type=\"application/pdf\"]').length===2", timeout=60000)
        self.assertNotEqual(first_url, second_url); self.assertEqual(self.object_url(page, 0, first_url), first_url)
        expect(page.locator("#kin-source-pdf")).to_contain_text("PDF Second")
        page.evaluate("""s=>{const d=services.displaySetService.getActiveDisplaySets().find(x=>x.SOPInstanceUID===s),original=d.pdfUrl;
          window.pdfLate=new Promise(resolve=>window.releasePdfLate=()=>resolve(original));d.pdfUrl=window.pdfLate;}""", first["sop"])
        self.place(page, first, 1); expect(page.locator("#kin-source-pdf")).to_contain_text("PDF First")
        page.wait_for_function("""()=>{const cell=document.querySelectorAll('[data-cy=viewport-grid] > div')[1],object=cell?.querySelector('object[type="application/pdf"]');return object&&!object.data;}""")
        # A read document retires with the element that showed it: the replaced cell's blob is gone, and showing
        # the second document again reads it again.
        page.wait_for_function("url=>!KinViewerResource.has(url)", arg=second_url, timeout=60000)
        before = len(self.pdf_reads)
        self.place(page, second, 1); second_url = self.object_url(page, 1)
        self.assertEqual([urlsplit(item.url).path for item in self.pdf_reads[before:]], [second["pdf"]])
        self.assertEqual(self.pdf_reads[-1].body(), second["payload"])
        page.evaluate("""()=>{const cell=document.querySelectorAll('[data-cy=viewport-grid] > div')[1];window.pdfObserved=[];window.pdfObserver=new MutationObserver(()=>{const url=cell.querySelector('object[type="application/pdf"]')?.data;if(url)pdfObserved.push(url)});pdfObserver.observe(cell,{subtree:true,childList:true,attributes:true,attributeFilter:['data']});releasePdfLate();}""")
        page.wait_for_timeout(250)
        expect(page.locator("#kin-source-pdf")).to_contain_text("PDF Second")
        self.assertEqual(self.object_url(page, 1), second_url)
        self.assertTrue(all(url==second_url for url in page.evaluate('pdfObserved')))
        page.evaluate('pdfObserver.disconnect()')
        self.shot(page,"source-pdf-two-cells")

    def test_pdf_03_in_viewer_document_access_sequence_stale_and_denied_sop_splice(self):
        fixture = self.ct("PDF-OPEN-" + uuid.uuid4().hex[:12], "current", "20260801")
        source = self.pdf_source(fixture, ["OPEN PDF PAGE 1", "OPEN PDF PAGE 2"], "PDF Explicit Open")
        denied_fixture = self.fixture(institution="KIN 판독센터", patient_id="PDF-DENIED-" + uuid.uuid4().hex[:12])
        denied = self.pdf_source(denied_fixture, ["DENIED PDF"], "PDF Denied")
        denied_reply = self.stack.request("POST", "/dicom/lookup", "doctor", {"studyUid": fixture.uid, "sopUid": denied["sop"]})
        self.assertEqual(denied_reply.status, 403)
        page = self.launch_pdf_viewer(self.login(), [fixture]); self.place(page, source)
        expect(page.locator("#kin-source-pdf-open")).to_be_enabled(); held = []; requests = []
        def observe(request):
            path = urlsplit(request.url).path
            if path in ("/api/me", "/api/dicom/lookup", "/api/studies", source["pdf"]):
                requests.append((request.method, path, request.post_data_json if request.method == "POST" else None))
        native_url = self.object_url(page); pages = len(page.context.pages)
        page.on("request", observe)
        page.route("**/api/me", lambda route: held.append(route) if not held else route.continue_())
        with page.expect_request(lambda request: request.method == "GET" and urlsplit(request.url).path == "/api/me") as first_me:
            page.locator("#kin-source-pdf-open").click()
        self.assertEqual(urlsplit(first_me.value.url).path, "/api/me")
        self.wait_until(page, lambda: len(held) == 1, "The first account check of the explicit open was not held")
        # Nothing is shown and no window exists until the account, the source and the patient were checked.
        expect(self.source_dialog(page)).to_have_count(0); self.assertEqual(len(page.context.pages), pages)
        held[0].fulfill(response=held[0].fetch())
        dialog, address = self.assert_source_dialog(page, pages)
        expected = [("GET", "/api/me", None),
            ("POST", "/api/dicom/lookup", {"studyUid": source["study"], "sopUid": source["sop"]}),
            ("GET", "/api/studies", None), ("GET", source["pdf"], None), ("GET", "/api/me", None)]
        step = 0
        for item in requests:
            if step < len(expected) and item == expected[step]: step += 1
        self.assertEqual(step, len(expected), requests)
        self.assertEqual([item for item in requests if item[1] == source["pdf"]], [("GET", source["pdf"], None)])
        self.assertEqual(self.bound_read(page, source).body(), source["payload"])
        expect(page.locator("#kin-source-pdf [data-patient]")).to_have_text("Verified Patient ID: " + fixture.patient_id)
        self.assertEqual(self.object_url(page), native_url); self.assertNotEqual(address, native_url)
        self.close_source_dialog(page, dialog, address); page.unroute("**/api/me")
        # A source replacement while lookup is held shows nothing: the answer belongs to a document no longer selected.
        waiting = []; page.route("**/api/dicom/lookup", lambda route: waiting.append(route))
        with page.expect_request("**/api/dicom/lookup"):
            page.locator("#kin-source-pdf-open").click()
        self.wait_until(page, lambda: len(waiting) == 1, "The lookup of the explicit open was not held")
        ct = page.evaluate("""()=>services.displaySetService.getActiveDisplaySets().find(d=>d.SOPClassHandlerId==='@ohif/extension-default.sopClassHandlerModule.stack').displaySetInstanceUID""")
        page.evaluate("""id=>{const g=services.viewportGridService,v=g.getState().activeViewportId;g.setDisplaySetsForViewport({viewportId:v,displaySetInstanceUIDs:[id]});}""", ct)
        waiting[0].fulfill(response=waiting[0].fetch()); expect(page.locator("#kin-source-pdf")).to_be_hidden()
        expect(self.source_dialog(page)).to_have_count(0); self.assertEqual(len(page.context.pages), pages)
        page.unroute("**/api/dicom/lookup"); self.place(page, source); expect(page.locator("#kin-source-pdf-open")).to_be_enabled()
        page.route("**/api/dicom/lookup", lambda route: route.fulfill(status=denied_reply.status, body=denied_reply.text))
        page.locator("#kin-source-pdf-open").click()
        expect(page.locator("#kin-source-pdf-status")).to_contain_text("로그인 또는 검사 접근 권한")
        expect(self.source_dialog(page)).to_have_count(0); self.assertEqual(len(page.context.pages), pages)
        page.unroute("**/api/dicom/lookup")

    def test_pdf_04_wrong_mime_malformed_bytes_and_failure_guidance(self):
        fixture = self.ct("PDF-FAIL-" + uuid.uuid4().hex[:12], "current", "20260801")
        wrong = self.pdf_source(fixture, ["WRONG MIME"], "PDF Wrong MIME", mime="text/plain")
        malformed = self.pdf_source(fixture, [], "PDF Malformed", payload=b"not a pdf document\n")
        # The source opens inside the viewer, so a browser that refuses new windows changes nothing; a call would be counted.
        worklist = self.login(); worklist.context.add_init_script("window.pdfWindowCalls=0;window.open=()=>{window.pdfWindowCalls++;return null}")
        page = self.launch_pdf_viewer(worklist, [fixture]); self.place(page, wrong)
        expect(page.locator("#kin-source-pdf")).to_be_visible()
        expect(page.locator("#kin-source-pdf [data-title]")).to_be_empty()
        expect(page.locator("#kin-source-pdf [data-role]")).to_be_empty()
        expect(page.locator("#kin-source-pdf [data-patient]")).to_be_empty()
        expect(page.locator("#kin-source-pdf-status")).to_have_text(
            "선택한 원본 PDF를 지원하지 않거나 식별 정보가 일치하지 않습니다.")
        expect(page.locator("#kin-source-pdf-open")).to_be_disabled()
        self.place(page, malformed); expect(page.locator("#kin-source-pdf-open")).to_be_enabled()
        # Core 1.12.5 returns malformed bytes as PDF. Native browser error controls
        # are not asserted here; the MIME check of the read does not validate PDF syntax.
        response = self.bound_read(page, malformed)
        self.assertEqual(response.status,200); self.assertTrue(response.headers.get('content-type','').startswith('application/pdf'))
        self.assertEqual(response.body(), malformed['payload'])
        lookup=self.stack.request('POST','/dicom/lookup','doctor',{'studyUid':fixture.uid,'sopUid':malformed['sop']})
        self.assertEqual(lookup.status,200,lookup.text)
        stored=pydicom.dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/'+lookup.body['id']+'/file')))
        self.assertEqual(stored.EncapsulatedDocument,malformed['payload'])
        with self.assertRaises(Exception): PdfReader(io.BytesIO(stored.EncapsulatedDocument))
        pages = len(page.context.pages); before = len(self.pdf_reads)
        page.locator("#kin-source-pdf-open").click()
        dialog, address = self.assert_source_dialog(page, pages)
        self.assertEqual(page.evaluate("pdfWindowCalls"), 0)
        self.assertEqual([urlsplit(item.url).path for item in self.pdf_reads[before:]], [malformed["pdf"]])
        self.assertEqual(self.pdf_reads[-1].body(), malformed["payload"])
        self.close_source_dialog(page, dialog, address)
        page.evaluate("""s=>{const d=services.displaySetService.getActiveDisplaySets().find(x=>x.SOPInstanceUID===s);d.pdfUrl=Promise.reject(Error('원본 PDF 경로를 확인할 수 없습니다.'));}""", malformed["sop"])
        ct = page.evaluate("""()=>services.displaySetService.getActiveDisplaySets().find(d=>d.SOPClassHandlerId==='@ohif/extension-default.sopClassHandlerModule.stack').displaySetInstanceUID""")
        page.evaluate("""id=>{const g=services.viewportGridService,v=g.getState().activeViewportId;g.setDisplaySetsForViewport({viewportId:v,displaySetInstanceUIDs:[id]});}""", ct)
        self.place(page, malformed); expect(page.locator("#kin-source-pdf-status")).to_contain_text("원본 PDF 경로")


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(DicomPdfE2E(name) for name in loader.getTestCaseNames(DicomPdfE2E) if name.startswith("test_pdf_"))


if __name__ == "__main__": unittest.main(verbosity=2)
