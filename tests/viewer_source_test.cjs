// D-MEASURE2 B1/B2/B3: compiled services, synthetic local HTTP only. No DB,
// credentials or external network. Full list/Prisma coverage remains E2E.
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http');
const { Logger } = require('/app/node_modules/@nestjs/common');
const { OrthancService } = require('/app/dist/orthanc.service');
const { ViewerService } = require('/app/dist/viewer.service');
const { warnViewerSource } = require('/app/dist/viewer-source-warning');
const secret = 'SYNTHETIC-PHI-UID-password';

test('B2: classified warnings, body cancellation, no sensitive content and bounded repeats', async t => {
  let mode = 'ok', closes = 0;
  const warnings = [], warn = Logger.prototype.warn, originalFetch = global.fetch;
  Logger.prototype.warn = function (message) { warnings.push(message); };
  const server = http.createServer((req, res) => {
    res.on('close', () => closes++);
    if (mode === '401' || mode === '404' || mode === '503') { res.writeHead(Number(mode)); return res.end(secret); }
    if (mode === 'large') return res.end(' '.repeat(262145));
    if (mode === 'decode') return res.end(Buffer.from([0xc0, 0xaf]));
    if (mode === 'parse') return res.end(secret);
    if (mode === 'stall') { res.writeHead(200); res.write('{'); return; }
    res.end(JSON.stringify([{ '0020000D': { Value: ['2.25.1'] } }]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.ORTHANC_USER = secret; process.env.ORTHANC_PASS = secret;
  const orthanc = new OrthancService(); orthanc.base = 'http://127.0.0.1:' + server.address().port;
  const reject = promise => assert.rejects(promise, error => {
    assert.equal(error.getStatus(), 503);
    assert.doesNotMatch(JSON.stringify(error.getResponse()), /SYNTHETIC|category|http_401/); return true;
  });
  try {
    await orthanc.reportPreviewStudy('2.25.1'); assert.deepEqual(warnings, []);
    for (const [fault, category] of [['401','http_401'], ['404','http_404'], ['503','http_other'],
      ['large','size_limit'], ['decode','decode'], ['parse','parse']]) {
      mode = fault;
      await reject(orthanc.reportPreviewStudy('2.25.1'));
      assert.equal(warnings.at(-1), 'viewer_source category=' + category);
      const count = warnings.length;
      await reject(orthanc.viewerJson('/' + secret, secret)); assert.equal(warnings.length, count);
    }
    mode = 'stall';
    const controller = new AbortController(), cancel = setTimeout(() => controller.abort(), 50);
    await reject(orthanc.viewerJson('/' + secret, undefined, controller.signal)); clearTimeout(cancel);
    assert.equal(warnings.at(-1), 'viewer_source category=parent_abort');
    const before = closes, start = performance.now();
    await reject(orthanc.viewerJson('/' + secret));
    assert.ok(performance.now() - start >= 4900 && performance.now() - start < 6500);
    assert.equal(warnings.at(-1), 'viewer_source category=timeout');
    await new Promise(resolve => setTimeout(resolve, 30)); assert.ok(closes > before);
    global.fetch = async () => { throw new TypeError(secret); };
    await reject(orthanc.viewerJson('/' + secret)); assert.equal(warnings.at(-1), 'viewer_source category=transport');
    global.fetch = async () => { throw new Error(secret); };
    await reject(orthanc.viewerJson('/' + secret)); assert.equal(warnings.at(-1), 'viewer_source category=unexpected');
    global.fetch = async () => new Response(null, { status: 200 });
    await reject(orthanc.viewerJson('/' + secret)); assert.equal(warnings.at(-1), 'viewer_source category=missing_body');
    assert.ok(warnings.every(x => /^viewer_source category=[a-z_0-9]+$/.test(x)));
    assert.doesNotMatch(JSON.stringify(warnings), /SYNTHETIC|127\.0\.0\.1|2\.25\.1/);
    const count = warnings.length;
    for (let i = 0; i < 10000; i++) warnViewerSource('timeout');
    assert.equal(warnings.length, count);
    const later = performance.now() + 30001;
    const clock = t.mock.method(performance, 'now', () => later);
    warnViewerSource('timeout'); assert.equal(warnings.length, count + 1);
    clock.mock.restore();
  } finally {
    global.fetch = originalFetch; Logger.prototype.warn = warn;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('B1/B2/B3: actual verification deadline, digest comparison and final access check', async () => {
  const warnings = [], warn = Logger.prototype.warn;
  Logger.prototype.warn = function (message) { warnings.push(message); };
  const uid = '2.25.1', item = { kind: 'length', seriesUid: '2.25.2', sopUid: '2.25.3', frame: 1,
    frameOfReferenceUid: '2.25.4', points: [[0,0,0],[10,0,0]], viewPlaneNormal: [0,0,1], viewUp: [0,1,0], sourceDigest: 'a'.repeat(32) };
  const tags = { StudyInstanceUID: uid, SeriesInstanceUID: item.seriesUid, SOPInstanceUID: item.sopUid,
    FrameOfReferenceUID: item.frameOfReferenceUid, SOPClassUID: '1.2.840.10008.5.1.4.1.1.2', Modality: 'CT',
    Rows: '32', Columns: '32', ImagePositionPatient: '0\\0\\0', ImageOrientationPatient: '1\\0\\0\\0\\1\\0', PixelSpacing: '1\\1', _kinSourceDigest: item.sourceDigest };
  let access = true, checks = 0;
  const prisma = { studyState: { findUnique: async () => { checks++; return { institutionId: access ? 'ours' : 'other' }; } } };
  const source = { viewerReference: async () => tags }, service = new ViewerService(prisma, source);
  const head = () => ({ item: structuredClone(item) }), caller = { institution: 'ours' };
  try {
    const equal = head(); await service.verifyMeasurements(uid, [equal], caller);
    assert.equal(equal.referenceStatus, 'verified'); assert.deepEqual(warnings, []);
    const different = head(); different.item.sourceDigest = 'b'.repeat(32);
    await service.verifyMeasurements(uid, [different], caller); assert.equal(different.referenceStatus, 'unverified');
    assert.equal(warnings.at(-1), 'viewer_source category=digest_mismatch');
    const invalid = head(); invalid.item.seriesUid = '2.25.9';
    await service.verifyMeasurements(uid, [invalid], caller); assert.equal(invalid.referenceStatus, 'unverified');
    assert.equal(warnings.at(-1), 'viewer_source category=reference_invalid');
    let active = 0, peak = 0, starts = 0;
    source.viewerReference = async (_, __, signal) => {
      starts++; active++; peak = Math.max(peak, active);
      try { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return tags; }
      finally { active--; }
    };
    const heads = Array.from({ length: 8 }, (_, i) => ({ item: { ...item, sopUid: '2.25.' + (10 + i) } }));
    const start = performance.now(); await service.verifyMeasurements(uid, heads, caller);
    assert.ok(performance.now() - start >= 2900 && performance.now() - start < 4500);
    assert.equal(starts, 4); assert.equal(peak, 4); assert.equal(active, 0);
    assert.ok(heads.every(h => h.referenceStatus === 'unverified'));
    assert.equal(warnings.at(-1), 'viewer_source category=page_deadline');
    source.viewerReference = async () => { access = false; return tags; };
    await assert.rejects(service.verifyMeasurements(uid, [head()], caller), error => error.getStatus() === 403);
    assert.equal(checks, 5); assert.deepEqual(head().item, item);
  } finally { Logger.prototype.warn = warn; }
});
