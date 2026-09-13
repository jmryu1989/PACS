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
        # The shape is the mirrored column merge, which hands the second pane the
        # half-width/full-height rectangle the anchor gets in case 02 - the one change this
        # native really does refit for. A row shape was used here before and asserted
        # nothing: it only ever made a pane wider at the same height, which leaves
        # parallelScale untouched, so this case never exercised a refit at all
        # (run 34725673641, samples all 140.25000000000003).
        # While that deviating layout is on screen the zoom of the reshaped panes is sampled,
        # so the rollback below is not proven against a screen that never refitted at all.
        page.evaluate('''()=>{const grid=services.viewportGridService,original=grid.setLayout;
          window.restoreCellMergeLayout=()=>{grid.setLayout=original;};
          window.kinCellMergeRefit=[];
          const sample=()=>{try{window.kinCellMergeRefit.push([...grid.getState().viewports.values()].map(v=>{
            const c=services.cornerstoneViewportService.getCornerstoneViewport(v.viewportId);
            return [v.viewportId,c&&c.getCamera?c.getCamera().parallelScale:null];}));}
            catch(error){window.kinCellMergeRefit.push([['error',String(error)]]);}};
          let once=true;grid.setLayout=function(payload){
            if(once&&payload.layoutOptions&&payload.layoutOptions.length===3){once=false;
              return Promise.resolve(original.call(this,{...payload,layoutOptions:[{x:0,y:0,width:.5,height:.5},{x:.5,y:0,width:.5,height:1},{x:0,y:.5,width:.5,height:.5}]}))
                .then(value=>{for(const delay of [150,400,800,1500])setTimeout(sample,delay);return value;});}
            return original.call(this,payload);};}''')
        try:
            self.merge_button(page, 'merge-column').click()
            expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('복구했습니다', timeout=60000)
        finally:
            page.evaluate('restoreCellMergeLayout()')
        self.assertEqual(before_geometry, self.geometry(page))
        # The panes really did resize and refit, so restoring the recorded zoom below is a
        # real undo and not a comparison of two identical screens.
        samples = page.evaluate('()=>window.kinCellMergeRefit||[]')
        scales = {item['id']: item['camera']['parallelScale'] for item in before}
        moved = [(viewport, scale) for sample in samples for viewport, scale in sample
                 if viewport in scales and scale is not None and scale != scales[viewport]]
        self.assertTrue(moved, 'no pane refitted while the deviating layout was on screen: %r vs %r' % (samples, scales))
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


    # --- MPR plane cells -----------------------------------------------------------------
    # The same double click, on the orthographic planes the viewer's own MPR button builds
    # over the approved synthetic CT volume. Nothing here is a second renderer: the planes
    # are opened through the app, and every claim is read back off the native volume
    # viewport (type, volume id, SOP list, camera, window, slab, blend mode).

    def mpr_screen(self):
        from test_volume_projection import phantom
        fixture = phantom(self.stack)
        self.seed_report(fixture)
        page = self.launch(self.login(), [fixture])
        page.locator('[data-cy=Layout]').click()
        page.locator('#react-portal').get_by_text('MPR', exact=True).click()
        page.wait_for_function("""()=>{const g=services.viewportGridService.getState();
          return g.viewports.size===3&&[...g.viewports.keys()].every(id=>{
            const v=services.cornerstoneViewportService.getCornerstoneViewport(id);
            return v?.type==='orthographic'&&cornerstone.cache.getVolume(v.getVolumeId())?.loadStatus.loaded})}""",
                               timeout=90000)
        # The initial MPR canvas is rounded up and a queued native resize follows it; every
        # camera below is compared only after that resize has actually landed.
        page.wait_for_function("""()=>[...services.viewportGridService.getState().viewports.keys()].every(id=>{
          const c=services.cornerstoneViewportService.getCornerstoneViewport(id).element.querySelector('canvas');
          return c.width===Math.floor(c.clientWidth*devicePixelRatio)&&c.height===Math.floor(c.clientHeight*devicePixelRatio)})""",
                               timeout=60000)
        self.open_layout_tools(page)
        expect(page.locator('#kin-cell-merge')).to_be_visible(timeout=45000)
        page.wait_for_timeout(300)
        return fixture, page

    def plane_state(self, page):
        return page.evaluate('''()=>[...services.viewportGridService.getState().viewports.values()]
          .sort((a,b)=>a.y-b.y||a.x-b.x).map(g=>{
            const v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);
            const plane=v?.type==='orthographic';
            const volume=plane?cornerstone.cache.getVolume(v.getVolumeId()):null;
            const properties=v?.getProperties?.()||null;
            return {id:g.viewportId,sets:g.displaySetInstanceUIDs||[],type:v?.type||null,
              rect:[g.x,g.y,g.width,g.height],orientation:g.viewportOptions?.orientation??null,
              volumeId:plane?v.getVolumeId():null,loaded:!!volume?.loadStatus?.loaded,
              framesLoaded:volume?.framesLoaded??null,
              sops:volume?volume.imageIds.map(id=>cornerstone.metaData.get('instance',id).SOPInstanceUID):null,
              camera:v?.getCamera?.()||null,voiRange:properties?.voiRange??null,
              lut:properties?.VOILUTFunction??null,invert:properties?.invert??null,
              interpolation:properties?.interpolationType??null,
              blend:plane?v.getActors()[0].actor.getMapper().getBlendMode():null,
              thickness:v?.getSlabThickness?.()??null};
          })''')

    @staticmethod
    def dominant_axis(normal):
        return max(range(3), key=lambda index: abs(normal[index]))

    def pane_index(self, page, viewport_id):
        # Pane order in the DOM is not part of the contract, so the index the gesture helpers
        # need is derived from the viewport id rather than assumed to match the sorted order.
        panes = page.locator('[data-cy=viewport-grid] > div')
        for index in range(panes.count()):
            if panes.nth(index).locator(f'[data-viewport-uid="{viewport_id}"]').count():
                return index
        raise AssertionError('no pane carries viewport ' + viewport_id)

    def test_cell_merge_05_double_click_maximizes_an_mpr_plane_and_returns_every_plane(self):
        fixture, page = self.mpr_screen()
        originals = self.originals(); rows = self.report_rows(fixture)
        before_geometry = self.geometry(page); before = self.plane_state(page)
        self.assertEqual(3, len(before))
        # Three orthographic planes over one and the same fully loaded volume.
        for cell in before:
            self.assertEqual('orthographic', cell['type'])
            self.assertTrue(cell['loaded'])
            self.assertEqual(33, len(cell['sops']))
            self.assertEqual(len(cell['sops']), cell['framesLoaded'])
            self.assertEqual(before[0]['volumeId'], cell['volumeId'], 'three planes, one volume')
            self.assertEqual(sorted(before[0]['sops']), sorted(cell['sops']))
        # Each plane really stands on its own anatomical axis, and the three are distinct.
        # Only the axis is asserted, not its sign: native orientation presets differ in sign
        # between versions while an oblique camera misses the axis entirely.
        axes = []
        for cell in before:
            normal = cell['camera']['viewPlaneNormal']
            axis = self.dominant_axis(normal); axes.append(axis)
            for index, value in enumerate(normal):
                self.assertAlmostEqual(abs(value), 1.0 if index == axis else 0.0, delta=1e-6)
        self.assertEqual({0, 1, 2}, set(axes), 'axial, sagittal and coronal, one each')

        # Give the plane that will be enlarged a window and a slab of its own, and the plane
        # that will be destroyed a measurement, so both claims below are about real state.
        anchor_index, displaced_index = 1, 2
        anchor = before[anchor_index]['id']; displaced = before[displaced_index]['id']
        self.focus_pane(page, anchor)
        self.gesture_on(page, 'WindowLevel', anchor, 70, 35)
        self.focus_pane(page, displaced)
        self.select_annotation_tool(page)
        self.draw_annotation(page, self.pane_index(page, displaced), 'MPR12345')
        drawn = self.annotations(page)
        self.assertEqual(1, len(drawn))
        tools = self.annotation_tools(page)
        self.assertEqual([], [name for name in tools if name not in self.DRAWN_TOOLS + self.DERIVED_TOOLS])
        self.assertIn('ArrowAnnotate', tools)
        page.locator('[data-cy="Pan"]').click()
        windowed = self.plane_state(page)
        self.assertNotEqual(before[anchor_index]['voiRange'], windowed[anchor_index]['voiRange'])

        grid_box = page.locator('[data-cy=viewport-grid]').bounding_box()
        third = self.pane_of(page, anchor)
        self.dblclick_pane(page, self.pane_index(page, anchor))
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('확대했습니다', timeout=60000)
        page.wait_for_function('()=>services.viewportGridService.getState().viewports.size===1', timeout=30000)
        merged = self.plane_state(page)
        self.assertEqual([[anchor, 0, 0, 1, 1, before[anchor_index]['sets']]], self.geometry(page))
        # The pane really spans the whole grid; native pane padding keeps it a few pixels
        # inside the container, so the claim is proportional, not pixel-exact.
        box = self.pane_of(page, anchor)
        self.assertGreater(box['width'], grid_box['width'] * .99)
        self.assertGreater(box['width'], third['width'] * 2.9)
        # Enlarged, it is still the same plane of the same volume, with the window, the slab
        # and the projection mode it had - not a rebuilt default.
        self.assertEqual('orthographic', merged[0]['type'])
        self.assertEqual(before[anchor_index]['volumeId'], merged[0]['volumeId'])
        self.assertEqual(before[anchor_index]['sops'], merged[0]['sops'])
        self.assertEqual(axes[anchor_index], self.dominant_axis(merged[0]['camera']['viewPlaneNormal']))
        self.assertEqual(windowed[anchor_index]['voiRange'], merged[0]['voiRange'])
        self.assertEqual(windowed[anchor_index]['blend'], merged[0]['blend'])
        self.assertAlmostEqual(windowed[anchor_index]['thickness'], merged[0]['thickness'], delta=1e-6)
        self.assertEqual(windowed[anchor_index]['interpolation'], merged[0]['interpolation'])
        # The measurement drawn on the plane this maximize destroyed is not on screen at all.
        self.assertNotIn(displaced, [row[0] for row in self.geometry(page)])
        self.assertEqual(drawn, self.annotations(page))
        # The merged plane screen keeps the existing persistence refusal, unchanged: a grid
        # whose cell count is not rows*cols is still refused by config/ohif.js:1479, which
        # this unit never touches. Merged plane geometry is not saved by anything.
        save = page.get_by_role('button', name='Save Recent Layout', exact=True)
        expect(save).to_be_enabled(); save.click()
        expect(page.locator('#kin-viewer-layout-status')).to_contain_text('1·2·4화면의 일반 CT 배치만 저장할 수 있습니다')
        self.assertEqual(1, page.evaluate('services.viewportGridService.getState().viewports.size'))
        # The clinician moves the enlarged plane while they read it.
        self.gesture_on(page, 'Pan', anchor, 55, 30)
        worked = self.plane_state(page)
        self.assertNotEqual(merged[0]['camera']['focalPoint'], worked[0]['camera']['focalPoint'])
        self.shot(page, 'cell-merge-mpr-plane')
        print('CELL-MERGE mpr-plane ' + json.dumps({'before': before_geometry, 'merged': self.geometry(page),
            'anchor': {'pre': windowed[anchor_index], 'while_maximized': merged[0], 'user_pan': worked[0]}}), flush=True)

        self.dblclick_pane(page, 0)
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('되돌렸습니다', timeout=60000)
        page.wait_for_function('()=>services.viewportGridService.getState().viewports.size===3', timeout=30000)
        self.assertEqual(before_geometry, self.geometry(page))
        after = self.plane_state(page)
        for index, (old, cell) in enumerate(zip(windowed, after)):
            self.assertEqual(old['id'], cell['id'])
            self.assertEqual('orthographic', cell['type'], 'a plane comes back a plane, never a stack')
            self.assertEqual(old['sets'], cell['sets'])
            self.assertEqual(old['volumeId'], cell['volumeId'], 'the original volume, not a new one')
            self.assertEqual(old['sops'], cell['sops'], 'the same originals in the same order')
            self.assertTrue(cell['loaded'])
            self.assertEqual(axes[index], self.dominant_axis(cell['camera']['viewPlaneNormal']))
            self.assertEqual(old['voiRange'], cell['voiRange'])
            self.assertEqual(old['lut'], cell['lut']); self.assertEqual(old['invert'], cell['invert'])
            self.assertEqual(old['interpolation'], cell['interpolation'])
            self.assertEqual(old['blend'], cell['blend'])
            self.assertAlmostEqual(old['thickness'], cell['thickness'], delta=1e-6)
        # The two planes the maximize destroyed come back on the camera they were left with:
        # rebuilding one plane makes the MPR tool group reset every linked plane, and the
        # held callback is what keeps that reset off the screen the user is owed.
        for index in (0, 2):
            self.assertEqual(windowed[index]['camera'], after[index]['camera'])
        # The pan the user made while it was enlarged is theirs and survives; the zoom they
        # never touched is owed the value from before the merge.
        self.assertEqual(worked[0]['camera']['focalPoint'], after[anchor_index]['camera']['focalPoint'])
        self.assertEqual(worked[0]['camera']['position'], after[anchor_index]['camera']['position'])
        self.assertEqual(windowed[anchor_index]['camera']['parallelScale'], after[anchor_index]['camera']['parallelScale'])
        for field in ('viewUp', 'viewPlaneNormal', 'flipHorizontal', 'flipVertical'):
            self.assertEqual(windowed[anchor_index]['camera'][field], after[anchor_index]['camera'][field])
        # The measurement on the displaced plane survived a real destroy and rebuild.
        self.assertEqual(drawn, self.annotations(page))
        self.assertEqual(tools, self.annotation_tools(page))
        self.assertEqual(rows, self.report_rows(fixture)); self.assertEqual(originals, self.originals())


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ViewerCellMergeE2E(name) for name in ViewerCellMergeE2E.__dict__ if name.startswith('test_cell_merge_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
