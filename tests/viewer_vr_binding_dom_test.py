# coding: utf-8
"""VR binding and D-A access timing: real product callbacks, controlled clocks/network.

REQ-S8-D-A -> RISK-S8-ACCESS-LATE/FALSE-CLOSE/SESSION -> AC and session cases below.
The engine fixture queues a VTK draw and copies only its flagged viewports, as Cornerstone does.
The shipped document session transport runs in every case. Only network time and the engine
are synthetic in AC cases; the loopback case verifies late body delivery under a busy thread.
"""
from pathlib import Path
import os
import unittest
import json
import threading
import time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse,parse_qs

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
const mapper={planes:[],props:{},getClippingPlanes(){return this.planes},removeAllClippingPlanes(){this.planes=[]},addClippingPlane(p){this.planes.push(p);return true},getViewSpecificProperties(){return this.props},setViewSpecificProperties(p){this.props=p;shader.pending=true;shader.compiled=false;}};
const vrActor={getMapper:()=>mapper,getProperty:()=>property};
const frameLog=[],renderRequests=[],nativeFrames=[],renderer=Object.freeze({getDraw:()=>true}),shader={pending:false,compiled:false};
const vrView={id:null,suppressEvents:false,async setVolumes(){},getActors:()=>[{actor:vrActor}],getRenderer:()=>renderer,resetCamera(){},camera:{...camera(),parallelProjection:true},getCamera(){return this.camera},setCamera(c){Object.assign(this.camera,c)},worldToCanvas:([i,j])=>[i*100,j*100],setProperties(){},render(){engine.renderViewport(this.id)}};
const engine={privateViews:new Map(),_needsRender:new Set(),enableElement(config){vrView.id=config.viewportId;vrView.element=config.element;const c=makeCanvas();c.style.cssText='width:100%;height:100%';config.element.append(c);this.privateViews.set(config.viewportId,vrView)},getViewport(id){return this.privateViews.get(id)||views.get(id)},disableElement(id){this.privateViews.delete(id);this._needsRender.delete(id)},
  performVtkDrawCall(){for(const id of this._needsRender){if(this.privateViews.has(id)){this.drawn.add(id);const c=vrView.element.querySelector('canvas'),g=c.getContext('2d');g.fillStyle='#ff00ff';g.fillRect(0,0,c.width,c.height);if(shader.pending)shader.compiled=true;if(window.sim?.frameDuration){const ms=sim.frameDuration;sim.frameDuration=0;sim.burn(ms);}}else if(views.has(id))nativeFrames.push(id)}},
  renderViewport(id){renderRequests.push(id);this._needsRender.add(id);if(this.frameQueued)return;this.frameQueued=true;requestAnimationFrame(()=>{this.frameQueued=false;if(this.privateViews.has(id)){
    this.drawn=new Set();const at=performance.now();(this.bypassDraw||this.performVtkDrawCall).call(this);frameLog.push({at,drawn:this.drawn.has(id)});if(this.drawn.has(id))vrView.element.dispatchEvent(new CustomEvent('CORNERSTONE_IMAGE_RENDERED'));this._needsRender.clear();}})},
  renderViewports(ids){ids.forEach(id=>this.renderViewport(id))},render(){this.renderViewports([...this.privateViews.keys()])},resize(){this.render()},
  offscreenMultiRenderWindow:{getOpenGLRenderWindow:()=>({getViewNodeFor:()=>({get:()=>({tris:{getProgram:()=>({getCompiled:()=>shader.compiled,getLinked:()=>shader.compiled,getFragmentShader:()=>({getSource:()=>shader.compiled?'kinSculptPoint0':''})})}})})})}};
const volume={volumeId:'volume-1',loadStatus:{loaded:true},framesLoaded:2,imageIds:['frame-0','frame-1'],dimensions:[2,2,2],spacing:[1,1,1],direction:[1,0,0,0,1,0,0,0,1],imageData:{getDimensions:()=>[2,2,2],getSpatialExtent:()=>[-.5,1.5,-.5,1.5,-.5,1.5],indexToWorld:([i,j,k])=>[i,j,k]}};
const alternate={...volume,volumeId:'volume-2'};
window.cornerstone={cache:{getVolume:id=>id==='volume-1'?volume:id==='volume-2'?alternate:null},getEnabledElement:element=>enabled.get(element),metaData:{get:(_,id)=>({SOPClassUID:'1.2.840.10008.5.1.4.1.1.2',Modality:'CT',SamplesPerPixel:1,PhotometricInterpretation:'MONOCHROME2',Rows:2,Columns:2,PixelSpacing:[1,1],ImagePositionPatient:[0,0,id==='frame-0'?0:1],ImageOrientationPatient:[1,0,0,0,1,0]})},Enums:{ViewportType:{VOLUME_3D:'3d'},Events:{IMAGE_RENDERED:'CORNERSTONE_IMAGE_RENDERED'}}};
const services={viewportGridService:{getState:()=>grid,setViewportIsReady:(id,value)=>repairs.push([id,value])},cornerstoneViewportService:{getCornerstoneViewport:id=>views.get(id),resizeQueue:[],gridResizeTimeOut:null},displaySetService:{getDisplaySetByUID:()=>({StudyInstanceUID:'study-1',SeriesInstanceUID:'series-1',Modality:'CT'})}};
window.KinVolumeOrientation={intersection:()=>[0,0,0],rotate:c=>c};
window.KinVolumeSculpt={};window.KinVolumeMaskRenderer={preflight(){} };let sculptCancels=0;
window.kinCreateVolumeSculpt=({controlsPane,getOperation,render})=>{const fieldset=document.createElement('fieldset');controlsPane.append(fieldset);const apply=document.createElement('button');apply.textContent='Apply Sculpt';fieldset.append(apply);apply.onclick=()=>{const op=getOperation();op.sculptOperations=[{}];shader.pending=true;shader.compiled=false;render(op)};return {fieldset,pause(){},cancel(){sculptCancels++},reset(){},dispose(){}}};
window.kinViewerJobWorkspaceState=()=>({busy:false});window.kinVolumeBatchState={busy:()=>false};window.kinMprRenderingState={busy:()=>false};

const intervalCallbacks=new Map(),nativeSetInterval=window.setInterval;window.setInterval=(fn,ms)=>{const list=intervalCallbacks.get(ms)||[];list.push(fn);intervalCallbacks.set(ms,list);return {ms,fn}};window.clearInterval=()=>{};window.tick=ms=>(intervalCallbacks.get(ms)||[]).forEach(fn=>fn());
window.mountOrientation=()=>window.kinCreateVolumeOrientation({services,selected:()=>source,live:()=>true,allowed:()=>true,owner:()=>currentOwner,host:document.querySelector('#host')});
window.openVr=async()=>document.querySelector('#kin-volume-orientation button:last-of-type').onclick();
window.closeVr=()=>document.querySelector('#kin-volume-rendering .kin-vr-close').click();
window.sourceState=()=>JSON.stringify({source,cameras:[...views.values()].map(v=>v.getCamera()),viewRefs:[...views.values()].map(v=>v.id)});
</script>
"""

ACCESS_CLOCK = r"""
window.sim={now:1,wallOffset:0,requests:[],tasks:[],raf:[],delay:0,bodyDelay:0,jobsBodyDelay:0,
  deny:false,account:'reader',silent:false,jobsSilent:false,frameDuration:0,timerId:0};
const sim=window.sim;
Object.defineProperty(performance,'now',{value:()=>sim.now});
Date.now=()=>sim.now+sim.wallOffset;
window.requestAnimationFrame=fn=>{sim.raf.push(fn);return sim.raf.length};window.cancelAnimationFrame=()=>{};
window.ResizeObserver=class {observe(){}disconnect(){}};
const turnChannel=new MessageChannel(),turns=[];
turnChannel.port1.onmessage=()=>turns.shift()();
sim.microtasks=async()=>{for(let j=0;j<2;j++){for(let i=0;i<40;i++)await Promise.resolve();await new Promise(resolve=>{turns.push(resolve);turnChannel.port2.postMessage(0)});}};
sim.task=(fn,delay,timer=false)=>{const id=++sim.timerId;sim.tasks.push({id,at:sim.now+delay,fn,timer});return id};
window.setTimeout=(fn,ms=0)=>sim.task(fn,ms,true);
window.clearTimeout=id=>{sim.tasks=sim.tasks.filter(t=>t.id!==id)};
// This is the server side of the real transport: an unbound non-bootstrap GET is 428.
window.fetch=(url,options={})=>{
  const name=new URL(String(url),location.href).href,path=new URL(name).pathname,headers=new Headers(options.headers);
  const started=sim.now,isMe=path==='/api/me';
  const record={url:name,path,at:started,session:headers.get('X-KIN-Session'),csrf:headers.get('X-KIN-CSRF')};
  sim.requests.push(record);
  if(sim.offline||sim.failJobs&&!isMe)return Promise.reject(new TypeError('Failed to fetch'));
  let status=200,body=isMe?{kind:'member',institution:'hospital',sub:sim.account,sessionId:'S1'}:[];
  if(!record.session&&!isMe){status=428;body={code:'AUTH_SESSION_REQUIRED'};}
  else if(record.session&&record.session!=='S1'){status=409;body={code:'AUTH_SESSION_MISMATCH'};}
  else if(sim.deny){status=403;body={};}
  else if(isMe&&sim.meStatus){status=sim.meStatus;body={};}
  else if(sim.httpStatus){status=sim.httpStatus;body={};}
  else if(sim.invalidBody){body=isMe?null:{};}
  else if(!isMe&&[...new URL(name).searchParams].some(([k,v])=>!['mine','includeHidden'].includes(k)||!['true','false'].includes(v))){status=400;body={};}
  if(sim.silent||sim.jobsSilent&&!isMe)return new Promise(()=>{});
  const delay=sim.delay,bodyDelay=isMe?sim.bodyDelay:sim.jobsBodyDelay;
  return new Promise(resolve=>{
    let stream;
    const response=new Response(new ReadableStream({start(c){stream=c}}),{status,headers:{'Content-Type':'application/json',...(sim.authCode?{'X-KIN-Auth-Code':sim.authCode}:{})}});
    sim.task(()=>resolve(response),delay);
    sim.task(()=>{
      stream.enqueue(new TextEncoder().encode(sim.badJson?'{':JSON.stringify(body)));stream.close();
    },delay+bodyDelay);
  });
};
sim.runUntil=(end,timers)=>{
  for(;;){
    const task=sim.tasks.filter(t=>t.at<=end&&(timers||!t.timer)).sort((a,b)=>a.at-b.at||a.id-b.id)[0];
    if(!task)break;
    sim.tasks=sim.tasks.filter(t=>t!==task);sim.now=Math.max(sim.now,task.at);task.fn();
  }
  sim.now=end;
};
// A real synchronous draw has no JS task/microtask delivery. Network arrival still occurs.
sim.burn=ms=>sim.runUntil(sim.now+ms,false);
sim.busy=ms=>sim.burn(ms);
sim.flush=async()=>{sim.runUntil(sim.now,true);await sim.microtasks();sim.runUntil(sim.now,true);await sim.microtasks()};
sim.advance=async(ms,{watch=true,timers=true}={})=>{
  const end=sim.now+ms;
  while(sim.now<end){
    const next=Math.min(end,sim.now+250);
    const due=sim.tasks.filter(t=>t.at<=next&&(timers||!t.timer)).sort((a,b)=>a.at-b.at||a.id-b.id)[0];
    if(due){sim.tasks=sim.tasks.filter(t=>t!==due);sim.now=Math.max(sim.now,due.at);due.fn();await sim.microtasks();}
    else{sim.now=next;if(watch)tick(250);await sim.flush();}
  }
  await sim.flush();
};
sim.frames=()=>{const queued=sim.raf.splice(0);queued.forEach(fn=>fn(sim.now));};
sim.frame=(duration=0)=>{sim.frameDuration=duration;engine.renderViewport(vrView.id);sim.frames()};
sim.open=()=>!!document.querySelector('#kin-volume-rendering')?.open;
sim.covered=()=>{const e=document.querySelector('#kin-volume-rendering .kin-vr-identity');return !!e&&getComputedStyle(e).visibility==='hidden'};
sim.visibility=value=>{Object.defineProperty(document,'visibilityState',{configurable:true,value});document.dispatchEvent(new Event('visibilitychange'));};
sim.message=()=>document.querySelector('#kin-volume-orientation [role=status]')?.textContent||'';
"""


class ViewerVrBindingDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(channel="chromium-headless-shell")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop()

    def page_with_vr(self, controlled=False, missing_gate=None, csp=None, real_sculpt=False):
        context = self.browser.new_context()
        self.addCleanup(context.close)
        page = context.new_page()
        state = {'session': 'S1', 'end': None, 'wire': []}
        page.server_state = state
        page.route("https://vr-binding.test/", lambda r: r.fulfill(
            body=HARNESS, content_type="text/html",
            headers={'Content-Security-Policy': csp} if csp else {}))
        def server(route):
            request = route.request
            path = urlparse(request.url).path
            headers = request.headers
            state['wire'].append({'path': path, 'session': headers.get('x-kin-session'),
                                  'csrf': headers.get('x-kin-csrf')})
            if not headers.get('x-kin-session') and path != '/api/me':
                return route.fulfill(status=428, headers={'X-KIN-Auth-Code':'AUTH_SESSION_REQUIRED'}, json={'code': 'AUTH_SESSION_REQUIRED'})
            if headers.get('x-kin-session') and headers.get('x-kin-session') != state['session']:
                return route.fulfill(status=409, headers={'X-KIN-Auth-Code':'AUTH_SESSION_MISMATCH'}, json={'code': 'AUTH_SESSION_MISMATCH'})
            if state['end']:
                status, code = state['end']
                return route.fulfill(status=status, headers={'X-KIN-Auth-Code':code}, json={'code': code})
            if path.endswith('/viewer-jobs') and any(k not in ('mine','includeHidden') or
                    len(values)!=1 or values[0] not in ('true','false')
                    for k,values in parse_qs(urlparse(request.url).query).items()):
                return route.fulfill(status=400,json={})
            route.fulfill(json={'kind': 'member', 'institution': 'hospital', 'sub': 'reader',
                                'sessionId': state['session']} if path == '/api/me' else [])
        page.route("**/api/**", server)
        page.goto("https://vr-binding.test/")
        if controlled:
            page.add_script_tag(content=ACCESS_CLOCK)
        self.install_session(page)
        if missing_gate:
            page.evaluate("key=>delete engine[key]", missing_gate)
        if real_sculpt:
            for name in ('volume-sculpt.js', 'viewer-volume-sculpt.js'):
                page.add_script_tag(content=(MODEL.parent/name).read_text(encoding='utf-8'))
        for path in (MODEL, ORIENTATION, RENDERING):
            page.add_script_tag(content=path.read_text(encoding='utf-8'))
        page.evaluate("""()=>{
          const create=window.kinCreateVolumeRendering;
          window.kinCreateVolumeRendering=args=>(window.vrControl=create(args));
          window.orientation=mountOrientation();
          KinViewerSessionBoundary.onEnd(()=>{window.documentEnded=true;orientation.dispose();});
        }""")
        return page

    def install_session(self, page):
        page.evaluate('()=>{window.unboundFetch=window.fetch.bind(window);}')
        for name in ('work-context.js', 'session-transport.js', 'viewer-resources.js', 'viewer-session.js'):
            page.add_script_tag(content=(MODEL.parent/name).read_text(encoding='utf-8'))
        page.evaluate("""async()=>{
          history.replaceState({kinViewerSession:{session:'S1',ended:false}},'');
          const boundary=KinViewerSession.connect(window);
          window.kinViewerOnEnd=run=>({close:boundary.onEnd(run)});
          await boundary.ready;
        }""")

    def open_ready(self, page):
        if page.evaluate("!!window.sim"):
            page.evaluate("async()=>{const opening=openVr();await sim.flush();await opening;}")
        else:
            page.evaluate("openVr()")
        expect(page.locator('#kin-volume-rendering')).to_have_attribute('open', '')
        expect(page.locator('#kin-volume-rendering [role=status]')).to_contain_text('VR 원본을 표시했습니다')

    def access_page(self, real_sculpt=False):
        page = self.page_with_vr(controlled=True, real_sculpt=real_sculpt)
        self.addCleanup(page.close)
        self.open_ready(page)
        page.evaluate("sim.frames();frameLog.length=0")
        return page

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

    def assert_surface(self, page, covered, outline=False):
        """Compare the composed dialog with/without patient surfaces, not a CSS token."""
        identity = page.get_by_text('CT · Patient SYNTHETIC-PID', exact=True)
        if covered:
            expect(identity).not_to_be_visible()
            expect(page.get_by_role('button', name='Close VR', exact=True)).to_be_visible()
        else:
            expect(identity).to_be_visible()
        if outline:
            self.assertEqual(1,page.get_by_label('Sculpt removal preview').count(),'unfinished draft retained')
            self.assertEqual(not covered, page.get_by_label('Sculpt removal preview').is_visible())
        clip = page.locator('#kin-volume-rendering').bounding_box()
        before = page.screenshot(clip=clip)
        saved = page.evaluate("""()=>{
          const d=document.querySelector('#kin-volume-rendering');
          const nodes=[...d.querySelectorAll('canvas,svg,.kin-vr-identity,.kin-vr-source')];
          return nodes.map(e=>{const old=e.style.opacity;e.style.opacity='0';return old});
        }""")
        try:
            blank = page.screenshot(clip=clip)
        finally:
            page.evaluate("""values=>document.querySelectorAll('#kin-volume-rendering canvas,#kin-volume-rendering svg,#kin-volume-rendering .kin-vr-identity,#kin-volume-rendering .kin-vr-source').forEach((e,i)=>e.style.opacity=values[i])""", saved)
        if covered:
            self.assertEqual(before, blank, 'no patient pixels, sculpt outline or patient identification on composed screen')
        else:
            self.assertNotEqual(before, blank, 'positive control: patient surfaces really contribute pixels')

    def test_ac_01_long_frame_covers_keeps_work_and_recovers(self):
        page=self.access_page()
        page.evaluate("""async()=>{
          document.querySelector('[aria-label="VR Opacity"]').value='45';
          sim.delay=1;await sim.advance(10000);sim.frame(30000);await sim.flush();
        }""")
        self.assertTrue(page.evaluate('sim.open()'))
        self.assert_surface(page, True)
        page.evaluate("async()=>{await sim.advance(2001);sim.frames()}")
        self.assert_surface(page, False)
        self.assertEqual('45',page.get_by_label('VR Opacity',exact=True).input_value())

    def test_ac_02_long_frames_cover_within_running_document_bounds(self):
        for duration,bound in [(30000,60000),(10000,40000)]:
            with self.subTest(frame=duration):
                page=self.access_page()
                result=page.evaluate("""async duration=>{
                  sim.jobsBodyDelay=14999;await sim.advance(10000);const revokedAt=sim.now;
                  sim.silent=true;await sim.advance(14999);sim.frame(duration);
                  while(!sim.covered()&&sim.now-revokedAt<60000)await sim.advance(250);
                  const coveredAt=sim.now;sim.frame();
                  return {open:sim.open(),covered:sim.covered(),elapsed:coveredAt-revokedAt,frames:frameLog};
                }""",duration)
                self.assertTrue(result['open']);self.assertTrue(result['covered'])
                self.assertLessEqual(result['elapsed'],bound)
                self.assertEqual([25000],[f['at'] for f in result['frames'] if f['drawn']])
                print('AC-02',duration,result['elapsed'],bound,flush=True)

    def test_ac_03_fourteen_second_body_retains_original_expiry(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          sim.jobsBodyDelay=14000;await sim.advance(24000);sim.silent=true;sim.frame();
          await sim.advance(1000);sim.frame();return {open:sim.open(),frames:frameLog};
        }""")
        self.assertTrue(result['open'])
        self.assertEqual([{'at':24001,'drawn':True},{'at':25001,'drawn':False}],result['frames'])

    def test_ac_04_silence_covers_at_thirty_seconds_never_closes(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          sim.silent=true;await sim.advance(14999);sim.frame();await sim.advance(1);sim.frame();
          await sim.advance(14999);const before=sim.covered();await sim.advance(1);
          const atLimit=sim.covered();await sim.advance(120000);
          return {before,atLimit,open:sim.open(),covered:sim.covered(),frames:frameLog};
        }""")
        self.assertFalse(result['before']);self.assertTrue(result['atLimit'])
        self.assertTrue(result['open']);self.assertTrue(result['covered'])
        self.assertEqual([{'at':15000,'drawn':True},{'at':15001,'drawn':False}],result['frames'])
        self.assert_surface(page,True)

    def test_ac_05_refusal_and_account_change_precede_next_render(self):
        for change in ["sim.deny=true","sim.account='other-reader'","sim.httpStatus=404","currentOwner=['hospital','other-reader']"]:
            with self.subTest(change=change):
                page=self.access_page()
                result=page.evaluate("""async change=>{
                  eval(change);await sim.advance(10000);engine.render();sim.frames();
                  return {open:sim.open(),frames:frameLog,message:sim.message()};
                }""",change)
                self.assertFalse(result['open']);self.assertEqual([],result['frames'])
                self.assertIn('닫았습니다',result['message'])

    def test_ac_06_old_operation_positive_or_refusal_cannot_uncover_owner_aba(self):
        for deny in (False,True):
            with self.subTest(old_refusal=deny):
                page=self.access_page()
                result=page.evaluate("""async deny=>{
                  sim.delay=100;sim.deny=deny;await sim.advance(10000);closeVr();
                  sim.deny=false;sim.account='other-reader';currentOwner=['hospital','other-reader'];
                  const otherOpening=openVr();await sim.flush();await sim.advance(10);closeVr();await otherOpening;
                  sim.account='reader';currentOwner=['hospital','reader'];sim.silent=true;void openVr();
                  await sim.advance(100);sim.frames();
                  const stale={open:sim.open(),covered:sim.covered(),views:engine.privateViews.size};
                  sim.silent=false;sim.delay=0;await sim.advance(17000);sim.frames();
                  return {stale,open:sim.open(),covered:sim.covered(),message:sim.message()};
                }""",deny)
                self.assertEqual({'open':True,'covered':True,'views':0},result['stale'])
                self.assertTrue(result['open']);self.assertFalse(result['covered'])
                self.assertEqual('',result['message'])

    def test_ac_07_two_minutes_prompt_checks_never_block_or_cover(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          const start=sim.now;sim.delay=1;let covers=0;
          for(let i=0;i<7500;i++){sim.frame();await sim.advance(16);if(sim.covered())covers++;}
          return {elapsed:sim.now-start,frames:frameLog.length,blocked:frameLog.filter(f=>!f.drawn).length,covers,
            requests:sim.requests.filter(r=>r.at<start+120000).length,message:sim.message(),open:sim.open()};
        }""")
        self.assertEqual(0,result['blocked']);self.assertEqual(0,result['covers'])
        self.assertEqual('',result['message']);self.assertTrue(result['open'])
        self.assertEqual(120000,result['elapsed']);self.assertEqual(7500,result['frames'])
        self.assertGreaterEqual(result['requests'],16);self.assertLessEqual(result['requests'],24)
        print('AC-07',result,flush=True)

    def test_ac_08_queued_engine_and_resize_paths_cannot_draw_expired(self):
        for request in ['vrView.render()','engine.renderViewport(vrView.id)','engine.renderViewports([vrView.id])','engine.render()','engine.resize()']:
            with self.subTest(request=request):
                page=self.access_page()
                result=page.evaluate("""async request=>{
                  sim.silent=true;await sim.advance(14999);eval(request);await sim.advance(1);sim.frames();
                  return {open:sim.open(),frames:frameLog};
                }""",request)
                self.assertTrue(result['open']);self.assertEqual([{'at':15001,'drawn':False}],result['frames'])

    def test_ac_09_expired_positive_cannot_restart_cover_limit(self):
        page=self.access_page()
        page.evaluate("""async()=>{
          sim.jobsBodyDelay=15000;await sim.advance(10000);sim.frame(30000);
          sim.silent=true;await sim.flush();await sim.advance(250);
        }""")
        self.assertTrue(page.evaluate('sim.open()'));self.assert_surface(page,True)

    def test_ac_10_wake_covers_before_check_then_confirmation_or_refusal(self):
        for deny in (False,True):
            with self.subTest(refusal=deny):
                page=self.access_page()
                result=page.evaluate("""async deny=>{
                  sim.now+=120000;sim.delay=1;sim.deny=deny;sim.frame();
                  const waiting={open:sim.open(),covered:sim.covered(),drawn:frameLog.at(-1).drawn};
                  await sim.advance(1);sim.frames();
                  return {waiting,open:sim.open(),covered:sim.covered()};
                }""",deny)
                self.assertEqual({'open':True,'covered':True,'drawn':False},result['waiting'])
                self.assertEqual(not deny,result['open'])
                if not deny:self.assertFalse(result['covered'])

    def test_ac_11_initial_access_waits_for_both_bodies_without_volume(self):
        for setup in ['sim.silent=true','sim.jobsBodyDelay=16000']:
            with self.subTest(setup=setup):
                page=self.page_with_vr(controlled=True)
                result=page.evaluate("""async setup=>{
                  eval(setup);void openVr();await sim.flush();await sim.advance(65000);
                  return {open:sim.open(),covered:sim.covered(),views:engine.privateViews.size,frames:frameLog};
                }""",setup)
                self.assertEqual({'open':True,'covered':True,'views':0,'frames':[]},result)
                page.evaluate("async()=>{sim.silent=false;sim.jobsBodyDelay=0;await sim.advance(18000);sim.frames()}")
                self.assert_surface(page,False)

    def test_ac_12_blocked_vr_preserves_mpr_and_close_restores_engine(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          const before=sourceState();sim.silent=true;await sim.advance(15000);
          engine.renderViewport(vrView.id);engine._needsRender.add('axial');sim.frames();
          const blocked=frameLog.at(-1);closeVr();
          engine._needsRender.add('coronal');engine.drawn=new Set();engine.performVtkDrawCall();engine._needsRender.clear();
          sim.silent=false;const opening=openVr();await sim.flush();await opening;sim.frames();
          return {blocked,native:nativeFrames,preserved:before===sourceState(),open:sim.open(),message:sim.message()};
        }""")
        self.assertEqual({'at':15001,'drawn':False},result['blocked'])
        self.assertEqual(['axial','coronal'],result['native']);self.assertTrue(result['preserved'])
        self.assertTrue(result['open']);self.assertEqual('',result['message'])

    def test_ac_13_sculpt_verification_sleeps_until_actual_resumed_frame(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          sim.offline=true;await sim.advance(16000);
          [...document.querySelectorAll('button')].find(b=>b.textContent==='Apply Sculpt').click();
          sim.frames();sim.frames();await sim.advance(50000);sim.frames();
          const waiting={open:sim.open(),covered:sim.covered(),raf:sim.raf.length,compiled:shader.compiled};
          sim.offline=false;await sim.advance(2000);const beforeFrame=shader.compiled;
          sim.frames();sim.frames();sim.frames();
          return {waiting,beforeFrame,open:sim.open(),compiled:shader.compiled,message:sim.message()};
        }""")
        self.assertEqual({'open':True,'covered':True,'raf':0,'compiled':False},result['waiting'])
        self.assertFalse(result['beforeFrame']);self.assertTrue(result['open']);self.assertTrue(result['compiled'])
        self.assertEqual('',result['message'])

    def test_ac_14_completed_frame_remains_covered_until_new_confirmation(self):
        page=self.access_page()
        page.evaluate("""async()=>{
          sim.delay=1;await sim.advance(10000);sim.frame(30000);sim.silent=true;await sim.flush();
          vrView.element.dispatchEvent(new CustomEvent('CORNERSTONE_IMAGE_RENDERED'));
        }""")
        self.assert_surface(page,True)
        page.evaluate("async()=>{sim.silent=false;await sim.advance(2001);sim.frames()}")
        self.assert_surface(page,False)

    def test_ac_15_delayed_body_timeout_keeps_one_bundle_in_flight(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          sim.jobsBodyDelay=16000;await sim.advance(10000);await sim.advance(50000);
          return {open:sim.open(),covered:sim.covered(),starts:sim.requests.filter(r=>r.path==='/api/me').map(r=>r.at)};
        }""")
        self.assertTrue(result['open']);self.assertTrue(result['covered'])
        self.assertEqual([1,10001,27001,44001],result['starts'])

    def test_ac_16_missing_or_unwritable_gate_refuses_before_native_open(self):
        for member in ('performVtkDrawCall','_needsRender','readonly'):
            with self.subTest(member=member):
                page=self.page_with_vr(controlled=True,missing_gate=member if member!='readonly' else None)
                if member=='readonly':page.evaluate("Object.defineProperty(engine,'performVtkDrawCall',{writable:false})")
                page.evaluate("async()=>{const opening=openVr();await sim.flush();await opening}")
                self.assertFalse(page.evaluate('sim.open()'));self.assertEqual(0,page.evaluate('engine.privateViews.size'))
                self.assertIn('지원 담당자',page.evaluate('sim.message()'));self.assertEqual([],page.evaluate('frameLog'))

    def test_ac_17_backward_wall_jump_cannot_extend_validity(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          sim.silent=true;sim.wallOffset=-900000;await sim.advance(15000);sim.frame();
          await sim.advance(15000);return {open:sim.open(),covered:sim.covered(),frames:frameLog};
        }""")
        self.assertTrue(result['open']);self.assertTrue(result['covered'])
        self.assertEqual([{'at':15001,'drawn':False}],result['frames'])

    def test_ac_18_one_failed_half_never_hides_refusal_of_other_half(self):
        for failure in ("sim.jobsSilent=true","sim.failJobs=true"):
            page=self.access_page()
            result=page.evaluate("""async failure=>{
              sim.account='other-reader';eval(failure);await sim.advance(10000);sim.frame();
              return {open:sim.open(),frames:frameLog,message:sim.message()};
            }""",failure)
            self.assertFalse(result['open']);self.assertEqual([],result['frames']);self.assertIn('계정이 변경',result['message'])

    def test_ac_19_sleep_during_initial_wait_differs_from_volume_preparation(self):
        for loading in (False,True):
            with self.subTest(preparing_volume=loading):
                page=self.page_with_vr(controlled=True)
                result=page.evaluate("""async loading=>{
                  if(loading)vrView.setVolumes=()=>new Promise(resolve=>window.releaseVolume=resolve);
                  else sim.silent=true;
                  void openVr();await sim.flush();sim.now+=120000;tick(250);await sim.flush();
                  return {open:sim.open(),covered:sim.covered(),message:sim.message(),frames:frameLog};
                }""",loading)
                self.assertEqual(not loading,result['open']);self.assertEqual([],result['frames'])
                if loading:self.assertIn('원본 확인 시간이',result['message'])
                else:self.assertTrue(result['covered'])

    def test_ac_20_every_recovery_draw_costs_thirty_seconds_but_not_permanent_cover(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          const draw=engine.performVtkDrawCall;
          // The cost belongs to every actual VR draw, including recovery.
          engine.performVtkDrawCall=function(){sim.frameDuration=30000;return draw.call(this)};
          sim.offline=true;await sim.advance(16000);sim.frame();await sim.advance(14000);
          sim.offline=false;await sim.advance(2000);sim.frames();
          const afterDraw={open:sim.open(),covered:sim.covered(),draws:frameLog.filter(f=>f.drawn).length};
          await sim.advance(4000);sim.frames();await sim.flush();
          const recovered={open:sim.open(),covered:sim.covered(),draws:frameLog.filter(f=>f.drawn).length};
          return {afterDraw,recovered};
        }""")
        self.assertTrue(result['afterDraw']['open']);self.assertTrue(result['afterDraw']['covered'])
        self.assertEqual({'open':True,'covered':False,'draws':1},result['recovered'])

    def test_ac_21_visibility_pagehide_time_resize_event_cannot_uncover(self):
        page=self.access_page()
        page.evaluate("""async()=>{
          sim.silent=true;sim.visibility('hidden');sim.visibility('visible');
          window.dispatchEvent(new Event('pagehide'));window.dispatchEvent(new Event('pageshow'));
          await sim.advance(60000);window.dispatchEvent(new Event('resize'));engine.resize();sim.frames();
          vrView.element.dispatchEvent(new CustomEvent('CORNERSTONE_IMAGE_RENDERED'));
        }""")
        self.assertTrue(page.evaluate('sim.open()'));self.assert_surface(page,True)

    def test_ac_22_late_one_half_cannot_borrow_other_request_success(self):
        page=self.access_page()
        page.evaluate("""async()=>{
          sim.jobsBodyDelay=16000;await sim.advance(10000);sim.frame(30000);
          sim.silent=true;await sim.flush();await sim.advance(250);
        }""")
        self.assertTrue(page.evaluate('sim.open()'));self.assert_surface(page,True)

    def test_ac_23_blocked_frame_requests_cannot_postpone_cover(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          sim.silent=true;await sim.advance(10000);sim.frame(30000);
          const atFinish=sim.covered();
          for(let i=0;i<40;i++){sim.frame();await sim.advance(16);}
          return {open:sim.open(),atFinish,covered:sim.covered(),frames:frameLog};
        }""")
        self.assertTrue(result['open']);self.assertTrue(result['atFinish']);self.assertTrue(result['covered'])
        self.assertTrue(all(f['at']<15001 for f in result['frames'] if f['drawn']))

    def test_ac_24_forward_and_restore_cannot_resurrect_pending_positive(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          sim.delay=100;await sim.advance(10000);
          sim.wallOffset+=600000;tick(250);sim.wallOffset=0;
          sim.silent=true;await sim.advance(100);sim.frame();
          return {open:sim.open(),covered:sim.covered(),drawn:frameLog.at(-1).drawn};
        }""")
        self.assertEqual({'open':True,'covered':True,'drawn':False},result)

    def test_ac_25_volume_preparation_limit_starts_after_initial_access(self):
        page=self.page_with_vr(controlled=True)
        result=page.evaluate("""async()=>{
          sim.jobsBodyDelay=14000;vrView.setVolumes=()=>new Promise(()=>{});
          void openVr();await sim.flush();await sim.advance(43999);const before=sim.open();
          await sim.advance(1);return {before,open:sim.open(),message:sim.message()};
        }""")
        self.assertTrue(result['before']);self.assertFalse(result['open']);self.assertIn('원본 확인 시간이',result['message'])

    def test_ac_26_transient_failures_and_five_second_refresh_never_cover_valid_reader(self):
        failures=['sim.offline=true','sim.httpStatus=503','sim.httpStatus=429',
                  "sim.httpStatus=403;sim.authCode='AUTH_IDP_UNAVAILABLE'",'sim.badJson=true','sim.invalidBody=true','sim.meStatus=404','sim.delay=5000']
        for failure in failures:
            with self.subTest(failure=failure):
                page=self.access_page()
                result=page.evaluate("""async failure=>{
                  document.querySelector('[aria-label="VR Opacity"]').value='45';
                  eval(failure);await sim.advance(10000);sim.frame();
                  const during={open:sim.open(),covered:sim.covered(),drawn:frameLog.at(-1).drawn};
                  sim.offline=false;sim.httpStatus=0;sim.meStatus=0;sim.authCode=null;sim.badJson=false;sim.invalidBody=false;
                  let covers=0;for(let i=0;i<80;i++){await sim.advance(250);if(sim.covered())covers++;}
                  return {during,open:sim.open(),covers,message:sim.message(),opacity:document.querySelector('[aria-label="VR Opacity"]').value};
                }""",failure)
                self.assertEqual({'open':True,'covered':False,'drawn':True},result['during'])
                self.assertTrue(result['open']);self.assertEqual(0,result['covers'])
                self.assertEqual('',result['message']);self.assertEqual('45',result['opacity'])

    def test_ac_27_failed_checks_continue_while_covered_two_seconds_after_completion(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          sim.httpStatus=503;sim.delay=5000;await sim.advance(65000);
          return {open:sim.open(),covered:sim.covered(),starts:sim.requests.filter(r=>r.path==='/api/me').map(r=>r.at)};
        }""")
        self.assertTrue(result['open']);self.assertTrue(result['covered'])
        self.assertEqual([1,*range(10001,66000,7000)],result['starts'])
        page.evaluate("async()=>{sim.httpStatus=0;sim.delay=0;await sim.advance(7000);sim.frames()}")
        self.assert_surface(page,False)

    def test_ac_28_wake_offline_five_seconds_keeps_edits_then_recovers(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          sim.now+=600000;sim.offline=true;tick(250);await sim.flush();
          for(let i=0;i<20;i++){sim.frame();await sim.advance(250);}
          const waiting={open:sim.open(),covered:sim.covered(),drawn:frameLog.filter(f=>f.drawn).length};
          sim.offline=false;await sim.advance(1000);sim.frames();
          return {waiting,open:sim.open(),covered:sim.covered(),drawn:frameLog.at(-1).drawn};
        }""")
        self.assertEqual({'open':True,'covered':True,'drawn':0},result['waiting'])
        self.assertTrue(result['open']);self.assertFalse(result['covered']);self.assertTrue(result['drawn'])

    def test_ac_29_superseded_refusal_while_covered_closes_immediately(self):
        for change in ('sim.deny=true',"sim.account='other-reader'"):
            with self.subTest(change=change):
                page=self.access_page()
                result=page.evaluate("""async change=>{
                  eval(change);sim.delay=2500;await sim.advance(10000);
                  sim.now+=600000;sim.silent=true;tick(250);
                  const covered=sim.covered();await sim.flush();sim.frame();
                  return {covered,open:sim.open(),message:sim.message(),frames:frameLog};
                }""",change)
                self.assertTrue(result['covered']);self.assertFalse(result['open'])
                self.assertIn('닫았습니다',result['message']);self.assertFalse(any(f['drawn'] for f in result['frames']))

    def test_ac_30_hidden_is_precovered_silence_stays_refusal_closes(self):
        for refusal in (True,False):
            with self.subTest(refusal=refusal):
                page=self.access_page()
                result=page.evaluate("""async refusal=>{
                  sim.delay=2500;sim.deny=refusal;sim.silent=!refusal;sim.visibility('hidden');
                  const beforeSleep=sim.covered();sim.now+=60000;tick(250);await sim.flush();
                  await sim.advance(2500,{watch:false,timers:false});
                  return {beforeSleep,open:sim.open(),covered:sim.covered(),frames:frameLog};
                }""",refusal)
                self.assertTrue(result['beforeSleep']);self.assertEqual(not refusal,result['open'])
                self.assertEqual([],result['frames'])
                if not refusal:self.assertTrue(result['covered'])

    def test_ac_31_repeated_stops_never_restart_or_release_cover(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          sim.offline=true;const states=[];
          for(let i=0;i<12;i++){sim.now+=4000;tick(250);await sim.flush();sim.frame();states.push(sim.covered());}
          return {open:sim.open(),states,frames:frameLog};
        }""")
        self.assertTrue(result['open']);self.assertEqual([False]*7+[True]*5,result['states'])
        self.assertTrue(all(f['at']<15001 for f in result['frames'] if f['drawn']))

    def test_ac_32_p1_p1b_busy_task_shows_requested_frame_without_more_input(self):
        for change in (False,True):
            page=self.access_page()
            result=page.evaluate("""async change=>{
              await sim.advance(3000);sim.busy(2100);
              if(change){const d=document.querySelector('[aria-label="View From"]');d.value='Posterior';d.onchange();}
              else vrView.render();
              sim.frames();await sim.flush();
              return {open:sim.open(),covered:sim.covered(),drawn:frameLog.filter(f=>f.drawn).length,requests:sim.requests.length};
            }""",change)
            self.assertEqual({'open':True,'covered':False,'drawn':1,'requests':2},result)

    def test_ac_33_stricter_clock_expiry_survives_clock_restoration(self):
        for setup in ('sim.wallOffset+=600000','sim.now+=600000','sim.now+=600000;sim.wallOffset-=600000'):
            page=self.access_page()
            result=page.evaluate("""async setup=>{
              sim.silent=true;eval(setup);sim.frame();const covered=sim.covered();
              sim.wallOffset=0;sim.frame();await sim.flush();
              return {open:sim.open(),covered,stillCovered:sim.covered(),frames:frameLog};
            }""",setup)
            self.assertTrue(result['open']);self.assertTrue(result['covered']);self.assertTrue(result['stillCovered'])
            self.assertFalse(any(f['drawn'] for f in result['frames']))

    def test_ac_34_expired_positive_read_after_busy_task_does_not_uncover(self):
        page=self.access_page()
        page.evaluate("""async()=>{
          sim.delay=1;await sim.advance(10000);sim.busy(20000);sim.delay=1000;
          await sim.microtasks();vrView.render();await sim.advance(1999);
        }""")
        self.assert_surface(page,True)
        page.evaluate("async()=>{await sim.advance(1501);sim.frames()}")
        self.assert_surface(page,False)

    def test_ac_35_present_but_bypassed_gate_closes_at_first_real_frame(self):
        page=self.page_with_vr(controlled=True)
        page.evaluate('()=>{engine.bypassDraw=engine.performVtkDrawCall;}');self.open_ready(page)
        result=page.evaluate("""()=>{sim.frames();return {open:sim.open(),message:sim.message(),views:engine.privateViews.size,frames:frameLog.filter(f=>f.drawn).length};}""")
        self.assertFalse(result['open']);self.assertEqual(0,result['views']);self.assertEqual(1,result['frames'])
        self.assertIn('지원 담당자',result['message'])

    def test_ac_36_resize_clears_canvas_without_implying_a_draw(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          const c=document.createElement('canvas');c.width=c.height=40;const g=c.getContext('2d');
          g.fillStyle='#fff';g.fillRect(0,0,40,40);const before=g.getImageData(20,20,1,1).data[0];
          sim.silent=true;await sim.advance(15000);c.width=c.width;engine.resize();sim.frames();
          return {before,after:g.getImageData(20,20,1,1).data[0],drawn:frameLog.at(-1).drawn,open:sim.open()};
        }""")
        self.assertEqual({'before':255,'after':0,'drawn':False,'open':True},result)

    def test_ac_37_short_pause_preserves_original_confirmation_expiry(self):
        for answer in (True,False):
            page=self.access_page()
            result=page.evaluate("""async answer=>{
              sim.delay=2500;sim.offline=!answer;await sim.advance(10000);sim.burn(2500);await sim.flush();sim.frame();
              const resumed={open:sim.open(),covered:sim.covered(),drawn:frameLog.at(-1).drawn};
              sim.silent=true;await sim.advance(answer?12500:2500);sim.frame();
              return {resumed,blocked:!frameLog.at(-1).drawn};
            }""",answer)
            self.assertEqual({'open':True,'covered':False,'drawn':True},result['resumed']);self.assertTrue(result['blocked'])

    def test_p2_slow_set_volumes_draws_without_waiting_for_refresh(self):
        page=self.page_with_vr(controlled=True)
        result=page.evaluate("""async()=>{
          vrView.setVolumes=async()=>sim.busy(2100);
          const opening=openVr();await sim.flush();await opening;sim.frames();
          return {open:sim.open(),covered:sim.covered(),frames:frameLog,requests:sim.requests.length};
        }""")
        self.assertTrue(result['open']);self.assertFalse(result['covered'])
        self.assertEqual([{'at':2101,'drawn':True}],result['frames']);self.assertEqual(2,result['requests'])

    def test_p3_hidden_failed_minute_wake_retries_at_next_wake_and_recovers(self):
        for timer_window in (0,3000):
            with self.subTest(window=timer_window):
                page=self.access_page()
                result=page.evaluate("""async timerWindow=>{
                  sim.visibility('hidden');sim.delay=50;const states=[];
                  for(let minute=1;minute<=3;minute++){
                    sim.offline=minute===2;const before=sim.requests.length;sim.now=1+minute*60000;
                    tick(250);await sim.flush();
                    if(timerWindow)await sim.advance(timerWindow,{watch:false});
                    await sim.advance(50,{watch:false,timers:false});
                    states.push({open:sim.open(),covered:sim.covered(),requests:sim.requests.length-before});
                  }
                  sim.visibility('visible');await sim.advance(2500);sim.frames();
                  return {states,open:sim.open(),covered:sim.covered()};
                }""",timer_window)
                self.assertTrue(all(s['open'] and s['covered'] and s['requests']>=2 for s in result['states']))
                self.assertTrue(result['open']);self.assertFalse(result['covered'])
                self.assert_surface(page,False)

    def test_p4_p4b_sleep_inside_task_or_frame_covers_and_preserves_edits(self):
        for inside_frame in (False,True):
            page=self.access_page()
            result=page.evaluate("""async insideFrame=>{
              document.querySelector('[aria-label="VR Opacity"]').value='45';
              sim.delay=1;await sim.advance(3000);sim.offline=true;
              if(insideFrame)sim.frame(600000);else{sim.busy(600000);tick(250);}
              const atWake={open:sim.open(),covered:sim.covered()};
              await sim.advance(5000);const offline={open:sim.open(),covered:sim.covered()};
              sim.offline=false;await sim.advance(2000);sim.frames();
              return {atWake,offline,open:sim.open(),covered:sim.covered(),opacity:document.querySelector('[aria-label="VR Opacity"]').value};
            }""",inside_frame)
            self.assertEqual({'open':True,'covered':True},result['atWake'])
            self.assertEqual({'open':True,'covered':True},result['offline'])
            self.assertTrue(result['open']);self.assertFalse(result['covered']);self.assertEqual('45',result['opacity'])

    def sculpt_draft(self,page,finish=True):
        page.get_by_label('Sculpt Tool',exact=True).select_option('Rectangle')
        page.get_by_role('button',name='Draw Region',exact=True).click()
        box=page.get_by_label('Sculpt removal preview').bounding_box()
        page.mouse.move(box['x']+box['width']*.2,box['y']+box['height']*.2);page.mouse.down()
        page.mouse.move(box['x']+box['width']*.6,box['y']+box['height']*.6)
        if finish:page.mouse.up()

    def test_cover_preserves_crop_transfer_applied_and_unfinished_sculpt_on_screen(self):
        page=self.access_page(real_sculpt=True)
        page.get_by_label('I Max',exact=True).fill('0')
        page.get_by_role('button',name='Apply Crop',exact=True).click()
        page.get_by_label('Transfer Mode',exact=True).select_option('Custom')
        page.get_by_label('Knot 1 HU',exact=True).fill('-900')
        page.get_by_label('VR Opacity',exact=True).fill('45')
        page.get_by_role('button',name='Apply Display',exact=True).click()
        self.sculpt_draft(page);page.get_by_role('button',name='Apply Sculpt',exact=True).click()
        page.evaluate('()=>{sim.frames();sim.frames();sim.frames()}')
        self.sculpt_draft(page,finish=False)
        before=page.evaluate("""()=>({
          properties:JSON.stringify(mapper.getViewSpecificProperties()),planes:mapper.getClippingPlanes().map(p=>({normal:p.getNormal(),origin:p.getOrigin()})),
          camera:vrView.getCamera(),path:document.querySelector('[data-kin-vr-sculpt] path').getAttribute('d'),
          size:[vrView.element.clientWidth,vrView.element.clientHeight],values:[...document.querySelectorAll('#kin-volume-rendering input')].map(e=>e.value)
        })""")
        self.assert_surface(page,False,outline=True)
        page.evaluate("async()=>{sim.offline=true;await sim.advance(30000)}")
        self.assert_surface(page,True,outline=True)
        page.mouse.up()
        page.evaluate("""()=>{
          const overlay=document.querySelector('[data-kin-vr-sculpt]');
          overlay.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:1,clientX:900,clientY:500}));
          document.querySelector('[aria-label="VR Opacity"]').dispatchEvent(new Event('change',{bubbles:true}));
          window.dispatchEvent(new Event('resize'));
        }""")
        after=page.evaluate("""()=>({
          properties:JSON.stringify(mapper.getViewSpecificProperties()),planes:mapper.getClippingPlanes().map(p=>({normal:p.getNormal(),origin:p.getOrigin()})),
          camera:vrView.getCamera(),path:document.querySelector('[data-kin-vr-sculpt] path').getAttribute('d'),
          size:[vrView.element.clientWidth,vrView.element.clientHeight],values:[...document.querySelectorAll('#kin-volume-rendering input')].map(e=>e.value)
        })""")
        self.assertEqual(before,after)
        page.evaluate("async()=>{sim.offline=false;await sim.advance(2000);sim.frames()}")
        self.assert_surface(page,False,outline=True)
        self.assertEqual(before['path'],page.locator('[data-kin-vr-sculpt] path').get_attribute('d'))
        page.get_by_role('button',name='Finish Region',exact=True).click()
        page.get_by_role('button',name='Apply Sculpt',exact=True).click()
        page.evaluate('()=>{sim.frames();sim.frames();sim.frames()}')
        self.assertTrue(page.evaluate('sim.open()'))
        self.assertNotEqual(before['properties'],page.evaluate('JSON.stringify(mapper.getViewSpecificProperties())'))
        self.assertEqual('45',page.get_by_label('VR Opacity',exact=True).input_value())

    def test_cover_context_priority_and_access_success_clear_only_access_reason(self):
        page=self.access_page()
        page.evaluate("""async()=>{
          sim.offline=true;await sim.advance(30000);vrControl.setContextLoss('GPU 연결이 끊어졌습니다. 복구를 기다리세요.');
          sim.offline=false;await sim.advance(2000);sim.frames();
        }""")
        self.assert_surface(page,True)
        expect(page.get_by_role('alert')).to_have_text('GPU 연결이 끊어졌습니다. 복구를 기다리세요.')
        page.evaluate("vrControl.setContextLoss(null)")
        self.assert_surface(page,False)
        page.evaluate("""async()=>{
          vrControl.setContextLoss('GPU 연결이 끊어졌습니다.');sim.offline=true;await sim.advance(30000);
          vrControl.setContextLoss(null);
        }""")
        self.assert_surface(page,True)
        expect(page.get_by_role('alert')).to_contain_text('접근')
        page.evaluate("async()=>{sim.offline=false;sim.deny=true;await sim.advance(2000)}")
        self.assertFalse(page.evaluate('sim.open()'))

    def test_cover_session_end_and_same_account_relogin_dispose_immediately(self):
        for status,code in [(401,'AUTH_SESSION_ENDED'),(409,'AUTH_SESSION_MISMATCH'),(403,'AUTH_SESSION_MISMATCH')]:
            with self.subTest(code=code,status=status):
                page=self.access_page()
                page.evaluate("""async values=>{
                  sim.offline=true;await sim.advance(30000);vrControl.setContextLoss('GPU 연결이 끊어졌습니다.');
                  sim.offline=false;[sim.httpStatus,sim.authCode]=values;await sim.advance(2000);
                }""",[status,code])
                self.assertTrue(page.evaluate('KinViewerSessionBoundary.ended()'))
                self.assertEqual(0,page.evaluate('engine.privateViews.size'))
                self.assertEqual(0,page.locator('#kin-volume-rendering').count())

    def test_expired_confirmation_cannot_revive_after_forward_then_backward_clock(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          sim.silent=true;sim.wallOffset=15000;sim.frame();sim.wallOffset=0;sim.frame();
          return {open:sim.open(),covered:sim.covered(),frames:frameLog};
        }""")
        self.assertTrue(result['open']);self.assertFalse(result['covered'])
        self.assertFalse(any(f['drawn'] for f in result['frames']))

    def test_cover_each_display_event_requires_new_confirmation(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          sim.silent=true;sim.visibility('hidden');const states=[sim.covered()];
          sim.visibility('visible');states.push(sim.covered());
          window.dispatchEvent(new Event('pagehide'));states.push(sim.covered());
          window.dispatchEvent(new Event('pageshow'));states.push(sim.covered());
          await sim.advance(60000);states.push(sim.covered());
          window.dispatchEvent(new Event('resize'));states.push(sim.covered());
          engine.resize();sim.frames();states.push(sim.covered());
          vrView.element.dispatchEvent(new CustomEvent('CORNERSTONE_IMAGE_RENDERED'));states.push(sim.covered());
          return states;
        }""")
        self.assertEqual([True]*8,result);self.assert_surface(page,True)

    def test_cover_owner_change_before_old_positive_closes(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          sim.offline=true;await sim.advance(30000);sim.offline=false;sim.delay=100;
          await sim.advance(2000);currentOwner=['hospital','other-reader'];
          await sim.advance(100);return {open:sim.open(),views:engine.privateViews.size};
        }""")
        self.assertEqual({'open':False,'views':0},result)

    def test_sculpt_resumed_shader_failure_closes_and_never_poll_spins(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          sim.offline=true;await sim.advance(16000);
          [...document.querySelectorAll('button')].find(b=>b.textContent==='Apply Sculpt').click();
          sim.frames();await sim.advance(20000);sim.frames();
          const waiting={raf:sim.raf.length,open:sim.open()};
          sim.offline=false;await sim.advance(2000);sim.frames();shader.compiled=false;sim.frames();sim.frames();
          return {waiting,open:sim.open(),message:sim.message()};
        }""")
        self.assertEqual({'raf':0,'open':True},result['waiting']);self.assertFalse(result['open'])
        self.assertIn('GPU',result['message'])

    def test_old_completed_body_cannot_uncover_new_operation(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          const bound=window.fetch;let switched=false;
          window.fetch=async(...args)=>{
            const response=await bound(...args);
            if(String(args[0]).includes('/viewer-jobs')){
              const read=response.json.bind(response);
              response.json=async()=>{
                const body=await read();
                if(!switched){switched=true;closeVr();sim.silent=true;void openVr();}
                return body;
              };
            }
            return response;
          };
          await sim.advance(10000);
          return {switched,open:sim.open(),covered:sim.covered(),views:engine.privateViews.size};
        }""")
        self.assertEqual({'switched':True,'open':True,'covered':True,'views':0},result)

    def test_session_both_access_requests_carry_binding_and_csrf_on_wire(self):
        page = self.page_with_vr();self.addCleanup(page.close);self.open_ready(page)
        wire = page.server_state['wire']
        self.assertEqual(['/api/me','/api/studies/study-1/viewer-jobs'], sorted(r['path'] for r in wire))
        for request in wire:
            self.assertEqual('S1',request['session']);self.assertEqual('1',request['csrf'])

    def test_session_same_account_relogin_in_another_tab_ends_viewer(self):
        page = self.page_with_vr();self.addCleanup(page.close);self.open_ready(page)
        other = page.context.new_page();self.addCleanup(other.close)
        other.route('**/test/relogin',lambda r:(page.server_state.update(session='S2'),r.fulfill(json={'sub':'reader','sessionId':'S2'}))[-1])
        other.goto('https://vr-binding.test/test/relogin')
        page.evaluate("()=>{closeVr();void openVr()}")
        page.wait_for_function("KinViewerSessionBoundary.ended() && window.documentEnded")
        self.assertEqual('S1',page.evaluate('KinViewerSessionBoundary.session()'))
        self.assertEqual(0,page.evaluate('engine.privateViews.size'))

    def test_session_end_answers_on_access_end_the_document(self):
        for status,code in [(401,'AUTH_SESSION_ENDED'),(409,'AUTH_SESSION_MISMATCH'),(403,'AUTH_SESSION_MISMATCH')]:
            with self.subTest(status=status):
                page=self.page_with_vr();self.addCleanup(page.close);self.open_ready(page)
                page.server_state['end']=(status,code)
                page.evaluate("()=>{closeVr();void openVr()}")
                page.wait_for_function("KinViewerSessionBoundary.ended() && window.documentEnded")
                self.assertEqual(0,page.evaluate('engine.privateViews.size'))

    def test_session_logout_preparation_holds_access_and_frames(self):
        page=self.access_page()
        page.evaluate("async()=>{sim.jobsBodyDelay=5000;await sim.advance(10000);vrControl.setContextLoss('GPU 연결이 끊어졌습니다.');}")
        other=page.context.new_page();self.addCleanup(other.close)
        other.route('https://vr-binding.test/peer',lambda r:r.fulfill(body='<p>peer</p>',content_type='text/html'))
        other.goto('https://vr-binding.test/peer')
        other.evaluate("""async()=>{
          window.channel=new BroadcastChannel('kin-session');
          await new Promise(done=>navigator.locks.request('kin-preparation:P1',()=>new Promise(release=>{
            window.release=release;done();})));
          channel.postMessage({type:'session-preparing',session:'S1',preparation:'P1'});
        }""")
        page.wait_for_function("KinWorkContext.state()==='preparing'")
        expect(page.get_by_role('alert')).to_contain_text('세션 변경')
        self.assert_surface(page,True)
        result=page.evaluate("""async()=>{
          const before=sim.requests.length;await sim.advance(20000);
          document.dispatchEvent(new Event('visibilitychange'));engine.resize();sim.frames();await sim.flush();
          return {requests:sim.requests.length-before,frames:frameLog.length,open:sim.open(),message:sim.message()};
        }""")
        self.assertEqual({'requests':0,'frames':0,'open':True,'message':''},result)
        page.evaluate('sim.jobsBodyDelay=0')
        other.evaluate("release();channel.postMessage({type:'session-resumed',session:'S1',preparation:'P1'})")
        page.wait_for_function("KinWorkContext.state()==='active'")
        page.evaluate("async()=>{await sim.flush();sim.frames()}")
        self.assert_surface(page,True)
        page.evaluate("async()=>{await sim.advance(2000);sim.frames()}")
        self.assertTrue(page.evaluate('sim.open()'))
        self.assertEqual(6,page.evaluate('sim.requests.length'))
        expect(page.get_by_role('alert')).to_have_text('GPU 연결이 끊어졌습니다.')
        page.evaluate('vrControl.setContextLoss(null)')
        self.assert_surface(page,False)

    def test_no_blob_worker_csp_does_not_prevent_bound_vr(self):
        csp="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'none'"
        page=self.page_with_vr(csp=csp);self.addCleanup(page.close);self.open_ready(page)
        self.assertTrue(all(r['session']=='S1' for r in page.server_state['wire']))

    def test_native_busy_task_automatically_displays_requested_frame(self):
        page=self.page_with_vr();self.addCleanup(page.close);self.open_ready(page)
        page.evaluate("""()=>{
          window.beforeBusyDraws=frameLog.filter(f=>f.drawn).length;
          // DevTools evaluate itself is not reported as a long task by Chromium.
          // Run the work as a document task, as real viewer callbacks run.
          setTimeout(()=>{
            const start=performance.now();while(performance.now()-start<2100){}
            tick(250);vrView.render();window.busyFinished=true;
          },0);
        }""")
        page.wait_for_function('window.busyFinished')
        page.wait_for_function('frameLog.filter(f=>f.drawn).length>beforeBusyDraws')
        expect(page.locator('#kin-volume-rendering')).to_have_attribute('open','')
        self.assertEqual(2,len(page.server_state['wire']), 'a busy task must keep the original confirmation, without a wake check')

    def test_native_busy_body_with_full_buffer_covers_then_new_answer_recovers(self):
        records=[];release=threading.Event();replacement=threading.Event()
        self.addCleanup(replacement.set);self.addCleanup(release.set)
        class Server(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                path=urlparse(self.path).path
                if path=='/':
                    body=HARNESS.encode();kind='text/html'
                elif path in ('/fill','/release'):
                    if path=='/release':
                        time.sleep(.08);release.set()
                    body=b'{}';kind='application/json'
                else:
                    records.append({'path':path,'session':self.headers.get('X-KIN-Session'),'csrf':self.headers.get('X-KIN-CSRF')})
                    index=len(records)
                    if 2<index<=4:release.wait(30)
                    if index>4:replacement.wait(30);time.sleep(1)
                    if not self.headers.get('X-KIN-Session') and path!='/api/me':
                        self.send_response(428);self.end_headers();return
                    if self.headers.get('X-KIN-Session') and self.headers.get('X-KIN-Session')!='S1':
                        self.send_response(409);self.send_header('X-KIN-Auth-Code','AUTH_SESSION_MISMATCH');self.end_headers();return
                    body=json.dumps({'kind':'member','institution':'hospital','sub':'reader','sessionId':'S1'} if path=='/api/me' else []).encode()
                    kind='application/json'
                self.send_response(200);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(body)))
                self.end_headers()
                try:self.wfile.write(body)
                except (BrokenPipeError,ConnectionResetError):pass # The timed-out HTTP client has already aborted.
        server=ThreadingHTTPServer(('127.0.0.1',0),Server)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        page=self.browser.new_page();self.addCleanup(page.close)
        page.goto(f'http://127.0.0.1:{server.server_port}/')
        page.evaluate("""async()=>{
          for(let i=0;i<26;i++)await Promise.all(Array.from({length:10},async(_,j)=>(await fetch('/fill?'+i+'-'+j)).arrayBuffer()));
        }""")
        self.assertEqual(250,page.evaluate("performance.getEntriesByType('resource').length"))
        self.install_session(page)
        for path in (MODEL,ORIENTATION,RENDERING):page.add_script_tag(content=path.read_text(encoding='utf-8'))
        page.evaluate("""()=>{
          window.orientation=mountOrientation();window.nativeObserved=[];
          window.testTimingObserver=new PerformanceObserver(list=>nativeObserved.push(...list.getEntries().filter(e=>new URL(e.name).pathname.startsWith('/api/'))));
          testTimingObserver.observe({type:'resource'});
          window.nativeIssues=[];const bound=window.fetch;
          window.fetch=(...args)=>{nativeIssues.push({name:String(args[0]),at:performance.now()});return bound(...args)};
          const draw=engine.performVtkDrawCall;
          engine.performVtkDrawCall=function(){
            draw.call(this);
            if(window.busyFrame){window.busyFrame=false;window.frameBegin=performance.now();
              void unboundFetch('/release');
              while(performance.now()-frameBegin<20000){}
              window.frameEnd=performance.now();}
          };
        }""")
        self.open_ready(page)
        page.get_by_label('VR Opacity',exact=True).fill('45')
        page.wait_for_function('nativeIssues.length===4',timeout=15000)
        page.evaluate("window.busyFrame=true;vrView.render()")
        page.wait_for_function("window.frameEnd>0",timeout=30000)
        # Only the old, now expired answer has completed. Hold the replacement on the server.
        for _ in range(50):
            self.assertFalse(page.get_by_text('CT · Patient SYNTHETIC-PID',exact=True).is_visible(),'expired native answer must not reveal the patient')
            if page.evaluate('nativeIssues.length===6'):break
            page.wait_for_timeout(100)
        self.assertEqual(6,page.evaluate('nativeIssues.length'),'a new confirmation must be requested')
        self.assert_surface(page,True)
        before=page.evaluate("frameLog.filter(f=>f.drawn).length")
        page.evaluate("vrView.render()")
        page.wait_for_function('frameLog.at(-1).drawn===false')
        self.assert_surface(page,True)
        self.assertEqual('45',page.get_by_label('VR Opacity',exact=True).input_value())
        entries=page.evaluate("""()=>({begin:frameBegin,end:frameEnd,entries:nativeObserved.map(e=>({start:e.startTime,end:e.responseEnd,name:e.name}))})""")
        self.assertEqual(2,len([e for e in entries['entries'] if entries['begin']<e['end']<entries['end']]))
        self.assertEqual([],page.evaluate("performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname.startsWith('/api/'))"))
        replacement.set()
        page.wait_for_function(f"frameLog.filter(f=>f.drawn).length>{before}",timeout=5000)
        self.assert_surface(page,False)
        self.assertEqual(6,len(records));self.assertEqual(before+1,page.evaluate("frameLog.filter(f=>f.drawn).length"))
        self.assertEqual('45',page.get_by_label('VR Opacity',exact=True).input_value())
        for request in records:self.assertEqual('S1',request['session']);self.assertEqual('1',request['csrf'])
        print('NATIVE_BUSY',entries,flush=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
