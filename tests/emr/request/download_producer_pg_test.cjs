'use strict';
// AR-IMPL-03: original-download HTTP -> missing access record -> real Nest/PG
// preparation, grant, byte supply, atomic failure and Access Review query.
// Only admission and the original-object HTTP source are synthetic adapters.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const api = process.env.KIN_DOWNLOAD_API || path.resolve(__dirname, '../../../api');
const build = process.env.KIN_DOWNLOAD_BUILD || path.join(api, 'dist');
const dependency = name => require(path.join(api, 'node_modules', name));
const product = name => require(path.join(build, name));
dependency('reflect-metadata');
const { Module, ForbiddenException } = dependency('@nestjs/common');
const { NestFactory, APP_GUARD } = dependency('@nestjs/core');
const { PrismaClient } = dependency('@prisma/client');
const { EmrRuntime } = product('emr-runtime/application');
const { createRequestContext, REQUEST_CONTEXT_SOURCE } = product('emr-runtime/request-context');
const { createRequestIngress } = product('emr-runtime/request-ingress');
const { StudyTransferLocalController } = product('study-transfer-local.controller');
const { StudyTransferLocalService } = product('study-transfer-local.service');
const { DicomImportGateService } = product('dicom-import-gate.service');
const { PrismaService } = product('prisma.service');
const { StudyAccessService } = product('study-access.service');
const { AuthService } = product('auth.service');
const audit = product('emr-audit/contract');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

async function main() {
  const uid = '2.25.20261025001', series = uid + '.1', sop = series + '.1';
  const issuer = 'https://synthetic.invalid/download', institution = 'download-fixture', sub = 'synthetic-downloader';
  const sourceId = '12345678-12345678-12345678-12345678-12345678';
  // Explicit VR LE synthetic Part 10 object; no production image or identifiers.
  const short = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const long = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const el = (g, e, vr, value) => {
    let bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (bytes.length % 2) bytes = Buffer.concat([bytes, Buffer.from([vr === 'UI' ? 0 : 32])]);
    return Buffer.concat([short(g), short(e), Buffer.from(vr),
      ['OB', 'OW'].includes(vr) ? Buffer.concat([short(0), long(bytes.length)]) : short(bytes.length), bytes]);
  };
  const meta = Buffer.concat([el(2, 1, 'OB', Buffer.from([0, 1])), el(2, 2, 'UI', '1.2.840.10008.5.1.4.1.1.2'),
    el(2, 3, 'UI', sop), el(2, 0x10, 'UI', '1.2.840.10008.1.2.1'), el(2, 0x12, 'UI', '2.25.77')]);
  const bytes = Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), el(2, 0, 'UL', long(meta.length)), meta,
    el(8, 0x16, 'UI', '1.2.840.10008.5.1.4.1.1.2'), el(8, 0x18, 'UI', sop), el(8, 0x60, 'CS', 'CT'),
    el(0x10, 0x10, 'PN', 'SYNTHETIC^DOWNLOAD'), el(0x10, 0x20, 'LO', 'SYN-DOWNLOAD'),
    el(0x20, 0x0d, 'UI', uid), el(0x20, 0x0e, 'UI', series), el(0x7fe0, 0x10, 'OW', Buffer.alloc(16, 0x5a))]);
  const md5 = createHash('md5').update(bytes).digest('hex');
  let truncated = false, changed = false, fileRequests = 0;
  const original = http.createServer((req, res) => {
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url === '/system') return json({ Version: '1.12.5' });
    if (req.url === '/tools/find') return json([sourceId]);
    if (req.url.endsWith('/simplified-tags')) return json({ StudyInstanceUID: uid, SeriesInstanceUID: series, SOPInstanceUID: sop });
    if (req.url.endsWith('/attachments/dicom/info')) return json({ UncompressedSize: bytes.length, UncompressedMD5: changed ? '0'.repeat(32) : md5 });
    if (req.url.endsWith('/file')) { fileRequests++; return res.end(truncated ? bytes.subarray(0, 140) : bytes); }
    res.statusCode = 404; res.end();
  });
  await listen(original);
  Object.assign(process.env, { KC_ISSUER: issuer, AUTH_REQUIRED: 'true',
    ORTHANC_URL: 'http://127.0.0.1:' + original.address().port, ORTHANC_USER: 'synthetic', ORTHANC_PASS: randomUUID() });
  const witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_B2R_WITNESS_URL } } });
  const runtime = new EmrRuntime(process.env.DATABASE_URL, process.env.KIN_B2R_SPOOL);
  let app;
  try {
    await witness.memberRights.create({ data: { sub, username: sub, email: 'synthetic@example.test', name: 'Synthetic',
      emailVerified: true, approved: true, suspended: false, institution, roles: ['radiologist'] } });
    await witness.studyState.create({ data: { uid, institutionId: institution, ss: 'Verified' } });
    await runtime.start();
    const requests = createRequestContext(createRequestIngress({ proxyPeers: [] }), runtime.port);
    const caller = { sub, actor: 'synthetic@example.test', institution, roles: ['radiologist'], kind: 'member' };
    const sessionRef = randomUUID();
    const guard = { async canActivate(context) {
      const req = context.switchToHttp().getRequest(), res = context.switchToHttp().getResponse();
      Object.assign(req, caller, { authMethod: 'session', sessionId: sessionRef });
      if (req.query.grant) req.archiveGrantAdmission = await app.get(StudyTransferLocalService).admitArchiveGrant(req, sessionRef);
      requests.capture.capture(req, res, { issuer, subject: sub, roles: caller.roles, institution, rightsVersion: 1,
        binding: { method: 'session', sessionRef } },
      { method: req.method, route: req.route.path.replace(/^\/api\//, ''), purpose: 'clinical' }, async tx => {
        const row = await (tx || witness).memberRights.findUnique({ where: { sub } });
        if (!row?.approved || row.suspended) throw new ForbiddenException();
      });
      return true;
    } };
    const source = { studyIdentityResources: async () => [{ '0020000D': { Value: [uid] } }] };
    class DownloadFixture {}
    Module({ controllers: [StudyTransferLocalController], providers: [PrismaService, StudyTransferLocalService, DicomImportGateService,
      { provide: REQUEST_CONTEXT_SOURCE, useValue: requests.source }, { provide: APP_GUARD, useValue: guard },
      { provide: StudyAccessService, useFactory: db => new StudyAccessService(db, source, {}), inject: [PrismaService] },
      { provide: AuthService, useValue: { hasSession: async () => true } }] })(DownloadFixture);
    app = await NestFactory.create(DownloadFixture, { logger: false, abortOnError: false });
    app.setGlobalPrefix('api'); await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl(), prefix = origin + '/api/studies/' + uid + '/original-downloads';
    const post = async (url, body) => {
      const answer = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: answer.status, body: await answer.json() };
    };
    const events = async id => (await witness.$queryRaw`SELECT payload::jsonb AS event, stream, statutory_act
      FROM emr_access.access_entry WHERE payload::jsonb->'targets'->0->'recordId'->>'value'=${id}
      ORDER BY sequence`).map(row => ({ ...row.event, stream: row.stream, act: row.statutory_act }));
    const operation = id => witness.importOperation.findUnique({ where: { id } });
    const settled = async id => {
      const until = Date.now() + 15000;
      while (Date.now() < until) {
        const row = await operation(id);
        if (row?.status !== 'sending') return row;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('download result did not settle');
    };
    const download = async id => {
      const granted = await post(prefix + '/' + id + '/archive/grant', {});
      assert.equal(granted.status, 200, JSON.stringify(granted));
      const received = await fetch(prefix + '/' + id + '/archive?grant=' + granted.body.grant);
      let body; try { body = Buffer.from(await received.arrayBuffer()); } catch { body = null; }
      return { received, body, row: await settled(id) };
    };
    const id = randomUUID();
    const prepared = await post(prefix, { operationId: id });
    assert.equal(prepared.status, 200, JSON.stringify(prepared));
    const complete = await download(id);
    assert.equal(complete.received.status, 200);
    assert.equal(complete.row.status, 'sent');
    assert.ok(complete.body.includes(bytes), 'the archive contains the actual original bytes');
    const ledger = await events(id);
    assert.deepEqual(ledger.map(e => e.action), ['provide-prepared', 'provide-prepared', 'provide-prepared', 'transfer-ended']);
    for (const event of ledger) {
      assert.equal(event.formatVersion, 2); assert.equal(event.branch, 'original-download');
      assert.equal(event.userId.value.subject, sub); assert.equal(event.userId.value.issuer, issuer);
      assert.equal(event.rightsVersion, 1); assert.deepEqual(event.session, { method: 'session', sessionRef });
      assert.equal(event.managingInstitution.value, institution); assert.equal(event.stream, 'viewing'); assert.equal(event.act, '열람');
      assert.equal(event.targets[0].studyId.value, uid); assert.equal(event.targets[0].versionId.value, prepared.body.manifestSha256);
      // A1's local-source shape: no formal PatientLink; the route never read the source PatientID/institution.
      assert.deepEqual(event.targets, [{ kind: 'download', studyId: { status: 'known', value: uid },
        recordId: { status: 'known', value: id }, versionId: { status: 'known', value: prepared.body.manifestSha256 },
        sourcePatientId: { status: 'unresolved', reason: 'not-observed' },
        sourceInstitution: { status: 'unresolved', reason: 'not-observed' }, projectionSha256: prepared.body.manifestSha256 }]);
    }
    assert.equal(ledger[3].relatedEventId, ledger[2].eventId);
    assert.equal(ledger[3].requestId, ledger[2].requestId);
    assert.deepEqual(ledger[3].targets, ledger[2].targets);
    assert.equal((await post(prefix, { operationId: id })).status, 200);
    assert.equal((await events(id)).length, 4, 'operation replay does not invent another download');
    // The investigation consumer (emr-audit) over these stored payloads: found by study, never a formal patient.
    const rows = (await witness.$queryRaw`SELECT sequence, payload, recorded_at FROM emr_access.access_entry
      WHERE payload::jsonb->'targets'->0->'recordId'->>'value'=${id} ORDER BY sequence`)
      .map(row => ({ entry: { sequence: Number(row.sequence), payload: { kind: 'access', event: JSON.parse(row.payload) } },
        durableAt: row.recorded_at.toISOString(), served: null }));
    const at = new Date().toISOString(), investigator = { id: randomUUID(), issuer, subject: 'synthetic-investigator' };
    const authority = audit.resolveAuditAuthority({ listGrants: subject => ({ subject, complete: true, grants: [{
      grantId: 'synthetic-grant', subject, institutionId: institution, events: [{ kind: 'granted', eventId: 'synthetic-grant-event',
        at, by: investigator, capacity: 'privacy-officer', basisDocumentId: 'synthetic-designation', scopes: ['investigate'],
        validFrom: at, validUntil: null }] }] }) }, { identity: investigator, institutionId: institution, roles: ['radiologist'] }, at);
    const investigate = filter => audit.readInvestigationPage(audit.planInvestigation(authority,
      { from: '2020-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z', ...filter }), {
      top: async () => Math.max(...rows.map(r => r.entry.sequence)),
      rows: async (top, below, take) => rows.filter(r => r.entry.sequence <= top && (below === null || r.entry.sequence < below))
        .sort((a, b) => b.entry.sequence - a.entry.sequence).slice(0, take) });
    const found = await investigate({ studyId: uid });
    assert.deepEqual(found.rows.map(r => r.eventId).sort(), ledger.map(e => e.eventId).sort());
    for (const row of found.rows) {
      assert.equal(row.targets[0].patient, null);
      assert.equal(row.targets[0].localSource.projectionSha256, prepared.body.manifestSha256);
    }
    assert.equal((await investigate({ sourcePatientId: 'SYN-DOWNLOAD' })).rows.length, 0, 'an unobserved PatientID is never matched');
    if (process.env.KIN_DOWNLOAD_REVIEW === '1') {
      // The Access Review branch's real bounded PostgreSQL query (its migration applied by the fixture), under runtime rights.
      const db = app.get(PrismaService);
      const review = await db.$queryRaw`SELECT * FROM emr_access.review_entries(${institution}::text,
        ${new Date(Date.now() - 60000)}::timestamptz, ${new Date(Date.now() + 60000)}::timestamptz,
        true, NULL::bigint, NULL::bigint, 25)`;
      assert.deepEqual(review.map(r => r.event_id).sort(), ledger.map(e => e.eventId).sort());
      console.log('access-review query listed the download rows');
    }

    // A real PG append failure rolls back the stage, its AuditLog projection,
    // and the grant consumption. No body bytes are supplied before durable intent.
    const rejected = randomUUID();
    await witness.$executeRawUnsafe(`ALTER TABLE emr_access.access_entry ADD CONSTRAINT download_test_failure CHECK (payload::jsonb->>'surface' <> 'POST studies/:uid/original-downloads') NOT VALID`);
    try { assert.equal((await post(prefix, { operationId: rejected })).status, 503); }
    finally { await witness.$executeRawUnsafe('ALTER TABLE emr_access.access_entry DROP CONSTRAINT download_test_failure'); }
    assert.equal(await operation(rejected), null);
    assert.equal(await witness.auditLog.count({ where: { detail: { contains: rejected } } }), 0);
    const retry = randomUUID(); assert.equal((await post(prefix, { operationId: retry })).status, 200);
    await witness.$executeRawUnsafe(`ALTER TABLE emr_access.access_entry ADD CONSTRAINT download_test_failure CHECK (payload::jsonb->>'surface' <> 'POST studies/:uid/original-downloads/:operationId/archive/grant') NOT VALID`);
    try { assert.equal((await post(prefix + '/' + retry + '/archive/grant', {})).status, 503); }
    finally { await witness.$executeRawUnsafe('ALTER TABLE emr_access.access_entry DROP CONSTRAINT download_test_failure'); }
    assert.equal((await operation(retry)).download.schemaVersion, 1, 'failed grant did not replace the stored operation');
    assert.equal(await witness.auditLog.count({ where: { action: 'original.download.grant', detail: { contains: retry } } }), 0);
    const granted = await post(prefix + '/' + retry + '/archive/grant', {}); assert.equal(granted.status, 200);
    const beforeFiles = fileRequests;
    await witness.$executeRawUnsafe(`ALTER TABLE emr_access.access_entry ADD CONSTRAINT download_test_failure CHECK (payload::jsonb->>'surface' <> 'GET studies/:uid/original-downloads/:operationId/archive') NOT VALID`);
    try {
      const refused = await fetch(prefix + '/' + retry + '/archive?grant=' + granted.body.grant);
      assert.equal(refused.status, 503); await refused.arrayBuffer();
    } finally { await witness.$executeRawUnsafe('ALTER TABLE emr_access.access_entry DROP CONSTRAINT download_test_failure'); }
    const stillPrepared = await operation(retry);
    assert.equal(stillPrepared.status, 'prepared'); assert.equal(stillPrepared.download.attempts.length, 0);
    assert.equal(stillPrepared.download.activeArchiveGrant.state, 'issued'); assert.equal(fileRequests, beforeFiles);
    truncated = true;
    const incomplete = await download(retry);
    assert.equal(incomplete.row.status, 'incomplete');
    const aborted = await events(retry);
    assert.equal(aborted.at(-1).action, 'transfer-aborted');
    assert.equal(aborted.at(-1).relatedEventId, aborted.at(-2).eventId);
    assert.ok(!aborted.some(e => e.action === 'transfer-ended'));
    truncated = false;
    const uncertain = randomUUID(); assert.equal((await post(prefix, { operationId: uncertain })).status, 200);
    const lastGrant = await post(prefix + '/' + uncertain + '/archive/grant', {}); assert.equal(lastGrant.status, 200);
    await witness.$executeRawUnsafe(`ALTER TABLE emr_access.access_entry ADD CONSTRAINT download_test_failure CHECK (payload::jsonb->>'action' <> 'transfer-ended') NOT VALID`);
    try {
      const received = await fetch(prefix + '/' + uncertain + '/archive?grant=' + lastGrant.body.grant);
      assert.equal(received.status, 200);
      assert.ok(Buffer.from(await received.arrayBuffer()).includes(bytes));
      let timer;
      try {
        await Promise.race([runtime.control.drained(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('retained request work did not settle')), 15000);
        })]);
      } finally { clearTimeout(timer); }
    } finally { await witness.$executeRawUnsafe('ALTER TABLE emr_access.access_entry DROP CONSTRAINT download_test_failure'); }
    assert.equal((await operation(uncertain)).status, 'sending', 'failed result append never claims Sent');
    assert.ok(!(await events(uncertain)).some(e => e.action === 'transfer-ended'));
    assert.equal(await witness.auditLog.count({ where: { action: 'original.download.result', detail: { contains: uncertain } } }), 0);

    // A refused archive start closes the admitted grant and records the refusal (act none) through the real parser and
    // ledger: no intent, no bytes. A changed original is a conflict (409); a lost right is a permission refusal (403).
    const refusal = async (change, restore) => {
      const op = randomUUID(); assert.equal((await post(prefix, { operationId: op })).status, 200);
      const issued = await post(prefix + '/' + op + '/archive/grant', {}); assert.equal(issued.status, 200);
      const files = fileRequests;
      await change();
      let status;
      try { const answer = await fetch(prefix + '/' + op + '/archive?grant=' + issued.body.grant); status = answer.status; await answer.arrayBuffer(); }
      finally { await restore(); }
      const row = await operation(op);
      assert.equal(row.status, 'prepared'); assert.equal(row.download.attempts.length, 0); assert.equal(fileRequests, files);
      assert.equal(row.download.activeArchiveGrant.state, 'refused');
      const recorded = await events(op);
      assert.deepEqual(recorded.map(e => e.action).slice(0, 2), ['provide-prepared', 'provide-prepared']);
      assert.equal(recorded.length, 3, 'one refusal row and no intent');
      const refused = recorded[2];
      assert.equal(refused.surface, 'GET studies/:uid/original-downloads/:operationId/archive');
      assert.equal(refused.act, 'none'); assert.equal(refused.stream, 'viewing'); assert.equal(refused.relatedEventId, null);
      assert.deepEqual(refused.targets, recorded[1].targets);
      return { status, code: row.download.activeArchiveGrant.refusal.code, action: refused.action, result: refused.result };
    };
    assert.deepEqual(await refusal(async () => { changed = true; }, async () => { changed = false; }),
      { status: 409, code: 'MANIFEST_CHANGED', action: 'conflict', result: 'failed' });
    const rights = suspended => witness.memberRights.update({ where: { sub }, data: { suspended } });
    const lost = await refusal(() => rights(true), () => rights(false));
    assert.equal(lost.status, 403); assert.equal(lost.action, 'permission-refused'); assert.equal(lost.result, 'refused');
    console.log('PASS actual download bytes; four B2 rows; investigation replay; ' +
      (process.env.KIN_DOWNLOAD_REVIEW === '1' ? 'access-review query; ' : 'access-review query NOT_RUN (no migration); ') +
      'replay; PG rollback of every stage; interrupted supply; refused starts (conflict, permission-refused)');
  } finally {
    if (app) await app.close();
    await runtime.stop(Date.now() + 15000); await witness.$disconnect();
    await new Promise(resolve => original.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
