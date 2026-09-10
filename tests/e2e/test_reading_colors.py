# coding: utf-8
"""TEST-WORKSPACE-COLORS: retain status meaning, real images and clinical edits."""
import os,json,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_reading_appearance import ReadingAppearanceE2E

class ReadingColorsE2E(ReadingAppearanceE2E):
 def color_storage(self,p):
  return p.evaluate("()=>Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('kin-reading-color:v1:')).map(k=>[k,localStorage.getItem(k)]))")
 def status_colors(self,p):
  return p.locator('#rows .rs, #relrows .rs').evaluate_all('(items)=>items.map(e=>({text:e.textContent,color:getComputedStyle(e).color}))')

 def test_colors_01_status_images_and_edits_preserved(self):
  from test_viewer_tech_note import ViewerTechNoteE2E
  a,b=self.pair();p=self.login();p.set_viewport_size(dict(width=1680,height=1100));f=self.workspace(p,a)
  p.locator('#findings').fill('KEEP COLOR REPORT');p.locator(f'#relrows tr[data-uid="{b.uid}"]').click();expect(p.locator('#prior-findings')).to_have_text('PRIOR '+b.uid)
  f.get_by_role('button',name='Comparison',exact=True).click();f.get_by_label('Job Title',exact=True).fill('KEEP COLOR VIEWER')
  before=ViewerTechNoteE2E.snapshot(self,f);self.assertEqual(len(before),2);url=f.url;states=self.status_colors(p);self.assertTrue(states)
  selection=p.locator('#rows tr.sel td').first.evaluate('(e)=>({bg:getComputedStyle(e).backgroundColor,mark:getComputedStyle(e).boxShadow})')
  self.settings(p)
  for name,color in [('list','warm'),('current','white'),('prior','cool')]:p.locator('#reading-color-'+name).select_option(color)
  for selector,color in [('#rows td','rgb(255, 241, 214)'),('#relrows td','rgb(255, 241, 214)'),('#findings','rgb(255, 255, 255)'),('#prior-findings','rgb(215, 243, 255)')]:expect(p.locator(selector).first).to_have_css('color',color)
  self.assertEqual(self.status_colors(p),states);self.assertEqual(p.locator('#rows tr.sel td').first.evaluate('(e)=>({bg:getComputedStyle(e).backgroundColor,mark:getComputedStyle(e).boxShadow})'),selection)
  p.locator('#reading-font-current').select_option('mono');p.locator('#reading-text-current').select_option('18');expect(p.locator('#findings')).to_have_css('color','rgb(255, 255, 255)')
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'color-settings.png'))
  p.keyboard.press('Escape');expect(p.locator('#reading-appearance-open')).to_be_focused();expect(p.locator('#findings')).to_have_value('KEEP COLOR REPORT');expect(f.get_by_label('Job Title',exact=True)).to_have_value('KEEP COLOR VIEWER')
  self.assertEqual(f.url,url);self.assertEqual(ViewerTechNoteE2E.snapshot(self,f),before);self.assertEqual(len(self.versions(a)),1);self.assertEqual(self.jobs(a),[])

 def test_colors_02_reload_owner_reset_and_invalid_values(self):
  p=self.login();self.settings(p);p.locator('#reading-color-current').select_option('warm');saved=self.color_storage(p);self.assertEqual(len(saved),1)
  p.reload();self.settings(p);expect(p.locator('#reading-color-current')).to_have_value('warm')
  other=self.login('doctor2');other.evaluate('(v)=>{for(const [k,s] of Object.entries(v))localStorage.setItem(k,s)}',saved);other.reload();self.settings(other);expect(other.locator('#reading-color-current')).to_have_value('default')
  other.locator('#reading-color-current').select_option('cool');self.assertEqual(len(self.color_storage(other)),2);self.assertEqual(self.color_storage(other)[next(iter(saved))],next(iter(saved.values())))
  p.locator('#reading-color-reset').click();p.reload();self.settings(p);expect(p.locator('#reading-color-current')).to_have_value('default')
  for invalid in ['#000000','url(https://invalid.example/color)',['warm'],'__proto__']:
   p.evaluate('([key,v])=>localStorage.setItem(key,JSON.stringify({version:1,list:"default",current:v,prior:"default"}))',[next(iter(saved)),invalid]);p.reload();self.settings(p)
   expect(p.locator('#reading-color-current')).to_have_value('default');expect(p.locator('#reading-color-status')).to_contain_text('오류')

 def test_colors_03_storage_failure_small_screen_and_session_end(self):
  p=self.login();p.set_viewport_size(dict(width=800,height=768));self.settings(p)
  p.evaluate("()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('kin-reading-color:v1:'))throw new DOMException('unavailable','QuotaExceededError');return original.call(this,k,v)}}")
  p.locator('#reading-color-current').select_option('white');expect(p.locator('#reading-color-status')).to_contain_text('이 창에만 적용');self.assertEqual(self.color_storage(p),{})
  p.locator('#reading-text-current').select_option('16');key=next(iter(self.stored(p))).replace('kin-reading-text:','kin-reading-color:')
  p.evaluate('(key)=>window.dispatchEvent(new StorageEvent("storage",{key}))',key);expect(p.locator('#reading-color-status')).to_contain_text('현재 창은 유지');expect(p.locator('#reading-color-current')).to_have_value('white')
  p.locator('#reading-appearance-close').scroll_into_view_if_needed();expect(p.locator('#reading-appearance-close')).to_be_in_viewport()
  box=p.locator('#reading-appearance-dialog').bounding_box();self.assertGreaterEqual(box['x'],0);self.assertLessEqual(box['x']+box['width'],800);self.assertGreaterEqual(box['y'],0);self.assertLessEqual(box['y']+box['height'],768)
  p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(p.locator('#reading-appearance-dialog')).not_to_be_visible();expect(p.locator('#reading-color-current')).to_be_disabled()
  p.evaluate("()=>{const s=document.querySelector('#reading-color-current');s.value='warm';s.dispatchEvent(new Event('change'))}");expect(p.locator('#reading-color-current')).to_have_value('default');self.assertEqual(self.color_storage(p),{})

def load_tests(loader,tests,pattern):return unittest.TestSuite(ReadingColorsE2E(n) for n in loader.getTestCaseNames(ReadingColorsE2E) if n.startswith('test_colors_'))
if __name__=='__main__':unittest.main(verbosity=2)
