# coding: utf-8
"""VR binding and D-A access timing: real product callbacks, controlled clocks/network.

REQ-S8-D-A -> RISK-S8-ACCESS-LATE/FALSE-CLOSE/SESSION -> AC and session cases below.
The engine fixture queues a VTK draw and copies only its flagged viewports, as Cornerstone does.
The shipped document session transport runs in every case. Only network time and the engine
are synthetic in AC cases; the loopback case verifies native ResourceTiming under a busy thread.
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
const mapper={getClippingPlanes:()=>[],removeAllClippingPlanes(){},addClippingPlane(){return true}};
const vrActor={getMapper:()=>mapper,getProperty:()=>property};
const frameLog=[],renderRequests=[],nativeFrames=[],renderer=Object.freeze({getDraw:()=>true}),shader={pending:false,compiled:false};
const vrView={id:null,suppressEvents:false,async setVolumes(){},getActors:()=>[{actor:vrActor}],getRenderer:()=>renderer,resetCamera(){},getCamera:camera,setCamera(){},setProperties(){},render(){engine.renderViewport(this.id)}};
const engine={privateViews:new Map(),_needsRender:new Set(),enableElement(config){vrView.id=config.viewportId;this.privateViews.set(config.viewportId,vrView)},getViewport(id){return this.privateViews.get(id)||views.get(id)},disableElement(id){this.privateViews.delete(id);this._needsRender.delete(id)},
  performVtkDrawCall(){for(const id of this._needsRender){if(this.privateViews.has(id)){this.drawn.add(id);if(shader.pending)shader.compiled=true;if(window.sim?.frameDuration){const ms=sim.frameDuration;sim.frameDuration=0;sim.burn(ms);}}else if(views.has(id))nativeFrames.push(id)}},
  renderViewport(id){renderRequests.push(id);this._needsRender.add(id);requestAnimationFrame(()=>{if(this.privateViews.has(id)){
    this.drawn=new Set();const at=performance.now();this.performVtkDrawCall();frameLog.push({at,drawn:this.drawn.has(id)});this._needsRender.clear();}})},
  renderViewports(ids){ids.forEach(id=>this.renderViewport(id))},render(){this.renderViewports([...this.privateViews.keys()])},resize(){this.render()},
  offscreenMultiRenderWindow:{getOpenGLRenderWindow:()=>({getViewNodeFor:()=>({get:()=>({tris:{getProgram:()=>({getCompiled:()=>shader.compiled,getLinked:()=>shader.compiled,getFragmentShader:()=>({getSource:()=>shader.compiled?'kinSculptPoint0':''})})}})})})}};
const volume={volumeId:'volume-1',loadStatus:{loaded:true},framesLoaded:2,imageIds:['frame-0','frame-1'],dimensions:[2,2,2],spacing:[1,1,1],direction:[1,0,0,0,1,0,0,0,1],imageData:{getDimensions:()=>[2,2,2],indexToWorld:([i,j,k])=>[i,j,k]}};
const alternate={...volume,volumeId:'volume-2'};
window.cornerstone={cache:{getVolume:id=>id==='volume-1'?volume:id==='volume-2'?alternate:null},getEnabledElement:element=>enabled.get(element),metaData:{get:(_,id)=>({SOPClassUID:'1.2.840.10008.5.1.4.1.1.2',Modality:'CT',SamplesPerPixel:1,PhotometricInterpretation:'MONOCHROME2',Rows:2,Columns:2,PixelSpacing:[1,1],ImagePositionPatient:[0,0,id==='frame-0'?0:1],ImageOrientationPatient:[1,0,0,0,1,0]})},Enums:{ViewportType:{VOLUME_3D:'3d'}}};
const services={viewportGridService:{getState:()=>grid,setViewportIsReady:(id,value)=>repairs.push([id,value])},cornerstoneViewportService:{getCornerstoneViewport:id=>views.get(id),resizeQueue:[],gridResizeTimeOut:null},displaySetService:{getDisplaySetByUID:()=>({StudyInstanceUID:'study-1',SeriesInstanceUID:'series-1',Modality:'CT'})}};
window.KinVolumeOrientation={intersection:()=>[0,0,0],rotate:c=>c};
window.KinVolumeSculpt={};window.KinVolumeMaskRenderer={preflight(){} };let sculptCancels=0;
window.kinCreateVolumeSculpt=({controlsPane,getOperation,render})=>{const fieldset=document.createElement('fieldset');controlsPane.append(fieldset);const apply=document.createElement('button');apply.textContent='Apply Sculpt';fieldset.append(apply);apply.onclick=()=>{const op=getOperation();op.sculptOperations=[{}];shader.pending=true;shader.compiled=false;render(op)};return {fieldset,cancel(){sculptCancels++},reset(){},dispose(){}}};
window.kinViewerJobWorkspaceState=()=>({busy:false});window.kinVolumeBatchState={busy:()=>false};window.kinMprRenderingState={busy:()=>false};

const intervalCallbacks=new Map(),nativeSetInterval=window.setInterval;window.setInterval=(fn,ms)=>{const list=intervalCallbacks.get(ms)||[];list.push(fn);intervalCallbacks.set(ms,list);return {ms,fn}};window.clearInterval=()=>{};window.tick=ms=>(intervalCallbacks.get(ms)||[]).forEach(fn=>fn());
window.mountOrientation=()=>window.kinCreateVolumeOrientation({services,selected:()=>source,live:()=>true,allowed:()=>true,owner:()=>currentOwner,host:document.querySelector('#host')});
window.openVr=async()=>document.querySelector('#kin-volume-orientation button:last-of-type').onclick();
window.closeVr=()=>document.querySelector('#kin-volume-rendering .kin-vr-close').click();
window.sourceState=()=>JSON.stringify({source,cameras:[...views.values()].map(v=>v.getCamera()),viewRefs:[...views.values()].map(v=>v.id)});
</script>
"""

ACCESS_CLOCK = r"""
window.sim={now:1,entries:[],requests:[],tasks:[],raf:[],delay:0,bodyDelay:0,jobsBodyDelay:0,
  deny:false,account:'reader',silent:false,jobsSilent:false,missingTiming:false,frameDuration:0,timerId:0};
const sim=window.sim;
Object.defineProperty(performance,'now',{value:()=>sim.now});
performance.getEntriesByName=(name)=>sim.missingTiming?[]:sim.entries.filter(e=>e.name===name);
window.requestAnimationFrame=fn=>{sim.raf.push(fn);return sim.raf.length};window.cancelAnimationFrame=()=>{};
window.ResizeObserver=class {observe(){}disconnect(){}};
const turnChannel=new MessageChannel(),turns=[];
turnChannel.port1.onmessage=()=>turns.shift()();
sim.microtasks=async()=>{for(let j=0;j<2;j++){for(let i=0;i<40;i++)await Promise.resolve();await new Promise(resolve=>{turns.push(resolve);turnChannel.port2.postMessage(0)});}};
sim.task=(fn,delay,timer=false)=>{const id=++sim.timerId;sim.tasks.push({id,at:sim.now+delay,fn,timer});return id};
window.setTimeout=(fn,ms=0)=>sim.task(fn,ms,true);
window.clearTimeout=id=>{sim.tasks=sim.tasks.filter(t=>t.id!==id)};
// This is the server side of the real transport: an unbound non-bootstrap GET is 428.
// Arrival is recorded independently of document delivery, as the browser's network service does.
window.fetch=(url,options={})=>{
  const name=new URL(String(url),location.href).href,path=new URL(name).pathname,headers=new Headers(options.headers);
  const started=sim.now,isMe=path==='/api/me';
  const record={url:name,path,at:started,session:headers.get('X-KIN-Session'),csrf:headers.get('X-KIN-CSRF')};
  sim.requests.push(record);
  let status=200,body=isMe?{kind:'member',institution:'hospital',sub:sim.account,sessionId:'S1'}:[];
  if(!record.session&&!isMe){status=428;body={code:'AUTH_SESSION_REQUIRED'};}
  else if(record.session&&record.session!=='S1'){status=409;body={code:'AUTH_SESSION_MISMATCH'};}
  else if(sim.deny){status=403;body={};}
  else if(!isMe&&[...new URL(name).searchParams].some(([k,v])=>!['mine','includeHidden'].includes(k)||!['true','false'].includes(v))){status=400;body={};}
  if(sim.silent||sim.jobsSilent&&!isMe)return new Promise(()=>{});
  const delay=sim.delay,bodyDelay=isMe?sim.bodyDelay:sim.jobsBodyDelay;
  return new Promise(resolve=>{
    let stream;
    const response=new Response(new ReadableStream({start(c){stream=c}}),{status,headers:{'Content-Type':'application/json'}});
    sim.task(()=>resolve(response),delay);
    sim.task(()=>{
      sim.entries.push({name,initiatorType:'fetch',startTime:started,responseEnd:sim.now});
      stream.enqueue(new TextEncoder().encode(JSON.stringify(body)));stream.close();
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
sim.flush=async()=>{sim.runUntil(sim.now,false);await sim.microtasks()};
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

    def page_with_vr(self, controlled=False, missing_gate=None, csp=None):
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
        for path in (MODEL, ORIENTATION, RENDERING):
            page.add_script_tag(content=path.read_text(encoding='utf-8'))
        page.evaluate("""()=>{
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

    def access_page(self):
        page = self.page_with_vr(controlled=True)
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

    def test_ac_01_timely_answer_during_30_second_frame_is_not_a_false_timeout(self):
        page = self.access_page()
        result = page.evaluate("""async()=>{
          sim.delay=1;await sim.advance(10000);sim.frame(30000);sim.frame();
          const waiting={open:sim.open(),drawn:frameLog.filter(f=>f.drawn).length};
          await sim.flush();await sim.advance(1);sim.frames();
          return {waiting,open:sim.open(),message:sim.message(),frames:frameLog,
            arrivals:sim.entries.map(e=>e.responseEnd)};
        }""")
        self.assertEqual({'open': True, 'drawn': 1}, result['waiting'])
        self.assertTrue(result['open']);self.assertEqual('', result['message'])
        self.assertEqual([10001, 40002], [f['at'] for f in result['frames'] if f['drawn']])
        self.assertIn(10002, result['arrivals'])

    def test_ac_02_consecutive_long_frames_revocation_and_silent_bound(self):
        for duration, bound in [(30000, 60000), (10000, 40000)]:
            with self.subTest(frame_ms=duration):
                page = self.access_page()
                result = page.evaluate("""async duration=>{
                  sim.jobsBodyDelay=14999;await sim.advance(10000);
                  const revokedAt=sim.now;sim.silent=true;
                  await sim.advance(14999);sim.frame(duration);sim.frame();
                  await sim.advance(Math.max(250,15000-duration));
                  return {open:sim.open(),elapsed:sim.now-revokedAt,message:sim.message(),frames:frameLog};
                }""", duration)
                self.assertFalse(result['open']);self.assertLessEqual(result['elapsed'], bound)
                self.assertIn('접근 확인 시간이', result['message'])
                self.assertEqual([25000], [f['at'] for f in result['frames'] if f['drawn']])
                print(f"AC-02 frame={duration} close={result['elapsed']} bound={bound}", flush=True)

    def test_ac_03_fourteen_second_answer_only_has_one_second_left(self):
        page = self.access_page()
        result = page.evaluate("""async()=>{
          sim.jobsBodyDelay=14000;await sim.advance(24000);sim.silent=true;sim.frame();
          await sim.advance(1000);sim.frame();return {open:sim.open(),frames:frameLog};
        }""")
        self.assertTrue(result['open'])
        self.assertEqual([{'at':24001,'drawn':True},{'at':25001,'drawn':False}], result['frames'])

    def test_ac_04_document_closes_without_an_answer(self):
        page = self.access_page()
        result = page.evaluate("""async()=>{
          sim.silent=true;await sim.advance(14999);sim.frame();await sim.advance(1);sim.frame();
          await sim.advance(9999);const before=sim.open();await sim.advance(1);
          return {before,open:sim.open(),frames:frameLog,message:sim.message()};
        }""")
        self.assertTrue(result['before']);self.assertFalse(result['open'])
        self.assertEqual([{'at':15000,'drawn':True},{'at':15001,'drawn':False}], result['frames'])
        self.assertIn('VR 접근 확인 시간이 지났습니다.', result['message'])

    def test_ac_05_refusal_and_account_change_precede_next_render(self):
        for change in ["sim.deny=true","sim.account='other-reader'","currentOwner=['hospital','other-reader']"]:
            with self.subTest(change=change):
                page = self.access_page()
                result = page.evaluate("""async change=>{
                  eval(change);await sim.advance(10000);engine.render();sim.frames();
                  return {open:sim.open(),frames:frameLog,message:sim.message()};
                }""", change)
                self.assertFalse(result['open']);self.assertEqual([], result['frames'])
                self.assertIn('닫았습니다', result['message'])

    def test_ac_06_old_operation_answers_cannot_reopen_after_owner_aba(self):
        page = self.access_page()
        result = page.evaluate("""async()=>{
          sim.delay=100;sim.deny=true;await sim.advance(10000);closeVr();
          sim.deny=false;sim.account='other-reader';currentOwner=['hospital','other-reader'];
          let opening=openVr();await sim.flush();await sim.advance(10);closeVr();await opening;
          sim.account='reader';currentOwner=['hospital','reader'];
          opening=openVr();await sim.advance(100);await opening;sim.frames();
          return {open:sim.open(),message:sim.message(),drawn:frameLog.filter(f=>f.drawn).length};
        }""")
        self.assertTrue(result['open']);self.assertEqual('', result['message'])
        self.assertGreater(result['drawn'], 0)

    def test_ac_07_two_minutes_prompt_checks_never_block_or_notify(self):
        page = self.access_page()
        result = page.evaluate("""async()=>{
          const start=sim.now;sim.delay=1;
          for(let i=0;i<7500;i++){sim.frame();await sim.advance(16);}
          return {elapsed:sim.now-start,frames:frameLog.length,blocked:frameLog.filter(f=>!f.drawn).length,
            requests:sim.requests.filter(r=>r.at<start+120000).length,message:sim.message(),open:sim.open()};
        }""")
        self.assertEqual(0, result['blocked']);self.assertEqual('', result['message']);self.assertTrue(result['open'])
        self.assertEqual(120000, result['elapsed']);self.assertEqual(7500, result['frames'])
        self.assertGreaterEqual(result['requests'], 16)
        self.assertLessEqual(result['requests'], 24, 'at most 12 GET/min in the half-open two-minute window')
        print('AC-07', result, flush=True)

    def test_ac_08_queued_viewport_engine_and_resize_check_at_frame_start(self):
        for request in ['vrView.render()','engine.renderViewport(vrView.id)',
                        'engine.renderViewports([vrView.id])','engine.render()','engine.resize()']:
            with self.subTest(request=request):
                page = self.access_page()
                result = page.evaluate("""async request=>{
                  sim.silent=true;await sim.advance(14999);eval(request);
                  await sim.advance(1);sim.frames();return {open:sim.open(),frames:frameLog};
                }""", request)
                self.assertTrue(result['open'])
                self.assertEqual([{'at':15001,'drawn':False}], result['frames'])

    def test_ac_09_known_late_body_is_refused_even_after_a_long_frame(self):
        page = self.access_page()
        result = page.evaluate("""async()=>{
          sim.jobsBodyDelay=15000;await sim.advance(10000);sim.frame(30000);
          await sim.flush();return {open:sim.open(),message:sim.message()};
        }""")
        self.assertFalse(result['open']);self.assertIn('접근 확인 시간이', result['message'])

    def test_ac_10_suspension_blocks_and_one_fresh_answer_decides(self):
        for deny in (False, True):
            with self.subTest(refused=deny):
                page = self.access_page()
                result = page.evaluate("""async deny=>{
                  sim.delay=1;await sim.advance(10000);
                  const before=sim.requests.length;sim.now+=120000;sim.deny=deny;
                  sim.frame();tick(250);sim.frame();
                  const waiting={open:sim.open(),drawn:frameLog.filter(f=>f.drawn).length,
                    newRequests:sim.requests.length-before};
                  await sim.advance(1);sim.frames();
                  return {waiting,open:sim.open(),message:sim.message(),newRequests:sim.requests.length-before};
                }""", deny)
                self.assertEqual({'open':True,'drawn':0,'newRequests':2}, result['waiting'])
                self.assertEqual(2, result['newRequests'])
                self.assertEqual(not deny, result['open'])
                if not deny:self.assertEqual('', result['message'])

    def test_ac_11_initial_check_includes_both_complete_bodies(self):
        for setup in ['sim.silent=true','sim.jobsBodyDelay=16000']:
            with self.subTest(setup=setup):
                page = self.page_with_vr(controlled=True);self.addCleanup(page.close)
                result = page.evaluate("""async setup=>{
                  eval(setup);const opening=openVr();await sim.flush();await sim.advance(14999);
                  const before=sim.open();await sim.advance(1);await opening;
                  return {before,open:sim.open(),message:sim.message(),frames:frameLog};
                }""", setup)
                self.assertTrue(result['before']);self.assertFalse(result['open'])
                self.assertEqual([], result['frames']);self.assertIn('접근 확인 시간이', result['message'])

    def test_ac_12_blocked_vr_preserves_mpr_and_close_restores_engine(self):
        page = self.access_page()
        result = page.evaluate("""async()=>{
          const before=sourceState();sim.silent=true;await sim.advance(15000);
          engine.renderViewport(vrView.id);engine._needsRender.add('axial');sim.frames();
          const blocked=frameLog.at(-1);closeVr();
          engine._needsRender.add('coronal');engine.drawn=new Set();engine.performVtkDrawCall();engine._needsRender.clear();
          sim.silent=false;const opening=openVr();await sim.flush();await opening;sim.frames();
          return {blocked,native:nativeFrames,preserved:before===sourceState(),open:sim.open(),message:sim.message()};
        }""")
        self.assertEqual({'at':15001,'drawn':False}, result['blocked'])
        self.assertEqual(['axial','coronal'], result['native']);self.assertTrue(result['preserved'])
        self.assertTrue(result['open']);self.assertEqual('', result['message'])

    def test_ac_13_access_held_sculpt_waits_for_actual_shader_frame(self):
        page = self.access_page()
        result = page.evaluate("""async()=>{
          sim.delay=100;await sim.advance(14999);sim.frame(30000);
          [...document.querySelectorAll('button')].find(b=>b.textContent==='Apply Sculpt').click();
          sim.frames();sim.frames();const waiting=sim.open();
          await sim.flush();await sim.advance(100);sim.frames();sim.frames();sim.frames();
          return {waiting,open:sim.open(),message:sim.message(),compiled:shader.compiled};
        }""")
        self.assertTrue(result['waiting']);self.assertTrue(result['open'])
        self.assertEqual('', result['message']);self.assertTrue(result['compiled'])

    def test_ac_14_missing_timing_rechecks_once_after_long_frame(self):
        for silent in (False, True):
            with self.subTest(fresh_silent=silent):
                page = self.access_page()
                result = page.evaluate("""async silent=>{
                  sim.missingTiming=true;sim.delay=1;await sim.advance(10000);sim.frame(30000);
                  const before=sim.requests.length;sim.silent=silent;await sim.flush();
                  const waiting={open:sim.open(),newRequests:sim.requests.length-before};
                  if(silent)await sim.advance(15000);else await sim.advance(1);
                  sim.frames();return {waiting,open:sim.open(),message:sim.message(),newRequests:sim.requests.length-before};
                }""", silent)
                self.assertEqual({'open':True,'newRequests':2}, result['waiting'])
                self.assertEqual(2, result['newRequests'])
                self.assertEqual(not silent, result['open'])
                if silent:self.assertIn('접근 확인 시간이', result['message'])
                else:self.assertEqual('', result['message'])

    def test_ac_15_missing_timing_is_strict_without_a_long_frame(self):
        page = self.access_page()
        result = page.evaluate("""async()=>{
          sim.missingTiming=true;sim.jobsBodyDelay=15000;await sim.advance(25000);
          return {open:sim.open(),message:sim.message(),requests:sim.requests.length};
        }""")
        self.assertFalse(result['open']);self.assertIn('접근 확인 시간이', result['message'])
        self.assertEqual(4, result['requests'])

    def test_ac_16_missing_or_unwritable_gate_refuses_before_native_open(self):
        for member in ('performVtkDrawCall','_needsRender','readonly'):
            with self.subTest(member=member):
                page = self.page_with_vr(controlled=True, missing_gate=member if member!='readonly' else None)
                self.addCleanup(page.close)
                if member=='readonly':
                    page.evaluate("Object.defineProperty(engine,'performVtkDrawCall',{writable:false})")
                page.evaluate("async()=>{const opening=openVr();await sim.flush();await opening}")
                self.assertFalse(page.evaluate('sim.open()'))
                self.assertEqual(0, page.evaluate('engine.privateViews.size'))
                self.assertIn('지원 담당자', page.evaluate('sim.message()'))
                self.assertEqual([], page.evaluate('frameLog'))

    def test_ac_17_wall_clock_changes_cannot_change_validity(self):
        page = self.access_page()
        result = page.evaluate("""async()=>{
          sim.silent=true;Date.now=()=>-900000;await sim.advance(15000);sim.frame();
          Date.now=()=>900000;await sim.advance(10000);return {open:sim.open(),frames:frameLog,message:sim.message()};
        }""")
        self.assertFalse(result['open']);self.assertEqual([{'at':15001,'drawn':False}],result['frames'])
        self.assertIn('접근 확인 시간이',result['message'])

    def test_ac_18_identity_refusal_does_not_wait_for_other_response(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          sim.account='other-reader';sim.jobsSilent=true;await sim.advance(10000);sim.frame();
          return {open:sim.open(),frames:frameLog,message:sim.message()};
        }""")
        self.assertFalse(result['open']);self.assertEqual([],result['frames'])
        self.assertIn('계정이 변경',result['message'])

    def test_ac_19_suspension_during_initial_check_and_source_loading(self):
        for loading in (False,True):
            with self.subTest(source_loading=loading):
                page=self.page_with_vr(controlled=True);self.addCleanup(page.close)
                result=page.evaluate("""async loading=>{
                  if(loading)vrView.setVolumes=()=>new Promise(resolve=>window.releaseVolume=resolve);
                  else sim.silent=true;
                  const opening=openVr();await sim.flush();
                  sim.now+=120000;sim.silent=false;sim.delay=1;tick(250);
                  const waiting={open:sim.open(),drawn:frameLog.filter(f=>f.drawn).length};
                  await sim.advance(1);if(loading)releaseVolume();await opening;sim.frames();
                  return {waiting,open:sim.open(),message:sim.message()};
                }""",loading)
                self.assertEqual({'open':True,'drawn':0},result['waiting'])
                self.assertTrue(result['open']);self.assertEqual('',result['message'])

    def test_ac_20_consecutive_30_second_frames_allow_timely_checks_without_false_close(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          sim.delay=1;await sim.advance(10000);
          for(let i=0;i<4;i++){
            sim.frame(30000);await sim.flush();await sim.advance(1);sim.frames();
          }
          return {open:sim.open(),message:sim.message(),drawn:frameLog.filter(f=>f.drawn).length};
        }""")
        self.assertTrue(result['open']);self.assertEqual('',result['message'])
        self.assertGreaterEqual(result['drawn'],4)

    def test_ac_21_unavailable_timing_api_rechecks_without_false_close(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          performance.getEntriesByName=undefined;sim.delay=1;await sim.advance(10000);sim.frame(30000);
          await sim.flush();await sim.advance(1);sim.frames();
          return {open:sim.open(),message:sim.message(),requests:sim.requests.length};
        }""")
        self.assertTrue(result['open']);self.assertEqual('',result['message'])
        self.assertEqual(6,result['requests'])

    def test_ac_22_other_request_timing_cannot_turn_a_late_answer_into_permission(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          sim.jobsBodyDelay=16000;await sim.advance(10000);
          const request=sim.requests.at(-1);
          sim.entries.push({name:request.url,initiatorType:'fetch',startTime:sim.now+1,responseEnd:sim.now+2});
          sim.frame(30000);await sim.flush();
          return {open:sim.open(),message:sim.message()};
        }""")
        self.assertFalse(result['open']);self.assertIn('접근 확인 시간이',result['message'])

    def test_ac_23_continuous_blocked_frame_requests_cannot_postpone_close(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          sim.silent=true;await sim.advance(10000);sim.frame(30000);let closedAt=null;
          for(let i=0;i<40;i++){sim.frame();await sim.advance(16);if(!sim.open()){closedAt=sim.now;break;}}
          return {open:sim.open(),closedAt,message:sim.message(),frames:frameLog};
        }""")
        self.assertFalse(result['open']);self.assertLessEqual(result['closedAt'],40267)
        self.assertIn('접근 확인 시간이',result['message'])
        self.assertTrue(all(f['at']<15001 for f in result['frames'] if f['drawn']))

    def test_ac_24_known_late_body_is_not_hidden_by_other_missing_entry(self):
        page=self.access_page()
        result=page.evaluate("""async()=>{
          const entries=performance.getEntriesByName;
          performance.getEntriesByName=(name,type)=>name.endsWith('/api/me')?[]:entries(name,type);
          sim.jobsBodyDelay=16000;await sim.advance(10000);sim.frame(30000);await sim.flush();
          return {open:sim.open(),message:sim.message(),requests:sim.requests.length};
        }""")
        self.assertFalse(result['open']);self.assertIn('접근 확인 시간이',result['message'])
        self.assertEqual(4,result['requests'])

    def test_ac_25_source_loading_keeps_original_whole_open_limit(self):
        page=self.page_with_vr(controlled=True);self.addCleanup(page.close)
        result=page.evaluate("""async()=>{
          sim.jobsBodyDelay=14000;vrView.setVolumes=()=>new Promise(()=>{});
          void openVr();await sim.flush();await sim.advance(29999);const before=sim.open();
          await sim.advance(251);return {before,open:sim.open(),message:sim.message()};
        }""")
        self.assertTrue(result['before']);self.assertFalse(result['open'])
        self.assertIn('VR 원본 확인 시간이',result['message'])

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
        result=page.evaluate("""async()=>{
          const before=sim.requests.length;await sim.advance(20000);
          document.dispatchEvent(new Event('visibilitychange'));engine.resize();sim.frames();await sim.flush();
          return {requests:sim.requests.length-before,frames:frameLog.length,open:sim.open(),message:sim.message()};
        }""")
        self.assertEqual({'requests':0,'frames':0,'open':True,'message':''},result)
        other.evaluate("release();channel.postMessage({type:'session-resumed',session:'S1',preparation:'P1'})")
        page.wait_for_function("KinWorkContext.state()==='active'")
        page.evaluate("async()=>{await sim.flush();sim.frames()}")
        self.assertTrue(page.evaluate('sim.open()'))
        self.assertEqual(4,page.evaluate('sim.requests.length'))

    def test_no_blob_worker_csp_does_not_prevent_bound_vr(self):
        csp="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'none'"
        page=self.page_with_vr(csp=csp);self.addCleanup(page.close);self.open_ready(page)
        self.assertTrue(all(r['session']=='S1' for r in page.server_state['wire']))

    def test_native_same_origin_response_end_survives_busy_document_and_full_buffer(self):
        records=[]
        class Server(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                path=urlparse(self.path).path
                if path=='/':
                    body=HARNESS.encode();kind='text/html'
                else:
                    records.append({'path':path,'session':self.headers.get('X-KIN-Session'),'csrf':self.headers.get('X-KIN-CSRF')})
                    time.sleep(.08)
                    if not self.headers.get('X-KIN-Session') and path!='/api/me':
                        self.send_response(428);self.end_headers();return
                    if self.headers.get('X-KIN-Session') and self.headers.get('X-KIN-Session')!='S1':
                        self.send_response(409);self.send_header('X-KIN-Auth-Code','AUTH_SESSION_MISMATCH');self.end_headers();return
                    body=json.dumps({'kind':'member','institution':'hospital','sub':'reader','sessionId':'S1'} if path=='/api/me' else []).encode()
                    kind='application/json'
                self.send_response(200);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(body)))
                self.end_headers();self.wfile.write(body)
        server=ThreadingHTTPServer(('127.0.0.1',0),Server)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        page=self.browser.new_page();self.addCleanup(page.close)
        page.goto(f'http://127.0.0.1:{server.server_port}/')
        self.install_session(page)
        for path in (MODEL,ORIENTATION,RENDERING):page.add_script_tag(content=path.read_text(encoding='utf-8'))
        page.evaluate("""()=>{
          window.orientation=mountOrientation();
          window.nativeIssues=[];const bound=window.fetch;
          window.fetch=(...args)=>{
            const started=performance.now(),response=bound(...args);
            nativeIssues.push({name:String(args[0]),start:started,end:performance.now()});return response;
          };
          const draw=engine.performVtkDrawCall;
          engine.performVtkDrawCall=function(){
            draw.call(this);
            if(window.busyFrame){window.busyFrame=false;window.frameBegin=performance.now();
              while(performance.now()-frameBegin<30000){}
              window.frameEnd=performance.now();}
          };
        }""")
        self.open_ready(page)
        page.wait_for_timeout(10010)
        page.evaluate("tick(250);window.busyFrame=true;vrView.render()")
        page.wait_for_function("window.frameEnd>0",timeout=45000)
        page.wait_for_function("""()=>{
          tick(250);
          return performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname.startsWith('/api/')).length>=6;
        }""")
        entries=page.evaluate("""()=>({begin:frameBegin,end:frameEnd,issues:nativeIssues,
          entries:performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname.startsWith('/api/')).map(e=>({start:e.startTime,end:e.responseEnd,name:e.name})),
          open:document.querySelector('#kin-volume-rendering').open,
          message:document.querySelector('#kin-volume-orientation [role=status]').textContent})""")
        self.assertTrue(entries['open']);self.assertEqual('',entries['message'])
        during=[e for e in entries['entries'] if entries['begin']<e['end']<entries['end']]
        self.assertEqual(2,len(during),'both real HTTP responses arrived during the synchronous draw')
        for entry in entries['entries']:
            matches=[r for r in entries['issues'] if r['name']==entry['name'] and r['start']<=entry['start']<=r['end']]
            self.assertEqual(1,len(matches),'native fetch startTime identifies its issuing interval in the document clock')
        for r in records:self.assertEqual('S1',r['session']);self.assertEqual('1',r['csrf'])
        # The browser really drops resource records when its buffer is full. The same supported
        # browser must still succeed via the conservative missing-entry path on prompt replies.
        page.evaluate("performance.clearResourceTimings();performance.setResourceTimingBufferSize(0);closeVr()")
        self.open_ready(page)
        self.assertEqual([],page.evaluate("performance.getEntriesByType('resource')"))
        print('NATIVE_TIMING',entries,flush=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
