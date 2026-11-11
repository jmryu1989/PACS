/*
 * FC-076 Attach Document: the pure rules. A scanned document or PC picture (JPG, PNG, PDF) becomes one new series of one
 * instance in the study it is attached to: a picture as DICOM Secondary Capture, a PDF as DICOM Encapsulated PDF, made by
 * Orthanc (`POST /tools/create-dicom`) under the study's Orthanc ID. What this file decides: the file's kind (its first
 * bytes, never only the declared type), its name, the Orthanc request, the check of what Orthanc stored, and which
 * objects of a study the serving paths leave out (every attachment not confirmed stored: pending, failed, withdrawn).
 */
import { randomUUID } from 'node:crypto';

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const SECONDARY_CAPTURE = '1.2.840.10008.5.1.4.1.1.7';
export const ENCAPSULATED_PDF = '1.2.840.10008.5.1.4.1.1.104.1';
export const ATTACHMENT_SERIES_DESCRIPTION = 'Attached Document';
export const WITHDRAW_REASON_MAX = 500;

export const ATTACHMENT_MESSAGES = Object.freeze({
  tooLarge: '파일이 20MB를 넘습니다',
  type: 'JPG·PNG·PDF 파일만 붙일 수 있습니다',
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
export type AttachmentFormat = 'jpeg' | 'png' | 'pdf';

/** The file's own first bytes: JPEG `FF D8 FF`, PNG's 8-byte signature, PDF `%PDF-`. Anything else is no attachment. */
export function sniffAttachment(bytes: Buffer): AttachmentFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  return null;
}

/** The declared media type, which must agree with the first bytes. */
export function declaredFormat(contentType: unknown): AttachmentFormat | null {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  return type === 'image/jpeg' ? 'jpeg' : type === 'image/png' ? 'png' : type === 'application/pdf' ? 'pdf' : null;
}

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

/**
 * A picture's pixel size from its own header (PNG IHDR; JPEG start-of-frame), as Orthanc's decoder will read it (no EXIF
 * orientation). Null when the header cannot be read.
 */
export function imageSize(bytes: Buffer, format: 'jpeg' | 'png'): { columns: number; rows: number } | null {
  if (format === 'png') {
    if (bytes.length < 24 || bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
    const columns = bytes.readUInt32BE(16), rows = bytes.readUInt32BE(20);
    return columns > 0 && rows > 0 && columns <= 65535 && rows <= 65535 ? { columns, rows } : null;
  }
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xff) { at++; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = bytes.readUInt16BE(at + 2);
    if (length < 2 || at + 2 + length > bytes.length) return null;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 7) return null;
      const rows = bytes.readUInt16BE(at + 5), columns = bytes.readUInt16BE(at + 7);
      return rows > 0 && columns > 0 ? { columns, rows } : null;
    }
    at += 2 + length;
  }
  return null;
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
  const mime = plan.format === 'pdf' ? 'application/pdf' : plan.format === 'png' ? 'image/png' : 'image/jpeg';
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

/**
 * A PNG's pixels as Orthanc stores them after decoding it (create-dicom's EmbedImage): 8-bit grey as one sample, RGB as
 * three, a palette expanded to RGB, and RGBA as RGB (DICOM has no alpha; Orthanc drops it). Non-interlaced 8-bit only;
 * anything else (and more than 64 megapixels) is null and refused as unreadable. This is the picture's content check:
 * the pixels Orthanc holds must be these, byte for byte.
 */
export function pngPixels(bytes: Buffer): { columns: number; rows: number; samples: 1 | 3; pixels: Buffer } | null {
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
    const stride = columns * channels;
    const raw = require('node:zlib').inflateSync(Buffer.concat(data), { maxOutputLength: rows * (stride + 1) }) as Buffer;
    if (raw.length !== rows * (stride + 1)) return null;
    const plane = Buffer.alloc(rows * stride);
    for (let y = 0; y < rows; y++) {
      const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      const out = plane.subarray(y * stride, (y + 1) * stride), up = y ? plane.subarray((y - 1) * stride, y * stride) : null;
      for (let x = 0; x < stride; x++) {
        const a = x >= channels ? out[x - channels] : 0, b = up ? up[x] : 0, c = up && x >= channels ? up[x - channels] : 0;
        let value = line[x];
        if (filter === 1) value += a;
        else if (filter === 2) value += b;
        else if (filter === 3) value += (a + b) >> 1;
        else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        else if (filter !== 0) return null;
        out[x] = value & 255;
      }
    }
    if (color === 0) return { columns, rows, samples: 1, pixels: plane };
    if (color === 2) return { columns, rows, samples: 3, pixels: plane };
    const rgb = Buffer.alloc(columns * rows * 3);
    for (let i = 0, n = columns * rows; i < n; i++) {
      if (color === 6) plane.copy(rgb, i * 3, i * 4, i * 4 + 3);
      else { const entry = plane[i] * 3; if (entry + 3 > palette!.length) return null; palette!.copy(rgb, i * 3, entry, entry + 3); }
    }
    return { columns, rows, samples: 3, pixels: rgb };
  } catch { return null; }
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
  /** A PNG's decoded pixels (pngPixels): samples per pixel and the SHA-256 of the pixel bytes. Null for a JPEG. */
  pixels?: { samples: 1 | 3; sha256: string } | null;
  /** The PDF's SHA-256 (the row's own digest), for a read-back without the uploaded bytes at hand. */
  sha256?: string;
}

export interface AttachmentObservation {
  parentStudy: string | null;
  tags: Record<string, unknown>;
  /** The Encapsulated Document as stored (a PDF only). */
  document: Buffer | null;
  /** The first frame's pixel bytes as stored (a picture only). */
  pixels: Buffer | null;
}

const text = (value: unknown) => typeof value === 'string' ? value.replace(/[\0 ]+$/, '') : null;
const digest = (bytes: Buffer) => require('node:crypto').createHash('sha256').update(bytes).digest('hex') as string;

/**
 * What Orthanc stored, read back: the same study (its Orthanc parent, StudyInstanceUID, PatientID and PatientName as the
 * study's own), the planned series and SOP UIDs, the expected SOP class, and the content: a PDF's bytes (DICOM's
 * even-length padding aside); a PNG's decoded pixels byte for byte; a JPEG's size (Orthanc decodes a JPEG with its own
 * decoder, whose output another decoder does not reproduce byte for byte). Null when it is the planned object; otherwise
 * the first difference, in words.
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
  if (expected.pixels) {
    const length = expected.size.rows * expected.size.columns * expected.pixels.samples, stored = observed.pixels;
    if (Number(t.SamplesPerPixel) !== expected.pixels.samples || !stored || stored.length < length || stored.length > length + 1
        || digest(stored.subarray(0, length)) !== expected.pixels.sha256) return '실린 그림의 화소가 올린 파일과 다릅니다';
  }
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