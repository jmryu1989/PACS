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
 <div id="pane-ct" style="position:relative;width:600px;height:400px;border:3px solid #000;padding:7px">
  <canvas id="canvas-ct" style="position:absolute;left:20px;top:30px;width:150px;height:150px"></canvas>
  <div id="overlay-ct" style="position:absolute;left:0;top:0;width:40px;height:40px">L</div>
 </div>
 <div id="pane-mr" style="width:200px;height:200px"></div>
 <div id="pane-other" style="width:200px;height:200px"></div>
 <div id="pane-volume" style="width:200px;height:200px"><span id="volume-keep">KEEP</span></div>
 <div id="pane-mr2" style="width:200px;height:200px"></div>
 <div id="pane-inset" style="position:relative;width:300px;height:300px;padding:11px">
  <div id="enabled-inset" style="position:absolute;left:31px;top:43px;width:200px;height:200px;border:5px solid #333">
   <canvas id="canvas-inset" style="position:absolute;left:9px;top:13px;width:150px;height:150px"></canvas>
  </div>
 </div>
 <div id="pane-styled" class="host-positioned" style="width:200px;height:200px"></div>
 <div id="pane-shared" style="width:200px;height:200px"></div>
 <div id="pane-mro" style="width:200px;height:200px"></div>
</div>
<div id="kin-viewer-layout"></div>
<style>.host-positioned{position:absolute;left:600px;top:600px}</style>
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
const INSET=series('in',{series:'1.2.3.5',modality:'CT',count:5,gap:5,origin:[-250,-250,0],spacing:[0.8,0.5],rows:256,columns:512});
const SPARE=series('sp',{series:'1.2.3.8',modality:'MR',count:6,gap:2.5,origin:[-64,-64,0],spacing:[1,1],rows:128,columns:128});
// Offset by 1.2 mm so that no slice of it ever contains a CT slice plane: the transported point
// is always some measurable distance away from the slice that gets shown for it.
const MRO=series('mo',{series:'1.2.3.11',modality:'MR',count:7,gap:2.5,origin:[-64,-64,1.2],spacing:[1,1],rows:128,columns:128});

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
  if(this.hold){
   const promise=new Promise((resolve,reject)=>this.pending.push(error=>{
    if(error)return reject(error);complete();resolve(imageId);}));
   if(this.onHold){const hook=this.onHold;this.onHold=null;hook();}
   return promise;
  }
  complete();return Promise.resolve(imageId);
 }
 replaceStack(ids,index){this.imageIds=ids;this.currentImageIdIndex=index||0;this.viewportStatus='loading';}
 plane(){return KinThreeDCursorModel.plane(META.get(this.getCurrentImageId())).plane;}
 canvasToWorld(point){const s=this.shift||[0,0];return KinThreeDCursorModel.toWorld(this.plane(),{x:point[0]-s[0],y:point[1]-s[1]});}
 worldToCanvas(world){const p=KinThreeDCursorModel.toPixel(this.plane(),world),s=this.shift||[0,0];return [p.x+s[0],p.y+s[1]];}
 rejectPending(){const queue=this.pending.splice(0);queue.forEach(fn=>fn(new Error('synthetic late rejection')));}
}
const ct=new Stack('vp-ct',CT,2),mr=new Stack('vp-mr',MR,0),foreign=new Stack('vp-other',FOREIGN,0);
ct.element=document.querySelector('#pane-ct');mr.element=document.querySelector('#pane-mr');foreign.element=document.querySelector('#pane-other');
const volume={id:'vp-volume',type:'volume',getImageIds(){return MR;},calls:[],setImageIdIndex(i){this.calls.push(i);return Promise.resolve();}};
const mr2=new Stack('vp-mr2',MR2,0);mr2.element=document.querySelector('#pane-mr2');
const inset=new Stack('vp-inset',INSET,2);inset.element=document.querySelector('#enabled-inset');
const styled=new Stack('vp-styled',MR2,0);styled.element=document.querySelector('#pane-styled');
const shared=new Stack('vp-shared',MR2,0);shared.element=document.querySelector('#pane-shared');
const mro=new Stack('vp-mro',MRO,0);mro.element=document.querySelector('#pane-mro');
window.viewports={ct,mr,foreign,volume,mr2,inset,styled,shared,mro};
const PANES={ct:{id:'ct',element:document.querySelector('#pane-ct'),viewport:ct},
 mr:{id:'mr',element:document.querySelector('#pane-mr'),viewport:mr},
 other:{id:'other',element:document.querySelector('#pane-other'),viewport:foreign},
 volume:{id:'volume',element:document.querySelector('#pane-volume'),viewport:volume},
 mr2:{id:'mr2',element:document.querySelector('#pane-mr2'),viewport:mr2},
 inset:{id:'inset',element:document.querySelector('#pane-inset'),viewport:inset},
 styled:{id:'styled',element:document.querySelector('#pane-styled'),viewport:styled},
 sharedA:{id:'sharedA',element:document.querySelector('#pane-shared'),viewport:shared},
 sharedB:{id:'sharedB',element:document.querySelector('#pane-shared'),viewport:shared},
 mro:{id:'mro',element:document.querySelector('#pane-mro'),viewport:mro}};
let paneList=[PANES.ct,PANES.mr,PANES.other,PANES.volume];
window.addSecondTarget=()=>{paneList=[...paneList,PANES.mr2];};
window.setPanes=list=>{paneList=list.map(id=>PANES[id]);};
let ctx={owner:'hospital|reader',session:'s1',tool:'WindowLevel'};
window.setContext=next=>{ctx={...ctx,...next};};
window.flush=name=>{const v=viewports[name],queue=v.pending.splice(0);queue.forEach(fn=>fn());return queue.length;};
const options=extra=>({panes:()=>paneList,meta:id=>META.get(id)||null,context:()=>ctx,
 tick:()=>new Promise(r=>setTimeout(r,0)),confirmAttempts:2,navigationAttempts:1500,drainAttempts:4000,...extra});
window.__mount=extra=>window.cursor=KinViewerThreeDCursor.mount(options(extra));
window.__mountHosted=extra=>{const host=document.querySelector('#kin-viewer-layout');host.replaceChildren();
 return window.cursor=KinViewerThreeDCursor.mount(options({host,...extra}));};
window.panelText=()=>{const p=document.querySelector('#kin-3d-cursor-status');return p?p.textContent:null;};
window.toggleState=()=>{const b=document.querySelector('#kin-3d-cursor-toggle');
 return b?{label:b.textContent,pressed:b.getAttribute('aria-pressed'),disabled:b.disabled}:null;};
window.clickToggle=()=>document.querySelector('#kin-3d-cursor-toggle').click();
window.__mountSecond=()=>window.cursor2=KinViewerThreeDCursor.mount(options({panes:()=>[PANES.mr2]}));
window.scrollTo_=(name,index)=>{const v=viewports[name];v.currentImageIdIndex=index;v.csImage={imageId:v.imageIds[index]};v.viewportStatus='rendered';};
window.markCenters=()=>[...document.querySelectorAll('[data-kin-3d-cursor-mark]')].map(dot=>{
 const anchor=dot.parentElement.parentElement,r=dot.getBoundingClientRect(),a=anchor.getBoundingClientRect();
 return {pane:anchor.id,sop:dot.dataset.kinSop,x:r.left+r.width/2-a.left,y:r.top+r.height/2-a.top,
  display:getComputedStyle(dot).display};});
window.markRect=()=>{const dot=document.querySelector('[data-kin-3d-cursor-mark]');
 if(!dot)return null;const r=dot.getBoundingClientRect();
 return {cx:r.left+r.width/2,cy:r.top+r.height/2,width:r.width,height:r.height,display:getComputedStyle(dot).display};};
window.rectOf=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};};
window.clickAt=(selector,x,y)=>{const host=document.querySelector(selector);
 host.scrollIntoView({block:'center',inline:'center'});
 const box=host.getBoundingClientRect(),target=document.elementFromPoint(box.left+x,box.top+y)||host;
 for(const type of ['pointerdown','click'])
  target.dispatchEvent(new MouseEvent(type,{bubbles:true,clientX:box.left+x,clientY:box.top+y}));
 return target.id||target.tagName;};
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

    def rounded(self, pixel):
        # The pane rect can sit on a fractional device pixel; the mapping, not the rounding, is
        # what this asserts.
        return {key: round(value, 6) for key, value in pixel.items()}

    def calls(self):
        return self.page.evaluate("()=>({ct:viewports.ct.calls,mr:viewports.mr.calls,foreign:viewports.foreign.calls,volume:viewports.volume.calls})")

    # --- B8 1: slice distance ----------------------------------------------------------------
    def test_d1_a_marked_pane_reports_the_slice_distance_in_its_result(self):
        # The transported point is shown on the nearest slice of the target series; how far that
        # slice is from the point is the difference between a located point and a suggested one.
        self.page.evaluate("setPanes(['ct','mr','mro'])")
        self.enable()
        result = self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})")
        by_pane = {entry["paneId"]: entry for entry in result["results"]}
        self.assertEqual(0, by_pane["mr"]["distance"], "the MR slice plane contains the point")
        self.assertAlmostEqual(1.2, by_pane["mro"]["distance"], places=9)
        self.assertEqual(3, by_pane["mro"]["distanceLimit"])
        self.assertEqual(3, self.page.evaluate("cursor.state().sliceDistanceLimit"))
        self.assertEqual("3D Cursor 표시됨 · 선택점에서 단면까지 1.2 mm", result["status"])
        panes = {pane["id"]: pane for pane in self.page.evaluate("cursor.state().panes")}
        self.assertAlmostEqual(1.2, panes["mro"]["distance"], places=9)
        self.assertEqual([4], self.page.evaluate("viewports.mro.calls"))
        # The visible sentence names the slice distance and never an accuracy or an error.
        for banned in ("정확도", "오차", "정밀도", "±"):
            self.assertNotIn(banned, result["status"])
        # An injected limit below that distance refuses the pane with its own reason and payload.
        self.page.evaluate("cursor.stop();__mount({sliceDistanceLimit:1});setPanes(['ct','mr','mro'])")
        self.enable()
        result = self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})")
        refused = [entry for entry in result["results"] if entry["paneId"] == "mro"][0]
        self.assertEqual("slice-distance-exceeded", refused["reason"])
        self.assertAlmostEqual(1.2, refused["distance"], places=9)
        self.assertEqual(1, refused["limit"])
        self.assertEqual("1 pane(s): 선택점이 이 시리즈의 어느 단면에서도 멀리 있습니다.", result["status"])
        self.assertEqual([4], self.page.evaluate("viewports.mro.calls"), "a refused pane is never navigated")
        self.assertEqual(["pane-ct", "pane-mr"], [mark["pane"] for mark in self.marks()])

    # --- B8 2: a marker is committed only after the image is displayed -----------------------
    def marked(self):
        return self.page.evaluate("()=>cursor.state().panes.filter(p=>p.marked).map(p=>p.id)")

    def test_d2_a_marker_is_not_committed_until_the_target_image_is_actually_rendered(self):
        # The index moves before the pixels do, so neither the index nor a resolved request is
        # the observation that commits a marker: only the image the renderer is holding is.
        self.enable()
        self.page.evaluate("viewports.mr.discard=true")
        result = self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})")
        self.assertEqual([4, 0], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual("mr:0", self.page.evaluate("viewports.mr.csImage.imageId"))
        self.assertEqual("target-not-confirmed", [r for r in result["results"] if r["paneId"] == "mr"][0]["reason"])
        self.assertEqual(["ct"], self.marked())
        self.assertEqual(["pane-ct"], [mark["pane"] for mark in self.marks()])
        # The load that never completes: the index already reads as the target frame.
        self.page.evaluate("cursor.stop();__mount({confirmAttempts:400,navigationAttempts:4000})")
        self.page.evaluate("viewports.mr.discard=false;scrollTo_('mr',0)")
        self.enable()
        self.page.evaluate("viewports.mr.hold=true;window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("viewports.mr.pending.length===1")
        self.assertEqual(4, self.page.evaluate("viewports.mr.currentImageIdIndex"))
        self.assertEqual("mr:4", self.page.evaluate("viewports.mr.getCurrentImageId()"))
        self.assertEqual("mr:0", self.page.evaluate("viewports.mr.csImage.imageId"))
        self.assertEqual(["ct"], self.marked(), "the index alone must not commit the marker")
        self.page.evaluate("viewports.mr.hold=false;flush('mr')")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual(["ct", "mr"], self.marked())
        self.assertEqual(["pane-ct", "pane-mr"], [mark["pane"] for mark in self.marks()])

    def test_d2_a_render_event_invalidates_a_stale_marker_without_a_pick(self):
        # What a host adapter does on a render event is call refresh(); no click, no pick.
        self.page.evaluate("addSecondTarget()")
        self.enable()
        self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual(["ct", "mr", "mr2"], self.marked())
        # The renderer began loading another image into a marked pane: the index and the held
        # image still match, and only the status says the frame on screen is on its way out.
        self.page.evaluate("viewports.mr.viewportStatus='loading';cursor.refresh()")
        self.assertEqual(["ct", "mr2"], self.marked())
        self.assertEqual(["pane-ct", "pane-mr2"], [mark["pane"] for mark in self.marks()])
        # The same must hold while a run is awaiting: a refresh then may not rebind or move a
        # pane, but it must still drop a marker whose frame has gone.
        self.page.evaluate("viewports.mr.viewportStatus='rendered';cursor.stop();__mount({navigationAttempts:4000})")
        self.page.evaluate("scrollTo_('mr',0);scrollTo_('mr2',0);addSecondTarget()")
        self.enable()
        self.page.evaluate("viewports.mr2.hold=true;window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("viewports.mr2.pending.length===1")
        self.assertEqual(["ct", "mr"], self.marked())
        self.page.evaluate("scrollTo_('mr',6);cursor.refresh()")
        self.assertEqual(["ct"], self.marked())
        self.page.evaluate("viewports.mr2.hold=false;flush('mr2')")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual(["ct", "mr2"], self.marked(), "the invalidated marker must not come back")
        self.assertEqual(["pane-ct", "pane-mr2"], [mark["pane"] for mark in self.marks()])

    def test_d2_a_failed_navigation_leaves_no_marker_and_reports_the_reason(self):
        self.enable()
        self.page.evaluate("viewports.mr.throwOnSet=true")
        result = self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})")
        self.assertEqual("navigation-failed", [r for r in result["results"] if r["paneId"] == "mr"][0]["reason"])
        self.assertEqual(["ct"], self.marked())
        # Two panes missed (the foreign-frame one always does); the count and the FIRST reason
        # are what the status carries, and the first miss here is the navigation that failed.
        self.assertEqual("2 pane(s): 대상 영상으로 이동하지 못했습니다.", result["status"])
        self.assertEqual("2 pane(s): 대상 영상으로 이동하지 못했습니다.", self.page.evaluate("cursor.state().status"))
        self.assertEqual(0, self.page.evaluate("document.querySelectorAll('#pane-mr [data-kin-3d-cursor-mark]').length"))

    # --- B8 3: bad IOP versus an ordinary oblique relation -----------------------------------
    def test_d3_every_reason_code_the_controller_can_emit_has_its_own_text(self):
        # A reason code that is not in the text table reaches the reader as the bare
        # '3D Cursor를 사용할 수 없습니다.', which explains nothing. Both product files are read
        # here so that a code added later without its sentence fails this test.
        import re
        # Literals that are DOM names, not reason codes. A new one has to be listed here on
        # purpose, which is the point: an unlisted new literal fails this test.
        non_reason = {"data-kin-3d-cursor-layer", "data-kin-3d-cursor-mark", "data-kin-3d-cursor-panel",
                      "kin-3d-cursor", "kin-3d-cursor-toggle", "kin-3d-cursor-status", "aria-pressed"}
        pattern = re.compile(r"'([a-z][a-z0-9]*(?:-[a-z0-9]+)+)'")
        found = set()
        for path in (MODEL, VIEWER):
            found |= set(pattern.findall(path.read_text(encoding="utf-8")))
        # Single-word codes carry no hyphen and are listed here explicitly.
        found |= {"stopped", "internal", "abandoned", "inactive", "restored", "off"}
        found -= non_reason
        self.assertIn("slice-distance-exceeded", found)
        self.assertIn("geometry-axes-invalid", found)
        self.assertNotIn("geometry-axes", found, "the ambiguous code must be gone, not renamed in one place")
        known = set(self.page.evaluate("KinViewerThreeDCursor.reasons()"))
        self.assertEqual(set(), found - known, "these reason codes have no text of their own")
        texts = {code: self.page.evaluate("KinViewerThreeDCursor.message(%r)" % code) for code in sorted(known)}
        # 'abandoned' is deliberately empty: a run whose session ended writes no status at all.
        for code, text in texts.items():
            if code == "abandoned":
                self.assertEqual("", text)
                continue
            self.assertTrue(text.strip(), code)
            if code != "internal":
                self.assertNotEqual("3D Cursor를 사용할 수 없습니다.", text, code)
        # An unsupported series shape is a limit of this feature, never an accusation.
        for code, text in texts.items():
            for banned in ("비정상", "잘못된 DICOM", "정확도", "오차", "정밀도"):
                self.assertNotIn(banned, text, code)
        for code in ("stack-too-short", "stack-spacing-nonuniform", "stack-orientation-mixed", "stack-duplicate-position"):
            self.assertIn("현재 지원하지 않는 시리즈 구성입니다", texts[code], code)
        self.assertEqual("이 영상의 방향 정보가 DICOM 규정을 벗어났습니다.", texts["geometry-axes-invalid"])

    def test_d3_a_defective_iop_is_reported_as_its_own_geometry_reason(self):
        # The controller surfaces the model's classification unchanged: |x| = 2 and |y| = 0.5 are
        # orthogonal and their cross product is a unit normal, so only the axis check refuses it.
        self.enable()
        self.page.evaluate("META.set('mr:3',{...META.get('mr:3'),ImageOrientationPatient:[2,0,0,0,0.5,0]})")
        self.page.evaluate("cursor.refresh()")
        panes = {pane["id"]: pane for pane in self.page.evaluate("cursor.state().panes")}
        self.assertEqual((False, "geometry-axes-invalid"), (panes["mr"]["eligible"], panes["mr"]["reason"]))
        result = self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})")
        self.assertEqual("geometry-axes-invalid", [r for r in result["results"] if r["paneId"] == "mr"][0]["reason"])
        self.assertEqual("2 pane(s): 이 영상의 방향 정보가 DICOM 규정을 벗어났습니다.", result["status"])
        self.assertEqual([], self.page.evaluate("viewports.mr.calls"))

    # --- B8 4: frames moved without any mouse event ------------------------------------------
    def watch_input(self):
        # Records every pointer event that reaches the document, so each test below can show that
        # the defence it exercises never had the revocation set to fall back on.
        self.page.evaluate(
            "()=>{window.mouseEvents=[];for(const type of ['pointerdown','pointerup','mousedown',"
            "'mouseup','click','wheel'])document.addEventListener(type,e=>mouseEvents.push(type),true);}")

    def assert_no_mouse_events(self):
        self.assertEqual([], self.page.evaluate("mouseEvents"))

    def test_d4_keyboard_arrow_move_during_a_run_is_not_overwritten_by_the_rollback(self):
        # A keyboard arrow is handled by the host, not by this controller: the pane moves and no
        # pointerdown or wheel is produced, so the revocation set stays empty and the issued-frame
        # comparison is the only thing that can refuse the rollback.
        self.watch_input()
        self.page.evaluate("cursor.stop();__mount({navigationAttempts:2});setPanes(['ct','mr','mr2'])")
        self.enable()
        self.page.evaluate(
            "viewports.mr2.hold=true;"
            "viewports.mr2.onHold=()=>{document.querySelector('#pane-mr').dispatchEvent("
            "new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));"
            "scrollTo_('mr',6);cursor.cancel('context-changed');};"
            "window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual("restore-skipped-user", self.page.evaluate("cursor.state().restores.mr"))
        self.assertEqual([4], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual(6, self.page.evaluate("viewports.mr.currentImageIdIndex"))
        self.assertEqual("mr:6", self.page.evaluate("viewports.mr.getCurrentImageId()"))
        self.assertEqual([], self.marks())
        self.assert_no_mouse_events()
        # The other half of the contract: the controller must not listen for the host's keys
        # either. A keydown on a pane may not cancel a run that is under way.
        # The request held above is abandoned with its controller; drop it so the wait below sees
        # only the request this phase makes.
        self.page.evaluate("viewports.mr2.pending.length=0;viewports.mr2.hold=false;cursor.stop()")
        self.page.evaluate("__mount();setPanes(['ct','mr','mr2']);scrollTo_('mr',0);scrollTo_('mr2',0)")
        self.enable()
        self.page.evaluate("viewports.mr2.hold=true;window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("viewports.mr2.pending.length===1")
        self.page.evaluate("document.querySelector('#pane-mr2').dispatchEvent("
                           "new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))")
        self.page.evaluate("viewports.mr2.hold=false;flush('mr2')")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertTrue(self.page.evaluate("picking").get("ok"))
        self.assertEqual(["ct", "mr", "mr2"], self.marked())
        self.assert_no_mouse_events()

    def test_d4_a_cine_advance_during_a_run_invalidates_that_panes_marker(self):
        # A cine timer moves the frame of a pane this run has already marked. No event of any kind
        # reaches the controller; the host's render adapter calls refresh(), and that must drop the
        # marker rather than leave it claiming an image that is no longer displayed.
        self.watch_input()
        self.page.evaluate("cursor.stop();__mount({navigationAttempts:4000});setPanes(['ct','mr','mr2'])")
        self.enable()
        self.page.evaluate(
            "viewports.mr2.hold=true;"
            "viewports.mr2.onHold=()=>setTimeout(()=>{scrollTo_('mr',5);cursor.refresh();},0);"
            "window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("cursor.state().panes.filter(p=>p.marked).length===1")
        self.assertEqual(["ct"], self.marked())
        self.assertTrue(self.page.evaluate("cursor.state().busy"))
        self.page.evaluate("viewports.mr2.hold=false;flush('mr2')")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual(["ct", "mr2"], self.marked())
        self.assertEqual(["pane-ct", "pane-mr2"], [mark["pane"] for mark in self.marks()])
        self.assertEqual([4], self.page.evaluate("viewports.mr.calls"), "the cine pane is never navigated again")
        self.assertEqual(5, self.page.evaluate("viewports.mr.currentImageIdIndex"))
        self.assert_no_mouse_events()

    def test_d4_a_synchronizer_move_without_pointer_events_relies_on_the_frame_comparison(self):
        # Another synchronisation tool moves the pane programmatically: no DOM event at all. The
        # rollback must still refuse, and the only defence left is the issued-frame comparison.
        self.watch_input()
        self.page.evaluate("cursor.stop();__mount({navigationAttempts:2});setPanes(['ct','mr','mr2'])")
        self.enable()
        self.page.evaluate("viewports.mr2.hold=true;"
                           "viewports.mr2.onHold=()=>{scrollTo_('mr',1);cursor.cancel('user-interrupt');};"
                           "window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual("restore-skipped-user", self.page.evaluate("cursor.state().restores.mr"))
        self.assertEqual([4], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual(1, self.page.evaluate("viewports.mr.currentImageIdIndex"))
        self.assertEqual([], self.marks())
        self.assert_no_mouse_events()
        # Contrast, same run shape with nothing moving the pane: the rollback does happen, so the
        # refusal above is the frame comparison and not a rollback that never runs.
        self.page.evaluate("viewports.mr2.pending.length=0;viewports.mr2.hold=false;cursor.stop()")
        self.page.evaluate("__mount({navigationAttempts:2});setPanes(['ct','mr','mr2'])")
        self.page.evaluate("scrollTo_('mr',0);scrollTo_('mr2',0);viewports.mr.calls.length=0")
        self.enable()
        self.page.evaluate("viewports.mr2.hold=true;"
                           "viewports.mr2.onHold=()=>{cursor.cancel('user-interrupt');};"
                           "window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual([4, 0], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual(0, self.page.evaluate("viewports.mr.currentImageIdIndex"))
        self.assertEqual("restored", self.page.evaluate("cursor.state().restores.mr"))
        self.assert_no_mouse_events()

    def test_d4_a_late_render_from_a_previous_request_never_becomes_the_current_marker(self):
        # Run N leaves a request the renderer never finished; run N+1 marks a different frame.
        # When run N's load finally lands it may not mark, restore or claim anything.
        self.watch_input()
        self.page.evaluate("cursor.stop();__mount({navigationAttempts:2});setPanes(['ct','mr','mr2'])")
        self.enable()
        self.page.evaluate("viewports.mr2.hold=true;window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.set_default_timeout(15000)
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual(["mr2"], self.page.evaluate("cursor.state().quarantined"))
        self.assertEqual(["ct", "mr"], self.marked())
        run_n = {pane["id"]: pane["sop"] for pane in self.page.evaluate("cursor.state().panes")}
        self.assertEqual("1.2.3.9.5", run_n["mr"])
        # Run N+1 on another source frame: the same panes, different slices.
        self.page.evaluate("scrollTo_('ct',3)")
        result = self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})")
        self.assertEqual("navigation-unsettled", [r for r in result["results"] if r["paneId"] == "mr2"][0]["reason"])
        self.assertEqual(["ct", "mr"], self.marked())
        run_next = {pane["id"]: pane["sop"] for pane in self.page.evaluate("cursor.state().panes")}
        self.assertEqual(("1.2.3.4.4", "1.2.3.9.7"), (run_next["ct"], run_next["mr"]))
        # Run N's load lands now.
        self.page.evaluate("flush('mr2')")
        self.page.wait_for_timeout(50)
        self.page.evaluate("cursor.refresh()")
        after = {pane["id"]: pane["sop"] for pane in self.page.evaluate("cursor.state().panes")}
        self.assertEqual(run_next, after, "the late render must not change what is marked")
        self.assertEqual([4], self.page.evaluate("viewports.mr2.calls"))
        self.assertEqual(["ct", "mr"], self.marked())
        self.assertEqual({}, self.page.evaluate("cursor.state().restores"))
        self.assertEqual([4, 6], self.page.evaluate("viewports.mr.calls"))
        self.assert_no_mouse_events()
        self.assertEqual([], self.page.evaluate("unhandled"))

    # --- B8 5: what the reader can see -------------------------------------------------------
    def test_d5_the_toggle_reflects_the_active_state_and_deactivates_the_mode(self):
        # A mount without a host stays headless: the 36 pre-existing mounts must not grow a panel.
        self.assertEqual(0, self.page.evaluate("document.querySelectorAll('#kin-3d-cursor').length"))
        self.page.evaluate("cursor.stop();__mountHosted()")
        self.assertEqual({"label": "3D Cursor", "pressed": "false", "disabled": False},
                         self.page.evaluate("toggleState()"))
        self.page.evaluate("clickToggle()")
        self.assertEqual({"label": "Exit 3D Cursor", "pressed": "true", "disabled": False},
                         self.page.evaluate("toggleState()"))
        self.assertEqual("3D Cursor 대기", self.page.evaluate("panelText()"))
        self.assertTrue(self.page.evaluate("cursor.state().enabled"))
        self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual("1 pane(s): 같은 기준 좌표계가 아닙니다.", self.page.evaluate("panelText()"))
        # The same button is the only way out, and it really does leave the mode.
        self.page.evaluate("clickToggle()")
        self.page.wait_for_function("cursor.state().enabled===false")
        self.assertEqual({"label": "3D Cursor", "pressed": "false", "disabled": False},
                         self.page.evaluate("toggleState()"))
        self.assertEqual("3D Cursor를 껐습니다.", self.page.evaluate("panelText()"))
        self.assertEqual([], self.marks())
        self.assertEqual({"ok": False, "reason": "inactive"}, self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})"))

    def test_d5_enable_without_an_eligible_pane_shows_a_visible_reason(self):
        self.page.evaluate("cursor.stop();__mountHosted();setPanes(['volume'])")
        self.assertFalse(self.page.evaluate("cursor.enable()"))
        self.assertEqual("대상 시리즈가 없어 3D Cursor를 켜지 못했습니다.", self.page.evaluate("panelText()"))
        self.assertEqual("false", self.page.evaluate("toggleState().pressed"))
        # The button path must say the same thing rather than doing nothing visible.
        self.page.evaluate("clickToggle()")
        self.assertEqual("대상 시리즈가 없어 3D Cursor를 켜지 못했습니다.", self.page.evaluate("panelText()"))
        self.assertFalse(self.page.evaluate("cursor.state().enabled"))
        self.page.evaluate("setPanes(['ct','mr'])")
        self.page.evaluate("clickToggle()")
        self.assertEqual("3D Cursor 대기", self.page.evaluate("panelText()"))

    def test_d5_a_partial_run_shows_the_count_and_the_first_reason(self):
        self.page.evaluate("cursor.stop();__mountHosted({navigationAttempts:2});setPanes(['ct','mr','mr2','other'])")
        self.enable()
        self.page.evaluate("viewports.mr.throwOnSet=true")
        self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual("2 pane(s): 대상 영상으로 이동하지 못했습니다.", self.page.evaluate("panelText()"))
        self.assertEqual(["ct", "mr2"], self.marked())
        # An unconfirmed restoration is its own sentence and stays on screen after the run.
        self.page.evaluate("viewports.mr.throwOnSet=false;cursor.stop();__mountHosted({navigationAttempts:2})")
        self.page.evaluate("setPanes(['ct','mr','mr2']);scrollTo_('mr',0);scrollTo_('mr2',0)")
        self.enable()
        self.page.evaluate("viewports.mr2.hold=true;"
                           "viewports.mr2.onHold=()=>{viewports.mr.currentImageIdIndex=0;cursor.cancel('user-interrupt');};"
                           "window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual("restore-unconfirmed", self.page.evaluate("cursor.state().restores.mr"))
        self.assertEqual("다른 조작으로 취소했습니다. · 2 pane(s): 원래 영상으로 되돌린 것을 확인하지 못했습니다.",
                         self.page.evaluate("panelText()"))

    def test_d5_an_unsettled_teardown_disables_the_toggle_and_says_why(self):
        self.page.evaluate("cursor.stop();__mountHosted({drainAttempts:0});setPanes(['ct','mr'])")
        self.enable()
        self.page.evaluate("viewports.mr.hold=true;window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("viewports.mr.pending.length===1")
        self.assertEqual("unsettled", self.page.evaluate("cursor.disable('context-changed')"))
        self.assertTrue(self.page.evaluate("cursor.state().poisoned"))
        self.assertEqual({"label": "3D Cursor", "pressed": "false", "disabled": True},
                         self.page.evaluate("toggleState()"))
        self.assertEqual("끝나지 않은 영상 요청이 있어 3D Cursor를 닫았습니다. 이 창에서는 다시 켤 수 없습니다.",
                         self.page.evaluate("panelText()"))
        self.page.evaluate("clickToggle()")
        self.assertFalse(self.page.evaluate("cursor.state().enabled"))
        self.assertEqual("끝나지 않은 영상 요청이 있어 3D Cursor를 닫았습니다. 이 창에서는 다시 켤 수 없습니다.",
                         self.page.evaluate("panelText()"))
        self.page.set_default_timeout(15000)
        self.page.evaluate("flush('mr')")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual(True, self.page.evaluate("toggleState().disabled"))

    # --- review 184a433 blocking regressions -------------------------------------------------
    def test_b1_click_through_a_nested_inset_child_uses_the_viewport_rect(self):
        # A click landing on an inset canvas/overlay child must map to the canvas point the
        # renderer itself uses (client minus the enabled element rect), not the child offset.
        self.enable()
        self.page.evaluate("clickAt('#pane-ct',100,50)")
        self.page.wait_for_function("cursor.state().busy===false&&cursor.state().source!==null")
        self.assertEqual({"x": 100, "y": 50}, self.rounded(self.page.evaluate("cursor.state().source.pixel")))
        self.page.evaluate("clickAt('#pane-ct',12,9)")
        self.page.wait_for_function("cursor.state().source&&cursor.state().source.pixel.x===12")
        self.assertEqual({"x": 12, "y": 9}, self.rounded(self.page.evaluate("cursor.state().source.pixel")))

    def test_b1_a_click_without_a_usable_viewport_rect_is_refused(self):
        self.enable()
        self.page.evaluate("document.querySelector('#pane-ct').style.display='none'")
        self.page.evaluate(
            "()=>document.querySelector('#pane-ct').dispatchEvent("
            "new MouseEvent('click',{bubbles:true,clientX:40,clientY:40}))")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertIsNone(self.page.evaluate("cursor.state().source"))
        self.assertEqual([], self.marks())
        self.assertEqual([], self.page.evaluate("viewports.mr.calls"))

    def test_b2_a_pane_dropped_from_the_host_loses_its_marker_and_listeners(self):
        self.enable()
        self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual(2, len(self.marks()))
        self.page.evaluate("setPanes(['ct']);cursor.refresh()")
        # The dropped pane keeps nothing; the pane still bound keeps its own marker.
        self.assertEqual(0, self.page.evaluate("document.querySelectorAll('#pane-mr [data-kin-3d-cursor-layer]').length"))
        self.assertEqual(["pane-ct"], [m["pane"] for m in self.marks()])
        before = self.page.evaluate("cursor.state().run")
        self.page.evaluate("clickAt('#pane-mr',60,60)")
        self.page.wait_for_timeout(50)
        self.assertEqual(before, self.page.evaluate("cursor.state().run"))

    def test_b2_cleanup_never_removes_another_controllers_nodes(self):
        self.page.evaluate("addSecondTarget()")
        self.enable()
        self.page.evaluate("__mountSecond();cursor2.enable()")
        self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})")
        self.page.wait_for_function("cursor.state().busy===false")
        self.page.evaluate("cursor2.pick('mr2',{x:40,y:40})")
        self.page.wait_for_function("cursor2.state().busy===false")
        self.assertEqual(1, self.page.evaluate("cursor2.state().panes.filter(p=>p.marked).length"))
        self.page.evaluate("cursor.stop()")
        self.page.wait_for_function("cursor.state().stopped===true")
        self.assertEqual(1, self.page.evaluate("cursor2.state().panes.filter(p=>p.marked).length"))
        self.assertEqual(1, self.page.evaluate("document.querySelectorAll('[data-kin-3d-cursor-mark]').length"))
        self.page.evaluate("cursor2.stop()")
        self.page.wait_for_function("cursor2.state().stopped===true")
        self.assertEqual(0, self.page.evaluate("document.querySelectorAll('[data-kin-3d-cursor-layer]').length"))

    def test_b3_stop_during_an_active_pick_is_bounded_and_owns_the_rollback(self):
        self.enable()
        self.page.evaluate("viewports.mr.hold=true;window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("viewports.mr.pending.length===1")
        self.page.evaluate("window.stopping=cursor.stop();null")
        self.page.evaluate("viewports.mr.hold=false;flush('mr')")
        self.assertEqual("settled", self.page.evaluate("stopping"))
        self.assertEqual([4, 0], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual(0, self.page.evaluate("viewports.mr.currentImageIdIndex"))
        self.assertEqual([], self.marks())
        self.assertEqual(0, self.page.evaluate("document.querySelectorAll('[data-kin-3d-cursor-layer]').length"))

    def test_b3_stop_with_a_never_resolving_load_quarantines_instead_of_racing_it(self):
        self.page.evaluate("cursor.stop();__mount({navigationAttempts:2})")
        self.enable()
        self.page.evaluate("viewports.mr.hold=true;window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("viewports.mr.pending.length===1")
        self.page.set_default_timeout(15000)
        self.assertEqual("settled", self.page.evaluate("cursor.stop()"))
        state = self.page.evaluate("cursor.state()")
        self.assertEqual(["mr"], state["quarantined"])
        self.assertEqual("restore-blocked-unsettled", state["restores"]["mr"])
        self.assertEqual([4], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual([], self.marks())
        # A late settle after teardown must not navigate, mark or claim a restore.
        self.page.evaluate("flush('mr')")
        self.page.wait_for_timeout(50)
        self.assertEqual([4], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual([], self.marks())
        self.assertEqual([], self.page.evaluate("unhandled"))

    def test_b3_a_drain_that_cannot_finish_reports_unsettled_and_claims_nothing(self):
        self.page.evaluate("cursor.stop();__mount({drainAttempts:0})")
        self.enable()
        self.page.evaluate("viewports.mr.hold=true;window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("viewports.mr.pending.length===1")
        self.assertEqual("unsettled", self.page.evaluate("cursor.stop()"))
        self.assertEqual(0, self.page.evaluate("document.querySelectorAll('[data-kin-3d-cursor-layer]').length"))
        self.page.set_default_timeout(15000)
        self.page.evaluate("flush('mr')")
        self.page.wait_for_function("cursor.state().busy===false")
        # Teardown already happened, so the abandoned run must not drive the viewport afterwards.
        self.assertEqual([4], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual("restore-blocked-abandoned", self.page.evaluate("cursor.state().restores.mr"))
        self.assertEqual([], self.marks())

    def test_b3_a_never_resolving_restore_is_bounded_and_never_claimed_as_restored(self):
        self.page.evaluate("addSecondTarget();cursor.stop();__mount({navigationAttempts:2})")
        self.enable()
        # The cancel is raised from inside the page at the moment the second pane's load is held,
        # so the ordering does not depend on a round trip.
        self.page.evaluate("viewports.mr2.hold=true;"
                           "viewports.mr2.onHold=()=>{viewports.mr.hold=true;cursor.cancel('user-interrupt');};"
                           "window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("cursor.state().busy===false")
        # The pinned viewport writes the index before the load, so the rollback index is already
        # there while its pixels are not: that is exactly why it may not be called restored.
        self.assertEqual([4, 0], self.page.evaluate("viewports.mr.calls"))
        panes = {p["id"]: p for p in self.page.evaluate("cursor.state().panes")}
        self.assertEqual("restore-unconfirmed", panes["mr"]["restore"])
        self.assertEqual([], self.marks())

    def test_b4_a_user_scroll_on_a_moved_pane_is_never_overwritten_by_the_rollback(self):
        self.page.evaluate("addSecondTarget()")
        self.enable()
        self.page.evaluate("viewports.mr2.hold=true;window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("viewports.mr2.pending.length===1")
        self.assertEqual(4, self.page.evaluate("viewports.mr.currentImageIdIndex"))
        self.page.eval_on_selector("#pane-mr", "n=>n.dispatchEvent(new WheelEvent('wheel',{bubbles:true}))")
        self.page.evaluate("scrollTo_('mr',6)")
        self.page.evaluate("viewports.mr2.hold=false;flush('mr2')")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual([4], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual(6, self.page.evaluate("viewports.mr.currentImageIdIndex"))
        panes = {p["id"]: p for p in self.page.evaluate("cursor.state().panes")}
        self.assertEqual("restore-skipped-user", panes["mr"]["restore"])

    def test_b4_a_user_takeover_revokes_the_pane_even_at_the_same_index(self):
        self.page.evaluate("addSecondTarget()")
        self.enable()
        self.page.evaluate("viewports.mr2.hold=true;window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("viewports.mr2.pending.length===1")
        # The reader scrolled away and back: the index equals the one the run issued, but the
        # pane is theirs now and must not be driven back to the pre-run frame.
        self.page.eval_on_selector("#pane-mr", "n=>n.dispatchEvent(new WheelEvent('wheel',{bubbles:true}))")
        self.page.evaluate("scrollTo_('mr',4)")
        self.page.evaluate("viewports.mr2.hold=false;flush('mr2')")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual([4], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual(4, self.page.evaluate("viewports.mr.currentImageIdIndex"))
        panes = {p["id"]: p for p in self.page.evaluate("cursor.state().panes")}
        self.assertEqual("restore-skipped-user", panes["mr"]["restore"])

    def test_b4_a_frame_moved_without_a_pointer_event_is_never_overwritten(self):
        # Independent review D-3DCURSOR-801AD73 4-2. The two B4 tests above are both satisfied by
        # the revocation set, which only a pointerdown or a wheel on the pane can fill. A keyboard
        # arrow, another tool or a synchronizer moves the frame without either event, and then the
        # issued-frame comparison in restoreOne is the only thing that refuses the rollback.
        self.page.evaluate("addSecondTarget();cursor.stop();__mount({navigationAttempts:2})")
        self.enable()
        self.page.evaluate("viewports.mr2.hold=true;"
                           "viewports.mr2.onHold=()=>{scrollTo_('mr',6);cursor.cancel('context-changed');};"
                           "window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual([], self.page.evaluate("cursor.state().panes.filter(p=>p.marked)"))
        # No pointerdown and no wheel reached the pane, so nothing was revoked.
        self.assertEqual("restore-skipped-user", self.page.evaluate("cursor.state().restores.mr"))
        self.assertEqual([4], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual(6, self.page.evaluate("viewports.mr.currentImageIdIndex"))
        self.assertEqual("mr:6", self.page.evaluate("viewports.mr.getCurrentImageId()"))
        self.assertEqual([], self.marks())

    def test_b4_a_replaced_pane_reports_the_replacement_before_the_user_takeover(self):
        # Independent review D-3DCURSOR-801AD73 4-5: both conditions hold at once and the order of
        # the two checks decides the reported reason. Replacement is the cause that invalidates the
        # frame the run owned, so it must win over the takeover.
        self.page.evaluate("addSecondTarget()")
        self.enable()
        self.page.evaluate("viewports.mr2.hold=true;window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("viewports.mr2.pending.length===1")
        self.page.eval_on_selector("#pane-mr", "n=>n.dispatchEvent(new WheelEvent('wheel',{bubbles:true}))")
        self.page.evaluate("viewports.mr.replaceStack(SPARE,1)")
        self.page.evaluate("viewports.mr2.hold=false;flush('mr2')")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual("restore-skipped-replaced", self.page.evaluate("cursor.state().restores.mr"))
        self.assertEqual([4], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual(1, self.page.evaluate("viewports.mr.currentImageIdIndex"))
        self.assertEqual([], self.marks())

    # --- review-after-fix-1 blocking regressions ---------------------------------------------
    def test_c1_an_inset_enabled_element_maps_clicks_and_draws_the_marker_on_the_same_origin(self):
        # The product shape: the cornerstone enabled element is a bordered, inset descendant of
        # the pane container, and carries its own children.
        self.page.evaluate("setPanes(['inset','mr'])")
        self.assertTrue(self.enable())
        self.page.evaluate("clickAt('#enabled-inset',120,70)")
        self.page.wait_for_function("cursor.state().busy===false&&cursor.state().source!==null")
        self.assertEqual({"x": 120, "y": 70}, self.rounded(self.page.evaluate("cursor.state().source.pixel")))
        enabled_rect = self.page.evaluate("rectOf('#enabled-inset')")
        pane_rect = self.page.evaluate("rectOf('#pane-inset')")
        dot = self.page.evaluate("markRect()")
        self.assertIsNotNone(dot)
        # The drawn centre must sit on the enabled element's origin, not the pane's.
        self.assertAlmostEqual(enabled_rect["left"] + 120, dot["cx"], delta=0.51)
        self.assertAlmostEqual(enabled_rect["top"] + 70, dot["cy"], delta=0.51)
        self.assertGreater(abs(pane_rect["left"] + 120 - dot["cx"]), 5)
        self.assertGreater(abs(pane_rect["top"] + 70 - dot["cy"]), 5)

    def test_c1_a_marker_outside_the_visible_viewport_is_clipped_and_reported(self):
        self.page.evaluate("setPanes(['inset','mr'])")
        self.enable()
        self.page.evaluate("clickAt('#enabled-inset',150,150)")
        self.page.wait_for_function("cursor.state().busy===false&&cursor.state().source!==null")
        self.assertEqual(True, self.page.evaluate("cursor.state().panes.find(p=>p.id==='inset').visible"))
        # Pan the pinned viewport so the marked world point leaves the visible canvas.
        self.page.evaluate("viewports.inset.shift=[-400,-400];cursor.refresh()")
        pane = self.page.evaluate("cursor.state().panes.find(p=>p.id==='inset')")
        self.assertEqual(False, pane["visible"])
        self.assertEqual("none", self.page.evaluate("markRect()&&markRect().display"))
        self.assertEqual("hidden", self.page.evaluate(
            "getComputedStyle(document.querySelector('[data-kin-3d-cursor-layer]')).overflow"))

    def test_c1_a_click_in_the_pane_margin_outside_the_anchor_rect_is_refused(self):
        # Independent review D-3DCURSOR-801AD73 4-3. The listener sits on the pane container while
        # the point is measured against the inset enabled element, so the padding around that
        # element is clickable and produces negative or over-width coordinates. Zoomed in, such a
        # point still falls inside the image, so without the rect check a marker would appear for
        # a click that landed outside the displayed area.
        self.page.evaluate("setPanes(['inset','mr'])")
        self.assertTrue(self.enable())
        anchor = self.page.evaluate("rectOf('#enabled-inset')")
        pane = self.page.evaluate("rectOf('#pane-inset')")
        self.assertGreater(anchor["left"] - pane["left"], 5)
        for x, y in ((5, 5), (round(anchor["left"] - pane["left"] + anchor["width"] + 5), 60)):
            self.page.evaluate("clickAt('#pane-inset',%d,%d)" % (x, y))
            self.page.wait_for_timeout(50)
            self.assertEqual("영상 표시 영역 안을 클릭하세요.", self.page.evaluate("cursor.state().status"))
            self.assertIsNone(self.page.evaluate("cursor.state().source"))
            self.assertEqual(0, self.page.evaluate("cursor.state().run"))
            self.assertEqual([], self.marks())
            self.assertEqual([], self.page.evaluate("viewports.mr.calls"))
        # Contrast: the same listener answers a click that does land on the anchor.
        self.page.evaluate("clickAt('#enabled-inset',120,70)")
        self.page.wait_for_function("cursor.state().busy===false&&cursor.state().source!==null")
        self.assertEqual({"x": 120, "y": 70}, self.rounded(self.page.evaluate("cursor.state().source.pixel")))
        self.assertEqual(1, len(self.marks()))

    def test_c1_a_viewport_element_outside_its_pane_is_refused_as_pane_anchor(self):
        # Independent review D-3DCURSOR-801AD73 4-4. A host that answers with a viewport element
        # that is not the pane and not inside it would have clicks measured against an unrelated
        # rect, which is the silent-wrong-point failure again. Such a pane is refused instead.
        self.enable()
        self.page.evaluate("viewports.mr.element=document.querySelector('#pane-other');cursor.refresh()")
        panes = {p["id"]: p for p in self.page.evaluate("cursor.state().panes")}
        self.assertEqual((False, "pane-anchor"), (panes["mr"]["eligible"], panes["mr"]["reason"]))
        result = self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})")
        self.assertEqual("pane-anchor", [r for r in result["results"] if r["paneId"] == "mr"][0]["reason"])
        self.assertEqual([], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual(["pane-ct"], [m["pane"] for m in self.marks()])
        # The refused pane keeps no listener either: a click on it starts no run.
        before = self.page.evaluate("cursor.state().run")
        self.page.evaluate("clickAt('#pane-mr',60,60)")
        self.page.wait_for_timeout(50)
        self.assertEqual(before, self.page.evaluate("cursor.state().run"))

    def test_c1_a_host_positioned_pane_keeps_its_stylesheet_position_and_is_restored(self):
        self.page.evaluate("setPanes(['styled','mr2'])")
        self.enable()
        self.assertEqual("static", self.page.evaluate("getComputedStyle(document.querySelector('#pane-mr2')).position"))
        self.page.evaluate("cursor.pick('styled',{x:40,y:40})")
        self.page.wait_for_function("cursor.state().busy===false")
        # The host stylesheet keeps the styled pane; only the static pane is written to.
        self.assertEqual("", self.page.evaluate("document.querySelector('#pane-styled').style.position"))
        self.assertEqual("absolute", self.page.evaluate("getComputedStyle(document.querySelector('#pane-styled')).position"))
        self.assertEqual("relative", self.page.evaluate("document.querySelector('#pane-mr2').style.position"))
        self.page.evaluate("cursor.stop()")
        self.page.wait_for_function("cursor.state().stopped===true")
        self.assertEqual("", self.page.evaluate("document.querySelector('#pane-mr2').style.position"))
        self.assertEqual("", self.page.evaluate("document.querySelector('#pane-styled').style.position"))

    def test_c2_an_unsettled_teardown_permanently_refuses_re_enable(self):
        self.enable()
        self.page.evaluate("cursor.stop();__mount({drainAttempts:0})")
        self.enable()
        self.page.evaluate("viewports.mr.hold=true;window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("viewports.mr.pending.length===1")
        self.assertEqual("unsettled", self.page.evaluate("cursor.disable('context-changed')"))
        self.assertEqual(True, self.page.evaluate("cursor.state().poisoned"))
        self.assertFalse(self.page.evaluate("cursor.enable()"))
        self.assertFalse(self.page.evaluate("cursor.state().enabled"))
        self.assertEqual({"ok": False, "reason": "inactive"}, self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})"))

    def test_c2_an_abandoned_run_cannot_write_after_an_unsettled_teardown(self):
        self.page.evaluate("cursor.stop();__mount({drainAttempts:0})")
        self.enable()
        self.page.evaluate("viewports.mr.hold=true;window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("viewports.mr.pending.length===1")
        self.assertEqual("unsettled", self.page.evaluate("cursor.disable('context-changed')"))
        before = self.page.evaluate("()=>({run:cursor.state().run,status:cursor.state().status})")
        self.page.set_default_timeout(15000)
        self.page.evaluate("flush('mr')")
        self.page.wait_for_function("cursor.state().busy===false")
        after = self.page.evaluate("()=>({run:cursor.state().run,status:cursor.state().status})")
        self.assertEqual(before, after, "an abandoned run must not touch the run counter or status")
        self.assertEqual([4], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual([], self.marks())
        self.assertEqual("restore-blocked-abandoned", self.page.evaluate("cursor.state().restores.mr"))
        self.assertEqual([], self.page.evaluate("unhandled"))

    def test_c2_an_abandoned_run_that_rejects_late_is_fenced_the_same_way(self):
        self.page.evaluate("cursor.stop();__mount({drainAttempts:0})")
        self.enable()
        self.page.evaluate("viewports.mr.hold=true;window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("viewports.mr.pending.length===1")
        self.assertEqual("unsettled", self.page.evaluate("cursor.disable('context-changed')"))
        self.page.set_default_timeout(15000)
        self.page.evaluate("viewports.mr.pending.splice(0).forEach(()=>{});viewports.mr.rejectPending()")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual([4], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual([], self.marks())
        self.assertEqual([], self.page.evaluate("unhandled"))

    def test_c3_enable_without_an_eligible_pane_stays_off_and_attaches_nothing(self):
        self.page.evaluate("setPanes(['volume'])")
        self.assertFalse(self.page.evaluate("cursor.enable()"))
        self.assertFalse(self.page.evaluate("cursor.state().enabled"))
        self.page.evaluate("clickAt('#pane-volume',20,20)")
        self.page.wait_for_timeout(50)
        self.assertEqual(0, self.page.evaluate("cursor.state().run"))
        self.assertEqual({"ok": False, "reason": "inactive"}, self.page.evaluate("cursor.pick('volume',{x:1,y:1})"))

    def test_c3_two_panes_sharing_one_element_are_refused_as_ambiguous(self):
        self.page.evaluate("setPanes(['ct','sharedA','sharedB'])")
        self.enable()
        panes = {p["id"]: p for p in self.page.evaluate("cursor.state().panes")}
        for name in ("sharedA", "sharedB"):
            self.assertEqual((False, "pane-ambiguous"), (panes[name]["eligible"], panes[name]["reason"]))
        self.page.evaluate("cursor.pick('ct',{x:460,y:237.5})")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual([], self.page.evaluate("viewports.shared.calls"))

    def test_c3_a_no_write_rollback_is_only_called_restored_when_the_pixels_confirm_it(self):
        self.page.evaluate("addSecondTarget();cursor.stop();__mount({navigationAttempts:2})")
        self.enable()
        # The index is back on the pre-run frame through a path this controller never saw, but the
        # pinned viewport still holds the frame this run issued: nothing to write, nothing to claim.
        self.page.evaluate("viewports.mr2.hold=true;"
                           "viewports.mr2.onHold=()=>{viewports.mr.currentImageIdIndex=0;cursor.cancel('user-interrupt');};"
                           "window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual([4], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual("restore-unconfirmed", self.page.evaluate("cursor.state().restores.mr"))
        # Contrast: the same no-write shortcut with the pixels actually showing the start frame.
        # A fresh controller is the documented way to clear a quarantine.
        self.page.evaluate("cursor.stop();__mount({navigationAttempts:2});scrollTo_('mr',0);scrollTo_('mr2',0)")
        self.enable()
        self.page.evaluate("viewports.mr2.hold=true;"
                           "viewports.mr2.onHold=()=>{scrollTo_('mr',0);cursor.cancel('user-interrupt');};"
                           "window.picking=cursor.pick('ct',{x:460,y:237.5});null")
        self.page.wait_for_function("cursor.state().busy===false")
        self.assertEqual([4, 4], self.page.evaluate("viewports.mr.calls"))
        self.assertEqual("restored", self.page.evaluate("cursor.state().restores.mr"))

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
        self.assertEqual([("pane-ct", "1.2.3.4.3"), ("pane-mr", "1.2.3.9.5")],
                         [(m["pane"], m["sop"]) for m in self.marks()])
        centres = [{key: (round(value, 3) if isinstance(value, float) else value) for key, value in mark.items()}
                   for mark in self.page.evaluate("markCenters()")]
        self.assertEqual(
            [{"pane": "pane-ct", "sop": "1.2.3.4.3", "x": 460, "y": 237.5, "display": "block"},
             {"pane": "pane-mr", "sop": "1.2.3.9.5", "x": 44, "y": 4, "display": "block"}],
            centres, "the drawn centre must sit on the canvas point of its own anchor")
        self.assertEqual("identity-frame", [r for r in result["results"] if r["paneId"] == "other"][0]["reason"])
        self.assertEqual(4, self.page.evaluate("viewports.mr.currentImageIdIndex"))
        self.assertEqual(2, self.page.evaluate("viewports.ct.currentImageIdIndex"))
        self.assertEqual([{"uid": "existing-length", "kept": True}], self.page.evaluate("annotations"))
        self.assertEqual([], self.page.evaluate("toolCalls"))
        self.assertEqual("KEEP", self.page.evaluate("document.querySelector('#volume-keep').textContent"))

    def test_a_real_click_on_a_bound_pane_picks_that_pane_point(self):
        self.enable()
        # A real pointerdown precedes the click; it must not swallow or duplicate the pick.
        self.page.evaluate("clickAt('#pane-ct',100,50)")
        self.page.wait_for_function("cursor.state().busy===false&&cursor.state().source!==null")
        state = self.page.evaluate("cursor.state().source")
        self.assertEqual(("ct", "1.2.3.4.3", [-200, -210, 10]), (state["paneId"], state["sop"], state["world"]))
        self.assertEqual({"x": 100, "y": 50}, self.rounded(state["pixel"]))
        self.assertEqual(["pane-ct"], [m["pane"] for m in self.marks()])
        self.assertEqual(1, self.page.evaluate("cursor.state().run"))
        self.assertEqual([], self.page.evaluate("viewports.volume.calls"))
        self.assertEqual([], self.page.evaluate("viewports.mr.calls"))
        # Picking from a pane of another frame of reference is allowed, but it carries nothing.
        self.page.evaluate("clickAt('#pane-other',100,50)")
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
