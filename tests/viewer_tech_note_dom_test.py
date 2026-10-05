# coding: utf-8
"""REQ-S8-CTX -> RISK-CTX-WORK/SESSION -> CTX-NOTE-WRAPPER (R2-F01).

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
        self.leading = self.trailing = None
        self.post_status = 200
        self.page = self.context.new_page()
        self.errors, self.dialogs = [], []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.on('dialog', lambda d: (self.dialogs.append(d.message), d.accept()))
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
            failure = self.trailing if self.posts else self.leading
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
                if self.post_status != 200:
                    return route.fulfill(status=self.post_status, json={'message': 'SYN write refused'})
                if body['baseVersion'] != len(self.notes):
                    return route.fulfill(status=409, json={'message': 'SYN version conflict'})
                self.notes.append(dict(studyUid='1.2.3', version=len(self.notes)+1, text=body['text'], reason=body['reason'].strip(), author='tech', createdAt='2026-10-05T00:00:00Z'))
            return route.fulfill(json=dict(uid='1.2.3', writable=True, note=self.notes[-1] if self.notes else None))
        route.fulfill(body='<div id="root"><div id="image"></div><section id="kin-viewer-layout"></section></div>', content_type='text/html')

    def save(self):
        self.page.get_by_role('button', name='Save Note', exact=True).click()

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
