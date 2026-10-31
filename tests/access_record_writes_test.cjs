'use strict';
/* TEST-ACCESS-RECORD-B2 — 의료법 제23조④ (제21776호): 전자의무기록에 기재·추가기재·수정을 하면 접속기록을 별도로 보관한다.
 * The PACS writes the access-record audit (access-record-20261031 report §5) found without a record now commit one with
 * the write, through the existing request records transaction (ClinicalRoutes.workflow):
 *   critical-result create / ack / cancel / supersede, viewer items (measurements, key images), viewer jobs (comparison
 *   layout and description), and the study writes PATCH/DELETE studies/:uid and POST match/unmatch
 *   (the study writes are in tests/pacs_split_modules_test.cjs SPLIT-25).
 *
 * What is bound: the committed event of each write, as the ledger canonicalizes it (parseAccessEvent): its route, record
 * kind, record/version, managing institution and statutory act; that a refused or replayed write records nothing; and that
 * a write rolled back with its business transaction keeps no record. Not bound: SQL text (the doubles below answer by
 * table, as tests/viewer_volume_job_test.cjs does) or private names. The compiled service suites over PostgreSQL remain
 * the authority for SQL; this file proves which access record each write commits.
 *
 * Source-only through tests/service_test_loader.cjs, or unchanged against /app/dist in the API image.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
if (!fs.existsSync('/app/dist/emr-clinical')) require('./service_test_loader.cjs');
const { ClinicalRoutes } = require('/app/dist/emr-clinical/routes');
const { parseAccessEvent, statutoryAct, accessStreams } = require('/app/dist/emr-contract/access-event');
const { ViewerService } = require('/app/dist/viewer.service');
const { ViewerJobService } = require('/app/dist/viewer-job.service');
const { CriticalResultService } = require('/app/dist/critical-result.service');

const INST = 'syn-a';
const IDENTITY = { id: '00000000-0000-4000-8000-0000000000a1', issuer: 'https://idp.synthetic.test', subject: 'syn-sub-rad' };
const FACTS = { actor: { identity: IDENTITY, kind: 'member', roles: ['radiologist'], institutionId: INST, signingRegistrationId: null },
  requestId: 'syn-request-1', ip: { status: 'known', value: { address: '127.0.0.1', source: 'request-peer' } } };

/** B2 as the store runs it: every event is canonicalized at admission and kept only if its business transaction commits. */
function recorded(db, committed) {
  const records = { begin: () => ({ end() {}, transactionWithRecords: async work => {
    const staged = [];
    const value = await db.$transaction(tx => work(tx, async (event, effect) => {
      const parsed = parseAccessEvent(event);
      const reference = await effect();
      staged.push({ event: parsed, act: statutoryAct(parsed), streams: [...accessStreams(parsed)], reference });
      return reference;
    }));
    committed.push(...staged);
    return value;
  } }) };
  const routes = new ClinicalRoutes({ records, context: { facts: async () => FACTS } }, null);
  return execute => routes.workflow({}, execute);
}
const summary = r => { const t = r.event.targets[0];
  return [r.event.surface, t.kind, t.recordId.value, t.versionId.value, r.event.managingInstitution.value, r.event.action, r.act]; };
const noTx = { $transaction: work => work({}) };

test('B2-01 each PACS write surface commits a 기재/추가기재/수정 record of its own record kind, with the patient link unresolved or known', async () => {
  const rows = [
    ['PATCH studies/:uid', 'study-metadata', 'modify', '수정'], ['PATCH studies/:uid', 'study-correction', 'modify', '수정'],
    ['DELETE studies/:uid', 'study-metadata', 'modify', '수정'],
    ['POST match', 'patient-match', 'modify', '수정'], ['POST unmatch', 'patient-match', 'modify', '수정'],
    ['POST studies/:uid/critical-results', 'critical-result', 'write', '기재'],
    ['POST critical-results/:id/ack', 'critical-result-ack', 'write', '기재'],
    ['POST critical-results/:id/cancel', 'critical-result', 'cancel', '수정'],
    ['POST critical-results/:id/supersede', 'critical-result', 'modify', '수정'],
    ['POST studies/:uid/viewer-items', 'measurement', 'write', '기재'], ['POST studies/:uid/viewer-items', 'key-image', 'write', '기재'],
    ['POST studies/:uid/viewer-items/:id/revisions', 'measurement', 'modify', '수정'],
    ['POST studies/:uid/viewer-jobs', 'comparison-layout', 'write', '기재'],
    ['POST studies/:uid/viewer-jobs', 'comparison-description', 'write', '기재'],
    ['POST studies/:uid/viewer-jobs/:id/revisions', 'comparison-description', 'modify', '수정'],
  ];
  for (const patientId of [null, 'SYN-PID']) {
    const committed = [];
    for (const [surface, kind, action] of rows) await recorded(noTx, committed)(w => w.record({ surface, uid: '2.25.1', institution: INST,
      kind, recordId: 'rec-1', version: '3', action, patientId, reference: { kind: 'Synthetic', id: 'rec-1', version: '3' } }));
    assert.deepEqual(committed.map(r => [r.event.surface, r.event.targets[0].kind, r.event.action, r.act]),
      rows.map(([surface, kind, action, act]) => [surface, kind, action, act]));
    for (const r of committed) {
      assert.deepEqual(r.streams, ['viewing', 'history'], 'a record change is kept in both streams');
      assert.deepEqual([r.event.userId.value, r.event.actingInstitution.value, r.event.managingInstitution.value, r.event.requestId],
        [IDENTITY, INST, INST, 'syn-request-1']);
      // A held source PatientID is named by the study's managing institution, as the current-study read names it.
      assert.deepEqual(r.event.targets[0].patientLinkSnapshot, patientId ? { status: 'known', value: { linkId: JSON.stringify([INST, patientId]),
        patientId, assigningAuthority: INST } } : { status: 'unresolved', reason: 'not-resolved' });
    }
  }
  // A kind the route does not write is still refused by the contract, so the record cannot mislabel what was written.
  await assert.rejects(recorded(noTx, [])(w => w.record({ surface: 'POST studies/:uid/viewer-items', uid: '2.25.1', institution: INST,
    kind: 'report-version', recordId: 'rec-1', version: '1', action: 'write', patientId: null, reference: { kind: 'Synthetic', id: 'rec-1', version: '1' } })));
});

// ── viewer items ──

const UID = '2.25.100', SERIES = '2.25.101', SOP = '2.25.102';
const RAD = { kind: 'member', sub: 'syn-sub-rad', actor: 'syn-rad@synthetic.test', institution: INST, roles: ['radiologist'] };
const keyItem = { schemaVersion: 1, kind: 'key', seriesUid: SERIES, sopUid: SOP, frame: 1, title: 'SYNTHETIC key' };
const access = { prepare: async () => {}, snapshot: async () => {}, require: async () => {}, allowed: async (_c, refs) => new Set(refs) };

/** Committed rows; a transaction works on a copy and commits it only when its work returns. */
function viewerDatabase() {
  const state = { uid: UID, institutionId: INST, teleInstitutionId: null, rs: 'W', preDoc: null, preReviewer: null };
  const store = { items: new Map(), revisions: [], requests: [], audit: [] };
  const client = s => ({
    studyState: { findUnique: async () => ({ ...state }) },
    viewerRequest: { findUnique: async ({ where }) => {
      const key = where.authorSub_requestId, found = s.requests.find(r => r.authorSub === key.authorSub && r.requestId === key.requestId);
      return found && { ...found, result: { revision: found.revision, item: s.items.get(found.itemId), snapshot: s.items.get(found.itemId).snapshot,
        at: new Date(0) } };
    }, create: async ({ data }) => { s.requests.push(data); } },
    viewerStorageBudget: { upsert: async () => ({}), update: async () => ({}) },
    auditLog: { create: async ({ data }) => { s.audit.push(data); return { id: s.audit.length, ...data }; } },
    $executeRaw: async (strings, ...values) => { if (strings.join('?').includes('"ViewerRevision"')) s.revisions.push(values); return 1; },
    $queryRaw: async (strings, ...values) => {
      const sql = strings.join('?');
      if (sql.includes('FROM "StudyState"')) return [{ ...state }];
      if (sql.includes('octet_length')) return [{ bytes: values[0].length }];
      if (sql.includes('INSERT INTO "ViewerItem"')) {
        const [id, studyUid, authorSub, authorActor, snapshot, hidden, revision, createdAt, updatedAt] = values;
        const row = { id, studyUid, authorSub, authorActor, snapshot: JSON.parse(snapshot), hidden, revision, createdAt, updatedAt };
        s.items.set(id, row); return [row];
      }
      if (sql.includes('UPDATE "ViewerItem"')) {
        const [snapshot, hidden, revision, updatedAt, id] = values;
        const row = { ...s.items.get(id), snapshot: JSON.parse(snapshot), hidden, revision, updatedAt };
        s.items.set(id, row); return [row];
      }
      if (sql.includes('FROM "ViewerItem"')) { const row = s.items.get(values[0]); return row ? [row] : []; }
      if (sql.startsWith('SET LOCAL') || sql.includes('SET LOCAL')) return [];
      throw new Error('viewer double: unexpected statement');
    },
  });
  return { store, ...client(store), $transaction: async work => {
    const staged = { items: new Map([...store.items].map(([k, v]) => [k, structuredClone(v)])), revisions: [...store.revisions],
      requests: [...store.requests], audit: [...store.audit] };
    const out = await work({ ...client(staged), $executeRaw: async (strings, ...values) =>
      strings.join('?').includes('SET LOCAL') ? 0 : client(staged).$executeRaw(strings, ...values) });
    Object.assign(store, staged);
    return out;
  } };
}
const tags = { StudyInstanceUID: UID, SeriesInstanceUID: SERIES, SOPInstanceUID: SOP, SOPClassUID: '1.2.840.10008.5.1.4.1.1.2', Modality: 'CT' };
const body = value => Buffer.from(JSON.stringify(value));

test('B2-02 a viewer item save is 기재 of its key image or measurement; an edit, hide or restore is 수정; a replay records nothing', async () => {
  const db = viewerDatabase(), committed = [];
  const svc = new ViewerService(db, { viewerReference: async () => tags }, access);
  const created = await svc.write(UID, body({ requestId: '00000000-0000-4000-8000-0000000000b1', item: keyItem }), RAD, undefined, recorded(db, committed));
  assert.deepEqual(committed.map(summary), [['POST studies/:uid/viewer-items', 'key-image', created.id, '1', INST, 'write', '기재']]);
  assert.deepEqual(committed[0].reference, { kind: 'ViewerItem', id: created.id, version: '1' });
  const hidden = await svc.write(UID, body({ requestId: '00000000-0000-4000-8000-0000000000b2', expectedRevision: 1, action: 'hide', reason: 'SYNTHETIC', item: keyItem }),
    RAD, created.id, recorded(db, committed));
  assert.equal(hidden.revision, 2);
  assert.deepEqual(committed.slice(1).map(summary), [['POST studies/:uid/viewer-items/:id/revisions', 'key-image', created.id, '2', INST, 'modify', '수정']]);
  // The same request again answers its stored result and changes no record.
  await svc.write(UID, body({ requestId: '00000000-0000-4000-8000-0000000000b1', item: keyItem }), RAD, undefined, recorded(db, committed));
  assert.equal(committed.length, 2);
  // A refused write (a stale revision) changes nothing and records nothing.
  await assert.rejects(svc.write(UID, body({ requestId: '00000000-0000-4000-8000-0000000000b3', expectedRevision: 1, action: 'restore', reason: 'SYNTHETIC', item: keyItem }),
    RAD, created.id, recorded(db, committed)), error => error.getStatus?.() === 409);
  assert.equal(committed.length, 2);
  assert.equal(db.store.audit.length, 2);
});

// ── viewer jobs ──

const JOB = '00000000-0000-4000-8000-000000000001';
function jobDatabase() {
  const parent = { uid: UID, institutionId: INST, teleInstitutionId: null, rs: 'W', preDoc: null, preReviewer: null, preDocSub: null, preReviewerSub: null };
  const store = { jobs: new Map(), revisions: [], audit: [] };
  const client = s => ({
    studyState: { findMany: async () => [parent] },
    viewerJob: {
      findUnique: async ({ where }) => s.jobs.get(where.id) ?? null,
      create: async ({ data }) => { const row = { hidden: false, createdAt: new Date(0), ...data }; s.jobs.set(data.id, row); return { ...row }; },
      update: async ({ where, data }) => { const row = s.jobs.get(where.id);
        const next = { ...row, title: data.title, description: data.description, hidden: data.hidden, revision: row.revision + data.revision.increment,
          updatedAt: data.updatedAt }; s.jobs.set(where.id, next); return { ...next }; },
    },
    viewerJobRevision: { create: async ({ data }) => { s.revisions.push(data); } },
    auditLog: { create: async ({ data }) => { s.audit.push(data); } },
    $executeRaw: async (strings, ...values) => { if (strings.join('?').includes('"snapshot"')) { s.jobs.get(values[1]).snapshot = values[0]; return 1; } return 0; },
    $queryRaw: async (strings, ...values) => { const sql = strings.join('?'); if (sql.includes('FROM "StudyState"')) return [parent];
      if (sql.includes('FROM "ViewerJob"')) return s.jobs.has(values[0]) ? [{ snapshot: s.jobs.get(values[0]).snapshot }] : [];
      throw new Error('job double: unexpected statement'); },
  });
  return { store, ...client(store), $transaction: async work => {
    const staged = { jobs: new Map([...store.jobs].map(([k, v]) => [k, { ...v }])), revisions: [...store.revisions], audit: [...store.audit] };
    const out = await work(client(staged)); Object.assign(store, staged); return out;
  } };
}
// The version 4 three-plane layout of tests/viewer_volume_job_test.cjs: a whole CT volume verified against its originals.
const volume = { study: UID, series: SERIES, sops: ['2.25.103', '2.25.104', '2.25.105'] };
const plane = { study: UID, series: SERIES, viewport: { width: 256, height: 256 }, projection: { blend: 3, thickness: 2 },
  camera: { focalPoint: [0, 0, 1], position: [0, 0, 101], viewUp: [0, 1, 0], viewPlaneNormal: [0, 0, 1], parallelScale: 128, rotation: 0,
    flipHorizontal: false, flipVertical: false },
  properties: { voiRange: { lower: -1000, upper: 1000 }, VOILUTFunction: 'LINEAR', invert: false, interpolationType: 0 } };
const layout = { version: 4, studies: [UID], volume, rows: 1, cols: 3, active: 0, cells: [plane, plane, plane] };
const volumeTags = volume.sops.map((sop, i) => ({ StudyInstanceUID: UID, SeriesInstanceUID: SERIES, SOPInstanceUID: sop, PatientID: 'SYN-PID',
  SOPClassUID: '1.2.840.10008.5.1.4.1.1.2', Modality: 'CT', SamplesPerPixel: 1, PhotometricInterpretation: 'MONOCHROME2', FrameOfReferenceUID: '2.25.106',
  Rows: 32, Columns: 32, ImageOrientationPatient: '1\\0\\0\\0\\1\\0', ImagePositionPatient: '0\\0\\' + i, PixelSpacing: '1\\1', RescaleSlope: 1,
  RescaleIntercept: -1000, BitsAllocated: 16, BitsStored: 16, HighBit: 15, PixelRepresentation: 0, _kinSourceDigest: String(i).repeat(32) }));
const volumeSource = { connectStudyIdentity: async () => ({ patientId: 'SYN-PID' }), viewerSeriesManifest: async () => volume.sops.map(sop => ({ sop })),
  viewerReference: async sop => volumeTags[volume.sops.indexOf(sop)] };

test('B2-03 a saved comparison job is 기재 of its layout and its description; a revision is 수정 of the description only', async () => {
  const db = jobDatabase(), committed = [];
  const svc = new ViewerJobService(db, volumeSource, access);
  const job = body({ id: JOB, title: 'SYNTHETIC', description: 'SYNTHETIC description', snapshot: layout });
  const created = await svc.create(UID, job, RAD, recorded(db, committed));
  assert.equal(created.revision, 1);
  assert.deepEqual(committed.map(summary), [
    ['POST studies/:uid/viewer-jobs', 'comparison-layout', JOB, '1', INST, 'write', '기재'],
    ['POST studies/:uid/viewer-jobs', 'comparison-description', JOB, '1', INST, 'write', '기재']]);
  await svc.create(UID, job, RAD, recorded(db, committed));
  assert.equal(committed.length, 2, 'the same job again replays its stored summary and records nothing');
  const revised = await svc.revise(UID, JOB, body({ expectedRevision: 1, title: 'SYNTHETIC 2', description: 'SYNTHETIC changed', hidden: false,
    reason: 'SYNTHETIC' }), RAD, recorded(db, committed));
  assert.equal(revised.revision, 2);
  assert.deepEqual(committed.slice(2).map(summary), [
    ['POST studies/:uid/viewer-jobs/:id/revisions', 'comparison-description', JOB, '2', INST, 'modify', '수정']]);
  await assert.rejects(svc.revise(UID, JOB, body({ expectedRevision: 1, title: 'SYNTHETIC 3', description: '', hidden: false, reason: 'SYNTHETIC' }),
    RAD, recorded(db, committed)), error => error.getStatus?.() === 409);
  assert.equal(committed.length, 3, 'a stale revision records nothing');
  assert.equal(db.store.audit.length, 2);
});
// ── critical results ──

const sub = n => '00000000-0000-4000-8000-0000000000' + String(n).padStart(2, '0');
const SENDER = { kind: 'member', sub: sub(11), actor: 'syn-rad@synthetic.test', institution: INST, roles: ['radiologist'], name: 'SYNTHETIC RAD' };
const RECIPIENT = { kind: 'member', sub: sub(12), actor: 'syn-clin@synthetic.test', institution: INST, roles: ['clinician'], name: 'SYNTHETIC CLIN' };
const rightsRow = c => ({ sub: c.sub, username: c.actor, email: c.actor, emailVerified: true, name: c.name, approved: true, suspended: false,
  institution: INST, roles: c.roles });
/** The rows the service reads and writes, committed per transaction. Statements are answered by the table they read. */
function criticalDatabase() {
  const state = { uid: UID, institutionId: INST, teleInstitutionId: null, rs: 'A', preDoc: null, preReviewer: null, preDocSub: null,
    preReviewerSub: null, ov: null };
  const head = { headVersion: 1, headAction: 'approve', headAuthor: SENDER.actor, headAt: new Date(0) };
  const store = { records: new Map(), receipts: new Map(), events: [], audit: [] };
  const client = s => ({
    memberRights: { findUnique: async ({ where }) => [SENDER, RECIPIENT].filter(c => c.sub === where.sub).map(rightsRow)[0] ?? null },
    studyState: { findUnique: async () => ({ ...state }) },
    criticalResultReceipt: { findUnique: async ({ where }) => s.receipts.get(where.requestId) ?? null,
      create: async ({ data }) => { s.receipts.set(data.requestId, { ...data }); } },
    criticalResult: { findUnique: async ({ where }) => s.records.get(where.id) ? { ...s.records.get(where.id) } : null,
      create: async ({ data }) => { s.records.set(data.id, { ...data }); },
      update: async ({ where, data }) => { s.records.set(where.id, { ...s.records.get(where.id), ...data }); } },
    criticalResultEvent: { create: async ({ data }) => { s.events.push(data); } },
    auditLog: { create: async ({ data }) => { s.audit.push(data); return { id: s.audit.length }; } },
    $executeRaw: async () => 0,
    $queryRaw: async (strings, ...values) => {
      const sql = strings.join('?');
      if (sql.includes('FROM "StudyState"')) return [{ ...state }];
      if (sql.includes('FROM "Report" r')) return [{ ...head }];
      if (sql.includes('"supersedesId"=')) return [...s.records.values()].filter(r => r.supersedesId === values[0]).map(r => ({ id: r.id, sourceVersion: r.sourceVersion }));
      if (sql.includes('SELECT id FROM "CriticalResult"')) return [...s.records.values()].filter(r => r.studyUid === values[0] && r.senderSub === values[1]
        && r.recipientSub === values[2] && r.state === 'created').map(r => ({ id: r.id }));
      if (sql.includes('FROM "CriticalResult" WHERE id=')) return s.records.has(values[0]) ? [{ ...s.records.get(values[0]) }] : [];
      throw new Error('critical double: unexpected statement');
    },
  });
  const copy = s => ({ records: new Map([...s.records].map(([k, v]) => [k, { ...v }])), receipts: new Map(s.receipts), events: [...s.events], audit: [...s.audit] });
  return { store, ...client(store), $transaction: async work => { const staged = copy(store); const out = await work(client(staged)); Object.assign(store, staged); return out; } };
}
const source = { reportPreviewStudy: async () => ({ '00100010': { Value: [{ Alphabetic: 'SYNTHETIC^PATIENT' }] }, '00100020': { Value: ['SYN-PID-1'] },
  '00100030': { Value: ['19700101'] }, '00080020': { Value: ['20261031'] } }) };
const owner = c => [c.institution, c.sub];
const MESSAGE = 'SYNTHETIC critical finding';

test('B2-04 a critical result is 기재 when sent and acknowledged, 수정 when cancelled or superseded; a replay records nothing', async () => {
  const db = criticalDatabase(), committed = [];
  const svc = new CriticalResultService(db, access, {}, source);
  const send = (requestId, c = SENDER) => svc.create(UID, c, { requestId, expectedOwner: owner(c), recipientSub: RECIPIENT.sub, sourceVersion: 1,
    message: MESSAGE }, recorded(db, committed));
  const link = { status: 'known', value: { linkId: JSON.stringify([INST, 'SYN-PID-1']), patientId: 'SYN-PID-1', assigningAuthority: INST } };

  const first = sub(21), firstAck = sub(22);
  await send(first);
  assert.deepEqual(committed.map(summary), [['POST studies/:uid/critical-results', 'critical-result', first, '1', INST, 'write', '기재']]);
  assert.deepEqual(committed[0].event.targets[0].patientLinkSnapshot, link, 'the patient the record pinned when it was made');
  await send(first);
  assert.equal(committed.length, 1, 'the same request again answers its stored result and records nothing');
  await svc.ack(first, RECIPIENT, { requestId: firstAck, expectedOwner: owner(RECIPIENT), revision: 1 }, recorded(db, committed));
  assert.deepEqual(committed.slice(1).map(summary), [['POST critical-results/:id/ack', 'critical-result-ack', first, '2', INST, 'write', '기재']]);

  const second = sub(23);
  await send(second);
  await svc.cancel(second, SENDER, { requestId: sub(24), expectedOwner: owner(SENDER), revision: 1, reason: 'SYNTHETIC reason' }, recorded(db, committed));
  assert.deepEqual(committed.slice(3).map(summary), [['POST critical-results/:id/cancel', 'critical-result', second, '2', INST, 'cancel', '수정']]);
  // A refused change (the cancelled record is terminal) writes nothing and records nothing.
  await assert.rejects(svc.cancel(second, SENDER, { requestId: sub(25), expectedOwner: owner(SENDER), revision: 1, reason: 'SYNTHETIC reason' },
    recorded(db, committed)), error => error.getStatus?.() === 409);
  assert.equal(committed.length, 4);

  const third = sub(26), replacement = sub(27);
  await send(third);
  await svc.supersede(third, SENDER, { requestId: replacement, expectedOwner: owner(SENDER), revision: 1, sourceVersion: 1, message: MESSAGE + ' corrected' },
    recorded(db, committed));
  assert.deepEqual(committed.slice(5).map(summary), [
    ['POST critical-results/:id/supersede', 'critical-result', third, '2', INST, 'modify', '수정'],
    ['POST critical-results/:id/supersede', 'critical-result', replacement, '1', INST, 'write', '기재']]);
  assert.equal(db.store.audit.length, 7, 'one audit row per state change, as before');
});