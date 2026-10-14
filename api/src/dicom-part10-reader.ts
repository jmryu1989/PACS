/*
 * The minimal DICOM Part-10 reader of the self-institution import (S9-U4p contract §4.1, U4P-05, D1172).
 *
 * AGENTS forbids an unrequested dependency, so the import gate reads uploaded files with this pure function instead
 * of a DICOM library. It interprets only the File Meta group and the named top-level header tags of §4.1 step 6; it
 * never decodes, transcodes or rewrites pixel data and never alters the input bytes (the stored original is the
 * uploaded original). Every length read from the file is checked against the bytes that remain before it is used, so
 * a hostile or truncated file costs at most one pass over its own bytes and is answered with a per-file refusal code,
 * never an exception.
 */

export type DicomReaderRejectCode =
  | 'DICOM_NOT_PART10'
  | 'DICOM_FILE_META_MISSING'
  | 'DICOM_TRANSFER_SYNTAX_UNSUPPORTED'
  | 'DICOM_MALFORMED'
  | 'PATIENT_ID_UNREADABLE';

export type DicomDatasetSyntax = 'implicit-vr-little-endian' | 'explicit-vr-little-endian';
export type DicomPixelPolicy = 'native' | 'encapsulated';

export interface DicomTransferSyntaxRow {
  readonly uid: string;
  readonly name: string;
  readonly datasetSyntax: DicomDatasetSyntax;
  readonly pixelPolicy: DicomPixelPolicy;
}

/** Values are trimmed per §4.1 step 7; an absent tag is null. */
export interface DicomHeader {
  transferSyntaxUid: string;
  mediaStorageSopInstanceUid: string;
  sopClassUid: string;
  sopInstanceUid: string;
  modality: string | null;
  /** A mismatch signal only (§4.3); never an ownership fact. */
  institutionName: string | null;
  /** null when absent or when it cannot be decoded under the file's character set (then patientNameComparable is false). */
  patientName: string | null;
  /** '' when present but empty: the PATIENT_ID_MISSING decision belongs to the import gate (§4.2). */
  patientId: string | null;
  issuerOfPatientId: string | null;
  patientBirthDate: string | null;
  patientSex: string | null;
  studyInstanceUid: string;
  seriesInstanceUid: string;
  numberOfFrames: number | null;
  specificCharacterSet: string | null;
  /**
   * True only when patientName holds a non-empty value decoded under the default repertoire (SpecificCharacterSet
   * absent, empty or ISO_IR 6) or ISO_IR 192 (§4.1 step 8); any other character set makes the name not comparable.
   */
  patientNameComparable: boolean;
}

export interface DicomReadAccepted {
  ok: true;
  header: DicomHeader;
  datasetSyntax: DicomDatasetSyntax;
  pixelDataPresent: boolean;
  stats: { elements: number; maxDepth: number };
}

export interface DicomReadRejected {
  ok: false;
  code: DicomReaderRejectCode;
  message: string;
}

export type DicomReadResult = DicomReadAccepted | DicomReadRejected;

const row = (uid: string, name: string, datasetSyntax: DicomDatasetSyntax, pixelPolicy: DicomPixelPolicy): DicomTransferSyntaxRow =>
  Object.freeze({ uid, name, datasetSyntax, pixelPolicy });

/** D1172: the closed list. Deflated Explicit VR LE (whole-dataset deflate) and every other syntax stay outside. */
export const DICOM_TRANSFER_SYNTAX_ALLOW_LIST: readonly DicomTransferSyntaxRow[] = Object.freeze([
  row('1.2.840.10008.1.2', 'Implicit VR Little Endian', 'implicit-vr-little-endian', 'native'),
  row('1.2.840.10008.1.2.1', 'Explicit VR Little Endian', 'explicit-vr-little-endian', 'native'),
  row('1.2.840.10008.1.2.4.50', 'JPEG Baseline (Process 1)', 'explicit-vr-little-endian', 'encapsulated'),
  row('1.2.840.10008.1.2.4.57', 'JPEG Lossless, Non-Hierarchical (Process 14)', 'explicit-vr-little-endian', 'encapsulated'),
  row('1.2.840.10008.1.2.4.70', 'JPEG Lossless, Non-Hierarchical, First-Order Prediction (Process 14, Selection Value 1)',
    'explicit-vr-little-endian', 'encapsulated'),
  row('1.2.840.10008.1.2.4.80', 'JPEG-LS Lossless', 'explicit-vr-little-endian', 'encapsulated'),
  row('1.2.840.10008.1.2.4.81', 'JPEG-LS Lossy (Near-Lossless)', 'explicit-vr-little-endian', 'encapsulated'),
  row('1.2.840.10008.1.2.4.90', 'JPEG 2000 Lossless Only', 'explicit-vr-little-endian', 'encapsulated'),
  row('1.2.840.10008.1.2.4.91', 'JPEG 2000', 'explicit-vr-little-endian', 'encapsulated'),
  row('1.2.840.10008.1.2.5', 'RLE Lossless', 'explicit-vr-little-endian', 'encapsulated'),
]);

export const DICOM_READER_LIMITS = Object.freeze({
  /** Nesting of undefined-length sequences, VR UN item sequences included; 17 is refused. */
  maxSequenceDepth: 16,
  /** Dataset elements and sequence items walked (File Meta and pixel fragments excluded); 100,001 is refused. */
  maxElements: 100_000,
  /** Basic Offset Table plus fragment items of one encapsulated Pixel Data element; 100,001 is refused. */
  maxPixelItems: 100_000,
  maxUidLength: 64,
});

/** User-facing Korean text (AGENTS §4). No message carries a value read from the file. */
export const DICOM_READER_MESSAGES: Readonly<Record<DicomReaderRejectCode, string>> = Object.freeze({
  DICOM_NOT_PART10: 'DICOM 파일 형식이 아닙니다. 이 파일은 저장되지 않았습니다.',
  DICOM_FILE_META_MISSING: 'DICOM 파일 머리 정보에 필요한 항목이 없습니다. 이 파일은 저장되지 않았습니다.',
  DICOM_TRANSFER_SYNTAX_UNSUPPORTED: '지원하지 않는 DICOM 전송 구문입니다. 이 파일은 저장되지 않았습니다.',
  DICOM_MALFORMED: 'DICOM 파일 구조가 올바르지 않거나 파일이 잘렸습니다. 이 파일은 저장되지 않았습니다.',
  PATIENT_ID_UNREADABLE: '환자 ID를 읽을 수 없는 문자로 기록된 파일입니다. 이 파일은 저장되지 않았습니다.',
});

const UNDEFINED_LENGTH = 0xffffffff;
const ITEM = 0xfffee000;
const ITEM_DELIMITATION = 0xfffee00d;
const SEQUENCE_DELIMITATION = 0xfffee0dd;
const PIXEL_DATA = 0x7fe00010;
const TRANSFER_SYNTAX_UID = 0x00020010;
const MEDIA_STORAGE_SOP_INSTANCE_UID = 0x00020003;

// PS3.5 §7.1.2: these VRs carry 2 reserved bytes and a 4-byte length in Explicit VR; the rest a 2-byte length.
const LONG_LENGTH_VRS = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);
const SHORT_LENGTH_VRS = new Set([
  'AE', 'AS', 'AT', 'CS', 'DA', 'DS', 'DT', 'FD', 'FL', 'IS', 'LO', 'LT', 'PN', 'SH', 'SL', 'SS', 'ST', 'TM', 'UI', 'UL', 'US',
]);

type NamedKey =
  | 'specificCharacterSet' | 'sopClassUid' | 'sopInstanceUid' | 'modality' | 'institutionName' | 'patientName'
  | 'patientId' | 'issuerOfPatientId' | 'patientBirthDate' | 'patientSex' | 'studyInstanceUid' | 'seriesInstanceUid'
  | 'numberOfFrames';

/** §4.1 step 6: the only dataset values this reader looks at, and only at the top level. */
const NAMED_TAGS = new Map<number, { key: NamedKey; vr: string }>([
  [0x00080005, { key: 'specificCharacterSet', vr: 'CS' }],
  [0x00080016, { key: 'sopClassUid', vr: 'UI' }],
  [0x00080018, { key: 'sopInstanceUid', vr: 'UI' }],
  [0x00080060, { key: 'modality', vr: 'CS' }],
  [0x00080080, { key: 'institutionName', vr: 'LO' }],
  [0x00100010, { key: 'patientName', vr: 'PN' }],
  [0x00100020, { key: 'patientId', vr: 'LO' }],
  [0x00100021, { key: 'issuerOfPatientId', vr: 'LO' }],
  [0x00100030, { key: 'patientBirthDate', vr: 'DA' }],
  [0x00100040, { key: 'patientSex', vr: 'CS' }],
  [0x0020000d, { key: 'studyInstanceUid', vr: 'UI' }],
  [0x0020000e, { key: 'seriesInstanceUid', vr: 'UI' }],
  [0x00280008, { key: 'numberOfFrames', vr: 'IS' }],
]);

const UID_SYNTAX = /^[0-9]+(\.[0-9]+)*$/;
const INTEGER_STRING = /^[+-]?[0-9]{1,12}$/;

/** Internal refusal signal; readDicomPart10 turns it into a result and lets nothing else escape as a refusal. */
class Refusal {
  code: DicomReaderRejectCode;
  constructor(code: DicomReaderRejectCode) {
    this.code = code;
  }
}

interface Walk {
  bytes: Uint8Array;
  end: number;
  encapsulated: boolean;
  elements: number;
  maxDepth: number;
}

interface ElementHeader {
  tag: number;
  vr: string | null;
  length: number;
  valueStart: number;
}

type Range = [number, number];

const malformed = (): never => {
  throw new Refusal('DICOM_MALFORMED');
};

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const tagAt = (b: Uint8Array, o: number) => u16(b, o) * 0x10000 + u16(b, o + 2);

function need(w: Walk, pos: number, count: number) {
  if (count > w.end - pos) malformed();
}

function skip(w: Walk, start: number, length: number) {
  need(w, start, length);
  return start + length;
}

function countElement(w: Walk) {
  w.elements += 1;
  if (w.elements > DICOM_READER_LIMITS.maxElements) malformed();
}

/** One data element header. Item and delimitation tags have no VR in any syntax and are handled by the callers. */
function readHeader(w: Walk, pos: number, explicit: boolean): ElementHeader {
  const b = w.bytes;
  need(w, pos, 8);
  const tag = tagAt(b, pos);
  if (tag >>> 16 === 0xfffe) malformed();
  if (!explicit) return { tag, vr: null, length: u32(b, pos + 4), valueStart: pos + 8 };
  const vr = String.fromCharCode(b[pos + 4], b[pos + 5]);
  if (LONG_LENGTH_VRS.has(vr)) {
    need(w, pos, 12);
    return { tag, vr, length: u32(b, pos + 8), valueStart: pos + 12 };
  }
  if (SHORT_LENGTH_VRS.has(vr)) return { tag, vr, length: u16(b, pos + 6), valueStart: pos + 8 };
  return malformed();
}

/**
 * An undefined-length value inside the dataset. SQ items keep the dataset's VR encoding; a VR UN element of undefined
 * length is an item sequence encoded in Implicit VR Little Endian whatever the dataset syntax (PS3.5 §6.2.2), so its
 * contents are skipped as Implicit VR LE under the same depth and element bounds and never interpreted.
 */
function undefinedLengthValue(w: Walk, h: ElementHeader, explicit: boolean, depth: number): number {
  if (!explicit) {
    if (h.tag === PIXEL_DATA) malformed();
    return sequence(w, h.valueStart, false, depth);
  }
  if (h.vr === 'SQ') return sequence(w, h.valueStart, true, depth);
  if (h.vr === 'UN') return sequence(w, h.valueStart, false, depth);
  // A nested encapsulated Pixel Data (an Icon Image Sequence item under a compressed syntax): same bounded checks.
  if (h.tag === PIXEL_DATA && h.vr === 'OB' && w.encapsulated) return fragments(w, h.valueStart, true);
  return malformed();
}

function sequence(w: Walk, pos: number, explicit: boolean, depth: number): number {
  if (depth > DICOM_READER_LIMITS.maxSequenceDepth) malformed();
  if (depth > w.maxDepth) w.maxDepth = depth;
  const b = w.bytes;
  for (;;) {
    need(w, pos, 8);
    const tag = tagAt(b, pos);
    const length = u32(b, pos + 4);
    if (tag === SEQUENCE_DELIMITATION) {
      if (length !== 0) malformed();
      return pos + 8;
    }
    if (tag !== ITEM) malformed();
    countElement(w);
    pos = length === UNDEFINED_LENGTH ? item(w, pos + 8, explicit, depth) : skip(w, pos + 8, length);
  }
}

function item(w: Walk, pos: number, explicit: boolean, depth: number): number {
  const b = w.bytes;
  for (;;) {
    need(w, pos, 8);
    if (tagAt(b, pos) === ITEM_DELIMITATION) {
      if (u32(b, pos + 4) !== 0) malformed();
      return pos + 8;
    }
    const h = readHeader(w, pos, explicit);
    countElement(w);
    pos = h.length === UNDEFINED_LENGTH ? undefinedLengthValue(w, h, explicit, depth + 1) : skip(w, h.valueStart, h.length);
  }
}

/**
 * Encapsulated Pixel Data (PS3.5 A.4), checked by length only: Basic Offset Table item (multiple of 4, 0 allowed),
 * then at least one fragment item (even, at least 2 bytes), then a zero-length Sequence Delimitation. Each item is
 * skipped by its declared length; the payload is never searched for delimiter bytes, decoded or checked against a codec.
 */
function fragments(w: Walk, pos: number, nested: boolean): number {
  const b = w.bytes;
  let items = 0;
  for (;;) {
    need(w, pos, 8);
    const tag = tagAt(b, pos);
    const length = u32(b, pos + 4);
    if (tag === SEQUENCE_DELIMITATION) {
      if (length !== 0 || items < 2) malformed();
      return pos + 8;
    }
    if (tag !== ITEM || length === UNDEFINED_LENGTH || length % 2 !== 0) malformed();
    if (items === 0 ? length % 4 !== 0 : length < 2) malformed();
    items += 1;
    if (items > DICOM_READER_LIMITS.maxPixelItems) malformed();
    if (nested) countElement(w);
    pos = skip(w, pos + 8, length);
  }
}

/** Top-level Pixel Data: semantic reading stops here; everything after it stays opaque original bytes. */
function pixelData(w: Walk, h: ElementHeader, explicit: boolean): number {
  if (!w.encapsulated) {
    if (h.length === UNDEFINED_LENGTH) malformed();
    if (explicit && h.vr !== 'OB' && h.vr !== 'OW') malformed();
    return skip(w, h.valueStart, h.length);
  }
  if (h.vr !== 'OB' || h.length !== UNDEFINED_LENGTH) malformed();
  return fragments(w, h.valueStart, false);
}

function namedVrMatches(found: string | null, expected: string) {
  // Implicit VR carries no VR; Explicit VR may say UN for a tag whose VR the writer did not know (PS3.5 §6.2.2).
  return found === null || found === expected || found === 'UN';
}

function readDataset(w: Walk, start: number, explicit: boolean, lastMetaTag: number, named: Map<NamedKey, Range>) {
  let pos = start;
  let last = lastMetaTag;
  while (pos < w.end) {
    const h = readHeader(w, pos, explicit);
    if (h.tag <= last) malformed();
    last = h.tag;
    countElement(w);
    if (h.tag === PIXEL_DATA) {
      pixelData(w, h, explicit);
      return true;
    }
    const spec = NAMED_TAGS.get(h.tag);
    if (h.length === UNDEFINED_LENGTH) {
      if (spec) malformed();
      pos = undefinedLengthValue(w, h, explicit, 1);
      continue;
    }
    const end = skip(w, h.valueStart, h.length);
    if (spec) {
      if (!namedVrMatches(h.vr, spec.vr)) malformed();
      named.set(spec.key, [h.valueStart, end]);
    }
    pos = end;
  }
  if (w.encapsulated) malformed();
  return false;
}

function readFileMeta(w: Walk) {
  const b = w.bytes;
  let pos = 132;
  let last = -1;
  let transferSyntax: Range | null = null;
  let sopInstance: Range | null = null;
  while (w.end - pos >= 2 && u16(b, pos) === 0x0002) {
    const h = readHeader(w, pos, true);
    if (h.tag <= last || h.length === UNDEFINED_LENGTH) malformed();
    last = h.tag;
    const end = skip(w, h.valueStart, h.length);
    if (h.tag === TRANSFER_SYNTAX_UID || h.tag === MEDIA_STORAGE_SOP_INSTANCE_UID) {
      if (!namedVrMatches(h.vr, 'UI')) malformed();
      if (h.tag === TRANSFER_SYNTAX_UID) transferSyntax = [h.valueStart, end];
      else sopInstance = [h.valueStart, end];
    }
    pos = end;
  }
  return { datasetStart: pos, lastTag: last, transferSyntax, sopInstance };
}

const isPadding = (byte: number) => byte === 0x20 || byte === 0x00;

/**
 * §4.1 step 7: trailing padding always goes (space; NUL for UI, and a trailing NUL some writers leave on text values,
 * which the stored-file readers also drop); leading spaces only where the VR allows them (LO, PN, CS and IS).
 */
function trimmed(b: Uint8Array, [start, end]: Range, leading: boolean): Range {
  while (end > start && isPadding(b[end - 1])) end -= 1;
  if (leading) while (start < end && b[start] === 0x20) start += 1;
  return [start, end];
}

const latin1 = (b: Uint8Array, [start, end]: Range) => Buffer.from(b.buffer, b.byteOffset + start, end - start).toString('latin1');

function printableAscii(b: Uint8Array, [start, end]: Range) {
  for (let i = start; i < end; i += 1) if (b[i] < 0x20 || b[i] > 0x7e) return false;
  return true;
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// C0 and C1 controls and DEL have no place in a name or identifier.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

function utf8Text(b: Uint8Array, [start, end]: Range): string | null {
  let text: string;
  try {
    text = utf8.decode(b.subarray(start, end));
  } catch {
    return null;
  }
  return CONTROL_CHARACTER.test(text) ? null : text;
}

type CharacterRepertoire = 'ascii' | 'utf-8' | 'other';

function repertoire(specificCharacterSet: string | null): CharacterRepertoire {
  if (specificCharacterSet === null || specificCharacterSet === '' || specificCharacterSet === 'ISO_IR 6') return 'ascii';
  if (specificCharacterSet === 'ISO_IR 192') return 'utf-8';
  return 'other';
}

/** Decoded text, or null when the bytes are not readable under the declared repertoire. */
function decoded(b: Uint8Array, range: Range, chars: CharacterRepertoire): string | null {
  if (chars === 'utf-8') return utf8Text(b, range);
  return printableAscii(b, range) ? latin1(b, range) : null;
}

/**
 * A LO value that cannot be decoded keeps its bytes as a one-to-one (latin1) string instead of becoming null, so an
 * unreadable IssuerOfPatientID is never mistaken for an absent one (§4.2 then refuses it as matching no institution).
 */
function textValue(b: Uint8Array, range: Range, chars: CharacterRepertoire) {
  return decoded(b, range, chars) ?? latin1(b, range);
}

function uid(b: Uint8Array, range: Range | undefined): string {
  if (!range) return malformed();
  const value = latin1(b, trimmed(b, range, false));
  if (value.length > DICOM_READER_LIMITS.maxUidLength || !UID_SYNTAX.test(value)) malformed();
  return value;
}

function headerFrom(b: Uint8Array, named: Map<NamedKey, Range>, transferSyntaxUid: string, mediaStorageSopInstanceUid: string): DicomHeader {
  const range = (key: NamedKey, leading: boolean) => {
    const found = named.get(key);
    return found ? trimmed(b, found, leading) : null;
  };
  const characterSetRange = range('specificCharacterSet', true);
  const specificCharacterSet = characterSetRange ? latin1(b, characterSetRange) : null;
  const chars = repertoire(specificCharacterSet);

  const sopClassUid = uid(b, named.get('sopClassUid'));
  const sopInstanceUid = uid(b, named.get('sopInstanceUid'));
  const studyInstanceUid = uid(b, named.get('studyInstanceUid'));
  const seriesInstanceUid = uid(b, named.get('seriesInstanceUid'));
  if (sopInstanceUid !== mediaStorageSopInstanceUid) malformed();

  let numberOfFrames: number | null = null;
  const framesRange = range('numberOfFrames', true);
  if (framesRange && framesRange[1] > framesRange[0]) {
    const text = latin1(b, framesRange);
    if (!INTEGER_STRING.test(text)) malformed();
    numberOfFrames = Number(text);
  }

  let patientId: string | null = null;
  const patientIdRange = range('patientId', true);
  if (patientIdRange) {
    patientId = chars === 'utf-8' ? utf8Text(b, patientIdRange) : printableAscii(b, patientIdRange) ? latin1(b, patientIdRange) : null;
    if (patientId === null) throw new Refusal('PATIENT_ID_UNREADABLE');
  }

  let patientName: string | null = null;
  const patientNameRange = range('patientName', true);
  if (patientNameRange && chars !== 'other') patientName = decoded(b, patientNameRange, chars);

  const plain = (key: NamedKey, leading: boolean) => {
    const found = range(key, leading);
    return found ? latin1(b, found) : null;
  };
  const lo = (key: NamedKey) => {
    const found = range(key, true);
    return found ? textValue(b, found, chars) : null;
  };

  return {
    transferSyntaxUid,
    mediaStorageSopInstanceUid,
    sopClassUid,
    sopInstanceUid,
    modality: plain('modality', true),
    institutionName: lo('institutionName'),
    patientName,
    patientId,
    issuerOfPatientId: lo('issuerOfPatientId'),
    patientBirthDate: plain('patientBirthDate', false),
    patientSex: plain('patientSex', true),
    studyInstanceUid,
    seriesInstanceUid,
    numberOfFrames,
    specificCharacterSet,
    patientNameComparable: patientName !== null && patientName !== '',
  };
}

const refused = (code: DicomReaderRejectCode): DicomReadRejected => ({ ok: false, code, message: DICOM_READER_MESSAGES[code] });

/**
 * Reads one uploaded Part-10 object. Pure: no IO, no clock, the input is never modified. Refusal order follows §4.1:
 * preamble/DICM, File Meta, transfer syntax, structure and header values, then PatientID readability.
 */
export function readDicomPart10(input: Uint8Array): DicomReadResult {
  if (!(input instanceof Uint8Array)) return refused('DICOM_NOT_PART10');
  const b = input;
  if (b.length < 132 || b[128] !== 0x44 || b[129] !== 0x49 || b[130] !== 0x43 || b[131] !== 0x4d) return refused('DICOM_NOT_PART10');
  const w: Walk = { bytes: b, end: b.length, encapsulated: false, elements: 0, maxDepth: 0 };
  try {
    const meta = readFileMeta(w);
    const transferSyntaxUid = meta.transferSyntax ? latin1(b, trimmed(b, meta.transferSyntax, false)) : '';
    const mediaStorageSopInstanceUid = meta.sopInstance ? latin1(b, trimmed(b, meta.sopInstance, false)) : '';
    if (transferSyntaxUid === '' || mediaStorageSopInstanceUid === '') return refused('DICOM_FILE_META_MISSING');
    const syntax = DICOM_TRANSFER_SYNTAX_ALLOW_LIST.find(candidate => candidate.uid === transferSyntaxUid);
    if (!syntax) return refused('DICOM_TRANSFER_SYNTAX_UNSUPPORTED');
    w.encapsulated = syntax.pixelPolicy === 'encapsulated';
    const explicit = syntax.datasetSyntax === 'explicit-vr-little-endian';
    const named = new Map<NamedKey, Range>();
    const pixelDataPresent = readDataset(w, meta.datasetStart, explicit, meta.lastTag, named);
    const header = headerFrom(b, named, transferSyntaxUid, mediaStorageSopInstanceUid);
    return { ok: true, header, datasetSyntax: syntax.datasetSyntax, pixelDataPresent, stats: { elements: w.elements, maxDepth: w.maxDepth } };
  } catch (error) {
    if (error instanceof Refusal) return refused(error.code);
    throw error;
  }
}
