# coding: utf-8
"""TEST-STANDALONE-DOCK: shared preferences, native pixels and lifecycle."""
import json,os,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_viewer_tech_note import ViewerTechNoteE2E,canvas_ready
from test_dock_preferences import DockPreferencesE2E

class StandaloneDockE2E(ViewerTechNoteE2E):
 def test_standalone_dock_01_parent_popup_preferences_and_work(self):
  a,b=self.pair();p=self.login();p.set_viewport_size(dict(width=1680,height=1100));f=self.workspace(p,a)
  p.locator('#findings').fill('KEEP DOCK PARENT REPORT');f.get_by_role('button',name='비교 작업·배치',exact=True).click();f.locator('#kin-dock-placement').select_option('top')
  with p.context.expect_page() as opened:p.get_by_role('button',name='영상 새 창',exact=True).click()
  v=opened.value;canvas_ready(v,2);expect(v.locator('#kin-dock-placement')).to_have_value('top',timeout=45000);expect(v.locator('#kin-viewer-layout')).to_be_visible();self.ready(v)
  v.get_by_label('작업 제목',exact=True).fill('KEEP POPUP TITLE');before=self.snapshot(v);url=v.url
  v.locator('#kin-dock-placement').select_option('bottom');canvas_ready(v,2);DockPreferencesE2E.bounds(self,v,False);self.assertEqual(self.snapshot(v),before)
  expect(f.locator('#kin-dock-placement')).to_have_value('top');expect(f.locator('#kin-dock-preference-status')).to_contain_text('현재 창 유지')
  v.locator('#kin-dock-placement').select_option('top');canvas_ready(v,2);DockPreferencesE2E.bounds(self,v,True);self.assertEqual(self.snapshot(v),before)
  expect(v.get_by_label('작업 제목',exact=True)).to_have_value('KEEP POPUP TITLE');expect(p.locator('#findings')).to_have_value('KEEP DOCK PARENT REPORT');self.assertEqual(v.url,url);self.assertEqual(self.jobs(a),[])
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);v.screenshot(path=str(folder/'standalone-top.png'))
  v.get_by_label('작업 제목',exact=True).fill('');v.get_by_role('button',name='측정·주석',exact=True).click();v.reload();canvas_ready(v,2)
  expect(v.locator('#kin-dock-placement')).to_have_value('top',timeout=45000);expect(v.get_by_role('button',name='측정·주석',exact=True)).to_have_attribute('aria-expanded','true')
  v.locator('#kin-dock-reset').click();expect(v.locator('#kin-dock-placement')).to_have_value('bottom');expect(v.locator('#kin-viewer-history')).not_to_be_visible()

 def test_standalone_dock_02_mode_cleanup_reentry_and_session(self):
  a,b=self.pair();v=self.launch(self.login(),[a]);self.ready(v);before=self.snapshot(v);self.assertEqual(len(before),1)
  v.locator('#kin-dock-placement').select_option('top')
  for _ in range(2):
   v.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeExit()")
   expect(v.locator('#kin-workspace-dock')).to_have_count(0);expect(v.locator('#kin-viewer-tech-note')).to_have_count(0);expect(v.locator('#kin-viewer-layout > summary')).to_be_visible()
   v.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeEnter()")
   self.ready(v);expect(v.locator('#kin-workspace-dock')).to_have_count(1);expect(v.locator('#kin-viewer-tech-note')).to_have_count(1);expect(v.locator('#kin-dock-placement')).to_have_value('top')
  canvas_ready(v,1);self.assertEqual(self.snapshot(v),before)
  saved=DockPreferencesE2E.stored(self,v)
  v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}")
  expect(v.locator('#kin-dock-placement')).to_be_disabled();expect(v.locator('#kin-viewer-note-open')).to_be_disabled();expect(v.locator('#kin-viewer-layout')).not_to_be_visible();self.assertEqual(DockPreferencesE2E.stored(self,v),saved)

 def test_standalone_dock_03_storage_denial_and_narrow_window(self):
  a,b=self.pair();p=self.login();p.set_viewport_size(dict(width=800,height=1100))
  p.context.add_init_script("const save=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('kin-viewer-dock:v1:'))throw Error('synthetic denial');return save.call(this,k,v)}")
  v=self.launch(p,[a]);self.ready(v);canvas_ready(v,1);before=self.snapshot(v)
  v.locator('#kin-dock-placement').select_option('top');expect(v.locator('#kin-dock-preference-status')).to_contain_text('이 창에만');canvas_ready(v,1);DockPreferencesE2E.bounds(self,v,True)
  self.assertEqual(self.snapshot(v),before);v.locator('#kin-dock-reset').click();expect(v.locator('#kin-dock-placement')).to_have_value('bottom')

 def test_standalone_dock_04_native_invalid_read_denial_and_measurement_restore(self):
  a,b=self.pair();p=self.login();me=p.context.request.get(self.stack.api+'/me').json();key='kin-viewer-dock:v1:'+json.dumps([me['institution'],me['sub']],ensure_ascii=False,separators=(',',':'))
  p.evaluate('(key)=>localStorage.setItem(key,"{bad")',key);v=self.launch(p,[a]);expect(v.locator('#kin-viewer-note-open')).to_be_enabled(timeout=45000)
  expect(v.locator('#kin-workspace-dock')).to_have_count(0);expect(v.locator('#kin-viewer-dock-enable')).to_be_enabled();v.keyboard.press('Control+Alt+7');expect(v.locator('#kin-viewer-history > summary')).to_be_focused()
  v.evaluate('(key)=>localStorage.setItem(key,JSON.stringify({version:1,placement:"top",panel:0}))',key);v.reload();canvas_ready(v,1)
  expect(v.locator('#kin-dock-placement')).to_have_value('top',timeout=45000);expect(v.get_by_role('button',name='측정·주석',exact=True)).to_have_attribute('aria-expanded','true');DockPreferencesE2E.bounds(self,v,True)
  v.context.add_init_script("(()=>{const read=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(k.startsWith('kin-viewer-dock:v1:'))throw Error('synthetic read denial');return read.call(this,k)}})()")
  v.reload();canvas_ready(v,1);expect(v.locator('#kin-viewer-note-open')).to_be_enabled(timeout=45000);expect(v.locator('#kin-workspace-dock')).to_have_count(0)
  v.locator('#kin-viewer-dock-enable').click();expect(v.locator('#kin-dock-placement')).to_have_value('bottom');expect(v.locator('#kin-viewer-layout')).to_be_visible()

 def test_standalone_dock_05_detached_original_parent_retains_native_edits(self):
  a,b=self.pair();v=self.launch(self.login(),[a]);expect(v.locator('#kin-viewer-note-open')).to_be_enabled(timeout=45000)
  v.evaluate("()=>{const wrapper=document.createElement('div');wrapper.id='synthetic-panel-host';document.body.append(wrapper);for(const id of ['kin-viewer-history','kin-viewer-layout'])wrapper.append(document.getElementById(id))}")
  v.get_by_label('작업 제목',exact=True).fill('KEEP DETACHED HOST TITLE');v.locator('#kin-viewer-dock-enable').click();expect(v.locator('#kin-workspace-dock')).to_have_count(1)
  v.locator('#synthetic-panel-host').evaluate('(e)=>e.remove()');v.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeExit()")
  expect(v.locator('#kin-workspace-dock')).to_have_count(0);expect(v.locator('#kin-viewer-history > summary')).to_be_visible();expect(v.get_by_label('작업 제목',exact=True)).to_have_value('KEEP DETACHED HOST TITLE');expect(v.get_by_label('작업 제목',exact=True)).to_be_visible()
  v.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeEnter()");self.ready(v);expect(v.get_by_label('작업 제목',exact=True)).to_have_value('KEEP DETACHED HOST TITLE');canvas_ready(v,1)

def load_tests(loader,tests,pattern):return unittest.TestSuite(StandaloneDockE2E(n) for n in loader.getTestCaseNames(StandaloneDockE2E) if n.startswith('test_standalone_dock_'))
if __name__=='__main__':unittest.main(verbosity=2)
