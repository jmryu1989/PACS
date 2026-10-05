"""Observe the real closed viewer through a same-origin, test-owned observer.

No product close/navigation function is replaced. Retained references let teardown
assertions inspect resources and late completions after the original window closes.
"""


class EndedViewer:
    def __init__(self, observer, source, held):
        self.observer = observer
        self.source = source
        self.held = held
        self.requests = []
        source.on('request', self._request)

    def _request(self, request):
        from urllib.parse import urlsplit
        path = urlsplit(request.url).path
        if path.startswith(('/api/', '/dicom-web/', '/instances/')):
            self.requests.append((request.method, path))

    def ended(self):
        self.observer.wait_for_function('window.endObserved')
        assert self.observer.evaluate('endObserved.state') != 'active'
        assert self.observer.evaluate('endObserved.empty'), 'The ended viewer still displays patient content'
        for _ in range(100):
            if self.source.is_closed() or self.held:
                break
            self.observer.wait_for_timeout(10)
        assert self.source.is_closed() or self.held, 'The ended viewer must close or request its login landing'
        self.assert_released()
        self.requests.clear()
        return self

    def assert_released(self):
        assert self.observer.evaluate('''() => viewerResources.engines.every(engine =>
          !viewerResources.cornerstone.getRenderingEngines().includes(engine))'''), 'An ended viewer retained a rendering engine'
        assert self.observer.evaluate('() => viewerResources.elements.every(node => !node.isConnected)'), 'An ended viewer retained an image element'

    def retained(self, selector, expression='node => !node.isConnected'):
        return self.observer.evaluate('selector => viewerResources.nodes[selector].map(' + expression + ')', selector)

    def assert_quiet(self, milliseconds=350):
        before = self.observer.evaluate('[viewerResources.renders,viewerResources.moves]')
        self.observer.wait_for_timeout(milliseconds)
        assert self.observer.evaluate('[viewerResources.renders,viewerResources.moves]') == before, 'An image rendered or moved after the viewer ended'
        assert self.requests == [], 'An ended viewer started a protected request: ' + repr(self.requests)
        self.assert_released()

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

    def dispatch_key(self, code, **modifiers):
        # Constructors disappear with a closed Window. Create the event in the
        # observer and deliver it to the original document's retained listeners.
        self.observer.evaluate("options => viewerSource.document.dispatchEvent(new KeyboardEvent('keydown', options))",
                               dict(code=code, bubbles=True, **modifiers))


def observe_viewer(page, selectors=()):
    # HTTP 204 retains the old realm without leaving the click that initiated
    # navigation waiting forever. A script-opened popup still really closes.
    held = []
    def landing(route):
        route.fulfill(status=204)
        held.append(route.request.url)
    page.route("**/worklist/hpacs-lite/index.html", landing)
    with page.expect_popup() as opened:
        page.evaluate("""selectors => {
          if (KinWorkContext.state() !== 'active' || !KinWorkContext.session())
            throw Error('Expected an authenticated viewer before ending it');
          const observer = window.open('about:blank');
          observer.viewerSource = window;
          const engines = window.cornerstone?.getRenderingEngines() || [];
          const elements = engines.flatMap(engine => engine.getViewports().map(viewport => viewport.element));
          observer.viewerResources = {cornerstone:window.cornerstone, engines, elements, renders:0, moves:0,
            nodes:Object.fromEntries(selectors.map(selector => [selector, [...document.querySelectorAll(selector)]]))};
          for (const selector of selectors) if (!observer.viewerResources.nodes[selector].length)
            throw Error('Expected a live control before ending: ' + selector);
          for (const element of elements) element.addEventListener(
            cornerstone.Enums.Events.IMAGE_RENDERED, () => observer.viewerResources.renders++);
          for (const element of elements) for(const event of [cornerstone.Enums.Events.CAMERA_MODIFIED,cornerstone.Enums.Events.STACK_NEW_IMAGE].filter(Boolean))
            element.addEventListener(event,()=>observer.viewerResources.moves++);
          window.endedJobStatus = document.querySelector('#kin-viewer-jobs-status');
          KinViewerSessionBoundary.onEnd(() => {
            observer.endObserved = {state:KinWorkContext.state(), empty:document.body.childElementCount===0};
          });
        }""", list(selectors))
    observer = opened.value
    return EndedViewer(observer, page, held)


def end_viewer(page, selectors=()):
    ended = observe_viewer(page, selectors)
    page.evaluate("""() => {
      const channel = new BroadcastChannel('kin-session');
      channel.postMessage({type:'session-ended', session:KinWorkContext.session(), operation:Date.now(), status:'ending'});
      channel.close();
    }""")
    return ended.ended()


def hold_landing(page):
    """Record the exit navigation while retaining its old realm (HTTP 204)."""
    held=[]
    def landing(route):
        held.append(route.request.url)
        route.fulfill(status=204)
    page.context.route('**/worklist/hpacs-lite/index.html',landing)
    return held


def end_document(page):
    """Deliver the same-session end without changing the live server's identity.

    A no-content landing response retains the ended document without committing
    a new realm. Cleanup assertions therefore cannot pass on a replacement page.
    """
    held, logouts = hold_landing(page), []
    page.on('request', lambda request: logouts.append(request.url)
            if request.method == 'POST' and request.url.endswith('/api/auth/logout') else None)
    page.evaluate("""() => {
      if (KinWorkContext.state() !== 'active' || !KinWorkContext.session())
        throw Error('Expected an authenticated document before ending it');
      const channel = new BroadcastChannel('kin-session');
      channel.postMessage({type:'session-ended', session:KinWorkContext.session(),
        operation:Date.now(), status:'ending'});
      channel.close();
    }""")
    page.wait_for_function("KinWorkContext.state() !== 'active'")
    page.wait_for_timeout(100)
    assert not logouts, 'Receiving an end must not send a logout request'
    return held


def release_after_end(route, **reply):
    """A cancelled read has no receiver; a held write still delivers its receipt."""
    if route.request.failure:
        assert 'ABORTED' in route.request.failure or 'CANCELLED' in route.request.failure, route.request.failure
        return 'aborted'
    route.fulfill(**reply)
    return 'delivered'


def ended_job_status(page):
    return page.evaluate("endedJobStatus?.textContent || ''")
