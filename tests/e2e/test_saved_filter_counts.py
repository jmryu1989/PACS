# coding: utf-8
"""Saved worklist filters show live, non-destructive result counts."""
from __future__ import annotations

import re
import unittest
import uuid

from playwright.sync_api import expect
import test_worklist as previous


class SavedFilterCountsE2E(previous.WorklistE2E):
    def remove_filter(self, filter_id):
        result = self.stack.request("DELETE", f"/filters/{filter_id}", "doctor")
        if result.status not in (200, 404):
            raise RuntimeError(f"Filter cleanup failed ({result.status})")

    def test_saved_filter_count_updates_without_changing_current_search(self):
        """COUNT/STABLE/A11Y: a saved search count follows refreshed studies and applying it remains explicit."""
        shared_id = "FILTER-" + uuid.uuid4().hex[:10]
        first, second = self.fixture(patient_id=shared_id), self.fixture(patient_id=shared_id)
        page = self.login()
        page.locator("#quick").fill(shared_id)
        page.locator('#filterrow input[data-f="desc"]').fill("Invariant route fixture")
        expect(page.locator("#rows tr[data-uid]" )).to_have_count(2)

        name = '검사함-"<&-' + uuid.uuid4().hex[:8]
        def answer(dialog):
            dialog.accept(name) if dialog.type == "prompt" else dialog.dismiss()
        page.on("dialog", answer)
        with page.expect_response(lambda r: r.request.method == "POST" and r.url.endswith("/api/filters")) as saved:
            page.locator("#savefilter").click()
        page.remove_listener("dialog", answer)
        filter_id = saved.value.json()["id"]
        self.addCleanup(self.remove_filter, filter_id)

        chip = page.locator("#chips button", has_text=name)
        expect(chip).to_have_count(1)
        expect(chip).to_contain_text("(2)")
        expect(chip).to_have_attribute("aria-label", f"{name}, 로드된 목록 기준 2건")
        expect(chip.locator("img, script")).to_have_count(0)

        chip.focus()
        page.evaluate("render()")
        expect(chip).to_be_focused()

        chip.locator("span").click(button="right")
        with page.expect_response(lambda r: r.request.method == "PATCH" and "/api/filters/" in r.url) as toggled:
            page.locator("#ctx").get_by_text("기본 필터로 지정", exact=True).click()
        self.assertEqual(toggled.value.request.post_data_json, {"on": True})
        expect(page.locator("#toast")).to_have_text(f'"{name}" 을 기본 필터로 지정했습니다')
        expect(chip).to_have_attribute("aria-label", re.compile(r"기본 필터"))

        page.locator("#quick").fill("NO-SUCH-PATIENT")
        page.locator('#filterrow input[data-f="desc"]').fill("NO-SUCH-DESCRIPTION")
        expect(page.locator("#rows tr[data-uid]")).to_have_count(0)
        expect(chip).to_contain_text("(2)")

        third = self.fixture(patient_id=shared_id)
        with page.expect_response(lambda r: r.request.method == "GET" and r.url.endswith("/api/studies")):
            page.locator("#refresh").click()
        expect(chip).to_contain_text("(3)")
        chip.locator("span").click()
        expect(page.locator("#quick")).to_have_value(shared_id)
        expect(page.locator('#filterrow input[data-f="desc"]')).to_have_value("Invariant route fixture")
        expect(page.locator("#rows tr[data-uid]")).to_have_count(3)
        self.assertEqual({first.uid, second.uid, third.uid}, set(page.locator("#rows tr[data-uid]").evaluate_all(
            "rows => rows.map(row => row.dataset.uid)")))


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(SavedFilterCountsE2E(name)
                              for name in loader.getTestCaseNames(SavedFilterCountsE2E)
                              if name.startswith("test_saved_filter_count_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
