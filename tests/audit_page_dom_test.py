"""CD-04 / REQ-EMR-15 -> RISK-F-01/02 -> TEST-AUDIT-PAGE.

Serve the real document and session scripts; only API responses are synthetic.
"""
import functools
import http.server
import json
import os
from pathlib import Path
import threading
import unittest
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
FROM, TO = '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'


def event(name, act='기재'):
    known = lambda value: dict(status='known', value=value)
    return dict(sequence=1, eventId=name, occurredAt=FROM, committedAt=FROM,
                actor=known(dict(id='SYN-AUDITOR', issuer='synthetic', subject='SYN-SUB')),
                rolesAtTime=known(['radiologist']), actingInstitution=known('SYN-SITE'),
                managingInstitution=known('SYN-SITE'), action='provide-prepared' if act == '열람' else 'write', statutoryAct=act,
                result='succeeded', surface='synthetic', cause='user-view', executor='member',
                channel='online', requestId='SYN-REQUEST', relatedEventId=None,
                targets=[dict(kind='report', patient=known(dict(patientId='SYN-PATIENT',
                    assigningAuthority='SYN-AUTHORITY', linkId='SYN-LINK')), studyId=known('SYN-STUDY'),
                    recordId=known('SYN-RECORD'), versionId=known('1'), currentLink=None, rematched=False)])


def answer(changes=(), views=(), change_next=None, view_next=None, totals=None):
    totals = totals or (len(changes), len(views))
    return dict(changes=dict(rows=list(changes), total=totals[0], top=20, nextCursor=change_next),
                views=dict(rows=list(views), total=totals[1], top=30, nextCursor=view_next),
                totalEntries=sum(totals), images=[], sourceManifests={})


class AuditPage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args): pass
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT)))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close(); cls.thread.join()

    def setUp(self):
        self.context = self.browser.new_context(viewport=dict(width=1440, height=1000), accept_downloads=True)
        self.page = self.context.new_page()
        self.replies, self.calls, self.held, self.errors = [], [], [], []
        self.roles = ['radiologist']  # designation is a server fact, independent of the admin role
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.route('**/api/**', self.api)

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def api(self, route):
        path = urlparse(route.request.url).path
        if path == '/api/me':
            route.fulfill(json=dict(sub='SYN-AUDITOR', user='Synthetic Auditor', roles=self.roles,
                                    institution='SYN-SITE', sessionId='SYN-SESSION'))
        elif path in ['/api/emr-audit/investigations', '/api/emr-audit/exports']:
            self.calls.append((path, route.request.post_data_json, route.request.headers))
            reply = self.replies.pop(0)
            if reply == 'hold': self.held.append(route)
            else: route.fulfill(status=reply[0], json=reply[1])
        elif path == '/api/auth/logout': route.fulfill(status=204)
        else: route.fulfill(status=404, json={})

    def open(self, status=200, body=None):
        self.page.goto(f'http://127.0.0.1:{self.server.server_port}/worklist-v0/hpacs-lite/audit.html')
        expect(self.page.get_by_role('button', name='Search', exact=True)).to_be_enabled()
        if status != 200 or body is not None: self.search(answer() if body is None else body, status)

    def document_status(self):
        # The page-wide query/session status is outside the feature regions.
        return self.page.locator('body > *').and_(self.page.get_by_role('status'))

    def filters(self):
        self.page.get_by_label('Patient ID', exact=True).fill('SYN-PATIENT')
        self.page.get_by_label('Assigning Authority', exact=True).fill('SYN-AUTHORITY')
        self.page.get_by_label('From (UTC)', exact=True).fill('2026-10-01T00:00')
        self.page.get_by_label('Until (UTC, exclusive)', exact=True).fill('2026-11-01T00:00')

    def search(self, body, status=200):
        self.replies.append((status, body))
        self.page.get_by_role('button', name='Search', exact=True).click()
        if body.get('code') != 'AuditorNotDesignated':
            expect(self.page.get_by_role('button', name='Search', exact=True)).to_be_enabled()

    def screenshot(self, name):
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', ROOT / 'tmp/cd-04'))
        folder.mkdir(parents=True, exist_ok=True)
        self.page.screenshot(path=str(folder / name), full_page=True)

    def test_patient_filters_streams_and_independent_continuation(self):
        self.open(); self.filters()
        self.search(answer([event('CHANGE-1')], [event('CHANGE-1'), event('VIEW-1', '열람')], 'C-NEXT', 'V-NEXT', (2, 5)))
        body = self.calls[-1][1]
        self.assertEqual(body['patient'], dict(patientId='SYN-PATIENT', assigningAuthority='SYN-AUTHORITY'))
        self.assertEqual((body['from'], body['to']), (FROM, TO))
        self.assertNotIn('actions', body)
        self.assertEqual(self.calls[-1][2]['x-kin-session'], 'SYN-SESSION')
        changes = self.page.get_by_role('region', name='Change History', exact=True)
        views = self.page.get_by_role('region', name='Access', exact=True)
        expect(changes).to_contain_text('CHANGE-1'); expect(views).to_contain_text('VIEW-1')
        self.replies.append((200, answer([event('CHANGE-2')], [event('CHANGE-2'), event('VIEW-2', '열람')], None, 'V-LAST', (2, 5))))
        self.page.get_by_role('button', name='Load More', exact=True).click()
        expect(views).to_contain_text('VIEW-2')
        self.assertEqual((self.calls[-1][1]['changesAfter'], self.calls[-1][1]['viewsAfter']), ('C-NEXT', 'V-NEXT'))
        continuation = answer((), [event('VIEW-3', '열람')], None, None, (0, 5))
        continuation['changes'] = None
        self.replies.append((200, continuation))
        self.page.get_by_role('button', name='Load More', exact=True).click()
        expect(views).to_contain_text('VIEW-3')
        self.assertTrue(self.calls[-1][1]['changesDone'])
        self.assertNotIn('changesAfter', self.calls[-1][1])
        self.assertEqual(self.calls[-1][1]['viewsAfter'], 'V-LAST')
        self.assertEqual(changes.get_by_role('row').count(), 3)
        expect(changes).to_contain_text('표시 2건 / 전체 2건')
        expect(views).to_contain_text('표시 5건 / 전체 5건')
        expect(changes).to_contain_text('Act: Entry')
        expect(views).to_contain_text('Act: Access')
        expect(self.page.get_by_role('button', name='Load More', exact=True)).to_be_hidden()
        self.screenshot('results.png')

    def test_all_four_acts_and_empty_results(self):
        self.open(); self.filters()
        for kind, actions in [('entry', ['write', 'approve-sign', 'draft-save']),
                              ('addition', ['additional-entry', 'addendum']),
                              ('correction', ['modify', 'amend', 'cancel', 'clear', 'discard']),
                              ('access', ['provide-prepared', 'transfer-ended', 'transfer-aborted',
                                  'client-shown', 'explicit-ack', 'print-opened', 'print-done',
                                  'pdf', 'copy', 'download', 'disclosure'])]:
            self.page.get_by_label('Event Kind').select_option(kind)
            self.search(answer())
            self.assertEqual(set(self.calls[-1][1]['actions']), set(actions))
            expect(self.document_status()).to_be_visible()
            expect(self.document_status()).to_contain_text('표시할 기록이 없습니다.')

    def test_non_auditor_admin_has_only_403_sentence(self):
        self.roles = ['admin']
        self.open(403, dict(code='AuditorNotDesignated'))
        expect(self.document_status()).to_be_visible()
        expect(self.document_status()).to_have_text('감사 기록을 조회할 권한이 없습니다.')
        self.assertEqual(self.page.locator('body').inner_text(), '감사 기록을 조회할 권한이 없습니다.')
        self.assertEqual(len(self.calls), 1)
        self.screenshot('forbidden.png')

    def test_timeout_retry_and_export_exact_query_and_download(self):
        self.open(); self.filters()
        self.search(dict(code='InvestigationTimedOut'), 503)
        expect(self.document_status()).to_be_visible()
        expect(self.document_status()).to_have_text('기간이나 조건을 좁혀 다시 시도')
        self.search(answer([event('ROW')], (), 'MORE'))
        exported = answer([event('EXPORT-ROW')], [event('EXPORT-VIEW', '열람')])
        self.replies.append((200, exported))
        with self.page.expect_download() as download:
            self.page.get_by_role('button', name='Export', exact=True).click()
        self.assertEqual(json.loads(Path(download.value.path()).read_text(encoding='utf-8')), exported)
        self.assertEqual(self.calls[-1][0], '/api/emr-audit/exports')
        self.assertEqual(self.calls[-1][1], self.calls[-2][1])
        self.assertNotIn('changesAfter', self.calls[-1][1])

    def test_late_response_filter_a_b_a_and_literal_server_text(self):
        self.open(); self.filters()
        self.replies.append('hold')
        with self.page.expect_request('**/api/emr-audit/investigations'):
            self.page.get_by_role('button', name='Search', exact=True).click()
        self.page.get_by_label('Patient ID', exact=True).fill('B')
        self.page.get_by_label('Patient ID', exact=True).fill('SYN-PATIENT')
        self.search(answer([event('<b>NEW</b>')]))
        self.held.pop().fulfill(json=answer([event('OLD')]))
        expect(self.page.get_by_role('region', name='Change History')).to_contain_text('<b>NEW</b>')
        self.assertEqual(self.page.locator('td b').count(), 0)
        expect(self.page.get_by_role('region', name='Change History')).not_to_contain_text('OLD')

    def test_failed_continuation_and_export_are_not_success(self):
        self.open(); self.filters()
        self.search(answer([event('KEPT')], (), 'C-NEXT'))
        self.replies.append((503, dict(code='InvestigationTimedOut')))
        self.page.get_by_role('button', name='Load More', exact=True).click()
        expect(self.document_status()).to_be_visible()
        expect(self.document_status()).to_contain_text('기간이나 조건을 좁혀 다시 시도')
        expect(self.document_status()).to_be_visible()
        expect(self.document_status()).to_contain_text('표시된 기록은 일부입니다.')
        expect(self.page.get_by_role('region', name='Change History')).to_contain_text('KEPT')
        downloads = []
        self.page.on('download', lambda download: downloads.append(download))
        self.replies.append((500, dict(code='LedgerReadFailed')))
        self.page.get_by_role('button', name='Export', exact=True).click()
        expect(self.document_status()).to_be_visible()
        expect(self.document_status()).to_contain_text('내보내기에 실패했습니다.')
        self.assertEqual(downloads, [])
        self.replies.append((403, dict(code='AuditScopeNotGranted')))
        self.page.get_by_role('button', name='Export', exact=True).click()
        expect(self.page.get_by_text('이 계정에는 내보내기 권한이 없습니다.', exact=True)).to_be_visible()
        expect(self.page.get_by_role('region', name='Change History')).to_contain_text('KEPT')
        self.assertEqual(downloads, [])

    def test_logout_clears_results_and_ignores_inflight_read(self):
        self.open(); self.filters()
        self.search(answer([event('PATIENT-RECORD')], (), 'C-NEXT'))
        self.replies.append('hold')
        with self.page.expect_request('**/api/emr-audit/investigations'):
            self.page.get_by_role('button', name='Load More', exact=True).click()
        self.page.get_by_role('button', name='Log out', exact=True).click()
        expect(self.page.get_by_role('region', name='Change History')).to_be_hidden()
        self.held.pop().fulfill(json=answer([event('LATE-RECORD')]))
        expect(self.page.locator('body')).not_to_contain_text('PATIENT-RECORD')
        expect(self.page.locator('body')).not_to_contain_text('LATE-RECORD')

    def test_export_scope_denial_preserves_search_results(self):
        self.open(); self.filters()
        self.search(answer([event('KEPT')]))
        downloads = []
        self.page.on('download', lambda download: downloads.append(download))
        self.replies.append((403, dict(code='AuditScopeNotGranted')))
        self.page.get_by_role('button', name='Export', exact=True).click()
        expect(self.page.get_by_role('region', name='Change History')).to_be_visible()
        expect(self.page.get_by_role('region', name='Change History')).to_contain_text('KEPT')
        expect(self.page.get_by_text('이 계정에는 내보내기 권한이 없습니다.', exact=True)).to_be_visible()
        self.assertEqual(downloads, [])
        self.screenshot('export-scope.png')
        self.search(answer([event('STILL-ALLOWED')]))
        expect(self.page.get_by_role('region', name='Change History')).to_contain_text('STILL-ALLOWED')
        self.replies.append((403, dict(code='AuditorNotDesignated')))
        self.page.get_by_role('button', name='Export', exact=True).click()
        expect(self.document_status()).to_be_visible()
        expect(self.document_status()).to_have_text('감사 기록을 조회할 권한이 없습니다.')
        self.assertEqual(self.page.locator('body').inner_text(), '감사 기록을 조회할 권한이 없습니다.')

    def test_open_only_shows_filters_without_reading_records(self):
        self.open()
        self.assertEqual(self.calls, [])
        expect(self.page.get_by_role('region', name='Change History')).to_be_hidden()
        expect(self.page.get_by_role('region', name='Access', exact=True)).to_be_hidden()
        expect(self.document_status()).not_to_contain_text('다시 로그인')
        self.screenshot('filters-only.png')

    def test_startup_does_not_claim_session_failure(self):
        sessions = []
        self.page.route('**/api/me', lambda route: sessions.append(route))
        self.page.goto(f'http://127.0.0.1:{self.server.server_port}/worklist-v0/hpacs-lite/audit.html', wait_until='domcontentloaded')
        expect(self.document_status()).to_be_visible()
        expect(self.document_status()).to_have_text('세션을 확인하고 있습니다.')
        self.assertEqual(self.calls, [])
        sessions.pop().fulfill(json=dict(sub='SYN-AUDITOR', user='Synthetic Auditor', roles=self.roles,
                                        institution='SYN-SITE', sessionId='SYN-SESSION'))
        expect(self.page.get_by_role('button', name='Search', exact=True)).to_be_enabled()

    def test_missing_investigate_scope_keeps_workspace_available(self):
        self.open()
        self.search(dict(code='AuditScopeNotGranted'), 403)
        expect(self.document_status()).to_be_visible()
        expect(self.document_status()).to_have_text('이 계정에는 접속기록 조회 권한이 없습니다.')
        expect(self.page.get_by_role('button', name='Search', exact=True)).to_be_enabled()
        expect(self.page.get_by_role('button', name='Log out', exact=True)).to_be_visible()


if __name__ == '__main__': unittest.main()
