# coding: utf-8
"""Opt-in note opening, local owner setting and editing deferral."""
import json,unittest
from playwright.sync_api import expect
from test_reading_note import ReadingNoteE2E

class ReadingNoteAutoE2E(ReadingNoteE2E):
 def test_auto_note_01_default_opt_in_once_and_reload(self):
  a,b=self.pair();self.note(a,'AUTO NOTE CURRENT');p=self.login();self.workspace(p,a)
  toggle=p.locator('#reading-note-auto');expect(toggle).not_to_be_checked();expect(p.locator('#tech-note-dialog')).not_to_be_visible()
  toggle.check();expect(p.locator('#tech-note-text')).to_have_value('AUTO NOTE CURRENT');p.locator('#tech-note-close').click()
  p.wait_for_timeout(750);expect(p.locator('#tech-note-dialog')).not_to_be_visible()
  stored=p.evaluate("() => Object.keys(localStorage).filter(k=>k.startsWith('kin-reading-note-auto:v1:')).map(k=>[k,localStorage.getItem(k)])")
  self.assertEqual(len(stored),1);self.assertEqual(stored[0][1],'true');self.assertNotIn(a.uid,json.dumps(stored))
  p.reload();expect(p.locator('#dbstat')).to_contain_text('DB Connected');self.workspace(p,a)
  expect(toggle).to_be_checked();expect(p.locator('#tech-note-text')).to_have_value('AUTO NOTE CURRENT');p.locator('#tech-note-close').click()
  toggle.uncheck();p.reload();expect(p.locator('#dbstat')).to_contain_text('DB Connected');self.workspace(p,a)
  expect(toggle).not_to_be_checked();expect(p.locator('#tech-note-dialog')).not_to_be_visible()

 def test_auto_note_02_editing_defers_and_manual_open_does_not_repeat(self):
  a,b=self.pair();self.note(a,'DEFER AUTO NOTE');p=self.login();self.workspace(p,a)
  p.locator('#findings').fill('KEEP WRITING')
  p.evaluate("() => {const t=document.querySelector('#reading-note-auto');t.checked=true;t.dispatchEvent(new Event('change',{bubbles:true}));}")
  p.wait_for_timeout(750);expect(p.locator('#tech-note-dialog')).not_to_be_visible();expect(p.locator('#findings')).to_have_value('KEEP WRITING')
  p.locator('#reading-tech-note').focus();p.wait_for_timeout(750);expect(p.locator('#tech-note-dialog')).not_to_be_visible()
  p.keyboard.press('Control+Alt+6');expect(p.locator('#tech-note-text')).to_have_value('DEFER AUTO NOTE');p.locator('#tech-note-close').click()
  p.locator('#reading-tech-note').focus();p.wait_for_timeout(750);expect(p.locator('#tech-note-dialog')).not_to_be_visible()
  # A different loaded image without a memo must not open an empty modal.
  self.choose(p,b);expect(p.locator('#reading-status')).to_have_text('영상 작업공간 연결됨',timeout=60000)
  p.wait_for_timeout(750);expect(p.locator('#tech-note-dialog')).not_to_be_visible()
  self.note(b,'LATER NOTE');p.locator('#refresh').click();expect(p.locator('#reading-tech-note')).to_contain_text('있음')
  p.wait_for_timeout(750);expect(p.locator('#tech-note-dialog')).not_to_be_visible()
  p.evaluate("() => {const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}")
  expect(p.locator('#reading-note-auto')).to_be_disabled()

 def test_auto_note_03_other_owner_and_storage_failure(self):
  a,b=self.pair();self.note(a,'LOCAL SETTING NOTE');p=self.login();self.workspace(p,a)
  p.locator('#reading-note-auto').check();expect(p.locator('#tech-note-text')).to_have_value('LOCAL SETTING NOTE');p.locator('#tech-note-close').click()
  saved=p.evaluate("() => Object.keys(localStorage).filter(k=>k.startsWith('kin-reading-note-auto:v1:')).map(k=>[k,localStorage.getItem(k)])")
  other=self.login('doctor2');other.evaluate('(items)=>items.forEach(([k,v])=>localStorage.setItem(k,v))',saved);self.workspace(other,a)
  expect(other.locator('#reading-note-auto')).not_to_be_checked();expect(other.locator('#tech-note-dialog')).not_to_be_visible()

  other.evaluate("() => {const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('kin-reading-note-auto:v1:'))throw new Error('Synthetic storage refusal');return original.call(this,k,v)}}")
  other.locator('#reading-note-auto').check();expect(other.locator('#tech-note-text')).to_have_value('LOCAL SETTING NOTE')
  other.locator('#tech-note-close').click();expect(other.locator('body')).to_contain_text('현재 화면에서만 적용됩니다.')
  other.reload();expect(other.locator('#dbstat')).to_contain_text('DB Connected');self.workspace(other,a)
  expect(other.locator('#reading-note-auto')).not_to_be_checked();expect(other.locator('#tech-note-dialog')).not_to_be_visible()

 def test_auto_note_04_unsaved_viewer_defers_but_manual_still_works(self):
  a,b=self.pair();self.note(a,'NOTE WITH UNSAVED VIEWER');p=self.login();f=self.workspace(p,a)
  f.get_by_role('button',name='Comparison',exact=True).click();f.get_by_label('Job Title',exact=True).fill('KEEP UNSAVED VIEWER')
  p.locator('#reading-note-auto').check();p.wait_for_timeout(750);expect(p.locator('#tech-note-dialog')).not_to_be_visible()
  p.keyboard.press('Control+Alt+6');expect(p.locator('#tech-note-text')).to_have_value('NOTE WITH UNSAVED VIEWER')
  p.locator('#tech-note-close').click();expect(f.get_by_label('Job Title',exact=True)).to_have_value('KEEP UNSAVED VIEWER')

 def test_auto_note_05_unknown_summary_warns_without_later_popup(self):
  a,b=self.pair();self.note(a,'NOTE WITH UNKNOWN SUMMARY');p=self.login()
  def omit(route):
   response=route.fetch();body=response.json()
   for row in body.get('studies',[]):
    if row.get('uid')==a.uid:row.pop('techNote',None)
   route.fulfill(response=response,json=body)
  p.route('**/api/studies?*',omit);p.reload();expect(p.locator('#dbstat')).to_contain_text('DB Connected');self.workspace(p,a)
  expect(p.locator('#reading-tech-note')).to_contain_text('미확인');p.locator('#reading-note-auto').check()
  expect(p.locator('body')).to_contain_text('메모 상태가 미확인입니다.');expect(p.locator('#tech-note-dialog')).not_to_be_visible()
  p.unroute('**/api/studies?*');p.locator('#refresh').click();expect(p.locator('#reading-tech-note')).to_contain_text('있음')
  p.wait_for_timeout(750);expect(p.locator('#tech-note-dialog')).not_to_be_visible()
  p.locator('#reading-tech-note').click();expect(p.locator('#tech-note-text')).to_have_value('NOTE WITH UNKNOWN SUMMARY')

def load_tests(loader,tests,pattern):
 return unittest.TestSuite(ReadingNoteAutoE2E(n) for n in loader.getTestCaseNames(ReadingNoteAutoE2E) if n.startswith('test_auto_note_'))
if __name__=='__main__':unittest.main(verbosity=2)
