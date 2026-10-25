# coding: utf-8
"""W9UI-V V-LIVE (order 01-multi-study-view.md, Q02/Q10) -> RISK V-RESOLVE / V-DISPLAY -> TEST W9-UI live page.

Real BFF, API, database, Orthanc, OHIF and three synthetic CT studies of one patient (synthetic_ct, owned and cleaned by
the stack's guard). Two parts, recorded apart as the order's Q10 requires:

  UNBOUND (real server, real page): Open Selected Studies on the delivered worklist page reaches the real
  POST /api/studies/viewing-set/resolve. This build binds ViewingSetAccess to ViewingSetAccessUnbound (app.module.ts), so
  any set with a ready member is refused 503 W9_AUDIT_UNAVAILABLE before a member body exists. The page shows Load Failed
  with the record message, closes only the blank window its own click reserved, navigates no viewer and writes nothing.

  SYNTHETIC RESOLVE (real page, real viewer): the same page, with only that one route answered at the browser's HTTP
  boundary in the W9-API wire shape (all three members ready). This is NOT live success (T13 needs the Module A binding;
  NOT_RUN). What it shows on the real stack: the frozen set opens [1, 2] in the real OHIF window, the real renderer's
  first original frame of each member reaches the page over the opening's channel (viewer-multi-study.js on the real
  config/ohif.js) and only then is that member Displayed; Next opens the odd last member alone (no comparison study) and
  it is Displayed the same way; the viewer's strip shows the composition; no clinical row changes and every original
  instance is byte-identical (originals()).
"""
from __future__ import annotations

import sys
import unittest
import uuid
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect

import test_worklist as base
import test_prior_selection as prior

RESOLVE = "/api/studies/viewing-set/resolve"
AUDIT = "열람 기록을 저장하지 못했습니다. 잠시 후 Retry로 다시 시도하세요."
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
    originals = prior.PriorSelectionE2E.originals

    def ids(self, page):
        return parse_qs(urlsplit(page.url).query)["StudyInstanceUIDs"][0].split(",")

    def member(self, page, uid):
        return page.locator(f'#multi-study-members li[data-uid="{uid}"]')

    def clinical(self, fixtures):
        return {f.uid: {k: self.state(f).get(k) for k in CLINICAL} for f in fixtures}

    def test_w9_01_unbound_refusal_then_synthetic_ready_set_displays_on_the_real_viewer(self):
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

        # UNBOUND: the real server refuses before any member body; the page opens nothing and keeps nothing open.
        with page.context.expect_page() as reserved, page.expect_response(lambda r: r.url.endswith(RESOLVE)) as reply:
            page.locator("#multi-selection-open-set").click()
        blank = reserved.value
        self.assertEqual(reply.value.status, 503)
        self.assertEqual(reply.value.json()["code"], "W9_AUDIT_UNAVAILABLE")
        self.assertEqual(reply.value.request.post_data_json["studyUids"], order)
        expect(page.locator("#multi-study-status")).to_contain_text("Load Failed")
        expect(page.locator("#multi-study-status")).to_contain_text(AUDIT)
        if not blank.is_closed():
            blank.wait_for_event("close", timeout=10000)
        self.assertTrue(blank.is_closed(), "the reserved blank window stayed open")
        self.assertIsNone(page.evaluate("selectedUid"))
        self.assertEqual(clinical, self.clinical(fixtures))

        # SYNTHETIC RESOLVE at the live HTTP boundary; the viewer, its images and its renderer are the real ones.
        bodies = []

        def synthetic(route):
            bodies.append(route.request.post_data_json)
            route.fulfill(json=ready_answer(bodies[-1], patient))
        page.route("**" + RESOLVE, synthetic)
        with page.context.expect_page() as opened:
            page.locator("#multi-study-retry").click()
        viewer = opened.value
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
        page.locator("#multi-study-next").click()
        viewer.wait_for_url("**StudyInstanceUIDs=" + order[2] + "**", timeout=30000)
        self.assertEqual(self.ids(viewer), [order[2]])
        self.assertIsNone(parse_qs(urlsplit(viewer.url).query).get("hangingProtocolId"))
        self.assertEqual([b["studyUids"] for b in bodies], [order, order])
        self.assertEqual(bodies[1]["expectedSourcePatientKey"], "SYN|" + patient)
        prior.canvas_ready(viewer, 1)
        expect(self.member(page, order[2])).to_contain_text("Displayed", timeout=60000)
        expect(page.locator("#multi-study-summary")).to_have_text("Studies 3 · Page 2/2 · Pages")
        self.assertIsNone(page.evaluate("selectedUid"))
        self.assertEqual(clinical, self.clinical(fixtures))
        self.assertEqual(originals, self.originals())


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], *sys.argv[1:]])
