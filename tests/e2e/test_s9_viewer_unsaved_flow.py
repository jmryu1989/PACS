"""U7 W1-W5: real saved receipts, loss recovery, and dirty/busy work kept across replacement paths."""
import json
import unittest
import uuid
from playwright.sync_api import expect
from test_s9_viewer_output_scope import ServedViewerFlow, BUSY_WINDOW, DIRTY_WINDOW
from test_viewer_history import ViewerHistoryE2E
from test_viewer_ux_priors import ViewerUXPriorsE2E
from test_context_loss import LOSS
from test_prior_selection import canvas_ready
from viewer_tools import select_image_tool
# The MPR mark, curve and path cases need the volume launch and drawing helpers; this family already
# contains VolumeMarksE2E and ViewerJobsE2E.
from test_volume_curved import SLOPE, PLACE
from test_volume_path import VolumePathE2E

# Existing guard notices: patient tabs (viewer-patient-tabs.js) and the series strip (viewer-series-strip.js).
TAB_KEPT = '저장·편집을 마친 뒤 환자를 전환하세요'
SERIES_KEPT = '미저장 작업을 저장하거나 편집을 마친 뒤 시리즈를 여세요'
# Existing refusals of the other replacement consumers while a save is in flight: Hanging Protocol
# (viewer-hanging-protocol.js), cell merge (viewer-cell-merge.js), the in-viewer Studies panel
# (viewer-prior-controller.js), renderer-loss Reload Viewer (viewer-context-loss.js) and the
# embedded reading workspace (reading-workspace.js).
HP_KEPT = '저장하지 않은 영상 작업이 있어 배치를 변경하지 않았습니다'
MERGE_KEPT = '저장 또는 영상 작업이 끝난 뒤 다시 시도하세요'
PRIOR_KEPT = '현재 영상은 유지합니다'
RELOAD_KEPT = '진행 중인 작업이 끝난 뒤 다시 시도하세요'
WORKSPACE_KEPT = '영상의 저장·복원 또는 상태 확인 중입니다'
# One personal rule that would replace the grid with the second CT series (draft only, never saved).
HP_RULE = '77777777-7777-4777-8777-777777777777'
HP_RULES = {'version': 1, 'activeRuleId': HP_RULE, 'rules': [{
    'id': HP_RULE, 'name': 'U7 Second Series', 'enabled': True,
    'match': {'modality': 'CT', 'retrieveAE': None, 'bodyPart': None, 'description': {'operator': 'contains', 'value': 'D03A'}},
    'selectors': [{'alias': 'Current', 'role': 'current', 'historical': False, 'modality': 'CT', 'retrieveAE': None,
                   'bodyPart': None, 'description': None, 'laterality': None, 'order': 'ascending', 'occurrence': 2}],
    'layout': {'rows': 1, 'cols': 1, 'cells': ['Current']}}]}
SERIES_ORDER = '''expected => { const cells=[...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x);
  return cells.length===expected.length && cells.every((g,i)=>{ const v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId),
    image=v?.getCurrentImageId?.(); return image && cornerstone.metaData.get('instance',image)?.SeriesInstanceUID===expected[i]; }); }'''
SECOND = 'D02E second series'
SHOWS_SERIES = '''series => [...services.viewportGridService.getState().viewports.keys()].some(id => {
  const image = services.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageId?.();
  return image && cornerstone.metaData.get('instance', image)?.SeriesInstanceUID === series;
})'''
ARROWS = '''() => cornerstoneTools.annotation.state.getAllAnnotations().filter(a => a.metadata.toolName === 'ArrowAnnotate')
  .map(a => ({image: a.metadata.referencedImageId, points: a.data.handles.points, label: a.data.text}))'''


class S9ViewerUnsavedFlowE2E(ServedViewerFlow, VolumePathE2E):
    def switch_tab(self, page, fixture, kept=False):
        tabs = page.get_by_role('tablist', name='Patients')
        tab = tabs.get_by_role('tab').filter(has_text=fixture.patient_id)
        before, cells = page.url, self.rendered(page)
        tab.click()
        if not kept:
            expect(tab).to_have_attribute('aria-selected', 'true')
            return self.shows(page, fixture)
        expect(page.locator('.kin-patient-tabs [role=status]')).to_contain_text(TAB_KEPT)
        # The guard runs synchronously in the click; give a wrongly admitted switch time to show.
        page.wait_for_timeout(500)
        expect(tab).to_have_attribute('aria-selected', 'false')
        self.assertEqual((page.url, self.rendered(page)), (before, cells))

    def series_card(self, page, title):
        return page.locator('.kin-series-card').filter(has_text=title)

    def finding(self, page):
        ViewerHistoryE2E.open_measurement_tools(self, page)
        panel = page.locator('#kin-viewer-findings')
        expect(panel.get_by_role('button', name='New Finding', exact=True)).to_be_enabled(timeout=45000)
        return panel

    def series_uids(self, work, fixture):
        """Each series UID of the fixture by its description, read from the stored DICOM metadata."""
        found = {}
        for item in self.metadata(work, fixture):
            found.setdefault(item.get('0008103E', {}).get('Value', [''])[0], set()).add(item['0020000E']['Value'][0])
        self.assertTrue(all(len(uids) == 1 for uids in found.values()), found)
        return {description: uids.pop() for description, uids in found.items()}

    def refuse_series(self, page):
        before = self.rendered(page)
        self.series_card(page, SECOND).click()
        expect(page.get_by_text(SERIES_KEPT).first).to_be_visible()
        # The strip refuses synchronously in the click; give a wrongly admitted replacement time to paint.
        page.wait_for_timeout(500)
        self.assertEqual(self.rendered(page), before)

    def worklist_step(self, work, page, button, fixture, refusal=None):
        """Worklist Prev/Next with Open on Selection: the selection moves to `fixture` and the separate window follows, or keeps."""
        def click():
            work.locator(button).click()
            expect(work.locator('#rows tr.sel')).to_have_attribute('data-uid', fixture.uid)
        before = page.url, self.rendered(page)
        self.worklist_action(work, page, fixture, click, refusal)
        if refusal is not None:
            # A wrongly admitted reuse would navigate after the notice; read the window again a little later.
            page.wait_for_timeout(500)
            self.assertEqual((page.url, self.rendered(page)), before)

    def hold_job_save(self, router, viewer, fixture):
        """Press Save New Job and hold its answer after the real write; returns the release, which lands it and gives the sent body.

        The answer is released well inside the client's 30 s request limit (otherwise it reads as unknown)."""
        held, land = self.hold_writes(router, '**/api/studies/' + fixture.uid + '/viewer-jobs')
        viewer.locator('#kin-viewer-jobs').get_by_role('button', name='Save New Job', exact=True).first.click()
        for _ in range(100):
            if held: break
            router.wait_for_timeout(50)
        self.assertTrue(held)
        self.assertTrue(viewer.evaluate('kinViewerJobWorkspaceState().busy'))
        def release():
            land()
            expect(viewer.locator('#kin-viewer-jobs-status')).to_contain_text('저장했습니다', timeout=45000)
            self.assertEqual(len(held), 1)
            return held[0][0].request.post_data_json
        return release

    def stored_cells(self, fixture, sent):
        """The stored Job named by the held request, as the study/series/SOP of each cell it recorded."""
        response = self.stack.request('GET', f'/studies/{fixture.uid}/viewer-jobs/{sent["id"]}', 'doctor')
        self.assertEqual(response.status, 200, response.text)
        return [(cell['study'], cell['series'], cell['sop']) for cell in response.body['snapshot']['cells'] if cell]

    def activate(self, page, index):
        # The Pan tool is selected first, so this click only makes the cell active.
        box = page.locator('[data-cy=viewport-grid] > div').nth(index).bounding_box()
        page.mouse.click(box['x'] + box['width'] * .5, box['y'] + box['height'] * .3)
        page.wait_for_function('''i => services.viewportGridService.getActiveViewportId() === [...services.viewportGridService.getState().viewports.values()]
          .sort((a,b)=>a.y-b.y||a.x-b.x)[i].viewportId''', arg=index)

    def test_unsaved_01_uncertain_job_receipt_and_same_request_retry(self):
        current = self.ct('U7W-' + uuid.uuid4().hex[:12], 'work', '20260801')
        work, page = self.served_viewer(current)
        work.locator('#findings').fill('U7 WORK KEEP REPORT')
        self.open_layout_tools(page)
        title = page.get_by_label('Job Title', exact=True)
        title.fill('U7 retained title')
        page.get_by_label('Description', exact=True).fill('U7 retained description')
        before = self.cells(page)
        path = '**/api/studies/' + current.uid + '/viewer-jobs'
        # The route stays registered (see hold_writes); `retry` passes the same-request retry on.
        sent, retry = [], []
        def lost_receipt(route):
            if retry or route.request.method != 'POST': return route.fallback()
            sent.append(route.request.post_data_json)
            response = route.fetch()
            self.assertEqual(response.status, 200)
            # The real write completed, but the client cannot identify its receipt.
            route.fulfill(response=response, json={})
        page.route(path, lost_receipt)
        self.click_job(page, 'Save New Job', '응답을 확인하지 못했습니다')
        expect(title).to_have_value('U7 retained title')
        expect(page.get_by_label('Description', exact=True)).to_have_value('U7 retained description')
        self.assertEqual(page.evaluate('kinViewerJobWorkspaceState().dirty'), True)
        self.assertEqual(self.cells(page), before)
        self.assertEqual([j['id'] for j in self.jobs(current)], [sent[0]['id']])
        self.evidence(page, 'unsaved-job-unknown-receipt')
        retry.append(True)
        self.click_job(page, 'Retry Request', '저장했습니다')
        self.assertEqual([j['id'] for j in self.jobs(current)], [sent[0]['id']])
        expect(work.locator('#findings')).to_have_value('U7 WORK KEEP REPORT')

        # A confirmed save whose list reload then fails stays reported as saved: an "unknown, retry" notice would
        # invite a second Job for one that exists. Only the first list read after this Save is refused.
        refused = []
        def list_unavailable(route):
            if refused or route.request.method != 'GET': return route.fallback()
            refused.append(route.request.url)
            route.fulfill(status=503, json={'message': 'Synthetic list unavailable'})
        page.route(path + '?*', list_unavailable)
        title.fill('U7 saved before the list')
        self.click_job(page, 'Save New Job', '작업 목록을 새로 고치지 못했습니다')
        expect(page.locator('#kin-viewer-jobs-status')).to_contain_text('비교 작업을 저장했습니다')
        expect(page.locator('#kin-viewer-jobs-status')).not_to_contain_text('재시도')
        self.assertEqual(len(refused), 1)
        self.assertEqual(sorted(j['title'] for j in self.jobs(current)), ['U7 retained title', 'U7 saved before the list'])
        expect(title).to_have_value('')
        self.assertFalse(page.evaluate('kinViewerJobWorkspaceState().dirty'))
        self.click_job(page, 'Refresh Jobs', '저장 작업 목록입니다')

    def test_unsaved_02_saved_key_edit_status_and_layout_preservation(self):
        current = self.ct('U7W-' + uuid.uuid4().hex[:12], 'key work', '20260801')
        work, page = self.served_viewer(current)
        ViewerHistoryE2E.open_measurement_tools(self, page)
        page.get_by_role('button', name='Add Key Image', exact=True).click()
        row = page.locator('#kin-viewer-history section[data-kind=key]').last
        row.get_by_label('Key Title').fill('U7 first key')
        expect(row.locator('strong')).to_contain_text('Unsaved')
        row.get_by_role('button', name='Save', exact=True).click()
        expect(row.locator('strong')).to_contain_text('Saved r1')
        row.get_by_role('button', name='Edit', exact=True).click()
        row.get_by_label('Key Title').fill('U7 unsaved key')
        expect(row.locator('strong')).to_contain_text('Unsaved')
        expect(row.locator('strong')).not_to_contain_text('Saved')
        before = self.cells(page)
        page.locator('[data-cy=Layout]').click()
        page.get_by_text('Common', exact=True).locator('..').locator(':scope > div').nth(1).locator(':scope > div').nth(1).click()
        expect(row.get_by_label('Key Title')).to_have_value('U7 unsaved key')
        # Adding a cell may proceed when the source and unsaved item survive.
        # The work contract does not require refusing every layout change.
        self.assertEqual([c['image'] for c in self.cells(page) if c['image']],
                         [c['image'] for c in before if c['image']])
        expect(row.locator('strong')).to_contain_text('Unsaved')
        self.evidence(page, 'unsaved-key-grid-preserved')
        row.get_by_role('button', name='Save', exact=True).click()
        expect(row.locator('strong')).to_contain_text('Saved r2')


    def test_unsaved_03_clean_patient_switch_preserves_other_window(self):
        a = self.ct('U7WA-' + uuid.uuid4().hex[:12], 'window A', '20260801')
        b = self.ct('U7WB-' + uuid.uuid4().hex[:12], 'window B', '20260801')
        c = self.ct('U7WC-' + uuid.uuid4().hex[:12], 'window C', '20260801')
        work, page = self.served_viewer(a)
        self.select(work, b)
        work.locator('#m-filmbox').click()
        tabs = page.get_by_role('tablist', name='Patients')
        expect(tabs.get_by_role('tab')).to_have_count(2, timeout=45000)
        expect(tabs.get_by_role('tab').filter(has_text=b.patient_id)).to_have_attribute('aria-selected', 'true')
        expect(page.locator('.kin-viewer-identity[data-study="' + b.uid + '"]')).to_contain_text('기준 검사', timeout=45000)
        self.open_layout_tools(page)
        title = page.get_by_label('Job Title', exact=True)
        title.fill('Temporary first-window title')
        other_work, other = self.served_viewer(c)
        other_work.locator('#findings').fill('U7 OTHER WINDOW KEEP REPORT')
        self.open_layout_tools(other)
        other.get_by_label('Job Title', exact=True).fill('U7 OTHER WINDOW KEEP JOB')
        before = self.cells(other)
        # Clearing this unsaved field is an explicit edit in this window only.
        title.fill('')
        dialogs = []
        def notice(dialog):
            dialogs.append(dialog.type)
            dialog.dismiss()
        page.on('dialog', notice)
        tabs.get_by_role('tab').filter(has_text=a.patient_id).click()
        expect(tabs.get_by_role('tab').filter(has_text=a.patient_id)).to_have_attribute('aria-selected', 'true')
        page.wait_for_function('uid => [...services.viewportGridService.getState().viewports.keys()].some(id => services.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageId?.().includes("/studies/"+uid+"/"))', arg=a.uid)
        expect(page.locator('.kin-viewer-identity[data-study="' + a.uid + '"]')).to_contain_text('기준 검사', timeout=45000)
        self.assertEqual(dialogs, [])
        expect(work.locator('#rows tr.sel')).to_have_attribute('data-uid', b.uid)
        expect(other.get_by_label('Job Title', exact=True)).to_have_value('U7 OTHER WINDOW KEEP JOB')
        expect(other_work.locator('#findings')).to_have_value('U7 OTHER WINDOW KEEP REPORT')
        self.assertEqual(self.cells(other), before)
        self.assertEqual(self.jobs(a), [])
        self.assertEqual(self.jobs(b), [])
        self.assertEqual(self.jobs(c), [])
        self.evidence(page, 'work-clean-patient-switch')
        self.evidence(other, 'work-other-window-kept')

    def test_unsaved_04_dirty_and_busy_work_keeps_every_replacement_target(self):
        patient = 'U7WD-' + uuid.uuid4().hex[:12]
        a = self.multiple(patient, 'dirty current', '20260801')
        prior = self.ct(patient, 'dirty prior', '20260701')
        b = self.ct('U7WD-OTHER-' + uuid.uuid4().hex[:12], 'dirty other', '20260801')
        work, page = self.served_viewer(a)
        work.locator('#findings').fill('U7 DIRTY KEEP REPORT')
        dialogs = []
        def answer(dialog):
            # Only the existing Frame Coverage confirm of a clean switch may ask; no refusal does.
            dialogs.append(dialog.message)
            dialog.accept()
        page.on('dialog', answer)
        # A second patient tab to switch to, then back to A while everything is clean.
        self.open_from_worklist(work, page, b)
        self.switch_tab(page, a)
        self.assertEqual({cell['study'] for cell in self.rendered(page)}, {a.uid})
        refusals = len(dialogs)

        # Job title/description: patient tab, comparison (prior) and other-patient reuse are refused.
        self.open_layout_tools(page)
        title, description = page.get_by_label('Job Title', exact=True), page.get_by_label('Description', exact=True)
        title.fill('U7 KEEP JOB TITLE')
        description.fill('U7 KEEP JOB DESCRIPTION')
        self.switch_tab(page, b, kept=True)
        self.open_from_worklist(work, page, prior, DIRTY_WINDOW)
        self.open_from_worklist(work, page, b, DIRTY_WINDOW)
        series = self.series_uids(work, a)
        self.assertEqual(len(series), 2)
        first = next(uid for description, uid in series.items() if description != SECOND)
        self.assertEqual({(cell['study'], cell['series']) for cell in self.rendered(page)}, {(a.uid, first)})
        self.refuse_series(page)
        expect(title).to_have_value('U7 KEEP JOB TITLE')
        expect(description).to_have_value('U7 KEEP JOB DESCRIPTION')
        self.evidence(page, 'work-dirty-job-kept')

        # A save in flight is busy: the same transitions wait for its real answer, which is
        # released well inside the client's 30 s request limit (otherwise it reads as unknown).
        held, release = self.hold_writes(page, '**/api/studies/' + a.uid + '/viewer-jobs')
        page.locator('#kin-viewer-jobs').get_by_role('button', name='Save New Job', exact=True).first.click()
        for _ in range(100):
            if held: break
            page.wait_for_timeout(50)
        self.assertTrue(held)
        self.assertTrue(page.evaluate('kinViewerJobWorkspaceState().busy'))
        self.open_from_worklist(work, page, b, BUSY_WINDOW)
        self.switch_tab(page, b, kept=True)
        release()
        expect(page.locator('#kin-viewer-jobs-status')).to_contain_text('저장했습니다', timeout=45000)
        saved = self.jobs(a)
        self.assertEqual([j['title'] for j in saved], ['U7 KEEP JOB TITLE'])
        # Emptying the inputs is this window's explicit discard of what is now saved.
        title.fill('')
        description.fill('')
        page.wait_for_function('() => !kinViewerJobWorkspaceState().dirty && !kinViewerJobWorkspaceState().busy')

        # An unsaved viewer Finding (not the workspace report draft): kept until Discard Draft.
        panel = self.finding(page)
        panel.get_by_role('button', name='New Finding', exact=True).click()
        row = panel.locator('article[data-saved=false]').last
        row.get_by_label('Finding Title').fill('U7 KEEP FINDING')
        row.get_by_label('Finding Text').fill('U7 viewer finding text')
        page.wait_for_function('() => kinViewerHistoryWorkspaceState().dirty')
        self.switch_tab(page, b, kept=True)
        self.open_from_worklist(work, page, prior, DIRTY_WINDOW)
        self.refuse_series(page)
        expect(row.get_by_label('Finding Title')).to_have_value('U7 KEEP FINDING')
        expect(row.get_by_label('Finding Text')).to_have_value('U7 viewer finding text')
        self.evidence(page, 'work-dirty-finding-kept')
        row.get_by_role('button', name='Discard Draft', exact=True).click()
        page.wait_for_function('() => !kinViewerHistoryWorkspaceState().dirty && !kinViewerHistoryWorkspaceState().busy')
        # Clean now: the series strip replaces the active cell's series without a question.
        self.series_card(page, SECOND).click()
        page.wait_for_function(SHOWS_SERIES, arg=series[SECOND], timeout=45000)
        self.assertEqual({(cell['study'], cell['series']) for cell in self.rendered(page)}, {(a.uid, series[SECOND])})

        # An unsaved Key Image: refused the same way, then saved with its own control.
        ViewerHistoryE2E.open_measurement_tools(self, page)
        page.get_by_role('button', name='Add Key Image', exact=True).click()
        key = page.locator('#kin-viewer-history section[data-kind=key]').last
        key.get_by_label('Key Title').fill('U7 KEEP KEY')
        expect(key.locator('strong')).to_contain_text('Unsaved')
        source = self.rendered(page)
        self.switch_tab(page, b, kept=True)
        self.open_from_worklist(work, page, prior, DIRTY_WINDOW)
        self.assertEqual(self.rendered(page), source)
        expect(key.get_by_label('Key Title')).to_have_value('U7 KEEP KEY')
        key.get_by_role('button', name='Save', exact=True).click()
        expect(key.locator('strong')).to_contain_text('Saved r1')
        page.wait_for_function('() => !kinViewerHistoryWorkspaceState().dirty && !kinViewerJobWorkspaceState().dirty')
        self.assertEqual(dialogs[refusals:], [])

        # Clean: B, back to A, then the comparison study. The saved work reopens; the discarded draft does not.
        self.switch_tab(page, b)
        self.switch_tab(page, a)
        ViewerHistoryE2E.open_measurement_tools(self, page)
        reopened = page.locator('#kin-viewer-history section[data-kind=key]').filter(has_text='U7 KEEP KEY')
        expect(reopened.locator('strong')).to_contain_text('Saved r1', timeout=45000)
        expect(page.locator('#kin-viewer-findings')).not_to_contain_text('U7 KEEP FINDING')
        self.open_layout_tools(page)
        expect(page.locator('#kin-viewer-jobs')).to_contain_text('U7 KEEP JOB TITLE', timeout=45000)
        self.evidence(page, 'work-saved-work-reopened')
        self.open_from_worklist(work, page, prior)
        self.assertEqual({cell['study'] for cell in self.rendered(page)}, {prior.uid})
        self.assertEqual(self.jobs(a), saved)
        self.assertEqual(self.jobs(prior), [])
        # The worklist report box follows its selected study; A's draft is back when A is selected.
        self.select(work, a)
        expect(work.locator('#findings')).to_have_value('U7 DIRTY KEEP REPORT', timeout=20000)

    def test_unsaved_05_unsaved_mpr_mark_keeps_the_window_until_reverted(self):
        # Stored before the worklist loads, so its row is listed without a refresh.
        b = self.ct('U7WM-OTHER-' + uuid.uuid4().hex[:12], 'mpr other', '20260801')
        a, work, page = self.opened_projection()
        dialogs = []
        def answer(dialog):
            dialogs.append(dialog.message)
            dialog.accept()
        page.on('dialog', answer)
        marks = self.add_mark(page, 'U7 KEEP MPR POINT')
        self.assertTrue(page.evaluate('() => kinMprMarks.dirty() && kinViewerJobWorkspaceState().dirty'))
        self.open_from_worklist(work, page, b, DIRTY_WINDOW)
        self.same_marks(page.evaluate('() => kinMprMarks.capture()'), marks)
        expect(page.locator('.kin-mpr-marks-overlay [data-mark-id]')).to_have_count(len(marks['marks']) * 3)
        self.assertEqual(dialogs, [])
        # The served-source evidence() waits on stack-image contrast; MPR planes use the plain screen capture.
        self.shot(page, 'work-dirty-mpr-mark-kept')
        self.marks(page).get_by_role('button', name='Revert All Unsaved Annotations', exact=True).click()
        self.assertFalse(page.evaluate('() => kinMprMarks.dirty()'))
        self.open_from_worklist(work, page, b)
        expect(page.get_by_role('tablist', name='Patients').get_by_role('tab').filter(has_text=b.patient_id)).to_have_attribute('aria-selected', 'true')
        self.assertEqual({cell['study'] for cell in self.rendered(page)}, {b.uid})
        self.assertEqual(self.jobs(a), [])

    def test_unsaved_06_separate_window_prev_next_and_native_thumbnail_keep_work(self):
        patient = 'U7WN-' + uuid.uuid4().hex[:12]
        a = self.multiple(patient, 'next current', '20260801')
        prior = self.ct(patient, 'next prior', '20260701')
        work, page = self.served_viewer(a)
        dialogs = []
        def answer(dialog):
            # Only the existing Frame Coverage confirm of a clean switch may ask; no refusal does.
            dialogs.append(dialog.message)
            dialog.accept()
        page.on('dialog', answer)
        # Open on Selection: the worklist report Prev/Next reopen the new selection in this separate window.
        self.open_toolbar_group(work, '#image-opening-open')
        work.locator('#image-opening-open').click()
        work.locator('#image-opening-autoload').set_checked(True)
        work.get_by_role('button', name='Done', exact=True).click()
        order = work.locator('#rows tr[data-uid]').evaluate_all('rows => rows.map(r => r.dataset.uid)')
        self.assertEqual(sorted(order), sorted([a.uid, prior.uid]))
        away, back = ('#b-next', '#b-prev') if order.index(a.uid) == 0 else ('#b-prev', '#b-next')
        self.open_toolbar_group(work, away)
        series = self.series_uids(work, a)
        self.assertEqual(len(series), 2)
        first_title = next(description for description in series if description != SECOND)
        page.evaluate("window.__u7Document = 'kept'")

        # Dirty Job title: Prev/Next moves the worklist selection, the window keeps its document and input.
        self.open_layout_tools(page)
        title = page.get_by_label('Job Title', exact=True)
        title.fill('U7 KEEP NEXT TITLE')
        self.worklist_step(work, page, away, prior, DIRTY_WINDOW)
        self.worklist_step(work, page, back, a)
        expect(title).to_have_value('U7 KEEP NEXT TITLE')

        # Busy: a held Job save; the same step waits for its real answer (released inside the 30 s bound).
        held, release = self.hold_writes(page, '**/api/studies/' + a.uid + '/viewer-jobs')
        page.locator('#kin-viewer-jobs').get_by_role('button', name='Save New Job', exact=True).first.click()
        for _ in range(100):
            if held: break
            page.wait_for_timeout(50)
        self.assertTrue(held)
        self.assertTrue(page.evaluate('kinViewerJobWorkspaceState().busy'))
        self.worklist_step(work, page, away, prior, BUSY_WINDOW)
        release()
        expect(page.locator('#kin-viewer-jobs-status')).to_contain_text('저장했습니다', timeout=45000)
        self.assertEqual([j['title'] for j in self.jobs(a)], ['U7 KEEP NEXT TITLE'])
        self.worklist_step(work, page, back, a)
        # Emptying the input is this window's explicit discard of what is now saved.
        title.fill('')
        page.wait_for_function('() => !kinViewerJobWorkspaceState().dirty && !kinViewerJobWorkspaceState().busy')

        # An unsaved arrow annotation: Prev/Next keeps it, as does a native thumbnail drop into its cell.
        ViewerHistoryE2E.open_measurement_tools(self, page)
        arrow = ViewerHistoryE2E.draw(self, page, 'U7 KEEP ARROW')
        marks = page.evaluate(ARROWS)
        self.assertEqual(len(marks), 1)
        self.assertTrue(page.evaluate('() => kinViewerHistoryWorkspaceState().dirty'))
        self.worklist_step(work, page, away, prior, DIRTY_WINDOW)
        self.worklist_step(work, page, back, a)
        self.assertEqual(page.evaluate(ARROWS), marks)
        expect(arrow.get_by_label('Annotation Text')).to_have_value('U7 KEEP ARROW')
        self.evidence(page, 'work-dirty-next-study-kept')
        self.drag(page, SECOND, 0)
        page.wait_for_function(SHOWS_SERIES, arg=series[SECOND], timeout=45000)
        self.assertEqual({(cell['study'], cell['series']) for cell in self.rendered(page)}, {(a.uid, series[SECOND])})
        self.assertEqual(page.evaluate(ARROWS), marks)
        self.assertTrue(page.evaluate('() => kinViewerHistoryWorkspaceState().dirty'))
        expect(arrow.get_by_label('Annotation Text')).to_have_value('U7 KEEP ARROW')
        self.evidence(page, 'work-dirty-thumbnail-drop-kept')
        self.drag(page, first_title, 0)
        page.wait_for_function(SHOWS_SERIES, arg=series[first_title], timeout=45000)
        self.assertEqual(page.evaluate(ARROWS), marks)
        arrow.get_by_role('button', name='Save', exact=True).click()
        expect(arrow).to_contain_text('저장 완료')
        saved = ViewerHistoryE2E.saved(self, a)
        self.assertEqual([(item['item']['label'], item['item']['points']) for item in saved], [('U7 KEEP ARROW', marks[0]['points'])])
        page.wait_for_function('() => !kinViewerHistoryWorkspaceState().dirty && !kinViewerJobWorkspaceState().dirty')
        self.assertEqual(page.evaluate('window.__u7Document'), 'kept')
        self.assertEqual(dialogs, [])

        # Clean: Prev/Next follows the selection in this window, and back again shows the saved work.
        self.worklist_step(work, page, away, prior)
        self.assertEqual({cell['study'] for cell in self.rendered(page)}, {prior.uid})
        self.worklist_step(work, page, back, a)
        ViewerHistoryE2E.open_measurement_tools(self, page)
        expect(page.locator('#kin-viewer-history section[data-kind=arrow]').filter(has_text='U7 KEEP ARROW')).to_have_count(1, timeout=45000)
        self.open_layout_tools(page)
        expect(page.locator('#kin-viewer-jobs')).to_contain_text('U7 KEEP NEXT TITLE', timeout=45000)
        self.assertEqual(self.jobs(prior), [])
        self.evidence(page, 'work-next-study-saved-work-reopened')

    def test_unsaved_07_unsaved_curved_mpr_keeps_the_window_until_saved(self):
        # Stored before the worklist loads, so its row is listed without a refresh.
        b = self.ct('U7WV-OTHER-' + uuid.uuid4().hex[:12], 'curve other', '20260801')
        a, work, page = self.opened_curved(SLOPE)
        dialogs = []
        page.on('dialog', lambda dialog: (dialogs.append(dialog.message), dialog.accept()))
        coronal = self.view(page, 1)
        page.evaluate(PLACE, [coronal, [18, 1, 40]])
        self.draw(page, coronal, [[1, 1, 15], [20, 1, 40], [36, 1, 70]])
        curve = self.final(page)['value']
        self.assertTrue(page.evaluate('() => kinMprCurved.dirty() && kinViewerJobWorkspaceState().dirty'))
        self.open_from_worklist(work, page, b, DIRTY_WINDOW)
        self.assertEqual(self.final(page)['value'], curve)
        self.assertTrue(page.evaluate('() => kinMprCurved.dirty()'))
        self.assertEqual(dialogs, [])
        self.shot(page, 'work-dirty-mpr-curve-kept')
        self.save_volume(page)
        self.assertEqual(self.get_volume_job(a)['snapshot']['curved'], curve)
        self.assertFalse(page.evaluate('() => kinMprCurved.dirty()'))
        # save_volume left its title in the input; emptying it is the explicit end of this window's work.
        page.get_by_label('Job Title', exact=True).fill('')
        page.wait_for_function('() => !kinViewerJobWorkspaceState().dirty && !kinViewerJobWorkspaceState().busy')
        self.open_from_worklist(work, page, b)
        self.assertEqual({cell['study'] for cell in self.rendered(page)}, {b.uid})
        self.assertEqual(self.jobs(b), [])

    def test_unsaved_08_unsaved_3d_path_keeps_the_window_until_cleared(self):
        b = self.ct('U7WP-OTHER-' + uuid.uuid4().hex[:12], 'path other', '20260801')
        a, work, page = self.opened_path()
        dialogs = []
        page.on('dialog', lambda dialog: (dialogs.append(dialog.message), dialog.accept()))
        self.add_path(page, [(2, [20, 15, 30], [6, 8, 30]), (1, [20, 20, 40], [16, 20, 40]), (0, [26, 15, 50], [26, 12, 52])])
        path = self.path_final(page)['value']
        self.assertTrue(page.evaluate('() => kinMprPath.dirty() && kinViewerJobWorkspaceState().dirty'))
        self.open_from_worklist(work, page, b, DIRTY_WINDOW)
        self.assertEqual(self.path_final(page)['value'], path)
        self.assertTrue(page.evaluate('() => kinMprPath.dirty()'))
        self.assertEqual(dialogs, [])
        self.shot(page, 'work-dirty-mpr-path-kept')
        # Nothing was saved, so Clear Path is this window's explicit discard.
        self.path_button(page, 'Clear Path').click()
        page.wait_for_function('() => !kinMprPath.dirty() && !kinViewerJobWorkspaceState().dirty')
        self.open_from_worklist(work, page, b)
        self.assertEqual({cell['study'] for cell in self.rendered(page)}, {b.uid})
        self.assertEqual(self.jobs(a), [])

    def test_unsaved_09_held_job_save_through_every_in_viewer_replacement(self):
        """Every in-viewer consumer that can replace the shown images, tried while a real Job save is in flight.

        Guarded consumers refuse and keep the screen. Unguarded native ones may proceed, but the held save
        must still store what was shown at its click and keep the typed work until it lands."""
        patient = 'U7WB-' + uuid.uuid4().hex[:12]
        a = self.multiple(patient, 'busy current', '20260801')
        self.ct(patient, 'busy prior', '20260701')
        work, page = self.served_viewer(a)
        work.locator('#findings').fill('U7 BUSY KEEP REPORT')
        dialogs = []
        def answer(dialog):
            dialogs.append(dialog.message)
            dialog.accept()
        page.on('dialog', answer)
        series = self.series_uids(work, a)
        first_title = next(description for description in series if description != SECOND)
        first, second = series[first_title], series[SECOND]
        cells = lambda shown: [(cell['study'], cell['series'], cell['sop']) for cell in shown]

        # Clean set-up, without questions: a saved arrow on the second series is the Go to Image target,
        # a Recent Layout keeps the two series swapped, and the reading grid is first | second.
        self.series_card(page, SECOND).click()
        page.wait_for_function(SERIES_ORDER, arg=[second], timeout=45000)
        ViewerHistoryE2E.open_measurement_tools(self, page)
        arrow = ViewerHistoryE2E.draw(self, page, 'U7 BUSY GO TO')
        arrow.get_by_role('button', name='Save', exact=True).click()
        expect(arrow).to_contain_text('저장 완료')
        saved_arrow = ViewerHistoryE2E.saved(self, a)
        select_image_tool(page, 'Pan')
        self.series_card(page, first_title).click()
        page.wait_for_function(SERIES_ORDER, arg=[first], timeout=45000)
        self.grid(page, 2)
        self.drag(page, SECOND, 0)
        self.drag(page, first_title, 1)
        page.wait_for_function(SERIES_ORDER, arg=[second, first], timeout=45000)
        self.action(page, '저장', '저장했습니다')
        self.drag(page, first_title, 0)
        self.drag(page, SECOND, 1)
        page.wait_for_function(SERIES_ORDER, arg=[first, second], timeout=45000)
        self.open_layout_tools(page)
        expect(page.get_by_role('heading', name='Hanging Protocols', exact=True)).to_be_visible(timeout=45000)
        page.locator('#kin-hp-import').set_input_files({'name': 'u7-busy-rules.json', 'mimeType': 'application/json',
                                                        'buffer': json.dumps(HP_RULES).encode('utf-8')})
        expect(page.locator('#kin-hp-status')).to_contain_text('초안으로 가져왔습니다')
        expect(page.locator('#kin-cell-merge')).to_be_visible(timeout=45000)
        self.activate(page, 0)
        # The imported rule's selector editor has Description fields of its own.
        jobs = page.locator('#kin-viewer-jobs')
        title, description = jobs.get_by_label('Job Title', exact=True), jobs.get_by_label('Description', exact=True)
        self.assertEqual(dialogs, [])

        # Save 1 held: the guarded consumers refuse and keep the screen and the typed work.
        title.fill('U7 BUSY FIRST')
        description.fill('U7 busy first description')
        source = self.rendered(page)
        release = self.hold_job_save(page, page, a)
        self.refuse_series(page)
        for control in ('#kin-hp-apply', '#kin-hp-next'):
            page.locator(control).click()
            expect(page.locator('#kin-hp-status')).to_contain_text(HP_KEPT)
            page.wait_for_timeout(500)
            self.assertEqual(self.rendered(page), source)
        page.locator('#kin-cell-merge [data-cell-merge="maximize"]').click()
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text(MERGE_KEPT)
        self.assertEqual(page.evaluate('services.viewportGridService.getState().viewports.size'), 2)
        studies = ViewerUXPriorsE2E.studies(self, page)
        studies.get_by_role('button', name='D03A busy prior', exact=True).click()
        expect(studies).to_contain_text(PRIOR_KEPT, timeout=20000)
        self.assertEqual(self.rendered(page), source)
        expect(title).to_have_value('U7 BUSY FIRST')
        expect(description).to_have_value('U7 busy first description')
        self.evidence(page, 'work-busy-save-guarded-replacements-kept')
        sent = release()
        self.assertEqual([j['title'] for j in self.jobs(a)], ['U7 BUSY FIRST'])
        self.assertEqual(self.stored_cells(a, sent), cells(source))
        # The landed save clears its own inputs; nothing else is unsaved now.
        page.wait_for_function('() => !kinViewerJobWorkspaceState().dirty && !kinViewerHistoryWorkspaceState().dirty')

        # Save 2 held: Restore Job waits; Go to Image, a native thumbnail drop, Restore Recent Layout and the
        # Layout menu proceed. Each keeps the typed work, and the save stores the screen of its click.
        self.activate(page, 0)
        title.fill('U7 BUSY SECOND')
        source = self.rendered(page)
        release = self.hold_job_save(page, page, a)
        expect(page.locator('#kin-viewer-jobs').get_by_role('button', name='Restore Job', exact=True).first).to_be_disabled()
        ViewerHistoryE2E.open_measurement_tools(self, page)
        page.locator('#kin-viewer-history section[data-kind=arrow]').filter(has_text='U7 BUSY GO TO') \
            .get_by_role('button', name='Go to Image', exact=True).click()
        page.wait_for_function(SERIES_ORDER, arg=[second, second], timeout=20000)
        self.drag(page, first_title, 0)
        page.wait_for_function(SERIES_ORDER, arg=[first, second], timeout=20000)
        self.action(page, '복원', '적용했습니다')
        page.wait_for_function(SERIES_ORDER, arg=[second, first], timeout=20000)
        self.grid(page, 1)
        page.wait_for_function(SERIES_ORDER, arg=[second], timeout=20000)
        expect(title).to_have_value('U7 BUSY SECOND')
        self.assertTrue(page.evaluate('kinViewerJobWorkspaceState().busy'))
        self.assertEqual(dialogs, [])
        sent = release()
        self.assertEqual(sorted(j['title'] for j in self.jobs(a)), ['U7 BUSY FIRST', 'U7 BUSY SECOND'])
        self.assertEqual(self.stored_cells(a, sent), cells(source))
        self.assertEqual(ViewerHistoryE2E.saved(self, a), saved_arrow)
        page.wait_for_function('() => !kinViewerJobWorkspaceState().dirty && !kinViewerHistoryWorkspaceState().dirty')
        self.evidence(page, 'work-busy-save-native-replacements-landed')

        # Save 3 held: after a real renderer loss, Reload Viewer waits; once the save lands it reloads.
        self.open_layout_tools(page)
        title.fill('U7 BUSY THIRD')
        source = self.rendered(page)
        release = self.hold_job_save(page, page, a)
        document = page.evaluate('performance.timeOrigin')
        page.evaluate(LOSS)
        recovery = page.locator('section[aria-label="Viewer Recovery"]').last
        expect(recovery).to_be_visible(timeout=20000)
        recovery.get_by_role('button', name='Reload Viewer', exact=True).click()
        expect(recovery.get_by_role('status')).to_contain_text(RELOAD_KEPT)
        self.assertEqual(page.evaluate('performance.timeOrigin'), document)
        expect(title).to_have_value('U7 BUSY THIRD')
        self.assertEqual(dialogs, [])
        sent = release()
        self.assertEqual(self.stored_cells(a, sent), cells(source))
        page.wait_for_function('() => !kinViewerJobWorkspaceState().dirty && !kinViewerJobWorkspaceState().busy')
        # Clean now: the same button reloads this viewer, which lists the three saved Jobs and the saved arrow.
        recovery.get_by_role('button', name='Reload Viewer', exact=True).click()
        page.wait_for_function('previous => performance.timeOrigin !== previous', arg=document, timeout=60000)
        canvas_ready(page, 1)
        self.open_layout_tools(page)
        for saved_title in ('U7 BUSY FIRST', 'U7 BUSY SECOND', 'U7 BUSY THIRD'):
            expect(page.locator('#kin-viewer-jobs')).to_contain_text(saved_title, timeout=45000)
        ViewerHistoryE2E.open_measurement_tools(self, page)
        expect(page.locator('#kin-viewer-history section[data-kind=arrow]').filter(has_text='U7 BUSY GO TO')).to_have_count(1, timeout=45000)
        expect(work.locator('#findings')).to_have_value('U7 BUSY KEEP REPORT')
        self.evidence(page, 'work-busy-save-reload-reopened')

    def test_unsaved_10_embedded_workspace_waits_for_a_held_job_save(self):
        a = self.ct('U7WE-' + uuid.uuid4().hex[:12], 'embedded busy', '20260801')
        b = self.ct('U7WE-OTHER-' + uuid.uuid4().hex[:12], 'embedded other', '20260801')
        self.seed_report(a)
        self.seed_report(b)
        work = self.login()
        work.set_viewport_size(dict(width=1680, height=1100))
        dialogs = []
        def answer(dialog):
            dialogs.append(dialog.message)
            dialog.accept()
        work.on('dialog', answer)
        frame = self.workspace(work, a, count=1)
        frame.get_by_role('button', name='Comparison', exact=True).click()
        title = frame.get_by_label('Job Title', exact=True)
        title.fill('U7 EMBEDDED BUSY TITLE')
        source = self.rendered(frame)
        release = self.hold_job_save(work, frame, a)
        # Selecting another study asks the workspace to replace its viewer while the save is in flight.
        self.choose(work, b)
        expect(work.locator('#reading-target')).to_contain_text(b.uid)
        expect(work.locator('#reading-status')).to_contain_text(WORKSPACE_KEPT)
        # A save in flight offers no discard.
        expect(work.get_by_role('button', name='Discard Viewer Changes & Open', exact=True)).to_be_hidden()
        self.assertEqual(self.rendered(frame), source)
        expect(title).to_have_value('U7 EMBEDDED BUSY TITLE')
        work.get_by_role('button', name='Return to Previous Viewer', exact=True).click()
        expect(work.locator('#reading-target')).to_contain_text(a.uid)
        expect(work.locator('#reading-frame')).to_be_visible()
        self.assertEqual(self.rendered(frame), source)
        self.assertEqual(dialogs, [])
        self.shot(work, 'work-busy-save-embedded-kept')
        sent = release()
        self.assertEqual([j['title'] for j in self.jobs(a)], ['U7 EMBEDDED BUSY TITLE'])
        self.assertEqual(self.stored_cells(a, sent), [(c['study'], c['series'], c['sop']) for c in source])
        frame.wait_for_function('() => !kinViewerJobWorkspaceState().dirty && !kinViewerJobWorkspaceState().busy')
        # Clean now: the same selection replaces the embedded viewer.
        self.choose(work, b)
        expect(work.locator('#reading-status')).to_have_text('영상 작업공간 연결됨', timeout=60000)
        replaced = work.locator('#reading-frame').element_handle().content_frame()
        canvas_ready(replaced, 1)
        self.assertEqual({cell['study'] for cell in self.rendered(replaced)}, {b.uid})
        self.assertEqual(self.jobs(b), [])


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(S9ViewerUnsavedFlowE2E(name) for name in loader.getTestCaseNames(S9ViewerUnsavedFlowE2E)
                              if name.startswith('test_unsaved_'))


if __name__ == '__main__': unittest.main(verbosity=2)
