"""REQ-EMR-15/19 -> RISK-F-07 -> TEST-AUDIT-INCIDENT: real browser and F parser."""
import json
import subprocess
import unittest
from urllib.parse import urlparse, unquote
from playwright.sync_api import expect
from audit_page_dom_test import AuditPage, ROOT


class Incidents(AuditPage):
    def setUp(self):
        super().setUp()
        self.backend = subprocess.Popen(['node', 'tests/emr/f/incident_harness.cjs'], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        self.incident_reply = None

    def tearDown(self):
        self.backend.stdin.close(); self.backend.wait(timeout=15)
        errors = self.backend.stderr.read()
        self.backend.stdout.close(); self.backend.stderr.close()
        super().tearDown()
        self.assertEqual(errors, ''); self.assertEqual(self.backend.returncode, 0)

    def backend_call(self, **query):
        self.backend.stdin.write(json.dumps(query) + '\n'); self.backend.stdin.flush()
        return json.loads(self.backend.stdout.readline())

    def api(self, route):
        path = urlparse(route.request.url).path
        if not path.startswith('/api/emr-audit/incidents'): return super().api(route)
        if self.incident_reply:
            reply, self.incident_reply = self.incident_reply, None
            if reply == 'hold': self.held.append(route); return
            route.fulfill(status=reply[0], json=reply[1]); return
        parts = path.split('/')
        method = ('listIncidents' if route.request.method == 'GET' else 'registerIncident') if len(parts) == 4 else (
            'readIncident' if len(parts) == 5 else {'findings': 'incidentFinding', 'notices': 'incidentNotice', 'close': 'closeIncident', 'drafts': 'incidentDraft'}[parts[5]])
        result = self.backend_call(method=method, id=unquote(parts[4]) if len(parts) > 4 else None,
            form=parts[6] if len(parts) > 6 else None, body=route.request.post_data_json if route.request.post_data else None)
        route.fulfill(status=result['status'], json=result['body'])

    @property
    def section(self): return self.page.get_by_role('region', name='Incident', exact=True)

    def click(self, text): self.section.get_by_role('button', name=text, exact=True).click()

    def register(self, identifier='SYN-A', verdict='possible'):
        self.section.get_by_label('Incident ID', exact=True).fill(identifier)
        for label, text in {'Awareness At (UTC)': '2026-11-01T00:00', 'Determination At (UTC)': '2026-11-01T00:00',
                'Finding Evidence ID': 'SYN-EVIDENCE', 'Incident From (UTC)': '2026-10-01T00:00',
                'Incident Until (UTC, exclusive)': '2026-10-03T00:00', 'Scope Evidence': '합성 CVR 오발송 <img src=x>'}.items():
            self.section.get_by_label(label, exact=True).fill(text)
        self.section.get_by_role('combobox', name='Verdict', exact=True).select_option(verdict)
        self.section.get_by_role('combobox', name='Incident Type', exact=True).select_option('cvr-misdelivery')
        self.section.get_by_role('combobox', name='Scope Finding', exact=True).select_option('access-outside-ledger')
        self.click('Register Incident')
        expect(self.section.locator('#audit-incident-state')).to_contain_text('Status: Open')

    def test_registration_scope_six_downloads_and_no_dispatch(self):
        self.open(); self.register()
        expect(self.section.locator('#audit-incident-scope')).to_contain_text('특정할 수 없습니다')
        expect(self.section.locator('#audit-incident-scope')).to_contain_text('SYN-PATIENT')
        expect(self.section.locator('#audit-incident-obligations')).to_contain_text('2026-11-04')
        cloud = self.section.get_by_role('row').filter(has_text='cloud-incident (클라우드컴퓨팅법 제25조)')
        expect(cloud).to_contain_text('조건부 (#69, 공급 구조 결정 전)')
        expect(cloud).to_contain_text('Not Tracked')
        self.assertEqual(self.section.locator('img').count(), 0)
        before = len(self.backend_call(inspect=True)['body']['requests'])
        for form in ['possibility', 'confirmed', 'not-a-leak', 'report', 'medical', 'network']:
            self.section.get_by_role('combobox', name='Draft Form', exact=True).select_option(form)
            with self.page.expect_download() as event: self.click('Download Draft')
            result = event.value.path().read_text(encoding='utf-8')
            self.assertIn(form, event.value.suggested_filename); self.assertIn('Status: Draft', result)
            self.assertIn('P5', result); self.assertIn('SYN-PATIENT', result)
            if form != 'possibility':
                self.assertIn('현재 계약 결과에 이 서식의 의무가 없습니다(조회 사실만 포함)', result)
                expect(self.section.locator('#audit-incident-draft-content')).to_contain_text('현재 계약 결과에 이 서식의 의무가 없습니다')
        storage = self.backend_call(inspect=True)['body']
        self.assertEqual(len(storage['requests']), before)
        self.assertEqual(len([r for r in storage['records'] if r['action'] == 'download']), 6)
        self.screenshot('incident-scope-draft.png')

    def test_no_leak_close_reopen_and_closed_controls(self):
        self.open(); self.register('NO-LEAK', 'not-a-leak')
        self.section.get_by_label('Closure Evidence ID', exact=True).fill('SYN-CLOSE')
        self.click('Close Incident')
        expect(self.section.locator('#audit-incident-state')).to_contain_text('Status: Closed')
        expect(self.section.get_by_role('button', name='Record Finding', exact=True)).to_be_disabled()
        self.click('Open Incident'); expect(self.section.locator('#audit-incident-state')).to_contain_text('Status: Closed')
        self.click('Load Incidents'); expect(self.section.locator('#audit-incident-listing')).to_contain_text('Closed')
        self.screenshot('incident-closed.png')

    def test_confirmation_preserves_reopened_fractional_awareness_and_performance(self):
        self.open(); self.register('PRECISE')
        self.section.get_by_role('combobox', name='Verdict', exact=True).select_option('confirmed')
        self.section.get_by_label('Determination At (UTC)', exact=True).fill('2026-11-01T01:00:10.14')
        self.section.get_by_label('Finding Evidence ID', exact=True).fill('SYN-CONFIRMED')
        self.section.get_by_label('Details Complete', exact=True).check()
        self.click('Record Finding'); expect(self.section.locator('#audit-incident-state')).to_contain_text('Verdict: confirmed')
        self.click('Open Incident')
        expect(self.section.get_by_label('Determination At (UTC)', exact=True)).to_have_value('2026-11-01T01:00:10.14')
        self.section.get_by_role('combobox', name='Obligation', exact=True).select_option(label='confirmed-leak / affected-subjects')
        self.section.get_by_label('Sent At (UTC)', exact=True).fill('2026-11-01T02:00')
        self.section.get_by_label('Delivery Evidence ID', exact=True).fill('SYN-SENT')
        self.section.get_by_label('All Recipients Covered', exact=True).check()
        for checkbox in self.section.locator('#audit-incident-fields input').all(): checkbox.check()
        self.click('Record Performance')
        expect(self.section.locator('#audit-incident-history')).to_contain_text('SYN-SENT')
        self.screenshot('incident-confirmed-performance.png')

    def authority_evidence(self):
        for label, value in {'Authority Verified At (UTC)': '2026-11-01T00:00',
                'Designation Category Evidence ID': 'SYN-CATEGORY',
                'Qualification Assessment Evidence ID': 'SYN-QUALIFICATION'}.items():
            self.section.get_by_label(label, exact=True).fill(value)

    def test_report_exemption_and_real_notice_close_without_fictitious_report(self):
        self.open()
        self.section.get_by_label('Sensitive / Unique Data', exact=True).check()
        self.section.get_by_label('Details Complete', exact=True).check()
        self.register('EXEMPT', 'confirmed')
        self.section.get_by_role('combobox', name='Record Type', exact=True).select_option('exemption')
        self.section.get_by_role('combobox', name='Obligation', exact=True).select_option(label='pipc-kisa-report / PIPC-or-KISA')
        for label, value in {'Decision ID': 'EXEMPT-1', 'Decision / Delay Evidence ID': 'SYN-EXEMPT-EVIDENCE',
                'Decision / Delay Reason': '권익 침해 가능성 감소 검토 <img>', 'Decision At (UTC)': '2026-11-01T01:00',
                'Decision Authority Evidence ID': 'SYN-AUTHORITY'}.items():
            self.section.get_by_label(label, exact=True).fill(value)
        self.authority_evidence(); self.click('Record Performance')
        expect(self.section.locator('#audit-incident-obligations')).to_contain_text('exempt / Resolved')
        self.assertEqual(self.section.locator('img').count(), 0)
        self.section.get_by_role('combobox', name='Record Type', exact=True).select_option('notice')
        self.section.get_by_role('combobox', name='Obligation', exact=True).select_option(label='confirmed-leak / affected-subjects')
        self.section.get_by_label('Sent At (UTC)', exact=True).fill('2026-11-01T02:00')
        self.section.get_by_label('Delivery Evidence ID', exact=True).fill('SYN-ACTUAL-NOTICE')
        self.section.get_by_label('All Recipients Covered', exact=True).check()
        for checkbox in self.section.locator('#audit-incident-fields input').all(): checkbox.check()
        self.click('Record Performance')
        expect(self.section.locator('#audit-incident-history')).to_contain_text('SYN-ACTUAL-NOTICE')
        self.section.get_by_label('Closure Evidence ID', exact=True).fill('EXEMPT-CLOSE'); self.click('Close Incident')
        expect(self.section.locator('#audit-incident-state')).to_contain_text('Status: Closed')
        self.click('Open Incident')
        expect(self.section.locator('#audit-incident-obligations')).to_contain_text('exempt / Resolved')
        saved = self.backend_call(method='readIncident', id='EXEMPT')['body']
        self.assertEqual([n['kind'] for n in saved['plan']['ledger']['notices']], ['confirmed-leak'])
        self.screenshot('incident-report-exemption.png')

    def test_accepted_delay_shows_cause_evidence_and_original_deadline(self):
        self.open(); self.register('DELAY')
        self.section.get_by_role('combobox', name='Record Type', exact=True).select_option('delay')
        self.section.get_by_label('Delay Accepted', exact=True).check()
        for label, value in {'Decision ID': 'DELAY-DECISION', 'Delay ID': 'DELAY-1', 'Decision / Delay Evidence ID': 'DELAY-EVIDENCE',
                'Decision / Delay Reason': '합성 불가항력 지연', 'Delay Clause': 'privacy-decree:39-3.1', 'Delay Clause Version': '2026-09-11',
                'Delay Started At (UTC)': '2026-11-01T00:30', 'Causal Evidence ID': 'CAUSE-1',
                'Causal Review At (UTC)': '2026-11-01T01:00', 'Causal Evidence Created At (UTC)': '2026-11-01T00:30',
                'Causal Evidence Received At (UTC)': '2026-11-01T00:45', 'Causal Review Reason': '사유와 지연 시간의 인과 확인'}.items():
            self.section.get_by_label(label, exact=True).fill(value)
        self.authority_evidence(); self.click('Record Performance')
        table = self.section.get_by_role('table')
        for text in ['deferred-until-cause-cleared', 'Original Due: 2026-11-04', '합성 불가항력 지연', 'DELAY-EVIDENCE', 'CAUSE-1', 'privacy-decree:39-3.1']:
            expect(table).to_contain_text(text)
        self.click('Open Incident'); expect(table).to_contain_text('사유와 지연 시간의 인과 확인')
        self.screenshot('incident-delay.png')

    def test_superseded_closure_keeps_original_scope_verdict_and_draft(self):
        self.open(); self.register('REPLACEMENT'); self.register('WRONG')
        self.section.get_by_label('Closure Evidence ID', exact=True).fill('CORRECTION-EVIDENCE')
        self.section.get_by_label('Superseded By Incident ID', exact=True).fill('REPLACEMENT')
        self.click('Close Incident')
        expect(self.section.locator('#audit-incident-state')).to_contain_text('Closed (Superseded by REPLACEMENT)')
        expect(self.section.locator('#audit-incident-state')).to_contain_text('Verdict: possible')
        self.click('Load Incidents'); expect(self.section.locator('#audit-incident-listing')).to_contain_text('Closed (Superseded by REPLACEMENT)')
        self.click('Open Incident'); expect(self.section.locator('#audit-incident-scope')).to_contain_text('SYN-PATIENT')
        with self.page.expect_download() as event: self.click('Download Draft')
        text = event.value.path().read_text(encoding='utf-8')
        self.assertIn('Verdict: possible', text); self.assertIn('SYN-PATIENT', text)
        self.screenshot('incident-superseded.png')

    def test_denied_designation_and_scope(self):
        for scopes in [[], ['investigate']]:
            self.backend_call(reset=True, scopes=scopes); self.open(); self.click('Load Incidents')
            if not scopes: expect(self.page.locator('#audit-workspace')).to_be_hidden()
            else: expect(self.section.locator('#audit-incident-workspace')).to_be_hidden()
            self.screenshot('incident-denied-' + str(len(scopes)) + '.png')

    def test_a_b_a_stale_scope_and_download_are_not_shown(self):
        self.open(); self.register('SYN-A')
        self.incident_reply = 'hold'; self.click('Open Incident')
        self.section.get_by_label('Incident ID', exact=True).fill('SYN-B')
        self.section.get_by_label('Incident ID', exact=True).fill('SYN-A')
        self.click('Open Incident'); expect(self.section.locator('#audit-incident-state')).to_contain_text('SYN-A')
        self.held.pop().fulfill(json={'incidentId': 'STALE'})
        self.page.wait_for_timeout(50)
        expect(self.section.locator('#audit-incident-state')).not_to_contain_text('STALE')
        self.incident_reply = 'hold'; self.click('Download Draft')
        self.section.get_by_label('Incident ID', exact=True).fill('SYN-B')
        self.section.get_by_label('Incident ID', exact=True).fill('SYN-A')
        self.held.pop().fulfill(json={'title': 'STALE-DRAFT'})
        self.page.wait_for_timeout(50)
        expect(self.section.locator('#audit-incident-draft-content')).to_have_text('')


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(Incidents(name) for name in Incidents.__dict__ if name.startswith('test_'))


if __name__ == '__main__': unittest.main(verbosity=2)
