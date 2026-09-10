# coding: utf-8
"""TEST-TOOLBAR-PREF: native section editing without changing tools or work."""
import json,os,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_native_toolbar import NativeToolbarE2E,canvas_ready

BASE=['MeasurementTools','Zoom','Pan','TrackballRotate','WindowLevel','Capture','Layout','Crosshairs','MoreTools']
class ToolbarPreferencesE2E(NativeToolbarE2E):
 def section(self,f):return f.evaluate("()=>services.toolbarService.getButtonSection('primary').map(x=>x.id)")
 def editor(self,f):
  self.tools(f);expect(f.locator('#kin-native-toolbar-edit')).to_be_visible(timeout=45000);f.locator('#kin-native-toolbar-edit').click();expect(f.locator('#kin-native-toolbar-dialog')).to_be_visible()
 def customize(self,f):
  f.get_by_label('이동 표시',exact=True).uncheck()
  for _ in range(3):f.get_by_role('button',name='밝기·대조 앞으로',exact=True).click()
 def applied(self,f):f.locator('#kin-native-toolbar-apply').click();expect(f.locator('#kin-native-toolbar-dialog')).not_to_be_visible()
 def stored(self,f):return f.evaluate("()=>Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('kin-viewer-toolbar:v1:')).map(k=>[k,JSON.parse(localStorage.getItem(k))]))")

 def test_toolbar_01_draft_apply_native_controls_and_preserved_work(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a);self.tools(f);f.get_by_label('작업 제목',exact=True).fill('KEEP TOOLBAR JOB');p.locator('#findings').fill('KEEP TOOLBAR REPORT');before=self.snapshot(f);active=self.active_tools(f)
  self.editor(f);self.customize(f);self.assertEqual(self.section(f),BASE);p.keyboard.press('ArrowDown');self.assertEqual(self.snapshot(f),before);self.assertEqual(self.active_tools(f),active);p.keyboard.press('Escape');expect(f.locator('#kin-native-toolbar-dialog')).not_to_be_visible();expect(f.locator('#kin-native-toolbar-edit')).to_be_focused();self.assertEqual(self.stored(f),{})
  self.editor(f);self.customize(f);expect(f.get_by_label('확대·축소 표시',exact=True)).to_be_disabled();self.applied(f)
  wanted=['MeasurementTools','WindowLevel','Zoom','TrackballRotate','Capture','Layout','Crosshairs','MoreTools'];self.assertEqual(self.section(f),wanted);expect(f.locator('#root button[data-cy="Pan"]')).to_have_count(0);self.assertEqual(self.snapshot(f),before);self.assertEqual(self.active_tools(f),active)
  native_order=f.locator('#root button[data-cy]').evaluate_all('(buttons)=>buttons.map(b=>b.dataset.cy)');self.assertLess(native_order.index('WindowLevel'),native_order.index('Zoom'));print('NATIVE TOOL ORDER',native_order,flush=True)
  p.keyboard.press('Control+Alt+9');expect(self.zoom(f)).to_be_focused();p.keyboard.press('Enter');self.assertEqual(self.active_tools(f)['tools']['Zoom']['mode'],'Active');p.keyboard.press('Control+Alt+4');expect(p.locator('#findings')).to_be_focused();expect(p.locator('#findings')).to_have_value('KEEP TOOLBAR REPORT');expect(f.get_by_label('작업 제목',exact=True)).to_have_value('KEEP TOOLBAR JOB');self.assertEqual(self.jobs(a),[])
  self.editor(f);f.locator('#kin-native-toolbar-default').click();self.assertEqual(self.section(f),wanted);self.applied(f);self.assertEqual(self.section(f),BASE)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);self.editor(f);p.screenshot(path=str(folder/'toolbar-editor.png'));f.locator('#kin-native-toolbar-cancel').click()

 def test_toolbar_02_popup_remember_other_window_and_lifecycle(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a);self.editor(f);self.customize(f);self.applied(f);saved=self.section(f)
  with p.context.expect_page() as opened:p.get_by_role('button',name='영상 새 창',exact=True).click()
  v=opened.value;canvas_ready(v,2);self.ready(v);expect(v.locator('#kin-native-toolbar-status')).to_contain_text('기억한 도구');self.assertEqual(self.section(v),saved)
  self.editor(v);v.locator('#kin-native-toolbar-default').click();self.applied(v);self.assertEqual(self.section(v),BASE);self.assertEqual(self.section(f),saved);expect(f.locator('#kin-native-toolbar-status')).to_contain_text('현재 창 유지')
  self.editor(v);self.customize(v);self.applied(v);v.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeExit()");expect(v.locator('#kin-native-toolbar-dialog')).to_have_count(0);self.assertEqual(self.section(v),BASE)
  v.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeEnter()");self.ready(v);self.assertEqual(self.section(v),saved);expect(v.locator('#kin-native-toolbar-edit')).to_have_count(1)
  self.editor(v);v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(v.locator('#kin-native-toolbar-dialog')).to_have_count(0);expect(v.locator('#kin-native-toolbar-edit')).to_have_count(0);self.assertEqual(self.section(v),BASE)

 def test_toolbar_03_corrupt_owner_isolation_and_storage_denial(self):
  a,b=self.pair();v=self.launch(self.login(),[a]);self.ready(v);self.editor(v);self.customize(v);self.applied(v);saved=self.stored(v);self.assertEqual(len(saved),1);key=next(iter(saved))
  v.evaluate("([key,value])=>{localStorage.removeItem(key);localStorage.setItem('kin-viewer-toolbar:v1:'+JSON.stringify(['foreign','owner']),JSON.stringify(value))}",[key,saved[key]]);v.reload();canvas_ready(v,1);self.ready(v);self.assertEqual(self.section(v),BASE)
  corrupt=dict(version=1,order=BASE,hidden=['Zoom']);v.evaluate('(x)=>localStorage.setItem(x[0],JSON.stringify(x[1]))',[key,corrupt]);v.reload();canvas_ready(v,1);self.ready(v);expect(v.locator('#kin-native-toolbar-status')).to_contain_text('저장값 오류');self.assertEqual(self.section(v),BASE)
  v.evaluate("()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('kin-viewer-toolbar:v1:'))throw Error('synthetic storage denial');return original.call(this,k,v)}}");self.editor(v);self.customize(v);self.applied(v);self.assertNotEqual(self.section(v),BASE);expect(v.locator('#kin-native-toolbar-status')).to_contain_text('이 창에만');self.assertEqual(self.stored(v)[key],corrupt)

 def test_toolbar_04_external_section_change_is_not_overwritten(self):
  a,b=self.pair();v=self.launch(self.login(),[a]);self.ready(v);self.editor(v);self.customize(v);self.applied(v)
  external=list(reversed(BASE));v.evaluate("ids=>{services.toolbarService.clearButtonSection('primary');services.toolbarService.createButtonSection('primary',ids)}",external)
  expect(v.locator('#kin-native-toolbar-edit')).to_be_disabled();expect(v.locator('#kin-native-toolbar-status')).to_contain_text('도구 모음이 변경');self.assertEqual(self.section(v),external)
  v.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeExit()");self.assertEqual(self.section(v),external);expect(v.locator('#kin-native-toolbar-dialog')).to_have_count(0)

def load_tests(loader,tests,pattern):return unittest.TestSuite(ToolbarPreferencesE2E(n) for n in loader.getTestCaseNames(ToolbarPreferencesE2E) if n.startswith('test_toolbar_'))
if __name__=='__main__':unittest.main(verbosity=2)
