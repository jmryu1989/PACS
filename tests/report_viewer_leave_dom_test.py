# coding: utf-8
"""A3 unit 10 (cards C-R01-139 step 21, C-R01-122 step 15): the viewer window's report pieces.

1. Leaving a viewer patient tab whose study holds report text the reading screen has not had confirmed by the server
   goes through the reading screen's study-move gate: the switch happens only once that text is saved; otherwise the
   viewer stays and says so with Retry, Check and Stay. The reading screen is the real split page (the harness of
   tests/auth_logout_dom_test.py, read-only); the viewer is the shipped viewer-patient-tabs.js in a same-origin
   /ohif/viewer document with the native OHIF services standing in (named below).
2. The viewer's Previous Report has a History that lists every version of the report from the same read, and Close
   History shows the report again. The shipped controller and panel run against a stub /api read.

Stand-ins, named: the OHIF viewport/grid services the tabs read (no images are shown), the viewer's patient lookup
(/api/studies?uids=), the viewer adapter the Previous Report controller reads (viewport identity and patient snapshot),
the session transport's refusal check, and the server's report version list.
"""
import unittest
from pathlib import Path

import auth_logout_dom_test as h
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FILES = ROOT / "worklist-v0/hpacs-lite"
PATIENT_ID = {h.UID: "SYN-P-001", h.UID_B: "SYN-P-002"}
NAME = {h.UID: h.PATIENT, h.UID_B: h.PATIENT_B}
VIEWER = """<!doctype html><title>SYN viewer</title>
<div id="root"><div><div class="bg-secondary-dark z-20"><span id="kin-viewer-brand">SYN</span></div></div></div>
<script src="/syn-viewer/viewer-patient-tabs.js"></script>
<script>
  window.kinViewerFrameCoverageConfirm = () => true;
  const services = {
    viewportGridService: { getState: () => ({ layout: { layoutType: 'stand-in' }, viewports: new Map() }) },
    cornerstoneViewportService: { EVENTS: { VIEWPORT_DATA_CHANGED: 'data' }, subscribe: () => ({ unsubscribe() {} }) },
    displaySetService: {} };
  window.synMounted = KinViewerPatientTabs.mount({ services, session: { state: () => 'active', readOnly: () => false },
    refreshChrome() {} });
</script>"""


def tab_name(uid):
    return " | ".join([NAME[uid], PATIENT_ID[uid], "46Y", "M"])


class ViewerTabLeave(h.LogoutDOMTest):
    def fresh_context(self, site=True):
        super().fresh_context(site)
        self.context.route("**/ohif/viewer*", lambda route: route.fulfill(body=VIEWER, content_type="text/html; charset=utf-8"))
        self.context.route("**/syn-viewer/*.js", lambda route: route.fulfill(
            body=(FILES / route.request.url.rsplit("/", 1)[-1]).read_bytes(), content_type="text/javascript; charset=utf-8"))
        self.context.route("**/api/studies?uids=*", self.lookup)

    @staticmethod
    def lookup(route):
        uids = route.request.url.split("uids=", 1)[1].split("&")[0].replace("%2C", ",").split(",")
        route.fulfill(json={"studies": [{"uid": uid, "sourcePatientKey": h.INSTITUTION + "|" + PATIENT_ID[uid],
                                         "name": NAME[uid], "id": PATIENT_ID[uid], "birth": "19800101",
                                         "date": "20261003", "sex": "M"} for uid in uids if uid in NAME]})

    def open_viewer(self):
        """The viewer shows study B, then the reading screen's study A (the tab whose text is typed)."""
        viewer = self.watch(self.context.new_page())
        viewer.goto(h.ORIGIN + "/ohif/viewer?StudyInstanceUIDs=" + h.UID_B)
        expect(viewer.get_by_role("tab", name=tab_name(h.UID_B))).to_have_attribute("aria-selected", "true")
        self.assertTrue(viewer.evaluate("href => kinViewerOpenPatient(href)", "/ohif/viewer?StudyInstanceUIDs=" + h.UID))
        expect(self.tab(viewer, h.UID)).to_have_attribute("aria-selected", "true")
        return viewer

    @staticmethod
    def tab(viewer, uid):
        return viewer.get_by_role("tab", name=tab_name(uid))

    def refused_text(self):
        self.open_main()
        viewer = self.open_viewer()
        # Without unconfirmed text the tabs switch at once, as before.
        self.tab(viewer, h.UID_B).click()
        expect(self.tab(viewer, h.UID_B)).to_have_attribute("aria-selected", "true")
        expect(viewer.get_by_role("alert")).to_be_hidden()
        self.tab(viewer, h.UID).click()
        expect(self.tab(viewer, h.UID)).to_have_attribute("aria-selected", "true")
        self.select_and_type()
        self.site.put_answers = [(503, {"code": "SYN_DOWN", "message": "SYN server down"})] * 6
        self.tab(viewer, h.UID_B).click()
        alert = viewer.get_by_role("alert")
        expect(alert).to_contain_text("Save Not Confirmed")
        expect(alert).to_contain_text(h.PATIENT)
        for name in ("Retry", "Check", "Stay"):
            expect(alert.get_by_role("button", name=name, exact=True)).to_be_enabled()
        expect(self.tab(viewer, h.UID)).to_have_attribute("aria-selected", "true")
        self.assertIsNone(self.site.stored())
        return viewer, alert

    def test_without_a_reading_screen_tabs_switch_at_once(self):
        viewer = self.open_viewer()
        self.tab(viewer, h.UID_B).click()
        expect(self.tab(viewer, h.UID_B)).to_have_attribute("aria-selected", "true")
        expect(viewer.get_by_role("alert")).to_be_hidden()

    def test_stay_keeps_the_patient_and_text_then_a_confirmed_save_switches(self):
        viewer, alert = self.refused_text()
        alert.get_by_role("button", name="Stay", exact=True).click()
        expect(alert).to_be_hidden()
        expect(self.tab(viewer, h.UID)).to_have_attribute("aria-selected", "true")
        expect(self.page.locator("#findings")).to_have_value(h.FIELDS["findings"])
        # The connection is back: the next switch saves the text through the reading screen's gate and then moves.
        self.site.put_answers = []
        self.tab(viewer, h.UID_B).click()
        expect(self.tab(viewer, h.UID_B)).to_have_attribute("aria-selected", "true")
        expect(alert).to_be_hidden()
        self.assertEqual(h.FIELDS, self.site.stored())

    def test_retry_saves_and_moves(self):
        viewer, alert = self.refused_text()
        self.site.put_answers = []
        alert.get_by_role("button", name="Retry", exact=True).click()
        expect(self.tab(viewer, h.UID_B)).to_have_attribute("aria-selected", "true")
        expect(alert).to_be_hidden()
        self.assertEqual(h.FIELDS, self.site.stored())

    def test_check_reads_without_saving_and_moves_once_confirmed(self):
        viewer, alert = self.refused_text()
        puts = len(self.site.puts)
        alert.get_by_role("button", name="Check", exact=True).click()
        expect(alert).to_contain_text("아직 저장이 확인되지 않았습니다")
        expect(self.tab(viewer, h.UID)).to_have_attribute("aria-selected", "true")
        self.assertEqual(puts, len(self.site.puts), "Check sends no write")
        # The reading screen's own save confirms the text (setup through its draft path); Check then moves.
        self.site.put_answers = []
        self.page.evaluate("() => stashReport()")
        self.wait_until(lambda: self.site.stored() == h.FIELDS, "the reading screen's own save")
        alert.get_by_role("button", name="Check", exact=True).click()
        expect(self.tab(viewer, h.UID_B)).to_have_attribute("aria-selected", "true")
        expect(alert).to_be_hidden()


PRIOR = """<!doctype html><title>SYN prior</title><div id="report"></div>
<script>window.KinSessionTransport = { refusal: () => false, responseError: () => new Error('ended') };</script>
<script src="/syn-viewer/viewer-prior-controller.js"></script>
<script src="/syn-viewer/viewer-prior-panel.js"></script>
<script>
  const origin = { patientKey: 'SYN|P', sequence: 1, viewportId: 'v1', studyUid: 'SYN.CUR', seriesUid: 'SYN.S', mode: 'stack' };
  const viewer = { viewport: () => ({ ...origin }), snapshot: () => ({ key: 'SYN|P', sequence: 1, studyUIDs: ['SYN.CUR'] }),
    subscribe: () => () => {} };
  const host = document.getElementById('report');
  window.synController = KinViewerPriorController.create({ viewer, loadStudy: async () => [], onList() {},
    onReport: value => KinViewerPriorPanel.report(host, value, { retry() {}, close() {} }) });
</script>"""
STUDIES = {"studies": [{"uid": "SYN.CUR", "sourcePatientKey": "SYN|P", "date": "20261110", "modality": "CT",
                        "desc": "SYN CT CHEST", "name": "SYN PARK", "id": "SYN-P"}]}
VERSIONS = [{"version": 1, "action": "approve", "author": "syn-rad@synthetic.test", "at": "2026-11-10T08:12:00.000Z",
             "findings": "8 mm nodule in the right upper lobe.", "conclusion": "SYN follow-up CT in 3 months.",
             "recommendation": ""}]


class ViewerPriorHistory(unittest.TestCase):
    def test_history_lists_versions_and_close_history_shows_the_report_again(self):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.route("**/*", self.serve)
            page.goto("https://syn.test/syn-prior")
            page.evaluate("() => synController.open(origin)")
            page.evaluate("() => synController.openReport('SYN.CUR')")
            region = page.get_by_role("region", name="Previous Report")
            expect(region).to_contain_text("8 mm nodule in the right upper lobe.")
            history = region.get_by_role("button", name="History", exact=True)
            expect(history).to_have_attribute("aria-expanded", "false")
            history.click()
            listed = region.get_by_role("region", name="History")
            expect(listed).to_be_visible()
            expect(history).to_have_attribute("aria-expanded", "true")
            expect(listed.get_by_role("article")).to_have_count(1)
            expect(listed.get_by_role("article")).to_contain_text("v1 | Approve | syn-rad@synthetic.test | 2026-11-10 08:12:00")
            expect(listed).to_contain_text("8 mm nodule in the right upper lobe.")
            expect(region.get_by_text("Version 1 | Approved", exact=False)).to_be_hidden()
            expect(listed.get_by_role("button", name="Close History", exact=True)).to_be_focused()
            listed.get_by_role("button", name="Close History", exact=True).click()
            expect(listed).to_be_hidden()
            expect(region.get_by_text("Version 1 | Approved", exact=False)).to_be_visible()
            expect(history).to_be_focused()
            self.assertEqual([], errors)
            browser.close()

    @staticmethod
    def serve(route):
        path = route.request.url.split("syn.test", 1)[1]
        if path == "/syn-prior":
            return route.fulfill(body=PRIOR, content_type="text/html; charset=utf-8")
        if path.startswith("/syn-viewer/"):
            return route.fulfill(body=(FILES / path.rsplit("/", 1)[-1]).read_bytes(), content_type="text/javascript")
        if path == "/api/studies":
            return route.fulfill(json=STUDIES)
        if path == "/api/studies/SYN.CUR/report/versions":
            return route.fulfill(json=VERSIONS)
        return route.fulfill(status=404, body="")


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite(ViewerTabLeave(name) for name in ViewerTabLeave.__dict__ if name.startswith("test_"))
    suite.addTests(loader.loadTestsFromTestCase(ViewerPriorHistory))
    return suite


if __name__ == "__main__":
    unittest.main(verbosity=2)
