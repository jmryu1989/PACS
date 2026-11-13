// Pure Compare menu calculations (worklist-v0/hpacs-lite/viewer-compare-model.js): exam marks and the prior order,
// Prev/Next prior, the manual sync step difference, the spacing source and screen px per mm, and where a slice
// crosses a scout image. node --test tests/viewer_compare_model_test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const file = path.join(__dirname, '..', 'worklist-v0', 'hpacs-lite', 'viewer-compare-model.js');
// Loaded as the browser loads it: a plain script that sets window.KinCompareModel (in this realm, so results compare
// structurally).
const win = {};
vm.runInThisContext('(function (window) {' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(win);
const M = win.KinCompareModel;

const row = (uid, date, extra = {}) => ({ uid, date, time: '120000', acc: 'A-' + uid, ...extra });

test('marks: current *, only earlier dates get P (nearest first); same day, later and undated have none and undated go last', () => {
  const rows = [row('later', '2026-09-01'), row('undated', null), row('old', '2024-01-08'), row('cur', '2026-08-12'),
    row('same', '2026-08-12', { time: '080000' }), row('near', '2026-05-02'), row('bad', '2026-02-30')];
  const marked = M.marks(rows, 'cur');
  assert.deepEqual(marked.map(r => [r.uid, r.mark]),
    [['cur', '*'], ['near', 'P1'], ['old', 'P2'], ['later', ''], ['same', ''], ['bad', ''], ['undated', '']]);
  assert.deepEqual(M.priorUids(marked), ['near', 'old']);
});

test('marks: the same date and time order by Accession Number, then Study Instance UID; time breaks a same-day tie', () => {
  const rows = [row('cur', '2026-08-12'), row('z', '2026-01-01', { acc: 'B' }), row('y', '2026-01-01', { acc: 'A' }),
    row('x2', '2026-01-01', { acc: 'A' }), row('t', '2026-01-01', { time: '1300', acc: 'Z' }), row('n', '2026-01-01', { time: '', acc: '0' })];
  assert.deepEqual(M.marks(rows, 'cur').map(r => r.uid + ':' + r.mark), ['cur:*', 't:P1', 'x2:P2', 'y:P3', 'z:P4', 'n:P5']);
});

test('marks: no P when the current study has no valid date or is missing', () => {
  assert.deepEqual(M.marks([row('cur', ''), row('a', '2020-01-01')], 'cur').map(r => r.mark), ['*', '']);
  assert.deepEqual(M.marks([row('a', '2020-01-01')], 'missing').map(r => r.mark), ['']);
});

test('step: Next goes further back, Prev toward the current study, both stop at the ends; no prior shown opens the nearest', () => {
  const priors = ['p1', 'p2', 'p3'];
  assert.deepEqual(M.step(priors, 'p1', 1), { uid: 'p2' });
  assert.deepEqual(M.step(priors, 'p2', -1), { uid: 'p1' });
  assert.deepEqual(M.step(priors, 'p1', -1), { end: 'newer' });
  assert.deepEqual(M.step(priors, 'p3', 1), { end: 'older' });
  assert.deepEqual(M.step(priors, null, 1), { uid: 'p1' });
  assert.deepEqual(M.step(priors, 'same-day', -1), { uid: 'p1' });
  assert.deepEqual(M.step([], null, 1), { end: 'none' });
});

test('follow: keeps the tied difference, stops at an end, and the stopped cell regains its difference when coming back', () => {
  const members = [{ id: 'L', anchor: 89, count: 240 }, { id: 'R', anchor: 21, count: 60 }];
  assert.deepEqual(M.follow(members, 'L', 94), { R: 26 });
  assert.deepEqual(M.follow(members, 'L', 140), { R: 59 });
  assert.deepEqual(M.follow(members, 'L', 100), { R: 32 });
  assert.deepEqual(M.follow(members, 'R', 0), { L: 68 });
  assert.deepEqual(M.follow(members, 'L', 0), { R: 0 });
  assert.deepEqual(M.follow(members, 'X', 3), {});
});

test('spacing: patient Pixel Spacing, detector Imager Pixel Spacing, magnification-corrected, and none', () => {
  assert.deepEqual(M.spacing({ PixelSpacing: [0.7, 0.7] }).source, 'patient');
  assert.deepEqual(M.spacing({ PixelSpacing: '0.82\\0.82' }).value, [0.82, 0.82]);
  const detector = M.spacing({ ImagerPixelSpacing: [0.2, 0.2] });
  assert.equal(detector.source, 'detector'); assert.match(detector.label, /not true size/);
  const ermf = M.spacing({ ImagerPixelSpacing: [0.2, 0.2], EstimatedRadiographicMagnificationFactor: 1.25 });
  assert.equal(ermf.source, 'ermf'); assert.ok(Math.abs(ermf.value[0] - 0.16) < 1e-12);
  assert.equal(M.spacing({}), null);
  assert.equal(M.spacing({ PixelSpacing: [0, 1] }), null);
  assert.equal(M.spacing({ ImagerPixelSpacing: [0.2, 0.2], EstimatedRadiographicMagnificationFactor: 0 }), null);
  assert.deepEqual(M.spacing({ SharedFunctionalGroupsSequence: [{ PixelMeasuresSequence: [{ PixelSpacing: [0.5, 0.5] }] }] }).value, [0.5, 0.5]);
});

test('px per mm and the matching zoom: 0.07 mm and 0.1 mm pixels show 10 mm at the same length', () => {
  const ref = M.pxPerMm(2, 0.07), other = M.pxPerMm(2, 0.1);
  const zoom = M.ratioZoom(1.5, ref, other);
  assert.ok(Math.abs(M.pxPerMm(2 * zoom / 1.5, 0.1) - ref) < 1e-9);
  assert.equal(M.ratioZoom(1, ref, null), null);
  assert.equal(M.pxPerMm(2, 0), null);
});

const axial = z => M.plane({ ImagePositionPatient: [0, 0, z], ImageOrientationPatient: [1, 0, 0, 0, 1, 0], FrameOfReferenceUID: '1.2.3', Rows: 256, Columns: 256, PixelSpacing: [1, 1] });
// A coronal scout: rows go down in z (feet), columns along x, 512 x 256 pixels of 0.5 mm, starting above the stack.
const scout = M.plane({ ImagePositionPatient: [0, 128, 40], ImageOrientationPatient: [1, 0, 0, 0, 0, -1], FrameOfReferenceUID: '1.2.3', Rows: 256, Columns: 512, PixelSpacing: [0.5, 0.5] });

test('plane: needs its own position, orientation and frame of reference; never defaults', () => {
  assert.ok(axial(0));
  assert.equal(M.plane({ ImageOrientationPatient: [1, 0, 0, 0, 1, 0], FrameOfReferenceUID: 'f', Rows: 2, Columns: 2 }), null);
  assert.equal(M.plane({ ImagePositionPatient: [0, 0, 0], ImageOrientationPatient: [1, 0, 0, 0, 1, 0], Rows: 2, Columns: 2 }), null);
  assert.equal(M.plane({ ImagePositionPatient: [0, 0, 0], ImageOrientationPatient: [1, 0, 0, 1, 0, 0], FrameOfReferenceUID: 'f', Rows: 2, Columns: 2 }), null);
});

test('crossLine: an axial slice is a horizontal line on a coronal scout, moving down as z falls; none for parallel or another frame', () => {
  const top = M.crossLine(scout, axial(30));
  assert.deepEqual(top.from.map(n => +n.toFixed(6)), [-0.5, 20]);
  assert.deepEqual(top.to.map(n => +n.toFixed(6)), [511.5, 20]);
  assert.equal(M.crossLine(scout, axial(10)).from[1], 60);
  assert.deepEqual(M.crossLine(axial(0), axial(10)), { reason: 'parallel' });
  const other = { ...axial(10), frame: '9.9' };
  assert.deepEqual(M.crossLine(scout, other), { reason: 'frame' });
  assert.deepEqual(M.crossLine(scout, axial(400)), { reason: 'outside' });
});

test('scoutPoint and nearestSlice: a click on the scout goes to the slice nearest that height', () => {
  const planes = [0, 2, 4, 6, 8].map(axial);
  const point = M.scoutPoint(scout, 100, 70);
  assert.deepEqual(point.map(n => +n.toFixed(6)), [50, 128, 5]);
  assert.equal(M.nearestSlice(planes, point), 2);
  assert.equal(M.nearestSlice([null, null], point), -1);
});
