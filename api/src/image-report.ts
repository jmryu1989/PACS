/*
 * Image Report: drawings on a breast or thyroid diagram or on a saved key image, attached to the report.
 *
 * Pure rules shared by the draft write (attach / remove), the commit (which drawings a version holds) and the reads.
 * A drawing row is immutable content. Which drawings a report holds is an id list:
 *  - a version: `ReportVersion.drawings` = `[{ id, background, source, sha256 }]`, fixed when written;
 *  - the author's draft: `ReportDraft.drawings` = `{ seed, ids }` once the draft attached or removed a drawing. `seed` is
 *    the head version's ids when the draft first did; `ids` what the draft means the report to hold.
 * The next version holds `ids` (a seeded id only while the head still holds it) and then every head drawing the draft
 * never saw (not in `seed`). So a removal is explicit, and a drawing the author did not see is never dropped or revived.
 */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

export const DRAWING_LIMITS = Object.freeze({
  perReport: 3, strokes: 500, points: 2000, text: 80, strokesBytes: 262144, pngBytes: 1200000, width: 1200, height: 900,
});
export const DRAWING_BACKGROUNDS = Object.freeze(['breast', 'thyroid', 'image'] as const);
export const DRAWING_TOOLS = Object.freeze(['pen', 'line', 'ellipse', 'text'] as const);
export const DRAWING_COLORS = Object.freeze(['#000000', '#e0242b', '#1565c0', '#2e7d32', '#f9a825'] as const);
export type DrawingBackground = typeof DRAWING_BACKGROUNDS[number];

export class DrawingInputError extends Error {}
const bad = (field: string): never => { throw new DrawingInputError(`그림 자료의 모양이 올바르지 않습니다: ${field}`); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const unit = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const round = (v: number) => Math.round(v * 1e5) / 1e5;

export interface DrawingStroke { tool: string; color: string; points: number[][]; text?: string }
export interface DrawingRequest {
  background: DrawingBackground;
  source: { keyImageId: string; keyImageRevision: number; frame: number } | null;
  strokes: DrawingStroke[];
  png: Buffer; width: number; height: number;
  replaces: string | null;
}

/** One stroke: coordinates are 0..1 of the background, so the same marks fit any drawn size. */
export function drawingStrokes(value: unknown): DrawingStroke[] {
  if (!Array.isArray(value) || value.length > DRAWING_LIMITS.strokes) bad('strokes');
  const strokes = (value as unknown[]).map((raw, i) => {
    if (!plain(raw)) return bad(`strokes[${i}]`);
    const tool = raw.tool, color = raw.color, points = raw.points;
    if (!DRAWING_TOOLS.includes(tool as any)) bad(`strokes[${i}].tool`);
    if (!DRAWING_COLORS.includes(color as any)) bad(`strokes[${i}].color`);
    const want = tool === 'pen' ? [1, DRAWING_LIMITS.points] : tool === 'text' ? [1, 1] : [2, 2];
    if (!Array.isArray(points) || points.length < want[0] || points.length > want[1]) bad(`strokes[${i}].points`);
    const pts = (points as unknown[]).map(p => {
      if (!Array.isArray(p) || p.length !== 2 || !unit(p[0]) || !unit(p[1])) bad(`strokes[${i}].points`);
      return [round((p as number[])[0]), round((p as number[])[1])];
    });
    const stroke: DrawingStroke = { tool: tool as string, color: color as string, points: pts };
    if (tool === 'text') {
      const text = raw.text;
      if (typeof text !== 'string' || !text.trim() || [...text].length > DRAWING_LIMITS.text || /[\u0000-\u001f\u007f]/.test(text))
        bad(`strokes[${i}].text`);
      stroke.text = text as string;
    } else if (raw.text !== undefined) bad(`strokes[${i}].text`);
    return stroke;
  });
  if (Buffer.byteLength(JSON.stringify(strokes), 'utf8') > DRAWING_LIMITS.strokesBytes) bad('strokes');
  return strokes;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  return table;
})();
const crc32 = (bytes: Buffer) => { let c = -1; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
// Samples per pixel of the non-palette 8-bit colour types a canvas or an editor writes (grey, RGB, grey+alpha, RGBA).
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * A PNG the screen drew, checked as a picture and not by its first bytes only: every chunk whole with its CRC, IHDR first
 * (8-bit grey, RGB, grey+alpha or RGBA, not interlaced) within the size limits, the IDAT data inflating to exactly one
 * filter byte and one row per line, and IEND last. A truncated or altered file is refused before anything is stored.
 */
export function drawingPng(value: unknown): { png: Buffer; width: number; height: number } {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return bad('png');
  const png = Buffer.from(value as string, 'base64');
  if (png.length < 45 || png.length > DRAWING_LIMITS.pngBytes || png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(4) !== 0x0d0a1a0a)
    return bad('png');
  let at = 8, width = 0, height = 0, channels = 0, ended = false;
  const data: Buffer[] = [];
  while (at < png.length) {
    if (ended || at + 12 > png.length) return bad('png');
    const length = png.readUInt32BE(at), type = png.toString('latin1', at + 4, at + 8);
    if (at + 12 + length > png.length || crc32(png.subarray(at + 4, at + 8 + length)) !== png.readUInt32BE(at + 8 + length)) return bad('png');
    const body = png.subarray(at + 8, at + 8 + length);
    if (at === 8) {
      if (type !== 'IHDR' || length !== 13) return bad('png');
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); channels = CHANNELS[body[9]] ?? 0;
      if (width < 1 || height < 1 || width > DRAWING_LIMITS.width || height > DRAWING_LIMITS.height || body[8] !== 8 || !channels
          || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) return bad('png');
    } else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') ended = true;
    else if (type === 'IHDR' || type === 'PLTE') return bad('png');
    at += 12 + length;
  }
  if (!ended || !data.length) return bad('png');
  const expected = height * (1 + width * channels);
  let pixels: Buffer;
  try { pixels = inflateSync(Buffer.concat(data), { maxOutputLength: expected }); }
  catch { return bad('png'); }
  if (pixels.length !== expected) return bad('png');
  for (let row = 0; row < height; row++) if (pixels[row * (1 + width * channels)] > 4) return bad('png');
  return { png, width, height };
}

/** The attach operation of a draft write: what to draw on, the marks, the picture and which attached drawing it replaces. */
export function drawingRequest(value: unknown): DrawingRequest {
  if (!plain(value)) return bad('drawing');
  for (const key of Object.keys(value)) if (!['background', 'source', 'strokes', 'png', 'replaces'].includes(key)) bad(key);
  const background = value.background as DrawingBackground;
  if (!DRAWING_BACKGROUNDS.includes(background)) bad('background');
  let source: DrawingRequest['source'] = null;
  if (background === 'image') {
    const s = value.source;
    if (!plain(s) || typeof s.keyImageId !== 'string' || !UUID.test(s.keyImageId) || !Number.isSafeInteger(s.keyImageRevision)
        || (s.keyImageRevision as number) < 1 || !Number.isSafeInteger(s.frame) || (s.frame as number) < 1) bad('source');
    source = { keyImageId: (s as any).keyImageId, keyImageRevision: (s as any).keyImageRevision, frame: (s as any).frame };
  } else if (value.source !== undefined && value.source !== null) bad('source');
  const strokes = drawingStrokes(value.strokes);
  if (!strokes.length) bad('strokes');
  const replaces = value.replaces === undefined || value.replaces === null ? null : value.replaces;
  if (replaces !== null && (typeof replaces !== 'string' || !UUID.test(replaces))) bad('replaces');
  return { background, source, strokes, ...drawingPng(value.png), replaces: replaces as string | null };
}

/** The server's hash of one drawing: what it was drawn on, the marks and the exact picture. */
export function drawingHash(d: { background: string; source: unknown; strokes: unknown; png: Buffer }): string {
  const png = createHash('sha256').update(d.png).digest('hex');
  return createHash('sha256').update(JSON.stringify(['report-drawing-v1', d.background, d.source ?? null, d.strokes, png])).digest('hex');
}

/** Two drawings of the same key replace each other: one per diagram, one per saved image frame. */
export function drawingKey(d: { background: string; source?: any }): string {
  return d.background === 'image' ? `image:${d.source?.sopUid ?? ''}:${d.source?.frame ?? ''}` : d.background;
}

/** `ReportVersion.drawings` as stored: entries `{ id, background, source, sha256 }`. */
export function versionDrawings(value: unknown): { id: string; background: string; source: any; sha256: string }[] {
  return Array.isArray(value) ? value.filter(e => plain(e) && typeof e.id === 'string') as any[] : [];
}
export const versionDrawingIds = (value: unknown) => versionDrawings(value).map(e => e.id);

/** `ReportDraft.drawings` as stored, or null when the draft leaves the drawings as they are. */
export function draftDrawings(value: unknown): { seed: string[]; ids: string[] } | null {
  if (!plain(value) || !Array.isArray(value.seed) || !Array.isArray(value.ids)) return null;
  return { seed: value.seed.filter((id): id is string => typeof id === 'string'), ids: value.ids.filter((id): id is string => typeof id === 'string') };
}

/** The drawings the next version holds: the draft's (a seeded one only while the head holds it), then head ones it never saw. */
export function effectiveDrawingIds(draft: { seed: string[]; ids: string[] } | null, head: readonly string[]): string[] {
  if (!draft) return [...head];
  const kept = draft.ids.filter(id => !draft.seed.includes(id) || head.includes(id));
  return [...kept, ...head.filter(id => !draft.seed.includes(id) && !kept.includes(id))];
}

/** "Nothing to keep": the draft neither adds nor removes a drawing. */
export const drawingsUntouched = (d: { seed: string[]; ids: string[] } | null) =>
  !d || (d.seed.length === d.ids.length && d.seed.every(id => d.ids.includes(id)));

/** The signature attachments of a version: each drawing as a pinned report-evidence record. */
export function drawingAttachments(value: unknown) {
  return versionDrawings(value).map(d => ({ kind: 'report-evidence' as const, recordId: d.id, versionId: '1', sha256: d.sha256 }));
}

/** The version entries of these drawings of the study, in this order. A missing row is a broken invariant, never skipped. */
export async function drawingEntries(tx: any, uid: string, ids: readonly string[]) {
  if (!ids.length) return [] as { id: string; background: string; source: any; sha256: string }[];
  const rows: any[] = await tx.reportDrawing.findMany({ where: { studyUid: uid, id: { in: [...ids] } },
    select: { id: true, background: true, source: true, sha256: true } });
  return ids.map(id => {
    const row = rows.find(r => r.id === id);
    if (!row) throw new Error('ReportDrawing row missing for ' + id);
    return { id: row.id, background: row.background, source: row.source ?? null, sha256: row.sha256 };
  });
}
/**
 * A report version row as signed and as hashed for the next version: a row without drawings serializes exactly as it did
 * before the column existed, so a stored signature and a stored previous-version hash stay the hashes of that row.
 */
export function signedReportRow<T>(row: T): T {
  if (!row || (row as any).drawings !== null) return row;
  const { drawings: _none, ...rest } = row as any;
  return rest as T;
}