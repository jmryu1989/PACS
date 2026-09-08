# coding: utf-8
"""TEST-D09-PREVIEW-CONTROLS: native pixel/geometry and output-only edits."""
import copy,json,sys,unittest,uuid
from pathlib import Path
import numpy as np
from pypdf import PdfReader
from playwright.sync_api import expect
from test_viewer_job_report import ViewerJobReportE2E,canvas_ready


class PreviewControlsE2E(ViewerJobReportE2E):
 def adjust(self,p,target='all',zoom=100,x=0,y=0,window=None):
  p.get_by_label('출력 조절 대상',exact=True).select_option(target)
  for label,value in [('확대 (%)',zoom),('가로 이동 (%)',x),('세로 이동 (%)',y)]:p.get_by_label(label,exact=True).fill(str(value))
  p.get_by_label('비교 출력 밝기',exact=True).select_option('manual' if window else 'saved')
  if window:
   p.get_by_label('출력 W',exact=True).fill(str(window[0]));p.get_by_label('출력 L',exact=True).fill(str(window[1]))
  expect(p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF')).to_be_disabled()
  p.get_by_role('button',name='출력 조절 적용',exact=True).click();self.ready_controls(p)

 def ready_controls(self,p):
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=45000)
  return p.frame_locator('#kin-job-print iframe')

 def reset_output(self,p,target='all'):
  p.get_by_label('출력 조절 대상',exact=True).select_option(target)
  p.get_by_role('button',name='선택 범위 저장 상태로',exact=True).click();self.ready_controls(p)

 def reference(self,p,zoom,x,y,window=None,points=None):
  return p.evaluate('''async ({zoom,x,y,windowing,points})=>{
   const state=services.viewportGridService.getState(),v=services.cornerstoneViewportService.getCornerstoneViewport(state.activeViewportId);
   const before={camera:v.getCamera(),properties:v.getProperties()},c=v.getCanvas(),dpr=devicePixelRatio;
   const rendered=()=>new Promise(resolve=>{v.element.addEventListener(cornerstone.Enums.Events.IMAGE_RENDERED,resolve,{once:true});v.render()});
   try {
    v.setZoom(v.getZoom()*zoom/100);const pan=v.getPan();v.setPan([pan[0]+c.width/dpr*x/100,pan[1]+c.height/dpr*y/100]);
    if(windowing)v.setProperties({voiRange:{lower:windowing[1]-windowing[0]/2,upper:windowing[1]+windowing[0]/2-1},VOILUTFunction:'LINEAR'});
    await rendered();return {image:c.toDataURL(),points:points?.map(point=>v.worldToCanvas(point).map(n=>n*dpr))};
   } finally {v.setProperties(before.properties);v.setCamera(before.camera);await rendered()}
  }''',dict(zoom=zoom,x=x,y=y,windowing=window,points=points))

 def test_preview_controls_01_native_pixels_and_reset(self):
  f=self.ct('PREVIEW-'+uuid.uuid4().hex[:12],'current','20260801');p=self.launch_job([f]);canvas_ready(p,1)
  for key in ['2','r','h','v']:p.keyboard.press(key)
  self.gesture(p,'Pan',22,14);job=self.saved(p,f);frozen=self.get_job(f,job);before=self.pngs(p)
  expected=self.reference(p,150,12,-8,[1500,-600]);self.assertEqual(self.pngs(p),before)
  paper=self.output(p);baseline=self.output_arrays(p,paper)[0]
  self.adjust(p,zoom=150,x=12,y=-8,window=[1500,-600]);actual=self.output_arrays(p,paper)[0];reference=self.arrays([expected['image']])[0]
  expect(p.get_by_label('확대 (%)',exact=True)).to_have_value('150');expect(p.get_by_label('출력 W',exact=True)).to_have_value('1500')
  error=np.abs(actual.astype(int)-reference.astype(int));self.assertEqual(actual.shape,reference.shape);self.assertLessEqual(int(error.max()),2)
  expect(paper.locator('.output-adjustment')).to_contain_text('150%');expect(paper.locator('.output-adjustment')).to_contain_text('W 1500 / L -600')
  self.assertEqual(self.pngs(p),before);self.assertEqual(self.get_job(f,job),frozen)
  self.reset_output(p);self.assertTrue(np.array_equal(self.output_arrays(p,paper)[0],baseline))
  print('PREVIEW native full-pixel max '+str(int(error.max())),flush=True)

 def test_preview_controls_02_annotation_geometry_report_pdf(self):
  f=self.ct('PREVIEW-'+uuid.uuid4().hex[:12],'current','20260801');head=self.annotation(f,'출력 이동 표식','length');p=self.launch_job([f]);canvas_ready(p,1)
  p.evaluate('''async sop=>{const s=services.viewportGridService.getState(),v=services.cornerstoneViewportService.getCornerstoneViewport(s.activeViewportId);
   const i=v.getImageIds().findIndex(id=>cornerstone.metaData.get('instance',id).SOPInstanceUID===sop);if(i<0)throw Error('missing SOP');await v.setImageIdIndex(i);v.scroll(i-v.getTargetImageIdIndex(),false)}''',head['item']['sopUid'])
  for key in ['r','h']:p.keyboard.press(key)
  p.get_by_label('작업 제목',exact=True).fill('출력 조절 주석');self.click_job(p,'주석 함께 새 비교 작업 저장','고정했습니다');job=self.jobs(f)[0]
  self.seed_report(f,action='approve',findings='출력 조절 판독문');before=self.pngs(p);rows=self.report_rows(f);original=self.originals();frozen=self.get_job(f,job)
  expected=self.reference(p,125,-7,5,points=head['item']['points']);self.output(p);self.adjust(p,zoom=125,x=-7,y=5)
  paper=self.include_report(p);image=self.output_arrays(p,paper)[0];gold=(image[:,:,0]>220)&(image[:,:,1]>170)&(image[:,:,2]<80)
  for x,y in expected['points']:
   x,y=round(x),round(y);self.assertTrue(gold[max(0,y-4):y+5,max(0,x-4):x+5].any(),(x,y))
  expect(paper.locator('.output-adjustment')).to_contain_text('125%');expect(paper.locator('.report')).to_contain_text('출력 조절 판독문')
  printed=self.print_popup(p);printed.wait_for_function('()=>window.__printed===true')
  path=Path(__file__).parent/'artifacts/preview-controls.pdf';printed.pdf(path=str(path),prefer_css_page_size=True)
  pdf=PdfReader(path);self.assertGreaterEqual(len(pdf.pages),2)
  for page in pdf.pages:self.assertIn(f.patient_id,page.extract_text())
  self.assertIn('125%', '\n'.join(page.extract_text() for page in pdf.pages));embedded=[np.array(i.image.convert('RGB')) for page in pdf.pages for i in page.images]
  self.assertTrue(any(np.array_equal(image,i) for i in embedded));self.assertEqual(self.pngs(p),before)
  self.assertEqual(self.report_rows(f),rows);self.assertEqual(self.originals(),original);self.assertEqual(self.get_job(f,job),frozen)
  print('PREVIEW annotation PDF '+json.dumps(dict(pages=len(pdf.pages),points=expected['points'])),flush=True)

 def test_preview_controls_03_selected_all_empty_and_reopen(self):
  patient='PREVIEW-'+uuid.uuid4().hex[:12];a=self.ct(patient,'current','20260801');b=self.ct(patient,'past','20260701')
  command=self.v2([a,b]);command['snapshot'].update(rows=2,cols=2);command['snapshot']['cells']+=[None,copy.deepcopy(command['snapshot']['cells'][0])]
  job=self.post(a,command);p=self.launch_job([a]);paper=self.output(p);baseline=self.output_arrays(p,paper)
  expect(p.get_by_label('출력 조절 대상',exact=True).locator('option')).to_have_count(4)
  self.adjust(p,target='1',zoom=180,x=9);selected=self.output_arrays(p,paper)
  self.assertTrue(np.array_equal(selected[0],baseline[0]));self.assertFalse(np.array_equal(selected[1],baseline[1]));self.assertTrue(np.array_equal(selected[2],baseline[2]))
  self.adjust(p,zoom=125,y=-10,window=[400,40]);allimages=self.output_arrays(p,paper)
  self.assertTrue(all(not np.array_equal(x,y) for x,y in zip(allimages,baseline)))
  expect(paper.locator('.cell').nth(2)).to_contain_text('빈 셀')
  self.reset_output(p);self.assertTrue(all(np.array_equal(x,y) for x,y in zip(self.output_arrays(p,paper),baseline)))
  self.adjust(p,target='0',zoom=200)
  p.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click();paper=self.output(p)
  expect(p.get_by_label('출력 조절 대상',exact=True)).to_have_value('all');self.assertTrue(all(np.array_equal(x,y) for x,y in zip(self.output_arrays(p,paper),baseline)))

 def test_preview_controls_04_invalid_input_failure_and_late_close(self):
  f=self.ct('PREVIEW-'+uuid.uuid4().hex[:12],'current','20260801');self.post(f,self.v2([f]));p=self.launch_job([f]);paper=self.output(p)
  for label,value in [('확대 (%)',''),('확대 (%)','401'),('가로 이동 (%)','-101')]:
   p.get_by_label(label,exact=True).fill(value);p.get_by_role('button',name='출력 조절 적용',exact=True).click()
   expect(p.locator('#kin-job-print [role=status]')).to_contain_text('범위를 확인');expect(p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF')).to_be_disabled()
   p.get_by_role('button',name='선택 범위 저장 상태로',exact=True).click();self.ready_controls(p)
  p.get_by_label('비교 출력 밝기',exact=True).select_option('manual');p.get_by_label('출력 W',exact=True).fill('0')
  p.get_by_role('button',name='출력 조절 적용',exact=True).click();expect(p.locator('#kin-job-print [role=status]')).to_contain_text('범위를 확인')
  p.get_by_role('button',name='선택 범위 저장 상태로',exact=True).click();self.ready_controls(p)
  self.adjust(p,window=[1,40]);expect(paper.locator('.output-adjustment')).to_contain_text('W 1 / L 40')
  asset='**/frames/0/image-*';failures=[]
  def failed(route):failures.append(route.request.url);route.fulfill(status=503,body='unavailable')
  p.route(asset,failed)
  p.get_by_label('확대 (%)',exact=True).fill('150');p.get_by_role('button',name='출력 조절 적용',exact=True).click()
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('읽지 못했습니다');expect(p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF')).to_be_disabled()
  self.assertEqual(len(failures),1)
  p.unroute(asset);p.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click();self.ready_controls(p)
  expect(paper.locator('.output-adjustment')).to_contain_text('150%')
  p.evaluate('''()=>{const f=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).includes('/report-preview')){window.__waiting=true;await new Promise(r=>window.__release=r)}return f(...args)};window.__restore=()=>window.fetch=f}''')
  p.get_by_label('확대 (%)',exact=True).fill('175');p.get_by_role('button',name='출력 조절 적용',exact=True).click();p.wait_for_function('()=>window.__waiting')
  p.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click();p.evaluate('()=>{window.__restore();window.__release()}')
  paper=self.output(p);expect(paper.locator('.output-adjustment')).to_contain_text('100%')


def load_tests(loader,tests,pattern):return unittest.TestSuite(PreviewControlsE2E(n) for n in loader.getTestCaseNames(PreviewControlsE2E) if n.startswith('test_preview_controls_'))
if __name__=='__main__':
 sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
