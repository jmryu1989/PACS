# coding: utf-8
"""Loaded MPR source consensus, clipboard guards and retained reading work."""
import json,os,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_image_context_copy import ImageContextCopyE2E
from test_embedded_patient_copy import EmbeddedPatientCopyE2E

class VolumePatientCopyE2E(ImageContextCopyE2E):
 def active(self,v,uid):
  if hasattr(v,'page'):EmbeddedPatientCopyE2E.active(self,v,uid)
  else:super().active(v,uid)
 def mpr(self,v):
  v.locator('[data-cy=Layout]').click();v.get_by_text('MPR',exact=True).click()
  v.wait_for_function("""()=>{const g=services.viewportGridService.getState();return g.viewports.size===3&&[...g.viewports.keys()].every(id=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id);return v?.type==='orthographic'&&cornerstone.cache.getVolume(v.getVolumeId())?.loadStatus.loaded})}""")
  expect(v.locator('#kin-viewer-copy-id')).to_be_enabled();self.tools(v)
  # The initial MPR canvas is rounded up, then the queued native resize uses
  # client dimensions. Compare copy operations only after that resize completes.
  v.wait_for_function("""()=>[...services.viewportGridService.getState().viewports.keys()].every(id=>{const c=services.cornerstoneViewportService.getCornerstoneViewport(id).element.querySelector('canvas');return c.width===Math.floor(c.clientWidth*devicePixelRatio)&&c.height===Math.floor(c.clientHeight*devicePixelRatio)})""")
 def volume_state(self,v):
  return v.evaluate("""()=>[...services.viewportGridService.getState().viewports.keys()].map(id=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id),c=v.element.querySelector('canvas'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let hash=2166136261,min=255,max=0;for(let n=0;n<p.length;n+=4){hash=Math.imul(hash^p[n],16777619)>>>0;min=Math.min(min,p[n]);max=Math.max(max,p[n]);}return {id,volume:v.getVolumeId(),image:v.getCurrentImageId()||null,camera:v.getCamera(),properties:v.getProperties(),hash,min,max}})""")
 def choose_volume(self,page,v,index):
  b=v.locator('[data-cy=viewport-grid] > div').nth(index).locator('canvas').bounding_box();page.mouse.click(b['x']+b['width']*.5,b['y']+b['height']*.3)
 def test_volume_01_native_mpr_planes_copy_and_preserve(self):
  a,b=self.pair();p,v=self.popup(a);p.locator('#findings').fill('KEEP MPR REPORT');v.get_by_label('작업 제목',exact=True).fill('KEEP MPR TITLE');self.mpr(v)
  before=self.volume_state(v);self.assertEqual(len(before),3);self.assertTrue(all(s['max']>s['min'] for s in before));self.assertIsNone(before[1]['image']);self.assertIsNone(before[2]['image'])
  for index in range(3):
   self.choose_volume(v,v,index);expect(v.locator('#kin-viewer-copy-context')).to_contain_text('선택 볼륨 원본');v.locator('#kin-viewer-copy-id').focus();v.keyboard.press('Control+Alt+c');self.copied(v);self.assertEqual(self.clipboard(v),a.patient_id)
  self.right_click(v,2);expect(self.item(v)).to_contain_text(a.patient_id);self.item(v).click();self.copied(v);self.assertEqual(self.clipboard(v),a.patient_id)
  v.locator('#kin-viewer-note-open').click();expect(v.locator('#kin-viewer-note-status')).to_contain_text('메모 대상을 확인할 수 없습니다');expect(v.locator('#tech-note-dialog')).not_to_be_visible();expect(p.locator('#findings')).to_have_value('KEEP MPR REPORT');expect(v.get_by_label('작업 제목',exact=True)).to_have_value('KEEP MPR TITLE');after=self.volume_state(v);print('MPR before/after '+json.dumps(dict(before=before,after=after)),flush=True)
  for left,right in zip(before,after):
   self.assertEqual({k:value for k,value in left.items() if k!='camera'},{k:value for k,value in right.items() if k!='camera'})
   self.assertEqual(left['camera'].keys(),right['camera'].keys())
   for key,value in left['camera'].items():
    other=right['camera'][key]
    # Native MPR viewport selection recomputes camera floats (~1e-14).
    # Keep pixel/VOI/source comparisons exact; bound camera drift to 1e-9.
    if isinstance(value,list):
     self.assertEqual(len(value),len(other))
     for x,y in zip(value,other):self.assertAlmostEqual(x,y,delta=1e-9)
    elif isinstance(value,(int,float)) and not isinstance(value,bool):self.assertAlmostEqual(value,other,delta=1e-9)
    else:self.assertEqual(value,other)
  self.assertEqual(self.jobs(a),[]);self.assertEqual(len(self.versions(a)),1)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);v.screenshot(path=str(folder/'mpr-source-copy.png'));print('MPR source copy '+json.dumps(before),flush=True)
 def test_volume_02_all_sources_loading_fusion_and_camera_aba_refuse(self):
  a,b=self.pair();p,v=self.popup(a);self.mpr(v);self.choose_volume(v,v,1);v.evaluate('()=>navigator.clipboard.writeText("KEEP VOLUME CLIPBOARD")')
  v.evaluate("""()=>{window.vp=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);window.vol=cornerstone.cache.getVolume(vp.getVolumeId());window.lastMeta=cornerstone.metaData.get('instance',vol.imageIds.at(-1));window.originalMeta={...lastMeta};window.originalActors=vp.getActors;window.originalCamera=vp.getCamera();}""")
  for change,restore in [("lastMeta.PatientID='WRONG'","lastMeta.PatientID=originalMeta.PatientID"),("lastMeta.SOPInstanceUID='1.2.3'","lastMeta.SOPInstanceUID=originalMeta.SOPInstanceUID"),("vol.loadStatus.loaded=false","vol.loadStatus.loaded=true"),("vol.framesLoaded--","vol.framesLoaded++"),("vp.getActors=()=>[...originalActors.call(vp),originalActors.call(vp)[0]]","vp.getActors=originalActors")]:
   v.evaluate('()=>{'+change+'}');expect(v.locator('#kin-viewer-copy-id')).to_be_disabled();v.locator('#kin-viewer-copy-context').click();v.keyboard.press('Control+Alt+c');self.assertEqual(self.clipboard(v),'KEEP VOLUME CLIPBOARD');v.evaluate('()=>{'+restore+'}');expect(v.locator('#kin-viewer-copy-id')).to_be_enabled()
  self.right_click(v,1);expect(self.item(v)).to_be_visible();v.evaluate('()=>{vp.setCamera({parallelScale:originalCamera.parallelScale*1.1});vp.setCamera(originalCamera);}');self.item(v).click();expect(v.locator('#kin-viewer-copy-status')).to_contain_text('메뉴를 다시 열어');self.assertEqual(self.clipboard(v),'KEEP VOLUME CLIPBOARD')
  self.right_click(v,1);self.item(v).click();self.copied(v);self.assertEqual(self.clipboard(v),a.patient_id)
 def test_volume_03_embedded_parent_modal_and_session(self):
  a,b=self.pair();p,f=EmbeddedPatientCopyE2E.opened(self,a);self.mpr(f);self.choose_volume(p,f,1);f.locator('#kin-viewer-copy-id').click();self.copied(f);self.assertEqual(p.evaluate('()=>navigator.clipboard.readText()'),a.patient_id)
  p.evaluate('()=>navigator.clipboard.writeText("KEEP PARENT VOLUME")');p.evaluate('()=>{window.volumeDialog=document.createElement("dialog");document.body.append(volumeDialog);volumeDialog.showModal()}');expect(f.locator('#kin-viewer-copy-id')).to_be_disabled();f.evaluate("()=>document.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyC',ctrlKey:true,altKey:true,bubbles:true}))");self.assertEqual(p.evaluate('()=>navigator.clipboard.readText()'),'KEEP PARENT VOLUME');p.evaluate('()=>volumeDialog.remove()');expect(f.locator('#kin-viewer-copy-id')).to_be_enabled()
  p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(p.locator('#reading-viewer iframe')).to_have_count(0);self.assertEqual(p.evaluate('()=>navigator.clipboard.readText()'),'KEEP PARENT VOLUME')

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumePatientCopyE2E(n) for n in loader.getTestCaseNames(VolumePatientCopyE2E) if n.startswith('test_volume_'))
if __name__=='__main__':unittest.main(verbosity=2)
