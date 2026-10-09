# coding: utf-8
"""VR112-REQ-02 -> VR112-RISK-02: real pinned GPU stack / mounted Job panel.

Supply KIN_PINNED_OHIF_LIBRARY (a retained libOrthancOHIF.so, never a live
container). All browser requests are intercepted; no server or LiveStack is used.
The native bundle pin identifies the supported runtime, not product source text.
Only its application bootstrap is replaced to expose its unchanged native modules.
Job code is loaded whole, and assertions compare rendered pixels and saved state.
This does not certify the still-blocked native overlay/completion contract.
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
JOBS = Path(os.environ.get('KIN_VIEWER_JOBS_JS', ROOT / 'worklist-v0/hpacs-lite/viewer-jobs.js'))

HTML = '''<!doctype html><html><head><style>
body {margin:0} #views {display:flex} .view {position:relative;width:256px;height:256px}
</style></head><body><div id="views"></div>
<details id="kin-viewer-layout" open><summary>Layout</summary></details>
<script src="/native.js"></script></body></html>'''

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
        SOPInstanceUID:`1.2.${study}.1.${frame+1}`,SOPClassUID:'1.2.840.10008.5.1.4.1.1.2',InstanceNumber:frame+1});
    }
    stacks.push(ids); sets.push({displaySetInstanceUID:`series-${study}`,StudyInstanceUID:`1.2.${study}`,
      SeriesInstanceUID:`1.2.${study}.1`,images:ids.map(id=>refs.get(id))});
  }
  cs.metaData.addProvider((type,id) => {
    if (!refs.has(id)) return;
    const frame=Number(id.split(':')[2]);
    if (type==='instance') return refs.get(id);
    if (type==='imagePlaneModule') return {frameOfReferenceUID:'1.2.90',rows:64,columns:64,
      rowCosines:[1,0,0],columnCosines:[0,1,0],imagePositionPatient:[0,0,frame],rowPixelSpacing:1,columnPixelSpacing:1};
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
  const engine=new cs.RenderingEngine('synthetic-restore');
  let state={layout:{layoutType:'grid',numRows:1,numCols:2},viewports:new Map(),activeViewportId:null};
  window.trace=[]; window.resetAfterApply=false; window.resetCount=0;
  window.rendered = v => new Promise(resolve=>{
    const handler=()=>{v.element.removeEventListener(cs.Enums.Events.IMAGE_RENDERED,handler);resolve()};
    v.element.addEventListener(cs.Enums.Events.IMAGE_RENDERED,handler);v.render();
  });
  async function layout(options) {
    for(const id of state.viewports.keys())engine.disableElement(id);
    document.getElementById('views').replaceChildren();
    state={layout:{layoutType:'grid',numRows:options.numRows,numCols:options.numCols},viewports:new Map(),activeViewportId:options.activeViewportId};
    for(let i=0;i<options.numRows*options.numCols;i++) {
      const cell=options.findOrCreateViewport(i), id=cell.viewportOptions.viewportId;
      state.viewports.set(id,{...cell,viewportId:id,x:i/2,y:0,width:1/2,height:1});
      const el=document.createElement('div');el.className='view';document.getElementById('views').append(el);
      engine.enableElement({viewportId:id,type:cs.Enums.ViewportType.STACK,element:el});
      const v=engine.getViewport(id); const index=sets.findIndex(s=>s.displaySetInstanceUID===cell.displaySetInstanceUIDs[0]);
      await v.setStack(stacks[index],0);await window.rendered(v);
      if(window.resetAfterApply && i===0){
        const initial=v.getCamera();
        const reset=()=>{
          if(v.getCurrentImageIdIndex()!==1 || v.getCamera().parallelScale>=initial.parallelScale*.9)return;
          el.removeEventListener(cs.Enums.Events.IMAGE_RENDERED,reset);
          window.trace.push({event:'late-native-camera',before:v.getCamera()});
          window.resetCount++;v.setCamera(initial);v.render();
        };el.addEventListener(cs.Enums.Events.IMAGE_RENDERED,reset);
      }
    }
  }
  const grid={getState:()=>state,getActiveViewportId:()=>state.activeViewportId,
    setActiveViewportId:id=>{state.activeViewportId=id},setLayout:layout};
  window.services={viewportGridService:grid,cornerstoneViewportService:{getCornerstoneViewport:id=>engine.getViewport(id)},
    displaySetService:{getActiveDisplaySets:()=>sets}};
  await layout({numRows:1,numCols:2,activeViewportId:'initial-0',findOrCreateViewport:i=>({
    displaySetInstanceUIDs:[sets[i].displaySetInstanceUID],viewportOptions:{viewportId:`initial-${i}`}})});
  window.views=()=>[...state.viewports.keys()].map(id=>engine.getViewport(id));
  window.observe=()=>window.views().map(v=>{
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
      const camera=v.getCamera();v.setCamera({parallelScale:camera.parallelScale*.8,
        focalPoint:camera.focalPoint.map((n,j)=>n+(j===0?2:0)),position:camera.position.map((n,j)=>n+(j===0?2:0))});
      await window.rendered(v);
    }
    state.activeViewportId=[...state.viewports.keys()][1];
  };
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
        self.context = self.browser.new_context(viewport={'width': 1000, 'height': 800}, device_scale_factor=1)
        self.context.route('**/*', self.route)
        self.page = self.context.new_page()
        self.page.on('pageerror', lambda error: print('PAGEERROR', error, flush=True))
        self.page.goto(ORIGIN + '/ohif/viewer?StudyInstanceUIDs=1.2.1,1.2.2')
        self.page.evaluate(HARNESS)
        self.page.add_script_tag(path=str(ROOT / 'worklist-v0/hpacs-lite/session-transport.js'))
        self.page.add_script_tag(path=str(JOBS))
        self.page.evaluate('window.panel=kinViewerJobs(services,{scope:()=>({})});panel.mount()')
        expect(self.page.get_by_role('button', name='Save New Job', exact=True)).to_be_enabled()

    def tearDown(self):
        self.context.close()

    def route(self, route):
        if route.request.url.startswith(ORIGIN + '/native.js'):
            route.fulfill(content_type='application/javascript', body=self.app)
        elif route.request.url.startswith(ORIGIN + '/ohif/viewer?'):
            route.fulfill(content_type='text/html', body=HTML)
        else:
            route.abort()

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
