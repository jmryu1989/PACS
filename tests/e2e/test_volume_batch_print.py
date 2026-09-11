# coding: utf-8
"""TEST-VOLUME-BATCH-PRINT: fresh-source saved reconstruction and output."""
import unittest
from pathlib import Path
from unittest.mock import patch
from pypdf import PdfReader
from playwright.sync_api import expect
from test_volume_batch_scout import VolumeBatchScoutE2E
import test_volume_projection as projection

class VolumeBatchPrintE2E(VolumeBatchScoutE2E):
 def open_batch_print(self,v):
  v.get_by_role('button',name='Print Saved Images',exact=True).first.click()
  v.wait_for_function("()=>{const t=document.querySelector('#kin-job-print [role=status]')?.textContent;return t&&t!=='저장한 영상 상태를 확인하는 중…'}",timeout=120000)
  expect(v.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=1000)
  return v.frame_locator('#kin-job-print iframe')
 def print_pixels(self,paper):
  return paper.locator('.cell img').evaluate_all("""async images=>Promise.all(images.map(async img=>{await img.decode();const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);let hash=2166136261;for(const b of ctx.getImageData(0,0,c.width,c.height).data)hash=Math.imul(hash^b,16777619);return {width:c.width,height:c.height,pixel:Array.from(ctx.getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data),hash:hash>>>0}}))""")
 def test_batch_print_01_saved_pixels_and_original_preservation(self):
  a,p,v=self.batch_start();self.make_batch(v);expected=self.pixels(v);self.save_volume(v);job=self.get_volume_job(a);before=self.volume_state(v);original=self.originals();p.locator('#findings').fill('KEEP BATCH PRINT DRAFT')
  v.evaluate("""()=>{window.printPrivateImages=[];window.printPrivateVolumes=[];for(const [method,list] of [['putImageSync',printPrivateImages],['putVolumeSync',printPrivateVolumes]]){const fn=cornerstone.cache[method];cornerstone.cache[method]=function(id,...args){if(id.startsWith('kin-batch-print-'))list.push(id);return fn.call(this,id,...args)}}}""")
  paper=self.open_batch_print(v);actual=self.print_pixels(paper);print('BATCH_PRINT_PIXELS',{'expected':expected,'actual':actual},flush=True);self.assertEqual(actual,expected)
  expect(paper.locator('.cell')).to_have_count(3);expect(paper.locator('.batch-reference line')).to_have_count(3);expect(paper.locator('main')).to_contain_text(job['id']);expect(paper.locator('main')).to_contain_text('no original SOP for this plane')
  self.assertTrue(v.evaluate("()=>printPrivateImages.length===33&&printPrivateVolumes.length===1&&printPrivateImages.every(id=>!cornerstone.cache.getImageLoadObject(id)&&!cornerstone.metaData.get('imagePlaneModule',id))&&printPrivateVolumes.every(id=>!cornerstone.cache.getVolume(id))"))
  self.preserved_volume(before,self.volume_state(v));expect(p.locator('#findings')).to_have_value('KEEP BATCH PRINT DRAFT');self.assertEqual(self.originals(),original);self.assertEqual(len(self.jobs(a)),1);self.assertEqual(len(self.versions(a)),1)
  folder=Path('../tmp/volume-batch-print');folder.mkdir(parents=True,exist_ok=True);v.screenshot(path=str(folder/'batch-print-preview.png'))
 def test_batch_print_02_oblique_average_reverse_read_only_dpr(self):
  a,p,v=self.batch_start();self.rotate_planes(v,0,25);self.rotate_planes(v,1,-35);self.project(v,3,20);v.evaluate('()=>{projectionVP.setProperties({invert:true});projectionVP.setCamera({flipHorizontal:true,flipVertical:true});projectionVP.render()}');v.wait_for_timeout(250)
  v.get_by_label('Batch Reverse',exact=True).check();self.make_batch(v,offset=1,interval=1,count=3);expected=self.pixels(v);self.save_volume(v);job=self.get_volume_job(a)
  create=self.browser.new_context
  with patch.object(self.browser,'new_context',side_effect=lambda **options:create(**dict(options,device_scale_factor=1.5,viewport={'width':1400,'height':950}))):fresh=self.login('tech')
  self.launch(fresh,[a]);self.ready(fresh);fresh.get_by_label('Job Author',exact=True).select_option('false');expect(fresh.get_by_role('button',name='Save New Job',exact=True)).to_be_disabled()
  paper=self.open_batch_print(fresh);actual=self.print_pixels(paper);print('BATCH_PRINT_OBLIQUE',{'expected':expected,'actual':actual},flush=True);self.assertEqual(actual,expected);expect(paper.locator('main')).to_contain_text('Average 20 mm');expect(paper.locator('main')).to_contain_text('Reverse');self.assertEqual(fresh.evaluate('devicePixelRatio'),1.5);self.assertEqual(self.get_volume_job(a)['snapshot'],job['snapshot'])
 def test_batch_print_03_multipage_pdf_identity_and_all_planes(self):
  a,p,v=self.batch_start();self.make_batch(v,offset=-12,interval=3,count=9);self.save_volume(v);job=self.get_volume_job(a);p.locator('#findings').fill('KEEP BATCH PRINT DRAFT');paper=self.open_batch_print(v);expect(paper.locator('[data-batch-plane]')).to_have_count(9)
  report=self.stack.request('GET',f'/studies/{a.uid}/report-preview','doctor').body['report'];v.get_by_label('함께 출력할 판독문',exact=True).select_option('saved');expect(v.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=120000);expect(paper.locator('[data-report-field=findings]')).to_have_text(report['findings'])
  v.evaluate("""()=>{const open=window.open;window.open=(...args)=>{const w=open(...args);if(w)w.print=()=>w.__printCalled=true;return w}}""")
  with v.expect_popup() as opened:v.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF',exact=True).click()
  printed=opened.value;printed.wait_for_function('()=>window.__printCalled===true',timeout=60000);path=Path('../tmp/volume-batch-print/batch-output.pdf');printed.pdf(path=str(path),prefer_css_page_size=True);pdf=PdfReader(path);self.assertGreaterEqual(len(pdf.pages),2)
  text='\n'.join(page.extract_text() for page in pdf.pages)
  for page in pdf.pages:self.assertIn(a.patient_id,page.extract_text())
  for i in range(1,10):self.assertEqual(text.count('Plane '+str(i)+' / 9'),1)
  self.assertIn(job['id'],text);self.assertNotIn('KEEP BATCH PRINT DRAFT',text);print('BATCH_PRINT_PDF',{'pages':len(pdf.pages),'planes':9},flush=True)
 def test_batch_print_04_changed_job_blocks_print_then_retry(self):
  a,p,v=self.batch_start();self.make_batch(v);self.save_volume(v);job=self.get_volume_job(a);self.open_batch_print(v)
  def revise(revision,hidden):
   r=self.stack.request('POST',f'/studies/{a.uid}/viewer-jobs/{job["id"]}/revisions','doctor',dict(expectedRevision=revision,title=job['title'],description=job['description'],hidden=hidden,reason='Synthetic output revision'));self.assertEqual(r.status,200)
  revise(1,True)
  v.evaluate("""()=>{window.batchPrintCalls=0;const open=window.open;window.open=(...args)=>{const w=open(...args);window.lastBatchPrint=w;if(w)w.print=()=>batchPrintCalls++;return w}}""")
  v.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF',exact=True).click();v.wait_for_function('()=>window.lastBatchPrint?.closed===true',timeout=60000);self.assertEqual(v.evaluate('()=>batchPrintCalls'),0);expect(v.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF',exact=True)).to_be_disabled()
  revise(2,False);v.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click();expect(v.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=120000);self.assertEqual(len(self.jobs(a)),1)
 def test_batch_print_05_missing_asset_retry_and_low_memory(self):
  a,p,v=self.batch_start();self.make_batch(v);self.save_volume(v);pattern='**/viewer-volume-job-print.js';v.route(pattern,lambda r:r.abort());v.get_by_role('button',name='Print Saved Images',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('출력 화면을 불러오지 못했습니다');expect(v.get_by_role('button',name='Restore Job',exact=True)).to_be_enabled();v.unroute(pattern)
  v.evaluate('()=>{window.printAvailable=cornerstone.cache.getBytesAvailable;cornerstone.cache.getBytesAvailable=()=>0}');v.get_by_role('button',name='Print Saved Images',exact=True).click();expect(v.locator('#kin-job-print [role=status]')).to_contain_text('메모리가 부족합니다',timeout=120000);expect(v.locator('[data-kin-batch-print-render]')).to_have_count(0)
  v.evaluate('()=>cornerstone.cache.getBytesAvailable=printAvailable');v.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click();expect(v.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=120000);self.assertEqual(len(self.jobs(a)),1)
 def test_batch_print_06_cancel_delayed_source_and_renderer_failure(self):
  a,p,v=self.batch_start();self.make_batch(v);self.save_volume(v);before=self.volume_state(v)
  v.evaluate("""()=>{window.printFetch=window.fetch;window.printHeld=[];window.fetch=async(...args)=>{const response=await printFetch(...args);if(String(args[0]).endsWith('/frames/0/image-uint16'))await new Promise(resolve=>printHeld.push({resolve,signal:args[1].signal}));return response}}""")
  v.get_by_role('button',name='Print Saved Images',exact=True).click();v.wait_for_function('()=>printHeld.length>0');v.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click()
  self.assertTrue(v.evaluate('()=>printHeld.every(p=>p.signal.aborted)'));v.evaluate('()=>{window.fetch=printFetch;for(const p of printHeld)p.resolve()}');v.wait_for_timeout(200);expect(v.locator('#kin-job-print')).not_to_be_visible();self.preserved_volume(before,self.volume_state(v))
  v.evaluate("""()=>{const original=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(callback,...args){if(this.closest('[data-kin-batch-print-render]')){HTMLCanvasElement.prototype.toBlob=original;callback(null);return}return original.call(this,callback,...args)}}""")
  v.get_by_role('button',name='Print Saved Images',exact=True).click();expect(v.locator('#kin-job-print [role=status]')).to_contain_text('출력 단면을 만들지 못했습니다',timeout=120000);expect(v.locator('[data-kin-batch-print-render]')).to_have_count(0);expect(v.locator('[data-kin-batch-scout-render]')).to_have_count(0)
  v.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click();expect(v.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=120000);self.preserved_volume(before,self.volume_state(v));self.assertEqual(len(self.jobs(a)),1)
 def test_batch_print_09_capacity_message_before_pixels(self):
  a,p,v=self.batch_start();self.make_batch(v);self.save_volume(v);requests=[];v.on('request',lambda r:requests.append(r.url) if '/frames/0/image-' in r.url else None)
  def large(route):
   response=route.fetch();value=response.json();value.update(Rows='1024',Columns='1024');route.fulfill(response=response,json=value)
  v.route('**/simplified-tags',large);v.get_by_role('button',name='Print Saved Images',exact=True).click();expect(v.locator('#kin-job-print [role=status]')).to_contain_text('출력 CT 원본 크기가 한도를 초과했습니다',timeout=120000);self.assertEqual(requests,[]);expect(v.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF',exact=True)).to_be_disabled()
 def test_batch_print_10_single_flip_mip_dpr125(self):
  a,p,v=self.batch_start();self.project(v,1,20);v.evaluate('()=>{projectionVP.setCamera({flipHorizontal:true});projectionVP.render()}');self.make_batch(v,offset=1,interval=1,count=3);expected=self.pixels(v);self.save_volume(v)
  create=self.browser.new_context
  with patch.object(self.browser,'new_context',side_effect=lambda **options:create(**dict(options,device_scale_factor=1.25,viewport={'width':1400,'height':950}))):fresh=self.login()
  self.launch(fresh,[a]);self.ready(fresh);paper=self.open_batch_print(fresh);self.assertEqual(self.print_pixels(paper),expected);self.assertEqual(fresh.evaluate('devicePixelRatio'),1.25)
 def test_batch_print_07_signed_negative_pixels_and_rescale(self):
  phantom=projection.phantom
  with patch.object(projection,'phantom',side_effect=lambda stack,intercept,constant:phantom(stack,-100,constant,signed=True)):a,p,v=self.batch_start()
  v.evaluate('()=>{projectionVP.setProperties({voiRange:{lower:-1124,upper:-124}});projectionVP.render()}');self.project(v,3,20);v.wait_for_function('()=>Math.abs(projectionPixel()-128)<=3');self.make_batch(v,offset=1,interval=1,count=3);expected=self.pixels(v);self.save_volume(v)
  paper=self.open_batch_print(v);self.assertEqual(self.print_pixels(paper),expected);expect(paper.locator('main')).to_contain_text('VOI -1124 ~ -124');self.assertEqual(len(self.jobs(a)),1)
 def test_batch_print_11_minip_vertical_flip(self):
  a,p,v=self.batch_start();self.project(v,2,20);v.evaluate('()=>{projectionVP.setCamera({flipVertical:true});projectionVP.render()}');self.make_batch(v,offset=1,interval=1,count=3);expected=self.pixels(v);self.save_volume(v);paper=self.open_batch_print(v);self.assertEqual(self.print_pixels(paper),expected);expect(paper.locator('main')).to_contain_text('MinIP 20 mm')
 def test_batch_print_08_changed_fresh_source_manifest_refuses_output(self):
  a,p,v=self.batch_start();self.make_batch(v);self.save_volume(v);before=self.volume_state(v);pattern='**/attachments/dicom/info'
  def changed(route):
   response=route.fetch();value=response.json();value['UncompressedMD5']='0'*32;route.fulfill(response=response,json=value)
  v.route(pattern,changed);v.get_by_role('button',name='Print Saved Images',exact=True).click();expect(v.locator('#kin-job-print [role=status]')).to_contain_text('저장 당시 전체 원본과 달라',timeout=120000);expect(v.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF',exact=True)).to_be_disabled();self.preserved_volume(before,self.volume_state(v));v.unroute(pattern)
  v.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click();expect(v.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=120000);self.preserved_volume(before,self.volume_state(v));self.assertEqual(len(self.jobs(a)),1)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeBatchPrintE2E(n) for n in loader.getTestCaseNames(VolumeBatchPrintE2E) if n.startswith('test_batch_print_'))
if __name__=='__main__':unittest.main(verbosity=2)
