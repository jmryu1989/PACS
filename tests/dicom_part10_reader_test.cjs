'use strict';
/* TEST-S9-U4-04 (pure part): the minimal DICOM Part-10 reader, api/src/dicom-part10-reader.ts.
 * REQ-S9-U4-04 -> RISK-S9-U4-04; contract S9-U4p §4.1 (D1172 allow-list, PS3.5 §6.2.2 VR UN rule), §4.7 as data, §8.
 *
 * Every vector is built in this file from the PS3.5 / PS3.10 encodings (no external file, no patient data), and every
 * expected value is what the vector wrote. Assertions bind to the contract: the refusal code, the contract's Korean
 * sentence for an unsupported transfer syntax, Korean text for the other refusals, the header values, and that the
 * input bytes are unchanged. Nothing here reads the reader's source text or its internal names (D73).
 *
 * Module: KIN_DICOM_READER_MODULE, default the compiled /app/dist/dicom-part10-reader (kin-api:ci). A path ending in
 * .ts loads the source through Node type stripping (Node >= 22.18); the module imports nothing outside Node.
 * The live acceptance of REQ-S9-U4-04 (proxy, API, Orthanc) is not this file; this is the reader alone.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MODULE = process.env.KIN_DICOM_READER_MODULE || '/app/dist/dicom-part10-reader';
const TARGET = path.isAbsolute(MODULE) ? MODULE : path.resolve(__dirname, '..', MODULE);
if (TARGET.endsWith('.ts') && !process.features.typescript) throw new Error('loading the .ts source needs Node type stripping (Node >= 22.18)');
const { readDicomPart10 } = require(TARGET);

// Contract §4.1 step 3 table (D1172), copied here as the oracle.
const IMPLICIT = '1.2.840.10008.1.2';
const EXPLICIT = '1.2.840.10008.1.2.1';
const JPEG_BASELINE = '1.2.840.10008.1.2.4.50';
const ALLOW_LIST = [
  { uid: IMPLICIT, name: 'Implicit VR Little Endian', implicit: true, encapsulated: false },
  { uid: EXPLICIT, name: 'Explicit VR Little Endian', implicit: false, encapsulated: false },
  { uid: JPEG_BASELINE, name: 'JPEG Baseline (Process 1)', implicit: false, encapsulated: true },
  { uid: '1.2.840.10008.1.2.4.57', name: 'JPEG Lossless, Non-Hierarchical (Process 14)', implicit: false, encapsulated: true },
  { uid: '1.2.840.10008.1.2.4.70', name: 'JPEG Lossless, First-Order Prediction (Process 14, SV1)', implicit: false, encapsulated: true },
  { uid: '1.2.840.10008.1.2.4.80', name: 'JPEG-LS Lossless', implicit: false, encapsulated: true },
  { uid: '1.2.840.10008.1.2.4.81', name: 'JPEG-LS Lossy (Near-Lossless)', implicit: false, encapsulated: true },
  { uid: '1.2.840.10008.1.2.4.90', name: 'JPEG 2000 Lossless Only', implicit: false, encapsulated: true },
  { uid: '1.2.840.10008.1.2.4.91', name: 'JPEG 2000', implicit: false, encapsulated: true },
  { uid: '1.2.840.10008.1.2.5', name: 'RLE Lossless', implicit: false, encapsulated: true },
];
const UNSUPPORTED_MESSAGE = '지원하지 않는 DICOM 전송 구문입니다. 이 파일은 저장되지 않았습니다.';
const CODES = ['DICOM_NOT_PART10', 'DICOM_FILE_META_MISSING', 'DICOM_TRANSFER_SYNTAX_UNSUPPORTED', 'DICOM_MALFORMED', 'PATIENT_ID_UNREADABLE'];
const HANGUL = /[가-힣]/;

// ---- PS3.5 encoders --------------------------------------------------------------------------------------------
const UNDEF = 0xffffffff;
const LONG_VRS = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);
const le16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const le32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const tag = (g, e) => Buffer.concat([le16(g), le16(e)]);
const even = (b, pad) => (b.length % 2 ? Buffer.concat([b, Buffer.from([pad])]) : b);
const txt = s => even(Buffer.from(s, 'latin1'), 0x20);
const utf8 = s => even(Buffer.from(s, 'utf8'), 0x20);
const ui = s => even(Buffer.from(s, 'latin1'), 0x00);
/** One data element: Explicit VR LE (PS3.5 7.1.2) or Implicit VR LE (7.1.3); `length` overrides the value length. */
function el(explicit, g, e, vr, value = Buffer.alloc(0), length = value.length) {
  if (!explicit) return Buffer.concat([tag(g, e), le32(length), value]);
  if (LONG_VRS.has(vr)) return Buffer.concat([tag(g, e), Buffer.from(vr, 'latin1'), Buffer.alloc(2), le32(length), value]);
  return Buffer.concat([tag(g, e), Buffer.from(vr, 'latin1'), le16(length), value]);
}
const imp = (g, e, value, length) => el(false, g, e, null, value, length);
const item = (content, length = content.length) => Buffer.concat([tag(0xfffe, 0xe000), le32(length), content]);
const itemDelimitation = () => Buffer.concat([tag(0xfffe, 0xe00d), le32(0)]);
const undefinedItem = content => Buffer.concat([tag(0xfffe, 0xe000), le32(UNDEF), content, itemDelimitation()]);
const sequenceDelimitation = (length = 0) => Buffer.concat([tag(0xfffe, 0xe0dd), le32(length)]);
/** An undefined-length sequence element (SQ, or UN when explicit) followed by its items and delimitation. */
const sequence = (explicit, g, e, vr, items, delimiter = true) =>
  Buffer.concat([el(explicit, g, e, vr, Buffer.alloc(0), UNDEF), ...items, ...(delimiter ? [sequenceDelimitation()] : [])]);

// ---- synthetic Part-10 files -----------------------------------------------------------------------------------
const SOP = '2.25.4001';
const SOP_CLASS = '1.2.840.10008.5.1.4.1.1.2';
const STUDY = '2.25.4002';
const SERIES = '2.25.4003';
const BASE = {
  charset: null, sopClass: SOP_CLASS, sop: SOP, modality: 'CT', institution: 'SYNTHETIC HOSPITAL', name: 'SYNTHETIC^PATIENT',
  id: 'SYN-0001', issuer: 'KINLAB', birth: '19700101', sex: 'O', study: STUDY, series: SERIES, frames: null,
};
const NAMED = [
  ['charset', 0x0008, 0x0005, 'CS', txt], ['sopClass', 0x0008, 0x0016, 'UI', ui], ['sop', 0x0008, 0x0018, 'UI', ui],
  ['modality', 0x0008, 0x0060, 'CS', txt], ['institution', 0x0008, 0x0080, 'LO', txt], ['name', 0x0010, 0x0010, 'PN', txt],
  ['id', 0x0010, 0x0020, 'LO', txt], ['issuer', 0x0010, 0x0021, 'LO', txt], ['birth', 0x0010, 0x0030, 'DA', txt],
  ['sex', 0x0010, 0x0040, 'CS', txt], ['study', 0x0020, 0x000d, 'UI', ui], ['series', 0x0020, 0x000e, 'UI', ui],
  ['frames', 0x0028, 0x0008, 'IS', txt],
];

function fileMeta({ ts = EXPLICIT, sop = SOP, drop = [], extra = [] } = {}) {
  const elements = [
    [0x0001, el(true, 2, 0x0001, 'OB', Buffer.from([0, 1]))],
    [0x0002, el(true, 2, 0x0002, 'UI', ui(SOP_CLASS))],
    [0x0003, el(true, 2, 0x0003, 'UI', Buffer.isBuffer(sop) ? sop : ui(sop))],
    [0x0010, el(true, 2, 0x0010, 'UI', Buffer.isBuffer(ts) ? ts : ui(ts))],
    [0x0012, el(true, 2, 0x0012, 'UI', ui('2.25.77'))],
    ...extra,
  ].filter(([element]) => !drop.includes(element)).sort((a, b) => a[0] - b[0]).map(([, bytes]) => bytes);
  const body = Buffer.concat(elements);
  return Buffer.concat([el(true, 2, 0x0000, 'UL', le32(body.length)), body]);
}

/**
 * A Part-10 file: 128-byte preamble, DICM, File Meta, the named header elements (values from BASE unless given; null
 * omits one), extra top-level elements ({t, bytes}), then Pixel Data and trailing bytes. `boundaries` are the offsets
 * where a top-level dataset element ends.
 */
function dicomFile(o = {}) {
  const ts = o.ts ?? EXPLICIT;
  const explicit = o.explicit ?? ts !== IMPLICIT;
  const values = { ...BASE, ...o.values };
  const parts = [];
  for (const [key, g, e, vr, encode] of NAMED) {
    const value = values[key];
    if (value === null || value === undefined) continue;
    parts.push({ t: g * 0x10000 + e, bytes: el(explicit, g, e, o.vrs?.[key] ?? vr, Buffer.isBuffer(value) ? value : encode(value)) });
  }
  parts.push(...(o.extra ?? []));
  if (!o.keepOrder) parts.sort((a, b) => a.t - b.t);
  if (o.pixel) parts.push({ t: 0x7fe00010, bytes: o.pixel });
  const head = Buffer.concat([o.preamble ?? Buffer.alloc(128), Buffer.from(o.magic ?? 'DICM', 'latin1'), o.meta ?? fileMeta({ ts, ...o.metaOptions })]);
  const boundaries = [];
  let at = head.length;
  for (const p of parts) boundaries.push((at += p.bytes.length));
  return { bytes: Buffer.concat([head, ...parts.map(p => p.bytes), o.trailing ?? Buffer.alloc(0)]), boundaries, datasetStart: head.length };
}

const nativePixel = (explicit, size = 16) => el(explicit, 0x7fe0, 0x0010, 'OW', Buffer.alloc(size, 0x5a));
/** Encapsulated Pixel Data (PS3.5 A.4): OB, undefined length, Basic Offset Table item, fragment items, delimitation. */
function encapsulatedPixel({ bot = Buffer.alloc(0), fragments = [Buffer.alloc(10, 0xab)], items, delimiter = true, vr = 'OB', length = UNDEF } = {}) {
  const body = items ?? [item(bot), ...fragments.map(f => item(f))];
  return Buffer.concat([el(true, 0x7fe0, 0x0010, vr, Buffer.alloc(0), length), ...body, ...(delimiter ? [sequenceDelimitation()] : [])]);
}
const pixelFor = row => (row.encapsulated ? encapsulatedPixel({ bot: le32(0), fragments: [Buffer.alloc(12, 0x11)] }) : nativePixel(!row.implicit));

function expectedHeader(ts, over = {}) {
  return {
    transferSyntaxUid: ts, mediaStorageSopInstanceUid: SOP, sopClassUid: SOP_CLASS, sopInstanceUid: SOP, modality: 'CT',
    institutionName: 'SYNTHETIC HOSPITAL', patientName: 'SYNTHETIC^PATIENT', patientId: 'SYN-0001', issuerOfPatientId: 'KINLAB',
    patientBirthDate: '19700101', patientSex: 'O', studyInstanceUid: STUDY, seriesInstanceUid: SERIES, numberOfFrames: null,
    specificCharacterSet: null, patientNameComparable: true, ...over,
  };
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** Reads and proves the reader left the input bytes exactly as they were. */
function read(bytes) {
  const before = sha256(bytes);
  const copy = Buffer.from(bytes);
  const result = readDicomPart10(bytes);
  assert.equal(sha256(bytes), before, 'the reader must not alter the input bytes');
  assert.ok(copy.equals(bytes));
  return result;
}
function accepted(bytes) {
  const result = read(bytes);
  assert.equal(result.ok, true, `expected acceptance, got ${result.code}`);
  return result;
}
function refused(bytes, code) {
  const result = read(bytes);
  assert.equal(result.ok, false, `expected ${code}, got an acceptance`);
  assert.equal(result.code, code);
  assert.match(result.message, HANGUL, 'refusal text is Korean (AGENTS §4)');
  return result;
}

// ---- VR UN (PS3.5 §6.2.2) vectors --------------------------------------------------------------------------------
const PRIVATE_CREATOR = { t: 0x00090010, bytes: el(true, 0x0009, 0x0010, 'LO', txt('KIN SYNTHETIC')) };
/** Implicit VR LE nesting: `levels` undefined-length sequences around `innermost`. */
function implicitChain(levels, innermost) {
  let content = innermost;
  for (let i = 0; i < levels; i += 1) content = Buffer.concat([imp(0x0009, 0x1012, Buffer.alloc(0), UNDEF), undefinedItem(content), sequenceDelimitation()]);
  return content;
}
/** Items of a private UN value, Implicit VR LE inside, with named-tag look-alikes the reader must not take. */
function unItems() {
  const nested = Buffer.concat([imp(0x0009, 0x1011, Buffer.alloc(0), UNDEF), undefinedItem(imp(0x0010, 0x0010, txt('NESTED^NAME'))), sequenceDelimitation()]);
  return [
    undefinedItem(Buffer.concat([imp(0x0010, 0x0020, txt('NESTED-ID')), imp(0x0008, 0x0018, ui('2.25.999')), nested])),
    item(imp(0x0010, 0x0020, txt('NESTED-2'))),
  ];
}
const unElement = (items, delimiter = true) => ({ t: 0x00091010, bytes: sequence(true, 0x0009, 0x1010, 'UN', items, delimiter) });

// =================================================================================================================

test('R-ALLOW: each of the ten D1172 allow-list syntaxes is accepted, read in its dataset encoding, bytes unchanged', () => {
  for (const row of ALLOW_LIST) {
    const { bytes } = dicomFile({ ts: row.uid, pixel: pixelFor(row), trailing: Buffer.from([0xfc, 0xff, 0xfc, 0xff, 0x04, 0, 0, 0, 1, 2, 3, 4]) });
    const before = sha256(bytes);
    const result = accepted(bytes);
    assert.equal(sha256(bytes), before, row.name);
    assert.deepEqual(result.header, expectedHeader(row.uid), row.name);
    assert.equal(result.datasetSyntax, row.implicit ? 'implicit-vr-little-endian' : 'explicit-vr-little-endian', row.name);
    assert.equal(result.pixelDataPresent, true, row.name);
  }
});

test('R-ALLOW-HEADER: a dataset encoded other than its row says is refused (the dataset_header column is honoured)', () => {
  refused(dicomFile({ ts: IMPLICIT, explicit: true, pixel: nativePixel(true) }).bytes, 'DICOM_MALFORMED');
  refused(dicomFile({ ts: EXPLICIT, explicit: false, pixel: nativePixel(false) }).bytes, 'DICOM_MALFORMED');
  refused(dicomFile({ ts: JPEG_BASELINE, explicit: false, pixel: encapsulatedPixel() }).bytes, 'DICOM_MALFORMED');
});

test('R-NAMED: every named header tag is read in Implicit VR LE and in Explicit VR LE', () => {
  const values = {
    charset: 'ISO_IR 192', sopClass: '1.2.840.10008.5.1.4.1.1.4', sop: '2.25.5001', modality: 'MR', institution: utf8('시험 병원'),
    name: utf8('홍^길동'), id: 'SYN-0002', issuer: 'KINLAB-2', birth: '19800202', sex: 'F', study: '2.25.5002', series: '2.25.5003', frames: '3',
  };
  for (const ts of [IMPLICIT, EXPLICIT]) {
    const result = accepted(dicomFile({ ts, values, metaOptions: { sop: '2.25.5001' }, pixel: nativePixel(ts === EXPLICIT) }).bytes);
    assert.deepEqual(result.header, {
      transferSyntaxUid: ts, mediaStorageSopInstanceUid: '2.25.5001', sopClassUid: '1.2.840.10008.5.1.4.1.1.4', sopInstanceUid: '2.25.5001',
      modality: 'MR', institutionName: '시험 병원', patientName: '홍^길동', patientId: 'SYN-0002', issuerOfPatientId: 'KINLAB-2',
      patientBirthDate: '19800202', patientSex: 'F', studyInstanceUid: '2.25.5002', seriesInstanceUid: '2.25.5003', numberOfFrames: 3,
      specificCharacterSet: 'ISO_IR 192', patientNameComparable: true,
    }, ts);
  }
  // Optional tags absent are null; SR-like objects without Pixel Data are accepted under the native syntaxes.
  for (const ts of [IMPLICIT, EXPLICIT]) {
    const result = accepted(dicomFile({ ts, values: { modality: null, institution: null, name: null, id: null, issuer: null, birth: null, sex: null } }).bytes);
    assert.deepEqual(result.header, expectedHeader(ts, {
      modality: null, institutionName: null, patientName: null, patientId: null, issuerOfPatientId: null, patientBirthDate: null,
      patientSex: null, patientNameComparable: false,
    }));
    assert.equal(result.pixelDataPresent, false);
  }
});

test('R-SYNTAX-REFUSED: Deflated, Big Endian, private, unlisted and near-miss syntaxes are refused per file', () => {
  const outside = [
    '1.2.840.10008.1.2.1.99', // Deflated Explicit VR Little Endian (whole-dataset deflate)
    '1.2.840.10008.1.2.2', // Explicit VR Big Endian
    '1.2.276.0.7230010.3.1.4.2831176407.11154.1448.1.1', // a private syntax
    '1.2.840.10008.1.2.4.51', '1.2.840.10008.1.2.4.100', '1.2.840.10008.1.2.4.201', '1.2.840.10008.1.2.4.92',
    '1.2.840.10008.1.2.10', '1.2.840.10008.1.2.4.5', '1.2.840.10008.1.2.4.500', '1.2.840.10008.1.2.4.50.1', '1.2.840.10008.1.2.1.0',
    '1.2.840.10008.1.2.', 'JPEG',
  ];
  for (const ts of outside) {
    const result = refused(dicomFile({ ts, explicit: true, pixel: encapsulatedPixel() }).bytes, 'DICOM_TRANSFER_SYNTAX_UNSUPPORTED');
    assert.equal(result.message, UNSUPPORTED_MESSAGE, ts);
  }
});

test('R-NOT-PART10: no preamble, no DICM, short or non-byte input is refused without throwing', () => {
  const good = dicomFile({ pixel: nativePixel(true) }).bytes;
  refused(good.subarray(128), 'DICOM_NOT_PART10'); // meta directly at offset 0
  refused(dicomFile({ magic: 'dicm', pixel: nativePixel(true) }).bytes, 'DICOM_NOT_PART10');
  refused(dicomFile({ magic: 'DICN', pixel: nativePixel(true) }).bytes, 'DICOM_NOT_PART10');
  for (const length of [0, 1, 128, 131]) refused(good.subarray(0, length), 'DICOM_NOT_PART10');
  for (const input of [null, undefined, 'DICM', 42, {}, [0x44, 0x49, 0x43, 0x4d], new ArrayBuffer(200)]) {
    const result = readDicomPart10(input);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DICOM_NOT_PART10');
  }
});

test('R-META: a missing or empty TransferSyntaxUID or MediaStorageSOPInstanceUID is DICOM_FILE_META_MISSING', () => {
  refused(dicomFile({ metaOptions: { drop: [0x0010] }, pixel: nativePixel(true) }).bytes, 'DICOM_FILE_META_MISSING');
  refused(dicomFile({ metaOptions: { drop: [0x0003] }, pixel: nativePixel(true) }).bytes, 'DICOM_FILE_META_MISSING');
  refused(dicomFile({ metaOptions: { ts: Buffer.alloc(0) }, pixel: nativePixel(true) }).bytes, 'DICOM_FILE_META_MISSING');
  refused(dicomFile({ metaOptions: { sop: Buffer.from('  ') }, pixel: nativePixel(true) }).bytes, 'DICOM_FILE_META_MISSING');
  refused(dicomFile({ meta: Buffer.alloc(0), pixel: nativePixel(true) }).bytes, 'DICOM_FILE_META_MISSING'); // no group 0002 at all
});

test('R-SOP: SOPInstanceUID must equal (0002,0003); the four dataset UIDs are required and must be valid UIDs', () => {
  refused(dicomFile({ values: { sop: '2.25.4009' }, pixel: nativePixel(true) }).bytes, 'DICOM_MALFORMED');
  refused(dicomFile({ metaOptions: { sop: '2.25.4009' }, pixel: nativePixel(true) }).bytes, 'DICOM_MALFORMED');
  for (const key of ['sop', 'sopClass', 'study', 'series']) refused(dicomFile({ values: { [key]: null }, pixel: nativePixel(true) }).bytes, 'DICOM_MALFORMED');
  for (const bad of ['2.25.4a', '.2.25', '2..25', '2.25.', '2.25 .1', `2.25.${'1'.repeat(60)}`, '']) {
    refused(dicomFile({ values: { study: bad }, pixel: nativePixel(true) }).bytes, 'DICOM_MALFORMED');
  }
  const sixtyFour = `2.25.${'7'.repeat(59)}`;
  assert.equal(sixtyFour.length, 64);
  const result = accepted(dicomFile({ values: { sop: sixtyFour, study: sixtyFour.replace(/7$/, '8') }, metaOptions: { sop: sixtyFour }, pixel: nativePixel(true) }).bytes);
  assert.equal(result.header.sopInstanceUid, sixtyFour);
  assert.equal(result.header.mediaStorageSopInstanceUid, sixtyFour);
});

test('R-ORDER: tag order violations and duplicates are refused at the top level and in File Meta', () => {
  const pixel = nativePixel(true);
  const name = { t: 0x00100010, bytes: el(true, 0x0010, 0x0010, 'PN', txt('SECOND^NAME')) };
  refused(dicomFile({ extra: [name], pixel }).bytes, 'DICOM_MALFORMED'); // duplicate (0010,0010)
  const swapped = dicomFile({ keepOrder: true, extra: [{ t: 0x00080020, bytes: el(true, 0x0008, 0x0020, 'DA', txt('20200101')) }], pixel });
  refused(swapped.bytes, 'DICOM_MALFORMED'); // (0008,0020) after (0020,000E)
  // A group 0000 element after File Meta, or a group 0002 element below the last File Meta tag.
  for (const [g, e] of [[0x0000, 0x0100], [0x0002, 0x0001]]) {
    refused(dicomFile({ extra: [{ t: -1, bytes: el(true, g, e, 'UL', le32(0)) }], pixel }).bytes, 'DICOM_MALFORMED');
  }
  const metaSwap = fileMeta({ extra: [[0x0011, el(true, 2, 0x0001, 'OB', Buffer.from([0, 1]))]] }); // (0002,0001) again after (0002,0010)
  refused(dicomFile({ meta: metaSwap, pixel }).bytes, 'DICOM_MALFORMED');
});

/** Explicit or implicit nesting of undefined-length SQ elements, `depth` deep, at the top-level tag (0040,A730). */
function sequenceChain(explicit, depth, leaf = el(explicit, 0x0010, 0x0020, 'LO', txt('NESTED-ID'))) {
  let content = leaf;
  for (let d = 0; d < depth; d += 1) content = sequence(explicit, 0x0040, 0xa730, 'SQ', [undefinedItem(content)]);
  return { t: 0x0040a730, bytes: content };
}

test('R-SQ: undefined-length sequences are skipped without reading named tags inside; depth 16 accepted, 17 refused', () => {
  for (const ts of [IMPLICIT, EXPLICIT, JPEG_BASELINE]) {
    const row = ALLOW_LIST.find(r => r.uid === ts);
    const explicit = !row.implicit;
    const shallow = accepted(dicomFile({ ts, extra: [sequenceChain(explicit, 3)], pixel: pixelFor(row) }).bytes);
    assert.deepEqual(shallow.header, expectedHeader(ts), ts);
    assert.equal(shallow.stats.maxDepth, 3);
    const deepest = accepted(dicomFile({ ts, extra: [sequenceChain(explicit, 16)], pixel: pixelFor(row) }).bytes);
    assert.equal(deepest.stats.maxDepth, 16, ts);
    assert.deepEqual(deepest.header, expectedHeader(ts), ts);
    refused(dicomFile({ ts, extra: [sequenceChain(explicit, 17)], pixel: pixelFor(row) }).bytes, 'DICOM_MALFORMED');
  }
  // A defined-length item is skipped by its length; a missing Sequence Delimitation or a stray tag is malformed.
  const definedItem = { t: 0x0040a730, bytes: sequence(true, 0x0040, 0xa730, 'SQ', [item(el(true, 0x0010, 0x0020, 'LO', txt('NESTED')))]) };
  assert.deepEqual(accepted(dicomFile({ extra: [definedItem], pixel: nativePixel(true) }).bytes).header, expectedHeader(EXPLICIT));
  const unterminated = { t: 0x0040a730, bytes: sequence(true, 0x0040, 0xa730, 'SQ', [undefinedItem(el(true, 0x0010, 0x0020, 'LO', txt('X ')))], false) };
  refused(dicomFile({ extra: [unterminated], pixel: nativePixel(true) }).bytes, 'DICOM_MALFORMED');
  const nonzeroDelimiter = { t: 0x0040a730, bytes: Buffer.concat([el(true, 0x0040, 0xa730, 'SQ', Buffer.alloc(0), UNDEF), sequenceDelimitation(4), le32(0)]) };
  refused(dicomFile({ extra: [nonzeroDelimiter], pixel: nativePixel(true) }).bytes, 'DICOM_MALFORMED');
  // An undefined length on a VR that cannot carry one is malformed.
  const undefinedLo = { t: 0x00091001, bytes: Buffer.concat([el(true, 0x0009, 0x1001, 'UT', Buffer.alloc(0), UNDEF), sequenceDelimitation()]) };
  refused(dicomFile({ extra: [undefinedLo], pixel: nativePixel(true) }).bytes, 'DICOM_MALFORMED');
});

test('R-COUNT: dataset elements plus sequence items are bounded at 100,000 (File Meta and pixel fragments excluded)', () => {
  const leaf = el(true, 0x0009, 0x1021, 'US', le16(1));
  const vector = nested => dicomFile({
    extra: [PRIVATE_CREATOR, { t: 0x00091020, bytes: sequence(true, 0x0009, 0x1020, 'SQ', [undefinedItem(Buffer.concat(new Array(nested).fill(leaf)))]) }],
    pixel: encapsulatedPixel(), ts: JPEG_BASELINE,
  });
  const probe = vector(1);
  const topLevel = probe.boundaries.length; // top-level elements of this vector, Pixel Data included
  const nestedForLimit = 100_000 - topLevel - 1; // minus the one item
  const atLimit = accepted(vector(nestedForLimit).bytes);
  assert.equal(atLimit.stats.elements, 100_000);
  refused(vector(nestedForLimit + 1).bytes, 'DICOM_MALFORMED');
});

test('R-UN-1: a private VR UN element of undefined length holds an Implicit VR LE item sequence; later named tags are read', () => {
  for (const ts of [EXPLICIT, JPEG_BASELINE]) {
    const row = ALLOW_LIST.find(r => r.uid === ts);
    const result = accepted(dicomFile({ ts, extra: [PRIVATE_CREATOR, unElement(unItems())], pixel: pixelFor(row) }).bytes);
    assert.deepEqual(result.header, expectedHeader(ts), ts);
    assert.equal(result.stats.maxDepth, 2, 'the UN sequence and the implicit sequence inside it');
  }
});

test('R-UN-2: a VR UN undefined-length element without its Sequence Delimitation is DICOM_MALFORMED', () => {
  refused(dicomFile({ extra: [PRIVATE_CREATOR, unElement(unItems(), false)], pixel: nativePixel(true) }).bytes, 'DICOM_MALFORMED');
  // ...also when the file simply ends inside the UN value.
  const { bytes } = dicomFile({ extra: [PRIVATE_CREATOR, unElement(unItems())], values: { name: null, id: null, issuer: null, birth: null, sex: null, study: null, series: null } });
  refused(bytes.subarray(0, bytes.length - 8), 'DICOM_MALFORMED');
});

test('R-UN-3: VR UN nesting deeper than 16 is DICOM_MALFORMED; exactly 16 is accepted', () => {
  const leaf = imp(0x0009, 0x1013, txt('LEAF'));
  const at16 = accepted(dicomFile({ extra: [PRIVATE_CREATOR, unElement([undefinedItem(implicitChain(15, leaf))])], pixel: nativePixel(true) }).bytes);
  assert.equal(at16.stats.maxDepth, 16);
  assert.deepEqual(at16.header, expectedHeader(EXPLICIT));
  refused(dicomFile({ extra: [PRIVATE_CREATOR, unElement([undefinedItem(implicitChain(16, leaf))])], pixel: nativePixel(true) }).bytes, 'DICOM_MALFORMED');
  // The UN items count toward the same 100,000 bound.
  const many = imp(0x0009, 0x1014, le16(1));
  const top = dicomFile({ extra: [PRIVATE_CREATOR, unElement([undefinedItem(many)])], pixel: nativePixel(true) }).boundaries.length;
  const fill = n => dicomFile({ extra: [PRIVATE_CREATOR, unElement([undefinedItem(Buffer.concat(new Array(n).fill(many)))])], pixel: nativePixel(true) }).bytes;
  assert.equal(accepted(fill(100_000 - top - 1)).stats.elements, 100_000);
  refused(fill(100_000 - top), 'DICOM_MALFORMED');
});

test('R-NATIVE-PIXEL: native Pixel Data must have a defined length within the file', () => {
  const undefinedNative = explicit => Buffer.concat([el(explicit, 0x7fe0, 0x0010, 'OW', Buffer.alloc(0), UNDEF), item(Buffer.alloc(4)), item(Buffer.alloc(8)), sequenceDelimitation()]);
  refused(dicomFile({ ts: EXPLICIT, pixel: undefinedNative(true) }).bytes, 'DICOM_MALFORMED');
  refused(dicomFile({ ts: IMPLICIT, pixel: undefinedNative(false) }).bytes, 'DICOM_MALFORMED');
  refused(dicomFile({ ts: EXPLICIT, pixel: el(true, 0x7fe0, 0x0010, 'OW', Buffer.alloc(8), 64) }).bytes, 'DICOM_MALFORMED');
  refused(dicomFile({ ts: IMPLICIT, pixel: imp(0x7fe0, 0x0010, Buffer.alloc(8), 64) }).bytes, 'DICOM_MALFORMED');
  // Native Pixel Data stays opaque: its bytes may look like anything.
  const opaque = Buffer.concat([tag(0xfffe, 0xe0dd), le32(0), Buffer.from('DICM'), Buffer.alloc(8, 0xff)]);
  assert.deepEqual(accepted(dicomFile({ ts: IMPLICIT, pixel: imp(0x7fe0, 0x0010, opaque) }).bytes).header, expectedHeader(IMPLICIT));
});

test('R-ENCAPSULATION: Basic Offset Table, fragments and delimitation are bounded by length and count only', () => {
  const file = pixel => dicomFile({ ts: JPEG_BASELINE, pixel }).bytes;
  accepted(file(encapsulatedPixel({ bot: Buffer.alloc(0) }))); // BOT 0
  accepted(file(encapsulatedPixel({ bot: Buffer.concat([le32(0), le32(12)]), fragments: [Buffer.alloc(4, 1), Buffer.alloc(4, 2)] }))); // BOT 8
  refused(file(encapsulatedPixel({ bot: Buffer.alloc(6) })), 'DICOM_MALFORMED'); // BOT not a multiple of 4
  refused(file(encapsulatedPixel({ bot: Buffer.alloc(2) })), 'DICOM_MALFORMED');
  accepted(file(encapsulatedPixel({ fragments: [Buffer.alloc(2, 7)] }))); // fragment minimum
  refused(file(encapsulatedPixel({ fragments: [Buffer.alloc(0)] })), 'DICOM_MALFORMED'); // fragment shorter than 2 bytes
  refused(file(encapsulatedPixel({ fragments: [Buffer.alloc(4), Buffer.alloc(0)] })), 'DICOM_MALFORMED');
  refused(file(encapsulatedPixel({ fragments: [Buffer.alloc(3, 7)] })), 'DICOM_MALFORMED'); // odd item length
  refused(file(encapsulatedPixel({ items: [item(Buffer.alloc(0)), item(Buffer.alloc(10), 1000)], delimiter: false })), 'DICOM_MALFORMED'); // beyond the bytes
  refused(file(encapsulatedPixel({ items: [item(Buffer.alloc(0), UNDEF), item(Buffer.alloc(10))] })), 'DICOM_MALFORMED'); // undefined item length
  refused(file(encapsulatedPixel({ fragments: [] })), 'DICOM_MALFORMED'); // no fragment at all
  refused(file(encapsulatedPixel({ delimiter: false })), 'DICOM_MALFORMED'); // file ends before the delimitation
  refused(file(Buffer.concat([encapsulatedPixel({ delimiter: false }), sequenceDelimitation(2), Buffer.alloc(2)])), 'DICOM_MALFORMED');
  refused(file(Buffer.concat([encapsulatedPixel({ delimiter: false }), item(Buffer.alloc(4)).fill(0x00, 0, 4)])), 'DICOM_MALFORMED'); // stray tag
  refused(file(encapsulatedPixel({ vr: 'OW' })), 'DICOM_MALFORMED');
  refused(file(el(true, 0x7fe0, 0x0010, 'OB', Buffer.alloc(16))), 'DICOM_MALFORMED'); // defined length under a compressed syntax
  refused(dicomFile({ ts: JPEG_BASELINE }).bytes, 'DICOM_MALFORMED'); // compressed syntax without Pixel Data
});

test('R-ENCAPSULATION-NO-SEARCH: items are skipped by length; delimiter bytes inside a fragment change nothing', () => {
  const fakeDelimiter = Buffer.concat([Buffer.alloc(6, 0x33), tag(0xfffe, 0xe0dd), le32(0), Buffer.alloc(4, 0x44)]);
  const result = accepted(dicomFile({ ts: JPEG_BASELINE, pixel: encapsulatedPixel({ fragments: [fakeDelimiter, Buffer.alloc(2, 9)] }) }).bytes);
  assert.deepEqual(result.header, expectedHeader(JPEG_BASELINE));
  // A fragment that claims more bytes than remain is refused even though a delimiter pattern follows inside it.
  const lying = Buffer.concat([item(Buffer.alloc(0)), tag(0xfffe, 0xe000), le32(4096), fakeDelimiter]);
  refused(dicomFile({ ts: JPEG_BASELINE, pixel: encapsulatedPixel({ items: [lying], delimiter: false }) }).bytes, 'DICOM_MALFORMED');
});

test('R-ENCAPSULATION-COUNT: 100,000 items (BOT included) are accepted, 100,001 refused', () => {
  const vector = count => dicomFile({ ts: JPEG_BASELINE, pixel: encapsulatedPixel({ fragments: new Array(count - 1).fill(Buffer.alloc(2, 5)) }) }).bytes;
  accepted(vector(100_000));
  refused(vector(100_001), 'DICOM_MALFORMED');
});

test('R-AFTER-PIXEL: bytes after Pixel Data stay opaque original bytes', () => {
  const garbage = Buffer.concat([el(true, 0x0008, 0x0018, 'UI', ui('2.25.1')), Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]), el(true, 0x0010, 0x0020, 'LO', Buffer.from([0xc8, 0xab]))]);
  for (const row of ALLOW_LIST) {
    const result = accepted(dicomFile({ ts: row.uid, pixel: pixelFor(row), trailing: garbage }).bytes);
    assert.deepEqual(result.header, expectedHeader(row.uid), row.name);
  }
});

test('R-ICON: a nested encapsulated Pixel Data (Icon Image Sequence) is checked, then the walk continues', () => {
  const icon = sub => ({ t: 0x00880200, bytes: sequence(true, 0x0088, 0x0200, 'SQ', [undefinedItem(sub)]) });
  const ok = accepted(dicomFile({ ts: JPEG_BASELINE, extra: [icon(encapsulatedPixel())], pixel: encapsulatedPixel() }).bytes);
  assert.deepEqual(ok.header, expectedHeader(JPEG_BASELINE));
  refused(dicomFile({ ts: JPEG_BASELINE, extra: [icon(encapsulatedPixel({ bot: Buffer.alloc(6) }))], pixel: encapsulatedPixel() }).bytes, 'DICOM_MALFORMED');
  refused(dicomFile({ ts: EXPLICIT, extra: [icon(encapsulatedPixel())], pixel: nativePixel(true) }).bytes, 'DICOM_MALFORMED');
});

test('R-VR: an unknown Explicit VR or a named tag in a binary VR is malformed; a named tag in UN or another text VR is read', () => {
  refused(dicomFile({ extra: [{ t: 0x00091001, bytes: Buffer.concat([tag(0x0009, 0x1001), Buffer.from('ZZ'), le16(2), Buffer.from('AB')]) }], pixel: nativePixel(true) }).bytes, 'DICOM_MALFORMED');
  refused(dicomFile({ extra: [{ t: 0x00091001, bytes: Buffer.concat([tag(0x0009, 0x1001), Buffer.from('ob'), le16(2), Buffer.from('AB')]) }], pixel: nativePixel(true) }).bytes, 'DICOM_MALFORMED');
  refused(dicomFile({ vrs: { id: 'US' }, pixel: nativePixel(true) }).bytes, 'DICOM_MALFORMED');
  refused(dicomFile({ vrs: { study: 'UL' }, pixel: nativePixel(true) }).bytes, 'DICOM_MALFORMED');
  refused(dicomFile({ vrs: { frames: 'FD' }, values: { frames: '1234' }, pixel: nativePixel(true) }).bytes, 'DICOM_MALFORMED');
  refused(dicomFile({ vrs: { sop: 'OB' }, pixel: nativePixel(true) }).bytes, 'DICOM_MALFORMED');
  const unNamed = accepted(dicomFile({ vrs: { id: 'UN', name: 'UN' }, pixel: nativePixel(true) }).bytes);
  assert.deepEqual(unNamed.header, expectedHeader(EXPLICIT));
  const otherText = accepted(dicomFile({ vrs: { id: 'SH', institution: 'SH', study: 'LO' }, pixel: nativePixel(true) }).bytes);
  assert.deepEqual(otherText.header, expectedHeader(EXPLICIT));
  // A named tag cannot be a sequence.
  const idAsSequence = dicomFile({ values: { id: null }, extra: [{ t: 0x00100020, bytes: sequence(true, 0x0010, 0x0020, 'UN', [undefinedItem(imp(0x0010, 0x0020, txt('X ')))]) }], pixel: nativePixel(true) });
  refused(idAsSequence.bytes, 'DICOM_MALFORMED');
});

test('R-CHARSET: PatientName is comparable only under no/ISO_IR 6/ISO_IR 192 and only when it decodes', () => {
  const euckr = Buffer.from([0x1b, 0x24, 0x29, 0x43, 0xc8, 0xab, 0x5e, 0xb1, 0xe6, 0xb5, 0xbf, 0x20]); // ESC $ ) C, '홍^길동' in KS X 1001
  const cases = [
    [{ charset: '\\ISO 2022 IR 149', name: euckr }, null, false],
    [{ charset: '\\ISO 2022 IR 149', name: 'ASCII^ONLY' }, null, false],
    [{ charset: 'ISO_IR 100', name: 'ASCII^ONLY' }, null, false],
    [{ charset: 'ISO_IR 192', name: utf8('홍^길동') }, '홍^길동', true],
    [{ charset: 'ISO_IR 192 ', name: utf8('홍^길동') }, '홍^길동', true],
    [{ charset: 'ISO_IR 6', name: 'ASCII^ONLY' }, 'ASCII^ONLY', true],
    [{ charset: null, name: 'ASCII^ONLY' }, 'ASCII^ONLY', true],
    [{ charset: null, name: Buffer.from([0x48, 0xc8, 0xab, 0x20]) }, null, false],
    [{ charset: 'ISO_IR 192', name: Buffer.from([0x48, 0xc3, 0x28, 0x20]) }, null, false], // invalid UTF-8
    [{ charset: 'ISO_IR 192', name: Buffer.from([0x48, 0x01]) }, null, false], // a control character
    [{ charset: null, name: '' }, '', false],
    [{ charset: null, name: null }, null, false],
  ];
  for (const [values, name, comparable] of cases) {
    const result = accepted(dicomFile({ values, pixel: nativePixel(true) }).bytes);
    assert.equal(result.header.patientName, name, JSON.stringify(values.charset));
    assert.equal(result.header.patientNameComparable, comparable, JSON.stringify(values.charset));
  }
  assert.equal(accepted(dicomFile({ values: { charset: '\\ISO 2022 IR 149' }, pixel: nativePixel(true) }).bytes).header.specificCharacterSet, '\\ISO 2022 IR 149');
  // An IssuerOfPatientID that cannot be decoded is never reported as absent.
  const issuer = accepted(dicomFile({ values: { charset: '\\ISO 2022 IR 149', issuer: euckr }, pixel: nativePixel(true) }).bytes).header.issuerOfPatientId;
  assert.notEqual(issuer, null);
  assert.notEqual(issuer, '');
});

test('R-PATIENT-ID: PatientID must read as printable ASCII (UTF-8 under ISO_IR 192); empty is read as empty', () => {
  const marker = 'MARKER-77';
  for (const values of [
    { id: Buffer.from([0x53, 0x59, 0x4e, 0xc8, 0xab, 0x31]) },
    { charset: '\\ISO 2022 IR 149', id: Buffer.from([0x1b, 0x24, 0x29, 0x43, 0xc8, 0xab]) },
    { charset: 'ISO_IR 192', id: Buffer.from([0x41, 0xc3, 0x28, 0x20]) },
    { id: Buffer.from([0x41, 0x01, 0x42, 0x20]) },
    { id: Buffer.concat([Buffer.from(marker, 'latin1'), Buffer.from([0x00, 0x41])]) },
    { charset: 'ISO_IR 100', id: Buffer.from([0x41, 0xe9]) },
  ]) {
    const result = refused(dicomFile({ values, pixel: nativePixel(true) }).bytes, 'PATIENT_ID_UNREADABLE');
    assert.ok(!result.message.includes(marker), 'the refusal text carries no value from the file');
  }
  assert.equal(accepted(dicomFile({ values: { charset: 'ISO_IR 192', id: utf8('환자-01') }, pixel: nativePixel(true) }).bytes).header.patientId, '환자-01');
  assert.equal(accepted(dicomFile({ values: { charset: '\\ISO 2022 IR 149', id: 'ASCII-01' }, pixel: nativePixel(true) }).bytes).header.patientId, 'ASCII-01');
  assert.equal(accepted(dicomFile({ values: { id: '' }, pixel: nativePixel(true) }).bytes).header.patientId, '');
  assert.equal(accepted(dicomFile({ values: { id: '    ' }, pixel: nativePixel(true) }).bytes).header.patientId, '');
  assert.equal(accepted(dicomFile({ values: { id: null }, pixel: nativePixel(true) }).bytes).header.patientId, null);
  // A structural fault outranks the PatientID rule (§4.1 order).
  refused(dicomFile({ values: { id: Buffer.from([0xc8, 0xab]), sop: '2.25.4009' }, pixel: nativePixel(true) }).bytes, 'DICOM_MALFORMED');
});

test('R-TRIM: padding and surrounding spaces are removed per VR; interior spaces are kept', () => {
  const result = accepted(dicomFile({
    values: {
      sop: Buffer.from('2.25.4001\0', 'latin1'), study: Buffer.from('2.25.4002 ', 'latin1'), series: Buffer.from('2.25.4003\0\0\0', 'latin1'),
      name: '  HONG^GIL DONG  ', id: '  ID 7  ', issuer: ' KINLAB ', modality: ' MR ', sex: 'F ', birth: '19700101 ',
      institution: 'SYNTHETIC HOSPITAL    ', frames: ' 12 ',
    },
    pixel: nativePixel(true),
  }).bytes);
  assert.deepEqual(result.header, expectedHeader(EXPLICIT, {
    patientName: 'HONG^GIL DONG', patientId: 'ID 7', issuerOfPatientId: 'KINLAB', modality: 'MR', patientSex: 'F', numberOfFrames: 12,
  }));
  for (const [frames, expected] of [['+3', 3], ['0012', 12], ['1 ', 1]]) {
    assert.equal(accepted(dicomFile({ values: { frames }, pixel: nativePixel(true) }).bytes).header.numberOfFrames, expected);
  }
  assert.equal(accepted(dicomFile({ values: { frames: '  ' }, pixel: nativePixel(true) }).bytes).header.numberOfFrames, null);
  for (const frames of ['1.5', 'abc', '1\\2', '1 2', '1234567890123']) {
    refused(dicomFile({ values: { frames }, pixel: nativePixel(true) }).bytes, 'DICOM_MALFORMED');
  }
  refused(dicomFile({ values: { study: ' 2.25.4002' }, pixel: nativePixel(true) }).bytes, 'DICOM_MALFORMED'); // UI has no leading padding
});

test('R-NUL: a NUL is padding only for UI; on the other character VRs it stays in the value (contract §4.1 steps 7-8)', () => {
  const pixel = nativePixel(true);
  // U4BA-01 probes: LO [0x41,0x00] and PN [0x41,0x00] under the default repertoire, ISO_IR 6 and ISO_IR 192.
  for (const charset of [null, 'ISO_IR 6', 'ISO_IR 192']) {
    refused(dicomFile({ values: { charset, id: Buffer.from([0x41, 0x00]) }, pixel }).bytes, 'PATIENT_ID_UNREADABLE');
    refused(dicomFile({ values: { charset, id: Buffer.from('SYN-0001\0\0', 'latin1') }, pixel }).bytes, 'PATIENT_ID_UNREADABLE');
    for (const name of [Buffer.from([0x41, 0x00]), Buffer.from('SYNTHETIC^PATIENT\0', 'latin1'), Buffer.from([0x41, 0x00, 0x20, 0x20])]) {
      const header = accepted(dicomFile({ values: { charset, name }, pixel }).bytes).header;
      assert.equal(header.patientNameComparable, false, `${charset} ${name.toString('hex')}`);
      assert.equal(header.patientName, null);
    }
  }
  // LO, CS and DA keep a NUL as part of the value instead of reading as the shorter value.
  const kept = accepted(dicomFile({
    values: { institution: Buffer.from('SYNTHETIC HOSPITAL\0\0', 'latin1'), modality: Buffer.from('CT\0\0', 'latin1'), birth: Buffer.from('19700101\0\0', 'latin1') },
    pixel,
  }).bytes).header;
  assert.notEqual(kept.institutionName, 'SYNTHETIC HOSPITAL');
  assert.equal(kept.institutionName, 'SYNTHETIC HOSPITAL\u0000\u0000');
  assert.equal(kept.modality, 'CT\u0000\u0000');
  assert.equal(kept.patientBirthDate, '19700101\u0000\u0000');
  // IS: a NUL makes the frame count unreadable rather than a number.
  refused(dicomFile({ values: { frames: Buffer.from('12\0\0', 'latin1') }, pixel }).bytes, 'DICOM_MALFORMED');
  // UI keeps its NUL padding rule, in the dataset and in File Meta.
  const ui = accepted(dicomFile({ values: { sop: Buffer.from('2.25.4001\0', 'latin1') }, metaOptions: { sop: Buffer.from('2.25.4001\0', 'latin1') }, pixel }).bytes).header;
  assert.equal(ui.sopInstanceUid, SOP);
  assert.equal(ui.mediaStorageSopInstanceUid, SOP);
});

test('R-VIEW: a Uint8Array view at a non-zero offset of a larger buffer reads the same', () => {
  const { bytes } = dicomFile({ ts: JPEG_BASELINE, extra: [PRIVATE_CREATOR, unElement(unItems())], pixel: encapsulatedPixel() });
  const host = Buffer.alloc(bytes.length + 40, 0xee);
  bytes.copy(host, 13);
  const view = new Uint8Array(host.buffer, host.byteOffset + 13, bytes.length);
  assert.deepEqual(readDicomPart10(view), readDicomPart10(bytes));
  assert.equal(readDicomPart10(view).ok, true);
});

test('R-MESSAGES: every refusal code answers in Korean; the transfer-syntax refusal is the contract sentence', () => {
  const seen = new Map();
  const vectors = [
    Buffer.alloc(10),
    dicomFile({ metaOptions: { drop: [0x0010] } }).bytes,
    dicomFile({ ts: '1.2.840.10008.1.2.2' }).bytes,
    dicomFile({ ts: JPEG_BASELINE }).bytes,
    dicomFile({ values: { id: Buffer.from([0xc8, 0xab]) }, pixel: nativePixel(true) }).bytes,
  ];
  for (const bytes of vectors) {
    const result = read(bytes);
    assert.equal(result.ok, false);
    seen.set(result.code, result.message);
  }
  assert.deepEqual([...seen.keys()].sort(), [...CODES].sort());
  for (const message of seen.values()) assert.match(message, HANGUL);
  assert.equal(seen.get('DICOM_TRANSFER_SYNTAX_UNSUPPORTED'), UNSUPPORTED_MESSAGE);
});

/** Base vectors for the truncation and mutation sweeps. */
function sweepVectors() {
  return [
    { label: 'implicit native', encapsulated: false, ...dicomFile({ ts: IMPLICIT, extra: [sequenceChain(false, 2)], pixel: nativePixel(false, 32) }) },
    { label: 'explicit native + UN', encapsulated: false, ...dicomFile({ ts: EXPLICIT, extra: [PRIVATE_CREATOR, unElement(unItems()), sequenceChain(true, 2)], pixel: nativePixel(true, 32) }) },
    { label: 'JPEG + UN + SQ', encapsulated: true, ...dicomFile({ ts: JPEG_BASELINE, extra: [PRIVATE_CREATOR, unElement(unItems()), sequenceChain(true, 2)],
      pixel: encapsulatedPixel({ bot: Buffer.concat([le32(0), le32(14)]), fragments: [Buffer.alloc(6, 1), Buffer.alloc(4, 2)] }) }) },
  ];
}

test('R-TRUNCATION: a file cut at any byte never throws; a cut inside an element is always refused', () => {
  for (const vector of sweepVectors()) {
    const ends = new Set(vector.boundaries);
    for (let length = 0; length < vector.bytes.length; length += 1) {
      let result;
      assert.doesNotThrow(() => { result = readDicomPart10(vector.bytes.subarray(0, length)); }, `${vector.label} cut at ${length}`);
      assert.equal(typeof result.ok, 'boolean');
      if (!result.ok) assert.ok(CODES.includes(result.code), `${vector.label} cut at ${length}: ${result.code}`);
      if (vector.encapsulated || !ends.has(length)) assert.equal(result.ok, false, `${vector.label} cut at ${length} must be refused`);
    }
  }
});

test('R-FUZZ: random byte damage never throws and always yields a well-formed result', () => {
  let seed = 0x5eed1234;
  const random = () => { // mulberry32
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const vectors = sweepVectors();
  for (let round = 0; round < 3000; round += 1) {
    const base = vectors[round % vectors.length].bytes;
    const bytes = Buffer.from(base);
    const edits = 1 + Math.floor(random() * 4);
    for (let i = 0; i < edits; i += 1) {
      const at = 132 + Math.floor(random() * (bytes.length - 136));
      if (random() < 0.3) bytes.writeUInt32LE(0xffffffff, at);
      else bytes[at] = Math.floor(random() * 256);
    }
    let result;
    assert.doesNotThrow(() => { result = readDicomPart10(bytes); }, `round ${round}`);
    assert.equal(typeof result.ok, 'boolean');
    if (result.ok) assert.equal(typeof result.header.sopInstanceUid, 'string');
    else assert.ok(CODES.includes(result.code), `round ${round}: ${result.code}`);
  }
});
