# coding: utf-8
"""TEST-WORKLIST-BODY-PARTS: actual QIDO series metadata drives saved search.

REQ-D01-BODY-PART-SEARCH -> RISK-D01-BODY-PART-UNKNOWN/WRONG/STALE/ACCESS
Only owned synthetic CT fixtures and a temporary personal filter are changed.
"""
from __future__ import annotations

import re
import unittest
import uuid

from playwright.sync_api import expect

import test_compound_search as compound
from test_prior_selection import synthetic_ct


class WorklistBodyPartsE2E(compound.CompoundSearchE2E):
    def wait_for_body_parts(self, page):
        page.wait_for_function("""() => {
            const state = worklistBodyParts.snapshot();
            return !state.busy && state.total > 0 && state.verified === state.total;
        }""", timeout=70000)

    def test_worklist_body_parts_01_actual_metadata_saved_default_and_clear(self):
        """Unknown values fail closed; an explicit read distinguishes tokens from verified missing."""
        prefix = "BODY-" + uuid.uuid4().hex[:10]
        chest = synthetic_ct(self.stack, prefix + "-CHEST", "body-chest", "20260801",
                             slices=1, body_part="CHEST")
        abdomen = synthetic_ct(self.stack, prefix + "-ABDOMEN", "body-abdomen", "20260802",
                               slices=1, body_part="ABDOMEN")
        unspecified = synthetic_ct(self.stack, prefix + "-NONE", "body-none", "20260803",
                                   slices=1, body_part=None)
        fixtures = [chest, abdomen, unspecified]
        self.seed_report(chest)
        original_versions = self.versions(chest)

        page = self.login()
        self.select(page, chest)
        draft = chest.secret + " / body-part search must not save this draft"
        page.locator("#findings").fill(draft)
        page.locator("#quick").fill(prefix)
        self.rows_are(page, fixtures)

        series_reads = []
        page.on("request", lambda request: series_reads.append(request.url)
                if request.method == "GET" and "/dicom-web/studies/" in request.url
                and "/series?" in request.url else None)
        self.open_manager(page)
        page.locator("#sfm-name").fill(prefix + "-verified-missing")
        page.locator("#sfm-default").check()
        row = self.rule(page, "bodyPart", "eq", "chest")
        expect(row.locator("[data-rule-field]")).to_have_value("bodyPart")
        expect(page.locator("#sfm-body-parts")).to_be_visible()

        # Before the explicit metadata read, unknown must not act like an empty value.
        self.count_is(page, 0)
        expect(page.locator("#sfm-count")).to_contain_text("Partial")
        expect(page.locator("#sfm-body-parts-load")).to_have_text("Read Body Parts")
        page.locator("#sfm-body-parts-load").click()
        self.wait_for_body_parts(page)
        self.count_is(page, 1)
        expect(page.locator("#sfm-body-parts-status")).to_contain_text(
            re.compile(r"부위 \d+/\d+건 확인 · 실패 0건"))
        expect(page.locator("#sfm-count")).not_to_contain_text("Partial")
        requested = {fixture.uid for fixture in fixtures
                     if any(f"/studies/{fixture.uid}/series?" in url for url in series_reads)}
        self.assertEqual(requested, {fixture.uid for fixture in fixtures},
                         "Each owned study must be read through the real DICOMweb series route")

        # Empty now means verified absence, while positive tokens remain distinct.
        self.rule(page, "bodyPart", "empty", index=0)
        self.count_is(page, 1)
        saved = self.save(page)
        self.assertEqual(saved["cols"]["$compound"], {
            "version": 1, "join": "and",
            "rules": [{"field": "bodyPart", "op": "empty"}],
        })
        self.assertTrue(saved["isDefault"])
        page.locator("#sfm-apply").click()
        self.rows_are(page, [unspecified])
        expect(page.locator("#findings")).to_have_value(draft)
        self.assertEqual(page.evaluate("selectedUid"), chest.uid)
        self.assertEqual(self.versions(chest), original_versions)

        # Metadata is deliberately session-memory only. The restored default fails
        # closed until the user explicitly reads the fresh session's accessible list.
        fresh = self.login()
        self.rows_are(fresh, [])
        expect(fresh.locator("#page-status")).to_contain_text("Partial")
        expect(fresh.locator("#body-parts-load")).to_have_text("Read Body Parts")
        fresh.locator("#body-parts-load").click()
        self.wait_for_body_parts(fresh)
        self.rows_are(fresh, [unspecified])
        expect(fresh.locator("#body-parts-status")).to_contain_text(
            re.compile(r"부위 \d+/\d+건 확인 · 실패 0건"))
        expect(fresh.locator("#page-status")).not_to_contain_text("Partial")

        fresh.locator("#clearfilter").click()
        expect(fresh.locator("#quick")).to_have_value("")
        expect(fresh.locator("#filterlist")).not_to_contain_text("Body Part")
        fresh.locator("#quick").fill(prefix)
        self.rows_are(fresh, fixtures)
        self.assertEqual(self.versions(chest), original_versions)


def load_tests(loader, tests, pattern):
    names = [name for name in loader.getTestCaseNames(WorklistBodyPartsE2E)
             if name.startswith("test_worklist_body_parts_")]
    return unittest.TestSuite(WorklistBodyPartsE2E(name) for name in names)


if __name__ == "__main__":
    test_loader = unittest.TestLoader()
    selected = unittest.TestSuite(
        WorklistBodyPartsE2E(name)
        for name in test_loader.getTestCaseNames(WorklistBodyPartsE2E)
        if name.startswith("test_worklist_body_parts_")
    )
    result = unittest.TextTestRunner(verbosity=2).run(selected)
    raise SystemExit(0 if result.wasSuccessful() else 1)
