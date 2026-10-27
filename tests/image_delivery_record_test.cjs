'use strict';
/* MG-08 (D1877(2)): the study delivery's 열람 record on the existing image reads nginx now routes to the API relay
 * (worklist preview/thumbnail `frames/N/rendered`, report/print `image-uint16`, WADO-RS frames). A real node:http server
 * runs the real ImageRelayController, StudyImageDeliveryRecorder, request-context capture, current clinical context
 * (identity, StudyAccess, patient link), StudyAccessService, PacsAccess, the DICOMweb gate and a real OrthancService
 * whose relay and lookups reach a synthetic Orthanc HTTP server on 127.0.0.1. The access ledger is an in-memory port
 * that runs the real event parser and mints real receipts; authentication is an explicit synthetic input (the guard's
 * capture is called with it). Asserted: no image byte before the provide-prepared event is durable; one pair per study
 * delivery across routes (open, reload within the idle gap, reload after it); descriptions (tags, metadata) and HEAD
 * are no delivery; a ledger that cannot record answers 503 and Orthanc is never asked for the image; refusals of the
 * gate leave no record; a delivery whose only response failed or was cut short closes as aborted, not succeeded
 * (MG-10); a terminal the ledger cannot take is retained as the same event and offered again until durable (MG-09); the
 * auth_request admission refuses every image read so none can bypass the relay. The PostgreSQL ledger itself is proven
 * in tests/emr/a (real PG); nginx routing is the served stack run. D73: behaviour at the boundary, no product source
 * text. Synthetic values only; 127.0.0.1 only. */
require('./service_test_loader.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const { HttpException, ForbiddenException } = require('/app/node_modules/@nestjs/common');

const STUDY_UID = '1.2.826.0.1.3680043.8.498.1001', SERIES_UID = '1.2.826.0.1.3680043.8.498.1002', SOP_UID = '1.2.826.0.1.3680043.8.498.1003';
const INSTANCE_ID = '0a1b2c3d-4e5f6071-8293a4b5-c6d7e8f9-0a1b2c3d', STUDY_ID = '11111111-22222222-33333333-44444444-55555555';
const ISSUER = 'https://synthetic-idp.invalid/realms/kin', SITE = 'site-a', IDLE_MS = 150;
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(4096, 7)]);
const PAM = Buffer.concat([Buffer.from('P7\nWIDTH 2\nHEIGHT 2\nDEPTH 1\nMAXVAL 65535\nTUPLTYPE GRAYSCALE\nENDHDR\n'), Buffer.alloc(8, 1)]);
const FRAME = Buffer.concat([Buffer.from('--b\r\nContent-Type: application/octet-stream\r\n\r\n'), Buffer.alloc(2048, 3), Buffer.from('\r\n--b--')]);

/** The immutable member id the ledger binds to an issuer and subject: deterministic here, a UUID shape as B2's. */
function identityOf(issuer, subject) {
  const h = createHash('sha256').update(issuer + '\n' + subject).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** An in-memory record port with the public port's semantics: durable receipts only for stored events, append-only,
 * one operation per event ID (an exact retry returns the stored result). `attempts` holds failed offers too. */
function ledger(parseAccessEvent, mintDurableReceipt) {
  const entries = [], attempts = [], state = { failing: false };
  const tx = {};
  const port = { begin() {
    let ended = false;
    const guard = () => { if (ended) throw new Error('EmrRecordWorkEnded'); };
    const find = operationId => entries.find(e => e.operationId === operationId);
    return {
      async append(event, served, keys) {
        guard();
        const parsed = parseAccessEvent(event);
        attempts.push({ eventId: parsed.eventId, action: parsed.action, operationId: keys?.operationId, failed: state.failing });
        if (state.failing) throw new Error('LedgerUnreachable');
        const stored = entries.find(e => e.event.eventId === parsed.eventId);
        if (stored) {
          if (stored.operationId !== keys?.operationId || JSON.stringify(stored.event) !== JSON.stringify(parsed)) throw new Error('AccessEventIdConflict');
          return mintDurableReceipt(parsed.eventId, stored.storedAt);
        }
        const storedAt = new Date().toISOString();
        entries.push({ event: parsed, operationId: keys?.operationId ?? randomUUID(), storedAt });
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
      end() { ended = true; },
    };
  } };
  return { port, entries, attempts, state, tx };
}

/** A synthetic Orthanc: the lookups the gate and the record read, and the image representations the consumers read. */
async function syntheticOrthanc() {
  const calls = [], behaviour = { image: 'ok' };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1'), p = url.pathname;
      calls.push({ method: req.method, path: p, query: url.search, accept: req.headers.accept });
      const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
      const image = (type, bytes) => {
        if (behaviour.image === 'error') { res.statusCode = 500; return json({ Message: 'synthetic failure' }); }
        res.setHeader('Content-Type', type); res.setHeader('Content-Length', String(bytes.length));
        if (behaviour.image === 'cut') { res.write(bytes.subarray(0, 64)); setTimeout(() => res.destroy(), 20); return; }
        res.end(bytes);
      };
      if (p === `/instances/${INSTANCE_ID}/study`) return json({ ID: STUDY_ID, MainDicomTags: { StudyInstanceUID: STUDY_UID } });
      if (p === '/tools/lookup' && req.method === 'POST') return json(body === STUDY_UID ? [{ Type: 'Study', ID: STUDY_ID }] : []);
      if (p === `/studies/${STUDY_ID}`) return json({ ID: STUDY_ID, LastUpdate: '20261028T090000' });
      if (p === '/dicom-web/studies' && url.searchParams.get('StudyInstanceUID') === STUDY_UID)
        return json([{ '0020000D': { vr: 'UI', Value: [STUDY_UID] }, '00100020': { vr: 'LO', Value: ['SYN-PID-1'] }, '00080080': { vr: 'LO', Value: ['SYN HOSPITAL A'] } }]);
      if (p === `/instances/${INSTANCE_ID}/simplified-tags`) return json({ StudyInstanceUID: STUDY_UID, Rows: '2' });
      if (p === `/dicom-web/studies/${STUDY_UID}/metadata`) return json([{ '0020000D': { vr: 'UI', Value: [STUDY_UID] } }]);
      if (p === `/instances/${INSTANCE_ID}/frames/0/rendered`) return image('image/png', PNG);
      if (p === `/instances/${INSTANCE_ID}/image-uint16`) return image('image/x-portable-arbitrarymap', PAM);
      if (p === `/dicom-web/studies/${STUDY_UID}/series/${SERIES_UID}/instances/${SOP_UID}/frames/1`) return image('multipart/related; type="application/octet-stream"; boundary=b', FRAME);
      res.statusCode = 404; json({ Message: 'unknown' });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const imageCalls = () => calls.filter(c => /rendered|image-uint16|\/frames\/1$/.test(c.path));
  return { calls, imageCalls, behaviour, origin: `http://127.0.0.1:${server.address().port}`,
    close: () => { server.closeAllConnections?.(); return new Promise(resolve => server.close(resolve)); } };
}

/** The whole served path over the synthetic Orthanc. */
async function stack() {
  const source = await syntheticOrthanc();
  const previous = { url: process.env.ORTHANC_URL, user: process.env.ORTHANC_USER, pass: process.env.ORTHANC_PASS };
  Object.assign(process.env, { ORTHANC_URL: source.origin, ORTHANC_USER: 'syn', ORTHANC_PASS: 'syn' });
  const { parseAccessEvent } = require('/app/dist/emr-contract/access-event.js');
  const { mintDurableReceipt } = require('/app/dist/emr-runtime/contract.js');
  const { createBackgroundWorkRegistry } = require('/app/dist/emr-runtime/background-work.js');
  const { createRequestContext } = require('/app/dist/emr-runtime/request-context.js');
  const { createRequestIngress } = require('/app/dist/emr-runtime/request-ingress.js');
  const { createCurrentClinicalContext } = require('/app/dist/emr-clinical/startup.js');
  const { StudyAccessService } = require('/app/dist/study-access.service.js');
  const { PacsAccess } = require('/app/dist/pacs/access.js');
  const { PacsDicomGateway } = require('/app/dist/pacs/dicom-gateway.js');
  const { OrthancService } = require('/app/dist/orthanc.service.js');
  const { StudyImageDeliveryRecorder } = require('/app/dist/image-delivery-record.js');
  const { ImageRelayController } = require('/app/dist/image-relay.controller.js');
  const orthanc = new OrthancService();
  const records = ledger(parseAccessEvent, mintDurableReceipt);
  const states = new Map([[STUDY_UID, { uid: STUDY_UID, institutionId: SITE, teleInstitutionId: null }]]);
  const sql = async strings => {
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
  const background = createBackgroundWorkRegistry();
  const recorder = new StudyImageDeliveryRecorder(records.port, contexts.source, clinical, background.work, orthanc, IDLE_MS);
  const controller = new ImageRelayController({ authzDicom: (...args) => gate.authzDicom(...args) }, orthanc, recorder);
  const observations = [];
  const server = http.createServer(async (req, res) => {
    // nginx: `location /instances/ { proxy_pass http://api:3000/api/image-relay/instances/; }` (and /dicom-web/).
    req.originalUrl = '/api/image-relay' + req.url;
    req.sub = req.headers['x-synthetic-sub'] ?? 'syn-doctor-sub'; req.actor = req.sub; req.roles = ['radiologist'];
    req.institution = req.headers['x-synthetic-site'] ?? SITE; req.kind = 'member';
    res.status = code => { res.statusCode = code; return res; };
    contexts.capture.capture(req, res, { issuer: ISSUER, subject: req.sub, roles: req.roles, institution: req.institution, rightsVersion: 1,
      binding: { method: 'session', sessionRef: req.headers['x-synthetic-session'] ?? 'authref:session-a' } },
      { method: 'GET', route: 'image-relay/*', purpose: 'clinical' }, async () => {});
    const observation = { path: req.url, firstByte: null };
    observations.push(observation);
    const write = res.write.bind(res), end = res.end.bind(res);
    const first = () => { observation.firstByte ??= records.entries.map(e => e.event.action); };
    res.write = (chunk, ...rest) => { if (chunk?.length) first(); return write(chunk, ...rest); };
    res.end = (chunk, ...rest) => { if (chunk?.length && res.statusCode === 200) first(); return end(chunk, ...rest); };
    try { await controller.read(req, res); }
    catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      res.statusCode = error instanceof HttpException ? error.getStatus() : 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(error instanceof HttpException ? error.getResponse() : { message: String(error?.message) }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async (route, headers = {}, method = 'GET') => {
    try {
      const response = await fetch(origin + route, { method, headers: { Connection: 'close', ...headers } });
      return { status: response.status, type: response.headers.get('content-type'), body: Buffer.from(await response.arrayBuffer()) };
    } catch (error) { return { status: 'cut', error }; }
  };
  const routes = {
    thumbnail: `/instances/${INSTANCE_ID}/frames/0/rendered?width=256&height=256`,
    report: `/instances/${INSTANCE_ID}/image-uint16`,
    frame: `/dicom-web/studies/${STUDY_UID}/series/${SERIES_UID}/instances/${SOP_UID}/frames/1`,
    tags: `/instances/${INSTANCE_ID}/simplified-tags`,
    metadata: `/dicom-web/studies/${STUDY_UID}/metadata`,
  };
  const close = async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    background.quiesce();
    await background.drained();
    await source.close();
    for (const [key, env] of [['url', 'ORTHANC_URL'], ['user', 'ORTHANC_USER'], ['pass', 'ORTHANC_PASS']])
      if (previous[key] === undefined) delete process.env[env]; else process.env[env] = previous[key];
  };
  return { source, records, recorder, observations, get, routes, states, close };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const actions = records => records.entries.map(e => e.event.action);

test('MG-08 worklist thumbnail: one durable provide-prepared for the study before the first image byte; bytes relayed unchanged', async () => {
  const s = await stack();
  try {
    const r = await s.get(s.routes.thumbnail, { Accept: 'image/png' });
    assert.equal(r.status, 200);
    assert.equal(r.type, 'image/png');
    assert.deepEqual(r.body, PNG, 'the rendering is Orthanc\'s own answer');
    assert.deepEqual(s.observations[0].firstByte, ['provide-prepared'], 'the record was durable when the first byte left');
    const call = s.source.imageCalls()[0];
    assert.equal(call.query, '?width=256&height=256', 'rendering parameters reach Orthanc as before');
    assert.equal(call.accept, 'image/png');
    const [prepared] = s.records.entries.map(e => e.event);
    assert.equal(prepared.surface, 'GET image-relay/*');
    assert.equal(prepared.result, 'prepared');
    assert.deepEqual(prepared.targets.map(t => [t.kind, t.studyId.value, t.recordId.value, t.versionId.value]),
      [['image', STUDY_UID, STUDY_UID, `orthanc-study:${STUDY_ID}@20261028T090000`]]);
    assert.equal(prepared.managingInstitution.value, SITE);
  } finally { await s.close(); }
});

test('MG-08 one study delivery across worklist, report and viewer reads; reload inside the gap shares it, after the gap opens a new pair', async () => {
  const s = await stack();
  try {
    assert.equal((await s.get(s.routes.thumbnail)).status, 200);
    assert.equal((await s.get(s.routes.report)).status, 200);
    const frame = await s.get(s.routes.frame, { Accept: 'multipart/related; type="application/octet-stream"' });
    assert.equal(frame.status, 200);
    assert.deepEqual(frame.body, FRAME);
    assert.deepEqual(actions(s.records), ['provide-prepared'], 'three image reads of one study, one record');
    await wait(IDLE_MS * 3);
    const [prepared, ended] = s.records.entries.map(e => e.event);
    assert.equal(ended.action, 'transfer-ended');
    assert.equal(ended.result, 'succeeded');
    assert.equal(ended.relatedEventId, prepared.eventId);
    assert.deepEqual(ended.targets, prepared.targets);
    assert.equal((await s.get(s.routes.thumbnail)).status, 200);
    assert.deepEqual(actions(s.records), ['provide-prepared', 'transfer-ended', 'provide-prepared'], 'a reload after the gap is a new pair');
  } finally { await s.close(); }
});

test('MG-08 descriptions and HEAD are relayed behind the gate without a delivery record', async () => {
  const s = await stack();
  try {
    assert.equal((await s.get(s.routes.tags)).status, 200);
    assert.equal((await s.get(s.routes.metadata)).status, 200);
    assert.equal((await s.get(s.routes.thumbnail, {}, 'HEAD')).status, 200);
    assert.deepEqual(s.records.attempts, [], 'no image byte left, so no delivery was recorded');
    const refused = await s.get(s.routes.tags, { 'X-Synthetic-Site': 'site-b' });
    assert.equal(refused.status, 403, 'the description keeps the institution gate');
  } finally { await s.close(); }
});

test('MG-08 a ledger that cannot record answers 503 and Orthanc is never asked for the image', async () => {
  const s = await stack();
  try {
    s.records.state.failing = true;
    const r = await s.get(s.routes.thumbnail);
    assert.equal(r.status, 503);
    assert.equal(JSON.parse(r.body.toString()).code, 'IMAGE_DELIVERY_RECORD_UNAVAILABLE');
    assert.deepEqual(s.source.imageCalls(), [], 'no image read reached the source');
    assert.deepEqual(s.records.entries, []);
    s.records.state.failing = false;
    assert.equal((await s.get(s.routes.thumbnail)).status, 200, 'the next read asks the ledger again');
    assert.deepEqual(actions(s.records), ['provide-prepared']);
  } finally { await s.close(); }
});

test('MG-08 a read the gate refuses leaves no record and no source image read', async () => {
  const s = await stack();
  try {
    const r = await s.get(s.routes.thumbnail, { 'X-Synthetic-Site': 'site-b' });
    assert.equal(r.status, 403);
    assert.deepEqual(s.records.attempts, []);
    assert.deepEqual(s.source.imageCalls(), []);
    for (const path of ['/instances/%2e%2e/system', '/instances/' + INSTANCE_ID + '//rendered', '/statistics'])
      assert.equal((await s.get(path)).status, 404, 'only plain image-root paths are relayed: ' + path);
  } finally { await s.close(); }
});

test('MG-10 a delivery whose only image answer failed or was cut short closes aborted, never succeeded', async () => {
  for (const behaviour of ['error', 'cut']) {
    const s = await stack();
    try {
      s.source.behaviour.image = behaviour;
      const r = await s.get(s.routes.thumbnail);
      if (behaviour === 'error') assert.equal(r.status, 500, 'Orthanc\'s error answer is relayed as it is');
      else assert.ok(r.status === 'cut' || r.body.length < PNG.length, 'a cut transfer is not a complete image');
      await wait(IDLE_MS * 3);
      assert.deepEqual(actions(s.records), ['provide-prepared', 'transfer-aborted'], behaviour);
      assert.equal(s.records.entries[1].event.result, 'aborted');
    } finally { await s.close(); }
  }
});

test('MG-09 a terminal the ledger cannot take is retained as the same event and offered again until durable', async () => {
  const s = await stack();
  try {
    assert.equal((await s.get(s.routes.thumbnail)).status, 200);
    s.records.state.failing = true;
    await wait(IDLE_MS * 3);
    assert.deepEqual(actions(s.records), ['provide-prepared'], 'the terminal is not recorded while the ledger fails');
    const offered = s.records.attempts.filter(a => a.action === 'transfer-ended');
    assert.equal(offered.length, 1);
    s.records.state.failing = false;
    await s.recorder.beforeApplicationShutdown();
    assert.deepEqual(actions(s.records), ['provide-prepared', 'transfer-ended'], 'the retained terminal became durable');
    const again = s.records.attempts.filter(a => a.action === 'transfer-ended');
    assert.equal(again.length, 2);
    assert.equal(again[1].eventId, again[0].eventId, 'the same event, not a second record');
    assert.equal(again[1].operationId, again[0].operationId, 'under the same operation');
    assert.equal(s.records.entries[1].event.relatedEventId, s.records.entries[0].event.eventId);
  } finally { await s.close(); }
});

test('MG-08 shutdown closes an open delivery: a quiet one by what it served', async () => {
  const s = await stack();
  try {
    assert.equal((await s.get(s.routes.report)).status, 200);
    await s.recorder.beforeApplicationShutdown();
    assert.deepEqual(actions(s.records), ['provide-prepared', 'transfer-ended']);
  } finally { await s.close(); }
});

test('MG-08 classification: image representations are deliveries, descriptions are not', () => {
  const { imageRead } = require('/app/dist/image-relay.controller.js');
  const I = '/instances/' + INSTANCE_ID, S = '/dicom-web/studies/' + STUDY_UID, SE = S + '/series/' + SERIES_UID, O = SE + '/instances/' + SOP_UID;
  for (const path of [I + '/frames/0/rendered', I + '/image-uint16', I + '/frames/0/image-int16', I + '/preview', I + '/pdf', I + '/file',
    I + '/rendered', I + '/content/7fe0-0010', I, O + '/frames/1', O + '/frames/1/rendered', O + '/rendered', O + '/thumbnail', O,
    O + '/bulk/7fe00010', SE, SE + '/rendered', S, S + '/thumbnail'])
    assert.equal(imageRead(path), true, path);
  for (const path of ['/dicom-web/studies', S + '/series', S + '/instances', SE + '/instances', S + '/metadata', SE + '/metadata',
    O + '/metadata', I + '/tags', I + '/simplified-tags', I + '/header', I + '/attachments/dicom/info', '/statistics', '/system'])
    assert.equal(imageRead(path), false, path);
});

test('MG-08 the auth_request admission refuses every image read and still admits descriptions and STOW', async () => {
  const { PacsController } = require('/app/dist/pacs.controller.js');
  const admitted = [];
  const controller = new PacsController({ authzDicom: async (uri, method) => { admitted.push([method, uri]); } }, {}, {});
  const ask = (uri, method = 'GET') => controller.authzDicom({ headers: { 'x-original-uri': uri, 'x-original-method': method }, sub: 's', roles: [] });
  for (const uri of [`/instances/${INSTANCE_ID}/frames/0/rendered?width=256`, `/instances/${INSTANCE_ID}/image-uint16`,
    `/dicom-web/studies/${STUDY_UID}/series/${SERIES_UID}/instances/${SOP_UID}/frames/1`, `/dicom-web/studies/${STUDY_UID}`])
    await assert.rejects(async () => ask(uri), ForbiddenException, uri);
  await assert.rejects(async () => ask(`/instances/${INSTANCE_ID}/pdf`, 'HEAD'), ForbiddenException);
  await ask(`/dicom-web/studies/${STUDY_UID}/metadata`);
  await ask(`/dicom-web/studies?StudyInstanceUID=${STUDY_UID}`);
  await ask(`/dicom-web/studies/${STUDY_UID}`, 'POST');
  await ask('/statistics');
  assert.deepEqual(admitted.map(([m]) => m), ['GET', 'GET', 'POST', 'GET']);
});
