import { BadRequestException } from '@nestjs/common';
import { mgGeometry } from './mg-geometry';

export function planarGeometry(tags: any, frame: number) {
  const fail = () => { throw new BadRequestException('원본 프레임의 좌표·간격·보정을 확인할 수 없습니다'); };
  const numbers = (v, n) => {
    const a = typeof v === 'string' ? v.split('\\') : v;
    if (!Array.isArray(a) || a.length !== n || a.some(x => !(typeof x === 'number' || typeof x === 'string' && x.trim()) || !Number.isFinite(Number(x)))) return fail();
    return a.map(Number);
  };
  const frames = Number(tags?.NumberOfFrames ?? 1);
  if (!Number.isSafeInteger(frame) || frame < 1 || !Number.isSafeInteger(frames) || frame > frames) return fail();
  const per = tags.PerFrameFunctionalGroupsSequence, shared = tags.SharedFunctionalGroupsSequence;
  if (per !== undefined && (!Array.isArray(per) || per.length !== frames)) return fail();
  const value = (sequence, key) => per || shared ? (per?.[frame - 1]?.[sequence]?.[0] ?? shared?.[0]?.[sequence]?.[0])?.[key] : tags[key];
  const mg = tags.Modality === 'MG' ? mgGeometry(tags, frame) : null;
  let origin, orientation, spacing, basis;
  if (mg) ({ origin, orientation, spacing, basis } = mg);
  else {
    const pixel = value('PixelMeasuresSequence', 'PixelSpacing');
    spacing = numbers(pixel ?? value('FramePixelDataPropertiesSequence', 'ImagerPixelSpacing'), 2);
    basis = pixel !== undefined ? 'pixel' : 'detector';
    if (basis === 'detector') {
      const factor = value('XRayGeometrySequence', 'EstimatedRadiographicMagnificationFactor');
      if (factor !== undefined) {
        const k = numbers([factor], 1)[0]; if (k <= 0) return fail();
        spacing = spacing.map(x => x / k); basis = 'ermf';
      }
    }
    origin = numbers(value('PlanePositionSequence', 'ImagePositionPatient') ?? [0, 0, 0], 3);
    orientation = numbers(value('PlaneOrientationSequence', 'ImageOrientationPatient') ?? [1, 0, 0, 0, 1, 0], 6);
  }
  if (spacing.some(n => n <= 0)) return fail();
  const rows = Number(tags.Rows), columns = Number(tags.Columns);
  if (![rows, columns].every(n => Number.isSafeInteger(n) && n > 0)) return fail();
  const u = orientation.slice(0, 3), v = orientation.slice(3), dot = (a, b) => a.reduce((s, n, i) => s + n * b[i], 0);
  const uu = dot(u, u), vv = dot(v, v), uv = dot(u, v), det = uu * vv - uv * uv;
  if (uu <= 0 || vv <= 0 || det <= 0 || Math.abs(uv / Math.sqrt(uu * vv)) > 1e-4) return fail();
  const cross = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
  const normal = cross.map(n => n / Math.sqrt(dot(cross, cross)));
  const imagePoint = point => {
    const d = numbers(point, 3).map((n, i) => n - origin[i]);
    const x = (dot(d, u) * vv - dot(d, v) * uv) / det / spacing[1];
    const y = (dot(d, v) * uu - dot(d, u) * uv) / det / spacing[0];
    if (Math.abs(dot(d, normal)) > .001 || x < -.501 || y < -.501 || x > columns - .499 || y > rows - .499) return fail();
    return [x, y];
  };
  const measure = (kind, points) => {
    const p = points.map(point => imagePoint(point).map((n, i) => n * spacing[1 - i]));
    const sub = (a, b) => a.map((n, i) => n - b[i]), size = a => Math.hypot(...a);
    const a = sub(p[0], p[1]); if (size(a) <= 1e-6) return fail();
    if (kind === 'length') return size(a);
    const b = kind === 'angle' ? sub(p[2], p[1]) : sub(p[3], p[2]);
    if (size(b) <= 1e-6) return fail();
    const cosine = dot(a, b) / size(a) / size(b);
    if (kind === 'angle') {
      return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
    }
    if (kind !== 'ellipse' || Math.abs(cosine) > 1e-4 || size(p[0].map((n, i) => (n + p[1][i] - p[2][i] - p[3][i]) / 2)) > .001) return fail();
    return Math.PI * size(a) * size(b) / 4;
  };
  const label = mg?.label || { pixel: 'PixelSpacing · 원본 기준면', detector: 'ImagerPixelSpacing · 검출기 기준', ermf: 'ImagerPixelSpacing / ERMF · 추정 보정' }[basis];
  return { origin, orientation, spacing, normal, imagePoint, measure, label, frameOfReferenceUid: tags.FrameOfReferenceUID || null,
    calculator: 'kin-planar-manual-v1:' + basis };
}
