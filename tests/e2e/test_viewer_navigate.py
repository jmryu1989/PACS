# coding: utf-8
"""Navigate menu on the shipped viewer with synthetic DICOM: Navigation Bar, Stack / Tile, Folded / Unfolded."""
import io
import unittest
import uuid

import numpy as np
from playwright.sync_api import expect
from pydicom import dcmread
from pydicom.uid import generate_uid

from test_viewer_layout import ViewerLayoutE2E
from test_prior_selection import synthetic_ct

# The active cell's viewport, as an expression inside a page function.
ACTIVE = "services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId())"
READY = "() => window.kinViewerHistoryWorkspaceState?.()?.busy === false && window.kinViewerJobWorkspaceState?.()?.busy === false"


class ViewerNavigateE2E(ViewerLayoutE2E):
    def xa(self, f, frames, label):
        """A stored XA multi-frame run in the study: a bar that moves frame by frame on a dark field."""
        source = next(d for d in (dcmread(io.BytesIO(self.stack.orthanc_bytes(path))) for path in self.originals())
                      if d.Modality == 'CT' and str(d.StudyInstanceUID) == f.uid)
        ds = source
        ds.SeriesInstanceUID = generate_uid(); ds.SOPInstanceUID = generate_uid()
        ds.SOPClassUID = '1.2.840.10008.5.1.4.1.1.12.1'; ds.Modality = 'XA'; ds.SeriesDescription = label; ds.SeriesNumber = 7
        ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID; ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
        base = ds.pixel_array.copy(); rows, columns = base.shape
        layers = []
        for n in range(frames):
            a = base.copy(); a[:] = 0
            top = 10 + n * max(1, (rows - 30) // frames)
            a[top:top + 12, columns // 4:3 * columns // 4] = 1800
            layers.append(a)
        ds.NumberOfFrames = frames; ds.FrameTime = 100; ds.CineRate = 10
        ds.PixelData = np.stack(layers).astype(base.dtype).tobytes()
        stream = io.BytesIO(); ds.save_as(stream, write_like_original=False)
        self.assertEqual(self.stack._orthanc_request('POST', '/instances', stream.getvalue()).status, 200)
        return dict(study=f.uid, series=str(ds.SeriesInstanceUID), sops=[str(ds.SOPInstanceUID)], label=label)

    def navigate(self, page, item):
        page.get_by_role('button', name='Navigate ▾').click()
        page.get_by_role('menu', name='Navigate').get_by_role('menuitem', name=item).click()

    def test_navigate_01_ct_jump_to_13_and_tile(self):
        f = synthetic_ct(self.stack, 'NAV-' + uuid.uuid4().hex[:12], 'current', '20260801', slices=20)
        page = self.launch(self.login(), [f])
        page.wait_for_function("() => " + ACTIVE + "?.getImageIds?.().length === 20")
        page.wait_for_function(READY)
        self.navigate(page, 'Navigation Bar')
        bar = page.get_by_role('group', name='Navigation Bar')
        expect(bar).to_be_visible()
        expect(bar.locator('small')).to_have_text('/ 20')
        box = bar.get_by_role('spinbutton', name='Image Number')
        box.fill('13')
        self.assertNotEqual(12, page.evaluate("() => " + ACTIVE + ".getCurrentImageIdIndex()"), 'typing alone does not move')
        box.press('Enter')
        page.wait_for_function("() => " + ACTIVE + ".getCurrentImageIdIndex() === 12")
        expect(box).to_have_value('13')
        expect(bar.get_by_role('slider', name='Image Position')).to_have_attribute('aria-valuenow', '13')
        # Stack / Tile: the grid of real images, a tile chosen is the image Stack shows.
        self.navigate(page, 'Stack / Tile')
        switch = page.get_by_role('group', name='Stack / Tile')
        expect(switch.get_by_role('button', name='Stack')).to_have_attribute('aria-pressed', 'true')
        switch.get_by_role('button', name='Tile').click()
        tiles = page.get_by_role('group', name='Series Tiles').get_by_role('button')
        expect(tiles.first).to_be_visible()
        self.assertIn('Image 13', tiles.evaluate_all('n => n.map(b => b.getAttribute("aria-label"))'))
        # The tiles hold the series' own pixels (not blank, not one copied image).
        page.wait_for_function("""() => [...document.querySelectorAll('.kin-nav-tiles canvas')].filter(c => {
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let lo = 255, hi = 0;
          for (let i = 0; i < d.length; i += 64) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); } return hi - lo > 40; }).length >= 2""", timeout=30000)
        page.get_by_role('group', name='Series Tiles').get_by_role('button', name='Image 16').click()
        page.wait_for_function("() => " + ACTIVE + ".getCurrentImageIdIndex() === 15")
        expect(page.get_by_role('group', name='Series Tiles').get_by_role('button', name='Image 16')).to_have_attribute('aria-current', 'true')
        switch.get_by_role('button', name='Stack').click()
        expect(page.locator('.kin-nav-tiles')).to_have_count(0)
        self.assertEqual(15, page.evaluate("() => " + ACTIVE + ".getCurrentImageIdIndex()"))
        expect(box).to_have_value('16')
        # The bar off: the image stays.
        self.navigate(page, 'Navigation Bar')
        expect(page.locator('.kin-nav-bar')).to_have_count(0)
        self.assertEqual(15, page.evaluate("() => " + ACTIVE + ".getCurrentImageIdIndex()"))

    def test_navigate_02_xa_multiframe_unfolded_then_folded(self):
        f = synthetic_ct(self.stack, 'NAV-' + uuid.uuid4().hex[:12], 'current', '20260801', slices=2)
        run = self.xa(f, 24, 'NAV XA run')
        page = self.launch(self.login(), [f])
        page.wait_for_function(READY)
        self.drag(page, run['label'], 0)
        page.wait_for_function("series => { const v = " + ACTIVE + "; return v?.getCurrentImageId?.()?.includes('/series/' + series + '/') && v.getImageIds().length === 24; }", arg=run['series'])
        page.wait_for_function(READY)
        page.get_by_role('button', name='Navigate ▾').click()
        menu = page.get_by_role('menu', name='Navigate')
        expect(menu.get_by_role('menuitem', name='Stack / Tile')).to_be_disabled()
        menu.get_by_role('menuitem', name='Folded / Unfolded').click()
        switch = page.get_by_role('group', name='Folded / Unfolded')
        expect(switch.get_by_role('button', name='Folded (Cine)')).to_have_attribute('aria-pressed', 'true')
        switch.get_by_role('button', name='Unfolded').click()
        frames = page.get_by_role('group', name='Frames').get_by_role('button')
        expect(frames.first).to_have_attribute('aria-label', 'Frame 1')
        labels = frames.evaluate_all('n => n.map(b => b.getAttribute("aria-label"))')
        self.assertEqual(['Frame ' + str(n) for n in range(1, len(labels) + 1)], labels)
        self.assertGreaterEqual(len(labels), 4)
        page.wait_for_function("""() => [...document.querySelectorAll('.kin-nav-tiles canvas')].filter(c => {
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let lo = 255, hi = 0;
          for (let i = 0; i < d.length; i += 64) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); } return hi - lo > 40; }).length >= 2""", timeout=30000)
        # The wheel reaches the last frame.
        page.get_by_role('group', name='Frames').hover()
        for _ in range(12): page.mouse.wheel(0, 120)
        expect(frames.last).to_have_attribute('aria-label', 'Frame 24')
        page.get_by_role('group', name='Frames').get_by_role('button', name='Frame 20').click()
        page.wait_for_function("() => " + ACTIVE + ".getCurrentImageIdIndex() === 19")
        switch.get_by_role('button', name='Folded (Cine)').click()
        expect(page.locator('.kin-nav-tiles')).to_have_count(0)
        self.assertEqual(19, page.evaluate("() => " + ACTIVE + ".getCurrentImageIdIndex()"))
        self.assertTrue(page.evaluate("() => " + ACTIVE + ".getCurrentImageId().endsWith('/frames/20')"))


def load_tests(loader, tests, pattern):
    # Only the cases this module declares; the inherited layout cases run in their own profiles.
    return unittest.TestSuite(ViewerNavigateE2E(name) for name in sorted(ViewerNavigateE2E.__dict__) if name.startswith('test_navigate_'))


if __name__ == '__main__':
    unittest.main()
