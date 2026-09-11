# coding: utf-8
"""REQ-D-3D-CURSOR / RISK-D-3D-CURSOR-IDENTITY/GEOMETRY/STALE/LOSS / TEST-3D-CURSOR-DOM.

Isolated page, no network and no container. The synthetic viewport reproduces the pinned
StackViewport ordering recorded in tmp/opus-3d-cursor/native-race.json: the index is written
before the load (N1), a replacement installs a new imageIds array and cancels nothing (N2/N3),
a completing load re-derives its index against the live array and is discarded on mismatch
(N4), the returned promise resolves even when the load was discarded (N5), and an already
matching index resolves at once (N6). Physical correctness of the coordinates is covered
independently by TEST-3D-CURSOR-MODEL with hand-computed points.
"""
from pathlib import Path
import unittest

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "worklist-v0" / "hpacs-lite" / "three-d-cursor-model.js"
VIEWER = ROOT / "worklist-v0" / "hpacs-lite" / "viewer-three-d-cursor.js"

HARNESS = r"""
<div id="panes">
 <div id="pane-ct" style="width:200px;height:200px"></div>
 <div id="pane-mr" style="width:200px;height:200px"></div>
 <div id="pane-other" style="width:200px;height:200px"></div>
 <div id="pane-volume" style="width:200px;height:200px"><span id="volume-keep">KEEP</span></div>
 <div id="pane-mr2" style="width:200px;height:200px"></div>
</div>
<script>
window.unhandled=[];window.addEventListener('unhandledrejection',e=>{unhandled.push(String(e.reason));e.preventDefault();});
const META=new Map();
const toolCalls=[],annotations=[{uid:'existing-length',kept:true}];
function series(prefix,opts){
 const ids=[];
 for(let k=0;k<opts.count;k++){
  const imageId=prefix+':'+k;
  ids.push(imageId);
  META.set(imageId,{StudyInstanceUID:opts.study||'1.2.3',SeriesInstanceUID:opts.series,SOPInstanceUID:opts.series+'.'+(k+1),
   FrameOfReferenceUID:opts.frame||'1.2.9',sourcePatientKey:opts.patient||'hospital|patient',Modality:opts.modality,
   ImageOrientationPatient:[1,0,0,0,1,0],ImagePositionPatient:[opts.origin[0],opts.origin[1],opts.origin[2]+opts.gap*k],
   PixelSpacing:opts.spacing,Rows:opts.rows,Columns:opts.columns,imageId});
 }
 return ids;
}
const CT=series('ct',{series:'1.2.3.4',modality:'CT',count:5,gap:5,origin:[-250,-250,0],spacing:[0.8,0.5],rows:256,columns:512});
const MR=series('mr',{series:'1.2.3.9',modality:'MR',count:7,gap:2.5,origin:[-64,-64,0],spacing:[1,1],rows:128,columns:128});
const FOREIGN=series('fo',{series:'1.2.3.7',modality:'CT',count:4,gap:5,origin:[-250,-250,0],spacing:[0.8,0.5],rows:256,columns:512,frame:'1.2.99'});
const MR2=series('m2',{series:'1.2.3.6',modality:'MR',count:7,gap:2.5,origin:[-64,-64,0],spacing:[1,1],rows:128,columns:128});
const SPARE=series('sp',{series:'1.2.3.8',modality:'MR',count:6,gap:2.5,origin:[-64,-64,0],spacing:[1,1],rows:128,columns:128});

class Stack{
 constructor(id,imageIds,index){this.id=id;this.type='stack';this.imageIds=imageIds;this.currentImageIdIndex=index||0;
  this.csImage={imageId:imageIds[index||0]};this.viewportStatus='rendered';this.calls=[];this.pending=[];this.hold=false;this.discard=false;this.throwOnSet=false;}
 getImageIds(){return this.imageIds;}
 getCurrentImageId(){return this.imageIds[this.currentImageIdIndex];}
 getCurrentImageIdIndex(){return this.currentImageIdIndex;}
 getCornerstoneImage(){return this.csImage;}
 setImageIdIndex(i){
  this.calls.push(i);
  if(this.throwOnSet)return Promise.reject(new Error('synthetic destroyed viewport'));
  if(this.currentImageIdIndex===i)return Promise.resolve(this.getCurrentImageId());
  this.currentImageIdIndex=i;this.viewportStatus='preRender';
  const imageId=this.imageIds[i],self=this;
  const complete=()=>{if(self.discard)return;const idx=self.imageIds.indexOf(imageId);if(idx!==self.currentImageIdIndex)return;
   self.csImage={imageId};self.viewportStatus='rendered';};
  if(this.hold)return new Promise(resolve=>this.pending.push(()=>{complete();resolve(imageId);}));
  complete();return Promise.resolve(imageId);
 }
 replaceStack(ids,index){this.imageIds=ids;this.currentImageIdIndex=index||0;this.viewportStatus='loading';}
 plane(){return KinThreeDCursorModel.plane(META.get(this.getCurrentImageId())).plane;}
 canvasToWorld(point){return KinThreeDCursorModel.toWorld(this.plane(),{x:point[0],y:point[1]});}
 worldToCanvas(world){const p=KinThreeDCursorModel.toPixel(this.plane(),world);return [p.x,p.y];}
}
const ct=new Stack('vp-ct',CT,2),mr=new Stack('vp-mr',MR,0),foreign=new Stack('vp-other',FOREIGN,0);
const volume={id:'vp-volume',type:'volume',getImageIds(){return MR;},calls:[],setImageIdIndex(i){this.calls.push(i);return Promise.resolve();}};
const mr2=new Stack('vp-mr2',MR2,0);
window.viewports={ct,mr,foreign,volume,mr2};
window.addSecondTarget=()=>{paneList=[...paneList,{id:'mr2',element:document.querySelector('#pane-mr2'),viewport:mr2}];};
let paneList=[{id:'ct',element:document.querySelector('#pane-ct'),viewport:ct},
 {id:'mr',element:document.querySelector('#pane-mr'),viewport:mr},
 {id:'other',element:document.querySelector('#pane-other'),viewport:foreign},
 {id:'volume',element:document.querySelector('#pane-volume'),viewport:volume}];
window.setPanes=list=>{paneList=list.map(id=>({ct:paneList[0],mr:paneList[1],other:paneList[2],volume:paneList[3]}[id]));};
let ctx={owner:'hospital|reader',session:'s1',tool:'WindowLevel'};
window.setContext=next=>{ctx={...ctx,...next};};
window.flush=name=>{const v=viewports[name],queue=v.pending.splice(0);queue.forEach(fn=>fn());return queue.length;};
window.__mount=()=>window.cursor=KinViewerThreeDCursor.mount({
 panes:()=>paneList,meta:id=>META.get(id)||null,context:()=>ctx,
 tick:()=>Promise.resolve(),confirmAttempts:2});
</script>
"""


class ViewerThreeDCursorDOMTest(unittest.TestCase):
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
        self.page.route(
            "https://cursor.test/**",
            lambda route: route.fulfill(body=HARNESS, content_type="text/html")
            if route.request.url == "https://cursor.test/" else route.abort(),
        )
        self.page.set_default_timeout(5000)
        self.page.goto("https://cursor.test/")
        self.page.add_script_tag(path=str(MODEL))
        self.page.add_script_tag(path=str(VIEWER))
        self.page.evaluate("__mount()")

    def tearDown(self):
        self.assertEqual([], self.page.evaluate("unhandled"))
        self.page.close()

    def enable(self):
        return self.page.evaluate("cursor.enable()")

    def marks(self):
        return self.page.evaluate(
            "()=>[...document.querySelectorAll('[data-kin-3d-cursor-mark]')]"
            ".map(node=>({pane:node.closest('[id^=pane-]').id,sop:node.dataset.kinSop,left:node.style.left,top:node.style.top}))"
        )

    def calls(self):
        return self.page.evaluate("()=>({ct:viewports.ct.calls,mr:viewports.mr.calls,foreign:viewports.foreign.calls,volume:viewports.volume.calls})")

    def test_mode_binds_only_valid_classic_stack_panes(self):
        self.assertTrue(self.enable())
        state = self.page.evaluate("cursor.state()")
        self.assertEqual(["ct", "mr", "other"], [pane["id"] for pane in state["panes"]])
        self.assertEqual([True, True, True], [pane["eligible"] for pane in state["panes"]])
        # A volume pane is never bound, so it can never be navigated by this mode.
        self.assertNotIn("volume", [pane["id"] for pane in state["panes"]])
        self.page.evaluate("META.set('mr:3',{...META.get('mr:3'),PixelSpacing:[1,0]})")
        self.page.evaluate("cursor.refresh()")
        panes = {pane["id"]: pane for pane in self.page.evaluate("cursor.state()")["panes"]}
        self.assertEqual((False, "geometry-spacing"), (panes["mr"]["eligible"], panes["mr"]["reason"]))
        self.page.evaluate("META.set('mr:3',{...META.get('mr:3'),PixelSpacing:[1,1]});META.delete('ct:4')")
        self.page.evaluate("cursor.refresh()")
        panes = {pane["id"]: pane for pane in self.page.evaluate("cursor.state()")["panes"]}
        self.assertEqual((False, "identity-missing"), (panes["ct"]["eligible"], panes["ct"]["reason"]))

    def test_pick_navigates_and_marks_only_eligible_panes(self):
        self.enable()
        result = self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})")
        self.assertTrue(result["ok"])
        self.assertEqual({"ct": [], "mr": [4], "foreign": [], "volume": []}, self.calls())
        self.assertEqual(
            [{"pane": "pane-ct", "sop": "1.2.3.4.3", "left": "460px", "top": "237.5px"},
             {"pane": "pane-mr", "sop": "1.2.3.9.5", "left": "44px", "top": "4px"}],
            self.marks(),
        )
        self.assertEqual("identity-frame", [r for r in result["results"] if r["paneId"] == "other"][0]["reason"])
        self.assertEqual(4, self.page.evaluate("viewports.mr.currentImageIdIndex"))
        self.assertEqual(2, self.page.evaluate("viewports.ct.currentImageIdIndex"))
        self.assertEqual([{"uid": "existing-length", "kept": True}], self.page.evaluate("annotations"))
        self.assertEqual([], self.page.evaluate("toolCalls"))
        self.assertEqual("KEEP", self.page.evaluate("document.querySelector('#volume-keep').textContent"))

    def test_a_real_click_on_a_bound_pane_picks_that_pane_point(self):
        self.enable()
        # A real pointerdown precedes the click; it must not swallow or duplicate the pick.
        self.page.click("#pane-ct", position={"x": 100, "y": 50})
        self.page.wait_for_function("cursor.state().busy===false&&cursor.state().source!==null")
        self.assertEqual({"paneId": "ct", "sop": "1.2.3.4.3", "world": [-200, -210, 10], "pixel": {"x": 100, "y": 50}},
                         self.page.evaluate("cursor.state().source"))
        self.assertEqual(["pane-ct"], [m["pane"] for m in self.marks()])
        self.assertEqual(1, self.page.evaluate("cursor.state().run"))
        self.assertEqual([], self.page.evaluate("viewports.volume.calls"))
        self.assertEqual([], self.page.evaluate("viewports.mr.calls"))
        # Picking from a pane of another frame of reference is allowed, but it carries nothing.
        self.page.click("#pane-other", position={"x": 100, "y": 50})
        self.page.wait_for_function("cursor.state().source&&cursor.state().source.paneId==='other'")
        self.assertEqual(["pane-other"], [m["pane"] for m in self.marks()])
        self.assertEqual({"ct": [], "mr": [], "foreign": [], "volume": []}, self.calls())

    def test_out_of_coverage_and_out_of_image_targets_are_refused_without_navigation(self):
        self.enable()
        self.page.evaluate("viewports.ct.currentImageIdIndex=4;viewports.ct.csImage={imageId:'ct:4'}")
        result = self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})")
        self.assertEqual("out-of-coverage", [r for r in result["results"] if r["paneId"] == "mr"][0]["reason"])
        self.assertEqual([], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual(["pane-ct"], [m["pane"] for m in self.marks()])
        self.page.evaluate("viewports.ct.currentImageIdIndex=2;viewports.ct.csImage={imageId:'ct:2'}")
        result = self.page.evaluate("cursor.pick('ct',{x:10,y:10})")
        self.assertEqual("out-of-image", [r for r in result["results"] if r["paneId"] == "mr"][0]["reason"])
        self.assertEqual([], self.page.evaluate("viewports.mr.calls"))

    def test_a_pick_is_refused_while_the_source_frame_is_not_the_rendered_one(self):
        self.enable()
        self.page.evaluate("viewports.ct.csImage={imageId:'ct:1'}")
        result = self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})")
        self.assertEqual("source-not-rendered", result["reason"])
        self.assertEqual([], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual([], self.marks())

    def test_stack_replacement_during_an_awaited_navigation_aborts_the_run(self):
        self.page.evaluate("setPanes(['ct','mr','other'])")
        self.enable()
        # The pick promise is kept in the page: awaiting it here would deadlock on the held load.
        self.page.evaluate("viewports.mr.hold=true;window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("viewports.mr.pending.length===1")
        self.page.evaluate("viewports.mr.replaceStack(SPARE,1)")
        self.page.evaluate("flush('mr')")
        self.page.wait_for_function("cursor.state().busy===false")
        # The late completion cannot paint or mark, and no index was written after replacement.
        self.assertEqual([4], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual(1, self.page.evaluate("viewports.mr.currentImageIdIndex"))
        self.assertEqual("sp:1", self.page.evaluate("viewports.mr.getCurrentImageId()"))
        self.assertEqual("mr:0", self.page.evaluate("viewports.mr.csImage.imageId"))
        # The replaced pane keeps no marker; the pane that was picked is untouched and keeps its own.
        self.assertEqual(["pane-ct"], [m["pane"] for m in self.marks()])
        result = self.page.evaluate("picking")
        self.assertEqual("source-replaced", [r for r in result["results"] if r["paneId"] == "mr"][0]["reason"])
        self.assertIn("영상이 교체되어 취소했습니다.", self.page.evaluate("cursor.state().status"))

    def test_a_replacement_before_a_later_pane_stops_further_navigation(self):
        self.page.evaluate("setPanes(['ct','mr','other'])")
        self.enable()
        # The pick promise is kept in the page: awaiting it here would deadlock on the held load.
        self.page.evaluate("viewports.mr.hold=true;window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("viewports.mr.pending.length===1")
        self.page.evaluate("viewports.ct.replaceStack(SPARE,3)")
        self.page.evaluate("viewports.mr.hold=false;flush('mr')")
        self.page.wait_for_function("cursor.state().busy===false")
        # Replacing the picked pane invalidates the point itself: the whole run stops and rolls back.
        self.assertEqual("source-replaced", self.page.evaluate("picking").get("reason"))
        self.assertEqual(3, self.page.evaluate("viewports.ct.currentImageIdIndex"))
        self.assertEqual([], self.page.evaluate("viewports.ct.calls"))
        self.assertEqual([4, 0], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual(0, self.page.evaluate("viewports.mr.currentImageIdIndex"))
        self.assertEqual([], self.marks())

    def test_a_pane_replaced_before_its_turn_is_never_issued_a_stale_index(self):
        self.page.evaluate("addSecondTarget()")
        self.enable()
        self.page.evaluate("viewports.mr.hold=true;window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("viewports.mr.pending.length===1")
        # The replacement lands while an earlier pane is awaited, before this pane's own call.
        self.page.evaluate("viewports.mr2.replaceStack(SPARE,2)")
        self.page.evaluate("viewports.mr.hold=false;flush('mr')")
        self.page.wait_for_function("cursor.state().busy===false")
        result = self.page.evaluate("picking")
        self.assertEqual("source-replaced", [r for r in result["results"] if r["paneId"] == "mr2"][0]["reason"])
        self.assertEqual([], self.page.evaluate("viewports.mr2.calls"))
        self.assertEqual(2, self.page.evaluate("viewports.mr2.currentImageIdIndex"))
        self.assertEqual(["pane-ct", "pane-mr"], [m["pane"] for m in self.marks()])
        self.assertEqual([4], self.page.evaluate("viewports.mr.calls"))

    def test_an_unconfirmed_target_yields_no_mark_and_restores_the_pane(self):
        self.enable()
        self.page.evaluate("viewports.mr.discard=true")
        result = self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})")
        self.assertEqual("target-not-confirmed", [r for r in result["results"] if r["paneId"] == "mr"][0]["reason"])
        self.assertEqual([4, 0], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual(0, self.page.evaluate("viewports.mr.currentImageIdIndex"))
        self.assertEqual(["pane-ct"], [m["pane"] for m in self.marks()])

    def test_a_rejected_navigation_is_reported_and_restored(self):
        self.enable()
        self.page.evaluate("viewports.mr.throwOnSet=true")
        result = self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})")
        self.assertEqual("navigation-failed", [r for r in result["results"] if r["paneId"] == "mr"][0]["reason"])
        self.assertEqual(0, self.page.evaluate("viewports.mr.currentImageIdIndex"))
        self.assertEqual(["pane-ct"], [m["pane"] for m in self.marks()])

    def test_a_competing_interaction_cancels_the_run_and_restores_moved_panes(self):
        self.enable()
        # The pick promise is kept in the page: awaiting it here would deadlock on the held load.
        self.page.evaluate("viewports.mr.hold=true;window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("viewports.mr.pending.length===1")
        self.page.eval_on_selector("#pane-ct", "node=>node.dispatchEvent(new WheelEvent('wheel',{bubbles:true}))")
        self.page.evaluate("viewports.mr.hold=false;flush('mr')")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual([4, 0], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual(0, self.page.evaluate("viewports.mr.currentImageIdIndex"))
        self.assertEqual([], self.marks())
        self.assertEqual("다른 조작으로 취소했습니다.", self.page.evaluate("cursor.state().status"))

    def test_owner_session_or_tool_change_cancels_and_clears(self):
        self.enable()
        self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual(2, len(self.marks()))
        self.page.evaluate("setContext({tool:'Length'});cursor.refresh()")
        self.assertEqual([], self.marks())
        self.assertFalse(self.page.evaluate("cursor.state().enabled"))
        self.assertEqual({"ok": False, "reason": "inactive"}, self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})"))
        self.page.evaluate("setContext({session:'s2'});cursor.enable()")
        self.assertTrue(self.page.evaluate("cursor.state().enabled"))

    def test_a_scrolled_pane_loses_its_stale_mark_and_stop_removes_every_owned_node(self):
        self.enable()
        self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual(2, len(self.marks()))
        self.page.evaluate("viewports.mr.currentImageIdIndex=6;viewports.mr.csImage={imageId:'mr:6'};cursor.refresh()")
        self.assertEqual(["pane-ct"], [m["pane"] for m in self.marks()])
        self.page.evaluate("cursor.stop()")
        self.page.wait_for_function("cursor.state().stopped===true")
        self.assertEqual([], self.marks())
        self.assertEqual(0, self.page.evaluate("document.querySelectorAll('[data-kin-3d-cursor-layer]').length"))
        self.assertEqual([{"uid": "existing-length", "kept": True}], self.page.evaluate("annotations"))
        self.assertEqual([], self.page.evaluate("toolCalls"))


if __name__ == "__main__":
    unittest.main()
