# coding: utf-8
"""VR112-REQ-02 -> VR112-RISK-02: real pinned GPU stack / mounted Job panel.

Supply KIN_PINNED_OHIF_LIBRARY (a retained libOrthancOHIF.so, never a live
container). All browser requests are intercepted; no server or LiveStack is used.
The native bundle pin identifies the supported runtime, not product source text.
Only its application bootstrap is replaced to expose its unchanged native modules.
Job code is loaded whole, and assertions compare rendered pixels and saved state.
Native service and overlay exports are widened only in this test fixture; their implementations are unchanged.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import unittest
import zlib

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
APP_SHA = '4fc18be2b7ae02369093d0505ae3241c9d78cb7396aebef4a0e01b8534f5ff58'
ORIGIN = 'https://viewer-restore.invalid'
ADAPTER = Path(os.environ.get('KIN_STACK_RESTORE_JS', ROOT / 'worklist-v0/hpacs-lite/viewer-stack-restore.js'))
JOBS = Path(os.environ.get('KIN_VIEWER_JOBS_JS', ROOT / 'worklist-v0/hpacs-lite/viewer-jobs.js'))

HTML = '''<!doctype html><html><head><style>
body {margin:0} #views {display:flex} .view {flex-shrink:0;position:relative;width:256px;height:256px}
</style></head><body><div id="react-portal"></div><div id="views"></div>
<details id="kin-viewer-layout" open><summary>Layout</summary></details>
<script>window.config={};</script><script src="/native.js"></script></body></html>'''

HARNESS = r"""
async () => {
  const cs = window.cornerstone = window.nativeRequire(81985);
  await cs.init(); cs.setUseCPURendering(false);
  const refs = new Map(), stacks = [], sets = [];
  for (let study=1; study<=2; study++) {
    const ids=[];
    for (let frame=0; frame<4; frame++) {
      const id=`syn:${study}:${frame}`; ids.push(id);
      refs.set(id,{StudyInstanceUID:`1.2.${study}`,SeriesInstanceUID:`1.2.${study}.1`,
        SOPInstanceUID:`1.2.${study}.1.${frame+1}`,SOPClassUID:'1.2.840.10008.5.1.4.1.1.2',InstanceNumber:frame+1,Modality:'CT',PatientID:'SYN',SamplesPerPixel:1,PhotometricInterpretation:'MONOCHROME2'});
    }
    stacks.push(ids); sets.push({displaySetInstanceUID:`series-${study}`,StudyInstanceUID:`1.2.${study}`,
      SeriesInstanceUID:`1.2.${study}.1`,Modality:'CT',images:ids.map(id=>refs.get(id))});
  }
  cs.metaData.addProvider((type,id) => {
    if (!refs.has(id)) return;
    const frame=Number(id.split(':')[2]);
    if (type==='instance') return refs.get(id);
    if (type==='generalImageModule') return {instanceNumber:frame+1};
    if (type==='imagePlaneModule') return {frameOfReferenceUID:'1.2.90',rows:64,columns:64,
      rowCosines:[1,0,0],columnCosines:[0,1,0],imageOrientationPatient:[1,0,0,0,1,0],pixelSpacing:[1,1],
      imagePositionPatient:[0,0,frame],rowPixelSpacing:1,columnPixelSpacing:1};
    if (type==='imagePixelModule') return {samplesPerPixel:1,photometricInterpretation:'MONOCHROME2',
      rows:64,columns:64,bitsAllocated:16,bitsStored:16,highBit:15,pixelRepresentation:1};
    if (type==='generalSeriesModule') return {modality:'CT',seriesInstanceUID:refs.get(id).SeriesInstanceUID};
    if (type==='modalityLutModule') return {rescaleIntercept:0,rescaleSlope:1};
    if (type==='voiLutModule') return {windowCenter:[128],windowWidth:[256]};
  },10000);
  cs.imageLoader.registerImageLoader('syn', imageId => {
    const frame=Number(imageId.split(':')[2]);
    const data=new Int16Array(64*64);
    for(let y=0;y<64;y++)for(let x=0;x<64;x++)data[y*64+x]=30+frame*10+((x+2*y)%160);
    return {promise:Promise.resolve({imageId,minPixelValue:0,maxPixelValue:255,slope:1,intercept:0,
      windowCenter:128,windowWidth:256,rows:64,columns:64,width:64,height:64,
      color:false,rgba:false,numberOfComponents:1,invert:false,rowPixelSpacing:1,columnPixelSpacing:1,
      sizeInBytes:data.byteLength,getPixelData:()=>data,
      voxelManager:cs.utilities.VoxelManager.createImageVoxelManager({width:64,height:64,scalarData:data})})};
  });
  const React=nativeRequire(86326), ReactDOM=nativeRequire(35623), flush=nativeRequire(35623);
  const listeners=new Map(), roots=[];
  const publish=(event,payload)=>{for(const fn of [...(listeners.get(event)||[])])fn(payload)};
  const manager={services:{
    displaySetService:{getActiveDisplaySets:()=>sets,getDisplaySetByUID:id=>sets.find(s=>s.displaySetInstanceUID===id)},
    hangingProtocolService:{getShouldPerformCustomImageLoad:()=>false},
    segmentationService:{clearSegmentationRepresentations:()=>{},getPresentation:()=>null},
    syncGroupService:{getSynchronizersForViewport:()=>[]},
    toolGroupService:{getActiveToolForViewport:()=>null},
    cineService:{getState:()=>({isCineEnabled:false})},
    customizationService:{getCustomization:name=>name==='@ohif/cornerstoneOverlay'?nativeRequire(5791).JX:null},
    uiNotificationService:{show:message=>{throw Error(JSON.stringify(message))}},
  }};
  const service=manager.services.cornerstoneViewportService=new nativeServices.CornerstoneViewportService(manager);
  const cache=manager.services.cornerstoneCacheService=new nativeServices.CornerstoneCacheService(manager);
  const engine=service.getRenderingEngine();
  const contexts=new Map(),enable=engine.enableElement.bind(engine);
  engine.enableElement=options=>{
    enable(options);
    const v=engine.getViewport(options.viewportId),c=contexts.get(options.viewportId);
    if(!c||v.type!=='stack')return;
    const setStack=v.setStack.bind(v),render=v.render.bind(v);
    v.setStack=async (...args)=>{
      const result=await setStack(...args);
      window.trace.push({event:'stack-loaded',gen:c.gen,i:c.i,index:v.getCurrentImageIdIndex()});
      await gate('data-'+c.gen+'-'+c.i);
      return result;
    };
    v.render=()=>{
      if(v.getProperties().colormap?.name==='Grayscale' && window.holds['render-'+c.gen+'-'+c.i]){
        gate('render-'+c.gen+'-'+c.i).then(render);return;
      }
      render();
    };
  };
  let mountingOverlay=false;
  const subscribeNative=service.subscribe.bind(service);
  service.subscribe=(event,fn)=>{
    if(!mountingOverlay)return subscribeNative(event,fn);
    return subscribeNative(event,value=>{
      const c=contexts.get(value.viewportId);
      if(c && window.holds['overlay-'+c.gen+'-'+c.i]) gate('overlay-'+c.gen+'-'+c.i).then(()=>fn(value));
      else fn(value);
    });
  };
  window.source={getImageIdsForDisplaySet:set=>stacks[sets.indexOf(set)]};
  let state={layout:{layoutType:'grid',numRows:1,numCols:2},viewports:new Map(),activeViewportId:null};
  window.trace=[];window.resetAfterApply=false;window.resetCount=0;window.generation=0;
  window.gates={};window.holds={};
  window.hold=key=>{window.holds[key]=true;};
  window.release=key=>{delete window.holds[key];const waiting=window.gates[key]||[];delete window.gates[key];waiting.forEach(resolve=>resolve())};
  const gate=key=>window.holds[key]?new Promise(resolve=>{(window.gates[key]||=[]).push(resolve)}):Promise.resolve();
  window.rendered = v => new Promise(resolve=>{
    const handler=()=>{v.element.removeEventListener(cs.Enums.Events.IMAGE_RENDERED,handler);resolve()};
    v.element.addEventListener(cs.Enums.Events.IMAGE_RENDERED,handler);v.render();
  });
  async function layout(options) {
    const gen=++window.generation,old=[...state.viewports.keys()];
    for(const root of roots.splice(0))root.unmount();
    for(const id of old)service.disableElement(id);
    document.getElementById('views').replaceChildren();
    state={layout:{layoutType:'grid',numRows:options.numRows,numCols:options.numCols},viewports:new Map(),activeViewportId:options.activeViewportId};
    const tasks=[];
    for(let i=0;i<(options.layoutOptions?.length||options.numRows*options.numCols);i++) {
      const cell=options.findOrCreateViewport(i), id=cell.viewportOptions.viewportId;
      state.viewports.set(id,{...cell,viewportId:id,x:(i%options.numCols)/options.numCols,y:Math.floor(i/options.numCols)/options.numRows,width:1/options.numCols,height:1/options.numRows,...options.layoutOptions?.[i]});
      const host=document.createElement('div');host.className='view';document.getElementById('views').append(host);
      const el=document.createElement('div');el.style.cssText='width:256px;height:256px';host.append(el);
      if(!cell.displaySetInstanceUIDs.length)continue;
      contexts.set(id,{gen,i});
      service.enableViewport(id,el);
      const overlay=document.createElement('div');overlay.className='native-overlay';host.append(overlay);
      const root=ReactDOM.createRoot(overlay);roots.push(root);
      mountingOverlay=true;flush.flushSync(()=>root.render(React.createElement(NativeOverlays,{viewportId:id,element:el,scrollbarHeight:'216px',servicesManager:manager})));mountingOverlay=false;
      tasks.push((async()=>{
        const set=sets.find(s=>s.displaySetInstanceUID===cell.displaySetInstanceUIDs[0]);
        const data=await cache.createViewportData([set],cell.viewportOptions,source);
        await gate('init-'+gen+'-'+i);
        const done=new Promise(resolve=>{
          const off=service.subscribe(service.EVENTS.VIEWPORT_DATA_CHANGED,({viewportId})=>{
            if(viewportId===id){off.unsubscribe();window.trace.push({event:'data',gen,i});resolve()}
          });
        });
        service.setViewportData(id,data,cell.viewportOptions,[{}],{});
        const v=service.getCornerstoneViewport(id);state.viewports.get(id).isReady=true;
        window.trace.push({event:'created',gen,i,index:v.getCurrentImageIdIndex()});
        if(window.resetAfterApply&&i===0){
          let fired=false;
          el.addEventListener(cs.Enums.Events.IMAGE_RENDERED,()=>{
            if(fired || v.getProperties().colormap?.name!=='Grayscale')return;
            fired=true;window.resetCount++;window.trace.push({event:'drift',gen,i});
            if(window.driftProperties)v.setProperties({voiRange:{lower:0,upper:500},VOILUTFunction:'SIGMOID',interpolationType:0});
            else v.setCamera({parallelScale:123});
          });
        }
        await done;await window.rendered(v);
      })());
    }
    publish('layout',{removedViewportIds:old});
    window.layoutDone=Promise.all(tasks);
    window.layoutDone.catch(e=>{window.layoutError=String(e)});
  }
  const grid={EVENTS:{LAYOUT_CHANGED:'layout',GRID_STATE_CHANGED:'grid'},getState:()=>state,getActiveViewportId:()=>state.activeViewportId,
    subscribe:(event,fn)=>{if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(fn);return {unsubscribe:()=>listeners.get(event).delete(fn)}},
    getDisplaySetsUIDsForViewport:id=>state.viewports.get(id)?.displaySetInstanceUIDs,
    setActiveViewportId:id=>{state.activeViewportId=id},setLayout:layout};
  manager.services.viewportGridService=grid;
  window.services=manager.services;window.setLayout=layout;
  window.nativeService=service;window.nativeCache=cache;window.engine=engine;window.sets=sets;
  await layout({numRows:1,numCols:new URLSearchParams(location.search).get('StudyInstanceUIDs').split(',').length,activeViewportId:'initial-0',findOrCreateViewport:i=>({
    displaySetInstanceUIDs:[sets[i].displaySetInstanceUID],viewportOptions:{viewportId:`initial-${i}`,viewportType:'stack'}})});
  await window.layoutDone;
  window.views=()=>[...state.viewports.keys()].map(id=>engine.getViewport(id)).filter(Boolean);
  window.observe=()=>window.views().filter(v=>v.type==='stack').map(v=>{
    const canvas=v.getCanvas(), pixels=Array.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data);
    let hash=2166136261;for(let i=0;i<pixels.length;i++)hash=Math.imul(hash^pixels[i],16777619)>>>0;
    return {image:v.getCurrentImageId(),index:v.getCurrentImageIdIndex(),target:v.getTargetImageIdIndex(),
      camera:v.getCamera(),properties:v.getProperties(),hash,
      pixel:pixels.slice(4*(128*canvas.width+128),4*(128*canvas.width+128)+4)};
  });
  window.seed=async (invert,colormap,lut) => {
    for(const [i,v] of window.views().entries()){
      await v.setImageIdIndex(i+1);v.scroll(i+1-v.getTargetImageIdIndex(),false);
      v.setProperties({voiRange:{lower:0,upper:256},VOILUTFunction:lut,interpolationType:1,
        ...(colormap?{colormap:{name:'Grayscale',opacity:[]}}:{}),invert:i===0&&invert});
      if(window.rotateSeed){v.setCamera({flipHorizontal:true,flipVertical:true});v.setProperties({rotation:90});}
      const camera=v.getCamera();v.setCamera({parallelScale:camera.parallelScale*.8,
        focalPoint:camera.focalPoint.map((n,j)=>n+(j===0?2:0)),position:camera.position.map((n,j)=>n+(j===0?2:0))});
      await window.rendered(v);
    }
    state.activeViewportId=[...state.viewports.keys()][1];
  };
  document.addEventListener('keydown',e=>{
    if(e.key!=='ArrowDown')return;
    service.getCornerstoneViewport(state.activeViewportId)?.scroll(1,false);
  });
  window.job=null;
  window.fetch=async (url,options={})=>{
    if(url==='/api/me')return new Response(JSON.stringify({kind:'member',institution:'SYN',sub:'reader',roles:['radiologist']}));
    if(options.method==='POST'){
      const value=JSON.parse(options.body);window.job={...value,revision:1,snapshotVersion:value.snapshot.version,
        authorSub:'reader',authorActor:'Synthetic',createdAt:'2026-10-09T00:00:00Z',hidden:false};
      return new Response(JSON.stringify(window.job));
    }
    if(url.includes('?'))return new Response(JSON.stringify({jobs:window.job?[window.job]:[]}));
    return new Response(JSON.stringify(window.job));
  };
}
"""


class NativeStackRestore(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = Path(os.environ['KIN_PINNED_OHIF_LIBRARY']).read_bytes()
        app = zlib.decompressobj(31).decompress(source[0x534DE0:])
        if hashlib.sha256(app).hexdigest() != APP_SHA:
            raise RuntimeError('Unsupported OHIF runtime: app bundle pin mismatch')
        app = app.decode('utf-8')
        entry = 'var __webpack_exports__ = __webpack_require__(16265);'
        if app.count(entry) != 1:
            raise RuntimeError('Pinned runtime bootstrap missing')
        cls.app = app.replace(entry, 'window.nativeRequire = __webpack_require__;')
        cls.app = cls.app.replace('loadDynamicConfig(window.config).then(', 'new Promise(() => {}).then(')
        cls.app = cls.app.replace('__webpack_modules__[moduleId].call(', '(__webpack_modules__[moduleId] || (() => {throw Error("Missing native module " + moduleId)})).call(')

        members = {}
        import re
        for hit in re.finditer(b'\\x1f\\x8b\\x08', source):
            try: raw = zlib.decompressobj(31).decompress(source[hit.start():])
            except zlib.error: continue
            if b'webpackChunk' in raw[:500]: members[hit.start()] = raw.decode('utf8')
        # Expose complete, unchanged native implementations to the isolated fixture.
        members[0xb80b00] = members[0xb80b00].replace(
            '/* harmony default export */ const cornerstone_src = (cornerstoneExtension);',
            'window.nativeServices = {CornerstoneCacheService,CornerstoneViewportService};' +
            '/* harmony default export */ const cornerstone_src = (cornerstoneExtension);')
        members[0x7e48e0] = members[0x7e48e0].replace(
            '/* harmony default export */ const Viewport_OHIFCornerstoneViewport = (OHIFCornerstoneViewport);',
            'window.NativeOverlays = Overlays_CornerstoneOverlays;' +
            '/* harmony default export */ const Viewport_OHIFCornerstoneViewport = (OHIFCornerstoneViewport);')
        cls.chunks = '\n'.join(v for v in members.values() if any('push([['+str(n)+']' in v[:100] for n in [149,1436,3334,1520,1185,4182,9611]))
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(channel='chromium', headless=True, args=[
            '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        print(json.dumps({'browser': cls.browser.version, 'app_sha256': APP_SHA,
                          'library_sha256': hashlib.sha256(source).hexdigest(),
                          'renderer': 'ANGLE SwiftShader', 'live_stack': False}), flush=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        try: self.setup_native()
        except Exception:
            import traceback
            traceback.print_exc()
            raise

    def setup_native(self, studies="1.2.1,1.2.2", job=None):
        self.context = self.browser.new_context(viewport={'width': 1000, 'height': 800}, device_scale_factor=1)
        self.context.route('**/*', self.route)
        self.page = self.context.new_page()
        self.page_errors=[]
        self.page.on('pageerror', lambda error: (self.page_errors.append(str(error)), print('PAGEERROR', error.stack, flush=True)))
        self.page.goto(ORIGIN + '/ohif/viewer?StudyInstanceUIDs='+studies, timeout=120000)
        self.bootstrap(job)
        expect(self.page.get_by_role('button', name='Save New Job', exact=True)).to_be_enabled()

    def bootstrap(self, job=None, holds=()):
        self.page.add_script_tag(content=self.chunks)
        self.page.evaluate('nativeRequire(11185); nativeRequire(69611)')
        print('Native modules loaded', flush=True)
        self.page.evaluate(HARNESS)
        self.page.evaluate('([job,keys])=>{window.job=job;keys.forEach(hold)}',[job,list(holds)])
        self.page.add_script_tag(path=str(ROOT / 'worklist-v0/hpacs-lite/session-transport.js'))
        self.page.add_script_tag(path=str(ADAPTER))
        self.page.add_script_tag(path=str(ROOT / "worklist-v0/hpacs-lite/viewer-volume-job.js"))
        self.page.add_script_tag(path=str(JOBS))
        self.page.evaluate('window.panel=kinViewerJobs(services,{scope:()=>({})},null,()=>source);panel.mount()')

    def tearDown(self):
        self.context.close()

    def route(self, route):
        if route.request.url.startswith(ORIGIN + '/native.js'):
            route.fulfill(content_type='application/javascript', body=self.app)
        elif route.request.url.startswith(ORIGIN + '/ohif/viewer?'):
            route.fulfill(content_type='text/html', body=HTML)
        else:
            route.abort()

    def assert_labels(self, indices):
        for i,index in enumerate(indices):
            host=self.page.locator('.view').nth(i)
            if index is None:
                expect(host.locator('input[type=range]')).to_have_count(0)
            else:
                expect(host).to_contain_text('('+str(index+1)+'/4)')
                expect(host.locator('input[type=range]')).to_have_value(str(index))

    def save(self, invert=True):
        self.page.evaluate('(invert)=>seed(invert,false,"LINEAR")', invert)
        before=self.page.evaluate('observe()')
        self.page.get_by_label('Job Title',exact=True).fill('Synthetic comparison')
        self.page.get_by_role('button',name='Save New Job',exact=True).click()
        expect(self.page.get_by_role('status')).to_contain_text('저장했습니다')
        return before

    def restore(self):
        self.page.get_by_role('button',name='Restore Job',exact=True).click()

    def restored(self):
        self.page.wait_for_function('!kinViewerJobWorkspaceState().busy', timeout=20000)
        self.assertIn('복원했습니다', self.page.get_by_role('status').inner_text(), 'successful restore must follow the saved display')

    def gate_ready(self, key):
        self.page.wait_for_function('(key)=>!!window.gates[key]',arg=key)

    def release(self, key):
        self.page.evaluate('(key)=>release(key)',key)

    def assert_display(self, before):
        after=self.page.evaluate('observe()')
        self.assertEqual(len(after),len(before))
        for old,new in zip(before,after):
            self.assertEqual(old['image'],new['image'])
            self.assertEqual(old['index'],new['index'])
            self.assertEqual(new['index'],new['target'])
            for key in ['voiRange','VOILUTFunction','invert','interpolationType']:
                self.assertEqual(old['properties'][key],new['properties'][key],key)
            for key in ['focalPoint','position','viewUp','viewPlaneNormal']:
                for x,y in zip(old['camera'][key],new['camera'][key]):self.assertAlmostEqual(x,y,places=6,msg=key)
            for key in ['rotation','parallelScale','flipHorizontal','flipVertical']:
                self.assertAlmostEqual(old['camera'][key],new['camera'][key],places=6,msg=key)
            self.assertEqual(old['hash'],new['hash'],'rendered pixels must equal saved display')

    def test_T02_delayed_native_overlay_snapshot(self):
        before=self.save()
        self.page.evaluate('sets.forEach(s=>s.images.reverse());hold("overlay-2-1")')
        self.restore();self.gate_ready('overlay-2-1')
        created=self.page.evaluate('trace.filter(e=>e.event==="created"&&e.gen===2).map(e=>e.index)')
        self.assertEqual(created,[1,2],'native stacks must start at the saved images')
        self.restored()
        # The actual native React consumer takes its first index snapshot late.
        self.release('overlay-2-1')
        self.assert_labels([1,2]);self.assert_display(before)
        created=self.page.evaluate('trace.filter(e=>e.event==="created"&&e.gen===2).map(e=>e.index)')
        self.assertEqual(created,[1,2],'native stacks must start at the saved images')

    def test_T01_fresh_context_navigation_both_orders(self):
        before=self.save();job=self.page.evaluate('job')
        for order in [(0,1),(1,0)]:
            with self.subTest(order=order):
                self.context.close();self.setup_native('1.2.1',job)
                self.restore();self.page.wait_for_url('**/*kinJob=*')
                self.bootstrap(job,['data-2-0','data-2-1'])
                self.gate_ready('data-2-0');self.gate_ready('data-2-1')
                self.release('data-2-'+str(order[0]))
                self.assertTrue(self.page.evaluate('kinViewerJobWorkspaceState().busy'),'each study has its own readiness boundary')
                self.release('data-2-'+str(order[1]));self.restored()
                self.assert_display(before);self.assert_labels([1,2])
                self.assertEqual(self.page.evaluate('[...services.viewportGridService.getState().viewports.keys()].indexOf(services.viewportGridService.getActiveViewportId())'),1)

    def test_T05_rotation_flips_pan_zoom(self):
        self.page.evaluate('window.rotateSeed=true')
        self.roundtrip(True,True,True)

    def test_T03_data_ready_then_final_render(self):
        before=self.save();self.page.clock.install()
        self.page.evaluate('hold("data-2-0");hold("data-2-1")')
        self.restore();self.gate_ready('data-2-0');self.gate_ready('data-2-1')
        self.page.clock.run_for(1200)
        self.assertTrue(self.page.evaluate('kinViewerJobWorkspaceState().busy'),'actor/quiet initial render is not data readiness')
        self.assertNotIn('복원했습니다',self.page.get_by_role('status').inner_text())
        self.page.evaluate('hold("render-2-0");hold("render-2-1")')
        self.release('data-2-1');self.release('data-2-0')
        self.gate_ready('render-2-0');self.gate_ready('render-2-1');self.page.clock.run_for(100)
        self.assertTrue(self.page.evaluate('kinViewerJobWorkspaceState().busy'),'initialization render cannot complete the saved display')
        self.release('render-2-0');self.release('render-2-1');self.page.clock.run_for(100)
        self.restored();self.assert_display(before);self.assert_labels([1,2])

    def test_T06_display_only_drift(self):
        self.page.evaluate('window.driftProperties=true')
        self.roundtrip(True,False,True)

    def test_T07_versions_vacancy_duplicate_series(self):
        before=self.save()
        for version,rows,cols,active,indices in [(1,1,1,0,[1]),(2,1,2,1,[1,2]),(3,2,2,2,[1,None,2,1]),(3,2,2,1,[1,None,2,1])]:
            with self.subTest(version=version):
                self.page.evaluate('''([version,rows,cols,active,indices])=>{
                  window.originalCells||=structuredClone(job.snapshot.cells);
                  job.snapshot={...job.snapshot,version,rows,cols,active,cells:indices.map(i=>i===null?null:structuredClone(originalCells[i===2?1:0]))};
                  job.snapshotVersion=version;
                }''',[version,rows,cols,active,indices])
                self.restore();self.restored();self.assert_labels(indices)
                actual=self.page.evaluate('observe()')
                self.assertEqual([x['image'] for x in actual],[before[1 if i==2 else 0]['image'] for i in indices if i is not None])
                self.assert_display([before[1 if i==2 else 0] for i in indices if i is not None])
                self.assertEqual(self.page.evaluate('[...services.viewportGridService.getState().viewports.keys()].indexOf(services.viewportGridService.getActiveViewportId())'),active)

    def test_T08_saved_location_and_merged_consumer(self):
        before=self.save()
        result=self.page.evaluate('''()=>kinViewerJobLocation.restore({subject:"reader",jobId:job.id,revision:job.revision,snapshotVersion:2,studies:job.snapshot.studies,mode:"same-document",mark:null})''')
        self.assertEqual(result['state'],'restored');self.assert_display(before);self.assert_labels([1,2])
        self.page.evaluate('''()=>{job.snapshot.version=9;job.snapshotVersion=9;job.snapshot.volume=null;
          job.snapshot.cells=[{...job.snapshot.cells[1],kind:"stack"}];job.snapshot.active=0;
          job.snapshot.rects=[{x:0,y:0,width:1,height:1}];}''')
        self.restore();self.restored();self.assert_display([before[1]]);self.assert_labels([2])

    def test_T09_next_slice_and_later_manipulations(self):
        self.save();self.restore();self.restored();self.assert_labels([1,2])
        self.page.evaluate("""async()=>{const v=views()[1];v.setProperties({voiRange:{lower:0,upper:512},invert:true});
          v.setCamera({parallelScale:20,focalPoint:[30,31,2],position:[30,31,-47]});await rendered(v)}""")
        self.assertEqual(self.page.evaluate('views()[1].getProperties().voiRange.upper'),512,'later W/L must not be restored again')
        after=self.page.evaluate('observe()')
        self.page.evaluate('()=>Promise.all(views().map(rendered))')
        self.assert_display(after);self.assert_labels([1,2])
        self.page.keyboard.press('ArrowDown')
        self.page.wait_for_function('views()[1].getCurrentImageIdIndex()===3');self.assert_labels([1,3])
        self.assertEqual(self.page.evaluate('views()[1].getProperties().voiRange.upper'),512)

    def test_T08_mixed_volume_stack_consumer(self):
        self.page.evaluate('''async()=>{
          await setLayout({numRows:1,numCols:2,activeViewportId:'mixed-1',findOrCreateViewport:i=>({
            displaySetInstanceUIDs:[sets[i].displaySetInstanceUID],displaySetOptions:[{}],
            viewportOptions:{id:'mixed-'+i,viewportId:'mixed-'+i,viewportType:i?'stack':'volume',toolGroupId:i?'default':'mpr',orientation:'axial'}
          })});await layoutDone;
        }''')
        self.page.wait_for_function('cornerstone.cache.getVolume(views()[0].getVolumeId())?.loadStatus.loaded')
        self.page.evaluate('''async()=>{
          const [v,s]=views();v.setProperties({voiRange:{lower:0,upper:256},invert:false,colormap:{name:'Grayscale',opacity:1}});
          await s.setImageIdIndex(2);s.scroll(2-s.getTargetImageIdIndex(),false);
          s.setProperties({voiRange:{lower:0,upper:256},invert:true});s.setCamera({parallelScale:25});
          await Promise.all(views().map(rendered));
        }''')
        before=self.page.evaluate('observe()')
        self.page.get_by_label('Job Title',exact=True).fill('Mixed native comparison')
        self.page.get_by_role('button',name='Save New Job',exact=True).click()
        expect(self.page.get_by_role('status')).to_contain_text('저장했습니다')
        self.assertEqual(self.page.evaluate('job.snapshot.version'),8)
        self.restore();self.restored();self.assert_display(before)
        expect(self.page.locator('.view').nth(1)).to_contain_text('(3/4)')
        expect(self.page.locator('.view').nth(1).locator('input[type=range]')).to_have_value('2')

    def test_T10_same_id_replacement(self):
        self.save();self.page.evaluate('hold("data-2-1")');self.restore();self.gate_ready('data-2-1')
        self.page.evaluate('''()=>{window.oldView=views()[1];const info=nativeService.getViewportInfo(oldView.id);
          nativeService.setViewportData(oldView.id,info.getViewportData(),info.getViewportOptions(),[{}],{});}''')
        self.page.wait_for_function('!kinViewerJobWorkspaceState().busy')
        self.assertNotIn('복원했습니다',self.page.get_by_role('status').inner_text(),'same id with a new native object cannot complete this restore')
        self.assertEqual(self.page.evaluate('generation'),2,'lost ownership cannot roll back over the replacement')
        self.release('data-2-1');self.page.evaluate('()=>new Promise(requestAnimationFrame)')
        self.assertNotIn('복원했습니다',self.page.get_by_role('status').inner_text())

    def test_T10_session_end_late_data(self):
        self.save();self.page.evaluate('hold("data-2-1")');self.restore();self.gate_ready('data-2-1')
        self.page.evaluate('panel.stop()');self.release('data-2-1')
        self.page.evaluate('()=>new Promise(requestAnimationFrame)')
        self.assertNotEqual(self.page.evaluate('views()[1].getProperties().colormap?.name'),'Grayscale','ended restore must not apply saved display')
        expect(self.page.locator('#kin-viewer-jobs')).to_have_count(0)

    def test_T10_a_b_a_cannot_revive_restore(self):
        self.save();self.page.evaluate('hold("data-2-1")');self.restore();self.gate_ready('data-2-1')
        self.page.evaluate('history.pushState({},"",location.href+"&context=B")')
        self.page.go_back()
        self.release('data-2-1');self.page.evaluate('()=>new Promise(requestAnimationFrame)')
        self.page.wait_for_function('!kinViewerJobWorkspaceState().busy')
        self.assertNotIn('복원했습니다',self.page.get_by_role('status').inner_text())
        self.assertNotEqual(self.page.evaluate('views()[1].getProperties().colormap?.name'),'Grayscale')

    def test_T12_unrelated_stack_and_volume_events(self):
        before=self.save();self.page.evaluate('hold("data-2-1")');self.restore();self.gate_ready('data-2-1')
        other=self.page.evaluate('''async()=>{
          window.others=[];
          for(const [id,type] of [["MG","stack"],["XA","stack"],["volume","orthographic"]]){
            const element=document.createElement('div');element.style.cssText="width:64px;height:64px";document.body.append(element);
            engine.enableElement({viewportId:id,type,element});const v=engine.getViewport(id);others.push(v);
            if(type==='stack')await v.setStack(['syn:1:0'],0);
            v.setCamera({parallelScale:19});
          }
          return others.map(v=>v.getCamera());
        }''')
        self.release('data-2-1');self.restored();self.assert_display(before)
        self.assertEqual(self.page.evaluate('others.map(v=>v.getCamera())'),other,'unowned modality/volume events must not receive a saved camera')

    def test_T11_timeout_verified_rollback(self):
        self.save();self.page.evaluate('()=>seed(false,false,"LINEAR")')
        previous=self.page.evaluate('observe()');self.page.clock.install();self.page.evaluate('hold("data-2-1")')
        self.restore();self.gate_ready('data-2-1');self.page.clock.fast_forward(15100);self.page.clock.run_for(200)
        self.page.wait_for_function('!kinViewerJobWorkspaceState().busy')
        self.assertNotIn('복원했습니다',self.page.get_by_role('status').inner_text(),'timeout must not claim restored')
        self.assertEqual(self.page.evaluate('generation'),3)
        self.assert_display(previous);self.assert_labels([1,2])
        self.release('data-2-1');self.page.clock.run_for(100);self.assert_display(previous)

    def test_T11_failed_rollback_is_unknown(self):
        self.save();self.page.clock.install();self.page.evaluate('hold("data-2-1");hold("data-3-1")')
        self.restore();self.gate_ready('data-2-1');self.page.clock.fast_forward(15100)
        self.gate_ready('data-3-1');self.page.clock.fast_forward(15100)
        self.page.wait_for_function('!kinViewerJobWorkspaceState().busy')
        message=self.page.get_by_role('status').inner_text()
        self.assertNotIn('복원했습니다',message,'unverified rollback must report unknown screen');self.assertIn('복구에 실패',message,'unverified rollback must report unknown screen')
        self.release('data-2-1');self.release('data-3-1');self.page.clock.run_for(100)
        self.assertEqual(self.page.get_by_role('status').inner_text(),message)

    def test_T11_final_render_timeout_verifies_rollback(self):
        previous=self.save();self.page.clock.install();self.page.evaluate('hold("data-2-0");hold("data-2-1")')
        self.restore();self.gate_ready('data-2-0');self.gate_ready('data-2-1')
        # Drain the genuine initial render before blocking the saved-state render.
        # Otherwise that already queued frame can legitimately render the saved state.
        self.page.clock.run_for(100)
        self.page.evaluate('hold("render-2-0");hold("render-2-1")')
        self.release('data-2-0');self.release('data-2-1');self.gate_ready('render-2-1')
        self.page.clock.run_for(100)
        self.assertTrue(self.page.evaluate('kinViewerJobWorkspaceState().busy'),'a missing saved-state render must remain pending')
        self.page.clock.fast_forward(15100);self.page.clock.run_for(200)
        self.page.wait_for_function('!kinViewerJobWorkspaceState().busy')
        self.assertNotIn('복원했습니다',self.page.get_by_role('status').inner_text())
        self.assertEqual(self.page.evaluate('generation'),3)
        self.assert_display(previous);self.assert_labels([1,2])
        self.release('render-2-0');self.release('render-2-1');self.page.clock.run_for(100);self.assert_display(previous)

    def test_T03_changed_initial_index_fails_and_rolls_back(self):
        previous=self.save();self.page.evaluate('hold("data-2-1")')
        self.restore();self.gate_ready('data-2-1')
        self.page.evaluate('async()=>{await views()[1].setImageIdIndex(0);await rendered(views()[1])}')
        self.release('data-2-1');self.page.wait_for_function('!kinViewerJobWorkspaceState().busy')
        self.assertNotIn('복원했습니다',self.page.get_by_role('status').inner_text())
        self.assertEqual(self.page.evaluate('generation'),3,'mismatched initialization must use verified rollback')
        self.assert_display(previous);self.assert_labels([1,2])

    def test_T12_non_ct_sources_refuse_before_native_creation(self):
        before=self.save()
        for modality,sopclass in [('MG','1.2.840.10008.5.1.4.1.1.1.2'),('XA','1.2.840.10008.5.1.4.1.1.12.1')]:
            with self.subTest(modality=modality):
                self.page.evaluate('([modality,sopclass])=>{sets[1].Modality=modality;sets[1].images.forEach(m=>{m.Modality=modality;m.SOPClassUID=sopclass})}',[modality,sopclass])
                self.restore();self.page.wait_for_function('!kinViewerJobWorkspaceState().busy')
                self.assertNotIn('복원했습니다',self.page.get_by_role('status').inner_text())
                self.assertEqual(self.page.evaluate('generation'),1,'non-CT sources must not enter the stack restore adapter')
                self.assert_display(before)

    def test_T12_missing_sop_refuses_without_layout(self):
        before=self.save();self.page.evaluate('job.snapshot.cells[1].sop="1.2.404"')
        self.restore();self.page.wait_for_function('!kinViewerJobWorkspaceState().busy')
        self.assertNotIn('복원했습니다',self.page.get_by_role('status').inner_text());self.assertEqual(self.page.evaluate('generation'),1)
        self.assert_display(before)

    def roundtrip(self, invert, colormap, reset, lut='LINEAR'):
        p = self.page
        p.evaluate('([invert,colormap,lut])=>seed(invert,colormap,lut)', [invert, colormap, lut])
        before = p.evaluate('observe()')
        p.get_by_label('Job Title', exact=True).fill('Synthetic comparison')
        p.get_by_role('button', name='Save New Job', exact=True).click()
        expect(p.get_by_role('status')).to_contain_text('저장했습니다')
        p.evaluate('(reset)=>{window.resetAfterApply=reset}', reset)
        p.get_by_role('button', name='Restore Job', exact=True).click()
        expect(p.get_by_role('status')).to_contain_text('복원했습니다', timeout=20000)
        after = p.evaluate('observe()')
        self.assert_labels([1,2])
        self.assertEqual(self.page_errors, [], 'native fixture must load without page errors')
        print(json.dumps({'case': self.id(), 'invert': invert, 'grayscale_start': colormap,
                          'late_camera': reset, 'before': before, 'after': after,
                          'resets': p.evaluate('window.resetCount')}, ensure_ascii=False), flush=True)
        self.assertEqual(p.evaluate('window.resetCount'), int(reset), 'late native camera continuation actually ran')
        for old, new in zip(before, after):
            self.assertEqual(old['image'], new['image'])
            self.assertEqual(old['index'], new['index'])
            self.assertEqual(new['index'], new['target'])
            for key in ['voiRange', 'VOILUTFunction', 'invert', 'interpolationType']:
                self.assertEqual(old['properties'][key], new['properties'][key], key)
            for key in ['focalPoint', 'position', 'viewUp', 'viewPlaneNormal']:
                for a, b in zip(old['camera'][key], new['camera'][key]):
                    self.assertAlmostEqual(a, b, places=6, msg=key)
            for key in ['parallelScale', 'rotation', 'flipHorizontal', 'flipVertical']:
                self.assertAlmostEqual(old['camera'][key], new['camera'][key], places=6, msg=key)
            self.assertEqual(old['hash'], new['hash'], 'restored rendered pixels must equal saved rendered pixels')

    def test_T04_control_invert_default(self):
        self.roundtrip(True, False, False)

    def test_T04_control_invert_grayscale(self):
        self.roundtrip(True, True, False)

    def test_T05_repeat_invert_default(self):
        self.roundtrip(True, False, True)

    def test_T05_repeat_invert_grayscale(self):
        self.roundtrip(True, True, True)

    def test_T04_control_no_invert_default(self):
        self.roundtrip(False, False, False)

    def test_T04_control_no_invert_grayscale(self):
        self.roundtrip(False, True, False)

    def test_T04_repeat_no_invert_default(self):
        self.roundtrip(False, False, True)

    def test_T04_repeat_no_invert_grayscale(self):
        self.roundtrip(False, True, True)

    def test_T04_repeat_sigmoid_invert(self):
        self.roundtrip(True, True, True, 'SIGMOID')

    def test_T04_repeat_sigmoid_no_invert(self):
        self.roundtrip(False, True, True, 'SIGMOID')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(verbosity=2)
