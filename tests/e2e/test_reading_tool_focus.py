# coding: utf-8
"""TEST-WORKSPACE-TOOL-FOCUS: reach live tool controls without changing images."""
import os,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_reading_workspace import ReadingWorkspaceE2E

class ToolFocusE2E(ReadingWorkspaceE2E):
 def test_tools_01_keyboard_roundtrip_keeps_images_and_work(self):
  from test_viewer_tech_note import ViewerTechNoteE2E
  a,b=self.pair();p=self.login();p.set_viewport_size(dict(width=1680,height=1100));f=self.workspace(p,a)
  p.locator('#findings').fill('KEEP TOOL FOCUS REPORT')
  f.get_by_role('button',name='Comparison',exact=True).click();f.get_by_label('Job Title',exact=True).fill('KEEP TOOL FOCUS VIEWER')
  before=ViewerTechNoteE2E.snapshot(self,f);self.assertEqual(len(before),2);url=f.url
  p.locator('#findings').focus();p.keyboard.press('Control+Alt+7')
  measurement=f.get_by_role('button',name='Measurements',exact=True);jobs=f.get_by_role('button',name='Comparison',exact=True)
  expect(measurement).to_be_focused();expect(jobs).to_have_attribute('aria-expanded','true')
  self.assertEqual(ViewerTechNoteE2E.snapshot(self,f),before)
  p.keyboard.press('Enter');expect(measurement).to_have_attribute('aria-expanded','true')
  p.keyboard.press('Tab');expect(jobs).to_be_focused();p.keyboard.press('Enter');expect(jobs).to_have_attribute('aria-expanded','true')
  expect(f.get_by_label('Job Title',exact=True)).to_have_value('KEEP TOOL FOCUS VIEWER')
  f.get_by_label('Job Title',exact=True).focus();p.keyboard.press('Control+Alt+7');expect(measurement).to_be_focused()
  p.keyboard.press('Control+Alt+4');expect(p.locator('#findings')).to_be_focused();expect(p.locator('#findings')).to_have_value('KEEP TOOL FOCUS REPORT')
  p.locator('#reading-tools-focus').click();expect(measurement).to_be_focused()
  self.assertEqual(f.url,url);self.assertEqual(ViewerTechNoteE2E.snapshot(self,f),before);self.assertEqual(self.jobs(a),[]);self.assertEqual(len(self.versions(a)),1)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'keyboard-tool-focus.png'))

 def test_tools_02_modal_composition_and_unavailable_guard(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a);p.locator('#findings').fill('KEEP GUARDED REPORT');p.locator('#findings').focus()
  for args in [{'repeat':True},{'isComposing':True},{'shiftKey':True},{'metaKey':True}]:
   p.locator('#findings').dispatch_event('keydown',dict(key='7',code='Digit7',ctrlKey=True,altKey=True,bubbles=True,**args));expect(p.locator('#findings')).to_be_focused()
  p.locator('#reading-appearance-open').click();expect(p.locator('#reading-appearance-dialog')).to_be_visible()
  active=p.evaluate('()=>document.activeElement.id');p.keyboard.press('Control+Alt+7');self.assertEqual(p.evaluate('()=>document.activeElement.id'),active)
  p.keyboard.press('Escape');p.locator('#reading-frame').evaluate('(e)=>e.inert=true')
  p.locator('#reading-tools-focus').click();expect(p.locator('#reading-status')).to_contain_text('영상 연결을 확인');expect(p.locator('#reading-tools-focus')).to_be_focused()
  p.locator('#reading-frame').evaluate('(e)=>e.inert=false');f.locator('#kin-workspace-dock').evaluate('(e)=>e.style.setProperty("display","none","important")');expect(f.locator('#kin-workspace-dock')).not_to_be_visible()
  p.locator('#reading-tools-focus').click();expect(p.locator('#reading-status')).to_contain_text('영상 도구 연결을 확인');expect(p.locator('#findings')).to_have_value('KEEP GUARDED REPORT')
  p.locator('#reading-frame').evaluate('(e)=>Object.defineProperty(e,"contentDocument",{configurable:true,get(){throw new DOMException("blocked","SecurityError")}})')
  p.locator('#reading-tools-focus').click();expect(p.locator('#reading-tools-focus')).to_be_focused();expect(p.locator('#findings')).to_have_value('KEEP GUARDED REPORT')

def load_tests(loader,tests,pattern):return unittest.TestSuite(ToolFocusE2E(n) for n in loader.getTestCaseNames(ToolFocusE2E) if n.startswith('test_tools_'))
if __name__=='__main__':unittest.main(verbosity=2)
