# coding: utf-8
"""TEST-MPR-PREFERENCES: visible settings, native input and retained work."""
import json,os,sys,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_volume_sync import VolumeSyncE2E

class VolumePreferencesE2E(VolumeSyncE2E):
 def setUp(self):
  super().setUp()
  from workspace_roaming_support import cleanup_workspace
  self.addCleanup(cleanup_workspace,self.stack,"ReadingAppearance")
 def properties(self,v):
  panel=v.locator('#kin-mpr-preferences');expect(panel).to_be_visible();return panel
 def mouse(self,v,left='StackScroll',middle='Zoom',right='WindowLevel'):
  panel=self.properties(v)
  for k,value in [('left',left),('middle',middle),('right',right)]:panel.get_by_label('MPR '+k+' mouse button',exact=True).select_option(value)
  panel.get_by_role('button',name='Apply Mouse',exact=True).click();expect(panel.locator('[role=status]')).to_contain_text('마우스 버튼을 적용')
 def test_properties_01_display_ruler_preserves_pixels_camera_and_report(self):
  a,p,v=self.starting();panel=self.properties(v);original=self.originals();p.locator('#findings').fill('KEEP PROPERTIES REPORT');before=self.volume_state(v)
  selectors={'Windowing':'[data-cy=viewport-overlay-bottom-left]>div:first-child','Zoom Factor':'.kin-mpr-zoom','Thickness':'.kin-volume-projection-label','Scale Bar':'.kin-mpr-scale','Orientation':'.orientation-marker-value','Demographic Info':'.kin-viewer-identity','Orientation Cube':'.kin-mpr-cube','Sample Direction':'.kin-mpr-sample'}
  for name,selector in selectors.items():
   box=panel.get_by_label('Show MPR '+name,exact=True);box.uncheck();expect(v.locator(selector).first).to_be_hidden();box.check();expect(v.locator(selector).first).to_be_visible()
  self.preserved_volume(before,self.volume_state(v));expect(p.locator('#findings')).to_have_value('KEEP PROPERTIES REPORT');self.assertEqual(self.originals(),original)
  self.rotate_planes(v,0,25);v.evaluate('()=>{projectionVP.setZoom(1.7);projectionVP.render()}')
  rules=v.evaluate('()=>[...services.viewportGridService.getState().viewports.keys()].map(id=>{const view=services.cornerstoneViewportService.getCornerstoneViewport(id),el=view.element.querySelector(".kin-mpr-scale"),px=parseFloat(el.style.width),a=view.canvasToWorld([50,50]),b=view.canvasToWorld([50+px,50]);return {label:parseFloat(el.textContent),actual:Math.hypot(...a.map((n,i)=>n-b[i]))}})')
  for r in rules:self.assertAlmostEqual(r['label'],r['actual'],delta=1e-5)
  if os.environ.get('KIN_EVIDENCE_DIR'):
   out=Path(os.environ['KIN_EVIDENCE_DIR']);out.mkdir(parents=True,exist_ok=True);panel.scroll_into_view_if_needed();v.screenshot(path=str(out/'mpr-properties.png'))
 def test_properties_02_native_mouse_and_duplicate_rejection(self):
  a,p,v=self.starting();self.mouse(v);panel=self.properties(v)
  bindings=v.evaluate('()=>cornerstoneTools.ToolGroupManager.getToolGroupForViewport(projectionVP.id,projectionVP.renderingEngineId).toolOptions')
  self.assertIn({'mouseButton':1},bindings['StackScroll']['bindings']);self.assertIn({'mouseButton':4},bindings['Zoom']['bindings']);self.assertIn({'mouseButton':2},bindings['WindowLevel']['bindings']);self.assertIn({'mouseButton':524288},bindings['StackScroll']['bindings'])
  box=v.locator('.cornerstone-viewport-element').first.bounding_box();x,y=box['x']+box['width']*.5,box['y']+box['height']*.5
  before=v.evaluate('()=>projectionVP.getZoom()');v.mouse.move(x,y);v.mouse.down(button='middle');v.mouse.move(x,y+45,steps=5);v.mouse.up(button='middle');v.wait_for_function('old=>Math.abs(projectionVP.getZoom()-old)>.01',arg=before)
  before=v.evaluate('()=>projectionVP.viewportProperties.voiRange.upper');v.mouse.move(x,y);v.mouse.down(button='right');v.mouse.move(x+35,y+15,steps=5);v.mouse.up(button='right');v.wait_for_function('old=>projectionVP.viewportProperties.voiRange.upper!==old',arg=before)
  panel.get_by_label('MPR left mouse button',exact=True).select_option('Zoom');panel.get_by_role('button',name='Apply Mouse',exact=True).click();expect(panel.locator('[role=status]')).to_contain_text('서로 다른 도구')
  self.assertEqual(v.evaluate('()=>cornerstoneTools.ToolGroupManager.getToolGroupForViewport(projectionVP.id,projectionVP.renderingEngineId).toolOptions'),bindings)
 def test_properties_03_save_reload_and_storage_failure(self):
  a,p,v=self.starting();panel=self.properties(v);self.mouse(v);panel.get_by_label('Show MPR Windowing',exact=True).uncheck();panel.get_by_role('button',name='Save MPR Preferences',exact=True).click();expect(panel.locator('[role=status]')).to_contain_text('저장했습니다')
  v.reload();self.ready(v);self.mpr(v);self.choose_volume(v,v,0);panel=self.properties(v);expect(panel.get_by_label('Show MPR Windowing',exact=True)).not_to_be_checked();expect(panel.get_by_label('MPR left mouse button',exact=True)).to_have_value('StackScroll')
  v.evaluate('()=>{window.preferenceStore=Storage.prototype.setItem;Storage.prototype.setItem=function(k,...args){if(k.startsWith("kin-mpr-preferences:"))throw Error("STORAGE FAILURE");return preferenceStore.call(this,k,...args)}}');panel.get_by_label('Show MPR Windowing',exact=True).check();panel.get_by_role('button',name='Save MPR Preferences',exact=True).click();expect(panel.locator('[role=status]')).to_contain_text('저장하지 못했습니다');panel.get_by_role('button',name='Load MPR Preferences',exact=True).click();expect(panel.get_by_label('Show MPR Windowing',exact=True)).not_to_be_checked()
 def test_properties_04_failed_binding_restores_and_modal_blocks(self):
  a,p,v=self.starting();panel=self.properties(v)
  before=v.evaluate('()=>{window.prefGroup=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(projectionVP.id,projectionVP.renderingEngineId);return prefGroup.toolOptions}')
  v.evaluate('()=>{const original=prefGroup.setToolActive;let once=true;prefGroup.setToolActive=function(...args){const r=original.apply(this,args);if(once){once=false;throw Error("BINDING FAILURE")}return r}}')
  panel.get_by_label('MPR left mouse button',exact=True).select_option('StackScroll');panel.get_by_role('button',name='Apply Mouse',exact=True).click();expect(panel.locator('[role=status]')).to_contain_text('BINDING FAILURE');self.assertEqual(v.evaluate('()=>prefGroup.toolOptions'),before)
  v.evaluate('()=>{const d=document.createElement("dialog");d.id="property-block";document.body.append(d);d.showModal()}');expect(panel.get_by_label('Show MPR Windowing',exact=True)).to_be_disabled();v.evaluate('()=>document.getElementById("property-block").remove()');expect(panel.get_by_label('Show MPR Windowing',exact=True)).to_be_enabled()

 def test_properties_05_autohide_crosshair_and_sync_profile(self):
  a,p,v=self.starting();panel=self.properties(v)
  v.get_by_role('button',name='Show Crosshairs',exact=True).click();v.wait_for_function('()=>{const e=document.querySelector("[data-kin-crosshair]");return e&&getComputedStyle(e).visibility==="visible"}')
  panel.get_by_label('Show MPR Auto Hide Crosshair',exact=True).check();v.wait_for_function('()=>getComputedStyle(document.querySelector("[data-kin-crosshair]")).visibility==="hidden"')
  box=v.locator('.cornerstone-viewport-element').first.bounding_box();v.mouse.move(box['x']+box['width']*.5,box['y']+box['height']*.5);v.wait_for_function('()=>{const e=document.querySelector("[data-kin-crosshair]");return e&&getComputedStyle(e).visibility==="visible"}')
  self.sync(v,'Windowing',False);self.sync(v,'Zoom',True);panel.get_by_role('button',name='Save MPR Preferences',exact=True).click();v.reload();self.ready(v);self.mpr(v);self.choose_volume(v,v,0)
  expect(v.get_by_role('checkbox',name='Sync MPR Windowing',exact=True)).not_to_be_checked();expect(v.get_by_role('checkbox',name='Sync MPR Zoom',exact=True)).to_be_checked()
 def test_properties_06_account_new_browser_restores_after_modal_preserving_work(self):
  from test_embedded_patient_copy import EmbeddedPatientCopyE2E
  a,p,v=self.starting();panel=self.properties(v);self.mouse(v);panel.get_by_label('Show MPR Windowing',exact=True).uncheck();panel.get_by_label('MPR Progressive Rendering',exact=True).check();self.sync(v,'Windowing',False);self.sync(v,'Zoom',True)
  panel.get_by_role('button',name='Save MPR Preferences',exact=True).click();p.bring_to_front();p.locator('#reading-appearance-open').click();expect(p.locator('#appearance-account-save')).to_be_enabled();p.locator('#appearance-account-save').click();expect(p.locator('#appearance-account-status')).to_contain_text('계정에 저장했습니다')
  stored=p.request.get(self.stack.api+'/reading-appearance').json();self.assertEqual(stored['sizes']['version'],7);self.assertFalse(stored['sizes']['mpr']['display']['windowing']);self.assertEqual(stored['sizes']['mpr']['mouse']['left'],'StackScroll')
  other=self.login();f=self.workspace(other,a,count=1);self.tools(f);self.mpr(f);self.choose_volume(other,f,0);other.locator('#findings').fill('KEEP MPR ACCOUNT REPORT');before=self.volume_state(f)
  other.locator('#reading-appearance-open').click();expect(other.locator('#appearance-account-save')).to_be_enabled();other.locator('#appearance-account-load').click();expect(other.locator('#appearance-account-status')).to_contain_text('계정의 표시 설정을 불러왔습니다')
  self.assertTrue(f.get_by_label('Show MPR Windowing',exact=True).is_checked());other.locator('#reading-appearance-close').click();self.tools(f);expect(f.get_by_label('Show MPR Windowing',exact=True)).not_to_be_checked();expect(f.get_by_label('MPR left mouse button',exact=True)).to_have_value('StackScroll');expect(f.get_by_role('checkbox',name='Sync MPR Zoom',exact=True)).to_be_checked()
  self.preserved_volume(before,self.volume_state(f));expect(other.locator('#findings')).to_have_value('KEEP MPR ACCOUNT REPORT');self.assertEqual(other.request.get(self.stack.api+'/reading-appearance').json(),stored)
  expect(f.get_by_label('MPR Progressive Rendering',exact=True)).to_be_checked()
  key='kin-mpr-preferences:v1:'+json.dumps(stored['owner'],separators=(',',':'),ensure_ascii=False)
  self.assertEqual(other.evaluate('key=>JSON.parse(localStorage.getItem(key))',key),stored['sizes']['mpr'])
 def test_properties_07_progressive_refines_to_identical_pixels(self):
  a,p,v=self.starting();self.rotate_planes(v,0,23);self.project(v,3,20);panel=self.properties(v);panel.get_by_label('MPR Progressive Rendering',exact=True).check();before=self.volume_state(v)
  original=v.evaluate('()=>{window.prefMapper=projectionVP.getActors()[0].actor.getMapper();return prefMapper.getSampleDistance()}')
  box=v.locator('.cornerstone-viewport-element').first.bounding_box();x,y=box['x']+box['width']*.5,box['y']+box['height']*.5
  v.mouse.move(x,y);v.mouse.down();v.wait_for_function('x=>prefMapper.getSampleDistance()===x*3',arg=original);expect(v.locator('.kin-mpr-refining').first).to_be_visible();coarse=self.volume_state(v);self.assertNotEqual(coarse[0]['hash'],before[0]['hash'])
  v.mouse.up();v.wait_for_function('x=>prefMapper.getSampleDistance()===x&&!kinMprRenderingState.busy()',arg=original);expect(v.locator('.kin-mpr-refining')).to_have_count(0);self.preserved_volume(before,self.volume_state(v))
  panel.get_by_label('MPR Progressive Rendering',exact=True).uncheck();v.mouse.move(x,y);v.mouse.down();self.assertEqual(v.evaluate('()=>prefMapper.getSampleDistance()'),original);v.mouse.up()
 def test_properties_08_progressive_restore_failure_is_visible_and_retries(self):
  a,p,v=self.starting();self.project(v,3,20);panel=self.properties(v);panel.get_by_label('MPR Progressive Rendering',exact=True).check();before=self.volume_state(v)
  original=v.evaluate('()=>{const actors=projectionVP.getActors(),mapper=actors[0].actor.getMapper();window.prefBase=mapper.getSampleDistance();window.refineInjected=false;const adapter={...mapper,setSampleDistance(value){if(value===prefBase&&!refineInjected){refineInjected=true;throw Error("REFINE FAILURE")}return mapper.setSampleDistance(value)}};const wrapped=[{...actors[0],actor:{...actors[0].actor,getMapper:()=>adapter}}];projectionVP.getActors=()=>wrapped;window.prefMapper=adapter;return prefBase}')
  box=v.locator('.cornerstone-viewport-element').first.bounding_box();v.mouse.move(box['x']+box['width']*.5,box['y']+box['height']*.5);v.mouse.down();v.wait_for_function('()=>prefMapper.getSampleDistance()>prefBase');v.mouse.up()
  expect(panel.locator('[role=status]')).to_contain_text('원래 렌더링 품질을 복구하지 못했습니다');self.assertTrue(v.evaluate('()=>refineInjected')); v.wait_for_function('x=>prefMapper.getSampleDistance()===x&&!kinMprRenderingState.busy()',arg=original);self.preserved_volume(before,self.volume_state(v));expect(v.locator('.kin-mpr-refining')).to_have_count(0)
 def test_properties_15_inexact_sample_restore_is_visible_and_retries(self):
  a,p,v=self.starting();self.project(v,3,20);panel=self.properties(v);panel.get_by_label('MPR Progressive Rendering',exact=True).check();before=self.volume_state(v)
  v.evaluate('()=>{const actors=projectionVP.getActors(),mapper=actors[0].actor.getMapper();window.prefBase=mapper.getSampleDistance();window.refineInjected=false;const adapter={...mapper,setSampleDistance(value){if(value===prefBase&&!refineInjected){refineInjected=true;return mapper.setSampleDistance(prefBase*2)}return mapper.setSampleDistance(value)}};projectionVP.getActors=()=>[{...actors[0],actor:{...actors[0].actor,getMapper:()=>adapter}}];window.prefMapper=adapter}')
  v.evaluate('()=>{projectionVP.element.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));document.dispatchEvent(new PointerEvent("pointerup",{bubbles:true}));if(!kinMprRenderingState.busy()||!document.querySelector(".kin-mpr-refining")?.textContent.includes("failed"))throw Error("Silent restoration failure was accepted") }')
  self.assertTrue(v.evaluate('()=>refineInjected'));v.wait_for_function('()=>prefMapper.getSampleDistance()===prefBase&&!kinMprRenderingState.busy()');self.preserved_volume(before,self.volume_state(v))
 def test_properties_16_attach_failure_requires_reload_without_loop(self):
  a,p,v=self.starting()
  v.evaluate('()=>{const views=[...services.viewportGridService.getState().viewports.keys()].map(id=>services.cornerstoneViewportService.getCornerstoneViewport(id)),g=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(views[0].id,views[0].renderingEngineId),get=g.getToolInstance;window.attachAttempts=0;g.getToolInstance=()=>{attachAttempts++;throw Error("ATTACH FAILURE")};const host=document.createElement("div");host.id="attach-failure-probe";document.body.append(host);window.attachProbe=kinCreateVolumePreferences({target:()=>({group:"same-cached-view",views}),permitted:()=>true,alive:()=>true,owner:()=>({probe:true}),services,host});g.getToolInstance=get}')
  v.wait_for_timeout(2100);self.assertEqual(v.evaluate('()=>attachAttempts'),1);expect(v.locator('#attach-failure-probe [role=status]')).to_contain_text('ATTACH FAILURE');self.assertIn('\uc0c8\ub85c\uace0\uce68',v.locator('#attach-failure-probe [role=status]').inner_text());v.evaluate('()=>{attachProbe.dispose();document.getElementById("attach-failure-probe").remove()}')
 def test_properties_17_persistent_refinement_failure_keeps_settings_usable(self):
  a,p,v=self.starting();self.project(v,3,20);panel=self.properties(v);panel.get_by_label('MPR Progressive Rendering',exact=True).check();before=self.volume_state(v)
  v.evaluate('()=>{const actors=projectionVP.getActors(),mapper=actors[0].actor.getMapper();window.prefBase=mapper.getSampleDistance();window.failRefine=true;const adapter={...mapper,setSampleDistance(value){return mapper.setSampleDistance(value===prefBase&&failRefine?prefBase*2:value)}};projectionVP.getActors=()=>[{...actors[0],actor:{...actors[0].actor,getMapper:()=>adapter}}];window.prefMapper=adapter;projectionVP.element.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));document.dispatchEvent(new PointerEvent("pointerup",{bubbles:true}))}')
  v.wait_for_timeout(2100);self.assertTrue(v.evaluate('()=>kinMprRenderingState.busy()'));expect(panel.get_by_role('button',name='Save MPR Preferences',exact=True)).to_be_enabled();expect(panel.get_by_label('MPR Progressive Rendering',exact=True)).to_be_enabled();expect(v.locator('.kin-mpr-refining').first).to_have_text('Refinement failed');self.assertIn('\ubcf5\uad6c',panel.locator('[role=status]').inner_text());v.evaluate('()=>{failRefine=false}');v.wait_for_function('()=>prefMapper.getSampleDistance()===prefBase&&!kinMprRenderingState.busy()');self.preserved_volume(before,self.volume_state(v))
 def test_properties_09_teardown_preserves_newer_native_tool_choice(self):
  a,p,v=self.starting();self.mouse(v);v.locator('[data-cy=WindowLevel]').click()
  native=v.evaluate('()=>{window.prefTools=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(projectionVP.id,projectionVP.renderingEngineId);return prefTools.toolOptions}')
  v.evaluate('()=>window.dispatchEvent(new StorageEvent("storage",{key:"kin-session-ended",newValue:"test"}))')
  expect(v.locator('.kin-mpr-configured')).to_have_count(0);expect(v.locator('.kin-mpr-zoom')).to_have_count(0);self.assertEqual(v.evaluate('()=>prefTools.toolOptions'),native)
 def test_properties_10_saved_profile_applies_after_job_restore(self):
  a,p,v=self.starting();self.mouse(v);self.sync(v,'Windowing',False);self.sync(v,'Zoom',True);panel=self.properties(v);panel.get_by_role('button',name='Save MPR Preferences',exact=True).click();self.save_volume(v);before=self.volume_state(v)
  capture='()=>kinCreateVolumeJob({grid:services.viewportGridService,cs:services.cornerstoneViewportService,ds:services.displaySetService,studies:new URLSearchParams(location.search).get("StudyInstanceUIDs").split(",")}).capture()';saved=v.evaluate(capture)
  v.get_by_role('button',name='Restore Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000);expect(v.get_by_role('checkbox',name='Sync MPR Zoom',exact=True)).to_be_checked();expect(v.get_by_role('checkbox',name='Sync MPR Windowing',exact=True)).not_to_be_checked()
  v.wait_for_function('()=>{const view=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId),g=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(view.id,view.renderingEngineId);return g.getToolOptions("StackScroll").bindings.some(b=>b.mouseButton===1)}')
  after=self.volume_state(v)
  self.assertNotEqual(before[0]['id'],after[0]['id'])
  restored=v.evaluate(capture)
  for old,new in zip(saved['cells'],restored['cells']):
   for key,expected in old['camera'].items():
    actual=new['camera'][key]
    if isinstance(expected,list):
     self.assertEqual(len(actual),len(expected))
     for x,y in zip(actual,expected):self.assertAlmostEqual(x,y,delta=1e-10,msg=key)
    elif isinstance(expected,bool):self.assertEqual(actual,expected)
    else:self.assertAlmostEqual(actual,expected,delta=1e-10,msg=key)
   new['camera']=old['camera']
  self.assertEqual(restored,saved)
  self.assertEqual([(x['hash'],x['min'],x['max']) for x in before],[(x['hash'],x['min'],x['max']) for x in after])

 def test_properties_11_saved_apply_failure_does_not_rebind_repeatedly(self):
  a,p,v=self.starting();self.mouse(v);self.properties(v).get_by_role('button',name='Save MPR Preferences',exact=True).click()
  v.add_init_script('''(()=>{let capability;window.prefSyncAttempts=0;Object.defineProperty(window,'kinVolumeSynchronization',{configurable:true,get:()=>capability,set(value){capability=value;if(value)value.apply=()=>{prefSyncAttempts++;return false}}})})()''')
  v.reload();self.ready(v);self.mpr(v);self.choose_volume(v,v,0);panel=self.properties(v);expect(panel.locator('[role=status]')).to_contain_text('동기화 설정을 적용하지 못했습니다')
  v.evaluate('()=>{window.prefOverlay=document.querySelector(".kin-mpr-zoom");window.prefActiveCalls=0;const g=cornerstoneTools.ToolGroupManager.getToolGroup("mpr"),original=g.setToolActive;g.setToolActive=function(...args){prefActiveCalls++;return original.apply(this,args)}}')
  v.wait_for_timeout(2100);self.assertEqual(v.evaluate('()=>({attempts:prefSyncAttempts,calls:prefActiveCalls,same:prefOverlay===document.querySelector(".kin-mpr-zoom")})'),{'attempts':1,'calls':0,'same':True})
 def test_properties_12_pending_profile_is_not_saved_or_rendered_early(self):
  a,p,v=self.starting();self.properties(v)
  result=v.evaluate('''()=>{const key='kin-mpr-preferences:v1:'+JSON.stringify(window.kinViewerOwner||[]),before=Object.entries(localStorage).filter(([k])=>k.startsWith('kin-mpr-preferences:'));
    const next=kinMprPreferences.read();next.progressive=true;next.display.windowing=false;kinMprPreferences.requestApply(next);
    const button=document.querySelector('#kin-mpr-preferences [data-action=save]');button.click();return {disabled:button.disabled,progressive:kinMprPreferences.read().progressive,unchanged:JSON.stringify(before)===JSON.stringify(Object.entries(localStorage).filter(([k])=>k.startsWith('kin-mpr-preferences:')))}}''')
  self.assertEqual(result,{'disabled':True,'progressive':False,'unchanged':True});expect(v.get_by_label('Show MPR Windowing',exact=True)).not_to_be_checked();expect(v.get_by_label('MPR Progressive Rendering',exact=True)).to_be_checked()
 def test_properties_13_render_failure_does_not_retry_sample_restore(self):
  a,p,v=self.starting();self.project(v,3,20);panel=self.properties(v);panel.get_by_label('MPR Progressive Rendering',exact=True).check();before=self.volume_state(v)
  v.evaluate('()=>{window.prefMapper=projectionVP.getActors()[0].actor.getMapper();window.prefBase=prefMapper.getSampleDistance();const render=projectionVP.render;window.prefRenderFailed=false;projectionVP.render=function(...args){if(window.prefRenderArmed&&!prefRenderFailed&&prefMapper.getSampleDistance()===prefBase){prefRenderFailed=true;throw Error("FINAL RENDER FAILURE")}return render.apply(this,args)}}')
  box=v.locator('.cornerstone-viewport-element').first.bounding_box();x,y=box['x']+box['width']*.5,box['y']+box['height']*.5;v.mouse.move(x,y);v.mouse.down();v.wait_for_function('()=>prefMapper.getSampleDistance()>prefBase');v.evaluate('()=>window.prefRenderArmed=true');v.mouse.up()
  expect(panel.locator('[role=status]')).to_contain_text('화면 갱신에 실패했습니다');v.wait_for_function('()=>prefMapper.getSampleDistance()===prefBase&&!kinMprRenderingState.busy()');expect(v.locator('.kin-mpr-refining')).to_have_count(0);expect(v.locator('.kin-mpr-render-error')).to_have_count(1)
  v.mouse.move(x,y);v.mouse.down();v.mouse.up();v.wait_for_function('()=>!kinMprRenderingState.busy()');expect(v.locator('.kin-mpr-render-error')).to_have_count(0);self.preserved_volume(before,self.volume_state(v))
 def test_properties_14_modifier_touch_bindings_survive_and_restore(self):
  a,p,v=self.starting()
  original=v.evaluate('()=>{window.prefTools=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(projectionVP.id,projectionVP.renderingEngineId);prefTools.setToolActive("Zoom",{bindings:[{mouseButton:2,modifierKey:16},{numTouchPoints:2}]});return prefTools.toolOptions}')
  self.mouse(v);bindings=v.evaluate('()=>prefTools.getToolOptions("Zoom").bindings');self.assertIn({'mouseButton':2,'modifierKey':16},bindings);self.assertIn({'numTouchPoints':2},bindings)
  v.evaluate('()=>window.dispatchEvent(new StorageEvent("storage",{key:"kin-session-ended",newValue:"test"}))');expect(v.locator('.kin-mpr-configured')).to_have_count(0);self.assertEqual(v.evaluate('()=>prefTools.toolOptions'),original)


def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumePreferencesE2E(n) for n in VolumePreferencesE2E.__dict__ if n.startswith('test_properties_') and (not loader.testNamePatterns or any(__import__('fnmatch').fnmatch(n,p) for p in loader.testNamePatterns)))
if __name__=='__main__':unittest.main(verbosity=2)
