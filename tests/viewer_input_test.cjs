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
  assert.equal(v.viewerCommand(raw({ ...body, expectedRevision: 1, action: 'hide' }), false).reason, '');
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

// The Measure menu's marks: Text / Marking stamps, Memo, Spine Label (one point and a text) and Circle by Diameter.
const mark = (kind, extra = {}) => ({ schemaVersion: 1, kind, seriesUid: '2.25.2', sopUid: '2.25.3', frame: 1, frameOfReferenceUid: '2.25.4',
  label: kind === 'spine' ? 'L4' : 'RLL nodule', points: [[5, 5, 0]], ...(kind === 'memo' ? { title: 'F/U' } : {}), ...extra });
const circle = (values, calculator = 'kin-circle-v1:pixel:hu', extra = {}) => mark('circle', { label: '', points: [[10, 10, 0], [15, 10, 0]],
  baseline: { calculator, values }, ...extra });
const area = d => Math.PI * d * d / 4;
const stats = d => [d, area(d), 40, 2, 35, 45, 69];
const command = itemValue => v.viewerCommand(raw({ ...body, item: itemValue }), true);
test('Measure marks: kinds, point counts, texts and the circle values are checked', () => {
  for (const kind of ['text', 'memo', 'spine']) assert.equal(command(mark(kind)).item.kind, kind);
  assert.equal(command(mark('memo', { label: '' })).item.title, 'F/U');
  assert.equal(command(mark('text', { frameOfReferenceUid: null })).item.frameOfReferenceUid, null);
  assert.deepEqual(command(circle(stats(10))).item.baseline, { calculator: 'kin-circle-v1:pixel:hu', values: stats(10) });
  assert.equal(command(circle([10, area(10)], 'kin-circle-v1:us:value')).item.baseline.values.length, 2);
  for (const bad of [
    mark('text', { points: [[5, 5, 0], [6, 6, 0]] }), mark('text', { points: [] }), mark('text', { label: '   ' }),
    mark('text', { viewPlaneNormal: [0, 0, 1] }), mark('text', { title: 'x' }), mark('memo', { title: undefined }),
    mark('memo', { title: ' ', label: ' ' }), mark('memo', { title: 'x'.repeat(201) }), mark('spine', { label: 'L7' }), mark('spine', { label: 'l4' }),
    circle(stats(10), 'kin-circle-v1:pixel'), circle(stats(10), 'kin-circle-v1:none:hu'), circle(stats(10), 'kin-native-manual-v1'),
    circle([10, area(10)], 'kin-circle-v1:pixel:hu'), circle([10, area(10) + 1, 40, 2, 35, 45, 69]), circle([10, area(10), 40, 2, 35, 45]),
    circle([10, area(10), 40, -1, 35, 45, 69]), circle([10, area(10), 50, 2, 35, 45, 69]), circle([10, area(10), 40, 2, 35, 45, 0]),
    circle([0, 0]), circle([1001, area(1001)], 'kin-circle-v1:pixel:value'), circle(stats(10), undefined, { points: [[10, 10, 0]] }),
    { ...circle(stats(10)), baseline: { calculator: 'kin-circle-v1:pixel:hu', values: stats(10), unit: 'HU' } },
    mark('probe'), mark('circle'),
  ]) reject(() => command(bad));
});
test('Measure marks on their original: a text point on the frame, a circle diameter from the tags', () => {
  // CT tags of the suite: 1 mm pixels, origin 0, axial.
  v.verifyViewerReference('2.25.1', command(mark('text')).item, tags);
  reject(() => v.verifyViewerReference('2.25.1', command(mark('text', { points: [[40, 5, 0]] })).item, tags));
  reject(() => v.verifyViewerReference('2.25.1', command(mark('text', { points: [[5, 5, 1]] })).item, tags));
  reject(() => v.verifyViewerReference('2.25.1', command(mark('text', { frameOfReferenceUid: '2.25.9' })).item, tags));
  // A frame with plane geometry refuses a point off it, even one that would read as a pixel of another frame.
  reject(() => v.verifyViewerReference('2.25.1', command(mark('text', { points: [[10, 10, 0]] })).item, { ...tags, ImagePositionPatient: '0\\0\\100' }));
  v.verifyViewerReference('2.25.1', command(mark('text', { points: [[10, 10, 100]] })).item, { ...tags, ImagePositionPatient: '0\\0\\100' });
  reject(() => v.verifyViewerReference('2.25.1', command(mark('text')).item, { ...tags, SOPInstanceUID: '2.25.8' }));
  v.verifyViewerReference('2.25.1', command(circle(stats(10))).item, tags);
  reject(() => v.verifyViewerReference('2.25.1', command(circle(stats(11))).item, tags));
  reject(() => v.verifyViewerReference('2.25.1', command(circle(stats(10), 'kin-circle-v1:detector:hu')).item, tags));
  // Rows 0.5 mm apart, columns 2 mm: the edge 5 columns from the centre is 10 mm away, a 20 mm circle.
  v.verifyViewerReference('2.25.1', command(circle(stats(20), undefined, { points: [[20, 10, 0], [30, 10, 0]] })).item, { ...tags, PixelSpacing: '0.5\\2' });
  // A radiograph without spacing or frame of reference: a text mark in pixel coordinates; no circle in mm.
  const plain = { StudyInstanceUID: '2.25.1', SeriesInstanceUID: '2.25.2', SOPInstanceUID: '2.25.3', SOPClassUID: '1.2.840.10008.5.1.4.1.1.1', Rows: '32', Columns: '32' };
  // Without orientation the pinned viewer shows rows along +y and columns along −z: pixel (5, 6) is [0, 5, −6]; the
  // identity reading of the same numbers is another plane and is refused.
  reject(() => v.verifyViewerReference('2.25.1', command(mark('spine', { frameOfReferenceUid: null })).item, plain));
  // The pinned viewer's default frame without ImageOrientationPatient: rows along +y, columns along −z (pixel 5, 6 → [0, 5, −6]).
  v.verifyViewerReference('2.25.1', command(mark('spine', { frameOfReferenceUid: null, points: [[0, 5, -6]] })).item, plain);
  reject(() => v.verifyViewerReference('2.25.1', command(mark('spine', { frameOfReferenceUid: null, points: [[0, 5, -40]] })).item, plain));
  reject(() => v.verifyViewerReference('2.25.1', command(mark('spine', { frameOfReferenceUid: null, points: [[1, 5, -6]] })).item, plain));
  reject(() => v.verifyViewerReference('2.25.1', command(mark('spine')).item, plain));
  reject(() => v.verifyViewerReference('2.25.1', command(circle([10, area(10)], 'kin-circle-v1:pixel:value', { frameOfReferenceUid: null })).item, plain));
});
test('Measure marks: a circle on ultrasound uses the Region Calibration and stays inside one region', () => {
  const us = { StudyInstanceUID: '2.25.1', SeriesInstanceUID: '2.25.2', SOPInstanceUID: '2.25.3', SOPClassUID: '1.2.840.10008.5.1.4.1.1.6.1', Modality: 'US',
    Rows: '100', Columns: '200', SequenceOfUltrasoundRegions: [{ RegionSpatialFormat: 1, PhysicalUnitsXDirection: 3, PhysicalUnitsYDirection: 3,
      PhysicalDeltaX: 0.01, PhysicalDeltaY: 0.02, RegionLocationMinX0: 0, RegionLocationMinY0: 0, RegionLocationMaxX1: 99, RegionLocationMaxY1: 99 }] };
  // 0.1 mm columns: 25 columns are 2.5 mm, a 5 mm circle; its 12.5 rows up and down stay in the region.
  // Shown in pixels in the viewer's default frame (pixel x, y is [0, x, −y]).
  const item = extra => command(circle([5, area(5)], 'kin-circle-v1:us:value', { frameOfReferenceUid: null, ...extra })).item;
  v.verifyViewerReference('2.25.1', item({ points: [[0, 50, -50], [0, 75, -50]] }), us);
  reject(() => v.verifyViewerReference('2.25.1', item({ points: [[50, 50, 0], [75, 50, 0]] }), us));
  reject(() => v.verifyViewerReference('2.25.1', item({ points: [[0, 50, -50], [75, 50, 0]] }), us));
  reject(() => v.verifyViewerReference('2.25.1', item({ points: [[0, 50, -50], [0, 76, -50]] }), us));
  reject(() => v.verifyViewerReference('2.25.1', item({ points: [[0, 90, -50], [0, 115, -50]] }), us));
  reject(() => v.verifyViewerReference('2.25.1', item({ points: [[0, 50, -5], [0, 75, -5]] }), us));
  reject(() => v.verifyViewerReference('2.25.1', item({ points: [[0, 50, -50], [0, 75, -50]] }), { ...us, SequenceOfUltrasoundRegions: undefined }));
});

// The orthopaedic and spine measurements: kinds, point counts, calculator names and values; the values calculated again
// from the original's tags (hand-computed here).
const ortho = (kind, points, calculator, values, extra = {}) => mark(kind, { label: '', points, baseline: { calculator, values }, ...extra });
const world = pixels => pixels.map(([x, y]) => [x, y, 0]);
// CT tags of the suite (1 mm): femoral heads (14, 30) and (16, 30), S1 endplate front (10, 20), back (20, 15) — the front to
// the image's left. SS = atan(5 / 10), PT = 0 (the hip axis right under the endplate's middle), PI = PT + SS.
const SS = Math.atan2(5, 10) * 180 / Math.PI;
const pelvis = (values = [SS, 0, SS], calculator = 'kin-pelvicincidence-v1:pixel', points = world([[14, 30], [16, 30], [10, 20], [20, 15]])) =>
  ortho('pelvicIncidence', points, calculator, values);
// Base line y = 10; pelvic landmarks 2 and 1 mm below it; femoral landmarks 10 and 9.5 mm below it: 8 and 8.5 mm, 0.5 apart.
const limb = (values = [8, 8.5, 0.5], calculator = 'kin-limblength-v1:pixel') =>
  ortho('limbLength', world([[2, 10], [30, 10], [5, 12], [25, 11], [6, 20], [24, 19.5]]), calculator, values);
test('Orthopaedic marks: kinds, point counts, calculator names and values are checked', () => {
  assert.deepEqual(command(pelvis()).item.baseline, { calculator: 'kin-pelvicincidence-v1:pixel', values: [SS, 0, SS] });
  assert.equal(command(limb()).item.points.length, 6);
  assert.equal(command(ortho('acetabular', world([[1, 1], [9, 1], [1, 2], [3, 4], [7, 4], [9, 2]]), 'kin-acetabular-v1:px', [45, 45])).item.kind, 'acetabular');
  assert.equal(command(ortho('spineBalance', world([[1, 1], [3, 1], [3, 3], [1, 3], [0, 9], [6, 9]]), 'kin-spinebalance-v1:pixel', [-1])).item.kind, 'spineBalance');
  assert.deepEqual(command(ortho('spineCobb', world([[1, 1], [3, 1], [1, 3], [3, 3]]), 'kin-spinecobb-v1:left:px', [null])).item.baseline.values, [null]);
  for (const bad of [
    pelvis([SS, 0]), pelvis([SS, 0, SS, 1]), pelvis([SS, null, SS]), pelvis(['1', 0, SS]), pelvis([SS, 0, SS], 'kin-pelvicincidence-v1:us'),
    pelvis([SS, 0, SS], 'kin-pelvicincidence-v1'), pelvis([SS, 0, SS], 'kin-limblength-v1:pixel'), pelvis([SS, 0, SS], undefined, world([[14, 30], [16, 30], [10, 20]])),
    ortho('spineCobb', world([[1, 1], [3, 1], [1, 3], [3, 3]]), 'kin-spinecobb-v1:pixel', [10]),
    ortho('spineCobb', world([[1, 1], [3, 1], [1, 3], [3, 3]]), 'kin-spinecobb-v1:up:pixel', [10]),
    { ...limb(), viewPlaneNormal: [0, 0, 1] }, { ...limb(), baseline: { calculator: 'kin-limblength-v1:pixel', values: [8, 8.5, 0.5], unit: 'mm' } },
    { ...limb(), title: 'x' }, { ...limb(), baseline: undefined },
  ]) reject(() => command(bad));
});
test('Orthopaedic marks on their original: the values are calculated again from the tags', () => {
  v.verifyViewerReference('2.25.1', command(pelvis()).item, tags);
  v.verifyViewerReference('2.25.1', command(limb()).item, tags);
  // A value off by more than the tolerance, another spacing basis, or pixels on an image that has a spacing: refused.
  reject(() => v.verifyViewerReference('2.25.1', command(pelvis([SS + .01, 0, SS + .01])).item, tags));
  reject(() => v.verifyViewerReference('2.25.1', command(limb([8, 8.6, 0.6])).item, tags));
  reject(() => v.verifyViewerReference('2.25.1', command(pelvis(undefined, 'kin-pelvicincidence-v1:detector')).item, tags));
  reject(() => v.verifyViewerReference('2.25.1', command(pelvis(undefined, 'kin-pelvicincidence-v1:px')).item, tags));
  // Spacing tags that are there but do not hold (no usable orientation) are no way into pixels either.
  const unusable = command(ortho('pelvicIncidence', [[14, 30], [16, 30], [10, 20], [20, 15]].map(([x, y]) => [0, x, -y]), 'kin-pelvicincidence-v1:px', [SS, 0, SS], { frameOfReferenceUid: null })).item;
  const plainTags = { StudyInstanceUID: '2.25.1', SeriesInstanceUID: '2.25.2', SOPInstanceUID: '2.25.3', SOPClassUID: '1.2.840.10008.5.1.4.1.1.1', Rows: '32', Columns: '32' };
  v.verifyViewerReference('2.25.1', unusable, plainTags);
  assert.throws(() => v.verifyViewerReference('2.25.1', unusable, { ...plainTags, PixelSpacing: '1\\1', ImageOrientationPatient: '1\\0\\0' }), e => e.getStatus?.() === 400 && /간격 태그/.test(e.message));
  // The endplate's ends the other way round: the server refuses as the viewer does.
  reject(() => v.verifyViewerReference('2.25.1', command(pelvis(undefined, undefined, world([[14, 30], [16, 30], [20, 15], [10, 20]]))).item, tags));
  // Rows 0.5 mm apart, columns 2 mm (world x = 2 × column, y = 0.5 × row): SS = atan(2.5 / 20).
  const square = Math.atan2(2.5, 20) * 180 / Math.PI;
  const stretched = [[14, 30], [16, 30], [10, 20], [20, 15]].map(([x, y]) => [2 * x, 0.5 * y, 0]);
  v.verifyViewerReference('2.25.1', command(pelvis([square, 0, square], undefined, stretched)).item, { ...tags, PixelSpacing: '0.5\\2' });
  reject(() => v.verifyViewerReference('2.25.1', command(pelvis(undefined, undefined, stretched)).item, { ...tags, PixelSpacing: '0.5\\2' }));
  // A radiograph without spacing: a Cobb angle in pixels (the default frame: pixel x, y is [0, x, −y]); the back's side
  // decides the sign; two lines at the same height have no value.
  const plain = { StudyInstanceUID: '2.25.1', SeriesInstanceUID: '2.25.2', SOPInstanceUID: '2.25.3', SOPClassUID: '1.2.840.10008.5.1.4.1.1.1', Rows: '32', Columns: '32' };
  const flat = pixels => pixels.map(([x, y]) => [0, x, -y]);
  const lordosis = -2 * Math.atan(0.2) * 180 / Math.PI;
  const cobb = (calculator, values, pixels = [[5, 5], [15, 7], [5, 25], [15, 23]]) => command(ortho('spineCobb', flat(pixels), calculator, values, { frameOfReferenceUid: null })).item;
  v.verifyViewerReference('2.25.1', cobb('kin-spinecobb-v1:right:px', [lordosis]), plain);
  reject(() => v.verifyViewerReference('2.25.1', cobb('kin-spinecobb-v1:left:px', [lordosis]), plain));
  v.verifyViewerReference('2.25.1', cobb('kin-spinecobb-v1:left:px', [-lordosis]), plain);
  reject(() => v.verifyViewerReference('2.25.1', cobb('kin-spinecobb-v1:right:pixel', [lordosis]), plain));
  v.verifyViewerReference('2.25.1', cobb('kin-spinecobb-v1:right:px', [null], [[5, 5], [15, 7], [5, 7], [15, 5]]), plain);
  reject(() => v.verifyViewerReference('2.25.1', cobb('kin-spinecobb-v1:right:px', [0], [[5, 5], [15, 7], [5, 7], [15, 5]]), plain));
});
// The Measure menu's line tools: CTR, Parallel Lines, Length Ratio, Centre-line Angle and Volume Measure.
const line = (kind, calculator, values, points, extra = {}) => mark(kind, { label: '', points, baseline: { calculator, values }, ...extra });
const CTR4 = [[10, 2, 0], [10, 30, 0], [6, 15, 0], [17, 14, 0], [2, 12, 0], [22, 12, 0]];
const lines = {
  ctr4: () => line('ctr', 'kin-ctr4-v1:pixel', [4, 7, 20, 0.55], CTR4),
  ctr2: () => line('ctr', 'kin-ctr2-v1:pixel', [10, 20, 0.5], [[0, 20, 0], [20, 20, 0], [5, 5, 0], [15, 5, 0]]),
  parallel: () => line('parallel', 'kin-parallel-v1:pixel', [4, Math.hypot(8, 4)], [[0, 0, 0], [10, 0, 0], [8, 4, 0], [18, 4, 0]]),
  ratio: () => line('ratio', 'kin-ratio-v1:pixel', [5, 0, null], [[0, 0, 0], [3, 4, 0], [5, 5, 0], [5, 5, 0]]),
  angle: () => line('centreAngle', 'kin-centreangle-v1:pixel', [45, 315], [[0, 0, 0], [10, 0, 0], [0, 2, 0], [10, 2, 0], [0, 0, 0], [10, 10, 0], [2, 0, 0], [12, 10, 0]]),
};
const VOLUME = Math.PI / 6 * 20 * 10 * 8 / 1000;
const source = (sopUid, points) => ({ seriesUid: '2.25.2', sopUid, frame: 1, frameOfReferenceUid: '2.25.4', points, calculator: 'kin-length-v1:pixel' });
const volume = (extra = {}, baseline = {}) => mark('volume', { label: 'Prostate volume', points: [[16, 16, 0]], baseline: { calculator: 'kin-volume-v1:ellipsoid',
  values: [20, 10, 8, VOLUME], sources: [source('2.25.3', [[2, 2, 0], [22, 2, 0]]), source('2.25.5', [[2, 4, 0], [2, 14, 0]]), source('2.25.6', [[1, 1, 0], [9, 1, 0]])], ...baseline }, ...extra });
test('Line marks: kinds, calculators, point counts and saved values are checked', () => {
  for (const make of Object.values(lines)) assert.deepEqual(command(make()).item.baseline, make().baseline);
  assert.equal(command(line('ratio', 'kin-ratio-v1:px', [5, 2, 2.5], lines.ratio().points)).item.baseline.calculator, 'kin-ratio-v1:px');
  assert.equal(command(volume()).item.baseline.sources.length, 3);
  assert.equal(command(volume({}, { calculator: 'kin-volume-v1:prolate', values: [20, 8, Math.PI / 6 * 20 * 64 / 1000], sources: volume().baseline.sources.slice(0, 2) })).item.label, 'Prostate volume');
  for (const bad of [
    line('ratio', 'kin-ctr4-v1:pixel', [4, 7, 20, 0.55], CTR4), line('ctr', 'kin-ctr4-v1:none', [4, 7, 20, 0.55], CTR4), line('ctr', 'kin-ctr4-v1', [4, 7, 20, 0.55], CTR4),
    line('ctr', 'kin-ctr4-v1:pixel', [4, 7, 20], CTR4), line('ctr', 'kin-ctr4-v1:pixel', [4, 7, 20, '0.55'], CTR4), line('ctr', 'kin-ctr4-v1:pixel:x', [4, 7, 20, 0.55], CTR4),
    line('ctr', 'kin-ctr2-v1:pixel', [10, 20, 0.5], CTR4), line('centreAngle', 'kin-centreangle-v1:pixel', [45, 315], CTR4),
    { ...lines.ctr4(), baseline: { ...lines.ctr4().baseline, sources: [] } }, { ...lines.ctr4(), viewPlaneNormal: [0, 0, 1] },
    volume({}, { values: [20, 10, 8, VOLUME + 1] }), volume({}, { values: [20, 10, 0, 0] }), volume({}, { sources: volume().baseline.sources.slice(0, 2) }),
    volume({}, { calculator: 'kin-volume-v1:cube' }), volume({}, { sources: undefined }), volume({ points: [[1, 1, 0], [2, 2, 0]] }), volume({ label: 'x'.repeat(201) }),
    volume({}, { sources: [{ ...source('2.25.3', [[2, 2, 0], [22, 2, 0]]), calculator: 'kin-length-v1:px' }, ...volume().baseline.sources.slice(1)] }),
    volume({}, { sources: [{ ...source('2.25.3', [[2, 2, 0]]) }, ...volume().baseline.sources.slice(1)] }),
    volume({}, { sources: [{ ...source('2.25.3', [[2, 2, 0], [22, 2, 0]]), hidden: true }, ...volume().baseline.sources.slice(1)] }),
  ]) reject(() => command(bad));
});
test('Line marks on their original: the values are calculated again from the tags', () => {
  for (const make of Object.values(lines)) v.verifyViewerReference('2.25.1', command(make()).item, tags);
  reject(() => v.verifyViewerReference('2.25.1', command(line('ctr', 'kin-ctr4-v1:pixel', [4, 7, 20, 0.56], CTR4)).item, tags));
  reject(() => v.verifyViewerReference('2.25.1', command(line('ratio', 'kin-ratio-v1:pixel', [5, 0, 0], lines.ratio().points)).item, tags));
  reject(() => v.verifyViewerReference('2.25.1', command(line('ctr', 'kin-ctr4-v1:detector', [4, 7, 20, 0.55], CTR4)).item, tags));
  reject(() => v.verifyViewerReference('2.25.1', command(line('ctr', 'kin-ctr4-v1:pixel', [4, 7, 20, 0.55], CTR4.map(([x, y]) => [x, y, 1]))).item, tags));
  // Rows of 0.5 mm and columns of 2 mm: a ratio of lengths on the patient. The viewer shows pixel (x, y) at [2x, 0.5y, 0].
  v.verifyViewerReference('2.25.1', command(line('ratio', 'kin-ratio-v1:pixel', [8, 4, 2], [[0, 0, 0], [8, 0, 0], [0, 0, 0], [0, 4, 0]])).item, { ...tags, PixelSpacing: '0.5\\2' });
  // A radiograph without spacing: a pixel-based mark in pixel coordinates; no mm mark.
  const plain = { StudyInstanceUID: '2.25.1', SeriesInstanceUID: '2.25.2', SOPInstanceUID: '2.25.3', SOPClassUID: '1.2.840.10008.5.1.4.1.1.1', Rows: '32', Columns: '32' };
  const flat = points => points.map(([x, y]) => [0, x, -y]);
  v.verifyViewerReference('2.25.1', command(line('ratio', 'kin-ratio-v1:px', [5, 0, null], flat(lines.ratio().points), { frameOfReferenceUid: null })).item, plain);
  reject(() => v.verifyViewerReference('2.25.1', command(line('ratio', 'kin-ratio-v1:pixel', [5, 0, null], flat(lines.ratio().points), { frameOfReferenceUid: null })).item, plain));
  // Ultrasound: the one region that holds every point gives the spacing (0.1 mm columns, 0.2 mm rows).
  const us = { StudyInstanceUID: '2.25.1', SeriesInstanceUID: '2.25.2', SOPInstanceUID: '2.25.3', SOPClassUID: '1.2.840.10008.5.1.4.1.1.6.1', Modality: 'US',
    Rows: '100', Columns: '200', SequenceOfUltrasoundRegions: [{ RegionSpatialFormat: 1, PhysicalUnitsXDirection: 3, PhysicalUnitsYDirection: 3,
      PhysicalDeltaX: 0.01, PhysicalDeltaY: 0.02, RegionLocationMinX0: 0, RegionLocationMinY0: 0, RegionLocationMaxX1: 99, RegionLocationMaxY1: 99 }] };
  v.verifyViewerReference('2.25.1', command(line('ratio', 'kin-ratio-v1:us', [5, 2, 2.5], flat([[10, 10], [60, 10], [10, 10], [10, 20]]), { frameOfReferenceUid: null })).item, us);
  reject(() => v.verifyViewerReference('2.25.1', command(line('ratio', 'kin-ratio-v1:us', [5, 2, 2.5], flat([[10, 10], [150, 10], [10, 10], [10, 20]]), { frameOfReferenceUid: null })).item, us));
});
test('Volume Measure: each length checked on its own original of the same study; none without them', () => {
  const frames = { '2.25.5': { ...tags, SOPInstanceUID: '2.25.5' }, '2.25.6': { ...tags, SOPInstanceUID: '2.25.6', PixelSpacing: '1\\1' } };
  const item = command(volume()).item;
  v.verifyViewerReference('2.25.1', item, tags, sop => frames[sop]);
  reject(() => v.verifyViewerReference('2.25.1', item, tags));
  reject(() => v.verifyViewerReference('2.25.1', item, tags, sop => ({ ...frames[sop], StudyInstanceUID: '2.25.99' })));
  reject(() => v.verifyViewerReference('2.25.1', item, tags, sop => ({ ...frames[sop], SOPInstanceUID: '2.25.7' })));
  reject(() => v.verifyViewerReference('2.25.1', item, tags, sop => sop === '2.25.6' ? { ...frames[sop], ImagePositionPatient: '0\\0\\5' } : frames[sop]));
  reject(() => v.verifyViewerReference('2.25.1', command(volume({ points: [[16, 16, 3]] })).item, tags, sop => frames[sop]));
});
