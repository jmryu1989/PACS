# coding: utf-8
"""Deterministic browser regression for VR source binding during layout transients.

S8-U1a (DM-U1a-01..04): the harness serves the repository's real lazily loaded VR files at /worklist/hpacs-lite/<file>
and fakes only the renderer: mapper view-specific properties (copied on write, recorded), the linked program the product
reads after a render (the stored fragment replacements applied to a fixed fragment), render counting and a preflight stub
that records its candidates. Product writes, preflight calls and the post-render check are never bypassed.
"""
from pathlib import Path
from urllib.parse import urlparse
import json
import os
import re
import unittest

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
LITE = ROOT / "worklist-v0" / "hpacs-lite"
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
// Gradient opacity as the viewer's presets leave it on the real volume property: on, opacity 1 at both ends.
const gradient={use:true,minimum:1,maximum:1};
const property={getRGBTransferFunction:()=>colors,getScalarOpacity:()=>curve,setShade(){},
  getUseGradientOpacity:()=>gradient.use,setUseGradientOpacity(_,value){gradient.use=value},
  getGradientOpacityMinimumOpacity:()=>gradient.minimum,getGradientOpacityMaximumOpacity:()=>gradient.maximum};
// Renderer fake for the VR mapper: view-specific properties are stored as copies and every write is recorded; a render
// compiles the stored fragment replacements into the linked program the product reads two frames later.
const mapperLog={properties:null,writes:[]};
const mapper={getClippingPlanes:()=>[],removeAllClippingPlanes(){},addClippingPlane(){return true},
  getViewSpecificProperties:()=>structuredClone(mapperLog.properties??{}),
  setViewSpecificProperties(value){mapperLog.properties=structuredClone(value);mapperLog.writes.push(structuredClone(value));}};
const FRAGMENT='#version 300 es\nvec4 getColorForValue(vec4 tValue, vec3 posIS, vec3 tstep)\n{\n  return tValue;\n}\n';
const renderer={renders:0,compiled:{},dropReplacements:false};
function linkedFragment(properties){
  let source=FRAGMENT;if(renderer.dropReplacements)return source;
  const list=properties?.OpenGL?.ShaderReplacements||[];
  for(const pass of [true,false])for(const r of list)if(r.shaderType==='Fragment'&&!!r.replaceFirst===pass)source=r.replaceAll?source.split(r.originalValue).join(r.replacementValue):source.replace(r.originalValue,()=>r.replacementValue);
  return source;
}
const program={getCompiled:()=>true,getLinked:()=>true,getVertexShader:()=>({getSource:()=>'vertex'}),getFragmentShader:()=>({getSource:()=>linkedFragment(renderer.compiled)})};
const preflights=[];let refuseNextPreflight=false;
const vrActor={getMapper:()=>mapper,getProperty:()=>property};
const vrView={id:null,element:null,suppressEvents:false,async setVolumes(){},getActors:()=>[{actor:vrActor}],resetCamera(){},getCamera:camera,setCamera(){},setProperties(){},render(){renderer.renders++;renderer.compiled=structuredClone(mapperLog.properties??{});}};
const engine={privateViews:new Map(),enableElement(config){vrView.id=config.viewportId;vrView.element=config.element;mapperLog.properties=null;renderer.compiled={};this.privateViews.set(config.viewportId,vrView)},getViewport(id){return this.privateViews.get(id)||views.get(id)},disableElement(id){this.privateViews.delete(id)},resize(){},offscreenMultiRenderWindow:{getOpenGLRenderWindow:()=>({getViewNodeFor:m=>m===mapper?{get:()=>({tris:{getProgram:()=>program}})}:null})}};
const volume={volumeId:'volume-1',loadStatus:{loaded:true},framesLoaded:2,imageIds:['frame-0','frame-1'],dimensions:[2,2,2],spacing:[1,1,1],direction:[1,0,0,0,1,0,0,0,1],imageData:{getDimensions:()=>[2,2,2],getSpatialExtent:()=>[0,1,0,1,0,1],indexToWorld:([i,j,k])=>[i,j,k]}};
const alternate={...volume,volumeId:'volume-2'};
window.cornerstone={cache:{getVolume:id=>id==='volume-1'?volume:id==='volume-2'?alternate:null},getEnabledElement:element=>enabled.get(element),metaData:{get:(_,id)=>({SOPClassUID:'1.2.840.10008.5.1.4.1.1.2',Modality:'CT',SamplesPerPixel:1,PhotometricInterpretation:'MONOCHROME2',Rows:2,Columns:2,PixelSpacing:[1,1],ImagePositionPatient:[0,0,id==='frame-0'?0:1],ImageOrientationPatient:[1,0,0,0,1,0]})},Enums:{ViewportType:{VOLUME_3D:'3d'}}};
const services={viewportGridService:{getState:()=>grid,setViewportIsReady:(id,value)=>repairs.push([id,value])},cornerstoneViewportService:{getCornerstoneViewport:id=>views.get(id),resizeQueue:[],gridResizeTimeOut:null},displaySetService:{getDisplaySetByUID:()=>({StudyInstanceUID:'study-1',SeriesInstanceUID:'series-1',Modality:'CT'})}};
window.KinVolumeOrientation={intersection:()=>[0,0,0],rotate:c=>c};
window.KinVolumeSculpt={};window.KinVolumeMaskRenderer={preflight(op,properties){preflights.push(structuredClone(properties));if(refuseNextPreflight){refuseNextPreflight=false;throw Error('Harness refused the candidate program.');}}};let sculptCancels=0;
window.kinCreateVolumeSculpt=({controlsPane})=>{const fieldset=document.createElement('fieldset');controlsPane.append(fieldset);return {fieldset,cancel(){sculptCancels++},reset(){},dispose(){}}};
window.kinViewerJobWorkspaceState=()=>({busy:false});window.kinVolumeBatchState={busy:()=>false};window.kinMprRenderingState={busy:()=>false};
window.fetch=async url=>({ok:true,json:async()=>url.endsWith('/api/me')?{kind:'member',institution:currentOwner[0],sub:currentOwner[1]}:[]});
window.rendererCounts=()=>({preflights:preflights.length,writes:mapperLog.writes.length,renders:renderer.renders});
window.storedProperties=()=>structuredClone(mapperLog.properties);
window.lastWrite=()=>structuredClone(mapperLog.writes.at(-1)??null);
window.refusePreflightOnce=()=>{refuseNextPreflight=true};window.dropLinkedReplacements=value=>{renderer.dropReplacements=value};
// Three frames after an action: the product's post-render check runs two frames after its render.
window.renderSettled=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(r))));
window.privateViewports=()=>engine.privateViews.size;
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

    def page_with_vr(self, real_sculpt=False):
        page = self.browser.new_page()
        self.requested = []
        page.on("request", lambda request: self.requested.append(request.url))
        page.route("https://vr-binding.test/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        # The product's lazy loader asks for /worklist/hpacs-lite/<file>; answer with the repository's real file.
        page.route("https://vr-binding.test/worklist/hpacs-lite/*", self.serve_lite)
        page.goto("https://vr-binding.test/")
        page.add_script_tag(path=str(MODEL));page.add_script_tag(path=str(ORIENTATION));page.add_script_tag(path=str(RENDERING))
        if real_sculpt:
            # Without the two sculpt stubs the loader requests the real sculpt model and panel through the route above.
            page.evaluate("()=>{delete window.KinVolumeSculpt;delete window.kinCreateVolumeSculpt}")
        page.evaluate("window.orientation=mountOrientation()")
        return page

    @staticmethod
    def serve_lite(route, request):
        name = urlparse(request.url).path.rsplit('/', 1)[-1]
        path = LITE / name
        if re.fullmatch(r'[A-Za-z0-9_.-]+\.js', name) and path.is_file():
            route.fulfill(body=path.read_bytes(), content_type='text/javascript')
        else:
            route.fulfill(status=404, body='')

    def requested_files(self):
        return [urlparse(url).path.rsplit('/', 1)[-1] for url in self.requested if urlparse(url).path.startswith('/worklist/hpacs-lite/')]

    def dialog(self, page):
        return page.get_by_role('dialog').filter(has=page.get_by_role('heading', name='Volume Rendering', exact=True))

    def voi(self, page):
        return self.dialog(page).get_by_role('group', name='VOI', exact=True)

    def notice(self, page):
        return page.locator('section').filter(has_text='MPR Orientation').get_by_role('status', include_hidden=True)

    def open_voi_ready(self, page):
        page.evaluate("openVr()")
        expect(self.dialog(page)).to_be_visible()
        expect(self.voi(page).get_by_role('button', name='Apply VOI', exact=True)).to_be_enabled()

    def editor_slab(self, page):
        voi = self.voi(page)
        value = lambda name: float(voi.get_by_role('spinbutton', name=name, exact=True).input_value())
        return {'center': [value('VOI Center ' + a) for a in 'LPS'], 'pivot': [value('VOI Pivot ' + a) for a in 'LPS'],
                'thickness': value('VOI Thickness')}

    def assert_near(self, actual, expected, tolerance=1e-6):
        for a, e in zip(actual, expected):
            self.assertLessEqual(abs(a - e), tolerance, (actual, expected))

    def apply_voi(self, page, thickness=None):
        """FC-D3: a real Apply VOI goes through preflight, one mapper write, a render and the post-render check."""
        voi = self.voi(page)
        if thickness is not None:
            voi.get_by_role('spinbutton', name='VOI Thickness', exact=True).fill(repr(thickness))
        requested, before, notice = self.editor_slab(page), page.evaluate('rendererCounts()'), self.notice(page).text_content()
        voi.get_by_role('button', name='Apply VOI', exact=True).click()
        page.evaluate('renderSettled()')
        after = page.evaluate('rendererCounts()')
        expect(self.dialog(page)).to_be_visible()
        self.assertEqual(self.notice(page).text_content(), notice, 'no notice: the VR stayed open after its post-render check')
        self.assertEqual([after[k] - before[k] for k in ('preflights', 'writes', 'renders')], [1, 1, 1])
        self.assertEqual(len(page.evaluate('lastWrite()')['OpenGL']['ShaderReplacements']), 1, 'one owned replacement written')
        state = page.evaluate('kinVolumeVr.inspect()')
        self.assertIsNotNone(state['voi'])
        self.assert_near(state['voi']['slab']['center'], requested['center'])
        self.assert_near(state['voi']['slab']['pivot'], requested['pivot'])
        self.assert_near([state['voi']['slab']['thickness']], [requested['thickness']])
        self.assert_near(state['voi']['slab']['normal'], [0, 0, 1])
        return state

    def assert_empty_voi_controls(self, page):
        voi = self.voi(page)
        for name in ['Undo VOI', 'Disable VOI', 'Move Slab', 'Rotate Slab']:
            expect(voi.get_by_role('button', name=name, exact=True)).to_be_disabled()
        expect(voi.get_by_role('checkbox', name='Original View', exact=True)).to_be_disabled()

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

    def test_dm_u1a_01_voi_is_locked_while_opening_and_busy_and_empty_until_applied(self):
        """DM-U1a-01 (LC-06, LC-08, CB-11, LC-03) and FC-D2."""
        page = self.page_with_vr()
        try:
            page.evaluate("""()=>{const answer=window.fetchBeforeHold=window.fetch;window.fetch=async url=>{if(String(url).includes('/viewer-jobs')){window.openHeld=true;await new Promise(r=>window.releaseOpen=r);}return answer(url)};window.opening=openVr();}""")
            page.wait_for_function('()=>window.openHeld===true')
            voi = self.voi(page)
            expect(self.dialog(page)).to_be_visible()
            for name in ['Apply VOI', 'Reset VOI']:
                expect(voi.get_by_role('button', name=name, exact=True)).to_be_disabled()
            expect(voi.get_by_role('spinbutton', name='VOI Thickness', exact=True)).to_be_disabled()
            page.evaluate('()=>{window.fetch=window.fetchBeforeHold;window.releaseOpen();return window.opening}')
            expect(voi.get_by_role('button', name='Apply VOI', exact=True)).to_be_enabled()
            expect(voi.get_by_role('spinbutton', name='VOI Thickness', exact=True)).to_be_enabled()
            self.assertIsNone(page.evaluate('kinVolumeVr.inspect()')['voi'])
            self.assertEqual(page.evaluate('kinVolumeVr.inspect()')['voiHistoryDepth'], 0)
            self.assert_empty_voi_controls(page)
            # FC-D2: the loader asked this origin for the real VOI files and nothing else elsewhere.
            self.assertTrue(all(url.startswith('https://vr-binding.test/') for url in self.requested), self.requested)
            for name in ['volume-voi.js', 'volume-vr-voi.js', 'volume-vr-masks.js', 'viewer-volume-vr-voi.js']:
                self.assertIn(name, self.requested_files())
            # Busy: a preset write waiting on the Web Lock locks the VOI with the other edits.
            page.evaluate("""()=>{const key='kin-vr-presets:'+KinVolumeRendering.presetStoreKey(currentOwner);navigator.locks.request(key,()=>new Promise(r=>{window.releasePresetLock=r;window.presetLockHeld=true}))}""")
            page.wait_for_function('()=>window.presetLockHeld===true')
            self.dialog(page).get_by_label('Preset Name', exact=True).fill('Held Write')
            self.dialog(page).get_by_role('button', name='Save New Preset', exact=True).click()
            expect(voi.get_by_role('button', name='Apply VOI', exact=True)).to_be_disabled()
            expect(voi.get_by_role('spinbutton', name='VOI Center L', exact=True)).to_be_disabled()
            page.evaluate('()=>window.releasePresetLock()')
            expect(voi.get_by_role('button', name='Apply VOI', exact=True)).to_be_enabled()
            # Close VR, then a fresh VR starts without the VOI applied before.
            self.apply_voi(page)
            page.evaluate("closeVr()")
            expect(self.dialog(page)).to_be_hidden()
            self.open_voi_ready(page)
            state = page.evaluate('kinVolumeVr.inspect()')
            self.assertIsNone(state['voi']);self.assertEqual(state['voiHistoryDepth'], 0)
            self.assert_empty_voi_controls(page)
        finally:
            page.close()

    def test_dm_u1a_02_a_missing_voi_module_keeps_vr_closed_and_a_retry_opens_it(self):
        """DM-U1a-02 (LC-09, OP-4 (a))."""
        page = self.page_with_vr()
        try:
            before = self.notice(page).text_content()
            missing = 'https://vr-binding.test/worklist/hpacs-lite/volume-vr-masks.js'
            page.route(missing, lambda route: route.abort())
            page.evaluate('openVr()')
            expect(self.dialog(page)).to_be_hidden()
            reason = self.notice(page).text_content()
            self.assertTrue(reason.strip());self.assertNotEqual(reason, before)
            self.assertEqual(page.evaluate('privateViewports()'), 0)
            self.assertIsNone(page.evaluate('kinVolumeVr.inspect()'))
            page.unroute(missing)
            self.open_voi_ready(page)
            self.assertEqual(page.evaluate('privateViewports()'), 1)
        finally:
            page.close()

    def test_dm_u1a_03_an_applied_voi_is_dropped_when_the_source_binding_changes(self):
        """DM-U1a-03 (LC-05, LC-03) after a real Apply VOI, and FC-D4."""
        cases = {
            'uid': ("source.uid='study-2'", "services.displaySetService.getDisplaySetByUID=()=>({StudyInstanceUID:'study-2',SeriesInstanceUID:'series-1',Modality:'CT'})"),
            'owner': ("currentOwner=['hospital','other-reader']", ''),
            'selection': ('source.selectionEpoch++', ''),
        }
        for name, (mutation, rebind) in cases.items():
            with self.subTest(name=name):
                page = self.page_with_vr()
                try:
                    self.open_voi_ready(page)
                    first = self.apply_voi(page)
                    self.assertGreaterEqual(first['voiHistoryDepth'], 1)
                    expect(self.voi(page).get_by_role('button', name='Undo VOI', exact=True)).to_be_enabled()
                    second = self.apply_voi(page, thickness=0.5)
                    self.assertEqual(second['voiHistoryDepth'], 2)
                    page.evaluate("mutation=>{eval(mutation);tick(250)}", mutation)
                    expect(self.dialog(page)).to_be_hidden()
                    self.assertEqual(page.evaluate('privateViewports()'), 0)
                    if rebind:
                        page.evaluate("code=>eval(code)", rebind)
                    writes = page.evaluate('rendererCounts()')['writes']
                    self.open_voi_ready(page)
                    state = page.evaluate('kinVolumeVr.inspect()')
                    self.assertIsNone(state['voi']);self.assertEqual(state['voiHistoryDepth'], 0)
                    editors = self.editor_slab(page)
                    self.assert_near(editors['center'], [.5, .5, .5]);self.assert_near([editors['thickness']], [1])
                    self.assert_empty_voi_controls(page)
                    self.assertEqual(page.evaluate('rendererCounts()')['writes'], writes, 'no mask written for the new viewport')
                    self.assertEqual(page.evaluate('storedProperties()'), None)
                finally:
                    page.close()
        with self.subTest(name='fc-d4-post-render-check-reads-the-linked-program'):
            page = self.page_with_vr()
            try:
                self.open_voi_ready(page)
                self.apply_voi(page)
                before = self.notice(page).text_content()
                page.evaluate('dropLinkedReplacements(true)')
                self.voi(page).get_by_role('spinbutton', name='VOI Thickness', exact=True).fill('0.25')
                self.voi(page).get_by_role('button', name='Apply VOI', exact=True).click()
                page.evaluate('renderSettled()')
                expect(self.dialog(page)).to_be_hidden()
                self.assertNotEqual(self.notice(page).text_content(), before)
            finally:
                page.close()

    def test_dm_u1a_04_the_ninth_sculpt_refusal_writes_nothing_and_keeps_drawing_until_cancel(self):
        """DM-U1a-04 (CB-04, CB-10) on the real sculpt model and panel, and FC-D6."""
        page = self.page_with_vr(real_sculpt=True)
        try:
            page.evaluate("""()=>{vrView.getCamera=()=>({...camera(),parallelProjection:true});
              vrView.worldToCanvas=([x,y])=>{const e=vrView.element;return [e.clientWidth*(.1+.8*x),e.clientHeight*(.1+.8*y)]}}""")
            self.open_voi_ready(page)
            for name in ['volume-sculpt.js', 'viewer-volume-sculpt.js']:
                self.assertIn(name, self.requested_files())
            dialog, voi = self.dialog(page), self.voi(page)
            self.apply_voi(page, thickness=0.75)
            status = dialog.get_by_role('status')
            successes = set()

            def draw(n):
                dialog.get_by_role('combobox', name='Sculpt Tool', exact=True).select_option('Rectangle')
                dialog.get_by_role('combobox', name='Removal Side', exact=True).select_option('Inside')
                dialog.get_by_role('button', name='Draw Region', exact=True).click()
                overlay = page.get_by_label('Sculpt removal preview', exact=True)
                expect(overlay).to_have_count(1)
                box = overlay.bounding_box()
                x0, y0 = box['x'] + box['width'] * (.12 + .085 * n), box['y'] + box['height'] * .2
                page.mouse.move(x0, y0);page.mouse.down();page.mouse.move(x0 + box['width'] * .05, y0 + box['height'] * .3, steps=4);page.mouse.up()
                expect(dialog.get_by_role('button', name='Apply Sculpt', exact=True)).to_be_enabled()

            for n in range(8):
                draw(n)
                if n == 0:
                    # Drawing locks the VOI with the camera and display edits (CB-10).
                    expect(voi.get_by_role('button', name='Apply VOI', exact=True)).to_be_disabled()
                    expect(dialog.get_by_role('combobox', name='View From', exact=True)).to_be_disabled()
                before = page.evaluate('rendererCounts()')
                dialog.get_by_role('button', name='Apply Sculpt', exact=True).click()
                page.evaluate('renderSettled()')
                after = page.evaluate('rendererCounts()')
                self.assertEqual([after[k] - before[k] for k in ('preflights', 'writes', 'renders')], [1, 1, 1], 'sculpt %d' % (n + 1))
                expect(dialog).to_be_visible()
                self.assertEqual(len(page.evaluate('kinVolumeVr.inspect()')['sculpt']), n + 1)
                successes.add(status.text_content())
            c0 = {'counts': page.evaluate('rendererCounts()'), 'state': page.evaluate('kinVolumeVr.inspect()'), 'stored': page.evaluate('storedProperties()')}
            applied = {k: v for k, v in c0['state'].items() if k != 'lastRefusal'}
            self.assertIsNotNone(applied['voi']);self.assertEqual(len(applied['sculpt']), 8)
            draw(8)
            previous = status.text_content()
            status.evaluate("e=>{window.statusWrites=0;window.statusObserver=new MutationObserver(()=>statusWrites++);statusObserver.observe(e,{childList:true,characterData:true,subtree:true})}")
            dialog.get_by_role('button', name='Apply Sculpt', exact=True).click()
            page.evaluate('renderSettled()')
            self.assertEqual(page.evaluate('rendererCounts()'), c0['counts'], 'the refused ninth region wrote, preflighted and rendered nothing')
            refused = page.evaluate('kinVolumeVr.inspect()')
            self.assertEqual({k: v for k, v in refused.items() if k != 'lastRefusal'}, applied)
            self.assertEqual(page.evaluate('storedProperties()'), c0['stored'])
            self.assertEqual(refused['lastRefusal'], 'vr-limit')
            self.assertGreaterEqual(page.evaluate('statusWrites'), 1)
            reason = status.text_content()
            self.assertTrue(reason.strip());self.assertNotEqual(reason, previous);self.assertNotIn(reason, successes)
            expect(page.get_by_label('Sculpt removal preview', exact=True)).to_have_count(1)
            expect(voi.get_by_role('button', name='Apply VOI', exact=True)).to_be_disabled()
            expect(dialog.get_by_role('combobox', name='View From', exact=True)).to_be_disabled()
            dialog.get_by_role('button', name='Cancel Sculpt', exact=True).click()
            page.evaluate('renderSettled()')
            expect(page.get_by_label('Sculpt removal preview', exact=True)).to_have_count(0)
            expect(voi.get_by_role('button', name='Apply VOI', exact=True)).to_be_enabled()
            expect(dialog.get_by_role('combobox', name='View From', exact=True)).to_be_enabled()
            self.assertEqual(page.evaluate('rendererCounts()'), c0['counts'])
            self.assertEqual({k: v for k, v in page.evaluate('kinVolumeVr.inspect()').items() if k != 'lastRefusal'}, applied)
            # Undo Sculpt removes the eighth applied region: the refusal and Cancel added nothing to either history.
            dialog.get_by_role('button', name='Undo Sculpt', exact=True).click()
            page.evaluate('renderSettled()')
            after = page.evaluate('rendererCounts()')
            self.assertEqual([after[k] - c0['counts'][k] for k in ('preflights', 'writes', 'renders')], [1, 1, 1])
            undone = page.evaluate('kinVolumeVr.inspect()')
            self.assertEqual(undone['sculpt'], applied['sculpt'][:7])
            self.assertEqual(undone['voi'], applied['voi']);self.assertEqual(undone['voiHistoryDepth'], applied['voiHistoryDepth'])
            expect(dialog).to_be_visible()
            page.evaluate('()=>statusObserver.disconnect()')
        finally:
            page.close()


if __name__ == '__main__':
    unittest.main()
