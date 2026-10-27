'use strict';
/* MG-08 (D1877): the study delivery's 열람 record on the API's image path, at the served HTTP boundary. A real
 * node:http server runs the real DicomFrameController, DicomFrameService, StudyImageDeliveryRecorder, request-context
 * capture, current clinical context (identity, StudyAccess, patient link), StudyAccessService, PacsAccess and the
 * DICOMweb gate; the access ledger is an in-memory port that runs the real event parser and mints real receipts, the
 * Orthanc index is a stub over one synthetic stored object, authentication is an explicit synthetic input (the guard's
 * capture is called with it). Asserted: no image byte before the provide-prepared event is durable; one pair per
 * study delivery (open, reload within the idle gap, reload after it); a ledger that cannot record answers 503 with no
 * body; refusals of the gate leave no record; shutdown closes open deliveries. The PostgreSQL ledger itself is proven in
 * tests/emr/a (real PG). D73: behaviour at the boundary, no product source text. Synthetic values only; 127.0.0.1 only. */
const { STUDY_UID, SERIES_UID, SOP_UID, INSTANCE_ID, STUDY_ID, syntheticObject, stubOrthanc } = require('./dicom_frame_fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { HttpException } = require('/app/node_modules/@nestjs/common');
const { DicomFrameController } = require('/app/dist/dicom-frame.controller.js');
const { DicomFrameService } = require('/app/dist/dicom-frame.service.js');
const { StudyImageDeliveryRecorder, IMAGE_DELIVERY_UNAVAILABLE, FRAMES_SURFACE, PREVIEW_SURFACE } = require('/app/dist/dicom-frame-delivery.js');
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

/** An in-memory record port with the public port's semantics: durable receipts only for stored events, append-only. */
function ledger() {
  const entries = [], state = { failing: false, live: 0 };
  const tx = {};
  const port = { begin() {
    state.live++;
    let ended = false;
    const guard = () => { if (ended) throw new Error('EmrRecordWorkEnded'); };
    const find = operationId => entries.find(e => e.operationId === operationId);
    return {
      async append(event, served, keys) {
        guard();
        const parsed = parseAccessEvent(event);   // the store's canonicalPayload runs this same parser
        if (state.failing) throw new Error('LedgerUnreachable');
        const storedAt = new Date().toISOString();
        entries.push({ event: parsed, operationId: keys?.operationId ?? randomUUID(), storedAt, at: process.hrtime.bigint() });
        return mintDurableReceipt(parsed.eventId, storedAt);
      },
      async lookup(operationId) { guard(); const e = find(operationId); return e ? { operationId, eventId: e.event.eventId, outcome: 'committed', durableAt: e.storedAt, result: null, entries: [] } : null; },
      async confirm(appended) { guard(); const e = find(appended.operationId); if (!e) throw new Error('CommitUnknown'); return mintDurableReceipt(e.event.eventId, e.storedAt); },
      async transactionWithRecords(work) { guard(); return work(tx, async (event, effect) => effect()); },
      async resolveRequestIdentity(issuer, subject) { guard(); return identityOf(issuer, subject); },
      async resolveIdentity(_tx, issuer, subject) { guard(); return identityOf(issuer, subject); },
      async admit() { throw new Error('SYN admit is not used by the image delivery'); },
      async transaction() { throw new Error('SYN transaction is not used by the image delivery'); },
      async snapshot() { throw new Error('SYN snapshot is not used by the image delivery'); },
      end() { if (!ended) { ended = true; state.live--; } },
    };
  } };
  return { port, entries, state, tx };
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
  const recorder = new StudyImageDeliveryRecorder(records.port, contexts.source, clinical, orthanc, IDLE_MS);
  const service = new DicomFrameService(orthanc);
  const controller = new DicomFrameController(service, { authzDicom: (...args) => gate.authzDicom(...args) }, orthanc, recorder);
  const observations = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    // Authentication is the synthetic input; everything after it is the product's.
    req.sub = req.headers['x-synthetic-sub'] ?? 'syn-doctor-sub'; req.actor = req.sub; req.roles = ['radiologist'];
    req.institution = req.headers['x-synthetic-site'] ?? SITE; req.kind = 'member';
    res.status = code => { res.statusCode = code; return res; };
    const preview = /^\/instances\/([0-9a-f-]+)\/preview$/.exec(url.pathname);
    const frames = /^\/dicom-web\/studies\/([^/]+)\/series\/([^/]+)\/instances\/([^/]+)\/frames\/([^/]+)$/.exec(url.pathname);
    contexts.capture.capture(req, res, { issuer: ISSUER, subject: req.sub, roles: req.roles, institution: req.institution, rightsVersion: 1,
      binding: { method: 'session', sessionRef: req.headers['x-synthetic-session'] ?? 'authref:session-a' } },
      { method: 'GET', route: preview ? 'instances/:id/preview' : 'dicom-web/studies/:study/series/:series/instances/:sop/frames/:frames', purpose: 'clinical' }, async () => {});
    const observation = { path: url.pathname, firstByte: null, status: null };
    observations.push(observation);
    const write = res.write.bind(res);
    res.write = (...args) => { observation.firstByte ??= { entries: records.entries.length, at: process.hrtime.bigint() }; return write(...args); };
    try {
      if (preview) await controller.preview(preview[1], req, res);
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
  const get = async (route, headers = {}) => {
    const response = await fetch(origin + route, { headers: { Connection: 'close', ...headers } });
    return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
  };
  const frame = (n, headers) => get(`/dicom-web/studies/${STUDY_UID}/series/${SERIES_UID}/instances/${SOP_UID}/frames/${n}`, { Accept: ACCEPT, ...headers });
  const preview = headers => get(`/instances/${INSTANCE_ID}/preview`, headers);
  const close = async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    if (previousStorage === undefined) delete process.env.KIN_ORTHANC_STORAGE; else process.env.KIN_ORTHANC_STORAGE = previousStorage;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { object, orthanc, records, recorder, observations, get, frame, preview, close, states };
}

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
    assert.equal(s.records.state.live, 0, 'every record work was ended');
    assert.equal(s.orthanc.calls.filter(c => c[0] === 'revision').length, 2, 'the study revision is read once per delivery');
  } finally { await s.close(); }
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
    assert.equal(s.records.state.live, 0);
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
    assert.equal(s.records.state.live, 0);
  } finally { hold = false; release?.(); await s.close(); }
});
