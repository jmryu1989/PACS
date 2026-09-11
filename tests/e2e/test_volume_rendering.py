# coding: utf-8
"""TEST-VR-DISPLAY: separate native 3D actor and retained MPR workspace."""
import os,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_volume_current_print import VolumeCurrentPrintE2E

class VolumeRenderingE2E(VolumeCurrentPrintE2E):
 def vr(self,v):
  v.get_by_role('button',name='Open Volume Rendering',exact=True).click();expect(v.locator('#kin-volume-rendering [role=status]')).to_contain_text('VR 원본을 표시했습니다',timeout=45000)
  v.wait_for_function("()=>{const el=document.querySelector('[data-kin-vr-render]'),vp=cornerstone.getEnabledElement(el)?.viewport,c=vp?.getCanvas();if(!c?.width)return false;const b=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return b.some((n,i)=>i%4!==3&&n>0)}")
  return v.locator('#kin-volume-rendering')
 def vr_state(self,v):
  return v.evaluate("()=>{const view=cornerstone.getEnabledElement(document.querySelector('[data-kin-vr-render]')).viewport,actor=view.getActors()[0].actor,curve=actor.getProperty().getScalarOpacity(0);return {camera:view.getCamera(),nodes:Array.from({length:curve.getSize()},(_,i)=>{const n=[];curve.getNodeValue(i,n);return n}),shade:actor.getProperty().getShade(),type:view.type}}")
 def vr_pixels(self,v):
  v.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  return v.evaluate("()=>{const c=cornerstone.getEnabledElement(document.querySelector('[data-kin-vr-render]')).viewport.getCanvas(),b=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let xmin=c.width,xmax=-1,ymin=c.height,ymax=-1,count=0;for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4;if(Math.max(b[i],b[i+1],b[i+2])>5){count++;xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);ymin=Math.min(ymin,y);ymax=Math.max(ymax,y);}}return {count,width:xmax-xmin+1,height:ymax-ymin+1}}")
 def test_vr_01_native_rotation_display_reset_and_preservation(self):
  a,p,v=self.starting();marks=self.add_mark(v);before=self.rows();original=self.originals();state=self.volume_state(v);native=self.native_pixels(v);dialog=self.vr(v);initial=self.vr_state(v);self.assertEqual(initial['type'],'volume3d');self.assertGreater(max(n[1] for n in initial['nodes']),0)
  layout=v.evaluate("()=>{const rect=e=>{const r=e.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom]};return {screen:[innerWidth,innerHeight],dialog:rect(document.querySelector('#kin-volume-rendering')),canvas:rect(document.querySelector('[data-kin-vr-render]'))}}")
  for name in ['dialog','canvas']:
   bounds=layout[name];self.assertGreaterEqual(min(bounds[:2]),-1);self.assertLessEqual(bounds[2],layout['screen'][0]+1);self.assertLessEqual(bounds[3],layout['screen'][1]+1)
  self.assertGreaterEqual(layout['canvas'][0],layout['dialog'][0]);self.assertGreaterEqual(layout['canvas'][1],layout['dialog'][1]);self.assertLessEqual(layout['canvas'][2],layout['dialog'][2]);self.assertLessEqual(layout['canvas'][3],layout['dialog'][3]);print('VR_VISIBLE_LAYOUT',layout,flush=True)
  dialog.locator('[data-kin-vr-render]').scroll_into_view_if_needed();box=dialog.locator('[data-kin-vr-render]').bounding_box();v.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2);v.mouse.down();v.mouse.move(box['x']+box['width']/2+90,box['y']+box['height']/2+40,steps=12);v.mouse.up();rotated=self.vr_state(v);self.assertNotEqual(rotated['camera']['viewPlaneNormal'],initial['camera']['viewPlaneNormal']);self.assertEqual(rotated['camera']['focalPoint'],initial['camera']['focalPoint'])
  expect(dialog.get_by_label('View From',exact=True)).to_have_value('Custom')
  v.mouse.wheel(0,-120);v.wait_for_function("scale=>cornerstone.getEnabledElement(document.querySelector('[data-kin-vr-render]')).viewport.getCamera().parallelScale<scale",arg=rotated['camera']['parallelScale']);self.assertLess(self.vr_state(v)['camera']['parallelScale'],rotated['camera']['parallelScale']);dialog.get_by_label('View From',exact=True).select_option('Left');self.assertEqual(self.vr_state(v)['camera']['viewPlaneNormal'],[1,0,0]);dialog.get_by_label('VR Opacity',exact=True).fill('50');dialog.get_by_label('VR Shading',exact=True).check();dialog.get_by_role('button',name='Apply Display',exact=True).click();changed=self.vr_state(v)
  for left,right in zip(initial['nodes'],changed['nodes']):self.assertEqual(left[0],right[0]);self.assertAlmostEqual(left[1]/2,right[1],delta=1e-10)
  self.assertTrue(changed['shade']);dialog.get_by_role('button',name='Reset VR',exact=True).click();self.assertEqual(self.vr_state(v),initial);self.preserved_volume(state,self.volume_state(v));self.assertEqual(self.native_pixels(v),native);self.same_marks(v.evaluate('()=>kinMprMarks.capture(true)'),marks);self.assertTrue(v.evaluate('()=>kinMprMarks.dirty()'));self.unchanged_rows(before);self.assertEqual(self.originals(),original)
  if os.environ.get('KIN_EVIDENCE_DIR'):v.screenshot(path=str(Path(os.environ['KIN_EVIDENCE_DIR'])/'volume-rendering.png'))
  dialog.get_by_role('button',name='Close VR',exact=True).click();expect(dialog).not_to_be_visible();self.assertEqual(v.evaluate("()=>projectionVP.getRenderingEngine().getViewports().filter(v=>v.id.startsWith('kin-vr-')).length"),0);self.assertEqual(self.native_pixels(v),native)
 def test_vr_02_known_box_geometry_opacity_and_preset_isolation(self):
  a,p,v=self.opened_projection(constant=True);native=self.native_pixels(v);before=self.volume_state(v);dialog=self.vr(v);baseline=self.vr_state(v);front=self.vr_pixels(v);self.assertGreater(front['count'],1000);self.assertAlmostEqual(front['width']/front['height'],64/33,delta=.12)
  dialog.get_by_label('View From',exact=True).select_option('Superior');top=self.vr_pixels(v);self.assertGreater(top['count'],1000);self.assertAlmostEqual(top['width']/top['height'],1,delta=.04);print('VR_BOX',{'front':front,'top':top},flush=True)
  dialog.get_by_label('VR Opacity',exact=True).fill('0');dialog.get_by_role('button',name='Apply Display',exact=True).click();self.assertEqual(self.vr_pixels(v)['count'],0);self.assertEqual(self.native_pixels(v),native)
  dialog.get_by_label('VR Opacity',exact=True).fill('100');dialog.get_by_role('button',name='Apply Display',exact=True).click();self.assertEqual(self.vr_state(v)['nodes'],baseline['nodes']);self.assertGreater(self.vr_pixels(v)['count'],1000)
  dialog.get_by_label('VR Preset',exact=True).select_option('CT-Soft-Tissue');dialog.get_by_role('button',name='Apply Display',exact=True).click();self.assertNotEqual(self.vr_state(v)['nodes'],baseline['nodes']);self.preserved_volume(before,self.volume_state(v));self.assertEqual(self.native_pixels(v),native)
 def test_vr_03_missing_asset_and_renderer_failure_retry(self):
  a,p,v=self.starting();native=self.native_pixels(v);before=self.rows();v.route('**/viewer-volume-rendering.js',lambda route:route.abort());v.get_by_role('button',name='Open Volume Rendering',exact=True).click();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('VR 도구를 불러오지 못했습니다');v.unroute('**/viewer-volume-rendering.js')
  v.evaluate("()=>{const e=projectionVP.getRenderingEngine(),enable=e.enableElement;e.enableElement=function(options){const r=enable.call(this,options);if(options.type==='volume3d'){e.enableElement=enable;this.getViewport(options.viewportId).setVolumes=async()=>{throw Error('INJECTED VR VOLUME FAILURE')}}return r}}")
  v.get_by_role('button',name='Open Volume Rendering',exact=True).click();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('INJECTED VR VOLUME FAILURE');expect(v.locator('#kin-volume-rendering')).not_to_be_visible();self.assertEqual(v.evaluate("()=>projectionVP.getRenderingEngine().getViewports().filter(v=>v.id.startsWith('kin-vr-')).length"),0);self.assertEqual(self.native_pixels(v),native);self.vr(v);self.unchanged_rows(before)
 def test_vr_04_pending_annotation_readonly_and_access_revocation(self):
  a,p,v=self.starting();panel=self.marks(v);panel.get_by_label('MPR annotation label',exact=True).fill('KEEP VR PENDING');dialog=self.vr(v);dialog.get_by_role('button',name='Close VR',exact=True).click();expect(panel.get_by_label('MPR annotation label',exact=True)).to_have_value('KEEP VR PENDING');self.assertTrue(v.evaluate('()=>kinMprMarks.dirty()'))
  fresh=self.launch(self.login('tech'),[a]);self.ready(fresh);self.mpr(fresh);self.choose_volume(fresh,fresh,0);before=self.rows();dialog=self.vr(fresh)
  fresh.route('**/api/studies/*/viewer-jobs',lambda route:route.fulfill(status=403,content_type='application/json',body='{}'));expect(dialog).not_to_be_visible(timeout=20000);self.unchanged_rows(before);self.assertEqual(self.jobs(a),[])
 def test_vr_05_close_pending_source_and_session_cleanup(self):
  a,p,v=self.starting();native=self.native_pixels(v);marks=self.add_mark(v);before=self.rows()
  v.evaluate("()=>{const f=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).includes('/viewer-jobs')){window.vrWaiting=true;await new Promise(r=>window.releaseVR=r)}return f(...args)};window.restoreVRFetch=()=>window.fetch=f}")
  v.get_by_role('button',name='Open Volume Rendering',exact=True).click();v.wait_for_function('()=>window.vrWaiting');v.locator('#kin-volume-rendering').get_by_role('button',name='Close VR',exact=True).click();v.evaluate('()=>{window.restoreVRFetch();window.releaseVR()}');expect(v.get_by_role('button',name='Open Volume Rendering',exact=True)).to_be_enabled();dialog=self.vr(v);self.same_marks(v.evaluate('()=>kinMprMarks.capture(true)'),marks);self.assertEqual(self.native_pixels(v),native)
  v.evaluate("()=>window.dispatchEvent(new StorageEvent('storage',{key:'kin-session-ended',newValue:String(Date.now())}))");expect(dialog).not_to_be_visible();self.assertEqual(v.evaluate("()=>projectionVP.getRenderingEngine().getViewports().filter(v=>v.id.startsWith('kin-vr-')).length"),0);self.unchanged_rows(before)
 def test_vr_06_partial_native_failure_closes_only_vr(self):
  a,p,v=self.starting();native=self.native_pixels(v);state=self.volume_state(v);marks=self.add_mark(v);before=self.rows();dialog=self.vr(v)
  v.evaluate("()=>{const vp=cornerstone.getEnabledElement(document.querySelector('[data-kin-vr-render]')).viewport,apply=vp.setProperties;vp.setProperties=function(...args){vp.setProperties=apply;apply.apply(this,args);const c=vp.getActors()[0].actor.getProperty().getScalarOpacity(0),node=[];c.getNodeValue(c.getSize()-1,node);node[1]*=.5;c.setNodeValue(c.getSize()-1,node);window.vrPartialFailureInjected=true;throw Error('PARTIAL VR OPACITY FAILURE')}}")
  dialog.get_by_label('VR Opacity',exact=True).fill('50');dialog.get_by_role('button',name='Apply Display',exact=True).click();self.assertTrue(v.evaluate('()=>window.vrPartialFailureInjected===true'));expect(dialog).not_to_be_visible();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('PARTIAL VR OPACITY FAILURE');self.preserved_volume(state,self.volume_state(v));self.assertEqual(self.native_pixels(v),native);self.same_marks(v.evaluate('()=>kinMprMarks.capture()'),marks)
  dialog=self.vr(v);v.evaluate("()=>{const vp=cornerstone.getEnabledElement(document.querySelector('[data-kin-vr-render]')).viewport;vp.setCamera=()=>{throw Error('VR CAMERA FAILURE')}}");dialog.get_by_label('View From',exact=True).select_option('Left');expect(dialog).not_to_be_visible();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('VR CAMERA FAILURE');expect(v.get_by_text('Sorry, something went wrong there. Try again.',exact=True)).to_have_count(0);self.preserved_volume(state,self.volume_state(v));self.assertEqual(self.native_pixels(v),native);self.unchanged_rows(before);self.vr(v)
 def test_vr_07_blank_pending_identity_hotkeys_and_selection_close(self):
  a,p,v=self.starting();dialog=self.vr(v);expect(dialog.locator('details')).to_contain_text(a.uid);before=self.volume_state(v);dialog.get_by_role('button',name='Close VR',exact=True).focus()
  for key in ['i','ArrowDown','ArrowUp','r','1','2']:v.keyboard.press(key)
  self.preserved_volume(before,self.volume_state(v));v.keyboard.press('Escape');expect(dialog).not_to_be_visible();expect(dialog.locator('details p')).to_have_text('');expect(dialog.locator(':scope > p').first).to_have_text('')
  v.evaluate("()=>{const f=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).includes('/viewer-jobs')){window.vrWaiting=true;await new Promise(r=>window.releaseVR=r)}return f(...args)};window.restoreVRFetch=()=>window.fetch=f}");v.get_by_role('button',name='Open Volume Rendering',exact=True).click();v.wait_for_function('()=>window.vrWaiting');expect(dialog.locator('details p')).to_have_text('');expect(dialog.locator(':scope > p').first).to_have_text('');v.evaluate('()=>{window.restoreVRFetch();window.releaseVR()}');expect(dialog.locator('[role=status]')).to_contain_text('VR 원본을 표시했습니다');expect(dialog.locator('details')).to_contain_text(a.uid)
  v.evaluate("()=>{const s=services.viewportGridService.getState(),next=[...s.viewports.keys()].find(id=>id!==s.activeViewportId);services.viewportGridService.setActiveViewportId(next)}");expect(dialog).not_to_be_visible();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('원본');expect(dialog.locator('details p')).to_have_text('')
 def test_vr_08_signed_and_rescaled_hu_use_same_transfer_function(self):
  from test_volume_projection import phantom
  pixels=[]
  for signed,intercept in [(False,-580),(True,444)]:
   a=phantom(self.stack,intercept=intercept,constant=True,signed=signed);v=self.launch(self.login(),[a]);self.ready(v);self.mpr(v);self.choose_volume(v,v,0);v.get_by_role('button',name='Open Volume Rendering',exact=True).click();dialog=v.locator('#kin-volume-rendering');expect(dialog.locator('[role=status]')).to_contain_text('VR 원본을 표시했습니다',timeout=45000);self.assertEqual(self.vr_pixels(v)['count'],0)
   dialog.get_by_label('VR Preset',exact=True).select_option('CT-Fat');dialog.get_by_role('button',name='Apply Display',exact=True).click();self.assertGreater(self.vr_pixels(v)['count'],1000)
   sample=v.evaluate("()=>{const view=cornerstone.getEnabledElement(document.querySelector('[data-kin-vr-render]')).viewport,c=view.getCanvas(),curve=view.getActors()[0].actor.getProperty().getScalarOpacity(0),volume=cornerstone.cache.getVolume(view.getVolumeId());return {value:volume.voxelManager.getAtIJK(0,0,0),opacity:curve.getValue(-80),pixel:Array.from(c.getContext('2d').getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data)}}");self.assertEqual(sample['value'],-80);self.assertGreater(sample['opacity'],0);pixels.append(sample['pixel']);dialog.get_by_role('button',name='Close VR',exact=True).click()
  self.assertEqual(pixels[0],pixels[1]);print('VR_SIGNED_HU',pixels,flush=True)
 def test_vr_09_loading_ignores_pointer_and_wheel(self):
  a,p,v=self.starting();before=self.volume_state(v)
  v.evaluate("()=>{const e=projectionVP.getRenderingEngine(),enable=e.enableElement;e.enableElement=function(options){const r=enable.call(this,options);if(options.type==='volume3d'){e.enableElement=enable;const view=e.getViewport(options.viewportId),set=view.setVolumes;view.setVolumes=async function(...args){window.vrLoadWaiting=true;await new Promise(r=>window.releaseVRLoad=r);return set.apply(this,args)}}return r}}")
  v.get_by_role('button',name='Open Volume Rendering',exact=True).click();v.wait_for_function('()=>window.vrLoadWaiting');dialog=v.locator('#kin-volume-rendering');dialog.locator('[data-kin-vr-render]').scroll_into_view_if_needed();box=dialog.locator('[data-kin-vr-render]').bounding_box();v.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2);v.mouse.wheel(0,-100);v.mouse.down();v.mouse.move(box['x']+box['width']/2+40,box['y']+box['height']/2+20);v.mouse.up();v.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');expect(dialog).to_be_visible();expect(dialog.get_by_role('button',name='Apply Display',exact=True)).to_be_disabled();self.preserved_volume(before,self.volume_state(v));v.evaluate('()=>window.releaseVRLoad()');expect(dialog.locator('[role=status]')).to_contain_text('VR 원본을 표시했습니다');expect(dialog.get_by_role('button',name='Apply Display',exact=True)).to_be_enabled();self.assertGreater(self.vr_pixels(v)['count'],1000);dialog.get_by_role('button',name='Close VR',exact=True).click();self.preserved_volume(before,self.volume_state(v))
 def test_vr_10_return_to_current_print_and_saved_job(self):
  a,p,v=self.starting();self.add_mark(v,'VR workflow mark');self.marks(v).get_by_label('Show Annotations',exact=True).uncheck();native=self.native_pixels(v);marks=v.evaluate('()=>kinMprMarks.capture()');before=self.rows();dialog=self.vr(v);dialog.get_by_label('VR Preset',exact=True).select_option('CT-Fat');dialog.get_by_role('button',name='Apply Display',exact=True).click();dialog.get_by_label('View From',exact=True).select_option('Superior');dialog.get_by_role('button',name='Close VR',exact=True).click()
  paper=self.current_output(v);self.assertEqual(self.print_pixels(paper),native);expect(paper.locator('[data-annotation-id]')).to_have_count(3);self.unchanged_rows(before);v.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click();self.save_volume(v);job=self.get_volume_job(a);self.assertEqual(job['snapshot']['version'],6);self.same_marks(job['snapshot']['marks'],marks)
  fresh=self.login();fresh.set_viewport_size(v.evaluate('()=>({width:innerWidth,height:innerHeight})'));self.launch(fresh,[a]);self.ready(fresh);fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000);self.same_marks(fresh.evaluate('()=>kinMprMarks.capture()'),marks);self.assertEqual(self.native_pixels(fresh),native);self.assertEqual(len(self.jobs(a)),1)

 def test_vr_11_crop_voxel_edges_pixels_invalid_and_reset(self):
  a,p,v=self.opened_projection(constant=True);native=self.native_pixels(v);before=self.volume_state(v);original=self.originals();dialog=self.vr(v);initial=self.vr_state(v);full=self.vr_pixels(v)
  dialog.get_by_label('I Max',exact=True).fill('31');dialog.get_by_role('button',name='Apply Crop',exact=True).click()
  cropped=self.vr_pixels(v);self.assertGreater(cropped['count'],0);self.assertAlmostEqual(cropped['width']/full['width'],.5,delta=.08);self.assertAlmostEqual(cropped['height']/full['height'],1,delta=.04)
  planes=v.evaluate("()=>cornerstone.getEnabledElement(document.querySelector('[data-kin-vr-render]')).viewport.getActors()[0].actor.getMapper().getClippingPlanes().map(p=>({origin:Array.from(p.getOrigin()),normal:Array.from(p.getNormal())}))")
  self.assertEqual(len(planes),6)
  dialog.get_by_label('View From',exact=True).select_option('Superior');expect(dialog).to_be_visible()
  self.assertEqual(v.evaluate("()=>cornerstone.getEnabledElement(document.querySelector('[data-kin-vr-render]')).viewport.getActors()[0].actor.getMapper().getClippingPlanes().map(p=>({origin:Array.from(p.getOrigin()),normal:Array.from(p.getNormal())}))"),planes)
  dialog.get_by_label('View From',exact=True).select_option('Anterior');self.assertEqual(self.vr_pixels(v),cropped)
  for bad in ['', '-1', '64', '1.5']:
   dialog.get_by_label('I Max',exact=True).fill(bad);dialog.get_by_role('button',name='Apply Crop',exact=True).click();expect(dialog).to_be_visible();self.assertEqual(self.vr_pixels(v),cropped)
  dialog.get_by_role('button',name='Reset VR',exact=True).click();expect(dialog.get_by_label('I Max',exact=True)).to_have_value('63');self.assertEqual(self.vr_state(v),initial);self.assertEqual(self.vr_pixels(v),full);self.preserved_volume(before,self.volume_state(v));self.assertEqual(self.native_pixels(v),native);self.assertEqual(self.originals(),original)

 def test_vr_12_custom_transfer_validation_opacity_and_reopen(self):
  a,p,v=self.opened_projection(constant=True);native=self.native_pixels(v);before=self.volume_state(v);dialog=self.vr(v);initial=self.vr_state(v)
  expect(dialog.get_by_label('Knot 1 HU',exact=True)).not_to_be_visible();dialog.get_by_label('Transfer Mode',exact=True).select_option('Custom');expect(dialog.get_by_label('Knot 1 HU',exact=True)).to_be_visible()
  for i,hu in [(1,'-1000'),(2,'2000')]:
   dialog.get_by_label('Knot '+str(i)+' HU',exact=True).fill(hu);dialog.get_by_label('Knot '+str(i)+' Color',exact=True).fill('#ff0000');dialog.get_by_label('Knot '+str(i)+' Opacity',exact=True).fill('1')
  dialog.get_by_role('button',name='Apply Display',exact=True).click();custom=self.vr_state(v);self.assertEqual([n[:2] for n in custom['nodes']],[[-1000,1],[2000,1]])
  # Native render queues a frame; sample only after it has copied to the visible canvas.
  self.assertGreater(self.vr_pixels(v)['count'],0)
  rgb=v.evaluate("()=>{const c=cornerstone.getEnabledElement(document.querySelector('[data-kin-vr-render]')).viewport.getCanvas();return Array.from(c.getContext('2d').getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data)}")
  self.assertGreater(rgb[0],20);self.assertLess(rgb[1],5);self.assertLess(rgb[2],5);print('VR_CUSTOM_RGB',rgb,flush=True)
  dialog.get_by_label('Knot 2 HU',exact=True).fill('-1000');dialog.get_by_role('button',name='Apply Display',exact=True).click();self.assertEqual(self.vr_state(v),custom);expect(dialog.get_by_label('Knot 2 HU',exact=True)).to_have_value('-1000')
  dialog.get_by_label('Knot 2 HU',exact=True).fill('2000');dialog.get_by_label('VR Opacity',exact=True).fill('50');dialog.get_by_role('button',name='Apply Display',exact=True).click();half=self.vr_state(v);self.assertEqual([n[1] for n in half['nodes']],[.5,.5]);dialog.get_by_role('button',name='Apply Display',exact=True).click();self.assertEqual(self.vr_state(v),half)
  dialog.get_by_role('button',name='Reset VR',exact=True).click();expect(dialog.get_by_label('Transfer Mode',exact=True)).to_have_value('Preset');expect(dialog.get_by_label('Knot 1 HU',exact=True)).not_to_be_visible();expect(dialog.locator('.kin-vr-knots')).not_to_be_visible();self.assertEqual(self.vr_state(v),initial);self.preserved_volume(before,self.volume_state(v));self.assertEqual(self.native_pixels(v),native)
  dialog.get_by_role('button',name='Close VR',exact=True).click();dialog=self.vr(v);expect(dialog.get_by_label('Transfer Mode',exact=True)).to_have_value('Preset');expect(dialog.get_by_label('Knot 1 HU',exact=True)).not_to_be_visible();expect(dialog.locator('.kin-vr-knots')).not_to_be_visible();self.assertEqual(self.vr_state(v),initial)

 def test_vr_13_personal_display_save_reopen_replace_and_delete(self):
  a,p,v=self.opened_projection(constant=True);native=self.native_pixels(v);before=self.volume_state(v);dialog=self.vr(v)
  dialog.get_by_label('VR Opacity',exact=True).fill('40');dialog.get_by_label('VR Shading',exact=True).check();dialog.get_by_role('button',name='Apply Display',exact=True).click();saved=self.vr_state(v)
  dialog.get_by_label('Preset Name',exact=True).fill('Bone 40');dialog.get_by_role('button',name='Save New Preset',exact=True).click();dialog.get_by_label('Saved Presets',exact=True).select_option(label='Bone 40')
  dialog.get_by_role('button',name='Close VR',exact=True).click();dialog=self.vr(v);self.assertNotEqual(self.vr_state(v)['nodes'],saved['nodes']);dialog.get_by_label('Saved Presets',exact=True).select_option(label='Bone 40');dialog.get_by_role('button',name='Load Preset',exact=True).click();self.assertEqual(self.vr_state(v),saved)
  dialog.get_by_label('I Max',exact=True).fill('31');dialog.get_by_role('button',name='Apply Crop',exact=True).click();crop=self.vr_pixels(v);dialog.get_by_role('button',name='Load Preset',exact=True).click();self.assertEqual(self.vr_pixels(v),crop);expect(dialog.get_by_label('I Max',exact=True)).to_have_value('31')
  dialog.get_by_label('VR Opacity',exact=True).fill('60');dialog.get_by_role('button',name='Apply Display',exact=True).click();replacement=self.vr_state(v);dialog.get_by_role('button',name='Replace Preset',exact=True).click();dialog.get_by_role('button',name='Reset VR',exact=True).click();dialog.get_by_label('Saved Presets',exact=True).select_option(label='Bone 40');dialog.get_by_role('button',name='Load Preset',exact=True).click();self.assertEqual(self.vr_state(v),replacement)
  dialog.get_by_role('button',name='Delete Preset',exact=True).click();expect(dialog.get_by_label('Saved Presets',exact=True)).not_to_contain_text('Bone 40');self.preserved_volume(before,self.volume_state(v));self.assertEqual(self.native_pixels(v),native)

 def test_vr_14_personal_display_pending_edits_conflict_and_storage_failure(self):
  a,p,v=self.opened_projection(constant=True);dialog=self.vr(v);dialog.get_by_label('Preset Name',exact=True).fill('Keep Me');dialog.get_by_role('button',name='Save New Preset',exact=True).click();dialog.get_by_label('Saved Presets',exact=True).select_option(label='Keep Me');saved=self.vr_state(v)
  dialog.get_by_label('VR Opacity',exact=True).fill('25');dialog.get_by_role('button',name='Replace Preset',exact=True).click();expect(dialog.locator('[role=status]')).to_contain_text('적용');self.assertEqual(self.vr_state(v),saved);expect(dialog.get_by_label('VR Opacity',exact=True)).to_have_value('25')
  dialog.get_by_role('button',name='Apply Display',exact=True).click();applied=self.vr_state(v);dialog.get_by_label('Preset Name',exact=True).fill('Keep Me');dialog.get_by_role('button',name='Save New Preset',exact=True).click();expect(dialog.locator('[role=status]')).to_contain_text('이름');self.assertEqual(self.vr_state(v),applied)
  v.evaluate("()=>{const key=Object.keys(localStorage).find(k=>k.startsWith('kin-vr-display-presets:v1:'));window.vrLibraryKey=key;const data=JSON.parse(localStorage.getItem(key));data.presets.push({name:'Other Window',display:data.presets[0].display});localStorage.setItem(key,JSON.stringify(data))}")
  dialog.get_by_role('button',name='Replace Preset',exact=True).click();expect(dialog.locator('[role=status]')).to_contain_text('다른');expect(dialog.get_by_label('VR Opacity',exact=True)).to_have_value('25');self.assertEqual(self.vr_state(v),applied)
  dialog.get_by_role('button',name='Reload Presets',exact=True).click();expect(dialog.get_by_label('Saved Presets',exact=True)).to_contain_text('Other Window');self.assertEqual(self.vr_state(v),applied)
  dialog.get_by_label('Saved Presets',exact=True).select_option(label='Keep Me');v.evaluate("()=>{window.vrSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('kin-vr-display-presets:v1:'))throw Error('INJECTED STORAGE FAILURE');return window.vrSetItem.call(this,k,v)}}")
  dialog.get_by_role('button',name='Replace Preset',exact=True).click();expect(dialog.locator('[role=status]')).to_contain_text('저장');self.assertEqual(self.vr_state(v),applied);v.evaluate('()=>Storage.prototype.setItem=window.vrSetItem');dialog.get_by_role('button',name='Replace Preset',exact=True).click();dialog.get_by_role('button',name='Reset VR',exact=True).click();dialog.get_by_label('Saved Presets',exact=True).select_option(label='Keep Me');dialog.get_by_role('button',name='Load Preset',exact=True).click();self.assertEqual(self.vr_state(v),applied)

 def test_vr_15_custom_preset_reuse_other_study_and_owner_isolation(self):
  from test_volume_projection import phantom
  a,p,v=self.opened_projection(constant=True);dialog=self.vr(v);dialog.get_by_label('Transfer Mode',exact=True).select_option('Custom')
  for i,hu in [(1,'-1000'),(2,'2000')]:
   dialog.get_by_label('Knot '+str(i)+' HU',exact=True).fill(hu);dialog.get_by_label('Knot '+str(i)+' Color',exact=True).fill('#ff0000');dialog.get_by_label('Knot '+str(i)+' Opacity',exact=True).fill('1')
  dialog.get_by_label('VR Opacity',exact=True).fill('35');dialog.get_by_role('button',name='Apply Display',exact=True).click();saved=self.vr_state(v);dialog.get_by_label('Preset Name',exact=True).fill('Reusable Red');dialog.get_by_role('button',name='Save New Preset',exact=True).click();expect(dialog.locator('[role=status]')).to_contain_text('VR 프리셋을 저장했습니다.');expect(dialog.get_by_label('Saved Presets',exact=True)).to_have_value('Reusable Red')
  entry=v.evaluate("()=>{const key=Object.keys(localStorage).find(k=>k.startsWith('kin-vr-display-presets:v1:'));return {key,raw:localStorage.getItem(key)}}");self.assertNotIn(a.uid,entry['raw']);dialog.get_by_role('button',name='Close VR',exact=True).click()
  b=phantom(self.stack,constant=True);fresh=self.launch(p.context.new_page(),[b]);self.ready(fresh);self.mpr(fresh);self.choose_volume(fresh,fresh,0);native=self.native_pixels(fresh);before=self.volume_state(fresh);dialog=self.vr(fresh)
  dialog.get_by_label('Saved Presets',exact=True).select_option(label='Reusable Red');dialog.get_by_role('button',name='Load Preset',exact=True).click();self.assertEqual(self.vr_state(fresh)['nodes'],saved['nodes']);expect(dialog.get_by_label('Transfer Mode',exact=True)).to_have_value('Custom');expect(dialog.get_by_label('Knot 1 Color',exact=True)).to_have_value('#ff0000');self.preserved_volume(before,self.volume_state(fresh));self.assertEqual(self.native_pixels(fresh),native)
  other=self.login('tech');other.evaluate('entry=>localStorage.setItem(entry.key,entry.raw)',entry);self.launch(other,[b]);self.ready(other);self.mpr(other);self.choose_volume(other,other,0);other_dialog=self.vr(other);self.assertNotIn('Reusable Red',other_dialog.get_by_label('Saved Presets',exact=True).locator('option').all_text_contents());self.assertEqual(other.evaluate('key=>localStorage.getItem(key)',entry['key']),entry['raw'])

 def test_vr_16_corrupt_library_and_native_load_failure_preserve_work(self):
  a,p,v=self.opened_projection(constant=True);native=self.native_pixels(v);before=self.volume_state(v);dialog=self.vr(v);dialog.get_by_label('Preset Name',exact=True).fill('Recover');dialog.get_by_role('button',name='Save New Preset',exact=True).click();dialog.get_by_label('Saved Presets',exact=True).select_option(label='Recover');initial=self.vr_state(v)
  v.evaluate("()=>{window.vrLibraryKey=Object.keys(localStorage).find(k=>k.startsWith('kin-vr-display-presets:v1:'));window.vrLibraryRaw=localStorage.getItem(vrLibraryKey);localStorage.setItem(vrLibraryKey,'BROKEN JSON')}");dialog.get_by_role('button',name='Reload Presets',exact=True).click();expect(dialog.locator('[role=status]')).to_contain_text('손상');self.assertEqual(self.vr_state(v),initial);dialog.get_by_label('Preset Name',exact=True).fill('Do Not Overwrite');dialog.get_by_role('button',name='Save New Preset',exact=True).click();self.assertEqual(v.evaluate('()=>localStorage.getItem(vrLibraryKey)'),'BROKEN JSON');expect(dialog.get_by_label('Preset Name',exact=True)).to_have_value('Do Not Overwrite')
  v.evaluate('()=>localStorage.setItem(vrLibraryKey,vrLibraryRaw)');dialog.get_by_role('button',name='Reload Presets',exact=True).click();dialog.get_by_label('Saved Presets',exact=True).select_option(label='Recover')
  v.evaluate("()=>{const vp=cornerstone.getEnabledElement(document.querySelector('[data-kin-vr-render]')).viewport,apply=vp.setProperties;vp.setProperties=function(...args){apply.apply(this,args);throw Error('INJECTED PRESET LOAD FAILURE')}}");dialog.get_by_role('button',name='Load Preset',exact=True).click();expect(dialog).not_to_be_visible();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('INJECTED PRESET LOAD FAILURE');self.preserved_volume(before,self.volume_state(v));self.assertEqual(self.native_pixels(v),native)
  dialog=self.vr(v);dialog.get_by_label('Saved Presets',exact=True).select_option(label='Recover');dialog.get_by_role('button',name='Load Preset',exact=True).click();self.assertEqual(self.vr_state(v),initial)

 def test_vr_17_close_aborts_queued_preset_write(self):
  a,p,v=self.opened_projection(constant=True);dialog=self.vr(v)
  v.evaluate("async()=>{const me=await(await fetch('/api/me')).json();window.vrLockKey='kin-vr-presets:'+KinVolumeRendering.presetStoreKey([me.institution,me.sub]);navigator.locks.request(vrLockKey,()=>new Promise(resolve=>{window.vrReleaseLock=resolve;window.vrLockHeld=true}))}");v.wait_for_function('()=>window.vrLockHeld===true')
  dialog.get_by_label('Preset Name',exact=True).fill('Never Save');dialog.get_by_role('button',name='Save New Preset',exact=True).click();expect(dialog.get_by_role('button',name='Save New Preset',exact=True)).to_be_disabled();dialog.get_by_role('button',name='Close VR',exact=True).click();expect(dialog).not_to_be_visible();v.evaluate('()=>vrReleaseLock()')
  dialog=self.vr(v);expect(dialog.get_by_label('Saved Presets',exact=True)).not_to_contain_text('Never Save');dialog.get_by_label('Preset Name',exact=True).fill('After Reopen');dialog.get_by_role('button',name='Save New Preset',exact=True).click();dialog.get_by_label('Saved Presets',exact=True).select_option(label='After Reopen');expect(dialog.get_by_label('Saved Presets',exact=True)).not_to_contain_text('Never Save')

 def sculpt_region(self,v,dialog,mode='Rectangle',side='Inside',points=None):
  dialog.get_by_label('Sculpt Tool',exact=True).select_option(mode);dialog.get_by_label('Removal Side',exact=True).select_option(side)
  dialog.get_by_role('button',name='Draw Region',exact=True).click();overlay=dialog.locator('[data-kin-vr-sculpt]');expect(overlay).to_be_visible();box=overlay.bounding_box()
  points=points or ([(.05,.05),(.5,.95)] if mode in ['Rectangle','Ellipse'] else [(.1,.1),(.5,.1),(.5,.9),(.1,.9)])
  coords=[(box['x']+x*box['width'],box['y']+y*box['height']) for x,y in points]
  if mode.startswith('Curved'):
   for x,y in coords:v.mouse.click(x,y)
  else:
   v.mouse.move(*coords[0]);v.mouse.down()
   for x,y in coords[1:]:v.mouse.move(x,y,steps=8)
   v.mouse.up()
  finish=dialog.get_by_role('button',name='Finish Region',exact=True)
  if finish.is_enabled():finish.click()
  expect(dialog.get_by_role('button',name='Apply Sculpt',exact=True)).to_be_enabled()

 def test_vr_18_sculpt_pixels_world_fixed_undo_and_source_preservation(self):
  a,p,v=self.opened_projection(constant=True);native=self.native_pixels(v);source=self.volume_state(v);original=self.originals();rows=self.rows();dialog=self.vr(v);front=self.vr_pixels(v)
  dialog.get_by_label('View From',exact=True).select_option('Superior');top=self.vr_pixels(v);dialog.get_by_label('View From',exact=True).select_option('Anterior')
  pristine=v.evaluate("()=>{const m=cornerstone.getEnabledElement(document.querySelector('[data-kin-vr-render]')).viewport.getActors()[0].actor.getMapper();m.setViewSpecificProperties({...m.getViewSpecificProperties(),kinSculptSentinel:'retain'});return m.getViewSpecificProperties()}")
  self.sculpt_region(v,dialog);dialog.get_by_role('button',name='Apply Sculpt',exact=True).click();cut=self.vr_pixels(v);self.assertAlmostEqual(cut['count']/front['count'],.5,delta=.06)
  shader=v.evaluate("()=>cornerstone.getEnabledElement(document.querySelector('[data-kin-vr-render]')).viewport.getActors()[0].actor.getMapper().getViewSpecificProperties().OpenGL.ShaderReplacements")
  dialog.get_by_label('View From',exact=True).select_option('Superior');rotated=self.vr_pixels(v);self.assertAlmostEqual(rotated['count']/top['count'],.5,delta=.06)
  self.assertEqual(v.evaluate("()=>cornerstone.getEnabledElement(document.querySelector('[data-kin-vr-render]')).viewport.getActors()[0].actor.getMapper().getViewSpecificProperties().OpenGL.ShaderReplacements"),shader)
  dialog.get_by_role('button',name='Undo Sculpt',exact=True).click();self.assertEqual(self.vr_pixels(v),top);self.preserved_volume(source,self.volume_state(v));self.assertEqual(self.native_pixels(v),native);self.assertEqual(self.originals(),original);self.unchanged_rows(rows)
  self.assertEqual(v.evaluate("()=>cornerstone.getEnabledElement(document.querySelector('[data-kin-vr-render]')).viewport.getActors()[0].actor.getMapper().getViewSpecificProperties()"),pristine)
  print('VR_SCULPT_WORLD_FIXED',{'front':front,'cut':cut,'top':top,'rotatedCut':rotated},flush=True)

 def test_vr_19_six_sculpt_shapes_inside_outside_and_clear(self):
  a,p,v=self.opened_projection(constant=True);dialog=self.vr(v);full=self.vr_pixels(v)
  for mode in ['Freehand Area','Freehand Line','Curved Area','Curved Line','Ellipse','Rectangle']:
   self.sculpt_region(v,dialog,mode);dialog.get_by_role('button',name='Apply Sculpt',exact=True).click();inside=self.vr_pixels(v);self.assertGreater(inside['count'],0,mode);self.assertLess(inside['count'],full['count'],mode)
   dialog.get_by_role('button',name='Clear Sculpt',exact=True).click();self.assertEqual(self.vr_pixels(v),full,mode)
   self.sculpt_region(v,dialog,mode,'Outside');dialog.get_by_role('button',name='Apply Sculpt',exact=True).click();outside=self.vr_pixels(v);self.assertGreater(outside['count'],0,mode);self.assertLess(outside['count'],full['count'],mode)
   self.assertAlmostEqual((inside['count']+outside['count'])/full['count'],1,delta=.035,msg=mode)
   dialog.get_by_role('button',name='Clear Sculpt',exact=True).click();self.assertEqual(self.vr_pixels(v),full,mode)
   print('VR_SCULPT_SHAPE',mode,inside,outside,flush=True)

 def test_vr_20_sculpt_draft_cancel_resize_reset_and_crop_transfer(self):
  v=None
  try:
   a,p,v=self.opened_projection(constant=True);dialog=self.vr(v);full=self.vr_pixels(v);camera=self.vr_state(v)['camera']
   self.sculpt_region(v,dialog);expect(dialog.get_by_label('View From',exact=True)).to_be_disabled();expect(dialog.get_by_role('button',name='Apply Display',exact=True)).to_be_disabled();self.assertEqual(self.vr_state(v)['camera'],camera)
   dialog.get_by_role('button',name='Cancel Sculpt',exact=True).click();expect(dialog.locator('[data-kin-vr-sculpt]')).not_to_be_visible();self.assertEqual(self.vr_pixels(v),full)
   self.sculpt_region(v,dialog);size=v.viewport_size;v.set_viewport_size({'width':size['width']-30,'height':size['height']});expect(dialog.locator('[data-kin-vr-sculpt]')).not_to_be_visible();v.set_viewport_size(size)
   self.sculpt_region(v,dialog);dialog.get_by_role('button',name='Apply Sculpt',exact=True).click();cut=self.vr_pixels(v)
   dialog.get_by_label('VR Opacity',exact=True).fill('50');dialog.get_by_role('button',name='Apply Display',exact=True).click();self.assertAlmostEqual(self.vr_pixels(v)['width'],cut['width'],delta=2)
   dialog.get_by_label('K Max',exact=True).fill('7');dialog.get_by_role('button',name='Apply Crop',exact=True).click();cropped=self.vr_pixels(v);self.assertGreater(cropped['count'],0);self.assertLess(cropped['height'],cut['height'])
   dialog.get_by_role('button',name='Reset VR',exact=True).click();self.assertEqual(self.vr_pixels(v),full)
   self.sculpt_region(v,dialog);dialog.get_by_role('button',name='Apply Sculpt',exact=True).click();dialog.get_by_role('button',name='Close VR',exact=True).click();dialog=self.vr(v);self.assertEqual(self.vr_pixels(v),full)
  finally:
   if v is not None and not v.is_closed():
    print('VR20_FINAL_STATE',v.evaluate("""()=>{const d=document.querySelector('#kin-volume-rendering'),s=d?.querySelector('[aria-label="Sculpt Tool"]'),h=d?.querySelector('[data-kin-vr-render]');const box=e=>{const r=e?.getBoundingClientRect();return r?{width:r.width,height:r.height,x:r.x,y:r.y}:null;};return {open:!!d?.open,screen:[innerWidth,innerHeight],select:box(s),host:box(h),status:document.querySelector('#kin-volume-orientation [role=status]')?.textContent?.slice(0,400),dialogStatus:d?.querySelector('[role=status]')?.textContent?.slice(0,400)};}"""),flush=True)

 def test_vr_21_sculpt_native_failure_closes_only_vr(self):
  a,p,v=self.opened_projection(constant=True);source=self.volume_state(v);native=self.native_pixels(v);dialog=self.vr(v);self.sculpt_region(v,dialog)
  # vtk mapper APIs are frozen. Inject the post-set failure on the mutable viewport.
  v.evaluate("()=>{const vp=cornerstone.getEnabledElement(document.querySelector('[data-kin-vr-render]')).viewport;vp.render=()=>{throw Error('INJECTED SCULPT FAILURE')}}")
  dialog.get_by_role('button',name='Apply Sculpt',exact=True).click();expect(dialog).not_to_be_visible();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('INJECTED SCULPT FAILURE');self.preserved_volume(source,self.volume_state(v));self.assertEqual(self.native_pixels(v),native);self.mpr_live_after_mask_failure(v,native)
  dialog=self.vr(v);self.sculpt_region(v,dialog)
  before=self.vr_pixels(v)
  v.evaluate("()=>{const original=window.KinVolumeMaskRenderer;window.vrRestoreMaskRenderer=()=>window.KinVolumeMaskRenderer=original;window.KinVolumeMaskRenderer={...original,preflight:(op,props)=>{props.OpenGL.ShaderReplacements.at(-1).replacementValue+='\\nINVALID_SCULPT_GLSL;';return original.preflight(op,props)}}}")
  dialog.get_by_role('button',name='Apply Sculpt',exact=True).click();expect(dialog).to_be_visible();expect(dialog.locator('[role=status]')).to_contain_text('GPU');self.assertEqual(self.vr_pixels(v),before);self.assertEqual(self.native_pixels(v),native)
  v.evaluate('()=>vrRestoreMaskRenderer()');dialog.get_by_role('button',name='Cancel Sculpt',exact=True).click();dialog.get_by_role('button',name='Close VR',exact=True).click();self.mpr_live_after_mask_failure(v,native);self.preserved_volume(source,self.volume_state(v));self.vr(v)

 def mpr_live_after_mask_failure(self,v,native):
  v.evaluate("()=>{window.vrSourceProperties=structuredClone(projectionVP.getProperties());window.vrSourceFrames=0;window.vrFrameListener=()=>vrSourceFrames++;projectionVP.element.addEventListener(cornerstone.Enums.Events.IMAGE_RENDERED,vrFrameListener);projectionVP.setProperties({voiRange:{lower:65535,upper:65536}});projectionVP.render()}")
  v.wait_for_function('()=>vrSourceFrames>0');self.assertNotEqual(self.native_pixels(v),native)
  v.evaluate('()=>{vrSourceFrames=0;projectionVP.setProperties(vrSourceProperties);projectionVP.render()}');v.wait_for_function('()=>vrSourceFrames>0');self.assertEqual(self.native_pixels(v),native)
  v.evaluate('()=>projectionVP.element.removeEventListener(cornerstone.Enums.Events.IMAGE_RENDERED,vrFrameListener)')

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeRenderingE2E(n) for n in loader.getTestCaseNames(VolumeRenderingE2E) if n.startswith('test_vr_') and n in VolumeRenderingE2E.__dict__)
if __name__=='__main__':unittest.main(verbosity=2)
