# coding: utf-8
"""Native Worklist Images browsing with real stored multi-instance/multiframe pixels."""
import base64, io, time, unittest, uuid
from pathlib import Path

import numpy as np
from PIL import Image
from playwright.sync_api import expect, Error as PlaywrightError

from test_worklist_image_preview import WorklistImagePreviewE2E
from test_cine import CineE2E
from test_prior_selection import synthetic_ct


class ImageThumbnailsE2E(WorklistImagePreviewE2E):
    def open_images(self, page, label):
        card = page.locator("#thumbwrap .thumb-card").filter(has_text=label)
        button = card.locator(".thumb-images-open")
        expect(button).to_be_enabled(timeout=25000); button.focus(); button.press("Enter")
        view = page.locator("#thumb-images-view"); expect(view).to_be_visible()
        return view

    def ready(self, view, count):
        expect(view.locator("#thumb-images-status")).to_have_text(f"{count} / {count} images ready", timeout=30000)
        expect(view.locator(".thumb-image-card img")).to_have_count(count)
        return view.locator(".thumb-image-card")

    def pixels(self, image):
        data = image.evaluate("""i=>{const c=document.createElement('canvas');c.width=i.naturalWidth;c.height=i.naturalHeight;
          c.getContext('2d').drawImage(i,0,0);return c.toDataURL('image/png').split(',')[1]}""")
        return np.asarray(Image.open(io.BytesIO(base64.b64decode(data))).convert("RGB"))

    def test_image_thumbnails_01_multiframe_multiinstance_pixels_identity_order_and_pages(self):
        f = synthetic_ct(self.stack, "IMAGE-THUMBS-" + uuid.uuid4().hex[:12], "current", "20260801", slices=14)
        multi = CineE2E.series(self, f, 14, "IMAGE THUMBNAILS multiframe")
        originals = self.originals(); rows = self.report_rows(f); page = self.login(); writes = self.source_writes(page); self.select(page, f); self.thumbs(page)
        requests = []
        page.on("request", lambda r: requests.append(r.url) if "/frames/" in r.url and "width=256" in r.url else None)

        view = self.open_images(page, multi["label"]); cards = self.ready(view, 12)
        self.assertEqual([multi["sops"][0]] * 12, cards.evaluate_all("xs=>xs.map(x=>x.dataset.sop)"))
        self.assertEqual([str(i) for i in range(12)], cards.evaluate_all("xs=>xs.map(x=>x.dataset.frame)"))
        expect(cards.first.locator(".thumb-description")).to_have_text(f"SOP {multi['sops'][0]} · Frame 1 / 14")
        self.assertTrue(requests); expected = page.request.get(requests[0], headers={"Accept": "image/png"})
        self.assertEqual(200, expected.status)
        np.testing.assert_array_equal(self.pixels(cards.first.locator("img")), np.asarray(Image.open(io.BytesIO(expected.body())).convert("RGB")))
        view.locator("#thumb-images-next").click(); cards = self.ready(view, 2)
        self.assertEqual(["12", "13"], cards.evaluate_all("xs=>xs.map(x=>x.dataset.frame)"))
        expect(view.locator("#thumb-images-page")).to_have_text("Page 2 / 2 · 14 images")
        view.locator("#thumb-images-order").select_option("descending"); cards = self.ready(view, 12)
        self.assertEqual([str(i) for i in range(13, 1, -1)], cards.evaluate_all("xs=>xs.map(x=>x.dataset.frame)"))

        view.locator("#thumb-images-back").click(); self.thumbs(page)
        # The ordinary CT series consists of real distinct SOP instances. Its Images view must retain that identity.
        other = page.locator("#thumbwrap .thumb-card").filter(has_not_text=multi["label"]).first
        other_label = other.locator(".thumb-number").inner_text(); expect(other.locator(".thumb-images-open")).to_be_enabled(); other.locator(".thumb-images-open").click()
        view = page.locator("#thumb-images-view"); cards = self.ready(view, 12)
        sops = cards.evaluate_all("xs=>xs.map(x=>x.dataset.sop)")
        self.assertEqual(12, len(set(sops))); self.assertEqual(["0"] * 12, cards.evaluate_all("xs=>xs.map(x=>x.dataset.frame)"))
        expect(view.locator("#thumb-images-page")).to_contain_text("2 ·")
        print("IMAGE THUMBNAILS native identities", {"multiframe": multi["sops"][0], "multiinstance_first": sops[0], "series": other_label}, flush=True)
        self.assertEqual(originals, self.originals()); self.assertEqual(rows, self.report_rows(f)); self.assertEqual([], writes)

    def test_image_thumbnails_02_exact_preview_frame_back_and_report_hold_preservation(self):
        f = self.ct("IMAGE-THUMBS-" + uuid.uuid4().hex[:12], "current", "20260801")
        multi = CineE2E.series(self, f, 14, "IMAGE THUMBNAILS preview")
        self.seed_report(f); values = {"findings": "Image grid unsaved finding", "conclusion": "Preserved conclusion", "recommendation": "Preserved recommendation"}
        self.assertEqual(200, self.stack.request("PUT", f"/studies/{f.uid}/report", "doctor", dict(values, baseVersion=1)).status)
        self.assertEqual(201, self.stack.request("POST", f"/studies/{f.uid}/hold", "doctor").status)
        originals = self.originals(); rows = self.report_rows(f); page = self.login(); writes = self.source_writes(page); self.select(page, f); self.thumbs(page)
        expect(page.locator("#findings")).to_have_value(values["findings"])
        view = self.open_images(page, multi["label"]); cards = self.ready(view, 12)
        cards.nth(7).locator(".thumb-image-open").click(); dialog = page.locator("#worklist-image-preview")
        expect(dialog.locator("[data-status]")).to_contain_text("Rendered", timeout=25000)
        expect(dialog.locator("[data-position]")).to_contain_text(f"8 / 14 · SOP {multi['sops'][0]} · Frame 8 / 14")
        lookup = self.stack.request("POST", "/dicom/lookup", "doctor", {"studyUid": f.uid, "sopUid": multi["sops"][0]})
        self.assertEqual(201, lookup.status)
        expected = page.request.get(self.stack.proxy + f"/instances/{lookup.body['id']}/frames/7/rendered?width=1024&height=1024", headers={"Accept": "image/png"})
        self.assertEqual(200, expected.status)
        np.testing.assert_array_equal(self.pixels(dialog.locator('img')), np.asarray(Image.open(io.BytesIO(expected.body())).convert('RGB')))
        dialog.locator("[data-close]").click(); view.locator("#thumb-images-back").click(); self.thumbs(page)
        expect(page.locator("#findings")).to_have_value(values["findings"])
        self.assertEqual(self.stack.actor("doctor"), self.state(f)["holder"])
        self.assertEqual(originals, self.originals()); self.assertEqual(rows, self.report_rows(f)); self.assertEqual([], writes)

    def test_image_thumbnails_03_failure_retry_and_late_source_are_isolated(self):
        patient = "IMAGE-THUMBS-" + uuid.uuid4().hex[:12]
        current = self.ct(patient, "current", "20260801"); multi = CineE2E.series(self, current, 14, "IMAGE THUMBNAILS delayed")
        related = self.ct(patient, "future", "20260907"); originals = self.originals(); page = self.login(); writes = self.source_writes(page); self.select(page, current); self.thumbs(page)
        held = []; pattern = "**/frames/*/rendered?width=256&height=256"
        page.route(pattern, lambda route: held.append(route)); view = self.open_images(page, multi["label"])
        deadline = time.monotonic() + 5
        while len(held) < 4 and time.monotonic() < deadline: page.wait_for_timeout(50)
        self.assertEqual(4, len(held))
        self.related(page, related).click(); expect(page.locator("#thumb-images-view")).to_have_count(0)
        for route in held:
            try: route.fulfill(response=route.fetch())
            except PlaywrightError: pass
        page.unroute(pattern); page.wait_for_timeout(300); self.assertEqual(0, page.locator("#thumb-images-view img").count())

        page.locator("#related-return").click(); self.thumbs(page); failed = {"done": False}
        def deny(route):
            if not failed["done"]: failed["done"] = True; route.fulfill(status=403, body="denied")
            else: route.continue_()
        page.route(pattern, deny); view = self.open_images(page, multi["label"])
        expect(view.locator("#thumb-images-status")).to_contain_text("일부 요청이 중단됐습니다.", timeout=25000)
        expect(view.locator(".thumb-image-preview").filter(has_text="Retry Images").first).to_be_visible()
        page.unroute(pattern); view.locator("#thumb-images-retry").click(); self.ready(view, 12)
        self.assertEqual(originals, self.originals()); self.assertEqual([], writes)

    def test_image_thumbnails_04_keyboard_narrow_layout_and_literal_metadata(self):
        literal = 'Literal <img onerror="window.imageThumbInjected=1"> & Series'
        f = self.ct("IMAGE-THUMBS-" + uuid.uuid4().hex[:12], "current", "20260801")
        CineE2E.series(self, f, 14, literal); originals = self.originals(); page = self.login(); page.set_viewport_size({"width": 390, "height": 700})
        self.select(page, f); self.thumbs(page); card = page.locator("#thumbwrap .thumb-card").filter(has_text=literal)
        entry = card.locator(".thumb-images-open"); expect(entry).to_be_enabled(); entry.focus(); entry.press("Enter")
        view = page.locator("#thumb-images-view"); cards = self.ready(view, 12)
        expect(view.locator("#thumb-images-series")).to_contain_text(literal)
        self.assertIsNone(page.evaluate("window.imageThumbInjected"))
        for selector in ("#thumb-images-back", "#thumb-images-order", "#thumb-images-retry", "#thumb-images-prev", "#thumb-images-next", ".thumb-image-open"):
            control = view.locator(selector).first; control.scroll_into_view_if_needed(); expect(control).to_be_in_viewport()
        expect(view.locator("#thumb-images-prev")).to_be_disabled()
        for selector in ("#thumb-images-back", "#thumb-images-order", "#thumb-images-retry", "#thumb-images-next", ".thumb-image-open"):
            expect(view.locator(selector).first).to_be_enabled()
        dimensions = view.evaluate("e=>({client:e.clientWidth,scroll:e.scrollWidth})")
        self.assertLessEqual(dimensions["scroll"], dimensions["client"] + 1)
        folder = Path(__file__).parent / "artifacts"; folder.mkdir(exist_ok=True)
        page.screenshot(path=str(folder / "IMAGE-THUMBNAILS-narrow-literal.png"), full_page=True)
        cards.first.locator(".thumb-image-open").focus(); cards.first.locator(".thumb-image-open").press("Enter")
        expect(page.locator("#worklist-image-preview [data-status]")).to_contain_text("Rendered", timeout=25000)
        page.locator("#worklist-image-preview [data-close]").click(); view.locator("#thumb-images-back").focus(); view.locator("#thumb-images-back").press("Enter")
        self.thumbs(page); self.assertEqual(0, page.locator("#thumb-images-view").count())
        self.assertEqual(originals, self.originals())


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ImageThumbnailsE2E(name) for name in ImageThumbnailsE2E.__dict__ if name.startswith("test_image_thumbnails_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
