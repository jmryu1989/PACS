# coding: utf-8
"""Display menu on the served viewer with owned synthetic images: overlay items with Image Text, Corner Information,
Zoom and Smart Zoom, My W/L Presets across a reopened viewer, Auto Rotate 180° from Image Orientation (Patient), and a
stored VOI LUT (a table and a SIGMOID function) turned on and off with the real pixels compared."""
import io
import json
import unittest
import uuid

import numpy as np
from playwright.sync_api import expect
from pydicom import dcmread
from pydicom.dataset import Dataset
from pydicom.uid import generate_uid

from test_display_controls import DisplayControlsE2E
from test_prior_selection import canvas_ready
from viewer_tools import select_image_tool, display_transform

MENU = ['Overlay Items…', 'Corner Information…', 'Auto Rotate 180°', 'Zoom…', 'Smart Zoom', 'My W/L Presets…', 'VOI LUT']
TITLES = dict(zip(MENU, ['Overlay Items', 'Corner Information', 'Auto Rotate 180°', 'Zoom', 'Smart Zoom', 'My W/L Presets', 'VOI LUT']))
CR_IMAGE = '1.2.840.10008.5.1.4.1.1.1'

# The first cell: its viewport, pane, OHIF's corner text and this module's text.
CELL = """()=>{const g=[...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x)[0];
  const v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId),pane=v.element.closest('[data-cy=viewport-pane]')||v.element.parentElement;
  const shown=n=>!!n&&getComputedStyle(n).display!=='none'&&getComputedStyle(n).visibility!=='hidden'&&!!n.getClientRects().length;
  const wl=pane.querySelector('[data-cy="viewport-overlay-bottom-left"]>div:first-child'),text=pane.querySelector('.kin-display-text');
  return {id:v.id,image:v.getCurrentImageId(),zoom:v.getZoom(),rotation:Math.round(((v.getViewPresentation().rotation%360)+360)%360),camera:v.getCamera(),
    wl:shown(wl),wlText:wl?.textContent||'',stockTopLeft:shown(pane.querySelector('[data-cy="viewport-overlay-top-left"]')),
    layer:text?getComputedStyle(text).visibility:null,zoomLine:pane.querySelector('.kin-display-zoom')?.textContent||null,
    ruler:pane.querySelector('.kin-display-ruler')?{text:pane.querySelector('.kin-display-ruler').textContent,height:pane.querySelector('.kin-display-ruler').getBoundingClientRect().height}:null,
    corners:Object.fromEntries([...pane.querySelectorAll('.kin-display-corner')].map(n=>[n.dataset.corner,n.textContent])),
    badges:[...pane.querySelectorAll('.kin-display-badges>span')].map(n=>n.textContent)};}"""

# Gray values drawn at two image pixels of the first cell (left and right half of the synthetic radiograph).
SAMPLES = """()=>{const g=[...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x)[0];
  const v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId),c=v.element.querySelector('canvas'),ctx=c.getContext('2d');
  const data=v.getImageData().imageData,scale=c.width/c.clientWidth;
  return [[64,128],[192,128]].map(([x,y])=>{const p=v.worldToCanvas(data.indexToWorld([x,y,0]));
    return ctx.getImageData(Math.round(p[0]*scale),Math.round(p[1]*scale),1,1).data[0];});}"""


class ViewerDisplayMenuE2E(DisplayControlsE2E):
    def put(self, ds):
        stream = io.BytesIO(); ds.save_as(stream, write_like_original=False)
        self.assertEqual(self.stack._orthanc_request('POST', '/instances', stream.getvalue()).status, 200)

    def copy(self, f, label, number):
        ds = next(d for d in (dcmread(io.BytesIO(self.stack.orthanc_bytes(path))) for path in self.originals()) if d.Modality == 'CT')
        ds.PatientID = f.patient_id; ds.StudyInstanceUID = f.uid; ds.SeriesInstanceUID = generate_uid(); ds.SOPInstanceUID = generate_uid()
        ds.SeriesDescription = label; ds.SeriesNumber = number; ds.InstanceNumber = 1
        ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
        return ds

    def upside_down(self, f, label):
        """One CT slice stored with both row and column directions reversed (a 180° turn in the axial plane)."""
        ds = self.copy(f, label, 40)
        ds.ImageOrientationPatient = [-1, 0, 0, 0, -1, 0]
        self.put(ds)
        return dict(study=f.uid, series=str(ds.SeriesInstanceUID), sops=[str(ds.SOPInstanceUID)], label=label)

    def radiograph(self, f, label, number, voi):
        """A 12-bit CR: left half 1300, right half 2600, with the given VOI attributes."""
        ds = self.copy(f, label, number)
        ds.SOPClassUID = ds.file_meta.MediaStorageSOPClassUID = CR_IMAGE; ds.Modality = 'CR'
        for name in ('RescaleIntercept', 'RescaleSlope', 'RescaleType', 'SliceLocation', 'SliceThickness', 'SpacingBetweenSlices', 'ImageType'):
            if name in ds: delattr(ds, name)
        ds.Rows = ds.Columns = 256; ds.BitsAllocated = 16; ds.BitsStored = 12; ds.HighBit = 11; ds.PixelRepresentation = 0
        pixels = np.zeros((256, 256), dtype=np.uint16); pixels[:, :128] = 1300; pixels[:, 128:] = 2600
        ds.PixelData = pixels.tobytes()
        voi(ds)
        self.put(ds)
        return dict(study=f.uid, series=str(ds.SeriesInstanceUID), sops=[str(ds.SOPInstanceUID)], label=label)

    @staticmethod
    def table(ds):
        # A 16-bit table that runs from white to black: the opposite of the stored window.
        ds.WindowCenter, ds.WindowWidth = 2048, 4096
        item = Dataset()
        item.add_new(0x00283002, 'US', [4096, 0, 16])
        item.add_new(0x00283006, 'US', [65535 - i * 16 for i in range(4096)])
        ds.VOILUTSequence = [item]

    @staticmethod
    def sigmoid(ds):
        ds.WindowCenter, ds.WindowWidth, ds.VOILUTFunction = 2048, 1000, 'SIGMOID'

    def cell(self, p):
        return p.evaluate(CELL)

    def menu(self, p, item):
        p.get_by_role('button', name='Display ▾').click()
        p.get_by_role('menu', name='Display').get_by_role('menuitem', name=item, exact=True).click()
        panel = p.locator('section.kin-ux-feature-panel[role=dialog][aria-label="%s"]' % TITLES[item])
        expect(panel).to_be_visible()
        return panel

    def settle(self, p):
        p.evaluate('() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150))))')

    def open_viewer(self, f, refs=()):
        p = self.launch(self.login(), [f])
        expect(p.get_by_role('button', name='Display ▾')).to_be_visible(timeout=45000)
        for ref in refs:
            self.drag(p, ref['label'], 0)
            p.wait_for_function('sop=>{const g=[...services.viewportGridService.getState().viewports.values()][0];'
                                'return (services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId)?.getCurrentImageId?.()||"").includes(sop)}',
                                arg=ref['sops'][0], timeout=60000)
            canvas_ready(p, 1)
        self.settle(p)
        return p

    def test_menu_01_overlay_corners_zoom_smart_zoom_and_presets(self):
        f = self.ct('DISPLAYMENU-' + uuid.uuid4().hex[:12], 'current', '20260801')
        p = self.open_viewer(f)
        p.get_by_role('button', name='Display ▾').click()
        # Display also carries the Auto Save View window last (its own feature, its own e2e); this test owns the seven above.
        expect(p.get_by_role('menu', name='Display').get_by_role('menuitem')).to_have_text(MENU + ['Auto Save View…'])
        p.keyboard.press('Escape')
        start = self.cell(p)
        self.assertTrue(start['wl']); self.assertEqual('Zoom 100%', start['zoomLine'])

        # 03-1: items one by one; the ruler is 5 cm of this image at this zoom.
        panel = self.menu(p, 'Overlay Items…')
        panel.get_by_role('checkbox', name='W/L Value').uncheck()
        panel.get_by_role('checkbox', name='Ruler').check(); self.settle(p)
        now = self.cell(p)
        self.assertFalse(now['wl']); self.assertEqual('5 cm', now['ruler']['text'])
        expected = p.evaluate("""()=>{const g=[...services.viewportGridService.getState().viewports.values()][0],v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);
          const c=v.getCamera(),a=c.focalPoint,b=a.map((n,i)=>n+c.viewUp[i]*50),p=v.worldToCanvas(a),q=v.worldToCanvas(b);return Math.hypot(p[0]-q[0],p[1]-q[1]);}""")
        self.assertAlmostEqual(expected, now['ruler']['height'], delta=2)
        panel.get_by_role('checkbox', name='Ruler').focus(); p.keyboard.press('Escape')
        expect(panel).to_have_count(0)
        # Image Text hides this text with OHIF's; showing it again brings back each item as chosen.
        self.open_layout_tools(p)
        toggle = p.locator('#kin-image-text-toggle')
        expect(toggle).to_be_enabled(); toggle.click(); expect(toggle).to_have_text('Show Image Text'); self.settle(p)
        self.assertEqual('hidden', self.cell(p)['layer'])
        toggle.click(); expect(toggle).to_have_text('Hide Image Text'); self.settle(p)
        now = self.cell(p)
        self.assertEqual('visible', now['layer']); self.assertFalse(now['wl']); self.assertIsNotNone(now['ruler'])
        panel = self.menu(p, 'Overlay Items…')
        panel.get_by_role('checkbox', name='W/L Value').check(); panel.get_by_role('checkbox', name='Ruler').uncheck()
        panel.get_by_role('button', name='Close').click()

        # 03-2: a corner item for CT, saved and drawn instead of the usual corner text; W/L stays.
        panel = self.menu(p, 'Corner Information…')
        expect(panel.get_by_label('Modality')).to_have_value('CT')
        panel.get_by_label('Top Right line 1').select_option(label='Slice Thickness')
        panel.get_by_role('button', name='Apply to Image').click()
        expect(panel.get_by_role('status')).to_have_text('Saved to your account.')
        self.settle(p)
        now = self.cell(p)
        # The image's own value as DICOM stores it (2 or 2.0), with its unit.
        self.assertRegex(now['corners'].get('TR') or '', r'^SliceThickness: 2(\.0+)? mm$'); self.assertFalse(now['stockTopLeft']); self.assertTrue(now['wl'])
        p.keyboard.press('Escape')

        # 03-5: buttons, typed zoom and Fit, with the number on the image.
        panel = self.menu(p, 'Zoom…')
        panel.get_by_role('button', name='200%', exact=True).click(); self.settle(p)
        now = self.cell(p); self.assertAlmostEqual(2, now['zoom'], places=3); self.assertEqual('Zoom 200%', now['zoomLine'])
        panel.get_by_label('Zoom percent').fill('150'); panel.get_by_role('button', name='Apply').click(); self.settle(p)
        self.assertAlmostEqual(1.5, self.cell(p)['zoom'], places=3)
        panel.get_by_role('button', name='Fit').click(); self.settle(p)
        self.assertAlmostEqual(1, self.cell(p)['zoom'], places=3)
        p.keyboard.press('Escape'); expect(panel).to_have_count(0)

        # 03-6: the clicked point stays under the pointer, twice as large; Escape ends the clicks.
        panel = self.menu(p, 'Smart Zoom')
        box = p.locator('[data-cy=viewport-grid] > div').first.locator('canvas').bounding_box()
        x, y = box['x'] + box['width'] * .7, box['y'] + box['height'] * .35
        point = [box['width'] * .7, box['height'] * .35]
        world = lambda: p.evaluate("pt=>{const g=[...services.viewportGridService.getState().viewports.values()][0];return services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId).canvasToWorld(pt)}", point)
        before = world(); p.mouse.click(x, y); self.settle(p)
        after = world()
        self.assertAlmostEqual(2, self.cell(p)['zoom'], places=3)
        for a, b in zip(before, after):
            self.assertAlmostEqual(a, b, delta=0.5)
        p.keyboard.press('Escape'); expect(panel).to_have_count(0)
        p.mouse.click(x, y); self.settle(p)
        self.assertAlmostEqual(2, self.cell(p)['zoom'], places=3)

        # 03-7: typed W/L, a preset saved, the viewer reopened, the preset applied.
        panel = self.menu(p, 'My W/L Presets…')
        expect(panel).to_contain_text('Modality: CT'); expect(panel).to_contain_text('No saved presets.')
        panel.get_by_label('Window Width').fill('1500'); panel.get_by_label('Window Level').fill('-600')
        panel.get_by_role('button', name='Apply', exact=True).click(); self.settle(p)
        self.assertIn('1500', self.cell(p)['wlText']); self.assertIn('-600', self.cell(p)['wlText'])
        panel.get_by_label('Preset name').fill('NODULE LUNG'); panel.get_by_role('button', name='Save Current W/L').click()
        expect(panel.locator('tr[data-preset="NODULE LUNG"] td')).to_have_text(['NODULE LUNG', '1500', '-600', 'ApplyDelete'])
        p.keyboard.press('Escape'); p.close()

        p = self.open_viewer(f)
        # The saved corner item is drawn on open.
        p.wait_for_function("()=>[...document.querySelectorAll('.kin-display-corner[data-corner=TR]')].some(n=>/^SliceThickness: 2(\\.0+)? mm$/.test(n.textContent))", timeout=30000)
        before = self.cell(p)['wlText']
        panel = self.menu(p, 'My W/L Presets…')
        panel.get_by_role('button', name='Apply NODULE LUNG').click(); self.settle(p)
        now = self.cell(p)
        self.assertNotEqual(before, now['wlText']); self.assertIn('1500', now['wlText']); self.assertIn('-600', now['wlText'])
        print('DISPLAY MENU presets ' + json.dumps(dict(before=before, after=now['wlText'])), flush=True)
        panel.get_by_role('button', name='Delete NODULE LUNG').click(); expect(panel).to_contain_text('No saved presets.')
        p.keyboard.press('Escape')
        panel = self.menu(p, 'Corner Information…')
        panel.get_by_role('button', name='Restore Stock Overlay').click()
        expect(panel.get_by_role('status')).to_have_text('Saved to your account.'); self.settle(p)
        self.assertEqual({}, self.cell(p)['corners']); self.assertTrue(self.cell(p)['stockTopLeft'])

    def test_menu_02_auto_rotate_hand_rotation_undo_and_reopen(self):
        f = self.ct('DISPLAYROT-' + uuid.uuid4().hex[:12], 'current', '20260801')
        upside = self.upside_down(f, 'DISPLAY UPSIDE')
        p = self.open_viewer(f)
        # Off by default: Show After uses the same rule.
        self.drag(p, upside['label'], 0)
        p.wait_for_function('sop=>{const g=[...services.viewportGridService.getState().viewports.values()][0];'
                            'return (services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId)?.getCurrentImageId?.()||"").includes(sop)}',
                            arg=upside['sops'][0], timeout=60000)
        canvas_ready(p, 1); self.settle(p)
        self.assertEqual(0, self.cell(p)['rotation'])
        panel = self.menu(p, 'Auto Rotate 180°')
        print('DISPLAY MENU rotate window ' + json.dumps(panel.inner_text()), flush=True)
        expect(panel).to_contain_text('Image Orientation Patient: -1')
        expect(panel).to_contain_text('This image is stored upside-down (180°).')
        panel.get_by_role('button', name='Show After').click(); self.settle(p)
        self.assertEqual(180, self.cell(p)['rotation']); self.assertIn('Auto-rotated 180°', self.cell(p)['badges'])
        panel.get_by_role('button', name='Undo').click(); self.settle(p)
        self.assertEqual(0, self.cell(p)['rotation'])
        panel.get_by_role('button', name='Close').click()
        # On in the account: the image is turned when shown.
        p.get_by_role('button', name='Viewer Settings').click()
        dialog = p.locator('dialog.kin-ux-settings')
        dialog.get_by_role('checkbox', name='Auto Rotate 180° from Image Orientation Patient').check()
        dialog.get_by_role('button', name='Save', exact=True).click(); expect(dialog).to_be_hidden()
        p.close()
        p = self.open_viewer(f, [upside])
        p.wait_for_function("()=>{const g=[...services.viewportGridService.getState().viewports.values()][0];return services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId).getViewPresentation().rotation===180}", timeout=30000)
        self.assertIn('Auto-rotated 180°', self.cell(p)['badges'])
        # A hand rotation after it; Undo takes back only the 180°, and drawing again does not turn it again.
        select_image_tool(p, 'rotate-right'); self.settle(p)
        self.assertEqual(270, self.cell(p)['rotation'])
        panel = self.menu(p, 'Auto Rotate 180°')
        panel.get_by_role('button', name='Undo').click(); self.settle(p)
        self.assertEqual(90, self.cell(p)['rotation']); self.assertNotIn('Auto-rotated 180°', self.cell(p)['badges'])
        p.evaluate("()=>{const g=[...services.viewportGridService.getState().viewports.values()][0];const v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);v.render();}")
        self.settle(p); self.assertEqual(90, self.cell(p)['rotation'])
        panel.get_by_role('button', name='Close').click()
        p.get_by_role('button', name='Viewer Settings').click()
        dialog = p.locator('dialog.kin-ux-settings')
        dialog.get_by_role('checkbox', name='Auto Rotate 180° from Image Orientation Patient').uncheck()
        dialog.get_by_role('button', name='Save', exact=True).click(); expect(dialog).to_be_hidden()

    def test_menu_03_voi_lut_table_and_sigmoid_pixels(self):
        f = self.ct('DISPLAYVOI-' + uuid.uuid4().hex[:12], 'current', '20260801')
        table = self.radiograph(f, 'DISPLAY LUT TABLE', 50, self.table)
        sigmoid = self.radiograph(f, 'DISPLAY LUT SIGMOID', 51, self.sigmoid)
        p = self.open_viewer(f, [table])
        # On by default: the stored table, which runs opposite to the stored window.
        p.wait_for_function("()=>[...document.querySelectorAll('.kin-display-badges>span')].some(n=>n.textContent==='VOI LUT')", timeout=30000)
        self.settle(p)
        on = p.evaluate(SAMPLES)
        panel = self.menu(p, 'VOI LUT')
        expect(panel).to_contain_text('This image carries a VOI LUT (VOI LUT Sequence).')
        check = panel.get_by_role('checkbox', name='Use VOI LUT')
        expect(check).to_be_checked()
        check.uncheck(); self.settle(p)
        off = p.evaluate(SAMPLES)
        check.check(); self.settle(p)
        again = p.evaluate(SAMPLES)
        print('DISPLAY MENU table ' + json.dumps(dict(on=on, off=off, again=again)), flush=True)
        # Table: 1300 -> 44735/65535, 2600 -> 23935/65535; window 2048/4096: 1300 -> 81, 2600 -> 162 of 255.
        self.assertAlmostEqual(174, on[0], delta=8); self.assertAlmostEqual(93, on[1], delta=8)
        self.assertAlmostEqual(81, off[0], delta=8); self.assertAlmostEqual(162, off[1], delta=8)
        self.assertEqual(on, again)
        # A window set by hand turns it off in this cell.
        select_image_tool(p, 'WindowLevel')
        box = p.locator('[data-cy=viewport-grid] > div').first.locator('canvas').bounding_box()
        p.mouse.move(box['x'] + box['width'] * .5, box['y'] + box['height'] * .5); p.mouse.down()
        p.mouse.move(box['x'] + box['width'] * .5 + 40, box['y'] + box['height'] * .5 + 20, steps=8); p.mouse.up(); self.settle(p)
        expect(check).not_to_be_checked()
        self.assertNotIn('VOI LUT', self.cell(p)['badges'])
        panel.get_by_role('button', name='Close').click()
        # SIGMOID: drawn with the function when on, with the linear window when off.
        self.drag(p, sigmoid['label'], 0)
        p.wait_for_function('sop=>{const g=[...services.viewportGridService.getState().viewports.values()][0];'
                            'return (services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId)?.getCurrentImageId?.()||"").includes(sop)}',
                            arg=sigmoid['sops'][0], timeout=60000)
        canvas_ready(p, 1); self.settle(p)
        on = p.evaluate(SAMPLES)
        panel = self.menu(p, 'VOI LUT')
        expect(panel).to_contain_text('This image carries a VOI LUT Function (SIGMOID).')
        check = panel.get_by_role('checkbox', name='Use VOI LUT')
        expect(check).to_be_checked()
        check.uncheck(); self.settle(p)
        off = p.evaluate(SAMPLES)
        check.check(); self.settle(p)
        again = p.evaluate(SAMPLES)
        print('DISPLAY MENU sigmoid ' + json.dumps(dict(on=on, off=off, again=again)), flush=True)
        # SIGMOID 2048/1000: 1300 -> 12, 2600 -> 230; linear: 1300 -> 0, 2600 -> 255.
        self.assertAlmostEqual(12, on[0], delta=6); self.assertAlmostEqual(230, on[1], delta=6)
        self.assertLessEqual(off[0], 3); self.assertGreaterEqual(off[1], 252)
        self.assertEqual(on, again)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ViewerDisplayMenuE2E(n) for n in loader.getTestCaseNames(ViewerDisplayMenuE2E) if n.startswith('test_menu_') and n in ViewerDisplayMenuE2E.__dict__)


if __name__ == '__main__':
    unittest.main(verbosity=2)
