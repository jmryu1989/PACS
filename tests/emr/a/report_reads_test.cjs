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
  const split = new Set(), sourceRows = new Map();
  // Synthetic external collaborators: the OIDC key set and Orthanc's QIDO study answer (one resource per UID, two for a
  // UID two patients share).
  const provider = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/certs') return res.end(JSON.stringify({ keys: [jwk] }));
    const url = new URL(req.url, 'http://synthetic');
    if (url.pathname === '/dicom-web/studies' && url.searchParams.get('StudyInstanceUID')) {
      const uid = url.searchParams.get('StudyInstanceUID');
      const row = patient => ({ '0020000D': { vr: 'UI', Value: [uid] }, '00100020': { vr: 'LO', Value: [patient] } });
      return res.end(JSON.stringify(sourceRows.get(uid) ?? (split.has(uid) ? [row('SYN-PID-1'), row('SYN-PID-2')] : [row('SYN-PID-1')])));
    }
    res.statusCode = 404; res.end('{}');
  });
  await listen(provider);
  const providerUrl = 'http://127.0.0.1:' + provider.address().port;
  Object.assign(process.env, { KC_ISSUER: issuer, KC_AUDIENCE: 'kin-api', AUTH_REQUIRED: 'true',
    KIN_COOKIE_SECRET: randomUUID(), KC_WEB_SECRET: randomUUID(), PUBLIC_ORIGIN: 'https://synthetic.invalid',
    KC_JWKS_URL: providerUrl + '/certs', ORTHANC_URL: providerUrl, ORTHANC_USER: 'synthetic', ORTHANC_PASS: randomUUID() });
  const token = await new jose.SignJWT({ email: actor, realm_access: { roles: ['radiologist'] }, groups: ['/' + institution] })
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
  const app = await NestFactory.create(AppModule.withLedger(runtime, { proxyPeers: ['127.0.0.1'] }), { logger: ['error'], abortOnError: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  ctx = { witness, runtime, app, provider, relay, split, sourceRows, origin, token };
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
function call(pathname, { onResponse } = {}) {
  let req;
  const done = new Promise((resolve, reject) => {
    req = http.request(ctx.origin + '/api' + pathname, { headers: { authorization: 'Bearer ' + ctx.token, 'x-real-ip': CLIENT_IP } }, res => {
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
    req.end();
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
      assert.equal(answer.status, 200);
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
