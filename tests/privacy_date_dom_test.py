"""REQ-LEGAL-D11 -> RISK-PRIVACY-WRONG-EFFECTIVE-DATE -> TEST-PRIVACY-DATE.

Isolated Chromium, local assets fulfilled in memory, no server or live stack.
Assert the text a reader sees and its statutory scope, independent of DOM shape.
"""
from datetime import datetime
from pathlib import Path
import os
import sys
import unittest
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PAGES = Path(os.environ.get('KIN_TEST_LEGAL_PAGES', ROOT / 'worklist-v0/legal'))


class PrivacyDateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def open_page(self, instant, timezone='Asia/Seoul', javascript=True):
        context = self.browser.new_context(timezone_id=timezone, java_script_enabled=javascript)
        self.addCleanup(context.close)
        page = context.new_page()
        def asset(route):
            parsed = urlsplit(route.request.url)
            name = Path(parsed.path).name
            if parsed.netloc == 'legal.invalid' and name in {'privacy.html', 'privacy-date.js', 'legal.css'}:
                mime = 'text/html' if name.endswith('.html') else ('text/javascript' if name.endswith('.js') else 'text/css')
                route.fulfill(body=(PAGES / name).read_bytes(), content_type=mime)
            else:
                route.abort()
        page.route('**/*', asset)
        if javascript:
            page.clock.install(time=datetime.fromisoformat(instant))
            page.clock.pause_at(datetime.fromisoformat(instant))
        page.goto('https://legal.invalid/worklist/legal/privacy.html')
        return page

    def assert_old(self, page):
        text = page.locator('main').inner_text()
        self.assertIn('개인정보취급자의 접속기록', text)
        self.assertNotIn('접속한 자(정보주체 제외)', text)
        self.assertIn('제8조①② 종전 문언: 2026-10-31까지 적용', text)
        self.assertIn('월 1회 이상 점검', text)
        self.assertIn('환자영상 자체의 보유기간은 위 표에서 별도로 정합니다.', text)
        self.assertIn('2년 이상', text)

    def assert_amended(self, page):
        text = page.locator('main').inner_text()
        self.assertIn('접속한 자(정보주체 제외)의 접속기록', text)
        self.assertNotIn('개인정보취급자', text)
        self.assertIn('제8조①② 개정 문언: 2026-11-01부터 적용', text)
        self.assertIn('내부 관리계획에서 정한 주기와 방법에 따라 점검', text)
        self.assertIn('다운로드 사유 확인', text)
        self.assertIn('환자영상 자체의 보유기간은 위 표에서 별도로 정합니다.', text)
        self.assertIn('2년 이상', text)
        self.assertNotIn('시행 2026-07-01', text)

    def test_october_31_2359_and_last_millisecond_keep_old_wording(self):
        for time in ['2026-10-31T23:59:00+09:00', '2026-10-31T23:59:59.999+09:00']:
            with self.subTest(time=time):
                self.assert_old(self.open_page(time))

    def test_november_1_midnight_uses_amended_wording(self):
        self.assert_amended(self.open_page('2026-11-01T00:00:00+09:00'))

    def test_kst_boundary_does_not_depend_on_browser_timezone(self):
        for timezone in ['UTC', 'America/Los_Angeles']:
            with self.subTest(timezone=timezone):
                self.assert_old(self.open_page('2026-10-31T14:59:00+00:00', timezone))
                self.assert_amended(self.open_page('2026-10-31T15:00:00+00:00', timezone))

    def test_open_page_switches_at_midnight(self):
        page = self.open_page('2026-10-31T23:59:00+09:00')
        self.assert_old(page)
        page.clock.run_for(60000)
        self.assert_amended(page)

    def test_without_script_both_periods_remain_readable(self):
        page = self.open_page('2026-11-01T00:00:00+09:00', javascript=False)
        text = page.locator('main').inner_text()
        self.assertIn('2026-10-31까지 종전 문언', text)
        self.assertIn('2026-11-01부터 개정 문언 적용', text)
        self.assertIn('접속한 자(정보주체 제외, 2026-11-01부터)', text)
        self.assertIn('확정 전', text)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(verbosity=2)
