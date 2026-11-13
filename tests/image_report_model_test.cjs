// Image Report: the pure rules of a drawing - the server's input checks, hash and the drawings a version holds
// (api/src/image-report.ts, compiled), and the page's marks model (worklist-v0/hpacs-lite/image-report.js).
// Run with: node --test tests/image_report_model_test.cjs (the server part needs /app/dist, as in the CI image).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { join } = require('node:path');
const zlib = require('node:zlib');

const page = require(join(__dirname, '../worklist-v0/hpacs-lite/image-report.js'));
const server = require('/app/dist/image-report');

/** A real PNG of w×h (white), as the window's canvas would make it. */
function png(w, h) {
  const crc = buf => { let c, crc = 0xffffffff; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0xff); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const RED = '#e0242b';
const ellipse = { tool: 'ellipse', color: RED, points: [[0.1, 0.2], [0.3, 0.4]] };
const label = { tool: 'text', color: RED, points: [[0.32, 0.3]], text: 'Mass 1.5 cm' };
const attach = (extra = {}) => ({ background: 'breast', strokes: [ellipse, label], png: png(640, 440).toString('base64'), ...extra });
const UUID = '0b7e1f7a-1c2d-4e3f-8a9b-0c1d2e3f4a5b';

test('server: a drawing request keeps strokes as 0..1 fractions and reads the PNG size', () => {
  const r = server.drawingRequest(attach());
  assert.equal(r.background, 'breast');
  assert.equal(r.source, null);
  assert.deepEqual(r.strokes, [ellipse, label]);
  assert.equal(r.width, 640); assert.equal(r.height, 440);
  assert.equal(r.replaces, null);
});

test('server: refused shapes and limits name the field', () => {
  const refused = (body, field) => assert.throws(() => server.drawingRequest(body), e => e instanceof server.DrawingInputError && e.message.endsWith(field));
  refused(attach({ background: 'default' }), 'background');
  refused(attach({ strokes: [] }), 'strokes');
  refused(attach({ strokes: [{ ...ellipse, points: [[0.1, 1.2], [0.3, 0.4]] }] }), 'strokes[0].points');
  refused(attach({ strokes: [{ ...ellipse, color: '#123456' }] }), 'strokes[0].color');
  refused(attach({ strokes: [{ ...ellipse, tool: 'measure' }] }), 'strokes[0].tool');
  refused(attach({ strokes: [{ ...label, text: 'x'.repeat(81) }] }), 'strokes[0].text');
  refused(attach({ strokes: [{ ...label, text: 'a\nb' }] }), 'strokes[0].text');
  refused(attach({ strokes: [{ ...ellipse, text: 'no' }] }), 'strokes[0].text');
  refused(attach({ strokes: Array.from({ length: 501 }, () => ellipse) }), 'strokes');
  refused(attach({ strokes: [{ tool: 'pen', color: RED, points: Array.from({ length: 2001 }, () => [0.5, 0.5]) }] }), 'strokes[0].points');
  refused(attach({ png: png(1201, 10).toString('base64') }), 'png');
  refused(attach({ png: Buffer.from('not a png at all, not a png at all').toString('base64') }), 'png');
  refused(attach({ source: { keyImageId: UUID, keyImageRevision: 1, frame: 1 } }), 'source');
  refused(attach({ background: 'image' }), 'source');
  refused(attach({ background: 'image', source: { keyImageId: UUID, keyImageRevision: 1, frame: 0 } }), 'source');
  refused(attach({ replaces: 'nope' }), 'replaces');
  refused({ ...attach(), extra: 1 }, 'extra');
  // A saved image names the key image item, its revision and the frame drawn on.
  assert.deepEqual(server.drawingRequest(attach({ background: 'image', source: { keyImageId: UUID, keyImageRevision: 2, frame: 3 } })).source,
    { keyImageId: UUID, keyImageRevision: 2, frame: 3 });
});

test('server: the hash covers background, source, strokes and the exact picture', () => {
  const base = { background: 'breast', source: null, strokes: [ellipse], png: png(4, 4) };
  const h = server.drawingHash(base);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(server.drawingHash({ ...base }), h);
  assert.notEqual(server.drawingHash({ ...base, background: 'thyroid' }), h);
  assert.notEqual(server.drawingHash({ ...base, strokes: [label] }), h);
  assert.notEqual(server.drawingHash({ ...base, png: png(4, 5) }), h);
  assert.notEqual(server.drawingHash({ ...base, background: 'image', source: { sopUid: '1.2', frame: 1 } }),
    server.drawingHash({ ...base, background: 'image', source: { sopUid: '1.2', frame: 2 } }));
});

test('server: one drawing per diagram, one per saved image frame', () => {
  assert.equal(server.drawingKey({ background: 'breast' }), 'breast');
  assert.notEqual(server.drawingKey({ background: 'image', source: { sopUid: '1.2', frame: 1 } }),
    server.drawingKey({ background: 'image', source: { sopUid: '1.2', frame: 2 } }));
  assert.notEqual(server.drawingKey({ background: 'image', source: { sopUid: '1.2', frame: 1 } }),
    server.drawingKey({ background: 'image', source: { sopUid: '1.3', frame: 1 } }));
});

test('server: the next version holds the draft list, the unseen head drawings, and never a removed or reset one', () => {
  const eff = server.effectiveDrawingIds;
  assert.deepEqual(eff(null, ['h1', 'h2']), ['h1', 'h2']);                                   // no draft change: carried
  assert.deepEqual(eff({ seed: ['h1', 'h2'], ids: ['h2', 'n1'] }, ['h1', 'h2']), ['h2', 'n1']); // h1 removed explicitly
  assert.deepEqual(eff({ seed: ['h1'], ids: ['h1'] }, ['h1', 'h9']), ['h1', 'h9']);           // h9 came later: kept
  assert.deepEqual(eff({ seed: ['h1'], ids: ['h1', 'n1'] }, []), ['n1']);                     // after a reset: h1 not revived
  assert.deepEqual(eff({ seed: ['h1'], ids: [] }, ['h1']), []);
  assert.ok(server.drawingsUntouched(null));
  assert.ok(server.drawingsUntouched({ seed: ['h1'], ids: ['h1'] }));
  assert.ok(!server.drawingsUntouched({ seed: ['h1'], ids: [] }));
  assert.ok(!server.drawingsUntouched({ seed: [], ids: ['n1'] }));
  assert.equal(server.draftDrawings(null), null);
  assert.deepEqual(server.draftDrawings({ seed: ['a'], ids: ['b'] }), { seed: ['a'], ids: ['b'] });
});

test('server: a signed version names each drawing by its hash; a version without drawings hashes as before', () => {
  const sha = 'a'.repeat(64);
  assert.deepEqual(server.drawingAttachments([{ id: UUID, background: 'breast', source: null, sha256: sha }]),
    [{ kind: 'report-evidence', recordId: UUID, versionId: '1', sha256: sha }]);
  assert.deepEqual(server.drawingAttachments(null), []);
  const old = { id: 1, uid: 'u', version: 1, action: 'approve', citations: null, structured: null, drawings: null, at: 't' };
  assert.equal(JSON.stringify(server.signedReportRow(old)), JSON.stringify({ id: 1, uid: 'u', version: 1, action: 'approve', citations: null, structured: null, at: 't' }));
  const drawn = { ...old, drawings: [{ id: UUID }] };
  assert.equal(server.signedReportRow(drawn), drawn);
});

test('page: marks are kept per background and per saved image frame; Undo and Clear act on one only', () => {
  const marks = page.createMarks();
  const breast = page.keyOf('breast'), thyroid = page.keyOf('thyroid');
  const frame1 = page.keyOf('image', { sopUid: '1.2', frame: 1 }), frame2 = page.keyOf('image', { sopUid: '1.2', frame: 2 });
  assert.equal(page.keyOf('image', null), null);
  assert.ok(marks.push(breast, { ...ellipse }));
  assert.ok(marks.push(breast, { ...label }));
  assert.ok(marks.push(thyroid, { tool: 'pen', color: '#000000', points: [[0.5, 0.5]] }));
  assert.ok(marks.push(frame1, { tool: 'line', color: '#1565c0', points: [[0, 0], [1, 1]] }));
  assert.equal(marks.list(frame2).length, 0);
  assert.ok(marks.undo(breast));
  assert.deepEqual(marks.list(breast).map(s => s.tool), ['ellipse']);
  assert.equal(marks.list(thyroid).length, 1);
  assert.ok(marks.clear(thyroid));
  assert.equal(marks.list(thyroid).length, 0);
  assert.equal(marks.list(frame1).length, 1);
  assert.ok(!marks.push(breast, { tool: 'text', color: RED, points: [[0.1, 0.1]], text: '' }), 'empty text is no mark');
  assert.ok(!marks.push(null, { ...ellipse }), 'no key, no mark');
});

test('page: the attach request carries only valid strokes, rounded 0..1', () => {
  assert.equal(page.wireStrokes([]), null);
  assert.equal(page.wireStrokes([{ tool: 'ellipse', color: RED, points: [[0.1, 0.2]] }]), null);
  assert.deepEqual(page.wireStrokes([{ tool: 'line', color: RED, points: [[0.1234567, 0.2], [0.3, 0.4]] }]),
    [{ tool: 'line', color: RED, points: [[0.12346, 0.2], [0.3, 0.4]] }]);
  // The page and the server agree on what a valid stroke is.
  const strokes = page.wireStrokes([ellipse, label]);
  assert.deepEqual(server.drawingStrokes(strokes), strokes);
});

test('page: marks not yet attached live for this sign-in only and not past a commit or a discarded draft', () => {
  const memory = page.createMemory();
  const me = { institution: 'SYN-A', sub: 's1' }, other = { institution: 'SYN-A', sub: 's2' };
  memory.put(me, 'uid-1', { version: 2, draftPresent: true, marks: { breast: [ellipse] } });
  assert.equal(memory.take(other, 'uid-1', { version: 2, draftPresent: true }), null, 'another user does not see them');
  assert.equal(memory.take(me, 'uid-2', { version: 2, draftPresent: true }), null, 'another study does not see them');
  assert.ok(memory.take(me, 'uid-1', { version: 2, draftPresent: true }));
  assert.equal(memory.take(me, 'uid-1', { version: 3, draftPresent: false }), null, 'a commit drops them');
  assert.equal(memory.take(me, 'uid-1', { version: 2, draftPresent: true }), null, 'and they do not come back');
  memory.put(me, 'uid-1', { version: 2, draftPresent: true, marks: {} });
  assert.equal(memory.take(me, 'uid-1', { version: 2, draftPresent: false }), null, 'a discarded draft drops them');
  memory.put(me, 'uid-1', { version: 0, draftPresent: false, marks: {} });
  assert.ok(memory.take(me, 'uid-1', { version: 0, draftPresent: true }), 'a draft made since keeps them');
  memory.clear();
  assert.equal(memory.size(), 0);
});

test('page: a saved image is drawn whole and centred', () => {
  assert.deepEqual(page.fit(512, 512, 640, 440), { x: 100, y: 0, w: 440, h: 440 });
  assert.deepEqual(page.fit(1280, 440, 640, 440), { x: 0, y: 110, w: 640, h: 220 });
});
