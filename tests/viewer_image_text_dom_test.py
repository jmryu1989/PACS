# coding: utf-8
"""Isolated Chromium DOM coverage for scoped native Image Text hiding."""
from pathlib import Path
import unittest

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "worklist-v0" / "hpacs-lite" / "viewer-image-text.js"
IMAGES_ONLY_MODULE = ROOT / "worklist-v0" / "hpacs-lite" / "viewer-images-only.js"
URL = "https://image-text.test/ohif/viewer?StudyInstanceUIDs=1.2"

HARNESS = r"""<!doctype html><html><head><title>Verified Study</title></head><body><main id="kin-viewer-layout"></main>
<section data-cy="viewport-pane" id="pane"><div class="viewport-overlay" id="native">Native text</div><div data-cy="viewport-overlay-top-left" id="prehidden" style="visibility:hidden">Existing hidden</div><div id="viewport"><canvas id="pixels"></canvas><div class="annotation">saved mark</div><div class="kin-viewer-identity" data-study="1.2" style="display:block">Current · PID-1</div></div></section>
<input id="job" value="UNSAVED JOB"><script>
let owner='owner-1',historyBusy=false,jobBusy=false,active='vp',subscribers=[],ids=['image:1.4','image:1.5'],current=ids[0];
const viewportElement=document.querySelector('#viewport'),pane=document.querySelector('#pane');
const metadata=new Map([[ids[0],{StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.4',PatientID:'PID-1'}],[ids[1],{StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.5',PatientID:'PID-1'}]]);
const displaySet={displaySetInstanceUID:'ds',StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',images:[...metadata.values()]};
const viewport={type:'stack',viewportStatus:'rendered',element:viewportElement,camera:{parallelScale:42},getImageIds:()=>[...ids],getCurrentImageId:()=>current};
const cell={viewportId:'vp',x:0,y:0,width:1,height:1,displaySetInstanceUIDs:['ds']};
const state={layout:{layoutType:'grid',numRows:1,numCols:1},get activeViewportId(){return active},viewports:new Map([['vp',cell]])};
window.kinViewerWindowOwner=()=>owner;window.kinViewerHistoryWorkspaceState=()=>({busy:historyBusy});window.kinViewerJobWorkspaceState=()=>({busy:jobBusy});
window.cornerstone={Enums:{ViewportStatus:{RENDERED:'rendered'},Events:{PRE_STACK_NEW_IMAGE:'pre-image',STACK_NEW_IMAGE:'new-image',IMAGE_RENDERED:'rendered-image'}},metaData:{get:(_,id)=>metadata.get(id)}};
window.services={viewportGridService:{EVENTS:{GRID:'grid',LAYOUT:'layout'},getState:()=>state,subscribe:(_,fn)=>{subscribers.push(fn);return{unsubscribe(){subscribers=subscribers.filter(x=>x!==fn)}}}},cornerstoneViewportService:{getCornerstoneViewport:id=>id==='vp'?viewport:null},displaySetService:{EVENTS:{ADDED:'added'},getDisplaySetByUID:id=>id==='ds'?displaySet:null,subscribe:(_,fn)=>{subscribers.push(fn);return{unsubscribe(){subscribers=subscribers.filter(x=>x!==fn)}}}}};
window.mountImageText=()=>{window.imageText=KinViewerImageText.create(services,{intervalMs:0});return imageText.mount()};
window.emit=()=>subscribers.slice().forEach(fn=>fn());
</script></body></html>"""


class ViewerImageTextDOMTest(unittest.TestCase):
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
        self.page.goto(URL); self.page.add_script_tag(path=str(MODULE)); self.assertTrue(self.page.evaluate("mountImageText()"))

    def tearDown(self):
        self.page.close()

    def test_scoped_hide_survives_native_sibling_and_identity_refresh_then_restores_exactly(self):
        before = self.page.evaluate("()=>({rect:pixels.getBoundingClientRect().toJSON(),camera:viewport.camera,title:document.title,job:job.value,native:native.getAttribute('style'),pre:prehidden.getAttribute('style')})")
        self.page.locator("#kin-image-text-toggle").click()
        self.assertTrue(self.page.evaluate("kinViewerImageTextHidden()"))
        expect(self.page.locator("#kin-image-text-toggle")).to_have_text("Show Image Text")
        expect(self.page.locator("#native")).to_have_css("visibility", "hidden")
        expect(self.page.locator(".kin-viewer-identity")).to_have_css("visibility", "hidden")
        expect(self.page.locator("#pixels")).to_have_css("visibility", "visible")
        self.assertIsNotNone(self.page.locator("#pane").get_attribute("data-kin-image-text-hidden"))
        self.page.evaluate("document.querySelector('.kin-viewer-identity').style.cssText='display:block;position:absolute;right:4px';const next=document.createElement('div');next.className='kin-viewer-identity';next.dataset.study='1.2';next.textContent='Replacement identity';document.querySelector('.kin-viewer-identity').replaceWith(next)")
        expect(self.page.locator(".kin-viewer-identity")).to_have_css("visibility", "hidden")
        self.page.locator("#kin-image-text-toggle").click()
        expect(self.page.locator("#native")).to_have_css("visibility", "visible")
        expect(self.page.locator("#prehidden")).to_have_css("visibility", "hidden")
        self.assertIsNone(self.page.locator("#pane").get_attribute("data-kin-image-text-hidden"))
        after = self.page.evaluate("()=>({rect:pixels.getBoundingClientRect().toJSON(),camera:viewport.camera,title:document.title,job:job.value,native:native.getAttribute('style'),pre:prehidden.getAttribute('style')})")
        self.assertEqual(before, after)

    def test_frame_navigation_stays_hidden_but_source_change_auto_shows(self):
        self.page.locator("#kin-image-text-toggle").click()
        self.page.evaluate("current=ids[1];document.dispatchEvent(new Event('new-image'))")
        self.assertTrue(self.page.evaluate("kinViewerImageTextHidden()"))
        self.page.evaluate("metadata.get(ids[1]).PatientID='OTHER';emit()")
        self.assertFalse(self.page.evaluate("kinViewerImageTextHidden()"))
        expect(self.page.locator("#native")).to_have_css("visibility", "visible")
        expect(self.page.locator("#kin-image-text-status")).to_contain_text("구성이 바뀌어")

    def test_fullscreen_busy_mixed_source_and_owner_change_fail_closed(self):
        self.page.evaluate("jobBusy=true;emit()")
        expect(self.page.locator("#kin-image-text-toggle")).to_be_disabled()
        self.page.evaluate("jobBusy=false;Object.defineProperty(document,'fullscreenElement',{configurable:true,get:()=>viewportElement});emit()")
        expect(self.page.locator("#kin-image-text-toggle")).to_be_disabled()
        self.page.evaluate("Object.defineProperty(document,'fullscreenElement',{config:true,configurable:true,get:()=>null})")
        self.page.evaluate("cell.displaySetInstanceUIDs=['ds','other'];emit()")
        expect(self.page.locator("#kin-image-text-toggle")).to_be_disabled()
        self.page.evaluate("cell.displaySetInstanceUIDs=['ds'];emit()")
        expect(self.page.locator("#kin-image-text-toggle")).to_be_enabled()
        self.page.locator("#kin-image-text-toggle").click()
        self.page.evaluate("owner='owner-2'")
        self.assertTrue(self.page.evaluate("kinViewerImageTextHidden()"), "the fullscreen guard must reflect physical concealment before observation")
        self.page.evaluate("emit()")
        self.assertFalse(self.page.evaluate("kinViewerImageTextHidden()"))

    def test_session_end_restores_owned_scope_and_detached_control_is_inert(self):
        old = self.page.locator("#kin-image-text-toggle").element_handle()
        self.page.locator("#kin-image-text-toggle").click()
        self.page.evaluate("dispatchEvent(new StorageEvent('storage',{key:'kin-session-ended'}))")
        expect(self.page.locator("#kin-image-text")).to_have_count(0)
        expect(self.page.locator("#native")).to_have_css("visibility", "visible")
        self.assertFalse(self.page.evaluate("kinViewerImageTextHidden()"))
        old.evaluate("element => element.click()")
        self.assertFalse(self.page.evaluate("kinViewerImageTextHidden()"))

    def test_actual_images_only_module_is_blocked_until_image_text_is_shown(self):
        self.page.add_script_tag(path=str(IMAGES_ONLY_MODULE))
        self.page.evaluate("window.fullscreenRequests=0;viewportElement.requestFullscreen=()=>{fullscreenRequests++;return Promise.resolve()};window.imagesOnly=KinViewerImagesOnly.create(services,{intervalMs:100});imagesOnly.mount()")
        self.page.locator("#kin-image-text-toggle").click()
        self.assertTrue(self.page.evaluate("kinViewerImageTextHidden()"))
        expect(self.page.locator("#kin-images-only-enter")).to_be_disabled()
        self.page.locator("#kin-images-only-enter").evaluate("element => element.click()")
        self.assertEqual(0, self.page.evaluate("fullscreenRequests"))
        self.page.locator("#kin-image-text-toggle").click()
        expect(self.page.locator("#kin-images-only-enter")).to_be_enabled(timeout=1000)
        self.page.locator("#kin-images-only-enter").evaluate("element => element.click()")
        self.assertEqual(1, self.page.evaluate("fullscreenRequests"))
        self.page.evaluate("imagesOnly.stop()")


if __name__ == "__main__":
    unittest.main(verbosity=2)
