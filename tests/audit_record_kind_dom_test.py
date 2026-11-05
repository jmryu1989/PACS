"""REQ-EMR-16/17 -> RISK-F-03/04 -> TEST-AUDIT-RECORD-KIND.

Real page + real F service/contract over native_harness.cjs: one Study UID holds both a Tech Note and a native
report. An unselected copy or rights request is refused with guidance and stores nothing; Record Type selects one.
A request received before the UID became ambiguous keeps its intake and hold and is shown as stored, with its ways
out. A paper copy is read in the browser as a person reads it.
"""
import json
from pathlib import Path
import subprocess
import unittest
from urllib.parse import quote, urlparse, unquote

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

    def received_unselected(self, request_id):
        """A request received while its UID held only the report, before a Tech Note was stored under the same UID."""
        self.backend_call(reset=True, reportOnly=True)
        self.open()
        section = self.fill_copy(request_id)
        section.get_by_role('button', name='Receive Request', exact=True).click()
        expect(section.locator('#audit-disclosure-state')).to_contain_text('Request: Pending')
        self.assertNotIn('recordKind', self.posted('/api/emr-audit/requests')['request']['scope'][0])
        return section

    def assert_request_kept(self, section, request_id, action_path):
        """The refused action was re-read: the page shows the stored request, its hold and the ways out, not a new intake."""
        state = section.locator('#audit-disclosure-state')
        # The outcome names the stored request; the message before the action did not, so this also waits for it.
        expect(section.locator('#audit-disclosure-message')).to_contain_text(request_id)
        after = [(m, p) for m, p, _ in self.calls[[p for _, p, _ in self.calls].index(action_path):]]
        self.assertIn(('GET', f'/api/emr-audit/requests/{request_id}'), after, 'the stored request is re-read after the refusal')
        stored = [r for r in self.backend_call(inspect=True)['body']['requests'] if r['body']['facts']['requestId'] == request_id]
        self.assertGreater(len(stored[-1]['body']['holds']), 0); self.assertIsNone(stored[-1]['body']['facts'].get('resolution'))
        expect(state).to_contain_text('Request: Pending'); expect(state).to_contain_text('Hold: Pending')
        self.assertTrue(section.get_by_role('combobox', name='Record Type', exact=True).is_hidden(), 'the intake form is not offered for a received request')
        self.assertTrue(section.get_by_role('button', name='Resolve', exact=True).is_enabled())

    def resolve_and_receive_selected(self, section, old_id, new_id):
        section.get_by_role('combobox', name='Resolution', exact=True).select_option('withdrawn')
        section.get_by_label('Resolution Evidence', exact=True).fill('SYN-WITHDRAWAL')
        section.get_by_role('button', name='Resolve', exact=True).click()
        expect(section.locator('#audit-disclosure-state')).to_contain_text('Request: Resolved')
        section.get_by_label('Request ID', exact=True).fill(new_id)
        section.get_by_role('combobox', name='Record Type', exact=True).select_option('report')
        section.get_by_role('button', name='Receive Request', exact=True).click()
        section.get_by_role('button', name='Prepare Issuance', exact=True).click()
        expect(section.locator('#audit-disclosure-state')).to_contain_text('Issuance: Prepared')
        stored = self.backend_call(inspect=True)['body']
        self.assertEqual([i['body']['manifest']['records'][0]['recordKind'] for i in stored['issuances']
            if i['body']['manifest']['requestId'] == new_id][-1], 'report')
        old = [r['body'] for r in stored['requests'] if r['body']['facts']['requestId'] == old_id][-1]
        self.assertEqual(old['facts']['resolution']['outcome'], 'withdrawn', 'the old request is ended on its evidence, not replaced')

    def test_received_request_whose_record_became_ambiguous_keeps_its_state_on_prepare(self):
        section = self.received_unselected('SYN-HELD-PREPARE')
        self.backend_call(techNote=True)
        section.get_by_role('button', name='Prepare Issuance', exact=True).click()
        self.assert_request_kept(section, 'SYN-HELD-PREPARE', '/api/emr-audit/issuances')
        expect(section.locator('#audit-disclosure-state')).to_contain_text('Issuance: Not Prepared')
        self.assertEqual(self.backend_call(inspect=True)['body']['issuances'], [], 'no issuance is prepared')
        self.screenshot('record-kind-04-held-prepare.png')
        self.resolve_and_receive_selected(section, 'SYN-HELD-PREPARE', 'SYN-HELD-PREPARE-REPORT')

    def test_issuance_prepared_before_record_kind_keeps_its_state_on_issue(self):
        section = self.received_unselected('SYN-HELD-ISSUE')
        section.get_by_role('button', name='Prepare Issuance', exact=True).click()
        state = section.locator('#audit-disclosure-state')
        expect(state).to_contain_text('Issuance: Prepared')
        issuance = self.backend_call(inspect=True)['body']['issuances'][-1]['body']['issuanceId']
        self.backend_call(techNote=True, legacy=True)
        section.get_by_role('button', name='Issue', exact=True).click()
        self.assert_request_kept(section, 'SYN-HELD-ISSUE', f'/api/emr-audit/issuances/{quote(issuance, safe="")}/issue')
        expect(state).to_contain_text('Issuance: Prepared')
        events = [e['kind'] for e in self.backend_call(inspect=True)['body']['issuances'][-1]['body']['events']]
        self.assertNotIn('issued', events, 'no copy is issued')
        self.screenshot('record-kind-05-held-issue.png')
        self.resolve_and_receive_selected(section, 'SYN-HELD-ISSUE', 'SYN-HELD-ISSUE-REPORT')

    def test_paper_copy_shows_report_versions_readably_and_keeps_the_originals(self):
        saved = '저장 소견 <b>원문</b>'
        self.backend_call(reset=True, saved=saved)
        self.open()
        section = self.fill_copy('SYN-PAPER')
        section.get_by_role('combobox', name='Record Type', exact=True).select_option('report')
        section.get_by_role('combobox', name='Delivery Method', exact=True).select_option('in-person')
        section.get_by_role('button', name='Receive Request', exact=True).click()
        section.get_by_role('button', name='Prepare Issuance', exact=True).click()
        expect(section.locator('#audit-disclosure-state')).to_contain_text('Issuance: Prepared')
        section.get_by_role('button', name='Issue', exact=True).click()
        expect(section.locator('#audit-disclosure-state')).to_contain_text('Issuance: Issued')
        with self.page.expect_download() as download:
            section.get_by_role('button', name='Download Print HTML', exact=True).click()
        paper = self.context.new_page()
        paper.set_content(Path(download.value.path()).read_text(encoding='utf-8'))
        # Read the copy as a person does: each version's labelled fields and headed text blocks.
        versions = {}
        for block in paper.locator('section').all():
            fields = dict(zip(block.get_by_role('term').all_inner_texts(), block.get_by_role('definition').all_inner_texts()))
            for heading in block.get_by_role('heading', level=3).all():
                fields[heading.inner_text()] = heading.evaluate('h => h.nextElementSibling.textContent')
            versions[fields['Version']] = fields
        self.assertEqual(sorted(versions), ['1', '2'])
        self.assertEqual((versions['1']['Findings'], versions['1']['Conclusion'], versions['1']['Signature']), (saved, '합성 결론', 'Not Signed'))
        self.assertEqual((versions['2']['Findings'], versions['2']['Signature'], versions['2']['Author']), ('확정 소견', 'Signed', 'SYN-DOCTOR'))
        self.assertTrue(all(not v['Findings'].lstrip().startswith('{') for v in versions.values()), 'the readable part is not the stored row JSON')
        self.assertEqual(paper.locator('section b').count(), 0, 'stored markup is shown as text, not rendered')
        # The stored originals travel with the copy, folded until opened.
        originals = paper.get_by_role('group').filter(has_text='Original Documents')
        expect(originals.get_by_text(saved, exact=False)).to_be_hidden()
        originals.get_by_text('Original Documents', exact=True).click()
        expect(originals.get_by_text(saved, exact=False)).to_be_visible()
        document = json.loads(originals.inner_text().split('\n', 1)[1])
        self.assertIn(saved, json.dumps(document, ensure_ascii=False))
        paper.close()

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
