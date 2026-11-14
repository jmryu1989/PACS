/*
 * Film / DICOM Print: the pure rules of printing one film of a series to a DICOM film printer, or sending the same
 * film as one layout image to a DICOM device. No I/O here; film-print.service.ts reads Orthanc and the database and
 * runs the DICOM helper (api/print/film_print.py).
 *
 * What a film holds is decided once, here, for both the preview and the print: the chosen series' images in
 * InstanceNumber order, one cell per frame (a multi-frame image fills one cell per frame), cells left empty when the
 * images run out. Each cell names its SOP Instance UID, frame, order, the window it is rendered with (the image
 * header's Window Center/Width - not the viewer's current one; the full range when the header has none) and its
 * output size. The preview and the printer get the same Orthanc rendering of each cell.
 */
import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export const FILM_MESSAGES = Object.freeze({
  request: '인쇄 요청 형식이 잘못되었습니다',
  noImages: '이 시리즈에는 인쇄할 영상이 없습니다',
  seriesNotFound: '이 검사에 그 시리즈가 없습니다',
  studyNotFound: '검사를 찾을 수 없습니다',
  filmOutOfRange: '그 필름 번호는 이 시리즈에 없습니다 — 미리보기를 다시 여세요',
  peerNotFound: '그 프린터나 장치가 등록돼 있지 않습니다',
  filmSize: (name: string, size: string) => `${name}에는 ${size} 필름이 등록돼 있지 않습니다`,
  jobNotFound: '인쇄 작업을 찾을 수 없습니다',
  requestReused: '같은 요청 번호로 다른 인쇄를 보낼 수 없습니다 — 창을 다시 여세요',
  tooMany: '한 시리즈의 영상이 너무 많습니다',
  planChanged: '미리보기를 연 뒤 이 시리즈의 영상이 바뀌었습니다 — 바뀐 미리보기를 확인하고 다시 인쇄하세요',
});

export const FORMATS = Object.freeze(['1x1', '1x2', '2x2', '3x4', '4x5']);
export const FILM_SIZES = Object.freeze(['8INX10IN', '10INX12IN', '11INX14IN', '14INX17IN']);
export const ORIENTATIONS = Object.freeze(['PORTRAIT', 'LANDSCAPE']);
export const MAX_COPIES = 5;
/** Output resolution of a film: pixels per inch of the rendered cells and of the layout image. */
export const FILM_DPI = 150;
/** The most frames one series may offer to the plan (a guard against an unbounded instance list). */
export const MAX_FRAMES = 5000;
/** Series that hold no printable picture. */
const NOT_IMAGES = new Set(['SR', 'PR', 'KO', 'DOC']);

const UID = /^[0-9]+(?:\.[0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUid = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && UID.test(value);
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

export type Layout = { columns: number; rows: number; filmSize: string; orientation: string };
export type LayoutRequest = Layout & { studyUid: string; seriesUid: string | null; film: number;sourceUid?:string };
export type JobRequest = LayoutRequest & { seriesUid: string; copies: number; requestId: string; plan: string;
  destination: { kind: 'printer' | 'device'; peerId: string } };

function fail(): never { throw new BadRequestException(FILM_MESSAGES.request); }

/** `{ studyUid, seriesUid?, format: 'c x r', filmSize, orientation, film? }` → the layout asked for. */
export function layoutRequest(body: any): LayoutRequest {
  if (!body || typeof body !== 'object' || !isUid(body.studyUid)) fail();
  if (body.seriesUid != null && !isUid(body.seriesUid)) fail();
  if(body.sourceUid!==undefined&&!isUid(body.sourceUid))fail();
  if (!FORMATS.includes(body.format) || !FILM_SIZES.includes(body.filmSize) || !ORIENTATIONS.includes(body.orientation)) fail();
  const film = body.film == null ? 1 : body.film;
  if (!Number.isInteger(film) || film < 1 || film > MAX_FRAMES) fail();
  const [columns, rows] = String(body.format).split('x').map(Number);
  return { studyUid: body.studyUid, seriesUid: body.seriesUid ?? null, columns, rows, filmSize: body.filmSize, orientation: body.orientation, film,...(body.sourceUid?{sourceUid:body.sourceUid}:{}) };
}

/**
 * The layout plus `copies`, `destination { kind, peerId }`, the request's own id (one request, one film) and `plan`: the
 * key of the cells the preview showed (planKey), so the print is exactly that film or nothing.
 */
export function jobRequest(body: any): JobRequest {
  const layout = layoutRequest(body);
  if (!layout.seriesUid || !isUuid(body.requestId) || typeof body.plan !== 'string' || !/^[0-9a-f]{64}$/.test(body.plan)) fail();
  const copies = body.copies;
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) fail();
  const d = body.destination;
  if (!d || typeof d !== 'object' || (d.kind !== 'printer' && d.kind !== 'device') || !isUuid(d.peerId)) fail();
  return { ...layout, seriesUid: layout.seriesUid!, copies, requestId: body.requestId.toLowerCase(), plan: body.plan,
    destination: { kind: d.kind, peerId: d.peerId.toLowerCase() } };
}

/** What makes two requests the same print (the idempotency check of a repeated request id). */
export function fingerprint(r: JobRequest): string {
  return JSON.stringify([r.studyUid, r.seriesUid, r.columns, r.rows, r.filmSize, r.orientation, r.film, r.copies, r.destination.kind, r.destination.peerId, r.plan,...(r.sourceUid?[r.sourceUid]:[])]);
}

// ── series and the plan ──

export type SeriesInfo = { id: string; uid: string; number: number | null; description: string; modality: string; instances: string[] };

/** The study's printable series in SeriesNumber order (no number last), without the left-out ones (attachments). */
export function printableSeries(series: SeriesInfo[], leftOut: ReadonlySet<string>): SeriesInfo[] {
  return series.filter(s => s.instances.length && !NOT_IMAGES.has(s.modality.toUpperCase()) && !leftOut.has(s.uid))
    .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || a.uid.localeCompare(b.uid));
}

export type Frame = { instance: string; sop: string; frame: number; order: number };

/** Every frame of the series in display order: InstanceNumber (numeric; none last), then SOP UID; frames 1..n of each. */
export function framesOf(instances: { id: string; sop: string; number: string; frames: string }[]): Frame[] {
  const number = (v: string) => /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : Infinity;
  const sorted = [...instances].sort((a, b) => number(a.number) - number(b.number) || a.sop.localeCompare(b.sop));
  const out: Frame[] = [];
  for (const i of sorted) {
    const count = /^\d+$/.test(i.frames.trim()) && Number(i.frames.trim()) > 0 ? Number(i.frames.trim()) : 1;
    for (let f = 1; f <= count; f++) {
      if (out.length >= MAX_FRAMES) throw new BadRequestException(FILM_MESSAGES.tooMany);
      out.push({ instance: i.id, sop: i.sop, frame: f, order: out.length + 1 });
    }
  }
  return out;
}

/** The film's pixel size (width, height) at FILM_DPI; landscape turns it. */
export function filmPixels(filmSize: string, orientation: string): { width: number; height: number } {
  const match = /^(\d+)INX(\d+)IN$/.exec(filmSize);
  if (!match) fail();
  const [short, long] = [Number(match[1]) * FILM_DPI, Number(match[2]) * FILM_DPI];
  return orientation === 'LANDSCAPE' ? { width: long, height: short } : { width: short, height: long };
}

/** One cell's box on the film: `columns` across, `rows` down. */
export function cellSize(layout: Layout): { width: number; height: number } {
  const film = filmPixels(layout.filmSize, layout.orientation);
  return { width: Math.floor(film.width / layout.columns), height: Math.floor(film.height / layout.rows) };
}

/** The first value of a header Window Center/Width text (`40\80` → 40); null unless both are numbers and the width is positive. */
export function headerWindow(raw: { center: string | null; width: string | null }): { center: number; width: number } | null {
  const first = (v: string | null) => {
    const text = v == null ? '' : String(v).split('\\')[0].trim();
    return /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(text) ? Number(text) : NaN;
  };
  const center = first(raw.center), width = first(raw.width);
  return Number.isFinite(center) && Number.isFinite(width) && width > 0 ? { center, width } : null;
}

export type Cell = { position: number; instance: string; sop: string; frame: number; order: number;
  window: { center: number; width: number } | null; width: number; height: number };

/** How many films the frames fill and the cells of film `film` (1-based): positions 1..c*r, empty cells absent. */
export function planFilm(frames: Frame[], layout: Layout, film: number, windows: Map<string, { center: number; width: number } | null>) {
  const per = layout.columns * layout.rows;
  const films = Math.max(1, Math.ceil(frames.length / per));
  if (!frames.length) throw new BadRequestException(FILM_MESSAGES.noImages);
  if (film > films) throw new BadRequestException(FILM_MESSAGES.filmOutOfRange);
  const size = cellSize(layout);
  const cells: Cell[] = frames.slice((film - 1) * per, film * per).map((f, index) => ({
    position: index + 1, instance: f.instance, sop: f.sop, frame: f.frame, order: f.order,
    window: windows.get(f.instance) ?? null, width: size.width, height: size.height }));
  return { films, cells };
}

/** The key of a film's cells: each cell's position, SOP, frame, order, window and size (the preview's and the print's). */
export function planKey(cells: Cell[],generation?:string,sourceUid?:string): string {
  const frames=cells.map(c => [c.position, c.sop, c.frame, c.order, c.window, c.width, c.height]);
  return createHash('sha256').update(JSON.stringify(generation?[generation,sourceUid,frames]:frames)).digest('hex');
}

/** The Orthanc rendering query of a cell, the same for the preview and the print (no window = Orthanc's full range). */
export function renderQuery(cell: Pick<Cell, 'window' | 'width' | 'height'>): string {
  const parts = [`width=${cell.width}`, `height=${cell.height}`];
  if (cell.window) parts.unshift(`window-center=${cell.window.center}`, `window-width=${cell.window.width}`);
  return parts.join('&');
}

// ── pixels ──

/** A PAM image (Orthanc's `image/x-portable-arbitrarymap`) → 8-bit grey pixels; RGB is turned grey (BT.601 weights). */
export function pamToGrey(data: Buffer): { width: number; height: number; pixels: Buffer } {
  const end = data.indexOf('ENDHDR\n');
  if (data.subarray(0, 3).toString('latin1') !== 'P7\n' || end < 0 || end > 512) throw new Error('not a PAM image');
  const header = Object.fromEntries(data.subarray(3, end).toString('latin1').split('\n').filter(Boolean)
    .map(line => { const at = line.indexOf(' '); return [line.slice(0, at), line.slice(at + 1).trim()]; }));
  const width = Number(header.WIDTH), height = Number(header.HEIGHT), depth = Number(header.DEPTH), max = Number(header.MAXVAL);
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 16384) || ![1, 3, 4].includes(depth) || max !== 255)
    throw new Error('unsupported PAM image');
  const body = data.subarray(end + 7);
  if (body.length < width * height * depth) throw new Error('short PAM image');
  if (depth === 1) return { width, height, pixels: Buffer.from(body.subarray(0, width * height)) };
  const pixels = Buffer.alloc(width * height);
  for (let i = 0, j = 0; i < pixels.length; i++, j += depth)
    pixels[i] = (body[j] * 299 + body[j + 1] * 587 + body[j + 2] * 114 + 500) / 1000 | 0;
  return { width, height, pixels };
}

/**
 * The film as one picture (the layout image sent to a device): black film, each cell's picture centred in its box,
 * cropped to the box if larger. Positions run left to right, top to bottom.
 */
export function composeFilm(layout: Layout, cells: { position: number; width: number; height: number; pixels: Buffer }[]) {
  const film = filmPixels(layout.filmSize, layout.orientation), box = cellSize(layout);
  const canvas = Buffer.alloc(film.width * film.height);
  for (const cell of cells) {
    const column = (cell.position - 1) % layout.columns, row = Math.floor((cell.position - 1) / layout.columns);
    const w = Math.min(cell.width, box.width), h = Math.min(cell.height, box.height);
    const sx = Math.floor((cell.width - w) / 2), sy = Math.floor((cell.height - h) / 2);
    const dx = column * box.width + Math.floor((box.width - w) / 2), dy = row * box.height + Math.floor((box.height - h) / 2);
    for (let y = 0; y < h; y++) {
      const from = (sy + y) * cell.width + sx;
      cell.pixels.copy(canvas, (dy + y) * film.width + dx, from, from + w);
    }
  }
  return { width: film.width, height: film.height, pixels: canvas };
}

/** A new DICOM UID from a random UUID (the 2.25 root, PS3.5 B.2). */
export function uuidUid(uuid: string): string {
  return '2.25.' + BigInt('0x' + uuid.replace(/-/g, '')).toString();
}

// ── a job's answer ──

export type JobState = 'sending' | 'sent' | 'printed' | 'sent-unreported' | 'no-answer' | 'failed' | 'stored';
export const FINAL_STATES: ReadonlySet<string> = new Set(['printed', 'sent-unreported', 'no-answer', 'failed', 'stored']);
/** The reason kept on a job the server cannot know the end of (it restarted while the job was open). */
export const RESTART_REASON = 'the server restarted before the answer came - the result is unknown';

/** The job as the screen reads it: its states in order, the final one's reason and warnings. */
export function jobView(row: any) {
  const layout = row.layout ?? {};
  return { id: row.id, requestId: row.requestId, state: row.state, events: Array.isArray(row.events) ? row.events : [],
    reason: row.reason ?? null, warnings: Array.isArray(row.warnings) ? row.warnings : [],
    destination: { kind: row.destination, peerId: row.peerId, name: row.peerName },
    studyUid: row.studyUid, seriesUid: row.seriesUid, film: layout.film ?? null, films: layout.films ?? null,
    ...(layout.examScope?{scope:layout.examScope,sourceUid:row.studyUid}:{}),
    format: layout.format ?? null, copies: layout.copies ?? null };
}
