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

const EXPLICIT = '1.2.840.10008.1.2.1', IMPLICIT = '1.2.840.10008.1.2';
const facts = (over = {}) => ({ transferSyntax: EXPLICIT, pixelDataOffset: 1000, rows: 4, columns: 3, bitsAllocated: 16,
  samplesPerPixel: 1, numberOfFrames: 5, planarConfiguration: null, photometric: 'MONOCHROME2', pixelRepresentation: 0,
  windowCenter: null, windowWidth: null, fileSize: 1000 + 12 + 4 * 3 * 2 * 5, storedSize: 1000 + 12 + 4 * 3 * 2 * 5, ...over });

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

test('frameRange and parseFrameList: 1-based frames inside the object, bounded lists', () => {
  const l = layout.frameLayout(facts());
  assert.deepEqual(layout.frameRange(l, 1), { start: 1012, end: 1035 });
  assert.deepEqual(layout.frameRange(l, 5), { start: 1012 + 96, end: 1012 + 119 });
  assert.equal(layout.frameRange(l, 6), null);
  assert.equal(layout.frameRange(l, 0), null);
  assert.deepEqual(layout.parseFrameList('1'), [1]);
  assert.deepEqual(layout.parseFrameList('3,1,2'), [3, 1, 2]);
  assert.equal(layout.parseFrameList('0'), null);
  assert.equal(layout.parseFrameList('1,1'), null);
  assert.equal(layout.parseFrameList('1,'), null);
  assert.equal(layout.parseFrameList(Array.from({ length: layout.MAX_FRAMES_PER_REQUEST + 1 }, (_, i) => i + 1).join(',')), null);
});

test('directReadServes: the viewer\'s transfer-syntax=* and the stored syntax are direct; a transcode request is Orthanc\'s', () => {
  assert.equal(layout.directReadServes('multipart/related; type=application/octet-stream; transfer-syntax=*', EXPLICIT), true);
  assert.equal(layout.directReadServes('multipart/related; type="application/octet-stream"; transfer-syntax="1.2.840.10008.1.2.1"', EXPLICIT), true);
  assert.equal(layout.directReadServes(undefined, EXPLICIT), true);
  assert.equal(layout.directReadServes('multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.4.80', EXPLICIT), false);
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

// ── the service over a synthetic stored file and a stub Orthanc index ──

function syntheticObject(dir, shape = {}) {
  const { rows = 4, columns = 3, random = false } = shape;
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
    BitsAllocated: '16', SamplesPerPixel: '1', NumberOfFrames: String(frames), PhotometricInterpretation: 'MONOCHROME2', PixelRepresentation: '0' };
  return { uuid, id, file, frameBytes, offset, tags,
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
  const done = new Promise(resolve => sink.on('end', resolve));
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
