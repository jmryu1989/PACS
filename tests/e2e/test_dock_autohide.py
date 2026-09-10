# coding: utf-8
"""TEST-DOCK-AUTOHIDE: native pointer/focus, account restore and transient collapse."""
import json,os,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_dock_account import DockAccountE2E
from test_viewer_tech_note import ViewerTechNoteE2E,canvas_ready

class DockAutohideE2E(DockAccountE2E):
 def tab(self,f):return f.locator('#kin-workspace-dock nav button[aria-controls="kin-viewer-layout"]')
 def opened(self,p,a):
  f=self.workspace(p,a);self.tab(f).click();expect(self.tab(f)).to_have_attribute('aria-expanded','true');return f
 def outside(self,p,f):
  c=f.locator('.cornerstone-canvas').first;c.evaluate('e=>e.tabIndex=-1');box=c.bounding_box();p.mouse.click(box['x']+box['width']/2,box['y']+box['height']/2);c.focus();return box
 def held_frames(self,f):
  samples=f.evaluate("""()=>new Promise(resolve=>{const samples=[],start=performance.now();function frame(){samples.push(document.body.classList.contains('kin-dock-open'));if(performance.now()-start>=1600)resolve(samples);else requestAnimationFrame(frame)}requestAnimationFrame(frame)})""");self.assertGreater(len(samples),3);self.assertTrue(all(samples));print('OPEN GUARD FRAMES',len(samples),flush=True)
 def test_auto_01_input_pointer_collapse_and_focus_reopen_preserve_work(self):
  a,b=self.pair();p=self.login();f=self.opened(p,a);p.locator('#findings').fill('KEEP AUTO REPORT');field=f.get_by_label('작업 제목',exact=True);field.fill('KEEP AUTO JOB');f.locator('#kin-dock-autohide').check();field.focus();self.held_frames(f);before=ViewerTechNoteE2E.snapshot(self,f)
  box=self.outside(p,f)
  for _ in range(6):p.keyboard.press('Shift');p.wait_for_timeout(300);expect(self.tab(f)).to_have_attribute('aria-expanded','true')
  p.mouse.down();self.held_frames(f);p.mouse.up();expect(self.tab(f)).to_have_attribute('aria-expanded','false',timeout=10000)
  value=f.evaluate("()=>document.getElementById('kin-workspace-dock').preference()");self.assertEqual(value,dict(version=2,placement='bottom',panel=1,autoHide=True));self.assertTrue(f.locator('#kin-viewer-layout').evaluate('e=>e.hidden'))
  p.keyboard.press('Control+Alt+7');expect(self.tab(f)).to_have_attribute('aria-expanded','true');self.assertEqual(f.evaluate("()=>document.getElementById('kin-workspace-dock').preference().panel"),1);p.keyboard.press('Enter');expect(f.locator('#kin-workspace-dock nav button[aria-controls="kin-viewer-history"]')).to_have_attribute('aria-expanded','true');p.keyboard.press('Tab');expect(self.tab(f)).to_be_focused();p.keyboard.press('Enter');expect(self.tab(f)).to_have_attribute('aria-expanded','true');self.held_frames(f);canvas_ready(f,2);expect(field).to_have_value('KEEP AUTO JOB');expect(p.locator('#findings')).to_have_value('KEEP AUTO REPORT');self.assertEqual(ViewerTechNoteE2E.snapshot(self,f),before);self.assertEqual(self.jobs(a),[])
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'autohide-reopened.png'))
 def test_auto_02_real_busy_request_and_mode_disposal(self):
  a,b=self.pair();p=self.launch(self.login(),[a]);f=p;expect(f.locator('#kin-viewer-note-open')).to_be_enabled(timeout=45000)
  if f.locator('#kin-viewer-dock-enable').is_visible():f.locator('#kin-viewer-dock-enable').click()
  expect(f.locator('#kin-dock-autohide')).to_be_visible(timeout=45000)
  if self.tab(f).get_attribute('aria-expanded')!='true':self.tab(f).click()
  f.locator('#kin-dock-autohide').check();pending=[];path='**/api/studies/'+a.uid+'/viewer-jobs*'
  p.route(path,lambda route:pending.append(route))
  try:
   f.get_by_role('button',name='작업 목록 새로고침',exact=True).click();expect(f.locator('#kin-viewer-jobs-status')).to_contain_text('확인 중')
   for _ in range(100):
    if pending:break
    p.wait_for_timeout(50)
   self.assertEqual(len(pending),1);self.outside(p,f);self.held_frames(f)
   route=pending.pop();route.fulfill(response=route.fetch());expect(f.locator('#kin-viewer-jobs-status')).to_contain_text('저장 작업 목록');expect(self.tab(f)).to_have_attribute('aria-expanded','false',timeout=10000)
  finally:
   for route in pending:route.abort()
   p.unroute(path)
  self.tab(f).focus();expect(self.tab(f)).to_have_attribute('aria-expanded','true');f.evaluate("()=>{window.oldAutoDock=document.getElementById('kin-workspace-dock');window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeExit()}");expect(f.locator('#kin-workspace-dock')).to_have_count(0)
  self.assertFalse(f.evaluate("()=>window.oldAutoDock.applyPreference({version:2,placement:'top',panel:1,autoHide:true})"));self.assertFalse(f.evaluate("()=>document.body.classList.contains('kin-docked')"))
  f.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeEnter()");expect(f.locator('#kin-dock-autohide')).to_be_checked(timeout=45000);expect(f.locator('#kin-workspace-dock')).to_have_count(1)
 def test_auto_03_account_legacy_load_and_session(self):
  a,b=self.pair();p=self.login();f=self.opened(p,a);self.ready(p);p.locator('#reading-dock-autohide').check();p.locator('#appearance-account-save').click();self.saved(p);saved=p.request.get(self.stack.api+'/reading-appearance').json();self.assertEqual(saved['sizes']['version'],6);self.assertTrue(saved['sizes']['dock']['autoHide']);p.locator('#reading-appearance-close').click()
  other=self.login();g=self.opened(other,a);self.ready(other);expect(other.locator('#reading-dock-autohide')).not_to_be_checked();other.locator('#appearance-account-load').click();expect(other.locator('#appearance-account-status')).to_have_text('계정의 표시 설정을 불러왔습니다.');expect(other.locator('#reading-dock-autohide')).to_be_checked();expect(g.locator('#kin-dock-autohide')).to_be_checked()
  legacy=json.loads(json.dumps(saved));legacy['sizes']['version']=4;legacy['sizes'].pop('toolbar');legacy['sizes']['dock']=dict(version=1,placement='top',panel=0)
  other.route('**/api/reading-appearance',lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps(legacy)));other.locator('#appearance-account-load').click();expect(other.locator('#reading-dock-placement')).to_have_value('top');expect(other.locator('#reading-dock-autohide')).to_be_checked();expect(g.locator('#kin-dock-autohide')).to_be_checked()
  other.locator('#reading-appearance-close').click();other.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(other.locator('#reading-frame')).to_have_count(0);expect(other.locator('#reading-dock-autohide')).to_be_disabled()

 def test_auto_04_history_busy_and_native_modal_guard(self):
  a,b=self.pair();p=self.login();f=self.opened(p,a);f.locator('#kin-dock-autohide').check();f.evaluate("()=>{window.originalHistoryState=kinViewerHistoryWorkspaceState;window.kinViewerHistoryWorkspaceState=()=>({busy:true,dirty:false})}")
  try:self.outside(p,f);self.held_frames(f)
  finally:f.evaluate('()=>window.kinViewerHistoryWorkspaceState=window.originalHistoryState')
  expect(self.tab(f)).to_have_attribute('aria-expanded','false',timeout=10000);self.tab(f).focus();expect(self.tab(f)).to_have_attribute('aria-expanded','true')
  f.evaluate("()=>{window.autoDialog=document.createElement('dialog');autoDialog.textContent='Synthetic modal';document.body.append(autoDialog);autoDialog.showModal()}");self.held_frames(f);f.evaluate('()=>{autoDialog.close();autoDialog.remove()}');self.outside(p,f);expect(self.tab(f)).to_have_attribute('aria-expanded','false',timeout=10000)

 def test_auto_05_pointer_reopen_does_not_toggle_closed_or_erase_selection(self):
  a,b=self.pair();p=self.login();f=self.opened(p,a);f.locator('#kin-dock-autohide').check()
  for placement in ['bottom','top']:
   f.locator('#kin-dock-placement').select_option(placement);self.outside(p,f);expect(self.tab(f)).to_have_attribute('aria-expanded','false',timeout=10000)
   self.tab(f).click();print('POINTER REOPEN',placement,f.evaluate("()=>document.getElementById('kin-workspace-dock').preference()"),flush=True);expect(self.tab(f)).to_have_attribute('aria-expanded','true');self.assertEqual(f.evaluate("()=>document.getElementById('kin-workspace-dock').preference().panel"),1)
   saved=p.evaluate("()=>Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('kin-viewer-dock:')).map(k=>[k,JSON.parse(localStorage.getItem(k))]))");self.assertEqual(len(saved),1);self.assertEqual(next(iter(saved.values()))['panel'],1)

def load_tests(loader,tests,pattern):return unittest.TestSuite(DockAutohideE2E(n) for n in loader.getTestCaseNames(DockAutohideE2E) if n.startswith('test_auto_'))
if __name__=='__main__':unittest.main(verbosity=2)
