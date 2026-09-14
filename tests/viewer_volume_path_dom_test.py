# coding: utf-8
"""TEST-MPR-PATH-DOM: the real 3D Path panel and model on a controlled synthetic three-plane target.

Native proof lives in tests/e2e/test_volume_path.py. This module owns what a native run cannot order
exactly: late chunks of superseded requests, a viewport that never reports a render, a camera change
arriving after the render event, injected camera failures, off-plane editing, the capture gate and
restore rollback. Delay-0 timers can be held and released in a chosen order; pointer events, DOM and
canvas are real.
"""
from pathlib import Path
import math
import os
import unittest

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
# Mutation runs substitute a changed copy; the default is always the product file.
MODEL = Path(os.environ.get("KIN_PATH_MODEL_SOURCE", HPACS / "volume-path.js"))
PANEL = Path(os.environ.get("KIN_PATH_PANEL_SOURCE", HPACS / "viewer-volume-path.js"))
SOURCE = {"study": "2.25.100", "series": "2.25.200", "sops": ["2.25.%d" % (k + 1) for k in range(128)]}
# One point per plane family: axial z=16, sagittal x=16, coronal y=16, axial z=16 again.
POINTS = [(0, [4, 6, 16]), (1, [16, 14, 20]), (2, [24, 16, 14]), (0, [28, 28, 16])]

HARNESS = r"""
<div id="views" style="position:absolute;left:0;top:0;display:flex;gap:6px"></div><div id="host" style="position:absolute;left:760px;top:0;width:520px"></div>
<script>
const realTimeout=window.setTimeout.bind(window);window.held=[];window.holdChunks=false;
window.setTimeout=(fn,ms,...args)=>{if(window.holdChunks&&!ms){window.held.push(()=>fn(...args));return 0;}return realTimeout(fn,ms,...args);};
window.release=(order)=>{window.holdChunks=false;const list=window.held.splice(0);if(order==='lifo')list.reverse();list.forEach(f=>f());return list.length;};
const DIMS=[128,128,128],SP=.25,FOR='1.2.826.0.1.3680043.2.1125.7';
window.field=(i,j,k)=>i+100*j+10000*k;
const data=new Float32Array(DIMS[0]*DIMS[1]*DIMS[2]);
for(let k=0;k<DIMS[2];k++)for(let j=0;j<DIMS[1];j++)for(let i=0;i<DIMS[0];i++)data[i+j*DIMS[0]+k*DIMS[0]*DIMS[1]]=field(i,j,k);
function makeVolume(mode){
  const manager=mode==='missing'?{}:{getCompleteScalarDataArray(){return data;}};
  return {volumeId:'vol-1',origin:[0,0,0],direction:[1,0,0,0,1,0,0,0,1],spacing:[SP,SP,SP],dimensions:DIMS,imageIds:Array.from({length:DIMS[2]},(_,k)=>'img-'+k),
    imageData:{indexToWorld:([i,j,k])=>[i*SP,j*SP,k*SP]},voxelManager:manager};
}
let volume=makeVolume('ok');window.swapVolume=mode=>{volume=makeVolume(mode);};
window.cornerstone={cache:{getVolume:id=>id==='vol-1'?volume:null},Enums:{Events:{CAMERA_MODIFIED:'CAMERA_MODIFIED',IMAGE_RENDERED:'IMAGE_RENDERED'}},
  metaData:{get:(type,id)=>type==='instance'&&id.startsWith('img-')?{SOPInstanceUID:'2.25.'+(Number(id.slice(4))+1),FrameOfReferenceUID:FOR}:null}};
Object.assign(window,{nativeEvents:0,renders:0,dropRenders:0,nudgeAfterRender:false});
const S=5;
function makeView(index,camera){
  const element=document.createElement('div');element.style.cssText='position:relative;width:240px;height:240px;background:#111';
  const canvas=document.createElement('canvas');canvas.width=240;canvas.height=240;canvas.style.cssText='display:block;width:240px;height:240px';element.append(canvas);document.querySelector('#views').append(element);
  for(const name of ['pointerdown','mousedown'])canvas.addEventListener(name,()=>{window.nativeEvents++;});
  let cam=structuredClone(camera),props={voiRange:{lower:0,upper:1300000},VOILUTFunction:'LINEAR',invert:false};
  const basis=()=>{const n=cam.viewPlaneNormal,u=cam.viewUp;return {u,r:[u[1]*n[2]-u[2]*n[1],u[2]*n[0]-u[0]*n[2],u[0]*n[1]-u[1]*n[0]]};};
  const view={id:'view-'+index,element,getVolumeId:()=>'vol-1',getCanvas:()=>canvas,getCamera:()=>structuredClone(cam),
    // A native render reports IMAGE_RENDERED on a later frame; a dropped render never reports.
    render(){window.renders++;if(window.dropRenders>0){window.dropRenders--;return;}requestAnimationFrame(()=>{element.dispatchEvent(new CustomEvent('IMAGE_RENDERED'));if(window.nudgeAfterRender&&index===0){window.nudgeAfterRender=false;view.setCamera({focalPoint:cam.focalPoint.map((n,i)=>n+(i===0?.5:0))});}});},
    setCamera(next){for(const [k,v] of Object.entries(next))if(v!==undefined)cam[k]=structuredClone(v);element.dispatchEvent(new CustomEvent('CAMERA_MODIFIED'));},
    getProperties:()=>structuredClone(props),setProperties(p){props={...props,...structuredClone(p)};},
    worldToCanvas(p){const {u,r}=basis(),d=p.map((x,i)=>x-cam.focalPoint[i]);return [120+S*(d[0]*r[0]+d[1]*r[1]+d[2]*r[2]),120-S*(d[0]*u[0]+d[1]*u[1]+d[2]*u[2])];},
    canvasToWorld([x,y]){const {u,r}=basis(),a=(x-120)/S,b=(120-y)/S;return cam.focalPoint.map((f,i)=>f+r[i]*a+u[i]*b);}};
  return view;
}
const at=(focal,normal,up)=>({focalPoint:focal,position:focal.map((n,i)=>n+normal[i]*100),viewPlaneNormal:normal,viewUp:up,parallelScale:24,flipHorizontal:false,flipVertical:false});
window.views=[makeView(0,at([16,16,16],[0,0,1],[0,-1,0])),makeView(1,at([16,16,16],[1,0,0],[0,0,1])),makeView(2,at([16,16,16],[0,1,0],[0,0,1]))];
window.state={owner:'owner-1',permitted:true,group:'group-1',targetOff:false};
function target(verify=false,readOnly=false){
  if(state.targetOff)return null;
  if(verify&&readOnly!==true&&!state.permitted)throw Error('다른 작업을 마친 뒤 MPR 방향을 조절하세요.');
  return {source:{uid:'2.25.100',series:'2.25.200',viewportId:'view-0'},views,cameras:views.map(v=>v.getCamera()),group:state.group,selection:'selection-1'};
}
window.boot=()=>{window.tool=kinCreateVolumePath({target,permitted:()=>state.permitted,alive:()=>true,owner:()=>state.owner,host:document.querySelector('#host')});};
</script>
"""


def field_at(p):
    index = [n / .25 for n in p]
    if any(n < -.5 - 1e-6 or n > 127.5 + 1e-6 for n in index):
        return None
    i, j, k = [min(max(n, 0), 127) for n in index]
    return i + 100 * j + 10000 * k


class VolumePathDomTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={"width": 1400, "height": 1300})
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.set_content(HARNESS)
        for script in (HPACS / "volume-curved.js", HPACS / "volume-orientation.js", MODEL, PANEL):
            self.page.add_script_tag(content=Path(script).read_text(encoding="utf-8"))
        self.page.evaluate("boot()")
        expect(self.page.locator("#kin-mpr-path")).to_be_visible()
        self.set_input("3D Path Half Height", "4")

    def tearDown(self):
        self.page.close()
        self.assertEqual(self.errors, [])

    # -- helpers -----------------------------------------------------------------------------
    def screen(self, view, point):
        return self.page.evaluate("([i,p])=>{const v=views[i],xy=v.worldToCanvas(p),r=v.element.getBoundingClientRect();return [r.left+xy[0],r.top+xy[1]]}", [view, point])

    def button(self, name):
        return self.page.get_by_role("button", name=name, exact=True)

    def set_input(self, label, value):
        field = self.page.get_by_label(label, exact=True)
        field.fill(str(value))
        field.dispatch_event("change")

    def state(self):
        return self.page.locator("#kin-mpr-path p[data-kin-path-state]")

    def status(self):
        return self.page.locator("#kin-mpr-path [role=status]")

    def inspect(self, values=False):
        return self.page.evaluate("v=>kinMprPath.inspect({values:v})", values)

    def capture_error(self):
        return self.page.evaluate("()=>{try{kinMprPath.capture();return ''}catch(e){return e.message}}")

    def cameras(self):
        return self.page.evaluate("()=>views.map(v=>v.getCamera())")

    def add(self, points=POINTS, finish=True):
        self.button("Add Points").click()
        for view, point in points:
            self.page.mouse.click(*self.screen(view, point))
        if finish:
            self.button("Finish Points").click()

    def final(self):
        expect(self.state()).to_have_text("Final", timeout=10000)
        report = self.inspect(True)
        self.assertEqual(report["final"]["signature"], report["current"])
        return report

    def drag(self, view, start, end, steps=6):
        self.page.mouse.move(*self.screen(view, start))
        self.page.mouse.down()
        self.page.mouse.move(*self.screen(view, end), steps=steps)
        self.page.mouse.up()

    # -- cases -------------------------------------------------------------------------------
    def test_path_dom_01_points_on_three_planes_projected_overlay_final_and_capture(self):
        page = self.page
        self.add(finish=False)
        # The panel owned every press: native tools received neither pointerdown nor mousedown.
        self.assertEqual(page.evaluate("nativeEvents"), 0)
        self.assertIn("Finish Points", self.capture_error())
        self.button("Finish Points").click()
        report = self.final()
        value = report["value"]
        self.assertEqual((value["cell"], value["frameOfReference"], value["output"]["spacing"]), (0, "1.2.826.0.1.3680043.2.1125.7", .25))
        points = value["points"]
        self.assertEqual(len(points), 4)
        for (view, want), got in zip(POINTS, points):
            self.assertTrue(all(abs(a - b) <= .2 for a, b in zip(got, want)), got)
        # Each point lies exactly on the slice of the plane it was picked on.
        self.assertEqual((points[0][2], points[1][0], points[2][1], points[3][2]), (16, 16, 16, 16))
        a, b, c = ([points[n][k] - points[0][k] for k in range(3)] for n in (1, 2, 3))
        triple = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
        self.assertGreater(abs(triple), 100, "the four picked points are not coplanar")
        # Every plane shows the projected path; filled points lie on that plane, dashed ones do not.
        self.assertEqual(page.evaluate("[...document.querySelectorAll('.kin-mpr-path-overlay [data-kin-path-plane]')].map(e=>e.dataset.kinPathPlane)"), ["2", "1", "1"])
        self.assertEqual(page.evaluate("[...document.querySelectorAll('.kin-mpr-path-overlay')].map(o=>[...o.querySelectorAll('[data-kin-path-point]')].map(c=>c.dataset.kinPathOn).join(','))"),
                         ["on,off,off,on", "off,on,off,off", "off,off,on,off"])
        self.assertEqual(page.evaluate("document.querySelectorAll('.kin-mpr-path-overlay polyline').length"), 3)
        final = report["final"]
        # Row `half` at column 0 is the first control point itself.
        self.assertAlmostEqual(final["values"][final["half"] * final["columns"]], field_at(points[0]), delta=1e-6)
        expect(page.locator("#kin-mpr-path .badge")).to_have_text("UNFOLDED 3D PATH · Derived display · Not a source image")
        expect(page.locator("#kin-mpr-path .caption")).to_contain_text("Arc length %.2f mm" % final["length"])
        self.assertNotIn("kin-path", page.locator("#kin-mpr-path").inner_text())
        captured = page.evaluate("()=>kinMprPath.capture()")
        self.assertEqual(captured, value)
        self.assertTrue(page.evaluate("kinMprPath.dirty()"))
        page.evaluate("([v,s])=>kinMprPath.saved(v,s)", [captured, SOURCE])
        self.assertFalse(page.evaluate("kinMprPath.dirty()"))
        page.mouse.click(*self.screen(1, [16, 30, 30]))
        self.assertGreater(page.evaluate("nativeEvents"), 0)

    def test_path_dom_02_only_on_plane_points_move_and_invalid_proposals_keep_the_last_valid_path(self):
        page = self.page
        self.add()
        points = self.final()["value"]["points"]
        self.drag(0, points[0], [6, 8, 16])
        report = self.final()
        self.assertTrue(abs(report["value"]["points"][0][0] - 6) <= .2 and report["value"]["points"][0][2] == 16)
        # The initial normal stored after the edit is the canonical one for the new start.
        normal = report["value"]["frame"]["initialNormal"]
        self.assertAlmostEqual(math.hypot(*normal), 1, delta=1e-9)
        # The projection of a point from another depth cannot be dragged here.
        before = report["value"]
        self.drag(0, points[1], [10, 10, 16])
        expect(self.status()).to_contain_text("이 평면 위에 있는 점만")
        self.assertEqual(self.inspect()["value"], before)
        # Dragging out of the volume stops at the last valid position.
        self.drag(0, points[3], [40, 28, 16], steps=12)
        expect(self.status()).to_contain_text("볼륨 밖")
        moved = self.final()["value"]
        self.assertLessEqual(moved["points"][3][0], 31.875)
        self.assertNotEqual(moved["points"][3], [40, 28, 16])
        self.assertEqual(self.inspect()["value"]["points"][3], moved["points"][3])
        # A point that turns the path straight back on itself is refused and the path is unchanged.
        # A tight loop the samples can follow is a valid path, so the fold-back here is exactly
        # collinear: at 5 px/mm about the (16,16,16) focal point these three points are whole
        # pixels. The model is asked first so a fixture that does not fold back fails loudly.
        self.button("Clear Path").click()
        straight = [(0, [4, 6, 16]), (0, [28, 28, 16])]
        self.add(straight)
        two = self.final()["value"]
        back = [16, 17, 16]
        self.assertTrue(page.evaluate("""([pts,q])=>{try{const points=[...pts,q];
          KinVolumePath.plan({points,output:{spacing:.25,halfHeight:4},frame:{initialNormal:KinVolumePath.initialNormal(points,.25,null)}});return false}catch(e){return /급하게/.test(e.message)}}""", [two["points"], back]))
        self.button("Add Points").click()
        page.mouse.click(*self.screen(0, back))
        expect(self.status()).to_contain_text("급하게 꺾이거나")
        self.button("Finish Points").click()
        self.assertEqual(self.final()["value"], two)

    def test_path_dom_03_delete_clear_and_reset_to_the_saved_path(self):
        page = self.page
        self.add()
        saved = page.evaluate("()=>kinMprPath.capture()") if self.final() else None
        page.evaluate("([v,s])=>kinMprPath.saved(v,s)", [saved, SOURCE])
        page.mouse.click(*self.screen(0, saved["points"][3]))
        self.assertEqual(self.inspect()["selected"], 3)
        self.button("Delete Point").click()
        self.assertEqual(len(self.final()["value"]["points"]), 3)
        self.assertTrue(page.evaluate("kinMprPath.dirty()"))
        self.button("Reset Path").click()
        self.assertEqual(self.final()["value"], saved)
        self.assertFalse(page.evaluate("kinMprPath.dirty()"))
        self.button("Clear Path").click()
        expect(self.state()).to_have_text("No Path")
        self.assertIsNone(self.inspect()["value"])
        self.assertIn("", self.capture_error())
        self.assertTrue(page.evaluate("kinMprPath.dirty()"))
        self.button("Reset Path").click()
        self.assertEqual(self.final()["value"], saved)
        expect(self.button("Reset Path")).to_be_disabled()

    def test_path_dom_04_superseded_final_never_replaces_the_current_result(self):
        page = self.page
        # 100 mm keeps both the four- and three-point finals above one 65536-sample chunk.
        self.set_input("3D Path Half Height", "100")
        self.add()
        first = self.final()
        page.evaluate("holdChunks=true")
        self.drag(0, first["value"]["points"][3], [26, 30, 16])
        page.wait_for_function("held.length===1")
        expect(self.state()).to_have_text("Preview · refining")
        expect(page.locator("#kin-mpr-path .caption")).to_contain_text("최종 결과가 아닙니다")
        self.assertIn("최종 결과 계산이 끝난 뒤", self.capture_error())
        moved = self.inspect()["current"]
        self.button("Delete Point").click()
        page.wait_for_function("held.length===2")
        current = self.inspect()["current"]
        self.assertNotEqual(current, moved)
        self.assertEqual(page.evaluate("release('lifo')"), 2)
        report = self.final()
        self.assertEqual(report["final"]["signature"], current)
        self.assertEqual(len(report["value"]["points"]), 3)
        page.wait_for_timeout(400)
        self.assertEqual(self.inspect()["final"]["signature"], current)

    def test_path_dom_05_go_to_path_point_waits_for_every_render_verifies_and_rolls_back(self):
        page = self.page
        self.add()
        self.final()
        self.set_input("3D Path Position Column", 40)
        page.get_by_label("Perpendicular Plane Cell", exact=True).select_option("1")
        start = self.cameras()
        renders = page.evaluate("renders")
        self.button("Go to Path Point").click()
        expect(self.status()).to_contain_text("경로 수직 평면", timeout=10000)
        report = self.inspect()
        self.assertEqual(page.evaluate("renders") - renders, 3)
        nav = report["navigation"]
        self.assertEqual((nav["column"], nav["perpendicular"], nav["rendered"]), (40, 1, 3))
        expected = page.evaluate("""()=>{const v=kinMprPath.inspect().value,g=KinVolumePath.plan(v),c=40,at=a=>[a[c*3],a[c*3+1],a[c*3+2]];
          return {centre:at(g.centres),T:at(g.tangents),N:at(g.normals),B:at(g.binormals),intersection:KinVolumeOrientation.intersection(views.map(x=>x.getCamera()))}}""")
        now = self.cameras()
        for camera, (normal, up) in zip(now, [("N", "T"), ("T", "B"), ("B", "T")]):
            for got, want in zip(camera["viewPlaneNormal"] + camera["viewUp"] + camera["focalPoint"], expected[normal] + expected[up] + expected["centre"]):
                self.assertAlmostEqual(got, want, delta=1e-9)
        for got, want in zip(expected["intersection"], expected["centre"]):
            self.assertAlmostEqual(got, want, delta=1e-9)
        for old, new in zip(start, now):
            self.assertAlmostEqual(math.dist(old["position"], old["focalPoint"]), math.dist(new["position"], new["focalPoint"]), delta=1e-9)
            self.assertEqual(old["parallelScale"], new["parallelScale"])
        self.assertEqual([c["focalPoint"] for c in nav["cameras"]], [c["focalPoint"] for c in now])
        # A viewport that never reports its render: nothing is claimed, input is held, and every camera returns.
        page.evaluate("views.forEach((v,i)=>v.setCamera(structuredClone(window.startCams=window.startCams||null)||{}))")
        page.evaluate("s=>s.forEach((c,i)=>views[i].setCamera(c))", start)
        page.evaluate("dropRenders=1")
        self.button("Go to Path Point").click()
        page.wait_for_function("kinMprPath.inspect().busy===true")
        self.assertIn("이동이 끝난 뒤", self.capture_error())
        events = page.evaluate("nativeEvents")
        page.mouse.click(*self.screen(1, [16, 30, 30]))
        self.assertEqual(page.evaluate("nativeEvents"), events, "input is held while the planes are changing")
        expect(self.status()).to_contain_text("렌더링 완료를 확인하지 못했습니다", timeout=10000)
        expect(self.status()).to_contain_text("이전 화면으로 복구했습니다")
        self.assertIsNone(self.inspect()["navigation"])
        self.assertEqual(self.cameras(), start)
        # A camera change that lands after the render event is caught by the re-read, then rolled back.
        page.evaluate("nudgeAfterRender=true")
        self.button("Go to Path Point").click()
        expect(self.status()).to_contain_text("카메라를 확인하지 못했습니다", timeout=10000)
        expect(self.status()).to_contain_text("이전 화면으로 복구했습니다")
        self.assertEqual(self.cameras(), start)
        # A native camera write that throws part way rolls back all three planes.
        page.evaluate("""()=>{const v=views[2],original=v.setCamera;let failed=false;v.setCamera=function(c){if(c.viewPlaneNormal&&!failed){failed=true;throw Error('INJECTED CAMERA FAILURE')}return original.call(this,c)}}""")
        self.button("Go to Path Point").click()
        expect(self.status()).to_contain_text("INJECTED CAMERA FAILURE", timeout=10000)
        expect(self.status()).to_contain_text("이전 화면으로 복구했습니다")
        self.assertEqual(self.cameras(), start)
        # A flipped plane is refused before any camera is written.
        page.evaluate("views[0].setCamera({flipHorizontal:true})")
        self.button("Go to Path Point").click()
        expect(self.status()).to_contain_text("뒤집어 표시한 평면")

    def test_path_dom_06_capture_gate_null_without_work_refused_while_adding_or_previewing(self):
        page = self.page
        self.assertIsNone(page.evaluate("()=>kinMprPath.capture()"))
        self.assertFalse(page.evaluate("kinMprPath.dirty()"))
        self.set_input("3D Path Half Height", "100")
        self.add(POINTS[:1], finish=False)
        self.assertIn("Finish Points", self.capture_error())
        self.button("Finish Points").click()
        expect(self.state()).to_have_text("Incomplete")
        self.assertIn("두 개 이상", self.capture_error())
        page.evaluate("holdChunks=true")
        self.add(POINTS[1:3])
        page.wait_for_function("held.length>=1")
        self.assertIn("최종 결과 계산이 끝난 뒤", self.capture_error())
        page.evaluate("release()")
        value = self.final()["value"]
        self.assertEqual(page.evaluate("()=>kinMprPath.capture()"), value)
        page.evaluate("state.targetOff=true")
        page.wait_for_function("kinMprPath.inspect()===null")
        self.assertIn("3평면 화면을 확인하지 못했습니다", self.capture_error())
        expect(page.locator("#kin-mpr-path .drafts")).to_contain_text("Unsaved 3D path · 2.25.100 / 2.25.200 · 3 point(s)")
        page.evaluate("state.targetOff=false")
        page.evaluate("state.owner='owner-2'")
        expect(page.locator("#kin-mpr-path")).to_be_hidden()
        self.assertIn("계정이 변경", self.capture_error())

    def test_path_dom_07_restore_validates_the_saved_definition_and_rolls_back(self):
        page = self.page
        self.add()
        a = self.final()
        saved_a = page.evaluate("()=>kinMprPath.capture()")
        self.button("Clear Path").click()
        self.add([POINTS[0], POINTS[2]])
        self.final()
        saved_b = page.evaluate("()=>kinMprPath.capture()")
        page.evaluate("([v,s])=>kinMprPath.saved(v,s)", [saved_b, SOURCE])
        result = page.evaluate("async v=>{await kinMprPath.restore(v);return kinMprPath.inspect({values:true})}", saved_a)
        self.assertEqual(result["value"], saved_a)
        self.assertEqual(result["final"]["values"], a["final"]["values"])
        self.assertFalse(page.evaluate("kinMprPath.dirty()"))
        stale = [n + (2e-3 if k == 0 else 0) for k, n in enumerate(saved_b["frame"]["initialNormal"])]
        failures = [
            ("swapVolume('missing')", "v=>kinMprPath.restore(v)", "다시 계산하지 못했습니다", saved_b),
            ("0", "v=>kinMprPath.restore(v,()=>false)", "복원을 중단했습니다", saved_b),
            ("0", "v=>kinMprPath.restore(v,()=>true,Date.now()-1)", "복원을 중단했습니다", saved_b),
            ("0", "v=>kinMprPath.restore({...v,frameOfReference:'1.2.3'})", "좌표계", saved_b),
            ("0", "v=>kinMprPath.restore({...v,algorithm:'kin-path-2'})", "형식", saved_b),
            ("0", "v=>kinMprPath.restore({...v,output:{...v.output,spacing:.5}})", "출력 간격", saved_b),
            ("0", "v=>{const points=[[60,26,16],[26,26,16]];return kinMprPath.restore({...v,points,position:{column:0},frame:{...v.frame,initialNormal:KinVolumePath.initialNormal(points,.25,null)}})}", "볼륨 밖", saved_b),
            # A saved normal that is no longer perpendicular is refused, never silently re-projected.
            ("0", "v=>kinMprPath.restore(v)", "형식", {**saved_b, "frame": {**saved_b["frame"], "initialNormal": stale}}),
        ]
        for setup, call, message, value in failures:
            page.evaluate(setup)
            error = page.evaluate("async ([call,v])=>{try{await (eval(call))(v);return null}catch(e){return e.message}}", [call, value])
            self.assertIsNotNone(error, call)
            self.assertIn(message, error, call)
            if setup.startswith("swapVolume"):
                page.evaluate("swapVolume('ok')")
            report = self.final()
            self.assertEqual(report["value"], saved_a, call)
            self.assertFalse(page.evaluate("kinMprPath.dirty()"), call)

    def test_path_dom_08_angle_and_position_changes_and_column_clamp_after_shortening(self):
        page = self.page
        self.add()
        first = self.final()
        self.set_input("3D Path Unfold Angle", "450")
        report = self.final()
        self.assertEqual(report["value"]["unfold"]["angle"], 90)
        self.assertNotEqual(report["final"]["signature"], first["final"]["signature"])
        expect(page.locator("#kin-mpr-path .caption")).to_contain_text("Unfold angle 90°")
        self.set_input("3D Path Unfold Angle", "")
        expect(self.status()).to_contain_text("숫자로 입력")
        self.assertEqual(self.inspect()["value"]["unfold"]["angle"], 90)
        columns = report["final"]["columns"]
        self.set_input("3D Path Position Column", columns)
        expect(self.status()).to_contain_text("Path Position은 0~%d" % (columns - 1))
        self.set_input("3D Path Position Column", columns - 1)
        # The position moves only the marker; the unfolded values are not recomputed.
        self.assertEqual(self.inspect()["final"]["signature"], report["final"]["signature"])
        expect(page.locator("[data-kin-path-position]")).to_contain_text("columns 0–%d" % (columns - 1))
        page.mouse.click(*self.screen(0, report["value"]["points"][3]))
        self.button("Delete Point").click()
        shorter = self.final()
        self.assertEqual(shorter["value"]["position"]["column"], shorter["final"]["columns"] - 1)
        self.assertLess(shorter["final"]["columns"], columns)

    def test_path_dom_09_dispose_removes_surfaces_and_retires_the_capability(self):
        page = self.page
        self.add()
        self.final()
        page.evaluate("()=>{window.retired=kinMprPath;tool.dispose()}")
        expect(page.locator("#kin-mpr-path")).to_have_count(0)
        expect(page.locator(".kin-mpr-path-overlay")).to_have_count(0)
        self.assertIsNone(page.evaluate("window.kinMprPath??null"))
        self.assertTrue(page.evaluate("()=>{try{retired.capture();return false}catch(_){return true}}"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
