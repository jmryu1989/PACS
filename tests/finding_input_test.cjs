// TEST-S2-INPUT (REQ-S2-PROVENANCE): exercise the compiled production parser, not a copy.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const f = require('/app/dist/finding-input.js');
const raw = x => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x));
const ID = '00000000-0000-4000-8000-000000000001', ID2 = '00000000-0000-4000-8000-000000000002', REQ = '00000000-0000-4000-8000-0000000000aa';
const item = { schemaVersion: 1, title: '소견', text: '본문', sources: [{ itemId: ID, revision: 2 }] };
const body = { requestId: REQ, item };
const reject = (fn, status = 400) => assert.throws(fn, e => e.getStatus?.() === status);

test('strict allow-list: copied provenance fields from the client are rejected', () => {
  const parsed = f.findingCommand(raw(body), true);
  assert.deepEqual(parsed, { requestId: REQ, action: 'create', reason: '', item: { schemaVersion: 1, title: '소견', text: '본문', sources: [{ itemId: ID, revision: 2 }], primary: 0 } });
  for (const forged of ['values', 'kind', 'sourceDigest', 'seriesUid', 'sopUid', 'frame', 'studyUid', 'label', 'authorActor', 'calculator'])
    reject(() => f.findingCommand(raw({ ...body, item: { ...item, sources: [{ itemId: ID, revision: 2, [forged]: 'x' }] } }), true));
  for (const bad of [{ ...body, author: 'forged' }, { ...body, item: { ...item, hidden: true } }, { ...body, item: { ...item, links: [] } },
    { ...body, item: { ...item, schemaVersion: 2 } }, { ...body, item: { ...item, sources: [] } },
    { ...body, item: { ...item, sources: [{ itemId: ID, revision: 2 }, { itemId: ID, revision: 3 }] } },
    { ...body, item: { ...item, sources: Array.from({ length: 9 }, (_, i) => ({ itemId: ID.slice(0, -1) + i, revision: 1 })) } },
    { ...body, item: { ...item, sources: [{ itemId: 'not-a-uuid', revision: 1 }] } }, { ...body, item: { ...item, sources: [{ itemId: ID, revision: 0 }] } },
    { ...body, item: { ...item, sources: [{ itemId: ID, revision: 1.5 }] } }, { ...body, item: { ...item, sources: [{ itemId: ID, revision: '1' }] } },
    { ...body, item: { ...item, primary: 1 } }, { ...body, item: { ...item, primary: -1 } }, { ...body, item: { ...item, title: 7 } },
    { ...body, item: { ...item, title: '😀'.repeat(201) } }, { ...body, item: { ...item, text: 'x'.repeat(4001) } },
    { ...body, item: { ...item, text: '\u0000' } }, { ...body, requestId: 'x' }]) reject(() => f.findingCommand(raw(bad), true));
  assert.equal([...f.findingCommand(raw({ ...body, item: { ...item, title: '😀'.repeat(200) } }), true).item.title].length, 200);
  assert.equal(f.findingCommand(raw({ ...body, item: { ...item, sources: Array.from({ length: 8 }, (_, i) => ({ itemId: ID.slice(0, -1) + i, revision: 1 })), primary: 7 } }), true).item.primary, 7);
});

test('revision commands need expectedRevision, an action and a reason only for hide/restore', () => {
  reject(() => f.findingCommand(raw(body), false));
  reject(() => f.findingCommand(raw({ ...body, expectedRevision: 1, action: 'create' }), false));
  reject(() => f.findingCommand(raw({ ...body, expectedRevision: 1, action: 'hide' }), false));
  reject(() => f.findingCommand(raw({ ...body, expectedRevision: 1, action: 'edit', reason: '사유' }), false));
  reject(() => f.findingCommand(raw({ ...body, expectedRevision: 0, action: 'edit' }), false));
  const hide = f.findingCommand(raw({ ...body, expectedRevision: 3, action: 'hide', reason: '사유' }), false);
  assert.equal(hide.action, 'hide'); assert.equal(hide.expectedRevision, 3); assert.equal(hide.reason, '사유');
  assert.equal(f.findingCommand(raw({ ...body, expectedRevision: 3, action: 'restore', reason: ' 복원 ' }), false).action, 'restore');
});

test('fingerprint covers the client pairs only, so a later head change still replays', () => {
  const fp = s => f.findingFingerprint('2.25.1', null, f.findingCommand(raw(s), true));
  assert.equal(fp(body), fp(JSON.stringify(body).replace('"revision":2', '"revision":2e0').replace('"text":"본문"', '"text": "본문"')));
  assert.equal(fp(body), fp({ item: { ...item, primary: 0 }, requestId: body.requestId }));
  assert.equal(fp(body), fp({ ...body, requestId: ID2 }), 'the request id itself is not part of the fingerprint');
  assert.notEqual(fp(body), fp({ ...body, item: { ...item, sources: [{ itemId: ID, revision: 3 }] } }));
  assert.notEqual(fp(body), fp({ ...body, item: { ...item, text: '본문 ' } }));
  assert.notEqual(f.findingFingerprint('2.25.1', ID, f.findingCommand(raw({ ...body, expectedRevision: 1, action: 'edit' }), false)),
    f.findingFingerprint('2.25.1', ID2, f.findingCommand(raw({ ...body, expectedRevision: 1, action: 'edit' }), false)));
});

test('page queries fail closed and copySource/linkState follow the contract', () => {
  for (const q of [{ limit: '0' }, { limit: '101' }, { cursor: ['1'] }, { includeHidden: 'yes' }, { recheck: ID }, { extra: '1' }]) reject(() => f.findingPage(q));
  assert.deepEqual(f.findingPage({ limit: '100', cursor: ID }), { limit: 100, cursor: ID, includeHidden: false });
  assert.deepEqual(f.findingPage({ cursor: '9' }, true), { limit: 50, cursor: 9, includeHidden: false });
  reject(() => f.findingPage({ includeHidden: 'true' }, true));
  const head = { id: ID, revision: 4, studyUid: '2.25.1', hidden: false, authorActor: 'Reader', snapshot: { schemaVersion: 1, kind: 'length', seriesUid: '2.25.2', sopUid: '2.25.3', frame: 1,
    frameOfReferenceUid: '2.25.4', label: 'L', points: [[0, 0, 0], [1, 0, 0]], viewPlaneNormal: [0, 0, 1], viewUp: [0, 1, 0], baseline: { calculator: 'kin-native-manual-v1', values: [1] }, sourceDigest: 'abc', hidden: false } };
  assert.deepEqual(f.copySource(head), { itemId: ID, revision: 4, studyUid: '2.25.1', kind: 'length', seriesUid: '2.25.2', sopUid: '2.25.3', frame: 1,
    frameOfReferenceUid: '2.25.4', label: 'L', values: [1], calculator: 'kin-native-manual-v1', sourceDigest: 'abc', authorActor: 'Reader' });
  const key = { ...head, snapshot: { schemaVersion: 1, kind: 'key', seriesUid: '2.25.2', sopUid: '2.25.3', frame: 3, title: 'K', description: '', hidden: false } };
  assert.deepEqual(f.copySource(key), { itemId: ID, revision: 4, studyUid: '2.25.1', kind: 'key', seriesUid: '2.25.2', sopUid: '2.25.3', frame: 3,
    frameOfReferenceUid: null, label: 'K', values: null, calculator: null, sourceDigest: null, authorActor: 'Reader' });
  const source = { itemId: ID, revision: 4, studyUid: '2.25.1' };
  assert.equal(f.linkState(source, head), 'current');
  assert.equal(f.linkState(source, { ...head, revision: 5 }), 'revised');
  assert.equal(f.linkState(source, { ...head, hidden: true, revision: 5 }), 'hidden');
  assert.equal(f.linkState(source, null), 'missing');
  assert.equal(f.linkState(source, { ...head, studyUid: '2.25.9' }), 'missing');
  assert.deepEqual(f.FINDING_LIMITS, { findings: 256, revisions: 4096, bytes: 16777216, snapshot: 65536, history: 1000, sources: 8, title: 200, text: 4000 });
});

test('S2-B2 comparison studies: distinct, anchor excluded, stable order, a missing uid never names a study', () => {
  assert.deepEqual(f.comparisonStudies('1.2.3', ['1.2.3', '1.2.10', '1.2.9', '1.2.10', '1.2.3']), ['1.2.10', '1.2.9']);
  assert.deepEqual(f.comparisonStudies('1.2.3', ['1.2.3']), []);
  assert.deepEqual(f.comparisonStudies('1.2.3', []), []);
  assert.deepEqual(f.comparisonStudies('1.2.3', new Set(['2.5', '1.2.3'])), ['2.5']);
  // null/undefined/non-string uids collapse to '' so a lineage holding one is never fully readable.
  assert.deepEqual(f.comparisonStudies('1.2.3', [null, undefined, 7, '1.2.3']), ['']);
  assert.deepEqual(f.comparisonStudies('1.2.3', ['2.5', null, '1.2.30']), ['', '1.2.30', '2.5']);
  // The pair allow-list is unchanged: a client still cannot name the source study.
  reject(() => f.findingCommand(raw({ ...body, item: { ...item, sources: [{ itemId: ID, revision: 2, studyUid: '2.25.9' }] } }), true));
});
