# coding: utf-8
"""TEST-MPR-PREFERENCES-LAYOUT: an applied MPR mouse setting stays bound on a new MPR layout.

REQ-D-MPR-PREFERENCES / RISK-D-MPR-PREF-INPUT/LOSS. The real preference model and MPR Properties
panel run in Chromium against a synthetic native tool group. Restore Job and layout changes mount
new MPR viewports on the same native tool group after the panel restored its original bindings; a
mouse setting applied in this window must be bound again instead of staying shown but unbound. A
pending account profile still wins, a failed rebind is reported once without a loop, the layout's
synchronization default and the never-configured native bindings are left alone, and teardown still
restores the native bindings. This is no GPU, pixel or native Restore Job proof.
"""
from pathlib import Path
import os
import unittest

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
MODEL = HPACS / "volume-preferences.js"
PREFERENCES = Path(os.environ.get("KIN_PREFERENCES_SOURCE", HPACS / "viewer-volume-preferences.js"))

HARNESS = r"""
<div id="host"></div><div id="grid"></div>
<script>
let alive=true,allowedFlag=true,layout=0,currentViews=[];const calls={active:0},syncApplies=[];
const native=()=>({WindowLevel:{mode:'Active',bindings:[{mouseButton:1}]},Pan:{mode:'Active',bindings:[{mouseButton:4}]},
  Zoom:{mode:'Active',bindings:[{mouseButton:2},{mouseButton:2,modifierKey:16},{numTouchPoints:2}]},StackScroll:{mode:'Active',bindings:[{mouseButton:524288}]},Length:{mode:'Passive',bindings:[]}});
const sameBinding=(a,b)=>a.mouseButton===b.mouseButton&&a.modifierKey===b.modifierKey&&a.numTouchPoints===b.numTouchPoints;
// The pinned @cornerstonejs/tools ToolGroup setters (orthancteam/orthanc:24.12.0): Active appends new bindings to the tool's
// existing ones. Passive removes all, the listed or by default only the primary binding, and a tool that keeps any binding
// stays Active. Enabled and Disabled drop every binding.
// failBinding fails one activation of that tool on that button after it was applied, as a partial native failure.
const group={toolOptions:native(),failBinding:null,
  getToolInstance:name=>name in group.toolOptions?{}:undefined,getToolOptions:name=>group.toolOptions[name],
  setToolActive(name,{bindings=[]}={}){calls.active++;const merged=[];
    for(const b of [...(group.toolOptions[name]?.bindings||[]),...bindings])if((b.mouseButton!==undefined||b.numTouchPoints!==undefined)&&!merged.some(x=>sameBinding(x,b)))merged.push(b);
    group.toolOptions[name]={bindings:merged,mode:'Active'};
    const fail=group.failBinding;if(fail&&fail.name===name&&bindings.some(b=>b.mouseButton===fail.mouseButton&&b.modifierKey===undefined)){group.failBinding=null;throw Error('REBIND FAILURE');}},
  setToolPassive(name,options){const remove=options?.removeAllBindings,match=Array.isArray(remove)?remove:[{mouseButton:1}];
    const bindings=(group.toolOptions[name]?.bindings||[]).filter(b=>remove!==true&&!match.some(x=>sameBinding(b,x)));
    group.toolOptions[name]={bindings,mode:bindings.length?'Active':'Passive'};},
  setToolEnabled(name){group.toolOptions[name]={bindings:[],mode:'Enabled'};},
  setToolDisabled(name){group.toolOptions[name]={bindings:[],mode:'Disabled'};}};
function makeViews(tag){
  return ['axial','sagittal','coronal'].map(name=>{const wrapper=document.createElement('div'),element=document.createElement('div');wrapper.className='viewport-wrapper';wrapper.append(element);document.querySelector('#grid').append(wrapper);
    return {id:name+'-'+tag,renderingEngineId:'engine',element,getZoom:()=>1,getCanvas:()=>({clientWidth:300,clientHeight:200}),canvasToWorld:([x,y])=>[x,y,0],worldToCanvas:([x,y])=>[x,y],getCamera:()=>({focalPoint:[0,0,0],viewPlaneNormal:[0,0,1]})};});
}
// A restored Job mounts new viewports on the same native tool group and retires the old elements.
window.restoreJob=()=>{for(const v of currentViews)v.element.parentElement.remove();layout++;currentViews=makeViews('layout-'+layout);};
window.cornerstone={Enums:{Events:{CAMERA_MODIFIED:'CAMERA_MODIFIED'}}};
window.cornerstoneTools={ToolGroupManager:{getToolGroupForViewport:()=>group}};
window.kinViewerJobWorkspaceState=()=>({busy:false});window.kinMprRenderingState={busy:()=>false,settle(){}};
window.kinVolumeSynchronization={value:{windowing:true,zoom:false},read(){return {...this.value};},apply(value){syncApplies.push(value);this.value={...value};return true;}};
const services={cornerstoneViewportService:{getCornerstoneViewport:id=>currentViews.find(v=>v.id===id)}};
const intervalCallbacks=[];window.setInterval=fn=>{intervalCallbacks.push(fn);return intervalCallbacks.length;};window.clearInterval=()=>{};
window.tick=(count=1)=>{for(let i=0;i<count;i++)intervalCallbacks.forEach(fn=>fn());};
window.mount=()=>{currentViews=makeViews('layout-0');window.preferences=window.kinCreateVolumePreferences({target:()=>currentViews.length?{group:'layout-'+layout,views:currentViews}:null,
  permitted:()=>allowedFlag,alive:()=>alive,owner:()=>['hospital','reader'],services,host:document.querySelector('#host')});};
const holder=button=>Object.entries(group.toolOptions).filter(([,o])=>o.mode==='Active'&&o.bindings.some(b=>b.mouseButton===button&&b.modifierKey===undefined)).map(([name])=>name);
// What the three mouse buttons actually do, next to what the panel shows for them.
window.mouseState=()=>({bound:{left:holder(1),middle:holder(4),right:holder(2)},
  shown:Object.fromEntries(['left','middle','right'].map(k=>[k,document.querySelector('[aria-label="MPR '+k+' mouse button"]').value])),
  status:document.querySelector('#kin-mpr-preferences [role=status]').textContent});
</script>
"""

APPLIED = {'left': 'StackScroll', 'middle': 'Zoom', 'right': 'WindowLevel'}
NATIVE = {'left': 'WindowLevel', 'middle': 'Pan', 'right': 'Zoom'}


def bound(mouse):
    return {key: [value] for key, value in mouse.items()}


class ViewerVolumePreferencesLayoutDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop()

    def open_page(self, stored=None):
        page = self.browser.new_page();errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route("https://preferences-layout.test/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.goto("https://preferences-layout.test/")
        if stored is not None:
            page.evaluate("value=>localStorage.setItem('kin-mpr-preferences:v1:'+JSON.stringify(['hospital','reader']),JSON.stringify(value))", stored)
        page.add_script_tag(path=str(MODEL));page.add_script_tag(path=str(PREFERENCES))
        page.evaluate("()=>{mount();tick()}")
        expect(page.locator('#kin-mpr-preferences')).to_be_visible()
        return page, errors

    def apply_mouse(self, page, mouse=APPLIED):
        for key, value in mouse.items():
            page.get_by_label('MPR '+key+' mouse button', exact=True).select_option(value)
        page.get_by_role('button', name='Apply Mouse', exact=True).click()
        expect(page.locator('#kin-mpr-preferences [role=status]')).to_contain_text('마우스 버튼을 적용')
        state = page.evaluate("mouseState()")
        self.assertEqual(bound(mouse), state['bound']);self.assertEqual(mouse, state['shown'])
        return page.evaluate("structuredClone(group.toolOptions)")

    def test_applied_mouse_is_bound_again_on_a_restored_layout(self):
        page, errors = self.open_page()
        try:
            original = page.evaluate("structuredClone(group.toolOptions)")
            applied = self.apply_mouse(page)
            page.evaluate("()=>{restoreJob();tick()}")
            state = page.evaluate("mouseState()")
            self.assertEqual(APPLIED, state['shown'])
            self.assertEqual(bound(APPLIED), state['bound'],
                             "the new layout must bind the applied mouse setting the panel still shows")
            # The same bindings, including the modifier and touch bindings Apply Mouse leaves alone.
            self.assertEqual(applied, page.evaluate("group.toolOptions"))
            # Mouse only: the layout's synchronization default and the browser profile stay untouched.
            self.assertEqual([], page.evaluate("syncApplies"))
            self.assertIsNone(page.evaluate("localStorage.getItem('kin-mpr-preferences:v1:'+JSON.stringify(['hospital','reader']))"))
            calls = page.evaluate("calls.active");page.evaluate("tick(8)")
            self.assertEqual(calls, page.evaluate("calls.active"), "no repeated rebinding while the layout stays")
            page.evaluate("preferences.dispose()")
            self.assertEqual(original, page.evaluate("group.toolOptions"), "teardown still restores the native bindings")
            self.assertEqual([], errors)
        finally:
            page.close()

    def test_rebind_waits_for_modal_and_a_newer_pending_profile_wins(self):
        page, errors = self.open_page()
        try:
            self.apply_mouse(page)
            page.evaluate("()=>{allowedFlag=false;restoreJob();tick(2)}")
            pending = page.evaluate("()=>{const next=KinVolumePreferences.defaults();next.mouse={left:'Pan',middle:'WindowLevel',right:'Zoom'};next.sync={windowing:false,zoom:true};return kinMprPreferences.requestApply(next)}")
            self.assertTrue(pending)
            page.evaluate("()=>{allowedFlag=true;tick()}")
            newer = {'left': 'Pan', 'middle': 'WindowLevel', 'right': 'Zoom'}
            state = page.evaluate("mouseState()")
            self.assertEqual(bound(newer), state['bound']);self.assertEqual(newer, state['shown'])
            self.assertEqual([{'windowing': False, 'zoom': True}], page.evaluate("syncApplies"))
            calls = page.evaluate("calls.active");page.evaluate("tick(8)")
            self.assertEqual(calls, page.evaluate("calls.active"), "the older applied setting never replaces the newer profile")
            self.assertEqual(bound(newer), page.evaluate("mouseState().bound"))
            self.assertEqual([], errors)
        finally:
            page.close()

    def test_failed_rebind_is_reported_once_and_keeps_native_bindings(self):
        page, errors = self.open_page()
        try:
            original = page.evaluate("structuredClone(group.toolOptions)")
            self.apply_mouse(page)
            # Only the new layout's rebind of the applied left button fails; restoring the native
            # bindings of the retired layout never activates StackScroll on the left button.
            page.evaluate("()=>{restoreJob();group.failBinding={name:'StackScroll',mouseButton:1};tick()}")
            state = page.evaluate("mouseState()")
            self.assertIn('REBIND FAILURE', state['status'])
            self.assertIsNone(page.evaluate("group.failBinding"))
            self.assertEqual(original, page.evaluate("group.toolOptions"), "a failed rebind rolls back to the exact native bindings")
            calls = page.evaluate("calls.active");page.evaluate("tick(8)")
            self.assertEqual(calls, page.evaluate("calls.active"), "a failed rebind is not retried in a loop")
            # The panel stays attached and usable for an explicit retry.
            expect(page.get_by_role('button', name='Apply Mouse', exact=True)).to_be_enabled()
            self.assertEqual(3, page.locator('.kin-mpr-zoom').count())
            self.assertEqual([], errors)
        finally:
            page.close()

    def test_toolbar_passive_tool_bound_to_the_middle_button_restores_after_retirement_and_rebind(self):
        # IF-A06. The native toolbar leaves WindowLevel Passive without a binding and Apply Mouse binds it to the middle
        # button. Retiring the layout, the next layout's rebind and teardown must each return the reused group to the
        # toolbar's state instead of leaving WindowLevel on the middle button beside Pan.
        page, errors = self.open_page()
        try:
            page.evaluate("()=>{group.setToolPassive('WindowLevel');group.setToolActive('Zoom',{bindings:[{mouseButton:1}]})}")
            original = page.evaluate("structuredClone(group.toolOptions)")
            self.assertEqual({'bindings': [], 'mode': 'Passive'}, original['WindowLevel'])
            mouse = {'left': 'Pan', 'middle': 'WindowLevel', 'right': 'Zoom'}
            self.apply_mouse(page, mouse)
            page.evaluate("()=>{for(const v of currentViews)v.element.parentElement.remove();currentViews=[];tick(2)}")
            with self.subTest('retirement restores the toolbar choice'):
                self.assertEqual(original, page.evaluate("group.toolOptions"))
            page.evaluate("()=>{layout++;currentViews=makeViews('layout-'+layout);tick()}")
            self.assertEqual(bound(mouse), page.evaluate("mouseState().bound"))
            page.evaluate("preferences.dispose()")
            with self.subTest('the rebind does not adopt a partly restored original'):
                self.assertEqual(original, page.evaluate("group.toolOptions"))
            self.assertEqual([], errors)
        finally:
            page.close()

    def test_saved_profile_and_never_configured_layouts_keep_existing_behaviour(self):
        with self.subTest('never configured'):
            page, errors = self.open_page()
            try:
                original = page.evaluate("structuredClone(group.toolOptions)")
                page.evaluate("()=>{restoreJob();tick(3)}")
                self.assertEqual(original, page.evaluate("group.toolOptions"))
                self.assertEqual(0, page.evaluate("calls.active"))
                self.assertEqual(NATIVE, page.evaluate("mouseState().shown"))
                self.assertEqual([], page.evaluate("syncApplies"))
                self.assertEqual([], errors)
            finally:
                page.close()
        with self.subTest('saved profile'):
            saved = {'version': 1, 'display': {'windowing': False, 'zoom': True, 'thickness': True, 'scale': True, 'orientation': True,
                     'demographics': True, 'cube': True, 'sample': True, 'autoHideCrosshair': False},
                     'mouse': {'left': 'Pan', 'middle': 'StackScroll', 'right': 'Zoom'}, 'sync': {'windowing': False, 'zoom': True}, 'progressive': False}
            page, errors = self.open_page(saved)
            try:
                expected = bound(saved['mouse'])
                self.assertEqual(expected, page.evaluate("mouseState().bound"))
                page.evaluate("()=>{restoreJob();tick()}")
                self.assertEqual(expected, page.evaluate("mouseState().bound"))
                self.assertEqual([saved['sync'], saved['sync']], page.evaluate("syncApplies"))
                self.assertEqual([], errors)
            finally:
                page.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
