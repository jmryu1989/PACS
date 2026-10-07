"""U5S-REQ-04/08 -> U5S-RISK-SESSION -> clinician's real opener-less handoff.

Reuse only the synthetic list/report fixture; load the shipped clinician, auth and
viewer boundary. This suite explicitly selects its own tests, not the parent suite.
"""
import unittest
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
try:
    import clinician_home_dom_test as home
except ImportError:
    from tests import clinician_home_dom_test as home

ROOT = Path(__file__).resolve().parents[1]


class ViewerClinicianEntryDOMTest(home.ClinicianHomeDOMTest):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    def route(self, route):
        path = urlparse(route.request.url).path
        if path == '/ohif/viewer':
            route.fulfill(body='<div id="root"></div><script src="/config.js"></script><script>'
                          'config.extensions[0].preRegistration().then(()=>window.started=true)</script>',content_type='text/html; charset=utf-8')
        elif path == '/config.js':
            route.fulfill(body=(ROOT/'config/ohif.js').read_text(encoding='utf-8'),content_type='application/javascript; charset=utf-8')
        elif path.startswith('/worklist/hpacs-lite/') and path.endswith('.js'):
            route.fulfill(body=(ROOT/'worklist-v0/hpacs-lite'/path.rsplit('/',1)[1]).read_text(encoding='utf-8'),content_type='application/javascript; charset=utf-8')
        else:
            super().route(route)

    def test_real_clinician_view_opens_verified_noopener_with_one_click(self):
        self.open_home(); self.pick(1)
        with self.context.expect_page() as opened:
            self.page.get_by_role('button',name='Open Viewer',exact=True).click()
        viewer=opened.value
        viewer.wait_for_function('window.started===true')
        self.assertEqual(viewer.evaluate('KinWorkContext.session()'),self.page.evaluate('KinAuth.sessionId()'))
        self.assertIsNone(viewer.evaluate('opener'))
        self.assertNotIn('kin-viewer-entry:',viewer.evaluate('window.name'))
        self.assertNotIn(self.page.evaluate('KinAuth.sessionId()'),viewer.url)
        expect(viewer.get_by_role('alert')).to_have_count(0)
        viewer.reload(); viewer.wait_for_function('window.started===true')
        self.assertEqual(viewer.evaluate('KinWorkContext.session()'),self.page.evaluate('KinAuth.sessionId()'))


def load_tests(loader, tests, pattern):
    return unittest.TestSuite([ViewerClinicianEntryDOMTest('test_real_clinician_view_opens_verified_noopener_with_one_click')])


if __name__ == '__main__':
    unittest.main(verbosity=2)
