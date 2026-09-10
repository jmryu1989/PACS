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
  validateJobSnapshot(s);
  return b;
}
export function previewCommand(raw: Buffer): any {
  const b = viewerJson(raw);
  keys(b, ['snapshot']);
  validateJobSnapshot(b.snapshot);
  if (b.snapshot.version !== 2) invalid();
  return b.snapshot;
}
function validateJobSnapshot(s: any) {
  keys(s, ['version', 'studies', 'rows', 'cols', 'active', 'cells', ...([4,5].includes(s?.version) ? ['volume'] : []), ...(s?.version===5?['batch']:[])]);
  if (![1, 2, 3, 4, 5].includes(s.version) || !Array.isArray(s.studies) || ![1, 2].includes(s.studies.length) || new Set(s.studies).size !== s.studies.length) invalid();
  s.studies.forEach(viewerUid);
  const volume = [4,5].includes(s.version);
  if(s.version===5){
    keys(s.batch,['cell','offset','interval','count','reverse']);
    number(s.batch.offset,-1e7,1e7);number(s.batch.interval,.1,1000);number(s.batch.count,2,128);
    if(!Number.isInteger(s.batch.count)||typeof s.batch.reverse!=='boolean')invalid();
  }
  if (volume) {
    keys(s.volume, ['study', 'series', 'sops']);
    if (!s.studies.includes(s.volume.study)) invalid(); viewerUid(s.volume.series);
    if (!Array.isArray(s.volume.sops) || s.volume.sops.length < 2 || s.volume.sops.length > 256 || new Set(s.volume.sops).size !== s.volume.sops.length) invalid();
    s.volume.sops.forEach(viewerUid);
  }
  if ((volume ? !(s.rows === 1 && s.cols === 3 || s.rows === 3 && s.cols === 1) : ![1, 2].includes(s.rows) || ![1, 2].includes(s.cols)) || !Number.isInteger(s.active) || s.active < 0 || s.active >= s.rows * s.cols ||
      !Array.isArray(s.cells) || s.cells.length !== s.rows * s.cols || s.cells.every(c => !c)) invalid();
  let pixels = 0;
  for (const c of [...s.cells,...(s.version===5?[s.batch.cell]:[])]) {
    if (c === null) { if (volume) invalid(); continue; }
    keys(c, ['study', 'series', ...(volume ? ['projection'] : ['sop', 'frame']), 'camera', 'properties', ...(s.version >= 2 ? ['viewport'] : [])]);
    if (s.version >= 2) {
      keys(c.viewport, ['width', 'height']);
      for (const x of Object.values(c.viewport)) { number(x, 1, 8192); if (!Number.isInteger(x)) invalid(); }
      const area = c.viewport.width * c.viewport.height; if(c!==s.batch?.cell)pixels += area;
      if (area > 16777216 || pixels > 33554432) invalid();
      if(c===s.batch?.cell){
        const scale=512/Math.max(c.viewport.width,c.viewport.height);
        if(Math.max(1,Math.floor(c.viewport.width*scale))*Math.max(1,Math.floor(c.viewport.height*scale))*s.batch.count*4>64*1024*1024)invalid();
      }
    }
    if (!s.studies.includes(c.study)) invalid(); viewerUid(c.series);
    if (volume) {
      if (c.study !== s.volume.study || c.series !== s.volume.series) invalid();
      keys(c.projection, ['blend', 'thickness']);
      if (![0, 1, 2, 3].includes(c.projection.blend)) invalid();
      number(c.projection.thickness, .1, 1000);
      if (c.projection.blend === 0 && c.projection.thickness > .2) invalid();
    } else { if (c.frame !== 1) invalid(); viewerUid(c.sop); }
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
    if(c===s.batch?.cell&&Math.max(Math.abs(dot(u,u)-1),Math.abs(dot(n,n)-1),Math.abs(dot(u,n)))>1e-6)invalid();
    keys(c.properties, ['voiRange', 'VOILUTFunction', 'invert', ...(s.version >= 2 ? ['interpolationType'] : [])]); keys(c.properties.voiRange, ['lower', 'upper']);
    if (s.version >= 2 && ![0, 1, 2].includes(c.properties.interpolationType)) invalid();
    number(c.properties.voiRange.lower, -1e9, 1e9); number(c.properties.voiRange.upper, -1e9, 1e9);
    if (c.properties.voiRange.upper <= c.properties.voiRange.lower || !['LINEAR', 'LINEAR_EXACT', 'SIGMOID'].includes(c.properties.VOILUTFunction) || typeof c.properties.invert !== 'boolean') invalid();
  }
  if (Buffer.byteLength(canonical(s)) > (volume ? 28000 : 16000)) invalid();
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
