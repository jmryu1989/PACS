// TEST-S3-U3-STALE-ADDENDUM: the compiled commitReport/putReport guards.
// (S7-U5: the requests carry the draft owner and boundary; the caller's draft row is locked and kept as a tombstone.)
//
// Runs against the built image (/app/dist) exactly like study_access_service_test.cjs:
//   docker run --rm --network none --read-only -v "$PWD/tests:/tests:ro" \
//     --entrypoint node kin-api:ci --test /tests/report_stale_draft_test.cjs
// Every database call is a stub, so no Postgres, no Orthanc and no original data.
const test = require('node:test'), assert = require('node:assert/strict');
const { PacsService } = require('/app/dist/pacs.service');

const UID = '2.25.4242';
const CALLER = { kind: 'member', institution: 'synthetic', sub: 'sub-1', actor: 'doctor@synthetic', roles: ['radiologist'] };
const HEAD = { version: 4, updatedBy: 'doctor2@synthetic', findings: 'HEAD F\r\n  edge  \n', conclusion: '', recommendation: 'HEAD R' };
const STATE = { uid: UID, institutionId: 'synthetic', teleInstitutionId: null, rs: 'A', ss: 'Verified', em: 'N',
  holder: null, heldAt: null, preDoc: null, preReviewer: null, repDoc: 'doctor2', confirm: '2026-09-19' };
const BODY = { findings: 'MY ADDENDUM', conclusion: '', recommendation: '' };

// S7-U5: every draft mutation carries the account and the boundary its document read, and a draft PUT the whole
// snapshot. `asDocument` is that document: it sends what a page that has just read this fixture's study would send.
const EPOCH = '0a1b2c3d-0000-4000-8000-00000000000a';
const OWNER = { institution: CALLER.institution, sub: CALLER.sub, author: CALLER.actor };

function fixture({ state = STATE, head = HEAD, draft = null } = {}) {
  const writes = [], audits = [], raw = [], reads = [];
  const record = (list, value) => { list.push(value); return value; };
  // The caller's draft row as the store holds it (the fixture's `draft` names only its base version).
  let row = draft ? { uid: UID, author: CALLER.actor, findings: 'SYN DRAFT', conclusion: '', recommendation: '', citations: null,
    structured: null, revision: 1, present: true, updatedAt: new Date(0), ...draft } : null;
  const stored = { ...state, draftEpoch: EPOCH };
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async strings => {
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      raw.push(sql);
      if (sql.includes('FROM "StudyState"')) return [stored];
      // Order matters: the draft table name also starts with "Report".
      if (sql.includes('FROM "ReportDraft"')) return row ? [row] : [];
      if (sql.includes('FROM "Report"')) return head ? [head] : [];
      throw new Error('unexpected raw query: ' + sql);
    },
    studyState: { findUnique: async () => stored, update: async a => record(writes, 'studyState.update') && stored },
    report: {
      findUnique: async () => { reads.push('report.findUnique'); return head ? { version: head.version } : null; },
      upsert: async a => record(writes, 'report.upsert:v' + a.create.version),
    },
    // The draft row is written once per mutation, whichever statement the service uses for it: a text write names its
    // base version, a write that leaves no draft (commit, clear) is a tombstone.
    reportDraft: new Proxy({}, { get: (_target, method) => async a => {
      if (method === 'findUnique') { reads.push('reportDraft.findUnique'); return row; }
      const data = a.data ?? a.create ?? a.update;
      record(writes, data.present === false ? 'reportDraft.tombstone' : 'reportDraft.store:base' + data.baseVersion);
      row = { ...(row ?? { uid: UID, author: CALLER.actor }), ...data, updatedAt: new Date(0) };
      return method === 'updateMany' ? { count: 1 } : row;
    } }),
    reportVersion: {
      findFirst: async () => (head ? { version: head.version } : null),
      // The commit path now reads the head version row for its citations. The shape grows; every
      // assertion below is unchanged, and a null row still means "no citations".
      findUnique: async () => { reads.push('reportVersion.findUnique'); return null; },
      create: async a => record(writes, `reportVersion.create:v${a.data.version}:${a.data.action}`),
    },
    auditLog: { create: async a => { audits.push(a.data); return a.data; } },
  };
  const prisma = {
    $transaction: async work => work(tx),
    studyState: { findUnique: async () => stored },
    report: { findUnique: async () => head },
    reportDraft: { findUnique: async () => row },
    auditLog: { create: async a => { audits.push(a.data); return a.data; } },
  };
  const studyAccess = { prepare: async () => {}, require: async () => {} };
  const keycloak = { usersInGroupWithRole: async () => [] };
  // The citation gate is a fifth collaborator; no test in this file cites anything, so an empty
  // readable set is the honest stub — reaching it at all would be the defect.
  const findings = { readableFindings: async () => { throw new Error('the stale-draft paths must not ask about findings'); } };
  const real = new PacsService(prisma, {}, keycloak, studyAccess, findings);
  const pre = c => ({ expectedOwner: { institution: c.institution, sub: c.sub, author: c.actor }, expectedRevision: `${EPOCH}:${row?.revision ?? 0}` });
  const svc = {
    commitReport: (uid, body, c) => real.commitReport(uid, { ...pre(c), ...body }, c, null),
    putReport: (uid, body, c) => real.putReport(uid, { citationIds: [], structureIds: [], ...pre(c), ...body }, c, null),
  };
  return { svc, writes, audits, raw, reads, tx };
}
const refusal = async (promise, status) => {
  const e = await promise.then(() => null, error => error);
  assert.ok(e, 'the call resolved instead of being refused');
  assert.equal(e.getStatus?.(), status, e.message);
  return e.getResponse();
};

test('a draft written against an older version cannot become an addendum, and the refusal carries the locked row', async () => {
  const f = fixture({ draft: { baseVersion: 2 } });
  // The screen sends the polled version, so the optimistic lock at :1813 agrees.
  // Only the draft row knows which version this text was actually written against.
  const body = await refusal(f.svc.commitReport(UID, { action: 'addendum', baseVersion: 4, ...BODY }, CALLER), 409);
  assert.equal(body.code, 'REPORT_DRAFT_STALE');
  assert.equal(body.draftBaseVersion, 2);
  assert.deepEqual({ ...body.head }, { version: 4, updatedBy: 'doctor2@synthetic', findings: HEAD.findings, conclusion: '', recommendation: 'HEAD R' });
  // An old tab routes on this substring and then overwrites the editor from the server.
  assert.doesNotMatch(body.message, /저장했습니다/);
  assert.match(body.message, /v2/);
  assert.match(body.message, /v4/);
  assert.deepEqual(f.writes, [], 'a refusal must not touch the report, the history or the draft');
  assert.deepEqual(f.raw.map(sql => sql.match(/FROM "(\w+)"/)[1]), ['StudyState', 'Report', 'ReportDraft'], 'the study, the report and the caller\'s draft are locked once each');
  assert.equal(f.reads.filter(r => r === 'report.findUnique').length, 0, 'the payload comes from the already locked row');
});

test('the stale guard is decided before the optimistic lock, so an honest screen also gets the payload', async () => {
  // With the rendered base (R1) the lock would fire first and answer with the
  // destructive '저장했습니다' wording; the named refusal has to win.
  const f = fixture({ draft: { baseVersion: 2 } });
  const body = await refusal(f.svc.commitReport(UID, { action: 'addendum', baseVersion: 2, ...BODY }, CALLER), 409);
  assert.equal(body.code, 'REPORT_DRAFT_STALE');
  assert.deepEqual(f.writes, []);
});

test('callers without a draft, and drafts standing on the head, keep the existing behaviour', async () => {
  for (const draft of [null, { baseVersion: 4 }, { baseVersion: 5 }]) {
    const f = fixture({ draft });
    await f.svc.commitReport(UID, { action: 'addendum', baseVersion: 4, ...BODY }, CALLER);
    assert.deepEqual(f.writes, ['studyState.update', 'report.upsert:v5', 'reportVersion.create:v5:addendum', 'reportDraft.tombstone'],
      `draft ${JSON.stringify(draft)}`);
    // Was a bare count of 2. A commit now also locks the draft row it is about to delete, so that a
    // same-author insertion from another tab cannot be read past and then deleted; name the three
    // locks instead of counting them, in the order that keeps them cycle-free.
    assert.deepEqual(f.raw.map(sql => sql.match(/FROM "(\w+)"/)[1]), ['StudyState', 'Report', 'ReportDraft'],
      `draft ${JSON.stringify(draft)}`);
    assert.equal(f.raw.filter(sql => sql.includes('FOR UPDATE')).length, 3);
  }
});

test('the guard is addendum only — a stale draft still saves, defers and resets', async () => {
  for (const [action, rs, extra] of [['save', 'T', {}], ['defer', 'H', { reason: 'r' }], ['reset', 'W', { reason: 'r' }]]) {
    const f = fixture({ state: { ...STATE, rs }, draft: { baseVersion: 2 } });
    await f.svc.commitReport(UID, { action, baseVersion: 4, ...BODY, ...extra }, CALLER);
    assert.ok(f.writes.some(w => w.includes(`:${action}`)), `${action} must still commit`);
  }
});

test('role, institution and preliminary gates still answer first — the approved text never leaks through them', async () => {
  const draft = { baseVersion: 2 };
  const technician = await refusal(
    fixture({ draft }).svc.commitReport(UID, { action: 'addendum', baseVersion: 4, ...BODY }, { ...CALLER, roles: ['technician'] }), 403);
  assert.doesNotMatch(JSON.stringify(technician), /HEAD/);

  const hidden = fixture({ state: { ...STATE, rs: 'P', preDoc: 'other@synthetic', preReviewer: 'boss@synthetic' }, draft });
  const prelim = await refusal(hidden.svc.commitReport(UID, { action: 'addendum', baseVersion: 4, ...BODY }, CALLER), 403);
  assert.doesNotMatch(JSON.stringify(prelim), /HEAD/);
  assert.deepEqual(hidden.raw.map(sql => sql.match(/FROM "(\w+)"/)[1]), ['StudyState'], 'a refused caller never reaches the locked report row');

  const foreign = fixture({ state: { ...STATE, institutionId: 'other' }, draft });
  await refusal(foreign.svc.commitReport(UID, { action: 'addendum', baseVersion: 4, ...BODY }, CALLER), 404);
  assert.deepEqual(foreign.writes, []);
});

test('a draft cannot be based on a version that does not exist yet', async () => {
  const f = fixture({ draft: { baseVersion: 2 } });
  const body = await refusal(f.svc.putReport(UID, { ...BODY, baseVersion: 5 }, CALLER), 400);
  assert.match(String(body.message ?? body), /v5/);
  assert.deepEqual(f.writes, [], 'a refused draft write stores nothing');
  for (const baseVersion of ['3', 2.5, -1, NaN, Infinity, {}, []]) {
    const bad = fixture({ draft: null });
    await refusal(bad.svc.putReport(UID, { ...BODY, baseVersion }, CALLER), 400);
    assert.deepEqual(bad.writes, [], `baseVersion ${String(baseVersion)}`);
  }
});

test('an explicit rebase is audited apart from the twenty-second autosave, and never locks the report', async () => {
  const advanced = fixture({ draft: { baseVersion: 2 } });
  await advanced.svc.putReport(UID, { ...BODY, baseVersion: 4 }, CALLER);
  assert.deepEqual(advanced.writes, ['reportDraft.store:base4']);
  assert.deepEqual(advanced.audits.map(a => a.action), ['report.draft', 'report.draft.rebase']);
  assert.deepEqual(JSON.parse(advanced.audits[1].detail), { from: 2, to: 4 });
  assert.deepEqual(advanced.raw.map(sql => sql.match(/FROM "(\w+)"/)[1]), ['StudyState', 'ReportDraft'], 'putReport must not take a FOR UPDATE lock on Report');

  for (const draft of [null, { baseVersion: 4 }, { baseVersion: 2 }]) {
    const f = fixture({ draft });
    await f.svc.putReport(UID, { ...BODY, baseVersion: draft?.baseVersion ?? 0 }, CALLER);
    assert.deepEqual(f.audits.map(a => a.action), ['report.draft'], `draft ${JSON.stringify(draft)} is a plain save`);
  }
});

test('clearing a draft is never refused for its base version', async () => {
  const f = fixture({ draft: { baseVersion: 2 } });
  const result = await f.svc.putReport(UID, { findings: '', conclusion: '', recommendation: '', baseVersion: 99 }, CALLER);
  assert.deepEqual([result.present, result.snapshot, result.revision], [false, null, EPOCH + ':2']);
  assert.deepEqual(f.audits.map(a => a.action), ['report.draft.clear']);
});
