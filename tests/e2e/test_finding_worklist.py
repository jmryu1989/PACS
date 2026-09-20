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
# S2-V: the frozen copies read with names and units; the ellipse numbers are API-seeded, never recomputed.
ELLIPSE_VALUES = [400.26, 45.0, -20.0, 80.0, 1234]
LENGTH_TEXT = '★ Length · 길이 · 프레임 1 · r1 · 20.0 mm · Current'
ELLIPSE_TEXT = 'Ellipse ROI · 타원 · 프레임 1 · r1 · 면적 400.3 mm² · 평균 45.0 HU · 최소 -20.0 HU · 최대 80.0 HU · 화소 수 1234 · Current'


class FindingWorklistE2E(navigation.FindingNavigationE2E):
    # ---- fixtures: every source is created through the product API -------------------------
    def dicom(self, f):
        found = self.stack._orthanc_request('POST', '/tools/lookup', f.uid.encode())
        study = next(x['ID'] for x in found.body if x['Type'] == 'Study')
        raws = [self.stack.orthanc_bytes('/instances/'+i['ID']+'/file') for i in self.stack._orthanc_request('GET', '/studies/'+study+'/instances').body]
        return sorted((dcmread(io.BytesIO(raw)) for raw in raws), key=lambda ds: int(ds.InstanceNumber))

    def post(self, path, body):
        r = self.stack.request('POST', path, 'doctor', body); self.assertEqual(r.status, 200, r.text); return r.body

    def length_at(self, f, ds, label, extent):
        ipp = [float(x) for x in ds.ImagePositionPatient]
        return self.post('/studies/'+f.uid+'/viewer-items', dict(requestId=str(uuid.uuid4()), item=dict(
            schemaVersion=1, kind='length', seriesUid=str(ds.SeriesInstanceUID), sopUid=str(ds.SOPInstanceUID), frame=1,
            frameOfReferenceUid=str(ds.FrameOfReferenceUID), label=label, points=[[ipp[0]+10, ipp[1]+10, ipp[2]], [ipp[0]+10+extent, ipp[1]+10, ipp[2]]],
            viewPlaneNormal=[0, 0, 1], viewUp=[0, 1, 0], baseline=dict(calculator='kin-native-manual-v1', values=[float(extent)]))))

    def seed(self, f, ellipse=False):
        """A length on slice 0, a key image on slice 1, one visible and one hidden finding. `ellipse` adds an
        axis-aligned API ellipse on slice 0 as the visible finding's third source (S2-V value names and units)."""
        slices = self.dicom(f); ds, key_ds = slices[0], slices[1]; ipp = [float(x) for x in ds.ImagePositionPatient]
        length = self.length_at(f, ds, '길이', 20)
        key = self.post('/studies/'+f.uid+'/viewer-items', dict(requestId=str(uuid.uuid4()), item=dict(
            schemaVersion=1, kind='key', seriesUid=str(key_ds.SeriesInstanceUID), sopUid=str(key_ds.SOPInstanceUID), frame=1, title='키 영상', description='')))
        heads = [length, key]
        if ellipse:
            # Bottom/top then left/right handles around one centre, both axes on the image axes (server rule).
            cx, cy, z = ipp[0]+60, ipp[1]+60, ipp[2]
            heads.append(self.post('/studies/'+f.uid+'/viewer-items', dict(requestId=str(uuid.uuid4()), item=dict(
                schemaVersion=1, kind='ellipse', seriesUid=str(ds.SeriesInstanceUID), sopUid=str(ds.SOPInstanceUID), frame=1,
                frameOfReferenceUid=str(ds.FrameOfReferenceUID), label='타원', points=[[cx, cy-10, z], [cx, cy+10, z], [cx-15, cy, z], [cx+15, cy, z]],
                viewPlaneNormal=[0, 0, 1], viewUp=[0, 1, 0], baseline=dict(calculator='kin-native-manual-v1', values=ELLIPSE_VALUES)))))
        pairs = [dict(itemId=h['id'], revision=h['revision']) for h in heads]
        shown = self.post('/studies/'+f.uid+'/findings', dict(requestId=str(uuid.uuid4()), item=dict(
            schemaVersion=1, title='우엽 결절 <img src=x onerror="window.bad=1">', text='목록 확인 본문', primary=0, sources=pairs)))
        hidden = self.post('/studies/'+f.uid+'/findings', dict(requestId=str(uuid.uuid4()), item=dict(
            schemaVersion=1, title='숨긴 소견', text='', primary=0, sources=pairs[1:])))
        hidden = self.post('/studies/'+f.uid+'/findings/'+hidden['id']+'/revisions', dict(requestId=str(uuid.uuid4()), expectedRevision=1,
            action='hide', reason='목록 숨김 확인', item=dict(schemaVersion=1, title='숨긴 소견', text='', primary=0, sources=pairs[1:])))
        self.assertEqual([s['sopUid'] for s in shown['item']['sources']], [str(ds.SOPInstanceUID), str(key_ds.SOPInstanceUID)] + ([str(ds.SOPInstanceUID)] if ellipse else []))
        self.assertEqual([(s['values'], s['calculator']) for s in shown['item']['sources']],
                         [([20.0], 'kin-native-manual-v1'), (None, None)] + ([(ELLIPSE_VALUES, 'kin-native-manual-v1')] if ellipse else []))
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
        shown, hidden = self.seed(f, ellipse=True); sops = self.sops(f)
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
        sources = article.locator('[data-kin-sources] > li')
        expect(sources).to_have_count(3)
        expect(sources.nth(0)).to_contain_text(LENGTH_TEXT)
        expect(sources.nth(1)).to_contain_text('Key Image · 키 영상 · 프레임 1 · r1 · Current')
        expect(sources.nth(2)).to_contain_text(ELLIPSE_TEXT)
        expect(article).not_to_contain_text('단위 미확인')
        expect(article.locator('[data-kin-link-state]')).to_have_text(['Current', 'Current', 'Current'])
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
        # The viewer's Findings section shows the same frozen copies with the same names and units.
        copies = frame.locator('#kin-viewer-findings article[data-finding-id="'+shown['id']+'"] [data-kin-sources] [data-item-id]')
        expect(copies).to_have_count(3)
        expect(copies.nth(0)).to_contain_text(LENGTH_TEXT); expect(copies.nth(2)).to_contain_text(ELLIPSE_TEXT)
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

    # ---- S2-B2 H4: a comparison source through the worklist ------------------------------------
    def test_worklist_04_comparison_source_exact_frame_refused_reload_pinned_retry_and_withdrawal(self):
        f = self.specimen(slices=2)
        prior = synthetic_ct(self.stack, f.patient_id, 'wlcompare', '20250917', [0, 0, 0], [1, 0, 0, 0, 1, 0], [.7, 1.3], slices=3)
        shown, _ = self.seed(f)
        label = '워크리스트 비교 키 '+uuid.uuid4().hex[:8]
        pk = self.key_at(prior, 1, label); prior_sops = self.sops(prior)
        # A comparison length copy whose numbers must leave with the withdrawn study (S2-V).
        prior_label = '워크리스트 비교 길이 '+uuid.uuid4().hex[:8]
        pl = self.length_at(prior, self.dicom(prior)[0], prior_label, 31)
        cross = self.post('/studies/'+f.uid+'/findings', dict(requestId=str(uuid.uuid4()), item=dict(schemaVersion=1, title='비교 원본 소견', text='워크리스트 비교',
            primary=1, sources=[dict(itemId=shown['item']['sources'][0]['itemId'], revision=1), dict(itemId=pk['id'], revision=1), dict(itemId=pl['id'], revision=1)])))
        self.assertEqual([s['studyUid'] for s in cross['item']['sources']], [f.uid, prior.uid, prior.uid])
        original, rows = self.hashes(), self.owned_rows(f, prior)
        w = self.login(); self.observe(w); w.on('dialog', lambda d: d.accept())
        p, studies = self.separate(w, f); self.assertEqual(studies, [f.uid, prior.uid])
        panel = self.open_findings(w, f)
        item = self.row(w, cross['id']).locator('[data-kin-sources] > li')
        expect(item.nth(0)).to_have_attribute('data-source-study', 'current'); expect(item.nth(1)).to_have_attribute('data-source-study', 'comparison')
        expect(item.nth(1)).to_contain_text('비교 검사 영상')
        expect(item.nth(0)).to_contain_text('Length · 길이 · 프레임 1 · r1 · 20.0 mm · Current')
        expect(item.nth(2)).to_have_attribute('data-source-study', 'comparison')
        expect(item.nth(2)).to_contain_text('Length · '+prior_label+' · 프레임 1 · r1 · 31.0 mm · Current')
        vx, vp = self.viewport_of(p, f.uid), self.viewport_of(p, prior.uid)
        self.select_viewport(p, vx, f.uid)
        self.scroll_viewport(p, vp, 0, prior_sops[1])
        x_image = p.evaluate(navigation.IMAGE_OF, vx)
        p.evaluate(navigation.RECORD_NAVIGATION)
        target = dict(studyUid=prior.uid, seriesUid=pk['item']['seriesUid'], sopUid=prior_sops[1], frame=1, itemId=pk['id'])
        # From the selected study's viewport the comparison source lands on its exact SOP/frame in that one window.
        self.go(w, cross['id'], 1)
        expect(self.result(w, 'ok')).to_have_text('영상 이동 확인 · 영상 창 1 · 비교 검사 영상 칸 · 키 이미지 프레임으로 이동했습니다.')
        arrived = dict(active=p.evaluate(navigation.ACTIVE_ID), history=p.evaluate(navigation.HISTORY_IMAGE), image=p.evaluate(navigation.IMAGE_OF, vp),
                       first=p.evaluate(navigation.IMAGE_OF, vx), bar=p.evaluate(navigation.BAR, vp), sent=p.evaluate('()=>window.__navs'))
        self.assertEqual((arrived['active'], arrived['history']['scope'], arrived['history']['image']),
                         (vp, prior.uid, dict(study=prior.uid, seriesUid=target['seriesUid'], sopUid=prior_sops[1], frame=1)))
        self.assertIn('/instances/'+prior_sops[1]+'/frames/1', arrived['image']); self.assertEqual(arrived['first'], x_image)
        self.assertEqual((arrived['bar'], arrived['sent']), (18, [target]))
        self.evidence('S2B2-worklist-comparison-navigation', dict(window=studies, target=target, arrived=arrived), p)
        # Forced failure: the comparison history reload is refused after activation. Busy, no call, no viewport restore.
        self.select_viewport(p, vx, f.uid); self.scroll_viewport(p, vp, 0, prior_sops[1])
        refused_reads = []
        def unavailable(r):
            refused_reads.append(r.request.url); r.fulfill(status=503, content_type='application/json', body='{"message":"synthetic unavailable"}')
        items = '**/studies/'+prior.uid+'/viewer-items?*'
        p.route(items, unavailable)
        self.go(w, cross['id'], 1)
        nav = self.result(w, 'busy')
        expect(nav).to_contain_text('원본 프레임으로는 이동하지 않았습니다'); expect(nav).not_to_contain_text('영상 이동 확인')
        self.assertTrue(any('includeHidden=true' in u for u in refused_reads), refused_reads)
        self.assertEqual((p.evaluate(navigation.ACTIVE_ID), p.evaluate('()=>window.__navs.length')), (vp, 1))
        self.assertNotIn('/instances/'+prior_sops[1]+'/', p.evaluate(navigation.IMAGE_OF, vp))
        retry = panel.get_by_role('button', name='Retry Go to Image', exact=True); expect(retry).to_be_visible()
        p.unroute(items, unavailable)
        # The user selects the first study again; Retry replays exactly the pinned comparison source through activation.
        self.select_viewport(p, vx, f.uid)
        retry.click()
        self.result(w, 'ok')
        self.assertEqual(p.evaluate('()=>window.__navs'), [target, target])
        self.assertEqual(p.evaluate(navigation.ACTIVE_ID), vp)
        self.assertIn('/instances/'+prior_sops[1]+'/frames/1', p.evaluate(navigation.IMAGE_OF, vp))
        # The comparison study is withdrawn: the reloaded list has no row and no text of it.
        restore = self.withdraw(prior.uid)
        panel.get_by_role('button', name='Reload Findings', exact=True).click()
        expect(self.row(w, cross['id'])).to_have_count(0); expect(self.row(w, shown['id'])).to_have_count(1)
        text = panel.inner_text()
        for secret in [label, prior_sops[1], pk['id'], '비교 원본 소견', '비교 검사 영상(', prior_label, pl['id'], '31.0 mm']: self.assertNotIn(secret, text)
        self.assertIn('20.0 mm', text)
        restore()
        panel.get_by_role('button', name='Reload Findings', exact=True).click()
        expect(self.row(w, cross['id'])).to_have_count(1)
        self.assertEqual(self.owned_rows(f, prior), rows); self.assertEqual(self.hashes(), original)

    # ---- S2-L2b saved locations from the worklist -----------------------------------------------------
    # ---- S3-U2b: the one real-stack pass from the panel through the server into the report -----
    def citations(self, f, actor='doctor'):
        r = self.stack.request('GET', '/studies/'+f.uid+'/report/citations', actor)
        self.assertEqual(r.status, 200, r.text)
        return r.body

    def stack_job(self, f, ds, title):
        """A version 1 saved view of one slice of `f`, through the product Job API."""
        z = float(ds.ImagePositionPatient[2])
        cell = dict(study=f.uid, series=str(ds.SeriesInstanceUID), sop=str(ds.SOPInstanceUID), frame=1,
                    camera=dict(focalPoint=[128, 128, z], position=[128, 128, z+1000], viewUp=[0, -1, 0], viewPlaneNormal=[0, 0, 1], parallelScale=128,
                                rotation=0, flipHorizontal=False, flipVertical=False),
                    properties=dict(voiRange=dict(lower=-1000, upper=-1), VOILUTFunction='LINEAR', invert=False))
        job = self.post('/studies/'+f.uid+'/viewer-jobs', dict(id=str(uuid.uuid4()), title=title, description='',
                        snapshot=dict(version=1, studies=[f.uid], rows=1, cols=1, active=0, cells=[cell])))
        self.addCleanup(self.clear_jobs, f)
        return job

    def clear_jobs(self, f):
        for raw in base.psql(f'SELECT to_jsonb(j)::text FROM "ViewerJob" j WHERE "studyUid"={literal(f.uid)}'):
            job_id = re.search(r'"id": "([0-9a-f-]{36})"', raw).group(1)
            base.psql(f'''BEGIN; DELETE FROM "ViewerJobRevision" WHERE "jobId"={literal(job_id)}::uuid; DELETE FROM "ViewerJob" WHERE id={literal(job_id)}::uuid; COMMIT;''')

    def test_worklist_05_saved_view_characteristics_exact_viewer_restore_and_refusals(self):
        f = self.specimen(slices=4); self.seed_report(f)
        slices = self.dicom(f); sops = self.sops(f)
        length = self.length_at(f, slices[0], '길이', 20)
        job = self.stack_job(f, slices[2], '세 번째 단면 위치')
        created = self.post('/studies/'+f.uid+'/findings', dict(requestId=str(uuid.uuid4()), item=dict(schemaVersion=2, title='위치 연결 소견',
            text='', characteristics='분엽상 경계 <b>', primary=1, sources=[dict(itemId=length['id'], revision=1), dict(jobId=job['id'], revision=1)])))
        self.assertEqual(created['item']['sources'][1]['kind'], 'job')
        original, rows = self.hashes(), self.owned_rows(f)
        w = self.login(); w.set_viewport_size(dict(width=1680, height=1100)); self.observe(w)
        w.on('dialog', lambda d: d.accept())
        self.select(w, f)
        panel = self.open_findings(w, f)
        article = self.row(w, created['id'])
        expect(article.locator('[data-kin-characteristics]')).to_have_text('Characteristics (병변 특성): 분엽상 경계 <b>')
        expect(article.locator('b')).to_have_count(0)
        location = article.locator('[data-kin-sources] > li[data-job-id="'+job['id']+'"]')
        expect(location).to_have_attribute('data-source-kind', 'view')
        expect(location).to_contain_text('★ Saved View · 세 번째 단면 위치 · v1 · r1 · Current')
        # No viewer shows exactly this study: refused, nothing opened.
        pages = len(w.context.pages)
        location.get_by_role('button', name='Open Saved View', exact=True).click()
        expect(self.result(w, 'saved-view-viewer')).to_contain_text('저장 작업의 검사 조합을 표시하는 영상 화면이 없습니다')
        self.assertEqual(len(w.context.pages), pages)
        # The embedded viewer of exactly [f]: the Job's own panel restores it and the worklist says so.
        self.close_findings(w)
        frame = self.workspace(w, f)
        frame.wait_for_function('()=>window.kinViewerJobLocation?.version===1')
        panel = self.open_findings(w, f)
        self.target(w, 'embedded')
        self.away(frame, 0, sops[2])
        before, url = (self.state(f), self.versions(f)), frame.url
        self.row(w, created['id']).locator('[data-kin-sources] > li[data-job-id="'+job['id']+'"]').get_by_role('button', name='Open Saved View', exact=True).click()
        expect(self.result(w, 'ok')).to_contain_text('저장 위치 확인 · 통합 작업공간 · 저장 화면을 복원했습니다(병변 위치 표식 없음).', timeout=60000)
        frame.wait_for_function(SHOWS, arg=sops[2])
        self.assertEqual(frame.url, url, 'the viewer URL study set is unchanged')
        self.assertEqual((self.state(f), self.versions(f)), before)
        # The Job's title changed: restored with the metadata note; hidden: refused before any screen change.
        renamed = self.stack.request('POST', '/studies/'+f.uid+'/viewer-jobs/'+job['id']+'/revisions', 'doctor',
                                     dict(expectedRevision=1, title='바뀐 제목', description='', hidden=False, reason=''))
        self.assertEqual(renamed.status, 200, renamed.text)
        self.away(frame, 0, sops[2])
        panel.get_by_role('button', name='Reload Findings', exact=True).click()
        location = self.row(w, created['id']).locator('[data-kin-sources] > li[data-job-id="'+job['id']+'"]')
        expect(location.locator('[data-kin-link-state]')).to_have_text('Details Changed')
        location.get_by_role('button', name='Open Saved View', exact=True).click()
        expect(self.result(w, 'ok')).to_contain_text('저장 작업의 제목·설명만 연결 이후 바뀌었고(현재 r2)', timeout=60000)
        hidden = self.stack.request('POST', '/studies/'+f.uid+'/viewer-jobs/'+job['id']+'/revisions', 'doctor',
                                    dict(expectedRevision=2, title='바뀐 제목', description='', hidden=True, reason='숨김 확인'))
        self.assertEqual(hidden.status, 200, hidden.text)
        self.away(frame, 0, sops[2])
        shown = frame.evaluate(ACTIVE)
        location.get_by_role('button', name='Open Saved View', exact=True).click()
        expect(self.result(w, 'job-hidden')).to_contain_text('영상은 바꾸지 않았습니다')
        self.assertEqual(frame.evaluate(ACTIVE), shown)
        # Navigation wrote no finding, item, job revision or report row.
        self.assertEqual(self.owned_rows(f), rows); self.assertEqual(self.hashes(), original)
        self.assertEqual(base.psql(f'SELECT count(*) FROM "ViewerJobRevision" WHERE "jobId"={literal(job["id"])}::uuid'), ['3'])

    def test_worklist_06_insert_into_report_attests_on_the_server_and_a_stale_finding_changes_nothing(self):
        """S3-U2b: the seams only a real stack executes - the panel's row bytes against the server's
        line-block validator, expectedLinkState/expectedHeadRevision against the server's own
        recomputation, the `inserted` and dedicated-read shapes, the route and the CSRF header.
        The late-answer and ordering races stay on the stubbed DOM harness, which can hold a reply;
        a real stack cannot."""
        f = self.specimen(slices=3); self.seed_report(f)
        shown, _ = self.seed(f)
        pairs = [dict(itemId=s['itemId'], revision=s['revision']) for s in shown['item']['sources']]
        # R5's one template: the finding's own title and text, in that order, nothing added.
        block = shown['item']['title'] + '\n' + shown['item']['text']
        w = self.login(); self.observe(w); w.on('dialog', lambda d: d.accept())
        self.select(w, f)
        expect(w.locator('#findings')).to_have_value(f.secret)
        panel = self.open_findings(w, f)
        source = self.row(w, shown['id']).locator('[data-kin-sources] > li').nth(0)
        source.get_by_role('button', name='Insert into Report', exact=True).click()
        pane = w.locator('#cite-preview')
        expect(pane).to_be_visible()
        # What the person reads is what will be requested, appended and attested.
        expect(w.locator('#cite-preview-block')).to_have_text(block)
        expect(w.locator('#cite-preview-field')).to_have_value('findings')
        with w.expect_response(lambda r: r.request.method == 'PUT'
                               and r.url.endswith('/studies/'+f.uid+'/report')) as reply:
            w.locator('#cite-preview-insert').click()
        self.assertEqual(reply.value.status, 200, reply.value.text())
        expect(pane).to_be_hidden()
        expect(w.locator('#findings')).to_have_value(f.secret + '\n' + block)
        answered = reply.value.json()
        self.assertEqual(answered['inserted']['field'], 'findings')
        self.assertNotIn('findings', answered, 'the answer never carries the report body back')
        # The server wrote the attestation: one draft entry, its own cid, the exact bytes.
        read = self.citations(f)
        self.assertEqual([], read['head'])
        self.assertEqual(1, len(read['draft']))
        stored = read['draft'][0]
        self.assertEqual(answered['inserted']['cid'], stored['cid'])
        self.assertEqual((stored['field'], stored['insertedText'], stored['sameTextCount']), ('findings', block, 1))
        self.assertEqual((stored['findingId'], stored['findingRevision'], stored['sourceIndex']), (shown['id'], 1, 0))
        self.assertEqual(stored['linkStateAtInsert'], 'current')
        self.assertEqual(stored['sourceRef']['itemId'], shown['item']['sources'][0]['itemId'])
        for forged in ('calculator', 'values', 'studyUid', 'seriesUid', 'sopUid', 'frame'):
            self.assertNotIn(forged, stored['sourceRef'], forged)
        # The screen says the sentence is still there, in the neutral wording contract 3 fixes.
        w.locator('#b-cite-list').click()
        expect(w.locator('#citelist')).to_contain_text('넣은 문자열이 이 칸에 그대로 있습니다')
        expect(w.locator('#citelist')).to_contain_text('주변 문장에 대해서는 아무것도 말하지 않습니다')
        expect(w.locator('#citemsg')).to_contain_text('저장된 초안 1건')
        self.assertNotIn(stored['cid'], w.locator('#citelist').inner_text(), 'no internal identifier is rendered')
        # The finding moves to r2 behind the panel's back: the server refuses on the revision it
        # reads now, and nothing the person wrote changes (contract 15, client half).
        revised = self.stack.request('POST', '/studies/'+f.uid+'/findings/'+shown['id']+'/revisions', 'doctor',
                                     dict(requestId=str(uuid.uuid4()), expectedRevision=1, action='edit', reason='',
                                          item=dict(schemaVersion=1, title='바뀐 제목', text='바뀐 본문', primary=0, sources=pairs)))
        self.assertEqual(revised.status, 200, revised.text)
        before_text, before_rows, before_read = w.locator('#findings').input_value(), self.owned_rows(f), self.citations(f)
        source.get_by_role('button', name='Insert into Report', exact=True).click()
        expect(pane).to_be_visible()
        with w.expect_response(lambda r: r.request.method == 'PUT'
                               and r.url.endswith('/studies/'+f.uid+'/report')) as refused:
            w.locator('#cite-preview-insert').click()
        self.assertEqual(refused.value.status, 409)
        self.assertEqual(refused.value.json()['code'], 'REPORT_CITATION_STALE')
        expect(w.locator('#cite-preview-status')).to_contain_text('판독문은 그대로입니다')
        self.assertEqual(w.locator('#findings').input_value(), before_text, 'a refusal changes no byte on screen')
        self.assertEqual(self.owned_rows(f), before_rows, 'and no row on the server')
        self.assertEqual(self.citations(f), before_read)
        w.locator('#cite-preview-close').click(); expect(pane).to_be_hidden()
        # Signing carries the attestation into the version the head now points at.
        self.commit(w, f, '#b-save', 'T')
        signed = self.citations(f)
        self.assertEqual([], signed['draft'], 'the draft row was consumed by the commit')
        self.assertEqual(1, len(signed['head']))
        self.assertEqual(signed['head'][0]['cid'], stored['cid'])
        self.assertEqual(signed['head'][0]['insertedText'], block)
        self.assertEqual(signed['head'][0]['insertedBy'], stored['insertedBy'])
        self.assertEqual(signed['head'][0]['insertedAt'], stored['insertedAt'], 'carried byte for byte')
        self.assertEqual(self.versions(f)[-1]['findings'], before_text)

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(defaultTest=[f'FindingWorklistE2E.{n}' for n in FindingWorklistE2E.__dict__ if n.startswith('test_')], verbosity=2)
