'use strict';
// D-01/02 -> D-T1, D-T5: real HTTP controllers, existing role/state services,
// native C2 signatures and PostgreSQL atomicity. Only IdP/A source facts are synthetic.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const api = process.env.KIN_D_API || path.resolve(__dirname, '../../../api');
const dependency = name => require(path.join(api, 'node_modules', name));
const product = name => require(path.join(api, 'dist', name));
dependency('reflect-metadata');
const { PrismaClient } = dependency('@prisma/client');
const jose = dependency('jose');
const { Module } = dependency('@nestjs/common');
const { NestFactory, APP_GUARD } = dependency('@nestjs/core');

test('clinical HTTP writes sign exact entries; operational allocation and close preserve read rights', async () => {
  const issuer = 'https://synthetic.example.test/realms/clinical', hospital = 'synthetic-clinical', receiver = 'synthetic-receiver';
  const members = Object.fromEntries(Object.entries({ doctor: ['radiologist'], other: ['radiologist'],
    clinician: ['clinician'], stranger: ['clinician'], tech: ['technician'], admin: ['admin'], receiving: ['radiologist'] })
    .map(([name, roles]) => [name, { sub: randomUUID(), username: name, email: name + '@example.test', name,
      institution: name === 'receiving' ? receiver : hospital, roles, emailVerified: true, approved: true, suspended: false }]));
  Object.assign(process.env, { KC_ISSUER: issuer, KC_AUDIENCE: 'kin-api', AUTH_REQUIRED: 'true',
    KIN_COOKIE_SECRET: randomUUID(), KC_WEB_SECRET: randomUUID(), PUBLIC_ORIGIN: 'https://synthetic.example.test' });
  const pair = await jose.generateKeyPair('RS256');
  const jwk = { ...await jose.exportJWK(pair.publicKey), kid: 'clinical-fixture', alg: 'RS256', use: 'sig' };
  const idp = require('node:http').createServer((_req, res) => {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise(resolve => idp.listen(0, '127.0.0.1', resolve));
  process.env.KC_JWKS_URL = 'http://127.0.0.1:' + idp.address().port + '/certs';
  const tokens = {};
  for (const [name, m] of Object.entries(members)) tokens[name] = await new jose.SignJWT({ email: m.email,
    realm_access: { roles: m.roles }, groups: ['/' + m.institution] }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer(issuer).setSubject(m.sub).setAudience('kin-api').setIssuedAt().setExpirationTime('10m').sign(pair.privateKey);
  const db = new PrismaClient({ datasources: { db: { url: process.env.KIN_D_WITNESS_URL } } });
  const runtime = new (product('emr-runtime/application').EmrRuntime)(process.env.DATABASE_URL, process.env.KIN_D_SPOOL);
  let app, ready = false;
  try {
    await db.memberRightsImport.create({ data: { id: 'realm-v1' } });
    for (const data of Object.values(members)) await db.memberRights.create({ data });
    await runtime.start(); ready = true;
    const clinical = await require('./clinical_fixture.cjs').clinicalFixture(db, runtime.port, issuer, Object.values(members));
    const orthanc = { studyIdentityResources: async uid => [{ '0020000D': { Value: [uid] } }], studyIdentities: async () => [] };
    const users = Object.values(members).map(m => ({ id: m.sub, username: m.username, email: m.email, firstName: m.name,
      enabled: true, groups: [m.institution], roles: m.roles }));
    const keycloak = { getUser: async sub => users.find(u => u.id === sub),
      assignmentReaders: async institution => users.filter(u => u.groups.includes(institution)), isReader: async () => true };
    const { PrismaService } = product('prisma.service'), { StudyAccessService } = product('study-access.service');
    const services = ['pacs', 'clinician-question', 'image-request', 'consultation', 'reader-assignment'];
    const className = name => name.split('-').map(x => x[0].toUpperCase() + x.slice(1)).join('');
    class HttpFixture {}
    Module({ controllers: services.map(n => product(n + '.controller')[className(n) + 'Controller']),
      providers: [PrismaService, ...services.map(n => product(n + '.service')[className(n) + 'Service']),
        product('auth.service').AuthService, ...clinical.providers,
        { provide: product('orthanc.service').OrthancService, useValue: orthanc },
        { provide: product('keycloak.service').KeycloakService, useValue: keycloak },
        { provide: product('finding.service').FindingService, useValue: {} },
        { provide: StudyAccessService, useFactory: prisma => new StudyAccessService(prisma, orthanc, keycloak), inject: [PrismaService] },
        { provide: product('emr-runtime/record-port').EMR_RECORD_PORT, useValue: runtime.port },
        { provide: product('emr-runtime/background-work').EMR_BACKGROUND_WORK, useValue: runtime.background.work },
        { provide: APP_GUARD, useClass: product('auth.guard').AuthGuard },
        { provide: product('study-transfer-local.service').StudyTransferLocalService, useValue: {} }] })(HttpFixture);
    app = await NestFactory.create(HttpFixture, { logger: ['error'] });
    app.setGlobalPrefix('api'); await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const send = async (name, method, route, body, expected = method === 'GET' || method === 'PATCH' ? 200 : 201) => {
      const response = await fetch(origin + '/api' + route, { method,
        headers: { authorization: 'Bearer ' + tokens[name], 'content-type': 'application/json', 'x-real-ip': '192.0.2.23' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json();
      assert.equal(response.status, expected, JSON.stringify({ method, route, name, value }));
      return value;
    };
    const owner = name => [members[name].institution, members[name].sub];
    const uid = '1.2.840.9999.24', teleUid = '1.2.840.9999.25';
    await db.studyState.create({ data: { uid, institutionId: hospital, ss: 'Verified' } });
    await db.studyState.create({ data: { uid: teleUid, institutionId: hospital, teleInstitutionId: receiver, ts: 'wait', ss: 'Verified' } });
    const question = { requestId: randomUUID(), expectedOwner: owner('clinician'), body: '합성 질문 원문' };
    const created = await send('clinician', 'POST', `/studies/${uid}/questions`, question);
    const signature = created.emr.signature;
    assert.equal(signature.registration.kid, clinical.keys.get(members.clinician.sub).kid);
    const verified = product('emr-signature/server-verification').verifyRegisteredServerEnvelope(signature.envelope, signature.registration);
    assert.equal(JSON.parse(verified.payload.text.body).content.body, question.body);
    const replay = await send('clinician', 'POST', `/studies/${uid}/questions`, question);
    assert.equal(replay.emr.replayed, true); assert.deepEqual(replay.emr.signature, signature);
    const id = created.applied.id;
    await send('doctor', 'POST', `/questions/${id}/entries`, { requestId: randomUUID(), expectedOwner: owner('doctor'), revision: 1, body: '합성 답변' });
    const read = await send('clinician', 'GET', `/questions/${id}`);
    assert.deepEqual(read.item.entries.map(e => e.body), [question.body, '합성 답변']);
    assert.equal(read.emr.signatures.length, 2);
    assert.ok((await send('clinician', 'GET', '/questions?view=mine')).items.some(item => item.id === id));
    assert.ok((await send('doctor', 'GET', `/studies/${uid}/questions`)).items.some(item => item.id === id));
    await send('stranger', 'GET', `/questions/${id}`, undefined, 404);
    await send('doctor', 'POST', `/questions/${id}/entries`, { requestId: randomUUID(), expectedOwner: owner('other'), revision: 2, body: '다른 계정 입력' }, 409);
    const beforeFailure = await db.studyQuestion.count();
    await db.$executeRaw`ALTER TABLE emr_access.access_entry ADD CONSTRAINT synthetic_question_failure
      CHECK (payload::jsonb->>'surface' <> 'POST studies/:uid/questions') NOT VALID`;
    try { await send('clinician', 'POST', `/studies/${uid}/questions`, { ...question, requestId: randomUUID() }, 500); }
    finally { await db.$executeRaw`ALTER TABLE emr_access.access_entry DROP CONSTRAINT synthetic_question_failure`; }
    assert.equal(await db.studyQuestion.count(), beforeFailure);
    const consultation = await send('doctor', 'POST', `/studies/${uid}/consultations`, { requestId: randomUUID(),
      expectedOwner: owner('doctor'), recipientSub: members.other.sub, reason: '합성 자문 의뢰' });
    const accepted = await send('other', 'POST', `/consultations/${consultation.item.id}`, { requestId: randomUUID(),
      expectedOwner: owner('other'), revision: 1, action: 'accept', note: '' });
    assert.equal(accepted.emr.signature, null);
    const completed = await send('other', 'POST', `/consultations/${consultation.item.id}`, { requestId: randomUUID(),
      expectedOwner: owner('other'), revision: 2, action: 'complete', note: '합성 자문 답변' });
    assert.ok(completed.emr.signature);
    assert.equal((await send('other', 'GET', '/consultations?direction=received')).items[0].reply, '합성 자문 답변');
    const imageRequest = await send('clinician', 'POST', `/studies/${uid}/image-requests`, { requestId: randomUUID(),
      expectedOwner: owner('clinician'), kind: 'external-image', counterparty: '합성 기관', counterpartyInstitutionId: null, reason: '합성 영상 요청' });
    assert.ok(imageRequest.emr.signature);
    assert.equal((await send('clinician', 'GET', '/image-requests?view=mine')).items[0].id, imageRequest.applied.id);
    assert.equal((await send('doctor', 'GET', `/studies/${uid}/image-requests`)).items[0].id, imageRequest.applied.id);
    await send('tech', 'POST', `/studies/${uid}/tech-note`, { attemptId: 'not-a-uuid', baseVersion: 0, text: '잘못된 요청 ID', reason: '' }, 400);
    const note = await send('tech', 'POST', `/studies/${uid}/tech-note`, { attemptId: randomUUID(), baseVersion: 0, text: '합성 촬영 메모', reason: '' });
    assert.ok(note.emr.signature);
    const history = await send('doctor', 'GET', `/studies/${uid}/tech-note/history`);
    assert.equal(history.items[0].text, '합성 촬영 메모'); assert.equal(history.emr.signatures.length, 1);
    const legacy = await send('tech', 'POST', `/studies/${uid}/tech-note`, { baseVersion: 1, text: '합성 메모 정정', reason: '합성 정정 사유' });
    assert.ok(legacy.emr.signature); assert.equal(legacy.note.attemptId, null);
    const before = await db.studyState.findUnique({ where: { uid: teleUid } });
    await send('tech', 'POST', `/studies/${teleUid}/tech-note`, { attemptId: randomUUID(), baseVersion: 0, text: '합성 원격 메모', reason: '' });
    const teleQuestion = await send('clinician', 'POST', `/studies/${teleUid}/questions`, { requestId: randomUUID(), expectedOwner: owner('clinician'), body: '합성 원격 검사 질문' });
    const allowedBeforeAssignment = await send('receiving', 'GET', `/studies/${teleUid}/tech-note`);
    assert.equal(allowedBeforeAssignment.note.text, '합성 원격 메모');
    await send('receiving', 'GET', `/questions/${teleQuestion.applied.id}`, undefined, 404);
    const assignment = { requestId: randomUUID(), expectedOwner: owner('receiving'), revision: 0, readerSub: members.receiving.sub };
    const assigned = await send('receiving', 'POST', `/studies/${teleUid}/reader-assignment`, assignment);
    assert.equal(assigned.reader.sub, members.receiving.sub);
    await send('receiving', 'POST', `/studies/${teleUid}/reader-assignment`, { ...assignment, requestId: randomUUID(), revision: 1, readerSub: members.doctor.sub }, 400);
    const storedAssignments = await db.$queryRaw`SELECT signature,body FROM emr_clinical.online_version WHERE record_type='assignment'`;
    assert.ok(storedAssignments.length > 0); assert.ok(storedAssignments.every(v => v.signature === null));
    assert.deepEqual(await db.studyState.findUnique({ where: { uid: teleUid } }), before);
    const allowedAfterAssignment = await send('receiving', 'GET', `/studies/${teleUid}/tech-note`);
    assert.equal(allowedAfterAssignment.note.text, allowedBeforeAssignment.note.text);
    await send('receiving', 'GET', `/questions/${teleQuestion.applied.id}`, undefined, 404);
    await send('tech', 'PATCH', `/studies/${teleUid}`, { ts: 'cancelled' }, 403);
    await send('doctor', 'PATCH', `/studies/${teleUid}`, { ts: 'cancelled' });
    const closed = await db.readerAssignment.findUnique({ where: { studyUid_institutionId: { studyUid: teleUid, institutionId: receiver } } });
    assert.equal(closed.readerSub, null); assert.equal(closed.closedRevision, 2);
    const closes = await db.$queryRaw`SELECT payload::jsonb AS event FROM emr_access.access_entry
      WHERE payload::jsonb->>'surface'='PATCH studies/:uid' AND payload::jsonb->>'action'='modify'`;
    assert.ok(closes.length > 0);
    for (const { event } of closes) {
      assert.equal(event.userId.value.subject, members.doctor.sub);
      assert.equal(event.actingInstitution.value, hospital);
      assert.equal(event.targets[0].recordId.value, JSON.stringify([teleUid, receiver]));
    }
    const denied = await fetch(origin + `/api/studies/${teleUid}/reader-assignment`, { headers: { authorization: 'Bearer ' + tokens.receiving } });
    assert.ok(denied.status >= 400);
    assert.equal(await db.reportVersion.count(), 0); assert.equal(await db.reportDraft.count(), 0);
  } finally {
    if (app) await app.close();
    if (ready) await runtime.stop(Date.now() + 10000);
    await db.$disconnect(); await new Promise(resolve => idp.close(resolve));
  }
});
