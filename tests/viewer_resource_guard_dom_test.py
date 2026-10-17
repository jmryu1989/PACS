"""U5S-REQ-08 -> U5S-RISK-SESSION -> default shared-fixture binding assertion.

Each child deliberately issues an unbound protected browser request. It must fail
without a caller opting into an assertion, including when it overrides routing.

U4BL6-04: a child records two facts apart - that the protected request actually left the
page (a marker line, from a listener added before the guard's) and that the guard refused
it (the guard's own AssertionError) - and waits for the request itself, not a fixed time.
Only both together are a guard kill; a request that never happened, or a browser failure,
is reported as such and never counted as a kill or as a pass. Two controls keep the
reading honest: a bound request passes the guard, and a child without the guard sends the
same request and is not a kill.
"""
from pathlib import Path
import subprocess
import sys
import time
import unittest
from urllib.parse import urlparse

CASES = {
    'srcset': "const e=new Image();document.body.append(e);e.srcset='/instances/unbound 1x'",
    'picture': "document.body.innerHTML='<picture><source srcset=\"/instances/unbound\"><img></picture>'",
    'css': "document.body.style.backgroundImage='url(/instances/unbound)'",
    'svg': "const e=document.createElementNS('http://www.w3.org/2000/svg','svg');e.innerHTML='<image href=\"/instances/unbound\" width=\"20\" height=\"20\"/>';document.body.append(e)",
    'namespace': "const e=new Image();document.body.append(e);e.setAttributeNS(null,'src','/instances/unbound')",
    'parser': "document.body.innerHTML='<img src=\"/instances/unbound\">'",
}
# The bound control: the same protected path, sent with the session binding the guard asks for.
BOUND = "fetch('/instances/bound',{headers:{'X-KIN-Session':'S1'}}).catch(()=>{})"
SEEN = 'PROTECTED-REQUEST-SEEN '
MISSING = 'PROTECTED-REQUEST-MISSING'
GUARD = 'AssertionError: Unbound protected request: https://resource-guard.test/instances/unbound'
REQUEST_WAIT_MS = 10000


def violate(name, guarded=True):
    from playwright.sync_api import sync_playwright
    from viewer_session_fixture import install_viewer_session
    script, path = (BOUND, '/instances/bound') if name == 'bound' else (CASES[name], '/instances/unbound')
    seen = []

    def record(request):
        if urlparse(request.url).path == path:
            seen.append(request.url)
            print(SEEN + request.url, flush=True)
    with sync_playwright() as pw:
        browser=pw.chromium.launch();page=browser.new_page()
        page.route('**/*',lambda route:route.fulfill(body='<body></body>',content_type='text/html'))
        page.goto('https://resource-guard.test/ohif/viewer')
        # Added before the guard's own listener: the request is on record before the guard refuses it (a listener that
        # raises stops the listeners after it, so nothing after the guard's could tell).
        page.on('request', record)
        if guarded:
            install_viewer_session(page)  # Intentionally ignore the returned failure list.
        page.route('**/instances/**',lambda route:route.fulfill(body='bad image'))
        page.evaluate('()=>{'+script+'}')
        # Wait for the request itself (bounded), never a fixed time. The guard's refusal, raised in its listener, surfaces
        # at a call into the browser - this wait or the call below - and ends the child with its AssertionError.
        deadline = time.monotonic() + REQUEST_WAIT_MS / 1000
        while not seen and time.monotonic() < deadline:
            page.wait_for_timeout(20)
        if not seen:
            print(MISSING, flush=True)
            browser.close()
            sys.exit(3)
        page.evaluate('()=>0')
        browser.close()


def classify(code, log):
    """'killed' (the request left the page and the guard refused it), 'missing' (no request: not a kill, not a pass),
    'passed' (the request left and nothing refused it) or 'failed' (the child ended otherwise)."""
    seen = SEEN in log
    if MISSING in log or not seen:
        return 'missing'
    if code != 0 and GUARD in log:
        return 'killed'
    return 'passed' if code == 0 else 'failed'


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

    def child(self, *args):
        result=subprocess.run([sys.executable,'-B',str(Path(__file__).resolve()),*args],
                              capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=60)
        log=result.stdout+result.stderr
        print(f'{" ".join(args)}: exit {result.returncode}\n{log}',flush=True)
        return classify(result.returncode, log), log

    def detects(self, name):
        verdict, log = self.child('--violate', name)
        self.assertNotEqual('missing', verdict, 'the protected request never left the page - not a guard kill:\n' + log)
        self.assertEqual('killed', verdict, log)

    def test_srcset_fails_by_default(self): self.detects('srcset')
    def test_picture_fails_by_default(self): self.detects('picture')
    def test_css_url_fails_by_default(self): self.detects('css')
    def test_svg_href_fails_by_default(self): self.detects('svg')
    def test_set_attribute_ns_fails_by_default(self): self.detects('namespace')
    def test_parser_created_element_fails_by_default(self): self.detects('parser')

    def test_controls_tell_a_kill_from_a_pass_and_from_a_missing_request(self):
        # A bound request passes the guard; the same unbound request without the guard is sent and passes - neither is a kill.
        self.assertEqual('passed', self.child('--violate', 'bound')[0])
        self.assertEqual('passed', self.child('--unguarded', 'css')[0])
        # The reading itself: no marker is 'missing' whatever the exit, a refusal without the request is no kill.
        self.assertEqual('missing', classify(1, GUARD))
        self.assertEqual('missing', classify(3, MISSING))
        self.assertEqual('failed', classify(1, SEEN + 'https://resource-guard.test/instances/unbound\nTargetClosedError'))


if __name__=='__main__':
    if sys.argv[1:2]==['--violate']: violate(sys.argv[2])
    elif sys.argv[1:2]==['--unguarded']: violate(sys.argv[2], guarded=False)
    else: unittest.main(verbosity=2)
