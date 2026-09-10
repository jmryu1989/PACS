# coding: utf-8
"""TEST-TOOLBAR-ROAM: explicit restore, delayed replies and live draft guards."""
import json,os,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_toolbar_preferences import ToolbarPreferencesE2E,BASE,canvas_ready
from workspace_roaming_support import cleanup_workspace

class ToolbarAccountE2E(ToolbarPreferencesE2E):
 def setUp(self):super().setUp();self.addCleanup(cleanup_workspace,self.stack,'ReadingAppearance')
 def settings(self,p):
  if not p.locator('#reading-appearance-dialog').is_visible():p.locator('#reading-appearance-open').click()
 def account_ready(self,p):self.settings(p);expect(p.locator('#appearance-account-save')).to_be_enabled()
 def save_account(self,p):p.locator('#appearance-account-save').click();expect(p.locator('#appearance-account-status')).to_have_text('표시 설정을 계정에 저장했습니다.')
 def loaded(self,p):expect(p.locator('#appearance-account-status')).to_have_text('계정의 표시 설정을 불러왔습니다.')
 def customized(self,p,a):
  f=self.workspace(p,a);self.editor(f);self.customize(f);self.applied(f);self.account_ready(p);self.save_account(p);return f

 def test_account_01_new_browser_restore_and_future_popup_preserve_work(self):
  a,b=self.pair();p=self.login();f=self.customized(p,a);wanted=self.section(f);saved=p.request.get(self.stack.api+'/reading-appearance').json();self.assertEqual(saved['sizes']['version'],6);self.assertEqual(saved['sizes']['toolbar']['hidden'],['Pan'])
  other=self.login();g=self.workspace(other,a);self.tools(g);g.get_by_label('작업 제목',exact=True).fill('KEEP TOOLBAR ROAM JOB');other.locator('#findings').fill('KEEP TOOLBAR ROAM REPORT');before=self.snapshot(g);self.account_ready(other);self.assertEqual(self.section(g),BASE)
  other.locator('#appearance-account-load').click();self.loaded(other);self.assertEqual(self.section(g),wanted);self.assertEqual(self.snapshot(g),before);expect(other.locator('#findings')).to_have_value('KEEP TOOLBAR ROAM REPORT');expect(g.get_by_label('작업 제목',exact=True)).to_have_value('KEEP TOOLBAR ROAM JOB');self.assertEqual(self.jobs(a),[])
  other.locator('#reading-appearance-close').click()
  with other.context.expect_page() as opened:other.get_by_role('button',name='영상 새 창',exact=True).click()
  v=opened.value;canvas_ready(v,2);self.ready(v);self.assertEqual(self.section(v),wanted)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);self.settings(other);other.screenshot(path=str(folder/'toolbar-account.png'))

 def test_account_02_late_load_aba_and_save_snapshot(self):
  a,b=self.pair();p=self.login();f=self.customized(p,a);wanted=self.section(f);pending=[];p.route('**/api/reading-appearance',lambda route:pending.append(route))
  p.locator('#appearance-account-load').click();expect(p.locator('#appearance-account-status')).to_have_text('표시 설정 확인 중…');p.locator('#reading-appearance-close').click();self.editor(f);f.locator('#kin-native-toolbar-default').click();self.applied(f);self.editor(f);self.customize(f);self.applied(f);self.settings(p);self.assertEqual(len(pending),1)
  pending.pop().fulfill(response=p.request.get(self.stack.api+'/reading-appearance'));expect(p.locator('#appearance-account-status')).to_contain_text('현재 설정이 바뀌어 적용하지 않았습니다');self.assertEqual(self.section(f),wanted)
  p.locator('#appearance-account-save').click();expect(p.locator('#appearance-account-status')).to_have_text('표시 설정 확인 중…');p.locator('#reading-toolbar-reset').click();self.assertEqual(self.section(f),BASE);self.assertEqual(len(pending),1);r=pending.pop();r.fulfill(response=r.fetch());expect(p.locator('#appearance-account-status')).to_contain_text('요청 당시 설정');self.assertEqual(p.request.get(self.stack.api+'/reading-appearance').json()['sizes']['toolbar']['hidden'],['Pan']);self.assertEqual(self.section(f),BASE)

 def test_account_06_retained_hidden_viewer_loads_without_losing_work(self):
  a,b=self.pair();p=self.login();f=self.customized(p,a);wanted=self.section(f);p.locator('#reading-toolbar-reset').click();self.assertEqual(self.section(f),BASE);p.locator('#reading-appearance-close').click();self.tools(f);f.get_by_label('작업 제목',exact=True).fill('KEEP HIDDEN ROAM TITLE');p.locator('#findings').fill('KEEP HIDDEN ROAM REPORT');before=self.snapshot(f);url=f.url
  p.get_by_role('button',name='목록 화면으로',exact=True).click();expect(p.locator('#reading-viewer')).not_to_be_visible();expect(p.locator('#reading-viewer')).to_have_attribute('aria-hidden','true');self.assertTrue(p.locator('#reading-viewer').evaluate('e=>e.inert'));self.settings(p);p.locator('#appearance-account-load').click();self.loaded(p);self.assertEqual(self.section(f),wanted);expect(p.locator('#findings')).to_have_value('KEEP HIDDEN ROAM REPORT')
  p.locator('#reading-appearance-close').click();p.locator('#m-reading').click();expect(p.locator('#reading-viewer')).to_be_visible()
  self.assertFalse(p.locator('#reading-viewer').evaluate('e=>e.inert'));expect(p.locator('#reading-viewer')).to_have_attribute('aria-hidden','false')
  print('RESUMED CANVASES',f.evaluate("()=>({all:[...document.querySelectorAll('.cornerstone-canvas')].map(c=>[c.width,c.height]),loaded:cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports()).map(v=>({id:v.id,image:v.getCurrentImageId?.(),camera:v.getCamera()}))})"),flush=True)
  f.wait_for_function("""()=>{const viewports=cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports()).filter(v=>v.getCurrentImageId?.());return viewports.length===2&&viewports.every(v=>{const c=v.element.querySelector('canvas');if(!c?.width||!c.height)return false;const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let lo=255,hi=0;for(let i=0;i<d.length;i+=16){lo=Math.min(lo,d[i]);hi=Math.max(hi,d[i]);}return hi-lo>100;});}""",timeout=15000)
  self.assertEqual(f.url,url);self.assertEqual(self.snapshot(f),before);self.assertEqual(self.section(f),wanted);expect(f.get_by_label('작업 제목',exact=True)).to_have_value('KEEP HIDDEN ROAM TITLE');expect(p.locator('#findings')).to_have_value('KEEP HIDDEN ROAM REPORT');self.assertEqual(self.jobs(a),[])

 def test_account_03_legacy_invalid_response_and_open_draft(self):
  a,b=self.pair();p=self.login();f=self.customized(p,a);wanted=self.section(f);saved=p.request.get(self.stack.api+'/reading-appearance').json();legacy=json.loads(json.dumps(saved));legacy['sizes']['version']=5;legacy['sizes'].pop('toolbar')
  p.route('**/api/reading-appearance',lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps(legacy)));p.locator('#appearance-account-load').click();self.loaded(p);self.assertEqual(self.section(f),wanted);p.unroute('**/api/reading-appearance')
  bad=json.loads(json.dumps(saved));bad['sizes']['current']=20;bad['sizes']['toolbar']['hidden']=['Zoom'];p.route('**/api/reading-appearance',lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps(bad)));p.locator('#appearance-account-load').click();expect(p.locator('#appearance-account-status')).to_contain_text('응답을 확인할 수 없습니다');expect(p.locator('#reading-text-current')).to_have_value('12');self.assertEqual(self.section(f),wanted);p.unroute('**/api/reading-appearance')
  p.locator('#reading-appearance-close').click();self.editor(f);f.get_by_label('영상 캡처 표시',exact=True).uncheck();self.settings(p);p.locator('#appearance-account-load').click();expect(p.locator('#appearance-account-status')).to_contain_text('화면 설정을 적용하지 못했습니다');expect(p.locator('#appearance-account-save')).to_be_disabled();self.assertEqual(self.section(f),wanted);expect(f.get_by_label('영상 캡처 표시',exact=True)).not_to_be_checked()
  p.locator('#reading-appearance-close').click();f.locator('#kin-native-toolbar-cancel').click();self.settings(p);p.locator('#appearance-account-load').click();self.loaded(p)

 def test_account_04_storage_failure_keeps_live_choice_and_session_end(self):
  a,b=self.pair();p=self.login();f=self.customized(p,a);wanted=self.section(f);p.locator('#reading-toolbar-reset').click();self.assertEqual(self.section(f),BASE)
  for target in [p,f]:target.evaluate("()=>{const old=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('kin-viewer-toolbar:v1:'))throw Error('synthetic storage denial');return old.call(this,k,v)}}")
  p.locator('#appearance-account-load').click();self.loaded(p);self.assertEqual(self.section(f),wanted);expect(p.locator('#reading-toolbar-status')).to_contain_text('이 화면에만');expect(f.locator('#kin-native-toolbar-status')).to_contain_text('이 창에만')
  pending=[];p.route('**/api/reading-appearance',lambda route:pending.append(route));p.locator('#appearance-account-load').click();expect(p.locator('#appearance-account-status')).to_have_text('표시 설정 확인 중…');self.assertEqual(len(pending),1);p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(p.locator('#reading-frame')).to_have_count(0);expect(p.locator('#reading-toolbar-reset')).to_be_disabled();expect(p.locator('#appearance-account-save')).to_be_disabled()
  for route in pending:route.abort()

 def test_account_05_other_window_invalidates_late_load_without_live_change(self):
  a,b=self.pair();p=self.login();f=self.customized(p,a);wanted=self.section(f);p.locator('#reading-appearance-close').click()
  with p.context.expect_page() as opened:p.get_by_role('button',name='영상 새 창',exact=True).click()
  v=opened.value;canvas_ready(v,2);self.ready(v);self.assertEqual(self.section(v),wanted);self.account_ready(p)
  pending=[];p.route('**/api/reading-appearance',lambda route:pending.append(route));p.locator('#appearance-account-load').click();expect(p.locator('#appearance-account-status')).to_have_text('표시 설정 확인 중…')
  self.editor(v);v.locator('#kin-native-toolbar-default').click();self.applied(v);expect(p.locator('#reading-toolbar-status')).to_contain_text('다른 창');self.assertEqual(self.section(f),wanted);self.assertEqual(self.section(v),BASE);self.assertEqual(len(pending),1)
  pending.pop().fulfill(response=p.request.get(self.stack.api+'/reading-appearance'));expect(p.locator('#appearance-account-status')).to_contain_text('현재 설정이 바뀌어 적용하지 않았습니다');self.assertEqual(self.section(f),wanted)

def load_tests(loader,tests,pattern):return unittest.TestSuite(ToolbarAccountE2E(n) for n in loader.getTestCaseNames(ToolbarAccountE2E) if n.startswith('test_account_'))
if __name__=='__main__':unittest.main(verbosity=2)
