# coding: utf-8
"""Compare menu on the shipped image toolbar: Related Studies' three views, Exam Marks, Prev / Next Prior on every
comparison cell, Manual Sync with Lock, Match Zoom and Match Ratio.

The shipped viewer-features.js, viewer-ux-toolbar.js, viewer-features-compare.js and viewer-compare-model.js run in
Chromium beside the synthetic OHIF services and account endpoint of viewer_features_dom_test.py, three synthetic stack
cells with synthetic metadata, and a stand-in for the Prior Studies controller's related-study connection
(KinViewerUX.related()) that records what the menu asks of it. Synthetic data only.
"""
from pathlib import Path
import unittest

from playwright.sync_api import sync_playwright, expect

from viewer_features_dom_test import HARNESS, SETUP, OWNER, ORIGIN, HPACS

# Three cells (left: today's CT, right: the August prior, third: the August prior's second series), a related-study list
# and cornerstone stand-ins. A cell is 20 images; a cell's screen scale is synBase[cell] px per mm at zoom 1.
COMPARE = """() => {
  const third = document.createElement('div'); third.dataset.cy = 'viewport-pane'; third.id = 'pane-third';
  const thirdElement = document.createElement('div'); thirdElement.className = 'viewport-element'; third.append(thirdElement);
  document.getElementById('grid').append(third);
  const image = (set, i) => 'img:' + set + ':' + i;
  const series = (uid, study, number, description, count = 20) => ({ displaySetInstanceUID: uid, StudyInstanceUID: study, SeriesInstanceUID: uid + '-series',
    SeriesNumber: number, SeriesDescription: description, Modality: 'CT', images: Array.from({ length: count }, (_, i) => ({ imageId: image(uid, i) })) });
  window.synSets = { 'syn-set-1': series('syn-set-1', 'cur', 2, 'Axial today'), 'syn-set-2': series('syn-set-2', 'aug', 2, 'Axial August'),
    'syn-set-3': series('syn-set-3', 'aug', 3, 'Coronal August'), 'syn-set-4': series('syn-set-4', 'cur', 1, 'Scout today', 1) };
  window.synShown = { left: ['syn-set-1'], right: ['syn-set-2'], third: ['syn-set-3'] };
  window.synTags = { 'syn-set-1': { StudyDate: '20260812', PixelSpacing: [0.7, 0.7] }, 'syn-set-2': { StudyDate: '20250812', PixelSpacing: [0.82, 0.82] },
    'syn-set-3': { StudyDate: '20250812', PixelSpacing: [0.82, 0.82] }, 'syn-set-4': { StudyDate: '20260812', PixelSpacing: [1, 1] } };
  window.synBase = { left: 2, right: 1.5, third: 1.5 };
  window.synIndexCalls = [];
  const views = new Map();
  for (const id of ['left', 'right', 'third']) {
    const element = id === 'third' ? thirdElement : document.querySelector('#pane-' + id + ' .viewport-element');
    views.set(id, { id, type: 'stack', element, index: 0, zoom: 1,
      ids() { return synSets[synShown[id][0]].images.map(item => item.imageId); },
      getImageIds() { return this.ids(); }, getCurrentImageIdIndex() { return this.index; }, getCurrentImageId() { return this.ids()[this.index]; },
      // As cornerstone: the new image is announced after it loads.
      setImageIdIndex(index) { this.index = index; synIndexCalls.push([id, index]);
        setTimeout(() => document.dispatchEvent(new CustomEvent('CORNERSTONE_STACK_NEW_IMAGE', { detail: { viewportId: id } })), 5); return Promise.resolve(); },
      getZoom() { return this.zoom; }, setZoom(value) { this.zoom = value; }, render() {},
      canvasToWorld([x, y]) { const s = synBase[id] * this.zoom; return [x / s, y / s, 0]; },
      worldToCanvas([x, y]) { const s = synBase[id] * this.zoom; return [x * s, y * s]; },
      getRenderingEngine: () => ({ id: 'syn-engine' }) });
  }
  window.synViews = views;
  synServices.cornerstoneViewportService.getCornerstoneViewport = id => views.get(id);
  synServices.displaySetService = { getActiveDisplaySets: () => Object.values(synSets), getDisplaySetByUID: uid => synSets[uid] };
  window.synMove = (id, index) => { views.get(id).index = index; document.dispatchEvent(new CustomEvent('CORNERSTONE_STACK_NEW_IMAGE', { detail: { viewportId: id } })); };
  window.cornerstone = { Enums: { Events: { STACK_NEW_IMAGE: 'CORNERSTONE_STACK_NEW_IMAGE', IMAGE_RENDERED: 'CORNERSTONE_IMAGE_RENDERED' }, ViewportType: { STACK: 'stack' } },
    metaData: { get(type, id) {
      const set = String(id).split(':')[1], tags = synTags[set];
      if (!tags) return null;
      if (type === 'instance') return { ...tags, PatientID: 'SYN-1' };
      if (type === 'imagePlaneModule') return { rowCosines: [1, 0, 0], columnPixelSpacing: tags.PixelSpacing ? Number(tags.PixelSpacing[1]) : 1 };
      return null;
    } } };
  // The related-study list as the Prior Studies controller gives it (dates already YYYY-MM-DD), and what was asked of it.
  window.synRelated = { calls: [], answer: true,
    rows: [{ uid: 'later', date: '2026-09-01', time: '090000', acc: 'L1', modality: 'CT', desc: 'Chest CT later', sourcePatientKey: 'PK' },
      { uid: 'cur', date: '2026-08-12', time: '120000', acc: 'C1', modality: 'CT', desc: 'Chest CT today', sourcePatientKey: 'PK' },
      { uid: 'may', date: '2025-05-02', time: '100000', acc: 'M1', modality: 'CT', desc: 'Chest CT May', sourcePatientKey: 'PK' },
      { uid: 'aug', date: '2025-08-12', time: '100000', acc: 'A1', modality: 'CT', desc: 'Chest CT August', sourcePatientKey: 'PK' },
      { uid: 'nodate', date: '', time: '', acc: 'N1', modality: 'CR', desc: 'Chest X-ray', sourcePatientKey: 'PK' }],
    async studies(value) { this.calls.push(['studies', value.viewportId]); return structuredClone(this.rows); },
    async open(value, uid, options) { this.calls.push(['open', value.viewportId, uid, options.seriesUid || null]); return this.answer; },
    async replace(entries) { this.calls.push(['replace', entries.map(entry => [entry.value.viewportId, entry.uid])]); return this.answer; },
    subscribe: () => () => {} };
  window.KinViewerUX = { related: () => synRelated, snapshot: () => ({ key: 'PK', sequence: 1, studyUIDs: ['cur'] }),
    viewport(id) {
      const sets = synShown[id]; if (!sets?.length) return null; const set = synSets[sets[0]];
      return { patientKey: 'PK', sequence: 1, viewportId: id, studyUid: set.StudyInstanceUID, seriesUid: set.SeriesInstanceUID, displaySetUid: sets[0], mode: 'stack' };
    } };
}"""


class ViewerCompareDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self, settings=None, size=(1366, 900)):
        context = self.browser.new_context(viewport={'width': size[0], 'height': size[1]})
        page = context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(ORIGIN + "/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.route(ORIGIN + "/worklist/hpacs-lite/viewer-compare-model.js",
                   lambda route: route.fulfill(path=str(HPACS / 'viewer-compare-model.js'), content_type='text/javascript'))
        page.goto(ORIGIN + "/")
        page.add_style_tag(path=str(HPACS / "viewer-ux-theme.css"))
        for name in ["viewer-ux-shortcuts.js", "viewer-features.js", "viewer-ux-toolbar.js"]:
            page.add_script_tag(path=str(HPACS / name))
        page.evaluate(SETUP, OWNER)
        page.evaluate("settings => { synServer.viewerSettings = settings; }", settings)
        page.evaluate(COMPARE)
        page.add_script_tag(path=str(HPACS / "viewer-features-compare.js"))
        page.evaluate("() => synMount()")
        expect(page.locator('.kin-ux-toolbar-settings [role=status]')).to_have_text('계정 설정 · 다른 PC에서도 적용됩니다.')
        page.wait_for_function("() => !!window.KinCompareModel")
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    def menu(self, page, label):
        page.get_by_role('button', name='Compare ▾').click()
        page.get_by_role('menu', name='Compare').get_by_role('menuitem', name=label, exact=True).click()

    def rows(self, panel):
        return panel.locator('table tr').evaluate_all('rows => rows.map(r => [...r.children].map(c => c.textContent))')

    def test_01_compare_menu_items_and_prior_buttons_in_the_mock_order(self):
        page = self.open()
        page.get_by_role('button', name='Compare ▾').click()
        expect(page.get_by_role('menu', name='Compare').get_by_role('menuitem')).to_have_text(
            ['Related Studies', 'Exam Marks on Images', 'Prev Prior Exam', 'Next Prior Exam', 'Manual Sync…', 'Scout Navigation', 'Match Zoom', 'Match Ratio…'])
        page.keyboard.press('Escape')
        self.assertEqual(['Compare ▾', '‹ Prior', 'Prior ›'], page.evaluate("() => [...document.querySelectorAll('.kin-ux-features-row > button')].map(n => n.textContent)"))
        self.assertEqual('Prev Prior Exam', page.locator('[data-feature=comparePrevPriorButton]').get_attribute('title'))

    def test_02_related_studies_three_views_marks_viewing_and_series_open(self):
        page = self.open()
        self.menu(page, 'Related Studies')
        panel = page.get_by_role('dialog', name='Related Studies')
        expect(panel.locator('tr[data-study]')).to_have_count(4)
        # Related Studies: every related study but the current one; P only for studies dated before today's.
        self.assertEqual([['Mark', 'Viewing', 'Study Date', 'Modality', 'Description'],
                          ['P1', 'Open', '2025-08-12', 'CT', 'Chest CT August'],
                          ['P2', '', '2025-05-02', 'CT', 'Chest CT May'],
                          ['', '', '2026-09-01', 'CT', 'Chest CT later'],
                          ['', '', '', 'CR', 'Chest X-ray']], self.rows(panel))
        self.assertEqual('italic', panel.locator('tr[data-study=aug] td').first.evaluate('n => getComputedStyle(n).fontStyle'))
        panel.get_by_label('View').select_option('with-current')
        expect(panel.locator('tr[data-study]')).to_have_count(5)
        self.assertEqual(['*', 'Open', '2026-08-12', 'CT', 'Chest CT today'], self.rows(panel)[1])
        panel.get_by_label('View').select_option('series')
        self.assertEqual([['Mark', 'Viewing', 'Study', 'Series No', 'Description', 'Images'],
                          ['*', '', '2026-08-12', '1', 'Scout today', '1'],
                          ['*', 'Open', '2026-08-12', '2', 'Axial today', '20'],
                          ['P1', 'Open', '2025-08-12', '2', 'Axial August', '20'],
                          ['P1', 'Open', '2025-08-12', '3', 'Coronal August', '20']], self.rows(panel))
        # A Series row opens that series, not the study's first.
        panel.locator('tr[data-series="syn-set-4-series"]').dblclick()
        page.wait_for_function("() => synRelated.calls.some(c => c[0] === 'open')")
        self.assertEqual(['open', 'left', 'cur', 'syn-set-4-series'], page.evaluate("synRelated.calls.find(c => c[0] === 'open')"))
        panel.get_by_label('View').select_option('related')
        panel.locator('tr[data-study=may]').dblclick()
        page.wait_for_function("() => synRelated.calls.filter(c => c[0] === 'open').length === 2")
        self.assertEqual(['open', 'left', 'may', None], page.evaluate("synRelated.calls.filter(c => c[0] === 'open')[1]"))

    def test_03_exam_marks_saved_in_the_account_and_given_to_the_image_labels(self):
        page = self.open()
        self.assertFalse(page.evaluate("typeof window.kinViewerExamMark === 'function'"))
        self.menu(page, 'Related Studies')
        panel = page.get_by_role('dialog', name='Related Studies')
        panel.get_by_label('Show Exam Mark on images (prior in a different font)').check()
        page.wait_for_function("() => synServer.puts.length === 1")
        self.assertEqual({'examMarks': True}, page.evaluate("synServer.puts[0].viewerSettings.features"))
        page.wait_for_function("() => window.kinViewerExamMark?.('aug') === 'P1'")
        self.assertEqual(['*', 'P1', 'P2', '', ''], page.evaluate("['cur', 'aug', 'may', 'later', 'nodate'].map(uid => kinViewerExamMark(uid))"))
        # The menu item turns it off again.
        self.menu(page, 'Exam Marks on Images')
        page.wait_for_function("() => synServer.puts.length === 2 && typeof window.kinViewerExamMark !== 'function'")
        expect(panel.get_by_label('Show Exam Mark on images (prior in a different font)')).not_to_be_checked()
        self.assertEqual({'examMarks': False}, page.evaluate("synServer.puts[1].viewerSettings.features"))

    def test_04_prior_buttons_change_every_comparison_cell_together_and_stop_at_the_ends(self):
        page = self.open()
        page.get_by_role('button', name='Prior ›').click()
        page.wait_for_function("() => synRelated.calls.some(c => c[0] === 'replace')")
        # Both comparison cells (right and third show the August prior) go to the next older prior in one request.
        self.assertEqual(['replace', [['right', 'may'], ['third', 'may']]], page.evaluate("synRelated.calls.find(c => c[0] === 'replace')"))
        page.wait_for_function("() => synNotes.some(n => n.message.includes('P2'))")
        # ‹ Prior from the newest prior: nothing changes and a note says there is no later one.
        page.get_by_role('button', name='‹ Prior').click()
        page.wait_for_function("() => synNotes.some(n => n.message === '더 이후 검사가 없습니다.')")
        self.assertEqual(1, page.evaluate("synRelated.calls.filter(c => c[0] === 'replace').length"))
        # Without a comparison cell the nearest prior opens beside the current images.
        page.evaluate("() => { synShown.right = []; synShown.third = []; }")
        page.get_by_role('button', name='Prior ›').click()
        page.wait_for_function("() => synRelated.calls.some(c => c[0] === 'open')")
        self.assertEqual(['open', 'left', 'aug', None], page.evaluate("synRelated.calls.find(c => c[0] === 'open')"))
        # A refused change is reported and nothing claims success.
        page.evaluate("() => { synShown.right = ['syn-set-2']; synRelated.answer = false; synNotes.length = 0; }")
        page.get_by_role('button', name='Prior ›').click()
        page.wait_for_function("() => synNotes.some(n => n.type === 'error')")
        self.assertFalse(page.evaluate("synNotes.some(n => n.message.includes('Next Prior Exam'))"))

    def test_05_manual_sync_lock_follows_the_image_set_and_keeps_the_difference(self):
        page = self.open()
        page.evaluate("() => { synViews.get('left').index = 9; synViews.get('right').index = 2; }")
        self.menu(page, 'Manual Sync…')
        panel = page.get_by_role('dialog', name='Manual Sync')
        self.assertEqual([['Sync', 'Cell', 'Study Date', 'Series'], ['', '1', '2026-08-12', '2 Axial today'],
                          ['', '2', '2025-08-12', '2 Axial August'], ['', '3', '2025-08-12', '3 Coronal August']], self.rows(panel))
        panel.get_by_label('Sync cell 1').check(); panel.get_by_label('Sync cell 2').check()
        panel.get_by_role('button', name='Lock Selection').click()
        expect(panel.get_by_role('button', name='Unlock')).to_be_visible()
        expect(panel.get_by_label('Sync cell 1')).to_be_disabled(); expect(panel.get_by_label('Sync cell 1')).to_be_checked()
        expect(page.locator('.kin-compare-badge[data-compare-badge=sync]')).to_have_text(['🔒 Manual Sync A (locked)', '🔒 Manual Sync A (locked)'])
        self.assertEqual([True, True, False], page.evaluate("['left', 'right', 'third'].map(id => kinManualSync.has(id))"))
        # Five images down on the left: the right goes five down from where it was tied, and its own echo leads nothing.
        page.evaluate("synMove('left', 14)")
        page.wait_for_function("() => synViews.get('right').index === 7")
        page.wait_for_timeout(60)
        self.assertEqual([['right', 7]], page.evaluate('synIndexCalls'))
        self.assertEqual(14, page.evaluate("synViews.get('left').index"))
        # The cells swap images (a new layout): the locked group follows its image sets, not the cell names.
        page.evaluate("() => { synShown.left = ['syn-set-2']; synShown.right = ['syn-set-1']; synViews.get('left').index = 7; synViews.get('right').index = 14; synEmit('grid', 'gridState', { viewports: [{ viewportId: 'left' }, { viewportId: 'right' }] }); }")
        page.evaluate("synMove('right', 4)")
        page.wait_for_function("() => synViews.get('left').index === 0")
        self.assertEqual([['right', 7], ['left', 0]], page.evaluate('synIndexCalls'))
        # Other images in a tied cell: that cell is out of the group until its set comes back, and moves nothing.
        page.evaluate("() => { synShown.left = ['syn-set-3']; synEmit('grid', 'gridState', { viewports: [{ viewportId: 'left' }] }); }")
        self.assertEqual([False, True], page.evaluate("['left', 'right'].map(id => kinManualSync.has(id))"))
        page.evaluate("synMove('right', 10)")
        page.wait_for_timeout(60)
        self.assertEqual(2, len(page.evaluate('synIndexCalls')))
        page.evaluate("() => { synShown.left = ['syn-set-2']; synEmit('grid', 'gridState', { viewports: [{ viewportId: 'left' }] }); }")
        self.assertEqual([True, True], page.evaluate("['left', 'right'].map(id => kinManualSync.has(id))"))
        # Unlock: the boxes can change again; clearing them and Apply unties the cells.
        panel.get_by_role('button', name='Unlock').click()
        expect(panel.get_by_label('Sync cell 1')).to_be_enabled()
        expect(page.locator('.kin-compare-badge[data-compare-badge=sync]')).to_have_text(['Manual Sync A', 'Manual Sync A'])
        panel.get_by_label('Sync cell 1').uncheck(); panel.get_by_label('Sync cell 2').uncheck()
        panel.get_by_role('button', name='Apply').click()
        self.assertEqual([False, False, False], page.evaluate("['left', 'right', 'third'].map(id => kinManualSync.has(id))"))
        expect(page.locator('.kin-compare-badge[data-compare-badge=sync]')).to_have_count(0)

    def test_06_unlocked_group_drops_a_cell_given_other_images(self):
        page = self.open()
        self.menu(page, 'Manual Sync…')
        panel = page.get_by_role('dialog', name='Manual Sync')
        panel.get_by_label('Sync cell 1').check(); panel.get_by_label('Sync cell 2').check()
        panel.get_by_role('button', name='Apply').click()
        self.assertEqual([True, True], page.evaluate("['left', 'right'].map(id => kinManualSync.has(id))"))
        page.evaluate("() => { synShown.right = ['syn-set-3']; synEmit('grid', 'gridState', { viewports: [{ viewportId: 'right' }] }); }")
        self.assertEqual([False, False], page.evaluate("['left', 'right'].map(id => kinManualSync.has(id))"))

    def test_06b_a_tied_cell_loading_its_next_image_stays_tied(self):
        # While a cell's next image loads the shell has no rendered identity for it; a layout event then must not untie it.
        page = self.open()
        self.menu(page, 'Manual Sync…')
        panel = page.get_by_role('dialog', name='Manual Sync')
        panel.get_by_label('Sync cell 1').check(); panel.get_by_label('Sync cell 2').check()
        panel.get_by_role('button', name='Apply').click()
        page.evaluate("() => { const viewport = KinViewerUX.viewport; KinViewerUX.viewport = id => id === 'right' ? null : viewport(id); synEmit('cells', 'data', { viewportId: 'right' }); }")
        self.assertEqual([True, True], page.evaluate("['left', 'right'].map(id => kinManualSync.has(id))"))
        page.evaluate("synMove('right', 3)")
        page.wait_for_function("() => synViews.get('left').index === 3")
        # Another patient's tab: nothing stays tied.
        page.evaluate("() => { KinViewerUX.snapshot = () => ({ key: 'OTHER', sequence: 2, studyUIDs: ['x'] }); synEmit('grid', 'gridState', {}); }")
        self.assertEqual([False, False], page.evaluate("['left', 'right'].map(id => kinManualSync.has(id))"))

    def test_07_match_zoom_and_match_ratio_with_the_spacing_source(self):
        page = self.open()
        page.evaluate("() => { synViews.get('left').zoom = 1.8; }")
        self.menu(page, 'Match Zoom')
        self.assertEqual([1.8, 1.8, 1.8], page.evaluate("['left', 'right', 'third'].map(id => synViews.get(id).zoom)"))
        page.wait_for_function("() => synNotes.some(n => n.message.startsWith('Match Zoom: 2 other images'))")
        page.evaluate("() => { for (const v of synViews.values()) v.zoom = 1; }")
        self.menu(page, 'Match Ratio…')
        panel = page.get_by_role('dialog', name='Match Ratio')
        self.assertEqual([['Cell', 'Pixel Spacing', 'Spacing Source', 'Screen px per mm'],
                          ['1 (reference)', '0.7\\0.7', 'Pixel Spacing (patient)', '2.00'],
                          ['2', '0.82\\0.82', 'Pixel Spacing (patient)', '1.50'],
                          ['3', '0.82\\0.82', 'Pixel Spacing (patient)', '1.50']], self.rows(panel))
        panel.get_by_role('button', name='Match Ratio').click()
        expect(panel.locator('tr[data-cell=right] td').nth(3)).to_have_text('2.00')
        self.assertAlmostEqual(4 / 3, page.evaluate("synViews.get('right').zoom"), places=9)
        expect(page.locator('#pane-right .kin-compare-badge[data-compare-badge=ratio]')).to_have_text('Match Ratio (same mm on screen)')

    def test_08_match_ratio_is_blocked_when_the_reference_spacing_is_unknown_and_skips_such_cells(self):
        page = self.open()
        page.evaluate("() => { delete synTags['syn-set-1'].PixelSpacing; }")
        self.menu(page, 'Match Ratio…')
        panel = page.get_by_role('dialog', name='Match Ratio')
        expect(panel.get_by_role('button', name='Match Ratio')).to_be_disabled()
        expect(panel.get_by_role('status')).to_contain_text('기준 칸')
        self.assertEqual(['1 (reference)', '—', '간격을 확인할 수 없어 제외', '—'], self.rows(panel)[1])
        panel.get_by_role('button', name='Close').click()
        # The right cell as reference: the left (no spacing) is skipped and named; the third is matched.
        page.evaluate("() => { synActive = 'right'; synTags['syn-set-3'].PixelSpacing = [0.5, 0.5]; synBase.third = 3; }")
        self.menu(page, 'Match Ratio…')
        panel = page.get_by_role('dialog', name='Match Ratio')
        self.assertEqual('2 (reference)', self.rows(panel)[2][0])
        panel.get_by_role('button', name='Match Ratio').click()
        expect(panel.get_by_role('status')).to_have_text('간격을 확인할 수 없어 제외한 칸: 1')
        self.assertEqual(1, page.evaluate("synViews.get('left').zoom"))
        # 1.5 px per mm on the reference; the third showed 3 px per mm, so it halves.
        self.assertAlmostEqual(0.5, page.evaluate("synViews.get('third').zoom"), places=9)


if __name__ == "__main__":
    unittest.main(verbosity=2)
