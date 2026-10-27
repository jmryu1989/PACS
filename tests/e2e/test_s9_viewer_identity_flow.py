"""U7 I1-I4: served tabs, viewport identity and immutable reading target."""
import unittest
import uuid
import re
from unittest.mock import patch
from pynetdicom.association import Association
from playwright.sync_api import expect
from test_s9_viewer_output_scope import ServedViewerFlow
from test_viewer_ux_priors import ViewerUXPriorsE2E
from test_prior_selection import canvas_ready


class S9ViewerIdentityFlowE2E(ServedViewerFlow, ViewerUXPriorsE2E):
    def test_identity_flow_01_same_name_dates_and_dynamic_comparison(self):
        patient = 'U7I-' + uuid.uuid4().hex[:12]
        long_name = '김영상판독확인용긴환자이름한글표시확인^테스트'
        send = Association.send_c_store
        def named_ct(association, dataset, *args, **kwargs):
            dataset.PatientName = long_name
            return send(association, dataset, *args, **kwargs)
        # Set the real synthetic DICOM before C-STORE, not the browser metadata.
        with patch.object(Association, 'send_c_store', named_ct):
            current = self.ct(patient, 'id current', '20260801')
            prior = self.ct(patient, 'id prior', '20260701')
            same = self.ct(patient, 'id same day', '20260801')
            unknown = self.ct(patient, 'id undated', '')
            other = self.ct('U7I-OTHER-' + uuid.uuid4().hex[:12], 'id same name', '20260701')
        work, page = self.served_viewer(current)
        work.locator('#findings').fill('U7 IDENTITY KEEP REPORT')
        panel = self.studies(page)
        expect(self.row(panel, 'id prior')).to_contain_text('Prior')
        expect(self.row(panel, 'id same day')).not_to_contain_text('Prior')
        expect(self.row(panel, 'id undated')).to_contain_text('Unknown-date Comparison')
        expect(panel).not_to_contain_text(other.patient_id)
        panel.get_by_role('button', name='D03A id prior', exact=True).click()
        self.identity(page, [self.fixture_refs(page, current)[0], self.fixture_refs(page, prior)[0]])
        for index, fixture in enumerate([current, prior]):
            bar = page.get_by_role('region', name='Viewport Information').nth(index)
            expect(bar).to_contain_text(patient)
            expect(bar.get_by_title(re.compile(re.escape(long_name)))).to_have_count(1)
            overlay = page.locator('.kin-viewer-identity[data-study="' + fixture.uid + '"]')
            expect(overlay).to_be_visible()
            expect(overlay).to_contain_text(patient)
            expect(overlay).to_contain_text(long_name.split('^')[0])
        self.evidence(page, 'identity-current-dynamic-prior')
        expect(work.locator('#rows tr.sel')).to_have_attribute('data-uid', current.uid)
        expect(work.locator('#findings')).to_have_value('U7 IDENTITY KEEP REPORT')

    def test_identity_flow_02_real_editor_connection_and_closed_window(self):
        current = self.ct('U7I-' + uuid.uuid4().hex[:12], 'editor link', '20260801')
        work, page = self.served_viewer(current)
        work.locator('#findings').fill('U7 REAL WORKSPACE DRAFT')
        self.open_layout_tools(page)
        page.get_by_role('button', name='Print Current View', exact=True).click()
        status = page.locator('#kin-job-print [role=status]')
        expect(status).to_contain_text('미리보기 내용을 확인', timeout=45000)
        self.evidence(page, 'identity-editor-choice-before-read')
        page.get_by_label('함께 출력할 판독문', exact=True).select_option('editor')
        expect(status).to_contain_text('미리보기 내용을 확인', timeout=45000)
        paper = page.frame_locator('#kin-job-print iframe')
        expect(paper.locator('main')).to_contain_text('U7 REAL WORKSPACE DRAFT')
        expect(paper.locator('main')).to_contain_text('저장·승인되지 않음')
        expect(work.locator('#findings')).to_have_value('U7 REAL WORKSPACE DRAFT')
        self.evidence(page, 'identity-real-editor-link')
        work.close()
        page.locator('#kin-job-print').get_by_role('button', name='다시 확인', exact=True).click()
        expect(status).to_contain_text('연결된 판독 화면이 없습니다', timeout=45000)
        expect(page.locator('#kin-job-print').get_by_role('button', name='인쇄 / PDF')).to_be_disabled()
        expect(paper.locator('body')).not_to_contain_text('U7 REAL WORKSPACE DRAFT')
        self.evidence(page, 'identity-editor-closed')

    def test_identity_flow_03_clinician_launch_retains_read_only_identity(self):
        current = self.ct('U7I-CL-' + uuid.uuid4().hex[:12], 'read only', '20260801')
        self.seed_report(current, 'approve')
        actor = 'u7-clinician'
        self.stack.create_test_identity(actor, ['clinician'], 'hallym')
        context = self.browser.new_context(ignore_https_errors=True)
        self.contexts.append(context)
        home = context.new_page()
        home.goto(self.stack.proxy + '/')
        home.locator('#username').fill(self.stack.username(actor))
        home.locator('#password').fill(self.stack.passwords[actor])
        home.locator('#kc-login').click()
        home.wait_for_url('**/worklist/hpacs-lite/clinician.html')
        home.locator('#studies tr[data-uid="' + current.uid + '"]').click()
        with context.expect_page() as opened: home.locator('#open-viewer').click()
        page = opened.value
        canvas_ready(page, 1)
        expect(page.get_by_role('region', name='Viewport Information')).to_contain_text(current.patient_id)
        expect(page.get_by_role('tablist', name='Patients')).to_contain_text(current.patient_id)
        overlay = page.locator('.kin-viewer-identity[data-study="' + current.uid + '"]')
        expect(overlay).to_be_visible(timeout=45000)
        expect(overlay).to_contain_text(current.patient_id)
        expect(page.locator('#kin-viewer-history')).to_contain_text('읽기 전용')
        expect(page.get_by_role('button', name='Add Key Image', exact=True)).to_have_count(0)
        expect(page.get_by_role('button', name='Capture', exact=True)).to_have_count(0)
        expect(page.get_by_label('Job Title', exact=True)).to_have_count(0)
        expect(page.locator('#kin-viewer-note-open')).to_have_count(0)
        self.evidence(page, 'identity-clinician-read-only')


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(S9ViewerIdentityFlowE2E(name) for name in loader.getTestCaseNames(S9ViewerIdentityFlowE2E)
                              if name.startswith('test_identity_flow_'))


if __name__ == '__main__': unittest.main(verbosity=2)
