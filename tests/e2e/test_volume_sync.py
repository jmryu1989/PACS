# coding: utf-8
"""TEST-VOLUME-SYNC: explicit three-plane scope, lifecycle and partial failure."""
import copy,os,re,unittest
from pathlib import Path
import numpy as np
from playwright.sync_api import expect
from test_volume_display import VolumeDisplayE2E

class VolumeSyncE2E(VolumeDisplayE2E):
 def volume_state(self,v):
  # VOI propagation finishes in a microtask, rendering in the next native frame.
  # Never pair new properties with pixels from the previous render.
  v.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  return super().volume_state(v)
 def preserved_volume(self,before,after):
  after=copy.deepcopy(after)
  for old,new in zip(before,after):
   # getProperties infers W/L from transfer nodes; exact restored curves can
   # read 1000.0000000000001 instead of 1000. Keep every other field/pixel exact.
   for key,value in old['properties']['voiRange'].items():
    self.assertAlmostEqual(value,new['properties']['voiRange'][key],delta=1e-9)
   new['properties']['voiRange']=copy.deepcopy(old['properties']['voiRange'])
  super().preserved_volume(before,after)
 def sync(self,v,kind,on):
  box=v.get_by_role('checkbox',name='Sync MPR '+kind,exact=True);expect(box).to_be_enabled();box.set_checked(on)
  expect(box).to_be_checked() if on else expect(box).not_to_be_checked()
 def test_sync_01_windowing_zoom_and_selected_reset(self):
  a,p,v=self.starting();original=self.originals();p.locator('#findings').fill('KEEP SYNC REPORT')
  self.sync(v,'Windowing',False);before=self.volume_state(v)
  v.evaluate('()=>{projectionVP.setProperties({voiRange:{lower:0,upper:2000}});projectionVP.render()}');v.wait_for_function('()=>projectionPixel()<100');self.preserved_volume(before[1:],self.volume_state(v)[1:])
  self.sync(v,'Windowing',True);v.evaluate('()=>{projectionVP.setProperties({voiRange:{lower:0,upper:1500}});projectionVP.render()}')
  v.wait_for_function('()=>[...services.viewportGridService.getState().viewports.keys()].every(id=>services.cornerstoneViewportService.getCornerstoneViewport(id).getProperties().voiRange.upper===1500)')
  before=self.volume_state(v);self.reset_display(v,'windowing');self.preserved_volume(before[1:],self.volume_state(v)[1:])
  self.sync(v,'Zoom',True);before=self.volume_state(v);v.evaluate('()=>{projectionVP.setZoom(projectionVP.getZoom()*1.5);projectionVP.render()}')
  v.wait_for_function('()=>[...services.viewportGridService.getState().viewports.keys()].every(id=>Math.abs(services.cornerstoneViewportService.getCornerstoneViewport(id).getZoom()-projectionVP.getZoom())<1e-6)')
  after=self.volume_state(v)
  for old,new in zip(before,after):
   for key in ['focalPoint','position','viewUp','viewPlaneNormal']:np.testing.assert_allclose(old['camera'][key],new['camera'][key],atol=1e-6)
  before=self.volume_state(v);self.reset_display(v,'zoom');self.preserved_volume(before[1:],self.volume_state(v)[1:])
  before=self.volume_state(v);v.evaluate('()=>{const c=projectionVP.getCamera(),d=c.viewUp.map(n=>n*3);projectionVP.setCamera({focalPoint:c.focalPoint.map((n,i)=>n+d[i]),position:c.position.map((n,i)=>n+d[i])});projectionVP.render()}');v.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');self.preserved_volume(before[1:],self.volume_state(v)[1:])
  expect(p.locator('#findings')).to_have_value('KEEP SYNC REPORT');self.assertEqual(self.originals(),original)
 def test_sync_02_restored_layout_and_retired_source_events(self):
  a,p,v=self.starting();self.sync(v,'Windowing',False);self.sync(v,'Zoom',True);self.save_volume(v)
  v.evaluate('()=>window.syncRetired=projectionVP');v.get_by_role('button',name='Restore Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000)
  expect(v.get_by_role('checkbox',name='Sync MPR Zoom',exact=True)).not_to_be_checked();self.sync(v,'Windowing',True);before=self.volume_state(v)
  v.evaluate("()=>syncRetired.element.dispatchEvent(new CustomEvent(cornerstone.Enums.Events.VOI_MODIFIED,{detail:{viewportId:syncRetired.id,range:{lower:0,upper:77}}}))");self.preserved_volume(before,self.volume_state(v))
  v.evaluate('()=>{const view=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);view.setProperties({voiRange:{lower:0,upper:1800}});view.render()}')
  v.wait_for_function('()=>[...services.viewportGridService.getState().viewports.keys()].every(id=>services.cornerstoneViewportService.getCornerstoneViewport(id).getProperties().voiRange.upper===1800)')
 def test_sync_03_partial_peer_failure_and_retry(self):
  a,p,v=self.starting();self.sync(v,'Windowing',False);self.sync(v,'Windowing',True);before=self.volume_state(v)
  v.evaluate("()=>{const ids=[...services.viewportGridService.getState().viewports.keys()],peer=services.cornerstoneViewportService.getCornerstoneViewport(ids[2]),original=peer.setProperties;let once=true;peer.setProperties=function(...args){const r=original.apply(this,args);if(once){once=false;throw Error('SYNC PEER FAILURE')}return r};projectionVP.setProperties({voiRange:{lower:0,upper:1700}});projectionVP.render()}")
  expect(v.locator('#kin-volume-sync [role=status]')).to_contain_text('SYNC PEER FAILURE');expect(v.get_by_role('checkbox',name='Sync MPR Windowing',exact=True)).not_to_be_checked();self.preserved_volume(before[1:],self.volume_state(v)[1:]);self.assertEqual(v.evaluate('()=>projectionVP.getProperties().voiRange.upper'),1700)
  self.sync(v,'Windowing',True);v.evaluate('()=>{projectionVP.setProperties({voiRange:{lower:0,upper:1900}});projectionVP.render()}');v.wait_for_function('()=>[...services.viewportGridService.getState().viewports.keys()].every(id=>services.cornerstoneViewportService.getCornerstoneViewport(id).getProperties().voiRange.upper===1900)')
 def test_sync_04_modal_and_session_release(self):
  a,p,v=self.starting();v.evaluate('()=>{window.syncResizeHook=services.cornerstoneViewportService.performResize;window.syncEngine=projectionVP.getRenderingEngine();window.syncEngineHook=syncEngine.resize}');self.sync(v,'Windowing',False);self.sync(v,'Zoom',True);self.open_note(v)
  expect(v.get_by_role('checkbox',name='Sync MPR Windowing',exact=True)).to_be_disabled();before=self.volume_state(v)
  v.evaluate('()=>{projectionVP.setZoom(projectionVP.getZoom()*1.2);projectionVP.render()}');self.preserved_volume(before[1:],self.volume_state(v)[1:])
  v.locator('#tech-note-close').click();expect(v.get_by_role('checkbox',name='Sync MPR Zoom',exact=True)).to_be_enabled()
  v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(v.locator('#kin-volume-sync')).to_have_count(0)
  self.assertTrue(v.evaluate('()=>window.kinVolumeSynchronization===undefined'))
  self.assertTrue(v.evaluate('()=>services.cornerstoneViewportService.performResize!==syncResizeHook'))
  self.assertTrue(v.evaluate('()=>syncEngine.resize!==syncEngineHook'))
 def test_sync_05_sigmoid_inversion_pixels_and_exact_failure_restore(self):
  a,p,v=self.starting();self.sync(v,'Windowing',False)
  v.evaluate("()=>{window.syncViews=[...services.viewportGridService.getState().viewports.keys()].map(id=>services.cornerstoneViewportService.getCornerstoneViewport(id));syncViews.forEach((view,i)=>{view.setProperties({VOILUTFunction:'SIGMOID'});view.setProperties({voiRange:{lower:0,upper:2000+i*200}});if(i!==1)view.setInvert(true,view.getVolumeId());view.render()})}")
  self.sync(v,'Windowing',True);v.evaluate('()=>{projectionVP.setProperties({voiRange:{lower:0,upper:1500}});projectionVP.setInvert(true,projectionVP.getVolumeId());projectionVP.render()}')
  v.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  actual=v.evaluate("()=>syncViews.map(view=>{const c=view.getCanvas(),xy=view.worldToCanvas([32,32,16]);return {range:view.viewportProperties.voiRange,invert:view.getProperties().invert,value:c.getContext('2d').getImageData(Math.floor(xy[0]*c.width/c.clientWidth),Math.floor(xy[1]*c.height/c.clientHeight),1,1).data[0]}})")
  for i,entry in enumerate(actual):
   self.assertEqual(entry['range'],{'lower':0,'upper':1500});self.assertEqual(entry['invert'],i!=1)
   expected=255/(1+np.exp(-4*(500-750)/1500));self.assertAlmostEqual(entry['value'],255-expected if i!=1 else expected,delta=3)
  for label in v.evaluate("()=>syncViews.map(v=>v.element.closest('.viewport-wrapper').innerText)"):
   match=re.search(r'W:\s*([-\d.]+)\s*L:\s*([-\d.]+)',label);self.assertIsNotNone(match,label)
   self.assertAlmostEqual(float(match[1]),1500,delta=1.01);self.assertAlmostEqual(float(match[2]),750,delta=1.01)
  before=self.volume_state(v)
  v.evaluate("()=>{const peer=syncViews[2],original=peer.setProperties;let once=true;peer.setProperties=function(...args){const result=original.apply(this,args);if(once){once=false;throw Error('SIGMOID PEER FAILURE')}return result};projectionVP.setProperties({voiRange:{lower:0,upper:1800}});projectionVP.render()}")
  expect(v.locator('#kin-volume-sync [role=status]')).to_contain_text('SIGMOID PEER FAILURE');self.preserved_volume(before[1:],self.volume_state(v)[1:])
  self.assertEqual(v.evaluate('()=>syncViews.slice(1).map(v=>v.viewportProperties.voiRange)'),[{'lower':0,'upper':1500}]*2)
 def test_sync_06_save_and_new_login_preserves_display_only(self):
  a,p,v=self.starting();original=self.originals();self.sync(v,'Windowing',False);self.sync(v,'Windowing',True);self.sync(v,'Zoom',True)
  v.evaluate('()=>{projectionVP.setProperties({voiRange:{lower:0,upper:1800}});projectionVP.setZoom(projectionVP.getZoom()*1.3);projectionVP.render()}');self.save_volume(v);saved=self.get_volume_job(a)['snapshot']
  fresh=self.login();self.launch(fresh,[a]);self.ready(fresh);fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000)
  expect(fresh.get_by_role('checkbox',name='Sync MPR Zoom',exact=True)).not_to_be_checked()
  actual=fresh.evaluate('()=>window.kinCreateVolumeJob({grid:services.viewportGridService,cs:services.cornerstoneViewportService,ds:services.displaySetService,studies:new URLSearchParams(location.search).get("StudyInstanceUIDs").split(",")}).capture()')
  self.assertEqual({k:val for k,val in saved['volume'].items() if k!='sourceDigest'},actual['volume']);self.assertEqual(len(saved['volume']['sourceDigest']),64)
  for got,want in zip(actual['cells'],saved['cells']):
   self.assertEqual(got['properties'],want['properties'])
   for key in ['position','focalPoint','viewUp','viewPlaneNormal','parallelScale']:np.testing.assert_allclose(got['camera'][key],want['camera'][key],atol=1e-6)
  self.assertEqual(self.originals(),original)
 def test_sync_07_zoom_partial_failure_restores_peers(self):
  a,p,v=self.starting();self.sync(v,'Zoom',True);before=self.volume_state(v)
  v.evaluate("()=>{const ids=[...services.viewportGridService.getState().viewports.keys()],peer=services.cornerstoneViewportService.getCornerstoneViewport(ids[2]),original=peer.setZoom;let once=true;peer.setZoom=function(...args){const r=original.apply(this,args);if(once){once=false;throw Error('ZOOM PEER FAILURE')}return r};projectionVP.setZoom(projectionVP.getZoom()*1.4);projectionVP.render()}")
  expect(v.locator('#kin-volume-sync [role=status]')).to_contain_text('ZOOM PEER FAILURE');expect(v.get_by_role('checkbox',name='Sync MPR Zoom',exact=True)).not_to_be_checked();self.preserved_volume(before[1:],self.volume_state(v)[1:])
  self.sync(v,'Zoom',True);v.evaluate('()=>{projectionVP.setZoom(projectionVP.getZoom()*1.1);projectionVP.render()}');v.wait_for_function('()=>[...services.viewportGridService.getState().viewports.keys()].every(id=>Math.abs(services.cornerstoneViewportService.getCornerstoneViewport(id).getZoom()-projectionVP.getZoom())<1e-6)')
 def test_sync_08_embedded_owner_loss_blocks_and_recovers(self):
  from test_embedded_patient_copy import EmbeddedPatientCopyE2E
  a,b=self.pair();p,v=EmbeddedPatientCopyE2E.opened(self,a);self.mpr(v);self.choose_volume(p,v,0)
  box=v.get_by_role('checkbox',name='Sync MPR Zoom',exact=True,include_hidden=True);expect(box).to_be_enabled();box.dispatch_event('click');v.evaluate("()=>{const b=document.querySelector('[aria-label=\"Sync MPR Zoom\"]');b.checked=true;b.dispatchEvent(new Event('change'))}");expect(box).to_be_checked();before=self.volume_state(v)
  p.evaluate("()=>{window.syncOwnerKey=KinWorkspaceLayout.key;KinWorkspaceLayout.key=()=>{throw Error('SYNC OWNER LOST')}}");expect(box).to_be_disabled()
  v.evaluate("()=>{const g=services.viewportGridService.getState(),view=services.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId);view.setZoom(view.getZoom()*1.3);view.render()}");self.preserved_volume(before[1:],self.volume_state(v)[1:])
  p.evaluate('()=>KinWorkspaceLayout.key=window.syncOwnerKey');expect(box).to_be_enabled()
 def test_sync_09_missing_asset_keeps_existing_tools(self):
  a,b=self.pair();p=self.login();p.route('**/viewer-volume-sync.js',lambda route:route.abort());v=self.launch(p,[a]);self.ready(v);self.mpr(v);self.choose_volume(v,v,0)
  expect(v.locator('#kin-volume-sync')).to_have_count(0);expect(v.get_by_role('button',name='Reset Planes',exact=True)).to_be_enabled();expect(v.get_by_role('button',name='Reset Windowing',exact=True)).to_be_enabled()
 def test_sync_10_reset_with_windowing_off_and_failed_selected_reset(self):
  a,p,v=self.starting();self.sync(v,'Windowing',False);self.sync(v,'Zoom',True)
  self.reset_display(v,'windowing');before=self.volume_state(v)
  v.evaluate('()=>{projectionVP.setProperties({voiRange:{lower:0,upper:2000}});projectionVP.render()}');self.preserved_volume(before[1:],self.volume_state(v)[1:])
  self.sync(v,'Windowing',True);v.evaluate('()=>{projectionVP.setProperties({voiRange:{lower:0,upper:1800}});projectionVP.setZoom(projectionVP.getZoom()*1.4);projectionVP.render()}');v.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');before=self.volume_state(v)
  v.evaluate("()=>{const original=projectionVP.setCamera;let once=true;projectionVP.setCamera=function(...args){const r=original.apply(this,args);if(once){once=false;throw Error('SELECTED SYNC RESET FAILURE')}return r}}")
  v.get_by_role('button',name='Reset Zoom / Pan',exact=True).click();expect(v.locator('#kin-volume-display [role=status]')).to_contain_text('SELECTED SYNC RESET FAILURE');self.preserved_volume(before,self.volume_state(v))
  v.evaluate("()=>{projectionVP.setProperties({voiRange:{lower:0,upper:2200}});document.querySelector('#kin-volume-display button').click()}");expect(v.locator('#kin-volume-display [role=status]')).to_contain_text('기본 밝기');self.preserved_volume(before[1:],self.volume_state(v)[1:])
 def test_sync_11_transient_target_and_actual_resize_keep_options(self):
  a,p,v=self.starting();self.sync(v,'Windowing',False);self.sync(v,'Zoom',True)
  v.evaluate('()=>{const c=projectionVP.getCanvas();window.syncCanvasWidth=c.width;c.width+=1}');v.wait_for_timeout(550)
  v.evaluate('()=>{projectionVP.getCanvas().width=syncCanvasWidth;projectionVP.render()}')
  expect(v.get_by_role('checkbox',name='Sync MPR Zoom',exact=True)).to_be_checked();expect(v.get_by_role('checkbox',name='Sync MPR Windowing',exact=True)).not_to_be_checked()
  initial_size=v.viewport_size
  v.evaluate('()=>kinVolumeSynchronization.selected(()=>[...services.viewportGridService.getState().viewports.keys()].forEach((id,i)=>{const view=services.cornerstoneViewportService.getCornerstoneViewport(id);view.setZoom(1+i*.2);view.render()}))')
  resize_before=self.volume_state(v);v.set_viewport_size({'width':1100,'height':850});expect(v.get_by_role('checkbox',name='Sync MPR Zoom',exact=True)).to_be_enabled();expect(v.get_by_role('checkbox',name='Sync MPR Zoom',exact=True)).to_be_checked();v.wait_for_timeout(550);resize_after=self.volume_state(v)
  # The native engine changes parallelScale on resize even with Zoom OFF.
  # Compare ON against native OFF from the same per-plane camera and size.
  self.sync(v,'Zoom',False);v.set_viewport_size(initial_size);v.wait_for_timeout(550)
  v.evaluate('cameras=>[...services.viewportGridService.getState().viewports.keys()].forEach((id,i)=>{const view=services.cornerstoneViewportService.getCornerstoneViewport(id),camera={...cameras[i]};delete camera.rotation;view.setCamera(camera);view.render()})',[entry['camera'] for entry in resize_before])
  v.set_viewport_size({'width':1100,'height':850});v.wait_for_timeout(550);native_after=self.volume_state(v)
  for old,new in zip(native_after,resize_after):
   for key in ['parallelScale','position','focalPoint','viewUp','viewPlaneNormal']:np.testing.assert_allclose(old['camera'][key],new['camera'][key],atol=1e-6)
  self.sync(v,'Zoom',True)
  pan_before=self.volume_state(v);v.evaluate('()=>{const c=projectionVP.getCamera(),d=c.viewUp.map(n=>n*3);projectionVP.setCamera({focalPoint:c.focalPoint.map((n,i)=>n+d[i]),position:c.position.map((n,i)=>n+d[i])});projectionVP.render()}');self.preserved_volume(pan_before[1:],self.volume_state(v)[1:])
  before=self.volume_state(v);v.evaluate('()=>{projectionVP.setProperties({voiRange:{lower:0,upper:2000}});projectionVP.render()}');self.preserved_volume(before[1:],self.volume_state(v)[1:])
  v.evaluate('()=>{projectionVP.setZoom(projectionVP.getZoom()*1.3);projectionVP.render()}');v.wait_for_function('()=>[...services.viewportGridService.getState().viewports.keys()].every(id=>Math.abs(services.cornerstoneViewportService.getCornerstoneViewport(id).getZoom()-projectionVP.getZoom())<1e-6)')
 def test_sync_12_native_mouse_windowing_and_zoom(self):
  a,p,v=self.starting();self.sync(v,'Windowing',True);self.sync(v,'Zoom',True);before=self.volume_state(v)
  self.gesture(v,'WindowLevel',45,20);after=self.volume_state(v);self.assertNotEqual(before[0]['properties']['voiRange'],after[0]['properties']['voiRange'])
  for peer in after[1:]:self.assertEqual(peer['properties']['voiRange'],after[0]['properties']['voiRange'])
  self.gesture(v,'Zoom',0,35);v.wait_for_function('()=>[...services.viewportGridService.getState().viewports.keys()].every(id=>Math.abs(services.cornerstoneViewportService.getCornerstoneViewport(id).getZoom()-projectionVP.getZoom())<1e-6)')
  self.sync(v,'Windowing',False);v.evaluate("()=>{projectionVP.setProperties({VOILUTFunction:'SIGMOID'});projectionVP.setProperties({voiRange:{lower:0,upper:1500}});projectionVP.setInvert(true,projectionVP.getVolumeId());projectionVP.render()}");self.sync(v,'Windowing',True)
  self.gesture(v,'WindowLevel',25,10)
  result=v.evaluate("()=>{const v=projectionVP,c=v.getCanvas(),xy=v.worldToCanvas([32,32,16]);return {range:v.viewportProperties.voiRange,invert:v.getProperties().invert,value:c.getContext('2d').getImageData(Math.floor(xy[0]*c.width/c.clientWidth),Math.floor(xy[1]*c.height/c.clientHeight),1,1).data[0]}}")
  self.assertTrue(result['invert']);low,high=result['range']['lower'],result['range']['upper'];expected=255-255/(1+np.exp(-4*(500-(low+high)/2)/(high-low)));self.assertAlmostEqual(result['value'],expected,delta=3)
  if os.environ.get('KIN_EVIDENCE_DIR'):
   folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);v.screenshot(path=str(folder/'mpr-sync-native-mouse.png'))
 def test_sync_13_direct_engine_and_inverted_sigmoid_resize(self):
  a,p,v=self.starting();self.sync(v,'Windowing',True);self.sync(v,'Zoom',True)
  self.assertFalse(v.evaluate('()=>cornerstoneTools.SynchronizerManager.getAllSynchronizers().some(g=>g._eventName===cornerstone.Enums.Events.CAMERA_MODIFIED)'))
  self.assertTrue(v.evaluate("()=>cornerstoneTools.SynchronizerManager.getAllSynchronizers().find(g=>g.id==='mpr')._options.syncInvertState"))
  v.evaluate('()=>kinVolumeSynchronization.selected(()=>[...services.viewportGridService.getState().viewports.keys()].forEach((id,i)=>{const view=services.cornerstoneViewportService.getCornerstoneViewport(id);view.setZoom(1+i*.2);view.render()}))');before=self.volume_state(v)
  v.evaluate('()=>projectionVP.getRenderingEngine().resize()');after=self.volume_state(v)
  for old,new in zip(before,after):
   for key in ['parallelScale','position','focalPoint','viewUp','viewPlaneNormal']:np.testing.assert_allclose(old['camera'][key],new['camera'][key],atol=1e-6)
  v.evaluate("()=>{projectionVP.setProperties({VOILUTFunction:'SIGMOID'});projectionVP.setProperties({voiRange:{lower:0,upper:1500}});projectionVP.setInvert(true,projectionVP.getVolumeId());projectionVP.render()}");self.volume_state(v)
  capture="()=>({range:projectionVP.viewportProperties.voiRange,nodes:cornerstone.utilities.transferFunctionUtils.getTransferFunctionNodes(projectionVP.getActors()[0].actor.getProperty().getRGBTransferFunction(0)),properties:projectionVP.getProperties()})"
  before=v.evaluate(capture);v.set_viewport_size({'width':1100,'height':850});v.wait_for_timeout(550);self.volume_state(v);self.assertEqual(before,v.evaluate(capture))
  value=v.evaluate("()=>{const c=projectionVP.getCanvas(),xy=projectionVP.worldToCanvas([32,32,16]);return c.getContext('2d').getImageData(Math.floor(xy[0]*c.width/c.clientWidth),Math.floor(xy[1]*c.height/c.clientHeight),1,1).data[0]}");self.assertAlmostEqual(value,255-255/(1+np.exp(-4*(500-750)/1500)),delta=3)
 def test_sync_14_native_reset_keeps_other_planes(self):
  a,p,v=self.starting();self.sync(v,'Windowing',True);self.sync(v,'Zoom',True)
  v.evaluate('()=>{projectionVP.setZoom(1.5);projectionVP.setProperties({voiRange:{lower:0,upper:1800}});projectionVP.render()}');before=self.volume_state(v)
  self.choose_volume(v,v,0);v.keyboard.press('Space');v.wait_for_function('()=>Math.abs(projectionVP.getZoom()-1)<1e-6')
  self.preserved_volume(before[1:],self.volume_state(v)[1:])
  self.assertNotEqual(v.evaluate('()=>projectionVP.getProperties().voiRange.upper'),1800)
 def test_sync_15_inversion_does_not_resynchronize_selected_reset(self):
  a,p,v=self.starting();self.sync(v,'Windowing',True)
  v.evaluate('()=>{projectionVP.setProperties({voiRange:{lower:0,upper:1800}});projectionVP.render()}');self.volume_state(v);self.reset_display(v,'windowing');before=self.volume_state(v)
  v.evaluate('()=>{projectionVP.setProperties({invert:true});projectionVP.render()}');self.preserved_volume(before[1:],self.volume_state(v)[1:])
  self.assertTrue(v.evaluate('()=>projectionVP.getProperties().invert'))
  v.evaluate('()=>{projectionVP.setProperties({voiRange:{lower:0,upper:1700},invert:false});projectionVP.render()}')
  v.wait_for_function('()=>[...services.viewportGridService.getState().viewports.keys()].every(id=>services.cornerstoneViewportService.getCornerstoneViewport(id).getProperties().voiRange.upper===1700)');self.assertFalse(v.evaluate('()=>projectionVP.getProperties().invert'))
  self.gesture(v,'WindowLevel',25,10);after=self.volume_state(v);self.assertNotEqual(after[0]['properties']['voiRange']['upper'],1700)
  for peer in after[1:]:self.assertEqual(peer['properties']['voiRange'],after[0]['properties']['voiRange'])

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeSyncE2E(n) for n in loader.getTestCaseNames(VolumeSyncE2E) if n.startswith('test_sync_'))
if __name__=='__main__':unittest.main(verbosity=2)
