# coding: utf-8
"""REQ-D01-FAVORITE-LIST: scope, report-safe navigation and failed/late refresh."""
import json,os,unittest,uuid
from pathlib import Path
from playwright.sync_api import expect
from test_favorites import FavoritesE2E

class FavoriteListE2E(FavoritesE2E):
 def prepare(self):
  a=self.fixture();b=self.fixture(patient_id=a.patient_id);c=self.fixture(patient_id=a.patient_id)
  for f in [a,b,c]:self.seed_report(f)
  s=self.account();fid=str(uuid.uuid4());s=self.change(self.body(s,'create',fid,name='SYNTHETIC <list>'))
  for f in [a,c]:s=self.change(self.body(s,'add',fid,uid=f.uid))
  p=self.login();self.select(p,b);return a,b,c,s,fid,p
 def apply(self,p):
  p.locator('#favorite-open').click();expect(p.locator('#favorite-apply')).to_be_enabled();p.locator('#favorite-apply').click()
  expect(p.locator('#favorite-dialog')).not_to_be_visible();expect(p.locator('#filterlist')).to_contain_text('즐겨찾기: SYNTHETIC <list>')
 def test_favorite_list_01_filter_navigation_report_and_clear(self):
  a,b,c,s,fid,p=self.prepare();p.locator('#findings').fill('KEEP OUTSIDE FILTER REPORT');self.apply(p)
  expect(p.locator('#rows tr[data-uid]')).to_have_count(2);expect(p.locator('#rows tr.sel')).to_have_count(0)
  expect(p.locator('#findings')).to_have_value('KEEP OUTSIDE FILTER REPORT');expect(p.locator('#quick')).to_have_value(a.patient_id)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'favorite-list.png'))
  p.locator('#heads th[data-key="date"]').click();order=p.locator('#rows tr[data-uid]').evaluate_all('(rs)=>rs.map(r=>r.dataset.uid)')
  self.assertEqual(set(order),{a.uid,c.uid});p.locator(f'#rows tr[data-uid="{order[0]}"]').click();p.locator('#b-next').click()
  expect(p.locator('#rows tr.sel')).to_have_attribute('data-uid',order[1]);p.locator('#b-prev').click();expect(p.locator('#rows tr.sel')).to_have_attribute('data-uid',order[0])
  p.locator('#quick').fill('NO FAVORITE MATCH');expect(p.locator('#rows tr[data-uid]')).to_have_count(0);expect(p.locator('#favorite-clear')).to_be_visible()
  p.locator('#quick').fill(a.patient_id);p.locator('#favorite-clear').click();expect(p.locator('#rows tr[data-uid]')).to_have_count(3)
  p.locator(f'#rows tr[data-uid="{b.uid}"]').click();expect(p.locator('#findings')).to_have_value('KEEP OUTSIDE FILTER REPORT')
  self.apply(p);p.locator('#clearfilter').click();expect(p.locator('#favorite-clear')).not_to_be_visible();expect(p.locator('#filterlist')).not_to_contain_text('즐겨찾기:')
  self.assertEqual(len(self.versions(b)),1)
 def test_favorite_list_02_refresh_failure_recovery_and_delete(self):
  a,b,c,s,fid,p=self.prepare();self.apply(p)
  s=self.change(self.body(s,'remove',fid,uid=c.uid));p.locator('#refresh').click();expect(p.locator('#rows tr[data-uid]')).to_have_count(1)
  p.route('**/api/favorite-folders',lambda r:r.fulfill(status=503,content_type='application/json',body=json.dumps({'message':'SYNTHETIC failure'})))
  p.locator('#refresh').click();expect(p.locator('#filterlist')).to_contain_text('확인 실패');expect(p.locator('#rows tr[data-uid]')).to_have_count(0)
  p.unroute('**/api/favorite-folders');p.locator('#refresh').click();expect(p.locator('#rows tr[data-uid]')).to_have_count(1);expect(p.locator('#filterlist')).not_to_contain_text('확인 실패')
  self.change(self.body(s,'delete',fid));p.locator('#refresh').click();expect(p.locator('#filterlist')).to_contain_text('폴더가 삭제되었습니다');expect(p.locator('#rows tr[data-uid]')).to_have_count(0)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'deleted-scope.png'))
  p.locator('#favorite-clear').click();expect(p.locator('#rows tr[data-uid]')).to_have_count(3)
 def test_favorite_list_03_late_refresh_cannot_restore_cleared_scope(self):
  a,b,c,s,fid,p=self.prepare();self.apply(p);waiting=[]
  p.route('**/api/favorite-folders',lambda r:waiting.append(r))
  # Route arrival is observed through the captured request, not an arbitrary sleep.
  with p.expect_request('**/api/favorite-folders') as request:
   p.locator('#refresh').click()
  p.locator('#favorite-clear').click();expect(p.locator('#rows tr[data-uid]')).to_have_count(3)
  for route in waiting:route.fulfill(status=200,content_type='application/json',body=json.dumps(s))
  expect(p.locator('#favorite-clear')).not_to_be_visible();expect(p.locator('#filterlist')).not_to_contain_text('즐겨찾기:');expect(p.locator('#rows tr[data-uid]')).to_have_count(3)


 def test_favorite_list_04_owner_change_hides_scope_and_rows(self):
  a,b,c,s,fid,p=self.prepare();self.apply(p)
  s['owner']=['hallym',str(uuid.uuid4())];s['folders'][0]['name']='OTHER OWNER SECRET'
  p.route('**/api/favorite-folders',lambda r:r.fulfill(status=200,content_type='application/json',body=json.dumps(s)))
  p.locator('#refresh').click();expect(p.locator('#filterlist')).to_contain_text('계정 확인 필요');expect(p.locator('#rows tr[data-uid]')).to_have_count(0)
  expect(p.locator('#filterlist')).not_to_contain_text('SYNTHETIC <list>');expect(p.locator('body')).not_to_contain_text('OTHER OWNER SECRET')

def load_tests(loader,tests,pattern):
 return unittest.TestSuite(FavoriteListE2E(n) for n in loader.getTestCaseNames(FavoriteListE2E) if n.startswith('test_favorite_list_'))
if __name__=='__main__':unittest.main(verbosity=2)
