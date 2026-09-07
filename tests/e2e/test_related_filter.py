# coding: utf-8
"""D03D: related-list modality filtering keeps viewing and report ownership stable."""
from __future__ import annotations

import json
from pathlib import Path
import unittest
import uuid
from playwright.sync_api import expect
import test_return_to_current as previous


class RelatedFilterE2E(previous.ReturnToCurrentE2E):
    def variants(self, page, changes):
        def reply(route):
            response = route.fetch(); data = response.json()
            for row in data["studies"]:
                if row["uid"] in changes:row.update(changes[row["uid"]])
            route.fulfill(response=response, json=data)
        page.route("**/api/studies", reply)
        self.addCleanup(page.unroute, "**/api/studies")
        self.refresh(page)

    def filter(self, page, token=None):
        page.locator("#related-modality").select_option("" if token is None else json.dumps(token))

    def shown(self, page, fixtures):
        expect(page.locator("#relrows tr[data-uid]")).to_have_count(len(fixtures))
        self.assertEqual(set(page.locator("#relrows tr[data-uid]").evaluate_all("rows => rows.map(r => r.dataset.uid)")),
                         {f.uid for f in fixtures})

    def test_d03d_01_exact_tokens_scope_empty_refresh_and_literal_text(self):
        """FILTER/MATCH: response-only variants exercise list semantics, not non-CT image support."""
        patient = "D03D-" + uuid.uuid4().hex[:16]
        fixtures = [self.ct(patient, label, "20260701") for label in
                    ("current", "ct", "mr", "mixed", "oct", "empty", "literal", "other-origin")]
        current, ct, mr, mixed, oct_, empty, literal_, origin = fixtures
        other = self.ct(patient + "-other", "other", "20260701")
        fixtures.append(other)
        literal = '<IMG SRC=X ONERROR="WINDOW.D03DBAD=1">'
        changes = {f.uid:dict(modality=value) for f,value in
                   ((ct," ct "),(mr,"MR"),(mixed,"CT, mr,CT"),(oct_,"OCT"),(empty," , "),
                    (literal_,literal),(origin,"XA"),(other,"US"))}
        changes[origin.uid]["sourcePatientKey"] = "D03D-other-origin-same-patient"
        rows = {f.uid:self.report_rows(f) for f in fixtures}; originals = self.originals()
        page = self.login(); expect(page.locator("#related-modality")).to_be_disabled()
        self.variants(page,changes); self.select(page,current)
        self.shown(page,[ct,mr,mixed,oct_,empty,literal_])
        expect(page.locator("#related-filter-count")).to_have_text("6 / 6")
        options = page.locator("#related-modality option").all_text_contents()
        self.assertEqual(set(options),{"전체 Modality","미지정","CT","MR","OCT",literal})
        for token,expected in (("CT",[ct,mixed]),("MR",[mr,mixed]),("OCT",[oct_]),("",[empty]),(literal,[literal_])):
            self.filter(page,token); self.shown(page,expected)
            expect(page.locator("#related-filter-count")).to_have_text(f"{len(expected)} / 6")
        self.assertIsNone(page.evaluate("window.D03DBAD"))
        expect(page.locator("#relrows img, #related-modality img")).to_have_count(0)
        expect(page.locator("#related-modality")).to_have_attribute("title",literal)
        self.filter(page,"CT")
        changes[ct.uid]["modality"] = "MR"; changes[mixed.uid]["modality"] = "MR"
        self.refresh(page); self.shown(page,[])
        expect(page.locator("#related-modality")).to_have_value(json.dumps("CT"))
        expect(page.locator("#related-filter-count")).to_have_text("0 / 6")
        expect(page.locator("#relrows")).to_contain_text("조건에 맞는 관련 검사 없음")
        self.filter(page); self.shown(page,[ct,mr,mixed,oct_,empty,literal_])
        for fixture in fixtures:self.assertEqual(self.report_rows(fixture),rows[fixture.uid])
        self.assertEqual(self.originals(),originals)

    def test_d03d_02_hidden_view_keeps_thumbnail_report_draft_and_hold(self):
        """CONTEXT/LOSS: filtering causes no view fetches or report writes, then explicit return still works."""
        current, related = self.pair()
        values = dict(findings="D03D private findings",conclusion="D03D private conclusion",recommendation="D03D private recommendation")
        self.assertEqual(self.stack.request("PUT",f"/studies/{current.uid}/report","doctor",dict(values,baseVersion=1)).status,200)
        self.assertEqual(self.stack.request("POST",f"/studies/{current.uid}/hold","doctor").status,201)
        rows = {f.uid:self.report_rows(f) for f in (current,related)}; originals = self.originals()
        page = self.login(); self.select(page,current); self.related(page,related).click()
        self.thumbnail_ready(page); expect(page.locator("#prior-findings")).to_have_text(related.secret)
        before = {selector:page.locator(selector).inner_text() for selector in ("#clinical","#related-current","#prior-report-meta")}
        src = page.locator("#thumbwrap img").get_attribute("src")
        requests = []; listener = lambda r:requests.append((r.method,r.url)) if any(x in r.url for x in ("/api/studies/","/api/dicom/lookup","/dicom-web/","/instances/")) else None
        page.on("request",listener)
        for token in ("",None,"",None,""):
            self.filter(page,token)
            if token == "":
                self.shown(page,[]); expect(page.locator("#related-filter-hidden")).to_be_visible()
            else:
                self.shown(page,[related]); expect(page.locator("#related-filter-hidden")).not_to_be_visible()
            for selector,text in before.items():self.assertEqual(page.locator(selector).inner_text(),text)
            self.assertEqual(page.locator("#thumbwrap img").get_attribute("src"),src)
            expect(page.locator("#prior-findings")).to_have_text(related.secret)
            for name,value in values.items():expect(page.locator("#"+name)).to_have_value(value)
        page.wait_for_timeout(200); self.assertEqual(requests,[]); page.remove_listener("request",listener)
        self.assertEqual(self.state(current)["holder"],self.stack.actor("doctor"))
        self.return_with_thumbnail(page,current)
        expect(page.locator("#related-filter-hidden")).not_to_be_visible()
        expect(page.locator("#related-modality")).to_have_value(json.dumps(""))
        for name,value in values.items():expect(page.locator("#"+name)).to_have_value(value)
        for fixture in (current,related):self.assertEqual(self.report_rows(fixture),rows[fixture.uid])
        self.assertEqual(self.originals(),originals)

    def test_d03d_03_keyboard_delayed_report_small_windows_and_target_reset(self):
        """RESET/STALE: hiding a pending related row retains its identity until explicit target movement."""
        current, related = self.pair(); other = self.ct("D03D-"+uuid.uuid4().hex[:16],"other","20260701")
        originals = self.originals()
        page = self.login(); self.select(page,current)
        pending = []; pattern = f"**/api/studies/{related.uid}/report/versions"
        page.route(pattern,lambda route:pending.append(route)); self.addCleanup(page.unroute,pattern)
        self.related(page,related).click(); self.thumbnail_ready(page)
        page.wait_for_timeout(100); self.assertEqual(len(pending),1)
        select = page.locator("#related-modality")
        page.set_viewport_size(dict(width=900,height=600))
        expect(select).to_be_in_viewport(ratio=1)
        select.focus(); select.press("Home"); select.press("ArrowDown"); select.press("Enter")
        select.press("Escape")
        expect(select).to_have_value(json.dumps("")); expect(select).to_be_focused()
        expect(page.locator("#related-filter-hidden")).to_be_in_viewport(ratio=1)
        reply = pending[0].fetch(); self.assertEqual(reply.status,200); pending[0].fulfill(response=reply)
        expect(page.locator("#prior-findings")).to_have_text(related.secret)
        expect(page.locator("#clinical")).to_contain_text("D03A future")
        expect(page.locator("#related-current")).to_contain_text("D03A current")
        folder = Path(__file__).parent/"artifacts"; folder.mkdir(exist_ok=True)
        page.screenshot(path=str(folder/"d03d-filter-900x600.png"))
        page.unroute(pattern)
        self.filter(page,"CT")
        row = self.related(page,related)
        row.click(timeout=5000)
        box = row.bounding_box(); header = page.locator(".related-list-pane thead").bounding_box()
        self.assertGreaterEqual(box["y"],header["y"]+header["height"]-1,
                                "The sticky heading must not cover the row even when geometry alone fits")
        page.screenshot(path=str(folder/"d03d-row-900x600.png"))
        page.set_viewport_size(dict(width=900,height=1200)); self.filter(page,"CT")
        expect(select).to_be_in_viewport(ratio=1); expect(self.related(page,related)).to_be_in_viewport(ratio=1)
        page.screenshot(path=str(folder/"d03d-filter-900x1200.png"))
        page.unroute(pattern)
        self.select(page,other)
        expect(select).to_have_value(""); expect(page.locator("#related-filter-count")).to_have_text("0 / 0")
        expect(page.locator("#related-filter-hidden")).not_to_be_visible()
        expect(page.locator("#prior-findings")).to_have_text("")
        self.select(page,current); expect(select).to_have_value(""); self.shown(page,[related])
        self.assertEqual(self.originals(),originals)


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(RelatedFilterE2E(name) for name in loader.getTestCaseNames(RelatedFilterE2E)
                              if name.startswith("test_d03d_"))

if __name__ == "__main__":unittest.main(verbosity=2)
