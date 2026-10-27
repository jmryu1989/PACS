"""U7 W1-W3/W5: real saved receipts, loss recovery and dirty grid preservation."""
import unittest
import uuid
from playwright.sync_api import expect
from test_s9_viewer_output_scope import ServedViewerFlow
from test_viewer_jobs import ViewerJobsE2E
from test_viewer_history import ViewerHistoryE2E


class S9ViewerUnsavedFlowE2E(ServedViewerFlow, ViewerJobsE2E):
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


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(S9ViewerUnsavedFlowE2E(name) for name in loader.getTestCaseNames(S9ViewerUnsavedFlowE2E)
                              if name.startswith('test_unsaved_'))


if __name__ == '__main__': unittest.main(verbosity=2)
