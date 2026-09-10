# coding: utf-8
"""D-MEASURE2 A1/A2/C5: real comparison viewer, drafts and BFF receipts."""
import sys, unittest, uuid
from test_held_measurements import HeldMeasurementE2E, expect, base, literal


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


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace')
    suite=unittest.TestSuite(ViewerRecoveryE2E(name) for name in ViewerRecoveryE2E.__dict__ if name.startswith('test_recovery_'))
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(not result.wasSuccessful())
