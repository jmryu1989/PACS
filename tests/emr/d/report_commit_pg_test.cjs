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
  const bearer = (email, subject) => new jose.SignJWT({ email, realm_access: { roles: ['radiologist'] }, groups: ['/' + institution] })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer).setSubject(subject).setAudience('kin-api')
    .setIssuedAt().setExpirationTime('10m').sign(privateKey);
  const token = await bearer(author, sub);
  // FC-040: two more synthetic readers of the same institution - the one whose reading is in progress and a third who saved.
  const second = { sub: 'synthetic-report-second', author: 'second@example.test' };
  const third = { sub: 'synthetic-report-third', author: 'third@example.test' };
  second.token = await bearer(second.author, second.sub);
  third.token = await bearer(third.author, third.sub);
  const witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_D_WITNESS_URL } } });
  const runtime = new EmrRuntime(process.env.DATABASE_URL, process.env.KIN_D_SPOOL);
  let app, ready = false;
  try {
    await witness.memberRightsImport.create({ data: { id: 'realm-v1' } });
    await witness.memberRights.create({ data: { sub, username: sub, email: author, name: 'Synthetic',
      emailVerified: true, approved: true, suspended: false, institution, roles: ['radiologist'] } });
    for (const other of [second, third])
      await witness.memberRights.create({ data: { sub: other.sub, username: other.sub, email: other.author, name: 'Synthetic',
        emailVerified: true, approved: true, suspended: false, institution, roles: ['radiologist'] } });
    await runtime.start(); ready = true;
    const clinical = await require('./clinical_fixture.cjs').clinicalFixture(witness, runtime.port, issuer,
      [sub, second.sub, third.sub].map(member => ({ sub: member, institution, roles: ['radiologist'] })));
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
    const send = async (uid, endpoint, body, as = token) => {
      const response = await fetch(origin + '/api/studies/' + uid + endpoint, {
        method: endpoint === '/report' ? 'PUT' : 'POST',
        headers: { authorization: 'Bearer ' + as, 'content-type': 'application/json', 'x-real-ip': '192.0.2.23' },
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

    // ── FC-040: an in-progress reading (W/T/H) that another reader holds or saved goes back to Unread by any reader ──
    const text = { findings: '합성 진행 중 소견', conclusion: '합성 진행 중 결론', recommendation: '' };
    const study = async uid => witness.studyState.create({ data: { uid, institutionId: institution, ss: 'Verified' } });
    const draftOf = (uid, who) => witness.reportDraft.findUnique({ where: { uid_author: { uid, author: who } } });
    const ownerOf = who => who === second ? { institution, sub: second.sub, author: second.author }
      : who === third ? { institution, sub: third.sub, author: third.author } : { institution, sub, author };
    const tokenOf = who => who === second ? second.token : who === third ? third.token : token;
    // A reader's draft write and Save, through the product routes.
    const write = async (uid, who, body, baseVersion = 0) => {
      const state = await witness.studyState.findUnique({ where: { uid } });
      const row = await draftOf(uid, ownerOf(who).author);
      const written = await send(uid, '/report', { expectedOwner: ownerOf(who), expectedRevision: state.draftEpoch + ':' + (row?.revision ?? 0),
        baseVersion, ...body, citationIds: [], structureIds: [] }, tokenOf(who));
      assert.equal(written.status, 200, JSON.stringify(written.body));
      return written.body;
    };
    const save = async (uid, who) => {
      const written = await write(uid, who, text);
      const saved = await send(uid, '/report/commit', { expectedOwner: ownerOf(who), expectedRevision: written.revision, baseVersion: 0,
        ...text, citationIds: [], structureIds: [], action: 'save' }, tokenOf(who));
      assert.equal(saved.status, 201, JSON.stringify(saved.body));
      return saved.body;
    };
    const hold = async (uid, who, body = {}) => (await send(uid, '/hold', body, tokenOf(who))).body;
    // The first reader resets with no reason of their own: the server writes it.
    const resetByFirst = async (uid, reason) => {
      const state = await witness.studyState.findUnique({ where: { uid } });
      const head = await witness.report.findUnique({ where: { uid } });
      return send(uid, '/report/commit', { expectedOwner: { institution, sub, author }, expectedRevision: state.draftEpoch + ':0',
        baseVersion: head?.version ?? 0, findings: '', conclusion: '', recommendation: '', citationIds: [], structureIds: [],
        action: 'reset', ...(reason ? { reason } : {}) });
    };
    const lastAudit = uid => witness.auditLog.findFirst({ where: { action: 'report.reset', target: uid }, orderBy: { id: 'desc' } });

    // (가) another reader's live hold on a W study, with that reader's own private draft: released, draft untouched.
    const held = await study('1.2.840.9999.40');
    await write(held.uid, second, text);
    assert.equal((await hold(held.uid, second)).mine, true);
    const keptDraft = await draftOf(held.uid, second.author);
    const releasedHold = await resetByFirst(held.uid);
    assert.equal(releasedHold.status, 201, JSON.stringify(releasedHold.body));
    assert.equal(releasedHold.body.state.rs, 'W');
    assert.equal(releasedHold.body.state.holder, null);
    assert.deepEqual(releasedHold.body.released, { holder: second.author, holderDraft: true, savedBy: null, savedKept: false });
    assert.equal((await witness.studyState.findUnique({ where: { uid: held.uid } })).holder, null);
    const heldReset = await witness.reportVersion.findFirst({ where: { uid: held.uid, action: 'reset' } });
    assert.equal(heldReset.reason, `진행 중 판독 되돌림 (점유: ${second.author}, 저장 글: 없음)`);
    const heldAudit = JSON.parse((await lastAudit(held.uid)).detail);
    assert.equal(heldAudit.takeover.holder, second.author);
    assert.equal(heldAudit.takeover.savedBy, null);
    assert.ok(heldAudit.takeover.heldAt);
    const untouched = await draftOf(held.uid, second.author);
    assert.deepEqual([untouched.present, untouched.revision, untouched.findings, untouched.workUnit],
      [true, keptDraft.revision, keptDraft.findings, keptDraft.workUnit]);
    // The released reader's heartbeat renews only its own hold: it does not take the study back.
    const renewed = await hold(held.uid, second, { renew: true });
    assert.deepEqual([renewed.lost, renewed.mine, renewed.conflict, renewed.holder], [true, false, false, null]);
    assert.equal((await witness.studyState.findUnique({ where: { uid: held.uid } })).holder, null);
    // A renew from the current holder still extends it; a hold request without a body is unchanged (takes a free study).
    assert.equal((await hold(held.uid, second)).mine, true);
    assert.equal((await hold(held.uid, second, { renew: true })).mine, true);
    const takenOver = await hold(held.uid, third, { renew: true });
    assert.deepEqual([takenOver.lost, takenOver.conflict, takenOver.holder], [true, true, second.author]);

    // (가) on an On Hold (H) study: the same path.
    const deferred = await study('1.2.840.9999.41');
    await witness.studyState.update({ where: { uid: deferred.uid }, data: { rs: 'H' } });
    assert.equal((await hold(deferred.uid, second)).mine, true);
    const deferredReset = await resetByFirst(deferred.uid);
    assert.equal(deferredReset.status, 201, JSON.stringify(deferredReset.body));
    assert.equal(deferredReset.body.state.rs, 'W');
    assert.deepEqual(deferredReset.body.released, { holder: second.author, holderDraft: false, savedBy: null, savedKept: false });

    // (나) another reader's saved text (T), hold expired, no live draft of theirs: kept as history and moved to their draft.
    const saved = await study('1.2.840.9999.42');
    const savedHead = await save(saved.uid, second);
    assert.equal(savedHead.state.rs, 'T');
    const before = await draftOf(saved.uid, second.author);
    const movedReset = await resetByFirst(saved.uid);
    assert.equal(movedReset.status, 201, JSON.stringify(movedReset.body));
    assert.deepEqual(movedReset.body.released, { holder: null, holderDraft: false, savedBy: second.author, savedKept: true });
    assert.ok(movedReset.body.signature, 'the reset of a saved version is signed as before');
    const savedVersions = await witness.reportVersion.findMany({ where: { uid: saved.uid }, orderBy: { version: 'asc' } });
    assert.deepEqual(savedVersions.map(v => v.action), ['save', 'discarded', 'reset']);
    assert.equal(savedVersions[1].author, second.author);
    assert.equal(savedVersions[1].findings, text.findings);
    assert.equal(savedVersions[2].reason, `진행 중 판독 되돌림 (점유: 없음, 저장 글: ${second.author})`);
    const moved = await draftOf(saved.uid, second.author);
    assert.equal(moved.present, true);
    assert.deepEqual([moved.findings, moved.conclusion, moved.recommendation], [text.findings, text.conclusion, text.recommendation]);
    assert.equal(moved.baseVersion, savedHead.state.version, 'the moved draft stands on the version it came from');
    assert.equal(moved.revision, before.revision + 1);
    assert.ok(moved.workUnit && moved.workUnit !== before.workUnit, 'a new work');
    assert.equal(JSON.parse((await lastAudit(saved.uid)).detail).takeover.savedBy, second.author);
    // The executor's record and the moved author's draft record are separate entries of the same commit.
    const epoch = (await witness.studyState.findUnique({ where: { uid: saved.uid } })).draftEpoch;
    const movedRecords = await witness.$queryRaw`SELECT e.payload::jsonb AS facts FROM emr_access.access_entry e
      WHERE e.payload::jsonb->>'surface'='POST studies/:uid/report/commit'
      AND e.payload::jsonb->'targets'->0->'recordId'->>'value' = ${JSON.stringify([saved.uid, second.author])}`;
    assert.ok(movedRecords.length >= 1, 'the moved author draft has its own access record');
    for (const { facts } of movedRecords) {
      assert.equal(facts.userId.value.subject, sub, 'recorded as the executor');
      assert.equal(facts.targets[0].kind, 'private-draft');
      assert.equal(facts.targets[0].versionId.value, epoch + ':' + moved.revision);
      assert.equal(facts.action, 'draft-save');
    }
    const executorRecords = await witness.$queryRaw`SELECT count(*)::int AS n FROM emr_access.access_entry e
      WHERE e.payload::jsonb->>'surface'='POST studies/:uid/report/commit'
      AND e.payload::jsonb->'targets'->0->'studyId'->>'value' = ${saved.uid}
      AND e.payload::jsonb->'targets'->0->>'kind' = 'report-version'`;
    assert.ok(executorRecords[0].n >= 1);

    // (나) with a live draft of the saver already present: that draft is not touched, the saved text stays in history only.
    const kept = await study('1.2.840.9999.43');
    const keptHead = await save(kept.uid, second);
    await write(kept.uid, second, { findings: '합성 새 초안', conclusion: '', recommendation: '' }, keptHead.state.version);
    const liveDraft = await draftOf(kept.uid, second.author);
    const keptReset = await resetByFirst(kept.uid);
    assert.equal(keptReset.status, 201, JSON.stringify(keptReset.body));
    assert.deepEqual(keptReset.body.released, { holder: null, holderDraft: false, savedBy: second.author, savedKept: false });
    const stillLive = await draftOf(kept.uid, second.author);
    assert.deepEqual([stillLive.present, stillLive.revision, stillLive.findings, stillLive.baseVersion, stillLive.workUnit],
      [true, liveDraft.revision, '합성 새 초안', keptHead.state.version, liveDraft.workUnit]);
    assert.equal((await witness.reportVersion.findFirst({ where: { uid: kept.uid, action: 'discarded' } })).findings, text.findings);

    // The holder and the saver are different readers: the answer keeps them apart.
    const split = await study('1.2.840.9999.44');
    await save(split.uid, third);
    assert.equal((await hold(split.uid, second)).mine, true);
    const splitReset = await resetByFirst(split.uid);
    assert.equal(splitReset.status, 201, JSON.stringify(splitReset.body));
    assert.deepEqual(splitReset.body.released, { holder: second.author, holderDraft: false, savedBy: third.author, savedKept: true });
    assert.equal((await draftOf(split.uid, third.author)).present, true);
    assert.equal(await draftOf(split.uid, second.author), null, 'the holder had no draft and gets none');
    assert.equal((await witness.reportVersion.findFirst({ where: { uid: split.uid, action: 'reset' } })).reason,
      `진행 중 판독 되돌림 (점유: ${second.author}, 저장 글: ${third.author})`);

    // Approved (A): this path does not exist - another reader's hold refuses the reset as before, reason or not.
    const approvedStudy = await study('1.2.840.9999.45');
    const approvedDraft = await write(approvedStudy.uid, second, text);
    const secondApproval = await send(approvedStudy.uid, '/report/commit', { expectedOwner: ownerOf(second),
      expectedRevision: approvedDraft.revision, baseVersion: 0, ...text, citationIds: [], structureIds: [], action: 'approve' }, second.token);
    assert.equal(secondApproval.status, 201, JSON.stringify(secondApproval.body));
    assert.equal((await hold(approvedStudy.uid, second)).mine, true);
    for (const reason of [undefined, '합성 정정']) {
      const refused = await resetByFirst(approvedStudy.uid, reason);
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.equal(refused.body.code, 'REPORT_HELD');
    }
    assert.equal((await witness.studyState.findUnique({ where: { uid: approvedStudy.uid } })).rs, 'A');
    // An approved report with no other hold still needs its reason, as before.
    await send(approvedStudy.uid, '/release', {}, second.token);
    assert.equal((await resetByFirst(approvedStudy.uid)).status, 400);

    // Preliminary (P): the existing rule - only its two readers, never a bypass of the hold.
    const prelim = await study('1.2.840.9999.46');
    await witness.studyState.update({ where: { uid: prelim.uid }, data: { rs: 'P', preDoc: second.author, preDocSub: second.sub,
      preReviewer: third.author, preReviewerSub: third.sub, holder: second.author, holderInstitutionId: institution, heldAt: new Date() } });
    for (const reason of [undefined, '합성 정정']) assert.notEqual((await resetByFirst(prelim.uid, reason)).status, 201);
    assert.equal((await witness.studyState.findUnique({ where: { uid: prelim.uid } })).rs, 'P');

    // My own saved text only (no other hold or saver): the reason is still required.
    const mine = await study('1.2.840.9999.47');
    const mineDraft = await write(mine.uid, null, text);
    const mineSaved = await send(mine.uid, '/report/commit', { expectedOwner: { institution, sub, author }, expectedRevision: mineDraft.revision,
      baseVersion: 0, ...text, citationIds: [], structureIds: [], action: 'save' });
    assert.equal(mineSaved.status, 201, JSON.stringify(mineSaved.body));
    assert.equal((await resetByFirst(mine.uid)).status, 400);

    // ── FC-034: the approving reader amends within 24 hours of the first approval; the window, the approver and Addendum close it ──
    const verify = product('emr-signature/server-verification').verifyRegisteredServerEnvelope;
    const commitAs = async (uid, who, action, body, extra = {}) => {
      const state = await witness.studyState.findUnique({ where: { uid } });
      const head = await witness.report.findUnique({ where: { uid } });
      const row = await draftOf(uid, ownerOf(who).author);
      return send(uid, '/report/commit', { expectedOwner: ownerOf(who), expectedRevision: state.draftEpoch + ':' + (row?.revision ?? 0),
        baseVersion: head?.version ?? 0, findings: '', conclusion: '', recommendation: '', citationIds: [], structureIds: [],
        ...body, action, ...extra }, tokenOf(who));
    };
    const stateOf = uid => witness.studyState.findUnique({ where: { uid } });
    const fixed = text => ({ findings: text, conclusion: '합성 결론', recommendation: '' });

    const amended = await study('1.2.840.9999.60');
    await write(amended.uid, null, fixed('승인한 소견'));
    const first = await commitAs(amended.uid, null, 'approve', fixed('승인한 소견'));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const approvedState = await stateOf(amended.uid);
    assert.ok(approvedState.approvedAt instanceof Date, 'approve writes the server time of the approval');
    assert.equal(approvedState.approvedBySub, sub, 'approve writes the approver subject');
    assert.deepEqual([approvedState.amendedAt, approvedState.addendumAt], [null, null]);
    assert.equal(first.body.state.amendUntil, new Date(approvedState.approvedAt.getTime() + 86_400_000).toISOString());
    assert.equal(first.body.state.amendMine, true);
    assert.ok(!JSON.stringify(first.body.state).includes(sub), 'the study state does not carry the approver subject');
    const approvalSignature = (await witness.$queryRaw`SELECT outcome FROM emr_signing.signed_version
      WHERE record_id=${amended.uid} AND version_id='1'`)[0].outcome;

    // A correction with the author's own draft (written on the approved report, as the editor does): a signed amend version.
    await write(amended.uid, null, fixed('고친 소견'), 1);
    const correction = await commitAs(amended.uid, null, 'amend', fixed('고친 소견'));
    assert.equal(correction.status, 201, JSON.stringify(correction.body));
    assert.equal(correction.body.state.rs, 'A');
    const afterAmend = await stateOf(amended.uid);
    assert.deepEqual([afterAmend.rs, afterAmend.repDoc, afterAmend.confirm, afterAmend.approvedAt.getTime(), afterAmend.approvedBySub],
      [approvedState.rs, approvedState.repDoc, approvedState.confirm, approvedState.approvedAt.getTime(), sub],
      'rs, the approver name, the confirm date and the window start stay');
    assert.ok(afterAmend.amendedAt instanceof Date);
    assert.equal(correction.body.state.amendUntil, first.body.state.amendUntil, 'an amendment does not restart the window');
    const amendVersions = await witness.reportVersion.findMany({ where: { uid: amended.uid }, orderBy: { version: 'asc' } });
    assert.deepEqual(amendVersions.map(v => [v.version, v.action, v.findings]), [[1, 'approve', '승인한 소견'], [2, 'amend', '고친 소견']]);
    const amendPayload = verify(correction.body.signature.envelope, correction.body.signature.keyAtSigning).payload;
    assert.equal(amendPayload.action, 'amend');
    assert.equal(amendPayload.previousVersion.versionId, '1');
    assert.equal(JSON.parse(amendPayload.text.body).findings, '고친 소견');
    assert.deepEqual((await witness.$queryRaw`SELECT outcome FROM emr_signing.signed_version
      WHERE record_id=${amended.uid} AND version_id='1'`)[0].outcome, approvalSignature, 'the approval signature stays as it was');
    // The draft's purpose ends with the signed amendment.
    const [ending] = await witness.$queryRaw`SELECT "workIntent", trigger, "signedVersionId" FROM "ReportDraftPurposeEnd"
      WHERE uid=${amended.uid} ORDER BY "endedAt" DESC LIMIT 1`;
    assert.deepEqual([ending.workIntent, ending.trigger, ending.signedVersionId], ['amend', 'result-version-signed', '2']);
    assert.equal((await draftOf(amended.uid, author)).present, false);
    assert.ok((await entries('amend')).some(e => e.facts.context.studyId === amended.uid), 'the access record names the amendment');
    assert.ok(await witness.auditLog.findFirst({ where: { action: 'report.amend', target: amended.uid } }));

    // A second correction follows the first correction, not the approval.
    const again = await commitAs(amended.uid, null, 'amend', fixed('다시 고친 소견'));
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(verify(again.body.signature.envelope, again.body.signature.keyAtSigning).payload.previousVersion.versionId, '2');

    const refusal = async (who, body, extra) => {
      const answer = await commitAs(amended.uid, who, 'amend', body, extra);
      return [answer.status, answer.body.code ?? null, String(answer.body.message ?? '')];
    };
    const unchanged = async () => (await witness.reportVersion.count({ where: { uid: amended.uid } }));
    const versionCount = await unchanged();
    // The same text again is not a correction.
    const same = await refusal(null, fixed('다시 고친 소견'));
    assert.equal(same[0], 400); assert.match(same[2], /고친 내용이 없습니다/);
    // Another reader cannot amend; the approver's draft written on an older version is the stale-draft refusal.
    assert.match((await refusal(second, fixed('남이 고친 소견')))[2], /승인한 판독의만/);
    await write(amended.uid, null, fixed('옛 판을 기준으로 쓴 글'), 1);
    assert.deepEqual((await refusal(null, fixed('옛 판을 기준으로 쓴 글'))).slice(0, 2), [409, 'REPORT_DRAFT_STALE']);
    // 24 hours after the first approval (the server clock against the stored start): Finalized, Addendum only.
    await witness.$executeRaw`UPDATE "StudyState" SET "approvedAt" = "approvedAt" - interval '24 hours' WHERE uid=${amended.uid}`;
    assert.match((await refusal(null, fixed('늦게 고친 소견')))[2], /24시간이 지나 Finalized/);
    // An approval whose time is unknown (a report approved before this change, unconfirmed by the backfill).
    await witness.$executeRaw`UPDATE "StudyState" SET "approvedAt" = NULL WHERE uid=${amended.uid}`;
    assert.match((await refusal(null, fixed('늦게 고친 소견')))[2], /승인 시각을 확인할 수 없는/);
    await witness.$executeRaw`UPDATE "StudyState" SET "approvedAt" = now() AT TIME ZONE 'UTC' WHERE uid=${amended.uid}`;
    assert.equal(await unchanged(), versionCount, 'no refused amendment wrote a version');
    // An Addendum (by anyone) closes the amendment.
    const added = await commitAs(amended.uid, second, 'addendum', fixed('덧붙인 소견'));
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.ok((await stateOf(amended.uid)).addendumAt instanceof Date);
    assert.match((await refusal(null, fixed('덧붙인 뒤 고친 소견')))[2], /Addendum\)가 붙은 판독문/);
    // Save and approve on an approved report stay refused.
    for (const action of ['save', 'approve'])
      assert.equal((await commitAs(amended.uid, null, action, fixed('승인본 위에 쓴 글'))).status, 400, action);
    // Reset (with its reason) ends the round: all four lookup values are cleared.
    const cleared = await commitAs(amended.uid, null, 'reset', {}, { reason: '합성 정정' });
    assert.equal(cleared.status, 201, JSON.stringify(cleared.body));
    const resetState = await stateOf(amended.uid);
    assert.deepEqual([resetState.approvedAt, resetState.approvedBySub, resetState.amendedAt, resetState.addendumAt], [null, null, null, null]);

    // Backfill (the migration's own statement): an approved report's round is read from its approve version, the signer of
    // that version and the Addendum after it; an unapproved one is not touched.
    const backfilled = await study('1.2.840.9999.61');
    await write(backfilled.uid, null, fixed('옛 승인 소견'));
    assert.equal((await commitAs(backfilled.uid, null, 'approve', fixed('옛 승인 소견'))).status, 201);
    assert.equal((await commitAs(backfilled.uid, second, 'addendum', fixed('옛 덧붙임'))).status, 201);
    const open = await study('1.2.840.9999.62');
    await save(open.uid, second);
    await witness.$executeRaw`UPDATE "StudyState" SET "approvedAt" = NULL, "approvedBySub" = NULL, "amendedAt" = NULL, "addendumAt" = NULL
      WHERE uid IN (${backfilled.uid}, ${open.uid})`;
    const migration = require('node:fs').readFileSync(path.resolve(__dirname, '../../../api/prisma/migrations/20261111150000_report_amend_window/migration.sql'), 'utf8');
    const statement = migration.match(/WITH approval AS[\s\S]*?;/)[0];
    await witness.$executeRawUnsafe(statement);
    const [approveRow, addendumRow] = await witness.reportVersion.findMany({ where: { uid: backfilled.uid }, orderBy: { version: 'asc' } });
    const filled = await stateOf(backfilled.uid);
    assert.deepEqual([filled.approvedAt.getTime(), filled.approvedBySub, filled.amendedAt, filled.addendumAt.getTime()],
      [approveRow.at.getTime(), sub, null, addendumRow.at.getTime()]);
    const untouched2 = await stateOf(open.uid);
    assert.deepEqual([untouched2.approvedAt, untouched2.approvedBySub, untouched2.addendumAt], [null, null, null]);
  } finally {
    if (app) await app.close();
    if (ready) await runtime.stop(Date.now() + 10000);
    await witness.$disconnect(); await new Promise(resolve => provider.close(resolve));
  }
});
