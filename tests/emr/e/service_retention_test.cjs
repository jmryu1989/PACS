'use strict';
// E_ROUTE study-identity refusal, manifest binding and observation retention at the service boundary
// (api/src/emr-image/service.ts, orthanc.service.ts imageSource, image-delivery-record.ts): compiled product code, a
// synthetic Orthanc over real local HTTP, the real AccessLedgerStore.transactionWithRecords over a synthetic SQL port
// (so B2's own rollback accounting and journal calls are the real ones), in-memory application rows, and the study
// delivery's record from the recorder every image route shares. R244-GPT-01 (split UID), R244-GPT-FIX7-01 (a delivery
// is the record of one manifest's patient and version: a corrected patient's bytes never go out under the previous
// patient's record; FIX8-01: also through the relay on the same recorder, whose gate names the patient it observed) and
// R244-GPT-02 / FIX7-02 / FIX8-02 (a row the application connection refused is never dropped: the delivery owes it,
// offers it on a ledger transaction of its own - journaled against its record when that fails - and writes its closing
// event only on one transaction with it, also at the stop, which waits for a response still handing its rows over).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { mkdtemp } = require('node:fs/promises');
const os = require('node:os');
const api = process.env.KIN_E_API || path.resolve(__dirname, '../../../api');
const load = name => require(path.join(api, 'dist', name));
const { buildImageManifest } = load('emr-image/manifest');
const { OnlineImageService } = load('emr-image/service');
const { ImageRelayController } = load('image-relay.controller');
const { ProductionImageContext } = load('emr-image/context');
const { OrthancService } = load('orthanc.service');
const { StudyImageDeliveryRecorder } = load('image-delivery-record');
const { AccessLedgerStore } = load('emr-runtime/store');
const { mintDurableReceipt } = load('emr-runtime/contract');
const { createBackgroundWorkRegistry } = load('emr-runtime/background-work');
const { parseAccessEvent } = load('emr-contract/access-event');
const E = load('emr-image/contract');
const hash = v => createHash('sha256').update(v).digest('hex');
const known = value => ({ status: 'known', value });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const until = async (condition, what, tries = 200) => {
  for (let i = 0; i < tries && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(condition(), what);
};
const uid = '2.25.701', series = uid + '.1', sop = series + '.1', frame = Buffer.alloc(1024, 11), ts = '1.2.840.10008.1.2.1';
const STUDY = '66666666-77777777-88888888-99999999-aaaaaaaa';
const patientOf = id => ({ linkId: JSON.stringify(['synthetic-hospital', id]), patientId: id, assigningAuthority: 'synthetic-hospital' });

/** One service over synthetic ports. `archive` and `ledger` are the knobs a case turns; `replacePatient` is a patient
 * correction of the study in the archive and the clinical context (same UIDs and pixels, another PatientID). */
async function harness({ idleMs } = {}) {
  const actor = { id: randomUUID(), issuer: 'synthetic', subject: 'doctor' };
  let patient = patientOf('PATIENT-A');
  const manifestInput = () => ({ formatVersion: 1, studyUid: uid, managingInstitution: 'synthetic-hospital', patient,
    builtAt: new Date().toISOString(), expected: { series: 1, objects: 1 }, pages: [{ cursor: null, next: null, objects: [{
      studyUid: uid, seriesUid: series, sopInstanceUid: sop, sopClassUid: '1.2.840.10008.5.1.4.1.1.7.2', transferSyntaxUid: ts,
      imageType: ['ORIGINAL', 'PRIMARY'], bytes: 2048, sha256: hash(Buffer.alloc(2048, 37)), declaredFrameCount: 1,
      frames: [{ number: 1, bytes: frame.length, sha256: hash(frame) }], provenance: { kind: 'device', receiptEventId: null },
      derivation: { kind: 'original' }, mammography: null, timing: null }] }], referencedObjects: [],
    decoderCatalog: { native: { version: 'synthetic', sha256: hash('decoder') } }, viewer: { id: 'synthetic', version: 'fixture', sha256: hash('viewer') } });
  let manifest = buildImageManifest(manifestInput());
  const archive = { split: false, rawReads: 0, studyReads: 0, patientId: 'PATIENT-A', revision: '20261028T120000' };
  const source = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const json = v => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(v)); };
    if (req.url === '/tools/lookup') return json(body.trim() === uid ? [{ Type: 'Study', ID: STUDY }] : [{ Type: 'Instance', ID: '11111111-22222222-33333333-44444444-55555555' }]);
    if (req.url === `/studies/${STUDY}`) return json({ ID: STUDY, LastUpdate: archive.revision });
    if (req.url.startsWith('/dicom-web/studies?StudyInstanceUID=')) {
      archive.studyReads++;
      const row = id => ({ '0020000D': { vr: 'UI', Value: [uid] }, '00100020': { vr: 'LO', Value: [id] } });
      return json(archive.split ? [row('PATIENT-A'), row('PATIENT-B')] : [row(archive.patientId)]);
    }
    if (req.url.endsWith('/simplified-tags')) return json({ StudyInstanceUID: uid, SeriesInstanceUID: series, SOPInstanceUID: sop,
      SOPClassUID: manifest.objects[0].sopClassUid, NumberOfFrames: '1', PatientID: archive.patientId });
    if (req.url.endsWith('/header')) return json({ '0002,0010': { Value: ts } });
    if (req.url.endsWith('/frames/0/raw')) { archive.rawReads++; return res.end(frame); }
    // A rendering the relay reads: the archive's current patient's image.
    if (req.url.endsWith('/rendered')) { res.setHeader('Content-Type', 'application/octet-stream'); return res.end(Buffer.from('synthetic-image:' + archive.patientId)); }
    res.writeHead(404); res.end();
  });
  process.env.ORTHANC_URL = await listen(source); process.env.ORTHANC_USER = 'synthetic'; process.env.ORTHANC_PASS = 'synthetic';
  process.env.KIN_EMR_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), 'emr-e-retention-'));

  // The ledger: the real store's transaction path over a synthetic SQL port. `ledger.refuseRetention` makes the
  // observation insert fail on a ledger transaction, as an unreachable database would; a transaction's rows count as
  // retained only when it commits. `ledger.refuseConnection` refuses the transaction's connection before its callback,
  // as an exhausted or unreachable pool does (Prisma P2024).
  const ledger = { refuseRetention: false, refuseConnection: false, journal: [], retained: [] };
  const ledgerDb = {
    $transaction: async fn => {
      if (ledger.refuseConnection) throw Object.assign(new Error('Timed out fetching a new connection from the connection pool'), { code: 'P2024' });
      const rows = [];
      const tx = { async $executeRaw(parts, ...values) {
        const sql = parts.join('?');
        if (sql.startsWith('SET LOCAL')) return 0;
        if (!sql.includes('INSERT INTO emr_image.observation')) throw new Error('unexpected ledger-transaction SQL: ' + sql.slice(0, 60));
        if (ledger.refuseRetention) throw Object.assign(new Error('SyntheticLedgerUnavailable'), { code: 'SyntheticLedgerUnavailable' });
        rows.push({ response: values[0], delivery: values[1], request: values[2], kind: values[3], body: JSON.parse(values[4]), retainedAfter: values[5] });
        return 1;
      } };
      const value = await fn(tx);
      ledger.retained.push(...rows);
      return value;
    },
  };
  const journal = { async record(cause, eventId, operationId) { ledger.journal.push({ cause, eventId, operationId }); return 'database'; } };
  const store = new AccessLedgerStore(ledgerDb, journal);
  // The record's own appends (`events`) are an in-memory store with the ledger's receipt rule. An admitted operation
  // with an effect is B2's (store.ts transaction): the effect and the entry commit on one ledger transaction or neither;
  // a failed effect is journaled against the operation's event and the operation settles negative - that event can
  // never commit.
  const events = [], operations = new Map();
  const result = (operationId, op) => ({ operationId, eventId: op.event.eventId, outcome: op.outcome });
  const records = { begin() { return {
    transactionWithRecords: (fn, options, failureEvent) => store.transactionWithRecords(fn, options, failureEvent),
    append: async event => { const parsed = parseAccessEvent(event); events.push(parsed); return mintDurableReceipt(parsed.eventId, new Date().toISOString()); },
    admit: async (event, _served, keys) => {
      const parsed = parseAccessEvent(event);
      if (!operations.has(keys.operationId)) operations.set(keys.operationId, { event: parsed, outcome: 'pending' });
      return { operationId: keys.operationId, attemptId: keys.attemptId, event: parsed };
    },
    transaction: async (operation, effect) => {
      const op = operations.get(operation.operationId);
      if (op.outcome !== 'pending') return result(operation.operationId, op);
      try { await ledgerDb.$transaction(tx => effect(tx)); }
      catch (error) {
        ledger.journal.push({ cause: 'business-rollback', eventId: op.event.eventId, operationId: operation.operationId });
        op.outcome = 'negative';
        throw error;
      }
      op.outcome = 'committed'; events.push(op.event);
      return result(operation.operationId, op);
    },
    confirm: async ({ operationId, eventId }) => {
      if (operations.get(operationId)?.outcome !== 'committed') throw new Error('AppendNotCommitted');
      return mintDurableReceipt(eventId, new Date().toISOString());
    },
    lookup: async operationId => operations.has(operationId) ? result(operationId, operations.get(operationId)) : null,
    end() {},
  }; } };
  // The application connection: E's own rows and the response's bounded check transaction; `app.refuseTransport`
  // refuses the next transport-observation insert; `app.beforeTransport` holds that insert (the response's body is out).
  const app = { refuseTransport: 0, beforeTransport: null, preparations: [], observations: [], checks: 0 };
  const db = { async $executeRaw(parts, ...values) {
    const sql = parts.join('?');
    if (sql.startsWith('SET LOCAL')) return 0;
    if (sql.includes('INSERT INTO emr_image.preparation')) app.preparations.push({ response: values[0], delivery: values[1] });
    else if (sql.includes('INSERT INTO emr_image.observation')) {
      if (values[3] === 'transport' && app.beforeTransport) await app.beforeTransport();
      if (values[3] === 'transport' && app.refuseTransport > 0) { app.refuseTransport--; throw Object.assign(new Error('SyntheticAppPoolWriteFailure'), { code: 'SyntheticAppPoolWriteFailure' }); }
      app.observations.push({ response: values[0], delivery: values[1], kind: values[3] });
    }
    return 1;
  }, $transaction(fn) { app.checks++; return fn(db); } };
  const facts = { actor: { identity: actor, kind: 'member', roles: ['radiologist'], institutionId: 'synthetic-hospital', signingRegistrationId: null },
    requestId: randomUUID(), ip: known({ address: '127.0.0.1', source: 'request-peer' }) };
  const scope = { studyId: uid, managingInstitutionId: 'synthetic-hospital', teleInstitutionId: null };
  let manifestBuilds = 0;
  const clinical = { facts: async () => facts, scope: async () => scope, study: async () => ({ ...scope, patient }) };
  const context = new ProductionImageContext(clinical, {
    manifest: async () => { manifestBuilds++; return manifest; },
    delivery: async (_tx, _request, _facts, _study, at) => ({ accountGeneration: 1, provision: E.checkProvisionBasis({ relation: 'same-institution', at,
      managingInstitution: 'synthetic-hospital', recipient: null, studyUid: uid, purpose: null, basis: null, agreement: null, auditBefore: null }) }),
  });
  const registry = createBackgroundWorkRegistry();
  const binding = { method: 'session', sessionRef: 'synthetic-session' };
  const requests = { read: () => ({ issuer: actor.issuer, subject: actor.subject, binding }),
    facts: async () => ({ actor, institution: 'synthetic-hospital', rightsVersion: 1, roles: ['radiologist'], binding, ingress: facts.ip, requestId: randomUUID() }) };
  const orthanc = new OrthancService();
  const recorder = new StudyImageDeliveryRecorder(records, requests, clinical, registry.work, orthanc, idleMs);
  // The check pool stand-in is the application stand-in: one in-memory port answers both.
  const service = new OnlineImageService(context, db, orthanc, requests, db, recorder);
  // The relay on the same recorder; its gate admits the read and names what it observed in the archive for it, as
  // PacsDicomGateway.authzDicom does with its per-request source read: the study and its current patient.
  const relay = new ImageRelayController({ authzDicom: async () => ({ studyUid: uid, managingInstitutionId: 'synthetic-hospital', sourcePatientId: archive.patientId }) },
    orthanc, recorder);
  const target = `/dicom-web/studies/${uid}/series/${series}/instances/${sop}/frames/1`;
  let settled, lastError = null;
  const server = createServer(async (req, res) => {
    res.status = code => { res.statusCode = code; return res; };
    try {
      if (req.url.startsWith('/api/image-relay/')) { req.originalUrl = req.url; await relay.read(req, res); }
      else await service.send(req, res, target);
    }
    catch (e) { lastError = e; if (!res.headersSent) { res.statusCode = e.status ?? 503; res.end(JSON.stringify(e.getResponse?.() ?? { code: e.code })); } }
    finally { settled(); }
  });
  const endpoint = await listen(server);
  const send = async (route = '/') => {
    const done = new Promise(resolve => settled = resolve);
    const r = await fetch(endpoint + route);
    const bytes = Buffer.from(await r.arrayBuffer());
    await done;
    return { status: r.status, hasFrame: bytes.includes(frame), body: bytes, delivery: r.headers.get('x-kin-image-event'), response: r.headers.get('x-kin-image-response') };
  };
  // The stop as Nest runs it: the recorder ends every delivery and offers what each still owes. E holds nothing.
  const shutdown = () => recorder.beforeApplicationShutdown();
  const stop = async () => { registry.quiesce(); await close(server); await close(source); };
  const replacePatient = id => {
    patient = patientOf(id);
    archive.patientId = id; archive.revision = '20261028T120100';
    manifest = buildImageManifest(manifestInput());
  };
  return { send, archive, ledger, app, events, service, shutdown, stop, replacePatient, manifest: () => manifest,
    builds: () => manifestBuilds, lastError: () => lastError, relayPath: `/api/image-relay/dicom-web/studies/${uid}/rendered` };
}

/** What the recorder's logger printed while `work` ran (Nest's console logger writes to stdout and stderr). */
async function logged(work) {
  const lines = [], out = process.stdout.write, err = process.stderr.write;
  process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return out.call(process.stdout, chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return err.call(process.stderr, chunk, ...rest); };
  try { await work(); } finally { process.stdout.write = out; process.stderr.write = err; }
  return lines.join('');
}

test('the check pool is the application database with a bound of its own', () => {
  const { checkPoolUrl, EMR_IMAGE_CHECK_POOL_SIZE } = load('emr-image/check-db');
  const url = new URL(checkPoolUrl('postgresql://kin_runtime:secret@db:5432/kin'));
  assert.deepEqual([url.hostname, url.pathname, url.username, url.searchParams.get('connection_limit')], ['db', '/kin', 'kin_runtime', String(EMR_IMAGE_CHECK_POOL_SIZE)]);
  assert.equal(new URL(checkPoolUrl('postgresql://kin_runtime:secret@db:5432/kin?connection_limit=5&schema=public')).searchParams.get('connection_limit'),
    String(EMR_IMAGE_CHECK_POOL_SIZE), 'the application pool\'s own bound does not carry over');
});

test('a second patient resource under the study UID refuses the response as unresolved, before any body read, and forgets the manifest with its delivery', async () => {
  const h = await harness();
  try {
    const first = await h.send();
    assert.deepEqual([first.status, first.hasFrame], [200, true]);
    const reads = h.archive.rawReads, builds = h.builds();
    h.archive.split = true;
    const split = await h.send();
    assert.equal(split.status, 409);
    assert.equal(JSON.parse(split.body.toString()).code, 'STUDY_IDENTITY_UNRESOLVED', 'the product\'s own refusal of an unresolved study identity');
    assert.equal(split.hasFrame, false);
    assert.equal(split.response, null, 'no response row under the record');
    assert.equal(h.archive.rawReads, reads, 'no body read');
    assert.ok(h.archive.studyReads >= 2, 'the study identity is read per response');
    assert.equal(h.app.preparations.length, 1);
    // The forgotten manifest's delivery ends with it, as what it served.
    await until(() => h.events.length === 2, 'the delivery of the forgotten manifest is closed');
    assert.deepEqual(h.events.map(e => [e.action, e.relatedEventId]), [['provide-prepared', null], ['transfer-ended', first.delivery]]);
    h.archive.split = false;
    const again = await h.send();
    assert.deepEqual([again.status, again.hasFrame], [200, true]);
    assert.notEqual(again.delivery, first.delivery, 'the rebuilt manifest opens its own record');
    assert.equal(h.builds(), builds + 1, 'the kept manifest was forgotten and rebuilt from the current study');
    await h.shutdown();
    assert.deepEqual(h.events.map(e => [e.action, e.relatedEventId]),
      [['provide-prepared', null], ['transfer-ended', first.delivery], ['provide-prepared', null], ['transfer-ended', again.delivery]]);
  } finally { await h.stop(); }
});

test('a corrected patient\'s image is never served under the record of the previous patient and revision (R244-GPT-FIX7-01)', async () => {
  const h = await harness();
  try {
    const first = await h.send();
    assert.deepEqual([first.status, first.hasFrame], [200, true]);
    h.replacePatient('PATIENT-B');
    const outdated = await h.send();
    assert.deepEqual([outdated.status, outdated.hasFrame, outdated.delivery], [409, false, null], 'the kept manifest of the previous patient is refused');
    await until(() => h.events.length === 2, 'the previous patient\'s delivery is closed with its manifest');
    const second = await h.send();
    assert.deepEqual([second.status, second.hasFrame], [200, true]);
    assert.notEqual(second.delivery, first.delivery, 'the corrected patient\'s bytes are under a record of their own');
    await h.shutdown();
    const targets = id => h.events.find(e => e.eventId === id).targets.map(t => [t.patientLinkSnapshot.value.patientId, t.versionId.value]);
    assert.deepEqual(targets(first.delivery), [['PATIENT-A', `orthanc-study:${STUDY}@20261028T120000`]]);
    assert.deepEqual(targets(second.delivery), [['PATIENT-B', `orthanc-study:${STUDY}@20261028T120100`]]);
    assert.deepEqual(h.events.map(e => [e.action, e.relatedEventId]),
      [['provide-prepared', null], ['transfer-ended', first.delivery], ['provide-prepared', null], ['transfer-ended', second.delivery]]);
    assert.deepEqual(h.app.preparations.map(p => p.delivery), [first.delivery, second.delivery], 'each response row names the record of its own patient');
  } finally { await h.stop(); }
});

test('a refused row is retained on a ledger transaction of its own after the response, naming its record and the first failure', async () => {
  const h = await harness();
  try {
    h.app.refuseTransport = 1;
    const served = await h.send();
    assert.deepEqual([served.status, served.hasFrame], [200, true]);
    assert.deepEqual(h.app.observations.map(o => o.kind), ['copies'], 'the transport row is missing from the response\'s own path');
    await until(() => h.ledger.retained.length === 1, 'the refused row is retained after the response');
    assert.deepEqual(h.ledger.retained.map(r => [r.kind, r.response, r.delivery, r.retainedAfter]), [['transport', served.response, served.delivery, 'SyntheticAppPoolWriteFailure']]);
    assert.deepEqual(h.ledger.journal, []);
    assert.deepEqual(h.events.map(e => e.action), ['provide-prepared'], 'the delivery stays open for the viewing\'s next reads');
    await h.shutdown();
    assert.deepEqual(h.events.map(e => e.action), ['provide-prepared', 'transfer-ended']);
  } finally { await h.stop(); }
});

test('a delivery whose refused rows cannot be retained has no closing event; the stop names them (R244-GPT-FIX7-02)', async () => {
  const h = await harness();
  try {
    h.app.refuseTransport = 1;
    h.ledger.refuseRetention = true;
    const served = await h.send();
    assert.equal(served.status, 200);
    await until(() => h.ledger.journal.length === 1, 'the failed retention is journaled');
    // B2 accounted the failure against the delivery's own record: no operation was admitted for it.
    assert.deepEqual(h.ledger.journal, [{ cause: 'business-rollback', eventId: served.delivery, operationId: null }]);
    const printed = await logged(() => h.shutdown());
    assert.deepEqual(h.ledger.retained, []);
    assert.deepEqual(h.events.map(e => e.action), ['provide-prepared'], 'no closing event without the rows it covers');
    // Each closing offer was the admitted operation's own rollback, journaled against its event; a refused one is never
    // offered again under the same event.
    const closings = h.ledger.journal.slice(1);
    assert.ok(closings.length >= 1 && closings.every(j => j.cause === 'business-rollback' && j.operationId && j.eventId !== served.delivery), JSON.stringify(h.ledger.journal));
    assert.equal(new Set(closings.map(j => j.eventId)).size, closings.length);
    assert.match(printed, new RegExp(`terminal_not_recorded_at_shutdown[^\\n]*prepared=${served.delivery}`));
    assert.match(printed, new RegExp(`facts_not_written_at_shutdown[^\\n]*${served.response}`), 'the stop names the rows it could not write');
  } finally { await h.stop(); }
});

test('the closing event is written on one transaction with the rows its delivery still owes, once the ledger takes them', async () => {
  const h = await harness({ idleMs: 50 });
  try {
    h.app.refuseTransport = 1;
    h.ledger.refuseRetention = true;
    const served = await h.send();
    assert.equal(served.status, 200);
    // The response's own offer, then the idle close's: both refused, and no closing event.
    await until(() => h.ledger.journal.length >= 2, 'the closing offer with the owed rows was refused');
    assert.deepEqual(h.events.map(e => e.action), ['provide-prepared']);
    const refusedClosing = h.ledger.journal[1];
    h.ledger.refuseRetention = false;
    // The next offer of the close (the background retry) is a new event of the same pair, with the rows.
    await until(() => h.events.length === 2, 'the closing event is recorded once the rows are', 400);
    const [, closing] = h.events;
    assert.deepEqual([closing.action, closing.relatedEventId], ['transfer-ended', served.delivery]);
    assert.notEqual(closing.eventId, refusedClosing.eventId, 'the refused closing event is not reused');
    assert.deepEqual(h.ledger.retained.map(r => [r.kind, r.response, r.delivery, r.retainedAfter]),
      [['transport', served.response, served.delivery, 'SyntheticAppPoolWriteFailure']]);
    await h.shutdown();
    assert.equal(h.events.length, 2);
  } finally { await h.stop(); }
});

test('a retention that gets no ledger connection is journaled against the delivery\'s record; the rows are kept for the next response', async () => {
  const h = await harness();
  try {
    const opened = await h.send();
    assert.equal(opened.status, 200);
    // The delivery is open; the next response joins it without ledger work, and its refused row meets no connection.
    h.ledger.refuseConnection = true;
    h.app.refuseTransport = 1;
    const served = await h.send();
    assert.deepEqual([served.status, served.delivery], [200, opened.delivery]);
    await until(() => h.ledger.journal.length === 1, 'the failed retention is journaled');
    assert.deepEqual(h.ledger.journal, [{ cause: 'ledger-unreachable', eventId: served.delivery, operationId: null }]);
    assert.deepEqual(h.ledger.retained, []);
    // The connection is back: the next response of the viewing offers the held rows again.
    h.ledger.refuseConnection = false;
    assert.equal((await h.send()).status, 200);
    await until(() => h.ledger.retained.length === 1, 'the held row is retained by the next response\'s offer');
    assert.deepEqual(h.ledger.retained.map(r => [r.kind, r.response, r.delivery]), [['transport', served.response, served.delivery]]);
    assert.equal(h.ledger.journal.length, 1);
    await h.shutdown();
    assert.deepEqual(h.events.map(e => e.action), ['provide-prepared', 'transfer-ended']);
  } finally { await h.stop(); }
});

test('after a patient correction the relay serves the corrected patient only under a record naming that patient, also when E opened the delivery (R244-GPT-FIX8-01)', async () => {
  for (const opener of ['E', 'relay']) {
    const h = await harness();
    try {
      assert.equal((await h.send(opener === 'E' ? '/' : h.relayPath)).status, 200, opener);
      await until(() => h.events.length === 1, 'the opening is recorded');
      h.replacePatient('PATIENT-B');
      const second = await h.send(h.relayPath);
      assert.deepEqual([second.status, second.body.toString()], [200, 'synthetic-image:PATIENT-B'], opener);
      await h.shutdown();
      const opened = h.events.filter(e => e.action === 'provide-prepared');
      assert.deepEqual(opened.map(e => [e.targets[0].patientLinkSnapshot.value.patientId, e.targets[0].versionId.value]),
        [['PATIENT-A', `orthanc-study:${STUDY}@20261028T120000`], ['PATIENT-B', `orthanc-study:${STUDY}@20261028T120100`]], opener);
      for (const prepared of opened)
        assert.deepEqual(h.events.filter(e => e.relatedEventId === prepared.eventId).map(e => e.action), ['transfer-ended'], opener);
    } finally { await h.stop(); }
  }
});

/** Holds E's next transport-row insert - written after the response's image body - until `release()`. */
function holdTransport(h) {
  let release, entered;
  const held = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { entered = resolve; });
  h.app.beforeTransport = async () => { h.app.beforeTransport = null; entered(); await held; };
  return { reached, release: () => release() };
}

test('the stop waits for a response still writing its rows: the closing event is written with the row it hands over (R244-GPT-FIX8-02)', async () => {
  const h = await harness();
  const transport = holdTransport(h);
  try {
    h.app.refuseTransport = 1;
    const pending = h.send();
    await transport.reached;
    const stopping = h.shutdown();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(h.events.map(e => e.action), ['provide-prepared'], 'no closing event while the response still owns its rows');
    transport.release();
    const served = await pending;
    await stopping;
    assert.equal(served.status, 200);
    assert.deepEqual(h.events.map(e => [e.action, e.relatedEventId]), [['provide-prepared', null], ['transfer-ended', served.delivery]]);
    assert.deepEqual(h.ledger.retained.map(r => [r.kind, r.response, r.delivery, r.retainedAfter]),
      [['transport', served.response, served.delivery, 'SyntheticAppPoolWriteFailure']]);
    assert.deepEqual(h.ledger.journal, []);
  } finally { transport.release(); await h.stop(); }
});

test('the stop waits for a response still writing its rows: a row the ledger cannot retain leaves no closing event, journaled and named (R244-GPT-FIX8-02)', async () => {
  const h = await harness();
  const transport = holdTransport(h);
  try {
    h.app.refuseTransport = 1;
    h.ledger.refuseRetention = true;
    const pending = h.send();
    await transport.reached;
    let served;
    const printed = await logged(async () => {
      const stopping = h.shutdown();
      transport.release();
      served = await pending;
      await stopping;
    });
    assert.equal(served.status, 200);
    assert.deepEqual(h.ledger.retained, []);
    assert.deepEqual(h.events.map(e => e.action), ['provide-prepared'], 'no closing event without the row it covers');
    assert.ok(h.ledger.journal.length >= 1 && h.ledger.journal.every(j => j.cause === 'business-rollback' && j.eventId !== served.delivery),
      JSON.stringify(h.ledger.journal));
    assert.match(printed, new RegExp(`terminal_not_recorded_at_shutdown[^\\n]*prepared=${served.delivery}`));
    assert.match(printed, new RegExp(`facts_not_written_at_shutdown[^\\n]*${served.response}`));
  } finally { transport.release(); await h.stop(); }
});

test('a response still in flight when the drain allowance ends leaves its delivery without a closing event (R244-GPT-FIX8-02)', async () => {
  const h = await harness();
  const transport = holdTransport(h);
  try {
    h.app.refuseTransport = 1;
    h.ledger.refuseRetention = true;
    const pending = h.send();
    await transport.reached;
    // The stop does not wait past the shutdown's drain allowance (SHUTDOWN_DRAIN_MS, 10 s).
    const printed = await logged(() => h.shutdown());
    assert.match(printed, /delivery_unsettled_at_shutdown[^\n]*inflight=1/);
    transport.release();
    const served = await pending;
    await until(() => h.ledger.journal.length === 1, 'the late row\'s own offer is journaled');
    assert.equal(served.status, 200);
    assert.deepEqual(h.ledger.retained, []);
    assert.deepEqual(h.ledger.journal, [{ cause: 'business-rollback', eventId: served.delivery, operationId: null }]);
    assert.deepEqual(h.events.map(e => e.action), ['provide-prepared'],
      'no closing event: what the delivery served and owes was not known when the process stopped');
  } finally { transport.release(); await h.stop(); }
});
