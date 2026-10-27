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
  let app, archive, ready = false;
  const fs = require('node:fs');
  const custody = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'd-startup-'));
  try {
    await db.memberRightsImport.create({ data: { id: 'realm-v1' } });
    for (const data of Object.values(members)) await db.memberRights.create({ data });
    await runtime.start(); ready = true;
    const clinical = await require('./clinical_fixture.cjs').clinicalFixture(db, runtime.port, issuer, Object.values(members));
    const secretFile = path.join(custody, 'wrapping.key');
    fs.writeFileSync(secretFile, clinical.wrappingSecret);
    process.env.KIN_EMR_WRAPPING_KEY_ID = 'fixture-wrap';
    process.env.KIN_EMR_WRAPPING_KEY_FILES = JSON.stringify({ 'fixture-wrap': secretFile });
    // One original resource per study; splitUid is a WORKLIST-SPLIT-UID source (two patient resources).
    const splitUid = '1.2.840.9999.26';
    const resource = (uid, patient) => ({ '0020000D': { Value: [uid] }, '00100020': { Value: [patient] } });
    const imageUid = '1.2.840.9999.24', seriesUid = imageUid + '.1', sopUid = seriesUid + '.1';
    const comparisonUid = imageUid + '.99';
    const studyResource = '11111111-11111111-11111111-11111111-11111111';
    const comparisonResource = '33333333-33333333-33333333-33333333-33333333';
    const objectResource = '22222222-22222222-22222222-22222222-22222222';
    const original = Buffer.alloc(2048, 37), frameBytes = Buffer.alloc(512, 11);
    original.write('DICM', 128);
    const header = { ...resource(imageUid, 'synthetic:' + imageUid),
      '0020000E': { Value: [seriesUid] }, '00080018': { Value: [sopUid] },
      '00080016': { Value: ['1.2.840.10008.5.1.4.1.1.2'] }, '00080008': { Value: ['ORIGINAL', 'PRIMARY'] } };
    let catalogPatient = 'synthetic:' + imageUid, fileReads = 0, beforeIdentity = null, storedFile = 'synthetic-file-1';
    let frameCount = 1, holdFrame = null, failFile = 0;
    const frameReads = [], frameData = n => n === 0 ? frameBytes : Buffer.alloc(512, 11 + n);
    // FIND-248-F3: a finding's comparison identity is read before its write locks the anchor study row, so a
    // concurrent write to that study never waits behind an archive call. Each comparison lookup probes the lock.
    let comparisonLookups = 0;
    const lockedLookups = [];
    // Orthanc's change log as the catalog's follower reads it: `?last` for where to start, then pages after `since`.
    const changes = [];
    archive = require('node:http').createServer(async (req, res) => {
      const url = new URL(req.url, 'http://synthetic'), json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
      if (url.pathname === '/changes') return json(url.searchParams.has('last')
        ? { Changes: changes.slice(-1), Done: true, Last: changes.length }
        : { Changes: changes.filter(change => change.Seq > Number(url.searchParams.get('since'))), Done: true, Last: changes.length });
      if (url.pathname === '/dicom-web/studies') {
        const uid = url.searchParams.get('StudyInstanceUID');
        if (uid === imageUid && beforeIdentity) await beforeIdentity();
        return json(!uid ? [] : uid === splitUid ? [resource(uid, 'synthetic:split-a'), resource(uid, 'synthetic:split-b')]
          : [resource(uid, 'synthetic:' + (uid === comparisonUid ? imageUid : uid))]);
      }
      if (url.pathname === '/tools/lookup') {
        let body = ''; for await (const chunk of req) body += chunk;
        if (body === comparisonUid) {
          comparisonLookups++;
          try { await db.$transaction(tx => tx.$queryRaw`SELECT uid FROM "StudyState" WHERE uid=${imageUid} FOR UPDATE NOWAIT`); }
          catch (error) { lockedLookups.push(String(error?.meta?.code ?? error?.message)); }
        }
        return json(body === imageUid ? [{ Type: 'Study', ID: studyResource }]
          : body === comparisonUid ? [{ Type: 'Study', ID: comparisonResource }]
          : body === sopUid ? [{ Type: 'Instance', ID: objectResource }] : []);
      }
      if ([`/studies/${studyResource}`, `/studies/${comparisonResource}`].includes(url.pathname)) return json({
        MainDicomTags: { StudyInstanceUID: url.pathname.endsWith(comparisonResource) ? comparisonUid : imageUid },
        PatientMainDicomTags: { PatientID: 'synthetic:' + imageUid } });
      if (url.pathname === `/studies/${studyResource}/instances`) return json([{ ID: objectResource, FileUuid: storedFile, MainDicomTags: { SOPInstanceUID: sopUid } }]);
      if (url.pathname.endsWith('/metadata')) return json([{ ...header, '00100020': { Value: [catalogPatient] },
        ...(frameCount > 1 ? { '00280008': { Value: [frameCount] } } : {}) }]);
      // E reads the object's current PatientID per response (#244, R244-GPT-01); a correction changes it with the metadata.
      if (url.pathname.endsWith('/simplified-tags')) return json({ StudyInstanceUID: imageUid, SeriesInstanceUID: seriesUid,
        SOPInstanceUID: sopUid, SOPClassUID: header['00080016'].Value[0], NumberOfFrames: String(frameCount), PatientID: catalogPatient });
      if (url.pathname.endsWith('/header')) return json({ '0002,0010': { Value: '1.2.840.10008.1.2.1' } });
      // A temporary archive outage: the next `failFile` stored-file reads answer 503.
      if (url.pathname.endsWith('/file') && failFile > 0) { failFile--; res.statusCode = 503; res.end(); return; }
      if (url.pathname.endsWith('/file')) { fileReads++; res.end(original); return; }
      const frame = url.pathname.match(/\/frames\/(\d+)\/raw$/);
      if (frame && Number(frame[1]) < frameCount) {
        const n = Number(frame[1]); frameReads.push(n);
        // A held frame answers nothing until its reader goes away, like a stalled archive read.
        if (holdFrame?.frame === n) { const held = holdFrame; holdFrame = null; res.once('close', held.closed); held.reached(); return; }
        res.end(frameData(n)); return;
      }
      res.statusCode = 404; res.end();
    });
    await new Promise(resolve => archive.listen(0, '127.0.0.1', resolve));
    Object.assign(process.env, { ORTHANC_URL: 'http://127.0.0.1:' + archive.address().port,
      ORTHANC_USER: 'synthetic', ORTHANC_PASS: randomUUID(), KIN_EMR_STATE_DIR: custody });
    fs.writeFileSync(path.join(custody, 'viewer.js'), 'synthetic deployed viewer and native decoder bytes');
    const asset = { version: 'synthetic-distribution', files: ['viewer.js'] };
    fs.writeFileSync(path.join(custody, 'assets.json'), JSON.stringify({ viewer: { id: 'viewer', ...asset }, decoders: { native: asset } }));
    process.env.KIN_EMR_IMAGE_ASSET_CATALOG = path.join(custody, 'assets.json');
    const orthanc = new (product('orthanc.service').OrthancService)();
    const users = Object.values(members).map(m => ({ id: m.sub, username: m.username, email: m.email, firstName: m.name,
      enabled: true, groups: [m.institution], roles: m.roles }));
    const keycloak = { getUser: async sub => users.find(u => u.id === sub),
      assignmentReaders: async institution => users.filter(u => u.groups.includes(institution)), isReader: async () => true };
    const { PrismaService } = product('prisma.service'), { StudyAccessService } = product('study-access.service');
    const services = ['pacs', 'clinician-question', 'image-request', 'consultation', 'reader-assignment', 'finding', 'connect', 'manual-sr'];
    const className = name => name.split('-').map(x => x[0].toUpperCase() + x.slice(1)).join('');
    class HttpFixture {}
    const { createRequestContext, REQUEST_CONTEXT_CAPTURE, REQUEST_CONTEXT_SOURCE } = product('emr-runtime/request-context');
    const { createRequestIngress } = product('emr-runtime/request-ingress');
    const requests = createRequestContext(createRequestIngress({ proxyPeers: ['127.0.0.1'] }), runtime.port);
    Module({ controllers: services.map(n => product(n + '.controller')[className(n) + 'Controller']),
      providers: [PrismaService, ...services.map(n => product(n + '.service')[className(n) + 'Service']),
        product('emr-image/service').OnlineImageService, product('emr-image/check-db').ImageCheckDatabase, product('emr-source/image').OrthancImageCatalog,
        { provide: product('emr-image/context').ImageContextSource,
          inject: [product('emr-clinical/startup').CURRENT_CLINICAL_CONTEXT, product('emr-source/image').OrthancImageCatalog],
          useFactory: (clinical, catalog) => new (product('emr-image/context').ProductionImageContext)(clinical, catalog) },
        product('auth.service').AuthService, ...product('emr-clinical/startup').startupClinicalProviders,
        { provide: REQUEST_CONTEXT_CAPTURE, useValue: requests.capture }, { provide: REQUEST_CONTEXT_SOURCE, useValue: requests.source },
        { provide: product('orthanc.service').OrthancService, useValue: orthanc },
        { provide: product('keycloak.service').KeycloakService, useValue: keycloak },
        { provide: StudyAccessService, useFactory: prisma => new StudyAccessService(prisma, orthanc, keycloak), inject: [PrismaService] },
        { provide: product('emr-runtime/record-port').EMR_RECORD_PORT, useValue: runtime.port },
        { provide: product('emr-runtime/background-work').EMR_BACKGROUND_WORK, useValue: runtime.background.work },
        { provide: APP_GUARD, useClass: product('auth.guard').AuthGuard },
        { provide: product('study-transfer-local.service').StudyTransferLocalService, useValue: {} }] })(HttpFixture);
    // Warnings are what an operator reads; errors still go to the test's stderr.
    const warnings = [];
    app = await NestFactory.create(HttpFixture, { rawBody: true, logger: { log() {}, debug() {}, verbose() {},
      warn: message => warnings.push(String(message)), error: (...args) => console.error(...args) } });
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
    // Empty lists and an absent note answer 200 (never 500) and, serving no record, append no 열람 entry.
    const readEntries = async () => (await db.$queryRaw`SELECT e.payload::jsonb AS event, o.result_id, o.result_version
      FROM emr_access.access_entry e JOIN emr_access.attempt_outcome o ON o.operation_id = e.operation_id
      WHERE e.payload::jsonb->>'surface' IN ('GET studies/:uid/questions', 'GET studies/:uid/image-requests', 'GET questions', 'GET studies/:uid/tech-note')`);
    assert.deepEqual((await send('doctor', 'GET', `/studies/${uid}/questions`)).items, []);
    assert.deepEqual((await send('doctor', 'GET', `/studies/${uid}/image-requests`)).items, []);
    assert.deepEqual((await send('clinician', 'GET', '/questions?view=mine')).items, []);
    assert.equal((await send('doctor', 'GET', `/studies/${uid}/tech-note`)).note, null);
    assert.equal((await readEntries()).length, 0);
    // WORKLIST-SPLIT-UID: a clinical write on a UID two patient resources share is refused with the
    // product's identity issue; no record and no event are written. D1860 / D-T5: the tele cancel of
    // that UID still closes the receiving allocation - an allocation is none of 제23조④'s record acts
    // and needs no resolved patient - ledgered on its own server surface with the patient link waived.
    await db.studyState.create({ data: { uid: splitUid, institutionId: hospital, teleInstitutionId: receiver, ts: 'wait', ss: 'Verified' } });
    const splitNote = await send('tech', 'POST', `/studies/${splitUid}/tech-note`, { attemptId: randomUUID(), baseVersion: 0, text: '분할 UID 메모', reason: '' }, 409);
    assert.equal(splitNote.code, 'STUDY_IDENTITY_UNRESOLVED');
    assert.equal(await db.techNoteRevision.count({ where: { studyUid: splitUid } }), 0);
    await send('doctor', 'PATCH', `/studies/${splitUid}`, { ts: 'cancelled' });
    assert.equal((await db.studyState.findUnique({ where: { uid: splitUid } })).ts, 'cancelled');
    const splitClosed = await db.readerAssignment.findUnique({ where: { studyUid_institutionId: { studyUid: splitUid, institutionId: receiver } } });
    assert.equal(splitClosed.readerSub, null); assert.equal(splitClosed.closedRevision, 1);
    // R219-01 / D1860: inspect both admission and persisted rows after the real automatic close.
    const closeEvents = uid => db.$queryRaw`SELECT e.payload::jsonb AS event, e.stream, e.statutory_act,
      e.retention_class, o.streams AS admitted_streams
      FROM emr_access.access_entry e JOIN emr_access.operation o ON o.operation_id=e.operation_id
      WHERE e.payload::jsonb->>'surface'='server:reader-assignment-close' AND e.payload::jsonb->'context'->>'studyId'=${uid}`;
    const assertViewingClose = entry => {
      assert.equal(entry.event.result, 'succeeded');
      assert.equal(entry.statutory_act, '수정');
      assert.deepEqual(entry.admitted_streams, ['viewing']);
      assert.equal(entry.stream, 'viewing');
      assert.equal(entry.retention_class, 'viewing2y');
    };
    const splitCloses = await closeEvents(splitUid);
    assert.equal(splitCloses.length, 1);
    splitCloses.forEach(assertViewingClose);
    for (const { event } of splitCloses) {
      assert.equal(event.action, 'modify'); assert.equal(event.managingInstitution.value, hospital);
      assert.deepEqual([event.targets[0].kind, event.targets[0].patientLinkSnapshot, event.targets[0].recordId.value, event.targets[0].versionId.value],
        ['assignment', { status: 'not-applicable', reason: 'non-record-target' }, JSON.stringify([splitUid, receiver]), '1']);
    }
    const itemId = randomUUID(), itemSnapshot = { schemaVersion: 1, kind: 'key',
      seriesUid: uid + '.1', sopUid: uid + '.1.1', frame: 1, title: '합성 원본', description: '', hidden: false };
    const [{ bytes: itemBytes }] = await db.$queryRaw`SELECT octet_length(convert_to(${JSON.stringify(itemSnapshot)}::jsonb::text, 'UTF8')) AS bytes`;
    await db.viewerItem.create({ data: { id: itemId, studyUid: uid, authorSub: members.doctor.sub,
      authorActor: 'doctor', revision: 1, snapshot: itemSnapshot, updatedAt: new Date(),
      revisions: { create: { revision: 1, snapshot: itemSnapshot, action: 'create', reason: '', actor: 'doctor', payloadBytes: itemBytes } } } });
    const findingBody = { requestId: randomUUID(), item: { schemaVersion: 1, title: '합성 소견', text: '원본 고정판 연결',
      sources: [{ itemId, revision: 1 }] } };
    const finding = await send('doctor', 'POST', `/studies/${uid}/findings`, findingBody, 200);
    assert.equal(finding.item.sources[0].itemId, itemId);
    assert.equal(finding.item.sources[0].revision, 1);
    assert.ok(finding.emr.signature);
    assert.equal(await db.finding.count(), 1);
    const fixed = await db.$queryRaw`SELECT source_record_id, source_version_id, source_sha256
      FROM emr_clinical.online_reference WHERE version_id=${finding.emr.receipt.versionId}`;
    assert.equal(fixed.length, 1);
    assert.equal(fixed[0].source_record_id, itemId);
    assert.equal(fixed[0].source_version_id, '1');
    const replayedFinding = await send('doctor', 'POST', `/studies/${uid}/findings`, findingBody, 200);
    assert.equal(replayedFinding.id, finding.id);
    assert.equal(replayedFinding.emr.replayed, true);
    assert.equal(await db.findingRevision.count(), 1);
    const updatedItem = { ...itemSnapshot, title: '나중 원본 제목' };
    const [{ bytes: updatedBytes }] = await db.$queryRaw`SELECT octet_length(convert_to(${JSON.stringify(updatedItem)}::jsonb::text, 'UTF8')) AS bytes`;
    await db.viewerItem.update({ where: { id: itemId }, data: { revision: 2, snapshot: updatedItem,
      updatedAt: new Date(), revisions: { create: { revision: 2, snapshot: updatedItem, action: 'edit',
        reason: '', actor: 'doctor', payloadBytes: updatedBytes } } } });
    const stale = await send('doctor', 'POST', `/studies/${uid}/findings`, { ...findingBody, requestId: randomUUID() }, 409);
    assert.equal(stale.code, 'FINDING_SOURCE_STALE');
    const edited = await send('doctor', 'POST', `/studies/${uid}/findings/${finding.id}/revisions`, {
      requestId: randomUUID(), expectedRevision: 1, action: 'edit',
      item: { ...findingBody.item, text: '보존된 원본으로 수정' } }, 200);
    assert.equal(edited.item.sources[0].label, itemSnapshot.title);
    const keptReference = await db.$queryRaw`SELECT source_sha256 FROM emr_clinical.online_reference WHERE version_id=${edited.emr.receipt.versionId}`;
    assert.equal(keptReference[0].source_sha256, fixed[0].source_sha256);
    const refreshed = await send('doctor', 'POST', `/studies/${uid}/findings/${finding.id}/revisions`, {
      requestId: randomUUID(), expectedRevision: 2, action: 'edit',
      item: { ...findingBody.item, sources: [{ itemId, revision: 2 }] } }, 200);
    assert.equal(refreshed.item.sources[0].label, updatedItem.title);
    const renewedReference = await db.$queryRaw`SELECT source_sha256 FROM emr_clinical.online_reference WHERE version_id=${refreshed.emr.receipt.versionId}`;
    assert.notEqual(renewedReference[0].source_sha256, fixed[0].source_sha256);
    assert.equal(await db.findingRevision.count(), 3);
    const oldFindingReplay = await send('doctor', 'POST', `/studies/${uid}/findings`, findingBody, 200);
    assert.equal(oldFindingReplay.item.sources[0].label, itemSnapshot.title);
    assert.deepEqual(oldFindingReplay.emr.signature, finding.emr.signature);
    // D-B2-READ-SIZE-01: a list row serves its listed revision and a history page the revisions it returned;
    // the 열람 entry, its result reference and the signing facts name exactly those versions.
    const findingReads = surface => db.$queryRaw`SELECT e.payload::jsonb AS event, o.result_id, o.result_version
      FROM emr_access.access_entry e JOIN emr_access.attempt_outcome o ON o.operation_id = e.operation_id
      WHERE e.payload::jsonb->>'surface'=${surface} AND o.result_id=${finding.id} ORDER BY e.sequence`;
    const servedTargets = row => row.event.targets.map(target => target.versionId.value);
    const findingVersionIds = [finding, edited, refreshed].map(written => written.emr.receipt.versionId);
    const listedFindings = await send('doctor', 'GET', `/studies/${uid}/findings`);
    assert.deepEqual(listedFindings.items.map(item => [item.id, item.revision]), [[finding.id, 3]]);
    const listReads = await findingReads('GET studies/:uid/findings');
    assert.deepEqual(listReads.map(servedTargets), [[findingVersionIds[2]]]);
    assert.equal(listReads[0].result_version, findingVersionIds[2]);
    const historyPath = `/studies/${uid}/findings/${finding.id}/revisions?limit=2`;
    const firstPage = await send('doctor', 'GET', historyPath);
    assert.deepEqual([firstPage.revisions.map(r => r.revision), firstPage.nextCursor], [[1, 2], 2]);
    assert.deepEqual(firstPage.emr.signatures.map(s => s.versionId), findingVersionIds.slice(0, 2));
    const lastPage = await send('doctor', 'GET', historyPath + '&cursor=2');
    assert.deepEqual([lastPage.revisions.map(r => r.revision), lastPage.nextCursor], [[3], null]);
    assert.deepEqual(lastPage.emr.signatures.map(s => s.versionId), findingVersionIds.slice(2));
    const pastEnd = await send('doctor', 'GET', historyPath + '&cursor=3');
    assert.deepEqual([pastEnd.revisions, pastEnd.emr.signatures], [[], []]);
    const historyReads = await findingReads('GET studies/:uid/findings/:id/revisions');
    assert.deepEqual(historyReads.map(servedTargets), [findingVersionIds.slice(0, 2), findingVersionIds.slice(2)]);
    assert.deepEqual(historyReads.map(row => row.result_version), [findingVersionIds[1], findingVersionIds[2]]);
    await db.studyState.create({ data: { uid: comparisonUid, institutionId: hospital, ss: 'Verified' } });
    const comparisonItemId = randomUUID(), comparisonSnapshot = { ...itemSnapshot,
      seriesUid: comparisonUid + '.1', sopUid: comparisonUid + '.1.1' };
    const [{ bytes: comparisonBytes }] = await db.$queryRaw`SELECT octet_length(convert_to(${JSON.stringify(comparisonSnapshot)}::jsonb::text, 'UTF8')) AS bytes`;
    await db.viewerItem.create({ data: { id: comparisonItemId, studyUid: comparisonUid, authorSub: members.doctor.sub,
      authorActor: 'doctor', revision: 1, snapshot: comparisonSnapshot, updatedAt: new Date(),
      revisions: { create: { revision: 1, snapshot: comparisonSnapshot, action: 'create', reason: '', actor: 'doctor', payloadBytes: comparisonBytes } } } });
    const comparisonBody = { ...findingBody, requestId: randomUUID(), item: { ...findingBody.item,
      sources: [{ itemId: comparisonItemId, revision: 1 }] } };
    const comparisonFinding = await send('doctor', 'POST', `/studies/${uid}/findings`, comparisonBody, 200);
    assert.ok(comparisonLookups > 0, 'the new comparison copy proved the patient against the archive');
    assert.deepEqual(lockedLookups, [], 'no comparison archive read ran while the anchor study row was locked');
    const findingVersions = await db.findingRevision.count();
    await db.studyState.update({ where: { uid: comparisonUid }, data: { institutionId: receiver } });
    await send('doctor', 'POST', `/studies/${uid}/findings`, comparisonBody, 404);
    assert.equal(await db.findingRevision.count(), findingVersions);
    await db.studyState.update({ where: { uid: comparisonUid }, data: { institutionId: hospital } });
    const comparisonReplay = await send('doctor', 'POST', `/studies/${uid}/findings`, comparisonBody, 200);
    assert.deepEqual(comparisonReplay.emr.signature, comparisonFinding.emr.signature);
    assert.equal(comparisonReplay.emr.replayed, true);
    assert.deepEqual(lockedLookups, []);
    // FIND-248-F4: the fixed source copy D keeps is the stored revision as stored. A 17-digit double that the
    // query engine's Json conversion would move by one ULP reaches the copy and the finding exactly.
    const exactItemId = randomUUID(), exactValue = -0.33113281957650276;
    const exactText = `{"schemaVersion":1,"kind":"length","seriesUid":"${uid}.1","sopUid":"${uid}.1.1","frame":1,` +
      `"frameOfReferenceUid":"${uid}.9","label":"합성 길이","points":[[-0.33113281957650276,0.1,0],[10.5,0.2,0]],` +
      `"viewPlaneNormal":[0,0,1],"viewUp":[0,-1,0],"baseline":{"calculator":"kin-native-manual-v1","values":[-0.33113281957650276]},"hidden":false}`;
    await db.$executeRaw`INSERT INTO "ViewerItem" (id, "studyUid", "authorSub", "authorActor", revision, hidden, snapshot, "updatedAt")
      VALUES (${exactItemId}::uuid, ${uid}, ${members.doctor.sub}, 'doctor', 1, false, ${exactText}::jsonb, now())`;
    await db.$executeRaw`INSERT INTO "ViewerRevision" ("itemId", revision, snapshot, action, reason, actor, "payloadBytes")
      VALUES (${exactItemId}::uuid, 1, ${exactText}::jsonb, 'create', '', 'doctor', octet_length(convert_to(${exactText}::jsonb::text, 'UTF8')))`;
    const exact = await send('doctor', 'POST', `/studies/${uid}/findings`, { requestId: randomUUID(),
      item: { schemaVersion: 1, title: '합성 정밀값', text: '원본 그대로', sources: [{ itemId: exactItemId, revision: 1 }] } }, 200);
    assert.deepEqual(exact.item.sources[0].values, [exactValue]);
    const [exactCommand] = await db.$queryRaw`SELECT c.body FROM emr_clinical.online_command c
      JOIN emr_clinical.online_version v ON v.operation_id=c.operation_id WHERE v.version_id=${exact.emr.receipt.versionId}`;
    const fixedCopy = JSON.parse(exactCommand.body).projection.fixedSources[0].row.snapshot;
    assert.deepEqual([fixedCopy.baseline.values, fixedCopy.points[0][0]], [[exactValue], exactValue]);
    // The registered image route reads real HTTP catalog/object/frame bodies and
    // persists the exact preparation/transport evidence through PostgreSQL B2.
    // A series retrieve: E keeps a study's manifest for its frame and instance requests (#244, manifest-reuse.ts) but
    // reads the catalog again for a series or study request, so each request below exercises the catalog itself.
    const imageUrl = origin + '/api/images/dicom-web?target=' + encodeURIComponent(`/dicom-web/studies/${imageUid}/series/${seriesUid}`);
    const imageResponse = await fetch(imageUrl, { headers: { authorization: 'Bearer ' + tokens.doctor } });
    assert.equal(imageResponse.status, 200, await (imageResponse.status === 200 ? Promise.resolve('') : imageResponse.text()));
    const bodyBytes = Buffer.from(await imageResponse.arrayBuffer());
    assert.ok(bodyBytes.includes(original));
    const firstReads = fileReads;
    // FIND-248-F6: an unchanged stored file is not downloaded again to rebuild the manifest; the delivery still
    // reads and hashes what it serves. A new stored file of the same object is read for the manifest again.
    const repeatedImage = await fetch(imageUrl, { headers: { authorization: 'Bearer ' + tokens.doctor } });
    assert.equal(repeatedImage.status, 200); assert.ok(Buffer.from(await repeatedImage.arrayBuffer()).includes(original));
    const repeatedReads = fileReads - firstReads;
    assert.ok(repeatedReads >= 1 && repeatedReads < firstReads, JSON.stringify({ firstReads, repeatedReads }));
    storedFile = 'synthetic-file-2';
    const rewrittenImage = await fetch(imageUrl, { headers: { authorization: 'Bearer ' + tokens.doctor } });
    assert.equal(rewrittenImage.status, 200); await rewrittenImage.arrayBuffer();
    assert.equal(fileReads - firstReads - repeatedReads, firstReads);
    // A preparation names its study manifest's body, kept once in emr_image.source_manifest (#244, 20261026210000).
    const preparations = await db.$queryRaw`SELECT COALESCE(p.source_manifest, m.body) AS source_manifest, p.response_manifest
      FROM emr_image.preparation p LEFT JOIN emr_image.source_manifest m ON m.body_sha256 = p.source_manifest_body`;
    assert.equal(preparations.length, 3);
    assert.equal(new Set(preparations.map(p => JSON.stringify(p.source_manifest.objects))).size, 1, 'the same fixed object version each time');
    const observed = preparations[0].source_manifest;
    assert.equal(observed.patient.patientId, 'synthetic:' + imageUid);
    assert.equal(observed.objects[0].sha256, require('node:crypto').createHash('sha256').update(original).digest('hex'));
    assert.equal(observed.objects[0].frames[0].sha256, require('node:crypto').createHash('sha256').update(frameBytes).digest('hex'));
    const originalReads = fileReads;
    const outside = await fetch(imageUrl, { headers: { authorization: 'Bearer ' + tokens.receiving } });
    assert.equal(outside.status, 404); await outside.text();
    assert.equal(fileReads, originalReads, 'out-of-scope source is not read');
    catalogPatient = 'synthetic:other-patient';
    const changedPatient = await fetch(imageUrl, { headers: { authorization: 'Bearer ' + tokens.doctor } });
    assert.equal(changedPatient.status, 503);
    assert.equal((await changedPatient.json()).code, 'ImageCurrentStudyChanged');
    assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM emr_image.preparation`)[0].n, 3);
    catalogPatient = 'synthetic:' + imageUid;
    let identityReads = 0;
    // The study moves to another institution while its identity is read for the manifest: the catalog's own access
    // check refuses it and nothing is prepared or served. (#244: a response joining an open study delivery is then
    // checked by recheck() before any source read, and the source's per-response identity read comes after that
    // check, so the move can no longer be placed between the two from here; E's delivery/service tests cover recheck.)
    beforeIdentity = async () => {
      if (++identityReads === 1) await db.studyState.update({ where: { uid: imageUid }, data: { institutionId: receiver } });
    };
    const movedStudy = await fetch(imageUrl, { headers: { authorization: 'Bearer ' + tokens.doctor } });
    assert.equal(movedStudy.status, 404); await movedStudy.text();
    assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM emr_image.preparation`)[0].n, 3);
    beforeIdentity = null;
    await db.studyState.update({ where: { uid: imageUid }, data: { institutionId: hospital } });
    // R248-FIX3-01: the catalog has no deadline or size refusal of its own. A requester that leaves while a
    // multiframe object is being read keeps the frames already finished; the next request reads only the rest.
    frameCount = 3; storedFile = 'synthetic-file-3'; frameReads.length = 0;
    const readsBeforePartial = fileReads, held = { frame: 2 };
    const atHeldFrame = new Promise(resolve => { held.reached = resolve; }), heldClosed = new Promise(resolve => { held.closed = resolve; });
    holdFrame = held;
    const leaving = new AbortController();
    const partial = fetch(imageUrl, { headers: { authorization: 'Bearer ' + tokens.doctor }, signal: leaving.signal }).catch(error => error);
    await atHeldFrame; leaving.abort(); await heldClosed;
    assert.equal((await partial).name, 'AbortError');
    assert.deepEqual(frameReads, [0, 1, 2]);
    const resumed = await fetch(imageUrl, { headers: { authorization: 'Bearer ' + tokens.doctor } });
    assert.equal(resumed.status, 200, await (resumed.status === 200 ? resumed.arrayBuffer().then(() => '') : resumed.text()));
    assert.deepEqual(frameReads, [0, 1, 2, 2], 'only the unfinished frame is read again');
    assert.equal(fileReads - readsBeforePartial, 1 + repeatedReads, 'the stored file is digested once, then delivered');
    const multiframe = (await db.$queryRaw`SELECT COALESCE(p.source_manifest, m.body) AS source_manifest FROM emr_image.preparation p
      LEFT JOIN emr_image.source_manifest m ON m.body_sha256 = p.source_manifest_body`)
      .map(p => p.source_manifest.objects[0]).filter(o => o.frames.length === 3);
    assert.equal(multiframe.length, 1);
    assert.deepEqual(multiframe[0].frames.map(f => [f.number, f.sha256]),
      [0, 1, 2].map(n => [n + 1, require('node:crypto').createHash('sha256').update(frameData(n)).digest('hex')]));
    frameCount = 1; storedFile = 'synthetic-file-2';
    // Cold first opening (#248 follow-up): each stored file's digests are kept in emr_image.object_digest, by the
    // opening that read them or by the follower once the study is stable. An opening that finds the listed file's row
    // reads no original or frame for its manifest (no process memory is involved); delivery still reads what it serves.
    const sha = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    const kept = file => db.$queryRaw`SELECT sha256, frames FROM emr_image.object_digest WHERE instance_id=${objectResource} AND file_uuid=${file}`;
    assert.deepEqual((await kept('synthetic-file-1')).map(row => [row.sha256, row.frames]),
      [[sha(original), [{ number: 1, bytes: frameBytes.length, sha256: sha(frameBytes) }]]]);
    storedFile = 'synthetic-file-4';
    const readsBeforeFollow = fileReads, framesBeforeFollow = frameReads.length;
    changes.push({ Seq: changes.length + 1, ChangeType: 'StableStudy', ResourceType: 'Study', ID: studyResource });
    // The same hang bound the D fixture gives its archive source to start (online_live.py, 120 s).
    for (const until = Date.now() + 120000; !(await kept('synthetic-file-4')).length;) {
      assert.ok(Date.now() < until, 'the follower kept the stable study');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual([fileReads - readsBeforeFollow, frameReads.length - framesBeforeFollow], [1, 1], 'the follower read the file and its frame once');
    const readsBeforeCold = fileReads, framesBeforeCold = frameReads.length;
    const cold = await fetch(imageUrl, { headers: { authorization: 'Bearer ' + tokens.doctor } });
    assert.equal(cold.status, 200); assert.ok(Buffer.from(await cold.arrayBuffer()).includes(original));
    assert.deepEqual([fileReads - readsBeforeCold, frameReads.length - framesBeforeCold], [repeatedReads, 0],
      'the first opening of the followed file reads only what it delivers');
    // A stable study the follower cannot read now is reported, not taken for digested, and its first opening reads
    // it. A study removed before the follower reached it is expected and stays quiet; the log names neither.
    storedFile = 'synthetic-file-6'; failFile = 1;
    const warnedBefore = warnings.length, readsBeforeOutage = fileReads;
    changes.push({ Seq: changes.length + 1, ChangeType: 'StableStudy', ResourceType: 'Study', ID: '44444444-44444444-44444444-44444444-44444444' });
    changes.push({ Seq: changes.length + 1, ChangeType: 'StableStudy', ResourceType: 'Study', ID: studyResource });
    for (const until = Date.now() + 120000; warnings.length === warnedBefore;) {
      assert.ok(Date.now() < until, 'the follower reported the study it could not read');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(failFile, 0);
    const reported = warnings.slice(warnedBefore);
    assert.equal(reported.length, 1, JSON.stringify(reported));
    assert.match(reported[0], /ImageSourceUnavailable/);
    for (const name of [studyResource, objectResource, imageUid, 'synthetic:', storedFile]) assert.equal(reported[0].includes(name), false, name);
    assert.equal((await kept('synthetic-file-6')).length, 0, 'nothing is kept for the study not read');
    const afterOutage = await fetch(imageUrl, { headers: { authorization: 'Bearer ' + tokens.doctor } });
    assert.equal(afterOutage.status, 200); assert.ok(Buffer.from(await afterOutage.arrayBuffer()).includes(original));
    assert.equal(fileReads - readsBeforeOutage, 1 + repeatedReads, 'the first opening reads the file the follower could not');
    assert.equal((await kept('synthetic-file-6')).length, 1);
    // A kept row is no delivery check of its own: a row naming other bytes builds a manifest the delivery refuses.
    storedFile = 'synthetic-file-5';
    await db.$executeRaw`INSERT INTO emr_image.object_digest (instance_id, file_uuid, sop_instance_uid, transfer_syntax_uid, bytes, sha256, frames)
      VALUES (${objectResource}, ${storedFile}, ${sopUid}, '1.2.840.10008.1.2.1', ${original.length}::bigint, ${'0'.repeat(64)},
        ${JSON.stringify([{ number: 1, bytes: frameBytes.length, sha256: sha(frameBytes) }])}::jsonb)`;
    const preparedBeforeWrong = (await db.$queryRaw`SELECT count(*)::int AS n FROM emr_image.preparation`)[0].n;
    const wrong = await fetch(imageUrl, { headers: { authorization: 'Bearer ' + tokens.doctor } });
    const wrongBody = Buffer.from(await wrong.arrayBuffer());
    assert.notEqual(wrong.status, 200); assert.equal(wrongBody.includes(original), false);
    assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM emr_image.preparation`)[0].n, preparedBeforeWrong);
    storedFile = 'synthetic-file-2';
    const question ={ requestId: randomUUID(), expectedOwner: owner('clinician'), body: '합성 질문 원문' };
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
    // A served record is one 열람 event per list it appears in: the record's study and institution, the version
    // its row serves as target and appended reference. A list row is the thread's summary at its head and
    // carries no entry body (R248-01); the thread read above serves, and names, both entries.
    const listed = (await readEntries()).filter(row => row.event.surface !== 'GET studies/:uid/tech-note');
    assert.deepEqual(listed.map(row => row.event.surface).sort(), ['GET questions', 'GET studies/:uid/questions']);
    for (const row of listed) {
      assert.equal(row.event.action, 'provide-prepared'); assert.equal(row.event.managingInstitution.value, hospital);
      assert.equal(row.event.context.studyId, uid);
      assert.deepEqual(row.event.targets.map(t => t.versionId.value), [read.emr.signatures[1].versionId]);
      assert.equal(row.result_id, id); assert.equal(row.result_version, read.emr.signatures[1].versionId);
    }
    const threadReads = await db.$queryRaw`SELECT e.payload::jsonb AS event FROM emr_access.access_entry e
      WHERE e.payload::jsonb->>'surface'='GET questions/:id'`;
    assert.deepEqual(threadReads.map(row => row.event.targets.map(t => t.versionId.value)), [read.emr.signatures.map(s => s.versionId)]);
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
    const noteBody = { attemptId: randomUUID(), baseVersion: 0, text: '합성 촬영 메모', reason: '' };
    const note = await send('tech', 'POST', `/studies/${uid}/tech-note`, noteBody);
    assert.ok(note.emr.signature);
    const history = await send('doctor', 'GET', `/studies/${uid}/tech-note/history`);
    assert.equal(history.items[0].text, '합성 촬영 메모'); assert.equal(history.emr.signatures.length, 1);
    const legacy = await send('tech', 'POST', `/studies/${uid}/tech-note`, { baseVersion: 1, text: '합성 메모 정정', reason: '합성 정정 사유' });
    assert.ok(legacy.emr.signature); assert.equal(legacy.note.attemptId, null);
    // R248-01: the current note serves its one version, a history page the versions it lists, and a page
    // listing nothing serves and records nothing.
    const noteReads = surface => db.$queryRaw`SELECT e.payload::jsonb AS event, o.result_version
      FROM emr_access.access_entry e JOIN emr_access.attempt_outcome o ON o.operation_id = e.operation_id
      WHERE e.payload::jsonb->>'surface'=${surface} AND e.payload::jsonb->'context'->>'studyId'=${uid} ORDER BY e.sequence`;
    const noteVersions = [note.emr.receipt.versionId, legacy.emr.receipt.versionId];
    const currentBefore = (await noteReads('GET studies/:uid/tech-note')).length;
    const currentNote = await send('doctor', 'GET', `/studies/${uid}/tech-note`);
    assert.equal(currentNote.note.version, 2);
    assert.deepEqual(currentNote.emr.signatures.map(s => s.versionId), [noteVersions[1]]);
    const currentReads = (await noteReads('GET studies/:uid/tech-note')).slice(currentBefore);
    assert.deepEqual(currentReads.map(row => [row.event.targets.map(t => t.versionId.value), row.result_version]), [[[noteVersions[1]], noteVersions[1]]]);
    const historyBefore = (await noteReads('GET studies/:uid/tech-note/history')).length;
    const olderPage = await send('doctor', 'GET', `/studies/${uid}/tech-note/history?before=2`);
    assert.deepEqual([olderPage.items.map(i => i.version), olderPage.emr.signatures.map(s => s.versionId)], [[1], [noteVersions[0]]]);
    const emptyPage = await send('doctor', 'GET', `/studies/${uid}/tech-note/history?before=1`);
    assert.deepEqual([emptyPage.items, emptyPage.emr.signatures], [[], []]);
    const pageReads = (await noteReads('GET studies/:uid/tech-note/history')).slice(historyBefore);
    assert.deepEqual(pageReads.map(row => row.event.targets.map(t => t.versionId.value)), [[noteVersions[0]]]);
    // A late resend of the first save answers its stored receipt (v1) and today's head (v2): its 열람 entries name
    // exactly those two, one each, and no retained version it did not return.
    const resendBefore = (await noteReads('POST studies/:uid/tech-note')).filter(row => row.event.action === 'provide-prepared').length;
    const resent = await send('tech', 'POST', `/studies/${uid}/tech-note`, noteBody);
    assert.deepEqual([resent.emr.replayed, resent.note.version, resent.latestNote.version], [true, 1, 2]);
    const resendReads = (await noteReads('POST studies/:uid/tech-note')).filter(row => row.event.action === 'provide-prepared').slice(resendBefore);
    assert.deepEqual(resendReads.map(row => row.event.targets.map(t => t.versionId.value)), [[noteVersions[0]], [noteVersions[1]]]);
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
    const closes = await closeEvents(teleUid);
    assert.equal(closes.length, 1);
    closes.forEach(assertViewingClose);
    for (const { event } of closes) {
      assert.equal(event.action, 'modify');
      assert.equal(event.userId.value.subject, members.doctor.sub);
      assert.equal(event.actingInstitution.value, hospital); assert.equal(event.managingInstitution.value, hospital);
      assert.equal(event.targets[0].recordId.value, JSON.stringify([teleUid, receiver]));
      assert.equal(event.targets[0].versionId.value, '2');
      assert.deepEqual(event.targets[0].patientLinkSnapshot, { status: 'not-applicable', reason: 'non-record-target' });
    }
    assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM emr_access.access_entry WHERE payload::jsonb->>'surface'='PATCH studies/:uid'`)[0].n, 0);
    const denied = await fetch(origin + `/api/studies/${teleUid}/reader-assignment`, { headers: { authorization: 'Bearer ' + tokens.receiving } });
    assert.ok(denied.status >= 400);
    assert.equal(await db.reportVersion.count(), 0); assert.equal(await db.reportDraft.count(), 0);
    await require('./sr_http_cases.cjs')({ db, orthanc, send, uid, members, records: runtime.port });
  } finally {
    if (app) await app.close();
    if (ready) await runtime.stop(Date.now() + 10000);
    await db.$disconnect(); await new Promise(resolve => idp.close(resolve));
    if (archive) await new Promise(resolve => { archive.close(resolve); archive.closeAllConnections(); });
    fs.rmSync(custody, { recursive: true });
  }
});
