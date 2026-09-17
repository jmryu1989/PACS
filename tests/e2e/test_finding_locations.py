# coding: utf-8
"""TEST-S2L-LOCATIONS (S2-L2a/S2-L2b, hosted volume-path group): saved locations of findings on the real pinned OHIF,
BFF login, run-owned same-patient synthetic CTs and the real findings/Job APIs.

L1 proves first that the Findings section keeps the reading study through the MPR layout (U1), then saves a 3D point on the
comparison study's volume in an [X, P] document (the bounded prior route), links it with characteristics, and reopens it after a
new login from a one-study document: the viewer continues in a new [X, P] page with a one-use nonce and proves the restored Job,
the point and the frame of reference there. L2 covers refusals and states (unsaved mark, an intercepted Job GET 409, a failure
injected after the apply replaced the screen with its verified rollback, a metadata change, a hidden Job, sync off) and the
server's markId/anchor matrix. L3 shows that a same-document restore keeps an unsaved
finding draft and that a withdrawn comparison study withdraws the finding. Nothing here writes a report or an original."""
import io, json, unittest, uuid
from urllib.parse import parse_qs, urlsplit
import pydicom
from playwright.sync_api import expect
from test_volume_marks import VolumeMarksE2E
from test_viewer_history import ViewerHistoryE2E, literal
from test_worklist import psql
from finding_api_test import BOUNDARY_COLUMNS

SCHEMA = {'X-KIN-Finding-Schema': '2'}
FINDINGS = '#kin-viewer-findings'
ACTIVE_VOLUME = """()=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);
 const m=cornerstone.metaData.get('instance',cornerstone.cache.getVolume(v.getVolumeId()).imageIds[0]);return {study:m.StudyInstanceUID,series:m.SeriesInstanceUID,frame:m.FrameOfReferenceUID}}"""
CENTER = """()=>{window.projectionVP=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);
 const volume=cornerstone.cache.getVolume(projectionVP.getVolumeId()),point=Array.from(volume.imageData.indexToWorld(volume.dimensions.map(n=>Math.floor(n/2)))),c=projectionVP.getCamera();
 projectionVP.setCamera({focalPoint:point,position:point.map((n,i)=>n+c.viewPlaneNormal[i]*100)});projectionVP.render();return point}"""
PLANES = "()=>[...services.viewportGridService.getState().viewports.keys()].map(id=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id);return {type:v?.type,camera:v?.getCamera?.()}})"
SHIFT = """()=>{for(const id of services.viewportGridService.getState().viewports.keys()){const view=services.cornerstoneViewportService.getCornerstoneViewport(id),c=view.getCamera(),d=c.viewPlaneNormal.map(n=>n*6);
 view.setCamera({focalPoint:c.focalPoint.map((n,i)=>n+d[i]),position:c.position.map((n,i)=>n+d[i])});view.render()}}"""
USE_STUDY = """uid=>{const set=services.displaySetService.getActiveDisplaySets().find(s=>s.StudyInstanceUID===uid&&s.Modality==='CT');if(!set)throw Error('Missing CT of '+uid);
 services.viewportGridService.setDisplaySetsForViewports([...services.viewportGridService.getState().viewports.keys()].map(viewportId=>({viewportId,displaySetInstanceUIDs:[set.displaySetInstanceUID]})))}"""
LOADED = """uid=>{try{return [...services.viewportGridService.getState().viewports.keys()].every(id=>{const view=services.cornerstoneViewportService.getCornerstoneViewport(id),volume=cornerstone.cache.getVolume(view.getVolumeId());
 return volume?.loadStatus.loaded&&cornerstone.metaData.get('instance',volume.imageIds[0]).StudyInstanceUID===uid})}catch(_){return false}}"""
# The saved-screen reading test_volume_jobs.py uses for its rollback proof, read-only here.
CAPTURE = ('()=>window.kinCreateVolumeJob({grid:services.viewportGridService,cs:services.cornerstoneViewportService,ds:services.displaySetService,'
           'studies:new URLSearchParams(location.search).get("StudyInstanceUIDs").split(",")}).capture(true)')
VIEWPORT_IDS = '()=>[...services.viewportGridService.getState().viewports.keys()]'
# N7: one synthetic failure after a v6 apply has replaced the screen. Its 3D marks step (viewer-volume-job.js) runs only after the
# saved layout, planes and cameras were applied and verified; the wrapper puts the original back before it throws, so the rollback
# re-applies the previous screen with the real capability. Test-only interception of an existing capability, undone in finally.
INJECT_APPLY_FAILURE = """()=>{const marks=window.kinMprMarks,original=marks.restore,state={calls:0,restored:false};
 const undo=()=>{if(marks.restore!==original)marks.restore=original;state.restored=marks.restore===original&&window.kinMprMarks===marks;};
 marks.restore=function(){state.calls++;undo();throw Error('SYNTHETIC APPLY FAILURE AFTER LAYOUT')};
 window.__s2lApplyFailure={state,undo}}"""
UNDO_APPLY_FAILURE = "()=>{const f=window.__s2lApplyFailure;if(!f)return null;f.undo();delete window.__s2lApplyFailure;return f.state}"


class FindingLocationsE2E(VolumeMarksE2E):
    # ---- helpers ------------------------------------------------------------------------------------
    def findings_tab(self, v):
        """The dock's Measurements tab (it holds the Findings section) with an answered findings list."""
        ViewerHistoryE2E.open_measurement_tools(self, v)
        panel = v.locator(FINDINGS)
        expect(panel.locator('#kin-viewer-findings-status')).to_contain_text('개 소견', timeout=45000)
        return panel

    def api_findings(self, f, user='doctor'):
        r = self.stack.bearer_request('GET', '/studies/'+f.uid+'/findings?includeHidden=true', self.stack.token(user), headers=SCHEMA)
        self.assertEqual(r.status, 200, r.text)
        return r.body['items']

    def link(self, f, body, user='doctor'):
        return self.stack.bearer_request('POST', '/studies/'+f.uid+'/findings', self.stack.token(user), body, headers=SCHEMA)

    def revision_rows(self, f):
        return psql(f'''SELECT to_jsonb(r)::text FROM "FindingRevision" r JOIN "Finding" x ON x.id=r."findingId" WHERE x."studyUid"={literal(f.uid)} ORDER BY 1''')

    def prior_point(self, label, sync=True):
        """[X, P] document with the MPR volume of P, one 3D point on it and one saved Job anchored on X."""
        a, b = self.pair(); v = self.login(); self.launch(v, [a, b]); self.ready(v); self.mpr(v); self.choose_volume(v, v, 0)
        if v.evaluate(ACTIVE_VOLUME)['study'] != b.uid:
            v.evaluate(USE_STUDY, b.uid); v.wait_for_function(LOADED, arg=b.uid, timeout=60000); self.choose_volume(v, v, 0)
        point = v.evaluate(CENTER)
        self.tools(v)
        marks = self.add_mark(v, label, point)
        if not sync: self.marks(v).get_by_label('Sync 3D Annotation', exact=True).uncheck(); marks = v.evaluate('()=>kinMprMarks.capture()')
        self.save_volume(v)
        jobs = self.jobs(a)
        job = self.stack.request('GET', f'/studies/{a.uid}/viewer-jobs/{jobs[0]["id"]}', 'doctor').body
        self.assertEqual((job['snapshot']['version'], job['snapshot']['studies'], job['snapshot']['volume']['study']), (6, [a.uid, b.uid], b.uid))
        return a, b, v, job, marks

    def link_point(self, v, label, title, traits, revision=1):
        panel = self.findings_tab(v)
        panel.get_by_role('button', name='New Finding', exact=True).click()
        key = panel.locator('article[data-saved=false]').last.get_attribute('data-row-key')
        row = panel.locator('article[data-row-key="'+key+'"]')
        row.get_by_label('Finding Title').fill(title)
        row.get_by_label('Finding Characteristics', exact=True).fill(traits)
        # The panel offers each unlinked pair once: linking removes that checkbox and shows the source line with Unlink, exactly
        # as the 2D Link Saved Items choices do (test_finding_navigation.compose). So the click is proven by the new state, not by
        # a checkbox that stays checked - Locator.check() waits for that element and cannot pass here (run 35258893346).
        point = row.locator('details[data-kin-locations]').get_by_label('Link 3D Point '+label+' · 저장 작업 r'+str(revision), exact=True)
        expect(point).to_be_enabled()
        point.click()
        expect(row.locator('[data-job-id]')).to_have_count(1)
        expect(point).to_have_count(0)
        expect(row.locator('[data-job-id][data-source-kind="point"]')).to_have_count(1)
        row.get_by_role('button', name='Save', exact=True).click()
        expect(row).to_contain_text('저장 완료', timeout=30000)
        return panel, row

    def withdraw(self, uid):
        assert uid in self.stack.active
        columns = ', '.join("'%s', \"%s\"" % (c, c) for c in BOUNDARY_COLUMNS)
        saved = psql(f'SELECT jsonb_build_object({columns})::text FROM "StudyState" WHERE uid={literal(uid)}')[0]
        def restore():
            assignments = ', '.join("\"%s\"=s.j->>'%s'" % (c, c) for c in BOUNDARY_COLUMNS)
            psql(f'UPDATE "StudyState" t SET {assignments} FROM (SELECT {literal(saved)}::jsonb AS j) s WHERE t.uid={literal(uid)}')
        self.addCleanup(restore)
        psql(f'''UPDATE "StudyState" SET "institutionId"='kin-center', "teleInstitutionId"=NULL WHERE uid={literal(uid)}''')
        return restore

    def same_screen(self, before, after):
        """The previous MPR screen is back: the same volume, active plane and plane set, projections and cameras (1e-6)."""
        self.assertEqual((before['version'], before['volume'], before['active'], len(before['cells'])),
                         (after['version'], after['volume'], after['active'], len(after['cells'])))
        for x, y in zip(before['cells'], after['cells']):
            self.assertEqual((x.get('orientation'), x['projection']), (y.get('orientation'), y['projection']))
            for field in ['position', 'focalPoint', 'viewUp', 'viewPlaneNormal']:
                for left, right in zip(x['camera'][field], y['camera'][field]): self.assertAlmostEqual(left, right, delta=1e-6)

    def at_point(self, page, point):
        cameras = page.evaluate(PLANES)
        self.assertEqual(len(cameras), 3)
        for plane in cameras:
            self.assertEqual(plane['type'], 'orthographic')
            for got, want in zip(plane['camera']['focalPoint'], point): self.assertAlmostEqual(got, want, delta=1e-6)

    # ---- L1 -----------------------------------------------------------------------------------------
    def test_location_01_prior_point_link_new_login_continuation_and_exact_arrival(self):
        a, b = self.pair(); original = self.originals(); report = (self.state(a), self.versions(a))
        v = self.login(); self.launch(v, [a, b]); self.ready(v)
        # U1 first: the Findings section keeps the reading study through the MPR layout, and a 2D Go to Image is refused there.
        panel = self.findings_tab(v)
        expect(panel).to_have_attribute('data-study-uid', a.uid)
        self.mpr(v); self.choose_volume(v, v, 0)
        panel = self.findings_tab(v)
        expect(panel).to_have_attribute('data-study-uid', a.uid)
        scope = v.evaluate('()=>kinViewerHistoryState()?.scope')
        self.assertIn(scope, [a.uid, b.uid])
        ds = pydicom.dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/'+self.stack.first_instance_id(scope)+'/file')))
        target = dict(studyUid=scope, seriesUid=str(ds.SeriesInstanceUID), sopUid=str(ds.SOPInstanceUID), frame=1)
        refused = v.evaluate('t=>kinViewerHistoryNavigate(t)', target)
        self.assertEqual(refused, dict(ok=False, reason='viewport-unsupported'))
        volume = v.evaluate(ACTIVE_VOLUME)
        if volume['study'] != b.uid:
            v.evaluate(USE_STUDY, b.uid); v.wait_for_function(LOADED, arg=b.uid, timeout=60000); self.choose_volume(v, v, 0)
        point = v.evaluate(CENTER); label = 'P 3D 표식 '+uuid.uuid4().hex[:6]
        self.tools(v)
        marks = self.add_mark(v, label, point)
        self.save_volume(v)
        [summary] = self.jobs(a)
        job = self.stack.request('GET', f'/studies/{a.uid}/viewer-jobs/{summary["id"]}', 'doctor').body
        self.assertEqual((job['snapshot']['version'], job['snapshot']['studies'], job['snapshot']['volume']['study']), (6, [a.uid, b.uid], b.uid))
        traits = '분엽상 경계 결절 😀'
        panel, row = self.link_point(v, label, '비교 검사 3D 표식', traits)
        [finding] = self.api_findings(a)
        source = finding['item']['sources'][0]
        frame = v.evaluate(ACTIVE_VOLUME)['frame']
        self.assertEqual((finding['item']['schemaVersion'], finding['item']['characteristics']), (2, traits))
        self.assertEqual({k: source[k] for k in ('kind', 'jobId', 'revision', 'jobStudyUid', 'studyUid', 'studies', 'snapshotVersion')},
                         dict(kind='job', jobId=job['id'], revision=1, jobStudyUid=a.uid, studyUid=b.uid, studies=[a.uid, b.uid], snapshotVersion=6))
        saved_mark = job['snapshot']['marks']['marks'][0]
        self.assertEqual({k: source['mark'][k] for k in ('id', 'label', 'point')}, saved_mark)
        self.assertEqual(source['mark']['volume'], dict(study=b.uid, series=job['snapshot']['volume']['series'], frameOfReferenceUid=frame,
                                                      sourceDigest=job['snapshot']['volume']['sourceDigest'], sopCount=len(job['snapshot']['volume']['sops'])))
        # The copied point is the Job snapshot's own number text.
        job_text = psql(f'''SELECT snapshot->'marks'->'marks'->0->'point'::text FROM "ViewerJob" WHERE id={literal(job['id'])}::uuid''')
        copy_text = psql(f'''SELECT snapshot->'sources'->0->'mark'->'point'::text FROM "FindingRevision" WHERE "findingId"={literal(finding['id'])}::uuid''')
        self.assertEqual(copy_text, job_text)
        expect(row.locator('[data-job-id="'+job['id']+'"]')).to_have_attribute('data-source-study', 'comparison')
        rows = self.revision_rows(a); jobs_before = self.jobs(a)
        # A new login in a one-study document: the finding continues in a new [X, P] page and proves the arrival there.
        fresh = self.login(); self.launch(fresh, [a]); self.ready(fresh)
        panel = self.findings_tab(fresh)
        saved_row = panel.locator('article[data-finding-id="'+finding['id']+'"]')
        expect(saved_row.locator('[data-kin-characteristics]')).to_have_text('Characteristics (병변 특성): '+traits)
        line = saved_row.locator('[data-job-id="'+job['id']+'"]')
        expect(line).to_have_attribute('data-source-kind', 'point')
        with fresh.expect_navigation(url=lambda url: 'kinFindingNonce=' in url, timeout=60000):
            line.get_by_role('button', name='Go to 3D Point', exact=True).click()
        params = parse_qs(urlsplit(fresh.url).query)
        self.assertEqual(params['StudyInstanceUIDs'], [a.uid+','+b.uid]); self.assertNotIn('kinJob', params)
        self.assertEqual((params['kinFinding'], params['kinFindingRevision'], params['kinFindingSource']), ([finding['id']], ['1'], ['0']))
        nonce = params['kinFindingNonce'][0]
        # No input here: a click in the new page before the restore applies is a user change that supersedes it.
        saved_row = fresh.locator(FINDINGS+' article[data-finding-id="'+finding['id']+'"]')
        expect(saved_row).to_contain_text('3D 표식 위치로 이동했습니다.', timeout=150000)
        self.at_point(fresh, saved_mark['point'])
        arrived = fresh.evaluate(ACTIVE_VOLUME)
        self.assertEqual((arrived['study'], arrived['frame']), (b.uid, source['mark']['volume']['frameOfReferenceUid']))
        self.same_marks(fresh.evaluate('()=>kinMprMarks.capture(true)'), marks)
        self.assertIsNone(fresh.evaluate('k=>sessionStorage.getItem(k)', 'kin-finding-continue:'+nonce), 'the nonce is used once')
        # The same URL again (reload): nothing restores or moves automatically.
        fresh.reload(); self.ready(fresh)
        panel = self.findings_tab(fresh)
        expect(panel.locator('article[data-finding-id="'+finding['id']+'"]')).to_contain_text('요청한 소견 위치를 자동으로 열지 않았습니다', timeout=30000)
        expect(fresh.locator('#kin-viewer-jobs-status')).not_to_contain_text('MPR 작업을 복원했습니다')
        # Navigation wrote no finding revision, Job, report row or original.
        self.assertEqual(self.revision_rows(a), rows); self.assertEqual(self.jobs(a), jobs_before)
        self.assertEqual((self.state(a), self.versions(a)), report); self.assertEqual(self.originals(), original)
        self.evidence_shot(fresh, 'S2L-prior-point-continuation')

    # ---- L2 -----------------------------------------------------------------------------------------
    def test_location_02_refusals_metadata_hidden_sync_off_and_server_matrix(self):
        label = 'L2 표식 '+uuid.uuid4().hex[:6]
        a, b, v, job, marks = self.prior_point(label, sync=False)
        panel, row = self.link_point(v, label, 'L2 소견', '')
        [finding] = self.api_findings(a)
        line = lambda: panel.locator('article[data-finding-id="'+finding['id']+'"] [data-job-id="'+job['id']+'"]')
        saved_row = lambda: panel.locator('article[data-finding-id="'+finding['id']+'"]')
        report = (self.state(a), self.versions(a)); rows = self.revision_rows(a)
        # Same document [X, P]: a sync-off Job moves only the source plane and says so.
        v.evaluate(SHIFT)
        line().get_by_role('button', name='Go to 3D Point', exact=True).click()
        expect(saved_row()).to_contain_text('3D 표식 위치로 이동했습니다. 기준 평면만 이동했습니다.', timeout=90000)
        # An unsaved mark refuses before any request.
        self.tools(v); self.marks(v).get_by_label('MPR annotation label', exact=True).fill('저장하지 않은 문구')
        panel = self.findings_tab(v)
        requests = []
        v.on('request', lambda r: requests.append(r.url) if '/viewer-jobs' in r.url else None)
        line().get_by_role('button', name='Go to 3D Point', exact=True).click()
        expect(saved_row()).to_contain_text('미저장 표식을 먼저 저장하거나 편집을 마친 뒤 복원하세요')
        self.assertEqual(requests, [])
        self.tools(v); self.marks(v).get_by_role('button', name='Cancel Edit', exact=True).click()
        panel = self.findings_tab(v)
        # The Job GET answering 409 is a refusal: the screen is unchanged, never "rolled back".
        before = self.volume_state(v)
        def conflict(route):
            if route.request.method == 'GET': route.fulfill(status=409, content_type='application/json', body=json.dumps({'message': 'SYNTHETIC JOB 409'}))
            else: route.continue_()
        v.route('**/api/studies/*/viewer-jobs/'+job['id'], conflict)
        line().get_by_role('button', name='Go to 3D Point', exact=True).click()
        expect(saved_row()).to_contain_text('SYNTHETIC JOB 409')
        expect(saved_row()).not_to_contain_text('이전 화면으로 되돌렸습니다')
        v.unroute('**/api/studies/*/viewer-jobs/'+job['id'], conflict)
        self.preserved_volume(before, self.volume_state(v))
        # N7: a failure after the apply has replaced the screen is rolled back to the previous screen and said so, never restored.
        v.evaluate(SHIFT)
        before, ids = v.evaluate(CAPTURE), v.evaluate(VIEWPORT_IDS)
        marks_before, jobs_before = v.evaluate('()=>kinMprMarks.capture(true)'), self.jobs(a)
        # The previous screen is not the saved one (each plane 6 mm off), so a skipped rollback cannot pass as this screen.
        self.assertEqual(len(before['cells']), len(job['snapshot']['cells']))
        for shown, saved in zip(before['cells'], job['snapshot']['cells']):
            self.assertGreater(sum((p - q) ** 2 for p, q in zip(shown['camera']['focalPoint'], saved['camera']['focalPoint'])) ** 0.5, 5)
        injected = None
        try:
            v.evaluate(INJECT_APPLY_FAILURE)
            line().get_by_role('button', name='Go to 3D Point', exact=True).click()
            expect(saved_row().locator('[data-kin-message]')).to_have_attribute('data-kin-location-result', 'rolled-back', timeout=120000)
        finally:
            injected = v.evaluate(UNDO_APPLY_FAILURE)
        self.assertEqual(injected, {'calls': 1, 'restored': True}, 'the failure happened once, inside the apply, and the capability is back')
        expect(saved_row().locator('[data-kin-message]')).to_have_text('저장 화면을 적용하지 못해 이전 화면으로 되돌렸습니다. 영상 상태를 적용하지 못했습니다. 이전 화면을 확인하세요.')
        expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('영상 상태를 적용하지 못했습니다')
        # The apply had replaced the viewports; the rollback rebuilt the previous screen on new ones, with its marks and without the point move.
        self.assertNotEqual(v.evaluate(VIEWPORT_IDS), ids)
        self.same_screen(before, v.evaluate(CAPTURE))
        self.same_marks(v.evaluate('()=>kinMprMarks.capture(true)'), marks_before)
        self.assertEqual(self.jobs(a), jobs_before)
        # A retitled Job restores exactly and names its current metadata revision.
        renamed = self.stack.request('POST', f'/studies/{a.uid}/viewer-jobs/{job["id"]}/revisions', 'doctor',
                                     dict(expectedRevision=1, title='바뀐 위치 제목', description='', hidden=False, reason=''))
        self.assertEqual(renamed.status, 200, renamed.text)
        panel.get_by_role('button', name='Reload Findings', exact=True).click()
        expect(line().locator('[data-kin-link-state]')).to_have_text('Details Changed')
        v.evaluate(SHIFT)
        line().get_by_role('button', name='Go to 3D Point', exact=True).click()
        expect(saved_row()).to_contain_text('저장 작업의 제목·설명만 연결 이후 바뀌었고(현재 r2)', timeout=90000)
        # A hidden Job is refused by the live pre-read, before its snapshot is read.
        hidden = self.stack.request('POST', f'/studies/{a.uid}/viewer-jobs/{job["id"]}/revisions', 'doctor',
                                    dict(expectedRevision=2, title='바뀐 위치 제목', description='', hidden=True, reason='숨김 확인'))
        self.assertEqual(hidden.status, 200, hidden.text)
        before = self.volume_state(v); requests.clear()
        line().get_by_role('button', name='Go to 3D Point', exact=True).click()
        expect(saved_row()).to_contain_text('연결한 저장 작업이 숨겨져 있어 복원하지 않았습니다')
        self.assertFalse([u for u in requests if u.rstrip('/').endswith('/viewer-jobs/'+job['id'])], requests)
        self.preserved_volume(before, self.volume_state(v))
        # Server matrix: an unknown mark, a Job anchored on the comparison study and a forged point.
        unknown = self.link(a, dict(requestId=str(uuid.uuid4()), item=dict(schemaVersion=2, title='x', text='', characteristics='',
                            sources=[dict(jobId=job['id'], revision=3, markId=str(uuid.uuid4()))])))
        self.assertEqual((unknown.status, unknown.body['code']), (400, 'FINDING_JOB_MARK'))
        swapped = dict(job['snapshot'], studies=[b.uid, a.uid]); swapped.pop('annotations', None)
        swapped['volume'] = {k: swapped['volume'][k] for k in ('study', 'series', 'sops')}
        other = self.stack.request('POST', f'/studies/{b.uid}/viewer-jobs', 'doctor', dict(id=str(uuid.uuid4()), title='P 판독 대상 작업', description='', snapshot=swapped))
        self.assertEqual(other.status, 200, other.text)
        elsewhere = self.link(a, dict(requestId=str(uuid.uuid4()), item=dict(schemaVersion=2, title='x', text='', characteristics='',
                              sources=[dict(jobId=other.body['id'], revision=1, markId=saved_mark_id(job))])))
        missing = self.link(a, dict(requestId=str(uuid.uuid4()), item=dict(schemaVersion=2, title='x', text='', characteristics='',
                            sources=[dict(jobId=str(uuid.uuid4()), revision=1, markId=saved_mark_id(job))])))
        self.assertEqual((elsewhere.status, elsewhere.body), (missing.status, missing.body))
        self.assertEqual(missing.body['message'], '연결할 저장 작업이 이 검사에 없습니다')
        forged = self.link(a, dict(requestId=str(uuid.uuid4()), item=dict(schemaVersion=2, title='x', text='', characteristics='',
                           sources=[dict(jobId=job['id'], revision=3, markId=saved_mark_id(job), point=[0, 0, 0])])))
        self.assertEqual(forged.status, 400)
        self.assertEqual(self.revision_rows(a), rows); self.assertEqual((self.state(a), self.versions(a)), report)
        self.assertEqual(len(marks['marks']), 1)

    # ---- L3 -----------------------------------------------------------------------------------------
    def test_location_03_same_document_restore_keeps_finding_drafts_and_withdrawal_removes_the_finding(self):
        label = 'L3 표식 '+uuid.uuid4().hex[:6]
        a, b, v, job, marks = self.prior_point(label)
        panel, row = self.link_point(v, label, 'L3 소견', '보존 확인')
        [finding] = self.api_findings(a)
        # An unsaved finding draft stays through a same-document restore.
        panel.get_by_role('button', name='New Finding', exact=True).click()
        key = panel.locator('article[data-saved=false]').last.get_attribute('data-row-key')
        draft = panel.locator('article[data-row-key="'+key+'"]')
        draft.get_by_label('Finding Title').fill('KEEP FINDING DRAFT')
        draft.get_by_label('Finding Characteristics', exact=True).fill('KEEP CHARACTERISTICS')
        v.evaluate(SHIFT)
        saved_row = panel.locator('article[data-finding-id="'+finding['id']+'"]')
        saved_row.locator('[data-job-id="'+job['id']+'"]').get_by_role('button', name='Go to 3D Point', exact=True).click()
        expect(saved_row).to_contain_text('3D 표식 위치로 이동했습니다.', timeout=90000)
        self.at_point(v, marks['marks'][0]['point'])
        expect(draft.get_by_label('Finding Title')).to_have_value('KEEP FINDING DRAFT')
        expect(draft.get_by_label('Finding Characteristics', exact=True)).to_have_value('KEEP CHARACTERISTICS')
        self.assertTrue(v.evaluate('()=>kinViewerFindingsState().dirty'))
        # The comparison study leaves this institution: the finding that names it through its 3D point is withdrawn; the draft stays.
        restore = self.withdraw(b.uid)
        panel.get_by_role('button', name='Reload Findings', exact=True).click()
        expect(panel.locator('article[data-finding-id="'+finding['id']+'"]')).to_have_count(0, timeout=30000)
        expect(draft.get_by_label('Finding Title')).to_have_value('KEEP FINDING DRAFT')
        # The withdrawn record's own text is gone (the open draft may still offer the shown Job's points for linking).
        self.assertNotIn('보존 확인', panel.inner_text())
        self.assertEqual(self.api_findings(a), [])
        restore()
        self.assertEqual([f['id'] for f in self.api_findings(a)], [finding['id']])

    def evidence_shot(self, page, name):
        import os
        from pathlib import Path
        if os.environ.get('KIN_EVIDENCE_DIR'): page.screenshot(path=str(Path(os.environ['KIN_EVIDENCE_DIR'])/(name+'.png')))


def saved_mark_id(job):
    return job['snapshot']['marks']['marks'][0]['id']


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(loader.loadTestsFromName(name, FindingLocationsE2E)
                              for name in loader.getTestCaseNames(FindingLocationsE2E) if name.startswith('test_location_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
