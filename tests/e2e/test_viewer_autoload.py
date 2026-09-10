# coding: utf-8
"""REQ-D-WORKSPACE-AUTOLOAD / RISK-D-WORKSPACE-IDENTITY/UNSAVED/STALE / TEST-VIEWER-AUTOLOAD."""
import sys
import unittest
from playwright.sync_api import expect
from test_viewer_windows import ViewerWindowsE2E
from test_prior_selection import canvas_ready


class ViewerAutoloadE2E(ViewerWindowsE2E):
    def automatic(self, p, enabled, target='window'):
        self.settings(p, target, False)
        p.locator('#image-opening-autoload').set_checked(enabled)
        self.close_settings(p)

    def test_autoload_06_double_click_during_pending_document_opens_once(self):
        a, b = self.pair()
        p = self.sign_in(self.device())
        self.limit(p, 2)
        self.choose(p, a)
        self.automatic(p, True)
        held = []
        p.context.route('**/ohif/viewer?**', lambda route: held.append(route))
        try:
            with p.context.expect_page() as opened:
                p.locator(f'#rows tr[data-uid="{b.uid}"]').dblclick()
            expect(p.locator('#viewer-windows-open')).to_contain_text('1/2')
            self.assertEqual(len(p.context.pages), 2)
            self.assertEqual(p.evaluate('viewerWindows.rows().length'), 1)
            self.assertEqual(len(held), 1)
        finally:
            for route in held:
                route.continue_()
            p.context.unroute('**/ohif/viewer?**')
        popup = opened.value
        canvas_ready(popup, 1)
        self.assertEqual(self.ids(popup), [b.uid])
        popup.evaluate("window.__autoMarker='double-click-kept'")
        p.locator(f'#rows tr[data-uid="{b.uid}"]').dblclick()
        self.assertEqual(popup.evaluate('window.__autoMarker'), 'double-click-kept')
        self.assertEqual(len(p.context.pages), 2)

    def test_autoload_07_reuse_prefers_another_clean_window(self):
        a, b = self.pair()
        c = self.ct('AUTO-OTHER-CLEAN', 'other', '20260901')
        p = self.sign_in(self.device())
        self.limit(p, 2)
        first = self.separate(p, a)
        second = self.separate(p, b)
        first.evaluate("window.__autoMarker='focused-kept'")
        p.wait_for_function('() => viewerWindows.rows().every(r=>r.status?.ready&&!r.status.busy)')
        self.manager(p)
        self.control(p, 0, 'focus').click()
        self.settings(p, 'window', False)
        p.locator('#image-opening-reuse').check()
        self.close_settings(p)
        self.choose(p, c)
        p.locator('#m-filmbox').click()
        second.wait_for_url('**StudyInstanceUIDs=' + c.uid + '**')
        canvas_ready(second, 1)
        self.assertEqual(self.ids(second), [c.uid])
        self.assertEqual(self.ids(first), [a.uid])
        self.assertEqual(first.evaluate('window.__autoMarker'), 'focused-kept')
        self.assertEqual(len(p.context.pages), 3)

    def test_autoload_01_selection_cap_and_existing_window_navigation(self):
        a, b = self.pair()
        p = self.sign_in(self.device())
        self.limit(p, 2)
        self.choose(p, a)
        self.assertEqual(len(p.context.pages), 1)
        self.automatic(p, True)
        self.assertEqual(len(p.context.pages), 1)
        with p.context.expect_page() as opened:
            self.choose(p, b)
        first = opened.value
        canvas_ready(first, 1)
        self.assertEqual(self.ids(first), [b.uid])
        first.get_by_role('button', name='Comparison', exact=True).click()
        first.get_by_label('Job Title', exact=True).fill('KEEP AUTOMATIC WINDOW')
        first.evaluate("window.__autoMarker='first'")
        with p.context.expect_page() as opened:
            self.choose(p, a)
        second = opened.value
        canvas_ready(second, 1)
        self.assertEqual(self.ids(second), [a.uid])
        self.manager(p)
        p.locator('#viewer-windows-prev').click()
        expect(p.locator('#viewer-windows-dialog')).not_to_be_visible()
        self.assertEqual(p.evaluate('selectedUid'), a.uid)
        expect(first.get_by_label('Job Title', exact=True)).to_have_value('KEEP AUTOMATIC WINDOW')
        self.assertEqual(first.evaluate('window.__autoMarker'), 'first')
        self.manager(p)
        p.locator('#viewer-windows-next').click()
        self.assertEqual(p.evaluate('selectedUid'), a.uid)
        self.assertEqual(self.ids(second), [a.uid])
        self.assertEqual(len(p.context.pages), 3)
        self.automatic(p, False)
        self.choose(p, b)
        self.assertEqual(len(p.context.pages), 3)
        self.assertEqual(first.evaluate('window.__autoMarker'), 'first')

    def test_autoload_02_integrated_selection_keeps_dirty_work(self):
        a, b = self.pair()
        p = self.sign_in(self.device())
        self.choose(p, b)
        self.automatic(p, True, 'workspace')
        self.assertEqual(p.locator('#reading-frame').count(), 0)
        self.choose(p, a)
        frame = self.ready(p, 1)
        p.locator('#findings').fill('KEEP AUTOMATIC REPORT')
        frame.get_by_role('button', name='Comparison', exact=True).click()
        frame.get_by_label('Job Title', exact=True).fill('KEEP AUTOMATIC JOB')
        self.choose(p, b)
        expect(p.locator('#reading-status')).to_contain_text('저장하지 않은 작업')
        expect(frame.get_by_label('Job Title', exact=True)).to_have_value('KEEP AUTOMATIC JOB')
        self.choose(p, a)
        expect(p.locator('#findings')).to_have_value('KEEP AUTOMATIC REPORT')
        self.assertEqual(self.ids(frame), [a.uid])

    def test_autoload_03_reload_owner_and_dirty_reuse(self):
        a, b = self.pair()
        context = self.device()
        p = self.sign_in(context)
        self.choose(p, a)
        self.automatic(p, True)
        p.reload()
        expect(p.locator('#dbstat')).to_contain_text('DB Connected')
        self.assertTrue(self.choice(p)['autoLoad'])
        self.assertEqual(len(context.pages), 1)
        with context.expect_page() as opened:
            self.choose(p, b)
        first = opened.value
        canvas_ready(first, 1)
        first.get_by_role('button', name='Comparison', exact=True).click()
        first.get_by_label('Job Title', exact=True).fill('KEEP AUTOMATIC REUSE')
        first.evaluate("window.__autoMarker='kept'")
        self.choose(p, a)
        expect(p.locator('#toast')).to_contain_text('저장하지 않은 표식이나 작업')
        self.assertEqual(self.ids(first), [b.uid])
        self.assertEqual(p.evaluate('selectedUid'), a.uid)
        self.choose(p, b)
        self.assertEqual(first.evaluate('window.__autoMarker'), 'kept')
        expect(first.get_by_label('Job Title', exact=True)).to_have_value('KEEP AUTOMATIC REUSE')
        first.get_by_label('Job Title', exact=True).fill('')
        first.close()
        self.sign_out(p)
        other = self.sign_in(context, 'doctor2')
        self.assertFalse(self.choice(other)['autoLoad'])
        self.sign_out(other)
        original = self.sign_in(context)
        self.assertTrue(self.choice(original)['autoLoad'])
        self.assertEqual(len(context.pages), 1)

    def test_autoload_04_context_selection_and_popup_denial(self):
        a, b = self.pair()
        p = self.sign_in(self.device())
        self.choose(p, a)
        self.automatic(p, True)
        p.locator(f'#rows tr[data-uid="{b.uid}"]').click(button='right')
        self.assertEqual(p.evaluate('selectedUid'), b.uid)
        self.assertEqual(len(p.context.pages), 1)
        p.keyboard.press('Escape')
        p.evaluate('window.__realOpen=window.open; window.open=()=>null')
        self.choose(p, a)
        expect(p.locator('#toast')).to_contain_text('팝업이 차단되었습니다')
        self.assertEqual(p.evaluate('viewerWindows.rows().length'), 0)
        self.assertEqual(len(p.context.pages), 1)
        p.evaluate('() => { window.open=window.__realOpen; }')
        self.automatic(p, False)
        self.choose(p, b)
        self.assertEqual(len(p.context.pages), 1)

    def test_autoload_05_reuse_only_clean_window_at_exact_limit(self):
        a, b = self.pair()
        c = self.ct('OTHER-AUTO-PATIENT', 'other', '20260901')
        p = self.sign_in(self.device())
        self.limit(p, 2)
        first = self.separate(p, a)
        second = self.separate(p, b)
        first.get_by_role('button', name='Comparison', exact=True).click()
        first.get_by_label('Job Title', exact=True).fill('KEEP FIRST PATIENT')
        first.evaluate("window.__autoMarker='original'")
        self.settings(p, 'window', False)
        p.locator('#image-opening-reuse').check()
        self.close_settings(p)
        self.assertEqual(self.ids(second), [b.uid])
        self.choose(p, c)
        p.locator('#m-filmbox').click()
        second.wait_for_url('**StudyInstanceUIDs=' + c.uid + '**')
        canvas_ready(second, 1)
        self.assertEqual(self.ids(second), [c.uid])
        self.assertEqual(first.evaluate('window.__autoMarker'), 'original')
        self.assertEqual(self.ids(first), [a.uid])
        self.assertEqual(len(p.context.pages), 3)
        comparison = second.get_by_role('button', name='Comparison', exact=True)
        if comparison.get_attribute('aria-expanded') != 'true':
            comparison.click()
        second.get_by_label('Job Title', exact=True).fill('KEEP SECOND PATIENT')
        self.choose(p, b)
        p.locator('#m-filmbox').click()
        expect(p.locator('#viewer-windows-dialog')).to_be_visible()
        self.assertEqual(self.ids(second), [c.uid])
        p.locator('#viewer-windows-done').click()
        self.limit(p, 1)
        p.locator('#m-filmbox').click()
        expect(p.locator('#viewer-windows-dialog')).to_be_visible()
        self.assertEqual(len(p.context.pages), 3)
        self.assertEqual(self.ids(first), [a.uid])
        self.assertEqual(self.ids(second), [c.uid])


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ViewerAutoloadE2E(name) for name in ViewerAutoloadE2E.__dict__ if name.startswith('test_autoload_'))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(verbosity=2)
