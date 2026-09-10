# coding: utf-8
"""Account viewer labels follow loaded current/prior identity, without resizing images."""
import os,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_viewer_patient_copy import ViewerPatientCopyE2E
from workspace_roaming_support import cleanup_workspace

class ViewerIdentityE2E(ViewerPatientCopyE2E):
 def setUp(self):
  super().setUp();self.addCleanup(cleanup_workspace,self.stack,'ReadingAppearance')
 def settings(self,p):
  p.locator('#reading-appearance-open').click();expect(p.locator('#appearance-account-save')).to_be_enabled()
 def label(self,v,uid):return v.locator('.kin-viewer-identity[data-study="'+uid+'"]')
 def test_identity_04_patient_header_stays_english_after_toggle(self):
  a,b=self.pair();p,v=self.popup(a);before=self.snapshot(v)
  label=v.get_by_text('Patient',exact=True).first
  expect(label).to_be_visible()
  label.evaluate("e=>(e.closest('button')||e.parentElement.parentElement).setAttribute('data-kin-patient-toggle','true')")
  toggle=v.locator('[data-kin-patient-toggle=true]')
  for _ in range(2):
   toggle.click();expect(toggle).to_contain_text('SYNTHETIC');expect(v.get_by_text('환자',exact=True)).to_have_count(0)
   toggle.click();expect(label).to_be_visible();expect(v.get_by_text('환자',exact=True)).to_have_count(0)
  self.assertEqual(self.snapshot(v),before)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);v.screenshot(path=str(folder/'patient-header.png'))

 def test_identity_01_live_current_prior_account_restore_preserves_work(self):
  a,b=self.pair();p,v=self.popup(a);expect(self.label(v,a.uid)).to_contain_text('기준 검사');expect(self.label(v,b.uid)).to_contain_text('비교 검사')
  p.locator('#findings').fill('KEEP IDENTITY REPORT');v.get_by_label('Job Title',exact=True).fill('KEEP IDENTITY TITLE');before=self.snapshot(v);self.settings(p)
  for role,size,font,color in [('current','20','mono','warm'),('prior','14','serif','cool')]:
   for field,value in [('size',size),('font',font),('color',color)]:p.locator('#viewer-identity-'+role+'-'+field).select_option(value)
  p.locator('#viewer-identity-prior-name').uncheck();p.locator('#viewer-identity-current-description').check()
  expect(self.label(v,a.uid)).to_have_css('font-size','20px');expect(self.label(v,b.uid)).to_have_css('font-size','14px');expect(self.label(v,a.uid)).to_have_css('color','rgb(255, 241, 214)');expect(self.label(v,b.uid)).to_have_css('color','rgb(215, 243, 255)');expect(self.label(v,b.uid)).not_to_contain_text('SYNTHETIC');expect(self.label(v,b.uid)).to_contain_text(b.patient_id)
  p.locator('#appearance-account-save').click();expect(p.locator('#appearance-account-status')).to_have_text('표시 설정을 계정에 저장했습니다.');p.locator('#reading-appearance-close').click()
  f=p.locator('#reading-frame').content_frame;expect(self.label(f,a.uid)).to_have_css('font-size','20px');expect(self.label(f,b.uid)).to_have_css('font-size','14px')
  self.active(v,b.uid);expect(self.label(v,b.uid)).to_contain_text('비교 검사');expect(self.label(v,a.uid)).to_contain_text('기준 검사');expect(p.locator('#findings')).to_have_value('KEEP IDENTITY REPORT');expect(p.locator('#findings')).to_have_css('font-size','12px');expect(v.get_by_label('Job Title',exact=True)).to_have_value('KEEP IDENTITY TITLE');self.assertEqual(self.snapshot(v),before)
  other=self.login();self.workspace(other,a);self.settings(other);expect(other.locator('#viewer-identity-current-size')).to_have_value('12');other.locator('#appearance-account-load').click();expect(other.locator('#viewer-identity-current-size')).to_have_value('20');other.locator('#reading-appearance-close').click();of=other.locator('#reading-frame').content_frame;expect(self.label(of,a.uid)).to_have_css('font-size','20px');expect(self.label(of,b.uid)).not_to_contain_text('SYNTHETIC')
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);v.screenshot(path=str(folder/'current-prior-identity.png'));self.assertEqual(self.jobs(a),[]);self.assertEqual(len(self.versions(a)),1)
 def test_identity_02_wrong_metadata_and_owner_session_clear(self):
  a,b=self.pair();p,v=self.popup(a);expect(self.label(v,a.uid)).to_contain_text(a.patient_id)
  v.evaluate("""()=>{const g=services.viewportGridService.getState(),vp=services.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId);window.identityMeta=cornerstone.metaData.get('instance',vp.getCurrentImageId());window.identitySop=identityMeta.SOPInstanceUID;identityMeta.SOPInstanceUID='1.2.3';}""")
  expect(self.label(v,a.uid)).to_have_count(0);expect(self.label(v,b.uid)).to_contain_text(b.patient_id);v.evaluate('()=>identityMeta.SOPInstanceUID=identitySop');expect(self.label(v,a.uid)).to_contain_text(a.patient_id)
  v.evaluate("()=>{const c=new BroadcastChannel('kin-viewer-identity');c.postMessage({owner:'WRONG OWNER',value:KinViewerIdentity.defaults()});c.close()}");expect(self.label(v,a.uid)).to_contain_text(a.patient_id)
  v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(v.locator('.kin-viewer-identity')).to_have_count(0)
 def test_identity_03_late_account_load_retains_newer_viewer_choice(self):
  a,b=self.pair();p,v=self.popup(a);self.settings(p);p.locator('#appearance-account-save').click();expect(p.locator('#appearance-account-status')).to_have_text('표시 설정을 계정에 저장했습니다.')
  pending=[];p.route('**/api/reading-appearance',lambda route:pending.append(route));p.locator('#appearance-account-load').click();expect(p.locator('#appearance-account-status')).to_have_text('표시 설정 확인 중…');p.locator('#viewer-identity-current-size').select_option('18');self.assertEqual(len(pending),1);pending.pop().fulfill(response=p.request.get(self.stack.api+'/reading-appearance'));expect(p.locator('#appearance-account-status')).to_contain_text('현재 설정이 바뀌어 적용하지 않았습니다');expect(p.locator('#viewer-identity-current-size')).to_have_value('18');expect(self.label(v,a.uid)).to_have_css('font-size','18px')
 def test_identity_04_late_notification_and_storage_failure(self):
  a,b=self.pair();p,v=self.popup(a);self.settings(p);p.locator('#viewer-identity-current-size').select_option('20');expect(self.label(v,a.uid)).to_have_css('font-size','20px')
  p.evaluate("""()=>{const owner=JSON.stringify([KinAuth.session().institution,KinAuth.session().sub]),c=new BroadcastChannel('kin-viewer-identity');c.postMessage({owner,persisted:true,value:KinViewerIdentity.defaults()});c.close();}""");expect(p.locator('#viewer-identity-current-size')).to_have_value('20');expect(self.label(v,a.uid)).to_have_css('font-size','20px')
  p.evaluate("""()=>{window.identitySetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('kin-viewer-identity:'))throw new DOMException('blocked','SecurityError');return identitySetItem.call(this,k,v)}}""");p.locator('#viewer-identity-current-size').select_option('14');expect(p.locator('#viewer-identity-status')).to_contain_text('현재 화면에만');p.locator('#reading-appearance-close').click();f=p.locator('#reading-frame').content_frame;expect(self.label(f,a.uid)).to_have_css('font-size','14px');expect(self.label(v,a.uid)).to_have_css('font-size','20px')
  p.evaluate("""()=>new Promise(resolve=>{const owner=JSON.stringify([KinAuth.session().institution,KinAuth.session().sub]),ack=new BroadcastChannel('kin-viewer-identity'),c=new BroadcastChannel('kin-viewer-identity');ack.onmessage=()=>{ack.close();setTimeout(resolve,0)};c.postMessage({owner,persisted:true});c.close();})""");expect(p.locator('#viewer-identity-current-size')).to_have_value('14');expect(self.label(f,a.uid)).to_have_css('font-size','14px')
  p.evaluate('()=>Storage.prototype.setItem=identitySetItem');self.settings(p);p.locator('#viewer-identity-current-size').select_option('18');p.locator('#reading-appearance-close').click();expect(self.label(f,a.uid)).to_have_css('font-size','18px');expect(self.label(v,a.uid)).to_have_css('font-size','18px')
 def test_identity_05_native_overlay_replacement_events_and_owner_refusal(self):
  a,b=self.pair();p,v=self.popup(a);p.locator('#findings').fill('KEEP REPLACEMENT REPORT');expect(self.label(v,a.uid)).to_be_visible()
  v.evaluate("""()=>{window.identityVp=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);window.identityMeta=cornerstone.metaData.get('instance',identityVp.getCurrentImageId());window.identityName=identityMeta.PatientName;identityMeta.PatientName={Ideographic:'한글 이름'};const pane=identityVp.element.closest('[data-cy="viewport-pane"]')||identityVp.element.parentElement;window.identityNative=pane.querySelector('[data-cy="viewport-overlay-top-right"]');if(!identityNative)throw new Error('Native overlay missing');window.identityNativeText=document.createElement('span');identityNativeText.textContent='NATIVE TOP RIGHT';identityNative.append(identityNativeText);}""")
  expect(self.label(v,a.uid)).to_contain_text('한글 이름');v.wait_for_function("""()=>{const a=identityVp.element.querySelector('.kin-viewer-identity')?.getBoundingClientRect(),b=identityNative.getBoundingClientRect();return a&&b.height>0&&a.top>=b.bottom+5}""");print('NATIVE LABEL BOUNDS',v.evaluate("()=>({label:identityVp.element.querySelector('.kin-viewer-identity').getBoundingClientRect().toJSON(),native:identityNative.getBoundingClientRect().toJSON()})"),flush=True)
  v.evaluate("""()=>{identityNativeText.remove();identityMeta.PatientName=identityName;window.identityTransitions=[];document.addEventListener(cornerstone.Enums.Events.STACK_NEW_IMAGE,e=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(e.detail.viewportId);if(v)identityTransitions.push({image:v.getCurrentImageId?.(),label:v.element.querySelector('.kin-viewer-identity')?.dataset.study||null});},true);}""")
  v.evaluate("""uid=>{window.identityLoadVp=[...services.viewportGridService.getState().viewports.keys()].map(id=>services.cornerstoneViewportService.getCornerstoneViewport(id)).find(v=>v.getCurrentImageId?.().includes('/studies/'+uid+'/'));const ids=identityLoadVp.getImageIds(),index=(identityLoadVp.getCurrentImageIdIndex()+1)%ids.length;window.identityLoadTarget=ids[index];window.identityLoader=identityLoadVp.imagesLoader;window.identityLoadOriginal=identityLoader.loadImages;identityLoader.loadImages=function(images,...args){if(!images.includes(identityLoadTarget))return identityLoadOriginal.call(this,images,...args);return new Promise((resolve,reject)=>{window.identityRelease=()=>identityLoadOriginal.call(this,images,...args).then(resolve,reject)})};window.identityLoadPromise=identityLoadVp.setImageIdIndex(index);}""",b.uid)
  try:
   v.wait_for_function("()=>typeof identityRelease==='function'");expect(self.label(v,b.uid)).to_have_count(0)
   samples=v.evaluate("""()=>new Promise(resolve=>{const samples=[],start=performance.now();function frame(){samples.push({image:identityLoadVp.getCurrentImageId(),label:identityLoadVp.element.querySelector('.kin-viewer-identity')?.dataset.study||null});if(performance.now()-start>=650)resolve(samples);else requestAnimationFrame(frame)}requestAnimationFrame(frame)})""");self.assertGreaterEqual(len(samples),3);self.assertTrue(all(s['label'] is None for s in samples));print('HELD LOADER ANIMATION FRAMES',samples,flush=True)
   v.evaluate('()=>{identityLoader.loadImages=identityLoadOriginal;identityRelease();identityRelease=null}');v.evaluate('()=>identityLoadPromise');expect(self.label(v,b.uid)).to_contain_text(b.patient_id);self.assertTrue(v.evaluate('()=>identityLoadVp.getCurrentImageId()===identityLoadTarget'))
  finally:v.evaluate('()=>{identityLoader.loadImages=identityLoadOriginal;identityRelease?.();identityRelease=null}')
  self.drag(v,'D03A past',0);expect(self.label(v,a.uid)).to_have_count(0);expect(self.label(v,b.uid)).to_have_count(2);trace=v.evaluate('()=>identityTransitions');self.assertTrue(trace);print('REPLACEMENT LABEL TRACE',trace,flush=True)
  for row in trace:
   if row['label']:self.assertIn('/studies/'+row['label']+'/',row['image'])
  expect(p.locator('#findings')).to_have_value('KEEP REPLACEMENT REPORT');self.settings(p);p.evaluate("()=>{window.identityOriginalKey=KinWorkspaceLayout.key;KinWorkspaceLayout.key=()=>KinWorkspaceLayout.PREFIX+'[\"wrong\",\"owner\"]'}");p.locator('#viewer-identity-current-size').select_option('18');expect(p.locator('#reading-appearance-dialog')).not_to_be_visible();expect(p.locator('#reading-appearance-open')).to_be_disabled();expect(p.locator('#viewer-identity-current-size')).to_be_disabled();p.evaluate('()=>KinWorkspaceLayout.key=identityOriginalKey')

def load_tests(loader,tests,pattern):return unittest.TestSuite(ViewerIdentityE2E(n) for n in loader.getTestCaseNames(ViewerIdentityE2E) if n.startswith('test_identity_'))
if __name__=='__main__':unittest.main(verbosity=2)
