# coding: utf-8
"""TEST-3D-CURSOR-ACCURACY: the 3D cursor in the real pinned renderer, checked two ways.

`three_d_cursor_model_test.cjs` and `viewer_three_d_cursor_dom_test.py` both compute their
expectations with the same transform the code under test uses, so a shared origin error survives
both (검토결과-D-3DCURSOR-801AD73 §4-1). Nothing here calls a product function to decide where to
click or where a marker should be:

  * the patient coordinate of a pick is `IPP + i*columnSpacing*u + j*rowSpacing*v` computed in
    Python from the tags the fixture wrote (`three_d_cursor_accuracy_fixture.world`);
  * the target frame, its separation `|n.(p-o)|` and the projected pixel come from this test's own
    `project()`, not from `three-d-cursor-model.js`;
  * image pixel -> screen comes from saturated fiducial squares at fixed asymmetric pixel positions
    on every slice, re-measured under every screen condition.

Where the squares are read from decides what a test can claim, and there are two readings:

  A. Agreement of transforms (tests 01, 02, 05). The squares are read from the canvas's drawing
     buffer and turned into client coordinates as `rect.left + x * rect.width / canvas.width`. That
     is the same buffer-to-box conversion the product uses, so these tests show that the product's
     chain of transforms (click -> patient point -> slice -> marker) agrees with an independent
     chain built on that conversion. They never look at the screen and cannot see an error in the
     conversion itself. Their tolerances (0.3 mm, 0.5 CSS px) bound that agreement; they are not a
     statement of how accurately a reader can point.
  B. Positions on the screen (tests 06 to 09). The squares, and the marker the product painted,
     are read from a screenshot of the composited page in device pixels. The point the reader
     really pressed is the pressed pixel's own square as the screenshot shows it, plus the
     pointer's offset from it; the product's point and its marker are judged against that in
     device pixels. One device pixel is 0.2 to 1.3 mm of the series in these layouts, so these
     tolerances correspond to a few millimetres in the most downscaled layout, never to 0.3 mm.

The product is not modified and `config/ohif.js` is not touched: the tests inject
`three-d-cursor-model.js` and `viewer-three-d-cursor.js` verbatim (sha256 recorded in the
observations) into the real viewer page and mount the controller over the real StackViewports,
with a `meta` adapter built from `cornerstone.metaData.get('instance', …)` and the study row's
`sourcePatientKey` — the same two sources a real `config/ohif.js` integration has. Test 09 uses
the controller the served config itself mounted instead.

Failing conditions are reported with their numbers, never repaired here.
"""
import hashlib
import io
import json
import math
import unittest
import uuid
from pathlib import Path

import numpy as np
from PIL import Image
from playwright.sync_api import expect

import three_d_cursor_accuracy_fixture as fx
from test_prior_selection import canvas_ready
from test_viewer_layout import ViewerLayoutE2E
from viewer_tools import select_image_tool

ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT / "worklist-v0/hpacs-lite/three-d-cursor-model.js"
CONTROLLER = ROOT / "worklist-v0/hpacs-lite/viewer-three-d-cursor.js"
ARTIFACTS = Path(__file__).parent / "artifacts"

# A. Agreement of transforms. The product's point and marker against this harness's own chain,
# both built on the same buffer-to-box conversion. The millimetre figure is taken at the coordinates
# the click was actually delivered at and carries the harness's own affine residual inside it, so
# 0.3 mm bounds that sum; it is not an accuracy against the screen. Click quantization stays
# reported-only: a real mouse cannot land between whole client pixels.
AGREEMENT_MM = 0.3
AGREEMENT_MARKER_PX = 0.5
# The product hands the renderer buffer-unit coordinates. Against the renderer's own answer for the
# buffer-unit point this harness computes from the page, the two must be the same point: this is
# arithmetic on one renderer call, so the allowance (a micrometre) is only for floating point and
# for the product putting the point back on the slice plane.
EXCHANGE_MM = 1e-3
# B. Positions on the screen, Euclidean, in device pixels of a screenshot: the point the product
# reports against the point really pressed, and the marker as painted against where that point is
# shown on the target pane. Engineering limits set just above what was measured (1.44 and 2.53);
# in the most downscaled layout here they are about 2 and 3 mm of the series.
SCREEN_CLICK_DEVICE_PX = 2.0
SCREEN_MARKER_DEVICE_PX = 3.0
# The sentence the product shows when a pane's drawing buffer is not one the renderer makes at the
# present device ratio (reason code pane-anchor).
BUFFER_REFUSED = "영상 표시 요소를 확인하지 못했습니다."
CONFIG_PATH = "/ohif/app-config.js"
CURSOR_FLAG = "kinThreeDCursor: { enabled: true }"

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
    // The same client point in the renderer's own units: buffer pixels, over the device ratio on
    // the GPU path and as they are on the CPU path.
    const unit = v.useCPURendering === true ? 1 : window.devicePixelRatio;
    out.clickBufferWorld = Array.from(v.canvasToWorld([
      (client[0] - c.left) * canvas.width / (c.width * unit),
      (client[1] - c.top) * canvas.height / (c.height * unit)]));
  }
  return out;
}"""

# ---- B. positions on the screen ---------------------------------------------------------------

# Everything inside a pane except the renderer's canvas (and, on request, the marker) is hidden for
# the moment of a screenshot. visibility never changes layout, so no canvas is resized by it. The
# viewer may rebuild a pane's wrapper, so the scope is tagged again before every use.
SCREEN_HIDE = """mode => {
  if (!document.getElementById('acc-screen-style')) {
    const style = document.createElement('style');
    style.id = 'acc-screen-style';
    style.textContent = [
      'html[data-acc-hide] [data-acc-scope] * { visibility: hidden !important; }',
      'html[data-acc-hide] [data-acc-scope] canvas.cornerstone-canvas { visibility: visible !important; }',
      'html[data-acc-hide="marker"] [data-acc-scope] [data-kin-3d-cursor-mark] { visibility: visible !important; }',
    ].join('\\n');
    document.head.append(style);
  }
  for (const host of document.querySelectorAll('[data-viewport-uid]')) {
    let scope = host;
    for (let up = host.parentElement, n = 0; up && n < 6; up = up.parentElement, n++) {
      if (up.querySelectorAll('[data-viewport-uid]').length > 1) break;
      scope = up;
    }
    scope.setAttribute('data-acc-scope', host.getAttribute('data-viewport-uid'));
  }
  if (mode) document.documentElement.setAttribute('data-acc-hide', mode);
  else document.documentElement.removeAttribute('data-acc-hide');
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));
}"""

# One pane's canvas as the page reports it: where its box is, how large its buffer is, which frame
# it holds. The box only says where in a screenshot to look; no position is computed from it.
PANE_BOX = """id => {
  const host = document.querySelector('[data-viewport-uid="' + id + '"]');
  const v = services.cornerstoneViewportService.getCornerstoneViewport(id);
  const canvas = host.querySelector('canvas.cornerstone-canvas');
  const box = r => ({left: r.left, top: r.top, width: r.width, height: r.height});
  const image = v.getCornerstoneImage && v.getCornerstoneImage();
  return {buffer: [canvas.width, canvas.height], client: [canvas.clientWidth, canvas.clientHeight],
    copied: [v.sWidth, v.sHeight], cpu: v.useCPURendering === true,
    rect: box(canvas.getBoundingClientRect()), elementRect: box((v.element || host).getBoundingClientRect()),
    dpr: window.devicePixelRatio, inner: [window.innerWidth, window.innerHeight],
    active: services.viewportGridService.getActiveViewportId() === id,
    index: v.getCurrentImageIdIndex(), status: v.viewportStatus,
    renderedIsCurrent: !!image && image.imageId === v.getCurrentImageId()};
}"""

# What the reader sees on one pane besides the image: the slice number, the scroll bar, and whether
# the viewer's own "Loading..." cover is up.
PANE_VIEW = """id => {
  const v = services.cornerstoneViewportService.getCornerstoneViewport(id);
  const host = document.querySelector('[data-viewport-uid="' + id + '"]');
  const ids = v.getImageIds(), index = v.getCurrentImageIdIndex();
  const instance = cornerstone.metaData.get('instance', ids[index]) || {};
  let scope = host;
  for (let up = host.parentElement, n = 0; up && n < 6; up = up.parentElement, n++) {
    if (up.querySelectorAll('[data-viewport-uid]').length > 1) break;
    scope = up;
  }
  const text = scope.innerText || '';
  const lines = text.split('\\n').map(s => s.trim()).filter(s => /^I:\\s*\\d/.test(s));
  const match = lines.length ? /\\((\\d+)\\s*\\/\\s*(\\d+)\\)/.exec(lines[0]) : null;
  const ranges = [...scope.querySelectorAll('input[type=range]')].map(r => Number(r.value));
  const image = v.getCornerstoneImage && v.getCornerstoneImage();
  return {index, count: ids.length, sop: instance.SOPInstanceUID,
    renderedIsCurrent: !!image && image.imageId === ids[index], status: v.viewportStatus,
    overlayIndex: match ? Number(match[1]) : null, ranges, loading: /Loading\\.\\.\\./.test(text)};
}"""

# The two stack events in the order each pane's element received them. Observation only; one pair
# of listeners per element however often the controller is mounted again.
SEQUENCE = """() => {
  const E = cornerstone.Enums.Events;
  window.__acc.sequence = [];
  window.__accSequenced = window.__accSequenced || new WeakSet();
  const note = (id, kind, index) => { if (window.__acc && window.__acc.sequence) window.__acc.sequence.push([id, kind, index]); };
  for (const pane of window.__acc.panes()) {
    const element = pane.viewport.element || pane.element, id = pane.id;
    if (window.__accSequenced.has(element)) continue;
    window.__accSequenced.add(element);
    element.addEventListener(E.STACK_VIEWPORT_SCROLL, event => note(id, 'scroll', event.detail && event.detail.newImageIdIndex));
    element.addEventListener(E.STACK_NEW_IMAGE, event => note(id, 'image', event.detail && event.detail.imageIdIndex));
  }
  return true;
}"""

# The controller the served config mounted, read through the product's own observation hook, in the
# shape the helpers below expect. Nothing is mounted and nothing is injected.
ADOPT = """study => {
  const grid = () => [...services.viewportGridService.getState().viewports.values()]
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const panes = () => grid().map(g => {
    const viewport = services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);
    const element = document.querySelector('[data-viewport-uid="' + g.viewportId + '"]');
    return viewport && element ? {id: g.viewportId, element, viewport} : null;
  }).filter(Boolean);
  window.__acc = {study, panes, events: [], cursor: {state: () => kinViewerThreeDCursorState().cursor}};
  const note = (phase, event) => window.__acc.events.push({phase, x: event.clientX, y: event.clientY});
  document.addEventListener('pointerup', event => note('document-pointerup', event), true);
  return true;
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
    loading: /Loading\\.\\.\\./.test(scope.innerText || ''),
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

    def open(self, fixture, descriptions, device_scale_factor=1, viewport=None, config=None, prepare=None):
        context = self.browser.new_context(
            ignore_https_errors=True, viewport=viewport or {"width": 1600, "height": 1050},
            device_scale_factor=device_scale_factor)
        self.contexts.append(context)
        if config:
            context.route(self.stack.proxy + CONFIG_PATH, config)
        page = context.new_page()
        if prepare:
            prepare(page)
        return self.enter(page, fixture, descriptions)

    def enter(self, page, fixture, descriptions):
        """Log in and bring the named series up in the real viewer, on a page the caller made."""
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
            if row["calculationMM"] > AGREEMENT_MM:
                wrong.append(("transforms disagree by over %.3f mm" % AGREEMENT_MM, detail))
            if "markerPX" in row and row["markerPX"] > AGREEMENT_MARKER_PX:
                wrong.append(("marker transforms disagree by over %.3f px" % AGREEMENT_MARKER_PX, detail))
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
            agreementTolerance=dict(calculationMM=AGREEMENT_MM, markerPX=AGREEMENT_MARKER_PX)), ensure_ascii=False), flush=True)
        return worst

    def setUp(self):
        super().setUp()
        self.observations = []
        self.digests = {}
        self.spec = None
        self.last_click = (0, 0)

    # ---- tests --------------------------------------------------------------------------

    def test_cursor_accuracy_01_transform_agreement_with_known_coordinates(self):
        """Agreement of transforms: every target, both directions, at the default scale and after
        resize/zoom-pan/rotate-flip."""
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

    def test_cursor_accuracy_02_transform_agreement_at_ratio_2_and_a_125_percent_zoom(self):
        """Agreement of transforms at devicePixelRatio 2 and at a 125% browser-zoom equivalent."""
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
        # In the slice plane only: the product puts the renderer's point back on the plane.
        apart = [reported[a] - bundle["clickBufferWorld"][a] for a in range(3)]
        row.update(productVsBundleCanvasMM=math.dist(reported, bundle["clickCanvasWorld"]),
                   productVsBundleElementMM=math.dist(reported, bundle["clickElementWorld"]),
                   bufferUnitsMM=math.hypot(fx.dot(apart, source_plane["orientation"][:3]),
                                            fx.dot(apart, source_plane["orientation"][3:])))
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

    def agreement_problems(self, row):
        """What one measured ds_compare() row fails, as sentences. Agreement of transforms only."""
        new, after = row["new"], row.get("paneAfter") or {}
        problems = []
        if row["targetReason"] is not None:
            problems.append("refused " + row["targetReason"])
        # Minified display: fewer device pixels than image pixels on either pane. A buffer reading
        # cannot resolve 0.3 mm there, so the two millimetre checks are recorded only.
        minified = row["devicePixelRatio"] * min(row["sourceScale"], row.get("targetScale", row["sourceScale"])) < 1
        row["millimetresUndecidable"] = minified
        if new["calculationMM"] > AGREEMENT_MM and not minified:
            problems.append("transforms disagree by over %.3f mm" % AGREEMENT_MM)
        # Not a measurement and never undecidable: the product's point against the renderer's own
        # answer for the same click in buffer units.
        if row["bufferUnitsMM"] > EXCHANGE_MM:
            problems.append("the point is not the renderer's answer for the click in buffer units (%.4f mm apart)"
                            % row["bufferUnitsMM"])
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
            elif new["markerPX"] > AGREEMENT_MARKER_PX:
                problems.append("marker transforms disagree by over %.3f px" % AGREEMENT_MARKER_PX)
        if row["clickResidual"]["new"]["mm"] > AGREEMENT_MM and not minified:
            problems.append("the harness cannot resolve this click (its own residual over %.3f mm)" % AGREEMENT_MM)
        if row["sourcePaneMoved"]:
            problems.append("the picked pane moved")
        # Judged only where the product moved the pane: this harness moves the picked pane with a
        # direct setImageIdIndex() of its own, which leaves that pane's number behind by itself.
        moved = (row.get("paneBefore") or {}).get("index") != after.get("index")
        if moved and (after.get("overlayIndex") != after.get("index", -2) + 1 or not after.get("ranges")
                      or after["ranges"][0]["value"] != after.get("index")):
            problems.append("slice number or scroll bar does not follow the moved pane")
        if after.get("loading"):
            problems.append("the viewer's Loading cover is left up on the target pane")
        return problems

    def test_cursor_accuracy_05_transform_agreement_on_a_downscaled_512_display(self):
        """Agreement of transforms on 512 x 512 series at real-CT pixel spacings, shown smaller than
        their pixel grid, at device pixel ratios 1, 1.25, 1.5, 2 and 3.

        The same comparison as test 01 under every downscaled layout, with the squares read from the
        canvas buffer two ways at once: with the original small fiducial triangle (the method as it
        was) and with a large triangle spread over the image, each judged against a check mark it
        was not fitted to and against the clicked target square itself (the residual at each click).
        The renderer's own worldToCanvas of every mark is recorded beside the measured centroids. On
        every row the product's point is also required to be the renderer's own answer for the
        click in buffer units. None of this reads the screen: test 06 does."""
        rows = []
        for pair in (("DSGE", "DSCO"), ("DSPH", "DSCO")):
            fixture, spec = fx.build(self.stack, "D3DACC-" + uuid.uuid4().hex[:12], label="downscale",
                                     names=list(pair))
            self.spec = spec
            descriptions = [fx.DS_SERIES[name]["description"] for name in pair]
            # Where the renderer has fewer device pixels than image pixels (ratio 2 at 0.43 screen px
            # per image px, the smaller layout at ratios 1 to 1.5) it minifies the image and the drawn
            # squares alias by up to half an image pixel, which a buffer reading cannot see past
            # (measured: 0.43 mm), so there the millimetre figure is recorded, not judged; everything
            # else still is. The 0.43 layout is measured again at ratio 3, where it is not minified.
            plans = [(2, ("baseline", "resize-wider", "narrow-refit-880", "zoom-pan", "refit-800",
                          "refit-740", "refit-650", "rotate-flip", "refit-560")),
                     (3, ("refit-560", "rotate-flip"))]
            if pair[0] == "DSGE":
                # The fractional ratios a 125 % and a 150 % display have, and ratio 1: one full-size
                # layout and one whose buffer is the client size times the ratio rounded down.
                plans = [(ratio, ("baseline", "refit-740")) for ratio in (1, 1.25, 1.5)] + plans
            for ratio, plan in plans:
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
                        name = "ds%s-%s" % (("%g" % ratio).replace(".", "_"), step)
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
            problems = self.agreement_problems(row)
            if problems:
                new, after = row["new"], row.get("paneAfter") or {}
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

    # ---- B. positions on the screen -------------------------------------------------------

    def shot(self, page):
        """The composited page in device pixels, as an RGB array."""
        return np.asarray(Image.open(io.BytesIO(page.screenshot(type="png"))).convert("RGB"))

    @staticmethod
    def screen_squares(shot, box):
        """Connected saturated regions inside one canvas box of a screenshot, smallest first, with
        centroid and extent in device pixels of the whole screenshot. Only the screenshot is read:
        the box says where to look and nothing else. Also returns how many pixels in the box are not
        grey, which must be none once everything but the canvas is hidden."""
        dpr, rect = box["dpr"], box["rect"]
        rows, columns = shot.shape[:2]
        x0 = min(columns, max(0, int(math.ceil(rect["left"] * dpr)) + 1))
        y0 = min(rows, max(0, int(math.ceil(rect["top"] * dpr)) + 1))
        x1 = min(columns, max(x0, int(math.floor((rect["left"] + rect["width"]) * dpr)) - 1))
        y1 = min(rows, max(y0, int(math.floor((rect["top"] + rect["height"]) * dpr)) - 1))
        part = shot[y0:y1, x0:x1].astype(np.int32)
        if part.size == 0:
            return [], 0
        red = part[..., 0]
        coloured = int(((np.abs(part[..., 0] - part[..., 1]) > 6) | (np.abs(part[..., 1] - part[..., 2]) > 6)).sum())
        high, low = int(red.max()), int(red.min())
        limit = low + (high - low) * 0.6
        mask = red >= limit
        height, width = mask.shape
        inside, value, seen = mask.tobytes(), red.astype(np.uint8).tobytes(), bytearray(height * width)
        found = []
        for start in np.flatnonzero(mask).tolist():
            if seen[start]:
                continue
            seen[start] = 1
            queue = [start]
            sum_x = sum_y = weight = 0.0
            area, min_x, max_x, min_y, max_y = 0, width, -1, height, -1
            while queue:
                at = queue.pop()
                x = at % width
                y = at // width
                # Intensity weighted about the threshold, as the buffer reading is.
                w = value[at] - limit
                sum_x += (x + 0.5) * w
                sum_y += (y + 0.5) * w
                weight += w
                area += 1
                if x < min_x: min_x = x
                if x > max_x: max_x = x
                if y < min_y: min_y = y
                if y > max_y: max_y = y
                if x > 0 and inside[at - 1] and not seen[at - 1]:
                    seen[at - 1] = 1
                    queue.append(at - 1)
                if x < width - 1 and inside[at + 1] and not seen[at + 1]:
                    seen[at + 1] = 1
                    queue.append(at + 1)
                if y > 0 and inside[at - width] and not seen[at - width]:
                    seen[at - width] = 1
                    queue.append(at - width)
                if y < height - 1 and inside[at + width] and not seen[at + width]:
                    seen[at + width] = 1
                    queue.append(at + width)
            if area < 4:
                continue
            if weight <= 0:
                sum_x, sum_y, weight = (min_x + max_x + 1) / 2.0, (min_y + max_y + 1) / 2.0, 1.0
            found.append(dict(area=area, x=x0 + sum_x / weight, y=y0 + sum_y / weight,
                              minX=x0 + min_x, maxX=x0 + max_x, minY=y0 + min_y, maxY=y0 + max_y,
                              edge=min_x == 0 or min_y == 0 or max_x == width - 1 or max_y == height - 1))
        return sorted(found, key=lambda square: square["area"]), coloured

    @staticmethod
    def marker_painted(plain, marked, around, dpr):
        """Where the marker ring is really painted, in device pixels: the middle of the yellow pixels
        that exist only in the screenshot that shows the marker. The marker's own DOM box only says
        where to look."""
        rows, columns = plain.shape[:2]
        reach = int(math.ceil(16 * dpr))
        cx, cy = int(round(around[0] * dpr)), int(round(around[1] * dpr))
        xa, xb, ya, yb = max(0, cx - reach), min(columns, cx + reach), max(0, cy - reach), min(rows, cy + reach)
        if xa >= xb or ya >= yb:
            return None
        a, b = plain[ya:yb, xa:xb].astype(np.int32), marked[ya:yb, xa:xb].astype(np.int32)
        ring = (np.abs(a - b).sum(axis=2) > 60) & (b[..., 0] > 140) & (b[..., 2] * 2 < b[..., 0])
        if ring.sum() < 6:
            return None
        ys, xs = np.nonzero(ring)
        return dict(count=int(ring.sum()), x=float(xs.min() + xs.max() + 1) / 2 + xa, y=float(ys.min() + ys.max() + 1) / 2 + ya,
                    cut=bool(ring[0].any() or ring[-1].any() or ring[:, 0].any() or ring[:, -1].any()))

    def screen_pane(self, page, cell, name, index, marker=False):
        """One pane as a screenshot shows it: the fiducial squares in device pixels and the affine
        image pixel -> device pixel they define (the pane's own target square, when the slice has
        one, is held out of the fit). Returns {'failed': why, ...} when the frame cannot be read, so
        the caller records the case instead of judging it."""
        wanted = [t for t in fx.DS_TARGETS if t["series"] == name and t["slice"] == index]
        expected = len(fx.DS_MARKS) + len(wanted)
        why, box, squares, coloured = "frame", None, [], 0
        try:
            for _ in range(15):
                box = page.evaluate(PANE_BOX, cell["id"])
                if box["index"] == index and box["renderedIsCurrent"] and box["status"] != "loading":
                    page.evaluate(SCREEN_HIDE, "all")
                    plain = self.shot(page)
                    squares, coloured = self.screen_squares(plain, box)
                    if coloured:
                        why = "overlay"
                    elif len(squares) != expected:
                        why = "count"
                    elif any(square["edge"] for square in squares):
                        why = "clipped"
                    else:
                        pairs = [(mark["column"], mark["row"], square["x"], square["y"])
                                 for mark, square in zip(fx.DS_MARKS, squares)]
                        mapping = Mapping(pairs)
                        own = wanted[0] if wanted else None
                        if own and math.dist(mapping.at(own["column"], own["row"]),
                                             (squares[-1]["x"], squares[-1]["y"])) > 4 * box["dpr"]:
                            why = "another frame"
                        else:
                            out = dict(box=box, squares=squares, mapping=mapping, plain=plain,
                                       residual=max(math.dist(mapping.at(c, r), (x, y)) for c, r, x, y in pairs))
                            if marker:
                                page.evaluate(SCREEN_HIDE, "marker")
                                out["marked"] = self.shot(page)
                            return out
                    page.evaluate(SCREEN_HIDE, None)
                page.wait_for_timeout(120)
        finally:
            page.evaluate(SCREEN_HIDE, None)
        return dict(failed=why, box=box, areas=[square["area"] for square in squares], coloured=coloured)

    def quiet(self, page, cells, limit=10000):
        """Wait until no pane has changed frame for most of a second: position sync answers a frame
        change after a network round trip of its own."""
        last, same, waited = None, 0, 0
        while waited < limit:
            now = [page.evaluate(PANE_VIEW, cell["id"]) for cell in cells]
            key = [(view["index"], view["renderedIsCurrent"], view["status"]) for view in now]
            same = same + 1 if key == last and all(view["renderedIsCurrent"] for view in now) else 0
            if same >= 6:
                return True
            last = key
            page.wait_for_timeout(150)
            waited += 150
        return False

    def screen_compare(self, page, condition, pair, target, source_cell, target_cell, synced=False, others=()):
        """One pick judged against the screen. With `synced` the panes are read once position sync
        has stopped moving them, and the target pane is judged on whatever frame it then shows;
        `others` are further panes whose markers and covers are then read as well."""
        source_name = target["series"]
        other_name = pair[1] if source_name == pair[0] else pair[0]
        source_plane, target_plane = self.spec["series"][source_name], self.spec["series"][other_name]
        cells = [source_cell, target_cell] + list(others)
        row = dict(condition=condition, target=target["id"], source=source_name, into=other_name, synced=synced)
        self.show(page, source_cell, target["sop"])
        if synced:
            row.update(quietBefore=self.quiet(page, cells))
        src = self.screen_pane(page, source_cell, source_name, target["slice"])
        if "failed" in src:
            row.update(unmeasured="source " + src["failed"], sourceBox=src["box"], sourceAreas=src["areas"])
            return row
        dpr, smap, square = src["box"]["dpr"], src["mapping"], src["squares"][-1]
        # Aim at the pressed pixel's own square where the screenshot shows it.
        client = (square["x"] / dpr, square["y"] / dpr)
        before, source_before = page.evaluate(PANE_VIEW, target_cell["id"]), page.evaluate(PANE_VIEW, source_cell["id"])
        page.evaluate("() => { window.__acc.sequence = []; }")
        state, dom_marks, lost, event, _ = self.pick(page, source_cell, client)
        delivered = [event["x"], event["y"]]
        picked = state["source"]
        if synced:
            row.update(quietAfter=self.quiet(page, cells))
            state, dom_marks = page.evaluate("() => window.__acc.cursor.state()"), page.evaluate(MARKS)
        # The point really pressed: the square's own pixel plus the pointer's offset from the square,
        # both as the screenshot has them. No buffer, no box and no product value enters this.
        pointer = (delivered[0] * dpr, delivered[1] * dpr)
        at_pointer, at_square = smap.pixel(*pointer), smap.pixel(square["x"], square["y"])
        pressed = (target["column"] + at_pointer[0] - at_square[0], target["row"] + at_pointer[1] - at_square[1])
        asked = fx.world(source_plane, target["slice"], *pressed)
        harness = math.dist(smap.at(target["column"], target["row"]), (square["x"], square["y"]))
        mm_per_device_px = max(source_plane["spacing"]) / smap.scale
        row.update(devicePixelRatio=dpr, sourceBox=src["box"], deliveredAt=delivered, clicksSwallowed=len(lost),
                   status=state.get("status"), pressedPixel=list(pressed), askedWorld=asked,
                   sourceDevicePXperImagePX=smap.scale, mmPerDevicePX=mm_per_device_px,
                   sourceFitResidualDevicePX=src["residual"], harnessAtClickDevicePX=harness)
        if not picked:
            row.update(unmeasured="no source point: " + str(state.get("status")))
            return row
        reported = picked["world"]
        row.update(reportedWorld=reported, clickMM=math.dist(reported, asked),
                   clickDevicePX=math.dist(smap.at(*fx.pixel_on(source_plane, target["slice"], reported)),
                                           smap.at(*pressed)))
        # Which slices the target pane may show: every slice that is the nearest one for some point
        # this measurement cannot tell from the pressed one — the screen limit plus the harness's own
        # residuals, taken along the target stack's normal.
        tilt = math.sqrt(max(0.0, 1 - fx.dot(source_plane["normal"], target_plane["normal"]) ** 2))
        reach = (SCREEN_CLICK_DEVICE_PX + harness + src["residual"]) * mm_per_device_px * tilt
        allowed = fx.nearest_within(target_plane, asked, reach)
        result = next(r for r in state["panes"] if r["id"] == target_cell["id"])
        origin = next(r for r in state["panes"] if r["id"] == source_cell["id"])
        after, source_after = None, None
        for _ in range(20):
            after = page.evaluate(PANE_VIEW, target_cell["id"])
            if after["overlayIndex"] == after["index"] + 1 or after["index"] == before["index"]:
                break
            page.wait_for_timeout(100)
        # The viewer's cover comes up 50 ms after a scroll event; read once it has had time to.
        page.wait_for_timeout(150)
        after, source_after = page.evaluate(PANE_VIEW, target_cell["id"]), page.evaluate(PANE_VIEW, source_cell["id"])
        sops = target_plane["sopInstanceUIDs"]
        shown = after["index"]
        row.update(sliceReachMM=reach, allowedSlices=allowed, nearestSlice=fx.project(target_plane, asked)["index"],
                   shownSlice=shown, targetMarked=bool(result.get("marked")), claimedSOP=result.get("sop"),
                   shownSOP=sops[shown], sourceMarked=bool(origin.get("marked")),
                   sourcePaneMoved=source_after["index"] != source_before["index"],
                   paneBefore=before, paneAfter=after, sourcePaneAfter=source_after,
                   sequence=[entry for entry in page.evaluate("() => window.__acc.sequence")
                             if entry[0] == target_cell["id"]])
        mark = next((m for m in dom_marks if m["viewportId"] == target_cell["id"]), None)
        row.update(markerInDocument=mark is not None, others=[])
        for cell in others:
            held, view = next(r for r in state["panes"] if r["id"] == cell["id"]), page.evaluate(PANE_VIEW, cell["id"])
            row["others"].append(dict(id=cell["id"], marked=bool(held.get("marked")), claimedSOP=held.get("sop"),
                                      shownSOP=view["sop"], shownSlice=view["index"], loading=view["loading"],
                                      markerNodes=sum(1 for m in dom_marks if m["viewportId"] == cell["id"])))
        if result.get("marked") and mark:
            tgt = self.screen_pane(page, target_cell, other_name, shown, marker=True)
            if "failed" in tgt:
                row.update(targetUnmeasured=tgt["failed"], targetBox=tgt["box"], targetAreas=tgt["areas"])
            else:
                want = tgt["mapping"].at(*fx.pixel_on(target_plane, shown, asked))
                box = tgt["box"]["rect"]
                painted = self.marker_painted(tgt["plain"], tgt["marked"], (mark["clientX"], mark["clientY"]), dpr)
                row.update(targetBox=tgt["box"], targetFitResidualDevicePX=tgt["residual"],
                           targetDevicePXperImagePX=tgt["mapping"].scale, expectedMarkerDevice=list(want),
                           expectedInsideCanvas=(box["left"] * dpr <= want[0] <= (box["left"] + box["width"]) * dpr
                                                 and box["top"] * dpr <= want[1] <= (box["top"] + box["height"]) * dpr),
                           markerVisible=mark["display"] != "none", markerPainted=painted)
                if painted:
                    row.update(markerDevicePX=math.dist((painted["x"], painted["y"]), want))
        return row

    def screen_problems(self, row):
        """What one screen_compare() row fails, as sentences."""
        if "error" in row:
            return ["the pick could not be carried out: " + row["error"]]
        if "unmeasured" in row:
            return ["not measured: " + row["unmeasured"]]
        problems = []
        synced, after = row["synced"], row["paneAfter"]
        if row["clicksSwallowed"]:
            problems.append("click swallowed")
        if row["clickDevicePX"] > SCREEN_CLICK_DEVICE_PX:
            problems.append("the reported point is %.2f device px from the pressed one" % row["clickDevicePX"])
        if "targetUnmeasured" in row:
            problems.append("target frame not measurable: " + row["targetUnmeasured"])
        if row["targetMarked"]:
            # A marker claims one image at one point: the image must be the one on screen.
            if row["claimedSOP"] != row["shownSOP"]:
                problems.append("the marker claims an image the pane does not show")
            if not row["markerInDocument"]:
                problems.append("a pane held as marked has no marker node")
            elif "expectedMarkerDevice" in row:
                if not row["markerVisible"] or row["markerPainted"] is None:
                    if row["expectedInsideCanvas"]:
                        problems.append("marker not painted inside the pane")
                elif row["markerDevicePX"] > SCREEN_MARKER_DEVICE_PX:
                    problems.append("the marker is painted %.2f device px from the pressed point" % row["markerDevicePX"])
        elif row["markerInDocument"]:
            problems.append("a marker node is left on a pane the controller does not hold marked")
        for name, view in (("target", after), ("picked", row["sourcePaneAfter"])):
            if view["loading"]:
                problems.append("the viewer's Loading cover is left up on the %s pane" % name)
        for other in row["others"]:
            if other["marked"] and other["claimedSOP"] != other["shownSOP"]:
                problems.append("another pane's marker claims an image that pane does not show")
            if bool(other["markerNodes"]) != other["marked"]:
                problems.append("another pane's marker node and its held marker disagree")
            if other["loading"]:
                problems.append("the viewer's Loading cover is left up on another pane")
        # Judged only where the pane moved during this pick: this harness moves the picked pane with
        # a direct setImageIdIndex() of its own, which leaves that pane's number behind by itself.
        moved = after["index"] != row["paneBefore"]["index"]
        if moved and (after["overlayIndex"] != after["index"] + 1 or not after["ranges"]
                      or after["ranges"][0] != after["index"]):
            problems.append("slice number or scroll bar does not follow the moved pane")
        if synced:
            # Position sync may move either pane afterwards; only the claims above are required.
            return problems
        if not row["targetMarked"]:
            problems.append("no marker on the target pane: " + str(row["status"]))
        if row["shownSlice"] not in row["allowedSlices"]:
            problems.append("the pane shows slice %d, not a nearest slice of the pressed point %s"
                            % (row["shownSlice"], row["allowedSlices"]))
        if row["sourcePaneMoved"]:
            problems.append("the picked pane moved")
        if not row["sourceMarked"]:
            problems.append("no marker on the picked pane")
        if moved:
            kinds = [(kind, index) for _, kind, index in row["sequence"]]
            if kinds != [("scroll", after["index"]), ("image", after["index"])]:
                problems.append("the moved pane did not get one scroll event and then its image: %s" % kinds)
        return problems

    def screen_layout(self, page, name, pair, targets=None, synced=False):
        """Every target of the pair picked once in the layout the page is in. The caller has the
        controller enabled."""
        rows = []
        first, second = [self.pane_of(page, series) for series in pair]
        for target in self.spec["targets"]:
            if targets is not None and target["id"] not in targets:
                continue
            source_cell, target_cell = (first, second) if target["series"] == pair[0] else (second, first)
            try:
                row = self.screen_compare(page, name, pair, target, source_cell, target_cell, synced)
            except Exception as error:  # one lost pick must not lose every number of the run
                row = dict(condition=name, target=target["id"], error=repr(error)[:600])
                page.evaluate(SCREEN_HIDE, None)
            row["problems"] = self.screen_problems(row)
            rows.append(row)
        return rows

    def screen_report(self, name, rows, extra=None):
        """Write every row and print the worst figures per device ratio before anything is judged."""
        ARTIFACTS.mkdir(exist_ok=True)
        (ARTIFACTS / ("three-d-cursor-accuracy-" + name + ".json")).write_text(
            json.dumps(dict(digests=self.digests, rows=rows, extra=extra), ensure_ascii=False, indent=1, default=str) + "\n",
            encoding="utf-8")
        groups = {}
        for row in rows:
            groups.setdefault(row["condition"].split("-")[0], []).append(row)
        top = lambda values: max(values) if values else None
        summary = {key: dict(
            picks=len(group), measured=sum(1 for row in group if "clickDevicePX" in row),
            clickDevicePXmax=top([row["clickDevicePX"] for row in group if "clickDevicePX" in row]),
            markerDevicePXmax=top([row["markerDevicePX"] for row in group if "markerDevicePX" in row]),
            markers=sum(1 for row in group if "markerDevicePX" in row),
            sliceAllowed=sum(1 for row in group if "allowedSlices" in row and row["shownSlice"] in row["allowedSlices"]),
            sliceNearest=sum(1 for row in group if row.get("shownSlice") is not None and row.get("shownSlice") == row.get("nearestSlice")),
            sliceDecidable=sum(1 for row in group if len(row.get("allowedSlices") or []) == 1),
            mmPerDevicePXmax=top([row["mmPerDevicePX"] for row in group if "mmPerDevicePX" in row]),
            harnessAtClickDevicePXmax=top([row["harnessAtClickDevicePX"] for row in group if "harnessAtClickDevicePX" in row]),
            loadingCoverLeftUp=sum(1 for row in group if (row.get("paneAfter") or {}).get("loading")),
            movedPanes=sum(1 for row in group if "paneAfter" in row and row["paneAfter"]["index"] != row["paneBefore"]["index"]),
            failing=sum(1 for row in group if row.get("problems"))) for key, group in groups.items()}
        print("3D CURSOR ACCURACY " + name + " " + json.dumps(dict(
            limits=dict(clickDevicePX=SCREEN_CLICK_DEVICE_PX, markerDevicePX=SCREEN_MARKER_DEVICE_PX), byRatio=summary),
            ensure_ascii=False), flush=True)
        return [dict(condition=row["condition"], target=row["target"], problems=row["problems"],
                     click=row.get("clickDevicePX"), marker=row.get("markerDevicePX"), shown=row.get("shownSlice"),
                     allowed=row.get("allowedSlices"), status=row.get("status"))
                for row in rows if row.get("problems")]

    def test_cursor_accuracy_06_positions_on_the_screen_at_five_device_ratios(self):
        """Positions on the screen at device pixel ratios 1, 1.25, 1.5, 2 and 3.

        Each pane is read from a screenshot of the composited page. The pressed point, the point the
        product reports for it and the marker the product paints for it are compared in device
        pixels, and the slice the target pane shows must be a nearest slice of some point this
        measurement cannot tell from the pressed one. After every pick the moved pane must carry the
        right slice number and scroll bar and no Loading cover, and must have received one scroll
        event followed by its image. The ratios are set by emulation, and 1.25 and 1.5 once more by a
        browser started at that ratio, which lays the page out in device pixels as a display does."""
        pair = ("DSGE", "DSCO")
        fixture, spec = fx.build(self.stack, "D3DACC-" + uuid.uuid4().hex[:12], label="screen", names=list(pair))
        self.spec = spec
        descriptions = [fx.DS_SERIES[name]["description"] for name in pair]
        rows, probes = [], {}
        cells = lambda page: [self.pane_of(page, name) for name in pair]

        def layout(page, name):
            self.mount(page)
            page.evaluate(SEQUENCE)
            try:
                rows.extend(self.screen_layout(page, name, pair))
            finally:
                self.unmount(page)
            page.screenshot(path=str(ARTIFACTS / ("THREE-D-CURSOR-ACCURACY-screen-" + name + ".png")))

        try:
            for ratio, plan in ((1, ("baseline", "refit")), (1.25, ("baseline", "refit")), (1.5, ("baseline", "refit")),
                                (2, ("baseline", "refit")), (3, ("refit",))):
                tag = ("%g" % ratio).replace(".", "_")
                page = self.open(fixture, descriptions, device_scale_factor=ratio, viewport={"width": 1600, "height": 1050})
                self.digests = self.inject(page)
                self.assertAlmostEqual(page.evaluate("() => window.devicePixelRatio"), ratio, places=6)
                for step in plan:
                    if step == "refit":
                        self.resize(page, 1000, 740, cells(page))
                    layout(page, "e%s-%s" % (tag, step))
                page.close()
            for ratio in (1.25, 1.5):
                tag = ("%g" % ratio).replace(".", "_")
                browser = self.pw.chromium.launch(headless=True, args=[
                    "--enable-unsafe-swiftshader", "--force-device-scale-factor=%g" % ratio, "--window-size=1600,1050"])
                try:
                    page = self.enter(browser.new_context(ignore_https_errors=True, no_viewport=True).new_page(),
                                      fixture, descriptions)
                    probes["r" + tag] = page.evaluate("""() => ({devicePixelRatio: window.devicePixelRatio,
                      inner: [window.innerWidth, window.innerHeight]})""")
                    self.digests = self.inject(page)
                    layout(page, "r%s-baseline" % tag)
                finally:
                    browser.close()
        finally:
            failing = self.screen_report("screen", rows, probes)
        self.assertEqual({key: probe["devicePixelRatio"] for key, probe in probes.items()}, {"r1_25": 1.25, "r1_5": 1.5})
        self.assertEqual(len(rows), 77, "every planned pick must be in the record")
        self.assertEqual(failing, [], json.dumps(failing, indent=1, ensure_ascii=False))

    def cover_step(self, page, label, target, source_cell, target_cell):
        """One pick, and what the target pane looks like and received once it is over."""
        self.show(page, source_cell, target["sop"])
        src = self.ds_read(page, source_cell, target["series"], target["slice"])
        self.assertNotIn("failed", src, "the picked frame could not be read: %s" % label)
        before = page.evaluate(PANE_VIEW, target_cell["id"])
        page.evaluate("() => { window.__acc.sequence = []; }")
        state, _, lost, _, _ = self.pick(page, source_cell, src["new"].at(target["column"], target["row"]))
        after = None
        for _ in range(20):
            after = page.evaluate(PANE_VIEW, target_cell["id"])
            if after["overlayIndex"] == after["index"] + 1:
                break
            page.wait_for_timeout(100)
        page.wait_for_timeout(250)
        after = page.evaluate(PANE_VIEW, target_cell["id"])
        return dict(step=label, before=before, after=after, status=state["status"], clicksSwallowed=len(lost),
                    restore=(state.get("restores") or {}).get(target_cell["id"]),
                    sequence=[(kind, index) for pane, kind, index in page.evaluate("() => window.__acc.sequence")
                              if pane == target_cell["id"]])

    @staticmethod
    def buffer_is_the_renderers(box):
        """This harness's own statement of the sizes the pinned renderer gives a canvas buffer at the
        present ratio: the client size times the unit rounded down (its resize), or the box times
        the unit rounded down or up (its creation); and on the GPU path the copied region is the
        buffer. The unit is the device ratio on the GPU path and 1 on the CPU path."""
        unit = 1 if box["cpu"] else box["dpr"]
        sizes = (box["rect"]["width"], box["rect"]["height"])
        for axis in range(2):
            buffer = box["buffer"][axis]
            if buffer not in (math.floor(box["client"][axis] * unit), math.floor(sizes[axis] * unit),
                              math.ceil(sizes[axis] * unit)):
                return False
            if not box["cpu"] and box["copied"][axis] != buffer:
                return False
        return True

    def test_cursor_accuracy_07_loading_cover_and_a_buffer_left_from_another_device_ratio(self):
        """Two states a reader meets without doing anything unusual.

        (a) The viewer's "Loading..." cover. It comes up on a scroll event and goes down on the image
            that follows, so a pane the product moved must get the scroll event first. Checked on a
            first visit to a slice, on a slice the renderer already holds, and on the restoration of
            a pane after the run that moved it was stopped.
        (b) A window whose device ratio changes while its size does not (moved to another display).
            The pinned renderer keeps the buffer it had. The first click then must be either right
            or refused in so many words; a refusal for a reason that only happens to apply (outside
            the other series) is neither. A marker drawn before the change may not stay on a pane in
            that state, and once the renderer has sized its buffer again the pane must answer."""
        pair = ("DSGE", "DSCO")
        fixture, spec = fx.build(self.stack, "D3DACC-" + uuid.uuid4().hex[:12], label="states", names=list(pair))
        self.spec = spec
        descriptions = [fx.DS_SERIES[name]["description"] for name in pair]
        targets = {target["id"]: target for target in self.spec["targets"]}
        record, problems = dict(cover=[], stale=[]), []
        try:
            # (a)
            page = self.open(fixture, descriptions)
            self.digests = self.inject(page)
            self.mount(page)
            page.evaluate(SEQUENCE)
            source_cell, target_cell = self.pane_of(page, "DSGE"), self.pane_of(page, "DSCO")
            for label, name in (("first visit", "G1"), ("first visit", "G2"), ("image already held", "G1")):
                step = self.cover_step(page, label, targets[name], source_cell, target_cell)
                record["cover"].append(step)
                index = step["after"]["index"]
                if index == step["before"]["index"]:
                    problems.append("%s %s: the target pane did not move" % (label, name))
                if step["sequence"] != [("scroll", index), ("image", index)]:
                    problems.append("%s %s: events on the moved pane were %s" % (label, name, step["sequence"]))
            held = record["cover"][0]["after"]["index"]
            if record["cover"][2]["after"]["index"] != held:
                problems.append("the third pick did not return to the slice of the first")
            # The run is stopped while its request is out: the harness's own context adapter changes
            # as the renderer is asked for the frame, which is what a session or tool change does.
            page.evaluate("""id => {
              const v = services.cornerstoneViewportService.getCornerstoneViewport(id), own = v.setImageIdIndex;
              v.setImageIdIndex = function (...args) {
                delete v.setImageIdIndex;
                window.__acc.context = {owner: 'another reader'};
                return own.apply(this, args);
              };
            }""", target_cell["id"])
            step = self.cover_step(page, "restoration", targets["G2"], source_cell, target_cell)
            record["cover"].append(step)
            moved_to = record["cover"][1]["after"]["index"]
            if step["status"] != "세션 또는 도구가 바뀌어 취소했습니다." or step["restore"] != "restored":
                problems.append("the run was not stopped and restored: %s / %s" % (step["status"], step["restore"]))
            if step["after"]["index"] != held:
                problems.append("the pane was not put back on its slice")
            if step["sequence"] != [("scroll", moved_to), ("image", moved_to), ("scroll", held), ("image", held)]:
                problems.append("restoration: events on the pane were %s" % step["sequence"])
            for step in record["cover"]:
                view = step["after"]
                if view["loading"]:
                    problems.append("%s: the viewer's Loading cover is left up" % step["step"])
                if view["overlayIndex"] != view["index"] + 1 or not view["ranges"] or view["ranges"][0] != view["index"]:
                    problems.append("%s: slice number or scroll bar does not match the pane" % step["step"])
                if step["clicksSwallowed"]:
                    problems.append("%s: click swallowed" % step["step"])
            page.screenshot(path=str(ARTIFACTS / "THREE-D-CURSOR-ACCURACY-cover.png"))
            page.close()

            # (b)
            for ratio, changed in ((1, 1.5), (2, 1.25)):
                name = "ratio-%g-to-%s" % (ratio, ("%g" % changed).replace(".", "_"))
                page = self.open(fixture, descriptions, device_scale_factor=ratio, viewport={"width": 1600, "height": 1050})
                self.digests = self.inject(page)
                self.mount(page)
                page.evaluate(DS_EVENTS)
                source_cell, target_cell = self.pane_of(page, "DSGE"), self.pane_of(page, "DSCO")
                cells = dict(DSGE=source_cell, DSCO=target_cell)
                boxes = lambda: {series: page.evaluate(PANE_BOX, cell["id"]) for series, cell in cells.items()}
                marked = lambda: {series: next(pane["marked"] for pane in page.evaluate("() => window.__acc.cursor.state().panes")
                                               if pane["id"] == cell["id"]) for series, cell in cells.items()}
                nodes = lambda: {series: sum(1 for mark in page.evaluate(MARKS) if mark["viewportId"] == cell["id"])
                                 for series, cell in cells.items()}
                entry = dict(condition=name, clicks=[])
                record["stale"].append(entry)
                first = self.ds_compare(page, name + "-before", pair, targets["G1"], source_cell, target_cell)
                before_problems = ["not measured: " + first["unmeasured"]] if "unmeasured" in first else self.agreement_problems(first)
                if before_problems:
                    problems.append("%s: the pick before the change: %s" % (name, before_problems))
                entry.update(markedBefore=marked())
                session = page.context.new_cdp_session(page)
                session.send("Emulation.setDeviceMetricsOverride", dict(
                    width=1600, height=1050, deviceScaleFactor=changed, mobile=False))
                page.wait_for_timeout(1500)
                after_change = boxes()
                kept = {series: not self.buffer_is_the_renderers(box) for series, box in after_change.items()}
                # What the host adapter does when the renderer reports anything: refresh().
                page.evaluate("() => window.__acc.cursor.refresh()")
                entry.update(devicePixelRatio=page.evaluate("() => window.devicePixelRatio"), boxesAfterChange=after_change,
                             bufferKept=kept, markedAfterRefresh=marked(), markerNodesAfterRefresh=nodes())
                if entry["devicePixelRatio"] != changed:
                    problems.append("%s: the ratio did not change" % name)
                for series in cells:
                    if kept[series] and (entry["markedAfterRefresh"][series] or entry["markerNodesAfterRefresh"][series]):
                        problems.append("%s: a marker stayed on %s, whose buffer is from the old ratio" % (name, series))

                def click(label, target):
                    """One click, judged by the state the picked and the target pane are in as it lands."""
                    self.show(page, source_cell, target["sop"])
                    state_before, index_before = boxes(), page.evaluate(PANE_VIEW, target_cell["id"])["index"]
                    old = {series: not self.buffer_is_the_renderers(box) for series, box in state_before.items()}
                    row = self.ds_compare(page, name + "-" + label, pair, target, source_cell, target_cell)
                    status = page.evaluate("() => window.__acc.cursor.state().status")
                    view = page.evaluate(PANE_VIEW, target_cell["id"])
                    outcome = dict(click=label, bufferKept=old, status=status, markedAfter=marked(), markerNodes=nodes(),
                                   targetMoved=view["index"] != index_before, boxesBefore=state_before, boxesAfter=boxes())
                    if old["DSGE"]:
                        # The picked pane itself: nothing is computed, nothing is drawn, nothing moves.
                        refused = (row.get("unmeasured") == "no source point: " + BUFFER_REFUSED and status == BUFFER_REFUSED
                                   and not any(outcome["markerNodes"].values()) and not outcome["targetMoved"])
                        outcome.update(verdict="refused in words" if refused else "neither right nor refused in words")
                    elif old["DSCO"]:
                        refused = (status == "1 pane(s): " + BUFFER_REFUSED and not outcome["markedAfter"]["DSCO"]
                                   and not outcome["markerNodes"]["DSCO"] and not outcome["targetMoved"]
                                   and row.get("bufferUnitsMM", 1) <= EXCHANGE_MM)
                        outcome.update(verdict="refused in words" if refused else "neither right nor refused in words")
                    else:
                        wrong = ["not measured: " + row["unmeasured"]] if "unmeasured" in row else self.agreement_problems(row)
                        outcome.update(verdict="right" if not wrong else "neither right nor refused in words", wrong=wrong)
                    outcome.update(row={key: value for key, value in row.items() if key in (
                        "unmeasured", "bufferUnitsMM", "targetReason", "targetMarked", "reportedTargetSOP")})
                    entry["clicks"].append(outcome)
                    if outcome["verdict"] == "neither right nor refused in words":
                        problems.append("%s %s: %s" % (name, label, json.dumps(outcome, ensure_ascii=False, default=str)[:900]))
                    return outcome

                click("first-click", targets["G2"])
                click("second-click", targets["G3"])
                # A real resize: the renderer sizes every buffer again, at the ratio the page has now.
                session.send("Emulation.setDeviceMetricsOverride", dict(
                    width=1500, height=1000, deviceScaleFactor=changed, mobile=False))
                page.wait_for_timeout(1200)
                resized = boxes()
                entry.update(boxesAfterResize=resized)
                if not all(self.buffer_is_the_renderers(box) for box in resized.values()):
                    problems.append("%s: the renderer did not size its buffers on a resize" % name)
                if click("after-resize", targets["G4"])["verdict"] != "right":
                    problems.append("%s: the pane did not answer once its buffer was sized again" % name)
                self.unmount(page)
                page.close()
        finally:
            ARTIFACTS.mkdir(exist_ok=True)
            (ARTIFACTS / "three-d-cursor-accuracy-states.json").write_text(
                json.dumps(dict(digests=self.digests, record=record, problems=problems),
                           ensure_ascii=False, indent=1, default=str) + "\n", encoding="utf-8")
            print("3D CURSOR ACCURACY states " + json.dumps(dict(
                cover=[dict(step=step["step"], loading=step["after"]["loading"], sequence=step["sequence"],
                            index=step["after"]["index"], restore=step["restore"]) for step in record["cover"]],
                stale=[dict(condition=entry["condition"], bufferKept=entry.get("bufferKept"),
                            markedAfterRefresh=entry.get("markedAfterRefresh"),
                            clicks=[dict(click=c["click"], bufferKept=c["bufferKept"], verdict=c["verdict"], status=c["status"])
                                    for c in entry["clicks"]]) for entry in record["stale"]],
                problems=len(problems)), ensure_ascii=False), flush=True)
        self.assertEqual(problems, [], json.dumps(problems, indent=1, ensure_ascii=False))

    def test_cursor_accuracy_08_cpu_rendering_path(self):
        """Positions on the screen when the pinned renderer draws without its GPU path.

        On that path the renderer sizes a canvas buffer to the canvas's client size and reads canvas
        coordinates as buffer pixels, whatever the device ratio is; ratio 2 is where that differs
        from the GPU path. The viewer takes the path from one key of its configuration, so first the
        served configuration is given that key (and nothing else) on its way to the page. If the
        viewer does not come up that way, what it showed is recorded and the renderer is switched to
        the path inside a normally opened page instead, through its own setUseCPURendering()."""
        pair = ("DSGE", "DSCO")
        fixture, spec = fx.build(self.stack, "D3DACC-" + uuid.uuid4().hex[:12], label="cpu", names=list(pair))
        self.spec = spec
        descriptions = [fx.DS_SERIES[name]["description"] for name in pair]
        served, said, held = {}, [], {}

        def cpu_config(route):
            response = route.fetch()
            body = response.text()
            served.update(status=response.status, flags=body.count(CURSOR_FLAG))
            route.fulfill(response=response, body=body.replace(CURSOR_FLAG, CURSOR_FLAG + ", useCPURendering: true", 1))

        def listen(page):
            held["page"] = page
            page.on("console", lambda message: said.append(message.type + ": " + message.text[:300])
                    if message.type in ("error", "warning") else None)
            page.on("pageerror", lambda error: said.append("pageerror: " + str(error)[:300]))

        rows, boxes, extra = [], {}, dict(served=served)
        try:
            try:
                page = self.open(fixture, descriptions, device_scale_factor=2, viewport={"width": 1600, "height": 1050},
                                 config=cpu_config, prepare=listen)
                extra.update(via="configuration")
            except Exception as error:
                # What the viewer did instead of coming up, before the other way in is taken.
                shown = None
                try:
                    held["page"].screenshot(path=str(ARTIFACTS / "THREE-D-CURSOR-ACCURACY-cpu-by-configuration.png"))
                    shown = held["page"].evaluate("""() => ({
                      url: location.pathname, configured: !!(window.config && window.config.useCPURendering),
                      rendererOnCPU: window.cornerstone && cornerstone.getShouldUseCPURendering ? cornerstone.getShouldUseCPURendering() : null,
                      canvases: [...document.querySelectorAll('.cornerstone-canvas')].map(c => [c.width, c.height, c.clientWidth, c.clientHeight]),
                      panes: window.services ? services.viewportGridService.getState().viewports.size : null,
                      text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400)})""")
                except Exception as second:
                    shown = dict(unreadable=repr(second)[:300])
                extra.update(byConfiguration=dict(error=repr(error)[:300], shown=shown, said=said[:40]))
                print("3D CURSOR ACCURACY cpu by configuration " + json.dumps(extra["byConfiguration"], ensure_ascii=False), flush=True)
                page = self.open(fixture, descriptions, device_scale_factor=2, viewport={"width": 1600, "height": 1050})
                extra.update(via="switched in the page", switched=page.evaluate("""async () => {
                  cornerstone.setUseCPURendering(true);
                  const engine = services.cornerstoneViewportService.getRenderingEngine(), out = [];
                  for (const g of services.viewportGridService.getState().viewports.values()) {
                    const v = services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);
                    await v.setStack(v.getImageIds(), v.getCurrentImageIdIndex());
                  }
                  engine.resize(true, false);
                  engine.render();
                  for (const g of services.viewportGridService.getState().viewports.values()) {
                    const v = services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);
                    out.push({cpu: v.useCPURendering === true, buffer: [v.canvas.width, v.canvas.height],
                              client: [v.canvas.clientWidth, v.canvas.clientHeight]});
                  }
                  return out;
                }"""))
                page.wait_for_timeout(500)
                canvas_ready(page, len(descriptions))
            self.assertEqual(served.get("flags"), 1, "the served configuration was not the one expected: %s" % served)
            self.digests = self.inject(page)
            cells = lambda: [self.pane_of(page, name) for name in pair]
            for step in ("baseline", "refit"):
                if step == "refit":
                    self.resize(page, 1000, 740, cells())
                boxes[step] = [page.evaluate(PANE_BOX, cell["id"]) for cell in cells()]
                self.mount(page)
                page.evaluate(SEQUENCE)
                try:
                    rows.extend(self.screen_layout(page, "cpu2-" + step, pair))
                finally:
                    self.unmount(page)
                page.screenshot(path=str(ARTIFACTS / ("THREE-D-CURSOR-ACCURACY-cpu-" + step + ".png")))
        finally:
            extra.update(boxes=boxes, said=said[:40])
            failing = self.screen_report("cpu", rows, extra)
            print("3D CURSOR ACCURACY cpu path " + json.dumps(dict(
                via=extra.get("via"), switched=extra.get("switched"),
                boxes={step: [dict(cpu=box["cpu"], buffer=box["buffer"], client=box["client"], dpr=box["dpr"]) for box in pair_boxes]
                       for step, pair_boxes in boxes.items()}), ensure_ascii=False), flush=True)
        for step, pair_boxes in boxes.items():
            for box in pair_boxes:
                self.assertTrue(box["cpu"], "the pane is not on the CPU path: %s" % json.dumps(box))
                self.assertEqual(box["buffer"], box["client"], "a CPU-path buffer is the canvas's client size")
                self.assertEqual(box["dpr"], 2)
        self.assertEqual(len(rows), 14)
        self.assertEqual(failing, [], json.dumps(failing, indent=1, ensure_ascii=False))

    def test_cursor_accuracy_09_with_position_sync_switched_on(self):
        """The product's own position sync and the 3D cursor switched on together.

        Four panes of one study: two axial series with different slice positions, which position
        sync ties together, a coronal series the points are pressed on, and a series in another
        frame of reference that neither feature may touch. Position sync is switched on with the
        viewer's own button and shown to move the other axial pane; the 3D cursor is the controller
        the served configuration mounted, switched on with its own button, so its marker
        invalidation is the product's wiring and not this harness's. Before every pick the axial
        panes are sent elsewhere, so the cursor has to move both, and sync may answer each move by
        moving the other pane; the panes are therefore read once they have stopped changing. What
        must hold then: the reported point is the pressed one, a marker that is still shown claims
        the image its pane shows and is painted at the pressed point, no pane keeps a marker node it
        does not hold, and no pane is left under the Loading cover or with a wrong slice number.
        Which slices the axial panes end on, and whether their markers survive, is recorded, not
        judged."""
        names = ("DSGE", "DSPH", "DSCO", "FOREIGN")
        fixture, spec = fx.build(self.stack, "D3DACC-" + uuid.uuid4().hex[:12], label="sync", names=list(names))
        self.spec = spec
        descriptions = [fx.ALL_SERIES[name]["description"] for name in names]
        rows, extra = [], {}
        try:
            page = self.open(fixture, descriptions, device_scale_factor=2, viewport={"width": 1600, "height": 1050})
            # The modules under test are the ones the page was served, and they are this checkout's.
            served = page.evaluate("""async names => {
              const out = {};
              for (const name of names) {
                const response = await fetch('/worklist/hpacs-lite/' + name, {credentials: 'same-origin'});
                const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(await response.arrayBuffer()));
                out[name] = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
              }
              return out;
            }""", [MODEL.name, CONTROLLER.name])
            self.digests = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in (MODEL, CONTROLLER)}
            self.assertEqual(served, self.digests, "the page was not served this checkout's modules")
            page.wait_for_function("() => !!document.querySelector('#kin-viewer-layout #kin-3d-cursor')", timeout=30000)
            page.evaluate(ADOPT, self.spec["study"])
            cell = {name: self.pane_of(page, name) for name in names}
            everything = list(cell.values())
            jump = lambda name, index: page.evaluate("""async ({id, index}) => {
              const v = services.cornerstoneViewportService.getCornerstoneViewport(id);
              await cornerstone.utilities.jumpToSlice(v.element, {imageIndex: index});
            }""", dict(id=cell[name]["id"], index=index))
            shown = lambda name: page.evaluate(
                "id => services.cornerstoneViewportService.getCornerstoneViewport(id).getCurrentImageIdIndex()",
                cell[name]["id"])
            # Position sync on, and seen to work before the cursor is involved.
            select_image_tool(page, "ImageSliceSync")
            axial, tied = self.spec["series"]["DSGE"], self.spec["series"]["DSPH"]
            follows = fx.project(tied, fx.world(axial, 12, 256, 256))["index"]
            jump("DSGE", 12)
            page.wait_for_function("""({id, index}) =>
              services.cornerstoneViewportService.getCornerstoneViewport(id).getCurrentImageIdIndex() === index""",
                                   arg=dict(id=cell["DSPH"]["id"], index=follows), timeout=20000)
            extra.update(syncFollowed=dict(moved=12, followedTo=follows),
                         syncStatus=page.evaluate("() => (document.querySelector('#kin-ct-sync-status') || {}).textContent || null"))
            # The 3D cursor on, through the panel button the reader uses.
            toggle = page.locator("#kin-3d-cursor-toggle")
            tab = page.locator('#kin-workspace-dock nav button[aria-controls="kin-viewer-layout"]')
            if tab.count() and not toggle.is_visible():
                tab.click()
            summary = page.locator("#kin-viewer-layout > summary")
            if summary.count() and not toggle.is_visible():
                summary.click()
            expect(toggle).to_be_visible()
            toggle.click()
            page.wait_for_function("() => kinViewerThreeDCursorState().cursor.enabled === true")
            page.evaluate(SEQUENCE)
            targets = {target["id"]: target for target in self.spec["targets"]}
            for into in ("DSGE", "DSPH"):
                for name in ("C1", "C2", "C3"):
                    # Send the tied panes away first, so this pick has both of them to move.
                    away = 6 if shown("DSGE") != 6 else 9
                    jump("DSGE", away)
                    self.quiet(page, everything)
                    start = dict(DSGE=shown("DSGE"), DSPH=shown("DSPH"))
                    others = [cell[other] for other in names if other not in ("DSCO", into)]
                    try:
                        row = self.screen_compare(page, "sync2-into-" + into, ("DSCO", into), targets[name],
                                                  cell["DSCO"], cell[into], synced=True, others=others)
                    except Exception as error:  # one lost pick must not lose every number of the run
                        row = dict(condition="sync2-into-" + into, target=name, error=repr(error)[:600])
                        page.evaluate(SCREEN_HIDE, None)
                    point = fx.world(self.spec["series"]["DSCO"], targets[name]["slice"], targets[name]["column"], targets[name]["row"])
                    row.update(tiedStart=start, tiedEnd=dict(DSGE=shown("DSGE"), DSPH=shown("DSPH")),
                               tiedNearest=dict(DSGE=fx.project(axial, point)["index"], DSPH=fx.project(tied, point)["index"]))
                    row["problems"] = self.screen_problems(row)
                    rows.append(row)
            extra.update(syncStatusAfter=page.evaluate("() => (document.querySelector('#kin-ct-sync-status') || {}).textContent || null"),
                         cursorStatus=page.evaluate("() => kinViewerThreeDCursorState().cursor.status"),
                         wiring=page.evaluate("""() => { const s = kinViewerThreeDCursorState();
                           return {mounts: s.mounts, renders: s.renders, invalidations: s.invalidations, blocked: s.blocked}; }"""))
            page.screenshot(path=str(ARTIFACTS / "THREE-D-CURSOR-ACCURACY-sync.png"))
        finally:
            failing = self.screen_report("sync", rows, extra)
            print("3D CURSOR ACCURACY sync outcome " + json.dumps(dict(
                picks=len(rows),
                targetMarkerKept=sum(1 for row in rows if row.get("targetMarked")),
                pickedMarkerKept=sum(1 for row in rows if row.get("sourceMarked")),
                pickedPaneMoved=sum(1 for row in rows if row.get("sourcePaneMoved")),
                tiedPanesMovedByThePick=sum(1 for row in rows if "tiedEnd" in row and row["tiedEnd"] != row["tiedStart"]),
                bothTiedPanesOnTheirNearestSlice=sum(1 for row in rows if "tiedEnd" in row and row["tiedEnd"] == row["tiedNearest"]),
                tied=[dict(target=row["target"], start=row.get("tiedStart"), end=row.get("tiedEnd"), nearest=row.get("tiedNearest"))
                      for row in rows],
                settled=sum(1 for row in rows if row.get("quietAfter")), extra=extra), ensure_ascii=False), flush=True)
        self.assertEqual(len(rows), 6)
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
