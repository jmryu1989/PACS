"""A4 display report on the real Guard/HTTP/PG boundary (REQ-A-OBSERVE / A-HTTP-OBSERVE).

The production AppModule.withLedger serves POST studies/:uid/view-observations beside A2's real report reads on the
accepted B2 synthetic PG fixture; an independent witness connection reads the ledger back. Only external collaborators
are synthetic (OIDC keys, the Orthanc QIDO answer, a TCP relay in front of the ledger connection). SQL locks, a lost
COMMIT reply, a closed record port and an API restart on the same database make the ordinary schedules. The served
page's renderer (which displays and reports) belongs to A5 and is not proven here.
The Node driver is embedded so the single A4 entry point is self-contained (A3's form).
"""
import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/emr/b'))
from pg_ledger_restore_test import PgLedgerFixture

EVIDENCE = ROOT / 'tmp/emr-a/report-observation'

DRIVER = r"""
'use strict';
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
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
const { AuthService } = require(path.join(build, 'auth.service.js'));
const { parseAccessEvent } = require(path.join(build, 'emr-contract/access-event.js'));

const pause = () => new Promise(resolve => setTimeout(resolve, 25));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(() => resolve()));
const issuer = 'https://synthetic.invalid/realms/module-a-observations';
const site = 'synthetic-a4-site', foreignSite = 'synthetic-a4-other-site';
const CLIENT_IP = '192.0.2.44';
const SURFACE = 'POST studies/:uid/view-observations';
const members = {
  reader: { sub: 'synthetic-a4-reader', roles: ['radiologist'] },
  other: { sub: 'synthetic-a4-other-reader', roles: ['radiologist'] },
  clinician: { sub: 'synthetic-a4-clinician', roles: ['clinician'] },
};
// Orthanc 1.12.5 answers the PS3.18 default study attributes plus the tags includefield names (measured, R229-B6-01).
const QIDO_STUDY_DEFAULTS = new Set(['00080005', '00080020', '00080030', '00080050', '00080056', '00080061', '00080090',
  '00080201', '00081190', '00100010', '00100020', '00100030', '00100040', '0020000D', '00200010', '00201206', '00201208']);
const sourceRow = uid => ({ '0020000D': { vr: 'UI', Value: [uid] }, '00100020': { vr: 'LO', Value: ['SYN-A4-PID'] },
  '00100010': { vr: 'PN', Value: [{ Alphabetic: 'SYN^A4' }] }, '00080080': { vr: 'LO', Value: ['SYN A4 Source'] },
  '00080020': { vr: 'DA', Value: ['20261026'] }, '00080061': { vr: 'CS', Value: ['CT'] },
  '00081030': { vr: 'LO', Value: ['SYN A4 study'] }, '00080050': { vr: 'SH', Value: ['SYN-A4-ACC'] } });

/** The ledger client's PostgreSQL connections; an armed marker loses the COMMIT reply of the first transaction carrying it. */
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
async function startApi() {
  // The ledger client (B2 runtime) goes through the relay; ordinary API reads (PrismaService) use DATABASE_URL directly.
  const runtime = new EmrRuntime(ctx.relayed, process.env.KIN_B2R_SPOOL);
  await runtime.start();
  const app = await NestFactory.create(AppModule.withLedger(runtime, { proxyPeers: ['127.0.0.1'] }),
    { rawBody: true, logger: ['error'], abortOnError: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  Object.assign(ctx, { runtime, app, origin: await app.getUrl(), auth: app.get(AuthService) });
}
async function stopApi() {
  await ctx.app.close();
  await ctx.runtime.stop(Date.now() + 15000);
}
before(async () => {
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  const jwk = { ...await jose.exportJWK(publicKey), kid: 'module-a-observations', alg: 'RS256', use: 'sig' };
  const provider = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/certs') return res.end(JSON.stringify({ keys: [jwk] }));
    const url = new URL(req.url, 'http://synthetic');
    if (url.pathname === '/dicom-web/studies' && url.searchParams.get('StudyInstanceUID')) {
      const uid = url.searchParams.get('StudyInstanceUID');
      const named = new Set(url.searchParams.getAll('includefield').flatMap(v => v.split(',')).map(tag => tag.trim().toUpperCase()));
      const row = Object.fromEntries(Object.entries(sourceRow(uid)).filter(([tag]) => QIDO_STUDY_DEFAULTS.has(tag) || named.has(tag)));
      return res.end(JSON.stringify([row]));
    }
    res.statusCode = 404; res.end('{}');
  });
  await listen(provider);
  const providerUrl = 'http://127.0.0.1:' + provider.address().port;
  Object.assign(process.env, { KC_ISSUER: issuer, KC_AUDIENCE: 'kin-api', AUTH_REQUIRED: 'true',
    KIN_COOKIE_SECRET: randomUUID(), KC_WEB_SECRET: randomUUID(), PUBLIC_ORIGIN: 'https://synthetic.invalid',
    KC_JWKS_URL: providerUrl + '/certs', ORTHANC_URL: providerUrl, ORTHANC_USER: 'synthetic', ORTHANC_PASS: randomUUID() });
  const witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_B2R_WITNESS_URL } } });
  await witness.$connect();
  await witness.memberRightsImport.create({ data: { id: 'realm-v1' } });
  for (const institution of [site, foreignSite]) await witness.institution.create({ data: { id: institution, name: 'SYN ' + institution } });
  for (const member of Object.values(members)) {
    member.email = member.sub + '@example.test';
    await witness.memberRights.create({ data: { sub: member.sub, username: member.sub, email: member.email,
      name: 'Synthetic ' + member.sub, emailVerified: true, approved: true, suspended: false, institution: site, roles: member.roles } });
    member.token = await new jose.SignJWT({ email: member.email, realm_access: { roles: member.roles }, groups: ['/' + site] })
      .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer).setSubject(member.sub).setAudience('kin-api')
      .setIssuedAt().setExpirationTime('30m').sign(privateKey);
  }
  const ledgerUrl = new URL(process.env.DATABASE_URL);
  const relay = ledgerRelay(ledgerUrl.hostname, Number(ledgerUrl.port || 5432));
  await listen(relay.server);
  const relayed = new URL(process.env.DATABASE_URL);
  relayed.hostname = '127.0.0.1'; relayed.port = String(relay.server.address().port);
  ctx = { witness, provider, relay, relayed: relayed.toString() };
  await startApi();
});
after(async () => {
  if (!ctx) return;
  if (ctx.app) await stopApi();
  await ctx.relay.stop();
  await ctx.witness.$disconnect();
  await close(ctx.provider);
});

/** One real HTTP request. `onResponse` runs when the status line arrives, before the body is read. */
function send(method, pathname, { member, session, body, onResponse } = {}) {
  const headers = { 'x-real-ip': CLIENT_IP };
  if (member) headers.authorization = 'Bearer ' + member.token;
  if (session) Object.assign(headers, session.headers);
  let payload;
  if (body !== undefined) {
    payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    Object.assign(headers, { 'content-type': 'application/json', 'content-length': payload.length });
  }
  let req;
  const done = new Promise((resolve, reject) => {
    req = http.request(ctx.origin + '/api' + pathname, { method, headers }, res => {
      res.pause();
      Promise.resolve(onResponse?.(res)).then(() => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null; try { parsed = JSON.parse(text); } catch { /* asserted by the case */ }
          resolve({ status: res.statusCode, text, body: parsed });
        });
        res.on('error', reject);
        res.resume();
      }, reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
  return { req, done };
}
const observe = (uid, report, options = {}) =>
  send('POST', '/studies/' + encodeURIComponent(uid) + '/view-observations', { member: members.reader, ...options, body: report });
const report = (accessRef, overrides = {}) => ({ accessRef, eventId: randomUUID(), shownAt: new Date().toISOString(), ...overrides });

async function session(member) {
  const sid = randomUUID();
  await ctx.witness.authSession.create({ data: { sid, sub: member.sub, accessToken: member.token, refreshToken: randomUUID(),
    rightsVersion: 1, institution: site, atExpiresAt: new Date(Date.now() + 600000), lastSeenAt: new Date() } });
  return { sid, headers: { cookie: 'kin_sid=' + sid, 'x-kin-session': ctx.auth.sessionRef(sid), 'x-kin-csrf': '1' } };
}
const entries = async where => (await ctx.witness.$queryRawUnsafe(`SELECT e.event_id, e.operation_id::text AS operation_id,
    e.payload, e.recorded_at FROM emr_access.access_entry e WHERE ${where} ORDER BY e.sequence`))
  .map(row => ({ eventId: row.event_id, operationId: row.operation_id, recordedAt: row.recorded_at, event: JSON.parse(row.payload) }));
const shown = accessRef => entries(`e.payload::jsonb->>'action' = 'client-shown' AND e.payload::jsonb->>'relatedEventId' = '${accessRef}'`);
const allShown = async () => (await entries(`e.payload::jsonb->>'action' = 'client-shown'`)).length;
const forStudy = uid => entries(`e.payload::jsonb->'targets'->0->'studyId'->>'value' = '${uid}'`);
async function settled(uid) {
  // A read's transfer outcome is appended after its body; wait until every provision has its follow-up.
  for (;;) {
    const all = await forStudy(uid);
    const opened = all.filter(e => e.event.action === 'provide-prepared');
    if (opened.every(p => all.some(e => e.event.relatedEventId === p.eventId && e.event.action !== 'client-shown'))) return;
    await pause();
  }
}
async function runtimeWaitsOnLock() {
  for (;;) {
    const [row] = await ctx.witness.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='kin_runtime' AND wait_event_type='Lock'`;
    if (row.n) return;
    await pause();
  }
}
function holdLedger() {
  let release, entered;
  const locked = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const holding = ctx.witness.$transaction(async tx => {
    await tx.$executeRawUnsafe('LOCK TABLE emr_access.access_entry IN SHARE MODE');
    entered(); await gate;
  }, { timeout: 15000 }); // B2's existing transaction deadline.
  return { locked, release: () => { release(); return holding; } };
}
let seq = 0;
async function study(fields = {}) {
  const uid = '2.25.9404' + process.pid + (++seq);
  await ctx.witness.studyState.create({ data: { uid, institutionId: site, ss: 'Verified', rs: 'A', ...fields } });
  return uid;
}
const version = (uid, n, fields = {}) => ctx.witness.reportVersion.create({ data: { uid, version: n, action: 'approve',
  author: members.reader.email, findings: 'SYN findings ' + n, conclusion: '', recommendation: '', ...fields } });
/** A2's real report history read as this caller: the rows and their access references. */
async function history(uid, options = { member: members.reader }) {
  const answer = await send('GET', '/studies/' + encodeURIComponent(uid) + '/report/versions', options).done;
  assert.equal(answer.status, 200, answer.text);
  await settled(uid);
  return answer.body;
}
async function prepared(accessRef) {
  const [entry] = await entries(`e.event_id = '${accessRef}'`);
  assert.equal(entry.event.action, 'provide-prepared');
  return entry;
}
async function outcomeAt(operationId) {
  const [row] = await ctx.witness.$queryRaw`SELECT recorded_at FROM emr_access.attempt_outcome WHERE operation_id = ${operationId}::uuid AND outcome = 'committed'`;
  return row.recorded_at.toISOString();
}
function assertShown(entry, source, sent, binding) {
  const event = entry.event;
  assert.deepEqual(parseAccessEvent(event), event, 'a valid local-read event');
  assert.equal(event.branch, 'local-read');
  assert.equal(event.action, 'client-shown');
  assert.equal(event.result, 'reported');
  assert.equal(event.eventId, sent.eventId, 'the client display event ID');
  assert.equal(event.relatedEventId, source.eventId, 'the provision it displayed');
  assert.equal(event.occurredAt, sent.shownAt, 'the client-reported display time');
  assert.equal(event.surface, source.event.surface, 'the provision read surface, not the reporting transport');
  assert.deepEqual(event.targets, source.event.targets, 'the stored target, kind, version and projection, never the body');
  assert.deepEqual(event.managingInstitution, source.event.managingInstitution);
  assert.deepEqual(event.userId, source.event.userId);
  assert.deepEqual(event.actingInstitution, { status: 'known', value: site });
  assert.deepEqual(event.session, binding);
  assert.equal(event.cause, 'user-view');
  assert.deepEqual(event.trustedProxyIp, { status: 'known', value: { address: CLIENT_IP, source: 'trusted-proxy' } });
  assert.notEqual(event.requestId, source.event.requestId, 'the reporting request is a new request');
  assert.notEqual(event.auditLinkId, source.event.auditLinkId);
}
const BEARER = { method: 'bearer', sessionRef: null };

test('A-HTTP-OBSERVE: the ACK follows the COMMIT of a client-shown bound to the stored provision; client and server times stay apart', async () => {
  const uid = await study();
  await version(uid, 1, { action: 'save' });
  await version(uid, 2);
  const rows = await history(uid);
  const source = await prepared(rows[0].accessRef);
  const sent = report(rows[0].accessRef, { shownAt: '2026-10-26T01:02:03.004Z' });
  const hold = holdLedger();
  await hold.locked;
  let atFirstByte = null, ack;
  try {
    const pending = observe(uid, sent, { onResponse: async () => { atFirstByte = (await shown(source.eventId)).length; } });
    await runtimeWaitsOnLock();
    assert.equal(atFirstByte, null, 'no answer while the client-shown INSERT waits on PostgreSQL');
    assert.equal((await shown(source.eventId)).length, 0);
    await hold.release();
    ack = await pending.done;
  } finally { await hold.release(); }
  assert.equal(ack.status, 200, ack.text);
  assert.equal(atFirstByte, 1, 'the display record is committed before the acknowledgement');
  const [entry] = await shown(source.eventId);
  assertShown(entry, source, sent, BEARER);
  assert.deepEqual(Object.keys(ack.body).sort(), ['accessRef', 'eventId', 'receivedAt', 'shownAt']);
  assert.equal(ack.body.eventId, sent.eventId);
  assert.equal(ack.body.accessRef, source.eventId);
  assert.equal(ack.body.shownAt, sent.shownAt);
  assert.equal(ack.body.receivedAt, await outcomeAt(entry.operationId), 'the server reception time is B2 own commit time');
  assert.notEqual(ack.body.receivedAt, sent.shownAt);
  assert.equal(ack.text.includes('SYN findings'), false, 'the acknowledgement carries no report text');
  // A version's evidence answer is displayed as report-evidence; it is never turned into a report-version display.
  const evidence = await send('GET', '/studies/' + encodeURIComponent(uid) + '/report/versions/2/citations', { member: members.reader }).done;
  assert.equal(evidence.status, 200, evidence.text);
  await settled(uid);
  const cited = await prepared(evidence.body.accessRef);
  const evidenceReport = report(evidence.body.accessRef);
  assert.equal((await observe(uid, evidenceReport).done).status, 200);
  const [evidenceShown] = await shown(cited.eventId);
  assertShown(evidenceShown, cited, evidenceReport, BEARER);
  assert.equal(evidenceShown.event.targets[0].kind, 'report-evidence');
});

test('A-HTTP-OBSERVE: a resent report is the same event; a new opening is a new event; another report under the ID is refused', async () => {
  const uid = await study();
  await version(uid, 1);
  const [row] = await history(uid);
  const sent = report(row.accessRef);
  const first = await observe(uid, sent).done;
  assert.equal(first.status, 200, first.text);
  // The acknowledgement was lost: the browser sends the same report again.
  const again = await observe(uid, sent).done;
  assert.equal(again.status, 200, again.text);
  assert.deepEqual(again.body, first.body, 'the first accepted fact, including its reception time');
  assert.equal((await shown(row.accessRef)).length, 1, 'no second entry for a resend');
  // Another report under the same ID (a changed display time) cannot overwrite the first accepted fact.
  const changed = await observe(uid, { ...sent, shownAt: new Date(Date.parse(sent.shownAt) + 1000).toISOString() }).done;
  assert.equal(changed.status, 409, changed.text);
  assert.equal(changed.body.code, 'VIEW_OBSERVATION_CONFLICT');
  // A provision's own event ID is not a display event ID.
  const reused = await observe(uid, report(row.accessRef, { eventId: (await history(uid))[0].accessRef })).done;
  assert.equal(reused.status, 409, reused.text);
  assert.deepEqual((await shown(row.accessRef)).map(e => e.event.occurredAt), [sent.shownAt]);
  // The same cached body in a new opening is a new display event, with no new server transfer.
  const transfers = (await forStudy(uid)).filter(e => e.event.relatedEventId === row.accessRef && e.event.action !== 'client-shown').length;
  const reopened = await observe(uid, report(row.accessRef)).done;
  assert.equal(reopened.status, 200, reopened.text);
  assert.equal((await shown(row.accessRef)).length, 2);
  assert.equal((await forStudy(uid)).filter(e => e.event.relatedEventId === row.accessRef && e.event.action !== 'client-shown').length,
    transfers, 'a display report adds no transfer outcome');
});

test('A-HTTP-OBSERVE: wrong targets, absent or disposed provisions and malformed reports never record a display', async () => {
  const uid = await study(), elsewhere = await study();
  await version(uid, 1); await version(elsewhere, 1);
  const [row] = await history(uid);
  const before = await allShown();
  const refusals = [
    ['another study path', elsewhere, report(row.accessRef), 404],
    ['an unknown reference', uid, report(randomUUID()), 404],
  ];
  // W9's real metadata read: its accessRef is a study-metadata provision, not a report display reference.
  const resolved = await send('POST', '/studies/viewing-set/resolve', { member: members.reader, body: { compositionId: randomUUID(),
    generation: 1, requestId: randomUUID(), expectedSourcePatientKey: null, studyUids: [uid] } }).done;
  assert.equal(resolved.status, 200, resolved.text);
  const metadataRef = resolved.body.members[0].accessRef;
  assert.equal((await prepared(metadataRef)).event.targets[0].kind, 'study-metadata');
  refusals.push(['a metadata reference', uid, report(metadataRef), 404]);
  // The real draft read records a formatVersion 1 provision of the caller's own draft: not a report display reference.
  const draft = await send('GET', '/studies/' + encodeURIComponent(uid) + '/draft', { member: members.reader }).done;
  assert.equal(draft.status, 200, draft.text);
  const [draftRead] = await entries(`e.payload::jsonb->>'surface' = 'GET studies/:uid/draft' AND e.payload::jsonb->'targets'->0->'studyId'->>'value' = '${uid}'`);
  assert.equal(draftRead.event.formatVersion, 1);
  refusals.push(['a formatVersion 1 draft-read reference', uid, report(draftRead.eventId), 404]);
  for (const [what, path, sent, status] of refusals) {
    const answer = await observe(path, sent).done;
    assert.equal(answer.status, status, what + ' ' + answer.text);
    assert.equal(answer.body.code, 'VIEW_OBSERVATION_REFERENCE', what);
  }
  for (const [what, body] of [
    ['no display time', { accessRef: row.accessRef, eventId: randomUUID() }],
    ['an extra field', { ...report(row.accessRef), versionId: '1' }],
    ['a non-UUID event ID', report(row.accessRef, { eventId: 'display-1' })],
    ['the provision ID as the event ID', report(row.accessRef, { eventId: row.accessRef })],
    ['a display time without milliseconds', report(row.accessRef, { shownAt: '2026-10-26T01:02:03Z' })],
    ['no JSON object', '[]'],
  ]) {
    const answer = await observe(uid, body).done;
    assert.equal(answer.status, 400, what + ' ' + answer.text);
    assert.equal(answer.body.code, 'VIEW_OBSERVATION_INVALID', what);
  }
  // A provision whose lawful retention ended (the two statements emr_access.expire_entry runs) is no longer a reference.
  const [other] = await history(elsewhere);
  await ctx.witness.$transaction([
    ctx.witness.$executeRaw`INSERT INTO emr_access.disposal_fact(entry_id, basis) SELECT entry_id, 'retention-elapsed'
      FROM emr_access.access_entry WHERE event_id = ${other.accessRef}`,
    ctx.witness.$executeRaw`DELETE FROM emr_access.access_entry WHERE event_id = ${other.accessRef}`]);
  const disposed = await observe(elsewhere, report(other.accessRef)).done;
  assert.equal(disposed.status, 404, disposed.text);
  assert.equal(await allShown(), before, 'no refused report left a display record');
});

test('A-HTTP-OBSERVE: the new request takes the existing report-history access decision', async () => {
  const before = await allShown();
  // Institution: the study left this member's institution after the read.
  const moved = await study();
  await version(moved, 1);
  const [movedRow] = await history(moved);
  await ctx.witness.studyState.update({ where: { uid: moved }, data: { institutionId: foreignSite } });
  const gone = await observe(moved, report(movedRow.accessRef)).done;
  assert.equal(gone.status, 404, gone.text);
  // Preliminary readability: another reader's preliminary now holds the study.
  const held = await study();
  await version(held, 1);
  const [heldRow] = await history(held);
  await ctx.witness.studyState.update({ where: { uid: held }, data: { rs: 'P', preDoc: 'synthetic-writer@example.test',
    preReviewer: 'synthetic-senior@example.test' } });
  const preliminary = await observe(held, report(heldRow.accessRef)).done;
  assert.equal(preliminary.status, 403, preliminary.text);
  // A clinician-only member stays outside the report-history scope (the Guard allowlist is not widened).
  const clinician = await observe(moved, report(movedRow.accessRef), { member: members.clinician }).done;
  assert.equal(clinician.status, 403, clinician.text);
  assert.equal(clinician.body.code, 'CLINICIAN_ROUTE_DENIED');
  assert.equal(await allShown(), before);
});

test('A-HTTP-OBSERVE: a cookie session reports only its own provisions; account switch and re-login keep old references out', async () => {
  const uid = await study();
  await version(uid, 1);
  const first = await session(members.reader);
  const [row] = await history(uid, { session: first });
  const source = await prepared(row.accessRef);
  const binding = { method: 'session', sessionRef: ctx.auth.sessionRef(first.sid) };
  assert.deepEqual(source.event.session, binding);
  const switched = await session(members.other);
  const relogin = await session(members.reader);
  for (const [what, options] of [['another account in the browser', { session: switched }],
    ['the same member after a new login', { session: relogin }], ['a bearer call of the same member', { member: members.reader }]]) {
    const answer = await observe(uid, report(row.accessRef), { member: undefined, ...options }).done;
    assert.equal(answer.status, 404, what + ' ' + answer.text);
  }
  assert.equal((await shown(row.accessRef)).length, 0);
  const sent = report(row.accessRef);
  const ack = await observe(uid, sent, { member: undefined, session: first }).done;
  assert.equal(ack.status, 200, ack.text);
  const [entry] = await shown(row.accessRef);
  assertShown(entry, source, sent, binding);
  // A bearer provision keeps the null session: no cookie session can report it.
  const [bearerRow] = await history(uid);
  const answer = await observe(uid, report(bearerRow.accessRef), { member: undefined, session: first }).done;
  assert.equal(answer.status, 404, answer.text);
});

test('A-PG-COMMIT: a lost COMMIT reply of the display record resolves through the same operation before the ACK', async () => {
  const uid = await study();
  await version(uid, 1);
  const [row] = await history(uid);
  const sent = report(row.accessRef, { shownAt: '2026-10-26T02:03:04.' + String(process.pid % 1000).padStart(3, '0') + 'Z' });
  ctx.relay.arm(sent.shownAt);
  const ack = await observe(uid, sent).done;
  assert.equal(ctx.relay.lost, 1, 'the relay lost exactly one COMMIT reply');
  assert.equal(ack.status, 200, ack.text);
  const recorded = await shown(row.accessRef);
  assert.equal(recorded.length, 1);
  const [attempts] = await ctx.witness.$queryRaw`SELECT count(*)::int AS n FROM emr_access.attempt WHERE operation_id = ${recorded[0].operationId}::uuid`;
  assert.equal(attempts.n, 1, 'no new attempt for the unknown COMMIT');
  const [unknown] = await ctx.witness.$queryRaw`SELECT count(*)::int AS n FROM emr_access.failure_entry
    WHERE event_id = ${sent.eventId} AND cause = 'commit-unknown'`;
  assert.equal(unknown.n, 1, 'B2 kept the truthful unknown before resolving it');
  assert.equal(ack.body.receivedAt, await outcomeAt(recorded[0].operationId));
});

test('A-HTTP-OBSERVE: a closed record port answers the non-PHI 503; after an API restart a resend is the same event', async () => {
  const uid = await study();
  await version(uid, 1);
  const [row] = await history(uid);
  const accepted = report(row.accessRef);
  const first = await observe(uid, accepted).done;
  assert.equal(first.status, 200, first.text);
  const refusedReport = report(row.accessRef);
  ctx.runtime.control.close();
  const refused = await observe(uid, refusedReport).done;
  assert.equal(refused.status, 503, refused.text);
  assert.equal(refused.body.code, 'EMR_VIEWING_UNAVAILABLE');
  assert.equal(refused.text.includes(uid), false, 'no study or patient value in the refusal');
  assert.deepEqual((await shown(row.accessRef)).map(e => e.eventId), [accepted.eventId]);
  await stopApi();
  await startApi();
  const replayed = await observe(uid, accepted).done;
  assert.equal(replayed.status, 200, replayed.text);
  assert.deepEqual(replayed.body, first.body, 'the restarted API answers the first accepted fact');
  const retried = await observe(uid, refusedReport).done;
  assert.equal(retried.status, 200, retried.text);
  assert.deepEqual((await shown(row.accessRef)).map(e => e.eventId), [accepted.eventId, refusedReport.eventId]);
});
"""


class ReportObservationHttp(PgLedgerFixture):
    def test_display_reports_bind_to_the_stored_provision(self):
        evidence = EVIDENCE / self.token
        evidence.mkdir(parents=True, exist_ok=True)
        driver = evidence / 'report-observation.cjs'
        driver.write_text(DRIVER, encoding='utf-8')
        env = {**os.environ, 'DATABASE_URL': self.runtime_url, 'KIN_B2R_WITNESS_URL': self.witness_url,
               'KIN_B2R_SPOOL': str(evidence / 'spool'),
               'KIN_B2R_BUILD': os.environ.get('KIN_B2R_BUILD', str(ROOT / 'api/dist'))}
        if self.image:
            command = ['docker', 'run', '--rm', '--name', self.container + '-node', '--label', 'kin.b2r=' + self.token,
                       '--network', self.network, '--memory', '1536m', '--memory-swap', '1536m', '--cpus', '2',
                       '--mount', 'type=bind,source=' + str(driver) + ',target=/app/report_observation.cjs,readonly']
            for key, value in {'DATABASE_URL': self.runtime_url, 'KIN_B2R_WITNESS_URL': self.witness_url,
                               'KIN_B2R_BUILD': '/app/dist', 'KIN_B2R_SPOOL': '/tmp/report-observation-spool'}.items():
                command += ['-e', key + '=' + value]
            command += [self.image, 'node', '--test', '--test-reporter=tap', '/app/report_observation.cjs']
        else:
            command = [os.environ['KIN_B2R_NODE'], '--test', '--test-reporter=tap', str(driver)]
        try:
            result = self.command(command, env=env, check=False, timeout=240)  # A2's report-read driver hang timeout.
        except subprocess.TimeoutExpired as error:
            # Keep partial raw output; the command line carries ephemeral fixture credentials.
            for name, value in [('stdout', error.stdout), ('stderr', error.stderr)]:
                raw = value if isinstance(value, bytes) else (value or '').encode('utf-8')
                (evidence / ('node.' + name + '.log')).write_bytes(raw)
            raise RuntimeError('Node fixture timed out; partial logs: ' + str(evidence)) from None
        (evidence / 'node.stdout.log').write_text(result.stdout, encoding='utf-8')
        (evidence / 'node.stderr.log').write_text(result.stderr, encoding='utf-8')
        print(result.stdout)
        self.assertEqual(result.returncode, 0, result.stderr[-3000:] or result.stdout[-3000:])


if __name__ == '__main__':
    unittest.main(verbosity=2)
