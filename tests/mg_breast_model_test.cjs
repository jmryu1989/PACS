// Pure MG menu calculations (worklist-v0/hpacs-lite/mg-breast-model.js): the counterpart of a point on the opposite
// breast and the prior of the same view, the four quadrants of a view, the breast region and its window, the zoom of
// Fit Breast, 1:1, True Size and Match Size, the DBT slab and the next patient tab. Synthetic values only.
// node --test tests/mg_breast_model_test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../worklist-v0/hpacs-lite/mg-breast-model.js');

// Standard display flips as mammography-model.js decides them; 1000 × 800 images (columns × rows).
const cell = (id, side, view, flipH = false, flipV = false, extra = {}) =>
  ({ id, side, view, verified: true, flipH, flipV, columns: 1000, rows: 800, ...extra });
const close = (actual, expected, digits = 6) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((n, i) => assert.ok(Math.abs(n - expected[i]) < 10 ** -digits, `${actual} ≈ ${expected}`));
};

test('counterpart: the opposite breast is mirrored across, the prior of the same side is the same place', () => {
  const rcc = cell('rcc', 'R', 'CC'), lcc = cell('lcc', 'L', 'CC'), priorRcc = cell('prcc', 'R', 'CC');
  close(M.counterpart([200, 100], rcc, lcc), [800, 100]);
  close(M.counterpart([200, 100], rcc, priorRcc), [200, 100]);
  // Stored flipped across (shown with flipH): the same standard place is the other stored column.
  const lccStoredFlipped = cell('lcc2', 'L', 'CC', true);
  close(M.counterpart([200, 100], rcc, lccStoredFlipped), [200, 100]);
  // Stored upside down (flipV): the standard place moves down the stored rows.
  close(M.counterpart([200, 100], rcc, cell('x', 'L', 'CC', false, true)), [800, 700]);
  // A smaller prior image: the same fraction of its own size.
  close(M.counterpart([200, 100], rcc, cell('p', 'L', 'CC', false, false, { columns: 500, rows: 400 })), [400, 50]);
});

test('counterpart: never across views, never with an unverified, unknown-side or unknown-view image', () => {
  const rcc = cell('rcc', 'R', 'CC');
  assert.equal(M.counterpart([1, 1], rcc, cell('rmlo', 'R', 'MLO')), null);
  assert.equal(M.counterpart([1, 1], rcc, cell('u', 'L', 'CC', false, false, { verified: false })), null);
  assert.equal(M.counterpart([1, 1], rcc, cell('b', 'B', 'CC')), null);
  assert.equal(M.counterpart([1, 1], cell('v', 'R', 'SPOT'), cell('w', 'L', 'SPOT')), null);
  assert.equal(M.unlinkable(cell('u', 'L', 'CC', false, false, { verified: false })), 'orientation-unverified');
  assert.equal(M.unlinkable(cell('b', 'B', 'CC')), 'laterality-unknown');
  assert.equal(M.unlinkable(cell('v', 'R', 'SPOT')), 'view-unknown');
});

test('targets: every other cell of the same view, with the reason a cell of that view is left out', () => {
  const cells = [cell('rcc', 'R', 'CC'), cell('lcc', 'L', 'CC'), cell('rmlo', 'R', 'MLO'), cell('lmlo', 'L', 'MLO'),
    cell('prcc', 'R', 'CC'), cell('plcc', 'L', 'CC', false, false, { verified: false }), cell('prmlo', 'R', 'MLO'), cell('plmlo', 'L', 'MLO')];
  const r = M.targets('rcc', cells);
  assert.deepEqual(r.linked, ['lcc', 'prcc']);
  assert.deepEqual(r.skipped, [{ id: 'plcc', reason: 'orientation-unverified' }]);
  assert.equal(r.reason, null);
  assert.equal(M.targets('plcc', cells).reason, 'orientation-unverified');
  assert.deepEqual(M.targets('lmlo', cells).linked, ['rmlo', 'prmlo', 'plmlo']);
});

test('quadrant: CC goes outer-chest, inner-chest, inner-nipple, outer-nipple; R and L are mirrored', () => {
  const box = { x0: 0, y0: 0, x1: 1000, y1: 800 };
  const rcc = cell('rcc', 'R', 'CC'), lcc = cell('lcc', 'L', 'CC');
  const steps = [0, 1, 2, 3].map(step => M.quadrant(step, rcc, box));
  assert.deepEqual(steps.map(q => q.name), ['Upper-Outer', 'Upper-Inner', 'Lower-Inner', 'Lower-Outer']);
  // Right breast: chest wall at the right half.
  assert.deepEqual(steps.map(q => q.box), [{ x0: 500, x1: 1000, y0: 0, y1: 400 }, { x0: 500, x1: 1000, y0: 400, y1: 800 },
    { x0: 0, x1: 500, y0: 400, y1: 800 }, { x0: 0, x1: 500, y0: 0, y1: 400 }]);
  // Left breast: the same step is the mirrored half.
  assert.deepEqual(M.quadrant(0, lcc, box).box, { x0: 0, x1: 500, y0: 0, y1: 400 });
  // Four distinct parts in every view.
  for (const c of [rcc, lcc, cell('rmlo', 'R', 'MLO'), cell('lmlo', 'L', 'MLO')])
    assert.equal(new Set([0, 1, 2, 3].map(step => JSON.stringify(M.quadrant(step, c, box).box))).size, 4);
  // Step 5 is step 1 again; step −1 is step 4.
  assert.equal(M.quadrant(5, rcc, box).name, 'Upper-Inner');
  assert.equal(M.quadrant(-1, rcc, box).name, 'Lower-Outer');
});

test('quadrant: MLO goes upper-chest, upper-nipple, lower-nipple, lower-chest; stored flips and the breast box count', () => {
  const rmlo = cell('rmlo', 'R', 'MLO');
  const box = { x0: 200, y0: 100, x1: 1000, y1: 700 };
  assert.deepEqual([0, 1, 2, 3].map(step => M.quadrant(step, rmlo, box).box), [
    { x0: 600, x1: 1000, y0: 100, y1: 400 }, { x0: 200, x1: 600, y0: 100, y1: 400 },
    { x0: 200, x1: 600, y0: 400, y1: 700 }, { x0: 600, x1: 1000, y0: 400, y1: 700 }]);
  // Stored flipped across: the standard right half is the stored left half.
  assert.deepEqual(M.quadrant(0, cell('f', 'R', 'MLO', true), { x0: 0, y0: 0, x1: 1000, y1: 800 }).box, { x0: 0, x1: 500, y0: 0, y1: 400 });
  // No box: the whole image.
  assert.deepEqual(M.quadrant(0, rmlo, null).box, { x0: 500, x1: 1000, y0: 0, y1: 400 });
  assert.equal(M.quadrant(0, cell('u', 'R', 'MLO', false, false, { verified: false }), null), null);
});

// A synthetic MG: dark background (40) and a bright half-ellipse (1000 + gradient) against the chest wall at the right,
// with a small bright marker (3000) apart from it that is not the breast.
function phantom(columns, rows, { chestRight = true, monochrome1 = false } = {}) {
  const values = new Uint16Array(columns * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const cx = chestRight ? columns : 0, dx = (x - cx) / (columns * 0.6), dy = (y - rows / 2) / (rows * 0.4);
    let v = dx * dx + dy * dy <= 1 ? 1000 + (y % 50) : 40;
    if (x < 30 && y < 30 && chestRight) v = 3000;
    values[y * columns + x] = monochrome1 ? 4095 - v : v;
  }
  return values;
}

test('detect: the breast region of a synthetic MG (largest bright region, not the marker); MONOCHROME1 tissue is dark', () => {
  const columns = 400, rows = 300, values = phantom(columns, rows);
  const r = M.detect(values, columns, rows, { maxSide: 100 });
  assert.equal(r.found, true);
  assert.equal(r.step, 4);
  // The ellipse spans x 160…400, y 30…270.
  assert.ok(Math.abs(r.box.x0 - 160) <= 8 && r.box.x1 === 400, JSON.stringify(r.box));
  assert.ok(Math.abs(r.box.y0 - 30) <= 8 && Math.abs(r.box.y1 - 270) <= 8, JSON.stringify(r.box));
  assert.ok(r.outline.length > 20 && r.outline.every(([x, y]) => x >= 0 && x <= columns && y >= 0 && y <= rows));
  const m1 = M.detect(phantom(columns, rows, { monochrome1: true }), columns, rows, { maxSide: 100, monochrome1: true });
  assert.deepEqual(m1.box, r.box);
  // Read as MONOCHROME2, the inverted image's "tissue" is the background around the breast: not the same box.
  assert.notDeepEqual(M.detect(phantom(columns, rows, { monochrome1: true }), columns, rows, { maxSide: 100 }).box, r.box);
  assert.equal(M.detect(new Uint16Array(columns * rows).fill(7), columns, rows).found, false);
  assert.equal(M.detect(null, columns, rows).found, false);
});

test('regionWindow: 1–99 percentiles of the region pixels only (the background and the marker do not count)', () => {
  const columns = 400, rows = 300, values = phantom(columns, rows);
  const region = M.detect(values, columns, rows, { maxSide: 100 });
  const w = M.regionWindow(values, columns, rows, region);
  // Region values are 1000 … 1049 (the gradient); the edge samples of the grid may take in a little background.
  assert.ok(w.lower >= 40 && w.lower <= 1001, JSON.stringify(w));
  assert.ok(w.upper >= 1047 && w.upper <= 1049, JSON.stringify(w));
  const narrow = M.regionWindow(values, columns, rows, region, { low: 0.2, high: 0.8 });
  assert.ok(narrow.lower >= 1005 && narrow.upper <= 1045, JSON.stringify(narrow));
  assert.equal(M.regionWindow(values, columns, rows, { found: false }), null);
});

test('zoom modes: Fit Breast, 1:1, True Size and Match Size as numbers', () => {
  // Fit now shows one image pixel as 0.25 CSS px; the breast box is 400 × 300 image px in a 500 × 300 cell.
  assert.equal(M.fitRect({ zoom: 1, perPixel: 0.25, cellWidth: 500, cellHeight: 300, width: 400, height: 300, margin: 1 }), 4);
  // Quadrant: half the box each way is twice the Fit zoom of the box.
  const whole = M.fitRect({ zoom: 1, perPixel: 0.25, cellWidth: 500, cellHeight: 400, width: 2000, height: 1600, margin: 1 });
  const quarter = M.fitRect({ zoom: 1, perPixel: 0.25, cellWidth: 500, cellHeight: 400, width: 1000, height: 800, margin: 1 });
  assert.equal(whole, 1); assert.equal(quarter, 2);
  // 1:1 on a dpr 2 screen: one image pixel is half a CSS pixel.
  assert.equal(M.onePixel({ zoom: 1, perPixel: 0.25, dpr: 2 }), 2);
  // True Size: 0.1 mm image pixels on a 0.25 mm-per-device-pixel monitor at dpr 1: 0.4 CSS px per image pixel.
  assert.ok(Math.abs(M.trueSize({ zoom: 1, perPixel: 0.25, spacing: 0.1, pitch: 0.25, dpr: 1 }) - 1.6) < 1e-12);
  // The same monitor with the browser at 200 %: twice as many device pixels per CSS pixel, half the zoom.
  assert.ok(Math.abs(M.trueSize({ zoom: 1, perPixel: 0.25, spacing: 0.1, pitch: 0.25, dpr: 2 }) - 0.8) < 1e-12);
  assert.equal(M.trueSize({ zoom: 1, perPixel: 0.25, spacing: 0.1, pitch: 0, dpr: 1 }), null);
  // Match Size: the shortest shown chest-wall-to-nipple length (b: 300 × 0.5 = 150) is kept; a: 400 × 0.5 = 200 → zoom × 0.75.
  assert.deepEqual(M.matchSize([{ id: 'a', zoom: 1, perPixel: 0.5, length: 400 }, { id: 'b', zoom: 2, perPixel: 0.5, length: 300 },
    { id: 'c', zoom: 1, perPixel: 0.5, length: 0 }]), { a: 0.75, b: 2 });
  assert.equal(M.trueSizeLabel('detector'), 'True Size (at detector)');
  assert.equal(M.trueSizeLabel('ermf'), 'True Size (ERMF estimate)');
  assert.equal(M.trueSizeLabel('pixel'), 'True Size');
});

test('monitor key and pitch: one key per screen size and place; a pitch from 0.05 to 1 mm', () => {
  assert.equal(M.monitorKey({ width: 2560, height: 1440, availLeft: -2560, availTop: 0 }), '2560x1440@-2560,0');
  assert.equal(M.monitorKey({ width: 1920, height: 1080, availLeft: 0, availTop: 0 }), '1920x1080@0,0');
  // Without the screen's place the arrangement is not known: no key, so no stored value is reused.
  assert.equal(M.monitorKey({ width: 1920, height: 1080 }), null);
  assert.equal(M.monitorKey(null), null);
  assert.ok(M.validPitch(0.27)); assert.ok(!M.validPitch(0)); assert.ok(!M.validPitch(3)); assert.ok(!M.validPitch('0.2'));
});

test('slab: odd and even counts around the centre, the ends take only the slices there', () => {
  assert.deepEqual(M.slabRange(10, 5, 40), { first: 8, last: 12, count: 5, requested: 5 });
  assert.deepEqual(M.slabRange(10, 4, 40), { first: 9, last: 12, count: 4, requested: 4 });
  assert.deepEqual(M.slabRange(0, 5, 40), { first: 0, last: 2, count: 3, requested: 5 });
  assert.deepEqual(M.slabRange(39, 10, 40), { first: 35, last: 39, count: 5, requested: 10 });
  assert.deepEqual(M.slabRange(3, 1, 40), { first: 3, last: 3, count: 1, requested: 1 });
  assert.equal(M.slabRange(40, 3, 40), null);
  assert.equal(M.slabLabel(M.slabRange(0, 5, 40)), 'Slab 3 of 5');
  assert.equal(M.slabLabel(M.slabRange(10, 5, 40)), 'Slab 5');
});

test('slab: the mean pixel values (rounded for integer pixels), only of slices on the same grid and conversion', () => {
  const out = new Uint16Array(3);
  assert.ok(M.slabAverage([Uint16Array.of(10, 20, 31), Uint16Array.of(20, 20, 30), Uint16Array.of(30, 21, 30)], out));
  assert.deepEqual([...out], [20, 20, 30]);
  const float = new Float32Array(2);
  assert.ok(M.slabAverage([Float32Array.of(1, 2), Float32Array.of(2, 2)], float));
  assert.deepEqual([...float], [1.5, 2]);
  assert.equal(M.slabAverage([Uint16Array.of(1, 2), Uint16Array.of(1)], new Uint16Array(2)), false);
  const base = { rows: 2, columns: 3, slope: 1, intercept: 0, scaled: true };
  assert.ok(M.slabCompatible([base, { ...base }]));
  assert.ok(!M.slabCompatible([base, { ...base, columns: 4 }]));
  assert.ok(!M.slabCompatible([base, { ...base, intercept: -1024 }]));
  assert.ok(!M.slabCompatible([base, { ...base, scaled: false }]));
  const planar = { ...base, rowCosines: [0, 1, 0], columnCosines: [0, 0, -1], spacing: [0.1, 0.1] };
  assert.ok(M.slabCompatible([planar, { ...planar, rowCosines: [0, 1, 0.00001] }]));
  assert.ok(!M.slabCompatible([planar, { ...planar, rowCosines: [0, 0.9, 0.1] }]));
  assert.ok(!M.slabCompatible([planar, { ...planar, spacing: [0.1, 0.085] }]));
  assert.ok(!M.slabCompatible([planar, base]));
  // Along the stack (the plane's normal) the slices differ; a shift within the plane is another grid.
  const placed = { ...planar, position: [0, 0, 0] };
  assert.ok(M.slabCompatible([placed, { ...placed, position: [1, 0, 0] }, { ...placed, position: [2, 0.0005, 0] }]));
  assert.ok(!M.slabCompatible([placed, { ...placed, position: [1, 0.5, 0] }]));
  assert.ok(!M.slabCompatible([placed, { ...placed, position: [1, 0, 0.2] }]));
  assert.ok(!M.slabCompatible([placed, { ...placed, position: null }]));
});

test('next tab: the one after the current, from the last back to the first; none with one tab', () => {
  assert.equal(M.nextTab(3, 0), 1);
  assert.equal(M.nextTab(3, 2), 0);
  assert.equal(M.nextTab(1, 0), null);
  assert.equal(M.nextTab(3, 5), null);
});
