# coding: utf-8
"""TEST-NATIVE-TOOLBAR: native activation, retained work and lifecycle guards."""
import os, re, unittest
from pathlib import Path
from playwright.sync_api import expect
from test_viewer_tech_note import ViewerTechNoteE2E, canvas_ready

class NativeToolbarE2E(ViewerTechNoteE2E):
 def zoom(self,f):return f.locator('#root button[data-cy="Zoom"]')
 def active_tools(self,f):
  return f.evaluate("""()=>{const id=services.viewportGridService.getState().activeViewportId,v=services.cornerstoneViewportService.getCornerstoneViewport(id),g=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(v.id,v.getRenderingEngine().id);return {id,tools:g.toolOptions}}""")

 def test_native_01_keyboard_activate_manipulate_and_return(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a);self.tools(f)
  f.get_by_label('작업 제목',exact=True).fill('KEEP NATIVE TOOL TITLE');p.locator('#findings').fill('KEEP NATIVE REPORT')
  before=self.snapshot(f);tools=self.active_tools(f);p.keyboard.press('Control+Alt+9');expect(self.zoom(f)).to_be_focused()
  self.assertEqual(self.snapshot(f),before);self.assertEqual(self.active_tools(f),tools)
  self.assertEqual(self.zoom(f).evaluate('e=>getComputedStyle(e).outlineStyle'),'solid')
  p.keyboard.press('Tab');self.assertTrue(f.evaluate("()=>document.activeElement.matches('#root button[data-cy]')"));self.assertNotEqual(f.evaluate("()=>document.activeElement.dataset.cy"),'Zoom')
  p.keyboard.press('Shift+Tab');expect(self.zoom(f)).to_be_focused();p.keyboard.press('Enter');self.assertEqual(self.active_tools(f)['tools']['Zoom']['mode'],'Active')
  box=f.locator('.cornerstone-canvas').first.bounding_box();x,y=box['x']+box['width']*.5,box['y']+box['height']*.5
  p.mouse.move(x,y);p.mouse.down();p.mouse.move(x,y+40,steps=10);p.mouse.up();canvas_ready(f,2)
  after=self.snapshot(f);self.assertNotEqual(after[0]['camera']['parallelScale'],before[0]['camera']['parallelScale']);self.assertEqual(after[1],before[1])
  p.keyboard.press('Control+Alt+4');expect(p.locator('#findings')).to_be_focused();expect(p.locator('#findings')).to_have_value('KEEP NATIVE REPORT');expect(f.get_by_label('작업 제목',exact=True)).to_have_value('KEEP NATIVE TOOL TITLE')
  p.locator('#reading-native-tools-focus').click();expect(self.zoom(f)).to_be_focused();self.assertEqual(self.snapshot(f),after);self.assertEqual(self.jobs(a),[])
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'native-toolbar-focus.png'))

 def test_native_02_modal_modifiers_and_missing_target(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a);field=p.locator('#findings');field.fill('GUARDED NATIVE REPORT')
  for flags in [{'repeat':True},{'isComposing':True},{'shiftKey':True},{'metaKey':True}]:
   prevented=field.evaluate("""(e,flags)=>{const k=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,code:'Digit9',key:'9',ctrlKey:true,altKey:true,...flags});e.dispatchEvent(k);return k.defaultPrevented}""",flags)
   self.assertFalse(prevented);expect(field).to_be_focused()
  f.evaluate("""()=>{window.nativeModal=document.createElement('dialog');nativeModal.innerHTML='<input aria-label="Modal field">';document.body.append(nativeModal);nativeModal.showModal()}""")
  p.keyboard.press('Control+Alt+9');expect(f.get_by_label('Modal field')).to_be_focused();f.evaluate('()=>{nativeModal.close();nativeModal.remove()}')
  field.focus();self.zoom(f).evaluate("e=>e.hidden=true")
  try:p.keyboard.press('Control+Alt+9');expect(field).to_be_focused();expect(p.locator('#reading-status')).to_contain_text('기본 영상 도구 연결')
  finally:self.zoom(f).evaluate('e=>e.hidden=false')
  p.keyboard.press('Control+Alt+9');expect(self.zoom(f)).to_be_focused();expect(field).to_have_value('GUARDED NATIVE REPORT')

 def test_native_03_popup_return_and_mode_cleanup(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a);p.locator('#findings').fill('KEEP POPUP NATIVE REPORT')
  with p.context.expect_page() as opened:p.get_by_role('button',name='영상 새 창',exact=True).click()
  v=opened.value;canvas_ready(v,2);self.ready(v);before=self.snapshot(v)
  v.keyboard.press('Control+Alt+9');expect(self.zoom(v)).to_be_focused();self.assertEqual(self.snapshot(v),before)
  v.keyboard.press('Control+Alt+4');expect(v.locator('#kin-viewer-return-status')).to_have_text(re.compile(r'판독문으로 돌아왔습니다\.|판독문 위치를 준비했습니다\. 목록 창을 선택하세요\.'));expect(p.locator('#findings')).to_have_value('KEEP POPUP NATIVE REPORT')
  v.evaluate("()=>{window.oldNativeFocus=kinViewerFocusNativeToolbar;window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeExit()}")
  self.assertFalse(v.evaluate("()=>typeof kinViewerFocusNativeToolbar==='function'"));self.assertFalse(v.evaluate('()=>oldNativeFocus()'));expect(self.zoom(v)).not_to_have_attribute('aria-label','확대·축소')
  v.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeEnter()");self.ready(v);v.locator('#kin-viewer-focus-9').click();expect(self.zoom(v)).to_be_focused();self.assertEqual(self.snapshot(v),before)
  v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(v.locator('#kin-viewer-focus-9')).to_be_disabled();self.assertFalse(v.evaluate("()=>typeof kinViewerFocusNativeToolbar==='function'"))

def load_tests(loader,tests,pattern):return unittest.TestSuite(NativeToolbarE2E(n) for n in loader.getTestCaseNames(NativeToolbarE2E) if n.startswith('test_native_'))
if __name__=='__main__':unittest.main(verbosity=2)
