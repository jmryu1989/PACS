# coding: utf-8
"""Account shortcut restore, unsaved input and late response handling."""
import unittest
from playwright.sync_api import expect
from test_workspace_shortcuts import WorkspaceShortcutsE2E
from workspace_roaming_support import cleanup_workspace

class ShortcutAccountE2E(WorkspaceShortcutsE2E):
 def setUp(self):
  super().setUp();self.addCleanup(cleanup_workspace,self.stack,'WorkspaceShortcuts')
 def account_ready(self,p):expect(p.locator('#workspace-shortcuts-account-save')).to_be_enabled(timeout=15000)
 def save(self,p):
  p.locator('#workspace-shortcuts-account-save').click();expect(p.locator('#workspace-shortcuts-account-status')).to_have_text('단축키를 계정에 저장했습니다.')
 def seed(self,p):
  self.editor(p);self.account_ready(p);self.assign(p,'report','Control+Alt+R');self.save(p)
 def test_account_01_new_browser_restore_and_navigation(self):
  a,b=self.pair();p=self.login();self.workspace(p,a);self.seed(p);self.apply(p)
  q=self.login();f=self.workspace(q,a);q.locator('#findings').fill('KEEP ACCOUNT SHORTCUT REPORT');self.editor(q);self.account_ready(q)
  expect(q.locator('#workspace-shortcut-report')).to_have_value('Control+Alt+4')
  q.locator('#workspace-shortcuts-account-load').click();expect(q.locator('#workspace-shortcut-report')).to_have_value('Control+Alt+R');self.apply(q)
  q.keyboard.press('Control+Alt+2');self.assertEqual(q.evaluate('()=>document.activeElement.id'),'reading-frame');q.keyboard.press('Control+Alt+R');expect(q.locator('#findings')).to_be_focused();expect(q.locator('#findings')).to_have_value('KEEP ACCOUNT SHORTCUT REPORT')
  self.editor(q);expect(q.locator('#workspace-shortcut-report')).to_have_value('Control+Alt+R')
 def test_account_02_late_load_keeps_new_input_and_closed_dialog(self):
  a,b=self.pair();p=self.login();self.workspace(p,a);self.seed(p);self.account_ready(p)
  p.evaluate("""()=>{window.shortcutFetch=window.fetch;window.holdShortcuts=false;window.fetch=async(...args)=>{const response=await shortcutFetch(...args);if(String(args[0]).endsWith('/workspace-shortcuts')&&(args[1]?.method||'GET')==='GET'){holdShortcuts=true;await new Promise(resolve=>window.releaseShortcuts=resolve)}return response}}""")
  p.locator('#workspace-shortcuts-account-load').click();p.wait_for_function('()=>holdShortcuts');self.assign(p,'report','Control+Alt+T');p.evaluate('()=>releaseShortcuts()')
  expect(p.locator('#workspace-shortcuts-account-status')).to_contain_text('입력이 바뀌어');expect(p.locator('#workspace-shortcut-report')).to_have_value('Control+Alt+T')
  p.evaluate('()=>holdShortcuts=false');p.locator('#workspace-shortcuts-account-load').click();p.wait_for_function('()=>holdShortcuts');p.locator('#workspace-shortcuts-cancel').click();p.evaluate('()=>{window.fetch=shortcutFetch;releaseShortcuts()}');self.editor(p);self.account_ready(p);expect(p.locator('#workspace-shortcut-report')).to_have_value('Control+Alt+4')
 def test_account_03_conflict_and_failed_save_keep_fields(self):
  a,b=self.pair();p=self.login();self.workspace(p,a);self.seed(p)
  q=self.login();self.workspace(q,a);self.editor(q);self.account_ready(q);self.assign(q,'report','Control+Alt+T');self.save(q)
  self.assign(p,'report','Control+Alt+N');p.locator('#workspace-shortcuts-account-save').click();expect(p.locator('#workspace-shortcuts-account-status')).to_contain_text('다른 창');expect(p.locator('#workspace-shortcut-report')).to_have_value('Control+Alt+N')
  p.locator('#workspace-shortcuts-account-load').click();expect(p.locator('#workspace-shortcut-report')).to_have_value('Control+Alt+T');self.account_ready(p)
  p.route('**/api/workspace-shortcuts',lambda route:route.abort() if route.request.method=='PUT' else route.continue_());self.assign(p,'report','Control+Alt+N');p.locator('#workspace-shortcuts-account-save').click();expect(p.locator('#workspace-shortcuts-account-status')).to_contain_text('입력은 유지');expect(p.locator('#workspace-shortcut-report')).to_have_value('Control+Alt+N')

 def test_account_04_invalid_saved_keys_can_be_repaired(self):
  a,b=self.pair();p=self.login();self.workspace(p,a);self.seed(p)
  def invalid(route):
   if route.request.method!='GET':route.continue_();return
   response=route.fetch();route.fulfill(response=response,json=dict(response.json(),bindings=None,invalid=True))
  p.route('**/api/workspace-shortcuts',invalid);p.locator('#workspace-shortcuts-account-load').click();expect(p.locator('#workspace-shortcuts-account-status')).to_contain_text('현재 입력으로');self.account_ready(p);expect(p.locator('#workspace-shortcut-report')).to_have_value('Control+Alt+R');self.save(p)
 def test_account_05_late_save_close_and_session_end(self):
  a,b=self.pair();p=self.login();self.workspace(p,a);self.editor(p);self.account_ready(p);self.assign(p,'report','Control+Alt+R')
  p.evaluate("""()=>{window.shortcutFetch=window.fetch;window.holdShortcuts=false;window.holdMethod='PUT';window.fetch=async(...args)=>{const response=await shortcutFetch(...args);if(String(args[0]).endsWith('/workspace-shortcuts')&&(args[1]?.method||'GET')===holdMethod){holdShortcuts=true;await new Promise(resolve=>window.releaseShortcuts=resolve)}return response}}""")
  p.locator('#workspace-shortcuts-account-save').click();p.wait_for_function('()=>holdShortcuts');p.locator('#workspace-shortcuts-cancel').click();p.evaluate('()=>{window.fetch=shortcutFetch;releaseShortcuts()}');self.editor(p);self.account_ready(p);expect(p.locator('#workspace-shortcuts-account-status')).to_contain_text('계정 설정이 있습니다');expect(p.locator('#workspace-shortcut-report')).to_have_value('Control+Alt+4')
  p.evaluate("""()=>{window.holdShortcuts=false;window.fetch=async(...args)=>{const response=await shortcutFetch(...args);if(String(args[0]).endsWith('/workspace-shortcuts')){holdShortcuts=true;await new Promise(resolve=>window.releaseShortcuts=resolve)}return response}}""")
  p.locator('#workspace-shortcuts-account-load').click();p.wait_for_function('()=>holdShortcuts');p.evaluate("()=>{const channel=new BroadcastChannel('kin-session');channel.postMessage({type:'session-ended'});channel.close()}");expect(p.locator('#workspace-shortcuts-dialog')).to_have_count(0);p.evaluate('()=>releaseShortcuts()');expect(p.locator('#workspace-shortcuts-account-status')).to_have_count(0)

def load_tests(loader,tests,pattern):return unittest.TestSuite(ShortcutAccountE2E(n) for n in loader.getTestCaseNames(ShortcutAccountE2E) if n.startswith('test_account_'))
if __name__=='__main__':unittest.main(verbosity=2)
