# coding: utf-8
"""REQ-D-SOURCE-PDF isolated DOM coverage; all network and windows are synthetic."""
import json
from pathlib import Path
import unittest

from playwright.sync_api import expect, sync_playwright
try:
    from viewer_session_fixture import install_viewer_session
except ImportError:
    from tests.viewer_session_fixture import install_viewer_session

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "worklist-v0" / "hpacs-lite" / "viewer-dicom-pdf.js"
CONFIG = ROOT / "config" / "ohif.js"
URL = "https://pdf.test/ohif/viewer?StudyInstanceUIDs=1.2,1.9"
RENDERED = "https://pdf.test/dicom-web/studies/1.2/series/1.3/instances/1.4/rendered"
ORTHANC_ID = "aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee"
PDF = f"https://pdf.test/instances/{ORTHANC_ID}/pdf"

HARNESS = r"""<!doctype html><html><body><main id="kin-viewer-layout"><object id="native-pdf"></object></main><script>
const HANDLER='@ohif/extension-dicom-pdf.sopClassHandlerModule.dicom-pdf',SOP='1.2.840.10008.5.1.4.1.1.104.1';
const makeSet=(over={})=>Object.assign({displaySetInstanceUID:'ds-pdf',SOPClassHandlerId:HANDLER,SOPClassUID:SOP,StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.4',SeriesDescription:'Source <img src=x onerror="bad=1">',pdfUrl:Promise.resolve('RENDERED'),instance:{SOPClassUID:SOP,StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.4',PatientID:'PID-001',MIMETypeOfEncapsulatedDocument:'application/pdf',EncapsulatedDocument:{BulkDataURI:'/bulk'}}},over);
let displaySet=makeSet(),view={viewportId:'vp1',displaySetInstanceUIDs:['ds-pdf']},subscribers=[],requests=[],cancels=[],popups=[],blockPopup=false,throwNavigation=false,holdPath=null,ignoreAbort=false,held=[],holdCancel=false,cancelHeld=[];
const owner={kind:'member',institution:'hospital',sub:'reader'},routes={
 '/api/me':()=>owner,
 '/api/dicom/lookup':()=>({id:'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee'}),
 '/api/studies':()=>({studies:[{uid:'1.2',id:'PID-001'}]}),
 'PDF_ROUTE':()=>({status:200,body:null,contentType:'application/pdf'})
};
const response=(status,value,url,contentType='application/json',headers={})=>new Response(new ReadableStream({start(controller){
 const finish=()=>{controller.enqueue(new TextEncoder().encode(contentType==='application/pdf'?'%PDF-1.4\n%%EOF':JSON.stringify(value)));controller.close()};
 if(holdCancel&&url==='PDF_ROUTE')cancelHeld.push(finish);else finish();},cancel(){cancels.push(url)}}),{status,headers:{'Content-Type':contentType,...headers}});
const nativeFetch=window.fetch.bind(window);
window.fetch=(url,options={})=>{if(String(url).startsWith('blob:'))return nativeFetch(url,options);if(!new Headers(options.headers).get('X-KIN-Session'))throw Error('Unbound protected request');requests.push({url,method:options.method||'GET',body:options.body?JSON.parse(options.body):null});
 const done=()=>{const configured=routes[url],value=typeof configured==='function'?configured():configured;return response(value?.status||200,value?.body??value,url,value?.contentType,value?.headers);};
 if(holdPath===url)return new Promise((resolve,reject)=>{const item={resolve:()=>resolve(done()),reject};held.push(item);if(!ignoreAbort)options.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});return Promise.resolve(done());};
window.open=()=>{if(blockPopup)return null;const popup={closed:false,opener:{unsafe:true},navigated:null,close(){this.closed=true},location:{replace(value){if(throwNavigation)throw Error('synthetic navigation detail');popup.navigated=value;}}};popups.push(popup);return popup;};
let state={activeViewportId:'vp1',viewports:new Map([['vp1',view]])};
// OHIF's grid provider hands the service a new state object after its event (React effect), without another event.
window.commitLater=(next,ms)=>setTimeout(()=>{displaySet=next.displaySet||displaySet;view={viewportId:'vp1',displaySetInstanceUIDs:[displaySet.displaySetInstanceUID]};state={activeViewportId:'vp1',viewports:new Map([['vp1',view]])};},ms);
window.services={viewportGridService:{EVENTS:{ACTIVE:'active',GRID:'grid'},getState:()=>state,getActiveViewportId:()=>state.activeViewportId,subscribe:(_,fn)=>{subscribers.push(fn);return {unsubscribe(){subscribers=subscribers.filter(x=>x!==fn)}}}},displaySetService:{getDisplaySetByUID:id=>id===displaySet.displaySetInstanceUID?displaySet:null}};
window.emit=()=>subscribers.forEach(fn=>fn());
window.mountPdf=(options={})=>{window.pdfController=KinDicomPdf.create(services,options);pdfController.mount();};
</script></body></html>""".replace("RENDERED", RENDERED).replace("PDF_ROUTE", PDF)


def extract_function(source, name):
    start = source.index(f"function {name}(")
    brace = source.index("{", start)
    depth, quote, escaped = 0, None, False
    for index in range(brace, len(source)):
        char = source[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in "'\"`":
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise ValueError(name)


class ViewerDicomPdfDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.page.route(URL, lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        self.page.goto(URL)
        self.unbound = install_viewer_session(self.page)
        self.page.add_script_tag(path=str(MODULE))
        self.page.evaluate("mountPdf()")
        expect(self.page.locator("#kin-source-pdf-open")).to_be_enabled()

    def tearDown(self):
        self.page.close()
        self.assertEqual(self.unbound, [])

    def test_coded_refusal_all_pdf_reads_allow_retry_plain_refusal_disables(self):
        button = self.page.locator('#kin-source-pdf-open')
        status = self.page.locator('#kin-source-pdf-status')
        for phase in ('resolve', 'verify', 'bytes'):
            for code in ('AUTH_IDP_UNAVAILABLE', 'AUTH_SESSION_BUSY', 'AUTH_STORAGE_FAILURE', None):
                with self.subTest(phase=phase, code=code):
                    self.page.evaluate("""({phase,code,pdf})=>{
                      pdfController.stop();
                      routes['/api/dicom/lookup']=()=>({id:'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee'});
                      routes[pdf]=()=>({status:200,body:null,contentType:'application/pdf'});
                      window.refusalPath=phase==='bytes'?pdf:'/api/dicom/lookup';
                      window.good=routes[refusalPath];window.bad=()=>({status:403,headers:code?{'X-KIN-Auth-Code':code}:{}});
                      if(phase==='resolve')routes[refusalPath]=bad;
                      mountPdf();
                    }""", {'phase': phase, 'code': code, 'pdf': PDF})
                    if phase != 'resolve':
                        expect(button).to_be_enabled()
                        self.page.evaluate('routes[refusalPath]=bad')
                        button.click()
                    if code:
                        expect(status).to_contain_text('연결을 확인하지 못했습니다')
                        expect(status).not_to_contain_text('권한')
                        expect(button).to_have_text('Retry Source PDF')
                        expect(button).to_be_enabled()
                        self.page.evaluate('routes[refusalPath]=good')
                        button.click()
                        if phase == 'resolve':
                            expect(button).to_have_text('Open Source PDF')
                        else:
                            expect(self.page.get_by_title('Source PDF', exact=True)).to_be_visible()
                            self.page.get_by_role('button', name='Close', exact=True).click()
                    else:
                        expect(status).to_contain_text('권한')
                        expect(button).to_be_disabled()
                        expect(button).not_to_have_text('Retry Source PDF')

    def test_selected_native_pdf_opens_exact_verified_source_and_preserves_embed(self):
        panel = self.page.locator("#kin-source-pdf")
        expect(panel).to_be_visible()
        expect(panel.locator("[data-title]")).to_have_text('Source <img src=x onerror="bad=1">')
        expect(panel.locator("[data-role]")).to_have_text("Current source PDF")
        self.assertEqual(0, panel.locator("img,script").count())
        self.assertIsNone(self.page.evaluate("window.bad"))
        self.assertEqual(1, self.page.locator("#native-pdf").count(), "the native embedded PDF is untouched")
        self.page.evaluate("requests=[]")
        self.page.locator("#kin-source-pdf-open").click()
        expect(panel.locator("[data-patient]")).to_have_text("Verified Patient ID: PID-001")
        expect(panel.locator("[role=status]")).to_contain_text("브라우저 PDF 도구")
        result = self.page.evaluate("()=>({requests,popups:popups.map(p=>({closed:p.closed,opener:p.opener,navigated:p.navigated}))})")
        self.assertEqual(["/api/me", "/api/dicom/lookup", "/api/studies", PDF, "/api/me"], [r["url"] for r in result["requests"]])
        self.assertEqual({"studyUid": "1.2", "sopUid": "1.4"}, result["requests"][1]["body"])
        self.assertEqual([], result['popups'])
        url = self.page.get_by_title('Source PDF', exact=True).get_attribute('src')
        self.assertTrue(url.startswith('blob:'))
        self.assertEqual(self.page.evaluate('u=>fetch(u).then(r=>r.text())', url), '%PDF-1.4\n%%EOF')
        self.page.get_by_role('button', name='Close', exact=True).click()
        self.assertFalse(self.page.evaluate('u=>KinViewerResource.has(u)', url))

    def test_open_rejects_a_lookup_id_spliced_after_source_resolution(self):
        initial = self.page.evaluate("requests.filter(r=>r.url==='/api/dicom/lookup').map(r=>r.body)")
        self.assertEqual([{"studyUid": "1.2", "sopUid": "1.4"}], initial)
        self.page.evaluate("routes['/api/dicom/lookup']=()=>({id:'11111111-22222222-33333333-44444444-55555555'})")
        self.page.locator("#kin-source-pdf-open").click()
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("원본 PDF 식별을 확인할 수 없습니다")
        self.assertEqual(0, self.page.locator('dialog[open]').count())
        self.assertNotIn(PDF, self.page.evaluate("requests.map(r=>r.url)"))

    def test_late_source_lookup_cannot_replace_a_new_selected_pdf(self):
        self.page.evaluate("""() => {
          holdPath='/api/dicom/lookup';ignoreAbort=true;
          displaySet=makeSet({displaySetInstanceUID:'held-source',SeriesDescription:'Held PDF'});
          view.displaySetInstanceUIDs=['held-source'];emit();
        }""")
        self.page.wait_for_function("() => held.length===1")
        self.page.evaluate("""() => {
          holdPath=null;
          displaySet=makeSet({displaySetInstanceUID:'new-source',SOPInstanceUID:'1.5',SeriesDescription:'New PDF',pdfUrl:Promise.resolve('https://pdf.test/dicom-web/studies/1.2/series/1.3/instances/1.5/rendered'),instance:{SOPClassUID:SOP,StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.5',PatientID:'PID-001',MIMETypeOfEncapsulatedDocument:'application/pdf',EncapsulatedDocument:{}}});
          view.displaySetInstanceUIDs=['new-source'];emit();
        }""")
        expect(self.page.locator("#kin-source-pdf-open")).to_be_enabled()
        self.page.evaluate("held.shift().resolve()")
        self.page.wait_for_timeout(0)
        expect(self.page.locator("#kin-source-pdf [data-title]")).to_have_text("New PDF")
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("Ready")

    def test_panel_follows_a_grid_state_that_arrives_after_its_event(self):
        # OHIF announces a grid change before its getState() returns the new cells (live dicom_pdf 02/04). A person who
        # puts another document, or a supported one after an unsupported one, in the cell sees that one in the panel.
        title, status = self.page.locator("#kin-source-pdf [data-title]"), self.page.locator("#kin-source-pdf-status")
        button = self.page.locator("#kin-source-pdf-open")
        late = ("makeSet({displaySetInstanceUID:'late-pdf',SOPInstanceUID:'1.5',SeriesDescription:'Late PDF',"
                "pdfUrl:Promise.resolve('https://pdf.test/dicom-web/studies/1.2/series/1.3/instances/1.5/rendered'),"
                "instance:{SOPClassUID:SOP,StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.5',PatientID:'PID-001',"
                "MIMETypeOfEncapsulatedDocument:'application/pdf',EncapsulatedDocument:{}}})")
        with self.subTest("another document"):
            self.page.evaluate("() => { emit(); commitLater({displaySet:" + late + "}, 200); }")
            expect(title).to_have_text("Late PDF"); expect(status).to_contain_text("Ready"); expect(button).to_be_enabled()
        with self.subTest("a supported document after an unsupported one"):
            self.page.evaluate("""() => { displaySet=makeSet({displaySetInstanceUID:'text-mime'});
              displaySet.instance.MIMETypeOfEncapsulatedDocument='text/plain'; view.displaySetInstanceUIDs=['text-mime']; emit(); }""")
            expect(status).to_have_text("선택한 원본 PDF를 지원하지 않거나 식별 정보가 일치하지 않습니다."); expect(button).to_be_disabled()
            self.page.evaluate("""() => { emit();
              commitLater({displaySet:makeSet({displaySetInstanceUID:'supported-pdf',SeriesDescription:'Supported PDF'})}, 200); }""")
            expect(title).to_have_text("Supported PDF"); expect(status).to_contain_text("Ready"); expect(button).to_be_enabled()

    def test_a_new_grid_state_with_the_same_selection_leaves_the_open_document_alone(self):
        button, patient = self.page.locator("#kin-source-pdf-open"), self.page.locator("#kin-source-pdf [data-patient]")
        button.click(); dialog = self.page.locator("dialog[open]"); expect(dialog).to_have_count(1)
        expect(patient).to_have_text("Verified Patient ID: PID-001")
        url = self.page.get_by_title('Source PDF', exact=True).get_attribute('src'); before = self.page.evaluate("requests.length")
        # An event, then a new state object holding the same cells (OHIF re-renders, e.g. when a viewport becomes ready).
        self.page.evaluate("() => { emit(); setTimeout(() => { state={activeViewportId:'vp1',viewports:new Map([['vp1',{...view}]])}; }, 100); }")
        self.page.wait_for_timeout(400)
        expect(dialog).to_have_count(1); self.assertTrue(self.page.evaluate("u=>KinViewerResource.has(u)", url))
        self.assertEqual(self.page.evaluate("requests.length"), before, "the same selection is not checked again")
        expect(patient).to_have_text("Verified Patient ID: PID-001"); expect(button).to_be_enabled()

    def test_source_timeout_exposes_retry_and_ignores_the_late_provider(self):
        self.page.evaluate("""() => {
          pdfController.stop();held=[];requests=[];holdPath='/api/dicom/lookup';ignoreAbort=true;window.nativeRetries=0;
          mountPdf({timeoutMs:30,onRetry:()=>nativeRetries++});
        }""")
        self.page.wait_for_function("() => held.length===1")
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("시간이 지났습니다")
        button=self.page.locator("#kin-source-pdf-open")
        expect(button).to_have_text("Retry Source PDF");expect(button).to_be_enabled()
        self.page.evaluate("holdPath=null");button.click()
        expect(button).to_have_text("Open Source PDF");expect(button).to_be_enabled()
        self.assertEqual(0,self.page.evaluate("nativeRetries"),"source retry must not restart the native resolver")
        self.assertEqual(2,self.page.evaluate("requests.filter(r=>r.url==='/api/dicom/lookup').length"))
        self.page.evaluate("held.shift().resolve()")
        self.page.wait_for_timeout(0)
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("Ready")

    def test_native_failure_retry_survives_grid_refresh_until_native_ready(self):
        self.page.evaluate("""() => {
          pdfController.stop();window.nativeRetries=0;
          mountPdf({onRetry:()=>nativeRetries++});
        }""")
        button = self.page.locator("#kin-source-pdf-open")
        expect(button).to_be_enabled()
        self.page.evaluate("pdfController.nativeFailure(Object.assign(Error('Synthetic native timeout'),{retryable:true}),displaySet,displaySet.pdfUrl)")
        self.page.evaluate("emit()")
        expect(button).to_have_text("Retry Source PDF")
        expect(button).to_be_enabled()
        expect(self.page.locator("#kin-source-pdf-status")).to_have_text("Synthetic native timeout")
        button.click()
        self.assertEqual(1, self.page.evaluate("nativeRetries"))
        expect(button).to_have_text("Retry Source PDF")
        expect(button).to_be_disabled()
        expect(self.page.locator("#kin-source-pdf-status")).to_have_text("Checking native PDF…")
        self.page.evaluate("emit()")
        expect(button).to_be_disabled()
        self.page.evaluate("pdfController.nativeReady(displaySet,displaySet.pdfUrl)")
        expect(button).to_have_text("Open Source PDF")
        expect(button).to_be_enabled()
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("Ready")
        self.assertEqual([], self.page.evaluate("popups"))

    def test_source_owner_mismatch_stops_before_lookup(self):
        self.page.evaluate("""() => {
          requests=[];routes['/api/me']=()=>({kind:'member',institution:'other',sub:'reader'});
          displaySet=makeSet({displaySetInstanceUID:'owner-mismatch'});view.displaySetInstanceUIDs=['owner-mismatch'];emit();
        }""")
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("계정이 변경")
        expect(self.page.locator("#kin-source-pdf-open")).to_have_text("Open Source PDF")
        expect(self.page.locator("#kin-source-pdf-open")).to_be_disabled()
        self.assertEqual(["/api/me"],self.page.evaluate("requests.map(r=>r.url)"))

    def test_native_failure_and_pending_retry_do_not_block_a_new_source(self):
        self.page.evaluate("""() => {
          window.nativeRetries=[];pdfController.stop();
          mountPdf({onRetry:(value,pdfUrl)=>nativeRetries.push([value.displaySetInstanceUID,pdfUrl])});
        }""")
        button=self.page.locator("#kin-source-pdf-open");expect(button).to_be_enabled()
        self.page.evaluate("pdfController.nativeFailure(Object.assign(Error('A native failure'),{retryable:true}),displaySet,displaySet.pdfUrl)")
        button.click();expect(button).to_be_disabled();self.assertEqual(1,len(self.page.evaluate("nativeRetries")))
        self.page.evaluate("""() => {
          displaySet=makeSet({displaySetInstanceUID:'source-b',SOPInstanceUID:'1.5',SeriesDescription:'Source B',pdfUrl:Promise.resolve('https://pdf.test/dicom-web/studies/1.2/series/1.3/instances/1.5/rendered'),instance:{SOPClassUID:SOP,StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.5',PatientID:'PID-001',MIMETypeOfEncapsulatedDocument:'application/pdf',EncapsulatedDocument:{}}});
          view.displaySetInstanceUIDs=['source-b'];emit();
        }""")
        expect(button).to_have_text("Open Source PDF");expect(button).to_be_enabled()
        button.click();expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("Opened source PDF")
        self.assertTrue(self.page.get_by_title('Source PDF', exact=True).get_attribute('src').startswith('blob:'))

    def test_related_role_and_invalid_mime_identity_or_url_fail_closed(self):
        self.page.evaluate("""() => {displaySet=makeSet({displaySetInstanceUID:'ds-related',StudyInstanceUID:'1.9',SeriesInstanceUID:'1.8',SOPInstanceUID:'1.7',SeriesDescription:'Prior PDF',pdfUrl:Promise.resolve('https://pdf.test/dicom-web/studies/1.9/series/1.8/instances/1.7/rendered'),instance:{SOPClassUID:SOP,StudyInstanceUID:'1.9',SeriesInstanceUID:'1.8',SOPInstanceUID:'1.7',PatientID:'PID-001',MIMETypeOfEncapsulatedDocument:'application/pdf',EncapsulatedDocument:{}}});view.displaySetInstanceUIDs=['ds-related'];emit();}""")
        expect(self.page.locator("[data-role]")).to_have_text("Related source PDF")
        expect(self.page.locator("#kin-source-pdf-open")).to_be_enabled()
        variants = [
            "delete displaySet.instance.MIMETypeOfEncapsulatedDocument",
            "displaySet.instance.SOPInstanceUID='1.99'",
            "displaySet.instance.EncapsulatedDocument.InlineBinary='AAAA'",
        ]
        for mutation in variants:
            with self.subTest(mutation=mutation):
                self.page.evaluate(f"() => {{displaySet=makeSet();{mutation};view.displaySetInstanceUIDs=[displaySet.displaySetInstanceUID];emit();}}")
                expect(self.page.locator("#kin-source-pdf")).to_be_visible()
                expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("식별 정보가 일치하지 않습니다")
                expect(self.page.locator("[data-title]")).to_be_empty()
                expect(self.page.locator("[data-patient]")).to_be_empty()
        self.page.evaluate("() => {displaySet=makeSet({pdfUrl:Promise.resolve('https://outside.test/source.pdf')});view.displaySetInstanceUIDs=['ds-pdf'];emit();}")
        expect(self.page.locator("#kin-source-pdf")).to_be_visible()
        expect(self.page.locator("#kin-source-pdf-open")).to_be_disabled()
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("경로")
        self.assertEqual([], self.page.evaluate("popups"))

    def test_rendered_pdf_preflight_rejects_bad_status_or_mime_and_stale_cancel(self):
        button = self.page.locator("#kin-source-pdf-open")
        for route in (
            {"status": 400, "body": {"error": "malformed"}, "contentType": "application/json"},
            {"status": 200, "body": "not pdf", "contentType": "application/json"},
            {"status": 206, "body": "partial pdf", "contentType": "application/pdf"},
        ):
            with self.subTest(route=route):
                self.page.evaluate("([url,value])=>routes[url]=value", [PDF, route])
                button.click()
                message = 'PDF 형식이 아닙니다' if route['status']==200 else '원본 자료 응답을 확인할 수 없습니다'
                expect(self.page.locator("#kin-source-pdf-status")).to_contain_text(message)
                self.assertEqual(0, self.page.locator('dialog[open]').count())

        self.page.evaluate("([url])=>{routes[url]={status:200,body:null,contentType:'application/pdf'};holdCancel=true}", [PDF])
        button.click(); self.page.wait_for_function("cancelHeld.length===1")
        self.page.evaluate("""() => {displaySet=makeSet({displaySetInstanceUID:'new-after-cancel',SOPInstanceUID:'1.5',pdfUrl:Promise.resolve('https://pdf.test/dicom-web/studies/1.2/series/1.3/instances/1.5/rendered'),instance:{SOPClassUID:SOP,StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.5',PatientID:'PID-001',MIMETypeOfEncapsulatedDocument:'application/pdf',EncapsulatedDocument:{}}});view.displaySetInstanceUIDs=['new-after-cancel'];emit();holdCancel=false;cancelHeld.shift()();}""")
        expect(button).to_be_enabled()
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("Ready")
        self.assertEqual(0, self.page.locator('dialog[open]').count())

    def test_source_or_owner_change_during_verification_closes_only_pending_window(self):
        self.page.evaluate("holdPath='/api/dicom/lookup'")
        button = self.page.locator("#kin-source-pdf-open")
        button.click()
        self.page.wait_for_function("held.length===1")
        button.click(force=True)
        self.assertEqual(0, self.page.locator('dialog').count(), 'verification has not displayed a document')
        self.page.evaluate("() => {displaySet=makeSet({displaySetInstanceUID:'replacement',SOPInstanceUID:'1.5',pdfUrl:Promise.resolve('https://pdf.test/dicom-web/studies/1.2/series/1.3/instances/1.5/rendered'),instance:{SOPClassUID:SOP,StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.5',PatientID:'PID-001',MIMETypeOfEncapsulatedDocument:'application/pdf',EncapsulatedDocument:{}}});view.displaySetInstanceUIDs=['replacement'];emit();holdPath=null;}")
        self.assertEqual(0, self.page.locator('dialog[open]').count())
        expect(button).to_be_enabled()

        self.page.evaluate("holdPath=null;let calls=0;routes['/api/me']=()=>++calls===2?{kind:'member',institution:'other',sub:'reader'}:owner")
        button.click()
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("계정이 변경")
        self.assertEqual(0, self.page.locator('dialog[open]').count())

    def test_late_old_resolve_or_reject_cannot_close_or_overwrite_new_pdf(self):
        button = self.page.locator("#kin-source-pdf-open")
        self.page.evaluate("holdPath='/api/dicom/lookup';ignoreAbort=true")
        button.click(); self.page.wait_for_function("held.length===1")
        self.page.evaluate("""() => {displaySet=makeSet({displaySetInstanceUID:'new-pdf',SOPInstanceUID:'1.5',pdfUrl:Promise.resolve('https://pdf.test/dicom-web/studies/1.2/series/1.3/instances/1.5/rendered'),instance:{SOPClassUID:SOP,StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.5',PatientID:'PID-001',MIMETypeOfEncapsulatedDocument:'application/pdf',EncapsulatedDocument:{}}});view.displaySetInstanceUIDs=['new-pdf'];emit();holdPath=null;}""")
        expect(button).to_be_enabled(); button.click()
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("Opened source PDF")
        self.page.evaluate("held.shift().resolve()")
        self.page.wait_for_timeout(0)
        self.assertEqual(1, self.page.locator('dialog[open]').count())
        self.assertTrue(self.page.get_by_title('Source PDF', exact=True).get_attribute('src').startswith('blob:'))
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("Opened source PDF")

        self.page.evaluate("""() => {displaySet=makeSet();view.displaySetInstanceUIDs=['ds-pdf'];emit();}""")
        expect(button).to_be_enabled(); self.page.evaluate("holdPath='/api/dicom/lookup'"); button.click(); self.page.wait_for_function("held.length===1")
        self.page.evaluate("""() => {displaySet=makeSet({displaySetInstanceUID:'last-pdf',SOPInstanceUID:'1.6',pdfUrl:Promise.resolve('https://pdf.test/dicom-web/studies/1.2/series/1.3/instances/1.6/rendered'),instance:{SOPClassUID:SOP,StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.6',PatientID:'PID-001',MIMETypeOfEncapsulatedDocument:'application/pdf',EncapsulatedDocument:{}}});view.displaySetInstanceUIDs=['last-pdf'];emit();holdPath=null;}""")
        expect(button).to_be_enabled(); button.click(); expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("Opened source PDF")
        self.page.evaluate("held.shift().reject(Error('late old rejection'))")
        self.page.wait_for_timeout(0)
        self.assertEqual(1, self.page.locator('dialog[open]').count())
        self.assertTrue(self.page.get_by_title('Source PDF', exact=True).get_attribute('src').startswith('blob:'))
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("Opened source PDF")

    def test_failed_owner_check_remains_visible_after_grid_refresh(self):
        self.page.evaluate("pdfController.stop();routes['/api/me']={status:503,body:{}};mountPdf()")
        expect(self.page.locator('#kin-source-pdf-status')).to_contain_text('로그인 세션을 확인할 수 없습니다')
        self.page.evaluate('emit()')
        expect(self.page.locator('#kin-source-pdf-status')).to_contain_text('로그인 세션을 확인할 수 없습니다')
        expect(self.page.locator('#kin-source-pdf-open')).to_be_disabled()

    def test_native_pdf_permanent_failures_are_visible_without_retry_after_grid_refresh(self):
        self.page.add_script_tag(path=str(CONFIG))
        for path, status, mime, message in [
            (PDF,403,'application/json','접근이 거절'),
            (PDF,404,'application/json','찾을 수 없습니다'),
            (PDF,200,'text/plain','PDF 형식이 아닙니다'),
            ('/api/dicom/lookup',403,'application/json','접근이 거절'),
        ]:
            with self.subTest(path=path,status=status,mime=mime):
                self.page.evaluate("""([path,status,mime])=>{
                  window.pdfExtension?.onModeExit();pdfController.stop();
                  routes['/api/dicom/lookup']=()=>({id:'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee'});
                  routes[path]={status,body:{},contentType:mime};
                  displaySet=makeSet();window.nativeOutcome='pending';
                  const entry={component:props=>{props.displaySets[0].pdfUrl.then(url=>{
                    document.querySelector('#native-pdf').data=url;nativeOutcome='url';},()=>nativeOutcome='rejected');return {key:props.key};}};
                  window.pdfExtension=kinCreateDicomPdf();pdfExtension.preRegistration({servicesManager:{services},extensionManager:{getModuleEntry:()=>entry}});
                  pdfExtension.onModeEnter();entry.component({displaySets:[displaySet]});
                }""",[path,status,mime])
                self.page.wait_for_function("nativeOutcome==='rejected'")
                expect(self.page.locator('#kin-source-pdf-status')).to_contain_text(message)
                self.page.evaluate('emit()')
                expect(self.page.locator('#kin-source-pdf-status')).to_contain_text(message)
                expect(self.page.locator('#kin-source-pdf')).to_be_visible()
                expect(self.page.locator('#kin-source-pdf-open')).to_be_disabled()
                self.assertNotIn('Retry',self.page.locator('#kin-source-pdf-open').inner_text())
                self.assertIsNone(self.page.locator('#native-pdf').get_attribute('data'))

    def test_document_close_http_failure_and_dispose_are_bounded(self):
        button = self.page.locator('#kin-source-pdf-open')
        self.page.evaluate("routes['/api/dicom/lookup']={status:403,body:{}}")
        button.click()
        expect(self.page.locator('#kin-source-pdf-status')).to_contain_text('접근 권한')
        self.assertEqual(0, self.page.locator('dialog').count())
        expect(button).to_be_disabled()
        # A fresh selection rechecks access; a definitive refusal has no retry button.
        self.page.evaluate("routes['/api/dicom/lookup']=()=>({id:'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee'});displaySet=makeSet({displaySetInstanceUID:'reselected'});view.displaySetInstanceUIDs=['reselected'];emit()")
        expect(button).to_be_enabled()
        button.click()
        expect(self.page.locator('dialog')).to_be_visible()
        url = self.page.get_by_title('Source PDF', exact=True).get_attribute('src')
        self.page.get_by_role('button', name='Close', exact=True).click()
        self.assertFalse(self.page.evaluate('u=>KinViewerResource.has(u)', url))
        button.click()
        expect(self.page.locator('dialog')).to_be_visible()
        url = self.page.get_by_title('Source PDF', exact=True).get_attribute('src')
        self.page.evaluate('pdfController.stop()')
        self.assertEqual(0, self.page.locator('dialog').count())
        self.assertFalse(self.page.evaluate('u=>KinViewerResource.has(u)', url))

    def test_config_loader_uses_factory_and_rejects_late_mode_entry(self):
        page = self.browser.new_page()
        self.addCleanup(page.close)
        page.set_content('<p id="kin-viewer-layout-status"></p>')
        page.add_script_tag(content=extract_function(CONFIG.read_text(encoding="utf-8"), "kinCreateDicomPdf"))
        result = page.evaluate("""async () => {
          let load,src=null,created=0,mounted=0,stopped=0;
          const append=document.head.append.bind(document.head);document.head.append=element=>{
            if(element.tagName!=='SCRIPT')return append(element);src=element.getAttribute('src');load=()=>{window.KinDicomPdf={create(value){created++;if(value.token!==17)throw Error('wrong services');return {mount(){mounted++},stop(){stopped++}}}};element.onload();};return element;
          };
          const extension=kinCreateDicomPdf();extension.preRegistration({servicesManager:{services:{token:17}}});
          extension.onModeEnter();extension.onModeExit();load();await Promise.resolve();await Promise.resolve();
          const late={created,mounted,stopped};extension.onModeEnter();await Promise.resolve();await Promise.resolve();extension.onModeExit();
          return {src,late,created,mounted,stopped,id:extension.id};
        }""")
        self.assertEqual("kin.source-pdf", result["id"])
        self.assertEqual("/worklist/hpacs-lite/viewer-dicom-pdf.js", result["src"])
        self.assertEqual({"created": 0, "mounted": 0, "stopped": 0}, result["late"])
        self.assertEqual((1, 1, 1), (result["created"], result["mounted"], result["stopped"]))

    def test_expired_request_cannot_navigate_when_provider_ignores_abort(self):
        self.page.evaluate("""()=>{window.originalTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>{
          if(ms===10000){window.expirePdfRequest=fn;return 99999;}return originalTimeout(fn,ms,...args);};
          holdPath='/api/dicom/lookup';ignoreAbort=true;}""")
        self.page.locator('#kin-source-pdf-open').click();self.page.wait_for_function('held.length===1')
        self.page.evaluate("()=>{expirePdfRequest();held.shift().resolve();holdPath=null;window.setTimeout=originalTimeout;}")
        expect(self.page.locator('#kin-source-pdf-open')).to_be_enabled()
        self.assertEqual(0, self.page.locator('dialog').count())


if __name__ == "__main__":
    unittest.main(verbosity=2)
