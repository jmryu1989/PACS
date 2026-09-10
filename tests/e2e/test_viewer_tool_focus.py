# coding: utf-8
"""TEST-VIEWER-TOOL-FOCUS: standalone controls and image focus preserve loaded work."""
import os,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_viewer_tech_note import ViewerTechNoteE2E,canvas_ready

class ViewerToolFocusE2E(ViewerTechNoteE2E):
 def test_tool_01_standalone_tools_image_and_edit_roundtrip(self):
  a,b=self.pair();p=self.login();self.workspace(p,a);p.locator('#findings').fill('KEEP PARENT REPORT')
  with p.context.expect_page() as opened:p.get_by_role('button',name='Open Viewer Window',exact=True).click()
  v=opened.value;canvas_ready(v,2);self.ready(v);self.active(v,a.uid);self.assertTrue(v.evaluate('()=>window.opener===null'))
  v.locator('#kin-viewer-layout').evaluate('(e)=>e.open=true');v.get_by_label('Job Title',exact=True).fill('KEEP STANDALONE TOOLS')
  before=self.snapshot(v);self.assertEqual(len(before),2);url=v.url
  measurement=v.locator('#kin-workspace-dock nav button[aria-controls="kin-viewer-history"]');comparison=v.locator('#kin-workspace-dock nav button[aria-controls="kin-viewer-layout"]')
  v.keyboard.press('Control+Alt+7');expect(measurement).to_be_focused()
  initial=measurement.get_attribute('aria-expanded');v.keyboard.press('Enter');self.assertNotEqual(measurement.get_attribute('aria-expanded'),initial)
  v.keyboard.press('Control+Alt+8');expect(comparison).to_be_focused()
  v.keyboard.press('Control+Alt+2');self.assertTrue(v.evaluate('()=>cornerstone.getRenderingEngines().some(e=>e.getViewports().some(v=>v.element===document.activeElement))'))
  self.tools(v);v.locator('#kin-viewer-focus-7').click();expect(measurement).to_be_focused()
  expect(v.get_by_label('Job Title',exact=True)).to_have_value('KEEP STANDALONE TOOLS');expect(p.locator('#findings')).to_have_value('KEEP PARENT REPORT');self.assertEqual(v.url,url);self.assertEqual(self.snapshot(v),before);self.assertEqual(self.jobs(a),[])
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);v.screenshot(path=str(folder/'standalone-tool-focus.png'))

 def test_tool_02_modal_modified_keys_and_session_end(self):
  a,b=self.pair();v=self.launch(self.login(),[a]);self.ready(v);self.active(v,a.uid);v.locator('#kin-viewer-layout').evaluate('(e)=>e.open=true');field=v.get_by_label('Job Title',exact=True);field.fill('KEEP INPUT');field.focus()
  for args in [{'repeat':True},{'isComposing':True},{'shiftKey':True},{'metaKey':True}]:
   field.dispatch_event('keydown',dict(key='7',code='Digit7',ctrlKey=True,altKey=True,bubbles=True,**args));expect(field).to_be_focused()
  self.open_note(v);active=v.evaluate('()=>document.activeElement.id');v.keyboard.press('Control+Alt+7');self.assertEqual(v.evaluate('()=>document.activeElement.id'),active)
  v.locator('#tech-note-close').click();v.locator('#kin-workspace-dock nav button[aria-controls="kin-viewer-history"]').evaluate('(e)=>e.style.display="none"');v.locator('#kin-viewer-focus-7').click();expect(v.locator('#kin-viewer-note-status')).to_contain_text('영상 도구 연결을 확인')
  expect(field).to_have_value('KEEP INPUT')
  v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(v.locator('#kin-viewer-focus-7')).to_be_disabled();expect(v.locator('#kin-viewer-layout')).not_to_be_visible();v.locator('body').evaluate('(e)=>{e.tabIndex=-1;e.focus()}');v.keyboard.press('Control+Alt+8');expect(v.locator('body')).to_be_focused();expect(field).to_have_value('')

def load_tests(loader,tests,pattern):return unittest.TestSuite(ViewerToolFocusE2E(n) for n in loader.getTestCaseNames(ViewerToolFocusE2E) if n.startswith('test_tool_'))
if __name__=='__main__':unittest.main(verbosity=2)
