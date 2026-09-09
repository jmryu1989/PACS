# coding: utf-8
"""Standalone note viewport identity, owner binding and preserved image/report state."""
import json,os,unittest,uuid
from pathlib import Path
from playwright.sync_api import expect
from test_reading_note import ReadingNoteE2E,canvas_ready
from test_display_controls import DisplayControlsE2E

class ViewerTechNoteE2E(ReadingNoteE2E):
 def active(self,p,uid):
  cells=self.cells(p);index=next(i for i,c in enumerate(cells) if '/studies/'+uid+'/' in (c['image'] or ''));DisplayControlsE2E.choose(self,p,index)
 def snapshot(self,p):
  return p.evaluate("""()=>cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports()).filter(v=>v.getCurrentImageId?.()).map(v=>{const c=v.element.querySelector('canvas'),pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let hash=2166136261;for(let n=0;n<pixels.length;n+=4)hash=Math.imul(hash^pixels[n],16777619)>>>0;return {image:v.getCurrentImageId(),camera:v.getCamera(),voi:v.getProperties().voiRange,pixelHash:hash}})""")
 def ready(self,p):expect(p.locator('#kin-viewer-note-open')).to_be_enabled(timeout=45000)
 def open_note(self,p):p.locator('#kin-viewer-note-open').click();expect(p.locator('#tech-note-meta')).not_to_be_empty()
 def test_viewer_note_01_active_prior_focus_and_report(self):
  a,b=self.pair();self.note(a,'CURRENT NOTE');self.note(b,'PRIOR ACTIVE NOTE');original=self.originals();p=self.login();f=self.workspace(p,a)
  p.locator('#findings').fill('KEEP POPUP REPORT')
  with p.context.expect_page() as opened:p.get_by_role('button',name='영상 새 창',exact=True).click()
  v=opened.value;canvas_ready(v,2);self.ready(v);self.active(v,b.uid)
  layout=v.locator('#kin-viewer-layout')
  if layout.get_attribute('open') is None:layout.locator('summary').first.click()
  v.get_by_label('작업 제목',exact=True).fill('KEEP POPUP JOB TITLE');before=self.snapshot(v);self.assertEqual(len(before),2);self.assertEqual({x['image'].split('/studies/')[1].split('/')[0] for x in before},{a.uid,b.uid});url=v.url
  v.keyboard.press('Control+Alt+6');expect(v.locator('#tech-note-target')).to_contain_text(b.uid);expect(v.locator('#tech-note-text')).to_have_value('PRIOR ACTIVE NOTE');expect(v.locator('#tech-note-save')).to_be_disabled()
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);v.screenshot(path=str(folder/'viewer-tech-note.png'))
  v.keyboard.press('Escape');expect(v.locator('#tech-note-dialog')).not_to_be_visible();expect(v.get_by_label('작업 제목',exact=True)).to_be_focused();expect(v.get_by_label('작업 제목',exact=True)).to_have_value('KEEP POPUP JOB TITLE');self.assertEqual(self.snapshot(v),before);self.assertEqual(v.url,url);expect(p.locator('#findings')).to_have_value('KEEP POPUP REPORT')
  self.active(v,a.uid);self.open_note(v);expect(v.locator('#tech-note-text')).to_have_value('CURRENT NOTE');v.locator('#tech-note-close').click();expect(v.locator('#kin-viewer-note-open')).to_be_focused();self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1)
 def test_viewer_note_02_technician_save_conflict_and_history(self):
  a=self.ct('VIEWER-NOTE-'+uuid.uuid4().hex[:10],'note','20260801');v=self.launch(self.login('tech'),[a]);self.ready(v);self.open_note(v);expect(v.locator('#tech-note-text')).to_be_editable();v.locator('#tech-note-text').fill('STANDALONE TECH NOTE');v.locator('#tech-note-save').click();expect(v.locator('#tech-note-status')).to_contain_text('저장되었습니다. v1')
  r=self.stack.request('POST',f'/studies/{a.uid}/tech-note','tech',dict(baseVersion=1,text='CONCURRENT NOTE',reason='synthetic concurrent'));self.assertEqual(r.status,201)
  v.locator('#tech-note-text').fill('KEEP UNSAVED NOTE');v.locator('#tech-note-reason').fill('synthetic edit');v.locator('#tech-note-save').click();expect(v.locator('#tech-note-status')).to_contain_text('저장 확인 실패');expect(v.locator('#tech-note-text')).to_have_value('KEEP UNSAVED NOTE')
  v.locator('#tech-note-history').click();expect(v.locator('#tech-note-history-items section')).to_have_count(2);expect(v.locator('#tech-note-text')).to_have_value('KEEP UNSAVED NOTE');v.once('dialog',lambda d:d.accept());v.locator('#tech-note-reload').click();expect(v.locator('#tech-note-text')).to_have_value('CONCURRENT NOTE');v.locator('#tech-note-close').click()
  v.reload();canvas_ready(v,1);self.ready(v);self.open_note(v);expect(v.locator('#tech-note-text')).to_have_value('CONCURRENT NOTE')
 def test_viewer_note_03_bound_headers_reject_before_read_write(self):
  a=self.ct('VIEWER-OWNER-'+uuid.uuid4().hex[:10],'owner','20260801');v=self.launch(self.login('tech'),[a]);self.ready(v);me=v.context.request.get(self.stack.api+'/me').json();path=self.stack.api+f'/studies/{a.uid}/tech-note';body=dict(baseVersion=0,text='MUST NOT SAVE',reason='')
  for headers in [{'X-KIN-Subject':self.stack.user_ids['doctor']},{'X-KIN-Institution':'kin-center'}]:
   headers['X-KIN-CSRF']='1'
   self.assertEqual(v.context.request.get(path,headers=headers).status,403);self.assertEqual(v.context.request.get(path+'/history',headers=headers).status,403);self.assertEqual(v.context.request.post(path,headers=headers,data=body).status,403)
  self.assertIsNone(self.stack.request('GET',f'/studies/{a.uid}/tech-note','tech').body['note']);self.open_note(v);expect(v.locator('#tech-note-text')).to_have_value('')
  v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(v.locator('#tech-note-dialog')).to_have_count(0);expect(v.locator('#kin-viewer-note-open')).to_be_disabled()
 def test_viewer_note_04_wrong_target_and_late_response(self):
  a=self.ct('VIEWER-LATE-'+uuid.uuid4().hex[:10],'late','20260801');self.note(a,'SAFE NOTE');v=self.launch(self.login(),[a]);self.ready(v);path='**/api/studies/'+a.uid+'/tech-note'
  v.route(path,lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps(dict(uid='1.2.3.4',note=dict(studyUid='1.2.3.4',text='WRONG NOTE'),writable=True))))
  v.locator('#kin-viewer-note-open').click();expect(v.locator('#tech-note-status')).to_contain_text('대상이 일치하지');expect(v.locator('#tech-note-text')).to_have_value('');v.unroute(path);v.locator('#tech-note-reload').click();expect(v.locator('#tech-note-text')).to_have_value('SAFE NOTE');v.locator('#tech-note-close').click()
  waiting=[];v.route(path,lambda route:waiting.append(route));v.locator('#kin-viewer-note-open').click();expect(v.locator('#tech-note-status')).to_contain_text('불러오는 중');v.wait_for_function("() => document.querySelector('#tech-note-dialog').open")
  for _ in range(100):
   if waiting:break
   v.wait_for_timeout(50)
  self.assertEqual(len(waiting),1,'Actual note GET must be pending before session end')
  v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(v.locator('#tech-note-dialog')).to_have_count(0)
  for route in waiting:route.fulfill(status=200,content_type='application/json',body=json.dumps(dict(uid=a.uid,note=dict(studyUid=a.uid,text='LATE NOTE'),writable=False)))
  expect(v.locator('#tech-note-dialog')).to_have_count(0);expect(v.locator('#kin-viewer-note-open')).to_be_disabled()
 def test_viewer_note_05_initial_connection_retry_preserves_view(self):
  a=self.ct('VIEWER-RETRY-'+uuid.uuid4().hex[:10],'retry','20260801');self.note(a,'RECONNECTED NOTE')
  p=self.login();fail=[True]
  def intermittent(route):
   if '/ohif/viewer' in route.request.frame.url and fail[0]:route.fulfill(status=503,content_type='application/json',body='{}')
   else:route.continue_()
  p.context.route('**/api/me',intermittent)
  v=self.launch(p,[a]);canvas_ready(v,1)
  expect(v.locator('#kin-viewer-note-status')).to_contain_text('다시 시도하세요')
  layout=v.locator('#kin-viewer-layout')
  if layout.get_attribute('open') is None:layout.locator('summary').first.click()
  v.get_by_label('작업 제목',exact=True).fill('KEEP RETRY JOB TITLE');before=self.snapshot(v);url=v.url
  v.locator('#kin-viewer-note-retry').click();expect(v.locator('#kin-viewer-note-status')).to_contain_text('다시 시도하세요')
  expect(v.locator('#kin-viewer-note-retry')).to_be_focused();self.assertEqual(self.snapshot(v),before)
  fail[0]=False;v.locator('#kin-viewer-note-retry').click();self.ready(v);expect(v.locator('#kin-viewer-note-open')).to_be_focused()
  self.assertEqual(v.url,url);self.assertEqual(self.snapshot(v),before);expect(v.get_by_label('작업 제목',exact=True)).to_have_value('KEEP RETRY JOB TITLE')
  self.open_note(v);expect(v.locator('#tech-note-text')).to_have_value('RECONNECTED NOTE');v.locator('#tech-note-close').click()
  v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}")
  expect(v.locator('#kin-viewer-note-open')).to_be_disabled();expect(v.locator('#kin-viewer-note-retry')).to_be_disabled()
def load_tests(loader,tests,pattern):return unittest.TestSuite(ViewerTechNoteE2E(n) for n in loader.getTestCaseNames(ViewerTechNoteE2E) if n.startswith('test_viewer_note_'))
if __name__=='__main__':unittest.main(verbosity=2)
