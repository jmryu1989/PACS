# coding: utf-8
"""D-MEASURE2 A1/A2/C5: real comparison viewer, drafts and BFF receipts."""
import sys, unittest, uuid
from urllib.parse import urlsplit
from test_held_measurements import HeldMeasurementE2E, expect, base, literal
from test_viewer_history import synthetic_ct, canvas_ready
from viewer_precision_support import hook

# S3-U5 CI1 (test_recovery_07..10): the fixed OHIF loader never asks again after a rejected series-metadata GET, which
# left the current study blank in CI1. Only the current study's one series-metadata GET is routed; the rest is real.
NOTICES = hook + '''window.__kinNotices=[];window.config.extensions.push({id:'kin.local-recovery-notices',preRegistration({servicesManager}){
  const s=servicesManager.services.uiNotificationService,show=s.show;
  s.show=function(n){__kinNotices.push({title:String(n&&n.title),type:String(n&&n.type),message:String(n&&n.message)});return show.apply(this,arguments)};}});'''
SHOWN = "()=>{const s=__d05c1.services;return [...s.viewportGridService.getState().viewports.keys()].map(id=>s.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageId?.()||'')}"
SETS = "uid=>__d05c1.services.displaySetService.getActiveDisplaySets().filter(d=>d.StudyInstanceUID===uid).map(d=>d.SeriesInstanceUID)"
STATE = "()=>window.kinSeriesMetadataRecoveryState()"
IMAGE_NOTICES = "()=>__kinNotices.filter(n=>n.title==='Image Loading')"
RECOVERY = "window.config.extensions.find(e=>e.id==='kin.series-metadata-recovery')"
# The extension's own registered exit (what ExtensionManager.onModeExit calls) runs in the same turn that first sees
# the one pending retry, so it always lands inside the 1000 ms wait.
EXIT_WHILE_WAITING = "()=>{const s=window.kinSeriesMetadataRecoveryState?.();if(!s||s.pending!==1)return false;"+RECOVERY+".onModeExit();return true}"


def transient(route, n):
    if n == 1: route.fulfill(status=500, content_type='text/plain', body='synthetic transient failure')
    else: route.continue_()


class ViewerRecoveryE2E(HeldMeasurementE2E):
    def switch(self, p, f):
        p.wait_for_function('uid=>__d05c1.services.displaySetService.getActiveDisplaySets().some(d=>d.StudyInstanceUID===uid)', arg=f.uid)
        p.evaluate('''uid=>{const s=__d05c1.services;
          const d=s.displaySetService.getActiveDisplaySets().find(d=>d.StudyInstanceUID===uid);
          s.viewportGridService.setDisplaySetsForViewport({viewportId:s.viewportGridService.getActiveViewportId(),displaySetInstanceUIDs:[d.displaySetInstanceUID]});}''', f.uid)
        expect(p.locator('#kin-viewer-history')).to_have_attribute('data-study-uid', f.uid)

    def test_recovery_01_comparison_holds_drafts_and_held_edits(self):
        a,b=self.specimen(),self.specimen(); w,p=self.open_viewer(a,extra=b,observer=True)
        self.addCleanup(w.close);self.addCleanup(p.close)
        self.switch(p,a)
        original=self.hashes()
        row,_=self.held(p,a,label='A 보관 수정')
        stored=self.durable(a)
        self.switch(p,b); self.guard(p,True)
        expect(p.locator('#kin-viewer-history')).not_to_contain_text('A 보관 수정')
        draft=self.draw_length(p);draft.get_by_label('Annotation Text').fill('B 새 측정')
        points=p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='Length').data.handles.points")
        self.switch(p,a)
        p.once('dialog',lambda d:d.dismiss());p.get_by_role('button',name='Discard Held Work',exact=True).click()
        p.get_by_role('button',name='Resume Held Work',exact=True).click()
        expect(p.locator('#kin-viewer-history')).to_contain_text('A 보관 수정')
        self.switch(p,b);p.get_by_role('button',name='Resume Held Work',exact=True).click()
        row=p.locator('#kin-viewer-history section[data-kind=length]')
        expect(row.get_by_label('Annotation Text')).to_have_value('B 새 측정')
        p.wait_for_function('''points=>{const a=cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='Length');
          return a&&!a.invalidated&&JSON.stringify(a.data.handles.points)===JSON.stringify(points)}''',arg=points)
        row.get_by_role('button',name='Save',exact=True).click();expect(row).to_contain_text('저장 완료')
        self.assertEqual(self.saved(b)[0]['item']['points'],points)
        self.assertEqual(self.durable(a),stored);self.assertEqual(self.hashes(),original)

    def test_recovery_02_busy_hide_conflict_has_no_fake_held_edit(self):
        f=self.specimen();w,p=self.open_viewer(f);self.addCleanup(w.close);self.addCleanup(p.close)
        row=self.draw_length(p);row.get_by_role('button',name='Save',exact=True).click();expect(row).to_contain_text('저장 완료')
        old=self.saved(f)[0]
        item={k:v for k,v in old['item'].items() if k not in ['hidden','sourceDigest']};item['label']='최신 서버 문구'
        for revision,action in [(1,'edit'),(2,'hide')]:
            response=self.stack.request('POST',f'/studies/{f.uid}/viewer-items/{old["id"]}/revisions','doctor',dict(
                requestId=str(uuid.uuid4()),expectedRevision=revision,action=action,**({'reason':'경합 시험'} if action=='hide' else {}),item=item))
            self.assertEqual(response.status,200,response.text)
        p.once('dialog',lambda d:d.accept('같은 항목 숨김'));row.get_by_role('button',name='Hide',exact=True).click()
        expect(row).to_contain_text('서버에 다른 판');row.get_by_role('button',name='Use Latest & Keep Changes').click()
        expect(row).not_to_contain_text('Held Changes');self.guard(p,False)
        p.once('dialog',lambda d:d.accept('최신 내용 복원'));row.get_by_role('button',name='Restore',exact=True).click()
        expect(row).to_contain_text('저장 완료');expect(row).to_contain_text('최신 서버 문구')
        self.assertEqual(self.saved(f)[0]['item']['label'],'최신 서버 문구');self.guard(p,False)

    def test_recovery_03_committed_denied_receipt_preserves_other_study_and_uuid(self):
        a,b=self.specimen(),self.specimen();w,p=self.open_viewer(a,extra=b,observer=True)
        self.addCleanup(w.close);self.addCleanup(p.close)
        self.switch(p,a)
        self.held(p,a,label='A 접근 거부와 별개인 보관 수정');stored_a=self.durable(a)
        self.switch(p,b);row=self.draw_length(p);row.get_by_label('Annotation Text').fill('B 결과 미확인')
        seen=[]
        # The actual service race (commit -> source check -> 403) is also tested
        # by viewer_readback_fault.cjs. Here inject that receipt at the browser
        # port after a real commit, then require real permission checks on retry.
        def committed_denial(route):
            seen.append(route.request.post_data);response=route.fetch();self.assertEqual(response.status,200)
            route.fulfill(status=403,content_type='application/json',body='{}')
        p.route('**/studies/'+b.uid+'/viewer-items',committed_denial)
        row.get_by_role('button',name='Save',exact=True).click()
        expect(p.locator('#kin-viewer-history')).to_contain_text('이 검사에 접근할 수 없습니다')
        expect(p.locator('#kin-viewer-history')).not_to_contain_text('B 결과 미확인');self.guard(p,True)
        stored_b=self.durable(b)
        self.switch(p,a);p.get_by_role('button',name='Resume Held Work',exact=True).click()
        expect(p.locator('#kin-viewer-history')).to_contain_text('A 접근 거부와 별개인 보관 수정')
        p.unroute('**/studies/'+b.uid+'/viewer-items',committed_denial)
        self.switch(p,b);p.get_by_role('button',name='Resume Held Work',exact=True).click()
        row=p.locator('#kin-viewer-history section').filter(has=p.get_by_role('button',name='Retry Request',exact=True))
        with p.expect_response(lambda r:r.request.method=='POST' and r.url.endswith('/viewer-items')) as response:
            row.get_by_role('button',name='Retry Request',exact=True).click()
        self.assertEqual(response.value.status,200);self.assertEqual(response.value.request.post_data,seen[0])
        expect(p.locator('#kin-viewer-history section[data-kind=length]')).to_have_count(1)
        expect(p.locator('#kin-viewer-history')).to_contain_text('저장 완료')
        self.assertEqual(self.durable(a),stored_a);self.assertEqual(self.durable(b),stored_b)

    def test_recovery_04_native_delete_does_not_resurrect_unsaved_measurement(self):
        f=self.specimen();w,p=self.open_viewer(f);self.addCleanup(w.close);self.addCleanup(p.close)
        self.draw_length(p);self.guard(p,True)
        p.evaluate('''()=>{const a=cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='Length');
          cornerstoneTools.annotation.state.removeAnnotation(a.annotationUID);cornerstone.getEnabledElements()[0].viewport.render();}''')
        expect(p.locator('#kin-viewer-history section[data-kind=length]')).to_have_count(0)
        p.wait_for_function('()=>!window.kinViewerHistoryHasUnsaved()');self.guard(p,False)
        self.assertEqual(self.saved(f),[])

    def test_recovery_05_resume_uses_current_source_verdict_without_discarding_draft(self):
        a,b=self.specimen(),self.specimen();w,p=self.open_viewer(a,extra=b,observer=True)
        self.addCleanup(w.close);self.addCleanup(p.close)
        self.switch(p,a)
        row=self.draw_length(p);row.get_by_role('button',name='Save',exact=True).click();expect(row).to_contain_text('저장 완료')
        row.get_by_role('button',name='Edit',exact=True).click();row.get_by_label('Annotation Text').fill('원본 미확인 중에도 보존')
        stored=self.durable(a);self.switch(p,b)
        def unverified(route):
            response=route.fetch();body=response.json()
            for head in body['items']:head['referenceStatus']='unverified'
            route.fulfill(response=response,json=body)
        p.route('**/studies/'+a.uid+'/viewer-items?*',unverified)
        self.switch(p,a);p.get_by_role('button',name='Resume Held Work',exact=True).click()
        row=p.locator('#kin-viewer-history section[data-kind=length]')
        expect(row).to_contain_text('원본을 확인하지 못했습니다')
        expect(row.get_by_label('Annotation Text')).to_have_value('원본 미확인 중에도 보존')
        self.assertEqual(p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='Length').length"),0)
        self.guard(p,True);self.assertEqual(self.durable(a),stored)

    def test_recovery_06_new_native_annotation_warns_before_history_scan(self):
        f=self.specimen();w,p=self.open_viewer(f);self.addCleanup(w.close);self.addCleanup(p.close)
        p.evaluate('''()=>{
          window.recoveryAtCreate=[];cornerstone.eventTarget.addEventListener(cornerstoneTools.Enums.Events.ANNOTATION_ADDED,({detail:{annotation}})=>{
            if(annotation.metadata.toolName==='Length'){
              const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);
              recoveryAtCreate.push({prevented:event.defaultPrevented,dirty:kinViewerHistoryHasUnsaved(),rows:document.querySelectorAll('#kin-viewer-history section[data-kind=length]').length});
            }
          });}''')
        row=self.draw_length(p);expect(row).to_have_count(1)
        samples=p.evaluate('()=>recoveryAtCreate');self.assertTrue(samples)
        self.assertEqual(samples[0],{'prevented':True,'dirty':True,'rows':0})
        self.assertEqual(self.saved(f),[])

    # ---- S3-U5 CI1: one bounded retry of the current study's series-metadata GET ----
    def metadata_studies(self):
        f=self.specimen();prior=synthetic_ct(self.stack,f.patient_id,'recprior','20260801',[0,0,0],[1,0,0,0,1,0],[.7,1.3],slices=1)
        found=self.stack._orthanc_request('POST','/tools/lookup',f.uid.encode())
        study=next(x['ID'] for x in found.body if x['Type']=='Study')
        [instance]=self.stack._orthanc_request('GET','/studies/'+study+'/instances').body
        series=self.stack._orthanc_request('GET','/series/'+instance['ParentSeries']).body['MainDicomTags']['SeriesInstanceUID']
        return f,prior,series,instance['MainDicomTags']['SOPInstanceUID']

    def metadata_viewer(self,f,prior,series,reply):
        # The worklist's own comparison URL (reading-workspace.js:515), current study first.
        w=self.login();p=w.context.new_page();p.set_viewport_size(dict(width=1680,height=1000));seen=[]
        self.addCleanup(w.close);self.addCleanup(p.close)
        def config(r):
            a=r.fetch();r.fulfill(response=a,body=a.text()+'\n'+NOTICES)
        path='/studies/'+f.uid+'/series/'+series+'/metadata'
        def metadata(route):
            seen.append(route.request.method);reply(route,len(seen))
        p.route('**/ohif/app-config.js',config);p.route(lambda url:urlsplit(url).path.endswith(path),metadata)
        p.goto(self.stack.proxy+'/ohif/viewer?StudyInstanceUIDs='+f.uid+','+prior.uid+'&hangingProtocolId=@ohif/hpCompare')
        return w,p,seen

    def metadata_failure(self,p,status,f,prior,series,sop):
        node=p.locator('#kin-viewer-layout #kin-series-metadata-status')
        expect(node).to_contain_text('1번째 검사의 영상 정보',timeout=60000);expect(node).to_contain_text('HTTP '+str(status))
        # The dock shows one panel at a time; select Layout the way open_measurement_tools selects History.
        expect(p.locator('#kin-workspace-dock')).to_have_count(1,timeout=45000)
        tab=p.locator('#kin-workspace-dock nav button[aria-controls=kin-viewer-layout]')
        if tab.get_attribute('aria-expanded')!='true':tab.click()
        expect(node).to_be_visible();text=node.text_content()
        for value in (f.uid,prior.uid,series,sop,f.patient_id):self.assertNotIn(value,text)
        self.assertEqual([(n['type'],n['message']) for n in p.evaluate(IMAGE_NOTICES)],[('error',text)])
        return text

    def assert_no_current_image(self,p,f,prior):
        self.assertEqual(p.evaluate(SETS,f.uid),[])
        shown=[i for i in p.evaluate(SHOWN) if i]
        self.assertEqual([i for i in shown if '/studies/'+f.uid+'/' in i],[],shown)
        self.assertTrue(all('/studies/'+prior.uid+'/' in i for i in shown),shown)

    def test_recovery_07_transient_series_metadata_500_recovers_the_current_study_once(self):
        f,prior,series,sop=self.metadata_studies()
        w,p,seen=self.metadata_viewer(f,prior,series,transient)
        canvas_ready(p,2)
        self.assertEqual(seen,['GET','GET'])
        current=[i for i in p.evaluate(SHOWN) if '/studies/'+f.uid+'/' in i]
        self.assertEqual(len(current),1,current);self.assertIn('/studies/'+f.uid+'/series/'+series+'/instances/'+sop+'/frames/1',current[0])
        self.assertEqual(p.evaluate(SETS,f.uid),[series]);self.assertTrue(p.evaluate(SETS,prior.uid))
        self.assertEqual(p.evaluate(STATE),{'phase':'installed','pending':0,'retries':1,'errors':0})
        expect(p.locator('#kin-series-metadata-status')).to_have_count(0);self.assertEqual(p.evaluate(IMAGE_NOTICES),[])

    def test_recovery_08_persistent_series_metadata_500_is_retried_once_then_shown(self):
        f,prior,series,sop=self.metadata_studies()
        w,p,seen=self.metadata_viewer(f,prior,series,lambda route,n:route.fulfill(status=500,content_type='text/plain',body='synthetic persistent failure'))
        text=self.metadata_failure(p,500,f,prior,series,sop);self.assertIn('한 번 다시 요청했지만',text)
        p.wait_for_function('uid=>__d05c1.services.displaySetService.getActiveDisplaySets().some(d=>d.StudyInstanceUID===uid)',arg=prior.uid)
        p.wait_for_timeout(3000)
        self.assertEqual(seen,['GET','GET']);self.assert_no_current_image(p,f,prior)
        self.assertEqual(p.evaluate(STATE),{'phase':'installed','pending':0,'retries':1,'errors':1})

    def test_recovery_09_denied_series_metadata_is_not_retried_and_is_shown(self):
        f,prior,series,sop=self.metadata_studies()
        w,p,seen=self.metadata_viewer(f,prior,series,lambda route,n:route.fulfill(status=403,content_type='application/json',body='{}'))
        text=self.metadata_failure(p,403,f,prior,series,sop);self.assertIn('접근할 수 없습니다',text)
        p.wait_for_timeout(2500)
        self.assertEqual(seen,['GET']);self.assert_no_current_image(p,f,prior)
        self.assertEqual(p.evaluate(STATE),{'phase':'installed','pending':0,'retries':0,'errors':1})

    def test_recovery_10_exit_before_the_retry_sends_and_shows_nothing_late(self):
        f,prior,series,sop=self.metadata_studies()
        w,p,seen=self.metadata_viewer(f,prior,series,transient)
        p.wait_for_function(EXIT_WHILE_WAITING,timeout=60000)
        self.assertEqual(p.evaluate(STATE),{'phase':'stopped','pending':0,'retries':0,'errors':0})
        p.wait_for_timeout(2500)
        self.assertEqual(seen,['GET']);self.assertEqual(p.evaluate(SETS,f.uid),[])
        expect(p.locator('#kin-series-metadata-status')).to_have_count(0);self.assertEqual(p.evaluate(IMAGE_NOTICES),[])
        # A new lifecycle is a new ticket, not a way back to the cancelled retry.
        p.evaluate('()=>'+RECOVERY+'.onModeEnter()');self.assertEqual(p.evaluate(STATE)['phase'],'installed')
        p.wait_for_timeout(1500)
        self.assertEqual(seen,['GET']);expect(p.locator('#kin-series-metadata-status')).to_have_count(0)
        self.assertEqual(p.evaluate(IMAGE_NOTICES),[])


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace')
    suite=unittest.TestSuite(ViewerRecoveryE2E(name) for name in ViewerRecoveryE2E.__dict__ if name.startswith('test_recovery_'))
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(not result.wasSuccessful())
