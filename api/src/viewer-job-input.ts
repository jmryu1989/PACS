import { BadRequestException } from '@nestjs/common';
import { canonical, viewerJson, viewerUid, viewerUuid, verifyViewerReference } from './viewer-input';
import { validateVolumeMarks } from './viewer-volume-marks';
import { validateVolumeCurved } from './viewer-volume-curved';
import { validateVolumePath } from './viewer-volume-path';
import { validateVolumeMip } from './viewer-volume-mip';
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
  if (![2,4,6].includes(b.snapshot.version) || b.snapshot.version===6&&b.snapshot.batch!==null) invalid();
  return b.snapshot;
}
// Version 7 is the Hanging Protocol plane layout: the same single fully loaded CT volume,
// but on 1x1/1x2/2x2 as well as 1x3/3x1, with null vacancies and an explicit per-cell
// orientation. Versions 4-6 keep their exact three-plane shape and their batch/marks rules.
// Version 8 is the mixed Hanging Protocol layout: plane cells of that one volume beside
// ordinary stack frame cells on the HP grids only. A v8 cell never has its shape inferred
// from the snapshot version; every non-null cell names its own kind.
// Version 9 is the merged cell layout: the base grid stays, but the cells sit in the
// fractional rectangles the viewer's own cell merge module dispatches. Geometry lives in
// `rects`, not on the cell, because a row or column merge can leave an empty survivor and a
// vacancy still occupies a rectangle. A v9 cell names its own kind, as a v8 cell does.
const VOLUME_LAYOUTS: [number, number][] = [[1,1],[1,2],[2,2],[1,3],[3,1]];
const MIXED_LAYOUTS: [number, number][] = [[1,1],[1,2],[2,2]];
// The base grids and the rectangle sets viewer-cell-merge.js:10,19-32 actually produces:
// one maximize, reachable from every base, and four 2x2 row/column shapes. Nothing outside
// this table is a shape the viewer can create, so nothing outside it is accepted — that is
// what refuses overlapping, gapped, out-of-bounds, nested and freeform geometry at once.
const MERGE_BASES: [number, number][] = [[1,2],[2,1],[2,2],[1,3],[3,1]];
const MERGE_SHAPES: number[][][] = [
  [[0,0,1,1]],
  [[0,0,.5,1],[.5,0,.5,.5],[.5,.5,.5,.5]],
  [[0,0,.5,.5],[.5,0,.5,1],[0,.5,.5,.5]],
  [[0,0,1,.5],[0,.5,.5,.5],[.5,.5,.5,.5]],
  [[0,0,.5,.5],[.5,0,.5,.5],[0,.5,1,.5]],
];
const PLANE_ORIENTATIONS = ['axial', 'sagittal', 'coronal'];
const CELL_KINDS = ['plane', 'stack'];
function validateJobSnapshot(s: any) {
  keys(s, ['version', 'studies', 'rows', 'cols', 'active', 'cells', ...([4,5,6,7,8,9,10,11,12].includes(s?.version) ? ['volume'] : []), ...(s?.version===9?['rects']:[]), ...(s?.version===5?['batch']:s?.version===6?['batch','marks']:s?.version===10?['curved']:s?.version===11?['path']:s?.version===12?['mip']:[])]);
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].includes(s.version) || !Array.isArray(s.studies) || ![1, 2].includes(s.studies.length) || new Set(s.studies).size !== s.studies.length) invalid();
  s.studies.forEach(viewerUid);
  const planes = s.version === 7, mixed = s.version === 8, merged = s.version === 9;
  // A merged layout of ordinary frame cells alone has no volume to reference, so its
  // `volume` is null and it is not a volume snapshot; one holding a plane cell is.
  // Version 10 is the exact version 4 three-plane snapshot plus one manual curved MPR; it
  // carries neither a batch nor 3D marks, so neither can be dropped beside a curve.
  // Version 11 is the same exact version 4 three-plane snapshot plus one manual 3D path, with
  // neither a batch, 3D marks nor a curve beside it.
  // Version 12 is the same exact version 4 three-plane snapshot plus one confirmed MIP Viewer display (kin-mip-1),
  // with neither a batch, 3D marks, a curve nor a path beside it; its display is the active cell's own W/L.
  const volume = [4,5,6,7,8,10,11,12].includes(s.version) || merged && s.volume !== null;
  if(s.version===6){validateVolumeMarks(s.marks);if(s.batch!==null&&!s.batch)invalid();}
  if(s.version===10)validateVolumeCurved(s.curved);
  if(s.version===11)validateVolumePath(s.path);
  if(s.version===12)validateVolumeMip(s.mip);
  const batch=s.version===5||s.version===6&&s.batch!==null;
  if(batch){
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
  const grid = mixed ? MIXED_LAYOUTS : VOLUME_LAYOUTS;
  if (merged) {
    // Geometry is decided before a single cell is read, so an unsupported shape can never
    // reach the source checks or the database.
    if (!MERGE_BASES.some(([r, c]) => s.rows === r && s.cols === c) || !Array.isArray(s.rects)) invalid();
    for (const r of s.rects) { keys(r, ['x', 'y', 'width', 'height']); for (const v of Object.values(r)) number(v, 0, 1); }
    // Only the maximize shape is reachable from every base; the row and column shapes exist
    // on 2x2 alone, exactly as the viewer builds them.
    if (!MERGE_SHAPES.some((shape, i) => (i === 0 || s.rows === 2 && s.cols === 2) && shape.length === s.rects.length &&
        shape.every(([x, y, w, h], n) => Math.abs(s.rects[n].x - x) < 1e-9 && Math.abs(s.rects[n].y - y) < 1e-9 &&
          Math.abs(s.rects[n].width - w) < 1e-9 && Math.abs(s.rects[n].height - h) < 1e-9))) invalid();
    // A merged cell list covers the rectangles, not the base grid: the cells the merge
    // absorbed are gone from the screen and are not saved as anything.
    if (!Array.isArray(s.cells) || s.cells.length !== s.rects.length || s.cells.every(c => !c) ||
        !Number.isInteger(s.active) || s.active < 0 || s.active >= s.cells.length) invalid();
    // The volume reference and the presence of a plane cell are one fact, asserted in both
    // directions: no volume may be carried without a plane, and no plane without its volume.
    if ((s.volume !== null) !== s.cells.some(c => c?.kind === 'plane')) invalid();
  } else if ((volume ? !(planes || mixed ? grid.some(([r, c]) => s.rows === r && s.cols === c) : s.rows === 1 && s.cols === 3 || s.rows === 3 && s.cols === 1)
              : ![1, 2].includes(s.rows) || ![1, 2].includes(s.cols)) || !Number.isInteger(s.active) || s.active < 0 || s.active >= s.rows * s.cols ||
      !Array.isArray(s.cells) || s.cells.length !== s.rows * s.cols || s.cells.every(c => !c)) invalid();
  // A mixed layout is only a mixed layout: an all-plane grid stays version 7 and an
  // all-stack grid stays version 2, so version 8 can never shadow an existing shape.
  if (mixed && !(s.cells.some(c => c?.kind === 'plane') && s.cells.some(c => c?.kind === 'stack'))) invalid();
  let pixels = 0;
  for (const c of [...s.cells,...(batch?[s.batch.cell]:[])]) {
    if (c === null) { if (volume && !planes && !mixed && !merged) invalid(); continue; }
    // Outside a mixed or merged layout the snapshot version names the one cell shape; inside
    // one, every non-null cell carries its own discriminator and is validated by that alone.
    const named = mixed || merged;
    if (named && !CELL_KINDS.includes(c.kind)) invalid();
    const oriented = planes || named && c.kind === 'plane', plane = named ? c.kind === 'plane' : volume;
    keys(c, [...(named ? ['kind'] : []), 'study', 'series', ...(oriented ? ['orientation'] : []), ...(plane ? ['projection'] : ['sop', 'frame']), 'camera', 'properties', ...(s.version >= 2 ? ['viewport'] : [])]);
    if (oriented && !PLANE_ORIENTATIONS.includes(c.orientation)) invalid();
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
    if (plane) {
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
  // The MIP Viewer opens on the active cell and takes its W/L and interpolation from it, so a display that is not that
  // cell's own (another cell, a later W/L change) is not the display this snapshot can put back.
  if (s.version === 12) {
    const p = s.cells[s.active].properties, d = s.mip.display;
    if (d.voiRange.lower !== p.voiRange.lower || d.voiRange.upper !== p.voiRange.upper || d.interpolationType !== p.interpolationType) invalid();
  }
  if (Buffer.byteLength(canonical(s)) > (volume || merged ? 28000 : 16000)) invalid();
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
