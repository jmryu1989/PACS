"""U5S-REQ-08 -> U5S-RISK-SESSION -> default shared-fixture binding assertion.

Each child deliberately issues an unbound protected browser request. It must fail
without a caller opting into an assertion, including when it overrides routing.
"""
from pathlib import Path
import subprocess
import sys
import unittest

CASES = {
    'srcset': "const e=new Image();document.body.append(e);e.srcset='/instances/unbound 1x'",
    'picture': "document.body.innerHTML='<picture><source srcset=\"/instances/unbound\"><img></picture>'",
    'css': "document.body.style.backgroundImage='url(/instances/unbound)'",
    'svg': "const e=document.createElementNS('http://www.w3.org/2000/svg','svg');e.innerHTML='<image href=\"/instances/unbound\" width=\"20\" height=\"20\"/>';document.body.append(e)",
    'namespace': "const e=new Image();document.body.append(e);e.setAttributeNS(null,'src','/instances/unbound')",
    'parser': "document.body.innerHTML='<img src=\"/instances/unbound\">'",
}


def violate(name):
    from playwright.sync_api import sync_playwright
    from viewer_session_fixture import install_viewer_session
    with sync_playwright() as pw:
        browser=pw.chromium.launch();page=browser.new_page()
        page.route('**/*',lambda route:route.fulfill(body='<body></body>',content_type='text/html'))
        page.goto('https://resource-guard.test/ohif/viewer')
        install_viewer_session(page)  # Intentionally ignore the returned failure list.
        page.route('**/instances/**',lambda route:route.fulfill(body='bad image'))
        page.evaluate('()=>{'+CASES[name]+'}')
        page.wait_for_timeout(250)
        browser.close()


class ViewerResourceGuardDOMTest(unittest.TestCase):
    def test_resource_auth_refusal_classification_and_recovery(self):
        from playwright.sync_api import sync_playwright
        from viewer_session_fixture import install_viewer_session
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page()
            page.route('**/*', lambda route: route.fulfill(body='<body></body>', content_type='text/html'))
            page.goto('https://resource-guard.test/ohif/viewer')
            install_viewer_session(page)
            for status in (401, 403):
                for code in ('AUTH_IDP_UNAVAILABLE', 'AUTH_SESSION_BUSY', 'AUTH_STORAGE_FAILURE', None):
                    with self.subTest(status=status, code=code):
                        page.route('**/instances/refused', lambda route: route.fulfill(status=status,
                            headers={'X-KIN-Auth-Code': code} if code else {}, body=''))
                        result = page.evaluate("""async()=>{
                          try { await KinViewerResource.read('/instances/refused'); return null; }
                          catch(error) { return {message:error.message,retryable:error.retryable,state:KinWorkContext.state()}; }
                        }""")
                        self.assertEqual(result['state'], 'active')
                        self.assertEqual(result['retryable'], bool(code))
                        if code:
                            self.assertIn('연결을 확인하지 못했습니다', result['message'])
                            self.assertNotIn('거절', result['message'])
                        else:
                            self.assertIn('접근이 거절', result['message'])
            browser.close()

    def detects(self, name):
        result=subprocess.run([sys.executable,'-B',str(Path(__file__).resolve()),'--violate',name],
                              capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=30)
        log=result.stdout+result.stderr
        print(f'{name}: exit {result.returncode}\n{log}',flush=True)
        self.assertNotEqual(result.returncode,0,log)
        self.assertIn('AssertionError: Unbound protected request: https://resource-guard.test/instances/unbound',log)

    def test_srcset_fails_by_default(self): self.detects('srcset')
    def test_picture_fails_by_default(self): self.detects('picture')
    def test_css_url_fails_by_default(self): self.detects('css')
    def test_svg_href_fails_by_default(self): self.detects('svg')
    def test_set_attribute_ns_fails_by_default(self): self.detects('namespace')
    def test_parser_created_element_fails_by_default(self): self.detects('parser')


if __name__=='__main__':
    if sys.argv[1:2]==['--violate']: violate(sys.argv[2])
    else: unittest.main(verbosity=2)
