import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

const invalid = (message = '표시 저장 입력이 올바르지 않습니다'): never => { throw new BadRequestException(message); };
export const VIEWER_LIMITS = Object.freeze({ items: 512, revisions: 4096, bytes: 16 * 1024 * 1024, snapshot: 8192 });

// JSON.parse has already discarded duplicate object keys. Parse the bounded original
// bytes so two differently interpreted commands cannot share one idempotency key.
export function viewerJson(raw: Buffer): any {
  if (!Buffer.isBuffer(raw) || raw.length > 32768) invalid('표시 저장 본문은32KiB 이하여야 합니다');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); }
  catch { invalid(); }
  let index = 0;
  const whitespace = () => { while (/[\t\r\n ]/.test(text[index] ?? '\0')) index++; };
  const string = () => {
    if (text[index] !== '"') invalid();
    const start = index++;
    while (index < text.length) {
      if (text[index] === '\\') { index += 2; continue; }
      if (text[index++] === '"') {
        let value: string;
        try { value = JSON.parse(text.slice(start, index)); } catch { invalid(); }
        if (/[\u0000\uD800-\uDFFF]/u.test(value)) invalid('저장할 수 없는 Unicode 문자열입니다');
        return value;
      }
    }
    return invalid();
  };
  const value = (depth: number): any => {
    if (depth > 16) invalid();
    whitespace();
    if (text[index] === '"') return string();
    if (text[index] === '{') {
      index++; whitespace();
      const result = Object.create(null), seen = new Set<string>();
      if (text[index] === '}') { index++; return result; }
      while (index < text.length) {
        whitespace(); const key = string();
        if (seen.has(key)) invalid('중복 JSON 필드는 허용하지 않습니다');
        seen.add(key); whitespace(); if (text[index++] !== ':') invalid();
        result[key] = value(depth + 1); whitespace();
        const end = text[index++]; if (end === '}') return result;
        if (end !== ',') invalid();
      }
      return invalid();
    }
    if (text[index] === '[') {
      index++; whitespace(); const result = [];
      if (text[index] === ']') { index++; return result; }
      while (index < text.length) {
        result.push(value(depth + 1)); whitespace();
        const end = text[index++]; if (end === ']') return result;
        if (end !== ',') invalid();
      }
      return invalid();
    }
    for (const [token, parsed] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(token, index)) { index += token.length; return parsed; }
    }
    const number = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number || !Number.isFinite(Number(number[0]))) invalid();
    index += number[0].length; return Number(number[0]);
  };
  const result = value(0); whitespace(); if (index !== text.length) invalid();
  return result;
}

function object(value: any, required: string[], optional: string[] = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function text(value: any, limit: number): string {
  if (typeof value !== 'string' || /[\u0000\uD800-\uDFFF]/u.test(value) || [...value].length > limit) invalid();
  return value;
}
export function viewerUid(value: any): string {
  if (typeof value !== 'string' || value.length > 64 || !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))+$/u.test(value)) invalid('잘못된 DICOM UID입니다');
  return value;
}
export function viewerUuid(value: any): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) invalid('잘못된 항목/요청 ID입니다');
  return value;
}
function positive(value: any): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) invalid();
  return value;
}
export interface ViewerItemInput {
  schemaVersion: 1; kind: 'arrow' | 'key' | 'length' | 'angle' | 'ellipse'; seriesUid: string; sopUid: string; frame: number;
  frameOfReferenceUid?: string; label?: string; points?: number[][]; title?: string; description?: string;
  viewPlaneNormal?: number[]; viewUp?: number[];
  baseline?: { calculator: string; values: number[] };
}
export const isManualMeasurement = (kind: string) => ['length', 'angle', 'ellipse'].includes(kind);
export interface ViewerCommand {
  requestId: string; expectedRevision?: number; action: 'create' | 'edit' | 'hide' | 'restore'; reason: string; item: ViewerItemInput;
}
export function viewerCommand(raw: Buffer, create: boolean): ViewerCommand {
  const body = viewerJson(raw);
  object(body, create ? ['requestId', 'item'] : ['requestId', 'expectedRevision', 'action', 'item'], create ? [] : ['reason']);
  const action = create ? 'create' : body.action;
  if (!['create', 'edit', 'hide', 'restore'].includes(action) || (!create && action === 'create')) invalid();
  const reason = text(body.reason === undefined ? '' : body.reason, 1000);
  if ((action === 'hide' || action === 'restore') ? !reason.trim() : reason !== '') invalid('숨김/복원에는 사유가 필요합니다');
  const item = body.item;
  const common = ['schemaVersion', 'kind', 'seriesUid', 'sopUid', 'frame'];
  if (item?.kind === 'arrow') object(item, [...common, 'frameOfReferenceUid', 'label', 'points']);
  else if (isManualMeasurement(item?.kind)) object(item, [...common, 'frameOfReferenceUid', 'label', 'points', 'viewPlaneNormal', 'viewUp', 'baseline']);
  else if (item?.kind === 'key') object(item, [...common, 'title'], ['description']);
  else invalid();
  if (item.schemaVersion !== 1) invalid();
  const normalized: ViewerItemInput = { schemaVersion: 1, kind: item.kind,
    seriesUid: viewerUid(item.seriesUid), sopUid: viewerUid(item.sopUid), frame: positive(item.frame) };
  if (item.kind !== 'key') {
    const count = item.kind === 'angle' ? 3 : item.kind === 'ellipse' ? 4 : 2;
    if (!Array.isArray(item.points) || item.points.length !== count || item.points.some(point =>
      !Array.isArray(point) || point.length !== 3 || point.some(n => typeof n !== 'number' || !Number.isFinite(n)))) invalid();
    Object.assign(normalized, { frameOfReferenceUid: viewerUid(item.frameOfReferenceUid), label: text(item.label, 1000), points: item.points });
    if (isManualMeasurement(item.kind)) {
      object(item.baseline, ['calculator', 'values']);
      if (item.baseline.calculator !== 'kin-native-manual-v1' || !Array.isArray(item.baseline.values) ||
          item.baseline.values.length !== (item.kind === 'ellipse' ? 5 : 1) ||
          item.baseline.values.some(n => typeof n !== 'number' || !Number.isFinite(n))) invalid('완료된 측정값이 필요합니다');
      normalized.baseline = item.baseline;
      for (const key of ['viewPlaneNormal', 'viewUp']) {
        if (!Array.isArray(item[key]) || item[key].length !== 3 || item[key].some(n => typeof n !== 'number' || !Number.isFinite(n))) invalid();
        normalized[key] = item[key];
      }
    }
  } else Object.assign(normalized, { title: text(item.title, 200), description: text(item.description === undefined ? '' : item.description, 1000) });
  return { requestId: viewerUuid(body.requestId), ...(create ? {} : { expectedRevision: positive(body.expectedRevision) }), action, reason, item: normalized };
}

export function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function viewerFingerprint(studyUid: string, id: string | null, command: ViewerCommand): string {
  const { requestId: _requestId, ...body } = command;
  return createHash('sha256').update(canonical({ studyUid, id, ...body })).digest('hex');
}
export function viewerPage(query: any, revisions = false) {
  object(query, [], revisions ? ['limit', 'cursor'] : ['limit', 'cursor', 'includeHidden']);
  if (query.limit !== undefined && (typeof query.limit !== 'string' || !/^[1-9]\d{0,2}$/.test(query.limit))) invalid();
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (limit > 100) invalid();
  let cursor: string | number | null = null;
  if (query.cursor !== undefined) cursor = revisions
    ? (typeof query.cursor === 'string' && /^[1-9]\d{0,9}$/.test(query.cursor) ? positive(Number(query.cursor)) : invalid()) : viewerUuid(query.cursor);
  if (query.includeHidden !== undefined && !['true', 'false'].includes(query.includeHidden)) invalid();
  return { limit, cursor, includeHidden: query.includeHidden === 'true' };
}

const CT = '1.2.840.10008.5.1.4.1.1.2', US_MULTI = '1.2.840.10008.5.1.4.1.1.3.1';
const SINGLE = new Set([CT, '1.2.840.10008.5.1.4.1.1.4', '1.2.840.10008.5.1.4.1.1.1', '1.2.840.10008.5.1.4.1.1.1.1']);
function metadataInteger(value: any): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[ ]*[+]?\d+[ ]*$/.test(value))) invalid();
  return positive(Number(value));
}
function metadataNumbers(value: any, count: number): number[] {
  const fields = typeof value === 'string' ? value.split('\\') : Array.isArray(value) ? value : [value];
  if (fields.length !== count) invalid('영상 좌표 태그가 불완전합니다');
  return fields.map(field => {
    if (typeof field !== 'number' && (typeof field !== 'string' || !/^[ ]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ ]*$/.test(field))) invalid();
    const n = Number(field); if (!Number.isFinite(n)) invalid(); return n;
  });
}
export function verifyViewerReference(studyUid: string, item: ViewerItemInput, tags: any): void {
  if (!tags || viewerUid(tags.StudyInstanceUID) !== studyUid || viewerUid(tags.SeriesInstanceUID) !== item.seriesUid ||
      viewerUid(tags.SOPInstanceUID) !== item.sopUid) invalid('영상 참조가 일치하지 않습니다');
  const sopClass = viewerUid(tags.SOPClassUID);
  if (!SINGLE.has(sopClass) && sopClass !== US_MULTI) invalid('지원하지 않는 영상 형식입니다');
  let frames = 1;
  if (tags.NumberOfFrames !== undefined) frames = metadataInteger(tags.NumberOfFrames);
  if ((sopClass === US_MULTI && tags.NumberOfFrames === undefined) || (SINGLE.has(sopClass) && frames !== 1) || item.frame > frames) invalid('영상 frame 범위가 올바르지 않습니다');
  if (item.kind === 'key') return;
  if (sopClass !== CT || item.frame !== 1 || viewerUid(tags.FrameOfReferenceUID) !== item.frameOfReferenceUid) invalid('주석 좌표 기준이 일치하지 않습니다');
  const rows = metadataInteger(tags.Rows), columns = metadataInteger(tags.Columns);
  if (rows > 65535 || columns > 65535) invalid();
  const origin = metadataNumbers(tags.ImagePositionPatient, 3), orientation = metadataNumbers(tags.ImageOrientationPatient, 6), spacing = metadataNumbers(tags.PixelSpacing, 2);
  if (spacing.some(x => x <= 0)) invalid();
  const u = orientation.slice(0, 3), v = orientation.slice(3);
  const dot = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i], 0);
  const uu = dot(u, u), vv = dot(v, v), uv = dot(u, v), determinant = uu * vv - uv * uv;
  if (Math.max(Math.abs(uu - 1), Math.abs(vv - 1), Math.abs(uv)) > 1e-4 || determinant <= 0) invalid();
  let normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const norm = Math.sqrt(dot(normal, normal)); normal = normal.map(x => x / norm);
  if (isManualMeasurement(item.kind)) {
    if (tags.Modality !== 'CT' || tags.PixelSpacingCalibrationType !== undefined) invalid('지원하지 않는 측정 보정입니다');
    const pn = item.viewPlaneNormal, up = item.viewUp;
    if (Math.max(Math.abs(dot(pn, pn) - 1), Math.abs(dot(up, up) - 1), Math.abs(dot(pn, up))) > 1e-4 ||
        Math.abs(Math.abs(dot(pn, normal)) - 1) > 1e-4) invalid('측정 평면이 원본 영상과 일치하지 않습니다');
    const delta = (a: number[], b: number[]) => a.map((n, i) => n - b[i]);
    const size = (a: number[]) => Math.sqrt(dot(a, a));
    const p = item.points;
    if (item.kind === 'length' && size(delta(p[1], p[0])) <= 1e-6) invalid('길이의 두 점을 구분하세요');
    if (item.kind === 'angle') {
      const a = delta(p[0], p[1]), b = delta(p[2], p[1]);
      if (size(a) <= 1e-6 || size(b) <= 1e-6 || Math.abs(dot(a, b) / size(a) / size(b)) >= 1 - 1e-12) invalid('완성된 각도를 지정하세요');
    }
    if (item.kind === 'ellipse') {
      const a = delta(p[0], p[1]), b = delta(p[3], p[2]);
      const centers = p[0].map((n, i) => (n + p[1][i] - p[2][i] - p[3][i]) / 2);
      if (size(a) <= 1e-6 || size(b) <= 1e-6 || size(centers) > .001 || Math.abs(dot(a, b) / size(a) / size(b)) > 1e-4)
        invalid('타원 핸들이 완전하지 않습니다');
      // The pinned native ROI inclusion calculator is world-axis aligned.
      // Until oblique inclusion is supported, reject it rather than storing a plausible wrong HU.
      const axis = (a: number[]) => a.filter(n => Math.abs(n) > 1e-6).length === 1;
      if (!axis(normal) || !axis(a) || !axis(b)) invalid('이 방향의 ROI 측정은 아직 지원하지 않습니다');
      const slope = metadataNumbers(tags.RescaleSlope, 1)[0];
      metadataNumbers(tags.RescaleIntercept, 1);
      if (slope === 0 || tags.Modality !== 'CT' || tags.RescaleType !== 'HU' || tags.ModalityLUTSequence !== undefined)
        invalid('HU 보정을 확인할 수 없습니다');
    }
  }
  for (const point of item.points) {
    const delta = point.map((x, i) => x - origin[i]);
    const plane = Math.abs(dot(delta, normal));
    const column = (dot(delta, u) * vv - dot(delta, v) * uv) / determinant / spacing[1];
    const row = (dot(delta, v) * uu - dot(delta, u) * uv) / determinant / spacing[0];
    if (![plane, column, row].every(Number.isFinite) || plane > .001 || column < -.501 || column > columns - .499 || row < -.501 || row > rows - .499) invalid('주석이 원본 영상 평면 또는 범위를 벗어났습니다');
  }
}
