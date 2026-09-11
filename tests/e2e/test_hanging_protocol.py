# coding: utf-8
"""Pinned OHIF personal Hanging Protocol flow over owned synthetic CT fixtures."""
from __future__ import annotations

import json
import unittest
import uuid
from pathlib import Path

from playwright.sync_api import expect

from test_viewer_layout import ViewerLayoutE2E
from test_prior_selection import canvas_ready
from workspace_roaming_support import cleanup_workspace


class HangingProtocolE2E(ViewerLayoutE2E):
    RULE_ID = "11111111-1111-4111-8111-111111111111"

    def setUp(self):
        super().setUp()
        self.addCleanup(cleanup_workspace, self.stack, "HangingProtocolPreference")

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

        viewer.get_by_role("button", name="Comparison", exact=True).click()
        viewer.get_by_label("Job Title", exact=True).fill("HP NAVIGATION UNSAVED JOB")
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


def load_tests(loader, tests, pattern):
    names = [name for name in HangingProtocolE2E.__dict__ if name.startswith("test_hp_")]
    return unittest.TestSuite(HangingProtocolE2E(name) for name in sorted(names))


if __name__ == "__main__":
    unittest.main(verbosity=2)
