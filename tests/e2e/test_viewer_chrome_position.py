# coding: utf-8
"""Toolbar & Thumbnail Position on the shipped viewer with synthetic DICOM.

ViewerChromePositionE2E: a portrait window (1080 x 1920) with the toolbar on the left and the thumbnails on the right;
a CT opens and pages, the choice is in the account and comes back on reopening. ViewerChromeSpanE2E: one viewer window
across two synthetic CDP displays (as test_viewer_ux_span's seam case) with the toolbar at the bottom and the
thumbnails on the left. Synthetic screens are not physical-monitor evidence.
"""
import sys
import unittest
import uuid

from playwright.sync_api import expect

from test_viewer_layout import ViewerLayoutE2E
from test_prior_selection import synthetic_ct, canvas_ready
from document_session import document_request

ACTIVE = "services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId())"
READY = "() => window.kinViewerHistoryWorkspaceState?.()?.busy === false && window.kinViewerJobWorkspaceState?.()?.busy === false"
BOXES = """() => {
  const box = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const strip = document.querySelector('.kin-viewer-series-strip');
  return { column: box(strip?.parentElement), toolbar: box(document.querySelector('.kin-ux-toolbar-slot')), thumbs: box(strip),
    grid: box(document.querySelector('[data-cy="viewport-grid"]')),
    canvas: box(document.querySelector('[data-cy="viewport-grid"] canvas')),
    mirrors: [...document.querySelectorAll('.kin-span-mirror')].map(m => ({ name: m.getAttribute('aria-label'), ...box(m) })) };
}"""


def restore_account(page):
    """The account's Toolbar & Thumbnail Position goes back to none, so later suites of this user see the default."""
    record = document_request(page, 'GET', '/api/workspace-shortcuts').json()
    settings = record.get('viewerSettings')
    if not settings or 'chrome' not in (settings.get('features') or {}):
        return
    features = {k: v for k, v in settings['features'].items() if k != 'chrome'}
    settings = {k: v for k, v in settings.items() if k != 'features'}
    if features:
        settings['features'] = features
    document_request(page, 'PUT', '/api/workspace-shortcuts', headers={'X-KIN-CSRF': '1'},
                     data=dict(expectedOwner=record['owner'], revision=record['revision'], viewerSettings=settings))


def choose(page, toolbar, thumbs, hide_toolbar=False, hide_thumbs=False):
    page.get_by_role('button', name='Viewer Settings', exact=True).click()
    settings = page.get_by_role('dialog', name='Viewer Settings')
    settings.get_by_role('button', name='Toolbar & Thumbnail Position…').click()
    window = page.get_by_role('dialog', name='Toolbar & Thumbnail Position')
    window.get_by_label('Toolbar', exact=True).select_option(toolbar)
    window.get_by_label('Thumbnails', exact=True).select_option(thumbs)
    window.get_by_label('Auto-hide Toolbar').set_checked(hide_toolbar)
    window.get_by_label('Auto-hide Thumbnails').set_checked(hide_thumbs)
    window.get_by_role('button', name='Apply').click()
    expect(window.get_by_role('status')).to_have_text('계정에 저장하고 이 창에 적용했습니다.')
    window.get_by_role('button', name='Close').click()
    settings.get_by_role('button', name='Cancel', exact=True).click()
    expect(settings).to_be_hidden()


class ViewerChromePositionE2E(ViewerLayoutE2E):
    def placed(self, page):
        b = page.evaluate(BOXES)
        column, tool, strip, grid = b['column'], b['toolbar'], b['thumbs'], b['grid']
        self.assertLessEqual(abs(tool['left'] - column['left']), 1, b)
        self.assertLessEqual(abs(tool['height'] - column['height']), 1, b)
        self.assertLessEqual(abs(strip['right'] - column['right']), 1, b)
        self.assertGreaterEqual(grid['left'], tool['right'] - 1, b)
        self.assertLessEqual(grid['right'], strip['left'] + 1, b)
        # The canvas is drawn in the images' place, not under a row.
        self.assertGreaterEqual(b['canvas']['left'], tool['right'] - 1, b)
        self.assertLessEqual(b['canvas']['right'], strip['left'] + 1, b)
        return b

    def test_chrome_01_portrait_toolbar_left_thumbnails_right_ct(self):
        f = synthetic_ct(self.stack, 'CHR-' + uuid.uuid4().hex[:12], 'current', '20260801', slices=20)
        page = self.login()
        self.addCleanup(restore_account, page)
        page.set_viewport_size({'width': 1080, 'height': 1920})
        self.launch(page, [f])
        page.wait_for_function("() => " + ACTIVE + "?.getImageIds?.().length === 20")
        page.wait_for_function(READY)
        page.locator('[data-cy="viewport-grid"]').hover()
        page.mouse.wheel(0, 120)
        page.wait_for_function("() => " + ACTIVE + ".getCurrentImageIdIndex() > 0")
        before = page.evaluate("() => " + ACTIVE + ".getCurrentImageIdIndex()")
        choose(page, 'left', 'right')
        self.placed(page)
        # Moving the rows keeps the image the reader was on; the CT still pages.
        self.assertEqual(before, page.evaluate("() => " + ACTIVE + ".getCurrentImageIdIndex()"))
        grid = page.evaluate(BOXES)['grid']
        page.mouse.move(grid['left'] + grid['width'] / 2, grid['top'] + grid['height'] / 2)
        for _ in range(4):
            page.mouse.wheel(0, 120)
        page.wait_for_function("n => " + ACTIVE + ".getCurrentImageIdIndex() > n", arg=before)
        expect(page.get_by_role('button', name='Next Series')).to_have_text('⌄')
        expect(page.locator('.kin-ux-tools-bar [data-tool=WindowLevel] .kin-ux-tool-label')).to_be_visible()
        # The account keeps the choice: the viewer opened again lays its rows out the same way.
        page.reload()
        canvas_ready(page, 1)
        page.wait_for_function("() => document.body.getAttribute('data-kin-toolbar-side') === 'left'")
        page.wait_for_function("() => " + ACTIVE + "?.getImageIds?.().length === 20")
        self.placed(page)
        for _ in range(3):
            page.mouse.wheel(0, 120)
        page.wait_for_function("() => " + ACTIVE + ".getCurrentImageIdIndex() > 0")
        # And back to the top edge.
        page.wait_for_function(READY)
        choose(page, 'top', 'top')
        self.assertIsNone(page.evaluate("() => document.body.getAttribute('data-kin-chrome')"))
        b = page.evaluate(BOXES)
        self.assertLessEqual(abs(b['toolbar']['top'] - b['column']['top']), 1, b)
        self.assertLessEqual(abs(b['thumbs']['top'] - b['toolbar']['bottom']), 1, b)


if '--portrait' not in sys.argv:
    from test_viewer_ux_span import ViewerSpanSeamEmulatedE2E

    class ViewerChromeSpanE2E(ViewerSpanSeamEmulatedE2E):
        def test_chrome_02_window_across_two_displays_bottom_toolbar_left_thumbnails(self):
            f = synthetic_ct(self.stack, 'CHS-' + uuid.uuid4().hex[:12], 'current', '20260801', slices=10)
            p = self.sign_in(self.device())
            self.grant(p)
            self.addCleanup(restore_account, p)
            record = document_request(p, 'GET', '/api/workspace-shortcuts').json()
            # A new account has no record yet: the toolbar's own fields come with it (the server checks them).
            settings = dict(record.get('viewerSettings') or dict(version=2, bar=['WindowLevel', 'Pan', 'Zoom', 'StackScroll'], shortcuts={}))
            settings['features'] = {**(settings.get('features') or {}), 'chrome': dict(toolbar='bottom', thumbs='left')}
            put = document_request(p, 'PUT', '/api/workspace-shortcuts', headers={'X-KIN-CSRF': '1'},
                                   data=dict(expectedOwner=record['owner'], revision=record['revision'], viewerSettings=settings))
            self.assertEqual(put.status, 200, put.text())
            group = str(uuid.uuid4())
            url = self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + f.uid + '#kin-window-group=' + group + '&kin-window-slot=0'
            viewer = self.viewer(p, url, 'chrome-span-0')
            canvas_ready(viewer, 1)
            left, right = self.displays
            self.bounds(viewer, dict(left=left['left'], top=0, width=3840, height=1080))
            self.until(viewer, "() => document.body.getAttribute('data-kin-toolbar-side') === 'bottom' && !!document.querySelector('.kin-ux-toolbar .kin-span-mirror')")
            b = viewer.evaluate(BOXES)
            column, tool, strip = b['column'], b['toolbar'], b['thumbs']
            self.assertLessEqual(abs(tool['bottom'] - column['bottom']), 1, b)
            self.assertLessEqual(abs(strip['left'] - column['left']), 1, b)
            names = {m['name'] for m in b['mirrors']}
            self.assertIn('Image Tools (Second Display)', names, b)
            self.assertIn('Series (Second Display)', names, b)
            tools = next(m for m in b['mirrors'] if m['name'] == 'Image Tools (Second Display)')
            self.assertLessEqual(abs(tools['bottom'] - column['bottom']), 1, b)
            self.assertLess(strip['right'], tools['left'], b)  # the strip itself lies whole on the first display
            # The second display has the strip on its own left edge (at the seam); it comes out when the pointer is there.
            seam = tools['left']
            copy = viewer.get_by_role('group', name='Series (Second Display)')
            box = copy.bounding_box()
            self.assertLessEqual(abs(box['x'] - seam), 1, b)
            self.assertEqual('0', copy.evaluate('n => getComputedStyle(n).opacity'))
            viewer.mouse.move(seam + 3, box['y'] + 100)
            expect(copy).to_have_attribute('data-kin-shown', '')
            expect(copy.locator('.kin-series-card').first).to_be_visible()
            # The copied tools at the bottom of the second display work as the originals.
            viewer.get_by_role('group', name='Image Tools (Second Display)').get_by_role('button', name='Zoom', exact=True).click()
            self.assertEqual(viewer.evaluate(self.ACTIVE_TOOL), 'Zoom')

        ACTIVE_TOOL = '''() => services.toolGroupService.getToolGroupForViewport(
          services.viewportGridService.getActiveViewportId()).getActivePrimaryMouseButtonTool()'''


def load_tests(loader, tests, pattern):
    # Only the cases this module declares; the inherited cases run in their own profiles.
    suite = unittest.TestSuite(ViewerChromePositionE2E(name) for name in sorted(ViewerChromePositionE2E.__dict__) if name.startswith('test_chrome_'))
    if '--portrait' not in sys.argv:
        suite.addTests(ViewerChromeSpanE2E(name) for name in sorted(ViewerChromeSpanE2E.__dict__) if name.startswith('test_chrome_'))
    return suite


if __name__ == '__main__':
    unittest.main()
