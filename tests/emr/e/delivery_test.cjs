'use strict';
// E_ROUTE on the shared study delivery record (D1877, 의료법 제23조④; fix round 7 of #244, R244-GPT-FIX6-01/02). E's
// image API records a viewing through the recorder every image route shares (api/src/image-delivery-record.ts): one
// provide-prepared event per member session and study, durable before any source read, and one terminal event after
// the idle gap - the same pair the relay's reads of that session join. A HEAD and a description take no lease: alone
// they record nothing, and beside a failed GET they never turn the delivery into an ended one. Compiled product code
// (OnlineImageService, StudyImageDeliveryRecorder, ImageRelayController, OrthancService, ProductionImageContext) over
// a synthetic Orthanc on real local HTTP and an in-memory ledger behind the real record port.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { mkdtemp, readdir } = require('node:fs/promises');
const api = process.env.KIN_E_API || path.resolve(__dirname, '../../../api');
const load = name => require(path.join(api, 'dist', name));
const { buildImageManifest } = load('emr-image/manifest');
const { OnlineImageService, ONLINE_IMAGE_SURFACE } = load('emr-image/service');
const { ProductionImageContext } = load('emr-image/context');
const { OrthancService } = load('orthanc.service');
const { StudyImageDeliveryRecorder } = load('image-delivery-record');
const { ImageRelayController } = load('image-relay.controller');
const { createRecordPort } = load('emr-runtime/record-port');
const { mintDurableReceipt } = load('emr-runtime/contract');
const { createBackgroundWorkRegistry } = load('emr-runtime/background-work');
const { parseAccessEvent } = load('emr-contract/access-event');
const E = load('emr-image/contract');
const hash = v => createHash('sha256').update(v).digest('hex');
const known = value => ({ status: 'known', value });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const uid = '2.25.702', series = uid + '.1', sop = series + '.1', frame = Buffer.alloc(1024, 13), ts = '1.2.840.10008.1.2.1';
const INSTANCE = '11111111-22222222-33333333-44444444-55555555', STUDY = '66666666-77777777-88888888-99999999-aaaaaaaa';
const FRAME = `/dicom-web/studies/${uid}/series/${series}/instances/${sop}/frames/1`;
const IDLE_MS = 150;

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
  const archive = { rawReads: 0, fileReads: 0, revision: '20261028T120000' };
  const source = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const json = v => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(v)); };
    if (req.url === '/tools/lookup') return json(body.trim() === uid ? [{ Type: 'Study', ID: STUDY }] : [{ Type: 'Instance', ID: INSTANCE }]);
    if (req.url === `/studies/${STUDY}`) return json({ ID: STUDY, LastUpdate: archive.revision });
    if (req.url === `/instances/${INSTANCE}/study`) return json({ MainDicomTags: { StudyInstanceUID: uid } });
    if (req.url.startsWith('/dicom-web/studies?StudyInstanceUID=')) return json([{ '0020000D': { vr: 'UI', Value: [uid] }, '00100020': { vr: 'LO', Value: ['PATIENT-A'] } }]);
    if (req.url.endsWith('/simplified-tags')) return json({ StudyInstanceUID: uid, SeriesInstanceUID: series, SOPInstanceUID: sop,
      SOPClassUID: manifest.objects[0].sopClassUid, NumberOfFrames: '1', PatientID: 'PATIENT-A' });
    if (req.url.endsWith('/header')) return json({ '0002,0010': { Value: ts } });
    if (req.url.endsWith('/frames/0/raw')) { archive.rawReads++; if (archive.failRaw) { res.writeHead(500); return res.end(); } return res.end(frame); }
    if (req.url === `/instances/${INSTANCE}/file`) { archive.fileReads++; res.setHeader('Content-Type', 'application/dicom'); return res.end(Buffer.alloc(2048, 37)); }
    res.writeHead(404); res.end();
  });
  process.env.ORTHANC_URL = await listen(source); process.env.ORTHANC_USER = 'synthetic'; process.env.ORTHANC_PASS = 'synthetic';
  process.env.KIN_EMR_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), 'emr-e-delivery-'));

  // The ledger: an in-memory store with the ledger's receipt rule behind the real record port.
  const ledger = { entries: [], failing: false };
  const store = {
    async append(event, _served, keys) {
      if (ledger.failing) throw new Error('SyntheticLedgerUnreachable');
      const parsed = parseAccessEvent(event), at = new Date().toISOString();
      ledger.entries.push({ event: parsed, operationId: keys.operationId });
      return mintDurableReceipt(parsed.eventId, at);
    },
    async lookup() { return null; },
    async transactionWithRecords(work) { return work({}, async (_event, effect) => effect()); },
  };
  const { port } = createRecordPort(store);
  const facts = { actor: { identity: actor, kind: 'member', roles: ['radiologist'], institutionId: 'synthetic-hospital', signingRegistrationId: null },
    requestId: randomUUID(), ip: known({ address: '127.0.0.1', source: 'request-peer' }) };
  const scope = { studyId: uid, managingInstitutionId: 'synthetic-hospital', teleInstitutionId: null };
  const clinical = { facts: async () => facts, scope: async () => scope, study: async () => ({ ...scope, patient }) };
  const context = new ProductionImageContext(clinical, {
    manifest: async () => manifest,
    delivery: async (_tx, _request, _facts, _study, at) => ({ accountGeneration: 1, provision: E.checkProvisionBasis({ relation: 'same-institution', at,
      managingInstitution: 'synthetic-hospital', recipient: null, studyUid: uid, purpose: null, basis: null, agreement: null, auditBefore: null }) }),
  });
  const session = req => req.headers['x-synthetic-session'] ?? 'authref:session-a';
  const requests = {
    read: req => ({ issuer: actor.issuer, subject: actor.subject, binding: { method: 'session', sessionRef: session(req) } }),
    facts: async req => ({ actor, issuer: actor.issuer, subject: actor.subject, institution: 'synthetic-hospital', rightsVersion: 1, roles: ['radiologist'],
      binding: { method: 'session', sessionRef: session(req) }, ingress: facts.ip, requestId: randomUUID() }),
  };
  // E's rows on the application connection and the response's check transaction: one in-memory port answers both.
  const rows = { preparations: [], observations: [] };
  const db = { async $executeRaw(parts, ...values) {
    const sql = parts.join('?');
    if (sql.includes('INSERT INTO emr_image.preparation')) rows.preparations.push({ response: values[0], delivery: values[1] });
    else if (sql.includes('INSERT INTO emr_image.observation')) rows.observations.push({ response: values[0], delivery: values[1], kind: values[3] });
    return 1;
  }, $transaction(fn) { return fn(db); } };
  const registry = createBackgroundWorkRegistry();
  const orthanc = new OrthancService();
  // app.module gives every image route the one recorder.
  const recorder = new StudyImageDeliveryRecorder(port, requests, clinical, registry.work, orthanc, IDLE_MS);
  const service = new OnlineImageService(context, db, orthanc, requests, db, recorder);
  // The gate admits the relayed read and names what it observed in the archive: the study and its current patient.
  const relay = new ImageRelayController({ authzDicom: async () => ({ studyUid: uid, managingInstitutionId: 'synthetic-hospital', sourcePatientId: 'PATIENT-A' }) },
    orthanc, recorder);
  const server = createServer(async (req, res) => {
    res.status = code => { res.statusCode = code; return res; };
    try {
      if (req.url.startsWith('/api/image-relay/')) { req.originalUrl = req.url; await relay.read(req, res); }
      else await service.send(req, res, decodeURIComponent(new URL(req.url, 'http://x').searchParams.get('target')));
    } catch (e) { if (!res.headersSent) { res.statusCode = e.status ?? 500; res.end(JSON.stringify(e.getResponse?.() ?? { code: e.code })); } else res.destroy(); }
  });
  const endpoint = await listen(server);
  const send = async (target, method = 'GET', headers = {}) => {
    const r = await fetch(`${endpoint}/?target=${encodeURIComponent(target)}`, { method, headers });
    const body = Buffer.from(await r.arrayBuffer());
    return { status: r.status, body, event: r.headers.get('x-kin-image-event'), response: r.headers.get('x-kin-image-response'), manifest: r.headers.get('x-kin-image-manifest') };
  };
  const relayed = async (pathname, method = 'GET') => {
    const r = await fetch(`${endpoint}/api/image-relay${pathname}`, { method });
    return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
  };
  const stop = async () => { await recorder.beforeApplicationShutdown(); registry.quiesce(); await close(server); await close(source); };
  return { send, relayed, ledger, rows, archive, stop, staging: path.join(process.env.KIN_EMR_STATE_DIR, 'image-staging') };
}

test('E\'s frames and the relay\'s reads of one session are one study delivery pair', async () => {
  const h = await harness();
  try {
    const frames = await Promise.all([1, 2, 3].map(() => h.send(FRAME)));
    assert.ok(frames.every(f => f.status === 200 && f.body.includes(frame)), frames.map(f => f.status).join(','));
    const object = await h.relayed(`/instances/${INSTANCE}/file`);
    assert.equal(object.status, 200);
    assert.equal(h.ledger.entries.length, 1, 'one provide-prepared event for the session\'s reads of the study, on both routes');
    const [opened] = h.ledger.entries.map(e => e.event);
    assert.deepEqual([opened.action, opened.result, opened.surface, opened.cause], ['provide-prepared', 'prepared', ONLINE_IMAGE_SURFACE, 'background-fetch']);
    assert.deepEqual(opened.targets.map(t => [t.kind, t.studyId.value, t.recordId.value, t.versionId.value]),
      [['image', uid, uid, `orthanc-study:${STUDY}@20261028T120000`]], 'the shared record names the study at the archive\'s revision');
    assert.ok(frames.every(f => f.event === opened.eventId), 'every E response names the shared record');
    assert.deepEqual(h.rows.preparations.map(p => p.delivery), frames.map(() => opened.eventId), 'E\'s response rows name the shared record');
    assert.equal(new Set(frames.map(f => f.response)).size, 3);
    // Another session of the same member is another delivery.
    const other = await h.send(FRAME, 'GET', { 'x-synthetic-session': 'authref:session-b' });
    assert.equal(other.status, 200);
    assert.notEqual(other.event, opened.eventId);
    await sleep(IDLE_MS + 200);
    const ended = h.ledger.entries.filter(e => e.event.action === 'transfer-ended').map(e => e.event.relatedEventId).sort();
    assert.deepEqual(ended, [opened.eventId, other.event].sort(), 'each delivery closed once as ended after its idle gap');
    assert.equal(h.ledger.entries.length, 4);
  } finally { await h.stop(); }
});

test('a HEAD through E is no delivery: alone it records and keeps nothing, beside a failed GET the delivery is aborted', async () => {
  const h = await harness();
  try {
    const head = await h.send(FRAME, 'HEAD');
    assert.deepEqual([head.status, head.body.length], [200, 0]);
    assert.deepEqual([head.event, head.response, head.manifest], [null, null, null], 'a HEAD names no record and no response row');
    assert.equal(h.archive.rawReads, 1, 'the HEAD read and checked its source to answer its headers');
    assert.deepEqual(h.ledger.entries, [], 'a HEAD opens no delivery');
    assert.deepEqual([h.rows.preparations, h.rows.observations], [[], []], 'and keeps no row');
    assert.deepEqual(await readdir(h.staging), [], 'and no staging copy');
    const relayedHead = await h.relayed(`/instances/${INSTANCE}/file`, 'HEAD');
    assert.equal(relayedHead.status, 200);
    await sleep(IDLE_MS + 200);
    assert.deepEqual(h.ledger.entries, [], 'HEADs alone leave no pair after the idle gap either');
    // A GET the route admits and then fails (the archive cannot read its frame), and a successful HEAD beside it.
    h.archive.failRaw = true;
    const failed = await h.send(FRAME);
    h.archive.failRaw = false;
    assert.ok(failed.status >= 400 && !failed.body.includes(frame), String(failed.status));
    assert.equal(h.ledger.entries.length, 1, 'the failed GET was admitted under a record');
    assert.equal((await h.send(FRAME, 'HEAD')).status, 200);
    await sleep(IDLE_MS + 200);
    assert.deepEqual(h.ledger.entries.map(e => [e.event.action, e.event.result]), [['provide-prepared', 'prepared'], ['transfer-aborted', 'aborted']],
      'the HEAD does not count as an image served');
    // A GET naming a frame the kept manifest lacks forgets that manifest, and the delivery recording it ends with it,
    // before the idle gap.
    const outside = await h.send(FRAME.replace(/frames\/1$/, 'frames/9'));
    assert.ok(outside.status >= 400 && !outside.body.includes(frame), String(outside.status));
    for (let i = 0; i < 10 && h.ledger.entries.length < 4; i++) await sleep(10);
    assert.deepEqual(h.ledger.entries.slice(2).map(e => [e.event.action, e.event.result]), [['provide-prepared', 'prepared'], ['transfer-aborted', 'aborted']],
      'the forgotten manifest\'s delivery is closed at once');
  } finally { await h.stop(); }
});

test('descriptions through E take no lease; a ledger that cannot record answers 503 before any source read', async () => {
  const h = await harness();
  try {
    for (const target of [`/dicom-web/studies/${uid}/metadata`, `/dicom-web/studies/${uid}/series`]) {
      const answer = await h.send(target);
      assert.ok(answer.status >= 400, `${target} ${answer.status}`);
      assert.equal(answer.event, null);
    }
    assert.deepEqual(h.ledger.entries, [], 'a description opens no delivery');
    h.ledger.failing = true;
    const refused = await h.send(FRAME);
    assert.equal(refused.status, 503);
    assert.equal(JSON.parse(refused.body.toString()).code, 'IMAGE_DELIVERY_RECORD_UNAVAILABLE');
    assert.equal(h.archive.rawReads, 0, 'no source body is read without the record');
    assert.deepEqual(h.rows.preparations, []);
    h.ledger.failing = false;
    const served = await h.send(FRAME);
    assert.deepEqual([served.status, h.ledger.entries.length], [200, 1], 'the next read asks the ledger again');
  } finally { await h.stop(); }
});

test('E joins the delivery a relay read opened when it names E\'s patient at the archive\'s current revision; after the archive changed the study, E opens its own (R244-GPT-FIX7-01)', async () => {
  const h = await harness();
  try {
    assert.equal((await h.relayed(`/instances/${INSTANCE}/file`)).status, 200);
    const frame1 = await h.send(FRAME);
    assert.equal(frame1.status, 200);
    assert.equal(h.ledger.entries.length, 1, 'the relay\'s open delivery is E\'s record too');
    assert.equal(frame1.event, h.ledger.entries[0].event.eventId);
    await sleep(IDLE_MS + 200);
    assert.deepEqual(h.ledger.entries.map(e => e.event.action), ['provide-prepared', 'transfer-ended']);
    // A relay read opens the next delivery at revision 120000; then the archive stores into the study (LastUpdate moves).
    assert.equal((await h.relayed(`/instances/${INSTANCE}/file`)).status, 200);
    const relayOpened = h.ledger.entries[2].event;
    h.archive.revision = '20261028T121500';
    const frame2 = await h.send(FRAME);
    assert.equal(frame2.status, 200);
    assert.notEqual(frame2.event, relayOpened.eventId, 'E\'s bytes are not recorded under the revision the relay\'s record names');
    const opened = h.ledger.entries.find(e => e.event.eventId === frame2.event).event;
    assert.deepEqual(opened.targets.map(t => [t.patientLinkSnapshot.value.patientId, t.versionId.value]), [['PATIENT-A', `orthanc-study:${STUDY}@20261028T121500`]]);
    for (let i = 0; i < 10 && !h.ledger.entries.some(e => e.event.relatedEventId === relayOpened.eventId); i++) await sleep(10);
    assert.deepEqual(h.ledger.entries.filter(e => e.event.relatedEventId === relayOpened.eventId).map(e => [e.event.action, e.event.result]),
      [['transfer-ended', 'succeeded']], 'the relay\'s delivery ended at once, as what it served');
    // The relay's next read joins E's delivery: an unbound read joins whichever delivery of the study is open.
    assert.equal((await h.relayed(`/instances/${INSTANCE}/file`)).status, 200);
    assert.equal(h.ledger.entries.filter(e => e.event.action === 'provide-prepared').length, 3);
  } finally { await h.stop(); }
});