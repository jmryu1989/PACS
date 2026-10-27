'use strict';
/* MG-LOADING: the direct frame reader's contracts (api/src/dicom-frame-layout.ts) and the service's streaming
 * answer (api/src/dicom-frame.service.ts) over a synthetic stored object: which objects it serves itself, the byte
 * range of a frame, the multipart/related shape the viewer parses, gzip negotiation, the URL-hierarchy check and
 * the preview PNG. Synthetic bytes only; Orthanc is a stub source. No Docker here. D73: behaviour, not source text. */
require('./service_test_loader.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { PassThrough } = require('node:stream');

const layout = require('/app/dist/dicom-frame-layout.js');
const { DicomFrameService } = require('/app/dist/dicom-frame.service.js');
const { DicomFrameController } = require('/app/dist/dicom-frame.controller.js');
const { OrthancService } = require('/app/dist/orthanc.service.js');

const EXPLICIT = '1.2.840.10008.1.2.1', IMPLICIT = '1.2.840.10008.1.2';
const facts = (over = {}) => ({ transferSyntax: EXPLICIT, pixelDataOffset: 1000, rows: 4, columns: 3, bitsAllocated: 16,
  samplesPerPixel: 1, numberOfFrames: 5, planarConfiguration: null, photometric: 'MONOCHROME2', pixelRepresentation: 0,
  bitsStored: null, highBit: null, rescaleSlope: null, rescaleIntercept: null, modalityLutSequence: false,
  windowCenter: null, windowWidth: null, voiLutFunction: null, voiLutSequence: false,
  fileSize: 1000 + 12 + 4 * 3 * 2 * 5, storedSize: 1000 + 12 + 4 * 3 * 2 * 5, ...over });

test('frameLayout: an uncompressed little-endian frame array is a range; everything else stays with Orthanc', () => {
  assert.deepEqual(layout.frameLayout(facts()), { headerLength: 12, frameBytes: 24, numberOfFrames: 5, firstFrameOffset: 1012 });
  assert.deepEqual(layout.frameLayout(facts({ transferSyntax: IMPLICIT, fileSize: 1000 + 8 + 120, storedSize: 1000 + 8 + 120 })),
    { headerLength: 8, frameBytes: 24, numberOfFrames: 5, firstFrameOffset: 1008 });
  assert.equal(layout.frameLayout(facts({ transferSyntax: '1.2.840.10008.1.2.4.80' })), null, 'JPEG-LS is encapsulated');
  assert.equal(layout.frameLayout(facts({ transferSyntax: '1.2.840.10008.1.2.2' })), null, 'big endian is Orthanc\'s');
  assert.equal(layout.frameLayout(facts({ bitsAllocated: 12 })), null);
  assert.equal(layout.frameLayout(facts({ bitsAllocated: 1 })), null);
  assert.equal(layout.frameLayout(facts({ samplesPerPixel: 3, planarConfiguration: 1 })), null, 'planar colour is not a frame');
  assert.equal(layout.frameLayout(facts({ pixelDataOffset: null })), null, 'no indexed offset');
  assert.equal(layout.frameLayout(facts({ storedSize: 500 })), null, 'storage compression changes the stored bytes');
  assert.equal(layout.frameLayout(facts({ fileSize: 1000 + 12 + 119, storedSize: 1000 + 12 + 119 })), null, 'frames past the file end');
});

test('pixelDataHeaderMatches: the element at the offset must be Pixel Data of exactly the indexed length', () => {
  const l = layout.frameLayout(facts());
  const header = (vr, length) => { const b = Buffer.alloc(12); Buffer.from([0xe0, 0x7f, 0x10, 0x00]).copy(b); b.write(vr, 4, 'latin1'); b.writeUInt32LE(length, 8); return b; };
  assert.equal(layout.pixelDataHeaderMatches(header('OW', 120), l), true);
  assert.equal(layout.pixelDataHeaderMatches(header('OB', 120), l), true);
  assert.equal(layout.pixelDataHeaderMatches(header('OW', 0xffffffff), l), false, 'undefined length is encapsulated');
  assert.equal(layout.pixelDataHeaderMatches(header('OW', 121), l), false);
  assert.equal(layout.pixelDataHeaderMatches(header('UN', 120), l), false);
  const other = header('OW', 120); other[0] = 0x10;
  assert.equal(layout.pixelDataHeaderMatches(other, l), false, 'another tag at the offset');
  const odd = layout.frameLayout(facts({ bitsAllocated: 8, rows: 3, columns: 3, numberOfFrames: 1, fileSize: 1000 + 12 + 10, storedSize: 1000 + 12 + 10 }));
  assert.equal(layout.pixelDataHeaderMatches(header('OB', 10), odd), true, 'odd frame array padded to an even length');
  const implicit = layout.frameLayout(facts({ transferSyntax: IMPLICIT, fileSize: 1000 + 8 + 120, storedSize: 1000 + 8 + 120 }));
  const b8 = Buffer.alloc(8); Buffer.from([0xe0, 0x7f, 0x10, 0x00]).copy(b8); b8.writeUInt32LE(120, 4);
  assert.equal(layout.pixelDataHeaderMatches(b8, implicit), true);
});

test('frameRange and parseFrameList: 1-based frames inside the object; any syntactically valid WADO-RS list is a request', () => {
  const l = layout.frameLayout(facts());
  assert.deepEqual(layout.frameRange(l, 1), { start: 1012, end: 1035 });
  assert.deepEqual(layout.frameRange(l, 5), { start: 1012 + 96, end: 1012 + 119 });
  assert.equal(layout.frameRange(l, 6), null);
  assert.equal(layout.frameRange(l, 0), null);
  assert.deepEqual(layout.parseFrameList('1'), [1]);
  assert.deepEqual(layout.parseFrameList('3,1,2'), [3, 1, 2]);
  assert.equal(layout.parseFrameList('0'), null);
  assert.equal(layout.parseFrameList('1,'), null);
  assert.equal(layout.parseFrameList('a'), null);
  // No invented ceiling (review MG-07): a 17-frame or longer list is as valid as a one-frame one (PS3.18 §10.4.1.1.2).
  const long = Array.from({ length: 40 }, (_, i) => i + 1);
  assert.deepEqual(layout.parseFrameList(long.join(',')), long);
});

test('directReadServes: octet-stream in the stored syntax (or any) is direct; another media type or syntax is Orthanc\'s', () => {
  assert.equal(layout.directReadServes('multipart/related; type=application/octet-stream; transfer-syntax=*', EXPLICIT), true);
  assert.equal(layout.directReadServes('multipart/related; type="application/octet-stream"; transfer-syntax="1.2.840.10008.1.2.1"', EXPLICIT), true);
  assert.equal(layout.directReadServes('multipart/related; type="application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1"', EXPLICIT), true, 'Orthanc\'s own quoted shape');
  assert.equal(layout.directReadServes('multipart/related; type="application/octet-stream"', EXPLICIT), true, 'no syntax parameter: the stored one');
  assert.equal(layout.directReadServes('multipart/related', EXPLICIT), true);
  assert.equal(layout.directReadServes('*/*', EXPLICIT), true);
  assert.equal(layout.directReadServes('application/octet-stream', EXPLICIT), true);
  assert.equal(layout.directReadServes(undefined, EXPLICIT), true);
  assert.equal(layout.directReadServes('', EXPLICIT), true);
  assert.equal(layout.directReadServes('multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.4.80', EXPLICIT), false, 'transcode');
  // Review MG-05: a request for another representation has no transfer-syntax parameter but is still not a raw frame read.
  assert.equal(layout.directReadServes('multipart/related; type="image/jpeg"', EXPLICIT), false);
  assert.equal(layout.directReadServes('multipart/related; type="image/jls"; transfer-syntax=*', EXPLICIT), false);
  assert.equal(layout.directReadServes('image/jpeg', EXPLICIT), false);
  assert.equal(layout.directReadServes('multipart/related; type="image/jpeg", multipart/related; type="application/octet-stream"', EXPLICIT), true, 'any acceptable entry');
  assert.equal(layout.directReadServes('multipart/related; type="application/octet-stream"; q=0, image/jpeg', EXPLICIT), false, 'q=0 is not acceptable');
});

test('acceptsGzip: a positive gzip (or wildcard) quality selects gzip; gzip;q=0, no header or no match is identity', () => {
  assert.equal(layout.acceptsGzip('gzip, deflate, br'), true);
  assert.equal(layout.acceptsGzip('gzip;q=0.5, identity'), true);
  assert.equal(layout.acceptsGzip('*'), true);
  assert.equal(layout.acceptsGzip('br, *;q=0.1'), true);
  assert.equal(layout.acceptsGzip('x-gzip'), true);
  assert.equal(layout.acceptsGzip('gzip;q=0, identity;q=1'), false, 'review MG-06: forbidden gzip');
  assert.equal(layout.acceptsGzip('gzip;q=0, *'), false, 'the named coding wins over the wildcard');
  assert.equal(layout.acceptsGzip('br, *;q=0'), false);
  assert.equal(layout.acceptsGzip('identity'), false);
  assert.equal(layout.acceptsGzip(undefined), false);
  assert.equal(layout.acceptsGzip(''), false);
});

test('multipartFrames: Orthanc\'s part shape and an exact Content-Length', () => {
  const boundary = '433097e9-6073-4bd0-b31c-6e00fe06e4d2-e4566715-731c-4cbd-b011-50eb24f73';
  const mp = layout.multipartFrames(boundary, 'https://pacs.example/dicom-web/studies/1.2/series/1.3/instances/1.4', EXPLICIT, 24);
  assert.equal(mp.contentType, `multipart/related; type="application/octet-stream; transfer-syntax=${EXPLICIT}"; boundary=${boundary}`);
  const head = mp.partHead(2).toString('latin1');
  assert.equal(head, `--${boundary}\r\nContent-Location: https://pacs.example/dicom-web/studies/1.2/series/1.3/instances/1.4/frames/2\r\n` +
    `Content-Type: application/octet-stream; transfer-syntax=${EXPLICIT}\r\nContent-Length: 24\r\nMIME-Version: 1.0\r\n\r\n`);
  const body = Buffer.concat([mp.partHead(1), Buffer.alloc(24), mp.partTail, mp.partHead(2), Buffer.alloc(24), mp.partTail, mp.closing]);
  assert.equal(mp.contentLength([1, 2], 24), body.length);
  assert.ok(body.toString('latin1').endsWith(`\r\n--${boundary}--\r\n`));
  assert.throws(() => layout.multipartFrames('x', 'o', EXPLICIT, 1));
});

test('previewPng: a valid greyscale PNG windowed by the stored VOI, inverted for MONOCHROME1, null for colour', () => {
  const f = facts({ rows: 40, columns: 30, numberOfFrames: 1, windowCenter: 100, windowWidth: 200, fileSize: 1000 + 12 + 2400, storedSize: 1000 + 12 + 2400 });
  const frame = Buffer.alloc(40 * 30 * 2);
  for (let i = 0; i < 40 * 30; i++) frame.writeUInt16LE(i % 30 < 15 ? 0 : 200, i * 2);   // left half 0 -> black, right half 200 -> white under the window
  const png = layout.previewPng(frame, f, { maxSide: 20 });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.toString('latin1', 12, 16), 'IHDR');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.ok(width <= 20 && height <= 20 && width >= 10 && height >= 10, `subsampled to ${width}x${height}`);
  assert.deepEqual([png[24], png[25]], [8, 0], '8-bit greyscale');
  const idat = png.indexOf('IDAT', 0, 'latin1');
  const length = png.readUInt32BE(idat - 4);
  const raw = zlib.inflateSync(png.subarray(idat + 4, idat + 4 + length));
  assert.equal(raw.length, (width + 1) * height);
  const values = new Set([...raw].filter((_, i) => i % (width + 1) !== 0));
  assert.ok(values.has(0) && values.has(255) && values.size === 2, 'the two stored values map to the window ends');
  const inverted = layout.previewPng(frame, { ...f, photometric: 'MONOCHROME1' }, { maxSide: 20 });
  assert.notDeepEqual(inverted, png);
  assert.equal(layout.previewPng(frame, { ...f, samplesPerPixel: 3 }, { maxSide: 20 }), null);
  assert.equal(layout.previewPng(frame.subarray(0, 100), f, { maxSide: 20 }), null, 'a short frame is not previewed');
});

/** The grey values of a PNG's rows, filter bytes dropped. */
function pngGreys(png) {
  const width = png.readUInt32BE(16), idat = png.indexOf('IDAT', 0, 'latin1'), length = png.readUInt32BE(idat - 4);
  return [...zlib.inflateSync(png.subarray(idat + 4, idat + 4 + length))].filter((_, i) => i % (width + 1) !== 0);
}

test('previewPng: stored samples go through the DICOM greyscale pipeline (bit layout, sign, rescale, VOI), or stay with Orthanc', () => {
  // Review MG-02 cases. A CT-like object: stored [824, 1024, 1224], slope 1, intercept -1024 → [-200, 0, 200]; window 0/400 (LINEAR,
  // PS3.3 C.11.2.1.2.1) maps those to 0, 128 and 255, not to three white pixels.
  const ct = facts({ rows: 1, columns: 3, numberOfFrames: 1, bitsStored: 16, highBit: 15, rescaleSlope: 1, rescaleIntercept: -1024,
    windowCenter: 0, windowWidth: 400, fileSize: 1000 + 12 + 6, storedSize: 1000 + 12 + 6 });
  const ctFrame = Buffer.alloc(6); [824, 1024, 1224].forEach((v, i) => ctFrame.writeUInt16LE(v, i * 2));
  assert.deepEqual(pngGreys(layout.previewPng(ctFrame, ct, { maxSide: 20 })), [0, 128, 255]);
  // The same values without a window: the frame's own min/max span the output.
  assert.deepEqual(pngGreys(layout.previewPng(ctFrame, { ...ct, windowCenter: null, windowWidth: null }, { maxSide: 20 })), [0, 128, 255]);
  // LINEAR_EXACT (C.11.2.1.3): -200 → 0, 0 → 128, 200 → 255 as well; 100 → (100/400+0.5)*255 = 191.
  const exactFrame = Buffer.alloc(6); [824, 1024, 1124].forEach((v, i) => exactFrame.writeUInt16LE(v, i * 2));
  assert.deepEqual(pngGreys(layout.previewPng(exactFrame, { ...ct, voiLutFunction: 'LINEAR_EXACT' }, { maxSide: 20 })), [0, 128, 191]);
  // Signed 12-bit samples in 16 allocated bits: [4095, 0, 1] are -1, 0, +1 (the sign bit is bit 11, PS3.5 §8.1.1), so the
  // preview rises from black through grey to white; reading the 16-bit sign bit would make 4095 the brightest.
  const signed = facts({ rows: 1, columns: 3, numberOfFrames: 1, bitsStored: 12, highBit: 11, pixelRepresentation: 1, fileSize: 1000 + 12 + 6, storedSize: 1000 + 12 + 6 });
  const signedFrame = Buffer.alloc(6); [4095, 0, 1].forEach((v, i) => signedFrame.writeUInt16LE(v, i * 2));
  assert.deepEqual(pngGreys(layout.previewPng(signedFrame, signed, { maxSide: 20 })), [0, 128, 255]);
  // Unsigned 10-bit in 16 (the EA1141 MG objects): bits above HighBit are not sample bits.
  const mg = facts({ rows: 1, columns: 3, numberOfFrames: 1, bitsStored: 10, highBit: 9, fileSize: 1000 + 12 + 6, storedSize: 1000 + 12 + 6 });
  const mgFrame = Buffer.alloc(6); [0 | 0xf000, 512, 1023].forEach((v, i) => mgFrame.writeUInt16LE(v, i * 2));
  assert.deepEqual(pngGreys(layout.previewPng(mgFrame, mg, { maxSide: 20 })), [0, 128, 255]);
  // MONOCHROME1 inverts after the window.
  assert.deepEqual(pngGreys(layout.previewPng(ctFrame, { ...ct, photometric: 'MONOCHROME1' }, { maxSide: 20 })), [255, 127, 0]);
  // What the small renderer does not interpret is Orthanc's: a palette, a Modality LUT table, a VOI LUT table without a
  // window, a sigmoid window, an impossible bit layout, a zero or sub-unit LINEAR width.
  for (const [name, over] of [
    ['palette colour', { photometric: 'PALETTE COLOR' }], ['Modality LUT Sequence', { modalityLutSequence: true }],
    ['VOI LUT Sequence without a window', { windowCenter: null, windowWidth: null, voiLutSequence: true }],
    ['SIGMOID window', { voiLutFunction: 'SIGMOID' }], ['HighBit below BitsStored-1', { bitsStored: 12, highBit: 7 }],
    ['BitsStored above BitsAllocated', { bitsStored: 17 }], ['zero window width', { windowWidth: 0 }], ['RGB', { samplesPerPixel: 3 }],
  ]) assert.equal(layout.previewPng(ctFrame, { ...ct, ...over }, { maxSide: 20 }), null, name);
  // A VOI LUT Sequence beside a window: the window is the rendered VOI (the viewer's default as well).
  assert.deepEqual(pngGreys(layout.previewPng(ctFrame, { ...ct, voiLutSequence: true }, { maxSide: 20 })), [0, 128, 255]);
});

// ── the service over a synthetic stored file and a stub Orthanc index ──

function syntheticObject(dir, shape = {}) {
  const { rows = 4, columns = 3, random = false, tags: extraTags = {} } = shape;
  const frames = 5, frameBytes = rows * columns * 2, offset = 1000;
  const uuid = '9447e43e-7a12-4de9-af18-9ceb86847e05';
  const file = Buffer.alloc(offset + 12 + frameBytes * frames);
  Buffer.from([0xe0, 0x7f, 0x10, 0x00]).copy(file, offset); file.write('OW', offset + 4, 'latin1'); file.writeUInt32LE(frameBytes * frames, offset + 8);
  if (random) require('node:crypto').randomFillSync(file, offset + 12);   // incompressible: gzip emits many chunks
  else for (let f = 0; f < frames; f++) for (let i = 0; i < rows * columns; i++) file.writeUInt16LE(f * 1000 + i, offset + 12 + f * frameBytes + i * 2);
  const filePath = path.join(dir, uuid.slice(0, 2), uuid.slice(2, 4), uuid);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, file);
  const id = '3fc2d51f-e3bbd38a-db69114e-eef254ef-fcc4744b';
  const tags = { StudyInstanceUID: '1.2.3', SeriesInstanceUID: '1.2.3.4', SOPInstanceUID: '1.2.3.4.5', Rows: String(rows), Columns: String(columns),
    BitsAllocated: '16', SamplesPerPixel: '1', NumberOfFrames: String(frames), PhotometricInterpretation: 'MONOCHROME2', PixelRepresentation: '0', ...extraTags };
  return { uuid, id, file, frameBytes, offset, tags, filePath,
    attachment: { Uuid: uuid, UncompressedSize: file.length, CompressedSize: file.length, ContentType: 1 } };
}

function stubOrthanc(object, over = {}) {
  const calls = [];
  return { calls,
    async lookupInstance(sop) { calls.push(['lookup', sop]); return sop === object.tags.SOPInstanceUID ? [{ Type: 'Instance', ID: object.id }] : []; },
    async frameFacts(id) { calls.push(['facts', id]); return { tags: object.tags, attachment: object.attachment, transferSyntax: EXPLICIT, pixelDataOffset: String(object.offset), ...over }; },
    async relay(path, accept, target) { calls.push(['relay', path, accept]); target.status(200); target.setHeader('content-type', 'relayed'); target.write(Buffer.from('relayed')); target.end(); },
  };
}

/** A Writable like Express's response: the service pipes into it and sets status/headers on it. */
function target() {
  const sink = new PassThrough(), chunks = [], headers = {}; let status = 0;
  sink.on('data', c => chunks.push(c));
  const done = new Promise(resolve => { sink.on('end', resolve); sink.on('close', resolve); });
  sink.status = c => { status = c; };
  sink.setHeader = (k, v) => { headers[k.toLowerCase()] = v; };
  sink.result = async () => { await done; return { status, headers, body: Buffer.concat(chunks) }; };
  return sink;
}

const request = over => ({ studyUid: '1.2.3', seriesUid: '1.2.3.4', sopUid: '1.2.3.4.5', frames: [2],
  accept: 'multipart/related; type=application/octet-stream; transfer-syntax=*', acceptEncoding: undefined, head: false, origin: 'https://pacs.example', ...over });

async function withService(fn, over, shape) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-frames-'));
  const previous = process.env.KIN_ORTHANC_STORAGE;
  process.env.KIN_ORTHANC_STORAGE = dir;
  try {
    const object = syntheticObject(dir, shape), orthanc = stubOrthanc(object, over);
    await fn(new DicomFrameService(orthanc), object, orthanc);
  } finally {
    if (previous === undefined) delete process.env.KIN_ORTHANC_STORAGE; else process.env.KIN_ORTHANC_STORAGE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('serveFrames: the frame bytes of the stored file in Orthanc\'s multipart shape, with an exact Content-Length', async () => {
  await withService(async (service, object, orthanc) => {
    const t = target();
    await service.serveFrames(request({ frames: [2, 5] }), t);
    const { status, headers, body } = await t.result();
    assert.equal(status, 200);
    assert.match(headers['content-type'], /^multipart\/related; type="application\/octet-stream; transfer-syntax=1\.2\.840\.10008\.1\.2\.1"; boundary=[0-9a-f-]+$/);
    assert.equal(Number(headers['content-length']), body.length);
    assert.equal(headers['content-encoding'], undefined);
    const boundary = /boundary=([0-9a-f-]+)$/.exec(headers['content-type'])[1];
    const parts = body.toString('latin1').split(`--${boundary}`);
    assert.equal(parts.length, 4, 'two parts and the closing delimiter');
    for (const [index, frame] of [[1, 2], [2, 5]]) {
      const part = parts[index];
      const headEnd = part.indexOf('\r\n\r\n');
      assert.match(part.slice(0, headEnd), new RegExp(`Content-Location: https://pacs.example/dicom-web/studies/1.2.3/series/1.2.3.4/instances/1.2.3.4.5/frames/${frame}\\r\\n`));
      const bytes = Buffer.from(part.slice(headEnd + 4, headEnd + 4 + object.frameBytes), 'latin1');
      assert.deepEqual(bytes, object.file.subarray(object.offset + 12 + (frame - 1) * object.frameBytes, object.offset + 12 + frame * object.frameBytes), `frame ${frame} bytes`);
    }
    assert.ok(!orthanc.calls.some(c => c[0] === 'relay'), 'served directly');
    // The second request neither looks the object up nor describes it again.
    const before = orthanc.calls.length, t2 = target();
    await service.serveFrames(request({ frames: [1] }), t2);
    assert.equal((await t2.result()).status, 200);
    assert.equal(orthanc.calls.length, before);
  });
});

test('serveFrames: gzip when the client accepts it, decoding to the same multipart body; HEAD sends headers only', async () => {
  await withService(async (service) => {
    const plain = target();
    await service.serveFrames(request(), plain);
    const expected = (await plain.result()).body;
    const t = target();
    await service.serveFrames(request({ acceptEncoding: 'gzip, deflate, br' }), t);
    const { headers, body } = await t.result();
    assert.equal(headers['content-encoding'], 'gzip');
    assert.equal(headers['content-length'], undefined);
    assert.equal(headers['vary'], 'Accept-Encoding');
    const decoded = zlib.gunzipSync(body);
    assert.equal(decoded.length, expected.length);
    assert.ok(decoded.subarray(0, 2).equals(Buffer.from('--')));
    const head = target();
    await service.serveFrames(request({ head: true }), head);
    const answer = await head.result();
    assert.equal(answer.status, 200);
    assert.equal(answer.body.length, 0);
    assert.equal(Number(answer.headers['content-length']), expected.length);
  });
});

test('serveFrames: a client that goes away mid-stream ends the read as a failure, never as an unhandled rejection', async () => {
  // Observed 2026-10-27 on the synthetic stack: the viewer page closed during a gzip thumbnail read and the API process
  // exited 1 from the delivery pipeline's unobserved rejection. The read itself must still fail (nothing pretends to finish).
  const unhandled = [], listener = reason => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    for (const acceptEncoding of ['gzip', undefined]) {
      await withService(async (service) => {
        const t = target();
        t.once('data', () => t.destroy());   // the client's socket closes after the first bytes
        await assert.rejects(service.serveFrames(request({ frames: [1, 2, 3, 4, 5], acceptEncoding }), t));
        await new Promise(resolve => setTimeout(resolve, 20));   // let any orphaned rejection surface
        assert.deepEqual(unhandled, [], `unhandled rejection with Accept-Encoding ${acceptEncoding}`);
      }, undefined, { rows: 256, columns: 256, random: true });
    }
  } finally { process.off('unhandledRejection', listener); }
});

test('serveFrames: a stored file that no longer has the described size is not served from the cached description', async () => {
  // Review MG-01, first form: the description (HEAD) is cached, then the stored file loses two bytes (its last sample).
  // The next GET must not answer 200 with a part that declares the full length and carries fewer bytes.
  await withService(async (service, object, orthanc) => {
    const head = target();
    await service.serveFrames(request({ frames: [5], head: true }), head);
    assert.equal((await head.result()).status, 200);
    fs.truncateSync(object.filePath, object.file.length - 2);
    const t = target();
    await service.serveFrames(request({ frames: [5] }), t);
    const { body } = await t.result();
    assert.equal(body.toString(), 'relayed', 'the changed file is not the described object: Orthanc answers');
    assert.deepEqual(orthanc.calls.at(-1), ['relay', '/dicom-web/studies/1.2.3/series/1.2.3.4/instances/1.2.3.4.5/frames/5', request().accept]);
    // The dropped description is rebuilt from the index on the next request (which still fails the size check here).
    const facts = orthanc.calls.filter(c => c[0] === 'facts').length;
    const again = target();
    await service.serveFrames(request({ frames: [1] }), again);
    assert.equal((await again.result()).body.toString(), 'relayed');
    assert.equal(orthanc.calls.filter(c => c[0] === 'facts').length, facts + 1, 'described again, not served from the stale description');
  });
});

test('serveFrames: a file that ends inside a frame while it streams aborts the transfer, never completing the multipart body', async () => {
  // Review MG-01, second form: the size check passed, then the read came up short (EOF is not an I/O error). The
  // response must fail: no part tail, no closing boundary, and for gzip no complete deflate stream.
  const unhandled = [], listener = reason => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    for (const acceptEncoding of [undefined, 'gzip']) {
      await withService(async (service, object) => {
        const t = target();
        // After the first bytes left (the part head and the first chunk of frame 1), frame 2 loses its second half.
        t.once('data', () => fs.truncateSync(object.filePath, object.offset + 12 + object.frameBytes + object.frameBytes / 2));
        await assert.rejects(service.serveFrames(request({ frames: [1, 2, 3], acceptEncoding }), t), /short read/);
        const { headers, body } = await t.result();
        const boundary = /boundary=([0-9a-f-]+)$/.exec(headers['content-type'])[1];
        let plain = body;
        if (acceptEncoding === 'gzip') {
          assert.throws(() => zlib.gunzipSync(body), 'an incomplete gzip stream, not a decodable body');
          plain = zlib.inflateRawSync(body.subarray(10), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
        } else assert.ok(body.length < Number(headers['content-length']), 'fewer bytes than the declared Content-Length');
        assert.ok(!plain.toString('latin1').includes(`--${boundary}--`), 'no closing delimiter');
        assert.ok(t.destroyed, 'the response was destroyed');
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.deepEqual(unhandled, []);
      }, undefined, { rows: 1024, columns: 1024, random: true });
    }
  } finally { process.off('unhandledRejection', listener); }
});

test('serveFrames: a URL whose study or series is not the object\'s is 404, never another study\'s bytes', async () => {
  await withService(async (service) => {
    await assert.rejects(service.serveFrames(request({ studyUid: '9.9.9' }), target()), /영상이 없습니다/);
    await assert.rejects(service.serveFrames(request({ seriesUid: '9.9.9' }), target()), /영상이 없습니다/);
    await assert.rejects(service.serveFrames(request({ sopUid: '9.9.9' }), target()), /원본이 없거나 중복/);
  });
});

test('serveFrames: relays to Orthanc what it cannot prove - encapsulated syntax, transcode request, frame past the end, absent file', async () => {
  await withService(async (service, object, orthanc) => {
    const t = target();
    await service.serveFrames(request({ frames: [9] }), t);
    assert.equal((await t.result()).body.toString(), 'relayed');
    assert.deepEqual(orthanc.calls.at(-1), ['relay', '/dicom-web/studies/1.2.3/series/1.2.3.4/instances/1.2.3.4.5/frames/9', request().accept]);
    const transcode = target();
    await service.serveFrames(request({ accept: 'multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.4.80' }), transcode);
    assert.equal((await transcode.result()).body.toString(), 'relayed');
  });
  await withService(async (service, object, orthanc) => {
    const t = target();
    await service.serveFrames(request(), t);
    assert.equal((await t.result()).body.toString(), 'relayed', 'JPEG-LS stored object');
  }, { transferSyntax: '1.2.840.10008.1.2.4.80' });
  await withService(async (service, object, orthanc) => {
    fs.rmSync(path.join(process.env.KIN_ORTHANC_STORAGE, object.uuid.slice(0, 2)), { recursive: true, force: true });
    const t = target();
    await service.serveFrames(request(), t);
    assert.equal((await t.result()).body.toString(), 'relayed', 'file not under the mount');
  });
  const previous = process.env.KIN_ORTHANC_STORAGE;
  process.env.KIN_ORTHANC_STORAGE = path.join(os.tmpdir(), 'kin-frames-absent-' + process.pid);
  try {
    const object = syntheticObject(fs.mkdtempSync(path.join(os.tmpdir(), 'kin-frames-elsewhere-'))), orthanc = stubOrthanc(object);
    const service = new DicomFrameService(orthanc), t = target();
    await service.serveFrames(request(), t);
    assert.equal((await t.result()).body.toString(), 'relayed', 'no storage mount: every read is Orthanc\'s');
    assert.ok(!orthanc.calls.some(c => c[0] === 'lookup'), 'without a mount the index is not even consulted');
  } finally { if (previous === undefined) delete process.env.KIN_ORTHANC_STORAGE; else process.env.KIN_ORTHANC_STORAGE = previous; }
});

test('serveFrames: a stored file whose pixel data header disagrees with the index is relayed, not served', async () => {
  await withService(async (service, object, orthanc) => {
    const filePath = path.join(process.env.KIN_ORTHANC_STORAGE, object.uuid.slice(0, 2), object.uuid.slice(2, 4), object.uuid);
    const file = fs.readFileSync(filePath); file.writeUInt32LE(0xffffffff, object.offset + 8); fs.writeFileSync(filePath, file);
    const t = target();
    await service.serveFrames(request(), t);
    assert.equal((await t.result()).body.toString(), 'relayed');
  });
});

test('servePreview: a PNG of the first frame for a direct-readable object, Orthanc\'s preview otherwise', async () => {
  await withService(async (service, object, orthanc) => {
    const t = target();
    await service.servePreview(object.id, t);
    const { status, headers, body } = await t.result();
    assert.equal(status, 200);
    assert.equal(headers['content-type'], 'image/png');
    assert.equal(Number(headers['content-length']), body.length);
    assert.deepEqual([...body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    await assert.rejects(service.servePreview('not-an-id', target()), /찾을 수 없습니다/);
  });
  await withService(async (service, object, orthanc) => {
    const t = target();
    await service.servePreview(object.id, t);
    assert.equal((await t.result()).body.toString(), 'relayed');
    assert.deepEqual(orthanc.calls.at(-1), ['relay', `/instances/${object.id}/preview`, 'image/png']);
  }, { transferSyntax: '1.2.840.10008.1.2.4.90' });
});

test('servePreview: the served PNG carries the object\'s modality and VOI semantics; a LUT-table object is Orthanc\'s', async () => {
  // Review MG-02 through the service: the index's simplified tags (strings) of a CT-like object with rescale and window.
  const ctTags = { BitsStored: '16', HighBit: '15', RescaleSlope: '1', RescaleIntercept: '-1024', WindowCenter: '0', WindowWidth: '400' };
  await withService(async (service, object) => {
    const file = fs.readFileSync(object.filePath); [824, 1024, 1224].forEach((v, i) => file.writeUInt16LE(v, object.offset + 12 + i * 2)); fs.writeFileSync(object.filePath, file);
    const t = target();
    await service.servePreview(object.id, t);
    const { status, body } = await t.result();
    assert.equal(status, 200);
    assert.deepEqual(pngGreys(body), [0, 128, 255]);
  }, undefined, { rows: 1, columns: 3, tags: ctTags });
  await withService(async (service, object) => {
    const file = fs.readFileSync(object.filePath); [4095, 0, 1].forEach((v, i) => file.writeUInt16LE(v, object.offset + 12 + i * 2)); fs.writeFileSync(object.filePath, file);
    const t = target();
    await service.servePreview(object.id, t);
    assert.deepEqual(pngGreys((await t.result()).body), [0, 128, 255], 'signed 12-bit');
  }, undefined, { rows: 1, columns: 3, tags: { BitsStored: '12', HighBit: '11', PixelRepresentation: '1' } });
  await withService(async (service, object, orthanc) => {
    const t = target();
    await service.servePreview(object.id, t);
    assert.equal((await t.result()).body.toString(), 'relayed', 'a VOI LUT table without a window is rendered by Orthanc');
    assert.deepEqual(orthanc.calls.at(-1), ['relay', `/instances/${object.id}/preview`, 'image/png']);
  }, undefined, { rows: 1, columns: 3, tags: { VOILUTSequence: [{ LUTDescriptor: '256\\0\\16' }] } });
  await withService(async (service, object, orthanc) => {
    // The strip's preview of a file that changed size is Orthanc's answer, never a picture of fewer bytes.
    await service.servePreview(object.id, target());
    fs.truncateSync(object.filePath, object.file.length - 2);
    const t = target();
    await service.servePreview(object.id, t);
    assert.equal((await t.result()).body.toString(), 'relayed');
  }, undefined, { rows: 1, columns: 3 });
});

// ── the Orthanc relay's lifetime and the controller's lifetime signal ──

/** A never-finishing Orthanc body: the fetch resolves with headers, the body's first read stays pending. */
function pendingOrthanc() {
  const seen = { cancelled: false, fetchAborted: false, calls: 0 };
  const previous = global.fetch;
  global.fetch = async (_url, init) => {
    seen.calls++;
    return new Response(new ReadableStream({ start() {}, cancel() { seen.cancelled = true; } }), { headers: { 'Content-Type': 'application/octet-stream' } });
  };
  return { seen, restore: () => { global.fetch = previous; } };
}

function relayTarget() {
  const t = new PassThrough(); t.status = () => {}; t.setHeader = () => {}; t.resume();
  return t;
}

async function withOrthancEnv(fn) {
  const saved = { ORTHANC_USER: process.env.ORTHANC_USER, ORTHANC_PASS: process.env.ORTHANC_PASS };
  process.env.ORTHANC_USER = 'synthetic'; process.env.ORTHANC_PASS = 'synthetic';
  try { await fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('relay: the client closing while an Orthanc body read is pending cancels the source and ends the relay', async () => {
  // Review MG-03: before, close only set a flag read on the next chunk, so a frame Orthanc was still producing kept the
  // request (and the whole-file read) alive for nobody. No caller signal here: the response's own close is enough.
  await withOrthancEnv(async () => {
    const { seen, restore } = pendingOrthanc();
    try {
      const orthanc = new OrthancService(), t = relayTarget();
      let settled = null;
      const running = orthanc.relay('/synthetic', '*/*', t).then(() => { settled = 'resolved'; }, () => { settled = 'rejected'; });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(settled, null, 'pending while Orthanc produces nothing');
      t.destroy();   // the viewer's socket closes
      await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('relay did not end after the client closed')), 2000))]);
      assert.equal(settled, 'rejected');
      assert.equal(seen.cancelled, true, 'the Orthanc body was cancelled');
    } finally { restore(); }
  });
});

test('relay: the client closing while the Orthanc headers are still pending aborts the fetch itself', async () => {
  await withOrthancEnv(async () => {
    const previous = global.fetch; let aborted = false;
    global.fetch = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }));
    try {
      const orthanc = new OrthancService(), t = relayTarget();
      const running = orthanc.relay('/synthetic', '*/*', t);
      await new Promise(resolve => setTimeout(resolve, 20));
      t.destroy();
      await assert.rejects(Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('relay did not end')), 2000))]), /Orthanc에 연결할 수 없습니다/);
      assert.equal(aborted, true);
    } finally { global.fetch = previous; }
  });
});

test('relay: a caller\'s signal still ends a pending relay, and a completed relay leaves no close listener behind', async () => {
  await withOrthancEnv(async () => {
    const { seen, restore } = pendingOrthanc();
    try {
      const orthanc = new OrthancService(), t = relayTarget(), abort = new AbortController();
      const running = orthanc.relay('/synthetic', '*/*', t, abort.signal);
      await new Promise(resolve => setTimeout(resolve, 20));
      abort.abort();
      await assert.rejects(Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('relay did not end')), 2000))]));
      assert.equal(seen.cancelled, true);
    } finally { restore(); }
    const previous = global.fetch;
    global.fetch = async () => new Response(Buffer.from('ok'), { headers: { 'Content-Type': 'text/plain', 'Content-Length': '2' } });
    try {
      const orthanc = new OrthancService(), t = relayTarget(), chunks = [];
      t.on('data', c => chunks.push(c));
      await orthanc.relay('/synthetic', '*/*', t);
      assert.equal(Buffer.concat(chunks).toString(), 'ok');
      assert.equal(t.listenerCount('close'), 0, 'the lifetime listener was removed with the relay');
    } finally { global.fetch = previous; }
  });
});

test('controller: the request\'s lifetime signal reaches the service and aborts when the response closes early', async () => {
  const seen = [];
  const service = { serveFrames: async (req, res, signal) => { seen.push(['frames', signal]); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); },
    servePreview: async (id, res, signal) => { seen.push(['preview', signal]); } };
  const pacs = { authzDicom: async () => {} };
  const controller = new DicomFrameController(service, pacs);
  const req = Object.assign(new PassThrough(), { method: 'GET', headers: {}, sub: 'synthetic-doctor', institution: 'site-a' });
  const res = relayTarget();
  const reading = controller.read('1.2.3', '1.2.3.4', '1.2.3.4.5', '1', req, res);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(seen[0][1] instanceof AbortSignal && !seen[0][1].aborted);
  res.destroy();   // closed before writableFinished
  await Promise.race([reading, new Promise((_, reject) => setTimeout(() => reject(new Error('the read did not observe the close')), 2000))]);
  assert.equal(seen[0][1].aborted, true);
  assert.equal(res.listenerCount('close'), 0);
  // A response that finished normally does not abort its own signal on the close that follows the end.
  const res2 = relayTarget();
  const service2 = { servePreview: async (id, r, signal) => { r.end(); await new Promise(resolve => setTimeout(resolve, 10)); seen.push(['preview-signal', signal.aborted]); } };
  await new DicomFrameController(service2, pacs).preview('3fc2d51f-e3bbd38a-db69114e-eef254ef-fcc4744b', req, res2);
  assert.deepEqual(seen.at(-1), ['preview-signal', false]);
  // The 17-frame list the review sent (MG-07) is a request like any other, not a 400.
  const service3 = { serveFrames: async (request) => { seen.push(['list', request.frames.length]); } };
  await new DicomFrameController(service3, pacs).read('1.2.3', '1.2.3.4', '1.2.3.4.5', Array.from({ length: 17 }, (_, i) => i + 1).join(','), req, relayTarget());
  assert.deepEqual(seen.at(-1), ['list', 17]);
});
