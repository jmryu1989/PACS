# coding: utf-8
"""TEST-D04-HELD-RECOVERY: explicit local discard and verified recovery."""
import sys, unittest, uuid, math
from pathlib import Path
from test_measurement_readback import MeasurementReadbackE2E, expect, base, literal


class HeldMeasurementE2E(MeasurementReadbackE2E):
    def held(self, p, f, label='보관 <img src=x onerror=window.bad=1> 수정'):
        row=self.draw_length(p)
        row.get_by_role('button',name='Save',exact=True).click(); expect(row).to_contain_text('저장 완료')
        head=self.saved(f)[0]
        row.get_by_role('button',name='Edit',exact=True).click()
        row.get_by_label('Annotation Text').fill(label)
        item={k:v for k,v in head['item'].items() if k not in ['hidden','sourceDigest']}
        response=self.stack.request('POST','/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions','doctor',
            dict(requestId=str(uuid.uuid4()),expectedRevision=head['revision'],action='hide',reason='다른 창 숨김',item=item))
        self.assertEqual(response.status,200,response.text)
        row.get_by_role('button',name='Save',exact=True).click()
        expect(row).to_contain_text('서버에 다른 판')
        row.get_by_role('button',name='Use Latest & Keep Changes').click()
        expect(row).to_contain_text('미저장 수정은 보관 중')
        return row,head

    def durable(self, f):
        # Compare every field of all owned items/revisions, not only counts.
        ids=f'SELECT id FROM "ViewerItem" WHERE "studyUid"={literal(f.uid)}'
        return {table:base.psql(f'SELECT to_jsonb(t)::text FROM "{table}" t WHERE {where} ORDER BY {order}')
            for table,where,order in [
                ('ViewerItem',f'"studyUid"={literal(f.uid)}','id'),
                ('ViewerRevision',f'"itemId" IN ({ids})','"itemId",revision'),
                ('ViewerRequest',f'"itemId" IN ({ids})','"itemId","requestId"'),
                ('ViewerStorageBudget',f'"studyUid"={literal(f.uid)}','"studyUid"')]}

    def guard(self,p,value):
        self.assertEqual(p.evaluate('()=>window.kinViewerHistoryHasUnsaved()'),value)
        self.assertEqual(p.evaluate("()=>window.dispatchEvent(new Event('beforeunload',{cancelable:true}))"),not value)

    def test_01_discard_hidden_held_edit_without_server_write(self):
        f=self.specimen(); w,p=self.open_viewer(f)
        self.addCleanup(w.close);self.addCleanup(p.close)
        original=self.hashes(); before=self.state(f),self.versions(f)
        row,_=self.held(p,f)
        expect(p.locator('svg.svg-layer')).not_to_contain_text('mm',timeout=3000)
        self.assertEqual(p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='Length').length"),0)
        row.get_by_text('Held Changes',exact=True).click()
        expect(row).to_contain_text('보관 <img src=x onerror=window.bad=1> 수정')
        self.assertEqual(row.locator('img').count(),0);self.assertIsNone(p.evaluate('()=>window.bad'))
        expect(row).to_contain_text('숨김을 복원')
        artifacts=Path(__file__).parent/'artifacts';artifacts.mkdir(exist_ok=True)
        p.screenshot(path=str(artifacts/'D04-held-preview.png'))
        saved=self.durable(f); writes=[]
        p.on('request',lambda request:writes.append(request.url) if request.method in ['POST','PATCH','DELETE'] else None)
        discard=row.get_by_role('button',name='Discard Held Changes',exact=True)
        self.guard(p,True)
        p.once('dialog',lambda dialog:dialog.dismiss());discard.click()
        expect(row).to_contain_text('미저장 수정은 보관 중');self.guard(p,True)
        p.once('dialog',lambda dialog:dialog.accept());discard.click()
        expect(row).to_contain_text('보관한 미저장 수정을 버렸습니다')
        expect(row).not_to_contain_text('Held Changes')
        self.guard(p,False)
        self.assertEqual(p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='Length').length"),0)
        self.assertEqual(writes,[]);self.assertEqual(self.durable(f),saved)
        p.get_by_role('button',name='Refresh',exact=True).click()
        expect(row).to_contain_text('Hidden');expect(row).not_to_contain_text('Held Changes')
        self.guard(p,False)
        self.assertEqual((self.state(f),self.versions(f)),before);self.assertEqual(self.hashes(),original)

    def test_02_recheck_on_another_frame_recovers_held_content(self):
        f=self.specimen(slices=2);w,p=self.open_viewer(f)
        self.addCleanup(w.close);self.addCleanup(p.close)
        row,head=self.held(p,f,label='원본 확인 뒤 이어 쓸 수정')
        def unverified(route):
            response=route.fetch();body=response.json();body['referenceStatus']='unverified'
            route.fulfill(response=response,json=body)
        p.route('**/viewer-items/*/revisions',unverified)
        p.once('dialog',lambda dialog:dialog.accept('보관 내용 복원'))
        row.get_by_role('button',name='Restore',exact=True).click()
        expect(row).to_contain_text('재확인 필요')
        expect(row.get_by_role('button',name='Recheck Source',exact=True)).to_be_enabled()
        self.guard(p,True)
        p.unroute('**/viewer-items/*/revisions',unverified)
        p.evaluate('''async()=>{const v=cornerstone.getEnabledElements()[0].viewport;
            await v.setImageIdIndex(v.getCurrentImageIdIndex()===0?1:0);v.render();}''')
        def still_unverified(route):
            response=route.fetch();body=response.json()
            for item in body['items']:item['referenceStatus']='unverified'
            route.fulfill(response=response,json=body)
        p.route('**/viewer-items?*',still_unverified)
        row.get_by_role('button',name='Recheck Source',exact=True).click()
        expect(row).to_contain_text('원본을 확인하지 못했습니다')
        expect(row).to_contain_text('보관한 수정은 유지됩니다')
        self.guard(p,True)
        p.unroute('**/viewer-items?*',still_unverified)
        row.get_by_role('button',name='Recheck Source',exact=True).click()
        expect(row.get_by_label('Annotation Text')).to_have_value('원본 확인 뒤 이어 쓸 수정')
        expect(row).to_contain_text('영상으로 이동해')
        row.get_by_role('button',name='Go to Image',exact=True).click()
        expect(p.locator('svg.svg-layer')).to_contain_text('mm')
        self.guard(p,True)
        row.get_by_role('button',name='Save',exact=True).click()
        expect(row).to_contain_text('Saved r4')
        saved=self.saved(f)[0]
        self.assertEqual(saved['item']['label'],'원본 확인 뒤 이어 쓸 수정')
        self.assertEqual(saved['item']['points'],head['item']['points'])
        self.assertAlmostEqual(saved['item']['baseline']['values'][0],math.dist(*head['item']['points']),places=8)
        self.guard(p,False)

    def test_03_pending_restore_blocks_old_discard_handler(self):
        f=self.specimen();w,p=self.open_viewer(f)
        self.addCleanup(w.close);self.addCleanup(p.close)
        row,_=self.held(p,f)
        p.evaluate('''()=>window.heldOldDiscard=[...document.querySelectorAll('#kin-viewer-history button')]
            .find(b=>b.textContent==='Discard Held Changes')''')
        requests=[]; routes=[]
        def lost(route):
            requests.append(route.request.post_data)
            routes.append(route)
        p.route('**/viewer-items/*/revisions',lost)
        p.once('dialog',lambda dialog:dialog.accept('응답 유실 복원'))
        with p.expect_request(lambda request:request.method=='POST' and request.url.endswith('/revisions')):
            row.get_by_role('button',name='Restore',exact=True).click()
        expect(row.get_by_role('button',name='Discard Held Changes',exact=True)).to_be_disabled()
        dialogs=[]
        def unexpected(dialog):dialogs.append(dialog.message);dialog.dismiss()
        p.on('dialog',unexpected)
        p.evaluate('()=>heldOldDiscard.click()')
        self.assertEqual(dialogs,[]);self.guard(p,True)
        self.assertEqual(len(routes),1)
        response=routes[0].fetch();self.assertEqual(response.status,200)
        routes[0].abort('failed')
        expect(row).to_contain_text('저장 결과를 확인하지 못했습니다')
        expect(row.get_by_role('button',name='Discard Held Changes',exact=True)).to_be_disabled()
        p.evaluate('()=>heldOldDiscard.click()')
        self.assertEqual(dialogs,[]);self.guard(p,True)
        saved=self.durable(f)
        p.unroute('**/viewer-items/*/revisions',lost)
        with p.expect_response(lambda r:r.request.method=='POST' and r.url.endswith('/revisions')) as response:
            row.get_by_role('button',name='Retry Request',exact=True).click()
        self.assertEqual(response.value.request.post_data,requests[0])
        expect(row).to_contain_text('보관한 수정은 아직 미저장')
        self.assertEqual(self.durable(f),saved);self.guard(p,True)
        self.assertEqual(row.get_by_role('button',name='Discard Held Changes',exact=True).count(),0)

    def test_04_discard_unverified_copy_keeps_other_unsaved_item(self):
        f=self.specimen();w,p=self.open_viewer(f)
        self.addCleanup(w.close);self.addCleanup(p.close)
        row,head=self.held(p,f)
        def unverified(route):
            response=route.fetch();body=response.json();body['referenceStatus']='unverified'
            route.fulfill(response=response,json=body)
        p.route('**/viewer-items/*/revisions',unverified)
        p.once('dialog',lambda dialog:dialog.accept('미검증 복원'))
        row.get_by_role('button',name='Restore',exact=True).click()
        expect(row).to_contain_text('재확인 필요')
        p.unroute('**/viewer-items/*/revisions',unverified)
        # Freeze the saved row's identity before a second local row appears.
        row=p.locator('#kin-viewer-history section[data-item-id="'+head['id']+'"]')
        other=self.draw_length(p);other.get_by_label('Annotation Text').fill('다른 미저장 항목')
        saved=self.durable(f);writes=[]
        p.on('request',lambda request:writes.append(request.url) if request.method in ['POST','PATCH','DELETE'] else None)
        p.once('dialog',lambda dialog:dialog.accept())
        row.get_by_role('button',name='Discard Held Changes',exact=True).click()
        expect(row).to_contain_text('재확인 필요');expect(row).not_to_contain_text('Held Changes')
        expect(other.get_by_label('Annotation Text')).to_have_value('다른 미저장 항목')
        self.guard(p,True);self.assertEqual(writes,[]);self.assertEqual(self.durable(f),saved)
        p.get_by_role('button',name='Refresh',exact=True).click()
        expect(row).not_to_contain_text('Held Changes')
        expect(row).not_to_contain_text('보관 <img')
        expect(other.get_by_label('Annotation Text')).to_have_value('다른 미저장 항목')
        self.guard(p,True)

    def remote_revision(self,f,action):
        head=self.saved(f)[0]
        item={k:v for k,v in head['item'].items() if k not in ['hidden','sourceDigest']}
        r=self.stack.request('POST','/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions','doctor',
            dict(requestId=str(uuid.uuid4()),expectedRevision=head['revision'],action=action,
                 reason='다른 창 반복 충돌',item=item))
        self.assertEqual(r.status,200,r.text)
        return r.body

    def test_05_repeated_restore_conflicts_keep_original_held_edit(self):
        f=self.specimen();w,p=self.open_viewer(f)
        self.addCleanup(w.close);self.addCleanup(p.close)
        label='처음 보관한 수정은 충돌해도 유지'
        row,head=self.held(p,f,label=label)
        self.remote_revision(f,'restore');self.remote_revision(f,'hide')
        p.once('dialog',lambda dialog:dialog.accept('다시 복원'))
        row.get_by_role('button',name='Restore',exact=True).click()
        expect(row).to_contain_text('서버에 다른 판')
        row.get_by_role('button',name='Use Latest & Keep Changes').click()
        row.get_by_text('Held Changes',exact=True).click()
        expect(row).to_contain_text(label)
        expect(row).to_contain_text('Saved r4');self.guard(p,True)
        # The next current head is visible: keeping the same held edit must
        # restore it for editing instead of editing an old saved draft.
        self.remote_revision(f,'restore')
        p.once('dialog',lambda dialog:dialog.accept('겹친 복원'))
        row.get_by_role('button',name='Restore',exact=True).click()
        expect(row).to_contain_text('서버에 다른 판')
        row.get_by_role('button',name='Use Latest & Keep Changes').click()
        expect(row.get_by_label('Annotation Text')).to_have_value(label)
        expect(row).to_contain_text('보관한 수정은 아직 미저장')
        expect(p.locator('svg.svg-layer')).to_contain_text('mm')
        row.get_by_role('button',name='Save',exact=True).click()
        expect(row).to_contain_text('Saved r6')
        item=self.saved(f)[0]['item']
        self.assertEqual(item['label'],label);self.assertEqual(item['points'],head['item']['points'])
        self.guard(p,False)

    def test_06_discard_after_conflict_adopts_known_latest_head(self):
        f=self.specimen();w,p=self.open_viewer(f)
        self.addCleanup(w.close);self.addCleanup(p.close)
        row,_=self.held(p,f)
        self.remote_revision(f,'restore');self.remote_revision(f,'hide')
        p.once('dialog',lambda dialog:dialog.accept('충돌한 복원'))
        row.get_by_role('button',name='Restore',exact=True).click()
        expect(row).to_contain_text('서버에 다른 판')
        saved=self.durable(f);writes=[]
        p.on('request',lambda request:writes.append(request.url) if request.method in ['POST','PATCH','DELETE'] else None)
        p.once('dialog',lambda dialog:dialog.accept())
        row.get_by_role('button',name='Discard Held Changes',exact=True).click()
        expect(row).to_contain_text('Saved r4')
        expect(row.get_by_role('button',name='Use Latest & Keep Changes')).to_have_count(0)
        expect(row).not_to_contain_text('Held Changes')
        self.guard(p,False);self.assertEqual(self.durable(f),saved);self.assertEqual(writes,[])


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace')
    suite=unittest.TestSuite(HeldMeasurementE2E(name) for name in [
        'test_01_discard_hidden_held_edit_without_server_write',
        'test_02_recheck_on_another_frame_recovers_held_content',
        'test_03_pending_restore_blocks_old_discard_handler',
        'test_04_discard_unverified_copy_keeps_other_unsaved_item',
        'test_05_repeated_restore_conflicts_keep_original_held_edit',
        'test_06_discard_after_conflict_adopts_known_latest_head'])
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(not result.wasSuccessful())
