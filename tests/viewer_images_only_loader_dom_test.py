# coding: utf-8
"""Isolated Chromium coverage for the actual Images Only config loader."""
from pathlib import Path
import time
import unittest

from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CONFIG = (ROOT / "config" / "ohif.js").read_text(encoding="utf-8")
URL = "https://images-only.test/ohif/viewer?StudyInstanceUIDs=1.2.1"


def extract_function(source, name):
    start = source.index(f"function {name}(")
    brace = source.index("{", start)
    depth, quote, escaped = 0, None, False
    for index in range(brace, len(source)):
        char = source[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in "'\"`":
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise ValueError(name)


FACTORY = extract_function(CONFIG, "kinCreateImagesOnly") + ";window.imagesOnlyExtension=kinCreateImagesOnly();"
HARNESS = """<!doctype html><html><head></head><body>
<main id="kin-viewer-layout"></main><p id="kin-viewer-layout-status"></p>
<script>
window.services={marker:'actual services'};
window.enterImagesOnly=()=>imagesOnlyExtension.onModeEnter({servicesManager:{services}});
</script></body></html>"""
FAKE_MODULE = """(()=>{
 window.imagesOnlyCalls ||= {creates:0,mounts:0,stops:0,services:[]};
 window.KinViewerImagesOnly={create(value){imagesOnlyCalls.creates++;imagesOnlyCalls.services.push(value);
   return {mount(){imagesOnlyCalls.mounts++;return true},stop(){imagesOnlyCalls.stops++}};
 }};
})()"""
CAPTURE_TIMEOUT_MS = 10_000


class ViewerImagesOnlyLoaderDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def new_page(self):
        page = self.browser.new_page()
        page.route(URL, lambda route: route.fulfill(body=HARNESS, content_type="text/html; charset=utf-8"))
        page.goto(URL)
        page.add_script_tag(content=FACTORY)
        return page

    @staticmethod
    def hold_module(page):
        held = []
        page.route("https://images-only.test/worklist/hpacs-lite/viewer-images-only.js",
                   lambda route: held.append(route))
        return held

    def wait_for_capture(self, page, held, count=1):
        # The script element exists before Chromium issues the request, so waiting on the DOM tag
        # can leave `held` empty; wait for the route handler itself. Sync-API handlers run on this
        # thread while page.wait_for_timeout blocks, so the poll lets them fire.
        deadline = time.monotonic() + CAPTURE_TIMEOUT_MS / 1000
        while len(held) < count:
            if time.monotonic() >= deadline:
                self.fail(f"viewer-images-only.js route captured {len(held)}/{count} request(s) "
                          f"within {CAPTURE_TIMEOUT_MS}ms")
            page.wait_for_timeout(10)
        return held

    def test_mode_exit_while_script_is_late_never_mounts_stale_controller(self):
        page = self.new_page()
        held = self.hold_module(page)
        try:
            page.evaluate("enterImagesOnly()")
            page.wait_for_function("()=>document.querySelectorAll('script[src*=viewer-images-only]').length===1")
            self.wait_for_capture(page, held)
            page.evaluate("imagesOnlyExtension.onModeExit()")
            held.pop().fulfill(body=FAKE_MODULE, content_type="application/javascript")
            page.wait_for_function("()=>!!window.imagesOnlyCalls")
            self.assertEqual({"creates": 0, "mounts": 0, "stops": 0}, page.evaluate(
                "()=>({creates:imagesOnlyCalls.creates,mounts:imagesOnlyCalls.mounts,stops:imagesOnlyCalls.stops})"))
        finally:
            for route in held:
                try:
                    route.abort()
                except PlaywrightError:
                    pass
            page.close()

    def test_session_end_before_load_blocks_late_mount_and_every_reentry(self):
        page = self.new_page()
        held = self.hold_module(page)
        try:
            page.evaluate("enterImagesOnly()")
            page.wait_for_function("()=>document.querySelectorAll('script[src*=viewer-images-only]').length===1")
            self.wait_for_capture(page, held)
            page.evaluate("dispatchEvent(new StorageEvent('storage',{key:'kin-session-ended'}))")
            held.pop().fulfill(body=FAKE_MODULE, content_type="application/javascript")
            page.wait_for_function("()=>!!window.imagesOnlyCalls")
            page.evaluate("enterImagesOnly()")
            page.wait_for_function("()=>!!window.imagesOnlyCalls")
            self.assertEqual({"creates": 0, "mounts": 0, "stops": 0}, page.evaluate(
                "()=>({creates:imagesOnlyCalls.creates,mounts:imagesOnlyCalls.mounts,stops:imagesOnlyCalls.stops})"))
        finally:
            for route in held:
                try:
                    route.abort()
                except PlaywrightError:
                    pass
            page.close()

    def test_rapid_mode_enters_share_load_and_only_latest_ticket_mounts(self):
        page = self.new_page()
        held = self.hold_module(page)
        try:
            page.evaluate("enterImagesOnly();enterImagesOnly()")
            page.wait_for_function("()=>document.querySelectorAll('script[src*=viewer-images-only]').length===1")
            self.wait_for_capture(page, held)
            self.assertEqual(1, len(held))
            held.pop().fulfill(body=FAKE_MODULE, content_type="application/javascript")
            page.wait_for_function("()=>window.imagesOnlyCalls?.mounts===1")
            self.assertEqual({"creates": 1, "mounts": 1, "stops": 0, "sameServices": True}, page.evaluate(
                "()=>({creates:imagesOnlyCalls.creates,mounts:imagesOnlyCalls.mounts,stops:imagesOnlyCalls.stops,"
                "sameServices:imagesOnlyCalls.services[0]===services})"))
        finally:
            for route in held:
                try:
                    route.abort()
                except PlaywrightError:
                    pass
            page.close()

    def test_reentry_stops_current_and_mount_failure_stops_candidate_and_is_visible(self):
        page = self.new_page()
        try:
            page.evaluate("""()=>{window.imagesOnlyCalls={creates:0,mounts:0,stops:[]};
              window.KinViewerImagesOnly={create(){const id=++imagesOnlyCalls.creates;return {
                mount(){imagesOnlyCalls.mounts++;return id===1},stop(){imagesOnlyCalls.stops.push(id)}}}}}""")
            page.evaluate("enterImagesOnly()")
            page.wait_for_function("()=>imagesOnlyCalls.mounts===1")
            page.evaluate("enterImagesOnly()")
            expect(page.locator("#kin-viewer-layout-status")).to_have_text("Images Only 패널을 연결하지 못했습니다.")
            self.assertEqual({"creates": 2, "mounts": 2, "stops": [1, 2]}, page.evaluate("imagesOnlyCalls"))
        finally:
            page.close()


if __name__ == "__main__":
    unittest.main()
