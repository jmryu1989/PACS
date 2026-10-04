# coding: utf-8
"""Deterministic browser regression for VR source binding during layout transients.

S8-U1a (DM-U1a-01..04): the harness serves the repository's real lazily loaded VR files at /worklist/hpacs-lite/<file>,
the mask session (volume-mask-renderer.js) included, and fakes only the renderer: mapper view-specific properties (copied
on write, recorded), a GL that keeps each program's uniforms and counts complete mask writes, the renderer's shader cache
(programs keyed by their sources, compiled on first use), and a frame that builds the drawn program from the stored
fragment replacements over a fixed fragment, then reports IMAGE_RENDERED. S8-U1a fix9 (B-u): installs, mapper writes,
mask data writes and renders are counted at those boundaries; the product's install, writes and post-frame check are
never bypassed.
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
// Renderer fake for the VR mapper: view-specific properties are stored as copies and every write is recorded; a GL keeps
// each program's uniforms (a uniform write applies to the bound program only) and counts complete mask writes (kinHead set
// to a generation); the shader cache compiles a program the first time its sources are asked for; a render queues one
// frame that builds the drawn program from the stored fragment replacements and then reports IMAGE_RENDERED.
const IMAGE_RENDERED='CORNERSTONE_IMAGE_RENDERED';
const mapperLog={properties:null,writes:[]};
const mapper={getClippingPlanes:()=>[],removeAllClippingPlanes(){},addClippingPlane(){return true},
  getViewSpecificProperties:()=>structuredClone(mapperLog.properties??{}),
  setViewSpecificProperties(value){mapperLog.properties=structuredClone(value);mapperLog.writes.push(structuredClone(value));}};
const FRAGMENT='#version 300 es\nvec4 getColorForValue(vec4 tValue, vec3 posIS, vec3 tstep)\n{\n  return tValue;\n}\n';
const renderer={renders:0,frames:0,installs:0,dataWrites:0,dropReplacements:false,failNextCompile:false,failNextWrite:false,failNextRender:false,lost:false,drawn:null,queued:false,
  frameMs:0,blockMs:0,vrRequests:0,otherRequests:0,vrFrames:[]};
// A clock the test moves (S8-U1a fix12): the product reads Date.now and performance.now, and a frame of frameMs is one
// during which that much time passed with the main thread kept (no timer or answer runs inside it). blockMs keeps the
// thread for real, for the cases that need the browser's own timers and task order.
const realNow=Date.now.bind(Date),realPerf=performance.now.bind(performance);let skew=0;
Date.now=()=>realNow()+skew;performance.now=()=>realPerf()+skew;window.advance=ms=>{if(ms>0)skew+=ms;return Date.now()};
const programs=new Set(),glErrors=[];let currentProgram=null;
const gl={NO_ERROR:0,INVALID_VALUE:0x501,INVALID_OPERATION:0x502,CURRENT_PROGRAM:0x8b8d,canvas:document.createElement('canvas'),
  isContextLost:()=>renderer.lost,isProgram:handle=>!renderer.lost&&programs.has(handle),getParameter:name=>name===gl.CURRENT_PROGRAM?currentProgram:null,
  useProgram(handle){currentProgram=handle},getError:()=>glErrors.length?glErrors.shift():0,deleteProgram(handle){programs.delete(handle)},
  getUniformLocation(handle,full){const m=/^(\w+)(?:\[(\d+)\])?$/.exec(full),u=m&&handle?.uniforms?.[m[1]],i=m?.[2]===undefined?0:Number(m[2]);return u&&i<u.size?{handle,u,i}:null},
  getUniform(handle,at){return at?.handle===handle?at.u.data.slice(at.i*at.u.comps,(at.i+1)*at.u.comps):null}};
for(const name of ['uniform4i','uniform4iv','uniform4fv','uniform2fv'])gl[name]=(at,...values)=>{
  if(renderer.lost)return;
  if(!at||at.handle!==currentProgram){glErrors.push(gl.INVALID_OPERATION);return}
  if(renderer.failNextWrite&&at.u===at.handle.uniforms.kinProj){renderer.failNextWrite=false;glErrors.push(gl.INVALID_VALUE);return}
  const data=Array.from(values.length===1&&ArrayBuffer.isView(values[0])?values[0]:values);
  if(data.length%at.u.comps){glErrors.push(gl.INVALID_VALUE);return}
  at.u.data.set(data.slice(0,(at.u.size-at.i)*at.u.comps),at.i*at.u.comps);
  if(name==='uniform4i'&&at.u===at.handle.uniforms.kinHead&&data[0]>0)renderer.dataWrites++;
};
function linkProgram(fragment){
  const handle={uniforms:{}};
  for(const [,type,name,size] of fragment.matchAll(/uniform (ivec4|vec4|vec2) (\w+)(?:\[(\d+)\])?;/g)){const comps=type==='vec2'?2:4,count=size?Number(size):1;handle.uniforms[name]={comps,size:count,data:type==='ivec4'?new Int32Array(comps*count):new Float32Array(comps*count)}}
  programs.add(handle);return handle;
}
const cachePrograms={};
function cacheEntry(fragment){
  const e={compiled:false,linked:false,handle:null,getCompiled:()=>e.compiled,getLinked:()=>e.linked,getHandle:()=>e.handle,getMd5Hash:()=>fragment,get:name=>({[name]:name==='context'?gl:undefined}),
    getVertexShader:()=>({getSource:()=>'vertex',cleanup(){}}),getFragmentShader:()=>({getSource:()=>fragment,cleanup(){}}),getGeometryShader:()=>({getSource:()=>'',cleanup(){}})};
  return e;
}
const shaderCache={get:name=>({[name]:name==='shaderPrograms'?cachePrograms:undefined}),
  getShaderProgram:(vertex,fragment)=>cachePrograms[fragment]||(cachePrograms[fragment]=cacheEntry(fragment)),
  readyShaderProgram(entry){
    if(!entry.compiled){
      if(renderer.failNextCompile){renderer.failNextCompile=false;return null}
      entry.handle=linkProgram(entry.getFragmentShader().getSource());entry.compiled=entry.linked=true;
      if(entry.getFragmentShader().getSource().includes('kinHead'))renderer.installs++;
    }
    currentProgram=entry.handle;return entry;
  }};
function drawnFragment(){
  let source=FRAGMENT;if(renderer.dropReplacements)return source;
  const list=mapperLog.properties?.OpenGL?.ShaderReplacements||[];
  for(const pass of [true,false])for(const r of list)if(r.shaderType==='Fragment'&&!!r.replaceFirst===pass)source=r.replaceAll?source.split(r.originalValue).join(r.replacementValue):source.replace(r.originalValue,()=>r.replacementValue);
  return source;
}
function frame(){
  renderer.frames++;const started=Date.now();
  if(renderer.blockMs){const until=realPerf()+renderer.blockMs;while(realPerf()<until);}
  skew+=renderer.frameMs;
  const entry=shaderCache.getShaderProgram('vertex',drawnFragment(),'');renderer.drawn=shaderCache.readyShaderProgram(entry);
  renderer.vrFrames.push([started,Date.now()]);vrView.element?.dispatchEvent(new Event(IMAGE_RENDERED))}
const vrActor={getMapper:()=>mapper,getProperty:()=>property};
// The engine as the pinned one draws: a viewport's render asks its engine, the engine's three render entries flag
// viewports for the next animation frame (render() and resize() flag every viewport, the VR one included), and that frame
// draws the flagged VR viewport once.
const flagged=new Set();
function flush(){renderer.queued=false;const ids=[...flagged];flagged.clear();if(ids.includes(vrView.id)&&engine.privateViews.has(vrView.id))frame()}
function flag(ids){for(const id of ids){if(id===undefined)continue;if(id===vrView.id)renderer.vrRequests++;else renderer.otherRequests++;flagged.add(id)}if(flagged.size&&!renderer.queued){renderer.queued=true;requestAnimationFrame(flush)}}
const vrView={id:null,element:null,suppressEvents:false,async setVolumes(){},getActors:()=>[{actor:vrActor}],resetCamera(){},getCamera:camera,setCamera(){},setProperties(){},
  render(){if(renderer.failNextRender){renderer.failNextRender=false;throw Error('HARNESS RENDER FAILURE')}renderer.renders++;engine.renderViewport(this.id)}};
const windowGL={getContext:()=>gl,getShaderCache:()=>shaderCache,getViewNodeFor:m=>m===mapper?{get:()=>({tris:{getProgram:()=>renderer.drawn}})}:null};
const engine={privateViews:new Map(),enableElement(config){vrView.id=config.viewportId;vrView.element=config.element;mapperLog.properties=null;this.privateViews.set(config.viewportId,vrView)},getViewport(id){return this.privateViews.get(id)||views.get(id)},disableElement(id){this.privateViews.delete(id)},
  getViewports(){return [...views.values(),...this.privateViews.values()]},render(){flag(this.getViewports().map(v=>v.id))},renderViewports(ids){flag(ids)},renderViewport(id){flag([id])},resize(){this.render()},
  offscreenMultiRenderWindow:{getOpenGLRenderWindow:()=>windowGL}};
const volume={volumeId:'volume-1',loadStatus:{loaded:true},framesLoaded:2,imageIds:['frame-0','frame-1'],dimensions:[2,2,2],spacing:[1,1,1],direction:[1,0,0,0,1,0,0,0,1],imageData:{getDimensions:()=>[2,2,2],getSpatialExtent:()=>[0,1,0,1,0,1],indexToWorld:([i,j,k])=>[i,j,k]}};
const alternate={...volume,volumeId:'volume-2'};
window.cornerstone={cache:{getVolume:id=>id==='volume-1'?volume:id==='volume-2'?alternate:null},getEnabledElement:element=>enabled.get(element),metaData:{get:(_,id)=>({SOPClassUID:'1.2.840.10008.5.1.4.1.1.2',Modality:'CT',SamplesPerPixel:1,PhotometricInterpretation:'MONOCHROME2',Rows:2,Columns:2,PixelSpacing:[1,1],ImagePositionPatient:[0,0,id==='frame-0'?0:1],ImageOrientationPatient:[1,0,0,0,1,0]})},Enums:{ViewportType:{VOLUME_3D:'3d'},Events:{IMAGE_RENDERED}}};
const services={viewportGridService:{getState:()=>grid,setViewportIsReady:(id,value)=>repairs.push([id,value])},cornerstoneViewportService:{getCornerstoneViewport:id=>views.get(id),resizeQueue:[],gridResizeTimeOut:null},displaySetService:{getDisplaySetByUID:()=>({StudyInstanceUID:'study-1',SeriesInstanceUID:'series-1',Modality:'CT'})}};
window.KinVolumeOrientation={intersection:()=>[0,0,0],rotate:c=>c};
window.KinVolumeSculpt={};let sculptCancels=0;
window.kinCreateVolumeSculpt=({controlsPane})=>{const fieldset=document.createElement('fieldset');controlsPane.append(fieldset);return {fieldset,cancel(){sculptCancels++},reset(){},dispose(){}}};
window.kinViewerJobWorkspaceState=()=>({busy:false});window.kinVolumeBatchState={busy:()=>false};window.kinMprRenderingState={busy:()=>false};
// The server the VR's access check asks. accessAnswer names what a request gets when it is answered: 'ok', 'refused'
// (403 on the study), 'other-account' (/api/me names another account) or 'silent' (never answered); answerAfterMs > 0
// answers on a later task, as a network does. Every request is kept with the clock at its start and its answer, the
// account header it carried and whether its caller gave it up; a held request is answered by the test (answerHeld).
// deafToAbort models an answer that still arrives after its caller gave the request up.
window.accessAnswer='ok';window.answerAfterMs=0;window.holdAccess=false;window.deafToAbort=false;const accessLog=[];
window.fetch=(url,options)=>new Promise((resolve,reject)=>{
  const row={url:String(url).replace(/^.*\/api\//,'/api/'),asked:Date.now(),answered:null,status:null,aborted:false,subject:options?.headers?.['X-KIN-Subject']??null,held:false,deaf:window.deafToAbort};accessLog.push(row);
  const signal=options?.signal,aborted=()=>{row.aborted=true;if(!row.deaf)reject(new DOMException('The request was given up.','AbortError'))};
  // A request whose caller gave up before asking is never sent.
  if(signal?.aborted){accessLog.pop();reject(new DOMException('The request was given up.','AbortError'));return}
  signal?.addEventListener('abort',aborted);
  const answer=kind=>{if(row.aborted&&!row.deaf||row.answered!==null)return;const me=row.url==='/api/me',refused=kind==='refused'&&!me;row.answered=Date.now();row.status=refused?403:200;
    resolve({ok:!refused,status:row.status,json:async()=>me?{kind:'member',institution:currentOwner[0],sub:kind==='other-account'?'someone-else':currentOwner[1]}:[]})};
  row.answer=answer;
  if(window.holdAccess){row.held=true;return}
  const kind=window.accessAnswer;if(kind==='silent')return;
  if(window.answerAfterMs>0)setTimeout(()=>answer(kind),window.answerAfterMs);else answer(kind);
});
window.accessRows=()=>accessLog.map(({url,asked,answered,status,aborted,subject,held})=>({url,asked,answered,status,aborted,subject,held}));
window.answerHeld=kind=>{let count=0;for(const row of accessLog)if(row.held&&row.answered===null&&(!row.aborted||row.deaf)){row.answer(kind);count++}return count};
window.vrFrames=()=>renderer.vrFrames.map(f=>[...f]);window.engineRequests=()=>({vr:renderer.vrRequests,other:renderer.otherRequests});
window.frameTakes=(clockMs,realMs=0)=>{renderer.frameMs=clockMs;renderer.blockMs=realMs};
window.rendererCounts=()=>({installs:renderer.installs,writes:mapperLog.writes.length,data:renderer.dataWrites,renders:renderer.renders});
window.storedProperties=()=>structuredClone(mapperLog.properties);
window.lastWrite=()=>structuredClone(mapperLog.writes.at(-1)??null);
window.failNextInstall=()=>{renderer.failNextCompile=true};window.dropLinkedReplacements=value=>{renderer.dropReplacements=value};
window.failNextWrite=()=>{renderer.failNextWrite=true};window.failNextRender=()=>{renderer.failNextRender=true};
window.loseContext=()=>{renderer.lost=true;currentProgram=null;gl.canvas.dispatchEvent(new Event('webglcontextlost'))};
// Whether the frame last drawn used a program with the fixed masks (the same mark the install counter above goes by).
window.drawnMasked=()=>!!renderer.drawn&&renderer.drawn.getFragmentShader().getSource().includes('kinHead');
window.mapperProperties=()=>mapper.getViewSpecificProperties();
// Three frames after an action: the product's post-frame check runs when the frame it asked for has been reported.
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
        """FC-D3: a real Apply VOI goes through the install (the first mask of a VR; a program this context already compiled
        is reused), the mapper write of the fixed replacement (the first mask of a VR only), one mask data write, a render and
        the post-frame check."""
        voi = self.voi(page)
        if thickness is not None:
            voi.get_by_role('spinbutton', name='VOI Thickness', exact=True).fill(repr(thickness))
        requested, before, notice = self.editor_slab(page), page.evaluate('rendererCounts()'), self.notice(page).text_content()
        # The mapper gets the fixed replacement whenever it carries none: the first mask of a VR, and the first after no masks.
        first = not ((page.evaluate('storedProperties()') or {}).get('OpenGL') or {}).get('ShaderReplacements')
        voi.get_by_role('button', name='Apply VOI', exact=True).click()
        page.evaluate('renderSettled()')
        after = page.evaluate('rendererCounts()')
        expect(self.dialog(page)).to_be_visible()
        self.assertEqual(self.notice(page).text_content(), notice, 'no notice: the VR stayed open after its post-frame check')
        self.assertEqual([after[k] - before[k] for k in ('installs', 'writes', 'data', 'renders')],
                         [1 if first and before['installs'] == 0 else 0, 1 if first else 0, 1, 1])
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
            for name in ['volume-voi.js', 'volume-vr-voi.js', 'volume-vr-masks.js', 'viewer-volume-vr-voi.js', 'volume-mask-renderer.js']:
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
                # The fixed program was installed by the VOI before: a sculpt edit writes data only.
                self.assertEqual([after[k] - before[k] for k in ('installs', 'writes', 'data', 'renders')], [0, 0, 1, 1], 'sculpt %d' % (n + 1))
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
            self.assertEqual(page.evaluate('rendererCounts()'), c0['counts'], 'the refused ninth region installed, wrote and rendered nothing')
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
            self.assertEqual([after[k] - c0['counts'][k] for k in ('installs', 'writes', 'data', 'renders')], [0, 0, 1, 1])
            undone = page.evaluate('kinVolumeVr.inspect()')
            self.assertEqual(undone['sculpt'], applied['sculpt'][:7])
            self.assertEqual(undone['voi'], applied['voi']);self.assertEqual(undone['voiHistoryDepth'], applied['voiHistoryDepth'])
            expect(dialog).to_be_visible()
            page.evaluate('()=>statusObserver.disconnect()')
        finally:
            page.close()

    def test_dm_u1a_05_mask_failures_keep_the_committed_voi_and_a_context_loss_closes_only_vr(self):
        """S8-U1a fix9 (B-u) on the viewer: BU-T08 an install failure is a refusal that writes nothing and keeps VR usable;
        BU-T05 a uniform write failure or a frame failure keeps the applied VOI, its Undo history and VR open; BU-T06a a
        context loss with a request in flight closes VR with a notice that claims nothing about the MPR, writes nothing more,
        and the viewer's context-loss registry (when loaded) gets the committed VOI, never the pending one."""
        page = self.page_with_vr()
        try:
            self.open_voi_ready(page)
            voi, dialog = self.voi(page), self.dialog(page)
            status = dialog.get_by_role('status')
            # BU-T08: the first mask of this VR installs the fixed program; its failure refuses before any write.
            before = page.evaluate('rendererCounts()'); previous = status.text_content()
            page.evaluate('failNextInstall()')
            voi.get_by_role('button', name='Apply VOI', exact=True).click(); page.evaluate('renderSettled()')
            state = page.evaluate('kinVolumeVr.inspect()')
            self.assertIsNone(state['voi']); self.assertEqual(state['lastRefusal'], 'render-failed')
            self.assertIn('GPU', status.text_content()); self.assertNotEqual(status.text_content(), previous)
            after = page.evaluate('rendererCounts()')
            self.assertEqual([after[k] - before[k] for k in ('installs', 'writes', 'data')], [0, 0, 0])
            self.assertIsNone(page.evaluate('storedProperties()')); expect(dialog).to_be_visible()
            applied = self.apply_voi(page, thickness=1.0)
            self.assertEqual(applied['voiHistoryDepth'], 1)
            # BU-T05: a failed write and a failed frame each leave the applied VOI, its history and VR as they were.
            for label, inject in (('write', 'failNextWrite()'), ('frame', 'failNextRender()')):
                previous = status.text_content()
                voi.get_by_role('spinbutton', name='VOI Thickness', exact=True).fill('0.5')
                page.evaluate(inject); voi.get_by_role('button', name='Apply VOI', exact=True).click(); page.evaluate('renderSettled()')
                state = page.evaluate('kinVolumeVr.inspect()')
                self.assertEqual(state['voi'], applied['voi'], label); self.assertEqual(state['voiHistoryDepth'], 1, label)
                self.assertEqual(state['lastRefusal'], 'render-failed', label)
                self.assertTrue(status.text_content().strip(), label); self.assertNotEqual(status.text_content(), previous, label)
                expect(dialog).to_be_visible(); expect(voi.get_by_role('button', name='Undo VOI', exact=True)).to_be_enabled()
            # The session stays usable: the same edit without a fault applies.
            moved = self.apply_voi(page, thickness=0.5)
            self.assertEqual(moved['voiHistoryDepth'], 2); self.assert_near([moved['voi']['slab']['thickness']], [0.5])
        finally:
            page.close()
        # BU-T06a, with the registry a viewer-wide context-loss unit would load (feature-detected by VR).
        for name in ('context event', 'registry release'):
            with self.subTest(name=name):
                page = self.page_with_vr()
                try:
                    page.evaluate("""()=>{window.releases=[];window.kinViewerContextLoss={onContextLoss(release){window.releases.push(release);return ()=>{window.unregistered=true}}}}""")
                    self.open_voi_ready(page)
                    self.assertEqual(page.evaluate('releases.length'), 1, 'VR registered its release function')
                    committed = self.apply_voi(page, thickness=1.0)
                    notice, data = self.notice(page).text_content(), page.evaluate('rendererCounts()')['data']
                    self.voi(page).get_by_role('spinbutton', name='VOI Thickness', exact=True).fill('0.25')
                    # The pending request is written; the loss arrives before its frame.
                    kept = page.evaluate("""([name,button])=>{button.click();const pending=rendererCounts().data;
                      if(name==='context event'){loseContext();return {pending,kept:null}}
                      const kept=releases[0]();loseContext();return {pending,kept}}""",
                                         [name, self.voi(page).get_by_role('button', name='Apply VOI', exact=True).element_handle()])
                    self.assertEqual(kept['pending'], data + 1, 'the pending request was written before the loss')
                    expect(self.dialog(page)).to_be_hidden()
                    reason = self.notice(page).text_content()
                    self.assertTrue(reason.strip()); self.assertNotEqual(reason, notice); self.assertNotIn('MPR', reason)
                    self.assertTrue(page.evaluate('window.unregistered===true'), 'closing VR unregisters its release function')
                    if kept['kept'] is not None:
                        self.assertEqual(kept['kept']['voi'], committed['voi'], 'the registry gets the committed VOI, never the pending one')
                    page.evaluate('renderSettled()')
                    self.assertEqual(page.evaluate('rendererCounts()')['data'], data + 1, 'nothing is written after the loss')
                    self.assertIsNone(page.evaluate('kinVolumeVr.inspect()'))
                finally:
                    page.close()

    # S8-U1a fix12 (D542): pristine return, the requested state, the access contract and the render entry control -----
    def access_state(self, page):
        return page.evaluate("""()=>({now:Date.now(),rows:accessRows(),frames:vrFrames(),requests:engineRequests(),
          open:document.querySelector('#kin-volume-rendering').open,viewports:privateViewports()})""")

    @staticmethod
    def open_checks(state):
        return [row for row in state['rows'] if row['answered'] is None and not row['aborted']]

    @staticmethod
    def last_check(state):
        """The clock at which the newest answered check was asked (its /api/me request)."""
        return [row for row in state['rows'] if row['url'] == '/api/me' and row['answered'] is not None][-1]['asked']

    def ask_frame(self, page, thickness):
        """A frame the product starts: Apply VOI with another thickness (a mask edit, drawn through the mask session)."""
        voi = self.voi(page)
        voi.get_by_role('spinbutton', name='VOI Thickness', exact=True).fill(repr(thickness))
        voi.get_by_role('button', name='Apply VOI', exact=True).click()

    def assert_closed(self, page, notice):
        expect(self.dialog(page)).to_be_hidden()
        reason = self.notice(page).text_content()
        self.assertTrue(reason.strip()); self.assertNotEqual(reason, notice, 'the reason VR closed is shown')
        self.assertEqual(page.evaluate('privateViewports()'), 0); self.assertIsNone(page.evaluate('kinVolumeVr.inspect()'))
        return reason

    def opened_with_mask(self, page):
        self.open_voi_ready(page); self.apply_voi(page, thickness=0.75); page.evaluate('renderSettled()')
        state = self.access_state(page)
        return self.notice(page).text_content(), state, self.last_check(state)

    def test_dm_u1a_06_no_masks_gives_the_mapper_its_own_properties_and_the_next_mask_compiles_nothing(self):
        """S8-U1a fix12 E on the viewer: when the applied request masks nothing (Disable VOI without sculpt, Undo to nothing,
        Original View, Reset VR) the mapper has the properties it had before the first mask and the frame is the renderer's
        own program; a VOI alone is a mask. Coming back to a mask installs nothing again (BU-T04)."""
        page = self.page_with_vr()
        try:
            self.open_voi_ready(page); page.evaluate('renderSettled()')
            own = page.evaluate('mapperProperties()'); self.assertFalse(page.evaluate('drawnMasked()'))
            voi = self.voi(page)
            self.apply_voi(page, thickness=0.75)
            self.assertTrue(page.evaluate('drawnMasked()'), 'a VOI alone is a mask')
            self.assertNotEqual(page.evaluate('mapperProperties()'), own)

            def settled(action):
                before = page.evaluate('rendererCounts()'); action(); page.evaluate('renderSettled()')
                after = page.evaluate('rendererCounts()'); expect(self.dialog(page)).to_be_visible()
                return {k: after[k] - before[k] for k in after}

            def unmasked(label):
                self.assertEqual(page.evaluate('mapperProperties()'), own, label); self.assertFalse(page.evaluate('drawnMasked()'), label)
            original = voi.get_by_role('checkbox', name='Original View', exact=True)
            for label, off, on in (
                    ('Disable VOI', lambda: voi.get_by_role('button', name='Disable VOI', exact=True).click(), lambda: voi.get_by_role('button', name='Undo VOI', exact=True).click()),
                    ('Original View', lambda: original.check(), lambda: original.uncheck()),
                    ('Undo VOI to nothing', lambda: voi.get_by_role('button', name='Undo VOI', exact=True).click(), lambda: voi.get_by_role('button', name='Apply VOI', exact=True).click())):
                delta = settled(off); unmasked(label)
                self.assertEqual((delta['installs'], delta['data']), (0, 0), label + ': nothing compiled or written for no masks')
                delta = settled(on)
                self.assertTrue(page.evaluate('drawnMasked()'), label + ': the mask is drawn again')
                self.assertEqual(delta['installs'], 0, label + ': the fixed program was still linked')
                self.assertIsNotNone(page.evaluate('kinVolumeVr.inspect()')['voi'], label)
            settled(lambda: self.dialog(page).get_by_role('button', name='Reset VR', exact=True).click()); unmasked('Reset VR')
            state = page.evaluate('kinVolumeVr.inspect()')
            self.assertEqual((state['voi'], state['sculpt'], state['originalView'], state['voiHistoryDepth']), (None, None, False, 0))
        finally:
            page.close()

    def test_dm_u1a_07_edits_made_before_a_frame_build_on_what_was_asked_for(self):
        """S8-U1a fix12 (NT-U1a-04 LC-01, LC-07, VS-15 on the viewer): the applied state changes only with a confirmed frame,
        but an edit made before that frame builds on the request in flight and the controls show it at once. A, B, then A
        again ends at A; forty alternating moves end where they began with the history at its limit; Original View stays
        checked from the click on; a request that fails gives the controls back to what is applied."""
        page = self.page_with_vr()
        try:
            self.open_voi_ready(page); voi = self.voi(page)
            applied = self.apply_voi(page, thickness=0.75); depth = applied['voiHistoryDepth']
            thickness, apply = voi.get_by_role('spinbutton', name='VOI Thickness', exact=True), voi.get_by_role('button', name='Apply VOI', exact=True)
            edit = """([field,button,values])=>{for(const value of values){field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));button.click()}return kinVolumeVr.inspect()}"""
            during = page.evaluate(edit, [thickness.element_handle(), apply.element_handle(), ['0.5', '0.25', '0.75']])
            self.assertEqual(during['voi'], applied['voi'], 'nothing is applied before its frame')
            page.evaluate('renderSettled()'); state = page.evaluate('kinVolumeVr.inspect()')
            self.assert_near([state['voi']['slab']['thickness']], [0.75]); self.assertEqual(state['voiHistoryDepth'], depth + 3)
            expect(self.dialog(page)).to_be_visible()
            # Forty moves in one task: +0.1, -0.1, ...
            centre = state['voi']['slab']['center']
            page.evaluate("""([field,button])=>{for(let n=0;n<40;n++){field.value=n%2?'-0.1':'0.1';field.dispatchEvent(new Event('input',{bubbles:true}));button.click()}}""",
                          [voi.get_by_role('spinbutton', name='VOI Move', exact=True).element_handle(), voi.get_by_role('button', name='Move Slab', exact=True).element_handle()])
            page.evaluate('renderSettled()'); state = page.evaluate('kinVolumeVr.inspect()')
            self.assert_near(state['voi']['slab']['center'], centre); self.assertEqual(state['voiHistoryDepth'], 32)
            # Original View: checked from the click, applied with its frame.
            original = voi.get_by_role('checkbox', name='Original View', exact=True)
            at_click = page.evaluate("box=>{box.click();return {checked:box.checked,applied:kinVolumeVr.inspect().originalView}}", original.element_handle())
            self.assertEqual(at_click, {'checked': True, 'applied': False})
            expect(apply).to_be_disabled()
            page.evaluate('renderSettled()'); self.assertTrue(page.evaluate('kinVolumeVr.inspect()')['originalView']); expect(original).to_be_checked()
            # A request whose frame fails: the applied state stays and the control shows it again.
            page.evaluate("box=>{failNextRender();box.click()}", original.element_handle()); page.evaluate('renderSettled()')
            state = page.evaluate('kinVolumeVr.inspect()'); self.assertTrue(state['originalView']); self.assertEqual(state['lastRefusal'], 'render-failed')
            expect(original).to_be_checked(); expect(self.dialog(page)).to_be_visible()
            original.uncheck(); page.evaluate('renderSettled()'); self.assertFalse(page.evaluate('kinVolumeVr.inspect()')['originalView']); expect(apply).to_be_enabled()
        finally:
            page.close()

    def test_ac_01_a_check_stands_for_fifteen_seconds_from_when_it_was_asked(self):
        """AC-01 (D542 D-A): an answered check is in force for 15 s of real time counted from its question, asked with the
        account VR was opened by. Inside that time a tick asks nothing and a frame is drawn at once; after it the next
        check is asked first and the frame waits for its answer. An answer that took 10 s leaves 5 s."""
        page = self.page_with_vr()
        try:
            self.open_voi_ready(page); page.evaluate('renderSettled()'); notice = self.notice(page).text_content()
            start = self.access_state(page)
            self.assertEqual([(row['url'], row['status'], row['subject']) for row in start['rows']],
                             [('/api/me', 200, 'reader'), ('/api/studies/study-1/viewer-jobs', 200, 'reader')])
            asked = self.last_check(start)
            page.evaluate('at=>{advance(at+12000-Date.now());tick(250)}', asked); page.evaluate('renderSettled()')
            inside = self.access_state(page); self.assertEqual(len(inside['rows']), 2, 'no check inside the validity')
            self.ask_frame(page, 0.75); page.evaluate('renderSettled()')
            drawn = self.access_state(page)
            self.assertEqual((len(drawn['frames']), len(drawn['rows'])), (len(inside['frames']) + 1, 2), 'a frame inside the validity is drawn at once')
            # Past the validity the tick asks; while that answer is out, a frame waits.
            page.evaluate('at=>{holdAccess=true;advance(at+15050-Date.now());tick(250)}', asked)
            waiting = self.access_state(page); self.assertEqual(len(self.open_checks(waiting)), 1); second = self.open_checks(waiting)[0]['asked']
            self.ask_frame(page, 0.5); page.evaluate('renderSettled()')
            held = self.access_state(page)
            self.assertEqual((len(held['frames']), held['requests']['vr']), (len(drawn['frames']), waiting['requests']['vr']), 'no VR frame while the check is open')
            self.assert_near([page.evaluate('kinVolumeVr.inspect()')['voi']['slab']['thickness']], [0.75])
            # The answer comes 10 s later: the frame is drawn, and the check counts from its question.
            self.assertEqual(page.evaluate("()=>{advance(10000);return answerHeld('ok')}"), 1)
            self.assertEqual(page.evaluate("()=>answerHeld('ok')"), 1); page.evaluate('()=>{holdAccess=false}'); page.evaluate('renderSettled()')
            released = self.access_state(page); self.assertEqual(len(released['frames']), len(drawn['frames']) + 1, 'the held frame, once')
            self.assert_near([page.evaluate('kinVolumeVr.inspect()')['voi']['slab']['thickness']], [0.5])
            rows = len(released['rows'])
            page.evaluate('at=>advance(at+12000-Date.now())', second); self.ask_frame(page, 0.25); page.evaluate('renderSettled()')
            still = self.access_state(page); self.assertEqual((len(still['frames']), len(still['rows'])), (len(released['frames']) + 1, rows))
            page.evaluate('at=>advance(at+15050-Date.now())', second); self.ask_frame(page, 0.75); page.evaluate('renderSettled()')
            renewed = self.access_state(page)
            self.assertEqual((len(renewed['frames']), len(renewed['rows'])), (len(still['frames']) + 1, rows + 2), 'a frame after the validity asks first')
            # Every VR frame started under a check in force: the newest check asked before the frame was answered before
            # it too (none open), and was asked less than 15 s before it.
            rows = renewed['rows']; checks = [(me['asked'], study['answered']) for me, study in zip(rows[::2], rows[1::2])]
            self.assertTrue(all(me['url'] == '/api/me' and study['status'] == 200 for me, study in zip(rows[::2], rows[1::2])) and len(rows) % 2 == 0)
            for started, _ in renewed['frames']:
                asked_before = [check for check in checks if check[0] <= started]
                self.assertTrue(asked_before and asked_before[-1][1] <= started and started - asked_before[-1][0] < 15000, (started, asked_before[-1:]))
            expect(self.dialog(page)).to_be_visible(); self.assertEqual(self.notice(page).text_content(), notice)
        finally:
            page.close()

    def test_ac_02_a_refusal_or_another_account_closes_vr_at_the_next_check(self):
        """AC-02, AC-03: the study refuses (403), or /api/me names another account (the study is then not asked at all)."""
        for answer, urls in (('refused', ['/api/me', '/api/studies/study-1/viewer-jobs']), ('other-account', ['/api/me'])):
            with self.subTest(answer=answer):
                page = self.page_with_vr()
                try:
                    notice, before, asked = self.opened_with_mask(page)
                    page.evaluate('([at,answer])=>{accessAnswer=answer;advance(at+15050-Date.now());tick(250)}', [asked, answer])
                    self.assert_closed(page, notice)
                    after = self.access_state(page)
                    self.assertEqual([row['url'] for row in after['rows'][len(before['rows']):]], urls)
                    self.assertEqual(len(after['frames']), len(before['frames']), 'no frame after the check that ran out')
                finally:
                    page.close()

    def test_ac_03_no_answer_closes_vr_fifteen_seconds_after_the_question_on_the_clock(self):
        """AC-04: a check without an answer closes VR 15 s after it was asked, by the clock; no frame starts meanwhile and
        asking for frames or ticking does not ask a second check or move the limit."""
        page = self.page_with_vr()
        try:
            notice, before, asked = self.opened_with_mask(page)
            page.evaluate("at=>{accessAnswer='silent';advance(at+15050-Date.now());tick(250)}", asked)
            waiting = self.access_state(page); self.assertEqual(len(self.open_checks(waiting)), 1); question = self.open_checks(waiting)[0]['asked']
            self.ask_frame(page, 0.5)
            page.evaluate("()=>{for(let n=0;n<4;n++){vrView.render();engine.render();tick(250)}}"); page.evaluate('renderSettled()')
            page.evaluate('at=>{advance(at+14900-Date.now());tick(250)}', question)
            almost = self.access_state(page); expect(self.dialog(page)).to_be_visible()
            self.assertEqual([row['asked'] for row in self.open_checks(almost)], [question], 'the one check, still open')
            self.assertEqual((len(almost['frames']), almost['requests']['vr']), (len(before['frames']), waiting['requests']['vr']))
            page.evaluate('at=>{advance(at+15050-Date.now());tick(250)}', question)
            self.assert_closed(page, notice)
            self.assertEqual(len(self.access_state(page)['frames']), len(before['frames']))
        finally:
            page.close()

    def test_ac_04_during_long_frames_the_next_frame_waits_and_vr_closes_within_the_bound(self):
        """AC-05: the worst case of the 60 s bound. Access is taken away (403, another account, or the server stops answering)
        right after a check was asked; a frame of 30 s starts at the end of that check's validity. That frame was on its way
        and is drawn; the next one is not started, the check is asked first, and VR closes within validity 15 s + the frame
        + the silent limit 15 s of the event: 60 s with a 30 s frame, 40 s (LC-04) with a 10 s one."""
        for frame_ms, bound in ((30000, 60000), (10000, 40000)):
            for event in ('refused', 'other-account', 'silent'):
                with self.subTest(frame_ms=frame_ms, event=event):
                    page = self.page_with_vr()
                    try:
                        notice, before, asked = self.opened_with_mask(page)
                        page.evaluate('([ms,event])=>{frameTakes(ms);accessAnswer=event}', [frame_ms, event])
                        page.evaluate('at=>advance(at+13000-Date.now())', asked)
                        self.ask_frame(page, 0.5); page.evaluate('renderSettled()')
                        on_its_way = self.access_state(page)
                        self.assertEqual(len(on_its_way['frames']), len(before['frames']) + 1); expect(self.dialog(page)).to_be_visible()
                        self.assertGreaterEqual(on_its_way['frames'][-1][1] - on_its_way['frames'][-1][0], frame_ms)
                        # The next frame is asked for: it is not started, the check is asked first.
                        self.ask_frame(page, 0.25); page.evaluate('renderSettled()')
                        state = self.access_state(page)
                        self.assertEqual((len(state['frames']), state['requests']['vr']), (len(on_its_way['frames']), on_its_way['requests']['vr']), 'the next frame did not start')
                        question = [row['asked'] for row in state['rows'][len(on_its_way['rows']):] if row['url'] == '/api/me'][0]
                        if event == 'silent':
                            # Asking again and again, through the viewport and the engine, starts no frame and no second check.
                            expect(self.dialog(page)).to_be_visible()
                            page.evaluate("()=>{for(let n=0;n<4;n++){vrView.render();engine.render();engine.resize();tick(250)}}"); page.evaluate('renderSettled()')
                            state = self.access_state(page)
                            self.assertEqual((len(state['frames']), state['requests']['vr']), (len(on_its_way['frames']), on_its_way['requests']['vr']))
                            self.assertEqual([row['asked'] for row in self.open_checks(state)], [question])
                            page.evaluate('at=>{advance(at+14900-Date.now());vrView.render();tick(250)}', question); expect(self.dialog(page)).to_be_visible()
                            page.evaluate('at=>{advance(at+15050-Date.now());tick(250)}', question)
                        self.assert_closed(page, notice)
                        closed = self.access_state(page)
                        self.assertEqual(len(closed['frames']), len(on_its_way['frames']), 'one frame at most after access was taken away')
                        # The bound, part by part: the frame started inside the validity, took frame_ms, the check was asked
                        # at the next frame request (in the product the 250 ms tick asks; here the test's own steps pass
                        # between, and that time is taken out), and VR closed within the silent limit of that question.
                        frame_start, frame_end = on_its_way['frames'][-1]
                        self.assertLess(frame_start - asked, 15000); self.assertLess(frame_end - frame_start, frame_ms + 1000)
                        self.assertLessEqual(closed['now'] - question, 15000 + 1000)
                        self.assertLessEqual(closed['now'] - asked - (question - frame_end), bound + 1000, 'closed within the bound, counted from the taking away')
                    finally:
                        page.close()

    def test_ac_05_no_entry_starts_a_vr_frame_while_a_check_is_open_and_one_check_is_open_at_a_time(self):
        """AC-06, AC-08: with a check open, no route starts a VR frame: the viewport's render, the engine's render of all and
        of listed viewports, its resize, View From, wheel, drag, Apply VOI, Apply Display, Apply Crop. The engine still gets
        the other viewports. One check is open however often frames or ticks ask; its answer lets the held frame through
        once, and a refusal closes VR without a frame."""
        for answer in ('ok', 'refused'):
            with self.subTest(answer=answer):
                page = self.page_with_vr()
                try:
                    notice, before, asked = self.opened_with_mask(page); dialog = self.dialog(page)
                    page.evaluate('at=>{holdAccess=true;advance(at+15050-Date.now());tick(250)}', asked)
                    waiting = self.access_state(page); self.assertEqual(len(self.open_checks(waiting)), 1)
                    page.evaluate("()=>{for(let n=0;n<5;n++){vrView.render();engine.render();engine.renderViewports([vrView.id,'axial']);engine.renderViewport(vrView.id);engine.resize();tick(250)}}")
                    dialog.get_by_label('View From', exact=True).select_option('Left')
                    self.ask_frame(page, 0.5)
                    dialog.get_by_role('button', name='Apply Display', exact=True).click(); dialog.get_by_role('button', name='Apply Crop', exact=True).click()
                    x, y = page.evaluate('()=>{const r=vrView.element.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]}')
                    page.mouse.move(x, y); page.mouse.wheel(0, 120); page.mouse.down(); page.mouse.move(x + 30, y + 10, steps=3); page.mouse.up()
                    page.evaluate('renderSettled()'); page.evaluate('renderSettled()')
                    held = self.access_state(page)
                    self.assertEqual((len(held['frames']), held['requests']['vr']), (len(before['frames']), waiting['requests']['vr']), 'no VR frame through any entry')
                    self.assertGreater(held['requests']['other'], waiting['requests']['other'], 'the other viewports are still drawn')
                    self.assertEqual([row['asked'] for row in self.open_checks(held)], [row['asked'] for row in self.open_checks(waiting)], 'one check, the same one')
                    expect(dialog).to_be_visible(); self.assertEqual(self.notice(page).text_content(), notice)
                    self.assertEqual(page.evaluate("()=>answerHeld('ok')"), 1, 'the account answer')
                    self.assertEqual(page.evaluate('k=>answerHeld(k)', answer), 1, 'the study answer'); page.evaluate('renderSettled()')
                    after = self.access_state(page)
                    if answer == 'ok':
                        self.assertEqual((len(after['frames']), after['requests']['vr']), (len(held['frames']) + 1, held['requests']['vr'] + 1), 'the held frame, once')
                        expect(dialog).to_be_visible(); self.assert_near([page.evaluate('kinVolumeVr.inspect()')['voi']['slab']['thickness']], [0.5])
                    else:
                        self.assert_closed(page, notice); self.assertEqual(len(after['frames']), len(held['frames']))
                finally:
                    page.close()

    def test_ac_06_a_late_answer_of_an_earlier_vr_changes_nothing(self):
        """AC-07: an answer that arrives after its VR was closed (its caller gave the request up) writes nothing: the VR
        opened since stays as it is whatever that answer says, and still asks its own check when its own runs out."""
        for late in ('refused', 'other-account', 'ok'):
            with self.subTest(late=late):
                page = self.page_with_vr()
                try:
                    self.open_voi_ready(page); page.evaluate('renderSettled()'); asked = self.last_check(self.access_state(page))
                    page.evaluate('at=>{holdAccess=true;deafToAbort=true;advance(at+15050-Date.now());tick(250)}', asked)
                    page.evaluate('()=>{closeVr();holdAccess=false;deafToAbort=false}'); expect(self.dialog(page)).to_be_hidden()
                    self.open_voi_ready(page); self.apply_voi(page, thickness=0.75); page.evaluate('renderSettled()')
                    second, notice = self.access_state(page), self.notice(page).text_content(); own = self.last_check(second)
                    page.evaluate('at=>advance(at+10000-Date.now())', own)
                    self.assertEqual(page.evaluate('k=>answerHeld(k)', late), 1, "the earlier VR's account answer arrives now"); page.evaluate('renderSettled()')
                    after = self.access_state(page)
                    expect(self.dialog(page)).to_be_visible(); self.assertEqual(self.notice(page).text_content(), notice)
                    self.assertEqual(len(after['rows']), len(second['rows']), 'the earlier VR asks nothing more')
                    # The second VR's check still runs out 15 s after its own question.
                    page.evaluate('at=>advance(at+15050-Date.now())', own); self.ask_frame(page, 0.5); page.evaluate('renderSettled()')
                    renewed = self.access_state(page)
                    self.assertEqual(len(renewed['rows']), len(after['rows']) + 2, 'its own check, asked before the frame')
                    self.assertEqual(len(renewed['frames']), len(after['frames']) + 1); expect(self.dialog(page)).to_be_visible()
                finally:
                    page.close()

    def test_ac_07_a_frame_on_its_way_when_a_check_was_asked_restarts_that_check(self):
        """AC-09: a frame let through at the last instant of a check's validity is drawn after the next check was asked, and
        takes 30 s. That check's time went into the frame: it is given up and asked again from the frame's end, so VR stays
        open while the server answers, one check is open at a time, and the given-up check's late answer changes nothing."""
        page = self.page_with_vr()
        try:
            notice, before, asked = self.opened_with_mask(page); voi = self.voi(page)
            page.evaluate('()=>{frameTakes(30000);answerAfterMs=40;deafToAbort=true}')
            voi.get_by_role('spinbutton', name='VOI Thickness', exact=True).fill('0.5')
            page.evaluate('([at,button])=>{advance(at+14990-Date.now());button.click();advance(20);tick(250)}',
                          [asked, voi.get_by_role('button', name='Apply VOI', exact=True).element_handle()])
            page.wait_for_function("""n=>{const rows=accessRows(),last=rows[rows.length-1];
              return vrFrames().length>n&&last.url.endsWith('/viewer-jobs')&&last.answered!==null&&rows.every(r=>r.answered!==null||r.aborted)}""", arg=len(before['frames']))
            page.evaluate('renderSettled()'); page.wait_for_timeout(200); page.evaluate('()=>tick(250)')
            after = self.access_state(page); rows = after['rows'][len(before['rows']):]
            expect(self.dialog(page)).to_be_visible(); self.assertEqual(self.notice(page).text_content(), notice)
            self.assertEqual(len(after['frames']), len(before['frames']) + 1)
            frame_start, frame_end = after['frames'][-1]
            self.assertEqual([(row['url'], row['aborted']) for row in rows], [('/api/me', True), ('/api/me', False), ('/api/studies/study-1/viewer-jobs', False)])
            self.assertLessEqual(rows[0]['asked'], frame_start + 1000, 'the first check was asked before the frame was drawn')
            self.assertGreaterEqual(rows[1]['asked'], frame_end, 'and asked again once the frame was drawn')
            self.assertEqual(self.open_checks(after), [])
            self.assert_near([page.evaluate('kinVolumeVr.inspect()')['voi']['slab']['thickness']], [0.5])
        finally:
            page.close()

    def test_ac_08_two_frames_of_fifteen_real_seconds_back_to_back_keep_vr_open(self):
        """AC-10, the regression of the hosted BU-T03 close (S8-U1a fix10, run 37166005589, MX-13): a frame the product allows
        (30 s at most on software GL) that runs right after a check was asked must not close VR while the server answers.
        The browser's own timers and task order decide this, so both frames keep the thread for 15.5 s of real time and the
        answers take a task each (40 ms), as a network's do."""
        page = self.page_with_vr()
        try:
            notice, before, asked = self.opened_with_mask(page); voi = self.voi(page)
            page.evaluate('()=>{frameTakes(0,15500);answerAfterMs=40}')
            self.ask_frame(page, 0.5)
            page.wait_for_function('n=>vrFrames().length>n', arg=len(before['frames']), timeout=60000)
            voi.get_by_role('spinbutton', name='VOI Thickness', exact=True).fill('0.25')
            # The tick that was due during the frame, and the next frame asked for in the same task.
            page.evaluate('button=>{tick(250);button.click()}', voi.get_by_role('button', name='Apply VOI', exact=True).element_handle())
            page.wait_for_function('n=>vrFrames().length>n+1', arg=len(before['frames']), timeout=60000)
            # The tick due after the second frame, and every answer of the checks it and the frames asked.
            page.evaluate('renderSettled()'); page.evaluate('()=>tick(250)')
            page.wait_for_function('()=>accessRows().every(r=>r.answered!==null||r.aborted)', timeout=10000); page.evaluate('renderSettled()')
            self.assertEqual(self.notice(page).text_content(), notice, 'VR was not closed'); expect(self.dialog(page)).to_be_visible()
            self.assert_near([page.evaluate('kinVolumeVr.inspect()')['voi']['slab']['thickness']], [0.25])
            after = self.access_state(page)
            self.assertEqual(len(after['frames']), len(before['frames']) + 2); self.assertEqual(self.open_checks(after), [])
        finally:
            page.close()


if __name__ == '__main__':
    unittest.main()
