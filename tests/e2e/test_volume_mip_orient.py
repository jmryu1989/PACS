# coding: utf-8
"""TEST-MIP-ORIENT-DOM (A11-ORIENT-1): the manual's Orientation Preset bar A/P/L/R/H/F at the bottom of the MIP Viewer
(IF-RND-502U Rev1.2 p.332 §12.1, placed in the MIP Viewer by p.342 §13), its persistence as kin-mip-2 in the new snapshot
versions 14/15, and its output through the existing A11-OUTPUT-1 print engine. Every expected camera is computed here from the
accepted contract table and the synthetic geometry, never read back from the code under test."""
import json,math,unittest
from playwright.sync_api import expect
import numpy as np
from test_volume_mip import VOI_STUDIES,VOI_CASES,HELPERS,SOURCE_PLANES,BLENDS,TOTAL,mm_text,rodrigues,voi_record,voi_planes,voi_label
from test_volume_mip_job import LAYOUT
from test_volume_mip_batch import BATCH_HELPERS,FINAL_CAMERA,batch_cameras,recipe_of
from test_volume_mip_output import VolumeMipOutputE2E,FOCAL,DISTANCE,NOTE,PRINT_TRACE,TAKE,NO_LEAKS,cross

# scripts/run-tests.py accepts only cases whose class is declared in the selected module; load_tests selects exactly these, so the
# inherited MIP Viewer, VOI Slab, MIP Job, MIP Batch and MIP output cases stay out of this bounded profile.
MIP_ORIENT_CASES=('test_mip_orient_01_presets_save_restore_output',
                  'test_mip_orient_02_refusals_current_view_cancel')
# The accepted A11-ORIENT-1 direction table (contract camera_truth.new_direction_table_kin_mip_2), as literals: [normal, up] in
# patient LPS, the normal pointing from the focal point toward the camera. Screen right is viewUp x normal, so H and F both put
# patient right on screen right and F is the Axial projection turned 180 degrees in plane.
DIRECTIONS={'Anterior':([0,-1,0],[0,0,1]),'Posterior':([0,1,0],[0,0,1]),'Left':([1,0,0],[0,0,1]),
            'Right':([-1,0,0],[0,0,1]),'Superior':([0,0,1],[0,-1,0]),'Inferior':([0,0,-1],[0,1,0])}
LETTERS={'Anterior':'A','Posterior':'P','Left':'L','Right':'R','Superior':'H','Inferior':'F'}
SPOKEN={'Anterior':'MIP View From Anterior','Posterior':'MIP View From Posterior','Left':'MIP View From Left',
        'Right':'MIP View From Right','Superior':'MIP View From Head (Superior)','Inferior':'MIP View From Foot (Inferior)'}
# The hand-computed +90 degree rows of the contract table, kept as two separate literal tables so a Horizontal row can never be
# used for a Vertical recipe again (ci-03 N3). HORIZONTAL turns about the Final viewUp, VERTICAL about the screen right u0 x n0.
# Superior (n0=[0,0,1], u0=[0,-1,0], right=[-1,0,0]) turned +90 about its right gives n=[0,1,0], u=[0,0,1] — the Posterior camera,
# which is the contract's stated Superior Vertical+90 identity; this module's recipes are Vertical, so only VERTICAL rows apply here.
HORIZONTAL_TURNED={'Anterior':([1,0,0],[0,0,1]),'Posterior':([-1,0,0],[0,0,1]),'Left':([0,1,0],[0,0,1]),
        'Right':([0,-1,0],[0,0,1]),'Superior':([-1,0,0],[0,-1,0]),'Inferior':([-1,0,0],[0,1,0])}
VERTICAL_TURNED={'Anterior':([0,0,-1],[0,-1,0]),'Posterior':([0,0,-1],[0,1,0]),'Left':([0,0,-1],[1,0,0]),
        'Right':([0,0,-1],[-1,0,0]),'Superior':([0,1,0],[0,0,1]),'Inferior':([0,-1,0],[0,0,-1])}
BAR="()=>[...document.querySelectorAll('#kin-volume-mip .kin-mip-presets button')].map(b=>[b.dataset.kinMipPreset,b.textContent,b.getAttribute('aria-label'),b.title,b.getAttribute('aria-pressed'),b.disabled])"
READOUT="()=>document.querySelector('#kin-volume-mip [aria-label=\"MIP Batch Thickness Readout\"]').textContent"
READOUT_TAG="()=>document.querySelector('#kin-volume-mip [aria-label=\"MIP Batch Thickness Readout\"]').tagName"
TYPE_LABEL="()=>document.querySelector('#kin-volume-mip [aria-label=\"MIP Batch Type\"]')?.tagName??''"
ORIENT_OPTIONS="()=>[...document.querySelector('#kin-volume-mip [aria-label=\"MIP Orientation\"]').options].map(o=>o.value)"

def orient_cameras(orientation,recipe=None):
 """The accepted cameras of one saved display: focal point the voxel-centre box centre, D = t = the whole-volume projection
 thickness, parallel scale D/2; a batch turns frame i by sign x i x interval about viewUp (Horizontal) or viewUp x normal
 (Vertical). Computed from the literal table above, exactly as the contract states it."""
 n0,u0=DIRECTIONS[orientation]
 def camera(angle,n,u):
  return {'angle':angle,'focalPoint':list(FOCAL),'position':[f+x*DISTANCE for f,x in zip(FOCAL,n)],
          'viewPlaneNormal':list(n),'viewUp':list(u),'parallelScale':DISTANCE/2}
 if recipe is None:return [camera(0,n0,u0)]
 right=cross(u0,n0);length=math.hypot(*right);right=[x/length for x in right]
 axis=u0 if recipe['axis']=='Horizontal' else right;sign=-1 if recipe['reverse'] else 1;cameras=[]
 for i in range(recipe['count']):
  angle=sign*i*recipe['interval'];radians=math.radians(angle)
  cameras.append(camera(angle,rodrigues(n0,axis,radians) if i else list(n0),
                        rodrigues(u0,axis,radians) if i and recipe['axis']=='Vertical' else list(u0)))
 return cameras

class VolumeMipOrientE2E(VolumeMipOutputE2E):
 def press(self,dialog,orientation):dialog.get_by_role('button',name=SPOKEN[orientation],exact=True).click()
 def near(self,actual,expected,label,tolerance=1e-6):
  self.assertEqual(len(actual),len(expected),label)
  for got,want in zip(actual,expected):self.assertLessEqual(abs(got-want),tolerance,(label,got,want))
 def rolled_back(self,page,mark,label):
  """A direction that did not take effect rolls back to the previous Final. The diagnostics are folded into the label as a STRING:
  assert_camera composes its messages from it, so a tuple here would raise before any camera comparison (ci-02 NA1)."""
  status=page.locator('#kin-volume-mip [role=status]').text_content()
  return f'{label} · status={status!r} · transitions={page.evaluate("m=>mipTransitions.slice(m)",mark)!r}'
 def assert_camera(self,camera,expected,label,fitted=None):
  """HP1: the Final camera the pinned runtime actually holds equals the accepted table's camera. Every message is composed with
  f-strings so a non-string label can never raise instead of comparing; the numeric checks stay at 1e-6."""
  self.near(camera['viewPlaneNormal'],expected['viewPlaneNormal'],f'{label} normal')
  self.near(camera['viewUp'],expected['viewUp'],f'{label} up')
  self.near(camera['focalPoint'],expected['focalPoint'],f'{label} focal point')
  distance=math.hypot(*[p-f for p,f in zip(camera['position'],camera['focalPoint'])])
  self.assertGreaterEqual(distance,DISTANCE/2+1e-6,f'{label} camera stands outside the whole-volume slab')
  # Zoom parity with the plane reset this display was written from: the explicit direction write must not change the scale.
  if fitted:
   self.assertAlmostEqual(distance,fitted[0],delta=1e-6,msg=f'{label} distance parity with the Axial fit')
   self.assertAlmostEqual(camera['parallelScale'],fitted[1],delta=1e-6,msg=f'{label} parallel scale parity with the Axial fit')
 def orient_voi_native(self,state,mode,orientation,record,voi):
  """voi_native for an anatomical preset: the camera is the literal DIRECTIONS row, every other assertion unchanged."""
  normal,up=DIRECTIONS[orientation]
  self.assertEqual(state['state'],'final',state['status']);self.assertEqual([state['mode'],state['orientation'],state['blend']],[mode,orientation,BLENDS[mode]])
  np.testing.assert_allclose(state['normal'],normal,atol=1e-6,rtol=0);np.testing.assert_allclose(state['up'],up,atol=1e-6,rtol=0)
  self.assertEqual(len(state['planes']),4 if record else 2,state['planes'])
  for _,plane_normal in state['planes'][:2]:self.assertAlmostEqual(abs(float(np.dot(plane_normal,normal))),1,delta=1e-6)
  self.assertAlmostEqual(math.dist(state['planes'][0][0],state['planes'][1][0]),TOTAL,delta=1e-6)
  for (origin,plane_normal),(want_origin,want_normal) in zip(state['planes'][2:],voi_planes(record) if record else []):
   np.testing.assert_allclose(origin,want_origin,atol=1e-6,rtol=0);np.testing.assert_allclose(plane_normal,want_normal,atol=1e-6,rtol=0)
  self.assertAlmostEqual(state['voiRange']['lower'],voi[0],delta=1e-6);self.assertAlmostEqual(state['voiRange']['upper'],voi[1],delta=1e-6)
  suffix=' · '+voi_label(record) if record else ''
  self.assertEqual(state['label'],mode+' · '+orientation+' · '+mm_text(TOTAL)+' mm'+suffix+' · Final')

 def test_mip_orient_01_presets_save_restore_output(self):
  study,intercept,voi=VOI_STUDIES[0];_,_,oblique=VOI_CASES;record=voi_record(oblique)
  a,p,v=self.opened_voi_study(intercept,voi);p.locator('#findings').fill('KEEP MIP ORIENT REPORT')
  v.evaluate(BATCH_HELPERS);source=v.evaluate(SOURCE_PLANES);layout=v.evaluate(LAYOUT)
  dialog=self.open_voi(v)
  # The bar is the manual's six letters in order, and every title names the camera side, the up direction and screen right.
  bar=v.evaluate(BAR)
  self.assertEqual([row[0] for row in bar],list(DIRECTIONS))
  self.assertEqual([row[1] for row in bar],[LETTERS[name] for name in DIRECTIONS])
  self.assertEqual([row[2] for row in bar],[SPOKEN[name] for name in DIRECTIONS])
  self.assertEqual(bar[4][3],'H · 머리 위에서 · 앞쪽이 위 · 환자 오른쪽이 화면 오른쪽')
  self.assertEqual(bar[5][3],'F · 발쪽에서 · 뒤쪽이 위 · 환자 오른쪽이 화면 오른쪽')
  self.assertEqual(v.evaluate(ORIENT_OPTIONS),['Axial','Coronal','Sagittal']+list(DIRECTIONS))
  # The p.328 field names: Type is the rotation kind; Thickness is a read-only output that is never an input.
  self.assertEqual(v.evaluate(TYPE_LABEL),'SELECT');self.assertEqual(v.evaluate(READOUT_TAG),'OUTPUT')
  self.assertEqual(v.evaluate(READOUT),'CT 전체 '+mm_text(DISTANCE)+' mm')
  # The opening Axial display is the runtime's own fitted camera; every direction is written from that fit, so its distance and
  # parallel scale must survive unchanged (a carried-stale or re-fitted camera would show here).
  axial=v.evaluate(FINAL_CAMERA)
  fitted=(math.hypot(*[p-f for p,f in zip(axial['position'],axial['focalPoint'])]),axial['parallelScale'])
  # HP1: each preset writes its own Final camera, and only that preset is pressed.
  for name,(normal,up) in DIRECTIONS.items():
   mark=self.mark(v);self.press(dialog,name);self.settled(v,mark)
   expect(dialog).to_have_attribute('data-kin-mip-state','final')
   self.assert_camera(v.evaluate(FINAL_CAMERA),orient_cameras(name)[0],self.rolled_back(v,mark,name),fitted)
   self.assertEqual(v.evaluate("()=>document.querySelector('#kin-volume-mip [aria-label=\"MIP Orientation\"]').value"),name)
   self.assertEqual([row[4] for row in v.evaluate(BAR)],['true' if other==name else 'false' for other in DIRECTIONS],name)
   expect(dialog.locator('.kin-mip-label')).to_contain_text(' · '+name+' · ')
  # A plane chosen from the list clears every pressed preset and returns the accepted kin-mip-1 camera.
  mark=self.mark(v);self.choose_mip(dialog,'MIP','Coronal');self.settled(v,mark)
  self.assertEqual([row[4] for row in v.evaluate(BAR)],['false']*6)
  V14,V15,V12='MIP orient v14 Posterior','MIP orient v15 Superior','MIP orient v12 Coronal'
  # A version 12 row from the same session proves the accepted pair is untouched by the new one.
  self.save_titled(dialog,V12,'VOI Slab · Off · Saved')
  mark=self.mark(v);self.press(dialog,'Posterior');self.settled(v,mark)
  self.orient_voi_native(self.settled(v,self.apply_voi_case(v,dialog,oblique)),'MIP','Posterior',record,voi)
  thickness=mm_text(record['thickness']);label='VOI Slab · On · '+thickness+' mm · '
  self.assertEqual(v.evaluate(READOUT),'CT 전체 '+mm_text(DISTANCE)+' mm · VOI Slab '+thickness+' mm (환자 좌표 고정)')
  mark=self.mark(v);self.choose_mip(dialog,'Raysum');self.job_final(v,mark,'Raysum','Posterior')
  self.save_titled(dialog,V14,label+'Saved')
  mark=self.mark(v);self.voi_button(dialog,'Reset VOI').click();self.settled(v,mark)
  mark=self.mark(v);self.press(dialog,'Superior');self.job_final(v,mark,'Raysum','Superior')
  vertical=recipe_of('Vertical',90,3);self.batch_inputs(dialog,'Vertical',90,3);self.make(v,dialog,3)
  self.save_titled(dialog,V15,'VOI Slab · Off · Saved')
  self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible()
  titles=(V12,V14,V15);saved={title:self.mip_job(a,title) for title in titles}
  self.assertEqual([saved[title][0]['snapshotVersion'] for title in titles],[12,14,15])
  self.assertEqual([saved[title][1]['snapshot']['mip']['algorithm'] for title in titles],['kin-mip-1','kin-mip-2','kin-mip-2'])
  self.assertEqual([saved[title][1]['snapshot']['mip']['orientation'] for title in titles],['Coronal','Posterior','Superior'])
  self.assertEqual(saved[V15][1]['snapshot']['mipBatch'],vertical)
  self.assertNotIn('thickness',saved[V14][1]['snapshot']['mip'],'the kin-mip-2 block carries no projection thickness (U4-T open)')
  jobs_panel=v.locator('#kin-viewer-jobs')
  expect(jobs_panel.get_by_role('button',name='Print Saved Images',exact=True)).to_have_count(3)
  # A fresh login restores the saved preset itself, not the plane it was opened on. fresh_page only logs in, launches and waits
  # for the Print buttons, so this page carries none of the MIP page helpers yet: HELPERS installs mipView (and canvasPixel), which
  # FINAL_CAMERA reads, exactly as the accepted fresh-login restore does (test_volume_mip_job.py: ready(fresh) then HELPERS).
  fresh=self.fresh_page(a,3);fresh.evaluate(HELPERS)
  self.restore_titled(fresh,a,V14)
  expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('MIP 작업을 복원했습니다',timeout=90000)
  restored=fresh.locator('#kin-volume-mip');expect(restored).to_have_attribute('data-kin-mip-state','final',timeout=90000)
  fresh.evaluate(BATCH_HELPERS)
  self.assertEqual(fresh.evaluate("()=>document.querySelector('#kin-volume-mip [aria-label=\"MIP Orientation\"]').value"),'Posterior')
  self.assert_camera(fresh.evaluate(FINAL_CAMERA),orient_cameras('Posterior')[0],'restored Posterior')
  self.assertEqual([row[4] for row in fresh.evaluate(BAR)],['false','true','false','false','false','false'])
  restored.get_by_role('button',name='Close MIP Viewer',exact=True).click();expect(restored).not_to_be_visible()
  # T2: the version 15 row restores to completion in the same fresh login — the saved preset, its pressed state and the frames
  # regenerated from the saved recipe under the explicit batch budget (the completing oracle MO6 needs).
  fresh.evaluate('()=>{batchStatuses.length=0;batchFrames.length=0}')
  self.restore_titled(fresh,a,V15)
  expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('MIP Batch 작업을 복원했습니다',timeout=90000)
  restored=fresh.locator('#kin-volume-mip');expect(restored).to_have_attribute('data-kin-mip-state','final',timeout=90000)
  self.assertEqual(fresh.evaluate("()=>document.querySelector('#kin-volume-mip [aria-label=\"MIP Orientation\"]').value"),'Superior')
  self.assertEqual([row[4] for row in fresh.evaluate(BAR)],['false','false','false','false','true','false'])
  restored_final=fresh.evaluate(FINAL_CAMERA)
  self.assert_camera(restored_final,orient_cameras('Superior')[0],'restored Superior')
  self.batch_announced(fresh,3,'VOI Slab · Off · Saved')
  # The regenerated frames take their camera distance from the CONFIRMED FINAL camera (viewer-volume-mip.js generateBatch), which
  # for a direction display is the distance of the runtime's own Axial fit — not the print engine's analytic whole-volume distance
  # that orient_cameras builds. The expectation is therefore derived from the Final readback, exactly as the accepted batch fixture
  # does (test_volume_mip_batch.batch_cameras(final,recipe) -> (cameras, distance)). Only D comes from the runtime: the Final axes
  # were just compared against the literal table, and the turned rows are cross-checked against the literal identity below.
  restored_cameras,restored_distance=batch_cameras(restored_final,vertical)
  self.assertGreaterEqual(restored_distance,TOTAL/2+1e-6,'the restored Final camera stands outside the whole-volume slab')
  self.near(restored_cameras[1]['viewPlaneNormal'],VERTICAL_TURNED['Superior'][0],'restored v15 frame 1 normal')
  self.near(restored_cameras[1]['viewUp'],VERTICAL_TURNED['Superior'][1],'restored v15 frame 1 up')
  self.near(restored_cameras[1]['viewPlaneNormal'],DIRECTIONS['Posterior'][0],'restored v15 frame 1 is the Posterior camera')
  self.batch_native(fresh.evaluate('()=>batchFrames.splice(0)'),restored_cameras,None,voi,'Raysum','v15 Superior restored')
  restored.get_by_role('button',name='Close MIP Viewer',exact=True).click();expect(restored).not_to_be_visible()
  # The saved preset prints through the same engine: every frame is its accepted camera, and frame 0 of the batch is the single frame.
  fresh.evaluate(PRINT_TRACE);fresh.evaluate(TAKE)
  paper=self.open_output(fresh,a,V14);single=fresh.evaluate(TAKE)
  self.print_native(single['frames'],orient_cameras('Posterior'),record,voi,'Raysum','v14 Posterior')
  expect(paper.locator('.mip-caption')).to_have_text('MIP Viewer · Raysum · Posterior · VOI Slab '+thickness+' mm · 512 × 512')
  expect(paper.locator('main')).to_contain_text(NOTE)
  self.close_output(fresh)
  paper=self.open_output(fresh,a,V15);series=fresh.evaluate(TAKE)
  cameras=orient_cameras('Superior',vertical)
  self.print_native(series['frames'],cameras,None,voi,'Raysum','v15 Superior')
  expect(paper.locator('.mip-caption')).to_have_text(
   ['Frame %d / 3 · Raysum · Superior · Vertical %s · VOI Slab Off · 512 × 512'%(i+1,angle) for i,angle in enumerate(('0°','+90°','+180°'))])
  # V15 was saved with a VERTICAL recipe, so frame 1 is Superior turned +90 about its screen right = the Posterior camera
  # (n=[0,1,0], u=[0,0,1]); the Horizontal row ([-1,0,0],[0,-1,0]) belongs to a Horizontal recipe and is not this frame (ci-03 N3).
  # print_native above already pinned this frame against the same Vertical row; this keeps the explicit literal statement of it.
  self.near(series['frames'][1]['camera']['viewPlaneNormal'],VERTICAL_TURNED['Superior'][0],'v15 frame 1 normal')
  self.near(series['frames'][1]['camera']['viewUp'],VERTICAL_TURNED['Superior'][1],'v15 frame 1 up')
  self.near(series['frames'][1]['camera']['viewPlaneNormal'],DIRECTIONS['Posterior'][0],'v15 frame 1 is the Posterior camera')
  self.close_output(fresh);fresh.wait_for_function(NO_LEAKS,timeout=10000)
  # Nothing of the original screen, the report or the accepted rows changed.
  self.assertEqual(v.evaluate(SOURCE_PLANES),source);self.assertEqual(v.evaluate(LAYOUT),layout)
  self.assertEqual(len(self.versions(a)),1)
  print('MIP_ORIENT_01',json.dumps({'versions':[saved[t][0]['snapshotVersion'] for t in titles]}),flush=True)

 def test_mip_orient_02_refusals_current_view_cancel(self):
  study,intercept,voi=VOI_STUDIES[0]
  a,p,v=self.opened_voi_study(intercept,voi);v.evaluate(BATCH_HELPERS)
  dialog=self.open_voi(v);mark=self.mark(v);self.press(dialog,'Left');self.job_final(v,mark,'MIP','Left')
  V14='MIP orient refusal v14';self.save_titled(dialog,V14,'VOI Slab · Off · Saved')
  self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible()
  row,detail=self.mip_job(a,V14);self.assertEqual(row['snapshotVersion'],14)
  layout=v.evaluate(LAYOUT)
  # Each version names exactly one algorithm and one key set: an intercepted body that breaks the binding is refused before any
  # screen change and before any page, whether it is restored or printed.
  def patched(change):
   body=json.loads(json.dumps(detail));change(body['snapshot']);return body
  # An unknown version is refused by the pre-existing gates, whose messages are the stack resolver's and the print dialog's own;
  # they are asserted as guards (no MIP dialog, layout unchanged, no page) rather than pinned to an incidental string.
  cases=[('kin-mip-1 inside version 14',lambda s:s['mip'].update(algorithm='kin-mip-1',orientation='Axial'),'재현할 수 없어','출력하지 않았습니다'),
         ('an unknown algorithm',lambda s:s['mip'].update(algorithm='kin-mip-3'),'재현할 수 없어','출력하지 않았습니다'),
         ('a plane name inside kin-mip-2',lambda s:s['mip'].update(orientation='Axial'),'형식을 확인할 수 없어','출력하지 않았습니다'),
         ('version 16',lambda s:s.update(version=16),None,'이전 작업에는 화면 크기가 없습니다'),
         ('version 14 carrying a recipe',lambda s:s.update(mipBatch=recipe_of('Horizontal',90,2)),'형식을 확인할 수 없어','출력하지 않았습니다')]
  # The five cases print as well as restore, and the loop ends on a no-leak wait whose predicate calls printLeaks(), which only
  # PRINT_TRACE defines (ci-03 N1: this page never installed it). Installing it here also puts the print guards and TAKE on this
  # page for the five refused prints. The accepted output cases install it on a page that already has BATCH_HELPERS in exactly
  # this order (test_volume_mip_output.py L332/L344 and L436/L444), and it is idempotent (window.printReady).
  v.evaluate(PRINT_TRACE)
  pattern=f"**/api/studies/{a.uid}/viewer-jobs/{row['id']}"
  for label,change,expected,print_expected in cases:
   # subTest carries the case name for every assertion in the iteration; LocatorAssertions take the expected value as their only
   # positional argument (to_have_count(0,label) raised TypeError in ci-03), so context never goes into the assertion call.
   with self.subTest(case=label):
    body=patched(change)
    # Playwright calls a route handler with TWO positional arguments, (route, route.request), so a bound default must come third:
    # binding it second made json.dumps receive the Request and the TypeError resurfaced at unroute (ci-02 NA2). This is the shape
    # the accepted output fixture already uses (test_volume_mip_output.py forged(route,request,change=change)).
    def forged(route,request,body=body):route.fulfill(status=200,content_type='application/json',body=json.dumps(body))
    v.route(pattern,forged)
    try:
     self.restore_titled(v,a,V14)
     status=v.locator('#kin-viewer-jobs-status')
     if expected:expect(status).to_contain_text(expected,timeout=90000)
     else:
      expect(status).not_to_contain_text('복원했습니다',timeout=90000)
      self.assertNotIn('복원했습니다',status.text_content(),label)
     expect(v.locator('#kin-volume-mip[open]')).to_have_count(0,timeout=10000)
     self.assertEqual(v.evaluate(LAYOUT),layout,label)
     self.print_titled(v,a,V14)
     expect(v.locator('#kin-job-print [role=status]')).to_contain_text(print_expected,timeout=120000)
     self.assertEqual(v.evaluate("()=>document.querySelector('#kin-job-print iframe')?.srcdoc??''"),'',label)
     self.close_output(v)
    finally:
     v.unroute(pattern,forged)
  v.wait_for_function(NO_LEAKS,timeout=10000)
  # The current MIP screen still has no output page of its own, under the new versions too.
  dialog=self.open_voi(v);mark=self.mark(v);self.press(dialog,'Inferior');self.job_final(v,mark,'MIP','Inferior')
  v.locator('#kin-viewer-jobs').get_by_role('button',name='Print Current View',exact=True).click()
  expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('MIP Viewer 작업은 아직 출력할 수 없습니다',timeout=60000)
  self.assertEqual(v.locator('#kin-job-print[open]').count(),0)
  # The restore of a version 15 Job is cancelled by Close MIP Viewer while its frames are being made, and rolls back.
  vertical=recipe_of('Vertical',45,3);self.batch_inputs(dialog,'Vertical',45,3);self.make(v,dialog,3)
  V15='MIP orient cancel v15';self.save_titled(dialog,V15,'VOI Slab · Off · Saved')
  self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible()
  self.assertEqual(self.mip_job(a,V15)[0]['snapshotVersion'],15)
  before=v.evaluate(LAYOUT)
  # B5: hold the second regenerated frame so the cancel is deterministic, exactly as the accepted batch cancel case does; without
  # a hold a three-frame batch can finish before the click and nothing is cancelled.
  v.evaluate('()=>{batchStatuses.length=0;batchHoldFrame=2;batchHeld=0}')
  try:
   self.restore_titled(v,a,V15)
   restoring=v.locator('#kin-volume-mip');expect(restoring).to_be_visible(timeout=90000)
   v.wait_for_function('()=>batchHeld>0',timeout=90000)
   expect(restoring.locator('[role=status]')).to_contain_text('MIP Batch 복원 중',timeout=90000)
   restoring.get_by_role('button',name='Close MIP Viewer',exact=True).click()
   expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('이전 화면',timeout=90000)
  finally:
   v.evaluate('()=>{batchHoldFrame=null}')
  expect(v.locator('#kin-volume-mip[open]')).to_have_count(0);self.assertEqual(v.evaluate(LAYOUT),before)
  self.assertEqual(len(self.versions(a)),1)
  print('MIP_ORIENT_02',json.dumps({'refusals':len(cases)}),flush=True)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeMipOrientE2E(n) for n in MIP_ORIENT_CASES)
if __name__=='__main__':unittest.main(verbosity=2)
