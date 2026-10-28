'use strict';
/* MG-08 (D1877): the study delivery's 열람 record on the API's image path, at the served HTTP boundary. A real
 * node:http server runs the real DicomFrameController, DicomFrameService, StudyImageDeliveryRecorder (the shared
 * image-delivery-record.ts the relay also uses), request-context
 * capture, current clinical context (identity, StudyAccess, patient link), StudyAccessService, PacsAccess and the
 * DICOMweb gate; the access ledger is the real record port (createRecordPort: admission close and drain as in the
 * product) over an in-memory store that runs the real event parser and mints real receipts, the Orthanc index is a
 * stub over one synthetic stored object, authentication is an explicit synthetic input (the guard's capture is called
 * with it). Asserted: no image byte before the provide-prepared event is durable; one pair per study delivery (open,
 * reload within the idle gap, reload after it); a ledger that cannot record answers 503 with no body; refusals of the
 * gate leave no record; shutdown closes open deliveries; a delivery that provided no image closes as aborted, not
 * succeeded (MG-10), and a HEAD - answered behind the gate - neither opens a delivery nor makes one whose relayed read
 * (the real ImageRelayController on the same recorder) failed a provided one (review INT-01); a terminal the ledger cannot take at the close is retried as the same event until durable, and the
 * shutdown makes a last attempt without inventing one (MG-09); a graceful Nest shutdown (installed Nest's application
 * context close, the real EmrNestLifecycle closing admission) still records the terminal of a delivery whose
 * preparation or whose first terminal attempt was in flight when admission closed (MG-09, round 4), and of one whose
 * first terminal attempt was made during the stop and failed once (MG-09, round 5). The PostgreSQL
 * ledger itself is proven in tests/emr/a (real PG). D73: behaviour at the boundary, no product source text. Synthetic
 * values only; 127.0.0.1 only. */
const { STUDY_UID, SERIES_UID, SOP_UID, INSTANCE_ID, STUDY_ID, syntheticObject, stubOrthanc } = require('./dicom_frame_fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { ConsoleLogger, HttpException, Logger, Module, ServiceUnavailableException } = require('/app/node_modules/@nestjs/common');
const { NestFactory } = require('/app/node_modules/@nestjs/core');
const { createBackgroundWorkRegistry } = require('/app/dist/emr-runtime/background-work.js');
const { createRecordPort } = require('/app/dist/emr-runtime/record-port.js');
const { EmrNestLifecycle } = require('/app/dist/emr-runtime/nest-lifecycle.js');
const { DicomFrameController, FRAMES_SURFACE, PREVIEW_SURFACE } = require('/app/dist/dicom-frame.controller.js');
const { DicomFrameService } = require('/app/dist/dicom-frame.service.js');
const { StudyImageDeliveryRecorder, IMAGE_DELIVERY_UNAVAILABLE } = require('/app/dist/image-delivery-record.js');
const { ImageRelayController } = require('/app/dist/image-relay.controller.js');
const { createRequestContext } = require('/app/dist/emr-runtime/request-context.js');
const { createRequestIngress } = require('/app/dist/emr-runtime/request-ingress.js');
const { mintDurableReceipt } = require('/app/dist/emr-runtime/contract.js');
const { createCurrentClinicalContext } = require('/app/dist/emr-clinical/startup.js');
const { StudyAccessService } = require('/app/dist/study-access.service.js');
const { PacsAccess } = require('/app/dist/pacs/access.js');
const { PacsDicomGateway } = require('/app/dist/pacs/dicom-gateway.js');
const { parseAccessEvent, statutoryAct, accessStreams } = require('/app/dist/emr-contract/access-event.js');

const ISSUER = 'https://synthetic-idp.invalid/realms/kin', SITE = 'site-a', IDLE_MS = 150;
const ACCEPT = 'multipart/related; type=application/octet-stream; transfer-syntax=*';
/** The immutable member id the ledger binds to an issuer and subject: deterministic here, a UUID shape as B2's. */
function identityOf(issuer, subject) {
  const h = createHash('sha256').update(issuer + '\n' + subject).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The real record port (admission close, per-work end, drain) over an in-memory store with the ledger's semantics:
 * durable receipts only for stored events, append-only. `attempts` is every append the store saw, failed ones included
 * (what the real store's B2 failure journal would hold). `control.live()` is the number of record works not ended. */
function ledger() {
  const entries = [], attempts = [], state = { failing: false };
  const tx = {};
  const find = operationId => entries.find(e => e.operationId === operationId);
  const store = {
    async append(event, served, keys) {
      const parsed = parseAccessEvent(event);   // the store's canonicalPayload runs this same parser
      attempts.push({ eventId: parsed.eventId, action: parsed.action, occurredAt: parsed.occurredAt, failed: state.failing });
      if (state.failing) throw new Error('LedgerUnreachable');
      const storedAt = new Date().toISOString();
      entries.push({ event: parsed, operationId: keys?.operationId ?? randomUUID(), storedAt, at: process.hrtime.bigint() });
      return mintDurableReceipt(parsed.eventId, storedAt);
    },
    async lookup(operationId) { const e = find(operationId); return e ? { operationId, eventId: e.event.eventId, outcome: 'committed', durableAt: e.storedAt, result: null, entries: [] } : null; },
    async confirm(appended) { const e = find(appended.operationId); if (!e) throw new Error('CommitUnknown'); return mintDurableReceipt(e.event.eventId, e.storedAt); },
    async transactionWithRecords(work) { return work(tx, async (event, effect) => effect()); },
    async resolveRequestIdentity(issuer, subject) { return identityOf(issuer, subject); },
    async resolveIdentity(_tx, issuer, subject) { return identityOf(issuer, subject); },
    async admit() { throw new Error('SYN admit is not used by the image delivery'); },
    async transaction() { throw new Error('SYN transaction is not used by the image delivery'); },
    async snapshot() { throw new Error('SYN snapshot is not used by the image delivery'); },
  };
  const { port, control } = createRecordPort(store);
  return { port, control, store, entries, attempts, state, tx };
}

/** The whole served stack over one synthetic object; `shape` and `over` reach the stored object and the Orthanc stub. */
async function stack(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-delivery-'));
  const previousStorage = process.env.KIN_ORTHANC_STORAGE;
  process.env.KIN_ORTHANC_STORAGE = dir;
  const object = syntheticObject(dir, options.shape), orthanc = stubOrthanc(object, options.over);
  if (options.orthanc) Object.assign(orthanc, options.orthanc(orthanc));
  const records = ledger();
  const states = new Map([[STUDY_UID, { uid: STUDY_UID, institutionId: SITE, teleInstitutionId: null }]]);
  const sql = async (strings) => {
    const text = strings.join('?');
    if (text.includes('pg_advisory')) return [{ locked: 1 }];
    if (text.includes('StudyAccessPolicy')) return [];   // no restriction row: an unrestricted member
    throw new Error('SYN unexpected SQL ' + text);
  };
  const prisma = { studyState: { findUnique: async ({ where }) => states.get(where.uid) ?? null }, $queryRaw: sql,
    auditLog: { create: async () => { throw new Error('SYN audit write refused'); } } };
  Object.assign(records.tx, { studyState: prisma.studyState, $queryRaw: sql });
  const studyAccess = new StudyAccessService(prisma, orthanc, {});
  const gate = new PacsDicomGateway(prisma, orthanc, studyAccess, new PacsAccess(prisma, studyAccess), {});
  const contexts = createRequestContext(createRequestIngress({ proxyPeers: [] }), records.port);
  const clinical = createCurrentClinicalContext(prisma, contexts.source, orthanc, studyAccess);
  // The runtime's background registry, as app.module provides it: terminal retries are its timers and tasks.
  const background = createBackgroundWorkRegistry();
  const recorder = new StudyImageDeliveryRecorder(records.port, contexts.source, clinical, background.work, orthanc, IDLE_MS);
  const service = new DicomFrameService(orthanc);
  const controller = new DicomFrameController(service, { authzDicom: (...args) => gate.authzDicom(...args) }, orthanc, recorder);
  // The other image reads of the same study, which nginx sends to the relay; app.module gives both controllers one recorder.
  const relay = new ImageRelayController({ authzDicom: (...args) => gate.authzDicom(...args) }, orthanc, recorder);
  const observations = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    // Authentication is the synthetic input; everything after it is the product's.
    req.sub = req.headers['x-synthetic-sub'] ?? 'syn-doctor-sub'; req.actor = req.sub; req.roles = ['radiologist'];
    req.institution = req.headers['x-synthetic-site'] ?? SITE; req.kind = 'member';
    res.status = code => { res.statusCode = code; return res; };
    const preview = /^\/instances\/([0-9a-f-]+)\/preview$/.exec(url.pathname);
    const frames = /^\/dicom-web\/studies\/([^/]+)\/series\/([^/]+)\/instances\/([^/]+)\/frames\/([^/]+)$/.exec(url.pathname);
    const relayed = url.pathname.startsWith('/api/image-relay/');
    if (relayed) req.originalUrl = req.url;
    contexts.capture.capture(req, res, { issuer: ISSUER, subject: req.sub, roles: req.roles, institution: req.institution, rightsVersion: 1,
      binding: { method: 'session', sessionRef: req.headers['x-synthetic-session'] ?? 'authref:session-a' } },
      { method: 'GET', route: relayed ? 'image-relay/*' : preview ? 'instances/:id/preview' : 'dicom-web/studies/:study/series/:series/instances/:sop/frames/:frames', purpose: 'clinical' }, async () => {});
    const observation = { path: url.pathname, firstByte: null, status: null };
    observations.push(observation);
    const write = res.write.bind(res);
    res.write = (...args) => { observation.firstByte ??= { entries: records.entries.length, at: process.hrtime.bigint() }; return write(...args); };
    try {
      if (relayed) await relay.read(req, res);
      else if (preview) await controller.preview(preview[1], req, res);
      else if (frames) await controller.read(frames[1], frames[2], frames[3], frames[4], req, res);
      else { res.statusCode = 404; res.end(); }
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      res.statusCode = error instanceof HttpException ? error.getStatus() : 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(error instanceof HttpException ? error.getResponse() : { message: String(error?.message) }));
    } finally { observation.status = res.statusCode; }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async (route, headers = {}, method = 'GET') => {
    const response = await fetch(origin + route, { method, headers: { Connection: 'close', ...headers } });
    return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
  };
  const frame = (n, headers) => get(`/dicom-web/studies/${STUDY_UID}/series/${SERIES_UID}/instances/${SOP_UID}/frames/${n}`, { Accept: ACCEPT, ...headers });
  const preview = headers => get(`/instances/${INSTANCE_ID}/preview`, headers);
  const close = async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    background.quiesce();   // no retry timer outlives its stack
    await background.drained();
    if (previousStorage === undefined) delete process.env.KIN_ORTHANC_STORAGE; else process.env.KIN_ORTHANC_STORAGE = previousStorage;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { object, orthanc, records, recorder, background, observations, get, frame, preview, close, states };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const settle = () => new Promise(resolve => setImmediate(resolve));
async function until(check, label, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 5))) if (check()) return;
  assert.fail(label);
}
const byAction = (entries, action) => entries.filter(e => e.event.action === action);

test('open: frames and the preview of one study by one session are served under one durable provide-prepared, closed by one transfer-ended', async () => {
  const s = await stack();
  try {
    const answers = await Promise.all([s.frame(1), s.frame(2), s.frame('3,4'), s.preview()]);
    assert.deepEqual(answers.map(a => a.status), [200, 200, 200, 200]);
    assert.match(answers[0].headers.get('content-type'), /^multipart\/related; type="application\/octet-stream; transfer-syntax=/);
    assert.deepEqual([...answers[3].body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'the preview is a PNG');
    // One record for the four reads, and it was durable before the first image byte of each of them left.
    const prepared = byAction(s.records.entries, 'provide-prepared');
    assert.equal(prepared.length, 1, 'one provide-prepared for the study delivery, not one per frame');
    for (const observation of s.observations) {
      assert.ok(observation.firstByte, observation.path + ' sent a body');
      assert.ok(observation.firstByte.entries >= 1 && prepared[0].at < observation.firstByte.at, observation.path + ': the record preceded its first byte');
    }
    const event = prepared[0].event;
    assert.ok([FRAMES_SURFACE, PREVIEW_SURFACE].includes(event.surface), 'recorded on the route that opened the delivery');
    assert.equal(event.result, 'prepared');
    assert.equal(statutoryAct(event), '열람');
    assert.deepEqual(accessStreams(event), ['viewing']);
    assert.deepEqual(event.userId, { status: 'known', value: { id: identityOf(ISSUER, 'syn-doctor-sub'), issuer: ISSUER, subject: 'syn-doctor-sub' } });
    assert.deepEqual([event.rolesAtTime.value, event.actingInstitution.value, event.managingInstitution.value], [['radiologist'], SITE, SITE]);
    assert.deepEqual(event.trustedProxyIp, { status: 'unresolved', reason: 'not-observed' }, 'no trusted proxy on the loopback: not invented');
    assert.deepEqual([event.cause, event.context], ['background-fetch', { basis: 'background-fetch', studyId: STUDY_UID, relatedStudyId: null, reason: null }]);
    assert.deepEqual(event.targets, [{ kind: 'image',
      patientLinkSnapshot: { status: 'known', value: { linkId: JSON.stringify([SITE, 'SYN-PID-1']), patientId: 'SYN-PID-1', assigningAuthority: SITE } },
      studyId: { status: 'known', value: STUDY_UID }, recordId: { status: 'known', value: STUDY_UID },
      versionId: { status: 'known', value: `orthanc-study:${STUDY_ID}@20261028T090000` } }]);
    assert.equal(event.relatedEventId, null);
    // The delivery ends after the idle gap: one terminal, bound to the prepared event, under the same audit link.
    await until(() => byAction(s.records.entries, 'transfer-ended').length === 1, 'the terminal was not recorded after the idle gap');
    const ended = byAction(s.records.entries, 'transfer-ended')[0].event;
    assert.equal(ended.relatedEventId, event.eventId);
    assert.equal(ended.result, 'succeeded');
    assert.deepEqual([ended.auditLinkId, ended.surface, ended.targets, ended.userId], [event.auditLinkId, event.surface, event.targets, event.userId]);
    assert.notEqual(ended.eventId, event.eventId);
    assert.equal(s.records.entries.length, 2, 'exactly the pair');
    // A reload after the delivery closed is a new delivery: a new pair, nothing appended to the old one.
    assert.equal((await s.frame(1)).status, 200);
    await until(() => s.records.entries.length === 4, 'the reload\'s pair was not recorded');
    const second = byAction(s.records.entries, 'provide-prepared')[1].event;
    assert.notEqual(second.eventId, event.eventId);
    assert.equal(byAction(s.records.entries, 'transfer-ended')[1].event.relatedEventId, second.eventId);
    await settle();
    assert.equal(s.records.control.live(), 0, 'every record work was ended');
    assert.equal(s.orthanc.calls.filter(c => c[0] === 'revision').length, 2, 'the study revision is read once per delivery');
  } finally { await s.close(); }
});

test('D1880: a memory preload is a transfer and never the opening; the opening records its own 열람 before its first byte, also inside the preload\'s idle gap', async () => {
  const STORE = { 'x-kin-preload': 'store' }, CHECK = { 'x-kin-preload': 'check', 'x-kin-image-use': 'view' }, VIEW = { 'x-kin-image-use': 'view' };
  const prepared = (s, cause) => byAction(s.records.entries, 'provide-prepared').filter(e => e.event.cause === cause);
  const s = await stack();
  try {
    // The worklist preloads the study: its reads are one background-fetch delivery; nothing of it is an opening.
    assert.deepEqual((await Promise.all([s.frame(1, STORE), s.frame(2, STORE)])).map(a => a.status), [200, 200]);
    assert.equal(prepared(s, 'background-fetch').length, 1);
    assert.equal(prepared(s, 'user-view').length, 0, 'a preload that is not opened has no opening record');
    // The reader opens it at once, well inside the preload delivery's idle gap: the check read does not join the
    // preload's delivery; it records the opening, durable before its first byte.
    const before = s.observations.length;
    assert.equal((await s.frame(1, CHECK)).status, 200);
    const opened = prepared(s, 'user-view');
    assert.equal(opened.length, 1, 'exactly one opening record');
    const check = s.observations[before];
    assert.ok(check.firstByte && opened[0].at < check.firstByte.at, 'the opening record preceded the check read\'s first byte');
    assert.deepEqual(opened[0].event.context, { basis: 'worklist', studyId: STUDY_UID, relatedStudyId: null, reason: null });
    assert.equal(opened[0].event.surface, FRAMES_SURFACE);
    assert.equal(statutoryAct(opened[0].event), '열람');
    // The viewer's later reads and a strip preview of the study belong to the opening; more preload reads to the preload.
    assert.deepEqual((await Promise.all([s.frame(2, VIEW), s.preview(), s.frame(3, STORE)])).map(a => a.status), [200, 200, 200]);
    assert.equal(byAction(s.records.entries, 'provide-prepared').length, 2, 'no further record: two deliveries, two prepared events');
    await until(() => byAction(s.records.entries, 'transfer-ended').length === 2, 'both deliveries close');
    const ended = byAction(s.records.entries, 'transfer-ended').map(e => e.event);
    assert.deepEqual(new Set(ended.map(e => e.relatedEventId)), new Set(byAction(s.records.entries, 'provide-prepared').map(e => e.event.eventId)));
    assert.deepEqual(ended.map(e => e.cause).sort(), ['background-fetch', 'user-view']);
    // An opening after the gap is a new opening record of its own.
    assert.equal((await s.frame(4, VIEW)).status, 200);
    assert.equal(prepared(s, 'user-view').length, 2);
    await until(() => s.records.entries.length === 6, 'the second opening\'s pair');
  } finally { await s.close(); }
  // A strip preview of the study just before the opening does not stand for it either.
  const s2 = await stack();
  try {
    assert.equal((await s2.preview()).status, 200);
    assert.equal((await s2.frame(1, VIEW)).status, 200);
    assert.deepEqual(byAction(s2.records.entries, 'provide-prepared').map(e => e.event.cause), ['background-fetch', 'user-view']);
  } finally { await s2.close(); }
});

test('reload inside the idle gap continues the open delivery; the terminal follows the last response, not the first', async () => {
  const s = await stack();
  try {
    assert.equal((await s.frame(1)).status, 200);
    await new Promise(resolve => setTimeout(resolve, IDLE_MS / 2));
    assert.equal(s.records.entries.length, 1, 'still open');
    assert.equal((await s.frame(1)).status, 200);   // the viewer reloaded the same frame
    const secondDone = process.hrtime.bigint();
    assert.equal(byAction(s.records.entries, 'provide-prepared').length, 1, 'the reload is served under the open record');
    await until(() => s.records.entries.length === 2, 'no terminal');
    const ended = s.records.entries[1];
    assert.equal(ended.event.action, 'transfer-ended');
    assert.ok(ended.at > secondDone, 'the delivery closed after the second response, not after the first');
    // After that close, the next read is a new delivery.
    assert.equal((await s.frame(2)).status, 200);
    assert.equal(byAction(s.records.entries, 'provide-prepared').length, 2);
  } finally { await s.close(); }
});

test('a ledger that cannot record refuses the image with 503 and no body; it serves again once the ledger records', async () => {
  const s = await stack();
  try {
    s.records.state.failing = true;
    const refused = await Promise.all([s.frame(1), s.preview()]);
    for (const answer of refused) {
      assert.equal(answer.status, 503);
      assert.equal(JSON.parse(answer.body.toString()).code, IMAGE_DELIVERY_UNAVAILABLE.code);
    }
    assert.ok(s.observations.every(o => o.firstByte === null), 'no image byte was written');
    assert.equal(s.records.entries.length, 0, 'nothing recorded, nothing to close');
    await new Promise(resolve => setTimeout(resolve, IDLE_MS * 2));
    assert.equal(s.records.entries.length, 0, 'a refused delivery has no terminal');
    s.records.state.failing = false;
    assert.equal((await s.frame(1)).status, 200);
    assert.equal(byAction(s.records.entries, 'provide-prepared').length, 1);
    await settle();
    assert.equal(s.records.control.live(), 0);
  } finally { await s.close(); }
});

test('the gate refuses before any record; another session of the same member is its own delivery', async () => {
  const s = await stack();
  try {
    assert.equal((await s.frame(1, { 'x-synthetic-site': 'site-b' })).status, 403, 'another institution');
    assert.equal((await s.get(`/dicom-web/studies/9.9.9/series/${SERIES_UID}/instances/${SOP_UID}/frames/1`, { Accept: ACCEPT })).status, 403, 'an unregistered study');
    assert.equal(s.records.entries.length, 0, 'a refused read is not a provision: no record');
    assert.equal((await s.frame(1)).status, 200);
    assert.equal((await s.frame(1, { 'x-synthetic-session': 'authref:session-b' })).status, 200);
    const prepared = byAction(s.records.entries, 'provide-prepared');
    assert.equal(prepared.length, 2, 'one delivery per member session and study');
    assert.deepEqual(new Set(prepared.map(p => p.event.userId.value.id)).size, 1, 'the same member');
    await until(() => byAction(s.records.entries, 'transfer-ended').length === 2, 'both deliveries end');
  } finally { await s.close(); }
});

test('shutdown closes open deliveries: a quiet one ends, one still being sent is aborted, and nothing stays open', async () => {
  let hold = false, release = null;
  const s = await stack({ orthanc: orthanc => { const relay = orthanc.relay.bind(orthanc); return { relay: async (...args) => {
    if (hold) await new Promise(resolve => { release = resolve; });
    return relay(...args);
  } }; } });
  try {
    assert.equal((await s.frame(1)).status, 200);   // quiet delivery A: served, its idle timer pending
    hold = true;
    // Delivery B of another session: admitted (its provide-prepared durable), then its read of a frame past the object waits on Orthanc.
    const pending = s.frame(9, { 'x-synthetic-session': 'authref:session-b' });
    await until(() => byAction(s.records.entries, 'provide-prepared').length === 2 && release !== null, 'B was not admitted before its read');
    s.recorder.onModuleDestroy();
    await s.recorder.beforeApplicationShutdown();
    const terminals = s.records.entries.filter(e => e.event.action !== 'provide-prepared').map(e => e.event.action).sort();
    assert.deepEqual(terminals, ['transfer-aborted', 'transfer-ended']);
    hold = false; release();
    assert.equal((await pending).status, 200, 'the held read still completes for its client');
    await settle();
    assert.equal(s.records.control.live(), 0);
  } finally { hold = false; release?.(); await s.close(); }
});

test('a delivery that provided no image closes as transfer-aborted, never succeeded: a source read that failed with 503, a relayed refusal', async () => {
  // Every read of the study fails at the source after the preparation was recorded: a 503 with no image byte.
  const failing = () => ({ relay: async () => { throw new ServiceUnavailableException('synthetic Orthanc temporarily unavailable'); } });
  const s = await stack({ orthanc: failing });
  try {
    const answer = await s.frame(9);   // past the object: Orthanc's to answer, and Orthanc fails
    assert.equal(answer.status, 503);
    assert.equal(byAction(s.records.entries, 'provide-prepared').length, 1, 'the preparation was recorded before the read');
    await until(() => s.records.entries.length === 2, 'the delivery did not close');
    const terminal = s.records.entries[1].event;
    assert.deepEqual([terminal.action, terminal.result, terminal.relatedEventId], ['transfer-aborted', 'aborted', s.records.entries[0].event.eventId]);
    assert.equal(byAction(s.records.entries, 'transfer-ended').length, 0, 'an error answer is not a successful transfer');
  } finally { await s.close(); }
  // Orthanc answers the relayed read with a refusal; the API relays it faithfully, and it is no image either.
  const refusing = () => ({ relay: async (path, accept, target) => { target.status(404); target.setHeader('content-type', 'text/plain'); target.write(Buffer.from('no such frame')); target.end(); } });
  const s2 = await stack({ orthanc: refusing });
  try {
    assert.equal((await s2.frame(9)).status, 404);
    await until(() => s2.records.entries.length === 2, 'the delivery did not close');
    assert.deepEqual([s2.records.entries[1].event.action, s2.records.entries[1].event.result], ['transfer-aborted', 'aborted']);
  } finally { await s2.close(); }
  // One image reached its end and another read failed: the study was provided, the delivery ended.
  const s3 = await stack({ orthanc: failing });
  try {
    assert.deepEqual((await Promise.all([s3.frame(1), s3.frame(9)])).map(a => a.status), [200, 503]);
    await until(() => s3.records.entries.length === 2, 'the delivery did not close');
    assert.deepEqual([s3.records.entries[1].event.action, s3.records.entries[1].event.result], ['transfer-ended', 'succeeded']);
  } finally { await s3.close(); }
});

test('a HEAD of a frame or preview is answered behind the gate but is no delivery: beside a failed relayed read of the study, the delivery still closes aborted', async () => {
  // Review INT-01. The frame reader serves frame 1 and the preview from storage; every read relayed to Orthanc fails.
  const failing = () => ({ relay: async (_path, _accept, target) => {
    target.status(500); target.setHeader('content-type', 'application/json'); target.end('{"error":"synthetic source unavailable"}');
  } });
  const thumbnail = `/api/image-relay/instances/${INSTANCE_ID}/frames/0/rendered`;
  for (const [name, route, accept, type] of [
    ['frame', `/dicom-web/studies/${STUDY_UID}/series/${SERIES_UID}/instances/${SOP_UID}/frames/1`, ACCEPT, /^multipart\/related/],
    ['preview', `/instances/${INSTANCE_ID}/preview`, 'image/png', /^image\/png$/]]) {
    const s = await stack({ orthanc: failing });
    try {
      assert.equal((await s.get(route, { Accept: accept, 'x-synthetic-site': 'site-b' }, 'HEAD')).status, 403, name + ': HEAD keeps the gate');
      const head = await s.get(route, { Accept: accept }, 'HEAD');
      assert.deepEqual([head.status, head.body.length], [200, 0], name + ': HEAD is answered with headers only');
      assert.match(head.headers.get('content-type'), type);
      await wait(IDLE_MS * 2);
      assert.deepEqual(s.records.attempts, [], name + ': a HEAD alone records nothing');
      // The same study's thumbnail through the relay fails at the source; a HEAD before and after it serves no image.
      assert.equal((await s.get(thumbnail)).status, 500);
      assert.equal((await s.get(route, { Accept: accept }, 'HEAD')).status, 200);
      await until(() => s.records.entries.length === 2, name + ': the delivery did not close');
      assert.deepEqual(s.records.entries.map(e => [e.event.action, e.event.result]),
        [['provide-prepared', 'prepared'], ['transfer-aborted', 'aborted']], name + ': no image was served, so no succeeded transfer');
      await wait(IDLE_MS * 2);
      assert.equal(s.records.entries.length, 2, name + ': nothing after the pair');
      await settle();
      assert.equal(s.records.control.live(), 0);
    } finally { await s.close(); }
  }
});

test('a terminal the ledger cannot take at the close keeps its identity and is retried as the same event until it is durable', async () => {
  const s = await stack();
  try {
    assert.equal((await s.frame(1)).status, 200);
    const prepared = s.records.entries[0].event;
    s.records.state.failing = true;
    await until(() => s.records.attempts.some(a => a.action === 'transfer-ended'), 'the delivery did not close at the idle gap');
    const closedBy = Date.now();
    await wait(IDLE_MS);
    assert.equal(s.records.entries.length, 1, 'the ledger refused the terminal: still only the prepared event');
    assert.equal(s.records.attempts.filter(a => a.action === 'transfer-ended').length, 1, 'one attempt so far, within the first retry delay');
    s.records.state.failing = false;
    await until(() => byAction(s.records.entries, 'transfer-ended').length === 1, 'the terminal was not recorded once the ledger returned', 5000);
    const ended = byAction(s.records.entries, 'transfer-ended')[0].event;
    assert.equal(ended.relatedEventId, prepared.eventId);
    assert.equal(ended.auditLinkId, prepared.auditLinkId);
    assert.equal(s.records.entries.length, 2, 'exactly the pair');
    const attempts = s.records.attempts.filter(a => a.action === 'transfer-ended');
    assert.ok(attempts.length >= 2 && attempts[0].failed && !attempts.at(-1).failed, 'a failed attempt, then a durable one');
    assert.equal(new Set(attempts.map(a => a.eventId)).size, 1, 'the retries append the same event, not a new one per attempt');
    assert.equal(new Set(attempts.map(a => a.occurredAt)).size, 1, 'the event keeps the time the delivery closed');
    assert.ok(Date.parse(ended.occurredAt) <= closedBy, 'the terminal is dated at the close, not at the append that held it');
    // The study is read again meanwhile: a new delivery, its own pair, the old one untouched.
    assert.equal((await s.frame(2)).status, 200);
    await until(() => s.records.entries.length === 4, 'the new delivery\'s pair');
    await settle();
    assert.equal(s.records.control.live(), 0, 'every record work was ended');
    assert.equal(s.background.live(), 0, 'no retry task left running');
  } finally { await s.close(); }
});

test('shutdown makes a pending terminal\'s last attempt: recorded when the ledger takes it, left pending - never invented - when it does not', async () => {
  // The ledger is back by the time the process stops: the quiesce cleared the retry timer, the shutdown's own attempt records it.
  const s = await stack();
  try {
    assert.equal((await s.frame(1)).status, 200);
    s.records.state.failing = true;
    await until(() => s.records.attempts.some(a => a.action === 'transfer-ended'), 'the delivery did not close');
    assert.equal(s.records.entries.length, 1);
    s.background.quiesce();   // EmrNestLifecycle.onModuleDestroy
    s.records.state.failing = false;
    s.recorder.onModuleDestroy();
    await s.recorder.beforeApplicationShutdown();
    assert.equal(byAction(s.records.entries, 'transfer-ended').length, 1, 'the shutdown recorded the pending terminal');
    assert.equal(s.records.entries[1].event.relatedEventId, s.records.entries[0].event.eventId);
    await settle();
    assert.equal(s.records.control.live(), 0);
  } finally { await s.close(); }
  // The ledger is still down at the stop: the attempt is made and fails; nothing is appended later and nothing claims the pair complete.
  const s2 = await stack();
  try {
    assert.equal((await s2.frame(1)).status, 200);
    s2.records.state.failing = true;
    await until(() => s2.records.attempts.some(a => a.action === 'transfer-ended'), 'the delivery did not close');
    const before = s2.records.attempts.length;
    s2.background.quiesce();
    s2.recorder.onModuleDestroy();
    await s2.recorder.beforeApplicationShutdown();
    assert.ok(s2.records.attempts.length > before, 'the shutdown made its last attempt');
    assert.equal(s2.records.entries.length, 1, 'the ledger holds the prepared event alone: the pair is not complete');
    s2.records.state.failing = false;
    await wait(1500);
    assert.equal(s2.records.entries.length, 1, 'no attempt after the shutdown invents a late terminal');
    assert.equal(s2.background.live(), 0);
  } finally { await s2.close(); }
});

/** The product's shutdown consumers around the recorder: installed Nest's application context (its close runs every
 * onModuleDestroy, then every beforeApplicationShutdown, then onApplicationShutdown) and the real EmrNestLifecycle over
 * a runtime double that owns this stack's real background registry and real record port control, as EmrRuntime does.
 * Nest's logger is captured so the recorder's shutdown lines can be read; the console logger is restored afterwards. */
async function nestShutdown(s) {
  let closedAdmission;
  const admissionClosed = new Promise(resolve => { closedAdmission = resolve; });
  const runtime = { background: s.background,
    control: { close() { s.records.control.close(); closedAdmission(); }, live: () => s.records.control.live(), drained: () => s.records.control.drained() },
    async stop() { await s.background.drained(); await s.records.control.drained(); } };
  class ShutdownModule {}
  Module({ providers: [{ provide: StudyImageDeliveryRecorder, useValue: s.recorder }, { provide: EmrNestLifecycle, useValue: new EmrNestLifecycle(runtime) }] })(ShutdownModule);
  const lines = [];
  const capture = { log() {}, warn(message) { lines.push('warn ' + message); }, error(message) { lines.push('error ' + message); }, debug() {}, verbose() {} };
  const app = await NestFactory.createApplicationContext(ShutdownModule, { logger: capture });
  let stopped = false;
  const close = async () => { try { await app.close(); } finally { stopped = true; } };
  const done = async () => { if (!stopped) await close().catch(() => {}); Logger.overrideLogger(new ConsoleLogger()); };
  return { close, admissionClosed, lines, done };
}

test('graceful Nest shutdown closes record admission after the stop began: a delivery still being prepared, or whose first terminal attempt was in flight, still completes its pair', async () => {
  // (a) A read was admitted and its provide-prepared append is inside the store when the process stops. Nest runs the
  // recorder's onModuleDestroy, then EmrNestLifecycle closes admission; only then does the append complete.
  const s = await stack();
  let release, entered;
  const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const append = s.records.store.append;
  s.records.store.append = async (event, ...rest) => { if (event.action === 'provide-prepared') { entered(); await held; } return append(event, ...rest); };
  const nest = await nestShutdown(s);
  try {
    const read = s.frame(1);
    await started;
    const stopping = nest.close();
    await nest.admissionClosed;
    // A read that arrives after the stop began belongs to no delivery the stop will close: refused, nothing recorded.
    const late = await s.frame(2);
    assert.equal(late.status, 503);
    assert.equal(JSON.parse(late.body.toString()).code, IMAGE_DELIVERY_UNAVAILABLE.code);
    release();
    const response = await read;
    await stopping;
    assert.equal(response.status, 200, 'the read admitted before the stop completes for its client');
    assert.deepEqual(s.records.entries.map(e => e.event.action), ['provide-prepared', 'transfer-aborted'], 'the pair is complete; the response was still being sent at the stop');
    assert.equal(s.records.entries[1].event.relatedEventId, s.records.entries[0].event.eventId);
    assert.equal(s.records.control.live(), 0, 'every record work, the one reserved for the stop included, was ended');
    assert.deepEqual(nest.lines.filter(line => line.startsWith('error')), [], 'a complete shutdown reports no pending terminal');
  } finally { release(); await nest.done(); await s.close(); }
  // (b) The delivery closed at the idle gap and its first terminal attempt is inside the store when the process stops;
  // that attempt fails (one transient failure) after admission closed. The stop's own attempt records the same event.
  const s2 = await stack();
  let fail, terminalEntered, once = true;
  const terminalStarted = new Promise(resolve => { terminalEntered = resolve; }), failure = new Promise((_, reject) => { fail = reject; });
  const append2 = s2.records.store.append;
  s2.records.store.append = async (event, ...rest) => {
    if (event.action !== 'provide-prepared' && once) { once = false; terminalEntered(); await failure; }
    return append2(event, ...rest);
  };
  const nest2 = await nestShutdown(s2);
  try {
    assert.equal((await s2.frame(1)).status, 200);
    await terminalStarted;
    const stopping = nest2.close();
    await nest2.admissionClosed;
    fail(new Error('synthetic single transient failure'));
    await stopping;
    assert.deepEqual(s2.records.entries.map(e => e.event.action), ['provide-prepared', 'transfer-ended'], 'the pair is complete');
    assert.equal(s2.records.entries[1].event.relatedEventId, s2.records.entries[0].event.eventId);
    assert.equal(s2.records.attempts.filter(a => a.action === 'transfer-ended').length, 1, 'the stop\'s attempt reached the store after the held one failed before it');
    assert.equal(nest2.lines.filter(line => line.startsWith('warn')).length, 1, 'the failed in-flight attempt is reported once, as an attempt');
    assert.deepEqual(nest2.lines.filter(line => line.startsWith('error')), [], 'nothing pending is reported');
    assert.equal(s2.records.control.live(), 0);
    assert.equal(s2.background.live(), 0);
  } finally { fail(new Error('cleanup')); await nest2.done(); await s2.close(); }
});

test('graceful Nest shutdown: a terminal whose first attempt was made during the stop and failed once is still recorded by the stop\'s last attempt', async () => {
  // The delivery is still being prepared when the process stops (as in (a) above); after admission closed, its terminal
  // is attempted on the work the stop reserved and that attempt fails once - the store takes everything after it. The
  // stop's last attempt must still reach the store: nothing before it may end the reserved work (GPT review of 1b9e0f8).
  const s = await stack();
  let release, entered;
  const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  // Every terminal append the store was asked for, the failed one included (it fails here, before the fixture's own
  // attempts list sees it).
  const terminals = [];
  const append = s.records.store.append;
  s.records.store.append = async (event, ...rest) => {
    if (event.action === 'provide-prepared') { entered(); await held; }
    else if (terminals.push(event.eventId) === 1) throw new Error('synthetic single transient terminal failure');
    return append(event, ...rest);
  };
  const nest = await nestShutdown(s);
  try {
    const read = s.frame(1);
    await started;
    const stopping = nest.close();
    await nest.admissionClosed;
    release();
    const response = await read;
    await stopping;
    assert.equal(response.status, 200);
    assert.deepEqual(s.records.entries.map(e => e.event.action), ['provide-prepared', 'transfer-aborted'], 'the pair is complete after one failed terminal attempt during the stop');
    assert.equal(s.records.entries[1].event.relatedEventId, s.records.entries[0].event.eventId);
    assert.equal(terminals.length, 2, 'the failed attempt and the stop\'s last attempt both reached the store');
    assert.equal(terminals[0], terminals[1], 'the same terminal event, not a new one');
    assert.equal(s.records.attempts.filter(a => a.action === 'transfer-aborted').length, 1, 'the store holds the one that succeeded');
    assert.equal(nest.lines.filter(line => line.startsWith('warn')).length, 1, 'the failed attempt is reported once, as an attempt');
    assert.deepEqual(nest.lines.filter(line => line.startsWith('error')), [], 'nothing pending is reported');
    assert.equal(s.records.control.live(), 0, 'the reserved work was ended after the last attempt');
    assert.equal(s.background.live(), 0);
  } finally { release(); await nest.done(); await s.close(); }
});
