# coding: utf-8
"""TEST-RELATED-KEYBOARD: related preview and image comparison retain report work."""
import json,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_reading_workspace import ReadingWorkspaceE2E,canvas_ready

class RelatedKeyboardE2E(ReadingWorkspaceE2E):
 def test_related_keyboard_01_preview_compare_and_report_draft(self):
  a,b=self.pair();p=self.login();self.choose(p,a);original=self.originals();p.locator('#findings').fill('KEEP RELATED KEYBOARD REPORT')
  p.locator('#image-opening-open').click();p.locator('#image-opening-target').select_option('workspace');p.locator('#image-opening-done').click()
  expect(p.locator('#image-opening-open')).to_be_focused()
  p.locator('#related-options-open').focus();expect(p.locator('#related-options-open')).to_be_focused();p.keyboard.press('Tab')
  print('RELATED_TAB',p.evaluate("()=>({active:document.activeElement.outerHTML,parent:document.activeElement.parentElement?.className})"),flush=True)
  # The last visible filter control precedes the sole row; pagination is hidden.
  expect(p.locator(f'#relrows tr[data-uid="{b.uid}"]')).to_be_focused();expect(p.locator('#relrows tr[tabindex="0"]')).to_have_count(1)
  p.keyboard.press('Enter');expect(p.locator('#prior-findings')).to_have_text('PRIOR '+b.uid);expect(p.locator('#findings')).to_have_value('KEEP RELATED KEYBOARD REPORT');self.assertEqual(p.evaluate('selectedUid'),a.uid)
  expect(p.locator(f'#relrows tr[data-uid="{b.uid}"]')).to_be_focused();p.keyboard.press('Tab');expect(p.locator(f'[data-related-open="{b.uid}"]')).to_be_focused()
  folder=Path('../tmp/related-keyboard/screens');folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'related-preview.png'));p.keyboard.press('Enter')
  expect(p.locator('#reading-status')).to_have_text('영상 작업공간 연결됨',timeout=60000);f=p.locator('#reading-frame').element_handle().content_frame();canvas_ready(f,2)
  self.assertIn(a.uid+','+b.uid,f.url);p.keyboard.press('Control+Alt+4');expect(p.locator('#findings')).to_be_focused();expect(p.locator('#findings')).to_have_value('KEEP RELATED KEYBOARD REPORT');self.assertEqual(p.evaluate('selectedUid'),a.uid);self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1);self.assertEqual(self.jobs(a),[])
 def test_related_keyboard_02_refresh_filter_and_session(self):
  a,b=self.pair();p=self.login();self.choose(p,a);button=p.locator(f'[data-related-open="{b.uid}"]');button.focus();p.evaluate('renderRelated()');expect(button).to_be_focused()
  p.locator('#findings').focus();p.evaluate('renderRelated()');expect(p.locator('#findings')).to_be_focused()
  button.focus();p.evaluate("()=>{relatedModality=JSON.stringify('MR');renderRelated()}");expect(p.locator('#related-modality')).to_be_focused();expect(p.locator('#relrows tr[tabindex="0"]')).to_have_count(0)
  p.evaluate("()=>{relatedModality='';renderRelated()}");expect(p.locator('#relrows tr[tabindex="0"]')).to_have_count(1)
  button.focus();p.evaluate("()=>{selectedUid=null;renderRelated()}");expect(p.locator('#related-current')).to_be_focused()
  p.evaluate('uid=>{selectedUid=uid;renderRelated()}',a.uid)
  p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(p.locator('#relrows tr[tabindex="0"]')).to_have_count(0);expect(button).to_have_attribute('tabindex','-1')
 def test_related_keyboard_03_loaded_rows_cross_page_without_selection(self):
  a,b=self.pair();p=self.login();self.choose(p,a);p.locator('#findings').fill('KEEP PAGED RELATED DRAFT')
  p.evaluate("""uid=>{clearInterval(poll);const base=studies.find(s=>s.uid===uid);studies.push(...Array.from({length:51},(_,i)=>({...base,uid:'related-dom-'+String(i).padStart(2,'0')})));renderRelated()}""",b.uid)
  order=p.evaluate('relatedRows.map(row=>row.uid)');self.assertEqual(len(order),52)
  p.locator('#relrows tr[tabindex="0"]').focus();p.keyboard.press('Home');expect(p.locator(f'#relrows tr[data-uid="{order[0]}"]')).to_be_focused()
  p.keyboard.press('End');expect(p.locator(f'#relrows tr[data-uid="{order[-1]}"]')).to_be_focused();expect(p.locator('#related-page-status')).to_have_text('2/2페이지')
  p.keyboard.press('Home');p.locator(f'#relrows tr[data-uid="{order[49]}"]').focus();p.keyboard.press('ArrowDown');expect(p.locator(f'#relrows tr[data-uid="{order[50]}"]')).to_be_focused();p.keyboard.press('ArrowUp');expect(p.locator(f'#relrows tr[data-uid="{order[49]}"]')).to_be_focused()
  self.assertEqual(p.evaluate('selectedUid'),a.uid);self.assertIsNone(p.evaluate('relatedUid'));expect(p.locator('#findings')).to_have_value('KEEP PAGED RELATED DRAFT');print(json.dumps({'scope':'51 DOM-only extra related rows; no extra DICOM study claim'}),flush=True)
 def test_related_keyboard_04_direct_compare_keeps_unsaved_viewer(self):
  a,b=self.pair();c=self.ct(a.patient_id,'older','20260601');self.seed_report(c,action='approve',findings='OLDER '+c.uid);p=self.login();f=self.workspace(p,a);p.locator('#findings').fill('KEEP DIRECT COMPARE REPORT')
  f.get_by_role('button',name='Comparison',exact=True).click();f.get_by_label('Job Title',exact=True).fill('KEEP DIRECT COMPARE JOB');url=f.url;f.evaluate("()=>window.relatedMarker='keep'")
  button=p.locator(f'[data-related-open="{c.uid}"]');button.focus();expect(button).to_be_focused();p.keyboard.press('Enter')
  expect(p.locator('#prior-findings')).to_have_text('OLDER '+c.uid);self.assertEqual(p.evaluate('relatedUid'),c.uid);self.assertEqual(p.evaluate('selectedUid'),a.uid);expect(p.locator('#reading-status')).to_contain_text('저장하지 않은 작업');self.assertEqual(f.url,url);self.assertEqual(f.evaluate('()=>window.relatedMarker'),'keep');expect(f.get_by_label('Job Title',exact=True)).to_have_value('KEEP DIRECT COMPARE JOB')
  # The report target never changed, so the retained viewer stays visible and
  # there is no Return to Previous Viewer button (that belongs to another target).
  expect(p.locator('#reading-frame')).to_be_visible();p.keyboard.press('Control+Alt+2');expect(p.locator('#reading-frame')).to_be_focused();p.keyboard.press('Control+Alt+4');expect(p.locator('#findings')).to_be_focused();expect(p.locator('#findings')).to_have_value('KEEP DIRECT COMPARE REPORT');expect(f.get_by_label('Job Title',exact=True)).to_have_value('KEEP DIRECT COMPARE JOB');self.assertEqual(self.jobs(a),[]);self.assertEqual(len(self.versions(a)),1)

def load_tests(loader,tests,pattern):return unittest.TestSuite(RelatedKeyboardE2E(n) for n in loader.getTestCaseNames(RelatedKeyboardE2E) if n.startswith('test_related_keyboard_'))
if __name__=='__main__':unittest.main(verbosity=2)
