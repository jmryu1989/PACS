# coding: utf-8
"""REQ-D09-JOB-ANNOTATIONS: fixed historical revisions and saved CT coordinates."""
import copy,io,json,math,sys,unittest,uuid
import numpy as np
from pydicom import dcmread
from pathlib import Path
from pypdf import PdfReader
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from playwright.sync_api import expect
from test_viewer_job_print import ViewerJobPrintE2E,canvas_ready
from test_viewer_jobs import literal,psql
from test_viewer_history import ViewerHistoryE2E


class ViewerJobAnnotationsE2E(ViewerJobPrintE2E):
 def annotation(self,f,label,kind='arrow'):
  ds=dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/'+self.stack.first_instance_id(f.uid)+'/file')))
  origin=np.array(ds.ImagePositionPatient,dtype=float);orientation=np.array(ds.ImageOrientationPatient,dtype=float);spacing=np.array(ds.PixelSpacing,dtype=float)
  def point(x,y):return (origin+orientation[:3]*spacing[1]*float(ds.Columns)*x+orientation[3:]*spacing[0]*float(ds.Rows)*y).tolist()
  points=[point(.35,.35),point(.6,.55)]
  item=dict(schemaVersion=1,kind=kind,seriesUid=str(ds.SeriesInstanceUID),sopUid=str(ds.SOPInstanceUID),frame=1,
   frameOfReferenceUid=str(ds.FrameOfReferenceUID),label=label,points=points)
  if kind=='length':item.update(viewPlaneNormal=np.cross(orientation[:3],orientation[3:]).tolist(),viewUp=(-orientation[3:]).tolist(),
   baseline=dict(calculator='kin-native-manual-v1',values=[math.dist(*points)]))
  command=dict(requestId=str(uuid.uuid4()),item=item)
  r=self.stack.request('POST',f'/studies/{f.uid}/viewer-items','doctor',command);self.assertEqual(r.status,200,r.text);return r.body

 def change(self,f,head,action='edit',label=None):
  item=copy.deepcopy(head['item']);item.pop('hidden',None);item.pop('sourceDigest',None)
  if label is not None:item['label']=label
  command=dict(requestId=str(uuid.uuid4()),expectedRevision=head['revision'],action=action,reason='owned annotation test' if action in ['hide','restore'] else '',item=item)
  r=self.stack.request('POST',f'/studies/{f.uid}/viewer-items/{head["id"]}/revisions','doctor',command);self.assertEqual(r.status,200,r.text);return r.body

 def get_job(self,f,job,status=200,user='doctor'):
  r=self.stack.request('GET',f'/studies/{f.uid}/viewer-jobs/{job["id"]}',user);self.assertEqual(r.status,status,r.text);return r.body

 def test_annotations_01_revision_freeze_replay_hidden_and_scope(self):
  patient='JOBANN-'+uuid.uuid4().hex[:12];a=self.ct(patient,'current','20260801');b=self.ct(patient,'past','20260701');outside=self.ct(patient,'outside','20260601')
  arrow=self.annotation(a,'saved arrow');length=self.annotation(b,'saved length','length');self.annotation(outside,'not selected')
  command=self.v2([a,b]);command['snapshot']['version']=3;job=self.post(a,command);first=self.get_job(a,job)
  refs=first['snapshot']['annotations'];self.assertEqual({r['id'] for r in refs},{arrow['id'],length['id']})
  self.assertEqual({r['revision'] for r in refs},{1});self.assertEqual(len(first['annotations']),2)
  revised=self.change(a,arrow,label='later edit');self.change(a,revised,'hide');self.annotation(a,'later new arrow')
  self.post(a,command);second=self.get_job(a,job);self.assertEqual(second,first)
  next_command=self.v2([a,b]);next_command['snapshot']['version']=3;next_job=self.get_job(a,self.post(a,next_command))
  self.assertEqual({e['item']['label'] for e in next_job['annotations']},{'later new arrow','saved length'})
  legacy=self.get_job(a,self.post(a,self.v2([a,b])));self.assertNotIn('annotations',legacy);self.assertNotIn('annotations',legacy['snapshot'])
  forged=self.v2([a]);forged['snapshot']['version']=3;forged['snapshot']['annotations']=refs;self.post(a,forged,status=400)

 def test_annotations_02_visible_output_old_revision_and_coordinates(self):
  f=self.ct('JOBANN-'+uuid.uuid4().hex[:12],'current','20260801');head=self.annotation(f,'과거 주석 <img src=x>')
  p=self.launch_job([f]);canvas_ready(p,1)
  p.evaluate('''async sop=>{const g=services.viewportGridService.getState();const v=services.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId);
   const index=v.getImageIds().findIndex(id=>cornerstone.metaData.get('instance',id).SOPInstanceUID===sop);if(index<0)throw Error('fixture SOP missing');
   await v.setImageIdIndex(index);v.scroll(index-v.getTargetImageIdIndex(),false);}''',head['item']['sopUid'])
  for key in ['2','r','h','v']:p.keyboard.press(key)
  self.gesture(p,'Zoom',0,25);self.gesture(p,'Pan',20,10)
  expected=p.evaluate('''points=>{const g=services.viewportGridService.getState();const v=services.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId);
   return {points:points.map(p=>v.worldToCanvas(p).map(n=>n*devicePixelRatio)),width:v.getCanvas().width,height:v.getCanvas().height};}''',head['item']['points'])
  p.get_by_label('Job Title',exact=True).fill('주석 이력 보존')
  self.click_job(p,'Save Job with Annotations','주석 이력도 함께 고정');job=self.jobs(f)[0]
  self.change(f,head,label='저장 뒤의 다른 문구');before=self.pngs(p)
  paper=self.output(p);expect(paper.locator('main')).to_contain_text('저장 당시 주석 포함')
  expect(paper.locator('[data-annotation-id]')).to_contain_text('과거 주석 <img src=x>')
  expect(paper.locator('[data-annotation-id]')).to_have_attribute('data-revision','1')
  self.assertEqual(paper.locator('script').count(),0);self.assertEqual(self.pngs(p),before)
  actual=self.output_arrays(p,paper)[0];self.assertEqual(actual.shape[:2],(expected['height'],expected['width']))
  gold=(actual[:,:,0]>220)&(actual[:,:,1]>170)&(actual[:,:,2]<80)
  for x,y in expected['points']:
   x,y=round(x),round(y);self.assertTrue(gold[max(0,y-4):y+5,max(0,x-4):x+5].any(),(x,y))
  frozen=self.get_job(f,job);self.assertEqual(frozen['annotations'][0]['revision'],1)
  print('JOBANNOTATION coordinate points '+json.dumps(expected),flush=True)
  p.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click()
  p.keyboard.press('1');self.click_job(p,'Restore Job','최신 이력입니다');self.assertEqual(self.pngs(p),before)

 def test_annotations_03_native_manual_values_pdf_and_forged_baseline(self):
  patient='JOBANN-'+uuid.uuid4().hex[:12];f=self.ct(patient,'current','20260801');p=self.launch_job([f]);canvas_ready(p,1)
  ViewerHistoryE2E.open_measurement_tools(self,p)
  for index,(kind,tool,label) in enumerate([('length','Length','Length'),('angle','Angle','Angle'),('ellipse','EllipticalROI','Ellipse ROI')]):
   p.get_by_role('button',name=label,exact=True).click();box=p.locator('.cornerstone-canvas').bounding_box()
   x,y=box['x']+box['width']*.38,box['y']+box['height']*.3+index*95
   p.mouse.move(x,y);p.mouse.down();p.mouse.move(x+65,y+32,steps=10);p.mouse.up()
   if kind=='angle':p.mouse.move(x+85,y-15,steps=8);p.mouse.click(x+85,y-15)
   try:p.wait_for_function('''tool=>{const g=services.viewportGridService.getState();const v=services.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId);
    const t=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(v.id,v.renderingEngineId).getToolInstance(tool);
    return !t.isDrawing && cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName===tool && !a.invalidated && Object.keys(a.data.cachedStats||{}).length)}''',arg=tool)
   except Exception:
    print('MANUAL DRAW FAILURE',kind,p.locator('#kin-viewer-history').inner_text(),p.evaluate('()=>cornerstoneTools.annotation.state.getAllAnnotations().map(a=>({tool:a.metadata.toolName,invalidated:a.invalidated,points:a.data.handles?.points,stats:a.data.cachedStats}))'),flush=True)
    p.screenshot(path=str(Path(__file__).parent/'artifacts/job-annotation-manual-failure.png'));raise
   row=p.locator('#kin-viewer-history section[data-kind='+kind+']');row.get_by_label('Annotation Text').fill('한글 저장 '+kind)
   row.get_by_role('button',name='Save',exact=True).click();expect(row).to_contain_text('저장 완료')
  for key in ['r','h','v']:p.keyboard.press(key)
  self.open_layout_tools(p)
  p.get_by_label('Job Title',exact=True).fill('수치가 확인되는 과거 작업');self.click_job(p,'Save Job with Annotations','고정했습니다')
  job=self.get_job(f,self.jobs(f)[0]);self.assertEqual(len(job['annotations']),3)
  before=p.evaluate('()=>services.measurementService.getMeasurements().map(m=>m.uid).sort()');paper=self.output(p)
  self.assertEqual(p.evaluate('()=>services.measurementService.getMeasurements().map(m=>m.uid).sort()'),before)
  for annotation in job['annotations']:
   expect(paper.locator('[data-annotation-id="'+annotation['id']+'"]')).to_contain_text('저장 당시 수치:')
  images=self.output_arrays(p,paper);p.evaluate('''()=>{const open=window.open;window.open=(...args)=>{const w=open(...args);if(w)w.print=()=>w.__printed=true;return w}}''')
  with p.expect_popup() as opened:p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF').click()
  printed=opened.value;printed.wait_for_function('()=>window.__printed===true')
  path=Path(__file__).parent/'artifacts/job-annotations.pdf';printed.pdf(path=str(path),prefer_css_page_size=True)
  pdf=PdfReader(path);embedded=[]
  for page in pdf.pages:
   self.assertIn(patient,page.extract_text());embedded += [np.array(x.image.convert('RGB')) for x in page.images]
  self.assertTrue(any(np.array_equal(images[0],image) for image in embedded))
  text='\n'.join(page.extract_text() for page in pdf.pages)
  for token in ['저장 당시','r1','HU','mm']:self.assertIn(token,text)
  print('JOBANNOTATION PDF '+json.dumps(dict(pages=len(pdf.pages),annotations=3)),flush=True)
  p.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click()
  head=next(a for a in job['annotations'] if a['item']['kind']=='length');item=copy.deepcopy(head['item']);item.pop('hidden');item.pop('sourceDigest');item['baseline']['values'][0]+=10
  r=self.stack.request('POST',f'/studies/{f.uid}/viewer-items/{head["id"]}/revisions','doctor',dict(requestId=str(uuid.uuid4()),expectedRevision=1,action='edit',item=item));self.assertEqual(r.status,200,r.text)
  command=self.v2([f]);command['snapshot']=copy.deepcopy(job['snapshot']);command['snapshot'].pop('annotations');command['title']='위조 수치 거절'
  for cell in command['snapshot']['cells']:
   if cell:cell.pop('sourceDigest')
  self.post(f,command)
  self.click_job(p,'Refresh Jobs','목록입니다');p.get_by_role('button',name='Print Saved Images',exact=True).first.click()
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('저장 측정값이 원본 재확인 결과와 다릅니다',timeout=45000)
  expect(p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF')).to_be_disabled()

 def test_annotations_04_prior_permission_race_is_atomic(self):
  patient='JOBANN-'+uuid.uuid4().hex[:12];a=self.ct(patient,'current','20260801');b=self.ct(patient,'past','20260701')
  self.annotation(a,'current');self.annotation(b,'prior')
  command=self.v2([a,b]);command['snapshot']['version']=3;job=self.post(a,command)
  original=self.get_job(a,job);self.uid=b.uid
  saved=json.loads(psql(f'SELECT to_jsonb(s)::text FROM "StudyState" s WHERE uid={literal(b.uid)}')[0])
  try:
   another=self.v2([a,b]);another['snapshot']['version']=3
   with ThreadPoolExecutor(max_workers=1) as pool:
    with self.parent_lock('rs=\'P\', "preDoc"=\'other\', "preReviewer"=\'other2\''):
     pending=pool.submit(self.stack.request,'POST',f'/studies/{a.uid}/viewer-jobs','doctor',another);self.wait_blocked()
    self.assertEqual(pending.result().status,403)
   self.get_job(a,job,status=403);self.post(a,command,status=403)
   self.assertEqual(psql(f'SELECT count(*) FROM "ViewerJob" WHERE "studyUid"={literal(a.uid)}'),['1'])
  finally:
   fields=', '.join('"'+key+'"='+('NULL' if saved[key] is None else literal(saved[key])) for key in ['rs','preDoc','preReviewer'])
   psql(f'UPDATE "StudyState" SET {fields} WHERE uid={literal(b.uid)}')
  self.assertEqual(self.get_job(a,job),original)

 def test_annotations_05_count_and_payload_refusal_preserve_history(self):
  f=self.ct('JOBANN-'+uuid.uuid4().hex[:12],'current','20260801');heads=[self.annotation(f,'item '+str(i)) for i in range(64)]
  command=self.v2([f]);command['snapshot']['version']=3;job=self.post(f,command)
  self.assertEqual(len(self.get_job(f,job)['annotations']),64)
  extra=self.annotation(f,'overflow');bad=self.v2([f]);bad['snapshot']['version']=3;self.post(f,bad,status=409)
  self.assertEqual(len(self.jobs(f)),1);self.change(f,extra,'hide')
  for head in heads:self.change(f,head,label='😀'*1000)
  bad=self.v2([f]);bad['snapshot']['version']=3;self.post(f,bad,status=409)
  self.assertEqual(len(self.jobs(f)),1)
  # Neither failure rewrites the old saved heads or prevents image-only jobs.
  self.assertEqual([a['revision'] for a in self.get_job(f,job)['annotations']],[1]*64)
  self.post(f,self.v2([f]));self.assertEqual(len(self.jobs(f)),2)

 def test_annotations_06_original_replacement_with_frozen_measurement(self):
  def save_with_annotation(p,f):
   head=self.annotation(f,'고정된 원본 측정','length')
   p.evaluate('''async sop=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);
    const index=v.getImageIds().findIndex(id=>cornerstone.metaData.get('instance',id).SOPInstanceUID===sop);await v.setImageIdIndex(index);v.scroll(index-v.getTargetImageIdIndex(),false);}''',head['item']['sopUid'])
   p.get_by_label('Job Title',exact=True).fill('원본 교체와 주석 고정');self.click_job(p,'Save Job with Annotations','고정했습니다')
   job=self.jobs(f)[0];self.assertEqual(len(self.get_job(f,job)['annotations']),1);return job
  with patch.object(self,'saved',save_with_annotation):
   ViewerJobPrintE2E.test_print_06_actual_source_replacement_blocks_cached_display(self)

 def test_annotations_08_drifted_head_creation_names_remediation(self):
  f=self.ct('JOBANN-'+uuid.uuid4().hex[:12],'current','20260801');head=self.annotation(f,'원본이 바뀐 길이','length')
  command=self.v2([f]);command['snapshot']['version']=3
  path='/instances/'+self.stack.first_instance_id(f.uid);raw=self.stack.orthanc_bytes(path+'/file');ds=dcmread(io.BytesIO(raw))
  self.assertEqual(str(ds.SOPInstanceUID),head['item']['sopUid']);self.assertEqual(str(ds.StudyInstanceUID),f.uid)
  ds.PixelData=(ds.pixel_array.astype(np.int16)+37).astype('<i2').tobytes();stream=io.BytesIO();ds.save_as(stream,write_like_original=False);replacement=stream.getvalue()
  def replace(expected,updated):
   self.assertIn(f.uid,self.stack.active);self.assertEqual(self.stack.orthanc_bytes(path+'/file'),expected)
   self.assertEqual(self.stack._orthanc_request('DELETE',path).status,200)
   self.assertEqual(self.stack._orthanc_request('POST','/instances',updated).status,200);self.assertEqual(self.stack.orthanc_bytes(path+'/file'),updated)
  replace(raw,replacement)
  try:
   r=self.stack.request('POST',f'/studies/{f.uid}/viewer-jobs','doctor',command);self.assertEqual(r.status,409,r.text)
   for text in [head['id'],'비교에서 제외','영상만 저장','원본이 복구']:self.assertIn(text,r.body['message'])
   self.assertEqual(len(self.jobs(f)),0);self.post(f,self.v2([f]))
  finally:replace(replacement,raw)
  self.post(f,command);self.assertEqual(len(self.get_job(f,command)['annotations']),1)

 def test_annotations_10_roi_budget_and_accumulator_exception_restore(self):
  f=self.ct('JOBANN-'+uuid.uuid4().hex[:12],'current','20260801');p=self.launch_job([f]);canvas_ready(p,1)
  ViewerHistoryE2E.open_measurement_tools(self,p)
  p.get_by_role('button',name='Ellipse ROI',exact=True).click()
  coords=p.evaluate('''()=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId),d=v.getImageData(),r=v.element.getBoundingClientRect();
   return [[.45,.5],[.8,.95]].map(([x,y])=>v.worldToCanvas(d.imageData.indexToWorld([x*(d.dimensions[0]-1),y*(d.dimensions[1]-1),0])).map((n,i)=>n+(i?r.y:r.x)));}''')
  p.mouse.move(*coords[0]);p.mouse.down();p.mouse.move(*coords[1],steps=15);p.mouse.up()
  p.wait_for_function('''()=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId),t=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(v.id,v.renderingEngineId).getToolInstance('EllipticalROI');
   const a=cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='EllipticalROI');return !t.isDrawing&&a&&!a.invalidated&&Object.keys(a.data.cachedStats).length}''')
  row=p.locator('#kin-viewer-history section[data-kind=ellipse]');row.get_by_label('Annotation Text').fill('연산 한도 ROI');row.get_by_role('button',name='Save',exact=True).click();expect(row).to_contain_text('저장 완료')
  self.open_layout_tools(p)
  p.get_by_label('Job Title',exact=True).fill('ROI 예외 복구');self.click_job(p,'Save Job with Annotations','고정했습니다')
  job=self.get_job(f,self.jobs(f)[0]);item=copy.deepcopy(job['annotations'][0]['item']);item.pop('hidden');item.pop('sourceDigest')
  p.evaluate('''()=>{const c=new cornerstoneTools.EllipticalROITool().configuration.statsCalculator;window.__jobStats={c,callback:c.statsCallback,prior:Object.fromEntries(['max','min','sum','count','runMean','m2','pointsInShape'].map(k=>[k,c[k]]))};c.statsCallback=()=>{throw Error('owned calculator fault')}}''')
  try:
   p.get_by_role('button',name='Print Saved Images',exact=True).click();expect(p.locator('#kin-job-print [role=status]')).to_contain_text('owned calculator fault',timeout=45000)
   self.assertTrue(p.evaluate('()=>Object.entries(window.__jobStats.prior).every(([k,v])=>window.__jobStats.c[k]===v)'))
  finally:p.evaluate('()=>{window.__jobStats.c.statsCallback=window.__jobStats.callback;delete window.__jobStats}')
  p.locator('#kin-job-print').get_by_role('button',name='다시 확인').click();expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=45000)
  p.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click()
  for i in range(63):
   r=self.stack.request('POST',f'/studies/{f.uid}/viewer-items','doctor',dict(requestId=str(uuid.uuid4()),item=item));self.assertEqual(r.status,200,r.text)
  p.get_by_label('Job Title',exact=True).fill('ROI 누적 계산 한도');self.click_job(p,'Save Job with Annotations','고정했습니다')
  p.get_by_role('button',name='Print Saved Images',exact=True).first.click();expect(p.locator('#kin-job-print [role=status]')).to_contain_text('수치 재확인 범위가 너무 큽니다',timeout=45000)
  expect(p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF')).to_be_disabled()

 def test_annotations_09_response_containment_and_cache_refusal(self):
  f=self.ct('JOBANN-'+uuid.uuid4().hex[:12],'current','20260801');self.annotation(f,'형식 보존')
  command=self.v2([f]);command['snapshot']['version']=3;job=self.get_job(f,self.post(f,command));p=self.launch_job([f])
  variants=[]
  bad=copy.deepcopy(job);bad['annotations'][0]['item']['baseline']=dict(calculator='kin-native-manual-v1',values=[1,2,3,4,5]);variants.append(bad)
  bad=copy.deepcopy(job);bad['annotations'][0]['item']['points'].append([1,2,3]);variants.append(bad)
  bad=copy.deepcopy(job);bad['annotations'][0]['item']['frame']='1';variants.append(bad)
  bad=copy.deepcopy(job);bad['snapshot']['version']=2;variants.append(bad)
  pattern='**/api/studies/'+f.uid+'/viewer-jobs/'+job['id']
  for bad in variants:
   def fault(route):route.fulfill(status=200,content_type='application/json',body=json.dumps(bad))
   p.route(pattern,fault)
   try:
    p.get_by_role('button',name='Print Saved Images',exact=True).click();expect(p.locator('#kin-job-print [role=status]')).to_contain_text('주석',timeout=45000)
    expect(p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF')).to_be_disabled()
   finally:p.unroute(pattern,fault)
   p.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click()
  p.evaluate('''()=>{window.__jobAvailable=cornerstone.cache.getBytesAvailable;window.__jobCacheIds=[...cornerstone.cache._imageCache.keys()].sort();cornerstone.cache.getBytesAvailable=()=>0}''')
  try:
   p.get_by_role('button',name='Print Saved Images',exact=True).click();expect(p.locator('#kin-job-print [role=status]')).to_contain_text('메모리가 부족',timeout=45000)
   self.assertTrue(p.evaluate('()=>JSON.stringify([...cornerstone.cache._imageCache.keys()].sort())===JSON.stringify(window.__jobCacheIds)'))
  finally:p.evaluate('()=>{cornerstone.cache.getBytesAvailable=window.__jobAvailable;delete window.__jobAvailable;delete window.__jobCacheIds}')
  p.locator('#kin-job-print').get_by_role('button',name='다시 확인').click();expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=45000)

 def test_annotations_07_grid_blank_dpr_and_long_legend_pdf(self):
  patient='JOBANN-'+uuid.uuid4().hex[:12];f=self.ct(patient,'current','20260801');head=self.annotation(f,'고정 주석 설명 '*40)
  p=self.launch_job([f]);self.grid(p,4)
  for i in [0,1,3]:self.drag(p,'D03A current',i)
  p.evaluate('''async sop=>{for(const g of services.viewportGridService.getState().viewports.values()){
   if(!g.displaySetInstanceUIDs?.length)continue;const v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);
   const index=v.getImageIds().findIndex(id=>cornerstone.metaData.get('instance',id).SOPInstanceUID===sop);await v.setImageIdIndex(index);v.scroll(index-v.getTargetImageIdIndex(),false);
   v.setCamera({flipHorizontal:g.x>0,flipVertical:g.y>0});v.render();}}''',head['item']['sopUid'])
  p.wait_for_timeout(200)
  expected=p.evaluate('''points=>[...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).filter(g=>g.displaySetInstanceUIDs?.length).map(g=>{
   const v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);return {points:points.map(p=>v.worldToCanvas(p).map(n=>n*devicePixelRatio)),width:v.getCanvas().width,height:v.getCanvas().height};})''',head['item']['points'])
  p.get_by_label('Job Title',exact=True).fill('네 셀 고정 주석');self.click_job(p,'Save Job with Annotations','고정했습니다')
  for dpr in [2,1.25]:
   context=self.browser.new_context(ignore_https_errors=True,viewport=dict(width=1050,height=800),device_scale_factor=dpr,storage_state=p.context.storage_state())
   try:
    q=self.launch_job_page(context,f);paper=self.output(q);actual=self.output_arrays(q,paper)
    self.assertEqual(len(actual),3);expect(paper.locator('.cell').nth(2)).to_contain_text('빈 셀')
    for spec,image in zip(expected,actual):
     self.assertEqual(image.shape[:2],(spec['height'],spec['width']));gold=(image[:,:,0]>220)&(image[:,:,1]>170)&(image[:,:,2]<80)
     for x,y in spec['points']:
      x,y=round(x),round(y);self.assertTrue(gold[max(0,y-4):y+5,max(0,x-4):x+5].any(),(dpr,x,y))
    if dpr==1.25:
     q.evaluate('''()=>{const open=window.open;window.open=(...args)=>{const w=open(...args);if(w)w.print=()=>w.__printed=true;return w}}''')
     with q.expect_popup() as opened:q.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF').click()
     printed=opened.value;printed.wait_for_function('()=>window.__printed===true')
     path=Path(__file__).parent/'artifacts/job-annotations-grid.pdf';printed.pdf(path=str(path),prefer_css_page_size=True)
     pdf=PdfReader(path);self.assertGreaterEqual(len(pdf.pages),2)
     for page in pdf.pages:self.assertIn(patient,page.extract_text())
     self.assertEqual(sum(len(page.images) for page in pdf.pages),3)
     print('JOBANNOTATION grid PDF '+json.dumps(dict(pages=len(pdf.pages),dpr=dpr)),flush=True)
   finally:context.close()


def load_tests(loader,tests,pattern):return unittest.TestSuite(ViewerJobAnnotationsE2E(n) for n in loader.getTestCaseNames(ViewerJobAnnotationsE2E) if n.startswith('test_annotations_'))
if __name__=='__main__':
 sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
