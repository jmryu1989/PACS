# coding: utf-8
"""Native 2x2 cell merge/maximize: real pane geometry, source state and preservation."""
import json
import unittest
import uuid

from playwright.sync_api import expect
from test_display_controls import DisplayControlsE2E


class ViewerCellMergeE2E(DisplayControlsE2E):
    # The app's own measurement map is config/ohif.js:529 {ArrowAnnotate, Length, Angle,
    # EllipticalROI}; this superset also covers the remaining annotation tools the pinned
    # OHIF toolbar can place. It is only used to say what a user is *expected* to draw.
    DRAWN_TOOLS = ('ArrowAnnotate', 'Length', 'Angle', 'Bidirectional', 'RectangleROI',
                   'EllipticalROI', 'CircleROI', 'Probe')
    # Overlays the pane derives from its own geometry, which legitimately follow a resize.
    # This is the only list that removes anything from the comparison, so a tool neither
    # list knows about is held to the user-work contract instead of being filtered away.
    DERIVED_TOOLS = ('ReferenceLines', 'Crosshairs', 'ScaleOverlay', 'ReferenceCursors', 'AdvancedMagnify')

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
        # Everything that is not an explicitly pane-derived overlay, sorted so a rebuilt
        # viewport cannot change the comparison by reordering the store.
        return page.evaluate("""derived=>cornerstoneTools.annotation.state.getAllAnnotations()
            .filter(a=>!derived.includes(a.metadata.toolName))
            .map(a=>({toolName:a.metadata.toolName,metadata:a.metadata,points:a.data?.handles?.points??null,text:a.data?.text??null}))
            .sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:1)""", list(self.DERIVED_TOOLS))

    def annotation_tools(self, page):
        return page.evaluate("()=>[...new Set(cornerstoneTools.annotation.state.getAllAnnotations().map(a=>a.metadata.toolName))].sort()")

    def select_annotation_tool(self, page):
        # Selected once for the whole case: the tool stays active between drawings, and
        # re-opening the split button would make the exact-text match ambiguous with the
        # toolbar button that now carries the same label.
        page.locator('[data-cy="MeasurementTools-split-button-secondary"]').click()
        page.get_by_text('Annotation', exact=True).click()

    def draw_annotation(self, page, index, label):
        box = page.locator('[data-cy=viewport-grid] > div').nth(index).locator('canvas').bounding_box()
        x, y = box['x'] + box['width'] * .5, box['y'] + box['height'] * .5
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 45, y + 28, steps=8); page.mouse.up()
        entry = page.get_by_placeholder('Enter label'); expect(entry).to_be_visible()
        entry.press_sequentially(label)
        page.get_by_role('button', name='Save', exact=True).click()
        page.wait_for_timeout(200)

    def gesture_on(self, page, tool, viewport_id, dx, dy):
        # The parent helper always drags the first pane; a merged cell is addressed by id.
        page.locator(f'[data-cy="{tool}"]').click()
        box = self.pane_of(page, viewport_id)
        x, y = box['x'] + box['width'] * .5, box['y'] + box['height'] * .5
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + dx, y + dy, steps=12); page.mouse.up()
        page.wait_for_timeout(200)

    def focus_pane(self, page, viewport_id):
        box = self.pane_of(page, viewport_id)
        page.mouse.click(box['x'] + box['width'] * .5, box['y'] + box['height'] * .3)
        page.wait_for_timeout(120)

    def merge_button(self, page, action):
        return page.locator(f'#kin-cell-merge [data-cell-merge="{action}"]')

    def pane_box(self, page, index=0):
        return page.locator('[data-cy=viewport-grid] > div').nth(index).bounding_box()

    def pane_of(self, page, viewport_id):
        # Pane order in the DOM is not part of the contract; the viewport id is.
        return page.locator(f'[data-cy=viewport-grid] > div:has([data-viewport-uid="{viewport_id}"])').bounding_box()

    def click_pane(self, page, index):
        # An empty cell has no canvas, so the pane element itself is the target.
        box = page.locator('[data-cy=viewport-grid] > div').nth(index).bounding_box()
        page.mouse.click(box['x'] + box['width'] * .5, box['y'] + box['height'] * .5)

    def dblclick_pane(self, page, index):
        box = page.locator('[data-cy=viewport-grid] > div').nth(index).locator('canvas').bounding_box()
        page.mouse.dblclick(box['x'] + box['width'] * .5, box['y'] + box['height'] * .35)

    def test_cell_merge_01_double_click_maximizes_one_cell_and_returns_the_prior_grid(self):
        fixture, page = self.quad()
        originals = self.originals(); rows = self.report_rows(fixture)
        before_geometry = self.geometry(page); before = self.snap(page)
        grid_box = page.locator('[data-cy=viewport-grid]').bounding_box()
        quarter = self.pane_of(page, before[0]['id'])
        self.dblclick_pane(page, 0)
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('확대했습니다', timeout=30000)
        page.wait_for_function('()=>services.viewportGridService.getState().viewports.size===1', timeout=30000)
        merged = self.geometry(page)
        self.assertEqual([[before[0]['id'], 0, 0, 1, 1, before[0]['sets']]], merged)
        # The pane really spans the whole grid; native pane padding keeps it a few
        # pixels inside the container, so the claim is proportional, not pixel-exact.
        box = self.pane_of(page, before[0]['id'])
        self.assertGreater(box['width'], grid_box['width'] * .99)
        self.assertGreater(box['height'], grid_box['height'] * .99)
        self.assertGreater(box['width'], quarter['width'] * 1.9)
        self.assertGreater(box['height'], quarter['height'] * 1.9)
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
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('병합했습니다', timeout=30000)
        page.wait_for_function('()=>services.viewportGridService.getState().viewports.size===3', timeout=30000)
        merged = self.geometry(page)
        self.assertEqual([before[0]['id'], 0, 0, .5, 1], merged[0][:5])
        self.assertEqual([0.5, 0, .5, .5], merged[1][1:5])
        self.assertEqual([0.5, .5, .5, .5], merged[2][1:5])
        # The anchor pane really is a full-height half, not just a state entry.
        grid_box = page.locator('[data-cy=viewport-grid]').bounding_box()
        anchor, neighbour = self.pane_of(page, merged[0][0]), self.pane_of(page, merged[1][0])
        self.assertGreater(anchor['height'], grid_box['height'] * .99)
        self.assertGreater(anchor['height'], neighbour['height'] * 1.9)
        self.assertAlmostEqual(anchor['width'] / grid_box['width'], .5, delta=.02)
        kept = self.snap(page)
        self.assertEqual([item['id'] for item in before], [item['id'] for item in kept])
        for old, item in zip(before, kept):
            self.assertEqual(old['image'], item['image']); self.assertEqual(old['sets'], item['sets'])
        expect(self.merge_button(page, 'maximize')).to_be_disabled()
        # The anchor pane changed shape, so whatever sits in its camera now is the merge's
        # own refit. The user scrolls and windows that merged cell but never touches zoom.
        anchor = before[0]['id']
        self.focus_pane(page, anchor)
        page.keyboard.press('ArrowDown'); page.wait_for_timeout(250)
        self.gesture_on(page, 'WindowLevel', anchor, 60, 30)
        worked = self.snap(page)
        self.assertNotEqual(before[0]['index'], worked[0]['index'])
        self.assertNotEqual(before[0]['properties']['voiRange'], worked[0]['properties']['voiRange'])
        self.merge_button(page, 'restore').click()
        page.wait_for_function('()=>services.viewportGridService.getState().viewports.size===4', timeout=30000)
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('되돌렸습니다')
        self.assertEqual(before_geometry, self.geometry(page))
        restored = self.snap(page)
        # Each field on its own: the slice and window the user moved come back as they left
        # them, and the zoom they never touched is owed the pre-merge value rather than the
        # refit that was sitting in it.
        self.assertEqual(worked[0]['image'], restored[0]['image'])
        self.assertEqual(worked[0]['index'], restored[0]['index'])
        self.assertEqual(worked[0]['properties'], restored[0]['properties'])
        # The zoom nobody touched is owed the pre-merge value, while where the camera sits
        # follows the slice the user scrolled to: a stack scroll moves focalPoint and
        # position along the normal, so those are not evidence of a zoom.
        self.assertEqual(before[0]['camera']['parallelScale'], restored[0]['camera']['parallelScale'])
        self.assertNotEqual(before[0]['camera']['parallelScale'], kept[0]['camera']['parallelScale'])
        self.assertEqual(worked[0]['camera']['focalPoint'], restored[0]['camera']['focalPoint'])
        self.assertEqual(worked[0]['camera']['position'], restored[0]['camera']['position'])
        for field in ('viewUp', 'viewPlaneNormal', 'flipHorizontal', 'flipVertical', 'rotation'):
            self.assertEqual(before[0]['camera'][field], restored[0]['camera'][field])
        # The surviving cell kept its own quadrant and is untouched throughout.
        self.assertEqual(before[1]['camera'], restored[1]['camera'])
        self.assertEqual(before[1]['properties'], restored[1]['properties'])
        self.assertEqual(before[1]['image'], restored[1]['image'])
        # A zoom the user really did make in the merged cell is theirs and must survive.
        self.merge_button(page, 'merge-column').click()
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('병합했습니다', timeout=30000)
        page.wait_for_function('()=>services.viewportGridService.getState().viewports.size===3', timeout=30000)
        self.gesture_on(page, 'Zoom', anchor, 0, 60)
        zoomed = self.snap(page)
        self.assertNotEqual(restored[0]['camera']['parallelScale'], zoomed[0]['camera']['parallelScale'])
        self.merge_button(page, 'restore').click()
        page.wait_for_function('()=>services.viewportGridService.getState().viewports.size===4', timeout=30000)
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('되돌렸습니다')
        self.assertEqual(before_geometry, self.geometry(page))
        self.assertEqual(zoomed[0]['camera']['parallelScale'], self.snap(page)[0]['camera']['parallelScale'])
        print('CELL-MERGE column ' + json.dumps({'before': before_geometry, 'merged': merged,
            'anchor_camera': {'pre_merge': before[0]['camera'], 'while_merged': kept[0]['camera'],
                              'after_restore': restored[0]['camera'], 'user_zoom': zoomed[0]['camera']}}), flush=True)
        self.assertEqual(originals, self.originals())

    def test_cell_merge_03_measurements_reports_and_save_refusal_survive_a_merge(self):
        fixture, page = self.quad()
        self.seed_report(fixture)
        values = dict(findings='Cell merge draft', conclusion='', recommendation='')
        self.assertEqual(200, self.stack.request('PUT', f'/studies/{fixture.uid}/report', 'doctor', dict(values, baseVersion=1)).status)
        self.assertEqual(201, self.stack.request('POST', f'/studies/{fixture.uid}/hold', 'doctor').status)
        originals = self.originals(); rows = self.report_rows(fixture)
        # The measurement goes in the cell the maximize destroys and rebuilds, which is the
        # case the shipped evidence did not cover. The surviving cell is never torn down, so
        # a displaced viewport is the harder of the two claims.
        annotated = self.snap(page)[1]['id']
        self.choose(page, 1)
        self.select_annotation_tool(page)
        self.draw_annotation(page, 1, 'CM12345')
        drawn = self.annotations(page)
        self.assertEqual(1, len(drawn))
        # Classification is enumerated rather than assumed: every tool actually present is
        # either one a user draws with or one pinned as pane-derived. An unknown tool fails
        # here instead of being silently dropped from the comparison above.
        tools = self.annotation_tools(page)
        self.assertEqual([], [name for name in tools if name not in self.DRAWN_TOOLS + self.DERIVED_TOOLS])
        self.assertIn('ArrowAnnotate', tools)
        # Leave the annotation tool before selecting the other cell, so activating it cannot
        # begin a drawing, and maximize the cell that carries no measurement.
        page.locator('[data-cy="Pan"]').click()
        self.choose(page, 0)
        # A drawn measurement must not block the enlargement the clinician asked for.
        self.merge_button(page, 'maximize').click()
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('확대했습니다', timeout=30000)
        page.wait_for_function('()=>services.viewportGridService.getState().viewports.size===1', timeout=30000)
        # The annotated viewport is not the one left on screen, so its measurement survived
        # a real destroy and rebuild rather than merely surviving a resize.
        self.assertEqual(1, len(self.geometry(page)))
        self.assertNotEqual(annotated, self.geometry(page)[0][0])
        self.assertEqual(drawn, self.annotations(page))
        # The merged screen keeps the existing persistence refusal, unchanged.
        save = page.get_by_role('button', name='Save Recent Layout', exact=True)
        expect(save).to_be_enabled(); save.click()
        # config/ohif.js:1479 already refuses a grid whose cell count is not rows*cols.
        expect(page.locator('#kin-viewer-layout-status')).to_contain_text('1·2·4화면의 일반 CT 배치만 저장할 수 있습니다')
        self.assertEqual(1, page.evaluate('services.viewportGridService.getState().viewports.size'))
        self.merge_button(page, 'restore').click()
        page.wait_for_function('()=>services.viewportGridService.getState().viewports.size===4', timeout=30000)
        self.assertEqual(drawn, self.annotations(page))
        self.assertEqual(tools, self.annotation_tools(page))
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
        self.click_pane(page, 2)
        self.merge_button(page, 'maximize').click()
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('영상이 표시된')
        self.assertEqual(before_geometry, self.geometry(page))
        self.choose(page, 0)
        # Land a real but different rectangle set instead of swallowing the request: the
        # panes genuinely resize, so the native refit happens exactly as it would on a
        # successful merge, while the achieved geometry is not the one that was asked for.
        # The rollback therefore owes the recorded state, never the refit it just caused.
        page.evaluate('''()=>{const grid=services.viewportGridService,original=grid.setLayout;
          window.restoreCellMergeLayout=()=>{grid.setLayout=original;};
          let once=true;grid.setLayout=function(payload){
            if(once&&payload.layoutOptions&&payload.layoutOptions.length===3){once=false;
              return original.call(this,{...payload,layoutOptions:[{x:0,y:0,width:1,height:.5},{x:0,y:.5,width:.5,height:.5},{x:.5,y:.5,width:.5,height:.5}]});}
            return original.call(this,payload);};}''')
        try:
            self.merge_button(page, 'merge-column').click()
            expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('복구했습니다', timeout=60000)
        finally:
            page.evaluate('restoreCellMergeLayout()')
        self.assertEqual(before_geometry, self.geometry(page))
        for old, item in zip(before, self.snap(page)):
            self.assertEqual(old['image'], item['image']); self.assertEqual(old['camera'], item['camera'])
            self.assertEqual(old['properties'], item['properties'])
        # No merge record survived the rollback, and the panel is usable rather than locked.
        expect(self.merge_button(page, 'restore')).to_be_disabled()
        expect(self.merge_button(page, 'maximize')).to_be_enabled()
        # The panel still works afterwards: recovery is not a permanent lock.
        self.merge_button(page, 'maximize').click()
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('확대했습니다', timeout=30000)
        page.wait_for_function('()=>services.viewportGridService.getState().viewports.size===1', timeout=30000)
        self.merge_button(page, 'restore').click()
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('되돌렸습니다', timeout=30000)
        page.wait_for_function('()=>services.viewportGridService.getState().viewports.size===4', timeout=30000)
        self.assertEqual(before_geometry, self.geometry(page))
        self.assertEqual(rows, self.report_rows(fixture)); self.assertEqual(originals, self.originals())


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ViewerCellMergeE2E(name) for name in ViewerCellMergeE2E.__dict__ if name.startswith('test_cell_merge_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
