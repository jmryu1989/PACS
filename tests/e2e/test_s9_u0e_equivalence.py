# coding: utf-8
"""REQ-S9-U0e-INJECTION -> RISK-STALE-SERVED-CONFIG -> TEST-S9-U0E-SERVED.

Normal worklist launch, real Orthanc-injected config and pinned OHIF assets.
Byte equality is the extraction/served-artifact contract (AGENTS 1-B.14).
This fills the injection/launch trace gap; it does not replace the existing
layout, tools, cine, measurement/job, reopen, prior or clinician flow suites.
Run only through run-tests.py against an independently isolated synthetic stack.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import unittest
from urllib.parse import parse_qs, urlsplit

from test_reading_workspace import ReadingWorkspaceE2E
from test_prior_selection import canvas_ready

ROOT = Path(__file__).resolve().parents[2]


class OHIFSourceEquivalenceE2E(ReadingWorkspaceE2E):
    def test_s9_u0e_served_config_and_normal_launch(self):
        current, prior = self.pair()
        originals = self.originals()
        reports = {f.uid: self.report_rows(f) for f in (current, prior)}
        work = self.login()
        self.choose(work, current)
        responses = []

        # Playwright tags the handler object, so it must be a Python function, not a bound builtin.
        def record(response):
            responses.append(response)
        work.context.on("response", record)
        self.addCleanup(lambda: work.context.remove_listener("response", record))
        with work.context.expect_page() as opened:
            work.locator("#m-filmbox").click()
        viewer = opened.value
        viewer.wait_for_url("**/ohif/viewer?**")
        canvas_ready(viewer, 2)
        self.assertEqual(parse_qs(urlsplit(viewer.url).query)["StudyInstanceUIDs"],
                         [current.uid + "," + prior.uid])

        configs = [r for r in responses if urlsplit(r.url).path == "/ohif/app-config.js"]
        self.assertTrue(configs, "Normal viewer launch did not fetch Orthanc's injected configuration")
        expected = (ROOT / "config/ohif.js").read_bytes()
        # Orthanc appends its plugin configuration to the supplied UserConfiguration.
        # Match the whole artifact as a contiguous byte range, without normalizing it.
        for response in configs:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.body().count(expected), 1,
                             "The served app-config does not contain the exact generated artifact once")
        scripts = [r for r in responses if r.request.resource_type == "script"
                   and urlsplit(r.url).path.startswith("/ohif/")]
        self.assertTrue(any(urlsplit(r.url).path != "/ohif/app-config.js" for r in scripts),
                        "No OHIF runtime script was fetched")
        self.assertTrue(all(r.ok for r in scripts), "An OHIF launch script failed")
        images = viewer.evaluate("""() => [...services.viewportGridService.getState().viewports.values()]
          .map(cell => services.cornerstoneViewportService.getCornerstoneViewport(cell.viewportId)
            ?.getCurrentImageId?.()).filter(Boolean)""")
        metadata = {f.uid: self.metadata(work, f) for f in (current, prior)}
        visible = set()
        for image in images:
            match = re.search(r"/studies/([0-9.]+)/series/([0-9.]+)/instances/([0-9.]+)/frames/([1-9][0-9]*)(?:$|[?#])", image)
            self.assertIsNotNone(match, "Displayed image has no complete DICOM identity")
            study, series, sop, frame = match.groups()
            self.assertIn(study, metadata)
            self.assertTrue(any(item["0020000E"]["Value"][0] == series
                                and item["00080018"]["Value"][0] == sop for item in metadata[study]))
            self.assertEqual(int(frame), 1)  # synthetic_ct stores single-frame CT instances
            visible.add(study)
        self.assertEqual(visible, {current.uid, prior.uid})
        self.assertEqual(self.originals(), originals)
        self.assertEqual({f.uid: self.report_rows(f) for f in (current, prior)}, reports)

        folder = Path(os.environ.get("KIN_EVIDENCE_DIR", str(ROOT / "tmp/s9-u0e/served")))
        folder.mkdir(parents=True, exist_ok=True)
        viewer.screenshot(path=str(folder / "normal-launch.png"))
        (folder / "served-app-config.js").write_bytes(configs[0].body())
        trace = [{"url": r.url, "status": r.status, "sha256": hashlib.sha256(r.body()).hexdigest()}
                 for r in scripts]
        (folder / "launch-trace.json").write_text(json.dumps({
            "generated_sha256": hashlib.sha256(expected).hexdigest(),
            "scripts": trace, "displayed_image_ids": images,
        }, indent=2) + "\n", encoding="utf-8")


def load_tests(loader, tests, pattern):
    return unittest.TestSuite([OHIFSourceEquivalenceE2E("test_s9_u0e_served_config_and_normal_launch")])


if __name__ == "__main__":
    unittest.main(verbosity=2)
