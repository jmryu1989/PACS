// REQ-S7-U5-DRAFT-OWNER -> RISK-S7-U5-DRAFT-WRONG-AUTHOR -> TEST-S7-U5-DRAFT-OWNER (Astra S7-U5-SPEC-C-F01).
//
// The compiled draft write (putReport) against an `expectedOwner` binding: the screen sends the account it took the report
// text from ([institution, subject, author]); a write whose cookie session is another account (an account switch in another
// tab, or a swap between Recover Draft's /api/me check and its PUT) must not create, overwrite or delete that account's
// draft. Runs against the built image (/app/dist) exactly like report_stale_draft_test.cjs:
//   docker run --rm --network none --read-only -v "$PWD/tests:/tests:ro" \
//     --entrypoint node kin-api:ci --test /tests/report_draft_owner_test.cjs
// Every database call is a stub, so no Postgres, no Orthanc and no original data.
const test = require('node:test'), assert = require('node:assert/strict');
const { PacsService } = require('/app/dist/pacs.service');

const UID = '2.25.7707';
const INST = 'synthetic-a', OTHER_INST = 'synthetic-b';
const A = { kind: 'member', institution: INST, sub: 'sub-a', actor: 'doctor-a@synthetic', roles: ['radiologist'] };
const B = { kind: 'member', institution: INST, sub: 'sub-b', actor: 'doctor-b@synthetic', roles: ['radiologist'] };
const OWNER_A = [INST, A.sub, A.actor];
const STATE = { uid: UID, institutionId: INST, teleInstitutionId: null, rs: 'W', ss: 'Verified', em: 'N',
  holder: null, heldAt: null, preDoc: null, preReviewer: null, repDoc: null, confirm: null };
const TEXT = { findings: 'SYN captured findings', conclusion: 'SYN conclusion', recommendation: '' };

function fixture({ state = STATE } = {}) {
  // Every touch of the store, in order. A refusal must leave all of these empty.
  const touched = [], writes = [], audits = [], prepared = [];
  const tx = {
    $executeRaw: async () => { touched.push('lock_timeout'); return 0; },
    $queryRaw: async () => { touched.push('queryRaw'); return []; },
    studyState: { findUnique: async () => { touched.push('studyState.findUnique'); return state; } },
    report: { findUnique: async () => { touched.push('report.findUnique'); return { version: 0 }; } },
    reportDraft: {
      findUnique: async a => { touched.push('reportDraft.findUnique:' + a.where.uid_author.author); return null; },
      upsert: async a => {
        writes.push('reportDraft.upsert:' + a.where.uid_author.author + ':' + a.create.author);
        return { uid: UID, author: a.create.author, baseVersion: a.create.baseVersion, updatedAt: new Date(0) };
      },
      deleteMany: async a => { writes.push('reportDraft.deleteMany:' + a.where.author); return { count: 1 }; },
    },
    auditLog: { create: async a => { audits.push(a.data.actor + ':' + a.data.action); return a.data; } },
  };
  const prisma = {
    $transaction: async work => { touched.push('transaction'); return work(tx); },
    studyState: { findUnique: async () => { touched.push('prisma.studyState.findUnique'); return state; } },
    auditLog: { create: async a => { audits.push(a.data.actor + ':' + a.data.action); return a.data; } },
  };
  const studyAccess = {
    prepare: async (c, uids) => { prepared.push(c.actor + ':' + JSON.stringify(uids ?? null)); },
    require: async () => { touched.push('studyAccess.require'); },
  };
  const keycloak = { usersInGroupWithRole: async () => [] };
  // Neither citation nor structure keys are sent, so the finding gate must never be reached.
  const findings = { readableFindings: async () => { throw new Error('the owner cases must not ask about findings'); } };
  return { svc: new PacsService(prisma, {}, keycloak, studyAccess, findings), touched, writes, audits, prepared };
}

const refusal = async (promise, status) => {
  const e = await promise.then(() => null, error => error);
  assert.ok(e, 'the call resolved instead of being refused');
  assert.equal(e.getStatus?.(), status, e.message);
  return e.getResponse();
};

const untouched = (f, what) => {
  assert.deepEqual(f.touched, [], `${what}: nothing of the study or the draft is read`);
  assert.deepEqual(f.writes, [], `${what}: no draft row is created, overwritten or deleted`);
  assert.deepEqual(f.audits, [], `${what}: no audit row (the success audit included)`);
  assert.deepEqual(f.prepared, [], `${what}: the access policy is not even prepared`);
};

test('the account the text was taken from writes its own draft, as before', async () => {
  const f = fixture();
  const answer = await f.svc.putReport(UID, { ...TEXT, baseVersion: 0, expectedOwner: OWNER_A }, A);
  assert.equal(answer.author, A.actor);
  assert.deepEqual(f.writes, [`reportDraft.upsert:${A.actor}:${A.actor}`]);
  assert.deepEqual(f.audits, [`${A.actor}:report.draft`]);
});

test('without expectedOwner the write is the caller\'s, exactly as before (the other callers of this PUT)', async () => {
  for (const caller of [A, B]) {
    const f = fixture();
    const answer = await f.svc.putReport(UID, { ...TEXT, baseVersion: 0 }, caller);
    assert.equal(answer.author, caller.actor);
    assert.deepEqual(f.writes, [`reportDraft.upsert:${caller.actor}:${caller.actor}`]);
    assert.deepEqual(f.audits, [`${caller.actor}:report.draft`]);
  }
});

test('A\'s captured text under B\'s session is refused before any read, write or audit', async () => {
  const cases = [
    ['another reader of the same institution', B],
    ['the same subject under another author name', { ...A, actor: 'renamed@synthetic' }],
    ['another subject under the same author name', { ...A, sub: 'sub-z' }],
    ['the same reader moved to another institution', { ...A, institution: OTHER_INST }],
    ['the same reader with no institution', { ...A, institution: null }],
  ];
  for (const [what, caller] of cases) {
    for (const [shape, body] of [
      ['a text write', { ...TEXT, baseVersion: 0 }],
      // An empty write deletes the caller's draft: that is exactly what must not happen to B.
      ['an emptying write', { findings: '', conclusion: '', recommendation: '', baseVersion: 0 }],
      // An insertion prepares the access policy first; the binding is decided before that, too.
      ['a write with an insertion', { ...TEXT, baseVersion: 0, insert: { field: 'findings' } }],
    ]) {
      const f = fixture();
      const answer = await refusal(f.svc.putReport(UID, { ...body, expectedOwner: OWNER_A }, caller), 409);
      assert.equal(answer.code, 'REPORT_DRAFT_OWNER_CHANGED', `${what}, ${shape}`);
      assert.doesNotMatch(answer.message, /저장했습니다/, 'the refusal never reads as a stored write');
      untouched(f, `${what}, ${shape}`);
    }
  }
});

test('a binding to another institution\'s reader is refused even when that reader is the caller\'s namesake', async () => {
  const f = fixture();
  const answer = await refusal(f.svc.putReport(UID, { ...TEXT, baseVersion: 0, expectedOwner: [OTHER_INST, A.sub, A.actor] }, A), 409);
  assert.equal(answer.code, 'REPORT_DRAFT_OWNER_CHANGED');
  untouched(f, 'another institution in the binding');
});

test('a malformed binding is a 400 and touches nothing', async () => {
  for (const value of [null, 'sub-a', {}, { institution: INST, sub: A.sub, author: A.actor }, [], [INST, A.sub],
                       [INST, A.sub, A.actor, 'extra'], [7, A.sub, A.actor], [INST, null, A.actor], [INST, A.sub, null]]) {
    const f = fixture();
    await refusal(f.svc.putReport(UID, { ...TEXT, baseVersion: 0, expectedOwner: value }, A), 400);
    untouched(f, `expectedOwner ${JSON.stringify(value)}`);
  }
});

test('a matching binding grants nothing: the role, institution and study gates are unchanged', async () => {
  // Without the radiologist role the existing refusal stands (403) and nothing is written.
  const tech = { ...A, roles: ['technician'] };
  const f1 = fixture();
  await refusal(f1.svc.putReport(UID, { ...TEXT, baseVersion: 0, expectedOwner: OWNER_A }, tech), 403);
  assert.deepEqual([f1.writes, f1.audits], [[], []]);
  // A study of another institution stays invisible (404) to a caller whose binding matches.
  const f2 = fixture({ state: { ...STATE, institutionId: OTHER_INST } });
  await refusal(f2.svc.putReport(UID, { ...TEXT, baseVersion: 0, expectedOwner: OWNER_A }, A), 404);
  assert.deepEqual([f2.writes, f2.audits], [[], []]);
  // A Preliminary report of someone else stays closed to the binding's own reader (403).
  const f3 = fixture({ state: { ...STATE, rs: 'P', preDoc: 'doctor-c@synthetic', preReviewer: 'doctor-c@synthetic' } });
  await refusal(f3.svc.putReport(UID, { ...TEXT, baseVersion: 0, expectedOwner: OWNER_A }, A), 403);
  assert.deepEqual([f3.writes, f3.audits], [[], []]);
  // The matching empty write still deletes only the caller's own draft.
  const f4 = fixture();
  await f4.svc.putReport(UID, { findings: '', conclusion: '', recommendation: '', baseVersion: 0, expectedOwner: OWNER_A }, A);
  assert.deepEqual(f4.writes, [`reportDraft.deleteMany:${A.actor}`]);
  assert.deepEqual(f4.audits, [`${A.actor}:report.draft.clear`]);
});
