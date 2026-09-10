# coding: utf-8
"""REQ-D-WORKSPACE-OPENING / RISK-D-WORKSPACE-IDENTITY/UNSAVED/ACCESS / TEST-VIEWER-OPENING."""
import os
from pathlib import Path
import unittest
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect
from test_reading_workspace import ReadingWorkspaceE2E
from test_prior_selection import canvas_ready
from test_workspace_persistence import WorkspacePersistenceE2E


class ViewerOpeningE2E(ReadingWorkspaceE2E):
    device = WorkspacePersistenceE2E.device
    sign_in = WorkspacePersistenceE2E.sign_in
    sign_out = WorkspacePersistenceE2E.sign_out

    def settings(self, page, target, prior):
        page.locator('#image-opening-open').click()
        page.locator('#image-opening-target').select_option(target)
        page.locator('#image-opening-prior').set_checked(prior)
        expect(page.locator('#image-opening-dialog')).to_be_visible()

    def close_settings(self, page):
        page.locator('#image-opening-done').click()
        expect(page.locator('#image-opening-open')).to_be_focused()

    def choice(self, page):
        return page.evaluate('imageOpening.snapshot()')

    def ids(self, frame):
        return parse_qs(urlsplit(frame.url).query)['StudyInstanceUIDs'][0].split(',')

    def ready(self, page, count):
        expect(page.locator('#reading-status')).to_have_text('영상 작업공간 연결됨', timeout=60000)
        frame = page.locator('#reading-frame').element_handle().content_frame()
        canvas_ready(frame, count)
        return frame

    def capture(self, page, name):
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', str(Path(__file__).parent / 'artifacts')))
        folder.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(folder / ('image-opening-' + name + '.png')))

    def test_opening_01_window_workspace_prior_and_retained_work(self):
        a, b = self.pair()
        originals = self.originals()
        versions = {f.uid: self.versions(f) for f in [a, b]}
        p = self.sign_in(self.device())
        self.choose(p, a)
        self.assertEqual(self.choice(p), dict(version=2, listTarget='window', includePrior=True, maxWindows=1))
        with p.context.expect_page() as opened:
            p.locator('#m-filmbox').click()
        popup = opened.value
        popup.wait_for_url('**/ohif/viewer?**')
        canvas_ready(popup, 2)
        self.assertEqual(self.ids(popup), [a.uid, b.uid])
        popup.close()
        self.settings(p, 'workspace', False)
        self.close_settings(p)
        p.locator(f'#rows tr[data-uid="{a.uid}"]').dblclick()
        frame = self.ready(p, 1)
        self.assertEqual(self.ids(frame), [a.uid])
        p.locator('#findings').fill('OPENING PRIVATE DRAFT')
        frame.evaluate('window.__openingDocument = "keep"')
        frame.get_by_role('button', name='Comparison', exact=True).click()
        frame.get_by_label('Job Title', exact=True).fill('OPENING UNSAVED JOB')
        self.settings(p, 'window', True)
        self.capture(p, 'preferences')
        self.close_settings(p)
        self.assertEqual(frame.evaluate('window.__openingDocument'), 'keep')
        self.assertEqual(self.ids(frame), [a.uid])
        # A changed preference cannot bypass the existing dirty-viewer guard.
        p.locator('#m-filmbox').click()
        expect(p.locator('#reading-status')).to_contain_text('저장하지 않은 작업')
        expect(frame.get_by_label('Job Title', exact=True)).to_have_value('OPENING UNSAVED JOB')
        expect(p.locator('#findings')).to_have_value('OPENING PRIVATE DRAFT')
        self.assertEqual(frame.evaluate('window.__openingDocument'), 'keep')
        frame.get_by_label('Job Title', exact=True).fill('')
        frame.wait_for_function('!kinViewerJobWorkspaceState().dirty')
        p.locator('#m-filmbox').click()
        frame = self.ready(p, 2)
        self.assertEqual(self.ids(frame), [a.uid, b.uid])
        expect(p.locator('#findings')).to_have_value('OPENING PRIVATE DRAFT')
        self.settings(p, 'window', False)
        self.close_settings(p)
        # Explicit comparison remains explicit even when automatic prior is off.
        p.locator(f'#relrows tr[data-uid="{b.uid}"]').dblclick()
        self.assertEqual(self.ids(self.ready(p, 2)), [a.uid, b.uid])
        self.choose(p, b)
        self.assertEqual(self.ids(self.ready(p, 1)), [b.uid])
        self.choose(p, a)
        self.assertEqual(self.ids(self.ready(p, 1)), [a.uid])
        expect(p.locator('#findings')).to_have_value('OPENING PRIVATE DRAFT')
        self.assertEqual(self.originals(), originals)
        self.assertEqual({f.uid: self.versions(f) for f in [a, b]}, versions)

    def test_opening_02_owner_relogin_other_browser_and_corruption(self):
        context = self.device()
        a = self.sign_in(context)
        a.set_viewport_size(dict(width=768, height=1024))
        owner = a.evaluate('KinViewerOpening.key(KinAuth.session())')
        self.settings(a, 'workspace', False)
        for selector in ['#image-opening-target', '#image-opening-prior', '#image-opening-reset', '#image-opening-done']:
            expect(a.locator(selector)).to_be_in_viewport()
            a.locator(selector).click(trial=True)
        self.capture(a, 'portrait')
        chosen = self.choice(a)
        self.close_settings(a)
        self.sign_out(a)
        b = self.sign_in(context, 'doctor2')
        self.assertNotEqual(b.evaluate('KinViewerOpening.key(KinAuth.session())'), owner)
        self.assertEqual(self.choice(b), dict(version=2, listTarget='window', includePrior=True, maxWindows=1))
        self.sign_out(b)
        a = self.sign_in(context)
        self.assertEqual(self.choice(a), chosen)
        other = self.sign_in(self.device())
        self.assertEqual(self.choice(other), dict(version=2, listTarget='window', includePrior=True, maxWindows=1))
        a.evaluate('(key)=>localStorage.setItem(key,"{")', owner)
        a.reload()
        expect(a.locator('#dbstat')).to_contain_text('DB Connected')
        a.locator('#image-opening-open').click()
        expect(a.locator('#image-opening-status')).to_contain_text('저장된 설정 오류')
        self.assertEqual(self.choice(a), dict(version=2, listTarget='window', includePrior=True, maxWindows=1))
        a.locator('#image-opening-reset').click()
        expect(a.locator('#image-opening-status')).to_contain_text('설정 저장됨')
        self.close_settings(a)

    def test_opening_03_other_tab_storage_denial_and_session_end(self):
        a, b = self.pair()
        context = self.device()
        p = self.sign_in(context)
        frame = self.workspace(p, a)
        frame.evaluate('window.__openingDocument = "same"')
        p.locator('#findings').fill('KEEP CROSS TAB DRAFT')
        q = context.new_page()
        q.goto(p.url)
        expect(q.locator('#dbstat')).to_contain_text('DB Connected')
        self.settings(q, 'workspace', False)
        self.close_settings(q)
        p.wait_for_function('imageOpening.snapshot().listTarget === "workspace" && !imageOpening.snapshot().includePrior')
        self.assertEqual(frame.evaluate('window.__openingDocument'), 'same')
        self.assertEqual(self.ids(frame), [a.uid, b.uid])
        expect(p.locator('#findings')).to_have_value('KEEP CROSS TAB DRAFT')
        # Storage denial keeps the current window's choice and truthful feedback.
        p.evaluate('''() => {
          const set = Storage.prototype.setItem;
          Storage.prototype.setItem = function(key,value) {
            if (String(key).startsWith(KinViewerOpening.PREFIX)) throw new DOMException('Synthetic denial','QuotaExceededError');
            return set.call(this,key,value);
          };
        }''')
        self.settings(p, 'window', True)
        expect(p.locator('#image-opening-status')).to_contain_text('이 창에서만 유지')
        self.close_settings(p)
        p.locator('#image-opening-open').click()
        expect(p.locator('#image-opening-status')).to_contain_text('이 창에서만 유지')
        self.close_settings(p)
        self.assertEqual(self.choice(q), dict(version=2, listTarget='workspace', includePrior=False, maxWindows=1))
        self.assertEqual(frame.evaluate('window.__openingDocument'), 'same')
        self.assertEqual(self.ids(frame), [a.uid, b.uid])
        p.locator('#image-opening-open').click()
        q.evaluate('''() => { const c=new BroadcastChannel('kin-session'); c.postMessage({type:'session-ended'}); setTimeout(()=>c.close(),0); }''')
        expect(p.locator('#image-opening-dialog')).not_to_be_visible()
        expect(p.locator('#image-opening-open')).to_be_disabled()


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ViewerOpeningE2E(name) for name in loader.getTestCaseNames(ViewerOpeningE2E)
                              if name.startswith('test_opening_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
