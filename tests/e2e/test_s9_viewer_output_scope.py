"""U7 O1-O4: normal workspace launch, real OHIF, API and synthetic CT output.

Only network responses are held/failed. Screens and assets are never replaced.
PDF is Chromium output, not evidence of delivery to a physical printer.
"""
import hashlib
import json
import os
import re
from PIL import Image
from pathlib import Path
import unittest
from unittest.mock import patch
import uuid

from playwright.sync_api import expect
from pynetdicom.association import Association
from test_viewer_job_print import ViewerJobPrintE2E
from test_viewer_display_scope import ViewerDisplayScopeE2E
from test_prior_selection import canvas_ready


# Existing viewer-launch.js notices for a window that cannot be replaced yet.
BUSY_WINDOW = '열린 대화상자를 닫은 뒤'
DIRTY_WINDOW = '저장하지 않은 표식이나 작업 내용'


class ServedViewerFlow:
    def served_viewer(self, current, compare=False):
        work = self.login()
        self.open_toolbar_group(work, '#image-opening-open')
        work.locator('#image-opening-open').click()
        work.get_by_label('Include Latest Prior', exact=True).set_checked(compare)
        work.get_by_role('button', name='Done', exact=True).click()
        self.select(work, current)
        with work.context.expect_page() as opened:
            work.locator('#m-filmbox').click()
        page = opened.value
        canvas_ready(page, 2 if compare else 1)
        page.wait_for_function('''() => window.KinViewerUX &&
          !kinViewerHistoryWorkspaceState().busy && !kinViewerJobWorkspaceState().busy''')
        return work, page

    # The rendered identity of every painted cell, read from the image the viewport draws.
    def rendered(self, page):
        return page.evaluate('''() => [...services.viewportGridService.getState().viewports.values()]
          .sort((a,b)=>a.y-b.y||a.x-b.x).map(g=>{
            const v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId),image=v?.getCurrentImageId?.();
            const m=image&&cornerstone.metaData.get('instance',image);
            return m?{study:m.StudyInstanceUID,series:m.SeriesInstanceUID,sop:m.SOPInstanceUID,patient:m.PatientID}:null;
          }).filter(Boolean)''')

    def shows(self, page, fixture):
        # A replaced viewport can exist before it has an image (for example while MPR is torn down).
        page.wait_for_function('uid => [...services.viewportGridService.getState().viewports.keys()].some(id => services.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageId?.()?.includes("/studies/"+uid+"/"))', arg=fixture.uid, timeout=45000)
        expect(page.locator('.kin-viewer-identity[data-study="' + fixture.uid + '"]')).to_be_visible(timeout=45000)
        page.wait_for_function('() => window.kinViewerJobWorkspaceState && !kinViewerJobWorkspaceState().busy && !kinViewerHistoryWorkspaceState().busy')

    def open_from_worklist(self, work, page, fixture, refusal=None):
        """The worklist Viewer action on an open viewer window: accepted, or refused with the existing notice."""
        before, cells, toast = page.url, self.rendered(page), work.locator('#toast')
        if refusal is not None:
            # An earlier identical notice must have expired so the refusal below is this click's. The worklist
            # is a background page here, where animation-frame polling is throttled: poll on a timer instead.
            work.wait_for_function('''text => { const t = document.querySelector('#toast');
              return !(t.classList.contains('show') && t.textContent.includes(text)); }''', arg=refusal, timeout=15000, polling=100)
        # A caller holding a response selects first; the worklist search must not use up the client's 30 s request bound.
        if work.locator('#rows tr.sel[data-uid="' + fixture.uid + '"]').count() != 1: self.select(work, fixture)
        work.locator('#m-filmbox').click()
        if refusal is None: return self.shows(page, fixture)
        expect(toast).to_have_class(re.compile(r'\bshow\b'))
        expect(toast).to_contain_text(refusal)
        self.assertEqual(page.url, before)
        self.assertEqual(self.rendered(page), cells)

    def evidence(self, page, name):
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/s9-u7/screens'))
        folder.mkdir(parents=True, exist_ok=True)
        page.bring_to_front()
        # Wait for the source pixels again after layout/focus changes, using
        # the asymmetric CT fixture's existing canvas_ready contrast contract.
        page.wait_for_function('''() => {
          const views=[...services.viewportGridService.getState().viewports.keys()]
            .map(id=>services.cornerstoneViewportService.getCornerstoneViewport(id))
            .filter(v=>v?.getCurrentImageId?.());
          return views.length && views.every(v=>{
            const c=v.getCanvas(),ctx=c?.getContext('2d');
            if(!ctx||!c.width||!c.height)return false;
            const d=ctx.getImageData(0,0,c.width,c.height).data;let lo=255,hi=0;
            for(let i=0;i<d.length;i+=16){lo=Math.min(lo,d[i]);hi=Math.max(hi,d[i]);}
            return hi-lo>100;
          });
        }''', timeout=60000)
        page.screenshot(path=str(folder / (name + '.png')))
        observed = page.evaluate('''() => ({url:location.href,browser:navigator.userAgent,
          size:[innerWidth,innerHeight,devicePixelRatio],visibility:document.visibilityState,focused:document.hasFocus(),patient:KinViewerPatientTabs.snapshot(),
          history:window.kinViewerHistoryWorkspaceState?.(),jobs:window.kinViewerJobWorkspaceState?.(),
          cells:[...services.viewportGridService.getState().viewports.keys()].map(id=>{
            const v=services.cornerstoneViewportService.getCornerstoneViewport(id),image=v?.getCurrentImageId?.();
            const m=image&&cornerstone.metaData.get('instance',image);
            return {id,image,study:m?.StudyInstanceUID,series:m?.SeriesInstanceUID,sop:m?.SOPInstanceUID,
              patient:m?.PatientID,name:m?.PatientName,overlay:v?.element?.querySelector('.kin-viewer-identity')?.textContent};
          })})''')
        observed['served_files'] = {}
        root = Path(__file__).resolve().parents[2]
        for source in ['config/ohif.js', 'worklist-v0/hpacs-lite/viewer-job-print.js',
                       'worklist-v0/hpacs-lite/viewer-editor-link.js', 'worklist-v0/hpacs-lite/viewer-jobs.js']:
            url = '/ohif/app-config.js' if source == 'config/ohif.js' else '/' + source.replace('worklist-v0/', 'worklist/')
            response = page.request.get(self.stack.proxy + url)
            self.assertEqual(response.status, 200)
            expected = (root / source).read_bytes()
            if source == 'config/ohif.js': self.assertTrue(expected in response.body())
            else: self.assertEqual(hashlib.sha256(expected).hexdigest(), hashlib.sha256(response.body()).hexdigest())
            observed['served_files'][url] = hashlib.sha256(response.body()).hexdigest()
        (folder / (name + '.json')).write_text(json.dumps(observed, ensure_ascii=False, indent=2), encoding='utf-8')
        return folder


class S9ViewerOutputScopeE2E(ServedViewerFlow, ViewerJobPrintE2E):
    def test_output_01_saved_current_scope_and_overlay_meaning(self):
        patient = 'U7O-' + uuid.uuid4().hex[:12]
        current = self.ct(patient, 'out current', '20260801')
        prior = self.ct(patient, 'out prior', '20260701')
        originals = self.originals()
        reports = {f.uid: self.report_rows(f) for f in [current, prior]}
        work, page = self.served_viewer(current, compare=True)
        self.grid(page, 2)
        canvas_ready(page, 2)
        work.locator('#findings').fill('U7 OUTPUT KEEP REPORT')
        self.open_layout_tools(page)
        page.get_by_label('Job Title', exact=True).fill('U7 saved display')
        self.click_job(page, 'Save New Job', '저장했습니다')
        saved = self.jobs(current)
        self.assertEqual(len(saved), 1)
        paper = self.output(page)
        for uid in [current.uid, prior.uid]: expect(paper.locator('main')).to_contain_text(uid)
        expect(paper.locator('main')).to_contain_text('익명화가 아닙니다')
        self.assertEqual(len(self.output_arrays(page, paper)), 2)
        self.evidence(page, 'output-saved-current-prior')
        page.locator('#kin-job-print').get_by_role('button', name='닫기', exact=True).click()
        expect(page.locator('#kin-job-print')).not_to_be_visible()
        self.evidence(page, 'output-preview-closed')
        page.locator('#kin-image-text-toggle').click()
        self.click_job(page, 'Print Current View', '')
        expect(page.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인', timeout=45000)
        paper = page.frame_locator('#kin-job-print iframe')
        expect(paper.locator('main')).to_contain_text(patient)
        expect(paper.locator('main')).to_contain_text('익명화가 아닙니다')
        expect(paper.locator('main')).to_contain_text('작업·표식·판독문을 저장하지 않는 출력')
        self.evidence(page, 'output-image-text-hidden')
        self.assertEqual(self.jobs(current), saved)
        self.assertEqual(self.originals(), originals)
        for f in [current, prior]: self.assertEqual(self.report_rows(f), reports[f.uid])
        expect(work.locator('#findings')).to_have_value('U7 OUTPUT KEEP REPORT')

    def hold_preview(self, page, fixture):
        held = []
        pattern = '**/api/studies/' + fixture.uid + '/viewer-jobs/preview'
        page.route(pattern, lambda route: held.append((route, route.fetch())))
        self.click_job(page, 'Print Current View', '')
        page.wait_for_function('() => document.querySelector("#kin-job-print")?.open')
        # Same response hold allowance as test_viewer_job_print.test_print_04.
        for _ in range(100):
            if held: break
            page.wait_for_timeout(50)
        self.assertTrue(held)
        return pattern, held

    def assert_output_matches(self, page, fixture, absent):
        status = page.locator('#kin-job-print [role=status]')
        expect(status).to_contain_text('미리보기 내용을 확인', timeout=45000)
        shown = self.rendered(page)
        self.assertTrue(shown)
        main = page.frame_locator('#kin-job-print iframe').locator('main')
        for cell in shown:
            # The output names the target the viewer actually draws now.
            self.assertEqual((cell['study'], cell['patient']), (fixture.uid, fixture.patient_id))
            expect(main).to_contain_text(cell['sop'])
        expect(main).to_contain_text(fixture.uid)
        expect(main).to_contain_text(fixture.patient_id)
        for text in absent: expect(main).not_to_contain_text(text)

    def test_output_02_late_preview_keeps_the_selected_target(self):
        patient, name = 'U7O-' + uuid.uuid4().hex[:12], 'U7동명이인^출력확인'
        send = Association.send_c_store
        def named_ct(association, dataset, *args, **kwargs):
            dataset.PatientName = name
            return send(association, dataset, *args, **kwargs)
        # Same-name fixtures are set in the real synthetic DICOM before C-STORE.
        with patch.object(Association, 'send_c_store', named_ct):
            current = self.ct(patient, 'preview current', '20260801')
            prior = self.ct(patient, 'preview prior', '20260701')
            other = self.ct('U7O-OTHER-' + uuid.uuid4().hex[:12], 'preview other', '20260801')
        work, page = self.served_viewer(current)
        self.open_layout_tools(page)

        # 1. current -> comparison while the current preview is pending: the
        # existing busy refusal keeps the window, then the answer shows current.
        # Selecting a worklist row does not load it into the open viewer.
        self.select(work, prior)
        self.assertEqual({cell['study'] for cell in self.rendered(page)}, {current.uid})
        pattern, held = self.hold_preview(page, current)
        self.open_from_worklist(work, page, prior, BUSY_WINDOW)
        for route, response in held: route.fulfill(response=response)
        page.unroute(pattern)
        self.assert_output_matches(page, current, [prior.uid])
        self.evidence(page, 'output-preview-refused-prior-switch')
        page.locator('#kin-job-print').get_by_role('button', name='닫기', exact=True).click()

        # 2. Close a pending current preview, switch to the comparison, then let
        # the old answer arrive. It is discarded; a new output names the prior.
        pattern, held = self.hold_preview(page, current)
        page.locator('#kin-job-print').get_by_role('button', name='닫기', exact=True).click()
        expect(page.locator('#kin-job-print')).not_to_be_visible()
        self.open_from_worklist(work, page, prior)
        for route, response in held: route.fulfill(response=response)
        page.unroute(pattern)
        page.wait_for_timeout(500)
        self.assertEqual(page.locator('#kin-job-print[open]').count(), 0)
        self.assertTrue(all(cell['study'] == prior.uid for cell in self.rendered(page)))
        self.open_layout_tools(page)
        self.click_job(page, 'Print Current View', '')
        self.assert_output_matches(page, prior, [current.uid])
        self.evidence(page, 'output-late-preview-then-prior')

        # 3. Same name, different patient: refused while the preview is open,
        # and after a real tab switch the output carries only the new patient.
        self.open_from_worklist(work, page, other, BUSY_WINDOW)
        self.assert_output_matches(page, prior, [current.uid, other.patient_id])
        page.locator('#kin-job-print').get_by_role('button', name='닫기', exact=True).click()
        self.open_from_worklist(work, page, other)
        expect(page.get_by_role('tablist', name='Patients').get_by_role('tab').filter(has_text=other.patient_id)).to_have_attribute('aria-selected', 'true')
        self.open_layout_tools(page)
        self.click_job(page, 'Print Current View', '')
        self.assert_output_matches(page, other, [patient, prior.uid, current.uid])
        self.evidence(page, 'output-same-name-other-patient')
        for fixture in [current, prior, other]: self.assertEqual(self.jobs(fixture), [])


    def test_output_03_native_capture_is_a_local_image(self):
        current = self.ct('U7C-' + uuid.uuid4().hex[:12], 'capture', '20260801')
        originals = self.originals()
        reports = self.report_rows(current)
        work, page = self.served_viewer(current)
        page.get_by_text('More', exact=True).click()
        capture = page.get_by_role('button', name='Capture', exact=True)
        expect(capture).to_have_attribute('title', re.compile('PNG'))
        expect(capture).to_have_attribute('title', re.compile('익명화가 아닙니다'))
        self.evidence(page, 'output-before-native-capture')
        before = self.cells(page)
        before_display = self.display(page)
        capture.click()
        self.evidence(page, 'output-native-capture-dialog')
        with page.expect_download() as saved:
            page.get_by_role('button', name=re.compile('Download', re.I)).last.click()
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/s9-u7/screens'))
        target = folder / saved.value.suggested_filename
        saved.value.save_as(target)
        with Image.open(target) as bitmap:
            actual_format = bitmap.format
            # The pinned dialog's default File Type is jpg; the entry states the bytes are PNG.
            self.assertGreater(max(hi-lo for lo,hi in bitmap.convert('RGB').getextrema()), 100)
            self.assertGreater(bitmap.width, 0)
            self.assertGreater(bitmap.height, 0)
        after_display = self.display(page)
        (folder / 'output-native-capture-preservation.json').write_text(json.dumps({
            'filename': target.name, 'format': actual_format,
            'before': before_display, 'after': after_display,
        }, ensure_ascii=False, indent=2), encoding='utf-8')
        with self.subTest(boundary='source'):
            self.assertEqual(self.cells(page), before)
        # Reuse the display contract: exact source/VOI/pixels, with its existing
        # allowance for native camera and patient-point floating point roundoff.
        with self.subTest(boundary='display'):
            ViewerDisplayScopeE2E.assert_restored(self, before_display, after_display)
        with self.subTest(boundary='originals'):
            self.assertEqual(self.originals(), originals)
        with self.subTest(boundary='report'):
            self.assertEqual(self.report_rows(current), reports)
        with self.subTest(boundary='jobs'):
            self.assertEqual(self.jobs(current), [])
        with self.subTest(boundary='file format'):
            self.assertEqual(actual_format, 'PNG', 'Capture is described as a PNG image: ' + target.name)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(S9ViewerOutputScopeE2E(name) for name in loader.getTestCaseNames(S9ViewerOutputScopeE2E)
                              if name.startswith('test_output_'))


if __name__ == '__main__': unittest.main(verbosity=2)
