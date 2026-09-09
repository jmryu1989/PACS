# coding: utf-8
"""TEST-DOCK-PREFERENCES: placement remembers UI only, preserving real work."""
import json,os,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_reading_workspace import ReadingWorkspaceE2E
from test_prior_selection import canvas_ready

class DockPreferencesE2E(ReadingWorkspaceE2E):
 def stored(self,p):return p.evaluate("()=>Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('kin-viewer-dock:v1:')).map(k=>[k,localStorage.getItem(k)]))")
 def bounds(self,f,top):
  dock=f.locator('#kin-workspace-dock').bounding_box()
  for canvas in f.locator('.cornerstone-canvas').all():
   r=canvas.bounding_box();self.assertGreater(r['height'],50)
   if top:self.assertGreaterEqual(r['y'],dock['y']+dock['height']-1)
   else:self.assertLessEqual(r['y']+r['height'],dock['y']+1)

 def test_dock_pref_01_move_retains_live_images_and_edits(self):
  from test_viewer_tech_note import ViewerTechNoteE2E
  a,b=self.pair();p=self.login();p.set_viewport_size(dict(width=1680,height=1100));f=self.workspace(p,a)
  p.locator('#findings').fill('KEEP DOCK POSITION REPORT');f.get_by_role('button',name='비교 작업·배치',exact=True).click();f.get_by_label('작업 제목',exact=True).fill('KEEP DOCK POSITION VIEWER')
  before=ViewerTechNoteE2E.snapshot(self,f);self.assertEqual(len(before),2);url=f.url
  f.locator('#kin-dock-placement').select_option('top');canvas_ready(f,2);self.bounds(f,True)
  expect(f.get_by_label('작업 제목',exact=True)).to_have_value('KEEP DOCK POSITION VIEWER');expect(p.locator('#findings')).to_have_value('KEEP DOCK POSITION REPORT');self.assertEqual(ViewerTechNoteE2E.snapshot(self,f),before)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'top-tools.png'))
  f.locator('#kin-dock-placement').select_option('bottom');canvas_ready(f,2);self.bounds(f,False);self.assertEqual(ViewerTechNoteE2E.snapshot(self,f),before);self.assertEqual(f.url,url);self.assertEqual(self.jobs(a),[])

 def test_dock_pref_02_reload_owner_isolation_reset_corrupt(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a);f.get_by_role('button',name='측정·주석',exact=True).click();f.locator('#kin-dock-placement').select_option('top');saved=self.stored(p);self.assertEqual(len(saved),1)
  self.assertEqual(json.loads(next(iter(saved.values()))),dict(version=1,placement='top',panel=0))
  f.evaluate('(key)=>window.dispatchEvent(new StorageEvent("storage",{key}))',next(iter(saved)));expect(f.locator('#kin-dock-preference-status')).to_contain_text('현재 창 유지');expect(f.locator('#kin-dock-placement')).to_have_value('top')
  p.reload();f=self.workspace(p,a);expect(f.locator('#kin-dock-placement')).to_have_value('top');expect(f.get_by_role('button',name='측정·주석',exact=True)).to_have_attribute('aria-expanded','true');self.bounds(f,True)
  other=self.login('doctor2');other.evaluate('(v)=>{for(const [k,s] of Object.entries(v))localStorage.setItem(k,s)}',saved);g=self.workspace(other,a);expect(g.locator('#kin-dock-placement')).to_have_value('bottom')
  g.get_by_role('button',name='비교 작업·배치',exact=True).click();self.assertEqual(len(self.stored(other)),2);self.assertEqual(self.stored(other)[next(iter(saved))],next(iter(saved.values())))
  f.locator('#kin-dock-reset').click();expect(f.locator('#kin-dock-placement')).to_have_value('bottom');expect(f.get_by_role('button',name='측정·주석',exact=True)).to_have_attribute('aria-expanded','false')
  p.reload();f=self.workspace(p,a);expect(f.locator('#kin-dock-placement')).to_have_value('bottom');expect(f.get_by_role('button',name='측정·주석',exact=True)).to_have_attribute('aria-expanded','false')
  p.evaluate('(k)=>localStorage.setItem(k,JSON.stringify({version:1,placement:"outside",panel:99}))',next(iter(saved)));p.reload();f=self.workspace(p,a);expect(f.locator('#kin-dock-placement')).to_have_value('bottom');expect(f.locator('#kin-dock-preference-status')).to_contain_text('오류')

 def test_dock_pref_03_failed_storage_other_tab_and_small_screen(self):
  a,b=self.pair();p=self.login();p.set_viewport_size(dict(width=800,height=1100));f=self.workspace(p,a)
  f.evaluate("()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('kin-viewer-dock:v1:'))throw new DOMException('blocked','QuotaExceededError');return original.call(this,k,v)}}")
  f.get_by_role('button',name='비교 작업·배치',exact=True).click();f.locator('#kin-dock-placement').select_option('top');expect(f.locator('#kin-dock-preference-status')).to_contain_text('이 창에만 적용');self.assertEqual(self.stored(p),{});canvas_ready(f,2);self.bounds(f,True)
  f.locator('#kin-dock-reset').scroll_into_view_if_needed();expect(f.locator('#kin-dock-reset')).to_be_in_viewport()
  p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(p.locator('#reading-frame')).to_have_count(0);self.assertEqual(self.stored(p),{})

def load_tests(loader,tests,pattern):return unittest.TestSuite(DockPreferencesE2E(n) for n in loader.getTestCaseNames(DockPreferencesE2E) if n.startswith('test_dock_pref_'))
if __name__=='__main__':unittest.main(verbosity=2)
