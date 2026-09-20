// TEST-S3-U2a-CITATION-BACKEND: the compiled citation rules, insertion, carry-forward and reads.
//
// Runs against the built image (/app/dist) exactly like report_stale_draft_test.cjs:
//   docker run --rm --network none --read-only -v "$PWD/tests:/tests:ro" \
//     --entrypoint node kin-api:ci --test /tests/report_citation_test.cjs
// Every database call is a stub, so no Postgres, no Orthanc and no original data.
//
// What this file does NOT prove: that PostgreSQL's CHECK violation actually surfaces carrying the
// constraint name. That is a real-database fact and belongs to tests/viewer_migration_test.py. Here
// the mapping is pinned on a synthesized error, so a rename or a broadened catch is caught early.
const test = require('node:test'), assert = require('node:assert/strict');
const { PacsService } = require('/app/dist/pacs.service');
const citation = require('/app/dist/report-citation');
const vectors = require('/tests/report_citation_vectors.json');

const UID = '2.25.4242', OTHER = '2.25.9999';
const CALLER = { kind: 'member', institution: 'synthetic', sub: 'sub-1', actor: 'doctor@synthetic', roles: ['radiologist'] };
const STATE = { uid: UID, institutionId: 'synthetic', teleInstitutionId: null, rs: 'T', ss: 'Verified', em: 'N',
  holder: null, heldAt: null, preDoc: null, preReviewer: null, repDoc: null, confirm: null };
const FINDING = '00000000-0000-4000-8000-0000000000f1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINE = '우상엽 결절';
const BODY = { findings: LINE, conclusion: '', recommendation: '' };
const INSERT = { field: 'findings', findingId: FINDING, findingRevision: 2, sourceIndex: 1,
  insertedText: LINE, expectedLinkState: 'current', expectedHeadRevision: 7 };

// One readable finding whose second source is a current item; index 0 is a hidden job.
const READABLE = [{ id: FINDING, revision: 2, hidden: false,
  sources: [{ kind: 'job', jobId: 'j-1', revision: 3 }, { kind: 'item', itemId: 'i-1', revision: 7, studyUid: OTHER }],
  links: [{ jobId: 'j-1', linkState: 'hidden', headRevision: 3, headHidden: true },
    { itemId: 'i-1', linkState: 'current', headRevision: 7, headHidden: false }] }];

const carried = (cid, at = '2026-09-01T00:00:00.000Z', by = 'other@synthetic') => ({
  v: 2, cid, field: 'findings', findingId: FINDING, findingRevision: 1, sourceIndex: 0,
  sourceRef: { kind: 'item', itemId: 'i-0', sourceRevision: 1 }, linkStateAtInsert: 'current',
  headRevisionAtInsert: 1, insertedText: '이전 줄', insertedAt: at, insertedBy: by });

// The additive recording below (studyState / transaction / reportVersion.findUnique / draft reads
// and the tx-boundness of require) exists so the historical read has an oracle for the boundaries
// it names: which client read StudyState, whether the access re-check was the transaction-bound
// one, and whether any draft was touched. Every existing case filters `calls` by name, so the new
// entries change nothing for them, and the defaults are unchanged for every existing caller.
function fixture({ state = STATE, report = { version: 4, updatedBy: 'doctor2@synthetic', findings: 'HEAD', conclusion: '', recommendation: '' },
  versions = new Map(), draft = null, readable = READABLE, readableAll = false, bytes = null, fail = null,
  refuseTxRequire = false } = {}) {
  const writes = [], audits = [], raw = [], calls = [], created = [];
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async (strings, ...values) => {
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      raw.push(sql);
      if (sql.includes('FROM "StudyState"')) return [{ uid: UID }];
      if (sql.includes('FROM "Report" WHERE')) return report ? [report] : [];
      if (sql.includes('FROM "ReportDraft"')) { calls.push({ call: 'reportDraft.raw' }); return draft ? [{ citations: draft.citations ?? null }] : []; }
      if (sql.includes('octet_length')) return [{ bytes: bytes ?? Buffer.byteLength(String(values[0] ?? ''), 'utf8') }];
      throw new Error('unexpected raw query: ' + sql);
    },
    studyState: { findUnique: async () => { calls.push({ call: 'studyState', tx: true }); return state; },
      update: async () => { writes.push('studyState.update'); return state; } },
    report: {
      findUnique: async () => (report ? { version: report.version } : null),
      upsert: async a => writes.push('report.upsert:v' + a.create.version),
    },
    reportDraft: {
      findUnique: async () => { calls.push({ call: 'reportDraft.findUnique', tx: true }); return draft; },
      upsert: async a => { writes.push('reportDraft.upsert'); created.push({ call: 'draft', data: a.update });
        return { uid: UID, author: CALLER.actor, baseVersion: a.update.baseVersion, updatedAt: 'now', ...a.update }; },
      deleteMany: async () => { writes.push('reportDraft.deleteMany'); return { count: draft ? 1 : 0 }; },
    },
    reportVersion: {
      findFirst: async () => { const all = [...versions.keys()]; return all.length ? { version: Math.max(...all) } : null; },
      // The uid was ignored before, so a read bound to the wrong study would have passed unnoticed.
      // Every existing caller passes this uid (the service always keys on its own argument).
      findUnique: async a => { calls.push({ call: 'reportVersion.findUnique', args: a });
        return (a.where.uid_version.uid === UID ? versions.get(a.where.uid_version.version) : null) ?? null; },
      create: async a => { if (fail === 'create') throw fail_error();
        writes.push(`reportVersion.create:v${a.data.version}:${a.data.action}`); created.push({ call: 'version', data: a.data }); },
      createMany: async a => { if (fail === 'createMany') throw fail_error();
        writes.push('reportVersion.createMany'); created.push({ call: 'many', data: a.data }); },
    },
    auditLog: { create: async a => { audits.push(a.data); return a.data; } },
  };
  const prisma = {
    $transaction: async (work, options) => { calls.push({ call: 'transaction', options });
      if (fail === 'upsert') throw fail_error(); return work(tx); },
    studyState: { findUnique: async () => { calls.push({ call: 'studyState', tx: false }); return state; } },
    report: { findUnique: async () => report },
    reportDraft: { findUnique: async () => { calls.push({ call: 'reportDraft.findUnique', tx: false }); return draft; } },
    reportVersion: { findMany: async a => { calls.push({ call: 'versions', args: a }); return []; } },
    auditLog: { create: async a => { audits.push(a.data); return a.data; } },
  };
  const studyAccess = { prepare: async () => calls.push({ call: 'prepare' }),
    // The third argument is the transaction client. Recording it is what tells a re-check that
    // runs inside the snapshot from one that ran outside it - the two were indistinguishable.
    // `refuseTxRequire` refuses ONLY the tx-bound call, which is the revocation the new read
    // has to answer with 404 before it reads any version row.
    require: async (_c, _uids, transaction) => { calls.push({ call: 'require', tx: transaction !== undefined });
      if (refuseTxRequire && transaction !== undefined) throw access_revoked(); },
    allowed: async () => new Set() };
  const findings = { readableFindings: async (_tx, _c, uid, ids) => {
    calls.push({ call: 'readableFindings', uid, ids });
    // The real method refuses more than one report's worth of ids (contract 5-12 "at most 64").
    // A stub that accepted any length is what let the dedicated read ask for 128 unnoticed.
    if (ids.length > 64) throw Object.assign(new Error('readableFindings asked for ' + ids.length + ' ids'), { cap: true });
    if (readableAll) return ids.map(id => ({ id, revision: 1, hidden: false, sources: [], links: [] }));
    return readable.filter(row => uid === UID && ids.includes(row.id));
  } };
  const keycloak = { usersInGroupWithRole: async () => [] };
  return { svc: new PacsService(prisma, {}, keycloak, studyAccess, findings), writes, audits, raw, calls, created, tx };
}

// The shape PostgreSQL's driver gives us is unproven until the hosted run; the one thing the
// service may rely on is the constraint name it wrote itself.
const fail_error = () => Object.assign(new Error('null value violates check constraint "ReportVersion_citations_check"'), { code: 'P2010' });

// What StudyAccessService.require() gives the caller when the policy no longer allows the study.
// The class itself is not reachable from this file's module path, so the SHAPE the service and
// `refusal()` see is what is reproduced here: this asserts propagation and ordering, never Nest's
// own mapping (that belongs to the live suite).
const access_revoked = () => Object.assign(new Error('검사를 찾을 수 없습니다'),
  { getStatus: () => 404, getResponse: () => '검사를 찾을 수 없습니다' });

const refusal = async (promise, status) => {
  const e = await promise.then(() => null, error => error);
  assert.ok(e, 'the call resolved instead of being refused');
  assert.equal(e.getStatus?.(), status, e.message);
  return e.getResponse();
};
const put = (f, body, caller = CALLER) => f.svc.putReport(UID, { ...BODY, baseVersion: 4, ...body }, caller);
const commit = (f, body, caller = CALLER) => f.svc.commitReport(UID, { action: 'save', baseVersion: 4, ...BODY, ...body }, caller);
const stored = f => f.created.find(row => row.call === 'draft')?.data.citations;
const signed = f => f.created.filter(row => row.call === 'version').pop()?.data.citations;

test('the shared vectors decide the compiled rule, not the other way round', () => {
  const nfd = (value, want, kind) => (want === kind ? value.normalize('NFD') : value);
  for (const c of vectors.occurrence)
    assert.equal(citation.lineBlockOccurrences(nfd(c.body, c.nfd, 'body'), nfd(c.block, c.nfd, 'block')), c.k, c.name);
  for (const c of vectors.blank) assert.equal(citation.blockIsBlank(c.block), c.refused, c.name);
  for (const c of vectors.sameText) assert.deepEqual(citation.sameTextCounts(c.entries), c.counts, c.name);
  for (const c of vectors.state) assert.equal(citation.presenceState(c.k, c.n), c.state, c.name);
  // n and k must come from one equivalence, or two citations over a single occurrence both claim
  // the text is still there.
  for (const c of vectors.equivalence) {
    assert.deepEqual(c.entries.map(e => citation.lineBlockOccurrences(c.body, e.insertedText)), c.k, c.name);
    const counts = citation.sameTextCounts(c.entries);
    assert.deepEqual(counts, c.counts, c.name);
    assert.deepEqual(counts.map((n, i) => citation.presenceState(c.k[i], n)), c.states, c.name);
  }
  assert.ok(vectors.occurrence.length >= 20 && vectors.equivalence.length >= 5, 'the oracle must not be thinned');
});

test('counting never edits the record: the stored bytes come back exactly as they were written', async () => {
  // n and k share one equivalence, so a trailing line break is absorbed when COMPARING. The entry
  // itself is a medical record and must survive that untouched - including through the read surface.
  const withLf = { ...carried('a'), insertedText: LINE + '\n' }, without = { ...carried('b'), insertedText: LINE };
  const entries = [withLf, without];
  const frozen = JSON.parse(JSON.stringify(entries));
  assert.deepEqual(citation.sameTextCounts(entries), [2, 2], 'the two forms compete for the same occurrence');
  assert.deepEqual(entries, frozen, 'counting must not normalise, trim or otherwise rewrite an entry');
  assert.equal(entries[0].insertedText, LINE + '\n');

  const f = fixture({ versions: new Map([[4, { citations: entries }]]), draft: null });
  const answer = await f.svc.reportCitations(UID, CALLER);
  assert.equal(answer.head[0].insertedText, LINE + '\n', 'the read surface returns the attested bytes');
  assert.equal(answer.head[1].insertedText, LINE);
  assert.deepEqual(answer.head.map(e => e.sameTextCount), [2, 2]);
  assert.deepEqual(entries, frozen, 'and the projection did not write back into the row');
});

test('the keep list is an intersection over my own draft: absent means unchanged, unknown is ignored', () => {
  const rows = [carried('a'), carried('b')];
  assert.deepEqual(citation.applyKeepList(rows, undefined), { kept: rows, ignored: 0 });
  assert.deepEqual(citation.applyKeepList(rows, []), { kept: [], ignored: 0 });
  assert.deepEqual(citation.applyKeepList(rows, ['a']).kept.map(r => r.cid), ['a']);
  // An autosave must never be refused for naming something it does not know about.
  assert.equal(citation.applyKeepList(rows, ['a', 'zzz']).ignored, 1);
});

test('the union carries the head, removes only what was named, and keeps head bytes on a collision', () => {
  const head = [carried('a'), carried('b')];
  const mine = [carried('c', '2026-09-02T00:00:00.000Z', 'me@synthetic'), { ...carried('a'), insertedText: 'FORGED' }];
  const union = citation.citationUnion(head, ['b'], mine);
  assert.deepEqual(union.entries.map(e => e.cid), ['a', 'c']);
  assert.deepEqual(union.removed, ['b']);
  assert.equal(union.entries[0].insertedText, '이전 줄', 'the head row wins a cid collision');
  assert.deepEqual(citation.citationUnion(head, ['nope'], []).entries.map(e => e.cid), ['a', 'b'],
    'an unknown removal is a no-op, never a refusal');
  assert.deepEqual(citation.citationUnion(head, undefined, []).entries.map(e => e.cid), ['a', 'b'],
    'an absent key carries everything forward');
});

test('the insert shape refuses what it cannot bound and silently drops what the server must write', () => {
  for (const bad of [{ field: 'notes' }, { field: 'findings', findingId: '' }, { sourceIndex: 8 }, { sourceIndex: -1 },
    { findingRevision: 0 }, { insertedText: '   ' }, { insertedText: '' }, { expectedLinkState: '' }])
    assert.throws(() => citation.citationInsertInput({ ...INSERT, ...bad }), citation.CitationInputError, JSON.stringify(bad));
  assert.throws(() => citation.citationInsertInput({ ...INSERT, insertedText: 'ㄱ'.repeat(1400) }), citation.CitationInputError);
  const forged = citation.citationInsertInput({ ...INSERT, cid: 'forged', insertedBy: 'boss@synthetic',
    insertedAt: '1999-01-01T00:00:00.000Z', sourceRef: { kind: 'item', itemId: 'evil' }, linkStateAtInsert: 'current',
    headRevisionAtInsert: 99, v: 9 });
  assert.deepEqual(Object.keys(forged).sort(),
    ['expectedHeadRevision', 'expectedLinkState', 'field', 'findingId', 'findingRevision', 'insertedText', 'sourceIndex']);
});

test('text the database cannot store is a request error, not a 500 from the byte query', () => {
  // jsonb refuses NUL and unpaired surrogates. Without this the insertion would die inside the
  // measuring query and the author would be told the server broke, with nothing to fix.
  const nul = String.fromCharCode(0), lone = String.fromCharCode(0xd800);
  for (const bad of [LINE + nul, nul + LINE, LINE + lone])
    assert.throws(() => citation.citationInsertInput({ ...INSERT, insertedText: bad }), citation.CitationInputError,
      'code points ' + [...bad].map(ch => ch.codePointAt(0)).join(','));
  // A real astral character is a single code point and stays perfectly storable.
  const astral = String.fromCodePoint(0x1f600) + ' 결절';
  assert.equal(citation.citationInsertInput({ ...INSERT, insertedText: astral }).insertedText, astral);
});

test('a validated insertion is attested by the server alone, in the same write as the sentence', async () => {
  const f = fixture({ draft: { baseVersion: 4, citations: [] } });
  const answer = await put(f, { insert: { ...INSERT, cid: 'forged', insertedBy: 'boss@synthetic',
    insertedAt: '1999-01-01T00:00:00.000Z', linkStateAtInsert: 'missing' } });
  const [entry] = stored(f);
  assert.match(entry.cid, UUID);
  assert.notEqual(entry.cid, 'forged');
  assert.equal(entry.insertedBy, CALLER.actor, 'the caller is the author, whatever the body said');
  assert.notEqual(entry.insertedAt, '1999-01-01T00:00:00.000Z');
  assert.equal(entry.linkStateAtInsert, 'current', 'the state is recomputed, never taken from the body');
  assert.deepEqual(entry.sourceRef, { kind: 'item', itemId: 'i-1', sourceRevision: 7 });
  assert.equal(entry.insertedText, LINE);
  assert.equal(entry.findingId, FINDING);
  // The sentence and its attestation are one upsert; nothing else is written.
  assert.deepEqual(f.writes, ['reportDraft.upsert']);
  assert.deepEqual(answer.inserted, { cid: entry.cid, field: 'findings', insertedAt: entry.insertedAt });
  assert.equal(answer.findings, undefined, 'the response must not carry the report body back');
  assert.equal(answer.citations, undefined, 'nor the citations');
});

test('lineage authorization is prepared before the transaction, or the comparison study answers 409', async () => {
  const f = fixture({ draft: { baseVersion: 4, citations: [] } });
  await put(f, { insert: INSERT });
  const names = f.calls.map(c => c.call);
  assert.ok(names.indexOf('prepare') < names.indexOf('readableFindings'));
  assert.equal(f.calls.find(c => c.call === 'prepare').call, 'prepare');
  // Without an insertion nothing asks about findings at all.
  const plain = fixture({ draft: { baseVersion: 4 } });
  await put(plain, {});
  assert.deepEqual(plain.calls.filter(c => c.call === 'readableFindings'), []);
});

test('every insertion refusal answers before anything is written', async () => {
  const cases = [
    ['an unreadable or absent finding', { findingId: '00000000-0000-4000-8000-00000000dead' }, 409, READABLE],
    ['a finding that moved on', { findingRevision: 1 }, 409, READABLE],
    ['a hidden finding', {}, 409, [{ ...READABLE[0], hidden: true }]],
    ['a hidden source', { sourceIndex: 0, expectedLinkState: 'hidden', expectedHeadRevision: 3 }, 409, READABLE],
    ['a source that moved on', { expectedHeadRevision: 6 }, 409, READABLE],
    ['a state the screen did not see', { expectedLinkState: 'revised' }, 409, READABLE],
    ['a sentence that is not in the field', { insertedText: '없는 줄' }, 409, READABLE],
    ['a fragment of a line', { insertedText: '결절' }, 409, READABLE],
    ['the wrong field', { field: 'conclusion' }, 409, READABLE],
    ['an out of range source index', { sourceIndex: 8 }, 400, READABLE],
    ['an unknown field name', { field: 'notes' }, 400, READABLE],
    ['a blank sentence', { insertedText: ' \n ' }, 400, READABLE],
  ];
  for (const [name, patch, status, readable] of cases) {
    const f = fixture({ draft: { baseVersion: 4, citations: [] }, readable });
    await refusal(put(f, { insert: { ...INSERT, ...patch } }), status);
    assert.deepEqual(f.writes, [], name);
  }
});

test('a missing source and an unreadable finding are refused with the same words', async () => {
  const unreadable = fixture({ draft: { baseVersion: 4 }, readable: [] });
  const denied = await refusal(put(unreadable, { insert: INSERT }), 409);
  const missing = fixture({ draft: { baseVersion: 4 },
    readable: [{ ...READABLE[0], links: [READABLE[0].links[0], { itemId: 'i-1', linkState: 'missing', headRevision: null }] }] });
  const gone = await refusal(put(missing, { insert: INSERT }), 409);
  // Saying which one it was would itself tell the caller something about a study they cannot read.
  assert.equal(denied.code, 'REPORT_CITATION_SOURCE');
  assert.equal(gone.code, 'REPORT_CITATION_SOURCE');
});

test('an old client that sends no citation key changes nothing, and [] clears my own', async () => {
  const rows = [carried('a')];
  const untouched = fixture({ draft: { baseVersion: 4, citations: rows } });
  await put(untouched, {});
  assert.equal(stored(untouched), undefined, 'the column is not written at all');
  assert.deepEqual(untouched.raw, [], 'and the row is not even locked');

  const cleared = fixture({ draft: { baseVersion: 4, citations: rows } });
  await put(cleared, { citationIds: [] });
  assert.deepEqual(stored(cleared), []);

  const partial = fixture({ draft: { baseVersion: 4, citations: [carried('a'), carried('b')] } });
  await put(partial, { citationIds: ['b', 'unknown-cid'] });
  assert.deepEqual(stored(partial).map(e => e.cid), ['b']);
  const detail = JSON.parse(partial.audits.find(a => a.action === 'report.draft').detail);
  assert.deepEqual(detail.cits, { n: 1, ignored: 1 }, 'unknown ids are counted, never refused');
});

test('an insertion into an emptied report is refused, not silently dropped with a 200', async () => {
  const f = fixture({ draft: { baseVersion: 4, citations: [] } });
  const body = await refusal(f.svc.putReport(UID,
    { findings: '', conclusion: '', recommendation: '', baseVersion: 4, insert: INSERT }, CALLER), 409);
  assert.equal(body.code, 'REPORT_CITATION_TEXT');
  assert.deepEqual(f.writes, [], 'the clearing delete must not happen either');
});

test('a malformed citation key is a request error, not a silent no-op', async () => {
  for (const bad of ['a', 1, {}, [1], [null]]) {
    const f = fixture({ draft: { baseVersion: 4 } });
    await refusal(put(f, { citationIds: bad }), 400);
    assert.deepEqual(f.writes, []);
  }
});

test('the head is the version row at Report.version, never the highest row', async () => {
  // A reset or a forced release leaves a discarded row with a HIGHER number than the head.
  const versions = new Map([[4, { citations: [carried('head-1')] }], [5, { citations: [carried('discarded-1')] }]]);
  const f = fixture({ versions, draft: { baseVersion: 4, citations: [carried('mine', '2026-09-03T00:00:00.000Z', 'me@synthetic')] } });
  await commit(f, { action: 'approve', citationIds: ['mine'] });
  assert.deepEqual(signed(f).map(e => e.cid), ['head-1', 'mine'],
    'someone else\'s discarded draft must never appear as carried forward');
  const head = signed(f)[0];
  assert.equal(head.insertedBy, 'other@synthetic', 'a carried entry keeps its original author');
  assert.equal(head.insertedAt, '2026-09-01T00:00:00.000Z', 'and its original time, byte for byte');
});

test('head entries leave only through an explicit removal, and a stale screen cannot drop what it never saw', async () => {
  const versions = new Map([[4, { citations: [carried('a'), carried('b')] }]]);
  const absent = fixture({ versions, draft: { baseVersion: 4 } });
  await commit(absent, { action: 'approve' });
  assert.deepEqual(signed(absent).map(e => e.cid), ['a', 'b'], 'no key means carry everything');

  const removed = fixture({ versions, draft: { baseVersion: 4 } });
  await commit(removed, { action: 'approve', removeCitationIds: ['a', 'never-seen'] });
  assert.deepEqual(signed(removed).map(e => e.cid), ['b']);
  const detail = JSON.parse(removed.audits.find(a => a.action === 'report.approve').detail);
  assert.deepEqual(detail.cits, { n: 1, dropped: ['a'] });
  assert.equal(detail.findingId, undefined);
});

test('reset and an empty commit sign an empty list, and reset preserves the head attestation', async () => {
  const versions = new Map([[4, { citations: [carried('a')] }]]);
  const f = fixture({ versions, state: { ...STATE, rs: 'A' }, draft: { baseVersion: 4 } });
  await f.svc.commitReport(UID, { action: 'reset', baseVersion: 4, reason: '취소', ...BODY }, CALLER);
  const rows = f.created.filter(r => r.call === 'version');
  assert.deepEqual(rows[0].data.citations.map(e => e.cid), ['a'], 'the row kept just before clearing keeps its attestation');
  assert.equal(rows[0].data.action, 'discarded');
  assert.deepEqual(rows[1].data.citations, [], 'the reset version itself attests nothing');

  const blank = fixture({ versions, draft: { baseVersion: 4 } });
  await blank.svc.commitReport(UID, { action: 'save', baseVersion: 4, findings: '', conclusion: '', recommendation: '' }, CALLER);
  assert.deepEqual(signed(blank), [], 'an empty report has nothing to attest');
});

test('a forced release preserves each author\'s own citations and survives rows that have none', async () => {
  const f = fixture({ draft: { baseVersion: 4 } });
  f.tx.$queryRaw = async (strings) => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim();
    if (sql.includes('FROM "StudyState"')) return [{ uid: UID }];
    return [{ uid: UID, author: 'a@synthetic', findings: 'A', conclusion: '', recommendation: '', baseVersion: 1, citations: [carried('mine')], updatedAt: 'now' },
      { uid: UID, author: 'b@synthetic', findings: 'B', conclusion: '', recommendation: '', baseVersion: 1, citations: null, updatedAt: 'now' }];
  };
  await f.svc.forceDiscardDrafts(UID, { ...CALLER, roles: ['admin'] });
  const rows = f.created.find(r => r.call === 'many').data;
  assert.deepEqual(rows[0].citations.map(e => e.cid), ['mine']);
  // A re-read NULL must be omitted, not written: otherwise every forced release of an older draft fails.
  assert.equal('citations' in rows[1], false);
  assert.equal(rows[0].author, 'a@synthetic', 'the writer stays the author');
});

test('the only new refusal at signing is the named limit, and it never routes an old tab into the reload branch', async () => {
  const head = Array.from({ length: 40 }, (_, i) => carried('h' + i));
  const mine = Array.from({ length: 30 }, (_, i) => carried('m' + i, '2026-09-03T00:00:00.000Z', 'me@synthetic'));
  const f = fixture({ versions: new Map([[4, { citations: head }]]), draft: { baseVersion: 4, citations: mine } });
  const body = await refusal(commit(f, { action: 'approve' }), 409);
  assert.equal(body.code, 'REPORT_CITATION_LIMIT');
  assert.doesNotMatch(body.message, /저장했습니다/);
  assert.match(body.message, /제거/);
  assert.deepEqual(f.writes, [], 'the draft and its citations survive the refusal');
});

test('an insertion is refused before the union can exceed the cap, and a keep list is the way back', async () => {
  // The preventive check at insertion time: head + my draft + 1. It is not authoritative (the head
  // is read unlocked) but it is what keeps an ordinary insertion from building a draft that can
  // never be signed.
  const head = Array.from({ length: 40 }, (_, i) => carried('h' + i));
  const mine = Array.from({ length: 24 }, (_, i) => carried('m' + i, '2026-09-03T00:00:00.000Z', 'me@synthetic'));
  const versions = new Map([[4, { citations: head }]]);
  const f = fixture({ versions, draft: { baseVersion: 4, citations: mine } });
  const body = await refusal(put(f, { insert: INSERT }), 409);
  assert.equal(body.code, 'REPORT_CITATION_LIMIT');
  assert.deepEqual(f.writes, [], 'nothing is written, so the draft the user is typing survives');

  // An autosave that only shrinks the list is never limit-refused - that is the exit.
  const recovering = fixture({ versions, draft: { baseVersion: 4, citations: mine } });
  await put(recovering, { citationIds: mine.slice(0, 10).map(e => e.cid) });
  assert.equal(stored(recovering).length, 10);
  assert.deepEqual(recovering.raw.filter(sql => sql.includes('octet_length')), [],
    'a keep-list-only PUT does not even measure: it cannot grow');
});

test('emptying the report deletes the draft row and the attestation of text that is gone', async () => {
  const f = fixture({ draft: { baseVersion: 4, citations: [carried('a')] } });
  const answer = await f.svc.putReport(UID, { findings: '', conclusion: '', recommendation: '', baseVersion: 4 }, CALLER);
  assert.equal(answer.cleared, true);
  assert.deepEqual(f.writes, ['reportDraft.deleteMany']);
  // No text, no attestation: the row carries both or neither.
  assert.deepEqual(f.audits.map(a => a.action), ['report.draft.clear']);
});

test('the byte bound is whatever the database measured, not a shorter local guess', async () => {
  const f = fixture({ versions: new Map([[4, { citations: [carried('a')] }]]), draft: { baseVersion: 4 }, bytes: 65537 });
  const body = await refusal(commit(f, { action: 'approve' }), 409);
  assert.equal(body.code, 'REPORT_CITATION_LIMIT');
  const measured = f.raw.filter(sql => sql.includes('octet_length'));
  assert.equal(measured.length, 1);
  assert.match(measured[0], /::jsonb::text, 'UTF8'/);
  const inside = fixture({ versions: new Map([[4, { citations: [carried('a')] }]]), draft: { baseVersion: 4 }, bytes: 65536 });
  await commit(inside, { action: 'approve' });
  assert.equal(signed(inside).length, 1, 'exactly at the bound is still allowed');
});

test('a citation CHECK becomes the same named 409 on all three write paths, and other errors are untouched', async () => {
  const draft = { baseVersion: 4, citations: [] };
  const insertion = await refusal(fixture({ draft, fail: 'upsert' }).svc.putReport(UID, { ...BODY, baseVersion: 4, insert: INSERT }, CALLER), 409);
  assert.equal(insertion.code, 'REPORT_CITATION_LIMIT');
  const signing = await refusal(commit(fixture({ draft, fail: 'create' }), { action: 'approve' }), 409);
  assert.equal(signing.code, 'REPORT_CITATION_LIMIT');
  const forced = fixture({ draft, fail: 'createMany' });
  forced.tx.$queryRaw = async strings => (strings.join('?').includes('StudyState') ? [{ uid: UID }]
    : [{ uid: UID, author: 'a@synthetic', findings: 'A', conclusion: '', recommendation: '', baseVersion: 1, citations: null, updatedAt: 'now' }]);
  const release = await refusal(forced.svc.forceDiscardDrafts(UID, { ...CALLER, roles: ['admin'] }), 409);
  assert.equal(release.code, 'REPORT_CITATION_LIMIT');

  // A different database failure must stay a different failure; swallowing it would disguise a real
  // fault as "remove a citation".
  const other = fixture({ draft, fail: 'create' });
  other.tx.reportVersion.create = async () => { throw Object.assign(new Error('column "x" does not exist'), { code: 'P2010' }); };
  const e = await commit(other, { action: 'approve' }).then(() => null, error => error);
  assert.match(String(e.message), /column "x"/);
  assert.notEqual(e.getStatus?.(), 409);
});

test('a version-number collision retries, and a CHECK on the retry leg is the same named 409', async () => {
  const f = fixture({ draft: { baseVersion: 4 } });
  f.tx.$queryRaw = async strings => (strings.join('?').includes('StudyState') ? [{ uid: UID }]
    : [{ uid: UID, author: 'a@synthetic', findings: 'A', conclusion: '', recommendation: '', baseVersion: 1, citations: [carried('mine')], updatedAt: 'now' }]);
  let attempt = 0;
  f.tx.reportVersion.createMany = async () => {
    attempt += 1;
    // First a real number collision with a concurrent commit, then the CHECK on the second try.
    if (attempt === 1) throw Object.assign(new Error('unique constraint'), { code: 'P2002' });
    throw fail_error();
  };
  const body = await refusal(f.svc.forceDiscardDrafts(UID, { ...CALLER, roles: ['admin'] }), 409);
  assert.equal(attempt, 2, 'the collision really did retry');
  assert.equal(body.code, 'REPORT_CITATION_LIMIT',
    'mapping only the first attempt would let the same request answer two different ways');
});

test('the history response names its columns and the new one is not among them', async () => {
  const f = fixture();
  await f.svc.versions(UID, CALLER);
  const args = f.calls.find(c => c.call === 'versions').args;
  assert.ok(args.select, 'a whole-row history response would carry citations');
  assert.equal(args.select.citations, undefined);
  assert.equal(args.select.findings, true);
});

test('the dedicated read re-gates finding readability and reduces what it cannot vouch for', async () => {
  const readableEntry = { ...carried('a'), findingId: FINDING, insertedText: LINE };
  const hiddenLineage = { ...carried('b'), findingId: '00000000-0000-4000-8000-00000000beef', insertedText: LINE };
  const f = fixture({ versions: new Map([[4, { citations: [readableEntry, hiddenLineage] }]]),
    draft: { baseVersion: 4, citations: [{ ...readableEntry, cid: 'c' }] } });
  const answer = await f.svc.reportCitations(UID, CALLER);
  assert.equal(answer.version, 4);
  assert.equal(answer.head[0].insertedText, LINE);
  // n counts the whole row, reduced entries included, or the screen would call an ambiguous
  // sentence 'present'.
  assert.equal(answer.head[0].sameTextCount, 2);
  assert.deepEqual(Object.keys(answer.head[1]).sort(), ['cid', 'field', 'insertedAt', 'insertedBy', 'state']);
  assert.equal(answer.head[1].state, 'source-unavailable');
  assert.equal(answer.head[1].insertedText, undefined, 'an unreadable lineage exports no clinical text');
  assert.equal(answer.draft[0].sameTextCount, 1, 'the draft row is counted on its own');
});

test('the over-limit state the signer has to escape from is exactly the one the read must answer', async () => {
  // head 40 + draft 30 is the contract's own named case: each row is legal on its own, the union is
  // not, and commit says "remove some". Asking for all 70 ids at once would trip the 64 cap of the
  // very query that lists the cids, leaving the signer told to remove something they cannot see.
  const head = Array.from({ length: 40 }, (_, i) => ({ ...carried('h' + i), findingId: 'head-finding-' + i }));
  const mine = Array.from({ length: 30 }, (_, i) => ({ ...carried('m' + i), findingId: 'draft-finding-' + i }));
  const f = fixture({ versions: new Map([[4, { citations: head }]]), draft: { baseVersion: 4, citations: mine }, readableAll: true });
  const answer = await f.svc.reportCitations(UID, CALLER);
  assert.equal(answer.head.length, 40);
  assert.equal(answer.draft.length, 30);
  assert.equal(answer.head.every(e => e.state === undefined), true, 'every entry stayed readable');
  const asked = f.calls.filter(c => c.call === 'readableFindings').map(c => c.ids.length);
  assert.deepEqual(asked, [40, 30], 'one call per row, each inside the 64 cap');
});

test('the citation read answers the report gates first', async () => {
  const hidden = fixture({ state: { ...STATE, rs: 'P', preDoc: 'other@synthetic', preReviewer: 'boss@synthetic' } });
  await refusal(hidden.svc.reportCitations(UID, CALLER), 403);
  const absent = fixture({ state: null });
  await refusal(absent.svc.reportCitations(UID, CALLER), 404);
  // The gate is the one versions() uses (contract 5-12): institution, study, preliminary - not role.
  // A technician therefore reads the head attestation, and only ever their own draft, which is none.
  const technician = fixture({ versions: new Map([[4, { citations: [carried('a')] }]]) });
  const answer = await technician.svc.reportCitations(UID, { ...CALLER, roles: ['technician'] });
  assert.equal(answer.head.length, 1, 'the head attestation follows the same gate as the history');
  assert.deepEqual(answer.draft, [], 'a draft belongs to its author; no one else\'s is ever returned');
});

test('no audit line carries a source pointer or clinical text', async () => {
  const f = fixture({ draft: { baseVersion: 4, citations: [] } });
  await put(f, { insert: INSERT });
  const versions = new Map([[4, { citations: [carried('a')] }]]);
  const g = fixture({ versions, draft: { baseVersion: 4 } });
  await commit(g, { action: 'approve', removeCitationIds: ['a'] });
  for (const entry of [...f.audits, ...g.audits]) {
    const detail = String(entry.detail ?? '');
    assert.doesNotMatch(detail, /findingId/, entry.action);
    assert.doesNotMatch(detail, /sourceIndex/, entry.action);
    assert.doesNotMatch(detail, /insertedText/, entry.action);
    assert.ok(!detail.includes(LINE), entry.action + ' must not carry report text');
    assert.ok(!detail.includes(FINDING), entry.action + ' must not carry a finding id');
  }
  const draftDetail = JSON.parse(f.audits.find(a => a.action === 'report.draft').detail);
  assert.equal(draftDetail.cits.n, 1);
  assert.equal(draftDetail.cits.add[0].field, 'findings');
  assert.match(draftDetail.cits.add[0].cid, UUID);
});

// ── S3-U5b: the historical row read ───────────────────────────────────────────────────────────
// REQ-S3-U5b-HISTORY-CITATION -> RISK-S3-U5b-WRONG-BODY / FALSE-EMPTY / DRAFT-LEAK /
// REVOKED-LINEAGE / ALIASED-VERSION -> TEST-S3-U5b-VERSION-CITATIONS.
const preserved = (citations, findings = LINE) =>
  ({ citations, findings, conclusion: '', recommendation: '' });
const historyRead = (f, version, caller = CALLER) => f.svc.reportVersionCitations(UID, version, caller);

test('the historical read runs the report gates and the access re-check inside one snapshot', async () => {
  const f = fixture({ versions: new Map([[2, preserved([{ ...carried('a'), findingId: FINDING, insertedText: LINE }])]]) });
  const answer = await historyRead(f, '2');
  assert.equal(answer.version, 2);
  // The order IS the security contract: nothing is read before the policy is prepared, the gate
  // and the row come from the same transaction, and the access re-check is the tx-bound one.
  assert.deepEqual(f.calls.map(c => c.call),
    ['prepare', 'transaction', 'studyState', 'require', 'reportVersion.findUnique', 'readableFindings']);
  assert.equal(f.calls.find(c => c.call === 'transaction').options.isolationLevel, 'RepeatableRead');
  assert.equal(f.calls.find(c => c.call === 'studyState').tx, true);
  assert.equal(f.calls.find(c => c.call === 'require').tx, true);
  assert.deepEqual(f.calls.filter(c => c.call === 'studyState' && !c.tx), [],
    'a StudyState read outside the transaction reopens the RS->P window this method closes');
  assert.deepEqual(f.calls.filter(c => c.call === 'require' && !c.tx), [],
    'there is no outer gate on this method, so no untransacted require may appear');

  const hidden = fixture({ state: { ...STATE, rs: 'P', preDoc: 'other@synthetic', preReviewer: 'boss@synthetic' },
    versions: new Map([[2, preserved([carried('a')])]]) });
  await refusal(historyRead(hidden, '2'), 403);
  const absent = fixture({ state: null });
  await refusal(historyRead(absent, '2'), 404);
  const foreign = fixture({ state: { ...STATE, institutionId: 'other-hospital' } });
  await refusal(historyRead(foreign, '2'), 404);

  // The revocation this surface exists to honour: readability withdrawn between two viewings.
  const revoked = fixture({ versions: new Map([[2, preserved([carried('a')])]]), refuseTxRequire: true });
  await refusal(historyRead(revoked, '2'), 404);
  assert.deepEqual(revoked.calls.filter(c => c.call === 'reportVersion.findUnique'), [],
    'a refused access re-check must answer before any version row is read');
});

test('the historical read answers one preserved row, and a version with no row is not an empty one', async () => {
  const mine = { ...carried('a', '2026-09-02T00:00:00.000Z', 'v2-author@synthetic'), findingId: FINDING, insertedText: LINE };
  const head = { ...carried('z', '2026-09-03T00:00:00.000Z', 'v4-author@synthetic'), findingId: FINDING, insertedText: LINE };
  const f = fixture({ versions: new Map([[2, preserved([mine])], [4, preserved([head])]]) });
  const answer = await historyRead(f, '2');
  const call = f.calls.find(c => c.call === 'reportVersion.findUnique');
  assert.deepEqual(call.args.where, { uid_version: { uid: UID, version: 2 } });
  assert.deepEqual(Object.keys(call.args.select).sort(), ['citations', 'conclusion', 'findings', 'recommendation'],
    'action/author/at/reason belong to the history response and must not leave the DB layer here');
  assert.equal(answer.entries.length, 1);
  assert.equal(answer.entries[0].insertedBy, 'v2-author@synthetic', 'the head row is not the answer');

  // A version that has no row is 404. Saying "no citations" about a version that does not exist
  // is the same lie as saying it about one this reader may not see.
  const missing = fixture({ versions: new Map([[4, preserved([head])]]) });
  await refusal(historyRead(missing, '9'), 404);
  // A row that never carried citations is a TRUE zero, and that is a different answer from 404.
  const empty = fixture({ versions: new Map([[2, preserved(null, '')]]) });
  assert.deepEqual((await historyRead(empty, '2')).entries, []);
});

test('the historical answer is metadata only, reads no draft on any path and writes nothing', async () => {
  const readableEntry = { ...carried('a'), findingId: FINDING, insertedText: LINE };
  const hiddenLineage = { ...carried('b'), findingId: '00000000-0000-4000-8000-00000000beef', insertedText: LINE };
  const f = fixture({ versions: new Map([[2, preserved([readableEntry, hiddenLineage])]]),
    draft: { baseVersion: 4, citations: [{ ...readableEntry, cid: 'draft-cid' }] } });
  const answer = await historyRead(f, '2');
  assert.deepEqual(Object.keys(answer).sort(), ['actor', 'entries', 'version']);
  assert.equal(answer.actor, CALLER.actor);
  assert.deepEqual(Object.keys(answer.entries[0]).sort(),
    ['field', 'findingRevision', 'insertedAt', 'insertedBy', 'linkStateAtInsert', 'presence', 'sourceIndex']);
  assert.deepEqual(Object.keys(answer.entries[1]).sort(), ['field', 'insertedAt', 'insertedBy', 'state']);
  for (const entry of answer.entries)
    for (const key of ['insertedText', 'cid', 'findingId', 'sourceRef', 'sameTextCount', 'headRevisionAtInsert'])
      assert.equal(entry[key], undefined, key + ' must not be on the wire for a past version');
  assert.equal(JSON.stringify(answer).includes(LINE), false, 'no sentence leaves the server for a past version');
  // Someone else's draft is not a version, and my own is the head read's business.
  assert.deepEqual(f.calls.filter(c => String(c.call).startsWith('reportDraft')), []);
  assert.deepEqual(f.raw.filter(sql => sql.includes('ReportDraft')), []);
  assert.deepEqual(f.writes, [], 'a read writes nothing');
});

test('a historical row is reduced entry by entry and asked about on its own', async () => {
  const readableEntry = { ...carried('a'), findingId: FINDING, insertedText: LINE };
  const hiddenLineage = { ...carried('b'), findingId: '00000000-0000-4000-8000-00000000beef', insertedText: LINE };
  const f = fixture({ versions: new Map([[2, preserved([readableEntry, hiddenLineage])],
    [4, preserved([{ ...carried('z'), findingId: FINDING, insertedText: LINE }])]]) });
  const answer = await historyRead(f, '2');
  assert.equal(answer.entries.length, 2, 'an unreadable lineage is reduced, never dropped');
  assert.equal(answer.entries[1].state, 'source-unavailable');
  assert.equal(answer.entries[1].presence, undefined, 'a reduced entry claims nothing about the body');
  const asked = f.calls.filter(c => c.call === 'readableFindings');
  assert.equal(asked.length, 1, 'one row, one question');
  assert.deepEqual(asked[0].ids, [FINDING, '00000000-0000-4000-8000-00000000beef'],
    'only the ids of the row that was asked for');
});

test('the historical read refuses a version number that is not a canonical INT4, before any read', async () => {
  // Number() would alias real versions ('01', '+1', ' 1', '1e2', '0x10') and let 2^31..2^53 reach
  // an Int column, where the answer is neither 400 nor 404.
  for (const bad of ['0', '-1', '1.5', '3x', '', '01', '+1', ' 1', '1e2', '0x10', '2147483648', '9007199254740992']) {
    const f = fixture({ versions: new Map([[2, preserved([carried('a')])]]) });
    await refusal(historyRead(f, bad), 400);
    assert.deepEqual(f.calls, [], 'refused before prepare, the transaction and any StudyState read: ' + JSON.stringify(bad));
    assert.deepEqual(f.raw, [], JSON.stringify(bad));
  }
  const edge = fixture({ versions: new Map() });
  await refusal(historyRead(edge, '2147483647'), 404);
  assert.deepEqual(edge.calls.map(c => c.call),
    ['prepare', 'transaction', 'studyState', 'require', 'reportVersion.findUnique'],
    'the largest Int is a shape the gates may run for');
});

test('a preserved discarded row answers its own testimony and no one else\'s draft', async () => {
  // The admin force-discard keeps each author's own draft as a version row (its body is already
  // in the history response); this read adds its metadata and nothing more.
  const theirs = { ...carried('x', '2026-09-02T00:00:00.000Z', 'author-x@synthetic'), findingId: FINDING, insertedText: LINE };
  const unreadable = { ...carried('y', '2026-09-02T00:00:00.000Z', 'author-x@synthetic'),
    findingId: '00000000-0000-4000-8000-00000000beef', insertedText: LINE };
  const f = fixture({ versions: new Map([[5, preserved([theirs, unreadable])],
    [6, preserved([{ ...carried('z'), findingId: FINDING, insertedText: LINE }])]]),
    draft: { baseVersion: 4, citations: [{ ...theirs, cid: 'live-draft' }] } });
  const reader = { ...CALLER, actor: 'reader-y@synthetic' };
  const answer = await historyRead(f, '5', reader);
  assert.equal(answer.actor, 'reader-y@synthetic', 'the attribution names who the server saw');
  assert.equal(answer.entries.length, 2);
  assert.equal(answer.entries[0].insertedBy, 'author-x@synthetic', 'the historical author is a fact of the row');
  assert.equal(answer.entries[1].state, 'source-unavailable');
  assert.deepEqual(f.calls.filter(c => String(c.call).startsWith('reportDraft')), [],
    'a live draft row is never read by this surface, not even the caller\'s own');
  assert.equal(JSON.stringify(answer).includes(LINE), false);
});

test('presence is counted against that row\'s own body, over the whole row, and never invented', async () => {
  const entry = { ...carried('a'), findingId: FINDING, insertedText: LINE };
  const rows = () => new Map([[2, preserved([entry], LINE)], [7, preserved([entry], '다른 본문')]]);
  assert.equal((await historyRead(fixture({ versions: rows() }), '2')).entries[0].presence, 'present');
  // The same entry in a later row whose body no longer holds the line: 'absent' is a fact ABOUT
  // THAT ROW. Counting it against the head is the misread this whole unit exists to prevent.
  assert.equal((await historyRead(fixture({ versions: rows() }), '7')).entries[0].presence, 'absent');

  // A reduced twin still competes for the same occurrence, or one occurrence would make two
  // citations both claim the sentence is there.
  const twin = { ...carried('b'), findingId: '00000000-0000-4000-8000-00000000beef', insertedText: LINE };
  const twins = fixture({ versions: new Map([[2, preserved([entry, twin])]]) });
  assert.equal((await historyRead(twins, '2')).entries[0].presence, 'ambiguous');

  // What cannot be counted is not 'absent'. lineBlockOccurrences coerces a non-string to '' and
  // would otherwise report 0 occurrences, i.e. invent "the sentence is gone" about a row nobody
  // could check. The screen turns this null into "확인하지 못했습니다" for the whole version.
  const legacy = fixture({ versions: new Map([[2, preserved([{ ...carried('c'), findingId: FINDING, insertedText: null }])]]) });
  assert.equal((await historyRead(legacy, '2')).entries[0].presence, null);
  const strangeField = fixture({ versions: new Map([[2, preserved([{ ...carried('d'), findingId: FINDING, field: 'citations', insertedText: LINE }])]]) });
  assert.equal((await historyRead(strangeField, '2')).entries[0].presence, null,
    'an unknown field must not index some other column of the row');
});
