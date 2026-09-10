# coding: utf-8
"""TEST-D01-COLUMN-FIT: draft fitting, related lists and existing account storage."""
import os,uuid,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_worklist_columns_roaming import ColumnsRoamingE2E

class ColumnFitE2E(ColumnsRoamingE2E):
 def width(self,p,key):return self.column(p,key).locator('.wc-width')
 def fit(self,p,key):self.column(p,key).locator('[data-fit]').click()
 def cell(self,p,uid,key):
  index=p.locator('#heads th').evaluate_all('(els,k)=>els.findIndex(e=>e.dataset.key===k)',key)
  return p.locator('#rows tr[data-uid="'+uid+'"]').locator('td').nth(index)
 def test_fit_01_related_content_account_restore_and_preserved_work(self):
  patient='FIT-'+uuid.uuid4().hex[:10];a=self.fixture(patient_id=patient);b=self.fixture(patient_id=patient)
  self.patch(a,ov={'desc':'Current short'});self.patch(b,ov={'desc':'Comparison description with longer readable text'});self.seed_report(a);self.seed_report(b,action='approve')
  p=self.login();self.select(p,a);p.locator('#quick').fill(patient);p.locator('#filterrow [data-f="desc"]').fill('Current');p.locator('#heads [data-key="desc"]').click();p.locator('#findings').fill('KEEP FIT REPORT')
  p.locator('#relrows tr[data-uid="'+b.uid+'"]').click();expect(p.locator('#relrows tr.related-selected')).to_have_attribute('data-uid',b.uid)
  before=p.evaluate('()=>({selectedUid,relatedUid,sortKey,sortDir,order:[...document.querySelectorAll("#heads th")].map(e=>e.dataset.key)})')
  self.open_columns(p);self.fit(p,'desc');expect(self.column(p,'desc').locator('[data-fit]')).to_be_focused();w=int(self.width(p,'desc').input_value());self.assertGreater(w,200);self.assertLess(w,600)
  expect(p.locator('#rows .wc-cell')).to_have_count(0);expect(p.locator('#relrows .wc-cell')).to_have_count(0)
  self.action(p,'inspect','저장된 열 설정이 없습니다');self.action(p,'save','편집값을 계정에 저장했습니다');self.assertEqual(self.remote(p)['columns']['modes']['Radiology']['appearance']['widths']['desc'],w);p.locator('#wc-save').click()
  expect(self.cell(p,a.uid,'desc').locator('.wc-cell')).to_have_css('width',str(w)+'px');related=p.locator('#relrows tr[data-uid="'+b.uid+'"] td').nth(3).locator('.wc-cell');expect(related).to_have_css('width',str(w)+'px');self.assertTrue(related.evaluate('e=>e.scrollWidth<=e.clientWidth+1'))
  self.assertEqual(p.evaluate('()=>({selectedUid,relatedUid,sortKey,sortDir,order:[...document.querySelectorAll("#heads th")].map(e=>e.dataset.key)})'),before);expect(p.locator('#filterrow [data-f="desc"]')).to_have_value('Current');expect(p.locator('#rows tr[data-uid]')).to_have_count(1);expect(p.locator('#findings')).to_have_value('KEEP FIT REPORT');self.assertEqual(len(self.versions(a)),1)
  other=self.login();self.select(other,a);self.open_columns(other);self.action(other,'load','편집창에 불러왔습니다');expect(self.width(other,'desc')).to_have_value(str(w));expect(other.locator('#relrows .wc-cell')).to_have_count(0);other.locator('#wc-save').click();expect(other.locator('#relrows .wc-cell')).to_have_css('width',str(w)+'px')
  other.locator('[data-tab="Technician"]').click();expect(other.locator('#relrows .wc-cell')).to_have_count(0);other.locator('[data-tab="Radiology"]').click();expect(other.locator('#relrows .wc-cell')).to_have_css('width',str(w)+'px')
  self.open_columns(other);self.width(other,'desc').fill('');other.locator('#wc-save').click();expect(other.locator('#relrows .wc-cell')).to_have_count(0)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'fitted-related-list.png'));print('RELATED CONTENT WIDTH',w,flush=True)
 def test_fit_02_limits_empty_cancel_and_small_screen(self):
  a=self.fixture();self.patch(a,ov={'desc':'<img src=x onerror=alert(1)> '+'W'*120});p=self.login();p.locator('#quick').fill(a.patient_id);self.open_columns(p);p.locator('#wc-fit-all').click();expect(p.locator('#wc-status')).to_contain_text('개 열의 내용');expect(self.width(p,'desc')).to_have_value('600');p.locator('#wc-save').click();expect(self.cell(p,a.uid,'desc').locator('.wc-cell')).to_have_css('width','600px');expect(self.cell(p,a.uid,'desc').locator('img')).to_have_count(0)
  self.open_columns(p);self.width(p,'desc').fill('111');p.once('dialog',lambda d:d.accept());p.locator('#wc-close').click();self.open_columns(p);expect(self.width(p,'desc')).to_have_value('600');p.locator('#wc-close').click()
  p.locator('#quick').fill('NOT-PRESENT-'+uuid.uuid4().hex);expect(p.locator('#rows tr[data-uid]')).to_have_count(0);self.open_columns(p);p.locator('#wc-fit-all').click();expect(p.locator('#wc-status')).to_contain_text('기존 너비는 유지');expect(self.width(p,'desc')).to_have_value('600')
  p.set_viewport_size({'width':400,'height':700});self.assertTrue(p.locator('#column-manager').evaluate('e=>e.scrollWidth<=e.clientWidth+1'));self.column(p,'desc').locator('[data-fit]').scroll_into_view_if_needed();expect(self.column(p,'desc').locator('[data-fit]')).to_be_in_viewport();p.locator('#wc-reset').click();p.locator('#wc-save').click()
 def test_fit_03_late_account_response_and_storage_failure(self):
  a=self.fixture();p=self.login();p.locator('#quick').fill(a.patient_id);self.open_columns(p);self.action(p,'inspect','저장된 열 설정이 없습니다');self.width(p,'desc').fill('90');self.action(p,'save','편집값을 계정에 저장했습니다');p.locator('#wc-save').click();self.open_columns(p)
  held=[];p.route('**/api/worklist-columns',lambda route:held.append((route,route.fetch())));p.locator('#wc-server-load').click();expect(p.locator('#wc-server-status')).to_contain_text('확인 중');self.fit(p,'desc');w=self.width(p,'desc').input_value();self.assertNotEqual(w,'90');self.assertEqual(len(held),1);route,response=held.pop();route.fulfill(response=response);expect(p.locator('#wc-server-status')).to_contain_text('편집값이 바뀌어');expect(self.width(p,'desc')).to_have_value(w)
  p.evaluate("()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('kin-worklist-columns:'))throw new DOMException('full','QuotaExceededError');return original.call(this,k,v)}}");p.locator('#wc-save').click();expect(p.locator('#wc-status')).to_contain_text('저장하지 못했습니다');expect(self.width(p,'desc')).to_have_value(w);p.locator('#wc-memory').click();expect(self.cell(p,a.uid,'desc').locator('.wc-cell')).to_have_css('width',w+'px')

 def test_fit_04_explicit_reading_style_precedence_survives_width_apply(self):
  a=self.fixture();p=self.login();p.locator('#quick').fill(a.patient_id);self.open_columns(p);p.locator('#wc-size').select_option('18');p.locator('#wc-font').select_option('mono');p.locator('#wc-color').select_option('warm');p.locator('#wc-save').click()
  cell=self.cell(p,a.uid,'name');expect(cell).to_have_css('font-size','18px');self.assertIn('Consolas',cell.evaluate('e=>getComputedStyle(e).fontFamily'));expect(cell).to_have_css('color','rgb(255, 230, 196)')
  p.locator('#reading-appearance-open').click();p.locator('#reading-text-list').select_option('16');p.locator('#reading-font-list').select_option('sans');p.locator('#reading-color-list').select_option('cool');p.locator('#reading-appearance-close').click()
  expect(cell).to_have_css('font-size','16px');self.assertNotIn('Consolas',cell.evaluate('e=>getComputedStyle(e).fontFamily'));expect(cell).to_have_css('color','rgb(215, 243, 255)')
  self.open_columns(p);self.fit(p,'name');p.locator('#wc-save').click();expect(cell).to_have_css('font-size','16px');expect(cell).to_have_css('color','rgb(215, 243, 255)');p.reload();expect(p.locator('#dbstat')).to_contain_text('DB Connected');expect(self.cell(p,a.uid,'name')).to_have_css('font-size','16px')
  p.locator('#reading-appearance-open').click();p.locator('#reading-appearance-reset').click();p.locator('#reading-font-reset').click();p.locator('#reading-color-reset').click();p.locator('#reading-appearance-close').click();expect(self.cell(p,a.uid,'name')).to_have_css('font-size','12px');self.assertNotIn('Consolas',self.cell(p,a.uid,'name').evaluate('e=>getComputedStyle(e).fontFamily'))

def load_tests(loader,tests,pattern):return unittest.TestSuite(ColumnFitE2E(n) for n in loader.getTestCaseNames(ColumnFitE2E) if n.startswith('test_fit_'))
if __name__=='__main__':unittest.main(verbosity=2)
