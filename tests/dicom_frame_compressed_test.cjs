'use strict';
// REQ-MG-LOADING-FRAME -> RISK-MG-FRAME-WRONG-BYTES/SLOW-OPEN -> TEST-MG-COMPRESSED.
// Behavioral byte/transport tests. The opaque payloads here test extraction, not codec correctness;
// scripts/mg_compressed_fixture.py builds real encoded EA1141 derivatives for the served decoder run.
const { facts, syntheticObject, stubOrthanc, target, request } = require('./dicom_frame_fixture.cjs');
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const { encapsulatedLayout, ENCAPSULATED_MEDIA } = require('/app/dist/dicom-frame-encapsulated.js');
const { DicomFrameService } = require('/app/dist/dicom-frame.service.js');
const { directReadServes } = require('/app/dist/dicom-frame-layout.js');

const item = (tag, bytes) => { const h = Buffer.alloc(8); h.writeUInt32LE(tag); h.writeUInt32LE(bytes.length, 4); return Buffer.concat([h, bytes]); };
function encoded(frames, table = true) {
  const head = Buffer.from('e07f10004f420000ffffffff', 'hex'), bot = Buffer.alloc(table ? frames.length * 4 : 0);
  let offset = 0;
  const fragments = frames.flatMap((frame, i) => {
    if (table) bot.writeUInt32LE(offset, i * 4);
    return frame.map(bytes => { const out = item(0xe000fffe, bytes); offset += out.length; return out; });
  });
  return Buffer.concat([Buffer.alloc(1000), head, item(0xe000fffe, bot), ...fragments, item(0xe0ddfffe, Buffer.alloc(0))]);
}
const payloads = [[Buffer.from([1, 2, 3, 4])], [Buffer.from([11, 12]), Buffer.from([13, 14, 15, 16])], [Buffer.from([21, 22])]];
const accept = [...new Set(['application/octet-stream', ...ENCAPSULATED_MEDIA.values()])]
  .map(type => `multipart/related; type=${type}; transfer-syntax=*`).join(', ');
async function setup(syntax, frames, fn, table = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-compressed-'));
  const previous = process.env.KIN_ORTHANC_STORAGE; process.env.KIN_ORTHANC_STORAGE = dir;
  try {
    const object = syntheticObject(dir), file = encoded(frames, table);
    fs.writeFileSync(object.filePath, file); object.file = file;
    object.tags.NumberOfFrames = String(frames.length);
    object.attachment.UncompressedSize = object.attachment.CompressedSize = file.length;
    const orthanc = stubOrthanc(object, { transferSyntax: syntax });
    await fn(new DicomFrameService(orthanc), object, orthanc);
  } finally {
    if (previous === undefined) delete process.env.KIN_ORTHANC_STORAGE; else process.env.KIN_ORTHANC_STORAGE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function parts(answer) {
  const type = answer.headers['x-kin-part-type'] || answer.headers['content-type'];
  const boundary = type.split('boundary=')[1];
  const body = answer.headers['content-encoding'] === 'gzip' || answer.headers['x-kin-part-type'] ? zlib.gunzipSync(answer.body) : answer.body;
  return body.toString('latin1').split('--' + boundary).slice(1, -1).map(part => {
    const split = part.indexOf('\r\n\r\n'), headers = part.slice(0, split);
    const bytes = Buffer.from(part.slice(split + 4, -2), 'latin1');
    assert.equal(Number(/Content-Length: (\d+)/.exec(headers)[1]), bytes.length);
    return { headers, bytes };
  });
}

for (const [syntax, media] of ENCAPSULATED_MEDIA) test(`native ${syntax}: requested frames only, exact media/length, no transcode, HEAD and preload`, async () => {
  const frames = syntax.endsWith('.5') ? payloads.map(p => [Buffer.concat(p)]) : payloads;
  await setup(syntax, frames, async (service, object, archive) => {
    for (const stored of [false, true]) {
      const sink = target();
      await service.serveFrames(request({ accept, frames: [3, 2, 2], stored, acceptEncoding: 'gzip' }), sink);
      const answer = await sink.result(), decoded = parts(answer);
      assert.equal(answer.status, 200);
      assert.deepEqual(decoded.map(p => p.bytes), [frames[2], frames[1], frames[1]].map(p => Buffer.concat(p)));
      assert.ok(decoded.every(p => p.headers.includes(`Content-Type: ${media}; transfer-syntax=${syntax}`)));
      if (!stored) { assert.equal(answer.headers['content-encoding'], undefined); assert.equal(Number(answer.headers['content-length']), answer.body.length); }
    }
    const head = target(); await service.serveFrames(request({ accept, head: true }), head);
    const result = await head.result(); assert.equal(result.body.length, 0); assert.ok(Number(result.headers['content-length']) > 0);
    assert.equal(archive.calls.filter(c => c[0] === 'relay').length, 0);
    assert.equal(archive.calls.filter(c => c[0] === 'facts').length, 1, 'immutable fragment index reused');
  });
});

test('encapsulation scan reads headers/table only and never a compressed payload', async () => {
  const file = encoded(payloads), reads = [];
  const l = await encapsulatedLayout(facts({ transferSyntax: '1.2.840.10008.1.2.4.90', numberOfFrames: 3, fileSize: file.length, storedSize: file.length }), async (at, n) => {
    reads.push([at, n]); return file.subarray(at, at + n);
  });
  assert.equal(l.encapsulated.length, 3);
  for (const frame of l.encapsulated) for (const span of frame) {
    assert.ok(reads.every(([at, n]) => at + n <= span.start || at > span.end));
  }
  assert.equal(reads.reduce((n, r) => n + r[1], 0), 12 + 8 + 12 + 4 * 8 + 8);
});

test('empty BOT: single-frame fragments and one fragment per frame are unambiguous; ambiguous grouping relays', async () => {
  for (const frames of [[payloads.flat()], payloads.map(p => [Buffer.concat(p)])]) {
    await setup('1.2.840.10008.1.2.4.90', frames, async (service, object, archive) => {
      const sink = target(); await service.serveFrames(request({ accept, frames: [1] }), sink);
      assert.deepEqual(parts(await sink.result())[0].bytes, Buffer.concat(frames[0]));
      assert.equal(archive.calls.some(c => c[0] === 'relay'), false);
    }, false);
  }
  await setup('1.2.840.10008.1.2.4.90', payloads, async (service, object, archive) => {
    const sink = target(); await service.serveFrames(request({ accept }), sink);
    assert.equal((await sink.result()).headers['content-type'], 'relayed');
  }, false);
});

test('malformed BOT, item length, delimiter and short source never return a direct frame', async () => {
  const source = encoded(payloads);
  for (const damage of [b => b.writeUInt32LE(1, 1020), b => b.writeUInt32LE(1, 1024),
    b => b.writeUInt32LE(0xffffffff, 1036), b => b.writeUInt32LE(3, 1036), b => b.writeUInt32LE(2, b.length - 4)]) {
    const file = Buffer.from(source); damage(file);
    const actual = await encapsulatedLayout(facts({ transferSyntax: '1.2.840.10008.1.2.4.90', numberOfFrames: 3,
      fileSize: file.length, storedSize: file.length }), async (at, n) => file.subarray(at, at + n));
    assert.equal(actual, null);
  }
  await assert.rejects(encapsulatedLayout(facts({ transferSyntax: '1.2.840.10008.1.2.4.90', numberOfFrames: 3,
    fileSize: source.length, storedSize: source.length }), async (at, n) => source.subarray(0, -5).subarray(at, at + n)), /Incomplete/);
});

test('MG-01: a compressed fragment truncated after headers aborts, without closing multipart', async () => {
  await setup('1.2.840.10008.1.2.4.90', payloads, async (service, object) => {
    const sink = target(), setHeader = sink.setHeader;
    sink.setHeader = (name, value) => { setHeader(name, value); if (name === 'Content-Type') fs.truncateSync(object.filePath, 1040); };
    await assert.rejects(service.serveFrames(request({ accept }), sink), /short read/);
    const answer = await sink.result(); assert.equal(sink.writableFinished, false);
    assert.equal(answer.body.includes(Buffer.from('--' + answer.headers['content-type'].split('boundary=')[1] + '--')), false);
  });
});

test('compressed selection retains hierarchy, delivery lease, revision and negotiation boundaries', async () => {
  await setup('1.2.840.10008.1.2.4.90', payloads, async (service, object, archive) => {
    let leases = 0;
    const lease = async () => { leases++; return { binding: { patient: { patientId: 'SYN-PID-1' }, revision: 'rev-1' }, confirm: async () => true }; };
    await assert.rejects(service.serveFrames(request({ accept, studyUid: '9.9' }), target(), undefined, lease), /검사/);
    assert.equal(leases, 0);
    const sink = target(); await service.serveFrames(request({ accept, revision: true }), sink, undefined, lease);
    assert.equal(leases, 1); assert.equal((await sink.result()).headers['x-kin-study-revision'], 'rev-1');
    const relay = target(); await service.serveFrames(request({ accept: 'multipart/related; type=application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1' }), relay);
    assert.equal((await relay.result()).headers['content-type'], 'relayed');
    assert.equal(directReadServes('multipart/related; type=image/jp2; q=0, */*', '1.2.840.10008.1.2.4.90', 'image/jp2'), false);
    const preview = target(); await service.servePreview(object.id, preview);
    assert.equal((await preview.result()).headers['content-type'], 'relayed', 'compressed bytes are never interpreted as grey pixels');
  });
});
