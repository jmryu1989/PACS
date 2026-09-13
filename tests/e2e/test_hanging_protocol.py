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
from test_worklist import psql
from workspace_roaming_support import cleanup_workspace


class HangingProtocolE2E(ViewerLayoutE2E):
    RULE_ID = "11111111-1111-4111-8111-111111111111"
    SITE_RULE_ID = "66666666-6666-4666-8666-666666666666"

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

    def mixed_library(self, name="Synthetic Mixed Layout"):
        """What an HP rule may already place: two plane cells of one eligible CT volume
        beside an ordinary frame cell of another series, plus a vacancy."""
        value = self.library(name=name)
        rule = value["rules"][0]
        first = rule["selectors"][0]
        second = json.loads(json.dumps(first))
        second.update(alias="Second", occurrence=2)
        rule["selectors"] = [first, second]
        rule["layout"] = {"rows": 2, "cols": 2, "cells": [
            {"alias": "Current", "view": "mpr", "orientation": "axial"},
            "Second",
            {"alias": "Current", "view": "mpr", "orientation": "coronal"},
            None]}
        return value

    def frame_cell(self, page, index):
        """The original instance an ordinary stack cell is actually standing on."""
        return page.evaluate("""index=>{
          const cell=[...services.viewportGridService.getState().viewports.values()]
            .sort((a,b)=>a.y-b.y||a.x-b.x)[index];
          const v=services.cornerstoneViewportService.getCornerstoneViewport(cell.viewportId);
          const m=cornerstone.metaData.get('instance',v.getCurrentImageId());
          return {type:v.type,study:m.StudyInstanceUID,series:m.SeriesInstanceUID,sop:m.SOPInstanceUID,
                  frames:v.getImageIds().length,voi:v.getProperties().voiRange};}""", arg=index)

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

    def site_library(self, name="Site Three Plane"):
        """What an administrator publishes: the same three-plane definition, institution wide."""
        value = self.mpr_library(name=name)
        value["rules"] = [value["rules"][0]]
        value["rules"][0]["id"] = self.SITE_RULE_ID
        value["activeRuleId"] = self.SITE_RULE_ID
        return value

    def site_rows(self, institution):
        return [row for row in psql('SELECT to_jsonb(t)::text FROM "HangingProtocolPreference" t '
                                    "WHERE subject='' AND institution='" + institution.replace("'", "''") + "';") if row]

    def cleanup_site(self, institution):
        """Delete exactly the institution rows this run created, by full-row equality."""
        for raw in self.site_rows(institution):
            print("SITE synthetic row " + raw, flush=True)
            if psql('DELETE FROM "HangingProtocolPreference" t WHERE to_jsonb(t)=\''
                    + raw.replace("'", "''") + "'::jsonb RETURNING 1;") != ["1"]:
                raise RuntimeError("Synthetic site row changed before exact-row cleanup")

    def publish_site(self, value, actor="jmryu"):
        """An administrator publishes through the isolated fixture API, never through seeded storage."""
        head = self.stack.request("GET", "/hanging-protocols/site", actor)
        self.assertEqual(200, head.status, head.text)
        institution = head.body["owner"]["institution"]
        if self.site_rows(institution):
            self.skipTest("SITE NATIVE SKIPPED: 기존 기관 행이 있어 합성 쓰기를 하지 않습니다")
        saved = self.stack.request("PUT", "/hanging-protocols/site", actor,
                                   dict(expectedOwner=head.body["owner"], revision=head.body["revision"], value=value))
        self.addCleanup(self.cleanup_site, institution)
        self.assertEqual(200, saved.status, saved.text)
        self.assertTrue(saved.body["canManageSite"])
        return saved.body

    def job_rows(self, uid):
        return [row for row in psql('SELECT to_jsonb(j)::text FROM "ViewerJob" j '
                                    "WHERE \"studyUid\"='" + uid.replace("'", "''") + "';") if row]

    def cleanup_jobs(self, uid):
        """Delete exactly the Job rows this run saved, by full-row equality.

        A saved Job holds a foreign key on StudyState, so the shared fixture cleanup cannot
        remove the study while it exists. This runs before that cleanup and never widens
        beyond this run's own study and author.
        """
        for raw in self.job_rows(uid):
            job = json.loads(raw)
            self.assertRegex(job["id"], r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")
            self.assertTrue(set(job["studies"]) <= set(self.stack.active))
            print("JOB synthetic row " + job["id"], flush=True)
            for rev in [row for row in psql('SELECT to_jsonb(r)::text FROM "ViewerJobRevision" r '
                                            "WHERE \"jobId\"='" + job["id"] + "'::uuid;") if row]:
                if psql('DELETE FROM "ViewerJobRevision" r WHERE to_jsonb(r)=\''
                        + rev.replace("'", "''") + "'::jsonb RETURNING 1;") != ["1"]:
                    raise RuntimeError("Synthetic Job revision changed before exact-row cleanup")
            if psql('DELETE FROM "ViewerJob" j WHERE to_jsonb(j)=\''
                    + raw.replace("'", "''") + "'::jsonb RETURNING 1;") != ["1"]:
                raise RuntimeError("Synthetic Job row changed before exact-row cleanup")

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

        # IF-A01 "저장 후 재현": the plane screen this rule just built is manipulated and then
        # saved as an MPR Job. Version 7 is the layout snapshot: three planes, one vacancy,
        # an explicit orientation per cell and one volume reference, never a synthesized SOP.
        expect(viewer.locator("#kin-viewer-jobs-status")).to_contain_text("저장 작업 목록", timeout=45000)
        viewer.evaluate("""()=>{
          const grid=services.viewportGridService,cs=services.cornerstoneViewportService;
          const id=[...grid.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x)[1].viewportId;
          const v=cs.getCornerstoneViewport(id),c=v.getCamera();
          v.setCamera({parallelScale:c.parallelScale*1.2,
            focalPoint:c.focalPoint.map((n,i)=>n+(i===1?2:0)),position:c.position.map((n,i)=>n+(i===1?2:0))});
          v.setProperties({voiRange:{lower:-420,upper:820}});v.render();grid.setActiveViewportId(id);}""")
        self.addCleanup(self.cleanup_jobs, current.uid)
        viewer.get_by_label("Job Title", exact=True).fill("HP plane layout job")
        viewer.get_by_role("button", name="Save New Job", exact=True).click()
        expect(viewer.locator("#kin-viewer-jobs-status")).to_contain_text("저장했습니다", timeout=45000)
        listed = self.stack.request("GET", f"/studies/{current.uid}/viewer-jobs", "doctor")
        self.assertEqual(200, listed.status, listed.text); self.assertEqual(1, len(listed.body["jobs"]))
        job = self.stack.request("GET", f"/studies/{current.uid}/viewer-jobs/{listed.body['jobs'][0]['id']}", "doctor")
        self.assertEqual(200, job.status, job.text); stored = job.body["snapshot"]
        self.assertEqual(7, stored["version"]); self.assertEqual([2, 2], [stored["rows"], stored["cols"]])
        self.assertEqual(4, len(stored["cells"])); self.assertIsNone(stored["cells"][3])
        self.assertEqual(["axial", "sagittal", "coronal"], [c["orientation"] for c in stored["cells"][:3]])
        self.assertEqual(1, stored["active"], "the manipulated plane stays the active cell index")
        self.assertEqual(series, stored["volume"]["series"]); self.assertEqual(current.uid, stored["volume"]["study"])
        self.assertEqual(sorted(cells[0]["sops"]), sorted(stored["volume"]["sops"]))
        self.assertEqual(64, len(stored["volume"]["sourceDigest"]))
        for cell in stored["cells"][:3]:
            self.assertNotIn("sop", cell); self.assertNotIn("frame", cell)
        # An incomplete original for the same layout is refused and leaves the saved Job alone.
        forged = json.loads(json.dumps(stored)); del forged["volume"]["sourceDigest"]
        forged["volume"]["sops"] = forged["volume"]["sops"][::2]
        denied = self.stack.request("POST", f"/studies/{current.uid}/viewer-jobs", "doctor",
                                    dict(id=str(uuid.uuid4()), title="Rejected plane layout",
                                         description="", snapshot=forged))
        self.assertEqual(400, denied.status, denied.text)
        self.assertEqual(1, len(self.stack.request("GET", f"/studies/{current.uid}/viewer-jobs", "doctor").body["jobs"]))

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

        # Reopened on the same account and device, the saved layout is restored over a screen
        # the rule alone had rebuilt: the planes, the vacancy, the manipulated camera and VOI.
        expect(target.locator("#kin-viewer-jobs-status")).to_contain_text("저장 작업 목록", timeout=45000)
        expect(target.get_by_text("MPR Plane Layout · 출력 미지원")).to_be_visible()
        self.assertEqual(0, target.get_by_role("button", name="Print Saved Images", exact=True).count(),
                         "a plane-layout Job offers no output path it cannot render")
        target.get_by_role("button", name="Restore Job", exact=True).click()
        expect(target.locator("#kin-viewer-jobs-status")).to_contain_text("복원했습니다", timeout=45000)
        restored = self.planes(target)
        self.assertEqual(4, len(restored)); self.assertEqual([], restored[3]["sets"])
        self.assertIsNone(restored[3].get("volumeId"))
        for cell in restored[:3]:
            self.assertEqual("orthographic", cell["type"]); self.assertTrue(cell["loaded"])
            self.assertEqual(cell["slices"], cell["framesLoaded"])
            self.assertEqual(sorted(stored["volume"]["sops"]), cell["sops"], "the whole original volume, in order")
            self.assertEqual(cell["sourceSops"], cell["sops"]); self.assertEqual(series, cell["series"])
        np.testing.assert_allclose(np.abs([cell["viewPlaneNormal"] for cell in restored[:3]]),
                                   [[0, 0, 1], [1, 0, 0], [0, 1, 0]], atol=1e-6)
        actual = target.evaluate("""()=>window.kinCreateVolumeJob({grid:services.viewportGridService,
          cs:services.cornerstoneViewportService,ds:services.displaySetService,
          studies:new URLSearchParams(location.search).get("StudyInstanceUIDs").split(",")}).capture()""")
        self.assertEqual(7, actual["version"]); self.assertEqual(stored["active"], actual["active"])
        self.assertEqual([stored["rows"], stored["cols"]], [actual["rows"], actual["cols"]])
        self.assertEqual(stored["volume"]["sops"], actual["volume"]["sops"])
        self.assertEqual(target.evaluate("()=>services.viewportGridService.getActiveViewportId()"),
                         self.cells(target)[stored["active"]]["id"])
        for left, right in zip(actual["cells"], stored["cells"]):
            if right is None:
                self.assertIsNone(left); continue
            self.assertEqual(right["orientation"], left["orientation"])
            self.assertEqual(right["projection"], left["projection"])
            self.assertEqual(right["properties"]["VOILUTFunction"], left["properties"]["VOILUTFunction"])
            self.assertEqual(right["properties"]["invert"], left["properties"]["invert"])
            self.assertEqual(right["properties"]["interpolationType"], left["properties"]["interpolationType"])
            for bound in ("lower", "upper"):
                self.assertAlmostEqual(left["properties"]["voiRange"][bound],
                                       right["properties"]["voiRange"][bound], delta=1e-6)
            for key, want in right["camera"].items():
                got = left["camera"][key]
                if isinstance(want, list):
                    for x, y in zip(got, want):
                        self.assertAlmostEqual(x, y, delta=1e-6)
                elif isinstance(want, bool):
                    self.assertEqual(got, want)
                else:
                    self.assertAlmostEqual(got, want, delta=1e-6)
        print("HP_PLANE_JOB " + json.dumps(dict(saved=stored, reopened=actual)), flush=True)
        target.screenshot(path=str(Path(__file__).parent / 'artifacts' / 'HP-plane-layout-job-restored.png'))
        expect(work.locator("#findings")).to_have_value("HP MPR UNSAVED REPORT")
        self.assertEqual(rows, self.report_rows(current)); self.assertEqual(originals, self.originals())


    def test_hp_06_published_site_rule_reaches_a_fresh_member_and_opens_its_planes(self):
        patient = "HP-SITE-" + uuid.uuid4().hex[:12]
        current = self.ct(patient, "current", "20260801")
        self.seed_report(current); originals = self.originals(); rows = self.report_rows(current)
        published = self.publish_site(self.site_library())
        site_key = "kin-hanging-protocols:v1:site:" + json.dumps([published["owner"]["institution"]], separators=(",", ":"))

        work = self.login(); self.select(work, current); work.locator("#findings").fill("HP SITE UNSAVED REPORT")
        viewer = work.context.new_page(); site_reads = []
        viewer.on("request", lambda request: site_reads.append(request.method)
                  if request.url.split("?")[0].endswith("/api/hanging-protocols/site") else None)
        viewer = self.launch(viewer, [current])
        # This member never opens the Site scope and has no matching rule of their own.
        personal = self.library(name="Personal MR Only"); personal["rules"][0]["match"]["modality"] = "MR"
        self.import_rules(viewer, personal)
        initial = self.cells(viewer)
        self.assertEqual(1, len(initial), "opening the viewer applies nothing by itself")

        # The published library reaches this browser from the server, not from a seeded cache.
        viewer.wait_for_function("key=>localStorage.getItem(key)!==null", arg=site_key, timeout=45000)
        self.assertEqual(["GET"], site_reads, "one read-only institution read, before any explicit press")
        self.assertEqual(initial, self.cells(viewer), "reading the institution library applies no layout")
        stored = viewer.evaluate("key=>JSON.parse(localStorage.getItem(key))", site_key)
        self.assertEqual("Site Three Plane", stored["rules"][0]["name"])

        viewer.locator("#kin-hp-apply-first").click()
        expect(viewer.locator("#kin-hp-applied")).to_have_text(
            "Applied Protocol: Site Three Plane · Source: Site", timeout=45000)
        self.rendered_planes(viewer, 3)
        cells = self.planes(viewer)
        self.assertEqual(4, len(cells), "three planes are three cells of the published 2x2 grid")
        self.assertEqual([], cells[3]["sets"]); self.assertIsNone(cells[3].get("volumeId"))
        series = self.described_ref(viewer, current, "D03A current")["series"]
        for cell in cells[:3]:
            self.assertEqual("orthographic", cell["type"]); self.assertEqual(1, len(cell["sets"]))
            self.assertEqual(cells[0]["volumeId"], cell["volumeId"], "every plane shows one and the same volume")
            self.assertEqual(series, cell["series"]); self.assertEqual(current.uid, cell["study"])
            self.assertEqual("mpr", cell["group"]); self.assertTrue(cell["loaded"])
            self.assertEqual(cell["slices"], cell["framesLoaded"])
            self.assertEqual(cell["sourceSops"], cell["sops"], "the plane stands on exactly the published series")
        normals = np.array([cell["viewPlaneNormal"] for cell in cells[:3]])
        np.testing.assert_allclose(np.abs(normals), [[0, 0, 1], [1, 0, 0], [0, 1, 0]], atol=1e-6)
        viewer.screenshot(path=str(Path(__file__).parent / 'artifacts' / 'HP-site-three-plane-cells.png'))
        self.assertEqual(["GET"], site_reads, "the applied institution library is read once, not per press")

        # A member may read the institution library and may not publish it. The screen says so,
        # and the server refuses regardless of the screen.
        viewer.select_option("#kin-hp-scope", "site")
        expect(viewer.locator("#kin-hp-scope-note")).to_contain_text("읽기 전용")
        for control in ("#kin-hp-save-account", "#kin-hp-reset-account", "#kin-hp-save-local", "#kin-hp-new"):
            expect(viewer.locator(control)).to_be_disabled()
        expect(viewer.get_by_label("Name")).to_be_disabled()
        viewer.locator("#kin-hp-load-account").click()
        expect(viewer.locator("#kin-hp-status")).to_contain_text("기관 규칙을 불러왔습니다")
        expect(viewer.get_by_label("Name")).to_have_value("Site Three Plane")
        self.assertEqual(["GET", "GET"], site_reads, "the explicit Load from Site is the only refresh")
        refused = self.stack.request("PUT", "/hanging-protocols/site", "doctor",
                                     dict(expectedOwner=published["owner"], revision=published["revision"],
                                          value=self.site_library("Member Attempt")))
        self.assertEqual(403, refused.status, refused.text)
        after = self.stack.request("GET", "/hanging-protocols/site", "doctor")
        self.assertEqual((published["revision"], "Site Three Plane", False),
                         (after.body["revision"], after.body["value"]["rules"][0]["name"], after.body["canManageSite"]))
        self.assertEqual(0, self.stack.request("GET", "/hanging-protocols", "doctor").body["revision"],
                         "applying a site rule writes nothing into the member's own account")
        expect(work.locator("#findings")).to_have_value("HP SITE UNSAVED REPORT")
        self.assertEqual(rows, self.report_rows(current)); self.assertEqual(originals, self.originals())


    def test_hp_07_mixed_plane_and_frame_cells_round_trip_through_the_account(self):
        patient = "HP-MIXED-" + uuid.uuid4().hex[:12]
        current = self.multiple(patient, "current", "20260801")
        self.seed_report(current); originals = self.originals(); rows = self.report_rows(current)
        work = self.login(); self.select(work, current); work.locator("#findings").fill("HP MIXED UNSAVED REPORT")
        viewer = self.launch(work.context.new_page(), [current])
        self.import_rules(viewer, self.mixed_library())
        self.apply(viewer, "Applied")
        self.rendered_planes(viewer, 3)
        cells = self.planes(viewer)
        self.assertEqual(["orthographic", "stack", "orthographic", None], [cell["type"] for cell in cells],
                         "the rule places both kinds in one grid and leaves the fourth cell empty")
        self.assertEqual([], cells[3]["sets"]); self.assertIsNone(cells[3].get("volumeId"))
        # Which of the study's two series the rule picked for which alias follows the product's
        # own Series Number ordering, so it is read off the screen rather than assumed here.
        before_frame = self.frame_cell(viewer, 1)
        plane_series, frame_series = cells[0]["series"], before_frame["series"]
        self.assertNotEqual(plane_series, frame_series, "the plane cells and the frame cell are different series")
        self.assertEqual({plane_series, frame_series},
                         {ref["series"] for ref in self.fixture_refs(viewer, current)})
        self.assertEqual({"D03A current", "D02E second series"},
                         {item.get("0008103E", {}).get("Value", [None])[0]
                          for item in self.metadata(viewer, current)})
        for cell in (cells[0], cells[2]):
            self.assertEqual(cells[0]["volumeId"], cell["volumeId"], "both planes show one and the same volume")
            self.assertEqual(plane_series, cell["series"]); self.assertEqual(current.uid, cell["study"])
            self.assertTrue(cell["loaded"]); self.assertEqual(cell["slices"], cell["framesLoaded"])
            self.assertEqual(cell["sourceSops"], cell["sops"])
        np.testing.assert_allclose(np.abs([cells[0]["viewPlaneNormal"], cells[2]["viewPlaneNormal"]]),
                                   [[0, 0, 1], [0, 1, 0]], atol=1e-6)
        self.assertGreaterEqual(before_frame["frames"], 2, "the frame cell must have another frame to choose")

        # Manipulate BOTH kinds, then make the frame cell the active one, so the saved snapshot
        # can only be reproduced by restoring a camera, a window and a chosen original frame.
        viewer.evaluate("""()=>{
          const grid=services.viewportGridService,cs=services.cornerstoneViewportService;
          const views=[...grid.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x);
          const plane=cs.getCornerstoneViewport(views[0].viewportId),c=plane.getCamera();
          plane.setCamera({parallelScale:c.parallelScale*1.2,
            focalPoint:c.focalPoint.map((n,i)=>n+(i===1?2:0)),position:c.position.map((n,i)=>n+(i===1?2:0))});
          plane.setProperties({voiRange:{lower:-420,upper:820}});plane.render();}""")
        viewer.evaluate("""async()=>{
          const grid=services.viewportGridService,cs=services.cornerstoneViewportService;
          const views=[...grid.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x);
          const v=cs.getCornerstoneViewport(views[1].viewportId),ids=v.getImageIds();
          // Whatever frame the rule opened, move to the next one, so the saved frame is
          // never the default no matter where the viewer started.
          const target=(Math.max(0,ids.indexOf(v.getCurrentImageId()))+1)%ids.length;
          await v.setImageIdIndex(target);v.scroll(target-v.getTargetImageIdIndex(),false);
          v.setProperties({voiRange:{lower:-300,upper:700}});v.render();
          grid.setActiveViewportId(views[1].viewportId);}""")
        chosen = self.frame_cell(viewer, 1)
        self.assertNotEqual(before_frame["sop"], chosen["sop"],
                            "the saved frame must not be the one the rule opened by itself")

        self.addCleanup(self.cleanup_jobs, current.uid)
        expect(viewer.locator("#kin-viewer-jobs-status")).to_contain_text("저장 작업 목록", timeout=45000)
        viewer.get_by_label("Job Title", exact=True).fill("HP mixed layout job")
        viewer.get_by_role("button", name="Save New Job", exact=True).click()
        expect(viewer.locator("#kin-viewer-jobs-status")).to_contain_text("저장했습니다", timeout=45000)
        listed = self.stack.request("GET", f"/studies/{current.uid}/viewer-jobs", "doctor")
        self.assertEqual(200, listed.status, listed.text); self.assertEqual(1, len(listed.body["jobs"]))
        job = self.stack.request("GET", f"/studies/{current.uid}/viewer-jobs/{listed.body['jobs'][0]['id']}", "doctor")
        self.assertEqual(200, job.status, job.text); stored = job.body["snapshot"]
        self.assertEqual(8, stored["version"]); self.assertEqual([2, 2], [stored["rows"], stored["cols"]])
        self.assertEqual(4, len(stored["cells"])); self.assertIsNone(stored["cells"][3])
        self.assertEqual(["plane", "stack", "plane"], [c["kind"] for c in stored["cells"][:3]])
        self.assertEqual(1, stored["active"], "the manipulated frame cell stays the active cell index")
        self.assertEqual(["axial", "coronal"], [stored["cells"][i]["orientation"] for i in (0, 2)])
        self.assertEqual(plane_series, stored["volume"]["series"])
        self.assertEqual(current.uid, stored["volume"]["study"])
        self.assertEqual(sorted(cells[0]["sops"]), sorted(stored["volume"]["sops"]))
        self.assertEqual(64, len(stored["volume"]["sourceDigest"]))
        for index in (0, 2):
            self.assertNotIn("sop", stored["cells"][index]); self.assertNotIn("frame", stored["cells"][index])
            self.assertEqual(plane_series, stored["cells"][index]["series"])
        # The frame cell keeps a real original instance, and the server bound its own digest.
        self.assertEqual(chosen["sop"], stored["cells"][1]["sop"])
        self.assertEqual(frame_series, stored["cells"][1]["series"])
        self.assertEqual(1, stored["cells"][1]["frame"])
        self.assertNotIn("orientation", stored["cells"][1])
        self.assertRegex(stored["cells"][1]["sourceDigest"], r"^[0-9a-f]{32}$")

        # Both originals are verified for this one snapshot: an incomplete volume and a frame
        # cell pointed at an instance of another series are each refused, Job untouched.
        def plain(snapshot):
            value = json.loads(json.dumps(snapshot)); del value["volume"]["sourceDigest"]
            for cell in value["cells"]:
                if cell is not None:
                    cell.pop("sourceDigest", None)
            return value
        for label, forge in [("incomplete volume", lambda v: v["volume"].__setitem__("sops", v["volume"]["sops"][::2])),
                             ("foreign frame", lambda v: v["cells"][1].__setitem__("sop", v["volume"]["sops"][0]))]:
            forged = plain(stored); forge(forged)
            denied = self.stack.request("POST", f"/studies/{current.uid}/viewer-jobs", "doctor",
                                        dict(id=str(uuid.uuid4()), title="Rejected mixed layout",
                                             description="", snapshot=forged))
            self.assertEqual(400, denied.status, label + ": " + denied.text)
        self.assertEqual(1, len(self.stack.request("GET", f"/studies/{current.uid}/viewer-jobs", "doctor").body["jobs"]))

        # Reopened on the same account and device over an ordinary single-cell screen — the
        # rollback snapshot of that screen is taken first and the mixed layout is rebuilt onto it.
        target = self.launch(self.login(), [current])
        expect(target.locator("#kin-viewer-jobs-status")).to_contain_text("저장 작업 목록", timeout=45000)
        expect(target.get_by_text("MPR Mixed Layout · 출력 미지원")).to_be_visible()
        self.assertEqual(0, target.get_by_role("button", name="Print Saved Images", exact=True).count(),
                         "a mixed-layout Job offers no output path it cannot render")
        self.assertEqual(1, len(self.cells(target)), "the reopened viewer starts on its own default layout")
        target.get_by_role("button", name="Restore Job", exact=True).click()
        expect(target.locator("#kin-viewer-jobs-status")).to_contain_text("복원했습니다", timeout=45000)
        restored = self.planes(target)
        self.assertEqual(["orthographic", "stack", "orthographic", None], [cell["type"] for cell in restored])
        self.assertEqual([], restored[3]["sets"]); self.assertIsNone(restored[3].get("volumeId"))
        for index in (0, 2):
            cell = restored[index]
            self.assertTrue(cell["loaded"]); self.assertEqual(cell["slices"], cell["framesLoaded"])
            self.assertEqual(sorted(stored["volume"]["sops"]), cell["sops"], "the whole original volume, in order")
            self.assertEqual(cell["sourceSops"], cell["sops"]); self.assertEqual(plane_series, cell["series"])
        np.testing.assert_allclose(np.abs([restored[0]["viewPlaneNormal"], restored[2]["viewPlaneNormal"]]),
                                   [[0, 0, 1], [0, 1, 0]], atol=1e-6)
        shown = self.frame_cell(target, 1)
        self.assertEqual([stored["cells"][1][key] for key in ("study", "series", "sop")],
                         [shown["study"], shown["series"], shown["sop"]],
                         "the frame cell stands on exactly the saved original instance")
        for bound in ("lower", "upper"):
            self.assertAlmostEqual(stored["cells"][1]["properties"]["voiRange"][bound], shown["voi"][bound], delta=1e-6)
        self.assertEqual(target.evaluate("()=>services.viewportGridService.getActiveViewportId()"),
                         self.cells(target)[stored["active"]]["id"])
        target.screenshot(path=str(Path(__file__).parent / 'artifacts' / 'HP-mixed-layout-job-restored.png'))

        # Saving again from the restored screen re-captures it through the product's own path;
        # the second stored snapshot is compared to the first rather than to a label.
        target.get_by_label("Job Title", exact=True).fill("HP mixed layout recapture")
        target.get_by_role("button", name="Save New Job", exact=True).click()
        expect(target.locator("#kin-viewer-jobs-status")).to_contain_text("저장했습니다", timeout=45000)
        rows_now = self.stack.request("GET", f"/studies/{current.uid}/viewer-jobs", "doctor").body["jobs"]
        self.assertEqual(2, len(rows_now))
        again_id = next(r["id"] for r in rows_now if r["title"] == "HP mixed layout recapture")
        again = self.stack.request("GET", f"/studies/{current.uid}/viewer-jobs/{again_id}", "doctor").body["snapshot"]
        self.assertEqual(8, again["version"])
        self.assertEqual([stored["rows"], stored["cols"], stored["active"]],
                         [again["rows"], again["cols"], again["active"]])
        self.assertEqual(stored["volume"]["sops"], again["volume"]["sops"])
        self.assertEqual(stored["volume"]["sourceDigest"], again["volume"]["sourceDigest"])
        for left, right in zip(again["cells"], stored["cells"]):
            if right is None:
                self.assertIsNone(left); continue
            self.assertEqual(right["kind"], left["kind"])
            for key in ("study", "series", "orientation", "sop", "frame", "sourceDigest", "projection"):
                if key in right:
                    self.assertEqual(right[key], left[key], key)
            for key in ("VOILUTFunction", "invert", "interpolationType"):
                self.assertEqual(right["properties"][key], left["properties"][key])
            for bound in ("lower", "upper"):
                self.assertAlmostEqual(left["properties"]["voiRange"][bound],
                                       right["properties"]["voiRange"][bound], delta=1e-6)
            for key, want in right["camera"].items():
                got = left["camera"][key]
                if isinstance(want, list):
                    for x, y in zip(got, want):
                        self.assertAlmostEqual(x, y, delta=1e-6)
                elif isinstance(want, bool):
                    self.assertEqual(got, want)
                else:
                    self.assertAlmostEqual(got, want, delta=1e-6)
        print("HP_MIXED_JOB " + json.dumps(dict(saved=stored, reopened=again)), flush=True)
        expect(work.locator("#findings")).to_have_value("HP MIXED UNSAVED REPORT")
        self.assertEqual(rows, self.report_rows(current)); self.assertEqual(originals, self.originals())


def load_tests(loader, tests, pattern):
    names = [name for name in HangingProtocolE2E.__dict__ if name.startswith("test_hp_")]
    return unittest.TestSuite(HangingProtocolE2E(name) for name in sorted(names))


if __name__ == "__main__":
    unittest.main(verbosity=2)
