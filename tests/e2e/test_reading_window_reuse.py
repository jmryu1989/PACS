# coding: utf-8
"""TEST-D-WORKSPACE-WINDOW: named viewer reuse, unsaved guard, and saved placement."""
import re
import sys
import unittest
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect

from test_prior_selection import canvas_ready
from test_reading_workspace import ReadingWorkspaceE2E


class ReadingWindowReuseE2E(ReadingWorkspaceE2E):
    def open_separate(self, page, fixture):
        frame = self.workspace(page, fixture)
        with page.context.expect_page() as opened:
            page.get_by_role("button", name="영상 새 창", exact=True).click()
        popup = opened.value
        popup.wait_for_url("**/ohif/viewer?**")
        canvas_ready(popup, 2)
        return frame, popup

    def test_named_window_reuse_keeps_or_guards_existing_work(self):
        current, past = self.pair()
        page = self.login()
        page.set_viewport_size(dict(width=1680, height=1100))
        _, popup = self.open_separate(page, current)
        original_popup = popup

        expect(popup.locator("#kin-viewer-jobs-status")).to_contain_text("목록입니다", timeout=45000)
        clean_event = popup.evaluate("""() => {
          const event = new Event('beforeunload', { cancelable: true });
          window.dispatchEvent(event);
          return event.defaultPrevented;
        }""")
        self.assertFalse(clean_event)
        popup.get_by_label("작업 제목", exact=True).fill("KEEP SEPARATE WINDOW")
        event = popup.evaluate("""() => {
          const event = new Event('beforeunload', { cancelable: true });
          window.dispatchEvent(event);
          return { prevented: event.defaultPrevented, state: window.kinViewerJobWorkspaceState() };
        }""")
        self.assertTrue(event["prevented"])
        self.assertTrue(event["state"]["dirty"])

        self.choose(page, past)
        expect(page.locator("#reading-status")).to_have_text("영상 작업공간 연결됨", timeout=60000)
        page.get_by_role("button", name="영상 새 창", exact=True).click()
        expect(page.locator("#toast")).to_contain_text("저장하지 않은 표식이나 작업 내용")
        self.assertEqual(parse_qs(urlsplit(popup.url).query)["StudyInstanceUIDs"], [current.uid + "," + past.uid])
        expect(popup.get_by_label("작업 제목", exact=True)).to_have_value("KEEP SEPARATE WINDOW")

        popup.get_by_label("작업 제목", exact=True).fill("")
        popup.evaluate("""() => {
          window.__kinOriginalJobState = window.kinViewerJobWorkspaceState;
          window.kinViewerJobWorkspaceState = () => ({busy: true, dirty: false});
        }""")
        page.get_by_role("button", name="영상 새 창", exact=True).click()
        expect(page.locator("#toast")).to_contain_text("저장·복원 또는 상태 확인")
        self.assertEqual(parse_qs(urlsplit(popup.url).query)["StudyInstanceUIDs"], [current.uid + "," + past.uid])
        popup.evaluate("window.kinViewerJobWorkspaceState = window.__kinOriginalJobState")
        page.get_by_role("button", name="영상 새 창", exact=True).click()
        expect(popup).to_have_url(re.compile(r"[?&]StudyInstanceUIDs=" + re.escape(past.uid) + r"(?:[&#]|$)"), timeout=60000)
        canvas_ready(popup, 1)
        self.assertIs(popup, original_popup)
        self.assertEqual(parse_qs(urlsplit(popup.url).query)["StudyInstanceUIDs"], [past.uid])

        navigations = []
        popup.on("request", lambda request: navigations.append(request.url) if request.is_navigation_request() else None)
        popup.evaluate("window.__kinSameScopeMarker = 'preserved'")
        page.get_by_role("button", name="영상 새 창", exact=True).click()
        popup.wait_for_timeout(500)
        self.assertEqual(popup.evaluate("window.__kinSameScopeMarker"), "preserved")
        self.assertEqual(navigations, [])
        popup.close()

    def test_saved_window_rect_is_used_for_a_new_named_window(self):
        current, _ = self.pair()
        page = self.login()
        self.choose(page, current)
        result = page.evaluate("""uid => {
          localStorage.setItem('kin.ohif.current.rect', JSON.stringify({left:123, top:145, width:900, height:700}));
          const calls = [];
          window.open = () => {
            let openerValue = 'initial';
            const popup = {
              closed: false, location: { href: 'about:blank' },
              document: { visibilityState: 'visible' },
              screenX: 0, screenY: 0, outerWidth: 0, outerHeight: 0,
              focus() { calls.push(['focus']); },
              moveTo(left, top) { this.screenX = left; this.screenY = top; calls.push(['move', left, top]); },
              resizeTo(width, height) { this.outerWidth = width; this.outerHeight = height; calls.push(['resize', width, height]); },
            };
            Object.defineProperty(popup, 'opener', {
              get() { return openerValue; },
              set(value) { openerValue = value; calls.push(['opener', value]); },
            });
            popup.openerValue = () => openerValue;
            window.__kinFakePopup = popup;
            return popup;
          };
          openOhifWindow(uid);
          const popup = window.__kinFakePopup;
          popup.closed = true;
          return { calls, href: popup.location.href, opener: popup.openerValue(),
            stored: JSON.parse(localStorage.getItem('kin.ohif.current.rect')) };
        }""", current.uid)
        self.assertIn(["move", 123, 145], result["calls"])
        self.assertIn(["resize", 900, 700], result["calls"])
        self.assertEqual(result["stored"], dict(left=123, top=145, width=900, height=700))
        self.assertIn(current.uid, result["href"])
        self.assertIsNone(result["opener"])


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ReadingWindowReuseE2E(name) for name in ReadingWindowReuseE2E.__dict__
                              if name.startswith("test_"))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    result = unittest.TextTestRunner(verbosity=2).run(load_tests(None, None, None))
    sys.exit(not result.wasSuccessful())
