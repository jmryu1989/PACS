"""U7 W1-W5: real saved receipts, loss recovery, and dirty/busy work kept across replacement paths."""
import unittest
import uuid
from playwright.sync_api import expect
from test_s9_viewer_output_scope import ServedViewerFlow, BUSY_WINDOW, DIRTY_WINDOW
from test_viewer_history import ViewerHistoryE2E
# The MPR mark, curve and path cases need the volume launch and drawing helpers; this family already
# contains VolumeMarksE2E and ViewerJobsE2E.
from test_volume_curved import SLOPE, PLACE
from test_volume_path import VolumePathE2E

# Existing guard notices: patient tabs (viewer-patient-tabs.js) and the series strip (viewer-series-strip.js).
TAB_KEPT = '저장·편집을 마친 뒤 환자를 전환하세요'
SERIES_KEPT = '미저장 작업을 저장하거나 편집을 마친 뒤 시리즈를 여세요'
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
        sent = []
        def lost_receipt(route):
            if route.request.method != 'POST': return route.continue_()
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
        page.unroute(path, lost_receipt)
        self.click_job(page, 'Retry Request', '저장했습니다')
        self.assertEqual([j['id'] for j in self.jobs(current)], [sent[0]['id']])
        expect(work.locator('#findings')).to_have_value('U7 WORK KEEP REPORT')

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
        path, held = '**/api/studies/' + a.uid + '/viewer-jobs', []
        def hold(route):
            if route.request.method != 'POST': return route.continue_()
            held.append((route, route.fetch()))
        page.route(path, hold)
        page.locator('#kin-viewer-jobs').get_by_role('button', name='Save New Job', exact=True).first.click()
        for _ in range(100):
            if held: break
            page.wait_for_timeout(50)
        self.assertTrue(held)
        self.assertTrue(page.evaluate('kinViewerJobWorkspaceState().busy'))
        self.open_from_worklist(work, page, b, BUSY_WINDOW)
        self.switch_tab(page, b, kept=True)
        for route, response in held: route.fulfill(response=response)
        page.unroute(path, hold)
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
        path, held = '**/api/studies/' + a.uid + '/viewer-jobs', []
        def hold(route):
            if route.request.method != 'POST': return route.continue_()
            held.append((route, route.fetch()))
        page.route(path, hold)
        page.locator('#kin-viewer-jobs').get_by_role('button', name='Save New Job', exact=True).first.click()
        for _ in range(100):
            if held: break
            page.wait_for_timeout(50)
        self.assertTrue(held)
        self.assertTrue(page.evaluate('kinViewerJobWorkspaceState().busy'))
        self.worklist_step(work, page, away, prior, BUSY_WINDOW)
        for route, response in held: route.fulfill(response=response)
        page.unroute(path, hold)
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


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(S9ViewerUnsavedFlowE2E(name) for name in loader.getTestCaseNames(S9ViewerUnsavedFlowE2E)
                              if name.startswith('test_unsaved_'))


if __name__ == '__main__': unittest.main(verbosity=2)
