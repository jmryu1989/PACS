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
        self.x = solve(matrix, [x for _, _, x, _ in pairs])
        self.y = solve(matrix, [y for _, _, _, y in pairs])
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
        """The product's own keyboard path: 'r' rotates the selected pane, 'h' flips it."""
        for index, cell in enumerate(cells):
            box = page.locator('[data-viewport-uid="' + cell["id"] + '"] canvas').bounding_box()
            page.mouse.click(box["x"] + box["width"] * .5, box["y"] + box["height"] * .3)
            page.keyboard.press("r")
            page.wait_for_timeout(150)
            if index == 1:
                page.keyboard.press("h")
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
