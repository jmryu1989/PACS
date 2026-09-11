# coding: utf-8
"""Isolated Chromium DOM coverage for selected-stack Images Only fullscreen."""
from pathlib import Path
import unittest

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "worklist-v0" / "hpacs-lite" / "viewer-images-only.js"
URL = "https://images-only.test/ohif/viewer?StudyInstanceUIDs=1.2"

HARNESS = r"""<!doctype html><html><body><main id="kin-viewer-layout"></main>
<section id="viewport" style="position:relative;width:800px;height:600px"><canvas id="pixels"></canvas><div class="native-overlay">S:1 · I:1/2</div><div class="annotation">saved mark</div><div class="kin-viewer-identity" data-study="1.2" style="position:absolute;right:8px;top:8px">Current · PID-1</div></section>
<input id="job" value="UNSAVED JOB"><script>
let owner='["hospital","reader"]',historyBusy=false,jobBusy=false,active='vp',full=null,exits=[],exitAttempts=0,exitMode='ready',releaseExit=null,requestMode='ready',releaseRequest=null,rejectRequest=null,syncRequest=[],sourceEvents=0,oneUp=0,subscribers=[];
const viewportElement=document.querySelector('#viewport'),identity=viewportElement.querySelector('.kin-viewer-identity');
let ids=['image:1.4','image:1.5'],current=ids[0];
const metadata=new Map([[ids[0],{StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.4',PatientID:'PID-1'}],[ids[1],{StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.5',PatientID:'PID-1'}]]);
const displaySet={displaySetInstanceUID:'ds',StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',images:[...metadata.values()]};
const viewport={type:'stack',viewportStatus:'rendered',element:viewportElement,camera:{parallelScale:42},getImageIds:()=>[...ids],getCurrentImageId:()=>current};
const cell={viewportId:'vp',x:0,y:0,width:1,height:1,displaySetInstanceUIDs:['ds']};
const state={layout:{layoutType:'grid',numRows:1,numCols:1},get activeViewportId(){return active},viewports:new Map([['vp',cell]])};
window.kinViewerWindowOwner=()=>owner;window.kinViewerHistoryWorkspaceState=()=>({busy:historyBusy,dirty:false});window.kinViewerJobWorkspaceState=()=>({busy:jobBusy,dirty:true});
window.cornerstone={Enums:{ViewportStatus:{RENDERED:'rendered'},Events:{PRE_STACK_NEW_IMAGE:'pre-image',STACK_NEW_IMAGE:'new-image',IMAGE_RENDERED:'rendered-image'}},metaData:{get:(_,id)=>metadata.get(id)}};
window.services={viewportGridService:{EVENTS:{GRID:'grid',LAYOUT:'layout'},getState:()=>state,subscribe:(_,fn)=>{subscribers.push(fn);return{unsubscribe(){subscribers=subscribers.filter(x=>x!==fn)}}}},cornerstoneViewportService:{getCornerstoneViewport:id=>id==='vp'?viewport:null},displaySetService:{EVENTS:{ADDED:'added'},getDisplaySetByUID:id=>id==='ds'?displaySet:null,subscribe:(_,fn)=>{subscribers.push(fn);return{unsubscribe(){subscribers=subscribers.filter(x=>x!==fn)}}}}};
Object.defineProperty(document,'fullscreenElement',{configurable:true,get:()=>full});
document.exitFullscreen=()=>{exitAttempts++;if(exitMode==='reject')return Promise.reject(Error('blocked'));exits.push(full);full=null;document.dispatchEvent(new Event('fullscreenchange'));if(exitMode==='held')return new Promise(resolve=>releaseExit=resolve);return Promise.resolve()};
let clickActive=false;document.addEventListener('click',()=>clickActive=true,true);document.addEventListener('click',()=>clickActive=false);
viewportElement.requestFullscreen=()=>{syncRequest.push(clickActive);if(requestMode==='reject')return Promise.reject(Error('denied'));if(requestMode==='pending')return new Promise((resolve,reject)=>{releaseRequest=()=>{full=viewportElement;document.dispatchEvent(new Event('fullscreenchange'));resolve()};rejectRequest=reject});full=viewportElement;document.dispatchEvent(new Event('fullscreenchange'));if(requestMode==='held')return new Promise(resolve=>releaseRequest=resolve);return Promise.resolve()};
for(const name of ['pointerdown','mousedown','touchstart','click'])viewportElement.addEventListener(name,event=>{if(event.target.id==='kin-images-only-exit')sourceEvents++});
viewportElement.addEventListener('dblclick',()=>oneUp++);
window.mountImagesOnly=()=>{window.imagesOnly=KinViewerImagesOnly.create(services,{intervalMs:0,requestTimeoutMs:40});return imagesOnly.mount()};
window.emit=()=>subscribers.slice().forEach(fn=>fn());
</script></body></html>"""


class ViewerImagesOnlyDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.page.route(URL, lambda route: route.fulfill(body=HARNESS, content_type="text/html; charset=utf-8"))
        self.page.goto(URL); self.page.add_script_tag(path=str(MODULE)); self.assertTrue(self.page.evaluate("mountImagesOnly()"))

    def tearDown(self):
        self.page.close()

    def test_selected_stack_enters_synchronously_and_exit_keeps_same_dom_and_work(self):
        self.page.evaluate("window.beforeImagesOnly={viewport:viewportElement,camera:viewport.camera,identity,overlay:viewportElement.querySelector('.native-overlay'),annotation:viewportElement.querySelector('.annotation')}")
        self.page.locator("#kin-images-only-enter").click()
        self.assertEqual([True], self.page.evaluate("syncRequest"))
        self.assertTrue(self.page.evaluate("document.fullscreenElement===viewportElement"))
        expect(self.page.locator("#kin-images-only-exit")).to_be_visible()
        self.assertEqual("right-middle", self.page.locator("#kin-images-only-exit").get_attribute("data-position"))
        expect(self.page.locator(".kin-viewer-identity")).to_have_text("Current · PID-1")
        expect(self.page.locator(".native-overlay")).to_have_text("S:1 · I:1/2")
        self.page.locator("#kin-images-only-exit").click()
        self.assertTrue(self.page.evaluate("document.fullscreenElement===null"))
        self.assertEqual(0, self.page.evaluate("sourceEvents"), "exit pointer/click events must not reach the viewport")
        self.assertEqual("UNSAVED JOB", self.page.locator("#job").input_value())
        self.assertTrue(self.page.evaluate("()=>beforeImagesOnly.viewport===viewportElement&&beforeImagesOnly.camera===viewport.camera&&beforeImagesOnly.identity===identity&&beforeImagesOnly.overlay===viewportElement.querySelector('.native-overlay')&&beforeImagesOnly.annotation===viewportElement.querySelector('.annotation')"))

    def test_frame_navigation_is_allowed_but_source_list_change_exits(self):
        self.page.locator("#kin-images-only-enter").click()
        self.page.evaluate("current=ids[1];document.dispatchEvent(new Event('new-image'))")
        self.assertTrue(self.page.evaluate("document.fullscreenElement===viewportElement"))
        self.page.evaluate("""()=>{const id='image:1.6',value={StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.6',PatientID:'PID-1'};metadata.set(id,value);displaySet.images.push(value);ids.push(id);emit()}""")
        self.page.wait_for_function("()=>document.fullscreenElement===null")
        self.assertEqual(1, self.page.evaluate("exits.length"))
        expect(self.page.locator("#kin-images-only-status")).to_contain_text("연결이 바뀌어")

    def test_exit_rejection_keeps_visible_retry_and_owned_fullscreen(self):
        self.page.locator("#kin-images-only-enter").click()
        self.page.evaluate("identity.style.top='270px';identity.style.right='0';identity.style.width='300px';document.dispatchEvent(new Event('rendered-image'))")
        self.assertEqual("left-middle", self.page.locator("#kin-images-only-exit").get_attribute("data-position"))
        self.page.evaluate("exitMode='reject'")
        self.page.locator("#kin-images-only-exit").click()
        expect(self.page.locator("#kin-images-only-exit")).to_contain_text("Retry")
        expect(self.page.locator("#kin-images-only-exit")).to_contain_text("종료 요청이 거절되었습니다")
        self.assertTrue(self.page.evaluate("document.fullscreenElement===viewportElement"))
        self.page.evaluate("identity.style.left='0';identity.style.right='0';identity.style.top='0';identity.style.width='800px';identity.style.height='600px';document.dispatchEvent(new Event('rendered-image'))")
        expect(self.page.locator("#kin-images-only-exit")).to_contain_text("Exit Images Only · Retry")
        self.assertEqual(2, self.page.evaluate("exitAttempts"))
        self.page.evaluate("document.dispatchEvent(new Event('rendered-image'))")
        self.assertEqual(2, self.page.evaluate("exitAttempts"), "an unsafe placement must not retry exit on every observer event")
        self.page.evaluate("identity.style.left='auto';identity.style.height='auto';identity.style.top='270px';identity.style.right='0';identity.style.width='300px';document.dispatchEvent(new Event('rendered-image'))")
        self.page.evaluate("exitMode='ready'")
        self.page.wait_for_timeout(450)
        self.page.locator("#kin-images-only-exit").click()
        self.page.wait_for_function("()=>document.fullscreenElement===null")

    def test_identity_relayout_repositions_exit_and_explicit_exit_shields_double_click(self):
        self.page.locator("#kin-images-only-enter").click()
        self.assertEqual("right-middle", self.page.locator("#kin-images-only-exit").get_attribute("data-position"))
        self.page.evaluate("identity.style.top='270px';identity.style.right='0';identity.style.width='300px';document.dispatchEvent(new Event('rendered-image'))")
        self.assertEqual("left-middle", self.page.locator("#kin-images-only-exit").get_attribute("data-position"))
        self.page.locator("#kin-images-only-exit").click()
        self.page.evaluate("viewportElement.querySelector('#pixels').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}))")
        self.assertEqual(0, self.page.evaluate("oneUp"))
        self.page.wait_for_timeout(550)
        self.page.evaluate("viewportElement.querySelector('#pixels').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}))")
        self.assertEqual(1, self.page.evaluate("oneUp"), "the exit shield must be temporary")

    def test_never_settled_request_is_bounded_and_blocks_competing_same_element_request(self):
        self.page.evaluate("requestMode='pending'")
        self.page.locator("#kin-images-only-enter").click()
        expect(self.page.locator("#kin-images-only-status")).to_contain_text("아직 완료되지 않았습니다", timeout=1000)
        expect(self.page.locator("#kin-images-only-enter")).to_be_disabled()
        self.page.evaluate("imagesOnly.stop();window.imagesOnly2=KinViewerImagesOnly.create(services,{intervalMs:0,requestTimeoutMs:40});imagesOnly2.mount()")
        expect(self.page.locator("#kin-images-only-enter")).to_be_disabled()
        expect(self.page.locator("#kin-images-only-status")).to_contain_text("아직 완료되지 않았습니다")
        self.page.evaluate("requestMode='ready';releaseRequest()")
        self.page.wait_for_function("()=>document.fullscreenElement===null")
        self.page.evaluate("emit()")
        expect(self.page.locator("#kin-images-only-enter")).to_be_enabled()
        self.page.locator("#kin-images-only-enter").click()
        self.assertTrue(self.page.evaluate("document.fullscreenElement===viewportElement"))
        self.assertEqual(1, self.page.locator("#kin-images-only-exit").count(), "the late old request must not remove the newer Exit UI")

    def test_cancelled_pending_rejection_releases_owner_and_old_exit_callback_is_stale(self):
        self.page.evaluate("requestMode='pending'")
        self.page.locator("#kin-images-only-enter").click()
        self.page.evaluate("imagesOnly.stop();window.imagesOnly2=KinViewerImagesOnly.create(services,{intervalMs:0,requestTimeoutMs:40});imagesOnly2.mount();rejectRequest(Error('cancelled'))")
        self.page.evaluate("()=>Promise.resolve().then(()=>emit())")
        expect(self.page.locator("#kin-images-only-enter")).to_be_enabled()
        self.page.evaluate("requestMode='ready';exitMode='held'")
        self.page.locator("#kin-images-only-enter").click()
        self.page.locator("#kin-images-only-exit").click()
        self.page.evaluate("window.imagesOnly3=KinViewerImagesOnly.create(services,{intervalMs:0,requestTimeoutMs:40});imagesOnly2.stop();imagesOnly3.mount();exitMode='ready'")
        expect(self.page.locator("#kin-images-only-enter")).to_be_enabled()
        self.page.locator("#kin-images-only-enter").click()
        self.page.evaluate("releaseExit()")
        self.assertTrue(self.page.evaluate("document.fullscreenElement===viewportElement"))
        self.assertEqual(1, self.page.locator("#kin-images-only-exit").count())

    def test_invalid_source_busy_dialog_and_missing_identity_disable_entry(self):
        changes = [
            "jobBusy=true", "jobBusy=false;document.body.append(Object.assign(document.createElement('dialog'),{open:true,id:'blocking'}))",
            "document.querySelector('#blocking')?.remove();identity.remove()", "viewportElement.append(identity);displaySet.images[0].PatientID='OTHER'",
            "displaySet.images[0].PatientID='PID-1';cell.displaySetInstanceUIDs=['ds','other']",
        ]
        for change in changes:
            self.page.evaluate(change + ";emit()")
            expect(self.page.locator("#kin-images-only-enter")).to_be_disabled()
        self.page.evaluate("cell.displaySetInstanceUIDs=['ds'];emit()")
        expect(self.page.locator("#kin-images-only-enter")).to_be_enabled()

    def test_rejection_session_late_resolution_and_unrelated_fullscreen_are_owned(self):
        self.page.evaluate("requestMode='reject'"); self.page.locator("#kin-images-only-enter").click()
        expect(self.page.locator("#kin-images-only-status")).to_contain_text("허용하지 않았습니다")
        self.assertEqual(0, self.page.locator("#kin-images-only-exit").count())
        self.page.evaluate("requestMode='pending'"); self.page.locator("#kin-images-only-enter").click()
        self.page.evaluate("dispatchEvent(new StorageEvent('storage',{key:'kin-session-ended'}))")
        expect(self.page.locator("#kin-images-only")).to_have_count(0)
        self.page.evaluate("releaseRequest()")
        self.page.wait_for_function("()=>document.fullscreenElement===null")
        self.assertEqual(1, self.page.evaluate("exits.length"))
        self.page.evaluate("full=document.body;document.dispatchEvent(new Event('fullscreenchange'))")
        self.assertEqual(1, self.page.evaluate("exits.length"), "the stopped controller must not exit unrelated fullscreen")


if __name__ == "__main__":
    unittest.main(verbosity=2)
