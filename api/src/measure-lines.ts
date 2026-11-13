// The Measure menu's line tools, as the server checks a saved mark: the same calculation as the viewer's
// worklist-v0/hpacs-lite/measure-lines-model.js (tests/measure_lines_model_test.cjs runs both on the same presses).
// Points are image pixel coordinates [column, row]; spacing [row, column] in mm, or null for a pixel-based mark.
// A value that cannot be defined (a line of length 0, a ratio over 0) is null.
type Point = number[];
const EPS = 1e-9;
const sub = (a: Point, b: Point) => [a[0] - b[0], a[1] - b[1]];
const scale = (a: Point, k: number) => [a[0] * k, a[1] * k];
const mid = (a: Point, b: Point) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];
const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0];
const size = (a: Point) => Math.hypot(a[0], a[1]);
const divide = (a: number | null, b: number | null) => a === null || b === null || !(Math.abs(b) > EPS) ? null : a / b;
function mm(points: Point[], spacing: number[] | null): Point[] {
  const s = spacing ?? [1, 1];
  return points.map(p => [p[0] * s[1], p[1] * s[0]]);
}

export const LINE_TOOLS: Readonly<Record<string, number>> = Object.freeze({ ctr4: 6, ctr2: 4, parallel: 4, ratio: 4, centreangle: 8 });

const ordered = (p: Point, q: Point): Point[] => p[1] < q[1] - EPS || Math.abs(p[1] - q[1]) <= EPS && p[0] <= q[0] ? [p, q] : [q, p];
function centreLine(a1: Point, a2: Point, b1: Point, b2: Point): Point[] | null {
  if (!(size(sub(a2, a1)) > EPS) && !(size(sub(b2, b1)) > EPS)) return null;
  [a1, a2] = ordered(a1, a2); [b1, b2] = ordered(b1, b2);
  if (size(sub(a1, b2)) + size(sub(a2, b1)) < size(sub(a1, b1)) + size(sub(a2, b2)) - EPS) [b1, b2] = [b2, b1];
  return [mid(a1, b1), mid(a2, b2)];
}
const downward = (u: Point) => u[1] > EPS || Math.abs(u[1]) <= EPS && u[0] > 0 ? u : scale(u, -1);

export function lineValues(tool: string, points: Point[], spacing: number[] | null): (number | null)[] {
  const p = mm(points, spacing);
  switch (tool) {
    case 'ctr4': {
      const [m1, m2, right, left, l1, l2] = p, axis = sub(m2, m1), axisLength = size(axis);
      const away = (q: Point) => axisLength > EPS ? Math.abs(cross(axis, sub(q, m1))) / axisLength : null;
      const mrd = away(right), mld = away(left), id = size(sub(l2, l1));
      return [mrd, mld, id, mrd === null ? null : divide(mrd + (mld as number), id)];
    }
    case 'ctr2': {
      const a = size(sub(p[1], p[0])), b = size(sub(p[3], p[2])), id = Math.max(a, b), cd = Math.min(a, b);
      return [cd, id, divide(cd, id)];
    }
    case 'parallel': {
      const dir = sub(p[1], p[0]), n = size(dir), joint = sub(mid(p[2], p[3]), mid(p[0], p[1]));
      return [n > EPS ? Math.abs(cross(dir, joint)) / n : null, size(joint)];
    }
    case 'ratio': {
      const l1 = size(sub(p[1], p[0])), l2 = size(sub(p[3], p[2]));
      return [l1, l2, divide(l1, l2)];
    }
    case 'centreangle': {
      const a = centreLine(p[0], p[1], p[2], p[3]), b = centreLine(p[4], p[5], p[6], p[7]);
      const u = a && sub(a[1], a[0]), v = b && sub(b[1], b[0]);
      if (!u || !v || !(size(u) > EPS) || !(size(v) > EPS)) return [null, null];
      const x = downward(u), y = downward(v), angle = Math.atan2(Math.abs(cross(x, y)), dot(x, y)) * 180 / Math.PI;
      return [angle, 360 - angle];
    }
    default: throw new Error('unknown line tool');
  }
}
export function lineLength(points: Point[], spacing: number[] | null): number {
  const [a, b] = mm(points, spacing); return size(sub(b, a));
}
// Ellipsoid π/6 × L × H × W, Prolate spheroid π/6 × L × W², lengths in mm, the volume in mL.
export function volumeValue(formula: string, lengths: number[]): number | null {
  if (!lengths.every(n => Number.isFinite(n) && n > 0)) return null;
  if (formula === 'prolate' && lengths.length === 2) return Math.PI / 6 * lengths[0] * lengths[1] * lengths[1] / 1000;
  if (formula === 'ellipsoid' && lengths.length === 3) return Math.PI / 6 * lengths[0] * lengths[1] * lengths[2] / 1000;
  throw new Error('unknown volume formula');
}
// Saved values against values calculated again: nulls in the same places, numbers within a millionth.
export const sameValues = (a: (number | null)[], b: (number | null)[], tolerance = 1e-6) => a.length === b.length &&
  a.every((n, i) => n === null ? b[i] === null : typeof b[i] === 'number' && Math.abs(n - (b[i] as number)) <= Math.max(tolerance, Math.abs(n) * 1e-9));
