# coding: utf-8
"""TEST-WORKSPACE-FONTS: display choices retain images, editing and account scope."""
import os,json,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_reading_appearance import ReadingAppearanceE2E

class ReadingFontsE2E(ReadingAppearanceE2E):
 def font_storage(self,p):
  return p.evaluate("()=>Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('kin-reading-font:v1:')).map(k=>[k,localStorage.getItem(k)]))")

 def test_fonts_01_independent_display_preserves_real_work(self):
  from test_viewer_tech_note import ViewerTechNoteE2E
  a,b=self.pair();p=self.login();p.set_viewport_size(dict(width=1680,height=1100));f=self.workspace(p,a)
  p.locator('#findings').fill('KEEP FONT REPORT 한글 123');p.locator(f'#relrows tr[data-uid="{b.uid}"]').click()
  expect(p.locator('#prior-findings')).to_have_text('PRIOR '+b.uid)
  f.get_by_role('button',name='비교 작업·배치',exact=True).click();f.get_by_label('작업 제목',exact=True).fill('KEEP FONT VIEWER')
  before=ViewerTechNoteE2E.snapshot(self,f);self.assertEqual(len(before),2);url=f.url
  self.settings(p)
  for name,font in [('list','sans'),('current','mono'),('prior','serif')]:p.locator('#reading-font-'+name).select_option(font)
  for selector,family in [('#rows td','sans-serif'),('#relrows td','sans-serif'),('#findings','monospace'),('#prior-findings','serif')]:
   self.assertTrue(p.locator(selector).first.evaluate('(e)=>getComputedStyle(e).fontFamily').endswith(family))
  p.locator('#reading-text-current').select_option('18');expect(p.locator('#findings')).to_have_css('font-size','18px')
  self.assertTrue(p.locator('#findings').evaluate('(e)=>getComputedStyle(e).fontFamily').endswith('monospace'))
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'font-settings.png'))
  p.keyboard.press('Escape');expect(p.locator('#reading-appearance-open')).to_be_focused()
  expect(p.locator('#findings')).to_have_value('KEEP FONT REPORT 한글 123');expect(f.get_by_label('작업 제목',exact=True)).to_have_value('KEEP FONT VIEWER')
  self.assertEqual(f.url,url);self.assertEqual(ViewerTechNoteE2E.snapshot(self,f),before)
  self.assertEqual(len(self.versions(a)),1);self.assertEqual(self.jobs(a),[])
  self.assertEqual(json.loads(next(iter(self.font_storage(p).values()))),dict(version=1,list='sans',current='mono',prior='serif'))

 def test_fonts_02_reload_owner_reset_and_untrusted_storage(self):
  p=self.login();self.settings(p);p.locator('#reading-font-current').select_option('serif');saved=self.font_storage(p);self.assertEqual(len(saved),1)
  p.reload();self.settings(p);expect(p.locator('#reading-font-current')).to_have_value('serif')
  other=self.login('doctor2');other.evaluate('(v)=>{for(const [k,s] of Object.entries(v))localStorage.setItem(k,s)}',saved);other.reload();self.settings(other)
  expect(other.locator('#reading-font-current')).to_have_value('default');other.locator('#reading-font-current').select_option('mono')
  self.assertEqual(len(self.font_storage(other)),2);self.assertEqual(self.font_storage(other)[next(iter(saved))],next(iter(saved.values())))
  p.locator('#reading-font-reset').click();p.reload();self.settings(p);expect(p.locator('#reading-font-current')).to_have_value('default')
  for invalid in ['url(https://invalid.example/font)', ['serif'], '__proto__']:
   p.evaluate('([key,v])=>localStorage.setItem(key,JSON.stringify({version:1,list:"default",current:v,prior:"default"}))',[next(iter(saved)),invalid])
   p.reload();self.settings(p);expect(p.locator('#reading-font-current')).to_have_value('default');expect(p.locator('#reading-font-status')).to_contain_text('오류')

 def test_fonts_03_storage_denial_other_tab_and_session_end(self):
  p=self.login();p.set_viewport_size(dict(width=800,height=768));self.settings(p)
  p.evaluate("()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('kin-reading-font:v1:'))throw new DOMException('unavailable','QuotaExceededError');return original.call(this,k,v)}}")
  p.locator('#reading-font-current').select_option('mono');expect(p.locator('#reading-font-status')).to_contain_text('이 창에만 적용');self.assertEqual(self.font_storage(p),{})
  p.locator('#reading-text-current').select_option('16');key=next(iter(self.stored(p))).replace('kin-reading-text:','kin-reading-font:')
  p.evaluate('(key)=>window.dispatchEvent(new StorageEvent("storage",{key,newValue:JSON.stringify({version:1,list:"serif",current:"serif",prior:"serif"})}))',key)
  expect(p.locator('#reading-font-status')).to_contain_text('현재 창은 유지');expect(p.locator('#reading-font-current')).to_have_value('mono')
  box=p.locator('#reading-appearance-dialog').bounding_box();self.assertGreaterEqual(box['x'],0);self.assertLessEqual(box['x']+box['width'],800);self.assertGreaterEqual(box['y'],0);self.assertLessEqual(box['y']+box['height'],768)
  p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}")
  expect(p.locator('#reading-appearance-dialog')).not_to_be_visible();expect(p.locator('#reading-font-current')).to_be_disabled()
  p.evaluate("()=>{const s=document.querySelector('#reading-font-current');s.value='serif';s.dispatchEvent(new Event('change'))}")
  expect(p.locator('#reading-font-current')).to_have_value('default');self.assertEqual(self.font_storage(p),{})

def load_tests(loader,tests,pattern):return unittest.TestSuite(ReadingFontsE2E(n) for n in loader.getTestCaseNames(ReadingFontsE2E) if n.startswith('test_fonts_'))
if __name__=='__main__':unittest.main(verbosity=2)
