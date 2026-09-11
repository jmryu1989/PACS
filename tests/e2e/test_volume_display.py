# coding: utf-8
"""TEST-VOLUME-DISPLAY: selected reset preserves reconstructed plane and work."""
import json,re,unittest
from pathlib import Path
import numpy as np
from playwright.sync_api import expect
from test_volume_orientation import VolumeOrientationE2E
from test_embedded_patient_copy import EmbeddedPatientCopyE2E
from test_volume_cine import VolumeCineE2E

class VolumeDisplayE2E(VolumeOrientationE2E):
 def reset_display(self,v,kind):
  name='Reset Windowing' if kind=='windowing' else 'Reset Zoom / Pan'
  v.get_by_role('button',name=name,exact=True).click()
  expect(v.locator('#kin-volume-display [role=status]')).to_contain_text('돌아왔습니다')
 def test_mpr_display_01_default_windowing_known_pixels_preserves_other_planes(self):
  a,p,v=self.starting();original=self.originals();p.locator('#findings').fill('KEEP DISPLAY REPORT');self.project(v,3,20)
  v.evaluate('()=>{window.displayVoiEvents=[];projectionVP.element.addEventListener(cornerstone.Enums.Events.VOI_MODIFIED,e=>displayVoiEvents.push(e.detail.range));projectionVP.setProperties({voiRange:{lower:0,upper:2000},invert:true});projectionVP.render()}')
  v.wait_for_function('()=>projectionPixel()>180');before=self.volume_state(v)
  self.reset_display(v,'windowing');v.wait_for_function('()=>Math.abs(projectionPixel()-127)<=3');after=self.volume_state(v)
  self.preserved_volume(before[1:],after[1:])
  for k in ['position','focalPoint','viewUp','viewPlaneNormal','parallelScale']:np.testing.assert_allclose(after[0]['camera'][k],before[0]['camera'][k],atol=1e-6)
  result=v.evaluate('()=>({properties:projectionVP.getProperties(),mode:projectionVP.getActors()[0].actor.getMapper().getBlendMode(),thickness:projectionVP.getSlabThickness()*2,pixel:projectionPixel()})')
  self.assertIn({'lower':0,'upper':999},v.evaluate('()=>displayVoiEvents'))
  v.wait_for_function("()=>/W:\\s*1000\\s*L:\\s*500/.test(projectionVP.element.closest('.viewport-wrapper').innerText)")
  self.assertEqual(result['properties']['voiRange'],{'lower':0,'upper':999});self.assertTrue(result['properties']['invert']);self.assertEqual(result['mode'],3);self.assertAlmostEqual(result['thickness'],20)
  expect(p.locator('#findings')).to_have_value('KEEP DISPLAY REPORT');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1)
  folder=Path('../tmp/volume-display-options');v.screenshot(path=str(folder/'selected-windowing.png'));print('SELECTED_WINDOWING',json.dumps(result),flush=True)
  v.evaluate('()=>{projectionVP.setProperties({voiRange:{lower:0,upper:1500}});projectionVP.render()}')
  v.wait_for_function('()=>[...services.viewportGridService.getState().viewports.keys()].every(id=>services.cornerstoneViewportService.getCornerstoneViewport(id).getProperties().voiRange.upper===1500)')
 def test_mpr_display_02_oblique_zoom_pan_plane_equation_and_saved_reopen(self):
  a,p,v=self.starting();self.reset_display(v,'zoom');starting=self.volume_state(v)[0]['camera'];self.rotate_planes(v,0,25);self.rotate_planes(v,1,-35)
  v.evaluate('()=>{const c=projectionVP.getCamera(),delta=c.viewUp.map(n=>n*7);projectionVP.setCamera({focalPoint:c.focalPoint.map((n,i)=>n+delta[i]),position:c.position.map((n,i)=>n+delta[i]),parallelScale:c.parallelScale*.4});projectionVP.render()}')
  v.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');before=self.volume_state(v)
  normal=np.array(before[0]['camera']['viewPlaneNormal']);old=np.array(before[0]['camera']['focalPoint']);center=np.array(starting['focalPoint']);expected=center+normal*np.dot(old-center,normal)/np.dot(normal,normal)
  self.reset_display(v,'zoom');after=self.volume_state(v);self.preserved_volume(before[1:],after[1:])
  np.testing.assert_allclose(after[0]['camera']['focalPoint'],expected,atol=1e-6);self.assertAlmostEqual(after[0]['camera']['parallelScale'],starting['parallelScale'],delta=1e-6)
  for k in ['viewUp','viewPlaneNormal']:np.testing.assert_allclose(after[0]['camera'][k],before[0]['camera'][k],atol=1e-6)
  self.assertAlmostEqual(np.dot(normal,after[0]['camera']['focalPoint']),np.dot(normal,old),delta=1e-6)
  self.save_volume(v);saved=self.get_volume_job(a);fresh=self.login();self.launch(fresh,[a]);self.ready(fresh);fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000)
  restored=self.volume_state(fresh)
  for want,got in zip(saved['snapshot']['cells'],restored):
   for k in ['position','focalPoint','viewUp','viewPlaneNormal','parallelScale']:np.testing.assert_allclose(got['camera'][k],want['camera'][k],atol=1e-6)
  expect(fresh.get_by_role('button',name='Reset Zoom / Pan',exact=True)).to_be_enabled();reopened=self.volume_state(fresh)
  fresh.evaluate('()=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId),c=v.getCamera();v.setCamera({parallelScale:c.parallelScale*.5});v.render()}');self.reset_display(fresh,'zoom');self.preserved_volume(reopened,self.volume_state(fresh))
  print('SELECTED_PLANE',json.dumps({'normal':normal.tolist(),'expected':expected.tolist(),'actual':after[0]['camera']['focalPoint']}),flush=True)
 def test_mpr_display_03_partial_native_failure_modal_and_session(self):
  a,p,v=self.starting();v.evaluate('()=>{const c=projectionVP.getCamera();projectionVP.setCamera({parallelScale:c.parallelScale*.5});projectionVP.render()}');v.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');before=self.volume_state(v)
  v.evaluate("()=>{const original=projectionVP.setCamera;let once=true;projectionVP.setCamera=function(...args){const r=original.apply(this,args);if(once){once=false;throw Error('INJECTED DISPLAY FAILURE')}return r}}")
  v.get_by_role('button',name='Reset Zoom / Pan',exact=True).click();expect(v.locator('#kin-volume-display [role=status]')).to_contain_text('INJECTED DISPLAY FAILURE');self.preserved_volume(before,self.volume_state(v));self.reset_display(v,'zoom')
  v.evaluate('()=>{projectionVP.setProperties({voiRange:{lower:0,upper:2000}});projectionVP.render()}');v.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');before=self.volume_state(v)
  v.evaluate("()=>{const original=projectionVP.setProperties;let once=true;projectionVP.setProperties=function(...args){const r=original.apply(this,args);if(once){once=false;throw Error('INJECTED WINDOWING FAILURE')}return r};window.displaySyncBefore=cornerstoneTools.SynchronizerManager.getAllSynchronizers().map(g=>[g.id,g.isDisabled()])}")
  v.get_by_role('button',name='Reset Windowing',exact=True).click();expect(v.locator('#kin-volume-display [role=status]')).to_contain_text('INJECTED WINDOWING FAILURE');self.preserved_volume(before,self.volume_state(v))
  self.assertTrue(v.evaluate('()=>JSON.stringify(displaySyncBefore)===JSON.stringify(cornerstoneTools.SynchronizerManager.getAllSynchronizers().map(g=>[g.id,g.isDisabled()]))'));self.reset_display(v,'windowing')
  self.open_note(v);expect(v.get_by_role('button',name='Reset Windowing',exact=True)).to_be_disabled();v.locator('#tech-note-close').click();expect(v.get_by_role('button',name='Reset Windowing',exact=True)).to_be_enabled()
  v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(v.locator('#kin-volume-display')).to_have_count(0)
 def test_mpr_display_04_embedded_owner_and_plane_selection(self):
  a,b=self.pair();p,f=EmbeddedPatientCopyE2E.opened(self,a);self.mpr(f);self.choose_volume(p,f,0);p.locator('#findings').fill('KEEP EMBEDDED DISPLAY')
  button=f.get_by_role('button',name='Reset Windowing',exact=True,include_hidden=True);expect(button).to_be_enabled();before=self.volume_state(f)
  p.evaluate("()=>{window.savedDisplayOwner=KinWorkspaceLayout.key;KinWorkspaceLayout.key=()=>{throw Error('OWNER UNAVAILABLE')}}");expect(button).to_be_disabled();button.dispatch_event('click');self.preserved_volume(before,self.volume_state(f));p.evaluate('()=>KinWorkspaceLayout.key=window.savedDisplayOwner');expect(button).to_be_enabled()
  f.evaluate("()=>{const g=services.viewportGridService;g.setActiveViewportId([...g.getState().viewports.keys()][1]);document.querySelector('#kin-volume-display button').click()}")
  expect(f.locator('#kin-volume-display [role=status]')).to_contain_text(re.compile('선택한 MPR|화면이 변경'));self.preserved_volume(before,self.volume_state(f))
  p.get_by_role('button',name='Back to Worklist',exact=True).click();expect(button).to_be_disabled();expect(p.locator('#findings')).to_have_value('KEEP EMBEDDED DISPLAY')
 def test_mpr_display_05_missing_asset_keeps_orientation_and_projection(self):
  a,b=self.pair();p=self.login();p.route('**/volume-display.js',lambda route:route.abort());v=self.launch(p,[a]);self.ready(v);self.mpr(v);self.choose_volume(v,v,0)
  expect(v.locator('#kin-volume-display')).to_have_count(0);expect(v.get_by_role('button',name='Reset Planes',exact=True)).to_be_enabled();expect(v.get_by_role('button',name='Apply to Active Plane',exact=True)).to_be_enabled()
 def test_mpr_display_06_selection_cancel_restores_only_owned_changes(self):
  a,p,v=self.starting();v.evaluate("()=>{projectionVP.setProperties({voiRange:{lower:0,upper:2000}});projectionVP.render()}");v.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');before=self.volume_state(v)
  v.evaluate("()=>{const g=services.viewportGridService;g.setActiveViewportId([...g.getState().viewports.keys()][1]);document.querySelector('#kin-volume-display button').click()}")
  expect(v.locator('#kin-volume-display [role=status]')).to_contain_text(re.compile('선택한 MPR|화면이 변경'));self.preserved_volume(before,self.volume_state(v))
  self.choose_volume(v,v,0);v.wait_for_timeout(300)
  v.evaluate("()=>{const original=projectionVP.setProperties;let once=true;projectionVP.setProperties=function(...args){const r=original.apply(this,args);if(once){once=false;requestAnimationFrame(()=>{original.call(this,{voiRange:{lower:0,upper:3000}});this.render()})}return r};const g=services.viewportGridService;g.setActiveViewportId([...g.getState().viewports.keys()][1]);document.querySelector('#kin-volume-display button').click()}")
  expect(v.locator('#kin-volume-display [role=status]')).to_contain_text('화면이 변경');v.wait_for_function('()=>[...services.viewportGridService.getState().viewports.keys()].every(id=>services.cornerstoneViewportService.getCornerstoneViewport(id).getProperties().voiRange.upper===3000)')
 def test_mpr_display_07_sigmoid_returns_to_default_linear_pixels(self):
  a,p,v=self.opened_projection()
  v.evaluate("()=>{projectionVP.setProperties({VOILUTFunction:'SIGMOID'});projectionVP.setProperties({voiRange:{lower:0,upper:2000}});projectionVP.render()}");v.wait_for_function('()=>projectionPixel()<100');self.assertEqual(v.evaluate('()=>projectionVP.getProperties().VOILUTFunction'),'SIGMOID')
  self.reset_display(v,'windowing');v.wait_for_function('()=>Math.abs(projectionPixel()-128)<=1');self.assertEqual(v.evaluate('()=>projectionVP.getProperties().VOILUTFunction'),'LINEAR')
  self.assertEqual(v.evaluate('()=>projectionVP.getActors()[0].actor.getProperty().getRGBTransferFunction(0).getSize()'),2)
  v.evaluate('()=>{const c=projectionVP.getCamera(),delta=4-c.focalPoint[2];projectionVP.setCamera({focalPoint:c.focalPoint.map((x,i)=>x+(i===2?delta:0)),position:c.position.map((x,i)=>x+(i===2?delta:0))});projectionVP.render()}');v.wait_for_function('()=>Math.abs(projectionPixel()-26)<=2')
  for inverted,expected in [(False,26),(True,229)]:
   v.evaluate("inverted=>{projectionVP.setProperties({VOILUTFunction:'SIGMOID'});projectionVP.setProperties({voiRange:{lower:0,upper:2000}});if(inverted)projectionVP.setInvert(true,projectionVP.getVolumeId());projectionVP.render()}",inverted)
   v.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');before=self.volume_state(v)
   self.reset_display(v,'windowing');v.wait_for_function('(n)=>Math.abs(projectionPixel()-n)<=2',arg=expected);self.preserved_volume(before[1:],self.volume_state(v)[1:]);self.assertEqual(v.evaluate('()=>projectionVP.getProperties().invert'),inverted)
 def test_mpr_display_08_rollback_failure_is_visible_and_retry_works(self):
  a,p,v=self.starting();v.evaluate('()=>{const c=projectionVP.getCamera();projectionVP.setCamera({parallelScale:c.parallelScale*.4});projectionVP.render()}')
  v.evaluate("()=>{window.displayOriginalCamera=projectionVP.setCamera;let calls=0;projectionVP.setCamera=function(...args){calls++;if(calls===2)throw Error('ROLLBACK FAILURE');const r=displayOriginalCamera.apply(this,args);if(calls===1)throw Error('APPLY FAILURE');return r}}")
  v.get_by_role('button',name='Reset Zoom / Pan',exact=True).click();expect(v.locator('#kin-volume-display [role=status]')).to_contain_text('완전히 복구하지 못했습니다');v.evaluate('()=>projectionVP.setCamera=displayOriginalCamera');self.reset_display(v,'zoom')
 def test_mpr_display_10_sigmoid_default_and_unsupported_function(self):
  a,p,v=self.opened_projection()
  self.assertEqual(v.evaluate('()=>Object.values(cornerstone.Enums.VOILUTFunctionType).sort()'),['LINEAR','SIGMOID'])
  v.evaluate("()=>{projectionVP.setDefaultProperties({voiRange:{lower:0,upper:999},VOILUTFunction:'SIGMOID'},projectionVP.getVolumeId());const c=projectionVP.getCamera(),delta=4-c.focalPoint[2];projectionVP.setCamera({focalPoint:c.focalPoint.map((x,i)=>x+(i===2?delta:0)),position:c.position.map((x,i)=>x+(i===2?delta:0))});projectionVP.render()}")
  for inverted in [False,True]:
   v.evaluate('invert=>{projectionVP.setProperties({invert,voiRange:{lower:0,upper:2000}});projectionVP.render()}',inverted)
   v.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');before=self.volume_state(v)
   self.reset_display(v,'windowing');expected=round(255/(1+np.exp(-4*(100-500)/1000)));expected=255-expected if inverted else expected
   v.wait_for_function('(n)=>Math.abs(projectionPixel()-n)<=2',arg=expected);self.preserved_volume(before[1:],self.volume_state(v)[1:]);self.assertEqual(v.evaluate('()=>projectionVP.getProperties().VOILUTFunction'),'SIGMOID');v.wait_for_function("()=>/W:\\s*1000\\s*L:\\s*500/.test(projectionVP.element.closest('.viewport-wrapper').innerText)")
  v.evaluate("()=>projectionVP.setDefaultProperties({voiRange:{lower:0,upper:999},VOILUTFunction:'LINEAR_EXACT'},projectionVP.getVolumeId())");expect(v.get_by_role('button',name='Reset Windowing',exact=True)).to_be_disabled()
 def test_mpr_display_11_same_page_job_restore_resets_to_restored_baseline(self):
  a,p,v=self.starting();self.rotate_planes(v,0,25);v.evaluate('()=>{projectionVP.setCamera({parallelScale:projectionVP.getCamera().parallelScale*.6});projectionVP.render()}');self.save_volume(v)
  v.evaluate('()=>{window.displayOldViews=[...services.viewportGridService.getState().viewports.keys()].map(id=>services.cornerstoneViewportService.getCornerstoneViewport(id));projectionVP.setCamera({parallelScale:projectionVP.getCamera().parallelScale*.4});projectionVP.render()}')
  v.get_by_role('button',name='Restore Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000);expect(v.get_by_role('button',name='Reset Zoom / Pan',exact=True)).to_be_enabled();restored=self.volume_state(v)
  self.assertTrue(v.evaluate('()=>[...services.viewportGridService.getState().viewports.keys()].every(id=>!displayOldViews.includes(services.cornerstoneViewportService.getCornerstoneViewport(id)))'))
  v.evaluate('()=>{const view=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);view.setCamera({parallelScale:view.getCamera().parallelScale*.5});view.render()}');self.reset_display(v,'zoom');self.preserved_volume(restored,self.volume_state(v))
 def test_mpr_display_12_inverted_sigmoid_failure_restores_exact_curve(self):
  a,p,v=self.opened_projection();v.evaluate("()=>{projectionVP.setDefaultProperties({voiRange:{lower:0,upper:999},VOILUTFunction:'SIGMOID'},projectionVP.getVolumeId());projectionVP.setProperties({invert:true});projectionVP.render()}");self.reset_display(v,'windowing');before=self.volume_state(v)
  v.evaluate("()=>{window.displayCurveBefore=cornerstone.utilities.transferFunctionUtils.getTransferFunctionNodes(projectionVP.getActors()[0].actor.getProperty().getRGBTransferFunction(0));const original=projectionVP.setProperties;let once=true;projectionVP.setProperties=function(...args){const r=original.apply(this,args);if(once){once=false;throw Error('SIGMOID PARTIAL FAILURE')}return r}}")
  v.get_by_role('button',name='Reset Windowing',exact=True).click();expect(v.locator('#kin-volume-display [role=status]')).to_have_text('SIGMOID PARTIAL FAILURE');self.preserved_volume(before,self.volume_state(v));self.assertTrue(v.evaluate('()=>JSON.stringify(displayCurveBefore)===JSON.stringify(cornerstone.utilities.transferFunctionUtils.getTransferFunctionNodes(projectionVP.getActors()[0].actor.getProperty().getRGBTransferFunction(0)))'))
 def test_mpr_display_09_actual_cine_and_batch_busy_gates(self):
  a,p,v=self.starting();VolumeCineE2E.cine_open(self,v);VolumeCineE2E.watch_cine(self,v);VolumeCineE2E.cine_play(self,v);v.wait_for_function('()=>cinePositions.length>=3')
  button=v.get_by_role('button',name='Reset Zoom / Pan',exact=True);expect(button).to_be_disabled();button.dispatch_event('click');count=v.evaluate('()=>cinePositions.length');v.wait_for_function('(n)=>cinePositions.length>n',arg=count);VolumeCineE2E.cine_play(self,v);v.wait_for_function("()=>services.cineService.getState().cines['mpr-axial'].isPlaying===false");expect(button).to_be_enabled()
  v.evaluate("()=>{window.displayOriginalBlob=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(...args){if(this.closest('[data-kin-batch-render]')){window.displayHeldBlob=()=>args[0](null);return;}return displayOriginalBlob.apply(this,args)}}")
  for label,value in [('Batch Start Offset','0'),('Batch Interval','1'),('Batch Number','3')]:v.get_by_label(label,exact=True).fill(value)
  v.get_by_role('button',name='Make Batch',exact=True).click();v.wait_for_function('()=>typeof displayHeldBlob==="function"');expect(button).to_be_disabled();v.get_by_role('button',name='Cancel Batch',exact=True).click();v.wait_for_function('()=>!kinVolumeBatchState.busy()');v.evaluate('()=>{displayHeldBlob();HTMLCanvasElement.prototype.toBlob=displayOriginalBlob}');expect(button).to_be_enabled()

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeDisplayE2E(n) for n in loader.getTestCaseNames(VolumeDisplayE2E) if n.startswith('test_mpr_display_'))
if __name__=='__main__':unittest.main(verbosity=2)
