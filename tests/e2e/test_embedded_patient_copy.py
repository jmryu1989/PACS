# coding: utf-8
"""TEST-EMBEDDED-PATIENT-COPY: actual selected image within the live report workspace."""
import os,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_viewer_tech_note import ViewerTechNoteE2E,canvas_ready

class EmbeddedPatientCopyE2E(ViewerTechNoteE2E):
 def active(self,f,uid):
  cells=self.cells(f);index=next(i for i,c in enumerate(cells) if '/studies/'+uid+'/' in (c['image'] or ''));b=f.locator('[data-cy=viewport-grid] > div').nth(index).locator('canvas').bounding_box();f.page.mouse.click(b['x']+b['width']*.5,b['y']+b['height']*.3)
 def opened(self,a):
  p=self.login();p.context.grant_permissions(['clipboard-read','clipboard-write'],origin=self.stack.proxy);f=self.workspace(p,a);expect(f.locator('#kin-viewer-copy-id')).to_be_enabled(timeout=45000);self.tools(f);self.active(f,a.uid);return p,f
 def menu(self,p,f,index=0):
  b=f.locator('[data-cy=viewport-grid] > div').nth(index).locator('canvas').bounding_box();p.mouse.click(b['x']+b['width']*.5,b['y']+b['height']*.3,button='right');return f.locator('[data-cy=context-menu-item]').filter(has_text='환자 ID 복사 ·')
 def clipboard(self,f):return f.page.evaluate('()=>navigator.clipboard.readText()')

 def test_embedded_01_active_prior_context_keyboard_and_preserved_work(self):
  a,b=self.pair();p,f=self.opened(a);p.locator('#findings').fill('KEEP EMBEDDED REPORT');f.get_by_label('Job Title',exact=True).fill('KEEP EMBEDDED TITLE');before=self.snapshot(f)
  self.active(f,b.uid);expect(f.locator('#kin-viewer-copy-context')).to_contain_text(b.uid);item=self.menu(p,f,1);expect(item).to_contain_text('20260701');item.click();expect(f.locator('#kin-viewer-copy-status')).to_have_text('환자 ID를 복사했습니다.');self.assertEqual(self.clipboard(f),b.patient_id)
  self.active(f,a.uid);f.locator('#kin-viewer-copy-id').focus();p.keyboard.press('Control+Alt+c');expect(f.locator('#kin-viewer-copy-status')).to_have_text('환자 ID를 복사했습니다.');self.assertEqual(self.clipboard(f),a.patient_id)
  expect(p.locator('#reading-target')).to_contain_text(a.uid);expect(p.locator('#findings')).to_have_value('KEEP EMBEDDED REPORT');expect(f.get_by_label('Job Title',exact=True)).to_have_value('KEEP EMBEDDED TITLE');self.assertEqual(self.snapshot(f),before);self.assertEqual(self.jobs(a),[]);self.assertEqual(len(self.versions(a)),1)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'embedded-patient-copy.png'))

 def test_embedded_02_parent_modal_inert_hidden_and_input_refuse_copy(self):
  a,b=self.pair();p,f=self.opened(a);f.evaluate('()=>navigator.clipboard.writeText("KEEP EMBEDDED GUARD")');item=self.menu(p,f);expect(item).to_be_visible();p.locator('#reading-appearance-open').click();expect(f.locator('#kin-viewer-copy-id')).to_be_disabled();item.dispatch_event('click');self.assertEqual(self.clipboard(f),'KEEP EMBEDDED GUARD');p.locator('#reading-appearance-close').click();expect(f.locator('#kin-viewer-copy-id')).to_be_enabled()
  f.get_by_label('Job Title',exact=True).fill('KEEP EMBEDDED INPUT');f.get_by_label('Job Title',exact=True).focus();p.keyboard.press('Control+Alt+c');self.assertEqual(self.clipboard(f),'KEEP EMBEDDED GUARD');expect(f.get_by_label('Job Title',exact=True)).to_have_value('KEEP EMBEDDED INPUT')
  p.locator('#reading-frame').evaluate('(e)=>e.inert=true');expect(f.locator('#kin-viewer-copy-id')).to_be_disabled();f.locator('#kin-viewer-copy-id').dispatch_event('click');self.assertEqual(self.clipboard(f),'KEEP EMBEDDED GUARD');p.locator('#reading-frame').evaluate('(e)=>e.inert=false');expect(f.locator('#kin-viewer-copy-id')).to_be_enabled()
  p.get_by_role('button',name='Back to Worklist',exact=True).click();expect(f.locator('#kin-viewer-copy-id')).to_be_disabled();f.locator('#kin-viewer-copy-id').dispatch_event('click');self.assertEqual(self.clipboard(f),'KEEP EMBEDDED GUARD')

 def test_embedded_03_stale_selection_metadata_and_lifecycle(self):
  a,b=self.pair();p,f=self.opened(a);f.evaluate('()=>navigator.clipboard.writeText("KEEP EMBEDDED ABA")');item=self.menu(p,f);expect(item).to_be_visible()
  f.evaluate('''()=>{const g=services.viewportGridService,ids=[...g.getState().viewports.keys()].filter(id=>services.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageId?.());g.setActiveViewportId(ids[1]);g.setActiveViewportId(ids[0]);}''');item.click();expect(f.locator('#kin-viewer-copy-status')).to_contain_text('메뉴를 다시 열어');self.assertEqual(self.clipboard(f),'KEEP EMBEDDED ABA')
  f.evaluate('''()=>{const g=services.viewportGridService.getState(),vp=services.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId);window.syntheticCopyMeta=cornerstone.metaData.get('instance',vp.getCurrentImageId());window.syntheticCopySop=syntheticCopyMeta.SOPInstanceUID;syntheticCopyMeta.SOPInstanceUID='1.2.3.4';}''');expect(f.locator('#kin-viewer-copy-id')).to_be_disabled();f.evaluate('()=>syntheticCopyMeta.SOPInstanceUID=syntheticCopySop');expect(f.locator('#kin-viewer-copy-id')).to_be_enabled()
  f.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeExit()");expect(f.locator('#kin-viewer-copy-id')).to_have_count(0);f.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeEnter()");expect(f.locator('#kin-viewer-copy-id')).to_be_enabled(timeout=45000);expect(f.locator('#kin-viewer-copy-id')).to_have_count(1)
  f.locator('#kin-viewer-copy-id').click();expect(f.locator('#kin-viewer-copy-status')).to_have_text('환자 ID를 복사했습니다.');self.assertEqual(self.clipboard(f),a.patient_id)
  p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(p.locator('#reading-frame')).to_have_count(0)

 def test_embedded_04_hidden_report_target_and_owner_failure_recover(self):
  a,b=self.pair();p,f=self.opened(a);f.get_by_label('Job Title',exact=True).fill('KEEP HIDDEN COPY');f.evaluate('()=>navigator.clipboard.writeText("KEEP HIDDEN CLIPBOARD")');self.choose(p,b)
  expect(p.locator('#reading-frame')).not_to_be_visible();expect(f.locator('#kin-viewer-copy-id')).to_be_disabled();f.locator('#kin-viewer-copy-id').dispatch_event('click');self.assertEqual(self.clipboard(f),'KEEP HIDDEN CLIPBOARD')
  p.get_by_role('button',name='Return to Previous Viewer',exact=True).click();expect(p.locator('#reading-target')).to_contain_text(a.uid);expect(f.locator('#kin-viewer-copy-id')).to_be_enabled();expect(f.get_by_label('Job Title',exact=True)).to_have_value('KEEP HIDDEN COPY')
  p.evaluate("()=>{window.syntheticOwnerKey=KinWorkspaceLayout.key;KinWorkspaceLayout.key=()=>{throw new Error('synthetic owner unavailable')}}");expect(f.locator('#kin-viewer-copy-id')).to_be_disabled();f.locator('#kin-viewer-copy-id').dispatch_event('click');self.assertEqual(self.clipboard(f),'KEEP HIDDEN CLIPBOARD');p.evaluate('()=>KinWorkspaceLayout.key=window.syntheticOwnerKey');expect(f.locator('#kin-viewer-copy-id')).to_be_enabled()
  self.tools(f);f.locator('#kin-viewer-copy-id').click();expect(f.locator('#kin-viewer-copy-status')).to_have_text('환자 ID를 복사했습니다.');self.assertEqual(self.clipboard(f),a.patient_id)

def load_tests(loader,tests,pattern):return unittest.TestSuite(EmbeddedPatientCopyE2E(n) for n in loader.getTestCaseNames(EmbeddedPatientCopyE2E) if n.startswith('test_embedded_'))
if __name__=='__main__':unittest.main(verbosity=2)
