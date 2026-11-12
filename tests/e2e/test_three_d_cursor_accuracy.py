# coding: utf-8
"""TEST-3D-CURSOR-ACCURACY: the 3D cursor's position accuracy in the real pinned renderer.

`three_d_cursor_model_test.cjs` and `viewer_three_d_cursor_dom_test.py` both compute their
expectations with the same transform the code under test uses, so a shared origin error survives
both (검토결과-D-3DCURSOR-801AD73 §4-1). This harness removes that shared origin.

Nothing here calls a product function to decide where to click or where a marker should be:

  * the patient coordinate of a pick is `IPP + i*columnSpacing*u + j*rowSpacing*v` computed in
    Python from the tags the fixture wrote (`three_d_cursor_accuracy_fixture.world`);
  * the target frame, its separation `|n.(p-o)|` and the projected pixel come from this test's own
    `project()`, not from `three-d-cursor-model.js`;
  * image pixel -> screen is measured from the rendered image itself. Three saturated fiducial
    squares of different sizes sit at fixed asymmetric pixel positions on every slice; their
    centroids in the canvas, converted to client coordinates through `getBoundingClientRect`,
    define the affine. It is re-measured under every screen condition, so device pixel ratio,
    browser zoom, resize, zoom/pan and rotation/flip need no renderer transform to be handled.

The product is not modified and `config/ohif.js` is not touched: the test injects
`three-d-cursor-model.js` and `viewer-three-d-cursor.js` verbatim (sha256 recorded in the
observations) into the real viewer page and mounts the controller over the two real
StackViewports, with a `meta` adapter built from `cornerstone.metaData.get('instance', …)` and the
study row's `sourcePatientKey` — the same two sources a real `config/ohif.js` integration has.

Failing conditions are reported with their numbers, never repaired here.
"""
import hashlib
import json
import math
import unittest
import uuid
from pathlib import Path

from playwright.sync_api import expect

import three_d_cursor_accuracy_fixture as fx
from test_prior_selection import canvas_ready
from test_viewer_layout import ViewerLayoutE2E

ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT / "worklist-v0/hpacs-lite/three-d-cursor-model.js"
CONTROLLER = ROOT / "worklist-v0/hpacs-lite/viewer-three-d-cursor.js"
ARTIFACTS = Path(__file__).parent / "artifacts"

# The accepted tolerances, now asserted rather than only printed. The mapping figure is measured
# against the coordinates the click was actually delivered at and carries this harness's own affine
# residual inside it, so 0.3 mm bounds that sum and not the product's share alone. Click
# quantization stays reported-only: a real mouse cannot land between whole client pixels, so its
# distance to the voxel centre is a property of the input device, not of the product.
CALCULATION_MM = 0.3
MARKER_PX = 0.5

# Mount the injected controller over the real grid. `panes`, `meta` and `context` are the whole
# integration surface a config/ohif.js extension would have to supply.
MOUNT = """async () => {
  const rows = await fetch('/api/studies', {credentials: 'same-origin'}).then(r => r.json());
  const me = await fetch('/api/me', {credentials: 'same-origin'}).then(r => r.json());
  const study = window.__acc.study;
  const row = (rows.studies || []).find(s => s.uid === study);
  if (!row || !row.sourcePatientKey) throw new Error('no sourcePatientKey for the study under test');
  window.__acc.patientKey = row.sourcePatientKey;
  window.__acc.context = {owner: JSON.stringify([me.institution, me.sub])};
  const grid = () => [...services.viewportGridService.getState().viewports.values()]
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const panes = () => grid().map(g => {
    const viewport = services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);
    const element = document.querySelector('[data-viewport-uid="' + g.viewportId + '"]');
    return viewport && element ? {id: g.viewportId, element, viewport} : null;
  }).filter(Boolean);
  const numbers = value => Array.isArray(value) ? value.map(Number) : value;
  const meta = imageId => {
    const i = cornerstone.metaData.get('instance', imageId);
    if (!i) return null;
    return {StudyInstanceUID: i.StudyInstanceUID, SeriesInstanceUID: i.SeriesInstanceUID,
      SOPInstanceUID: i.SOPInstanceUID, FrameOfReferenceUID: i.FrameOfReferenceUID,
      sourcePatientKey: window.__acc.patientKey, Modality: i.Modality,
      ImageOrientationPatient: numbers(i.ImageOrientationPatient),
      ImagePositionPatient: numbers(i.ImagePositionPatient),
      PixelSpacing: numbers(i.PixelSpacing), Rows: Number(i.Rows), Columns: Number(i.Columns), imageId};
  };
  window.__acc.panes = panes;
  window.__acc.meta = meta;
  window.__acc.cursor = KinViewerThreeDCursor.mount(
    {panes, meta, context: () => window.__acc.context});
  // Observation only: where a click is seen, so a click that never reaches the controller can be
  // told apart from one the controller refused. These listeners change nothing about the product.
  window.__acc.events = [];
  if (!window.__acc.probed) {
    window.__acc.probed = true;
    const note = (phase, event) => {
      const host = event.target && event.target.closest && event.target.closest('[data-viewport-uid]');
      window.__acc.events.push({phase, x: event.clientX, y: event.clientY,
        target: event.target && event.target.tagName, cls: event.target && String(event.target.className).slice(0, 60),
        pane: host && host.getAttribute('data-viewport-uid')});
    };
    document.addEventListener('click', event => note('document-capture', event), true);
    document.addEventListener('click', event => note('document-bubble', event), false);
    // Since B8b the controller measures the pointerup, not the click. PointerEvent.clientX is a
    // double while MouseEvent.clientX is rounded to whole pixels, so only this event carries the
    // coordinates the product was actually asked about.
    document.addEventListener('pointerup', event => note('document-pointerup', event), true);
    for (const pane of panes()) {
      const anchor = pane.viewport.element || pane.element;
      pane.element.addEventListener('click', event => note('pane-bubble:' + pane.id, event), false);
      if (anchor !== pane.element)
        anchor.addEventListener('click', event => note('anchor-bubble:' + pane.id, event), false);
    }
  }
  return window.__acc.cursor.enable();
}"""

# Connected saturated regions of the rendered canvas, in client coordinates. This is the only
# image-pixel -> screen measurement in the harness and it uses no viewport transform at all.
BLOBS = """viewportId => {
  const host = document.querySelector('[data-viewport-uid="' + viewportId + '"]');
  const canvas = host.querySelector('canvas.cornerstone-canvas') || host.querySelector('canvas');
  const width = canvas.width, height = canvas.height;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  let high = 0, low = 255;
  for (let i = 0; i < data.length; i += 4) { if (data[i] > high) high = data[i]; if (data[i] < low) low = data[i]; }
  const limit = low + (high - low) * 0.6;
  const label = new Int32Array(width * height).fill(-1);
  const found = [];
  for (let start = 0; start < width * height; start++) {
    if (label[start] >= 0 || data[start * 4] < limit) continue;
    const id = found.length, queue = [start];
    label[start] = id;
    // Intensity weighted about the threshold: a saturated square has a flat top and a symmetric
    // interpolated skirt, so this centres it far better than counting pixels does.
    let sumX = 0, sumY = 0, weight = 0, area = 0, minX = width, maxX = -1, minY = height, maxY = -1;
    while (queue.length) {
      const at = queue.pop(), x = at % width, y = (at - x) / width, w = data[at * 4] - limit;
      sumX += (x + 0.5) * w; sumY += (y + 0.5) * w; weight += w; area++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      const neighbours = [x > 0 ? at - 1 : -1, x < width - 1 ? at + 1 : -1,
                          y > 0 ? at - width : -1, y < height - 1 ? at + width : -1];
      for (const next of neighbours)
        if (next >= 0 && label[next] < 0 && data[next * 4] >= limit) { label[next] = id; queue.push(next); }
    }
    found.push({area, x: sumX / weight, y: sumY / weight, minX, maxX, minY, maxY});
  }
  const rect = canvas.getBoundingClientRect();
  const toClientX = x => rect.left + x * rect.width / width;
  const toClientY = y => rect.top + y * rect.height / height;
  return {limit, high, low, canvas: {width, height, cssWidth: rect.width, cssHeight: rect.height},
    devicePixelRatio: window.devicePixelRatio,
    blobs: found.filter(b => b.area >= 4).sort((a, b) => a.area - b.area).map(b => ({
      area: b.area, clientX: toClientX(b.x), clientY: toClientY(b.y),
      clipped: b.minX === 0 || b.minY === 0 || b.maxX === width - 1 || b.maxY === height - 1}))};
}"""

# Every owned marker with the screen position of its centre.
MARKS = """() => [...document.querySelectorAll('[data-kin-3d-cursor-mark]')].map(dot => {
  const rect = dot.getBoundingClientRect();
  const host = dot.closest('[data-viewport-uid]');
  return {viewportId: host && host.getAttribute('data-viewport-uid'), sop: dot.dataset.kinSop,
    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    display: dot.style.display, width: rect.width, height: rect.height};
})"""


# Where the renderer itself maps world points (worldToCanvas) and the delivered click (canvasToWorld),
# read against both the canvas box and the viewport element box. Observation only.
DS_BUNDLE = """({id, worlds, client}) => {
  const v = services.cornerstoneViewportService.getCornerstoneViewport(id);
  const host = document.querySelector('[data-viewport-uid="' + id + '"]');
  const canvas = host.querySelector('canvas.cornerstone-canvas') || host.querySelector('canvas');
  const c = canvas.getBoundingClientRect(), e = (v.element || host).getBoundingClientRect();
  const box = r => ({left: r.left, top: r.top, width: r.width, height: r.height});
  const out = {canvasRect: box(c), elementRect: box(e), canvasSize: [canvas.width, canvas.height],
    clientSize: [canvas.clientWidth, canvas.clientHeight], dpr: window.devicePixelRatio,
    marksCanvas: [], marksElement: []};
  for (const w of worlds) {
    const p = v.worldToCanvas(w);
    out.marksCanvas.push([c.left + p[0], c.top + p[1]]);
    out.marksElement.push([e.left + p[0], e.top + p[1]]);
  }
  if (client) {
    out.clickCanvasWorld = Array.from(v.canvasToWorld([client[0] - c.left, client[1] - c.top]));
    out.clickElementWorld = Array.from(v.canvasToWorld([client[0] - e.left, client[1] - e.top]));
  }
  return out;
}"""

# Count the stack events the pinned renderer sends per pane, so a moved pane's slice-number display
# can be tied to the event it does or does not receive. Observation only.
DS_EVENTS = """() => {
  const E = (window.cornerstone && cornerstone.Enums && cornerstone.Enums.Events) || {};
  const names = [E.STACK_VIEWPORT_SCROLL || 'CORNERSTONE_STACK_VIEWPORT_SCROLL',
                 E.STACK_NEW_IMAGE || 'CORNERSTONE_STACK_NEW_IMAGE'];
  window.__acc.paneEvents = {};
  for (const pane of window.__acc.panes()) {
    const counts = window.__acc.paneEvents[pane.id] = {};
    const element = pane.viewport.element || pane.element;
    for (const name of names) {
      counts[name] = 0;
      element.addEventListener(name, () => { counts[name]++; });
    }
  }
  return names;
}"""

# The moved pane as the reader sees it: the renderer's index and SOP, the overlay's "I:" line and
# any range input (scroll bar) inside that pane only.
DS_PANE = """id => {
  const v = services.cornerstoneViewportService.getCornerstoneViewport(id);
  const host = document.querySelector('[data-viewport-uid="' + id + '"]');
  const ids = v.getImageIds(), index = v.getCurrentImageIdIndex();
  const instance = cornerstone.metaData.get('instance', ids[index]) || {};
  let scope = host;
  for (let up = host.parentElement, n = 0; up && n < 6; up = up.parentElement, n++) {
    if (up.querySelectorAll('[data-viewport-uid]').length > 1) break;
    scope = up;
  }
  const lines = (scope.innerText || '').split('\\n').map(s => s.trim()).filter(s => /^I:\\s*\\d/.test(s));
  const match = lines.length ? /\\((\\d+)\\s*\\/\\s*(\\d+)\\)/.exec(lines[0]) : null;
  const ranges = [...scope.querySelectorAll('input[type=range]')].map(r => ({value: Number(r.value), min: Number(r.min), max: Number(r.max)}));
  const image = v.getCornerstoneImage && v.getCornerstoneImage();
  return {index, count: ids.length, sop: instance.SOPInstanceUID, instanceNumber: Number(instance.InstanceNumber),
    renderedIsCurrent: !!image && image.imageId === ids[index], overlay: lines.slice(0, 3),
    overlayIndex: match ? Number(match[1]) : null, overlayCount: match ? Number(match[2]) : null, ranges,
    events: (window.__acc.paneEvents || {})[id] || null};
}"""


def solve(matrix, values):
    """Exact 3x3 solve; the fiducials are far apart and never near-collinear."""
    size = 3
    rows = [list(matrix[i]) + [values[i]] for i in range(size)]
    for column in range(size):
        pivot = max(range(column, size), key=lambda r: abs(rows[r][column]))
        if abs(rows[pivot][column]) < 1e-9:
            raise AssertionError("degenerate fiducial triangle")
        rows[column], rows[pivot] = rows[pivot], rows[column]
        for r in range(size):
            if r == column:
                continue
            factor = rows[r][column] / rows[column][column]
            for c in range(column, size + 1):
                rows[r][c] -= factor * rows[column][c]
    return [rows[i][size] / rows[i][i] for i in range(size)]


class Mapping:
    """Image pixel -> client coordinates, measured from three rendered fiducials only."""

    def __init__(self, pairs):
        matrix = [[column, row, 1.0] for column, row, _, _ in pairs]
        if len(pairs) == 3:
            self.x = solve(matrix, [x for _, _, x, _ in pairs])
            self.y = solve(matrix, [y for _, _, _, y in pairs])
        else:
            # More than three marks: least squares through the normal equations, so the centroid
            # noise of each mark is averaged instead of carried whole into the affine.
            normal = [[sum(a[i] * a[j] for a in matrix) for j in range(3)] for i in range(3)]
            self.x = solve(normal, [sum(a[i] * p[2] for a, p in zip(matrix, pairs)) for i in range(3)])
            self.y = solve(normal, [sum(a[i] * p[3] for a, p in zip(matrix, pairs)) for i in range(3)])
        determinant = self.x[0] * self.y[1] - self.x[1] * self.y[0]
        self.scale = math.sqrt(abs(determinant))

    def at(self, column, row):
        return (self.x[0] * column + self.x[1] * row + self.x[2],
                self.y[0] * column + self.y[1] * row + self.y[2])

    def pixel(self, clientX, clientY):
        """The inverse, so a screen residual can be stated in image pixels and then in mm."""
        a, b, c, d = self.x[0], self.x[1], self.y[0], self.y[1]
        determinant = a * d - b * c
        dx, dy = clientX - self.x[2], clientY - self.y[2]
        return ((d * dx - b * dy) / determinant, (a * dy - c * dx) / determinant)


class ThreeDCursorAccuracyE2E(ViewerLayoutE2E):
    maxDiff = None

    # ---- fixture, page and controller -------------------------------------------------

    def study(self):
        fixture, spec = fx.build(self.stack, "D3DACC-" + uuid.uuid4().hex[:12])
        self.spec = spec
        return fixture

    def open(self, fixture, descriptions, device_scale_factor=1, viewport=None):
        context = self.browser.new_context(
            ignore_https_errors=True, viewport=viewport or {"width": 1600, "height": 1050},
            device_scale_factor=device_scale_factor)
        self.contexts.append(context)
        page = context.new_page()
        page.set_default_timeout(20000)
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

    def inject(self, page):
        """Product source, byte for byte, into the real viewer page."""
        digests = {}
        for path in (MODEL, CONTROLLER):
            source = path.read_bytes()
            digests[path.name] = hashlib.sha256(source).hexdigest()
            page.add_script_tag(content=source.decode("utf-8"))
        self.assertTrue(page.evaluate("() => !!(window.KinThreeDCursorModel && window.KinViewerThreeDCursor)"))
        return digests

    def mount(self, page):
        page.evaluate("study => {window.__acc = {study}}", self.spec["study"])
        self.assertTrue(page.evaluate(MOUNT), "the controller refused to enable over the real grid")

    def unmount(self, page):
        page.evaluate("async () => {if (window.__acc && window.__acc.cursor) await window.__acc.cursor.disable()}")

    def cells(self, page):
        """viewportId in grid order, and the series each one shows."""
        return page.evaluate("""() => [...services.viewportGridService.getState().viewports.values()]
          .sort((a, b) => a.y - b.y || a.x - b.x).map(g => {
            const v = services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);
            const ids = v.getImageIds();
            return {id: g.viewportId, type: v.type, index: v.getCurrentImageIdIndex(),
              series: cornerstone.metaData.get('instance', ids[0]).SeriesInstanceUID,
              sops: ids.map(id => cornerstone.metaData.get('instance', id).SOPInstanceUID)};
          })""")

    def pane_of(self, page, name):
        wanted = self.spec["series"][name]["seriesInstanceUID"]
        return next(cell for cell in self.cells(page) if cell["series"] == wanted)

    def show(self, page, cell, sop):
        """Move a pane to one exact SOP through the renderer, then wait for the pixels."""
        index = cell["sops"].index(sop)
        page.evaluate("""async ({id, index}) => {
          const v = services.cornerstoneViewportService.getCornerstoneViewport(id);
          await v.setImageIdIndex(index);
        }""", dict(id=cell["id"], index=index))
        page.wait_for_function("""({id, index}) => {
          const v = services.cornerstoneViewportService.getCornerstoneViewport(id);
          return v.getCurrentImageIdIndex() === index
            && v.getCornerstoneImage() && v.getCornerstoneImage().imageId === v.getCurrentImageId()
            && v.viewportStatus !== 'loading';
        }""", arg=dict(id=cell["id"], index=index), timeout=30000)
        return index

    # ---- the independent measurement ---------------------------------------------------

    def mapping(self, page, cell, series, index):
        """Measure image pixel -> client from the fiducials the renderer actually drew.

        `viewportStatus` and the held cornerstone image settle before the canvas is repainted, so the
        first read after a frame change can still be the previous frame — and every slice carries the
        same three fiducials, so a stale frame produces a perfectly plausible affine. The pick target
        is the only per-slice content, so when the slice has one, poll until the largest square is
        where this slice's target belongs; when it has none, poll on the count alone.
        """
        wanted = [target for target in fx.TARGETS
                  if target["series"] == series and target["slice"] == index]
        expected = len(fx.FIDUCIALS) + len(wanted)
        settled = None
        for _ in range(40):
            reading = page.evaluate(BLOBS, cell["id"])
            blobs = reading["blobs"]
            if len(blobs) == expected:
                if not wanted:
                    settled = "count"
                    break
                mapping = Mapping([(mark["column"], mark["row"], blob["clientX"], blob["clientY"])
                                   for mark, blob in zip(fx.FIDUCIALS, blobs)])
                if math.dist(mapping.at(wanted[0]["column"], wanted[0]["row"]),
                             (blobs[-1]["clientX"], blobs[-1]["clientY"])) <= 4:
                    settled = "target"
                    break
            page.wait_for_timeout(100)
        self.assertIsNotNone(settled, "the canvas never showed %s slice %d: %s"
                             % (series, index, json.dumps(reading)))
        for blob in blobs:
            self.assertFalse(blob["clipped"], "a square left the visible canvas: %s" % json.dumps(reading))
        pairs = [(mark["column"], mark["row"], blob["clientX"], blob["clientY"])
                 for mark, blob in zip(fx.FIDUCIALS, blobs)]
        return Mapping(pairs), blobs, reading

    ACTIVE = "() => services.viewportGridService.getActiveViewportId()"

    # The activation click this harness used to spend before every measurement is gone (B8b A' +
    # 작업지시 D-3DCURSOR-B9 3(c)). The pinned viewer still swallows nothing less: mousedown and
    # mouseup land on different nodes when an inactive pane is activated, and the `click` is
    # retargeted out of the pane. The controller reads the pointerup instead, so the measurement
    # click itself both activates the pane and picks. `focusClickPicked` now records that the
    # measured click was delivered into a pane that was not active and picked anyway.

    def pick(self, page, cell, client):
        clicks = []
        for attempt in range(2):
            before = page.evaluate("""client => {
              window.__acc.events = [];
              window.__acc.probeX = client[0]; window.__acc.probeY = client[1];
              return window.__acc.cursor.state().run;
            }""", list(client))
            page.mouse.click(client[0], client[1])
            try:
                page.wait_for_function("""before => {
                  const state = window.__acc.cursor.state();
                  return state.run > before && !state.busy;
                }""", arg=before, timeout=8000 if attempt == 0 else 30000)
            except Exception:
                clicks.append(page.evaluate("""() => ({
                  active: services.viewportGridService.getActiveViewportId(),
                  status: window.__acc.cursor.state().status, events: window.__acc.events,
                  elementAtPoint: (t => t && t.tagName + ' ' + String(t.className).slice(0, 60))(
                    document.elementFromPoint(window.__acc.probeX, window.__acc.probeY))})"""))
                continue
            # The pointerup is the pick, and it is the only event whose coordinates are not
            # rounded to whole client pixels. A click into a pane that was not active is also
            # retargeted above [data-viewport-uid], so the pane's own click listener may never see
            # it at all; the document capture always does.
            seen = page.evaluate("() => window.__acc.events.filter(e => e.phase === 'document-pointerup')")
            self.assertTrue(seen, "the pointerup never reached the document: %s"
                            % json.dumps(page.evaluate("() => window.__acc.events"), ensure_ascii=False))
            inside = page.evaluate("id => window.__acc.events.filter(e => e.phase === 'pane-bubble:' + id).length",
                                   cell["id"])
            return (page.evaluate("() => window.__acc.cursor.state()"), page.evaluate(MARKS),
                    clicks, seen[-1], inside)
        self.fail("the click at %s started no run: %s" % (client, json.dumps(clicks, ensure_ascii=False)))

    def compare(self, page, condition, target, source_cell, target_cell):
        """One pick: click a known voxel in one series, check everything the product reports."""
        source_plane = self.spec["series"][target["series"]]
        other_name = "OBLIQUE" if target["series"] == "AXIAL" else "AXIAL"
        target_plane = self.spec["series"][other_name]
        point = fx.world(source_plane, target["slice"], target["column"], target["row"])
        found = fx.project(target_plane, point)

        was_active = page.evaluate(self.ACTIVE) == source_cell["id"]
        self.show(page, source_cell, target["sop"])
        source_map, source_blobs, source_reading = self.mapping(
            page, source_cell, target["series"], target["slice"])
        # Self-check of the measurement itself: the target square is where the three fiducials say.
        client = source_map.at(target["column"], target["row"])
        measured = source_blobs[-1]
        fiducial_residual = math.dist(client, (measured["clientX"], measured["clientY"]))

        self.last_click = client
        state, marks, lost, event, pane_clicks = self.pick(page, source_cell, client)

        # The point the product was asked about is not exactly the voxel centre: the pointer lands
        # where the browser puts it. The expectation is therefore recomputed from the coordinates
        # the pointerup actually carried — still only from this test's affine and the DICOM tags —
        # and the voxel-centre figure is kept beside it as the input quantization.
        landed = source_map.pixel(event["x"], event["y"])
        asked = fx.world(source_plane, target["slice"], landed[0], landed[1])
        reached = fx.project(target_plane, asked)

        self.assertTrue(state["source"], "no point was picked: %s" % json.dumps(state))
        self.assertEqual(state["source"]["sop"], target["sop"])
        reported = state["source"]["world"]
        source_pixel = state["source"]["pixel"]

        result = next(row for row in state["panes"] if row["id"] == target_cell["id"])
        row = dict(condition=condition, target=target["id"], source=target["series"], into=other_name,
                   devicePixelRatio=source_reading["devicePixelRatio"],
                   clickedAt=list(client), deliveredAt=[event["x"], event["y"]],
                   voxelWorld=point, askedWorld=asked, reportedWorld=reported,
                   calculationMM=math.dist(reported, asked),
                   clickQuantizationMM=math.dist(asked, point),
                   voxelCentreMM=math.dist(reported, point),
                   expectedSourcePixel=list(landed), reportedSourcePixel=[source_pixel["x"], source_pixel["y"]],
                   sourcePixelErrorPX=math.dist([source_pixel["x"], source_pixel["y"]], list(landed)),
                   fiducialSelfCheckPX=fiducial_residual,
                   paneWasActive=was_active, paneSawClick=pane_clicks,
                   # True means this pick was the first click into a pane the host had taken out of
                   # the hit test — the case the removed workaround used to absorb. None means the
                   # pane was already active, so the case does not arise for that row.
                   focusClickPicked=None if was_active else True, clicksSwallowed=len(lost),
                   swallowed=lost or None,
                   expectedTargetSOP=target_plane["sopInstanceUIDs"][reached["index"]],
                   voxelTargetSOP=target_plane["sopInstanceUIDs"][found["index"]],
                   reportedTargetSOP=result.get("sop"), targetReason=result.get("reason"),
                   separationMM=reached["separation"], runnerUpMM=reached["runnerUp"],
                   marginMM=reached["runnerUp"] - reached["separation"],
                   neighbourSOPs=[target_plane["sopInstanceUIDs"][i] for i in
                                  (reached["index"] - 1, reached["index"] + 1)
                                  if 0 <= i < len(target_plane["sopInstanceUIDs"])],
                   voxelSeparationMM=found["separation"],
                   expectedTargetPixel=[reached["column"], reached["row"]])
        # A frame choice is only decidable when the point sits farther from the midpoint between two
        # slices than this harness can place it. Inside that band both neighbours are defensible, so
        # the case is recorded as a boundary rather than counted as a wrong frame.
        row["frameVerdict"] = ("exact" if result.get("sop") == row["expectedTargetSOP"]
                               else "boundary" if (result.get("sop") in row["neighbourSOPs"]
                                                   and row["marginMM"] <= 2 * row["calculationMM"])
                               else "wrong")

        if result["sop"] == row["expectedTargetSOP"]:
            target_map, _, _ = self.mapping(page, target_cell, other_name, reached["index"])
            expected_client = target_map.at(reached["column"], reached["row"])
            mark = next((m for m in marks if m["viewportId"] == target_cell["id"]), None)
            self.assertIsNotNone(mark, "the target pane carried no marker: %s" % json.dumps(marks))
            # State the marker residual in image pixels of the target frame first, so the millimetre
            # figure uses that frame's own row and column spacing instead of one averaged number.
            drawn = target_map.pixel(mark["clientX"], mark["clientY"])
            offset = (drawn[0] - reached["column"], drawn[1] - reached["row"])
            row.update(markerPX=math.dist(expected_client, (mark["clientX"], mark["clientY"])),
                       markerVisible=mark["display"] != "none",
                       screenScalePXperImagePX=target_map.scale,
                       markerImagePixelOffset=list(offset),
                       markerErrorMM=math.hypot(offset[0] * target_plane["spacing"][1],
                                                offset[1] * target_plane["spacing"][0]),
                       reportedMarkerCanvas=[result["canvas"]["x"], result["canvas"]["y"]] if result.get("canvas") else None)
            origin_mark = next((m for m in marks if m["viewportId"] == source_cell["id"]), None)
            self.assertIsNotNone(origin_mark, "the picked pane carried no marker")
            row.update(originMarkerPX=math.dist((event["x"], event["y"]),
                                                (origin_mark["clientX"], origin_mark["clientY"])))
        self.observations.append(row)
        return row

    def run_condition(self, page, condition, source, into, targets):
        source_cell, target_cell = self.pane_of(page, source), self.pane_of(page, into)
        rows = []
        for target in self.spec["targets"]:
            if target["series"] == source and target["id"] in targets:
                rows.append(self.compare(page, condition, target, source_cell, target_cell))
        return rows

    def verdict(self, rows):
        """Assert only what a correct implementation must satisfy; the numbers are already written."""
        wrong = []
        for row in rows:
            detail = {key: row[key] for key in
                      ("condition", "target", "paneWasActive", "paneSawClick", "clicksSwallowed",
                       "calculationMM", "clickQuantizationMM", "voxelCentreMM",
                       "sourcePixelErrorPX", "expectedTargetPixel", "separationMM", "runnerUpMM",
                       "marginMM", "voxelSeparationMM", "targetReason", "markerPX", "clickedAt",
                       "deliveredAt", "fiducialSelfCheckPX")
                      if key in row}
            detail["frameVerdict"] = row["frameVerdict"]
            if row["targetReason"] is not None:
                wrong.append(("refused", detail))
            elif row["frameVerdict"] not in ("exact", "boundary"):
                wrong.append(("wrong frame", detail))
            elif row["frameVerdict"] == "exact" and not row.get("markerVisible"):
                wrong.append(("marker hidden", detail))
            if row["calculationMM"] > CALCULATION_MM:
                wrong.append(("mapping over %.3f mm" % CALCULATION_MM, detail))
            if "markerPX" in row and row["markerPX"] > MARKER_PX:
                wrong.append(("marker over %.3f px" % MARKER_PX, detail))
            # Without the activation click, every measured click has to be answered the first time.
            if row["clicksSwallowed"]:
                wrong.append(("click swallowed", detail))
            if row["focusClickPicked"] is False:
                wrong.append(("inactive pane refused the first click", detail))
        self.assertEqual(wrong, [], "conditions that did not hold:\n"
                         + json.dumps(wrong, ensure_ascii=False, indent=1))

    def report(self, name):
        ARTIFACTS.mkdir(exist_ok=True)
        path = ARTIFACTS / ("three-d-cursor-accuracy-" + name + ".json")
        path.write_text(json.dumps(dict(digests=self.digests, observations=self.observations),
                                   ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        worst = dict(
            calculationMM=max(row["calculationMM"] for row in self.observations),
            clickQuantizationMM=max(row["clickQuantizationMM"] for row in self.observations),
            voxelCentreMM=max(row["voxelCentreMM"] for row in self.observations),
            sourcePixelErrorPX=max(row["sourcePixelErrorPX"] for row in self.observations),
            fiducialSelfCheckPX=max(row["fiducialSelfCheckPX"] for row in self.observations),
            markerPX=max((row["markerPX"] for row in self.observations if "markerPX" in row), default=None),
            markerErrorMM=max((row["markerErrorMM"] for row in self.observations if "markerErrorMM" in row), default=None),
            separationMM=max(row["separationMM"] for row in self.observations),
            boundaryFrames=sum(1 for row in self.observations if row.get("frameVerdict") == "boundary"),
            clicksSwallowed=sum(row["clicksSwallowed"] for row in self.observations),
            inactivePaneClicks=sum(1 for row in self.observations if not row["paneWasActive"]),
            focusClicksThatPicked=sum(1 for row in self.observations if row["focusClickPicked"]))
        print("3D CURSOR ACCURACY " + name + " " + json.dumps(dict(
            count=len(self.observations), worst=worst,
            tolerance=dict(calculationMM=CALCULATION_MM, markerPX=MARKER_PX)), ensure_ascii=False), flush=True)
        return worst

    def setUp(self):
        super().setUp()
        self.observations = []
        self.digests = {}
        self.spec = None
        self.last_click = (0, 0)

    # ---- tests --------------------------------------------------------------------------

    def test_cursor_accuracy_01_known_coordinates_in_the_real_renderer(self):
        """Every target, both directions, at the default scale and after resize/zoom-pan/rotate-flip."""
        fixture = self.study()
        originals = self.originals()
        page = self.open(fixture, ["ACC axial", "ACC oblique"])
        self.digests = self.inject(page)
        axial, oblique = self.pane_of(page, "AXIAL"), self.pane_of(page, "OBLIQUE")
        every = [target["id"] for target in fx.TARGETS]

        conditions = [("baseline", lambda: None),
                      ("resize-wider", lambda: self.resize(page, 1800, 920)),
                      ("resize-narrow-refit", lambda: self.resize(page, 1240, 880, [axial, oblique])),
                      ("zoom-pan", lambda: self.zoom_pan(page, [axial, oblique])),
                      ("rotate-flip", lambda: self.rotate_flip(page, [axial, oblique]))]
        collected = []
        try:
            for name, apply in conditions:
                apply()
                self.mount(page)
                try:
                    collected += self.run_condition(page, name, "AXIAL", "OBLIQUE", every)
                    collected += self.run_condition(page, name, "OBLIQUE", "AXIAL", every)
                finally:
                    self.unmount(page)
                page.screenshot(path=str(ARTIFACTS / ("THREE-D-CURSOR-ACCURACY-" + name + ".png")))
        finally:
            # Every condition's numbers are written before any of them is judged.
            if self.observations:
                self.report("default-scale")
        self.verdict(collected)
        self.assertTrue([row for row in collected if row["focusClickPicked"]],
                        "no condition exercised the first click into an inactive pane")
        self.assertEqual(self.originals(), originals)

    def test_cursor_accuracy_02_device_pixel_ratio_and_browser_zoom(self):
        """The same comparison at devicePixelRatio 2 and at a 125% browser-zoom equivalent."""
        fixture = self.study()
        originals = self.originals()
        every = [target["id"] for target in fx.TARGETS]
        collected = []
        try:
            for name, scale, size in [("dpr-2", 2, {"width": 1600, "height": 1050}),
                                      ("zoom-125", 1.25, {"width": 1280, "height": 840})]:
                page = self.open(fixture, ["ACC axial", "ACC oblique"], device_scale_factor=scale, viewport=size)
                self.digests = self.inject(page)
                self.assertAlmostEqual(page.evaluate("() => window.devicePixelRatio"), scale, places=6)
                axial, oblique = self.pane_of(page, "AXIAL"), self.pane_of(page, "OBLIQUE")
                for condition, apply in [(name, lambda: None),
                                         (name + "-zoom-pan", lambda: self.zoom_pan(page, [axial, oblique]))]:
                    apply()
                    self.mount(page)
                    try:
                        collected += self.run_condition(page, condition, "AXIAL", "OBLIQUE", every)
                        collected += self.run_condition(page, condition, "OBLIQUE", "AXIAL", every)
                    finally:
                        self.unmount(page)
                    page.screenshot(path=str(ARTIFACTS / ("THREE-D-CURSOR-ACCURACY-" + condition + ".png")))
        finally:
            if self.observations:
                self.report("screen-conditions")
        self.verdict(collected)
        self.assertTrue([row for row in collected if row["focusClickPicked"]],
                        "no condition exercised the first click into an inactive pane")
        self.assertEqual(self.originals(), originals)

    def test_cursor_accuracy_03_normal_oblique_is_carried_and_bad_geometry_is_refused(self):
        """A normal oblique must be transported; a foreign frame and non-unit axes must be refused."""
        fixture = self.study()
        originals = self.originals()
        page = self.open(fixture, ["ACC axial", "ACC oblique", "ACC foreign frame", "ACC skewed axes"])
        self.digests = self.inject(page)
        axial = self.pane_of(page, "AXIAL")
        oblique, foreign, skewed = (self.pane_of(page, name) for name in ("OBLIQUE", "FOREIGN", "SKEWED"))
        self.mount(page)
        try:
            state = page.evaluate("() => window.__acc.cursor.state()")
            reasons = {pane["id"]: pane["reason"] for pane in state["panes"]}
            eligible = {pane["id"]: pane["eligible"] for pane in state["panes"]}
            print("3D CURSOR ACCURACY panes " + json.dumps(dict(
                axial=[eligible[axial["id"]], reasons[axial["id"]]],
                oblique=[eligible[oblique["id"]], reasons[oblique["id"]]],
                foreign=[eligible[foreign["id"]], reasons[foreign["id"]]],
                skewed=[eligible[skewed["id"]], reasons[skewed["id"]]]), ensure_ascii=False), flush=True)
            self.assertEqual(reasons[skewed["id"]], "geometry-axes-invalid")
            self.assertFalse(eligible[skewed["id"]])
            self.assertTrue(eligible[axial["id"]] and eligible[oblique["id"]])
            self.assertIsNone(reasons[oblique["id"]], "a normal oblique must not be refused as a pane")

            target = next(t for t in self.spec["targets"] if t["id"] == "A1")
            row = self.compare(page, "four-pane", target, axial, oblique)
            self.verdict([row])
            state = page.evaluate("() => window.__acc.cursor.state()")
            outcome = {pane["id"]: pane for pane in state["panes"]}
            # The real click already decides this: only the normal oblique carries a marker, and the
            # user-visible status names how many panes were refused and why the first one was.
            self.assertTrue(outcome[oblique["id"]]["marked"])
            self.assertFalse(outcome[foreign["id"]]["marked"])
            self.assertFalse(outcome[skewed["id"]]["marked"])
            self.assertIn("2 pane(s)", state["status"])
            self.assertIn("같은 기준 좌표계가 아닙니다", state["status"])
            self.assertEqual(outcome[skewed["id"]]["reason"], "geometry-axes-invalid")
            self.assertIsNone(outcome[foreign["id"]]["reason"],
                              "a foreign frame is a per-run refusal, not an ineligible pane")
            expect(page.locator("[data-kin-3d-cursor-mark]")).to_have_count(2)
            # Per-pane reason codes are only in the run's own result, which a click discards. This
            # one call goes through the same public pick() the click handler uses; the coordinate
            # mapping it needs was already proved by the click above.
            results = page.evaluate("""async ({id, client}) => {
              const pane = window.__acc.panes().find(p => p.id === id);
              const rect = (pane.viewport.element || pane.element).getBoundingClientRect();
              return await window.__acc.cursor.pick(id, {x: client[0] - rect.left, y: client[1] - rect.top});
            }""", dict(id=axial["id"], client=list(self.last_click)))
            by_pane = {item["paneId"]: item for item in results["results"]}
            self.assertEqual(by_pane[foreign["id"]]["reason"], "identity-frame")
            self.assertEqual(by_pane[skewed["id"]]["reason"], "geometry-axes-invalid")
            self.assertTrue(by_pane[oblique["id"]]["ok"])
            print("3D CURSOR ACCURACY refusals " + json.dumps(dict(
                status=state["status"], panes=state["panes"], results=results["results"]),
                ensure_ascii=False), flush=True)
        finally:
            self.unmount(page)
        page.screenshot(path=str(ARTIFACTS / "THREE-D-CURSOR-ACCURACY-refusals.png"))
        self.report("geometry-range")
        self.assertEqual(self.originals(), originals)

    def test_cursor_accuracy_04_an_exact_tie_lands_on_the_same_slice_in_every_order(self):
        """A point exactly halfway between two slices is equally near both. The neighbour allowance
        in `compare()` covers points this harness can only place to within its own measurement;
        this test places the point exactly, from the tags, and requires one answer: the slice that
        projects lower on the target normal, whatever order the slices are handed over in.

        The point is not clicked (a click cannot land on an exact midpoint); it is computed here as
        the mean of two voxel centres from `fx.world`, and the expected slice comes from this
        module's own `fx.project`. The product model runs in the real viewer page on the metadata
        the real renderer loaded for the pane, through the same `meta` adapter the controller uses.
        """
        fixture = self.study()
        originals = self.originals()
        page = self.open(fixture, ["ACC axial", "ACC oblique"])
        self.digests = self.inject(page)
        self.mount(page)
        rows = []
        try:
            for name in ("AXIAL", "OBLIQUE"):
                plane, cell = self.spec["series"][name], self.pane_of(page, name)
                for index, column, row in ((3, 128, 128), (plane["slices"] // 2, 60, 190), (plane["slices"] - 2, 200, 40)):
                    lower, upper = fx.world(plane, index, column, row), fx.world(plane, index + 1, column, row)
                    point = [(lower[axis] + upper[axis]) / 2 for axis in range(3)]
                    expected = fx.project(plane, point)
                    # The harness's own check that the point really is a tie before it asks anything.
                    self.assertLessEqual(abs(expected["runnerUp"] - expected["separation"]), fx.TIE_MM)
                    self.assertEqual(expected["index"], index, "the lower-projection slice of the pair")
                    answers = page.evaluate("""({id, point}) => {
                      const pane = window.__acc.panes().find(p => p.id === id);
                      const metas = pane.viewport.getImageIds().map(window.__acc.meta);
                      const orders = {listed: metas, reversed: metas.slice().reverse(),
                        rotated: metas.slice(7).concat(metas.slice(0, 7)),
                        interleaved: metas.filter((_, i) => i % 2).concat(metas.filter((_, i) => !(i % 2)))};
                      const out = {};
                      for (const [key, list] of Object.entries(orders)) {
                        const built = KinThreeDCursorModel.stack(list);
                        if (!built.ok) { out[key] = {reason: built.reason}; continue; }
                        const found = KinThreeDCursorModel.locate(built.stack, point);
                        out[key] = found.ok ? {sop: found.sop, distance: found.distance, pixel: found.pixel,
                                               listedSop: list[found.index].SOPInstanceUID}
                                            : {reason: found.reason};
                      }
                      return out;
                    }""", dict(id=cell["id"], point=point))
                    record = dict(series=name, pair=[index, index + 1], point=point,
                                  expectedSOP=plane["sopInstanceUIDs"][expected["index"]],
                                  expectedSeparationMM=expected["separation"],
                                  expectedPixel=[expected["column"], expected["row"]], answers=answers)
                    rows.append(record)
                    for key, answer in answers.items():
                        self.assertNotIn("reason", answer, "%s %s refused: %s" % (name, key, json.dumps(record)))
                        self.assertEqual(answer["sop"], record["expectedSOP"], "%s %s" % (name, key))
                        self.assertEqual(answer["listedSop"], answer["sop"], "the index must point into the order given")
                        self.assertAlmostEqual(answer["distance"], plane["gap"] / 2, delta=1e-6)
                        self.assertAlmostEqual(answer["pixel"]["x"], expected["column"], delta=1e-6)
                        self.assertAlmostEqual(answer["pixel"]["y"], expected["row"], delta=1e-6)
        finally:
            self.unmount(page)
            print("3D CURSOR ACCURACY exact-tie " + json.dumps(rows, ensure_ascii=False), flush=True)
        self.assertEqual(len(rows), 6)
        self.assertEqual(self.originals(), originals)

    # ---- downscaled display (512 x 512 shown smaller than its pixel grid) ----------------

    def ds_read(self, page, cell, name, index):
        """Both fiducial triangles, the check mark and (when the slice has one) the target, measured
        from the rendered canvas; plus where the renderer itself says each mark's world point is.

        Returns None when the frame could not be measured (count never matched, or a square left the
        canvas), so the caller records the case instead of judging it."""
        plane = self.spec["series"][name]
        wanted = [t for t in fx.DS_TARGETS if t["series"] == name and t["slice"] == index]
        expected = len(fx.DS_MARKS) + len(wanted)
        reading = None
        for _ in range(60):
            reading = page.evaluate(BLOBS, cell["id"])
            blobs = reading["blobs"]
            if len(blobs) == expected:
                spread = Mapping([(m["column"], m["row"], b["clientX"], b["clientY"])
                                  for m, b in zip(fx.DS_MARKS[3:6], blobs[3:6])])
                if not wanted or math.dist(spread.at(wanted[0]["column"], wanted[0]["row"]),
                                           (blobs[-1]["clientX"], blobs[-1]["clientY"])) <= 4:
                    break
            page.wait_for_timeout(100)
        else:
            return dict(failed="count", reading=reading)
        if any(blob["clipped"] for blob in blobs):
            return dict(failed="clipped", reading=reading)
        marks = {m["name"]: (b["clientX"], b["clientY"]) for m, b in zip(fx.DS_MARKS, blobs)}
        old = Mapping([(m["column"], m["row"], *marks[m["name"]]) for m in fx.DS_MARKS[:3]])
        # The improved measurement: all six fiducials (both triangles) in one least-squares affine.
        # The check mark and the clicked target square stay out of it, so both remain held-out tests.
        new = Mapping([(m["column"], m["row"], *marks[m["name"]]) for m in fx.DS_MARKS[:6]])
        worlds = [fx.world(plane, index, m["column"], m["row"]) for m in fx.DS_MARKS]
        bundle = page.evaluate(DS_BUNDLE, dict(id=cell["id"], worlds=worlds, client=None))
        residual = {}
        for m, on_canvas, on_element in zip(fx.DS_MARKS, bundle["marksCanvas"], bundle["marksElement"]):
            seen = marks[m["name"]]
            residual[m["name"]] = dict(
                oldPX=math.dist(old.at(m["column"], m["row"]), seen),
                newPX=math.dist(new.at(m["column"], m["row"]), seen),
                bundleCanvasPX=math.dist(on_canvas, seen), bundleElementPX=math.dist(on_element, seen),
                bundleCanvasXY=[on_canvas[0] - seen[0], on_canvas[1] - seen[1]])
        for m in fx.DS_MARKS:
            residual[m["name"]]["seen"] = list(marks[m["name"]])
        return dict(old=old, new=new, marks=marks, residual=residual, bundle=bundle,
                    target=(blobs[-1]["clientX"], blobs[-1]["clientY"]) if wanted else None,
                    canvas=reading["canvas"], devicePixelRatio=reading["devicePixelRatio"])

    def ds_compare(self, page, condition, pair, target, source_cell, target_cell):
        source_name = target["series"]
        other_name = pair[1] if source_name == pair[0] else pair[0]
        source_plane, target_plane = self.spec["series"][source_name], self.spec["series"][other_name]
        row = dict(condition=condition, pair="/".join(pair), target=target["id"], source=source_name, into=other_name)
        self.show(page, source_cell, target["sop"])
        src = self.ds_read(page, source_cell, source_name, target["slice"])
        if "failed" in src:
            row.update(unmeasured="source " + src["failed"])
            self.observations.append(row)
            return row
        client = src["new"].at(target["column"], target["row"])
        before = page.evaluate(DS_PANE, target_cell["id"])
        source_before = page.evaluate(DS_PANE, source_cell["id"])
        state, marks, lost, event, _ = self.pick(page, source_cell, client)
        delivered = [event["x"], event["y"]]
        source_after = page.evaluate(DS_PANE, source_cell["id"])
        row.update(sourcePaneMoved=source_after["index"] != source_before["index"])
        reported = state["source"]["world"] if state["source"] else None
        bundle = page.evaluate(DS_BUNDLE, dict(id=source_cell["id"], worlds=[], client=delivered))
        spacing = source_plane["spacing"]
        # The target square is drawn at the clicked pixel: its measured centre against each affine
        # is the harness's own residual at this click, in CSS px and in source millimetres.
        click_residual = {}
        for method in ("old", "new"):
            px = math.dist(src[method].at(target["column"], target["row"]), src["target"])
            click_residual[method] = dict(px=px, mm=px / src[method].scale * max(spacing))
        row.update(clickResidual=click_residual)
        row.update(devicePixelRatio=src["devicePixelRatio"], canvas=src["canvas"],
                   canvasRect=bundle["canvasRect"], elementRect=bundle["elementRect"],
                   sourceScale=src["new"].scale, sourceScaleOld=src["old"].scale,
                   clicksSwallowed=len(lost), deliveredAt=delivered, reportedWorld=reported,
                   sourceResidual=src["residual"],
                   # Where the renderer itself puts the delivered point, both ways the canvas origin
                   # could be read; the product's own world is compared with each.
                   bundleClickCanvasWorld=bundle.get("clickCanvasWorld"),
                   bundleClickElementWorld=bundle.get("clickElementWorld"))
        if reported is None:
            row.update(unmeasured="no source point: " + str(state.get("status")))
            self.observations.append(row)
            return row
        row.update(productVsBundleCanvasMM=math.dist(reported, bundle["clickCanvasWorld"]),
                   productVsBundleElementMM=math.dist(reported, bundle["clickElementWorld"]))
        result = next(r for r in state["panes"] if r["id"] == target_cell["id"])
        row.update(reportedTargetSOP=result.get("sop"), targetReason=result.get("reason"))
        for method in ("old", "new"):
            mapping = src[method]
            landed = mapping.pixel(*delivered)
            asked = fx.world(source_plane, target["slice"], landed[0], landed[1])
            reached = fx.project(target_plane, asked)
            error = [reported[a] - asked[a] for a in range(3)]
            u, v = source_plane["orientation"][:3], source_plane["orientation"][3:]
            # The product's error in the source image grid, then on screen at this scale.
            ex, ey = fx.dot(error, u) / spacing[1], fx.dot(error, v) / spacing[0]
            # The renderer's own canvasToWorld of the same delivered point, without any correction:
            # what the product reported before it exchanged coordinates in buffer units.
            raw = bundle["clickCanvasWorld"]
            rx, ry = (fx.dot([raw[a] - asked[a] for a in range(3)], u) / spacing[1],
                      fx.dot([raw[a] - asked[a] for a in range(3)], v) / spacing[0])
            raw_reached = fx.project(target_plane, raw)
            row[method] = dict(calculationMM=math.dist(reported, asked), errorImagePX=[ex, ey],
                               rendererRawCalculationMM=math.dist(raw, asked), rendererRawErrorImagePX=[rx, ry],
                               rendererRawSameSlice=raw_reached["index"] == reached["index"],
                               errorScreenPX=math.hypot(ex, ey) * mapping.scale,
                               expectedTargetSOP=target_plane["sopInstanceUIDs"][reached["index"]],
                               expectedTargetIndex=reached["index"], separationMM=reached["separation"],
                               marginMM=reached["runnerUp"] - reached["separation"],
                               expectedTargetPixel=[reached["column"], reached["row"]])
            row[method]["sameSlice"] = result.get("sop") == row[method]["expectedTargetSOP"]
            # Inside the band this measurement cannot resolve (the point within its own calculation
            # figure of the midpoint between two slices) the positional neighbour is as defensible.
            chosen = (target_plane["sopInstanceUIDs"].index(result["sop"])
                      if result.get("sop") in target_plane["sopInstanceUIDs"] else None)
            row[method]["boundary"] = (not row[method]["sameSlice"] and chosen is not None
                                       and abs(chosen - reached["index"]) == 1
                                       and row[method]["marginMM"] <= 2 * row[method]["calculationMM"])
        mark = next((m for m in marks if m["viewportId"] == target_cell["id"]), None)
        row.update(targetMarked=mark is not None)
        if result.get("sop") in target_plane["sopInstanceUIDs"] and mark:
            shown = target_plane["sopInstanceUIDs"].index(result["sop"])
            tgt = self.ds_read(page, target_cell, other_name, shown)
            if "failed" in tgt:
                row.update(targetUnmeasured=tgt["failed"])
            else:
                row.update(targetScale=tgt["new"].scale, targetResidual=tgt["residual"])
                rect = page.evaluate(DS_BUNDLE, dict(id=target_cell["id"], worlds=[], client=None))["canvasRect"]
                for method in ("old", "new"):
                    if row[method]["sameSlice"] or row[method]["boundary"]:
                        # Projected independently onto the slice that is actually shown: for an
                        # allowed neighbour that is not the nearest slice's own pixel.
                        landed = src[method].pixel(*delivered)
                        asked = fx.world(source_plane, target["slice"], landed[0], landed[1])
                        expected_client = tgt[method].at(*fx.pixel_on(target_plane, shown, asked))
                        inside = (rect["left"] <= expected_client[0] <= rect["left"] + rect["width"]
                                  and rect["top"] <= expected_client[1] <= rect["top"] + rect["height"])
                        row[method]["markerVisible"] = mark["display"] != "none"
                        row[method]["expectedInsideCanvas"] = inside
                        # A marker for a point outside the visible pane is hidden by design.
                        if row[method]["markerVisible"]:
                            row[method]["markerPX"] = math.dist(expected_client, (mark["clientX"], mark["clientY"]))
        # Slice number on the moved pane, read once the run is over (the overlay is React state).
        after = None
        for _ in range(20):
            after = page.evaluate(DS_PANE, target_cell["id"])
            if after["overlay"] and after["overlayIndex"] == after["index"] + 1:
                break
            page.wait_for_timeout(100)
        row.update(paneBefore=before, paneAfter=after)
        self.observations.append(row)
        return row

    def test_cursor_accuracy_05_downscaled_512_display(self):
        """512 x 512 series at real-CT pixel spacings, shown smaller than their pixel grid.

        The same comparison as test 01 under every downscaled layout, measured two ways at once: with
        the original small fiducial triangle (the method as it was) and with a large triangle spread
        over the image, each judged against a check mark it was not fitted to and against the clicked
        target square itself (the residual at each click). The renderer's
        own worldToCanvas of every mark is recorded beside the measured centroids, so a mismatch
        between where the renderer draws and where it maps can be told apart from the harness."""
        rows = []
        for pair in (("DSGE", "DSCO"), ("DSPH", "DSCO")):
            fixture, spec = fx.build(self.stack, "D3DACC-" + uuid.uuid4().hex[:12], label="downscale",
                                     names=list(pair))
            self.spec = spec
            descriptions = [fx.DS_SERIES[name]["description"] for name in pair]
            # Two device pixel ratios. Where the renderer has fewer device pixels than image pixels
            # (ratio 2 at 0.43 screen px per image px) it minifies the image and the drawn squares
            # alias by up to half an image pixel, which no harness can see past (measured: 0.43 mm),
            # so there the millimetre figure is recorded, not judged; everything else still is. The
            # same 0.43 layout is measured again at ratio 3, where it is not minified, in full.
            for ratio, plan in ((2, ("baseline", "resize-wider", "narrow-refit-880", "zoom-pan", "refit-800",
                                     "refit-740", "refit-650", "rotate-flip", "refit-560")),
                                (3, ("refit-560", "rotate-flip"))):
                page = self.open(fixture, descriptions, device_scale_factor=ratio, viewport={"width": 1600, "height": 1050})
                self.digests = self.inject(page)
                cells = lambda: [self.pane_of(page, name) for name in pair]
                steps = {"baseline": lambda: None,
                         "resize-wider": lambda: self.resize(page, 1800, 920),
                         "narrow-refit-880": lambda: self.resize(page, 1240, 880, cells()),
                         "zoom-pan": lambda: self.zoom_pan(page, cells()),
                         "refit-800": lambda: self.resize(page, 1100, 800, cells()),
                         "refit-740": lambda: self.resize(page, 1000, 740, cells()),
                         "refit-650": lambda: self.resize(page, 900, 650, cells()),
                         "refit-560": lambda: self.resize(page, 820, 560, cells()),
                         "rotate-flip": lambda: self.rotate_flip(page, cells())}
                try:
                    for step in plan:
                        name = "ds%d-%s" % (ratio, step)
                        steps[step]()
                        self.mount(page)
                        page.evaluate(DS_EVENTS)
                        try:
                            first, second = cells()
                            for target in self.spec["targets"]:
                                source_cell, target_cell = (first, second) if target["series"] == pair[0] else (second, first)
                                rows.append(self.ds_compare(page, name, pair, target, source_cell, target_cell))
                        finally:
                            self.unmount(page)
                        page.screenshot(path=str(ARTIFACTS / ("THREE-D-CURSOR-ACCURACY-" + name + "-" + pair[0] + ".png")))
                finally:
                    ARTIFACTS.mkdir(exist_ok=True)
                    (ARTIFACTS / "three-d-cursor-accuracy-downscale.json").write_text(
                        json.dumps(dict(digests=self.digests, rows=rows), ensure_ascii=False, indent=1, default=str) + "\n",
                        encoding="utf-8")
        summary = {}
        for row in rows:
            key = row["condition"]
            s = summary.setdefault(key, dict(n=0, unmeasured=0, scales=[], old=dict(calc=[], marker=[], same=0),
                                             new=dict(calc=[], marker=[], same=0), checkNewPX=[], checkOldPX=[],
                                             bundleCanvasPX=[], productVsBundleCanvasMM=[], productVsBundleElementMM=[],
                                             overlayStale=0, overlayRead=0))
            s["n"] += 1
            if "unmeasured" in row:
                s["unmeasured"] += 1
                continue
            s["scales"].append(round(row["sourceScale"], 3))
            s["checkNewPX"].append(row["sourceResidual"]["check"]["newPX"])
            s["checkOldPX"].append(row["sourceResidual"]["check"]["oldPX"])
            s.setdefault("clickNewPX", []).append(row["clickResidual"]["new"]["px"])
            s.setdefault("clickOldPX", []).append(row["clickResidual"]["old"]["px"])
            s["bundleCanvasPX"].append(max(r["bundleCanvasPX"] for r in row["sourceResidual"].values()))
            s["productVsBundleCanvasMM"].append(row["productVsBundleCanvasMM"])
            s["productVsBundleElementMM"].append(row["productVsBundleElementMM"])
            for method in ("old", "new"):
                s[method]["calc"].append(row[method]["calculationMM"])
                s[method]["same"] += row[method]["sameSlice"]
                s[method]["boundary"] = s[method].get("boundary", 0) + row[method]["boundary"]
                s[method].setdefault("rawCalc", []).append(row[method]["rendererRawCalculationMM"])
                s[method]["rawSame"] = s[method].get("rawSame", 0) + row[method]["rendererRawSameSlice"]
                if "markerPX" in row[method]:
                    s[method]["marker"].append(row[method]["markerPX"])
            after = row.get("paneAfter") or {}
            if after.get("overlay"):
                s["overlayRead"] += 1
                s["overlayStale"] += after.get("overlayIndex") != after.get("index", -2) + 1
        top = lambda values: max(values) if values else None
        printable = {key: dict(n=s["n"], unmeasured=s["unmeasured"], scale=[min(s["scales"] or [0]), max(s["scales"] or [0])],
                               calcOldMax=top(s["old"]["calc"]), calcNewMax=top(s["new"]["calc"]),
                               markerOldMax=top(s["old"]["marker"]), markerNewMax=top(s["new"]["marker"]),
                               sameOld=s["old"]["same"], sameNew=s["new"]["same"],
                               boundaryNew=s["new"].get("boundary", 0),
                               rendererRawCalcNewMax=top(s["new"].get("rawCalc", [])),
                               rendererRawSameNew=s["new"].get("rawSame", 0),
                               checkResidualNewMaxPX=top(s["checkNewPX"]), checkResidualOldMaxPX=top(s["checkOldPX"]),
                               clickResidualNewMaxPX=top(s.get("clickNewPX", [])),
                               clickResidualOldMaxPX=top(s.get("clickOldPX", [])),
                               bundleDrawVsMapMaxPX=top(s["bundleCanvasPX"]),
                               productVsBundleCanvasMaxMM=top(s["productVsBundleCanvasMM"]),
                               productVsBundleElementMaxMM=top(s["productVsBundleElementMM"]),
                               overlayRead=s["overlayRead"], overlayStale=s["overlayStale"])
                     for key, s in summary.items()}
        print("3D CURSOR ACCURACY downscale " + json.dumps(printable, ensure_ascii=False), flush=True)
        unmeasured = [dict(condition=row["condition"], target=row["target"], why=row["unmeasured"])
                      for row in rows if "unmeasured" in row]
        self.assertEqual(unmeasured, [], "picks the harness could not measure")
        failing = []
        for row in rows:
            new, after = row["new"], row.get("paneAfter") or {}
            problems = []
            if row["targetReason"] is not None:
                problems.append("refused " + row["targetReason"])
            # Minified display: fewer device pixels than image pixels on either pane. The harness
            # cannot resolve 0.3 mm there, so the two millimetre checks are recorded only.
            minified = row["devicePixelRatio"] * min(row["sourceScale"], row.get("targetScale", row["sourceScale"])) < 1
            row["millimetresUndecidable"] = minified
            if new["calculationMM"] > CALCULATION_MM and not minified:
                problems.append("mapping over %.3f mm" % CALCULATION_MM)
            if not (new["sameSlice"] or new["boundary"]):
                problems.append("not the nearest slice of the delivered click")
            # Every marker is measured: a missing marker, an unmeasurable target frame or a hidden
            # marker for a point inside the pane is a failure, never a skipped row.
            if not row.get("targetMarked"):
                problems.append("no marker on the target pane")
            if "targetUnmeasured" in row:
                problems.append("target frame not measurable: " + row["targetUnmeasured"])
            elif new["sameSlice"] or new["boundary"]:
                if "markerVisible" not in new:
                    problems.append("marker not evaluated")
                elif not new["markerVisible"]:
                    if new.get("expectedInsideCanvas"):
                        problems.append("marker hidden inside the pane")
                elif new["markerPX"] > MARKER_PX:
                    problems.append("marker over %.3f px" % MARKER_PX)
            if row["clickResidual"]["new"]["mm"] > CALCULATION_MM and not minified:
                problems.append("the harness cannot resolve this click (its own residual over %.3f mm)" % CALCULATION_MM)
            if row["sourcePaneMoved"]:
                problems.append("the picked pane moved")
            # Judged only where the product moved the pane: this harness moves the picked pane with a
            # direct setImageIdIndex() of its own, which leaves that pane's number behind by itself.
            moved = (row.get("paneBefore") or {}).get("index") != after.get("index")
            if moved and (after.get("overlayIndex") != after.get("index", -2) + 1 or not after.get("ranges")
                          or after["ranges"][0]["value"] != after.get("index")):
                problems.append("slice number or scroll bar does not follow the moved pane")
            if problems:
                failing.append(dict(condition=row["condition"], target=row["target"], problems=problems,
                                    calc=new["calculationMM"], marker=new.get("markerPX"), margin=new["marginMM"],
                                    overlay=after.get("overlay"), index=after.get("index")))
        # Written again now that every row carries its millimetresUndecidable flag.
        (ARTIFACTS / "three-d-cursor-accuracy-downscale.json").write_text(
            json.dumps(dict(digests=self.digests, rows=rows), ensure_ascii=False, indent=1, default=str) + "\n",
            encoding="utf-8")
        undecidable = [row for row in rows if row.get("millimetresUndecidable")]
        print("3D CURSOR ACCURACY downscale minified " + json.dumps(dict(
            rows=len(undecidable),
            calculationMaxMM=max((row["new"]["calculationMM"] for row in undecidable), default=None),
            harnessClickResidualMaxMM=max((row["clickResidual"]["new"]["mm"] for row in undecidable), default=None))),
            flush=True)
        self.assertEqual(failing, [], json.dumps(failing, indent=1, ensure_ascii=False))

    # ---- screen conditions ---------------------------------------------------------------

    def resize(self, page, width, height, refit=None):
        """The pinned viewer keeps each pane's camera across a window resize, so a narrower window
        pushes part of the image off the canvas until the reader refits it with the product's own
        'fit to window' key. Both halves of that behaviour are measured: a wider window with the
        camera untouched, and a narrower one the reader refits."""
        page.set_viewport_size({"width": width, "height": height})
        page.wait_for_timeout(400)
        for cell in refit or []:
            box = page.locator('[data-viewport-uid="' + cell["id"] + '"] canvas').bounding_box()
            page.mouse.click(box["x"] + box["width"] * .5, box["y"] + box["height"] * .3)
            page.keyboard.press("=")
            page.wait_for_timeout(200)
        canvas_ready(page, len(self.cells(page)))

    def zoom_pan(self, page, cells):
        """Renderer zoom/pan, the way test_preview_controls.py already drives the pinned viewport.
        Bounded so every fiducial stays on the canvas; a larger zoom is the harness's limit, not the
        product's."""
        page.evaluate("""async ids => {
          for (const id of ids) {
            const v = services.cornerstoneViewportService.getCornerstoneViewport(id);
            v.setZoom(v.getZoom() * 1.15);
            const pan = v.getPan();
            v.setPan([pan[0] + 22, pan[1] - 18]);
            v.render();
          }
        }""", [cell["id"] for cell in cells])
        page.wait_for_timeout(300)

    def rotate_flip(self, page, cells):
        """The product's own keyboard path: Shift+R turns the selected pane, Shift+H flips it."""
        for index, cell in enumerate(cells):
            box = page.locator('[data-viewport-uid="' + cell["id"] + '"] canvas').bounding_box()
            page.mouse.click(box["x"] + box["width"] * .5, box["y"] + box["height"] * .3)
            page.keyboard.press("Shift+R")
            page.wait_for_timeout(150)
            if index == 1:
                page.keyboard.press("Shift+H")
                page.wait_for_timeout(150)
        applied = page.evaluate("""ids => ids.map(id => {
          const c = services.cornerstoneViewportService.getCornerstoneViewport(id).getCamera();
          return {rotation: c.rotation, flipHorizontal: c.flipHorizontal};
        })""", [cell["id"] for cell in cells])
        print("3D CURSOR ACCURACY rotate-flip " + json.dumps(applied), flush=True)
        self.assertTrue(any(item["rotation"] for item in applied), "rotation was not applied")
        self.assertTrue(any(item["flipHorizontal"] for item in applied), "flip was not applied")
        page.wait_for_timeout(200)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ThreeDCursorAccuracyE2E(name)
                              for name in loader.getTestCaseNames(ThreeDCursorAccuracyE2E)
                              if name.startswith("test_cursor_accuracy_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
