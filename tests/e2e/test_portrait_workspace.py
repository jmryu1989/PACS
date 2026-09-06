"""D02A live portrait access tests, separate from B2 and D03A counts.

Run: python tests/e2e/test_portrait_workspace.py
Uses existing local guard, temporary identities and owned synthetic fixtures.
"""
from __future__ import annotations

from datetime import date
import hashlib
import re
import unittest
import uuid
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect
import test_worklist as base
from test_prior_selection import synthetic_ct


class PortraitWorkspaceE2E(base.WorklistE2E):
    def fixture(self, patient_id=None):
        fixture = synthetic_ct(self.stack, patient_id or "D02A-" + uuid.uuid4().hex[:16],
                               "D2" + uuid.uuid4().hex[:8], date.today().strftime("%Y%m%d"), slices=1)
        rows = self.stack._orthanc_request("POST", "/tools/lookup", fixture.uid.encode("ascii")).body
        orth_id = next(row["ID"] for row in rows if row["Type"] == "Study")
        instances = self.stack._orthanc_request("GET", f"/studies/{orth_id}/instances").body
        self.assertEqual(len(instances), 1)
        path = "/instances/" + instances[0]["ID"] + "/file"
        original = hashlib.sha256(self.stack.orthanc_bytes(path)).hexdigest()
        # Run before the inherited owned-fixture cleanup, even after a failed UI assertion.
        self.addCleanup(self.check_original, path, original)
        return fixture

    def check_original(self, path, original):
        self.assertEqual(hashlib.sha256(self.stack.orthanc_bytes(path)).hexdigest(), original)

    def portrait(self, page, width=900, height=1400):
        page.set_viewport_size({"width": width, "height": height})
        expect(page.locator("body")).to_have_class(re.compile(r"\bportrait\b"))

    def reachable(self, page, selector):
        element = page.locator(selector)
        element.scroll_into_view_if_needed()
        expect(element).to_be_visible()
        expect(element).to_be_in_viewport()
        # Viewport intersection alone misses clipping by a scrollable ancestor.
        element.click(trial=True)

    def wait_thumbnail(self, page):
        page.wait_for_function("""() => {
            const images = [...document.querySelectorAll('#thumbwrap img')];
            return images.length > 0 && images.every(img => img.complete && img.naturalWidth > 0);
        }""", timeout=30000)

    def snapshot(self, page, name):
        folder = base.Path(__file__).parent / "artifacts"
        folder.mkdir(exist_ok=True)
        page.screenshot(path=str(folder / ("D02A-" + name + ".png")))

    def drag(self, page, selector, dy):
        handle = page.locator(selector)
        handle.scroll_into_view_if_needed()
        box = handle.bounding_box()
        self.assertIsNotNone(box)
        x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x, y + dy, steps=8)
        page.mouse.up()

    def template(self):
        title = "D02A-" + uuid.uuid4().hex[:12]
        body = {"title": title, "modality": "CT", "findings": title + " findings", "conclusion": title + " conclusion"}
        result = self.stack.request("POST", "/templates", "doctor", body)
        self.assertEqual(result.status, 201)
        template_id = result.body["id"]
        self.addCleanup(self.cleanup_template, template_id)
        return body

    def cleanup_template(self, template_id):
        result = self.stack.request("DELETE", f"/templates/{template_id}", "doctor")
        self.assertEqual(result.status, 200)
        # The template table has no Keycloak FK, so deleting the user alone is insufficient.
        self.assertEqual(base.psql(f'SELECT count(*) FROM "ReadingTemplate" WHERE id={int(template_id)};'), ["0"])

    def test_d02a_panels_resize_and_thumbnail(self):
        """ACCESS/RESIZE/COST: visible real content, scroll reachability and no reload on layout."""
        fixture = self.fixture()
        self.seed_report(fixture)
        page = self.login()
        self.select(page, fixture)
        self.wait_thumbnail(page)
        history = self.versions(fixture)
        requests = []
        listener = lambda request: requests.append(request.url) if ("/dicom-web/" in request.url or "/preview" in request.url
                    or ("/templates" in request.url and request.method != "GET")) else None
        page.on("request", listener)
        try:
            self.portrait(page)
            for selector in ["#thumbwrap img", "#clinical", "#t-mod", "#resize-top", "#logout"]:
                self.reachable(page, selector)
            expect(page.locator("#clinical")).to_contain_text(fixture.patient_id)
            self.snapshot(page, "900-panels")
            old = page.locator(".rw").bounding_box()["height"]
            self.drag(page, "#resize-top", 30)
            self.assertGreater(page.locator(".rw").bounding_box()["height"], old + 15)
            self.drag(page, "#resize-main", 80)
            self.drag(page, "#resize-related", 20)
            self.portrait(page, 768, 1024)
            for selector in ["#thumbwrap img", "#clinical", "#t-mod", "#b-save", "#b-history", "#logout"]:
                self.reachable(page, selector)
            self.snapshot(page, "768-report")
            # The resize handle is now inside a scrolled workspace.
            old = page.locator(".rw").bounding_box()["height"]
            self.drag(page, "#resize-top", -15)
            self.assertGreaterEqual(page.locator(".rw").bounding_box()["height"], 140)
            self.assertLess(page.locator(".rw").bounding_box()["height"], old - 5)
            page.locator("#layout-toggle").click()  # auto -> portrait
            page.set_viewport_size({"width": 1600, "height": 1000})
            expect(page.locator("body")).to_have_class(re.compile(r"\bportrait\b"))
            self.reachable(page, "#b-history")
            page.locator("#layout-toggle").click()  # portrait -> landscape
            expect(page.locator("body")).not_to_have_class(re.compile(r"\bportrait\b"))
            self.snapshot(page, "1600-landscape")
            page.locator("#layout-toggle").click()  # landscape -> auto
            self.portrait(page)
            self.reachable(page, "#b-history")
            expect(page.locator(f'#rows tr[data-uid="{fixture.uid}"]')).to_have_class(re.compile(r"\bsel\b"))
            expect(page.locator("#findings")).to_have_value(fixture.secret)
        finally:
            page.remove_listener("request", listener)
        self.assertEqual(requests, [], "Layout/resize/scroll must not reload images")
        self.assertEqual(self.versions(fixture), history)
        self.reachable(page, "#thumbwrap img")
        with page.context.expect_page() as opened:
            page.locator("#thumbwrap img").dblclick()
        viewer = opened.value
        viewer.wait_for_url("**/ohif/viewer?**", timeout=30000)
        self.assertEqual(parse_qs(urlsplit(viewer.url).query)["StudyInstanceUIDs"], [fixture.uid])
        viewer.wait_for_function("""() => {
            const c = document.querySelector('.cornerstone-canvas');
            if (!c || !c.width || !c.height) return false;
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let lo=255, hi=0;
            for (let i=0; i<d.length; i+=16) { lo=Math.min(lo,d[i]); hi=Math.max(hi,d[i]); }
            return hi-lo>40;
        }""", timeout=60000)
        image_ids = viewer.evaluate("""() => cornerstone.getRenderingEngines().filter(e => e.id !== '_thumbnails')
            .flatMap(e => e.getViewports().map(v => v.getCurrentImageId?.()))""")
        self.assertTrue(any(image and f"/studies/{fixture.uid}/" in image for image in image_ids))
        self.snapshot(viewer, "thumbnail-viewer")

    def test_d02a_template_current_draft_while_viewing_related(self):
        """REPORT: visible template inserts into current draft, never the related approved report."""
        patient = "D02A-" + uuid.uuid4().hex[:16]
        current, related = self.fixture(patient_id=patient), self.fixture(patient_id=patient)
        self.seed_report(current)
        self.seed_report(related, action="approve")
        template = self.template()
        history = {f.uid: self.versions(f) for f in [current, related]}
        page = self.login()
        self.portrait(page)
        self.select(page, current)
        page.locator(f'#relrows tr[data-uid="{related.uid}"]').click()
        expect(page.locator("#prior-findings")).to_contain_text(related.secret)
        self.wait_thumbnail(page)
        expect(page.locator("#clinical")).to_contain_text(patient)
        page.locator("#tplrows").get_by_text(template["title"], exact=True).dblclick()
        expected = current.secret + "\n" + template["findings"]
        expect(page.locator("#findings")).to_have_value(expected)
        expect(page.locator("#conclusion")).to_have_value("E2E conclusion\n" + template["conclusion"])
        page.locator("#quick").click()
        self.wait_state(page, current, lambda s: (s.get("draft") or {}).get("findings") == expected, timeout=30000)
        self.portrait(page, 768, 1024)
        self.reachable(page, "#findings")
        expect(page.locator("#findings")).to_have_value(expected)
        self.snapshot(page, "template-draft")
        page.reload()
        self.select(page, current)
        self.reachable(page, "#findings")
        expect(page.locator("#findings")).to_have_value(expected)
        self.assertEqual(self.state(current)["findings"], current.secret)
        self.assertIsNone(self.state(current, "doctor2").get("draft"))
        for fixture in [current, related]:
            self.assertEqual(self.versions(fixture), history[fixture.uid])

    def test_d02a_technician_and_approved_locks(self):
        """MODE: technician access, filming locks and approved commit restrictions survive portrait."""
        fixture = self.fixture()
        self.patch(fixture, ss="Unverified", em="N")
        doctor = self.login()
        self.portrait(doctor)
        self.select(doctor, fixture)
        self.locked(doctor)
        tech = self.login("tech")
        self.portrait(tech, 768, 1024)
        tech.locator('[data-tab="Technician"]').click()
        self.select(tech, fixture)
        self.wait_thumbnail(tech)
        expect(tech.locator(".s-template")).to_be_hidden()
        expect(tech.locator(".report-p")).to_be_hidden()
        self.reachable(tech, "#clinical")
        self.reachable(tech, ".order-p")
        with tech.expect_response(lambda r: r.request.method == "PATCH" and r.url.endswith(f"/studies/{fixture.uid}")) as reply:
            tech.locator("#t-verify").click()
        self.assertEqual(reply.value.status, 200)
        self.assertEqual(self.state(fixture)["ss"], "Verified")
        self.snapshot(tech, "technician")
        self.seed_report(fixture, action="approve")
        template = self.template()
        doctor.reload()
        self.select(doctor, fixture)
        for button in ("#b-save", "#b-transcribe", "#b-approve"):
            expect(doctor.locator(button)).to_be_disabled()
        expect(doctor.locator("#b-addendum")).to_be_enabled()
        history = self.versions(fixture)
        # Approved reports permit preparing an addendum in a private draft;
        # readonly is the filming/role/holder contract, not the approved contract.
        doctor.locator("#tplrows").get_by_text(template["title"], exact=True).dblclick()
        expected = fixture.secret + "\n" + template["findings"]
        expect(doctor.locator("#findings")).to_have_value(expected)
        doctor.locator("#quick").click()
        self.wait_state(doctor, fixture, lambda s: (s.get("draft") or {}).get("findings") == expected, timeout=30000)
        self.assertEqual(self.state(fixture)["rs"], "A")
        self.assertEqual(self.state(fixture)["findings"], fixture.secret)
        self.assertEqual(self.versions(fixture), history)
        self.assertIsNone(self.state(fixture, "doctor2").get("draft"))


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(PortraitWorkspaceE2E(name) for name in loader.getTestCaseNames(PortraitWorkspaceE2E)
                              if name.startswith("test_d02a_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
