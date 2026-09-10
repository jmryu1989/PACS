# coding: utf-8
"""REQ-D-WORKSPACE-FLOW / RISK-D-WORKSPACE-TARGET / TEST-D-WORKSPACE-FLOW.

Visible queue order and keyboard movement must retain report/viewer ownership.
"""
import os, sys, unittest
from pathlib import Path
from playwright.sync_api import expect
from test_reading_workspace import ReadingWorkspaceE2E
from test_prior_selection import canvas_ready


class ReadingFlowE2E(ReadingWorkspaceE2E):
 def test_flow_01_navigation_follows_visible_sort(self):
  a,b=self.pair();p=self.login();self.choose(p,a)
  p.locator('#quick').fill(a.patient_id)
  expect(p.locator('#rows tr[data-uid]')).to_have_count(2)
  # Exercise both sort directions; one necessarily reverses the API order.
  for _ in range(2):
   p.locator('#heads th[data-key="date"]').click()
   order=p.locator('#rows tr[data-uid]').evaluate_all('(rs)=>rs.map(r=>r.dataset.uid)')
   p.locator('#rows tr[data-uid="'+order[0]+'"]').click()
   p.locator('#b-next').click()
   expect(p.locator('#rows tr.sel')).to_have_attribute('data-uid',order[1])
   p.locator('#b-prev').click()
   expect(p.locator('#rows tr.sel')).to_have_attribute('data-uid',order[0])

 def test_flow_02_keyboard_roundtrip_retains_report_and_viewer(self):
  a,b=self.pair();original=self.originals();p=self.login()
  p.set_viewport_size(dict(width=1680,height=1100));f=self.workspace(p,a)
  p.locator('#relrows tr[data-uid="'+b.uid+'"]').click()
  expect(p.locator('#prior-findings')).to_have_text('PRIOR '+b.uid)
  p.get_by_role('button',name='Report Editor',exact=True).click()
  p.locator('#findings').fill('KEYBOARD UNSAVED REPORT')
  p.keyboard.press('Control+Alt+ArrowRight')
  expect(p.locator('#reading-target')).to_contain_text(a.uid)
  p.keyboard.press('Control+Alt+3')
  expect(p.locator('.prior-report-pane')).to_be_focused()
  p.keyboard.press('Control+Alt+2')
  expect(p.locator('#reading-frame')).to_be_focused()
  p.keyboard.press('Control+Alt+4')
  expect(p.locator('#findings')).to_be_focused()
  expect(p.locator('#findings')).to_have_value('KEYBOARD UNSAVED REPORT')
  f.get_by_role('button',name='Comparison',exact=True).click()
  f.get_by_label('작업 제목',exact=True).fill('KEYBOARD UNSAVED VIEWER')
  canvas_ready(f,2)
  view_state="() => cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports().map(v=>({image:v.getCurrentImageId?.(),camera:v.getCamera(),voi:v.getProperties().voiRange})))"
  before_view=f.evaluate(view_state)
  p.keyboard.press('Control+Alt+ArrowRight')
  expect(p.locator('#reading-target')).to_contain_text(a.uid)
  # A shortcut dispatched inside the real OHIF document returns to the list.
  p.keyboard.press('Control+Alt+1');expect(p.locator('#quick')).to_be_focused()
  order=p.locator('#rows tr[data-uid]').evaluate_all('(rs)=>rs.map(r=>r.dataset.uid)')
  key='ArrowRight' if order.index(a.uid)==0 else 'ArrowLeft'
  p.keyboard.press('Escape')
  expect(p.get_by_role('button',name='Worklist',exact=True)).to_be_focused()
  expect(p.locator('.split > .left')).not_to_be_visible()
  p.keyboard.press('Control+Alt+'+key)
  expect(p.locator('#reading-target')).to_contain_text(b.uid)
  expect(p.locator('#reading-frame')).not_to_be_visible()
  expect(p.locator('#reading-status')).to_contain_text('저장하지 않은 작업')
  p.get_by_role('button',name='Return to Previous Viewer',exact=True).click()
  expect(p.locator('#findings')).to_have_value('KEYBOARD UNSAVED REPORT')
  expect(f.get_by_label('작업 제목',exact=True)).to_have_value('KEYBOARD UNSAVED VIEWER')
  print('RETAINED VIEWPORT STATE',dict(before=before_view,after=f.evaluate(view_state)),flush=True)
  canvas_ready(f,2)
  self.assertEqual(f.evaluate(view_state),before_view)
  self.assertEqual(self.originals(),original)
  self.assertEqual(len(self.versions(a)),1);self.assertEqual(self.jobs(a),[])
  folder=Path(os.environ.get('KIN_EVIDENCE_DIR',str(Path(__file__).parent/'artifacts')))
  folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'reading-flow.png'))

 def test_flow_03_queue_edges_filter_and_modal_guard(self):
  a,b=self.pair();p=self.login();self.workspace(p,a)
  p.keyboard.press('Control+Alt+1')
  order=p.locator('#rows tr[data-uid]').evaluate_all('(rs)=>rs.map(r=>r.dataset.uid)')
  p.locator('#rows tr[data-uid="'+order[0]+'"]').click()
  expect(p.locator('#reading-position')).to_have_text('현재 목록 1 / 2')
  expect(p.get_by_role('button',name='Previous Study',exact=True)).to_be_disabled()
  expect(p.get_by_role('button',name='Image',exact=True)).to_be_enabled(timeout=60000)
  p.keyboard.press('Control+Alt+2');expect(p.locator('#reading-frame')).to_be_focused()
  p.keyboard.press('Control+Alt+ArrowRight')
  expect(p.locator('#reading-position')).to_have_text('현재 목록 2 / 2')
  expect(p.get_by_role('button',name='Next Study',exact=True)).to_be_disabled()
  # The visible list can change without changing the active reading target.
  p.keyboard.press('Control+Alt+1');p.locator('#quick').fill('NO-SUCH-READING-FLOW-PATIENT')
  expect(p.locator('#reading-position')).to_have_text('현재 목록 0건')
  expect(p.get_by_role('button',name='Previous Study',exact=True)).to_be_disabled()
  expect(p.get_by_role('button',name='Next Study',exact=True)).to_be_disabled()
  p.locator('#quick').fill(a.patient_id);p.keyboard.press('Escape')
  current=p.locator('#reading-target').inner_text()
  p.evaluate("() => { const d=document.createElement('dialog');d.id='flow-test-dialog';d.textContent='synthetic dialog';document.body.append(d);d.showModal(); }")
  p.keyboard.press('Control+Alt+ArrowLeft');p.keyboard.press('Control+Alt+1')
  self.assertEqual(p.locator('#reading-target').inner_text(),current)
  expect(p.locator('.split > .left')).not_to_be_visible()
  p.evaluate("() => document.getElementById('flow-test-dialog').remove()")
  p.get_by_role('button',name='Study Info & Templates',exact=True).click()
  p.get_by_role('button',name='Back to Worklist',exact=True).click();p.locator('#m-reading').click()
  expect(p.get_by_role('button',name='Study Info & Templates',exact=True)).to_have_attribute('aria-expanded','false')


def load_tests(loader,tests,pattern):
 return unittest.TestSuite(ReadingFlowE2E(n) for n in loader.getTestCaseNames(ReadingFlowE2E) if n.startswith('test_flow_'))


if __name__=='__main__':
 sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
