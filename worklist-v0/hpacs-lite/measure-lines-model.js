// Pure values of the Measure menu's line tools: CTR (4-line and 2-line), Parallel Lines, Length Ratio, Centre-line Angle and
// Volume Measure. Nothing here reads the screen. Points are image pixel coordinates [column x, row y]; spacing is
// [row spacing, column spacing] in mm (DICOM PixelSpacing order), or null where the image's spacing is not known: then every
// length is in pixels and a ratio or an angle is a pixel-based value. Every calculation is done on the patient (the pixel
// coordinates times the spacing), so pixels that are not square do not change a ratio or an angle.
// A value that cannot be defined (a line of length 0, a ratio over 0) is null; the screen shows it as "—".
// The server checks a saved mark with the same calculation (api/src/measure-lines.ts).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.KinMeasureLinesModel = api;
})(globalThis, () => {
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const EPS = 1e-9;
  function checkSpacing(spacing) {
    if (spacing === null) return [1, 1];
    if (!Array.isArray(spacing) || spacing.length !== 2 || !spacing.every(n => finite(n) && n > 0)) throw new Error('간격을 확인할 수 없습니다');
    return spacing;
  }
  function checkPoints(points, count) {
    if (!Array.isArray(points) || points.length !== count || !points.every(p => Array.isArray(p) && p.length === 2 && p.every(finite)))
      throw new Error('점 ' + count + '개가 필요합니다');
  }
  // Pixel ↔ patient (mm, or pixels without a spacing).
  const toMm = (p, s) => [p[0] * s[1], p[1] * s[0]];
  const toPixel = (p, s) => [p[0] / s[1], p[1] / s[0]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
  const scale = (a, k) => [a[0] * k, a[1] * k];
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
  const size = a => Math.hypot(a[0], a[1]);
  const mm = (points, spacing) => { const s = checkSpacing(spacing); return points.map(p => toMm(p, s)); };
  const divide = (a, b) => a === null || b === null || !(Math.abs(b) > EPS) ? null : a / b;

  // ── One length ──
  function length(points, spacing) { checkPoints(points, 2); const [a, b] = mm(points, spacing); return size(sub(b, a)); }

  // ── CTR ──
  // 4-line (INFINITT CT Ratio; HPACS MRD · MLD · ID): ① the midline, two points (top of the aorta to the base of the heart);
  // ② the right heart border's farthest point; ③ the left heart border's farthest point; ④ the widest line across the lung
  // field, two points. MRD and MLD are the distances of ② and ③ from the midline (the straight line through ①, so a tilted
  // midline is followed), ID the length of ④. CTR = (MRD + MLD) / ID. values: [MRD, MLD, ID, CTR].
  function ctr4(points, spacing) {
    checkPoints(points, 6);
    const [m1, m2, right, left, l1, l2] = mm(points, spacing), axis = sub(m2, m1), axisLength = size(axis);
    const away = p => axisLength > EPS ? Math.abs(cross(axis, sub(p, m1))) / axisLength : null;
    const mrd = away(right), mld = away(left), id = size(sub(l2, l1));
    return [mrd, mld, id, mrd === null ? null : divide(mrd + mld, id)];
  }
  // 2-line (HPACS 2Line CTR): two lines; the longer is ID (the chest), the other CD (the heart), whatever the order they
  // were drawn in. CTR = CD / ID. values: [CD, ID, CTR].
  function ctr2(points, spacing) {
    checkPoints(points, 4);
    const [a1, a2, b1, b2] = mm(points, spacing), a = size(sub(a2, a1)), b = size(sub(b2, b1));
    const id = Math.max(a, b), cd = Math.min(a, b);
    return [cd, id, divide(cd, id)];
  }
  // The points of the four-line midline's helper segments, for drawing: the foot of ② and ③ on the midline.
  function ctrFeet(points, spacing) {
    checkPoints(points, 6);
    const s = checkSpacing(spacing), [m1, m2, right, left] = points.slice(0, 4).map(p => toMm(p, s)), axis = sub(m2, m1), n = dot(axis, axis);
    if (!(n > EPS)) return null;
    const foot = p => toPixel(add(m1, scale(axis, dot(sub(p, m1), axis) / n)), s);
    return [foot(right), foot(left)];
  }

  // ── Parallel Lines ──
  // The second line placed from one press: parallel to the first, as long as it, its middle at the press (on the patient).
  function parallelSecond(first, press, spacing) {
    checkPoints(first, 2); checkPoints([press], 1);
    const s = checkSpacing(spacing), [a, b] = first.map(p => toMm(p, s)), c = toMm(press, s), half = scale(sub(b, a), .5);
    return [toPixel(sub(c, half), s), toPixel(add(c, half), s)];
  }
  // The second line brought back parallel to the first: it keeps its middle and its length and takes the first's direction
  // (the order of its two ends is kept where it can be: the end nearer the first line's start stays first).
  function parallelAlign(points, spacing) {
    checkPoints(points, 4);
    const s = checkSpacing(spacing), [a, b, c, d] = points.map(p => toMm(p, s)), dir = sub(b, a), n = size(dir);
    if (!(n > EPS)) return points.map(p => [...p]);
    const unit = scale(dir, 1 / n), half = size(sub(d, c)) / 2, m = mid(c, d), sign = dot(sub(d, c), unit) < 0 ? -1 : 1;
    return [points[0], points[1], toPixel(sub(m, scale(unit, half * sign)), s), toPixel(add(m, scale(unit, half * sign)), s)].map(p => [...p]);
  }
  // Moving one end of the second line: it slides along the line only (the line stays parallel; its other end stays).
  function parallelSlide(points, index, to, spacing) {
    checkPoints(points, 4); checkPoints([to], 1);
    if (index !== 2 && index !== 3) throw new Error('둘째 선의 끝점만 미끄러집니다');
    const s = checkSpacing(spacing), [a, b, c, d] = points.map(p => toMm(p, s)), dir = sub(b, a), n = dot(dir, dir);
    const base = index === 2 ? c : d, other = index === 2 ? d : c, t = toMm(to, s);
    const moved = n > EPS ? add(base, scale(dir, dot(sub(t, base), dir) / n)) : base;
    if (size(sub(moved, other)) <= EPS) return points.map(p => [...p]);
    const out = points.map(p => [...p]); out[index] = toPixel(moved, s); return out;
  }
  // Gap (Line Distance): the perpendicular distance between the two lines. Centre (INFINITT Center line): the length of the
  // line joining the middles of the two lines. values: [Gap, Centre].
  function parallel(points, spacing) {
    checkPoints(points, 4);
    const [a, b, c, d] = mm(points, spacing), dir = sub(b, a), n = size(dir), joint = sub(mid(c, d), mid(a, b));
    return [n > EPS ? Math.abs(cross(dir, joint)) / n : null, size(joint)];
  }
  // The middles of the two lines (the centre line), in pixels.
  const parallelCentre = points => { checkPoints(points, 4); return [mid(points[0], points[1]), mid(points[2], points[3])]; };

  // ── Length Ratio ──
  // values: [Length 1, Length 2, Length 1 / Length 2].
  function ratio(points, spacing) {
    checkPoints(points, 4);
    const [a, b, c, d] = mm(points, spacing), l1 = size(sub(b, a)), l2 = size(sub(d, c));
    return [l1, l2, divide(l1, l2)];
  }

  // ── Centre-line Angle ──
  // The centre line of two lines: their ends are paired front with front and back with back along the first line's
  // direction (the second line's ends are swapped when it points the other way), and the centre line joins the middles of
  // the pairs. Drawing either line the other way round gives the same centre line. null when both lines have no length.
  function centreLine(a1, a2, b1, b2) {
    let dir = sub(a2, a1);
    if (!(size(dir) > EPS)) dir = sub(b2, b1);
    if (!(size(dir) > EPS)) return null;
    if (dot(sub(b2, b1), dir) < 0) [b1, b2] = [b2, b1];
    if (dot(sub(a2, a1), dir) < 0) [a1, a2] = [a2, a1];
    return [mid(a1, b1), mid(a2, b2)];
  }
  // The two centre lines (lines 1 and 2, lines 3 and 4), in pixels, for drawing; null for one that has no direction.
  function centreLines(points, spacing) {
    checkPoints(points, 8);
    const s = checkSpacing(spacing), p = points.map(q => toMm(q, s));
    return [centreLine(p[0], p[1], p[2], p[3]), centreLine(p[4], p[5], p[6], p[7])].map(line => line && line.map(q => toPixel(q, s)));
  }
  // The direction of a centre line, fixed by the image and not by the order of the presses: towards the bottom of the image
  // (increasing rows), or towards the right for a line along a row.
  const downward = u => u[1] > EPS || Math.abs(u[1]) <= EPS && u[0] > 0 ? u : scale(u, -1);
  // The angle between the two centre lines, each pointing down the image: 0–180°, with 360° − angle beside it (as the
  // viewer's angles give the inside and, in brackets, the outside). values: [angle, 360 − angle].
  function centreAngle(points, spacing) {
    checkPoints(points, 8);
    const p = mm(points, spacing), a = centreLine(p[0], p[1], p[2], p[3]), b = centreLine(p[4], p[5], p[6], p[7]);
    const u = a && sub(a[1], a[0]), v = b && sub(b[1], b[0]);
    if (!u || !v || !(size(u) > EPS) || !(size(v) > EPS)) return [null, null];
    const [x, y] = [downward(u), downward(v)];
    const angle = Math.atan2(Math.abs(cross(x, y)), dot(x, y)) * 180 / Math.PI;
    return [angle, 360 - angle];
  }

  // ── Volume Measure ──
  // INFINITT 2D Volume Measurement: Ellipsoid = π/6 × L × H × W; Prolate spheroid = π/6 × L × W² (no Height). Lengths in mm,
  // the volume in mL (mm³ / 1000). null until every length the formula needs is measured and longer than 0.
  const FORMULAS = Object.freeze(['ellipsoid', 'prolate']);
  const formulaParts = formula => formula === 'prolate' ? ['Length', 'Width'] : ['Length', 'Height', 'Width'];
  function volume(formula, lengths) {
    if (!FORMULAS.includes(formula)) throw new Error('공식을 고르세요');
    const parts = formulaParts(formula), values = parts.map(part => lengths?.[part]);
    if (!values.every(n => finite(n) && n > 0)) return null;
    const [l, a, b] = values;
    return formula === 'prolate' ? Math.PI / 6 * l * a * a / 1000 : Math.PI / 6 * l * a * b / 1000;
  }

  // ── The calculators and their values, as saved ──
  // calculator 'kin-<tool>-v1:<basis>'; basis 'px' when the spacing is not known (lengths in pixels, ratios and angles
  // pixel-based). A Volume is never calculated in pixels.
  const TOOLS = Object.freeze({ ctr4: { points: 6, values: ctr4 }, ctr2: { points: 4, values: ctr2 }, parallel: { points: 4, values: parallel },
    ratio: { points: 4, values: ratio }, centreangle: { points: 8, values: centreAngle } });
  const BASES = Object.freeze(['pixel', 'detector', 'ermf', 'dbt', 'us', 'px']);
  function calculate(tool, points, spacing) {
    const spec = TOOLS[tool]; if (!spec) throw new Error('알 수 없는 측정입니다');
    return spec.values(points, spacing);
  }
  // Values are equal when each is null in both or within a millionth of a millimetre (or degree).
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    a.every((n, i) => n === null ? b[i] === null : finite(n) && finite(b[i]) && Math.abs(n - b[i]) <= Math.max(1e-6, Math.abs(n) * 1e-9));

  // ── The words shown beside a mark and in the panel ──
  const one = n => n === null || !finite(n) ? '—' : (Math.round(n * 10) / 10).toFixed(1);
  const two = n => n === null || !finite(n) ? '—' : (Math.round(n * 100) / 100).toFixed(2);
  const percent = n => n === null || !finite(n) ? '' : ' (' + one(n * 100) + '%)';
  const unitOf = basis => basis === 'px' ? 'px' : 'mm';
  const PIXEL_BASED = '픽셀 기준(간격 미확인)';
  function lines(tool, values, basis) {
    const u = ' ' + unitOf(basis), px = basis === 'px';
    if (!Array.isArray(values)) return ['재확인 필요: 값을 확인할 수 없습니다'];
    switch (tool) {
      case 'ctr4': return ['CTR ' + two(values[3]) + percent(values[3]), 'MRD ' + one(values[0]) + u + ' · MLD ' + one(values[1]) + u + ' · ID ' + one(values[2]) + u, ...(px ? [PIXEL_BASED] : [])];
      case 'ctr2': return ['CTR ' + two(values[2]) + percent(values[2]), 'CD ' + one(values[0]) + u + ' · ID ' + one(values[1]) + u, ...(px ? [PIXEL_BASED] : [])];
      case 'parallel': return ['Gap ' + one(values[0]) + u + ' · Centre ' + one(values[1]) + u, ...(px ? ['간격 확인 불가'] : [])];
      case 'ratio': return ['Ratio (L1/L2) ' + two(values[2]), 'Length 1 ' + one(values[0]) + u + ' · Length 2 ' + one(values[1]) + u, ...(px ? [PIXEL_BASED] : [])];
      case 'centreangle': return [values[0] === null ? 'Angle —' : 'Angle ' + one(values[0]) + '° (' + one(values[1]) + '°)', ...(px ? [PIXEL_BASED] : [])];
      default: return ['재확인 필요: 값을 확인할 수 없습니다'];
    }
  }
  const volumeText = n => n === null || !finite(n) ? '—' : two(n) + ' mL';

  return Object.freeze({ length, ctr4, ctr2, ctrFeet, parallelSecond, parallelAlign, parallelSlide, parallel, parallelCentre, ratio,
    centreLine, centreLines, centreAngle, FORMULAS, formulaParts, volume, TOOLS, BASES, calculate, same, lines, one, two, volumeText,
    unitOf, PIXEL_BASED });
});
