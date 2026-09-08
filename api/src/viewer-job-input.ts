import { BadRequestException } from '@nestjs/common';
import { canonical, viewerJson, viewerUid, viewerUuid, verifyViewerReference } from './viewer-input';
import { createHash } from 'node:crypto';

const invalid = (): never => { throw new BadRequestException('비교 작업의 입력 또는 원본 참조가 올바르지 않습니다'); };
function keys(x: any, names: string[]) {
  if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).length !== names.length || Object.keys(x).some(k => !names.includes(k))) invalid();
}
function number(x: any, min: number, max: number) {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) invalid();
  return x;
}
function text(x: any, max: number) {
  if (typeof x !== 'string' || x.length > max) invalid();
  return x;
}
export function jobCommand(raw: Buffer, create: boolean): any {
  const b = viewerJson(raw);
  keys(b, create ? ['id', 'title', 'description', 'snapshot'] : ['expectedRevision', 'title', 'description', 'hidden', 'reason']);
  text(b.title, 120); if (!b.title.trim()) invalid(); text(b.description, 2000);
  if (!create) {
    number(b.expectedRevision, 1, 1000); if (!Number.isInteger(b.expectedRevision) || typeof b.hidden !== 'boolean') invalid();
    text(b.reason, 1000); return b;
  }
  viewerUuid(b.id);
  const s = b.snapshot;
  keys(s, ['version', 'studies', 'rows', 'cols', 'active', 'cells']);
  if (![1, 2, 3].includes(s.version) || !Array.isArray(s.studies) || ![1, 2].includes(s.studies.length) || new Set(s.studies).size !== s.studies.length) invalid();
  s.studies.forEach(viewerUid);
  if (![1, 2].includes(s.rows) || ![1, 2].includes(s.cols) || !Number.isInteger(s.active) || s.active < 0 || s.active >= s.rows * s.cols ||
      !Array.isArray(s.cells) || s.cells.length !== s.rows * s.cols || s.cells.every(c => !c)) invalid();
  let pixels = 0;
  for (const c of s.cells) {
    if (c === null) continue;
    keys(c, ['study', 'series', 'sop', 'frame', 'camera', 'properties', ...(s.version >= 2 ? ['viewport'] : [])]);
    if (s.version >= 2) {
      keys(c.viewport, ['width', 'height']);
      for (const x of Object.values(c.viewport)) { number(x, 1, 8192); if (!Number.isInteger(x)) invalid(); }
      const area = c.viewport.width * c.viewport.height; pixels += area;
      if (area > 16777216 || pixels > 33554432) invalid();
    }
    if (!s.studies.includes(c.study) || c.frame !== 1) invalid(); viewerUid(c.series); viewerUid(c.sop);
    keys(c.camera, ['focalPoint', 'position', 'viewUp', 'viewPlaneNormal', 'parallelScale', 'rotation', 'flipHorizontal', 'flipVertical']);
    for (const field of ['focalPoint', 'position', 'viewUp', 'viewPlaneNormal']) {
      if (!Array.isArray(c.camera[field]) || c.camera[field].length !== 3) invalid();
      c.camera[field].forEach(n => number(n, -1e7, 1e7));
    }
    number(c.camera.parallelScale, .0001, 1e7); number(c.camera.rotation, -3600, 3600);
    if (typeof c.camera.flipHorizontal !== 'boolean' || typeof c.camera.flipVertical !== 'boolean') invalid();
    const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);
    const { viewUp: u, viewPlaneNormal: n, position: p, focalPoint: f } = c.camera;
    const delta = p.map((v, i) => v - f[i]), distance = Math.sqrt(dot(delta, delta));
    if (Math.max(Math.abs(dot(u, u) - 1), Math.abs(dot(n, n) - 1), Math.abs(dot(u, n))) > 1e-4 || distance < .0001 ||
        Math.abs(dot(delta, n) / distance - 1) > 1e-4) invalid();
    keys(c.properties, ['voiRange', 'VOILUTFunction', 'invert', ...(s.version >= 2 ? ['interpolationType'] : [])]); keys(c.properties.voiRange, ['lower', 'upper']);
    if (s.version >= 2 && ![0, 1, 2].includes(c.properties.interpolationType)) invalid();
    number(c.properties.voiRange.lower, -1e9, 1e9); number(c.properties.voiRange.upper, -1e9, 1e9);
    if (c.properties.voiRange.upper <= c.properties.voiRange.lower || !['LINEAR', 'LINEAR_EXACT', 'SIGMOID'].includes(c.properties.VOILUTFunction) || typeof c.properties.invert !== 'boolean') invalid();
  }
  if (Buffer.byteLength(canonical(s)) > 16000) invalid();
  return b;
}
export function verifyJobCell(c: any, tags: any) {
  verifyViewerReference(c.study, { schemaVersion: 1, kind: 'key', seriesUid: c.series, sopUid: c.sop, frame: c.frame }, tags);
  if (tags.SOPClassUID !== '1.2.840.10008.5.1.4.1.1.2' || tags.Modality !== 'CT') invalid();
  const parse = (x: any) => Array.isArray(x) ? x.map(Number) : typeof x === 'string' ? x.split('\\').map(Number) : [];
  const o = parse(tags.ImageOrientationPatient), origin = parse(tags.ImagePositionPatient);
  if (o.length !== 6 || origin.length !== 3 || [...o, ...origin].some(n => !Number.isFinite(n))) invalid();
  const n = [o[1]*o[5]-o[2]*o[4], o[2]*o[3]-o[0]*o[5], o[0]*o[4]-o[1]*o[3]];
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  if (Math.abs(dot(n, n)-1) > 1e-4 || Math.abs(Math.abs(dot(n, c.camera.viewPlaneNormal))-1) > 1e-4 ||
      Math.abs(dot(n, c.camera.focalPoint.map((v, i) => v-origin[i]))) > .01) invalid();
}
export const jobFingerprint = (b: any) => createHash('sha256').update(canonical(b)).digest('hex');
