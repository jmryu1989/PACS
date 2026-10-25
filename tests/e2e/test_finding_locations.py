# coding: utf-8
"""TEST-S2L-LOCATIONS (S2-L2a/S2-L2b, hosted volume-path group) - the interim finding-write contract (#219, D1861).

Every finding write runs through the composed clinical runtime, whose finding source reader Module A has not supplied
yet (A1 #223 provides no fixed-version/patient/retention reader). Until it lands, every `finding.*` write answers
503 `ModuleAFixedVersionReaderPending`, keeps the input and writes nothing. These three cases assert that contract on
the real pinned OHIF, BFF login, run-owned same-patient synthetic CTs and the real findings/Job APIs:
  01 the viewer's own Save of a finding linked to a saved 3D point (POST studies/:uid/findings) and its Retry Request;
     U1 (the Findings section keeps the reading study through the MPR layout, a 2D Go to Image is refused there) and
     the Job save it links are unchanged and still proven;
  02 the API create route: a valid 3D point link and the server-matrix bodies all meet the interim refusal before any
     Job is read, the route's own shape check still answers 400, the list read answers 200 and empty;
  03 the API revisions route (edit, hide, restore) and the page: a refused draft stays unsaved with its text and
     survives Reload Findings.
The saved-location assertions these cases held before #219 (link, continuation into a new [X, P] page, exact arrival,
restore rollback, metadata/hidden/sync-off states, withdrawal) are listed for restoration in the Module A unit's
hand-off (private docs-repo evidence/fable-impl-emr-d-routes-20261025/handoff-module-a-finding-reader.md); their last
full text is this file at 5ac35a3. Nothing here writes a report or an original."""
import io, unittest, uuid
import pydicom
from playwright.sync_api import expect
from test_volume_marks import VolumeMarksE2E
from test_viewer_history import ViewerHistoryE2E, literal
from test_worklist import psql

SCHEMA = {'X-KIN-Finding-Schema': '2'}
FINDINGS = '#kin-viewer-findings'
INTERIM_CODE = 'ModuleAFixedVersionReaderPending'
# The findings pane keeps a request that met no 4xx refusal for Retry Request and says so.
PENDING_TEXT = '저장 결과를 확인하지 못했습니다. 같은 요청 재시도로 결과를 확인하세요.'
ACTIVE_VOLUME = """()=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);
 const m=cornerstone.metaData.get('instance',cornerstone.cache.getVolume(v.getVolumeId()).imageIds[0]);return {study:m.StudyInstanceUID,series:m.SeriesInstanceUID,frame:m.FrameOfReferenceUID}}"""
CENTER = """()=>{window.projectionVP=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);
 const volume=cornerstone.cache.getVolume(projectionVP.getVolumeId()),point=Array.from(volume.imageData.indexToWorld(volume.dimensions.map(n=>Math.floor(n/2)))),c=projectionVP.getCamera();
 projectionVP.setCamera({focalPoint:point,position:point.map((n,i)=>n+c.viewPlaneNormal[i]*100)});projectionVP.render();return point}"""
USE_STUDY = """uid=>{const set=services.displaySetService.getActiveDisplaySets().find(s=>s.StudyInstanceUID===uid&&s.Modality==='CT');if(!set)throw Error('Missing CT of '+uid);
 services.viewportGridService.setDisplaySetsForViewports([...services.viewportGridService.getState().viewports.keys()].map(viewportId=>({viewportId,displaySetInstanceUIDs:[set.displaySetInstanceUID]})))}"""
LOADED = """uid=>{try{return [...services.viewportGridService.getState().viewports.keys()].every(id=>{const view=services.cornerstoneViewportService.getCornerstoneViewport(id),volume=cornerstone.cache.getVolume(view.getVolumeId());
 return volume?.loadStatus.loaded&&cornerstone.metaData.get('instance',volume.imageIds[0]).StudyInstanceUID===uid})}catch(_){return false}}"""


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

    def revise(self, f, finding_id, body, user='doctor'):
        return self.stack.bearer_request('POST', '/studies/'+f.uid+'/findings/'+finding_id+'/revisions', self.stack.token(user), body, headers=SCHEMA)

    def revision_rows(self, f):
        return psql(f'''SELECT to_jsonb(r)::text FROM "FindingRevision" r JOIN "Finding" x ON x.id=r."findingId" WHERE x."studyUid"={literal(f.uid)} ORDER BY 1''')

    def written(self, f):
        """Finding rows, revision rows and finding audit rows of the study: the interim refusal leaves all three at zero."""
        return psql(f'''SELECT (SELECT count(*) FROM "Finding" WHERE "studyUid"={literal(f.uid)}) || '|' ||
            (SELECT count(*) FROM "FindingRevision" r JOIN "Finding" x ON x.id=r."findingId" WHERE x."studyUid"={literal(f.uid)}) || '|' ||
            (SELECT count(*) FROM "AuditLog" WHERE target={literal(f.uid)} AND action LIKE 'finding.%')''')

    def nothing_written(self, f, report, original, jobs_before):
        self.assertEqual(self.api_findings(f), [])
        self.assertEqual(self.written(f), ['0|0|0']); self.assertEqual(self.revision_rows(f), [])
        self.assertEqual(self.jobs(f), jobs_before)
        self.assertEqual((self.state(f), self.versions(f)), report); self.assertEqual(self.originals(), original)

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

    def compose_point(self, v, label, title, traits, revision=1):
        """A new finding with its title and characteristics typed and the saved 3D point linked, not yet saved."""
        panel = self.findings_tab(v)
        panel.get_by_role('button', name='New Finding', exact=True).click()
        key = panel.locator('article[data-saved=false]').last.get_attribute('data-row-key')
        row = panel.locator('article[data-row-key="'+key+'"]')
        row.get_by_label('Finding Title').fill(title)
        row.get_by_label('Finding Characteristics', exact=True).fill(traits)
        # The panel offers each unlinked pair once: linking removes that checkbox and shows the source line with Unlink
        # (test_finding_navigation.compose), so the click is proven by the new state, not by a checked box.
        point = row.locator('details[data-kin-locations]').get_by_label('Link 3D Point '+label+' · 저장 작업 r'+str(revision), exact=True)
        expect(point).to_be_enabled()
        point.click()
        expect(row.locator('[data-job-id][data-source-kind="point"]')).to_have_count(1)
        expect(point).to_have_count(0)
        expect(row.get_by_label('Finding Title')).to_have_value(title)
        expect(row.get_by_label('Finding Characteristics', exact=True)).to_have_value(traits)
        return row

    def save_refused(self, v, row, button='Save'):
        """The page's own request through `button` meets the interim refusal; the answer the page received is returned."""
        with v.expect_response(lambda r: r.request.method == 'POST' and r.url.endswith('/findings')) as answer:
            row.get_by_role('button', name=button, exact=True).click()
        self.assertEqual(answer.value.status, 503, answer.value.text())
        self.assertEqual(answer.value.json()['code'], INTERIM_CODE)
        return answer.value

    def kept_unsaved(self, v, row, title, traits):
        """The refused finding stays an unsaved draft with its typed fields, says the result is unconfirmed and offers Retry Request."""
        expect(row).to_have_attribute('data-saved', 'false')
        expect(row.locator('[data-kin-message]')).to_have_text(PENDING_TEXT)
        expect(row.get_by_role('button', name='Retry Request', exact=True)).to_have_count(1)
        expect(row.get_by_role('button', name='Save', exact=True)).to_have_count(0)
        expect(row.get_by_label('Finding Title')).to_have_value(title)
        expect(row.get_by_label('Finding Characteristics', exact=True)).to_have_value(traits)
        expect(row.locator('[data-job-id][data-source-kind="point"]')).to_have_count(1)
        self.assertTrue(v.evaluate('()=>kinViewerFindingsState().dirty'))

    # ---- 01 -----------------------------------------------------------------------------------------
    def test_location_01_viewer_save_meets_the_interim_refusal_and_keeps_the_typed_finding(self):
        a, b = self.pair(); original = self.originals(); report = (self.state(a), self.versions(a))
        v = self.login(); self.launch(v, [a, b]); self.ready(v)
        # U1 (unchanged by the interim): the Findings section keeps the reading study through the MPR layout, and a 2D
        # Go to Image is refused there.
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
        jobs_before = self.jobs(a)
        title, traits = '비교 검사 3D 표식', '분엽상 경계 결절 😀'
        row = self.compose_point(v, label, title, traits)
        first = self.save_refused(v, row)
        self.kept_unsaved(v, row, title, traits)
        self.nothing_written(a, report, original, jobs_before)
        # Retry Request replays the kept body byte for byte and meets the same refusal; the input still stays.
        retry = self.save_refused(v, row, 'Retry Request')
        self.assertEqual(retry.request.post_data, first.request.post_data)
        self.kept_unsaved(v, row, title, traits)
        self.nothing_written(a, report, original, jobs_before)
        self.same_marks(v.evaluate('()=>kinMprMarks.capture(true)'), marks)
        self.evidence_shot(v, 'S2L-interim-refusal')

    # ---- 02 -----------------------------------------------------------------------------------------
    def test_location_02_api_create_route_meets_the_interim_refusal_before_any_job_is_read(self):
        label = 'L2 표식 '+uuid.uuid4().hex[:6]
        a, b, v, job, marks = self.prior_point(label, sync=False)
        original = self.originals(); report = (self.state(a), self.versions(a)); jobs_before = self.jobs(a)
        mark_id = saved_mark_id(job)
        swapped = dict(job['snapshot'], studies=[b.uid, a.uid]); swapped.pop('annotations', None)
        swapped['volume'] = {k: swapped['volume'][k] for k in ('study', 'series', 'sops')}
        other = self.stack.request('POST', f'/studies/{b.uid}/viewer-jobs', 'doctor', dict(id=str(uuid.uuid4()), title='P 판독 대상 작업', description='', snapshot=swapped))
        self.assertEqual(other.status, 200, other.text)
        body = lambda sources: dict(requestId=str(uuid.uuid4()), item=dict(schemaVersion=2, title='L2 소견', text='', characteristics='', sources=sources))
        # The valid 3D point link and the server matrix (an unknown mark, a Job anchored on the comparison study, a missing
        # Job) all meet the interim refusal: it answers before the finding service reads any Job, so none is told apart yet.
        cases = {'valid point': [dict(jobId=job['id'], revision=1, markId=mark_id)],
                 'unknown mark': [dict(jobId=job['id'], revision=1, markId=str(uuid.uuid4()))],
                 'job anchored on the comparison study': [dict(jobId=other.body['id'], revision=1, markId=mark_id)],
                 'missing job': [dict(jobId=str(uuid.uuid4()), revision=1, markId=mark_id)]}
        for name, sources in cases.items():
            with self.subTest(body=name):
                answer = self.link(a, body(sources))
                self.assertEqual((answer.status, (answer.body or {}).get('code')), (503, INTERIM_CODE), answer.text)
        # The route's own shape check is not pending: a copied point and an empty link list are refused as input.
        forged = self.link(a, body([dict(jobId=job['id'], revision=1, markId=mark_id, point=[0, 0, 0])]))
        self.assertEqual(forged.status, 400, forged.text)
        empty = self.link(a, body([]))
        self.assertEqual(empty.status, 400, empty.text)
        self.nothing_written(a, report, original, jobs_before)
        self.assertEqual(len(marks['marks']), 1)

    # ---- 03 -----------------------------------------------------------------------------------------
    def test_location_03_revisions_route_meets_the_interim_refusal_and_the_page_keeps_the_refused_draft(self):
        label = 'L3 표식 '+uuid.uuid4().hex[:6]
        a, b, v, job, marks = self.prior_point(label)
        original = self.originals(); report = (self.state(a), self.versions(a)); jobs_before = self.jobs(a)
        item = dict(schemaVersion=2, title='L3 소견', text='', characteristics='보존 확인', sources=[dict(jobId=job['id'], revision=1, markId=saved_mark_id(job))])
        # Edit, hide and restore meet the interim refusal before the finding id is looked up.
        for action, reason in (('edit', ''), ('hide', '숨김 확인'), ('restore', '복원 확인')):
            with self.subTest(action=action):
                answer = self.revise(a, str(uuid.uuid4()), dict(requestId=str(uuid.uuid4()), expectedRevision=1, action=action, reason=reason, item=item))
                self.assertEqual((answer.status, (answer.body or {}).get('code')), (503, INTERIM_CODE), answer.text)
        # The page: a draft linked to the 3D point is refused on Save, stays unsaved with its text and survives Reload Findings.
        title, traits = 'L3 소견', '보존 확인'
        row = self.compose_point(v, label, title, traits)
        self.save_refused(v, row)
        self.kept_unsaved(v, row, title, traits)
        key = row.get_attribute('data-row-key')
        panel = self.findings_tab(v)
        panel.get_by_role('button', name='Reload Findings', exact=True).click()
        panel = self.findings_tab(v)
        row = panel.locator('article[data-row-key="'+key+'"]')
        self.kept_unsaved(v, row, title, traits)
        self.nothing_written(a, report, original, jobs_before)
        self.at_point_unchanged(v, marks)

    def at_point_unchanged(self, v, marks):
        self.same_marks(v.evaluate('()=>kinMprMarks.capture(true)'), marks)

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
