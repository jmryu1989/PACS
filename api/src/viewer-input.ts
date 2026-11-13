import { planarGeometry, usRegionGeometry } from './planar-geometry';
import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mgGeometry } from './mg-geometry';
import { ORTHO_KINDS, ORTHO_POINTS, ORTHO_VALUES, hasSpacingTags, orthoCalculator, orthoNullable, orthoValues } from './ortho-geometry';
import { LINE_TOOLS, lineLength, lineValues, sameValues, volumeValue } from './measure-lines';

const invalid = (message = '표시 저장 입력이 올바르지 않습니다'): never => { throw new BadRequestException(message); };
export const VIEWER_LIMITS = Object.freeze({ snapshot: 8192 });

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
// Fixed vocabulary only: no report, note, description, arbitrary error or caller identity.
export function viewerContextEvent(raw: Buffer) {
  const body = viewerJson(raw);
  object(body, ['eventId', 'faultId', 'stage', 'occurredAt', 'engine', 'viewport', 'cause', 'repeatCount', 'attempt', 'reason', 'result']);
  viewerUuid(body.eventId); viewerUuid(body.faultId);
  const oneOf = (value: any, values: string[]) => { if (!values.includes(value)) invalid('영상 장애 기록 필드가 올바르지 않습니다'); };
  oneOf(body.stage, ['loss', 'manual-retry', 'refused', 'recovery-result']);
  oneOf(body.engine, ['webgl', 'unknown']);
  oneOf(body.viewport, ['stack', 'orthographic', 'volume3d', 'unknown']);
  oneOf(body.cause, ['context-lost', 'unknown']);
  oneOf(body.reason, ['none', 'session-ended', 'preparing', 'unknown', 'busy', 'save-unknown', 'guard-unavailable', 'dirty', 'account', 'request', 'coverage', 'marker']);
  oneOf(body.result, ['succeeded', 'failed', 'unknown']);
  if (typeof body.occurredAt !== 'string' || body.occurredAt.length !== 24 ||
      !Number.isFinite(Date.parse(body.occurredAt)) || new Date(body.occurredAt).toISOString() !== body.occurredAt) invalid();
  positive(body.repeatCount);
  if (!Number.isSafeInteger(body.attempt) || body.attempt < 0 || body.attempt > 2147483647) invalid();
  return { eventId: body.eventId as string, faultId: body.faultId as string, stage: body.stage as string,
    occurredAt: body.occurredAt as string, engine: body.engine as string, viewport: body.viewport as string,
    cause: body.cause as string, repeatCount: body.repeatCount as number, attempt: body.attempt as number,
    reason: body.reason as string, result: body.result as string };
}
interface ViewerItemInput {
  schemaVersion: 1; kind: 'arrow' | 'key' | 'length' | 'angle' | 'ellipse' | 'text' | 'memo' | 'spine' | 'circle' |
    'limbLength' | 'acetabular' | 'spineBalance' | 'spineCobb' | 'pelvicIncidence' | 'ctr' | 'parallel' | 'ratio' | 'centreAngle' | 'volume';
  seriesUid: string; sopUid: string; frame: number;
  frameOfReferenceUid?: string; label?: string; points?: number[][]; title?: string; description?: string;
  viewPlaneNormal?: number[]; viewUp?: number[];
  baseline?: { calculator: string; values: (number | null)[]; sources?: VolumeSource[] };
}
interface VolumeSource { seriesUid: string; sopUid: string; frame: number; frameOfReferenceUid: string | null; points: number[][]; calculator: string }
export const isManualMeasurement = (kind: string) => ['length', 'angle', 'ellipse'].includes(kind);
// The Measure menu's marks: a text at one point (Text and Marking stamps, Memo with its title, a Spine Label level) and
// a Circle by Diameter. They are not manual measurements: no SR, no source digest; the original is checked when saved.
export const TEXT_MARKS = Object.freeze(['text', 'memo', 'spine']);
// The orthopaedic and spine measurements (Limb Length Discrepancy, Acetabular Angle, Spine Balance, Cobb Angle (Lordosis /
// Kyphosis), Pelvic Incidence): their values are calculated again here from the original's tags (ortho-geometry.ts).
// The line tools: CTR, Parallel Lines, Length Ratio, Centre-line Angle (points on one frame, values recomputed from them) and
// Volume Measure (a result stamp whose two or three lengths were each measured on a frame of the same study).
export const LINE_MARKS = Object.freeze(['ctr', 'parallel', 'ratio', 'centreAngle', 'volume']);
export const MEASURE_MARKS = Object.freeze([...TEXT_MARKS, 'circle', ...ORTHO_KINDS, ...LINE_MARKS]);
export const CIRCLE_BASES = Object.freeze(['pixel', 'detector', 'ermf', 'dbt', 'us']);
// kind → the calculators it may name: kin-<tool>-v1:<basis>, basis 'px' for a pixel-based mark (spacing not known).
const LINE_CALCULATORS: Readonly<Record<string, readonly string[]>> = Object.freeze({ ctr: ['ctr4', 'ctr2'], parallel: ['parallel'], ratio: ['ratio'], centreAngle: ['centreangle'] });
const LINE_VALUES: Readonly<Record<string, number>> = Object.freeze({ ctr4: 4, ctr2: 3, parallel: 2, ratio: 3, centreangle: 2 });
const point3 = (point: any) => Array.isArray(point) && point.length === 3 && point.every(n => typeof n === 'number' && Number.isFinite(n));
// A line mark's or a Volume's saved values; the tool and the basis come from its calculator.
function lineBaseline(kind: string, baseline: any) {
  const bad = (): never => invalid('완료된 측정값이 필요합니다');
  if (kind === 'volume') {
    object(baseline, ['calculator', 'values', 'sources']);
    const formula = typeof baseline.calculator === 'string' && baseline.calculator.match(/^kin-volume-v1:(ellipsoid|prolate)$/)?.[1];
    const parts = formula === 'prolate' ? 2 : 3, v = baseline.values, sources = baseline.sources;
    if (!formula || !Array.isArray(v) || v.length !== parts + 1 || !v.every(n => typeof n === 'number' && Number.isFinite(n) && n > 0) ||
        !Array.isArray(sources) || sources.length !== parts) bad();
    if (Math.abs((volumeValue(formula, v.slice(0, parts)) as number) - v[parts]) > 1e-9 * Math.max(1, v[parts])) invalid('부피가 세 길이의 공식 값과 다릅니다');
    const normalized = sources.map((source: any) => {
      object(source, ['seriesUid', 'sopUid', 'frame', 'frameOfReferenceUid', 'points', 'calculator']);
      const basis = typeof source.calculator === 'string' && source.calculator.match(/^kin-length-v1:(pixel|detector|ermf|dbt|us)$/)?.[1];
      if (!basis || !Array.isArray(source.points) || source.points.length !== 2 || !source.points.every(point3)) bad();
      return { seriesUid: viewerUid(source.seriesUid), sopUid: viewerUid(source.sopUid), frame: positive(source.frame),
        frameOfReferenceUid: source.frameOfReferenceUid === null ? null : viewerUid(source.frameOfReferenceUid), points: source.points, calculator: source.calculator as string };
    });
    return { calculator: baseline.calculator as string, values: v as number[], sources: normalized };
  }
  object(baseline, ['calculator', 'values']);
  const [name, basis, ...rest] = typeof baseline.calculator === 'string' ? baseline.calculator.split(':') : [];
  const tool = name?.match(/^kin-([a-z0-9]+)-v1$/)?.[1];
  if (!tool || rest.length || !LINE_CALCULATORS[kind]?.includes(tool) || ![...CIRCLE_BASES, 'px'].includes(basis) ||
      !Array.isArray(baseline.values) || baseline.values.length !== LINE_VALUES[tool] ||
      !baseline.values.every((n: any) => n === null || typeof n === 'number' && Number.isFinite(n))) bad();
  return { calculator: baseline.calculator as string, values: baseline.values as (number | null)[] };
}
const SPINE_LEVELS = [...Array.from({ length: 8 }, (_, i) => 'C' + (i + 1)), ...Array.from({ length: 12 }, (_, i) => 'T' + (i + 1)),
  ...Array.from({ length: 6 }, (_, i) => 'L' + (i + 1)), 'S1'];
// kin-circle-v1:<spacing basis>:<hu | value>: [diameter mm, area mm²] or, with statistics, [.., mean, SD, min, max, pixel count];
// 'hu' when the statistics are CT values in HU, 'value' for pixel values without a unit (and for a circle without statistics).
function circleBaseline(baseline: any) {
  object(baseline, ['calculator', 'values']);
  const v = baseline.values, finite = (n: any) => typeof n === 'number' && Number.isFinite(n);
  const [name, basis, unit] = typeof baseline.calculator === 'string' ? baseline.calculator.split(':') : [];
  if (name !== 'kin-circle-v1' || !CIRCLE_BASES.includes(basis) || !['hu', 'value'].includes(unit) || baseline.calculator.split(':').length !== 3 ||
      !Array.isArray(v) || ![2, 7].includes(v.length) || !v.every(finite) ||
      !(v[0] > 0 && v[0] <= 1000) || Math.abs(v[1] - Math.PI * v[0] * v[0] / 4) > 1e-6 * Math.max(1, v[1]) || v.length === 2 && unit !== 'value' ||
      v.length === 7 && (!(v[3] >= 0) || !Number.isSafeInteger(v[6]) || v[6] < 1 || v[4] > v[5] ||
        v[2] < v[4] - 1e-9 * Math.max(1, Math.abs(v[4])) || v[2] > v[5] + 1e-9 * Math.max(1, Math.abs(v[5]))))
    invalid('완료된 원 측정값이 필요합니다');
  return { calculator: baseline.calculator as string, values: v as number[] };
}
// kin-<tool>-v1:<spacing basis | px> (the Cobb angle: kin-spinecobb-v1:<back side on the image>:<basis>) and the tool's values;
// only the Cobb angle of two lines at the same height may be null.
function orthoBaseline(kind: string, baseline: any) {
  object(baseline, ['calculator', 'values']);
  const v = baseline.values;
  if (!orthoCalculator(kind, baseline.calculator) || !Array.isArray(v) || v.length !== ORTHO_VALUES[kind] ||
      !v.every((n: any, i: number) => typeof n === 'number' && Number.isFinite(n) || orthoNullable(kind, i) && n === null))
    invalid('완료된 측정값이 필요합니다');
  return { calculator: baseline.calculator as string, values: v as (number | null)[] };
}
interface ViewerCommand {
  requestId: string; expectedRevision?: number; action: 'create' | 'edit' | 'hide' | 'restore'; reason: string; item: ViewerItemInput;
}
export function viewerCommand(raw: Buffer, create: boolean): ViewerCommand {
  const body = viewerJson(raw);
  object(body, create ? ['requestId', 'item'] : ['requestId', 'expectedRevision', 'action', 'item'], create ? [] : ['reason']);
  const action = create ? 'create' : body.action;
  if (!['create', 'edit', 'hide', 'restore'].includes(action) || (!create && action === 'create')) invalid();
  const reason = text(body.reason === undefined ? '' : body.reason, 1000);
  const item = body.item;
  const common = ['schemaVersion', 'kind', 'seriesUid', 'sopUid', 'frame'];
  if (item?.kind === 'arrow') object(item, [...common, 'frameOfReferenceUid', 'label', 'points']);
  else if (isManualMeasurement(item?.kind)) object(item, [...common, 'frameOfReferenceUid', 'label', 'points', 'viewPlaneNormal', 'viewUp', 'baseline']);
  else if (item?.kind === 'key') object(item, [...common, 'title'], ['description']);
  else if (TEXT_MARKS.includes(item?.kind)) object(item, [...common, 'frameOfReferenceUid', 'label', 'points', ...(item.kind === 'memo' ? ['title'] : [])]);
  else if (item?.kind === 'circle' || ORTHO_KINDS.includes(item?.kind) || LINE_MARKS.includes(item?.kind)) object(item, [...common, 'frameOfReferenceUid', 'label', 'points', 'baseline']);
  else invalid();
  if (item.schemaVersion !== 1) invalid();
  const normalized: ViewerItemInput = { schemaVersion: 1, kind: item.kind,
    seriesUid: viewerUid(item.seriesUid), sopUid: viewerUid(item.sopUid), frame: positive(item.frame) };
  if (MEASURE_MARKS.includes(item.kind)) {
    const line = LINE_MARKS.includes(item.kind) ? lineBaseline(item.kind, item.baseline) : null;
    const count = item.kind === 'circle' ? 2 : ORTHO_KINDS.includes(item.kind) ? ORTHO_POINTS[item.kind] :
      line && item.kind !== 'volume' ? LINE_TOOLS[line.calculator.split(':')[0].slice(4, -3)] : 1;
    if (!Array.isArray(item.points) || item.points.length !== count || item.points.some(point =>
      !Array.isArray(point) || point.length !== 3 || point.some(n => typeof n !== 'number' || !Number.isFinite(n)))) invalid();
    Object.assign(normalized, { frameOfReferenceUid: item.frameOfReferenceUid === null ? null : viewerUid(item.frameOfReferenceUid),
      label: text(item.label, 1000), points: item.points });
    if (item.kind === 'memo') {
      normalized.title = text(item.title, 200);
      if (!normalized.title.trim() && !normalized.label.trim()) invalid('메모의 제목이나 글이 필요합니다');
    } else if (item.kind === 'spine') { if (!SPINE_LEVELS.includes(normalized.label)) invalid('척추 레벨 이름이 올바르지 않습니다'); }
    else if (item.kind === 'text' && !normalized.label.trim()) invalid('표식 글이 필요합니다');
    if (item.kind === 'circle') normalized.baseline = circleBaseline(item.baseline);
    if (ORTHO_KINDS.includes(item.kind)) normalized.baseline = orthoBaseline(item.kind, item.baseline);
    if (line) {
      normalized.baseline = line;
      // A Volume's label is its title; the other line marks carry no text of their own.
      if (item.kind === 'volume') text(normalized.label, 200);
    }
    return { requestId: viewerUuid(body.requestId), ...(create ? {} : { expectedRevision: positive(body.expectedRevision) }), action, reason, item: normalized };
  }
  if (item.kind !== 'key') {
    const count = item.kind === 'angle' ? 3 : item.kind === 'ellipse' ? 4 : 2;
    if (!Array.isArray(item.points) || item.points.length !== count || item.points.some(point =>
      !Array.isArray(point) || point.length !== 3 || point.some(n => typeof n !== 'number' || !Number.isFinite(n)))) invalid();
    Object.assign(normalized, { frameOfReferenceUid: isManualMeasurement(item.kind) && item.frameOfReferenceUid === null ? null : viewerUid(item.frameOfReferenceUid), label: text(item.label, 1000), points: item.points });
    if (isManualMeasurement(item.kind)) {
      object(item.baseline, ['calculator', 'values']);
      if (!(item.baseline.calculator === 'kin-native-manual-v1' || ['dbt', 'pixel', 'ermf', 'detector'].some(b => item.baseline.calculator === 'kin-planar-manual-v1:' + b) || item.kind === 'length' &&
          ['dbt', 'pixel', 'ermf', 'detector'].some(b => item.baseline.calculator === 'kin-mg-length-v1:' + b)) || !Array.isArray(item.baseline.values) ||
          item.baseline.values.length !== (item.kind === 'ellipse' && item.baseline.calculator === 'kin-native-manual-v1' ? 5 : 1) ||
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
  object(query, [], revisions ? ['limit', 'cursor'] : ['limit', 'cursor', 'includeHidden', 'recheck']);
  if (query.limit !== undefined && (typeof query.limit !== 'string' || !/^[1-9]\d{0,2}$/.test(query.limit))) invalid();
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (limit > 100) invalid();
  let cursor: string | number | null = null;
  if (query.cursor !== undefined) cursor = revisions
    ? (typeof query.cursor === 'string' && /^[1-9]\d{0,9}$/.test(query.cursor) ? positive(Number(query.cursor)) : invalid()) : viewerUuid(query.cursor);
  if (query.includeHidden !== undefined && !['true', 'false'].includes(query.includeHidden)) invalid();
  const recheck = query.recheck === undefined ? null : viewerUuid(query.recheck);
  if (recheck && cursor !== null) invalid();
  return { limit, cursor, includeHidden: query.includeHidden === 'true', recheck };
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
// sourceTags: a Volume's other frames (the tags of each length's original, by SOP Instance UID). Every caller that verifies a
// Volume passes it; a Volume whose lengths' originals cannot be read is refused.
export function verifyViewerReference(studyUid: string, item: ViewerItemInput, tags: any, sourceTags?: (sopUid: string) => any): void {
  if (!tags || viewerUid(tags.StudyInstanceUID) !== studyUid || viewerUid(tags.SeriesInstanceUID) !== item.seriesUid ||
      viewerUid(tags.SOPInstanceUID) !== item.sopUid) invalid('영상 참조가 일치하지 않습니다');
  if (item.kind === 'volume') {
    verifyMeasureMark(item, tags);
    item.baseline.sources.forEach((source, i) => {
      const own = source.sopUid === item.sopUid ? tags : sourceTags?.(source.sopUid);
      if (!own) invalid('부피 길이의 원본 영상을 확인할 수 없습니다');
      if (viewerUid(own.StudyInstanceUID) !== studyUid || viewerUid(own.SeriesInstanceUID) !== source.seriesUid || viewerUid(own.SOPInstanceUID) !== source.sopUid)
        invalid('부피 길이의 원본 참조가 일치하지 않습니다');
      const { spacing, image } = lineFrame(own, source.frame, source.frameOfReferenceUid, source.points, source.calculator.split(':')[1]);
      if (Math.abs(lineLength(image, spacing) - (item.baseline.values[i] as number)) > .001) invalid('원본으로 계산한 부피 길이와 저장값이 일치하지 않습니다');
    });
    return;
  }
  if (MEASURE_MARKS.includes(item.kind)) return verifyMeasureMark(item, tags);
  const sopClass = viewerUid(tags.SOPClassUID);
  if (isManualMeasurement(item.kind) && item.baseline?.calculator?.startsWith('kin-planar-manual-v1:')) {
    const geometry = planarGeometry(tags, item.frame), pn = item.viewPlaneNormal, up = item.viewUp;
    if (geometry.frameOfReferenceUid !== item.frameOfReferenceUid || geometry.calculator !== item.baseline.calculator)
      invalid('측정 원본과 보정 기준이 일치하지 않습니다');
    const dot = (a: number[], b: number[]) => a.reduce((s, n, i) => s + n * b[i], 0);
    const size = (a: number[]) => Math.sqrt(dot(a, a));
    if (!pn || !up || size(pn) <= 0 || size(up) <= 0 || Math.abs(dot(pn, up) / size(pn) / size(up)) > 1e-4 ||
        Math.abs(Math.abs(dot(pn, geometry.normal) / size(pn)) - 1) > 1e-4) invalid('측정 평면이 원본 영상과 일치하지 않습니다');
    const value = geometry.measure(item.kind, item.points);
    if (Math.abs(value - item.baseline.values[0]) > (item.kind === 'ellipse' ? .01 : .001)) invalid('원본으로 계산한 측정값과 저장값이 일치하지 않습니다');
    return;
  }
  const mg = item.kind === 'length' && mgGeometry(tags, item.frame);
  if (mg) {
    if (mg.frameOfReferenceUid !== item.frameOfReferenceUid || item.baseline?.calculator !== mg.calculator)
      invalid('MG 측정 원본과 보정 기준이 일치하지 않습니다');
    const dot = (a: number[], b: number[]) => a.reduce((sum, n, i) => sum + n * b[i], 0);
    const pn = item.viewPlaneNormal, up = item.viewUp;
    const pnSize = pn && Math.sqrt(dot(pn, pn)), upSize = up && Math.sqrt(dot(up, up));
    // The pinned camera preserves rounded MG direction cosines in viewUp. Compare
    // directions after normalization; coordinates still undergo the source-plane check.
    if (!(pnSize > 0) || !(upSize > 0) || Math.abs(dot(pn, up) / pnSize / upSize) > 1e-4 ||
        Math.abs(Math.abs(dot(pn, mg.normal) / pnSize)-1) > 1e-4) invalid('측정 평면이 원본 영상과 일치하지 않습니다');
    const length = mg.length(item.points);
    if (length <= 1e-6 || !Number.isFinite(length) || !item.baseline?.values || Math.abs(length - item.baseline.values[0]) > .001)
      invalid('MG 원본으로 계산한 길이와 저장값이 일치하지 않습니다');
    return;
  }
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
    if (tags.Modality !== 'CT' || tags.PixelSpacingCalibrationType !== undefined || item.baseline?.calculator?.startsWith('kin-mg-length-v1:')) invalid('지원하지 않는 측정 보정입니다');
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

// A Measure menu mark on its original frame, in the coordinates the viewer shows that frame in. A frame with plane
// geometry (ImageOrientationPatient or functional groups, and a spacing) must hold every point: a point off it is refused.
// A frame without orientation is shown from its position (or the origin) with rows along +y and columns along −z (the pinned
// viewer's default, as mg-length.js), in its spacing or, without one, in pixels; its points must lie on that plane.
// A circle is checked against the spacing its calculator names: its diameter is recomputed from the original's tags; its
// statistics come from the pixels in the browser and are stored as they were calculated.
function measureFrame(tags: any, frame: number, frameOfReferenceUid: string | null | undefined) {
  let frames = 1;
  if (tags.NumberOfFrames !== undefined) frames = metadataInteger(tags.NumberOfFrames);
  if (frame > frames) invalid('영상 frame 범위가 올바르지 않습니다');
  const reference = tags.FrameOfReferenceUID === undefined || tags.FrameOfReferenceUID === null || tags.FrameOfReferenceUID === '' ? null : viewerUid(tags.FrameOfReferenceUID);
  if (frameOfReferenceUid !== reference) invalid('주석 좌표 기준이 일치하지 않습니다');
  const rows = metadataInteger(tags.Rows), columns = metadataInteger(tags.Columns);
  let planar: ReturnType<typeof planarGeometry> | null = null;
  try { planar = planarGeometry(tags, frame); } catch { planar = null; }
  const oriented = tags.ImageOrientationPatient !== undefined || tags.SharedFunctionalGroupsSequence !== undefined || tags.PerFrameFunctionalGroupsSequence !== undefined;
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
  // The image pixel coordinates of the points, under the first of the spacings that holds them all on the frame.
  const shown = (points: number[][], spacings: number[][]): number[][] => {
    if (oriented && planar) return points.map(point => planar.imagePoint(point));
    if (tags.SharedFunctionalGroupsSequence !== undefined || tags.PerFrameFunctionalGroupsSequence !== undefined) return invalid('측정 원본의 좌표를 확인할 수 없습니다');
    const origin = tags.ImagePositionPatient === undefined ? [0, 0, 0] : metadataNumbers(tags.ImagePositionPatient, 3);
    const orientation = tags.ImageOrientationPatient === undefined ? [0, 1, 0, 0, 0, -1] : metadataNumbers(tags.ImageOrientationPatient, 6);
    const u = orientation.slice(0, 3), v = orientation.slice(3), cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const size = Math.sqrt(dot(cross, cross)); if (!(size > 0)) invalid();
    const n = cross.map(x => x / size);
    for (const spacing of spacings) {
      const mapped = points.map(point => { const d = point.map((x, i) => x - origin[i]); return [dot(d, u) / spacing[1], dot(d, v) / spacing[0], dot(d, n)]; });
      if (mapped.every(([x, y, z]) => Math.abs(z) <= .001 && x >= -.501 && y >= -.501 && x <= columns - .499 && y <= rows - .499)) return mapped.map(([x, y]) => [x, y]);
    }
    return invalid('주석이 원본 영상 평면 또는 범위를 벗어났습니다');
  };
  return { planar, shown };
}
// The image pixel coordinates of a line tool's points on its frame and the spacing its calculator's basis names (null for
// a pixel-based mark): the planar spacing of that basis, or the one ultrasound region that holds every point.
function lineFrame(tags: any, frame: number, frameOfReferenceUid: string | null | undefined, points: number[][], basis: string) {
  const { planar, shown } = measureFrame(tags, frame, frameOfReferenceUid);
  if (basis === 'px') return { spacing: null, image: shown(points, planar ? [planar.spacing, [1, 1]] : [[1, 1]]) };
  if (basis === 'us') {
    const us = usRegionGeometry(tags);
    if (!us) invalid('초음파 보정 영역을 확인할 수 없습니다');
    const image = shown(points, planar ? [planar.spacing] : [[1, 1]]), region = us.region(image);
    if (!region) invalid('초음파 보정 영역 안에서만 mm로 잴 수 있습니다');
    return { spacing: region.spacing as number[], image };
  }
  if (!planar || planar.calculator !== 'kin-planar-manual-v1:' + basis) invalid('측정 원본과 보정 기준이 일치하지 않습니다');
  return { spacing: planar.spacing as number[], image: shown(points, [planar.spacing]) };
}
function verifyMeasureMark(item: ViewerItemInput, tags: any): void {
  const { planar, shown } = measureFrame(tags, item.frame, item.frameOfReferenceUid);
  if (LINE_MARKS.includes(item.kind) && item.kind !== 'volume') {
    const [name, basis] = item.baseline.calculator.split(':');
    const { spacing, image } = lineFrame(tags, item.frame, item.frameOfReferenceUid, item.points, basis);
    if (!sameValues(lineValues(name.slice(4, -3), image, spacing), item.baseline.values, 1e-4)) invalid('원본으로 계산한 측정값과 저장값이 일치하지 않습니다');
    return;
  }
  // An orthopaedic measurement: its points in the spacing its calculator names (or in pixels where the original has no
  // spacing at all), its values calculated again from them.
  if (ORTHO_KINDS.includes(item.kind)) {
    const { basis, backSide } = orthoCalculator(item.kind, item.baseline.calculator);
    let spacing: number[] | null = null, pixels: number[][];
    if (basis === 'px') {
      // Pixels only where the original has no spacing at all: tags that are there but do not hold are no way into pixels.
      if (planar || hasSpacingTags(tags)) invalid('간격 태그가 있는 영상은 픽셀로 재지 않습니다');
      pixels = shown(item.points, [[1, 1]]);
    } else {
      if (!planar || planar.calculator !== 'kin-planar-manual-v1:' + basis) invalid('측정 원본과 보정 기준이 일치하지 않습니다');
      spacing = planar.spacing; pixels = shown(item.points, [planar.spacing]);
    }
    let values: (number | null)[];
    try { values = orthoValues(item.kind, pixels, spacing, backSide); } catch (error) { return invalid(error.message); }
    if (values.some((n, i) => {
      const stored = item.baseline.values[i];
      return n === null || stored === null ? n !== stored : Math.abs(n - stored) > .001;
    })) invalid('원본으로 계산한 측정값과 저장값이 일치하지 않습니다');
    return;
  }
  if (item.kind !== 'circle') { shown(item.points, planar ? [planar.spacing, [1, 1]] : [[1, 1]]); return; }
  const basis = item.baseline.calculator.split(':')[1];
  let spacing: number[], center: number[], edge: number[];
  if (basis === 'us') {
    const us = usRegionGeometry(tags);
    if (!us) invalid('초음파 보정 영역을 확인할 수 없습니다');
    [center, edge] = shown(item.points, planar ? [planar.spacing] : [[1, 1]]);
    const rx = Math.hypot(edge[0] - center[0], edge[1] - center[1]), first = us.region([center]);
    if (!first) invalid('초음파 보정 영역 안에서만 mm로 잴 수 있습니다');
    const ry = rx * first.spacing[1] / first.spacing[0];
    if (us.region([center, [center[0] - rx, center[1]], [center[0] + rx, center[1]], [center[0], center[1] - ry], [center[0], center[1] + ry]]) !== first)
      invalid('원이 초음파 보정 영역을 벗어났습니다');
    spacing = first.spacing;
  } else {
    if (!planar || planar.calculator !== 'kin-planar-manual-v1:' + basis) invalid('측정 원본과 보정 기준이 일치하지 않습니다');
    spacing = planar.spacing; [center, edge] = shown(item.points, [planar.spacing]);
  }
  const diameter = 2 * Math.hypot((edge[0] - center[0]) * spacing[1], (edge[1] - center[1]) * spacing[0]);
  if (!Number.isFinite(diameter) || Math.abs(diameter - item.baseline.values[0]) > .001) invalid('원본으로 계산한 지름과 저장값이 일치하지 않습니다');
}