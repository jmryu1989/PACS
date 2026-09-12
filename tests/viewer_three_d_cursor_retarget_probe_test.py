# coding: utf-8
"""TEST-3D-CURSOR-RETARGET-PROBE — observation only, no product behaviour is asserted.

작업지시 D-3DCURSOR-B8b §1(가). B7 §7-1 이 세운 **추정**은 「비활성 pane 의 mousedown 이 그 pane 을
활성화하면서 고정 뷰어가 서브트리를 다시 만들고, mousedown 과 mouseup 의 대상이 달라져 `click` 이
공통 조상 — `[data-viewport-uid]` 바깥의 그리드 셀 — 으로 retarget 된다」는 것이다. 이 파일은 그
메커니즘을 격리 DOM 에서 실제 브라우저에게 물어본다. 고치는 코드는 여기에 없다.

실제 뷰어와 같은 3층 구조를 만든다.

    #probe-cell  (그리드 셀, class="h-full w-full overflow-hidden rounded-md border …")
      └ [data-viewport-uid="vp-probe"]   ← 컨트롤러가 리스너를 거는 pane.element (:234)
          └ .viewport-element             ← viewport.element = anchor, 좌표 기준 (:176, :317)
              └ canvas.cornerstone-canvas

pointerdown 과 pointerup 사이에 서브트리를 교체하는 세 갈래를 각각 진짜 Playwright 마우스 클릭으로
때리고, `mousedown.target` · `mouseup.target` · `click.target` · `click.target.closest(
'[data-viewport-uid]')` · pane 리스너 호출 여부 · `state().run` 증분 · 노드 동일성을 기록한다.
관측 결과는 `evidence/three-d-cursor-b8b/retarget-probe.json` 에 남는다.

시험이 고정하는 것은 「관측이 실제로 이루어졌다」는 것뿐이다: 대조군에서는 픽이 일어나고, 교체
갈래에서는 브라우저가 무엇을 하든 그것이 기록으로 남는다.
"""
import json
import os
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

from viewer_three_d_cursor_dom_test import HARNESS, MODEL, VIEWER

ROOT = Path(__file__).resolve().parents[1]

# The probe grid mirrors the pinned viewer's nesting. The class strings are the ones B7 §7-1 read
# off the retargeted click's target, so a match in the log is recognisable as the same shape.
BUILD = r"""mode => {
  document.querySelectorAll('#probe-grid').forEach(node => node.remove());
  const grid = document.createElement('div');
  grid.id = 'probe-grid';
  grid.setAttribute('style', 'position:fixed;left:20px;top:20px;width:420px;height:320px;z-index:99999;background:#fff');
  grid.innerHTML =
    '<div id="probe-cell" class="h-full w-full overflow-hidden rounded-md border" ' +
      'style="position:relative;width:420px;height:320px;padding:10px">' +
      '<div data-viewport-uid="vp-probe" id="probe-uid" class="viewport-container" ' +
        'style="position:relative;width:400px;height:300px">' +
        '<div class="viewport-element" style="position:absolute;left:0;top:0;width:400px;height:300px">' +
          '<canvas class="cornerstone-canvas" width="400" height="300" ' +
            'style="position:absolute;left:0;top:0;width:400px;height:300px"></canvas>' +
        '</div>' +
      '</div>' +
      // The pinned viewer's click-to-activate layer, modelled as a sibling of the uid div inside
      // the grid cell: while it is up, a click never reaches the canvas below it.
      '<div id="probe-overlay" style="position:absolute;left:10px;top:10px;width:400px;height:300px"></div>' +
    '</div>';
  document.body.appendChild(grid);
  if (mode.indexOf('overlay') < 0) document.querySelector('#probe-overlay').remove();

  const viewport = window.viewports.inset;   // a real synthetic StackViewport from the harness
  const uid = () => document.querySelector('[data-viewport-uid="vp-probe"]');
  const anchor = () => document.querySelector('#probe-grid .viewport-element');
  // The host adapter resolves both nodes live, exactly like the B7 harness MOUNT does.
  const panes = () => {
    const pane = uid(), inner = anchor();
    if (!pane || !inner) return [];
    viewport.element = inner;
    return [{id: 'probe', element: pane, viewport}];
  };
  window.__p = {mode, log: [], paneListener: 0, panes};

  const describe = node => {
    if (!node) return null;
    const host = node.closest && node.closest('[data-viewport-uid]');
    return {tag: node.tagName, id: node.id || null,
      cls: String(node.className || '').slice(0, 80),
      connected: !!node.isConnected,
      probeAttr: node.getAttribute ? node.getAttribute('data-kin-probe') : null,
      closestViewportUid: host ? host.getAttribute('data-viewport-uid') : null};
  };
  window.__p.describe = describe;
  for (const type of ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup']) {
    document.addEventListener(type, event => {
      window.__p.log.push(Object.assign({phase: type}, describe(event.target)));
    }, true);
  }

  // The replacement under test. It runs on pointerdown, before the button comes back up, which is
  // when the pinned viewer is suspected to rebuild the activated pane.
  const swap = node => {
    const fresh = node.cloneNode(true);
    fresh.removeAttribute('data-kin-probe');
    node.replaceWith(fresh);
    return fresh;
  };
  window.__p.armed = false;
  document.addEventListener('pointerdown', () => {
    if (!window.__p.armed) return;
    window.__p.armed = false;
    if (mode === 'replace-anchor') window.__p.swapped = swap(anchor());
    else if (mode === 'replace-pane') window.__p.swapped = swap(uid());
    else if (mode === 'replace-cell') window.__p.swapped = swap(document.querySelector('#probe-cell'));
    else if (mode === 'hide-overlay') document.querySelector('#probe-overlay').style.display = 'none';
    else if (mode === 'remove-overlay') document.querySelector('#probe-overlay').remove();
    window.__p.log.push({phase: 'swap:' + mode});
  }, true);

  // `__mount` supplies the harness's own `meta`/`context`/`tick`; only `panes` is replaced.
  window.__p.cursor = window.__mount({panes});
  const started = window.__p.cursor.enable();
  // The same node the controller just attached its own bubble `click` to (:188, :234). If this one
  // is not called, the controller's is not called either.
  window.__p.attachedTo = uid();
  window.__p.attachedTo.addEventListener('click', () => { window.__p.paneListener += 1; }, false);
  return started;
}"""

ARM = r"""arm => {
  const pane = window.__p.panes()[0];
  window.__p.log = [];
  window.__p.paneListener = 0;
  window.__p.armed = arm;
  window.__p.heldPane = pane.element;
  window.__p.heldAnchor = pane.viewport.element;
  pane.element.setAttribute('data-kin-probe', 'pane');
  pane.viewport.element.setAttribute('data-kin-probe', 'anchor');
  const r = pane.viewport.element.getBoundingClientRect();
  return {run: window.__p.cursor.state().run, status: window.__p.cursor.state().status,
    x: r.left + r.width * 0.5, y: r.top + r.height * 0.5};
}"""

READ = r"""before => {
  const p = window.__p, state = p.cursor.state();
  const live = p.panes()[0] || null;
  const pick = phase => p.log.filter(entry => entry.phase === phase).pop() || null;
  return {
    mode: p.mode,
    mousedown: pick('mousedown'), mouseup: pick('mouseup'), click: pick('click'),
    pointerdown: pick('pointerdown'), pointerup: pick('pointerup'),
    swapLogged: p.log.some(entry => String(entry.phase).startsWith('swap:')),
    paneListenerCalls: p.paneListener,
    runBefore: before.run, runAfter: state.run, runDelta: state.run - before.run,
    statusBefore: before.status, statusAfter: state.status,
    heldPaneStillConnected: !!p.heldPane.isConnected,
    heldAnchorStillConnected: !!p.heldAnchor.isConnected,
    livePaneIsHeldNode: live ? live.element === p.heldPane : null,
    liveAnchorIsHeldNode: live ? live.viewport.element === p.heldAnchor : null,
    livePaneHasProbeAttr: live ? live.element.getAttribute('data-kin-probe') : null,
    liveAnchorHasProbeAttr: live ? live.viewport.element.getAttribute('data-kin-probe') : null,
    controllerListenerHost: p.attachedTo === (live && live.element),
    controllerListenerHostConnected: !!p.attachedTo.isConnected,
    trace: p.log,
  };
}"""


class ThreeDCursorRetargetProbe(unittest.TestCase):
    """Runs the four variants once each and writes the observation out."""

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        cls.observations = []

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        out = os.environ.get("KIN_RETARGET_PROBE_OUT")
        if out:
            Path(out).parent.mkdir(parents=True, exist_ok=True)
            Path(out).write_text(json.dumps(cls.observations, indent=2, ensure_ascii=False), "utf-8")

    def setUp(self):
        self.page = self.browser.new_page()
        self.page.route(
            "https://cursor.test/**",
            lambda route: route.fulfill(body=HARNESS, content_type="text/html")
            if route.request.url == "https://cursor.test/" else route.abort(),
        )
        self.page.set_default_timeout(5000)
        self.page.goto("https://cursor.test/")
        self.page.add_script_tag(path=str(MODEL))
        self.page.add_script_tag(path=str(VIEWER))

    def tearDown(self):
        self.page.close()

    def observe(self, mode):
        self.page.evaluate(BUILD, mode)
        rows = []
        for attempt in (1, 2):
            # The disturbance is armed for the first click only, so the second click answers the
            # other half of B7 §7-1: "두 번째 클릭부터는 정상이다".
            before = self.page.evaluate(ARM, attempt == 1)
            self.page.mouse.click(before["x"], before["y"])
            self.page.wait_for_timeout(150)
            row = self.page.evaluate(READ, before)
            row["click_number"] = attempt
            rows.append(row)
        type(self).observations.append({"mode": mode, "clicks": rows})
        return rows

    def test_probe_control_no_replacement(self):
        rows = self.observe("control")
        self.assertEqual("CANVAS", rows[0]["click"]["tag"])
        self.assertEqual("vp-probe", rows[0]["click"]["closestViewportUid"])
        self.assertEqual(1, rows[0]["paneListenerCalls"])

    def test_probe_replace_anchor_between_pointerdown_and_pointerup(self):
        self.observe("replace-anchor")

    def test_probe_replace_pane_between_pointerdown_and_pointerup(self):
        self.observe("replace-pane")

    def test_probe_replace_grid_cell_between_pointerdown_and_pointerup(self):
        self.observe("replace-cell")

    def test_probe_activation_overlay_hidden_between_pointerdown_and_pointerup(self):
        self.observe("hide-overlay")

    def test_probe_activation_overlay_removed_between_pointerdown_and_pointerup(self):
        self.observe("remove-overlay")


if __name__ == "__main__":
    unittest.main()
