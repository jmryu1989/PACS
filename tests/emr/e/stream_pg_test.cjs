'use strict';
// E-01/02/03 -> wrong representation, bytes before COMMIT, false delivery.
// Actual B2 PostgreSQL transactions and node HTTP sockets. The Orthanc protocol
// fixture is synthetic; this does not claim pinned OHIF/native decoder coverage.
const assert = require('node:assert/strict');
const { test } = require('node:test');
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

test('E real B2 COMMIT gates fixed HTTP bodies, ranges, multipart, failures and copies', async () => {
  const db = new PrismaClient(), witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_E_WITNESS_URL } } });
  const journal = new FailureJournal(db, new FailureSpool(process.env.KIN_E_SPOOL));
  const ledger = new AccessLedgerStore(db, journal), { port } = createRecordPort(ledger);
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
  let sourceBytes = original, sourceReads = 0, headerSyntax = ts;
  const source = createServer((req, res) => {
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url === '/tools/lookup') return json([{ Type: 'Instance', ID: objectId }]);
    if (req.url.endsWith('/simplified-tags')) return json({ StudyInstanceUID: studyUid, SeriesInstanceUID: seriesUid,
      SOPInstanceUID: sop, SOPClassUID: manifest.objects[0].sopClassUid, NumberOfFrames: '2' });
    if (req.url.endsWith('/header')) return json({ '0002,0010': { Value: headerSyntax } });
    if (req.url.endsWith('/file')) { sourceReads++; res.end(sourceBytes); return; }
    const frame = /\/frames\/(\d+)\/raw$/.exec(req.url);
    if (frame && frames[Number(frame[1])]) { sourceReads++; res.end(frames[Number(frame[1])]); return; }
    if (req.url.endsWith('/metadata')) return json([{ '0020000D': { vr: 'UI', Value: [studyUid] } }]);
    res.writeHead(404); res.end();
  });
  process.env.ORTHANC_URL = await listen(source);
  process.env.ORTHANC_USER = 'synthetic'; process.env.ORTHANC_PASS = randomUUID();
  const staging = path.join(process.env.KIN_E_SPOOL, 'staging'); await mkdir(staging, { recursive: true });
  const orthanc = new OrthancService();
  let denyAtCommit = false, failPrepared = false, loseCommit = false, failObservation = false, interruptFrame = false;
  let afterPrepared = () => {}, current, handleResult, clientRequest, countAuth = 0;
  const storedEvidence = new PgImageEvidenceStore(db);
  const evidence = {
    async prepared(tx, fixed, sourceManifest, copies) {
      assert.equal(sourceManifest.sha256, fixed.studyManifestSha256);
      await storedEvidence.prepared(tx, fixed, sourceManifest, copies);
      if (failPrepared) throw new Error('SyntheticPrepareRollback');
      afterPrepared();
    },
    async transferred(tx, id, observations, wire) {
      if (failObservation) throw new Error('SyntheticObservationFailure');
      await storedEvidence.transferred(tx, id, observations, wire);
    },
    async copiesRemoved(id, copies) {
      await storedEvidence.copiesRemoved(id, copies);
    },
  };
  const boundary = { records: port, evidence, source: orthanc.imageSource(), stagingDirectory: staging,
    async authorize() { if (++countAuth === 2 && denyAtCommit) throw new Error('SyntheticCurrentAccessRefused'); } };
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
      // The opening transaction is the caller's first current access check (authorize call 1); commit is call 2.
      const delivery = current;
      const result = await sendOnlineImage(boundary, { manifest: delivery.manifest, response: res, signal: control.signal,
        range: req.headers.range, async open(tx) {
          await boundary.authorize(tx, delivery.event, delivery.manifest);
          return { prepared: delivery.prepared, event: delivery.event };
        } });
      handleResult({ result });
    } catch (error) {
      if (!res.headersSent) { res.statusCode = 503; res.end(); } else res.destroy();
      handleResult({ error });
    }
  });
  const endpoint = await listen(server);
  const begin = (suffix = '', method = 'GET') => {
    countAuth = 0;
    const at = new Date().toISOString(), eventId = randomUUID();
    const target = `/dicom-web/studies/${studyUid}/series/${seriesUid}/instances/${sop}${suffix}`;
    const prepared = E.prepareDelivery(manifest, E.parseImageRequest(method, target), { eventId, cause: 'user-view', at,
      authorization: { studyUid, institution: 'synthetic-hospital', accountGeneration: 1 }, opening: null,
      provision: E.checkProvisionBasis({ relation: 'same-institution', at, managingInstitution: 'synthetic-hospital',
        recipient: null, studyUid, purpose: null, basis: null, agreement: null, auditBefore: null }) });
    const event = parseAccessEvent({ formatVersion: 1, surface: 'dicom-web-study-series-instance-frame', eventId,
      userId: known({ id: 'synthetic-doctor', issuer: 'synthetic', subject: 'doctor' }), rolesAtTime: known(['radiologist']),
      actingInstitution: known('synthetic-hospital'), managingInstitution: known('synthetic-hospital'), occurredAt: at,
      trustedProxyIp: known({ address: '127.0.0.1', source: 'request-peer' }), cause: 'user-view',
      context: { basis: 'worklist', studyId: studyUid, relatedStudyId: null, reason: null }, executor: 'member',
      targets: [{ kind: prepared.units[0].recordKind, patientLinkSnapshot: known(patient), studyId: known(studyUid), recordId: known(sop), versionId: known(manifest.sha256) }],
      action: 'provide-prepared', result: 'prepared', requestId: randomUUID(), auditLinkId: 'audit:' + randomUUID(), relatedEventId: null });
    current = { manifest, prepared, event }; return eventId;
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
        // The independent connection can see both the exact manifest and B2
        // preparation before the first protected HTTP chunk is consumed.
        if (res.statusCode < 300) {
          const rows = await witness.$queryRaw`SELECT response_manifest AS manifest FROM emr_image.preparation WHERE event_id=${current.event.eventId}::uuid`;
          assert.equal(rows.length, 1);
          assert.equal((await ledger.lookup(current.event.eventId)).outcome, 'committed');
          const fixed = rows[0].manifest;
          assert.equal(fixed.http.status, res.statusCode);
          assert.equal(fixed.http.range, headers.Range ?? null);
          assert.equal(fixed.request.method, current.prepared.request.method);
          assert.equal(fixed.http.body, fixed.request.method === 'GET');
          for (const [name, value] of Object.entries(fixed.http.headers))
            assert.equal(res.headers[name.toLowerCase()], value);
          assert.equal(fixed.http.plannedBytes, fixed.http.body ? Number(res.headers['content-length']) : 0);
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
  try {
    await db.$connect(); await witness.$connect();
    begin(); afterPrepared = () => { sourceBytes = Buffer.alloc(original.length, 99); };
    let sent = await request();
    assert.equal(sent.answer.status, 200); assert.equal(sent.result.terminal, 'transfer-ended');
    assert.equal(sent.result.observationStored, true);
    assert.equal(sourceReads, 1); assert.ok(sent.answer.body.includes(original));
    assert.equal(sent.result.copies.every(c => c.state === 'removed'), true);
    assert.equal(E.judgeDelivery([{ prepared: current.prepared, observations: sent.result.observations }]).outcome, 'complete');
    afterPrepared = () => {}; sourceBytes = original;

    // Module A's local-read branch can carry the same event ID, action, institutions
    // and target IDs, but asserts no formal PatientLink. It never opens an image body.
    begin();
    const v1 = current.event, readsBefore = sourceReads;
    current.event = parseAccessEvent({ formatVersion: 2, branch: 'local-read', surface: 'GET studies/:uid/report/versions',
      eventId: v1.eventId, userId: v1.userId, rolesAtTime: v1.rolesAtTime, rightsVersion: 1,
      actingInstitution: v1.actingInstitution, managingInstitution: v1.managingInstitution, occurredAt: v1.occurredAt,
      trustedProxyIp: v1.trustedProxyIp, session: { method: 'session', sessionRef: 'authref:' + randomUUID() },
      cause: 'user-view', executor: 'member', context: v1.context,
      targets: [{ kind: 'report-version', studyId: known(studyUid), recordId: known(sop), versionId: known(manifest.sha256),
        sourcePatientId: known(patient.patientId), sourceInstitution: known('synthetic-hospital'), projectionSha256: hash('synthetic-projection') }],
      action: 'provide-prepared', result: 'prepared', requestId: v1.requestId, auditLinkId: v1.auditLinkId, relatedEventId: null });
    sent = await request();
    assert.equal(sent.error?.code, 'ImageEventMismatch');
    assert.equal(sent.answer.status, 503); assert.equal(sent.answer.body.length, 0);
    assert.equal(sourceReads, readsBefore);
    assert.equal(await ledger.lookup(v1.eventId), null);
    assert.equal((await witness.$queryRaw`SELECT event_id FROM emr_image.preparation WHERE event_id=${v1.eventId}::uuid`).length, 0);
    // The same request with E's own v1 event still streams.
    current.event = v1; sent = await request();
    assert.equal(sent.answer.status, 200); assert.equal(sent.result.terminal, 'transfer-ended');
    assert.ok(sent.answer.body.includes(original));

    begin(); sent = await request({ Range: 'bytes=4-19' });
    assert.equal(sent.answer.status, 206); assert.deepEqual(sent.answer.body, original.subarray(4, 20));
    assert.equal(sent.answer.headers['content-range'], `bytes 4-19/${original.length}`);
    assert.deepEqual(sent.result.manifest.http.selections, [{ unit: current.prepared.units[0].key, start: 4, end: 20 }]);
    assert.equal(E.judgeDelivery([{ prepared: current.prepared, observations: sent.result.observations }]).outcome, 'incomplete');
    begin(); sent = await request({ Range: 'bytes=0-7,-8' });
    assert.equal(sent.answer.status, 206); assert.match(sent.answer.headers['content-type'], /^multipart\/byteranges/);
    assert.ok(sent.answer.body.includes(original.subarray(0, 8)));
    begin(); sent = await request({ Range: `bytes=${original.length}-` });
    assert.equal(sent.answer.status, 416); assert.equal(sent.answer.body.length, 0);

    begin('/frames/1,2'); sent = await request();
    assert.equal(sent.answer.status, 200);
    for (const bytes of frames) assert.ok(sent.answer.body.includes(bytes));
    assert.deepEqual(sent.result.manifest.representations.map(r => r.frame), [1, 2]);
    begin('', 'HEAD'); sent = await request();
    assert.equal(sent.answer.body.length, 0);
    assert.equal(E.judgeDelivery([{ prepared: current.prepared, observations: sent.result.observations }]).outcome, 'no-body');
    begin('/metadata'); sent = await request();
    assert.equal(sent.answer.status, 503);
    assert.equal(sent.answer.body.length, 0, 'an unbound generated representation must not borrow the original digest');
    begin();
    current.event = parseAccessEvent({ ...current.event, cause: 'background-fetch',
      context: { basis: 'background-fetch', studyId: null, relatedStudyId: null, reason: null } });
    sent = await request(); assert.equal(sent.answer.status, 503); assert.equal(sent.answer.body.length, 0);

    begin(); failPrepared = true; sent = await request(); failPrepared = false;
    assert.equal(sent.answer.status, 503); assert.equal(sent.answer.body.length, 0);
    assert.equal((await ledger.lookup(current.event.eventId)).outcome, 'negative');
    assert.equal((await witness.$queryRaw`SELECT event_id FROM emr_image.preparation WHERE event_id=${current.event.eventId}::uuid`).length, 0);
    begin(); denyAtCommit = true; sent = await request(); denyAtCommit = false;
    assert.equal(sent.answer.status, 503); assert.equal(sent.answer.body.length, 0);
    begin(); sourceBytes = Buffer.alloc(original.length, 99); sent = await request(); sourceBytes = original;
    assert.equal(sent.answer.status, 503); assert.equal(sent.answer.body.length, 0);
    const failedCopies = await witness.$queryRaw`SELECT body FROM emr_image.observation WHERE kind='copies' AND event_id=${current.event.eventId}::uuid`;
    assert.equal(failedCopies.length, 1, 'a failed preparation still accounts for its temporary copy');
    assert.equal(failedCopies[0].body[0].state, 'removed');
    begin(); headerSyntax = '1.2.840.10008.1.2.4.50'; sent = await request(); headerSyntax = ts;
    assert.equal(sent.answer.status, 503); assert.equal(sent.answer.body.length, 0);
    begin(); loseCommit = true; sent = await request();
    assert.equal(sent.answer.status, 200); assert.equal(sent.result.observationStored, true);
    begin(); afterPrepared = () => clientRequest.destroy(); sent = await request({}, true); afterPrepared = () => {};
    assert.equal(sent.result.terminal, 'transfer-aborted');
    assert.equal(sent.result.observations.some(o => o.stage === 'bytes'), false);
    begin('/frames/1,2'); interruptFrame = true; sent = await request(); interruptFrame = false;
    assert.equal(sent.result.terminal, 'transfer-aborted');
    assert.ok(sent.answer.body.includes(frames[0]), 'first frame reached the HTTP client before interruption');
    assert.equal(sent.answer.body.includes(frames[1]), false);
    assert.ok(sent.result.observations.some(o => o.stage === 'bytes' && o.end > o.start));
    assert.equal(E.judgeDelivery([{ prepared: current.prepared, observations: sent.result.observations }]).outcome, 'incomplete');
    begin(); failObservation = true; sent = await request(); failObservation = false;
    assert.equal(sent.result.observationStored, false);
    assert.ok(sent.result.observationError);
    assert.deepEqual(await readdir(staging), []);

    // R244-02: every committed preparation above came from the one study manifest. Its exact body is kept once, and
    // each preparation still yields that body, as the audit reader reads it (emr-audit/service.ts).
    const kept = await witness.$queryRaw`SELECT body FROM emr_image.source_manifest`;
    assert.equal(kept.length, 1, 'one kept copy of the study manifest, not one per delivered response');
    assert.deepEqual(kept[0].body, JSON.parse(JSON.stringify(manifest)));
    const sources = await witness.$queryRaw`SELECT COALESCE(p.source_manifest, m.body) AS source FROM emr_image.preparation p
      LEFT JOIN emr_image.source_manifest m ON m.body_sha256 = p.source_manifest_body`;
    assert.ok(sources.length > 5);
    for (const row of sources) assert.deepEqual(row.source, JSON.parse(JSON.stringify(manifest)));
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
