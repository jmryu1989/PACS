# coding: utf-8
"""VR binding and D-A access timing: real product callbacks, controlled clocks/network.

REQ-S8-D-A -> RISK-S8-ACCESS-LATE/FALSE-CLOSE -> AC-01..AC-13 below.
The engine fixture queues a VTK draw and copies only its flagged viewports, as Cornerstone does.
The worker fixture executes the shipped Blob source, not a second access policy model.
"""
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
const frameLog=[],renderRequests=[],nativeFrames=[],renderer=Object.freeze({getDraw:()=>true}),shader={pending:false,compiled:false};
const vrView={id:null,suppressEvents:false,async setVolumes(){},getActors:()=>[{actor:vrActor}],getRenderer:()=>renderer,resetCamera(){},getCamera:camera,setCamera(){},setProperties(){},render(){engine.renderViewport(this.id)}};
const engine={privateViews:new Map(),_needsRender:new Set(),enableElement(config){vrView.id=config.viewportId;this.privateViews.set(config.viewportId,vrView)},getViewport(id){return this.privateViews.get(id)||views.get(id)},disableElement(id){this.privateViews.delete(id);this._needsRender.delete(id)},
  performVtkDrawCall(){for(const id of this._needsRender){if(this.privateViews.has(id)){this.drawn.add(id);if(shader.pending)shader.compiled=true;}else if(views.has(id))nativeFrames.push(id)}},
  renderViewport(id){renderRequests.push(id);this._needsRender.add(id);requestAnimationFrame(()=>{if(this.privateViews.has(id)){
    this.drawn=new Set();this.performVtkDrawCall();frameLog.push({at:Date.now(),drawn:this.drawn.has(id)});this._needsRender.clear();}})},
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
window.fetch=async url=>({ok:true,json:async()=>url.endsWith('/api/me')?{kind:'member',institution:'hospital',sub:'reader'}:[]});
const intervalCallbacks=new Map(),nativeSetInterval=window.setInterval;window.setInterval=(fn,ms)=>{const list=intervalCallbacks.get(ms)||[];list.push(fn);intervalCallbacks.set(ms,list);return {ms,fn}};window.clearInterval=()=>{};window.tick=ms=>(intervalCallbacks.get(ms)||[]).forEach(fn=>fn());
window.mountOrientation=()=>window.kinCreateVolumeOrientation({services,selected:()=>source,live:()=>true,allowed:()=>true,owner:()=>currentOwner,host:document.querySelector('#host')});
window.openVr=async()=>document.querySelector('#kin-volume-orientation button:last-of-type').onclick();
window.closeVr=()=>document.querySelector('#kin-volume-rendering .kin-vr-close').click();
window.sourceState=()=>JSON.stringify({source,cameras:[...views.values()].map(v=>v.getCamera()),viewRefs:[...views.values()].map(v=>v.id)});
</script>
"""

ACCESS_CLOCK = r"""
window.sim={now:0,wallOffset:0,messages:[],history:[],jobs:[],requests:[],tasks:[],raf:[],workers:[],
  delay:0,bodyDelay:0,jobsBodyDelay:0,deny:false,account:'reader',silent:false,holdMessages:false,timerId:0};
const sim=window.sim;
Date.now=()=>sim.now+sim.wallOffset;
Object.defineProperty(performance,'timeOrigin',{value:0});Object.defineProperty(performance,'now',{value:()=>sim.now});
window.requestAnimationFrame=fn=>{sim.raf.push(fn);return sim.raf.length};window.cancelAnimationFrame=()=>{};
// Layout is outside this clock's subject. Native resize requests are exercised explicitly below.
window.ResizeObserver=class {observe(){}disconnect(){}};
const blobs=new Map(),createURL=URL.createObjectURL.bind(URL),revokeURL=URL.revokeObjectURL.bind(URL);
URL.createObjectURL=blob=>{const url=createURL(blob);blobs.set(url,blob);return url};
URL.revokeObjectURL=url=>{blobs.delete(url);revokeURL(url)};
sim.microtasks=async()=>{for(let i=0;i<30;i++)await Promise.resolve()};
sim.task=(fn,delay,timer=false)=>{const id=++sim.timerId;sim.tasks.push({id,at:sim.now+delay,fn,timer});return id};
sim.clear=id=>{sim.tasks=sim.tasks.filter(t=>t.id!==id)};
sim.network=async(url,options)=>{
  sim.requests.push({url,at:sim.now,subject:options.headers['X-KIN-Subject'],credentials:options.credentials,cache:options.cache});
  const plan={delay:sim.delay,bodyDelay:url.endsWith('/viewer-jobs')?sim.jobsBodyDelay:sim.bodyDelay,deny:sim.deny,account:sim.account,silent:sim.silent};
  const wait=delay=>delay?new Promise(resolve=>sim.task(resolve,delay)):Promise.resolve();
  if(plan.silent)return new Promise(()=>{});
  await wait(plan.delay);
  return {ok:!plan.deny,json:async()=>{await wait(plan.bodyDelay);return url.endsWith('/api/me')?{kind:'member',institution:'hospital',sub:plan.account}:[]}};
};
window.Worker=class {
  constructor(url){
    this.terminated=false;sim.workers.push(this);const blob=blobs.get(url);
    const scope={postMessage:data=>{const message={worker:this,data:structuredClone(data)};sim.history.push(message);sim.messages.push(message);if(!sim.holdMessages)sim.deliver()}};
    this.ready=blob.text().then(code=>{new Function('self','fetch','Date','performance','setTimeout','clearTimeout',code)(scope,sim.network,Date,performance,(fn,ms)=>sim.task(fn,ms,true),sim.clear);this.scope=scope});
  }
  postMessage(data){sim.jobs.push(structuredClone(data));this.ready.then(()=>{if(!this.terminated)this.scope.onmessage({data:structuredClone(data)})})}
  terminate(){this.terminated=true}
};
sim.deliver=()=>{while(sim.messages.length){const {worker,data}=sim.messages.shift();if(!worker.terminated)worker.onmessage?.({data})}};
sim.advance=async(ms,{deliver=true,timers=true}={})=>{
  const end=sim.now+ms;sim.holdMessages=!deliver;await sim.microtasks();
  while(true){const task=sim.tasks.filter(t=>t.at<=end&&(timers||!t.timer)).sort((a,b)=>a.at-b.at||a.id-b.id)[0];if(!task)break;
    sim.tasks=sim.tasks.filter(t=>t!==task);sim.now=Math.max(sim.now,task.at);task.fn();await sim.microtasks();}
  sim.now=end;await sim.microtasks();if(deliver)sim.deliver();
};
sim.frames=()=>{const queued=sim.raf.splice(0);queued.forEach(fn=>fn(sim.now));};
sim.frame=()=>{engine.renderViewport(vrView.id);sim.frames()};
sim.flush=async()=>{await sim.microtasks();sim.deliver();await sim.microtasks()};
sim.open=()=>document.querySelector('#kin-volume-rendering').open;
sim.message=()=>document.querySelector('#kin-volume-orientation [role=status]').textContent;
"""


class ViewerVrBindingDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(channel="chromium-headless-shell")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop()

    def page_with_vr(self, controlled=False):
        page = self.browser.new_page()
        page.route("https://vr-binding.test/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.route("**/api/me", lambda route: route.fulfill(json={"kind": "member", "institution": "hospital", "sub": "reader"}))
        page.route("**/api/studies/*/viewer-jobs", lambda route: route.fulfill(json=[]))
        page.goto("https://vr-binding.test/")
        if controlled:
            page.add_script_tag(content=ACCESS_CLOCK)
        page.add_script_tag(path=str(MODEL));page.add_script_tag(path=str(ORIENTATION));page.add_script_tag(path=str(RENDERING))
        page.evaluate("window.orientation=mountOrientation()")
        return page

    def open_ready(self, page):
        page.evaluate("openVr()")
        expect(page.locator('#kin-volume-rendering')).to_have_attribute('open', '')

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
          await sim.advance(5000);sim.delay=1;tick(250);sim.frame();
          await sim.advance(30000,{deliver:false});tick(250);sim.frame();
          const waiting={open:sim.open(),drawn:frameLog.filter(f=>f.drawn).length};
          sim.deliver();await sim.advance(2);sim.frames();
          return {waiting,open:sim.open(),message:sim.message(),frames:frameLog,arrivals:sim.history.map(m=>m.data.arrived.wall)};
        }""")
        self.assertEqual({'open': True, 'drawn': 1}, result['waiting'])
        self.assertTrue(result['open']);self.assertEqual('', result['message'])
        self.assertEqual([5000, 35002], [f['at'] for f in result['frames'] if f['drawn']])
        self.assertIn(5002, result['arrivals'], 'the answer arrived during the frame, not at delivery at 35000')

    def test_ac_02_consecutive_long_frames_revocation_and_silent_bound(self):
        for duration, bound in [(30000, 60000), (10000, 40000)]:
            with self.subTest(frame_ms=duration):
                page = self.access_page()
                result = page.evaluate("""async duration=>{
                  sim.frame();await sim.advance(duration,{deliver:false});
                  sim.holdMessages=false;sim.jobsBodyDelay=14999;tick(250);await sim.flush();
                  // The server allowed the request, then access disappeared while its body was in transit.
                  const revokedAt=sim.now;sim.silent=true;
                  await sim.advance(14999);sim.frame();
                  await sim.advance(duration,{deliver:false});sim.frame();
                  sim.deliver();await sim.advance(Math.max(0,15000-duration));sim.frames();
                  return {open:sim.open(),elapsed:sim.now-revokedAt,message:sim.message(),frames:frameLog};
                }""", duration)
                self.assertFalse(result['open']);self.assertLessEqual(result['elapsed'], bound)
                self.assertIn('접근 확인 시간이', result['message'])
                starts = [f['at'] for f in result['frames'] if f['drawn']]
                self.assertEqual([0, duration + 14999], starts, 'no next frame starts after expiry')
                self.assertEqual(14999 + max(duration, 15000), result['elapsed'])
                print(f"AC-02 frame={duration}ms starts={starts} revoke-to-close={result['elapsed']}ms bound={bound}ms")

    def test_ac_03_fourteen_second_answer_only_has_one_second_left(self):
        page = self.access_page()
        result = page.evaluate("""async()=>{
          await sim.advance(5000);sim.jobsBodyDelay=14000;tick(250);await sim.flush();
          await sim.advance(14000);sim.silent=true;sim.frame();
          await sim.advance(1000);sim.frame();
          return {open:sim.open(),frames:frameLog};
        }""")
        self.assertTrue(result['open'])
        self.assertEqual([{'at': 19000, 'drawn': True}, {'at': 20000, 'drawn': False}], result['frames'])

    def test_ac_04_no_answer_deadline_and_expiry_without_page_timer(self):
        page = self.access_page()
        result = page.evaluate("""async()=>{
          await sim.advance(5000);sim.silent=true;tick(250);
          await sim.advance(9999);sim.frame();await sim.advance(1);sim.frame();
          await sim.advance(4999);const before=sim.open();await sim.advance(1);sim.frames();
          return {before,open:sim.open(),frames:frameLog,message:sim.message(),now:sim.now};
        }""")
        self.assertTrue(result['before']);self.assertFalse(result['open'])
        self.assertEqual([{'at': 14999, 'drawn': True}, {'at': 15000, 'drawn': False}], result['frames'])
        self.assertEqual(20000, result['now']);self.assertIn('접근 확인 시간이', result['message'])

    def test_ac_05_refusal_and_account_change_precede_next_render(self):
        for change in ["sim.deny=true", "sim.account='other-reader'", "currentOwner=['hospital','other-reader']"]:
            with self.subTest(change=change):
                page = self.access_page()
                result = page.evaluate("""async change=>{
                  await sim.advance(5000);eval(change);tick(250);await sim.flush();
                  engine.render();sim.frames();return {open:sim.open(),frames:frameLog,message:sim.message()};
                }""", change)
                self.assertFalse(result['open']);self.assertEqual([], result['frames'])
                self.assertIn('닫았습니다', result['message'])

    def test_ac_06_old_operation_request_and_other_account_answers_are_discarded(self):
        page = self.access_page()
        result = page.evaluate("""async()=>{
          const old=sim.history[0];closeVr();currentOwner=['hospital','other-reader'];sim.account='other-reader';
          await openVr();const other=sim.history.at(-1);closeVr();currentOwner=['hospital','reader'];sim.account='reader';
          await openVr();sim.frames();frameLog.length=0;
          await sim.advance(15000);sim.silent=true;sim.frame();await sim.flush();
          // These are stale transport deliveries, including A -> B -> A. None may renew access.
          old.worker.onmessage({data:old.data});
          other.worker.onmessage({data:other.data});
          const current=sim.workers.at(-1),pending=sim.jobs.at(-1);
          current.onmessage({data:{...old.data,id:pending.id,owner:JSON.stringify(['hospital','other-reader'])}});
          current.onmessage({data:old.data});sim.frames();
          const before={open:sim.open(),drawn:frameLog.filter(f=>f.drawn).length};
          await sim.advance(15000);return {before,open:sim.open(),message:sim.message()};
        }""")
        self.assertEqual({'open': True, 'drawn': 0}, result['before'])
        self.assertFalse(result['open']);self.assertIn('접근 확인 시간이', result['message'])

    def test_ac_07_two_minutes_prompt_checks_never_block_or_notify(self):
        page = self.access_page()
        result = page.evaluate("""async()=>{
          sim.delay=1;
          for(let i=0;i<7500;i++){tick(250);sim.frame();await sim.advance(16);}
          return {now:sim.now,frames:frameLog.length,blocked:frameLog.filter(f=>!f.drawn).length,
            checks:sim.jobs.length,message:sim.message(),open:sim.open()};
        }""")
        self.assertEqual(0, result['blocked']);self.assertEqual('', result['message']);self.assertTrue(result['open'])
        self.assertEqual(120000, result['now']);self.assertEqual(7500, result['frames'])
        self.assertGreaterEqual(result['checks'], 8, 'two minutes cannot reuse a 15-second confirmation')
        print(f"AC-07 simulated={result['now']}ms frames={result['frames']} checks={result['checks']} blocked=0 messages=0")

    def test_ac_08_queued_viewport_engine_and_resize_frames_check_at_traversal(self):
        for request in ['vrView.render()', 'engine.renderViewport(vrView.id)', 'engine.renderViewports([vrView.id])', 'engine.render()', 'engine.resize()']:
            with self.subTest(request=request):
                page = self.access_page()
                result = page.evaluate("""async request=>{
                  await sim.advance(14999);eval(request);
                  await sim.advance(1);sim.silent=true;sim.frames();
                  return {open:sim.open(),frames:frameLog};
                }""", request)
                self.assertTrue(result['open']);self.assertEqual([{'at': 15000, 'drawn': False}], result['frames'])

    def test_ac_09_full_body_deadline_even_when_worker_timer_is_delayed(self):
        page = self.access_page()
        result = page.evaluate("""async()=>{
          await sim.advance(5000);sim.jobsBodyDelay=15000;tick(250);await sim.flush();
          await sim.advance(15000,{timers:false});sim.frame();
          return {open:sim.open(),frames:frameLog,message:sim.message()};
        }""")
        self.assertFalse(result['open']);self.assertEqual([], result['frames'])
        self.assertIn('접근 확인 시간이', result['message'])

    def test_ac_10_wall_clock_rollback_and_resume_do_not_extend_confirmation(self):
        page = self.access_page()
        result = page.evaluate("""async()=>{
          await sim.advance(15000);sim.wallOffset=-60000;sim.silent=true;
          document.dispatchEvent(new Event('visibilitychange'));sim.frame();
          await sim.advance(15000);return {open:sim.open(),frames:frameLog,message:sim.message()};
        }""")
        self.assertFalse(result['open']);self.assertEqual([{'at': -45000, 'drawn': False}], result['frames'])
        self.assertIn('접근 확인 시간이', result['message'])

    def test_ac_11_initial_check_and_two_response_bodies_share_one_deadline(self):
        for setup in ['sim.silent=true', 'sim.bodyDelay=8000;sim.jobsBodyDelay=8000']:
            with self.subTest(setup=setup):
                page = self.page_with_vr(controlled=True);self.addCleanup(page.close)
                result = page.evaluate("""async setup=>{
                  eval(setup);const opening=openVr();await Promise.all(sim.workers.map(w=>w.ready));
                  await sim.advance(14999);const before=sim.open();await sim.advance(1);await opening;
                  return {before,open:sim.open(),message:sim.message(),frames:frameLog,terminated:sim.workers.every(w=>w.terminated)};
                }""", setup)
                self.assertTrue(result['before']);self.assertFalse(result['open'])
                self.assertEqual([], result['frames']);self.assertTrue(result['terminated'])
                self.assertIn('접근 확인 시간이', result['message'])

    def test_ac_12_blocked_vr_preserves_mpr_and_close_restores_engine(self):
        page = self.access_page()
        result = page.evaluate("""async()=>{
          const sourceBefore=sourceState();await sim.advance(15000);sim.silent=true;
          engine.renderViewport(vrView.id);engine._needsRender.add('axial');sim.frames();
          const blocked=frameLog.at(-1);closeVr();
          engine._needsRender.add('coronal');engine.drawn=new Set();engine.performVtkDrawCall();engine._needsRender.clear();
          const old=sim.history[0];old.worker.onmessage({data:{...old.data,error:'old refusal'}});
          sim.silent=false;await openVr();sim.frames();
          return {blocked,native:nativeFrames,sourcePreserved:sourceBefore===sourceState(),open:sim.open(),message:sim.message()};
        }""")
        self.assertEqual({'at': 15000, 'drawn': False}, result['blocked'])
        self.assertEqual(['axial', 'coronal'], result['native']);self.assertTrue(result['sourcePreserved'])
        self.assertTrue(result['open']);self.assertEqual('', result['message'])

    def test_ac_13_access_held_sculpt_waits_for_its_actual_shader_frame(self):
        page = self.access_page()
        result = page.evaluate("""async()=>{
          await sim.advance(15000);sim.delay=100;
          [...document.querySelectorAll('button')].find(b=>b.textContent==='Apply Sculpt').click();
          sim.frames();sim.frames();const waiting=sim.open();
          await sim.advance(200);sim.frames();sim.frames();sim.frames();
          return {waiting,open:sim.open(),message:sim.message(),compiled:shader.compiled,frames:frameLog};
        }""")
        self.assertTrue(result['waiting']);self.assertTrue(result['open'])
        self.assertEqual('', result['message']);self.assertTrue(result['compiled'])
        self.assertEqual([{'at': 15200, 'drawn': True}], result['frames'])


if __name__ == '__main__':
    unittest.main()
