# coding: utf-8
"""Compare menu on the served viewer with owned synthetic CTs: Manual Sync ties two stacks by image number while the
automatic CT position sync stays out in both directions; Scout Navigation draws the active slice on a synthetic
localizer of the same frame of reference, follows it, moves it on a click and draws nothing for another frame of
reference; Match Ratio gives two CTs of different pixel spacing the same screen pixels per millimetre."""
import copy, io, os, unittest, uuid
import numpy as np
from pydicom import dcmread
from pydicom.uid import generate_uid, CTImageStorage, ExplicitVRLittleEndian
from pynetdicom import AE
from playwright.sync_api import expect
from test_ct_sync import CTSyncE2E
from test_prior_selection import canvas_ready


class ViewerCompareE2E(CTSyncE2E):
    def originals_of(self, f):
        orth = next(x['ID'] for x in self.stack._orthanc_request('POST', '/tools/lookup', f.uid.encode()).body if x['Type'] == 'Study')
        found = [dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/' + x['ID'] + '/file')))
                 for x in self.stack._orthanc_request('GET', '/studies/' + orth + '/instances').body]
        return sorted(found, key=lambda d: float(d.ImagePositionPatient[2]))

    def store(self, datasets):
        ae = AE(ae_title='HALLYM_CT'); ae.add_requested_context(CTImageStorage, ExplicitVRLittleEndian)
        assoc = ae.associate('127.0.0.1', int(os.environ.get('KIN_TEST_DICOM_PORT', '4242')), ae_title='KINLAB')
        self.assertTrue(assoc.is_established)
        try:
            for d in datasets:
                self.assertEqual(assoc.send_c_store(d).Status, 0)
        finally:
            assoc.release()

    def copy_series(self, f, description, number, change):
        series, out = generate_uid(), []
        for original in self.originals_of(f):
            d = copy.deepcopy(original); d.SeriesInstanceUID = series; d.SeriesNumber = number; d.SeriesDescription = description
            d.SOPInstanceUID = generate_uid(); d.file_meta.MediaStorageSOPInstanceUID = d.SOPInstanceUID
            change(d); out.append(d)
        self.store(out)
        return series

    # A coronal localizer in the CT's own frame of reference: 256 columns of 1 mm along x, 100 rows of 0.5 mm going
    # down in z from z = 40, so the axial slices (z = 0..30) cross it as horizontal lines.
    def localizer(self, f):
        d = copy.deepcopy(self.originals_of(f)[0])
        d.SeriesInstanceUID = generate_uid(); d.SeriesNumber = 9; d.SeriesDescription = 'SCOUT localizer'; d.InstanceNumber = 1
        d.SOPInstanceUID = generate_uid(); d.file_meta.MediaStorageSOPInstanceUID = d.SOPInstanceUID
        d.ImageType = ['ORIGINAL', 'PRIMARY', 'LOCALIZER']
        d.ImageOrientationPatient = [1, 0, 0, 0, 0, -1]; d.ImagePositionPatient = [0, 128, 40]
        d.PixelSpacing = [0.5, 1]; d.Rows, d.Columns = 100, 256
        if 'SliceLocation' in d: del d.SliceLocation
        pixels = (np.add.outer(np.arange(100) * 20, np.arange(256) * 4) % 2000 + 100).astype('<u2')
        d.PixelData = pixels.tobytes()
        self.store([d])
        return d.SeriesInstanceUID

    def compare(self, p, label):
        p.get_by_role('button', name='Compare ▾').click()
        p.get_by_role('menu', name='Compare').get_by_role('menuitem', name=label, exact=True).click()

    def index(self, p, cell):
        return self.snapshot(p)[cell]['index']

    def wait_index(self, p, cell, index):
        p.wait_for_function('''({cell,index})=>{const g=[...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x)[cell];
          return services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId).getCurrentImageIdIndex()===index}''', arg=dict(cell=cell, index=index), timeout=15000)

    def activate(self, p, cell):
        ident = self.snapshot(p)[cell]['id']
        p.evaluate('id=>services.viewportGridService.setActiveViewportId(id)', ident)
        p.wait_for_function('id=>services.viewportGridService.getActiveViewportId()===id', arg=ident)

    def test_compare_01_manual_sync_keeps_the_step_difference_and_auto_sync_stays_out(self):
        f, series, refs = self.pair(); originals = self.originals(); p = self.pair_page(f)
        self.jump(p, 0, 2); self.wait_index(p, 0, 2); self.jump(p, 1, 0); self.wait_index(p, 1, 0)
        self.compare(p, 'Manual Sync…')
        panel = p.get_by_role('dialog', name='Manual Sync')
        panel.get_by_label('Sync cell 1').check(); panel.get_by_label('Sync cell 2').check()
        panel.get_by_role('button', name='Apply').click()
        expect(p.locator('.kin-compare-badge[data-compare-badge=sync]')).to_have_text(['Manual Sync A', 'Manual Sync A'])
        panel.get_by_role('button', name='Close').click()
        self.toggle(p)  # the automatic CT position sync is on from here
        # Five images on the left: the right goes five images too (not to the nearest position), and stays there.
        self.jump(p, 0, 7); self.wait_index(p, 1, 5); p.wait_for_timeout(800)
        self.assertEqual([7, 5], [self.index(p, 0), self.index(p, 1)])
        # The other direction: two images back on the right, two back on the left.
        self.jump(p, 1, 3); self.wait_index(p, 0, 5); p.wait_for_timeout(800)
        self.assertEqual([5, 3], [self.index(p, 0), self.index(p, 1)])
        # The end stops the right cell; coming back it regains its own difference.
        self.jump(p, 0, 15); self.wait_index(p, 1, 7)
        self.jump(p, 0, 4); self.wait_index(p, 1, 2)
        p.screenshot(path=str(self.artifacts() / 'COMPARE-manual-sync.png'))
        # Untied, the automatic sync matches positions again.
        self.compare(p, 'Manual Sync…')
        panel = p.get_by_role('dialog', name='Manual Sync')
        panel.get_by_label('Sync cell 1').uncheck(); panel.get_by_label('Sync cell 2').uncheck()
        panel.get_by_role('button', name='Apply').click(); panel.get_by_role('button', name='Close').click()
        expect(p.locator('.kin-compare-badge[data-compare-badge=sync]')).to_have_count(0)
        self.jump(p, 0, 10); self.wait_z(p, 1, 20)
        self.assertEqual(self.originals(), originals)

    def test_compare_02_scout_navigation_line_click_and_no_line_across_frames(self):
        f = self.ct('CMP-' + uuid.uuid4().hex[:12], 'current', '20260801'); self.localizer(f)
        past = self.ct(f.patient_id, 'past', '20260701'); originals = self.originals()
        p = self.launch(self.login(), [f, past]); self.grid(p, 2)
        self.drag(p, 'D03A current', 0); self.drag(p, 'D03A past', 1); canvas_ready(p, 2)
        self.activate(p, 0); self.jump(p, 0, 3); self.wait_index(p, 0, 3)
        self.compare(p, 'Scout Navigation')
        panel = p.get_by_role('dialog', name='Scout Navigation')
        expect(panel.get_by_label('Series').locator('option:checked')).to_contain_text('Localizer')
        frame = panel.locator('.kin-compare-scout-frame')
        # The drawn line lies where the scout viewport itself puts the height z (both ends).
        def line_at(z):
            p.wait_for_function('''z=>{const f=document.querySelector('.kin-compare-scout-frame');if(!f?.dataset.line||f.dataset.line==='none')return false;
              const e=cornerstone.getRenderingEngines().find(e=>e.id.startsWith('kin-compare-scout-')),v=e?.getViewports()[0];if(!v)return false;
              const [x1,y1,x2,y2]=f.dataset.line.split(' ').map(Number);
              return Math.abs(y1-v.worldToCanvas([0,128,z])[1])<1.5&&Math.abs(y2-v.worldToCanvas([255,128,z])[1])<1.5}''', arg=z, timeout=20000)
        line_at(6)
        expect(panel.get_by_role('status')).to_have_text('Image 4 / 16')
        # The line follows the active cell.
        self.jump(p, 0, 10); line_at(20)
        p.screenshot(path=str(self.artifacts() / 'COMPARE-scout.png'))
        # A click on the scout takes the active cell to the slice nearest that height (z = 24 → image 13).
        point = p.evaluate('''()=>{const e=cornerstone.getRenderingEngines().find(e=>e.id.startsWith('kin-compare-scout-'));const v=e.getViewports()[0];
          const c=v.worldToCanvas([128,128,24]),b=v.element.getBoundingClientRect();return [b.left+c[0],b.top+c[1]]}''')
        p.mouse.click(point[0], point[1]); self.wait_index(p, 0, 12); line_at(24)
        # The prior is another frame of reference: no line, and it says so.
        self.activate(p, 1)
        expect(panel.get_by_role('status')).to_have_text('이 시리즈와는 위치를 맞출 수 없습니다.')
        expect(frame).to_have_attribute('data-line', 'none')
        panel.get_by_role('button', name='Close').click()
        self.assertEqual(0, p.evaluate("cornerstone.getRenderingEngines().filter(e=>e.id.startsWith('kin-compare-scout-')).length"))
        self.assertEqual(self.originals(), originals)

    def test_compare_03_match_ratio_gives_the_same_millimetres_on_screen(self):
        f = self.ct('CMP-' + uuid.uuid4().hex[:12], 'current', '20260801')
        def finer(d):
            d.PixelSpacing = [0.7, 0.7]
        self.copy_series(f, 'RATIO fine', 2, finer); originals = self.originals()
        p = self.launch(self.login(), [f]); self.grid(p, 2)
        self.drag(p, 'D03A current', 0); self.drag(p, 'RATIO fine', 1); canvas_ready(p, 2); self.activate(p, 0)
        ten_mm = '''()=>[...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).map(g=>{
          const v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId),a=v.getCamera().focalPoint,
          p=v.worldToCanvas(a),q=v.worldToCanvas([a[0]+10,a[1],a[2]]);return Math.hypot(q[0]-p[0],q[1]-p[1])})'''
        before = p.evaluate(ten_mm)
        self.assertGreater(abs(before[0] - before[1]) / before[0], 0.2)
        self.compare(p, 'Match Ratio…')
        panel = p.get_by_role('dialog', name='Match Ratio')
        rows = panel.locator('table tr').evaluate_all('rows => rows.map(r => [...r.children].map(c => c.textContent))')
        self.assertEqual(['1 (reference)', '1\\1', 'Pixel Spacing (patient)'], rows[1][:3])
        self.assertEqual(['2', '0.7\\0.7', 'Pixel Spacing (patient)'], rows[2][:3])
        panel.get_by_role('button', name='Match Ratio').click()
        p.wait_for_function('''()=>{const r=[...document.querySelectorAll('.kin-compare-panel table tr')].slice(1).map(t=>t.children[3].textContent);return r.length===2&&r[0]===r[1]}''')
        after = p.evaluate(ten_mm)
        self.assertAlmostEqual(after[0], before[0], delta=0.01 * before[0])
        self.assertAlmostEqual(after[1], after[0], delta=0.01 * after[0])
        expect(p.locator('.kin-compare-badge[data-compare-badge=ratio]').nth(1)).to_have_text('Match Ratio (same mm on screen)')
        p.screenshot(path=str(self.artifacts() / 'COMPARE-match-ratio.png'))
        self.assertEqual(self.originals(), originals)

    def artifacts(self):
        from pathlib import Path
        folder = Path(__file__).parent / 'artifacts'; folder.mkdir(exist_ok=True)
        return folder


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ViewerCompareE2E(n) for n in loader.getTestCaseNames(ViewerCompareE2E) if n.startswith('test_compare_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
