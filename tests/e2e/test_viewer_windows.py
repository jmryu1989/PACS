# coding: utf-8
"""REQ-D-WORKSPACE-WINDOWS / RISK-D-WORKSPACE-UNSAVED/ACCESS/WINDOW-LOST / TEST-VIEWER-WINDOWS."""
import json
import sys
import unittest
from playwright.sync_api import expect
from test_viewer_opening import ViewerOpeningE2E
from test_prior_selection import canvas_ready


class ViewerWindowsE2E(ViewerOpeningE2E):
    def limit(self, p, count):
        self.settings(p, 'window', False)
        p.locator('#image-opening-limit').select_option(str(count))
        self.close_settings(p)

    def separate(self, p, fixture):
        self.choose(p, fixture)
        with p.context.expect_page() as opened:
            p.locator('#m-filmbox').click()
        popup = opened.value
        popup.wait_for_url('**/ohif/viewer?**')
        canvas_ready(popup, 1)
        popup.wait_for_function("() => typeof kinViewerWindowOwner==='function' && kinViewerWindowOwner() && typeof kinViewerJobWorkspaceState==='function' && !kinViewerJobWorkspaceState().busy")
        self.assertEqual(self.ids(popup), [fixture.uid])
        return popup

    def manager(self, p):
        p.locator('#viewer-windows-open').click()
        expect(p.locator('#viewer-windows-dialog')).to_be_visible()

    def control(self, p, index, action):
        return p.locator(f'[data-window-index="{index}"][data-window-action="{action}"]')

    def test_windows_01_limit_dirty_close_focus_and_slot_reuse(self):
        a, b = self.pair()
        c = self.ct(a.patient_id, 'older', '20260601')
        originals = self.originals()
        p = self.sign_in(self.device())
        self.limit(p, 2)
        first = self.separate(p, a)
        first.evaluate("window.__windowMarker='first'")
        first.get_by_role('button', name='Comparison', exact=True).click()
        first.get_by_label('Job Title', exact=True).fill('KEEP UNSAVED WINDOW')
        second = self.separate(p, b)
        second.evaluate("window.__windowMarker='second'")
        self.choose(p, c)
        p.locator('#m-filmbox').click()
        expect(p.locator('#viewer-windows-dialog')).to_be_visible()
        expect(p.locator('.viewer-window-row')).to_have_count(2)
        self.assertEqual(len(p.context.pages), 3)
        expect(p.locator('#viewer-windows-list')).to_contain_text(a.uid)
        expect(p.locator('#viewer-windows-list')).to_contain_text(b.uid)
        self.control(p, 0, 'close').click()
        expect(p.locator('#viewer-windows-status')).to_contain_text('창을 닫지 않았습니다')
        self.assertFalse(first.is_closed())
        self.control(p, 0, 'focus').click()
        expect(p.locator('#viewer-windows-dialog')).not_to_be_visible()
        expect(first.get_by_label('Job Title', exact=True)).to_have_value('KEEP UNSAVED WINDOW')
        self.assertEqual(first.evaluate('window.__windowMarker'), 'first')
        first.get_by_label('Job Title', exact=True).fill('')
        first.wait_for_function('() => !kinViewerJobWorkspaceState().dirty')
        self.manager(p)
        self.control(p, 0, 'close').click()
        expect(p.locator('.viewer-window-row')).to_have_count(1)
        self.assertTrue(first.is_closed())
        p.locator('#viewer-windows-done').click()
        third = self.separate(p, c)
        self.assertEqual(second.evaluate('window.__windowMarker'), 'second')
        self.limit(p, 1)
        self.manager(p)
        expect(p.locator('.viewer-window-row')).to_have_count(2)
        self.capture(p, 'windows-limit')
        p.locator('#viewer-windows-done').click()
        self.choose(p, a)
        p.locator('#m-filmbox').click()
        expect(p.locator('#viewer-windows-dialog')).to_be_visible()
        self.assertEqual(self.ids(third), [c.uid])
        self.assertEqual(self.ids(second), [b.uid])
        self.assertEqual(self.originals(), originals)
        self.assertEqual(self.jobs(a), [])

    def test_windows_02_reload_rediscovers_without_scope_storage(self):
        a, b = self.pair()
        p = self.sign_in(self.device())
        self.limit(p, 2)
        first = self.separate(p, a)
        second = self.separate(p, b)
        first.evaluate("window.__windowMarker='reload-kept'")
        record = p.evaluate("Object.entries(sessionStorage).find(([key])=>key.startsWith('kin-viewer-windows:'))")
        saved = json.loads(record[1])
        self.assertEqual(set(saved), {'version', 'id', 'slots'})
        self.assertEqual(saved['slots'], [True, True, False, False])
        self.assertNotIn(a.uid, record[1])
        p.reload()
        expect(p.locator('#dbstat')).to_contain_text('DB Connected')
        self.manager(p)
        expect(p.locator('#viewer-windows-list')).to_contain_text(a.uid, timeout=15000)
        expect(p.locator('#viewer-windows-list')).to_contain_text(b.uid, timeout=15000)
        self.control(p, 0, 'focus').click()
        self.assertEqual(first.evaluate('window.__windowMarker'), 'reload-kept')
        self.assertEqual(len(p.context.pages), 3)
        self.manager(p)
        self.control(p, 1, 'close').click()
        expect(p.locator('.viewer-window-row')).to_have_count(1)
        self.assertTrue(second.is_closed())
        self.assertFalse(first.is_closed())

    def test_windows_04_corrupt_registry_retains_existing_document(self):
        a, b = self.pair()
        p = self.sign_in(self.device())
        self.limit(p, 2)
        first = self.separate(p, a)
        first.evaluate("window.__windowMarker='corrupt-kept'")
        p.evaluate("() => { const key=Object.keys(sessionStorage).find(key=>key.startsWith('kin-viewer-windows:')); sessionStorage.setItem(key,'{'); }")
        p.reload()
        expect(p.locator('#dbstat')).to_contain_text('DB Connected')
        self.choose(p, b)
        p.locator('#m-filmbox').click()
        expect(p.locator('#toast')).to_contain_text('영상 창 연결 저장소를 확인하지 못했습니다')
        self.assertEqual(len(p.context.pages), 2)
        self.assertEqual(first.evaluate('window.__windowMarker'), 'corrupt-kept')
        self.assertEqual(self.ids(first), [a.uid])

    def test_windows_05_open_note_prevents_close_and_retarget(self):
        a, b = self.pair()
        p = self.sign_in(self.device(), 'tech')
        self.limit(p, 1)
        first = self.separate(p, a)
        first.get_by_role('button', name='Comparison', exact=True).click()
        first.locator('#kin-viewer-note-open').click()
        expect(first.locator('#tech-note-text')).to_be_editable()
        first.locator('#tech-note-text').fill('KEEP UNSAVED TECH NOTE')
        self.manager(p)
        self.control(p, 0, 'close').click()
        expect(p.locator('#viewer-windows-status')).to_contain_text('창을 닫지 않았습니다')
        self.assertFalse(first.is_closed())
        expect(first.locator('#tech-note-text')).to_have_value('KEEP UNSAVED TECH NOTE')
        p.locator('#viewer-windows-done').click()
        self.choose(p, b)
        p.locator('#m-filmbox').click()
        expect(p.locator('#toast')).to_contain_text('저장·복원 또는 상태 확인')
        self.assertEqual(self.ids(first), [a.uid])
        expect(first.locator('#tech-note-text')).to_have_value('KEEP UNSAVED TECH NOTE')

    def test_windows_03_popup_denial_unverified_owner_and_session_end(self):
        a, b = self.pair()
        p = self.sign_in(self.device())
        self.limit(p, 1)
        self.choose(p, a)
        p.evaluate('window.__realOpen=window.open; window.open=()=>null')
        p.locator('#m-filmbox').click()
        expect(p.locator('#toast')).to_contain_text('팝업이 차단되었습니다')
        self.assertEqual(p.evaluate('viewerWindows.rows().length'), 0)
        self.assertEqual(len(p.context.pages), 1)
        p.evaluate('window.open=window.__realOpen')
        first = self.separate(p, a)
        first.evaluate("window.__realOwner=kinViewerWindowOwner; window.kinViewerWindowOwner=()=> '[\"other\",\"owner\"]'; window.__windowMarker='unverified-kept'")
        self.choose(p, b)
        p.locator('#m-filmbox').click()
        expect(p.locator('#toast')).to_contain_text('보호 상태를 확인할 수 없습니다')
        self.manager(p)
        self.control(p, 0, 'close').click()
        expect(p.locator('#viewer-windows-status')).to_contain_text('창을 닫지 않았습니다')
        self.assertEqual(self.ids(first), [a.uid])
        self.assertEqual(first.evaluate('window.__windowMarker'), 'unverified-kept')
        first.evaluate("window.kinViewerWindowOwner=window.__realOwner; const c=new BroadcastChannel('kin-session'); c.postMessage({type:'session-ended'}); c.close()")
        expect(p.locator('#viewer-windows-dialog')).not_to_be_visible()
        expect(p.locator('#viewer-windows-open')).to_be_disabled()


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ViewerWindowsE2E(name) for name in ViewerWindowsE2E.__dict__ if name.startswith('test_windows_'))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(verbosity=2)
