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
                    rendered=f"/dicom-web/studies/{fixture.uid}/series/{series}/instances/{sop}/rendered")

    def launch_pdf_viewer(self, worklist, fixtures):
        page = worklist.context.new_page()
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
        obj = page.locator('[data-cy=viewport-grid] > div').nth(index).locator('object[type="application/pdf"]')
        expect(obj).to_be_attached(timeout=60000)
        if expected:
            page.wait_for_function("([node,url])=>node.data===url", arg=[obj.element_handle(),expected], timeout=60000)
        else:
            page.wait_for_function("node=>!!node.data", arg=obj.element_handle(), timeout=60000)
        return obj.evaluate("node=>node.data")

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
        url = self.object_url(page,expected=self.stack.proxy + source["rendered"]); self.assertEqual(url, self.stack.proxy + source["rendered"])
        response = page.context.request.get(url); self.assertEqual(response.status, 200)
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
        self.place(page, first, 0); self.place(page, second, 1)
        self.object_url(page, 0, self.stack.proxy + first["rendered"])
        self.object_url(page, 1, self.stack.proxy + second["rendered"])
        page.wait_for_function("()=>document.querySelectorAll('object[type=\"application/pdf\"]').length===2", timeout=60000)
        urls = page.locator('object[type="application/pdf"]').evaluate_all("nodes=>nodes.map(n=>n.data).sort()")
        self.assertEqual(urls, sorted([self.stack.proxy + first["rendered"], self.stack.proxy + second["rendered"]]))
        expect(page.locator("#kin-source-pdf")).to_contain_text("PDF Second")
        page.evaluate("""s=>{const d=services.displaySetService.getActiveDisplaySets().find(x=>x.SOPInstanceUID===s),original=d.pdfUrl;
          window.pdfLate=new Promise(resolve=>window.releasePdfLate=()=>resolve(original));d.pdfUrl=window.pdfLate;}""", first["sop"])
        self.place(page, first, 1); expect(page.locator("#kin-source-pdf")).to_contain_text("PDF First")
        page.wait_for_function("""()=>{const cell=document.querySelectorAll('[data-cy=viewport-grid] > div')[1],object=cell?.querySelector('object[type="application/pdf"]');return object&&!object.data;}""")
        self.place(page, second, 1)
        self.assertEqual(self.object_url(page, 1, self.stack.proxy + second["rendered"]), self.stack.proxy + second["rendered"])
        page.evaluate("""()=>{const cell=document.querySelectorAll('[data-cy=viewport-grid] > div')[1];window.pdfObserved=[];window.pdfObserver=new MutationObserver(()=>{const url=cell.querySelector('object[type="application/pdf"]')?.data;if(url)pdfObserved.push(url)});pdfObserver.observe(cell,{subtree:true,childList:true,attributes:true,attributeFilter:['data']});releasePdfLate();}""")
        page.wait_for_timeout(250)
        expect(page.locator("#kin-source-pdf")).to_contain_text("PDF Second")
        self.assertEqual(self.object_url(page, 1), self.stack.proxy + second["rendered"])
        self.assertTrue(all(url==self.stack.proxy+second['rendered'] for url in page.evaluate('pdfObserved')))
        page.evaluate('pdfObserver.disconnect()')
        self.shot(page,"source-pdf-two-cells")

    def test_pdf_03_blank_popup_access_sequence_stale_and_denied_sop_splice(self):
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
            if path in ("/api/me", "/api/dicom/lookup", "/api/studies") or path==source["rendered"] and request.headers.get('x-kin-csrf')=='1':
                requests.append((request.method, path, request.post_data_json if request.method == "POST" else None))
        page.on("request", observe)
        native_url = self.object_url(page)
        page.route("**/api/me", lambda route: held.append(route) if not held else route.continue_())
        with page.context.expect_page() as opened, page.expect_request(
                lambda request: request.method == "GET" and urlsplit(request.url).path == "/api/me") as first_me:
            page.locator("#kin-source-pdf-open").click()
        self.assertEqual(urlsplit(first_me.value.url).path, "/api/me"); self.assertEqual(len(held), 1)
        popup = opened.value; self.assertEqual(urlsplit(popup.url).scheme, "about"); self.assertTrue(popup.evaluate("opener===null"))
        held[0].fulfill(response=held[0].fetch()); popup.wait_for_url("**" + source["rendered"], timeout=30000)
        self.assertEqual(popup.url, self.stack.proxy + source["rendered"])
        self.assertEqual(requests[:5], [("GET", "/api/me", None),
            ("POST", "/api/dicom/lookup", {"studyUid": source["study"], "sopUid": source["sop"]}),
            ("GET", "/api/studies", None), ("GET", source["rendered"], None), ("GET", "/api/me", None)])
        expect(page.locator("#kin-source-pdf [data-patient]")).to_have_text("Verified Patient ID: " + fixture.patient_id)
        self.assertEqual(self.object_url(page), native_url); popup.close(); page.unroute("**/api/me")
        # A source replacement while lookup is held closes the already-created blank window.
        waiting = []; page.route("**/api/dicom/lookup", lambda route: waiting.append(route))
        with page.context.expect_page() as stale_opened, page.expect_request("**/api/dicom/lookup"):
            page.locator("#kin-source-pdf-open").click()
        stale = stale_opened.value; self.assertEqual(len(waiting), 1)
        ct = page.evaluate("""()=>services.displaySetService.getActiveDisplaySets().find(d=>d.SOPClassHandlerId==='@ohif/extension-default.sopClassHandlerModule.stack').displaySetInstanceUID""")
        page.evaluate("""id=>{const g=services.viewportGridService,v=g.getState().activeViewportId;g.setDisplaySetsForViewport({viewportId:v,displaySetInstanceUIDs:[id]});}""", ct)
        waiting[0].fulfill(response=waiting[0].fetch()); expect(page.locator("#kin-source-pdf")).to_be_hidden(); self.assertTrue(stale.is_closed())
        page.unroute("**/api/dicom/lookup"); self.place(page, source)
        page.route("**/api/dicom/lookup", lambda route: route.fulfill(status=denied_reply.status, body=denied_reply.text))
        with page.context.expect_page() as denied_opened: page.locator("#kin-source-pdf-open").click()
        expect(page.locator("#kin-source-pdf-status")).to_contain_text("로그인 또는 검사 접근 권한")
        self.assertTrue(denied_opened.value.is_closed()); page.unroute("**/api/dicom/lookup")

    def test_pdf_04_wrong_mime_malformed_bytes_and_failure_guidance(self):
        fixture = self.ct("PDF-FAIL-" + uuid.uuid4().hex[:12], "current", "20260801")
        wrong = self.pdf_source(fixture, ["WRONG MIME"], "PDF Wrong MIME", mime="text/plain")
        malformed = self.pdf_source(fixture, [], "PDF Malformed", payload=b"not a pdf document\n")
        worklist = self.login(); worklist.context.add_init_script("const pdfNativeOpen=window.open.bind(window);window.pdfBlockPopup=true;window.open=(...args)=>window.pdfBlockPopup?null:pdfNativeOpen(...args)")
        page = self.launch_pdf_viewer(worklist, [fixture]); self.place(page, wrong)
        expect(page.locator("#kin-source-pdf")).to_be_visible()
        expect(page.locator("#kin-source-pdf [data-title]")).to_be_empty()
        expect(page.locator("#kin-source-pdf [data-role]")).to_be_empty()
        expect(page.locator("#kin-source-pdf [data-patient]")).to_be_empty()
        expect(page.locator("#kin-source-pdf-status")).to_have_text(
            "선택한 원본 PDF를 지원하지 않거나 식별 정보가 일치하지 않습니다.")
        expect(page.locator("#kin-source-pdf-open")).to_be_disabled()
        self.place(page, malformed); expect(page.locator("#kin-source-pdf-open")).to_be_enabled()
        response = page.context.request.get(self.stack.proxy + malformed["rendered"])
        self.assertEqual(response.status,400); self.assertTrue(response.headers.get('content-type','').startswith('application/json'))
        lookup=self.stack.request('POST','/dicom/lookup','doctor',{'studyUid':fixture.uid,'sopUid':malformed['sop']})
        self.assertEqual(lookup.status,201,lookup.text)
        stored=pydicom.dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/'+lookup.body['id']+'/file')))
        self.assertEqual(stored.EncapsulatedDocument,malformed['payload'])
        with self.assertRaises(Exception): PdfReader(io.BytesIO(stored.EncapsulatedDocument))
        page.locator("#kin-source-pdf-open").click()
        expect(page.locator("#kin-source-pdf-status")).to_contain_text("팝업이 차단")
        page.evaluate('pdfBlockPopup=false')
        with page.context.expect_page() as corrupt_opened: page.locator('#kin-source-pdf-open').click()
        expect(page.locator('#kin-source-pdf-status')).to_contain_text('원본 PDF 응답을 확인할 수 없습니다.')
        self.assertTrue(corrupt_opened.value.is_closed())
        page.evaluate("""s=>{const d=services.displaySetService.getActiveDisplaySets().find(x=>x.SOPInstanceUID===s);d.pdfUrl=Promise.reject(Error('원본 PDF 경로를 확인할 수 없습니다.'));}""", malformed["sop"])
        ct = page.evaluate("""()=>services.displaySetService.getActiveDisplaySets().find(d=>d.SOPClassHandlerId==='@ohif/extension-default.sopClassHandlerModule.stack').displaySetInstanceUID""")
        page.evaluate("""id=>{const g=services.viewportGridService,v=g.getState().activeViewportId;g.setDisplaySetsForViewport({viewportId:v,displaySetInstanceUIDs:[id]});}""", ct)
        self.place(page, malformed); expect(page.locator("#kin-source-pdf-status")).to_contain_text("원본 PDF 경로")


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(DicomPdfE2E(name) for name in loader.getTestCaseNames(DicomPdfE2E) if name.startswith("test_pdf_"))


if __name__ == "__main__": unittest.main(verbosity=2)
