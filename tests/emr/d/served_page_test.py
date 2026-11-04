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

# B2-COMMIT 503 answers of a clinical write (emr-clinical routes): (code, server message, whether the write was stored).
# The command step was not stored; at the provide step the write was stored but its provide record was not, or could not
# be confirmed. The page cannot tell which: the choice or text and the same request stay for Retry or a Check.
B2_ANSWERS = [
    ('AppendNotCommitted', '저장이 완료되지 않았습니다. 입력은 유지됩니다.', False),
    ('ProvideNotRecorded', '열람 기록을 남기지 못해 내용을 보내지 않았습니다. 입력은 유지됩니다. 다시 열거나 같은 요청으로 다시 확인하세요.', True),
    ('OutcomeUnknown', '열람 기록이 저장됐는지 확인하지 못해 내용을 보내지 않았습니다. 입력은 유지됩니다. 다시 열거나 같은 요청으로 다시 확인하세요.', True),
]


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
        # B2-COMMIT answers for the next write: (code, message, whether the write was stored). A write already stored for
        # its requestId answers that stored result again (the clinical routes' idempotent replay).
        self.assignment_answers, self.assignment_posts, self.assignment_receipts = [], [], set()
        self.consultations, self.consultation_answers, self.consultation_posts, self.consultation_receipts = {}, [], [], {}

    def consultation(self, cid, uid, state, revision, requester, recipient, reason, reply=None):
        return {'id': cid, 'studyUid': uid, 'institutionId': h.INSTITUTION, 'state': state, 'revision': revision,
                'requesterSub': requester['sub'], 'requesterActor': requester['actor'], 'recipientSub': recipient['sub'],
                'recipientActor': recipient['actor'], 'recipientName': recipient['displayName'], 'reason': reason,
                'reply': reply, 'cancelReason': None, 'updatedAt': '2026-10-03T00:00:00.000Z', 'changedBy': requester['actor']}

    def consultation_write(self, route, request, account, path):
        """POST create (/studies/:uid/consultations) or action (/consultations/:id) with the requestId replay and the
        revision check of the consultation service."""
        body = request.post_data_json
        self.consultation_posts.append((path, body))
        answer = self.consultation_answers.pop(0) if self.consultation_answers else None
        owner = [h.INSTITUTION, account['sub']]
        rid = body['requestId']
        if rid not in self.consultation_receipts and (answer is None or answer[2]):
            found = re.fullmatch(r'/api/studies/([^/]+)/consultations', path)
            if found:
                recipient = next(r for r in (h.RAD, h.RAD_OTHER) if r['sub'] == body['recipientSub'])
                self.consultations[rid] = self.consultation(rid, found[1], 'Requested', 1, account, recipient, body['reason'])
                self.consultation_receipts[rid] = rid
            else:
                item = self.consultations[path.rsplit('/', 1)[-1]]
                if body['revision'] != item['revision']:
                    return route.fulfill(status=409, json={'code': 'CONSULTATION_CHANGED', 'message': 'SYN changed'})
                state = {'accept': 'Accepted', 'complete': 'Completed', 'cancel': 'Cancelled'}[body['action']]
                item.update(state=state, revision=item['revision'] + 1, changedBy=account['actor'],
                            **({'reply': body['note']} if body['action'] == 'complete' else {}))
                self.consultation_receipts[rid] = item['id']
        if answer is not None:
            return route.fulfill(status=503, json={'code': answer[0], 'message': answer[1]})
        return route.fulfill(status=201, json={'owner': owner, 'item': deepcopy(self.consultations[self.consultation_receipts[rid]]),
                                               'emr': None})

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
                  or path in ('/api/reader-candidates', '/api/consultations', '/api/consultation-candidates')
                  or path.startswith('/api/consultations/')
                  or re.fullmatch(r'/api/studies/[^/]+/(questions|reader-assignment|consultations)', path))
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
                self.assignment_posts.append(body)
                answer = self.assignment_answers.pop(0) if self.assignment_answers else None
                if body['requestId'] not in self.assignment_receipts and (answer is None or answer[2]):
                    if body['revision'] != self.assignment_revision:
                        return route.fulfill(status=409, json={'code': 'READER_ASSIGNMENT_CHANGED', 'message': 'SYN changed'})
                    self.assignment_revision += 1
                    self.assignment = {'sub': account['sub'], 'actor': account['actor'], 'name': account['displayName']} if body['readerSub'] else None
                    self.assignment_receipts.add(body['requestId'])
                if answer is not None:
                    return route.fulfill(status=503, json={'code': answer[0], 'message': answer[1]})
            return route.fulfill(status=201 if method == 'POST' else 200, json={
                'owner': [h.INSTITUTION, account['sub']], 'studyUid': found[1], 'revision': self.assignment_revision,
                'reader': self.assignment, 'canManage': False, 'blocked': None, 'history': []})
        owner = [h.INSTITUTION, account['sub']] if custom else None
        if method == 'POST' and (path.startswith('/api/consultations/') or re.fullmatch(r'/api/studies/[^/]+/consultations', path)):
            return self.consultation_write(route, request, account, path)
        if method == 'GET' and path == '/api/consultations':
            direction = parse_qs(query)['direction'][0]
            mine = 'recipientSub' if direction == 'received' else 'requesterSub'
            items = [deepcopy(c) for c in self.consultations.values() if c[mine] == account['sub']]
            return route.fulfill(json={'owner': owner, 'direction': direction, 'items': items, 'nextCursor': None})
        if method == 'GET' and path.startswith('/api/consultations/'):
            return route.fulfill(json={'owner': owner, 'item': deepcopy(self.consultations[path.rsplit('/', 1)[-1]]), 'emr': None})
        if method == 'GET' and path == '/api/consultation-candidates':
            return route.fulfill(json={'owner': owner, 'readers': [
                {'sub': h.RAD_OTHER['sub'], 'actor': h.RAD_OTHER['actor'], 'name': h.RAD_OTHER['displayName']}]})
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
            # The compact worklist exposes Refresh directly; the retired group is not a session contract.
            self.page.get_by_role('button', name='↻ Refresh', exact=True).click(no_wait_after=True)
        else:
            self.page.locator('#refresh').click(no_wait_after=True)
        # Replacement closes the old document and automatically enters the new
        # account. Waiting for a transient non-active state races that navigation
        # on Linux Chromium. Observe the new session, then revisit the same UID.
        self.page.wait_for_function("session => typeof KinWorkContext !== 'undefined' && "
                                    "KinWorkContext.state() === 'active' && KinWorkContext.session() === session",
                                    arg=self.site.cookie)
        self.select(name, h.UID_B)
        self.open_questions(name)
        expect(self.page.locator('#question-thread')).to_contain_text('CURRENT-' + h.UID_B)
        expect(self.page.locator('#question-thread')).to_contain_text('2030')
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

    def test_assignment_b2_commit_answers_keep_the_choice_and_converge_on_the_same_request(self):
        self.page.goto(h.MAIN_URL)
        self.select('main', h.UID)
        status, reader = self.page.locator('#ra-status'), self.page.locator('#ra-reader')
        current = self.page.locator('#ra-current')
        for (code, message, stored), want in zip(B2_ANSWERS, (h.RAD['sub'], '', h.RAD['sub'])):
            with self.subTest(code=code):
                self.page.locator('[data-reader-assignment]').first.click()
                expect(reader).to_be_enabled()
                before, revision = current.inner_text(), self.site.assignment_revision
                reader.select_option(want)
                self.site.assignment_answers = [(code, message, stored)]
                self.page.locator('#ra-save').click()
                # The page cannot tell what was stored: the choice and its request stay, Retry is offered.
                expect(status).to_contain_text(message)
                expect(status).to_contain_text('선택은 유지했습니다')
                expect(self.page.locator('#ra-retry')).to_be_visible()
                expect(reader).to_have_value(want)
                expect(current).to_have_text(before)
                first = self.site.assignment_posts[-1]
                # Check: Reload Assignment reads the stored assignment and never writes.
                self.page.locator('#ra-reload').click()
                if stored:
                    expect(self.page.locator('#ra-retry')).to_be_hidden()
                else:
                    expect(status).to_contain_text('같은 요청을 다시 시도하세요')
                    expect(self.page.locator('#ra-retry')).to_be_visible()
                    expect(reader).to_have_value(want)
                    self.assertEqual(first, self.site.assignment_posts[-1], 'the read wrote nothing')
                    # Retry sends the same requestId, revision and reader; the server applies it now.
                    self.page.locator('#ra-retry').click()
                    expect(status).to_have_text('배정이 저장되었습니다.')
                    self.assertEqual(first, self.site.assignment_posts[-1])
                self.assertEqual((want or None, revision), (first['readerSub'], first['revision']))
                expect(current).to_contain_text(h.RAD['displayName'] if want else 'Unassigned')
                self.assertEqual((revision + 1, want or None), (self.site.assignment_revision, (self.site.assignment or {}).get('sub')),
                                 'the request applied once')
                self.page.locator('#ra-close').click()
                expect(self.page.locator('#reader-assignment-dialog')).to_be_hidden()
        self.assertEqual(3, self.site.assignment_revision, 'each request applied once')

    def open_consultations(self):
        # Consultations sits in the toolbar's More menu.
        self.page.locator('#toolbar-more > summary').click()
        self.page.locator('#consultations-open').click()
        expect(self.page.locator('#consultations-dialog')).to_be_visible()

    def test_consultation_b2_commit_answers_keep_the_text_and_retry_the_same_request(self):
        ids = {}
        for code, _, _ in B2_ANSWERS:
            ids[code] = str(uuid4())
            self.site.consultations[ids[code]] = self.site.consultation(ids[code], h.UID, 'Accepted', 2, h.RAD_OTHER, h.RAD,
                                                                         'SYN reason ' + code)
        self.page.goto(h.MAIN_URL)
        expect(self.page.locator('#rows')).to_contain_text(h.PATIENT)
        self.select('main', h.UID)
        self.open_consultations()
        expect(self.page.locator('#co-list [data-consultation]')).to_have_count(3)
        status, note, retry = self.page.locator('#co-status'), self.page.locator('#co-note'), self.page.locator('#co-retry')
        # Complete with Reply: the reply text, the requestId and the revision stay for Retry Same Request.
        for code, message, stored in B2_ANSWERS:
            with self.subTest(action='complete', code=code):
                self.page.locator(f'#co-list [data-consultation="{ids[code]}"]').click()
                expect(self.page.locator('#co-original')).to_have_text('SYN reason ' + code)
                reply = 'SYN reply after ' + code
                note.fill(reply)
                self.site.consultation_answers = [(code, message, stored)]
                self.page.locator('#co-complete').click()
                expect(status).to_contain_text(message)
                expect(status).to_contain_text('입력은 유지했습니다')
                expect(retry).to_be_visible()
                expect(note).to_have_value(reply)
                expect(self.page.locator('#co-current-state')).to_contain_text('Accepted')
                path, first = self.site.consultation_posts[-1]
                self.assertEqual((f'/api/consultations/{ids[code]}', 2, 'complete', reply),
                                 (path, first['revision'], first['action'], first['note']))
                retry.click()
                expect(status).to_have_text('자문 요청을 저장했습니다. 목록은 Reload로 갱신할 수 있습니다.')
                self.assertEqual((path, first), self.site.consultation_posts[-1], 'the same requestId, revision and text')
                expect(retry).to_be_hidden()
                expect(self.page.locator('#co-current-state')).to_contain_text('Completed')
                expect(self.page.locator('#co-answer')).to_have_text(reply)
                self.assertEqual(('Completed', 3, reply), tuple(self.site.consultations[ids[code]][k] for k in ('state', 'revision', 'reply')),
                                 'applied once')
        # A new request: the consultant, the reason and the requestId stay for Retry Same Request.
        code, message, stored = B2_ANSWERS[1]
        self.page.locator('#co-new').click()
        expect(self.page.locator('#co-reader option')).to_have_count(2)
        self.page.locator('#co-reader').select_option(h.RAD_OTHER['sub'])
        self.page.locator('#co-reason').fill('SYN new consultation reason')
        self.site.consultation_answers = [(code, message, stored)]
        self.page.locator('#co-send').click()
        expect(status).to_contain_text(message)
        expect(retry).to_be_visible()
        expect(self.page.locator('#co-reason')).to_have_value('SYN new consultation reason')
        expect(self.page.locator('#co-reader')).to_have_value(h.RAD_OTHER['sub'])
        path, first = self.site.consultation_posts[-1]
        retry.click()
        expect(status).to_have_text('자문 요청을 저장했습니다. 목록은 Reload로 갱신할 수 있습니다.')
        self.assertEqual((path, first), self.site.consultation_posts[-1])
        self.assertEqual(f'/api/studies/{h.UID}/consultations', path)
        created = self.site.consultations[first['requestId']]
        self.assertEqual(('Requested', 'SYN new consultation reason', h.RAD_OTHER['sub']),
                         (created['state'], created['reason'], created['recipientSub']))
        self.assertEqual(4, len(self.site.consultations), 'one consultation per request')
        expect(self.page.locator('#co-current-state')).to_contain_text('Requested')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main()
