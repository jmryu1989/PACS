# coding: utf-8
"""Deterministic browser regression for VR source binding during layout transients."""
from pathlib import Path
import os
import unittest

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
ORIENTATION = Path(os.environ.get("KIN_VR_ORIENTATION_SOURCE", ROOT / "worklist-v0" / "hpacs-lite" / "viewer-volume-orientation.js"))
RENDERING = Path(os.environ.get("KIN_VR_RENDERING_SOURCE", ROOT / "worklist-v0" / "hpacs-lite" / "viewer-volume-rendering.js"))
MODEL = ROOT / "worklist-v0" / "hpacs-lite" / "volume-rendering.js"

HARNESS = r"""
<div id="host"></div><div id="sources"></div>
<script>
const source={kind:'volume',viewportId:'axial',uid:'study-1',series:'series-1',sourceSignature:'source-1',selectionEpoch:1,study:{id:'SYNTHETIC-PID'}};
let currentOwner=['hospital','reader'];const notices=[],repairs=[];
const cells=[
  {viewportId:'axial',x:0,y:0,isReady:true,displaySetInstanceUIDs:['ds']},
  {viewportId:'coronal',x:1,y:0,isReady:true,displaySetInstanceUIDs:['ds']},
  {viewportId:'sagittal',x:2,y:0,isReady:true,displaySetInstanceUIDs:['ds']}
];
const grid={viewports:new Map(cells.map(c=>[c.viewportId,c])),activeViewportId:'axial'};
const camera=()=>({position:[0,-10,0],focalPoint:[0,0,0],viewUp:[0,0,1],viewPlaneNormal:[0,-1,0],parallelScale:10,flipHorizontal:false,flipVertical:false});
const sourceMapper={name:'source'},enabled=new Map(),views=new Map();
function makeCanvas(){const canvas=document.createElement('canvas');canvas.width=200;canvas.height=160;Object.defineProperty(canvas,'clientWidth',{get:()=>200});Object.defineProperty(canvas,'clientHeight',{get:()=>160});return canvas;}
function makeView(id,element){
  const canvas=makeCanvas();element.append(canvas);
  const view={id,type:'orthographic',element,volumeId:'volume-1',getActors:()=>[{actor:{getMapper:()=>sourceMapper}}],getCanvas:()=>canvas,getVolumeId(){return this.volumeId},getCamera:camera,getRenderingEngine:()=>engine};
  return view;
}
for(const cell of cells){const element=document.createElement('div');element.id=cell.viewportId;document.querySelector('#sources').append(element);const view=makeView(cell.viewportId,element);views.set(cell.viewportId,view);enabled.set(element,{viewport:view});}
const curve={getSize:()=>0,getNodeValue(){},setNodeValue(){},removeAllPoints(){},addPoint(){}},colors={removeAllPoints(){},addRGBPoint(){}};
const property={getRGBTransferFunction:()=>colors,getScalarOpacity:()=>curve,setShade(){}};
const mapper={getClippingPlanes:()=>[],removeAllClippingPlanes(){},addClippingPlane(){return true}};
const vrActor={getMapper:()=>mapper,getProperty:()=>property};
const vrView={id:null,suppressEvents:false,async setVolumes(){},getActors:()=>[{actor:vrActor}],resetCamera(){},getCamera:camera,setCamera(){},setProperties(){},render(){}};
const engine={privateViews:new Map(),enableElement(config){vrView.id=config.viewportId;this.privateViews.set(config.viewportId,vrView)},getViewport(id){return this.privateViews.get(id)||views.get(id)},disableElement(id){this.privateViews.delete(id)},resize(){},offscreenMultiRenderWindow:{getOpenGLRenderWindow:()=>({getViewNodeFor:()=>null})}};
const volume={volumeId:'volume-1',loadStatus:{loaded:true},framesLoaded:2,imageIds:['frame-0','frame-1'],dimensions:[2,2,2],spacing:[1,1,1],direction:[1,0,0,0,1,0,0,0,1],imageData:{getDimensions:()=>[2,2,2],indexToWorld:([i,j,k])=>[i,j,k]}};
const alternate={...volume,volumeId:'volume-2'};
window.cornerstone={cache:{getVolume:id=>id==='volume-1'?volume:id==='volume-2'?alternate:null},getEnabledElement:element=>enabled.get(element),metaData:{get:(_,id)=>({SOPClassUID:'1.2.840.10008.5.1.4.1.1.2',Modality:'CT',SamplesPerPixel:1,PhotometricInterpretation:'MONOCHROME2',Rows:2,Columns:2,PixelSpacing:[1,1],ImagePositionPatient:[0,0,id==='frame-0'?0:1],ImageOrientationPatient:[1,0,0,0,1,0]})},Enums:{ViewportType:{VOLUME_3D:'3d'}}};
const services={viewportGridService:{getState:()=>grid,setViewportIsReady:(id,value)=>repairs.push([id,value])},cornerstoneViewportService:{getCornerstoneViewport:id=>views.get(id)},displaySetService:{getDisplaySetByUID:()=>({StudyInstanceUID:'study-1',SeriesInstanceUID:'series-1',Modality:'CT'})}};
window.KinVolumeOrientation={intersection:()=>[0,0,0],rotate:c=>c};
window.KinVolumeSculpt={};window.KinVolumeMaskRenderer={preflight(){} };let sculptCancels=0;
window.kinCreateVolumeSculpt=({controlsPane})=>{const fieldset=document.createElement('fieldset');controlsPane.append(fieldset);return {fieldset,cancel(){sculptCancels++},reset(){},dispose(){}}};
window.kinViewerJobWorkspaceState=()=>({busy:false});window.kinVolumeBatchState={busy:()=>false};window.kinMprRenderingState={busy:()=>false};
window.fetch=async url=>({ok:true,json:async()=>url.endsWith('/api/me')?{kind:'member',institution:'hospital',sub:'reader'}:[]});
const intervalCallbacks=new Map(),nativeSetInterval=window.setInterval;window.setInterval=(fn,ms)=>{const list=intervalCallbacks.get(ms)||[];list.push(fn);intervalCallbacks.set(ms,list);return {ms,fn}};window.clearInterval=()=>{};window.tick=ms=>(intervalCallbacks.get(ms)||[]).forEach(fn=>fn());
window.mountOrientation=()=>window.kinCreateVolumeOrientation({services,selected:()=>source,live:()=>true,allowed:()=>true,owner:()=>currentOwner,host:document.querySelector('#host')});
window.openVr=async()=>document.querySelector('#kin-volume-orientation button:last-of-type').onclick();
window.closeVr=()=>document.querySelector('#kin-volume-rendering .kin-vr-close').click();
window.sourceState=()=>JSON.stringify({source,cameras:[...views.values()].map(v=>v.getCamera()),viewRefs:[...views.values()].map(v=>v.id)});
</script>
"""


class ViewerVrBindingDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop()

    def page_with_vr(self):
        page = self.browser.new_page()
        page.route("https://vr-binding.test/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.goto("https://vr-binding.test/")
        page.add_script_tag(path=str(MODEL));page.add_script_tag(path=str(ORIENTATION));page.add_script_tag(path=str(RENDERING))
        page.evaluate("window.orientation=mountOrientation()")
        return page

    def open_ready(self, page):
        page.evaluate("openVr()")
        expect(page.locator('#kin-volume-rendering')).to_have_attribute('open', '')

    def test_render_readiness_transient_keeps_binding_without_repair_and_strict_open_refuses(self):
        for name, setup in [
            ('canvas-only', "for(const v of views.values())v.getCanvas().width=17"),
            ('ready-only', "for(const c of cells)c.isReady=false"),
            ('canvas-and-ready', "for(const c of cells)c.isReady=false;for(const v of views.values())v.getCanvas().width=17"),
        ]:
            with self.subTest(name=name):
                page = self.page_with_vr()
                try:
                    self.open_ready(page);before=page.evaluate("sourceState()")
                    page.evaluate("code=>{eval(code);tick(250)}", setup)
                    expect(page.locator('#kin-volume-rendering')).to_have_attribute('open', '')
                    self.assertEqual([], page.evaluate("repairs"), "binding-only lifecycle reads must not repair the native grid")
                    self.assertEqual(before, page.evaluate("sourceState()"), "VR lifecycle reads preserve source selection, view references, and source cameras")
                    before_cancel=page.evaluate('sculptCancels');page.evaluate("dispatchEvent(new Event('resize'))")
                    self.assertGreater(page.evaluate('sculptCancels'), before_cancel)
                    expect(page.locator('#kin-volume-rendering')).to_have_attribute('open', '')
                    page.evaluate("closeVr()")
                    page.evaluate("openVr()")
                    expect(page.locator('#kin-volume-rendering')).not_to_have_attribute('open', '')
                finally:
                    page.close()

    def test_three_planes_beside_an_empty_cell_keep_the_mpr_tools_and_vr_bound(self):
        """A Hanging Protocol opens the three planes in a 2x2 grid, so one cell stays empty."""
        page = self.page_with_vr()
        try:
            page.evaluate("tick(500)")
            self.assertFalse(page.evaluate("document.querySelector('#kin-volume-orientation').hidden"))
            before = page.evaluate("document.querySelector('#kin-volume-orientation .target').textContent")
            self.assertIn('Center', before)
            page.evaluate("""()=>{const vacancy={viewportId:'vacancy',x:1,y:1,isReady:true,displaySetInstanceUIDs:[]};
              cells.push(vacancy);grid.viewports.set('vacancy',vacancy);tick(500);}""")
            self.assertFalse(page.evaluate("document.querySelector('#kin-volume-orientation').hidden"),
                             "an empty fourth cell does not hide the three-plane tools")
            self.assertEqual(before, page.evaluate("document.querySelector('#kin-volume-orientation .target').textContent"))
            self.assertFalse(page.evaluate("document.querySelector('#kin-volume-orientation button').disabled"),
                             "Rotate Three Planes stays usable beside an empty cell")
            self.open_ready(page)
            self.assertEqual([], page.evaluate("repairs"), "the empty cell is not a native readiness repair target")
            # A fourth cell that actually shows something is not a three-plane screen.
            page.evaluate("""()=>{const extra={viewportId:'extra',x:0,y:1,isReady:true,displaySetInstanceUIDs:['ds']};
              cells.push(extra);grid.viewports.set('extra',extra);tick(500);}""")
            self.assertTrue(page.evaluate("document.querySelector('#kin-volume-orientation').hidden"))
            self.assertTrue(page.evaluate("document.querySelector('#kin-volume-orientation button').disabled"))
        finally:
            page.close()

    def test_stale_binding_identity_and_metadata_close_even_while_render_unready(self):
        mutations = {
            'uid': "source.uid='study-2'",
            'series': "source.series='series-2'",
            'selection': "source.selectionEpoch++",
            'volume': "views.get('coronal').volumeId='volume-2'",
            'viewport-ref': "(()=>{const old=views.get('axial'),next=makeView('axial',old.element);views.set('axial',next);enabled.set(next.element,{viewport:next})})()",
            'vr-registry': "engine.privateViews.set([...engine.privateViews.keys()].find(id=>id.startsWith('kin-vr-')),{})",
            'enabled-binding': "enabled.set(views.get('axial').element,{viewport:{}})",
            'disconnected': "views.get('axial').element.remove()",
            'owner': "currentOwner=['hospital','other-reader']",
            'metadata': "cornerstone.metaData.get=(_,id)=>({...({SOPClassUID:'1.2.840.10008.5.1.4.1.1.2',Modality:'CT',SamplesPerPixel:1,PhotometricInterpretation:'MONOCHROME2',Rows:2,Columns:2,PixelSpacing:[1,1],ImagePositionPatient:[0,0,id==='frame-0'?0:1],ImageOrientationPatient:[1,0,0,0,1,0]}),Rows:3})",
        }
        for name, mutation in mutations.items():
            with self.subTest(name=name):
                page = self.page_with_vr()
                try:
                    self.open_ready(page)
                    page.evaluate("mutation=>{for(const c of cells)c.isReady=false;for(const v of views.values())v.getCanvas().width=17;eval(mutation);tick(250)}", mutation)
                    expect(page.locator('#kin-volume-rendering')).not_to_have_attribute('open', '')
                    expect(page.locator('#kin-volume-orientation [role="status"]')).to_contain_text('VR 표시를 닫았습니다')
                finally:
                    page.close()


if __name__ == '__main__':
    unittest.main()
