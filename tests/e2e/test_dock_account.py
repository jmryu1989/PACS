# coding: utf-8
"""TEST-DOCK-ROAM-BROWSER: explicit restore and all dock edits invalidate late loads."""
import json,os,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_reading_appearance_account import AppearanceAccountE2E
from test_viewer_tech_note import ViewerTechNoteE2E
from test_prior_selection import canvas_ready

class DockAccountE2E(AppearanceAccountE2E):
 def saved(self,p):expect(p.locator('#appearance-account-status')).to_have_text('표시 설정을 계정에 저장했습니다.')
 def test_dock_account_01_cross_browser_explicit_restore_and_live_work(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a);f.get_by_role('button',name='비교 작업·배치',exact=True).click();self.ready(p)
  p.locator('#reading-dock-placement').select_option('top');p.locator('#reading-font-current').select_option('mono');p.locator('#appearance-account-save').click();self.saved(p)
  saved=p.request.get(self.stack.api+'/reading-appearance').json()['sizes'];self.assertEqual(saved['version'],3);self.assertEqual(saved['dock'],dict(version=1,placement='top',panel=1))
  other=self.login();g=self.workspace(other,a);g.get_by_role('button',name='비교 작업·배치',exact=True).click();g.get_by_label('작업 제목',exact=True).fill('KEEP ROAM DOCK TITLE');other.locator('#findings').fill('KEEP ROAM REPORT')
  before=ViewerTechNoteE2E.snapshot(self,g);self.assertEqual(len(before),2);self.ready(other);expect(g.locator('#kin-dock-placement')).to_have_value('bottom')
  other.locator('#appearance-account-load').click();expect(other.locator('#appearance-account-status')).to_have_text('계정의 표시 설정을 불러왔습니다.');expect(g.locator('#kin-dock-placement')).to_have_value('top');expect(other.locator('#reading-font-current')).to_have_value('mono');canvas_ready(g,2)
  self.assertEqual(ViewerTechNoteE2E.snapshot(self,g),before);expect(g.get_by_label('작업 제목',exact=True)).to_have_value('KEEP ROAM DOCK TITLE');expect(other.locator('#findings')).to_have_value('KEEP ROAM REPORT');self.assertEqual(self.jobs(a),[]);expect(other.locator('#reading-dock-status')).not_to_contain_text('다른 창')
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);other.screenshot(path=str(folder/'account-dock.png'))
  other.locator('#reading-appearance-close').click()
  with other.context.expect_page() as opened:other.get_by_role('button',name='영상 새 창',exact=True).click()
  popup=opened.value;canvas_ready(popup,2);expect(popup.locator('#kin-dock-placement')).to_have_value('top',timeout=45000)
  self.settings(other);other.locator('#reading-dock-placement').select_option('bottom');expect(g.locator('#kin-dock-placement')).to_have_value('bottom');expect(popup.locator('#kin-dock-placement')).to_have_value('top');expect(popup.locator('#kin-dock-preference-status')).to_contain_text('현재 창 유지')

 def test_dock_account_02_late_load_aba_and_save_snapshot(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a);self.ready(p);p.locator('#reading-dock-placement').select_option('top');p.locator('#appearance-account-save').click();self.saved(p)
  pending=[];p.route('**/api/reading-appearance',lambda route:pending.append(route));p.locator('#appearance-account-load').click();expect(p.locator('#appearance-account-status')).to_have_text('표시 설정 확인 중…')
  p.locator('#reading-appearance-close').click();f.locator('#kin-dock-placement').select_option('bottom');f.locator('#kin-dock-placement').select_option('top');self.settings(p)
  self.assertEqual(len(pending),1);pending.pop().fulfill(response=p.request.get(self.stack.api+'/reading-appearance'));expect(p.locator('#appearance-account-status')).to_contain_text('현재 설정이 바뀌어 적용하지 않았습니다')
  p.locator('#reading-dock-placement').select_option('bottom');p.locator('#appearance-account-save').click();expect(p.locator('#appearance-account-status')).to_have_text('표시 설정 확인 중…');p.locator('#reading-dock-placement').select_option('top')
  self.assertEqual(len(pending),1);r=pending.pop();r.fulfill(response=r.fetch());expect(p.locator('#appearance-account-status')).to_contain_text('요청 당시 설정');expect(f.locator('#kin-dock-placement')).to_have_value('top');self.assertEqual(p.request.get(self.stack.api+'/reading-appearance').json()['sizes']['dock']['placement'],'bottom')

 def test_dock_account_03_legacy_preserves_dock_and_invalid_response_atomic(self):
  p=self.login();self.ready(p);head=p.request.get(self.stack.api+'/reading-appearance').json();legacy=dict(version=2,list=16,current=18,prior=20,fonts=dict(version=1,list='sans',current='mono',prior='serif'),colors=dict(version=1,list='warm',current='white',prior='cool'))
  r=p.request.put(self.stack.api+'/reading-appearance',headers={'X-KIN-CSRF':'1'},data=dict(expectedOwner=head['owner'],revision=0,sizes=legacy));self.assertEqual(r.status,200)
  p.locator('#reading-dock-placement').select_option('top');p.locator('#reading-dock-panel').select_option('0');p.locator('#appearance-account-load').click();expect(p.locator('#reading-text-current')).to_have_value('18');expect(p.locator('#reading-dock-placement')).to_have_value('top');expect(p.locator('#reading-dock-panel')).to_have_value('0')
  bad=dict(owner=head['owner'],revision=1,sizes=dict(legacy,version=3,current=20,dock=dict(version=1,placement='left',panel=0)))
  p.route('**/api/reading-appearance',lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps(bad)));p.locator('#appearance-account-load').click();expect(p.locator('#appearance-account-status')).to_contain_text('응답을 확인할 수 없습니다');expect(p.locator('#reading-text-current')).to_have_value('18');expect(p.locator('#reading-dock-placement')).to_have_value('top');expect(p.locator('#appearance-account-save')).to_be_disabled()

 def test_dock_account_04_storage_failure_in_window_and_session_end(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a);self.ready(p);p.locator('#reading-dock-placement').select_option('top');p.locator('#appearance-account-save').click();self.saved(p)
  p.locator('#reading-dock-placement').select_option('bottom');f.evaluate("()=>{const save=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('kin-viewer-dock:v1:'))throw Error('synthetic denial');return save.call(this,k,v)}}")
  p.locator('#appearance-account-load').click();expect(f.locator('#kin-dock-placement')).to_have_value('top');expect(p.locator('#reading-dock-status')).to_contain_text('이 창에만');expect(p.locator('#appearance-account-status')).to_have_text('계정의 표시 설정을 불러왔습니다.')
  pending=[];p.route('**/api/reading-appearance',lambda route:pending.append(route));p.locator('#appearance-account-load').click();expect(p.locator('#appearance-account-status')).to_have_text('표시 설정 확인 중…');self.assertEqual(len(pending),1)
  p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(p.locator('#reading-frame')).to_have_count(0);expect(p.locator('#reading-dock-placement')).to_be_disabled();expect(p.locator('#appearance-account-save')).to_be_disabled()
  for route in pending:route.abort()

 def test_dock_account_05_parent_storage_denial_and_popup_late_load(self):
  a,b=self.pair();p=self.login();self.ready(p)
  p.evaluate("()=>{const save=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('kin-viewer-dock:v1:'))throw Error('synthetic parent denial');return save.call(this,k,v)}}")
  p.locator('#reading-dock-placement').select_option('top');expect(p.locator('#reading-dock-status')).to_contain_text('이 창에만');p.locator('#appearance-account-save').click();self.saved(p)
  pending=[];p.route('**/api/reading-appearance',lambda route:pending.append(route));p.locator('#appearance-account-load').click();expect(p.locator('#appearance-account-status')).to_have_text('표시 설정 확인 중…');p.locator('#reading-dock-placement').select_option('bottom')
  self.assertEqual(len(pending),1);pending.pop().fulfill(response=p.request.get(self.stack.api+'/reading-appearance'));expect(p.locator('#appearance-account-status')).to_contain_text('현재 설정이 바뀌어 적용하지 않았습니다');p.unroute('**/api/reading-appearance')
  p.locator('#reading-appearance-close').click();f=self.workspace(p,a)
  with p.context.expect_page() as opened:p.get_by_role('button',name='영상 새 창',exact=True).click()
  popup=opened.value;canvas_ready(popup,2);expect(popup.locator('#kin-viewer-note-open')).to_be_enabled(timeout=45000)
  if popup.locator('#kin-viewer-dock-enable').is_visible():popup.locator('#kin-viewer-dock-enable').click()
  self.settings(p);p.route('**/api/reading-appearance',lambda route:pending.append(route));p.locator('#appearance-account-load').click();expect(p.locator('#appearance-account-status')).to_have_text('표시 설정 확인 중…');popup.locator('#kin-dock-placement').select_option('top')
  expect(p.locator('#reading-dock-status')).to_contain_text('다른 창');self.assertEqual(len(pending),1);pending.pop().fulfill(response=p.request.get(self.stack.api+'/reading-appearance'));expect(p.locator('#appearance-account-status')).to_contain_text('현재 설정이 바뀌어 적용하지 않았습니다');expect(f.locator('#kin-dock-placement')).to_have_value('bottom')

 def test_dock_account_06_refused_live_apply_keeps_save_disabled(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a);self.ready(p);p.locator('#reading-text-current').select_option('20');p.locator('#appearance-account-save').click();self.saved(p)
  p.locator('#reading-text-current').select_option('18');f.locator('#kin-workspace-dock').evaluate('(e)=>{e.syntheticOriginalApply=e.applyPreference;e.applyPreference=()=>false}');p.locator('#appearance-account-load').click()
  expect(p.locator('#appearance-account-status')).to_contain_text('화면 설정을 적용하지 못했습니다');expect(p.locator('#reading-text-current')).to_have_value('18');expect(p.locator('#appearance-account-save')).to_be_disabled()
  f.locator('#kin-workspace-dock').evaluate('(e)=>{e.applyPreference=e.syntheticOriginalApply;delete e.syntheticOriginalApply;e.end()}');expect(f.locator('#kin-dock-placement')).to_be_disabled()
  p.locator('#appearance-account-load').click();expect(p.locator('#reading-text-current')).to_have_value('20');expect(p.locator('#appearance-account-save')).to_be_enabled();expect(f.locator('#kin-dock-placement')).to_be_disabled();expect(f.locator('#kin-viewer-layout')).not_to_be_visible();expect(p.locator('#reading-dock-status')).to_contain_text('다음 영상 창')

def load_tests(loader,tests,pattern):return unittest.TestSuite(DockAccountE2E(n) for n in loader.getTestCaseNames(DockAccountE2E) if n.startswith('test_dock_account_'))
if __name__=='__main__':unittest.main(verbosity=2)
