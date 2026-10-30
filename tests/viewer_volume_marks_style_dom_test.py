# coding: utf-8
"""TEST-MARKER-STYLE (Minhoon 12, MH-4): manual MPR 3D annotations follow the account's marker colour and thickness.

REQ-MARKER-STYLE -> RISK-MARKER-PARTIAL (some marks keep the old look) / RISK-MARKER-RECORD (a display choice
changes a mark) -> TEST-MARKER-STYLE. The real orientation host, manual 3D annotation panel and marker style
model run in Chromium against the synthetic three-plane target of viewer_volume_marks_progressive_dom_test.
The points are drawn outside Cornerstone's annotation styles, so they must take the same choice as the
viewer's other marks at once, keep their points and saved state, ignore another account and return to
their own look on Default/Standard. This is no GPU, pixel or native renderer proof.
"""
from pathlib import Path
import sys
import unittest

from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, str(Path(__file__).resolve().parent))
from viewer_volume_marks_progressive_dom_test import HARNESS, POINT, STATUS  # noqa: E402


ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
SCRIPTS = ["volume-marks.js", "viewer-volume-marks.js", "viewer-volume-orientation.js", "marker-style.js"]
GOLD, RED = "rgb(255, 220, 124)", "rgb(255, 64, 64)"
# What the reader sees of every drawn annotation in all three planes, and what the panel holds.
DRAWN = """() => ({
  lines: [...document.querySelectorAll('.kin-mpr-marks-overlay line')].map(e => [getComputedStyle(e).stroke, e.getAttribute('stroke-width')]),
  labels: [...document.querySelectorAll('.kin-mpr-marks-overlay [data-mark-id]')].map(e => getComputedStyle(e).color),
  points: [...document.querySelectorAll('.kin-mpr-marks-overlay [data-kin-mpr-mark-point]')].map(e => [getComputedStyle(e).color, getComputedStyle(e).webkitTextStrokeWidth]),
  marks: kinMprMarks.capture(true), dirty: kinMprMarks.dirty()})"""
# The viewer's Cornerstone style registry; the marker style mount writes the same choice there.
MOUNT = """() => { let styles = {global: {color: 'rgb(255, 255, 0)', lineWidth: '1'}};
  window.cornerstoneTools = {annotation: {config: {style: {getDefaultToolStyles: () => styles, setDefaultToolStyles: next => { styles = next; }}}}};
  window.markerMount = KinMarkerStyle.mount({tools: cornerstoneTools, cornerstone: {getRenderingEngines: () => []}, owner: JSON.stringify(currentOwner)}); }"""


class ViewerVolumeMarksStyleDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop()

    def open_page(self):
        page = self.browser.new_page(viewport={'width': 1000, 'height': 900});errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route("https://marks-style.test/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.goto("https://marks-style.test/")
        for name in SCRIPTS:
            page.add_script_tag(path=str(HPACS / name))
        page.evaluate("()=>{window.mounted=mountOrientation();tick(250);tick(500)}")
        panel = page.locator('#kin-mpr-marks')
        panel.get_by_label('MPR annotation label', exact=True).fill('Synthetic point')
        panel.get_by_role('button', name='Pick Point', exact=True).click()
        page.mouse.click(*POINT)
        expect(page.locator(STATUS)).to_contain_text('수동 표식을 추가했습니다')
        return page, errors

    def publish(self, page, owner, color, width):
        page.evaluate("([owner, value]) => KinMarkerStyle.publish(JSON.stringify(owner), value)",
                      [owner, {'version': 1, 'color': color, 'width': width}])

    def test_a_change_redraws_every_plane_at_once_and_keeps_the_points(self):
        page, errors = self.open_page()
        try:
            before = page.evaluate(DRAWN)
            self.assertEqual([[GOLD, '1']] * 3, before['lines'])
            self.assertEqual([GOLD] * 3, before['labels']);self.assertEqual([[GOLD, '0px']] * 3, before['points'])
            page.evaluate(MOUNT)
            # No refresh tick: the change itself repaints.
            self.publish(page, ['hospital', 'reader'], 'red', 'extra-thick')
            after = page.evaluate(DRAWN)
            self.assertEqual([[RED, '3']] * 3, after['lines'])
            self.assertEqual([RED] * 3, after['labels'])
            self.assertEqual([RED] * 3, [color for color, _ in after['points']])
            self.assertTrue(all(float(width.removesuffix('px')) > 0 for _, width in after['points']), after['points'])
            self.assertEqual((before['marks'], before['dirty']), (after['marks'], after['dirty']), 'points and the unsaved state never follow the display choice')
            page.evaluate("tick(250)")
            self.assertEqual(after, page.evaluate(DRAWN), 'the next refresh keeps the choice')
            # Another account's choice is not this reader's.
            self.publish(page, ['hospital', 'another-reader'], 'cyan', 'standard')
            self.assertEqual(after['lines'], page.evaluate(DRAWN)['lines'])
            self.publish(page, ['hospital', 'reader'], 'default', 'standard')
            self.assertEqual(before, page.evaluate(DRAWN), 'Default/Standard is the annotations\' own look')
            self.assertEqual([], errors)
        finally:
            page.close()

    def test_annotations_drawn_after_the_choice_start_with_it(self):
        page, errors = self.open_page()
        try:
            self.publish(page, ['hospital', 'reader'], 'red', 'thick')
            page.evaluate(MOUNT)
            panel = page.locator('#kin-mpr-marks')
            panel.get_by_label('MPR annotation label', exact=True).fill('Second point')
            panel.get_by_role('button', name='Pick Point', exact=True).click()
            page.mouse.click(POINT[0] + 20, POINT[1] + 20)
            expect(page.locator(STATUS)).to_contain_text('수동 표식을 추가했습니다')
            drawn = page.evaluate(DRAWN)
            self.assertEqual(2, len(drawn['marks']['marks']))
            self.assertEqual({(RED, '2')}, set(map(tuple, drawn['lines'])))
            self.assertEqual({RED}, set(drawn['labels']))
            self.assertEqual([], errors)
        finally:
            page.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
