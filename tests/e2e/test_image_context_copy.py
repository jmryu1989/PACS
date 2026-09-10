# coding: utf-8
"""TEST-IMAGE-CONTEXT-COPY: pinned native blank-image menu and stale target refusal."""
import os,unittest,json
from pathlib import Path
from playwright.sync_api import expect
from test_viewer_patient_copy import ViewerPatientCopyE2E
from test_viewer_history import ViewerHistoryE2E
from test_viewer_tech_note import canvas_ready

class ImageContextCopyE2E(ViewerPatientCopyE2E):
 def right_click(self,v,index=0):
  b=v.locator('[data-cy=viewport-grid] > div').nth(index).locator('canvas').bounding_box();v.mouse.click(b['x']+b['width']*.5,b['y']+b['height']*.3,button='right')
 def item(self,v):return v.locator('[data-cy=context-menu-item]').filter(has_text='환자 ID 복사 ·')

 def test_context_01_native_menu_actual_id_prior_and_unsaved_work(self):
  a,b=self.pair();p,v=self.popup(a);p.locator('#findings').fill('KEEP CONTEXT REPORT');v.get_by_label('Job Title',exact=True).fill('KEEP CONTEXT TITLE');before=self.snapshot(v);url=v.url
  self.right_click(v);expect(self.item(v)).to_be_visible();expect(self.item(v)).to_contain_text(a.patient_id);expect(self.item(v)).to_contain_text('20260801')
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);v.screenshot(path=str(folder/'image-context-copy.png'))
  self.item(v).click();self.copied(v);self.assertEqual(self.clipboard(v),a.patient_id);expect(v.locator('[data-cy=context-menu]')).to_have_count(0)
  self.active(v,b.uid);self.right_click(v,1);expect(self.item(v)).to_contain_text('20260701');self.item(v).click();self.copied(v);self.assertEqual(self.clipboard(v),b.patient_id)
  expect(p.locator('#findings')).to_have_value('KEEP CONTEXT REPORT');expect(v.get_by_label('Job Title',exact=True)).to_have_value('KEEP CONTEXT TITLE');self.assertEqual(self.snapshot(v),before);self.assertEqual(v.url,url);self.assertTrue(v.evaluate('()=>window.opener===null'));self.assertEqual(self.jobs(a),[])

 def test_context_02_menu_ticket_rejects_aba_and_denial_retries(self):
  a,b=self.pair();p,v=self.popup(a);v.evaluate('()=>navigator.clipboard.writeText("KEEP CLIPBOARD")');self.right_click(v);expect(self.item(v)).to_be_visible()
  v.evaluate('''()=>{const grid=services.viewportGridService,ids=[...grid.getState().viewports.keys()].filter(id=>services.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageId?.());grid.setActiveViewportId(ids[1]);grid.setActiveViewportId(ids[0]);}''')
  self.item(v).click();expect(v.locator('#kin-viewer-copy-status')).to_contain_text('메뉴를 다시 열어');self.assertEqual(self.clipboard(v),'KEEP CLIPBOARD')
  v.evaluate('()=>{window.nativeCopy=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=()=>Promise.reject(new DOMException("denied","NotAllowedError"))}')
  self.right_click(v);self.item(v).click();expect(v.locator('#kin-viewer-copy-status')).to_contain_text('실패했습니다');self.assertEqual(self.clipboard(v),'KEEP CLIPBOARD')
  v.evaluate('()=>navigator.clipboard.writeText=window.nativeCopy');self.right_click(v);self.item(v).click();self.copied(v);self.assertEqual(self.clipboard(v),a.patient_id)

 def test_context_03_existing_annotation_menu_keeps_native_commands(self):
  a=self.ct('CONTEXT-ANNOTATION','current','20260801');p=self.login();v=self.launch(p,[a]);canvas_ready(v,1);self.ready(v)
  ViewerHistoryE2E.draw(self,v,'KEEP NATIVE ANNOTATION')
  point=v.evaluate('''()=>{const a=cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='ArrowAnnotate'),g=services.viewportGridService.getState(),vp=services.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId),p=a.data.handles.points;const xy=vp.worldToCanvas(p[0].map((x,i)=>(x+p[1][i])/2)),b=vp.element.getBoundingClientRect();return {x:b.x+xy[0],y:b.y+xy[1]}}''')
  before=v.evaluate('()=>JSON.stringify(cornerstoneTools.annotation.state.getAllAnnotations())');v.mouse.click(point['x'],point['y'],button='right');expect(v.get_by_text('Delete measurement',exact=True)).to_be_visible();expect(v.get_by_text('Add Label',exact=True)).to_be_visible();expect(self.item(v)).to_have_count(0)
  v.locator('#kin-viewer-copy-id').click();self.assertEqual(v.evaluate('()=>JSON.stringify(cornerstoneTools.annotation.state.getAllAnnotations())'),before)

 def test_context_04_mode_exit_and_session_end_remove_owned_menu(self):
  a,b=self.pair();p,v=self.popup(a);v.evaluate('()=>navigator.clipboard.writeText("KEEP END CLIPBOARD")');self.right_click(v);expect(self.item(v)).to_be_visible()
  v.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeExit()");expect(self.item(v)).to_have_count(0)
  v.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeEnter()");expect(v.locator('#kin-viewer-copy-id')).to_be_enabled(timeout=45000);self.right_click(v);expect(self.item(v)).to_have_count(1)
  v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(self.item(v)).to_have_count(0);expect(v.locator('#kin-viewer-copy-id')).to_be_disabled();self.assertEqual(self.clipboard(v),'KEEP END CLIPBOARD')

 def test_context_05_right_drag_preserves_native_zoom_without_menu(self):
  a,b=self.pair();p,v=self.popup(a)
  v.evaluate('''()=>{const g=services.viewportGridService.getState(),vp=services.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId),group=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(vp.id,vp.getRenderingEngine().id),button=cornerstoneTools.Enums.MouseBindings.Secondary;for(const [name,options] of Object.entries(group.toolOptions))if(name!=='Zoom'&&options.bindings?.some(b=>b.mouseButton===button))group.setToolPassive(name);group.setToolActive('Zoom',{bindings:[{mouseButton:button}]});}''')
  v.evaluate("()=>{window.syntheticDragEvents=[];for(const name of ['MOUSE_DOWN','MOUSE_DRAG','MOUSE_UP','MOUSE_CLICK'])document.addEventListener(cornerstoneTools.Enums.Events[name],e=>syntheticDragEvents.push({name,buttons:e.detail.event.buttons,which:e.detail.event.which,viewport:e.detail.viewportId}),true)}")
  # Let the preceding left-click selection finish the pinned tool click timer.
  v.wait_for_timeout(400)
  before=self.snapshot(v)
  box=v.locator('[data-cy=viewport-grid] > div').first.locator('canvas').bounding_box();x,y=box['x']+box['width']*.5,box['y']+box['height']*.3
  v.mouse.move(x,y);v.mouse.down(button='right');v.mouse.move(x+65,y+65,steps=12);v.mouse.up(button='right');v.wait_for_timeout(200)
  print('DRAG_EVENT',json.dumps(v.evaluate('()=>syntheticDragEvents')),flush=True)
  expect(self.item(v)).to_have_count(0);after=self.snapshot(v)
  target=lambda frames,uid:next(frame for frame in frames if '/studies/'+uid+'/' in frame['image'])
  self.assertNotEqual(target(after,a.uid)['camera'],target(before,a.uid)['camera']);self.assertEqual(target(after,b.uid),target(before,b.uid))
  self.right_click(v);expect(self.item(v)).to_be_visible();self.item(v).click();self.copied(v)

 def test_context_06_same_viewport_image_aba_rejects_stale_menu(self):
  a,b=self.pair();p,v=self.popup(a);v.evaluate('()=>navigator.clipboard.writeText("KEEP IMAGE ABA")');self.right_click(v);expect(self.item(v)).to_be_visible()
  v.evaluate('''async()=>{const g=services.viewportGridService.getState(),vp=services.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId),first=vp.getCurrentImageIdIndex();await vp.setImageIdIndex(first+1);vp.render();await vp.setImageIdIndex(first);vp.render();}''')
  self.item(v).click();expect(v.locator('#kin-viewer-copy-status')).to_contain_text('메뉴를 다시 열어');self.assertEqual(self.clipboard(v),'KEEP IMAGE ABA')

 def test_context_07_context_event_before_mouseup_waits_and_discards_drag(self):
  a,b=self.pair();p,v=self.popup(a)
  v.evaluate('''()=>{const g=services.viewportGridService.getState(),vp=services.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId),el=vp.element.querySelector('canvas'),b=el.getBoundingClientRect();window.syntheticMenuGesture={el,x:b.x+b.width*.5,y:b.y+b.height*.3};for(const type of ['mousedown','contextmenu'])el.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,button:2,buttons:2,clientX:syntheticMenuGesture.x,clientY:syntheticMenuGesture.y}));}''')
  expect(self.item(v)).to_have_count(0)
  v.evaluate('''()=>{const {el,x,y}=syntheticMenuGesture;el.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,button:2,buttons:2,clientX:x+60,clientY:y+60}));el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:2,buttons:0,clientX:x+60,clientY:y+60}));}''');v.wait_for_timeout(100);expect(self.item(v)).to_have_count(0)

def load_tests(loader,tests,pattern):return unittest.TestSuite(ImageContextCopyE2E(n) for n in loader.getTestCaseNames(ImageContextCopyE2E) if n.startswith('test_context_'))
if __name__=='__main__':unittest.main(verbosity=2)
