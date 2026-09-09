# coding: utf-8
"""REQ-D-WORKSPACE-CONTEXT -> RISK-D-WORKSPACE-TARGET -> TEST-D-WORKSPACE-CONTEXT.

Real study information roundtrip; ER/Tech note persistence is not implemented here.
"""
import os, sys, unittest
from pathlib import Path
from playwright.sync_api import expect
from test_reading_workspace import ReadingWorkspaceE2E
from test_prior_selection import canvas_ready


class ReadingContextE2E(ReadingWorkspaceE2E):
 def test_context_identity_and_draft_roundtrip(self):
  a,b=self.pair();original=self.originals();p=self.login()
  p.set_viewport_size(dict(width=1680,height=1100));f=self.workspace(p,a)
  p.locator('#findings').fill('CONTEXT UNSAVED REPORT')
  p.keyboard.press('Control+Alt+5')
  expect(p.locator('#clinical')).to_be_focused()
  expect(p.locator('#clinical')).to_contain_text('판독 대상 검사 정보')
  expect(p.locator('#clinical')).to_contain_text(a.uid)
  p.locator('#relrows tr[data-uid="'+b.uid+'"]').click()
  expect(p.locator('#clinical')).to_contain_text('관련 검사 정보')
  expect(p.locator('#clinical')).to_contain_text(b.uid)
  expect(p.locator('#reading-report-target')).to_contain_text(a.uid)
  p.get_by_role('button',name='정보 닫고 판독문으로',exact=True).click()
  expect(p.locator('#findings')).to_be_focused()
  expect(p.locator('#findings')).to_have_value('CONTEXT UNSAVED REPORT')
  expect(p.locator('#reading-context')).not_to_be_visible()
  p.keyboard.press('Control+Alt+2');p.keyboard.press('Control+Alt+5')
  expect(p.locator('#clinical')).to_be_focused()
  p.keyboard.press('Escape')
  expect(p.get_by_role('button',name='검사 정보·상용구',exact=True)).to_be_focused()
  expect(p.locator('#reading-context')).not_to_be_visible()
  p.locator('#related-return').click();p.keyboard.press('Control+Alt+5')
  expect(p.locator('#clinical')).to_contain_text(a.uid)
  # Let queued layout/retained-viewer redraw finish before checking its pixels.
  p.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  canvas_ready(f,2)
  self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1)
  folder=Path(os.environ.get('KIN_EVIDENCE_DIR',str(Path(__file__).parent/'artifacts')))
  folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'reading-context.png'))

 def test_context_narrow_width_and_selection(self):
  a,b=self.pair();p=self.login();p.set_viewport_size(dict(width=800,height=1100));self.workspace(p,a)
  p.keyboard.press('Control+Alt+5')
  for width in [800,1100]:
   p.set_viewport_size(dict(width=width,height=1100))
   box=p.locator('.s-clinical').bounding_box();right=p.locator('.right').bounding_box()
   self.assertGreater(box['width'],300)
   self.assertLessEqual(box['width'],right['width'])
   self.assertTrue(p.locator('#clinical').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1'))
  self.choose(p,b)
  expect(p.locator('#clinical')).to_contain_text(b.uid)
  expect(p.locator('#clinical')).to_contain_text('판독 대상 검사 정보')
  p.keyboard.press('Control+Alt+4')
  expect(p.locator('#findings')).to_be_focused()
  expect(p.locator('#findings')).to_have_value('PRIOR '+b.uid)
  expect(p.locator('#reading-context')).not_to_be_visible()


def load_tests(loader,tests,pattern):
 return unittest.TestSuite(ReadingContextE2E(n) for n in loader.getTestCaseNames(ReadingContextE2E) if n.startswith('test_context_'))


if __name__=='__main__':
 sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
