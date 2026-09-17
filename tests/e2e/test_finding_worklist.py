# coding: utf-8
"""TEST-S2B-UI-01..03 (REQ-S2B-LIST/COMMAND/BOUNDARY/PRESERVE): the worklist and Reading Workspace
Image Findings list of the selected study and an explicit Go to Image into the embedded viewer or one
attached separate window, on the real BFF login, pinned OHIF, owned synthetic CT and the real findings
API. Arrival is proven from the viewer's active viewport image id, never from the message. A refused or
superseded command only asserts what holds (no success text, same URL study set, byte-equal rows); the
viewer display may already have moved. Finding draft guards stay in FindingNavigationE2E 05/06."""
import io, re, sys, unittest, uuid
from urllib.parse import parse_qs, urlsplit
from pydicom import dcmread
import test_worklist as base
import test_finding_navigation as navigation
from test_viewer_history import expect, literal, synthetic_ct
from viewer_precision_support import hook

ACTIVE = "()=>{const s=__d05c1.services;return s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getActiveViewportId())?.getCurrentImageId?.()||''}"
SHOWS = "sop=>{const s=__d05c1.services;return !!s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getActiveViewportId())?.getCurrentImageId?.().includes('/instances/'+sop+'/frames/1')}"
SET_INDEX = "i=>{const s=__d05c1.services;return s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getActiveViewportId()).setImageIdIndex(i)}"
# The test owns the image load of the active viewport so a command can be held in flight.
HOLD = """()=>{const s=__d05c1.services;const v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getActiveViewportId());
  const own=Object.getOwnPropertyDescriptor(v,'setImageIdIndex'),original=v.setImageIdIndex;window.__held=[];
  window.__unhold=()=>{if(own)Object.defineProperty(v,'setImageIdIndex',own);else delete v.setImageIdIndex;window.__unhold=null;};
  v.setImageIdIndex=function(i){return new Promise((resolve,reject)=>window.__held.push(()=>original.call(v,i).then(resolve,reject)));};}"""
HELD = "n=>(window.__held||[]).length===n"
RELEASE_ONE = "()=>{const q=window.__held||[];const next=q.shift();if(!q.length&&window.__unhold)window.__unhold();if(next)next();return !!next}"
READY = "uid=>{const h=window.kinViewerHistoryState?.();return !!h&&(uid===null?!!h.scope:h.scope===uid)&&!h.suspended&&!h.ended}"
MODAL = "()=>{const d=document.createElement('dialog');d.id='s2b-modal';d.textContent='S2-B modal';document.body.append(d);d.showModal()}"
ENDED = "()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}"
OWNED_TABLES = ('Finding', 'FindingRevision', 'ViewerItem', 'ViewerRevision', 'Report', 'ReportDraft', 'ReportVersion')


class FindingWorklistE2E(navigation.FindingNavigationE2E):
    # ---- fixtures: every source is created through the product API -------------------------
    def dicom(self, f):
        found = self.stack._orthanc_request('POST', '/tools/lookup', f.uid.encode())
        study = next(x['ID'] for x in found.body if x['Type'] == 'Study')
        raws = [self.stack.orthanc_bytes('/instances/'+i['ID']+'/file') for i in self.stack._orthanc_request('GET', '/studies/'+study+'/instances').body]
        return sorted((dcmread(io.BytesIO(raw)) for raw in raws), key=lambda ds: int(ds.InstanceNumber))

    def post(self, path, body):
        r = self.stack.request('POST', path, 'doctor', body); self.assertEqual(r.status, 200, r.text); return r.body

    def seed(self, f):
        """A length on slice 0, a key image on slice 1, one visible and one hidden finding."""
        slices = self.dicom(f); ds, key_ds = slices[0], slices[1]; ipp = [float(x) for x in ds.ImagePositionPatient]
        length = self.post('/studies/'+f.uid+'/viewer-items', dict(requestId=str(uuid.uuid4()), item=dict(
            schemaVersion=1, kind='length', seriesUid=str(ds.SeriesInstanceUID), sopUid=str(ds.SOPInstanceUID), frame=1,
            frameOfReferenceUid=str(ds.FrameOfReferenceUID), label='길이', points=[[ipp[0]+10, ipp[1]+10, ipp[2]], [ipp[0]+30, ipp[1]+10, ipp[2]]],
            viewPlaneNormal=[0, 0, 1], viewUp=[0, 1, 0], baseline=dict(calculator='kin-native-manual-v1', values=[20.0]))))
        key = self.post('/studies/'+f.uid+'/viewer-items', dict(requestId=str(uuid.uuid4()), item=dict(
            schemaVersion=1, kind='key', seriesUid=str(key_ds.SeriesInstanceUID), sopUid=str(key_ds.SOPInstanceUID), frame=1, title='키 영상', description='')))
        pairs = [dict(itemId=h['id'], revision=h['revision']) for h in (length, key)]
        shown = self.post('/studies/'+f.uid+'/findings', dict(requestId=str(uuid.uuid4()), item=dict(
            schemaVersion=1, title='우엽 결절 <img src=x onerror="window.bad=1">', text='목록 확인 본문', primary=0, sources=pairs)))
        hidden = self.post('/studies/'+f.uid+'/findings', dict(requestId=str(uuid.uuid4()), item=dict(
            schemaVersion=1, title='숨긴 소견', text='', primary=0, sources=pairs[1:])))
        hidden = self.post('/studies/'+f.uid+'/findings/'+hidden['id']+'/revisions', dict(requestId=str(uuid.uuid4()), expectedRevision=1,
            action='hide', reason='목록 숨김 확인', item=dict(schemaVersion=1, title='숨긴 소견', text='', primary=0, sources=pairs[1:])))
        self.assertEqual([s['sopUid'] for s in shown['item']['sources']], [str(ds.SOPInstanceUID), str(key_ds.SOPInstanceUID)])
        return shown, hidden

    def owned_rows(self, *fixtures):
        result = {}
        for f in fixtures:
            uid = literal(f.uid)
            where = {'Finding': f'"studyUid"={uid}', 'FindingRevision': f'"findingId" IN (SELECT id FROM "Finding" WHERE "studyUid"={uid})',
                     'ViewerItem': f'"studyUid"={uid}', 'ViewerRevision': f'"itemId" IN (SELECT id FROM "ViewerItem" WHERE "studyUid"={uid})',
                     'Report': f'uid={uid}', 'ReportDraft': f'uid={uid}', 'ReportVersion': f'uid={uid}'}
            result[f.uid] = {t: base.psql(f'SELECT to_jsonb(t)::text FROM "{t}" t WHERE {where[t]} ORDER BY to_jsonb(t)::text COLLATE "C"') for t in OWNED_TABLES}
        return result

    # ---- worklist and viewer helpers --------------------------------------------------------
    def observe(self, w):
        def config(r):
            a = r.fetch(); r.fulfill(response=a, body=a.text()+'\n'+hook)
        w.context.route('**/ohif/app-config.js', config)

    def open_findings(self, w, f):
        panel = w.locator('#reading-findings')
        if not panel.is_visible(): w.locator('#reading-findings-open').click()
        expect(panel).to_be_visible()
        expect(w.locator('#reading-findings-open')).to_have_attribute('aria-expanded', 'true')
        expect(panel).to_have_attribute('data-study-uid', f.uid)
        expect(panel).to_have_attribute('data-state', 'ready', timeout=20000)
        return panel

    def close_findings(self, w):
        if w.locator('#reading-findings').is_visible():
            w.locator('#reading-findings').get_by_role('button', name='Close Image Findings', exact=True).click()
        expect(w.locator('#reading-findings')).to_be_hidden()

    def row(self, w, finding_id):
        return w.locator('#reading-findings article[data-finding-id="'+finding_id+'"]')

    def go(self, w, finding_id, index):
        self.row(w, finding_id).locator('[data-kin-sources] > li').nth(index).get_by_role('button', name='Go to Image', exact=True).click()

    def result(self, w, state):
        nav = w.locator('#reading-findings-nav')
        expect(nav).to_have_attribute('data-result', state, timeout=20000)
        return nav

    def target(self, w, state):
        expect(w.locator('#reading-findings-target')).to_have_attribute('data-target', state, timeout=20000)

    def away(self, p, index, sop):
        p.evaluate(SET_INDEX, index)
        p.wait_for_function('sop=>!(' + SHOWS + ')(sop)', arg=sop)

    def window_ready(self, p):
        studies = self.viewer_ready(p)
        p.wait_for_function("()=>typeof kinViewerWindowOwner==='function'&&!!kinViewerWindowOwner()")
        p.wait_for_function(READY, arg=None)
        return studies

    def separate(self, w, f):
        self.close_findings(w)
        self.select(w, f)
        with w.context.expect_page() as opened: w.locator('#m-filmbox').click()
        p = opened.value; p.on('dialog', lambda d: d.accept())
        p.wait_for_url('**/ohif/viewer?**', timeout=60000)
        return p, self.window_ready(p)

    def studies(self, page_or_frame):
        return parse_qs(urlsplit(page_or_frame.url).query)['StudyInstanceUIDs'][0].split(',')

    # ---- H1 + list states ---------------------------------------------------------------------
    def test_worklist_01_embedded_list_states_exact_frame_and_refusals(self):
        f = self.specimen(slices=4); self.seed_report(f)
        shown, hidden = self.seed(f); sops = self.sops(f)
        original, rows = self.hashes(), self.owned_rows(f)
        w = self.login(); w.set_viewport_size(dict(width=1680, height=1100)); self.observe(w)
        w.on('dialog', lambda d: d.accept())
        self.select(w, f)
        # List mode without a viewer: a read-only list, no navigation, Open Image offered, no new page.
        panel = self.open_findings(w, f)
        expect(panel.locator('article')).to_have_count(1)
        article = self.row(w, shown['id'])
        expect(article).to_contain_text('우엽 결절 <img src=x onerror="window.bad=1">')
        expect(article.locator('img')).to_have_count(0); self.assertIsNone(w.evaluate('()=>window.bad'))
        expect(article).to_contain_text('Length · 길이 · 프레임 1 · r1 · 20.0')
        expect(article).to_contain_text('Key Image · 키 영상 · 프레임 1 · r1')
        expect(article.locator('[data-kin-link-state]')).to_have_text(['Current', 'Current'])
        expect(panel).to_contain_text('영상 원본 확인 결과가 아닙니다'); expect(panel).not_to_contain_text('Verified')
        for name in ['Save', 'Edit', 'Hide', 'Restore', 'New Finding', 'Refresh Link']:
            expect(panel.get_by_role('button', name=name, exact=True)).to_have_count(0)
        self.target(w, 'no-viewer')
        pages = len(w.context.pages)
        self.go(w, shown['id'], 0)
        self.result(w, 'no-viewer')
        expect(panel.get_by_role('button', name='Open Image', exact=True)).to_be_visible()
        self.assertEqual(len(w.context.pages), pages)
        panel.get_by_label('Show Hidden').check()
        expect(panel.locator('article')).to_have_count(2)
        expect(self.row(w, hidden['id'])).to_contain_text('Hidden'); expect(self.row(w, hidden['id'])).to_have_attribute('data-hidden', 'true')
        panel.get_by_label('Show Hidden').uncheck()
        expect(panel.locator('article')).to_have_count(1)
        # Reading Workspace: the embedded viewer is the target.
        self.close_findings(w)
        frame = self.workspace(w, f)
        panel = self.open_findings(w, f)
        self.target(w, 'embedded')
        before, url = (self.state(f), self.versions(f)), frame.url
        self.away(frame, 3, sops[0])
        self.go(w, shown['id'], 0)
        frame.wait_for_function(SHOWS, arg=sops[0])
        nav = self.result(w, 'ok'); expect(nav).to_contain_text('영상 이동 확인 · 통합 작업공간')
        self.assertEqual(w.evaluate('()=>document.activeElement?.id'), 'reading-frame')
        self.away(frame, 3, sops[1])
        self.go(w, shown['id'], 1)
        frame.wait_for_function(SHOWS, arg=sops[1])
        expect(self.result(w, 'ok')).to_contain_text('키 이미지 프레임으로 이동했습니다')
        self.away(frame, 2, sops[0])
        self.row(w, shown['id']).get_by_role('button', name='Go to Primary Image', exact=True).click()
        frame.wait_for_function(SHOWS, arg=sops[0])
        # A viewer dialog refuses before the call; Retry after closing it arrives.
        frame.evaluate(MODAL)
        self.away(frame, 3, sops[0])
        shown_before = frame.evaluate(ACTIVE)
        self.go(w, shown['id'], 0)
        expect(self.result(w, 'modal')).to_contain_text('대화상자')
        self.assertEqual(frame.evaluate(ACTIVE), shown_before)
        frame.evaluate("()=>document.getElementById('s2b-modal').remove()")
        panel.get_by_role('button', name='Retry Go to Image', exact=True).click()
        frame.wait_for_function(SHOWS, arg=sops[0]); self.result(w, 'ok')
        # 403/404 and 503 clear the shown rows with their own text; an authorized reload restores them.
        listing = lambda url: '/api/studies/'+f.uid+'/findings?' in url and 'includeHidden=false' in url
        for status, state, text in [(403, 'denied', '볼 수 없습니다'), (404, 'denied', '볼 수 없습니다'), (503, 'failed', '확인하지 못했습니다')]:
            # Playwright passes (route, request); the bound status comes after both.
            def refuse(r, request, status=status): r.fulfill(status=status, content_type='application/json', body='{"message":"synthetic"}')
            w.route(listing, refuse)
            panel.get_by_role('button', name='Reload Findings', exact=True).click()
            expect(panel).to_have_attribute('data-state', state); expect(panel.locator('article')).to_have_count(0)
            expect(w.locator('#reading-findings-status')).to_contain_text(text)
            w.unroute(listing, refuse)
            panel.get_by_role('button', name='Reload Findings', exact=True).click()
            expect(panel).to_have_attribute('data-state', 'ready'); expect(panel.locator('article')).to_have_count(1)
        self.assertEqual(self.studies(frame), [f.uid]); self.assertEqual(frame.url, url)
        self.assertEqual((self.state(f), self.versions(f)), before)
        self.assertEqual(self.owned_rows(f), rows); self.assertEqual(self.hashes(), original)

    # ---- H2 -----------------------------------------------------------------------------------
    def test_worklist_02_separate_windows_ambiguous_owner_unattached_reattach_and_close(self):
        f = self.specimen(slices=3); shown, _ = self.seed(f); sops = self.sops(f)
        original, rows = self.hashes(), self.owned_rows(f)
        w = self.login(); self.observe(w); w.on('dialog', lambda d: d.accept())
        w.locator('#image-opening-open').click(); expect(w.locator('#image-opening-dialog')).to_be_visible()
        w.locator('#image-opening-limit').select_option('2'); w.locator('#image-opening-done').click()
        expect(w.locator('#image-opening-dialog')).to_be_hidden()
        one, studies = self.separate(w, f); self.assertEqual(studies, [f.uid])
        panel = self.open_findings(w, f)
        self.target(w, 'window'); expect(w.locator('#reading-findings-target')).to_have_text('이동 대상: 영상 창 1')
        url = one.url
        self.away(one, 2, sops[0])
        self.go(w, shown['id'], 0)
        one.wait_for_function(SHOWS, arg=sops[0])
        expect(self.result(w, 'ok')).to_contain_text('영상 이동 확인 · 영상 창 1')
        self.assertEqual(one.url, url)
        # Another account's window is never commanded.
        one.evaluate("()=>{window.__realOwner=kinViewerWindowOwner;window.kinViewerWindowOwner=()=>'[\"other\",\"owner\"]'}")
        self.away(one, 2, sops[1]); image = one.evaluate(ACTIVE)
        self.go(w, shown['id'], 1); self.result(w, 'owner')
        self.assertEqual(one.evaluate(ACTIVE), image)
        one.evaluate("()=>{window.kinViewerWindowOwner=window.__realOwner}")
        # A second window of the same study makes the target ambiguous; neither window moves.
        self.close_findings(w)
        w.locator('#viewer-windows-open').click(); expect(w.locator('#viewer-windows-dialog')).to_be_visible()
        latest = w.locator('[data-window-index="0"][data-window-action="latest"]'); expect(latest).to_be_enabled(timeout=15000)
        with w.context.expect_page() as opened: latest.click()
        two = opened.value; two.on('dialog', lambda d: d.accept())
        two.wait_for_url('**/ohif/viewer?**', timeout=60000)
        self.assertEqual(self.window_ready(two), [f.uid])
        w.locator('#viewer-windows-done').click(); expect(w.locator('#viewer-windows-dialog')).to_be_hidden()
        panel = self.open_findings(w, f)
        self.target(w, 'ambiguous')
        self.away(two, 2, sops[1])
        images = [one.evaluate(ACTIVE), two.evaluate(ACTIVE)]
        self.go(w, shown['id'], 1); self.result(w, 'ambiguous')
        self.assertEqual([one.evaluate(ACTIVE), two.evaluate(ACTIVE)], images)
        two.close()
        self.target(w, 'window')
        self.go(w, shown['id'], 1)
        one.wait_for_function(SHOWS, arg=sops[1]); self.result(w, 'ok')
        # After a worklist reload the window is known only by address: unattached until Open Image re-attaches it.
        one.evaluate("()=>{window.__s2bMarker='kept'}")
        w.reload(); expect(w.locator('#dbstat')).to_contain_text('DB Connected')
        self.select(w, f)
        panel = self.open_findings(w, f)
        self.target(w, 'unattached')
        self.go(w, shown['id'], 0)
        self.result(w, 'unattached')
        open_image = panel.get_by_role('button', name='Open Image', exact=True); expect(open_image).to_be_visible()
        pages = len(w.context.pages)
        open_image.click()
        self.result(w, 'opening'); self.target(w, 'window')
        self.assertEqual(len(w.context.pages), pages); self.assertEqual(one.evaluate('()=>window.__s2bMarker'), 'kept')
        self.assertTrue(one.evaluate(SHOWS, sops[1]), 'Open Image did not navigate')
        self.go(w, shown['id'], 0)
        one.wait_for_function(SHOWS, arg=sops[0]); self.result(w, 'ok')
        # A closed window leaves no target.
        one.close()
        self.target(w, 'no-viewer')
        self.go(w, shown['id'], 0); self.result(w, 'no-viewer')
        self.assertEqual(self.owned_rows(f), rows); self.assertEqual(self.hashes(), original)

    # ---- H3 -----------------------------------------------------------------------------------
    def test_worklist_03_scope_selection_newest_renavigation_open_image_and_session_end(self):
        f = self.specimen(slices=3)
        prior = synthetic_ct(self.stack, f.patient_id, 'wlprior', '20260801', [0, 0, 0], [1, 0, 0, 0, 1, 0], [.7, 1.3], slices=2)
        other = self.specimen(slices=2)
        shown, _ = self.seed(f); sops = self.sops(f)
        original, rows = self.hashes(), self.owned_rows(f, prior, other)
        w = self.login(); self.observe(w); w.on('dialog', lambda d: d.accept())
        p, studies = self.separate(w, f); self.assertEqual(studies, [f.uid, prior.uid])
        panel = self.open_findings(w, f)
        # The viewer stays the scope authority: the prior's viewport is active, nothing moves.
        self.activate(p, prior.uid); p.wait_for_function(READY, arg=prior.uid)
        image = p.evaluate(ACTIVE)
        self.go(w, shown['id'], 0)
        expect(self.result(w, 'scope')).to_contain_text('이 검사의 영상 칸을 선택')
        self.assertEqual(p.evaluate(ACTIVE), image)
        self.activate(p, f.uid); p.wait_for_function(READY, arg=f.uid)
        p.evaluate(MODAL); self.go(w, shown['id'], 0); self.result(w, 'modal')
        p.evaluate("()=>document.getElementById('s2b-modal').remove()")
        # A selection change during the image load: the list follows the new study, the late answer writes nothing.
        self.away(p, 2, sops[0]); p.evaluate(HOLD)
        self.go(w, shown['id'], 0)
        p.wait_for_function(HELD, arg=1); self.result(w, 'pending')
        self.close_findings(w); self.select(w, other)
        panel = self.open_findings(w, other)
        expect(panel.locator('article')).to_have_count(0)
        expect(w.locator('#reading-findings-nav')).to_have_text('')
        self.assertTrue(p.evaluate(RELEASE_ONE))
        p.wait_for_function(SHOWS, arg=sops[0])  # the viewer may still arrive (review C7)
        w.wait_for_timeout(500)
        expect(w.locator('#reading-findings-nav')).to_have_text('')
        # Two commands in flight: only the newest reports.
        self.close_findings(w); self.select(w, f); panel = self.open_findings(w, f)
        self.away(p, 2, sops[1]); p.evaluate(HOLD)
        self.go(w, shown['id'], 0); p.wait_for_function(HELD, arg=1)
        self.go(w, shown['id'], 1); p.wait_for_function(HELD, arg=2)
        self.assertTrue(p.evaluate(RELEASE_ONE)); p.wait_for_function(SHOWS, arg=sops[0])
        w.wait_for_timeout(500); self.result(w, 'pending')
        self.assertTrue(p.evaluate(RELEASE_ONE)); p.wait_for_function(SHOWS, arg=sops[1])
        expect(self.result(w, 'ok')).to_contain_text('키 이미지 프레임으로 이동했습니다')
        # The window is re-navigated to another study during the load: superseded, never success.
        self.away(p, 2, sops[0]); p.evaluate(HOLD)
        self.go(w, shown['id'], 0); p.wait_for_function(HELD, arg=1)
        elsewhere = self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + other.uid + '#' + urlsplit(p.url).fragment
        p.evaluate('u=>{location.href=u}', elsewhere)
        self.result(w, 'superseded')
        p.wait_for_url(re.compile(r'[?&]StudyInstanceUIDs=' + re.escape(other.uid) + r'(?:[&#]|$)'), timeout=60000)
        self.assertEqual(self.window_ready(p), [other.uid])
        self.target(w, 'no-viewer')
        self.go(w, shown['id'], 0); self.result(w, 'no-viewer')
        self.assertEqual(self.studies(p), [other.uid])
        # Open Image uses the existing single-window reuse; the user presses Go to Image again.
        panel.get_by_role('button', name='Open Image', exact=True).click()
        p.wait_for_url(re.compile(r'[?&]StudyInstanceUIDs=' + re.escape(f.uid) + r'(?:[,&#]|$)'), timeout=60000)
        self.assertEqual(self.window_ready(p), [f.uid, prior.uid])
        self.activate(p, f.uid); p.wait_for_function(READY, arg=f.uid)
        self.target(w, 'window')
        # Session end during the load: rows and message clear at once and nothing late is shown.
        self.away(p, 2, sops[0]); p.evaluate(HOLD)
        self.go(w, shown['id'], 0); p.wait_for_function(HELD, arg=1)
        w.evaluate(ENDED)
        expect(panel).to_have_attribute('data-state', 'ended'); expect(panel.locator('article')).to_have_count(0)
        expect(w.locator('#reading-findings-open')).to_be_disabled()
        self.assertTrue(p.evaluate(RELEASE_ONE)); w.wait_for_timeout(500)
        expect(w.locator('#reading-findings-nav')).to_have_text(''); expect(panel.locator('article')).to_have_count(0)
        self.assertEqual(self.owned_rows(f, prior, other), rows); self.assertEqual(self.hashes(), original)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(defaultTest=[f'FindingWorklistE2E.{n}' for n in FindingWorklistE2E.__dict__ if n.startswith('test_')], verbosity=2)
