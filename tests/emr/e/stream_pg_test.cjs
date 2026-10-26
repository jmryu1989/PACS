'use strict';
// E-01/02/03 -> wrong representation, bytes before COMMIT, false delivery.
// Actual B2 PostgreSQL transactions and node HTTP sockets. The Orthanc protocol
// fixture is synthetic; this does not claim pinned OHIF/native decoder coverage.
//
// A response is provided under a study delivery's access record (delivery.ts): one B2 provide-prepared event per
// requester, session and manifest version, durable before the first response of the delivery is prepared; each
// response keeps its exact representation, transport and copy facts in E's rows naming that event; the delivery is
// closed by one terminal event. The first case drives sendOnlineImage with a delivery opened the way the service
// opens it; the second drives the service itself against the real ledger and checks the ledger's events.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createServer, get } = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const { mkdir, readdir } = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const api = process.env.KIN_E_API || path.join(root, 'api');
const load = name => require(path.join(api, 'dist', name));
const { PrismaClient } = require(path.join(api, 'node_modules/@prisma/client'));
const { AccessLedgerStore } = load('emr-runtime/store');
const { createRecordPort } = load('emr-runtime/record-port');
const { FailureJournal, FailureSpool } = load('emr-runtime/failure-journal');
const { OrthancService } = load('orthanc.service');
const { buildImageManifest } = load('emr-image/manifest');
const E = load('emr-image/contract');
const { sendOnlineImage } = load('emr-image/stream');
const { PgImageEvidenceStore } = load('emr-image/store');
const { parseAccessEvent } = load('emr-contract/access-event');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const known = value => ({ status: 'known', value });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const studyUid = '2.25.701', seriesUid = studyUid + '.1', sop = seriesUid + '.1';
const original = Buffer.alloc(65536, 37), frames = [Buffer.alloc(1024, 11), Buffer.alloc(1024, 22)];
original.write('DICM', 128);
const ts = '1.2.840.10008.1.2.1', objectId = '11111111-22222222-33333333-44444444-55555555';
const patient = { linkId: 'synthetic-image-link', patientId: 'SYNTHETIC-E', assigningAuthority: 'synthetic-hospital' };
const manifest = buildImageManifest({ formatVersion: 1, studyUid, managingInstitution: 'synthetic-hospital', patient,
  builtAt: new Date().toISOString(), expected: { series: 1, objects: 1 },
  pages: [{ cursor: null, next: null, objects: [{ studyUid, seriesUid, sopInstanceUid: sop,
    sopClassUid: '1.2.840.10008.5.1.4.1.1.7.2', transferSyntaxUid: ts, imageType: ['ORIGINAL', 'PRIMARY'],
    bytes: original.length, sha256: hash(original), declaredFrameCount: 2,
    frames: frames.map((bytes, i) => ({ number: i + 1, bytes: bytes.length, sha256: hash(bytes) })),
    provenance: { kind: 'device', receiptEventId: null }, derivation: { kind: 'original' }, mammography: null, timing: null }] }],
  referencedObjects: [], decoderCatalog: { native: { version: 'synthetic-native', sha256: hash('synthetic-decoder') } },
  viewer: { id: 'synthetic-viewer', version: 'fixture', sha256: hash('synthetic-viewer') } });
const doctor = { id: 'synthetic-doctor', issuer: 'synthetic', subject: 'doctor' };
const provision = at => E.checkProvisionBasis({ relation: 'same-institution', at, managingInstitution: 'synthetic-hospital',
  recipient: null, studyUid, purpose: null, basis: null, agreement: null, auditBefore: null });
const studyEvent = (eventId, at, cause = 'user-view', requestId = randomUUID()) => parseAccessEvent({ formatVersion: 1,
  surface: 'GET images/dicom-web', eventId, userId: known(doctor), rolesAtTime: known(['radiologist']),
  actingInstitution: known('synthetic-hospital'), managingInstitution: known('synthetic-hospital'), occurredAt: at,
  trustedProxyIp: known({ address: '127.0.0.1', source: 'request-peer' }), cause,
  context: cause === 'user-view' ? { basis: 'worklist', studyId: studyUid, relatedStudyId: null, reason: null }
    : { basis: 'background-fetch', studyId: null, relatedStudyId: null, reason: null }, executor: 'member',
  targets: [{ kind: 'image', patientLinkSnapshot: known(patient), studyId: known(studyUid), recordId: known(studyUid), versionId: known(manifest.sha256) }],
  action: 'provide-prepared', result: 'prepared', requestId, auditLinkId: 'audit:' + randomUUID(), relatedEventId: null });

/** A synthetic Orthanc answering the manifest's one object; `state` lets a case swap bytes or the header syntax. */
function syntheticSource(state) {
  return createServer((req, res) => {
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url === '/tools/lookup') return json([{ Type: 'Instance', ID: objectId }]);
    if (req.url.endsWith('/simplified-tags')) return json({ StudyInstanceUID: studyUid, SeriesInstanceUID: seriesUid,
      SOPInstanceUID: sop, SOPClassUID: manifest.objects[0].sopClassUid, NumberOfFrames: '2' });
    if (req.url.endsWith('/header')) return json({ '0002,0010': { Value: state.headerSyntax } });
    if (req.url.endsWith('/file')) { state.sourceReads++; res.end(state.sourceBytes); return; }
    const frame = /\/frames\/(\d+)\/raw$/.exec(req.url);
    if (frame && frames[Number(frame[1])]) { state.sourceReads++; res.end(frames[Number(frame[1])]); return; }
    if (req.url.endsWith('/metadata')) return json([{ '0020000D': { vr: 'UI', Value: [studyUid] } }]);
    res.writeHead(404); res.end();
  });
}

/** What the service does to open a study delivery on the real ledger: admit, commit, confirm. */
async function openDelivery(port, cause = 'user-view') {
  const work = port.begin();
  try {
    const at = new Date().toISOString(), eventId = randomUUID();
    const prepared = E.prepareDelivery(manifest, E.parseImageRequest('GET', `/dicom-web/studies/${studyUid}`), { eventId, cause, at,
      authorization: { studyUid, institution: 'synthetic-hospital', accountGeneration: 1 }, opening: null, provision: provision(at) });
    const event = studyEvent(eventId, at, cause);
    const operation = await work.admit(event, undefined, { operationId: eventId, attemptId: eventId });
    const result = await work.transaction(operation, async () => ({ kind: 'emr-image', id: eventId, version: manifest.sha256 }));
    assert.equal(result.outcome, 'committed');
    const receipt = await work.confirm({ provisional: true, operationId: operation.operationId, eventId });
    return { event, receipt, prepared };
  } finally { work.end(); }
}

test('E real B2 COMMIT gates fixed HTTP bodies, ranges, multipart, failures and copies', async () => {
  const db = new PrismaClient(), witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_E_WITNESS_URL } } });
  const journal = new FailureJournal(db, new FailureSpool(process.env.KIN_E_SPOOL));
  const ledger = new AccessLedgerStore(db, journal), { port } = createRecordPort(ledger);
  const state = { sourceBytes: original, sourceReads: 0, headerSyntax: ts };
  const source = syntheticSource(state);
  process.env.ORTHANC_URL = await listen(source);
  process.env.ORTHANC_USER = 'synthetic'; process.env.ORTHANC_PASS = randomUUID();
  const staging = path.join(process.env.KIN_E_SPOOL, 'staging'); await mkdir(staging, { recursive: true });
  const orthanc = new OrthancService();
  let denyAtPrepare = false, failPrepared = false, loseCommit = false, failObservation = false, interruptFrame = false;
  let afterPrepared = () => {}, current, handleResult, clientRequest, countChecks = 0, readsBeforeDeny = 0;
  const storedEvidence = new PgImageEvidenceStore(db);
  const evidence = {
    async prepared(fixed, sourceManifest, copies, requestId) {
      assert.equal(sourceManifest.sha256, fixed.studyManifestSha256);
      assert.equal(fixed.deliveryEventId, current.delivery.event.eventId);
      await storedEvidence.prepared(fixed, sourceManifest, copies, requestId);
      if (failPrepared) throw new Error('SyntheticPrepareRollback');
      afterPrepared();
    },
    async transferred(id, observations, wire) {
      if (failObservation) throw new Error('SyntheticObservationFailure');
      await storedEvidence.transferred(id, observations, wire);
    },
    async copiesRemoved(id, copies) { await storedEvidence.copiesRemoved(id, copies); },
  };
  const boundary = { records: port, evidence, source: orthanc.imageSource(), stagingDirectory: staging };
  const server = createServer(async (req, res) => {
    const control = new AbortController(); req.once('aborted', () => control.abort());
    if (interruptFrame) {
      const write = res.write.bind(res);
      // A real socket failure after the first frame's successful write. Let the
      // write continuation observe those bytes before closing the transport.
      res.write = (bytes, callback) => write(bytes, error => {
        callback(error);
        if (!error && bytes.equals(frames[0])) queueMicrotask(() => res.destroy());
      });
    }
    try {
      const response = current;
      const result = await sendOnlineImage(boundary, { manifest: response.manifest, delivery: response.delivery, requestId: response.requestId,
        response: res, signal: control.signal, range: req.headers.range,
        // The response's current access check on the ledger transaction, before any source read.
        async prepare() { countChecks++; if (denyAtPrepare) throw new Error('SyntheticCurrentAccessRefused'); return response.prepared; } });
      handleResult({ result });
    } catch (error) {
      if (!res.headersSent) { res.statusCode = 503; res.end(); } else res.destroy();
      handleResult({ error });
    }
  });
  const endpoint = await listen(server);
  let delivery = null;
  const begin = async (suffix = '', method = 'GET', opts = {}) => {
    countChecks = 0;
    delivery = opts.delivery ?? delivery ?? await openDelivery(port);
    const at = new Date().toISOString(), eventId = randomUUID();
    const target = `/dicom-web/studies/${studyUid}/series/${seriesUid}/instances/${sop}${suffix}`;
    const prepared = E.prepareDelivery(manifest, E.parseImageRequest(method, target), { eventId, deliveryEventId: opts.deliveryEventId ?? delivery.event.eventId,
      cause: opts.cause ?? 'user-view', at, authorization: { studyUid, institution: 'synthetic-hospital', accountGeneration: 1 }, opening: null, provision: provision(at) });
    current = { manifest, delivery, prepared, requestId: randomUUID() }; return eventId;
  };
  const request = async (headers = {}, abort = false) => {
    const pending = new Promise(resolve => { handleResult = resolve; });
    const answer = await new Promise((resolve, reject) => {
      const req = get(endpoint, { headers, method: current.prepared.request.method }, async res => {
        const chunks = [];
        let ended = false, checked = false;
        const finish = () => {
          ended = true;
          if (checked) resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        };
        // Close can arrive while the independent PostgreSQL read is pending.
        // Observe it immediately, but consume no buffered bytes before that check.
        res.on('end', finish); res.on('close', finish); res.on('error', finish);
        try {
        // The independent connection can see the exact representation, named under the delivery's committed
        // ledger event, before the first protected HTTP chunk is consumed.
        if (res.statusCode < 300) {
          const rows = await witness.$queryRaw`SELECT response_manifest AS manifest, delivery_event_id::text AS delivery, request_id
            FROM emr_image.preparation WHERE event_id=${current.prepared.eventId}::uuid`;
          assert.equal(rows.length, 1);
          assert.equal(rows[0].delivery, current.delivery.event.eventId);
          assert.equal(rows[0].request_id, current.requestId);
          assert.equal((await ledger.lookup(current.delivery.event.eventId)).outcome, 'committed');
          const fixed = rows[0].manifest;
          assert.equal(fixed.http.status, res.statusCode);
          assert.equal(fixed.http.range, headers.Range ?? null);
          assert.equal(fixed.request.method, current.prepared.request.method);
          assert.equal(fixed.http.body, fixed.request.method === 'GET');
          for (const [name, value] of Object.entries(fixed.http.headers))
            assert.equal(res.headers[name.toLowerCase()], value);
          assert.equal(fixed.http.plannedBytes, fixed.http.body ? Number(res.headers['content-length']) : 0);
          assert.equal(res.headers['x-kin-image-event'], current.delivery.event.eventId);
          assert.equal(res.headers['x-kin-image-response'], current.prepared.eventId);
          assert.equal(res.headers['x-kin-image-manifest'], fixed.sha256);
        }
        if (ended) {
          for (let chunk = res.read(); chunk !== null; chunk = res.read()) chunks.push(chunk);
          checked = true; finish();
        } else {
          checked = true;
          res.on('data', chunk => { chunks.push(chunk); if (abort) req.destroy(); });
        }
        } catch (error) { res.destroy(); reject(error); }
      });
      clientRequest = req;
      req.on('error', error => abort ? resolve({ status: 0, body: Buffer.alloc(0) }) : reject(error));
    });
    return { answer, ...(await pending) };
  };
  const originalTransaction = db.$transaction.bind(db);
  db.$transaction = async (...args) => {
    const answer = await originalTransaction(...args);
    if (loseCommit && answer?.outcome === 'committed') { loseCommit = false; throw new Error('SyntheticLostCommitResponse'); }
    return answer;
  };
  const judged = (sent) => E.judgeDelivery([{ prepared: current.prepared, observations: sent.result.observations }]).outcome;
  try {
    await db.$connect(); await witness.$connect();
    await begin(); afterPrepared = () => { state.sourceBytes = Buffer.alloc(original.length, 99); };
    const firstDelivery = delivery;
    let sent = await request();
    assert.equal(sent.answer.status, 200); assert.equal(sent.result.terminal, 'transfer-ended');
    assert.equal(sent.result.observationStored, true);
    assert.equal(state.sourceReads, 1); assert.ok(sent.answer.body.includes(original));
    assert.equal(sent.result.copies.every(c => c.state === 'removed'), true);
    assert.equal(countChecks, 1, 'one current access check per response');
    assert.equal(judged(sent), 'complete', 'the bytes are judged on the delivery record\'s receipt');
    afterPrepared = () => {}; state.sourceBytes = original;
    // The one ledger event of the delivery, and no event per response.
    const ledgerRows = async id => witness.$queryRaw`SELECT payload FROM emr_access.access_entry WHERE event_id=${id}`;
    assert.equal((await ledgerRows(delivery.event.eventId)).length, 1);
    assert.equal((await ledgerRows(current.prepared.eventId)).length, 0, 'a response under a delivery is not its own ledger event');

    // A delivery whose record is Module A's local-read branch, names another study record, or is unconfirmed, never
    // opens an image body; a response naming another delivery's record is refused before any source read.
    const v1 = delivery.event, readsBefore = state.sourceReads;
    const foreign = { ...delivery, event: parseAccessEvent({ formatVersion: 2, branch: 'local-read', surface: 'GET studies/:uid/report/versions',
      eventId: v1.eventId, userId: v1.userId, rolesAtTime: v1.rolesAtTime, rightsVersion: 1,
      actingInstitution: v1.actingInstitution, managingInstitution: v1.managingInstitution, occurredAt: v1.occurredAt,
      trustedProxyIp: v1.trustedProxyIp, session: { method: 'session', sessionRef: 'authref:' + randomUUID() },
      cause: 'user-view', executor: 'member', context: v1.context,
      targets: [{ kind: 'report-version', studyId: known(studyUid), recordId: known(sop), versionId: known(manifest.sha256),
        sourcePatientId: known(patient.patientId), sourceInstitution: known('synthetic-hospital'), projectionSha256: hash('synthetic-projection') }],
      action: 'provide-prepared', result: 'prepared', requestId: v1.requestId, auditLinkId: v1.auditLinkId, relatedEventId: null }) };
    for (const broken of [foreign, { ...delivery, receipt: { eventId: randomUUID(), durableAt: delivery.receipt.durableAt } },
      { ...delivery, event: studyEvent(randomUUID(), v1.occurredAt) }]) {
      await begin(); current.delivery = broken;
      sent = await request();
      assert.equal(sent.error?.code, 'ImageEventMismatch');
      assert.equal(sent.answer.status, 503); assert.equal(sent.answer.body.length, 0);
    }
    await begin('', 'GET', { deliveryEventId: randomUUID() });
    sent = await request();
    assert.equal(sent.error?.code, 'ImageEventMismatch');
    assert.equal(sent.answer.status, 503); assert.equal(sent.answer.body.length, 0);
    assert.equal(state.sourceReads, readsBefore, 'no source read before the response was bound to its record');
    assert.equal((await witness.$queryRaw`SELECT event_id FROM emr_image.preparation WHERE event_id=${current.prepared.eventId}::uuid`).length, 0);
    // The same request under the delivery's own record still streams.
    await begin(); sent = await request();
    assert.equal(sent.answer.status, 200); assert.equal(sent.result.terminal, 'transfer-ended');
    assert.ok(sent.answer.body.includes(original));

    await begin(); sent = await request({ Range: 'bytes=4-19' });
    assert.equal(sent.answer.status, 206); assert.deepEqual(sent.answer.body, original.subarray(4, 20));
    assert.equal(sent.answer.headers['content-range'], `bytes 4-19/${original.length}`);
    assert.deepEqual(sent.result.manifest.http.selections, [{ unit: current.prepared.units[0].key, start: 4, end: 20 }]);
    assert.equal(judged(sent), 'incomplete');
    await begin(); sent = await request({ Range: 'bytes=0-7,-8' });
    assert.equal(sent.answer.status, 206); assert.match(sent.answer.headers['content-type'], /^multipart\/byteranges/);
    assert.ok(sent.answer.body.includes(original.subarray(0, 8)));
    await begin(); sent = await request({ Range: `bytes=${original.length}-` });
    assert.equal(sent.answer.status, 416); assert.equal(sent.answer.body.length, 0);

    await begin('/frames/1,2'); sent = await request();
    assert.equal(sent.answer.status, 200);
    for (const bytes of frames) assert.ok(sent.answer.body.includes(bytes));
    assert.deepEqual(sent.result.manifest.representations.map(r => r.frame), [1, 2]);
    await begin('', 'HEAD'); sent = await request();
    assert.equal(sent.answer.body.length, 0);
    assert.equal(judged(sent), 'no-body');
    await begin('/metadata'); sent = await request();
    assert.equal(sent.answer.status, 503);
    assert.equal(sent.answer.body.length, 0, 'an unbound generated representation must not borrow the original digest');
    // A response whose cause differs from its delivery's record is another access, not this one.
    await begin('', 'GET', { cause: 'background-fetch' });
    sent = await request(); assert.equal(sent.answer.status, 503); assert.equal(sent.answer.body.length, 0);

    await begin(); failPrepared = true; sent = await request(); failPrepared = false;
    assert.equal(sent.answer.status, 503); assert.equal(sent.answer.body.length, 0);
    assert.equal((await ledger.lookup(delivery.event.eventId)).outcome, 'committed', 'the delivery record is unchanged by a failed response');
    assert.equal(sent.result, undefined);
    await begin(); denyAtPrepare = true; readsBeforeDeny = state.sourceReads; sent = await request(); denyAtPrepare = false;
    assert.equal(sent.answer.status, 503); assert.equal(sent.answer.body.length, 0);
    assert.equal(state.sourceReads, readsBeforeDeny, 'a refused current access check reads no source body');
    assert.equal((await witness.$queryRaw`SELECT event_id FROM emr_image.preparation WHERE event_id=${current.prepared.eventId}::uuid`).length, 0);
    await begin(); state.sourceBytes = Buffer.alloc(original.length, 99); sent = await request(); state.sourceBytes = original;
    assert.equal(sent.answer.status, 503); assert.equal(sent.answer.body.length, 0);
    const failedCopies = await witness.$queryRaw`SELECT body FROM emr_image.observation WHERE kind='copies' AND event_id=${current.prepared.eventId}::uuid`;
    assert.equal(failedCopies.length, 1, 'a failed preparation still accounts for its temporary copy');
    assert.equal(failedCopies[0].body[0].state, 'removed');
    await begin(); state.headerSyntax = '1.2.840.10008.1.2.4.50'; sent = await request(); state.headerSyntax = ts;
    assert.equal(sent.answer.status, 503); assert.equal(sent.answer.body.length, 0);
    // A lost COMMIT response of the delivery's own transaction is settled from the ledger, never retried as a new record.
    loseCommit = true; const settled = await openDelivery(port); assert.equal(loseCommit, false);
    await begin('', 'GET', { delivery: settled }); sent = await request();
    assert.equal(sent.answer.status, 200); assert.equal(sent.result.observationStored, true);
    await begin(); afterPrepared = () => clientRequest.destroy(); sent = await request({}, true); afterPrepared = () => {};
    assert.equal(sent.result.terminal, 'transfer-aborted');
    assert.equal(sent.result.observations.some(o => o.stage === 'bytes'), false);
    await begin('/frames/1,2'); interruptFrame = true; sent = await request(); interruptFrame = false;
    assert.equal(sent.result.terminal, 'transfer-aborted');
    assert.ok(sent.answer.body.includes(frames[0]), 'first frame reached the HTTP client before interruption');
    assert.equal(sent.answer.body.includes(frames[1]), false);
    assert.ok(sent.result.observations.some(o => o.stage === 'bytes' && o.end > o.start));
    assert.equal(judged(sent), 'incomplete');
    await begin(); failObservation = true; sent = await request(); failObservation = false;
    assert.equal(sent.result.observationStored, false);
    assert.ok(sent.result.observationError);
    assert.deepEqual(await readdir(staging), []);

    // R244-02: every committed preparation above came from the one study manifest. Its exact body is kept once, and
    // each preparation still yields that body, as the audit reader reads it (emr-audit/service.ts); each names a
    // delivery record that the ledger holds.
    const kept = await witness.$queryRaw`SELECT body FROM emr_image.source_manifest`;
    assert.equal(kept.length, 1, 'one kept copy of the study manifest, not one per delivered response');
    assert.deepEqual(kept[0].body, JSON.parse(JSON.stringify(manifest)));
    const sources = await witness.$queryRaw`SELECT p.event_id::text AS response, COALESCE(p.source_manifest, m.body) AS source,
      p.delivery_event_id::text AS delivery FROM emr_image.preparation p LEFT JOIN emr_image.source_manifest m ON m.body_sha256 = p.source_manifest_body`;
    assert.ok(sources.length > 5);
    const records = [firstDelivery.event.eventId, settled.event.eventId];
    for (const row of sources) {
      assert.deepEqual(row.source, JSON.parse(JSON.stringify(manifest)));
      assert.ok(records.includes(row.delivery), `response ${row.response} names record ${row.delivery}, not one of ${records.join(', ')}`);
    }
  } finally {
    await close(server); await close(source);
    await journal.close(); await db.$disconnect(); await witness.$disconnect();
  }
});

test('E image service: one ledger record per requester, session and manifest version, closed after the viewing', async () => {
  const db = new PrismaClient(), witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_E_WITNESS_URL } } });
  const journal = new FailureJournal(db, new FailureSpool(path.join(process.env.KIN_E_SPOOL, 'service')));
  const ledger = new AccessLedgerStore(db, journal), { port, control } = createRecordPort(ledger);
  const { OnlineImageService } = load('emr-image/service');
  const { createBackgroundWorkRegistry } = load('emr-runtime/background-work');
  const { DELIVERY_IDLE_MS } = load('emr-image/delivery');
  const state = { sourceBytes: original, sourceReads: 0, headerSyntax: ts };
  const source = syntheticSource(state);
  process.env.ORTHANC_URL = await listen(source);
  process.env.ORTHANC_USER = 'synthetic'; process.env.ORTHANC_PASS = randomUUID();
  process.env.KIN_EMR_STATE_DIR = path.join(process.env.KIN_E_SPOOL, 'service-state');
  await mkdir(process.env.KIN_EMR_STATE_DIR, { recursive: true });
  const registry = createBackgroundWorkRegistry();
  // Stand-ins for Module A's context and the request facts: the member, session and address each request carries.
  const sessions = new WeakMap();
  const requests = { async facts(request) {
    return { actor: doctor, issuer: doctor.issuer, subject: doctor.subject, roles: ['radiologist'], institution: 'synthetic-hospital', rightsVersion: 1,
      binding: { method: 'session', sessionRef: sessions.get(request) ?? 'authref:session-1' }, ingress: known({ address: '127.0.0.1', source: 'trusted-proxy' }),
      requestId: request.requestId ??= randomUUID() };
  } };
  let currentChecks = 0, refuseCurrent = null;
  const context = {
    async manifest() { return manifest; },
    async current(_tx, request, _manifest, at) {
      currentChecks++;
      if (refuseCurrent) throw refuseCurrent;
      return { actor: { identity: doctor, kind: 'member', roles: ['radiologist'], institutionId: 'synthetic-hospital', signingRegistrationId: null },
        requestId: request.requestId, ip: known({ address: '127.0.0.1', source: 'trusted-proxy' }), accountGeneration: 1, provision: provision(at) };
    },
  };
  const service = new OnlineImageService(port, context, db, new OrthancService(), requests, registry.work);
  const server = createServer((req, res) => {
    req.requestId = randomUUID();
    if (req.headers['x-synthetic-session']) sessions.set(req, req.headers['x-synthetic-session']);
    service.send(req, res, decodeURIComponent(new URL(req.url, 'http://x').searchParams.get('target')))
      .catch(error => { if (!res.headersSent) { res.statusCode = error?.status ?? 503; res.end(); } else res.destroy(); });
  });
  const endpoint = await listen(server);
  const frame = (n, headers = {}) => fetch(`${endpoint}/?target=${encodeURIComponent(`/dicom-web/studies/${studyUid}/series/${seriesUid}/instances/${sop}/frames/${n}`)}`, { headers });
  const entries = async where => (await witness.$queryRawUnsafe(`SELECT event_id, payload FROM emr_access.access_entry e WHERE ${where} ORDER BY sequence`))
    .map(row => ({ eventId: row.event_id, ...JSON.parse(row.payload) }));
  try {
    await db.$connect(); await witness.$connect();
    // A burst of frames of one viewing: one provide-prepared record, every response naming it, no event per frame.
    const answers = await Promise.all([1, 2, 1, 2, 1, 2].map(n => frame(n)));
    assert.ok(answers.every(a => a.status === 200), answers.map(a => a.status).join(','));
    const bodies = await Promise.all(answers.map(a => a.arrayBuffer()));
    bodies.forEach((body, i) => assert.ok(Buffer.from(body).includes(frames[[1, 2, 1, 2, 1, 2][i] - 1])));
    const deliveryId = answers[0].headers.get('x-kin-image-event');
    assert.ok(answers.every(a => a.headers.get('x-kin-image-event') === deliveryId), 'one record for the burst');
    const responseIds = answers.map(a => a.headers.get('x-kin-image-response'));
    assert.equal(new Set(responseIds).size, 6);
    assert.equal(currentChecks, 2 + 6, 'two checks opening the record, one per response before its first byte');
    const provided = await entries(`event_id = '${deliveryId}'`);
    assert.equal(provided.length, 1);
    assert.deepEqual([provided[0].action, provided[0].result, provided[0].surface, provided[0].cause], ['provide-prepared', 'prepared', 'GET images/dicom-web', 'background-fetch']);
    assert.deepEqual(provided[0].targets.map(t => [t.kind, t.studyId.value, t.recordId.value, t.versionId.value, t.patientLinkSnapshot.value.patientId]),
      [['image', studyUid, studyUid, manifest.sha256, patient.patientId]]);
    assert.deepEqual(provided[0].userId.value, doctor);
    assert.equal((await entries(`event_id = ANY(ARRAY[${responseIds.map(id => `'${id}'`).join(',')}])`)).length, 0);
    const rows = await witness.$queryRaw`SELECT event_id::text, delivery_event_id::text AS delivery, request_id FROM emr_image.preparation
      WHERE delivery_event_id=${deliveryId}::uuid ORDER BY recorded_at`;
    assert.deepEqual(rows.map(r => r.event_id).sort(), [...responseIds].sort());
    assert.ok(rows.every(r => r.delivery === deliveryId && /^[0-9a-f-]{36}$/.test(r.request_id)));
    const transports = await witness.$queryRaw`SELECT event_id::text, body->'wire' AS wire FROM emr_image.observation WHERE kind='transport'
      AND event_id=ANY(${responseIds}::uuid[])`;
    assert.equal(transports.length, 6);
    assert.ok(transports.every(t => t.wire.terminal === 'transfer-ended' && t.wire.bytesWritten === t.wire.plannedBytes));
    assert.equal((await entries(`payload::jsonb->>'relatedEventId' = '${deliveryId}'`)).length, 0, 'the record stays open for the next frames');
    // Another session of the same member is another record.
    const other = await frame(1, { 'x-synthetic-session': 'authref:session-2' });
    assert.equal(other.status, 200); await other.arrayBuffer();
    const otherId = other.headers.get('x-kin-image-event');
    assert.notEqual(otherId, deliveryId);
    // After the idle period each record is closed by one terminal event that follows what E observed.
    await sleep(DELIVERY_IDLE_MS + 1500);
    for (const id of [deliveryId, otherId]) {
      const [opened] = await entries(`event_id = '${id}'`);
      const closed = await entries(`payload::jsonb->>'relatedEventId' = '${id}'`);
      assert.deepEqual(closed.map(c => [c.action, c.result]), [['transfer-ended', 'succeeded']], id);
      assert.deepEqual(closed[0].targets, opened.targets, 'the terminal event keeps the prepared record\'s targets');
      assert.deepEqual([closed[0].requestId, closed[0].userId], [opened.requestId, opened.userId]);
    }
    // A changed current fact refuses the response before any source read and retires the record; the next frame of
    // the viewing opens a new one. The retired record closes as aborted: nothing of it was transferred.
    const readsBefore = state.sourceReads;
    const fresh = await frame(1); assert.equal(fresh.status, 200); await fresh.arrayBuffer();
    const freshId = fresh.headers.get('x-kin-image-event');
    assert.notEqual(freshId, deliveryId, 'a closed record is not reopened');
    refuseCurrent = Object.assign(new Error('synthetic rights change'), { code: 'SyntheticRightsChanged' });
    const refused = await frame(2); assert.equal(refused.status, 503); await refused.arrayBuffer();
    assert.equal(state.sourceReads, readsBefore + 1, 'the refused response read no source body');
    refuseCurrent = null;
    const next = await frame(2); assert.equal(next.status, 200); await next.arrayBuffer();
    assert.notEqual(next.headers.get('x-kin-image-event'), freshId, 'the record a refused response retired takes no later frame');
    // Shutdown closes the open record now, before the ledger drains.
    registry.quiesce();
    await service.beforeApplicationShutdown();
    control.close();
    await Promise.race([control.drained(), sleep(5000).then(() => { throw new Error('ledger work left open by a delivery'); })]);
    const lastId = next.headers.get('x-kin-image-event');
    assert.deepEqual((await entries(`payload::jsonb->>'relatedEventId' = '${lastId}'`)).map(c => c.action), ['transfer-ended']);
    await sleep(DELIVERY_IDLE_MS + 1500);
    assert.deepEqual((await entries(`payload::jsonb->>'relatedEventId' = '${freshId}'`)).map(c => [c.action, c.result]), [['transfer-ended', 'succeeded']],
      'the retired record transferred its one frame before the refusal');
  } finally {
    await close(server); await close(source);
    await journal.close(); await db.$disconnect(); await witness.$disconnect();
  }
});

test('E registered Connect GET/HEAD refuses unavailable production context without image bytes', async () => {
  const { NestFactory } = require(path.join(api, 'node_modules/@nestjs/core'));
  const { AppModule } = load('app.module');
  const { EmrRuntime } = load('emr-runtime/application');
  const previous = { ...process.env };
  Object.assign(process.env, { AUTH_REQUIRED: 'false', KIN_EMR_STATE_DIR: process.env.KIN_E_SPOOL,
    KC_ADMIN_URL: 'http://127.0.0.1:9', KC_ISSUER: 'http://127.0.0.1:9/realms/synthetic',
    KC_JWKS_URL: 'http://127.0.0.1:9/realms/synthetic/certs', PUBLIC_ORIGIN: 'http://127.0.0.1' });
  const runtime = new EmrRuntime(process.env.DATABASE_URL, path.join(process.env.KIN_E_SPOOL, 'route-outage'));
  let app;
  try {
    await runtime.start();
    app = await NestFactory.create(AppModule.withLedger(runtime), { logger: false, abortOnError: false });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    const endpoint = await app.getUrl();
    const target = '/dicom-web/studies/2.25.701/series/2.25.701.1/instances/2.25.701.1.1';
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(endpoint + '/api/images/dicom-web?target=' + encodeURIComponent(target), { method });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('x-kin-image-event'), null);
      if (method === 'HEAD') assert.equal((await response.arrayBuffer()).byteLength, 0);
      else assert.equal((await response.json()).code, 'IMAGE_CONTEXT_UNAVAILABLE');
    }
    const malformed = await fetch(endpoint + '/api/images/dicom-web?target=' + encodeURIComponent('/instances/anything/file'));
    assert.equal(malformed.status, 400);
  } finally {
    if (app) await app.close(); else await runtime.stop(Date.now() + 15000);
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
