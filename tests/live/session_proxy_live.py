"""U5S-REQ-08/12 -> U5S-RISK-SESSION -> U5S-TEST-S12.

Real nginx auth_request, cookie BFF, Orthanc and browser-visible response headers.
Explicit repeated/ranged requests test the wire boundary, not OHIF's retry implementation.
"""
import sys
from pathlib import Path
import unittest

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from session_support import Session, setup_stack


class SessionProxyLive(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        setup_stack(cls)
        cls.pw = sync_playwright().start()
        cls.addClassCleanup(cls.pw.stop)
        cls.browser = cls.pw.chromium.launch()
        cls.addClassCleanup(cls.browser.close)

    def test_s12_all_protected_locations_binding_and_browser_headers(self):
        fixture = self.stack.create_fixture()
        session = Session(self.stack).login(self, "jmryu")
        other = Session(self.stack).login(self, "doctor2")
        instance = self.stack.first_instance_id(fixture.uid)
        paths = [f"/dicom-web/studies/{fixture.uid}",
                 f"/dicom-web/studies/{fixture.uid}/series",
                 f"/instances/{instance}/simplified-tags", "/statistics", "/system"]
        context = self.browser.new_context(ignore_https_errors=True)
        self.addCleanup(context.close)
        context.add_cookies([{"name": "kin_sid", "value": session.sid(), "url": self.stack.proxy,
                              "httpOnly": True, "secure": True, "sameSite": "Strict"}])
        page = context.new_page()
        page.goto(self.stack.proxy + "/api/health")

        def get(path, binding, ranged=False):
            return page.evaluate("""async ({path,binding,ranged}) => {
              const headers = {Accept: '*/*'};
              if (binding !== null) headers['X-KIN-Session'] = binding;
              if (ranged) headers.Range = 'bytes=0-127';
              const r = await fetch(path, {headers});
              await r.arrayBuffer();
              return {status:r.status, code:r.headers.get('X-KIN-Auth-Code')};
            }""", {"path": path, "binding": binding, "ranged": ranged})

        for path in paths:
            with self.subTest(path=path):
                for _ in range(2):
                    self.assertEqual(get(path, session.session), {"status": 200, "code": None})
                self.assertEqual(get(path, None), {"status": 403, "code": "AUTH_SESSION_REQUIRED"})
                self.assertEqual(get(path, other.session), {"status": 403, "code": "AUTH_SESSION_MISMATCH"})
        for _ in range(2):
            ranged = get(f"/instances/{instance}/file", session.session, True)
            self.assertIn(ranged["status"], (200, 206))
            self.assertIsNone(ranged["code"])
            self.assertEqual(get(f"/instances/{instance}/file", other.session, True),
                             {"status": 403, "code": "AUTH_SESSION_MISMATCH"})

        # A role denial remains distinguishable from the binding mismatch above.
        ordinary = other.call("GET", "/system", headers={"X-KIN-Session": other.session})
        self.assertEqual(ordinary[0], 403)
        self.assertFalse(any(k.lower() == "x-kin-auth-code" for k in ordinary[1]))
        before = next(c["value"] for c in context.cookies() if c["name"] == "kin_sid")
        self.assertEqual(session.json("POST", "/api/auth/logout")[0], 204)
        for path in paths:
            with self.subTest(ended=path):
                self.assertEqual(get(path, session.session), {"status": 401, "code": "AUTH_SESSION_ENDED"})
        self.assertEqual(next(c["value"] for c in context.cookies() if c["name"] == "kin_sid"), before)
        self.assertEqual(other.json("GET", "/api/me")[0], 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
