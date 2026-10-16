/** R5-01/04/06/07/08/10/11/16, NC-04: response contracts on real boundary and Nest metadata.
 * REQ-EMR-01/03/04/05/07/10/17 -> RISK-D-01..04 -> TEST-D-03. Synthetic DB ports only.
 * The installed TS checker checks types; no implementation-string/DOM assertions.
 */
'use strict';
const fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict'), { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const root = process.env.KIN_EMR_D_ROOT || path.resolve(__dirname, '../../..'), api = path.join(root, 'api');
const src = process.env.KIN_EMR_D_API_SRC || path.join(api, 'src');
const ts = require(path.join(api, 'node_modules/typescript'));
const config = ts.readConfigFile(path.join(api, 'tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, api);
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
  { compilerOptions: parsed.options, fileName: filename }).outputText, filename);
require(path.join(api, 'node_modules/reflect-metadata'));
const load = file => require(path.join(src, file));
const B = load('emr-clinical/response.ts'), R = load('emr-clinical/records.ts'), S = load('emr-clinical/store.ts');
const { canonical } = load('viewer-input.ts');
const { firstValueFrom, of } = require(path.join(api, 'node_modules/rxjs'));
const N = require(path.join(api, 'node_modules/@nestjs/common'));
const constants = require(path.join(api, 'node_modules/@nestjs/common/constants'));
const controllers = ['clinician-question', 'image-request', 'consultation', 'finding', 'reader-assignment', 'manual-sr']
  .map(name => Object.values(load(name + '.controller.ts')).find(v => typeof v === 'function'));
const routes = new Map();
for (const controller of controllers) for (const name of Object.getOwnPropertyNames(controller.prototype)) {
  const handler = controller.prototype[name], method = Reflect.getMetadata(constants.METHOD_METADATA, handler);
  if (method === undefined) continue;
  const route = [Reflect.getMetadata(constants.PATH_METADATA, controller), Reflect.getMetadata(constants.PATH_METADATA, handler)]
    .filter(v => typeof v === 'string').join('/').split('/').filter(Boolean).join('/');
  routes.set(N.RequestMethod[method] + ' ' + route, { controller, handler });
}
const person = (role, id) => ({ identity: { id, subject: id, issuer: 'https://synthetic.invalid' }, kind: 'member',
  roles: [role], institutionId: 'synthetic-hospital', signingRegistrationId: 'reg-' + id });
const clinician = person('clinician', 'c1000000-0000-4000-8000-000000000001');
const radiologist = person('radiologist', 'a1000000-0000-4000-8000-000000000001');
const recipient = person('radiologist', 'a2000000-0000-4000-8000-000000000001');
const technician = person('technician', 'b1000000-0000-4000-8000-000000000001');
const study = { studyId: '1.2.840.777', managingInstitutionId: clinician.institutionId,
  patient: { linkId: 'syn-link', patientId: 'SYN', assigningAuthority: 'synthetic-hospital' } };
const caller = a => ({ kind: 'member', sub: a.identity.subject, actor: a.identity.subject, name: a.identity.subject,
  institution: a.institutionId, roles: [...a.roles] });
const known = value => ({ status: 'known', value });
const unitRows = unit => unit.versions.map(v => ({ record_id: unit.recordId, record: unit.record, study_id: unit.studyId,
  managing_institution_id: unit.managingInstitutionId, patient: JSON.stringify(unit.patient), author_id: unit.parties.authorId,
  recipient_id: unit.parties.recipientId, state: unit.state, revision: unit.revision, head_version_id: unit.head.versionId,
  head_sha256: unit.head.sha256, clinical_entry: unit.clinicalEntry, sequence: v.sequence, version_id: v.versionId, body: JSON.stringify(v), signature: null }));
function fixture(kind, entries = 1, text = 'SYN 임상 문장') {
  let unit = null; const originals = new Map(), projections = [], plans = [];
  const author = ['question', 'image-request'].includes(kind) ? clinician : radiologist;
  const recordId = randomUUID();
  for (let i = 0; i < entries; i++) {
    const closing = kind === 'question' && i === 99;
    const surface = kind + '.' + (i === 0 ? 'create' : closing ? 'close' : kind === 'question' ? 'reply' : 'complete');
    const who = kind === 'consultation' && i ? recipient : author;
    const body = { requestId: i === 0 ? recordId : randomUUID(), expectedOwner: [who.institutionId, who.identity.subject],
      ...(i ? { revision: i } : {}) };
    if (kind === 'question') body[closing ? 'note' : 'body'] = text;
    if (kind === 'image-request') Object.assign(body, { kind: 'external-image', counterparty: 'SYN hospital', counterpartyInstitutionId: null, reason: text });
    if (kind === 'consultation') Object.assign(body, i ? { action: 'complete', note: text } : { recipientSub: recipient.identity.subject, reason: text });
    const plan = R.planClinicalWrite({ surface, actor: who, study, unit, body, content: null, attachments: [], navigation: [],
      recipientId: kind === 'consultation' && !i ? recipient.identity.id : null, readerId: null, workContext: null,
      ids: { recordId, versionId: randomUUID() }, at: new Date(1760000000000 + i * 1000).toISOString() });
    unit = R.applyPlan(unit, plan); plans.push(plan);
    const projection = { caller: caller(who), recipient: kind === 'consultation' && !i ? { sub: recipient.identity.subject,
      actor: recipient.identity.subject, name: recipient.identity.subject } : null,
      create: kind === 'image-request' ? { kind: body.kind, counterparty: body.counterparty, counterpartyInstitutionId: null } : null };
    originals.set(plan.version.versionId, [{ request_id: body.requestId, projection: JSON.stringify(projection) }]);
    projections.push({ id: body.requestId, seq: i + 1, kind: i === 0 ? 'question' : closing ? 'close' : 'followup', body: text,
      authorSub: who.identity.subject, authorActor: who.identity.subject, authorName: who.identity.subject, authorRole: who.roles[0],
      at: plan.version.at, reportRs: 'A', reportVersion: 1 });
  }
  const first = unit.versions[0], last = unit.versions.at(-1);
  const row = { id: recordId, studyUid: study.studyId, institutionId: study.managingInstitutionId, revision: unit.revision, state: unit.state,
    createdAt: first.at, updatedAt: last.at, changedBy: last.author.subject };
  if (kind === 'question') Object.assign(row, { authorSub: author.identity.subject, authorActor: author.identity.subject, authorName: author.identity.subject,
    entryCount: entries, closedAt: entries === 100 ? last.at : null, closedByActor: author.identity.subject,
    closedByName: author.identity.subject, closedByRole: author.roles[0] });
  else Object.assign(row, { requesterSub: author.identity.subject, requesterActor: author.identity.subject, requesterName: author.identity.subject,
    reason: first.text, note: null, handlerActor: null, kind: 'external-image', counterpartyText: 'SYN hospital', counterpartyInstitutionId: null,
    recipientSub: kind === 'consultation' ? recipient.identity.subject : undefined,
    recipientActor: recipient.identity.subject, recipientName: recipient.identity.subject, reply: entries > 1 ? last.text : null, cancelReason: null });
  return { unit, row, projections, originals, plans, author };
}
function environment(fixtures, actor = radiologist) {
  const changes = { policy: false, ledgerAt: 0, badReceipt: 0, denied: false, rights: false, study: false };
  const appended = [], req = {}, c = caller(actor);
  const find = ({ where }) => fixtures.find(f => f.row.id === where.id)?.row ?? null;
  const db = { memberRights: { findUnique: async () => ({ approved: !changes.rights, suspended: false,
    institution: c.institution, roles: c.roles }) }, studyQuestion: { findUnique: find }, studyImageRequest: { findUnique: find },
    studyConsultation: { findUnique: find }, studyQuestionEntry: { findMany: async ({ where }) => fixtures.find(f => f.row.id === where.questionId).projections },
    $queryRaw: async (strings, ...v) => {
      const sql = strings.join('?');
      if (sql.includes('emr_clinical.unit_for')) { const f = fixtures.find(f => f.row.id === v[0]); return f?.unit ? unitRows(f.unit) : []; }
      if (sql.includes('emr_clinical.response_facts')) return v[1].flatMap(version => fixtures.flatMap(f => (f.originals.get(version) ?? []).map(p => ({ ...p, version_id: version }))));
      if (sql.includes('FROM "Finding" WHERE')) return fixtures.filter(f => f.row.id === v[0]).map(f => f.row);
      if (sql.includes('FROM "FindingRevision" WHERE')) return fixtures.find(f => f.row.id === v[0]).projections;
      if (sql.includes('"StudyState"')) return v[0].map(uid => ({ uid, institutionId: changes.study || changes.lineageDenied === uid || changes.teleOnly === uid ? 'foreign' : c.institution,
        teleInstitutionId: changes.teleOnly === uid ? c.institution : null, rs: changes.preliminary === uid ? 'P' : 'A' }));
      throw new Error('unimplemented synthetic SQL ' + sql);
    } };
  db.$transaction = async work => work(db);
  const access = { prepare: async () => {}, snapshot: async () => ({ revision: 1 }),
    require: async () => { if (changes.denied) throw new N.NotFoundException(); },
    unchanged: async () => { if (changes.policy) throw new N.ConflictException(); } };
  const parts = { db, context: { facts: async () => ({ actor, trustedProxyIp: known({ address: '10.0.0.1', source: 'trusted-proxy' }),
    requestId: 'syn-request', signature: null, member: async () => { throw new Error('No mutable party resolution on read'); } }) },
    ledger: { append: async e => { appended.push(e); if (changes.ledgerAt === appended.length) throw new Error('SYN ledger failure');
      return { eventId: changes.badReceipt === appended.length ? 'wrong-event' : e.eventId, durableAt: new Date().toISOString() }; } } };
  return { changes, appended, req, c, db, context: { db, tx: db, caller: c, access }, parts };
}
async function serialize(env, route, value, before) {
  const { controller, handler } = routes.get(route);
  const writes = [], response = Object.fromEntries(['write', 'end', 'send', 'json', 'render', 'writeHead', 'flushHeaders'].map(k => [k, () => writes.push(k)]));
  const context = { getHandler: () => handler, getClass: () => controller, switchToHttp: () => ({ getRequest: () => env.req, getResponse: () => response }) };
  const result = new B.ClinicalResponseInterceptor().intercept(context, { handle: () => { if (before) before(response); return of(value); } });
  try { return JSON.parse(JSON.stringify(await firstValueFrom(result))); }
  finally { assert.deepEqual(writes, [], 'no response bytes, including before a later refusal'); }
}
const variant = (f, route) => f.unit.record === 'question' ? { view: 'question', route, id: f.row.id, current: { rs: 'A', version: 1 } } :
  { view: f.unit.record === 'consultation' ? 'consultations' : 'images', route, ids: [f.row.id],
    ...(route.startsWith('POST') ? { receipt: f.plans.at(-1).receipt } : {}) };
const variants = [
  ['question', 'GET questions/:id'], ['image-request', 'GET image-requests'], ['image-request', 'GET image-requests/:id'],
  ['image-request', 'GET studies/:uid/image-requests'], ['consultation', 'GET consultations'], ['consultation', 'GET consultations/:id'],
  ['consultation', 'POST studies/:uid/consultations'], ['consultation', 'POST consultations/:id'],
];
function findingFixture() {
  const original = fixture('consultation'), recordId = original.row.id;
  let unit = null; const projections = [], originals = new Map(), plans = [];
  for (const [i, action] of ['create', 'edit', 'hide', 'restore'].entries()) {
    const snapshot = { schemaVersion: 1, title: 'SYN title', text: 'SYN finding ' + i, hidden: action === 'hide', primary: 0,
      sources: i === 0 ? [{ itemId: randomUUID(), studyUid: '1.2.840.778', revision: 1 }] : [] };
    const body = { requestId: randomUUID(), item: {}, ...(i ? { expectedRevision: i, action, ...(i>=2?{reason:'SYN reason '+i}:{}) } : {}) };
    const plan = R.planClinicalWrite({ surface: 'finding.' + action, actor: radiologist, study, unit, body, content: canonical(snapshot),
      attachments: [], navigation: i === 0 ? ['1.2.840.778'] : [], recipientId: null, readerId: null, workContext: null,
      ids: { recordId, versionId: randomUUID() }, at: new Date(1760000000000 + i * 1000).toISOString() });
    unit = R.applyPlan(unit, plan); plans.push(plan);
    // PostgreSQL jsonb::text spacing differs from canonical signing JSON; its stored byte count must still read normally.
    const storedSnapshot = JSON.stringify(JSON.parse(plan.version.text), null, 1);
    projections.push({ revision: i + 1, action, reason: i>=2 ? 'SYN reason ' + i : '', actor: radiologist.identity.subject,
      authorSub: radiologist.identity.subject, payloadBytes: Buffer.byteLength(storedSnapshot), at: plan.version.at, snapshot: storedSnapshot });
    originals.set(plan.version.versionId, [{ request_id: body.requestId, projection: JSON.stringify({ caller: caller(radiologist) }) }]);
  }
  const row = { id: recordId, studyUid: study.studyId, authorSub: radiologist.identity.subject, authorActor: radiologist.identity.subject,
    createdAt: unit.versions[0].at, updatedAt: unit.versions.at(-1).at, revision: 4, hidden: false, snapshot: unit.versions.at(-1).text };
  return { unit, row, projections, originals, plans };
}
if (require.main === module) {
for (const [kind, route] of variants) test('R5 response variant: ' + route, async () => {
  const f = fixture(kind, route === 'POST consultations/:id' ? 2 : 1), env = environment([f]);
  const selector = variant(f, route);
  const response = await B.clinicalResponse(env.parts, env.req, selector, env.context);
  const body = await serialize(env, route, response);
  assert.ok(JSON.stringify(body).includes('SYN 임상 문장'), 'normal authorized clinical text is provided');
  assert.deepEqual(env.appended.flatMap(e => e.targets.map(t => t.versionId.value)), f.unit.versions.map(v => v.versionId), 'every actual version named');
  for (const fault of ['reason', 'requesterSub', 'createdAt', 'state', 'revision']) {
    if (kind === 'question' && ['reason', 'requesterSub'].includes(fault)) continue;
    if (route.startsWith('POST') && ['state', 'revision'].includes(fault)) continue; // echoes name their original, not today's head
    const before = f.row[fault]; f.row[fault] = fault === 'revision' ? 777 : fault === 'createdAt' ? '2020-01-01T00:00:00Z' : 'SYN corruption';
    await assert.rejects(B.clinicalResponse(env.parts, env.req, selector, env.context), e => ['ProjectionMismatch', 'NotFound'].includes(e.code), fault + ' corruption withheld');
    f.row[fault] = before;
  }
  const rowFields = kind === 'question' ? ['authorActor', 'authorName', 'changedBy'] : kind === 'consultation' ?
    ['requesterActor', 'recipientActor', 'recipientName', 'recipientSub'] : ['requesterActor', 'requesterName', 'counterpartyText', 'counterpartyInstitutionId', 'kind', 'handlerActor', 'handlerName', 'changedBy'];
  for (const field of rowFields) {
    const before = f.row[field]; f.row[field] = 'SYN corruption';
    await assert.rejects(B.clinicalResponse(env.parts, env.req, selector, env.context), field + ' cannot describe another author/party'); f.row[field] = before;
  }
  if (kind === 'question') for (const field of ['id', 'body', 'authorSub', 'authorActor', 'authorName', 'authorRole', 'kind', 'seq', 'at']) {
    const before = f.projections[0][field]; f.projections[0][field] = field === 'seq' ? 999 : field === 'at' ? '2020-01-01T00:00:00Z' : 'SYN corruption';
    await assert.rejects(B.clinicalResponse(env.parts, env.req, selector, env.context), field + ' cannot substitute another entry'); f.projections[0][field] = before;
  }
  for (const fault of ['policy', 'rights', 'study', 'denied']) {
    env.changes[fault] = true;
    await assert.rejects(serialize(env, route, response), e => [404, 409, 503].includes(e.getStatus()), 'current ' + fault + ' changed: no bytes');
    env.changes[fault] = false;
  }
  env.appended.length = 0; env.changes.ledgerAt = 1;
  await assert.rejects(B.clinicalResponse(env.parts, env.req, selector, env.context), /SYN ledger failure/, 'ledger failure provides no capability');
});
test('R5-07/16 100 allowed multibyte question entries are provided only after both ledger chunks', async () => {
  const f = fixture('question', 100, '가'.repeat(2000)), env = environment([f]);
  const selector = variant(f, 'GET questions/:id');
  const body = await serialize(env, selector.route, await B.clinicalResponse(env.parts, env.req, selector, env.context));
  assert.equal(body.item.entries.length, 100); assert.equal(body.item.entries[99].body, '가'.repeat(2000));
  assert.deepEqual(env.appended.map(e => e.targets.length), [64, 36]);
  for (const fault of ['ledgerAt', 'badReceipt']) {
    env.appended.length = 0; env.changes[fault] = 2;
    await assert.rejects(B.clinicalResponse(env.parts, env.req, selector, env.context), 'partial ledger never releases a response');
    env.changes[fault] = 0;
  }
});
for (const route of ['GET studies/:uid/findings', 'GET studies/:uid/findings/:id/revisions', 'POST studies/:uid/findings', 'POST studies/:uid/findings/:id/revisions'])
test('R5 Finding response variant: ' + route, async () => {
  const f = findingFixture(), env = environment([f]);
  const selector = route === 'GET studies/:uid/findings' ? { view: 'findings', route, ids: [f.row.id], links: [], schema: '2' } :
    route.startsWith('GET') ? { view: 'finding-history', route, id: f.row.id, sequences: [1, 2, 3, 4], schema: '2' } :
    { view: 'finding-write', route, receipt: f.plans[route.endsWith('/revisions') ? 2 : 0].receipt };
  const response = await B.clinicalResponse(env.parts, env.req, selector, env.context);
  const body = await serialize(env, route, response);
  assert.ok(JSON.stringify(body).includes('SYN finding'), 'normal Finding text');
  const wanted = selector.view === 'findings' ? [4] : selector.view === 'finding-history' ? [1, 2, 3, 4] : [selector.receipt.revision];
  assert.deepEqual(env.appended.flatMap(e => e.targets.map(t => t.versionId.value)), wanted.map(n => f.unit.versions[n - 1].versionId));
  env.changes.lineageDenied = '1.2.840.778';
  await assert.rejects(B.clinicalResponse(env.parts, env.req, selector, env.context), e => e.code === 'NotFound', 'old comparison lineage cannot disappear from read scope');
  await assert.rejects(serialize(env, route, response), e => e.getStatus() === 404, 'access revoked immediately before serialization');
  env.changes.lineageDenied = null;
  for (const fault of ['teleOnly', 'preliminary']) {
    env.changes[fault] = '1.2.840.778';
    await assert.rejects(B.clinicalResponse(env.parts, env.req, selector, env.context), e => e.code === 'NotFound', fault + ' cannot widen the original comparison lineage');
    env.changes[fault] = null;
  }
  for (const key of ['snapshot', 'reason', 'authorSub', 'actor', 'payloadBytes', 'action', 'at']) {
    const row = f.projections[wanted[0] - 1], before = row[key];
    row[key] = key === 'snapshot' ? JSON.stringify({ text: 'SYN corrupt' }) : key === 'at' ? '2020-01-01T00:00:00Z' : 'SYN corrupt';
    await assert.rejects(B.clinicalResponse(env.parts, env.req, selector, env.context), 'each shown projection field is compared'); row[key] = before;
  }
  env.appended.length = 0; env.changes.ledgerAt = 1;
  await assert.rejects(B.clinicalResponse(env.parts, env.req, selector, env.context), /SYN ledger failure/);
  env.changes.ledgerAt = 0;
  if (selector.view === 'finding-history' || selector.view === 'findings') {
    f.unit = null;
    const legacy = await B.clinicalResponse(env.parts, env.req, selector, env.context);
    const result = await serialize(env, route, legacy);
    assert.ok(!JSON.stringify(result).includes('SYN finding')); assert.ok(!JSON.stringify(result).includes('SYN reason'));
  }
});
test('R5-01/06 all 25 Nest routes reject unclassified JSON, binary, base64 and raw writes', async () => {
  assert.equal(routes.size, 25); assert.deepEqual([...routes.keys()].sort(), Object.keys(B.RESPONSE_ROUTES).sort());
  for (const [route, { controller }] of routes) {
    assert.ok(Reflect.getMetadata(constants.INTERCEPTORS_METADATA, controller).includes(B.ClinicalResponseInterceptor));
    const env = environment([]);
    for (const body of [{ reason: 'SYN arbitrary' }, Buffer.from('SYN'), { dicom: Buffer.from('SYN').toString('base64') }])
      await assert.rejects(serialize(env, route, body), e => e.getStatus?.() === 503, route);
    for (const method of ['write', 'end', 'json', 'send', 'render', 'writeHead', 'flushHeaders'])
      await assert.rejects(serialize(env, route, {}, response => response[method]('SYN')), e => e.getStatus?.() === 503, route + ' ' + method);
  }
});
test('NC-04/R5-10 operational ACKs are bound to the original version and strip arbitrary nested receipt JSON', async () => {
  for (const kind of ['question', 'image-request']) {
    const f = fixture(kind), plan = f.plans[0], env = environment([f], f.author), v = plan.version;
    const stored = { id: v.recordId, studyUid: v.studyId, requestId: plan.requestId, revision: v.sequence, action: 'create',
      from: null, to: v.state.to, at: v.at, kind: 'external-image', entry: { body: 'SYN leaked', seq: 777 }, note: 'SYN leaked' };
    const result = B.writeAcknowledgement(env.req, env.c, plan.access.route, plan.receipt, f.unit, true, stored);
    const body = await serialize(env, plan.access.route, result);
    assert.ok(!JSON.stringify(body).includes('SYN leaked')); assert.equal(body.applied.revision, 1);
    for (const key of ['id', 'requestId', 'revision', 'studyUid']) {
      const altered = { ...stored, [key]: key === 'revision' ? 9 : randomUUID() };
      assert.throws(() => B.writeAcknowledgement(env.req, env.c, plan.access.route, plan.receipt, f.unit, true, altered), e => e.code === 'ProjectionMismatch');
    }
  }
});
for (const route of ['POST studies/:uid/manual-sr', 'POST studies/:uid/manual-sr/:id/store'])
test('R5 common SR response boundary: ' + route, async () => {
  const { srFile, srUid, SR_CLASS } = load('manual-sr-dicom.ts'), env = environment([]), id = randomUUID();
  const dataset = { SpecificCharacterSet: 'ISO_IR 192', SOPClassUID: SR_CLASS, SOPInstanceUID: srUid(id),
    StudyInstanceUID: study.studyId, Modality: 'SR', ContentSequence: [{ ValueType: 'TEXT', RelationshipType: 'CONTAINS', TextValue: 'SYN retained SR' }] };
  const bytes = srFile(dataset), hash = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const at = new Date().toISOString(), versionId = randomUUID();
  const row = { id, studyUid: study.studyId, authorSub: radiologist.identity.subject, dataset, dicom: bytes, sha256: hash,
    createdAt: at, attemptedAt: at, storedAt: at };
  let adopted = true;
  env.db.manualSr = { findUnique: async () => row };
  env.db.studyState = { findUnique: async () => ({ uid: study.studyId, institutionId: env.changes.study ? 'foreign' : env.c.institution, rs: 'A' }) };
  const query = env.db.$queryRaw;
  env.db.$queryRaw = async (strings, ...values) => strings.join('?').includes('sr_adoption_for') ? adopted ? [{
    version_id: versionId, sha256: hash, bytes_sha256: hash, sop_instance_uid: dataset.SOPInstanceUID, confirmed: true,
    body: JSON.stringify({ recordId: id, versionId, studyId: study.studyId, managingInstitutionId: study.managingInstitutionId,
      patient: study.patient, author: radiologist.identity }), access_event: '{}' }] : [] : query(strings, ...values);
  const selector = { view: 'sr', route, id, studyUid: study.studyId };
  const response = await B.clinicalResponse(env.parts, env.req, selector, env.context);
  const body = await serialize(env, route, response);
  assert.deepEqual(body.dataset, dataset);
  assert.equal(body.dicom, route.endsWith('/manual-sr') ? bytes.toString('base64') : undefined);
  assert.deepEqual(env.appended.flatMap(e => e.targets.map(t => t.versionId.value)), [versionId]);
  for (const fault of ['rights', 'policy', 'study', 'denied']) {
    env.changes[fault] = true;
    await assert.rejects(serialize(env, route, response), 'current SR read authorization precedes serialization');
    env.changes[fault] = false;
  }
  for (const key of ['dataset', 'dicom', 'sha256']) {
    const before = row[key];
    row[key] = key === 'dataset' ? { ...dataset, PatientID: 'SYN substituted' } : key === 'dicom' ? Buffer.from('SYN different bytes') : '00'.repeat(32);
    await assert.rejects(B.clinicalResponse(env.parts, env.req, selector, env.context), 'adopted SR projection corruption is withheld'); row[key] = before;
  }
  env.appended.length = 0; env.changes.ledgerAt = 1;
  await assert.rejects(B.clinicalResponse(env.parts, env.req, selector, env.context), 'adopted SR requires a new durable receipt on each response');
  env.changes.ledgerAt = 0;
  if (route.endsWith('/manual-sr')) {
    adopted = false; row.storedAt = null; row.attemptedAt = null; env.appended.length = 0;
    const preparation = await serialize(env, route, await B.clinicalResponse(env.parts, env.req, selector, env.context));
    assert.equal(preparation.stored, false); assert.equal(preparation.dicom, bytes.toString('base64'));
    assert.deepEqual(env.appended, [], 'unadopted working preparation is the declared non-clinical variant');
  }
});
test('R5-01 installed TypeScript checker requires every declared route to return only the private response capability', () => {
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true, incremental: false }), checker = program.getTypeChecker();
  const file = program.getSourceFile(path.join(api, 'src/emr-clinical/response.ts'));
  const module = checker.getSymbolAtLocation(file);
  const symbol = checker.getExportsOfModule(module).find(s => s.name === 'AuthorizedResponse');
  const authorized = checker.getDeclaredTypeOfSymbol(symbol);
  const selector = checker.getDeclaredTypeOfSymbol(checker.getExportsOfModule(module).find(s => s.name === 'ClinicalResponseSelector'));
  const stringMembers = type => (type.isUnion() ? type.types : [type]).map(t => {
    assert.ok(t.isStringLiteral(), 'response discriminants are closed literal types'); return t.value;
  });
  const selectedRoutes = new Set();
  for (const variant of selector.types) {
    const view = stringMembers(checker.getTypeOfSymbolAtLocation(variant.getProperty('view'), file))[0];
    const selected = stringMembers(checker.getTypeOfSymbolAtLocation(variant.getProperty('route'), file));
    for (const route of selected) {
      assert.ok(routes.has(route), 'each declared selector variant names a real route');
      assert.equal(B.RESPONSE_ROUTES[route], view === 'sr' && route.endsWith('/manual-sr') ? 'preparation-or-clinical' : 'clinical');
      selectedRoutes.add(route);
    }
  }
  assert.deepEqual([...selectedRoutes].sort(), Object.keys(B.RESPONSE_ROUTES).filter(route => B.RESPONSE_ROUTES[route] !== 'business').sort());
  const business = checker.getDeclaredTypeOfSymbol(checker.getExportsOfModule(module).find(s => s.name === 'BusinessResponse'));
  assert.deepEqual(business.types.flatMap(t => stringMembers(checker.getTypeOfSymbolAtLocation(t.getProperty('type'), file))).sort(), ['assignment', 'candidates', 'questions']);
  let count = 0;
  for (const sf of program.getSourceFiles().filter(f => controllers.some(c => f.fileName.endsWith('/' + c.name.replace(/Controller$/, '').replace(/[A-Z]/g, m => '-' + m.toLowerCase()).replace(/^-/, '') + '.controller.ts')))) {
    function visit(node) {
      if (ts.isMethodDeclaration(node) && ts.canHaveDecorators(node) && ts.getDecorators(node)?.length) {
        const signature = checker.getSignatureFromDeclaration(node), result = checker.getAwaitedType(checker.getReturnTypeOfSignature(signature));
        assert.ok(!(result.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)), 'route return must be closed');
        assert.ok(checker.isTypeAssignableTo(result, authorized), 'route must return an authorized capability'); count++;
      }
      ts.forEachChild(node, visit);
    } visit(sf);
  }
  assert.equal(count, 25);
});
}
module.exports = { B, R, S, load, fixture, environment, variant, serialize, routes, caller, clinician, radiologist, recipient, technician, study, unitRows };
