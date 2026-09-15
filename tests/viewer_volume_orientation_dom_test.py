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
CROSSHAIR_MODEL = Path(os.environ.get("KIN_CROSSHAIR_MODEL_SOURCE", ROOT / "worklist-v0" / "hpacs-lite" / "volume-crosshair.js"))
CROSSHAIR_PANEL = Path(os.environ.get("KIN_CROSSHAIR_PANEL_SOURCE", ROOT / "worklist-v0" / "hpacs-lite" / "viewer-volume-crosshair.js"))
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
const enabled=new Map(),views=new Map(),writes=[],slabWrites=[];let centers=0,nativeDrags=0,failNext=null,failSlab=null,workspaceBusy=false,roundUp=0,alive=true,clockOffset=0;
const realNow=Date.now;Date.now=()=>realNow.call(Date)+clockOffset;
function makeCanvas(){const canvas=document.createElement('canvas');canvas.width=200+roundUp;canvas.height=160;Object.defineProperty(canvas,'clientWidth',{get:()=>200});Object.defineProperty(canvas,'clientHeight',{get:()=>160});return canvas;}
function makeView(name,camera){
  const element=document.createElement('div');document.querySelector('#sources').append(element);
  const canvas=makeCanvas();element.append(canvas);const state=structuredClone(camera);
  // Slab clipping as in the pinned cornerstone source (orthancteam/orthanc:24.12.0 libOrthancOHIF.so): planes are
  // +/- normal about the focal point at the half thickness (0.05 default); setCamera re-derives them only for an
  // out-of-plane focal move or a viewUp change beyond 1e-5; setSlabThickness clamps below 0.1 and re-derives.
  const clip=()=>{const half=view.getSlabThickness(),n=state.viewPlaneNormal,f=state.focalPoint;view.planes=[{normal:n.slice(),origin:f.map((x,k)=>x-n[k]*half)},{normal:n.map(x=>-x),origin:f.map((x,k)=>x+n[k]*half)}];};
  const slab=(id,half)=>{if(failSlab===id){failSlab=null;throw Error('INJECTED SLAB FAILURE');}view.slab=half;slabWrites.push(id);clip();};
  const axes=()=>{const u=state.viewUp,r=cross(u,state.viewPlaneNormal),mm=2*state.parallelScale/160;return {u,r,mm};};
  const view={id:'mpr-'+name,type:'orthographic',element,renderingEngineId:'engine',options:{orientation:name},volumeId:'volume-1',slab:undefined,blend:0,planes:null,
    getActors:()=>[{actor:{getMapper:()=>({getBlendMode:()=>view.blend})}}],getCanvas:()=>canvas,getVolumeId(){return this.volumeId},getCamera:()=>structuredClone(state),render(){},
    setCamera(next){if(next.position){writes.push(this.id);if(failNext===this.id){failNext=null;throw Error('INJECTED CAMERA FAILURE');}}const previous=structuredClone(state);for(const [key,value] of Object.entries(next))if(value!==undefined)state[key]=structuredClone(value);
      if((next.focalPoint&&previous.focalPoint)||(next.viewUp&&previous.viewUp)){const moved=!!next.focalPoint&&Math.abs(dot(next.focalPoint.map((x,k)=>x-previous.focalPoint[k]),state.viewPlaneNormal))>0,turned=!!next.viewUp&&!state.viewUp.every((x,k)=>Math.abs(x-previous.viewUp[k])<=1e-5);if(moved||turned)clip();}},
    getSlabThickness(){return Math.max(.05,this.slab??0)},setSlabThickness(half){slab(this.id,Math.max(.1,half))},resetSlabThickness(){slab(this.id,.05)},
    worldToCanvas(p){const {u,r,mm}=axes(),d=p.map((x,k)=>x-state.focalPoint[k]);return [100+dot(d,r)/mm,80-dot(d,u)/mm];},
    canvasToWorld([x,y]){const {u,r,mm}=axes();return state.focalPoint.map((f,k)=>f+r[k]*(x-100)*mm-u[k]*(y-80)*mm);}};
  clip();views.set(view.id,view);enabled.set(element,{viewport:view});return view;
}
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
window.start=()=>NAMES.map((name,i)=>{const {viewPlaneNormal:n,viewUp:u}=TABLE[name],r=cross(u,n),pan=[[3,-2],[-5,1],[4,6]][i],focal=[10,20,30].map((x,k)=>x+r[k]*pan[0]+u[k]*pan[1]);return {focalPoint:focal,position:focal.map((x,k)=>x+n[k]*(100+i)),viewUp:u.slice(),viewPlaneNormal:n.slice(),parallelScale:40+i,flipHorizontal:false,flipVertical:false};});
// Every focal point at the pivot: an H/F turn then keeps sagittal and coronal focal point and viewUp.
window.centered=()=>start().map(c=>({...c,focalPoint:[10,20,30],position:[10,20,30].map((x,k)=>x+c.viewPlaneNormal[k]*100)}));
window.planeError=()=>Math.max(...[...views.values()].flatMap(v=>{const c=v.getCamera(),h=v.getSlabThickness(),n=c.viewPlaneNormal,f=c.focalPoint,[a,b]=v.planes;return [0,1,2].flatMap(k=>[a.normal[k]-n[k],b.normal[k]+n[k],a.origin[k]-(f[k]-h*n[k]),b.origin[k]-(f[k]+h*n[k])].map(Math.abs));}));
window.display=()=>[...views.values()].map(v=>[v.getSlabThickness(),v.blend]);
window.drag=(id,degrees)=>{const v=views.get(id),c=v.worldToCanvas(KinVolumeOrientation.intersection(cameras())),a=degrees*Math.PI/180,from=[c[0]+40,c[1]],to=[c[0]+40*Math.cos(a),c[1]+40*Math.sin(a)];crosshairs.editData={annotation:{data:{handles:{activeOperation:2}}}};crosshairs._dragCallback({detail:{element:v.element,currentPoints:{canvas:to},deltaPoints:{canvas:[to[0]-from[0],to[1]-from[1]]}}});};
window.turned=turns=>turns.reduce((c,[axis,degrees])=>KinVolumeOrientation.rotate(c,axis,degrees),start());
window.cameras=()=>[...views.values()].map(v=>v.getCamera());
window.largest=(a,b)=>Math.max(...a.flatMap((c,i)=>['focalPoint','position','viewUp','viewPlaneNormal'].flatMap(k=>c[k].map((n,j)=>Math.abs(n-b[i][k][j]))).concat(Math.abs(c.parallelScale-b[i].parallelScale))));
window.nativeError=()=>Math.max(...[...views.values()].flatMap(v=>{const c=v.getCamera(),t=TABLE[v.id.slice(4)];return [...c.viewPlaneNormal.map((n,i)=>Math.abs(n-t.viewPlaneNormal[i])),...c.viewUp.map((n,i)=>Math.abs(n-t.viewUp[i]))];}));
window.basicButton=()=>[...document.querySelectorAll('#kin-volume-orientation button')].find(b=>b.textContent==='Basic Orthogonal');
const volume={volumeId:'volume-1',loadStatus:{loaded:true},framesLoaded:2,imageIds:['frame-0','frame-1'],dimensions:[2,2,2],spacing:[1,1,1],direction:[1,0,0,0,1,0,0,0,1],imageData:{indexToWorld:([i,j,k])=>[i,j,k]}};
window.cornerstone={cache:{getVolume:id=>id==='volume-1'?volume:null},getEnabledElement:element=>enabled.get(element),CONSTANTS:{MPR_CAMERA_VALUES:TABLE},
  metaData:{get:(_,id)=>({SOPClassUID:'1.2.840.10008.5.1.4.1.1.2',Modality:'CT',SamplesPerPixel:1,PhotometricInterpretation:'MONOCHROME2',Rows:2,Columns:2,PixelSpacing:[1,1],ImagePositionPatient:[0,0,id==='frame-0'?0:1],ImageOrientationPatient:[1,0,0,0,1,0]})}};
const crosshairs={computeToolCenter(){centers++;},configuration:{},renderAnnotation(){},_pointNearTool(){return false},getHandleNearImagePoint(){},preMouseDownCallback(){},_checkIfViewportsRenderingSameScene(){return false},_activateModify(){},_deactivateModify(){},_dragCallback(){nativeDrags++;}},toolGroup={getToolOptions:()=>({mode:'Active'}),getToolInstance:name=>name==='Crosshairs'?crosshairs:null};
window.cornerstoneTools={ToolGroupManager:{getToolGroupForViewport:()=>toolGroup}};
const services={viewportGridService:{getState:()=>grid,setViewportIsReady(){}},cornerstoneViewportService:{getCornerstoneViewport:id=>views.get(id),resizeQueue:[],gridResizeTimeOut:null},displaySetService:{getDisplaySetByUID:()=>({StudyInstanceUID:'study-1',SeriesInstanceUID:'series-1',Modality:'CT'})}};
// The pinned OHIF resize pipeline: a queued viewport resize (resizeQueue) or grid resize window, then performResize sizes
// each canvas to its client box and re-applies each plane's position presentation (a slice snap and a zoom refit).
const native=services.cornerstoneViewportService;
window.presentation=()=>start().map(c=>({...c,focalPoint:c.focalPoint.map((x,k)=>x-c.viewPlaneNormal[k]*1e-6),position:c.position.map((x,k)=>x-c.viewPlaneNormal[k]*1e-6),parallelScale:c.parallelScale*200/201}));
window.settleNative=next=>{[...views.values()].forEach((v,i)=>{v.getCanvas().width=200;if(next)v.setCamera(structuredClone(next[i]));});native.resizeQueue=[];};
// A native tool that scrolls a plane from its own element listener, after document capture listeners have run.
window.scrollOnPress=(id,mm)=>{const v=views.get(id);v.element.addEventListener('pointerdown',()=>{const c=v.getCamera();v.setCamera({focalPoint:c.focalPoint.map((x,k)=>x+c.viewPlaneNormal[k]*mm),position:c.position.map((x,k)=>x+c.viewPlaneNormal[k]*mm)});},{once:true});};
window.press=id=>views.get(id).element.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
window.controls=()=>[...document.querySelectorAll('#kin-volume-orientation button')].slice(0,3).map(b=>b.disabled);
window.caption=()=>document.querySelector('#kin-volume-orientation .target').textContent;
window.statusText=()=>document.querySelector('#kin-volume-orientation [role=status]').textContent;
window.kinViewerJobWorkspaceState=()=>({busy:workspaceBusy});
const intervals=new Map();window.setInterval=(fn,ms)=>{const list=intervals.get(ms)||[];list.push(fn);intervals.set(ms,list);return {ms,fn}};window.clearInterval=()=>{};window.tick=ms=>(intervals.get(ms)||[]).forEach(fn=>fn());
window.mount=value=>{NAMES.forEach((name,i)=>makeView(name,value[i]));return window.kinCreateVolumeOrientation({services,selected:()=>source,live:()=>alive,allowed:()=>true,owner:()=>['hospital','reader'],host:document.querySelector('#host')});};
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

    def mounted(self, cameras=OBLIQUE, before="", crosshair=False, settle=True):
        page = self.browser.new_page()
        page.route("https://orientation.test/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.goto("https://orientation.test/")
        page.add_script_tag(path=str(MODEL));page.add_script_tag(path=str(PANEL))
        if crosshair:page.add_script_tag(path=str(CROSSHAIR_MODEL));page.add_script_tag(path=str(CROSSHAIR_PANEL))
        if before:page.evaluate("code=>eval(code)", before)
        page.evaluate(f"window.panel=mount({cameras})")
        if settle:
            # The reading at mount and the next tick's identical reading confirm the start screen.
            page.evaluate("tick(500)")
            expect(page.get_by_role('button', name=BASIC, exact=True)).to_be_enabled()
        return page

    def pressed(self, page, name):
        # A programmatic activation reaches apply() even while the button is disabled; a refusal is written synchronously.
        page.evaluate("name=>[...document.querySelectorAll('#kin-volume-orientation button')].find(b=>b.textContent===name).onclick()", name)
        return page.evaluate("statusText()")

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

    def slabbed(self, page):
        # One plane already carries a thicker MIP slab; the default planes must stay at 0.05, not the 0.1 clamp.
        page.evaluate("const c=views.get('mpr-coronal');c.blend=1;c.setSlabThickness(2.5);slabWrites.length=0")
        self.assertLess(page.evaluate("planeError()"), 1e-12)
        return page.evaluate("display()")

    def test_rotation_and_reset_rederive_slab_planes_and_keep_thickness(self):
        for name, cameras in [('focal points at the pivot turn in place', "centered()"), ('focal points move', "start()")]:
            with self.subTest(name=name):
                page = self.mounted(cameras)
                try:
                    display = self.slabbed(page)
                    page.get_by_label('MPR Rotation Axis', exact=True).select_option('2');page.get_by_label('MPR Rotation Degrees', exact=True).fill('40')
                    self.assertIn('40도 회전했습니다', self.apply(page, 'Rotate Three Planes'))
                    self.assertLess(page.evaluate("planeError()"), 1e-9);self.assertEqual(display, page.evaluate("display()"))
                    self.assertIn('시작 MPR 화면', self.apply(page, 'Reset Planes'))
                    self.assertLess(page.evaluate("planeError()"), 1e-9);self.assertEqual(display, page.evaluate("display()"))
                finally:
                    page.close()

    def test_failed_slab_reapply_rolls_back_cameras_with_matching_planes(self):
        page = self.mounted("centered()")
        try:
            display = self.slabbed(page);before = page.evaluate("cameras()");page.evaluate("failSlab='mpr-coronal'")
            page.get_by_label('MPR Rotation Axis', exact=True).select_option('2')
            self.assertIn('INJECTED SLAB FAILURE', self.apply(page, 'Rotate Three Planes'))
            self.assertLess(page.evaluate("b=>largest(cameras(),b)", before), 1e-12)
            self.assertLess(page.evaluate("planeError()"), 1e-9);self.assertEqual(display, page.evaluate("display()"))
        finally:
            page.close()

    def test_crosshair_rotate_drag_rederives_linked_slab_planes_and_rolls_back(self):
        for name, cameras in [('focal points at the pivot turn in place', "centered()"), ('focal points move', "start()")]:
            with self.subTest(name=name):
                page = self.mounted(cameras, crosshair=True)
                try:
                    display = self.slabbed(page);before = page.evaluate("cameras()")
                    page.evaluate("drag('mpr-axial',30)")
                    self.assertEqual(0, page.evaluate("nativeDrags"), "the product wrapper handles rotation")
                    self.assertGreater(page.evaluate("b=>largest(cameras(),b)", before), .1, "the linked planes turned")
                    self.assertLess(page.evaluate("planeError()"), 1e-9);self.assertEqual(display, page.evaluate("display()"))
                    self.assertEqual(['mpr-sagittal', 'mpr-coronal'], page.evaluate("slabWrites"))
                finally:
                    page.close()
        page = self.mounted("centered()", crosshair=True)
        try:
            display = self.slabbed(page);before = page.evaluate("cameras()");page.evaluate("failSlab='mpr-coronal';drag('mpr-axial',30)")
            expect(page.locator('#kin-volume-crosshair [role=status]')).to_have_text('INJECTED SLAB FAILURE')
            self.assertLess(page.evaluate("b=>largest(cameras(),b)", before), 1e-12)
            self.assertLess(page.evaluate("planeError()"), 1e-9);self.assertEqual(display, page.evaluate("display()"))
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

    def rotate_and_reset(self, page, expected):
        page.get_by_label('MPR Rotation Axis', exact=True).select_option('2');page.get_by_label('MPR Rotation Degrees', exact=True).fill('40')
        self.assertIn('40도 회전했습니다', self.apply(page, 'Rotate Three Planes'))
        self.assertIn('시작 MPR 화면', self.apply(page, 'Reset Planes'))
        self.assertLess(page.evaluate("e=>largest(cameras(),e)", expected), 1e-12)

    def test_start_screen_waits_for_the_queued_native_resize(self):
        # VP1: target() already accepts the planes while the pinned resize is queued and the canvas keeps its rounded-up
        # width; that resize then snaps each focal point and refits the zoom (presentation()).
        page = self.mounted("start()", "roundUp=1;native.resizeQueue.push(false)", settle=False)
        try:
            opened = page.evaluate("cameras()");page.evaluate("tick(500);tick(500)")
            self.assertEqual([True, True, True], page.evaluate("controls()"), "Rotate, Reset and Basic wait for the presented screen")
            self.assertIn('시작 MPR 화면을 확인하는 중', page.evaluate("caption()"))
            page.evaluate("writes.length=0");self.assertIn('확인하는 중', self.pressed(page, 'Reset Planes'));self.assertEqual([], page.evaluate("writes"))
            page.evaluate("settleNative(presentation())");presented = page.evaluate("cameras()")
            page.evaluate("tick(500)");self.assertEqual([True, True, True], page.evaluate("controls()"), "one presented reading does not confirm the screen")
            page.evaluate("tick(500)");self.assertEqual([False, False, False], page.evaluate("controls()"))
            self.assertGreater(page.evaluate("o=>largest(cameras(),o)", opened), 1e-3, "the native resize changed the planes")
            self.rotate_and_reset(page, presented)
        finally:
            page.close()

    def test_start_screen_restarts_for_a_new_source_job_restore_and_owner_loss(self):
        turned = "turned([[[0,0,1],20]])"
        for name, change in [
            # A new source in the same viewports is a new screen; the previous start screen is not reused.
            ('new source', f"source.sourceSignature='source-2';[...views.values()].forEach((v,i)=>v.setCamera({turned}[i]))"),
            # A Job restore owns the planes while it runs; its restored planes are read only after it ends.
            ('Job restore', f"workspaceBusy=true;source.sourceSignature='restored';[...views.values()].forEach((v,i)=>v.setCamera({turned}[i]));tick(500);tick(500);workspaceBusy=false"),
        ]:
            with self.subTest(name=name):
                page = self.mounted("start()")
                try:
                    expected = page.evaluate(turned);page.evaluate("code=>eval(code)", change)
                    page.evaluate("tick(500)");self.assertEqual([True, True, True], page.evaluate("controls()"))
                    page.evaluate("tick(500)");self.assertEqual([False, False, False], page.evaluate("controls()"))
                    self.rotate_and_reset(page, expected)
                finally:
                    page.close()
        with self.subTest(name='owner lost while pending'):
            page = self.mounted("start()", "native.resizeQueue.push(false)", settle=False)
            try:
                page.evaluate("tick(500);alive=false;settleNative();tick(500);tick(500)")
                self.assertTrue(page.evaluate("document.querySelector('#kin-volume-orientation').hidden"))
                page.evaluate("alive=true;tick(500)");self.assertEqual([True, True, True], page.evaluate("controls()"), "no reading without the owner confirms the screen")
                page.evaluate("tick(500)");self.assertEqual([False, False, False], page.evaluate("controls()"))
                self.rotate_and_reset(page, page.evaluate("start()"))
            finally:
                page.close()
        with self.subTest(name='disposed while pending'):
            page = self.mounted("start()", "native.resizeQueue.push(false)", settle=False);errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            try:
                page.evaluate("panel.dispose();settleNative();writes.length=0;tick(500);tick(500);press('mpr-axial')")
                self.assertEqual(0, page.locator('#kin-volume-orientation').count());self.assertEqual([], page.evaluate("writes"));self.assertEqual([], errors)
            finally:
                page.close()

    def test_start_screen_that_never_presents_leaves_reset_unavailable_after_the_deadline(self):
        page = self.mounted("start()", "native.resizeQueue.push(false)", settle=False)
        try:
            page.evaluate("tick(500);clockOffset+=59000;tick(500)")
            self.assertEqual([True, True, True], page.evaluate("controls()"))
            page.evaluate("clockOffset+=1500;tick(500)")
            self.assertEqual([False, True, False], page.evaluate("controls()"), "Rotate and Basic work; Reset Planes has no start screen")
            self.assertIn('안정되지 않아 Reset Planes를 사용할 수 없습니다', page.evaluate("caption()"))
            page.evaluate("writes.length=0");self.assertIn('시작 화면을 확인할 수 없습니다', self.pressed(page, 'Reset Planes'));self.assertEqual([], page.evaluate("writes"))
            page.evaluate("settleNative();tick(500);tick(500)")
            self.assertEqual([False, True, False], page.evaluate("controls()"), "a screen presented after the deadline is not taken as the start")
            page.get_by_label('MPR Rotation Axis', exact=True).select_option('2')
            self.assertIn('15도 회전했습니다', self.apply(page, 'Rotate Three Planes'))
        finally:
            page.close()

    def test_input_before_the_start_screen_is_confirmed(self):
        # The mount reading is presented; the press arrives before the next tick and a native tool scrolls on it.
        page = self.mounted("start()", settle=False)
        try:
            opened = page.evaluate("cameras()");self.assertEqual([True, True, True], page.evaluate("controls()"))
            page.evaluate("scrollOnPress('mpr-axial',2);press('mpr-axial')")
            self.assertGreater(page.evaluate("o=>largest(cameras(),o)", opened), 1, "the native tool scrolled the plane")
            self.assertEqual([False, False, False], page.evaluate("controls()"), "the screen the press acted on is the start screen")
            self.rotate_and_reset(page, opened)
        finally:
            page.close()
        for name, scroll, controls in [
            ('an input moves a plane while the native resize is queued', True, [False, True, False]),
            ('an input moves nothing while the native resize is queued', False, [False, False, False]),
        ]:
            with self.subTest(name=name):
                page = self.mounted("start()", "roundUp=1;native.resizeQueue.push(false)", settle=False)
                try:
                    opened = page.evaluate("cameras()")
                    page.evaluate("s=>{if(s)scrollOnPress('mpr-axial',2);press('mpr-axial');settleNative();tick(500);tick(500)}", scroll)
                    self.assertEqual(controls, page.evaluate("controls()"))
                    if scroll:
                        self.assertIn('평면이 바뀌어 Reset Planes를 사용할 수 없습니다', page.evaluate("caption()"))
                        self.assertIn('시작 화면을 확인할 수 없습니다', self.pressed(page, 'Reset Planes'))
                    else:
                        self.rotate_and_reset(page, opened)
                finally:
                    page.close()


if __name__ == '__main__':
    unittest.main()
