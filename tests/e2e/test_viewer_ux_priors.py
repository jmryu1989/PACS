"""U3-F1..F4: real workspace -> shipped OHIF, API reports and synthetic CT.

No replacement page, controller, markup or display-set renderer. Faults delay
or fail actual network reads only after the normally served baseline renders.
"""
import hashlib
import json
import os
from pathlib import Path
import unittest
import uuid

from playwright.sync_api import expect
from document_session import document_request
from test_viewer_layout import ViewerLayoutE2E
from test_prior_selection import canvas_ready


class ViewerUXPriorsE2E(ViewerLayoutE2E):
    def evidence(self, page, name):
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/viewer-ux-u3/screens'))
        folder.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(folder / (name + '.png')))
        observed = page.evaluate('''() => ({
          url:location.href,browser:navigator.userAgent,size:[innerWidth,innerHeight,devicePixelRatio],
          patient:KinViewerPatientTabs.snapshot(),
          assets:performance.getEntriesByType('resource').map(r=>r.name).filter(n=>/ohif|viewer-prior|viewer-ux/.test(n)),
          cells:[...services.viewportGridService.getState().viewports.keys()].map(id=>{
            const v=services.cornerstoneViewportService.getCornerstoneViewport(id),image=v?.getCurrentImageId?.();
            const m=image&&cornerstone.metaData.get('instance',image);
            return {id,image,study:m?.StudyInstanceUID,series:m?.SeriesInstanceUID,sop:m?.SOPInstanceUID,status:v?.viewportStatus,
              canvas:v?.canvas&&[v.canvas.width,v.canvas.height,v.canvas.clientWidth,v.canvas.clientHeight,devicePixelRatio]};
          })})''')
        observed['served_files'] = {}
        for relative in ['config/ohif.js', 'worklist-v0/hpacs-lite/viewer-ux-shell.js',
                         'worklist-v0/hpacs-lite/viewer-ux-toolbar.js',
                         'worklist-v0/hpacs-lite/viewer-prior-controller.js',
                         'worklist-v0/hpacs-lite/viewer-prior-panel.js']:
            url = '/ohif/app-config.js' if relative == 'config/ohif.js' else '/' + relative.replace('worklist-v0/', 'worklist/')
            response = page.request.get(self.stack.proxy + url)
            self.assertEqual(response.status, 200)
            digest = hashlib.sha256(response.body()).hexdigest()
            source = (Path(__file__).resolve().parents[2] / relative).read_bytes()
            # Orthanc wraps app-config.js around the configured source. Verify
            # that source verbatim; standalone served assets have no wrapper.
            if relative == 'config/ohif.js':
                self.assertTrue(source in response.body(), 'Served OHIF wrapper must contain the current configuration')
            else:
                self.assertEqual(digest, hashlib.sha256(source).hexdigest())
            observed['served_files'][url] = digest
        (folder / (name + '.json')).write_text(json.dumps(observed, indent=2), encoding='utf-8')

    def tearDown(self):
        if any(test is self for test, _ in self._outcome.result.failures + self._outcome.result.errors):
            for context in self.contexts:
                for index, page in enumerate(context.pages):
                    if '/ohif/viewer' in page.url:
                        try: self.evidence(page, 'failure-' + self._testMethodName + '-' + str(index))
                        except Exception as error: print('Failure capture:', str(error)[:160])
        super().tearDown()

    def open_viewer(self, current):
        work = self.login()
        self.open_toolbar_group(work, '#image-opening-open')
        work.locator('#image-opening-open').click()
        work.get_by_label('Include Latest Prior', exact=True).uncheck()
        work.get_by_role('button', name='Done', exact=True).click()
        self.select(work, current)
        with work.context.expect_page() as opened: work.locator('#m-filmbox').click()
        page = opened.value
        # Accept the existing frame-coverage confirmation as a user would;
        # unvisited synthetic slices must not silently cancel image navigation.
        page.on('dialog', lambda dialog: dialog.accept())
        canvas_ready(page, 1)
        page.wait_for_function('''() => window.KinViewerUX && !kinViewerHistoryWorkspaceState().busy && !kinViewerJobWorkspaceState().busy''')
        return work, page

    def studies(self, page, cell=0):
        page.get_by_role('region', name='Viewport Information').nth(cell).get_by_role('button', name='Study', exact=False).click()
        panel = page.get_by_role('region', name='Studies', exact=True)
        expect(panel.get_by_role('table')).to_be_visible()
        return panel

    def row(self, panel, label):
        return panel.get_by_role('row').filter(has=panel.page.get_by_role('button', name='D03A ' + label, exact=True))

    def report_panel(self, page):
        return page.get_by_role('region', name='Previous Report', exact=True)

    def test_priors_01_list_compare_report_keyboard(self):
        patient = 'U3-' + uuid.uuid4().hex[:12]
        current = self.ct(patient, 'current', '20260801')
        x = self.ct(patient, 'prior X', '20260701')
        y = self.ct(patient, 'prior Y', '20250601')
        unknown = self.ct(patient, 'undated', '')
        other = self.ct('U3-OTHER-' + uuid.uuid4().hex[:8], 'other patient', '20250101')
        self.seed_report(y, 'approve', findings='Original Y findings\nSecond line')
        head = self.versions(y)[-1]
        self.seed_report(current)
        work, page = self.open_viewer(current)
        work.locator('#findings').fill('Retained private draft')
        work.locator('#findings').evaluate('e=>e.setSelectionRange(3,7)')
        writes = self.source_writes(page)
        state_before = self.report_rows(current)
        document = page.evaluate('performance.timeOrigin')
        panel = self.studies(page)
        expect(panel.get_by_role('row')).to_have_count(5)
        expect(panel).not_to_contain_text(other.patient_id)
        expect(self.row(panel, 'undated')).to_contain_text('Unknown-date Comparison')
        expect(self.row(panel, 'prior X')).to_contain_text('Prior')
        expect(self.row(panel, 'prior Y')).to_contain_text('Prior')
        before = self.cells(page)
        images = panel.get_by_role('button', name='D03A prior Y', exact=True)
        images.click(button='right')
        report = self.report_panel(page)
        expect(report).to_contain_text(head['findings'])
        expect(report).to_contain_text('Version ' + str(head['version']))
        expect(report).to_contain_text(head['author'])
        expect(report).to_contain_text(head['at'])
        expect(report).to_contain_text(y.uid)
        self.assertEqual(report.locator('input,textarea,[contenteditable=true]').count(), 0)
        self.assertEqual(self.cells(page), before)
        report.get_by_role('button', name='Close', exact=True).click()
        expect(images).to_be_focused()
        page.keyboard.press('Shift+F10')
        expect(report).to_contain_text(y.uid)
        report.get_by_role('button', name='Close', exact=True).click()
        images.press('ContextMenu')
        expect(report).to_contain_text(head['findings'])
        report.get_by_role('button', name='Close', exact=True).click()
        self.evidence(page, 'direct-study-list')
        # X has not been in the route or a chooser. Its first click loads the
        # real native data source and creates a current-preserving comparison.
        panel.get_by_role('button', name='D03A prior X', exact=True).press('Enter')
        self.identity(page, [self.fixture_refs(page, current)[0], self.fixture_refs(page, x)[0]])
        self.assertEqual(self.cells(page)[0]['image'], before[0]['image'])
        panel = self.studies(page)
        panel.get_by_role('button', name='D03A prior Y', exact=True).press('Space')
        self.identity(page, [self.fixture_refs(page, current)[0], self.fixture_refs(page, y)[0]])
        # The assigned prior cell itself is a valid Study origin, too.
        panel = self.studies(page, 1)
        panel.get_by_role('button', name='D03A prior X', exact=True).click()
        self.identity(page, [self.fixture_refs(page, current)[0], self.fixture_refs(page, x)[0]])
        panel = self.studies(page)
        self.row(panel, 'prior Y').get_by_role('button', name='Report', exact=True).click()
        expect(report).to_contain_text(head['findings'])
        self.evidence(page, 'prior-report-overlay')
        self.assertEqual(page.evaluate('performance.timeOrigin'), document)
        self.assertEqual(len(work.context.pages), 2)
        expect(work.locator('#findings')).to_have_value('Retained private draft')
        self.assertEqual(work.locator('#findings').evaluate('e=>[e.selectionStart,e.selectionEnd]'), [3,7])
        expect(work.locator('#rows tr.sel')).to_have_attribute('data-uid', current.uid)
        self.assertEqual(self.report_rows(current), state_before)
        self.assertEqual(writes, [])
        # Opening the list never suppresses native contextmenu on the canvas.
        report.get_by_role('button', name='Close', exact=True).click()
        panel.get_by_role('button', name='Close', exact=True).click()
        page.locator('[data-cy="viewport-pane"] canvas').first.click(button='right', position={'x':30,'y':30})
        expect(report).not_to_be_visible()
        expect(page.get_by_role('region', name='Viewport Information').first).to_contain_text(patient)

    def test_priors_02_empty_reset_error_retry(self):
        patient = 'U3-' + uuid.uuid4().hex[:12]
        current = self.ct(patient, 'only current', '20260801')
        work, page = self.open_viewer(current)
        panel = self.studies(page)
        expect(panel).to_contain_text('이 환자의 이전 날짜 검사가 없습니다.')
        panel.get_by_role('button', name='Report', exact=True).click()
        report = self.report_panel(page)
        expect(report).to_contain_text('현재 유효한 승인 판독문이 없습니다.')
        report.get_by_role('button', name='Close', exact=True).click()
        panel.get_by_role('button', name='Close', exact=True).click()
        x = self.ct(patient, 'reset prior', '20260701')
        self.seed_report(x, 'approve', findings='Superseded approval')
        result = self.stack.request('POST', f'/studies/{x.uid}/report/commit', 'doctor',
            {'action':'reset','baseVersion':1,'reason':'Synthetic reset'})
        self.assertEqual(result.status, 201)
        panel = self.studies(page)
        expect(panel.get_by_role('row')).to_have_count(3)
        row = self.row(panel, 'reset prior')
        endpoint = '**/api/studies/' + x.uid + '/report/versions'
        page.route(endpoint, lambda route: route.fulfill(status=503, body='Unavailable'), times=1)
        row.get_by_role('button', name='Report', exact=True).click()
        expect(report.get_by_role('button', name='Retry', exact=True)).to_be_visible()
        with page.expect_response(lambda response: response.url.endswith('/' + x.uid + '/report/versions')) as reply:
            report.get_by_role('button', name='Retry', exact=True).click()
        self.assertEqual(reply.value.status, 200)
        expect(report).to_contain_text('현재 유효한 승인 판독문이 없습니다.')
        expect(report).not_to_contain_text('Superseded approval')
        report.get_by_role('button', name='Close', exact=True).click()
        panel.get_by_role('button', name='Close', exact=True).click()
        page.route('**/api/studies', lambda route: route.fulfill(status=503, body='Unavailable'), times=1)
        page.get_by_role('region', name='Viewport Information').get_by_role('button', name='Study', exact=False).click()
        expect(panel.get_by_role('button', name='Retry', exact=True)).to_be_visible()
        panel.get_by_role('button', name='Retry', exact=True).click()
        expect(panel.get_by_role('table')).to_be_visible()
        panel.get_by_role('button', name='Close', exact=True).click()
        page.route('**/api/studies', lambda route: route.fulfill(json={'studies': []}), times=1)
        page.get_by_role('region', name='Viewport Information').get_by_role('button', name='Study', exact=False).click()
        expect(panel).to_contain_text('검사를 확인할 수 없습니다.')
        expect(panel.get_by_role('table')).to_have_count(0)
        panel.get_by_role('button', name='Close', exact=True).click()
        self.studies(page)
        self.evidence(page, 'report-reset-and-retry')

    def test_priors_03_late_reads_close_patient_and_viewport(self):
        patient = 'U3-' + uuid.uuid4().hex[:12]
        a = self.multiple(patient, 'current A', '20260801')
        x = self.ct(patient, 'report X', '20260701')
        y = self.ct(patient, 'report Y', '20260601')
        b = self.ct('U3-B-' + uuid.uuid4().hex[:12], 'current B', '20260801')
        self.seed_report(x, 'approve', findings='Body X')
        self.seed_report(y, 'approve', findings='Body Y')
        work, page = self.open_viewer(a)
        report = self.report_panel(page)
        panel = self.studies(page)
        def release(held):
            for route, response in held:
                try: route.fulfill(response=response)
                except Exception: pass  # The replaced request has been aborted.
        def hold_x():
            held = []
            page.route('**/api/studies/' + x.uid + '/report/versions', lambda route: held.append((route, route.fetch())), times=1)
            return held
        held = hold_x()
        with page.expect_request(lambda r: r.url.endswith('/' + x.uid + '/report/versions')):
            self.row(panel, 'report X').get_by_role('button', name='Report', exact=True).click()
        expect(report).to_contain_text('불러오는 중')
        expect(report).not_to_contain_text('Body X')
        panel = self.studies(page)
        self.row(panel, 'report Y').get_by_role('button', name='Report', exact=True).click()
        expect(report).to_contain_text('Body Y')
        result = self.stack.request('POST', f'/studies/{x.uid}/report/commit', 'doctor',
            {'action': 'addendum', 'baseVersion': 1, 'findings': 'Updated body X',
             'conclusion': '', 'recommendation': ''})
        self.assertEqual(result.status, 201)
        panel = self.studies(page)
        self.row(panel, 'report X').get_by_role('button', name='Report', exact=True).click()
        expect(report).to_contain_text('Updated body X')
        release(held)
        expect(report).to_contain_text(x.uid)
        expect(report).to_contain_text('Updated body X')
        expect(report).not_to_contain_text('Body X')
        panel = self.studies(page)
        held = hold_x()
        self.row(panel, 'report X').get_by_role('button', name='Report', exact=True).click()
        expect(report).to_contain_text('불러오는 중')
        report.get_by_role('button', name='Close', exact=True).click()
        release(held)
        expect(report).not_to_be_visible()
        self.row(panel, 'report Y').get_by_role('button', name='Report', exact=True).click()
        expect(report).to_contain_text('Body Y')
        panel = self.studies(page)
        held = hold_x()
        self.row(panel, 'report X').get_by_role('button', name='Report', exact=True).click()
        self.select(work, b); work.locator('#m-filmbox').click()
        tabs = page.get_by_role('tablist', name='Patients')
        expect(tabs.get_by_role('tab')).to_have_count(2, timeout=45000)
        canvas_ready(page, 1)
        expect(report).not_to_be_visible()
        expect(panel).not_to_be_visible()
        page.wait_for_function('!kinViewerHistoryWorkspaceState().busy && !kinViewerJobWorkspaceState().busy')
        tabs.get_by_role('tab').filter(has_text=patient).click()
        canvas_ready(page, 1)
        release(held)
        expect(report).not_to_be_visible()
        panel = self.studies(page)
        self.row(panel, 'report Y').get_by_role('button', name='Report', exact=True).click()
        expect(report).to_contain_text('Body Y')
        report.get_by_role('button', name='Close', exact=True).click()
        held = hold_x()
        self.row(panel, 'report X').get_by_role('button', name='Report', exact=True).click()
        page.get_by_role('region', name='Series', exact=True).get_by_role('button', name='2/2 D02E second series', exact=False).click()
        release(held)
        expect(report).not_to_be_visible()
        self.evidence(page, 'cancelled-contexts')

    def test_priors_04_cancel_image_load_and_removed_viewport(self):
        patient = 'U3-' + uuid.uuid4().hex[:12]
        current = self.ct(patient, 'current', '20260801')
        x = self.ct(patient, 'delayed X', '20260701')
        y = self.ct(patient, 'chosen Y', '20260601')
        self.seed_report(y, 'approve', findings='Chosen Y report')
        work, page = self.open_viewer(current)
        panel = self.studies(page)
        held = []
        page.route('**/dicom-web/studies/' + x.uid + '/**',
                   lambda route: held.append((route, route.fetch())), times=1)
        with page.expect_request(lambda request: '/dicom-web/studies/' + x.uid + '/' in request.url):
            panel.get_by_role('button', name='D03A delayed X', exact=True).click()
        expect(panel).to_contain_text('영상을 불러오는 중')
        panel.get_by_role('button', name='Close', exact=True).click()
        panel = self.studies(page)
        panel.get_by_role('button', name='D03A chosen Y', exact=True).click()
        expected = [self.fixture_refs(page, current)[0], self.fixture_refs(page, y)[0]]
        self.identity(page, expected)
        self.assertTrue(held, 'The native X metadata read must have reached the real network boundary')
        for route, response in held:
            route.fulfill(response=response)
        page.wait_for_function('uid => services.displaySetService.getActiveDisplaySets().some(set => set.StudyInstanceUID === uid)', arg=x.uid)
        self.identity(page, expected)
        panel = self.studies(page, 1)
        reports = []
        page.route('**/api/studies/' + y.uid + '/report/versions',
                   lambda route: reports.append((route, route.fetch())), times=1)
        self.row(panel, 'chosen Y').get_by_role('button', name='Report', exact=True).click()
        report = self.report_panel(page)
        expect(report).to_contain_text('불러오는 중')
        self.grid(page, 1)
        canvas_ready(page, 1)
        expect(report).not_to_be_visible()
        self.assertTrue(reports)
        for route, response in reports:
            try: route.fulfill(response=response)
            except Exception: pass  # Removing the originating viewport aborts this read.
        expect(report).not_to_be_visible()
        self.evidence(page, 'cancelled-image-and-removed-viewport')

    def test_priors_05_populated_grid_preserves_origin(self):
        patient = 'U3-' + uuid.uuid4().hex[:12]
        current = self.ct(patient, 'current grid', '20260801')
        prior = self.ct(patient, 'grid prior', '20260701')
        work, page = self.open_viewer(current)
        self.grid(page, 4)
        # Populate the native grid through its public assignment boundary. All
        # four cells are real Cornerstone viewports, not a replacement renderer.
        page.evaluate('''() => {
          const grid = services.viewportGridService;
          const cells = [...grid.getState().viewports.values()];
          const source = cells.find(cell => cell.displaySetInstanceUIDs?.length);
          for (const cell of cells) if (!cell.displaySetInstanceUIDs?.length)
            grid.setDisplaySetsForViewport({ viewportId: cell.viewportId,
              displaySetInstanceUIDs: source.displaySetInstanceUIDs });
        }''')
        current_ref = self.fixture_refs(page, current)[0]
        self.identity(page, [current_ref] * 4)
        before = self.cells(page)[3]['image']
        panel = self.studies(page, 3)
        panel.get_by_role('button', name='D03A grid prior', exact=True).click()
        self.identity(page, [current_ref, self.fixture_refs(page, prior)[0]])
        self.assertEqual(self.cells(page)[0]['image'], before)
        # A retained canvas can still contain the correct SOP while CSS stretches
        # its old bitmap. Await the native resize/render, not just image identity.
        page.wait_for_function('''() => [...services.viewportGridService.getState().viewports.keys()].every(id => {
          const canvas=services.cornerstoneViewportService.getCornerstoneViewport(id)?.canvas;
          return canvas && canvas.width===canvas.clientWidth*devicePixelRatio &&
            canvas.height===canvas.clientHeight*devicePixelRatio;
        })''')
        self.evidence(page, 'populated-grid-comparison')


    def test_priors_06_mg_account_preferences(self):
        # D1821 -> RISK-WRONG-STUDY/PREFERENCE-LOSS -> TEST-VIEWER-U3-MG.
        # Real DICOM and account API; browser contexts model a fresh PC login.
        from test_mammography_hanging import MammographyHangingE2E as MG
        patient = 'U3MG-' + uuid.uuid4().hex[:12]
        current = MG.phantom(self, patient)
        prior = MG.phantom(self, patient, prior=True)
        work = self.login()
        self.open_toolbar_group(work, '#image-opening-open')
        work.locator('#image-opening-open').click()
        work.get_by_label('Include Latest Prior', exact=True).check()
        work.get_by_role('button', name='Done', exact=True).click()
        self.select(work, current)
        with work.context.expect_page() as opened: work.locator('#m-filmbox').click()
        page = opened.value
        page.on('dialog', lambda dialog: dialog.accept())
        url = page.url

        def layout(target, compare):
            canvas_ready(target, 8 if compare else 4)
            target.wait_for_function('n=>window.services?.viewportGridService.getState().viewports.size===n',
                                     arg=8 if compare else 4)
            rows = MG.image_state(self, target)
            self.assertEqual({row['study'] for row in rows}, {current.uid, prior.uid} if compare else {current.uid})
            self.assertEqual([(r['side'], r['view']) for r in rows],
                             [('R','CC'),('L','CC'),('R','CC'),('L','CC'),('R','MLO'),('L','MLO'),('R','MLO'),('L','MLO')]
                             if compare else [('R','CC'),('L','CC'),('R','MLO'),('L','MLO')])
            expect(target.get_by_role('button', name='Viewer Settings', exact=True)).to_be_enabled()

        def editor(target):
            target.get_by_role('button', name='Viewer Settings', exact=True).click()
            dialog = target.get_by_role('dialog', name='Viewer Settings', exact=True)
            expect(dialog.get_by_role('button', name='Save', exact=True)).to_be_enabled()
            return dialog

        def save(target, dialog):
            with target.expect_response(lambda r: r.url.endswith('/api/workspace-shortcuts') and r.request.method == 'PUT') as reply:
                dialog.get_by_role('button', name='Save', exact=True).click()
            self.assertEqual(reply.value.status, 200)
            expect(dialog).not_to_be_visible()
            persisted = document_request(target, 'GET', '/api/workspace-shortcuts')
            self.assertEqual(persisted.status, 200)
            return persisted.json()

        layout(page, True)
        url = page.url
        settings = editor(page)
        expect(settings.get_by_label('MG Layout', exact=True)).to_have_value('compare')
        expect(settings.get_by_label('MG Image Type', exact=True)).to_have_value('')
        self.evidence(page, 'mg-settings-default')
        settings.get_by_label('MG Layout', exact=True).select_option('current')
        settings.get_by_label('MG Image Type', exact=True).select_option('conventional')
        saved = save(page, settings)
        self.assertEqual(saved['viewerSettings']['mammography'], {'layout':'current','kind':'conventional'})
        turn_keys = {'flipHorizontal': 'shift+h', 'flipVertical': 'shift+v',
                     'rotate-left': 'shift+l', 'rotate-right': 'shift+r'}
        self.assertEqual({key: saved['viewerSettings']['shortcuts'][key] for key in turn_keys}, turn_keys)
        layout(page, False)
        self.evidence(page, 'mg-current-account-setting')
        fresh_work = self.login()
        fresh = fresh_work.context.new_page()
        fresh.goto(url)
        layout(fresh, False)
        settings = editor(fresh)
        expect(settings.get_by_label('MG Image Type', exact=True)).to_have_value('conventional')
        settings.get_by_role('button', name='Cancel', exact=True).click()
        other_work = self.login('doctor2')
        other = other_work.context.new_page()
        other.goto(url)
        layout(other, True)
        other.close()
        # Existing MG quick controls persist through the same owner/revision boundary.
        self.open_layout_tools(fresh)
        with fresh.expect_response(lambda r: r.url.endswith('/api/workspace-shortcuts') and r.request.method == 'PUT') as reply:
            fresh.locator('#kin-mammography-hanging').get_by_label('MG Layout', exact=True).select_option('compare')
        self.assertEqual(reply.value.status, 200)
        layout(fresh, True)
        # An older PC must reload on CAS conflict; its attempted preference cannot overwrite the newer one.
        settings = editor(page)
        settings.get_by_label('MG Image Type', exact=True).select_option('dbt')
        with page.expect_response(lambda r: r.url.endswith('/api/workspace-shortcuts') and r.request.method == 'PUT') as reply:
            settings.get_by_role('button', name='Save', exact=True).click()
        self.assertEqual(reply.value.status, 409)
        expect(settings).to_be_visible()
        settings.get_by_role('button', name='Cancel', exact=True).click()
        page.get_by_role('button', name='Reload Settings', exact=True).click()
        layout(page, True)
        # A failed write leaves the saved default and exposes recovery.
        fresh.route('**/api/workspace-shortcuts', lambda route: route.fulfill(status=503, json={'message':'Synthetic unavailable'})
                    if route.request.method == 'PUT' else route.continue_(), times=1)
        with fresh.expect_response(lambda r: r.url.endswith('/api/workspace-shortcuts') and r.request.method == 'PUT') as reply:
            fresh.locator('#kin-mammography-hanging').get_by_label('MG Layout', exact=True).select_option('current')
        self.assertEqual(reply.value.status, 503)
        layout(fresh, True)
        expect(fresh.get_by_role('button', name='Reload Settings', exact=True)).to_be_visible()
        settings = editor(fresh)
        settings.get_by_role('button', name='Restore Defaults', exact=True).click()
        reset = save(fresh, settings)
        self.assertEqual(reset['viewerSettings']['mammography'], {'layout':'compare','kind':None})
        fresh.reload()
        layout(fresh, True)
        self.evidence(fresh, 'mg-comparison-roamed-default')
        # Lack of a prior changes only the effective hanging, not the persisted preference.
        fresh.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + current.uid)
        layout(fresh, False)
        settings = editor(fresh)
        expect(settings.get_by_label('MG Layout', exact=True)).to_have_value('compare')
        settings.get_by_role('button', name='Cancel', exact=True).click()
        self.open_layout_tools(fresh)
        with fresh.expect_response(lambda r: r.url.endswith('/api/workspace-shortcuts') and r.request.method == 'PUT') as reply:
            fresh.locator('#kin-mammography-hanging').get_by_label('MG Image Type', exact=True).select_option('conventional')
        self.assertEqual(reply.value.status, 200)
        self.assertEqual(reply.value.json()['viewerSettings']['mammography'], {'layout':'compare','kind':'conventional'})
        fresh.goto(url)
        layout(fresh, True)

        # A v1 account created before U2 must retain MG through the first v2 toolbar save.
        record = document_request(fresh, 'GET', '/api/workspace-shortcuts').json()
        legacy = {**record['viewerSettings'], 'version': 1, 'mammography': {'layout': 'current', 'kind': 'conventional'}}
        # v1 could only store plain keys; its unassigned turn keys were null/absent.
        legacy['shortcuts'] = {key: None if key in turn_keys else value for key, value in legacy['shortcuts'].items()}
        response = document_request(fresh, 'PUT', '/api/workspace-shortcuts', headers={'X-KIN-CSRF': '1'},
                                    data={'expectedOwner': record['owner'], 'revision': record['revision'], 'viewerSettings': legacy})
        self.assertEqual(response.status, 200)
        migrated_work = self.login()
        migrated = migrated_work.context.new_page()
        migrated.goto(url)
        migrated.on('dialog', lambda dialog: dialog.accept())
        layout(migrated, False)
        tools = migrated.get_by_role('region', name='Image Tools', exact=True)
        with migrated.expect_response(lambda r: r.url.endswith('/api/workspace-shortcuts') and r.request.method == 'PUT') as reply:
            tools.get_by_role('toolbar', name='Frequent Tools').get_by_role('button', name='Zoom', exact=True).drag_to(tools.locator('summary'))
        self.assertEqual(reply.value.status, 200)
        persisted = document_request(migrated, 'GET', '/api/workspace-shortcuts')
        self.assertEqual(persisted.status, 200)
        self.assertEqual(persisted.json()['viewerSettings']['version'], 2)
        self.assertEqual(persisted.json()['viewerSettings']['mammography'], legacy['mammography'])
        self.assertEqual({key: persisted.json()['viewerSettings']['shortcuts'][key] for key in turn_keys}, turn_keys)
        # Read the U3-written v2 record in a fresh document; test actual native actions.
        migrated.reload(); layout(migrated, False)
        migrated.wait_for_function('() => !kinViewerHistoryWorkspaceState().busy && !kinViewerJobWorkspaceState().busy')
        view = '''() => {const v=services.cornerstoneViewportService.getCornerstoneViewport(
          services.viewportGridService.getActiveViewportId()), c=v.getCamera();
          return [!!c.flipHorizontal,!!c.flipVertical,(Math.round(v.getViewPresentation().rotation)%360+360)%360];}'''
        for key, expected in [('Shift+H',[True,False,0]), ('Shift+V',[True,True,0]),
                              ('Shift+H',[False,True,0]), ('Shift+V',[False,False,0]),
                              ('Shift+L',[False,False,270]), ('Shift+R',[False,False,0])]:
            migrated.keyboard.press(key)
            migrated.wait_for_function('expected => JSON.stringify((' + view + ')()) === JSON.stringify(expected)', arg=expected)
        settings = editor(migrated)
        settings.get_by_label('MG Layout', exact=True).select_option('compare')
        settings.get_by_label('MG Image Type', exact=True).select_option('dbt')
        save(migrated, settings)
        layout(migrated, True)
        migrated.reload(); layout(migrated, True)
        self.evidence(migrated, 'dbt-default-conventional-fallback')
        settings = editor(migrated)
        settings.get_by_label('MG View Order', exact=True).select_option('MLO-CC')
        settings.get_by_label('MG Breast Order', exact=True).select_option('L-R')
        settings.get_by_label('MG Prior Position', exact=True).select_option('top')
        settings.get_by_label('MG Comparison Grid', exact=True).select_option('2')
        save(migrated, settings)
        migrated.reload(); canvas_ready(migrated, 8)
        rows = MG.image_state(self, migrated)
        self.assertEqual([(r['study'], r['side'], r['view']) for r in rows],
                         [(study, side, view) for study in [prior.uid, current.uid] for view in ['MLO', 'CC'] for side in ['L', 'R']])
        self.assertEqual(migrated.evaluate('services.viewportGridService.getState().layout.numRows'), 4)
        self.evidence(migrated, 'mg-custom-arrangement-fresh-login')
        for position, columns in [('right', 2), ('left', 2), ('right', 8), ('bottom', 1)]:
            settings = editor(migrated)
            settings.get_by_label('MG Prior Position', exact=True).select_option(position)
            grid = settings.get_by_label('MG Comparison Grid', exact=True)
            expect(grid.locator('option[value="' + ('8' if position == 'bottom' else '1') + '"]')).to_have_js_property('disabled', True)
            grid.select_option(str(columns)); save(migrated, settings)
            canvas_ready(migrated, 8)
            sides = [('L', 'MLO'), ('R', 'MLO'), ('L', 'CC'), ('R', 'CC')]
            if position == 'bottom':
                expected = [(study, side, view) for study in [current.uid, prior.uid] for side, view in sides]
            else:
                studies = [prior.uid, current.uid] if position == 'left' else [current.uid, prior.uid]
                per_study = columns // 2
                expected = [(study, side, view) for offset in range(0, 4, per_study) for study in studies for side, view in sides[offset:offset + per_study]]
            self.assertEqual([(r['study'], r['side'], r['view']) for r in MG.image_state(self, migrated)], expected)
            self.assertEqual(migrated.evaluate('services.viewportGridService.getState().layout.numCols'), columns)
            self.evidence(migrated, 'mg-prior-' + position + '-columns-' + str(columns))
            if position == 'bottom':
                graphics = migrated.evaluate("""() => { const e=cornerstone.getRenderingEngines()[0];
                  const w=e.offscreenMultiRenderWindow.getOpenGLRenderWindow(),g=w.getContext();
                  return {requested:w.getSize()[0],actual:g.drawingBufferWidth,
                    limit:Math.min(g.getParameter(g.MAX_TEXTURE_SIZE),g.getParameter(g.MAX_RENDERBUFFER_SIZE),g.getParameter(g.MAX_VIEWPORT_DIMS)[0])}; }""")
                self.assertLessEqual(graphics['requested'], graphics['limit'])
                self.assertEqual(graphics['actual'], graphics['requested'])
                folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/viewer-ux-u3/screens'))
                (folder / 'mg-bottom-graphics.json').write_text(json.dumps(graphics, indent=2), encoding='utf-8')
        dbt = MG.phantom(self, 'U3DBT-' + uuid.uuid4().hex[:12], dbt=True)
        migrated.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + dbt.uid)
        canvas_ready(migrated, 4)
        self.assertTrue(all(r['study'] == dbt.uid for r in MG.image_state(self, migrated)))
        self.assertTrue(migrated.evaluate("[...services.viewportGridService.getState().viewports.keys()].every(id => { const v=services.cornerstoneViewportService.getCornerstoneViewport(id); return cornerstone.metaData.get('instance',v.getCurrentImageId()).SOPClassUID==='1.2.840.10008.5.1.4.1.1.13.1.3'; })"))
        self.evidence(migrated, 'dbt-default-dbt-images')

    def test_priors_07_modality_layout_and_matching_series(self):
        # D1821 -> RISK-WRONG-SERIES/PREFERENCE-LOSS -> TEST-VIEWER-U3-HANGING.
        patient = 'U3CT-' + uuid.uuid4().hex[:12]
        current = self.multiple(patient, 'current', '20260801')
        prior = self.multiple(patient, 'prior', '20250701')
        work, page = self.open_viewer(current)
        page.get_by_role('button', name='Viewer Settings', exact=True).click()
        settings = page.get_by_role('dialog', name='Viewer Settings', exact=True)
        expect(settings.get_by_role('button', name='Save', exact=True)).to_be_enabled()
        settings.get_by_label('CT Default Layout', exact=True).select_option('2x1')
        settings.get_by_label('CT Prior Position', exact=True).select_option('top')
        settings.get_by_label('MR Default Layout', exact=True).select_option('2x2')
        settings.get_by_label('MR Prior Position', exact=True).select_option('left')
        settings.get_by_label('XA Default Layout', exact=True).select_option('1x2')
        with page.expect_response(lambda r: r.url.endswith('/api/workspace-shortcuts') and r.request.method == 'PUT') as reply:
            settings.get_by_role('button', name='Save', exact=True).click()
        self.assertEqual(reply.value.status, 200)
        expect(settings).not_to_be_visible()
        fresh_work = self.login(); fresh = fresh_work.context.new_page()
        fresh.on('dialog', lambda dialog: dialog.accept())
        fresh.goto(page.url); canvas_ready(fresh, 2)
        self.assertEqual(fresh.evaluate('services.viewportGridService.getState().layout.numRows'), 2)
        fresh.get_by_role('region', name='Series', exact=True).get_by_role('button', name='2/2 D02E second series', exact=False).click()
        fresh.wait_for_function("() => KinViewerUX.viewport(services.viewportGridService.getActiveViewportId())?.seriesUid === services.displaySetService.getActiveDisplaySets().find(d=>d.StudyInstanceUID==='" + current.uid + "' && d.SeriesNumber==2)?.SeriesInstanceUID")
        reads = []
        fresh.on('request', lambda request: reads.append(request.url) if '/api/studies' in request.url else None)
        panel = self.studies(fresh)
        panel.get_by_role('button', name='D03A prior', exact=True).click()
        canvas_ready(fresh, 2)
        fresh.wait_for_function("uid => [...services.viewportGridService.getState().viewports.values()].some(c=>services.displaySetService.getDisplaySetByUID(c.displaySetInstanceUIDs[0])?.StudyInstanceUID===uid)", arg=prior.uid)
        state = fresh.evaluate("() => [...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).map(c=>{const d=services.displaySetService.getDisplaySetByUID(c.displaySetInstanceUIDs[0]);return [d.StudyInstanceUID,Number(d.SeriesNumber)];})")
        self.assertEqual(state, [[prior.uid, 2], [current.uid, 2]])
        self.assertEqual(len(reads), 1, reads)
        self.evidence(fresh, 'per-modality-prior-top-matching-series')

    def test_priors_08_mg_reference_lines_with_comparison(self):
        # REQ-MG-03 -> RISK-MG-FALSE-ANATOMY -> TEST-MG-REFERENCE-LINES.
        # Stored DBT planes share a synthetic FoR deliberately, even across studies.
        from test_mammography_hanging import MammographyHangingE2E as MG
        from pydicom.uid import generate_uid
        patient = 'U3REF-' + uuid.uuid4().hex[:12]
        frame = generate_uid()
        current = MG.phantom(self, patient, dbt=True, reference_frame=frame)
        prior = MG.phantom(self, patient, prior=True, dbt=True, reference_frame=frame)
        work = self.login()
        record = document_request(work, 'GET', '/api/workspace-shortcuts').json()
        settings = {**(record['viewerSettings'] or {'version': 2, 'bar': [], 'shortcuts': {}}),
                    'mammography': {'layout': 'compare', 'kind': 'dbt'}}
        response = document_request(work, 'PUT', '/api/workspace-shortcuts', headers={'X-KIN-CSRF': '1'},
                                    data={'expectedOwner': record['owner'], 'revision': record['revision'], 'viewerSettings': settings})
        self.assertEqual(response.status, 200)
        page = work.context.new_page()
        page.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + current.uid + ',' + prior.uid)
        canvas_ready(page, 8)
        observations = []
        ids = page.evaluate('[...services.viewportGridService.getState().viewports.keys()]')
        for source in ids:
            page.evaluate('id=>services.viewportGridService.setActiveViewportId(id)', source)
            page.wait_for_function('''id=>[...services.viewportGridService.getState().viewports.keys()].every(key=>{
              const v=services.cornerstoneViewportService.getCornerstoneViewport(key);
              return cornerstoneTools.ToolGroupManager.getToolGroupForViewport(v.id,v.renderingEngineId)
                ?.getToolInstance('ReferenceLines')?.editData?.sourceViewportId===id;})''', arg=source)
            # Observe the real gate with a pass-through native-geometry spy, as in #240's served probe.
            observations.extend(page.evaluate('''() => {
              const cs=cornerstone, manager=cornerstoneTools.ToolGroupManager;
              return [...services.viewportGridService.getState().viewports.keys()].map(id=>{
                const enabled=cs.getEnabledElementByViewportId(id), v=enabled.viewport;
                const t=manager.getToolGroupForViewport(v.id,v.renderingEngineId).getToolInstance('ReferenceLines');
                const src=cs.getEnabledElementByViewportId(t.editData.sourceViewportId).viewport;
                const a=cs.metaData.get('instance',src.getCurrentImageId()), b=cs.metaData.get('instance',v.getCurrentImageId());
                const own=Object.prototype.hasOwnProperty.call(t,'isParallel'), original=t.isParallel;
                let reached=false;
                t.isParallel=function(...args){reached=true;return original.apply(this,args);};
                try { t.renderAnnotation(enabled,{getSvgNode:()=>null,appendNode:()=>{},setNodeTouched:()=>{},svgLayerElement:{id:'reference-observation'}}); }
                finally { if(own)t.isParallel=original;else delete t.isParallel; }
                return {source:src.id,target:id,reached,sourceStudy:a.StudyInstanceUID,targetStudy:b.StudyInstanceUID,
                  sourceSide:a.ImageLaterality,targetSide:b.ImageLaterality};
              });}'''))
        pairs = [row for row in observations if row['source'] != row['target']]
        self.assertTrue(any(row['reached'] for row in pairs), 'Same-study same-side stored planes must reach native geometry')
        for row in pairs:
            self.assertEqual(row['reached'], row['sourceStudy'] == row['targetStudy'] and row['sourceSide'] == row['targetSide'], row)
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/viewer-ux-u3/screens'))
        folder.mkdir(parents=True, exist_ok=True)
        (folder / 'mg-reference-boundary.json').write_text(json.dumps(observations, indent=2), encoding='utf-8')
        self.evidence(page, 'mg-reference-comparison')


    def test_priors_09_personal_layout_metadata_order(self):
        # D1821 -> RISK-WRONG-SERIES -> TEST-VIEWER-U3-HANGING.
        # Hold real series metadata responses, without replacing native services or DICOM.
        patient = 'U3ORDER-' + uuid.uuid4().hex[:12]
        current = self.multiple(patient, 'current', '20260801')
        prior = self.multiple(patient, 'prior', '20250701')
        work = self.login()
        first_series = {}
        for fixture in [current, prior]:
            first_series[fixture.uid] = next(item['0020000E']['Value'][0] for item in self.metadata(work, fixture)
                                             if int(item['00200011']['Value'][0]) == 1)
        observations = []
        for layout, fixtures, expected in [
                ('1x2', [current], [[current.uid, 1], [current.uid, 2]]),
                ('1x2', [current, prior], [[current.uid, 1], [prior.uid, 1]])]:
            record = document_request(work, 'GET', '/api/workspace-shortcuts').json()
            settings = {'version': 2, 'bar': ['Zoom'], 'shortcuts': {'Zoom': 'z'},
                        'hanging': {'CT': {'layout': layout, 'priorPosition': 'right', 'seriesMatch': 'similar'}}}
            reply = document_request(work, 'PUT', '/api/workspace-shortcuts', headers={'X-KIN-CSRF': '1'},
                                     data={'expectedOwner': record['owner'], 'revision': record['revision'], 'viewerSettings': settings})
            self.assertEqual(reply.status, 200)
            for reverse in [False, True]:
                fresh_work = self.login()
                page = fresh_work.context.new_page()
                page.on('dialog', lambda dialog: dialog.accept())
                held = []
                if reverse:
                    def metadata_response(route):
                        if any('/series/' + first_series[f.uid] + '/metadata' in route.request.url for f in fixtures):
                            held.append(route)
                        else:
                            route.continue_()
                    page.route('**/dicom-web/studies/**/metadata*', metadata_response)
                page.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + ','.join(f.uid for f in fixtures))
                if reverse:
                    page.wait_for_function("uids => uids.every(uid => window.services?.displaySetService.getActiveDisplaySets().some(d => d.StudyInstanceUID===uid && Number(d.SeriesNumber)===2))",
                                           arg=[f.uid for f in fixtures])
                    self.assertEqual(len(held), len(fixtures))
                    for route in held: route.continue_()
                canvas_ready(page, 2)
                page.wait_for_function("uids => uids.every(uid => services.displaySetService.getActiveDisplaySets().filter(d => d.StudyInstanceUID===uid).length===2)",
                                       arg=[f.uid for f in fixtures])
                state = """() => [...services.viewportGridService.getState().viewports.values()]
                  .sort((a,b)=>a.y-b.y||a.x-b.x).map(c=>{
                    const v=services.cornerstoneViewportService.getCornerstoneViewport(c.viewportId);
                    const m=cornerstone.metaData.get('instance',v?.getCurrentImageId?.());
                    return [m?.StudyInstanceUID,Number(m?.SeriesNumber)];})"""
                page.wait_for_function('expected => JSON.stringify((' + state + ')()) === JSON.stringify(expected)', arg=expected)
                order = page.evaluate('uid => services.displaySetService.getActiveDisplaySets().filter(d=>d.StudyInstanceUID===uid).map(d=>Number(d.SeriesNumber))', current.uid)
                if reverse: self.assertEqual(order, [2, 1])
                observations.append({'layout': layout, 'reversed': reverse, 'arrival': order, 'cells': page.evaluate(state)})
                self.evidence(page, 'personal-layout-' + layout + ('-reversed' if reverse else '-normal'))
                page.close(); fresh_work.context.close()
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/viewer-ux-u3/screens'))
        (folder / 'personal-layout-order.json').write_text(json.dumps(observations, indent=2), encoding='utf-8')

    def test_priors_10_worklist_comparison_uses_saved_layout(self):
        # D1821 -> RISK-PREFERENCE-LOSS -> TEST-VIEWER-U3-HANGING.
        # The worklist's own comparison open (Include Latest Prior) after a Settings Save.
        patient = 'U3WL-' + uuid.uuid4().hex[:12]
        current = self.multiple(patient, 'current', '20260801')
        prior = self.multiple(patient, 'prior', '20250701')
        work, page = self.open_viewer(current)
        page.get_by_role('button', name='Viewer Settings', exact=True).click()
        settings = page.get_by_role('dialog', name='Viewer Settings', exact=True)
        expect(settings.get_by_role('button', name='Save', exact=True)).to_be_enabled()
        settings.get_by_label('CT Default Layout', exact=True).select_option('2x1')
        settings.get_by_label('CT Prior Position', exact=True).select_option('top')
        settings.get_by_label('CT Compare Series', exact=True).select_option('number')
        with page.expect_response(lambda r: r.url.endswith('/api/workspace-shortcuts') and r.request.method == 'PUT') as reply:
            settings.get_by_role('button', name='Save', exact=True).click()
        self.assertEqual(reply.value.status, 200)
        expect(settings).not_to_be_visible()
        reader = self.login()
        self.open_toolbar_group(reader, '#image-opening-open')
        reader.locator('#image-opening-open').click()
        reader.get_by_label('Include Latest Prior', exact=True).check()
        reader.get_by_role('button', name='Done', exact=True).click()
        self.select(reader, current)
        with reader.context.expect_page() as opened: reader.locator('#m-filmbox').click()
        viewer = opened.value
        viewer.on('dialog', lambda dialog: dialog.accept())
        viewer.wait_for_url('**/ohif/viewer?**')
        self.assertIn('hangingProtocolId=@ohif/hpCompare', viewer.url)
        self.assertIn(current.uid + ',' + prior.uid, viewer.url)
        canvas_ready(viewer, 2)
        state = """() => [...services.viewportGridService.getState().viewports.values()]
          .sort((a,b)=>a.y-b.y||a.x-b.x).map(c=>{
            const v=services.cornerstoneViewportService.getCornerstoneViewport(c.viewportId);
            const m=cornerstone.metaData.get('instance',v?.getCurrentImageId?.());
            return [m?.StudyInstanceUID,Number(m?.SeriesNumber)];})"""
        expected = [[prior.uid, 1], [current.uid, 1]]
        viewer.wait_for_function('expected => JSON.stringify((' + state + ')()) === JSON.stringify(expected)', arg=expected)
        # The stock hpCompare hang is 2x2; the saved CT grid is one column, prior on top.
        grid = viewer.evaluate('''() => [services.viewportGridService.getState().layout.numRows,
          services.viewportGridService.getState().layout.numCols]''')
        self.assertEqual(grid, [2, 1])
        self.evidence(viewer, 'worklist-comparison-personal-layout')


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ViewerUXPriorsE2E(name) for name in loader.getTestCaseNames(ViewerUXPriorsE2E)
                              if name.startswith('test_priors_'))


if __name__ == '__main__':
    unittest.main()
