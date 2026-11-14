'use strict';
// Image Report: a drawing attached to the report is part of its draft and of the version made from it, under the same
// boundary as the text. Real authenticated HTTP (PUT report, POST commit, the drawing reads), the guard, PostgreSQL,
// the B2 ledger and C2 signing; only identities, the study source and the PNG are synthetic.
//   - attach / remove ride the draft write: a late attach (old revision), a screen that did not see a drawing, the same
//     background without naming the drawing it replaces, a key image frame that is not the study's: refused, no change;
//   - a version holds the draft's drawings; the signature names each by the server's hash; a failed signing keeps nothing;
//   - an amendment that only removes a drawing is a change; a removed drawing does not come back in the next version;
//   - reset leaves the head without drawings and keeps them on the discarded copy; a later save does not revive them;
//   - reads: a version's drawing for any reader of the report, a draft-only drawing for its author only, a drawing no
//     version and no live draft holds for nobody; the fixed version chain (with and without drawings) still verifies.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const zlib = require('node:zlib');
const { randomUUID, randomBytes } = require('node:crypto');
const api = process.env.KIN_D_API || path.resolve(__dirname, '../../../api');
const dependency = name => require(path.join(api, 'node_modules', name));
const product = name => require(path.join(api, 'dist', name));
dependency('reflect-metadata');
const { PrismaClient } = dependency('@prisma/client');
const jose = dependency('jose');
const { Module } = dependency('@nestjs/common');
const { NestFactory, APP_GUARD } = dependency('@nestjs/core');

function png(w, h, shade = 0xff, noise = false) {
  const crc = buf => { let c, r = 0xffffffff; for (const b of buf) { c = (r ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; r = (r >>> 8) ^ c; } return (r ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = noise ? randomBytes((w * 3 + 1) * h) : Buffer.alloc((w * 3 + 1) * h, shade);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const RED = '#e0242b';
const strokes = [{ tool: 'ellipse', color: RED, points: [[0.1, 0.2], [0.3, 0.4]] }, { tool: 'text', color: RED, points: [[0.32, 0.3]], text: 'Mass 1.5 cm' }];

test('Image Report drawings ride the draft boundary, are bound and signed with the version, and are read by its rules', async () => {
  const { EmrRuntime } = product('emr-runtime/application');
  const { EMR_RECORD_PORT } = product('emr-runtime/record-port');
  const { EMR_BACKGROUND_WORK } = product('emr-runtime/background-work');
  const { PrismaService } = product('prisma.service');
  const { AuthService } = product('auth.service');
  const { PresenceService } = product('presence.service');
  const { AuthGuard } = product('auth.guard');
  const { PacsController } = product('pacs.controller');
  const { ImageReportController } = product('image-report.controller');
  const { PacsService } = product('pacs.service');
  const { StudyAccessService } = product('study-access.service');
  const { OrthancService } = product('orthanc.service');
  const { KeycloakService } = product('keycloak.service');
  const { FindingService } = product('finding.service');
  const { StudyTransferLocalService } = product('study-transfer-local.service');
  const { EmrViewingModule } = product('emr-viewing/emr-viewing.module');
  const drawingRules = product('image-report');
  const issuer = 'https://synthetic.example.test/realms/drawing', institution = 'drawing-fixture';
  const sub = 'synthetic-drawing-doctor', author = 'drawer@example.test';
  Object.assign(process.env, { KC_ISSUER: issuer, KC_AUDIENCE: 'kin-api', AUTH_REQUIRED: 'true',
    KIN_COOKIE_SECRET: randomUUID(), KC_WEB_SECRET: randomUUID(), PUBLIC_ORIGIN: 'https://synthetic.example.test' });
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  const jwk = { ...await jose.exportJWK(publicKey), kid: 'drawing-fixture', alg: 'RS256', use: 'sig' };
  const provider = require('node:http').createServer((_req, res) => {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  process.env.KC_JWKS_URL = 'http://127.0.0.1:' + provider.address().port + '/certs';
  const bearer = (email, subject) => new jose.SignJWT({ email, realm_access: { roles: ['radiologist'] }, groups: ['/' + institution] })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer).setSubject(subject).setAudience('kin-api')
    .setIssuedAt().setExpirationTime('10m').sign(privateKey);
  const token = await bearer(author, sub);
  const second = { sub: 'synthetic-drawing-second', author: 'second-drawer@example.test' };
  second.token = await bearer(second.author, second.sub);
  const witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_D_WITNESS_URL } } });
  const runtime = new EmrRuntime(process.env.DATABASE_URL, process.env.KIN_D_SPOOL);
  let app, ready = false;
  try {
    await witness.memberRightsImport.create({ data: { id: 'realm-v1' } });
    for (const member of [{ sub, author }, second])
      await witness.memberRights.create({ data: { sub: member.sub, username: member.sub, email: member.author, name: 'Synthetic',
        emailVerified: true, approved: true, suspended: false, institution, roles: ['radiologist'] } });
    await runtime.start(); ready = true;
    const clinical = await require('./clinical_fixture.cjs').clinicalFixture(witness, runtime.port, issuer,
      [sub, second.sub].map(member => ({ sub: member, institution, roles: ['radiologist'] })));
    const orthanc = { studyIdentityResources: async uid => [{ '0020000D': { Value: [uid] } }], studyIdentities: async () => [] };
    class HttpFixture {}
    const { createRequestContext, REQUEST_CONTEXT_CAPTURE, REQUEST_CONTEXT_SOURCE } = product('emr-runtime/request-context');
    const { createRequestIngress } = product('emr-runtime/request-ingress');
    const requests = createRequestContext(createRequestIngress({ proxyPeers: ['127.0.0.1'] }), runtime.port);
    Module({ imports: [EmrViewingModule.withRequests(requests.source)],
      controllers: [PacsController, ImageReportController], providers: [PrismaService, PacsService, AuthService, PresenceService, ...clinical.providers,
      { provide: REQUEST_CONTEXT_CAPTURE, useValue: requests.capture }, { provide: REQUEST_CONTEXT_SOURCE, useValue: requests.source },
      { provide: OrthancService, useValue: orthanc }, { provide: KeycloakService, useValue: {} },
      { provide: FindingService, useValue: {} },
      { provide: StudyAccessService, useFactory: db => new StudyAccessService(db, orthanc, {}), inject: [PrismaService] },
      { provide: EMR_RECORD_PORT, useValue: runtime.port },
      { provide: EMR_BACKGROUND_WORK, useValue: runtime.background.work },
      { provide: APP_GUARD, useClass: AuthGuard }, { provide: StudyTransferLocalService, useValue: {} }] })(HttpFixture);
    app = await NestFactory.create(HttpFixture, { logger: ['error'] });
    app.use(product('report-draft-parser').reportDraftParser());   // as main.ts registers it
    app.setGlobalPrefix('api'); await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const call = async (method, uid, endpoint, body, as = token) => {
      const response = await fetch(origin + '/api/studies/' + uid + endpoint, {
        method, headers: { authorization: 'Bearer ' + as, 'content-type': 'application/json', 'x-real-ip': '192.0.2.24' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    const put = (uid, body, as) => call('PUT', uid, '/report', body, as);
    const commit = (uid, body, as) => call('POST', uid, '/report/commit', body, as);
    const read = (uid, rest = '', as) => call('GET', uid, '/report/drawings' + rest, undefined, as);
    const drawingRows = uid => witness.reportDrawing.count({ where: { studyUid: uid } });

    const state = await witness.studyState.create({ data: { uid: '1.2.840.9999.137', institutionId: institution, ss: 'Verified' } });
    const other = await witness.studyState.create({ data: { uid: '1.2.840.9999.138', institutionId: institution, ss: 'Verified' } });
    const uid = state.uid, epoch = state.draftEpoch;
    const owner = { institution, sub, author };
    const texts = { findings: '합성 판독 원문', conclusion: '합성 결론', recommendation: '' };
    const base = (revision, extra = {}) => ({ expectedOwner: owner, expectedRevision: epoch + ':' + revision, baseVersion: 0,
      findings: '', conclusion: '', recommendation: '', citationIds: [], structureIds: [], ...extra });
    const breast = { background: 'breast', strokes, png: png(640, 440).toString('base64') };

    // ── attach on an empty report: the drawing alone is a draft ──
    const first = await put(uid, base(0, { drawingIds: [], drawing: breast }));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const breastId = first.body.drawn.added;
    assert.equal(first.body.present, true);
    assert.deepEqual(first.body.snapshot.drawings, [breastId]);
    assert.deepEqual(first.body.drawn.ids, [breastId]);
    const stored = await witness.reportDrawing.findUnique({ where: { id: breastId } });
    assert.equal(stored.studyUid, uid); assert.equal(stored.authorSub, sub);
    assert.equal(stored.width, 640); assert.equal(stored.height, 440);
    assert.equal(stored.sha256, drawingRules.drawingHash({ background: 'breast', source: null, strokes, png: Buffer.from(breast.png, 'base64') }));

    // ── a PNG that is not a whole picture is refused before anything is read or written ──
    const truncated = await put(uid, base(1, { drawingIds: [breastId], drawing: { ...breast, background: 'thyroid',
      png: Buffer.from(breast.png, 'base64').subarray(0, 40).toString('base64') } }));
    assert.equal(truncated.status, 400, JSON.stringify(truncated.body));
    assert.equal(await drawingRows(uid), 1);
    assert.equal((await witness.reportDraft.findUnique({ where: { uid_author: { uid, author } } })).revision, 1);
    // An unknown critical chunk (its CRC right) is one a viewer must understand: refused, nothing written.
    {
      const good = Buffer.from(breast.png, 'base64'), type = Buffer.from('ABCD'), len = Buffer.alloc(4), sum = Buffer.alloc(4);
      sum.writeUInt32BE(zlib.crc32 ? zlib.crc32(type) : 0);
      const odd = await put(uid, base(1, { drawingIds: [breastId], drawing: { ...breast, background: 'thyroid',
        png: Buffer.concat([good.subarray(0, 33), len, type, sum, good.subarray(33)]).toString('base64') } }));
      assert.equal(odd.status, 400, JSON.stringify(odd.body));
      assert.equal(await drawingRows(uid), 1);
    }    // ── a late attach (the revision before the first one): refused, nothing written ──
    const late = await put(uid, base(0, { drawingIds: [], drawing: { ...breast, background: 'thyroid' } }));
    assert.equal(late.status, 409); assert.equal(late.body.code, 'REPORT_DRAFT_CONFLICT');
    assert.equal(await drawingRows(uid), 1);
    // ── a screen that did not see the drawing (another tab attached it): refused ──
    const blind = await put(uid, base(1, { findings: texts.findings, drawingIds: [] }));
    assert.equal(blind.status, 409); assert.equal(blind.body.code, 'REPORT_DRAFT_CONFLICT');
    // ── the same diagram again without naming the drawing it replaces: refused; naming it replaces it ──
    const again = await put(uid, base(1, { drawingIds: [breastId], drawing: breast }));
    assert.equal(again.status, 409); assert.equal(again.body.code, 'REPORT_DRAWING_STALE');
    const replaced = await put(uid, base(1, { drawingIds: [breastId], drawing: { ...breast, replaces: breastId } }));
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    const breast2 = replaced.body.drawn.added;
    assert.equal(replaced.body.drawn.replaced, breastId);
    assert.deepEqual(replaced.body.snapshot.drawings, [breast2]);
    // ── a saved image is the study's own key image at its revision and frame ──
    const keyId = randomUUID(), otherKey = randomUUID();
    await witness.viewerItem.create({ data: { id: keyId, studyUid: uid, authorSub: sub, authorActor: author, revision: 1,
      snapshot: { kind: 'key', seriesUid: '1.2.840.9999.137.1', sopUid: '1.2.840.9999.137.1.7', frame: 2, title: 'SYN key' }, updatedAt: new Date() } });
    await witness.viewerItem.create({ data: { id: otherKey, studyUid: other.uid, authorSub: sub, authorActor: author, revision: 1,
      snapshot: { kind: 'key', seriesUid: '1.2.840.9999.138.1', sopUid: '1.2.840.9999.138.1.1', frame: 1, title: 'SYN other' }, updatedAt: new Date() } });
    const onImage = (source, revision) => base(revision, { drawingIds: [breast2],
      drawing: { background: 'image', source, strokes: [{ tool: 'line', color: '#1565c0', points: [[0.9, 0.1], [0.5, 0.8]] }], png: png(320, 220, 0x40).toString('base64') } });
    for (const wrong of [{ keyImageId: keyId, keyImageRevision: 1, frame: 1 }, { keyImageId: keyId, keyImageRevision: 2, frame: 2 },
      { keyImageId: otherKey, keyImageRevision: 1, frame: 1 }]) {
      const refused = await put(uid, onImage(wrong, 2));
      assert.equal(refused.status, 409, JSON.stringify(wrong)); assert.equal(refused.body.code, 'REPORT_DRAWING_SOURCE');
    }
    const image = await put(uid, onImage({ keyImageId: keyId, keyImageRevision: 1, frame: 2 }, 2));
    assert.equal(image.status, 200, JSON.stringify(image.body));
    const imageId = image.body.drawn.added;
    assert.deepEqual((await witness.reportDrawing.findUnique({ where: { id: imageId } })).source,
      { keyImageId: keyId, keyImageRevision: 1, seriesUid: '1.2.840.9999.137.1', sopUid: '1.2.840.9999.137.1.7', frame: 2 });
    // ── three per report ──
    // A real-sized picture (incompressible pixels, well over the default 100 KB JSON body) goes through the draft write.
    const large = png(320, 220, 0, true).toString('base64');
    assert.ok(large.length > 150000);
    const thyroid = await put(uid, base(3, { drawingIds: [breast2, imageId], drawing: { ...breast, background: 'thyroid', png: large } }));
    assert.equal(thyroid.status, 200, JSON.stringify(thyroid.body));
    const thyroidId = thyroid.body.drawn.added;
    assert.equal((await read(uid, '/' + thyroidId)).body.png, large);
    const sameFrame = await put(uid, base(4, { drawingIds: [breast2, imageId, thyroidId],
      drawing: { ...onImage({ keyImageId: keyId, keyImageRevision: 1, frame: 2 }, 4).drawing, replaces: undefined } }));
    assert.equal(sameFrame.status, 409); assert.equal(sameFrame.body.code, 'REPORT_DRAWING_STALE');   // same frame: names the one it replaces
    // A fourth drawing (another key image) is over the three a report holds.
    const secondKey = randomUUID();
    await witness.viewerItem.create({ data: { id: secondKey, studyUid: uid, authorSub: sub, authorActor: author, revision: 1,
      snapshot: { kind: 'key', seriesUid: '1.2.840.9999.137.2', sopUid: '1.2.840.9999.137.2.1', frame: 1, title: 'SYN key 2' }, updatedAt: new Date() } });
    const fourth = await put(uid, base(4, { drawingIds: [breast2, imageId, thyroidId],
      drawing: onImage({ keyImageId: secondKey, keyImageRevision: 1, frame: 1 }, 4).drawing }));
    assert.equal(fourth.status, 409); assert.equal(fourth.body.code, 'REPORT_DRAWING_LIMIT');
    assert.equal(await drawingRows(uid), 4, 'no row for a refused attach');
    // Remove the thyroid drawing; the text is written with it.
    const removed = await put(uid, base(4, { ...texts, drawingIds: [breast2, imageId, thyroidId], removeDrawing: thyroidId }));
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(removed.body.snapshot.drawings, [breast2, imageId]);
    assert.equal(removed.body.drawn.removed, thyroidId);

    // ── reads before any version: my draft's drawings for me; a drawing removed before a version for nobody ──
    const mine = await read(uid);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.deepEqual(mine.body.head, []);
    assert.deepEqual(mine.body.draft.drawings.map(d => d.id), [breast2, imageId]);
    assert.equal((await read(uid, '/' + breast2)).status, 200);
    assert.equal((await read(uid, '/' + breast2)).body.png, breast.png);
    assert.equal((await read(uid, '/' + thyroidId)).status, 404, 'removed before any version: not served to its author');
    assert.equal((await read(uid, '/' + breastId)).status, 404, 'replaced before any version: not served');
    assert.equal((await read(uid, '/' + breast2, second.token)).status, 404, 'another reader does not read my draft');
    assert.equal((await read(other.uid, '/' + breast2)).status, 404, 'never through another study');

    // ── a failed signing keeps no version and the draft with its drawings ──
    const approve = { ...base(5, texts), drawingIds: [breast2, imageId], action: 'approve' };
    await witness.$executeRaw`UPDATE emr_signing.doctor_key SET status='suspended'`;
    try { assert.equal((await commit(uid, approve)).status, 503); }
    finally { await witness.$executeRaw`UPDATE emr_signing.doctor_key SET status='active'`; }
    assert.equal(await witness.reportVersion.count({ where: { uid } }), 0);
    const kept = await witness.reportDraft.findUnique({ where: { uid_author: { uid, author } } });
    assert.equal(kept.present, true); assert.deepEqual(kept.drawings.ids, [breast2, imageId]);

    // ── approve: the version holds them, the signature names each by the server's hash ──
    const approved = await commit(uid, approve);
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    const v1 = await witness.reportVersion.findUnique({ where: { uid_version: { uid, version: approved.body.state.version } } });
    const hashes = Object.fromEntries((await witness.reportDrawing.findMany({ where: { id: { in: [breast2, imageId] } } })).map(r => [r.id, r.sha256]));
    assert.deepEqual(v1.drawings.map(d => [d.id, d.sha256]), [[breast2, hashes[breast2]], [imageId, hashes[imageId]]]);
    const verify = product('emr-signature/server-verification').verifyRegisteredServerEnvelope;
    const signed = verify(approved.body.signature.envelope, approved.body.signature.keyAtSigning).payload;
    assert.deepEqual(signed.attachments, [breast2, imageId].map(id => ({ kind: 'report-evidence', recordId: id, versionId: '1', sha256: hashes[id] })));
    assert.deepEqual(JSON.parse(signed.text.body).drawings.map(d => d.id), [breast2, imageId]);
    // Another reader of the report reads a version's drawing; History names them.
    assert.equal((await read(uid, '/' + imageId, second.token)).status, 200);
    const history = await call('GET', uid, '/report/versions', undefined, second.token);
    assert.deepEqual(history.body[0].drawings.map(d => d.id), [breast2, imageId]);

    // ── an amendment that only removes a drawing is a change; the same again is not ──
    const draftAgain = await put(uid, { ...base(6, texts), baseVersion: v1.version, drawingIds: [], removeDrawing: imageId });
    assert.equal(draftAgain.status, 200, JSON.stringify(draftAgain.body));
    assert.deepEqual(draftAgain.body.snapshot.drawings, [breast2]);
    const amended = await commit(uid, { ...base(7, texts), baseVersion: v1.version, drawingIds: [breast2], action: 'amend' });
    assert.equal(amended.status, 201, JSON.stringify(amended.body));
    const v2 = await witness.reportVersion.findUnique({ where: { uid_version: { uid, version: amended.body.state.version } } });
    assert.deepEqual(v2.drawings.map(d => d.id), [breast2]);
    const amendSigned = verify(amended.body.signature.envelope, amended.body.signature.keyAtSigning).payload;
    assert.deepEqual(amendSigned.attachments.map(a => a.recordId), [breast2]);
    const unchanged = await commit(uid, { ...base(8, texts), baseVersion: v2.version, action: 'amend' });
    assert.equal(unchanged.status, 400); assert.match(unchanged.body.message, /고친 내용이 없습니다/);
    // The removed drawing does not come back: an Addendum carries the head's drawings only.
    const addendum = await commit(uid, { ...base(8, { ...texts, findings: texts.findings + '\n합성 추가기재' }), baseVersion: v2.version, action: 'addendum' });
    assert.equal(addendum.status, 201, JSON.stringify(addendum.body));
    const v3 = await witness.reportVersion.findUnique({ where: { uid_version: { uid, version: addendum.body.state.version } } });
    assert.deepEqual(v3.drawings.map(d => d.id), [breast2]);
    // A version held it, so it is still read (History of v1), by its author and others.
    assert.equal((await read(uid, '/' + imageId, second.token)).status, 200);

    // ── reset: the head holds none, the discarded copy keeps them; a later save does not revive them ──
    const reset = await commit(uid, { ...base(9), baseVersion: v3.version, action: 'reset', reason: '합성 정정' });
    assert.equal(reset.status, 201, JSON.stringify(reset.body));
    const after = await witness.reportVersion.findMany({ where: { uid }, orderBy: { version: 'asc' } });
    const [copy, head] = after.slice(-2);
    assert.equal(copy.action, 'discarded'); assert.deepEqual(copy.drawings.map(d => d.id), [breast2]);
    assert.equal(head.action, 'reset'); assert.equal(head.drawings, null);
    assert.deepEqual((await read(uid)).body.head, []);
    const saved = await commit(uid, { ...base(10, texts), baseVersion: head.version, action: 'save' });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal((await witness.reportVersion.findUnique({ where: { uid_version: { uid, version: saved.body.state.version } } })).drawings, null);

    // ── a report whose head holds a drawing and no text: removing its last drawing is kept as the draft and amended ──
    const lone = await witness.studyState.create({ data: { uid: '1.2.840.9999.140', institutionId: institution, ss: 'Verified' } });
    const loneBase = (revision, extra = {}) => ({ ...base(revision, extra), expectedRevision: lone.draftEpoch + ':' + revision });
    const loneAttach = await put(lone.uid, loneBase(0, { drawing: breast }));
    assert.equal(loneAttach.status, 200, JSON.stringify(loneAttach.body));
    const loneId = loneAttach.body.drawn.added;
    const loneApproved = await commit(lone.uid, { ...loneBase(1), drawingIds: [loneId], action: 'approve' });
    assert.equal(loneApproved.status, 201, JSON.stringify(loneApproved.body));
    const loneRemoved = await put(lone.uid, { ...loneBase(2), baseVersion: loneApproved.body.state.version, drawingIds: [], removeDrawing: loneId });
    assert.equal(loneRemoved.status, 200, JSON.stringify(loneRemoved.body));
    assert.equal(loneRemoved.body.present, true, 'the removal is the draft');
    assert.deepEqual(loneRemoved.body.snapshot.drawings, []);
    assert.deepEqual((await read(lone.uid)).body.draft.drawings, []);
    // A write of the same empty text naming that empty list keeps it; one naming nothing would discard unseen work: refused.
    assert.equal((await put(lone.uid, { ...loneBase(3), baseVersion: loneApproved.body.state.version })).status, 409);
    const loneAmended = await commit(lone.uid, { ...loneBase(3), baseVersion: loneApproved.body.state.version, drawingIds: [], action: 'amend' });
    assert.equal(loneAmended.status, 201, JSON.stringify(loneAmended.body));
    const loneRows = await witness.reportVersion.findMany({ where: { uid: lone.uid }, orderBy: { version: 'asc' } });
    assert.deepEqual(loneRows.map(r => [r.action, (r.drawings || []).map(d => d.id)]), [['approve', [loneId]], ['amend', []]]);
    // ── the fixed version chain (versions with and without drawings) still verifies ──
    const { loadFixedVersions } = product('emr-audit/fixed-versions');
    const listing = await witness.$transaction(tx => loadFixedVersions(tx, uid, 'report'));
    assert.ok(listing, 'the chain loads');

    // ── a study without drawings signs exactly as before (no drawings key in the signed body) ──
    const plain = await witness.studyState.create({ data: { uid: '1.2.840.9999.139', institutionId: institution, ss: 'Verified' } });
    const plainDraft = await put(plain.uid, { ...base(0, texts), expectedRevision: plain.draftEpoch + ':0' });
    assert.equal(plainDraft.status, 200, JSON.stringify(plainDraft.body));
    assert.equal('drawings' in plainDraft.body.snapshot, false);
    const plainApproved = await commit(plain.uid, { ...base(1, texts), expectedRevision: plainDraft.body.revision, action: 'approve' });
    assert.equal(plainApproved.status, 201, JSON.stringify(plainApproved.body));
    const plainSigned = verify(plainApproved.body.signature.envelope, plainApproved.body.signature.keyAtSigning).payload;
    assert.deepEqual(plainSigned.attachments, []);
    assert.equal('drawings' in JSON.parse(plainSigned.text.body), false);
    // Its next version names the previous one by the hash of the row as it was signed (no drawings key), and the fixed
    // version listing of that chain verifies.
    const plainAmended = await commit(plain.uid, { ...base(2, { ...texts, conclusion: texts.conclusion + ' 수정' }),
      expectedRevision: plainApproved.body.revision, baseVersion: plainApproved.body.state.version, action: 'amend' });
    assert.equal(plainAmended.status, 201, JSON.stringify(plainAmended.body));
    const plainFirst = await witness.reportVersion.findUnique({ where: { uid_version: { uid: plain.uid, version: plainApproved.body.state.version } } });
    const { drawings: _none, ...asSigned } = plainFirst;
    const plainAmendSigned = verify(plainAmended.body.signature.envelope, plainAmended.body.signature.keyAtSigning).payload;
    assert.equal(plainAmendSigned.previousVersion.sha256, require('node:crypto').createHash('sha256').update(JSON.stringify(asSigned)).digest('hex'));
    assert.ok(await witness.$transaction(tx => loadFixedVersions(tx, plain.uid, 'report')));
  } finally {
    if (app) await app.close();
    await witness.$disconnect();
    if (ready) await runtime.stop?.();
    provider.close();
  }
});
