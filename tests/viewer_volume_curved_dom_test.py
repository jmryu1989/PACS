# coding: utf-8
"""TEST-MPR-CURVED-DOM: the real Curved MPR panel and model on a controlled synthetic target.

Native proof lives in tests/e2e/test_volume_curved.py. This module owns what a native run cannot
order exactly: late chunks of superseded requests, target/owner loss mid-computation, off-plane
editing, scalar absence, the capture gate and restore rollback. Delay-0 timers can be held and
released in a chosen order; every other browser behaviour (pointer events, DOM, canvas) is real.
"""
from pathlib import Path
import math
import os
import unittest

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
# Mutation runs substitute a changed copy; the default is always the product file.
MODEL = Path(os.environ.get("KIN_CURVED_MODEL_SOURCE", ROOT / "worklist-v0" / "hpacs-lite" / "volume-curved.js"))
PANEL = Path(os.environ.get("KIN_CURVED_PANEL_SOURCE", ROOT / "worklist-v0" / "hpacs-lite" / "viewer-volume-curved.js"))
SOURCE = {"study": "2.25.100", "series": "2.25.200", "sops": ["2.25.%d" % (k + 1) for k in range(128)]}

HARNESS = r"""
<div id="views" style="position:absolute;left:0;top:0;display:flex;gap:6px"></div><div id="host" style="position:absolute;left:760px;top:0;width:520px"></div>
<script>
const realTimeout=window.setTimeout.bind(window);window.held=[];window.holdChunks=false;
window.setTimeout=(fn,ms,...args)=>{if(window.holdChunks&&!ms){window.held.push(()=>fn(...args));return 0;}return realTimeout(fn,ms,...args);};
window.release=(order)=>{window.holdChunks=false;const list=window.held.splice(0);if(order==='lifo')list.reverse();list.forEach(f=>f());return list.length;};
const DIMS=[128,128,128],SP=.25,FOR='1.2.826.0.1.3680043.2.1125.7';
// A linear field: trilinear sampling returns it exactly, so every value has a closed-form oracle.
window.field=(i,j,k)=>i+100*j+10000*k;
const data=new Float32Array(DIMS[0]*DIMS[1]*DIMS[2]);
for(let k=0;k<DIMS[2];k++)for(let j=0;j<DIMS[1];j++)for(let i=0;i<DIMS[0];i++)data[i+j*DIMS[0]+k*DIMS[0]*DIMS[1]]=field(i,j,k);
window.accessor={calls:0};
function makeVolume(mode){
  const manager=mode==='missing'?{}:{getCompleteScalarDataArray(){accessor.calls++;return mode==='short'?data.subarray(1):data;}};
  return {volumeId:'vol-1',origin:[0,0,0],direction:[1,0,0,0,1,0,0,0,1],spacing:[SP,SP,SP],dimensions:DIMS,imageIds:Array.from({length:DIMS[2]},(_,k)=>'img-'+k),
    imageData:{indexToWorld:([i,j,k])=>[i*SP,j*SP,k*SP],worldToIndex:([x,y,z])=>[x/SP,y/SP,z/SP]},voxelManager:manager};
}
let volume=makeVolume('ok');window.swapVolume=mode=>{volume=makeVolume(mode);};
window.cornerstone={cache:{getVolume:id=>id==='vol-1'?volume:null},Enums:{Events:{CAMERA_MODIFIED:'CAMERA_MODIFIED'}},
  metaData:{get:(type,id)=>type==='instance'&&id.startsWith('img-')?{SOPInstanceUID:'2.25.'+(Number(id.slice(4))+1),FrameOfReferenceUID:FOR}:null}};
window.nativeEvents=0;
const S=5;
function makeView(index,camera){
  const element=document.createElement('div');element.style.cssText='position:relative;width:240px;height:240px;background:#111';
  const canvas=document.createElement('canvas');canvas.width=240;canvas.height=240;canvas.style.cssText='display:block;width:240px;height:240px';element.append(canvas);document.querySelector('#views').append(element);
  for(const name of ['pointerdown','mousedown'])canvas.addEventListener(name,()=>{window.nativeEvents++;});
  let cam=structuredClone(camera),props={voiRange:{lower:0,upper:1300000},VOILUTFunction:'LINEAR',invert:false};
  const basis=()=>{const n=cam.viewPlaneNormal,u=cam.viewUp;return {u,r:[u[1]*n[2]-u[2]*n[1],u[2]*n[0]-u[0]*n[2],u[0]*n[1]-u[1]*n[0]]};};
  return {id:'view-'+index,element,getVolumeId:()=>'vol-1',getCanvas:()=>canvas,getCamera:()=>structuredClone(cam),render(){},
    setCamera(next){for(const [k,v] of Object.entries(next))if(v!==undefined)cam[k]=structuredClone(v);element.dispatchEvent(new CustomEvent('CAMERA_MODIFIED'));},
    getProperties:()=>structuredClone(props),setProperties(p){props={...props,...structuredClone(p)};},
    worldToCanvas(p){const {u,r}=basis(),d=p.map((x,i)=>x-cam.focalPoint[i]);return [120+S*(d[0]*r[0]+d[1]*r[1]+d[2]*r[2]),120-S*(d[0]*u[0]+d[1]*u[1]+d[2]*u[2])];},
    canvasToWorld([x,y]){const {u,r}=basis(),a=(x-120)/S,b=(120-y)/S;return cam.focalPoint.map((f,i)=>f+r[i]*a+u[i]*b);}};
}
const at=(focal,normal,up)=>({focalPoint:focal,position:focal.map((n,i)=>n+normal[i]*100),viewPlaneNormal:normal,viewUp:up,parallelScale:24,flipHorizontal:false,flipVertical:false});
window.views=[makeView(0,at([16,16,16],[0,0,1],[0,-1,0])),makeView(1,at([16,16,16],[1,0,0],[0,0,1])),makeView(2,at([16,16,16],[0,1,0],[0,0,1]))];
window.state={owner:'owner-1',permitted:true,group:'group-1',targetOff:false};
function target(verify=false,readOnly=false){
  if(state.targetOff)return null;
  if(verify&&readOnly!==true&&!state.permitted)throw Error('다른 작업을 마친 뒤 MPR 방향을 조절하세요.');
  return {source:{uid:'2.25.100',series:'2.25.200',viewportId:'view-0'},views,group:state.group};
}
window.boot=()=>{window.tool=kinCreateVolumeCurved({target,permitted:()=>state.permitted,alive:()=>true,owner:()=>state.owner,host:document.querySelector('#host')});};
</script>
"""


def catmull(points, kind):
    if kind == "freehand":
        return [list(p) for p in points]
    n, out = len(points), []
    at = lambda i: points[max(0, min(n - 1, i))]
    for i in range(n - 1):
        p0, p1, p2, p3 = at(i - 1), at(i), at(i + 1), at(i + 2)
        for j in range(16):
            t = j / 16
            out.append([.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t * t + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t ** 3) for k in range(3)])
    out.append(list(points[-1]))
    return out


def grid(value):
    """Independent oracle of kin-cpr-1 counts for an axis-aligned plane of the linear field."""
    line = catmull(value["points"], value["kind"])
    length = sum(math.dist(line[i], line[i - 1]) for i in range(1, len(line)))
    s, h = value["output"]["spacing"], value["output"]["halfHeight"]
    return length, math.floor(length / s + 1e-9) + 1, 2 * math.floor(h / s + 1e-9) + 1


def field_at(p):
    index = [n / .25 for n in p]
    if any(n < -.5 - 1e-6 or n > 127.5 + 1e-6 for n in index):
        return None
    i, j, k = [min(max(n, 0), 127) for n in index]
    return i + 100 * j + 10000 * k


class VolumeCurvedDomTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={"width": 1400, "height": 1100})
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.set_content(HARNESS)
        self.page.add_script_tag(content=MODEL.read_text(encoding="utf-8"))
        self.page.add_script_tag(content=PANEL.read_text(encoding="utf-8"))
        self.page.evaluate("boot()")
        expect(self.page.locator("#kin-mpr-curved")).to_be_visible()
        # 60 mm keeps every final here above one 65536-sample chunk, so a held yield is real.
        self.page.get_by_label("Curved MPR Half Height", exact=True).fill("60")

    def tearDown(self):
        self.page.close()
        self.assertEqual(self.errors, [])

    # -- helpers -----------------------------------------------------------------------------
    def screen(self, view, point):
        return self.page.evaluate("([i,p])=>{const v=views[i],xy=v.worldToCanvas(p),r=v.element.getBoundingClientRect();return [r.left+xy[0],r.top+xy[1]]}", [view, point])

    def button(self, name):
        return self.page.get_by_role("button", name=name, exact=True)

    def state(self):
        return self.page.locator("#kin-mpr-curved p[data-kin-curved-state]")

    def status(self):
        return self.page.locator("#kin-mpr-curved [role=status]")

    def inspect(self, values=False):
        return self.page.evaluate("v=>kinMprCurved.inspect({values:v})", values)

    def capture_error(self):
        # An accepted capture returns '' so a missing refusal fails as an assertion, not a TypeError.
        return self.page.evaluate("()=>{try{kinMprCurved.capture();return ''}catch(e){return e.message}}")

    def draw(self, points, view=0, finish=True):
        self.button("Draw Curve").click()
        for point in points:
            self.page.mouse.click(*self.screen(view, point))
        if finish:
            self.button("Finish Drawing").click()

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
    def test_curved_dom_01_draw_preview_final_capture_and_exact_values(self):
        page = self.page
        self.button("Draw Curve").click()
        page.mouse.click(*self.screen(0, [2, 4, 16]))
        page.mouse.click(*self.screen(0, [16, 28, 16]))
        # The panel owned both gestures: native tools received neither pointerdown nor mousedown.
        self.assertEqual(page.evaluate("nativeEvents"), 0)
        self.assertIn("Finish Drawing", self.capture_error())
        page.evaluate("holdChunks=true")
        page.mouse.click(*self.screen(0, [30, 6, 16]))
        page.wait_for_function("held.length>=1")
        # Final is running (first chunk done, second held): only the labelled preview is shown.
        expect(self.state()).to_have_text("Drawing · Preview · refining")
        expect(page.locator("#kin-mpr-curved .caption")).to_contain_text("최종 결과가 아닙니다")
        self.button("Finish Drawing").click()
        self.assertIn("최종 결과 계산이 끝난 뒤", self.capture_error())
        page.evaluate("release()")
        report = self.final()
        value = report["value"]
        self.assertEqual((value["kind"], value["cell"], value["frameOfReference"]), ("curved", 0, "1.2.826.0.1.3680043.2.1125.7"))
        self.assertEqual(value["plane"], {"origin": [16, 16, 16], "normal": [0, 0, 1], "viewUp": [0, -1, 0]})
        self.assertEqual(value["output"]["spacing"], .25)
        for got, want in zip(value["points"], [[2, 4, 16], [16, 28, 16], [30, 6, 16]]):
            self.assertTrue(all(abs(a - b) <= .2 for a, b in zip(got, want)), got)
            self.assertEqual(got[2], 16)
        length, columns, rows = grid(value)
        final = report["final"]
        self.assertAlmostEqual(final["length"], length, delta=1e-9)
        self.assertEqual((final["columns"], final["rows"], final["half"]), (columns, rows, 240))
        values = final["values"]
        # Row 240 is the curve: column 0 is the first point; row 0 is +normal (+60 mm, outside).
        self.assertAlmostEqual(values[240 * columns], field_at(value["points"][0]), delta=1e-6)
        self.assertAlmostEqual(values[224 * columns], field_at([value["points"][0][0], value["points"][0][1], 20]), delta=1e-6)
        self.assertIsNone(values[0])
        # z index = 304 - r: rows 0..176 are above the volume, rows 305..480 below it.
        self.assertEqual(final["outside"], 353 * columns)
        self.assertTrue(all(v is None for v in values[:177 * columns]))
        self.assertTrue(all(v is not None for v in values[177 * columns:305 * columns]))
        expect(page.locator("#kin-mpr-curved .badge")).to_have_text("CURVED MPR · Derived display · Not a source image")
        self.assertEqual(page.evaluate("[document.querySelector('#kin-mpr-curved canvas').width,document.querySelector('#kin-mpr-curved canvas').height]"), [columns, rows])
        captured = page.evaluate("()=>kinMprCurved.capture()")
        self.assertEqual(captured, value)
        self.assertTrue(page.evaluate("kinMprCurved.dirty()"))
        page.evaluate("([v,s])=>kinMprCurved.saved(v,s)", [captured, SOURCE])
        self.assertFalse(page.evaluate("kinMprCurved.dirty()"))
        # Outside an edit the native tools keep their events.
        page.mouse.click(*self.screen(1, [16, 30, 30]))
        self.assertGreater(page.evaluate("nativeEvents"), 0)

    def test_curved_dom_02_superseded_final_never_replaces_the_current_result(self):
        page = self.page
        self.draw([[2, 2, 16], [30, 30, 16], [2, 30, 16]])
        first = self.final()
        page.evaluate("holdChunks=true")
        self.drag(0, first["value"]["points"][2], [4, 28, 16])
        page.wait_for_function("held.length===1")
        moved = self.inspect()["current"]
        self.button("Delete Point").click()
        page.wait_for_function("held.length===2")
        current = self.inspect()["current"]
        self.assertNotEqual(current, moved)
        # The newer request resumes first; the older one resumes last and must be discarded.
        self.assertEqual(page.evaluate("release('lifo')"), 2)
        report = self.final()
        self.assertEqual(report["final"]["signature"], current)
        self.assertEqual(len(report["value"]["points"]), 2)
        page.wait_for_timeout(400)
        self.assertEqual(self.inspect()["final"]["signature"], current)
        expect(self.state()).to_have_text("Final")

    def test_curved_dom_03_target_and_owner_loss_cancel_without_losing_the_draft(self):
        page = self.page
        self.draw([[2, 2, 16], [30, 30, 16]])
        first = self.final()
        page.evaluate("holdChunks=true")
        self.drag(0, first["value"]["points"][1], [30, 26, 16])
        page.wait_for_function("held.length===1")
        page.evaluate("state.targetOff=true")
        page.wait_for_function("kinMprCurved.inspect()===null")
        page.evaluate("release()")
        self.assertIn("3평면 화면을 확인하지 못했습니다", self.capture_error())
        expect(page.locator("#kin-mpr-curved .drafts")).to_contain_text("Unsaved curve · 2.25.100 / 2.25.200 · 2 point(s)")
        page.evaluate("state.targetOff=false")
        report = self.final()
        self.assertTrue(abs(report["value"]["points"][1][1] - 26) <= .2)
        page.evaluate("state.owner='owner-2'")
        expect(page.locator("#kin-mpr-curved")).to_be_hidden()
        self.assertFalse(page.evaluate("kinMprCurved.dirty()"))
        self.assertIn("계정이 변경", self.capture_error())

    def test_curved_dom_04_off_plane_other_plane_and_outside_edits_are_refused(self):
        page = self.page
        self.draw([[4, 4, 16], [28, 8, 16]])
        before = self.final()["value"]
        page.evaluate("views[0].setCamera({focalPoint:[16,16,17],position:[16,16,117]})")
        expect(page.locator("[data-kin-curved-plane]")).to_have_text("+1.00 mm off curve plane · editing disabled")
        self.drag(0, [4, 4, 17], [10, 10, 17])
        expect(self.status()).to_contain_text("그리기 평면에서 벗어나")
        self.assertEqual(self.inspect()["value"], before)
        self.button("Go to Curve Plane").click()
        expect(page.locator("[data-kin-curved-plane]")).to_have_text("Curve plane · Curved MPR path")
        self.assertEqual(page.evaluate("views[0].getCamera().focalPoint"), [16, 16, 16])
        self.button("Draw Curve").click()
        page.mouse.click(*self.screen(1, [16, 20, 20]))
        expect(self.status()).to_contain_text("곡선을 그린 평면에서만")
        page.mouse.click(*self.screen(0, [33, 16, 16]))
        expect(self.status()).to_contain_text("볼륨 밖")
        self.button("Finish Drawing").click()
        self.assertEqual(self.inspect()["value"], before)
        page.get_by_label("Curved MPR Half Height", exact=True).fill("151")
        page.get_by_label("Curved MPR Half Height", exact=True).dispatch_event("change")
        expect(self.status()).to_contain_text("1~150 mm")
        self.assertEqual(self.inspect()["value"]["output"]["halfHeight"], 60)

    def test_curved_dom_05_scalar_absence_keeps_points_and_freehand_is_simplified(self):
        page = self.page
        page.evaluate("swapVolume('missing')")
        self.draw([[4, 4, 16], [28, 8, 16]])
        expect(self.state()).to_have_text("Failed", timeout=10000)
        expect(self.status()).to_contain_text("원본 화소 배열을 확인할 수 없어")
        self.assertIn("계산에 실패", self.capture_error())
        self.assertEqual(len(self.inspect()["value"]["points"]), 2)
        page.evaluate("swapVolume('short')")
        page.get_by_label("Curved MPR Half Height", exact=True).fill("10")
        page.get_by_label("Curved MPR Half Height", exact=True).dispatch_event("change")
        expect(self.state()).to_have_text("Failed", timeout=10000)
        expect(self.status()).to_contain_text("길이가 볼륨 크기와 달라")
        page.evaluate("swapVolume('ok')")
        page.get_by_label("Curved MPR Half Height", exact=True).fill("12")
        page.get_by_label("Curved MPR Half Height", exact=True).dispatch_event("change")
        self.assertEqual(self.final()["final"]["rows"], 97)
        self.button("Clear Curve").click()
        page.get_by_label("Curve Type", exact=True).select_option("freehand")
        self.button("Draw Curve").click()
        self.drag(0, [2, 2, 16], [30, 30, 16], steps=40)
        report = self.final()
        self.assertEqual(report["value"]["kind"], "freehand")
        self.assertEqual(report["value"]["interpolation"], "linear")
        self.assertTrue(2 <= len(report["value"]["points"]) <= 128)
        expect(self.button("Draw Curve")).to_be_disabled()

    def test_curved_dom_06_restore_waits_for_final_and_rolls_back_on_failure(self):
        page = self.page
        self.draw([[2, 4, 16], [16, 28, 16], [30, 6, 16]])
        a = self.final()
        saved_a = page.evaluate("()=>kinMprCurved.capture()")
        self.button("Clear Curve").click()
        self.draw([[6, 26, 16], [26, 26, 16]])
        self.final()
        saved_b = page.evaluate("()=>kinMprCurved.capture()")
        page.evaluate("([v,s])=>kinMprCurved.saved(v,s)", [saved_b, SOURCE])
        result = page.evaluate("async v=>{await kinMprCurved.restore(v);return kinMprCurved.inspect({values:true})}", saved_a)
        self.assertEqual(result["value"], saved_a)
        self.assertEqual(result["final"]["signature"], result["current"])
        self.assertEqual(result["final"]["values"], a["final"]["values"])
        self.assertFalse(page.evaluate("kinMprCurved.dirty()"))
        failures = [
            # A changed volume object fails the recomputation; the rollback curve is recomputed
            # once the volume is readable again.
            ("swapVolume('missing')", "v=>kinMprCurved.restore(v)", "다시 계산하지 못했습니다"),
            ("0", "v=>kinMprCurved.restore(v,()=>false)", "복원을 중단했습니다"),
            # The screen changes after the recomputation finished but before it is accepted.
            ("window.checks=0", "v=>kinMprCurved.restore(v,()=>++checks<2)", "복원을 중단했습니다"),
            ("0", "v=>kinMprCurved.restore(v,()=>true,Date.now()-1)", "복원을 중단했습니다"),
            ("0", "v=>kinMprCurved.restore({...v,frameOfReference:'1.2.3'})", "좌표계"),
            ("0", "v=>kinMprCurved.restore({...v,algorithm:'kin-cpr-2'})", "형식"),
            ("0", "v=>kinMprCurved.restore({...v,output:{...v.output,spacing:.5}})", "출력 간격"),
            ("0", "v=>kinMprCurved.restore({...v,points:[[60,26,16],[26,26,16]],plane:v.plane})", "볼륨 밖"),
        ]
        for setup, call, message in failures:
            page.evaluate(setup)
            error = page.evaluate("async ([call,v])=>{try{await (eval(call))(v);return null}catch(e){return e.message}}", [call, saved_b])
            self.assertIsNotNone(error, call)
            self.assertIn(message, error, call)
            page.evaluate("swapVolume('ok')") if setup.startswith("swapVolume('missing')") else None
            report = self.final()
            self.assertEqual(report["value"], saved_a, call)
            self.assertFalse(page.evaluate("kinMprCurved.dirty()"), call)

    def test_curved_dom_07_dispose_removes_surfaces_and_retires_the_capability(self):
        page = self.page
        self.draw([[4, 4, 16], [28, 8, 16]])
        self.final()
        page.evaluate("()=>{window.retired=kinMprCurved;tool.dispose()}")
        expect(page.locator("#kin-mpr-curved")).to_have_count(0)
        expect(page.locator(".kin-mpr-curved-overlay")).to_have_count(0)
        self.assertIsNone(page.evaluate("window.kinMprCurved??null"))
        self.assertTrue(page.evaluate("()=>{try{retired.capture();return false}catch(_){return true}}"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
