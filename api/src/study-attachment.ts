/*
 * FC-076 Attach Document: the pure rules. A scanned document or PC picture becomes one new series of one instance in the
 * study it is attached to: a picture (PNG; the page redraws a JPG as PNG before sending it, so the stored pixels can be
 * checked byte for byte) as DICOM Secondary Capture, a PDF as DICOM Encapsulated PDF, made by
 * Orthanc (`POST /tools/create-dicom`) under the study's Orthanc ID. What this file decides: the file's kind (its first
 * bytes, never only the declared type), its name, the Orthanc request, the check of what Orthanc stored, and which
 * objects of a study the serving paths leave out (every attachment not confirmed stored: pending, failed, withdrawn).
 */
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflate } from 'node:zlib';

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
/** A PNG body's limit: a JPG of up to 20 MB, redrawn as PNG by the page, can be larger than the file chosen. */
export const ATTACHMENT_PNG_MAX_BYTES = 64 * 1024 * 1024;
export const SECONDARY_CAPTURE = '1.2.840.10008.5.1.4.1.1.7';
export const ENCAPSULATED_PDF = '1.2.840.10008.5.1.4.1.1.104.1';
export const ATTACHMENT_SERIES_DESCRIPTION = 'Attached Document';
export const WITHDRAW_REASON_MAX = 500;

export const ATTACHMENT_MESSAGES = Object.freeze({
  tooLarge: '파일이 20MB를 넘습니다',
  imageTooLarge: '그림이 너무 큽니다',
  type: 'JPG·PNG·PDF 파일만 붙일 수 있습니다',
  jpeg: 'JPG 파일은 화면을 새로 고친 뒤 다시 붙이세요',
  name: '파일 이름을 확인하세요',
  request: '요청 번호를 확인하세요',
  requestReused: '이 요청 번호는 다른 파일이나 다른 검사에 이미 쓰였습니다',
  role: '문서 붙이기는 방사선사 또는 판독의 권한이 필요합니다',
  withdrawRole: '철회는 방사선사 또는 관리자 권한이 필요합니다',
  notFound: '검사를 찾을 수 없습니다',
  received: '원격판독으로 받은 검사에는 문서를 붙이거나 철회할 수 없습니다',
  reason: '사유가 필요합니다',
  attachmentNotFound: '붙은 문서를 찾을 수 없습니다',
  notStored: '저장이 확인된 문서만 철회할 수 있습니다',
  unconfirmed: '저장 결과를 아직 확인하지 못했습니다. 이 검사에 붙은 문서 목록에서 다시 확인됩니다',
  source: '검사의 원본을 확인하지 못했습니다. 잠시 뒤 다시 시도하세요',
  imageUnreadable: '그림 파일을 읽을 수 없습니다',
});

export type AttachmentKind = 'image' | 'pdf';
export type AttachmentFormat = 'png' | 'pdf';

/** The file's own first bytes: PNG's 8-byte signature, PDF `%PDF-`. Anything else is no attachment. */
export function sniffAttachment(bytes: Buffer): AttachmentFormat | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  return null;
}

/** The declared media type, which must agree with the first bytes. */
export function declaredFormat(contentType: unknown): AttachmentFormat | null {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  return type === 'image/png' ? 'png' : type === 'application/pdf' ? 'pdf' : null;
}

/** A JPEG body (`FF D8`): a page from before pictures were redrawn as PNG sent it; it is refused with its own reason. */
export const isJpeg = (bytes: Buffer) => bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;

export const kindOf = (format: AttachmentFormat): AttachmentKind => format === 'pdf' ? 'pdf' : 'image';

/**
 * `X-KIN-File-Name`: the file's name, percent-encoded UTF-8. The last path segment only, 1-255 characters, no control
 * characters. Null when it cannot be read.
 */
export function decodeFileName(header: unknown): string | null {
  if (typeof header !== 'string' || !header || header.length > 2048 || !/^[\x21-\x7e]+$/.test(header)) return null;
  let name: string;
  try { name = decodeURIComponent(header); } catch { return null; }
  name = name.split(/[\\/]/).pop()!.normalize('NFC').trim();
  // decodeURIComponent already refuses bytes that are not UTF-8, so no lone surrogate reaches here.
  if (!name || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/** A new DICOM UID under the UUID root (2.25, ISO/IEC 9834-8). */
export function newDicomUid(): string {
  return '2.25.' + BigInt('0x' + randomUUID().replace(/-/g, '')).toString();
}

export interface AttachmentPlan {
  kind: AttachmentKind;
  format: AttachmentFormat;
  sopInstanceUid: string;
  seriesInstanceUid: string;
}

/**
 * The create-dicom request. `Parent` is the study's Orthanc ID (not its StudyInstanceUID): Orthanc copies the patient and
 * study modules from it, so neither is sent here. `Force` is what lets the request name its own series and SOP UIDs
 * (Orthanc refuses to set them otherwise), which the row holds before the write; nothing else this request names is a
 * patient or study tag.
 */
export function createDicomRequest(parent: string, plan: AttachmentPlan, bytes: Buffer) {
  const mime = plan.format === 'pdf' ? 'application/pdf' : 'image/png';
  return {
    Parent: parent,
    Force: true,
    Tags: {
      SOPClassUID: plan.kind === 'pdf' ? ENCAPSULATED_PDF : SECONDARY_CAPTURE,
      SOPInstanceUID: plan.sopInstanceUid,
      SeriesInstanceUID: plan.seriesInstanceUid,
      Modality: plan.kind === 'pdf' ? 'DOC' : 'OT',
      SeriesDescription: ATTACHMENT_SERIES_DESCRIPTION,
      InstanceNumber: '1',
      ConversionType: 'WSD',
      ...(plan.kind === 'pdf' ? { DocumentTitle: ATTACHMENT_SERIES_DESCRIPTION } : {}),
    },
    Content: `data:${mime};base64,` + bytes.toString('base64'),
  };
}

/** How much of the IDAT stream is handed to zlib at a time, and the size of each piece it hands back. */
const PNG_STEP = 64 * 1024;

/**
 * A PNG's pixels as Orthanc stores them after decoding it (create-dicom's EmbedImage): 8-bit grey as one sample, RGB as
 * three, a palette expanded to RGB, and RGBA as RGB (DICOM has no alpha; Orthanc drops it). Non-interlaced 8-bit only;
 * anything else (and more than 64 megapixels) is null and refused as unreadable. This is the picture's content check:
 * the pixels Orthanc holds must be these, byte for byte - kept as their SHA-256 only.
 *
 * The pixels are never held whole: the IDAT stream is inflated piece by piece (zlib off the event loop, its input paced
 * by its output), each piece is unfiltered as it comes (only the line above is kept, and only when there is one) and
 * hashed. Inflating past the expected length stops at once; the stream must end (zlib's own end and checksum) at exactly
 * rows x (1 + line) bytes.
 */
export async function pngPixels(bytes: Buffer): Promise<{ columns: number; rows: number; samples: 1 | 3; sha256: string } | null> {
  try {
    if (sniffAttachment(bytes) !== 'png') return null;
    let at = 8, header: Buffer | null = null, palette: Buffer | null = null;
    const data: Buffer[] = [];
    while (at + 8 <= bytes.length) {
      const length = bytes.readUInt32BE(at), type = bytes.subarray(at + 4, at + 8).toString('latin1');
      const body = bytes.subarray(at + 8, at + 8 + length);
      if (body.length !== length) return null;
      if (type === 'IHDR') header = body;
      else if (type === 'PLTE') palette = body;
      else if (type === 'IDAT') data.push(body);
      else if (type === 'IEND') break;
      at += 12 + length;
    }
    if (!header || header.length !== 13) return null;
    const columns = header.readUInt32BE(0), rows = header.readUInt32BE(4), depth = header[8], color = header[9];
    if (!columns || !rows || columns * rows > 64 * 1024 * 1024 || depth !== 8 || header[10] !== 0 || header[11] !== 0 || header[12] !== 0) return null;
    const channels = ({ 0: 1, 2: 3, 3: 1, 6: 4 } as Record<number, number>)[color];
    if (!channels || (color === 3 && (!palette || palette.length % 3))) return null;
    const unfilter = pngUnfilter(columns, rows, channels, color, palette);
    await pipeline(
      Readable.from((function* () { for (const body of data) for (let i = 0; i < body.length; i += PNG_STEP) yield body.subarray(i, i + PNG_STEP); })()),
      createInflate({ chunkSize: PNG_STEP }),
      new Writable({
        write(piece: Buffer, _encoding, done) {
          for (let i = 0; i < piece.length; i += PNG_STEP) if (!unfilter.take(piece.subarray(i, i + PNG_STEP))) return done(new Error('png'));
          done();
        },
        final(done) { done(unfilter.complete() ? null : new Error('png')); },
      }),
    );
    return { columns, rows, samples: color === 0 ? 1 : 3, sha256: unfilter.digest() };
  } catch { return null; }
}

/**
 * The PNG line filters undone over the inflated stream as it arrives, in any piece size: each byte is the filter type
 * at a line's start, or a filtered sample. `a` (left), `b` (above) and `c` (above-left) come from two rings of one pixel
 * and the line above, which is overwritten in place as the new line is decoded (none for a one-line picture). The
 * decoded samples go to the hash as Orthanc stores them: grey or RGB as they are, RGBA without alpha, a palette index as
 * its RGB entry (an index past the palette is unreadable).
 */
function pngUnfilter(columns: number, rows: number, channels: number, color: number, palette: Buffer | null) {
  const stride = columns * channels, expected = rows * (stride + 1);
  const above = rows > 1 ? Buffer.allocUnsafe(stride) : null;
  const left = new Uint8Array(4), upLeft = new Uint8Array(4), out = Buffer.allocUnsafe(PNG_STEP * 3);
  const hash = createHash('sha256');
  let total = 0, y = 0, x = -1, filter = 0, k = 0;
  return {
    take(piece: Buffer): boolean {
      if (total + piece.length > expected) return false;
      total += piece.length;
      let o = 0;
      for (let i = 0; i < piece.length; i++) {
        if (x < 0) {
          filter = piece[i];
          if (filter > 4) return false;
          x = 0; k = 0;
          continue;
        }
        const b = y && above ? above[x] : 0;
        let value = piece[i];
        if (filter === 1) value += x >= channels ? left[k] : 0;
        else if (filter === 2) value += b;
        else if (filter === 3) value += ((x >= channels ? left[k] : 0) + b) >> 1;
        else if (filter === 4) {
          const a = x >= channels ? left[k] : 0, c = y && x >= channels ? upLeft[k] : 0;
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        value &= 255;
        if (above) { upLeft[k] = b; above[x] = value; }
        left[k] = value;
        if (color === 3) {
          const entry = value * 3;
          if (entry + 3 > palette!.length) return false;
          out[o++] = palette![entry]; out[o++] = palette![entry + 1]; out[o++] = palette![entry + 2];
        } else if (color !== 6 || k !== 3) out[o++] = value;
        if (++k === channels) k = 0;
        if (++x === stride) { x = -1; y++; }
      }
      hash.update(out.subarray(0, o));
      return true;
    },
    complete: () => total === expected && y === rows && x === -1,
    digest: () => hash.digest('hex'),
  };
}

export interface AttachmentExpectation {
  uid: string;
  parent: string;
  patientId: string;
  patientName: string;
  sopInstanceUid: string;
  seriesInstanceUid: string;
  kind: AttachmentKind;
  size: { columns: number; rows: number } | null;
  /** A picture's decoded pixels (pngPixels): samples per pixel and the SHA-256 of the pixel bytes. Required for a picture. */
  pixels?: { samples: 1 | 3; sha256: string } | null;
  /** The PDF's SHA-256 (the row's own digest), for a read-back without the uploaded bytes at hand. */
  sha256?: string;
}

export interface AttachmentObservation {
  parentStudy: string | null;
  tags: Record<string, unknown>;
  /** The Encapsulated Document as stored (a PDF only). */
  document: Buffer | null;
  /**
   * The first frame as stored (a picture only), never held whole: its length and the SHA-256 of its first
   * rows x columns x samples bytes (the expected frame; DICOM may pad it by one byte).
   */
  pixels: { length: number; sha256: string } | null;
}

const text = (value: unknown) => typeof value === 'string' ? value.replace(/[\0 ]+$/, '') : null;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/**
 * What Orthanc stored, read back: the same study (its Orthanc parent, StudyInstanceUID, PatientID and PatientName as the
 * study's own), the planned series and SOP UIDs, the expected SOP class, and the content: a PDF's bytes (DICOM's
 * even-length padding aside); a picture's size and decoded pixels byte for byte (a picture without expected pixels is
 * never confirmed). Null when it is the planned object; otherwise the first difference, in words.
 */
export function readbackDifference(expected: AttachmentExpectation, observed: AttachmentObservation): string | null {
  const t = observed.tags;
  if (observed.parentStudy !== expected.parent) return '다른 검사 아래에 만들어졌습니다';
  if (text(t.StudyInstanceUID) !== expected.uid) return 'StudyInstanceUID가 원본 검사와 다릅니다';
  if ((text(t.PatientID) ?? '') !== expected.patientId || (text(t.PatientName) ?? '') !== expected.patientName)
    return '환자 식별이 원본 검사와 다릅니다';
  if (text(t.SOPInstanceUID) !== expected.sopInstanceUid || text(t.SeriesInstanceUID) !== expected.seriesInstanceUid)
    return '만든 객체의 식별자가 요청과 다릅니다';
  if (text(t.SOPClassUID) !== (expected.kind === 'pdf' ? ENCAPSULATED_PDF : SECONDARY_CAPTURE)) return 'SOP class가 기대와 다릅니다';
  if (expected.kind === 'pdf') {
    const doc = observed.document;
    if (text(t.MIMETypeOfEncapsulatedDocument) !== 'application/pdf' || !doc || !expected.sha256) return '실린 PDF를 확인하지 못했습니다';
    const padded = doc.length % 2 === 0 && doc.length > 0 && (doc[doc.length - 1] === 0 || doc[doc.length - 1] === 0x20);
    if (digest(doc) !== expected.sha256 && !(padded && digest(doc.subarray(0, doc.length - 1)) === expected.sha256))
      return '실린 PDF가 올린 파일과 다릅니다';
    return null;
  }
  if (!expected.size || Number(t.Rows) !== expected.size.rows || Number(t.Columns) !== expected.size.columns)
    return '실린 그림의 크기가 올린 파일과 다릅니다';
  if (!expected.pixels) return '실린 그림의 화소를 확인하지 못했습니다';
  const length = expected.size.rows * expected.size.columns * expected.pixels.samples, stored = observed.pixels;
  if (Number(t.SamplesPerPixel) !== expected.pixels.samples || !stored || stored.length < length || stored.length > length + 1
      || stored.sha256 !== expected.pixels.sha256) return '실린 그림의 화소가 올린 파일과 다릅니다';
  return null;
}

/**
 * The objects the serving paths leave out: every attachment row not confirmed stored (pending, failed, withdrawn) - its
 * planned series and SOP, its Orthanc instance once seen, and the series it was actually stored under when a read-back
 * found it elsewhere.
 */
export interface HiddenAttachments { series: Set<string>; sops: Set<string>; orthancIds: Set<string> }
export const NO_HIDDEN: HiddenAttachments = Object.freeze({ series: new Set<string>(), sops: new Set<string>(), orthancIds: new Set<string>() }) as HiddenAttachments;
const HIDDEN_FIELDS = { seriesInstanceUid: true, sopInstanceUid: true, orthancId: true, objectSeriesUid: true } as const;

export function hiddenOf(rows: readonly { seriesInstanceUid: string; sopInstanceUid: string; orthancId: string | null; objectSeriesUid?: string | null }[]): HiddenAttachments {
  if (!rows.length) return NO_HIDDEN;
  return { series: new Set(rows.flatMap(r => r.objectSeriesUid ? [r.seriesInstanceUid, r.objectSeriesUid] : [r.seriesInstanceUid])),
    sops: new Set(rows.map(r => r.sopInstanceUid)), orthancIds: new Set(rows.flatMap(r => r.orthancId ? [r.orthancId] : [])) };
}

/** Rows to read for `hiddenOf`: the study's own attachments and any found stored under it, every state but `stored`. */
export async function hiddenAttachments(db: { studyAttachment: { findMany(args: any): Promise<any[]> } }, uid: string): Promise<HiddenAttachments> {
  return hiddenOf(await db.studyAttachment.findMany({ where: { state: { not: 'stored' }, OR: [{ uid }, { objectStudyUid: uid }] },
    select: HIDDEN_FIELDS }));
}

/**
 * Whether an image path reaches a left-out object: its series, SOP or Orthanc instance by name, or the whole study at
 * once (WADO-RS study retrieve, its rendered and thumbnail forms, study bulk data), which would carry it along.
 */
export function namesHidden(path: string, hidden: HiddenAttachments): boolean {
  if (!hidden.series.size && !hidden.orthancIds.size) return false;
  if (/^\/dicom-web\/studies\/[0-9.]+(?:\/(?:rendered|thumbnail|bulkdata)(?:\/.*)?)?$/.test(path)) return true;
  const series = /^\/dicom-web\/studies\/[0-9.]+\/series\/([0-9.]+)(?:\/|$)/.exec(path)?.[1];
  if (series && hidden.series.has(series)) return true;
  const sop = /\/instances\/([0-9.]+)(?:\/|$)/.exec(path)?.[1];
  if (sop && path.startsWith('/dicom-web/') && hidden.sops.has(sop)) return true;
  const instance = /^\/instances\/([0-9a-f-]+)(?:\/|$)/.exec(path)?.[1];
  return !!instance && hidden.orthancIds.has(instance);
}

/** An Orthanc instance path's ID (`/instances/{id}/...`), for the gate's check of an instance not yet seen. */
export const orthancInstanceOf = (path: string) => /^\/instances\/([0-9a-f-]+)(?:\/|$)/.exec(path)?.[1] ?? null;

const LEFT_OUT = { state: { not: 'stored' } } as const;
type AttachmentReader = { studyAttachment: { findFirst(args: any): Promise<any> } };

/**
 * Whether an image path names a left-out object wherever it is held - by its planned or actual series, its SOP or its
 * Orthanc instance, not only within the study the path names (an object Orthanc stored under another study is still
 * this feature's). An Orthanc instance no row names yet is checked by its own series and SOP (`instanceUids`), but only
 * while some left-out row has not been seen in Orthanc.
 */
export async function leftOutObject(db: AttachmentReader, path: string,
    instanceUids: (id: string) => Promise<{ series: string; sop: string }>): Promise<boolean> {
  const series = /^\/dicom-web\/studies\/[0-9.]+\/series\/([0-9.]+)(?:\/|$)/.exec(path)?.[1];
  const sop = path.startsWith('/dicom-web/') ? /\/instances\/([0-9.]+)(?:\/|$)/.exec(path)?.[1] : undefined;
  const instance = orthancInstanceOf(path);
  const named = (s?: string, p?: string, o?: string | null) => [...(s ? [{ seriesInstanceUid: s }, { objectSeriesUid: s }] : []),
    ...(p ? [{ sopInstanceUid: p }] : []), ...(o ? [{ orthancId: o }] : [])];
  const any = async (or: object[]) => !!or.length && !!await db.studyAttachment.findFirst({ where: { ...LEFT_OUT, OR: or }, select: { id: true } });
  if (await any(named(series, sop, instance))) return true;
  if (!instance || !await db.studyAttachment.findFirst({ where: { ...LEFT_OUT, orthancId: null }, select: { id: true } })) return false;
  const own = await instanceUids(instance);
  return any(named(own.series, own.sop));
}

const tagValue = (item: any, tag: string) => { const v = item?.[tag]?.Value?.[0]; return typeof v === 'string' ? v : null; };

/**
 * A DICOM JSON array (QIDO series or instances, study or series metadata) without the left-out objects. The same array
 * object when nothing is left out, so the caller keeps Orthanc's own representation.
 */
export function withoutHidden(body: unknown, hidden: HiddenAttachments): unknown {
  if (!Array.isArray(body) || !hidden.series.size) return body;
  const kept = body.filter(item => !hidden.series.has(tagValue(item, '0020000E') ?? '') && !hidden.sops.has(tagValue(item, '00080018') ?? ''));
  return kept.length === body.length ? body : kept;
}