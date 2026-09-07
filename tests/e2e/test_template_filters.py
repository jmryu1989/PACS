# coding: utf-8
"""D09D: personal bodypart browsing and exact current-modality filtering through the UI."""
from __future__ import annotations

import json
import unittest
import uuid

from playwright.sync_api import expect
import test_template_preservation as previous


class TemplateFiltersE2E(previous.TemplatePreservationE2E):
    def titles(self, page):
        return page.locator("#tplrows tr[data-i] td:first-child").all_text_contents()

    def body(self, page, value):
        page.locator("#t-body").select_option(json.dumps(value, ensure_ascii=False))

    def prefix(self):
        return "D09D-" + uuid.uuid4().hex[:10]

    def test_d09d_01_bodypart_normalization_composition_and_reset(self):
        """CLASS/HIDE: exact normalized classes compose with search and never include unspecified implicitly."""
        prefix = self.prefix()
        items = [self.template(title=prefix + suffix, bodypart=body, modality=modality)
                 for suffix, body, modality in [(" A", "  Chest   Wall ", "CT"),
                    (" B", "chest wall", "MR"), (" C", "Chest", "CT"),
                    (" D", "", ""), (" E", '<img src=x onerror="window.d09dBad=1">', "CT")]]
        fixture = self.fixture()
        page = self.login(); self.select(page, fixture)
        page.locator("#tpl-search").fill(prefix)
        self.body(page, "chest wall")
        expect(page.locator("#tplrows tr[data-i]")).to_have_count(1)
        self.assertEqual(self.titles(page), [items[0]["title"]])
        self.assertEqual(page.locator("#t-body option").evaluate_all(
            "options => options.filter(o => o.textContent.toLowerCase() === 'chest wall').length"), 1)
        page.locator("#t-mod").uncheck()
        expect(page.locator("#tplrows tr[data-i]")).to_have_count(2)
        self.assertEqual(self.titles(page), [items[0]["title"], items[1]["title"]])
        page.locator("#tpl-search").fill(prefix + " " + items[1]["shortcut"])
        expect(page.locator("#tplrows tr[data-i]")).to_have_count(1)
        self.body(page, "chest")
        expect(page.locator("#tplrows tr[data-i]")).to_have_count(0)
        expect(page.locator("#tpl-filter-status")).to_contain_text("0 /")
        page.locator("#tpl-search-clear").click()
        expect(page.locator("#t-body")).to_have_value('"chest"')
        expect(page.locator("#t-mod")).not_to_be_checked()
        expect(page.locator("#tpl-search")).to_be_focused()
        self.assertEqual(self.titles(page), [items[2]["title"]])
        page.locator("#tpl-search").fill(prefix)
        self.body(page, "")
        self.assertEqual(self.titles(page), [items[3]["title"]])
        self.body(page, items[4]["bodypart"].lower())
        self.assertEqual(self.titles(page), [items[4]["title"]])
        expect(page.locator("#t-body img, #tpl-filter-status img")).to_have_count(0)
        self.assertIsNone(page.evaluate("window.d09dBad"))
        page.locator("#t-mod").check()
        page.locator("#tpl-filter-clear").click()
        expect(page.locator("#t-body")).to_have_value("")
        expect(page.locator("#tpl-search")).to_have_value("")
        expect(page.locator("#t-mod")).not_to_be_checked()
        for item in items:self.assertIn(item["title"], self.titles(page))
        self.assertEqual({x["id"]: self.saved_template(x["id"]) for x in items}, {x["id"]: x for x in items})

    def test_d09d_02_modality_tokens_selection_and_missing_metadata(self):
        """CONTEXT/MATCH: real CT plus explicitly synthetic study-list modality variants, without rewriting DICOM."""
        prefix = self.prefix()
        items = [self.template(title=prefix + " " + name, bodypart="Context", modality=mod)
                 for name, mod in [("CT", "CT"), ("PT", "pt"), ("SCT", "SCT"),
                                   ("MULTI", " MR, ct "), ("GENERAL", "")]]
        a, b = self.fixture(), self.fixture()
        page = self.login()
        page.locator("#tpl-search").fill(prefix); self.body(page, "context")
        expect(page.locator("#tpl-filter-status")).to_contain_text("검사 미선택")
        self.select(page, a)
        self.assertEqual(self.titles(page), [items[n]["title"] for n in (0, 3, 4)])
        variants = {a.uid: "CT", b.uid: "PT"}
        def synthetic_modality(route):
            reply = route.fetch(); data = reply.json()
            for row in data["studies"]:
                if row["uid"] in variants:row["modality"] = variants[row["uid"]]
            route.fulfill(response=reply, json=data)
        page.route("**/api/studies", synthetic_modality)
        self.addCleanup(page.unroute, "**/api/studies")
        def refresh():
            with page.expect_response(lambda r: r.request.method == "GET" and r.url.endswith("/api/studies")):
                page.locator("#refresh").click()
        refresh(); self.select(page, b)
        expect(page.locator("#tpl-filter-status")).to_contain_text("Modality: PT")
        self.assertEqual(self.titles(page), [items[n]["title"] for n in (1, 4)])
        self.select(page, a)
        expect(page.locator("#tpl-filter-status")).to_contain_text("Modality: CT")
        self.assertEqual(self.titles(page), [items[n]["title"] for n in (0, 3, 4)])
        for modality, indexes, status in [("SCT", (2, 4), "Modality: SCT"),
                (" CT, PT ", (0, 1, 3, 4), "Modality: CT, PT"),
                ("", (0, 1, 2, 3, 4), "검사 Modality 없음")]:
            variants[a.uid] = modality; refresh()
            expect(page.locator("#tpl-filter-status")).to_contain_text(status)
            self.assertEqual(self.titles(page), [items[n]["title"] for n in indexes])
            expect(page.locator("#t-body")).to_have_value('"context"')
            expect(page.locator("#tpl-search")).to_have_value(prefix)

    def test_d09d_03_edit_delete_retains_filter_and_account_boundary(self):
        """STABLE/WRONG: filtered actions keep the original item, and changing the last class leaves zero results."""
        prefix = self.prefix()
        other = self.template(title=prefix + " Other", bodypart="Other " + prefix)
        selected = self.template(title=prefix + " Selected", bodypart=prefix)
        page = self.login(); self.body(page, prefix.lower())
        page.locator("#tplrows").get_by_role("button", name="상용구 미리보기: " + selected["title"], exact=True).click()
        expect(page.locator("#tpl-preview-title")).to_contain_text(selected["title"])
        page.locator("#tpl-preview-close").click()
        self.edit(page, selected["title"])
        changed = "Changed " + prefix
        page.locator("#tpl-b").fill(changed)
        saved = self.save(page)
        self.assertEqual(saved, dict(selected, bodypart=changed))
        expect(page.locator("#t-body")).to_have_value(json.dumps(prefix.lower()))
        expect(page.locator("#tplrows tr[data-i]")).to_have_count(0)
        self.body(page, changed.lower())
        self.assertEqual(self.titles(page), [selected["title"]])
        page.once("dialog", lambda dialog: dialog.accept())
        page.locator("#tplrows").get_by_text(selected["title"], exact=True).click(button="right")
        with page.expect_response(lambda r: r.request.method == "DELETE" and r.url.endswith(f'/templates/{selected["id"]}')) as reply:
            page.locator("#ctx").get_by_text("삭제", exact=True).click()
        self.assertEqual(reply.value.status, 200)
        self.deleted_id = selected["id"]
        expect(page.locator("#tplrows tr[data-i]")).to_have_count(0)
        expect(page.locator("#t-body")).to_have_value(json.dumps(changed.lower()))
        self.assertEqual(self.saved_template(other["id"]), other)
        fresh = self.login()
        expect(fresh.locator("#t-body")).to_have_value("")
        expect(fresh.locator("#tpl-search")).to_have_value("")
        expect(fresh.locator("#t-mod")).to_be_checked()
        second = self.login("doctor2")
        self.assertNotIn(other["title"], self.titles(second))
        self.assertNotIn(other["bodypart"], second.locator("#t-body option").all_text_contents())

    def remove_template(self, template_id):
        if template_id != getattr(self, "deleted_id", None):super().remove_template(template_id)

    def test_d09d_04_navigation_is_readonly_and_controls_reachable(self):
        """READONLY/SIDE: classification and reset never write reports, drafts, holds or templates."""
        prefix = self.prefix()
        template = self.template(title=prefix, bodypart="Brain")
        fixture = self.fixture(); self.seed_report(fixture)
        before = self.report_rows(fixture)
        page = self.login(); self.select(page, fixture)
        writes = []
        page.on("request", lambda r: writes.append(r.url) if r.method in ("POST", "PUT", "PATCH", "DELETE")
                and ("/templates" in r.url or "/report" in r.url or "/draft" in r.url or r.url.endswith("/hold")) else None)
        for width, height in [(900, 600), (900, 1200)]:
            page.set_viewport_size(dict(width=width, height=height))
            page.locator("#tpl-search").fill(prefix)
            self.body(page, "brain")
            page.locator("#t-mod").uncheck()
            for selector in ("#t-body", "#tpl-search", "#tpl-search-clear", "#tpl-filter-clear", "#tpl-filter-status"):
                expect(page.locator(selector)).to_be_in_viewport()
            expect(page.locator("#t-desc")).to_be_disabled()
            page.locator("#tpl-filter-clear").focus(); page.keyboard.press("Enter")
            expect(page.locator("#tpl-search")).to_be_focused()
        page.locator("#tpl-search").fill(prefix); self.body(page, "brain")
        folder = previous.base.Path(__file__).parent / "artifacts"; folder.mkdir(exist_ok=True)
        page.screenshot(path=str(folder / "D09D-template-filters.png"))
        self.assertEqual(writes, [])
        self.assertEqual(self.report_rows(fixture), before)
        self.assertEqual(self.saved_template(template["id"]), template)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(TemplateFiltersE2E(name) for name in loader.getTestCaseNames(TemplateFiltersE2E)
                              if name.startswith("test_d09d_"))


if __name__ == "__main__":unittest.main(verbosity=2)
