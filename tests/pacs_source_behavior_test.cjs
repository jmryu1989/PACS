'use strict';
// Only the contracts missing from the existing compiled suites live here.
// Public PacsService calls use test-owned stores; no private-method forwarding seam.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PacsService, qidoCount } = require('/app/dist/pacs.service');
const UID = '2.25.901', OTHER = '2.25.902';
const caller = (roles = ['technician']) => ({ kind: 'member', institution: 'syn-a', sub: 'syn-sub', actor: 'syn-user', roles });
const project = (row, select) => select ? Object.fromEntries(Object.keys(select).map(key => [key, row[key]])) : { ...row };
function fixture(options = {}) {
  const calls = [], writes = [];
  let state = { uid: UID, institutionId: 'syn-a', teleInstitutionId: null, rs: 'W', matched: 'U', orderOid: null,
    preDoc: null, preReviewer: null, version: 0, repDoc: null, confirm: null, origin: 'dicom',
    createdAt: new Date('2020-01-01'), ...options.state };
  const states = () => [state, ...(options.extraStates || [])];
  const report = { version: 4, findings: 'FINAL', conclusion: 'CONCLUSION', recommendation: 'REC', secret: 'DO NOT SEND', ...options.report };
  const head = { ...report, action: 'approve', ...options.head };
  const order = { oid: 'syn-order', institutionId: 'syn-a', matched: 'U', accession: 'secret-accession',
    patientId: 'ORDER-ID', name: 'ORDER-NAME', sex: 'F', birth: '20000101', descr: 'ORDER-DESC', ward: 'WARD', ...options.order };
  const qido = options.qido || [{ '0020000D': { Value: [UID] }, '00080080': { Value: ['syn-a'] },
    '00100020': { Value: ['QIDO-ID'] }, '00100010': { Value: ['QIDO-NAME'] }, ...options.tags }];
  const failWrite = name => async () => { throw new Error(`Unexpected write: ${name}`); };
  const access = {
    prepare: async () => calls.push('prepare'), require: async (_c, _uids, tx) => { calls.push(tx ? 'access:tx' : 'access:root');
      if (options.revoke) throw Object.assign(new Error('revoked'), { getStatus: () => 404 }); },
    snapshot: async () => ({ policy: { restricted: !!options.restricted } }),
    needsMetadata: () => false, matches: (_a, uid) => !options.restricted || uid === UID,
    unchanged: async () => { calls.push('unchanged'); if (options.changeAccess) throw new Error('changed-access'); },
  };
  function store(label) {
    return {
      studyState: { findMany: async args => { calls.push(`${label}:states`); return states()
        .filter(row => !args?.where?.uid || args.where.uid.in.includes(row.uid))
        .map(row => project(row, args?.select)); },
        findUnique: async () => { calls.push(`${label}:state`); return options.missing ? null : { ...state }; },
        findUniqueOrThrow: async () => ({ ...state }),
        update: async ({ data }) => { writes.push(['state', data]); state = { ...state, ...data }; return { ...state }; },
        updateMany: async ({ data }) => { writes.push(['state', data]); state = { ...state, ...data }; return { count: 1 }; },
        create: failWrite('state.create') },
      order: { findMany: async () => [], findUnique: async () => options.noOrder ? null : order,
        updateMany: async ({ data }) => { writes.push(['order', data]); return { count: 1 }; } },
      report: { findMany: async () => [{ uid: UID, ...report }], findUnique: async () => { calls.push(`${label}:report`); return report; } },
      reportDraft: { findMany: async () => [], findUnique: async () => options.draft || null },
      reportVersion: { findUnique: async args => { calls.push([`${label}:head`, args.where]); return project(head, args.select); },
        findMany: async args => [project({ ...head, citations: ['secret'], structured: ['secret'] }, args.select)] },
      viewerItem: { findMany: async () => { calls.push('keys'); return []; } },
      readerAssignment: { findMany: async () => [] }, gatewayReceipt: { findMany: async () => [] },
      auditLog: { create: async ({ data }) => { writes.push(['audit', data]); return data; } },
      $executeRaw: async () => 0,
      $queryRaw: async (_sql, ...values) => {
        calls.push([`${label}:sql`, values]);
        return states().map(row => ({ ...row, version: report.version, action: head.action, ...options.snapshot }));
      },
    };
  }
  const prisma = store('root'), tx = store('tx');
  prisma.$transaction = async (work, options) => { calls.push(['transaction', options]); return work(tx); };
  const orthanc = { studies: async () => { calls.push('qido'); return qido; },
    studyIdentities: async () => qido, studiesByUid: async uids => qido.filter(row => uids.includes(row['0020000D']?.Value?.[0])) };
  const service = new PacsService(prisma, orthanc, {}, access, {});
  return { service, calls, writes, state: () => state };
}
async function refused(promise, status, message) {
  await assert.rejects(promise, error => {
    assert.equal(error.getStatus?.(), status, error.stack);
    if (message) assert.match(error.message, message);
    return true;
  });
}

const countVectors = [undefined, null, '', '   ', 0, '0', -0, 12, 12.0, '12', '  12 ', '+12', '0012', -1, '-1',
  3.5, '3.5', '1e3', '0x10', '1 2', 'abc', NaN, Infinity, 1e21, true, { Alphabetic: '12' },
  '9007199254740991', 9007199254740991, '9007199254740992', '99999999999999999999', '１２'];
const countExpected = [null, null, null, null, 0, 0, 0, 12, 12, 12, 12, 12, 12, null, null, null, null, null,
  null, null, null, null, null, null, null, null, 9007199254740991, 9007199254740991, null, null, null];
test('U0B-COUNTS all original count vectors and both list axes distinguish unknown from zero', async () => {
  for (let i = 0; i < countVectors.length; i++) {
    const raw = countVectors[i];
    assert.equal(qidoCount({ count: { Value: [raw] } }, 'count'), countExpected[i], `vector ${i}`);
    const tags = { '00201208': { Value: [raw] }, '00201206': { Value: [raw] } };
    const f = fixture({ tags }), out = await f.service.listStudies(caller());
    assert.equal(out.studies[0].count, countExpected[i], `instances ${i}`);
    assert.equal(out.studies[0].series, countExpected[i], `series ${i}`);
  }
  // Negative control is a wrong result rule, not another assertion on implementation spelling.
  assert.notEqual(qidoCount({}, 'count'), 0);
});

test('U0B-OBSERVATION invalid dates, future rows and restricted/foreign absence never leak', async () => {
  const absent = { uid: OTHER, institutionId: 'syn-a', teleInstitutionId: null, origin: 'dicom',
    createdAt: new Date('2020-01-01'), rs: 'W', matched: 'U' };
  const valid = fixture({ extraStates: [absent] });
  assert.deepEqual((await valid.service.listStudies(caller())).notObserved,
    [{ uid: OTHER, origin: 'dicom', createdAt: '2020-01-01T00:00:00.000Z' }]);
  for (const changed of [{ createdAt: '2020-01-01' }, { origin: null }]) {
    const f = fixture({ extraStates: [{ ...absent, ...changed }] });
    assert.equal((await f.service.listStudies(caller())).notObserved, null);
  }
  for (const changed of [{ createdAt: new Date('2999-01-01') }, { institutionId: 'syn-b', teleInstitutionId: 'syn-a' }]) {
    const f = fixture({ extraStates: [{ ...absent, ...changed }] });
    assert.deepEqual((await f.service.listStudies(caller())).notObserved, []);
  }
  assert.deepEqual((await fixture({ extraStates: [absent], restricted: true }).service.listStudies(caller())).notObserved, []);
});

test('U0B-CLINICIAN-ROLES mixed members keep statistics; clinician-only and gateway are refused', async () => {
  for (const roles of [['clinician', 'radiologist'], ['clinician', 'technician'], ['clinician', 'admin']])
    await fixture().service.authzDicom('/statistics', 'GET', caller(roles));
  await refused(fixture().service.authzDicom('/statistics', 'GET', caller(['clinician'])), 403);
  for (const roles of [['clinician'], ['clinician', 'radiologist'], ['admin']]) {
    const f = fixture({ state: { rs: 'A' } });
    assert.equal(await f.service.clinicianViewerHead(UID, caller(roles)), 4);
  }
  for (const c of [caller(['technician']), caller(['radiologist']), { ...caller(['clinician']), kind: 'gateway' }]) {
    const f = fixture();
    await refused(f.service.clinicianReportRead(UID, c), 403);
    assert.deepEqual(f.calls, []);
  }
});

test('U0B-CLINICIAN-SNAPSHOT report read is final-only, tenant-gated and transaction-bound', async () => {
  const c = caller(['clinician']);
  for (const rs of ['W', 'T', 'R', 'A']) {
    const f = fixture({ state: { rs } }), out = await f.service.clinicianReportRead(UID, c);
    assert.equal(out.report.final, rs === 'A');
    assert.equal(JSON.stringify(out).includes('FINAL'), rs === 'A');
    assert.equal(JSON.stringify(out).includes('DO NOT SEND'), false);
    assert.equal(f.calls.includes('keys'), rs === 'A');
    assert.equal(f.calls[0], 'prepare');
    assert.equal(f.calls.find(Array.isArray)[1].isolationLevel, 'RepeatableRead');
    assert.ok(f.calls.includes('access:tx'));
    assert.equal(f.calls.some(x => x === 'root:state' || x === 'root:report'), false);
    assert.deepEqual(f.calls.find(x => Array.isArray(x) && x[0] === 'tx:head')[1], { uid_version: { uid: UID, version: 4 } });
  }
  for (const options of [{ missing: true }, { state: { institutionId: 'syn-b' } }, { revoke: true }]) {
    const f = fixture(options); await refused(f.service.clinicianReportRead(UID, c), 404);
    assert.equal(f.calls.includes('keys'), false);
  }
  assert.equal(await fixture({ state: { rs: 'A' }, head: { action: 'reset' } }).service.clinicianViewerHead(UID, c), null);
});

test('U0B-CLINICIAN-LIST public enumeration narrows rows and refuses a changed snapshot', async () => {
  const c = caller(['clinician']), f = fixture({ state: { rs: 'A' } });
  const out = await f.service.clinicianStudies(c);
  assert.equal(out.studies.length, 1);
  for (const field of ['notObserved', 'orderReconciliation', 'gatewayReceipt']) assert.equal(field in out, false);
  assert.equal(JSON.stringify(out).includes('DO NOT SEND'), false);
  assert.equal(f.calls.slice(f.calls.indexOf('unchanged') + 1)
    .filter(x => Array.isArray(x) && x[0] === 'root:sql').length, 1);
  for (const snapshot of [{ institutionId: 'syn-b' }, { rs: 'T' }, { repDoc: 'changed' }, { confirm: new Date() }])
    await refused(fixture({ state: { rs: 'A' }, snapshot }).service.clinicianStudies(c), 409);
});

test('U0B-IDENTITY-PATCH overlay vectors retain role, ownership, preliminary and state refusal precedence', async () => {
  // Every original shape vector remains in study_identity_server_test; this checks public storage/refusal order.
  for (const [options, c, body, status, message] of [
    [{}, caller(), { rs: 'A', ov: [] }, 400, /전용 경로/],
    [{}, caller(['radiologist']), { ov: [] }, 403, /technician/],
    [{ state: { institutionId: 'syn-b', teleInstitutionId: 'syn-a' } }, caller(), { ov: [] }, 403, /보유 기관/],
    [{ state: { rs: 'P', preDoc: 'other', preReviewer: 'other2' } }, caller(), { ov: [] }, 403, /예비 판독/],
    [{ state: { rs: 'A' } }, caller(), { ov: [] }, 400, /판독 전/],
    [{}, caller(), { ov: [] }, 400, /형식/],
  ]) { const f = fixture(options); await refused(f.service.patchState(UID, body, c), status, message); assert.deepEqual(f.writes, []); }
  const f = fixture(); await f.service.patchState(UID, { ov: { name: 'SYNTHETIC', age: 42 } }, caller());
  assert.deepEqual(JSON.parse(f.state().ov), { name: 'SYNTHETIC', age: 42 });
});

test('U0B-IDENTITY-MATCH original-shape and age contracts preserve prior refusals and stored values', async () => {
  for (const [options, c, status, message] of [
    [{}, caller(['radiologist']), 403, /technician/],
    [{ order: { institutionId: 'syn-b' } }, caller(), 400, /오더/],
    [{ state: { institutionId: 'syn-b', teleInstitutionId: 'syn-a' } }, caller(), 403, /보유 기관/],
    [{ state: { rs: 'A' } }, caller(), 400, /판독 전/],
    [{}, caller(), 400, /형식/],
  ]) { const f = fixture(options); await refused(f.service.match(UID, 'syn-order', { orig: [] }, c), status, message); assert.deepEqual(f.writes, []); }
  for (const age of ['', '42Y', 42, 0, -1, null, undefined, [], {}, true, NaN, Infinity]) {
    const f = fixture(); const out = await f.service.match(UID, 'syn-order', { age, orig: { name: 'SYNTHETIC' } }, caller());
    const expected = typeof age === 'string' || typeof age === 'number' && Number.isFinite(age) ? age : '';
    assert.equal(JSON.parse(f.state().ov).age, expected);
    assert.equal(JSON.stringify(out).includes('secret-accession'), false);
  }
});

test('U0B-PROJECTION state responses retain draft fields without citation/structure payloads', async () => {
  const draft = { uid: UID, author: 'syn-user', present: true, findings: 'MINE', conclusion: '', recommendation: '',
    baseVersion: 4, citations: ['CITATION-SECRET'], structured: ['STRUCTURE-SECRET'] };
  const f = fixture({ draft });
  for (const answer of [await f.service.patchState(UID, { em: 'Y' }, caller())]) {
    assert.equal(answer.draft.findings, 'MINE');
    assert.equal(answer.draft.baseVersion, 4);
    const serialized = JSON.stringify(answer);
    assert.equal(serialized.includes('CITATION-SECRET'), false);
    assert.equal(serialized.includes('STRUCTURE-SECRET'), false);
    assert.equal(serialized.includes('"citations"'), false);
    assert.equal(serialized.includes('"structured"'), false);
  }
});
