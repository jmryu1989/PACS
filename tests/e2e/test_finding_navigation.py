# coding: utf-8
"""TEST-S2-UI-01/02 (REQ-S2-RECORD/FRESHNESS/NAVIGATE/IDEMPOTENT/PRESERVE): real pinned OHIF, BFF login,
owned synthetic multi-slice CT and the real findings API. Image identity is asserted from the viewport's
current image id, never from a success message. Tests 05/06 (REQ-S2B-GUARD): unsaved and pending
findings block Next Study, window reuse/close and unload while clean viewers stay usable, and survive a
comparison viewport activation, a 403 and a same-document mode exit until logout. Test 07 (S2-B2
REQ-S2B2-ANCHOR/PICK/NAVIGATE/REVOKE): in an hpCompare viewer of two run-owned same-patient CTs the
Findings section stays on the first study, links a comparison item, lands on the exact comparison
SOP/frame (identity and pixel readback) and keeps nothing of a withdrawn comparison study."""
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
import sys, json, math, re, unittest, uuid
from unittest.mock import patch
import test_worklist as base
from test_viewer_history import ViewerHistoryE2E, synthetic_ct, expect, literal, canvas_ready
from viewer_precision_support import hook
from finding_api_test import FindingStack, BOUNDARY_COLUMNS

CURRENT_IMAGE = "sop=>cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports()).some(v=>v.getCurrentImageId?.().includes('/instances/'+sop+'/frames/1'))"
ACTIVE_IMAGE = "uid=>{const s=__d05c1.services;return s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getActiveViewportId())?.getCurrentImageId?.().includes('/studies/'+uid+'/')}"
ANNOTATIONS = "()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='Length').map(a=>({highlighted:!!a.highlighted,selected:cornerstoneTools.annotation.selection.isAnnotationSelected(a.annotationUID),image:a.metadata.referencedImageId}))"
HIGHLIGHTED = "()=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName==='Length'&&a.highlighted&&cornerstoneTools.annotation.selection.isAnnotationSelected(a.annotationUID))"
UNLOAD = "()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented}"
GUARDS = "()=>({workspace:kinViewerHistoryWorkspaceState(),findings:kinViewerFindingsState(),marks:kinViewerHistoryHasUnsaved()})"
LIFECYCLE = "n=>{for(const id of ['kin.viewer-history','kin.viewer-findings'])window.config.extensions.find(e=>e.id===id)[n]()}"
# S2-B2: the history of the active viewport, every viewport's shown image, and a pixel readback of the
# synthetic slice (row 195 carries a bar (z+1)*9 pixels wide left of the phantom disc).
HISTORY_READY = "uid=>{const h=window.kinViewerHistoryState?.();return !!h&&h.scope===uid&&!h.suspended&&!h.ended}"
VIEWPORTS = "()=>{const s=__d05c1.services;return [...s.viewportGridService.getState().viewports.keys()].map(id=>({id,image:s.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageId?.()||''}))}"
SELECT_VIEWPORT = "id=>__d05c1.services.viewportGridService.setActiveViewportId(id)"
ACTIVE_ID = "()=>__d05c1.services.viewportGridService.getActiveViewportId()"
IMAGE_OF = "id=>__d05c1.services.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageId?.()||''"
INDEX_OF = "([id,i])=>__d05c1.services.cornerstoneViewportService.getCornerstoneViewport(id).setImageIdIndex(i)"
BAR = """id=>{const v=__d05c1.services.cornerstoneViewportService.getCornerstoneViewport(id),img=cornerstone.cache.getImage(v.getCurrentImageId());
  const d=img.getPixelData(),w=img.columns||img.width;let n=0;for(let x=0;x<58;x++)if(d[195*w+x]!==d[195*w])n++;return n}"""
HISTORY_IMAGE = "()=>{const h=kinViewerHistoryState();return {scope:h.scope,viewportId:h.viewportId,image:h.image}}"
RECORD_NAVIGATION = "()=>{const f=window.kinViewerHistoryNavigate;window.__navs=[];window.kinViewerHistoryNavigate=function(t){window.__navs.push(JSON.parse(JSON.stringify(t)));return f.call(this,t)}}"

def one_decimal(n):
    """A copied value as finding-link-model.js valueText writes it: Math.round(n * 10) / 10, then toFixed(1)."""
    x = n * 10; r = math.floor(x)
    if x - r >= .5: r += 1
    return '%.1f' % (r / 10 + 0.0)

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
        # S2-L R5: a findings page holding a version 2 record is served only to a client that names that record format;
        # the viewer writes version 2 on every create and edit.
        r = self.stack.bearer_request('GET', '/studies/'+f.uid+'/findings?includeHidden=true', self.stack.token('doctor'), headers={'X-KIN-Finding-Schema': '2'})
        self.assertEqual(r.status, 200, r.text); return r.body['items']

    def panel(self, p, reading=False):
        """The Findings section with an answered list, or (`reading`) with its list read still unanswered: that
        read keeps the rows it replaces on screen and says so. S2-B2: activating the comparison viewport of
        the same viewer does not cancel it, so a test that holds the read must expect exactly that state."""
        panel = p.locator('#kin-viewer-findings'); expect(panel).to_have_count(1)
        status = panel.locator('#kin-viewer-findings-status')
        if reading: expect(status).to_have_text('소견 확인 중…')
        else: expect(status).to_contain_text('개 소견')
        return panel

    def compose(self, p, title, text, link_text, shows=None, characteristics=None):
        """`shows`: text the choice's own label must contain before it is linked (its checkbox name stays `link_text`).
        `characteristics`: S2-L free-text lesion characteristics typed into their own field."""
        panel = self.panel(p)
        panel.get_by_role('button', name='New Finding', exact=True).click()
        key = panel.locator('article[data-saved=false]').last.get_attribute('data-row-key')
        row = panel.locator('article[data-row-key="'+key+'"]')
        row.get_by_label('Finding Title').fill(title); row.get_by_label('Finding Text').fill(text)
        if characteristics is not None: row.get_by_label('Finding Characteristics', exact=True).fill(characteristics)
        if shows: expect(row.get_by_label(link_text).locator('xpath=..')).to_contain_text(shows)
        row.get_by_label(link_text).click()
        expect(row.locator('[data-kin-sources] [data-item-id]')).to_have_count(1)
        # What was typed is still in its fields after the renders this click and the section's saved-Jobs answer cause.
        expect(row.get_by_label('Finding Title')).to_have_value(title)
        expect(row.get_by_label('Finding Text')).to_have_value(text)
        if characteristics is not None: expect(row.get_by_label('Finding Characteristics', exact=True)).to_have_value(characteristics)
        return row

    def saved_row(self, p, finding_id, reading=False):
        return self.panel(p, reading).locator('article[data-finding-id="'+finding_id+'"]')

    def refresh_both(self, p):
        # The Measurements panel owns the exact name 'Refresh' (unique on the page); the nested
        # Findings section owns 'Reload Findings'. Neither selector may rely on ordinal picking.
        p.locator('#kin-viewer-history').get_by_role('button', name='Refresh', exact=True).click()
        self.panel(p).get_by_role('button', name='Reload Findings', exact=True).click()

    def test_01_save_finding_new_login_and_exact_frame_navigation(self):
        f = self.specimen(); sops = self.sops(f); self.seed_report(f)
        w, p = self.open_viewer(f)
        before = (self.state(f), self.versions(f)); original = self.hashes()
        self.scroll(p, 2)
        row = self.draw_length(p); row.get_by_role('button', name='Save', exact=True).click(); expect(row).to_contain_text('저장 완료')
        head = self.saved(f)[0]; self.assertEqual(head['item']['sopUid'], sops[2]); self.assertEqual(head['item']['kind'], 'length')
        # S2-V: the live head (no calculator in the panel's state) and the saved copy both read in mm.
        length = ' · r1 · ' + one_decimal(head['item']['baseline']['values'][0]) + ' mm'
        finding_row = self.compose(p, '우폐 결절 <img src=x onerror="window.bad=1">', '3번 단면 길이', 'Link Length', shows=length)
        finding_row.get_by_role('button', name='Save', exact=True).click()
        expect(finding_row).to_contain_text('저장 완료')
        saved = self.findings(f); self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0]['item']['sources'][0]['itemId'], head['id']); self.assertEqual(saved[0]['item']['sources'][0]['values'], head['item']['baseline']['values'])
        self.assertEqual(saved[0]['item']['sources'][0]['calculator'], 'kin-native-manual-v1')
        self.assertEqual(saved[0]['item']['sources'][0]['sopUid'], sops[2]); self.assertEqual(saved[0]['links'][0]['linkState'], 'current')
        saved_row = self.saved_row(p, saved[0]['id'])
        expect(saved_row).to_contain_text('Saved r1'); expect(saved_row.locator('[data-kin-link-state]')).to_have_text('Current')
        expect(saved_row.locator('[data-kin-sources] [data-item-id]')).to_contain_text(length + ' · Current')
        expect(saved_row).not_to_contain_text('단위 미확인')
        self.assertEqual(saved_row.locator('img').count(), 0); self.assertIsNone(p.evaluate('()=>window.bad'))
        # Scroll away, navigate back through the finding: the viewport must show the saved SOP and the annotation must be highlighted.
        self.scroll(p, 5)
        self.assertFalse(p.evaluate(CURRENT_IMAGE, sops[2]))
        saved_row.locator('[data-kin-sources] [data-item-id]').get_by_role('button', name='Go to Image', exact=True).click()
        p.wait_for_function(CURRENT_IMAGE, arg=sops[2])
        p.wait_for_function(HIGHLIGHTED)
        marks = p.evaluate(ANNOTATIONS); self.assertEqual(len(marks), 1); self.assertIn('/instances/'+sops[2]+'/', marks[0]['image'])
        p.close(); w.close()
        w, p = self.open_viewer(f)
        saved_row = self.saved_row(p, saved[0]['id'])
        expect(saved_row).to_contain_text('3번 단면 길이'); expect(saved_row.locator('[data-kin-link-state]')).to_have_text('Current')
        self.assertFalse(p.evaluate(CURRENT_IMAGE, sops[2]))
        saved_row.locator('[data-kin-sources] [data-item-id]').get_by_role('button', name='Go to Image', exact=True).click()
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
        # The API stores the window's native Length result as sent and never recomputes it; the browser
        # saved the world distance of these exact points, so the other window sends the moved distance.
        self.assertAlmostEqual(head['item']['baseline']['values'][0], math.dist(*head['item']['points']), delta=1e-9)
        item = {k: v for k, v in head['item'].items() if k not in ['hidden', 'sourceDigest']}
        item['points'] = [item['points'][0], [item['points'][1][0]+5, item['points'][1][1], item['points'][1][2]]]
        item['baseline'] = dict(item['baseline'], values=[math.dist(*item['points'])])
        moved = self.stack.request('POST', '/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions', 'doctor', dict(requestId=str(uuid.uuid4()), expectedRevision=1, action='edit', item=item))
        self.assertEqual(moved.status, 200, moved.text); self.assertNotEqual(moved.body['item']['baseline']['values'], head['item']['baseline']['values'])
        self.assertEqual((moved.body['item']['points'], moved.body['item']['baseline']), (item['points'], item['baseline']))
        self.refresh_both(p)
        panel = self.panel(p); saved_row = self.saved_row(p, saved['id'])
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
        self.refresh_both(p)
        expect(saved_row.locator('[data-kin-link-state]')).to_have_text('Hidden')
        self.scroll(p, 2); self.assertFalse(p.evaluate(CURRENT_IMAGE, sops[0]))
        saved_row.locator('[data-kin-sources] [data-item-id]').get_by_role('button', name='Go to Image', exact=True).click()
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
        # S2-L version rule: the viewer saved a version 2 record, so the other window's edit is version 2 as well.
        other = dict(requestId=str(uuid.uuid4()), expectedRevision=1, action='edit', item=dict(schemaVersion=2, title='다른 창', text='', characteristics='', sources=[dict(itemId=head['id'], revision=1)]))
        self.assertEqual(self.stack.request('POST', '/studies/'+f.uid+'/findings/'+saved[0]['id']+'/revisions', 'doctor', other).status, 200)
        saved_row.get_by_role('button', name='Save', exact=True).click(); expect(saved_row).to_contain_text('서버에 다른 판')
        expect(saved_row.get_by_label('Finding Text')).to_have_value('내 수정 보존'); expect(saved_row.get_by_role('button', name='Save', exact=True)).to_be_disabled()
        saved_row.get_by_role('button', name='Use Latest & Keep Changes', exact=True).click(); saved_row.get_by_role('button', name='Save', exact=True).click()
        expect(saved_row).to_contain_text('Saved r3'); self.assertEqual(self.findings(f)[0]['item']['text'], '내 수정 보존')
        # A source that moved between selection and save is refused with its current revision; Refresh Link re-pairs it.
        item = {k: v for k, v in head['item'].items() if k not in ['hidden', 'sourceDigest']}
        item['points'] = [item['points'][0], [item['points'][1][0]+3, item['points'][1][1], item['points'][1][2]]]
        self.refresh_both(p)
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
            self.activate(p, uid)
            p.wait_for_function(HISTORY_READY, arg=uid)
        switch(f.uid); expect(p.locator('#kin-viewer-findings-status')).to_contain_text('개 소견')
        row = self.draw_length(p); row.get_by_role('button', name='Save', exact=True).click(); expect(row).to_contain_text('저장 완료')
        finding_row = self.compose(p, 'old A', '', 'Link Length'); finding_row.get_by_role('button', name='Save', exact=True).click(); expect(finding_row).to_contain_text('저장 완료')
        saved = self.findings(f)[0]
        delayed = []
        def hold(r): delayed.append((r, r.fetch()))
        pattern = '**/studies/'+f.uid+'/findings?*'; p.route(pattern, hold)
        p.locator('#kin-viewer-findings').get_by_role('button', name='Reload Findings', exact=True).click()
        for _ in range(50):
            if delayed: break
            p.wait_for_timeout(20)
        self.assertEqual(len(delayed), 1)
        edit = dict(requestId=str(uuid.uuid4()), expectedRevision=1, action='edit', item=dict(schemaVersion=2, title='new A', text='', characteristics='', sources=[dict(itemId=s['itemId'], revision=s['revision']) for s in saved['item']['sources']]))
        self.assertEqual(self.stack.request('POST', '/studies/'+f.uid+'/findings/'+saved['id']+'/revisions', 'doctor', edit).status, 200)
        # S2-B2: activating the other study of this comparison viewer keeps the first study's list as it is,
        # with its reload still unanswered (held above): the old rows stay and the status says it is reading.
        switch(b.uid)
        self.assertEqual(len(delayed), 1)
        expect(self.saved_row(p, saved['id'], reading=True)).to_contain_text('old A')
        url = p.url
        # The finding of A is refused for scope while B is active: no display-set change, no URL change.
        result = p.evaluate("t=>window.kinViewerHistoryNavigate(t)", dict(studyUid=f.uid, seriesUid=saved['item']['sources'][0]['seriesUid'], sopUid=saved['item']['sources'][0]['sopUid'], frame=1, itemId=saved['item']['sources'][0]['itemId']))
        self.assertEqual(result, dict(ok=False, reason='scope')); self.assertEqual(p.url, url)
        self.assertTrue(p.evaluate(ACTIVE_IMAGE, b.uid))
        for bad, reason in [(dict(studyUid=b.uid, seriesUid='2.25.1', sopUid='2.25.2', frame=1), 'series-missing'), (dict(studyUid=b.uid, seriesUid='x', sopUid='2.25.2', frame=1), 'invalid')]:
            self.assertEqual(p.evaluate("t=>window.kinViewerHistoryNavigate(t)", bad), dict(ok=False, reason=reason))
        # The panel's own Go to Image for A names the viewport to select and moves nothing.
        self.saved_row(p, saved['id'], reading=True).locator('[data-kin-sources] [data-item-id]').get_by_role('button', name='Go to Image', exact=True).click()
        expect(self.saved_row(p, saved['id'], reading=True)).to_contain_text('현재 검사의 영상 칸이 선택되어 있지 않아 이동하지 않았습니다')
        self.assertTrue(p.evaluate(ACTIVE_IMAGE, b.uid)); self.assertEqual(p.url, url)
        # A real document-level change (mode exit and entry) drops the late list of the first store (A-B-A).
        p.evaluate(LIFECYCLE, 'onModeExit'); p.unroute(pattern, hold); p.evaluate(LIFECYCLE, 'onModeEnter')
        expect(p.locator('#kin-viewer-findings')).to_contain_text('new A', timeout=30000)
        expect(p.locator('#kin-viewer-findings')).to_have_attribute('data-study-uid', f.uid)
        for r, response in delayed:
            try: r.fulfill(response=response)
            except Exception: pass  # Aborted requests may already be disposed.
        p.wait_for_timeout(500); expect(p.locator('#kin-viewer-findings')).not_to_contain_text('old A')
        switch(f.uid)
        # Back on A the finding navigates again and the frame is proven from the active viewport.
        p.evaluate("()=>{const s=__d05c1.services;return s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getActiveViewportId()).setImageIdIndex(1)}")
        p.wait_for_function("sop=>{const s=__d05c1.services;return !s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getActiveViewportId()).getCurrentImageId().includes('/instances/'+sop+'/')}", arg=sops[0])
        finding_row = self.saved_row(p, saved['id'])
        finding_row.locator('[data-kin-sources] [data-item-id]').get_by_role('button', name='Go to Image', exact=True).click()
        p.wait_for_function("sop=>{const s=__d05c1.services;return s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getActiveViewportId()).getCurrentImageId().includes('/instances/'+sop+'/frames/1')}", arg=sops[0])
        p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}")
        expect(p.locator('#kin-viewer-findings')).to_contain_text('다시 로그인'); self.assertEqual(p.locator('#kin-viewer-findings article').count(), 0)
        self.assertEqual(p.evaluate("t=>window.kinViewerHistoryNavigate?window.kinViewerHistoryNavigate(t):{ok:false,reason:'tool-missing'}", dict(studyUid=f.uid, seriesUid=saved['item']['sources'][0]['seriesUid'], sopUid=saved['item']['sources'][0]['sopUid'], frame=1)), dict(ok=False, reason='ended'))

    # ---- S2-B draft protection: guards, clean controls and held drafts ----
    def seed_key(self, f, title):
        found = self.stack._orthanc_request('POST', '/tools/lookup', f.uid.encode())
        study = next(x['ID'] for x in found.body if x['Type'] == 'Study')
        series = self.stack._orthanc_request('GET', '/studies/'+study+'/series').body[0]['MainDicomTags']['SeriesInstanceUID']
        body = dict(requestId=str(uuid.uuid4()), item=dict(schemaVersion=1, kind='key', seriesUid=series, sopUid=self.sops(f)[0], frame=1, title=title, description=''))
        r = self.stack.request('POST', '/studies/'+f.uid+'/viewer-items', 'doctor', body); self.assertEqual(r.status, 200, r.text)

    def viewer_ready(self, p):
        studies = parse_qs(urlsplit(p.url).query)['StudyInstanceUIDs'][0].split(',')
        canvas_ready(p, len(studies)); self.open_measurement_tools(p)
        expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text('개 저장 항목')
        self.panel(p); return studies

    def workspace(self, w, f):
        if not w.locator('.left').is_visible(): w.get_by_role('button', name='Worklist', exact=True).click()
        self.select(w, f)
        if w.locator('#m-reading').text_content() != 'Back to Worklist': w.locator('#m-reading').click()
        expect(w.locator('#reading-target')).to_contain_text(f.uid)
        expect(w.locator('#reading-status')).to_have_text('영상 작업공간 연결됨', timeout=60000)
        frame = w.locator('#reading-frame').element_handle().content_frame()
        self.assertEqual(self.viewer_ready(frame)[0], f.uid); return frame

    def activate(self, p, uid):
        p.evaluate('''uid=>{const s=__d05c1.services;const d=s.displaySetService.getActiveDisplaySets().find(d=>d.StudyInstanceUID===uid);if(!d)throw Error('missing display set');s.viewportGridService.setDisplaySetsForViewport({viewportId:s.viewportGridService.getActiveViewportId(),displaySetInstanceUIDs:[d.displaySetInstanceUID]});}''', uid)
        p.wait_for_function(ACTIVE_IMAGE, arg=uid)
        p.wait_for_function("uid=>window.kinViewerHistoryState?.().scope===uid", arg=uid)
        # S2-B2: the Findings section of a comparison viewer stays on the first study of its URL.
        expect(p.locator('#kin-viewer-findings')).to_have_attribute('data-study-uid', parse_qs(urlsplit(p.url).query)['StudyInstanceUIDs'][0].split(',')[0])

    def test_05_finding_draft_guards_next_study_window_reuse_close_and_clean_controls(self):
        f = self.specimen(slices=2)
        b = synthetic_ct(self.stack, f.patient_id, 'findprior', '20260801', [0, 0, 0], [1, 0, 0, 0, 1, 0], [.7, 1.3], slices=2)
        self.seed_key(f, 'guard key A'); self.seed_key(b, 'guard key B')
        original, items = self.hashes(), (self.saved(f), self.saved(b))
        w = self.login(); w.set_viewport_size(dict(width=1680, height=1100))
        w.on('dialog', lambda d: d.accept())  # Frame Coverage confirmations of clean viewers only.
        frame = self.workspace(w, f)
        self.assertEqual(frame.evaluate(GUARDS)['workspace'], dict(dirty=False, busy=False))
        # A separate window with an unsaved finding: dirty for every whole-viewer guard, not for the mark-only flag.
        with w.context.expect_page() as opened: w.get_by_role('button', name='Open Viewer Window', exact=True).click()
        popup = opened.value; popup.wait_for_url('**/ohif/viewer?**')
        popup_studies = self.viewer_ready(popup)
        popup.wait_for_function("()=>typeof kinViewerWindowOwner==='function'&&!!kinViewerWindowOwner()")
        self.assertFalse(popup.evaluate(UNLOAD), 'a clean window closes without a prompt')
        self.compose(popup, 'POPUP DRAFT', '창 재사용 보호', 'Link Key Image')
        guards = popup.evaluate(GUARDS)
        self.assertEqual((guards['workspace'], guards['findings']['dirty'], guards['marks']), (dict(dirty=True, busy=False), True, False))
        self.assertTrue(popup.evaluate(UNLOAD))
        # The clean embedded viewer follows a selection change.
        frame = self.workspace(w, b)
        # Window reuse for another study is refused for the unsaved finding; the window keeps its study and draft.
        w.get_by_role('button', name='Open Viewer Window', exact=True).click()
        expect(w.locator('#toast')).to_contain_text('저장하지 않은 표식이나 작업 내용(소견 작성 내용 포함)')
        self.assertEqual(parse_qs(urlsplit(popup.url).query)['StudyInstanceUIDs'][0].split(','), popup_studies)
        expect(self.panel(popup).get_by_label('Finding Title')).to_have_value('POPUP DRAFT')
        # Close Window is refused for the same reason, visible as Unsaved in the window list.
        w.locator('#m-reading').click(); expect(w.locator('#m-reading')).to_have_text('Reading Workspace')
        self.open_toolbar_group(w, '#viewer-windows-open')
        w.locator('#viewer-windows-open').click(); expect(w.locator('#viewer-windows-dialog')).to_be_visible()
        expect(w.locator('.viewer-window-row')).to_have_count(1); expect(w.locator('.viewer-window-row')).to_contain_text('Unsaved')
        w.locator('[data-window-action="close"]').click()
        expect(w.locator('#viewer-windows-status')).to_contain_text('창을 닫지 않았습니다'); self.assertFalse(popup.is_closed())
        w.locator('#viewer-windows-done').click()
        # Discarding the draft makes the same window reusable: it now shows the selected study.
        self.panel(popup).get_by_role('button', name='Discard Draft', exact=True).click()
        popup.wait_for_function('()=>!kinViewerHistoryWorkspaceState().dirty&&!kinViewerHistoryWorkspaceState().busy')
        w.locator('#m-reading').click(); expect(w.locator('#reading-status')).to_have_text('영상 작업공간 연결됨', timeout=60000)
        w.get_by_role('button', name='Open Viewer Window', exact=True).click()
        expect(popup).to_have_url(re.compile(r'[?&]StudyInstanceUIDs=' + re.escape(b.uid) + r'(?:[,&#]|$)'), timeout=60000)
        self.assertFalse(popup.is_closed()); self.assertEqual(self.viewer_ready(popup)[0], b.uid)
        # An unsaved finding in the embedded viewer stops Next Study; the draft stays and Return restores the viewer.
        frame = self.workspace(w, f)
        self.compose(frame, 'WORKSPACE DRAFT', 'Next Study 보호', 'Link Key Image')
        self.assertEqual(frame.evaluate(GUARDS)['workspace'], dict(dirty=True, busy=False))
        order = w.locator('#rows tr[data-uid]').evaluate_all('rows=>rows.map(r=>r.dataset.uid)')
        self.assertEqual(sorted(order), sorted([f.uid, b.uid]))
        step = 'Next Study' if order.index(f.uid) == 0 else 'Previous Study'
        w.get_by_role('button', name=step, exact=True).click()
        expect(w.locator('#reading-target')).to_contain_text(b.uid)
        expect(w.locator('#reading-status')).to_contain_text('저장하지 않은 작업이 있습니다')
        expect(w.get_by_role('button', name='Discard Viewer Changes & Open', exact=True)).to_be_visible()
        expect(w.locator('#reading-frame')).to_be_hidden()
        expect(self.panel(frame).get_by_label('Finding Title')).to_have_value('WORKSPACE DRAFT')
        w.get_by_role('button', name='Return to Previous Viewer', exact=True).click()
        expect(w.locator('#reading-target')).to_contain_text(f.uid); expect(w.locator('#reading-frame')).to_be_visible()
        expect(self.panel(frame).get_by_label('Finding Title')).to_have_value('WORKSPACE DRAFT')
        # Without the draft the same Next Study proceeds.
        self.panel(frame).get_by_role('button', name='Discard Draft', exact=True).click()
        frame.wait_for_function('()=>!kinViewerHistoryWorkspaceState().dirty')
        w.get_by_role('button', name=step, exact=True).click()
        expect(w.locator('#reading-target')).to_contain_text(b.uid)
        expect(w.locator('#reading-status')).to_have_text('영상 작업공간 연결됨', timeout=60000)
        frame = w.locator('#reading-frame').element_handle().content_frame()
        self.assertEqual(self.viewer_ready(frame)[0], b.uid)
        # A clean window closes.
        popup.wait_for_function("()=>typeof kinViewerWindowOwner==='function'&&!!kinViewerWindowOwner()&&!kinViewerHistoryWorkspaceState().dirty")
        w.locator('#m-reading').click(); self.open_toolbar_group(w, '#viewer-windows-open'); w.locator('#viewer-windows-open').click()
        expect(w.locator('.viewer-window-row')).to_contain_text('Open')
        w.locator('[data-window-action="close"]').click()
        expect(w.locator('#viewer-windows-status')).to_contain_text('영상 창을 닫았습니다'); self.assertTrue(popup.is_closed())
        self.assertEqual((self.findings(f), self.findings(b)), ([], []))
        self.assertEqual((self.saved(f), self.saved(b)), items); self.assertEqual(self.hashes(), original)

    def test_06_held_drafts_survive_study_switch_403_and_mode_exit_until_logout(self):
        f = self.specimen(slices=2); b = self.fixture(f.patient_id)
        self.seed_key(f, 'held key'); original = self.hashes(); keys = self.saved(f)
        w, p = self.open_viewer(f, extra=b, observer=True)
        panel = p.locator('#kin-viewer-findings'); held = panel.locator('#kin-viewer-findings-held')
        status = panel.locator('#kin-viewer-findings-status')
        self.activate(p, f.uid); expect(status).to_contain_text('개 소견')
        self.assertFalse(p.evaluate(UNLOAD))
        self.compose(p, 'HELD DRAFT', '보관 확인', 'Link Key Image')
        draft = panel.locator('article[data-saved=false]'); expect(draft).to_have_count(1)
        # S2-B2: activating the comparison study of this viewer keeps the draft live on the first study; nothing is held.
        self.activate(p, b.uid)
        expect(held).to_be_hidden()
        expect(draft.get_by_label('Finding Title')).to_have_value('HELD DRAFT'); expect(draft.get_by_label('Finding Text')).to_have_value('보관 확인')
        self.assertEqual(p.evaluate(GUARDS), dict(workspace=dict(dirty=True, busy=False), findings=dict(scope=f.uid, dirty=True, busy=False, held=0), marks=False))
        self.assertTrue(p.evaluate(UNLOAD))
        # Back on A the same draft is still there, never parked or restored.
        self.activate(p, f.uid)
        expect(draft).to_have_count(1)
        expect(draft.get_by_label('Finding Title')).to_have_value('HELD DRAFT'); expect(draft.get_by_label('Finding Text')).to_have_value('보관 확인')
        expect(draft.locator('[data-kin-sources] [data-item-id]')).to_have_count(1)
        expect(draft).not_to_contain_text('보관했던'); expect(held).to_be_hidden()
        # A refused list (403) holds it again and shows nothing of it; the next authorized list restores it.
        pattern = '**/studies/'+f.uid+'/findings?*'
        def refused(r): r.fulfill(status=403, content_type='application/json', body='{"message":"synthetic refusal"}')
        p.route(pattern, refused); panel.get_by_role('button', name='Reload Findings', exact=True).click()
        expect(status).to_contain_text('접근할 수 없습니다'); expect(panel.get_by_label('Finding Title')).to_have_count(0)
        expect(held).to_contain_text('현재 검사'); self.assertTrue(p.evaluate('()=>kinViewerHistoryWorkspaceState().dirty'))
        p.unroute(pattern, refused); panel.get_by_role('button', name='Reload Findings', exact=True).click()
        expect(draft.get_by_label('Finding Title')).to_have_value('HELD DRAFT'); expect(held).to_be_hidden()
        # An unconfirmed save (503) keeps its request live across a comparison activation; Retry there sends the same body once.
        seen = []
        def unavailable(r):
            seen.append(r.request.post_data); r.fulfill(status=503, content_type='application/json', body='{"message":"synthetic unavailable"}')
        post = '**/studies/'+f.uid+'/findings'
        p.route(post, unavailable); draft.get_by_role('button', name='Save', exact=True).click()
        expect(draft).to_contain_text('저장 결과를 확인하지 못했습니다'); p.unroute(post, unavailable)
        self.assertEqual(len(seen), 1); self.assertEqual(p.evaluate('()=>kinViewerHistoryWorkspaceState()'), dict(dirty=True, busy=True))
        self.activate(p, b.uid); expect(held).to_be_hidden()
        self.assertEqual(p.evaluate('()=>kinViewerHistoryWorkspaceState()'), dict(dirty=True, busy=True))
        expect(draft).to_contain_text('저장 결과를 확인하지 못했습니다')
        with p.expect_response(lambda r: r.request.method == 'POST' and r.url.endswith('/studies/'+f.uid+'/findings')) as response:
            draft.get_by_role('button', name='Retry Request', exact=True).click()
        self.assertEqual(response.value.request.post_data, seen[0]); self.assertEqual(response.value.status, 200)
        expect(panel.locator('article[data-saved=true]')).to_have_count(1); expect(draft).to_have_count(0)
        self.activate(p, f.uid)
        saved = self.findings(f); self.assertEqual([x['item']['title'] for x in saved], ['HELD DRAFT'])
        p.wait_for_function('()=>{const s=kinViewerHistoryWorkspaceState();return !s.dirty&&!s.busy}')
        # A mode exit of this same document holds a new draft (still guarded); the next entry restores it after its list.
        self.compose(p, 'MODE DRAFT', '', 'Link Key Image')
        p.evaluate(LIFECYCLE, 'onModeExit')
        expect(p.locator('#kin-viewer-findings')).to_have_count(0)
        self.assertEqual(p.evaluate("()=>[typeof kinViewerFindingsState,typeof kinViewerHistoryWorkspaceState]"), ['undefined', 'undefined'])
        self.assertTrue(p.evaluate(UNLOAD))
        p.evaluate(LIFECYCLE, 'onModeEnter')
        restored = p.locator('#kin-viewer-findings article[data-saved=false]')
        expect(restored.get_by_label('Finding Title')).to_have_value('MODE DRAFT', timeout=30000)
        expect(restored).to_contain_text('보관했던 작성 내용을 복원했습니다')
        expect(p.locator('#kin-viewer-findings article[data-saved=true]')).to_have_count(1)
        self.assertTrue(p.evaluate('()=>kinViewerHistoryWorkspaceState().dirty'))
        # Logout destroys the draft; nothing of it remains or is counted.
        p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}")
        expect(p.locator('#kin-viewer-findings')).to_contain_text('다시 로그인'); expect(p.locator('#kin-viewer-findings article')).to_have_count(0)
        self.assertEqual(p.evaluate('()=>[kinViewerHistoryWorkspaceState(),kinViewerFindingsState()]'),
                         [dict(dirty=False, busy=False), dict(scope=f.uid, dirty=False, busy=False, held=0)])
        self.assertEqual(len(self.findings(f)), 1); self.assertEqual(self.saved(f), keys); self.assertEqual(self.hashes(), original)

    # ---- S2-B2 comparison sources: helpers shared with the worklist suite ----
    def key_at(self, f, index, title):
        found = self.stack._orthanc_request('POST', '/tools/lookup', f.uid.encode())
        study = next(x['ID'] for x in found.body if x['Type'] == 'Study')
        series = self.stack._orthanc_request('GET', '/studies/'+study+'/series').body[0]['MainDicomTags']['SeriesInstanceUID']
        body = dict(requestId=str(uuid.uuid4()), item=dict(schemaVersion=1, kind='key', seriesUid=series, sopUid=self.sops(f)[index], frame=1, title=title, description=''))
        r = self.stack.request('POST', '/studies/'+f.uid+'/viewer-items', 'doctor', body); self.assertEqual(r.status, 200, r.text); return r.body

    def comparison_viewer(self, x, prior):
        w = self.login(); p = w.context.new_page(); p.set_viewport_size(dict(width=1680, height=1000))
        def config(r):
            a = r.fetch(); r.fulfill(response=a, body=a.text()+'\n'+hook)
        p.route('**/ohif/app-config.js', config)
        p.goto(self.stack.proxy+'/ohif/viewer?StudyInstanceUIDs='+x.uid+','+prior.uid+'&hangingProtocolId=@ohif/hpCompare')
        canvas_ready(p, 2); self.open_measurement_tools(p)
        expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text('개 저장 항목')
        return w, p

    def viewport_of(self, p, uid):
        p.wait_for_function("uid=>{const s=__d05c1.services;return [...s.viewportGridService.getState().viewports.keys()].some(id=>(s.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageId?.()||'').includes('/studies/'+uid+'/'))}", arg=uid, timeout=60000)
        shown = [v['id'] for v in p.evaluate(VIEWPORTS) if '/studies/'+uid+'/' in v['image']]
        self.assertEqual(len(shown), 1, shown); return shown[0]

    def select_viewport(self, p, viewport, uid):
        p.evaluate(SELECT_VIEWPORT, viewport)
        p.wait_for_function(HISTORY_READY, arg=uid, timeout=30000)
        self.assertEqual(p.evaluate(ACTIVE_ID), viewport)

    def scroll_viewport(self, p, viewport, index, away_from):
        p.evaluate(INDEX_OF, [viewport, index])
        p.wait_for_function("([id,sop])=>!(__d05c1.services.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageId?.()||'').includes('/instances/'+sop+'/')", arg=[viewport, away_from])

    def withdraw(self, uid):
        """The run-owned comparison study leaves this institution (SYNTHETIC boundary change, always restored)."""
        assert uid in self.stack.active
        columns = ', '.join("'%s', \"%s\"" % (c, c) for c in BOUNDARY_COLUMNS)
        saved = base.psql(f'SELECT jsonb_build_object({columns})::text FROM "StudyState" WHERE uid={literal(uid)}')[0]
        def restore():
            assignments = ', '.join("\"%s\"=s.j->>'%s'" % (c, c) for c in BOUNDARY_COLUMNS)
            base.psql(f'UPDATE "StudyState" t SET {assignments} FROM (SELECT {literal(saved)}::jsonb AS j) s WHERE t.uid={literal(uid)}')
            self.assertEqual(json.loads(base.psql(f'SELECT jsonb_build_object({columns})::text FROM "StudyState" WHERE uid={literal(uid)}')[0]), json.loads(saved))
        self.addCleanup(restore)
        base.psql(f'''UPDATE "StudyState" SET "institutionId"='kin-center', "teleInstitutionId"=NULL WHERE uid={literal(uid)}''')
        return restore

    def evidence(self, name, record, page):
        out = Path(__file__).parent/'artifacts/measurement-ci'; out.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(out/(name+'.png')))
        (out/(name+'.json')).write_text(json.dumps(record, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')

    def test_07_comparison_source_stays_on_first_study_exact_comparison_frame_and_withdrawal(self):
        x = self.specimen(slices=2)
        prior = synthetic_ct(self.stack, x.patient_id, 'findcompare', '20250917', [0, 0, 0], [1, 0, 0, 0, 1, 0], [.7, 1.3], slices=3)
        label = 'P 비교 키 '+uuid.uuid4().hex[:8]
        xk, pk = self.key_at(x, 0, 'X 기준 키'), self.key_at(prior, 2, label)
        prior_sops = self.sops(prior); original, items = self.hashes(), (self.saved(x), self.saved(prior))
        w, p = self.comparison_viewer(x, prior)
        panel = p.locator('#kin-viewer-findings')
        expect(panel).to_have_attribute('data-study-uid', x.uid); expect(panel).to_have_attribute('data-comparison-uid', prior.uid)
        expect(panel).to_have_attribute('data-comparison-state', 'ready', timeout=20000)
        expect(panel.locator('#kin-viewer-findings-pair-note')).to_contain_text('비교 검사 하나에서만')
        vx, vp = self.viewport_of(p, x.uid), self.viewport_of(p, prior.uid)
        self.select_viewport(p, vx, x.uid)
        # A draft with one source of each study while the first study is active.
        panel.get_by_role('button', name='New Finding', exact=True).click()
        row = panel.locator('article[data-saved=false]'); expect(row).to_have_count(1)
        row.get_by_label('Finding Title').fill('비교 소견 초안'); row.get_by_label('Finding Text').fill('비교 검사 원본 연결')
        row.get_by_label('Link Key Image · X 기준 키 · 프레임 1 · r1', exact=True).click()
        row.get_by_label('Link Comparison Key Image · '+label+' · 프레임 1 · r1', exact=True).click()
        expect(row.locator('[data-kin-sources] [data-item-id]')).to_have_count(2)
        expect(row.locator('[data-source-study=comparison]')).to_contain_text('[비교 검사]')
        # The comparison viewport becomes active: the section, the draft and its guard stay on the first study.
        self.select_viewport(p, vp, prior.uid)
        expect(panel).to_have_attribute('data-study-uid', x.uid); expect(panel.locator('#kin-viewer-findings-held')).to_be_hidden()
        expect(row.get_by_label('Finding Title')).to_have_value('비교 소견 초안')
        self.assertEqual(p.evaluate(GUARDS)['findings'], dict(scope=x.uid, dirty=True, busy=False, held=0))
        # A lost answer while the comparison is active: the pending body survives both activations and Retry replays it.
        seen = []
        def lost(route):
            seen.append(route.request.post_data); r = route.fetch(); self.assertEqual(r.status, 200); route.abort('failed')
        p.route('**/studies/'+x.uid+'/findings', lost)
        row.get_by_role('button', name='Save', exact=True).click(); expect(row).to_contain_text('저장 결과를 확인하지 못했습니다')
        p.unroute('**/studies/'+x.uid+'/findings', lost)
        self.select_viewport(p, vx, x.uid); self.select_viewport(p, vp, prior.uid)
        self.assertEqual(p.evaluate(GUARDS)['workspace'], dict(dirty=True, busy=True))
        with p.expect_response(lambda r: r.request.method == 'POST' and r.url.endswith('/studies/'+x.uid+'/findings')) as response:
            row.get_by_role('button', name='Retry Request', exact=True).click()
        self.assertEqual((response.value.request.post_data, response.value.status), (seen[0], 200))
        self.assertEqual(json.loads(seen[0])['item']['sources'], [dict(itemId=xk['id'], revision=1), dict(itemId=pk['id'], revision=1)])
        saved = self.findings(x); self.assertEqual(len(saved), 1)
        self.assertEqual([(s['studyUid'], s['sopUid']) for s in saved[0]['item']['sources']], [(x.uid, xk['item']['sopUid']), (prior.uid, prior_sops[2])])
        saved_row = self.saved_row(p, saved[0]['id']); expect(saved_row).to_contain_text('Saved r1')
        # From the first study's viewport, Go to Image of the comparison source lands on its exact SOP/frame.
        self.select_viewport(p, vx, x.uid)
        self.scroll_viewport(p, vp, 0, prior_sops[2])
        x_image = p.evaluate(IMAGE_OF, vx)
        p.evaluate(RECORD_NAVIGATION)
        saved_row.locator('[data-source-study=comparison]').get_by_role('button', name='Go to Image', exact=True).click()
        expect(saved_row).to_contain_text('비교 검사 영상 칸에서 원본 프레임으로 이동했습니다', timeout=20000)
        target = dict(studyUid=prior.uid, seriesUid=pk['item']['seriesUid'], sopUid=prior_sops[2], frame=1, itemId=pk['id'])
        arrived = dict(active=p.evaluate(ACTIVE_ID), history=p.evaluate(HISTORY_IMAGE), comparisonImage=p.evaluate(IMAGE_OF, vp),
                       firstImage=p.evaluate(IMAGE_OF, vx), bar=p.evaluate(BAR, vp), sent=p.evaluate('()=>window.__navs'))
        self.assertEqual(arrived['active'], vp)
        self.assertEqual(arrived['history'], dict(scope=prior.uid, viewportId=vp, image=dict(study=prior.uid, seriesUid=target['seriesUid'], sopUid=prior_sops[2], frame=1)))
        self.assertIn('/studies/'+prior.uid+'/series/'+target['seriesUid']+'/instances/'+prior_sops[2]+'/frames/1', arrived['comparisonImage'])
        self.assertEqual(arrived['firstImage'], x_image, 'the first study viewport did not move')
        self.assertEqual(arrived['bar'], 27, 'pixel row of synthetic slice 3')
        self.assertEqual(arrived['sent'], [target])
        self.evidence('S2B2-comparison-navigation', dict(first=vx, comparison=vp, target=target, arrived=arrived), p)
        # The first study's own source while the comparison is active names the viewport to select and moves nothing.
        saved_row.locator('[data-source-study=current]').get_by_role('button', name='Go to Image', exact=True).click()
        expect(saved_row).to_contain_text('현재 검사의 영상 칸이 선택되어 있지 않아 이동하지 않았습니다')
        self.assertEqual((p.evaluate(ACTIVE_ID), p.evaluate(IMAGE_OF, vx)), (vp, x_image))
        # The comparison study is withdrawn while the author edits: nothing of it or of the finding stays shown.
        saved_row.get_by_role('button', name='Edit', exact=True).click(); saved_row.get_by_label('Finding Text').fill('작성자 수정 보존')
        restore = self.withdraw(prior.uid)
        self.select_viewport(p, vx, x.uid)
        panel.get_by_role('button', name='Reload Findings', exact=True).click()
        expect(panel).to_have_attribute('data-comparison-state', 'denied', timeout=20000)
        expect(panel.locator('article[data-saved=true]')).to_have_count(0)
        kept = panel.locator('article[data-saved=false]'); expect(kept).to_have_count(1)
        expect(kept.get_by_label('Finding Text')).to_have_value('작성자 수정 보존')
        expect(kept).to_contain_text('이 소견을 더 이상 볼 수 없어 저장하지 않았습니다')
        expect(kept.locator('[data-source-study=comparison]')).to_have_count(0); expect(kept.locator('[data-source-study=current]')).to_have_count(1)
        shown = panel.inner_text()
        for secret in [label, prior_sops[2], pk['id'], '[비교 검사]']: self.assertNotIn(secret, shown)
        self.assertEqual(self.findings(x), [])
        self.evidence('S2B2-comparison-withdrawn', dict(state=p.evaluate("()=>document.querySelector('#kin-viewer-findings').dataset.comparisonState"), rows=panel.locator('article').count()), p)
        kept.get_by_role('button', name='Discard Draft', exact=True).click()
        restore()
        self.assertEqual([f['id'] for f in self.findings(x)], [saved[0]['id']], 'the withdrawn finding and its history return unchanged')
        self.assertEqual(self.findings(x)[0]['item'], saved[0]['item'])
        self.assertEqual((self.saved(x), self.saved(prior)), items); self.assertEqual(self.hashes(), original)

    def test_08_characteristics_live_disclosure_history_and_older_api(self):
        """S2-C/S2-L2b: characteristics entry, save, new login, reopen and History; the arrival note follows the viewer's own
        entry (revised, working), never the list; navigation writes nothing; an older API answer makes the section read-only."""
        f = self.specimen(slices=3); sops = self.sops(f); self.seed_report(f)
        w, p = self.open_viewer(f)
        original, report = self.hashes(), (self.state(f), self.versions(f))
        row = self.draw_length(p); row.get_by_role('button', name='Save', exact=True).click(); expect(row).to_contain_text('저장 완료')
        head = self.saved(f)[0]
        traits = '경계 불명확한 간유리 결절 😀 <b>'
        composed = self.compose(p, '특성 소견', '본문', 'Link Length', characteristics=traits)
        field = composed.get_by_label('Finding Characteristics', exact=True)
        help_id = field.get_attribute('aria-describedby')
        expect(p.locator('#'+help_id)).to_have_text('사용자가 직접 입력하는 병변 특성입니다. 정해진 용어나 항목은 없으며 판독문에 자동 반영하지 않습니다.')
        self.assertEqual(field.get_attribute('maxlength'), '1000')
        composed.get_by_role('button', name='Save', exact=True).click(); expect(composed).to_contain_text('저장 완료')
        saved = self.findings(f)[0]
        self.assertEqual((saved['item']['schemaVersion'], saved['item']['characteristics']), (2, traits))
        stored = base.psql(f'''SELECT snapshot->>'characteristics' FROM "FindingRevision" WHERE "findingId"={literal(saved['id'])}::uuid''')
        self.assertEqual(stored, [traits])
        saved_row = self.saved_row(p, saved['id'])
        expect(saved_row.locator('[data-kin-characteristics]')).to_have_text('Characteristics (병변 특성): '+traits)
        # Another window moves the measurement: the list says Revised, and the arrival names the drawn revision.
        item = {k: v for k, v in head['item'].items() if k not in ['hidden', 'sourceDigest']}
        item['points'] = [item['points'][0], [item['points'][1][0]+4, item['points'][1][1], item['points'][1][2]]]
        item['baseline'] = dict(item['baseline'], values=[math.dist(*item['points'])])
        moved = self.stack.request('POST', '/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions', 'doctor', dict(requestId=str(uuid.uuid4()), expectedRevision=1, action='edit', item=item))
        self.assertEqual(moved.status, 200, moved.text)
        self.refresh_both(p)
        expect(saved_row.locator('[data-kin-link-state]')).to_have_text('Revised')
        rows_before = (base.psql(f'''SELECT to_jsonb(t)::text FROM "FindingRevision" t WHERE "findingId"={literal(saved['id'])}::uuid ORDER BY revision'''), self.saved(f))
        self.scroll(p, 2)
        saved_row.locator('[data-kin-sources] [data-item-id]').get_by_role('button', name='Go to Image', exact=True).click()
        p.wait_for_function(CURRENT_IMAGE, arg=sops[0])
        expect(saved_row).to_contain_text('표시한 표식은 현재판 r2이며 소견의 수치는 연결 당시 r1의 사본입니다(위치·수치가 다를 수 있음).')
        # The same arrival while the measurement is being edited in this window also says so.
        p.locator('#kin-viewer-history section[data-kind=length]').first.get_by_role('button', name='Edit', exact=True).click()
        self.scroll(p, 2)
        saved_row.locator('[data-kin-sources] [data-item-id]').get_by_role('button', name='Go to Image', exact=True).click()
        p.wait_for_function(CURRENT_IMAGE, arg=sops[0])
        expect(saved_row).to_contain_text('편집 중인 미저장 위치일 수 있습니다.')
        # Navigation wrote nothing; the copied number is still the linked revision's text.
        self.assertEqual((base.psql(f'''SELECT to_jsonb(t)::text FROM "FindingRevision" t WHERE "findingId"={literal(saved['id'])}::uuid ORDER BY revision'''), self.saved(f)), rows_before)
        self.assertEqual(self.findings(f)[0]['item']['sources'][0]['values'], head['item']['baseline']['values'])
        p.close(); w.close()
        # A new login reopens the record with its characteristics and History shows them per revision.
        w, p = self.open_viewer(f)
        saved_row = self.saved_row(p, saved['id'])
        expect(saved_row.locator('[data-kin-characteristics]')).to_have_text('Characteristics (병변 특성): '+traits)
        saved_row.get_by_role('button', name='History', exact=True).click()
        expect(saved_row).to_contain_text('r1 · 생성 · ')
        expect(saved_row.locator('[data-kin-revision="1"]')).to_contain_text('Characteristics (병변 특성): '+traits)
        expect(saved_row.locator('[data-kin-revision="1"]')).to_contain_text('연결: 2D 표식 1개 · Saved View 0개 · 3D Point 0개 · v2')
        # An API answer without the schema header: saved records stay visible, nothing can be written.
        def older(route):
            response = route.fetch()
            headers = {k: v for k, v in response.headers.items() if k.lower() != 'x-kin-finding-schema'}
            route.fulfill(response=response, headers=headers)
        p.route('**/api/studies/*/findings?*', older)
        panel = self.panel(p); panel.get_by_role('button', name='Reload Findings', exact=True).click()
        expect(panel.locator('#kin-viewer-findings-status')).to_contain_text('서버가 이 화면 판을 지원하지 않아 소견을 저장하지 않습니다')
        expect(panel.get_by_role('button', name='New Finding', exact=True)).to_be_disabled()
        expect(self.saved_row(p, saved['id']).get_by_role('button', name='Edit', exact=True)).to_have_count(0)
        expect(self.saved_row(p, saved['id'])).to_contain_text(traits)
        p.unroute('**/api/studies/*/findings?*', older)
        panel.get_by_role('button', name='Reload Findings', exact=True).click()
        expect(panel.get_by_role('button', name='New Finding', exact=True)).to_be_enabled()
        self.assertEqual((self.state(f), self.versions(f)), report); self.assertEqual(self.hashes(), original)
        self.evidence('S2L-characteristics-history', dict(characteristics=traits, revision=saved['revision']), p)

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(defaultTest=[f'FindingNavigationE2E.{n}' for n in FindingNavigationE2E.__dict__ if n.startswith('test_')], verbosity=2)
