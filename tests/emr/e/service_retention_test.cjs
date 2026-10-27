'use strict';
// E_ROUTE study-identity refusal and observation retention at the service boundary (api/src/emr-image/service.ts,
// orthanc.service.ts imageSource): compiled product code, a synthetic Orthanc over real local HTTP, the real
// AccessLedgerStore.transactionWithRecords over a synthetic SQL port (so B2's own admission, rollback accounting and
// journal calls are the real ones), in-memory application rows. R244-GPT-01 (split UID) and R244-GPT-02 (a closing
// whose retention the ledger refuses).
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
const { AccessLedgerStore } = load('emr-runtime/store');
const { createBackgroundWorkRegistry } = load('emr-runtime/background-work');
const E = load('emr-image/contract');
const hash = v => createHash('sha256').update(v).digest('hex');
const known = value => ({ status: 'known', value });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const uid = '2.25.701', series = uid + '.1', sop = series + '.1', frame = Buffer.alloc(1024, 11), ts = '1.2.840.10008.1.2.1';

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
  const source = createServer((req, res) => {
    const json = v => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(v)); };
    if (req.url === '/tools/lookup') return json([{ Type: 'Instance', ID: '11111111-22222222-33333333-44444444-55555555' }]);
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
  // pool does (Prisma P2024).
  const ledger = { refuseRetention: false, refuseConnection: false, journal: [], admitted: [], appended: [], retained: [], calls: [] };
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
    async $queryRaw(parts, ...values) {
      const sql = parts.join('?');
      if (sql.includes('lock_operation')) return [{ value: 'pending' }];
      if (sql.includes('append_operation')) { ledger.calls.push('append'); ledger.appended.push({ operationId: values[0], event: JSON.parse(values[2]) }); return []; }
      if (sql.includes('settle_operation')) return [{ value: { operationId: values[0], eventId: null, outcome: 'negative', durableAt: null, result: null, entries: [] } }];
      throw new Error('unexpected ledger-transaction query: ' + sql.slice(0, 60));
    },
  };
  const ledgerDb = {
    $transaction: async fn => {
      if (ledger.refuseConnection) throw Object.assign(new Error('Timed out fetching a new connection from the connection pool'), { code: 'P2024' });
      return fn(tx);
    },
    async $queryRaw(parts, ...values) {
      const sql = parts.join('?');
      if (sql.includes('admit_operation')) { ledger.admitted.push({ operationId: values[0], event: JSON.parse(values[2]) }); return [{ id: values[0] }]; }
      throw new Error('unexpected ledger query: ' + sql.slice(0, 60));
    },
  };
  const store = new AccessLedgerStore(ledgerDb, { async record(cause, eventId, operationId) { ledger.journal.push({ cause, eventId, operationId }); return 'database'; } });
  const events = [];
  const records = { begin() { return {
    transactionWithRecords: (fn, options, failureEvent) => store.transactionWithRecords(fn, options, failureEvent),
    admit: async event => ({ event, operationId: event.eventId }),
    transaction: async (operation, fn) => { const result = await fn(tx); events.push(operation.event); return { outcome: 'committed', result }; },
    confirm: async x => ({ eventId: x.eventId, durableAt: new Date().toISOString() }), end() {},
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
  const context = new ProductionImageContext({ facts: async () => facts, scope: async () => scope, study: async () => ({ ...scope, patient }) }, {
    manifest: async () => { manifestBuilds++; return manifest; },
    delivery: async (_tx, _request, _facts, _study, at) => ({ accountGeneration: 1, provision: E.checkProvisionBasis({ relation: 'same-institution', at,
      managingInstitution: 'synthetic-hospital', recipient: null, studyUid: uid, purpose: null, basis: null, agreement: null, auditBefore: null }) }),
  });
  const registry = createBackgroundWorkRegistry();
  const requestFacts = { actor, institution: 'synthetic-hospital', rightsVersion: 1, roles: ['radiologist'],
    binding: { method: 'session', sessionRef: 'synthetic-session' }, ingress: facts.ip, requestId: randomUUID() };
  // The check pool stand-in is the application stand-in: one in-memory port answers both.
  const service = new OnlineImageService(records, context, db, new OrthancService(), { facts: async () => ({ ...requestFacts, requestId: randomUUID() }) }, registry.work, db);
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
  const stop = async () => { registry.quiesce(); await close(server); await close(source); };
  return { send, archive, ledger, app, events, service, stop, builds: () => manifestBuilds, lastError: () => lastError };
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
    await h.service.beforeApplicationShutdown();
    assert.deepEqual(h.ledger.appended.map(a => a.event.action), ['transfer-ended']);
  } finally { await h.stop(); }
});

test('a refused row is retained as the effect of the terminal operation, before its append', async () => {
  const h = await harness();
  try {
    h.app.refuseTransport = 1;
    const served = await h.send();
    assert.deepEqual([served.status, served.hasFrame], [200, true]);
    assert.deepEqual(h.app.observations.map(o => o.kind), ['copies'], 'the transport row is missing until the record closes');
    await h.service.beforeApplicationShutdown();
    assert.deepEqual(h.ledger.calls, ['retain', 'append'], 'retained on the terminal operation\'s transaction, before the terminal event is appended');
    assert.deepEqual(h.ledger.retained.map(r => [r.kind, r.response, r.delivery, r.retainedAfter]), [['transport', served.response, served.delivery, 'SyntheticAppPoolWriteFailure']]);
    assert.deepEqual(h.ledger.appended.map(a => [a.event.action, a.event.relatedEventId]), [['transfer-ended', served.delivery]]);
    assert.deepEqual(h.ledger.journal, []);
  } finally { await h.stop(); }
});

test('a closing whose retention the ledger refuses is a journaled rollback of the terminal operation; the rows are kept and retained at the next shutdown', async () => {
  const h = await harness();
  const errors = [];
  const consoleError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    h.app.refuseTransport = 1;
    const served = await h.send();
    assert.equal(served.status, 200);
    h.ledger.refuseRetention = true;
    await h.service.beforeApplicationShutdown();
    // B2 accounted the failure against the terminal operation, whose admitted event names the delivery.
    assert.equal(h.ledger.journal[0].cause, 'business-rollback');
    const terminal = h.ledger.admitted.find(a => a.operationId === h.ledger.journal[0].operationId);
    assert.ok(terminal, 'the journaled operation is the admitted terminal operation');
    assert.deepEqual([terminal.event.eventId, terminal.event.action, terminal.event.relatedEventId], [h.ledger.journal[0].eventId, 'transfer-ended', served.delivery]);
    // The shutdown's retention-only retry failed too: journaled against the delivery's own event (R244-GPT-02).
    assert.deepEqual(h.ledger.journal.slice(1), [{ cause: 'business-rollback', eventId: served.delivery, operationId: null }]);
    assert.deepEqual(h.ledger.appended, [], 'no terminal event without the response\'s facts');
    assert.deepEqual(h.ledger.retained, []);
    assert.ok(errors.some(line => line.includes('held for a later retention') && line.includes(served.delivery)), errors.join('\n'));
    assert.ok(errors.some(line => line.includes('not retained at shutdown') && line.includes(served.response)), 'a shutdown that still cannot retain names the rows');
    // The database is back: the next shutdown retains the held rows under their own delivery and request.
    const reported = errors.length;
    h.ledger.refuseRetention = false;
    await h.service.beforeApplicationShutdown();
    errors.splice(0, reported);
    assert.deepEqual(h.ledger.retained.map(r => [r.kind, r.response, r.delivery, r.retainedAfter]), [['transport', served.response, served.delivery, 'SyntheticAppPoolWriteFailure']]);
    assert.ok(typeof h.ledger.retained[0].request === 'string' && h.ledger.retained[0].request.length > 0);
    assert.deepEqual(h.ledger.appended, [], 'the failed terminal event is not re-invented by the retry');
    assert.equal(h.ledger.journal.length, 2, 'a retry that succeeds adds no failure');
    assert.ok(!errors.some(line => line.includes('not retained at shutdown')), errors.join('\n'));
  } finally { console.error = consoleError; await h.stop(); }
});

test('a closing that gets no ledger connection is journaled against its delivery before any operation is admitted; the rows are kept', async () => {
  const h = await harness();
  const errors = [];
  const consoleError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    h.app.refuseTransport = 1;
    const served = await h.send();
    assert.equal(served.status, 200);
    h.ledger.refuseConnection = true;
    await h.service.beforeApplicationShutdown();
    assert.deepEqual(h.ledger.admitted, [], 'no terminal operation was admitted');
    // The closing and the shutdown's retry each failed before a transaction began; both name the delivery.
    assert.deepEqual(h.ledger.journal, [0, 1].map(() => ({ cause: 'ledger-unreachable', eventId: served.delivery, operationId: null })));
    assert.deepEqual([h.ledger.retained, h.ledger.appended], [[], []]);
    assert.ok(errors.some(line => line.includes('not retained at shutdown') && line.includes(served.response)), errors.join('\n'));
    h.ledger.refuseConnection = false;
    await h.service.beforeApplicationShutdown();
    assert.deepEqual(h.ledger.retained.map(r => [r.kind, r.response, r.delivery]), [['transport', served.response, served.delivery]]);
    assert.equal(h.ledger.journal.length, 2);
  } finally { console.error = consoleError; await h.stop(); }
});
