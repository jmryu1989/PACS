# coding: utf-8
import time
import unittest
import numpy as np
from playwright.sync_api import expect
from test_volume_orientation import VolumeOrientationE2E

class VolumeCineE2E(VolumeOrientationE2E):
 CAPTURE_TIMEOUT_MS=10000
 def wait_for_capture(self,v,size,what,count=1):
  # Route handlers and page listeners append after the action returns, so a fixed window can expire
  # before the append lands (D-CINETIMING 추가 1). Poll the capture itself; sync-API route handlers
  # run on this thread while wait_for_timeout blocks.
  deadline=time.monotonic()+self.CAPTURE_TIMEOUT_MS/1000
  while True:
   got=size()
   if got>=count:return got
   if time.monotonic()>=deadline:self.fail('%s captured %d/%d within %dms'%(what,got,count,self.CAPTURE_TIMEOUT_MS))
   v.wait_for_timeout(10)
 def cine_open(self,v):
  errors=[];v.on('pageerror',lambda e:errors.append(str(e)));self.addCleanup(lambda:self.assertEqual(errors,[]))
  v.locator('[data-cy="MoreTools-split-button-secondary"]').click();v.locator('[data-cy="Cine"]').click();expect(v.locator('#kin-cine')).to_be_visible()
 def cine_play(self,v):
  v.locator('[data-cy=viewport-grid] > div').nth(0).locator('[data-cy="cine-player-play-pause"]').click()
 def watch_cine(self,v):
  v.evaluate("""()=>{window.cineView=services.cornerstoneViewportService.getCornerstoneViewport('mpr-axial');window.cinePositions=[];window.cinePixels=[];cineView.element.addEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED,()=>{const p=cineView.getCamera().focalPoint;if(!cinePositions.length||p.some((x,i)=>Math.abs(x-cinePositions.at(-1).point[i])>1e-6))cinePositions.push({point:p,time:performance.now()})});cineView.element.addEventListener(cornerstone.Enums.Events.IMAGE_RENDERED,()=>{const c=cineView.getCanvas(),p=cineView.getCamera().focalPoint,q=cineView.worldToCanvas(p);cinePixels.push({point:p,value:c.getContext('2d').getImageData(Math.floor(q[0]*c.width/c.clientWidth),Math.floor(q[1]*c.height/c.clientHeight),1,1).data[0]})})}""")
 def test_volume_cine_01_both_endpoints_direction_pixels(self):
  a,p,v=self.starting();original=self.originals();p.locator('#findings').fill('KEEP MPR CINE REPORT');self.cine_open(v);v.get_by_label('Loop',exact=True).uncheck();v.get_by_role('button',name='First Plane',exact=True).click();v.wait_for_timeout(200);before=self.volume_state(v);self.assertAlmostEqual(before[0]['camera']['focalPoint'][2],32,delta=1e-6);self.watch_cine(v);self.cine_play(v)
  v.wait_for_function("()=>services.cineService.getState().cines['mpr-axial'].isPlaying===false",timeout=10000);forward=v.evaluate('()=>cinePositions');np.testing.assert_allclose([r['point'][2] for r in forward],list(range(31,-1,-1)),atol=1e-6,rtol=0);fps=(len(forward)-1)*1000/(forward[-1]['time']-forward[0]['time']);self.assertGreater(fps,18);self.assertLess(fps,30);print('VOLUME_CINE_FPS',fps,flush=True)
  pixels=v.evaluate('()=>cinePixels');self.assertTrue(pixels)
  for row in pixels:
   z=row['point'][2];want=25 if z<10.5 else 230 if z>=21.5 else 128;self.assertAlmostEqual(row['value'],want,delta=3)
  self.preserved_volume(before[1:],self.volume_state(v)[1:]);v.get_by_label('Playback Direction',exact=True).select_option('reverse');v.evaluate('()=>{cinePositions=[];cinePixels=[]}');self.cine_play(v);v.wait_for_function("()=>services.cineService.getState().cines['mpr-axial'].isPlaying===false",timeout=10000);reverse=v.evaluate('()=>cinePositions');np.testing.assert_allclose([r['point'][2] for r in reverse],list(range(1,33)),atol=1e-6,rtol=0);expect(p.locator('#findings')).to_have_value('KEEP MPR CINE REPORT');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1);print('CINE_BOTH_DIRECTIONS',len(forward),len(reverse),flush=True)
 def test_volume_cine_02_selection_modal_session_stop(self):
  a,p,v=self.starting();self.cine_open(v);self.watch_cine(v);self.cine_play(v);v.wait_for_function('()=>cinePositions.length>=3');self.choose_volume(v,v,1);v.wait_for_function("()=>services.cineService.getState().cines['mpr-axial'].isPlaying===false");count=v.evaluate('()=>cinePositions.length');v.wait_for_timeout(250);self.assertEqual(v.evaluate('()=>cinePositions.length'),count)  # negative assertion: fixed window is the delivery margin for frames that must not arrive after the modal stop
  self.choose_volume(v,v,0);v.wait_for_timeout(600);v.get_by_label('Playback Direction',exact=True).select_option('reverse');v.get_by_label('Loop',exact=True).uncheck();self.cine_play(v);v.wait_for_function('(count)=>cinePositions.length>count',arg=count);self.open_note(v);v.wait_for_function("()=>services.cineService.getState().cines['mpr-axial'].isPlaying===false");v.locator('#tech-note-close').click();expect(v.get_by_label('Playback Direction',exact=True)).to_have_value('reverse');expect(v.get_by_label('Loop',exact=True)).not_to_be_checked();self.cine_play(v);v.wait_for_timeout(200)
  # The 300ms and 100ms windows below are negative-assertion delivery margins: no frame may arrive after session end, and play must never start.
  v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");v.wait_for_function("()=>services.cineService.getState().cines['mpr-axial'].isPlaying===false");v.wait_for_timeout(200);count=v.evaluate('()=>cinePositions.length');v.wait_for_timeout(300);self.assertEqual(v.evaluate('()=>cinePositions.length'),count);self.cine_play(v);v.wait_for_timeout(100);self.assertFalse(v.evaluate("()=>services.cineService.getState().cines['mpr-axial'].isPlaying"));self.assertEqual(len(self.versions(a)),1)
 def test_volume_cine_03_oblique_spacing_and_loop(self):
  a,p,v=self.starting();self.rotate_planes(v,0,25);self.rotate_planes(v,1,-35);self.cine_open(v);v.get_by_label('Loop',exact=True).uncheck();v.get_by_role('button',name='First Plane',exact=True).click();v.wait_for_timeout(200);before=self.volume_state(v);normal=np.array(before[0]['camera']['viewPlaneNormal']);first=np.array(before[0]['camera']['focalPoint']);last=int(np.floor(float(np.dot(np.abs(normal),[63,63,32]))));self.assertAlmostEqual(float(np.dot(first,normal)),float(np.minimum(normal*[63,63,32],0).sum()),delta=2e-5);self.watch_cine(v);self.cine_play(v);v.wait_for_function("()=>services.cineService.getState().cines['mpr-axial'].isPlaying===false",timeout=10000);positions=v.evaluate('()=>cinePositions');self.assertEqual(len(positions),last)
  for i,row in enumerate(positions,1):np.testing.assert_allclose(row['point'],first+normal*i,atol=2e-5,rtol=0)
  self.preserved_volume(before[1:],self.volume_state(v)[1:]);self.assertGreater(len(positions),40);v.get_by_label('Loop',exact=True).check();v.evaluate('()=>cinePositions=[]');self.cine_play(v);v.wait_for_function('()=>cinePositions.length>=3');self.cine_play(v);points=v.evaluate('()=>cinePositions');np.testing.assert_allclose(points[0]['point'],first,atol=2e-5,rtol=0);self.assertEqual(len(self.versions(a)),1);print('OBLIQUE_CINE_POSITIONS',last,flush=True)
 def test_volume_cine_04_delayed_permission_and_source_change(self):
  a,p,v=self.starting();self.cine_open(v);self.watch_cine(v);pending=[];pattern='**/api/me';v.route(pattern,lambda r:pending.append(r));self.cine_play(v);self.wait_for_capture(v,lambda:len(pending),'/api/me');self.assertTrue(pending)
  v.evaluate("()=>{window.cineVolume=cornerstone.cache.getVolume(cineView.getVolumeId());cineVolume.framesLoaded--}")
  for request in pending:request.fulfill(response=request.fetch())
  # The 200ms window below is a negative-assertion delivery margin: no camera move may ever arrive.
  v.unroute(pattern);v.wait_for_function("()=>services.cineService.getState().cines['mpr-axial'].isPlaying===false");v.wait_for_timeout(200);self.assertEqual(v.evaluate('()=>cinePositions'),[]);v.evaluate('()=>cineVolume.framesLoaded++');expect(v.get_by_label('Playback Direction',exact=True)).to_be_enabled()
  v.route(pattern,lambda r:r.fulfill(status=403,json={'message':'Synthetic denied'}));self.cine_play(v);expect(v.locator('#kin-cine [role=status]')).to_contain_text('로그인');self.assertFalse(v.evaluate("()=>services.cineService.getState().cines['mpr-axial'].isPlaying"));self.assertEqual(v.evaluate('()=>cinePositions'),[]);v.unroute(pattern);self.assertEqual(len(self.versions(a)),1)
 def test_volume_cine_05_partial_camera_failure_recovers(self):
  a,p,v=self.starting();self.cine_open(v);self.watch_cine(v);before=self.volume_state(v)
  v.evaluate("()=>{window.cineSetCamera=cineView.setCamera;window.cineFailures=0;cineView.setCamera=function(camera,...args){if(camera.focalPoint&&cineFailures++===0){cineSetCamera.call(this,{focalPoint:camera.focalPoint});throw Error('Synthetic partial cine camera failure')}return cineSetCamera.call(this,camera,...args)}}")
  self.cine_play(v);expect(v.locator('#kin-cine [role=status]')).to_contain_text('Synthetic partial cine camera failure');v.wait_for_timeout(200);self.assertFalse(v.evaluate("()=>services.cineService.getState().cines['mpr-axial'].isPlaying"));v.evaluate('()=>cineView.setCamera=cineSetCamera');self.preserved_volume(before,self.volume_state(v));self.assertEqual(len(self.versions(a)),1)
 def test_volume_cine_07_late_permission_after_native_layout_replacement(self):
  a,p,v=self.starting();self.cine_open(v);original=self.originals();p.locator('#findings').fill('KEEP REPLACED CINE REPORT')
  v.evaluate("""()=>{
   const fetch=window.fetch,play=services.cineService.playClip;let first=true,inside=false;
   window.fetch=(...args)=>{const hold=inside&&first&&String(args[0])==='/api/me';return fetch(...args).then(async response=>{if(hold){window.oldCineResponse=true;await new Promise(resolve=>window.releaseOldCine=resolve)}return response})};
   services.cineService.playClip=function(...args){inside=true;let result;try{result=play.apply(this,args)}finally{inside=false}if(first){first=false;window.oldCinePlay=result}return result};
   const g=services.viewportGridService.getState();window.originalCineIds=[...g.viewports.keys()];window.cineSet=g.viewports.get(g.activeViewportId).displaySetInstanceUIDs[0];window.retiredCineView=services.cornerstoneViewportService.getCornerstoneViewport('mpr-axial');
  }""")
  self.cine_play(v);v.wait_for_function('()=>window.oldCineResponse===true')
  for restore in [False,True]:
   v.evaluate("""async restore=>{
    const grid=services.viewportGridService,ids=restore?originalCineIds:originalCineIds.map(()=> 'kin-cine-test-'+crypto.randomUUID());window.remountCineIds=ids;
    await grid.setLayout({numRows:1,numCols:3,activeViewportId:ids[0],isHangingProtocolLayout:false,findOrCreateViewport:index=>({displaySetInstanceUIDs:[cineSet],displaySetOptions:[{}],viewportOptions:{id:'kin-cine-presentation-'+crypto.randomUUID(),viewportId:ids[index],viewportType:'volume',toolGroupId:'mpr',orientation:['axial','sagittal','coronal'][index],allowUnmatchedView:true}})});
   }""",restore)
   v.wait_for_function("()=>remountCineIds.every(id=>services.viewportGridService.getState().viewports.get(id)?.isReady&&services.cornerstoneViewportService.getCornerstoneViewport(id)?.getActors().length===1)")
  self.choose_volume(v,v,0);v.wait_for_function("()=>kinGetVolumeCineTarget(services.cornerstoneViewportService.getCornerstoneViewport('mpr-axial'))?.allowed")
  self.assertTrue(v.evaluate("()=>{const now=services.cornerstoneViewportService.getCornerstoneViewport('mpr-axial');return now!==retiredCineView&&now.element!==retiredCineView.element&&now.id===retiredCineView.id}"))
  self.watch_cine(v);self.cine_play(v);v.wait_for_function('()=>cinePositions.length>=3');count=v.evaluate('()=>cinePositions.length')
  v.evaluate('async()=>{releaseOldCine();await oldCinePlay}');self.wait_for_capture(v,lambda:v.evaluate('()=>cinePositions.length'),'cine positions after the retired play resolved',count+1)
  self.assertTrue(v.evaluate("()=>services.cineService.getState().cines['mpr-axial'].isPlaying"));self.assertGreater(v.evaluate('()=>cinePositions.length'),count);self.cine_play(v)
  expect(p.locator('#findings')).to_have_value('KEEP REPLACED CINE REPORT');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1)
 def test_volume_cine_06_fps_change_waiting_for_permission(self):
  a,p,v=self.starting();self.cine_open(v);self.watch_cine(v);self.cine_play(v);v.wait_for_function('()=>cinePositions.length>=4');pending=[];pattern='**/api/me';v.route(pattern,lambda r:pending.append(r))
  v.locator('[data-cy=viewport-grid] > div').nth(0).locator('[data-cy="cine-player-left-arrow"]').click();self.wait_for_capture(v,lambda:len(pending),'/api/me');self.assertTrue(pending);self.assertTrue(v.evaluate("()=>services.cineService.getState().cines['mpr-axial'].isPlaying"));count=v.evaluate('()=>cinePositions.length');v.wait_for_timeout(150);self.assertEqual(v.evaluate('()=>cinePositions.length'),count)  # negative assertion: fixed window is the delivery margin for frames that must not advance while permission is held
  for request in pending:request.fulfill(response=request.fetch())
  v.unroute(pattern);v.wait_for_function('(count)=>cinePositions.length>=count+4',arg=count);self.assertTrue(v.evaluate("()=>services.cineService.getState().cines['mpr-axial'].isPlaying"));self.assertEqual(v.evaluate("()=>services.cineService.getState().cines['mpr-axial'].frameRate"),23);self.cine_play(v);self.assertEqual(len(self.versions(a)),1)
 def test_volume_cine_08_range_yoyo_pixels_invalid_and_geometry_reset(self):
  a,p,v=self.starting();original=self.originals();p.locator('#findings').fill('KEEP RANGED MPR CINE REPORT');self.cine_open(v);before=self.volume_state(v);self.watch_cine(v)
  v.get_by_label('Range Start').fill('3');v.get_by_label('Range End').fill('6');v.get_by_role('button',name='Apply Range',exact=True).click();v.get_by_label('Playback Direction',exact=True).select_option('yoyo');v.get_by_label('Loop',exact=True).uncheck();self.cine_play(v)
  v.wait_for_function("()=>cinePositions.length>=7&&!services.cineService.getState().cines['mpr-axial'].isPlaying",timeout=5000);positions=v.evaluate('()=>cinePositions');np.testing.assert_allclose([r['point'][2] for r in positions],[30,29,28,27,28,29,30],atol=1e-6,rtol=0)
  v.wait_for_function("()=>[27,28,29,30].every(z=>cinePixels.some(r=>Math.abs(r.point[2]-z)<1e-6))");pixels=v.evaluate('()=>cinePixels.filter(r=>[27,28,29,30].some(z=>Math.abs(r.point[2]-z)<1e-6))');self.assertTrue(pixels);self.assertTrue(all(abs(row['value']-230)<=3 for row in pixels))
  after=self.volume_state(v);self.assertEqual(before[0]['volume'],after[0]['volume']);self.assertEqual(before[0]['properties'],after[0]['properties']);self.preserved_volume(before[1:],after[1:])
  v.get_by_label('Range Start').fill('8');v.get_by_label('Range End').fill('4');v.get_by_role('button',name='Apply Range',exact=True).click();expect(v.locator('#kin-cine [role=status]')).to_contain_text('시작이 끝보다 작아야');v.get_by_role('button',name='Last Plane',exact=True).click();v.wait_for_function("()=>Math.abs(cineView.getCamera().focalPoint[2]-27)<1e-6")
  v.evaluate("()=>{const c=cineView.getCamera();cineView.setCamera({parallelScale:c.parallelScale+1});cineView.render()}");expect(v.get_by_label('Range Start')).to_have_value('1');expect(v.get_by_label('Range End')).to_have_value('33')
  expect(p.locator('#findings')).to_have_value('KEEP RANGED MPR CINE REPORT');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeCineE2E(n) for n in loader.getTestCaseNames(VolumeCineE2E) if n.startswith('test_volume_cine_'))
if __name__=='__main__':unittest.main(verbosity=2)
