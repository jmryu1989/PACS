"""REQ-D05-JOB: original references, real saved display restoration and preserved boundaries."""
import copy,io,json,sys,unittest,uuid
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from pydicom import dcmread
from playwright.sync_api import expect
import test_worklist as base
from test_display_controls import DisplayControlsE2E
from test_viewer_history import ViewerHistoryE2E
from test_prior_selection import canvas_ready
from viewer_api_test import ViewerStack,ViewerAPI,literal
from invariants_live import psql

class ViewerJobsE2E(DisplayControlsE2E):
 parent_lock=ViewerAPI.parent_lock
 wait_blocked=ViewerAPI.wait_blocked
 @classmethod
 def setUpClass(cls):
  with patch.object(base,'LiveStack',ViewerStack):super().setUpClass()

 def cleanup_fixtures(self):
  # Full-row equality guards and run-owned parent/author identities only.
  for uid in list(self.stack.active):
   rows=psql(f'SELECT to_jsonb(j)::text FROM "ViewerJob" j WHERE "studyUid"={literal(uid)}')
   for raw in rows:
    j=json.loads(raw);self.assertIn(j['authorSub'],self.stack.user_ids.values());self.assertTrue(set(j['studies'])<=set(self.stack.active))
    revs=psql(f'SELECT to_jsonb(r)::text FROM "ViewerJobRevision" r WHERE "jobId"={literal(j["id"])}::uuid')
    sql='BEGIN; '
    for rev in revs:sql+=f'DELETE FROM "ViewerJobRevision" r WHERE to_jsonb(r)={literal(rev)}::jsonb; '
    sql+=f'DELETE FROM "ViewerJob" j WHERE to_jsonb(j)={literal(raw)}::jsonb; COMMIT;'
    psql(sql)
   self.assertEqual(psql(f'SELECT count(*) FROM "ViewerJob" WHERE "studyUid"={literal(uid)}'),['0'])
  super().cleanup_fixtures()

 def jobs(self,f,user='doctor',suffix=''):
  r=self.stack.request('GET',f'/studies/{f.uid}/viewer-jobs'+suffix,user);self.assertEqual(r.status,200,r.text);return r.body['jobs']

 def command(self,fixtures):
  cells=[]
  for f in fixtures:
   ds=dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/'+self.stack.first_instance_id(f.uid)+'/file')))
   z=float(ds.ImagePositionPatient[2]);cells.append(dict(study=f.uid,series=str(ds.SeriesInstanceUID),sop=str(ds.SOPInstanceUID),frame=1,
    camera=dict(focalPoint=[128,128,z],position=[128,128,z+1000],viewUp=[0,-1,0],viewPlaneNormal=[0,0,1],parallelScale=128,rotation=0,flipHorizontal=False,flipVertical=False),
    properties=dict(voiRange=dict(lower=-1000,upper=-1),VOILUTFunction='LINEAR',invert=False)))
  return dict(id=str(uuid.uuid4()),title='비교 <img src=x onerror=alert(1)>',description='Saved original frame',
   snapshot=dict(version=1,studies=[f.uid for f in fixtures],rows=1,cols=len(fixtures),active=0,cells=cells))

 def post(self,f,command,user='doctor',status=200,suffix=''):
  r=self.stack.request('POST',f'/studies/{f.uid}/viewer-jobs'+suffix,user,command);self.assertEqual(r.status,status,r.text);return r.body

 def revised(self,j,**changes):return dict(expectedRevision=j['revision'],title=j['title'],description=j['description'],hidden=j['hidden'],reason='',**changes)

 def launch_job(self,fixtures):
  p=self.launch(self.login(),fixtures);expect(p.locator('#kin-viewer-jobs-status')).to_contain_text('목록입니다.');return p

 def click_job(self,p,label,message):
  p.locator('#kin-viewer-jobs').get_by_role('button',name=label,exact=True).first.click()
  expect(p.locator('#kin-viewer-jobs-status')).to_contain_text(message,timeout=45000)

 def test_job_01_api_references_replay_history_and_preservation(self):
  patient='JOB-'+uuid.uuid4().hex[:12];a=self.ct(patient,'current','20260801');b=self.ct(patient,'past','20260701')
  self.seed_report(a);originals=self.originals();reports={f.uid:self.report_rows(f) for f in [a,b]}
  c=self.command([a,b]);j=self.post(a,c);self.assertEqual(self.post(a,c)['id'],j['id']);self.assertEqual(len(self.jobs(a)),1)
  changed=copy.deepcopy(c);changed['title']='changed';self.post(a,changed,status=409)
  for user in ['tech','kdoctor']:self.post(a,self.command([a,b]),user=user,status=403)
  self.assertEqual(self.stack.bearer_request('POST',f'/studies/{a.uid}/viewer-jobs',self.stack.service_token('gateway'),c).status,403)
  self.assertEqual(self.stack.request('GET',f'/studies/{a.uid}/viewer-jobs','kdoctor').status,403)
  self.assertEqual(self.stack.request('GET',f'/studies/{a.uid}/viewer-jobs/{j["id"]}','kdoctor').status,403)
  self.assertEqual(self.stack.request('DELETE',f'/studies/{a.uid}','tech').status,409)
  self.assertEqual(self.stack.request('DELETE',f'/studies/{b.uid}','tech').status,409)
  token=self.stack.token('doctor')
  raw=json.dumps(c).encode();raw=raw[:-1]+b',"id":"'+str(uuid.uuid4()).encode()+b'"}'
  self.assertEqual(self.stack.bearer_request('POST',f'/studies/{a.uid}/viewer-jobs',token,raw,headers={'Content-Type':'application/json'}).status,400)
  self.assertEqual(self.stack.bearer_request('POST',f'/studies/{a.uid}/viewer-jobs',token,c,headers={'X-KIN-Subject':'different-user'}).status,403)
  bad=self.command([a,b]);bad['snapshot']['cells'][0]['series']=bad['snapshot']['cells'][1]['series'];self.post(a,bad,status=400)
  bad=self.command([a,b]);bad['snapshot']['cells'][0]['frame']=2;self.post(a,bad,status=400)
  bad=self.command([a,b]);bad['snapshot']['cells'][0]['camera']['focalPoint'][2]+=1;self.post(a,bad,status=400)
  different=self.ct('OTHER-'+uuid.uuid4().hex[:8],'future','20260907');self.post(a,self.command([a,different]),status=400)
  edit=self.revised(j);edit['description']='수정된 설명'
  self.post(a,edit,user='doctor2',status=403,suffix='/'+j['id']+'/revisions')
  with ThreadPoolExecutor(max_workers=2) as pool:
   results=list(pool.map(lambda _:self.stack.request('POST',f'/studies/{a.uid}/viewer-jobs/{j["id"]}/revisions','doctor',edit),range(2)))
  self.assertEqual(sorted(r.status for r in results),[200,409]);j=next(r.body for r in results if r.status==200)
  before=psql(f'SELECT snapshot::text FROM "ViewerJob" WHERE id={literal(j["id"])}::uuid')
  hide=self.revised(j);hide.update(hidden=True);self.post(a,hide,status=400,suffix='/'+j['id']+'/revisions')
  hide['reason']='중복 작업 숨김';j=self.post(a,hide,suffix='/'+j['id']+'/revisions');self.assertEqual(self.jobs(a),[])
  self.assertEqual(len(self.jobs(a,suffix='?includeHidden=true')),1)
  self.assertEqual(self.stack.request('GET',f'/studies/{a.uid}/viewer-jobs/{j["id"]}','doctor').status,409)
  undo=self.revised(j);undo.update(hidden=False,reason='다시 사용');j=self.post(a,undo,suffix='/'+j['id']+'/revisions')
  self.assertEqual(psql(f'SELECT snapshot::text FROM "ViewerJob" WHERE id={literal(j["id"])}::uuid'),before)
  self.assertEqual(psql(f'SELECT count(*) FROM "ViewerJobRevision" WHERE "jobId"={literal(j["id"])}::uuid'),['4'])
  self.assertEqual(psql(f'SELECT count(*) FROM "AuditLog" WHERE target={literal(a.uid)} AND action=\'viewer.job\''),['4'])
  current_originals=self.originals()
  for k,v in originals.items():self.assertEqual(current_originals[k],v)
  for f in [a,b]:self.assertEqual(self.report_rows(f),reports[f.uid])

 def test_job_02_prior_access_P_source_mismatch_and_atomic_failure(self):
  patient='JOB-'+uuid.uuid4().hex[:12];a=self.ct(patient,'current','20260801');b=self.ct(patient,'past','20260701')
  c=self.command([a,b]);j=self.post(a,c);url=f'/studies/{a.uid}/viewer-jobs/{j["id"]}'
  rows=self.report_rows(a);originals=self.originals()
  old=psql(f'SELECT to_jsonb(s)::text FROM "StudyState" s WHERE uid={literal(b.uid)}')[0]
  try:
   psql(f'UPDATE "StudyState" SET rs=\'P\', "preDoc"=\'other\', "preReviewer"=\'other2\' WHERE uid={literal(b.uid)}')
   self.assertEqual(self.jobs(a),[]);self.assertEqual(self.stack.request('GET',url,'doctor').status,403)
   self.post(a,self.command([a,b]),status=403);self.post(a,self.revised(j),status=403,suffix='/'+j['id']+'/revisions')
   psql(f'UPDATE "StudyState" SET rs=\'W\', "institutionId"=\'foreign\' WHERE uid={literal(b.uid)}')
   self.assertEqual(self.jobs(a),[]);self.assertEqual(self.stack.request('GET',url,'doctor').status,403)
  finally:
   s=json.loads(old);psql(f'UPDATE "StudyState" SET rs={literal(s["rs"])}, "institutionId"={literal(s["institutionId"])}, "preDoc"=NULL, "preReviewer"=NULL WHERE uid={literal(b.uid)}')
  self.assertEqual(self.stack.request('GET',url,'doctor').status,200)
  saved=psql(f'SELECT snapshot::text FROM "ViewerJob" WHERE id={literal(j["id"])}::uuid')[0]
  try:
   broken=json.loads(saved);broken['cells'][1]['sourceDigest']='0'*32
   psql(f'UPDATE "ViewerJob" SET snapshot={literal(json.dumps(broken))}::jsonb WHERE id={literal(j["id"])}::uuid')
   self.assertEqual(self.stack.request('GET',url,'doctor').status,409)
  finally:psql(f'UPDATE "ViewerJob" SET snapshot={literal(saved)}::jsonb WHERE id={literal(j["id"])}::uuid')
  self.assertEqual(self.report_rows(a),rows);self.assertEqual(self.originals(),originals)

 def test_job_03_two_study_native_display_new_browser_restore(self):
  patient='JOB-'+uuid.uuid4().hex[:12];a=self.ct(patient,'current','20260801');b=self.ct(patient,'past','20260701')
  self.seed_report(a);self.seed_report(b);originals=self.originals();rows={f.uid:self.report_rows(f) for f in [a,b]}
  p=self.launch_job([a,b]);self.grid(p,2);self.drag(p,'D03A current',0);self.drag(p,'D03A past',1);canvas_ready(p,2);self.choose(p,0)
  p.keyboard.press('ArrowDown');self.gesture(p,'Zoom',0,45);self.gesture(p,'Pan',30,20)
  for key in ['2','r','h','v','i']:p.keyboard.press(key)
  # Soft-tissue keeps this phantom visible; Liver clips every fixture pixel to
  # black and cannot exercise the spatial canvas restoration oracle.
  self.choose(p,1);p.keyboard.press('ArrowDown');p.keyboard.press('ArrowDown');p.keyboard.press('1');p.wait_for_timeout(200)
  before=self.display(p);p.get_by_label('작업 제목',exact=True).fill('현재·과거 비교');p.get_by_label('작업 설명',exact=True).fill('프레임·밝기·방향 저장')
  self.click_job(p,'새 비교 작업 저장','저장했습니다');self.assertEqual(len(self.jobs(a)),1)
  p.close();p=self.launch_job([a]);self.click_job(p,'이 작업 복원','복원했습니다');p.wait_for_timeout(400)
  self.assertIn('StudyInstanceUIDs='+a.uid+'%2C'+b.uid,p.url);self.assertIn('kinJob=',p.url)
  print('JOB restored observation '+json.dumps(dict(before=before,after=self.display(p))),flush=True);canvas_ready(p,2)
  after=self.display(p)
  for original,restored in zip(before,after):
   self.assertEqual(original['image'],restored['image']);self.assertEqual(original['index'],restored['index'])
   for key in ['voiRange','invert','VOILUTFunction']:self.assertEqual(original['properties'].get(key),restored['properties'].get(key))
   for key in ['focalPoint','position','viewUp','viewPlaneNormal']:
    for x,y in zip(original['camera'][key],restored['camera'][key]):self.assertAlmostEqual(x,y,places=6)
   for key in ['rotation','flipHorizontal','flipVertical','parallelScale']:self.assertAlmostEqual(original['camera'][key],restored['camera'][key],places=6)
   for x,y in zip(original['point'],restored['point']):self.assertAlmostEqual(x,y,delta=.05)
   self.assertEqual(original['canvasHash'],restored['canvasHash'])
  self.assertEqual(p.evaluate('services.viewportGridService.getActiveViewportId()'),self.cells(p)[1]['id'])
  for i,index in enumerate([1,2]):expect(p.locator('[data-cy=viewport-grid] > div').nth(i)).to_contain_text('('+str(index+1)+'/4)')
  print('JOB native roundtrip '+json.dumps(dict(before=before,after=after)),flush=True)
  p.screenshot(path=str(Path(__file__).parent/'artifacts/JOB-restored.png'))
  self.choose(p,1);p.keyboard.press('ArrowDown');p.wait_for_timeout(120)
  self.assertEqual(self.display(p)[1]['index'],3);expect(p.locator('[data-cy=viewport-grid] > div').nth(1)).to_contain_text('(4/4)')
  self.click_job(p,'제목·설명 수정','편집 후');p.get_by_label('작업 설명',exact=True).fill('수정된 설명');self.click_job(p,'변경 저장','저장했습니다')
  self.assertEqual(self.jobs(a)[0]['description'],'수정된 설명')
  for f in [a,b]:self.assertEqual(self.report_rows(f),rows[f.uid])
  self.assertEqual(self.originals(),originals)

 def test_job_04_delayed_restore_retry_input_and_session(self):
  f=self.ct('JOB-'+uuid.uuid4().hex[:12],'current','20260801');p=self.launch_job([f]);self.choose(p,0)
  p.get_by_label('작업 제목',exact=True).fill('실패 재시도')
  pattern='**/api/studies/*/viewer-jobs'
  def lost(route):
   if route.request.method=='POST':route.fetch();route.abort()
   else:route.continue_()
  p.route(pattern,lost);self.click_job(p,'새 비교 작업 저장','입력은 유지');expect(p.get_by_label('작업 제목',exact=True)).to_have_value('실패 재시도')
  self.assertEqual(len(self.jobs(f)),1);p.unroute(pattern,lost);self.click_job(p,'같은 요청 재시도','저장했습니다');self.assertEqual(len(self.jobs(f)),1)
  held=[]
  def hold(route):held.append((route,route.fetch()))
  p.route('**/api/studies/*/viewer-jobs/*',hold)
  p.get_by_role('button',name='이 작업 복원',exact=True).click()
  for _ in range(100):
   if held:break
   p.wait_for_timeout(50)
  self.assertTrue(held);self.choose(p,0);p.keyboard.press('ArrowDown');p.wait_for_timeout(150);changed=self.display(p)
  held[0][0].fulfill(response=held[0][1]);expect(p.locator('#kin-viewer-jobs-status')).to_contain_text('영상 조작이 변경')
  self.assertEqual(self.display(p),changed);p.unroute('**/api/studies/*/viewer-jobs/*',hold)
  p.get_by_label('작업 제목',exact=True).fill('logout clears this')
  work=p.context.new_page();self.relog(work,'doctor2')
  self.click_job(p,'작업 목록 새로고침','세션이 변경');expect(p.get_by_label('작업 제목',exact=True)).to_have_value('');self.assertEqual(len(self.jobs(f)),1)

 def test_job_05_locked_permission_recheck_and_audit_rollback(self):
  f=self.ct('JOB-'+uuid.uuid4().hex[:12],'current','20260801');self.uid=f.uid;c=self.command([f]);originals=self.originals()
  # Permission changes commit while a new save is blocked on the same parent.
  with ThreadPoolExecutor(max_workers=1) as pool:
   with self.parent_lock('rs=\'P\', "preDoc"=\'other\', "preReviewer"=\'other2\''):
    future=pool.submit(self.stack.request,'POST',f'/studies/{f.uid}/viewer-jobs','doctor',c);self.wait_blocked()
   self.assertEqual(future.result().status,403)
  psql(f'UPDATE "StudyState" SET rs=\'W\', "preDoc"=NULL, "preReviewer"=NULL WHERE uid={literal(f.uid)}')
  self.assertEqual(self.jobs(f),[])
  name='job_audit_'+uuid.uuid4().hex
  psql(f'CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.target={literal(f.uid)} AND NEW.action=\'viewer.job\' THEN RAISE EXCEPTION \'SYNTHETIC job audit fault\'; END IF; RETURN NEW; END $$; CREATE TRIGGER {name} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION {name}();')
  try:self.post(f,c,status=500)
  finally:psql(f'DROP TRIGGER {name} ON "AuditLog"; DROP FUNCTION {name}();')
  self.assertEqual(self.jobs(f),[])
  self.assertEqual(psql(f'SELECT count(*) FROM "ViewerJobRevision" WHERE "jobId"={literal(c["id"])}::uuid'),['0'])
  self.post(f,c);self.assertEqual(len(self.jobs(f)),1);self.assertEqual(self.originals(),originals)

 def test_job_06_four_cells_saved_annotations_and_unsaved_guard(self):
  f=self.multiple('JOB-'+uuid.uuid4().hex[:12],'current','20260801');p=self.launch_job([f]);originals=self.originals();reports=self.report_rows(f)
  row=ViewerHistoryE2E.draw(self,p,'Job saved arrow');p.get_by_label('작업 제목',exact=True).fill('네 화면과 표식')
  self.click_job(p,'새 비교 작업 저장','미저장 표식');self.assertEqual(self.jobs(f),[])
  row.get_by_role('button',name='저장',exact=True).click();expect(row).to_contain_text('저장 완료')
  ViewerHistoryE2E.key(self,p,'Job key')
  points=p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='ArrowAnnotate').data.handles.points")
  self.grid(p,4);self.drag(p,'D03A current',0);self.drag(p,'D02E second series',1);self.drag(p,'D03A current',3)
  refs=self.fixture_refs(p,f);one=next(r for r in refs if any(i['0020000E']['Value'][0]==r['series'] and i['0008103E']['Value'][0]=='D03A current' for i in self.metadata(p,f)))
  two=next(r for r in refs if r!=one);expected=[one,two,None,one];self.identity(p,expected)
  self.click_job(p,'새 비교 작업 저장','저장했습니다');p.close();p=self.launch_job([f]);self.click_job(p,'이 작업 복원','복원했습니다');self.identity(p,expected)
  p.wait_for_function("()=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName==='ArrowAnnotate')")
  self.assertEqual(p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='ArrowAnnotate').data.handles.points"),points)
  expect(p.locator('#kin-viewer-history')).to_contain_text('Job key');expect(p.locator('#kin-viewer-history')).to_contain_text('Job saved arrow')
  before=self.cells(p);row=p.locator('#kin-viewer-history section[data-kind=arrow]');row.get_by_role('button',name='편집',exact=True).click();row.get_by_label('주석 문구').fill('unsaved retained')
  self.click_job(p,'이 작업 복원','미저장 표식');self.assertEqual(self.cells(p),before);expect(row.get_by_label('주석 문구')).to_have_value('unsaved retained')
  row.get_by_role('button',name='저장',exact=True).click();expect(row).to_contain_text('저장됨 r2')
  self.assertEqual(self.originals(),originals);self.assertEqual(self.report_rows(f),reports)

def load_tests(loader,tests,pattern):return unittest.TestSuite(ViewerJobsE2E(n) for n in loader.getTestCaseNames(ViewerJobsE2E) if n.startswith('test_job_'))
if __name__=='__main__':
 sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
