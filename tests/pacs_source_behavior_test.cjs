'use strict';
// Read the selected wire body; HTTP/PG publication is covered by emr/a/report_reads_test.cjs.
const readBody = value => JSON.parse(value.json);
// Only the contracts missing from the existing compiled suites live here.
// Public PacsService calls use test-owned stores; no private-method forwarding seam.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PacsService, qidoCount } = require('/app/dist/pacs.service');
const UID = '2.25.901', OTHER = '2.25.902';

test('PHYSICIAN-SETTINGS admits own preferences, favourites and tag reads while clinical writes remain refused', async () => {
  const { PacsPreferences } = require('/app/dist/pacs/preferences');
  const { FavoriteService } = require('/app/dist/favorite.service');
  const { StudyTagsService } = require('/app/dist/study-tags.service');
  const { clinicalContextCallerRefusal, contextSigned } = require('/app/dist/clinical-context-policy');
  const c = { kind: 'member', sub: 'syn-physician', actor: 'syn-physician@local.test', institution: 'syn-a', roles: ['clinician'] };
  const empty = { findUnique: async () => null };
  const tx = { $executeRaw: async () => 0, $queryRaw: async () => [],
    studyTagCatalog: { findMany: async () => [] } };
  const db = { $transaction: async fn => fn(tx), workspaceLayout: empty, workspaceShortcuts: empty,
    readingAppearance: empty, readingPreferences: empty, worklistColumns: empty, hangingProtocolPreference: empty };
  const access = { prepare: async () => {}, snapshot: async () => ({ policy: { restricted: false } }), allowed: async (_c, ids) => new Set(ids) };
  const prefs = new PacsPreferences(db);
  for (const method of ['workspaceLayout', 'workspaceShortcuts', 'readingAppearance', 'readingPreferences', 'worklistColumns']) {
    const answer = await prefs[method](c);
    assert.deepEqual(answer.owner, [c.institution, c.sub], method);
    assert.equal(answer.revision, 0, method);
  }
  assert.equal((await prefs.hangingProtocols(c)).owner.subject, c.sub);
  assert.equal((await prefs.siteHangingProtocols(c)).canManageSite, false);
  const forbidden = e => e.getStatus() === 403;
  await assert.rejects(prefs.saveSiteHangingProtocols({}, c), forbidden);
  await assert.rejects(prefs.saveTemplate({}, c), forbidden);
  const favorites = new FavoriteService(db, {}, access);
  assert.deepEqual((await favorites.read(c)).folders, []);
  // Invalid input is validated after admission; the served matrix exercises a persisted create.
  await assert.rejects(favorites.write(c, {}), e => e.getStatus() === 400);
  const tags = new StudyTagsService(db, access);
  assert.deepEqual((await tags.read(c)).catalogs.map(x => x.tags), [[], []]);
  await assert.rejects(tags.write(c, {}), forbidden);
  assert.equal(clinicalContextCallerRefusal(c), null);
  assert.equal(contextSigned({ state: { rs: 'T' }, report: { version: 1 }, head: { action: 'save' } }), false);
});

test('PHYSICIAN-TAGS Orthanc HTTP requests and worklist rows preserve raw PN and absent values', async () => {
  const http = require('node:http');
  const { OrthancService } = require('/app/dist/orthanc.service');
  const requests = [];
  // PN shape recorded from a synthetic Orthanc 24.12.0 study-level QIDO read (2026-11-02).
  // The extra Ideographic representation also checks lossless PN decoding; served evidence is retained with the unit.
  const tags = { '0020000D': { Value: [UID] }, '00080080': { Value: ['syn-a'] }, '00100020': { Value: ['SYN-ID'] },
    '00080090': { vr: 'PN', Value: [{ Alphabetic: 'Ref^Doctor', Ideographic: '참조^의사' }] },
    '00321032': { vr: 'PN', Value: [{ Alphabetic: 'Req^Doctor' }] } };
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/tools/find'
      ? [{ RequestedTags: { StudyInstanceUID: UID, InstitutionName: 'syn-a',
        ReferringPhysicianName: 'Ref^Doctor', RequestingPhysician: 'Req^Doctor' } }] : [tags]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = Object.fromEntries(['ORTHANC_URL', 'ORTHANC_USER', 'ORTHANC_PASS'].map(k => [k, process.env[k]]));
  try {
    process.env.ORTHANC_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.ORTHANC_USER = 'synthetic'; process.env.ORTHANC_PASS = 'synthetic';
    const source = new OrthancService();
    await source.studyIdentities();
    const page = await source.studiesByUid([UID]);
    await source.studies();
    assert.ok(requests[0].body.RequestedTags.includes('ReferringPhysicianName'));
    assert.ok(requests[0].body.RequestedTags.includes('RequestingPhysician'));
    for (const request of requests.slice(1)) {
      const fields = new URL(request.url, process.env.ORTHANC_URL).searchParams.get('includefield').split(',');
      assert.ok(fields.includes('00080090')); assert.ok(fields.includes('00321032'));
    }
    const row = (await fixture({ qido: page }).service.listStudies(caller(['clinician']))).studies[0];
    assert.equal(row.referringPhysician, 'Ref^Doctor=참조^의사'); assert.equal(row.requestingPhysician, 'Req^Doctor');
    const absent = (await fixture().service.listStudies(caller(['clinician']))).studies[0];
    assert.equal(absent.referringPhysician, null); assert.equal(absent.requestingPhysician, null);
  } finally {
    for (const [k, value] of Object.entries(env)) { if (value === undefined) delete process.env[k]; else process.env[k] = value; }
    await new Promise(resolve => server.close(resolve));
  }
});
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
    // WORKLIST-SPLIT-UID: the request's source observation; these fixtures answer one resource per UID.
    prepareSourceIdentity: async () => { calls.push('source'); }, assertUnsplitSource: () => {},
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
        updateMany: async args => { options.onOrderWrite?.(args); writes.push(['order', args.data]); return { count: 1 }; },
        update: async ({ data }) => { writes.push(['order', data]); return { ...order, ...data }; } },
      report: { findMany: async () => [{ uid: UID, ...report }], findUnique: async () => { calls.push(`${label}:report`); return report; } },
      studyGroup: { findMany: async () => [] }, studyGroupMember: { findMany: async () => [] },
      reportDraft: { findMany: async () => [], findUnique: async () => options.draft || null },
      reportVersion: { findUnique: async args => { calls.push([`${label}:head`, args.where]); return project(head, args.select); },
        findMany: async args => [project({ ...head, citations: ['secret'], structured: ['secret'] }, args.select)] },
      viewerItem: { findMany: async () => { calls.push('keys'); return []; } },
      readerAssignment: { findMany: async () => [] }, studyAttachment:{groupBy:async()=>[],findMany:async()=>[],findFirst:async()=>null},gatewayReceipt: { findMany: async () => [] },
      auditLog: { create: async ({ data }) => { writes.push(['audit', data]); return data; } },
      $executeRaw: async () => 0,
      $queryRaw: async (_sql, ...values) => {
        calls.push([`${label}:sql`, values]);
        return states().map(row => ({ ...row, version: report.version, action: head.action, findings: report.findings, conclusion: report.conclusion, recommendation: report.recommendation, ...options.snapshot }));
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

test('U0B-CLINICIAN-SNAPSHOT report read exposes W/T/H/A, withholds P, and remains tenant-gated and transaction-bound', async () => {
  const c = caller(['clinician']);
  for (const rs of ['W', 'T', 'H', 'P', 'A']) {
    const f = fixture({ state: { rs } }), selected = await f.service.clinicianReportRead(UID, c), out = readBody(selected);
    assert.equal(selected.sources.some(source => source.target.kind === 'report-version'), rs !== 'P');
    assert.equal(out.report.final, rs === 'A');
    assert.equal(JSON.stringify(out).includes('FINAL'), rs !== 'P');
    assert.equal(JSON.stringify(out).includes('DO NOT SEND'), false);
    assert.equal(f.calls.includes('keys'), rs !== 'P');
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
  const selected = await f.service.clinicianStudies(c), out = readBody(selected);
  assert.equal(out.studies[0].report.findings, 'FINAL');
  const headSource = selected.sources.find(source => source.target.kind === 'report-head');
  assert.equal(headSource.target.versionId.value, '4');
  assert.deepEqual(headSource.path, ['studies', 0, 'report']);
  const preliminary = await fixture({ state: { rs: 'P' } }).service.clinicianStudies(c);
  assert.equal(preliminary.sources.some(source => source.target.kind === 'report-head'), false);
  assert.equal(JSON.stringify(readBody(preliminary)).includes('FINAL'), false);
  assert.equal(out.studies.length, 1);
  for (const field of ['notObserved', 'orderReconciliation', 'gatewayReceipt']) assert.equal(field in out, false);
  assert.equal(JSON.stringify(out).includes('DO NOT SEND'), false);
  assert.equal(f.calls.slice(f.calls.indexOf('unchanged') + 1)
    .filter(x => Array.isArray(x) && x[0] === 'root:sql').length, 1);
  for (const snapshot of [{ institutionId: 'syn-b' }, { rs: 'T' }, { repDoc: 'changed' }, { confirm: new Date() }])
    await refused(fixture({ state: { rs: 'A' }, snapshot }).service.clinicianStudies(c), 409);
});

// Both reader roles reach the same current-item read; the service enforces P and institution boundaries.
test('U0B-CLINICIAN-VIEWER current items and revisions use the radiologist read for every reader role', async () => {
  const { ViewerController } = require('/app/dist/viewer.controller');
  const ITEM_ID = '00000000-0000-4000-8000-0000000000a1';
  const calls = [], selected = { current: true };
  const controller = new ViewerController({ listRead: async (...args) => { calls.push(args); return selected; } }, {}, {});
  for (const roles of [['clinician'], ['clinician', 'radiologist'], ['radiologist'], ['technician'], ['admin']]) {
    const req = caller(roles), query = { limit: '20', cursor: ITEM_ID };
    assert.equal(await controller.list(UID, query, req), selected);
    assert.deepEqual(calls.pop(), [UID, query, req]);
    assert.equal(await controller.revisions(UID, ITEM_ID, query, req), selected);
    assert.deepEqual(calls.pop(), [UID, query, req, ITEM_ID]);
  }
});

test('U0B-CLINICIAN-PREVIEW reads non-final text with an access target and refuses P and other institutions', async () => {
  const { ReportPreviewController } = require('/app/dist/report-preview.controller');
  let state = { uid: UID, institutionId: 'syn-a', rs: 'T', preDoc: 'other-author', preReviewer: 'other-reviewer' };
  const report = { version: 2, findings: 'SYN non-final body', conclusion: '', recommendation: '' };
  const db = { studyState: { findUnique: async () => state }, report: { findUnique: async () => report },
    reportVersion: { findUnique: async () => ({ version: 2, action: 'save', author: 'other-author' }) },
    viewerItem: { findMany: async () => [] } };
  db.$transaction = async fn => fn(db);
  const controller = new ReportPreviewController(db, { reportPreviewStudy: async () => ({}) }, { require: async () => {} }, {});
  const req = caller(['clinician']);
  const selected = await controller.read(UID, req);
  assert.equal(readBody(selected).report.findings, report.findings);
  assert.equal(readBody(selected).canPreviewEditor, false);
  assert.equal(selected.sources.find(s => s.target.kind === 'report-head').target.versionId.value, '2');
  state = { ...state, rs: 'P' };
  await refused(controller.read(UID, req), 403);
  state = { ...state, rs: 'T', institutionId: 'syn-b' };
  await refused(controller.read(UID, req), 403);
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

test('TO-MATCH a removed order is refused before any write, and the claim itself requires an order on the list', async () => {
  const f = fixture({ order: { removedAt: new Date('2026-11-14T00:00:00Z') } });
  await refused(f.service.match(UID, 'syn-order', { orig: {} }, caller()), 400, /목록에서 내린/);
  assert.deepEqual(f.writes, []);
  // A removal committed between the read and the claim: the claim's own condition carries removedAt null.
  const claims = [];
  const g = fixture({ onOrderWrite: args => claims.push(args.where) });
  await g.service.match(UID, 'syn-order', { orig: {} }, caller());
  assert.deepEqual(claims, [{ oid: 'syn-order', institutionId: 'syn-a', matched: 'U', removedAt: null }]);
});

test('TO-UNMATCH the window reason is kept in the unmatch audit row; the right-click path records none; a bad reason writes nothing', async () => {
  const matched = { state: { matched: 'M', orderOid: 'syn-order' } };
  const detail = f => JSON.parse(f.writes.find(w => w[0] === 'audit')[1].detail);
  const f = fixture(matched);
  await f.service.unmatch(UID, caller(), undefined, '  Wrong order of the same patient  ');
  assert.deepEqual(detail(f), { oid: 'syn-order', by: 'syn-a', reason: 'Wrong order of the same patient' });
  for (const none of [undefined, null, '   ']) {
    const g = fixture(matched);
    await g.service.unmatch(UID, caller(), undefined, none);
    assert.deepEqual(detail(g), { oid: 'syn-order', by: 'syn-a' }, String(none));
  }
  for (const bad of [42, {}, 'x'.repeat(501), 'line\u0001']) {
    const h = fixture(matched);
    await refused(h.service.unmatch(UID, caller(), undefined, bad), 400, /사유/);
    assert.deepEqual(h.writes, []);
  }
});