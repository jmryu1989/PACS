# coding: utf-8
"""REQ-D01-TECH-NOTE / RISK-D01-NOTE-IDENTITY/HISTORY / TEST-D01-TECH-NOTE."""
# List integration also covers badge-only payloads, preserved report selection,
# keyboard opening, clear/history status and rejection of older list versions.
import json, os, sys, unittest, subprocess, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from playwright.sync_api import expect
from test_worklist import WorklistE2E, psql, ROOT
from test_prior_selection import canvas_ready


class TechNoteE2E(WorklistE2E):
 @classmethod
 def setUpClass(cls):
  super().setUpClass()
  cls.stack.create_test_identity('kadmin',['admin'],'kin-center')
 def path(self,f): return '/studies/'+f.uid+'/tech-note'
 def write(self,f,text,version=0,reason='',actor='tech'):
  return self.stack.request('POST',self.path(f),actor,dict(text=text,baseVersion=version,reason=reason))

 def test_note_01_roles_history_conflicts_and_originals(self):
  f=self.fixture();path=self.path(f)
  before=psql(f'''SELECT to_jsonb(t)::text FROM "StudyState" t WHERE uid='{f.uid}' ''')
  self.assertEqual(self.stack.request('GET',path,'doctor').body['note'],None)
  self.assertEqual(self.write(f,'not allowed',actor='doctor').status,403)
  for actor in ['kdoctor','kadmin']:
   self.assertEqual(self.stack.request('GET',path,actor).status,404)
   self.assertIn(self.write(f,'not allowed',actor=actor).status,[403,404])
   self.assertEqual(self.stack.request('GET',path+'/history',actor).status,404)
  r=self.write(f,'<script>SYNTHETIC & first</script>');self.assertEqual(r.status,201,r.text)
  self.assertEqual(r.body['note']['version'],1)
  self.assertNotIn('authorSub',r.body['note']);self.assertNotIn('institutionId',r.body['note'])
  self.assertEqual(r.body['note']['author'],self.stack.username('tech')+'@local.test' if '@' not in self.stack.username('tech') else self.stack.username('tech'))
  self.assertEqual(self.write(f,'edit',1).status,400)
  self.assertEqual(self.write(f,'stale',0,'stale').status,409)
  # Two requests based on the same version cannot silently overwrite each other.
  with ThreadPoolExecutor(2) as pool:
   replies=list(pool.map(lambda text:self.write(f,text,1,'concurrent edit'),['second A','second B']))
  self.assertEqual(sorted(r.status for r in replies),[201,409])
  self.assertEqual(self.write(f,'',2,'clear with history').status,201)
  history=self.stack.request('GET',path+'/history','doctor').body['items']
  self.assertEqual([n['version'] for n in history],[3,2,1])
  self.assertEqual(history[-1]['text'],'<script>SYNTHETIC & first</script>')
  self.assertEqual(self.stack.request('DELETE','/studies/'+f.uid,'tech').status,409)
  for body in [dict(text='x',reason='',baseVersion=-1),dict(text='x',reason='',baseVersion=3,author='forged'),dict(text='x'*10001,reason='',baseVersion=3)]:
   self.assertEqual(self.stack.request('POST',path,'tech',body).status,400)
  self.assertEqual(self.stack.request('GET',path+'/history?before=bad','tech').status,400)
  self.assertEqual(self.write(f,'\ud800',3,'bad unicode').status,400)
  self.assertEqual(psql(f'''SELECT to_jsonb(t)::text FROM "StudyState" t WHERE uid='{f.uid}' '''),before)
  self.assertEqual(psql(f'''SELECT count(*) FROM "ReportVersion" WHERE uid='{f.uid}' '''),['0'])

 def test_note_03_remote_read_only_revocation_and_paging(self):
  f=self.fixture();path=self.path(f)
  self.assertEqual(self.write(f,'SYNTHETIC owner note').status,201)
  psql(f'''UPDATE "StudyState" SET "teleInstitutionId"='kin-center' WHERE uid='{f.uid}' ''')
  remote=self.stack.request('GET',path,'kadmin');self.assertEqual(remote.status,200,remote.text)
  self.assertFalse(remote.body['writable']);self.assertEqual(remote.body['note']['text'],'SYNTHETIC owner note')
  self.assertEqual(self.write(f,'remote modification',1,'not allowed',actor='kadmin').status,403)
  # Synthetic immutable rows exercise the bounded history cursor without 50 UI writes.
  psql(f'''INSERT INTO "TechNoteRevision" ("studyUid",version,text,reason,author,"authorSub","institutionId") SELECT '{f.uid}',n,'SYNTHETIC history','paging','SYNTHETIC-tech','SYNTHETIC-sub','hallym' FROM generate_series(2,52) n''')
  first=self.stack.request('GET',path+'/history','doctor').body
  self.assertEqual(len(first['items']),50);self.assertEqual(first['nextBefore'],3)
  last=self.stack.request('GET',path+'/history?before=3','doctor').body
  self.assertEqual([n['version'] for n in last['items']],[2,1]);self.assertIsNone(last['nextBefore'])
  psql(f'''UPDATE "StudyState" SET "teleInstitutionId"=NULL WHERE uid='{f.uid}' ''')
  self.assertEqual(self.stack.request('GET',path,'kadmin').status,404)
  self.assertEqual(self.stack.request('GET',path+'/history','kadmin').status,404)

 def test_note_04_lock_retry_and_late_session_response(self):
  f=self.fixture();path=self.path(f)
  lock_name='tech-note-lock-'+f.uid[-16:]
  with subprocess.Popen(['docker','compose','exec','-T','db','psql','-U','kin','-d','kin','-At','-v','ON_ERROR_STOP=1','-c',
      f'''SET application_name='{lock_name}'; BEGIN; SELECT uid FROM "StudyState" WHERE uid='{f.uid}' FOR UPDATE; SELECT pg_sleep(8); COMMIT;'''],
      cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) as lock:
   # psql stdout is buffered through Docker pipes; observe the actual held lock.
   deadline=time.monotonic()+5
   while psql(f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{lock_name}' AND wait_event='PgSleep'") != ['1']:
    self.assertLess(time.monotonic(),deadline,'Owned lock did not become active');time.sleep(.1)
   result=self.stack.request('GET',path,'tech');self.assertEqual(result.status,503,result.text)
   lock.communicate(timeout=10);self.assertEqual(lock.returncode,0)
  p=self.login('tech');self.select(p,f);pending=[]
  p.route('**/tech-note',lambda route:pending.append(route))
  p.locator('#tech-note-open').click();expect(p.locator('#tech-note-status')).to_contain_text('불러오는 중')
  p.wait_for_function("() => document.querySelector('#tech-note-save').disabled")
  p.evaluate("() => {const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}")
  expect(p.locator('#tech-note-dialog')).not_to_be_visible()
  self.assertEqual(len(pending),1)
  pending[0].fulfill(status=200,content_type='application/json',body=json.dumps(dict(uid=f.uid,writable=True,note=dict(studyUid=f.uid,version=1,text='LATE SECRET',author='SYNTHETIC',createdAt='2026-09-09T00:00:00Z'))))
  expect(p.locator('#tech-note-text')).to_have_value('');expect(p.locator('#tech-note-dialog')).not_to_be_visible()

 def test_note_02_real_save_reopen_reader_and_failed_input(self):
  f=self.fixture();p=self.login('tech');self.select(p,f)
  p.locator('#tech-note-open').click();expect(p.locator('#tech-note-text')).to_be_editable()
  p.locator('#tech-note-text').fill('SYNTHETIC Tech communication <b>literal</b>')
  p.locator('#tech-note-save').click();expect(p.locator('#tech-note-status')).to_have_text('저장되었습니다. v1')
  p.locator('#tech-note-close').click();p.locator('#tech-note-open').click()
  expect(p.locator('#tech-note-text')).to_have_value('SYNTHETIC Tech communication <b>literal</b>')
  p.locator('#tech-note-text').fill('SYNTHETIC revised');p.locator('#tech-note-reason').fill('correct communication')
  p.route('**/tech-note',lambda route: route.abort() if route.request.method=='POST' else route.continue_())
  p.locator('#tech-note-save').click();expect(p.locator('#tech-note-status')).to_contain_text('저장 확인 실패')
  expect(p.locator('#tech-note-text')).to_have_value('SYNTHETIC revised')
  p.unroute('**/tech-note');p.locator('#tech-note-save').click();expect(p.locator('#tech-note-status')).to_have_text('저장되었습니다. v2')
  p.locator('#tech-note-history').click();expect(p.locator('#tech-note-history-items section')).to_have_count(2)
  expect(p.locator('#tech-note-history-items')).to_contain_text('<b>literal</b>')
  self.assertEqual(p.locator('#tech-note-history-items b').count(),0)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'tech-note-history.png'))
  reader=self.login();self.select(reader,f);reader.locator('#tech-note-open').click()
  expect(reader.locator('#tech-note-status')).to_contain_text('읽기 전용')
  expect(reader.locator('#tech-note-save')).to_be_disabled();expect(reader.locator('#tech-note-text')).to_have_value('SYNTHETIC revised')
  p.locator('#tech-note-text').fill('UNSAVED');p.once('dialog',lambda d:d.dismiss());p.locator('#tech-note-close').click()
  expect(p.locator('#tech-note-dialog')).to_be_visible()
  p.evaluate("() => {const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}")
  expect(p.locator('#tech-note-dialog')).not_to_be_visible();expect(p.locator('#tech-note-text')).to_have_value('')

 def test_note_05_reading_workspace_report_return(self):
  f=self.fixture();self.assertEqual(self.write(f,'SYNTHETIC reading context note').status,201)
  p=self.login();self.select(p,f);p.locator('#m-reading').click()
  expect(p.locator('#reading-status')).to_have_text('영상 작업공간 연결됨',timeout=60000)
  frame=p.locator('#reading-frame').element_handle().content_frame();canvas_ready(frame,1)
  p.locator('#findings').fill('UNSAVED REPORT WITH TECH NOTE')
  p.keyboard.press('Control+Alt+5');p.locator('#tech-note-open').click()
  expect(p.locator('#tech-note-target')).to_contain_text(f.uid)
  expect(p.locator('#tech-note-text')).to_have_value('SYNTHETIC reading context note')
  p.locator('#tech-note-close').click();p.get_by_role('button',name='정보 닫고 판독문으로',exact=True).click()
  expect(p.locator('#findings')).to_be_focused();expect(p.locator('#findings')).to_have_value('UNSAVED REPORT WITH TECH NOTE')
  canvas_ready(frame,1)

 def test_note_06_list_badge_open_preserves_report_and_refreshes(self):
  a=self.fixture();b=self.fixture(patient_id=a.patient_id);p=self.login('tech');self.select(p,a)
  badge=p.locator(f'[data-tech-note="{b.uid}"]')
  expect(badge).to_have_text('없음');badge.focus();p.keyboard.press('Enter')
  expect(p.locator('#tech-note-target')).to_contain_text(b.uid)
  expect(p.locator('#rows tr.sel')).to_have_attribute('data-uid',a.uid)
  p.locator('#tech-note-text').fill('SYNTHETIC LIST NOTE');p.locator('#tech-note-save').click()
  expect(p.locator('#tech-note-status')).to_have_text('저장되었습니다. v1')
  expect(badge).to_have_text('있음');p.locator('#tech-note-close').click();expect(badge).to_be_focused()
  badge.click();expect(p.locator('#tech-note-text')).to_have_value('SYNTHETIC LIST NOTE')
  p.locator('#tech-note-text').fill('');p.locator('#tech-note-reason').fill('clear list note');p.locator('#tech-note-save').click()
  expect(p.locator('#tech-note-status')).to_have_text('저장되었습니다. v2');expect(badge).to_have_text('비움·이력')
  p.locator('#tech-note-close').click();p.reload();expect(p.locator('#dbstat')).to_contain_text('DB 연결됨');p.locator('#quick').fill(a.patient_id)
  expect(badge).to_have_text('비움·이력')
  reader=self.login();self.select(reader,a);reader.locator('#findings').fill('UNSAVED READING TARGET')
  reader.locator(f'[data-tech-note="{b.uid}"]').click();expect(reader.locator('#tech-note-status')).to_contain_text('읽기 전용')
  expect(reader.locator('#rows tr.sel')).to_have_attribute('data-uid',a.uid)
  reader.locator('#tech-note-close').click();expect(reader.locator('#findings')).to_have_value('UNSAVED READING TARGET')
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);reader.screenshot(path=str(folder/'tech-note-list.png'))

 def test_note_07_summary_tenant_and_payload(self):
  f=self.fixture();self.assertEqual(self.write(f,'SYNTHETIC HIDDEN BODY').status,201)
  result=self.stack.request('GET','/studies','doctor');self.assertEqual(result.status,200)
  row=next(r for r in result.body['studies'] if r['uid']==f.uid)
  self.assertEqual(row['techNote'],dict(version=1,present=True));self.assertNotIn('SYNTHETIC HIDDEN BODY',result.text)
  result=self.stack.request('GET','/studies','kadmin');self.assertEqual(result.status,200)
  self.assertNotIn(f.uid,[r['uid'] for r in result.body['studies']])
  self.assertNotIn('SYNTHETIC HIDDEN BODY',result.text)

 def test_note_08_old_list_response_cannot_rollback_saved_badge(self):
  f=self.fixture();p=self.login('tech');self.select(p,f)
  badge=p.locator(f'[data-tech-note="{f.uid}"]');badge.click()
  p.locator('#tech-note-text').fill('SYNTHETIC local save');p.locator('#tech-note-save').click()
  expect(p.locator('#tech-note-status')).to_have_text('저장되었습니다. v1');p.locator('#tech-note-close').click()
  def old_list(route):
   response=route.fetch();body=response.json()
   row=next(r for r in body['studies'] if r['uid']==f.uid)
   row['techNote']=dict(version=0,present=False);row['desc']='SYNTHETIC stale list applied'
   route.fulfill(response=response,json=body)
  p.route('**/api/studies',old_list);p.locator('#refresh').click()
  expect(p.locator(f'#rows tr[data-uid="{f.uid}"]')).to_contain_text('SYNTHETIC stale list applied')
  expect(badge).to_have_text('있음');p.unroute('**/api/studies')


def load_tests(loader,tests,pattern):
 return unittest.TestSuite(TechNoteE2E(n) for n in loader.getTestCaseNames(TechNoteE2E) if n.startswith('test_note_'))

if __name__=='__main__':
 sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
