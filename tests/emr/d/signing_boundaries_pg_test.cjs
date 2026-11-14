'use strict';
// CD-09 W-G WG1-WG5: synthetic studies, findings, consultations, image requests and manual SRs -> observed
// PostgreSQL lock, waiter and row facts -> HTTP result. Real AuthGuard and controllers, finding source reader,
// C2 signer, fixed-record locks and B2 transactions. Each case states its input, observes the branch it needs
// on the database (holder connections, pg_locks advisory keys, pg_blocking_pids, NOWAIT probes, xmin) before
// the product answers, then asserts the product result. Lock keys are computed here from their stored JSON
// form, not imported from the product. Finding cases run through two compositions over one database: the
// fixture's (synthetic identity and study facts) and the deployed one (startupClinicalProviders: request
// identity, current clinical context, configured wrapping secrets and their route source reader).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const api = process.env.KIN_D_API || path.resolve(__dirname, '../../../api');
const dependency = name => require(path.join(api, 'node_modules', name));
const product = name => require(path.join(api, 'dist', name));
dependency('reflect-metadata');
const { PrismaClient, Prisma } = dependency('@prisma/client');
const jose = dependency('jose');
const { Module, ServiceUnavailableException } = dependency('@nestjs/common');
const { NestFactory, APP_GUARD } = dependency('@nestjs/core');

test('CD-09 W-G signed records and their references: fixed-record set, source versions, signing predecessors, B2 outcomes', async t => {
  const { EmrRuntime } = product('emr-runtime/application');
  const { EMR_RECORD_PORT } = product('emr-runtime/record-port');
  const { EMR_BACKGROUND_WORK } = product('emr-runtime/background-work');
  const { PrismaService } = product('prisma.service');
  const { StudyAccessService } = product('study-access.service');
  const { OrthancService } = product('orthanc.service');
  const { KeycloakService } = product('keycloak.service');
  const { FindingService } = product('finding.service');
  const { ClinicalStore } = product('emr-clinical/store');
  const { clinicalRouteSources } = product('emr-clinical/sources');
  const { findingSources } = product('emr-source/finding');
  const services = ['pacs', 'clinician-question', 'consultation', 'image-request', 'finding', 'manual-sr'];
  const className = name => name.split('-').map(x => x[0].toUpperCase() + x.slice(1)).join('');
  const issuer = 'https://synthetic.example.test/realms/signing', institution = 'signing-fixture';
  // doctor signs native reports, findings, consultation replies, answers, SRs and (as technician) Tech Notes;
  // other requests consultations; clinician asks questions and requests images.
  const members = Object.fromEntries(Object.entries({ doctor: ['radiologist', 'technician'], other: ['radiologist'],
    clinician: ['clinician'] }).map(([name, roles]) => [name, { sub: randomUUID(), username: 'wg-' + name,
    email: name + '@example.test', roles }]));
  Object.assign(process.env, { KC_ISSUER: issuer, KC_AUDIENCE: 'kin-api', AUTH_REQUIRED: 'true',
    KIN_COOKIE_SECRET: randomUUID(), KC_WEB_SECRET: randomUUID(), PUBLIC_ORIGIN: 'https://synthetic.example.test' });
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  const jwk = { ...await jose.exportJWK(publicKey), kid: 'signing-fixture', alg: 'RS256', use: 'sig' };
  const provider = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  process.env.KC_JWKS_URL = 'http://127.0.0.1:' + provider.address().port + '/certs';
  const tokens = {};
  for (const [name, m] of Object.entries(members)) tokens[name] = await new jose.SignJWT({ email: m.email,
    realm_access: { roles: m.roles }, groups: ['/' + institution] }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer(issuer).setSubject(m.sub).setAudience('kin-api').setIssuedAt().setExpirationTime('30m').sign(privateKey);
  const witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_D_WITNESS_URL } } });
  const runtimeDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const runtime = new EmrRuntime(process.env.DATABASE_URL, process.env.KIN_D_SPOOL);
  const custody = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-startup-'));
  let app, startupApp, relay, ready = false;
  try {
    await witness.memberRightsImport.create({ data: { id: 'realm-v1' } });
    for (const m of Object.values(members)) await witness.memberRights.create({ data: { sub: m.sub, username: m.username,
      email: m.email, name: 'Synthetic ' + m.username, emailVerified: true, approved: true, suspended: false, institution, roles: m.roles } });
    await runtime.start(); ready = true;
    // The finding source reader is the product's, over the FindingService the module below constructs.
    let findingService;
    const clinical = await require('./clinical_fixture.cjs').clinicalFixture(witness, runtime.port, issuer,
      Object.values(members).map(m => ({ sub: m.sub, institution, roles: m.roles })),
      identity => clinicalRouteSources(identity, runtime.port, (...args) => findingSources(findingService, identity)(...args)));
    const users = Object.values(members).map(m => ({ id: m.sub, username: m.username, email: m.email, firstName: m.username,
      enabled: true, groups: [institution], roles: m.roles }));
    const keycloak = { getUser: async sub => users.find(u => u.id === sub),
      assignmentReaders: async () => users, isReader: async () => true };
    // A manual SR's source tags; an upload is refused before storage, so its committed intent is what is observed.
    const tagsFor = uid => ({ StudyInstanceUID: uid, SeriesInstanceUID: uid + '.1', SOPInstanceUID: uid + '.1.1',
      SOPClassUID: '1.2.840.10008.5.1.4.1.1.2', FrameOfReferenceUID: uid + '.2', Modality: 'CT',
      PatientID: 'synthetic:' + uid, PatientName: 'SYNTHETIC^WG', Rows: 32, Columns: 32,
      ImagePositionPatient: [0, 0, 0], ImageOrientationPatient: [1, 0, 0, 0, 1, 0], PixelSpacing: [1, 1],
      _kinSourceDigest: 'a'.repeat(64) });
    // Every synthetic study is one patient's, so a comparison source passes the same-patient check.
    const orthanc = { studyIdentityResources: async uid => [{ '0020000D': { Value: [uid] }, '00100020': { Value: ['SYN-PATIENT-' + uid] } }], studyIdentities: async () => [],
      studyPatientIdentity: async () => 'synthetic:wg', connectStudyIdentity: async () => ({ patientId: 'synthetic:wg' }),
      viewerReference: async sop => tagsFor(sop.split('.').slice(0, -2).join('.')),
      manualSrLocation: async () => null,
      storeManualSr: async () => { throw new ServiceUnavailableException('synthetic upload unavailable before storage'); } };
    class HttpFixture {}
    const { createRequestContext, REQUEST_CONTEXT_CAPTURE, REQUEST_CONTEXT_SOURCE } = product('emr-runtime/request-context');
    const { createRequestIngress } = product('emr-runtime/request-ingress');
    const requests = createRequestContext(createRequestIngress({ proxyPeers: ['127.0.0.1'] }), runtime.port);
    Module({ controllers: services.map(n => product(n + '.controller')[className(n) + 'Controller']),
      providers: [PrismaService, ...services.filter(n => n !== 'finding').map(n => product(n + '.service')[className(n) + 'Service']),
        { provide: FindingService, inject: [PrismaService, StudyAccessService],
          useFactory: (db, access) => (findingService = new FindingService(db, access, orthanc)) },
        product('auth.service').AuthService, product('presence.service').PresenceService, ...clinical.providers,
        { provide: REQUEST_CONTEXT_CAPTURE, useValue: requests.capture }, { provide: REQUEST_CONTEXT_SOURCE, useValue: requests.source },
        { provide: OrthancService, useValue: orthanc }, { provide: KeycloakService, useValue: keycloak },
        { provide: StudyAccessService, useFactory: db => new StudyAccessService(db, orthanc, keycloak), inject: [PrismaService] },
        { provide: EMR_RECORD_PORT, useValue: runtime.port },
        { provide: EMR_BACKGROUND_WORK, useValue: runtime.background.work },
        { provide: APP_GUARD, useClass: product('auth.guard').AuthGuard },
        { provide: product('study-transfer-local.service').StudyTransferLocalService, useValue: {} }] })(HttpFixture);
    app = await NestFactory.create(HttpFixture, { rawBody: true, logger: ['error'] });
    app.setGlobalPrefix('api'); await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    // The deployed composition of the finding route over the same database, keys (wrapped by the fixture's
    // secret, read here through the configured custody file) and request context.
    const secretFile = path.join(custody, 'wrapping.key');
    fs.writeFileSync(secretFile, clinical.wrappingSecret);
    Object.assign(process.env, { KIN_EMR_WRAPPING_KEY_ID: 'fixture-wrap', KIN_EMR_WRAPPING_KEY_FILES: JSON.stringify({ 'fixture-wrap': secretFile }) });
    class StartupFixture {}
    Module({ controllers: [product('finding.controller').FindingController],
      providers: [PrismaService,
        { provide: FindingService, inject: [PrismaService, StudyAccessService], useFactory: (db, access) => new FindingService(db, access, orthanc) },
        product('auth.service').AuthService, product('presence.service').PresenceService,
        ...product('emr-clinical/startup').startupClinicalProviders,
        { provide: REQUEST_CONTEXT_CAPTURE, useValue: requests.capture }, { provide: REQUEST_CONTEXT_SOURCE, useValue: requests.source },
        { provide: OrthancService, useValue: orthanc }, { provide: KeycloakService, useValue: keycloak },
        { provide: StudyAccessService, useFactory: db => new StudyAccessService(db, orthanc, keycloak), inject: [PrismaService] },
        { provide: EMR_RECORD_PORT, useValue: runtime.port },
        { provide: EMR_BACKGROUND_WORK, useValue: runtime.background.work },
        { provide: APP_GUARD, useClass: product('auth.guard').AuthGuard },
        { provide: product('study-transfer-local.service').StudyTransferLocalService, useValue: {} }] })(StartupFixture);
    startupApp = await NestFactory.create(StartupFixture, { rawBody: true, logger: ['error'] });
    startupApp.setGlobalPrefix('api'); await startupApp.listen(0, '127.0.0.1');
    const headers = who => ({ authorization: 'Bearer ' + tokens[who], 'content-type': 'application/json', 'x-real-ip': '192.0.2.23' });
    const callAt = base => async (who, method, route, body) => {
      const response = await fetch(base + '/api' + route, { method, headers: headers(who),
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      let value; try { value = JSON.parse(text); } catch { value = text; }
      return { status: response.status, body: value };
    };
    const call = callAt(origin), startup = callAt(await startupApp.getUrl());
    const compositions = { fixture: call, startup };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const log = (label, value) => console.log('WG-WITNESS ' + JSON.stringify({ label, ...value }));
    const ok = (out, status, label) => assert.equal(out.status, status, label + ' ' + JSON.stringify(out));
    const owner = who => [institution, members[who].sub];

    // --- inputs through the real routes
    let serial = 0;
    const fresh = async () => (await witness.studyState.create({ data: { uid: '2.25.9411.' + ++serial,
      institutionId: institution, ss: 'Verified' } })).uid;
    const draftOwner = who => ({ institution, sub: members[who].sub, author: members[who].email });
    const draft = async (uid, who = 'doctor') => { const out = await call(who, 'GET', `/studies/${uid}/draft`); ok(out, 200, 'draft'); return out.body; };
    const commit = async (uid, action, who = 'doctor') => {
      const d = await draft(uid, who), head = await witness.report.findUnique({ where: { uid } });
      const body = { expectedOwner: draftOwner(who), expectedRevision: d.revision, baseVersion: head?.version ?? 0,
        findings: 'SYN signed ' + uid + ' ' + action, conclusion: '', recommendation: '', citationIds: [], structureIds: [],
        action, ...(action === 'reset' ? { reason: 'SYN reset' } : {}) };
      return () => call(who, 'POST', `/studies/${uid}/report/commit`, body);
    };
    const signed = async () => {
      const uid = await fresh(); const out = await (await commit(uid, 'approve'))();
      ok(out, 201, 'approve'); assert.ok(out.body.signature, 'the normal control uses the real signer'); return uid;
    };
    const viewerItem = async (uid, snapshot) => {
      const id = randomUUID();
      const [{ bytes }] = await witness.$queryRaw`SELECT octet_length(convert_to(${JSON.stringify(snapshot)}::jsonb::text, 'UTF8')) AS bytes`;
      await witness.viewerItem.create({ data: { id, studyUid: uid, authorSub: members.doctor.sub, authorActor: members.doctor.email,
        revision: 1, snapshot, updatedAt: new Date(), revisions: { create: { revision: 1, snapshot, action: 'create', reason: '',
          actor: members.doctor.email, payloadBytes: bytes } } } });
      return { id, snapshot };
    };
    const keyItem = (uid, title = 'SYN key image') => viewerItem(uid, { schemaVersion: 1, kind: 'key', seriesUid: uid + '.1',
      sopUid: uid + '.1.1', frame: 1, title, description: '', hidden: false });
    const measurementItem = (uid, label = 'SYN length') => viewerItem(uid, { schemaVersion: 1, kind: 'length', seriesUid: uid + '.1',
      sopUid: uid + '.1.1', frame: 1, frameOfReferenceUid: uid + '.2', sourceDigest: 'a'.repeat(64), points: [[1, 1, 0], [4, 5, 0]],
      baseline: { values: [5] }, label, hidden: false });
    // A saved view (no 3D mark): its head row carries the immutable layout snapshot, each revision its own title.
    const jobItem = async (uid, title = 'SYN saved view') => {
      const id = randomUUID(), snapshot = { version: 1, studies: [uid], rows: 1, cols: 1, active: 0,
        cells: [{ study: uid, series: uid + '.1', sop: uid + '.1.1', frame: 1, sourceDigest: 'a'.repeat(64) }] };
      await witness.viewerJob.create({ data: { id, studyUid: uid, authorSub: members.doctor.sub, authorActor: members.doctor.email,
        studies: [uid], fingerprint: 'wg-' + id, snapshot, title, description: '', revision: 1, updatedAt: new Date(),
        revisions: { create: { revision: 1, title, description: '', hidden: false, reason: '', actor: members.doctor.email } } } });
      return { id, snapshot };
    };
    const reviseJob = async (job, title) => {
      const head = await witness.viewerJob.findUnique({ where: { id: job.id } });
      await witness.viewerJob.update({ where: { id: job.id }, data: { revision: head.revision + 1, title, updatedAt: new Date(),
        revisions: { create: { revision: head.revision + 1, title, description: '', hidden: false, reason: '', actor: members.doctor.email } } } });
      return head.revision + 1;
    };
    const reviseItem = async (item, title) => {
      const snapshot = { ...item.snapshot, title };
      const [{ bytes }] = await witness.$queryRaw`SELECT octet_length(convert_to(${JSON.stringify(snapshot)}::jsonb::text, 'UTF8')) AS bytes`;
      const head = await witness.viewerItem.findUnique({ where: { id: item.id } });
      await witness.viewerItem.update({ where: { id: item.id }, data: { revision: head.revision + 1, snapshot, updatedAt: new Date(),
        revisions: { create: { revision: head.revision + 1, snapshot, action: 'edit', reason: '', actor: members.doctor.email, payloadBytes: bytes } } } });
      return head.revision + 1;
    };
    // A saved-view reference exists in the version 2 record only.
    const findingItem = (sources, text = 'SYN finding') => sources.some(source => source.jobId)
      ? { schemaVersion: 2, title: 'SYN finding', text, characteristics: '', sources, primary: 0 }
      : { schemaVersion: 1, title: 'SYN finding', text, sources };
    const createFinding = (uid, sources, requestId = randomUUID(), send = call) =>
      send('doctor', 'POST', `/studies/${uid}/findings`, { requestId, item: findingItem(sources) });
    const reviseFinding = (uid, id, expectedRevision, action, sources, text, requestId = randomUUID(), send = call) =>
      send('doctor', 'POST', `/studies/${uid}/findings/${id}/revisions`, { requestId, expectedRevision, action, item: findingItem(sources, text) });
    const consult = {
      create: (uid, requestId = randomUUID()) => call('other', 'POST', `/studies/${uid}/consultations`,
        { requestId, expectedOwner: owner('other'), recipientSub: members.doctor.sub, reason: 'SYN consultation' }),
      change: (id, who, revision, action, note, requestId = randomUUID()) => call(who, 'POST', `/consultations/${id}`,
        { requestId, expectedOwner: owner(who), revision, action, note }),
    };
    const accepted = async uid => {
      const created = await consult.create(uid); ok(created, 201, 'consultation create');
      const id = created.body.item.id;
      ok(await consult.change(id, 'doctor', 1, 'accept', ''), 201, 'consultation accept');
      return id;
    };
    const imageRequest = {
      create: (uid, requestId = randomUUID()) => call('clinician', 'POST', `/studies/${uid}/image-requests`, { requestId,
        expectedOwner: owner('clinician'), kind: 'external-image', counterparty: 'SYN site', counterpartyInstitutionId: null, reason: 'SYN request' }),
      change: (id, revision, action, note, requestId = randomUUID()) => call('doctor', 'POST', `/image-requests/${id}`,
        { requestId, expectedOwner: owner('doctor'), revision, action, note }),
    };
    const note = uid => () => call('doctor', 'POST', `/studies/${uid}/tech-note`, { baseVersion: 0, text: 'SYN note', reason: '', attemptId: randomUUID() });
    const ask = (uid, requestId = randomUUID()) => call('clinician', 'POST', `/studies/${uid}/questions`,
      { requestId, expectedOwner: owner('clinician'), body: 'SYN question' });
    const reply = (qid, revision, requestId = randomUUID()) => call('doctor', 'POST', `/questions/${qid}/entries`,
      { requestId, expectedOwner: owner('doctor'), revision, body: 'SYN answer' });
    const srPrepared = async uid => {
      const snapshot = { kind: 'length', studyUid: uid, seriesUid: uid + '.1', sopUid: uid + '.1.1', frame: 1,
        frameOfReferenceUid: uid + '.2', sourceDigest: 'a'.repeat(64), points: [[1, 1, 0], [4, 5, 0]], viewPlaneNormal: [0, 0, 1],
        viewUp: [0, 1, 0], baseline: { values: [5] }, label: 'SYN length' };
      const item = await witness.viewerItem.create({ data: { id: randomUUID(), studyUid: uid, authorSub: members.doctor.sub,
        authorActor: members.doctor.email, revision: 1, snapshot, updatedAt: new Date() } });
      const out = await call('doctor', 'POST', `/studies/${uid}/manual-sr`, { requestId: randomUUID(), items: [{ id: item.id, revision: 1 }] });
      ok(out, 200, 'manual SR prepare'); return out.body.id;
    };
    const srStore = (uid, id) => () => call('doctor', 'POST', `/studies/${uid}/manual-sr/${id}/store`, {});
    const srIntent = async id => {
      const row = await witness.manualSr.findUnique({ where: { id } });
      const versions = await witness.$queryRaw`SELECT count(*)::int AS n FROM emr_signing.signed_version WHERE record_id=${id}`;
      return { attempted: !!row.attemptedAt, stored: !!row.storedAt, signed: versions[0].n };
    };
    const insertion = async (target, source) => {
      const d = await draft(target), head = await witness.report.findUnique({ where: { uid: target } });
      const src = await witness.report.findUnique({ where: { uid: source } });
      const version = await witness.reportVersion.findUnique({ where: { uid_version: { uid: source, version: src.version } } });
      const seed = d.snapshot ?? { findings: head?.findings ?? '', conclusion: head?.conclusion ?? '',
        recommendation: head?.recommendation ?? '', baseVersion: head?.version ?? 0 };
      const text = (seed.findings && !seed.findings.endsWith('\n') ? '\n' : '') + version.findings;
      return { expectedOwner: draftOwner('doctor'), expectedRevision: d.revision, ...seed,
        findings: seed.findings + text, citationIds: [], structureIds: [], relatedInsert: {
          intent: 'apply', insertRequestId: randomUUID(), targetUid: target, targetBaseVersion: seed.baseVersion,
          source: { uid: source, version: src.version, action: version.action,
            parts: [{ field: 'findings', start: 0, end: version.findings.length }] },
          seedKind: d.present ? 'private-draft' : head ? 'report-head' : 'empty', section: 'findings',
          position: 'end', offset: seed.findings.length, text, selectionSeq: 1, contentRevision: 1, sourceGeneration: 1 } };
    };

    // --- independent witnesses (direct rows, not the product's queries)
    const body = text => { const value = JSON.parse(text); return 'plan' in value ? value.plan : value; };
    const lastVersion = async (record, id) => {
      const [row] = await witness.$queryRaw`SELECT version_id, sequence, body FROM emr_clinical.online_version
        WHERE record_type=${record} AND record_id=${id} ORDER BY sequence DESC LIMIT 1`;
      return row ? { versionId: row.version_id, sequence: row.sequence, sha256: body(row.body).version.sha256 } : null;
    };
    const versionRow = async versionId => {
      const [row] = await witness.$queryRaw`SELECT record_id, sequence, body FROM emr_clinical.online_version WHERE version_id=${versionId}`;
      return row && { recordId: row.record_id, sequence: row.sequence, version: body(row.body).version };
    };
    const references = versionId => witness.$queryRaw`SELECT source_kind AS kind, source_record_id AS "recordId",
      source_version_id AS "versionId", source_sha256 AS sha256 FROM emr_clinical.online_reference WHERE version_id=${versionId}
      ORDER BY source_record_id, source_version_id`;
    const commandOf = async (record, requestId) => (await witness.$queryRaw`SELECT operation_id::text AS operation, body
      FROM emr_clinical.online_command WHERE record_type=${record} AND request_id=${requestId}`)[0] ?? null;
    const outcomeOf = async (record, requestId) => witness.$queryRaw`SELECT o.outcome, o.xmin::text AS xid
      FROM emr_clinical.online_command c JOIN emr_access.attempt_outcome o ON o.operation_id=c.operation_id
      WHERE c.record_type=${record} AND c.request_id=${requestId}`;
    const findingCounts = async id => (await witness.$queryRaw`SELECT
        (SELECT revision FROM "Finding" WHERE id=${id}::uuid) AS revision,
        (SELECT count(*)::int FROM "FindingRevision" WHERE "findingId"=${id}::uuid) AS revisions,
        (SELECT count(*)::int FROM "AuditLog" WHERE action LIKE 'finding.%' AND detail::jsonb->>'findingId'=${id}) AS audits,
        (SELECT count(*)::int FROM emr_clinical.online_version WHERE record_type='finding' AND record_id=${id}) AS versions,
        (SELECT count(*)::int FROM emr_clinical.online_reference r JOIN emr_clinical.online_version v USING (version_id)
          WHERE v.record_type='finding' AND v.record_id=${id}) AS refs`)[0];
    const signedPayload = async (recordId, versionId) => {
      const [row] = await witness.$queryRaw`SELECT outcome FROM emr_signing.signed_version WHERE record_id=${recordId} AND version_id=${versionId}`;
      return row && JSON.parse(Buffer.from(row.outcome.envelope.payload, 'base64url').toString('utf8'));
    };

    // --- lock observation
    const fixed = id => JSON.stringify(['emr-fixed-record', id]);
    const unitKey = (record, id) => JSON.stringify(['emr-d-unit', record, id]);
    const identityOf = who => clinical.keys.get(members[who].sub).doctor.identity.id;
    const c2 = who => JSON.stringify(['c2-key', institution, identityOf(who)]);
    // Each holder is a separate real connection. No product pause or mocked lock. A holder that does not end cleanly fails.
    const hold = async acquire => {
      let entered, release, ended;
      const ready = new Promise(resolve => { entered = resolve; });
      const stop = new Promise(resolve => { release = resolve; });
      const pending = witness.$transaction(async tx => {
        await acquire(tx);
        const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        entered(pid); await stop;
      }, { timeout: 20000, maxWait: 5000 });
      pending.catch(() => {});
      const pid = await Promise.race([ready, pending.then(() => { throw new Error('holder ended before ready'); })]);
      return { pid, end() { release(); return ended ??= pending.then(() => undefined); } };
    };
    // Every cleanup step runs. A failed step fails the case, and never replaces the case's own failure: both are kept.
    const ensure = async (body, ...cleanups) => {
      const failures = [];
      let value;
      try { value = await body(); } catch (error) { failures.push(error); }
      for (const cleanup of cleanups) {
        try { await cleanup(); } catch (error) { if (!failures.includes(error)) failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, failures.map(String).join(' | then | '));
      return value;
    };
    const advisoryHold = key => hold(tx => tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))::text`);
    const waits = async blocker => witness.$queryRaw`SELECT pid, backend_xid::text AS xid, wait_event_type, wait_event,
      left(query, 200) AS query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE ${blocker} = ANY(pg_blocking_pids(pid))`;
    const waitFor = async (blocker, label) => {
      for (let i = 0; i < 300; i++) {
        const rows = await waits(blocker);
        if (rows.length) { log(label, { blocker, rows }); return rows; }
        await sleep(10);
      }
      log(label + '-missing', { blocker, rows: await waits(blocker) });
      throw new Error(label + ': waiter was not observed');
    };
    const keys = async (pid, named) => {
      const out = {};
      for (const [name, key] of Object.entries(named)) out[name] = await witness.$queryRaw`SELECT l.granted, l.classid::text, l.objid::text,
        hashtextextended(${key},0)::text AS hash FROM pg_locks l WHERE l.pid=${pid} AND l.locktype='advisory' AND l.objsubid=1
        AND l.classid::bigint=((hashtextextended(${key},0) >> 32) & 4294967295)
        AND l.objid::bigint=(hashtextextended(${key},0) & 4294967295)`;
      log('advisory-map', { pid, keys: named, rows: out }); return out;
    };
    const granted = rows => rows.some(r => r.granted), waiting = rows => rows.some(r => !r.granted);
    const lockState = async (pid, label) => log(label, { pid, locks: await witness.$queryRaw`SELECT locktype, relation::regclass::text AS relation,
      classid::text, objid::text, mode, granted FROM pg_locks WHERE pid=${pid} ORDER BY granted DESC, locktype` });
    const rollback = new Error('probe completed; release by rollback');
    const probe = async (label, statement) => {
      let code = 'acquired';
      try { await witness.$transaction(async tx => { await statement(tx); throw rollback; }); }
      catch (error) { if (error !== rollback) code = error.meta?.code ?? error.code ?? String(error); }
      log(label, { code }); return code;
    };
    const rowProbe = uid => probe('row-probe ' + uid, tx => tx.$queryRaw`SELECT uid FROM "StudyState" WHERE uid=${uid} FOR UPDATE NOWAIT`);
    const keyProbe = async key => {
      let free = null;
      try { await witness.$transaction(async tx => {
        free = (await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtextextended(${key},0)) AS free`)[0].free;
        throw rollback;
      }); } catch (error) { if (error !== rollback) throw error; }
      log('key-probe', { key, free }); return free;
    };
    const deadlocks = async () => (await witness.$queryRaw`SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname=current_database()`)[0].n;
    const settledDeadlocks = async () => { await sleep(1200); return deadlocks(); };

    // The three source branches a finding copies, by the reference kind each is recorded as. A key image and a
    // measurement are a ViewerItem with its ViewerRevision; a saved view is the ViewerJob head snapshot combined with
    // one ViewerJobRevision, so its stored version can change in either row. Each corruption removes or changes the
    // stored version a kept copy was taken from, says how that is seen directly, and how it is put back.
    const itemCorruptions = async source => {
      const [saved] = await witness.$queryRaw`SELECT "itemId"::text AS "itemId", revision, snapshot::text AS snapshot, action, reason, actor, "payloadBytes", at
        FROM "ViewerRevision" WHERE "itemId"=${source.id}::uuid AND revision=1`;
      const first = async () => (await witness.$queryRaw`SELECT snapshot->>'title' AS title FROM "ViewerRevision"
        WHERE "itemId"=${source.id}::uuid AND revision=1`)[0] ?? null;
      return {
        missing: { code: 'FindingFixedVersionMissing', damaged: async () => (await first()) === null,
          damage: () => witness.$executeRaw`DELETE FROM "ViewerRevision" WHERE "itemId"=${source.id}::uuid AND revision=1`,
          repair: () => witness.$executeRaw`INSERT INTO "ViewerRevision"("itemId", revision, snapshot, action, reason, actor, "payloadBytes", at)
            VALUES (${saved.itemId}::uuid, 1, ${saved.snapshot}::jsonb, ${saved.action}, ${saved.reason}, ${saved.actor}, ${saved.payloadBytes}, ${saved.at})` },
        // The changed row stays a valid row: its byte count is that of its new snapshot (ViewerRevision_payload_check).
        changed: { code: 'FindingFixedVersionChanged', damaged: async () => (await first())?.title === 'SYN rewritten',
          damage: () => witness.$executeRaw`UPDATE "ViewerRevision" SET snapshot=jsonb_set(snapshot, '{title}', '"SYN rewritten"'),
            "payloadBytes"=octet_length(convert_to(jsonb_set(snapshot, '{title}', '"SYN rewritten"')::text, 'UTF8'))
            WHERE "itemId"=${source.id}::uuid AND revision=1`,
          repair: () => witness.$executeRaw`UPDATE "ViewerRevision" SET snapshot=${saved.snapshot}::jsonb, "payloadBytes"=${saved.payloadBytes}
            WHERE "itemId"=${source.id}::uuid AND revision=1` },
      };
    };
    const jobCorruptions = async source => {
      const [saved] = await witness.$queryRaw`SELECT "jobId"::text AS "jobId", revision, title, description, hidden, reason, actor, at
        FROM "ViewerJobRevision" WHERE "jobId"=${source.id}::uuid AND revision=1`;
      const [head] = await witness.$queryRaw`SELECT snapshot::text AS snapshot FROM "ViewerJob" WHERE id=${source.id}::uuid`;
      const first = async () => (await witness.$queryRaw`SELECT title FROM "ViewerJobRevision" WHERE "jobId"=${source.id}::uuid AND revision=1`)[0] ?? null;
      const headTitle = async () => (await witness.$queryRaw`SELECT snapshot->>'title' AS title FROM "ViewerJob" WHERE id=${source.id}::uuid`)[0].title;
      return {
        missing: { code: 'FindingFixedVersionMissing', damaged: async () => (await first()) === null,
          damage: () => witness.$executeRaw`DELETE FROM "ViewerJobRevision" WHERE "jobId"=${source.id}::uuid AND revision=1`,
          repair: () => witness.$executeRaw`INSERT INTO "ViewerJobRevision"("jobId", revision, title, description, hidden, reason, actor, at)
            VALUES (${saved.jobId}::uuid, 1, ${saved.title}, ${saved.description}, ${saved.hidden}, ${saved.reason}, ${saved.actor}, ${saved.at})` },
        changed: { code: 'FindingFixedVersionChanged', damaged: async () => (await first())?.title === 'SYN rewritten',
          damage: () => witness.$executeRaw`UPDATE "ViewerJobRevision" SET title='SYN rewritten' WHERE "jobId"=${source.id}::uuid AND revision=1`,
          repair: () => witness.$executeRaw`UPDATE "ViewerJobRevision" SET title=${saved.title} WHERE "jobId"=${source.id}::uuid AND revision=1` },
        'head-changed': { code: 'FindingFixedVersionChanged', damaged: async () => (await headTitle()) === 'SYN rewritten',
          damage: () => witness.$executeRaw`UPDATE "ViewerJob" SET snapshot=jsonb_set(snapshot, '{title}', '"SYN rewritten"') WHERE id=${source.id}::uuid`,
          repair: () => witness.$executeRaw`UPDATE "ViewerJob" SET snapshot=${head.snapshot}::jsonb WHERE id=${source.id}::uuid` },
      };
    };
    const SOURCES = {
      'key-image': { make: uid => keyItem(uid), ref: (s, revision = 1) => ({ itemId: s.id, revision }),
        revise: s => reviseItem(s, 'SYN later source'), corruptions: ['missing', 'changed'], corrupt: itemCorruptions },
      measurement: { make: uid => measurementItem(uid), ref: (s, revision = 1) => ({ itemId: s.id, revision }),
        revise: s => reviseItem(s, 'SYN later source'), corruptions: ['missing', 'changed'], corrupt: itemCorruptions },
      'comparison-layout': { make: uid => jobItem(uid), ref: (s, revision = 1) => ({ jobId: s.id, revision }),
        revise: s => reviseJob(s, 'SYN later view'), corruptions: ['missing', 'changed', 'head-changed'], corrupt: jobCorruptions },
    };

    await t.test('TG1/TG3 each signed version names the head it extends; findings reference the exact source versions they copied', async () => {
      const uid = await fresh();
      // Each write's predecessor, read from the stored rows before the write (null before the opening one).
      const chain = async (record, id, write, status, label) => {
        const before = id ? await lastVersion(record, id) : null;
        const out = await write();
        ok(out, status, label);
        const written = await versionRow(out.body.emr.receipt.versionId);
        log('head-chain', { label, before, written: { recordId: written.recordId, sequence: written.sequence, previous: written.version.previousVersion } });
        assert.deepEqual(written.version.previousVersion, before && { recordId: written.recordId, versionId: before.versionId, sha256: before.sha256 }, label);
        assert.equal(written.sequence, (before?.sequence ?? 0) + 1, label);
        return { out, written };
      };
      const created = await chain('consultation', null, () => consult.create(uid), 201, 'consultation create');
      const cid = created.out.body.item.id;
      await chain('consultation', cid, () => consult.change(cid, 'doctor', 1, 'accept', ''), 201, 'consultation accept');
      await chain('consultation', cid, () => consult.change(cid, 'doctor', 2, 'complete', 'SYN reply'), 201, 'consultation complete');
      const request = await chain('image-request', null, () => imageRequest.create(uid), 201, 'image request create');
      const rid = request.out.body.applied.id;
      await chain('image-request', rid, () => imageRequest.change(rid, 1, 'accept', ''), 201, 'image request accept');
      await chain('image-request', rid, () => imageRequest.change(rid, 2, 'close', 'SYN close'), 201, 'image request close');
      const item = await keyItem(uid);
      const first = await chain('finding', null, () => createFinding(uid, [{ itemId: item.id, revision: 1 }]), 200, 'finding create');
      const fid = first.out.body.id, refs = [await references(first.written.version.versionId)];
      const rev2 = await reviseItem(item, 'SYN key image revised');
      log('source-heads', { item: item.id, head: (await witness.viewerItem.findUnique({ where: { id: item.id } })).revision,
        stored: (await witness.viewerRevision.findMany({ where: { itemId: item.id }, select: { revision: true } })).map(r => r.revision) });
      const kept = await chain('finding', fid, () => reviseFinding(uid, fid, 1, 'edit', [{ itemId: item.id, revision: 1 }], 'SYN kept copy'), 200, 'finding edit kept');
      refs.push(await references(kept.written.version.versionId));
      const renewed = await chain('finding', fid, () => reviseFinding(uid, fid, 2, 'edit', [{ itemId: item.id, revision: rev2 }], 'SYN new copy'), 200, 'finding edit new');
      refs.push(await references(renewed.written.version.versionId));
      await chain('finding', fid, () => reviseFinding(uid, fid, 3, 'hide', [{ itemId: item.id, revision: rev2 }], 'SYN new copy'), 200, 'finding hide');
      await chain('finding', fid, () => reviseFinding(uid, fid, 4, 'restore', [{ itemId: item.id, revision: rev2 }], 'SYN new copy'), 200, 'finding restore');
      log('finding-references', { refs });
      assert.deepEqual(refs.map(r => r.map(x => [x.kind, x.recordId, x.versionId])),
        [[['key-image', item.id, '1']], [['key-image', item.id, '1']], [['key-image', item.id, String(rev2)]]]);
      assert.equal(refs[1][0].sha256, refs[0][0].sha256, 'the kept copy references the first source version');
      assert.notEqual(refs[2][0].sha256, refs[0][0].sha256, 'the new copy references the new source version');
    });

    await t.test('TG3b (E4) every source kind, in both compositions: a reference names the copied version; a kept copy keeps it, a renewed one names the next', async t => {
      for (const [name, send] of Object.entries(compositions)) for (const [kind, spec] of Object.entries(SOURCES)) await t.test(`${name} ${kind}`, async () => {
        const uid = await fresh(), source = await spec.make(uid);
        const created = await createFinding(uid, [spec.ref(source)], randomUUID(), send); ok(created, 200, 'create');
        const fid = created.body.id, refs = [await references(created.body.emr.receipt.versionId)];
        const next = await spec.revise(source);
        const kept = await reviseFinding(uid, fid, 1, 'edit', [spec.ref(source)], 'SYN kept copy', randomUUID(), send); ok(kept, 200, 'edit kept');
        refs.push(await references(kept.body.emr.receipt.versionId));
        const renewed = await reviseFinding(uid, fid, 2, 'edit', [spec.ref(source, next)], 'SYN new copy', randomUUID(), send); ok(renewed, 200, 'edit new');
        refs.push(await references(renewed.body.emr.receipt.versionId));
        log('source-kind-references', { composition: name, kind, source: source.id, next, refs });
        assert.deepEqual(refs.map(r => r.map(x => [x.kind, x.recordId, x.versionId])),
          [[[kind, source.id, '1']], [[kind, source.id, '1']], [[kind, source.id, String(next)]]]);
        assert.equal(refs[1][0].sha256, refs[0][0].sha256, 'the kept copy references the first source version');
        assert.notEqual(refs[2][0].sha256, refs[0][0].sha256, 'the new copy references the new source version');
      });
    });

    await t.test('TG2 a native signature names the Report head before the commit; the first approval names none', async () => {
      const uid = await fresh();
      for (const action of ['approve', 'addendum', 'reset']) {
        const before = await witness.report.findUnique({ where: { uid } });
        const head = before && await witness.reportVersion.findUnique({ where: { uid_version: { uid, version: before.version } } });
        const out = await (await commit(uid, action))();
        ok(out, 201, action);
        const after = await witness.report.findUnique({ where: { uid } });
        const payload = await signedPayload(uid, String(after?.version ?? out.body.version));
        log('native-head', { action, before: before?.version ?? null, headAction: head?.action ?? null, after: after?.version ?? null,
          previous: payload?.previousVersion ?? null });
        assert.ok(payload, action + ' is signed');
        assert.equal(payload.previousVersion?.versionId ?? null, before ? String(before.version) : null, action);
        if (before) assert.equal(payload.previousVersion.recordId, uid);
      }
    });

    await t.test('TG2 an empty Reset with no Report before it changes state only: nothing is signed and no predecessor is invented', async () => {
      const uid = await fresh();
      const observe = async () => ({ report: await witness.report.findUnique({ where: { uid } }),
        versions: await witness.reportVersion.findMany({ where: { uid }, select: { version: true, action: true }, orderBy: { version: 'asc' } }),
        signed: (await witness.$queryRaw`SELECT count(*)::int AS n FROM emr_signing.signed_version WHERE record_id=${uid}`)[0].n,
        rs: (await witness.studyState.findUnique({ where: { uid } })).rs });
      const before = await observe();
      log('empty-reset-before', before);
      assert.deepEqual(before, { report: null, versions: [], signed: 0, rs: 'W' }, 'no Report, no version and no signature precede the Reset');
      const out = await (await commit(uid, 'reset'))();
      const after = await observe();
      log('empty-reset', { status: out.status, signature: out.body?.signature ?? null, after });
      ok(out, 201, 'reset');
      assert.equal(out.body.signature ?? null, null, 'the answer carries no signature');
      assert.equal(after.signed, 0, 'no signed version was written for the study');
      assert.equal(after.rs, 'W');
    });

    await t.test('TG4 a stored reference of a kind its surface does not attach is refused at append and writes nothing', async t => {
      // The store boundary: a command whose plan, digest, head and projection agree, so only the reference
      // kind differs from what the surface attaches. Commands come from real writes, ids are fresh.
      const store = new ClinicalStore(runtimeDb);
      const hex = value => createHash('sha256').update(value).digest('hex');
      const digest = v => hex(JSON.stringify([v.formatVersion, v.record, v.recordId, v.versionId, v.sequence, v.previousVersion, v.surface,
        v.entry, v.capacity, v.kind, v.act, v.author, v.actingInstitutionId, v.text, v.contentSha256, v.reason, v.reasonSource,
        v.attachments, v.navigation, v.state, v.readerId, v.recipientId, v.studyId, v.managingInstitutionId, v.patient, v.at]));
      const uid = await fresh(), item = await keyItem(uid), findingRequest = randomUUID(), questionRequest = randomUUID();
      ok(await createFinding(uid, [{ itemId: item.id, revision: 1 }], findingRequest), 200, 'finding');
      ok(await ask(uid, questionRequest), 201, 'question');
      const variant = async (record, requestId, attachments) => {
        const stored = JSON.parse((await commandOf(record, requestId)).body);
        // The fixture builder must reproduce the stored digest before it is trusted with a changed one.
        assert.equal(digest(stored.plan.version), stored.plan.version.sha256, 'digest builder matches the stored version');
        const plan = structuredClone(stored.plan), recordId = randomUUID(), versionId = randomUUID();
        Object.assign(plan.version, { recordId, versionId, attachments: attachments(plan.version.attachments) });
        plan.version.sha256 = digest(plan.version);
        plan.projection.head = { recordId, versionId, sha256: plan.version.sha256 };
        Object.assign(plan.receipt, { recordId, versionId, versionSha256: plan.version.sha256 });
        if (plan.signing) Object.assign(plan.signing, { recordId, versionId, versionSha256: plan.version.sha256, attachments: plan.version.attachments });
        const [{ signature }] = await witness.$queryRaw`SELECT v.signature FROM emr_clinical.online_version v JOIN emr_clinical.online_command c
          ON c.operation_id=v.operation_id WHERE c.record_type=${record} AND c.request_id=${requestId}`;
        return { command: { ...stored, plan, operationId: randomUUID(), attemptId: randomUUID() }, signature: signature && JSON.parse(signature), record };
      };
      const append = async ({ command, signature, record }) => {
        let error = null, rows = null;
        try { await store.transaction(async tx => {
          await tx.$executeRaw`INSERT INTO emr_clinical.online_command(record_type, actor_id, request_id, operation_id, body)
            VALUES (${record}, ${'wg-store-' + randomUUID()}, ${randomUUID()}, ${command.operationId}::uuid, ${JSON.stringify(command)})`;
          try { await store.append(tx, command, signature); } catch (e) { error = e; }
          rows = (await tx.$queryRaw`SELECT (SELECT count(*)::int FROM emr_clinical.online_version WHERE version_id=${command.plan.version.versionId}) AS versions,
            (SELECT count(*)::int FROM emr_clinical.online_reference WHERE version_id=${command.plan.version.versionId}) AS refs`)[0];
          throw rollback;
        }); } catch (e) { if (e !== rollback) throw e; }
        return { code: error?.code ?? null, rows };
      };
      const cases = {
        'finding report-version': ['finding', findingRequest, refs => refs.map(r => ({ ...r, kind: 'report-version' }))],
        'question measurement': ['question', questionRequest, () => [{ kind: 'measurement', recordId: item.id, versionId: '1', sha256: 'a'.repeat(64) }]],
      };
      for (const [name, [record, requestId, change]] of Object.entries(cases)) await t.test(name, async () => {
        const control = await append(await variant(record, requestId, refs => refs));
        log('store-control', { name, control });
        assert.deepEqual(control, { code: null, rows: { versions: 1, refs: record === 'finding' ? 1 : 0 } }, 'the same fixture appends with its own kinds');
        const changed = await variant(record, requestId, change);
        const refused = await append(changed);
        log('store-kind', { name, attachments: changed.command.plan.version.attachments, refused });
        assert.equal(refused.code, 'AttachmentKindUnsupported', JSON.stringify(refused));
        assert.deepEqual(refused.rows, { versions: 0, refs: 0 });
      });
    });

    await t.test('TG5 (E3) a kept source copy whose version is gone or changed is refused by the business write; a committed replay is kept', async t => {
      // Every source kind and corruption, through the fixture composition and the deployed one (F1: the business
      // write's held set must reach the finding reader there too).
      for (const [name, send] of Object.entries(compositions)) for (const [kind, spec] of Object.entries(SOURCES))
        for (const corruption of spec.corruptions) await t.test(`${name} ${kind} ${corruption}`, async () => {
          const uid = await fresh(), source = await spec.make(uid), createId = randomUUID();
          const createBody = { requestId: createId, item: findingItem([spec.ref(source)]) };
          const created = await send('doctor', 'POST', `/studies/${uid}/findings`, createBody); ok(created, 200, 'create');
          const fid = created.body.id;
          await spec.revise(source);
          const { code, damage, damaged, repair } = (await spec.corrupt(source))[corruption];
          const kept = [spec.ref(source)], id = randomUUID(), before = await findingCounts(fid);
          // The command and its admission are stored first; the business transaction waits at its unit key.
          const gate = await advisoryHold(unitKey('finding', fid));
          let pending, out;
          await ensure(async () => {
            pending = reviseFinding(uid, fid, 1, 'edit', kept, 'SYN kept', id, send);
            await waitFor(gate.pid, 'edit-at-unit');
            const stored = await commandOf('finding', id);
            log('command-before-damage', { composition: name, kind, corruption, id, operation: stored?.operation, outcome: await outcomeOf('finding', id) });
            assert.ok(stored, 'the command was prepared before the source changed');
            await damage();
            const seen = await damaged();
            log('damaged-source', { composition: name, kind, corruption, seen });
            assert.ok(seen, 'the stored source version is ' + corruption);
            await gate.end(); out = await pending;
          }, () => gate.end(), async () => { if (pending && out === undefined) out = await pending; });
          log('business-refusal', { composition: name, kind, corruption, out, outcome: await outcomeOf('finding', id) });
          assert.ok(out.status >= 400, JSON.stringify(out));
          assert.equal(out.body.code, code, JSON.stringify(out));
          assert.deepEqual(await findingCounts(fid), before, 'no finding revision, version, reference or audit');
          // The committed create, replayed under the same ID and body, still answers its stored result.
          const replayed = await send('doctor', 'POST', `/studies/${uid}/findings`, createBody);
          log('replay-after-damage', { composition: name, kind, corruption, status: replayed.status, replayed: replayed.body?.emr?.replayed });
          ok(replayed, 200, 'replay'); assert.equal(replayed.body.emr.replayed, true);
          assert.deepEqual(replayed.body.emr.signature, created.body.emr.signature);
          // A request prepared after the damage is not written either; where it stopped is recorded.
          const late = randomUUID(), lateOut = await reviseFinding(uid, fid, 1, 'edit', kept, 'SYN kept', late, send);
          log('refusal-after-damage', { composition: name, kind, corruption, lateOut, command: !!(await commandOf('finding', late)), outcome: await outcomeOf('finding', late) });
          assert.ok(lateOut.status >= 400, JSON.stringify(lateOut));
          assert.deepEqual(await findingCounts(fid), before);
          await repair();
          const again = await reviseFinding(uid, fid, 1, 'edit', kept, 'SYN kept', id, send);
          log('same-id-after-repair', { composition: name, kind, corruption, again, outcome: await outcomeOf('finding', id) });
          assert.ok(again.status >= 400, JSON.stringify(again));
          assert.deepEqual(await findingCounts(fid), before);
          ok(await reviseFinding(uid, fid, 1, 'edit', kept, 'SYN kept', randomUUID(), send), 200, 'new id after repair');
        });
    });

    await t.test('TG6 a finding takes its whole sorted fixed set, sources included, before StudyState and the signer key', async () => {
      const uid = await fresh(), a = await keyItem(uid, 'SYN A'), b = await keyItem(uid, 'SYN B'), id = randomUUID();
      const set = [...new Set([id, uid, a.id, b.id])].sort();
      const source = [a.id, b.id].sort()[1], at = set.indexOf(source);
      const holder = await advisoryHold(fixed(source));
      let pending, out;
      await ensure(async () => {
        pending = createFinding(uid, [{ itemId: a.id, revision: 1 }, { itemId: b.id, revision: 1 }], id);
        const [waiter] = await waitFor(holder.pid, 'finding-at-source');
        const held = await keys(waiter.pid, Object.fromEntries(set.map((key, i) => ['k' + i, fixed(key)])));
        await lockState(waiter.pid, 'finding-locks');
        set.forEach((key, i) => assert.ok(i < at ? granted(held['k' + i]) : i === at ? waiting(held['k' + i]) : !held['k' + i].length,
          'key ' + i + ' of the sorted set ' + JSON.stringify({ key, at })));
        assert.equal(await rowProbe(uid), 'acquired', 'StudyState is not held yet');
        assert.equal(await keyProbe(c2('doctor')), true, 'the signer key is free');
      }, () => holder.end(), async () => { if (pending) out = await pending; });
      ok(out, 200, 'create');
      assert.deepEqual((await references(out.body.emr.receipt.versionId)).map(r => r.recordId), [a.id, b.id].sort());
    });

    await t.test('TG6b (E4) every source kind, in both compositions, joins the sorted fixed set taken before StudyState and the signer key', async t => {
      for (const [name, send] of Object.entries(compositions)) for (const [kind, spec] of Object.entries(SOURCES)) await t.test(`${name} ${kind}`, async () => {
        const uid = await fresh(), source = await spec.make(uid), id = randomUUID();
        const set = [...new Set([id, uid, source.id])].sort(), at = set.indexOf(source.id);
        const holder = await advisoryHold(fixed(source.id));
        let pending, out;
        await ensure(async () => {
          pending = createFinding(uid, [spec.ref(source)], id, send);
          const [waiter] = await waitFor(holder.pid, 'finding-at-source');
          const held = await keys(waiter.pid, Object.fromEntries(set.map((key, i) => ['k' + i, fixed(key)])));
          log('source-kind-set', { composition: name, kind, set, at });
          set.forEach((key, i) => assert.ok(i < at ? granted(held['k' + i]) : i === at ? waiting(held['k' + i]) : !held['k' + i].length,
            'key ' + i + ' of the sorted set ' + JSON.stringify({ key, at })));
          assert.equal(await rowProbe(uid), 'acquired', 'StudyState is not held yet');
          assert.equal(await keyProbe(c2('doctor')), true, 'the signer key is free');
        }, () => holder.end(), async () => { if (pending) out = await pending; });
        ok(out, 200, 'create');
        assert.deepEqual((await references(out.body.emr.receipt.versionId)).map(r => [r.kind, r.recordId]), [[kind, source.id]]);
      });
    });

    await t.test('F1 (E1) a Study set grown after the command was prepared is refused before StudyState is locked, in both compositions', async t => {
      for (const [name, send] of Object.entries(compositions)) await t.test(name, async () => {
        const uid = await fresh(), other = await fresh(), item = await keyItem(uid), id = randomUUID();
        const gate = await advisoryHold(unitKey('finding', id));
        let pending, row, out;
        const waiters = [];
        await ensure(async () => {
          pending = createFinding(uid, [{ itemId: item.id, revision: 1 }], id, send);
          await waitFor(gate.pid, 'create-at-unit');
          const stored = await commandOf('finding', id);
          const records = stored && JSON.parse(stored.body).records;
          log('prepared-set', { composition: name, id, records });
          assert.ok(records?.includes(uid) && !records.includes(other), 'the command was prepared for the anchor study only');
          // The source now lies on another study of the same institution and patient: preparing the write again
          // plans that study as well, which the prepared set does not hold. Its StudyState row is held elsewhere.
          await witness.$executeRaw`UPDATE "ViewerItem" SET "studyUid"=${other} WHERE id=${item.id}::uuid`;
          row = await hold(tx => tx.$queryRaw`SELECT uid FROM "StudyState" WHERE uid=${other} FOR UPDATE`);
          await gate.end();
          // Watch the held row until the write answers; a write that queues behind it is recorded and released.
          let done = false;
          pending.then(() => { done = true; }, () => { done = true; });
          while (!done) {
            const rows = await waits(row.pid);
            if (rows.length) { waiters.push(...rows); break; }
            await sleep(10);
          }
          log('grown-set-waiters', { composition: name, waiters });
        }, () => gate.end(), () => row?.end(), async () => { if (pending) out = await pending; });
        log('grown-set-result', { composition: name, out, outcome: await outcomeOf('finding', id), counts: await findingCounts(id) });
        assert.deepEqual(waiters, [], 'the write never waited on the added study row');
        assert.ok(out.status >= 400, JSON.stringify(out));
        const counts = await findingCounts(id);
        assert.deepEqual([counts.revision, counts.revisions, counts.versions, counts.refs, counts.audits], [null, 0, 0, 0, 0], 'nothing was written');
      });
    });

    await t.test('TG7 a consultation reply and a native commit by one signer on one study, both orders, finish without deadlock', async t => {
      for (const order of ['native-first', 'consultation-first']) await t.test(order, async () => {
        const uid = await signed(), cid = await accepted(uid), native = await commit(uid, 'addendum');
        const d0 = await deadlocks();
        let holder, nativeCall, replyCall, results;
        await ensure(async () => {
          if (order === 'native-first') {
            holder = await hold(tx => tx.$queryRaw`SELECT uid FROM "Report" WHERE uid=${uid} FOR UPDATE`);
            nativeCall = native();
            const [writer] = await waitFor(holder.pid, 'native-at-report');
            await keys(writer.pid, { study: fixed(uid) });
            assert.equal(await rowProbe(uid), '55P03', 'the native writer holds StudyState');
            replyCall = consult.change(cid, 'doctor', 2, 'complete', 'SYN reply');
            const [waiter] = await waitFor(writer.pid, 'reply-behind-native');
            const held = await keys(waiter.pid, { study: fixed(uid), own: fixed(cid), signer: c2('doctor') });
            await lockState(waiter.pid, 'reply-locks');
            assert.ok(waiting(held.study), 'the reply waits at the study key the native writer holds');
            assert.equal(granted(held.signer), false, 'the reply does not hold the signer key while it waits');
          } else {
            holder = await advisoryHold(c2('doctor'));
            replyCall = consult.change(cid, 'doctor', 2, 'complete', 'SYN reply');
            const [waiter] = await waitFor(holder.pid, 'reply-at-signer');
            const held = await keys(waiter.pid, { study: fixed(uid), own: fixed(cid), signer: c2('doctor') });
            assert.ok(granted(held.study) && granted(held.own), 'the reply holds its whole set'); assert.ok(waiting(held.signer));
            assert.equal(await rowProbe(uid), 'acquired', 'the reply has not locked StudyState');
            nativeCall = native();
            const [writer] = await waitFor(waiter.pid, 'native-behind-reply');
            const nativeHeld = await keys(writer.pid, { study: fixed(uid) });
            await lockState(writer.pid, 'native-locks');
            assert.ok(waiting(nativeHeld.study), 'the native writer waits at the same study key');
          }
        }, () => holder?.end(), async () => {
          results = await Promise.all([nativeCall, replyCall].map(p => p ?? Promise.resolve(null)));
          log('native-reply-results', { order, results, deadlocks: [d0, await settledDeadlocks()] });
        });
        ok(results[0], 201, 'native'); ok(results[1], 201, 'reply');
        assert.equal(await deadlocks(), d0, 'no deadlock was detected');
        assert.equal((await witness.studyConsultation.findUnique({ where: { id: cid } })).state, 'Completed');
      });
    });

    // Writers of one study by the same signer. `park` stops a writer at its own row write, after its record,
    // StudyState and signer locks; `unit` gates a generic writer after its command is prepared.
    const writers = {
      'consultation-complete': async uid => { const cid = await accepted(uid);
        return { run: () => consult.change(cid, 'doctor', 2, 'complete', 'SYN reply'), status: 201, unit: ['consultation', cid],
          park: () => hold(tx => tx.$executeRawUnsafe('LOCK TABLE "StudyConsultation" IN SHARE MODE')) }; },
      'finding-edit': async uid => { const item = await keyItem(uid), out = await createFinding(uid, [{ itemId: item.id, revision: 1 }]);
        ok(out, 200, 'finding'); const fid = out.body.id;
        return { run: () => reviseFinding(uid, fid, 1, 'edit', [{ itemId: item.id, revision: 1 }], 'SYN edit'), status: 200, unit: ['finding', fid],
          park: () => hold(tx => tx.$executeRawUnsafe('LOCK TABLE "Finding" IN SHARE MODE')) }; },
      'finding-create': async uid => { const item = await keyItem(uid), id = randomUUID();
        return { run: () => createFinding(uid, [{ itemId: item.id, revision: 1 }], id), status: 200, unit: ['finding', id],
          park: () => hold(tx => tx.$executeRawUnsafe('LOCK TABLE "Finding" IN SHARE MODE')) }; },
      'tech-note': async uid => ({ run: note(uid), status: 201, unit: ['tech-note', uid],
        park: () => hold(tx => tx.$executeRawUnsafe('LOCK TABLE "TechNoteRevision" IN SHARE MODE')) }),
      'question-answer': async uid => { const q = randomUUID(); ok(await ask(uid, q), 201, 'question');
        return { run: () => reply(q, 1), status: 201, unit: ['question', q],
          park: () => hold(tx => tx.$executeRawUnsafe('LOCK TABLE "StudyQuestion" IN SHARE MODE')) }; },
      'manual-sr': async uid => { const id = await srPrepared(uid);
        return { run: srStore(uid, id), status: 503, after: async () => assert.deepEqual(await srIntent(id), { attempted: true, stored: false, signed: 1 }),
          park: () => hold(tx => tx.$executeRawUnsafe('LOCK TABLE "ManualSr" IN SHARE MODE')) }; },
      native: async uid => ({ run: await commit(uid, 'addendum'), status: 201,
        park: () => hold(tx => tx.$queryRaw`SELECT uid FROM "Report" WHERE uid=${uid} FOR UPDATE`) }),
      'related-target': async uid => { const source = await signed(), payload = await insertion(uid, source);
        return { run: () => call('doctor', 'PUT', `/studies/${uid}/report`, payload), status: 200,
          park: () => hold(tx => tx.$executeRawUnsafe('LOCK TABLE "ReportDraft" IN SHARE MODE')) }; },
    };
    const pairs = [['finding-edit', 'consultation-complete'], ['finding-create', 'tech-note'], ['consultation-complete', 'tech-note'],
      ['manual-sr', 'consultation-complete'], ['finding-edit', 'question-answer'], ['native', 'finding-edit'],
      ['consultation-complete', 'related-target']];
    await t.test('TG8 (E4) signed writers of one study by one signer queue at the study key in both orders without deadlock', async t => {
      for (const [x, y] of pairs) for (const [first, second] of [[x, y], [y, x]]) await t.test(first + ' then ' + second, async () => {
        const uid = await signed(), one = await writers[first](uid), two = await writers[second](uid), d0 = await deadlocks();
        let gate, park, firstCall, secondCall, results;
        await ensure(async () => {
          if (two.unit) {
            gate = await advisoryHold(unitKey(...two.unit));
            secondCall = two.run();
            await waitFor(gate.pid, 'second-at-unit');
          }
          park = await one.park();
          firstCall = one.run();
          const [writer] = await waitFor(park.pid, 'first-parked');
          const held = await keys(writer.pid, { study: fixed(uid), signer: c2('doctor') });
          await lockState(writer.pid, 'first-locks');
          assert.equal(await rowProbe(uid), '55P03', 'the first writer holds StudyState');
          if (gate) await gate.end(); else secondCall = two.run();
          const [waiter] = await waitFor(writer.pid, 'second-behind-first');
          const second_ = await keys(waiter.pid, { study: fixed(uid), signer: c2('doctor') });
          await lockState(waiter.pid, 'second-locks');
          log('cross-order', { first, second, firstHeld: held, secondHeld: second_, waiterQuery: waiter.query });
          assert.ok(waiting(second_.study), 'the second writer waits at the study key');
          assert.equal(granted(second_.signer), false, 'the second writer does not hold the signer key');
        }, () => gate?.end(), () => park?.end(), async () => {
          results = await Promise.all([firstCall, secondCall].map(p => p ?? Promise.resolve(null)));
          log('cross-results', { first, second, results, deadlocks: [d0, await settledDeadlocks()] });
        });
        ok(results[0], one.status, first); ok(results[1], two.status, second);
        if (one.after) await one.after(); if (two.after) await two.after();
        assert.equal(await deadlocks(), d0, 'no deadlock was detected');
      });
    });

    await t.test('TG10 a manual SR store takes its SR and study fixed records before StudyState, the SR row and the signer key', async () => {
      const uid = await signed(), id = await srPrepared(uid), holder = await advisoryHold(fixed(id));
      let pending, out;
      await ensure(async () => {
        pending = srStore(uid, id)();
        const [waiter] = await waitFor(holder.pid, 'sr-at-fixed');
        const held = await keys(waiter.pid, { sr: fixed(id), study: fixed(uid), signer: c2('doctor') });
        await lockState(waiter.pid, 'sr-locks');
        assert.ok(waiting(held.sr), 'the store waits at the SR key');
        assert.equal(await rowProbe(uid), 'acquired', 'StudyState is not held yet');
        assert.equal(await probe('sr-row', tx => tx.$queryRaw`SELECT id FROM "ManualSr" WHERE id=${id}::uuid FOR UPDATE NOWAIT`), 'acquired');
        assert.equal(await keyProbe(c2('doctor')), true, 'the signer key is free');
      }, () => holder.end(), async () => { if (pending) out = await pending; });
      log('sr-result', { out, intent: await srIntent(id) });
      ok(out, 503, 'the synthetic upload is refused after the committed intent');
      assert.deepEqual(await srIntent(id), { attempted: true, stored: false, signed: 1 });
    });

    // The rows one write produced, by the transaction that wrote them. Admission, answer and failure rows are not read.
    const observeWrite = async (record, requestId, business) => witness.$queryRaw`
      ${business}
      UNION ALL SELECT 'version', v.xmin::text FROM emr_clinical.online_version v JOIN emr_clinical.online_command c
        ON c.operation_id=v.operation_id WHERE c.record_type=${record} AND c.request_id=${requestId}
      UNION ALL SELECT 'reference', r.xmin::text FROM emr_clinical.online_reference r JOIN emr_clinical.online_version v USING (version_id)
        JOIN emr_clinical.online_command c ON c.operation_id=v.operation_id WHERE c.record_type=${record} AND c.request_id=${requestId}
      UNION ALL SELECT 'access', e.xmin::text FROM emr_access.access_entry e JOIN emr_clinical.online_command c
        ON c.operation_id=e.operation_id WHERE c.record_type=${record} AND c.request_id=${requestId}
      UNION ALL SELECT 'receipt', r.xmin::text FROM emr_access.entry_receipt r JOIN emr_clinical.online_command c
        ON c.operation_id=r.operation_id WHERE c.record_type=${record} AND c.request_id=${requestId}
      UNION ALL SELECT 'outcome', o.xmin::text FROM emr_access.attempt_outcome o JOIN emr_clinical.online_command c
        ON c.operation_id=o.operation_id WHERE c.record_type=${record} AND c.request_id=${requestId} AND o.outcome='committed'`;
    const oneTransaction = (label, rows, parts) => {
      assert.deepEqual([...new Set(rows.map(r => r.part))].sort(), parts, label + ': every part of the write is present');
      assert.equal(new Set(rows.map(r => r.xid)).size, 1, label + ': one transaction wrote them ' + JSON.stringify(rows));
    };
    await t.test('TG11 (E6) a finding edit and a consultation reply write every part in one transaction; split counterexamples fail the same check', async () => {
      const uid = await fresh(), item = await keyItem(uid), created = await createFinding(uid, [{ itemId: item.id, revision: 1 }]);
      ok(created, 200, 'finding'); const fid = created.body.id, edit = randomUUID();
      ok(await reviseFinding(uid, fid, 1, 'edit', [{ itemId: item.id, revision: 1 }], 'SYN edit', edit), 200, 'edit');
      const findingRows = () => observeWrite('finding', edit, Prisma.sql`SELECT 'finding' AS part, xmin::text AS xid FROM "Finding" WHERE id=${fid}::uuid
        UNION ALL SELECT 'revision', xmin::text FROM "FindingRevision" WHERE "requestId"=${edit}::uuid
        UNION ALL SELECT 'audit', xmin::text FROM "AuditLog" WHERE action='finding.edit' AND detail::jsonb->>'findingId'=${fid} AND (detail::jsonb->>'revision')::int=2`);
      const FINDING = ['access', 'audit', 'finding', 'outcome', 'receipt', 'reference', 'revision', 'version'];
      oneTransaction('finding edit', await findingRows(), FINDING);
      const cid = await accepted(uid), done = randomUUID();
      ok(await consult.change(cid, 'doctor', 2, 'complete', 'SYN reply', done), 201, 'complete');
      const consultationRows = () => observeWrite('consultation', done, Prisma.sql`SELECT 'consultation' AS part, xmin::text AS xid FROM "StudyConsultation" WHERE id=${cid}::uuid
        UNION ALL SELECT 'audit', xmin::text FROM "AuditLog" WHERE action='study.consultation' AND detail::jsonb->>'id'=${cid} AND (detail::jsonb->>'revision')::int=3`);
      // A consultation attaches nothing: no reference row is expected or created.
      const CONSULTATION = ['access', 'audit', 'consultation', 'outcome', 'receipt', 'version'];
      oneTransaction('consultation complete', await consultationRows(), CONSULTATION);
      await witness.auditLog.create({ data: { actor: members.doctor.email, action: 'finding.edit', target: uid,
        detail: JSON.stringify({ findingId: fid, revision: 2, counterexample: 'separate audit transaction' }) } });
      const auditApart = await findingRows();
      log('counterexample-audit', { rows: auditApart });
      assert.throws(() => oneTransaction('audit apart', auditApart, FINDING), assert.AssertionError);
      await witness.$executeRaw`UPDATE "StudyConsultation" SET reply=reply WHERE id=${cid}::uuid`;
      const businessApart = await consultationRows();
      log('counterexample-business', { rows: businessApart });
      assert.throws(() => oneTransaction('business apart', businessApart, CONSULTATION), assert.AssertionError);
    });

    await t.test('TG12 a committed finding whose answer the relay held and dropped replays by the same ID; a refused COMMIT never answers success', async t => {
      await t.test('answer dropped after commit', async () => {
        const uid = await fresh(), item = await keyItem(uid);
        let heldBody, drop;
        const captured = new Promise(resolve => { heldBody = resolve; });
        const dropped = new Promise(resolve => { drop = resolve; });
        relay = http.createServer(async (req, res) => {
          let text = ''; for await (const chunk of req) text += chunk;
          const answer = await fetch(origin + req.url, { method: req.method, headers: { authorization: req.headers.authorization,
            'content-type': 'application/json', 'x-real-ip': '192.0.2.23' }, body: text });
          heldBody({ status: answer.status, body: JSON.parse(await answer.text()) });
          await dropped;
          req.socket.destroy();
        });
        await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
        const id = randomUUID(), payload = { requestId: id, item: findingItem([{ itemId: item.id, revision: 1 }]) };
        const client = fetch('http://127.0.0.1:' + relay.address().port + `/api/studies/${uid}/findings`, { method: 'POST',
          headers: headers('doctor'), body: JSON.stringify(payload) })
          .then(response => ({ delivered: true, status: response.status }), error => ({ delivered: false, error: String(error.cause?.code ?? error.message) }));
        const held = await captured;
        const committed = { outcome: await outcomeOf('finding', id), counts: await findingCounts(id) };
        log('committed-before-drop', { held: { status: held.status, id: held.body.id }, committed });
        ok(held, 200, 'the relay holds the real answer');
        assert.deepEqual(committed.outcome.map(o => o.outcome), ['committed']);
        assert.deepEqual([committed.counts.revisions, committed.counts.versions, committed.counts.refs], [1, 1, 1]);
        drop();
        const lost = await client;
        log('client-lost', { lost });
        assert.equal(lost.delivered, false, 'the client never received the answer');
        await new Promise(resolve => relay.close(resolve)); relay = null;
        const replay = await call('doctor', 'POST', `/studies/${uid}/findings`, payload);
        ok(replay, 200, 'replay'); assert.equal(replay.body.emr.replayed, true);
        assert.equal(replay.body.emr.receipt.versionId, held.body.emr.receipt.versionId);
        assert.deepEqual(await findingCounts(id), committed.counts);
      });
      await t.test('COMMIT refused by a deferred constraint', async () => {
        const uid = await fresh(), item = await keyItem(uid), created = await createFinding(uid, [{ itemId: item.id, revision: 1 }]);
        ok(created, 200, 'finding'); const fid = created.body.id, id = randomUUID(), before = await findingCounts(fid);
        await witness.$executeRawUnsafe(`CREATE FUNCTION public.wg_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'SYN WG deferred rollback' USING ERRCODE='23514'; END $$`);
        await witness.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER wg_fail_commit AFTER INSERT ON "FindingRevision"
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.wg_fail_commit()`);
        let out;
        try { out = await reviseFinding(uid, fid, 1, 'edit', [{ itemId: item.id, revision: 1 }], 'SYN edit', id); }
        finally {
          await witness.$executeRawUnsafe('DROP TRIGGER wg_fail_commit ON "FindingRevision"');
          await witness.$executeRawUnsafe('DROP FUNCTION public.wg_fail_commit()');
        }
        // The HTTP status of a refused COMMIT is recorded as observed; it is not assumed to be a 503.
        const settled = await outcomeOf('finding', id);
        log('deferred-commit', { out, outcome: settled, counts: await findingCounts(fid) });
        assert.ok(out.status >= 400, JSON.stringify(out));
        assert.deepEqual(await findingCounts(fid), before);
        // The refused COMMIT took its B2 rows with it. With no settled outcome the same ID is a new attempt and
        // applies once; a settled negative would refuse it. Either way nothing is written twice.
        const again = await reviseFinding(uid, fid, 1, 'edit', [{ itemId: item.id, revision: 1 }], 'SYN edit', id);
        const after = await findingCounts(fid);
        log('deferred-commit-same-id', { again, outcome: await outcomeOf('finding', id), counts: after });
        if (settled.length) { assert.ok(again.status >= 400, JSON.stringify(again)); assert.deepEqual(after, before); }
        else {
          ok(again, 200, 'same id after a COMMIT that left no outcome');
          assert.deepEqual([after.revision, after.revisions, after.versions, after.refs, after.audits],
            [before.revision + 1, before.revisions + 1, before.versions + 1, before.refs + 1, before.audits + 1]);
          const replay = await reviseFinding(uid, fid, 1, 'edit', [{ itemId: item.id, revision: 1 }], 'SYN edit', id);
          ok(replay, 200, 'replay'); assert.equal(replay.body.emr.replayed, true); assert.deepEqual(await findingCounts(fid), after);
        }
        ok(await reviseFinding(uid, fid, after.revision, 'edit', [{ itemId: item.id, revision: 1 }], 'SYN edit again'), 200, 'new id');
      });
    });
  } finally {
    if (relay) await new Promise(resolve => relay.close(resolve));
    if (app) await app.close();
    if (startupApp) await startupApp.close();
    if (ready) await runtime.stop(Date.now() + 10000);
    await runtimeDb.$disconnect(); await witness.$disconnect(); await new Promise(resolve => provider.close(resolve));
    fs.rmSync(custody, { recursive: true, force: true });
  }
});
