# coding: utf-8
"""REQ-S8-CTX-NOTE -> RISK-CTX-NOTE-OUTCOME/WORK/SESSION -> TEST-S8-NOTE-T01..T27 (Astra S8-CTX contract 2026-10-05, s3/s4).

Every row of the save contract's transition table is one behaviour test, run twice on the same vector:
  - ModuleNoteTest: the shared module tech-note.js as the Worklist page uses it, over an api with the page's error
    contract (status on an answered failure, `sent:false` when nothing left);
  - WrapperNoteTest: the real viewer window (viewer-tech-note.js over tech-note.js, viewer session, gate, transport) with
    its account checks before and after each request.
Only HTTP answers are synthetic: NoteApi below is the server contract of section 2 (revisions keep the attempt id, the same
attempt sent again answers its revision, another request with that id is 400, reads answer attemptId and the
server-computed isOwnAttempt, CAS on the base version, the edit and first-note rules). Observed: the POST bodies (ids,
bases, count), the stored revisions, the input, the sentence shown, the published state and the questions asked.
No stack, no patient data. A source can be replaced for a negative control through KIN_CTX_TECH_NOTE_JS /
KIN_CTX_VIEWER_TECH_NOTE_JS.
"""
import os
import re
import uuid
from pathlib import Path
import unittest
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import sync_playwright, expect

try:
    from viewer_session_fixture import install_viewer_session
except ImportError:
    from tests.viewer_session_fixture import install_viewer_session

ROOT = Path(__file__).resolve().parents[1]
HP = ROOT / 'worklist-v0/hpacs-lite'
BASE = 'https://viewer-note.test'
UID = '1.2.3'
ME = dict(kind='member', sub='tech', institution='hospital', sessionId='S1', roles=['technician'])
UUID4 = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
OTHER_ID = '99999999-9999-4999-8999-999999999999'


def source(name):
    return Path(os.environ.get('KIN_CTX_' + name.replace('-', '_').replace('.', '_').upper(), HP / name))


# The contract's sentences (section 3), one per row. A Korean particle after a version number follows how the number is
# read: written out per version (v1 일, v2 이, v3 삼, v4 사), not computed, so a wrong rule in the screen cannot pass.
RO = {1: 'v1로', 2: 'v2로', 3: 'v3으로', 4: 'v4로'}
GWA = {1: 'v1과', 2: 'v2와', 3: 'v3과'}
EUL = {1: 'v1을', 2: 'v2를', 3: 'v3을'}
def opened(v): return f'마지막으로 확인한 메모는 v{v}입니다.' if v else '마지막으로 확인한 메모가 없습니다.'
DIFFERS, SAME = '현재 입력은 마지막 확인본과 다릅니다.', '현재 입력은 마지막 확인본과 같습니다.'
SAVING = '입력을 저장하는 중입니다.'
NEED_REASON = '이번 수정의 사유를 입력하세요.'
NEED_TEXT = '메모 내용을 입력하세요.'
def unchanged(v, reason_only=False):
    return f'새 저장은 보내지 않았으며 본문은 마지막 확인한 {GWA[v]} 같' + ('고 사유만의 변경은 저장되지 않습니다.' if reason_only else '습니다.')
def other_found(v): return f'다른 저장 {EUL[v]} 확인했으며 입력은 유지되므로 비교 후 Save Note 또는 Reload Note를 선택하세요.'
RESENDING = '앞선 저장 결과를 확인하며 같은 입력을 다시 요청합니다.'
PARALLEL = '현재 입력을 저장하는 중이며 앞선 시도와 결과를 구분해 확인합니다.'
REVERTED_UNKNOWN = '본문은 마지막 확인본과 같지만 앞선 저장 결과는 아직 알 수 없습니다.'
def saved(v): return f'입력이 {RO[v]} 저장되었습니다.'
REFUSED = '이번 저장은 거절되어 입력을 유지합니다'
UNSENT = '저장 요청을 보내지 못해 입력을 유지합니다.'
UNKNOWN = '저장 결과를 알 수 없으며 입력은 유지되므로 Save Note 또는 Reload Note로 확인하세요.'
STILL_UNKNOWN = '앞선 저장 결과는 아직 확인되지 않았으며 입력은 유지됩니다.'
OPEN_RESULT = ' 앞선 저장 결과는 아직 확인되지 않았습니다.'
def earlier(v): return f'앞선 입력은 {RO[v]} 저장되었습니다.'
def not_saved(v): return f'이 시도는 저장되지 않았고 마지막 확인본은 다른 저장인 v{v}이며 입력은 유지됩니다.'
def mine_then_other(m, v): return f'앞선 입력은 {RO[m]} 저장되었고 마지막 확인본은 다른 저장인 v{v}입니다.'
def followup_reason(v): return f'앞선 입력은 {RO[v]} 저장되었으며 현재 수정은 새 사유를 입력한 뒤 저장하세요.'
RELOAD_Q = '현재 입력을 버리고 마지막 저장본을 불러올까요?'
CLOSE_Q = '현재 입력이 마지막 확인본과 다른데 입력을 버리고 닫을까요?'
CLOSE_U = '저장 결과가 미확정이고 닫아도 저장이 취소되지는 않는데 닫을까요?'
HISTORY = '저장 이력을 표시하며 현재 입력은 유지됩니다.'
PREPARING = '로그아웃 확인 중이며 입력은 유지됩니다.'


class NoteApi:
    """The Tech Note API of contract section 2 for one study, no timing of its own."""

    def __init__(self):
        self.notes, self.posts, self.calls = [], [], []
        self.post_modes, self.get_modes, self.history_modes = [], [], []
        self.held, self.late, self.headers = {}, None, []

    def view(self, note):
        public = {k: note[k] for k in ('studyUid', 'version', 'text', 'reason', 'author', 'createdAt')}
        return dict(public, attemptId=note['attemptId'], isOwnAttempt=bool(note['attemptId']) and note['authorSub'] == ME['sub'])

    def latest(self):
        return self.view(self.notes[-1]) if self.notes else None

    def commit(self, body, sub=ME['sub'], author='tech'):
        """(status, note) - the order of section 2: the id first (after the permission checks), then the CAS."""
        attempt = body.get('attemptId')
        if attempt is not None and not (isinstance(attempt, str) and UUID4.match(attempt)):
            return 400, None
        reason = body['reason'].strip()
        if attempt:
            for note in self.notes:
                if note['attemptId'] == attempt:
                    same = (note['authorSub'], note['version'], note['text'], note['reason']) == (sub, body['baseVersion'] + 1, body['text'], reason)
                    return (200, note) if same else (400, None)
        if body['baseVersion'] != len(self.notes):
            return 409, None
        if self.notes and (not reason or self.notes[-1]['text'] == body['text']):
            return 400, None
        if not self.notes and not body['text'].strip():
            return 400, None
        note = dict(studyUid=UID, version=len(self.notes) + 1, text=body['text'], reason=reason, author=author,
                    authorSub=sub, createdAt='2026-10-06T00:00:00Z', attemptId=attempt)
        self.notes.append(note)
        return 200, note

    def foreign(self, text, reason='SYN their reason', sub='other-tech', attempt='new', author='other technician'):
        attempt = str(uuid.uuid4()) if attempt == 'new' else attempt
        status, note = self.commit(dict(baseVersion=len(self.notes), text=text, reason=reason, attemptId=attempt), sub=sub, author=author)
        assert status == 200, status
        return note

    def receipt(self, note):
        return dict(uid=UID, writable=True, note=self.view(note), latestNote=self.latest())


class Harness:
    """What both consumers share: the page, the routes over NoteApi and the observations."""
    STATE = None

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.api = NoteApi()
        self.me_answers = []
        self.context = self.browser.new_context()
        self.context.route(BASE + '/**', self.route)
        self.page = self.context.new_page()
        self.errors, self.dialogs, self.answers = [], [], []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.on('dialog', self.on_dialog)
        self.page.goto(BASE + '/ohif/viewer?StudyInstanceUIDs=' + UID)
        self.unbound = install_viewer_session(self.page)
        self.mount()

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])
        self.assertEqual(self.unbound, [])

    def on_dialog(self, dialog):
        self.dialogs.append(dialog.message)
        dialog.accept() if (self.answers.pop(0) if self.answers else True) else dialog.dismiss()

    # ── routes ──
    def route(self, route):
        request = route.request
        path = request.url[len(BASE):].split('?')[0]
        if path == '/api/me':
            self.api.calls.append('me')
            answer = self.me_answers.pop(0) if self.me_answers else None
            if answer == 'account':
                return route.fulfill(json={**ME, 'sub': 'different'})
            if answer == 'network':
                return route.abort()
            if answer:
                return route.fulfill(status=answer, json={'message': 'SYN account busy', 'code': 'AUTH_SESSION_BUSY'})
            return route.fulfill(json=ME)
        if path.endswith('/tech-note/history'):
            self.api.calls.append('HISTORY')
            mode = self.api.history_modes.pop(0) if self.api.history_modes else 'ok'
            if mode == 'fail':
                return route.fulfill(status=500, json={'message': 'SYN history unavailable'})
            before = int(parse_qs(urlparse(request.url).query).get('before', [len(self.api.notes) + 1])[0])
            items = [self.api.view(n) for n in reversed(self.api.notes) if n['version'] < before]
            if mode == 'missing':
                items = [i for i in items if i['version'] != before - 1]
            return route.fulfill(json=dict(uid=UID, items=items, nextBefore=None))
        if path.endswith('/tech-note') and request.method == 'GET':
            self.api.calls.append('GET')
            mode = self.api.get_modes.pop(0) if self.api.get_modes else 'ok'
            if mode == 'fail':
                return route.fulfill(status=500, json={'message': 'SYN read unavailable'})
            if mode == 'hold':
                self.api.held['GET'] = route
                return
            if mode == 'old':
                old = self.api.notes[:-1]
                return route.fulfill(json=dict(uid=UID, writable=True, note=self.api.view(old[-1]) if old else None))
            return route.fulfill(json=dict(uid=UID, writable=True, note=self.api.latest()))
        if path.endswith('/tech-note') and request.method == 'POST':
            self.api.calls.append('POST')
            body = request.post_data_json
            self.api.posts.append(body)
            self.api.headers.append({k: v for k, v in request.headers.items() if k.startswith('x-kin')})
            if self.api.late is not None:  # an earlier lost write commits now, just before this one is handled
                self.api.commit(self.api.late)
                self.api.late = None
            mode = self.api.post_modes.pop(0) if self.api.post_modes else 'ok'
            if mode == 'hold':
                self.api.held[len(self.api.posts) - 1] = route
                return
            if mode == 'abort':
                return route.abort()
            if mode == 'late':
                self.api.late = body
                return route.abort()
            if isinstance(mode, int):
                return route.fulfill(status=mode, json={'message': 'SYN write refused'})
            if mode == 'foreign-409':  # another save lands just before this write reaches the version check
                self.api.foreign('SYN v3 theirs')
                return route.fulfill(status=409, json={'message': 'SYN write refused'})
            status, note = self.api.commit(body)
            if mode == 'abort-commit':
                return route.abort()
            if mode == '500-commit':
                return route.fulfill(status=500, json={'message': 'SYN gateway'})
            if status != 200:
                return route.fulfill(status=status, json={'message': 'SYN write refused'})
            if mode == 'broken':
                receipt = self.api.receipt(note)
                receipt['note'].pop('attemptId')
                return route.fulfill(json=receipt)
            return route.fulfill(json=self.api.receipt(note))
        route.fulfill(body='<div id="root"><div id="image"></div><section id="kin-viewer-layout"></section></div>', content_type='text/html')

    def finish(self, index, commit=True, status=None):
        route = self.api.held.pop(index)
        if not commit:
            return route.fulfill(status=status or 500, json={'message': 'SYN not stored'})
        code, note = self.api.commit(self.api.posts[index])
        route.fulfill(status=code, json=self.api.receipt(note) if code == 200 else {'message': 'SYN write refused'})

    # ── observations and actions ──
    @property
    def note(self): return self.page.get_by_label('Note', exact=True)

    @property
    def reason(self): return self.page.get_by_label('Reason for Change')

    @property
    def status(self): return self.page.locator('#tech-note-status')

    @property
    def dialog(self): return self.page.locator('#tech-note-dialog')

    def state(self): return self.page.evaluate(self.STATE)

    def idle(self): self.page.wait_for_function('!(' + self.STATE + ').busy')

    def press(self, name):
        self.page.locator('#tech-note-dialog').get_by_role('button', name=name, exact=True).click()

    def save(self, wait=True):
        self.press('Save Note')
        if wait:
            self.idle()

    def reload(self):
        self.press('Reload Note'); self.idle()

    def opened_with(self, *texts, author_sub='other-tech'):
        """The dialog opened on a note whose revisions are `texts` (NULL ids, as before attempts had ids)."""
        for text in texts:
            self.api.commit(dict(baseVersion=len(self.api.notes), text=text, reason='SYN earlier' if self.api.notes else '', attemptId=None), sub=author_sub, author='SYN earlier')
        self.open()
        expect(self.note).to_be_editable()
        expect(self.status).to_have_text(opened(len(texts)))

    def edit(self, text, reason=None):
        self.note.fill(text)
        if reason is not None:
            self.reason.fill(reason)

    def lost_first_write(self, mode='abort'):
        """An edit of v1 whose POST answer is lost (`abort` not stored, `abort-commit` stored, `late` stored later)."""
        self.opened_with('SYN v1')
        self.edit('SYN v2 mine', 'SYN R1')
        self.api.post_modes = [mode]
        self.save()
        expect(self.status).to_have_text(UNKNOWN)
        self.assertTrue(self.state()['unknown'])

    def posts_of(self, key): return [p[key] for p in self.api.posts]


class Vectors:
    """TEST-S8-NOTE-T01..T27 on whichever consumer the harness mounts."""

    def test_T01_open_records_L_fills_text_and_leaves_reason_untyped(self):
        self.api.commit(dict(baseVersion=0, text='SYN v1', reason='', attemptId=None), sub='other-tech')
        self.api.commit(dict(baseVersion=1, text='SYN v2', reason='their reason', attemptId=None), sub='other-tech')
        self.open()
        expect(self.status).to_have_text(opened(2))
        expect(self.note).to_have_value('SYN v2'); expect(self.reason).to_have_value('')
        self.assertEqual(self.state(), {'dirty': False, 'busy': False, 'unknown': False})
        self.assertEqual(self.api.posts, [])
        self.page.keyboard.press('Escape')
        expect(self.dialog).not_to_be_visible(); self.assertEqual(self.dialogs, [])

    def test_T01_open_without_a_note(self):
        self.open()
        expect(self.status).to_have_text(opened(0))
        expect(self.note).to_have_value('')

    def test_T02_typing_reverting_and_reason_only_change_only_the_input(self):
        self.opened_with('SYN v1')
        self.note.fill('SYN v1 edited')
        expect(self.status).to_have_text(DIFFERS); self.assertTrue(self.state()['dirty'])
        self.note.fill('SYN v1')
        expect(self.status).to_have_text(SAME); self.assertFalse(self.state()['dirty'])
        self.reason.fill('SYN reason only')
        expect(self.status).to_have_text(DIFFERS); self.assertTrue(self.state()['dirty'])
        self.reason.fill('')
        self.assertFalse(self.state()['dirty'])
        self.assertEqual(self.api.posts, [])
        self.press('Close'); expect(self.dialog).not_to_be_visible(); self.assertEqual(self.dialogs, [])

    def test_T03_T11_one_save_one_post_with_an_attempt_id_and_its_receipt(self):
        self.opened_with('SYN v1')
        self.edit('SYN v2', '  SYN dose corrected  ')
        self.api.post_modes = ['hold']
        self.save(wait=False)
        self.page.wait_for_function('(' + self.STATE + ').busy')
        expect(self.status).to_have_text(SAVING)
        self.assertEqual(self.state(), {'dirty': True, 'busy': True, 'unknown': True})
        self.finish(0)
        self.idle()
        expect(self.status).to_have_text(saved(2))
        [body] = self.api.posts
        self.assertEqual((body['baseVersion'], body['text'], body['reason']), (1, 'SYN v2', '  SYN dose corrected  '))
        self.assertRegex(body['attemptId'], UUID4)
        self.assertEqual(self.api.notes[-1]['attemptId'], body['attemptId'])
        # The receipt changes no input: text and the reason as typed stay; the state is clean.
        expect(self.note).to_have_value('SYN v2'); expect(self.reason).to_have_value('  SYN dose corrected  ')
        self.assertEqual(self.state(), {'dirty': False, 'busy': False, 'unknown': False})
        self.assertEqual(self.api.calls.count('POST'), 1)
        self.page.keyboard.press('Escape'); self.assertEqual(self.dialogs, [])

    def test_T04_an_edit_needs_its_own_reason_and_a_used_reason_is_used(self):
        self.opened_with('SYN v1')
        self.edit('SYN v2')
        self.save()
        expect(self.status).to_have_text(NEED_REASON)
        expect(self.reason).to_be_focused()
        self.assertEqual(self.api.posts, [])
        self.reason.fill('SYN R1'); self.save()
        expect(self.status).to_have_text(saved(2))
        # The reason of a saved attempt is used: the next edit needs a reason typed for it (the box keeps the text).
        self.edit('SYN v3'); self.save()
        expect(self.status).to_have_text('앞선 입력은 v2로 저장되었으며 ' + NEED_REASON)
        expect(self.reason).to_have_value('SYN R1')
        self.assertEqual(len(self.api.posts), 1)
        # Typing the same words again is a new reason for this edit.
        self.reason.fill(''); self.reason.fill('SYN R1'); self.save()
        expect(self.status).to_have_text(saved(3))
        self.assertEqual(self.posts_of('reason'), ['SYN R1', 'SYN R1'])
        self.assertNotEqual(*self.posts_of('attemptId'))

    def test_T04_an_earlier_save_is_said_even_after_a_later_other_save(self):
        self.lost_first_write('abort-commit')
        self.api.foreign('SYN v3 theirs')
        self.reload()
        expect(self.status).to_have_text(mine_then_other(2, 3))
        self.note.fill('SYN v4 mine'); self.save()
        expect(self.status).to_have_text(f'앞선 입력은 {RO[2]} 저장되었으며 ' + NEED_REASON)
        self.assertEqual(len(self.api.posts), 1)

    def test_T04_a_reason_retyped_before_the_resend_is_used_by_it(self):
        # The same words typed again before the resend of the same request: that input is carried by the resend and used
        # up when it is saved, so the next edit still needs a reason typed for it.
        self.lost_first_write('abort')
        self.reason.fill(''); self.reason.fill('SYN R1')
        self.save()
        expect(self.status).to_have_text(saved(2))
        self.assertEqual(len(set(self.posts_of('attemptId'))), 1)
        self.note.fill('SYN v3 mine'); self.save()
        expect(self.status).to_have_text(f'앞선 입력은 {RO[2]} 저장되었으며 ' + NEED_REASON)
        self.assertEqual(len(self.api.posts), 2)

    def test_T05_a_blank_first_note_is_not_sent(self):
        self.open()
        for text in ('', '   '):
            with self.subTest(text=text):
                self.note.fill(text); self.save()
                expect(self.status).to_have_text(NEED_TEXT)
        self.assertEqual(self.api.posts, [])
        self.note.fill('SYN first'); self.save()
        expect(self.status).to_have_text(saved(1))
        self.assertEqual(self.posts_of('reason'), [''])

    def test_T06_unchanged_text_sends_nothing_and_a_reason_only_change_stays_unsaved(self):
        self.opened_with('SYN v1')
        self.save()
        expect(self.status).to_have_text(unchanged(1))
        self.assertFalse(self.state()['dirty'])
        self.reason.fill('SYN reason only'); self.save()
        expect(self.status).to_have_text(unchanged(1, reason_only=True))
        self.assertTrue(self.state()['dirty'])
        self.assertEqual(self.api.posts, [])
        self.answers.append(False)
        self.press('Close')
        self.assertEqual(self.dialogs, [CLOSE_Q]); expect(self.dialog).to_be_visible()
        expect(self.reason).to_have_value('SYN reason only')

    def test_T07_a_409_reads_the_other_save_stops_this_click_and_the_next_save_builds_on_it(self):
        self.opened_with('SYN v1')
        self.api.foreign('SYN v2 theirs')
        self.edit('SYN mine', 'SYN R1'); self.save()
        expect(self.status).to_have_text(other_found(2))
        self.assertEqual(self.api.calls.count('POST'), 1)
        expect(self.note).to_have_value('SYN mine'); expect(self.reason).to_have_value('SYN R1')
        self.assertEqual(self.state(), {'dirty': True, 'busy': False, 'unknown': False})
        # Save Note after seeing v2: the current input on the version already shown.
        self.save()
        expect(self.status).to_have_text(saved(3))
        self.assertEqual(self.posts_of('baseVersion'), [1, 2])
        self.assertEqual(self.api.notes[-1]['text'], 'SYN mine')

    def test_T08_unknown_old_read_same_input_resends_the_same_id_once(self):
        self.lost_first_write('abort')
        self.api.get_modes = ['ok']
        self.api.post_modes = ['hold']
        self.save(wait=False)
        for _ in range(200):
            if self.api.held:
                break
            self.page.wait_for_timeout(10)
        expect(self.status).to_have_text(RESENDING)
        self.finish(1)
        self.idle()
        expect(self.status).to_have_text(saved(2))
        self.assertEqual(len(set(self.posts_of('attemptId'))), 1, 'the same attempt id')
        self.assertEqual(self.api.posts[0], self.api.posts[1], 'the same request')
        self.assertEqual(len(self.api.notes), 2)
        self.assertFalse(self.state()['unknown'])

    def test_T08_resend_of_a_stored_attempt_answers_its_receipt_and_writes_nothing_more(self):
        # The opposite side of T08: the first send was stored; the same id comes back with that revision.
        self.lost_first_write('abort')
        self.api.commit(self.api.posts[0])  # stored after all, only after the read showed v1
        self.api.get_modes = ['old']
        self.save()
        expect(self.status).to_have_text(saved(2))
        self.assertEqual(len(self.api.posts), 2)
        self.assertEqual(len(self.api.notes), 2, 'no second revision')
        self.assertEqual(self.api.posts[0]['attemptId'], self.api.posts[1]['attemptId'])

    def test_T09_unknown_old_read_changed_input_sends_a_new_id_on_the_same_base(self):
        self.lost_first_write('abort')
        self.edit('SYN v2 corrected', 'SYN R2')
        self.save()
        expect(self.status).to_have_text(saved(2))
        a, b = self.api.posts
        self.assertNotEqual(a['attemptId'], b['attemptId'])
        self.assertEqual((a['baseVersion'], b['baseVersion']), (1, 1))
        self.assertEqual(self.api.notes[-1]['text'], 'SYN v2 corrected')
        self.assertFalse(self.state()['unknown'], 'the first attempt is settled by the receipt of v2 with another id')

    def test_T09_the_earlier_attempt_wins_meanwhile_and_the_current_input_follows_once(self):
        # Either attempt may win; the ids decide. Here the lost first write is stored just before the second arrives.
        self.lost_first_write('late')
        self.edit('SYN v2 corrected', 'SYN R2')
        self.save()
        expect(self.status).to_have_text(saved(3))
        self.assertEqual(self.posts_of('baseVersion'), [1, 1, 2])
        self.assertEqual([n['text'] for n in self.api.notes], ['SYN v1', 'SYN v2 mine', 'SYN v2 corrected'])
        self.assertEqual(self.state(), {'dirty': False, 'busy': False, 'unknown': False})

    def test_T10_unknown_with_text_back_at_L_sends_nothing_and_stays_unknown(self):
        self.lost_first_write('abort')
        self.note.fill('SYN v1'); self.save()
        expect(self.status).to_have_text(REVERTED_UNKNOWN)
        self.assertEqual(len(self.api.posts), 1)
        self.assertEqual(self.state(), {'dirty': True, 'busy': False, 'unknown': True})
        self.answers.append(False)
        self.press('Close')
        self.assertEqual(self.dialogs, [CLOSE_U]); expect(self.dialog).to_be_visible()

    def test_T11_a_receipt_without_this_attempts_id_is_not_a_receipt(self):
        self.opened_with('SYN v1')
        self.edit('SYN v2', 'SYN R1')
        self.api.post_modes = ['broken']
        self.save()
        expect(self.status).to_have_text(UNKNOWN)
        self.assertTrue(self.state()['unknown'])
        self.reload()  # the read finds the revision with this id
        expect(self.status).to_have_text(earlier(2))
        self.assertFalse(self.state()['unknown'])

    def test_T12_an_answered_refusal_is_final_at_once(self):
        self.opened_with('SYN v1')
        self.edit('SYN v2', 'SYN R1')
        self.api.post_modes = [403]
        self.save()
        expect(self.status).to_contain_text(REFUSED)
        self.assertEqual(self.state(), {'dirty': True, 'busy': False, 'unknown': False})
        self.assertEqual(self.api.calls.count('POST'), 1)
        self.assertEqual(self.api.calls.count('GET'), 1, 'no read to settle a refusal')
        self.answers.append(True); self.press('Close')
        self.assertEqual(self.dialogs, [CLOSE_Q])

    def test_T12_a_refused_resend_does_not_settle_an_earlier_unknown_send(self):
        self.lost_first_write('abort')
        self.api.post_modes = [400]
        self.save()
        # Both facts: this send was refused, and the earlier send of the same id is still unknown.
        expect(self.status).to_have_text(re.compile(re.escape(REFUSED) + '.*' + re.escape(OPEN_RESULT) + '$'))
        self.assertEqual(len(set(self.posts_of('attemptId'))), 1)
        self.assertTrue(self.state()['unknown'], 'the first send of this id may still have been stored')

    def test_T13_a_5xx_or_lost_answer_is_unknown_and_never_resent_by_itself(self):
        for mode in (500, 'abort', '500-commit'):
            with self.subTest(mode=mode):
                if mode != 500:
                    self.setUp_again()
                self.opened_with('SYN v1')
                self.edit('SYN v2', 'SYN R1')
                self.api.post_modes = [mode]
                self.save()
                expect(self.status).to_have_text(UNKNOWN)
                self.page.wait_for_timeout(200)
                self.assertEqual(self.api.calls.count('POST'), 1)
                self.assertEqual(self.state(), {'dirty': True, 'busy': False, 'unknown': True})
                self.answers.append(False); self.press('Close')
                self.assertEqual(self.dialogs[-1], CLOSE_U)

    def test_T12_an_unsent_resend_keeps_the_earlier_unknown_and_both_facts(self):
        self.lost_first_write('abort')
        self.prevent_resend()
        self.save()
        expect(self.status).to_have_text(UNSENT + OPEN_RESULT)
        self.assertEqual(len(self.api.posts), 1, 'the resend never left, but the first send may have committed')
        self.assertEqual(self.state(), {'dirty': True, 'busy': False, 'unknown': True})
        expect(self.note).to_have_value('SYN v2 mine'); expect(self.reason).to_have_value('SYN R1')
        self.answers.append(False); self.press('Close')
        self.assertEqual(self.dialogs, [CLOSE_U])
        expect(self.dialog).to_be_visible()

    def test_T14_an_older_read_a_missing_history_row_or_a_failed_read_leave_the_attempt_unknown(self):
        self.lost_first_write('abort-commit')
        self.api.foreign('SYN v3 theirs')
        self.api.history_modes = ['missing']
        self.reload()
        expect(self.status).to_have_text(STILL_UNKNOWN)
        self.assertTrue(self.state()['unknown'])
        expect(self.page.locator('#tech-note-meta')).to_contain_text('v3')
        # A later older read never takes L back.
        self.api.get_modes = ['fail']
        self.reload()
        expect(self.status).to_contain_text(STILL_UNKNOWN[:-1])
        self.assertTrue(self.state()['unknown'])
        expect(self.note).to_have_value('SYN v2 mine')
        # An older read (it answers v2, this attempt's own revision) settles the attempt but never takes L back to v2.
        self.api.get_modes = ['old']
        self.reload()
        expect(self.status).to_have_text(mine_then_other(2, 3))
        expect(self.page.locator('#tech-note-meta')).to_contain_text('v3')
        self.assertEqual(len(self.api.posts), 1)

    def test_T15_the_attempts_own_revision_settles_it_and_keeps_the_input(self):
        self.lost_first_write('abort-commit')
        self.reload()
        expect(self.status).to_have_text(earlier(2))
        expect(self.note).to_have_value('SYN v2 mine'); expect(self.reason).to_have_value('SYN R1')
        self.assertEqual(self.state(), {'dirty': False, 'busy': False, 'unknown': False})
        # Its reason is used: a further edit needs a new one.
        self.edit('SYN v3'); self.save()
        expect(self.status).to_have_text('앞선 입력은 v2로 저장되었으며 ' + NEED_REASON)
        self.assertEqual(len(self.api.posts), 1)

    def test_T15_a_different_reason_after_the_settled_attempt_is_said_unsaved(self):
        self.lost_first_write('abort-commit')
        self.reason.fill('SYN R1 typo fixed')
        self.reload()
        expect(self.status).to_have_text('앞선 입력은 v2로 저장되었으며 현재 사유는 저장되지 않았습니다.')
        self.assertTrue(self.state()['dirty'])

    def test_T16_the_exact_next_revision_with_another_or_no_id_proves_not_saved(self):
        for attempt, sub in ((OTHER_ID, ME['sub']), (None, ME['sub']), (OTHER_ID, 'other-tech')):
            with self.subTest(attempt=attempt, sub=sub):
                if (attempt, sub) != (OTHER_ID, ME['sub']):
                    self.setUp_again()
                self.lost_first_write('abort')
                # Same author (or not), same text, same reason - only the id tells.
                self.api.foreign('SYN v2 mine', 'SYN R1', sub=sub, attempt=attempt, author='tech')
                self.reload()
                expect(self.status).to_have_text(not_saved(2))
                self.assertEqual(self.state(), {'dirty': False, 'busy': False, 'unknown': False})
                expect(self.reason).to_have_value('SYN R1')
                # Not mine: its reason is not used up; the next Save of a change is allowed with it.
                self.note.fill('SYN v3 mine'); self.save()
                expect(self.status).to_have_text(saved(3))

    def test_T17_my_v2_and_a_later_other_v3_are_both_said(self):
        self.lost_first_write('abort-commit')
        self.api.foreign('SYN v3 theirs')
        self.reload()
        expect(self.status).to_have_text(mine_then_other(2, 3))
        self.assertEqual(self.state(), {'dirty': True, 'busy': False, 'unknown': False})
        self.assertEqual(self.api.calls.count('HISTORY'), 1)
        self.note.fill('SYN v3 theirs')
        self.assertTrue(self.state()['dirty'], 'a reason typed for this edit that differs from v3''s is still input')
        self.reason.fill('')
        self.assertFalse(self.state()['dirty'], 'input equal to the last confirmed version is clean')

    def test_T16_matching_id_without_ownership_is_not_my_save(self):
        self.lost_first_write('abort')
        # Defensive read contract: a matching id alone never proves this caller's save.
        self.api.foreign('SYN v2 mine', 'SYN R1', sub='other-tech', attempt=self.api.posts[0]['attemptId'])
        self.reload()
        expect(self.status).to_have_text(not_saved(2))
        self.assertEqual(self.state(), {'dirty': False, 'busy': False, 'unknown': False})
        expect(self.note).to_have_value('SYN v2 mine'); expect(self.reason).to_have_value('SYN R1')
        self.note.fill('SYN v3 mine'); self.save()
        expect(self.status).to_have_text(saved(3))
        self.assertEqual(self.posts_of('baseVersion'), [1, 2])

    def test_T18_my_earlier_save_found_and_a_changed_box_send_one_followup(self):
        self.lost_first_write('abort-commit')
        self.edit('SYN v3 mine', 'SYN R2')
        self.save()
        expect(self.status).to_have_text(saved(3))
        self.assertEqual(self.posts_of('baseVersion'), [1, 2])
        self.assertEqual(self.state(), {'dirty': False, 'busy': False, 'unknown': False})

    def test_T18_without_a_new_reason_the_followup_waits(self):
        self.lost_first_write('abort-commit')
        self.note.fill('SYN v3 mine'); self.save()
        expect(self.status).to_have_text(followup_reason(2))
        expect(self.reason).to_be_focused()
        self.assertEqual(len(self.api.posts), 1)
        self.assertTrue(self.state()['dirty'])

    def test_T18_another_save_found_stops_the_followup(self):
        self.lost_first_write('abort-commit')
        self.api.foreign('SYN v3 theirs')
        self.edit('SYN v4 mine', 'SYN R2'); self.save()
        expect(self.status).to_have_text(mine_then_other(2, 3))
        self.assertEqual(len(self.api.posts), 1)

    def test_T19_a_refused_or_unknown_followup_keeps_both_facts_and_writes_no_more(self):
        for mode, said in ((400, '앞선 입력은 v2로 저장되었지만 이번 입력은 거절되어 유지됩니다'),
                           (500, '앞선 입력은 v2로 저장되었지만 이번 입력의 저장 결과는 알 수 없으며'),
                           ('foreign-409', f'앞선 입력은 v2로 저장되었지만 이번 입력은 다른 저장 {GWA[3]} 충돌해 거절되었으며')):
            with self.subTest(mode=mode):
                if mode != 400:
                    self.setUp_again()
                self.lost_first_write('abort-commit')
                self.edit('SYN v3 mine', 'SYN R2')
                self.api.post_modes = [mode]
                self.save()
                expect(self.status).to_contain_text(said)
                self.page.wait_for_timeout(200)
                self.assertEqual(len(self.api.posts), 2)
                expect(self.note).to_have_value('SYN v3 mine'); expect(self.reason).to_have_value('SYN R2')

    def test_T20_reload_while_unknown_only_reads(self):
        self.lost_first_write('abort')
        self.edit('SYN typed after', 'SYN R9')
        self.reload()
        expect(self.status).to_have_text(STILL_UNKNOWN)
        expect(self.note).to_have_value('SYN typed after')
        self.assertEqual(len(self.api.posts), 1)
        self.assertEqual(self.dialogs, [])

    def test_T21_reload_asks_once_when_input_would_be_lost_and_keeps_it_on_cancel(self):
        self.opened_with('SYN v1')
        self.reload(); self.assertEqual(self.dialogs, [])  # nothing to lose: no question
        self.edit('SYN typed', 'SYN R')
        reads = self.api.calls.count('GET')
        self.answers.append(False); self.press('Reload Note')
        self.assertEqual(self.dialogs, [RELOAD_Q])
        expect(self.note).to_have_value('SYN typed')
        self.assertEqual(self.api.calls.count('GET'), reads)
        self.api.foreign('SYN v2 theirs')
        self.answers.append(True); self.reload()
        expect(self.note).to_have_value('SYN v2 theirs'); expect(self.reason).to_have_value('')
        expect(self.status).to_have_text(opened(2))
        self.assertEqual(self.state(), {'dirty': False, 'busy': False, 'unknown': False})
        # A conflict alone is no question: after a 409 with the input put back to the last version, Reload asks nothing.
        self.api.foreign('SYN v3 theirs')
        self.edit('SYN mine', 'SYN R1'); self.save()
        expect(self.status).to_have_text(other_found(3))
        self.note.fill('SYN v3 theirs'); self.reason.fill('')
        prompts = len(self.dialogs)
        self.reload(); self.assertEqual(len(self.dialogs), prompts)

    def test_T22_close_is_immediate_when_clean_asks_once_otherwise_and_a_write_in_flight_does_not_trap(self):
        self.opened_with('SYN v1')
        self.edit('SYN v2', 'SYN R1')
        self.answers.append(False); self.press('Close')
        self.assertEqual(self.dialogs, [CLOSE_Q]); expect(self.note).to_have_value('SYN v2')
        self.api.post_modes = ['hold']
        self.save(wait=False)
        for _ in range(200):
            if self.api.held:
                break
            self.page.wait_for_timeout(10)
        expect(self.page.locator('#tech-note-close')).to_be_enabled()
        self.answers.append(True); self.press('Close')
        self.assertEqual(self.dialogs[-1], CLOSE_U)
        expect(self.dialog).not_to_be_visible()
        self.finish(0)
        self.page.wait_for_timeout(200)
        expect(self.dialog).not_to_be_visible()
        self.assertEqual(len(self.api.notes), 2, 'closing does not cancel the write')

    def test_T21_accepted_older_read_keeps_the_newer_last_confirmed_revision(self):
        self.opened_with('SYN v1')
        self.edit('SYN v2 mine', 'SYN R1'); self.save()
        expect(self.status).to_have_text(saved(2))
        self.edit('SYN unsaved', 'SYN R2')
        self.api.get_modes = ['old']
        self.reload()
        self.assertEqual(self.dialogs, [RELOAD_Q])
        expect(self.status).to_have_text(opened(2))
        expect(self.page.locator('#tech-note-meta')).to_contain_text('v2 ·')
        expect(self.note).to_have_value('SYN v2 mine'); expect(self.reason).to_have_value('')
        self.assertFalse(self.state()['dirty'])
        self.save(); expect(self.status).to_have_text(unchanged(2))
        self.assertEqual(len(self.api.posts), 1)

    def test_T22_conflict_alone_closes_without_a_question(self):
        self.opened_with('SYN v1')
        self.api.foreign('SYN v2 theirs')
        self.edit('SYN mine', 'SYN R1'); self.save()
        expect(self.status).to_have_text(other_found(2))
        self.note.fill('SYN v2 theirs'); self.reason.fill('')
        self.assertEqual(self.state(), {'dirty': False, 'busy': False, 'unknown': False})
        self.press('Close')
        expect(self.dialog).not_to_be_visible()
        self.assertEqual(self.dialogs, [])

    def test_T23_history_reads_only_settles_by_id_and_keeps_the_input(self):
        self.lost_first_write('abort-commit')
        self.edit('SYN typed after', 'SYN R9')
        self.press('History'); self.idle()
        expect(self.status).to_have_text(HISTORY)
        self.assertFalse(self.state()['unknown'], 'the history row carrying this id settles the attempt')
        expect(self.note).to_have_value('SYN typed after')
        self.assertEqual(len(self.api.posts), 1)
        expect(self.page.locator('#tech-note-history-items section')).to_have_count(2)

    def test_T23_history_says_an_unresolved_result(self):
        self.lost_first_write('abort')
        self.press('History'); self.idle()
        expect(self.status).to_have_text(HISTORY + ' 앞선 저장 결과는 아직 확인되지 않았습니다.')

    def test_T23_history_settles_the_latest_save_then_save_is_noop_and_close_silent(self):
        self.lost_first_write('abort-commit')
        self.press('History'); self.idle()
        expect(self.status).to_have_text(HISTORY)
        expect(self.page.locator('#tech-note-meta')).to_contain_text('v2 ·')
        expect(self.note).to_have_value('SYN v2 mine'); expect(self.reason).to_have_value('SYN R1')
        self.assertEqual(self.state(), {'dirty': False, 'busy': False, 'unknown': False})
        self.save(); expect(self.status).to_have_text(unchanged(2))
        self.assertEqual(len(self.api.posts), 1)
        self.press('Close'); expect(self.dialog).not_to_be_visible()
        self.assertEqual(self.dialogs, [])

    def test_T23_history_settles_my_v2_but_keeps_others_v3_as_last_confirmed(self):
        self.lost_first_write('abort-commit')
        self.api.foreign('SYN v3 theirs')
        self.press('History'); self.idle()
        expect(self.page.locator('#tech-note-meta')).to_contain_text('v3 ·')
        expect(self.note).to_have_value('SYN v2 mine'); expect(self.reason).to_have_value('SYN R1')
        self.assertEqual(self.state(), {'dirty': True, 'busy': False, 'unknown': False})
        self.answers.append(False); self.press('Close')
        self.assertEqual(self.dialogs, [CLOSE_Q])
        expect(self.dialog).to_be_visible()
        # Read the facts without replacing the input, then observe both the saved attempt and the conflict.
        self.api.post_modes = [409]; self.reason.fill('SYN R2'); self.save()
        expect(self.status).to_have_text(other_found(3))
        self.reason.fill(''); self.save()
        expect(self.status).to_have_text('앞선 입력은 v2로 저장되었으며 이번 수정의 사유를 입력하세요.')
        self.note.fill('SYN v3 theirs'); self.save()
        expect(self.status).to_have_text(unchanged(3))
        self.assertFalse(self.state()['dirty'])
        self.assertEqual(self.posts_of('baseVersion'), [1, 3])

    def test_T23_older_history_cannot_move_last_confirmed_back(self):
        self.opened_with('SYN v1')
        self.edit('SYN v2 mine', 'SYN R1'); self.save()
        self.api.history_modes = ['missing']  # first page is stale/incomplete: only v1 is returned
        self.press('History'); self.idle()
        expect(self.page.locator('#tech-note-meta')).to_contain_text('v2 ·')
        expect(self.note).to_have_value('SYN v2 mine'); expect(self.reason).to_have_value('SYN R1')
        self.assertFalse(self.state()['dirty'])
        self.save(); expect(self.status).to_have_text(unchanged(2))
        self.assertEqual(len(self.api.posts), 1)

    def test_T24_logout_preparation_stops_writes_keeps_input_and_cancel_only_reads(self):
        self.opened_with('SYN v1')
        self.edit('SYN typed', 'SYN R1')
        peer = self.prepare()
        expect(self.status).to_have_text(PREPARING)
        self.press('Save Note')
        self.page.wait_for_timeout(150)
        self.assertEqual(self.api.posts, [])
        self.resume(peer)
        expect(self.status).to_have_text(DIFFERS)
        expect(self.note).to_have_value('SYN typed'); expect(self.reason).to_have_value('SYN R1')
        self.assertEqual(self.api.posts, [])

    def test_T24_cancel_after_an_interrupted_write_reads_its_result_without_writing(self):
        self.opened_with('SYN v1')
        self.edit('SYN v2', 'SYN R1')
        self.api.post_modes = ['hold']
        self.save(wait=False)
        for _ in range(200):
            if self.api.held:
                break
            self.page.wait_for_timeout(10)
        peer = self.prepare()
        self.finish(0)
        self.page.wait_for_timeout(100)
        self.resume(peer)
        expect(self.status).to_have_text(earlier(2))
        self.assertEqual(len(self.api.posts), 1)
        self.assertEqual(self.state(), {'dirty': False, 'busy': False, 'unknown': False})

    def test_T25_a_real_session_end_closes_the_note_and_nothing_is_sent_after(self):
        self.opened_with('SYN v1')
        self.edit('SYN typed', 'SYN R1')
        self.notice('session-ended')
        expect(self.dialog).not_to_be_visible()
        self.page.wait_for_timeout(150)
        self.assertEqual(self.api.posts, [])
        self.assertEqual(self.state(), {'dirty': False, 'busy': False, 'unknown': False})

    def test_T26_the_published_state_tells_busy_unknown_and_input_apart(self):
        self.opened_with('SYN v1')
        self.assertEqual(self.state(), {'dirty': False, 'busy': False, 'unknown': False})
        self.edit('SYN v2', 'SYN R1')
        self.assertEqual(self.state(), {'dirty': True, 'busy': False, 'unknown': False})
        self.api.post_modes = [500]
        self.save()
        self.assertEqual(self.state(), {'dirty': True, 'busy': False, 'unknown': True})
        self.api.get_modes = ['hold']
        self.press('Reload Note')
        for _ in range(300):
            if 'GET' in self.api.held:
                break
            self.page.wait_for_timeout(10)
        self.assertEqual(self.state(), {'dirty': True, 'busy': True, 'unknown': True})
        self.api.held.pop('GET').fulfill(json=dict(uid=UID, writable=True, note=self.api.latest()))
        self.idle()
        self.assertTrue(self.state()['unknown'])

    def test_T27_late_answers_of_a_closed_dialog_change_nothing_A_B_A(self):
        self.api.commit(dict(baseVersion=0, text='SYN v1', reason='', attemptId=None), sub='other-tech')
        self.api.get_modes = ['hold']
        self.open()
        for _ in range(200):
            if 'GET' in self.api.held:
                break
            self.page.wait_for_timeout(10)
        stale = self.api.held.pop('GET')
        self.page.keyboard.press('Escape'); expect(self.dialog).not_to_be_visible()
        self.api.foreign('SYN v2 theirs')
        self.open()
        expect(self.note).to_have_value('SYN v2 theirs')
        stale.fulfill(json=dict(uid=UID, writable=True, note=self.api.view(self.api.notes[0])))
        self.page.wait_for_timeout(150)
        expect(self.note).to_have_value('SYN v2 theirs'); expect(self.status).to_have_text(opened(2))
        # A write answered after its dialog closed (and another opened) does not speak in the new one.
        self.edit('SYN v3 mine', 'SYN R1')
        self.api.post_modes = ['hold']
        self.save(wait=False)
        for _ in range(200):
            if self.api.held:
                break
            self.page.wait_for_timeout(10)
        self.answers.append(True); self.press('Close')
        self.open()
        expect(self.status).to_have_text(opened(2))
        self.finish(0)
        self.page.wait_for_timeout(150)
        expect(self.status).to_have_text(opened(2)); expect(self.note).to_have_value('SYN v2 theirs')

    # ── session notices (the viewer's own gate) ──
    def prepare(self):
        peer = self.context.new_page(); peer.goto(BASE + '/peer')
        peer.evaluate('void navigator.locks.request("kin-preparation:P1",()=>new Promise(r=>window.release=r));window.channel=new BroadcastChannel("kin-session")')
        peer.wait_for_function('!!window.release')
        peer.evaluate('channel.postMessage({type:"session-preparing",session:"S1",preparation:"P1"})')
        self.page.wait_for_function('KinWorkContext.state()==="preparing"')
        return peer

    def resume(self, peer):
        peer.evaluate('channel.postMessage({type:"session-resumed",session:"S1",preparation:"P1"});release()')
        self.page.wait_for_function('KinWorkContext.state()==="active"')
        self.idle()

    def notice(self, kind):
        self.page.evaluate('kind=>{const c=new BroadcastChannel("kin-session");c.postMessage({type:kind,session:"S1",operation:1,status:"ending"});c.close();}', kind)
        self.page.wait_for_function('KinWorkContext.state()!=="active"')

    def setUp_again(self):
        self.context.close()
        self.setUp()


class ModuleNoteTest(Vectors, Harness, unittest.TestCase):
    """The shared module as the Worklist page drives it: its api ends an answered failure with `status`, a request that
    never left with `sent:false`, and an unreadable success with `incomplete`."""
    STATE = 'note.workspaceState()'

    def mount(self):
        self.page.add_script_tag(path=str(source('tech-note.js')))
        self.page.evaluate('''() => {
          window.moduleUnsent=0;
          const api=async(method,path,body)=>{
            if(moduleUnsent){moduleUnsent--;throw Object.assign(new Error('SYN not sent'),{sent:false});}
            let r;
            try{r=await fetch('/api'+path,{method,cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});}
            catch(e){throw Object.assign(new Error('SYN network'),{sent:true});}
            let value=null;try{value=await r.json();}catch(_){}
            if(!r.ok)throw Object.assign(new Error(value?.message??'HTTP '+r.status),{status:r.status,body:value});
            if(!value)throw Object.assign(new Error('SYN unreadable'),{status:r.status,incomplete:true});
            return value;
          };
          window.note=KinTechNote({allowed:()=>KinWorkContext.state()==='active',api});
        }''')

    def open(self):
        self.page.evaluate('note.open({uid:"1.2.3"})')

    def prevent_resend(self):
        self.page.evaluate('''() => { const fetchBefore = window.fetch; window.fetch = async (url, init) => {
            const response = await fetchBefore(url, init);
            if (String(url).endsWith('/tech-note') && init.method === 'GET') {
                window.fetch = fetchBefore; window.moduleUnsent = 1;
            }
            return response;
        }; }''')

    def test_module_a_request_that_never_left_is_not_saved(self):
        self.opened_with('SYN v1')
        self.edit('SYN v2', 'SYN R1')
        self.page.evaluate('moduleUnsent=1')
        self.save()
        expect(self.status).to_have_text(UNSENT)
        self.assertEqual(self.api.posts, [])
        self.assertEqual(self.state(), {'dirty': True, 'busy': False, 'unknown': False})


class WrapperNoteTest(Vectors, Harness, unittest.TestCase):
    """The viewer window's Tech Note: viewer-tech-note.js checks the account before and after each request."""
    STATE = 'kinViewerTechNoteWorkspaceState()'

    def mount(self):
        self.page.add_script_tag(path=str(ROOT / 'config/ohif.js'))
        for name in ('workspace-shortcuts.js', 'tech-note.js', 'viewer-tech-note.js'):
            self.page.add_script_tag(path=str(source(name)))
        self.page.evaluate('''() => {
          const image='/studies/1.2.3/series/1.2.4/instances/1.2.5/frames/1';
          const view={id:'v',type:'stack',element:document.getElementById('image'),getCurrentImageId:()=>image};
          const row={displaySetInstanceUIDs:['ds']};
          const ds={StudyInstanceUID:'1.2.3',SeriesInstanceUID:'1.2.4',PatientID:'SYN'};
          window.services={viewportGridService:{getState:()=>({activeViewportId:'v',viewports:new Map([['v',row]])})},
            cornerstoneViewportService:{getCornerstoneViewport:()=>view},displaySetService:{getDisplaySetByUID:()=>ds}};
          window.cornerstone={Enums:{Events:{STACK_NEW_IMAGE:'STACK_NEW_IMAGE'}},metaData:{get:()=>undefined}};
          window.noteBridge=kinViewerTechNote(services,kinViewerSession.writeModule);
          noteBridge.mount();
        }''')
        expect(self.page.get_by_role('button', name='Tech Note', exact=True)).to_be_enabled()

    def open(self):
        self.page.get_by_role('button', name='Tech Note', exact=True).click()

    def prevent_resend(self):
        self.me_answers = [None, None, 409]  # the result GET passes; the resend's leading /me refuses

    # The wrapper's own pairs: the answer of the POST is the write's answer, never the account check's.
    def test_wrapper_post_2xx_then_a_failing_account_check_keeps_the_receipt(self):
        for trailing in (409, 'network'):
            with self.subTest(trailing=trailing):
                if trailing != 409:
                    self.setUp_again()
                self.opened_with('SYN v1')
                self.edit('SYN v2', 'SYN R1')
                self.me_answers = [None, trailing]
                self.save()
                expect(self.status).to_have_text(saved(2))
                self.assertEqual(self.api.calls[-2:], ['POST', 'me'])
                self.assertFalse(self.state()['unknown'])

    def test_wrapper_a_failing_account_check_before_the_post_sends_nothing(self):
        self.opened_with('SYN v1')
        self.edit('SYN v2', 'SYN R1')
        self.me_answers = [409]
        self.save()
        expect(self.status).to_have_text(UNSENT)
        self.assertEqual(self.api.posts, [])
        self.assertEqual(self.state(), {'dirty': True, 'busy': False, 'unknown': False})

    def test_wrapper_another_account_after_the_post_ends_the_window_without_painting_the_receipt(self):
        self.opened_with('SYN v1')
        self.edit('SYN v2', 'SYN R1')
        self.me_answers = [None, 'account']
        self.save(wait=False)
        expect(self.dialog).to_have_count(0)
        expect(self.page.get_by_role('button', name='Tech Note', exact=True)).to_be_disabled()
        self.assertEqual(len(self.api.notes), 2)
        self.assertNotIn('저장되었습니다', self.page.locator('body').inner_text())
        self.assertEqual({'dirty': False, 'busy': False, 'unknown': False}, self.state())

    def test_wrapper_the_resend_stops_at_an_account_change(self):
        self.lost_first_write('abort')
        self.me_answers = [None, None, 'account']   # the re-check's GET passes; the resend's leading check sees B
        self.save(wait=False)
        expect(self.dialog).to_have_count(0)
        self.assertEqual(len(self.api.posts), 1)

    def test_wrapper_requests_carry_the_window_owner(self):
        self.opened_with('SYN v1')
        self.edit('SYN v2', 'SYN R1'); self.save()
        expect(self.status).to_have_text(saved(2))
        self.assertEqual([{k: h[k] for k in ('x-kin-subject', 'x-kin-institution', 'x-kin-session')} for h in self.api.headers],
                         [{'x-kin-subject': 'tech', 'x-kin-institution': 'hospital', 'x-kin-session': 'S1'}])


if __name__ == '__main__':
    unittest.main(verbosity=2)
