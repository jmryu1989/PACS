'use strict';
/* MG-LOADING: the direct frame reader's contracts (api/src/dicom-frame-layout.ts) and the service's streaming
 * answer (api/src/dicom-frame.service.ts) over a synthetic stored object: which objects it serves itself, the byte
 * range of a frame, the multipart/related shape the viewer parses, gzip negotiation, the URL-hierarchy check and
 * the preview PNG. Synthetic bytes only; Orthanc is a stub source. No Docker here. D73: behaviour, not source text. */
const { EXPLICIT, IMPLICIT, facts, syntheticObject, stubOrthanc, target, request, withService, pngGreys } = require('./dicom_frame_fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { PassThrough } = require('node:stream');

const layout = require('/app/dist/dicom-frame-layout.js');
const { DicomFrameService, firstFrameTransforms } = require('/app/dist/dicom-frame.service.js');
const { DicomFrameController } = require('/app/dist/dicom-frame.controller.js');
const { OrthancService } = require('/app/dist/orthanc.service.js');

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

test('directReadServes: the emitted multipart octet-stream must be acceptable by precedence; anything else is Orthanc\'s', () => {
  assert.equal(layout.directReadServes('multipart/related; type=application/octet-stream; transfer-syntax=*', EXPLICIT), true);
  assert.equal(layout.directReadServes('multipart/related; type="application/octet-stream"; transfer-syntax="1.2.840.10008.1.2.1"', EXPLICIT), true);
  assert.equal(layout.directReadServes('multipart/related; type="application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1"', EXPLICIT), true, 'Orthanc\'s own quoted shape');
  assert.equal(layout.directReadServes('multipart/related; type="application/octet-stream"', EXPLICIT), true, 'no syntax parameter: the stored one');
  assert.equal(layout.directReadServes('multipart/related', EXPLICIT), true);
  assert.equal(layout.directReadServes('multipart/*', EXPLICIT), true);
  assert.equal(layout.directReadServes('*/*', EXPLICIT), true);
  assert.equal(layout.directReadServes(undefined, EXPLICIT), true);
  assert.equal(layout.directReadServes('', EXPLICIT), true);
  assert.equal(layout.directReadServes('multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.4.80', EXPLICIT), false, 'transcode');
  // Review MG-05: a request for another representation has no transfer-syntax parameter but is still not a raw frame read.
  assert.equal(layout.directReadServes('multipart/related; type="image/jpeg"', EXPLICIT), false);
  assert.equal(layout.directReadServes('multipart/related; type="image/jls"; transfer-syntax=*', EXPLICIT), false);
  assert.equal(layout.directReadServes('image/jpeg', EXPLICIT), false);
  assert.equal(layout.directReadServes('multipart/related; type="image/jpeg", multipart/related; type="application/octet-stream"', EXPLICIT), true, 'equally preferred: ours is acceptable');
  assert.equal(layout.directReadServes('multipart/related; type="application/octet-stream"; q=0, image/jpeg', EXPLICIT), false, 'q=0 is not acceptable');
  // Review MG-05, second round (RFC 9110 §12.5.1): the service emits multipart/related only, so a bare application/octet-stream
  // is a representation it does not have; an excluded multipart/related is not rescued by a positive wildcard, because the
  // most specific matching range decides; a more preferred representation this path lacks is left to Orthanc.
  assert.equal(layout.directReadServes('application/octet-stream', EXPLICIT), false, 'bare octet-stream is not what is emitted');
  assert.equal(layout.directReadServes('multipart/related;q=0, */*;q=1', EXPLICIT), false, 'the specific exclusion wins over the wildcard');
  assert.equal(layout.directReadServes('multipart/related; type="application/octet-stream";q=0, */*;q=1', EXPLICIT), false);
  assert.equal(layout.directReadServes('multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.1;q=0, multipart/related;q=1', EXPLICIT), false, 'the named syntax is the most specific match');
  assert.equal(layout.directReadServes('multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.1;q=1, multipart/related;q=0', EXPLICIT), true);
  assert.equal(layout.directReadServes('*/*;q=0.1, multipart/related; type="image/jpeg"', EXPLICIT), false, 'a preferred rendering is Orthanc\'s to offer');
  assert.equal(layout.directReadServes('multipart/related; type="application/octet-stream";q=0.5, image/jpeg;q=0.2', EXPLICIT), true);
  // Representation parameters bind on wildcard ranges as well (RFC 9110 §12.5.1): parts of another type or syntax are not ours.
  assert.equal(layout.directReadServes('multipart/*; type="image/jpeg"', EXPLICIT), false, 'multipart of jpeg parts, whatever the subtype');
  assert.equal(layout.directReadServes('*/*; type="image/jpeg"', EXPLICIT), false);
  assert.equal(layout.directReadServes('*/*; transfer-syntax=1.2.840.10008.1.2.4.80', EXPLICIT), false, 'a transcoded syntax on the full wildcard');
  assert.equal(layout.directReadServes('multipart/*; type="application/octet-stream"; transfer-syntax=*', EXPLICIT), true);
  assert.equal(layout.directReadServes('multipart/*; type="application/octet-stream"', EXPLICIT), true);
  assert.equal(layout.directReadServes('multipart/*; type="image/jpeg", multipart/related; type="application/octet-stream";q=0.5', EXPLICIT), false, 'the jpeg parts are preferred');
  assert.equal(layout.directReadServes('multipart/*; type="image/jpeg";q=0.5, multipart/related; type="application/octet-stream"', EXPLICIT), true);
  assert.equal(layout.directReadServes('multipart/*; type="application/octet-stream";q=0, multipart/related;q=1', EXPLICIT), true, 'the named type with no parameter is the more specific match');
  assert.equal(layout.directReadServes('multipart/related;q=0, multipart/*; type="application/octet-stream";q=1', EXPLICIT), false);
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
  // Review MG-02, second round: a functional-group shape the reader did not resolve is not rendered as if it had none.
  assert.equal(layout.previewPng(ctFrame, { ...ct, unsupportedTransforms: true }, { maxSide: 20 }), null);
});

test('firstFrameTransforms: the enhanced object\'s shared and per-frame groups replace the top-level rescale and window for frame 1', () => {
  // PS3.3 C.7.6.16.2.9/.10 as Orthanc's simplified tags give them: sequences are arrays of items with simplified names.
  const pvt = { PixelValueTransformationSequence: [{ RescaleSlope: '1', RescaleIntercept: '-1024', RescaleType: 'HU' }] };
  const voi = { FrameVOILUTSequence: [{ WindowCenter: '40', WindowWidth: '400', VOILUTFunction: 'LINEAR' }] };
  assert.deepEqual(firstFrameTransforms({ Rows: '1' }), {}, 'no functional groups: the top-level attributes stand');
  assert.deepEqual(firstFrameTransforms({ SharedFunctionalGroupsSequence: [{ ...pvt, ...voi }] }),
    { RescaleSlope: '1', RescaleIntercept: '-1024', WindowCenter: '40', WindowWidth: '400', VOILUTFunction: 'LINEAR' });
  assert.deepEqual(firstFrameTransforms({ PerFrameFunctionalGroupsSequence: [{ ...pvt, ...voi }, { FrameVOILUTSequence: [{ WindowCenter: '0', WindowWidth: '1' }] }] }),
    { RescaleSlope: '1', RescaleIntercept: '-1024', WindowCenter: '40', WindowWidth: '400', VOILUTFunction: 'LINEAR' }, 'frame 1\'s item, not frame 2\'s');
  // The per-frame item of frame 1 overrides the shared group; a present group without a window means no window (min/max), not the top-level window.
  assert.deepEqual(firstFrameTransforms({ WindowCenter: '9', WindowWidth: '9', SharedFunctionalGroupsSequence: [voi],
    PerFrameFunctionalGroupsSequence: [{ FrameVOILUTSequence: [{ WindowCenter: '100', WindowWidth: '200' }] }] }),
    { WindowCenter: '100', WindowWidth: '200', VOILUTFunction: undefined });
  assert.deepEqual(firstFrameTransforms({ SharedFunctionalGroupsSequence: [{ PixelMeasuresSequence: [{ PixelSpacing: '1\\1' }] }] }), {}, 'groups the preview does not use');
  assert.deepEqual(firstFrameTransforms({ SharedFunctionalGroupsSequence: [], PerFrameFunctionalGroupsSequence: [] }), {}, 'empty sequences');
  for (const [name, tags] of [
    ['a non-sequence value', { SharedFunctionalGroupsSequence: 'x' }],
    ['two Pixel Value Transformation items', { SharedFunctionalGroupsSequence: [{ PixelValueTransformationSequence: [{ RescaleSlope: '1' }, { RescaleSlope: '2' }] }] }],
    ['a Modality LUT table inside the group', { SharedFunctionalGroupsSequence: [{ PixelValueTransformationSequence: [{ ModalityLUTSequence: [{ LUTDescriptor: '256\\0\\16' }] }] }] }],
    ['a VOI LUT table inside the group', { SharedFunctionalGroupsSequence: [{ FrameVOILUTSequence: [{ VOILUTSequence: [{ LUTDescriptor: '256\\0\\16' }] }] }] }],
    ['a malformed item', { PerFrameFunctionalGroupsSequence: [{ FrameVOILUTSequence: ['x'] }] }],
  ]) assert.equal(firstFrameTransforms(tags), null, name);
});

// ── the service over a synthetic stored file and a stub Orthanc index ──

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

test('serveFrames: the preload stored form is the gzip stream itself, typed application/gzip, naming the multipart it decodes to', async () => {
  await withService(async (service) => {
    const plain = target();
    await service.serveFrames(request(), plain);
    const expected = await plain.result();
    // With or without Accept-Encoding: a browser would decode Content-Encoding before the preload store sees the bytes.
    for (const acceptEncoding of [undefined, 'gzip, deflate, br']) {
      const t = target();
      await service.serveFrames(request({ stored: true, acceptEncoding }), t);
      const { status, headers, body } = await t.result();
      assert.equal(status, 200);
      assert.equal(headers['content-type'], 'application/gzip');
      assert.equal(headers['content-encoding'], undefined);
      const unbounded = type => type.replace(/boundary=[^;]+/, '');
      assert.equal(unbounded(headers['x-kin-part-type']), unbounded(expected.headers['content-type']), 'the type the plain answer has');
      const decoded = zlib.gunzipSync(body);
      assert.equal(decoded.length, expected.body.length);
      const boundary = /boundary=([^;]+)/.exec(headers['x-kin-part-type'])[1];
      assert.ok(decoded.toString('latin1').startsWith('--' + boundary + '\r\n'), 'the part type names the decoded body\'s boundary');
    }
  });
});

test('controller: a preload read answers the study\'s archive revision; a stored read without one is refused before any lease', async () => {
  const calls = [], leases = [];
  const service = { serveFrames: async (req, res) => { calls.push(req); res.statusCode = 200; res.end(); } };
  const pacs = { authzDicom: async () => {} };
  let revisionFails = false;
  const orthanc = { studyRevision: async uid => { calls.push(['revision', uid]); if (revisionFails) throw new Error('two study resources'); return { id: 'abc', lastUpdate: '20261028T101010' }; } };
  const deliveries = { admit: async (req, surface, study) => { leases.push(study); return { release() {} }; } };
  const controller = new DicomFrameController(service, pacs, orthanc, deliveries);
  const read = async preload => {
    const req = Object.assign(new PassThrough(), { method: 'GET', headers: preload ? { 'x-kin-preload': preload } : {}, sub: 'synthetic-doctor' });
    const res = relayTarget(), headers = {};
    const set = res.setHeader.bind(res);
    res.setHeader = (k, v) => { headers[k.toLowerCase()] = v; return set(k, v); };
    await controller.read('1.2.3', '1.2.3.4', '1.2.3.4.5', '1', req, res);
    return headers;
  };
  assert.equal((await read('store'))['x-kin-study-revision'], 'orthanc-study:abc@20261028T101010');
  assert.equal(calls.at(-1).stored, true);
  assert.equal((await read('check'))['x-kin-study-revision'], 'orthanc-study:abc@20261028T101010');
  assert.equal(calls.at(-1).stored, false);
  calls.length = 0;
  assert.equal((await read(null))['x-kin-study-revision'], undefined);
  assert.deepEqual(calls.filter(c => Array.isArray(c)), [], 'an ordinary read asks the archive nothing more');
  assert.equal(calls.at(-1).stored, false);
  assert.equal(leases.length, 3, 'every read, preload or not, takes the study delivery lease (D1877)');
  revisionFails = true;
  assert.equal((await read('check'))['x-kin-study-revision'], undefined, 'a check read is served; the viewer sees no match and stays live');
  await assert.rejects(read('store'), /two study resources/);
  assert.equal(leases.length, 4, 'the refused stored read opened no delivery');
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

test('servePreview: an enhanced object\'s functional-group transforms are applied to frame 1, or the preview is Orthanc\'s', async () => {
  // Review MG-02, second round. Stored [824, 1024, 1224], intercept -1024 → [-200, 0, 200]; window 40/400 LINEAR maps them to
  // 0, 102 and 230 (PS3.3 C.11.2.1.2.1), whether the groups are shared or per frame. Treating the transforms as absent gave 0/128/255.
  const group = { PixelValueTransformationSequence: [{ RescaleSlope: '1', RescaleIntercept: '-1024', RescaleType: 'HU' }],
    FrameVOILUTSequence: [{ WindowCenter: '40', WindowWidth: '400', VOILUTFunction: 'LINEAR' }] };
  for (const location of ['SharedFunctionalGroupsSequence', 'PerFrameFunctionalGroupsSequence']) {
    await withService(async (service, object, orthanc) => {
      const t = target();
      await service.servePreview(object.id, t);
      const { status, body } = await t.result();
      assert.equal(status, 200);
      assert.deepEqual(pngGreys(body), [0, 102, 230], location);
      assert.ok(!orthanc.calls.some(c => c[0] === 'relay'));
    }, undefined, { rows: 1, columns: 3, values: [824, 1024, 1224], tags: { SOPClassUID: '1.2.840.10008.5.1.4.1.1.2.1', [location]: [group] } });
  }
  // The per-frame window of frame 1 wins over the shared one; a top-level window is not frame 1's.
  await withService(async (service, object) => {
    const t = target();
    await service.servePreview(object.id, t);
    assert.deepEqual(pngGreys((await t.result()).body), [0, 102, 230]);
  }, undefined, { rows: 1, columns: 3, values: [824, 1024, 1224], tags: { WindowCenter: '0', WindowWidth: '1',
    SharedFunctionalGroupsSequence: [{ PixelValueTransformationSequence: group.PixelValueTransformationSequence, FrameVOILUTSequence: [{ WindowCenter: '0', WindowWidth: '1' }] }],
    PerFrameFunctionalGroupsSequence: [{ FrameVOILUTSequence: group.FrameVOILUTSequence }] } });
  // A LUT table inside a frame group is a transform this renderer does not apply: Orthanc's renderer answers, visibly not a silent identity.
  await withService(async (service, object, orthanc) => {
    const t = target();
    await service.servePreview(object.id, t);
    assert.equal((await t.result()).body.toString(), 'relayed');
    assert.deepEqual(orthanc.calls.at(-1), ['relay', `/instances/${object.id}/preview`, 'image/png']);
    // The frames of the same object are still a byte range: the transforms concern the rendering, not the stored bytes.
    const frames = target();
    await service.serveFrames(request({ frames: [1] }), frames);
    assert.equal((await frames.result()).status, 200);
    assert.ok(!orthanc.calls.slice(-1).some(c => c[0] === 'relay'));
  }, undefined, { rows: 1, columns: 3, values: [824, 1024, 1224], tags: { SharedFunctionalGroupsSequence: [{ FrameVOILUTSequence: [{ VOILUTSequence: [{ LUTDescriptor: '256\\0\\16' }] }] }] } });
});

test('description: a request that leaves while a shared description is read does not cancel it for the others', async () => {
  // Review MG-03, second round: two cold previews of one object share one frameFacts read. Closing the first client
  // must fail only that client; the second keeps its description. Only when the last waiting client leaves is the source read stopped.
  await withService(async (service, object, orthanc) => {
    let entered, sharedSignal, calls = 0;
    const started = new Promise(resolve => { entered = resolve; });
    const source = orthanc.frameFacts.bind(orthanc);
    orthanc.frameFacts = async (id, signal) => {
      calls++; sharedSignal = signal; entered();
      await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('source cancelled')), { once: true }); setTimeout(resolve, 60); });
      return source(id);
    };
    const first = new AbortController(), second = new AbortController();
    const t1 = target(), t2 = target();
    const p1 = service.servePreview(object.id, t1, first.signal).then(() => 'fulfilled', e => 'rejected:' + e.message);
    await started;
    const p2 = service.servePreview(object.id, t2, second.signal).then(() => 'fulfilled', e => 'rejected:' + e.message);
    await new Promise(resolve => setImmediate(resolve));
    first.abort();   // the first pane closed
    assert.equal(await p1, 'rejected:영상 요청이 중단되었습니다');
    assert.equal(sharedSignal.aborted, false, 'the shared source read goes on for the second client');
    assert.equal(await p2, 'fulfilled');
    assert.equal((await t2.result()).status, 200);
    assert.equal(calls, 1, 'one description for both');
    // A later request is served from the completed description (no second read).
    const t3 = target();
    await service.servePreview(object.id, t3);
    assert.equal((await t3.result()).status, 200);
    assert.equal(calls, 1);
  });
  // When every waiting client has left, the source read is cancelled and the next request describes afresh.
  await withService(async (service, object, orthanc) => {
    let entered, sharedSignal, calls = 0;
    const started = new Promise(resolve => { entered = resolve; });
    const source = orthanc.frameFacts.bind(orthanc);
    orthanc.frameFacts = async (id, signal) => {
      calls++; sharedSignal = signal; entered();
      await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('source cancelled')), { once: true }); setTimeout(resolve, 60); });
      return source(id);
    };
    const only = new AbortController(), t = target();
    const p = service.servePreview(object.id, t, only.signal).then(() => 'fulfilled', e => 'rejected');
    await started;
    only.abort();
    assert.equal(await p, 'rejected');
    assert.equal(sharedSignal.aborted, true, 'nobody waits: the source read stops');
    orthanc.frameFacts = source;
    const again = target();
    await service.servePreview(object.id, again);
    assert.equal((await again.result()).status, 200);
    assert.equal(calls, 1, 'the cancelled read was not reused; the stub\'s plain read answered');
  });
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

/** A response double: status code as Express keeps it (200 until set), headers dropped, body drained. */
function relayTarget() {
  const t = new PassThrough(); t.statusCode = 200; t.status = code => { t.statusCode = code; return t; }; t.setHeader = () => {}; t.resume();
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
  const seen = [], leases = [];
  const service = { serveFrames: async (req, res, signal) => { seen.push(['frames', signal]); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); },
    servePreview: async (id, res, signal) => { seen.push(['preview', signal]); } };
  const pacs = { authzDicom: async () => {} };
  const orthanc = { instanceStudyUid: async () => '1.2.3' };
  // The delivery recorder's admission is awaited before the service is called; its lease is released with the response's close.
  const deliveries = { admit: async (req, surface, study) => { const lease = { surface, study, released: null }; leases.push(lease); return { release: finished => { lease.released = finished; } }; } };
  const controller = new DicomFrameController(service, pacs, orthanc, deliveries);
  const req = Object.assign(new PassThrough(), { method: 'GET', headers: {}, sub: 'synthetic-doctor', institution: 'site-a' });
  const res = relayTarget();
  const reading = controller.read('1.2.3', '1.2.3.4', '1.2.3.4.5', '1', req, res);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(seen[0][1] instanceof AbortSignal && !seen[0][1].aborted);
  assert.deepEqual([leases[0].surface, leases[0].study, leases[0].released], ['GET dicom-web/studies/:study/series/:series/instances/:sop/frames/:frames', '1.2.3', null]);
  res.destroy();   // closed before writableFinished
  await Promise.race([reading, new Promise((_, reject) => setTimeout(() => reject(new Error('the read did not observe the close')), 2000))]);
  assert.equal(seen[0][1].aborted, true);
  assert.equal(res.listenerCount('close'), 0);
  assert.equal(leases[0].released, false, 'a response cut short releases its lease as unfinished');
  // A response that finished normally does not abort its own signal on the close that follows the end.
  const res2 = relayTarget();
  const service2 = { servePreview: async (id, r, signal) => { r.end(); await new Promise(resolve => setTimeout(resolve, 10)); seen.push(['preview-signal', signal.aborted]); } };
  await new DicomFrameController(service2, pacs, orthanc, deliveries).preview('3fc2d51f-e3bbd38a-db69114e-eef254ef-fcc4744b', req, res2);
  assert.deepEqual(seen.at(-1), ['preview-signal', false]);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual([leases[1].surface, leases[1].study, leases[1].released], ['GET instances/:id/preview', '1.2.3', true]);
  // A service that failed before any image byte: the exception filter then writes the error answer and finishes the
  // socket, which is no image served (MG-10). The lease waits for that close rather than deciding at the failure.
  const res3 = relayTarget();
  const failing = { servePreview: async () => { throw new Error('synthetic source failure'); } };
  await assert.rejects(new DicomFrameController(failing, pacs, orthanc, deliveries).preview('3fc2d51f-e3bbd38a-db69114e-eef254ef-fcc4744b', req, res3), /synthetic source failure/);
  assert.equal(leases[2].released, null, 'undecided until the response closes');
  res3.status(503); res3.end('{"code":"synthetic"}');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(leases[2].released, false, 'an error answer sent to its end is not an image served');
  // A relayed non-success answer (Orthanc's 404 for a frame it does not have) finishes the socket and is no image either.
  const res4 = relayTarget();
  const relayed = { servePreview: async (id, r) => { r.status(404); r.end('no such frame'); } };
  await new DicomFrameController(relayed, pacs, orthanc, deliveries).preview('3fc2d51f-e3bbd38a-db69114e-eef254ef-fcc4744b', req, res4);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(leases[3].released, false);
  // The 17-frame list the review sent (MG-07) is a request like any other, not a 400.
  const service3 = { serveFrames: async (request) => { seen.push(['list', request.frames.length]); } };
  await new DicomFrameController(service3, pacs, orthanc, deliveries).read('1.2.3', '1.2.3.4', '1.2.3.4.5', Array.from({ length: 17 }, (_, i) => i + 1).join(','), req, relayTarget());
  assert.deepEqual(seen.at(-1), ['list', 17]);
  // No admission, no service call: a recorder that refuses leaves the gate's refusal in place and sends nothing.
  const refusing = { admit: async () => { throw new Error('ledger down'); } };
  const service4 = { serveFrames: async () => { seen.push(['served-without-record']); } };
  await assert.rejects(new DicomFrameController(service4, pacs, orthanc, refusing).read('1.2.3', '1.2.3.4', '1.2.3.4.5', '1', req, relayTarget()), /ledger down/);
  assert.ok(!seen.some(s => s[0] === 'served-without-record'));
});
