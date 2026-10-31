"""Minhoon items 2/3/6: native gestures on served OHIF and owned synthetic DICOM."""
import io
import json
import os
import math
import time
import unittest
import uuid
from pathlib import Path

from pydicom import dcmread
from pydicom.dataset import Dataset
from pydicom.uid import generate_uid, ExplicitVRLittleEndian
from pynetdicom import AE
from playwright.sync_api import expect
from invariants_live import Fixture
from test_viewer_history import ViewerHistoryE2E
from viewer_precision_fixture import synthetic_ct
from viewer_tools import select_image_tool
from test_display_controls import DisplayControlsE2E
from test_volume_preferences import VolumePreferencesE2E
from test_prior_selection import canvas_ready, synthetic_ct as stack_ct
import numpy as np


class ViewerToolsE2E(ViewerHistoryE2E):
    def open_tools_viewer(self, fixture):
        work = self.login('doctor'); page = work.context.new_page()
        page.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + fixture.uid)
        try:
            # MG can have empty contralateral cells. Read the rendered source
            # boundary rather than requiring every cell to contain a canvas.
            page.wait_for_function('''uid => window.cornerstone?.getRenderingEngines().some(engine =>
                engine.id !== '_thumbnails' && engine.getViewports().some(v =>
                    v.type === 'stack' && v.viewportStatus === cornerstone.Enums.ViewportStatus.RENDERED &&
                    cornerstone.metaData.get('instance',v.getCurrentImageId())?.StudyInstanceUID === uid))''',
                arg=fixture.uid, timeout=60000)
            box = page.evaluate('''uid => {
                const v=cornerstone.getRenderingEngines().filter(e => e.id !== '_thumbnails')
                    .flatMap(e => e.getViewports()).find(v => v.type === 'stack' && v.getCurrentImageId?.() &&
                        cornerstone.metaData.get('instance',v.getCurrentImageId())?.StudyInstanceUID === uid);
                return v.element.querySelector('canvas').getBoundingClientRect().toJSON();
            }''', fixture.uid)
            page.mouse.click(box['x'] + box['width']/2, box['y'] + box['height']/2)
            self.open_measurement_tools(page)
            expect(page.locator('#kin-viewer-history [role=status]')).to_contain_text('개 저장 항목')
            return work, page
        except Exception:
            folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/viewer-tools')); folder.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(folder / (fixture.uid + '-open.png')))
            print('VIEWER open failure ' + json.dumps(page.evaluate('''() => ({
                text:document.body.innerText,
                views:(window.cornerstone?.getRenderingEngines() || []).filter(e => e.id !== '_thumbnails')
                    .flatMap(e => e.getViewports()).map(v => ({id:v.id,type:v.type,image:v.getCurrentImageId?.(),status:v.viewportStatus}))
                })''')), flush=True)
            page.close(); work.close()
            raise

    def source_dicom(self, fixture):
        found = self.stack._orthanc_request('POST', '/tools/lookup', fixture.uid.encode()).body
        study = next(x['ID'] for x in found if x['Type'] == 'Study')
        instance = self.stack._orthanc_request('GET', '/studies/' + study + '/instances').body[0]['ID']
        return dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/' + instance + '/file')))

    def modality_fixture(self, modality):
        source = synthetic_ct(self.stack, 'VTOOLS-' + uuid.uuid4().hex[:12], modality,
                              '20261028', [0, 0, 0], [1, 0, 0, 0, 1, 0], [.7, 1.3], slices=1)
        if modality == 'CT':
            return source
        ds = self.source_dicom(source)
        classes = {'MG': '1.2.840.10008.5.1.4.1.1.1.2', 'XA': '1.2.840.10008.5.1.4.1.1.12.1',
                   'MR': '1.2.840.10008.5.1.4.1.1.4', 'CR': '1.2.840.10008.5.1.4.1.1.1',
                   'DX': '1.2.840.10008.5.1.4.1.1.1.1', 'US': '1.2.840.10008.5.1.4.1.1.6.1'}
        ds.StudyInstanceUID = generate_uid(); ds.SeriesInstanceUID = generate_uid(); ds.SOPInstanceUID = generate_uid()
        ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
        ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID = classes[modality]
        ds.Modality = modality; ds.SeriesDescription = 'VTOOLS ' + modality
        for name in ['RescaleType', 'RescaleSlope', 'RescaleIntercept']:
            delattr(ds, name)
        ds.WindowCenter = 500; ds.WindowWidth = 1000
        if modality == 'MG':
            ds.ImageLaterality = 'R'; ds.ViewPosition = 'CC'; ds.PresentationIntentType = 'FOR PRESENTATION'
            ds.ImageType = ['ORIGINAL', 'PRIMARY']
            view = Dataset(); view.CodingSchemeDesignator = 'SCT'
            view.CodeValue = '399162004'; view.CodeMeaning = 'cranio-caudal'
            ds.ViewCodeSequence = [view]
        if modality == 'XA':
            ds.NumberOfFrames = 3; ds.FrameTime = 100; ds.PixelData *= 3
        fixture = Fixture(ds.StudyInstanceUID, source.patient_id, source.institution, source.owner_user, 'VTOOLS ' + modality)
        self.stack.active[fixture.uid] = fixture
        ae = AE(ae_title='HALLYM_CT'); ae.add_requested_context(ds.SOPClassUID, ExplicitVRLittleEndian)
        association = ae.associate('127.0.0.1', 4242, ae_title='KINLAB')
        self.assertTrue(association.is_established)
        try:
            self.assertEqual(association.send_c_store(ds).Status, 0)
        finally:
            association.release()
        # C-STORE precedes Orthanc's worklist ingestion, as in synthetic_ct.
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            result = self.stack.request('GET', '/studies', 'jmryu')
            if result.status == 200 and any(s.get('uid') == fixture.uid for s in result.body.get('studies', [])):
                break
            time.sleep(.25)
        else:
            self.fail('Synthetic ' + modality + ' did not reach the real API')
        self.assertEqual(self.stack.request('PATCH', '/studies/' + fixture.uid, 'jmryu', {'ss': 'Verified'}).status, 200)
        return fixture

    def ellipse(self, page):
        page.wait_for_function('''() => cornerstoneTools.annotation.state.getAllAnnotations().some(a =>
            a.metadata.toolName === 'EllipticalROI' && !a.invalidated && Object.values(a.data.cachedStats).some(s => s.area > 0))''')
        return page.evaluate('''() => { const a = cornerstoneTools.annotation.state.getAllAnnotations().find(a => a.metadata.toolName === 'EllipticalROI');
            const v = cornerstone.getRenderingEngines().filter(e => e.id !== '_thumbnails').flatMap(e => e.getViewports())
                .find(v => v.type === 'stack' && v.getCurrentImageId() === a.metadata.referencedImageId);
            const rect = v.element.getBoundingClientRect();
            return { points:a.data.handles.points, stats:Object.values(a.data.cachedStats)[0],
                imagePoints:a.data.handles.points.map(point => Array.from(v.getImageData().imageData.worldToIndex(point))),
                canvas:a.data.handles.points.map(point => { const p = v.worldToCanvas(point); return [p[0] + rect.x, p[1] + rect.y]; }) }; }''')

    def check_values(self, page, fixture, modality):
        annotation = self.ellipse(page)
        ds = self.source_dicom(fixture)
        # Keep fractional handle coordinates: voxel-index rounding changes the ROI.
        # Image coordinates identify the reader's handles; DICOM supplies the
        # physical spacing independently of the renderer's chosen world scale.
        bottom, top, left, right = np.array(annotation['imagePoints']) * [float(ds.PixelSpacing[1]), float(ds.PixelSpacing[0]), 1]
        ru, rv = np.linalg.norm(right - left) / 2, np.linalg.norm(bottom - top) / 2
        annotation['area'] = math.pi * ru * rv
        if modality == 'CT':
            self.assertAlmostEqual(annotation['stats']['area'], annotation['area'], delta=.01)
            center = (bottom + top + left + right) / 4
            yy, xx = np.mgrid[:int(ds.Rows), :int(ds.Columns)]
            world = np.stack([xx * float(ds.PixelSpacing[1]), yy * float(ds.PixelSpacing[0]), np.zeros_like(xx)], axis=-1)
            d = world - center
            mask = (d @ ((right-left) / (2*ru)) / ru)**2 + (d @ ((bottom-top) / (2*rv)) / rv)**2 <= 1
            values = ds.pixel_array[mask].astype(float) * float(ds.RescaleSlope) + float(ds.RescaleIntercept)
            self.assertAlmostEqual(annotation['stats']['mean'], values.mean(), places=5)
            self.assertAlmostEqual(annotation['stats']['stdDev'], values.std(), places=5)
            expect(page.locator('svg.svg-layer').filter(has_text='SD:').first).to_be_visible()
        else:
            label = page.locator('svg.svg-layer').filter(has_text=f"{annotation['area']:.1f} mm²").first
            expect(label).to_be_visible()
            expect(label).not_to_contain_text('HU')
        return annotation

    def drag_point(self, page, point, dx, dy):
        page.mouse.move(*point); page.mouse.down()
        page.mouse.move(point[0] + dx, point[1] + dy, steps=10); page.mouse.up()

    def test_tools_ellipse_modalities(self):
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/viewer-tools'))
        folder.mkdir(parents=True, exist_ok=True)
        for modality in ['CT', 'MG', 'XA', 'MR', 'CR', 'DX', 'US']:
            with self.subTest(modality=modality):
                fixture = self.modality_fixture(modality)
                work, page = self.open_tools_viewer(fixture)
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                try:
                    select_image_tool(page, 'EllipticalROI')
                    box = page.evaluate('''() => services.cornerstoneViewportService.getCornerstoneViewport(
                        services.viewportGridService.getActiveViewportId()).element.querySelector('canvas').getBoundingClientRect().toJSON()''')
                    x, y = box['x'] + box['width'] * .43, box['y'] + box['height'] * .43
                    page.mouse.move(x, y); page.mouse.down()
                    page.mouse.move(x + 65, y + 32, steps=10); page.mouse.up()
                    row = page.locator('#kin-viewer-history section[data-kind=ellipse]')
                    expect(row).to_have_count(1)
                    created = self.check_values(page, fixture, modality)
                    row.get_by_role('button', name='Save', exact=True).click()
                    expect(row).to_contain_text('저장 완료')
                    self.assertEqual(self.saved(fixture)[0]['item']['kind'], 'ellipse')
                    self.assertAlmostEqual(self.saved(fixture)[0]['item']['baseline']['values'][0], created['area'], delta=.01)
                    row.get_by_role('button', name='Edit', exact=True).click()
                    before = self.ellipse(page)
                    self.drag_point(page, before['canvas'][3], 20, 0)
                    page.wait_for_function('before => JSON.stringify(cornerstoneTools.annotation.state.getAllAnnotations().find(a => a.metadata.toolName === "EllipticalROI").data.handles.points) !== JSON.stringify(before)', arg=before['points'])
                    resized = self.check_values(page, fixture, modality)
                    self.assertNotEqual(resized['points'], before['points'])
                    # Move from the ellipse boundary between handles, as a reader does.
                    bottom, top, left, right = np.array(resized['canvas'])
                    edge = ((bottom + top + left + right)/4 + (right-left)/2/math.sqrt(2) + (bottom-top)/2/math.sqrt(2)).tolist()
                    self.drag_point(page, edge, 15, 10)
                    page.wait_for_function('before => JSON.stringify(cornerstoneTools.annotation.state.getAllAnnotations().find(a => a.metadata.toolName === "EllipticalROI").data.handles.points) !== JSON.stringify(before)', arg=resized['points'])
                    moved = self.check_values(page, fixture, modality)
                    self.assertAlmostEqual(moved['area'], resized['area'], places=5)
                    row.get_by_label('Annotation Text').fill('VTOOLS ' + modality)
                    row.get_by_role('button', name='Save', exact=True).click()
                    expect(row).to_contain_text('Saved r2')
                    self.assertAlmostEqual(self.saved(fixture)[0]['item']['baseline']['values'][0], moved['area'], delta=.01)
                    page.screenshot(path=str(folder / (modality + '-edited.png')))
                    page.close(); work.close()
                    work, page = self.open_tools_viewer(fixture)
                    reopened = self.check_values(page, fixture, modality)
                    self.assertEqual(reopened['points'], moved['points'])
                    row = page.locator('#kin-viewer-history section[data-kind=ellipse]')
                    page.once('dialog', lambda dialog: dialog.accept('synthetic removal'))
                    row.get_by_role('button', name='Hide', exact=True).click()
                    expect(row).to_contain_text('Hidden')
                    self.assertFalse(page.evaluate('''() => cornerstoneTools.annotation.state.getAllAnnotations().some(a => a.metadata.toolName === 'EllipticalROI')'''))
                    row.get_by_role('button', name='History', exact=True).click()
                    expect(row).to_contain_text('synthetic removal')
                finally:
                    state = page.evaluate('''() => ({annotations:cornerstoneTools.annotation.state.getAllAnnotations(),
                        history:document.querySelector('#kin-viewer-history')?.textContent,
                        groups:cornerstoneTools.ToolGroupManager.getAllToolGroups().map(g=>({id:g.id, options:g.toolOptions}))})''')
                    (folder / (modality + '.json')).write_text(json.dumps({'study': fixture.uid, 'errors': errors, 'state': state}, indent=2), encoding='utf-8')
                    page.screenshot(path=str(folder / (modality + '.png')))
                    page.close(); work.close()


class ViewerStackControlsE2E(DisplayControlsE2E):
    def cell_view(self, page, index):
        page.wait_for_function('''index => {const cell=[...services.viewportGridService.getState().viewports.values()][index];
            const v=services.cornerstoneViewportService.getCornerstoneViewport(cell.viewportId);
            return v?.getCornerstoneImage?.()?.imageId === v?.getCurrentImageId?.() && v?.viewportStatus === cornerstone.Enums.ViewportStatus.RENDERED;}''', arg=index)
        page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        return page.evaluate('''index => {const cell=[...services.viewportGridService.getState().viewports.values()][index];
            const v=services.cornerstoneViewportService.getCornerstoneViewport(cell.viewportId),canvas=v.element.querySelector('canvas');
            const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
            let hash=2166136261;for(let n=0;n<pixels.length;n+=4)hash=Math.imul(hash^pixels[n],16777619)>>>0;
            return {image:v.getCurrentImageId(),camera:v.getCamera(),properties:v.getProperties(),canvasHash:hash};}''', index)

    def test_tools_stack_mouse(self):
        # Use the standard stack fixture so opposite gestures stay away from
        # its endpoints rather than testing an out-of-range scroll request.
        fixture = stack_ct(self.stack, 'MOUSE-' + uuid.uuid4().hex[:12], 'mouse', '20261028')
        self.exercise_stack_mouse(fixture)

    def test_tools_stack_mouse_short_stack(self):
        # Keep the original failing four-frame input as a regression boundary.
        fixture = self.ct('MOUSE-SHORT-' + uuid.uuid4().hex[:12], 'mouse-short', '20261028')
        self.exercise_stack_mouse(fixture)

    def exercise_stack_mouse(self, fixture):
        page = self.launch(self.login(), [fixture])
        canvas_ready(page, 1)
        page.wait_for_function('() => !!window.kinViewerStackMouse')
        box = page.locator('.cornerstone-canvas').first.bounding_box()
        x, y = box['x'] + box['width']*.5, box['y'] + box['height']*.5
        def gesture(button, dx, dy):
            page.mouse.move(x,y); page.mouse.down(button=button)
            page.mouse.move(x+dx,y+dy,steps=12); page.mouse.up(button=button)
            print('MOUSE gesture ' + json.dumps({'button': button, 'dx': dx, 'dy': dy,
                'viewport': page.evaluate('''() => {
                    const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());
                    const group=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(v.id,v.renderingEngineId);
                    return {index:v.getCurrentImageIdIndex(),count:v.getImageIds().length,primary:group.getActivePrimaryMouseButtonTool()};
                }''')}), flush=True)
        before = self.display(page)[0]
        gesture('left', 0, 100)
        page.wait_for_function('before => services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId()).getCurrentImageId() !== before', arg=before['image'])
        scrolled = self.display(page)[0]
        self.assertEqual(scrolled['properties']['voiRange'], before['properties']['voiRange'])
        gesture('right', 35, 20)
        page.wait_for_function('before => JSON.stringify(services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId()).getProperties().voiRange) !== JSON.stringify(before)', arg=before['properties']['voiRange'])
        self.assertEqual(self.display(page)[0]['image'], scrolled['image'])
        select_image_tool(page, 'Zoom'); zoom_before = self.display(page)[0]
        gesture('left', 0, 35)
        page.wait_for_function('before => services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId()).getCamera().parallelScale !== before', arg=zoom_before['camera']['parallelScale'])
        self.assertEqual(self.display(page)[0]['image'], zoom_before['image'])
        select_image_tool(page, 'Zoom')
        zoom_after = self.display(page)[0]
        print('MOUSE deselected ' + json.dumps(page.evaluate('''() => {
            const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());
            const group=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(v.id,v.renderingEngineId);
            return {index:v.getCurrentImageIdIndex(),count:v.getImageIds().length,primary:group.getActivePrimaryMouseButtonTool()};
        }''')), flush=True)
        # The native tool accumulates pixel motion across gestures. Traverse
        # half the actual canvas so this checks tool selection without
        # imposing a fixed pixel sensitivity on the native scroll tool.
        gesture('left', 0, -box['height']/2)
        try:
            page.wait_for_function('before => services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId()).getCurrentImageId() !== before', arg=zoom_after['image'])
        except Exception:
            print('MOUSE native scroll ' + json.dumps(page.evaluate('''() => {
                const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());
                const tool=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(v.id,v.renderingEngineId).getToolInstance('StackScroll');
                return {index:v.getCurrentImageIdIndex(),height:v.element.clientHeight,deltaY:tool.deltaY,
                    configuration:tool.configuration};
            }''')), flush=True)
            raise
        self.assertEqual(self.display(page)[0]['camera']['parallelScale'], zoom_after['camera']['parallelScale'])
        before_wheel = self.display(page)[0]
        page.mouse.move(x,y); page.mouse.wheel(0,100)
        page.wait_for_function('before => services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId()).getCurrentImageId() !== before', arg=before_wheel['image'])

    def test_tools_compare_strip_drop(self):
        self.compare_strip(True)

    def test_tools_compare_click_retry(self):
        self.compare_strip(False)

    def compare_strip(self, use_drop):
        fixture = self.multiple('DROP-' + uuid.uuid4().hex[:12], 'drop', '20261028')
        page = self.launch(self.login(), [fixture]); self.grid(page, 2)
        strip = page.get_by_role('region', name='Series', exact=True)
        cards = strip.locator('button.kin-series-card')
        expect(cards).to_have_count(2)
        # The native hanging protocol may fill both cells automatically. Use
        # its real grid boundary to establish a vacant comparison cell while
        # keeping the source strip, then exercise the reader's mouse actions.
        page.evaluate('''() => services.viewportGridService.setDisplaySetsForViewport({
            viewportId:[...services.viewportGridService.getState().viewports.keys()][1],
            displaySetInstanceUIDs:[]})''')
        page.wait_for_function('''() => {
            const cell=[...services.viewportGridService.getState().viewports.values()][1];
            const v=services.cornerstoneViewportService.getCornerstoneViewport(cell.viewportId);
            return !cell.displaySetInstanceUIDs.length && (!v?.element?.isConnected || !v.getCurrentImageId?.());
        }''')
        cells = page.locator('[data-cy=viewport-pane]')
        before = self.cell_view(page, 0)
        description = page.evaluate('image => cornerstone.metaData.get("instance",image).SeriesDescription', before['image'])
        # Metadata requests can finish in either order. Choose the other
        # visible series by its identity, not its arrival position in the strip.
        series_cards = [cards.filter(has_text=description), cards.filter(has_not_text=description)]
        for card in series_cards:
            expect(card).to_have_count(1)
        first_images = page.evaluate('''() => services.cornerstoneViewportService.getCornerstoneViewport(
            [...services.viewportGridService.getState().viewports.keys()][0]).getImageIds()''')
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/viewer-tools')); folder.mkdir(parents=True, exist_ok=True)
        def assign(card, cell):
            if use_drop:
                series_cards[card].locator('.kin-series-preview').drag_to(page.locator('[data-cy=viewport-grid] > div').nth(cell))
            else:
                box = cells.nth(cell).bounding_box()
                page.mouse.click(box['x'] + box['width']/2, box['y'] + box['height']/2)
                page.wait_for_function('index => services.viewportGridService.getState().activeViewportId === [...services.viewportGridService.getState().viewports.keys()][index]', arg=cell)
                series_cards[card].click()
        if use_drop:
            def feedback(cell):
                expect(cell).to_be_visible()
                value = cell.evaluate('''el => { const s = getComputedStyle(el, '::after');
                    return {text:s.content, color:s.color, background:s.backgroundColor,
                        visible:s.display !== 'none' && s.visibility === 'visible' && Number(s.opacity) > 0 && parseFloat(s.fontSize) > 0}; }''')
                self.assertIn('Drop Series', value['text'])
                self.assertTrue(value['visible'])
                self.assertNotEqual(value['color'], value['background'])
                return value
            # Grab the thumbnail, the card's picture handle: in headless Chromium a press on the card's text
            # dispatches dragstart but no dragover (main and V-SPACE alike), and the compact card centres on text.
            card_box, cell_box = series_cards[1].locator('.kin-series-preview').bounding_box(), cells.nth(1).bounding_box()
            page.mouse.move(card_box['x'] + card_box['width']/2, card_box['y'] + card_box['height']/2)
            page.mouse.down()
            page.mouse.move(cell_box['x'] + cell_box['width']/2, cell_box['y'] + cell_box['height']/2, steps=15)
            hovered, available = feedback(cells.nth(1)), feedback(cells.nth(0))
            self.assertNotEqual(hovered, available, 'the hovered drop target is visually distinct')
            page.screenshot(path=str(folder/'compare-drag-feedback.png'))
            page.mouse.move(card_box['x'] + card_box['width']/2, card_box['y'] + card_box['height']/2, steps=15)
            self.assertEqual(feedback(cells.nth(1)), available)
            page.mouse.move(cell_box['x'] + cell_box['width']/2, cell_box['y'] + cell_box['height']/2, steps=15)
            self.assertEqual(feedback(cells.nth(1)), hovered)
            page.mouse.up()
        else:
            assign(1, 1)
        canvas_ready(page, 2)
        page.wait_for_function('''() => {const cells=[...services.viewportGridService.getState().viewports.values()];
            return cells.every(c=>services.cornerstoneViewportService.getCornerstoneViewport(c.viewportId)?.getCurrentImageId?.()) && cells[0].displaySetInstanceUIDs[0] !== cells[1].displaySetInstanceUIDs[0];}''')
        self.assertEqual(self.cell_view(page, 0), before)
        right = self.cell_view(page, 1)
        assign(1, 0)
        page.wait_for_function('''() => {const cells=[...services.viewportGridService.getState().viewports.values()];
            return services.cornerstoneViewportService.getCornerstoneViewport(cells[0].viewportId)?.getCurrentImageId?.() === services.cornerstoneViewportService.getCornerstoneViewport(cells[1].viewportId)?.getCurrentImageId?.();}''')
        self.assertEqual(self.cell_view(page, 1), right)
        # Fail a real frame request after releasing only this fixture's cached
        # first series. The other cell's rendered image and camera must survive.
        page.evaluate('''images => {for (const id of images) if (cornerstone.cache.getImageLoadObject(id))
            cornerstone.cache.removeImageLoadObject(id);}''', first_images)
        failed = []
        pattern = '**/dicom-web/**/frames/**'
        def unavailable(route):
            failed.append(route.request.url); route.fulfill(status=503, body='synthetic frame unavailable')
        page.route(pattern, unavailable)
        assign(0, 0)
        expect(cells.nth(0).get_by_role('button', name='Retry', exact=True)).to_be_visible()
        self.assertTrue(failed)
        self.assertEqual(self.cell_view(page, 1), right)
        page.screenshot(path=str(folder/('compare-load-failed-' + str(use_drop) + '.png')))
        page.unroute(pattern, unavailable)
        cells.nth(0).get_by_role('button', name='Retry', exact=True).click()
        page.wait_for_function('image => services.cornerstoneViewportService.getCornerstoneViewport([...services.viewportGridService.getState().viewports.keys()][0]).getCurrentImageId() === image', arg=before['image'])
        expect(cells.nth(0).get_by_role('button', name='Retry', exact=True)).to_have_count(0)
        self.assertEqual(self.cell_view(page, 1), right)
        self.assertEqual(self.cell_view(page, 0)['canvasHash'], before['canvasHash'])
        page.screenshot(path=str(folder/('compare-retried-' + str(use_drop) + '.png')))


class ViewerMprMouseE2E(VolumePreferencesE2E):
    def test_tools_mpr_defaults_unchanged(self):
        fixture, work, page = self.starting()
        bindings = page.evaluate('''() => {
            const group = cornerstoneTools.ToolGroupManager.getToolGroupForViewport(projectionVP.id, projectionVP.renderingEngineId);
            return Object.fromEntries(['WindowLevel','Pan','Zoom'].map(name => [name,group.getToolOptions(name).bindings])); }''')
        for name, button in [('WindowLevel', 1), ('Pan', 4), ('Zoom', 2)]:
            self.assertIn({'mouseButton': button}, bindings[name])
        box = page.locator('.cornerstone-viewport-element').first.bounding_box()
        x, y = box['x'] + box['width']*.5, box['y'] + box['height']*.5
        def gesture(button, dx, dy):
            page.mouse.move(x,y); page.mouse.down(button=button)
            page.mouse.move(x+dx,y+dy,steps=8); page.mouse.up(button=button)
        before = page.evaluate('() => projectionVP.getProperties().voiRange')
        gesture('left',35,15)
        page.wait_for_function('old => JSON.stringify(projectionVP.getProperties().voiRange) !== JSON.stringify(old)', arg=before)
        before = page.evaluate('() => projectionVP.getCamera().focalPoint')
        gesture('middle',20,10)
        page.wait_for_function('old => JSON.stringify(projectionVP.getCamera().focalPoint) !== JSON.stringify(old)', arg=before)
        before = page.evaluate('() => projectionVP.getZoom()')
        gesture('right',0,35)
        page.wait_for_function('old => projectionVP.getZoom() !== old', arg=before)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(cls(name) for cls in [ViewerToolsE2E, ViewerStackControlsE2E, ViewerMprMouseE2E]
                              for name in loader.getTestCaseNames(cls) if name.startswith('test_tools_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
