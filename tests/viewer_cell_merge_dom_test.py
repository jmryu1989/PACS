# coding: utf-8
"""Isolated Chromium coverage for cell merge: double-click ownership, panel and loader."""
from pathlib import Path
import json
import time
import unittest

from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MODULE = (ROOT / "worklist-v0" / "hpacs-lite" / "viewer-cell-merge.js").read_text(encoding="utf-8")
VOLUME_JOB = (ROOT / "worklist-v0" / "hpacs-lite" / "viewer-volume-job.js").read_text(encoding="utf-8")
JOBS = (ROOT / "worklist-v0" / "hpacs-lite" / "viewer-jobs.js").read_text(encoding="utf-8")
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

# The saved Jobs panel over the same fake grid. Each stack cell gets the frame, actor and
# canvas reads viewer-jobs.js needs to capture and restore it, so a restore really dispatches
# a layout and really rolls back; nothing in the product path is stubbed out.
JOB_FIXTURE = r"""(()=>{
const frames=5,setOf=id=>gridState.viewports.get(id)?.displaySetInstanceUIDs?.[0]||null;
window.cornerstone={metaData:{get:(type,id)=>{const m=type==='instance'&&/^img:ds-([A-D]):(\d+)$/.exec(id||'');
  return m?{StudyInstanceUID:'1.2.1',SeriesInstanceUID:'series-'+m[1],SOPInstanceUID:'sop-'+m[1]+'-'+m[2],SOPClassUID:'1.2.840.10008.5.1.4.1.1.2'}:undefined;}}};
for(const set of displaySets.values()){const letter=set.displaySetInstanceUID.slice(3);Object.assign(set,{StudyInstanceUID:'1.2.1',SeriesInstanceUID:'series-'+letter,
  images:Array.from({length:frames},(_,n)=>({SOPInstanceUID:'sop-'+letter+'-'+n,SOPClassUID:'1.2.840.10008.5.1.4.1.1.2'}))});}
services.displaySetService.getActiveDisplaySets=()=>[...displaySets.values()];
grid.setActiveViewportId=id=>{gridState.activeViewportId=id;};
window.failNextImageLoad=false;
const frameable=viewport=>Object.assign(viewport,{
  getImageIds(){const set=setOf(this.id);return set?Array.from({length:frames},(_,n)=>'img:'+set+':'+n):[];},
  getCurrentImageId(){const set=setOf(this.id);return set?'img:'+set+':'+this.index:null;},
  getTargetImageIdIndex(){return this.index;},scroll(delta){this.index+=delta;},
  getDefaultActor(){return setOf(this.id)?{actor:{}}:null;},getCanvas(){return {width:300,height:200};},
  setImageIdIndex(value){if(window.failNextImageLoad){window.failNextImageLoad=false;return Promise.reject(Error('native frame load failed'));}
    this.index=value;return Promise.resolve();}});
nativeViewports.forEach(frameable);
const make=makeViewport;window.makeViewport=(id,seed)=>frameable(make(id,seed));
window.mountJobs=()=>{document.querySelector('#kin-viewer-layout').prepend(document.createElement('summary'));
  window.kinViewerJobs(services,{scope:()=>'study'}).mount();};
window.frameOf=id=>nativeViewports.get(id)?.getCurrentImageId?.()||null;
window.shownFrames=()=>[...gridState.viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).map(v=>frameOf(v.viewportId));
// A click with no pointer event, so an in-flight merge cannot read it as user input.
window.pressRestoreJob=title=>{const item=[...document.querySelectorAll('#kin-viewer-jobs strong')].find(s=>s.textContent===title).parentElement;
  const button=[...item.querySelectorAll('button')].find(b=>b.textContent==='Restore Job'),enabled=!button.disabled;button.click();return enabled;};
})();"""


def stack_cell(letter, frame, scale):
    return dict(study="1.2.1", series=f"series-{letter}", sop=f"sop-{letter}-{frame}", frame=1,
                viewport=dict(width=300, height=200),
                camera=dict(focalPoint=[0, 0, 0], position=[0, 0, 10], viewUp=[0, 1, 0], viewPlaneNormal=[0, 0, 1],
                            parallelScale=scale, flipHorizontal=False, flipVertical=False),
                properties=dict(voiRange=dict(lower=0, upper=100), VOILUTFunction="LINEAR", invert=False, interpolationType=1))


SNAPSHOTS = {
    "job-ordinary": ("Ordinary Job", dict(version=2, studies=["1.2.1"], rows=1, cols=2, active=0,
                                          cells=[stack_cell("A", 3, 21), stack_cell("B", 1, 22)])),
    "job-merged": ("Merged Job", dict(version=9, studies=["1.2.1"], rows=2, cols=2, rects=[dict(x=0, y=0, width=1, height=1)],
                                      active=0, volume=None, cells=[dict(kind="stack", **stack_cell("B", 4, 33))])),
}


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

    def jobs_page(self):
        """Cell merge and the saved Jobs panel mounted together over the same grid."""
        page = self.new_page()
        held, gate = [], {"hold": False}

        def api(route):
            path = route.request.url.split("https://cellmerge.test/api", 1)[1]
            if path == "/me":
                body = dict(kind="member", sub="doctor", institution="inst", roles=["radiologist"])
            elif path.startswith("/studies/1.2.1/viewer-jobs?"):
                body = dict(jobs=[dict(id=key, title=title, description="", authorActor="doctor", authorSub="other",
                                       createdAt="2026-09-13T00:00:00Z", revision=1, hidden=False,
                                       snapshotVersion=snapshot["version"]) for key, (title, snapshot) in SNAPSHOTS.items()])
            elif path.startswith("/studies/1.2.1/viewer-jobs/") and path.rsplit("/", 1)[1] in SNAPSHOTS:
                if gate["hold"]:
                    held.append(route)
                    return
                body = dict(id=path.rsplit("/", 1)[1], snapshot=SNAPSHOTS[path.rsplit("/", 1)[1]][1])
            else:
                route.fulfill(status=404, body='{"message":"missing"}', content_type="application/json")
                return
            route.fulfill(body=json.dumps(body), content_type="application/json")

        page.route("https://cellmerge.test/api/**", api)
        page.add_script_tag(content=JOB_FIXTURE)
        page.add_script_tag(content=VOLUME_JOB)
        page.add_script_tag(content=JOBS)
        self.assertTrue(page.evaluate("mountDirect()"))
        page.evaluate("mountJobs()")
        expect(page.locator("#kin-viewer-jobs-status")).to_contain_text("저장 작업 목록")
        return page, held, gate

    def jobs_status(self, page, text, timeout=25000):
        expect(page.locator("#kin-viewer-jobs-status")).to_contain_text(text, timeout=timeout)
        return page.locator("#kin-viewer-jobs-status").text_content()

    def test_a_held_merge_refuses_restore_job_before_any_dispatch_and_keeps_its_way_back(self):
        page, _, _ = self.jobs_page()
        try:
            panel = page.locator("#kin-cell-merge")
            # D is the cell the maximize removes; its frame and zoom exist only in the record.
            page.evaluate("nativeViewports.get('D').index=2;nativeViewports.get('D').camera.parallelScale=55")
            before = page.evaluate("geometry()")
            page.locator('[data-cell="C"]').dblclick()
            expect(panel.locator("[role=status]")).to_contain_text("확대했습니다")
            # The user's own work on the merged cell never invalidates the record.
            page.evaluate("nativeViewports.get('C').camera.parallelScale=64")
            # Were the restore to run, the Job's first frame load fails after its layout landed.
            page.evaluate("failNextImageLoad=true")
            page.locator("#kin-viewer-jobs strong", has_text="Ordinary Job").locator("xpath=..") \
                .get_by_role("button", name="Restore Job").click()
            status = self.jobs_status(page, "입력은 유지됩니다")
            observed = dict(refused="Restore Grid로 격자를 되돌린 뒤 복원하세요" in status,
                            layout_calls=len(page.evaluate("layoutCalls")), merged=page.evaluate("mergeController.state().merged"),
                            restore_grid_enabled=panel.locator('[data-cell-merge="restore"]').is_enabled(),
                            geometry=page.evaluate("geometry()"))
            self.assertEqual(dict(refused=True, layout_calls=1, merged=True, restore_grid_enabled=True,
                                  geometry=[["C", 0, 0, 1, 1]]), observed, status)
            page.evaluate("failNextImageLoad=false")

            # A merge state that cannot be read is not taken as "no merge".
            page.evaluate("window.heldReader=kinCellMergeWorkspaceState;kinCellMergeWorkspaceState=()=>{throw Error('unreadable')};0")
            page.locator("#kin-viewer-jobs strong", has_text="Merged Job").locator("xpath=..") \
                .get_by_role("button", name="Restore Job").click()
            self.jobs_status(page, "칸 병합 상태를 확인할 수 없어")
            self.assertEqual(1, len(page.evaluate("layoutCalls")))
            page.evaluate("kinCellMergeWorkspaceState=heldReader")

            # The way back still works and still owes the removed cell its frame and zoom.
            panel.locator('[data-cell-merge="restore"]').click()
            expect(panel.locator("[role=status]")).to_contain_text("되돌렸습니다", timeout=15000)
            self.assertEqual(before, page.evaluate("geometry()"))
            self.assertEqual(55, page.evaluate("nativeViewports.get('D').camera.parallelScale"))
            self.assertEqual("img:ds-D:2", page.evaluate("frameOf('D')"))
            self.assertEqual(64, page.evaluate("nativeViewports.get('C').camera.parallelScale"))

            # With no record held, the explicit replacement goes ahead and succeeds.
            page.locator("#kin-viewer-jobs strong", has_text="Ordinary Job").locator("xpath=..") \
                .get_by_role("button", name="Restore Job").click()
            self.jobs_status(page, "비교 작업을 복원했습니다")
            self.assertEqual(3, len(page.evaluate("layoutCalls")))
            self.assertEqual(["img:ds-A:3", "img:ds-B:1"], page.evaluate("shownFrames()"))
        finally:
            page.close()

    def test_restore_job_waits_out_an_in_flight_merge_and_continues_once_no_record_is_held(self):
        page, held, gate = self.jobs_page()
        try:
            panel = page.locator("#kin-cell-merge")
            # A merge still waiting for its layout is about to become a held record.
            page.evaluate("failSetLayout=true")
            panel.locator('[data-cell-merge="maximize"]').click()
            page.wait_for_function("()=>mergeController.state().busy")
            self.assertTrue(page.evaluate("pressRestoreJob('Ordinary Job')"))
            self.jobs_status(page, "칸 배치 요청이 끝난 뒤")
            self.assertEqual([], page.evaluate("layoutCalls.filter(call=>String(call.activeViewportId).startsWith('kin-'))"))
            # The merge finishes on its own terms, untouched by the refused restore.
            expect(panel.locator("[role=status]")).to_contain_text("이전 배치로 복구했습니다", timeout=15000)
            self.assertFalse(page.evaluate("mergeController.state().quarantined"))
            page.evaluate("failSetLayout=false")

            # Input order the other way round: a restore in flight refuses a new merge, and the
            # user's click is itself an interaction the restore's own serial refuses on - neither
            # side dispatches anything.
            gate["hold"] = True
            self.assertTrue(page.evaluate("pressRestoreJob('Merged Job')"))
            self.wait_for_capture(page, held)
            panel.locator('[data-cell-merge="maximize"]').click()
            expect(panel.locator("[role=status]")).to_contain_text("저장 또는 영상 작업이 끝난 뒤")
            gate["hold"] = False
            held.pop().fulfill(body=json.dumps(dict(id="job-merged", snapshot=SNAPSHOTS["job-merged"][1])),
                               content_type="application/json")
            self.jobs_status(page, "영상 조작이 변경되어 복원하지 않았습니다")
            self.assertEqual([], page.evaluate("layoutCalls.filter(call=>String(call.activeViewportId).startsWith('kin-'))"))
            self.assertFalse(page.evaluate("mergeController.state().merged"))
            # Asked again on a screen that holds no record, the saved merged layout is restored.
            self.assertTrue(page.evaluate("pressRestoreJob('Merged Job')"))
            self.jobs_status(page, "병합한 칸 배치를 복원했습니다")
            self.assertEqual(["img:ds-B:4"], page.evaluate("shownFrames()"))
            self.assertFalse(page.evaluate("mergeController.state().merged"))
            expect(panel.locator('[data-cell-merge="restore"]')).to_be_disabled()

            # A foreign source change drops a held record through the module's own observer;
            # the screen is then an ordinary record-less one and a restore is allowed again.
            page.locator("#kin-viewer-jobs strong", has_text="Ordinary Job").locator("xpath=..") \
                .get_by_role("button", name="Restore Job").click()
            self.jobs_status(page, "비교 작업을 복원했습니다")
            panel.locator('[data-cell-merge="maximize"]').click()
            expect(panel.locator("[role=status]")).to_contain_text("확대했습니다")
            page.evaluate("""grid.setLayout({numRows:1,numCols:2,activeViewportId:'F0',
              findOrCreateViewport:i=>({displaySetInstanceUIDs:['ds-'+'CD'[i]],viewportOptions:{viewportId:'F'+i}})})""")
            expect(panel.locator("[role=status]")).to_contain_text("병합 기록을 지웠습니다")
            self.assertTrue(page.evaluate("pressRestoreJob('Merged Job')"))
            self.jobs_status(page, "병합한 칸 배치를 복원했습니다")
            self.assertEqual(["img:ds-B:4"], page.evaluate("shownFrames()"))

            # A stopped module leaves no reader behind, so nothing stale can answer for it.
            page.evaluate("mergeController.stop()")
            self.assertEqual("undefined", page.evaluate("typeof window.kinCellMergeWorkspaceState"))
        finally:
            for route in held:
                try:
                    route.abort()
                except PlaywrightError:
                    pass
            page.close()

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
            # The restore is only finished when the controller says so: the recorded
            # camera is re-applied after the rebuilt panes settle.
            expect(page.locator("#kin-cell-merge [role=status]")).to_contain_text("되돌렸습니다")
            self.assertEqual(before, page.evaluate("geometry()"))
            self.assertEqual(42, page.evaluate("nativeViewports.get('B').camera.parallelScale"))
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

    def test_panel_buttons_merge_a_column_and_refuse_a_3d_plane_or_busy_screen(self):
        page = self.new_page()
        try:
            page.evaluate("mountDirect()")
            panel = page.locator("#kin-cell-merge")
            expect(panel.locator('[data-cell-merge="restore"]')).to_be_disabled()
            # A VR 3D volume viewport is neither a stack nor an orthographic plane and stays
            # refused whole. An orthographic cell whose loaded volume, SOP list and plane
            # cannot be read here is refused by the same guard, before any dispatch.
            for kind in ("volume3d", "orthographic"):
                page.evaluate(f"nativeViewports.get('B').type='{kind}'")
                panel.locator('[data-cell-merge="maximize"]').click()
                expect(panel.locator("[role=status]")).to_contain_text("3D·SR·PDF")
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
            # A merged screen is now a saveable Job shape, so the hint states that instead.
            expect(panel.locator("[data-cell-merge-hint]")).to_contain_text("Save New Job")
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
