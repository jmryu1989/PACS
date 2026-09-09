# coding: utf-8
"""TEST-VIEWER-TITLE: active rendered identity, preferences and lifecycle."""
import os,re,unittest
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from playwright.sync_api import expect
from test_viewer_identity import ViewerIdentityE2E
from test_embedded_patient_copy import EmbeddedPatientCopyE2E

NEUTRAL='판독 뷰어 — KOREA IMAGING NETWORK'

class ViewerTitleE2E(ViewerIdentityE2E):
 def test_title_01_current_prior_preferences_and_embedded_name(self):
  a,b=self.pair();p,v=self.popup(a);parent_title=p.title();before=self.snapshot(v)
  expect(v).to_have_title(re.compile('기준 검사.*'+re.escape(a.patient_id)+'.*20260801.*CT'))
  p.locator('#findings').fill('KEEP TITLE REPORT');v.get_by_label('작업 제목',exact=True).fill('KEEP JOB TITLE')
  self.active(v,b.uid);expect(v).to_have_title(re.compile('비교 검사.*20260701'))
  self.settings(p);p.locator('#viewer-identity-prior-name').uncheck();p.locator('#viewer-identity-prior-date').uncheck();p.locator('#reading-appearance-close').click()
  expected='비교 검사 · '+b.patient_id+' · CT — 판독 뷰어';expect(v).to_have_title(expected)
  f=next(f for f in p.frames if '/ohif/viewer' in f.url);EmbeddedPatientCopyE2E.active(self,f,b.uid)
  expect(p.locator('#reading-frame')).to_have_attribute('title',expected);self.assertEqual(f.evaluate('()=>document.title'),expected);expect(p).to_have_title(parent_title)
  expect(p.locator('#findings')).to_have_value('KEEP TITLE REPORT');expect(v.get_by_label('작업 제목',exact=True)).to_have_value('KEEP JOB TITLE');self.assertEqual(self.snapshot(v),before)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'embedded-active-title.png'));print('ACTIVE TITLES',v.title(),p.locator('#reading-frame').get_attribute('title'),flush=True)
  p.evaluate("()=>{window.titleOwnerKey=KinWorkspaceLayout.key;KinWorkspaceLayout.key=()=>KinWorkspaceLayout.PREFIX+'[\"wrong\",\"owner\"]'}");expect(p.locator('#reading-frame')).to_have_attribute('title','영상 뷰어');self.assertEqual(f.evaluate('()=>document.title'),NEUTRAL)
  p.evaluate('()=>KinWorkspaceLayout.key=titleOwnerKey');expect(p.locator('#reading-frame')).to_have_attribute('title',expected)
  f.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeExit()");expect(p.locator('#reading-frame')).to_have_attribute('title','영상 뷰어')
  f.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeEnter()");expect(p.locator('#reading-frame')).to_have_attribute('title',expected,timeout=45000)
  p.evaluate("()=>localStorage.setItem('kin-session-ended',String(Date.now()))");expect(v).to_have_title(NEUTRAL);expect(p.locator('#reading-frame')).to_have_attribute('title','영상 뷰어')
  samples=v.evaluate("""()=>new Promise(resolve=>{const samples=[],start=performance.now();function frame(){samples.push(document.title);if(performance.now()-start>=700)resolve(samples);else requestAnimationFrame(frame)}requestAnimationFrame(frame)})""");self.assertGreaterEqual(len(samples),3);self.assertEqual(set(samples),{NEUTRAL});expect(p.locator('#reading-frame')).to_have_attribute('title','영상 뷰어');print('ENDED TITLE FRAMES',len(samples),samples,flush=True)
 def test_title_02_loading_frames_and_invalid_metadata_clear(self):
  a,b=self.pair();p,v=self.popup(a);self.active(v,b.uid);expect(v).to_have_title(re.compile('비교 검사.*20260701'))
  v.evaluate("""()=>{window.titleVp=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);const ids=titleVp.getImageIds(),index=(titleVp.getCurrentImageIdIndex()+1)%ids.length;window.titleTarget=ids[index];window.titleLoader=titleVp.imagesLoader;window.titleOriginal=titleLoader.loadImages;titleLoader.loadImages=function(images,...args){if(!images.includes(titleTarget))return titleOriginal.call(this,images,...args);return new Promise((resolve,reject)=>{window.titleRelease=()=>titleOriginal.call(this,images,...args).then(resolve,reject)})};window.titlePromise=titleVp.setImageIdIndex(index);}""")
  try:
   v.wait_for_function("()=>typeof window.titleRelease==='function'");expect(v).to_have_title(NEUTRAL)
   samples=v.evaluate("""()=>new Promise(resolve=>{const samples=[],start=performance.now();function frame(){samples.push(document.title);if(performance.now()-start>=650)resolve(samples);else requestAnimationFrame(frame)}requestAnimationFrame(frame)})""");self.assertGreaterEqual(len(samples),3);self.assertEqual(set(samples),{NEUTRAL});print('HELD TITLE FRAMES',len(samples),samples,flush=True)
   v.evaluate('()=>{titleLoader.loadImages=titleOriginal;titleRelease();titleRelease=null}');v.evaluate('()=>titlePromise');expect(v).to_have_title(re.compile('비교 검사.*20260701'));self.assertTrue(v.evaluate('()=>titleVp.getCurrentImageId()===titleTarget'))
  finally:v.evaluate('()=>{titleLoader.loadImages=titleOriginal;window.titleRelease?.();window.titleRelease=null}')
  v.evaluate("()=>{window.titleMeta=cornerstone.metaData.get('instance',titleVp.getCurrentImageId());window.titleSop=titleMeta.SOPInstanceUID;titleMeta.SOPInstanceUID='1.2.3'}");expect(v).to_have_title(NEUTRAL)
  v.evaluate('()=>titleMeta.SOPInstanceUID=titleSop');expect(v).to_have_title(re.compile('비교 검사.*20260701'))
  v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(v).to_have_title(NEUTRAL)
 def test_title_03_no_competing_qido_writer_and_mode_lifecycle(self):
  a,b=self.pair();p=self.login();legacy=[]
  def route_qido(route):
   if parse_qs(urlparse(route.request.url).query).get('includefield')==['00081030,00180015,00080061,00100010']:
    legacy.append(route.request.url);route.fulfill(status=200,content_type='application/json',body='[{"00100010":{"Value":[{"Alphabetic":"WRONG PATIENT"}]},"00080061":{"Value":["CT"]}}]')
   else:route.continue_()
  p.context.route('**/dicom-web/studies?**',route_qido);v=self.launch(p,[a]);self.ready(v);expect(v).to_have_title(re.compile('기준 검사.*'+re.escape(a.patient_id)));self.assertEqual(legacy,[])
  v.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeExit()");expect(v).to_have_title(NEUTRAL)
  v.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeEnter()");expect(v).to_have_title(re.compile('기준 검사.*'+re.escape(a.patient_id)),timeout=45000);self.assertEqual(legacy,[])

def load_tests(loader,tests,pattern):return unittest.TestSuite(ViewerTitleE2E(n) for n in loader.getTestCaseNames(ViewerTitleE2E) if n.startswith('test_title_'))
if __name__=='__main__':unittest.main(verbosity=2)
