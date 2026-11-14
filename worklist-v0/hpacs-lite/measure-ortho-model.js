// Pure values of the Measure menu's orthopaedic and spine tools: Limb Length Discrepancy, Acetabular Angle, Spine Balance,
// Cobb Angle (Lordosis / Kyphosis) and Pelvic Incidence. Nothing here reads the screen.
//
// Points are image pixel coordinates (column x, row y; a whole number is the centre of a pixel), in the order the tool's
// steps ask for them. spacing = [row spacing, column spacing] in mm (DICOM PixelSpacing order), or null when the spacing is
// not known: then lengths are in pixels and angles are of the pixel grid. Every value is calculated on the patient plane
// (x = column × column spacing, y = row × row spacing), so pixels that are not square do not bend an angle. "Horizontal" and
// "vertical" are the image's row and column directions (an upright radiograph as stored), whatever the screen shows.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.KinMeasureOrthoModel = api;
})(globalThis, () => {
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const DEG = 180 / Math.PI, EPS = 1e-9;
  const KINDS = Object.freeze(['limbLength', 'acetabular', 'spineBalance', 'spineCobb', 'pelvicIncidence']);
  const POINTS = Object.freeze({ limbLength: 6, acetabular: 6, spineBalance: 6, spineCobb: 4, pelvicIncidence: 4 });
  const VALUES = Object.freeze({ limbLength: 3, acetabular: 2, spineBalance: 1, spineCobb: 1, pelvicIncidence: 3 });
  const NAMES = Object.freeze({ limbLength: 'limblength', acetabular: 'acetabular', spineBalance: 'spinebalance', spineCobb: 'spinecobb', pelvicIncidence: 'pelvicincidence' });
  // The spacing bases of a calculator name: those of planar-geometry.js, and 'px' when the spacing is not known.
  const BASES = Object.freeze(['pixel', 'detector', 'ermf', 'dbt', 'px']);
  const SIDES = Object.freeze(['right', 'left']);
  // The words for a spacing basis, shown with the values (as the Findings value text names them).
  const BASIS_LABELS = Object.freeze({ pixel: 'PixelSpacing', detector: 'ImagerPixelSpacing · 검출기 기준', ermf: 'ImagerPixelSpacing / ERMF · 추정 보정',
    dbt: 'DBT PixelSpacing', px: '픽셀 기준(간격 미확인)' });
  // Pixels are only for an original that holds no spacing at all: one whose spacing tags are there but cannot be used
  // (an orientation that does not hold, a calibration) is refused, not measured in pixels.
  const SPACING_TAGS = Object.freeze(['PixelSpacing', 'ImagerPixelSpacing', 'SharedFunctionalGroupsSequence', 'PerFrameFunctionalGroupsSequence']);
  const hasSpacingTags = tags => !!tags && SPACING_TAGS.some(key => tags[key] !== undefined && tags[key] !== null && tags[key] !== '');

  // kin-<tool>-v1:<basis>, and for the Cobb angle kin-spinecobb-v1:<back side on the image>:<basis>.
  function calculator(kind, basis, backSide) {
    if (!KINDS.includes(kind) || !BASES.includes(basis)) return null;
    if (kind === 'spineCobb') return SIDES.includes(backSide) ? 'kin-spinecobb-v1:' + backSide + ':' + basis : null;
    return 'kin-' + NAMES[kind] + '-v1:' + basis;
  }
  // { kind, basis, backSide } of a calculator name, or null.
  function parseCalculator(name) {
    if (typeof name !== 'string') return null;
    const parts = name.split(':'), kind = KINDS.find(k => parts[0] === 'kin-' + NAMES[k] + '-v1');
    if (!kind) return null;
    if (kind === 'spineCobb') return parts.length === 3 && SIDES.includes(parts[1]) && BASES.includes(parts[2]) ? { kind, backSide: parts[1], basis: parts[2] } : null;
    return parts.length === 2 && BASES.includes(parts[1]) ? { kind, basis: parts[1] } : null;
  }

  // ── Plane geometry, y upwards ──
  const fail = reason => { const error = new Error(reason); error.measure = true; throw error; };
  function physical(points, spacing, count) {
    if (!Array.isArray(points) || points.length !== count || !points.every(p => Array.isArray(p) && p.length >= 2 && finite(p[0]) && finite(p[1])))
      fail('점 ' + count + '개가 필요합니다');
    const [row, column] = spacing == null ? [1, 1] : spacing;
    if (!finite(row) || !finite(column) || row <= 0 || column <= 0) fail('간격이 올바르지 않습니다');
    return points.map(([x, y]) => [x * column, -y * row]);
  }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const len = a => Math.hypot(a[0], a[1]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  // The acute angle between two lines that have no direction, 0–90°.
  const lineAngle = (u, v) => Math.acos(Math.min(1, Math.abs(dot(u, v)) / len(u) / len(v))) * DEG;
  // The distinct-points check of a line; scale: the size of the drawing, so a line of a hair's width is refused.
  function line(a, b, what, scale) {
    const u = sub(b, a);
    if (len(u) <= Math.max(EPS, scale * 1e-6)) fail(what + '의 두 점을 떼어 찍으세요');
    return u;
  }
  const size = points => Math.max(...points.map(p => len(sub(p, points[0]))), 1);

  // Limb Length Discrepancy: ①② the base line, ③④ the same pelvic landmark on both sides (e.g. the ischial tuberosities),
  // ⑤⑥ the same femoral landmark on both sides (e.g. the midpoint of the lesser trochanter). On each side, the distance from
  // its pelvic landmark to its femoral landmark measured across the base line (the femoral landmark's distance from the base
  // line less the pelvic one's, so a tilted pelvis is taken out). The sides pair by their place on the image, not by order.
  // values: [image-left side, image-right side, |left − right|].
  function limbLength(P) {
    const s = size(P), base = line(P[0], P[1], '기준선', s), n = [-base[1] / len(base), base[0] / len(base)];
    const across = p => dot(sub(p, P[0]), n);
    const [pl, pr] = P[2][0] <= P[3][0] ? [P[2], P[3]] : [P[3], P[2]];
    const [fl, fr] = P[4][0] <= P[5][0] ? [P[4], P[5]] : [P[5], P[4]];
    if (len(sub(pl, pr)) <= s * 1e-6) fail('좌우 골반 표지를 따로 찍으세요');
    if (len(sub(fl, fr)) <= s * 1e-6) fail('좌우 대퇴 표지를 따로 찍으세요');
    const left = Math.abs(across(fl) - across(pl)), right = Math.abs(across(fr) - across(pr));
    return [left, right, Math.abs(left - right)];
  }
  // Acetabular Angle (the original's figure): ①② line A, which joins both sides; ③④ and ⑤⑥ the acetabular lines of the
  // two sides. At each end of A: the acute angle between A and that side's line (its supplement is 180° less it). The two
  // lines take the side their middle is on, so the order of the two lines does not matter. values: [image-left, image-right].
  function acetabular(P) {
    const s = size(P), a = line(P[0], P[1], '기준선 A', s), one = line(P[2], P[3], '③④ 비구 선', s), two = line(P[4], P[5], '⑤⑥ 비구 선', s);
    const [left, right] = mid(P[2], P[3])[0] <= mid(P[4], P[5])[0] ? [one, two] : [two, one];
    return [lineAngle(a, left), lineAngle(a, right)];
  }
  // Spine Balance on a frontal (PA) whole-spine image: ①–④ the four corners of an upper vertebral body, ⑤⑥ two points at the
  // level of the pelvis, one on each side. The vertical line from the middle of the four corners and the vertical line from
  // the middle of ⑤⑥: their horizontal distance. values: [signed distance, + when the vertebra is to the image's right].
  function spineBalance(P) {
    const s = size(P);
    line(P[4], P[5], '⑤⑥ 골반 선', s);
    const corners = P.slice(0, 4), centre = [corners.reduce((sum, p) => sum + p[0], 0) / 4, 0];
    if (Math.max(...corners.map(p => p[0])) - Math.min(...corners.map(p => p[0])) <= s * 1e-6) fail('①–④ 척추체의 네 모서리를 찍으세요');
    return [centre[0] - mid(P[4], P[5])[0]];
  }
  // Spine Cobb Angle on a lateral image: ①② one endplate line, ③④ the other, then where the back is (on the image). With both
  // lines pointed towards the back, the angle from the lower line to the upper line: lines that close in towards the back
  // are a lordosis (−), towards the front a kyphosis (+). The upper line is the one whose middle is higher (the order of the
  // two lines does not matter). Lines whose middles are at the same height have no upper one: the value is null ("—").
  // values: [signed angle, −180° to 180°, or null].
  function spineCobb(P, backSide) {
    if (!SIDES.includes(backSide)) fail('등의 위치를 고르세요');
    const s = size(P), b = backSide === 'right' ? 1 : -1;
    const lines = [[P[0], P[1]], [P[2], P[3]]].map(([p, q], i) => ({ u: line(p, q, i ? '③④ 종판 선' : '①② 종판 선', s), m: mid(p, q) }));
    if (Math.abs(lines[1].m[1] - lines[0].m[1]) <= s * 1e-6) return [null];
    const [upper, lower] = lines[1].m[1] > lines[0].m[1] ? [lines[1], lines[0]] : lines;
    // In a frame where the back is +x: each line pointed to the back has an angle in (−90°, 90°].
    const tilt = u => { let x = u[0] * b, y = u[1]; if (x < 0 || x === 0 && y < 0) { x = -x; y = -y; } return Math.atan2(y, x) * DEG; };
    let angle = tilt(upper.u) - tilt(lower.u);
    if (angle > 180) angle -= 360; if (angle <= -180) angle += 360;
    return [angle];
  }
  // Pelvic Incidence on a lateral image, the points in order (the original: out of order it calculates wrongly): ①② the
  // centres of the two femoral heads (their middle is the hip axis H), ③ the front (lower) end and ④ the back (upper) end
  // of the upper S1 endplate (its middle M). The front is the way from ④ to ③.
  // SS: the endplate against the horizontal (+ when its back end is higher). PT: the line H→M against the vertical
  // (+ when H is in front of M). PI = PT + SS, which is the angle between the endplate's perpendicular and M→H.
  // values: [PI, PT, SS].
  const ORDER = '점 순서·원본 영상 방향을 확인하세요';
  function pelvicIncidence(P) {
    const s = size(P), front = P[2], back = P[3];
    line(front, back, '③④ S1 종판', s);
    const a = Math.sign(front[0] - back[0]);
    if (!a) fail('③ 종판의 앞 끝, ④ 뒤 끝을 찍으세요(두 점이 세로로 놓였습니다)');
    const H = mid(P[0], P[1]), M = mid(front, back);
    if (H[1] >= M[1] - s * 1e-6) fail(ORDER + ' (①② 대퇴골두 중심이 ③④ 종판보다 아래에 있어야 합니다)');
    const ss = Math.atan2(back[1] - front[1], a * (front[0] - back[0])) * DEG;
    const pt = Math.atan2(a * (H[0] - M[0]), M[1] - H[1]) * DEG;
    const pi = pt + ss;
    if (pi < 0) fail(ORDER + ' (③ S1 종판의 앞 끝, ④ 뒤 끝)');
    return [pi, pt, ss];
  }
  // The angle between the endplate's perpendicular (pointing down) and M→H: the PI the definition names, for the tests.
  function incidenceDirect(points, spacing) {
    const P = physical(points, spacing, 4), front = P[2], back = P[3], H = mid(P[0], P[1]), M = mid(front, back);
    const plate = sub(front, back), down = [plate[1], -plate[0]], normal = down[1] <= 0 ? down : [-down[0], -down[1]];
    const mh = sub(H, M);
    return Math.acos(Math.min(1, Math.max(-1, dot(normal, mh) / len(normal) / len(mh)))) * DEG;
  }

  const TOOLS = { limbLength, acetabular, spineBalance, spineCobb, pelvicIncidence };
  // The one value that may be undetermined: the Cobb angle of two lines at the same height.
  const nullable = (kind, index) => kind === 'spineCobb' && index === 0;
  // { values } or { reason }. options.backSide: 'right' | 'left' for the Cobb angle.
  function compute(kind, points, spacing, options = {}) {
    if (!KINDS.includes(kind)) return { reason: '측정 종류를 확인할 수 없습니다' };
    try {
      const values = TOOLS[kind](physical(points, spacing, POINTS[kind]), options.backSide);
      if (values.length !== VALUES[kind] || !values.every((n, i) => finite(n) || nullable(kind, i) && n === null)) return { reason: '값을 계산할 수 없습니다' };
      return { values };
    } catch (error) {
      if (error.measure) return { reason: error.message };
      throw error;
    }
  }

  // ── Words ──
  // The patient sides of the image's left and right edges, from the original's tags: Image Orientation (Patient)'s row
  // direction, else the first Patient Orientation value. Without either: the image's own left and right.
  function sideNames(tags) {
    const numbers = value => (typeof value === 'string' ? value.split('\\') : Array.isArray(value) ? value : []).map(Number);
    const row = numbers(tags?.ImageOrientationPatient);
    let towards = '';
    // A row direction that runs mostly along the patient's left–right axis names the sides; another one names none.
    if (row.length === 6 && row.every(finite)) { if (Math.abs(row[0]) > Math.abs(row[1]) && Math.abs(row[0]) > Math.abs(row[2])) towards = row[0] > 0 ? 'L' : 'R'; }
    else {
      const first = (typeof tags?.PatientOrientation === 'string' ? tags.PatientOrientation.split('\\') : Array.isArray(tags?.PatientOrientation) ? tags.PatientOrientation : [])[0];
      if (typeof first === 'string' && /^[LR]/.test(first.trim())) towards = first.trim()[0];
    }
    // Columns running towards the patient's left: the image's left edge is the patient's right.
    if (towards === 'L') return { left: 'Rt', right: 'Lt', known: true };
    if (towards === 'R') return { left: 'Lt', right: 'Rt', known: true };
    return { left: 'Image left', right: 'Image right', known: false };
  }
  const one = n => (Math.round(n * 10) / 10).toFixed(1);
  const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + one(Math.abs(n));
  // The lines shown in the panel, beside the mark and in the Job print. basis: the calculator's spacing basis, which sets
  // the unit (px: pixels) and adds its words; without it, unit says 'mm' or 'px'. sides: sideNames().
  function lines(kind, values, { basis, unit = basis === 'px' ? 'px' : 'mm', sides = sideNames(null), backSide } = {}) {
    if (!KINDS.includes(kind) || !Array.isArray(values) || values.length !== VALUES[kind] || !values.every((n, i) => finite(n) || nullable(kind, i) && n === null)) return ['재확인 필요: 값을 확인할 수 없습니다'];
    const u = ' ' + unit, grid = unit === 'px' ? [BASIS_LABELS.px] : basis && BASIS_LABELS[basis] ? [BASIS_LABELS[basis]] : [];
    if (kind === 'limbLength') {
      const [left, right, diff] = values, longer = Math.abs(left - right) < 0.05 ? '' : ' (' + (left > right ? sides.left : sides.right) + ' longer)';
      return [sides.right + ' ' + one(right) + u + ' · ' + sides.left + ' ' + one(left) + u, 'Difference ' + one(diff) + u + longer, ...grid];
    }
    if (kind === 'acetabular') {
      const at = (name, a) => name + ' @' + one(a) + '°(' + one(360 - a) + '°) · @' + one(180 - a) + '°(' + one(180 + a) + '°)';
      return [at(sides.right, values[1]), at(sides.left, values[0]), ...grid];
    }
    if (kind === 'spineBalance') {
      const d = values[0], way = Math.abs(d) < 0.05 ? '' : ' (upper vertebral centre to the ' + (d > 0 ? sides.right : sides.left) + ')';
      return ['Balance ' + one(Math.abs(d)) + u + way, ...grid];
    }
    if (kind === 'spineCobb') {
      const a = values[0], name = a === null ? 'Cobb' : a < 0 ? 'Lordosis' : a > 0 ? 'Kyphosis' : 'Cobb';
      const value = a === null ? ' — (위·아래 선을 가릴 수 없습니다: 두 선의 가운데가 같은 높이)' : ' @' + signed(a) + '°(' + one(360 - Math.abs(a)) + '°)';
      return [name + value, ...(backSide ? ['Back: image ' + backSide] : []), ...grid];
    }
    const [pi, pt, ss] = values;
    return ['PI ' + one(pi) + '° · PT ' + one(pt) + '° · SS ' + one(ss) + '°', ...grid];
  }

  return Object.freeze({ KINDS, POINTS, VALUES, BASES, SIDES, BASIS_LABELS, hasSpacingTags, calculator, parseCalculator, compute, incidenceDirect, sideNames, lines, nullable });
});
