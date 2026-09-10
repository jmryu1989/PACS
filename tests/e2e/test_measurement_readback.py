# coding: utf-8
"""TEST-D04-MANUAL-READBACK: real saved receipts, source verification and UI."""
from pathlib import Path
import sys, json, unittest, uuid, subprocess
import math
from test_viewer_history import ViewerHistoryE2E, synthetic_ct, expect, literal, base


class MeasurementReadbackE2E(ViewerHistoryE2E):
    def specimen(self, slices=1):
        return synthetic_ct(self.stack, 'READBACK-'+uuid.uuid4().hex[:12], 'readback',
                            '20260908', [0, 0, 0], [1, 0, 0, 0, 1, 0], [.7, 1.3], slices=slices)

    def draw_length(self, p):
        self.open_measurement_tools(p)
        p.get_by_role('button', name='Length', exact=True).click()
        box = p.locator('.cornerstone-canvas').bounding_box()
        x, y = box['x']+box['width']*.4, box['y']+box['height']*.4
        p.mouse.move(x, y); p.mouse.down(); p.mouse.move(x+65, y+32, steps=10); p.mouse.up()
        p.wait_for_function('''()=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>
            a.metadata.toolName==='Length' && !a.invalidated && Object.values(a.data.cachedStats||{}).some(s=>Number.isFinite(s.length)))''')
        return p.locator('#kin-viewer-history section[data-kind=length]').last

    def test_01_lost_receipt_replay_keeps_verified_measurement(self):
        f = self.specimen(); w, p = self.open_viewer(f)
        self.addCleanup(w.close); self.addCleanup(p.close)
        original = self.hashes(); before = self.state(f), self.versions(f)
        row = self.draw_length(p); seen = []
        def lost(route):
            seen.append(route.request.post_data)
            response = route.fetch(); self.assertEqual(response.status, 200)
            route.abort('failed')
        p.route('**/viewer-items', lost)
        row.get_by_role('button', name='Save', exact=True).click()
        expect(row).to_contain_text('저장 결과를 확인하지 못했습니다')
        self.assertEqual(len(self.saved(f)), 1)
        def rows():
            return base.psql(f'''SELECT to_jsonb(t)::text FROM "ViewerRevision" t
                WHERE "itemId" IN (SELECT id FROM "ViewerItem" WHERE "studyUid"={literal(f.uid)})''')
        persisted = rows()
        p.unroute('**/viewer-items', lost)
        with p.expect_response(lambda r: r.request.method=='POST' and r.url.endswith('/viewer-items')) as response:
            row.get_by_role('button', name='Retry Request').click()
        receipt = response.value
        self.assertEqual(receipt.request.post_data, seen[0])
        self.assertEqual(receipt.json().get('referenceStatus'), 'verified')
        expect(row).to_contain_text('저장 완료')
        expect(p.locator('svg.svg-layer')).to_contain_text('mm')
        expect(p.locator('svg.svg-layer')).not_to_contain_text('재확인 필요')
        self.assertEqual(rows(), persisted)
        self.assertEqual((self.state(f), self.versions(f)), before)
        self.assertEqual(self.hashes(), original)

    def test_02_unverified_receipt_reports_saved_and_withholds_annotation(self):
        f = self.specimen(); w, p = self.open_viewer(f)
        self.addCleanup(w.close); self.addCleanup(p.close)
        row = self.draw_length(p)
        # A UI-only transport fault; server fault coverage is in test_03.
        def unverified(route):
            response = route.fetch(); self.assertEqual(response.status, 200)
            body = response.json(); body['referenceStatus'] = 'unverified'
            route.fulfill(response=response, json=body)
        p.route('**/viewer-items', unverified)
        row.get_by_role('button', name='Save', exact=True).click()
        expect(row).to_contain_text('저장 완료')
        expect(row).to_contain_text('재확인 필요')
        expect(row.get_by_role('button', name='Edit', exact=True)).to_be_disabled()
        self.assertEqual(p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='Length').length"), 0)
        self.assertEqual(len(self.saved(f)), 1)
        p.unroute('**/viewer-items', unverified)
        p.get_by_role('button', name='Refresh', exact=True).click()
        expect(p.locator('svg.svg-layer')).to_contain_text('mm')
        expect(row.get_by_role('button', name='Edit', exact=True)).to_be_enabled()
        # A hidden-head conflict may hold local edits while restore's response
        # is unverified. Refresh must recover those edits, not discard them.
        row.get_by_role('button', name='Edit', exact=True).click()
        row.get_by_label('Annotation Text').fill('보관한 내 수정')
        head = self.saved(f)[0]
        item = {k:v for k,v in head['item'].items() if k not in ['hidden', 'sourceDigest']}
        hidden = self.stack.request('POST', '/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions', 'doctor',
            dict(requestId=str(uuid.uuid4()), expectedRevision=head['revision'], action='hide', reason='다른 창 숨김', item=item))
        self.assertEqual(hidden.status, 200, hidden.text)
        row.get_by_role('button', name='Save', exact=True).click()
        expect(row).to_contain_text('서버에 다른 판')
        row.get_by_role('button', name='Use Latest & Keep Changes').click()
        p.route('**/viewer-items/*/revisions', unverified)
        p.once('dialog', lambda dialog: dialog.accept('보관한 수정 복원'))
        row.get_by_role('button', name='Restore', exact=True).click()
        expect(row).to_contain_text('미저장 수정은 보관 중')
        expect(row).to_contain_text('재확인 필요')
        self.assertTrue(p.evaluate('()=>window.kinViewerHistoryHasUnsaved()'))
        self.assertFalse(p.evaluate("()=>window.dispatchEvent(new Event('beforeunload',{cancelable:true}))"))
        p.unroute('**/viewer-items/*/revisions', unverified)
        waiting = []
        def unverified_list(route): waiting.append(route)
        p.route('**/viewer-items?*', unverified_list)
        p.get_by_role('button', name='Refresh', exact=True).click()
        for _ in range(100):
            if waiting: break
            p.wait_for_timeout(50)
        self.assertEqual(len(waiting), 1, 'The unverified refresh must actually be pending')
        expect(p.locator('#kin-viewer-history > [role=status]')).to_have_text('저장 항목 확인 중…')
        expect(row).to_contain_text('미저장 수정은 보관 중')
        self.assertTrue(p.evaluate('()=>window.kinViewerHistoryHasUnsaved()'))
        route = waiting.pop(); response = route.fetch(); body = response.json()
        for head in body['items']: head['referenceStatus'] = 'unverified'
        route.fulfill(response=response, json=body)
        # The held-draft text already existed before Refresh. Await this read's
        # completion before removing its fault or issuing the verified refresh.
        expect(p.locator('#kin-viewer-history > [role=status]')).to_contain_text('1개 저장 항목')
        expect(row).to_contain_text('미저장 수정은 보관 중')
        self.assertTrue(p.evaluate('()=>window.kinViewerHistoryHasUnsaved()'))
        p.unroute('**/viewer-items?*', unverified_list)
        p.get_by_role('button', name='Refresh', exact=True).click()
        expect(row.get_by_label('Annotation Text')).to_have_value('보관한 내 수정')
        expect(row).to_contain_text('보관한 수정은 아직 미저장')
        expect(p.locator('svg.svg-layer')).to_contain_text('mm')
        row.get_by_role('button', name='Save', exact=True).click()
        expect(row).to_contain_text('Saved r4')
        self.assertEqual(self.saved(f)[0]['item']['label'], '보관한 내 수정')

    def test_03_bounded_list_replay_and_current_permission(self):
        f = self.specimen(slices=8)
        original = self.hashes(); before = self.state(f), self.versions(f)
        institution = base.psql(f'SELECT "institutionId" FROM "StudyState" WHERE uid={literal(f.uid)}')[0]
        # This separate Node process uses the compiled product services and real
        # Prisma/Orthanc. Only its own HTTP transport is fault injected.
        payload = dict(uid=f.uid, caller=dict(sub=self.stack.user_ids['doctor'],
            actor=self.stack.actor('doctor'), institution=institution,
            kind='member', roles=['radiologist']))
        script = (Path(__file__).parents[1]/'viewer_readback_fault.cjs').read_text(encoding='utf-8')
        run = subprocess.run(['docker', 'exec', '-i', 'kin-api', 'node'],
            input='const fixture = '+json.dumps(payload)+';\n'+script,
            text=True, encoding='utf-8', capture_output=True, timeout=70)
        self.assertEqual(run.returncode, 0, run.stdout+'\n'+run.stderr)
        self.assertIn('READBACK PASS', run.stdout)
        self.assertEqual((self.state(f), self.versions(f)), before)
        self.assertEqual(self.hashes(), original)

    def test_04_verified_restore_preserves_dragged_geometry(self):
        f=self.specimen(); w,p=self.open_viewer(f)
        self.addCleanup(w.close); self.addCleanup(p.close)
        row=self.draw_length(p)
        row.get_by_role('button',name='Save',exact=True).click(); expect(row).to_contain_text('저장 완료')
        head=self.saved(f)[0]; old=head['item']['points']
        row.get_by_role('button',name='Edit',exact=True).click()
        xy=p.evaluate('''()=>{const a=cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='Length');
            const v=cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails')[0].getViewports()[0];
            const point=v.worldToCanvas(a.data.handles.points[1]),box=v.element.getBoundingClientRect();
            return [point[0]+box.x,point[1]+box.y];}''')
        p.mouse.move(*xy); p.mouse.down(); p.mouse.move(xy[0]+35,xy[1]+15,steps=12); p.mouse.up()
        p.wait_for_function('''old=>{const a=cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='Length');
            return a&&!a.invalidated&&JSON.stringify(a.data.handles.points)!==JSON.stringify(old)}''',arg=old)
        changed=p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='Length').data.handles.points")
        self.assertNotEqual(changed,old)
        item={k:v for k,v in head['item'].items() if k not in ['hidden','sourceDigest']}
        hidden=self.stack.request('POST','/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions','doctor',
            dict(requestId=str(uuid.uuid4()),expectedRevision=1,action='hide',reason='합성 다른 창 숨김',item=item))
        self.assertEqual(hidden.status,200,hidden.text)
        row.get_by_role('button',name='Save',exact=True).click(); expect(row).to_contain_text('서버에 다른 판')
        row.get_by_role('button',name='Use Latest & Keep Changes').click()
        # Settle the hidden-head scan, or accept an implementation that removes
        # it immediately. The retained annotation used to carry the old points.
        p.wait_for_function('''old=>{const a=cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='Length');
            return !a||JSON.stringify(a.data.handles.points)===JSON.stringify(old)}''',arg=old)
        p.once('dialog',lambda d:d.accept('보관 좌표 복원'))
        row.get_by_role('button',name='Restore',exact=True).click(); expect(row).to_contain_text('보관한 수정은 아직 미저장')
        p.wait_for_function('''points=>{const a=cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='Length');
            return a&&!a.invalidated&&JSON.stringify(a.data.handles.points)===JSON.stringify(points)}''',arg=changed,timeout=5000)
        expect(p.locator('svg.svg-layer')).to_contain_text('mm')
        row.get_by_role('button',name='Save',exact=True).click(); expect(row).to_contain_text('Saved r4')
        saved=self.saved(f)[0]['item']; self.assertEqual(saved['points'],changed)
        self.assertAlmostEqual(saved['baseline']['values'][0],math.dist(*changed),places=5)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    suite = unittest.TestSuite(MeasurementReadbackE2E(name) for name in [
        'test_01_lost_receipt_replay_keeps_verified_measurement',
        'test_02_unverified_receipt_reports_saved_and_withholds_annotation',
        'test_03_bounded_list_replay_and_current_permission',
        'test_04_verified_restore_preserves_dragged_geometry'])
    sys.exit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
