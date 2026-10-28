'use strict';
// E-01/02/03 -> wrong representation, bytes before COMMIT, false delivery.
// Actual B2 PostgreSQL transactions and node HTTP sockets. The Orthanc protocol
// fixture is synthetic; this does not claim pinned OHIF/native decoder coverage.
//
// A response is provided under its study delivery's access record, the pair every image route shares
// (image-delivery-record.ts, D1877): one B2 provide-prepared event per member session and study, durable before the
// first response of the delivery is prepared; each response keeps its exact representation, transport and copy facts in
// E's rows naming that event; the delivery is closed by one terminal event. A HEAD and a description are answered
// under no record and keep no row. The first case drives sendOnlineImage under a durable record on the real ledger;
// the second drives the service with the shared recorder against the real ledger and checks the ledger's events.
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
const studyResource = '66666666-77777777-88888888-99999999-aaaaaaaa';
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

/** A synthetic Orthanc answering the manifest's one object; `state` lets a case swap bytes, the header syntax or the
 * object's current PatientID (a patient correction that keeps the UIDs and the pixels), and add a second patient's
 * study resource under the same Study UID (`split`: the object itself unchanged). */
function syntheticSource(state) {
  return createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url === '/tools/lookup') return json(body.trim() === studyUid ? [{ Type: 'Study', ID: studyResource }] : [{ Type: 'Instance', ID: objectId }]);
    if (req.url === `/studies/${studyResource}`) return json({ ID: studyResource, LastUpdate: '20261028T120000' });
    if (req.url.startsWith('/dicom-web/studies?StudyInstanceUID=')) {
      state.studyReads = (state.studyReads ?? 0) + 1;
      const row = id => ({ '0020000D': { vr: 'UI', Value: [studyUid] }, '00100020': { vr: 'LO', Value: [id] }, '00080080': { vr: 'LO', Value: ['synthetic-hospital'] } });
      return json(state.split ? [row(patient.patientId), row('SYNTHETIC-SECOND')] : [row(state.patientId ?? patient.patientId)]);
    }
    if (req.url.endsWith('/simplified-tags')) return json({ StudyInstanceUID: studyUid, SeriesInstanceUID: seriesUid,
      SOPInstanceUID: sop, SOPClassUID: manifest.objects[0].sopClassUid, NumberOfFrames: '2', PatientID: state.patientId ?? patient.patientId });
    if (req.url.endsWith('/header')) return json({ '0002,0010': { Value: state.headerSyntax } });
    if (req.url.endsWith('/file')) { state.sourceReads++; res.end(state.sourceBytes); return; }
    const frame = /\/frames\/(\d+)\/raw$/.exec(req.url);
    if (frame && frames[Number(frame[1])]) { state.sourceReads++; res.end(frames[Number(frame[1])]); return; }
    if (req.url.endsWith('/metadata')) return json([{ '0020000D': { vr: 'UI', Value: [studyUid] } }]);
    res.writeHead(404); res.end();
  });
}

/** A durable provide-prepared image record of the study on the real ledger: admit, commit, confirm. */
async function openDelivery(port, cause = 'user-view') {
  const work = port.begin();
  try {
    const at = new Date().toISOString(), eventId = randomUUID();
    const event = studyEvent(eventId, at, cause);
    const operation = await work.admit(event, undefined, { operationId: eventId, attemptId: eventId });
    const result = await work.transaction(operation, async () => ({ kind: 'emr-image', id: eventId, version: manifest.sha256 }));
    assert.equal(result.outcome, 'committed');
    const receipt = await work.confirm({ provisional: true, operationId: operation.operationId, eventId });
    // The delivery the service's lease hands the stream: bound to this manifest (image-delivery-record.ts).
    return { event, receipt, manifestSha256: manifest.sha256 };
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
    async transferred(link, observations, wire) {
      if (failObservation) throw new Error('SyntheticObservationFailure');
      await storedEvidence.transferred(link, observations, wire);
    },
    async copiesRemoved(link, copies) { await storedEvidence.copiesRemoved(link, copies); },
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
  // opts.delivery: the record the response is provided under; null answers it under none, as the service does for a HEAD.
  const begin = async (suffix = '', method = 'GET', opts = {}) => {
    countChecks = 0;
    delivery = opts.delivery ?? delivery ?? await openDelivery(port);
    const record = opts.delivery === null ? null : delivery;
    const at = new Date().toISOString(), eventId = randomUUID();
    const target = `/dicom-web/studies/${studyUid}/series/${seriesUid}/instances/${sop}${suffix}`;
    const deliveryEventId = opts.deliveryEventId ?? record?.event.eventId;
    const prepared = E.prepareDelivery(manifest, E.parseImageRequest(method, target), { eventId, ...(deliveryEventId ? { deliveryEventId } : {}),
      cause: opts.cause ?? 'user-view', at, authorization: { studyUid, institution: 'synthetic-hospital', accountGeneration: 1 }, opening: null, provision: provision(at) });
    current = { manifest, delivery: record, prepared, requestId: randomUUID() }; return eventId;
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
        if (res.statusCode < 300 && current.delivery) {
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
    // A HEAD is answered under no record: the same headers from the same checked source, no body, no row, no copy.
    const readsBeforeHead = state.sourceReads;
    const headId = await begin('', 'HEAD', { delivery: null }); sent = await request();
    assert.deepEqual([sent.answer.status, sent.answer.body.length], [200, 0]);
    assert.ok(Number(sent.answer.headers['content-length']) > original.length, 'the multipart length of the object it describes');
    assert.deepEqual(['x-kin-image-event', 'x-kin-image-response', 'x-kin-image-manifest'].map(name => sent.answer.headers[name]), [undefined, undefined, undefined]);
    assert.equal(state.sourceReads, readsBeforeHead + 1, 'the HEAD read and checked its source');
    assert.deepEqual(sent.result.copies, [], 'and kept no staging copy');
    assert.equal((await witness.$queryRaw`SELECT event_id FROM emr_image.preparation WHERE event_id=${headId}::uuid`).length, 0);
    assert.equal((await witness.$queryRaw`SELECT event_id FROM emr_image.observation WHERE event_id=${headId}::uuid`).length, 0);
    // Under a record, a HEAD or a description would be counted as a delivery: refused before any source read; a GET
    // of an image under no record would send bytes without one: refused too.
    for (const [suffix, method, opts, code] of [['', 'HEAD', {}, 'ImageNoDeliveryUnderRecord'], ['/metadata', 'GET', {}, 'ImageNoDeliveryUnderRecord'],
      ['', 'GET', { delivery: null }, 'ImageDeliveryRecordRequired']]) {
      const reads = state.sourceReads;
      await begin(suffix, method, opts); sent = await request();
      assert.equal(sent.error?.code, code, `${method} ${suffix}`);
      assert.deepEqual([sent.answer.status, sent.answer.body.length, state.sourceReads], [503, 0, reads]);
    }
    // R244-GPT-FIX7-01: a record bound to another manifest version, or naming another patient than this manifest's, is
    // not the record of these bytes: refused before any source read.
    const otherPatient = { ...delivery, event: { ...delivery.event, targets: delivery.event.targets.map(t => ({ ...t,
      patientLinkSnapshot: known({ ...patient, patientId: 'SYNTHETIC-OTHER', linkId: 'synthetic-other-link' }) })) } };
    const bound = delivery;
    for (const other of [{ ...delivery, manifestSha256: hash('another manifest') }, otherPatient]) {
      const reads = state.sourceReads;
      await begin('', 'GET', { delivery: other }); sent = await request();
      assert.equal(sent.error?.code, 'ImageEventMismatch');
      assert.deepEqual([sent.answer.status, sent.answer.body.length, state.sourceReads], [503, 0, reads]);
    }
    delivery = bound;
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
    const failedCopies = await witness.$queryRaw`SELECT body, delivery_event_id::text AS delivery, request_id, retained_after
      FROM emr_image.observation WHERE kind='copies' AND event_id=${current.prepared.eventId}::uuid`;
    assert.equal(failedCopies.length, 1, 'a failed preparation still accounts for its temporary copy');
    assert.equal(failedCopies[0].body[0].state, 'removed');
    // R244-GPT-03: there is no preparation row to follow, so the copy observation names its record and request itself.
    assert.deepEqual([failedCopies[0].delivery, failedCopies[0].request_id, failedCopies[0].retained_after], [delivery.event.eventId, current.requestId, null]);
    assert.equal((await witness.$queryRaw`SELECT event_id FROM emr_image.preparation WHERE event_id=${current.prepared.eventId}::uuid`).length, 0);
    await begin(); state.headerSyntax = '1.2.840.10008.1.2.4.50'; sent = await request(); state.headerSyntax = ts;
    assert.equal(sent.answer.status, 503); assert.equal(sent.answer.body.length, 0);
    // R244-GPT-01: the object's current PatientID is not the manifest's (same UIDs, same pixels): refused before the
    // body is read, no preparation row, the temporary copy accounted for under the record.
    await begin(); state.patientId = 'SYNTHETIC-OTHER'; const readsBeforePatient = state.sourceReads; sent = await request(); state.patientId = undefined;
    assert.equal(sent.answer.status, 503); assert.equal(sent.answer.body.length, 0);
    assert.equal(sent.error?.status, 409, 'the source refuses the changed patient as a changed original');
    assert.equal(state.sourceReads, readsBeforePatient, 'no body read for an object of another patient');
    assert.equal((await witness.$queryRaw`SELECT event_id FROM emr_image.preparation WHERE event_id=${current.prepared.eventId}::uuid`).length, 0);
    assert.deepEqual(await witness.$queryRaw`SELECT delivery_event_id::text AS delivery FROM emr_image.observation WHERE event_id=${current.prepared.eventId}::uuid`,
      [{ delivery: delivery.event.eventId }]);
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
    // The refused row is returned to the caller for its delivery to retain (R244-GPT-02), with the facts intact.
    assert.equal(sent.result.unstored.length, 1);
    assert.deepEqual([sent.result.unstored[0].kind, sent.result.unstored[0].link],
      ['transport', { eventId: current.prepared.eventId, deliveryEventId: delivery.event.eventId, requestId: current.requestId }]);
    assert.equal(sent.result.unstored[0].body.wire.terminal, 'transfer-ended');
    assert.equal(sent.result.unstored[0].body.observations, sent.result.observations);
    assert.deepEqual(await readdir(staging), []);

    // R244-02: every committed preparation above came from the one study manifest. Its exact body is kept once, and
    // each preparation still yields that body through the digest it names (the audit reader returns each named body once
    // per page, emr-audit/service.ts); each names a delivery record that the ledger holds.
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

test('E image service: the shared study delivery record per member session and study, closed after the viewing', async () => {
  const db = new PrismaClient(), witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_E_WITNESS_URL } } });
  const journal = new FailureJournal(db, new FailureSpool(path.join(process.env.KIN_E_SPOOL, 'service')));
  const ledger = new AccessLedgerStore(db, journal), { port, control } = createRecordPort(ledger);
  const { OnlineImageService, ONLINE_IMAGE_SURFACE } = load('emr-image/service');
  const { StudyImageDeliveryRecorder } = load('image-delivery-record');
  const { createBackgroundWorkRegistry } = load('emr-runtime/background-work');
  const IDLE_MS = 1500;
  const state = { sourceBytes: original, sourceReads: 0, headerSyntax: ts };
  const source = syntheticSource(state);
  process.env.ORTHANC_URL = await listen(source);
  process.env.ORTHANC_USER = 'synthetic'; process.env.ORTHANC_PASS = randomUUID();
  process.env.KIN_EMR_STATE_DIR = path.join(process.env.KIN_E_SPOOL, 'service-state');
  await mkdir(process.env.KIN_EMR_STATE_DIR, { recursive: true });
  const registry = createBackgroundWorkRegistry();
  // Stand-ins for Module A's context and the request facts: the member, session and address each request carries.
  const sessions = new WeakMap();
  const binding = request => ({ method: 'session', sessionRef: sessions.get(request) ?? 'authref:session-1' });
  const requests = {
    read: request => ({ issuer: doctor.issuer, subject: doctor.subject, binding: binding(request) }),
    async facts(request) {
      return { actor: doctor, issuer: doctor.issuer, subject: doctor.subject, roles: ['radiologist'], institution: 'synthetic-hospital', rightsVersion: 1,
        binding: binding(request), ingress: known({ address: '127.0.0.1', source: 'trusted-proxy' }), requestId: request.requestId ??= randomUUID() };
    },
  };
  let rechecks = 0, refuseCurrent = null, manifestBuilds = 0, lastRefusal = null;
  const facts = (request, at) => {
    if (refuseCurrent) throw refuseCurrent;
    return { actor: { identity: doctor, kind: 'member', roles: ['radiologist'], institutionId: 'synthetic-hospital', signingRegistrationId: null },
      requestId: request.requestId, ip: known({ address: '127.0.0.1', source: 'trusted-proxy' }), accountGeneration: 1, provision: provision(at) };
  };
  // The delivery's record reads D's current study once, when it opens; each response re-checks identity, scope, access
  // and provision without the archive read.
  const clinical = { async facts(_tx, request) { return facts(request, new Date().toISOString()); },
    async study() { return { studyId: studyUid, managingInstitutionId: 'synthetic-hospital', teleInstitutionId: null, patient }; } };
  const context = {
    async manifest() { manifestBuilds++; return manifest; },
    async recheck(_tx, request, _manifest, at) { rechecks++; return facts(request, at); },
  };
  // The application connection E writes its rows on: a case makes it refuse the next transport-observation insert, as
  // a pool failure would, while the ledger's own transactions are untouched. (The kind is the fourth parameter of the
  // observation insert; a response's rows are written after its body ended, so a case waits for the previous
  // response's rows before arming this.)
  let refuseObservationWrites = 0, refuseObservationCode = 'SyntheticAppPoolWriteFailure';
  const applicationExecuteRaw = db.$executeRaw.bind(db);
  db.$executeRaw = (parts, ...values) => {
    if (refuseObservationWrites > 0 && parts.join('?').includes('INSERT INTO emr_image.observation') && values[3] === 'transport') {
      refuseObservationWrites--;
      return Promise.reject(Object.assign(new Error('synthetic application pool failure'), { code: refuseObservationCode }));
    }
    return applicationExecuteRaw(parts, ...values);
  };
  const rowsOf = async (responseId, count) => {
    for (let i = 0; i < 100; i++) {
      const rows = await witness.$queryRaw`SELECT kind FROM emr_image.observation WHERE event_id=${responseId}::uuid`;
      if (rows.length >= count) return rows;
      await sleep(50);
    }
    throw new Error(`response ${responseId} did not reach ${count} observation rows`);
  };
  // The check pool: the product's own bounded client over the same synthetic database URL.
  const { ImageCheckDatabase } = load('emr-image/check-db');
  const checks = new ImageCheckDatabase();
  const orthanc = new OrthancService();
  const recorder = new StudyImageDeliveryRecorder(port, requests, clinical, registry.work, orthanc, IDLE_MS);
  const service = new OnlineImageService(context, db, orthanc, requests, checks, recorder);
  const server = createServer((req, res) => {
    req.requestId = randomUUID();
    if (req.headers['x-synthetic-session']) sessions.set(req, req.headers['x-synthetic-session']);
    service.send(req, res, decodeURIComponent(new URL(req.url, 'http://x').searchParams.get('target')))
      .catch(error => { lastRefusal = error; if (!res.headersSent) { res.statusCode = error?.status ?? 503; res.end(); } else res.destroy(); });
  });
  const endpoint = await listen(server);
  const frame = (n, headers = {}, method = 'GET') => fetch(`${endpoint}/?target=${encodeURIComponent(`/dicom-web/studies/${studyUid}/series/${seriesUid}/instances/${sop}/frames/${n}`)}`, { headers, method });
  const entries = async where => (await witness.$queryRawUnsafe(`SELECT event_id, payload FROM emr_access.access_entry e WHERE ${where} ORDER BY sequence`))
    .map(row => ({ eventId: row.event_id, ...JSON.parse(row.payload) }));
  const closings = id => entries(`payload::jsonb->>'relatedEventId' = '${id}'`);
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
    assert.equal(rechecks, 6, 'one re-check per response before its first byte');
    const provided = await entries(`event_id = '${deliveryId}'`);
    assert.equal(provided.length, 1);
    assert.deepEqual([provided[0].action, provided[0].result, provided[0].surface, provided[0].cause], ['provide-prepared', 'prepared', ONLINE_IMAGE_SURFACE, 'background-fetch']);
    assert.deepEqual(provided[0].targets.map(t => [t.kind, t.studyId.value, t.recordId.value, t.versionId.value, t.patientLinkSnapshot.value.patientId]),
      [['image', studyUid, studyUid, `orthanc-study:${studyResource}@20261028T120000`, patient.patientId]], 'the shared record names the study at the archive\'s revision');
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
    assert.equal((await closings(deliveryId)).length, 0, 'the record stays open for the next frames');
    // Another session of the same member is another record; a HEAD of a third session is no delivery at all.
    const other = await frame(1, { 'x-synthetic-session': 'authref:session-2' });
    assert.equal(other.status, 200); await other.arrayBuffer();
    const otherId = other.headers.get('x-kin-image-event');
    assert.notEqual(otherId, deliveryId);
    const before = (await entries('TRUE')).length;
    const head = await frame(1, { 'x-synthetic-session': 'authref:session-3' }, 'HEAD');
    assert.deepEqual([head.status, (await head.arrayBuffer()).byteLength, head.headers.get('x-kin-image-event')], [200, 0, null]);
    // After the idle period each record is closed by one terminal event; the HEAD left none.
    await sleep(IDLE_MS + 1500);
    for (const id of [deliveryId, otherId]) {
      const [opened] = await entries(`event_id = '${id}'`);
      const closed = await closings(id);
      assert.deepEqual(closed.map(c => [c.action, c.result]), [['transfer-ended', 'succeeded']], id);
      assert.deepEqual(closed[0].targets, opened.targets, 'the terminal event keeps the prepared record\'s targets');
      assert.deepEqual([closed[0].requestId, closed[0].userId], [opened.requestId, opened.userId]);
    }
    assert.equal((await entries('TRUE')).length, before + 2, 'the two terminals and nothing for the HEAD');
    // A changed current fact refuses the response before any source read; the viewing's record stays the one the next
    // frame joins, and it ends as provided: its other response was served.
    const readsBefore = state.sourceReads;
    const fresh = await frame(1); assert.equal(fresh.status, 200); await fresh.arrayBuffer();
    const freshId = fresh.headers.get('x-kin-image-event');
    assert.notEqual(freshId, deliveryId, 'a closed record is not reopened');
    refuseCurrent = Object.assign(new Error('synthetic rights change'), { code: 'SyntheticRightsChanged' });
    const refused = await frame(2); assert.equal(refused.status, 503); await refused.arrayBuffer();
    assert.equal(state.sourceReads, readsBefore + 1, 'the refused response read no source body');
    refuseCurrent = null;
    const next = await frame(2); assert.equal(next.status, 200); await next.arrayBuffer();
    assert.equal(next.headers.get('x-kin-image-event'), freshId, 'the session\'s next frame joins its open record');
    // R244-GPT-01: a patient correction in the archive (same UIDs and pixels, another PatientID) between two frames of
    // one record: the response is refused before any body read, serves no bytes, and the kept manifest is forgotten so
    // the next request rebuilds it from the current study. The record of the forgotten manifest ends with it, as what it
    // served (R244-GPT-FIX7-01); the rebuilt manifest's bytes are under a record of their own.
    const closedAs = async id => {
      for (let i = 0; i < 100 && !(await closings(id)).length; i++) await sleep(50);
      return (await closings(id)).map(c => [c.action, c.result]);
    };
    const buildsBefore = manifestBuilds, readsBeforeCorrection = state.sourceReads;
    state.patientId = 'SYNTHETIC-OTHER';
    const corrected = await frame(1); assert.equal(corrected.status, 409); assert.equal((await corrected.arrayBuffer()).byteLength, 0);
    assert.equal(corrected.headers.get('x-kin-image-response'), null, 'no response row was prepared for another patient\'s object');
    assert.equal(state.sourceReads, readsBeforeCorrection, 'the body of another patient\'s object is not read');
    assert.deepEqual(await closedAs(freshId), [['transfer-ended', 'succeeded']], 'the record of the forgotten manifest is closed with it');
    state.patientId = undefined;
    const rebuilt = await frame(1); assert.equal(rebuilt.status, 200); await rebuilt.arrayBuffer();
    assert.equal(manifestBuilds, buildsBefore + 1, 'the manifest was forgotten and rebuilt after the correction');
    const rebuiltId = rebuilt.headers.get('x-kin-image-event');
    assert.notEqual(rebuiltId, freshId);
    await rowsOf(rebuilt.headers.get('x-kin-image-response'), 2);
    // R244-GPT-01 (split UID): a second patient's resource arrives under the same Study UID between two frames while
    // the selected object, its patient and its pixels are unchanged. The study's current identity is read for the
    // response and the product's own refusal answers (STUDY_IDENTITY_UNRESOLVED, as D's current-study read), before
    // any body read; the kept manifest is forgotten, and its record closed.
    const buildsBeforeSplit = manifestBuilds, readsBeforeSplit = state.sourceReads, studyReadsBefore = state.studyReads ?? 0;
    state.split = true;
    const split = await frame(2); assert.equal(split.status, 409); assert.equal((await split.arrayBuffer()).byteLength, 0);
    assert.equal(lastRefusal?.getResponse?.()?.code, 'STUDY_IDENTITY_UNRESOLVED', 'the product\'s own refusal of an unresolved study identity');
    assert.equal(split.headers.get('x-kin-image-response'), null, 'no response row was prepared under the unresolved study');
    assert.equal(state.sourceReads, readsBeforeSplit, 'no body read while the study names two patients');
    assert.ok((state.studyReads ?? 0) > studyReadsBefore, 'the study identity was read for the response');
    assert.deepEqual(await closedAs(rebuiltId), [['transfer-ended', 'succeeded']]);
    state.split = false;
    const afterSplit = await frame(2); assert.equal(afterSplit.status, 200); await afterSplit.arrayBuffer();
    assert.equal(manifestBuilds, buildsBeforeSplit + 1, 'the manifest was forgotten and rebuilt after the split');
    const currentId = afterSplit.headers.get('x-kin-image-event');
    await rowsOf(afterSplit.headers.get('x-kin-image-response'), 2);
    // R244-GPT-02: the application connection refuses a response's transport row. The response ended all the same
    // (HTTP 200, every byte); its facts are written on a ledger transaction of their own after the response, naming the
    // record and the first failure, while the record stays open.
    refuseObservationWrites = 1;
    const late = await frame(2); assert.equal(late.status, 200); assert.ok(Buffer.from(await late.arrayBuffer()).includes(frames[1]));
    assert.equal(refuseObservationWrites, 0, 'the synthetic pool failure was consumed by the transport write');
    const lateResponse = late.headers.get('x-kin-image-response');
    assert.equal(late.headers.get('x-kin-image-event'), currentId);
    let retained = [];
    for (let i = 0; i < 100 && !retained.length; i++) {
      retained = await witness.$queryRaw`SELECT delivery_event_id::text AS delivery, request_id, retained_after, body->'wire' AS wire
        FROM emr_image.observation WHERE event_id=${lateResponse}::uuid AND kind='transport'`;
      if (!retained.length) await sleep(50);
    }
    assert.equal(retained.length, 1, 'the refused transport row was retained after the response');
    assert.deepEqual([retained[0].delivery, retained[0].retained_after], [currentId, 'SyntheticAppPoolWriteFailure']);
    assert.deepEqual([retained[0].wire.terminal, retained[0].wire.bytesWritten === retained[0].wire.plannedBytes], ['transfer-ended', true]);
    // R244-GPT-FIX7-02 on the real ledger: the ledger refuses that retention too (a synthetic trigger refuses the row this
    // case's failure names). The delivery owes the row: while it cannot be written there is no closing event - each
    // closing offer is its admitted operation's rollback, journaled against its own event - and the closing that commits
    // carries the row on its own transaction.
    await witness.$executeRawUnsafe(`CREATE FUNCTION public.synthetic_refuse_retention() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'SyntheticLedgerRefusal'; END $$`);
    await witness.$executeRawUnsafe(`CREATE TRIGGER synthetic_refuse_retention BEFORE INSERT ON emr_image.observation FOR EACH ROW
      WHEN (NEW.retained_after = 'SyntheticLedgerRefusal') EXECUTE FUNCTION public.synthetic_refuse_retention()`);
    const [{ since }] = await witness.$queryRaw`SELECT clock_timestamp() AS since`;
    refuseObservationCode = 'SyntheticLedgerRefusal'; refuseObservationWrites = 1;
    const held = await frame(1); assert.equal(held.status, 200); await held.arrayBuffer();
    const heldId = held.headers.get('x-kin-image-event'), heldResponse = held.headers.get('x-kin-image-response');
    const failures = () => witness.$queryRaw`SELECT cause, event_id, operation_id::text FROM emr_access.failure_entry WHERE occurred_at >= ${since} ORDER BY occurred_at`;
    let journaled = [];
    for (let i = 0; i < 200 && !journaled.some(f => f.operation_id); i++) { journaled = await failures(); if (!journaled.some(f => f.operation_id)) await sleep(50); }
    assert.ok(journaled.some(f => f.event_id === heldId && f.operation_id === null && f.cause === 'business-rollback'), 'the response\'s own offer: journaled against the record');
    const closingFailures = journaled.filter(f => f.operation_id);
    assert.ok(closingFailures.length && closingFailures.every(f => f.cause === 'business-rollback' && f.event_id !== heldId), JSON.stringify(journaled));
    assert.deepEqual(await closings(heldId), [], 'no closing event while the row it covers is refused');
    assert.equal((await witness.$queryRaw`SELECT 1 FROM emr_image.observation WHERE event_id=${heldResponse}::uuid AND kind='transport'`).length, 0);
    await witness.$executeRawUnsafe('DROP TRIGGER synthetic_refuse_retention ON emr_image.observation');
    await witness.$executeRawUnsafe('DROP FUNCTION public.synthetic_refuse_retention()');
    assert.deepEqual(await closedAs(heldId), [['transfer-ended', 'succeeded']], 'the next closing offer commits with the row');
    const [closing] = await closings(heldId);
    assert.ok(!closingFailures.some(f => f.event_id === closing.eventId), 'a refused closing event is never reused');
    const heldRow = await witness.$queryRaw`SELECT delivery_event_id::text AS delivery, retained_after FROM emr_image.observation
      WHERE event_id=${heldResponse}::uuid AND kind='transport'`;
    assert.deepEqual(heldRow.map(r => [r.delivery, r.retained_after]), [[heldId, 'SyntheticLedgerRefusal']]);
    // Shutdown closes whatever is still open, before the ledger drains.
    await recorder.beforeApplicationShutdown();
    registry.quiesce();
    control.close();
    await Promise.race([control.drained(), sleep(5000).then(() => { throw new Error('ledger work left open by a delivery'); })]);
    assert.deepEqual(await closedAs(currentId), [['transfer-ended', 'succeeded']],
      'the viewing\'s record ends as provided: a refused response does not abort it');
  } finally {
    await close(server); await close(source);
    await journal.close(); await checks.$disconnect(); await db.$disconnect(); await witness.$disconnect();
  }
});

// The production context reads current identity only from a guard-captured member admission. With
// authentication off there is none: the registered route refuses before any archive read, with its code.
test('E registered Connect GET/HEAD refuses a request without a member admission, without image bytes', async () => {
  const { NestFactory } = require(path.join(api, 'node_modules/@nestjs/core'));
  const { AppModule } = load('app.module');
  const { EmrRuntime } = load('emr-runtime/application');
  const previous = { ...process.env };
  // AppModule's own start-up work may reach the archive; only a read naming the requested study is the route's.
  const studyUid = '2.25.701', studyReads = [];
  const archive = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url.includes(studyUid) || body.includes(studyUid)) studyReads.push(req.method + ' ' + req.url);
    res.statusCode = 404; res.end();
  });
  await new Promise(resolve => archive.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, { AUTH_REQUIRED: 'false', KIN_EMR_STATE_DIR: process.env.KIN_E_SPOOL,
    ORTHANC_URL: 'http://127.0.0.1:' + archive.address().port, ORTHANC_USER: 'synthetic', ORTHANC_PASS: 'synthetic',
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
      else assert.equal((await response.json()).code, 'ImageRequestContextUnavailable');
    }
    const malformed = await fetch(endpoint + '/api/images/dicom-web?target=' + encodeURIComponent('/instances/anything/file'));
    assert.equal(malformed.status, 400);
    assert.deepEqual(studyReads, [], 'no archive read of the study happens before a current member is known');
  } finally {
    await close(archive);
    if (app) await app.close(); else await runtime.stop(Date.now() + 15000);
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
