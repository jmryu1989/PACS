# coding: utf-8
"""An initial saved-job restoration must still yield to real user interaction."""
import sys,unittest
from playwright.sync_api import expect
from test_reading_workspace import ReadingWorkspaceE2E
from test_prior_selection import canvas_ready

class ReadingWorkspaceGuardE2E(ReadingWorkspaceE2E):
 def test_initial_restore_yields_to_user_input(self):
  a,b=self.pair();c=self.ct(a.patient_id,'older','20260601')
  saved=self.post(a,self.command([a,c]));p=self.login();p.set_viewport_size(dict(width=1680,height=1100));f=self.workspace(p,a)
  held=[];pattern='**/api/studies/'+a.uid+'/viewer-jobs/'+saved['id']
  def hold(route):
   if 'kinJob=' in route.request.frame.url:held.append((route,route.fetch()))
   else:route.continue_()
  p.route(pattern,hold)
  f.get_by_role('button',name='Comparison',exact=True).click()
  f.locator('#kin-viewer-jobs').get_by_role('button',name='이 작업 복원',exact=True).first.click()
  f.wait_for_url('**kinJob='+saved['id'])
  for _ in range(200):
   if held:break
   p.wait_for_timeout(50)
  self.assertTrue(held);canvas_ready(f,1)
  expect(p.locator('#reading-status')).to_have_text('영상 작업공간 연결됨')
  f.locator('.cornerstone-canvas').first.click();p.keyboard.press('ArrowDown');p.wait_for_timeout(150)
  changed=self.display(f)
  held[0][0].fulfill(response=held[0][1])
  expect(f.locator('#kin-viewer-jobs-status')).to_contain_text('영상 조작이 변경',timeout=45000)
  self.assertEqual(self.display(f),changed)
  expect(p.locator('#reading-target')).to_contain_text(a.uid)

def load_tests(loader,tests,pattern):return unittest.TestSuite([ReadingWorkspaceGuardE2E('test_initial_restore_yields_to_user_input')])
if __name__=='__main__':
 sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
