# coding: utf-8
"""TEST-3D-CURSOR-WIRING: the 3D cursor reached through config/ohif.js, not through injection.

작업지시 D-3DCURSOR-B9 3(a)(b). The accuracy harness proves the coordinates by injecting the two
module files itself (`test_three_d_cursor_accuracy.py:inject` / `add_script_tag`). That is exactly
what this suite must not do: here the modules may only arrive because the served
`config/ohif.js` loaded them, so `add_script_tag` never appears in this file.

The flag-ON build is produced by intercepting the served config response and turning **one boolean
literal** into `true` (the `page.route` shape of `test_viewer_precision.py:53` and
`test_viewer_history.py:21`). The original body's sha256, the patched body's sha256 and the proof
that the two differ in that one token are written into the observation file.

The flag-OFF case runs the evaluation build unchanged: nothing is intercepted, and the two module
files must not be requested at all.
"""
import hashlib
import json
import unittest
import uuid
from pathlib import Path

from playwright.sync_api import expect

import three_d_cursor_accuracy_fixture as fx
from test_prior_selection import canvas_ready
from test_viewer_layout import ViewerLayoutE2E

ROOT = Path(__file__).resolve().parents[2]
MODULES = ("three-d-cursor-model.js", "viewer-three-d-cursor.js")
ARTIFACTS = Path(__file__).parent / "artifacts"
OUT = ARTIFACTS / "three-d-cursor-wiring-ci"

CONFIG_PATH = "/ohif/app-config.js"
FLAG_OFF = "kinThreeDCursor: { enabled: false }"
FLAG_ON = "kinThreeDCursor: { enabled: true }"

# Every addEventListener/removeEventListener on the page, counted per {target, type, capture}
# before the viewer's own scripts run. Only the net change across one mode exit and re-entry is
# read, so the host viewer's own churn outside that window is never attributed to the controller.
LISTENER_PROBE = r"""
(() => {
  const proto = EventTarget.prototype;
  const add = proto.addEventListener, remove = proto.removeEventListener;
  const net = new Map();
  const name = node => {
    if (node === document) return 'document';
    if (node === window) return 'window';
    if (!node || node.nodeType !== 1) return 'other';
    const pane = node.getAttribute && node.getAttribute('data-viewport-uid');
    if (pane) return 'pane:' + pane;
    return 'element:' + (node.id || node.tagName);
  };
  const key = (node, type, options) =>
    name(node) + '|' + type + '|' + (typeof options === 'object' && options !== null ? !!options.capture : !!options);
  const bump = (node, type, options, delta) => {
    const k = key(node, type, options);
    net.set(k, (net.get(k) || 0) + delta);
  };
  proto.addEventListener = function (type, handler, options) {
    try { bump(this, type, options, 1); } catch (_) {}
    return add.apply(this, arguments);
  };
  proto.removeEventListener = function (type, handler, options) {
    try { bump(this, type, options, -1); } catch (_) {}
    return remove.apply(this, arguments);
  };
  window.__kinListenerNet = () => Object.fromEntries(net);
})();
"""

PANELS = """() => [...document.querySelectorAll('[data-kin-3d-cursor-panel]')]
  .map(node => ({id: node.id, owned: node.getAttribute('data-kin-3d-cursor-panel')}))"""

STEP = """label => {
  const probe = window.kinViewerThreeDCursorState ? window.kinViewerThreeDCursorState() : null;
  return {
    step: label,
    globals: {KinThreeDCursorModel: typeof window.KinThreeDCursorModel,
              KinViewerThreeDCursor: typeof window.KinViewerThreeDCursor},
    probe: probe && {mounts: probe.mounts, renders: probe.renders, invalidations: probe.invalidations,
                     listeners: probe.listeners, ended: probe.ended, mounted: probe.mounted},
    state: probe && probe.cursor,
    panels: [...document.querySelectorAll('#kin-3d-cursor')].length,
    panelOwners: [...document.querySelectorAll('[data-kin-3d-cursor-panel]')]
      .map(node => node.getAttribute('data-kin-3d-cursor-panel')),
    insideLayout: !!document.querySelector('#kin-viewer-layout #kin-3d-cursor'),
    layers: document.querySelectorAll('[data-kin-3d-cursor-layer]').length,
    marks: document.querySelectorAll('[data-kin-3d-cursor-mark]').length,
    markedPanes: probe && probe.cursor ? probe.cursor.panes.filter(p => p.marked).length : null,
    listenerNet: window.__kinListenerNet ? window.__kinListenerNet() : null};
}"""


class ThreeDCursorWiringE2E(ViewerLayoutE2E):
    maxDiff = None

    # ---- page ---------------------------------------------------------------------------

    def digests(self):
        return {name: hashlib.sha256((ROOT / "worklist-v0/hpacs-lite" / name).read_bytes()).hexdigest()
                for name in MODULES}

    def open(self, fixture, descriptions, flag_on):
        context = self.browser.new_context(ignore_https_errors=True,
                                           viewport={"width": 1600, "height": 1050})
        self.contexts.append(context)
        context.add_init_script(LISTENER_PROBE)
        if flag_on:
            context.route(self.stack.proxy + CONFIG_PATH, self.serve_flag_on)
        page = context.new_page()
        page.set_default_timeout(20000)
        self.requests = []
        page.on("request", lambda request: self.requests.append(request.url.split("?")[0]))
        page.goto(self.stack.proxy + "/")
        try:
            page.locator("#username").fill(self.stack.username("doctor"))
            page.locator("#password").fill(self.stack.passwords["doctor"])
            page.locator("#kc-login").click()
        except Exception:
            raise RuntimeError("Real BFF login form could not be submitted") from None
        page.wait_for_url("**/worklist/hpacs-lite/main.html", timeout=30000)
        page = self.launch(page, [fixture])
        self.grid(page, len(descriptions))
        for index, description in enumerate(descriptions):
            self.drag(page, description, index)
        canvas_ready(page, len(descriptions))
        return page

    def serve_flag_on(self, route):
        """One boolean literal, and nothing else."""
        response = route.fetch()
        self.assertEqual(response.status, 200)
        body = response.text()
        self.assertEqual(body.count(FLAG_OFF), 1, "the served config must carry exactly one flag")
        self.assertNotIn(FLAG_ON, body, "the evaluation build must not ship the flag on")
        patched = body.replace(FLAG_OFF, FLAG_ON)
        # The only change is the token: everything before and after it is byte for byte the served
        # response, and turning the token back reproduces that response exactly.
        at = body.index(FLAG_OFF)
        self.assertEqual(patched[:at], body[:at])
        self.assertEqual(patched[at + len(FLAG_ON):], body[at + len(FLAG_OFF):])
        self.assertEqual(patched.replace(FLAG_ON, FLAG_OFF), body)
        self.assertEqual(len(patched), len(body) - 1)
        self.config_patch = dict(
            servedSHA256=hashlib.sha256(body.encode("utf-8")).hexdigest(),
            patchedSHA256=hashlib.sha256(patched.encode("utf-8")).hexdigest(),
            servedBytes=len(body), patchedBytes=len(patched), flagOffset=at,
            committedFlag=FLAG_OFF, interceptedFlag=FLAG_ON,
            unchangedPrefixBytes=at, unchangedSuffixBytes=len(body) - at - len(FLAG_OFF))
        route.fulfill(response=response, body=patched)

    # ---- observations -------------------------------------------------------------------

    def record(self, page, label):
        row = page.evaluate(STEP, label)
        self.observations.append(row)
        return row

    def module_requests(self):
        return [url for url in self.requests
                if any(url.endswith("/worklist/hpacs-lite/" + name) for name in MODULES)]

    def served_digests(self, page):
        return page.evaluate("""async names => {
          const out = {};
          for (const name of names) {
            const response = await fetch('/worklist/hpacs-lite/' + name, {credentials: 'same-origin'});
            const bytes = new Uint8Array(await response.arrayBuffer());
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            out[name] = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
          }
          return out;
        }""", list(MODULES))

    def pane_cells(self, page):
        return page.evaluate("""() => [...services.viewportGridService.getState().viewports.values()]
          .sort((a, b) => a.y - b.y || a.x - b.x).map(g => {
            const v = services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);
            return {id: g.viewportId, type: v && v.type, index: v && v.getCurrentImageIdIndex(),
                    count: v && v.getImageIds().length};
          })""")

    def reveal(self, page):
        """Open the dock panel the controller's section lives in.

        `#kin-viewer-layout` is the workspace dock's collapsible panel, so a freshly opened viewer
        has the 3D Cursor button in the document but not on screen. This uses the dock's own tab and
        the panel's own summary — nothing about the host layout is written by the test.
        """
        toggle = page.locator("#kin-3d-cursor-toggle")
        tab = page.locator('#kin-workspace-dock nav button[aria-controls="kin-viewer-layout"]')
        if tab.count() and not toggle.is_visible():
            tab.click()
        summary = page.locator("#kin-viewer-layout > summary")
        if summary.count() and not toggle.is_visible():
            summary.click()
        expect(toggle).to_be_visible()

    def enable_mode(self, page):
        self.reveal(page)
        page.locator("#kin-3d-cursor-toggle").click()
        page.wait_for_function("() => kinViewerThreeDCursorState().cursor.enabled === true")

    def report(self, name):
        OUT.mkdir(parents=True, exist_ok=True)
        payload = dict(config=getattr(self, "config_patch", None), digests=self.digests(),
                       served=getattr(self, "servedDigests", None), steps=self.observations)
        (OUT / ("wiring-" + name + ".json")).write_text(
            json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print("3D CURSOR WIRING " + name + " " + json.dumps(payload, ensure_ascii=False), flush=True)

    def setUp(self):
        super().setUp()
        self.observations = []
        self.requests = []
        self.config_patch = None
        self.servedDigests = None

    def study(self):
        fixture, spec = fx.build(self.stack, "D3DWIRE-" + uuid.uuid4().hex[:12])
        self.spec = spec
        return fixture

    # ---- (a) the flag-ON wiring ----------------------------------------------------------

    def test_wiring_01_config_mounts_the_module_and_an_inactive_pane_picks_on_the_first_click(self):
        """3(a) 1-4: loaded by config, mounted in #kin-viewer-layout, first click on an inactive
        pane picks, and IMAGE_RENDERED reaches the controller."""
        fixture = self.study()
        originals = self.originals()
        page = self.open(fixture, ["ACC axial", "ACC oblique"], flag_on=True)
        try:
            # 1-2. The modules are here because the served config asked for them.
            self.assertIsNotNone(self.config_patch, "the config response was never intercepted")
            self.assertEqual(len(self.module_requests()), 2, "both module files must be fetched once")
            self.servedDigests = self.served_digests(page)
            self.assertEqual(self.servedDigests, self.digests(),
                             "the bytes the page loaded are not the bytes in the repository")
            page.wait_for_function("() => !!document.querySelector('#kin-viewer-layout #kin-3d-cursor')")
            loaded = self.record(page, "load")
            self.assertEqual(loaded["globals"],
                             {"KinThreeDCursorModel": "object", "KinViewerThreeDCursor": "object"})
            self.assertEqual(loaded["panels"], 1)
            self.assertTrue(loaded["insideLayout"])
            self.assertEqual(loaded["probe"]["mounts"], 1)

            # 3. Enable through the panel button, then pick on a pane that is not the active one.
            self.enable_mode(page)
            self.record(page, "enable")
            cells = self.pane_cells(page)
            self.assertEqual(len(cells), 2)
            active = page.evaluate("() => services.viewportGridService.getActiveViewportId()")
            target = next(cell for cell in cells if cell["id"] != active)
            self.assertNotEqual(target["id"], active, "the pick target must start out inactive")
            box = page.locator('[data-viewport-uid="' + target["id"] + '"] canvas').bounding_box()
            before = page.evaluate("() => kinViewerThreeDCursorState().cursor.run")
            page.mouse.click(box["x"] + box["width"] * .5, box["y"] + box["height"] * .5)
            page.wait_for_function("""before => {
              const s = kinViewerThreeDCursorState().cursor;
              return s.run > before && !s.busy;
            }""", arg=before, timeout=30000)
            picked = self.record(page, "pick")
            self.assertIsNotNone(picked["state"]["source"],
                                 "the first click on an inactive pane did not pick: %s"
                                 % json.dumps(picked, ensure_ascii=False))
            self.assertEqual(picked["state"]["source"]["sop"] is None, False)
            self.assertGreaterEqual(picked["markedPanes"], 1)
            self.assertGreaterEqual(picked["marks"], 1)
            # The pick itself did not need a preceding activation click; one click did both.
            self.assertEqual(picked["state"]["run"], before + 1)

            # 4. IMAGE_RENDERED: move the other pane through the renderer and watch the counter.
            other = next(cell for cell in cells if cell["id"] != target["id"])
            renders = page.evaluate("() => kinViewerThreeDCursorState().renders")
            self.assertGreater(renders, 0, "no IMAGE_RENDERED was received while the study loaded")
            page.evaluate("""async ({id, index}) => {
              await services.cornerstoneViewportService.getCornerstoneViewport(id).setImageIdIndex(index);
            }""", dict(id=other["id"], index=(other["index"] + 2) % other["count"]))
            page.wait_for_function("renders => kinViewerThreeDCursorState().renders > renders",
                                   arg=renders, timeout=30000)
            page.wait_for_function("""id => {
              const pane = kinViewerThreeDCursorState().cursor.panes.find(p => p.id === id);
              return pane && !pane.marked;
            }""", arg=other["id"], timeout=30000)
            moved = self.record(page, "image-rendered")
            self.assertGreater(moved["probe"]["renders"], renders)
            self.assertEqual([p["marked"] for p in moved["state"]["panes"] if p["id"] == other["id"]],
                             [False], "the stale marker survived the render")
        finally:
            self.report("flag-on-pick")
        page.screenshot(path=str(ARTIFACTS / "THREE-D-CURSOR-WIRING-pick.png"))
        self.assertEqual(self.originals(), originals)

    def test_wiring_02_re_entry_is_clean_and_the_session_end_unmounts_everything(self):
        """3(a) 5-6: one controller after a mode exit and re-entry, no net listener growth, and a
        session end that leaves nothing behind."""
        fixture = self.study()
        originals = self.originals()
        page = self.open(fixture, ["ACC axial", "ACC oblique"], flag_on=True)
        extension = "() => window.config.extensions.find(e => e.id === 'kin.three-d-cursor')"
        try:
            page.wait_for_function("() => !!document.querySelector('#kin-viewer-layout #kin-3d-cursor')")
            self.enable_mode(page)
            first = self.record(page, "before-exit")
            self.assertEqual(first["panels"], 1)
            baseline = page.evaluate("() => __kinListenerNet()")

            # 5. The host's own lifecycle, called the way the other viewer suites call it.
            page.evaluate(extension + "().onModeExit()")
            page.wait_for_function("() => !document.querySelector('#kin-3d-cursor')")
            exited = self.record(page, "mode-exit")
            self.assertEqual(exited["panels"], 0)
            self.assertEqual(exited["layers"], 0)
            self.assertEqual(exited["probe"]["mounted"], False)

            page.evaluate(extension + "().onModeEnter()")
            page.wait_for_function("() => !!document.querySelector('#kin-viewer-layout #kin-3d-cursor')")
            page.wait_for_function("() => kinViewerThreeDCursorState().mounts === 2")
            self.enable_mode(page)
            again = self.record(page, "re-entry")
            self.assertEqual(again["panels"], 1, "a second panel means a duplicate mount")
            self.assertEqual(len(again["panelOwners"]), 1)
            self.assertNotEqual(again["panelOwners"], first["panelOwners"],
                                "the re-entry must be a new controller, not the old node reused")
            after = page.evaluate("() => __kinListenerNet()")
            growth = {key: after.get(key, 0) - baseline.get(key, 0)
                      for key in set(after) | set(baseline)
                      if after.get(key, 0) - baseline.get(key, 0) != 0}
            self.observations.append(dict(step="listener-net-growth", growth=growth))
            self.assertEqual(growth, {}, "listeners were not returned across the re-entry")

            # 6. Session end. Same signal the other viewer extensions listen for.
            page.evaluate("""() => {
              const channel = new BroadcastChannel('kin-session');
              channel.postMessage({type: 'session-ended'});
              channel.close();
            }""")
            page.wait_for_function("() => !document.querySelector('#kin-3d-cursor')")
            page.wait_for_function("() => kinViewerThreeDCursorState().ended === true")
            ended = self.record(page, "session-end")
            self.assertEqual(ended["panels"], 0)
            self.assertEqual(ended["layers"], 0)
            self.assertEqual(ended["marks"], 0)
            self.assertEqual(ended["probe"]["mounted"], False)
            self.assertEqual(ended["probe"]["listeners"], 0, "the event bindings outlived the session")
            # A re-entry after the session ended must not bring the mode back.
            page.evaluate(extension + "().onModeEnter()")
            page.wait_for_timeout(500)
            self.assertEqual(page.evaluate("() => document.querySelectorAll('#kin-3d-cursor').length"), 0)
            self.assertEqual(page.evaluate("() => kinViewerThreeDCursorState().mounts"), 2)
        finally:
            self.report("flag-on-lifecycle")
        self.assertEqual(self.originals(), originals)

    # ---- (b) the evaluation build, untouched ---------------------------------------------

    def test_wiring_03_the_committed_flag_is_off_and_nothing_is_loaded(self):
        """3(b): no interception at all. The committed literal is false, so the module files are
        never requested and neither global nor panel exists."""
        fixture = self.study()
        originals = self.originals()
        page = self.open(fixture, ["ACC axial", "ACC oblique"], flag_on=False)
        try:
            self.assertIsNone(self.config_patch, "the OFF case must not intercept the config")
            page.wait_for_timeout(2000)
            # Open the very panel the ON build puts the section in, so 'not there' is not 'not shown'.
            tab = page.locator('#kin-workspace-dock nav button[aria-controls="kin-viewer-layout"]')
            if tab.count():
                tab.click()
            expect(page.locator("#kin-viewer-layout")).to_be_visible()
            off = self.record(page, "flag-off")
            print("3D CURSOR WIRING flag-off requests " + json.dumps(
                dict(modules=self.module_requests(), total=len(self.requests)), ensure_ascii=False), flush=True)
            self.assertEqual(self.module_requests(), [],
                             "the OFF build requested a 3D cursor module file")
            self.assertEqual(off["globals"],
                             {"KinThreeDCursorModel": "undefined", "KinViewerThreeDCursor": "undefined"})
            self.assertIsNone(off["probe"], "the OFF build must not even publish its observation hook")
            self.assertEqual(off["panels"], 0)
            self.assertEqual(off["layers"], 0)
            self.assertEqual(off["marks"], 0)
            # And the served config really is the committed one, with the literal false in it.
            served = page.evaluate("""async path => {
              const response = await fetch(path, {credentials: 'same-origin'});
              const body = await response.text();
              const bytes = new TextEncoder().encode(body);
              const digest = await crypto.subtle.digest('SHA-256', bytes);
              return {off: body.split('kinThreeDCursor: { enabled: false }').length - 1,
                      on: body.split('kinThreeDCursor: { enabled: true }').length - 1,
                      sha256: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')};
            }""", CONFIG_PATH)
            self.observations.append(dict(step="served-config", **served))
            self.assertEqual(served["off"], 1)
            self.assertEqual(served["on"], 0)
        finally:
            self.report("flag-off")
        page.screenshot(path=str(ARTIFACTS / "THREE-D-CURSOR-WIRING-flag-off.png"))
        self.assertEqual(self.originals(), originals)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ThreeDCursorWiringE2E(name)
                              for name in loader.getTestCaseNames(ThreeDCursorWiringE2E)
                              if name.startswith("test_wiring_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
