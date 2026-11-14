# coding: utf-8
"""Auto Save View on the served viewer with owned synthetic CT: with the account check on, W/L, zoom and the image are
saved a moment after they change and put back, with a badge, when the viewer is opened again (a study no Hanging Protocol
is applied to); a viewer closed right after a change still saves it; the saved view is not a Job; with the check off the
viewer opens on its own first view; a Job chosen to open wins over the saved view."""
import json
import time
import uuid

from playwright.sync_api import expect

from invariants_live import psql
from test_viewer_display_menu import ViewerDisplayMenuE2E
from workspace_roaming_support import cleanup_workspace


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"

CHECK = 'Save view changes automatically and apply on reopen'
FIRST = "[...services.viewportGridService.getState().viewports.values()].sort((a, b) => a.y - b.y || a.x - b.x)[0]"
# The first cell: its image (SOP and place), zoom and window, and the badge if one is shown.
STATE = """() => { const g = """ + FIRST + """, v = services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);
  const id = v.getCurrentImageId(), m = cornerstone.metaData.get('instance', id), r = v.getProperties().voiRange;
  const wl = cornerstone.utilities.windowLevel.toWindowLevel(r.lower, r.upper);
  return { index: v.getCurrentImageIdIndex(), sop: m.SOPInstanceUID, zoom: v.getZoom(), w: Math.round(wl.windowWidth), l: Math.round(wl.windowCenter),
    lower: r.lower, upper: r.upper, badge: document.querySelector('[data-auto-view-badge]')?.textContent || null }; }"""
# The reader's change: another image, then a window and a zoom (as the viewer's tools set them).
CHANGE = """([index, w, l, zoom]) => new Promise((resolve, reject) => { const g = """ + FIRST + """;
  const v = services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);
  cornerstone.utilities.jumpToSlice(v.element, { imageIndex: index }).then(() => setTimeout(() => {
    v.setProperties({ voiRange: cornerstone.utilities.windowLevel.toLowHighRange(w, l) }); v.setZoom(zoom); v.render(); setTimeout(resolve, 300);
  }, 300), reject); })"""


class AutoSaveViewE2E(ViewerDisplayMenuE2E):
    def setUp(self):
        super().setUp()
        self.addCleanup(cleanup_workspace, self.stack, 'WorkspaceShortcuts')

    def cleanup_fixtures(self):
        # The run's own Jobs and saved views of its own studies go before the studies do (full-row guards, run authors only).
        for uid in list(self.stack.active):
            for raw in psql(f'SELECT to_jsonb(j)::text FROM "ViewerJob" j WHERE "studyUid"={literal(uid)}'):
                job = json.loads(raw)
                self.assertIn(job['authorSub'], self.stack.user_ids.values())
                sql = f'BEGIN; DELETE FROM "ViewerJobRevision" WHERE "jobId"={literal(job["id"])}::uuid; '
                psql(sql + f'DELETE FROM "ViewerJob" j WHERE to_jsonb(j)={literal(raw)}::jsonb; COMMIT;')
            for raw in psql(f'SELECT to_jsonb(v)::text FROM "ViewerAutoView" v WHERE "studyUid"={literal(uid)}'):
                self.assertIn(json.loads(raw)['authorSub'], self.stack.user_ids.values())
                psql(f'DELETE FROM "ViewerAutoView" v WHERE to_jsonb(v)={literal(raw)}::jsonb')
            self.assertEqual(['0', '0'], [psql(f'SELECT count(*) FROM "{t}" WHERE "studyUid"={literal(uid)}')[0] for t in ('ViewerJob', 'ViewerAutoView')])
        super().cleanup_fixtures()

    @staticmethod
    def counting(page, requests, whole=False):
        """Counts this feature's API requests (its scripts are not requests to the server)."""
        def seen(r):
            path = r.url.split('/api', 1)[-1]
            if '/viewer-auto-view' in path and not path.split('?', 1)[0].endswith('.js'):
                requests.append(r.method + ' ' + (r.url if whole else path))
        page.on('request', seen)

    def window(self, p):
        p.get_by_role('button', name='Display ▾').click()
        p.get_by_role('menu', name='Display').get_by_role('menuitem', name='Auto Save View…', exact=True).click()
        panel = p.locator('section.kin-ux-feature-panel[role=dialog][aria-label="Auto Save View"]')
        expect(panel).to_be_visible()
        return panel

    def switch(self, p, on):
        panel = self.window(p)
        box = panel.get_by_label(CHECK)
        if box.is_checked() != on:
            box.check() if on else box.uncheck()
            expect(panel.get_by_role('status')).to_contain_text('On:' if on else 'Off:', timeout=15000)
        panel.get_by_role('button', name='Close').click()

    def saved(self, f):
        r = self.stack.request('GET', f'/studies/{f.uid}/viewer-auto-view', 'doctor')
        self.assertEqual(r.status, 200, r.text)
        return r.body['view']

    def change(self, p, index, w, l, zoom):
        with p.expect_response(lambda r: r.url.endswith('/viewer-auto-view') and r.request.method == 'POST', timeout=20000) as saving:
            p.evaluate(CHANGE, [index, w, l, zoom])
        self.assertEqual(200, saving.value.status)
        self.settle(p)
        return p.evaluate(STATE)

    def reopen(self, p, f):
        """Closes the viewer window and opens the study again, counting this feature's requests from the first one."""
        p.close()
        page = self.login()
        requests = []
        self.counting(page, requests)
        page.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + f.uid)
        expect(page.get_by_role('button', name='Display ▾')).to_be_visible(timeout=45000)
        return page, requests

    def test_auto_view_01_reopened_with_the_saved_window_zoom_and_image_and_a_badge(self):
        f = self.ct('ASV-' + uuid.uuid4().hex[:12], 'current', '20260801')
        p = self.open_viewer(f)
        self.assertIsNone(self.saved(f))
        self.switch(p, True)
        p.wait_for_timeout(3000)
        self.assertIsNone(self.saved(f), 'nothing is saved before the view changes')
        before = p.evaluate(STATE)
        after = self.change(p, 2, 1500, -600, 2.5)
        print('AUTO-SAVE-VIEW changed ' + json.dumps(dict(before=before, after=after)), flush=True)
        view = self.saved(f)
        self.assertEqual(after['sop'], view['snapshot']['cells'][0]['sop'])
        # The saved view is not a Job.
        jobs = self.stack.request('GET', f'/studies/{f.uid}/viewer-jobs?mine=false&includeHidden=true', 'doctor')
        self.assertEqual((200, []), (jobs.status, jobs.body['jobs']))
        p, requests = self.reopen(p, f)
        p.wait_for_selector('[data-auto-view-badge]', timeout=45000)
        now = p.evaluate(STATE)
        print('AUTO-SAVE-VIEW reopened ' + json.dumps(dict(now=now, requests=requests)), flush=True)
        self.assertEqual((after['sop'], after['index'], after['w'], after['l']), (now['sop'], now['index'], now['w'], now['l']))
        self.assertAlmostEqual(after['zoom'], now['zoom'], places=3)
        self.assertEqual('Restored saved view: Zoom 250%%, W %d / L %d, Image 3' % (after['w'], after['l']), now['badge'])
        # Putting it back saved nothing (the view is the saved one).
        p.wait_for_timeout(3500)
        self.assertEqual(['GET /studies/%s/viewer-auto-view' % f.uid], requests)

    def test_auto_view_02_closed_at_once_still_saved_and_off_opens_the_stock_view(self):
        f = self.ct('ASV-CLOSE-' + uuid.uuid4().hex[:12], 'current', '20260801')
        p = self.open_viewer(f)
        stock = p.evaluate(STATE)
        self.switch(p, True)
        p.wait_for_timeout(1500)
        # A change, and the window closed before the two quiet seconds: the closing window sends it.
        p.evaluate(CHANGE, [3, 400, 40, 2])
        changed = p.evaluate(STATE)
        p.close()
        for _ in range(40):
            view = self.saved(f)
            if view: break
            time.sleep(0.25)
        self.assertIsNotNone(view, 'the closing viewer saved the view')
        self.assertEqual(changed['sop'], view['snapshot']['cells'][0]['sop'])
        # Off: the saved view stays on the server but the viewer neither reads nor applies it.
        p = self.open_viewer(f)
        p.wait_for_selector('[data-auto-view-badge]', timeout=45000)
        self.switch(p, False)
        p, requests = self.reopen(p, f)
        p.wait_for_timeout(5000)
        now = p.evaluate(STATE)
        self.assertEqual((stock['sop'], stock['w'], stock['l'], None), (now['sop'], now['w'], now['l'], now['badge']))
        self.assertEqual([], requests)
        self.assertIsNotNone(self.saved(f), 'a saved view stays until it is discarded')
        # Discard Saved View removes it.
        panel = self.window(p)
        panel.get_by_role('button', name='Discard Saved View').click()
        expect(panel.get_by_role('status')).to_have_text('The saved view of this study was discarded.')
        self.assertIsNone(self.saved(f))

    def test_auto_view_03_a_job_chosen_to_open_wins(self):
        f = self.ct('ASV-JOB-' + uuid.uuid4().hex[:12], 'current', '20260801')
        p = self.open_viewer(f)
        self.switch(p, True)
        p.wait_for_timeout(1500)
        self.change(p, 3, 1500, -600, 2)
        self.assertIsNotNone(self.saved(f))
        # A Job of the first image, saved from the Jobs panel.
        p.evaluate("""() => new Promise(resolve => { const g = """ + FIRST + """, v = services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);
          cornerstone.utilities.jumpToSlice(v.element, { imageIndex: 0 }).then(() => setTimeout(resolve, 500)); })""")
        self.open_layout_tools(p)
        p.get_by_label('Job Title', exact=True).fill('Auto Save View job')
        p.locator('#kin-viewer-jobs').get_by_role('button', name='Save New Job', exact=True).first.click()
        p.wait_for_function("() => /저장했습니다/.test(document.querySelector('#kin-viewer-jobs-status')?.textContent || '')", timeout=45000)
        jobs = self.stack.request('GET', f'/studies/{f.uid}/viewer-jobs?mine=true&includeHidden=false', 'doctor').body['jobs']
        self.assertEqual(1, len(jobs))
        p.close()
        page = self.login()
        requests = []
        self.counting(page, requests, whole=True)
        page.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + f.uid + '&kinJob=' + jobs[0]['id'])
        expect(page.get_by_role('button', name='Display ▾')).to_be_visible(timeout=45000)
        page.wait_for_timeout(5000)
        self.assertEqual(['GET ' + self.stack.proxy + '/api/studies/' + f.uid + '/viewer-auto-view'], requests,
                         'the Discard generation is read without applying the saved view')
        now = page.evaluate(STATE)
        self.assertEqual(0, now['index'], 'the chosen Job wins over the automatically saved image')
        self.assertIsNone(now['badge'])
