// The Measure menu's line tools (worklist-v0/hpacs-lite/measure-lines-model.js): hand-computed values for CTR (4-line and
// 2-line), Parallel Lines, Length Ratio, Centre-line Angle and Volume Measure; presses in the reverse order; lengths of 0 and
// ratios over 0; pixels that are not square; and the server's copy of the same calculation (api/src/measure-lines.ts, run
// from the compiled API when KIN_API_DIST names it) against the same values.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../worklist-v0/hpacs-lite/measure-lines-model.js');
const close = (actual, expected, tolerance = 1e-9) => assert.ok(actual !== null && Math.abs(actual - expected) <= tolerance, actual + ' vs ' + expected);
const closeAll = (actual, expected) => { assert.equal(actual.length, expected.length); expected.forEach((n, i) => n === null ? assert.equal(actual[i], null) : close(actual[i], n)); };

test('CTR 4-line: MRD and MLD from the midline, ID across the lung field; square and non-square pixels', () => {
  // Midline x = 100 (two points), right heart border at x = 60, left at x = 170, lung field from x = 20 to x = 220.
  const points = [[100, 20], [100, 220], [60, 150], [170, 140], [20, 120], [220, 120]];
  closeAll(M.ctr4(points, [0.5, 0.5]), [20, 35, 100, 0.55]);
  // Columns of 0.5 mm, rows of 1 mm: the widths are along the rows, so the same mm.
  closeAll(M.ctr4(points, [1, 0.5]), [20, 35, 100, 0.55]);
  // The midline drawn bottom to top is the same midline.
  closeAll(M.ctr4([[100, 220], [100, 20], ...points.slice(2)], [0.5, 0.5]), [20, 35, 100, 0.55]);
  // A tilted midline: the distance is the perpendicular one.
  close(M.ctr4([[0, 0], [100, 100], [100, 0], [0, 100], [0, 50], [100, 50]], null)[0], 100 / Math.SQRT2);
  // Pixels without a spacing: the same ratio in pixel lengths.
  closeAll(M.ctr4(points, null), [40, 70, 200, 0.55]);
});

test('CTR 4-line: a midline or a lung line of no length gives no ratio', () => {
  closeAll(M.ctr4([[100, 20], [100, 20], [60, 150], [170, 140], [20, 120], [220, 120]], null), [null, null, 200, null]);
  closeAll(M.ctr4([[100, 20], [100, 220], [60, 150], [170, 140], [20, 120], [20, 120]], null), [40, 70, 0, null]);
});

test('CTR 2-line: the longer line is ID whatever the order', () => {
  const heart = [[10, 10], [110, 10]], chest = [[0, 50], [200, 50]];
  closeAll(M.ctr2([...heart, ...chest], [0.5, 0.5]), [50, 100, 0.5]);
  closeAll(M.ctr2([...chest, ...heart], [0.5, 0.5]), [50, 100, 0.5]);
  closeAll(M.ctr2([...heart.reverse(), ...chest], null), [100, 200, 0.5]);
  closeAll(M.ctr2([[0, 0], [0, 0], [0, 0], [0, 0]], null), [0, 0, null]);
});

test('Parallel Lines: the second line from one press, Gap and Centre', () => {
  const first = [[0, 0], [100, 0]], second = M.parallelSecond(first, [130, 40], null);
  closeAll(second.flat(), [80, 40, 180, 40]);
  closeAll(M.parallel([...first, ...second], null), [40, Math.hypot(80, 40)]);
  // A slanted first line (length 50): the second is parallel and as long; Gap is perpendicular, Centre joins the middles.
  const slanted = [[0, 0], [30, 40]], placed = M.parallelSecond(slanted, [100, 0], null);
  closeAll(placed.flat(), [85, -20, 115, 20]);
  closeAll(M.parallel([...slanted, ...placed], null), [80, Math.hypot(85, 20)]);
  // Non-square pixels: parallel on the patient. Rows of 2 mm, columns of 1 mm; the press at row 20 is 40 mm away.
  const tall = M.parallelSecond(first, [130, 20], [2, 1]);
  closeAll(tall.flat(), [80, 20, 180, 20]);
  closeAll(M.parallel([...first, ...tall], [2, 1]), [40, Math.hypot(80, 40)]);
  // Drawn the other way round: the same values.
  closeAll(M.parallel([first[1], first[0], second[1], second[0]], null), [40, Math.hypot(80, 40)]);
  closeAll(M.parallelCentre([...first, ...second]).flat(), [50, 0, 130, 40]);
});

test('Parallel Lines: editing keeps the second line parallel', () => {
  const points = [[0, 0], [100, 0], [80, 40], [180, 40]];
  // One end of the second line slides along the line only.
  closeAll(M.parallelSlide(points, 3, [200, 100], null).flat(), [0, 0, 100, 0, 80, 40, 200, 40]);
  // The first line turned upright: the second keeps its middle (130, 40) and length (100) and turns with it.
  closeAll(M.parallelAlign([[0, 0], [0, 100], [80, 40], [180, 40]], null).flat(), [0, 0, 0, 100, 130, -10, 130, 90]);
  // A first line of no length: Gap cannot be given; Centre still can.
  closeAll(M.parallel([[0, 0], [0, 0], [80, 40], [180, 40]], null), [null, Math.hypot(130, 40)]);
  assert.throws(() => M.parallelSlide(points, 0, [1, 1], null));
});

test('Length Ratio: L1, L2 and L1 / L2; a second length of 0 gives no ratio', () => {
  closeAll(M.ratio([[0, 0], [30, 40], [0, 0], [0, 20]], null), [50, 20, 2.5]);
  closeAll(M.ratio([[30, 40], [0, 0], [0, 20], [0, 0]], [0.5, 0.5]), [25, 10, 2.5]);
  closeAll(M.ratio([[0, 0], [30, 40], [5, 5], [5, 5]], null), [50, 0, null]);
  // Non-square pixels: the ratio of lengths on the patient. Rows of 2 mm: (0,0)–(0,10) is 20 mm, (0,0)–(20,0) is 20 mm.
  closeAll(M.ratio([[0, 0], [0, 10], [0, 0], [20, 0]], [2, 1]), [20, 20, 1]);
});

test('Centre-line Angle: two centre lines and the angle between them; any press order gives the same', () => {
  const pair1 = [[0, 0], [100, 0], [0, 10], [100, 10]], pair2 = [[0, 0], [100, 100], [10, 0], [110, 100]];
  // Each centre line points down the image (along a row: to the right); the angle is 0–180° with 360° − angle beside it.
  closeAll(M.centreAngle([...pair1, ...pair2], null), [45, 315]);
  const lines = M.centreLines([...pair1, ...pair2], null);
  closeAll(lines[0].flat(), [0, 5, 100, 5]);
  closeAll(lines[1].flat(), [5, 0, 105, 100]);
  // Each line drawn the other way round, and the pairs' lines swapped: the same centre lines and the same angle.
  const reversed = [pair1[3], pair1[2], pair1[0], pair1[1], pair2[2], pair2[3], pair2[1], pair2[0]];
  closeAll(M.centreAngle(reversed, null), [45, 315]);
  const again = M.centreLines(reversed, null);
  assert.deepEqual(again[0].map(p => p.join()).sort(), lines[0].map(p => p.join()).sort());
  assert.deepEqual(again[1].map(p => p.join()).sort(), lines[1].map(p => p.join()).sort());
  // A second centre line going down to the left: 135°, whatever the order of its presses.
  const left = [[100, 0], [0, 100], [110, 0], [10, 100]];
  closeAll(M.centreAngle([...pair1, ...left], null), [135, 225]);
  closeAll(M.centreAngle([...pair1, left[1], left[0], left[3], left[2]], null), [135, 225]);
  // Non-square pixels: rows of 2 mm make (0,0)–(100,50) a 45° line on the patient.
  closeAll(M.centreAngle([...pair1, [0, 0], [100, 50], [10, 0], [110, 50]], [2, 1]), [45, 315]);
  // Perpendicular centre lines: 90° and 270°.
  closeAll(M.centreAngle([...pair1, [50, 0], [50, 100], [60, 0], [60, 100]], null), [90, 270]);
  // A pair of lines without length has no centre line: no angle.
  closeAll(M.centreAngle([...pair1, [1, 1], [1, 1], [1, 1], [1, 1]], null), [null, null]);
});

// Every order of the presses: each of the four lines drawn either way round, and the two lines of a pair swapped.
function pressOrders(base) {
  const out = [];
  for (let mask = 0; mask < 16; mask++) {
    const p = base.map(q => [...q]);
    for (let line = 0; line < 4; line++) if (mask & (1 << line)) [p[2 * line], p[2 * line + 1]] = [p[2 * line + 1], p[2 * line]];
    out.push(p, [...p.slice(2, 4), ...p.slice(0, 2), ...p.slice(6, 8), ...p.slice(4, 6)]);
  }
  return out;
}
// A pair whose two lines cross at a right angle: the ends are paired by distance, not by the order of the presses.
const CROSSED = [[10, 10], [30, 10], [20, 20], [20, 40], [50, 10], [70, 10], [50, 20], [70, 20]];
test('Centre-line Angle: a pair of perpendicular lines and every press order give one angle', () => {
  const expected = M.centreAngle(CROSSED, [1, 1]);
  assert.ok(expected[0] !== null);
  for (const points of pressOrders(CROSSED)) closeAll(M.centreAngle(points, [1, 1]), expected);
  for (const points of pressOrders([[0, 0], [100, 0], [0, 10], [100, 10], [0, 0], [100, 100], [10, 0], [110, 100]])) closeAll(M.centreAngle(points, null), [45, 315]);
});
test('Volume Measure: Ellipsoid and Prolate spheroid in mL; nothing until each needed length is measured', () => {
  close(M.volume('ellipsoid', { Length: 40, Height: 30, Width: 20 }), Math.PI / 6 * 40 * 30 * 20 / 1000);
  close(M.volume('ellipsoid', { Length: 40, Height: 30, Width: 20 }), 12.566370614359172);
  close(M.volume('prolate', { Length: 40, Width: 20 }), Math.PI / 6 * 40 * 20 * 20 / 1000);
  close(M.volume('prolate', { Length: 40, Height: 999, Width: 20 }), 8.377580409572781);
  assert.equal(M.volume('ellipsoid', { Length: 40, Width: 20 }), null);
  assert.equal(M.volume('ellipsoid', { Length: 40, Height: 0, Width: 20 }), null);
  assert.deepEqual(M.formulaParts('prolate'), ['Length', 'Width']);
  assert.deepEqual(M.formulaParts('ellipsoid'), ['Length', 'Height', 'Width']);
  assert.throws(() => M.volume('cube', { Length: 1, Height: 1, Width: 1 }));
  // Three lengths on three images of different spacings.
  const lengths = { Length: M.length([[0, 0], [80, 0]], [0.5, 0.5]), Height: M.length([[0, 0], [0, 150]], [0.2, 0.2]), Width: M.length([[0, 0], [100, 0]], [0.3, 0.2]) };
  closeAll([lengths.Length, lengths.Height, lengths.Width], [40, 30, 20]);
  close(M.volume('ellipsoid', lengths), 12.566370614359172);
});

test('the words: units, the pixel-based mark and "—" for a value that cannot be given', () => {
  assert.deepEqual(M.lines('ctr4', [20, 35, 100, 0.55], 'pixel'), ['CTR 0.55 (55.0%)', 'MRD 20.0 mm · MLD 35.0 mm · ID 100.0 mm']);
  assert.deepEqual(M.lines('ctr2', [50, 100, 0.5], 'px'), ['CTR 0.50 (50.0%)', 'CD 50.0 px · ID 100.0 px', '픽셀 기준(간격 미확인)']);
  assert.deepEqual(M.lines('ratio', [50, 0, null], 'pixel'), ['Ratio (L1/L2) —', 'Length 1 50.0 mm · Length 2 0.0 mm']);
  assert.deepEqual(M.lines('parallel', [40, 89.44], 'px'), ['Gap 40.0 px · Centre 89.4 px', '간격 확인 불가']);
  assert.deepEqual(M.lines('centreangle', [45, 315], 'us'), ['Angle 45.0° (315.0°)']);
  assert.deepEqual(M.lines('centreangle', [null, null], 'pixel'), ['Angle —']);
  assert.equal(M.volumeText(12.566), '12.57 mL');
  assert.equal(M.volumeText(null), '—');
});

test('calculate and same: the saved values are compared with nulls in place', () => {
  assert.ok(M.same(M.calculate('ratio', [[0, 0], [30, 40], [5, 5], [5, 5]], null), [50, 0, null]));
  assert.ok(!M.same([50, 0, null], [50, 0, 0]));
  assert.ok(!M.same([50, 20, 2.5], [50, 20, 2.5001]));
  assert.throws(() => M.calculate('cobb', [], null));
  assert.throws(() => M.ctr4([[0, 0]], null));
  assert.throws(() => M.ratio([[0, 0], [1, 1], [2, 2], [3, NaN]], null));
  assert.throws(() => M.length([[0, 0], [1, 1]], [0, 1]));
});

// The server's calculation is a copy in TypeScript; both must give the same values for the same presses.
test('the server copy gives the same values', { skip: !process.env.KIN_API_DIST && 'KIN_API_DIST not set (the compiled API)' }, () => {
  const S = require(process.env.KIN_API_DIST.replace(/\/$/, '') + '/measure-lines.js');
  const cases = [['ctr4', [[100, 20], [100, 220], [60, 150], [170, 140], [20, 120], [220, 120]], [1, 0.5]],
    ['ctr2', [[0, 50], [200, 50], [10, 10], [110, 10]], [0.5, 0.5]], ['parallel', [[0, 0], [30, 40], [85, -20], [115, 20]], null],
    ['ratio', [[0, 0], [30, 40], [5, 5], [5, 5]], [2, 1]], ['centreangle', [[0, 0], [100, 0], [0, 10], [100, 10], [0, 0], [100, 50], [10, 0], [110, 50]], [2, 1]]];
  for (const [tool, points, spacing] of cases) assert.ok(M.same(S.lineValues(tool, points, spacing), M.calculate(tool, points, spacing)), tool);
  close(S.volumeValue('prolate', [40, 20]), M.volume('prolate', { Length: 40, Width: 20 }));
  for (const points of pressOrders(CROSSED)) assert.ok(M.same(S.lineValues('centreangle', points, [1, 1]), M.centreAngle(CROSSED, [1, 1])));
});

test('the model file is plain browser JavaScript (no module syntax)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'worklist-v0', 'hpacs-lite', 'measure-lines-model.js'), 'utf8');
  assert.ok(!/^\s*(import|export)\s/m.test(source));
});
