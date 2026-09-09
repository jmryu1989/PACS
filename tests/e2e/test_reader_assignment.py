# coding: utf-8
"""IF-W21 assignment roles, fresh eligibility, CAS/hold and browser/report protection."""
import json,os,unittest,uuid
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from playwright.sync_api import expect
from test_worklist import WorklistE2E,psql

def lit(x):return "'"+str(x).replace("'","''")+"'"
class ReaderAssignmentE2E(WorklistE2E):
 def setUp(self):
  super().setUp();self.requests=set();self.actors=set();self.addCleanup(self.cleanup_assignments)
 def cleanup_assignments(self):
  self.close_contexts();self.contexts=[]
  for uid in self.stack.active:
   for raw in psql('SELECT to_jsonb(t)::text FROM "ReaderAssignment" t WHERE "studyUid"='+lit(uid)):
    row=json.loads(raw);self.assertIn(row['lastRequest'],self.requests);self.assertIn(row['changedBy'],self.actors)
    self.assertEqual(psql('DELETE FROM "ReaderAssignment" t WHERE to_jsonb(t)='+lit(raw)+'::jsonb RETURNING 1'),['1'])
 def account(self,role):
  r=self.stack.request('GET','/me',role);self.assertEqual(r.status,200);actor=r.body['actor'];self.assertTrue(actor.startswith('kin-test-') and actor.endswith('@local.test'));self.actors.add(actor);return r.body
 def read(self,f,role='tech'):
  self.account(role);r=self.stack.request('GET',f'/studies/{f.uid}/reader-assignment',role);self.assertEqual(r.status,200,r.text);return r.body
 def body(self,s,reader):
  request=str(uuid.uuid4());self.requests.add(request);return dict(expectedOwner=s['owner'],revision=s['revision'],readerSub=self.stack.user_ids[reader] if reader else None,requestId=request)
 def change(self,f,body,role='tech',status=201):
  self.account(role);r=self.stack.request('POST',f'/studies/{f.uid}/reader-assignment',role,body);self.assertEqual(r.status,status,r.text);return r.body
 def login(self,role='doctor'):
  self.account(role);p=super().login(role)
  def capture(req):
   if req.method=='POST' and req.url.split('?')[0].endswith('/reader-assignment'):self.requests.add(req.post_data_json['requestId'])
  p.on('request',capture);return p
 def open(self,p,f):
  p.locator(f'[data-reader-assignment="{f.uid}"]').click();expect(p.locator('#ra-status')).to_contain_text('최신 배정')
 def test_assignment_01_roles_fresh_eligibility_and_original(self):
  a=self.fixture();before=psql('SELECT to_jsonb(t)::text FROM "StudyState" t WHERE uid='+lit(a.uid));s=self.read(a)
  readers=self.stack.request('GET','/reader-candidates','tech');self.assertEqual(readers.status,200);subs={r['sub'] for r in readers.body['readers']};self.assertIn(self.stack.user_ids['doctor'],subs);self.assertNotIn(self.stack.user_ids['tech'],subs);self.assertNotIn(self.stack.user_ids['kdoctor'],subs)
  s=self.change(a,self.body(s,'doctor'));other=self.read(a,'doctor2');self.change(a,self.body(other,'doctor2'),'doctor2',403)
  own=self.read(a,'doctor');own=self.change(a,self.body(own,None),'doctor');self.assertIsNone(own['reader']);own=self.change(a,self.body(own,'doctor'),'doctor');self.assertEqual(own['reader']['sub'],self.stack.user_ids['doctor'])
  s=self.read(a)
  for who in ['tech','kdoctor']:self.change(a,self.body(s,who),status=400)
  target=self.stack.user_ids['doctor2'];self.assertEqual(self.stack.kc_admin('PUT',f'/users/{target}',{'enabled':False}).status,204)
  try:self.change(a,self.body(s,'doctor2'),status=400)
  finally:self.assertEqual(self.stack.kc_admin('PUT',f'/users/{target}',{'enabled':True}).status,204)
  self.assertEqual(self.stack.request('GET',f'/studies/{a.uid}/reader-assignment','kdoctor').status,404)
  self.assertEqual(psql('SELECT to_jsonb(t)::text FROM "StudyState" t WHERE uid='+lit(a.uid)),before)
  self.assertEqual(len(self.read(a)['history']),3)
 def test_assignment_02_cas_replay_hold_and_status(self):
  a=self.fixture();tech=self.read(a);admin=self.read(a,'jmryu');b1=self.body(tech,'doctor');b2=self.body(admin,'doctor2')
  with ThreadPoolExecutor(max_workers=2) as pool:
   results=list(pool.map(lambda x:self.stack.request('POST',f'/studies/{a.uid}/reader-assignment',x[0],x[1]),[('tech',b1),('jmryu',b2)]))
  self.assertEqual(sorted(r.status for r in results),[201,409]);winner=0 if results[0].status==201 else 1;role=['tech','jmryu'][winner];body=[b1,b2][winner];self.change(a,body,role);self.assertEqual(len(self.read(a)['history']),1)
  self.assertEqual(self.stack.request('POST',f'/studies/{a.uid}/hold','doctor').status,201);s=self.read(a);self.assertTrue(s['blocked']);self.change(a,self.body(s,None),status=409);self.assertEqual(self.stack.request('POST',f'/studies/{a.uid}/release','doctor').status,201)
  for status in ['T','P','A','O']:
   psql('UPDATE "StudyState" SET rs='+lit(status)+' WHERE uid='+lit(a.uid))
   try:self.change(a,self.body(self.read(a),None),status=409)
   finally:psql('UPDATE "StudyState" SET rs='+lit('W')+' WHERE uid='+lit(a.uid))
  self.change(a,self.body(self.read(a),None));self.change(a,body,role,409)
 def test_assignment_03_browser_column_search_and_report(self):
  a=self.fixture();b=self.fixture(patient_id=a.patient_id);c=self.fixture(patient_id=a.patient_id);self.seed_report(c)
  tech=self.login('tech');self.select(tech,a);self.open(tech,a);tech.locator('#ra-reader').select_option(self.stack.user_ids['doctor']);tech.locator('#ra-save').click();expect(tech.locator('#ra-status')).to_contain_text('저장되었습니다');tech.locator('#ra-close').click()
  p=self.login();self.select(p,c);p.locator('#findings').fill('KEEP ASSIGNMENT REPORT');self.open(p,a);expect(p.locator('#ra-current')).to_contain_text(self.stack.actor('doctor'));p.locator('#ra-close').click();expect(p.locator('#findings')).to_have_value('KEEP ASSIGNMENT REPORT');expect(p.locator(f'#rows tr[data-uid="{c.uid}"]')).to_have_class(__import__('re').compile(r'\bsel\b'))
  p.locator('#filterrow [data-f="assignedReader"]').fill(self.stack.actor('doctor'));expect(p.locator('#rows tr[data-uid]')).to_have_count(1);expect(p.locator('#findings')).to_have_value('KEEP ASSIGNMENT REPORT');p.locator('#filterrow [data-f="assignedReader"]').fill('');expect(p.locator('#rows tr[data-uid]')).to_have_count(3)
  self.change(a,self.body(self.read(a),'doctor2'));p.locator('#refresh').click();expect(p.locator(f'[data-reader-assignment="{a.uid}"]')).to_contain_text(self.stack.actor('doctor2'));expect(p.locator('#findings')).to_have_value('KEEP ASSIGNMENT REPORT')
  self.open(tech,a);expect(tech.locator('#ra-history li')).to_have_count(2);folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);tech.screenshot(path=str(folder/'reader-assignment.png'));self.assertEqual(len(self.versions(c)),1)
 def test_assignment_04_retry_conflict_late_session(self):
  a=self.fixture();p=self.login('tech');self.select(p,a);self.open(p,a)
  def lost(route):route.fetch();route.abort()
  p.route('**/reader-assignment',lambda r:lost(r) if r.request.method=='POST' else r.continue_());p.locator('#ra-reader').select_option(self.stack.user_ids['doctor']);p.locator('#ra-save').click();expect(p.locator('#ra-status')).to_contain_text('저장 확인 실패');expect(p.locator('#ra-retry')).to_be_enabled()
  p.unroute('**/reader-assignment');p.locator('#ra-retry').click();expect(p.locator('#ra-status')).to_contain_text('저장되었습니다');self.assertEqual(len(self.read(a)['history']),1)
  self.change(a,self.body(self.read(a),'doctor2'));p.locator('#ra-reader').select_option('');p.locator('#ra-save').click();expect(p.locator('#ra-status')).to_contain_text('바뀌었습니다');expect(p.locator('#ra-reader')).to_have_value('');p.locator('#ra-reload').click();expect(p.locator('#ra-current')).to_contain_text(self.stack.actor('doctor2'));expect(p.locator('#ra-reader')).to_have_value('');p.locator('#ra-save').click();expect(p.locator('#ra-status')).to_contain_text('저장되었습니다');self.assertIsNone(self.read(a)['reader']);p.locator('#ra-close').click()
  waiting=[];p.route('**/reader-assignment',lambda r:waiting.append(r));p.locator(f'[data-reader-assignment="{a.uid}"]').click();expect(p.locator('#ra-status')).to_contain_text('읽는 중');p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(p.locator('#reader-assignment-dialog')).not_to_be_visible()
  for route in waiting:route.fulfill(status=200,content_type='application/json',body=json.dumps(self.read(a)))
  expect(p.locator('#ra-history')).to_be_empty();expect(p.locator('#ra-reader')).to_be_empty()
 def test_assignment_05_concurrent_hold_is_serialized(self):
  a=self.fixture();s=self.read(a);self.account('doctor');self.account('doctor2');body=self.body(s,'doctor')
  def call(item):
   role,path,payload=item;return self.stack.request('POST',f'/studies/{a.uid}/'+path,role,payload)
  with ThreadPoolExecutor(max_workers=3) as pool:
   results=list(pool.map(call,[('doctor','hold',None),('doctor2','hold',None),('tech','reader-assignment',body)]))
  self.assertEqual([r.status for r in results[:2]],[201,201]);self.assertEqual(sum(r.body['mine'] for r in results[:2]),1);self.assertEqual(results[0].body['holder'],results[1].body['holder']);self.assertIn(results[2].status,[201,409])
  actions=psql('SELECT action FROM "AuditLog" WHERE target='+lit(a.uid)+" AND action IN ('reader.assignment','report.hold') ORDER BY id")
  self.assertEqual(actions,['reader.assignment','report.hold'] if results[2].status==201 else ['report.hold'])
def load_tests(loader,tests,pattern):return unittest.TestSuite(ReaderAssignmentE2E(n) for n in loader.getTestCaseNames(ReaderAssignmentE2E) if n.startswith('test_assignment_'))
if __name__=='__main__':unittest.main(verbosity=2)
