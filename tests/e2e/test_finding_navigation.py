# coding: utf-8
"""TEST-S2-UI-01/02 (REQ-S2-RECORD/FRESHNESS/NAVIGATE/IDEMPOTENT/PRESERVE): real pinned OHIF, BFF login,
owned synthetic multi-slice CT and the real findings API. Image identity is asserted from the viewport's
current image id, never from a success message."""
from pathlib import Path
import sys, json, unittest, uuid
from unittest.mock import patch
import test_worklist as base
from test_viewer_history import ViewerHistoryE2E, synthetic_ct, expect, literal
from finding_api_test import FindingStack

CURRENT_IMAGE = "sop=>cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports()).some(v=>v.getCurrentImageId?.().includes('/instances/'+sop+'/frames/1'))"
ACTIVE_IMAGE = "uid=>{const s=__d05c1.services;return s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getActiveViewportId())?.getCurrentImageId?.().includes('/studies/'+uid+'/')}"
ANNOTATIONS = "()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='Length').map(a=>({highlighted:!!a.highlighted,selected:cornerstoneTools.annotation.selection.isAnnotationSelected(a.annotationUID),image:a.metadata.referencedImageId}))"
HIGHLIGHTED = "()=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName==='Length'&&a.highlighted&&cornerstoneTools.annotation.selection.isAnnotationSelected(a.annotationUID))"

class FindingNavigationE2E(ViewerHistoryE2E):
    @classmethod
    def setUpClass(cls):
        with patch.object(base, 'LiveStack', FindingStack): super().setUpClass()

    def specimen(self, slices=6):
        return synthetic_ct(self.stack, 'FINDNAV-'+uuid.uuid4().hex[:12], 'findnav', '20260917', [0, 0, 0], [1, 0, 0, 0, 1, 0], [.7, 1.3], slices=slices)

    def sops(self, f):
        found = self.stack._orthanc_request('POST', '/tools/lookup', f.uid.encode())
        study = next(x['ID'] for x in found.body if x['Type'] == 'Study')
        instances = self.stack._orthanc_request('GET', '/studies/'+study+'/instances').body
        return [i['MainDicomTags']['SOPInstanceUID'] for i in sorted(instances, key=lambda i: int(i['MainDicomTags']['InstanceNumber']))]

    def scroll(self, p, index):
        p.evaluate("i=>cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports())[0].setImageIdIndex(i)", index)
        p.wait_for_function("i=>cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports())[0].getCurrentImageIdIndex()===i", arg=index)

    def draw_length(self, p):
        self.open_measurement_tools(p)
        p.get_by_role('button', name='Length', exact=True).click()
        box = p.locator('.cornerstone-canvas').bounding_box()
        x, y = box['x']+box['width']*.4, box['y']+box['height']*.4
        p.mouse.move(x, y); p.mouse.down(); p.mouse.move(x+65, y+32, steps=10); p.mouse.up()
        p.wait_for_function('''()=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>
            a.metadata.toolName==='Length' && !a.invalidated && Object.values(a.data.cachedStats||{}).some(s=>Number.isFinite(s.length)))''')
        return p.locator('#kin-viewer-history section[data-kind=length]').last

    def findings(self, f):
        r = self.stack.request('GET', '/studies/'+f.uid+'/findings?includeHidden=true', 'doctor')
        self.assertEqual(r.status, 200, r.text); return r.body['items']

    def panel(self, p):
        panel = p.locator('#kin-viewer-findings'); expect(panel).to_have_count(1)
        expect(panel.locator('#kin-viewer-findings-status')).to_contain_text('개 소견')
        return panel

    def compose(self, p, title, text, link_text):
        panel = self.panel(p)
        panel.get_by_role('button', name='New Finding', exact=True).click()
        key = panel.locator('article[data-saved=false]').last.get_attribute('data-row-key')
        row = panel.locator('article[data-row-key="'+key+'"]')
        row.get_by_label('Finding Title').fill(title); row.get_by_label('Finding Text').fill(text)
        row.get_by_label(link_text).click()
        expect(row.locator('[data-kin-sources] [data-item-id]')).to_have_count(1)
        return row

    def saved_row(self, p, finding_id):
        return self.panel(p).locator('article[data-finding-id="'+finding_id+'"]')

    def test_01_save_finding_new_login_and_exact_frame_navigation(self):
        f = self.specimen(); sops = self.sops(f); self.seed_report(f)
        w, p = self.open_viewer(f)
        before = (self.state(f), self.versions(f)); original = self.hashes()
        self.scroll(p, 2)
        row = self.draw_length(p); row.get_by_role('button', name='Save', exact=True).click(); expect(row).to_contain_text('저장 완료')
        head = self.saved(f)[0]; self.assertEqual(head['item']['sopUid'], sops[2]); self.assertEqual(head['item']['kind'], 'length')
        finding_row = self.compose(p, '우폐 결절 <img src=x onerror="window.bad=1">', '3번 단면 길이', 'Link Length')
        finding_row.get_by_role('button', name='Save', exact=True).click()
        expect(finding_row).to_contain_text('저장 완료')
        saved = self.findings(f); self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0]['item']['sources'][0]['itemId'], head['id']); self.assertEqual(saved[0]['item']['sources'][0]['values'], head['item']['baseline']['values'])
        self.assertEqual(saved[0]['item']['sources'][0]['sopUid'], sops[2]); self.assertEqual(saved[0]['links'][0]['linkState'], 'current')
        saved_row = self.saved_row(p, saved[0]['id'])
        expect(saved_row).to_contain_text('Saved r1'); expect(saved_row.locator('[data-kin-link-state]')).to_have_text('Current')
        self.assertEqual(saved_row.locator('img').count(), 0); self.assertIsNone(p.evaluate('()=>window.bad'))
        # Scroll away, navigate back through the finding: the viewport must show the saved SOP and the annotation must be highlighted.
        self.scroll(p, 5)
        self.assertFalse(p.evaluate(CURRENT_IMAGE, sops[2]))
        saved_row.get_by_role('button', name='Go to Image', exact=True).first.click()
        p.wait_for_function(CURRENT_IMAGE, arg=sops[2])
        p.wait_for_function(HIGHLIGHTED)
        marks = p.evaluate(ANNOTATIONS); self.assertEqual(len(marks), 1); self.assertIn('/instances/'+sops[2]+'/', marks[0]['image'])
        p.close(); w.close()
        w, p = self.open_viewer(f)
        saved_row = self.saved_row(p, saved[0]['id'])
        expect(saved_row).to_contain_text('3번 단면 길이'); expect(saved_row.locator('[data-kin-link-state]')).to_have_text('Current')
        self.assertFalse(p.evaluate(CURRENT_IMAGE, sops[2]))
        saved_row.get_by_role('button', name='Go to Image', exact=True).first.click()
        p.wait_for_function(CURRENT_IMAGE, arg=sops[2])
        p.wait_for_function(HIGHLIGHTED)
        artifacts = Path(__file__).parent/'artifacts'; artifacts.mkdir(exist_ok=True); p.screenshot(path=str(artifacts/'S2A-finding-navigation.png'))
        w2, p2 = self.open_viewer(f, 'doctor2')
        # Another radiologist may write findings of their own but never edit this one.
        expect(self.saved_row(p2, saved[0]['id'])).to_contain_text('Read-only')
        self.assertEqual(self.saved_row(p2, saved[0]['id']).get_by_role('button', name='Edit', exact=True).count(), 0)
        self.assertEqual(self.saved_row(p2, saved[0]['id']).get_by_role('button', name='Hide', exact=True).count(), 0)
        self.assertEqual((self.state(f), self.versions(f)), before); self.assertEqual(self.hashes(), original)

    def test_02_freshness_revised_hidden_refresh_and_text_edit_preserves_copy(self):
        f = self.specimen(slices=3); sops = self.sops(f); w, p = self.open_viewer(f)
        original = self.hashes()
        row = self.draw_length(p); row.get_by_role('button', name='Save', exact=True).click(); expect(row).to_contain_text('저장 완료')
        head = self.saved(f)[0]
        finding_row = self.compose(p, '소견', '본문', 'Link Length'); finding_row.get_by_role('button', name='Save', exact=True).click()
        expect(finding_row).to_contain_text('저장 완료'); saved = self.findings(f)[0]
        # Another window moves the measurement: the finding keeps its frozen numbers and reads Revised.
        item = {k: v for k, v in head['item'].items() if k not in ['hidden', 'sourceDigest']}
        item['points'] = [item['points'][0], [item['points'][1][0]+5, item['points'][1][1], item['points'][1][2]]]
        moved = self.stack.request('POST', '/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions', 'doctor', dict(requestId=str(uuid.uuid4()), expectedRevision=1, action='edit', item=item))
        self.assertEqual(moved.status, 200, moved.text); self.assertNotEqual(moved.body['item']['baseline']['values'], head['item']['baseline']['values'])
        p.get_by_role('button', name='Refresh', exact=True).first.click()
        panel = self.panel(p); saved_row = self.saved_row(p, saved['id'])
        panel.get_by_role('button', name='Refresh', exact=True).click()
        expect(saved_row.locator('[data-kin-link-state]')).to_have_text('Revised')
        expect(saved_row).to_contain_text('현재 r2')
        self.assertEqual(self.findings(f)[0]['item']['sources'][0]['values'], head['item']['baseline']['values'])
        # A text edit keeps the frozen copy; the link stays Revised.
        saved_row.get_by_role('button', name='Edit', exact=True).click(); saved_row.get_by_label('Finding Text').fill('본문 수정')
        saved_row.get_by_role('button', name='Save', exact=True).click(); expect(saved_row).to_contain_text('Saved r2')
        after_text = self.findings(f)[0]
        self.assertEqual(after_text['item']['sources'], saved['item']['sources']); self.assertEqual(after_text['links'][0]['linkState'], 'revised')
        def rows():
            return base.psql(f'''SELECT to_jsonb(t)::text FROM "FindingRevision" t WHERE "findingId"={literal(saved['id'])}::uuid ORDER BY revision''')
        persisted = rows(); self.assertEqual(len(persisted), 2)
        # Explicit refresh copies the current head into revision 3; revisions 1 and 2 stay byte-equal.
        saved_row.get_by_role('button', name='Refresh Link', exact=True).click(); expect(saved_row).to_contain_text('Saved r3')
        expect(saved_row.locator('[data-kin-link-state]')).to_have_text('Current')
        refreshed = self.findings(f)[0]
        self.assertEqual(refreshed['item']['sources'][0]['revision'], 2); self.assertEqual(refreshed['item']['sources'][0]['values'], moved.body['item']['baseline']['values'])
        self.assertEqual(rows()[:2], persisted)
        # Hiding the measurement reads Hidden; navigation still reaches the frame and says why nothing is drawn.
        hidden = self.stack.request('POST', '/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions', 'doctor', dict(requestId=str(uuid.uuid4()), expectedRevision=2, action='hide', reason='다른 창 숨김', item=item))
        self.assertEqual(hidden.status, 200, hidden.text)
        p.get_by_role('button', name='Refresh', exact=True).first.click(); panel.get_by_role('button', name='Refresh', exact=True).click()
        expect(saved_row.locator('[data-kin-link-state]')).to_have_text('Hidden')
        self.scroll(p, 2); self.assertFalse(p.evaluate(CURRENT_IMAGE, sops[0]))
        saved_row.get_by_role('button', name='Go to Image', exact=True).first.click()
        p.wait_for_function(CURRENT_IMAGE, arg=sops[0]); expect(saved_row).to_contain_text('표식이 숨겨져 있어 그리지 않습니다')
        self.assertEqual(p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='Length').length"), 0)
        self.assertEqual(self.hashes(), original)

    def test_03_lost_receipt_retry_conflict_and_stale_source(self):
        f = self.specimen(slices=2); w, p = self.open_viewer(f)
        row = self.draw_length(p); row.get_by_role('button', name='Save', exact=True).click(); expect(row).to_contain_text('저장 완료')
        head = self.saved(f)[0]; seen = []
        def lost(route):
            seen.append(route.request.post_data); response = route.fetch(); self.assertEqual(response.status, 200); route.abort('failed')
        p.route('**/findings', lost)
        finding_row = self.compose(p, '유실 응답', '본문', 'Link Length'); finding_row.get_by_role('button', name='Save', exact=True).click()
        expect(finding_row).to_contain_text('저장 결과를 확인하지 못했습니다'); self.assertEqual(len(self.findings(f)), 1)
        p.unroute('**/findings', lost)
        with p.expect_response(lambda r: r.request.method == 'POST' and r.url.endswith('/findings')) as response:
            finding_row.get_by_role('button', name='Retry Request', exact=True).click()
        self.assertEqual(response.value.request.post_data, seen[0]); expect(finding_row).to_contain_text('저장 완료')
        saved = self.findings(f); self.assertEqual(len(saved), 1); self.assertEqual(saved[0]['revision'], 1)
        self.assertEqual(base.psql(f'''SELECT count(*) FROM "FindingRevision" WHERE "findingId"={literal(saved[0]['id'])}::uuid'''), ['1'])
        # Two-window conflict: the other window's edit wins, this window keeps its text and adopts the latest head.
        panel = self.panel(p); saved_row = self.saved_row(p, saved[0]['id'])
        saved_row.get_by_role('button', name='Edit', exact=True).click(); saved_row.get_by_label('Finding Text').fill('내 수정 보존')
        other = dict(requestId=str(uuid.uuid4()), expectedRevision=1, action='edit', item=dict(schemaVersion=1, title='다른 창', text='', sources=[dict(itemId=head['id'], revision=1)]))
        self.assertEqual(self.stack.request('POST', '/studies/'+f.uid+'/findings/'+saved[0]['id']+'/revisions', 'doctor', other).status, 200)
        saved_row.get_by_role('button', name='Save', exact=True).click(); expect(saved_row).to_contain_text('서버에 다른 판')
        expect(saved_row.get_by_label('Finding Text')).to_have_value('내 수정 보존'); expect(saved_row.get_by_role('button', name='Save', exact=True)).to_be_disabled()
        saved_row.get_by_role('button', name='Use Latest & Keep Changes', exact=True).click(); saved_row.get_by_role('button', name='Save', exact=True).click()
        expect(saved_row).to_contain_text('Saved r3'); self.assertEqual(self.findings(f)[0]['item']['text'], '내 수정 보존')
        # A source that moved between selection and save is refused with its current revision; Refresh Link re-pairs it.
        item = {k: v for k, v in head['item'].items() if k not in ['hidden', 'sourceDigest']}
        item['points'] = [item['points'][0], [item['points'][1][0]+3, item['points'][1][1], item['points'][1][2]]]
        p.get_by_role('button', name='Refresh', exact=True).first.click(); panel.get_by_role('button', name='Refresh', exact=True).click()
        expect(saved_row.locator('[data-kin-link-state]')).to_have_text('Current')
        new_row = self.compose(p, '늦은 저장', '', 'Link Length')
        moved = self.stack.request('POST', '/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions', 'doctor', dict(requestId=str(uuid.uuid4()), expectedRevision=1, action='edit', item=item))
        self.assertEqual(moved.status, 200, moved.text)
        new_row.get_by_role('button', name='Save', exact=True).click(); expect(new_row).to_contain_text('더 새로운 판(r2)')
        self.assertEqual(len(self.findings(f)), 1)
        def unavailable(r): r.fulfill(status=503, content_type='application/json', body='{"message":"synthetic unavailable"}')
        p.route('**/findings', unavailable)
        new_row.get_by_role('button', name='Save', exact=True).click(); expect(new_row).to_contain_text('저장 결과를 확인하지 못했습니다')
        p.unroute('**/findings', unavailable)
        new_row.get_by_role('button', name='Retry Request', exact=True).click(); expect(new_row).to_contain_text('더 새로운 판(r2)')
        self.assertEqual(len(self.findings(f)), 1)

    def test_04_a_b_a_late_list_scope_refusal_and_logout(self):
        f = self.specimen(slices=2); b = self.fixture(f.patient_id); sops = self.sops(f)
        w, p = self.open_viewer(f, extra=b, observer=True)
        def switch(uid):
            p.evaluate('''uid=>{const s=__d05c1.services;const d=s.displaySetService.getActiveDisplaySets().find(d=>d.StudyInstanceUID===uid);if(!d)throw Error('missing display set');s.viewportGridService.setDisplaySetsForViewport({viewportId:s.viewportGridService.getActiveViewportId(),displaySetInstanceUIDs:[d.displaySetInstanceUID]});}''', uid)
            p.wait_for_function(ACTIVE_IMAGE, arg=uid)
            expect(p.locator('#kin-viewer-findings')).to_have_attribute('data-study-uid', uid)
        switch(f.uid); expect(p.locator('#kin-viewer-findings-status')).to_contain_text('개 소견')
        row = self.draw_length(p); row.get_by_role('button', name='Save', exact=True).click(); expect(row).to_contain_text('저장 완료')
        finding_row = self.compose(p, 'old A', '', 'Link Length'); finding_row.get_by_role('button', name='Save', exact=True).click(); expect(finding_row).to_contain_text('저장 완료')
        saved = self.findings(f)[0]
        delayed = []
        def hold(r): delayed.append((r, r.fetch()))
        pattern = '**/studies/'+f.uid+'/findings?*'; p.route(pattern, hold)
        p.locator('#kin-viewer-findings').get_by_role('button', name='Refresh', exact=True).click()
        for _ in range(50):
            if delayed: break
            p.wait_for_timeout(20)
        self.assertEqual(len(delayed), 1)
        edit = dict(requestId=str(uuid.uuid4()), expectedRevision=1, action='edit', item=dict(schemaVersion=1, title='new A', text='', sources=[dict(itemId=s['itemId'], revision=s['revision']) for s in saved['item']['sources']]))
        self.assertEqual(self.stack.request('POST', '/studies/'+f.uid+'/findings/'+saved['id']+'/revisions', 'doctor', edit).status, 200)
        switch(b.uid); expect(p.locator('#kin-viewer-findings-status')).to_contain_text('0개 소견')
        url = p.url
        # The finding of A is refused for scope while B is active: no display-set change, no URL change.
        result = p.evaluate("t=>window.kinViewerHistoryNavigate(t)", dict(studyUid=f.uid, seriesUid=saved['item']['sources'][0]['seriesUid'], sopUid=saved['item']['sources'][0]['sopUid'], frame=1, itemId=saved['item']['sources'][0]['itemId']))
        self.assertEqual(result, dict(ok=False, reason='scope')); self.assertEqual(p.url, url)
        self.assertTrue(p.evaluate(ACTIVE_IMAGE, b.uid))
        for bad, reason in [(dict(studyUid=b.uid, seriesUid='2.25.1', sopUid='2.25.2', frame=1), 'series-missing'), (dict(studyUid=b.uid, seriesUid='x', sopUid='2.25.2', frame=1), 'invalid')]:
            self.assertEqual(p.evaluate("t=>window.kinViewerHistoryNavigate(t)", bad), dict(ok=False, reason=reason))
        p.unroute(pattern, hold); switch(f.uid); expect(p.locator('#kin-viewer-findings')).to_contain_text('new A')
        for r, response in delayed:
            try: r.fulfill(response=response)
            except Exception: pass  # Aborted requests may already be disposed.
        p.wait_for_timeout(500); expect(p.locator('#kin-viewer-findings')).not_to_contain_text('old A')
        # Back on A the finding navigates again and the frame is proven from the active viewport.
        p.evaluate("()=>{const s=__d05c1.services;return s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getActiveViewportId()).setImageIdIndex(1)}")
        p.wait_for_function("sop=>{const s=__d05c1.services;return !s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getActiveViewportId()).getCurrentImageId().includes('/instances/'+sop+'/')}", arg=sops[0])
        finding_row = self.saved_row(p, saved['id'])
        finding_row.get_by_role('button', name='Go to Image', exact=True).first.click()
        p.wait_for_function("sop=>{const s=__d05c1.services;return s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getActiveViewportId()).getCurrentImageId().includes('/instances/'+sop+'/frames/1')}", arg=sops[0])
        p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}")
        expect(p.locator('#kin-viewer-findings')).to_contain_text('다시 로그인'); self.assertEqual(p.locator('#kin-viewer-findings article').count(), 0)
        self.assertEqual(p.evaluate("t=>window.kinViewerHistoryNavigate?window.kinViewerHistoryNavigate(t):{ok:false,reason:'tool-missing'}", dict(studyUid=f.uid, seriesUid=saved['item']['sources'][0]['seriesUid'], sopUid=saved['item']['sources'][0]['sopUid'], frame=1)), dict(ok=False, reason='ended'))

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(defaultTest=[f'FindingNavigationE2E.{n}' for n in FindingNavigationE2E.__dict__ if n.startswith('test_')], verbosity=2)
