// REQ-D05B-INPUT/IDENTITY: exercise the compiled production parser, not a copy.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const v = require('/app/dist/viewer-input.js');
const raw = x => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x));
const item = { schemaVersion: 1, kind: 'arrow', seriesUid: '2.25.2', sopUid: '2.25.3', frame: 1,
  frameOfReferenceUid: '2.25.4', label: '', points: [[0, 0, 0], [1, 1, 0]] };
const body = { requestId: '00000000-0000-4000-8000-000000000001', item };
const tags = { StudyInstanceUID: '2.25.1', SeriesInstanceUID: item.seriesUid, SOPInstanceUID: item.sopUid,
  FrameOfReferenceUID: item.frameOfReferenceUid, SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
  Rows: '32', Columns: '32', ImagePositionPatient: '0\\0\\0', ImageOrientationPatient: '1\\0\\0\\0\\1\\0', PixelSpacing: '1\\1' };
const reject = fn => assert.throws(fn, e => e.getStatus?.() === 400);
test('raw syntax, decoded duplicate keys, bounded depth/UTF8 and finite numbers', () => {
  for (const bad of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"item":{"x":1,"x":2}}',
    '1e999', '01', '1.', '[1,]', '{"x":1,}', 'null false', 'NaN', '"\\ud800"', '"\\udc00"', '"\\u0000"',
    '"line\n"', '['.repeat(18) + '0' + ']'.repeat(18)]) reject(() => v.viewerJson(raw(bad)));
  reject(() => v.viewerJson(Buffer.from([0xc0, 0xaf])));
  reject(() => v.viewerJson(raw(' '.repeat(32769))));
  assert.equal(v.viewerJson(raw('"\\ud83d\\ude00"')), '😀');
  assert.deepEqual([...v.viewerJson(raw('[1,1.0,1e0,-0]'))].slice(0, 3), [1, 1, 1]);
});
test('strict DTO and Unicode code point limits', () => {
  assert.equal(v.viewerCommand(raw({ ...body, item: { ...item, label: '😀'.repeat(1000) } }), true).item.label.length, 2000);
  for (const bad of [{ ...body, author: 'forged' }, { ...body, item: { ...item, cachedStats: {} } },
    { ...body, item: { ...item, label: '😀'.repeat(1001) } }, { ...body, item: { ...item, points: [[0, 0, 0]] } },
    { ...body, item: { ...item, frame: 0 } }, { ...body, item: { ...item, frame: 1.1 } },
    { ...body, item: { ...item, frame: true } }, { ...body, item: { ...item, schemaVersion: 2 } }]) reject(() => v.viewerCommand(raw(bad), true));
  reject(() => v.viewerCommand(raw({ ...body, expectedRevision: 1, action: 'hide' }), false));
  assert.equal(v.viewerCommand(raw({ ...body, expectedRevision: 1, action: 'hide', reason: '사유' }), false).action, 'hide');
});
test('canonical command semantic equality and significant text/array order', () => {
  const fingerprint = s => v.viewerFingerprint('2.25.1', null, v.viewerCommand(raw(s), true));
  assert.equal(fingerprint(body), fingerprint(JSON.stringify(body).replace('"frame":1', '"frame":1e0').replace('"label":""', '"label": ""')));
  assert.equal(fingerprint(body), fingerprint({ item, requestId: body.requestId }));
  assert.equal(fingerprint(body), fingerprint({ ...body, item: { ...item, points: [[-0, 0, 0], [1, 1, 0]] } }));
  assert.notEqual(fingerprint(body), fingerprint({ ...body, item: { ...item, points: [...item.points].reverse() } }));
  assert.notEqual(fingerprint({ ...body, item: { ...item, label: 'é' } }), fingerprint({ ...body, item: { ...item, label: 'é' } }));
});
test('page and identity fail closed including repeated query keys', () => {
  for (const q of [{ limit: '0' }, { limit: '101' }, { cursor: ['1'] }, { limit: ['1'] }, { cursor: '1.0' }, { extra: '1' }]) reject(() => v.viewerPage(q, true));
  assert.deepEqual(v.viewerPage({ limit: '100', cursor: '9' }, true), { limit: 100, cursor: 9, includeHidden: false, recheck: null });
  const id = '00000000-0000-4000-8000-000000000001';
  assert.equal(v.viewerPage({ recheck: id }).recheck, id);
  for (const q of [{recheck: [id]}, {recheck: ''}, {recheck: id, cursor: id}]) reject(()=>v.viewerPage(q));
  reject(()=>v.viewerPage({recheck: id}, true));
  for (const uid of ['1', '1.02', '2.', '2.25.' + '1'.repeat(64), 'https://x', 1]) reject(() => v.viewerUid(uid));
});
test('actual metadata contract: missing/malformed identity, integer and frame tags', () => {
  v.verifyViewerReference('2.25.1', item, tags);
  for (const change of [{ StudyInstanceUID: '2.25.9' }, { SeriesInstanceUID: '2.25.9' }, { SOPInstanceUID: '2.25.9' },
    { FrameOfReferenceUID: '2.25.9' }, { NumberOfFrames: '0' }, { NumberOfFrames: '1.0' }, { NumberOfFrames: '2' },
    { Rows: '' }, { Rows: '1.0' }, { Columns: '65536' }, { PixelSpacing: '0\\1' }, { ImagePositionPatient: 'Infinity\\0\\0' },
    { ImageOrientationPatient: '1\\0\\0\\1\\0\\0' }]) reject(() => v.verifyViewerReference('2.25.1', item, { ...tags, ...change }));
  const key = { schemaVersion: 1, kind: 'key', seriesUid: item.seriesUid, sopUid: item.sopUid, frame: 3, title: '', description: '' };
  const multi = { ...tags, SOPClassUID: '1.2.840.10008.5.1.4.1.1.3.1', NumberOfFrames: '3' };
  v.verifyViewerReference('2.25.1', key, multi);
  reject(() => v.verifyViewerReference('2.25.1', { ...key, frame: 4 }, multi));
  reject(() => v.verifyViewerReference('2.25.1', key, { ...multi, NumberOfFrames: undefined }));
});
test('plane/edge bounds, swapped spacing, oblique and rounded IOP preserve input', () => {
  for (const orientation of [[1,0,0,0,1,0], [0,1,0,0,0,1], [0,0,1,1,0,0], [-1,0,0,0,-1,0],
    [.70710678,.70710678,0,-.61237244,.61237244,.5]]) {
    const origin = [10000, -20000, 30000], spacing = [.7, 1.3], u = orientation.slice(0,3), w = orientation.slice(3);
    const point = (column, row) => origin.map((x,i) => x + column*spacing[1]*u[i] + row*spacing[0]*w[i]);
    const actual = { ...tags, ImagePositionPatient: origin, ImageOrientationPatient: orientation, PixelSpacing: spacing };
    const arrow = { ...item, points: [point(-.5,-.5), point(31.5,31.5)] }, before = JSON.stringify(arrow);
    v.verifyViewerReference('2.25.1', arrow, actual); assert.equal(JSON.stringify(arrow), before);
    reject(() => v.verifyViewerReference('2.25.1', { ...arrow, points: [point(-.502,0), point(0,0)] }, actual));
    const n = [u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]];
    reject(() => v.verifyViewerReference('2.25.1', { ...arrow, points: [origin.map((x,i) => x+n[i]*.002), point(0,0)] }, actual));
  }
});

test('bounded Orthanc reference lookup refuses duplicate/missing IDs, redirect and large bodies', async () => {
  const http = require('node:http');
  let mode = 'normal';
  const id = 'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee';
  const server = http.createServer((req, res) => {
    if (mode === 'redirect') { res.writeHead(302, { Location: '/other' }); return res.end(); }
    if (mode === 'large') return res.end(' '.repeat(262145));
    if (req.url === '/tools/lookup') return res.end(JSON.stringify(mode === 'missing' ? [] :
      mode === 'duplicate' ? [{ Type: 'Instance', ID: id }, { Type: 'Instance', ID: id }] : [{ Type: 'Instance', ID: id }]));
    res.end(JSON.stringify(tags));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.ORTHANC_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.ORTHANC_USER = 'synthetic'; process.env.ORTHANC_PASS = 'synthetic';
  const { OrthancService } = require('/app/dist/orthanc.service.js');
  const orthanc = new OrthancService();
  try {
    assert.deepEqual(await orthanc.viewerReference(item.sopUid), tags);
    for (const [next, status] of [['missing', 400], ['duplicate', 400], ['redirect', 503], ['large', 503]]) {
      mode = next;
      await assert.rejects(() => orthanc.viewerReference(item.sopUid), e => e.getStatus?.() === status && !e.message.includes('synthetic'));
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('an Orthanc response that never completes hits the finite network deadline', async () => {
  const http = require('node:http');
  const server = http.createServer((req, res) => { res.writeHead(200); res.write('['); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.ORTHANC_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.ORTHANC_USER = 'synthetic'; process.env.ORTHANC_PASS = 'synthetic';
  const { OrthancService } = require('/app/dist/orthanc.service.js');
  const orthanc = new OrthancService(), start = Date.now();
  try {
    await assert.rejects(() => orthanc.viewerReference(item.sopUid), e => e.getStatus?.() === 503);
    assert(Date.now() - start >= 4500 && Date.now() - start < 10000);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
