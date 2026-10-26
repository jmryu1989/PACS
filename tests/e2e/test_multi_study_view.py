# coding: utf-8
"""W9UI-V V-LIVE (order 01-multi-study-view.md, Q02/Q10) -> RISK V-RESOLVE / V-DISPLAY -> TEST W9-UI live page.

Real BFF, API, database, Orthanc, OHIF and synthetic CT studies owned and cleaned by the stack's guard.

The candidate flow opens a frozen set through the real Module A-bound resolve endpoint. Both pages receive actual
200 ready metadata with ordered members and unique, nonblank recording references. Those references alone do not
prove display: each member becomes Displayed only after its original frame renders in the real OHIF window. The
first page shows [1, 2]; Next opens the odd last member alone. Clinical rows and original DICOM bytes stay unchanged.

The separate review regression labels its synthetic resolve boundary and exercises the real page, viewer, images,
measurement/save and lifecycle. Recording-unavailable text, blank-window closure and Retry remain covered by the
labelled UI-only failed-response scenarios in multi_study_view_dom_test.py and the client model suite.
"""
from __future__ import annotations

import sys
import os
import json
import time
from pathlib import Path
import unittest
from unittest.mock import patch
import uuid
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect

import test_worklist as base
import test_prior_selection as prior
import test_viewer_history as history
from viewer_tools import select_image_tool
import viewer_api_test as viewer_fixture

RESOLVE = "/api/studies/viewing-set/resolve"
CLINICAL = ("rs", "version", "holder", "draft", "findings", "conclusion", "recommendation", "confirm", "repDoc")


def ready_answer(body, patient):
    """SYNTHETIC RESOLVE: every requested member ready, in the W9-API wire shape (multi-study-view.service.ts answer())."""
    members = [{"uid": uid, "ordinal": ordinal, "status": "ready", "accessRef": f"SYN-W9-{body['requestId']}-{ordinal}",
                "metadata": {"patientId": patient, "patientName": "D03A SYNTHETIC", "institutionName": "SYN",
                             "studyDate": "", "modalities": ["CT"], "description": "SYN W9", "accession": ""}}
               for ordinal, uid in enumerate(body["studyUids"])]
    return {"compositionId": body["compositionId"], "generation": body["generation"], "requestId": body["requestId"],
            "sourcePatientKey": "SYN|" + patient, "scopeStatus": "ready", "members": members}


class MultiStudyViewE2E(base.WorklistE2E):
    @classmethod
    def setUpClass(cls):
        # The review regression saves a real manual measurement; its owned child rows need the viewer fixture cleanup.
        with patch.object(base, 'LiveStack', viewer_fixture.ViewerStack):
            super().setUpClass()

    originals = prior.PriorSelectionE2E.originals

    def tearDown(self):
        result = self._outcome.result
        if any(test is self for test, _ in result.failures + result.errors):
            folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/w9-review'))
            folder.mkdir(parents=True, exist_ok=True)
            for context in self.contexts:
                for index, page in enumerate(context.pages):
                    if '/ohif/viewer' not in page.url: continue
                    try:
                        state = page.evaluate('''() => ({url:location.href,
                          history:document.querySelector('#kin-viewer-history')?.innerText,
                          workspace:window.kinViewerHistoryWorkspaceState?.(),
                          annotations:cornerstoneTools.annotation.state.getAllAnnotations().map(a=>({
                            tool:a.metadata.toolName,points:a.data.handles.points,
                            invalidated:a.invalidated,stats:a.data.cachedStats}))})''')
                        (folder / f'{self._testMethodName}-viewer-{index}.json').write_text(
                            json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
                        page.screenshot(path=str(folder / f'{self._testMethodName}-viewer-{index}.png'))
                    except Exception as error: print('W9 viewer failure capture:', str(error)[:180], flush=True)
        super().tearDown()

    def ids(self, page):
        return parse_qs(urlsplit(page.url).query)["StudyInstanceUIDs"][0].split(",")

    def member(self, page, uid):
        return page.locator(f'#multi-study-members li[data-uid="{uid}"]')

    def clinical(self, fixtures):
        return {f.uid: {k: self.state(f).get(k) for k in CLINICAL} for f in fixtures}

    def assert_ready_response(self, response, order):
        self.assertEqual(response.status, 200)
        body, answer = response.request.post_data_json, response.json()
        self.assertEqual(answer["scopeStatus"], "ready")
        for field in ("compositionId", "generation", "requestId"):
            self.assertEqual(answer[field], body[field])
        self.assertEqual(body["studyUids"], order)
        members = answer["members"]
        self.assertEqual([member["uid"] for member in members], order)
        self.assertEqual([member["ordinal"] for member in members], list(range(len(order))))
        self.assertTrue(all(member["status"] == "ready" for member in members))
        refs = [member["accessRef"] for member in members]
        self.assertTrue(all(isinstance(ref, str) and ref.strip() for ref in refs))
        self.assertEqual(len(set(refs)), len(refs))
        return body, answer

    def test_w9_01_ready_set_with_receipts_displays_on_the_real_viewer(self):
        patient = "W9-" + uuid.uuid4().hex[:12]
        fixtures = [prior.synthetic_ct(self.stack, patient, "w9" + str(i), date, slices=2)
                    for i, date in enumerate(("20260803", "20260802", "20260801"))]
        originals, clinical = self.originals(), self.clinical(fixtures)
        page = self.login()
        page.locator("#quick").fill(patient)
        for f in fixtures:
            row = page.locator(f'#rows tr[data-uid="{f.uid}"]')
            expect(row).to_be_visible()
            row.click(modifiers=["Control"])
        expect(page.locator("#multi-selection-count")).to_have_text("Selected: 3")
        order = page.evaluate("() => [...document.querySelectorAll('#rows tr.multi-selected')].map(tr => tr.dataset.uid)")
        self.assertEqual(sorted(order), sorted(f.uid for f in fixtures))

        # A3 issues the actual ready metadata and recording references; no resolve response is intercepted.
        with page.context.expect_page() as opened, page.expect_response(lambda r: r.url.endswith(RESOLVE)) as reply:
            page.locator("#multi-selection-open-set").click()
        viewer = opened.value
        body, first = self.assert_ready_response(reply.value, order)
        bodies = [body]
        viewer.wait_for_url("**/ohif/viewer?**", timeout=30000)
        self.assertEqual(self.ids(viewer), order[:2])
        self.assertEqual(parse_qs(urlsplit(viewer.url).query).get("hangingProtocolId"), ["@ohif/hpCompare"])
        prior.canvas_ready(viewer, 2)
        for uid in order[:2]:
            expect(self.member(page, uid)).to_contain_text("Displayed", timeout=60000)
        expect(self.member(page, order[2])).to_contain_text("Not Opened")
        expect(viewer.locator("#kin-multi-study")).to_contain_text("Studies 3 · Page 1/2", timeout=30000)
        viewer.wait_for_function("() => typeof kinViewerWindowOwner==='function' && kinViewerWindowOwner() && "
                                 "typeof kinViewerJobWorkspaceState==='function' && !kinViewerJobWorkspaceState().busy "
                                 "&& typeof kinViewerFrameCoverageState==='function' && !kinViewerFrameCoverageState().warn")

        # Next: the odd last member alone, the same frozen N resolved with the admitted key.
        with page.expect_response(lambda r: r.url.endswith(RESOLVE)) as reply:
            page.locator("#multi-study-next").click()
        body, _ = self.assert_ready_response(reply.value, order)
        bodies.append(body)
        viewer.wait_for_url("**StudyInstanceUIDs=" + order[2] + "**", timeout=30000)
        self.assertEqual(self.ids(viewer), [order[2]])
        self.assertIsNone(parse_qs(urlsplit(viewer.url).query).get("hangingProtocolId"))
        self.assertEqual([b["studyUids"] for b in bodies], [order, order])
        self.assertEqual(bodies[1]["expectedSourcePatientKey"], first["sourcePatientKey"])
        prior.canvas_ready(viewer, 1)
        expect(self.member(page, order[2])).to_contain_text("Displayed", timeout=60000)
        expect(page.locator("#multi-study-summary")).to_have_text("Studies 3 · Page 2/2 · Pages")
        viewer.wait_for_function("() => !kinViewerHistoryWorkspaceState().busy && !kinViewerJobWorkspaceState().busy")
        pending = []
        def hold_patient(route):
            requested = parse_qs(urlsplit(route.request.url).query).get('uids', [''])[0].split(',')
            if requested == order[:2]: pending.append(route)
            else: route.continue_()
        viewer.route('**/api/studies?**', hold_patient)
        before_url = viewer.url
        with page.expect_response(lambda r: r.url.endswith(RESOLVE)):
            page.locator('#multi-study-prev').click()
        deadline = time.monotonic() + 30
        while not pending and time.monotonic() < deadline: page.wait_for_timeout(50)
        self.assertEqual(len(pending), 1, 'patient lookup reached the held boundary')
        expect(page.locator('#multi-study-next')).to_be_disabled()
        held_request = pending.pop()
        with viewer.expect_event('requestfailed', predicate=lambda r: r == held_request.request):
            page.locator('#multi-study-close').click()
            held_request.continue_()
        viewer.unroute('**/api/studies?**', hold_patient)
        expect(page.locator('#multi-study')).to_be_hidden()
        self.assertEqual(viewer.url, before_url)
        self.assertIsNone(page.evaluate("selectedUid"))
        self.assertEqual(clinical, self.clinical(fixtures))
        self.assertEqual(originals, self.originals())


    def test_w9_02_review_fixes_on_the_served_stack(self):
        """Review regression: real page, OHIF, images, measurement/save and lifecycle; only W9 resolve is synthetic."""
        patient = 'W9FIX-' + uuid.uuid4().hex[:12]
        fixtures = [prior.synthetic_ct(self.stack, patient, 'w9fix'+str(i), date, slices=2)
                    for i, date in enumerate(('20260805','20260804','20260803','20260802','20260801'))]
        originals, clinical = self.originals(), self.clinical(fixtures)
        page = self.login(); page.set_viewport_size({'width':1366,'height':768})
        page.locator('#quick').fill(patient)
        for f in fixtures: expect(page.locator(f'#rows tr[data-uid="{f.uid}"]')).to_be_visible()
        order = page.locator('#rows tr[data-uid]').evaluate_all('(rows) => rows.map(r=>r.dataset.uid)')
        self.assertEqual(sorted(order), sorted(f.uid for f in fixtures))
        page.locator(f'#rows tr[data-uid="{order[0]}"]').click()
        errors, correction, bodies, held = {}, {}, [], []
        def resolve(route):
            body = route.request.post_data_json; bodies.append(body)
            reply = ready_answer(body,patient)
            for m in reply['members']:
                if m['uid'] in errors:
                    m.update(status='error',code=errors[m['uid']]);m.pop('metadata');m.pop('accessRef')
                else: m['metadata'].update(correction.get(m['uid'],{}))
            count = sum(m['status']=='ready' for m in reply['members'])
            reply['scopeStatus'] = 'ready' if count==len(reply['members']) else 'partial' if count else 'rejected'
            route.fulfill(json=reply)
        page.route('**'+RESOLVE,resolve)
        module = '**/worklist/hpacs-lite/viewer-multi-study.js'
        page.context.route(module, lambda route: held.append((route,time.monotonic())))
        def open_set(uids):
            in_workspace = page.locator('body').evaluate("e => e.classList.contains('reading')")
            if in_workspace and not page.locator('body').evaluate("e => e.classList.contains('reading-list-open')"):
                page.locator('#reading-bar').get_by_role('button',name='Worklist',exact=True).click()
            clear = page.locator('#multi-selection-clear')
            if clear.is_enabled(): clear.click()
            for uid in uids: page.locator(f'#rows tr[data-uid="{uid}"]').click(modifiers=['Control'])
            with page.expect_response(lambda r:r.url.endswith(RESOLVE)):
                page.locator('#multi-selection-open-set').click()
            if in_workspace and page.locator('body').evaluate("e => e.classList.contains('reading-list-open')"):
                page.locator('#reading-bar').get_by_role('button',name='Worklist',exact=True).click()
        with page.context.expect_page() as opened: open_set(order)
        viewer = opened.value
        prior.canvas_ready(viewer,2)
        deadline = time.monotonic()+30
        while not held and time.monotonic()<deadline: page.wait_for_timeout(50)
        self.assertEqual(len(held),1)
        # Let the shipped loader's actual 20s timeout elapse; no product timer or constructor is replaced.
        page.wait_for_timeout(max(0, (held[0][1]+21-time.monotonic())*1000))
        expect(viewer.locator('#kin-multi-study')).to_have_count(0)
        held.pop()[0].continue_(); page.context.unroute(module)
        expect(viewer.locator('#kin-multi-study')).to_contain_text('Studies 5 · Page 1/3',timeout=30000)
        for uid in order[:2]: expect(self.member(page,uid)).to_contain_text('Displayed',timeout=60000)
        def ready_window():
            viewer.wait_for_function("() => typeof kinViewerHistoryWorkspaceState==='function' && !kinViewerHistoryWorkspaceState().busy && "
                                     "typeof kinViewerJobWorkspaceState==='function' && !kinViewerJobWorkspaceState().busy && "
                                     "typeof kinViewerFrameCoverageState==='function' && !kinViewerFrameCoverageState().warn")
        ready_window()
        facts = page.evaluate("""() => {
          const visible = e => {const r=e.getBoundingClientRect();let top=r.top,bottom=r.bottom;
            for(let a=e.parentElement;a;a=a.parentElement){const s=getComputedStyle(a),b=a.getBoundingClientRect();
              if(['hidden','auto','scroll','clip'].includes(s.overflowY)){top=Math.max(top,b.top);bottom=Math.min(bottom,b.bottom)}}
            return {height:r.height,visible:Math.max(0,Math.min(innerHeight,bottom)-Math.max(0,top))};};
          return {row:visible(document.querySelector('#relrows tr')),header:visible(document.querySelector('.reltabs')),
            report:visible(document.querySelector('.redit')),findings:visible(document.querySelector('#findings'))};} """)
        self.assertGreaterEqual(facts['row']['visible'],facts['row']['height'])
        self.assertEqual(facts['header']['visible'],facts['header']['height'])
        self.assertGreaterEqual(facts['report']['visible'],facts['findings']['height'])
        print('W9_REVIEW_LAYOUT',json.dumps(facts),flush=True)
        evidence=Path(os.environ.get('KIN_EVIDENCE_DIR','tmp/w9-review'));evidence.mkdir(parents=True,exist_ok=True)
        page.screenshot(path=str(evidence/'w9-open-1366.png'),full_page=True)
        # Real unsaved manual length: the existing viewer guard refuses both Next and a new overlapping selection.
        history.ViewerHistoryE2E.open_measurement_tools(self,viewer)
        select_image_tool(viewer, 'Length')
        # The U2 shell changes the image's letterboxing. Place both handles in the
        # actual image, as the manual-measurement suites do, rather than in its canvas margin.
        start, end = viewer.evaluate('''() => {
          const v=cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails')
            .flatMap(e=>e.getViewports()).find(v=>v.getCurrentImageId?.() && v.element.getBoundingClientRect().width>0);
          const d=v.getImageData(),r=v.element.getBoundingClientRect();
          const point=([x,y])=>v.worldToCanvas(d.imageData.indexToWorld([x*(d.dimensions[0]-1),y*(d.dimensions[1]-1),0]))
            .map((n,i)=>n+(i?r.y:r.x));
          return [[.4,.4],[.6,.6]].map(point);
        }''')
        viewer.mouse.move(*start);viewer.mouse.down();viewer.mouse.move(*end,steps=10);viewer.mouse.up()
        viewer.wait_for_function('''() => cornerstoneTools.annotation.state.getAllAnnotations().some(a=>
          a.metadata.toolName==='Length' && !a.invalidated && Object.values(a.data.cachedStats||{}).some(s=>Number.isFinite(s.length)))''')
        viewer.wait_for_function('() => kinViewerHistoryWorkspaceState().dirty')
        with page.expect_response(lambda r:r.url.endswith(RESOLVE)): page.locator('#multi-study-next').click()
        expect(page.locator('#multi-study-status')).to_contain_text('Not Opened')
        expect(page.locator('#multi-study-summary')).to_contain_text('Page 1/3')
        self.assertEqual(self.ids(viewer),order[:2])
        open_set([order[1],order[4]])
        expect(page.locator('#multi-study-status')).to_contain_text('Not Opened')
        expect(self.member(page,order[1])).to_contain_text('Displayed')
        expect(self.member(page,order[1])).not_to_contain_text('Not Opened')
        expect(self.member(page,order[1]).get_by_role('button',name='Retry',exact=True)).to_have_count(0)
        measurement = viewer.locator('#kin-viewer-history section[data-kind=length]')
        with viewer.expect_response(lambda r: r.request.method == 'POST' and r.url.endswith('/viewer-items')) as saved:
            measurement.get_by_role('button',name='Save',exact=True).click()
        self.assertTrue(saved.value.ok, saved.value.text())
        expect(measurement).to_contain_text('Saved r1')
        viewer.wait_for_function('() => !kinViewerHistoryWorkspaceState().dirty && !kinViewerHistoryWorkspaceState().busy')
        errors[order[2]]='W9_LOAD_FAILED'
        with page.expect_response(lambda r:r.url.endswith(RESOLVE)): page.locator('#multi-study-next').click()
        viewer.wait_for_url('**StudyInstanceUIDs='+order[3]+'**')
        expect(page.locator('#multi-study-summary')).to_contain_text('Page 2/3')
        expect(self.member(page,order[3])).to_contain_text('Displayed',timeout=60000)
        errors.clear();errors[order[4]]='W9_SCOPE_EXCLUDED'
        open_set([order[0],order[4]])
        expect(page.locator('#multi-study-candidate')).to_contain_text('Access Restricted')
        expect(self.member(page,order[2])).to_contain_text('Load Failed')
        # F4 = 1: Retry replaces the document in the existing window; its partner can be opened again.
        errors.clear()
        with page.expect_response(lambda r:r.url.endswith(RESOLVE)):
            self.member(page,order[2]).get_by_role('button',name='Retry',exact=True).click()
        viewer.wait_for_url('**StudyInstanceUIDs='+order[2]+'**')
        self.assertEqual(self.ids(viewer), [order[2]])
        expect(self.member(page,order[3])).to_contain_text('Not Opened')
        expect(self.member(page,order[3]).get_by_role('button',name='View Study',exact=True)).to_be_enabled()
        self.assertEqual(bodies[-1]['studyUids'],order)
        expect(self.member(page,order[2])).to_contain_text('Displayed',timeout=60000)
        viewer.close()
        with page.context.expect_page() as reopened, page.expect_response(lambda r:r.url.endswith(RESOLVE)):
            self.member(page,order[1]).get_by_role('button',name='Select for Reporting',exact=True).click()
        viewer=reopened.value;viewer.wait_for_url('**StudyInstanceUIDs='+order[1]+'**')
        expect(self.member(page,order[1])).to_contain_text('Displayed',timeout=60000)
        self.assertEqual(page.evaluate('selectedUid'),order[1])
        viewer.close()
        page.locator('#toolbar-view > summary').click();page.locator('#image-opening-open').click()
        page.locator('#image-opening-target').select_option('workspace');page.locator('#image-opening-done').click()
        correction[order[1]]={'patientName':'SYN CORRECTED PATIENT','description':'SYN CORRECTED SOURCE DESCRIPTION'}
        open_set(order)
        expect(page.locator('#reading-images')).to_contain_text('SYN CORRECTED PATIENT')
        expect(page.locator('#reading-images')).to_contain_text('SYN CORRECTED SOURCE DESCRIPTION')
        expect(page.locator('#reading-target')).not_to_contain_text('SYN CORRECTED PATIENT')
        expect(self.member(page,order[1])).to_contain_text('Displayed',timeout=60000)
        page.screenshot(path=str(evidence/'w9-corrected-workspace.png'),full_page=True)
        self.assertEqual(clinical,self.clinical(fixtures))
        self.assertEqual(originals,self.originals())

if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], *sys.argv[1:]])
