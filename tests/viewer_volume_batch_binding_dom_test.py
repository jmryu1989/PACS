# coding: utf-8
"""TEST-VOLUME-BATCH-BINDING: a generated MPR batch preview survives render readiness transients.

REQ-D-VOLUME-BATCH-SAVE / RISK-D-VOLUME-BATCH-LOSS. The real orientation host, batch model and
batch panel run in Chromium against a synthetic native target. Canvas size and grid readiness
flicker while native rendering resizes; that must not discard the generation-time recipe or let
Save New Job capture nothing, while a changed source, selection, viewport or session still clears
it and a new generation still requires a render-ready target. This is no GPU or pixel proof.
"""
from pathlib import Path
import os
import unittest

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
MODEL = HPACS / "volume-batch.js"
ORIENTATION = HPACS / "viewer-volume-orientation.js"
BATCH = Path(os.environ.get("KIN_BATCH_SOURCE", HPACS / "viewer-volume-batch.js"))

HARNESS = r"""
<div id="host"></div><div id="sources"></div>
<script>
const source={kind:'volume',viewportId:'axial',uid:'study-1',series:'series-1',sourceSignature:'source-1',selectionEpoch:1,study:{id:'SYNTHETIC-PID'}};
let alive=true;const currentOwner=['hospital','reader'],repairs=[],enabledIds=[],disabledIds=[],created=[],revoked=[];
const cells=[
  {viewportId:'axial',x:0,y:0,isReady:true,displaySetInstanceUIDs:['ds']},
  {viewportId:'coronal',x:1,y:0,isReady:true,displaySetInstanceUIDs:['ds']},
  {viewportId:'sagittal',x:2,y:0,isReady:true,displaySetInstanceUIDs:['ds']}
];
const grid={viewports:new Map(cells.map(c=>[c.viewportId,c])),activeViewportId:'axial'};
const cameras={
  axial:{focalPoint:[1.5,1.5,1.5],position:[1.5,1.5,11.5],viewUp:[0,-1,0],viewPlaneNormal:[0,0,1],parallelScale:4,parallelProjection:true,flipHorizontal:false,flipVertical:false},
  coronal:{focalPoint:[1.5,1.5,1.5],position:[1.5,-8.5,1.5],viewUp:[0,0,1],viewPlaneNormal:[0,-1,0],parallelScale:4,parallelProjection:true,flipHorizontal:false,flipVertical:false},
  sagittal:{focalPoint:[1.5,1.5,1.5],position:[11.5,1.5,1.5],viewUp:[0,0,1],viewPlaneNormal:[1,0,0],parallelScale:4,parallelProjection:true,flipHorizontal:false,flipVertical:false}
};
const opacity={getSize:()=>1,getClamping:()=>true,getNodeValue(i,node){node.push(0,1,.5,0)}};
const sourceActor={getMapper:()=>({getBlendMode:()=>0}),getProperty:()=>({getScalarOpacity:()=>opacity})};
const enabled=new Map(),views=new Map();
function makeCanvas(){const canvas=document.createElement('canvas');canvas.width=200;canvas.height=160;Object.defineProperty(canvas,'clientWidth',{get:()=>200});Object.defineProperty(canvas,'clientHeight',{get:()=>160});return canvas;}
function makeView(id,element){
  const canvas=makeCanvas();element.append(canvas);
  return {id,type:'orthographic',element,volumeId:'volume-1',getActors:()=>[{actor:sourceActor}],getCanvas:()=>canvas,getVolumeId(){return this.volumeId},getCamera:()=>structuredClone(cameras[id]),
    getProperties:()=>({voiRange:{lower:0,upper:1000},VOILUTFunction:'LINEAR',invert:false,interpolationType:1}),getSlabThickness:()=>.05,getRenderingEngine:()=>engine};
}
for(const cell of cells){const element=document.createElement('div');document.querySelector('#sources').append(element);const view=makeView(cell.viewportId,element);views.set(cell.viewportId,view);enabled.set(element,{viewport:view});}
// The disposable batch viewport sizes its raster from the element the panel requested and
// announces IMAGE_RENDERED asynchronously, as the native renderer does.
function makeBatchView({viewportId,element}){
  const canvas=document.createElement('canvas'),mapper={setViewSpecificProperties(){},getBlendMode:()=>0};element.append(canvas);let camera=null,half=.05;
  return {id:viewportId,element,suppressEvents:true,
    setVolumes:()=>window.holdVolumes?new Promise(resolve=>{window.releaseVolumes=resolve}):Promise.resolve(),
    getActors:()=>[{actor:{getMapper:()=>mapper}}],setProperties(){},setBlendMode(){},resetSlabThickness(){half=.05},setSlabThickness(value){half=value},getSlabThickness:()=>half,
    setCamera(value){camera=structuredClone(value)},getCamera:()=>structuredClone(camera),getCanvas:()=>canvas,
    render(){canvas.width=Math.round(parseFloat(element.style.width)*devicePixelRatio);canvas.height=Math.round(parseFloat(element.style.height)*devicePixelRatio);
      const context=canvas.getContext('2d');context.fillStyle='rgb('+Math.round(camera.focalPoint[2]*60)+',40,80)';context.fillRect(0,0,canvas.width,canvas.height);
      setTimeout(()=>element.dispatchEvent(new Event('IMAGE_RENDERED')),0);}};
}
const engine={privateViews:new Map(),enableElement(config){enabledIds.push(config.viewportId);this.privateViews.set(config.viewportId,makeBatchView(config))},getViewport(id){return this.privateViews.get(id)||views.get(id)},disableElement(id){disabledIds.push(id);this.privateViews.delete(id)}};
const imageIds=['frame-0','frame-1','frame-2','frame-3'];
const volume={volumeId:'volume-1',loadStatus:{loaded:true},framesLoaded:4,imageIds,dimensions:[4,4,4],spacing:[1,1,1],direction:[1,0,0,0,1,0,0,0,1],imageData:{indexToWorld:([i,j,k])=>[i,j,k]}};
const alternate={...volume,volumeId:'volume-2'};
window.cornerstone={cache:{getVolume:id=>id==='volume-1'?volume:id==='volume-2'?alternate:null},getEnabledElement:element=>enabled.get(element),
  metaData:{get:(_,id)=>{const k=imageIds.indexOf(id);return {SOPClassUID:'1.2.840.10008.5.1.4.1.1.2',Modality:'CT',SamplesPerPixel:1,PhotometricInterpretation:'MONOCHROME2',Rows:4,Columns:4,PixelSpacing:[1,1],ImagePositionPatient:[0,0,k],ImageOrientationPatient:[1,0,0,0,1,0],StudyInstanceUID:'study-1',SeriesInstanceUID:'series-1',SOPInstanceUID:'sop-'+k};}},
  Enums:{ViewportType:{ORTHOGRAPHIC:'orthographic'},Events:{IMAGE_RENDERED:'IMAGE_RENDERED'}}};
const services={viewportGridService:{getState:()=>grid,setViewportIsReady:(id,value)=>repairs.push([id,value])},cornerstoneViewportService:{getCornerstoneViewport:id=>views.get(id)},
  displaySetService:{getDisplaySetByUID:()=>({StudyInstanceUID:'study-1',SeriesInstanceUID:'series-1',Modality:'CT'})}};
window.KinVolumeOrientation={intersection:()=>[1.5,1.5,1.5],rotate:c=>c};
window.kinViewerJobWorkspaceState=()=>({busy:false});
window.fetch=async url=>({ok:true,json:async()=>url==='/api/me'?{kind:'member',institution:'hospital',sub:'reader'}:null});
const createURL=URL.createObjectURL.bind(URL),revokeURL=URL.revokeObjectURL.bind(URL);
URL.createObjectURL=blob=>{const url=createURL(blob);created.push(url);return url};URL.revokeObjectURL=url=>{revoked.push(url);return revokeURL(url)};
const intervalCallbacks=new Map();window.setInterval=(fn,ms)=>{const list=intervalCallbacks.get(ms)||[];list.push(fn);intervalCallbacks.set(ms,list);return {ms,fn}};window.clearInterval=()=>{};
window.tick=ms=>(intervalCallbacks.get(ms)||[]).forEach(fn=>fn());
window.reference={study:'study-1',series:'series-1',sops:imageIds.map((_,k)=>'sop-'+k)};
window.mountOrientation=()=>window.kinCreateVolumeOrientation({services,selected:()=>source,live:()=>alive,allowed:()=>true,owner:()=>currentOwner,host:document.querySelector('#host')});
// What the user sees and what Save New Job would capture for the batch, read together.
window.batchState=()=>{const panel=document.querySelector('#kin-volume-batch'),src=panel.querySelector('img[alt="Reconstructed MPR batch plane"]').getAttribute('src'),before=repairs.length;let recipe=null,error=null;
  try{recipe=window.kinVolumeBatchState.capture(window.reference);}catch(e){error=e.message;}
  return {resultHidden:panel.querySelector('.result').hidden,src,revoked:!!src&&revoked.includes(src),frame:panel.querySelector('.frame').textContent,recipe,error,captureRepairs:repairs.length-before};};
</script>
"""

TRANSIENTS = [
    ('canvas-only', "for(const v of views.values())v.getCanvas().width=17"),
    ('ready-only', "for(const c of cells)c.isReady=false"),
    ('canvas-and-ready', "for(const c of cells)c.isReady=false;for(const v of views.values())v.getCanvas().width=17"),
]
READY = "for(const c of cells)c.isReady=true;for(const v of views.values())v.getCanvas().width=200"


class ViewerVolumeBatchBindingDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop()

    def open_page(self):
        page = self.browser.new_page();errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route("https://batch-binding.test/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.goto("https://batch-binding.test/")
        page.add_script_tag(path=str(MODEL));page.add_script_tag(path=str(ORIENTATION));page.add_script_tag(path=str(BATCH))
        page.evaluate("window.orientation=mountOrientation()")
        return page, errors

    def make_batch(self, page):
        for label, value in [('Batch Start Offset', '0'), ('Batch Interval', '1'), ('Batch Number', '2')]:
            page.get_by_label(label, exact=True).fill(value)
        page.get_by_role('button', name='Make Batch', exact=True).click()
        expect(page.locator('#kin-volume-batch [role=status]')).to_contain_text('2개 단면 미리보기를 생성했습니다')
        state = page.evaluate("batchState()")
        self.assertFalse(state['resultHidden']);self.assertTrue(state['src']);self.assertIsNone(state['error'])
        self.assertEqual([state['recipe'][key] for key in ('offset', 'interval', 'count', 'reverse')], [0, 1, 2, False])
        self.assertEqual(state['recipe']['cell']['camera']['focalPoint'], [1.5, 1.5, 1.5])
        return state

    def test_render_readiness_transient_keeps_preview_and_captured_recipe(self):
        for name, transient in TRANSIENTS:
            with self.subTest(name=name):
                page, errors = self.open_page()
                try:
                    before = self.make_batch(page)
                    page.evaluate("code=>{eval(code);tick(250);tick(500);tick(250)}", transient)
                    self.assertEqual(before, page.evaluate("batchState()"),
                                     "a readiness transient keeps the preview, its object URL and the recipe Save New Job captures")
                    # Generation stays strict: a render-unready target cannot start another batch.
                    self.assertTrue(page.evaluate("document.querySelector('#kin-volume-batch .make').disabled"))
                    page.evaluate("code=>{eval(code);tick(250);tick(500)}", READY)
                    self.assertEqual(before, page.evaluate("batchState()"))
                    self.assertFalse(page.evaluate("document.querySelector('#kin-volume-batch .make').disabled"))
                    self.assertEqual([], errors)
                finally:
                    page.close()

    def test_stale_binding_identity_and_session_clear_preview_even_while_render_unready(self):
        mutations = {
            'study': "source.uid='study-2'",
            'series': "source.series='series-2'",
            'selection': "source.selectionEpoch++",
            'volume': "views.get('coronal').volumeId='volume-2'",
            'viewport-ref': "(()=>{const old=views.get('axial'),next=makeView('axial',old.element);views.set('axial',next);enabled.set(next.element,{viewport:next})})()",
            'enabled-binding': "enabled.set(views.get('axial').element,{viewport:{}})",
            'disconnected': "views.get('axial').element.remove()",
            'session': "alive=false",
        }
        for name, mutation in mutations.items():
            with self.subTest(name=name):
                page, errors = self.open_page()
                try:
                    self.make_batch(page)
                    page.evaluate("code=>{for(const c of cells)c.isReady=false;for(const v of views.values())v.getCanvas().width=17;eval(code);tick(250)}", mutation)
                    after = page.evaluate("batchState()")
                    self.assertTrue(after['resultHidden']);self.assertIsNone(after['src']);self.assertIsNone(after['recipe']);self.assertIsNone(after['error'])
                    self.assertTrue(page.evaluate("created.length>0&&created.every(url=>revoked.includes(url))"))
                    self.assertEqual([], errors)
                finally:
                    page.close()

    def test_readiness_transient_cancels_generation_and_keeps_previous_preview(self):
        page, errors = self.open_page()
        try:
            before = self.make_batch(page)
            page.evaluate("()=>{window.holdVolumes=true}")
            page.get_by_label('Batch Interval', exact=True).fill('0.5')
            page.get_by_role('button', name='Make Batch', exact=True).click()
            page.wait_for_function("()=>typeof window.releaseVolumes==='function'")
            self.assertEqual(1, page.locator('[data-kin-batch-render]').count())
            page.evaluate("()=>{for(const v of views.values())v.getCanvas().width=17;tick(250)}")
            page.wait_for_function("()=>document.querySelector('#kin-volume-batch [role=status]').textContent.includes('취소')")
            self.assertEqual(0, page.locator('[data-kin-batch-render]').count())
            self.assertEqual(page.evaluate("enabledIds"), page.evaluate("disabledIds"))
            # The late renderer attachment settles after cancellation and changes nothing.
            page.evaluate("code=>{releaseVolumes();window.holdVolumes=false;eval(code);tick(250);tick(500)}", READY)
            page.wait_for_timeout(50)
            self.assertEqual(before, page.evaluate("batchState()"),
                             "the previous preview and its generation recipe remain, not the unapplied 0.5 mm input")
            self.assertEqual('0.5', page.get_by_label('Batch Interval', exact=True).input_value())
            self.assertEqual([], errors)
        finally:
            page.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
