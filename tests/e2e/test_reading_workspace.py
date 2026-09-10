# coding: utf-8
"""TEST-D-WORKSPACE: real embedded viewer, report identity and retained work."""
import json,re,sys,unittest,uuid
from pathlib import Path
from urllib.parse import parse_qs,urlsplit
from playwright.sync_api import expect
from test_viewer_job_report import ViewerJobReportE2E
from test_prior_selection import canvas_ready

class ReadingWorkspaceE2E(ViewerJobReportE2E):
 def pair(self):
  patient='WORKSPACE-'+uuid.uuid4().hex[:12]
  a=self.ct(patient,'current','20260801');b=self.ct(patient,'past','20260701')
  self.seed_report(a,findings='CURRENT '+a.uid);self.seed_report(b,action='approve',findings='PRIOR '+b.uid)
  return a,b

 def choose(self,p,f):
  if not p.locator('.left').is_visible():p.get_by_role('button',name='Worklist',exact=True).click()
  self.select(p,f)

 def workspace(self,p,f,count=2):
  self.choose(p,f);p.locator('#m-reading').click()
  expect(p.locator('#reading-status')).to_have_text('영상 작업공간 연결됨',timeout=60000)
  frame=p.locator('#reading-frame').element_handle().content_frame()
  canvas_ready(frame,count)
  return frame

 def shot(self,p,name):
  folder=Path(__file__).parent/'artifacts';folder.mkdir(exist_ok=True)
  p.screenshot(path=str(folder/('reading-workspace-'+name+'.png')))

 def test_workspace_01_real_comparison_report_and_separate_window(self):
  a,b=self.pair();original=self.originals();versions={f.uid:self.report_rows(f) for f in [a,b]}
  p=self.login();p.set_viewport_size(dict(width=1680,height=1100));self.choose(p,a);self.shot(p,'before')
  f=self.workspace(p,a)
  self.assertEqual(parse_qs(urlsplit(f.url).query)['StudyInstanceUIDs'],[a.uid+','+b.uid])
  expect(p.locator('#reading-target')).to_contain_text(a.uid);expect(p.locator('#reading-images')).to_contain_text(b.uid)
  expect(p.locator('#findings')).to_have_value('CURRENT '+a.uid)
  p.locator(f'#relrows tr[data-uid="{b.uid}"]').click()
  expect(p.locator('#prior-findings')).to_have_text('PRIOR '+b.uid)
  expect(p.locator('#findings')).to_have_value('CURRENT '+a.uid)
  p.get_by_role('button',name='Report Editor',exact=True).click();expect(p.locator('#findings')).to_be_focused()
  image=p.locator('#reading-frame').bounding_box();report=p.locator('.report-p').bounding_box()
  self.assertGreater(image['width'],700);self.assertGreaterEqual(report['x'],image['x']+image['width'])
  self.shot(p,'integrated')
  with p.context.expect_page() as opened:p.get_by_role('button',name='Open Viewer Window',exact=True).click()
  popup=opened.value;popup.wait_for_url('**/ohif/viewer?**');canvas_ready(popup,2)
  self.assertEqual(parse_qs(urlsplit(popup.url).query)['StudyInstanceUIDs'],[a.uid+','+b.uid]);popup.close()
  self.assertEqual(self.originals(),original);self.assertEqual({f.uid:self.report_rows(f) for f in [a,b]},versions)

 def test_workspace_02_draft_navigation_and_mode_resume(self):
  a,b=self.pair();p=self.login();p.set_viewport_size(dict(width=1680,height=1100));f=self.workspace(p,a)
  p.locator('#findings').fill('UNSAVED CURRENT WORKSPACE')
  old=p.locator('#reading-frame').get_attribute('src')
  expect(p.locator('#m-reading')).to_have_text('Back to Worklist');p.locator('#m-reading').click();expect(p.locator('#reading-viewer')).not_to_be_visible();expect(p.locator('#m-reading')).to_have_text('Reading Workspace');expect(p.locator('#m-reading')).to_be_focused()
  p.locator('#m-reading').click();expect(p.locator('#reading-frame')).to_be_visible()
  self.assertEqual(p.locator('#reading-frame').get_attribute('src'),old)
  expect(p.locator('#findings')).to_have_value('UNSAVED CURRENT WORKSPACE')
  # Derive next/previous from the actual filtered display order.
  p.get_by_role('button',name='Worklist',exact=True).click()
  order=p.locator('#rows tr[data-uid]').evaluate_all('(rows)=>rows.map(r=>r.dataset.uid)')
  i=order.index(a.uid);direction=1 if i+1<len(order) else -1;wanted=order[i+direction]
  p.get_by_role('button',name='Next Study' if direction==1 else 'Previous Study',exact=True).click()
  expect(p.locator('#reading-target')).to_contain_text(wanted)
  expect(p.locator('#reading-status')).to_have_text('영상 작업공간 연결됨',timeout=60000)
  self.choose(p,a);expect(p.locator('#findings')).to_have_value('UNSAVED CURRENT WORKSPACE')
  expect(p.locator('#reading-target')).to_contain_text(a.uid)
  self.assertEqual(len(self.versions(a)),1)

 def test_workspace_03_unsaved_viewer_hidden_and_restored(self):
  a,b=self.pair();p=self.login();p.set_viewport_size(dict(width=1680,height=1100));f=self.workspace(p,a)
  f.get_by_role('button',name='Comparison',exact=True).click()
  f.get_by_label('Job Title',exact=True).fill('KEEP UNSAVED VIEWER')
  self.choose(p,b)
  expect(p.locator('#reading-target')).to_contain_text(b.uid);expect(p.locator('#reading-frame')).not_to_be_visible()
  expect(p.locator('#reading-status')).to_contain_text('저장하지 않은 작업')
  expect(f.get_by_label('Job Title',exact=True)).to_have_value('KEEP UNSAVED VIEWER')
  p.get_by_role('button',name='Return to Previous Viewer',exact=True).click()
  expect(p.locator('#reading-target')).to_contain_text(a.uid);expect(p.locator('#reading-frame')).to_be_visible()
  expect(f.get_by_label('Job Title',exact=True)).to_have_value('KEEP UNSAVED VIEWER')
  self.choose(p,b)
  p.once('dialog',lambda dialog:dialog.dismiss())
  p.get_by_role('button',name='Discard Viewer Changes & Open',exact=True).click()
  expect(f.get_by_label('Job Title',exact=True)).to_have_value('KEEP UNSAVED VIEWER')
  p.once('dialog',lambda dialog:dialog.accept())
  p.get_by_role('button',name='Discard Viewer Changes & Open',exact=True).click()
  expect(p.locator('#reading-status')).to_have_text('영상 작업공간 연결됨',timeout=60000)
  current=p.locator('#reading-frame').element_handle().content_frame();canvas_ready(current,1)
  self.assertEqual(parse_qs(urlsplit(current.url).query)['StudyInstanceUIDs'],[b.uid])
  self.assertEqual(self.jobs(a),[]);self.assertEqual(self.jobs(b),[])

 def test_workspace_04_failed_document_retry_and_session_end(self):
  a,b=self.pair();p=self.login();self.choose(p,a)
  # Fail only the embedded document; the real report/API remains available.
  p.route('**/ohif/viewer?**',lambda route:route.abort())
  p.locator('#m-reading').click()
  expect(p.locator('#reading-status')).to_contain_text('확인하지 못했습니다',timeout=60000)
  expect(p.locator('#findings')).to_have_value('CURRENT '+a.uid)
  p.unroute('**/ohif/viewer?**')
  p.get_by_role('button',name='Reopen Viewer',exact=True).click()
  expect(p.locator('#reading-status')).to_have_text('영상 작업공간 연결됨',timeout=60000)
  f=p.locator('#reading-frame').element_handle().content_frame();canvas_ready(f,2)
  p.evaluate("() => { const c = new BroadcastChannel('kin-session'); c.postMessage({type:'session-ended'}); c.close(); }")
  expect(p.locator('#reading-frame')).to_have_count(0);expect(p.locator('#reading-viewer')).not_to_be_visible()
  self.assertEqual(self.jobs(a),[])

 def test_workspace_05_narrow_layout_and_context_controls(self):
  a,b=self.pair();p=self.login();p.set_viewport_size(dict(width=800,height=1100));f=self.workspace(p,a)
  image=p.locator('#reading-frame').bounding_box();report=p.locator('.report-p').bounding_box()
  self.assertGreater(image['width'],650);self.assertGreaterEqual(report['y'],image['y']+image['height'])
  p.get_by_role('button',name='Study Info & Templates',exact=True).click();expect(p.locator('.rw')).to_be_visible()
  p.get_by_role('button',name='Study Info & Templates',exact=True).click();expect(p.locator('.rw')).not_to_be_visible()
  p.get_by_role('button',name='Report Editor',exact=True).click();expect(p.locator('#findings')).to_be_focused()
  expect(p.locator('#findings')).to_have_value('CURRENT '+a.uid)
  self.shot(p,'narrow')

 def test_workspace_06_restore_changes_comparison_identity(self):
  a,b=self.pair();c=self.ct(a.patient_id,'older','20260601')
  source=self.launch_job([a,c]);self.grid(source,2);self.drag(source,'D03A current',0);self.drag(source,'D03A older',1);canvas_ready(source,2)
  source.get_by_label('Job Title',exact=True).fill('WORKSPACE RESTORE')
  self.click_job(source,'Save New Job','저장했습니다');saved=self.jobs(a)[0];source.close()
  p=self.login();p.set_viewport_size(dict(width=1680,height=1100));f=self.workspace(p,a)
  f.get_by_role('button',name='Comparison',exact=True).click()
  f.locator('#kin-viewer-jobs').get_by_role('button',name='Restore Job',exact=True).first.click()
  f.wait_for_url('**kinJob='+saved['id'])
  try:
   expect(f.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000)
   canvas_ready(f,2)
  except Exception:
   print('RESTORE DIAGNOSTIC',f.locator('#kin-viewer-jobs-status').inner_text(),f.locator('.cornerstone-canvas').count(),p.locator('#reading-status').inner_text(),flush=True)
   self.shot(p,'restore-failed');raise
  expect(p.locator('#reading-images')).to_contain_text(c.uid);expect(p.locator('#reading-images')).not_to_contain_text(b.uid)
  expect(p.locator('#reading-target')).to_contain_text(a.uid);expect(p.locator('#findings')).to_have_value('CURRENT '+a.uid)
  expect(f.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000)
  p.get_by_role('button',name='Back to Worklist',exact=True).click();p.locator('#m-reading').click()
  self.assertIn('kinJob='+saved['id'],f.url)
  with p.context.expect_page() as opened:p.get_by_role('button',name='Open Viewer Window',exact=True).click()
  popup=opened.value;popup.wait_for_url('**/ohif/viewer?**');canvas_ready(popup,2)
  self.assertEqual(parse_qs(urlsplit(popup.url).query)['StudyInstanceUIDs'],[a.uid+','+c.uid]);popup.close()

 def test_workspace_07_missing_jobs_asset_can_recover_or_change_study(self):
  a,b=self.pair();p=self.login();self.choose(p,a)
  p.route('**/viewer-jobs.js',lambda route:route.abort())
  p.locator('#m-reading').click()
  expect(p.locator('#reading-status')).to_contain_text('확인하지 못했습니다',timeout=60000)
  self.assertTrue(p.locator('#reading-frame').evaluate('(f)=>f.inert'))
  p.unroute('**/viewer-jobs.js');self.choose(p,b)
  expect(p.locator('#reading-status')).to_have_text('영상 작업공간 연결됨',timeout=60000)
  f=p.locator('#reading-frame').element_handle().content_frame();canvas_ready(f,1)
  expect(p.locator('#reading-images')).to_contain_text(b.uid)

def load_tests(loader,tests,pattern):return unittest.TestSuite(ReadingWorkspaceE2E(n) for n in loader.getTestCaseNames(ReadingWorkspaceE2E) if n.startswith('test_workspace_'))
if __name__=='__main__':
 sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
