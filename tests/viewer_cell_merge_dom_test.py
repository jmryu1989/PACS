# coding: utf-8
"""Isolated Chromium coverage for cell merge: double-click ownership, panel and loader."""
from pathlib import Path
import time
import unittest

from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MODULE = (ROOT / "worklist-v0" / "hpacs-lite" / "viewer-cell-merge.js").read_text(encoding="utf-8")
CONFIG = (ROOT / "config" / "ohif.js").read_text(encoding="utf-8")
URL = "https://cellmerge.test/ohif/viewer?StudyInstanceUIDs=1.2.1"


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


FACTORY = extract_function(CONFIG, "kinCreateCellMerge") + ";window.mergeExtension=kinCreateCellMerge();"
HARNESS = r"""<!doctype html><html><head></head><body style="margin:0">
<main id="kin-viewer-layout" style="box-sizing:border-box;width:340px;padding:4px">
  <section id="kin-existing-section">Recent Layout</section>
</main>
<p id="kin-viewer-layout-status"></p>
<div id="grid" style="position:relative;width:600px;height:400px;background:#111"></div>
<script>
const host=document.getElementById('grid');
const displaySets=new Map(),viewports=new Map(),cells=new Map();
const camera=()=>({focalPoint:[0,0,0],position:[0,0,10],viewUp:[0,1,0],viewPlaneNormal:[0,0,1],parallelScale:10,flipHorizontal:false,flipVertical:false});
function makeViewport(id,seed){
  const element=document.createElement('div');element.dataset.cell=id;element.style.cssText='position:absolute;background:#234;color:#fff';
  element.textContent=id;host.append(element);
  return {id,type:'stack',element,current:'wadors:'+id+':0',index:0,renders:0,
    camera:Object.assign(camera(),{parallelScale:seed}),properties:{invert:false,voiRange:{lower:0,upper:100}},
    getCurrentImageId(){return this.current},getCurrentImageIdIndex(){return this.index},
    getCamera(){return structuredClone(this.camera)},setCamera(value){Object.assign(this.camera,structuredClone(value))},
    getProperties(){return structuredClone(this.properties)},setProperties(value){Object.assign(this.properties,structuredClone(value))},
    setVOI(value){this.properties.voiRange=structuredClone(value)},
    setImageIdIndex(value){this.index=value;this.current='wadors:'+this.id+':'+value;return Promise.resolve()},
    render(){this.renders++}};
}
function place(id,x,y,width,height){
  const viewport=viewports.get(id);if(!viewport)return;
  Object.assign(viewport.element.style,{left:(x*100)+'%',top:(y*100)+'%',width:(width*100)+'%',height:(height*100)+'%'});
}
['A','B','C','D'].forEach((name,index)=>{
  displaySets.set('ds-'+name,{displaySetInstanceUID:'ds-'+name,Modality:'CT'});
  viewports.set(name,makeViewport(name,10+index));
  cells.set(name,{viewportId:name,x:(index%2)/2,y:Math.floor(index/2)/2,width:.5,height:.5,
    displaySetInstanceUIDs:['ds-'+name],viewportOptions:{viewportId:name,id:'slot-'+name,toolGroupId:'default'}});
  place(name,(index%2)/2,Math.floor(index/2)/2,.5,.5);
});
const state={layout:{layoutType:'grid',numRows:2,numCols:2},activeViewportId:'A',viewports:cells};
let subscribers=[];window.layoutCalls=[];window.cines={};window.failSetLayout=false;
const grid={EVENTS:{GRID:'grid'},getState:()=>state,
  subscribe:(_,fn)=>{subscribers.push(fn);return {unsubscribe(){subscribers=subscribers.filter(item=>item!==fn)}}},
  setLayout(payload){
    window.layoutCalls.push({numRows:payload.numRows,numCols:payload.numCols,layoutOptions:payload.layoutOptions||null,activeViewportId:payload.activeViewportId});
    if(window.failSetLayout)return Promise.resolve();
    const next=new Map(),options=payload.layoutOptions;
    for(let row=0;row<payload.numRows;row++)for(let col=0;col<payload.numCols;col++){
      const position=col+row*payload.numCols;
      if(options&&options.length&&position>=options.length)continue;
      const option=options&&options[position];
      const width=option?option.width:1/payload.numCols,height=option?option.height:1/payload.numRows;
      const x=option?option.x:col/payload.numCols,y=option?option.y:row/payload.numRows;
      const request=payload.findOrCreateViewport(position);if(!request)continue;
      const id=request.viewportOptions.viewportId;
      next.set(id,{viewportId:id,x,y,width,height,displaySetInstanceUIDs:[...request.displaySetInstanceUIDs],viewportOptions:request.viewportOptions});
    }
    for(const id of [...viewports.keys()])if(!next.has(id)){viewports.get(id).element.remove();viewports.delete(id)}
    for(const [id,cell] of next){if(!viewports.has(id))viewports.set(id,makeViewport(id,1));place(id,cell.x,cell.y,cell.width,cell.height)}
    state.viewports=next;state.layout={layoutType:'grid',numRows:payload.numRows,numCols:payload.numCols};
    state.activeViewportId=payload.activeViewportId;
    subscribers.slice().forEach(fn=>fn());
    return Promise.resolve();
  }};
window.services={viewportGridService:grid,cornerstoneViewportService:{getCornerstoneViewport:id=>viewports.get(id)||null},
  displaySetService:{getDisplaySetByUID:id=>displaySets.get(id)},cineService:{getState:()=>({cines:window.cines})}};
window.nativeViewports=viewports;window.gridState=state;
window.geometry=()=>[...state.viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).map(v=>[v.viewportId,v.x,v.y,v.width,v.height]);
window.mountDirect=()=>{window.mergeController=KinViewerCellMerge.create(services);return mergeController.mount()};
window.enterMerge=()=>mergeExtension.onModeEnter({servicesManager:{services}});
</script></body></html>"""
CAPTURE_TIMEOUT_MS = 10_000


class ViewerCellMergeDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def new_page(self, module=True, factory=False):
        page = self.browser.new_page(viewport={"width": 900, "height": 700})
        page.route(URL, lambda route: route.fulfill(body=HARNESS, content_type="text/html; charset=utf-8"))
        page.goto(URL)
        if module:
            page.add_script_tag(content=MODULE)
        if factory:
            page.add_script_tag(content=FACTORY)
        return page

    def wait_for_capture(self, page, held, count=1):
        deadline = time.monotonic() + CAPTURE_TIMEOUT_MS / 1000
        while len(held) < count:
            if time.monotonic() >= deadline:
                self.fail(f"viewer-cell-merge.js route captured {len(held)}/{count} request(s)")
            page.wait_for_timeout(10)
        return held

    def test_double_click_maximizes_the_clicked_cell_and_the_next_one_restores_the_grid(self):
        page = self.new_page()
        try:
            self.assertTrue(page.evaluate("mountDirect()"))
            before = page.evaluate("geometry()")
            page.evaluate("nativeViewports.get('B').camera.parallelScale=42")
            page.locator('[data-cell="C"]').dblclick()
            page.wait_for_function("()=>gridState.viewports.size===1")
            self.assertEqual([["C", 0, 0, 1, 1]], page.evaluate("geometry()"))
            self.assertEqual("C", page.evaluate("gridState.activeViewportId"))
            expect(page.locator("#kin-cell-merge [role=status]")).to_contain_text("확대했습니다")
            # The rendered pane really covers the whole grid, not just the state object.
            box = page.locator('[data-cell="C"]').bounding_box()
            grid = page.locator("#grid").bounding_box()
            self.assertAlmostEqual(box["width"], grid["width"], delta=1)
            self.assertAlmostEqual(box["height"], grid["height"], delta=1)
            page.locator('[data-cell="C"]').dblclick()
            page.wait_for_function("()=>gridState.viewports.size===4")
            self.assertEqual(before, page.evaluate("geometry()"))
            self.assertEqual(42, page.evaluate("nativeViewports.get('B').camera.parallelScale"))
            expect(page.locator("#kin-cell-merge [role=status]")).to_contain_text("되돌렸습니다")
            self.assertEqual(2, len(page.evaluate("layoutCalls")))
        finally:
            page.close()

    def test_a_double_click_a_native_tool_or_drag_consumed_never_reaches_the_grid(self):
        for phase in ["bubble", "capture"]:
            with self.subTest(phase=phase):
                page = self.new_page()
                try:
                    page.evaluate("mountDirect()")
                    page.evaluate("""phase=>{const element=nativeViewports.get('A').element;
                      element.addEventListener('dblclick',event=>{event.stopImmediatePropagation();event.preventDefault();},
                        phase==='capture'?{capture:true}:undefined);}""", phase)
                    before = page.evaluate("geometry()")
                    page.locator('[data-cell="A"]').dblclick()
                    page.wait_for_timeout(120)
                    self.assertEqual(before, page.evaluate("geometry()"))
                    self.assertEqual([], page.evaluate("layoutCalls"))
                    self.assertFalse(page.evaluate("mergeController.state().merged"))
                finally:
                    page.close()

    def test_panel_buttons_merge_a_column_and_refuse_a_non_stack_or_busy_screen(self):
        page = self.new_page()
        try:
            page.evaluate("mountDirect()")
            panel = page.locator("#kin-cell-merge")
            expect(panel.locator('[data-cell-merge="restore"]')).to_be_disabled()
            page.evaluate("nativeViewports.get('B').type='orthographic'")
            panel.locator('[data-cell-merge="maximize"]').click()
            expect(panel.locator("[role=status]")).to_contain_text("MPR")
            self.assertEqual([], page.evaluate("layoutCalls"))
            page.evaluate("nativeViewports.get('B').type='stack'")
            page.evaluate("cines={A:{isPlaying:true}}")
            panel.locator('[data-cell-merge="merge-column"]').click()
            expect(panel.locator("[role=status]")).to_contain_text("Cine")
            self.assertEqual([], page.evaluate("layoutCalls"))
            page.evaluate("cines={}")
            panel.locator('[data-cell-merge="merge-column"]').click()
            page.wait_for_function("()=>gridState.viewports.size===3")
            self.assertEqual([["A", 0, 0, .5, 1], ["B", .5, 0, .5, .5], ["D", .5, .5, .5, .5]], page.evaluate("geometry()"))
            expect(panel.locator('[data-cell-merge="maximize"]')).to_be_disabled()
            expect(panel.locator('[data-cell-merge="restore"]')).to_be_enabled()
            expect(panel.locator("[data-cell-merge-hint]")).to_contain_text("저장할 수 없으며")
            panel.locator('[data-cell-merge="restore"]').click()
            page.wait_for_function("()=>gridState.viewports.size===4")
            expect(panel.locator('[data-cell-merge="restore"]')).to_be_disabled()
            # The existing panel content is untouched by the added section.
            expect(page.locator("#kin-existing-section")).to_have_text("Recent Layout")
        finally:
            page.close()

    def test_a_layout_request_that_never_lands_is_restored_and_reported_as_such(self):
        page = self.new_page()
        try:
            page.evaluate("mountDirect()")
            before = page.evaluate("geometry()")
            page.evaluate("failSetLayout=true")
            page.locator('#kin-cell-merge [data-cell-merge="maximize"]').click()
            expect(page.locator("#kin-cell-merge [role=status]")).to_contain_text("이전 배치로 복구했습니다", timeout=15000)
            self.assertEqual(before, page.evaluate("geometry()"))
            self.assertFalse(page.evaluate("mergeController.state().merged"))
            self.assertFalse(page.evaluate("mergeController.state().quarantined"))
        finally:
            page.close()

    def test_session_storage_and_pagehide_each_remove_the_panel_and_the_gesture(self):
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
                    page.wait_for_timeout(25)
                    expect(page.locator("#kin-cell-merge")).to_have_count(0)
                    page.locator('[data-cell="A"]').dblclick()
                    page.wait_for_timeout(120)
                    self.assertEqual([], page.evaluate("layoutCalls"))
                    self.assertTrue(page.evaluate("mergeController.state().ended"))
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

        page.route("https://cellmerge.test/worklist/hpacs-lite/viewer-cell-merge.js", script)
        try:
            page.evaluate("enterMerge()")
            expect(page.locator("#kin-viewer-layout-status")).to_contain_text("불러오지 못했습니다")
            self.assertEqual(0, page.locator("#kin-cell-merge").count())
            page.evaluate("enterMerge()")
            expect(page.locator("#kin-cell-merge")).to_be_visible()
            self.assertEqual(2, len(attempts))
        finally:
            page.close()

    def test_mode_exit_during_a_late_load_cannot_mount_and_a_clean_reentry_can(self):
        page = self.new_page(module=False, factory=True)
        held = []
        page.route("https://cellmerge.test/worklist/hpacs-lite/viewer-cell-merge.js", lambda route: held.append(route))
        try:
            page.evaluate("enterMerge()")
            page.wait_for_function("()=>document.querySelectorAll('script[src*=viewer-cell-merge]').length===1")
            self.wait_for_capture(page, held)
            page.evaluate("mergeExtension.onModeExit()")
            held.pop().fulfill(body=MODULE, content_type="application/javascript")
            page.wait_for_timeout(0)
            expect(page.locator("#kin-cell-merge")).to_have_count(0)
            page.evaluate("enterMerge()")
            expect(page.locator("#kin-cell-merge")).to_be_visible()
            page.evaluate("mergeExtension.onModeExit()")
            expect(page.locator("#kin-cell-merge")).to_have_count(0)
        finally:
            for route in held:
                try:
                    route.abort()
                except PlaywrightError:
                    pass
            page.close()


if __name__ == "__main__":
    unittest.main()
