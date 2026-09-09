# coding: utf-8
"""IF-W15: personal/shared vocabulary, assignment permission and search preservation."""
import json,os,unittest,uuid
from pathlib import Path
from playwright.sync_api import expect
from test_worklist import WorklistE2E,psql

def literal(x):return "'"+str(x).replace("'","''")+"'"
class StudyTagsE2E(WorklistE2E):
 def setUp(self):
  super().setUp();self.tagOwners=set();self.tagInstitutions=set();self.tagActors=set();self.tagIds=set();self.tagRequests=set();self.tagCleanup=False
 def login(self,actor='doctor'):
  p=super().login(actor)
  def capture(req):
   if req.method=='POST' and req.url.split('?')[0].endswith('/api/study-tags'):
    body=req.post_data_json;self.tagIds.add(body['tagId']);self.tagRequests.add(body['requestId'])
  p.on('request',capture);return p
 def account(self,role='doctor'):
  r=self.stack.request('GET','/study-tags',role);self.assertEqual(r.status,200,r.text);inst,sub=r.body['owner'];actor=self.stack.request('GET','/me',role).body['actor']
  self.assertRegex(inst,r'^[A-Za-z0-9-]+$');self.assertRegex(sub,r'^[a-f0-9-]{36}$');self.assertTrue(actor.startswith('kin-test-') and actor.endswith('@local.test'))
  if inst not in self.tagInstitutions:
   self.assertEqual(psql('SELECT count(*) FROM "StudyTagCatalog" WHERE institution='+literal(inst)+' AND "ownerSub"='+literal('')),['0'],'Shared catalog must be absent before this synthetic run')
   self.tagInstitutions.add(inst)
  self.tagOwners.add((inst,sub));self.tagActors.add(actor)
  if not self.tagCleanup:self.addCleanup(self.cleanup_tags);self.tagCleanup=True
  return r.body
 def cleanup_tags(self):
  self.close_contexts();self.contexts=[]
  owners=self.tagOwners|{(inst,'') for inst in self.tagInstitutions}
  for inst,sub in owners:
   rows=psql('SELECT to_jsonb(t)::text FROM "StudyTagCatalog" t WHERE institution='+literal(inst)+' AND "ownerSub"='+literal(sub))
   for raw in rows:
    row=json.loads(raw);tags=json.loads(row['value']);self.assertTrue({t['id'] for t in tags}<=self.tagIds)
    self.assertTrue({uid for t in tags for uid in t['uids']}<=set(self.stack.active))
    self.assertIn(row['lastRequest'],self.tagRequests,'Catalog last writer is not owned by this test')
    actors=psql('SELECT DISTINCT actor FROM "AuditLog" WHERE action LIKE '+literal('study.tag.%')+' AND target IN ('+','.join(literal(x) for x in self.tagIds)+')')
    self.assertTrue(set(actors)<=self.tagActors,'Foreign audit actor touched test tags')
    self.assertEqual(psql('DELETE FROM "StudyTagCatalog" t WHERE to_jsonb(t)='+literal(raw)+'::jsonb RETURNING 1'),['1'],'Catalog changed during cleanup')
  if self.tagIds:
   actors=psql('SELECT DISTINCT actor FROM "AuditLog" WHERE action LIKE '+literal('study.tag.%')+' AND target IN ('+','.join(literal(x) for x in self.tagIds)+')')
   self.assertTrue(set(actors)<=self.tagActors,'Foreign audit actor touched test tags')
  if self.tagActors:psql('DELETE FROM "AuditLog" WHERE action LIKE '+literal('study.tag.%')+' AND actor IN ('+','.join(literal(x) for x in self.tagActors)+')')
 def catalog(self,state,scope='personal'):return next(c for c in state['catalogs'] if c['scope']==scope)
 def body(self,state,action,tagId,scope='personal',**extra):
  self.tagIds.add(tagId);request=str(uuid.uuid4());self.tagRequests.add(request);return dict(expectedOwner=state['owner'],scope=scope,revision=self.catalog(state,scope)['revision'],requestId=request,tagId=tagId,action=action,**extra)
 def change(self,body,role='doctor',status=201):
  r=self.stack.request('POST','/study-tags',role,body);self.assertEqual(r.status,status,r.text);return r.body
 def test_tags_01_private_shared_roles_revision_and_original(self):
  a=self.fixture();before=psql('SELECT to_jsonb(t)::text FROM "StudyState" t WHERE uid='+literal(a.uid));s=self.account();tid=str(uuid.uuid4());body=self.body(s,'create',tid,name='SYNTHETIC private');s=self.change(body);self.assertEqual(self.change(body),s)
  s=self.change(self.body(s,'add',tid,uid=a.uid));self.assertEqual(self.catalog(s)['tags'][0]['uids'],[a.uid]);other=self.account('doctor2');self.assertEqual(self.catalog(other)['tags'],[])
  self.change(self.body(other,'rename',tid,name='intrusion'),'doctor2',404)
  self.change(self.body(s,'create',str(uuid.uuid4()),scope='institution',name='no permission'),status=403)
  admin=self.account('jmryu');shared=str(uuid.uuid4());admin=self.change(self.body(admin,'create',shared,scope='institution',name='SYNTHETIC shared'),'jmryu')
  tech=self.account('tech');assigned=self.body(tech,'add',shared,scope='institution',uid=a.uid);tech=self.change(assigned,'tech');self.assertEqual(self.catalog(tech,'institution')['tags'][0]['uids'],[a.uid])
  other=self.account('doctor2');intrusion={**assigned,'expectedOwner':other['owner']};self.change(intrusion,'doctor2',409)
  self.change(self.body(other,'rename',shared,scope='institution',name='no permission'),'doctor2',403)
  self.change(self.body(other,'delete',shared,scope='institution'),'doctor2',403)
  psql('UPDATE "StudyState" SET "institutionId"='+literal('kin-center')+' WHERE uid='+literal(a.uid))
  try:self.change(self.body(other,'remove',shared,scope='institution',uid=a.uid),'doctor2',404)
  finally:psql('UPDATE "StudyState" SET "institutionId"='+literal('hallym')+' WHERE uid='+literal(a.uid))
  other=self.change(self.body(other,'remove',shared,scope='institution',uid=a.uid),'doctor2');self.change(assigned,'tech',409)
  foreign=self.account('kdoctor');self.assertEqual(self.catalog(foreign,'institution')['tags'],[])
  self.change(self.body(foreign,'add',shared,scope='institution',uid=a.uid),'kdoctor',404)
  s=self.account();stale=self.body(s,'rename',tid,name='stale');s=self.change(self.body(s,'rename',tid,name='SYNTHETIC renamed'));self.change(stale,status=409)
  for name in ['', 'x'*121, 'bad\nname']:self.change(self.body(s,'create',str(uuid.uuid4()),name=name),status=400)
  s=self.change(self.body(s,'delete',tid));admin=self.account('jmryu');self.change(self.body(admin,'delete',shared,scope='institution'),'jmryu')
  self.assertEqual(psql('SELECT to_jsonb(t)::text FROM "StudyState" t WHERE uid='+literal(a.uid)),before)
 def test_tags_02_browser_assignment_search_and_report(self):
  a=self.fixture();b=self.fixture(patient_id=a.patient_id);c=self.fixture(patient_id=a.patient_id)
  for f in [a,b,c]:self.seed_report(f)
  self.account();p=self.login();self.select(p,a);p.locator('#study-tag-open').click();p.locator('#study-tag-new').fill('SYNTHETIC <tag>')
  with p.expect_response('**/api/study-tags') as response:p.locator('#study-tag-create').click()
  data=response.value.json();self.tagIds.update(t['id'] for t in self.catalog(data)['tags']);expect(p.locator('#study-tag-name')).to_have_value('SYNTHETIC <tag>')
  p.locator('#study-tag-add').click();expect(p.locator('#study-tag-assigned')).to_have_text('이 검사에 부여된 태그입니다.');p.locator('#study-tag-close').click()
  self.select(p,b);p.locator('#study-tag-open').click();p.locator('#study-tag-add').click();expect(p.locator('#study-tag-count')).to_contain_text('2건');p.locator('#study-tag-close').click()
  self.select(p,c);p.locator('#findings').fill('KEEP TAG REPORT');p.locator('#study-tag-open').click();p.locator('#study-tag-apply').click();expect(p.locator('#rows tr[data-uid]')).to_have_count(2);expect(p.locator('#findings')).to_have_value('KEEP TAG REPORT')
  expect(p.locator('#filterlist')).to_contain_text('태그: [개인] SYNTHETIC <tag>');p.locator('#study-tag-clear').click();expect(p.locator('#rows tr[data-uid]')).to_have_count(3)
  other=self.login();self.select(other,a);other.locator('#study-tag-open').click();expect(other.locator('#study-tag-name')).to_have_value('SYNTHETIC <tag>');expect(other.locator('#study-tag-assigned')).to_contain_text('부여된')
  other.locator('#study-tag-name').fill('SYNTHETIC renamed');other.locator('#study-tag-remove').click();expect(other.locator('#study-tag-name')).to_have_value('SYNTHETIC renamed');other.locator('#study-tag-rename').click();expect(other.locator('#study-tag-list')).to_contain_text('SYNTHETIC renamed')
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);other.screenshot(path=str(folder/'study-tags.png'))
  other.once('dialog',lambda d:d.accept());other.locator('#study-tag-delete').click();expect(other.locator('#study-tag-list button')).to_have_count(0)
  self.assertEqual(len(self.versions(c)),1)
 def test_tags_03_shared_ui_and_revocation(self):
  a=self.fixture();admin=self.account('jmryu');tid=str(uuid.uuid4());self.change(self.body(admin,'create',tid,scope='institution',name='SYNTHETIC institution'),'jmryu');self.account();p=self.login();self.select(p,a);p.locator('#study-tag-open').click();p.locator('#study-tag-scope').select_option('institution')
  expect(p.locator('#study-tag-create')).to_be_disabled();expect(p.locator('#study-tag-rename')).to_be_disabled();expect(p.locator('#study-tag-delete')).to_be_disabled();expect(p.locator('#study-tag-add')).to_be_enabled()
  p.locator('#study-tag-add').click();expect(p.locator('#study-tag-assigned')).to_contain_text('부여된');p.locator('#study-tag-apply').click();expect(p.locator('#rows tr[data-uid]')).to_have_count(1)
  psql('UPDATE "StudyState" SET "institutionId"='+literal('kin-center')+' WHERE uid='+literal(a.uid))
  try:p.locator('#refresh').click();expect(p.locator('#rows tr[data-uid]')).to_have_count(0)
  finally:psql('UPDATE "StudyState" SET "institutionId"='+literal('hallym')+' WHERE uid='+literal(a.uid))
  p.locator('#refresh').click();expect(p.locator('#rows tr[data-uid]')).to_have_count(1)
 def test_tags_04_lost_response_conflict_and_late_session(self):
  a=self.fixture();self.account();p=self.login();self.select(p,a);p.locator('#study-tag-open').click();expect(p.locator('#study-tag-status')).to_contain_text('최신 태그')
  def lost(route):
   self.tagIds.add(route.request.post_data_json['tagId']);route.fetch();route.abort()
  p.route('**/api/study-tags',lambda r:lost(r) if r.request.method=='POST' else r.continue_());p.locator('#study-tag-new').fill('SYNTHETIC retry');p.locator('#study-tag-create').click();expect(p.locator('#study-tag-status')).to_contain_text('저장 확인 실패');expect(p.locator('#study-tag-retry')).to_be_enabled()
  p.unroute('**/api/study-tags');p.locator('#study-tag-retry').click();expect(p.locator('#study-tag-list button')).to_have_count(1);s=self.account();self.assertEqual(self.catalog(s)['revision'],1)
  tid=self.catalog(s)['tags'][0]['id'];self.change(self.body(s,'rename',tid,name='SYNTHETIC concurrent'));p.locator('#study-tag-name').fill('SYNTHETIC intended');p.locator('#study-tag-rename').click();expect(p.locator('#study-tag-status')).to_contain_text('바뀌었습니다')
  expect(p.locator('#study-tag-name')).to_have_value('SYNTHETIC intended');p.locator('#study-tag-reload').click();expect(p.locator('#study-tag-list')).to_contain_text('SYNTHETIC concurrent');expect(p.locator('#study-tag-name')).to_have_value('SYNTHETIC intended');p.locator('#study-tag-rename').click();expect(p.locator('#study-tag-list')).to_contain_text('SYNTHETIC intended')
  p.locator('#study-tag-close').click();waiting=[];p.route('**/api/study-tags',lambda r:waiting.append(r));p.locator('#study-tag-open').click();expect(p.locator('#study-tag-status')).to_contain_text('읽는 중')
  p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(p.locator('#study-tag-dialog')).not_to_be_visible()
  for route in waiting:route.fulfill(status=200,content_type='application/json',body=json.dumps(s))
  expect(p.locator('#study-tag-list')).to_be_empty();expect(p.locator('#study-tag-name')).to_have_value('')

def load_tests(loader,tests,pattern):return unittest.TestSuite(StudyTagsE2E(n) for n in loader.getTestCaseNames(StudyTagsE2E) if n.startswith('test_tags_'))
if __name__=='__main__':unittest.main(verbosity=2)
