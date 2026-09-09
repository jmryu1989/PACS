# coding: utf-8
"""Display-only text sizes retain real image and clinical editing state."""
import os,unittest,json
from pathlib import Path
from playwright.sync_api import expect
from test_reading_workspace import ReadingWorkspaceE2E

class ReadingAppearanceE2E(ReadingWorkspaceE2E):
 def settings(self,p):
  p.locator('#reading-appearance-open').click();expect(p.locator('#reading-appearance-dialog')).to_be_visible()
 def stored(self,p):
  return p.evaluate("() => Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('kin-reading-text:v1:')).map(k=>[k,localStorage.getItem(k)]))")
 def test_text_01_independent_sizes_preserve_images_and_edits(self):
  from test_viewer_tech_note import ViewerTechNoteE2E
  a,b=self.pair();p=self.login();p.set_viewport_size(dict(width=1680,height=1100));f=self.workspace(p,a)
  p.locator('#findings').fill('KEEP TEXT SIZE REPORT');p.locator(f'#relrows tr[data-uid="{b.uid}"]').click()
  expect(p.locator('#prior-findings')).to_have_text('PRIOR '+b.uid)
  f.get_by_role('button',name='비교 작업·배치',exact=True).click();f.get_by_label('작업 제목',exact=True).fill('KEEP TEXT SIZE VIEWER')
  before=ViewerTechNoteE2E.snapshot(self,f);self.assertEqual(len(before),2);url=f.url
  self.settings(p)
  for name,size in [('list','16'),('current','20'),('prior','18')]:p.locator('#reading-text-'+name).select_option(size)
  expect(p.locator('#rows td').first).to_have_css('font-size','16px')
  expect(p.locator('#relrows td').first).to_have_css('font-size','16px')
  expect(p.locator('#findings')).to_have_css('font-size','20px');expect(p.locator('#prior-findings')).to_have_css('font-size','18px')
  expect(p.locator('#reading-appearance-status')).to_contain_text('기억했습니다')
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'text-size-settings.png'))
  p.keyboard.press('Escape');expect(p.locator('#reading-appearance-open')).to_be_focused()
  expect(p.locator('#findings')).to_have_value('KEEP TEXT SIZE REPORT')
  expect(f.get_by_label('작업 제목',exact=True)).to_have_value('KEEP TEXT SIZE VIEWER')
  self.assertEqual(f.url,url);self.assertEqual(ViewerTechNoteE2E.snapshot(self,f),before)
  self.assertEqual(len(self.versions(a)),1);self.assertEqual(self.jobs(a),[])
  saved=list(self.stored(p).values());self.assertEqual(len(saved),1)
  self.assertEqual(json.loads(saved[0]),dict(version=1,list=16,current=20,prior=18))

 def test_text_02_reload_owner_isolation_reset_and_corrupt_values(self):
  a,b=self.pair();p=self.login();self.settings(p);p.locator('#reading-text-current').select_option('18')
  p.locator('#reading-appearance-close').click();p.reload();expect(p.locator('#findings')).to_have_css('font-size','18px')
  saved=self.stored(p);self.assertEqual(len(saved),1)
  other=self.login('doctor2');other.evaluate('(values)=>{for(const [k,v] of Object.entries(values))localStorage.setItem(k,v)}',saved);other.reload()
  expect(other.locator('#findings')).to_have_css('font-size','12px');self.settings(other)
  other.locator('#reading-text-current').select_option('16');self.assertEqual(len(self.stored(other)),2)
  self.assertEqual(self.stored(other)[next(iter(saved))],next(iter(saved.values())))
  self.settings(p);p.locator('#reading-appearance-reset').click();expect(p.locator('#findings')).to_have_css('font-size','12px')
  p.locator('#reading-appearance-close').click();p.reload();expect(p.locator('#findings')).to_have_css('font-size','12px')
  p.evaluate('(key)=>localStorage.setItem(key,JSON.stringify({version:1,list:999,current:18,prior:12,extra:"unexpected"}))',next(iter(saved)))
  p.reload();expect(p.locator('#findings')).to_have_css('font-size','12px');self.settings(p)
  expect(p.locator('#reading-appearance-status')).to_contain_text('오류')

 def test_text_03_storage_failure_small_screen_and_session_end(self):
  a,b=self.pair();p=self.login();p.set_viewport_size(dict(width=800,height=1100));self.settings(p)
  p.evaluate("() => {const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('kin-reading-text:v1:'))throw new DOMException('unavailable','QuotaExceededError');return original.call(this,k,v);}}")
  p.locator('#reading-text-current').select_option('20');expect(p.locator('#findings')).to_have_css('font-size','20px')
  expect(p.locator('#reading-appearance-status')).to_contain_text('이 창에만 적용')
  self.assertEqual(self.stored(p),{})
  box=p.locator('#reading-appearance-dialog').bounding_box();self.assertGreaterEqual(box['x'],0);self.assertLessEqual(box['x']+box['width'],800)
  p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}")
  expect(p.locator('#reading-appearance-dialog')).not_to_be_visible();expect(p.locator('#reading-appearance-open')).to_be_disabled()
  p.evaluate("()=>{const s=document.querySelector('#reading-text-current');s.value='18';s.dispatchEvent(new Event('change'));}")
  expect(p.locator('#findings')).to_have_css('font-size','12px');self.assertEqual(self.stored(p),{})

 def test_text_04_missing_display_asset_keeps_clinical_workspace(self):
  a,b=self.pair();p=self.login();p.route('**/reading-appearance.js',lambda route:route.abort());p.reload()
  expect(p.locator('#dbstat')).to_contain_text('DB 연결됨');expect(p.locator('#reading-appearance-open')).to_be_disabled()
  expect(p.locator('#reading-appearance-open')).to_have_attribute('title','글자 크기 설정을 불러오지 못했습니다. 판독 작업은 계속할 수 있습니다.')
  self.workspace(p,a);p.locator('#findings').fill('KEEP WORK WITHOUT DISPLAY SETTINGS')
  expect(p.locator('#findings')).to_have_value('KEEP WORK WITHOUT DISPLAY SETTINGS')

def load_tests(loader,tests,pattern):return unittest.TestSuite(ReadingAppearanceE2E(n) for n in loader.getTestCaseNames(ReadingAppearanceE2E) if n.startswith('test_text_'))
if __name__=='__main__':unittest.main(verbosity=2)
