'use strict';
// D1824 / medical-record access -> partial publication or missing change history
// -> real authenticated HTTP commit/approval, PostgreSQL and B2 rollback.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const api = process.env.KIN_D_API || path.resolve(__dirname, '../../../api');
const dependency = name => require(path.join(api, 'node_modules', name));
const product = name => require(path.join(api, 'dist', name));
dependency('reflect-metadata');
const { PrismaClient } = dependency('@prisma/client');
const jose = dependency('jose');
const { Module } = dependency('@nestjs/common');
const { NestFactory, APP_GUARD } = dependency('@nestjs/core');

test('actual HTTP report approval/reset and ledger failure preserve exact versions and drafts', async () => {
  const { EmrRuntime } = product('emr-runtime/application');
  const { EMR_RECORD_PORT } = product('emr-runtime/record-port');
  const { EMR_BACKGROUND_WORK } = product('emr-runtime/background-work');
  const { PrismaService } = product('prisma.service');
  const { AuthService } = product('auth.service');
  const { PresenceService } = product('presence.service');
  const { AuthGuard } = product('auth.guard');
  const { PacsController } = product('pacs.controller');
  const { PacsService } = product('pacs.service');
  const { StudyAccessService } = product('study-access.service');
  const { OrthancService } = product('orthanc.service');
  const { KeycloakService } = product('keycloak.service');
  const { FindingService } = product('finding.service');
  const { StudyTransferLocalService } = product('study-transfer-local.service');
  const issuer = 'https://synthetic.example.test/realms/report', institution = 'report-fixture';
  const sub = 'synthetic-report-doctor', author = 'doctor@example.test';
  Object.assign(process.env, { KC_ISSUER: issuer, KC_AUDIENCE: 'kin-api', AUTH_REQUIRED: 'true',
    KIN_COOKIE_SECRET: randomUUID(), KC_WEB_SECRET: randomUUID(), PUBLIC_ORIGIN: 'https://synthetic.example.test' });
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  const jwk = { ...await jose.exportJWK(publicKey), kid: 'report-fixture', alg: 'RS256', use: 'sig' };
  const provider = require('node:http').createServer((_req, res) => {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  process.env.KC_JWKS_URL = 'http://127.0.0.1:' + provider.address().port + '/certs';
  const token = await new jose.SignJWT({ email: author, realm_access: { roles: ['radiologist'] }, groups: ['/' + institution] })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer).setSubject(sub).setAudience('kin-api')
    .setIssuedAt().setExpirationTime('10m').sign(privateKey);
  const witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_D_WITNESS_URL } } });
  const runtime = new EmrRuntime(process.env.DATABASE_URL, process.env.KIN_D_SPOOL);
  let app, ready = false;
  try {
    await witness.memberRightsImport.create({ data: { id: 'realm-v1' } });
    await witness.memberRights.create({ data: { sub, username: sub, email: author, name: 'Synthetic',
      emailVerified: true, approved: true, suspended: false, institution, roles: ['radiologist'] } });
    await runtime.start(); ready = true;
    const clinical = await require('./clinical_fixture.cjs').clinicalFixture(witness, runtime.port, issuer,
      [{ sub, institution, roles: ['radiologist'] }]);
    const orthanc = { studyIdentityResources: async uid => [{ '0020000D': { Value: [uid] } }], studyIdentities: async () => [] };
    class HttpFixture {}
    // REQUEST_FACTS: the Guard captures into, and the report routes read, the shared request context;
    // this direct fixture's loopback peer stands in for the deployment proxy.
    const { createRequestContext, REQUEST_CONTEXT_CAPTURE, REQUEST_CONTEXT_SOURCE } = product('emr-runtime/request-context');
    const { createRequestIngress } = product('emr-runtime/request-ingress');
    const requests = createRequestContext(createRequestIngress({ proxyPeers: ['127.0.0.1'] }), runtime.port);
    Module({ controllers: [PacsController], providers: [PrismaService, PacsService, AuthService, PresenceService, ...clinical.providers,
      { provide: REQUEST_CONTEXT_CAPTURE, useValue: requests.capture }, { provide: REQUEST_CONTEXT_SOURCE, useValue: requests.source },
      { provide: OrthancService, useValue: orthanc }, { provide: KeycloakService, useValue: {} },
      { provide: FindingService, useValue: {} },
      { provide: StudyAccessService, useFactory: db => new StudyAccessService(db, orthanc, {}), inject: [PrismaService] },
      { provide: EMR_RECORD_PORT, useValue: runtime.port },
      { provide: EMR_BACKGROUND_WORK, useValue: runtime.background.work },
      { provide: APP_GUARD, useClass: AuthGuard }, { provide: StudyTransferLocalService, useValue: {} }] })(HttpFixture);
    app = await NestFactory.create(HttpFixture, { logger: ['error'] });
    app.setGlobalPrefix('api'); await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const send = async (uid, endpoint, body) => {
      const response = await fetch(origin + '/api/studies/' + uid + endpoint, {
        method: endpoint === '/report' ? 'PUT' : 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-real-ip': '192.0.2.23' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const state = await witness.studyState.create({ data: { uid: '1.2.840.9999.23', institutionId: institution, ss: 'Verified' } });
    const input = { expectedOwner: { institution, sub, author }, expectedRevision: state.draftEpoch + ':0',
      baseVersion: 0, findings: '합성 판독 원문', conclusion: '합성 결론', recommendation: '', citationIds: [], structureIds: [] };
    const draft = await send(state.uid, '/report', input);
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    const command = { ...input, expectedRevision: draft.body.revision, action: 'approve' };
    // A real storage error must leave all business rows and the personal draft unchanged.
    await witness.$executeRaw`ALTER TABLE emr_access.access_entry ADD CONSTRAINT report_write_failure
      CHECK (payload::jsonb->>'surface' <> 'POST studies/:uid/report/commit') NOT VALID`;
    try { assert.equal((await send(state.uid, '/report/commit', command)).status, 500); }
    finally { await witness.$executeRaw`ALTER TABLE emr_access.access_entry DROP CONSTRAINT report_write_failure`; }
    assert.equal(await witness.reportVersion.count({ where: { uid: state.uid } }), 0);
    assert.equal((await witness.studyState.findUnique({ where: { uid: state.uid } })).rs, 'W');
    assert.equal((await witness.reportDraft.findUnique({ where: { uid_author: { uid: state.uid, author } } })).present, true);
    assert.equal(Number((await witness.$queryRaw`SELECT count(*)::int AS n FROM emr_signing.signed_version`)[0].n), 0);
    await witness.$executeRaw`UPDATE emr_signing.doctor_key SET status='suspended'`;
    try { assert.equal((await send(state.uid, '/report/commit', command)).status, 503); }
    finally { await witness.$executeRaw`UPDATE emr_signing.doctor_key SET status='active'`; }
    assert.equal(await witness.reportVersion.count({ where: { uid: state.uid } }), 0);
    assert.equal((await witness.reportDraft.findUnique({ where: { uid_author: { uid: state.uid, author } } })).present, true);
    const approved = await send(state.uid, '/report/commit', command);
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    assert.equal(approved.body.state.rs, 'A');
    const approval = approved.body.signature;
    assert.equal(approval.kid, clinical.keys.get(sub).kid);
    const verified = product('emr-signature/server-verification').verifyRegisteredServerEnvelope(approval.envelope, approval.keyAtSigning);
    const signedVersion = JSON.parse(verified.payload.text.body);
    assert.equal(signedVersion.uid, state.uid);
    assert.equal(signedVersion.findings, input.findings);
    assert.equal(signedVersion.version, approved.body.state.version);
    const [atomic] = await witness.$queryRaw`SELECT v.xmin::text AS version_tx, s.xmin::text AS signature_tx,
      e.xmin::text AS ledger_tx FROM "ReportVersion" v, emr_signing.signed_version s, emr_access.access_entry e
      WHERE v.uid=${state.uid} AND s.record_id=${approval.recordId} AND s.version_id=${approval.versionId}
      AND e.payload::jsonb->>'surface'='POST studies/:uid/report/commit'
      AND e.payload::jsonb->>'action'='approve-sign' LIMIT 1`;
    assert.equal(atomic.version_tx, atomic.signature_tx); assert.equal(atomic.version_tx, atomic.ledger_tx);
    const entries = async action => witness.$queryRaw`SELECT e.stream,e.statutory_act,e.payload::jsonb AS facts
      FROM emr_access.access_entry e WHERE e.payload::jsonb->>'surface'='POST studies/:uid/report/commit'
      AND e.payload::jsonb->>'action'=${action}`;
    const writes = await entries('approve-sign');
    assert.deepEqual(writes.map(e => e.stream).sort(), ['history', 'viewing']);
    for (const e of writes) {
      assert.equal(e.statutory_act, '기재'); assert.equal(e.facts.userId.value.subject, sub);
      assert.equal(e.facts.targets[0].versionId.value, String(approved.body.state.version));
      assert.equal(e.facts.trustedProxyIp.value.address, '192.0.2.23');
      assert.equal(e.facts.context.basis, 'worklist'); assert.equal(e.facts.context.studyId, state.uid);
    }
    assert.equal((await entries('provide-prepared')).length, 1);
    const reset = await send(state.uid, '/report/commit', { ...command, action: 'reset', reason: '합성 정정',
      expectedRevision: approved.body.revision, baseVersion: approved.body.state.version });
    assert.equal(reset.status, 201, JSON.stringify(reset.body));
    assert.equal((await entries('cancel')).length, 4);
    for (const entry of await entries('cancel')) assert.equal(entry.statutory_act, '수정');
    const versions = await witness.reportVersion.findMany({ where: { uid: state.uid }, orderBy: { version: 'asc' } });
    assert.equal(versions.length, 3);
    assert.equal(versions[0].findings, input.findings); assert.equal(versions[1].findings, input.findings);
    assert.equal(versions[2].reason, '합성 정정');
    const empty = await witness.studyState.create({ data: { uid: '1.2.840.9999.24', institutionId: institution, ss: 'Verified' } });
    const emptyReset = await send(empty.uid, '/report/commit', { ...input, expectedRevision: empty.draftEpoch + ':0',
      action: 'reset', reason: '아직 판독문이 없는 상태의 취소' });
    assert.equal(emptyReset.status, 201, JSON.stringify(emptyReset.body));
    assert.equal(emptyReset.body.signature, null);
    assert.equal(Number((await witness.$queryRaw`SELECT count(*)::int AS n FROM emr_signing.signed_version WHERE record_id=${empty.uid}`)[0].n), 0);
  } finally {
    if (app) await app.close();
    if (ready) await runtime.stop(Date.now() + 10000);
    await witness.$disconnect(); await new Promise(resolve => provider.close(resolve));
  }
});
