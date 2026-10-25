"""REQ-EMR-15/19 -> RISK-F-05 -> TEST-ACCESS-REVIEW-PAGE.

Serve the unchanged Admin document and its scripts; only API answers are synthetic.
No product fragments, replacement page, or implementation-string assertions.
"""
import functools
import http.server
import json
from pathlib import Path
import threading
import unittest
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FROM, UNTIL = '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'


def answer(rows, next_=None):
    return dict(institutionId='SYN-A', from_=FROM, until=UNTIL, rows=rows, next=next_)


def event(identity='SYN-1', result='prepared'):
    known = lambda value: dict(status='known', value=value)
    return dict(eventId=identity, occurredAt=FROM, recordedAt=FROM, statutoryAct='열람',
                userId=known(dict(id='SYN-DOCTOR', issuer='synthetic', subject='SYN-SUB')),
                rolesAtTime=known(['radiologist']), executor='member', actingInstitution=known('SYN-A'),
                managingInstitution=known('SYN-A'), trustedProxyIp=dict(status='unresolved', reason='not-observed'),
                targets=[dict(kind='download', patientLinkSnapshot=known(dict(patientId='SYN-PATIENT')),
                              studyId=known('SYN-STUDY'), recordId=known('SYN-RECORD'), versionId=known('1'))],
                surface='GET studies/:uid/original-downloads/:operationId/archive', action='provide-prepared',
                result=result, cause='user-view', context=dict(reason='<b>stored reason</b>'))


class AccessReviewPage(unittest.TestCase):
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
        self.context = self.browser.new_context(viewport={'width': 1440, 'height': 1000})
        self.page = self.context.new_page()
        self.replies, self.calls, self.held, self.errors = [], [], [], []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.route('**/api/**', self.api)
        self.page.goto(f'http://127.0.0.1:{self.server.server_port}/worklist-v0/hpacs-lite/admin.html')
        self.page.wait_for_function("!document.getElementById('access-review-load').disabled")
        self.page.get_by_label('From (UTC)', exact=True).fill('2026-10-01T00:00')
        self.page.get_by_label('Until (UTC, exclusive)', exact=True).fill('2026-11-01T00:00')

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def api(self, route):
        url = urlparse(route.request.url)
        if url.path == '/api/me':
            route.fulfill(json=dict(sub='SYN-ADMIN', user='SYN Admin', roles=['admin'], institution='SYN-A', sessionId='SYN-SESSION'))
        elif url.path == '/api/admin/users':
            route.fulfill(json=dict(page=1, pageSize=25, total=0, pendingCount=0, users=[]))
        elif url.path == '/api/admin/audit':
            self.calls.append(parse_qs(url.query))
            reply = self.replies.pop(0)
            if reply == 'hold': self.held.append(route)
            else:
                status, body = reply
                if 'from_' in body: body['from'] = body.pop('from_')
                route.fulfill(status=status, json=body)
        elif url.path == '/api/auth/logout': route.fulfill(status=204)
        else: route.fulfill(status=404, json={})

    def load(self, body, status=200):
        self.replies.append((status, body))
        self.page.get_by_role('button', name='Load Review', exact=True).click()
        self.page.wait_for_function("document.getElementById('access-review-state').textContent !== 'Loading'")

    def test_period_candidates_paging_and_results(self):
        self.assertEqual(self.calls, [])
        self.assertEqual(self.page.locator('#access-review-state').inner_text(), 'Not Loaded')
        self.page.get_by_label('Events', exact=False).select_option('files')
        self.load(answer([event()], 'SYN-CURSOR'))
        self.assertEqual(self.calls[0], dict(report=['access'], **{'from': [FROM]}, until=[UNTIL], downloads=['files']))
        self.assertEqual(self.page.locator('#access-review-state').inner_text(), 'Partial')
        text = self.page.locator('#access-review-rows').inner_text()
        for expected in ['SYN-DOCTOR', 'SYN-PATIENT', 'SYN-STUDY', 'prepared', 'unresolved: not-observed', '<b>stored reason</b>']:
            self.assertIn(expected, text)
        self.assertEqual(self.page.locator('#access-review-rows b').count(), 0)
        self.replies.append((200, answer([event('SYN-2', 'failed')])))
        self.page.get_by_role('button', name='Load More', exact=True).last.click()
        self.page.wait_for_function("document.getElementById('access-review-state').textContent === 'Loaded'")
        self.assertEqual(self.calls[-1]['after'], ['SYN-CURSOR'])
        self.assertEqual(self.page.locator('#access-review-rows tr').count(), 2)
        self.assertIn('failed', self.page.locator('#access-review-rows').inner_text())
        screenshot = ROOT / 'tmp/access-review/page.png'
        screenshot.parent.mkdir(parents=True, exist_ok=True)
        self.page.locator('#access-review').screenshot(path=str(screenshot))

    def test_empty_failure_partial_failure_and_filter_change(self):
        self.load(answer([]))
        self.assertEqual(self.page.locator('#access-review-state').inner_text(), 'No Events')
        self.load({}, 503)
        self.assertEqual(self.page.locator('#access-review-state').inner_text(), 'Query Failed')
        self.load(answer([event()], 'SYN-NEXT'))
        self.replies.append((503, {}))
        self.page.locator('#access-review-more').click()
        self.page.wait_for_function("document.getElementById('access-review-state').textContent === 'Query Failed'")
        self.assertEqual(self.page.locator('#access-review-rows tr').count(), 1)
        self.assertIn('일부', self.page.locator('#access-review-message').inner_text())
        self.page.get_by_label('Events', exact=False).select_option('files')
        self.assertEqual(self.page.locator('#access-review-rows tr').count(), 0)
        self.assertEqual(self.page.locator('#access-review-state').inner_text(), 'Not Loaded')

    def test_late_answer_after_a_b_a_and_logout(self):
        self.replies.append('hold')
        self.page.get_by_role('button', name='Load Review', exact=True).click()
        self.page.wait_for_timeout(100)
        self.page.get_by_label('Events', exact=False).select_option('files')
        self.page.get_by_label('Events', exact=False).select_option('all')
        self.load(answer([event('NEW')]))
        old = answer([event('OLD')]); old['from'] = old.pop('from_')
        self.held.pop().fulfill(json=old)
        self.page.wait_for_timeout(100)
        self.assertNotIn('OLD', self.page.locator('#access-review-rows').inner_text())
        self.page.get_by_role('button', name='Log out', exact=False).click()
        self.page.wait_for_timeout(100)
        self.assertEqual(self.page.locator('#access-review-rows tr').count(), 0)


if __name__ == '__main__': unittest.main()
