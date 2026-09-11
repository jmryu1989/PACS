# coding: utf-8
"""TEST-MPR-PRINT: saved three-plane reconstruction and manual point output."""
import os,unittest
from unittest.mock import patch
from pathlib import Path
from playwright.sync_api import expect
from test_volume_marks import VolumeMarksE2E
from test_volume_batch_print import VolumeBatchPrintE2E

class VolumeMprPrintE2E(VolumeMarksE2E):
 open_print=VolumeBatchPrintE2E.open_batch_print
 print_pixels=VolumeBatchPrintE2E.print_pixels
 def native_pixels(self,v):
  return v.evaluate("""()=>{const state=services.viewportGridService.getState();return [...state.viewports.values()].map(g=>{const c=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId).getCanvas(),ctx=c.getContext('2d');let hash=2166136261;for(const b of ctx.getImageData(0,0,c.width,c.height).data)hash=Math.imul(hash^b,16777619);return {width:c.width,height:c.height,pixel:Array.from(ctx.getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data),hash:hash>>>0}})}""")
 def test_mpr_print_01_legacy_three_planes_exact_pixels(self):
  a,p,v=self.starting();expected=self.native_pixels(v);self.save_volume(v);before=self.volume_state(v);original=self.originals();paper=self.open_print(v);actual=self.print_pixels(paper);print('MPR_PRINT_PIXELS',{'expected':expected,'actual':actual},flush=True);self.assertEqual(expected,actual);expect(paper.locator('.cell')).to_have_count(3);expect(paper.locator('.batch-reference')).to_have_count(0);self.preserved_volume(before,self.volume_state(v));self.assertEqual(self.originals(),original)
 def test_mpr_print_02_marks_number_position_and_immutable_source(self):
  a,p,v=self.starting();self.add_mark(v,'<manual label & text>');self.save_volume(v);job=self.get_volume_job(a);before=self.volume_state(v);p.locator('#findings').fill('KEEP PRINT DRAFT');expected=v.evaluate("""point=>[...services.viewportGridService.getState().viewports.values()].map(g=>{const view=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);return {xy:view.worldToCanvas(point).map(n=>n*devicePixelRatio),offset:KinVolumeMarks.signedOffset(point,view.getCamera())}})""",job['snapshot']['marks']['marks'][0]['point']);paper=self.open_print(v);expect(paper.locator('[data-annotation-id]')).to_have_count(3);actual=paper.locator('[data-annotation-id]').evaluate_all('(rows)=>rows.map(r=>({xy:[Number(r.dataset.x),Number(r.dataset.y)],offset:Number(r.dataset.offset)}))');
  for x,y in zip(expected,actual):
   for aa,bb in zip(x['xy'],y['xy']):self.assertAlmostEqual(aa,bb,delta=.01)
   self.assertAlmostEqual(x['offset'],y['offset'],delta=1e-5)
  expect(paper.locator('[data-annotation-id]').first).to_contain_text('<manual label & text>');expect(p.locator('#findings')).to_have_value('KEEP PRINT DRAFT');self.preserved_volume(before,self.volume_state(v));self.assertEqual(self.get_volume_job(a)['snapshot'],job['snapshot']);self.assertFalse(v.evaluate('()=>kinMprMarks.dirty()'))
  if os.environ.get('KIN_EVIDENCE_DIR'):v.screenshot(path=str(Path(os.environ['KIN_EVIDENCE_DIR'])/'mpr-print.png'))
 def test_mpr_print_03_hidden_marks_preserve_pixels_and_new_browser(self):
  a,p,v=self.starting();self.add_mark(v);self.marks(v).get_by_label('Show Annotations',exact=True).uncheck();expected=self.native_pixels(v);self.save_volume(v);fresh=self.login();self.launch(fresh,[a]);self.ready(fresh);paper=self.open_print(fresh);self.assertEqual(self.print_pixels(paper),expected);expect(paper.locator('[data-annotation-id]')).to_have_count(3);expect(paper.locator('[data-annotation-id]').first).to_contain_text('Hidden marker')

 batch_start=VolumeBatchPrintE2E.batch_start
 make_batch=VolumeBatchPrintE2E.make_batch
 open_batch_print=VolumeBatchPrintE2E.open_batch_print
 test_mpr_print_04_revision_before_actual_print=VolumeBatchPrintE2E.test_batch_print_04_changed_job_blocks_print_then_retry
 test_mpr_print_05_asset_memory_recovery=VolumeBatchPrintE2E.test_batch_print_05_missing_asset_retry_and_low_memory
 test_mpr_print_06_cancel_and_renderer_failure=VolumeBatchPrintE2E.test_batch_print_06_cancel_delayed_source_and_renderer_failure
 test_mpr_print_07_changed_source_refuses=VolumeBatchPrintE2E.test_batch_print_08_changed_fresh_source_manifest_refuses_output
 def test_mpr_print_08_annotated_batch_offsets(self):
  a,p,v=self.batch_start();self.add_mark(v);self.make_batch(v);self.save_volume(v);job=self.get_volume_job(a);self.assertEqual(job['snapshot']['version'],6);paper=self.open_print(v);expect(paper.locator('.cell')).to_have_count(3);expect(paper.locator('.batch-reference line')).to_have_count(3);expect(paper.locator('[data-annotation-id]')).to_have_count(3);self.assertEqual(sorted(round(abs(float(n)),1) for n in paper.locator('[data-annotation-id]').evaluate_all('(rows)=>rows.map(r=>r.dataset.offset)')),[0,12,12]);self.assertEqual(len(self.jobs(a)),1)
 # Fix only the reference sampling phase: saved reconstruction is deterministic,
 # while live Average otherwise uses a random GPU phase. Pixel assertions stay exact.
 def test_mpr_print_09_oblique_average_readonly_dpr(self):
  a,p,v=self.starting();self.rotate_planes(v,0,25);self.rotate_planes(v,1,-35);self.project(v,3,20);v.evaluate('()=>{projectionVP.setProperties({invert:true});projectionVP.setCamera({flipHorizontal:true,flipVertical:true});projectionVP.render()}');v.wait_for_timeout(250);self.add_mark(v);self.marks(v).get_by_label('Show Annotations',exact=True).uncheck();v.evaluate("""()=>{for(const g of services.viewportGridService.getState().viewports.values()){const view=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);const mapper=view.getActors()[0].actor.getMapper(),specific=mapper.getViewSpecificProperties();mapper.setViewSpecificProperties({...specific,OpenGL:{...specific.OpenGL,ShaderReplacements:[...(specific.OpenGL?.ShaderReplacements||[]),{shaderType:'Fragment',originalValue:'float jitter = 0.01 + 0.99*texture2D(jtexture, gl_FragCoord.xy/32.0).r;',replacementValue:'float jitter = 0.5;',replaceFirst:true,replaceAll:false}]}});view.render()}}""");v.wait_for_timeout(250);expected=self.native_pixels(v);native_png=v.evaluate('()=>[...services.viewportGridService.getState().viewports.values()].map(g=>services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId).getCanvas().toDataURL())');self.save_volume(v)
  create=self.browser.new_context
  with patch.object(self.browser,'new_context',side_effect=lambda **options:create(**dict(options,device_scale_factor=1.5,viewport={'width':1400,'height':950}))):fresh=self.login('tech')
  self.launch(fresh,[a]);self.ready(fresh);fresh.get_by_label('Job Author',exact=True).select_option('false');expect(fresh.get_by_role('button',name='Save New Job',exact=True)).to_be_disabled();paper=self.open_print(fresh);actual=self.print_pixels(paper);print('MPR_PRINT_OBLIQUE',{'expected':expected,'actual':actual},flush=True)
  if actual!=expected:
   import base64
   from PIL import Image
   import io,numpy as np
   output_png=paper.locator('.cell img').evaluate_all("async rows=>Promise.all(rows.map(async img=>{await img.decode();const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;c.getContext('2d').drawImage(img,0,0);return c.toDataURL()}))")
   folder=Path(os.environ.get('KIN_EVIDENCE_DIR','../tmp/mpr-print'));folder.mkdir(parents=True,exist_ok=True)
   for i,(left,right) in enumerate(zip(native_png,output_png)):
    aa=base64.b64decode(left.split(',')[1]);bb=base64.b64decode(right.split(',')[1]);(folder/f'native-{i}.png').write_bytes(aa);(folder/f'output-{i}.png').write_bytes(bb);diff=np.abs(np.asarray(Image.open(io.BytesIO(aa))).astype(int)-np.asarray(Image.open(io.BytesIO(bb))).astype(int));print('PIXEL_DIFF',i,{'count':int(np.count_nonzero(diff)),'max':int(diff.max()),'mean':float(diff.mean())},flush=True)
  self.assertEqual(actual,expected);expect(paper.locator('main')).to_contain_text('Average 20 mm')

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeMprPrintE2E(n) for n in loader.getTestCaseNames(VolumeMprPrintE2E) if n.startswith('test_mpr_print_'))
if __name__=='__main__':unittest.main(verbosity=2)
