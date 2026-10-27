"""U2-T0/T2/T3: shipped viewer chrome over synthetic DICOM.

No substitute page, config, renderer or product controller is installed.
U3 prior/report integration and first-site hardware acceptance remain separate.
"""
import json
from urllib.parse import parse_qs, urlsplit
import os
from pathlib import Path
import unittest
import uuid
import io
import copy

from playwright.sync_api import expect
from pydicom import dcmread
from pydicom.dataset import Dataset
from pydicom.uid import generate_uid
from test_viewer_layout import ViewerLayoutE2E
from test_prior_selection import canvas_ready
from test_cine import CineE2E
from test_display_controls import DisplayControlsE2E
from document_session import document_request


class ViewerUXShellE2E(ViewerLayoutE2E):
    def tearDown(self):
        result = self._outcome.result
        if any(test is self for test, _ in result.failures + result.errors):
            folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/viewer-ux-u2/screens'))
            folder.mkdir(parents=True, exist_ok=True)
            for i, context in enumerate(self.contexts):
                for j, page in enumerate(context.pages):
                    if '/ohif/viewer' not in page.url: continue
                    try:
                        name = 'failure-' + self._testMethodName + '-' + str(i) + '-' + str(j)
                        page.screenshot(path=str(folder / (name + '.png')))
                        (folder / (name + '.html')).write_text(page.content(), encoding='utf-8')
                        state = page.evaluate('''() => ({url:location.href, classes:document.body.className,
                          tabs:window.KinViewerPatientTabs?.snapshot(),
                          history:window.kinViewerHistoryWorkspaceState?.(), jobs:window.kinViewerJobWorkspaceState?.(),
                          cells:[...services.viewportGridService.getState().viewports.values()].map(c=>({
                            id:c.viewportId,sets:c.displaySetInstanceUIDs,
                            image:services.cornerstoneViewportService.getCornerstoneViewport(c.viewportId)?.getCurrentImageId?.(),
                            camera:services.cornerstoneViewportService.getCornerstoneViewport(c.viewportId)?.getCamera?.()}))})''')
                        (folder / (name + '.json')).write_text(json.dumps(state, indent=2), encoding='utf-8')
                        (folder / (name + '-browser-errors.json')).write_text(json.dumps(getattr(self, 'browser_errors', []), indent=2), encoding='utf-8')
                    except Exception as error: print('Viewer failure capture:', str(error)[:180], flush=True)
        super().tearDown()

    def test_shell_04_patient_tabs(self):
        a = self.multiple('U2A-' + uuid.uuid4().hex[:12], 'tabs A', '20260801')
        b = self.multiple('U2B-' + uuid.uuid4().hex[:12], 'tabs B', '20260801')
        work = self.login(); self.select(work, a)
        with work.context.expect_page() as opened:
            work.locator('#m-filmbox').click()
        page = opened.value
        browser_errors = []
        self.browser_errors = browser_errors
        page.on('pageerror', lambda error: browser_errors.append(str(error)))
        def record_console(message):
            if message.type not in ('error', 'warning', 'debug'): return
            browser_errors.append({'type':message.type,'text':message.text,'arguments':[
                arg.evaluate('(value) => value instanceof Error ? {message:value.message,stack:value.stack} : String(value)')
                for arg in message.args]})
        page.on('console', record_console)
        canvas_ready(page, 1)
        tabs = page.get_by_role('tablist', name='Patients')
        expect(tabs.get_by_role('tab')).to_have_count(1)
        expect(tabs).to_contain_text(a.patient_id)
        expect(tabs.get_by_role('tab')).to_have_text('D03A SYNTHETIC | ' + a.patient_id + ' | Unknown | O')
        self.grid(page, 2); self.drag(page, 'D02E second series', 1)
        canvas_ready(page, 2)
        page.wait_for_function('''() => [...services.viewportGridService.getState().viewports.keys()]
          .every(id => services.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageId?.())''')
        # Preserve a reader's changed view, not only the initial fitted image.
        canvas = page.locator('[data-cy="viewport-pane"] canvas').first
        box = canvas.bounding_box(); DisplayControlsE2E.choose(self, page, 0)
        view_state = """() => {const v=services.cornerstoneViewportService.getCornerstoneViewport(
          services.viewportGridService.getState().activeViewportId);return {
          scale:v.getCamera().parallelScale,image:v.getCurrentImageId(),voi:v.getProperties().voiRange};}"""
        original_view = page.evaluate(view_state)
        page.get_by_role('toolbar', name='Frequent Tools').get_by_role('button', name='Zoom', exact=True).click()
        page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2);page.mouse.down()
        page.mouse.move(box['x']+box['width']/2,box['y']+box['height']*3/4,steps=10);page.mouse.up()
        page.wait_for_function('before => ('+view_state+')().scale !== before',arg=original_view['scale'])
        page.keyboard.press('4')
        page.wait_for_function('before => JSON.stringify(('+view_state+')().voi) !== JSON.stringify(before)',arg=original_view['voi'])
        page.mouse.wheel(0,box['height'])
        page.wait_for_function('before => ('+view_state+')().image !== before',arg=original_view['image'])
        before = self.cells(page)
        page.wait_for_function('''() => [...services.viewportGridService.getState().viewports.keys()]
          .every(id=>services.cornerstoneViewportService.getViewportInfo(id)?.getViewportData())''')
        folder=Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/viewer-ux-u2/screens'));folder.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(folder/'patient-tabs-before.png'))
        display_state = '''() => JSON.stringify([...services.viewportGridService.getState().viewports.values()]
          .sort((a,b)=>a.y-b.y||a.x-b.x).map(cell=>{
            const v=services.cornerstoneViewportService.getCornerstoneViewport(cell.viewportId),canvas=v?.element?.querySelector('canvas');
            if(!v?.getCurrentImageId?.() || !canvas?.width || !canvas?.height) return null;
            const p=v.getProperties(),pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
            let digest=2166136261;for(let n=0;n<pixels.length;n+=4)digest=Math.imul(digest^pixels[n],16777619)>>>0;
            return {image:v.getCurrentImageId(),canvas:{width:canvas.width,height:canvas.height,digest},
              properties:{voiRange:p.voiRange,invert:p.invert,VOILUTFunction:p.VOILUTFunction}};
          }))'''
        before_display = page.evaluate(display_state)
        (folder/'patient-tabs-display-before.json').write_text(before_display,encoding='utf-8')
        document_id = page.evaluate('performance.timeOrigin')
        self.select(work, b); work.locator('#m-filmbox').click()
        expect(tabs.get_by_role('tab')).to_have_count(2, timeout=45000)
        page.wait_for_function('''uid => [...services.viewportGridService.getState().viewports.keys()].every(id => {
          const v=services.cornerstoneViewportService.getCornerstoneViewport(id);
          return !v?.getCurrentImageId?.() || v.getCurrentImageId().includes('/studies/'+uid+'/');
        })''',arg=b.uid)
        canvas_ready(page, 1)
        self.assertEqual(page.evaluate('performance.timeOrigin'),document_id)
        page.screenshot(path=str(folder/'patient-tabs-two.png'))
        tabs.get_by_role('tab').filter(has_text=a.patient_id).click()
        page.wait_for_function('''uid => services.viewportGridService.getState().viewports.size===2 &&
          [...services.viewportGridService.getState().viewports.keys()].every(id =>
            services.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageId?.().includes('/studies/'+uid+'/'))''',arg=a.uid)
        self.assertEqual([cell['image'] for cell in self.cells(page)], [cell['image'] for cell in before])
        # Pixel equality below remains valid with low-contrast CT presets too.
        (folder/'patient-tabs-browser-errors.json').write_text(json.dumps(browser_errors,indent=2),encoding='utf-8')
        (folder/'patient-tabs-display-restored.json').write_text(page.evaluate(display_state),encoding='utf-8')
        details = page.get_by_role('button', name='Show Details', exact=True)
        if details.is_visible():
            details.click()
            (folder/'patient-tabs-native-error.txt').write_text(page.locator('body').inner_text(),encoding='utf-8')
            self.fail('Native viewer reported an error while restoring the patient tab')
        # Compare the rendered diagnostic pixels and display properties, rather
        # than pinning internal camera floats across native viewport recreation.
        page.wait_for_function('expected => (' + display_state + ')() === expected', arg=before_display)
        page.screenshot(path=str(folder/'patient-tabs-restored.png'))
        for bar in page.get_by_role('region', name='Viewport Information').all():
            expect(bar).to_contain_text(a.patient_id)
        # A late patient lookup cannot win after selecting A again (A→B→A).
        page.wait_for_function('''() => window.kinViewerHistoryWorkspaceState?.()?.busy === false && window.kinViewerJobWorkspaceState?.()?.busy === false''')
        held = []
        page.route('**/api/studies?*', lambda route: held.append(route), times=1)
        with page.expect_request(lambda request: request.url.split('?')[0].endswith('/api/studies')):
            tabs.get_by_role('tab').filter(has_text=b.patient_id).click()
        tabs.get_by_role('tab').filter(has_text=a.patient_id).click()
        for route in held:
            try: route.continue_()
            except Exception: pass  # The real fetch was aborted by the newer selection.
        expect(tabs.get_by_role('tab').filter(has_text=a.patient_id)).to_have_attribute('aria-selected','true')
        page.wait_for_function('expected => (' + display_state + ')() === expected', arg=before_display)
        held = []
        page.route('**/api/studies?*', lambda route: held.append(route), times=1)
        with page.expect_request(lambda request: request.url.split('?')[0].endswith('/api/studies')):
            tabs.get_by_role('tab').filter(has_text=b.patient_id).click()
        tabs.get_by_role('button', name='Close D03A SYNTHETIC ' + b.patient_id, exact=True).click()
        for route in held:
            try: route.continue_()
            except Exception: pass
        expect(tabs.get_by_role('tab')).to_have_count(1)
        expect(tabs.get_by_role('tab').filter(has_text=a.patient_id)).to_have_attribute('aria-selected','true')
        self.select(work, b); work.locator('#m-filmbox').click()
        expect(tabs.get_by_role('tab')).to_have_count(2, timeout=45000)
        canvas_ready(page, 1)
        page.wait_for_function('''() => window.kinViewerHistoryWorkspaceState?.()?.busy === false && window.kinViewerJobWorkspaceState?.()?.busy === false''')
        tabs.get_by_role('tab').filter(has_text=a.patient_id).click()
        page.wait_for_function('expected => (' + display_state + ')() === expected', arg=before_display)
        page.wait_for_function('''() => window.kinViewerHistoryWorkspaceState?.()?.busy === false && window.kinViewerJobWorkspaceState?.()?.busy === false''')
        self.select(work, a); work.locator('#m-filmbox').click()
        expect(tabs.get_by_role('tab')).to_have_count(2)
        tabs.get_by_role('tab').filter(has_text=a.patient_id).focus();page.keyboard.press('ArrowRight')
        expect(tabs.get_by_role('tab').filter(has_text=b.patient_id)).to_have_attribute('aria-selected','true')
        page.wait_for_function('''() => window.kinViewerHistoryWorkspaceState?.()?.busy === false && window.kinViewerJobWorkspaceState?.()?.busy === false''')
        tabs.get_by_role('tab').filter(has_text=b.patient_id).focus()
        page.wait_for_function('''uid => !document.body.classList.contains('kin-patient-switching') &&
          window.kinViewerHistoryWorkspaceState?.() && !kinViewerHistoryWorkspaceState().busy &&
          window.kinViewerJobWorkspaceState?.() && !kinViewerJobWorkspaceState().busy &&
          [...services.viewportGridService.getState().viewports.keys()].some(id =>
            services.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageId?.().includes('/studies/'+uid+'/'))''', arg=b.uid)
        page.keyboard.press('Delete')
        expect(tabs.get_by_role('tab')).to_have_count(1)
        expect(tabs.get_by_role('tab').filter(has_text=a.patient_id)).to_be_focused()
        page.wait_for_function('''() => window.kinViewerHistoryWorkspaceState?.()?.busy === false && window.kinViewerJobWorkspaceState?.()?.busy === false''')
        tabs.get_by_role('button', name='Close ', exact=False).click()
        expect(tabs.get_by_role('tab')).to_have_count(0)
        expect(page.get_by_text('No Patient — 목록에서 검사를 여세요.', exact=True)).to_be_visible()
        self.select(work, a);work.locator('#m-filmbox').click()
        expect(tabs.get_by_role('tab')).to_have_count(1)
        expect(tabs).to_contain_text(a.patient_id)
        self.assertEqual(page.evaluate('performance.timeOrigin'),document_id)

    def test_shell_05_patient_dirty_guard(self):
        from test_viewer_image_text import ViewerImageTextE2E
        a=self.multiple('U2A-'+uuid.uuid4().hex[:12],'guard A','20260801')
        b=self.multiple('U2B-'+uuid.uuid4().hex[:12],'guard B','20260801')
        work=self.login();self.select(work,a)
        with work.context.expect_page() as opened: work.locator('#m-filmbox').click()
        page=opened.value;canvas_ready(page,1)
        self.select(work,b);work.locator('#m-filmbox').click()
        tabs=page.get_by_role('tablist',name='Patients')
        expect(tabs.get_by_role('tab')).to_have_count(2,timeout=45000)
        canvas_ready(page,1)
        more = page.get_by_text('More', exact=True)
        menu = page.get_by_role('group', name='More Tools')
        more.click(); expect(menu).to_be_visible()
        page.keyboard.press('Escape'); expect(menu).not_to_be_visible()
        more.click(); expect(menu).to_be_visible()
        page.get_by_role('toolbar', name='Frequent Tools').click(position={'x': 2, 'y': 2})
        expect(menu).not_to_be_visible()
        ViewerImageTextE2E.annotate(self,page)
        expect(menu).not_to_be_visible()
        before=self.cells(page)
        tabs.get_by_role('tab').filter(has_text=a.patient_id).click()
        expect(tabs.get_by_role('tab').filter(has_text=b.patient_id)).to_have_attribute('aria-selected','true')
        tabs.get_by_role('button',name='Close ',exact=False).last.click()
        expect(tabs.get_by_role('tab')).to_have_count(2)
        self.assertEqual(self.cells(page),before)

    def test_shell_07_failed_patient_lookup_recovers(self):
        fixture = self.multiple('U2-' + uuid.uuid4().hex[:12], 'lookup failure', '20260801')
        work = self.login()
        page = work.context.new_page()
        page.route('**/api/studies?*', lambda route: route.fulfill(status=503, content_type='application/json', body='{}'), times=1)
        page.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + fixture.uid)
        canvas_ready(page, 1)
        retry = page.get_by_role('button', name='Retry Patient', exact=True)
        expect(retry).to_be_visible()
        expect(page.locator('[data-cy="viewport-grid"]')).to_be_visible()
        self.assertFalse(page.evaluate("document.body.classList.contains('kin-viewer-empty')"))
        before = self.cells(page)
        retry.click(); expect(retry).not_to_be_visible()
        expect(page.get_by_role('tablist', name='Patients')).to_contain_text(fixture.patient_id)
        self.assertEqual(self.cells(page), before)

    def test_shell_08_same_patient_requested_study(self):
        patient = 'U2-' + uuid.uuid4().hex[:12]
        a = self.multiple(patient, 'first study', '20260801')
        b = self.multiple(patient, 'second study', '20260701')
        work = self.login(); self.select(work, a)
        with work.context.expect_page() as opened: work.locator('#m-filmbox').click()
        page = opened.value
        # Automatic comparison hangs both series from each of these two studies.
        canvas_ready(page, 4)
        page.wait_for_function('() => window.kinViewerOpenPatient && window.kinViewerHistoryWorkspaceState?.()?.busy === false && window.kinViewerJobWorkspaceState?.()?.busy === false')
        tabs = page.get_by_role('tablist', name='Patients')
        expect(tabs.get_by_role('tab')).to_have_count(1)
        document = page.evaluate('performance.timeOrigin')
        self.select(work, b); work.locator('#m-filmbox').click()
        page.wait_for_function('uid => new URL(location.href).searchParams.get("StudyInstanceUIDs").split(",")[0] === uid', arg=b.uid)
        page.wait_for_function('''uid => {
          const first=[...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x)[0];
          return services.cornerstoneViewportService.getCornerstoneViewport(first?.viewportId)?.getCurrentImageId?.().includes(uid);
        }''', arg=b.uid)
        expect(tabs.get_by_role('tab')).to_have_count(1)
        self.assertEqual(page.evaluate('performance.timeOrigin'), document)

    def test_shell_09_settings_failure_keeps_default_tools(self):
        fixture = self.multiple('U2-' + uuid.uuid4().hex[:12], 'settings failure', '20260801')
        page = self.login()
        page.route('**/api/workspace-shortcuts', lambda route: route.fulfill(status=503, content_type='application/json', body='{}'), times=1)
        page = self.launch(page, [fixture])
        page.locator('#kin-workspace-dock nav button[aria-controls="kin-viewer-layout"]').click()
        retry = page.get_by_role('button', name='Reload Settings', exact=True)
        expect(retry).to_be_visible()
        zoom = page.get_by_role('toolbar', name='Frequent Tools').get_by_role('button', name='Zoom', exact=True)
        expect(zoom).to_be_enabled(); expect(zoom).to_have_attribute('draggable', 'false')
        page.wait_for_function('() => window.kinViewerHistoryWorkspaceState?.()?.busy === false && window.kinViewerJobWorkspaceState?.()?.busy === false')
        zoom.click()
        active = '() => services.toolGroupService.getToolGroupForViewport(services.viewportGridService.getActiveViewportId()).getActivePrimaryMouseButtonTool()'
        self.assertEqual(page.evaluate(active), 'Zoom')
        page.keyboard.press('p'); self.assertEqual(page.evaluate(active), 'Pan')
        page.get_by_role('button', name='Viewer Settings', exact=True).click()
        dialog = page.get_by_role('dialog', name='Viewer Settings')
        expect(dialog.get_by_role('button', name='Save', exact=True)).to_be_disabled()
        dialog.get_by_role('button', name='Cancel', exact=True).click()
        retry.click(); expect(retry).not_to_be_visible()
        expect(zoom).to_have_attribute('draggable', 'true')

    def test_shell_10_mammography_tab_roundtrip(self):
        patient = 'U2MG-' + uuid.uuid4().hex[:12]
        current = self.ct(patient, 'MG current', '20260801')
        prior = self.ct(patient, 'MG prior', '20250701')
        other = self.ct('U2CT-' + uuid.uuid4().hex[:12], 'CT patient', '20260801')
        for fixture in [current, prior]:
            source = next(d for d in (dcmread(io.BytesIO(self.stack.orthanc_bytes(path))) for path in self.originals())
                          if str(d.StudyInstanceUID) == fixture.uid)
            for number, (side, view) in enumerate([('R', 'CC'), ('L', 'CC'), ('R', 'MLO'), ('L', 'MLO')], 1):
                data = copy.deepcopy(source)
                data.Modality = 'MG'; data.SOPClassUID = '1.2.840.10008.5.1.4.1.1.1.2'
                data.file_meta.MediaStorageSOPClassUID = data.SOPClassUID
                data.SOPInstanceUID = generate_uid(); data.file_meta.MediaStorageSOPInstanceUID = data.SOPInstanceUID
                data.SeriesInstanceUID = generate_uid(); data.SeriesNumber = number + 10
                data.ImageType = ['ORIGINAL', 'PRIMARY']; data.ImageLaterality = side; data.ViewPosition = view
                data.PresentationIntentType = 'FOR PRESENTATION'
                code = Dataset(); code.CodingSchemeDesignator = 'SCT'
                code.CodeValue = '399162004' if view == 'CC' else '399368009'
                code.CodeMeaning = 'cranio-caudal' if view == 'CC' else 'medio-lateral oblique'
                data.ViewCodeSequence = [code]
                data.SeriesDescription = 'MG ' + side + ' ' + view
                stream = io.BytesIO(); data.save_as(stream, write_like_original=False)
                self.assertEqual(self.stack._orthanc_request('POST', '/instances', stream.getvalue()).status, 200)
        work = self.login(); page = work.context.new_page()
        page.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + current.uid + ',' + prior.uid)
        canvas_ready(page, 8)
        expect(page.get_by_label('MG Layout', exact=True)).to_have_value('compare')
        before = [cell['image'] for cell in self.cells(page)]
        self.assertEqual(len(set(before)), 8)
        page.wait_for_function('() => window.kinViewerHistoryWorkspaceState?.()?.busy === false && window.kinViewerJobWorkspaceState?.()?.busy === false')
        # Exercise the published open boundary without replacing either extension.
        self.assertTrue(page.evaluate('href => kinViewerOpenPatient(href)', self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + other.uid))
        tabs = page.get_by_role('tablist', name='Patients')
        expect(tabs.get_by_role('tab')).to_have_count(2, timeout=45000)
        canvas_ready(page, 1)
        page.wait_for_function('() => window.kinViewerHistoryWorkspaceState?.()?.busy === false && window.kinViewerJobWorkspaceState?.()?.busy === false')
        tabs.get_by_role('tab').filter(has_text=patient).click()
        page.wait_for_function('expected => JSON.stringify([...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).map(c=>services.cornerstoneViewportService.getCornerstoneViewport(c.viewportId)?.getCurrentImageId?.())) === JSON.stringify(expected)', arg=before)
        canvas_ready(page, 8)
        expect(page.get_by_label('MG Layout', exact=True)).to_have_value('compare')

    def test_shell_06_study_action_seam(self):
        patient = 'U2-' + uuid.uuid4().hex[:12]
        current = self.multiple(patient, 'seam current', '20260801')
        prior = self.ct(patient, 'seam prior', '20250701')
        page = self.launch(self.login(), [current, prior])
        self.grid(page, 2); self.drag(page, 'D03A seam prior', 1)
        canvas_ready(page, 2)
        bars = page.get_by_role('region', name='Viewport Information')
        for bar in bars.all(): expect(bar.get_by_role('button', name='Study', exact=False)).to_be_disabled()
        # Register only the future consumer callbacks at the public boundary;
        # the shipped shell, services, native grid and report host execute normally.
        page.evaluate('''() => {
          window.u2Unregister = KinViewerUX.registerStudyActions({
            listPriors(value) { window.u2Origin = value; },
            openImages() {}, openReport() {}
          });
        }''')
        bars.nth(1).get_by_role('button', name='Study', exact=False).click()
        origin = page.evaluate('''() => ({...KinViewerUX.viewport(u2Origin.viewportId),
          target:KinViewerUX.comparisonTarget(u2Origin)})''')
        self.assertEqual(origin['studyUid'], prior.uid)
        self.assertEqual(origin['target']['layout']['numCols'], 2)
        self.assertIsNone(origin['target']['viewportId'])
        self.assertTrue(page.evaluate('''() => KinViewerUX.reportHost.show(u2Origin,
          {title:'Prior study',findings:'Synthetic prior findings',impression:'Synthetic impression'})'''))
        host = page.get_by_role('region', name='Previous Report', exact=True)
        expect(host).to_contain_text('Synthetic prior findings')
        self.assertEqual(host.locator('input,textarea,[contenteditable=true]').count(), 0)
        before = self.cells(page)
        page.wait_for_function('''() => window.kinViewerHistoryWorkspaceState?.()?.busy === false && window.kinViewerJobWorkspaceState?.()?.busy === false''')
        self.assertTrue(page.evaluate('''() => KinViewerUX.assign(u2Origin,
          services.viewportGridService.getState().viewports.get(u2Origin.viewportId).displaySetInstanceUIDs)'''))
        canvas_ready(page, 2)
        self.assertEqual(self.cells(page)[0]['image'], before[0]['image'])
        page.evaluate('u2Unregister()')
        expect(host).not_to_be_visible()
        for bar in bars.all(): expect(bar.get_by_role('button', name='Study', exact=False)).to_be_disabled()

    def test_shell_11_clinician_only_can_view_and_switch_series(self):
        fixture = self.multiple('U2CL-' + uuid.uuid4().hex[:12], 'clinician', '20260801')
        actor = 'u2-clinician'
        self.stack.create_test_identity(actor, ['clinician'], 'hallym')
        context = self.browser.new_context(ignore_https_errors=True, viewport={'width': 1600, 'height': 1050})
        self.contexts.append(context)
        home = context.new_page(); home.goto(self.stack.proxy + '/')
        home.locator('#username').fill(self.stack.username(actor))
        home.locator('#password').fill(self.stack.passwords[actor]); home.locator('#kc-login').click()
        home.wait_for_url('**/worklist/hpacs-lite/clinician.html', timeout=30000)
        expect(home.locator('#actor')).to_contain_text(actor)
        page = context.new_page(); requests = []
        page.on('dialog', lambda dialog: dialog.accept())
        page.on('request', lambda request: requests.append(request.url) if '/api/' in request.url else None)
        page.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + fixture.uid)
        canvas_ready(page, 1)
        expect(page.get_by_role('tablist', name='Patients')).to_contain_text(fixture.patient_id)
        expect(page.locator('[data-cy="viewport-grid"]')).to_be_visible()
        expect(page.get_by_role('region', name='Image Tools', exact=True)).to_be_visible()
        page.get_by_role('toolbar', name='Frequent Tools').get_by_role('button', name='Zoom', exact=True).click()
        page.wait_for_function("() => services.toolGroupService.getToolGroupForViewport(services.viewportGridService.getActiveViewportId()).getActivePrimaryMouseButtonTool() === 'Zoom'")
        strip = page.get_by_role('region', name='Series', exact=True)
        strip.get_by_role('button', name='2/2 D02E second series', exact=False).click()
        page.wait_for_function("() => services.displaySetService.getDisplaySetByUID(services.viewportGridService.getState().viewports.get(services.viewportGridService.getActiveViewportId()).displaySetInstanceUIDs[0]).SeriesNumber == 2")
        canvas_ready(page, 1)
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/viewer-ux-u2/screens')); folder.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(folder / 'clinician-visible-second-series.png'))
        (folder / 'clinician-requests.json').write_text(json.dumps(requests, indent=2), encoding='utf-8')
        self.assertTrue(any('/api/clinician/studies?uids=' in url for url in requests))
        expect(page.get_by_role('button', name='Viewer Settings', exact=True)).not_to_be_visible()
        expect(page.get_by_role('region', name='Image Tools', exact=True).get_by_role('status')).to_be_empty()
        self.assertFalse(any(url.split('?')[0].endswith('/api/studies') for url in requests))
        page.get_by_role('tablist', name='Patients').get_by_role('button', name='Close ', exact=False).click()
        expect(page.get_by_role('tablist', name='Patients').get_by_role('tab')).to_have_count(0)

    def test_shell_12_catalog_save_preserves_unavailable_settings(self):
        fixture = self.multiple('U2CAT-' + uuid.uuid4().hex[:12], 'catalog', '20260801')
        work = self.login()
        record = document_request(work, 'GET', '/api/workspace-shortcuts').json()
        saved = {'version': 1, 'bar': ['Angle', 'Zoom', 'UnavailableModeTool'],
                 'shortcuts': {'Angle': 'a', 'Zoom': 'z', 'UnavailableModeTool': 'u'}}
        response = document_request(work, 'PUT', '/api/workspace-shortcuts', headers={'X-KIN-CSRF':'1'},
                                    data=dict(expectedOwner=record['owner'], revision=record['revision'], viewerSettings=saved))
        self.assertEqual(response.status, 200)
        page = self.launch(work, [fixture])
        expect(page.get_by_role('toolbar', name='Frequent Tools').get_by_role('button', name='Angle', exact=True)).to_be_enabled()
        page.get_by_role('button', name='Viewer Settings', exact=True).click()
        dialog = page.get_by_role('dialog', name='Viewer Settings')
        dialog.get_by_label('Zoom Shortcut', exact=True).fill('j')
        dialog.get_by_role('button', name='Save', exact=True).click()
        expect(dialog).not_to_be_visible()
        actual = document_request(page, 'GET', '/api/workspace-shortcuts').json()['viewerSettings']
        self.assertEqual(actual['bar'], saved['bar'])
        self.assertEqual(actual['shortcuts'], {**saved['shortcuts'], 'Zoom':'j', **{
            key: value for key, value in actual['shortcuts'].items() if key not in saved['shortcuts']}})
        # The native preferences entry remains reachable through the real header.
        page.locator('.bg-secondary-dark.z-20:has(#kin-viewer-brand) button[aria-haspopup="menu"]').click()
        page.get_by_role('menu').get_by_text('Preferences', exact=True).click()
        expect(page.get_by_text('User Preferences', exact=True)).to_be_visible()
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/viewer-ux-u2/screens')); folder.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(folder / 'native-user-preferences.png'))

    def test_shell_13_early_tools_busy_feedback_and_cached_switch(self):
        a = self.multiple('U2EARLY-' + uuid.uuid4().hex[:12], 'early tools', '20260801')
        b = self.multiple('U2NEXT-' + uuid.uuid4().hex[:12], 'next tools', '20260801')
        work = self.login()
        record = document_request(work, 'GET', '/api/workspace-shortcuts').json()
        response = document_request(work, 'PUT', '/api/workspace-shortcuts', headers={'X-KIN-CSRF':'1'},
                                    data=dict(expectedOwner=record['owner'], revision=record['revision'],
                                              viewerSettings={'version':1,'bar':['Zoom'],'shortcuts':{'Zoom':'z','RectangleROI':'r'}}))
        self.assertEqual(response.status, 200)
        page = work.context.new_page()
        held_note = []
        page.route('**/viewer-tech-note.js', lambda route: held_note.append(route))
        page.add_init_script('''
          window.toolFrames = [];
          function observeTools() {
            const native = document.querySelector('#root [data-cy="Zoom"]');
            const bar = document.querySelector('[aria-label="Frequent Tools"]');
            const zoom = bar?.querySelector('[data-tool="Zoom"]');
            toolFrames.push({stock:!!native?.checkVisibility({visibilityProperty:true}),
              binding:zoom?.getAttribute('aria-keyshortcuts'),bar:bar?.innerText});
            requestAnimationFrame(observeTools);
          }
          requestAnimationFrame(observeTools);
        ''')
        page.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + a.uid)
        canvas_ready(page, 1)
        tools = page.get_by_role('region', name='Image Tools', exact=True)
        expect(tools).to_be_visible()
        page.wait_for_function('() => window.kinViewerHistoryWorkspaceState?.()?.busy === false && window.kinViewerJobWorkspaceState?.()?.busy === false')
        page.keyboard.press('z')
        active = '() => services.toolGroupService.getToolGroupForViewport(services.viewportGridService.getActiveViewportId()).getActivePrimaryMouseButtonTool()'
        self.assertEqual(page.evaluate(active), 'Zoom')
        page.keyboard.press('r'); self.assertEqual(page.evaluate(active), 'RectangleROI')
        self.assertTrue(held_note, 'The view tools work while the tech-note script is still held')
        self.assertFalse(page.evaluate('toolFrames.some(frame => frame.stock)'))
        for route in held_note: route.continue_()
        page.unroute('**/viewer-tech-note.js')
        page.get_by_role('button', name='Viewer Settings', exact=True).click()
        dialog = page.get_by_role('dialog', name='Viewer Settings')
        dialog.get_by_label('Zoom Shortcut', exact=True).fill('j')
        dialog.get_by_role('button', name='Save', exact=True).click()
        expect(dialog).not_to_be_visible()
        held_jobs = []
        page.route('**/api/studies/*/viewer-jobs*', lambda route: held_jobs.append(route))
        calls = []
        page.on('request', lambda request: calls.append(request.url) if '/api/studies?' in request.url else None)
        page.evaluate('toolFrames.length = 0')
        self.assertTrue(page.evaluate('url => kinViewerOpenPatient(url)', '/ohif/viewer?StudyInstanceUIDs=' + b.uid))
        expect(page.get_by_role('tablist', name='Patients')).to_contain_text(b.patient_id)
        page.wait_for_function('() => window.kinViewerJobWorkspaceState?.()?.busy === true')
        tools.get_by_role('toolbar', name='Frequent Tools').get_by_role('button', name='Zoom', exact=True).click()
        expect(tools.get_by_role('status')).to_contain_text('완료 후 도구를 다시 선택하세요')
        for route in held_jobs: route.continue_()
        page.unroute('**/api/studies/*/viewer-jobs*')
        page.wait_for_function('() => window.kinViewerHistoryWorkspaceState?.()?.busy === false && window.kinViewerJobWorkspaceState?.()?.busy === false')
        canvas_ready(page, 1)
        page.keyboard.press('j'); self.assertEqual(page.evaluate(active), 'Zoom')
        self.assertEqual(len(calls), 1, calls)
        self.assertEqual(parse_qs(urlsplit(calls[0]).query).get('uids'), [b.uid])
        page.set_viewport_size({'width': 3200, 'height': 1050})
        page.locator('[data-cy="viewport-pane"]').first.click(position={'x':100,'y':100})
        page.get_by_role('button', name='Viewer Settings', exact=True).click()
        box = dialog.bounding_box()
        monitor = page.evaluate('({right:Math.min(innerWidth,(screen.availLeft||0)+screen.availWidth-screenX),left:Math.max(0,(screen.availLeft||0)-screenX)})')
        self.assertGreaterEqual(box['x'], monitor['left'])
        self.assertLessEqual(box['x'] + box['width'], monitor['right'])
        dialog.get_by_role('button', name='Cancel', exact=True).click()
        samples = page.evaluate('toolFrames')
        self.assertFalse(any(frame['stock'] for frame in samples))
        self.assertTrue(all(frame['binding'] == 'J' for frame in samples if frame.get('binding')))
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/viewer-ux-u2/screens')); folder.mkdir(parents=True, exist_ok=True)
        (folder / 'tool-frames-and-lookup.json').write_text(json.dumps({'frames': samples, 'calls': calls}, indent=2), encoding='utf-8')

    def test_shell_14_chrome_load_failure_keeps_native_image(self):
        fixture = self.multiple('U2ASSET-' + uuid.uuid4().hex[:12], 'chrome fallback', '20260801')
        work = self.login(); page = work.context.new_page()
        page.route('**/viewer-ux-shell.js', lambda route: route.fulfill(status=503, body='Unavailable'))
        page.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + fixture.uid)
        canvas_ready(page, 1)
        expect(page.locator('[data-cy="viewport-grid"]')).to_be_visible()
        expect(page.locator('#root [data-cy="Zoom"]')).to_be_visible()

    def test_shell_00_native_runtime(self):
        fixture = self.multiple('U2-' + uuid.uuid4().hex[:16], 'current', '20260801')
        work = self.login()
        self.select(work, fixture)
        with work.context.expect_page() as opened:
            work.locator('#m-filmbox').click()
        page = opened.value
        page.wait_for_url('**/ohif/viewer?**')
        canvas_ready(page, 1)
        expect(page.get_by_role('region', name='Viewport Information')).to_have_count(1)
        strip = page.get_by_role('region', name='Series', exact=True)
        expect(strip).to_be_visible()
        expect(strip.get_by_role('button', name='1/2 D03A current', exact=False)).to_be_visible()
        expect(strip.get_by_role('button', name='2/2 D02E second series', exact=False)).to_be_visible()
        page.wait_for_function('''() => {
          const images=[...document.querySelectorAll('.kin-viewer-series-strip img')];
          return images.length===2 && images.every(i=>!i.hidden && i.complete && i.naturalWidth>0);
        }''')
        evidence = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/viewer-ux-u2/screens'))
        evidence.mkdir(parents=True, exist_ok=True)
        snapshot = page.evaluate('''() => {
          const grid = services.viewportGridService;
          const cells = [...grid.getState().viewports.values()].map(cell => {
            const v = services.cornerstoneViewportService.getCornerstoneViewport(cell.viewportId);
            return {id: cell.viewportId, options: cell.viewportOptions, type: v?.type,
              image: v?.getCurrentImageId?.(), element: v?.element?.outerHTML.slice(0, 500)};
          });
          return {url: location.href, browser: navigator.userAgent,
            window: {width: innerWidth, height: innerHeight, dpr: devicePixelRatio},
            assets: [...document.scripts].map(s => s.src).filter(Boolean),
            grid: grid.getState().layout, cells};
        }''')
        (evidence / 'runtime.json').write_text(json.dumps(snapshot, indent=2), encoding='utf-8')
        self.assertTrue(snapshot['cells'])
        self.assertTrue(all('/studies/' + fixture.uid + '/' in c['image'] for c in snapshot['cells']))
        page.screenshot(path=str(evidence / 'workspace-entry.png'))
        (evidence / 'viewer.html').write_text(page.content(), encoding='utf-8')
        self.grid(page, 2)
        self.assertEqual(len(self.cells(page)), 2)
        expect(page.get_by_role('region', name='Viewport Information')).to_have_count(2)
        self.drag(page, 'D02E second series', 1)
        page.wait_for_function('''() => [...services.viewportGridService.getState().viewports.values()]
          .every(c => services.cornerstoneViewportService.getCornerstoneViewport(c.viewportId)?.getCurrentImageId?.())''')
        expect(page.get_by_role('region', name='Viewport Information')).to_have_count(2)
        self.assertTrue(page.evaluate('''() => [...document.querySelectorAll('[data-cy="viewport-pane"]')].every(p => {
          const bar=p.querySelector('.kin-viewer-info-bar'), canvas=p.querySelector('canvas');
          return bar && canvas && bar.getBoundingClientRect().bottom <= canvas.getBoundingClientRect().top;
        })'''))
        for bar in page.get_by_role('region', name='Viewport Information').all():
            expect(bar).to_contain_text(fixture.patient_id)
            expect(bar).to_contain_text('1×2')
        before = self.cells(page)
        active = page.evaluate('services.viewportGridService.getActiveViewportId()')
        strip.get_by_role('button', name='1/2 D03A current', exact=False).focus()
        page.keyboard.press('Enter')
        page.wait_for_function('''id => services.displaySetService.getDisplaySetByUID(
          services.viewportGridService.getState().viewports.get(id).displaySetInstanceUIDs[0]).SeriesNumber == 1''', arg=active)
        after = self.cells(page)
        self.assertEqual([c for c in before if c['id'] != active], [c for c in after if c['id'] != active])
        page.screenshot(path=str(evidence / 'split.png'))
        self.grid(page, 1)
        canvas_ready(page, 1)
        direct = work.context.new_page()
        self.launch(direct, [fixture])
        direct.screenshot(path=str(evidence / 'direct-entry.png'))
        self.assertTrue(all('/studies/' + fixture.uid + '/' in c['image'] for c in self.cells(direct)))
        expect(direct.get_by_role('region', name='Viewport Information')).to_contain_text(fixture.patient_id)
        expect(direct.get_by_role('region', name='Series', exact=True).get_by_role('button', name='1/2 D03A current', exact=False)).to_be_visible()
        palette = direct.evaluate('''() => {
          const info=getComputedStyle(document.querySelector('.kin-viewer-info-bar'));
          return [getComputedStyle(document.body).backgroundColor, info.backgroundColor, info.color,
            getComputedStyle(document.querySelector('.kin-viewer-info-mode')).color,
            getComputedStyle(document.querySelector('.kin-series-card[aria-pressed="true"]')).borderTopColor];
        }''')
        self.assertEqual(palette, ['rgb(33, 33, 33)', 'rgb(45, 45, 45)', 'rgb(227, 227, 227)', 'rgb(180, 180, 180)', 'rgb(138, 180, 200)'])
        self.assertEqual(direct.evaluate('getComputedStyle(document.querySelector("canvas")).filter'), 'none')

    def check_delayed_identity(self, page, current, prior):
        bar = page.get_by_role('region', name='Viewport Information')
        expect(bar).to_contain_text(current.patient_id)
        page.wait_for_function('() => window.kinViewerHistoryWorkspaceState?.()?.busy === false && window.kinViewerJobWorkspaceState?.()?.busy === false')
        snapshot = """() => {
          const id=services.viewportGridService.getActiveViewportId(),
            viewport=services.cornerstoneViewportService.getCornerstoneViewport(id),
            pane=document.querySelector('[data-cy="viewport-pane"]'),
            label=pane.querySelector('.kin-viewer-info-identity'), image=viewport?.getCurrentImageId?.();
          return {text:label.textContent,title:label.title,image,
            displayedImage:viewport?.getCornerstoneImage?.()?.imageId,
            imageCached:!!(image&&cornerstone.cache.getImage(image)),
            context:KinViewerUX.viewport(id),hasCanvas:!!pane.querySelector('canvas')};
        }"""
        # Establish both real stacks, then evict only the inactive current
        # study so the delayed transport cannot be bypassed by an earlier load.
        for study, description in [(current, 'current'), (prior, 'prior')]:
            self.drag(page, 'D03A ' + description, 0)
            page.wait_for_function('''uid => {
              const id=services.viewportGridService.getActiveViewportId(),
                viewport=services.cornerstoneViewportService.getCornerstoneViewport(id);
              return KinViewerUX.viewport(id)?.studyUid===uid &&
                viewport?.getCornerstoneImage?.()?.imageId.includes('/studies/'+uid+'/');
            }''', arg=study.uid)
            if study is current:
                current_images = page.evaluate('''() => services.cornerstoneViewportService
                  .getCornerstoneViewport(services.viewportGridService.getActiveViewportId()).getImageIds()''')
        target, label, date = current, 'current', '20260801'
        page.evaluate('''images => { for (const id of images) {
          if (cornerstone.cache.getImageLoadObject(id)) cornerstone.cache.removeImageLoadObject(id);
        } }''', current_images)
        before = page.evaluate(snapshot)
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/viewer-ux-u2/screens'))
        folder.mkdir(parents=True, exist_ok=True)
        states = {'before': before}
        def record(stage):
            states[stage] = page.evaluate(snapshot)
            (folder / 'delayed-identity.json').write_text(json.dumps(states, indent=2), encoding='utf-8')
            page.screenshot(path=str(folder / ('delayed-identity-' + stage + '.png')))
        record('before')
        held = []
        route_pattern = '**/dicom-web/**/frames/**'
        page.route(route_pattern, lambda route: held.append(route))
        try:
            with page.expect_request(lambda request: '/dicom-web/studies/' + target.uid + '/' in request.url and '/frames/' in request.url):
                self.drag(page, 'D03A ' + label, 0)
            page.wait_for_function("""uid => services.cornerstoneViewportService
              .getCornerstoneViewport(services.viewportGridService.getActiveViewportId())
              ?.getCurrentImageId?.().includes('/studies/'+uid+'/')""", arg=target.uid)
            page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
            record('loading')
        finally:
            try:
                for route in held:
                    route.continue_()
            finally:
                page.unroute(route_pattern)
        canvas_ready(page, 1)
        expect(bar).to_contain_text(date)
        record('recovered')
        # SR provenance also uses this native empty-assignment boundary.
        page.evaluate("""() => { const grid=services.viewportGridService;
          grid.setDisplaySetsForViewport({viewportId:grid.getActiveViewportId(),displaySetInstanceUIDs:[]}); }""")
        page.wait_for_function("""() => !document.querySelector('[data-cy="viewport-pane"] canvas')""")
        expect(bar).to_contain_text('Loading / No image')
        record('empty')
        with self.subTest(boundary='delayed-frame-identity'):
            self.assertTrue(held, 'The real DICOM frame request must be held')
            self.assertFalse(states['loading']['imageCached'], 'This case requires an uncached frame')
            self.assertNotIn(date, states['loading']['text'])
            self.assertNotIn(date, states['loading']['title'])
            self.assertIsNone(states['loading']['context'])
        with self.subTest(boundary='rendered-frame-recovery'):
            self.assertEqual(states['recovered']['context']['studyUid'], target.uid)
            self.assertIn(date, states['recovered']['title'])
        with self.subTest(boundary='empty-viewport-identity'):
            self.assertFalse(states['empty']['title'])
            self.assertIsNone(states['empty']['context'])

    def test_shell_01_cell_study_and_metadata_retry(self):
        patient = 'U2-' + uuid.uuid4().hex[:16]
        current = self.multiple(patient, 'current', '20260801')
        prior = self.ct(patient, 'prior', '20260701')
        page = self.launch(self.login(), [current, prior])
        self.check_delayed_identity(page, current, prior)
        self.grid(page, 2)
        self.drag(page, 'D03A current', 0)
        self.drag(page, 'D03A prior', 1)
        current_series = next(m['0020000E']['Value'][0] for m in self.metadata(page, current)
                              if m['0008103E']['Value'][0] == 'D03A current')
        self.identity(page, [next(r for r in self.fixture_refs(page, current) if r['series'] == current_series), self.fixture_refs(page, prior)[0]])
        bars = page.get_by_role('region', name='Viewport Information')
        expect(bars.nth(0)).to_contain_text('20260801')
        expect(bars.nth(1)).to_contain_text('20260701')

        expect(bars.nth(0)).to_contain_text('D03A current')
        expect(bars.nth(1)).to_contain_text('D03A prior')
        strip = page.get_by_role('region', name='Series', exact=True)
        expect(strip.get_by_role('button', name='1/2 D03A prior', exact=False)).to_be_visible()
        # Faults are injected at the real network boundary after a rendered baseline.
        path = '**/dicom-web/studies/' + current.uid + '/metadata'
        page.route(path, lambda route: route.fulfill(status=503, body='Unavailable'), times=1)
        page.route('**/instances/*/preview', lambda route: route.fulfill(status=503, body='Unavailable'))
        DisplayControlsE2E.choose(self, page, 0)
        expect(strip.get_by_role('button', name='Retry', exact=True)).to_be_visible()
        strip.get_by_role('button', name='Retry', exact=True).click()
        expect(strip.get_by_text('Preview unavailable', exact=True)).to_have_count(2)
        expect(strip.get_by_role('button', name='2/2 D02E second series', exact=False)).to_be_enabled()
        expect(bars.nth(0)).to_contain_text('20260801')
        expect(bars.nth(1)).to_contain_text('20260701')

    def test_shell_02_multiframe_duplicate_missing_and_long_title(self):
        current = self.multiple('U2-' + uuid.uuid4().hex[:16], 'current', '20260801')
        multi = CineE2E.series(self, current, 7, 'U2 multiframe')
        original = next(d for d in (dcmread(io.BytesIO(self.stack.orthanc_bytes(path))) for path in self.originals())
                        if d.Modality == 'CT' and str(d.StudyInstanceUID) == current.uid)
        for number, title in [(1, 'U2 duplicate number with a long title retained for keyboard use'), (None, 'U2 missing number')]:
            data = copy.deepcopy(original)
            data.SeriesInstanceUID = generate_uid(); data.SOPInstanceUID = generate_uid()
            data.file_meta.MediaStorageSOPInstanceUID = data.SOPInstanceUID
            data.SeriesDescription = title
            if number is None:
                if 'SeriesNumber' in data: del data.SeriesNumber
            else: data.SeriesNumber = number
            output = io.BytesIO(); data.save_as(output, write_like_original=False)
            self.assertEqual(self.stack._orthanc_request('POST', '/instances', output.getvalue()).status, 200)
        page = self.launch(self.login(), [current])
        strip = page.get_by_role('region', name='Series', exact=True)
        expect(strip.get_by_role('button', name='Unknown/1 U2 missing number', exact=False)).to_be_visible()
        expect(strip.get_by_role('button', name='1/1 U2 duplicate number', exact=False)).to_be_visible()
        expect(strip.get_by_role('button', name='1/2 D03A current', exact=False)).to_be_visible()
        card = strip.get_by_role('button', name='7/7 U2 multiframe', exact=False)
        expect(card).to_be_visible()
        page.wait_for_function('() => window.kinViewerHistoryWorkspaceState?.()?.busy === false && window.kinViewerJobWorkspaceState?.()?.busy === false')
        card.focus(); page.keyboard.press('Enter')
        page.wait_for_function('''series => {
          const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());
          return v?.getCurrentImageId?.().includes('/series/'+series+'/') && v.getImageIds().length===7;
        }''', arg=multi['series'])
        # A narrower window is a browser reachability check, not first-site equipment acceptance.
        size = strip.locator('.kin-series-list').evaluate('''element => {
          const cards=[...element.querySelectorAll('.kin-series-card')].map(c=>c.getBoundingClientRect());
          return {width: Math.floor(innerWidth - element.clientWidth + cards.at(-1).left - cards[0].left), height: innerHeight};
        }''')
        page.set_viewport_size(size)
        page.wait_for_function('''() => {
          const list=document.querySelector('.kin-series-list'); return list.scrollWidth>list.clientWidth;
        }''')
        overflow = strip.locator('.kin-series-list').evaluate('(element) => ({content:element.scrollWidth, available:element.clientWidth})')
        self.assertGreater(overflow['content'], overflow['available'])
        card.focus()
        # focus() on the already-focused card does not scroll it after resize.
        # Re-enter by the reader's actual keyboard path and check reachability.
        page.keyboard.press('Shift+Tab'); page.keyboard.press('Tab')
        expect(card).to_be_focused()
        expect(card).to_be_in_viewport()

    def test_shell_03_toolbar_shortcuts_and_account_roaming(self):
        current = self.multiple('U2-' + uuid.uuid4().hex[:16], 'current', '20260801')
        page = self.launch(self.login(), [current])
        tools = page.get_by_role('region', name='Image Tools', exact=True)
        bar = tools.get_by_role('toolbar', name='Frequent Tools')
        zoom = bar.get_by_role('button', name='Zoom', exact=True)
        expect(zoom).to_be_enabled()
        expect(zoom).to_have_attribute('draggable', 'true')
        page.wait_for_function('() => window.kinViewerHistoryWorkspaceState?.()?.busy === false && window.kinViewerJobWorkspaceState?.()?.busy === false')
        active_tool = '''() => services.toolGroupService.getToolGroupForViewport(
          services.viewportGridService.getActiveViewportId()).getActivePrimaryMouseButtonTool()'''
        zoom.click()
        self.assertEqual(page.evaluate(active_tool), 'Zoom')
        canvas = page.locator('[data-cy="viewport-pane"] canvas').first
        canvas.click(position=dict(x=100, y=100))
        page.keyboard.press('p')
        self.assertEqual(page.evaluate(active_tool), 'Pan')
        page.keyboard.press('z')
        self.assertEqual(page.evaluate(active_tool), 'Zoom')
        zoom.drag_to(tools.locator('summary'))
        expect(bar.get_by_role('button', name='Zoom', exact=True)).to_have_count(0)
        more = tools.get_by_role('group', name='More Tools')
        expect(more.get_by_role('button', name='Zoom', exact=True)).to_be_visible()
        stored = document_request(page, 'GET', '/api/workspace-shortcuts').json()
        self.assertNotIn('Zoom', stored['viewerSettings']['bar'])
        more.get_by_role('button', name='Zoom', exact=True).drag_to(bar)
        expect(bar.get_by_role('button', name='Zoom', exact=True)).to_be_enabled()
        page.locator('#kin-workspace-dock nav button[aria-controls="kin-viewer-layout"]').click()
        page.get_by_role('button', name='Viewer Settings', exact=True).click()
        dialog = page.get_by_role('dialog', name='Viewer Settings')
        field = dialog.get_by_label('Zoom Shortcut', exact=True)
        field.fill('j')
        self.assertEqual(page.evaluate(active_tool), 'Zoom')
        dialog.get_by_role('button', name='Save', exact=True).click()
        expect(dialog).not_to_be_visible()
        expect(bar.get_by_role('button', name='Zoom', exact=True)).to_have_attribute('aria-keyshortcuts', 'J')
        canvas.click(position=dict(x=100, y=100))
        page.keyboard.press('p'); self.assertEqual(page.evaluate(active_tool), 'Pan')
        page.keyboard.press('z'); self.assertEqual(page.evaluate(active_tool), 'Pan')
        page.keyboard.press('j'); self.assertEqual(page.evaluate(active_tool), 'Zoom')
        # A real existing editor receives text and composing keys without tool changes.
        job = page.get_by_label('Job Title', exact=True)
        job.evaluate('''element => {
          window.typedKeys = [];
          for (const type of ['keydown', 'keypress', 'keyup']) element.addEventListener(type, event => typedKeys.push([type, event.key]));
        }''')
        voi = '''() => services.cornerstoneViewportService.getCornerstoneViewport(
          services.viewportGridService.getActiveViewportId()).getProperties().voiRange'''
        before_typing = page.evaluate(voi)
        job.fill('keep '); job.press('p'); job.press('s'); job.press('2')
        job.dispatch_event('keydown', dict(key='p', code='KeyP', isComposing=True, bubbles=True))
        self.assertEqual(page.evaluate(active_tool), 'Zoom')
        expect(job).to_have_value('keep ps2')
        for kind in ['keydown', 'keypress', 'keyup']:
            self.assertIn([kind, 'p'], page.evaluate('typedKeys'))
        self.assertEqual(page.evaluate(voi), before_typing)
        layout = bar.get_by_role('button').evaluate_all('nodes => nodes.map(n => n.getAttribute("aria-label"))')
        # A separate browser context has no local storage from the first PC.
        other = self.launch(self.login(), [current])
        other_bar = other.get_by_role('toolbar', name='Frequent Tools')
        expect(other_bar.get_by_role('button', name='Zoom', exact=True)).to_have_attribute('aria-keyshortcuts', 'J')
        self.assertEqual(other_bar.get_by_role('button').evaluate_all('nodes => nodes.map(n => n.getAttribute("aria-label"))'), layout)
        server = document_request(other, 'GET', '/api/workspace-shortcuts').json()
        self.assertEqual(server['viewerSettings']['shortcuts']['Zoom'], 'j')
        # Saving workspace keys keeps viewer settings, and vice versa, on the real API.
        bindings = other.evaluate('KinWorkspaceShortcuts.migrate(null).map')
        result = document_request(other, 'PUT', '/api/workspace-shortcuts', headers={'X-KIN-CSRF': '1'},
                                  data=dict(expectedOwner=server['owner'], revision=server['revision'], bindings=bindings))
        self.assertEqual(result.status, 200)
        self.assertEqual(result.json()['viewerSettings'], server['viewerSettings'])
        stale = document_request(other, 'PUT', '/api/workspace-shortcuts', headers={'X-KIN-CSRF': '1'},
                                 data=dict(expectedOwner=server['owner'], revision=server['revision'], viewerSettings=server['viewerSettings']))
        self.assertEqual(stale.status, 409)
        technician = self.login('tech')
        self.assertIsNone(document_request(technician, 'GET', '/api/workspace-shortcuts').json()['viewerSettings'])
        page.get_by_role('button', name='Viewer Settings', exact=True).click()
        dialog.get_by_label('Zoom Shortcut', exact=True).fill('k')
        dialog.get_by_role('button', name='Save', exact=True).focus()
        page.keyboard.press('p')
        self.assertEqual(page.evaluate(active_tool), 'Zoom')
        page.route('**/api/workspace-shortcuts', lambda route: route.fulfill(status=503, body='Unavailable'), times=1)
        dialog.get_by_role('button', name='Save', exact=True).click()
        expect(dialog).to_contain_text('계정 설정 응답을 읽지 못했습니다')
        expect(bar.get_by_role('button', name='Zoom', exact=True)).to_have_attribute('aria-keyshortcuts', 'J')
        dialog.get_by_role('button', name='Cancel', exact=True).click()
        page.get_by_role('button', name='Reload Settings', exact=True).click()
        page.get_by_role('button', name='Viewer Settings', exact=True).click()
        dialog.get_by_label('Zoom Shortcut', exact=True).fill('')
        dialog.get_by_role('button', name='Save', exact=True).click()
        expect(dialog).not_to_be_visible()
        canvas.click(position=dict(x=100, y=100)); page.keyboard.press('p'); page.keyboard.press('j')
        self.assertEqual(page.evaluate(active_tool), 'Pan')
        page.get_by_role('button', name='Viewer Settings', exact=True).click()
        dialog.get_by_role('button', name='Restore Defaults', exact=True).click()
        dialog.get_by_role('button', name='Save', exact=True).click()
        expect(dialog).not_to_be_visible()
        canvas.click(position=dict(x=100, y=100)); page.keyboard.press('z')
        self.assertEqual(page.evaluate(active_tool), 'Zoom')
        page.get_by_role('button', name='Viewer Settings', exact=True).click()
        dialog.get_by_label('Zoom Shortcut', exact=True).fill('2')
        dialog.get_by_role('button', name='Save', exact=True).click()
        expect(dialog).not_to_be_visible()
        canvas.click(position=dict(x=100, y=100)); page.keyboard.press('p')
        before_override = page.evaluate(voi); page.keyboard.press('2')
        self.assertEqual(page.evaluate(active_tool), 'Zoom')
        self.assertEqual(page.evaluate(voi), before_override)
        self.assertEqual(document_request(page, 'GET', '/api/workspace-shortcuts').json()['bindings'], bindings)
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/viewer-ux-u2/screens')); folder.mkdir(parents=True, exist_ok=True)
        other.screenshot(path=str(folder / 'toolbar-roaming.png'))

    def test_shell_15_flip_rotate_shift_keys(self):
        # F8 (2026-10-26 reader answer): Shift+H/V flip, Shift+L/R turn; L and R stay Length and Rectangle.
        fixture = self.multiple('U2TURN-' + uuid.uuid4().hex[:12], 'turn keys', '20260801')
        work = self.login()
        record = document_request(work, 'GET', '/api/workspace-shortcuts').json()
        # A record saved by the first U2 viewer, which had no key for the flips and turns.
        first = {'version': 1, 'bar': ['Zoom', 'Length', 'RectangleROI'],
                 'shortcuts': {'Zoom': 'z', 'Length': 'l', 'RectangleROI': 'r', 'flipHorizontal': None, 'rotate-right': None}}
        response = document_request(work, 'PUT', '/api/workspace-shortcuts', headers={'X-KIN-CSRF': '1'},
                                    data=dict(expectedOwner=record['owner'], revision=record['revision'], viewerSettings=first))
        self.assertEqual(response.status, 200)
        page = self.launch(work, [fixture])
        page.wait_for_function('() => window.kinViewerHistoryWorkspaceState?.()?.busy === false && window.kinViewerJobWorkspaceState?.()?.busy === false')
        tools = page.get_by_role('region', name='Image Tools', exact=True)
        bar = tools.get_by_role('toolbar', name='Frequent Tools')
        expect(bar.get_by_role('button', name='Zoom', exact=True)).to_be_enabled()
        keys = {'Flip Horizontal': 'Shift+H', 'Flip Vertical': 'Shift+V', 'Rotate Left': 'Shift+L', 'Rotate Right': 'Shift+R'}
        tools.locator('summary').click()
        more = tools.get_by_role('group', name='More Tools')
        for name, key in keys.items():
            button = more.get_by_role('button', name=name, exact=True)
            expect(button).to_be_enabled()
            expect(button).to_have_attribute('aria-keyshortcuts', key)
            expect(button).to_have_attribute('title', name + ' · ' + key + ' — 끌어서 도구 위치를 바꿀 수 있습니다.')
            expect(button.locator('kbd')).to_have_text(key)
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/viewer-ux-u2/screens')); folder.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(folder / 'shift-flip-rotate-more.png'))
        tools.locator('summary').click()
        active_tool = '''() => services.toolGroupService.getToolGroupForViewport(
          services.viewportGridService.getActiveViewportId()).getActivePrimaryMouseButtonTool()'''
        view = '''() => {const v=services.cornerstoneViewportService.getCornerstoneViewport(
          services.viewportGridService.getActiveViewportId()), c=v.getCamera();
          return {h:!!c.flipHorizontal, v:!!c.flipVertical, rotation:(Math.round(v.getViewPresentation().rotation)%360+360)%360};}'''
        def settle(expected, after):
            try:
                page.wait_for_function('expected => JSON.stringify((' + view + ')()) === JSON.stringify(expected)', arg=expected)
            except Exception:
                self.fail(after + ': expected ' + json.dumps(expected) + ', the viewer shows ' + json.dumps(page.evaluate(view)))
        canvas = page.locator('[data-cy="viewport-pane"] canvas').first
        canvas.click(position=dict(x=100, y=100))
        start = page.evaluate(view)
        self.assertEqual(start, {'h': False, 'v': False, 'rotation': 0})
        turned = lambda degrees: dict(start, rotation=degrees)
        # Rotate Left from 0 degrees is the case the stock counter-clockwise command leaves unturned.
        for step, (key, expected) in enumerate([('Shift+R', turned(90)), ('Shift+L', start), ('Shift+L', turned(270)), ('Shift+R', start),
                                                ('Shift+H', dict(start, h=True)), ('Shift+V', dict(start, h=True, v=True)),
                                                ('Shift+H', dict(start, v=True)), ('Shift+V', start)]):
            page.keyboard.press(key)
            settle(expected, 'step %d %s' % (step + 1, key))
        # With Caps Lock on, Shift+H reports a lower-case key; it is still Shift+H.
        page.evaluate('''() => (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown',
          {key:'h', code:'KeyH', shiftKey:true, bubbles:true, cancelable:true}))''')
        settle(dict(start, h=True), 'Caps Lock Shift+H')
        page.keyboard.press('Shift+H')
        settle(start, 'Shift+H back')
        # Plain L and R choose Length and Rectangle; the stock turn on those letters does not also run.
        page.keyboard.press('l'); self.assertEqual(page.evaluate(active_tool), 'Length')
        page.keyboard.press('r'); self.assertEqual(page.evaluate(active_tool), 'RectangleROI')
        page.keyboard.press('h'); page.keyboard.press('v')
        page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        self.assertEqual(page.evaluate(view), start)
        # Text fields keep the letters; no image changes while typing.
        page.locator('#kin-workspace-dock nav button[aria-controls="kin-viewer-layout"]').click()
        for label in ['Job Title', 'Description']:
            field = page.locator('#kin-viewer-jobs').get_by_label(label, exact=True)
            field.fill('')
            for key in ['Shift+H', 'Shift+V', 'Shift+L', 'Shift+R', 'l', 'r']: field.press(key)
            expect(field).to_have_value('HVLRlr')
            page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
            self.assertEqual(page.evaluate(view), start)
            self.assertEqual(page.evaluate(active_tool), 'RectangleROI')
            field.fill('')
        # The account editor shows and saves Shift keys; a v1 record is written back as v2.
        page.get_by_role('button', name='Viewer Settings', exact=True).click()
        dialog = page.get_by_role('dialog', name='Viewer Settings')
        for name, key in keys.items():
            expect(dialog.get_by_label(name + ' Shortcut', exact=True)).to_have_value(key)
        rotate_left = dialog.get_by_label('Rotate Left Shortcut', exact=True)
        revision = document_request(page, 'GET', '/api/workspace-shortcuts').json()['revision']
        for wrong in ['Shift+1', 'Shift+H', 'Control+K']:
            rotate_left.fill(wrong); dialog.get_by_role('button', name='Save', exact=True).click()
            expect(dialog.get_by_role('status')).to_contain_text('Shift+영문자로 지정하세요')
            expect(dialog).to_be_visible()
        self.assertEqual(document_request(page, 'GET', '/api/workspace-shortcuts').json()['revision'], revision)
        rotate_left.fill('shift+k')
        dialog.get_by_role('button', name='Save', exact=True).click()
        expect(dialog).not_to_be_visible()
        saved = document_request(page, 'GET', '/api/workspace-shortcuts').json()['viewerSettings']
        self.assertEqual(saved['version'], 2)
        self.assertEqual({key: saved['shortcuts'][key] for key in ['flipHorizontal', 'flipVertical', 'rotate-left', 'rotate-right', 'Length', 'RectangleROI']},
                         {'flipHorizontal': 'shift+h', 'flipVertical': 'shift+v', 'rotate-left': 'shift+k', 'rotate-right': 'shift+r',
                          'Length': 'l', 'RectangleROI': 'r'})
        tools.locator('summary').click()
        expect(more.get_by_role('button', name='Rotate Left', exact=True)).to_have_attribute('aria-keyshortcuts', 'Shift+K')
        tools.locator('summary').click()
        # A click with Rectangle active would start a mark; return to Zoom first.
        page.keyboard.press('z'); self.assertEqual(page.evaluate(active_tool), 'Zoom')
        canvas.click(position=dict(x=100, y=100))
        page.keyboard.press('Shift+L')
        page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        self.assertEqual(page.evaluate(view), start)
        page.keyboard.press('Shift+K')
        settle(turned(270), 'Shift+K')


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ViewerUXShellE2E(name) for name in loader.getTestCaseNames(ViewerUXShellE2E)
                              if name.startswith('test_shell_'))



if __name__ == '__main__':
    unittest.main()
