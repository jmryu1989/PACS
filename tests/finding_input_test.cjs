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

/* ---------- S2-L1: version 2 records and saved locations (TEST-S2L-INPUT) ---------- */
const { canonical } = require('/app/dist/viewer-input.js');
const JOB = '00000000-0000-4000-8000-0000000000b1', MARK = '00000000-0000-4000-8000-0000000000c1', MARK2 = '00000000-0000-4000-8000-0000000000c2';
const X = '2.25.10', P = '2.25.20', Q = '2.25.30';
const v2 = extra => Object.assign({ schemaVersion: 2, title: '소견', text: '본문', characteristics: '경계 불명확', sources: [{ itemId: ID, revision: 2 }] }, extra);

test('S2-L1 E1: version 1 parsing and fingerprints are byte-identical to the shipped parser (base goldens)', () => {
  // Values printed by the base blob ce965cdf of api/src/finding-input.ts for the same four bodies.
  const ID2b = '00000000-0000-4000-8000-000000000002';
  const golden = [
    [raw({ requestId: REQ, item }), true, null, 'fd325be0e2052ad33e765dcaa0ea10aaaf7396948370f7c1456c932b0c6a2b06'],
    [raw({ requestId: REQ, item: { ...item, sources: [{ itemId: ID, revision: 2 }, { itemId: ID2b, revision: 7 }], primary: 1 } }), true, null, '1ea6e687d325aad0ac8bcd6197c948890b87d29402aafa05a42c7fd02494a980'],
    [raw({ requestId: REQ, expectedRevision: 3, action: 'edit', item }), false, ID2b, 'a2c67bf3d3da2719408c1f53c54a5fc6d1c317faa02d22ac4b20b3dcacfa9590'],
    [raw({ requestId: REQ, expectedRevision: 3, action: 'hide', reason: '사유 😀', item: { ...item, title: '😀'.repeat(200) } }), false, ID2b, 'bb00ee3dd299416217a93a3a4f1ac1e1c982c19c61727262261725b6769fe5ec']];
  for (const [bytes, create, id, fingerprint] of golden) assert.equal(f.findingFingerprint('2.25.1', id, f.findingCommand(bytes, create)), fingerprint);
  assert.equal(JSON.stringify(f.findingCommand(raw(body), true)), '{"requestId":"' + REQ + '","action":"create","reason":"","item":{"schemaVersion":1,"title":"소견","text":"본문","sources":[{"itemId":"' + ID + '","revision":2}],"primary":0}}');
  // Version 1 stays item-only and has no characteristics.
  for (const bad of [{ ...item, characteristics: '' }, { ...item, sources: [{ jobId: JOB, revision: 1 }] }, { ...item, sources: [{ jobId: JOB, revision: 1, markId: MARK }] }])
    reject(() => f.findingCommand(raw({ ...body, item: bad }), true));
});

test('S2-L1 version 2: required characteristics, item and job references, and every copied field refused', () => {
  const parsed = f.findingCommand(raw({ requestId: REQ, item: v2({ sources: [{ itemId: ID, revision: 2 }, { jobId: JOB, revision: 3 }, { jobId: JOB, revision: 3, markId: MARK }], primary: 2 }) }), true);
  assert.deepEqual(parsed.item, { schemaVersion: 2, title: '소견', text: '본문', characteristics: '경계 불명확',
    sources: [{ itemId: ID, revision: 2 }, { jobId: JOB, revision: 3 }, { jobId: JOB, revision: 3, markId: MARK }], primary: 2 });
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.item.sources[1], 'markId'), false, 'a saved view names no mark, not even undefined');
  assert.deepEqual(parsed.item.sources.map(f.isJobRef), [false, true, true]);
  // Job-only and item-only version 2 records are valid; blank text is a client rule.
  assert.equal(f.findingCommand(raw({ requestId: REQ, item: v2({ title: '', text: '', characteristics: '', sources: [{ jobId: JOB, revision: 1 }] }) }), true).item.sources.length, 1);
  for (const forged of ['studies', 'jobStudyUid', 'studyUid', 'mark', 'point', 'label', 'snapshotVersion', 'title', 'authorActor', 'frameOfReferenceUid', 'kind', 'sourceDigest', 'volume'])
    reject(() => f.findingCommand(raw({ requestId: REQ, item: v2({ sources: [{ jobId: JOB, revision: 1, [forged]: 'x' }] }) }), true), 400);
  for (const [name, bad] of Object.entries({
    'missing characteristics': (({ characteristics, ...rest }) => rest)(v2()), 'non-string characteristics': v2({ characteristics: 7 }),
    'NUL characteristics': v2({ characteristics: 'a\u0000' }), 'lone surrogate': v2({ characteristics: '\uD800' }),
    'both ids': v2({ sources: [{ itemId: ID, jobId: JOB, revision: 1 }] }), 'mark without job': v2({ sources: [{ itemId: ID, revision: 1, markId: MARK }] }),
    'null mark': v2({ sources: [{ jobId: JOB, revision: 1, markId: null }] }), 'bad mark': v2({ sources: [{ jobId: JOB, revision: 1, markId: 'x' }] }),
    'bad job id': v2({ sources: [{ jobId: JOB.toUpperCase(), revision: 1 }] }), 'zero job revision': v2({ sources: [{ jobId: JOB, revision: 0 }] }),
    'same saved view twice': v2({ sources: [{ jobId: JOB, revision: 1 }, { jobId: JOB, revision: 2 }] }),
    'same point twice': v2({ sources: [{ jobId: JOB, revision: 1, markId: MARK }, { jobId: JOB, revision: 2, markId: MARK }] }),
    'unknown version': { ...v2(), schemaVersion: 3 }, 'extra key': v2({ laterality: 'L' }),
    'nine sources': v2({ sources: Array.from({ length: 9 }, (_, i) => ({ jobId: JOB, revision: 1, markId: MARK.slice(0, -1) + i })) }) }))
    reject(() => f.findingCommand(raw({ requestId: REQ, item: bad }), true), 400);
  // One job may be linked as its saved view and as each of its points.
  assert.equal(f.findingCommand(raw({ requestId: REQ, item: v2({ sources: [{ jobId: JOB, revision: 1 }, { jobId: JOB, revision: 1, markId: MARK }, { jobId: JOB, revision: 1, markId: MARK2 }] }) }), true).item.sources.length, 3);
  // Frozen reuse keys and the pair a stored copy came from.
  assert.equal(f.refKey({ itemId: ID, revision: 2 }), ID + ':2');
  assert.equal(f.refKey({ jobId: JOB, revision: 3 }), 'job:' + JOB + ':3:');
  assert.equal(f.refKey({ jobId: JOB, revision: 3, markId: MARK }), 'job:' + JOB + ':3:' + MARK);
  assert.deepEqual(f.sourceRef({ itemId: ID, revision: 2, kind: 'length', studyUid: X }), { itemId: ID, revision: 2 });
  assert.deepEqual(f.sourceRef({ kind: 'job', jobId: JOB, revision: 3, mark: null }), { jobId: JOB, revision: 3 });
  assert.deepEqual(f.sourceRef({ kind: 'job', jobId: JOB, revision: 3, mark: { id: MARK } }), { jobId: JOB, revision: 3, markId: MARK });
  // The fingerprint separates versions and ignores key order.
  const fp = value => f.findingFingerprint(X, null, f.findingCommand(raw(value), true));
  const two = { requestId: REQ, item: v2() };
  assert.equal(fp(two), fp({ item: { sources: two.item.sources, characteristics: '경계 불명확', text: '본문', title: '소견', schemaVersion: 2 }, requestId: REQ }));
  assert.notEqual(fp(two), fp({ requestId: REQ, item: { ...item, title: '소견', text: '본문' } }));
  assert.notEqual(fp(two), fp({ requestId: REQ, item: v2({ characteristics: '경계 불명확 ' }) }));
});

test('S2-L1 R7: characteristics count code points like title and text; 1000 astral round-trip byte-equal, 1001 refused', () => {
  const astral = '\u{1F600}'.repeat(1000);
  assert.equal(f.FINDING_CHARACTERISTICS, 1000);
  const accepted = f.findingCommand(raw({ requestId: REQ, item: v2({ characteristics: astral }) }), true).item.characteristics;
  assert.equal(accepted, astral); assert.equal(Buffer.compare(Buffer.from(accepted), Buffer.from(astral)), 0);
  assert.equal(astral.length, 2000, 'a native maxlength of 1000 UTF-16 units stops typing at 500 of these');
  reject(() => f.findingCommand(raw({ requestId: REQ, item: v2({ characteristics: astral + '\u{1F600}' }) }), true));
  assert.equal(f.findingCommand(raw({ requestId: REQ, item: v2({ characteristics: '가'.repeat(1000) }) }), true).item.characteristics.length, 1000);
  reject(() => f.findingCommand(raw({ requestId: REQ, item: v2({ characteristics: 'x'.repeat(1001) }) }), true));
  // The shipped limits object is unchanged; the version 2 bound is its own constant.
  assert.deepEqual(f.FINDING_LIMITS, { findings: 256, revisions: 4096, bytes: 16777216, snapshot: 65536, history: 1000, sources: 8, title: 200, text: 4000 });
});

const jobRow = extra => Object.assign({ id: JOB, studyUid: X, studies: [X, P], hidden: false, revision: 4, title: '비교 위치', authorActor: 'Reader' }, extra);
const volume = { study: P, series: '2.25.21', sops: ['2.25.22', '2.25.23'], sourceDigest: 'a'.repeat(64) };
const v6 = extra => Object.assign({ version: 6, studies: [X, P], volume, marks: { version: 1, visible: true, sync: true, marks: [
  { id: MARK, label: '병변 <b>', point: [-0.33113281957650276, 12.5, 1e-7] }] } }, extra);

test('S2-L1 W1-W4: a job of this anchor and its own ordered study set; a point of a version 6 volume of those studies', () => {
  assert.deepEqual(f.jobStudies(X, jobRow()), [X, P]);
  assert.deepEqual(f.jobStudies(X, jobRow({ studies: [X] })), [X]);
  const absent = fn => assert.throws(fn, e => e.getStatus?.() === 404 && e.message === '연결할 저장 작업이 이 검사에 없습니다');
  for (const row of [null, jobRow({ studyUid: P }), jobRow({ studies: [P, X] }), jobRow({ studies: [X, X] }), jobRow({ studies: [] }),
    jobRow({ studies: [X, P, Q] }), jobRow({ studies: 'X' }), jobRow({ studies: [X, 7] }), jobRow({ studies: [X, ''] })]) absent(() => f.jobStudies(X, row));
  assert.equal(f.jobMark(v6(), [X, P], undefined), null, 'a saved view');
  for (const version of f.FINDING_JOB_VERSIONS) assert.equal(f.jobMark({ version }, [X], undefined), null, 'version ' + version);
  assert.deepEqual([...f.FINDING_JOB_VERSIONS], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  for (const version of [0, 16, '6', null]) assert.throws(() => f.jobMark({ version }, [X], undefined), e => e.getStatus?.() === 400 && e.getResponse().code === 'FINDING_JOB_VERSION');
  const mark = f.jobMark(v6(), [X, P], MARK);
  assert.deepEqual(mark, { id: MARK, label: '병변 <b>', point: [-0.33113281957650276, 12.5, 1e-7],
    volume: { study: P, series: '2.25.21', sop: '2.25.22', sourceDigest: 'a'.repeat(64), sopCount: 2 } });
  const bad = fn => assert.throws(fn, e => e.getStatus?.() === 400 && e.getResponse().code === 'FINDING_JOB_MARK');
  bad(() => f.jobMark(v6({ version: 4 }), [X, P], MARK));
  bad(() => f.jobMark(v6(), [X, P], MARK2));
  bad(() => f.jobMark(v6({ volume: { ...volume, study: Q } }), [X, P], MARK));
  bad(() => f.jobMark(v6({ volume: { ...volume, sourceDigest: 'A'.repeat(64) } }), [X, P], MARK));
  bad(() => f.jobMark(v6({ volume: { ...volume, sops: [] } }), [X, P], MARK));
  bad(() => f.jobMark(v6({ marks: { marks: [{ id: MARK, label: 'x', point: [1, 2] }] } }), [X, P], MARK));
  bad(() => f.jobMark(v6({ marks: null }), [X, P], MARK));
  const tags = { SOPInstanceUID: '2.25.22', StudyInstanceUID: P, SeriesInstanceUID: '2.25.21', FrameOfReferenceUID: '2.25.99' };
  assert.equal(f.jobFrame(tags, mark.volume), '2.25.99');
  for (const change of [{ SOPInstanceUID: '2.25.23' }, { StudyInstanceUID: X }, { SeriesInstanceUID: '2.25.2' }, { FrameOfReferenceUID: '' }, { FrameOfReferenceUID: 'x' }])
    assert.throws(() => f.jobFrame({ ...tags, ...change }, mark.volume), e => e.getStatus?.() === 409);
});

test('S2-L1 copy: anchor, projection and whole study set; immutable location; lineage contributions and job link state', () => {
  const mark = f.jobMark(v6(), [X, P], MARK), copy = f.copyJob(jobRow(), [X, P], v6(), mark, '2.25.99');
  assert.deepEqual(copy, { kind: 'job', jobId: JOB, revision: 4, jobStudyUid: X, studyUid: P, studies: [X, P], snapshotVersion: 6, title: '비교 위치',
    authorActor: 'Reader', mark: { id: MARK, label: '병변 <b>', point: [-0.33113281957650276, 12.5, 1e-7],
      volume: { study: P, series: '2.25.21', frameOfReferenceUid: '2.25.99', sourceDigest: 'a'.repeat(64), sopCount: 2 } } });
  // The projection a shipped reader requires is the comparison study; a one-study job projects its anchor.
  const view = f.copyJob(jobRow({ studies: [X] }), [X], { version: 2 }, null, null);
  assert.deepEqual([view.jobStudyUid, view.studyUid, view.studies, view.mark, view.snapshotVersion], [X, X, [X], null, 2]);
  // A metadata refresh keeps the location: only the revision, title and author may differ.
  assert.equal(f.jobLocation(copy), f.jobLocation(f.copyJob(jobRow({ revision: 9, title: '새 제목', authorActor: 'Other' }), [X, P], v6(), mark, '2.25.99')));
  assert.notEqual(f.jobLocation(copy), f.jobLocation(f.copyJob(jobRow(), [X, P], v6(), mark, '2.25.98')));
  assert.notEqual(f.jobLocation(copy), f.jobLocation({ ...copy, studies: [X] }));
  // R6: a well-formed job names exactly its studies; every malformed shape adds the unreadable ''.
  assert.equal(f.jobShape(copy), true); assert.deepEqual(f.sourceStudies(copy), [P, X, P, X]);
  assert.deepEqual(f.sourceStudies({ itemId: ID, studyUid: P, kind: 'length' }), [P]);
  for (const [name, patch] of Object.entries({ three: { studies: [X, P, Q] }, duplicate: { studies: [X, P, P] }, empty: { studies: [] }, missing: { studies: undefined },
    'projection is the anchor': { studyUid: X }, 'anchor is the comparison': { jobStudyUid: P }, 'non-string': { studies: [X, 5] }, reversed: { studies: [P, X] } })) {
    const source = { ...copy, ...patch };
    assert.equal(f.jobShape(source), false, name); assert.ok(f.sourceStudies(source).includes(''), name);
  }
  assert.equal(f.jobLinkState(copy, { id: JOB, studyUid: X, hidden: false, revision: 4 }), 'current');
  assert.equal(f.jobLinkState(copy, { id: JOB, studyUid: X, hidden: false, revision: 5 }), 'metadata-changed');
  assert.equal(f.jobLinkState(copy, { id: JOB, studyUid: X, hidden: true, revision: 5 }), 'hidden');
  assert.equal(f.jobLinkState(copy, { id: JOB, studyUid: P, hidden: false, revision: 4 }), 'missing');
  assert.equal(f.jobLinkState(copy, null), 'missing');
  for (const state of ['current', 'metadata-changed', 'hidden', 'missing']) assert.equal(state.includes('revised'), false);
});

test('S2-L1 R7 envelope: 8 worst item sources with 1000 astral characteristics fit the 64 KiB cap in jsonb text; 2000 would not', () => {
  // jsonb text puts one space after every ':' and ',' outside strings; the service measures that text.
  const jsonb = v => Array.isArray(v) ? '[' + v.map(jsonb).join(', ') + ']' : v && typeof v === 'object'
    ? '{' + Object.keys(v).map(k => JSON.stringify(k) + ': ' + jsonb(v[k])).join(', ') + '}' : JSON.stringify(v);
  const uid64 = '1.' + '2'.repeat(62), actor = 'a'.repeat(254), dbl = -0.33113281957650276, emoji = n => '\u{1F600}'.repeat(n);
  const worst = f.copySource({ id: ID, revision: 2147483647, studyUid: uid64, authorActor: actor, snapshot: { kind: 'ellipse', seriesUid: uid64, sopUid: uid64,
    frame: 2147483647, frameOfReferenceUid: uid64, label: emoji(1000), baseline: { calculator: 'kin-native-manual-v1', values: [dbl, dbl, dbl, dbl, 2147483647] }, sourceDigest: 'f'.repeat(64) } });
  const snapshot = n => JSON.parse(canonical({ schemaVersion: 2, title: emoji(200), text: emoji(4000), characteristics: emoji(n), hidden: false, primary: 7, sources: Array(8).fill(worst) }));
  assert.equal(Buffer.byteLength(jsonb(snapshot(1000))), 60640);
  assert.ok(Buffer.byteLength(jsonb(snapshot(1000))) <= f.FINDING_LIMITS.snapshot);
  assert.ok(Buffer.byteLength(jsonb(snapshot(2000))) > 64000, 'a 2000 bound would leave no margin');
  const point = f.copyJob({ id: JOB, revision: 1000, title: emoji(120), authorActor: actor }, [uid64, uid64.slice(0, -1) + '3'], { version: 6 },
    { id: MARK, label: emoji(160), point: [dbl, dbl, dbl], volume: { study: uid64, series: uid64, sop: uid64, sourceDigest: 'f'.repeat(64), sopCount: 256 } }, uid64);
  const jobs = JSON.parse(canonical({ schemaVersion: 2, title: emoji(200), text: emoji(4000), characteristics: emoji(1000), hidden: false, primary: 7, sources: Array(8).fill(point) }));
  assert.ok(Buffer.byteLength(jsonb(jobs)) < Buffer.byteLength(jsonb(snapshot(1000))), 'a job copy is smaller than the worst item copy');
});
