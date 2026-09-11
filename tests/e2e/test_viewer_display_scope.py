# coding: utf-8
"""Native classic CT display scope, exact targets and recovery on synthetic data."""
import unittest
from playwright.sync_api import expect
from test_display_controls import DisplayControlsE2E


class ViewerDisplayScopeE2E(DisplayControlsE2E):
    def assert_restored(self, before, after):
        # Camera restoration may round patient-space floats; source, VOI and
        # rendered pixels must remain exact at this synthetic geometry.
        def same(a, b):
            if isinstance(a, bool) or not isinstance(a, (dict, list, float, int)):
                self.assertEqual(a, b)
            elif isinstance(a, dict):
                self.assertEqual(set(a), set(b))
                for key in a: same(a[key], b[key])
            elif isinstance(a, list):
                self.assertEqual(len(a), len(b))
                for x, y in zip(a, b): same(x, y)
            else:
                self.assertAlmostEqual(a, b, delta=1e-7)
        self.assertEqual(len(before), len(after))
        for old, item in zip(before, after):
            for field in ['id', 'properties', 'image', 'index', 'rgba', 'canvasHash']:
                self.assertEqual(old[field], item[field])
            same(old['camera'], item['camera']); same(old['point'], item['point'])

    def pair(self):
        fixture, page = self.open_pair()
        self.open_layout_tools(page)
        expect(page.locator('#kin-display-scope')).to_be_visible(timeout=30000)
        page.wait_for_timeout(200)
        return fixture, page

    def scope(self, page, mode):
        page.locator(f'#kin-display-scope [data-scope-mode="{mode}"]').click()

    def operate(self, page, action):
        page.locator(f'#kin-display-scope [data-action="{action}"]').click()
        expect(page.locator('#kin-display-scope [role=status]')).to_contain_text('표시 조작을 적용했습니다.')
        page.wait_for_timeout(120)

    def test_scope_01_all_ct_window_rotation_flip_and_reset_pixels(self):
        fixture, page = self.pair(); originals = self.originals(); rows = self.report_rows(fixture)
        untouched = self.display(page); self.scope(page, 'all')
        page.locator('#kin-display-scope [data-action=reset]').click()
        expect(page.locator('#kin-display-scope [role=status]')).to_contain_text('Reset')
        self.assertEqual(untouched, self.display(page))
        # The native Reset establishes an explicit Grayscale colormap. Group
        # Reset requires a publicly restorable snapshot, so undefined native
        # defaults remain an explicit refusal rather than a lossy rollback.
        for index in (0, 1):
            self.choose(page, index); page.keyboard.press('Space'); page.wait_for_timeout(120)
        self.choose(page, 0)
        before = self.display(page); active = page.evaluate('services.viewportGridService.getState().activeViewportId')
        self.scope(page, 'all')
        page.locator('#kin-display-scope [data-ww]').fill('1')
        page.locator('#kin-display-scope [data-wc]').fill('40')
        page.locator('#kin-display-scope [data-window]').click()
        expect(page.locator('#kin-display-scope [role=status]')).to_contain_text('2개 CT')
        for item in self.display(page):
            self.assertEqual(item['properties']['voiRange'], {'lower': 39.5, 'upper': 39.5})
        page.locator('#kin-display-scope [data-ww]').fill('400')
        page.locator('#kin-display-scope [data-wc]').fill('40')
        page.locator('#kin-display-scope [data-window]').click()
        expect(page.locator('#kin-display-scope [role=status]')).to_contain_text('2개 CT')
        page.wait_for_timeout(120); windowed = self.display(page)
        self.assertTrue(any(a['canvasHash'] != b['canvasHash'] for a, b in zip(before, windowed)))
        for old, item in zip(before, windowed):
            self.assertEqual(item['properties']['voiRange'], {'lower': -160, 'upper': 239})
            self.assertEqual(item['image'], old['image']); self.assertEqual(item['index'], old['index'])
        self.operate(page, 'rotate-right')
        for item in self.display(page): self.assertAlmostEqual(item['camera']['rotation'], 90)
        self.operate(page, 'flipH')
        for item in self.display(page): self.assertTrue(item['camera']['flipHorizontal'])
        self.operate(page, 'reset')
        for old, item in zip(before, self.display(page)):
            self.assertEqual(item['image'], old['image'])
            self.assertAlmostEqual(item['camera']['rotation'], 0)
            self.assertFalse(item['camera']['flipHorizontal'])
            self.assertEqual(item['properties']['voiRange'], old['properties']['voiRange'])
        self.assertEqual(active, page.evaluate('services.viewportGridService.getState().activeViewportId'))
        self.assertEqual(rows, self.report_rows(fixture)); self.assertEqual(originals, self.originals())
        self.shot(page, 'display-scope-all')

    def test_scope_02_checkbox_set_complement_and_unselected_cell_preservation(self):
        fixture, page = self.pair(); originals = self.originals(); before = self.display(page)
        boxes = page.locator('#kin-display-scope [data-scope-cells] input')
        expect(boxes.nth(0)).to_be_checked(); expect(boxes.nth(1)).not_to_be_checked()
        boxes.nth(1).check(); expect(boxes.nth(0)).to_be_checked()
        boxes.nth(0).uncheck(); self.operate(page, 'flipV')
        after = self.display(page); self.assertEqual(before[0], after[0]); self.assertTrue(after[1]['camera']['flipVertical'])
        page.locator('#kin-display-scope [data-scope-invert]').click()
        expect(boxes.nth(0)).to_be_checked(); expect(boxes.nth(1)).not_to_be_checked()
        self.operate(page, 'invert'); final = self.display(page)
        self.assertTrue(final[0]['properties']['invert']); self.assertEqual(after[1], final[1])
        self.assertEqual(originals, self.originals())

    def test_scope_03_mid_apply_failure_restores_exact_existing_targets(self):
        fixture, page = self.pair(); originals = self.originals(); rows = self.report_rows(fixture)
        self.scope(page, 'all'); before = self.display(page)
        page.evaluate("""()=>{const cells=[...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x);
          const v=services.cornerstoneViewportService.getCornerstoneViewport(cells[1].viewportId),original=v.setProperties;
          let once=true;window.restoreScopeSetter=()=>{v.setProperties=original;};
          v.setProperties=function(...args){if(once){once=false;throw Error('Synthetic second target failure')}return original.apply(this,args)};}""")
        try:
            page.locator('#kin-display-scope [data-action=invert]').click()
            expect(page.locator('#kin-display-scope [role=status]')).to_contain_text('이전 표시로 복구했습니다.')
            page.wait_for_timeout(120)
            self.assert_restored(before, self.display(page))
        finally:
            page.evaluate('restoreScopeSetter()')
        self.operate(page, 'invert')
        for item in self.display(page): self.assertTrue(item['properties']['invert'])
        before_window = self.display(page)
        page.evaluate("""()=>{const cells=[...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x);
          const v=services.cornerstoneViewportService.getCornerstoneViewport(cells[1].viewportId),original=v.setVOI;
          let once=true;window.restoreScopeVoi=()=>{v.setVOI=original;};
          v.setVOI=function(...args){if(once){once=false;throw Error('Synthetic W/L failure')}return original.apply(this,args)};}""")
        try:
            page.locator('#kin-display-scope [data-ww]').fill('400')
            page.locator('#kin-display-scope [data-wc]').fill('40')
            page.locator('#kin-display-scope [data-window]').click()
            expect(page.locator('#kin-display-scope [role=status]')).to_contain_text('일부 표시')
            page.wait_for_timeout(120)
            for old, item in zip(before_window, self.display(page)):
                for field in ['id', 'image', 'index', 'camera', 'rgba', 'canvasHash']:
                    self.assertEqual(old[field], item[field])
                self.assertEqual({k:v for k,v in old['properties'].items() if k!='colormap'},
                                 {k:v for k,v in item['properties'].items() if k!='colormap'})
                self.assertEqual(item['properties']['colormap']['name'], 'Grayscale')
        finally:
            page.evaluate('restoreScopeVoi()')
        self.assertEqual(rows, self.report_rows(fixture)); self.assertEqual(originals, self.originals())

    def test_scope_04_layout_source_reset_and_report_hold_preservation(self):
        fixture, page = self.pair(); self.seed_report(fixture)
        values = {'findings': 'Display scope private draft', 'conclusion': '', 'recommendation': ''}
        self.assertEqual(200, self.stack.request('PUT', f'/studies/{fixture.uid}/report', 'doctor', dict(values, baseVersion=1)).status)
        self.assertEqual(201, self.stack.request('POST', f'/studies/{fixture.uid}/hold', 'doctor').status)
        originals = self.originals(); rows = self.report_rows(fixture)
        work = self.login(); self.select(work, fixture)
        self.scope(page, 'all'); self.grid(page, 1)
        expect(page.locator('#kin-display-scope [data-scope-mode=active]')).to_have_attribute('aria-pressed', 'true')
        self.scope(page, 'set'); page.locator('#kin-display-scope [data-scope-cells] input').check()
        self.drag(page, 'D02E second series', 0)
        expect(page.locator('#kin-display-scope [data-scope-mode=active]')).to_have_attribute('aria-pressed', 'true')
        page.wait_for_function("""()=>{const g=[...services.viewportGridService.getState().viewports.values()][0],
          v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId),d=services.displaySetService.getDisplaySetByUID(g.displaySetInstanceUIDs[0]),
          m=cornerstone.metaData.get('instance',v?.getCurrentImageId?.());return m?.SeriesInstanceUID===d?.SeriesInstanceUID;}""", timeout=60000)
        self.operate(page, 'fit')
        expect(work.locator('#findings')).to_have_value(values['findings'])
        self.assertEqual(self.stack.actor('doctor'), self.state(fixture)['holder'])
        self.assertEqual(rows, self.report_rows(fixture)); self.assertEqual(originals, self.originals())


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ViewerDisplayScopeE2E(name) for name in ViewerDisplayScopeE2E.__dict__ if name.startswith('test_scope_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
