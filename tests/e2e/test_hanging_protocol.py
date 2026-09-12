# coding: utf-8
"""Pinned OHIF personal Hanging Protocol flow over owned synthetic CT fixtures."""
from __future__ import annotations

import json
import unittest
import uuid
from pathlib import Path

import numpy as np
from playwright.sync_api import expect

from test_viewer_layout import ViewerLayoutE2E
from test_prior_selection import canvas_ready
from workspace_roaming_support import cleanup_workspace


class HangingProtocolE2E(ViewerLayoutE2E):
    RULE_ID = "11111111-1111-4111-8111-111111111111"

    def setUp(self):
        super().setUp()
        self.addCleanup(cleanup_workspace, self.stack, "HangingProtocolPreference")

    def tearDown(self):
        result = self._outcome.result
        failures = result.failures + result.errors + [
            (test, error) for test, error in getattr(self._outcome, "errors", []) if error
        ]
        if any(test is self for test, _ in failures):
            folder = Path(__file__).parent / "artifacts"
            folder.mkdir(exist_ok=True)
            for i, context in enumerate(self.contexts):
                for j, page in enumerate(context.pages):
                    if "/ohif/viewer" in page.url:
                        try:
                            page.screenshot(path=str(folder / f"HP-failure-{self._testMethodName}-{i}-{j}.png"),
                                            full_page=True)
                        except Exception:
                            pass
        super().tearDown()

    def hp(self, page):
        self.open_layout_tools(page)
        expect(page.get_by_role("heading", name="Hanging Protocols", exact=True)).to_be_visible(timeout=45000)
        expect(page.locator("#kin-hp-new")).to_be_visible()

    def import_rules(self, page, value):
        self.hp(page)
        page.locator("#kin-hp-import").set_input_files({
            "name": "synthetic-hanging-protocols.json",
            "mimeType": "application/json",
            "buffer": json.dumps(value).encode("utf-8"),
        })
        expect(page.locator("#kin-hp-status")).to_contain_text("초안으로 가져왔습니다")

    def library(self, *, historical=True, occurrence=1, name="Synthetic Current Related"):
        return {
            "version": 1,
            "activeRuleId": self.RULE_ID,
            "rules": [{
                "id": self.RULE_ID,
                "name": name,
                "enabled": True,
                "match": {"modality": "CT", "retrieveAE": None, "bodyPart": None,
                          "description": {"operator": "contains", "value": "D03A"}},
                "selectors": [
                    {"alias": "Current", "role": "current", "historical": False, "modality": "CT",
                     "retrieveAE": None, "bodyPart": None, "description": None, "laterality": None,
                     "order": "ascending", "occurrence": occurrence},
                    {"alias": "Related", "role": "related", "historical": historical, "modality": "CT",
                     "retrieveAE": None, "bodyPart": None, "description": None, "laterality": None,
                     "order": "ascending", "occurrence": 1},
                ],
                "layout": {"rows": 2, "cols": 2, "cells": ["Current", "Related", None, "Current"]},
            }],
        }

    def mpr_library(self, name="Synthetic Three Plane"):
        """One eligible CT volume in three explicitly oriented cells plus a vacancy."""
        value = self.library(name=name)
        rule = value["rules"][0]
        rule["selectors"] = [rule["selectors"][0]]
        rule["layout"] = {"rows": 2, "cols": 2, "cells": [
            {"alias": "Current", "view": "mpr", "orientation": orientation}
            for orientation in ("axial", "sagittal", "coronal")] + [None]}
        stack = json.loads(json.dumps(rule))
        stack.update(id="55555555-5555-4555-8555-555555555555", name="Synthetic Stack Again")
        stack["layout"] = {"rows": 1, "cols": 1, "cells": ["Current"]}
        value["rules"].append(stack)
        return value

    def planes(self, page):
        return page.evaluate("""()=>[...services.viewportGridService.getState().viewports.values()]
          .sort((a,b)=>a.y-b.y||a.x-b.x).map(cell=>{
            const v=services.cornerstoneViewportService.getCornerstoneViewport(cell.viewportId);
            const sets=cell.displaySetInstanceUIDs||[];
            if(v?.type!=='orthographic')return {type:v?.type??null,sets};
            const volume=cornerstone.cache.getVolume(v.getVolumeId()),camera=v.getCamera();
            const first=cornerstone.metaData.get('instance',volume.imageIds[0]);
            const group=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(v.id,v.renderingEngineId);
            // The whole requested series, completely loaded: a plane that reported the right
            // type over a partial or foreign volume is not the cell the rule asked for.
            const sops=volume.imageIds.map(id=>cornerstone.metaData.get('instance',id).SOPInstanceUID);
            const source=services.displaySetService.getDisplaySetByUID(sets[0]);
            return {type:v.type,sets,volumeId:v.getVolumeId(),slices:volume.imageIds.length,
              study:first.StudyInstanceUID,series:first.SeriesInstanceUID,group:group?.id??null,
              loaded:!!volume.loadStatus?.loaded,framesLoaded:volume.framesLoaded,
              sops:[...sops].sort(),sourceSops:(source?.images||[]).map(i=>i.SOPInstanceUID).sort(),
              viewPlaneNormal:camera.viewPlaneNormal,focalPoint:camera.focalPoint};})""")

    def rendered_planes(self, page, count):
        page.wait_for_function("""count=>{
          const cells=[...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).slice(0,count);
          return cells.length===count&&cells.every(cell=>{
            const c=document.querySelector('[data-viewport-uid="'+cell.viewportId+'"] .cornerstone-canvas');
            if(!c?.width||!c.height)return false;
            const ctx=c.getContext('2d');if(!ctx)return false;
            const pixels=ctx.getImageData(0,0,c.width,c.height).data;let lo=255,hi=0;
            for(let n=0;n<pixels.length;n+=16){lo=Math.min(lo,pixels[n]);hi=Math.max(hi,pixels[n]);}
            return hi-lo>100;});}""", arg=count, timeout=60000)

    def navigation_library(self):
        second = self.library(occurrence=2)["rules"][0]
        first = json.loads(json.dumps(second))
        first["id"] = "22222222-2222-4222-8222-222222222222"
        first["name"] = "Synthetic Current First"
        first["selectors"] = [first["selectors"][0]]
        first["selectors"][0]["occurrence"] = 1
        first["layout"] = {"rows": 1, "cols": 1, "cells": ["Current"]}
        no_match = json.loads(json.dumps(first))
        no_match.update(id="33333333-3333-4333-8333-333333333333", name="Synthetic MR Skip")
        no_match["match"]["modality"] = "MR"
        disabled = json.loads(json.dumps(first))
        disabled.update(id="44444444-4444-4444-8444-444444444444",
                        name="Synthetic Disabled Skip", enabled=False)
        return {"version": 1, "activeRuleId": second["id"],
                "rules": [first, no_match, disabled, second]}

    def described_ref(self, page, fixture, description):
        metadata = self.metadata(page, fixture)
        series = next(item["0020000E"]["Value"][0] for item in metadata
                      if item.get("0008103E", {}).get("Value", [None])[0] == description)
        return next(ref for ref in self.fixture_refs(page, fixture) if ref["series"] == series)

    def apply(self, page, expected=None):
        self.hp(page)
        page.locator("#kin-hp-apply").click()
        if expected:
            expect(page.locator("#kin-hp-status")).to_contain_text(expected, timeout=45000)

    def test_hp_01_form_save_import_apply_preserves_exact_images_and_vacancy(self):
        patient = "HP-FORM-" + uuid.uuid4().hex[:12]
        related = self.ct(patient, "older", "20250701")
        current = self.multiple(patient, "current", "20260801")
        self.seed_report(current); originals = self.originals(); rows = self.report_rows(current)
        work = self.login(); self.select(work, current); work.locator("#findings").fill("HP FORM UNSAVED REPORT")
        viewer = self.launch(work.context.new_page(), [current, related]); self.hp(viewer)

        # Exercise the actual editor before importing the precise reusable definition.
        viewer.locator("#kin-hp-new").click()
        viewer.get_by_label("Name").fill("Form Draft")
        viewer.get_by_label("Name").dispatch_event("change")
        viewer.get_by_label("Alias (ASCII letter, then letters/numbers/_/-)").fill("Current_Main")
        viewer.get_by_label("Alias (ASCII letter, then letters/numbers/_/-)").dispatch_event("change")
        viewer.get_by_label("Grid").select_option("2x2")
        viewer.get_by_role("button", name="Add Selector", exact=True).click()
        expect(viewer.locator("#kin-hp-save-local")).to_be_enabled(); viewer.locator("#kin-hp-save-local").click()
        expect(viewer.locator("#kin-hp-status")).to_contain_text("이 브라우저")

        definition = self.navigation_library()
        self.import_rules(viewer, definition)
        before = self.cells(viewer)
        previous = viewer.locator("#kin-hp-previous")
        following = viewer.locator("#kin-hp-next")
        expect(previous).to_have_text("Previous Protocol")
        expect(following).to_have_text("Next Protocol")
        current_second = self.described_ref(viewer, current, "D02E second series")
        current_first = self.described_ref(viewer, current, "D03A current")
        related_first = self.described_ref(viewer, related, "D03A older")

        # With no successful cursor, Previous starts at the last eligible rule.
        previous.click(); expect(viewer.locator("#kin-hp-status")).to_contain_text("Applied", timeout=45000)
        self.identity(viewer, [current_second, related_first, None, current_second])
        viewer.screenshot(path=str(Path(__file__).parent / 'artifacts' / 'HP-current-related-vacancy.png'))
        applied = self.cells(viewer)
        self.assertEqual([], applied[2]["sets"])
        self.assertNotEqual(before, applied)

        # A manual layout change invalidates the cursor; Next therefore starts at the first rule.
        self.grid(viewer, 1)
        expect(viewer.locator("#kin-hp-applied")).to_have_text("Applied Protocol: None")
        following.click(); expect(viewer.locator("#kin-hp-status")).to_contain_text("Applied", timeout=45000)
        self.identity(viewer, [current_first])
        following.click(); expect(viewer.locator("#kin-hp-status")).to_contain_text("Applied", timeout=45000)
        self.identity(viewer, [current_second, related_first, None, current_second])
        endpoint = self.cells(viewer)
        following.click(); expect(viewer.locator("#kin-hp-status")).to_contain_text("저장 순서의 끝")
        self.assertEqual(endpoint, self.cells(viewer), "navigation must not wrap beyond the last matching rule")

        previous.click(); expect(viewer.locator("#kin-hp-status")).to_contain_text("Applied", timeout=45000)
        self.identity(viewer, [current_first])
        first_endpoint = self.cells(viewer)
        previous.click(); expect(viewer.locator("#kin-hp-status")).to_contain_text("저장 순서의 끝")
        self.assertEqual(first_endpoint, self.cells(viewer), "navigation must not wrap before the first matching rule")

        # Apply follows the editor selection (the second rule) and becomes the navigation cursor.
        self.apply(viewer, "Applied")
        self.identity(viewer, [current_second, related_first, None, current_second])
        previous.click(); expect(viewer.locator("#kin-hp-status")).to_contain_text("Applied", timeout=45000)
        self.identity(viewer, [current_first])
        following.click(); expect(viewer.locator("#kin-hp-status")).to_contain_text("Applied", timeout=45000)
        self.identity(viewer, [current_second, related_first, None, current_second])

        job_title = viewer.get_by_label("Job Title", exact=True)
        if not job_title.is_visible():
            viewer.get_by_role("button", name="Comparison", exact=True).click()
        expect(job_title).to_be_visible()
        job_title.fill("HP NAVIGATION UNSAVED JOB")
        dirty = self.cells(viewer); previous.click()
        expect(viewer.locator("#kin-hp-status")).to_contain_text("저장하지 않은 영상 작업")
        self.assertEqual(dirty, self.cells(viewer), "navigation must preserve dirty viewer work")
        expect(viewer.get_by_label("Job Title", exact=True)).to_have_value("HP NAVIGATION UNSAVED JOB")
        expect(work.locator("#findings")).to_have_value("HP FORM UNSAVED REPORT")
        self.assertEqual(rows, self.report_rows(current)); self.assertEqual(originals, self.originals())

    def test_hp_02_historical_rejects_future_then_explicit_related_applies(self):
        patient = "HP-HISTORY-" + uuid.uuid4().hex[:12]
        current = self.ct(patient, "current", "20260801")
        future = self.ct(patient, "future", "20260907")
        originals = self.originals(); viewer = self.launch(self.login(), [current, future])
        definition = self.library(historical=True, name="Strict Historical")
        self.import_rules(viewer, definition); before = self.cells(viewer); self.apply(viewer, "일치하는 규칙이 없어")
        self.assertEqual(before, self.cells(viewer))
        viewer.locator("#kin-hp-next").click()
        expect(viewer.locator("#kin-hp-status")).to_contain_text("현재 검사와 일치하는 규칙이 없습니다")
        self.assertEqual(before, self.cells(viewer))
        viewer.locator("#kin-hp-previous").click()
        expect(viewer.locator("#kin-hp-status")).to_contain_text("현재 검사와 일치하는 규칙이 없습니다")
        self.assertEqual(before, self.cells(viewer))

        related = viewer.locator('[data-selector="1"]')
        expect(related.get_by_label("Require strictly earlier study")).to_be_visible()
        related.get_by_label("Require strictly earlier study").uncheck()
        self.apply(viewer, "Applied")
        current_ref, future_ref = self.fixture_refs(viewer, current)[0], self.fixture_refs(viewer, future)[0]
        self.identity(viewer, [current_ref, future_ref, None, current_ref])
        expect(viewer.locator("#kin-hp-status")).to_contain_text("Current/Related")
        self.assertEqual(originals, self.originals())

    def test_hp_03_account_load_apply_reopen_has_no_autoapply_and_owner_isolated(self):
        patient = "HP-ACCOUNT-" + uuid.uuid4().hex[:12]
        related = self.ct(patient, "older", "20250701"); current = self.ct(patient, "current", "20260801")
        originals = self.originals(); source = self.launch(self.login(), [current, related]); self.import_rules(source, self.library())
        source.locator("#kin-hp-load-account").click(); expect(source.locator("#kin-hp-status")).to_contain_text("저장된 Hanging Protocol이 없습니다")
        source.locator("#kin-hp-save-account").click(); expect(source.locator("#kin-hp-status")).to_contain_text("계정에 규칙을 저장")

        target = self.launch(self.login(), [current, related]); self.hp(target); initial = self.cells(target)
        target.locator("#kin-hp-load-account").click(); expect(target.locator("#kin-hp-status")).to_contain_text("Apply를 눌러")
        self.assertEqual(initial, self.cells(target), "explicit account Load stores a draft but does not apply it")
        self.apply(target, "Applied")
        current_ref, related_ref = self.fixture_refs(target, current)[0], self.fixture_refs(target, related)[0]
        self.identity(target, [current_ref, related_ref, None, current_ref])
        target.reload(); canvas_ready(target, 1); self.hp(target)
        self.assertEqual(1, len(self.cells(target)), "saved local draft must not auto-apply on reopen")

        other = self.launch(self.login("doctor2"), [current, related]); self.hp(other)
        other.locator("#kin-hp-load-account").click(); expect(other.locator("#kin-hp-status")).to_contain_text("저장된 Hanging Protocol이 없습니다")
        self.assertEqual(1, len(self.cells(other))); self.assertEqual(originals, self.originals())

    def test_hp_04_delayed_access_discards_frame_camera_and_layout_stale_apply(self):
        patient = "HP-STALE-" + uuid.uuid4().hex[:12]
        related = self.ct(patient, "older", "20250701"); current = self.ct(patient, "current", "20260801")
        self.seed_report(current); originals = self.originals(); rows = self.report_rows(current)
        work = self.login(); self.select(work, current); work.locator("#findings").fill("HP STALE UNSAVED REPORT")
        viewer = self.launch(work.context.new_page(), [current, related]); self.import_rules(viewer, self.library())

        def delayed_change(change):
            pending = []
            viewer.route("**/api/studies", lambda route: pending.append(route))
            with viewer.expect_request(lambda request: request.url.split("?")[0].endswith("/api/studies")):
                viewer.locator("#kin-hp-apply").click()
            viewer.wait_for_timeout(100)
            expect(viewer.locator("#kin-hp-apply")).to_be_disabled(); self.assertEqual(1, len(pending))
            before = self.cells(viewer); change(); pending[0].fulfill(response=pending[0].fetch())
            expect(viewer.locator("#kin-hp-status")).to_contain_text("변경되어 적용하지 않았습니다")
            viewer.unroute("**/api/studies"); return before

        def frame():
            viewer.evaluate("""async()=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());
              await v.setImageIdIndex(Math.min(1,v.getImageIds().length-1));}""")
        frame_before = delayed_change(frame)
        self.assertNotEqual(frame_before[0]["image"], self.cells(viewer)[0]["image"],
                            "manual frame selection must survive the stale Apply")

        camera_before = viewer.evaluate("""()=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());
          const c=v.getCamera();v.setCamera({parallelScale:c.parallelScale*0.8});return c.parallelScale;}""")
        # First establish the manual camera change, then make another one while permission is held.
        delayed_change(lambda: viewer.evaluate("""()=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());
          const c=v.getCamera();v.setCamera({parallelScale:c.parallelScale*0.9});}"""))
        self.assertNotEqual(camera_before, viewer.evaluate("""()=>services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId()).getCamera().parallelScale"""))

        delayed_change(lambda: self.grid(viewer, 2))
        self.assertEqual(2, len(self.cells(viewer)))
        expect(work.locator("#findings")).to_have_value("HP STALE UNSAVED REPORT")
        self.assertEqual(rows, self.report_rows(current)); self.assertEqual(originals, self.originals())


    def test_hp_05_plane_cells_open_one_ct_volume_and_round_trip_through_the_account(self):
        patient = "HP-MPR-" + uuid.uuid4().hex[:12]
        current = self.ct(patient, "current", "20260801")
        self.seed_report(current); originals = self.originals(); rows = self.report_rows(current)
        work = self.login(); self.select(work, current); work.locator("#findings").fill("HP MPR UNSAVED REPORT")
        viewer = self.launch(work.context.new_page(), [current])
        self.import_rules(viewer, self.mpr_library())
        before = self.cells(viewer)
        self.apply(viewer, "Applied")
        self.rendered_planes(viewer, 3)
        cells = self.planes(viewer)
        self.assertEqual(4, len(cells), "three planes are three cells of the saved 2x2 grid")
        self.assertEqual([], cells[3]["sets"]); self.assertIsNone(cells[3].get("volumeId"))
        series = self.described_ref(viewer, current, "D03A current")["series"]
        for index, cell in enumerate(cells[:3]):
            self.assertEqual("orthographic", cell["type"])
            self.assertEqual(1, len(cell["sets"]))
            self.assertEqual(cells[0]["volumeId"], cell["volumeId"], "every plane shows one and the same volume")
            self.assertEqual(series, cell["series"]); self.assertEqual(current.uid, cell["study"])
            self.assertEqual("mpr", cell["group"], "planes join the established MPR tool group")
            self.assertTrue(cell["loaded"], "a cell is only applied over a fully loaded volume")
            self.assertEqual(cell["slices"], cell["framesLoaded"])
            self.assertEqual(cell["sourceSops"], cell["sops"], "the plane stands on exactly the requested series")
        self.assertEqual({tuple(cell["sets"]) for cell in cells[:3]}, {tuple(cells[0]["sets"])})
        normals = np.array([cell["viewPlaneNormal"] for cell in cells[:3]])
        np.testing.assert_allclose(np.abs(normals), [[0, 0, 1], [1, 0, 0], [0, 1, 0]], atol=1e-6)
        for a, b in [(0, 1), (0, 2), (1, 2)]:
            self.assertAlmostEqual(float(np.dot(normals[a], normals[b])), 0, delta=1e-6)
        viewer.screenshot(path=str(Path(__file__).parent / 'artifacts' / 'HP-three-plane-cells.png'))
        self.assertNotEqual(before, self.cells(viewer))

        # The same rule library round trips through the account, and an ordinary stack rule
        # still replaces the plane screen this rule built.
        viewer.locator("#kin-hp-load-account").click()
        expect(viewer.locator("#kin-hp-status")).to_contain_text("저장된 Hanging Protocol이 없습니다")
        viewer.locator("#kin-hp-save-account").click()
        expect(viewer.locator("#kin-hp-status")).to_contain_text("계정에 규칙을 저장")
        viewer.select_option("#kin-hp-rule", "55555555-5555-4555-8555-555555555555")
        self.apply(viewer, "Applied")
        stack = self.cells(viewer)
        self.assertEqual(1, len(stack)); self.assertEqual("stack", stack[0]["type"])
        self.identity(viewer, [self.described_ref(viewer, current, "D03A current")])

        target = self.launch(self.login(), [current]); self.hp(target)
        target.locator("#kin-hp-load-account").click()
        expect(target.locator("#kin-hp-status")).to_contain_text("Apply를 눌러")
        self.assertEqual(1, len(self.cells(target)), "an account load stores a draft and does not apply it")
        self.apply(target, "Applied")
        self.rendered_planes(target, 3)
        reloaded = self.planes(target)
        self.assertEqual([cell["type"] for cell in reloaded], ["orthographic"] * 3 + [None])
        np.testing.assert_allclose(np.abs([cell["viewPlaneNormal"] for cell in reloaded[:3]]),
                                   [[0, 0, 1], [1, 0, 0], [0, 1, 0]], atol=1e-6)
        self.assertEqual([cell["series"] for cell in reloaded[:3]], [series] * 3)
        expect(work.locator("#findings")).to_have_value("HP MPR UNSAVED REPORT")
        self.assertEqual(rows, self.report_rows(current)); self.assertEqual(originals, self.originals())


def load_tests(loader, tests, pattern):
    names = [name for name in HangingProtocolE2E.__dict__ if name.startswith("test_hp_")]
    return unittest.TestSuite(HangingProtocolE2E(name) for name in sorted(names))


if __name__ == "__main__":
    unittest.main(verbosity=2)
