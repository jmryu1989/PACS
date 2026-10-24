"""D-04 -> D-T3, D-T5: unmodified served main/clinician assets in Chromium.

The wire fixture delays actual browser responses, including signature metadata.
It does not prove PostgreSQL signing (routes_pg_test.cjs does that). Fetch keeps
the response alive despite AbortController to exercise generation checks too.
"""
from copy import deepcopy
from pathlib import Path
import re
import sys
import time
import unittest
from urllib.parse import parse_qs
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests'))
import auth_logout_dom_test as h
from playwright.sync_api import sync_playwright, expect


class Site(h.Site):
    def __init__(self):
        super().__init__()
        self.second_study = True
        self.ids = {uid: str(uuid4()) for uid in (h.UID, h.UID_B)}
        self.hold_thread = False
        self.threads = []
        self.assignment = None
        self.assignment_revision = 0
        self.refuse_assignment = False

    def question(self, uid, old=False):
        at = '2001-01-01T00:00:00.000Z' if old else '2030-01-01T00:00:00.000Z'
        person = {'actor': h.CLINICIAN['actor'], 'name': h.CLINICIAN['displayName']}
        anchor = {'rs': 'W', 'version': None}
        return {'id': self.ids[uid], 'studyUid': uid, 'state': 'Open', 'revision': 1, 'entryCount': 1,
                'author': person, 'createdAt': at, 'lastEntryAt': at, 'closed': None, 'current': anchor,
                'entries': [{'id': self.ids[uid], 'seq': 1, 'kind': 'question',
                             'body': ('OLD' if old else 'CURRENT') + '-' + uid,
                             'author': {**person, 'role': 'clinician'}, 'at': at, 'reportAnchor': anchor}]}

    def thread(self, uid, account, old=False):
        at = '2001-01-01T00:00:00.000Z' if old else '2030-01-01T00:00:00.000Z'
        return {'owner': [h.INSTITUTION, account['sub']], 'item': self.question(uid, old),
                'emr': {'studyId': uid, 'recordId': self.ids[uid], 'signatures': [
                    {'revision': 1, 'versionId': str(uuid4()), 'signature': {'signedAt': at}}]}}

    def api(self, route, request, method, path, query):
        custom = (path.startswith('/api/clinician/studies') or path.startswith('/api/questions/')
                  or path == '/api/reader-candidates'
                  or re.fullmatch(r'/api/studies/[^/]+/(questions|reader-assignment)', path))
        if custom:
            _, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
        account = self.account
        if path == '/api/clinician/studies':
            rows = [{'uid': uid, 'id': 'SYN-' + uid[-1], 'name': name, 'date': '20261024', 'birth': '19800101',
                     'sex': 'M', 'desc': 'Synthetic', 'modality': 'CT', 'count': 1, 'series': 1,
                     'report': {'final': False, 'rs': 'W'}} for uid, name in [(h.UID, h.PATIENT), (h.UID_B, h.PATIENT_B)]]
            return route.fulfill(json={'studies': rows, 'pagination': {'limit': 100, 'offset': 0, 'total': 2, 'next': None}})
        if re.fullmatch(r'/api/clinician/studies/[^/]+/report', path):
            return route.fulfill(json={'uid': path.split('/')[-2], 'final': False, 'rs': 'W'})
        if re.fullmatch(r'/api/clinician/studies/[^/]+/key-images', path):
            return route.fulfill(json={'items': [], 'nextCursor': None})
        found = re.fullmatch(r'/api/studies/([^/]+)/questions', path)
        if found:
            return route.fulfill(json={'owner': [h.INSTITUTION, account['sub']], 'items': [self.question(found[1])]})
        found = re.fullmatch(r'/api/questions/([^/]+)', path)
        if found:
            uid = next(uid for uid, id in self.ids.items() if id == found[1])
            if self.hold_thread:
                self.hold_thread = False
                self.threads.append((route, self.thread(uid, account, old=True)))
                return
            return route.fulfill(json=self.thread(uid, account))
        if path == '/api/reader-candidates':
            return route.fulfill(json={'owner': [h.INSTITUTION, account['sub']], 'canManage': False,
                                       'readers': [{'sub': account['sub'], 'actor': account['actor'], 'name': account['displayName']}]})
        found = re.fullmatch(r'/api/studies/([^/]+)/reader-assignment', path)
        if found:
            if method == 'POST':
                if self.refuse_assignment:
                    return route.fulfill(status=403, json={'message': '현재 배정 권한이 없습니다'})
                body = request.post_data_json
                self.assignment_revision += 1
                self.assignment = {'sub': account['sub'], 'actor': account['actor'], 'name': account['displayName']} if body['readerSub'] else None
            return route.fulfill(status=201 if method == 'POST' else 200, json={
                'owner': [h.INSTITUTION, account['sub']], 'studyUid': found[1], 'revision': self.assignment_revision,
                'reader': self.assignment, 'canManage': False, 'blocked': None, 'history': []})
        return super().api(route, request, method, path, query)


class ServedClinicalPages(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = Site()
        self.context = self.browser.new_context(viewport={'width': 1600, 'height': 1000}, locale='ko-KR')
        self.context.add_init_script("""const send=window.fetch;window.fetch=(url,init)=>send(url,
          String(url).includes('/questions/') ? {...init,signal:undefined} : init);""")
        self.context.route('**/*', lambda route, request: self.site.handle(route, request))
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.on('dialog', lambda dialog: dialog.accept())

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])
        self.assertEqual(self.site.violations, [])

    def held(self):
        deadline = time.monotonic() + 10
        while not self.site.threads and time.monotonic() < deadline:
            self.page.wait_for_timeout(20)
        self.assertEqual(len(self.site.threads), 1)

    def select(self, page, uid):
        self.page.locator(('#rows' if page == 'main' else '#studies') + f' tr[data-uid="{uid}"]').click()

    def open_questions(self, page):
        if page == 'main':
            if not self.page.locator('#question-pane').is_visible():
                self.page.locator('#question-toggle').click()
        elif self.page.locator('#questions').get_attribute('open') is None:
            self.page.locator('#questions-summary').click()
        self.page.locator('[data-open-thread]').first.click()

    def page_case(self, name):
        if name == 'clinician':
            self.site.sign_in(h.CLINICIAN)
        self.page.goto(h.ORIGIN + h.BASE + name + '.html')
        self.select(name, h.UID)
        self.site.hold_thread = True
        self.open_questions(name)
        self.held()
        self.select(name, h.UID_B)
        self.open_questions(name)
        area = self.page.locator('#question-thread')
        expect(area).to_contain_text('CURRENT-' + h.UID_B)
        self.select(name, h.UID)
        self.open_questions(name)
        expect(area).to_contain_text('CURRENT-' + h.UID)
        expect(area).to_contain_text('Signed')
        expect(area).to_contain_text('2030')
        route, body = self.site.threads.pop()
        route.fulfill(json=body)
        self.page.wait_for_timeout(100)
        expect(area).not_to_contain_text('OLD-')
        expect(area).not_to_contain_text('2001')
        # A second delayed body belongs to the old account even if UID matches.
        self.select(name, h.UID_B)
        self.site.hold_thread = True
        self.open_questions(name)
        self.held()
        old = self.site.account
        self.site.account = {**old, 'sub': h.RAD_OTHER['sub'], 'actor': h.RAD_OTHER['actor'], 'displayName': 'SYN switched doctor'}
        if name == 'main':
            self.page.get_by_role('group', name='Refresh').get_by_role('button', name='Refresh', exact=True).click()
        else:
            self.page.locator('#refresh').click()
        self.page.wait_for_function("KinWorkContext.state() !== 'active'")
        route, body = self.site.threads.pop()
        route.fulfill(json=body)
        self.page.wait_for_timeout(100)
        self.assertNotIn('OLD-', self.page.locator('body').inner_text())
        self.assertNotIn('2001', self.page.locator('body').inner_text())

    def test_main_a_b_a_and_doctor_switch_drop_late_body_and_signature(self):
        self.page_case('main')

    def test_clinician_a_b_a_and_doctor_switch_drop_late_body_and_signature(self):
        self.page_case('clinician')

    def test_assignment_allow_and_refuse_keep_report_input_and_read_access(self):
        self.page.goto(h.MAIN_URL)
        self.select('main', h.UID)
        self.page.locator('#findings').fill('SYN clinical input stays')
        self.page.locator('[data-reader-assignment]').first.click()
        expect(self.page.locator('#ra-reader')).to_be_enabled()
        self.page.locator('#ra-reader').select_option(h.RAD['sub'])
        self.page.locator('#ra-save').click()
        expect(self.page.locator('#ra-current')).to_contain_text(h.RAD['displayName'])
        self.page.locator('#ra-close').click()
        expect(self.page.locator('#findings')).to_have_value('SYN clinical input stays')
        self.page.locator('[data-reader-assignment]').first.click()
        expect(self.page.locator('#ra-reader')).to_be_enabled()
        self.page.locator('#ra-reader').select_option('')
        self.site.refuse_assignment = True
        self.page.locator('#ra-save').click()
        expect(self.page.locator('#ra-status')).to_contain_text('현재 배정 권한이 없습니다')
        expect(self.page.locator('#ra-current')).to_contain_text(h.RAD['displayName'])
        self.page.locator('#ra-close').click()
        expect(self.page.locator('#findings')).to_have_value('SYN clinical input stays')
        self.open_questions('main')
        expect(self.page.locator('#question-thread')).to_contain_text('CURRENT-' + h.UID)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main()
