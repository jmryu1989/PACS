// The Measure menu's base tools: Spine Label order, Circle by Diameter shape and statistics (hand-computed values),
// Marking / Text / Memo texts, and the ultrasound Region Calibration lengths of config/ohif/planar-geometry.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const M = require('../worklist-v0/hpacs-lite/measure-tools-model.js');
const geometry = (() => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'config', 'ohif', 'planar-geometry.js'), 'utf8') +
    '\n;this.kinUsRegionGeometry = kinUsRegionGeometry;', context);
  return context.kinUsRegionGeometry;
})();
const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' ≠ ' + expected);

test('Spine Label: the levels with and without C8 and L6', () => {
  assert.equal(M.spineLevels(false, false).length, 25);
  assert.deepEqual(M.spineLevels(false, false).slice(5, 9), ['C6', 'C7', 'T1', 'T2']);
  assert.deepEqual(M.spineLevels(true, false).slice(6, 9), ['C7', 'C8', 'T1']);
  assert.deepEqual(M.spineLevels(false, true).slice(-4), ['L4', 'L5', 'L6', 'S1']);
  assert.equal(M.spineLevels(true, true).length, 27);
});

test('Spine Label: the order from the start level, both directions, and a start that is not a level', () => {
  assert.deepEqual(M.spineOrder({ start: 'L4', includeC8: false, includeL6: true, direction: 'Top to bottom' }).order, ['L4', 'L5', 'L6', 'S1']);
  assert.deepEqual(M.spineOrder({ start: 'L4', includeC8: false, includeL6: false, direction: 'Top to bottom' }).order, ['L4', 'L5', 'S1']);
  const up = M.spineOrder({ start: 'T2', includeC8: true, includeL6: false, direction: 'Bottom to top' }).order;
  assert.deepEqual(up, ['T2', 'T1', 'C8', 'C7', 'C6', 'C5', 'C4', 'C3', 'C2', 'C1']);
  assert.equal(M.spineOrder({ start: 'C8', includeC8: false, includeL6: false, direction: 'Top to bottom' }), null);
  assert.equal(M.spineOrder({ start: 'L6', includeC8: false, includeL6: false, direction: 'Top to bottom' }), null);
  assert.equal(M.spineOrder({ start: 'L4', includeC8: false, includeL6: false, direction: 'Sideways' }), null);
  // The preview names every level, the start in brackets.
  const preview = M.spinePreview(M.spineLevels(false, true), 'L4');
  assert.match(preview, /^C1 C2 /); assert.match(preview, / \[L4\] L5 L6 S1$/);
  assert.ok(M.spineLevel('C8') && M.spineLevel('L6') && M.spineLevel('S1') && !M.spineLevel('L7') && !M.spineLevel('S2'));
});

test('Circle by Diameter: a circle on the patient is an ellipse of pixels where the pixels are not square', () => {
  const square = M.circleShape([10, 10], 10, [1, 1]);
  assert.deepEqual([square.rx, square.ry, square.edge], [5, 5, [15, 10]]);
  close(square.area, 25 * Math.PI);
  // Rows 0.5 mm apart, columns 1 mm: 5 mm is 5 columns but 10 rows.
  const tall = M.circleShape([10, 10], 10, [0.5, 1]);
  assert.deepEqual([tall.rx, tall.ry, tall.edge], [5, 10, [15, 10]]);
  assert.throws(() => M.circleShape([10, 10], 0, [1, 1]), /0보다/);
  assert.throws(() => M.circleShape([10, 10], 10, [0, 1]), /mm 지름/);
  assert.throws(() => M.circleShape([10, NaN], 10, [1, 1]), /가운데/);
});

test('Circle by Diameter: the pixels inside, counted by hand', () => {
  const key = list => list.map(p => p.join(',')).sort();
  // r = 1 mm on 1 mm pixels: the centre and its four neighbours.
  assert.deepEqual(key(M.circlePixels(M.circleShape([2, 2], 2, [1, 1]), 10, 10, [1, 1])), ['1,2', '2,1', '2,2', '2,3', '3,2']);
  // r = 1 mm, rows 0.5 mm: five pixels up the column and one either side.
  const tall = M.circlePixels(M.circleShape([2, 4], 2, [0.5, 1]), 10, 10, [0.5, 1]);
  assert.deepEqual(key(tall), ['1,4', '2,2', '2,3', '2,4', '2,5', '2,6', '3,4']);
  // The image edge cuts the circle: only pixels of the image.
  assert.deepEqual(key(M.circlePixels(M.circleShape([0, 0], 2, [1, 1]), 10, 10, [1, 1])), ['0,0', '0,1', '1,0']);
});

test('Circle by Diameter: mean, SD of the pixels, min, max and count, by hand', () => {
  const shape = M.circleShape([2, 2], 2, [1, 1]);
  // value = x + 10 y: 22, 21, 23, 12, 32 → mean 22, squares/5 = 524.4, SD √40.4.
  const stats = M.circleStats(shape, 10, 10, [1, 1], (x, y) => x + 10 * y);
  assert.equal(stats.count, 5); close(stats.mean, 22); close(stats.sd, Math.sqrt(40.4)); assert.equal(stats.min, 12); assert.equal(stats.max, 32);
  // Rescaled CT values (slope 1, intercept −1024) shift the mean, not the SD.
  const hu = M.circleStats(shape, 10, 10, [1, 1], (x, y) => x + 10 * y - 1024);
  close(hu.mean, 22 - 1024); close(hu.sd, Math.sqrt(40.4));
  // A circle that misses every pixel centre has no statistics; an unreadable pixel stops the calculation.
  assert.equal(M.circleStats(M.circleShape([.5, .5], .2, [1, 1]), 10, 10, [1, 1], () => 1), null);
  assert.throws(() => M.circleStats(shape, 10, 10, [1, 1], () => NaN), /화소값/);
  assert.throws(() => M.circleStats(M.circleShape([0, 0], 10000, [.1, .1]), 10, 10, [.1, .1], () => 1), /너무 커서/);
  const values = M.circleValues(2, stats);
  assert.equal(values.length, 7); close(values[1], Math.PI); assert.deepEqual(values.slice(4), [12, 32, 5]);
  assert.equal(M.circleValues(2, null).length, 2);
});

test('Circle by Diameter: the same image point gives the same values whatever the view did to it', () => {
  // A zoom, a rotation and a flip change where the circle is on the canvas, not its image point; every value is of the image.
  const shape = M.circleShape([20.25, 30.5], 7, [0.7, 0.7]), value = (x, y) => (x * 7 + y * 13) % 101;
  const once = M.circleStats(shape, 64, 64, [0.7, 0.7], value);
  for (const view of [{ zoom: 3 }, { rotation: 90 }, { flip: true }]) {
    const again = M.circleStats(M.circleShape([20.25, 30.5], 7, [0.7, 0.7]), 64, 64, [0.7, 0.7], value);
    assert.deepEqual(again, once, JSON.stringify(view));
  }
});

test('Circle by Diameter: the shown lines', () => {
  const lines = M.circleLines([10, 78.53981633974483, 40.04, 2.26, 35, 45, 69], 'HU', 'PixelSpacing · 원본 기준면');
  assert.deepEqual(lines, ['Ø 10.0 mm · Area 78.5 mm²', 'Mean 40.0 HU · SD 2.3 HU', 'Min 35.0 HU · Max 45.0 HU · n 69', 'PixelSpacing · 원본 기준면']);
  assert.match(M.circleLines([10, 78.5], '', '')[1], /통계 없음/);
  assert.match(M.circleLines([10], '', '')[0], /재확인 필요/);
});

test('Marking, Text and Memo: texts as stamped and the account list read as stored', () => {
  assert.equal(M.cleanText('  RLL nodule  '), 'RLL nodule');
  assert.equal(M.cleanText('   '), null); assert.equal(M.cleanText('a\u0000b'), null); assert.equal(M.cleanText(5), null);
  assert.equal(M.cleanText('\ud800'), null);
  assert.equal(M.cleanText('x'.repeat(1000)), 'x'.repeat(1000)); assert.equal(M.cleanText('x'.repeat(1001)), null);
  assert.deepEqual(M.markingList(['RLL nodule', ' RLL nodule ', 'two\nlines', 'x'.repeat(61), 7, '', 'GGO']), ['RLL nodule', 'GGO']);
  assert.deepEqual(M.markingList({ 0: 'a' }), []);
  assert.equal(M.markingList(Array.from({ length: 40 }, (_, i) => 'T' + i)).length, 30);
  assert.deepEqual(M.addMarking(['GGO'], ' RLL nodule '), { list: ['GGO', 'RLL nodule'], error: '' });
  assert.match(M.addMarking(['GGO'], 'GGO').error, /이미/);
  assert.match(M.addMarking([], 'a\nb').error, /한 줄/);
  assert.match(M.addMarking(Array.from({ length: 30 }, (_, i) => 'T' + i), 'new').error, /30개/);
});

test('Ultrasound Region Calibration: lengths in one region, none across regions or outside', () => {
  const region = (x0, x1, deltaX, deltaY, extra = {}) => ({ RegionSpatialFormat: 1, PhysicalUnitsXDirection: 3, PhysicalUnitsYDirection: 3,
    PhysicalDeltaX: deltaX, PhysicalDeltaY: deltaY, RegionLocationMinX0: x0, RegionLocationMinY0: 0, RegionLocationMaxX1: x1, RegionLocationMaxY1: 99, ...extra });
  const us = geometry({ Modality: 'US', SequenceOfUltrasoundRegions: [region(0, 99, 0.01, 0.02), region(100, 199, '0.05', '0.05')] });
  // 0.1 mm per column, 0.2 mm per row: 30 columns and 40 rows are 3 mm by 8 mm.
  close(us.length([0, 0], [30, 40]), Math.hypot(3, 8));
  assert.deepEqual(Array.from(us.spacing([[10, 10]])), [0.2, 0.1]);
  close(us.length([110, 10], [120, 10]), 5);
  assert.throws(() => us.length([90, 10], [110, 10]), /보정 영역/);
  assert.throws(() => us.length([0, 0], [0, 150]), /보정 영역/);
  // Only 2D regions in cm count; an image that is not US has none.
  assert.equal(geometry({ Modality: 'US', SequenceOfUltrasoundRegions: [region(0, 99, 0.01, 0.01, { PhysicalUnitsXDirection: 0 })] }), null);
  assert.equal(geometry({ Modality: 'US', SequenceOfUltrasoundRegions: [region(0, 99, 0.01, 0.01, { RegionSpatialFormat: 2 })] }), null);
  assert.equal(geometry({ Modality: 'CT', SequenceOfUltrasoundRegions: [region(0, 99, 0.01, 0.01)] }), null);
  assert.equal(geometry({ Modality: 'US' }), null);
});
