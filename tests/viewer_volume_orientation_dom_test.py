# coding: utf-8
"""TEST-VOLUME-ORIENTATION-BASIC-DOM: Basic Orthogonal versus Reset Planes on the real panel and model."""
from pathlib import Path
import os
import unittest

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
# Mutation runs substitute a changed copy; the default is always the product file.
PANEL = Path(os.environ.get("KIN_ORIENTATION_PANEL_SOURCE", ROOT / "worklist-v0" / "hpacs-lite" / "viewer-volume-orientation.js"))
MODEL = Path(os.environ.get("KIN_ORIENTATION_MODEL_SOURCE", ROOT / "worklist-v0" / "hpacs-lite" / "volume-orientation.js"))
BASIC = "Basic Orthogonal"

HARNESS = r"""
<div id="host"></div><div id="sources"></div>
<script>
// The native patient-axis table shape; only an orthonormal set is required here.
const TABLE={axial:{viewPlaneNormal:[0,0,-1],viewUp:[0,-1,0]},sagittal:{viewPlaneNormal:[1,0,0],viewUp:[0,0,1]},coronal:{viewPlaneNormal:[0,1,0],viewUp:[0,0,1]}};
const NAMES=['axial','sagittal','coronal'];
const source={kind:'volume',viewportId:'mpr-axial',uid:'study-1',series:'series-1',sourceSignature:'source-1',selectionEpoch:1,study:{id:'SYNTHETIC-PID'}};
const cells=NAMES.map((name,i)=>({viewportId:'mpr-'+name,x:i,y:0,isReady:true,displaySetInstanceUIDs:['ds'],viewportOptions:{orientation:name}}));
const grid={viewports:new Map(cells.map(c=>[c.viewportId,c])),activeViewportId:'mpr-axial'};
const enabled=new Map(),views=new Map(),writes=[];let centers=0,failNext=null,workspaceBusy=false;
function makeCanvas(){const canvas=document.createElement('canvas');canvas.width=200;canvas.height=160;Object.defineProperty(canvas,'clientWidth',{get:()=>200});Object.defineProperty(canvas,'clientHeight',{get:()=>160});return canvas;}
function makeView(name,camera){
  const element=document.createElement('div');document.querySelector('#sources').append(element);
  const canvas=makeCanvas();element.append(canvas);const state=structuredClone(camera);
  const view={id:'mpr-'+name,type:'orthographic',element,renderingEngineId:'engine',options:{orientation:name},volumeId:'volume-1',
    getActors:()=>[{actor:{}}],getCanvas:()=>canvas,getVolumeId(){return this.volumeId},getCamera:()=>structuredClone(state),render(){},
    setCamera(next){if(next.position){writes.push(this.id);if(failNext===this.id){failNext=null;throw Error('INJECTED CAMERA FAILURE');}}for(const [key,value] of Object.entries(next))if(value!==undefined)state[key]=structuredClone(value);}};
  views.set(view.id,view);enabled.set(element,{viewport:view});return view;
}
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
window.start=()=>NAMES.map((name,i)=>{const {viewPlaneNormal:n,viewUp:u}=TABLE[name],r=cross(u,n),pan=[[3,-2],[-5,1],[4,6]][i],focal=[10,20,30].map((x,k)=>x+r[k]*pan[0]+u[k]*pan[1]);return {focalPoint:focal,position:focal.map((x,k)=>x+n[k]*(100+i)),viewUp:u.slice(),viewPlaneNormal:n.slice(),parallelScale:40+i,flipHorizontal:false,flipVertical:false};});
window.turned=turns=>turns.reduce((c,[axis,degrees])=>KinVolumeOrientation.rotate(c,axis,degrees),start());
window.cameras=()=>[...views.values()].map(v=>v.getCamera());
window.largest=(a,b)=>Math.max(...a.flatMap((c,i)=>['focalPoint','position','viewUp','viewPlaneNormal'].flatMap(k=>c[k].map((n,j)=>Math.abs(n-b[i][k][j]))).concat(Math.abs(c.parallelScale-b[i].parallelScale))));
window.nativeError=()=>Math.max(...[...views.values()].flatMap(v=>{const c=v.getCamera(),t=TABLE[v.id.slice(4)];return [...c.viewPlaneNormal.map((n,i)=>Math.abs(n-t.viewPlaneNormal[i])),...c.viewUp.map((n,i)=>Math.abs(n-t.viewUp[i]))];}));
window.basicButton=()=>[...document.querySelectorAll('#kin-volume-orientation button')].find(b=>b.textContent==='Basic Orthogonal');
const volume={volumeId:'volume-1',loadStatus:{loaded:true},framesLoaded:2,imageIds:['frame-0','frame-1'],dimensions:[2,2,2],spacing:[1,1,1],direction:[1,0,0,0,1,0,0,0,1],imageData:{indexToWorld:([i,j,k])=>[i,j,k]}};
window.cornerstone={cache:{getVolume:id=>id==='volume-1'?volume:null},getEnabledElement:element=>enabled.get(element),CONSTANTS:{MPR_CAMERA_VALUES:TABLE},
  metaData:{get:(_,id)=>({SOPClassUID:'1.2.840.10008.5.1.4.1.1.2',Modality:'CT',SamplesPerPixel:1,PhotometricInterpretation:'MONOCHROME2',Rows:2,Columns:2,PixelSpacing:[1,1],ImagePositionPatient:[0,0,id==='frame-0'?0:1],ImageOrientationPatient:[1,0,0,0,1,0]})}};
const crosshairs={computeToolCenter(){centers++;}},toolGroup={getToolOptions:()=>({mode:'Active'}),getToolInstance:name=>name==='Crosshairs'?crosshairs:null};
window.cornerstoneTools={ToolGroupManager:{getToolGroupForViewport:()=>toolGroup}};
const services={viewportGridService:{getState:()=>grid,setViewportIsReady(){}},cornerstoneViewportService:{getCornerstoneViewport:id=>views.get(id)},displaySetService:{getDisplaySetByUID:()=>({StudyInstanceUID:'study-1',SeriesInstanceUID:'series-1',Modality:'CT'})}};
window.kinViewerJobWorkspaceState=()=>({busy:workspaceBusy});
const intervals=new Map();window.setInterval=(fn,ms)=>{const list=intervals.get(ms)||[];list.push(fn);intervals.set(ms,list);return {ms,fn}};window.clearInterval=()=>{};window.tick=ms=>(intervals.get(ms)||[]).forEach(fn=>fn());
window.mount=value=>{NAMES.forEach((name,i)=>makeView(name,value[i]));return window.kinCreateVolumeOrientation({services,selected:()=>source,live:()=>true,allowed:()=>true,owner:()=>['hospital','reader'],host:document.querySelector('#host')});};
</script>
"""

# A restored oblique Job opens as this screen, so it is also the Reset Planes baseline.
OBLIQUE = "turned([[[1,0,0],25],[[0,1,0],-35]])"


class ViewerVolumeOrientationDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop()

    def mounted(self, cameras=OBLIQUE, before=""):
        page = self.browser.new_page()
        page.route("https://orientation.test/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.goto("https://orientation.test/")
        page.add_script_tag(path=str(MODEL));page.add_script_tag(path=str(PANEL))
        if before:page.evaluate("code=>eval(code)", before)
        page.evaluate(f"window.panel=mount({cameras})")
        expect(page.get_by_role('button', name=BASIC, exact=True)).to_be_enabled()
        return page

    def apply(self, page, name):
        page.get_by_role('button', name=name, exact=True).click()
        page.wait_for_function("()=>!document.querySelector('#kin-volume-orientation [role=status]').textContent.includes('적용 중')")
        return page.locator('#kin-volume-orientation [role="status"]').text_content()

    def test_basic_uses_native_axes_while_reset_returns_to_the_opened_oblique_screen(self):
        page = self.mounted()
        try:
            opened = page.evaluate("cameras()");pivot = page.evaluate("KinVolumeOrientation.intersection(cameras())")
            self.assertGreater(page.evaluate("nativeError()"), .1, "the opened screen is oblique")
            self.assertIn('기본 Axial·Sagittal·Coronal 방향으로 맞췄습니다', self.apply(page, BASIC))
            self.assertLess(page.evaluate("nativeError()"), 1e-12)
            # Rotation keeps plane coordinates, so Basic lands exactly on the unrotated opened screen.
            self.assertLess(page.evaluate("largest(cameras(),start())"), 1e-9)
            self.assertLess(page.evaluate("p=>Math.max(...KinVolumeOrientation.intersection(cameras()).map((n,i)=>Math.abs(n-p[i])))", pivot), 1e-9)
            self.assertEqual(1, page.evaluate("centers"));basic = page.evaluate("cameras()")
            self.assertIn('시작 MPR 화면', self.apply(page, 'Reset Planes'))
            self.assertLess(page.evaluate("b=>largest(cameras(),b)", opened), 1e-12, "Reset Planes keeps the opened oblique baseline")
            self.assertEqual(1, page.evaluate("centers"))
            self.assertIn('기본 Axial', self.apply(page, BASIC))
            self.assertLess(page.evaluate("b=>largest(cameras(),b)", basic), 1e-9)
            page.get_by_label('MPR Rotation Axis', exact=True).select_option('2');page.get_by_label('MPR Rotation Degrees', exact=True).fill('40')
            self.assertIn('40도 회전했습니다', self.apply(page, 'Rotate Three Planes'))
            self.assertIn('기본 Axial', self.apply(page, BASIC))
            self.assertLess(page.evaluate("b=>largest(cameras(),b)", basic), 1e-9)
            self.assertEqual(3, page.evaluate("centers"))
        finally:
            page.close()

    def test_identity_follows_stored_plane_names_not_grid_order_or_nearest_axis(self):
        for name, before, cameras in [
            ('reordered grid, tied axes and half turn', "cells.forEach((c,i)=>c.x=[2,0,1][i])", "turned([[[0,0,1],45],[[1,0,0],180]])"),
            ('native viewport option without a grid option', "for(const c of cells)delete c.viewportOptions", "turned([[[0,1,0],-170],[[0,0,1],120]])"),
        ]:
            with self.subTest(name=name):
                page = self.mounted(cameras, before)
                try:
                    self.assertIn('기본 Axial', self.apply(page, BASIC))
                    self.assertLess(page.evaluate("nativeError()"), 1e-12)
                    self.assertLess(page.evaluate("largest(cameras(),start())"), 1e-9)
                finally:
                    page.close()

    def test_refusals_write_no_camera(self):
        for name, mutation, message in [
            ('native table missing', "delete cornerstone.CONSTANTS.MPR_CAMERA_VALUES", '기본 평면 방향 정보'),
            ('native table invalid', "cornerstone.CONSTANTS.MPR_CAMERA_VALUES={...TABLE,coronal:TABLE.axial}", '기본 평면 방향 정보'),
            ('no stored identity', "for(const c of cells)delete c.viewportOptions;for(const v of views.values())delete v.options.orientation", '기본 방향'),
            ('duplicate identity', "cells[2].viewportOptions.orientation='axial'", '기본 방향'),
            ('unknown identity', "cells[0].viewportOptions.orientation='oblique'", '기본 방향'),
            ('flipped plane', "views.get('mpr-sagittal').setCamera({flipHorizontal:true})", '뒤집기를 해제한 뒤'),
        ]:
            with self.subTest(name=name):
                page = self.mounted()
                try:
                    page.evaluate("code=>eval(code)", mutation);page.evaluate("writes.length=0");before = page.evaluate("cameras()")
                    self.assertIn(message, self.apply(page, BASIC))
                    self.assertEqual(before, page.evaluate("cameras()"));self.assertEqual([], page.evaluate("writes"));self.assertEqual(0, page.evaluate("centers"))
                finally:
                    page.close()

    def test_failed_application_rolls_back_and_recenters_crosshair(self):
        page = self.mounted()
        try:
            before = page.evaluate("cameras()");page.evaluate("failNext='mpr-sagittal'")
            self.assertIn('INJECTED CAMERA FAILURE', self.apply(page, BASIC))
            self.assertLess(page.evaluate("b=>largest(cameras(),b)", before), 1e-12)
            self.assertEqual(1, page.evaluate("centers"), "the crosshair center is derived again from the restored planes")
            self.assertIn('기본 Axial', self.apply(page, BASIC));self.assertLess(page.evaluate("nativeError()"), 1e-12)
        finally:
            page.close()

    def test_busy_readiness_double_click_and_newer_selection(self):
        page = self.mounted()
        try:
            button = page.get_by_role('button', name=BASIC, exact=True);before = page.evaluate("cameras()")
            page.evaluate("workspaceBusy=true;tick(500)");expect(button).to_be_disabled()
            page.evaluate("writes.length=0;basicButton().onclick()")
            page.wait_for_function("()=>document.querySelector('#kin-volume-orientation [role=status]').textContent.includes('선택한 MPR 평면이 바뀌었습니다')")
            self.assertEqual(before, page.evaluate("cameras()"));self.assertEqual([], page.evaluate("writes"))
            page.evaluate("workspaceBusy=false;tick(500)");expect(button).to_be_enabled()
            page.evaluate("for(const c of cells)c.isReady=false;tick(500)");expect(button).to_be_disabled()
            page.evaluate("for(const c of cells)c.isReady=true;tick(500)");expect(button).to_be_enabled()
            page.evaluate("writes.length=0;basicButton().onclick();basicButton().onclick()")
            page.wait_for_function("()=>document.querySelector('#kin-volume-orientation [role=status]').textContent.includes('기본 Axial')")
            self.assertEqual(3, page.evaluate("writes.length"), "a second click while applying is ignored");self.assertEqual(1, page.evaluate("centers"))
            self.assertLess(page.evaluate("nativeError()"), 1e-12)
        finally:
            page.close()
        page = self.mounted()
        try:
            page.evaluate("writes.length=0;basicButton().onclick();requestAnimationFrame(()=>source.selectionEpoch++)")
            page.wait_for_function("()=>document.querySelector('#kin-volume-orientation [role=status]').textContent.includes('화면이 변경되어')")
            # The newer selection owns the screen now; the aborted application must not write over it.
            self.assertEqual(3, page.evaluate("writes.length"));self.assertEqual(1, page.evaluate("centers"))
        finally:
            page.close()


if __name__ == '__main__':
    unittest.main()
