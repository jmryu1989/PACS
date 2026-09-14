# coding: utf-8
"""TEST-VOLUME-SYNC-LAYOUT: MPR synchronization choices stay on a Hanging Protocol three-plane layout.

REQ-D-VOLUME-SYNC / REQ-D-MPR-PREFERENCES on REQ-D07-MPR-HANGING, RISK-D-VOLUME-SYNC-TARGET/LOSS and
RISK-D-MPR-PREF-LOSS. The real MPR Synchronization panel runs in Chromium against synthetic native
viewports, grid and brightness synchronizer. A Hanging Protocol opens the three planes in a 2x2 grid
whose fourth cell is empty, and the shared MPR target accepts those three shown cells. The panel must
keep the user's latest Windowing/Zoom choice and a profile applied through its capability on that
layout, bind each plane once, attach a restored layout once, release the session when the vacancy is
filled, and a failed attach must leave no native change behind before it recovers. This is no GPU,
pixel or native Hanging Protocol proof.
"""
from pathlib import Path
import os
import unittest

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
SYNC = Path(os.environ.get("KIN_SYNC_SOURCE", ROOT / "worklist-v0" / "hpacs-lite" / "viewer-volume-sync.js"))

HARNESS = r"""
<div id="host"></div>
<script>
const E={VOI_MODIFIED:'CORNERSTONE_VOI_MODIFIED',CAMERA_MODIFIED:'CORNERSTONE_CAMERA_MODIFIED'};
const counters={attach:0},volume={id:'ct-volume'},listeners=new WeakMap(),engineResize=function(){},engine={resize:engineResize};
let cells=[],current=new Map();window.hideTarget=false;
function makeView(id){
  const element=document.createElement('div'),own={},add=element.addEventListener.bind(element),remove=element.removeEventListener.bind(element);listeners.set(element,own);
  element.addEventListener=(name,handler,options)=>{(own[name]||=new Set()).add(handler);add(name,handler,options);};
  element.removeEventListener=(name,handler,options)=>{own[name]?.delete(handler);remove(name,handler,options);};
  const view={id,renderingEngineId:'engine',element,zoom:1,initialCamera:{parallelScale:100},viewportProperties:{},
    getRenderingEngine:()=>engine,getVolumeId:()=>volume.id,getZoom:()=>view.zoom,
    setZoom(value){view.zoom=value;element.dispatchEvent(new CustomEvent(E.CAMERA_MODIFIED,{detail:{viewportId:id}}));},
    getCamera:()=>({parallelScale:100/view.zoom,focalPoint:[0,0,0],position:[0,0,1],viewUp:[0,1,0],viewPlaneNormal:[0,0,1]}),
    setCamera(camera){view.setZoom(100/camera.parallelScale);},
    getProperties:()=>({voiRange:{...(view.viewportProperties.voiRange||{lower:0,upper:1000})},VOILUTFunction:'LINEAR',invert:false}),
    setProperties({voiRange}={}){if(!voiRange)return;view.viewportProperties.voiRange={...voiRange};element.dispatchEvent(new CustomEvent(E.VOI_MODIFIED,{detail:{viewportId:id,range:{...voiRange}}}));},
    getActors:()=>[{referencedId:volume.id,actor:{getProperty:()=>({getRGBTransferFunction:()=>({})})}}],
    render(){},resetProperties(){},resetCamera(){}};
  return view;
}
// A Hanging Protocol opens the three planes in a 2x2 grid with an empty fourth cell; an ordinary MPR grid has only the three.
window.layout=(tag,vacancy)=>{
  cells=['axial','sagittal','coronal'].map(name=>({viewportId:name+'-'+tag,displaySetInstanceUIDs:['ct-series']}));
  if(vacancy)cells.push({viewportId:'vacancy-'+tag,displaySetInstanceUIDs:[]});
  current=new Map(cells.filter(c=>c.displaySetInstanceUIDs.length).map(c=>[c.viewportId,makeView(c.viewportId)]));
};
const services={viewportGridService:{getState:()=>({viewports:new Map(cells.map(c=>[c.viewportId,{...c,displaySetInstanceUIDs:[...c.displaySetInstanceUIDs]}]))})},
  cornerstoneViewportService:{getCornerstoneViewport:id=>current.get(id),performResize(){}}};
const performResize=services.cornerstoneViewportService.performResize;
// The shared MPR target: exactly three shown cells, as viewer-volume-orientation.js selects them.
function target(){
  const shown=cells.filter(c=>c.displaySetInstanceUIDs.length);if(window.hideTarget||shown.length!==3)return null;
  return {group:JSON.stringify(shown.map(c=>c.viewportId)),views:shown.map(c=>current.get(c.viewportId)),source:{study:{id:'HP-STUDY'}}};
}
const native={id:'mpr',_eventName:E.VOI_MODIFIED,enabled:true,isDisabled:()=>!native.enabled,setEnabled(value){native.enabled=value;},
  getSourceViewports:()=>[...current.values()].map(v=>({viewportId:v.id,renderingEngineId:'engine'})),getTargetViewports:()=>native.getSourceViewports()};
window.cornerstone={Enums:{Events:E},cache:{getVolume:id=>id===volume.id?volume:undefined},
  utilities:{transferFunctionUtils:{getTransferFunctionNodes:()=>[],setTransferFunctionNodes(){}},triggerEvent:(element,name,detail)=>element.dispatchEvent(new CustomEvent(name,{detail}))}};
// Groups are read only when a session attaches, so this counts attach attempts.
window.cornerstoneTools={SynchronizerManager:{getAllSynchronizers:()=>{counters.attach++;return [native];},getSynchronizer:id=>id===native.id?native:undefined}};
const intervalCallbacks=[];window.setInterval=fn=>{intervalCallbacks.push(fn);return intervalCallbacks.length;};window.clearInterval=()=>{};
window.tick=(count=1)=>{for(let i=0;i<count;i++)intervalCallbacks.forEach(fn=>fn());};
window.mount=()=>{window.sync=window.kinCreateVolumeSync({target,permitted:()=>true,alive:()=>true,services,host:document.querySelector('#host')});};
const box=name=>document.querySelector('[aria-label="Sync MPR '+name+'"]');
window.syncState=()=>({windowing:box('Windowing').checked,zoom:box('Zoom').checked,enabled:!box('Zoom').disabled,
  read:window.kinVolumeSynchronization?.read()??null,attach:counters.attach,nativeEnabled:native.enabled,
  hooked:services.cornerstoneViewportService.performResize!==performResize,status:document.querySelector('#kin-volume-sync [role=status]').textContent});
window.planes=()=>[...current.values()];
window.bindings=views=>views.map(v=>[listeners.get(v.element)[E.VOI_MODIFIED]?.size||0,listeners.get(v.element)[E.CAMERA_MODIFIED]?.size||0]);
window.zooms=()=>planes().map(v=>v.zoom);
window.uppers=()=>planes().map(v=>v.viewportProperties.voiRange?.upper??null);
</script>
"""


class ViewerVolumeSyncLayoutDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop()

    def open_page(self, vacancy=True, broken_engine=False):
        page = self.browser.new_page();errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route("https://sync-layout.test/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.goto("https://sync-layout.test/")
        page.evaluate("([vacancy,broken])=>{layout('opened',vacancy);if(broken)delete engine.resize}", [vacancy, broken_engine])
        page.add_script_tag(path=str(SYNC))
        page.evaluate("()=>{mount();tick()}")
        expect(page.locator('#kin-volume-sync')).to_be_visible()
        return page, errors

    def click(self, page, name):
        # A plain click, so a checkbox the panel flips back is observed instead of retried.
        page.get_by_role('checkbox', name='Sync MPR '+name, exact=True).click()

    def test_hanging_protocol_vacancy_keeps_the_latest_sync_choice(self):
        page, errors = self.open_page(vacancy=True)
        try:
            state = page.evaluate("syncState()")
            self.assertEqual((True, False, False), (state['windowing'], state['zoom'], state['nativeEnabled']))
            self.click(page, 'Zoom');self.click(page, 'Windowing');page.evaluate("tick(8)")
            state = page.evaluate("syncState()")
            self.assertEqual((False, True), (state['windowing'], state['zoom']),
                             "the user's latest choice stays on the Hanging Protocol three planes")
            self.assertEqual({'windowing': False, 'zoom': True}, state['read'])
            self.assertIn('동기화 설정을 적용했습니다', state['status'])
            self.assertEqual(1, state['attach'], "an unchanged layout is not attached again on every refresh")
            self.assertFalse(state['nativeEnabled']);self.assertTrue(state['hooked'])
            self.assertEqual([[1, 1]] * 3, page.evaluate("bindings(planes())"), "each plane is bound once")
            # What the panel shows is what happens: Zoom follows, Windowing stays on its own plane.
            page.evaluate("planes()[0].setZoom(1.5)")
            self.assertEqual([1.5] * 3, page.evaluate("zooms()"))
            page.evaluate("async()=>{planes()[0].setProperties({voiRange:{lower:0,upper:1500}});await new Promise(r=>setTimeout(r,0))}")
            self.assertEqual([1500, None, None], page.evaluate("uppers()"))
            # A profile applied through the capability (MPR Properties or the account profile) is kept
            # across refreshes and a transient target loss on the same layout.
            self.assertTrue(page.evaluate("kinVolumeSynchronization.apply({windowing:true,zoom:false})"))
            page.evaluate("()=>{hideTarget=true;tick(2);hideTarget=false;tick(6)}")
            state = page.evaluate("syncState()")
            self.assertEqual({'windowing': True, 'zoom': False}, state['read'], "an applied profile is not reset by later refreshes")
            self.assertEqual((True, False, True, 1), (state['windowing'], state['zoom'], state['enabled'], state['attach']))
            page.evaluate("async()=>{planes()[1].setProperties({voiRange:{lower:0,upper:1800}});await new Promise(r=>setTimeout(r,0))}")
            self.assertEqual([1800] * 3, page.evaluate("uppers()"))
            self.assertEqual([], errors)
        finally:
            page.close()

    def test_restored_layout_attaches_once_and_a_filled_vacancy_releases_the_session(self):
        page, errors = self.open_page(vacancy=True)
        try:
            self.click(page, 'Zoom')
            # Restore Job mounts new plane viewports into the same 2x2 layout.
            page.evaluate("()=>{window.retired=planes();layout('restored',true);tick(4)}")
            state = page.evaluate("syncState()")
            self.assertEqual((True, False), (state['windowing'], state['zoom']), "options belong to the layout they were chosen on")
            self.assertEqual(2, state['attach'], "the restored layout is attached exactly once")
            self.assertEqual([[0, 0]] * 3, page.evaluate("bindings(retired)"))
            self.assertEqual([[1, 1]] * 3, page.evaluate("bindings(planes())"))
            self.click(page, 'Zoom');page.evaluate("tick(4)")
            page.evaluate("retired[0].setZoom(2)")
            self.assertEqual([1, 1, 1], page.evaluate("zooms()"), "a retired plane's event is not synchronized")
            self.assertEqual((True, 2), tuple(page.evaluate("[syncState().zoom,syncState().attach]")))
            # Another series fills the vacancy: these are no longer the three MPR planes.
            page.evaluate("()=>{cells[3].displaySetInstanceUIDs=['other-series'];tick()}")
            state = page.evaluate("syncState()")
            self.assertIsNone(state['read'])
            self.assertTrue(state['nativeEnabled'], "the native brightness group is handed back")
            self.assertFalse(state['hooked'])
            self.assertEqual([[0, 0]] * 3, page.evaluate("bindings(planes())"))
            self.assertEqual([], errors)
        finally:
            page.close()

    def test_failed_attach_leaves_no_native_change_and_recovers_when_the_path_returns(self):
        page, errors = self.open_page(vacancy=False, broken_engine=True)
        try:
            for ticks in (0, 4):
                page.evaluate("count=>tick(count)", ticks)
                state = page.evaluate("syncState()")
                self.assertIn('화면 크기 변경 경로', state['status'])
                self.assertFalse(state['enabled'], "a failed attach offers no synchronization control")
                self.assertIsNone(state['read'])
                self.assertTrue(state['nativeEnabled'], "the native brightness group muted before the failure is restored")
                self.assertFalse(state['hooked'], "no partial resize hook is left behind")
                self.assertEqual([[0, 0]] * 3, page.evaluate("bindings(planes())"))
            # Current cadence: one side-effect-free attempt per refresh until the resize path returns.
            self.assertEqual(6, page.evaluate("syncState().attach"))
            page.evaluate("()=>{engine.resize=engineResize;tick()}")
            state = page.evaluate("syncState()")
            self.assertEqual((7, True, True, False), (state['attach'], state['enabled'], state['windowing'], state['nativeEnabled']))
            self.assertEqual([[1, 1]] * 3, page.evaluate("bindings(planes())"))
            self.click(page, 'Zoom');page.evaluate("tick(8)")
            self.assertEqual((True, 7), tuple(page.evaluate("[syncState().zoom,syncState().attach]")))
            page.evaluate("sync.dispose()")
            self.assertEqual([True, True, True], page.evaluate(
                "[native.enabled,engine.resize===engineResize,services.cornerstoneViewportService.performResize===performResize]"))
            self.assertEqual([[0, 0]] * 3, page.evaluate("bindings(planes())"))
            self.assertEqual([], errors)
        finally:
            page.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
