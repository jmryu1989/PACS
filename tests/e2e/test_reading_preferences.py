# coding: utf-8
"""Explicit account save/load leaves newer local choices and clinical work intact."""
import os,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_reading_note import ReadingNoteE2E
from workspace_roaming_support import cleanup_workspace

class ReadingPreferencesE2E(ReadingNoteE2E):
 def setUp(self):
  super().setUp();self.addCleanup(cleanup_workspace,self.stack,'ReadingPreferences')
 def ready(self,p):expect(p.locator('#reading-prefs-save')).to_be_enabled()
 def test_prefs_01_two_browsers_explicit_load_and_off(self):
  from test_viewer_tech_note import ViewerTechNoteE2E
  a,b=self.pair();p=self.login();f=self.workspace(p,a);self.ready(p)
  before=ViewerTechNoteE2E.snapshot(self,f);self.assertEqual(len(before),2)
  p.locator('#findings').fill('KEEP ACCOUNT SETTING REPORT')
  p.locator('#reading-note-auto').check();p.locator('#reading-prefs-save').click()
  expect(p.locator('#reading-prefs-status')).to_have_text('메모 설정을 계정에 저장했습니다.')
  other=self.login();self.workspace(other,a);self.ready(other)
  expect(other.locator('#reading-note-auto')).not_to_be_checked()
  other.locator('#reading-prefs-load').click();expect(other.locator('#reading-note-auto')).to_be_checked()
  other.locator('#reading-note-auto').uncheck();other.locator('#reading-prefs-save').click()
  expect(other.locator('#reading-prefs-status')).to_have_text('메모 설정을 계정에 저장했습니다.')
  p.locator('#reading-prefs-load').click();expect(p.locator('#reading-note-auto')).not_to_be_checked()
  expect(p.locator('#findings')).to_have_value('KEEP ACCOUNT SETTING REPORT')
  self.assertEqual(ViewerTechNoteE2E.snapshot(self,f),before)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'reading-account-settings.png'))
 def test_prefs_02_conflict_keeps_local_choice(self):
  a,b=self.pair();p=self.login();self.workspace(p,a);self.ready(p)
  other=self.login();self.workspace(other,a);self.ready(other)
  p.locator('#reading-note-auto').check();p.locator('#reading-prefs-save').click()
  expect(p.locator('#reading-prefs-status')).to_have_text('메모 설정을 계정에 저장했습니다.')
  other.locator('#reading-prefs-save').click();expect(other.locator('#reading-prefs-status')).to_contain_text('다른 창에서 설정이 바뀌었습니다')
  expect(other.locator('#reading-note-auto')).not_to_be_checked();expect(other.locator('#reading-prefs-save')).to_be_disabled()
  other.locator('#reading-prefs-load').click();expect(other.locator('#reading-note-auto')).to_be_checked()
 def test_prefs_03_late_read_and_session_end(self):
  a,b=self.pair();p=self.login();self.workspace(p,a);self.ready(p)
  waiting=[];p.route('**/api/reading-preferences',lambda route:waiting.append(route))
  p.locator('#reading-prefs-load').click();expect(p.locator('#reading-prefs-status')).to_have_text('메모 설정 확인 중…')
  p.locator('#reading-note-auto').check()
  self.assertEqual(len(waiting),1);waiting.pop().fulfill(response=p.request.get(self.stack.api+'/reading-preferences'))
  expect(p.locator('#reading-prefs-status')).to_contain_text('현재 설정이 바뀌어 적용하지 않았습니다')
  expect(p.locator('#reading-note-auto')).to_be_checked()
  p.locator('#reading-prefs-load').click();expect(p.locator('#reading-prefs-status')).to_have_text('메모 설정 확인 중…')
  p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}")
  expect(p.locator('#reading-prefs-load')).to_be_disabled();expect(p.locator('#reading-prefs-save')).to_be_disabled()
  for route in waiting:route.abort()

 def test_prefs_04_failed_save_and_other_account(self):
  a,b=self.pair();p=self.login();self.workspace(p,a);self.ready(p)
  p.locator('#reading-note-auto').check()
  p.route('**/api/reading-preferences',lambda route:route.fulfill(status=500,content_type='application/json',body='{}'))
  p.locator('#reading-prefs-save').click();expect(p.locator('#reading-prefs-status')).to_contain_text('설정 저장 여부를 확인하지 못했습니다')
  expect(p.locator('#reading-note-auto')).to_be_checked();expect(p.locator('#reading-prefs-save')).to_be_disabled()
  p.unroute('**/api/reading-preferences');p.locator('#reading-prefs-load').click();self.ready(p)
  expect(p.locator('#reading-note-auto')).to_be_checked();p.locator('#reading-prefs-save').click()
  expect(p.locator('#reading-prefs-status')).to_have_text('메모 설정을 계정에 저장했습니다.')
  other=self.login('doctor2');self.workspace(other,a);self.ready(other)
  other.locator('#reading-prefs-load').click();expect(other.locator('#reading-prefs-status')).to_have_text('계정에 저장된 메모 설정이 없습니다.')
  expect(other.locator('#reading-note-auto')).not_to_be_checked()

def load_tests(loader,tests,pattern):return unittest.TestSuite(ReadingPreferencesE2E(n) for n in loader.getTestCaseNames(ReadingPreferencesE2E) if n.startswith('test_prefs_'))
if __name__=='__main__':unittest.main(verbosity=2)
