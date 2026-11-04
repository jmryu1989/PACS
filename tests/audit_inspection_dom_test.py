"""REQ-EMR-15/19 -> RISK-F-05 -> TEST-AUDIT-INSPECTION.

Real page/session scripts and real Node controller/service/contract; synthetic storage only.
"""
import json
from datetime import datetime, timezone
import subprocess
import unittest
from urllib.parse import urlparse

from playwright.sync_api import expect
from audit_page_dom_test import AuditPage, ROOT


class MonthlyInspection(AuditPage):
    # Reuse the browser/session fixture without rerunning its test cases.
    def setUp(self):
        super().setUp()
        self.backend = subprocess.Popen(['node', 'tests/emr/f/inspection_harness.cjs'], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        self.inspection_calls = []
        self.inspection_reply = None

    def tearDown(self):
        self.backend.stdin.close()
        self.backend.wait(timeout=15)
        errors = self.backend.stderr.read()
        self.backend.stdout.close(); self.backend.stderr.close()
        super().tearDown()
        self.assertEqual(errors, '')
        self.assertEqual(self.backend.returncode, 0)

    def backend_call(self, **query):
        self.backend.stdin.write(json.dumps(query) + '\n'); self.backend.stdin.flush()
        return json.loads(self.backend.stdout.readline())

    def api(self, route):
        path = urlparse(route.request.url).path
        if not path.startswith('/api/emr-audit/inspections'):
            return super().api(route)
        body = route.request.post_data_json if route.request.method == 'POST' else None
        self.inspection_calls.append((route.request.method, path, body))
        if self.inspection_reply:
            reply, self.inspection_reply = self.inspection_reply, None
            if reply == 'hold': self.held.append(route); return
            route.fulfill(status=reply[0], json=reply[1]); return
        parts = path.split('/')
        method = 'inspectionMonths' if len(parts) == 4 else 'inspection' if len(parts) == 5 else (
            'inspectionReport' if parts[-1] == 'report' else 'inspectionStep')
        reply = self.backend_call(method=method, month=parts[4] if len(parts) > 4 else None, body=body)
        if method == 'inspectionReport' and reply['status'] == 200:
            self.started_event_ids = [event['eventId'] for event in reply['body']['downloads']]
        if method == 'inspectionStep' and reply['status'] == 200:
            reply['body'] = {key: reply['body'][key] for key in ('cycle', 'status')}
        route.fulfill(status=reply['status'], json=reply['body'])

    def months(self):
        self.open()
        self.assertEqual(self.inspection_calls, [])
        self.page.get_by_role('button', name='Load Months', exact=True).click()
        expect(self.page.get_by_role('combobox', name='Inspection Month', exact=True)).to_contain_text('2026-10')
        self.page.get_by_role('combobox', name='Inspection Month', exact=True).select_option('2026-10')
        expect(self.page.get_by_role('button', name='Start Inspection', exact=True)).to_be_enabled()

    def start(self):
        self.months()
        self.page.get_by_role('button', name='Start Inspection', exact=True).click()
        expect(self.page.get_by_role('region', name='Monthly Inspection')).to_contain_text('Event Count: 3')
        expect(self.page.get_by_role('button', name='Finish', exact=True)).to_be_enabled()

    def test_month_list_start_record_finish_and_reopen_snapshot(self):
        self.start()
        section = self.page.get_by_role('region', name='Monthly Inspection')
        expect(section).to_contain_text('시작할 때')
        expect(section).to_contain_text('기한이 지난 달도')
        expect(section).to_contain_text('Asia/Seoul')
        row = self.page.get_by_role('group', name='Download SYN-0', exact=True)
        downloads = section.get_by_role('group', name='Download SYN-', exact=False)
        download_ids = self.started_event_ids
        expect(downloads).to_have_count(len(download_ids))
        for event_id in download_ids:
            expect(section.get_by_role('group', name=f'Download {event_id}', exact=True)).to_be_visible()
        row.get_by_label('Reason Check', exact=True).fill('요청 사유 <b>확인</b>')
        row.get_by_label('Follow-up', exact=True).fill('추가 조치 없음')
        other = self.page.get_by_role('group', name='Download SYN-1', exact=True)
        other.get_by_label('Reason Check', exact=True).fill('아직 기록하지 않은 사유')
        other.get_by_label('Follow-up', exact=True).fill('다른 행의 후속조치 입력')
        row.get_by_role('button', name='Record', exact=True).click()
        expect(section).to_contain_text('확인 기록을 추가했습니다.')
        expect(downloads).to_have_count(len(download_ids))
        for event_id in download_ids:
            expect(section.get_by_role('group', name=f'Download {event_id}', exact=True)).to_be_visible()
        expect(section.locator('#audit-inspection-history')).to_contain_text('요청 사유 <b>확인</b>')
        expect(section).to_contain_text('추가 조치 없음')
        expect(other.get_by_label('Reason Check', exact=True)).to_have_value('아직 기록하지 않은 사유')
        expect(other.get_by_label('Follow-up', exact=True)).to_have_value('다른 행의 후속조치 입력')
        expect(row.get_by_label('Reason Check', exact=True)).to_have_value('')
        self.assertEqual(section.locator('b').count(), 0)
        writes = [c for c in self.inspection_calls if c[0] == 'POST']
        self.assertEqual([c[1].split('/')[-1] for c in writes], ['report', 'steps'])
        self.assertEqual(writes[-1][2]['outcome'], 'legitimate')
        report = self.backend_call(method='inspection', month='2026-10')['body']['cycle']['events'][0]
        expect(section).to_contain_text(report['reportSha256'])
        before = len(self.inspection_calls)
        self.page.get_by_role('button', name='Finish', exact=True).click()
        expect(section).to_contain_text('화면에서 점검 작업을 마쳤습니다.')
        expect(section).to_contain_text('추가 기록은 저장하지 않았습니다.')
        expect(section).to_contain_text(report['reportSha256'])
        self.assertEqual(len(self.inspection_calls), before)
        self.screenshot('monthly-finished.png')
        self.page.reload()
        self.page.get_by_role('button', name='Load Months', exact=True).click()
        self.page.get_by_role('combobox', name='Inspection Month', exact=True).select_option('2026-10')
        expect(section).to_contain_text('추가 조치 없음')
        expect(section).to_contain_text(report['reportSha256'])
        self.assertEqual(section.get_by_role('button', name='Delete', exact=True).count(), 0)
        self.assertEqual(section.get_by_role('button', name='Edit', exact=True).count(), 0)
        self.screenshot('monthly-reopened.png')

    def test_scope_denial_keeps_patient_search_and_designation_denial_clears_all(self):
        self.backend_call(reset=True, scopes=['investigate'])
        self.open()
        self.page.get_by_role('button', name='Load Months', exact=True).click()
        expect(self.page.get_by_text('이 계정에는 월간 점검 권한이 없습니다.', exact=True)).to_be_visible()
        expect(self.page.get_by_role('button', name='Search', exact=True)).to_be_enabled()
        self.backend_call(reset=True, scopes=[])
        self.page.get_by_role('button', name='Load Months', exact=True).click()
        expect(self.document_status()).to_have_text('감사 기록을 조회할 권한이 없습니다.')
        self.assertEqual(self.page.locator('body').inner_text(), '감사 기록을 조회할 권한이 없습니다.')

    def test_missing_investigate_scope_does_not_block_inspection(self):
        self.open()
        self.search(dict(code='AuditScopeNotGranted'), 403)
        self.page.get_by_role('button', name='Load Months', exact=True).click()
        self.page.get_by_role('combobox', name='Inspection Month', exact=True).select_option('2026-10')
        self.page.get_by_role('button', name='Start Inspection', exact=True).click()
        expect(self.page.get_by_role('region', name='Monthly Inspection')).to_contain_text('Event Count: 3')

    def test_stale_month_and_logout_responses_are_discarded(self):
        self.start()
        old = self.backend_call(method='inspection', month='2026-10')['body']
        month = self.page.get_by_role('combobox', name='Inspection Month', exact=True)
        month.select_option('2026-09')
        expect(self.page.get_by_role('button', name='Start Inspection', exact=True)).to_be_enabled()
        self.inspection_reply = 'hold'
        with self.page.expect_request(lambda r: r.url.endswith('/inspections/2026-10')):
            month.select_option('2026-10')  # Hold first A, not B.
        month.select_option('2026-09')
        expect(self.page.get_by_role('button', name='Start Inspection', exact=True)).to_be_enabled()
        month.select_option('2026-10')
        expect(self.page.get_by_role('region', name='Monthly Inspection')).to_contain_text('Event Count: 3')
        old['summary']['eventCount'] = 777
        old['cycle']['events'][0]['eventCount'] = 777
        with self.page.expect_response(lambda r: r.url.endswith('/inspections/2026-10')):
            self.held.pop().fulfill(json=old)
        # Wait for the released fetch and its rendering opportunity before the negative assertion.
        self.page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        expect(self.page.get_by_role('region', name='Monthly Inspection')).not_to_contain_text('777')
        self.inspection_reply = 'hold'
        self.page.get_by_role('combobox', name='Inspection Month', exact=True).select_option('2026-09')
        self.page.get_by_role('button', name='Log out', exact=True).click()
        self.held.pop().fulfill(json=old)
        expect(self.page.locator('body')).not_to_contain_text('SYN-0')

    def test_month_options_show_state_and_overdue_without_blocking(self):
        self.page.clock.install(time=datetime(2026, 11, 2, tzinfo=timezone.utc))
        self.backend_call(method='inspectionReport', month='2026-09')
        self.months()
        month = self.page.get_by_role('combobox', name='Inspection Month', exact=True)
        expect(month.get_by_role('option', name='2026-09 — Report Only · 기한 경과', exact=True)).to_be_enabled()
        expect(month.get_by_role('option', name='2026-10 — Awaiting Report', exact=True)).to_be_enabled()
        month.select_option('2026-09')
        expect(self.page.get_by_role('button', name='Finish', exact=True)).to_be_enabled()
        self.screenshot('monthly-overdue.png')

    def test_inspection_timeout_reports_timeout_and_preserves_step_input(self):
        self.start()
        section = self.page.get_by_role('region', name='Monthly Inspection')
        row = self.page.get_by_role('group', name='Download SYN-0', exact=True)
        row.get_by_label('Reason Check', exact=True).fill('확인 중')
        row.get_by_label('Follow-up', exact=True).fill('담당자 확인')
        self.inspection_reply = (503, dict(code='InvestigationTimedOut'))
        row.get_by_role('button', name='Record', exact=True).click()
        expect(section).to_contain_text('월간 점검 처리 시간이 초과되었습니다.')
        expect(section).not_to_contain_text('연결 상태')
        expect(row.get_by_label('Follow-up', exact=True)).to_have_value('담당자 확인')
        self.inspection_reply = (503, dict(code='InvestigationTimedOut'))
        self.page.get_by_role('combobox', name='Inspection Month', exact=True).select_option('2026-09')
        expect(section).to_contain_text('월간 점검 처리 시간이 초과되었습니다.')
        expect(section).not_to_contain_text('조건을 좁혀')

    def test_failed_step_keeps_input_and_follow_up_contract_round_trip(self):
        self.start()
        section = self.page.get_by_role('region', name='Monthly Inspection')
        row = self.page.get_by_role('group', name='Download SYN-0', exact=True)
        row.get_by_label('Reason Check', exact=True).fill('사유 확인 필요')
        row.get_by_role('combobox', name='Outcome', exact=True).select_option('investigate')
        row.get_by_label('Follow-up', exact=True).fill('담당자 확인 요청')
        self.inspection_reply = (500, dict(code='StorageFailed'))
        row.get_by_role('button', name='Record', exact=True).click()
        expect(section).to_contain_text('기록 응답을 확인하지 못했습니다.')
        expect(row.get_by_label('Follow-up', exact=True)).to_have_value('담당자 확인 요청')
        row.get_by_role('button', name='Record', exact=True).click()
        expect(section).to_contain_text('담당자 확인 요청')
        investigation = section.get_by_role('group', name='Open Follow-up', exact=True)
        investigation.get_by_label('Recheck Note', exact=True).fill('담당자 확인 완료')
        investigation.get_by_role('combobox', name='Result', exact=True).select_option('resolved')
        investigation.get_by_role('button', name='Record', exact=True).click()
        expect(investigation).to_have_count(0)
        review = section.get_by_role('group', name='Review', exact=True)
        review.get_by_label('Review Note', exact=True).fill('전체 접속기록 확인')
        review.get_by_role('button', name='Record', exact=True).click()
        expect(section).to_contain_text('전체 접속기록 확인')
        self.screenshot('monthly-follow-up.png')


if __name__ == '__main__':
    # Base class is an imported fixture; select this unit's tests only.
    names = [name for name in MonthlyInspection.__dict__ if name.startswith('test_')]
    suite = unittest.TestSuite(MonthlyInspection(name) for name in names)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())
