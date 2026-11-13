# coding: utf-8
"""Display Set Presets on the served viewer with owned synthetic CT: per-cell windowing saved with the applied Hanging
Protocol comes back on each cell when that protocol is applied again; GSPS auto puts a stored presentation state's
window, rotation and annotation on the cell; a display filter changes the picture but not a measurement."""
import datetime
import io
import uuid

from playwright.sync_api import expect
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

from test_hanging_protocol import HangingProtocolE2E
from test_prior_selection import canvas_ready, synthetic_ct
from viewer_tools import select_image_tool

GSPS_CLASS = '1.2.840.10008.5.1.4.1.1.11.1'
RULE_ID = '77777777-7777-4777-8777-777777777777'

# Each cell in grid order: its window as W/L, turn, image, filter and this module's marks and annotation lines.
CELLS = """() => [...services.viewportGridService.getState().viewports.values()].sort((a, b) => a.y - b.y || a.x - b.x).map(g => {
  const v = services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId), pane = v.element.closest('[data-cy=viewport-pane]') || v.element.parentElement;
  const range = v.getProperties().voiRange, wl = range && cornerstone.utilities.windowLevel.toWindowLevel(range.lower, range.upper);
  return { id: g.viewportId, w: wl ? wl.windowWidth : null, l: wl ? wl.windowCenter : null,
    rotation: Math.round(((v.getViewPresentation().rotation % 360) + 360) % 360), image: v.getCurrentImageId(),
    filter: v.element.querySelector('canvas')?.style.filter || '',
    marks: [...pane.querySelectorAll('.kin-view-marks>span')].map(n => n.textContent),
    lines: pane.querySelectorAll('.kin-view-gsps polyline').length }; })"""
PRESET = """name => { const p = services.customizationService.get('cornerstone.windowLevelPresets').presets.CT.find(p => p.description === name);
  return { w: Number(p.window), l: Number(p.level) }; }"""


class DisplaySetPresetsE2E(HangingProtocolE2E):
    def ct(self, patient, label, date):
        return synthetic_ct(self.stack, patient, label, date, slices=4)

    def put(self, ds):
        stream = io.BytesIO(); ds.save_as(stream, write_like_original=False)
        self.assertEqual(200, self.stack._orthanc_request('POST', '/instances', stream.getvalue()).status)

    def two_cells(self):
        """One rule: the current CT series in both cells of a 1 × 2 grid."""
        value = self.library(name='Synthetic Two Cells')
        rule = value['rules'][0]
        rule.update(id=RULE_ID, selectors=[rule['selectors'][0]], layout={'rows': 1, 'cols': 2, 'cells': ['Current', 'Current']})
        value['activeRuleId'] = RULE_ID
        return value

    def settle(self, p):
        p.evaluate('() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200))))')

    def presets(self, p):
        dialog = p.locator('dialog.kin-ux-settings')
        if not dialog.evaluate('n => n.open'):
            p.get_by_role('button', name='Viewer Settings').click()
        dialog.get_by_role('button', name='Display Set Presets…').click()
        panel = p.locator('dialog.kin-ux-feature-panel[aria-label="Display Set Presets"]')
        expect(panel).to_be_visible()
        return panel

    def close(self, p, panel):
        panel.get_by_role('button', name='Close').click()
        dialog = p.locator('dialog.kin-ux-settings')
        dialog.get_by_role('button', name='Cancel').click(); expect(dialog).to_be_hidden()

    def cells_now(self, p):
        return p.evaluate(CELLS)

    def test_presets_01_cell_windows_saved_with_the_hanging_protocol_come_back_per_cell(self):
        f = self.ct('DSP-HP-' + uuid.uuid4().hex[:12], 'current', '20260801')
        p = self.launch(self.login(), [f])
        self.import_rules(p, self.two_cells())
        p.locator('#kin-hp-apply').click(); expect(p.locator('#kin-hp-status')).to_contain_text('Applied', timeout=45000)
        canvas_ready(p, 2); self.settle(p)
        stock = self.cells_now(p)
        panel = self.presets(p)
        expect(panel.locator('tr td:first-child')).to_have_text(['Set 1', 'Set 2'])
        panel.get_by_label('Set 1 Windowing').select_option(label='Soft tissue')
        panel.get_by_label('Set 2 Windowing').select_option(label='Lung')
        save = panel.get_by_role('button', name='Save with Hanging Protocol')
        expect(save).to_be_enabled(); save.click()
        expect(panel.get_by_role('status')).to_contain_text('Saved with Hanging Protocol "Synthetic Two Cells"')
        self.close(p, panel)
        # Save keeps the rules; the cells are as they were until the protocol is applied.
        self.assertEqual([(c['w'], c['l']) for c in stock], [(c['w'], c['l']) for c in self.cells_now(p)])
        soft, lung = p.evaluate(PRESET, 'Soft tissue'), p.evaluate(PRESET, 'Lung')
        # Another layout, then the protocol again: each cell gets its own window.
        self.grid(p, 1)
        expect(p.locator('#kin-hp-applied')).to_have_text('Applied Protocol: None')
        self.open_layout_tools(p)
        p.locator('#kin-hp-apply').click(); expect(p.locator('#kin-hp-status')).to_contain_text('Applied', timeout=45000)
        canvas_ready(p, 2)
        p.wait_for_function("""([a, b]) => { const cells = (""" + CELLS + """)();
          return cells.length === 2 && Math.abs(cells[0].w - a.w) <= 1 && Math.abs(cells[0].l - a.l) <= 1
            && Math.abs(cells[1].w - b.w) <= 1 && Math.abs(cells[1].l - b.l) <= 1; }""", arg=[soft, lung], timeout=30000)
        cells = self.cells_now(p)
        print('DISPLAY-SET-PRESETS cells after re-apply ' + repr(cells), flush=True)
        # The window shows each cell's rule.
        panel = self.presets(p)
        expect(panel.get_by_label('Set 1 Windowing')).to_have_value('["Soft tissue",%s,%s]' % (self.number(soft['w']), self.number(soft['l'])))
        expect(panel.get_by_label('Set 2 Windowing')).to_have_value('["Lung",%s,%s]' % (self.number(lung['w']), self.number(lung['l'])))
        self.close(p, panel)

    @staticmethod
    def number(value):
        return str(int(value)) if float(value).is_integer() else str(value)

    def test_presets_02_gsps_auto_applies_the_stored_window_rotation_and_annotation(self):
        f = self.ct('DSP-GSPS-' + uuid.uuid4().hex[:12], 'current', '20260801')
        p = self.launch(self.login(), [f])
        images = p.evaluate("""() => { const g = [...services.viewportGridService.getState().viewports.values()][0];
          const v = services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);
          return v.getImageIds().map(id => { const m = cornerstone.metaData.get('instance', id); return { sop: m.SOPInstanceUID, cls: m.SOPClassUID, series: m.SeriesInstanceUID }; }); }""")
        # A GSPS for every image of the series: W 350 / L 50, a 90° turn, a polyline and a text.
        meta = FileMetaDataset(); sop = generate_uid()
        meta.TransferSyntaxUID = ExplicitVRLittleEndian; meta.MediaStorageSOPClassUID = GSPS_CLASS
        meta.MediaStorageSOPInstanceUID = sop; meta.ImplementationClassUID = generate_uid()
        ds = Dataset(); ds.file_meta = meta; ds.is_little_endian, ds.is_implicit_VR = True, False
        ds.SOPClassUID, ds.SOPInstanceUID, ds.Modality = GSPS_CLASS, sop, 'PR'
        ds.PatientName, ds.PatientID = 'D03A^SYNTHETIC', f.patient_id
        ds.StudyInstanceUID, ds.SeriesInstanceUID = f.uid, generate_uid()
        ds.StudyDate = '20260801'; ds.StudyTime = '120000'; ds.SeriesNumber, ds.InstanceNumber = 90, 1
        ds.ContentLabel, ds.ContentDescription = 'SYNGSPS', 'Synthetic presentation state'
        now = datetime.datetime.now()
        ds.PresentationCreationDate, ds.PresentationCreationTime = now.strftime('%Y%m%d'), now.strftime('%H%M%S')
        series = Dataset(); series.SeriesInstanceUID = images[0]['series']
        refs = []
        for image in images:
            ref = Dataset(); ref.ReferencedSOPClassUID, ref.ReferencedSOPInstanceUID = image['cls'], image['sop']; refs.append(ref)
        series.ReferencedImageSequence = refs; ds.ReferencedSeriesSequence = [series]
        voi = Dataset(); voi.WindowCenter, voi.WindowWidth = 50, 350; ds.SoftcopyVOILUTSequence = [voi]
        ds.PresentationLUTShape = 'IDENTITY'; ds.ImageRotation = 90; ds.ImageHorizontalFlip = 'N'
        layer = Dataset(); layer.GraphicLayer, layer.GraphicLayerOrder = 'SYN', 1; ds.GraphicLayerSequence = [layer]
        graphic = Dataset(); graphic.GraphicAnnotationUnits = 'PIXEL'; graphic.GraphicDimensions = 2; graphic.NumberOfGraphicPoints = 3
        graphic.GraphicData = [40.0, 40.0, 200.0, 40.0, 200.0, 200.0]; graphic.GraphicType = 'POLYLINE'; graphic.GraphicFilled = 'N'
        text = Dataset(); text.AnchorPointAnnotationUnits = 'PIXEL'; text.AnchorPoint = [40.0, 30.0]; text.AnchorPointVisibility = 'N'
        text.UnformattedTextValue = 'SYN NOTE'
        note = Dataset(); note.GraphicLayer = 'SYN'; note.GraphicObjectSequence = [graphic]; note.TextObjectSequence = [text]
        ds.GraphicAnnotationSequence = [note]
        self.put(ds)
        panel = self.presets(p)
        panel.get_by_label('Set 1 Windowing').select_option(label='Lung')
        panel.get_by_label('Set 1 GSPS auto').select_option(label='On')
        panel.get_by_role('button', name='Apply to This Study').click()
        expect(panel.get_by_role('status')).to_have_text('Applied to 1 cell.', timeout=30000)
        self.close(p, panel); self.settle(p)
        cell = self.cells_now(p)[0]
        print('DISPLAY-SET-PRESETS gsps cell ' + repr(cell), flush=True)
        # The presentation state's window wins over the row's Lung, and its turn is put on the cell.
        self.assertAlmostEqual(350, cell['w'], delta=1); self.assertAlmostEqual(50, cell['l'], delta=1)
        self.assertEqual(90, cell['rotation'])
        self.assertEqual(['GSPS: SYNGSPS'], cell['marks'])
        self.assertEqual(1, cell['lines'])
        expect(p.locator('.kin-view-gsps text')).to_have_text(['SYN NOTE'])

    def test_presets_03_a_filter_changes_the_picture_not_the_measurement(self):
        f = self.ct('DSP-FILTER-' + uuid.uuid4().hex[:12], 'current', '20260801')
        p = self.launch(self.login(), [f])
        self.settle(p)
        select_image_tool(p, 'EllipticalROI')
        box = p.locator('.cornerstone-canvas').first.bounding_box()
        x, y = box['x'] + box['width'] * .4, box['y'] + box['height'] * .4
        p.mouse.move(x, y); p.mouse.down(); p.mouse.move(x + 60, y + 40, steps=10); p.mouse.up()
        p.wait_for_timeout(350)
        stats = """() => { const a = cornerstoneTools.annotation.state.getAllAnnotations().find(a => a.metadata.toolName === 'EllipticalROI');
          return a && !a.invalidated && Object.keys(a.data.cachedStats || {}).length ? JSON.stringify(Object.values(a.data.cachedStats)[0]) : null; }"""
        p.wait_for_function(stats)
        before = p.evaluate(stats)
        pane = p.locator('[data-cy=viewport-pane]').first
        picture = pane.locator('.cornerstone-canvas').screenshot()
        panel = self.presets(p)
        panel.get_by_label('Set 1 Filter').select_option(label='Sharpen')
        panel.get_by_role('button', name='Apply to This Study').click()
        expect(panel.get_by_role('status')).to_have_text('Applied to 1 cell.')
        self.close(p, panel); self.settle(p)
        cell = self.cells_now(p)[0]
        self.assertEqual('url("#kin-image-filter-sharpen")', cell['filter']); self.assertEqual(['Filter: Sharpen'], cell['marks'])
        self.assertNotEqual(picture, pane.locator('.cornerstone-canvas').screenshot(), 'the picture is sharpened')
        # The measurement is worked out again on the filtered cell: the same values, from the original pixels.
        p.evaluate("""() => { const a = cornerstoneTools.annotation.state.getAllAnnotations().find(a => a.metadata.toolName === 'EllipticalROI');
          const g = [...services.viewportGridService.getState().viewports.values()].sort((x, y) => x.y - y.y || x.x - y.x)[0];
          a.invalidated = true; services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId).render(); }""")
        p.wait_for_timeout(350)
        p.wait_for_function(stats)
        self.assertEqual(before, p.evaluate(stats))
