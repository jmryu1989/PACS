# coding: utf-8
"""Isolated Chromium coverage for the CT display-scope panel and its config loader."""
from pathlib import Path
from urllib.parse import urlparse
import unittest

from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MODULE = (ROOT / "worklist-v0" / "hpacs-lite" / "viewer-display-scope.js").read_text(encoding="utf-8")
CONFIG = (ROOT / "config" / "ohif.js").read_text(encoding="utf-8")
URL = "https://scope.test/ohif/viewer?StudyInstanceUIDs=1.2.1"


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


FACTORY = extract_function(CONFIG, "kinCreateDisplayScope") + ";window.scopeExtension=kinCreateDisplayScope();"
HARNESS = r"""<!doctype html><html><head></head><body style="margin:0">
<main id="kin-viewer-layout" style="box-sizing:border-box;width:100%;padding:4px"></main>
<p id="kin-viewer-layout-status"></p><script>
const CT='1.2.840.10008.5.1.4.1.1.2';
let active='A',subscribers=[];const metadata=new Map(),displaySets=new Map(),nativeViewports=new Map(),cells=new Map();
for(let index=0;index<3;index++){
 const id=String.fromCharCode(65+index),study=`1.2.${index+1}`,series=`1.3.${index+1}`,sop=`1.4.${index+1}`,imageId=`wadors:${sop}`;
 const ds={displaySetInstanceUID:`ds-${id}`,Modality:'CT',SOPClassUID:CT,StudyInstanceUID:study,SeriesInstanceUID:series};displaySets.set(ds.displaySetInstanceUID,ds);
 metadata.set(imageId,{SOPClassUID:CT,StudyInstanceUID:study,SeriesInstanceUID:series,SOPInstanceUID:sop});
 const viewport={type:'stack',imageIds:[imageId],current:imageId,camera:{parallelScale:10,flipHorizontal:false,flipVertical:false},properties:{invert:false,voiRange:{lower:0,upper:100}},voiUpdatedWithSetProperties:true,presentation:{rotation:0},renders:0,
  getImageIds(){return [...this.imageIds]},getCurrentImageId(){return this.current},getCamera(){return structuredClone(this.camera)},setCamera(value){Object.assign(this.camera,value)},getProperties(){return {...structuredClone(this.properties),isComputedVOI:!this.voiUpdatedWithSetProperties}},setProperties(value){const clean=structuredClone(value);delete clean.isComputedVOI;Object.assign(this.properties,clean);if(Object.hasOwn(clean,'voiRange'))this.voiUpdatedWithSetProperties=true},setVOI(value,options={}){this.properties.voiRange=structuredClone(value);if(!this.voiUpdatedWithSetProperties)this.voiUpdatedWithSetProperties=!!options.voiUpdatedWithSetProperties},resetProperties(){this.voiUpdatedWithSetProperties=false;this.properties={colormap:{name:'Grayscale'},invert:false,interpolationType:'LINEAR',voiRange:{lower:0,upper:100}}},resetCamera(){this.camera={parallelScale:10,flipHorizontal:false,flipVertical:false}},getViewPresentation(){return structuredClone(this.presentation)},setViewPresentation(value){this.presentation=structuredClone(value)},render(){this.renders++}};
 nativeViewports.set(id,viewport);cells.set(id,{viewportId:id,x:index,y:0,width:1/3,height:1,displaySetInstanceUIDs:[ds.displaySetInstanceUID]});
}
const state={layout:{layoutType:'grid',numRows:1,numCols:3},get activeViewportId(){return active},viewports:cells};
window.services={viewportGridService:{EVENTS:{ACTIVE:'active',GRID:'grid'},getState:()=>state,subscribe:(_,fn)=>{subscribers.push(fn);return {unsubscribe(){subscribers=subscribers.filter(item=>item!==fn)}}}},cornerstoneViewportService:{getCornerstoneViewport:id=>nativeViewports.get(id)},displaySetService:{getDisplaySetByUID:id=>displaySets.get(id)}};
window.cornerstone={metaData:{get:(_,id)=>metadata.get(id)},utilities:{windowLevel:{toLowHighRange:(width,center)=>({lower:center-width/2,upper:center+width/2-1})}}};
window.emitGrid=()=>subscribers.slice().forEach(fn=>fn());
window.mountDirect=()=>{window.scopeController=KinViewerDisplayScope.create(services);return scopeController.mount()};
window.enterScope=()=>scopeExtension.onModeEnter({servicesManager:{services}});
</script></body></html>"""


class ViewerDisplayScopeDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def new_page(self, module=True, factory=False, width=900, height=700):
        page = self.browser.new_page(viewport={"width": width, "height": height})
        page.route(URL, lambda route: route.fulfill(body=HARNESS, content_type="text/html; charset=utf-8"))
        page.goto(URL)
        if module:
            page.add_script_tag(content=MODULE)
        if factory:
            page.add_script_tag(content=FACTORY)
        return page

    def test_real_controls_extend_active_set_and_keep_selection_invert_separate_from_image_invert(self):
        page = self.new_page(width=320, height=560)
        try:
            self.assertTrue(page.evaluate("mountDirect()"))
            panel = page.locator("#kin-display-scope")
            checkboxes = panel.locator("[data-scope-cells] input")
            self.assertEqual([True, False, False], checkboxes.evaluate_all("els=>els.map(e=>e.checked)"))
            checkboxes.nth(1).click()
            self.assertEqual({"mode": "set", "ids": ["A", "B"]}, page.evaluate("scopeController.selection()"))
            panel.locator("[data-scope-invert]").click()
            self.assertEqual({"mode": "set", "ids": ["C"]}, page.evaluate("scopeController.selection()"))
            panel.locator('[data-action="invert"]').click()
            self.assertEqual([False, False, True], page.evaluate("[...nativeViewports.values()].map(v=>v.properties.invert)"))

            panel.locator("[data-ww]").fill("400")
            panel.locator("[data-wc]").fill("40")
            apply_window = panel.locator("[data-window]")
            apply_window.scroll_into_view_if_needed()
            expect(apply_window).to_be_in_viewport()
            apply_window.focus()
            page.keyboard.press("Enter")
            self.assertEqual({"lower": -160, "upper": 239}, page.evaluate("nativeViewports.get('C').properties.voiRange"))
            box = apply_window.bounding_box()
            self.assertGreaterEqual(box["x"], 0)
            self.assertLessEqual(box["x"] + box["width"], 320)

            page.evaluate("oldCheckbox=document.querySelectorAll('[data-scope-cells] input')[1];displaySets.get('ds-B').StudyInstanceUID='9.9.9';emitGrid()")
            page.evaluate("oldCheckbox.checked=false;oldCheckbox.onchange()")
            self.assertEqual({"mode": "active", "ids": ["A"]}, page.evaluate("scopeController.selection()"))
            self.assertFalse(page.evaluate("nativeViewports.get('B').properties.invert"))
        finally:
            page.close()

    def test_session_storage_and_pagehide_each_remove_the_panel_and_disable_controller(self):
        dispatches = [
            "new BroadcastChannel('kin-session').postMessage({type:'session-ended'})",
            "dispatchEvent(new StorageEvent('storage',{key:'kin-session-ended'}))",
            "dispatchEvent(new Event('pagehide'))",
        ]
        for dispatch in dispatches:
            with self.subTest(dispatch=dispatch):
                page = self.new_page()
                try:
                    page.evaluate("mountDirect()")
                    page.evaluate(dispatch)
                    expect(page.locator("#kin-display-scope")).to_have_count(0)
                    self.assertFalse(page.evaluate("scopeController.apply('invert').ok"))
                finally:
                    page.close()

    def test_config_exit_during_late_load_cannot_mount_and_a_clean_reentry_can(self):
        page = self.new_page(module=False, factory=True)
        held = []
        page.route("https://scope.test/worklist/hpacs-lite/viewer-display-scope.js", lambda route: held.append(route))
        try:
            page.evaluate("enterScope()")
            page.wait_for_function("()=>document.querySelectorAll('script[src*=viewer-display-scope]').length===1")
            page.evaluate("scopeExtension.onModeExit()")
            held.pop().fulfill(body=MODULE, content_type="application/javascript")
            page.wait_for_timeout(0)
            expect(page.locator("#kin-display-scope")).to_have_count(0)
            page.evaluate("enterScope()")
            expect(page.locator("#kin-display-scope")).to_be_visible()
            page.evaluate("scopeExtension.onModeExit()")
            expect(page.locator("#kin-display-scope")).to_have_count(0)
        finally:
            page.close()

    def test_config_loader_failure_is_visible_and_reentry_retries_cleanly(self):
        page = self.new_page(module=False, factory=True)
        attempts = []
        def script(route):
            attempts.append(route.request.url)
            if len(attempts) == 1:
                route.abort()
            else:
                route.fulfill(body=MODULE, content_type="application/javascript")
        page.route("https://scope.test/worklist/hpacs-lite/viewer-display-scope.js", script)
        try:
            page.evaluate("enterScope()")
            expect(page.locator("#kin-viewer-layout-status")).to_contain_text("불러오지 못했습니다")
            self.assertEqual(0, page.locator("#kin-display-scope").count())
            page.evaluate("enterScope()")
            expect(page.locator("#kin-display-scope")).to_be_visible()
            self.assertEqual(2, len(attempts))
        finally:
            page.close()

    def test_session_end_while_config_script_is_late_must_not_mount_after_logout(self):
        dispatches = [
            "dispatchEvent(new StorageEvent('storage',{key:'kin-session-ended'}))",
            "new BroadcastChannel('kin-session').postMessage({type:'session-ended'})",
            "dispatchEvent(new Event('pagehide'))",
        ]
        for dispatch in dispatches:
            with self.subTest(dispatch=dispatch):
                page = self.new_page(module=False, factory=True)
                held = []
                page.route("https://scope.test/worklist/hpacs-lite/viewer-display-scope.js", lambda route: held.append(route))
                try:
                    page.evaluate("enterScope()")
                    page.wait_for_function("()=>document.querySelectorAll('script[src*=viewer-display-scope]').length===1")
                    page.evaluate(dispatch)
                    page.wait_for_timeout(25)
                    held.pop().fulfill(body=MODULE, content_type="application/javascript")
                    page.wait_for_timeout(0)
                    expect(page.locator("#kin-display-scope")).to_have_count(0)
                finally:
                    for route in held:
                        try:
                            route.abort()
                        except PlaywrightError:
                            pass
                    page.close()


if __name__ == "__main__":
    unittest.main()
