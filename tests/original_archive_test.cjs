'use strict';
/* TEST-S9-U4-08 (pure part): the whole-original archive, api/src/original-archive.ts.
 * REQ-S9-U4-08 -> RISK-S9-U4-08; contract S9-U4p §5.2 (canonical manifest, ZIP32 exact pre-computation, STORE writer,
 * final manifest.json, bounded per-object stream) and §8 (D73).
 *
 * The expected manifest string is written out by hand; the ZIP32 sizes are recomputed here with BigInt from the
 * contract's formula; every byte of a written archive is decoded by the small ZIP reader below, written from PKWARE
 * APPNOTE 4.3 for this file and sharing nothing with the writer, and CRC-32 is checked against node:zlib and against
 * this file's own table implementation. Assertions bind to the contract's codes, sizes, field values and states,
 * never to the module's source text (D73). No Orthanc, proxy or database: the live REQ-S9-U4-08 rows are part (b).
 *
 * Module: KIN_ORIGINAL_ARCHIVE_MODULE, default the compiled /app/dist/original-archive (kin-api:ci). A path ending in
 * .ts loads the source through Node type stripping (Node >= 22.18); the module imports only node: built-ins.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { crc32: zlibCrc32 } = require('node:zlib');
const { Readable, Writable } = require('node:stream');

const MODULE = process.env.KIN_ORIGINAL_ARCHIVE_MODULE || '/app/dist/original-archive';
const TARGET = path.isAbsolute(MODULE) ? MODULE : path.resolve(__dirname, '..', MODULE);
if (TARGET.endsWith('.ts') && !process.features.typescript) throw new Error('loading the .ts source needs Node type stripping (Node >= 22.18)');
const { canonicalManifest, parseCanonicalManifest, planArchive, writeArchive } = require(TARGET);

const TOO_LARGE_MESSAGE = '검사 원본 묶음이 내려받기 한도를 넘었습니다.'; // contract §5.2
const HANGUL = /[가-힣]/;
const LIMIT = 0xffffffffn; // every ZIP32 quantity must stay strictly below this (§5.2)

// PKWARE APPNOTE 4.3.7, 4.3.9, 4.3.12, 4.3.16 signatures; §5.2 fixed field values.
const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const FLAGS_UTF8_DESCRIPTOR = (1 << 3) | (1 << 11);
const DOS_DATE_1980_01_01 = ((1980 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME_MIDNIGHT = 0;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const md5 = bytes => createHash('md5').update(bytes).digest('hex');
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function ownCrc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Reads a ZIP from its end record backwards, then walks the local entries the central directory names. */
function parseZip(zip) {
  const endAt = zip.length - 22;
  const end = {
    signature: zip.readUInt32LE(endAt), disk: zip.readUInt16LE(endAt + 4), centralDisk: zip.readUInt16LE(endAt + 6),
    entriesOnDisk: zip.readUInt16LE(endAt + 8), entries: zip.readUInt16LE(endAt + 10), centralSize: zip.readUInt32LE(endAt + 12),
    centralOffset: zip.readUInt32LE(endAt + 16), commentLength: zip.readUInt16LE(endAt + 20),
  };
  const central = [];
  let p = end.centralOffset;
  for (let i = 0; i < end.entries; i += 1) {
    const nameLength = zip.readUInt16LE(p + 28);
    const extraLength = zip.readUInt16LE(p + 30);
    const commentLength = zip.readUInt16LE(p + 32);
    central.push({
      signature: zip.readUInt32LE(p), madeBy: zip.readUInt16LE(p + 4), versionNeeded: zip.readUInt16LE(p + 6), flags: zip.readUInt16LE(p + 8),
      method: zip.readUInt16LE(p + 10), time: zip.readUInt16LE(p + 12), date: zip.readUInt16LE(p + 14), crc: zip.readUInt32LE(p + 16),
      compressedSize: zip.readUInt32LE(p + 20), size: zip.readUInt32LE(p + 24), nameLength, extraLength, commentLength,
      diskStart: zip.readUInt16LE(p + 34), internalAttributes: zip.readUInt16LE(p + 36), externalAttributes: zip.readUInt32LE(p + 38),
      localOffset: zip.readUInt32LE(p + 42), name: zip.toString('utf8', p + 46, p + 46 + nameLength),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  const local = [];
  let q = 0;
  for (const entry of central) {
    const nameLength = zip.readUInt16LE(q + 26);
    const extraLength = zip.readUInt16LE(q + 28);
    const dataAt = q + 30 + nameLength + extraLength;
    const descriptorAt = dataAt + entry.compressedSize; // bit 3: the local sizes are zero, the central ones are real
    local.push({
      at: q, signature: zip.readUInt32LE(q), versionNeeded: zip.readUInt16LE(q + 4), flags: zip.readUInt16LE(q + 6), method: zip.readUInt16LE(q + 8),
      time: zip.readUInt16LE(q + 10), date: zip.readUInt16LE(q + 12), crc: zip.readUInt32LE(q + 14), compressedSize: zip.readUInt32LE(q + 18),
      size: zip.readUInt32LE(q + 22), nameLength, extraLength, name: zip.toString('utf8', q + 30, q + 30 + nameLength), data: zip.subarray(dataAt, descriptorAt),
      descriptor: {
        signature: zip.readUInt32LE(descriptorAt), crc: zip.readUInt32LE(descriptorAt + 4),
        compressedSize: zip.readUInt32LE(descriptorAt + 8), size: zip.readUInt32LE(descriptorAt + 12),
      },
    });
    q = descriptorAt + 16;
  }
  return { end, endAt, central, centralEnd: p, local, localEnd: q };
}

/** §5.2 "ZIP32 정확 사전 계산", recomputed here: L_i = 30+f_i+s_i+16, C_i = 46+f_i, O = ΣL, C = ΣC, T = O+C+22. */
function independentPlan(studyUid, objects) {
  const zeroManifest = JSON.stringify({
    schemaVersion: 1, studyUid, objects: objects.map(o => ({ seriesUid: o.seriesUid, sopUid: o.sopUid, bytes: o.bytes, sha256: '0'.repeat(64) })),
  });
  const M = BigInt(Buffer.byteLength(zeroManifest, 'utf8'));
  const entries = [...objects.map(o => ({ name: o.path, size: BigInt(o.bytes) })), { name: 'manifest.json', size: M }];
  let O = 0n;
  let C = 0n;
  const rows = [];
  for (const e of entries) {
    const f = BigInt(Buffer.byteLength(e.name, 'utf8'));
    rows.push({ name: e.name, offset: O, local: 30n + f + e.size + 16n, central: 46n + f, size: e.size });
    O += 30n + f + e.size + 16n;
    C += 46n + f;
  }
  return { M, rows, O, C, T: O + C + 22n, N: entries.length };
}

function deterministicBytes(seed, length) {
  const out = Buffer.alloc(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const STUDY = '2.25.7001';
// Unsorted on purpose; ASCII order puts series 2.25.10 < 2.25.20 < 2.25.9.
const INPUT = [
  { orthancId: 'oc-c', seriesUid: '2.25.20', sopUid: '2.25.201', bytes: 4096, md5: 'cccccccccccccccccccccccccccccccc' },
  { orthancId: 'oc-b', seriesUid: '2.25.10', sopUid: '2.25.102', bytes: 257, md5: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
  { orthancId: 'oc-a', seriesUid: '2.25.10', sopUid: '2.25.101', bytes: 1000, md5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  { orthancId: 'oc-d', seriesUid: '2.25.9', sopUid: '2.25.901', bytes: 1, md5: 'dddddddddddddddddddddddddddddddd' },
];
const EXPECTED_CANONICAL = '{"schemaVersion":1,"studyUid":"2.25.7001","objects":['
  + '{"orthancId":"oc-a","seriesUid":"2.25.10","sopUid":"2.25.101","bytes":1000,"md5":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","path":"001/00001.dcm"},'
  + '{"orthancId":"oc-b","seriesUid":"2.25.10","sopUid":"2.25.102","bytes":257,"md5":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","path":"001/00002.dcm"},'
  + '{"orthancId":"oc-c","seriesUid":"2.25.20","sopUid":"2.25.201","bytes":4096,"md5":"cccccccccccccccccccccccccccccccc","path":"002/00001.dcm"},'
  + '{"orthancId":"oc-d","seriesUid":"2.25.9","sopUid":"2.25.901","bytes":1,"md5":"dddddddddddddddddddddddddddddddd","path":"003/00001.dcm"}]}';

/** The four INPUT objects with real bytes (and their real MD5) for the writer tests. */
function sampleStudy() {
  const data = new Map(INPUT.map((o, index) => [o.orthancId, deterministicBytes(index + 11, o.bytes)]));
  const prepared = canonicalManifest(STUDY, INPUT.map(o => ({ ...o, md5: md5(data.get(o.orthancId)) })));
  assert.equal(prepared.ok, true);
  const planned = planArchive(prepared.manifest);
  assert.equal(planned.ok, true);
  return { data, manifest: prepared.manifest, plan: planned.plan };
}

function* chunked(bytes, size) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
/** A sink that accepts slowly (asynchronous callbacks, tiny buffer) so the writer meets backpressure. */
function collector({ highWaterMark = 64, stallAfter = Infinity } = {}) {
  const chunks = [];
  let received = 0;
  let finished = false;
  const sink = new Writable({
    highWaterMark,
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      received += chunk.length;
      if (received > stallAfter) return; // never acknowledges: a receiver that stopped reading
      setImmediate(done);
    },
  });
  sink.on('finish', () => { finished = true; });
  return { sink, bytes: () => Buffer.concat(chunks), finished: () => finished };
}
const contains = (haystack, signature) => {
  const needle = Buffer.alloc(4);
  needle.writeUInt32LE(signature);
  return haystack.includes(needle);
};
async function withTimeout(promise, ms, label) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not return within ${ms} ms`)), ms); });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

// =================================================================================================================

test('A-MANIFEST: canonical manifest bytes equal the hand-written string for every input order; SHA-256 over those bytes', () => {
  const permutations = items => (items.length <= 1 ? [items] : items.flatMap((x, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [x, ...rest])));
  for (const order of permutations(INPUT)) {
    const result = canonicalManifest(STUDY, order);
    assert.equal(result.ok, true);
    assert.equal(result.manifestCanonical, EXPECTED_CANONICAL);
    assert.equal(result.manifestSha256, sha256(Buffer.from(EXPECTED_CANONICAL, 'utf8')));
    assert.deepEqual(JSON.parse(JSON.stringify(result.manifest)), JSON.parse(EXPECTED_CANONICAL));
  }
});

test('A-ORDER: objects sort by (seriesUid, sopUid, orthancId) in ASCII order, not numerically', () => {
  // The SOP UIDs do not follow the series order (2.25.4.1 belongs to the first series), so only a series-first sort fits.
  const result = canonicalManifest(STUDY, [
    { orthancId: 'x2', seriesUid: '2.25.3', sopUid: '2.25.3.999', bytes: 2, md5: '0'.repeat(32) },
    { orthancId: 'x4', seriesUid: '2.25.12', sopUid: '2.25.4.1', bytes: 2, md5: '3'.repeat(32) },
    { orthancId: 'x1', seriesUid: '2.25.3', sopUid: '2.25.3.1000', bytes: 2, md5: '1'.repeat(32) },
    { orthancId: 'x3', seriesUid: '2.25.12', sopUid: '2.25.12.5', bytes: 2, md5: '2'.repeat(32) },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.manifest.objects.map(o => [o.seriesUid, o.sopUid, o.path]), [
    ['2.25.12', '2.25.12.5', '001/00001.dcm'], ['2.25.12', '2.25.4.1', '001/00002.dcm'],
    ['2.25.3', '2.25.3.1000', '002/00001.dcm'], ['2.25.3', '2.25.3.999', '002/00002.dcm'],
  ]);
});

test('A-REFUSE: empty sets, duplicate SOP or Orthanc IDs and malformed fields are MANIFEST_INCOMPLETE', () => {
  const ok = { orthancId: 'a', seriesUid: '2.25.1', sopUid: '2.25.1.1', bytes: 10, md5: 'f'.repeat(32) };
  const cases = [
    [STUDY, []],
    [STUDY, [ok, { ...ok, orthancId: 'b' }]], // same SOP, same series
    [STUDY, [ok, { ...ok, orthancId: 'b', seriesUid: '2.25.2' }]], // same SOP in another series
    [STUDY, [ok, { ...ok, sopUid: '2.25.1.2' }]], // same Orthanc ID
    [STUDY, [{ ...ok, md5: 'F'.repeat(32) }]], [STUDY, [{ ...ok, md5: 'f'.repeat(31) }]],
    [STUDY, [{ ...ok, bytes: -1 }]], [STUDY, [{ ...ok, bytes: 1.5 }]], [STUDY, [{ ...ok, bytes: 2 ** 53 }]], [STUDY, [{ ...ok, bytes: '10' }]],
    [STUDY, [{ ...ok, sopUid: '2.25.１' }]], [STUDY, [{ ...ok, seriesUid: '' }]], [STUDY, [{ ...ok, orthancId: 'a b' }]], [STUDY, [null]],
    ['', [ok]], ['2.25.한', [ok]],
  ];
  for (const [study, objects] of cases) {
    const result = canonicalManifest(study, objects);
    assert.equal(result.ok, false, JSON.stringify(objects));
    assert.equal(result.code, 'MANIFEST_INCOMPLETE');
    assert.match(result.message, HANGUL);
  }
});

test('A-PADDING: series ordinals take at least 3 digits and instances at least 5, never truncated', () => {
  const md5Zero = '0'.repeat(32);
  const thousandSeries = canonicalManifest(STUDY, Array.from({ length: 1000 }, (_, i) =>
    ({ orthancId: `s${i}`, seriesUid: `2.25.${String(i + 1).padStart(4, '0')}`, sopUid: `2.25.9.${i}`, bytes: 1, md5: md5Zero })));
  assert.equal(thousandSeries.ok, true);
  const paths = thousandSeries.manifest.objects.map(o => o.path);
  assert.equal(paths[0], '001/00001.dcm');
  assert.equal(paths[98], '099/00001.dcm');
  assert.equal(paths[998], '999/00001.dcm');
  assert.equal(paths[999], '1000/00001.dcm');
  const bigSeries = canonicalManifest(STUDY, Array.from({ length: 100_000 }, (_, i) =>
    ({ orthancId: `i${i}`, seriesUid: '2.25.5', sopUid: `2.25.5.${String(i + 1).padStart(6, '0')}`, bytes: 1, md5: md5Zero })));
  assert.equal(bigSeries.ok, true);
  assert.equal(bigSeries.manifest.objects[0].path, '001/00001.dcm');
  assert.equal(bigSeries.manifest.objects[99_998].path, '001/99999.dcm');
  assert.equal(bigSeries.manifest.objects[99_999].path, '001/100000.dcm');
});

test('A-STORED: a stored manifest is accepted only with its SHA-256 and in exact canonical form', () => {
  const good = canonicalManifest(STUDY, INPUT);
  const reread = parseCanonicalManifest(good.manifestCanonical, good.manifestSha256);
  assert.equal(reread.ok, true);
  assert.equal(reread.manifestCanonical, EXPECTED_CANONICAL);
  assert.deepEqual(JSON.parse(JSON.stringify(reread.manifest)), JSON.parse(EXPECTED_CANONICAL));
  const parsed = JSON.parse(EXPECTED_CANONICAL);
  const variants = [
    [EXPECTED_CANONICAL, sha256(Buffer.from(EXPECTED_CANONICAL)).replace(/^./, c => (c === '0' ? '1' : '0'))], // wrong hash
    [JSON.stringify(parsed, null, 1)], // reformatted
    [`${EXPECTED_CANONICAL}\n`], // final LF
    [JSON.stringify({ ...parsed, objects: [...parsed.objects].reverse() })], // reordered
    [JSON.stringify({ ...parsed, objects: parsed.objects.map((o, i) => (i === 1 ? { ...o, path: '001/00009.dcm' } : o)) })], // wrong path
    [JSON.stringify({ ...parsed, extra: true })], // extra key
    [JSON.stringify({ ...parsed, schemaVersion: 2 })],
    ['{"schemaVersion":1,'], // not JSON
  ];
  for (const [text, hash] of variants) {
    const result = parseCanonicalManifest(text, hash ?? sha256(Buffer.from(text, 'utf8')));
    assert.equal(result.ok, false, text.slice(0, 60));
    assert.equal(result.code, 'MANIFEST_STORE_INVALID');
    assert.match(result.message, HANGUL);
  }
});

test('A-PLAN: sizes, offsets, O, C and T equal the contract arithmetic recomputed here', () => {
  const { manifest } = canonicalManifest(STUDY, INPUT);
  const planned = planArchive(manifest);
  assert.equal(planned.ok, true);
  const plan = planned.plan;
  const expected = independentPlan(STUDY, JSON.parse(EXPECTED_CANONICAL).objects);
  assert.equal(plan.entryCount, expected.N);
  assert.equal(plan.manifestSize, Number(expected.M));
  assert.deepEqual(plan.entries.map(e => [e.name, e.nameBytes, e.size, e.localOffset, e.localSize, e.centralSize]),
    expected.rows.map(r => [r.name, Buffer.byteLength(r.name), Number(r.size), Number(r.offset), Number(r.local), Number(r.central)]));
  assert.equal(plan.centralOffset, Number(expected.O));
  assert.equal(plan.centralSize, Number(expected.C));
  assert.equal(plan.totalSize, Number(expected.T));
  assert.throws(() => planArchive({ ...JSON.parse(EXPECTED_CANONICAL), objects: JSON.parse(EXPECTED_CANONICAL).objects.reverse() }), TypeError);
});

test('A-LIMITS: 65,533 DICOM objects plan; 65,534 and 65,535 are refused before byte 1', () => {
  const objects = n => Array.from({ length: n }, (_, i) =>
    ({ orthancId: `o${i}`, seriesUid: '2.25.8', sopUid: `2.25.8.${String(i).padStart(5, '0')}`, bytes: 3, md5: '0'.repeat(32) }));
  const max = canonicalManifest(STUDY, objects(65_533));
  const planned = planArchive(max.manifest);
  assert.equal(planned.ok, true);
  const expected = independentPlan(STUDY, max.manifest.objects);
  assert.equal(planned.plan.entryCount, 65_534);
  assert.equal(planned.plan.totalSize, Number(expected.T));
  for (const n of [65_534, 65_535]) {
    const refused = planArchive(canonicalManifest(STUDY, objects(n)).manifest);
    assert.equal(refused.ok, false, String(n));
    assert.equal(refused.code, 'ARCHIVE_TOO_LARGE');
    assert.equal(refused.message, TOO_LARGE_MESSAGE);
  }
});

test('A-4GIB: payload, offsets and total stay below 0xFFFFFFFF; T = 0xFFFFFFFE plans, 0xFFFFFFFF does not', () => {
  const one = bytes => canonicalManifest(STUDY, [{ orthancId: 'big', seriesUid: '2.25.6', sopUid: '2.25.6.1', bytes, md5: '0'.repeat(32) }]).manifest;
  const refusedFor = manifest => {
    const result = planArchive(manifest);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ARCHIVE_TOO_LARGE');
    assert.equal(result.message, TOO_LARGE_MESSAGE);
  };
  refusedFor(one(0xffffffff)); // s_i itself
  refusedFor(one(0xfffffffe)); // fits alone, but not with its headers
  // The exact edge: find s with T(s) = 0xFFFFFFFE using the contract formula (M has the same digit count throughout).
  const base = 1_000_000_000;
  const baseT = independentPlan(STUDY, one(base).objects).T;
  const edge = base + Number(0xfffffffen - baseT);
  assert.equal(independentPlan(STUDY, one(edge).objects).T, 0xfffffffen);
  const atEdge = planArchive(one(edge));
  assert.equal(atEdge.ok, true);
  assert.equal(atEdge.plan.totalSize, 0xfffffffe);
  refusedFor(one(edge + 1)); // T = 0xFFFFFFFF
  // Raw payload below 4 GiB, overhead above the limit.
  const two = canonicalManifest(STUDY, [
    { orthancId: 'p', seriesUid: '2.25.6', sopUid: '2.25.6.1', bytes: 0x80000000, md5: '0'.repeat(32) },
    { orthancId: 'q', seriesUid: '2.25.6', sopUid: '2.25.6.2', bytes: 0x7fffffff - 100, md5: '0'.repeat(32) },
  ]).manifest;
  assert.ok(two.objects.reduce((sum, o) => sum + BigInt(o.bytes), 0n) < 0x100000000n);
  assert.ok(independentPlan(STUDY, two.objects).T >= LIMIT);
  refusedFor(two);
});

test('A-WRITE: the archive is exactly T bytes of STORE entries, descriptors, central directory and end record', async () => {
  const { data, manifest, plan } = sampleStudy();
  const out = collector();
  const events = [];
  const progress = [];
  const result = await writeArchive({
    plan,
    source: (object, index) => {
      events.push(`source:${index}`);
      return Readable.from(chunked(data.get(object.orthancId), 7));
    },
    sink: out.sink,
    onObjectDone: async (done, index) => {
      await new Promise(resolve => setImmediate(resolve));
      events.push(`done:${index}:${done.complete}`);
    },
    onProgress: p => progress.push(p),
  });
  const zip = out.bytes();
  const expected = independentPlan(STUDY, manifest.objects);
  assert.equal(result.state, 'finished');
  assert.equal(out.finished(), true);
  assert.equal(zip.length, Number(expected.T));
  assert.equal(result.bytesWritten, zip.length);
  assert.equal(result.archiveSha256, sha256(zip));
  assert.deepEqual(events, ['source:0', 'done:0:true', 'source:1', 'done:1:true', 'source:2', 'done:2:true', 'source:3', 'done:3:true']);
  assert.deepEqual(result.objects, manifest.objects.map(o => {
    const bytes = data.get(o.orthancId);
    return { orthancId: o.orthancId, sopUid: o.sopUid, bytesRead: bytes.length, bytesSupplied: bytes.length, sha256: sha256(bytes), md5: md5(bytes), complete: true };
  }));
  for (let i = 1; i < progress.length; i += 1) assert.ok(progress[i].archiveBytesWritten > progress[i - 1].archiveBytesWritten);

  const parsed = parseZip(zip);
  const names = [...manifest.objects.map(o => o.path), 'manifest.json'];
  const payloads = [...manifest.objects.map(o => data.get(o.orthancId))];
  const manifestJson = JSON.stringify({
    schemaVersion: 1, studyUid: STUDY,
    objects: manifest.objects.map(o => ({ seriesUid: o.seriesUid, sopUid: o.sopUid, bytes: o.bytes, sha256: sha256(data.get(o.orthancId)) })),
  });
  payloads.push(Buffer.from(manifestJson, 'utf8'));

  assert.deepEqual(parsed.end, {
    signature: SIG_END, disk: 0, centralDisk: 0, entriesOnDisk: names.length, entries: names.length,
    centralSize: Number(expected.C), centralOffset: Number(expected.O), commentLength: 0,
  });
  assert.equal(parsed.localEnd, Number(expected.O), 'local entries end where the central directory starts');
  assert.equal(parsed.centralEnd, parsed.endAt, 'the central directory ends where the end record starts');
  assert.equal(parsed.central.length, names.length);
  parsed.local.forEach((entry, i) => {
    const c = parsed.central[i];
    const payload = payloads[i];
    const crc = zlibCrc32(payload);
    assert.equal(crc, ownCrc32(payload));
    assert.equal(entry.at, Number(expected.rows[i].offset), names[i]);
    assert.deepEqual(
      { signature: entry.signature, flags: entry.flags, method: entry.method, time: entry.time, date: entry.date, crc: entry.crc,
        compressedSize: entry.compressedSize, size: entry.size, extraLength: entry.extraLength, name: entry.name },
      { signature: SIG_LOCAL, flags: FLAGS_UTF8_DESCRIPTOR, method: 0, time: DOS_TIME_MIDNIGHT, date: DOS_DATE_1980_01_01, crc: 0,
        compressedSize: 0, size: 0, extraLength: 0, name: names[i] }, names[i]);
    assert.ok(entry.versionNeeded >= 10 && entry.versionNeeded <= 20, 'extractable by a ZIP 2.0 reader (no ZIP64)');
    assert.ok(entry.data.equals(payload), `${names[i]} payload is the stored original, unchanged`);
    assert.deepEqual(entry.descriptor, { signature: SIG_DESCRIPTOR, crc, compressedSize: payload.length, size: payload.length }, names[i]);
    assert.deepEqual(
      { signature: c.signature, versionNeeded: c.versionNeeded, flags: c.flags, method: c.method, time: c.time, date: c.date, crc: c.crc,
        compressedSize: c.compressedSize, size: c.size, extraLength: c.extraLength, commentLength: c.commentLength, diskStart: c.diskStart,
        internalAttributes: c.internalAttributes, externalAttributes: c.externalAttributes, localOffset: c.localOffset, name: c.name },
      { signature: SIG_CENTRAL, versionNeeded: entry.versionNeeded, flags: FLAGS_UTF8_DESCRIPTOR, method: 0, time: DOS_TIME_MIDNIGHT,
        date: DOS_DATE_1980_01_01, crc, compressedSize: payload.length, size: payload.length, extraLength: 0, commentLength: 0, diskStart: 0,
        internalAttributes: 0, externalAttributes: 0, localOffset: entry.at, name: names[i] }, names[i]);
  });
  assert.equal(parsed.local.at(-1).data.toString('utf8'), manifestJson, 'manifest.json is the §5.2 step 7 compact form, last');
});

/** A writer run over the sample study with one object's source replaced. */
async function writeWith(replace, options = {}) {
  const { data, manifest, plan } = sampleStudy();
  const out = collector(options.collector);
  const opened = [];
  const result = await withTimeout(writeArchive({
    plan,
    source: (object, index) => {
      opened.push(index);
      const original = data.get(object.orthancId);
      return replace(index, original) ?? Readable.from(chunked(original, 64));
    },
    sink: out.sink,
    ...options.hooks,
  }), 5000, 'writeArchive');
  return { result, zip: out.bytes(), out, opened, plan, manifest, data };
}
function assertIncomplete(run, reason) {
  assert.equal(run.result.state, 'incomplete');
  assert.equal(run.result.reason, reason);
  assert.equal(run.result.archiveSha256, null);
  assert.equal(run.out.finished(), false, 'never a finished response');
  assert.equal(run.out.sink.destroyed, true, 'the response is torn down, not ended');
  assert.ok(!contains(run.zip, SIG_CENTRAL) && !contains(run.zip, SIG_END), 'no central directory or end record was written');
  assert.ok(run.zip.length < run.plan.totalSize);
  // bytesWritten counts what was handed to the sink; a torn-down sink may drop what it still buffered.
  assert.ok(run.zip.length <= run.result.bytesWritten && run.result.bytesWritten < run.plan.totalSize);
}

test('A-SHORT: an object shorter than its manifest bytes makes the archive incomplete', async () => {
  const run = await writeWith((index, original) => (index === 1 ? Readable.from(chunked(original.subarray(1), 64)) : null));
  assertIncomplete(run, 'length-mismatch');
  assert.equal(run.result.objects.length, 2);
  assert.equal(run.result.objects[0].complete, true);
  assert.deepEqual(run.result.objects[1], {
    orthancId: run.manifest.objects[1].orthancId, sopUid: run.manifest.objects[1].sopUid, bytesRead: run.manifest.objects[1].bytes - 1,
    bytesSupplied: run.manifest.objects[1].bytes - 1, sha256: null, md5: null, complete: false,
  });
});

test('A-LONG: reading stops at manifest bytes + 1 and the source is released', async () => {
  let produced = 0;
  let stream;
  const run = await writeWith((index, original) => {
    if (index !== 0) return null;
    const total = original.length + 5000;
    stream = new Readable({
      highWaterMark: 1,
      read() {
        if (produced >= total) return this.push(null);
        this.push(Buffer.from([produced < original.length ? original[produced] : 0x55]));
        produced += 1;
      },
    });
    return stream;
  });
  assertIncomplete(run, 'length-mismatch');
  const size = run.manifest.objects[0].bytes;
  assert.equal(run.result.objects[0].bytesRead, size + 1);
  assert.equal(run.result.objects[0].complete, false);
  assert.equal(run.result.objects[0].sha256, null);
  assert.ok(produced <= size + 4, `the writer pulled ${produced} bytes from a ${size}-byte object`);
  assert.equal(stream.destroyed, true);
});

test('A-MD5: same length, different bytes: incomplete, no hash recorded for the object', async () => {
  const run = await writeWith((index, original) => {
    if (index !== 2) return null;
    const changed = Buffer.from(original);
    changed[17] ^= 0xff;
    return Readable.from(chunked(changed, 100));
  });
  assertIncomplete(run, 'md5-mismatch');
  assert.equal(run.result.objects.length, 3);
  assert.deepEqual(run.result.objects.map(o => o.complete), [true, true, false]);
  assert.equal(run.result.objects[2].bytesRead, run.manifest.objects[2].bytes);
  assert.equal(run.result.objects[2].sha256, null);
  assert.equal(run.result.objects[2].md5, null);
});

test('A-SOURCE-FAIL: a source that errors or cannot open ends the archive incomplete', async () => {
  const failing = await writeWith((index, original) => {
    if (index !== 1) return null;
    return new Readable({
      read() {
        this.push(original.subarray(0, 10));
        this.destroy(new Error('upstream reset'));
      },
    });
  });
  assertIncomplete(failing, 'source-error');
  const unopened = await writeWith(index => {
    if (index === 3) throw new Error('lookup failed');
    return null;
  });
  assertIncomplete(unopened, 'source-error');
  assert.equal(unopened.result.objects.length, 4);
  assert.equal(unopened.result.objects[3].bytesRead, 0);
});

test('A-SINK-CLOSED: a receiver that goes away mid-stream ends the archive without hanging', async () => {
  const { data, plan } = sampleStudy();
  const out = collector();
  let written = 0;
  const result = await withTimeout(writeArchive({
    plan,
    source: object => Readable.from(chunked(data.get(object.orthancId), 32)),
    sink: out.sink,
    onProgress: p => {
      written = p.archiveBytesWritten;
      if (written > 1500 && !out.sink.destroyed) out.sink.destroy();
    },
  }), 5000, 'writeArchive');
  assert.equal(result.state, 'incomplete');
  assert.equal(result.reason, 'sink-closed');
  assert.equal(out.finished(), false);
});

test('A-HOOKS: a failed checkpoint, a lost lease or an abort stops the archive before the next write', async () => {
  const checkpoint = await writeWith(() => null, { hooks: { onObjectDone: async index => { throw new Error('db down'); } } });
  assertIncomplete(checkpoint, 'checkpoint-failed');
  assert.deepEqual(checkpoint.opened, [0], 'the next object is not opened after a failed checkpoint');

  let calls = 0;
  let afterFence = 0;
  const fenced = await writeWith(() => null, { hooks: { beforeWrite: () => (calls += 1) < 5 } });
  assertIncomplete(fenced, 'fenced');
  afterFence = fenced.zip.length;
  assert.equal(afterFence, fenced.result.bytesWritten);

  // Abort while the source stalls: the writer returns promptly and releases the stalled source.
  const controller = new AbortController();
  let stalled;
  const aborted = await writeWith((index, original) => {
    if (index !== 1) return null;
    stalled = new Readable({ read() {} });
    stalled.push(original.subarray(0, 8));
    setTimeout(() => controller.abort(), 20);
    return stalled;
  }, { hooks: { signal: controller.signal } });
  assertIncomplete(aborted, 'aborted');
  assert.equal(stalled.destroyed, true);

  // Abort while the receiver stalls (stops acknowledging writes after 600 bytes, so the writer waits for 'drain').
  const controller2 = new AbortController();
  const timer = setTimeout(() => controller2.abort(), 200);
  const receiverStall = await writeWith(() => null, { collector: { stallAfter: 600 }, hooks: { signal: controller2.signal } });
  clearTimeout(timer);
  assertIncomplete(receiverStall, 'aborted');
  assert.ok(receiverStall.zip.length > 600 && receiverStall.zip.length < 1000, 'it was waiting on the stalled receiver');
});
