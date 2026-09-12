# coding: utf-8
"""Native 2x2 cell merge/maximize: real pane geometry, source state and preservation."""
import json
import unittest
import uuid

from playwright.sync_api import expect
from test_display_controls import DisplayControlsE2E


class ViewerCellMergeE2E(DisplayControlsE2E):
    def loaded(self, page, count):
        # A 2x2 grid with two filled cells keeps empty panes without a canvas, so the
        # exact-count helper of the other suites does not apply here.
        page.wait_for_function("""count => {
            const rendered = [...document.querySelectorAll('.cornerstone-canvas')].filter(canvas => {
              const context = canvas.getContext('2d');
              if (!context || !canvas.width || !canvas.height) return false;
              const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
              let low = 255, high = 0;
              for (let index = 0; index < data.length; index += 16) { low = Math.min(low, data[index]); high = Math.max(high, data[index]); }
              return high - low > 100;
            });
            return rendered.length >= count;
        }""", arg=count, timeout=60000)

    def quad(self):
        fixture = self.multiple('CELLMERGE-' + uuid.uuid4().hex[:12], 'current', '20260801')
        page = self.launch(self.login(), [fixture])
        self.grid(page, 4)
        self.drag(page, 'D03A current', 0)
        self.drag(page, 'D02E second series', 1)
        self.loaded(page, 2)
        self.choose(page, 0)
        self.open_layout_tools(page)
        expect(page.locator('#kin-cell-merge')).to_be_visible(timeout=45000)
        page.wait_for_timeout(200)
        return fixture, page

    def geometry(self, page):
        return page.evaluate('''()=>[...services.viewportGridService.getState().viewports.values()]
          .sort((a,b)=>a.y-b.y||a.x-b.x).map(v=>[v.viewportId,v.x,v.y,v.width,v.height,v.displaySetInstanceUIDs||[]])''')

    def snap(self, page):
        return page.evaluate('''()=>[...services.viewportGridService.getState().viewports.values()]
          .sort((a,b)=>a.y-b.y||a.x-b.x).filter(g=>(g.displaySetInstanceUIDs||[]).length).map(g=>{
            const v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);
            return {id:g.viewportId,sets:g.displaySetInstanceUIDs,type:v?.type||null,camera:v?.getCamera?.()||null,
              properties:v?.getProperties?.()||null,image:v?.getCurrentImageId?.()||null,index:v?.getCurrentImageIdIndex?.()??null};
          })''')

    def annotations(self, page):
        return page.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations()"
                             ".map(a=>({metadata:a.metadata,points:a.data.handles.points,text:a.data.text||null}))")

    def merge_button(self, page, action):
        return page.locator(f'#kin-cell-merge [data-cell-merge="{action}"]')

    def pane_box(self, page, index=0):
        return page.locator('[data-cy=viewport-grid] > div').nth(index).bounding_box()

    def dblclick_pane(self, page, index):
        box = page.locator('[data-cy=viewport-grid] > div').nth(index).locator('canvas').bounding_box()
        page.mouse.dblclick(box['x'] + box['width'] * .5, box['y'] + box['height'] * .35)

    def test_cell_merge_01_double_click_maximizes_one_cell_and_returns_the_prior_grid(self):
        fixture, page = self.quad()
        originals = self.originals(); rows = self.report_rows(fixture)
        before_geometry = self.geometry(page); before = self.snap(page)
        grid_box = page.locator('[data-cy=viewport-grid]').bounding_box()
        self.dblclick_pane(page, 0)
        page.wait_for_function('()=>services.viewportGridService.getState().viewports.size===1', timeout=30000)
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('확대했습니다')
        merged = self.geometry(page)
        self.assertEqual([[before[0]['id'], 0, 0, 1, 1, before[0]['sets']]], merged)
        box = self.pane_box(page, 0)
        self.assertAlmostEqual(box['width'], grid_box['width'], delta=2)
        self.assertAlmostEqual(box['height'], grid_box['height'], delta=2)
        maximized = self.snap(page)
        self.assertEqual(before[0]['image'], maximized[0]['image'])
        self.assertEqual(before[0]['properties']['voiRange'], maximized[0]['properties']['voiRange'])
        print('CELL-MERGE maximize ' + json.dumps({'before': before_geometry, 'merged': merged}), flush=True)
        self.dblclick_pane(page, 0)
        page.wait_for_function('()=>services.viewportGridService.getState().viewports.size===4', timeout=30000)
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('되돌렸습니다')
        self.assertEqual(before_geometry, self.geometry(page))
        after = self.snap(page)
        self.assertEqual([item['id'] for item in before], [item['id'] for item in after])
        for old, item in zip(before, after):
            self.assertEqual(old['sets'], item['sets'])
            self.assertEqual(old['image'], item['image'])
            self.assertEqual(old['index'], item['index'])
            self.assertEqual(old['properties'], item['properties'])
            self.assertEqual(old['camera'], item['camera'])
        self.shot(page, 'cell-merge-maximize')
        self.assertEqual(rows, self.report_rows(fixture)); self.assertEqual(originals, self.originals())

    def test_cell_merge_02_column_merge_keeps_every_source_in_its_own_rectangle(self):
        fixture, page = self.quad()
        originals = self.originals()
        before_geometry = self.geometry(page); before = self.snap(page)
        self.merge_button(page, 'merge-column').click()
        page.wait_for_function('()=>services.viewportGridService.getState().viewports.size===3', timeout=30000)
        merged = self.geometry(page)
        self.assertEqual([before[0]['id'], 0, 0, .5, 1], merged[0][:5])
        self.assertEqual([0.5, 0, .5, .5], merged[1][1:5])
        self.assertEqual([0.5, .5, .5, .5], merged[2][1:5])
        # The anchor pane really is a full-height half, not just a state entry.
        grid_box = page.locator('[data-cy=viewport-grid]').bounding_box()
        anchor = self.pane_box(page, 0)
        self.assertAlmostEqual(anchor['height'], grid_box['height'], delta=2)
        self.assertAlmostEqual(anchor['width'], grid_box['width'] / 2, delta=2)
        kept = self.snap(page)
        self.assertEqual([item['id'] for item in before], [item['id'] for item in kept])
        for old, item in zip(before, kept):
            self.assertEqual(old['image'], item['image']); self.assertEqual(old['sets'], item['sets'])
        expect(self.merge_button(page, 'maximize')).to_be_disabled()
        self.merge_button(page, 'restore').click()
        page.wait_for_function('()=>services.viewportGridService.getState().viewports.size===4', timeout=30000)
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('되돌렸습니다')
        self.assertEqual(before_geometry, self.geometry(page))
        for old, item in zip(before, self.snap(page)):
            self.assertEqual(old['camera'], item['camera']); self.assertEqual(old['properties'], item['properties'])
            self.assertEqual(old['image'], item['image'])
        print('CELL-MERGE column ' + json.dumps({'before': before_geometry, 'merged': merged}), flush=True)
        self.assertEqual(originals, self.originals())

    def test_cell_merge_03_measurements_reports_and_save_refusal_survive_a_merge(self):
        fixture, page = self.quad()
        self.seed_report(fixture)
        values = dict(findings='Cell merge draft', conclusion='', recommendation='')
        self.assertEqual(200, self.stack.request('PUT', f'/studies/{fixture.uid}/report', 'doctor', dict(values, baseVersion=1)).status)
        self.assertEqual(201, self.stack.request('POST', f'/studies/{fixture.uid}/hold', 'doctor').status)
        originals = self.originals(); rows = self.report_rows(fixture)
        page.locator('[data-cy="MeasurementTools-split-button-secondary"]').click()
        page.get_by_text('Annotation', exact=True).click()
        box = page.locator('[data-cy=viewport-grid] > div').first.locator('canvas').bounding_box()
        x, y = box['x'] + box['width'] * .5, box['y'] + box['height'] * .5
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 45, y + 28, steps=8); page.mouse.up()
        entry = page.get_by_placeholder('Enter label'); expect(entry).to_be_visible()
        entry.press_sequentially('CM12345')
        page.get_by_role('button', name='Save', exact=True).click()
        drawn = self.annotations(page)
        self.assertTrue(drawn)
        self.merge_button(page, 'maximize').click()
        page.wait_for_function('()=>services.viewportGridService.getState().viewports.size===1', timeout=30000)
        self.assertEqual(drawn, self.annotations(page))
        # The merged screen keeps the existing persistence refusal, unchanged.
        save = page.get_by_role('button', name='Save Recent Layout', exact=True)
        expect(save).to_be_enabled(); save.click()
        expect(page.locator('#kin-viewer-layout-status')).to_contain_text('저장할 수 없습니다')
        self.assertEqual(1, page.evaluate('services.viewportGridService.getState().viewports.size'))
        self.merge_button(page, 'restore').click()
        page.wait_for_function('()=>services.viewportGridService.getState().viewports.size===4', timeout=30000)
        self.assertEqual(drawn, self.annotations(page))
        work = self.login(); self.select(work, fixture)
        expect(work.locator('#findings')).to_have_value(values['findings'])
        self.assertEqual(self.stack.actor('doctor'), self.state(fixture)['holder'])
        self.assertEqual(rows, self.report_rows(fixture)); self.assertEqual(originals, self.originals())
        self.shot(page, 'cell-merge-measurements')

    def test_cell_merge_04_unloaded_cell_and_failed_layout_change_nothing(self):
        fixture, page = self.quad()
        originals = self.originals(); rows = self.report_rows(fixture)
        before_geometry = self.geometry(page); before = self.snap(page)
        # An empty cell cannot become the surviving cell of a merge.
        self.choose(page, 2)
        self.merge_button(page, 'maximize').click()
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('영상이 표시된')
        self.assertEqual(before_geometry, self.geometry(page))
        self.choose(page, 0)
        page.evaluate('''()=>{const grid=services.viewportGridService,original=grid.setLayout;
          window.restoreCellMergeLayout=()=>{grid.setLayout=original;};
          let once=true;grid.setLayout=function(...args){if(once){once=false;return Promise.resolve();}return original.apply(this,args);};}''')
        try:
            self.merge_button(page, 'maximize').click()
            expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('복구했습니다', timeout=30000)
        finally:
            page.evaluate('restoreCellMergeLayout()')
        self.assertEqual(before_geometry, self.geometry(page))
        for old, item in zip(before, self.snap(page)):
            self.assertEqual(old['image'], item['image']); self.assertEqual(old['camera'], item['camera'])
            self.assertEqual(old['properties'], item['properties'])
        # The panel still works afterwards: recovery is not a permanent lock.
        self.merge_button(page, 'maximize').click()
        page.wait_for_function('()=>services.viewportGridService.getState().viewports.size===1', timeout=30000)
        self.merge_button(page, 'restore').click()
        page.wait_for_function('()=>services.viewportGridService.getState().viewports.size===4', timeout=30000)
        self.assertEqual(before_geometry, self.geometry(page))
        self.assertEqual(rows, self.report_rows(fixture)); self.assertEqual(originals, self.originals())


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ViewerCellMergeE2E(name) for name in ViewerCellMergeE2E.__dict__ if name.startswith('test_cell_merge_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
