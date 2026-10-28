'use strict';
// E_ROUTE study-identity refusal and observation retention at the service boundary (api/src/emr-image/service.ts,
// orthanc.service.ts imageSource): compiled product code, a synthetic Orthanc over real local HTTP, the real
// AccessLedgerStore.transactionWithRecords over a synthetic SQL port (so B2's own rollback accounting and journal calls
// are the real ones), in-memory application rows, and the study delivery's record from the recorder every image route
// shares (image-delivery-record.ts). R244-GPT-01 (split UID) and R244-GPT-02 (a row the application connection refused
// is never dropped: it is retained on a ledger transaction of its own, journaled against the delivery's record when that
// fails too, and kept for the next offer).
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
const until = async (condition, what) => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(condition(), what);
};
const uid = '2.25.701', series = uid + '.1', sop = series + '.1', frame = Buffer.alloc(1024, 11), ts = '1.2.840.10008.1.2.1';
const STUDY = '66666666-77777777-88888888-99999999-aaaaaaaa';

/** One service over synthetic ports. `archive` and `ledger` are the knobs a case turns. */
async function harness() {
  const actor = { id: randomUUID(), issuer: 'synthetic', subject: 'doctor' };
  const patient = { linkId: JSON.stringify(['synthetic-hospital', 'PATIENT-A']), patientId: 'PATIENT-A', assigningAuthority: 'synthetic-hospital' };
  const manifest = buildImageManifest({ formatVersion: 1, studyUid: uid, managingInstitution: 'synthetic-hospital', patient,
    builtAt: new Date().toISOString(), expected: { series: 1, objects: 1 }, pages: [{ cursor: null, next: null, objects: [{
      studyUid: uid, seriesUid: series, sopInstanceUid: sop, sopClassUid: '1.2.840.10008.5.1.4.1.1.7.2', transferSyntaxUid: ts,
      imageType: ['ORIGINAL', 'PRIMARY'], bytes: 2048, sha256: hash(Buffer.alloc(2048, 37)), declaredFrameCount: 1,
      frames: [{ number: 1, bytes: frame.length, sha256: hash(frame) }], provenance: { kind: 'device', receiptEventId: null },
      derivation: { kind: 'original' }, mammography: null, timing: null }] }], referencedObjects: [],
    decoderCatalog: { native: { version: 'synthetic', sha256: hash('decoder') } }, viewer: { id: 'synthetic', version: 'fixture', sha256: hash('viewer') } });
  const archive = { split: false, rawReads: 0, studyReads: 0 };
  const source = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const json = v => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(v)); };
    if (req.url === '/tools/lookup') return json(body.trim() === uid ? [{ Type: 'Study', ID: STUDY }] : [{ Type: 'Instance', ID: '11111111-22222222-33333333-44444444-55555555' }]);
    if (req.url === `/studies/${STUDY}`) return json({ ID: STUDY, LastUpdate: '20261028T120000' });
    if (req.url.startsWith('/dicom-web/studies?StudyInstanceUID=')) {
      archive.studyReads++;
      const row = id => ({ '0020000D': { vr: 'UI', Value: [uid] }, '00100020': { vr: 'LO', Value: [id] } });
      return json(archive.split ? [row('PATIENT-A'), row('PATIENT-B')] : [row('PATIENT-A')]);
    }
    if (req.url.endsWith('/simplified-tags')) return json({ StudyInstanceUID: uid, SeriesInstanceUID: series, SOPInstanceUID: sop,
      SOPClassUID: manifest.objects[0].sopClassUid, NumberOfFrames: '1', PatientID: 'PATIENT-A' });
    if (req.url.endsWith('/header')) return json({ '0002,0010': { Value: ts } });
    if (req.url.endsWith('/frames/0/raw')) { archive.rawReads++; return res.end(frame); }
    res.writeHead(404); res.end();
  });
  process.env.ORTHANC_URL = await listen(source); process.env.ORTHANC_USER = 'synthetic'; process.env.ORTHANC_PASS = 'synthetic';
  process.env.KIN_EMR_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), 'emr-e-retention-'));

  // The ledger: the real store's transaction path over a synthetic SQL port. `ledger.refuseRetention` makes the
  // observation insert fail on the ledger transaction, as an unreachable database would.
  // `ledger.refuseConnection` refuses the transaction's connection before its callback, as an exhausted or unreachable
  // pool does (Prisma P2024). The delivery record's own appends (`events`) are an in-memory store with the ledger's
  // receipt rule.
  const ledger = { refuseRetention: false, refuseConnection: false, journal: [], retained: [], calls: [] };
  const tx = {
    async $executeRaw(parts, ...values) {
      const sql = parts.join('?');
      if (sql.startsWith('SET LOCAL')) return 0;
      if (!sql.includes('INSERT INTO emr_image.observation')) throw new Error('unexpected ledger-transaction SQL: ' + sql.slice(0, 60));
      ledger.calls.push('retain');
      if (ledger.refuseRetention) throw Object.assign(new Error('SyntheticLedgerUnavailable'), { code: 'SyntheticLedgerUnavailable' });
      ledger.retained.push({ response: values[0], delivery: values[1], request: values[2], kind: values[3], body: JSON.parse(values[4]), retainedAfter: values[5] });
      return 1;
    },
  };
  const ledgerDb = {
    $transaction: async fn => {
      if (ledger.refuseConnection) throw Object.assign(new Error('Timed out fetching a new connection from the connection pool'), { code: 'P2024' });
      return fn(tx);
    },
  };
  const store = new AccessLedgerStore(ledgerDb, { async record(cause, eventId, operationId) { ledger.journal.push({ cause, eventId, operationId }); return 'database'; } });
  const events = [];
  const records = { begin() { return {
    transactionWithRecords: (fn, options, failureEvent) => store.transactionWithRecords(fn, options, failureEvent),
    append: async event => { const parsed = parseAccessEvent(event); events.push(parsed); return mintDurableReceipt(parsed.eventId, new Date().toISOString()); },
    lookup: async () => null, end() {},
  }; } };
  // The application connection: E's own rows and the response's bounded check transaction; `app.refuseTransport`
  // refuses the next transport-observation insert.
  const app = { refuseTransport: 0, preparations: [], observations: [], checks: 0 };
  const db = { async $executeRaw(parts, ...values) {
    const sql = parts.join('?');
    if (sql.startsWith('SET LOCAL')) return 0;
    if (sql.includes('INSERT INTO emr_image.preparation')) app.preparations.push({ response: values[0], delivery: values[1] });
    else if (sql.includes('INSERT INTO emr_image.observation')) {
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
  const recorder = new StudyImageDeliveryRecorder(records, requests, clinical, registry.work, orthanc);
  // The check pool stand-in is the application stand-in: one in-memory port answers both.
  const service = new OnlineImageService(records, context, db, orthanc, requests, db, recorder);
  const target = `/dicom-web/studies/${uid}/series/${series}/instances/${sop}/frames/1`;
  let settled, lastError = null;
  const server = createServer(async (req, res) => {
    try { await service.send(req, res, target); }
    catch (e) { lastError = e; if (!res.headersSent) { res.statusCode = e.status ?? 503; res.end(JSON.stringify(e.getResponse?.() ?? { code: e.code })); } }
    finally { settled(); }
  });
  const endpoint = await listen(server);
  const send = async () => {
    const done = new Promise(resolve => settled = resolve);
    const r = await fetch(endpoint);
    const bytes = Buffer.from(await r.arrayBuffer());
    await done;
    return { status: r.status, hasFrame: bytes.includes(frame), body: bytes, delivery: r.headers.get('x-kin-image-event'), response: r.headers.get('x-kin-image-response') };
  };
  // The stop as Nest runs it: the recorder ends the open delivery, then E names or retains what it still holds.
  const shutdown = async () => { await recorder.beforeApplicationShutdown(); await service.beforeApplicationShutdown(); };
  const stop = async () => { registry.quiesce(); await close(server); await close(source); };
  return { send, archive, ledger, app, events, service, shutdown, stop, builds: () => manifestBuilds, lastError: () => lastError };
}

test('the check pool is the application database with a bound of its own', () => {
  const { checkPoolUrl, EMR_IMAGE_CHECK_POOL_SIZE } = load('emr-image/check-db');
  const url = new URL(checkPoolUrl('postgresql://kin_runtime:secret@db:5432/kin'));
  assert.deepEqual([url.hostname, url.pathname, url.username, url.searchParams.get('connection_limit')], ['db', '/kin', 'kin_runtime', String(EMR_IMAGE_CHECK_POOL_SIZE)]);
  assert.equal(new URL(checkPoolUrl('postgresql://kin_runtime:secret@db:5432/kin?connection_limit=5&schema=public')).searchParams.get('connection_limit'),
    String(EMR_IMAGE_CHECK_POOL_SIZE), 'the application pool\'s own bound does not carry over');
});

test('a second patient resource under the study UID refuses the response as unresolved, before any body read, and forgets the manifest', async () => {
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
    h.archive.split = false;
    const again = await h.send();
    assert.deepEqual([again.status, again.hasFrame, again.delivery === first.delivery], [200, true, true], 'the record of the viewing continues once the study is one patient again');
    assert.equal(h.builds(), builds + 1, 'the kept manifest was forgotten and rebuilt from the current study');
    await h.shutdown();
    assert.deepEqual(h.events.map(e => [e.action, e.relatedEventId]), [['provide-prepared', null], ['transfer-ended', first.delivery]]);
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

test('a retention the ledger refuses is journaled against the delivery\'s record; the rows are kept and retained by a later offer', async () => {
  const h = await harness();
  const errors = [];
  const consoleError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    h.app.refuseTransport = 1;
    h.ledger.refuseRetention = true;
    const served = await h.send();
    assert.equal(served.status, 200);
    await until(() => h.ledger.journal.length === 1, 'the failed retention is journaled');
    // B2 accounted the failure against the delivery's own record: no operation was admitted for it.
    assert.deepEqual(h.ledger.journal, [{ cause: 'business-rollback', eventId: served.delivery, operationId: null }]);
    assert.deepEqual(h.ledger.retained, []);
    await until(() => errors.some(line => line.includes('held for a later retention') && line.includes(served.delivery)), errors.join('\n'));
    // The stop's own offer fails too: the rows are named, not dropped.
    await h.shutdown();
    assert.equal(h.ledger.journal.length, 2);
    assert.ok(errors.some(line => line.includes('not retained at shutdown') && line.includes(served.response)), 'a shutdown that still cannot retain names the rows');
    // The database is back: the next offer retains the held rows under their own record and request.
    const reported = errors.length;
    h.ledger.refuseRetention = false;
    await h.service.beforeApplicationShutdown();
    errors.splice(0, reported);
    assert.deepEqual(h.ledger.retained.map(r => [r.kind, r.response, r.delivery, r.retainedAfter]), [['transport', served.response, served.delivery, 'SyntheticAppPoolWriteFailure']]);
    assert.ok(typeof h.ledger.retained[0].request === 'string' && h.ledger.retained[0].request.length > 0);
    assert.equal(h.ledger.journal.length, 2, 'a retry that succeeds adds no failure');
    assert.ok(!errors.some(line => line.includes('not retained at shutdown')), errors.join('\n'));
  } finally { console.error = consoleError; await h.stop(); }
});

test('a retention that gets no ledger connection is journaled against the delivery\'s record; the rows are kept for the next response', async () => {
  const h = await harness();
  const errors = [];
  const consoleError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
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
  } finally { console.error = consoleError; await h.stop(); }
});
