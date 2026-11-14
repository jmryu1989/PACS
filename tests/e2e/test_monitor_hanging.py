# coding: utf-8
"""Monitors in Hanging Protocol on the served viewer with owned synthetic CT, on one display (the headless browser says
it has one): the monitors are saved into a rule from Viewer Settings, nothing moves until the rule is applied, applying
it splits the image area into that monitor's grid with its rows on their own edges, and the split screen is saved as a
Job and restored onto a fresh viewer. Two physical displays are checked on a real desktop, not here."""
import json
import uuid

from playwright.sync_api import expect

from test_hanging_protocol import HangingProtocolE2E
from test_prior_selection import canvas_ready, synthetic_ct

RULE_ID = '88888888-8888-4888-8888-888888888888'
CELLS = """() => [...services.viewportGridService.getState().viewports.values()].sort((a, b) => a.y - b.y || a.x - b.x)
  .map(g => ({ x: g.x, y: g.y, width: g.width, height: g.height, sets: g.displaySetInstanceUIDs || [] }))"""
BOXES = """() => { const box = s => { const n = document.querySelector(s); if (!n) return null; const r = n.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  return { column: box('#root :has(> .kin-viewer-series-strip)'), toolbar: box('.kin-ux-toolbar-slot'), thumbs: box('.kin-viewer-series-strip'),
    grid: box('[data-cy=viewport-grid]') }; }"""


class MonitorHangingE2E(HangingProtocolE2E):
    def two_cells(self):
        value = self.library(name='Synthetic Monitors')
        rule = value['rules'][0]
        rule.update(id=RULE_ID, selectors=[rule['selectors'][0]], layout={'rows': 1, 'cols': 2, 'cells': ['Current', 'Current']})
        value['activeRuleId'] = RULE_ID
        return value

    def settle(self, p):
        p.evaluate('() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 300))))')

    def monitors_window(self, p):
        dialog = p.locator('dialog.kin-ux-settings')
        if not dialog.evaluate('n => n.open'):
            p.get_by_role('button', name='Viewer Settings').click()
        dialog.get_by_role('button', name='Monitors in Hanging Protocol…').click()
        panel = p.locator('dialog.kin-ux-feature-panel[aria-label="Monitors in Hanging Protocol"]')
        expect(panel).to_be_visible()
        return panel

    def test_monitors_01_saved_with_the_rule_applied_with_it_and_kept_by_a_job(self):
        f = synthetic_ct(self.stack, 'MON-HP-' + uuid.uuid4().hex[:12], 'current', '20260801', slices=4)
        p = self.launch(self.login(), [f])
        self.import_rules(p, self.two_cells())
        before = p.evaluate(CELLS)
        # Viewer Settings › Monitors in Hanging Protocol…: the rule, one monitor (one display here), its choices.
        panel = self.monitors_window(p)
        expect(panel.get_by_label('Hanging Protocol')).to_have_value(RULE_ID)
        expect(panel.get_by_label('Monitors')).to_have_value('1')
        panel.get_by_label('Monitor 1 Images').select_option('2x1')
        panel.get_by_label('Monitor 1 Thumbnails').select_option('left')
        panel.get_by_label('Monitor 1 Toolbar').select_option('bottom')
        expect(panel.locator('.kin-chrome-monitor')).to_have_attribute('aria-label', 'Monitor 1: Images 2 × 1, Worklist None, Thumbnails Left, Toolbar Bottom')
        panel.get_by_role('button', name='Save').click()
        expect(panel.get_by_role('status')).to_contain_text('Hanging Protocol "Synthetic Monitors"에')
        panel.get_by_role('button', name='Close').click()
        dialog = p.locator('dialog.kin-ux-settings')
        dialog.get_by_role('button', name='Cancel').click(); expect(dialog).to_be_hidden()
        # Save applies nothing.
        self.assertEqual(before, p.evaluate(CELLS))
        self.assertIsNone(p.evaluate("document.body.getAttribute('data-kin-monitor-rows')"))
        # Apply: monitor 1's 2 × 1 grid, the strip on its left, the toolbar at its bottom.
        self.open_layout_tools(p)
        p.locator('#kin-hp-apply').click()
        expect(p.locator('#kin-hp-status')).to_contain_text('Applied', timeout=45000)
        expect(p.locator('#kin-hp-status')).to_contain_text('Monitors: 적용 Monitor 1.')
        canvas_ready(p, 2); self.settle(p)
        cells = p.evaluate(CELLS); boxes = p.evaluate(BOXES)
        print('MONITOR-HANGING cells ' + repr(cells) + ' boxes ' + repr(boxes), flush=True)
        self.assertEqual(2, len(cells))
        self.assertTrue(all(c['sets'] for c in cells))
        self.assertAlmostEqual(cells[0]['x'], cells[1]['x'], delta=1e-6); self.assertLess(cells[0]['y'], cells[1]['y'])
        column, toolbar, thumbs, grid = boxes['column'], boxes['toolbar'], boxes['thumbs'], boxes['grid']
        self.assertAlmostEqual(column['bottom'], toolbar['bottom'], delta=1); self.assertAlmostEqual(36, toolbar['height'], delta=1)
        self.assertAlmostEqual(column['left'], thumbs['left'], delta=1); self.assertAlmostEqual(156, thumbs['width'], delta=1)
        for c in cells:
            self.assertGreaterEqual(grid['left'] + c['x'] * grid['width'] + 1, thumbs['right'], 'no cell under the strip')
            self.assertLessEqual(grid['top'] + (c['y'] + c['height']) * grid['height'] - 1, toolbar['top'], 'no cell under the toolbar')
        expect(p.get_by_role('button', name='Viewer Settings')).to_be_visible()
        # Saved as a Job (the split is its own shape, version 16) and restored onto a fresh viewer.
        self.addCleanup(self.cleanup_jobs, f.uid)
        expect(p.locator('#kin-viewer-jobs-status')).to_contain_text('저장 작업 목록', timeout=45000)
        p.get_by_label('Job Title', exact=True).fill('Monitor split job')
        p.get_by_role('button', name='Save New Job', exact=True).click()
        expect(p.locator('#kin-viewer-jobs-status')).to_contain_text('저장했습니다', timeout=45000)
        listed = self.stack.request('GET', f'/studies/{f.uid}/viewer-jobs', 'doctor')
        self.assertEqual(200, listed.status, listed.text); self.assertEqual(1, len(listed.body['jobs']))
        job = self.stack.request('GET', f"/studies/{f.uid}/viewer-jobs/{listed.body['jobs'][0]['id']}", 'doctor')
        self.assertEqual(200, job.status, job.text); stored = job.body['snapshot']
        self.assertEqual(16, stored['version']); self.assertIsNone(stored['volume'])
        self.assertEqual(2, len(stored['rects'])); self.assertEqual(['stack', 'stack'], [c['kind'] for c in stored['cells']])
        for saved, shown in zip(stored['rects'], cells):
            for key in ('x', 'y', 'width', 'height'):
                self.assertAlmostEqual(saved[key], shown[key], delta=1e-6)
        target = self.launch(self.login(), [f])
        self.open_layout_tools(target)
        expect(target.locator('#kin-viewer-jobs-status')).to_contain_text('저장 작업 목록', timeout=45000)
        expect(target.get_by_text('Monitor Split Layout · 출력 미지원')).to_be_visible()
        self.assertEqual(1, len(target.evaluate(CELLS)))
        target.get_by_role('button', name='Restore Job', exact=True).click()
        expect(target.locator('#kin-viewer-jobs-status')).to_contain_text('모니터별로 나눈 칸 배치를 복원했습니다', timeout=45000)
        restored = target.evaluate(CELLS)
        self.assertEqual(2, len(restored))
        for saved, shown in zip(stored['rects'], restored):
            for key in ('x', 'y', 'width', 'height'):
                self.assertAlmostEqual(saved[key], shown[key], delta=1e-6)
        # Saved again from the restored screen: the same shape.
        target.get_by_label('Job Title', exact=True).fill('Monitor split recapture')
        target.get_by_role('button', name='Save New Job', exact=True).click()
        expect(target.locator('#kin-viewer-jobs-status')).to_contain_text('저장했습니다', timeout=45000)
        rows = self.stack.request('GET', f'/studies/{f.uid}/viewer-jobs', 'doctor').body['jobs']
        again_id = next(r['id'] for r in rows if r['title'] == 'Monitor split recapture')
        again = self.stack.request('GET', f'/studies/{f.uid}/viewer-jobs/{again_id}', 'doctor').body['snapshot']
        self.assertEqual(16, again['version']); self.assertEqual(stored['rects'], again['rects'])

    def test_monitors_02_a_split_with_planes_and_frames_keeps_every_original_checked(self):
        # Plane cells and an ordinary frame cell, split by monitor 1's bands: the Job is version 16 with a volume, and the
        # server verifies the whole volume and the frame cell's own original (its digest is kept; a foreign one is refused).
        current = self.multiple('MON-MIXED-' + uuid.uuid4().hex[:12], 'current', '20260801')
        p = self.launch(self.login(), [current])
        value = self.mixed_library('Synthetic Monitors Mixed')
        value['rules'][0]['monitors'] = {'count': 1, 'list': [{'images': 'auto', 'worklist': 'none', 'thumbs': 'left', 'toolbar': 'top'}]}
        self.import_rules(p, value)
        self.apply(p, 'Applied')
        expect(p.locator('#kin-hp-status')).to_contain_text('Monitors: 적용 Monitor 1.')
        self.rendered_planes(p, 3)
        cells = self.planes(p)
        self.assertEqual(['orthographic', 'stack', 'orthographic', None], [cell['type'] for cell in cells])
        shown = p.evaluate(CELLS)
        self.assertNotEqual(0, shown[0]['x'], 'the strip on the left takes a band of monitor 1')
        rule_id = value['rules'][0]['id']
        self.addCleanup(self.cleanup_jobs, current.uid)
        expect(p.locator('#kin-viewer-jobs-status')).to_contain_text('저장 작업 목록', timeout=45000)
        p.get_by_label('Job Title', exact=True).fill('Monitor split mixed job')
        p.get_by_role('button', name='Save New Job', exact=True).click()
        expect(p.locator('#kin-viewer-jobs-status')).to_contain_text('저장했습니다', timeout=45000)
        listed = self.stack.request('GET', f'/studies/{current.uid}/viewer-jobs', 'doctor').body['jobs']
        stored = self.stack.request('GET', f"/studies/{current.uid}/viewer-jobs/{listed[0]['id']}", 'doctor').body['snapshot']
        print('MONITOR-HANGING mixed ' + repr({k: stored[k] for k in ('version', 'rows', 'cols', 'rects', 'active')}), flush=True)
        self.assertEqual(16, stored['version'])
        self.assertEqual(['plane', 'stack', 'plane'], [c['kind'] for c in stored['cells'][:3]]); self.assertIsNone(stored['cells'][3])
        self.assertEqual(64, len(stored['volume']['sourceDigest']))
        self.assertRegex(stored['cells'][1]['sourceDigest'], r'^[0-9a-f]{32}$', 'the frame cell was verified against its own original')
        forged = json.loads(json.dumps(stored)); del forged['volume']['sourceDigest']
        for cell in forged['cells']:
            if cell is not None:
                cell.pop('sourceDigest', None)
        forged['cells'][1]['sop'] = forged['volume']['sops'][0]
        denied = self.stack.request('POST', f'/studies/{current.uid}/viewer-jobs', 'doctor',
                                    dict(id=str(uuid.uuid4()), title='Rejected split', description='', snapshot=forged))
        self.assertEqual(400, denied.status, denied.text)
        self.assertEqual(1, len(self.stack.request('GET', f'/studies/{current.uid}/viewer-jobs', 'doctor').body['jobs']))
        self.assertTrue(rule_id)
