# coding: utf-8
"""Personal links, ownership/revocation, retry/conflict and report-safe UI."""
import json,os,re,unittest,uuid
from pathlib import Path
from playwright.sync_api import expect
from test_worklist import WorklistE2E,psql

class FavoritesE2E(WorklistE2E):
 def setUp(self):
  super().setUp();self.favoriteOwners={}
 def account(self,role='doctor'):
  r=self.stack.request('GET','/favorite-folders',role);self.assertEqual(r.status,200,r.text)
  if role not in self.favoriteOwners:
   institution,subject=r.body['owner'];actor=self.stack.request('GET','/me',role).body['actor']
   self.assertRegex(institution,r'^[A-Za-z0-9-]+$');self.assertRegex(subject,r'^[a-f0-9-]{36}$');self.assertTrue(actor.startswith('kin-test-') and actor.endswith('@local.test'))
   self.favoriteOwners[role]=r.body['owner']
   def cleanup():
    self.close_contexts();self.contexts=[]
    psql(f'''BEGIN; DELETE FROM "FavoriteWorkspace" WHERE institution='{institution}' AND subject='{subject}'; DELETE FROM "AuditLog" WHERE actor='{actor}' AND action LIKE 'favorite.%'; COMMIT;''')
    self.assertEqual(psql(f'''SELECT count(*) FROM "FavoriteWorkspace" WHERE institution='{institution}' AND subject='{subject}' '''),['0'])
   self.addCleanup(cleanup)
  return r.body
 def body(self,state,action,folder,**extra):
  return dict(expectedOwner=state['owner'],revision=state['revision'],requestId=str(uuid.uuid4()),folderId=folder,action=action,**extra)
 def change(self,body,role='doctor',status=201):
  r=self.stack.request('POST','/favorite-folders',role,body);self.assertEqual(r.status,status,r.text);return r.body
 def test_favorite_01_api_identity_retry_revision_and_original(self):
  a=self.fixture();before=psql(f'''SELECT to_jsonb(t)::text FROM "StudyState" t WHERE uid='{a.uid}' ''');s=self.account();fid=str(uuid.uuid4())
  request=self.body(s,'create',fid,name='SYNTHETIC <folder>');s=self.change(request);again=self.change(request);self.assertEqual(again,s)
  s=self.change(self.body(s,'add',fid,uid=a.uid));self.assertEqual(s['folders'][0]['uids'],[a.uid])
  stale=self.body(s,'rename',fid,name='SYNTHETIC stale');s=self.change(self.body(s,'rename',fid,name='SYNTHETIC renamed'));self.change(stale,status=409)
  self.assertEqual(self.account('doctor2')['folders'],[])
  other=self.body(s,'rename',fid,name='intrusion');other['expectedOwner']=self.favoriteOwners['doctor2'];self.change(other,'doctor2',409)
  self.change(self.body(self.account('doctor2'),'rename',fid,name='intrusion'),'doctor2',404)
  psql(f'''UPDATE "StudyState" SET "institutionId"='kin-center' WHERE uid='{a.uid}' ''')
  hidden=self.account();self.assertEqual(hidden['folders'][0]['uids'],[]);self.assertEqual(hidden['folders'][0]['unavailable'],1)
  self.change(self.body(hidden,'add',fid,uid=a.uid),status=404)
  psql(f'''UPDATE "StudyState" SET "institutionId"='hallym' WHERE uid='{a.uid}' ''')
  s=self.account();self.assertEqual(s['folders'][0]['uids'],[a.uid]);s=self.change(self.body(s,'remove',fid,uid=a.uid));self.assertEqual(s['folders'][0]['uids'],[])
  s=self.change(self.body(s,'delete',fid));self.assertEqual(s['folders'],[])
  self.assertEqual(psql(f'''SELECT to_jsonb(t)::text FROM "StudyState" t WHERE uid='{a.uid}' '''),before)
  for body in [dict(s,action='create'),self.body(s,'create',str(uuid.uuid4()),name=''),self.body(s,'add',str(uuid.uuid4()),uid='../bad')]:self.change(body,status=400)

 def test_favorite_02_browser_cross_context_and_report_roundtrip(self):
  a=self.fixture();b=self.fixture(patient_id=a.patient_id);self.seed_report(a);self.seed_report(b);self.account();p=self.login();self.select(p,a)
  p.locator('#findings').fill('KEEP FAVORITE REPORT');p.locator('#favorite-open').click()
  p.locator('#favorite-new-name').fill('SYNTHETIC <favorite>');p.locator('#favorite-create').click();expect(p.locator('#favorite-status')).to_have_text('저장되었습니다.')
  p.locator('#favorite-add').click();expect(p.locator('.favorite-link')).to_have_count(1);p.locator('#favorite-close').click()
  self.select(p,b);p.locator('#favorite-open').click();expect(p.locator('#favorite-name')).to_have_value('SYNTHETIC <favorite>')
  p.locator('#favorite-add').click();expect(p.locator('.favorite-link')).to_have_count(2)
  p.locator('#favorite-name').fill('SYNTHETIC renamed folder');p.locator('#favorite-rename').click();expect(p.locator('#favorite-folders')).to_contain_text('SYNTHETIC renamed folder')
  p.locator(f'.favorite-link[data-uid="{a.uid}"]').get_by_role('button',name='검사 선택',exact=True).click();expect(p.locator('#favorite-dialog')).not_to_be_visible()
  expect(p.locator('#findings')).to_have_value('KEEP FAVORITE REPORT');expect(p.locator('#rows tr.sel')).to_have_attribute('data-uid',a.uid)
  other=self.login();self.select(other,a);other.locator('#favorite-open').click();expect(other.locator('.favorite-link')).to_have_count(2)
  self.assertEqual(other.locator('#favorite-folders b').count(),0)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);other.screenshot(path=str(folder/'favorites.png'))
  other.locator(f'.favorite-link[data-uid="{b.uid}"]').get_by_role('button',name='링크 제거',exact=True).click();expect(other.locator('.favorite-link')).to_have_count(1)
  other.once('dialog',lambda d:d.accept());other.locator('#favorite-delete').click();expect(other.locator('#favorite-folders button')).to_have_count(0)
  self.assertEqual(len(self.versions(a)),1);self.assertEqual(len(self.versions(b)),1)

 def test_favorite_03_lost_response_retry_and_conflict_input(self):
  a=self.fixture();self.account();p=self.login();self.select(p,a);p.locator('#favorite-open').click();expect(p.locator('#favorite-status')).to_contain_text('최신 즐겨찾기')
  def lost(route):route.fetch();route.abort()
  p.route('**/api/favorite-folders',lambda route:lost(route) if route.request.method=='POST' else route.continue_())
  p.locator('#favorite-new-name').fill('SYNTHETIC retry');p.locator('#favorite-create').click();expect(p.locator('#favorite-status')).to_contain_text('저장 확인 실패')
  expect(p.locator('#favorite-new-name')).to_have_value('SYNTHETIC retry');p.unroute('**/api/favorite-folders');p.locator('#favorite-retry').click()
  expect(p.locator('#favorite-folders button')).to_have_count(1);s=self.account();self.assertEqual(s['revision'],1)
  fid=s['folders'][0]['id'];self.change(self.body(s,'rename',fid,name='SYNTHETIC other browser'))
  p.locator('#favorite-name').fill('SYNTHETIC intended rename');p.locator('#favorite-rename').click();expect(p.locator('#favorite-status')).to_contain_text('바뀌었습니다')
  expect(p.locator('#favorite-name')).to_have_value('SYNTHETIC intended rename');p.locator('#favorite-reload').click();expect(p.locator('#favorite-folders')).to_contain_text('SYNTHETIC other browser')
  expect(p.locator('#favorite-name')).to_have_value('SYNTHETIC intended rename');p.locator('#favorite-rename').click();expect(p.locator('#favorite-folders')).to_contain_text('SYNTHETIC intended rename')

 def test_favorite_04_limits_and_request_id_payload_binding(self):
  a=self.fixture();s=self.account();fid=str(uuid.uuid4());body=self.body(s,'create',fid,name='SYNTHETIC limit');s=self.change(body)
  changed={**body,'name':'changed payload'};self.change(changed,status=409)
  institution,subject=s['owner']
  def seed(folders):
   value=json.dumps(folders).replace("'","''");psql(f'''UPDATE "FavoriteWorkspace" SET value='{value}' WHERE institution='{institution}' AND subject='{subject}' ''')
  try:
   seed([dict(id=str(uuid.uuid4()),name='SYNTHETIC cap',uids=[]) for _ in range(50)])
   self.change(self.body(s,'create',str(uuid.uuid4()),name='SYNTHETIC overflow'),status=400)
   seed([dict(id=fid,name='SYNTHETIC cap',uids=['2.25.'+str(n) for n in range(500)])])
   self.change(self.body(s,'add',fid,uid=a.uid),status=400)
  finally:seed([])

 def test_favorite_05_revoked_link_cannot_select_and_late_session_read(self):
  a=self.fixture();b=self.fixture(patient_id=a.patient_id);s=self.account();fid=str(uuid.uuid4());s=self.change(self.body(s,'create',fid,name='SYNTHETIC session'))
  s=self.change(self.body(s,'add',fid,uid=a.uid));p=self.login();self.select(p,b);p.locator('#favorite-open').click();expect(p.locator('.favorite-link')).to_have_count(1)
  psql(f'''UPDATE "StudyState" SET "institutionId"='kin-center' WHERE uid='{a.uid}' ''')
  try:
   p.locator('.favorite-link').get_by_role('button',name='검사 선택',exact=True).click();expect(p.locator('#favorite-status')).to_contain_text('지금 열 수 없습니다')
   expect(p.locator('#rows tr.sel')).to_have_attribute('data-uid',b.uid);expect(p.locator('.favorite-link')).to_have_count(0)
  finally:psql(f'''UPDATE "StudyState" SET "institutionId"='hallym' WHERE uid='{a.uid}' ''')
  p.locator('#favorite-close').click();pending=[];p.route('**/api/favorite-folders',lambda route:pending.append(route))
  p.locator('#favorite-open').click();expect(p.locator('#favorite-status')).to_contain_text('읽는 중')
  p.evaluate("() => {const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}")
  expect(p.locator('#favorite-dialog')).not_to_be_visible();self.assertEqual(len(pending),1)
  s['folders'][0]['name']='LATE FAVORITE SECRET';pending[0].fulfill(status=200,content_type='application/json',body=json.dumps(s))
  expect(p.locator('#favorite-folders')).to_be_empty();expect(p.locator('body')).not_to_contain_text('LATE FAVORITE SECRET')

 def test_favorite_06_unsaved_name_and_mismatched_owner_clear(self):
  a=self.fixture();s=self.account();fid=str(uuid.uuid4());s=self.change(self.body(s,'create',fid,name='SYNTHETIC private folder'))
  p=self.login();self.select(p,a);p.locator('#favorite-open').click();expect(p.locator('#favorite-name')).to_have_value('SYNTHETIC private folder')
  p.locator('#favorite-name').fill('UNSAVED NAME');p.once('dialog',lambda d:d.dismiss());p.locator('#favorite-close').click()
  expect(p.locator('#favorite-dialog')).to_be_visible();expect(p.locator('#favorite-name')).to_have_value('UNSAVED NAME')
  s['owner']=['hallym',str(uuid.uuid4())];s['folders'][0]['name']='OTHER OWNER SECRET'
  p.route('**/api/favorite-folders',lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps(s)))
  p.locator('#favorite-reload').click();expect(p.locator('#favorite-dialog')).not_to_be_visible()
  expect(p.locator('#favorite-folders')).to_be_empty();expect(p.locator('#favorite-name')).to_have_value('');expect(p.locator('body')).not_to_contain_text('OTHER OWNER SECRET')


 def test_favorite_07_changed_selection_and_uncommitted_retry(self):
  a=self.fixture();b=self.fixture(patient_id=a.patient_id);s=self.account();fid=str(uuid.uuid4());self.change(self.body(s,'create',fid,name='SYNTHETIC selection guard'))
  p=self.login();self.select(p,a);p.locator('#favorite-open').click();expect(p.locator('#favorite-name')).to_have_value('SYNTHETIC selection guard')
  p.locator(f'#rows tr[data-uid="{b.uid}"]').evaluate('(el)=>el.click()');expect(p.locator('#rows tr.sel')).to_have_attribute('data-uid',b.uid)
  p.locator('#favorite-add').click();expect(p.locator('#favorite-status')).to_contain_text('선택 검사가 바뀌었습니다');self.assertEqual(self.account()['folders'][0]['uids'],[])
  p.route('**/api/favorite-folders',lambda route:route.fulfill(status=503,content_type='application/json',body=json.dumps({'message':'SYNTHETIC busy'})) if route.request.method=='POST' else route.continue_())
  p.locator('#favorite-add').click();expect(p.locator('#favorite-retry')).to_be_visible();p.locator('#favorite-reload').click()
  expect(p.locator('#favorite-status')).to_contain_text('아직 반영되지 않았습니다');expect(p.locator('#favorite-retry')).to_be_visible()
  p.unroute('**/api/favorite-folders');p.locator('#favorite-retry').click();expect(p.locator('.favorite-link')).to_have_count(1)
  self.assertEqual(self.account()['folders'][0]['uids'],[b.uid])

def load_tests(loader,tests,pattern):
 return unittest.TestSuite(FavoritesE2E(n) for n in loader.getTestCaseNames(FavoritesE2E) if n.startswith('test_favorite_'))
if __name__=='__main__':unittest.main(verbosity=2)
