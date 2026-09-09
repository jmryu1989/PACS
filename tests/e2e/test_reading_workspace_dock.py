"""TEST-D-WORKSPACE-DOCK: actual pixels, reserved space and live save controls."""
import sys,unittest,math
from pathlib import Path
from playwright.sync_api import expect
from test_reading_workspace import ReadingWorkspaceE2E
from test_prior_selection import canvas_ready

class ReadingDockE2E(ReadingWorkspaceE2E):
 def bounds(self,f):
  dock=f.locator('#kin-workspace-dock').bounding_box()
  for canvas in f.locator('.cornerstone-canvas').all():
   r=canvas.bounding_box();self.assertLessEqual(r['y']+r['height'],dock['y']+1)
   self.assertGreater(r['height'],50)
  self.assertLessEqual(dock['x']+dock['width'],f.evaluate('innerWidth')+1)

 def test_dock_01_resize_switch_and_retained_job_save(self):
  a,b=self.pair();original=self.originals();p=self.login();p.set_viewport_size(dict(width=1680,height=1100));f=self.workspace(p,a)
  self.bounds(f)
  job=f.get_by_role('button',name='비교 작업·배치',exact=True);history=f.get_by_role('button',name='측정·주석',exact=True)
  expect(job).to_have_attribute('aria-expanded','false')
  job.click();f.get_by_label('작업 제목',exact=True).fill('DOCK RETAINED JOB')
  self.bounds(f);canvas_ready(f,2)
  history.click();expect(f.locator('#kin-viewer-history')).to_be_visible();expect(f.locator('#kin-viewer-layout')).not_to_be_visible()
  history.click();expect(history).to_have_attribute('aria-expanded','false');self.bounds(f)
  p.set_viewport_size(dict(width=800,height=1100));job.click();self.bounds(f);canvas_ready(f,2)
  expect(f.get_by_label('작업 제목',exact=True)).to_have_value('DOCK RETAINED JOB')
  p.set_viewport_size(dict(width=1680,height=1100));self.bounds(f);canvas_ready(f,2)
  self.click_job(f,'새 비교 작업 저장','저장했습니다')
  self.assertEqual(self.jobs(a)[0]['title'],'DOCK RETAINED JOB')
  folder=Path(__file__).parent/'artifacts';folder.mkdir(exist_ok=True)
  p.screenshot(path=str(folder/'reading-dock-expanded.png'))
  job.click();p.screenshot(path=str(folder/'reading-dock-collapsed.png'))
  self.assertEqual(self.originals(),original)

 def test_dock_02_hidden_unsaved_work_still_blocks_navigation(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a)
  job=f.get_by_role('button',name='비교 작업·배치',exact=True);job.click()
  f.get_by_label('작업 제목',exact=True).fill('HIDDEN UNSAVED');job.click()
  self.choose(p,b);expect(p.locator('#reading-frame')).not_to_be_visible()
  expect(p.locator('#reading-status')).to_contain_text('저장하지 않은 작업')
  p.get_by_role('button',name='이전 영상 작업으로 돌아가기',exact=True).click()
  job.click();expect(f.get_by_label('작업 제목',exact=True)).to_have_value('HIDDEN UNSAVED')
  self.assertEqual(self.jobs(a),[])

 def test_dock_03_measurement_after_panel_and_canvas_resize(self):
  a,b=self.pair();original=self.originals();p=self.login();p.set_viewport_size(dict(width=1680,height=1100));f=self.workspace(p,a)
  history=f.get_by_role('button',name='측정·주석',exact=True);history.click()
  f.get_by_role('button',name='수동 길이',exact=True).click()
  box=f.locator('.cornerstone-canvas').first.bounding_box()
  x,y=box['x']+box['width']*.4,box['y']+box['height']*.4
  p.mouse.move(x,y);p.mouse.down();p.mouse.move(x+60,y+30,steps=10);p.mouse.up()
  f.wait_for_function("()=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName==='Length'&&!a.invalidated&&Object.keys(a.data.cachedStats||{}).length)")
  measurement=f.evaluate("()=>{const a=cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='Length');return {points:a.data.handles.points,length:Object.values(a.data.cachedStats)[0].length}}")
  self.assertAlmostEqual(measurement['length'],math.dist(*measurement['points']),places=5)
  row=f.locator('#kin-viewer-history section[data-kind=length]');row.get_by_label('주석 문구').fill('DOCK LENGTH')
  history.click();history.click();expect(row.get_by_label('주석 문구')).to_have_value('DOCK LENGTH')
  row.get_by_role('button',name='저장',exact=True).click();expect(row).to_contain_text('저장 완료')
  self.bounds(f);canvas_ready(f,2);self.assertEqual(self.originals(),original)

def load_tests(loader,tests,pattern):return unittest.TestSuite(ReadingDockE2E(n) for n in loader.getTestCaseNames(ReadingDockE2E) if n.startswith('test_dock_'))
if __name__=='__main__':
 sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
