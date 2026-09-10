# coding: utf-8
"""REQ-D-WORKSPACE-READING-LAYOUT / RISK-D-WORKSPACE-WORK-LOSS/OWNER / TEST-READING-PANEL-LAYOUT.

Real CT, private drafts and native viewer state survive integrated panel changes.
"""
from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest
import uuid

from playwright.sync_api import expect
from test_prior_selection import canvas_ready
from test_reading_workspace import ReadingWorkspaceE2E
from test_workspace_persistence import WorkspacePersistenceE2E
from test_workspace_roaming import WorkspaceRoamingE2E
from workspace_roaming_support import cleanup_workspace


class ReadingPanelLayoutE2E(ReadingWorkspaceE2E):
    device = WorkspacePersistenceE2E.device
    sign_in = WorkspacePersistenceE2E.sign_in
    sign_out = WorkspacePersistenceE2E.sign_out
    owner = WorkspacePersistenceE2E.owner
    stored = WorkspacePersistenceE2E.stored
    drag_by = WorkspacePersistenceE2E.drag_by
    size_is = WorkspacePersistenceE2E.size_is
    remote = WorkspaceRoamingE2E.remote
    open_menu = WorkspaceRoamingE2E.open_menu
    action = WorkspaceRoamingE2E.action

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.addClassCleanup(cleanup_workspace, cls.stack)

    def tearDown(self):
        super().tearDown()
        cleanup_workspace(self.stack)

    def panels(self, page):
        return page.evaluate('readingWorkspace.snapshotPanels()')

    def defaults(self):
        return dict(version=1, reportWidth=None, imageHeight=None, relatedHeight=None,
                    relatedListHeight=None, relatedHidden=False)

    def key_resize(self, page, selector, key):
        handle = page.locator(selector)
        handle.scroll_into_view_if_needed()
        handle.focus()
        handle.press(key)
        expect(handle).to_be_focused()

    def mark_document(self, frame):
        marker = str(uuid.uuid4())
        frame.evaluate('(marker) => window.__readingPanelDocument = marker', marker)
        return marker

    def native_view(self, frame):
        # Canvas dimensions legitimately change during layout. Hash decoded CT
        # samples and inspect the real camera, rather than compare resized PNGs.
        result = frame.evaluate('''async () => {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const cells = [...services.viewportGridService.getState().viewports.values()]
            .sort((a,b) => a.y-b.y || a.x-b.x).filter(cell => cell.displaySetInstanceUIDs?.length);
          const rounded = value => value === undefined ? null : JSON.parse(JSON.stringify(value, (_key, item) =>
            typeof item === 'number' ? Math.round(item * 1e6) / 1e6 : item));
          return await Promise.all(cells.map(async cell => {
            const viewport = services.cornerstoneViewportService.getCornerstoneViewport(cell.viewportId);
            const image = viewport.getCurrentImageId();
            const pixels = cornerstone.cache.getImage(image).getPixelData();
            const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength).slice();
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            let min = Infinity, max = -Infinity;
            for (const pixel of pixels) { min = Math.min(min, pixel); max = Math.max(max, pixel); }
            return { image, samples: pixels.length, min, max,
              pixels: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join(''),
              camera: rounded(viewport.getCamera()), voi: rounded(viewport.getProperties().voiRange) };
          }));
        }''')
        self.assertEqual(len(result), 2)
        for viewport in result:
            self.assertEqual(viewport['samples'], 256 * 256)
            self.assertGreater(viewport['max'], viewport['min'])
        return result

    def retained(self, page, frame, marker, fixture, draft):
        self.assertEqual(frame.evaluate('window.__readingPanelDocument'), marker)
        expect(page.locator('#reading-target')).to_contain_text(fixture.uid)
        expect(page.locator('#findings')).to_have_value(draft)
        self.assertEqual(page.evaluate('selectedUid'), fixture.uid)
        canvas_ready(frame, 2)

    def expect_draft(self, page, fixture, draft, versions):
        self.wait_state(page, fixture, lambda state: (state.get('draft') or {}).get('findings') == draft,
                        timeout=30000)
        self.assertEqual(self.state(fixture)['findings'], 'CURRENT ' + fixture.uid)
        self.assertEqual(self.versions(fixture), versions)

    def capture(self, page, name):
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', str(Path(__file__).parent / 'artifacts')))
        folder.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(folder / ('reading-panels-' + name + '.png')))

    def test_reading_panels_01_resize_hide_prior_shortcuts_and_reset_preserve_work(self):
        current, prior = self.pair()
        originals = self.originals()
        versions = {fixture.uid: self.versions(fixture) for fixture in (current, prior)}
        page = self.sign_in(self.device())
        page.set_viewport_size(dict(width=1680, height=1100))
        frame = self.workspace(page, current)
        marker = self.mark_document(frame)
        page.locator(f'#relrows tr[data-uid="{prior.uid}"]').click()
        expect(page.locator('#prior-findings')).to_have_text('PRIOR ' + prior.uid)
        draft = 'PANEL RESIZE PRIVATE REPORT ' + current.uid
        page.locator('#findings').fill(draft)
        comparison = frame.get_by_role('button', name='Comparison', exact=True)
        comparison.click()
        frame.get_by_label('Job Title', exact=True).fill('PANEL RESIZE UNSAVED VIEWER')
        comparison.click()
        canvas_ready(frame, 2)
        baseline_view = self.native_view(frame)

        report_width = int(page.locator('#reading-resize-report').get_attribute('aria-valuenow'))
        self.drag_by(page, '#reading-resize-report', dx=-60)
        self.assertAlmostEqual(self.panels(page)['reportWidth'], report_width + 60, delta=2)
        self.size_is(page, '#reading-report-column', 'width', self.panels(page)['reportWidth'])
        self.key_resize(page, '#reading-resize-report', 'ArrowLeft')
        self.assertAlmostEqual(self.panels(page)['reportWidth'], report_width + 70, delta=2)
        for selector, dimension in (('#reading-resize-related', 'relatedHeight'),
                                    ('#reading-resize-prior', 'relatedListHeight')):
            self.key_resize(page, selector, 'End')
            maximum = int(page.locator(selector).get_attribute('aria-valuemax'))
            self.assertEqual(self.panels(page)[dimension], maximum)
            self.key_resize(page, selector, 'Home')
            minimum = int(page.locator(selector).get_attribute('aria-valuemin'))
            self.assertEqual(self.panels(page)[dimension], minimum)
            self.key_resize(page, selector, 'End')
        chosen = self.panels(page)
        self.size_is(page, '#reading-related-region', 'height', chosen['relatedHeight'])
        self.size_is(page, '#reading-related-list', 'height', chosen['relatedListHeight'])
        self.retained(page, frame, marker, current, draft)

        page.locator('#reading-related-toggle').click()
        expect(page.locator('#reading-related-region')).not_to_be_visible()
        expect(page.locator('#reading-related-region')).to_have_attribute('aria-hidden', 'true')
        self.assertTrue(page.locator('#reading-related-region').evaluate('element => element.inert'))
        expect(page.locator('#reading-resize-related')).not_to_be_visible()
        expect(page.locator('#reading-resize-prior')).not_to_be_visible()
        expect(page.locator('#reading-related-toggle')).to_have_text('Show Related Panel')
        page.keyboard.press('Control+Alt+3')
        expect(page.locator('#reading-prior-report')).to_be_focused()
        expect(page.locator('#reading-related-region')).to_be_visible()
        expect(page.locator('#prior-findings')).to_have_text('PRIOR ' + prior.uid)
        self.assertEqual(self.panels(page), chosen)
        page.keyboard.press('Control+Alt+4')
        expect(page.locator('#findings')).to_be_focused()
        page.keyboard.press('Control+Alt+2')
        expect(page.locator('#reading-frame')).to_be_focused()
        self.retained(page, frame, marker, current, draft)
        self.capture(page, 'resized')

        page.locator('#reading-panels-reset').click()
        self.assertEqual(self.panels(page), self.defaults())
        self.retained(page, frame, marker, current, draft)
        self.assertEqual(self.native_view(frame), baseline_view)
        comparison.click()
        expect(frame.get_by_label('Job Title', exact=True)).to_have_value('PANEL RESIZE UNSAVED VIEWER')
        self.expect_draft(page, current, draft, versions[current.uid])
        self.assertEqual(self.versions(prior), versions[prior.uid])
        self.assertEqual(self.jobs(current), [])
        self.assertEqual(self.jobs(prior), [])
        self.assertEqual(self.originals(), originals)

    def test_reading_panels_02_owner_reopen_narrow_bounds_and_storage_failure(self):
        current, _ = self.pair()
        versions = self.versions(current)
        context = self.device()
        page = self.sign_in(context)
        page.set_viewport_size(dict(width=1680, height=1100))
        frame = self.workspace(page, current)
        marker = self.mark_document(frame)
        draft = 'LOCAL PANEL OWNER DRAFT ' + current.uid
        page.locator('#findings').fill(draft)
        self.key_resize(page, '#reading-resize-report', 'Shift+ArrowLeft')
        self.key_resize(page, '#reading-resize-related', 'End')
        self.key_resize(page, '#reading-resize-prior', 'End')
        wide = self.panels(page)
        record = self.stored(page)
        self.assertEqual(record['version'], 2)
        self.assertEqual(record['reading'], wide)
        wide_view = self.native_view(frame)
        page.set_viewport_size(dict(width=800, height=1100))
        expect(page.locator('#reading-resize-report')).to_have_attribute('aria-orientation', 'horizontal')
        self.assertEqual(self.panels(page), wide)
        self.assertEqual(self.stored(page), record)
        frame_box = page.locator('#reading-viewer').bounding_box()
        report_box = page.locator('#reading-report-column').bounding_box()
        self.assertGreaterEqual(report_box['y'], frame_box['y'] + frame_box['height'])
        self.assertLessEqual(report_box['x'] + report_box['width'], 801)
        self.key_resize(page, '#reading-resize-report', 'Shift+ArrowDown')
        narrow = self.panels(page)
        self.assertEqual(narrow['reportWidth'], wide['reportWidth'])
        self.assertIsInstance(narrow['imageHeight'], int)
        self.assertEqual(self.stored(page)['reading'], narrow)
        self.retained(page, frame, marker, current, draft)
        self.capture(page, 'narrow')
        page.set_viewport_size(dict(width=1680, height=1100))
        expect(page.locator('#reading-resize-report')).to_have_attribute('aria-orientation', 'vertical')
        self.size_is(page, '#reading-report-column', 'width', wide['reportWidth'])
        self.retained(page, frame, marker, current, draft)
        self.assertEqual(self.native_view(frame), wide_view)
        page.locator('#reading-related-toggle').click()
        chosen = self.panels(page)
        owner, owner_record = self.owner(page), self.stored(page)
        self.expect_draft(page, current, draft, versions)
        self.sign_out(page)

        other = self.sign_in(context, 'doctor2')
        self.assertNotEqual(self.owner(other), owner)
        self.assertEqual(self.panels(other), self.defaults())
        self.assertIsNone(self.stored(other))
        self.sign_out(other)
        reopened = self.sign_in(context)
        reopened.set_viewport_size(dict(width=1680, height=1100))
        restored_frame = self.workspace(reopened, current)
        expect(reopened.locator('#findings')).to_have_value(draft)
        expect(reopened.locator('#reading-related-region')).not_to_be_visible()
        self.assertEqual(self.panels(reopened), chosen)
        self.assertEqual(self.stored(reopened), owner_record)
        self.size_is(reopened, '#reading-report-column', 'width', chosen['reportWidth'])
        canvas_ready(restored_frame, 2)
        fresh = self.sign_in(self.device())
        self.assertEqual(self.panels(fresh), self.defaults())
        self.assertIsNone(self.stored(fresh))

        reopened.evaluate('''() => {
          const write = Storage.prototype.setItem;
          Storage.prototype.setItem = function(key, value) {
            if (String(key).startsWith('kin-workspace:'))
              throw new DOMException('Synthetic panel storage denial', 'QuotaExceededError');
            return write.call(this, key, value);
          };
        }''')
        self.key_resize(reopened, '#reading-resize-report', 'ArrowLeft')
        expect(reopened.locator('#layout-status')).to_contain_text('저장 안 됨')
        self.assertEqual(self.panels(reopened)['reportWidth'], chosen['reportWidth'] + 10)
        self.assertEqual(self.stored(reopened), owner_record)
        self.size_is(reopened, '#reading-report-column', 'width', chosen['reportWidth'] + 10)
        expect(reopened.locator('#findings')).to_have_value(draft)
        self.assertEqual(self.versions(current), versions)

    def test_reading_panels_03_legacy_load_preserves_local_then_v2_account_restore(self):
        current, _ = self.pair()
        originals, versions = self.originals(), self.versions(current)
        source = self.sign_in(self.device())
        source.set_viewport_size(dict(width=1680, height=1100))
        source_frame = self.workspace(source, current)
        self.key_resize(source, '#reading-resize-report', 'Shift+ArrowLeft')
        self.key_resize(source, '#reading-resize-related', 'End')
        source.locator('#reading-related-toggle').click()
        chosen = self.panels(source)

        # A real legacy record must exist before the first v2 save: a later v1
        # overwrite is correctly rejected by the API's downgrade protection.
        remote = self.remote(source)
        self.assertIsNone(remote['layout'])
        legacy = dict(version=1, mode='auto', landscape={'main': 650}, portrait={})
        seeded = source.request.put(self.stack.proxy + '/api/workspace-layout',
                                    headers={'X-KIN-CSRF': '1'},
                                    data=dict(expectedOwner=remote['owner'], revision=remote['revision'], layout=legacy))
        self.assertEqual(seeded.status, 200)
        marker = self.mark_document(source_frame)
        before_view = self.native_view(source_frame)
        self.action(source, 'Load from Account', '불러왔습니다')
        self.assertEqual(self.panels(source), chosen)
        self.assertEqual(self.stored(source)['reading'], chosen)
        self.assertEqual(self.remote(source)['layout'], legacy)
        self.assertEqual(source_frame.evaluate('window.__readingPanelDocument'), marker)
        canvas_ready(source_frame, 2)
        self.assertEqual(self.native_view(source_frame), before_view)
        self.action(source, 'Save to Account', '계정에 저장했습니다')
        saved = self.remote(source)
        self.assertEqual(saved['layout']['version'], 2)
        self.assertEqual(saved['layout']['reading'], chosen)
        self.assertEqual(saved['layout']['landscape'], legacy['landscape'])

        target = self.sign_in(self.device())
        target.set_viewport_size(dict(width=1680, height=1100))
        target_frame = self.workspace(target, current)
        self.assertEqual(self.panels(target), self.defaults())
        self.assertIsNone(self.stored(target))
        draft = 'ACCOUNT PANEL LOAD PRIVATE REPORT ' + current.uid
        target.locator('#findings').fill(draft)
        target_marker = self.mark_document(target_frame)
        target_view = self.native_view(target_frame)
        self.action(target, 'Load from Account', '불러왔습니다')
        self.assertEqual(self.panels(target), chosen)
        self.assertEqual(self.stored(target), saved['layout'])
        self.size_is(target, '#reading-report-column', 'width', chosen['reportWidth'])
        expect(target.locator('#reading-related-region')).not_to_be_visible()
        self.retained(target, target_frame, target_marker, current, draft)
        self.assertEqual(self.native_view(target_frame), target_view)
        self.assertEqual(self.panels(source), chosen)
        self.assertEqual(self.remote(target), saved)
        self.expect_draft(target, current, draft, versions)
        self.capture(target, 'account-restored')

        # Reset removes the local record, but this modern UI must still send
        # v2 when saving again instead of being mistaken for an older writer.
        source.bring_to_front()
        source_report = source.locator('#findings').input_value()
        source_view = self.native_view(source_frame)
        source.locator('#layout-reset').click()
        self.assertEqual(self.panels(source), self.defaults())
        self.assertIsNone(self.stored(source))
        self.retained(source, source_frame, marker, current, source_report)
        with source.expect_response(lambda response: response.request.method == 'PUT'
                                    and response.url.endswith('/api/workspace-layout')) as resaved:
            self.action(source, 'Save to Account', '계정에 저장했습니다')
        self.assertEqual(resaved.value.status, 200)
        reset_saved = self.remote(source)
        self.assertEqual(reset_saved['revision'], saved['revision'] + 1)
        self.assertEqual(reset_saved['layout'], dict(version=2, mode='auto', landscape={},
                                                     portrait={}, reading=self.defaults()))
        self.retained(source, source_frame, marker, current, source_report)
        self.assertEqual(self.native_view(source_frame), source_view)

        target.bring_to_front()
        self.assertEqual(self.panels(target), chosen)
        self.assertEqual(self.stored(target), saved['layout'])
        expect(target.locator('#reading-related-region')).not_to_be_visible()
        self.size_is(target, '#reading-report-column', 'width', chosen['reportWidth'])
        self.retained(target, target_frame, target_marker, current, draft)
        self.assertEqual(self.native_view(target_frame), target_view)
        self.assertEqual(self.state(current)['draft']['findings'], draft)
        self.assertEqual(self.versions(current), versions)
        self.assertEqual(self.jobs(current), [])
        self.assertEqual(self.originals(), originals)
    def test_reading_panels_04_viewport_breakpoint_escape_and_range_only_redraw(self):
        current, prior = self.pair()
        originals = self.originals()
        versions = {fixture.uid: self.versions(fixture) for fixture in (current, prior)}
        page = self.sign_in(self.device())
        page.set_viewport_size(dict(width=860, height=1100))
        frame = self.workspace(page, current)
        marker = self.mark_document(frame)
        draft = 'PANEL BREAKPOINT PRIVATE REPORT ' + current.uid
        page.locator('#findings').fill(draft)
        baseline_view = self.native_view(frame)
        handle = page.locator('#reading-resize-report')

        # A constrained content area must not select a different orientation
        # from the viewport media query which controls the real CSS grid.
        page.locator('.split').evaluate("element => element.style.width = '820px'")
        expect(handle).to_have_attribute('aria-valuemax', '454')
        self.assertFalse(page.evaluate("matchMedia('(max-width: 850px)').matches"))
        self.assertEqual(page.locator('.split').evaluate('element => getComputedStyle(element).display'), 'grid')
        expect(handle).to_have_attribute('aria-orientation', 'vertical')
        width = int(handle.get_attribute('aria-valuenow'))
        self.key_resize(page, '#reading-resize-report', 'ArrowLeft')
        self.assertEqual(self.panels(page)['reportWidth'], width + 10)
        self.assertIsNone(self.panels(page)['imageHeight'])
        self.size_is(page, '#reading-report-column', 'width', width + 10)
        self.retained(page, frame, marker, current, draft)

        page.evaluate('''() => {
          window.__panelEscapeEvents = [];
          window.__panelEscapeProbe = event => {
            if (event.key === 'Escape') window.__panelEscapeEvents.push(event.defaultPrevented);
          };
          document.addEventListener('keydown', window.__panelEscapeProbe);
        }''')
        self.key_resize(page, '#reading-resize-report', 'Escape')
        self.assertEqual(page.evaluate('window.__panelEscapeEvents'), [False])
        page.evaluate("document.removeEventListener('keydown', window.__panelEscapeProbe)")

        self.key_resize(page, '#reading-resize-report', 'Enter')
        page.locator('.split').evaluate("element => element.style.removeProperty('width')")
        self.retained(page, frame, marker, current, draft)
        self.assertEqual(self.native_view(frame), baseline_view)

        # More scrollable report space changes only separator limits. It must
        # not resize an unchanged image canvas as a side effect of that metadata.
        related_handle = page.locator('#reading-resize-related')
        previous_max = int(related_handle.get_attribute('aria-valuemax'))
        work_height = page.locator('.workrow').evaluate('element => element.clientHeight')
        frame.evaluate('''() => {
          window.__panelSyntheticResizes = 0;
          window.__panelResizeProbe = event => { if (!event.isTrusted) window.__panelSyntheticResizes++; };
          window.addEventListener('resize', window.__panelResizeProbe);
        }''')
        page.locator('.workrow').evaluate("(element, height) => element.style.minHeight = height + 'px'", work_height + 40)
        page.wait_for_function("maximum => Number(document.getElementById('reading-resize-related').getAttribute('aria-valuemax')) > maximum", arg=previous_max)
        self.assertEqual(self.native_view(frame), baseline_view)
        self.assertEqual(frame.evaluate('window.__panelSyntheticResizes'), 0)
        frame.evaluate("window.removeEventListener('resize', window.__panelResizeProbe)")
        page.locator('.workrow').evaluate("element => element.style.removeProperty('min-height')")
        self.retained(page, frame, marker, current, draft)
        self.assertEqual(self.panels(page), self.defaults())
        self.expect_draft(page, current, draft, versions[current.uid])
        self.assertEqual(self.versions(prior), versions[prior.uid])
        self.assertEqual(self.jobs(current), [])
        self.assertEqual(self.originals(), originals)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ReadingPanelLayoutE2E(name)
                              for name in loader.getTestCaseNames(ReadingPanelLayoutE2E)
                              if name.startswith('test_reading_panels_'))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(verbosity=2)
