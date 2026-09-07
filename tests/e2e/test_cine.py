# coding: utf-8
"""Native cine controls, real multiframe pixels and selected-stack lifecycle."""
import copy,io,json,unittest,uuid
from pathlib import Path
import numpy as np
from pydicom import dcmread
from pydicom.uid import generate_uid
from playwright.sync_api import expect
from test_viewer_layout import ViewerLayoutE2E
from test_prior_selection import canvas_ready

class CineE2E(ViewerLayoutE2E):
 def series(self,f,count,label):
  ds=next(d for d in (dcmread(io.BytesIO(self.stack.orthanc_bytes(path))) for path in self.originals()) if d.Modality=='CT')
  ds.PatientID=f.patient_id;ds.StudyInstanceUID=f.uid;ds.SeriesInstanceUID=generate_uid();ds.SOPInstanceUID=generate_uid()
  ds.SOPClassUID='1.2.840.10008.5.1.4.1.1.3.1';ds.Modality='US';ds.SeriesDescription=label;ds.SeriesNumber=count
  ds.file_meta.MediaStorageSOPClassUID=ds.SOPClassUID;ds.file_meta.MediaStorageSOPInstanceUID=ds.SOPInstanceUID
  original_pixels=ds.pixel_array.copy();ds.NumberOfFrames=count;ds.FrameTime=100;ds.CineRate=10
  frames=[]
  for n in range(count):
   a=original_pixels.copy();a[:]=0;a[30:70,30:60]=700;a[90:120,35+n*10:45+n*10]=1800;frames.append(a)
  ds.PixelData=np.stack(frames).astype(original_pixels.dtype).tobytes()
  stream=io.BytesIO();ds.save_as(stream,write_like_original=False)
  self.assertEqual(self.stack._orthanc_request('POST','/instances',stream.getvalue()).status,200)
  return dict(study=f.uid,series=str(ds.SeriesInstanceUID),sops=[str(ds.SOPInstanceUID)],frames=count,label=label)

 def pair(self):
  f=self.ct('CINE-'+uuid.uuid4().hex[:12],'current','20260801')
  return f,self.series(f,12,'CINE twelve'),self.series(f,7,'CINE seven')

 def open_cine(self,f,refs,p=None):
  p=self.launch(p or self.login(),[f]);self.grid(p,len(refs))
  for i,r in enumerate(refs):self.drag(p,r['label'],i)
  self.identity(p,refs);self.select_cell(p,0)
  if not p.evaluate('services.cineService.getState().isCineEnabled'):
   p.locator('[data-cy="MoreTools-split-button-secondary"]').click();p.locator('[data-cy="Cine"]').click()
  expect(p.locator('#kin-cine')).to_be_visible();return p

 def select_cell(self,p,i):
  box=p.locator('[data-cy=viewport-grid] > div').nth(i).locator('canvas').bounding_box()
  p.mouse.click(box['x']+box['width']*.5,box['y']+box['height']*.3)

 def snapshot(self,p):
  return p.evaluate('''()=>[...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.x-b.x).map(g=>{
   const v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);return {id:g.viewportId,index:v?.getCurrentImageIdIndex?.(),image:v?.getCurrentImageId?.(),playing:!!services.cineService.getState().cines[g.viewportId]?.isPlaying};})''')

 def play(self,p,i=0):p.locator('[data-cy=viewport-grid] > div').nth(i).locator('[data-cy="cine-player-play-pause"]').click()
 def watch(self,p):
  p.evaluate('''()=>{window.cineRenders=[];for(const v of cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports())){
   v.element.addEventListener(cornerstone.Enums.Events.IMAGE_RENDERED,()=>{const i=v.getCurrentImageIdIndex(),image=v.getCurrentImageId(),c=v.element.querySelector('.cornerstone-canvas');
   const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let hi=0;for(let n=0;n<pixels.length;n+=4)hi=Math.max(hi,pixels[n]);
   const origin=cornerstone.metaData.get('imagePlaneModule',image).imagePositionPatient,xy=v.worldToCanvas([origin[0]+40+i*10,origin[1]+105,origin[2]]);
   const marker=c.getContext('2d').getImageData(Math.round(xy[0]),Math.round(xy[1]),1,1).data[0];
   cineRenders.push({id:v.id,index:i,image,t:performance.now(),hi,marker});});}}''')

 def wait_index(self,p,i,n):p.wait_for_function('a=>services.cornerstoneViewportService.getCornerstoneViewport([...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.x-b.x)[a[0]].viewportId).getCurrentImageIdIndex()===a[1]',arg=[i,n])

 def test_cine_01_direction_loop_bounds_and_resume(self):
  f,a,b=self.pair();originals=self.originals();rows=self.report_rows(f);p=self.open_cine(f,[a]);self.watch(p)
  p.get_by_role('button',name='첫 프레임',exact=True).click();self.wait_index(p,0,0)
  self.play(p);p.wait_for_timeout(2500);self.play(p);stopped=self.snapshot(p);p.wait_for_timeout(450);self.assertEqual(self.snapshot(p),stopped)
  data=p.evaluate('cineRenders');print('CINE forward '+json.dumps(data),flush=True)
  self.assertGreater(len(data),18);self.assertTrue(all(x['marker']>200 and '/frames/'+str(x['index']+1) in x['image'] for x in data))
  self.assertTrue(all((y['index']-x['index'])%12==1 for x,y in zip(data,data[1:])))
  fps=(len(data)-1)*1000/(data[-1]['t']-data[0]['t']);self.assertGreater(fps,8);self.assertLess(fps,12);print('CINE 10fps measured '+str(fps),flush=True)
  p.get_by_label('재생 방향').select_option('reverse');p.get_by_label('반복',exact=True).uncheck()
  p.get_by_role('button',name='끝 프레임',exact=True).click();self.wait_index(p,0,11)
  p.wait_for_function('()=>cineRenders.at(-1)?.index===11');p.evaluate('()=>{cineRenders=[]}');self.play(p);self.wait_index(p,0,0)
  p.wait_for_timeout(350);self.assertFalse(self.snapshot(p)[0]['playing']);self.assertEqual(self.snapshot(p)[0]['index'],0)
  reverse=p.evaluate('cineRenders');self.assertEqual([r['index'] for r in reverse],list(range(10,-1,-1)));self.assertTrue(all(r['marker']>200 for r in reverse));print('CINE reverse '+json.dumps(reverse),flush=True)
  p.get_by_label('재생 방향').select_option('forward');self.play(p);self.wait_index(p,0,11);p.wait_for_timeout(350);self.assertFalse(self.snapshot(p)[0]['playing'])
  p.screenshot(path=str(Path(__file__).parent/'artifacts/CINE-controls.png'))
  self.assertEqual(self.originals(),originals);self.assertEqual(self.report_rows(f),rows)

 def test_cine_02_selected_cell_speed_and_replacement(self):
  f,a,b=self.pair();self.seed_report(f)
  values=dict(findings='Cine draft',conclusion='Preserved conclusion',recommendation='Preserved recommendation')
  self.assertEqual(self.stack.request('PUT','/studies/'+f.uid+'/report','doctor',dict(values,baseVersion=1)).status,200)
  self.assertEqual(self.stack.request('POST','/studies/'+f.uid+'/hold','doctor').status,201)
  original=self.originals();rows=self.report_rows(f);p=self.open_cine(f,[a,b]);self.watch(p)
  self.play(p,0);p.wait_for_timeout(450);self.assertEqual(self.snapshot(p)[1]['index'],0)
  self.select_cell(p,1);before=self.snapshot(p)[0];self.play(p,1);p.wait_for_timeout(850);self.assertEqual(self.snapshot(p)[0],before)
  self.play(p,1)
  for _ in range(5):p.locator('[data-cy=viewport-grid] > div').nth(1).locator('[data-cy="cine-player-left-arrow"]').click()
  p.evaluate('()=>{cineRenders=[]}');self.play(p,1);p.wait_for_timeout(2500);self.play(p,1)
  data=p.evaluate('cineRenders');seq=[r for r in data if r['id']==self.snapshot(p)[1]['id']]
  fps=(len(seq)-1)*1000/(seq[-1]['t']-seq[0]['t']);print('CINE 5fps '+json.dumps(dict(fps=fps,renders=seq)),flush=True)
  self.assertGreater(fps,4);self.assertLess(fps,6);self.assertTrue(all((y['index']-x['index'])%7==1 for x,y in zip(seq,seq[1:])))
  self.play(p,1);self.drag(p,'D03A current',1);p.wait_for_timeout(500);before=self.snapshot(p);print('CINE replacement '+json.dumps(before),flush=True);p.wait_for_timeout(450);self.assertEqual(self.snapshot(p),before);self.assertFalse(before[1]['playing'])
  self.grid(p,1);p.wait_for_timeout(300);self.assertTrue(all(not x['playing'] for x in self.snapshot(p)))
  self.assertEqual(self.originals(),original);self.assertEqual(self.report_rows(f),rows)

 def test_cine_03_delayed_stop_and_access_failure(self):
  f,a,b=self.pair();p=self.open_cine(f,[a]);pending=[]
  pattern='**/api/me';p.route(pattern,lambda r:pending.append(r))
  self.play(p);p.wait_for_timeout(250);self.assertTrue(pending);self.play(p);before=self.snapshot(p)
  for r in pending:r.fulfill(response=r.fetch())
  p.unroute(pattern);p.wait_for_timeout(500);self.assertEqual(self.snapshot(p),before)
  p.route(pattern,lambda r:r.fulfill(status=403,json={'message':'Synthetic denied'}));self.play(p)
  expect(p.locator('#kin-cine [role=status]')).to_contain_text('준비할 수 없습니다');self.assertFalse(self.snapshot(p)[0]['playing']);p.unroute(pattern)
  self.play(p);p.wait_for_timeout(350);p.locator('[data-cy="cine-player-close"]').click();expect(p.locator('#kin-cine')).not_to_be_visible()
  before=self.snapshot(p);p.wait_for_timeout(500);self.assertEqual(self.snapshot(p),before)

 def test_cine_04_logout_and_spa_exit(self):
  f,a,b=self.pair();work=self.login();p=self.open_cine(f,[a],work.context.new_page());self.play(p);p.wait_for_timeout(350)
  work.once('dialog',lambda d:d.accept());work.locator('#logout').click();work.wait_for_url('**/worklist/hpacs-lite/index.html')
  before=self.snapshot(p);p.wait_for_timeout(500);self.assertEqual(self.snapshot(p),before);self.assertFalse(before[0]['playing']);expect(p.locator('#kin-cine')).not_to_be_visible()
  p=self.open_cine(f,[a]);self.play(p);p.wait_for_timeout(350);p.evaluate('()=>{window.cineExitMarker=true}');p.mouse.click(20,24)
  expect(p.locator('#kin-cine')).to_have_count(0);self.assertTrue(p.evaluate('window.cineExitMarker===true'));self.assertNotIn('/ohif/viewer?',p.url)

 def test_cine_05_delayed_image_replacement_and_failure(self):
  f,a,b=self.pair();p=self.login();pending=[];pattern='**/instances/'+a['sops'][0]+'/frames/8'
  p.route(pattern,lambda r:pending.append(r));self.open_cine(f,[a],p);self.play(p);p.wait_for_timeout(350);self.assertTrue(pending)
  self.drag(p,'CINE seven',0);self.identity(p,[b]);before=self.snapshot(p)
  for r in pending:r.fulfill(response=r.fetch())
  p.unroute(pattern);p.wait_for_timeout(500);self.assertEqual(self.snapshot(p),before);self.assertFalse(before[0]['playing'])
  p.close();p=self.login();p.route(pattern,lambda r:r.fulfill(status=500,body='Synthetic unavailable'))
  self.open_cine(f,[a],p);self.play(p);expect(p.locator('#kin-cine [role=status]')).to_contain_text('준비할 수 없습니다');self.assertEqual(self.snapshot(p)[0]['index'],0)
  p.unroute(pattern);self.play(p);p.wait_for_timeout(450);self.assertGreater(self.snapshot(p)[0]['index'],0)

 def test_cine_06_hidden_page_and_reload(self):
  f,a,b=self.pair();p=self.open_cine(f,[a]);self.play(p);p.wait_for_timeout(350)
  # Explicit visibility-event simulation; actual OS tab occlusion is not claimed by this headless test.
  p.evaluate("()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))}")
  before=self.snapshot(p);p.wait_for_timeout(450);self.assertEqual(self.snapshot(p),before);self.assertFalse(before[0]['playing'])
  p.evaluate("()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))}");p.wait_for_timeout(350);self.assertEqual(self.snapshot(p),before)
  p.reload();canvas_ready(p,1);p.wait_for_timeout(350);self.assertTrue(all(not x['playing'] for x in self.snapshot(p)))

if __name__=='__main__':
 suite=unittest.TestSuite(CineE2E(n) for n in dir(CineE2E) if n.startswith('test_cine_'))
 import sys
 sys.exit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
