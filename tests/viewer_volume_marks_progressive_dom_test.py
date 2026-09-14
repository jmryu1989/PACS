# coding: utf-8
"""TEST-MPR-MARKS-PROGRESSIVE: an armed manual 3D point press is not turned into a progressive preview.

REQ-D-MPR-MARKS / REQ-D-MPR-PREFERENCES → RISK-D-MPR-MARK-LOSS / RISK-D-PREVIEW-OUTPUT → TEST-MPR-MARKS.
The real orientation host, progressive refinement and manual 3D annotation panel run in Chromium
against a synthetic three-plane thick-slab target whose mappers record every sample-distance write.
The host creates progressive refinement before the annotation panel, so its press listener runs first
on the same viewport element. A press the armed annotation tool consumes must not start a coarse
preview; otherwise the tool sees unresolved rendering and refuses every pick while Progressive
Rendering is on. A preview or unresolved refinement already on screen still refuses a pick, an
unarmed press still previews and refines, and either tool missing or retired leaves the other alone.
This is no GPU, pixel or native renderer proof.
"""
from pathlib import Path
import os
import unittest

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
MODEL = HPACS / "volume-marks.js"
ORIENTATION = HPACS / "viewer-volume-orientation.js"
PROGRESSIVE = Path(os.environ.get("KIN_PROGRESSIVE_SOURCE", HPACS / "viewer-volume-progressive.js"))
MARKS = Path(os.environ.get("KIN_MARKS_SOURCE", HPACS / "viewer-volume-marks.js"))

HARNESS = r"""
<style>body{margin:0}#sources{position:fixed;left:0;top:0;display:flex}#sources>div{position:relative;width:200px;height:160px}#host{position:absolute;left:0;top:200px;width:900px}</style>
<div id="sources"></div><div id="host"></div>
<script>
const BASE=.5;
const source={kind:'volume',viewportId:'axial',uid:'study-1',series:'series-1',sourceSignature:'source-1',selectionEpoch:1,study:{id:'SYNTHETIC-PID'}};
let alive=true;window.failRefine=false;const currentOwner=['hospital','reader'],notices=[],sampleWrites=[];
const cells=['axial','coronal','sagittal'].map((viewportId,x)=>({viewportId,x,y:0,isReady:true,displaySetInstanceUIDs:['ds']}));
const grid={viewports:new Map(cells.map(c=>[c.viewportId,c])),activeViewportId:'axial'};
// Screen right/up axes at 50 CSS px per mm around one shared focal point.
const planes={
  axial:{right:[1,0,0],camera:{focalPoint:[1.5,1.5,1.5],position:[1.5,1.5,11.5],viewUp:[0,-1,0],viewPlaneNormal:[0,0,1],parallelScale:4,parallelProjection:true,flipHorizontal:false,flipVertical:false}},
  coronal:{right:[1,0,0],camera:{focalPoint:[1.5,1.5,1.5],position:[1.5,-8.5,1.5],viewUp:[0,0,1],viewPlaneNormal:[0,-1,0],parallelScale:4,parallelProjection:true,flipHorizontal:false,flipVertical:false}},
  sagittal:{right:[0,1,0],camera:{focalPoint:[1.5,1.5,1.5],position:[11.5,1.5,1.5],viewUp:[0,0,1],viewPlaneNormal:[1,0,0],parallelScale:4,parallelProjection:true,flipHorizontal:false,flipVertical:false}}};
const dot=(a,b)=>a.reduce((sum,n,i)=>sum+n*b[i],0);
const enabled=new Map(),views=new Map();
function makeView(id,element){
  const canvas=document.createElement('canvas');canvas.width=200;canvas.height=160;canvas.style.cssText='display:block;width:200px;height:160px';element.append(canvas);
  const {right}=planes[id];let camera=structuredClone(planes[id].camera);
  // A persistent refinement failure lands on another distance instead of the requested original one.
  const mapper={distance:BASE,getSampleDistance(){return this.distance},setSampleDistance(value){sampleWrites.push([id,value]);this.distance=window.failRefine&&value===BASE?BASE*2:value},isDeleted:()=>false,getBlendMode:()=>3};
  const actor={getMapper:()=>mapper};
  return {id,type:'orthographic',element,mapper,getActors:()=>[{actor}],getCanvas:()=>canvas,getVolumeId:()=>'volume-1',getSlabThickness:()=>10,
    getCamera:()=>structuredClone(camera),setCamera(next){camera={...camera,...structuredClone(next)}},render(){},
    canvasToWorld:([x,y])=>camera.focalPoint.map((n,i)=>n+right[i]*(x-100)/50+camera.viewUp[i]*(80-y)/50),
    worldToCanvas:point=>{const d=point.map((n,i)=>n-camera.focalPoint[i]);return [100+50*dot(d,right),80-50*dot(d,camera.viewUp)]}};
}
for(const cell of cells){const element=document.createElement('div');document.querySelector('#sources').append(element);const view=makeView(cell.viewportId,element);views.set(cell.viewportId,view);enabled.set(element,{viewport:view});}
const imageIds=['frame-0','frame-1','frame-2','frame-3'];
const volume={volumeId:'volume-1',loadStatus:{loaded:true},framesLoaded:4,imageIds,dimensions:[4,4,4],spacing:[1,1,1],direction:[1,0,0,0,1,0,0,0,1],imageData:{indexToWorld:p=>[...p],worldToIndex:p=>[...p]}};
window.cornerstone={cache:{getVolume:id=>id==='volume-1'?volume:null},getEnabledElement:element=>enabled.get(element),
  metaData:{get:(_,id)=>{const k=imageIds.indexOf(id);return {SOPClassUID:'1.2.840.10008.5.1.4.1.1.2',Modality:'CT',SamplesPerPixel:1,PhotometricInterpretation:'MONOCHROME2',Rows:4,Columns:4,PixelSpacing:[1,1],ImagePositionPatient:[0,0,k],ImageOrientationPatient:[1,0,0,0,1,0],StudyInstanceUID:'study-1',SeriesInstanceUID:'series-1',SOPInstanceUID:'sop-'+k};}},
  Enums:{Events:{CAMERA_MODIFIED:'CAMERA_MODIFIED',IMAGE_RENDERED:'IMAGE_RENDERED'}}};
const services={viewportGridService:{getState:()=>grid,setViewportIsReady(){}},cornerstoneViewportService:{getCornerstoneViewport:id=>views.get(id)},
  displaySetService:{getDisplaySetByUID:()=>({StudyInstanceUID:'study-1',SeriesInstanceUID:'series-1',Modality:'CT'})}};
window.KinVolumeOrientation={intersection:()=>[1.5,1.5,1.5],rotate:c=>c};
window.kinViewerJobWorkspaceState=()=>({busy:false});
window.kinMprPreferences={read:()=>({progressive:true}),notice:text=>notices.push(text)};
const intervalCallbacks=new Map();window.setInterval=(fn,ms)=>{const list=intervalCallbacks.get(ms)||[];list.push(fn);intervalCallbacks.set(ms,list);return {ms,fn}};window.clearInterval=()=>{};
window.tick=ms=>(intervalCallbacks.get(ms)||[]).forEach(fn=>fn());
// Hold the wheel settle delay, so a preview is deterministically still on screen at the next press.
const realTimeout=window.setTimeout.bind(window),heldSettles=[];
window.setTimeout=(fn,ms,...args)=>ms===150?(heldSettles.push(fn),-heldSettles.length):realTimeout(fn,ms,...args);
window.releaseSettle=()=>heldSettles.splice(0).forEach(fn=>fn());
window.mountOrientation=()=>window.kinCreateVolumeOrientation({services,selected:()=>source,live:()=>alive,allowed:()=>true,owner:()=>currentOwner,host:document.querySelector('#host')});
// What the annotation panel accepted and what the renderer is actually drawing with, read together.
window.marksState=()=>{let marks=null,error=null;try{marks=window.kinMprMarks.capture(true).marks}catch(e){error=e.message}
  return {status:document.querySelector('#kin-mpr-marks [role=status]')?.textContent??null,marks,error,dirty:!!window.kinMprMarks?.dirty?.(),
    rows:document.querySelectorAll('#kin-mpr-marks .marks > div').length,labels:document.querySelectorAll('.kin-mpr-marks-overlay [data-mark-id]').length,
    refining:[...document.querySelectorAll('.kin-mpr-refining')].map(e=>e.textContent),busy:!!window.kinMprRenderingState?.busy?.(),
    distances:[...views.values()].map(v=>v.mapper.distance)}};
</script>
"""

POINT = (130, 60)
BASE = 0.5
STATUS = '#kin-mpr-marks [role=status]'


class ViewerVolumeMarksProgressiveDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop()

    def open_page(self, progressive=True, marks=True):
        page = self.browser.new_page(viewport={'width': 1000, 'height': 900});errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route("https://marks-progressive.test/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.goto("https://marks-progressive.test/")
        page.add_script_tag(path=str(MODEL))
        if progressive:
            page.add_script_tag(path=str(PROGRESSIVE))
        if marks:
            page.add_script_tag(path=str(MARKS))
        page.add_script_tag(path=str(ORIENTATION))
        page.evaluate("()=>{window.mounted=mountOrientation();tick(250);tick(500)}")
        if marks:
            expect(page.locator('#kin-mpr-marks')).to_be_visible()
        return page, errors

    def arm(self, page, label='Progressive slab point'):
        panel = page.locator('#kin-mpr-marks')
        panel.get_by_label('MPR annotation label', exact=True).fill(label)
        panel.get_by_role('button', name='Pick Point', exact=True).click()
        expect(page.locator(STATUS)).to_contain_text('점을 클릭하세요')

    def expect_point(self, page, label='Progressive slab point'):
        expect(page.locator(STATUS)).to_contain_text('수동 표식을 추가했습니다')
        state = page.evaluate("marksState()")
        expected = page.evaluate("xy=>views.get('axial').canvasToWorld(xy)", list(POINT))
        self.assertEqual([(label, expected)], [(m['label'], m['point']) for m in state['marks']])
        self.assertEqual((1, 3), (state['rows'], state['labels']))
        self.assertEqual([BASE] * 3, state['distances']);self.assertEqual([], state['refining']);self.assertFalse(state['busy'])
        self.assertEqual([], page.evaluate("sampleWrites"), "the pick press itself must start no coarse preview")

    def test_armed_pick_on_a_progressive_slab_adds_the_exact_point_without_a_preview(self):
        page, errors = self.open_page()
        try:
            self.arm(page)
            page.mouse.click(*POINT)
            self.expect_point(page)
            self.assertTrue(page.evaluate("kinMprMarks.dirty()"))
            self.assertEqual([], errors)
        finally:
            page.close()

    def test_unarmed_press_still_previews_then_refines_to_the_original_distance(self):
        page, errors = self.open_page()
        try:
            page.mouse.move(*POINT);page.mouse.down()
            state = page.evaluate("marksState()")
            self.assertEqual([BASE * 3] * 3, state['distances']);self.assertEqual(['Preview · refining'] * 3, state['refining']);self.assertTrue(state['busy'])
            page.evaluate("tick(250)")
            expect(page.get_by_role('button', name='Pick Point', exact=True)).to_be_disabled()
            page.mouse.up()
            page.wait_for_function("()=>!kinMprRenderingState.busy()")
            state = page.evaluate("marksState()")
            self.assertEqual([BASE] * 3, state['distances']);self.assertEqual([], state['refining'])
            self.assertEqual(([], 0), (state['marks'], state['rows']))
            page.evaluate("tick(250)")
            expect(page.get_by_role('button', name='Pick Point', exact=True)).to_be_enabled()
            self.assertEqual([], errors)
        finally:
            page.close()

    def test_a_preview_already_on_screen_refuses_the_pick_until_the_final_render(self):
        page, errors = self.open_page()
        try:
            self.arm(page)
            page.mouse.move(*POINT);page.mouse.wheel(0, 40)
            page.wait_for_function("()=>kinMprRenderingState.busy()")
            self.assertEqual(['Preview · refining'] * 3, page.evaluate("marksState().refining"))
            page.mouse.click(*POINT)
            expect(page.locator(STATUS)).to_contain_text('작업 상태를 확인하세요')
            state = page.evaluate("marksState()")
            self.assertEqual((0, 0), (state['rows'], state['labels']), "no point is taken from a preview")
            self.assertTrue(state['dirty'], "the pick stays armed for the final render")
            # That press released the preview; the next press on the final render is the pick.
            page.wait_for_function("()=>!kinMprRenderingState.busy()")
            self.assertEqual([BASE] * 3, page.evaluate("marksState().distances"))
            page.evaluate("()=>{sampleWrites.length=0;releaseSettle()}")
            page.mouse.click(*POINT)
            self.expect_point(page)
            self.assertEqual([], errors)
        finally:
            page.close()

    def test_unresolved_refinement_refuses_the_pick_and_recovery_accepts_it(self):
        page, errors = self.open_page()
        try:
            self.arm(page)
            page.evaluate("()=>{window.failRefine=true}")
            page.mouse.move(*POINT);page.mouse.wheel(0, 40)
            page.wait_for_function("()=>kinMprRenderingState.busy()")
            page.evaluate("releaseSettle()")
            state = page.evaluate("marksState()")
            self.assertEqual(['Refinement failed'] * 3, state['refining']);self.assertEqual([BASE * 2] * 3, state['distances']);self.assertTrue(state['busy'])
            self.assertTrue(any('복구하지 못했습니다' in text for text in page.evaluate("notices")))
            page.mouse.click(*POINT)
            expect(page.locator(STATUS)).to_contain_text('작업 상태를 확인하세요')
            self.assertEqual((0, 0), tuple(page.evaluate("[marksState().rows,marksState().labels]")), "no point while the screen is not final")
            page.evaluate("()=>{window.failRefine=false;tick(250)}")
            page.wait_for_function("()=>!kinMprRenderingState.busy()")
            state = page.evaluate("marksState()")
            self.assertEqual([BASE] * 3, state['distances']);self.assertEqual([], state['refining'])
            page.evaluate("()=>{sampleWrites.length=0}")
            page.mouse.click(*POINT)
            self.expect_point(page)
            self.assertEqual([], errors)
        finally:
            page.close()

    def test_missing_or_retired_tool_leaves_the_other_unchanged(self):
        with self.subTest('progressive refinement missing'):
            page, errors = self.open_page(progressive=False)
            try:
                self.assertIsNone(page.evaluate("window.kinMprRenderingState??null"))
                self.arm(page);page.mouse.click(*POINT)
                self.expect_point(page)
                self.assertEqual([], errors)
            finally:
                page.close()
        with self.subTest('annotation panel missing'):
            page, errors = self.open_page(marks=False)
            try:
                page.mouse.move(*POINT);page.mouse.down()
                self.assertEqual([BASE * 3] * 3, page.evaluate("marksState().distances"))
                page.mouse.up();page.wait_for_function("()=>!kinMprRenderingState.busy()")
                self.assertEqual([BASE] * 3, page.evaluate("marksState().distances"))
                self.assertEqual([], errors)
            finally:
                page.close()
        with self.subTest('annotation owner retired while armed'):
            page, errors = self.open_page()
            try:
                self.arm(page)
                page.evaluate("()=>{currentOwner[1]='another-reader';tick(250)}")
                expect(page.locator('#kin-mpr-marks')).to_be_hidden()
                page.mouse.move(*POINT);page.mouse.down()
                self.assertEqual([BASE * 3] * 3, page.evaluate("marksState().distances"), "a retired pick no longer owns presses")
                page.mouse.up();page.wait_for_function("()=>!kinMprRenderingState.busy()")
                self.assertEqual(0, page.locator('.kin-mpr-marks-overlay [data-mark-id]').count())
                self.assertEqual([], errors)
            finally:
                page.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
