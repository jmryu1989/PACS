# coding: utf-8
"""REQ-D-SOURCE-PDF isolated DOM coverage; all network and windows are synthetic."""
import json
from pathlib import Path
import unittest

from playwright.sync_api import expect, sync_playwright

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
const response=(status,value,url,contentType='application/json')=>({ok:status>=200&&status<300,status,headers:{get:name=>name.toLowerCase()==='content-type'?contentType:null},body:{cancel:()=>{cancels.push(url);return holdCancel&&url==='PDF_ROUTE'?new Promise(resolve=>cancelHeld.push(resolve)):Promise.resolve()}},json:async()=>structuredClone(value)});
window.fetch=(url,options={})=>{requests.push({url,method:options.method||'GET',body:options.body?JSON.parse(options.body):null});
 const done=()=>{const configured=routes[url],value=typeof configured==='function'?configured():configured;return response(value?.status||200,value?.body??value,url,value?.contentType);};
 if(holdPath===url)return new Promise((resolve,reject)=>{const item={resolve:()=>resolve(done()),reject};held.push(item);if(!ignoreAbort)options.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});return Promise.resolve(done());};
window.open=()=>{if(blockPopup)return null;const popup={closed:false,opener:{unsafe:true},navigated:null,close(){this.closed=true},location:{replace(value){if(throwNavigation)throw Error('synthetic navigation detail');popup.navigated=value;}}};popups.push(popup);return popup;};
const state={activeViewportId:'vp1',viewports:new Map([['vp1',view]])};
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
        self.page.add_script_tag(path=str(MODULE))
        self.page.evaluate("mountPdf()")
        expect(self.page.locator("#kin-source-pdf-open")).to_be_enabled()

    def tearDown(self):
        self.page.close()

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
        self.assertEqual([{"closed": False, "opener": None, "navigated": PDF}], result["popups"])
        self.assertEqual([PDF], self.page.evaluate("cancels"))

    def test_open_rejects_a_lookup_id_spliced_after_source_resolution(self):
        initial = self.page.evaluate("requests.filter(r=>r.url==='/api/dicom/lookup').map(r=>r.body)")
        self.assertEqual([{"studyUid": "1.2", "sopUid": "1.4"}], initial)
        self.page.evaluate("routes['/api/dicom/lookup']=()=>({id:'11111111-22222222-33333333-44444444-55555555'})")
        self.page.locator("#kin-source-pdf-open").click()
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("원본 PDF 식별을 확인할 수 없습니다")
        self.assertTrue(self.page.evaluate("popups.at(-1).closed"))
        self.assertIsNone(self.page.evaluate("popups.at(-1).navigated"))
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

    def test_source_timeout_exposes_retry_and_ignores_the_late_provider(self):
        self.page.evaluate("""() => {
          pdfController.stop();held=[];holdPath='/api/dicom/lookup';ignoreAbort=true;window.nativeRetries=0;
          mountPdf({timeoutMs:30,onRetry:()=>nativeRetries++});
        }""")
        self.page.wait_for_function("() => held.length===1")
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("시간이 지났습니다")
        button=self.page.locator("#kin-source-pdf-open")
        expect(button).to_have_text("Retry Source PDF");expect(button).to_be_enabled()
        self.page.evaluate("holdPath=null");button.click()
        expect(button).to_have_text("Open Source PDF");expect(button).to_be_enabled()
        self.assertEqual(1,self.page.evaluate("nativeRetries"))
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
        self.page.evaluate("pdfController.nativeFailure(Error('Synthetic native timeout'))")
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
        self.page.evaluate("pdfController.nativeReady()")
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
        expect(self.page.locator("#kin-source-pdf-open")).to_have_text("Retry Source PDF")
        self.assertEqual(["/api/me"],self.page.evaluate("requests.map(r=>r.url)"))

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
        ):
            with self.subTest(route=route):
                self.page.evaluate("([url,value])=>routes[url]=value", [PDF, route])
                button.click()
                expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("원본 PDF 응답을 확인할 수 없습니다")
                self.assertTrue(self.page.evaluate("popups.at(-1).closed"))
                self.assertIsNone(self.page.evaluate("popups.at(-1).navigated"))
                self.assertEqual(PDF, self.page.evaluate("cancels.at(-1)"))

        self.page.evaluate("([url])=>{routes[url]={status:200,body:null,contentType:'application/pdf'};holdCancel=true}", [PDF])
        button.click(); self.page.wait_for_function("cancelHeld.length===1")
        self.page.evaluate("""() => {displaySet=makeSet({displaySetInstanceUID:'new-after-cancel',SOPInstanceUID:'1.5',pdfUrl:Promise.resolve('https://pdf.test/dicom-web/studies/1.2/series/1.3/instances/1.5/rendered'),instance:{SOPClassUID:SOP,StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.5',PatientID:'PID-001',MIMETypeOfEncapsulatedDocument:'application/pdf',EncapsulatedDocument:{}}});view.displaySetInstanceUIDs=['new-after-cancel'];emit();holdCancel=false;cancelHeld.shift()();}""")
        expect(button).to_be_enabled()
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("Ready")
        self.assertTrue(self.page.evaluate("popups.at(-1).closed"))
        self.assertIsNone(self.page.evaluate("popups.at(-1).navigated"))

    def test_source_or_owner_change_during_verification_closes_only_pending_window(self):
        self.page.evaluate("holdPath='/api/dicom/lookup'")
        button = self.page.locator("#kin-source-pdf-open")
        button.click()
        self.page.wait_for_function("held.length===1")
        button.click(force=True)
        self.assertEqual(1, self.page.evaluate("popups.length"), "a busy click cannot create a phantom second window")
        self.page.evaluate("() => {displaySet=makeSet({displaySetInstanceUID:'replacement',SOPInstanceUID:'1.5',pdfUrl:Promise.resolve('https://pdf.test/dicom-web/studies/1.2/series/1.3/instances/1.5/rendered'),instance:{SOPClassUID:SOP,StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.5',PatientID:'PID-001',MIMETypeOfEncapsulatedDocument:'application/pdf',EncapsulatedDocument:{}}});view.displaySetInstanceUIDs=['replacement'];emit();holdPath=null;}")
        self.assertTrue(self.page.evaluate("popups[0].closed"))
        self.assertIsNone(self.page.evaluate("popups[0].navigated"))
        expect(button).to_be_enabled()

        self.page.evaluate("holdPath=null;let calls=0;routes['/api/me']=()=>++calls===2?{kind:'member',institution:'other',sub:'reader'}:owner")
        button.click()
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("계정이 변경")
        outcome = self.page.evaluate("()=>popups.at(-1)")
        self.assertTrue(outcome["closed"])
        self.assertIsNone(outcome["navigated"])

    def test_late_old_resolve_or_reject_cannot_close_or_overwrite_new_pdf(self):
        button = self.page.locator("#kin-source-pdf-open")
        self.page.evaluate("holdPath='/api/dicom/lookup';ignoreAbort=true")
        button.click(); self.page.wait_for_function("held.length===1")
        self.page.evaluate("""() => {displaySet=makeSet({displaySetInstanceUID:'new-pdf',SOPInstanceUID:'1.5',pdfUrl:Promise.resolve('https://pdf.test/dicom-web/studies/1.2/series/1.3/instances/1.5/rendered'),instance:{SOPClassUID:SOP,StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.5',PatientID:'PID-001',MIMETypeOfEncapsulatedDocument:'application/pdf',EncapsulatedDocument:{}}});view.displaySetInstanceUIDs=['new-pdf'];emit();holdPath=null;}""")
        expect(button).to_be_enabled(); button.click()
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("Opened source PDF")
        self.page.evaluate("held.shift().resolve()")
        self.page.wait_for_timeout(0)
        first = self.page.evaluate("()=>popups.map(p=>({closed:p.closed,navigated:p.navigated}))")
        self.assertEqual([{"closed": True, "navigated": None}, {"closed": False, "navigated": PDF}], first)
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("Opened source PDF")

        self.page.evaluate("""() => {displaySet=makeSet();view.displaySetInstanceUIDs=['ds-pdf'];emit();}""")
        expect(button).to_be_enabled(); self.page.evaluate("holdPath='/api/dicom/lookup'"); button.click(); self.page.wait_for_function("held.length===1")
        self.page.evaluate("""() => {displaySet=makeSet({displaySetInstanceUID:'last-pdf',SOPInstanceUID:'1.6',pdfUrl:Promise.resolve('https://pdf.test/dicom-web/studies/1.2/series/1.3/instances/1.6/rendered'),instance:{SOPClassUID:SOP,StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.6',PatientID:'PID-001',MIMETypeOfEncapsulatedDocument:'application/pdf',EncapsulatedDocument:{}}});view.displaySetInstanceUIDs=['last-pdf'];emit();holdPath=null;}""")
        expect(button).to_be_enabled(); button.click(); expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("Opened source PDF")
        self.page.evaluate("held.shift().reject(Error('late old rejection'))")
        self.page.wait_for_timeout(0)
        last = self.page.evaluate("()=>popups.slice(-2).map(p=>({closed:p.closed,navigated:p.navigated}))")
        self.assertEqual([{"closed": True, "navigated": None}, {"closed": False, "navigated": PDF}], last)
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("Opened source PDF")

    def test_failed_owner_check_remains_visible_after_grid_refresh(self):
        self.page.evaluate("pdfController.stop();routes['/api/me']={status:503,body:{}};mountPdf()")
        expect(self.page.locator('#kin-source-pdf-status')).to_contain_text('로그인 세션을 확인할 수 없습니다')
        self.page.evaluate('emit()')
        expect(self.page.locator('#kin-source-pdf-status')).to_contain_text('로그인 세션을 확인할 수 없습니다')
        expect(self.page.locator('#kin-source-pdf-open')).to_be_disabled()

    def test_popup_denial_closed_window_http_failure_and_dispose_are_bounded(self):
        button = self.page.locator("#kin-source-pdf-open")
        self.page.evaluate("blockPopup=true")
        before = self.page.evaluate("requests.length")
        button.click()
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("팝업이 차단")
        self.assertEqual(before, self.page.evaluate("requests.length"))

        self.page.evaluate("blockPopup=false;holdPath='/api/me'")
        button.click(); self.page.wait_for_function("held.length===1")
        self.page.evaluate("popups.at(-1).close();held.shift().resolve();holdPath=null")
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("PDF 창이 닫혀")
        self.assertIsNone(self.page.evaluate("popups.at(-1).navigated"))

        self.page.evaluate("routes['/api/dicom/lookup']={status:403,body:{}}")
        button.click()
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("접근 권한")
        self.assertTrue(self.page.evaluate("popups.at(-1).closed"))

        self.page.evaluate("routes['/api/dicom/lookup']=()=>({id:'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee'});throwNavigation=true")
        button.click()
        expect(self.page.locator("#kin-source-pdf-status")).to_contain_text("PDF 창을 열 수 없습니다")
        expect(self.page.locator("#kin-source-pdf [data-patient]")).to_be_empty()
        self.assertTrue(self.page.evaluate("popups.at(-1).closed"))

        self.page.evaluate("holdPath='/api/me'")
        button.click(); self.page.wait_for_function("held.length===1")
        self.page.evaluate("pdfController.stop()")
        expect(self.page.locator("#kin-source-pdf")).to_have_count(0)
        self.assertTrue(self.page.evaluate("popups.at(-1).closed"))

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
        self.assertTrue(self.page.evaluate('popups[0].closed'))
        self.assertIsNone(self.page.evaluate('popups[0].navigated'))


if __name__ == "__main__":
    unittest.main(verbosity=2)
