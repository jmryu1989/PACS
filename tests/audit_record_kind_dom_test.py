"""REQ-EMR-16/17 -> RISK-F-03/04 -> TEST-AUDIT-RECORD-KIND.

Real page + real F service/contract over native_harness.cjs: one Study UID holds both a Tech Note and a native
report. An unselected copy or rights request is refused with guidance and stores nothing; Record Type selects one.
"""
import json
import subprocess
import unittest
from urllib.parse import urlparse, unquote

from playwright.sync_api import expect
from audit_page_dom_test import AuditPage, ROOT
import audit_disclosure_dom_test as disclosure

UID = '2.25.7001'
GUIDANCE = '같은 기록 ID에 판독문과 임상 기록(Tech Note 등)이 함께 저장되어 있습니다.'


class RecordKindSelection(AuditPage):
    def setUp(self):
        super().setUp()
        self.backend = subprocess.Popen(['node', 'tests/emr/f/native_harness.cjs'], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        self.calls = []

    def tearDown(self):
        self.backend.stdin.close(); self.backend.wait(timeout=15)
        errors = self.backend.stderr.read()
        self.backend.stdout.close(); self.backend.stderr.close()
        super().tearDown()
        self.assertEqual(errors, '')
        self.assertEqual(self.backend.returncode, 0)

    backend_call = disclosure.RecordCopyRequests.backend_call

    def api(self, route):
        path = urlparse(route.request.url).path
        body = route.request.post_data_json if route.request.post_data else None
        parts = path.split('/')
        if path.startswith('/api/emr-audit/rights-requests'):
            method = ('listRights' if route.request.method == 'GET' else 'receiveRights') if len(parts) == 4 else (
                'readRights' if len(parts) == 5 else {'decide': 'decideRights', 'notify': 'notifyRights'}[parts[-1]])
        elif path.startswith(('/api/emr-audit/requests', '/api/emr-audit/issuances')):
            method = ('register' if parts[3] == 'requests' else 'prepare') if len(parts) == 4 else (
                ('state' if parts[3] == 'requests' else 'issuance') if len(parts) == 5 else parts[-1])
        else:
            return super().api(route)
        self.calls.append((route.request.method, path, body))
        reply = self.backend_call(method=method, id=unquote(parts[4]) if len(parts) > 4 else None, body=body)
        route.fulfill(status=reply['status'], json=reply['body'])

    def posted(self, path):
        return [body for method, p, body in self.calls if method == 'POST' and p == path][-1]

    def fill_copy(self, request_id):
        section = self.page.get_by_role('region', name='Record Copy Requests', exact=True)
        section.get_by_label('Request ID', exact=True).fill(request_id)
        fields = {'Copy Patient ID': 'SYN-PATIENT', 'Copy Assigning Authority': 'SYN-SITE', 'Patient Link ID': 'SYN-LINK',
            'Requester Name': '합성 요청자', 'Request Purpose': 'patient-copy', 'Received At (UTC)': disclosure.date_input(-1),
            'Due At (UTC)': disclosure.date_input(2), 'Verifier ID': 'synthetic-auditor', 'Verifier Issuer': 'synthetic',
            'Verifier Subject': 'auditor', 'Checked At (UTC)': disclosure.date_input(), 'Evidence Document ID': 'SYN-EVIDENCE',
            'Record ID': UID, 'Recipient': '합성 수령자'}
        for label, value in fields.items(): section.get_by_label(label, exact=True).fill(value)
        return section

    def test_copy_request_selects_report_or_is_refused_with_guidance(self):
        self.open()
        section = self.fill_copy('SYN-UNSELECTED')
        section.get_by_role('button', name='Receive Request', exact=True).click()
        expect(section).to_contain_text(GUIDANCE)
        self.assertEqual(self.backend_call(inspect=True)['body']['requests'], [], 'an ambiguous intake stores nothing')
        self.assertNotIn('recordKind', self.posted('/api/emr-audit/requests')['request']['scope'][0])
        self.screenshot('record-kind-01-ambiguous.png')
        section.get_by_label('Request ID', exact=True).fill('SYN-REPORT')
        section.get_by_role('combobox', name='Record Type', exact=True).select_option('report')
        section.get_by_role('button', name='Receive Request', exact=True).click()
        state = section.locator('#audit-disclosure-state')
        expect(state).to_contain_text('Issuance ID: null')
        self.assertEqual(self.posted('/api/emr-audit/requests')['request']['scope'][0]['recordKind'], 'report')
        section.get_by_role('button', name='Prepare Issuance', exact=True).click()
        expect(state).to_contain_text('Issuance: Prepared')
        table = section.get_by_role('table', name='Fixed Versions')
        expect(table).to_contain_text('approve'); expect(table).to_contain_text('save')
        section.get_by_role('button', name='Issue', exact=True).click()
        expect(state).to_contain_text('Issuance: Issued')
        issued = [i['body'] for i in self.backend_call(inspect=True)['body']['issuances']][-1]
        self.assertEqual([r['recordKind'] for r in issued['manifest']['records']], ['report'])
        self.screenshot('record-kind-02-report-issued.png')

    def test_rights_request_selects_report_or_is_refused_with_guidance(self):
        self.open()
        section = self.page.get_by_role('region', name='Rights Requests', exact=True)
        section.get_by_label('Rights Request ID', exact=True).fill('SYN-R-UNSELECTED')
        for label, text in {'Rights Patient ID': 'SYN-PATIENT', 'Rights Assigning Authority': 'SYN-SITE',
                'Rights Patient Link ID': 'SYN-LINK', 'Rights Record IDs': UID,
                'Rights Received At (UTC)': '2026-10-01T00:00', 'Statement': '합성 정정 요구'}.items():
            section.get_by_label(label, exact=True).fill(text)
        section.get_by_role('button', name='Receive Request', exact=True).click()
        expect(section).to_contain_text(GUIDANCE)
        self.assertEqual(self.backend_call(inspect=True)['body']['requests'], [])
        section.get_by_label('Rights Request ID', exact=True).fill('SYN-R-REPORT')
        section.get_by_role('combobox', name='Rights Record Type', exact=True).select_option('report')
        section.get_by_role('button', name='Receive Request', exact=True).click()
        expect(section.locator('#audit-rights-state')).to_contain_text('Request: Received')
        self.assertEqual(self.posted('/api/emr-audit/rights-requests')['recordIds'], [{'recordId': UID, 'recordKind': 'report'}])
        stored = self.backend_call(inspect=True)['body']['requests'][-1]['body']['request']
        self.assertEqual((stored['recordIds'], stored['recordKinds']), ([UID], {UID: 'report'}))
        self.screenshot('record-kind-03-rights-report.png')


if __name__ == '__main__':
    unittest.main()
