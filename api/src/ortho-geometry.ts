// The values of the Measure menu's orthopaedic and spine marks, calculated again on the server from the original's tags.
// The same definitions as the viewer's worklist-v0/hpacs-lite/measure-ortho-model.js (tests/measure_ortho_model_test.cjs
// holds both to the same hand-computed cases). points: image pixel coordinates [column, row]; spacing: [row, column] mm,
// or null when the spacing is not known (pixels). Every value is on the patient plane, y upwards.
export const ORTHO_KINDS = Object.freeze(['limbLength', 'acetabular', 'spineBalance', 'spineCobb', 'pelvicIncidence']);
export const ORTHO_POINTS: Readonly<Record<string, number>> = Object.freeze({ limbLength: 6, acetabular: 6, spineBalance: 6, spineCobb: 4, pelvicIncidence: 4 });
export const ORTHO_VALUES: Readonly<Record<string, number>> = Object.freeze({ limbLength: 3, acetabular: 2, spineBalance: 1, spineCobb: 1, pelvicIncidence: 3 });
const NAMES: Record<string, string> = { limbLength: 'limblength', acetabular: 'acetabular', spineBalance: 'spinebalance', spineCobb: 'spinecobb', pelvicIncidence: 'pelvicincidence' };
export const ORTHO_BASES = Object.freeze(['pixel', 'detector', 'ermf', 'dbt', 'px']);
const SIDES = ['right', 'left'];
// Pixels are only for an original with no spacing tags at all (the viewer's measure-ortho-model.js hasSpacingTags).
const SPACING_TAGS = ['PixelSpacing', 'ImagerPixelSpacing', 'SharedFunctionalGroupsSequence', 'PerFrameFunctionalGroupsSequence'];
export const hasSpacingTags = (tags: any) => !!tags && SPACING_TAGS.some(key => tags[key] !== undefined && tags[key] !== null && tags[key] !== '');
const DEG = 180 / Math.PI, EPS = 1e-9;
type P = [number, number];

// { basis, backSide } of a calculator name of this kind, or null.
export function orthoCalculator(kind: string, name: unknown): { basis: string; backSide?: string } | null {
  if (!ORTHO_KINDS.includes(kind) || typeof name !== 'string') return null;
  const parts = name.split(':');
  if (parts[0] !== 'kin-' + NAMES[kind] + '-v1') return null;
  if (kind === 'spineCobb') return parts.length === 3 && SIDES.includes(parts[1]) && ORTHO_BASES.includes(parts[2]) ? { backSide: parts[1], basis: parts[2] } : null;
  return parts.length === 2 && ORTHO_BASES.includes(parts[1]) ? { basis: parts[1] } : null;
}
export const orthoNullable = (kind: string, index: number) => kind === 'spineCobb' && index === 0;

const fail = (reason: string): never => { throw new Error(reason); };
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const mid = (a: P, b: P): P => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const len = (a: P) => Math.hypot(a[0], a[1]);
const dot = (a: P, b: P) => a[0] * b[0] + a[1] * b[1];
const lineAngle = (u: P, v: P) => Math.acos(Math.min(1, Math.abs(dot(u, v)) / len(u) / len(v))) * DEG;
function line(a: P, b: P, what: string, scale: number): P {
  const u = sub(b, a);
  if (len(u) <= Math.max(EPS, scale * 1e-6)) fail(what + '의 두 점을 떼어 찍으세요');
  return u;
}
const size = (points: P[]) => Math.max(...points.map(p => len(sub(p, points[0]))), 1);

function limbLength(P: P[]): (number | null)[] {
  const s = size(P), base = line(P[0], P[1], '기준선', s), n: P = [-base[1] / len(base), base[0] / len(base)];
  const across = (p: P) => dot(sub(p, P[0]), n);
  const [pl, pr] = P[2][0] <= P[3][0] ? [P[2], P[3]] : [P[3], P[2]];
  const [fl, fr] = P[4][0] <= P[5][0] ? [P[4], P[5]] : [P[5], P[4]];
  if (len(sub(pl, pr)) <= s * 1e-6) fail('좌우 골반 표지를 따로 찍으세요');
  if (len(sub(fl, fr)) <= s * 1e-6) fail('좌우 대퇴 표지를 따로 찍으세요');
  const left = Math.abs(across(fl) - across(pl)), right = Math.abs(across(fr) - across(pr));
  return [left, right, Math.abs(left - right)];
}
function acetabular(P: P[]): (number | null)[] {
  const s = size(P), a = line(P[0], P[1], '기준선 A', s), one = line(P[2], P[3], '③④ 비구 선', s), two = line(P[4], P[5], '⑤⑥ 비구 선', s);
  const [left, right] = mid(P[2], P[3])[0] <= mid(P[4], P[5])[0] ? [one, two] : [two, one];
  return [lineAngle(a, left), lineAngle(a, right)];
}
function spineBalance(P: P[]): (number | null)[] {
  const s = size(P);
  line(P[4], P[5], '⑤⑥ 골반 선', s);
  const corners = P.slice(0, 4), centre = corners.reduce((sum, p) => sum + p[0], 0) / 4;
  if (Math.max(...corners.map(p => p[0])) - Math.min(...corners.map(p => p[0])) <= s * 1e-6) fail('①–④ 척추체의 네 모서리를 찍으세요');
  return [centre - mid(P[4], P[5])[0]];
}
function spineCobb(P: P[], backSide?: string): (number | null)[] {
  if (!SIDES.includes(backSide)) fail('등의 위치를 고르세요');
  const s = size(P), b = backSide === 'right' ? 1 : -1;
  const lines = [[P[0], P[1]], [P[2], P[3]]].map(([p, q], i) => ({ u: line(p, q, i ? '③④ 종판 선' : '①② 종판 선', s), m: mid(p, q) }));
  if (Math.abs(lines[1].m[1] - lines[0].m[1]) <= s * 1e-6) return [null];
  const [upper, lower] = lines[1].m[1] > lines[0].m[1] ? [lines[1], lines[0]] : lines;
  const tilt = (u: P) => { let x = u[0] * b, y = u[1]; if (x < 0 || x === 0 && y < 0) { x = -x; y = -y; } return Math.atan2(y, x) * DEG; };
  let angle = tilt(upper.u) - tilt(lower.u);
  if (angle > 180) angle -= 360; if (angle <= -180) angle += 360;
  return [angle];
}
const ORDER = '점 순서·원본 영상 방향을 확인하세요';
function pelvicIncidence(P: P[]): (number | null)[] {
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
const TOOLS: Record<string, (P: P[], backSide?: string) => (number | null)[]> = { limbLength, acetabular, spineBalance, spineCobb, pelvicIncidence };

// The values, or an Error with the reason.
export function orthoValues(kind: string, points: number[][], spacing: number[] | null, backSide?: string): (number | null)[] {
  if (!ORTHO_KINDS.includes(kind)) fail('측정 종류를 확인할 수 없습니다');
  const count = ORTHO_POINTS[kind];
  if (!Array.isArray(points) || points.length !== count || !points.every(p => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])))
    fail('점 ' + count + '개가 필요합니다');
  const [row, column] = spacing == null ? [1, 1] : spacing;
  if (!Number.isFinite(row) || !Number.isFinite(column) || row <= 0 || column <= 0) fail('간격이 올바르지 않습니다');
  const values = TOOLS[kind](points.map(([x, y]) => [x * column, -y * row] as P), backSide);
  if (values.length !== ORTHO_VALUES[kind] || !values.every((n, i) => Number.isFinite(n) || orthoNullable(kind, i) && n === null)) fail('값을 계산할 수 없습니다');
  return values;
}
