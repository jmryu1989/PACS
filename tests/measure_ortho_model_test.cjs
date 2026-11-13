// The Measure menu's orthopaedic and spine tools (hand-computed values): Limb Length Discrepancy, Acetabular Angle, Spine
// Balance, Cobb Angle (Lordosis / Kyphosis) and Pelvic Incidence; non-square pixels, an unknown spacing, points out of order;
// and the server's own calculation (api/src/ortho-geometry.ts, compiled) giving the same values.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../worklist-v0/hpacs-lite/measure-ortho-model.js');
const DEG = 180 / Math.PI;
const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' vs ' + expected);
const values = (kind, points, spacing = [1, 1], options) => { const r = M.compute(kind, points, spacing, options); assert.ok(r.values, r.reason); return r.values; };
const reason = (kind, points, spacing = [1, 1], options) => { const r = M.compute(kind, points, spacing, options); assert.ok(!r.values, 'expected a refusal'); return r.reason; };
const rotate = (points, deg, [cx, cy] = [0, 0]) => { const c = Math.cos(deg / DEG), s = Math.sin(deg / DEG); return points.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]); };

// Base line y = 100; pelvic landmarks 20 and 10 px below it, femoral landmarks 100 and 95 px below it.
const LIMB = [[0, 100], [200, 100], [50, 120], [150, 110], [52, 200], [148, 195]];
test('Limb Length Discrepancy: each side from its pelvic to its femoral landmark across the base line, and the difference', () => {
  assert.deepEqual(values('limbLength', LIMB).map(n => Math.round(n * 1e9) / 1e9), [80, 85, 5]);
  // Row spacing 0.5 mm, column 0.2 mm: the distances run along the rows.
  values('limbLength', LIMB, [0.5, 0.2]).forEach((n, i) => close(n, [40, 42.5, 2.5][i]));
  // The sides pair by their place on the image, not by the order they were marked in.
  const swapped = [LIMB[0], LIMB[1], LIMB[3], LIMB[2], LIMB[5], LIMB[4]];
  values('limbLength', swapped).forEach((n, i) => close(n, [80, 85, 5][i]));
  // A tilted framework (the whole drawing turned by 30°) gives the same lengths.
  values('limbLength', rotate(LIMB, 30)).forEach((n, i) => close(n, [80, 85, 5][i], 1e-9));
  assert.match(reason('limbLength', [[0, 100], [0, 100], ...LIMB.slice(2)]), /기준선/);
  assert.match(reason('limbLength', [LIMB[0], LIMB[1], [50, 120], [50, 120], ...LIMB.slice(4)]), /골반 표지/);
});

// Line A along y = 300; one acetabular line at 45°, the other at atan(0.2).
const ACET = [[100, 300], [700, 300], [0, 200], [100, 300], [600, 280], [700, 260]];
test('Acetabular Angle: the acute angle at each end of line A, and the supplement', () => {
  const [left, right] = values('acetabular', ACET);
  close(left, 45); close(right, Math.atan(0.2) * DEG); close(right, 11.309932474020215);
  // Non-square pixels (row 2 mm, column 1 mm): the left line is (100, 200) mm, the right (100, 40) mm.
  const [l2, r2] = values('acetabular', ACET, [2, 1]);
  close(l2, Math.atan(2) * DEG); close(r2, Math.atan(0.4) * DEG);
  // The two side lines in the other order, and each line's ends in the other order: the same angles.
  const other = values('acetabular', [ACET[1], ACET[0], ACET[5], ACET[4], ACET[3], ACET[2]]);
  close(other[0], 45); close(other[1], right);
  const text = M.lines('acetabular', [35.86, 8.85], { sides: { left: 'Rt', right: 'Lt' } });
  assert.equal(text[1], 'Rt @35.9°(324.1°) · @144.1°(215.9°)');
  assert.equal(text[0], 'Lt @8.9°(351.2°) · @171.2°(188.9°)');
  assert.match(reason('acetabular', [ACET[0], ACET[0], ...ACET.slice(2)]), /기준선 A/);
});

// The four corners of a vertebral body around x = 120, the pelvic points around x = 130.
const BALANCE = [[100, 50], [140, 50], [142, 80], [98, 80], [60, 500], [200, 500]];
test('Spine Balance: the horizontal distance between the vertebral centre and the middle of the pelvic points', () => {
  close(values('spineBalance', BALANCE)[0], -10);
  close(values('spineBalance', BALANCE, [1, 0.5])[0], -5);
  // The corners in any order.
  close(values('spineBalance', [BALANCE[2], BALANCE[0], BALANCE[3], BALANCE[1], BALANCE[5], BALANCE[4]])[0], -10);
  assert.deepEqual(M.lines('spineBalance', [-10], { sides: { left: 'Rt', right: 'Lt' } }), ['Balance 10.0 mm (upper vertebral centre to the Rt)']);
  assert.deepEqual(M.lines('spineBalance', [4], { unit: 'px' }), ['Balance 4.0 px (upper vertebral centre to the Image right)', '픽셀 기준(간격 미확인)']);
});

// Lateral image, back to the image's right: the upper endplate falls towards the back, the lower one rises — lordosis.
const COBB = [[100, 100], [200, 120], [100, 300], [200, 280]];
const mirror = points => points.map(([x, y]) => [300 - x, y]);
test('Cobb Angle: the sign from where the back is — lordosis −, kyphosis +', () => {
  const lordosis = 2 * Math.atan(0.2) * DEG;
  close(values('spineCobb', COBB, [1, 1], { backSide: 'right' })[0], -lordosis);
  // The same spine seen mirrored, the back to the left: still a lordosis.
  close(values('spineCobb', mirror(COBB), [1, 1], { backSide: 'left' })[0], -lordosis);
  // The back on the other side of the same drawing: the curve is the other way round.
  close(values('spineCobb', COBB, [1, 1], { backSide: 'left' })[0], lordosis);
  // Lower line first, and each line's ends reversed: the same angle.
  close(values('spineCobb', [COBB[3], COBB[2], COBB[1], COBB[0]], [1, 1], { backSide: 'right' })[0], -lordosis);
  // Non-square pixels: the slopes are (row 2 mm) twice as steep.
  close(values('spineCobb', COBB, [2, 1], { backSide: 'right' })[0], -2 * Math.atan(0.4) * DEG);
  assert.equal(M.lines('spineCobb', [-22.62])[0], 'Lordosis @−22.6°(337.4°)');
  assert.equal(M.lines('spineCobb', [8.04])[0], 'Kyphosis @+8.0°(352.0°)');
  assert.match(reason('spineCobb', COBB, [1, 1], {}), /등의 위치/);
  // Two lines whose middles are at the same height: no upper line, so no sign — the value is "—", not a guess from the order.
  assert.deepEqual(values('spineCobb', [[100, 100], [200, 120], [100, 120], [200, 100]], [1, 1], { backSide: 'right' }), [null]);
  assert.match(M.lines('spineCobb', [null])[0], /^Cobb — /);
});

// Lateral image, the front to the image's left: femoral heads (300, 700) and (320, 700), S1 endplate front (300, 470), back (400, 400).
const PELVIS = [[300, 700], [320, 700], [300, 470], [400, 400]];
test('Pelvic Incidence: PI, PT and SS, PI = PT + SS = the angle the definition names', () => {
  const [pi, pt, ss] = values('pelvicIncidence', PELVIS);
  close(ss, Math.atan2(70, 100) * DEG); close(ss, 34.99202019855866);
  close(pt, Math.atan2(40, 265) * DEG); close(pt, 8.5836, 1e-4);
  close(pi, pt + ss); close(pi, M.incidenceDirect(PELVIS, [1, 1]));
  // Mirrored (front to the right), the heads in the other order, and non-square pixels: PI = PT + SS still holds.
  const flipped = values('pelvicIncidence', [[300 * 2 - 320, 700], [300 * 2 - 300, 700], [600 - 300, 470], [600 - 400, 400]]);
  flipped.forEach((n, i) => close(n, [pi, pt, ss][i]));
  const [pi2, pt2, ss2] = values('pelvicIncidence', PELVIS, [0.7, 0.3]);
  close(pi2, pt2 + ss2); close(pi2, M.incidenceDirect(PELVIS, [0.7, 0.3]));
  close(ss2, Math.atan2(70 * 0.7, 100 * 0.3) * DEG);
  // A hip axis behind the endplate's middle gives a negative PT, and PI is still PT + SS.
  const behind = values('pelvicIncidence', [[380, 700], [400, 700], PELVIS[2], PELVIS[3]]);
  assert.ok(behind[1] < 0); close(behind[0], behind[1] + behind[2]);
});

test('Pelvic Incidence: points out of order are refused, not calculated wrongly', () => {
  // The endplate marked first: the "hip axis" would be above the "endplate".
  assert.match(reason('pelvicIncidence', [PELVIS[2], PELVIS[3], PELVIS[0], PELVIS[1]]), /점 순서·원본 영상 방향을 확인하세요 \(①② 대퇴골두 중심이/);
  // The endplate's ends the other way round: every sign turns over and PI comes out below 0.
  assert.match(reason('pelvicIncidence', [PELVIS[0], PELVIS[1], PELVIS[3], PELVIS[2]]), /점 순서·원본 영상 방향을 확인하세요 \(③ S1 종판의 앞 끝, ④ 뒤 끝\)/);
  // PI = 0 can be drawn (the hip axis on the endplate's perpendicular): it is a value, not a refusal.
  const flat = values('pelvicIncidence', [[340, 700], [360, 700], [300, 400], [400, 400]]);
  close(flat[0], 0); close(flat[2], 0);
  assert.match(reason('pelvicIncidence', [PELVIS[0], PELVIS[1], [300, 470], [300, 400]]), /세로로/);
  assert.match(reason('pelvicIncidence', PELVIS.slice(0, 3)), /점 4개/);
});

test('An unknown spacing: values in pixels, angles marked as of the pixel grid', () => {
  assert.deepEqual(values('limbLength', LIMB, null).map(n => Math.round(n)), [80, 85, 5]);
  assert.deepEqual(M.lines('limbLength', [80, 85, 5], { unit: 'px' }),
    ['Image right 85.0 px · Image left 80.0 px', 'Difference 5.0 px (Image right longer)', '픽셀 기준(간격 미확인)']);
  assert.deepEqual(M.lines('pelvicIncidence', [43.58, 8.58, 35], { unit: 'px' }), ['PI 43.6° · PT 8.6° · SS 35.0°', '픽셀 기준(간격 미확인)']);
  assert.deepEqual(M.lines('pelvicIncidence', [1, 2]), ['재확인 필요: 값을 확인할 수 없습니다']);
  // The spacing basis sets the unit and is named with the values.
  assert.deepEqual(M.lines('spineBalance', [4], { basis: 'detector' }), ['Balance 4.0 mm (upper vertebral centre to the Image right)', 'ImagerPixelSpacing · 검출기 기준']);
  assert.deepEqual(M.lines('spineBalance', [4], { basis: 'px' }), ['Balance 4.0 px (upper vertebral centre to the Image right)', '픽셀 기준(간격 미확인)']);
  // Pixels only for an original without any spacing tag.
  assert.equal(M.hasSpacingTags({ Rows: 32 }), false);
  for (const key of ['PixelSpacing', 'ImagerPixelSpacing', 'SharedFunctionalGroupsSequence', 'PerFrameFunctionalGroupsSequence'])
    assert.equal(M.hasSpacingTags({ [key]: '1\\1' }), true, key);
});

test('Calculator names and the patient sides of the image', () => {
  assert.equal(M.calculator('spineCobb', 'pixel', 'right'), 'kin-spinecobb-v1:right:pixel');
  assert.equal(M.calculator('limbLength', 'px'), 'kin-limblength-v1:px');
  assert.equal(M.calculator('pelvicIncidence', 'us'), null);
  assert.equal(M.calculator('spineCobb', 'pixel'), null);
  assert.deepEqual(M.parseCalculator('kin-spinecobb-v1:left:detector'), { kind: 'spineCobb', backSide: 'left', basis: 'detector' });
  assert.deepEqual(M.parseCalculator('kin-acetabular-v1:ermf'), { kind: 'acetabular', basis: 'ermf' });
  for (const bad of ['kin-acetabular-v1', 'kin-acetabular-v1:us', 'kin-spinecobb-v1:pixel', 'kin-spinecobb-v1:up:pixel', 'kin-circle-v1:pixel:value', null])
    assert.equal(M.parseCalculator(bad), null);
  assert.deepEqual(M.sideNames({ ImageOrientationPatient: '1\\0\\0\\0\\0\\-1' }), { left: 'Rt', right: 'Lt', known: true });
  assert.deepEqual(M.sideNames({ ImageOrientationPatient: [-1, 0, 0, 0, 0, -1] }), { left: 'Lt', right: 'Rt', known: true });
  assert.deepEqual(M.sideNames({ PatientOrientation: 'L\\F' }), { left: 'Rt', right: 'Lt', known: true });
  assert.deepEqual(M.sideNames({ PatientOrientation: 'R\\F' }), { left: 'Lt', right: 'Rt', known: true });
  assert.deepEqual(M.sideNames({ PatientOrientation: 'A\\F' }), { left: 'Image left', right: 'Image right', known: false });
  assert.deepEqual(M.sideNames({}), { left: 'Image left', right: 'Image right', known: false });
  // An orientation whose rows run front to back names no side, whatever Patient Orientation says.
  assert.deepEqual(M.sideNames({ ImageOrientationPatient: '0\\1\\0\\0\\0\\-1', PatientOrientation: 'L\\F' }), { left: 'Image left', right: 'Image right', known: false });
});

// The server calculates the same values from the original's tags (api/src/ortho-geometry.ts). Where the compiled API is at
// hand (the CI image, or ORTHO_GEOMETRY_JS), the two must agree on every case above.
const serverPath = process.env.ORTHO_GEOMETRY_JS || '/app/dist/ortho-geometry.js';
let server = null;
try { server = require(serverPath); } catch (_) { server = null; }
test('The server calculation gives the browser values', { skip: !server && 'compiled API not present' }, () => {
  const cases = [['limbLength', LIMB, [0.5, 0.2]], ['acetabular', ACET, [2, 1]], ['spineBalance', BALANCE, [1, 0.5]],
    ['spineCobb', COBB, [2, 1], 'right'], ['spineCobb', COBB, [1, 1], 'left'], ['pelvicIncidence', PELVIS, [0.7, 0.3]], ['limbLength', LIMB, null]];
  for (const [kind, points, spacing, backSide] of cases) {
    const browser = M.compute(kind, points, spacing, { backSide }).values, own = server.orthoValues(kind, points, spacing, backSide);
    assert.equal(own.length, browser.length);
    own.forEach((n, i) => close(n, browser[i], 1e-9));
  }
  assert.throws(() => server.orthoValues('pelvicIncidence', [PELVIS[2], PELVIS[3], PELVIS[0], PELVIS[1]], [1, 1]));
});
