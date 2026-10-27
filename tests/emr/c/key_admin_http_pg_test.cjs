'use strict';
// KEY-ADMIN (D1770 server-held approval keys, D1753 online only): the administrator's real HTTP path creates, rotates
// and retires a doctor's key through ServerKeys.manage, and the doctor's own report approval (POST
// studies/:uid/report/commit) signs with exactly that key - no step is added for the doctor. Real Nest controllers,
// AuthGuard, startup clinical providers, B2 PostgreSQL ledger, C2 crypto and file custody (the #218 ID and mapping
// shape). Only the IdP, Orthanc and Keycloak directory are synthetic.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = process.env.KIN_D_API || path.resolve(__dirname, '../../../api');
const dependency = name => require(path.join(api, 'node_modules', name));
const product = name => require(path.join(api, 'dist', name));
dependency('reflect-metadata');
const { PrismaClient } = dependency('@prisma/client');
const jose = dependency('jose');
const { Module } = dependency('@nestjs/common');
const { NestFactory, APP_GUARD } = dependency('@nestjs/core');

test('admin creates, rotates and retires a doctor key over HTTP; the doctor approves with it unchanged', async () => {
  const issuer = 'https://synthetic.example.test/realms/keys', hospital = 'synthetic-keys', other = 'synthetic-other';
  const members = Object.fromEntries(Object.entries({ admin: [hospital, ['admin']], doctor: [hospital, ['radiologist']],
    second: [hospital, ['radiologist']], staff: [hospital, ['admin']], outsider: [other, ['admin']] })
    .map(([name, [institution, roles]]) => [name, { sub: randomUUID(), username: name, email: name + '@example.test', name,
      institution, roles, emailVerified: true, approved: true, suspended: false }]));
  Object.assign(process.env, { KC_ISSUER: issuer, KC_AUDIENCE: 'kin-api', AUTH_REQUIRED: 'true',
    KIN_COOKIE_SECRET: randomUUID(), KC_WEB_SECRET: randomUUID(), PUBLIC_ORIGIN: 'https://synthetic.example.test' });
  // The deployment's custody: the #218 wrapping ID mapped to a separate 32-byte file outside PostgreSQL.
  const custody = fs.mkdtempSync(path.join(os.tmpdir(), 'key-admin-custody-'));
  const secretFile = path.join(custody, 'emr-signing-wrap-v1');
  fs.writeFileSync(secretFile, randomBytes(32), { mode: 0o600 });
  const configured = { KIN_EMR_WRAPPING_KEY_ID: 'c2-wrap-v1', KIN_EMR_WRAPPING_KEY_FILES: JSON.stringify({ 'c2-wrap-v1': secretFile }) };
  Object.assign(process.env, configured);
  const pair = await jose.generateKeyPair('RS256');
  const jwk = { ...await jose.exportJWK(pair.publicKey), kid: 'keys-fixture', alg: 'RS256', use: 'sig' };
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
    const resource = uid => ({ '0020000D': { Value: [uid] }, '00100020': { Value: ['synthetic:' + uid] } });
    const orthanc = { studyIdentityResources: async uid => [resource(uid)], studyIdentities: async () => [] };
    // D's current-study read applies the archive reader's own patient rule over these resources (#244).
    orthanc.studyPatientIdentity = product('orthanc.service').OrthancService.prototype.studyPatientIdentity;
    const users = Object.values(members).map(m => ({ id: m.sub, username: m.username, email: m.email, firstName: m.name,
      enabled: true, groups: [m.institution], roles: m.roles }));
    const keycloak = { getUser: async sub => users.find(u => u.id === sub),
      assignmentReaders: async institution => users.filter(u => u.groups.includes(institution)), isReader: async () => true };
    const { PrismaService } = product('prisma.service'), { StudyAccessService } = product('study-access.service');
    const { createRequestContext, REQUEST_CONTEXT_CAPTURE, REQUEST_CONTEXT_SOURCE } = product('emr-runtime/request-context');
    const { createRequestIngress } = product('emr-runtime/request-ingress');
    const requests = createRequestContext(createRequestIngress({ proxyPeers: ['127.0.0.1'] }), runtime.port);
    class HttpFixture {}
    Module({ controllers: [product('signing-key-admin.controller').SigningKeyAdminController, product('pacs.controller').PacsController],
      providers: [PrismaService, product('pacs.service').PacsService, product('auth.service').AuthService,
        ...product('emr-clinical/startup').startupClinicalProviders,
        { provide: REQUEST_CONTEXT_CAPTURE, useValue: requests.capture }, { provide: REQUEST_CONTEXT_SOURCE, useValue: requests.source },
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
    const call = async (name, method, route, body) => {
      const response = await fetch(origin + '/api' + route, { method,
        headers: { authorization: 'Bearer ' + tokens[name], 'content-type': 'application/json', 'x-real-ip': '192.0.2.31' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    const send = async (name, method, route, body, expected) => {
      const result = await call(name, method, route, body);
      assert.equal(result.status, expected, JSON.stringify({ name, method, route, result }));
      return result.body;
    };
    const keyRoute = name => '/admin/users/' + encodeURIComponent(members[name].sub) + '/signing-key';
    const change = (name, action, expectedKid, as = 'admin', expected = 201, reason = '합성 서명키 ' + action) =>
      send(as, 'POST', keyRoute(name), { action, expectedKid, reason }, expected);
    const identityRows = sub => db.$queryRaw`SELECT id::text AS id FROM emr_access.member_identity WHERE subject=${sub}`;
    const keyRows = sub => db.$queryRaw`SELECT k.kid, k.status FROM emr_signing.doctor_key k
      JOIN emr_access.member_identity i ON i.id::text = k.doctor_id WHERE i.subject=${sub}`;
    const keyEvents = () => db.$queryRaw`SELECT e.stream, e.retention_class, e.payload::jsonb AS event
      FROM emr_access.access_entry e WHERE e.payload::jsonb->>'surface'='server:doctor-key-management' ORDER BY e.sequence`;
    const doctorOwner = { institution: hospital, sub: members.doctor.sub, author: members.doctor.email };
    let studies = 0;
    // The doctor's ordinary approval: write the draft, then approve. Nothing about keys is sent.
    const approve = async expected => {
      const uid = '1.2.840.9999.7' + (++studies);
      const state = await db.studyState.create({ data: { uid, institutionId: hospital, ss: 'Verified' } });
      const input = { expectedOwner: doctorOwner, expectedRevision: state.draftEpoch + ':0', baseVersion: 0,
        findings: '합성 판독 ' + uid, conclusion: '합성 결론', recommendation: '', citationIds: [], structureIds: [] };
      const draft = await send('doctor', 'PUT', '/studies/' + uid + '/report', input, 200);
      const result = await call('doctor', 'POST', '/studies/' + uid + '/report/commit',
        { ...input, expectedRevision: draft.revision, action: 'approve' });
      assert.equal(result.status, expected, JSON.stringify(result.body));
      return { uid, result: result.body };
    };
    const verify = product('emr-signature/server-verification').verifyRegisteredServerEnvelope;

    // Read: admin only; a read never enrolls the member's identity.
    await send('doctor', 'GET', keyRoute('doctor'), undefined, 403);
    await send('admin', 'GET', '/admin/users/' + randomUUID() + '/signing-key', undefined, 404);
    assert.deepEqual(await send('admin', 'GET', keyRoute('second'), undefined, 200),
      { subject: members.second.sub, institutionId: hospital, current: null, keys: [] });
    assert.equal((await identityRows(members.second.sub)).length, 0);

    // Before a key exists the doctor's approval is refused and the draft is kept (no partial version).
    const refused = await approve(503);
    assert.equal(refused.result.code, 'DoctorSigningKeyUnavailable');
    assert.equal(await db.reportVersion.count({ where: { uid: refused.uid } }), 0);

    // Create.
    const created = await change('doctor', 'provision', null);
    assert.equal(created.subject, members.doctor.sub);
    assert.equal(created.keys.length, 1);
    assert.equal(created.keys[0].status, 'active');
    assert.equal(created.current, created.keys[0].kid);
    assert.equal(JSON.stringify(created).includes('ciphertext'), false);
    assert.deepEqual(await send('admin', 'GET', keyRoute('doctor'), undefined, 200), created);
    const first = await approve(201);
    assert.equal(first.result.signature.kid, created.current);
    assert.equal(verify(first.result.signature.envelope, first.result.signature.keyAtSigning).integrity, 'valid');
    const [doctorId] = (await identityRows(members.doctor.sub)).map(row => row.id);
    assert.equal(first.result.signature.keyAtSigning.doctor.identity.id, doctorId);
    assert.equal(first.result.signature.keyAtSigning.doctor.identity.subject, members.doctor.sub);
    // A second create while one is active is a conflict, not a second active key.
    assert.equal((await change('doctor', 'provision', null, 'admin', 409)).code, 'KeyManagementConflict');

    // Rotate: a new key; the earlier approval still verifies from its retained public registration.
    const rotated = await change('doctor', 'replace', created.current);
    assert.notEqual(rotated.current, created.current);
    assert.deepEqual(rotated.keys.map(k => [k.kid, k.status]).sort(),
      [[created.current, 'revoked'], [rotated.current, 'active']].sort());
    const second = await approve(201);
    assert.equal(second.result.signature.kid, rotated.current);
    assert.equal(verify(first.result.signature.envelope, first.result.signature.keyAtSigning).integrity, 'valid');
    // A page still showing the earlier key cannot act on the newer one.
    assert.equal((await change('doctor', 'replace', created.current, 'admin', 409)).code, 'KeyManagementConflict');
    assert.equal((await change('doctor', 'revoke', created.current, 'admin', 409)).code, 'KeyManagementConflict');

    // Scope and input: another institution's admin, a non-clinical member, malformed commands, missing reason.
    await change('doctor', 'revoke', rotated.current, 'outsider', 409);
    await change('doctor', 'provision', null, 'outsider', 403);
    assert.deepEqual(await send('outsider', 'GET', keyRoute('doctor'), undefined, 200),
      { subject: members.doctor.sub, institutionId: other, current: null, keys: [] });
    await change('staff', 'provision', null, 'admin', 403);
    await change('doctor', 'revoke', rotated.current, 'doctor', 403);
    for (const body of [{ action: 'suspend', expectedKid: rotated.current, reason: '사유' },
      { action: 'provision', expectedKid: rotated.current, reason: '사유' }, { action: 'revoke', expectedKid: null, reason: '사유' },
      { action: 'revoke', expectedKid: rotated.current, reason: ' ' }, { action: 'revoke', expectedKid: rotated.current },
      { action: 'revoke', expectedKid: 'not-a-kid', reason: '사유' }])
      await send('admin', 'POST', keyRoute('doctor'), body, 400);
    assert.deepEqual((await keyRows(members.doctor.sub)).map(r => r.status).sort(), ['active', 'revoked']);

    // Retire: approvals stop until a new key is created; history and evidence remain.
    const retired = await change('doctor', 'revoke', rotated.current);
    assert.equal(retired.current, null);
    assert.deepEqual(retired.keys.map(k => k.status), ['revoked', 'revoked']);
    assert.ok(retired.keys.every(k => k.endedAt));
    assert.equal((await approve(503)).result.code, 'DoctorSigningKeyUnavailable');
    assert.equal(verify(second.result.signature.envelope, second.result.signature.keyAtSigning).integrity, 'valid');
    const renewed = await change('doctor', 'provision', null);
    assert.equal((await approve(201)).result.signature.kid, renewed.current);

    // Every applied change is one law-level event of the existing B2 ledger (refusals write none): the administrator,
    // the doctor and the key the change produced (create/rotate) or ended (retire).
    const events = await keyEvents();
    assert.deepEqual(events.map(e => e.event.targets[0].versionId.value),
      [created.current, rotated.current, rotated.current, renewed.current]);
    for (const { stream, retention_class: retention, event } of events) {
      assert.equal(stream, 'viewing'); assert.equal(retention, 'rights3y');
      assert.equal(event.action, 'modify'); assert.equal(event.result, 'succeeded');
      assert.equal(event.userId.value.subject, members.admin.sub);
      assert.equal(event.actingInstitution.value, hospital); assert.equal(event.managingInstitution.value, hospital);
      assert.equal(event.targets[0].kind, 'identity-access'); assert.equal(event.targets[0].recordId.value, doctorId);
      assert.equal(event.trustedProxyIp.value.address, '192.0.2.31');
    }
    const history = await db.$queryRaw`SELECT event FROM emr_signing.key_history WHERE kid=${created.current} ORDER BY sequence`;
    assert.deepEqual(history.map(h => [h.event.before, h.event.after, h.event.reason]),
      [[null, 'active', '합성 서명키 provision'], ['active', 'revoked', '합성 서명키 replace']]);

    // Atomic with the ledger: a refused event leaves no key behind.
    await db.$executeRaw`ALTER TABLE emr_access.access_entry ADD CONSTRAINT key_admin_failure
      CHECK (payload::jsonb->>'surface' <> 'server:doctor-key-management') NOT VALID`;
    try { await change('second', 'provision', null, 'admin', 500); }
    finally { await db.$executeRaw`ALTER TABLE emr_access.access_entry DROP CONSTRAINT key_admin_failure`; }
    assert.equal((await keyRows(members.second.sub)).length, 0);

    // Custody belongs to the deployment: unset, unreadable or wrong-length material refuses creation without a key.
    for (const [env, code] of [[{ KIN_EMR_WRAPPING_KEY_ID: '', KIN_EMR_WRAPPING_KEY_FILES: '' }, 'WrappingSecretConfigurationPending'],
      [{ KIN_EMR_WRAPPING_KEY_FILES: JSON.stringify({ 'c2-wrap-v1': path.join(custody, 'absent') }) }, 'WrappingSecretUnavailable']]) {
      Object.assign(process.env, env);
      try { assert.equal((await change('second', 'provision', null, 'admin', 503)).code, code); }
      finally { Object.assign(process.env, configured); }
    }
    assert.equal((await keyRows(members.second.sub)).length, 0);
    const secondKey = await change('second', 'provision', null);
    assert.equal(secondKey.keys[0].status, 'active');
  } finally {
    if (app) await app.close();
    if (ready) await runtime.stop(Date.now() + 10000);
    await db.$disconnect(); await new Promise(resolve => idp.close(resolve));
    fs.rmSync(custody, { recursive: true });
  }
});
