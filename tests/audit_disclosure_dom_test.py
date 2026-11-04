"""REQ-EMR-16/17 -> RISK-F-03/04/06 -> TEST-AUDIT-DISCLOSURE.

Real page + real F service/contract + signed synthetic originals in one disclosure harness.
"""
import base64
import hashlib
import json
import subprocess
import unittest
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse, unquote

from playwright.sync_api import expect
from audit_page_dom_test import AuditPage, ROOT


def date_input(days=0):
    return (datetime.now(timezone.utc) + timedelta(days=days)).strftime('%Y-%m-%dT%H:%M')


class RecordCopyRequests(AuditPage):
    def setUp(self):
        super().setUp()
        self.backend = subprocess.Popen(['node', 'tests/emr/f/disclosure_harness.cjs'], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        self.disclosure_calls = []
        self.disclosure_reply = None

    def tearDown(self):
        self.backend.stdin.close(); self.backend.wait(timeout=15)
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
        if not path.startswith(('/api/emr-audit/requests', '/api/emr-audit/issuances')):
            return super().api(route)
        body = route.request.post_data_json if route.request.post_data else None
        self.disclosure_calls.append((route.request.method, path, body))
        if self.disclosure_reply:
            reply, self.disclosure_reply = self.disclosure_reply, None
            if reply == 'hold': self.held.append(route); return
            route.fulfill(status=reply[0], json=reply[1]); return
        parts = path.split('/')
        method = ('register' if parts[3] == 'requests' else 'prepare') if len(parts) == 4 else (
            ('state' if parts[3] == 'requests' else 'issuance') if len(parts) == 5 else parts[-1])
        reply = self.backend_call(method=method, id=unquote(parts[4]) if len(parts) > 4 else None, body=body)
        route.fulfill(status=reply['status'], json=reply['body'])

    @property
    def section(self):
        return self.page.get_by_role('region', name='Record Copy Requests', exact=True)

    @property
    def state(self):
        return self.section.locator('#audit-disclosure-state')

    def click(self, name):
        self.section.get_by_role('button', name=name, exact=True).click()

    def receive(self, request_id='SYN-A', record='SYN-RECORD', part=None, method='electronic'):
        self.section.get_by_label('Request ID', exact=True).fill(request_id)
        fields = {'Copy Patient ID': 'SYN-PATIENT', 'Copy Assigning Authority': 'SYN-SITE', 'Patient Link ID': 'SYN-LINK',
            'Requester Name': '합성 <b>요청자</b>', 'Request Purpose': 'patient-copy', 'Received At (UTC)': date_input(-1),
            'Due At (UTC)': date_input(2), 'Verifier ID': 'synthetic-auditor', 'Verifier Issuer': 'synthetic',
            'Verifier Subject': 'auditor', 'Checked At (UTC)': date_input(), 'Evidence Document ID': 'SYN-EVIDENCE',
            'Record ID': record, 'Recipient': '합성 수령자'}
        for label, value in fields.items(): self.section.get_by_label(label, exact=True).fill(value)
        self.section.get_by_role('combobox', name='Delivery Method', exact=True).select_option(method)
        self.section.get_by_role('combobox', name='Version Scope', exact=True).select_option('part' if part else 'all')
        if part: self.section.get_by_label('Requested Version IDs', exact=True).fill(part)
        self.click('Receive Request')
        expect(self.state).to_contain_text('Issuance ID: null')
        expect(self.section.get_by_role('button', name='Prepare Issuance', exact=True)).to_be_enabled()
        expect(self.state).to_contain_text('합성 <b>요청자</b>')
        self.assertEqual(self.state.locator('b').count(), 0)

    def prepare_issue(self):
        self.click('Prepare Issuance'); expect(self.state).to_contain_text('Issuance: Prepared')
        self.click('Issue'); expect(self.state).to_contain_text('Issuance: Issued')
        expect(self.state).not_to_contain_text('Issuance: Delivered')
        expect(self.section.get_by_role('button', name='Record Delivery', exact=True)).to_be_enabled()

    def delivery(self):
        self.section.get_by_label('Delivery Evidence ID', exact=True).fill('SYN-RECEIPT')
        self.section.get_by_label('Delivered At (UTC)', exact=True).fill(date_input())
        self.section.get_by_label('Delivery Note', exact=True).fill('수령 확인 <img>')
        self.click('Record Delivery'); expect(self.state).to_contain_text('Issuance: Delivered')
        expect(self.state).to_contain_text('SYN-RECEIPT')
        expect(self.state).to_contain_text('수령 확인 <img>')
        self.assertEqual(self.state.locator('img').count(), 0)

    def resolve(self, outcome='fulfilled'):
        self.section.get_by_role('combobox', name='Resolution', exact=True).select_option(outcome)
        self.section.get_by_label('Resolution Evidence', exact=True).fill('SYN-RESOLUTION')
        self.click('Resolve'); expect(self.state).to_contain_text('Request: Resolved')
        expect(self.state).to_contain_text('Hold: Released')

    def test_round_trip_and_each_step_screenshot(self):
        self.open(); self.receive(); self.screenshot('disclosure-01-received.png')
        self.click('Prepare Issuance'); expect(self.state).to_contain_text('Issuance: Prepared')
        expect(self.section.get_by_role('table', name='Fixed Versions')).to_contain_text('SYN-V1')
        expect(self.section.get_by_role('table', name='Fixed Versions')).to_contain_text('SYN-V2')
        self.screenshot('disclosure-02-prepared.png')
        self.click('Issue'); expect(self.state).to_contain_text('Issuance: Issued')
        expect(self.state).not_to_contain_text('Issuance: Delivered'); self.screenshot('disclosure-03-issued.png')
        self.delivery(); self.screenshot('disclosure-04-delivered.png')
        self.section.get_by_label('Extended Due At (UTC)', exact=True).fill(date_input(4))
        self.section.get_by_label('Notification Evidence', exact=True).fill('SYN-NOTICE')
        self.click('Extend'); expect(self.state).to_contain_text(date_input(4))
        self.screenshot('disclosure-05-extended.png')
        self.resolve(); self.screenshot('disclosure-06-resolved.png')
        self.page.reload()
        self.section.get_by_label('Request ID', exact=True).fill('SYN-A'); self.click('Open Request')
        expect(self.state).to_contain_text('Request: Resolved'); expect(self.state).to_contain_text('Issuance: Delivered')
        data = self.backend_call(inspect=True)['body']
        self.assertTrue(all(record['targets'] for record in data['records']))
        self.assertEqual(data['requests'][-1]['body']['facts']['extensions'][0]['evidenceId'], 'SYN-NOTICE')
        self.assertEqual(data['requests'][-1]['body']['facts']['resolution']['outcome'], 'fulfilled')

    def test_missing_original_keeps_null_extend_and_resolve(self):
        self.open(); self.receive(record='MISSING')
        self.click('Prepare Issuance'); expect(self.section).to_contain_text('VersionListingIncomplete')
        expect(self.state).to_contain_text('Issuance ID: null')
        expect(self.state).to_contain_text('원본 누락 또는 준비 실패')
        for name in ['Extend', 'Resolve']: expect(self.section.get_by_role('button', name=name, exact=True)).to_be_enabled()
        self.screenshot('disclosure-missing-original.png')
        self.section.get_by_label('Extended Due At (UTC)', exact=True).fill(date_input(5))
        self.section.get_by_label('Notification Evidence', exact=True).fill('SYN-MISSING-NOTICE')
        self.click('Extend'); expect(self.state).to_contain_text(date_input(5))
        self.resolve('withdrawn')

    def test_preparation_failure_keeps_intake_and_can_retry(self):
        self.open(); self.receive()
        self.disclosure_reply = (500, {'code': 'SyntheticStorageFailure'})
        self.click('Prepare Issuance'); expect(self.section).to_contain_text('SyntheticStorageFailure')
        expect(self.state).to_contain_text('Issuance ID: null')
        for name in ['Extend', 'Resolve']: expect(self.section.get_by_role('button', name=name, exact=True)).to_be_enabled()
        self.prepare_issue()

    def test_partial_scope_download_is_exact_json_and_server_hash(self):
        self.open(); self.receive(part='SYN-V2'); self.prepare_issue()
        versions = self.section.get_by_role('table', name='Fixed Versions')
        expect(versions).to_contain_text('SYN-V2'); expect(versions).not_to_contain_text('SYN-V1')
        self.check_download('Download JSON', 'json')
        expect(self.section.get_by_role('button', name='Download Print HTML', exact=True)).to_be_disabled()
        self.screenshot('disclosure-partial-json.png')

    def check_download(self, button, format):
        state = self.backend_call(method='state', id='SYN-A')['body']
        copy = self.backend_call(method='issuance', id=state['issuanceId'])['body']
        with self.page.expect_download() as info: self.click(button)
        data = info.value.path().read_bytes()
        self.assertEqual(data, base64.b64decode(copy['artifact']))
        self.assertEqual(hashlib.sha256(data).hexdigest(), copy['sha256'])
        expect(self.section.locator(f'#audit-disclosure-{format}-sha')).to_contain_text(copy['sha256'])
        if format == 'json':
            document = json.loads(data)
            originals = self.backend_call(inspect=True)['body']['originals']
            for item in document['originals']:
                original = next(row for row in originals if row['versionId'] == item['versionId'])
                self.assertEqual(json.loads(item['original']), original)
        else:
            self.assertIn('Fixed Record Copy', data.decode())
            self.assertIn('&lt;script&gt;unsafe&lt;/script&gt;', data.decode())

    def test_paper_download_preserves_html_and_reopening_never_issues(self):
        self.open(); self.receive(method='in-person'); self.prepare_issue()
        self.check_download('Download Print HTML', 'html')
        expect(self.section.get_by_role('button', name='Download JSON', exact=True)).to_be_disabled()
        self.screenshot('disclosure-print-html.png')
        before = len([c for c in self.disclosure_calls if c[1].endswith('/issue')])
        self.page.reload(); self.section.get_by_label('Request ID', exact=True).fill('SYN-A'); self.click('Open Request')
        expect(self.state).to_contain_text('Issuance: Issued')
        self.assertEqual(len([c for c in self.disclosure_calls if c[1].endswith('/issue')]), before)
        self.check_download('Download Print HTML', 'html')

    def test_scope_denial_leaves_other_sections_and_designation_denial_blanks_page(self):
        self.open(); self.backend_call(reset=True, scopes=['inspection'])
        self.section.get_by_label('Request ID', exact=True).fill('SYN-A'); self.click('Open Request')
        expect(self.section).to_contain_text('이 계정에는 진료기록 사본 발급 권한이 없습니다.')
        expect(self.page.get_by_role('button', name='Search', exact=True)).to_be_enabled()
        expect(self.page.get_by_role('button', name='Load Months', exact=True)).to_be_enabled()
        self.screenshot('disclosure-scope-missing.png')
        self.backend_call(reset=True, scopes=[]); self.page.reload()
        self.section.get_by_label('Request ID', exact=True).fill('SYN-A'); self.click('Open Request')
        expect(self.document_status()).to_have_text('감사 기록을 조회할 권한이 없습니다.')
        self.assertEqual(self.page.locator('body').inner_text(), '감사 기록을 조회할 권한이 없습니다.')

    def test_a_b_a_and_logout_discard_late_request_response(self):
        self.open(); self.receive('SYN-A'); self.receive('SYN-B')
        old = self.backend_call(method='state', id='SYN-A')['body']
        self.disclosure_reply = 'hold'
        self.section.get_by_label('Request ID', exact=True).fill('SYN-A'); self.click('Open Request')
        self.section.get_by_label('Request ID', exact=True).fill('SYN-B'); self.click('Open Request')
        expect(self.state).to_contain_text('Request ID: SYN-B')
        self.section.get_by_label('Request ID', exact=True).fill('SYN-A'); self.click('Open Request')
        expect(self.state).to_contain_text('Request ID: SYN-A')
        old['request']['requester']['name'] = 'STALE-RESPONSE'
        with self.page.expect_response(lambda r: r.url.endswith('/requests/SYN-A')): self.held.pop().fulfill(json=old)
        self.page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        expect(self.state).not_to_contain_text('STALE-RESPONSE')
        self.disclosure_reply = 'hold'; self.click('Open Request')
        self.page.get_by_role('button', name='Log out', exact=True).click()
        self.held.pop().fulfill(json=old)
        expect(self.page.locator('body')).not_to_contain_text('SYN-PATIENT')

    def test_delivery_failure_is_not_delivered_and_can_recover(self):
        self.open(); self.receive(); self.prepare_issue()
        self.section.get_by_role('combobox', name='Delivery Outcome', exact=True).select_option('unknown')
        self.section.get_by_label('Delivered At (UTC)', exact=True).fill(date_input())
        self.section.get_by_label('Delivery Note', exact=True).fill('수령 확인 불가')
        self.click('Record Delivery'); expect(self.state).to_contain_text('Issuance: ReceiptUnknown')
        self.section.get_by_label('Resolution Evidence', exact=True).fill('SYN-FALSE-FULFILLED')
        self.click('Resolve'); expect(self.section).to_contain_text('DeliveryEvidenceRequired')
        expect(self.state).to_contain_text('Request: Pending')
        self.section.get_by_role('combobox', name='Delivery Outcome', exact=True).select_option('delivered')
        self.delivery(); self.resolve()


if __name__ == '__main__':
    names = [name for name in RecordCopyRequests.__dict__ if name.startswith('test_')]
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(RecordCopyRequests(name) for name in names))
    raise SystemExit(not result.wasSuccessful())
