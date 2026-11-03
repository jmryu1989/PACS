"""REQ-EMR-17 -> TEST-AUDIT-RIGHTS. 위험 ID 미배정: 문서 트랙 대기.

Real browser page, F controller/service/contract and synthetic original storage.
"""
import json
import subprocess
import unittest
from datetime import datetime, timezone
from urllib.parse import urlparse, unquote
from playwright.sync_api import expect
from audit_page_dom_test import AuditPage, ROOT


def datetime_local_value(at):
    value = at.isoformat(timespec='milliseconds').replace('+00:00', '').rstrip('0').rstrip('.')
    return value[:-3] if value.endswith(':00') else value


class RightsRequests(AuditPage):
    def setUp(self):
        super().setUp()
        self.backend = subprocess.Popen(['node', 'tests/emr/f/rights_harness.cjs'], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        self.rights_reply = None

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
        if not path.startswith('/api/emr-audit/rights-requests'):
            return super().api(route)
        if self.rights_reply:
            reply, self.rights_reply = self.rights_reply, None
            if reply == 'hold': self.held.append(route); return
            route.fulfill(status=reply[0], json=reply[1]); return
        parts = path.split('/')
        method = ('listRights' if route.request.method == 'GET' else 'receiveRights') if len(parts) == 4 else (
            'readRights' if len(parts) == 5 else {'decide': 'decideRights', 'notify': 'notifyRights'}[parts[-1]])
        result = self.backend_call(method=method, id=unquote(parts[4]) if len(parts) > 4 else None,
            body=route.request.post_data_json if route.request.post_data else None)
        route.fulfill(status=result['status'], json=result['body'])

    @property
    def section(self): return self.page.get_by_role('region', name='Rights Requests', exact=True)

    @property
    def state(self): return self.section.locator('#audit-rights-state')

    def click(self, name): self.section.get_by_role('button', name=name, exact=True).click()

    def receive(self, request_id='SYN-A', kind='correction'):
        self.section.get_by_label('Rights Request ID', exact=True).fill(request_id)
        for label, text in {'Rights Patient ID': 'SYN-PATIENT', 'Rights Assigning Authority': 'SYN-SITE',
                'Rights Patient Link ID': 'SYN-LINK', 'Rights Record IDs': 'SYN-RECORD',
                'Rights Received At (UTC)': '2026-10-01T00:00', 'Statement': '합성 요구 <b>원문</b>'}.items():
            self.section.get_by_label(label, exact=True).fill(text)
        self.section.get_by_role('combobox', name='Rights Kind', exact=True).select_option(kind)
        self.click('Receive Request'); expect(self.state).to_contain_text('Request: Received')

    def notify(self):
        for label, value in {'Notified At (UTC)': datetime_local_value(datetime.now(timezone.utc)),
                'Notice Recipient': '합성 수령자', 'Notice Method': 'electronic', 'Notice Evidence ID': 'SYN-EVIDENCE',
                'Notice Content': '실제 통지 원문 <img> / 이의제기 방법 안내'}.items():
            self.section.get_by_label(label, exact=True).fill(value)
        self.click('Record Notification'); expect(self.state).to_contain_text('Request: Notified')

    def withdraw(self):
        self.section.get_by_role('combobox', name='Rights Closure', exact=True).select_option('withdrawn')
        self.section.get_by_label('Notice Evidence ID', exact=True).fill('SYN-WITHDRAWAL')
        self.click('Record Withdrawal'); expect(self.state).to_contain_text('Request: Withdrawn')

    def test_received_and_decided_withdrawal_reopen_and_retry(self):
        self.open()
        for decided in [False, True]:
            request_id = 'SYN-W-' + str(decided)
            self.receive(request_id)
            if decided:
                self.click('Decide'); expect(self.state).to_contain_text('Request: Decided')
            self.withdraw()
            expect(self.section.get_by_role('button', name='Decide', exact=True)).to_be_disabled()
            expect(self.section.get_by_role('button', name='Record Withdrawal', exact=True)).to_be_disabled()
            self.click('Load Requests'); expect(self.section.get_by_role('table')).to_contain_text('Withdrawn')
            self.click('Open Request'); expect(self.state).to_contain_text('SYN-WITHDRAWAL')
            self.click('Receive Request'); expect(self.state).to_contain_text('Request: Withdrawn')
            replay = self.backend_call(method='notifyRights', id=request_id, body={'outcome': 'withdrawn', 'evidenceId': 'SYN-WITHDRAWAL'})
            self.assertEqual(replay['body']['status'], 'Withdrawn')
            for method, body in [('decideRights', None), ('notifyRights', {})]:
                refused = self.backend_call(method=method, id=request_id, body=body)
                self.assertEqual(refused['body']['code'], 'RightsRequestWithdrawn')
            self.screenshot('rights-withdrawn-' + str(decided) + '.png')

    def test_decision_refusal_keeps_received_duty_and_offers_evidenced_withdrawal(self):
        self.open(); self.receive()
        self.backend_call(unavailable_originals=True)
        self.click('Decide')
        expect(self.section).to_contain_text('결정이 거절되어 요구는 Received로 남고, 열린 응답 의무가 접속기록 만료를 계속 막습니다(CD-07-Q4). 철회가 아니면 닫지 않습니다')
        expect(self.section).not_to_contain_text('접수 사실은 별도로 기록하세요')
        expect(self.state).to_contain_text('Request: Received')
        saved = self.backend_call(inspect=True)['body']
        self.assertEqual(len(saved['requests']), 1); self.assertEqual(len(saved['duties']), 1)
        self.screenshot('rights-decision-refused.png')
        self.withdraw()
        self.assertEqual(len(self.backend_call(inspect=True)['body']['duties']), 2)

    def test_datetime_local_accepts_zero_seconds_and_fraction_normalization(self):
        self.open(); self.receive(); self.click('Decide')
        expect(self.state).to_contain_text('Request: Decided')
        for suffix, expected in [('00.000', ''), ('10.000', ':10'), ('10.100', ':10.1'), ('00.010', ':00.01'), ('00.001', ':00.001')]:
            at = datetime.fromisoformat('2026-11-03T01:02:' + suffix + '+00:00')
            value = datetime_local_value(at)
            self.assertEqual(value, '2026-11-03T01:02' + expected)
            self.section.get_by_label('Notified At (UTC)', exact=True).fill(value)
            expect(self.section.get_by_label('Notified At (UTC)', exact=True)).to_have_value(value)

    def test_concurrent_withdrawal_is_not_reported_as_an_open_received_duty(self):
        self.open(); self.receive()
        self.backend_call(method='notifyRights', id='SYN-A', body={'outcome': 'withdrawn', 'evidenceId': 'SYN-OTHER-OPERATOR'})
        self.click('Decide')
        expect(self.section).to_contain_text('RightsRequestWithdrawn')
        expect(self.section).not_to_contain_text('CD-07-Q4')
        self.click('Open Request'); expect(self.state).to_contain_text('Request: Withdrawn')

    def test_round_trip_correction_deadline_list_and_reopen(self):
        self.open(); self.receive(); expect(self.state).to_contain_text('2026-10-10T15:00:00.000Z')
        expect(self.state).to_contain_text('통지 기한 경과'); self.screenshot('rights-received.png')
        self.click('Decide'); expect(self.state).to_contain_text('Request: Decided')
        expect(self.section).to_contain_text('Addendum 또는 새 서명판')
        expect(self.section.get_by_role('link', name='Open Worklist')).to_have_attribute('href', 'main.html')
        self.screenshot('rights-decided.png'); self.notify(); self.screenshot('rights-notified.png')
        self.assertEqual(self.state.locator('img,b').count(), 0)
        self.click('Load Requests'); expect(self.section.get_by_role('table')).to_contain_text('Notified')
        self.page.reload(); self.section.get_by_label('Rights Request ID').fill('SYN-A'); self.click('Open Request')
        expect(self.state).to_contain_text('Request: Notified')
        expect(self.section.get_by_label('Notice Content')).to_have_value('실제 통지 원문 <img> / 이의제기 방법 안내')
        saved = self.backend_call(inspect=True)['body']
        self.assertEqual(len(saved['requests']), 3)
        self.assertTrue(all(r['targets'] for r in saved['records']))

    def test_refusals_show_basis_and_objection_placeholder(self):
        self.open()
        for kind, basis in [('deletion', 'privacy:36.1-proviso'), ('processing-suspension', 'privacy:37.2.1')]:
            self.receive(kind, kind); self.click('Decide')
            expect(self.state).to_contain_text('Request: Decided')
            expect(self.section.locator('#audit-rights-notice')).to_contain_text(basis)
            expect(self.section.locator('#audit-rights-notice')).to_contain_text('이의제기 방법: 문안 확정 전 (P5)')
            expect(self.section.locator('#audit-rights-notice')).to_contain_text('보존기간 경과 여부는 이 결정에 반영되지 않습니다(CD-07-Q1 미정). 보존기간이 끝난 기록이면 통지 전에 확인하세요.')
            self.screenshot('rights-' + kind + '.png'); self.notify()

    def test_guidance_follows_record_outcome_and_unsupported_receipt_is_explicit(self):
        self.open(); self.receive()
        state = self.backend_call(method='decideRights', id='SYN-A')['body']
        for outcome in ['correct', 'append-correction-note', 'correct-by-new-signed-version']:
            state['decision']['records'][0]['outcome'] = outcome
            self.rights_reply = (200, state); self.click('Open Request')
            expect(self.section.locator('#audit-rights-notice')).to_contain_text(outcome)
            guidance = self.section.get_by_role('link', name='Open Worklist')
            if outcome == 'correct-by-new-signed-version': expect(guidance).to_be_visible()
            else: expect(guidance).to_be_hidden()
        for code in ['RightsRecordUnsupported', 'RightsRecordAmbiguous', 'VersionListingIncomplete']:
            self.rights_reply = (409, {'code': code}); self.click('Receive Request')
            expect(self.section).to_contain_text('이 기록 종류는 아직 이 화면에서 처리할 수 없습니다(CD-07-Q3 미정). 접수 사실은 별도로 기록하세요.')
            expect(self.section.get_by_label('Statement')).to_have_value('합성 요구 <b>원문</b>')

    def test_unknown_or_foreign_id_keeps_rights_workspace_available(self):
        self.open(); self.receive()
        self.rights_reply = (404, {'code': 'RequestNotFound'}); self.click('Open Request')
        expect(self.section).to_contain_text('RequestNotFound')
        expect(self.section.get_by_role('button', name='Load Requests')).to_be_visible()
        self.click('Open Request'); expect(self.state).to_contain_text('Request: Received')

    def test_no_designation_blanks_whole_page(self):
        self.backend_call(reset=True, scopes=[]); self.open(); self.click('Load Requests')
        expect(self.document_status()).to_have_text('감사 기록을 조회할 권한이 없습니다.')
        self.assertEqual(self.page.locator('body').inner_text(), '감사 기록을 조회할 권한이 없습니다.')
        self.screenshot('rights-forbidden.png')

    def test_scope_missing_preserves_other_sections(self):
        self.backend_call(reset=True, scopes=['inspection']); self.open(); self.click('Load Requests')
        expect(self.section).to_contain_text('이 계정에는 정정·삭제·처리정지 요구 처리 권한이 없습니다.')
        expect(self.section.get_by_role('button', name='Load Requests')).to_be_hidden()
        expect(self.page.get_by_role('button', name='Search', exact=True)).to_be_enabled()
        self.screenshot('rights-scope.png')

    def test_late_a_response_cannot_overwrite_a_b_a(self):
        self.open(); self.receive()
        stale = self.backend_call(method='readRights', id='SYN-A')['body']
        stale['request']['statement'] = 'STALE-A'
        self.rights_reply = 'hold'; self.click('Open Request')
        expect(self.section.locator('#audit-rights-message')).to_contain_text('처리하고')
        self.section.get_by_label('Rights Request ID').fill('SYN-B')
        self.section.get_by_label('Rights Request ID').fill('SYN-A')
        self.click('Open Request'); expect(self.state).to_contain_text('합성 요구')
        self.held.pop().fulfill(status=200, json=stale)
        self.page.wait_for_timeout(100)
        expect(self.state).not_to_contain_text('STALE-A')

    def test_failure_keeps_inputs_and_reopen_recovers(self):
        self.open(); self.receive()
        self.rights_reply = (503, {'code': 'ResponseUnavailable'}); self.click('Decide')
        expect(self.section).to_contain_text('Open Request로 다시 확인')
        expect(self.section.get_by_label('Statement')).to_have_value('합성 요구 <b>원문</b>')
        self.click('Open Request'); expect(self.state).to_contain_text('Request: Received')
        self.click('Decide'); expect(self.state).to_contain_text('Request: Decided')
        self.section.get_by_label('Notice Content').fill('재시도할 실제 통지 원문')
        self.rights_reply = (503, {'code': 'ResponseUnavailable'}); self.click('Open Request')
        expect(self.section).to_contain_text('Open Request로 다시 확인')
        self.click('Open Request'); expect(self.state).to_contain_text('Request: Decided')
        expect(self.section.get_by_label('Notice Content')).to_have_value('재시도할 실제 통지 원문')


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(RightsRequests(name) for name in RightsRequests.__dict__ if name.startswith('test_'))


if __name__ == '__main__': unittest.main()
