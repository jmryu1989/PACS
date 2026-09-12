# coding: utf-8
"""TEST-D09-JOB-PRINT: saved native display, immutable source and read-only output."""
import base64, copy, io, json, sys, unittest, uuid
from pathlib import Path
import numpy as np
from PIL import Image
from pypdf import PdfReader
from pydicom import dcmread
from playwright.sync_api import expect
from test_viewer_jobs import ViewerJobsE2E, literal, psql, canvas_ready


class ViewerJobPrintE2E(ViewerJobsE2E):
 def v2(self, fixtures, width=600, height=400):
  command=self.command(fixtures);command['snapshot']['version']=2
  for cell in command['snapshot']['cells']:
   cell['viewport']=dict(width=width,height=height);cell['properties']['interpolationType']=1
  return command

 def saved(self,p,f):
  p.get_by_label('Job Title',exact=True).fill('저장 화면 <img src=x onerror=alert(1)>')
  self.click_job(p,'Save New Job','저장했습니다');return self.jobs(f)[0]

 def output(self,p):
  p.get_by_role('button',name='Print Saved Images',exact=True).first.click()
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=45000)
  return p.frame_locator('#kin-job-print iframe')

 def pngs(self,p):
  return p.evaluate('''()=>[...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).map(g=>{
   const v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);return g.displaySetInstanceUIDs?.length?v.getCanvas().toDataURL():null;
  })''')

 # Per-viewport observation for pixel-preservation checks: backing-store and
 # element size, dock state, image and camera, plus a size/hash of the canvas
 # PNG. Printed per stage so a CI mismatch names what moved (integration run
 # 34614022650: test_compare_reports_01 baseline vs after-print PNGs differed).
 VIEWPORT_STATE='''stage=>[...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).map(g=>{
   const v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);if(!g.displaySetInstanceUIDs?.length||!v)return null;
   const c=v.getCanvas(),r=v.element.getBoundingClientRect(),png=c.toDataURL();let hash=0;for(let i=0;i<png.length;i+=7)hash=(hash*31+png.charCodeAt(i))>>>0;
   return {stage,id:g.viewportId,canvas:[c.width,c.height],element:[Math.round(r.width),Math.round(r.height)],dpr:window.devicePixelRatio,
    dockOpen:document.body.classList.contains('kin-dock-open'),image:v.getCurrentImageId?.()??null,index:v.getCurrentImageIdIndex?.()??null,
    camera:v.getCamera?.()??null,properties:v.getProperties?.()??null,pngLength:png.length,pngHash:hash};
  })'''
 # canvas_ready only proves that some image is painted. The dock panel opened by
 # launch_job shrinks #root afterwards and OHIF resizes the canvases on the
 # following resize event, so a baseline taken before that lands differs from
 # every later capture. Settled means: every backing store already matches its
 # element box, an image is bound, and two animation frames paint identically.
 SETTLED='''async()=>{
   const frame=()=>new Promise(r=>requestAnimationFrame(()=>r()));
   const cells=[...services.viewportGridService.getState().viewports.values()].filter(g=>g.displaySetInstanceUIDs?.length);
   const state=()=>cells.map(g=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);if(!v)return null;
    const c=v.getCanvas(),r=v.element.getBoundingClientRect(),dpr=window.devicePixelRatio;
    return {fit:Math.abs(c.width-r.width*dpr)<=1.5&&Math.abs(c.height-r.height*dpr)<=1.5,image:v.getCurrentImageId?.()??null,png:c.toDataURL()};});
   const first=state();if(!first.length||first.some(s=>!s||!s.fit||!s.image))return false;
   await frame();await frame();
   const second=state();return first.every((s,i)=>second[i]&&second[i].fit&&second[i].image===s.image&&second[i].png===s.png);
  }'''

 def observe(self,p,stage):
  state=p.evaluate(self.VIEWPORT_STATE,stage);print('VIEWPORT_STATE '+json.dumps(state),flush=True);return state

 def settled_pngs(self,p):
  p.wait_for_function(self.SETTLED,timeout=60000);return self.pngs(p)

 def assert_pixels_kept(self,p,pixels,before,stage):
  after=self.observe(p,stage)
  if self.pngs(p)!=pixels:
   # The full data-URL diff is useless; the observations say what moved.
   self.fail('viewer pixels changed between %s and %s: %s'%(before[0]['stage'] if before and before[0] else 'baseline',stage,json.dumps(dict(before=before,after=after))))

 def arrays(self,values):return [np.array(Image.open(io.BytesIO(base64.b64decode(x.split(',')[1]))).convert('RGB')) if x else None for x in values]

 def output_arrays(self,p,paper):
  values=paper.locator('img').evaluate_all('''async imgs=>Promise.all(imgs.map(async img=>{
    await img.decode();const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;c.getContext('2d').drawImage(img,0,0);return c.toDataURL();
  }))''')
  return self.arrays(values)

 def test_print_01_v1_compatible_v2_validation_and_replay(self):
  f=self.ct('JOBPRINT-'+uuid.uuid4().hex[:12],'current','20260801')
  legacy=self.post(f,self.command([f]));self.assertEqual(self.stack.request('GET',f'/studies/{f.uid}/viewer-jobs/{legacy["id"]}','doctor').body['snapshot']['version'],1)
  command=self.v2([f]);j=self.post(f,command);self.assertEqual(self.post(f,command)['id'],j['id'])
  read=self.stack.request('GET',f'/studies/{f.uid}/viewer-jobs/{j["id"]}','doctor');self.assertEqual(read.body['snapshot']['cells'][0]['viewport'],dict(width=600,height=400))
  for viewport in [dict(width=0,height=400),dict(width=600.5,height=400),dict(width=8193,height=400),dict(width=8192,height=8192),dict(width=600,height=400,extra=1)]:
   bad=self.v2([f]);bad['snapshot']['cells'][0]['viewport']=viewport;self.post(f,bad,status=400)
  bad=self.v2([f]);bad['snapshot']['version']=1;self.post(f,bad,status=400)
  bad=self.v2([f]);bad['snapshot'].update(rows=2,cols=2,cells=[copy.deepcopy(bad['snapshot']['cells'][0]) for _ in range(4)])
  for c in bad['snapshot']['cells']:c['viewport']=dict(width=4096,height=4096)
  self.post(f,bad,status=400)
  bad=self.v2([f]);bad['snapshot']['cells'][0]['properties']['interpolationType']=3;self.post(f,bad,status=400)

 def test_print_08_optional_asset_failure_and_save_size_guidance(self):
  f=self.ct('JOBPRINT-'+uuid.uuid4().hex[:12],'current','20260801');p=self.launch_job([f]);canvas_ready(p,1)
  self.assertEqual(p.evaluate('typeof window.kinViewerJobPrint'),'undefined')
  self.saved(p,f);self.assertEqual(len(self.jobs(f)),1)
  errors=[];p.on('pageerror',lambda error:errors.append(str(error)))
  asset='**/worklist/hpacs-lite/viewer-job-print.js'
  for body in [None,'void 0;']:
   p.route(asset,lambda route:route.fulfill(status=404 if body is None else 200,content_type='application/javascript',body=body or ''))
   self.click_job(p,'Print Saved Images','출력 화면을 불러오지 못했습니다')
   self.assertEqual(p.locator('#kin-job-print').count(),0)
   self.click_job(p,'Restore Job','복원했습니다')
   p.unroute(asset)
  p.get_by_label('Job Title',exact=True).fill('화면 크기 실패 뒤 보존')
  for width,height,message in [(0,400,'영상 화면 크기가 준비되지'),(8192,4096,'브라우저 창 크기나 배율을 줄인')]:
   p.evaluate('''([width,height])=>{const state=services.viewportGridService.getState();const v=services.cornerstoneViewportService.getCornerstoneViewport(state.activeViewportId);
    window.__jobSizeViewport=v;window.__jobSizeGetCanvas=v.getCanvas;v.getCanvas=()=>({width,height});}''',[width,height])
   try:
    self.click_job(p,'Save New Job',message)
    expect(p.get_by_label('Job Title',exact=True)).to_have_value('화면 크기 실패 뒤 보존')
    self.assertEqual(len(self.jobs(f)),1)
   finally:p.evaluate('()=>{window.__jobSizeViewport.getCanvas=window.__jobSizeGetCanvas;delete window.__jobSizeViewport;delete window.__jobSizeGetCanvas;}')
  self.click_job(p,'Save New Job','저장했습니다');self.assertEqual(len(self.jobs(f)),2)
  self.output(p);self.assertEqual(p.locator('#kin-job-print').count(),1);self.assertEqual(errors,[])

 def test_print_02_saved_pixels_two_studies_other_screen_pdf(self):
  patient='JOBPRINT-'+uuid.uuid4().hex[:12];a=self.ct(patient,'current','20260801');b=self.ct(patient,'past','20260701')
  self.seed_report(a);originals=self.originals();reports={f.uid:self.report_rows(f) for f in [a,b]}
  p=self.launch_job([a,b]);self.grid(p,2);self.drag(p,'D03A current',0);self.drag(p,'D03A past',1);canvas_ready(p,2)
  self.choose(p,0);p.keyboard.press('ArrowDown');self.gesture(p,'Zoom',0,35);self.gesture(p,'Pan',35,20)
  for key in ['2','r','h','v','i']:p.keyboard.press(key)
  self.choose(p,1);p.keyboard.press('ArrowDown');p.keyboard.press('1');p.wait_for_timeout(200)
  expected=self.arrays(self.pngs(p));job=self.saved(p,a);p.close()
  p=self.launch_job([a]);p.set_viewport_size(dict(width=1100,height=850));canvas_ready(p,1)
  # ResizeObserver/native rendering can finish after a nonblank old canvas.
  # Complete that layout before taking the workspace-preservation baseline.
  p.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  canvas_ready(p,1)
  before=self.pngs(p);paper=self.output(p);actual=self.output_arrays(p,paper)
  errors=[]
  for x,y in zip(expected,actual):
   self.assertEqual(x.shape,y.shape);error=np.abs(x.astype(int)-y.astype(int));errors.append(dict(max=int(error.max()),mean=float(error.mean())))
   self.assertLessEqual(int(error.max()),2)
  self.assertEqual(len(actual),2);self.assertEqual(self.pngs(p),before)
  expect(paper.locator('main')).to_contain_text('주석 미포함');expect(paper.locator('main')).to_contain_text(patient)
  self.assertEqual(paper.locator('script').count(),0)
  p.evaluate('''()=>{const open=window.open;window.open=(...args)=>{const w=open(...args);if(w)w.print=()=>w.__printCalled=true;return w}}''')
  with p.expect_popup() as opened:p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF').click()
  printed=opened.value;printed.wait_for_function('()=>window.__printCalled===true')
  output=Path(__file__).parent/'artifacts/job-print.pdf';printed.pdf(path=str(output),prefer_css_page_size=True)
  pdf=PdfReader(output);self.assertGreaterEqual(len(pdf.pages),1)
  embedded=[]
  for page in pdf.pages:
   self.assertIn(patient,page.extract_text());embedded += [np.array(img.image.convert('RGB')) for img in page.images]
  self.assertEqual(len(embedded),2)
  for x in actual:self.assertTrue(any(x.shape==y.shape and np.array_equal(x,y) for y in embedded))
  print('JOBPRINT pixel/PDF '+json.dumps(dict(errors=errors,pages=len(pdf.pages),job=job['id'])),flush=True)
  self.assertEqual(self.originals(),originals)
  for f in [a,b]:self.assertEqual(self.report_rows(f),reports[f.uid])

 def test_print_03_four_cells_empty_cell_and_unsaved_preserved(self):
  f=self.ct('JOBPRINT-'+uuid.uuid4().hex[:12],'current','20260801');p=self.launch_job([f])
  self.grid(p,4);self.drag(p,'D03A current',0);self.drag(p,'D03A current',1);self.drag(p,'D03A current',3)
  self.choose(p,1);p.keyboard.press('ArrowDown');self.choose(p,3);p.keyboard.press('ArrowDown');p.keyboard.press('ArrowDown');p.wait_for_timeout(200)
  expected=[x for x in self.arrays(self.pngs(p)) if x is not None]
  p.get_by_label('Description',exact=True).fill('긴 한국어 비교 작업 설명\n'*45);self.saved(p,f)
  self.choose(p,0)
  p.locator('[data-cy="MeasurementTools-split-button-secondary"]').click();p.get_by_text('Annotation',exact=True).click()
  box=p.locator('.cornerstone-canvas').first.bounding_box();x,y=box['x']+box['width']*.47,box['y']+box['height']*.47
  p.mouse.move(x,y);p.mouse.down();p.mouse.move(x+45,y+28,steps=8);p.mouse.up()
  p.get_by_placeholder('Enter label').fill('출력 중 보존할 미저장 표식');p.get_by_role('button',name='Save',exact=True).click()
  row=p.locator('#kin-viewer-history section[data-kind=arrow]').last
  p.get_by_label('Job Title',exact=True).fill('아직 저장하지 않은 제목');p.get_by_label('Description',exact=True).fill('내 설명')
  before=self.pngs(p);paper=self.output(p);actual=self.output_arrays(p,paper)
  self.assertEqual(len(actual),3);expect(paper.locator('.cell')).to_have_count(4);expect(paper.locator('.cell').nth(2)).to_contain_text('빈 셀')
  for x,y in zip(expected,actual):self.assertTrue(np.array_equal(x,y))
  self.assertEqual(self.pngs(p),before)
  p.evaluate('''()=>{const open=window.open;window.open=(...args)=>{const w=open(...args);if(w)w.print=()=>w.__printCalled=true;return w}}''')
  with p.expect_popup() as opened:p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF').click()
  printed=opened.value;printed.wait_for_function('()=>window.__printCalled===true')
  output=Path(__file__).parent/'artifacts/job-print-grid.pdf';printed.pdf(path=str(output),prefer_css_page_size=True)
  pdf=PdfReader(output);self.assertGreaterEqual(len(pdf.pages),2)
  self.assertEqual(sum(len(page.images) for page in pdf.pages),3)
  for page in pdf.pages:self.assertIn(f.patient_id,page.extract_text())
  print('JOBPRINT four cells PDF '+json.dumps(dict(pages=len(pdf.pages))),flush=True)
  p.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click()
  expect(row.get_by_label('Annotation Text')).to_have_value('출력 중 보존할 미저장 표식')
  expect(p.get_by_label('Job Title',exact=True)).to_have_value('아직 저장하지 않은 제목');self.assertTrue(p.evaluate('()=>kinViewerHistoryHasUnsaved()'))
  self.assertEqual(p.evaluate("()=>cornerstone.getRenderingEngines().filter(e=>e.id.startsWith('kin-print-')).length"),0)

 def test_print_04_failure_retry_close_late_response_and_v1(self):
  f=self.ct('JOBPRINT-'+uuid.uuid4().hex[:12],'current','20260801');p=self.launch_job([f]);self.saved(p,f)
  pattern='**/instances/*/frames/0/image-uint16'
  def fail(route):route.fulfill(status=503,body='synthetic unavailable')
  p.route(pattern,fail);p.get_by_role('button',name='Print Saved Images',exact=True).click()
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('읽지 못했습니다');expect(p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF')).to_be_disabled()
  p.unroute(pattern,fail);p.locator('#kin-job-print').get_by_role('button',name='다시 확인').click()
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인')
  held=[]
  def hold(route):held.append((route,route.fetch()))
  p.route(pattern,hold);p.locator('#kin-job-print').get_by_role('button',name='다시 확인').click()
  for _ in range(100):
   if held:break
   p.wait_for_timeout(50)
  self.assertTrue(held);p.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click()
  held[0][0].fulfill(response=held[0][1]);p.unroute(pattern,hold)
  expect(p.locator('#kin-job-print')).not_to_be_visible();self.assertEqual(p.locator('#kin-job-print iframe').get_attribute('srcdoc'),'')
  self.assertEqual(p.evaluate("()=>cornerstone.getRenderingEngines().filter(e=>e.id.startsWith('kin-print-')).length"),0)
  legacy=self.post(f,self.command([f]));self.click_job(p,'Refresh Jobs','목록입니다.')
  p.get_by_role('button',name='Print Saved Images',exact=True).first.click()
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('이전 작업에는 화면 크기가 없습니다')
  expect(p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF')).to_be_disabled()

 def test_print_05_print_rechecks_hidden_prior_permission_and_session(self):
  patient='JOBPRINT-'+uuid.uuid4().hex[:12];a=self.ct(patient,'current','20260801');b=self.ct(patient,'past','20260701')
  self.post(a,self.v2([a,b]));p=self.launch_job([a]);self.output(p);j=self.jobs(a)[0]
  revised=self.revised(j);revised.update(hidden=True,reason='출력 도중 숨김');self.post(a,revised,suffix='/'+j['id']+'/revisions')
  with p.expect_popup() as opened:p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF').click()
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('변경되었습니다');self.assertTrue(opened.value.is_closed())
  p.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click()
  j=self.jobs(a,suffix='?includeHidden=true')[0];revised=self.revised(j);revised.update(hidden=False,reason='시험 복원');self.post(a,revised,suffix='/'+j['id']+'/revisions')
  self.output(p)
  psql(f'UPDATE "StudyState" SET rs=\'P\', "preDoc"=\'other\', "preReviewer"=\'other2\' WHERE uid={literal(b.uid)}')
  try:
   with p.expect_popup() as opened:p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF').click()
   expect(p.locator('#kin-job-print')).not_to_be_visible();self.assertTrue(opened.value.is_closed())
  finally:psql(f'UPDATE "StudyState" SET rs=\'W\', "preDoc"=NULL, "preReviewer"=NULL WHERE uid={literal(b.uid)}')
  p.close();p=self.launch_job([a]);self.output(p)
  # relog silently replaces cookies; it does not emit the logout broadcast.
  # The fallback checks after 15 s on a 1 s tick, then awaits the server.
  work=p.context.new_page();self.relog(work,'doctor2');expect(p.locator('#kin-job-print')).not_to_be_visible(timeout=30000)

 def test_print_06_actual_source_replacement_blocks_cached_display(self):
  f=self.ct('JOBPRINT-'+uuid.uuid4().hex[:12],'current','20260801');p=self.launch_job([f]);j=self.saved(p,f);self.output(p)
  job=self.stack.request('GET',f'/studies/{f.uid}/viewer-jobs/{j["id"]}','doctor').body
  sop=job['snapshot']['cells'][0]['sop'];instance=self.stack._orthanc_request('POST','/tools/lookup',sop.encode()).body[0]['ID'];path='/instances/'+instance
  raw=self.stack.orthanc_bytes(path+'/file');ds=dcmread(io.BytesIO(raw));self.assertEqual(str(ds.StudyInstanceUID),f.uid);self.assertEqual(str(ds.PatientID),f.patient_id)
  ds.PixelData=(ds.pixel_array.astype(np.int16)+37).astype('<i2').tobytes();stream=io.BytesIO();ds.save_as(stream,write_like_original=False);replacement=stream.getvalue()
  def replace(expected,updated):
   self.assertIn(f.uid,self.stack.active);self.assertEqual(self.stack.orthanc_bytes(path+'/file'),expected)
   self.assertEqual(self.stack._orthanc_request('DELETE',path).status,200)
   self.assertEqual(self.stack._orthanc_request('POST','/instances',updated).status,200);self.assertEqual(self.stack.orthanc_bytes(path+'/file'),updated)
  before=self.pngs(p);replace(raw,replacement)
  try:
   with p.expect_popup() as opened:p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF').click()
   expect(p.locator('#kin-job-print [role=status]')).to_contain_text('원본과 달라')
   # Closing can arrive before a later event listener is registered. Observe
   # retained page state while pumping the opener, with the same 15 s budget.
   for _ in range(300):
    if opened.value.is_closed():break
    p.wait_for_timeout(50)
   self.assertTrue(opened.value.is_closed())
   p.locator('#kin-job-print').get_by_role('button',name='다시 확인').click();expect(p.locator('#kin-job-print [role=status]')).to_contain_text('원본과 달라')
   self.assertEqual(self.pngs(p),before)
  finally:replace(replacement,raw)
  p.locator('#kin-job-print').get_by_role('button',name='다시 확인').click();expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인')

 def test_print_07_signed_rescale_unequal_spacing_voi_and_device_scale(self):
  f=self.ct('JOBPRINT-'+uuid.uuid4().hex[:12],'current','20260801')
  instance=self.stack.first_instance_id(f.uid);path='/instances/'+instance;raw=self.stack.orthanc_bytes(path+'/file');ds=dcmread(io.BytesIO(raw))
  self.assertEqual(str(ds.StudyInstanceUID),f.uid);self.assertEqual(str(ds.PatientID),f.patient_id)
  ds.PixelRepresentation=1;ds.PixelData=(ds.pixel_array.astype(np.int32)-2000).astype('<i2').tobytes()
  ds.RescaleSlope=2;ds.RescaleIntercept=-1024;ds.WindowCenter=-4000;ds.WindowWidth=4000
  ds.PixelSpacing=[.7,1.3];ds.ImageOrientationPatient=[.8,.6,0,-.6,.8,0]
  stream=io.BytesIO();ds.save_as(stream,write_like_original=False);replacement=stream.getvalue()
  def replace(expected,updated):
   self.assertIn(f.uid,self.stack.active);self.assertEqual(self.stack.orthanc_bytes(path+'/file'),expected)
   self.assertEqual(self.stack._orthanc_request('DELETE',path).status,200);self.assertEqual(self.stack._orthanc_request('POST','/instances',updated).status,200)
  replace(raw,replacement)
  try:
   p=self.launch_job([f])
   # Select the exact replaced SOP through the native viewport; other slices
   # intentionally retain the original geometry and cannot be used as oracle.
   p.evaluate('''async sop=>{const v=cornerstone.getEnabledElements()[0].viewport;const index=v.getImageIds().findIndex(id=>cornerstone.metaData.get('instance',id).SOPInstanceUID===sop);await v.setImageIdIndex(index);v.render()}''',str(ds.SOPInstanceUID))
   for voi in ['LINEAR_EXACT','SIGMOID']:
    p.evaluate('''voi=>{const v=cornerstone.getEnabledElements()[0].viewport;v.setProperties({voiRange:{lower:-6000,upper:-1500},VOILUTFunction:voi,invert:true,interpolationType:voi==='LINEAR_EXACT'?0:2});v.render()}''',voi);p.wait_for_timeout(150)
    expected=self.arrays(self.pngs(p))[0];self.saved(p,f)
    for dpr in [2,1.25]:
     context=self.browser.new_context(ignore_https_errors=True,viewport=dict(width=1050,height=800),device_scale_factor=dpr,storage_state=p.context.storage_state())
     try:
      q=self.launch_job_page(context,f);paper=self.output(q);actual=self.output_arrays(q,paper)[0]
      self.assertEqual(expected.shape,actual.shape);error=np.abs(expected.astype(int)-actual.astype(int));self.assertLessEqual(int(error.max()),2)
      print('JOBPRINT signed geometry '+json.dumps(dict(voi=voi,dpr=dpr,max=int(error.max()))),flush=True)
     finally:context.close()
  finally:replace(replacement,raw)

 def launch_job_page(self,context,f):
  p=context.new_page();self.launch(p,[f]);expect(p.locator('#kin-viewer-jobs-status')).to_contain_text('목록입니다.');return p

def load_tests(loader,tests,pattern):return unittest.TestSuite(ViewerJobPrintE2E(n) for n in loader.getTestCaseNames(ViewerJobPrintE2E) if n.startswith('test_print_'))
if __name__=='__main__':
 sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
