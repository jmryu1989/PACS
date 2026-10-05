# coding: utf-8
"""REQ-S8-CTX -> RISK-CTX-WORK/SESSION -> CTX-NOTE-WRAPPER (R2-F01, R3-F01).

Real viewer-tech-note, note dialog, account verdict, page boundary and transport.
Only renderer services and HTTP replies are synthetic; no stack or patient data.
"""
import os
from pathlib import Path
import unittest
from playwright.sync_api import sync_playwright, expect

try:
    from viewer_session_fixture import install_viewer_session
except ImportError:
    from tests.viewer_session_fixture import install_viewer_session

ROOT = Path(__file__).resolve().parents[1]
HP = ROOT / 'worklist-v0/hpacs-lite'
BASE = 'https://viewer-note.test'
ME = dict(kind='member', sub='tech', institution='hospital', sessionId='S1', roles=['technician'])


class ViewerTechNoteDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.context = self.browser.new_context()
        self.context.route(BASE + '/**', self.route)
        self.notes, self.posts, self.calls = [], [], []
        self.me_answers, self.post_modes, self.post_headers, self.held = [], [], [], {}
        self.leading = self.trailing = None
        self.post_status = 200
        self.page = self.context.new_page()
        self.errors, self.dialogs = [], []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.accept_dialogs = True
        self.page.on('dialog', lambda d: (self.dialogs.append(d.message), d.accept() if self.accept_dialogs else d.dismiss()))
        self.page.goto(BASE + '/ohif/viewer?StudyInstanceUIDs=1.2.3')
        self.unbound = install_viewer_session(self.page)
        self.page.add_script_tag(path=str(ROOT / 'config/ohif.js'))
        for name in ('workspace-shortcuts.js', 'tech-note.js', 'viewer-tech-note.js'):
            source = Path(os.environ.get('KIN_CTX_' + name.replace('-', '_').replace('.', '_').upper(), HP / name))
            self.page.add_script_tag(path=str(source))
        self.page.evaluate('''() => {
          const image='/studies/1.2.3/series/1.2.4/instances/1.2.5/frames/1';
          const view={id:'v',type:'stack',element:document.getElementById('image'),getCurrentImageId:()=>image};
          const row={displaySetInstanceUIDs:['ds']};
          const ds={StudyInstanceUID:'1.2.3',SeriesInstanceUID:'1.2.4',PatientID:'SYN'};
          window.services={viewportGridService:{getState:()=>({activeViewportId:'v',viewports:new Map([['v',row]])})},
            cornerstoneViewportService:{getCornerstoneViewport:()=>view},displaySetService:{getDisplaySetByUID:()=>ds}};
          window.cornerstone={Enums:{Events:{STACK_NEW_IMAGE:'STACK_NEW_IMAGE'}},metaData:{get:()=>undefined}};
          const createNote=KinTechNote;
          window.noteErrors=[];
          window.KinTechNote=app=>createNote({...app,api:async(...args)=>{
            try{return await app.api(...args);}
            catch(error){noteErrors.push({method:args[0],status:error.status??null});throw error;}
          }});
          window.noteBridge=kinViewerTechNote(services,kinViewerSession.writeModule);
          noteBridge.mount();
        }''')
        self.page.get_by_role('button', name='Tech Note', exact=True).click()
        expect(self.page.get_by_label('Note', exact=True)).to_be_editable()
        self.page.get_by_label('Note', exact=True).fill('SYN my note')

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])
        self.assertEqual(self.unbound, [])

    def route(self, route):
        path = route.request.url[len(BASE):].split('?')[0]
        if path == '/api/me':
            self.calls.append('me')
            failure = self.me_answers.pop(0) if self.me_answers else self.trailing if self.posts else self.leading
            if failure == 'account':
                return route.fulfill(json={**ME, 'sub': 'different'})
            if failure == 'network':
                return route.abort()
            if failure:
                return route.fulfill(status=failure, json={'message': 'SYN account busy', 'code': 'AUTH_SESSION_BUSY'})
            return route.fulfill(json=ME)
        if path.endswith('/tech-note'):
            self.calls.append(route.request.method)
            if route.request.method == 'POST':
                body = route.request.post_data_json
                self.posts.append(body)
                self.post_headers.append({k: v for k, v in route.request.headers.items() if k.startswith('x-kin')})
                if self.post_status != 200:
                    return route.fulfill(status=self.post_status, json={'message': 'SYN write refused'})
                mode = self.post_modes.pop(0) if self.post_modes else 'ok'
                if mode == 'hold':
                    self.held[len(self.posts)-1] = route
                    self.page.evaluate('window.heldNoteReady=true')
                    return
                if mode == 'abort':
                    return route.abort()
                code = self.commit_note(body)
                if mode == 'abort-commit':
                    return route.abort()
                if code != 200:
                    return route.fulfill(status=code, json={'message': 'SYN write refused'})
            return route.fulfill(json=dict(uid='1.2.3', writable=True, note=self.notes[-1] if self.notes else None))
        route.fulfill(body='<div id="root"><div id="image"></div><section id="kin-viewer-layout"></section></div>', content_type='text/html')

    def save(self):
        self.page.get_by_role('button', name='Save Note', exact=True).click()

    def commit_note(self, body):
        """Atomic CAS and validation from the Tech Note API contract, no timing."""
        if body['baseVersion'] != len(self.notes):
            return 409
        if self.notes and (not body['reason'].strip() or self.notes[-1]['text'] == body['text']):
            return 400
        if not self.notes and not body['text'].strip():
            return 400
        self.notes.append(dict(studyUid='1.2.3', version=len(self.notes)+1, text=body['text'],
                               reason=body['reason'].strip(), author='tech', createdAt='2026-10-05T00:00:00Z'))
        return 200

    def finish_held(self, index):
        route = self.held.pop(index)
        code = self.commit_note(self.posts[index])
        route.fulfill(status=code, json=dict(uid='1.2.3', writable=True, note=self.notes[-1]) if code == 200 else {'message': 'SYN write refused'})

    def unknown_first(self, committed=False):
        self.post_modes = ['abort-commit' if committed else 'abort']
        self.save()
        expect(self.page.locator('#tech-note-status')).to_contain_text('저장 결과를 알 수 없습니다')
        self.page.wait_for_function('!kinViewerTechNoteWorkspaceState().busy')

    def edit_unknown(self, reason='  SYN correction  '):
        self.page.get_by_label('Note', exact=True).fill('SYN corrected dose 120 mAs')
        self.page.get_by_label('Reason for Change').fill(reason)

    def assert_current_saved(self, version):
        expect(self.page.locator('#tech-note-status')).to_have_text('저장되었습니다. v' + str(version))
        expect(self.page.get_by_label('Note', exact=True)).to_have_value('SYN corrected dose 120 mAs')
        expect(self.page.get_by_label('Reason for Change')).to_have_value('  SYN correction  ')
        self.assertEqual({'dirty': False, 'busy': False, 'unknown': False}, self.page.evaluate('kinViewerTechNoteWorkspaceState()'))

    def test_ordinary_save_preserves_text_and_reason_clean_one_request(self):
        self.page.get_by_label('Reason for Change').fill('  SYN initial  ')
        self.save()
        expect(self.page.locator('#tech-note-status')).to_have_text('저장되었습니다. v1')
        expect(self.page.get_by_label('Note', exact=True)).to_have_value('SYN my note')
        expect(self.page.get_by_label('Reason for Change')).to_have_value('  SYN initial  ')
        self.assertEqual(len(self.posts), 1)
        self.assertEqual({'dirty': False, 'busy': False, 'unknown': False}, self.page.evaluate('kinViewerTechNoteWorkspaceState()'))
        self.page.keyboard.press('Escape')
        self.assertEqual(self.dialogs, [])

    def test_unknown_old_read_sends_current_text_second_commits_first(self):
        self.unknown_first()
        self.edit_unknown()
        self.save()
        self.assert_current_saved(1)
        self.assertEqual([(b['baseVersion'], b['text']) for b in self.posts], [(0, 'SYN my note'), (0, 'SYN corrected dose 120 mAs')])
        self.assertEqual(self.commit_note(self.posts[0]), 409)
        self.assertEqual([(n['version'], n['text']) for n in self.notes], [(1, 'SYN corrected dose 120 mAs')])
        for headers in self.post_headers:
            self.assertEqual({k: headers[k] for k in ('x-kin-subject', 'x-kin-institution', 'x-kin-session')},
                             {'x-kin-subject': 'tech', 'x-kin-institution': 'hospital', 'x-kin-session': 'S1'})

    def test_unknown_witness_sends_current_text_from_known_version(self):
        self.unknown_first(committed=True)
        self.edit_unknown()
        self.save()
        self.assert_current_saved(2)
        self.assertEqual([b['baseVersion'] for b in self.posts], [0, 1])
        self.assertEqual([n['text'] for n in self.notes], ['SYN my note', 'SYN corrected dose 120 mAs'])

    def test_unknown_witness_same_input_is_clean_without_resend(self):
        self.unknown_first(committed=True)
        self.save()
        expect(self.page.locator('#tech-note-status')).to_have_text('저장되었습니다. v1')
        self.assertEqual(len(self.posts), 1)
        self.assertFalse(self.page.evaluate('kinViewerTechNoteWorkspaceState().dirty'))

    def test_unknown_reload_witness_keeps_edits_and_never_writes(self):
        self.unknown_first(committed=True)
        self.edit_unknown()
        self.page.get_by_role('button', name='Reload Note', exact=True).click()
        expect(self.page.locator('#tech-note-status')).to_contain_text('저장되었습니다. v1 · 이후 입력은 아직 저장되지 않았습니다')
        expect(self.page.get_by_label('Note', exact=True)).to_have_value('SYN corrected dose 120 mAs')
        expect(self.page.get_by_label('Reason for Change')).to_have_value('  SYN correction  ')
        self.assertEqual({'dirty': True, 'busy': False, 'unknown': False}, self.page.evaluate('kinViewerTechNoteWorkspaceState()'))
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(self.dialogs, [])
        self.accept_dialogs = False
        self.page.keyboard.press('Escape')
        expect(self.page.get_by_role('dialog', name='Tech Note', exact=True)).to_be_visible()
        self.assertEqual(len(self.dialogs), 1)

    def test_unknown_old_reload_keeps_current_input_and_never_writes(self):
        self.unknown_first()
        self.edit_unknown()
        self.page.get_by_role('button', name='Reload Note', exact=True).click()
        expect(self.page.locator('#tech-note-status')).to_contain_text('저장 결과는 아직 알 수 없습니다')
        expect(self.page.get_by_label('Note', exact=True)).to_have_value('SYN corrected dose 120 mAs')
        self.assertTrue(self.page.evaluate('kinViewerTechNoteWorkspaceState().unknown'))
        self.assertEqual(len(self.posts), 1)

    def first_commits_during_resend(self, reason='  SYN correction  ', change_account=False):
        self.unknown_first()
        self.edit_unknown(reason)
        self.post_modes = ['hold', 'ok', 'hold']
        self.save()
        self.page.wait_for_function('window.heldNoteReady===true')
        expect(self.page.locator('#tech-note-status')).to_have_text('저장 중…')
        if change_account:
            # A refused POST throws before the trailing check: only the re-check's
            # two identity reads precede the follow-up's leading check.
            self.me_answers = [None, None, 'account']
        with self.page.expect_response(lambda r: r.request.method == 'POST'):
            self.assertEqual(self.commit_note(self.posts[0]), 200)
            self.finish_held(1)

    def test_first_commits_during_resend_current_text_gets_one_followup(self):
        self.first_commits_during_resend()
        self.assert_current_saved(2)
        self.assertEqual([b['baseVersion'] for b in self.posts], [0, 0, 1])
        self.assertEqual([n['text'] for n in self.notes], ['SYN my note', 'SYN corrected dose 120 mAs'])

    def test_followup_refusal_keeps_box_and_stops_after_one_write(self):
        self.first_commits_during_resend(reason='')
        expect(self.page.locator('#tech-note-status')).to_contain_text('저장되지 않았습니다')
        self.page.wait_for_function('!kinViewerTechNoteWorkspaceState().busy', timeout=2000)
        expect(self.page.get_by_label('Note', exact=True)).to_have_value('SYN corrected dose 120 mAs')
        self.assertEqual([b['baseVersion'] for b in self.posts], [0, 0, 1])
        self.assertEqual([n['text'] for n in self.notes], ['SYN my note'])
        self.assertEqual({'dirty': True, 'busy': False, 'unknown': False}, self.page.evaluate('kinViewerTechNoteWorkspaceState()'))

    def test_foreign_version_is_not_saved_and_baseline_comes_from_read(self):
        self.unknown_first()
        self.edit_unknown()
        self.assertEqual(self.commit_note({'baseVersion': 0, 'text': 'SYN other reader', 'reason': 'SYN other reason'}), 200)
        self.save()
        expect(self.page.locator('#tech-note-status')).to_contain_text('저장되지 않았습니다. 다른 메모가 저장되었습니다')
        expect(self.page.get_by_label('Note', exact=True)).to_have_value('SYN corrected dose 120 mAs')
        expect(self.page.get_by_label('Reason for Change')).to_have_value('  SYN correction  ')
        self.assertEqual(len(self.posts), 1)
        self.assertTrue(self.page.evaluate('kinViewerTechNoteWorkspaceState().dirty'))
        # Matching the read server version is clean even though our attempt failed.
        self.page.get_by_label('Note', exact=True).fill('SYN other reader')
        self.page.get_by_label('Reason for Change').fill('SYN other reason')
        self.assertFalse(self.page.evaluate('kinViewerTechNoteWorkspaceState().dirty'))
        self.page.keyboard.press('Escape')
        self.assertEqual(self.dialogs, [])

    def test_reload_differing_box_requires_confirmation(self):
        self.save()
        expect(self.page.locator('#tech-note-status')).to_have_text('저장되었습니다. v1')
        self.edit_unknown()
        self.accept_dialogs = False
        self.page.get_by_role('button', name='Reload Note', exact=True).click()
        expect(self.page.get_by_label('Note', exact=True)).to_have_value('SYN corrected dose 120 mAs')
        self.assertEqual(len(self.dialogs), 1)
        self.accept_dialogs = True
        self.page.get_by_role('button', name='Reload Note', exact=True).click()
        expect(self.page.get_by_label('Note', exact=True)).to_have_value('SYN my note')
        self.assertEqual(len(self.dialogs), 2)
        self.assertEqual(len(self.posts), 1)

    def test_resend_stops_at_account_change_before_leading_check(self):
        self.unknown_first()
        self.edit_unknown()
        self.me_answers = [None, None, 'account']
        self.save()
        expect(self.page.get_by_role('dialog', name='Tech Note', exact=True)).to_have_count(0)
        self.assertEqual(len(self.posts), 1)
        self.assertNotIn('저장되었습니다', self.page.locator('body').inner_text())

    def test_recheck_stops_at_account_change(self):
        self.unknown_first(committed=True)
        self.me_answers = ['account']
        self.save()
        expect(self.page.get_by_role('dialog', name='Tech Note', exact=True)).to_have_count(0)
        self.assertEqual(len(self.posts), 1)

    def test_followup_stops_at_account_change(self):
        self.first_commits_during_resend(change_account=True)
        expect(self.page.get_by_role('dialog', name='Tech Note', exact=True)).to_have_count(0)
        self.assertEqual(len(self.posts), 2)
        self.assertEqual([n['text'] for n in self.notes], ['SYN my note'])
        self.assertNotIn('저장되었습니다', self.page.locator('body').inner_text())

    def test_rejected_unchanged_box_is_clean_from_known_version(self):
        self.page.get_by_label('Note', exact=True).fill('')
        self.post_status = 403
        self.save()
        expect(self.page.locator('#tech-note-status')).to_contain_text('저장되지 않았습니다')
        self.assertEqual({'dirty': False, 'busy': False, 'unknown': False}, self.page.evaluate('kinViewerTechNoteWorkspaceState()'))
        self.page.keyboard.press('Escape')
        self.assertEqual(self.dialogs, [])

    def test_unknown_with_clean_box_still_requires_close_confirmation(self):
        self.unknown_first()
        self.page.get_by_label('Note', exact=True).fill('')
        self.assertEqual({'dirty': False, 'busy': False, 'unknown': True}, self.page.evaluate('kinViewerTechNoteWorkspaceState()'))
        self.accept_dialogs = False
        self.page.keyboard.press('Escape')
        expect(self.page.get_by_role('dialog', name='Tech Note', exact=True)).to_be_visible()
        self.assertEqual(len(self.dialogs), 1)
        self.assertIn('저장 결과를 알 수 없습니다', self.dialogs[0])
        self.assertEqual(len(self.posts), 1)

    def test_typing_and_cancelled_close_never_send_without_save(self):
        self.edit_unknown()
        self.accept_dialogs = False
        self.page.get_by_role('button', name='Close', exact=True).click()
        expect(self.page.get_by_role('dialog', name='Tech Note', exact=True)).to_be_visible()
        expect(self.page.get_by_label('Note', exact=True)).to_have_value('SYN corrected dose 120 mAs')
        self.assertEqual(self.posts, [])
        self.assertEqual(self.notes, [])

    def test_post_200_trailing_me_409_keeps_write_receipt(self):
        self.trailing = 409
        self.save()
        expect(self.page.locator('#tech-note-status')).to_have_text('저장되었습니다. v1')
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(self.calls[-2:], ['POST', 'me'])
        self.assertFalse(self.page.evaluate('kinViewerTechNoteWorkspaceState().unknown'))

    def test_post_200_trailing_network_failure_keeps_write_receipt(self):
        self.trailing = 'network'
        self.save()
        expect(self.page.locator('#tech-note-status')).to_have_text('저장되었습니다. v1')
        self.assertEqual(len(self.notes), 1)

    def test_leading_check_failure_never_sends_write(self):
        self.leading = 409
        self.save()
        expect(self.page.locator('#tech-note-status')).to_contain_text('저장 요청을 보내지 못했습니다')
        self.assertEqual(self.posts, [])
        expect(self.page.get_by_label('Note', exact=True)).to_have_value('SYN my note')
        self.assertFalse(self.page.evaluate('kinViewerTechNoteWorkspaceState().unknown'))
        self.page.keyboard.press('Escape')
        expect(self.page.get_by_role('dialog', name='Tech Note', exact=True)).not_to_be_visible()

    def test_write_403_is_not_unknown_and_close_is_available(self):
        self.post_status = 403
        self.save()
        expect(self.page.locator('#tech-note-status')).to_contain_text('저장되지 않았습니다')
        expect(self.page.get_by_label('Note', exact=True)).to_have_value('SYN my note')
        self.assertFalse(self.page.evaluate('kinViewerTechNoteWorkspaceState().unknown'))
        self.page.keyboard.press('Escape')
        expect(self.page.get_by_role('dialog', name='Tech Note', exact=True)).not_to_be_visible()
        self.assertEqual(len(self.posts), 1)

    def test_post_200_trailing_different_account_ends_note_module(self):
        self.trailing = 'account'
        self.save()
        expect(self.page.get_by_role('dialog', name='Tech Note', exact=True)).to_have_count(0)
        expect(self.page.get_by_role('button', name='Tech Note', exact=True)).to_be_disabled()
        expect(self.page.locator('#kin-viewer-note-status')).to_contain_text('세션이나 영상창이 변경되었습니다')
        expect(self.page.get_by_label('Note', exact=True)).to_have_count(0)
        expect(self.page.locator('#tech-note-meta, #tech-note-status')).to_have_count(0)
        self.assertEqual({'dirty': False, 'busy': False, 'unknown': False},
                         self.page.evaluate('kinViewerTechNoteWorkspaceState()'))
        self.assertEqual([{'method': 'POST', 'status': None}], self.page.evaluate('noteErrors'))
        self.assertEqual(len(self.notes), 1)
        self.assertNotIn('저장되었습니다', self.page.locator('body').inner_text())
        self.assertNotIn('SYN my note', self.page.locator('body').inner_text())


if __name__ == '__main__':
    unittest.main(verbosity=2)
