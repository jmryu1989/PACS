# coding: utf-8
"""TEST-TEXT-ROAM-BROWSER: explicit cross-browser restore and late response guards."""
import os,unittest,json
from pathlib import Path
from playwright.sync_api import expect
from test_reading_appearance import ReadingAppearanceE2E
from workspace_roaming_support import cleanup_workspace

class AppearanceAccountE2E(ReadingAppearanceE2E):
 def setUp(self):
  super().setUp();self.addCleanup(cleanup_workspace,self.stack,'ReadingAppearance')
 def ready(self,p):
  self.settings(p);expect(p.locator('#appearance-account-save')).to_be_enabled()
 def test_roam_01_explicit_two_browser_restore_preserves_work(self):
  from test_viewer_tech_note import ViewerTechNoteE2E
  a,b=self.pair();p=self.login();f=self.workspace(p,a)
  p.locator('#findings').fill('KEEP ACCOUNT FONT REPORT')
  f.get_by_role('button',name='비교 작업·배치',exact=True).click();f.get_by_label('작업 제목',exact=True).fill('KEEP ACCOUNT FONT VIEWER')
  before=ViewerTechNoteE2E.snapshot(self,f);self.assertEqual(len(before),2);self.ready(p)
  p.locator('#reading-font-current').select_option('mono')
  for name,size in [('list','16'),('current','20'),('prior','18')]:p.locator('#reading-text-'+name).select_option(size)
  p.locator('#appearance-account-save').click();expect(p.locator('#appearance-account-status')).to_have_text('글자 설정을 계정에 저장했습니다.')
  other=self.login();self.workspace(other,a);self.ready(other)
  expect(other.locator('#findings')).to_have_css('font-size','12px')
  expect(other.locator('#reading-font-current')).to_have_value('default')
  other.locator('#appearance-account-load').click();expect(other.locator('#findings')).to_have_css('font-size','20px')
  expect(other.locator('#reading-text-list')).to_have_value('16');expect(other.locator('#reading-text-prior')).to_have_value('18')
  other.locator('#reading-text-current').select_option('16');other.locator('#appearance-account-save').click()
  expect(other.locator('#appearance-account-status')).to_have_text('글자 설정을 계정에 저장했습니다.')
  p.locator('#appearance-account-load').click();expect(p.locator('#findings')).to_have_css('font-size','16px')
  expect(p.locator('#reading-font-current')).to_have_value('mono')
  self.assertTrue(p.locator('#findings').evaluate('(e)=>getComputedStyle(e).fontFamily').endswith('monospace'))
  expect(p.locator('#findings')).to_have_value('KEEP ACCOUNT FONT REPORT');expect(f.get_by_label('작업 제목',exact=True)).to_have_value('KEEP ACCOUNT FONT VIEWER')
  self.assertEqual(ViewerTechNoteE2E.snapshot(self,f),before)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'account-text-sizes.png'))
 def test_roam_02_conflict_preserves_local_choice(self):
  a,b=self.pair();p=self.login();self.ready(p);other=self.login();self.ready(other)
  p.locator('#reading-text-current').select_option('20');p.locator('#appearance-account-save').click()
  expect(p.locator('#appearance-account-status')).to_have_text('글자 설정을 계정에 저장했습니다.')
  other.locator('#reading-text-current').select_option('18');other.locator('#appearance-account-save').click()
  expect(other.locator('#appearance-account-status')).to_contain_text('다른 창에서 설정이 바뀌었습니다')
  expect(other.locator('#findings')).to_have_css('font-size','18px');expect(other.locator('#appearance-account-save')).to_be_disabled()
  other.locator('#appearance-account-load').click();expect(other.locator('#findings')).to_have_css('font-size','20px')
 def test_roam_03_newer_local_edit_and_session_end(self):
  a,b=self.pair();p=self.login();self.ready(p)
  p.locator('#reading-text-current').select_option('20');p.locator('#appearance-account-save').click()
  expect(p.locator('#appearance-account-status')).to_have_text('글자 설정을 계정에 저장했습니다.')
  pending=[];p.route('**/api/reading-appearance',lambda route:pending.append(route))
  p.locator('#appearance-account-load').click();expect(p.locator('#appearance-account-status')).to_have_text('글자 설정 확인 중…')
  p.locator('#reading-text-current').select_option('18');self.assertEqual(len(pending),1)
  pending.pop().fulfill(response=p.request.get(self.stack.api+'/reading-appearance'))
  expect(p.locator('#appearance-account-status')).to_contain_text('현재 설정이 바뀌어 적용하지 않았습니다')
  expect(p.locator('#findings')).to_have_css('font-size','18px')
  p.locator('#appearance-account-load').click();expect(p.locator('#appearance-account-status')).to_have_text('글자 설정 확인 중…')
  p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}")
  expect(p.locator('#appearance-account-save')).to_be_disabled();expect(p.locator('#reading-appearance-dialog')).not_to_be_visible()
  for route in pending:route.abort()
 def test_roam_04_failed_write_empty_load_and_wrong_owner_response(self):
  a,b=self.pair();p=self.login();self.ready(p);p.locator('#reading-text-current').select_option('20')
  p.route('**/api/reading-appearance',lambda route:route.fulfill(status=500,content_type='application/json',body='{}'))
  p.locator('#appearance-account-save').click();expect(p.locator('#appearance-account-status')).to_contain_text('설정 저장 여부를 확인하지 못했습니다')
  expect(p.locator('#appearance-account-save')).to_be_disabled();expect(p.locator('#findings')).to_have_css('font-size','20px')
  p.unroute('**/api/reading-appearance');p.locator('#appearance-account-load').click()
  expect(p.locator('#appearance-account-status')).to_have_text('계정에 저장된 글자 설정이 없습니다.')
  expect(p.locator('#findings')).to_have_css('font-size','20px');p.locator('#appearance-account-save').click()
  expect(p.locator('#appearance-account-status')).to_have_text('글자 설정을 계정에 저장했습니다.')
  other=self.login('doctor2');self.ready(other);other.locator('#appearance-account-load').click()
  expect(other.locator('#appearance-account-status')).to_have_text('계정에 저장된 글자 설정이 없습니다.')
  me=other.request.get(self.stack.api+'/me').json()
  p.route('**/api/me',lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps(me)))
  p.locator('#reading-text-current').select_option('16');p.locator('#appearance-account-load').click()
  expect(p.locator('#appearance-account-status')).to_contain_text('세션이 변경되었습니다')
  expect(p.locator('#findings')).to_have_css('font-size','16px');expect(p.locator('#appearance-account-save')).to_be_disabled()

def load_tests(loader,tests,pattern):return unittest.TestSuite(AppearanceAccountE2E(n) for n in loader.getTestCaseNames(AppearanceAccountE2E) if n.startswith('test_roam_'))
if __name__=='__main__':unittest.main(verbosity=2)
