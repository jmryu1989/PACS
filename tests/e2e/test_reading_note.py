# coding: utf-8
"""Current-image note shortcut preserves image and report contexts."""
import os,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_reading_workspace import ReadingWorkspaceE2E,canvas_ready

class ReadingNoteE2E(ReadingWorkspaceE2E):
 def note(self,f,text):
  r=self.stack.request('POST','/studies/'+f.uid+'/tech-note','tech',dict(baseVersion=0,text=text,reason=''))
  self.assertEqual(r.status,201,r.text)

 def test_reading_note_01_shortcut_preserves_viewer_and_report(self):
  a,b=self.pair();self.note(a,'CURRENT IMAGE NOTE');self.note(b,'PRIOR IMAGE NOTE')
  original=self.originals();p=self.login();p.set_viewport_size(dict(width=1680,height=1100));f=self.workspace(p,a)
  button=p.locator('#reading-tech-note');expect(button).to_have_text('Image Tech Note · 있음')
  p.locator('#findings').fill('UNSAVED REPORT NOTE ROUNDTRIP')
  f.get_by_role('button',name='비교 작업·배치',exact=True).click();f.get_by_label('작업 제목',exact=True).fill('UNSAVED VIEWER NOTE ROUNDTRIP')
  view="() => cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports().map(v=>({image:v.getCurrentImageId?.(),camera:v.getCamera(),voi:v.getProperties().voiRange})))"
  before=f.evaluate(view);url=f.url
  p.keyboard.press('Control+Alt+6')
  expect(p.locator('#tech-note-target')).to_contain_text(a.uid);expect(p.locator('#tech-note-text')).to_have_value('CURRENT IMAGE NOTE')
  expect(p.locator('#tech-note-save')).to_be_disabled()
  p.locator('#tech-note-close').focus();p.keyboard.press('Control+Alt+ArrowRight');expect(p.locator('#reading-target')).to_contain_text(a.uid)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'reading-note.png'))
  p.keyboard.press('Escape');expect(p.locator('#tech-note-dialog')).not_to_be_visible();expect(p.locator('#reading-frame')).to_be_focused()
  expect(f.get_by_label('작업 제목',exact=True)).to_be_focused()
  expect(f.get_by_label('작업 제목',exact=True)).to_have_value('UNSAVED VIEWER NOTE ROUNDTRIP')
  expect(p.locator('#findings')).to_have_value('UNSAVED REPORT NOTE ROUNDTRIP');self.assertEqual(f.url,url);canvas_ready(f,2);self.assertEqual(f.evaluate(view),before)
  button.click();expect(p.locator('#tech-note-text')).to_have_value('CURRENT IMAGE NOTE');p.locator('#tech-note-close').click();expect(button).to_be_focused()
  p.evaluate("""uid=>{const w=document.querySelector('#reading-frame').contentWindow,old=w.location.href;try{const u=new URL(old);u.searchParams.set('StudyInstanceUIDs',uid);w.history.replaceState(null,'',u);document.querySelector('#reading-tech-note').click();if(document.querySelector('#tech-note-dialog').open)throw Error('Stale viewer target opened note');}finally{w.history.replaceState(null,'',old)}}""",b.uid)
  self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1);self.assertEqual(self.jobs(a),[])

 def test_reading_note_02_related_image_keeps_report_target(self):
  a,b=self.pair();self.note(a,'CURRENT REPORT NOTE');self.note(b,'RELATED IMAGE NOTE')
  p=self.login();f=self.workspace(p,a);p.locator('#findings').fill('KEEP REPORT TARGET')
  p.locator(f'#relrows tr[data-uid="{b.uid}"]').click()
  p.keyboard.press('Control+Alt+5');p.locator('.thumb-open').first.click()
  expect(p.locator('#reading-status')).to_have_text('영상 작업공간 연결됨',timeout=60000)
  f=p.locator('#reading-frame').element_handle().content_frame();canvas_ready(f,1)
  expect(p.locator('#reading-tech-note')).to_have_text('Image Tech Note · 있음')
  p.locator('#reading-tech-note').click();expect(p.locator('#tech-note-target')).to_contain_text(b.uid)
  expect(p.locator('#tech-note-text')).to_have_value('RELATED IMAGE NOTE');expect(p.locator('#reading-target')).to_contain_text(a.uid)
  p.locator('#tech-note-close').click();expect(p.locator('#findings')).to_have_value('KEEP REPORT TARGET')
  p.evaluate("() => {const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}")
  expect(p.locator('#reading-tech-note')).to_be_disabled();expect(p.locator('#tech-note-dialog')).not_to_be_visible()

 def test_reading_note_03_active_second_image(self):
  from test_viewer_tech_note import ViewerTechNoteE2E
  a,b=self.pair();self.note(b,'SECOND NOTE')
  p=self.login();f=self.workspace(p,a);p.locator('#findings').fill('KEEP ACTIVE REPORT')
  f.wait_for_function('() => typeof kinViewerSelectedNoteTarget === "function"')
  selector='[data-cy=viewport-grid] > div'
  for cell in f.locator(selector).all():
   canvas=cell.locator('canvas')
   if not canvas.count():continue
   box=canvas.bounding_box();p.mouse.click(box['x']+box['width']*.5,box['y']+box['height']*.3)
   if f.evaluate('() => kinViewerSelectedNoteTarget()?.uid')==b.uid:break
  self.assertEqual(f.evaluate('() => kinViewerSelectedNoteTarget()?.uid'),b.uid)
  expect(p.locator('#reading-tech-note')).to_have_text('Image Tech Note · 있음')
  before=ViewerTechNoteE2E.snapshot(self,f);self.assertEqual(len(before),2)
  p.locator('#reading-tech-note').click();expect(p.locator('#tech-note-target')).to_contain_text(b.uid)
  expect(p.locator('#tech-note-text')).to_have_value('SECOND NOTE')
  p.keyboard.press('Escape');expect(p.locator('#reading-tech-note')).to_be_focused()
  expect(p.locator('#reading-target')).to_contain_text(a.uid);expect(p.locator('#findings')).to_have_value('KEEP ACTIVE REPORT')
  self.assertEqual(ViewerTechNoteE2E.snapshot(self,f),before)

 def test_reading_note_04_bridge_failure_keeps_images(self):
  from test_viewer_tech_note import ViewerTechNoteE2E
  a,b=self.pair();self.note(b,'RECOVERED SECOND IMAGE NOTE')
  p=self.login();failed_loads=[]
  def fail_asset(route):
   failed_loads.append(route.request.url);route.abort()
  p.route('**/viewer-tech-note.js',fail_asset)
  f=self.workspace(p,a);expect(p.locator('#reading-tech-note')).to_be_disabled()
  p.locator('#findings').fill('KEEP REPORT WITHOUT NOTES');p.keyboard.press('Control+Alt+2')
  expect(p.locator('#reading-frame')).to_be_focused();canvas_ready(f,2)
  f.get_by_role('button',name='비교 작업·배치',exact=True).click();f.get_by_label('작업 제목',exact=True).fill('KEEP VIEWER THROUGH ASSET RETRY')
  before=ViewerTechNoteE2E.snapshot(self,f);self.assertEqual(len(before),2);url=f.url
  f.evaluate('() => window.noteRetryDocument = document')
  retry=p.locator('#reading-note-retry');expect(retry).to_be_enabled();retry.click()
  expect(retry).to_be_enabled();expect(p.locator('#reading-tech-note')).to_be_disabled()
  self.assertEqual(len(failed_loads),2)
  self.assertEqual(ViewerTechNoteE2E.snapshot(self,f),before)
  p.unroute('**/viewer-tech-note.js');retry.click()
  expect(p.locator('#reading-tech-note')).to_be_enabled();expect(retry).not_to_be_visible()
  expect(p.locator('#reading-tech-note')).to_be_focused()
  self.assertTrue(f.evaluate('() => window.noteRetryDocument === document'));self.assertEqual(f.url,url)
  expect(f.get_by_label('작업 제목',exact=True)).to_have_value('KEEP VIEWER THROUGH ASSET RETRY')
  expect(p.locator('#findings')).to_have_value('KEEP REPORT WITHOUT NOTES')
  self.assertEqual(ViewerTechNoteE2E.snapshot(self,f),before)
  for cell in f.locator('[data-cy=viewport-grid] > div').all():
   canvas=cell.locator('canvas')
   if not canvas.count():continue
   box=canvas.bounding_box();p.mouse.click(box['x']+box['width']*.5,box['y']+box['height']*.3)
   if f.evaluate('() => kinViewerSelectedNoteTarget()?.uid')==b.uid:break
  self.assertEqual(f.evaluate('() => kinViewerSelectedNoteTarget()?.uid'),b.uid)
  p.locator('#reading-tech-note').click();expect(p.locator('#tech-note-target')).to_contain_text(b.uid)
  expect(p.locator('#tech-note-text')).to_have_value('RECOVERED SECOND IMAGE NOTE');p.keyboard.press('Escape')
  p.evaluate("() => {const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}")
  expect(p.locator('#reading-tech-note')).to_be_disabled();expect(retry).to_be_disabled()

def load_tests(loader,tests,pattern):
 return unittest.TestSuite(ReadingNoteE2E(n) for n in loader.getTestCaseNames(ReadingNoteE2E) if n.startswith('test_reading_note_'))
if __name__=='__main__':unittest.main(verbosity=2)
