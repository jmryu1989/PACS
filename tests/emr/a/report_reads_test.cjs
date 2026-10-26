'use strict';
// MODULE_A A2 real boundary cells for the report history reads:
//   GET studies/:uid/report/versions and GET studies/:uid/report/versions/:version/citations
// through the production AppModule.withLedger (signed Guard, PacsController, PacsService, StudyAccessInterceptor and
// A1's ViewingResponseInterceptor) on the accepted B2 PostgreSQL ledger, read back on an independent witness connection.
// Only external collaborators are synthetic: the OIDC key endpoint, the Orthanc QIDO answer, and a TCP relay in front of
// the ledger connection that loses one COMMIT reply. SQL locks and a fixture-owned CHECK constraint make the ordinary
// delays and failures. No product seam, fake receipt or composed page.
// REQ-A-REPORT / A-HTTP-REPORT, REQ-A-DURABLE / A-PG-COMMIT, REQ-A-TARGET / A-HTTP-BODY, REQ-A-OUTCOME / A-HTTP-OUTCOME.
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const build = process.env.KIN_B2R_BUILD;
if (!build) throw new Error('Compiled candidate path required');
const apiRequire = createRequire(path.join(build, '../package.json'));
apiRequire('reflect-metadata');
const jose = apiRequire('jose');
const { PrismaClient } = apiRequire('@prisma/client');
const { NestFactory } = apiRequire('@nestjs/core');
const { EmrRuntime } = require(path.join(build, 'emr-runtime/application.js'));
const { AppModule } = require(path.join(build, 'app.module.js'));
const { parseAccessEvent } = require(path.join(build, 'emr-contract/access-event.js'));

const sha = text => createHash('sha256').update(text).digest('hex');
const pause = () => new Promise(resolve => setTimeout(resolve, 25));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(() => resolve()));
const issuer = 'https://synthetic.invalid/realms/module-a-reports';
const institution = 'synthetic-report-site', foreignInstitution = 'synthetic-other-site';
const sub = 'synthetic-report-doctor', actor = sub + '@example.test';
const CLIENT_IP = '192.0.2.41';
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Relays the ledger client's PostgreSQL connections. When armed with a marker, the first transaction that sends the
 * marker has its COMMIT forwarded; the server's reply is then discarded and both sockets are closed. PostgreSQL commits,
 * the API never hears it: the ordinary lost-reply schedule, made in the transport only.
 */
function ledgerRelay(host, port) {
  let armed = null, lost = 0;
  const sockets = new Set();
  const server = net.createServer(client => {
    const upstream = net.connect(port, host);
    sockets.add(client); sockets.add(upstream);
    let pending = Buffer.alloc(0), started = false, inTx = false, marked = false, losing = false;
    const end = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    for (const socket of [client, upstream]) { socket.on('error', end); socket.on('close', end); }
    upstream.on('data', data => {
      if (losing) { lost++; end(); return; }
      client.write(data);
    });
    client.on('data', data => {
      pending = Buffer.concat([pending, data]);
      for (;;) {
        if (!started) {
          // SSLRequest/StartupMessage carry no type byte; the server answers SSLRequest itself.
          if (pending.length < 8) return;
          const length = pending.readInt32BE(0);
          if (pending.length < length) return;
          if (pending.readInt32BE(4) === 196608) started = true;
          upstream.write(pending.subarray(0, length)); pending = pending.subarray(length);
          continue;
        }
        if (pending.length < 5) return;
        const length = pending.readInt32BE(1) + 1;
        if (pending.length < length) return;
        const message = pending.subarray(0, length); pending = pending.subarray(length);
        const type = String.fromCharCode(message[0]);
        if (type === 'Q' || type === 'P') {
          const text = message.subarray(5).toString('utf8');
          const sql = type === 'Q' ? text : text.slice(text.indexOf('\0') + 1);
          if (/^\s*(BEGIN|START TRANSACTION)/i.test(sql)) { inTx = true; marked = false; }
          else if (/^\s*(COMMIT|ROLLBACK)/i.test(sql)) {
            if (inTx && marked && armed && /^\s*COMMIT/i.test(sql)) { armed = null; losing = true; }
            inTx = false; marked = false;
          }
        }
        if (inTx && armed && message.includes(armed)) marked = true;
        upstream.write(message);
      }
    });
  });
  return { server, arm(marker) { armed = Buffer.from(marker, 'utf8'); }, get lost() { return lost; },
    stop() { for (const socket of sockets) socket.destroy(); return close(server); } };
}

let ctx;
before(async () => {
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  const jwk = { ...await jose.exportJWK(publicKey), kid: 'module-a-reports', alg: 'RS256', use: 'sig' };
  const split = new Set(), sourceRows = new Map(), originals = new Map(), instances = new Map();
  // Synthetic external collaborators: the OIDC key set and Orthanc's QIDO study answer (one resource per UID, two for a
  // UID two patients share). Like Orthanc 1.12.5 (measured, R229-B6-01), the answer carries the PS3.18 default study
  // attributes plus only the tags the request names in includefield; InstitutionName is not a default.
  const QIDO_STUDY_DEFAULTS = new Set(['00080005', '00080020', '00080030', '00080050', '00080056', '00080061', '00080090',
    '00080201', '00081190', '00100010', '00100020', '00100030', '00100040', '0020000D', '00200010', '00201206', '00201208']);
  const provider = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/certs') return res.end(JSON.stringify({ keys: [jwk] }));
    const url = new URL(req.url, 'http://synthetic');
    if (url.pathname === '/dicom-web/studies') {
      const uid = url.searchParams.get('StudyInstanceUID');
      const named = new Set(url.searchParams.getAll('includefield').flatMap(value => value.split(',')).map(tag => tag.trim().toUpperCase()));
      const answered = row => Object.fromEntries(Object.entries(row).filter(([tag]) => QIDO_STUDY_DEFAULTS.has(tag) || named.has(tag)));
      const row = patient => ({ '0020000D': { vr: 'UI', Value: [uid] }, '00100020': { vr: 'LO', Value: [patient] } });
      const rows = uid ? uid.split(',').flatMap(id => sourceRows.get(id) ?? (split.has(id) ? [row('SYN-PID-1'), row('SYN-PID-2')] : [row('SYN-PID-1')])) : [...sourceRows.values()].flat();
      return res.end(JSON.stringify(rows.map(answered)));
    }
    if (url.pathname === '/tools/lookup') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const uid = Buffer.concat(chunks).toString('utf8');
      const id = sha(uid).slice(0, 40).match(/.{8}/g).join('-');
      if (instances.has(uid)) { originals.set(id, instances.get(uid)); return res.end(JSON.stringify([{ Type: 'Instance', ID: id }])); }
      if (sourceRows.has(uid)) { originals.set(id, { MainDicomTags: { StudyInstanceUID: uid }, PatientMainDicomTags: { PatientID: 'SYN-CONSUMER-PID' } });
        return res.end(JSON.stringify([{ Type: 'Study', ID: id }])); }
    }
    if (url.pathname.startsWith('/instances/') && url.pathname.endsWith('/study'))
      return res.end(JSON.stringify({ MainDicomTags: { StudyInstanceUID: originals.get(url.pathname.split('/')[2])?.StudyInstanceUID } }));
    if (url.pathname.startsWith('/instances/') && url.pathname.endsWith('/simplified-tags')) return res.end(JSON.stringify(originals.get(url.pathname.split('/')[2])));
    if (url.pathname.startsWith('/instances/') && url.pathname.endsWith('/attachments/dicom/info')) return res.end(JSON.stringify({ UncompressedMD5: 'a'.repeat(32) }));
    if (url.pathname.startsWith('/studies/') && originals.has(url.pathname.split('/')[2]))
      return res.end(JSON.stringify(originals.get(url.pathname.split('/')[2])));
    if (url.pathname === '/tools/find') {
      const rows = [...sourceRows.values()].flat().map(row => ({ RequestedTags: {
        StudyInstanceUID: row['0020000D'].Value[0], InstitutionName: row['00080080']?.Value[0] ?? '',
        PatientID: row['00100020']?.Value[0] ?? '', StudyDate: row['00080020']?.Value[0] ?? '',
        ModalitiesInStudy: row['00080061']?.Value?.join('\\') ?? '', AccessionNumber: row['00080050']?.Value[0] ?? '',
      } }));
      return res.end(JSON.stringify(rows));
    }
    res.statusCode = 404; res.end('{}');
  });
  await listen(provider);
  const providerUrl = 'http://127.0.0.1:' + provider.address().port;
  Object.assign(process.env, { KC_ISSUER: issuer, KC_AUDIENCE: 'kin-api', AUTH_REQUIRED: 'true',
    KIN_COOKIE_SECRET: randomUUID(), KC_WEB_SECRET: randomUUID(), PUBLIC_ORIGIN: 'https://synthetic.invalid',
    KC_JWKS_URL: providerUrl + '/certs', ORTHANC_URL: providerUrl, ORTHANC_USER: 'synthetic', ORTHANC_PASS: randomUUID() });
  const token = await new jose.SignJWT({ sid: 'synthetic-report-session', email: actor, realm_access: { roles: ['radiologist'] }, groups: ['/' + institution] })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer).setSubject(sub).setAudience('kin-api')
    .setIssuedAt().setExpirationTime('30m').sign(privateKey);
  const witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_B2R_WITNESS_URL } } });
  const ledgerUrl = new URL(process.env.DATABASE_URL);
  const relay = ledgerRelay(ledgerUrl.hostname, Number(ledgerUrl.port || 5432));
  await listen(relay.server);
  const relayed = new URL(process.env.DATABASE_URL);
  relayed.hostname = '127.0.0.1'; relayed.port = String(relay.server.address().port);
  // The ledger client (B2 runtime) goes through the relay; ordinary API reads (PrismaService) use DATABASE_URL directly.
  const runtime = new EmrRuntime(relayed.toString(), process.env.KIN_B2R_SPOOL);
  await witness.$connect();
  await witness.memberRightsImport.create({ data: { id: 'realm-v1' } });
  await witness.memberRights.create({ data: { sub, username: sub, email: actor, name: 'Synthetic Reader', emailVerified: true,
    approved: true, suspended: false, institution, roles: ['radiologist'] } });
  await witness.institution.create({ data: { id: foreignInstitution, name: 'Synthetic Other Site' } });
  await runtime.start();
  const app = await NestFactory.create(AppModule.withLedger(runtime, { proxyPeers: ['127.0.0.1'] }), { logger: ['error'], abortOnError: false, rawBody: true });
  app.setGlobalPrefix('api');
  app.use('/worklist', apiRequire('express').static(path.resolve(__dirname, '../../../worklist-v0/hpacs-lite')));
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const clinicianSub = 'synthetic-consumer-clinician';
  await witness.memberRights.create({ data: { sub: clinicianSub, username: clinicianSub, email: clinicianSub + '@example.test',
    name: 'Synthetic Clinician', emailVerified: true, approved: true, suspended: false, institution, roles: ['clinician'] } });
  const clinicianToken = await new jose.SignJWT({ email: clinicianSub + '@example.test', realm_access: { roles: ['clinician'] }, groups: ['/' + institution] })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer).setSubject(clinicianSub).setAudience('kin-api')
    .setIssuedAt().setExpirationTime('30m').sign(privateKey);
  ctx = { witness, runtime, app, provider, relay, split, sourceRows, origin, token, clinicianToken, instances };
});
after(async () => {
  if (!ctx) return;
  await ctx.app.close();
  await ctx.runtime.stop(Date.now() + 15000);
  await ctx.relay.stop();
  await ctx.witness.$disconnect();
  await close(ctx.provider);
});

/** One real HTTP request. `onResponse` runs when the status line and headers arrive, before any body byte is read. */
function call(pathname, { onResponse, token, method = 'GET', body } = {}) {
  let req;
  const done = new Promise((resolve, reject) => {
    req = http.request(ctx.origin + '/api' + pathname, { method, headers: { authorization: 'Bearer ' + (token ?? ctx.token), 'x-real-ip': CLIENT_IP, 'content-type': 'application/json' } }, res => {
      res.pause();
      Promise.resolve(onResponse?.(res)).then(() => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null; try { body = JSON.parse(text); } catch { /* non-JSON is asserted by the case */ }
          resolve({ status: res.statusCode, headers: res.headers, text, body });
        });
        res.on('error', reject);
        res.resume();
      }, reject);
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { req, done };
}
const get = pathname => call(pathname).done;
const events = async uid => (await ctx.witness.$queryRaw`SELECT e.event_id, e.operation_id::text AS operation_id, e.payload
  FROM emr_access.access_entry e WHERE e.payload::jsonb->'targets'->0->'studyId'->>'value' = ${uid} ORDER BY e.sequence`)
  .map(row => ({ eventId: row.event_id, operationId: row.operation_id, payload: row.payload, event: JSON.parse(row.payload) }));
const prepared = async uid => (await events(uid)).filter(e => e.event.action === 'provide-prepared');
async function settled(uid, count) {
  for (;;) {
    const all = await events(uid);
    if (all.filter(e => e.event.relatedEventId !== null).length >= count) return all;
    await pause();
  }
}
async function runtimeWaitsOnLock() {
  for (;;) {
    const [row] = await ctx.witness.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE usename='kin_runtime' AND wait_event_type='Lock'`;
    if (row.n) return;
    await pause();
  }
}
/** Hold the ledger's entry table; the API's INSERT waits on PostgreSQL itself. */
function holdLedger(mode = 'SHARE') {
  let release, entered;
  const locked = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const holding = ctx.witness.$transaction(async tx => {
    await tx.$executeRawUnsafe(`LOCK TABLE emr_access.access_entry IN ${mode} MODE`);
    entered(); await gate;
  }, { timeout: 15000 }); // B2's existing transaction deadline.
  return { locked, release: () => { release(); return holding; } };
}
let seq = 0;
async function study(fields = {}) {
  const uid = '2.25.8802' + process.pid + (++seq);
  await ctx.witness.studyState.create({ data: { uid, institutionId: institution, ss: 'Verified', rs: 'A', ...fields } });
  return uid;
}
async function version(uid, n, fields = {}) {
  return ctx.witness.reportVersion.create({ data: { uid, version: n, action: 'approve', author: actor,
    findings: '', conclusion: '', recommendation: '', ...fields } });
}
function assertAttribution(event, surface) {
  assert.equal(event.surface, surface);
  assert.equal(event.branch, 'local-read');
  assert.equal(event.userId.value.issuer, issuer);
  assert.equal(event.userId.value.subject, sub);
  assert.deepEqual(event.rolesAtTime.value, ['radiologist']);
  assert.equal(event.actingInstitution.value, institution);
  assert.equal(event.managingInstitution.value, institution);
  assert.deepEqual(event.session, { method: 'bearer', sessionRef: null });
  assert.deepEqual(event.trustedProxyIp.value, { address: CLIENT_IP, source: 'trusted-proxy' });
  assert.equal(event.cause, 'user-view');
  assert.equal(event.context, null);
  assert.deepEqual(parseAccessEvent(event), event);
}

test('A-HTTP-REPORT / A-HTTP-BODY / A-PG-COMMIT: every returned version is committed before the first byte and is the returned row', async () => {
  const uid = await study();
  const sentinel = 'SYN-REPORT-BODY-' + randomUUID();
  const rows = [await version(uid, 1, { action: 'save', findings: sentinel + ' v1' }),
    await version(uid, 2, { action: 'approve', findings: sentinel + ' v2', conclusion: 'SYN conclusion' }),
    await version(uid, 3, { action: 'discarded', author: 'synthetic-other@example.test', findings: sentinel + ' other draft' }),
    await version(uid, 4, { action: 'addendum', findings: sentinel + ' v4', reason: 'SYN addendum reason' })];
  const hold = holdLedger();
  await hold.locked;
  let firstByte = null, answer;
  try {
    const pending = call('/studies/' + encodeURIComponent(uid) + '/report/versions', { onResponse: async () => {
      // At the first response bytes, an independent connection already sees every target committed.
      firstByte = (await prepared(uid)).length;
    } });
    await runtimeWaitsOnLock();
    assert.equal(firstByte, null, 'no response byte while the provide-prepared INSERT waits on PostgreSQL');
    assert.equal((await prepared(uid)).length, 0);
    await hold.release();
    answer = await pending.done;
  } finally { await hold.release(); }
  assert.equal(answer.status, 200, answer.text);
  assert.equal(firstByte, rows.length, 'every returned version is committed before the first byte');
  assert.match(answer.headers['content-type'], /^application\/json/);
  // The existing array contract: newest first, the same ten fields, plus each row's opaque accessRef.
  assert.deepEqual(answer.body.map(r => r.version), [4, 3, 2, 1]);
  for (const row of answer.body) {
    const stored = rows.find(r => r.version === row.version);
    const { accessRef, ...fields } = row;
    assert.match(accessRef, UUID4);
    assert.deepEqual(fields, { id: stored.id, uid, version: stored.version, action: stored.action, findings: stored.findings,
      conclusion: stored.conclusion, recommendation: stored.recommendation, reason: stored.reason, author: stored.author,
      at: stored.at.toISOString() });
  }
  const recorded = await settled(uid, rows.length);
  const opened = recorded.filter(e => e.event.action === 'provide-prepared');
  assert.equal(opened.length, rows.length, 'one provide-prepared per returned version, none invented');
  for (const row of answer.body) {
    const entry = opened.find(e => e.eventId === row.accessRef);
    assert.ok(entry, 'the accessRef names its own committed record');
    assertAttribution(entry.event, 'GET studies/:uid/report/versions');
    assert.deepEqual(entry.event.targets, [{ kind: 'report-version', studyId: { status: 'known', value: uid },
      recordId: { status: 'known', value: String(row.id) }, versionId: { status: 'known', value: String(row.version) },
      sourcePatientId: { status: 'known', value: 'SYN-PID-1' }, sourceInstitution: { status: 'unresolved', reason: 'not-observed' },
      projectionSha256: sha(JSON.stringify(row)) }], 'the target is the exact returned row');
    assert.equal(entry.payload.includes(sentinel), false, 'the ledger keeps the projection identity, not the report text');
    const ended = recorded.filter(e => e.event.relatedEventId === row.accessRef);
    assert.deepEqual(ended.map(e => e.event.action), ['transfer-ended']);
  }
  assert.equal(new Set(opened.map(e => e.event.requestId)).size, 1, 'one server request');
  const indexed = await ctx.witness.$queryRawUnsafe(`SELECT t.target_kind, t.record_id, t.version_id FROM emr_access.access_target t
    JOIN emr_access.access_entry e USING (entry_id) WHERE e.event_id = ANY($1::text[]) ORDER BY t.version_id`, opened.map(e => e.eventId));
  assert.deepEqual(indexed, rows.map(r => ({ target_kind: 'report-version', record_id: String(r.id), version_id: String(r.version) }))
    .sort((a, b) => a.version_id.localeCompare(b.version_id)));
});

test('A-HTTP-REPORT: version citations record the filtered projection of the stored version; empty, missing and refused reads', async () => {
  const uid = await study();
  const finding = randomUUID(), hidden = randomUUID();
  // A readable finding: its one source item stays inside this study (the stored shape needs one to eight sources).
  // `hidden` names no stored finding, so the caller cannot read it.
  await ctx.witness.finding.create({ data: { id: finding, studyUid: uid, authorSub: sub, authorActor: actor, revision: 1,
    hidden: false, snapshot: { sources: [{ kind: 'item', studyUid: uid, itemId: randomUUID(), revision: 1 }] }, updatedAt: new Date() } });
  const line = 'SYN cited line', secret = 'SYN-HIDDEN-SENTENCE-' + randomUUID();
  const entry = (findingId, insertedText) => ({ v: 2, cid: randomUUID(), field: 'findings', findingId, findingRevision: 1, sourceIndex: 0,
    sourceRef: { kind: 'item', itemId: randomUUID(), sourceRevision: 1 }, linkStateAtInsert: 'current', headRevisionAtInsert: 1,
    insertedText, insertedAt: '2026-10-25T00:00:00.000Z', insertedBy: actor });
  const v1 = await version(uid, 1, { action: 'save', findings: 'SYN first' });
  const v2 = await version(uid, 2, { findings: line + '\n' + secret, citations: [entry(finding, line), entry(hidden, secret)] });
  const path2 = '/studies/' + encodeURIComponent(uid) + '/report/versions/2/citations';
  const answer = await get(path2);
  assert.equal(answer.status, 200, answer.text);
  const { accessRef, ...projection } = answer.body;
  assert.match(accessRef, UUID4);
  assert.deepEqual(projection, { version: 2, actor, entries: [
    { field: 'findings', findingRevision: 1, sourceIndex: 0, linkStateAtInsert: 'current', insertedAt: '2026-10-25T00:00:00.000Z',
      insertedBy: actor, presence: 'present' },
    { field: 'findings', insertedAt: '2026-10-25T00:00:00.000Z', insertedBy: actor, state: 'source-unavailable' }] });
  for (const value of [hidden, secret, finding, line]) assert.equal(answer.text.includes(value), false, 'no finding id or sentence on the wire');
  let recorded = await settled(uid, 1);
  const [opened] = recorded.filter(e => e.eventId === accessRef);
  assertAttribution(opened.event, 'GET studies/:uid/report/versions/:version/citations');
  assert.deepEqual(opened.event.targets, [{ kind: 'report-evidence', studyId: { status: 'known', value: uid },
    recordId: { status: 'known', value: String(v2.id) }, versionId: { status: 'known', value: '2' },
    sourcePatientId: { status: 'known', value: 'SYN-PID-1' }, sourceInstitution: { status: 'unresolved', reason: 'not-observed' },
    projectionSha256: sha(JSON.stringify(answer.body)) }], 'the target is the stored version and the filtered answer');
  for (const value of [hidden, secret, finding, line]) assert.equal(opened.payload.includes(value), false, 'nothing hidden enters the record');
  assert.deepEqual(recorded.filter(e => e.event.relatedEventId === accessRef).map(e => e.event.action), ['transfer-ended']);

  // An existing version with no citations is that version's read with an empty projection; never a 404.
  const empty = await get('/studies/' + encodeURIComponent(uid) + '/report/versions/1/citations');
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual(empty.body.entries, []);
  recorded = await settled(uid, 2);
  const emptyRecord = recorded.find(e => e.eventId === empty.body.accessRef);
  assert.equal(emptyRecord.event.targets[0].recordId.value, String(v1.id));
  assert.equal(emptyRecord.event.targets[0].projectionSha256, sha(JSON.stringify(empty.body)));

  // Refusals keep their status and record nothing: a missing version, a non-canonical number.
  const before = (await events(uid)).length;
  assert.equal((await get('/studies/' + encodeURIComponent(uid) + '/report/versions/9/citations')).status, 404);
  assert.equal((await get('/studies/' + encodeURIComponent(uid) + '/report/versions/01/citations')).status, 400);
  assert.equal((await events(uid)).length, before, 'a refused read records no provide-prepared and no transfer');

  // The head read and the history list are separate surfaces: the head citations read is unchanged and unrecorded.
  const head = await get('/studies/' + encodeURIComponent(uid) + '/report/citations');
  assert.equal(head.status, 200, head.text);
  assert.deepEqual(Object.keys(head.body).sort(), ['draft', 'draftRevision', 'head', 'version']);
  const [headRecords] = await ctx.witness.$queryRaw`SELECT count(*)::int AS n FROM emr_access.access_entry
    WHERE payload::jsonb->>'surface' = 'GET studies/:uid/report/citations'`;
  assert.equal(headRecords.n, 0);
});

test('A-HTTP-REPORT / A-HTTP-BODY: an empty history and every refusal keep their answer and record nothing', async () => {
  const empty = await study({ rs: 'W' });
  const listed = await get('/studies/' + encodeURIComponent(empty) + '/report/versions');
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(listed.body, []);
  const preliminary = await study({ rs: 'P', preDoc: 'synthetic-writer@example.test', preReviewer: 'synthetic-senior@example.test' });
  await version(preliminary, 1, { action: 'preliminary', findings: 'SYN preliminary' });
  const foreign = await study({ institutionId: foreignInstitution });
  await version(foreign, 1, { findings: 'SYN foreign' });
  const shared = await study();
  await version(shared, 1, { findings: 'SYN shared uid' });
  ctx.split.add(shared);
  const cases = [[preliminary, 403], [foreign, 404], [shared, 409]];
  for (const [uid, status] of cases) {
    for (const suffix of ['/report/versions', '/report/versions/1/citations']) {
      const refused = await get('/studies/' + encodeURIComponent(uid) + suffix);
      assert.equal(refused.status, status, suffix + ' ' + refused.text);
      assert.equal(refused.text.includes('SYN'), false, 'no report text in a refusal');
    }
  }
  for (const uid of [empty, preliminary, foreign, shared]) assert.deepEqual(await events(uid), [], 'no synthetic or refused target');
});

test('A-PG-COMMIT: a failure on the last target refuses the whole body and keeps the prior COMMIT with its abort', async () => {
  const uid = await study();
  const sentinel = 'SYN-REFUSED-BODY-' + randomUUID();
  const newest = await version(uid, 2, { findings: sentinel + ' v2' });
  const last = await version(uid, 1, { action: 'save', findings: sentinel + ' v1' });
  // Fixture-owned ordinary SQL failure for the last returned row (the list is newest first).
  await ctx.witness.$executeRawUnsafe(`ALTER TABLE emr_access.access_entry ADD CONSTRAINT a2_fixture_refusal
    CHECK (payload::jsonb->'targets'->0->'studyId'->>'value' <> '${uid}' OR payload::jsonb->'targets'->0->'recordId'->>'value' <> '${last.id}')`);
  try {
    const refused = await get('/studies/' + encodeURIComponent(uid) + '/report/versions');
    assert.equal(refused.status, 503, refused.text);
    assert.equal(refused.body.code, 'EMR_VIEWING_UNAVAILABLE');
    assert.equal(refused.text.includes(sentinel), false, 'no clinical body without every record');
    const recorded = await settled(uid, 1);
    assert.deepEqual(recorded.map(e => [e.event.targets[0].recordId.value, e.event.action]).sort(),
      [[String(newest.id), 'provide-prepared'], [String(newest.id), 'transfer-aborted']].sort(),
      'the committed earlier target stays with its abort; the refused target has no row');
  } finally {
    await ctx.witness.$executeRawUnsafe('ALTER TABLE emr_access.access_entry DROP CONSTRAINT a2_fixture_refusal');
  }
});

test('A-HTTP-OUTCOME: a client that leaves before the COMMIT gets no body; the late COMMIT is kept with its abort', async () => {
  const uid = await study();
  await version(uid, 1, { findings: 'SYN late commit' });
  const hold = holdLedger();
  await hold.locked;
  let answered = false;
  try {
    const pending = call('/studies/' + encodeURIComponent(uid) + '/report/versions', { onResponse: () => { answered = true; } });
    const failed = pending.done.then(() => 'answered', () => 'left');
    await runtimeWaitsOnLock();
    pending.req.destroy();
    assert.equal(await failed, 'left');
  } finally { await hold.release(); }
  const recorded = await settled(uid, 1);
  assert.deepEqual(recorded.map(e => e.event.action), ['provide-prepared', 'transfer-aborted']);
  assert.equal(answered, false);
});

test('A-HTTP-BODY: a policy change caught by the outer access check after preparation is an abort, never a transfer', async () => {
  const uid = await study();
  const sentinel = 'SYN-POLICY-BODY-' + randomUUID();
  await version(uid, 1, { findings: sentinel });
  const hold = holdLedger();
  await hold.locked;
  try {
    const pending = call('/studies/' + encodeURIComponent(uid) + '/report/versions');
    await runtimeWaitsOnLock();
    // The request already passed its own gates; StudyAccessInterceptor compares the policy snapshot after the handler.
    // A policy row of another institution for this subject is the existing "needs institution review" scope change.
    await ctx.witness.studyAccessPolicy.create({ data: { institution: foreignInstitution, subject: sub, revision: 1,
      policy: { version: 1, restricted: true, startsAt: null, endsAt: null, rules: [] }, reason: 'SYN institution review',
      updatedBy: 'synthetic-admin' } });
    await hold.release();
    const refused = await pending.done;
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.code, 'STUDY_ACCESS_CHANGED');
    assert.equal(refused.text.includes(sentinel), false);
    const recorded = await settled(uid, 1);
    assert.deepEqual(recorded.map(e => e.event.action), ['provide-prepared', 'transfer-aborted']);
  } finally {
    await hold.release();
    await ctx.witness.studyAccessPolicy.deleteMany({ where: { institution: foreignInstitution, subject: sub } });
  }
});

test('A-PG-COMMIT: a lost COMMIT reply resolves through the same operation; no new attempt, one record, then the body', async () => {
  const uid = await study();
  await version(uid, 1, { findings: 'SYN lost reply' });
  ctx.relay.arm(uid);
  const answer = await get('/studies/' + encodeURIComponent(uid) + '/report/versions');
  assert.equal(ctx.relay.lost, 1, 'the relay lost exactly one COMMIT reply');
  assert.equal(answer.status, 200, answer.text);
  const [row] = answer.body;
  const recorded = await settled(uid, 1);
  const opened = recorded.filter(e => e.event.action === 'provide-prepared');
  assert.deepEqual(opened.map(e => e.eventId), [row.accessRef], 'one record for the read, none re-appended under a new ID');
  const [attempts] = await ctx.witness.$queryRaw`SELECT count(*)::int AS n FROM emr_access.attempt WHERE operation_id = ${opened[0].operationId}::uuid`;
  assert.equal(attempts.n, 1, 'the unknown COMMIT was resolved by the same operation, not by a new attempt');
  const [unknown] = await ctx.witness.$queryRaw`SELECT count(*)::int AS n FROM emr_access.failure_entry
    WHERE event_id = ${row.accessRef} AND cause = 'commit-unknown'`;
  assert.equal(unknown.n, 1, 'B2 kept the truthful unknown before resolving it');
  assert.deepEqual(recorded.filter(e => e.event.relatedEventId === row.accessRef).map(e => e.event.action), ['transfer-ended']);
});

// The same UID is read in new requests as its source changes; no older observation or local institution substitutes for it.
test('A-HTTP-REPORT source identities: retain observed values, and only absent values stay unresolved', async () => {
  const uid = await study();
  await version(uid, 1);
  const unknown = { status: 'unresolved', reason: 'not-observed' };
  for (const [patient, sourceInstitution, noResource] of [
    [' SYN-PID-observed ', 'SYN source hospital', false],
    [null, 'SYN source only', false], ['SYN patient only', null, false],
    ['  ', '', false], [null, null, true],
  ]) {
    const row = { '0020000D': { vr: 'UI', Value: [uid] } };
    if (patient !== null) row['00100020'] = { vr: 'LO', Value: [patient] };
    if (sourceInstitution !== null) row['00080080'] = { vr: 'LO', Value: [sourceInstitution] };
    ctx.sourceRows.set(uid, noResource ? [] : [row]);
    for (const suffix of ['/versions', '/versions/1/citations']) {
      const answer = await get('/studies/' + uid + '/report' + suffix);
      assert.equal(answer.status, 200, answer.text);
      const accessRef = Array.isArray(answer.body) ? answer.body[0].accessRef : answer.body.accessRef;
      const recorded = await events(uid);
      const prepared = recorded.find(entry => entry.event.eventId === accessRef);
      assert.ok(prepared, 'the returned access reference identifies its committed source observation');
      assert.deepEqual(prepared.event.targets[0].sourcePatientId, patient?.trim() ? { status: 'known', value: patient } : unknown);
      assert.deepEqual(prepared.event.targets[0].sourceInstitution, sourceInstitution?.trim() ? { status: 'known', value: sourceInstitution } : unknown);
      assert.equal(prepared.event.managingInstitution.value, institution);
    }
  }
});

// A-016..038 remaining read consumers: real production controllers and PG receipts, never a fixture endpoint.
async function consumerStudy(fields = {}) {
  const uid = await study(fields);
  ctx.sourceRows.set(uid, [{ '0020000D': { Value: [uid] }, '00100020': { Value: ['SYN-CONSUMER-PID'] },
    '00100010': { Value: [{ Alphabetic: 'SYN^CONSUMER' }] }, '00080080': { Value: ['SYN-SOURCE-SITE'] },
    '00080020': { Value: ['20261026'] }, '00080061': { Value: ['CT'] } }]);
  return uid;
}
async function readRecorded(route, uid, options = {}) {
  const before = new Set((await events(uid)).map(e => e.eventId));
  const answer = await call(route, options).done;
  assert.equal(answer.status, 200, answer.text);
  const selected = (await prepared(uid)).filter(e => !before.has(e.eventId));
  for (const row of selected) assert.deepEqual(parseAccessEvent(row.event), row.event);
  await settled(uid, (await prepared(uid)).length);
  return { answer: answer.body, selected: selected.map(e => e.event) };
}
function targetOf(events, kind) { return events.filter(e => e.targets[0].kind === kind).map(e => e.targets[0]); }

test('A-REMAINDER worklist: returned page, own draft, hidden preliminary, and original source attribution', async () => {
  const uid = await consumerStudy();
  await version(uid, 1, { findings: 'SYN approved' });
  await ctx.witness.report.create({ data: { uid, version: 1, findings: 'SYN approved' } });
  await ctx.witness.reportDraft.create({ data: { uid, author: actor, findings: 'SYN private', revision: 3 } });
  await ctx.witness.reportDraft.create({ data: { uid, author: 'other@example.test', findings: 'SYN other draft' } });
  const hidden = await consumerStudy({ rs: 'P', preDocSub: 'other-author', preReviewerSub: 'other-reviewer' });
  await ctx.witness.report.create({ data: { uid: hidden, version: 2, findings: 'SYN withheld' } });
  const { answer, selected } = await readRecorded('/studies?limit=100', uid);
  const row = answer.studies.find(r => r.uid === uid);
  assert.equal(row.state.findings, 'SYN approved'); assert.equal(row.state.draft.findings, 'SYN private');
  assert.equal(JSON.stringify(answer).includes('SYN other draft'), false);
  assert.equal(JSON.stringify(answer).includes('SYN withheld'), false);
  assert.equal(targetOf(selected, 'report-head').length, 1);
  assert.equal(targetOf(selected, 'private-draft')[0].versionId.value, row.state.draftRevision);
  const metadata = targetOf(selected, 'study-metadata')[0];
  assert.equal(metadata.sourcePatientId.value, 'SYN-CONSUMER-PID');
  assert.equal(metadata.sourceInstitution.value, 'SYN-SOURCE-SITE');
  assert.equal(metadata.projectionSha256, sha(JSON.stringify(row)));
  assert.equal(targetOf((await prepared(hidden)).map(e => e.event), 'report-head').length, 0);
  const boot = await readRecorded('/bootstrap', uid);
  assert.equal(targetOf(boot.selected, 'report-head').length, 1);
  assert.equal(targetOf(boot.selected, 'private-draft').length, 1);
  const lean = await readRecorded('/bootstrap?states=omit', uid);
  assert.equal(lean.selected.length, 0, 'omitted states are not served records');
});

test('A-REMAINDER preview, report evidence, keys and revisions preserve the exact selected body', async () => {
  const uid = await consumerStudy();
  const stored = await version(uid, 1, { findings: 'SYN preview' });
  await ctx.witness.report.create({ data: { uid, version: 1, findings: stored.findings } });
  const item = { schemaVersion: 1, kind: 'key', seriesUid: uid + '.1', sopUid: uid + '.1.1', frame: 1,
    title: 'SYN KEY', description: 'SYN key description' };
  const id = randomUUID();
  await ctx.witness.viewerItem.create({ data: { id, studyUid: uid, authorSub: sub, authorActor: actor,
    revision: 1, snapshot: item, updatedAt: new Date() } });
  const payload = JSON.stringify(item);
  await ctx.witness.$executeRaw`INSERT INTO "ViewerRevision" ("itemId",revision,snapshot,action,reason,actor,"payloadBytes")
    VALUES (${id}::uuid,1,${payload}::jsonb,'create','',${actor},octet_length(convert_to((${payload}::jsonb)::text,'UTF8')))`;
  ctx.instances.set(item.sopUid, { StudyInstanceUID: uid, SeriesInstanceUID: item.seriesUid, SOPInstanceUID: item.sopUid });
  const lookup = await readRecorded('/dicom/lookup', uid, { method: 'POST', body: { studyUid: uid, sopUid: item.sopUid } });
  assert.equal(targetOf(lookup.selected, 'study-metadata')[0].recordId.value, lookup.answer.id);
  assert.equal(targetOf(lookup.selected, 'study-metadata')[0].projectionSha256, sha(JSON.stringify(lookup.answer)));
  const preview = await readRecorded('/studies/' + uid + '/report-preview', uid);
  assert.equal(preview.answer.report.findings, stored.findings);
  assert.equal(targetOf(preview.selected, 'report-head')[0].projectionSha256, sha(JSON.stringify(preview.answer.report)));
  assert.equal(targetOf(preview.selected, 'key-image')[0].recordId.value, id);
  for (const route of ['citations', 'structure']) {
    const evidence = await readRecorded('/studies/' + uid + '/report/' + route, uid);
    assert.equal(targetOf(evidence.selected, 'report-evidence')[0].projectionSha256, sha(JSON.stringify(evidence.answer.head)));
  }
  const marks = await readRecorded('/studies/' + uid + '/viewer-items?limit=20', uid);
  assert.equal(targetOf(marks.selected, 'key-image')[0].projectionSha256, sha(JSON.stringify(marks.answer.items[0])));
  const revisions = await readRecorded('/studies/' + uid + '/viewer-items/' + id + '/revisions?limit=20', uid);
  assert.equal(targetOf(revisions.selected, 'key-image')[0].projectionSha256, sha(JSON.stringify(revisions.answer.revisions[0])));
  const clinical = await readRecorded('/clinician/studies/' + uid + '/report', uid, { token: ctx.clinicianToken });
  assert.equal(targetOf(clinical.selected, 'report-version')[0].recordId.value, String(stored.id));
  assert.equal(targetOf(clinical.selected, 'key-image').length, 1);
  const list = await readRecorded('/clinician/studies?limit=100', uid, { token: ctx.clinicianToken });
  assert.equal(targetOf(list.selected, 'report-head').length, 0, 'clinician list has status, not report text');
  const timeline = await readRecorded('/clinician/studies/' + uid + '/timeline?limit=100', uid, { token: ctx.clinicianToken });
  assert.equal(targetOf(timeline.selected, 'study-metadata').length, 2);
});

test('A-REMAINDER: preview waits for all PG receipts before its first clinical byte', async () => {
  const uid = await consumerStudy();
  await version(uid, 1, { findings: 'SYN delayed preview' });
  await ctx.witness.report.create({ data: { uid, version: 1, findings: 'SYN delayed preview' } });
  const hold = holdLedger(); await hold.locked;
  let first = null;
  try {
    const pending = call('/studies/' + uid + '/report-preview', { onResponse: async () => { first = (await prepared(uid)).length; } });
    await runtimeWaitsOnLock(); assert.equal(first, null);
    await hold.release(); assert.equal((await pending.done).status, 200);
    assert.equal(first, 2);
  } finally { await hold.release(); }
});


test('A-REMAINDER comparison preview/list/restore identify the saved revision', async () => {
  const uid = await consumerStudy(), prior = await consumerStudy();
  const id = randomUUID(), cell = { study: uid, series: uid + '.1', sop: uid + '.1.1', frame: 1,
    camera: { focalPoint: [0,0,0], position: [0,0,1], viewUp: [0,1,0], viewPlaneNormal: [0,0,1], parallelScale: 1,
      rotation: 0, flipHorizontal: false, flipVertical: false },
    properties: { voiRange: { lower: 0, upper: 100 }, VOILUTFunction: 'LINEAR', invert: false, interpolationType: 1 },
    viewport: { width: 256, height: 256 } };
  ctx.instances.set(cell.sop, { StudyInstanceUID: uid, SeriesInstanceUID: cell.series, SOPInstanceUID: cell.sop,
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.2', Modality: 'CT', PatientID: 'SYN-CONSUMER-PID', ImageOrientationPatient: '1\\0\\0\\0\\1\\0',
    ImagePositionPatient: '0\\0\\0' });
  const snapshot = { version: 2, studies: [uid, prior], rows: 1, cols: 2, active: 0, cells: [cell, null] };
  const preview = await readRecorded('/studies/' + uid + '/viewer-jobs/preview', uid, { method: 'POST', body: { snapshot } });
  assert.equal(targetOf(preview.selected, 'comparison-layout')[0].versionId.status, 'unresolved');
  snapshot.cells[0] = { ...cell, sourceDigest: 'a'.repeat(32) };
  await ctx.witness.viewerJob.create({ data: { id, studyUid: uid, studies: [uid, prior], authorSub: sub, authorActor: actor,
    fingerprint: 'synthetic', snapshot, title: 'SYN comparison', description: 'SYN description', revision: 1, updatedAt: new Date() } });
  const list = await readRecorded('/studies/' + uid + '/viewer-jobs', uid);
  assert.equal(targetOf(list.selected, 'comparison-description')[0].recordId.value, id);
  const restored = await readRecorded('/studies/' + uid + '/viewer-jobs/' + id, uid);
  const layout = targetOf(restored.selected, 'comparison-layout')[0];
  assert.equal(layout.recordId.value, id); assert.equal(layout.versionId.value, '1');
  assert.equal(layout.projectionSha256, sha(JSON.stringify(restored.answer.snapshot)));
  assert.equal(targetOf(restored.selected, 'comparison-description').length, 1);
  assert.equal((await prepared(prior)).some(e => e.event.targets[0].recordId.value === id), true);
});


if (process.env.KIN_A_BROWSER_PYTHON) test('A-REMAINDER real served worklist renders recorded HTTP data', async () => {
  await consumerStudy();
  const { spawn } = require('node:child_process');
  const output = path.resolve(__dirname, '../../../tmp/module-a-consumers/browser');
  const sid = randomUUID();
  await ctx.witness.authSession.create({ data: { sid, sub, institution, accessToken: ctx.token, refreshToken: 'SYN-refresh',
    idpSid: 'synthetic-report-session', atExpiresAt: new Date(jose.decodeJwt(ctx.token).exp * 1000), lastSeenAt: new Date() } });
  const child = spawn(process.env.KIN_A_BROWSER_PYTHON, [path.join(__dirname, 'consumer_browser.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(JSON.stringify({ origin: ctx.origin, sid, output }));
  let log = ''; child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.equal(code, 0, log);
});


test('A-REMAINDER critical-result full and status-only reads record only their actual projection', async () => {
  const uid = await consumerStudy();
  const source = await version(uid, 1, { findings: 'SYN critical pinned report' });
  await ctx.witness.report.create({ data: { uid, version: 1, findings: source.findings } });
  const id = randomUUID();
  await ctx.witness.criticalResult.create({ data: { id, studyUid: uid, institutionId: institution,
    senderInstitutionId: institution, senderSub: sub, senderActor: actor, senderName: 'Synthetic Reader',
    recipientSub: 'synthetic-consumer-clinician', recipientActor: 'synthetic-consumer-clinician@example.test',
    recipientName: 'Synthetic Clinician', recipientRole: 'clinician', sourceVersion: 1, sourceAction: 'approve',
    sourceAuthor: actor, sourceAt: source.at, origName: 'SYN CONSUMER', origPatientId: 'SYN-CONSUMER-PID',
    origBirth: '', origStudyDate: '20261026', message: 'SYN critical message', state: 'created', revision: 1, changedBy: actor,
    updatedAt: new Date() } });
  const full = await readRecorded('/critical-results/' + id, uid, { token: ctx.clinicianToken });
  assert.equal(full.answer.item.body.findings, source.findings);
  assert.equal(targetOf(full.selected, 'critical-result')[0].recordId.value, id);
  assert.equal(targetOf(full.selected, 'report-version')[0].recordId.value, String(source.id));
  assert.equal(targetOf(full.selected, 'report-version')[0].projectionSha256, sha(JSON.stringify(full.answer.item.body)));
  const list = await readRecorded('/critical-results?view=received', uid, { token: ctx.clinicianToken });
  assert.equal(targetOf(list.selected, 'report-version').length, 1);
  const studyList = await readRecorded('/studies/' + uid + '/critical-results', uid);
  assert.equal(targetOf(studyList.selected, 'critical-result').length, 1);
  assert.equal(Object.hasOwn(studyList.answer.items[0], 'body'), false);
  assert.equal(targetOf(studyList.selected, 'report-version').length, 0);
  await ctx.witness.studyState.update({ where: { uid }, data: { rs: 'W' } });
  const beforeRefusal = (await prepared(uid)).length;
  assert.equal((await call('/critical-results/' + id, { token: ctx.clinicianToken }).done).status, 404);
  assert.equal((await prepared(uid)).length, beforeRefusal);
  await version(uid, 2, { action: 'reset' });
  await ctx.witness.report.update({ where: { uid }, data: { version: 2 } });
  const status = await readRecorded('/critical-results/' + id, uid, { token: ctx.clinicianToken });
  assert.equal(Object.hasOwn(status.answer.item, 'body'), false);
  assert.equal(targetOf(status.selected, 'critical-result').length, 1);
  assert.equal(targetOf(status.selected, 'report-version').length, 0);
});

test('A-REMAINDER bootstrap records an unlinked order without inventing a study', async () => {
  const oid = 'SYN-ORDER-' + randomUUID();
  await ctx.witness.order.create({ data: { oid, institutionId: institution, patientId: 'SYN-ORDER-PATIENT', name: 'SYN ORDER',
    sex: '', birth: '', sched: '', modality: 'CT', descr: '', ward: '', reqDoc: '' } });
  const answer = await get('/bootstrap?states=omit');
  assert.equal(answer.status, 200, answer.text);
  const rows = await ctx.witness.$queryRaw`SELECT payload FROM emr_access.access_entry
    WHERE payload::jsonb->'targets'->0->'recordId'->>'value'=${oid} AND payload::jsonb->>'action'='provide-prepared'`;
  assert.equal(rows.length, 1);
  const target = JSON.parse(rows[0].payload).targets[0];
  assert.equal(target.kind, 'order'); assert.deepEqual(target.studyId, { status: 'unresolved', reason: 'not-observed' });
  assert.equal(target.projectionSha256, sha(JSON.stringify(answer.body.orders.find(o => o.oid === oid))));
});


test('A-REMAINDER organization: returned folders and catalogs retain only visible UIDs and their actual revisions', async () => {
  const uid = await consumerStudy(), hidden = await study({ institutionId: 'synthetic-other-site' });
  const item = { id: require('node:crypto').randomUUID(), name: 'SYN organization', uids: [uid, hidden] };
  await ctx.witness.favoriteWorkspace.upsert({ where: { institution_subject: { institution, subject: sub } },
    create: { institution, subject: sub, revision: 3, value: JSON.stringify([item]) },
    update: { revision: 3, value: JSON.stringify([item]) } });
  for (const [ownerSub, revision] of [[sub, 4], ['', 5]])
    await ctx.witness.studyTagCatalog.upsert({ where: { institution_ownerSub: { institution, ownerSub } },
      create: { institution, ownerSub, revision, value: JSON.stringify([item]) }, update: { revision, value: JSON.stringify([item]) } });
  const ledger = async surface => (await ctx.witness.$queryRaw`SELECT payload FROM emr_access.access_entry
    WHERE payload::jsonb->>'surface' = ${surface} AND payload::jsonb->>'action' = 'provide-prepared' ORDER BY sequence`)
    .map(row => JSON.parse(row.payload));
  for (const [route, count] of [['favorite-folders', 1], ['study-tags', 2]]) {
    const surface = 'GET ' + route, before = (await ledger(surface)).length;
    const answer = await get('/' + route);
    assert.equal(answer.status, 200, answer.text);
    const records = (await ledger(surface)).slice(before);
    assert.equal(records.length, count);
    const projections = route === 'favorite-folders'
      ? [{ revision: answer.body.revision, folders: answer.body.folders }] : answer.body.catalogs;
    const returned = route === 'favorite-folders' ? answer.body.folders : answer.body.catalogs.flatMap(c => c.tags);
    assert(returned.every(item => item.uids.includes(uid) && !item.uids.includes(hidden)));
    records.forEach((event, index) => {
      assertAttribution(event, surface);
      const target = event.targets[0];
      assert.equal(target.kind, 'study-organization');
      assert.equal(target.versionId.value, String(projections[index].revision));
      assert.equal(target.projectionSha256, sha(JSON.stringify(projections[index])));
      assert.deepEqual(target.studyId, { status: 'unresolved', reason: 'not-observed' });
      assert.deepEqual(target.sourcePatientId, { status: 'unresolved', reason: 'not-observed' });
      const owner = route === 'favorite-folders' ? ['FavoriteWorkspace', institution, sub]
        : ['StudyTagCatalog', institution, projections[index].scope === 'personal' ? sub : ''];
      assert.equal(target.recordId.value, JSON.stringify(owner));
    });
  }
});
