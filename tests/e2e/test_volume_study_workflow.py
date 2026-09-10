# coding: utf-8
"""TEST-VOLUME-STUDY-WORKFLOW: verified MPR sources, note and report roundtrip."""
import os,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_volume_patient_copy import VolumePatientCopyE2E
from test_embedded_patient_copy import EmbeddedPatientCopyE2E
from test_window_return import WindowReturnE2E

class VolumeStudyWorkflowE2E(VolumePatientCopyE2E):
 def preserved_volume(self,before,after):
  self.assertEqual(len(before),len(after))
  for left,right in zip(before,after):
   self.assertEqual({k:v for k,v in left.items() if k!='camera'},{k:v for k,v in right.items() if k!='camera'})
   self.assertEqual(left['camera'].keys(),right['camera'].keys())
   for key,value in left['camera'].items():
    other=right['camera'][key]
    if isinstance(value,list):
     self.assertEqual(len(value),len(other))
     for x,y in zip(value,other):self.assertAlmostEqual(x,y,delta=1e-9)
    elif isinstance(value,(int,float)) and not isinstance(value,bool):self.assertAlmostEqual(value,other,delta=1e-9)
    else:self.assertEqual(value,other)
 def test_volume_study_01_three_planes_note_and_linked_report(self):
  a,b=self.pair();self.note(a,'MPR SOURCE STUDY NOTE');original=self.originals();p,v=self.popup(a);self.mpr(v)
  p.locator('#findings').fill('KEEP MPR REPORT DRAFT');v.get_by_label('Job Title',exact=True).fill('KEEP MPR JOB');before=self.volume_state(v);url=v.url
  for index in range(3):
   self.choose_volume(v,v,index);self.open_note(v);expect(v.locator('#tech-note-target')).to_contain_text(a.uid);expect(v.locator('#tech-note-text')).to_have_value('MPR SOURCE STUDY NOTE');expect(v.locator('#tech-note-save')).to_be_disabled();expect(v.locator('#kin-viewer-note-status')).to_contain_text('볼륨 원본 검사 메모');v.locator('#tech-note-close').click()
  v.keyboard.press('Control+Alt+4');WindowReturnE2E.returned(self,p,v)
  expect(p.locator('#findings')).to_have_value('KEEP MPR REPORT DRAFT');expect(p.locator('#reading-target')).to_contain_text(a.uid);expect(v.get_by_label('Job Title',exact=True)).to_have_value('KEEP MPR JOB');self.assertEqual(v.url,url);self.preserved_volume(before,self.volume_state(v));self.assertEqual(self.jobs(a),[]);self.assertEqual(len(self.versions(a)),1);self.assertEqual(self.originals(),original)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);v.screenshot(path=str(folder/'mpr-study-note-return.png'))
 def test_volume_study_02_technician_save_and_reopen(self):
  a,b=self.pair();original=self.originals();v=self.launch(self.login('tech'),[a]);self.ready(v);self.mpr(v);self.choose_volume(v,v,2);before=self.volume_state(v)
  self.open_note(v);expect(v.locator('#tech-note-text')).to_be_editable();v.locator('#tech-note-text').fill('MPR TECHNICIAN SOURCE NOTE');v.locator('#tech-note-save').click();expect(v.locator('#tech-note-status')).to_contain_text('저장되었습니다. v1');v.locator('#tech-note-close').click()
  self.choose_volume(v,v,1);self.open_note(v);expect(v.locator('#tech-note-text')).to_have_value('MPR TECHNICIAN SOURCE NOTE');v.locator('#tech-note-history').click();expect(v.locator('#tech-note-history-items section')).to_have_count(1);v.locator('#tech-note-close').click();self.preserved_volume(before,self.volume_state(v));self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1);self.assertEqual(self.jobs(a),[])
 def test_volume_study_03_embedded_source_scope_and_incomplete_refusal(self):
  a,b=self.pair();self.note(a,'EMBEDDED SOURCE NOTE');p,f=EmbeddedPatientCopyE2E.opened(self,a);self.mpr(f);self.choose_volume(p,f,1);p.locator('#findings').fill('KEEP EMBEDDED MPR REPORT');before=self.volume_state(f)
  target=f.evaluate('()=>kinViewerSelectedNoteTarget()');self.assertEqual(target['uid'],a.uid);self.assertEqual(target['kind'],'volume');self.assertNotIn('sop',target);self.assertNotIn('image',target)
  expect(p.locator('#reading-tech-note')).to_have_text('Volume Tech Note · 있음');f.get_by_label('Job Title',exact=True).focus();p.keyboard.press('Control+Alt+6');expect(p.locator('#tech-note-text')).to_have_value('EMBEDDED SOURCE NOTE');p.locator('#tech-note-close').click();expect(f.get_by_label('Job Title',exact=True)).to_be_focused()
  f.evaluate("""()=>{window.vp=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);window.vol=cornerstone.cache.getVolume(vp.getVolumeId());window.meta=cornerstone.metaData.get('instance',vol.imageIds.at(-1));window.oldMeta={...meta};window.oldActors=vp.getActors;}""")
  for change,restore in [("vol.loadStatus.loaded=false","vol.loadStatus.loaded=true"),("vol.framesLoaded--","vol.framesLoaded++"),("meta.PatientID='WRONG'","meta.PatientID=oldMeta.PatientID"),("meta.StudyInstanceUID='1.2.3'","meta.StudyInstanceUID=oldMeta.StudyInstanceUID"),("vp.getActors=()=>[...oldActors.call(vp),oldActors.call(vp)[0]]","vp.getActors=oldActors")]:
   f.evaluate('()=>{'+change+'}');self.assertIsNone(f.evaluate('()=>kinViewerSelectedNoteTarget()'));expect(p.locator('#reading-tech-note')).to_be_disabled();expect(p.locator('#tech-note-dialog')).not_to_be_visible();f.evaluate('()=>{'+restore+'}');expect(p.locator('#reading-tech-note')).to_be_enabled()
  self.preserved_volume(before,self.volume_state(f));expect(p.locator('#findings')).to_have_value('KEEP EMBEDDED MPR REPORT');self.assertEqual(len(self.versions(a)),1)
 def test_volume_study_04_auth_pending_viewport_aba_rejects(self):
  a,b=self.pair();p,v=self.popup(a);self.mpr(v);self.choose_volume(v,v,1);waiting=[]
  v.route('**/api/me',lambda route:waiting.append(route));v.locator('#kin-viewer-note-open').click()
  for _ in range(100):
   if waiting:break
   v.wait_for_timeout(50)
  self.assertTrue(waiting,'Native authentication request must be held')
  self.choose_volume(v,v,2);self.choose_volume(v,v,1)
  for route in waiting:route.continue_()
  expect(v.locator('#kin-viewer-note-status')).to_contain_text('선택 영상이 바뀌었습니다');expect(v.locator('#tech-note-dialog')).not_to_be_visible();v.unroute('**/api/me');self.open_note(v);expect(v.locator('#tech-note-target')).to_contain_text(a.uid);v.locator('#tech-note-close').click()
 def test_volume_study_05_prior_volume_keeps_current_report(self):
  a,b=self.pair();self.note(a,'CURRENT NOTE');self.note(b,'PRIOR MPR NOTE');p,v=self.popup(a);self.active(v,b.uid);self.mpr(v);self.choose_volume(v,v,2);p.locator('#findings').fill('CURRENT REPORT WITH PRIOR MPR');before=self.volume_state(v)
  self.open_note(v);expect(v.locator('#tech-note-target')).to_contain_text(b.uid);expect(v.locator('#tech-note-text')).to_have_value('PRIOR MPR NOTE');v.locator('#tech-note-close').click();v.keyboard.press('Control+Alt+4');WindowReturnE2E.returned(self,p,v);expect(p.locator('#reading-target')).to_contain_text(a.uid);expect(p.locator('#findings')).to_have_value('CURRENT REPORT WITH PRIOR MPR');self.preserved_volume(before,self.volume_state(v));self.assertEqual(len(self.versions(a)),1);self.assertEqual(len(self.versions(b)),1);self.assertEqual(self.jobs(a),[]);self.assertEqual(self.jobs(b),[])
 def test_volume_study_06_same_study_scroll_and_camera_keep_pending_note(self):
  a,b=self.pair();p,v=self.popup(a)
  for volume in [False,True]:
   if volume:self.mpr(v);self.choose_volume(v,v,1)
   waiting=[]
   def hold_first(route):
    if not waiting:waiting.append(route)
    else:route.continue_()
   v.route('**/api/me',hold_first);v.locator('#kin-viewer-note-open').click()
   for _ in range(100):
    if waiting:break
    v.wait_for_timeout(50)
   self.assertTrue(waiting)
   v.evaluate("""async volume=>{const vp=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);if(volume){vp.setCamera({parallelScale:vp.getCamera().parallelScale*1.1});vp.render();}else{await vp.setImageIdIndex(vp.getCurrentImageIdIndex()+1);vp.render();}}""",volume)
   waiting[0].continue_();expect(v.locator('#tech-note-target')).to_contain_text(a.uid);expect(v.locator('#tech-note-meta')).not_to_be_empty();v.unroute('**/api/me');v.locator('#tech-note-close').click()
 def test_volume_study_07_camera_events_avoid_source_walk_but_open_revalidates(self):
  a,b=self.pair();p,v=self.popup(a);self.mpr(v);self.choose_volume(v,v,1)
  count=v.evaluate("""()=>{const vp=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId),vol=cornerstone.cache.getVolume(vp.getVolumeId()),get=cornerstone.metaData.get;let calls=0,events=0;const observe=()=>events++;document.addEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED,observe,true);cornerstone.metaData.get=function(type,...args){if(type==='instance')calls++;return get.call(this,type,...args)};try{const camera=vp.getCamera();for(let n=0;n<50;n++)vp.setCamera({parallelScale:camera.parallelScale*(n%2?1:1.01)});vp.setCamera(camera);return {calls,events,sources:vol.imageIds.length};}finally{cornerstone.metaData.get=get;document.removeEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED,observe,true)}}""")
  print('CAMERA_SOURCE_LOOKUPS',count,flush=True);self.assertGreaterEqual(count['events'],50);self.assertEqual(count['calls'],0,'Native camera events must not iterate instance metadata')
  v.evaluate("""()=>{const vp=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId),vol=cornerstone.cache.getVolume(vp.getVolumeId());window.sourceMeta=cornerstone.metaData.get('instance',vol.imageIds.at(-1));window.sourcePatient=sourceMeta.PatientID;sourceMeta.PatientID='WRONG SOURCE';document.querySelector('#kin-viewer-note-open').click()}""")
  expect(v.locator('#kin-viewer-note-status')).to_contain_text('메모 대상을 확인할 수 없습니다');expect(v.locator('#tech-note-dialog')).not_to_be_visible();v.evaluate('()=>sourceMeta.PatientID=sourcePatient');self.open_note(v);expect(v.locator('#tech-note-target')).to_contain_text(a.uid);v.locator('#tech-note-close').click()

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeStudyWorkflowE2E(n) for n in loader.getTestCaseNames(VolumeStudyWorkflowE2E) if n.startswith('test_volume_study_'))
if __name__=='__main__':unittest.main(verbosity=2)
