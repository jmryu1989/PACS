"""Observe the real closed viewer through a same-origin, test-owned observer.

No product close/navigation function is replaced. Retained references let teardown
assertions inspect resources and late completions after the original window closes.
"""


class EndedViewer:
    def __init__(self, observer):
        self.observer = observer

    def evaluate(self, expression, arg=None):
        # Playwright compiles this test expression in its evaluation world. No
        # eval() runs in the product, whose CSP deliberately disallows it.
        return self.observer.evaluate("arg => { with (viewerSource) { const read = (" + expression
                                      + "); return typeof read === 'function' ? read(arg) : read; } }", arg)

    def wait_for_function(self, expression, arg=None, timeout=20000):
        self.observer.wait_for_function("arg => { with (viewerSource) { return (" + expression + ")(arg); } }",
                                        arg=arg, timeout=timeout)

    def wait_for_timeout(self, milliseconds):
        self.observer.wait_for_timeout(milliseconds)

    def count(self, selector):
        return self.evaluate("selector => document.querySelectorAll(selector).length", selector)


def end_viewer(page):
    # A slow landing retains the old realm for a non-script-opened viewer. A
    # popup really closes; the observer retains only references needed to inspect it.
    held = []
    page.route("**/worklist/hpacs-lite/index.html", lambda route: held.append(route))
    with page.expect_popup() as opened:
        page.evaluate("""() => {
          if (KinWorkContext.state() !== 'active' || !KinWorkContext.session())
            throw Error('Expected an authenticated viewer before ending it');
          const observer = window.open('about:blank');
          observer.viewerSource = window;
          window.endedJobStatus = document.querySelector('#kin-viewer-jobs-status');
          KinViewerSessionBoundary.onEnd(() => {
            observer.endObserved = {state:KinWorkContext.state(), empty:document.body.childElementCount===0};
          });
        }""")
    observer = opened.value
    page.evaluate("""() => {
      const channel = new BroadcastChannel('kin-session');
      channel.postMessage({type:'session-ended', session:KinWorkContext.session(), operation:Date.now()});
      channel.close();
    }""")
    observer.wait_for_function("window.endObserved")
    assert observer.evaluate("endObserved") == {"state": "ending", "empty": True}
    for _ in range(100):
        if page.is_closed() or held:
            break
        observer.wait_for_timeout(10)
    assert page.is_closed() or held, "The ended viewer must close or request its login landing"
    return EndedViewer(observer)


def ended_job_status(page):
    return page.evaluate("endedJobStatus?.textContent || ''")
