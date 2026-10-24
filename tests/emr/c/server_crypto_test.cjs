/*
 * C2-L4/L5/L8 -> wrong signed version, false time, unreadable restored key -> T-BIND/T-TIME/T-KEY.
 * These tests exercise the production crypto boundary, with real Node keys and an independent JOSE verifier.
 * Exact v1 bytes are a compatibility requirement; no implementation text or page composition is asserted.
 * This is pre-B2 evidence only: no claim of PG atomicity, current authority, durable custody or served UI acceptance.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const api = path.resolve(__dirname, '../../../api');
const ts = require(path.join(api, 'node_modules/typescript'));
const jose = require(path.join(api, 'node_modules/jose'));
const config = ts.readConfigFile(path.join(api, 'tsconfig.json'), ts.sys.readFile);
assert.equal(config.error, undefined);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, api);
const previousLoader = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
  { compilerOptions: parsed.options, fileName: filename }).outputText, filename);
const S = require(path.join(api, 'src/emr-contract/signature.ts'));
const C = require(path.join(api, 'src/emr-signature/server-crypto.ts'));
const V = require(path.join(api, 'src/emr-signature/server-verification.ts'));
if (previousLoader) require.extensions['.ts'] = previousLoader; else delete require.extensions['.ts'];

const clone = value => JSON.parse(JSON.stringify(value));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const identity = id => ({ id, issuer: 'https://synthetic.example.test', subject: 'subject-' + id });
const content = () => ({
  formatVersion: 'emr-signature/1',
  text: { kind: 'report', findings: '  한글\r\n두 번째 줄\n\te\u0301 / é / 🩻  ', conclusion: '결론\n', recommendation: '숨겨진 Recommendation\r\n추적 관찰  ' },
  patient: { linkId: 'link-1', patientId: 'synthetic-patient-1', assigningAuthority: 'hospital-1' },
  studyId: '1.2.840.99999.1', managingInstitutionId: 'hospital-1', actingInstitutionId: 'hospital-1',
  recordKind: 'report-version', recordId: 'report-1', versionId: 'report-1-v1',
  author: identity('doctor-1'), signer: identity('doctor-1'), identityRegistrationId: 'registration-1',
  action: 'approve-sign', previousVersion: null,
  attachments: [{ kind: 'report-evidence', recordId: 'evidence-1', versionId: 'evidence-1-v1', sha256: sha('synthetic fixed evidence') }],
  reason: null,
});
const key = (kid = 'doctor-key-1') => ({ kid, ...C.generateServerKeyPair() });
const publicPart = k => ({ kid: k.kid, publicKey: k.publicKey });
const sign = (k, c = content()) => C.signServerPayload(c, k.kid, k.privateKey);
const unpack = result => JSON.parse(Buffer.from(result.envelope.payload, 'base64url').toString('utf8'));

test('T-BIND exact v1 Korean, newline, Unicode and hidden Recommendation bytes verify independently', async () => {
  const k = key(), input = content(), result = sign(k, input), payload = unpack(result);
  assert.deepEqual(payload.text, input.text);
  const expectedBytes = S.canonicalPayload({ ...input, serverTime: result.signedAt });
  assert.deepEqual(Buffer.from(result.envelope.payload, 'base64url'), expectedBytes);
  const independentKey = await jose.importJWK(k.publicKey, 'ES256');
  const verified = await jose.compactVerify(Object.values(result.envelope).join('.'), independentKey,
    { algorithms: ['ES256'] });
  assert.deepEqual(Buffer.from(verified.payload), expectedBytes);
  assert.deepEqual(verified.protectedHeader, { alg: 'ES256', kid: k.kid, typ: 'emr-signature+jws' });
  assert.equal(Buffer.from(result.envelope.signature, 'base64url').length, 64);
  assert.equal(result.versionSha256, sha(expectedBytes));
  const read = V.verifyServerEnvelope(result.envelope, publicPart(k), payload);
  assert.equal(read.integrity, 'valid');
  assert.equal(read.versionSha256, result.versionSha256);
  assert.deepEqual(read.envelope, result.envelope);
  assert.equal(Object.hasOwn(read, 'registeredIdentity'), false);
  assert.equal(Object.hasOwn(read, 'keyAtSigningTime'), false);
});

test('T-BIND an accidentally paired content or context is refused for every signed binding', () => {
  const k = key(), result = sign(k), payload = unpack(result);
  const changes = [
    p => { p.text.findings += '추가'; }, p => { p.text.conclusion += '추가'; }, p => { p.text.recommendation = ''; },
    p => { p.text.findings = p.text.findings.normalize('NFC'); }, p => { p.text.findings = p.text.findings.replace(/\r\n/g, '\n'); },
    p => { p.patient.linkId = 'link-2'; }, p => { p.patient.patientId = 'synthetic-patient-2'; },
    p => { p.patient.assigningAuthority = 'hospital-2'; }, p => { p.studyId = '1.2.840.99999.2'; },
    p => { p.managingInstitutionId = 'hospital-2'; }, p => { p.actingInstitutionId = 'hospital-2'; },
    p => { p.recordKind = 'report-head'; }, p => { p.recordId = 'report-2'; }, p => { p.versionId = 'report-1-v2'; },
    p => { p.author = identity('doctor-2'); }, p => { p.signer.id = 'doctor-2'; },
    p => { p.signer.issuer = 'https://other.example.test'; }, p => { p.signer.subject = 'subject-2'; },
    p => { p.identityRegistrationId = 'registration-2'; }, p => { p.action = 'preliminary'; },
    p => { p.serverTime = '2000-01-01T00:00:00.000Z'; }, p => { p.reason = 'another reason'; },
    p => { p.attachments[0].kind = 'report-version'; }, p => { p.attachments[0].recordId = 'evidence-2'; },
    p => { p.attachments[0].versionId = 'evidence-1-v2'; }, p => { p.attachments[0].sha256 = sha('different evidence'); },
    p => { p.attachments = []; },
  ];
  for (const change of changes) {
    const expected = clone(payload); change(expected);
    assert.throws(() => V.verifyServerEnvelope(result.envelope, publicPart(k), expected), { code: 'ServerSignatureContentMismatch' });
    const pairedEnvelope = { ...result.envelope, payload: S.canonicalPayload(expected).toString('base64url') };
    assert.throws(() => V.verifyServerEnvelope(pairedEnvelope, publicPart(k)), { code: 'ServerSignatureIntegrityInvalid' });
  }
});

test('T-BIND wrong key material, kid or signature pairing cannot verify', () => {
  const first = key(), second = key('doctor-key-2'), original = sign(first), other = sign(second);
  assert.throws(() => V.verifyServerEnvelope(original.envelope, publicPart(second)), { code: 'ServerSignatureKeyMismatch' });
  assert.throws(() => V.verifyServerEnvelope(original.envelope, { kid: first.kid, publicKey: second.publicKey }),
    { code: 'ServerSignatureIntegrityInvalid' });
  assert.throws(() => V.verifyServerEnvelope({ ...original.envelope, signature: other.envelope.signature }, publicPart(first)),
    { code: 'ServerSignatureIntegrityInvalid' });
  assert.throws(() => V.verifyServerEnvelope({ ...original.envelope, protected: other.envelope.protected }, publicPart(second)),
    { code: 'ServerSignatureIntegrityInvalid' });
});

test('T-BIND predecessor and attachment order are fixed in revisions without changing the original', () => {
  const k = key(), original = sign(k), originalBytes = JSON.stringify(original);
  for (const action of ['amend', 'addendum', 'cancel', 'supplement-sign']) {
    const revision = content();
    revision.action = action;
    revision.versionId = 'report-1-' + action;
    revision.previousVersion = { recordId: revision.recordId, versionId: 'report-1-v1', sha256: original.versionSha256 };
    revision.reason = action === 'cancel' ? '잘못 연결한 합성 검사' : null;
    revision.attachments.push({ kind: 'report-evidence', recordId: 'evidence-2', versionId: 'evidence-2-v1', sha256: sha('second evidence') });
    const result = sign(k, revision), payload = unpack(result);
    assert.equal(V.verifyServerEnvelope(result.envelope, publicPart(k), payload).integrity, 'valid');
    for (const field of ['versionId', 'sha256']) {
      const wrong = clone(payload);
      wrong.previousVersion[field] = field === 'sha256' ? sha('wrong previous version') : 'report-1-v0';
      assert.throws(() => V.verifyServerEnvelope(result.envelope, publicPart(k), wrong), { code: 'ServerSignatureContentMismatch' });
    }
    const reversed = clone(payload); reversed.attachments.reverse();
    assert.throws(() => V.verifyServerEnvelope(result.envelope, publicPart(k), reversed), { code: 'ServerSignatureContentMismatch' });
    assert.equal(JSON.stringify(original), originalBytes);
  }
});

test('T-BIND existing v1 envelope from independent Node signing stays readable with its original time', () => {
  const k = key();
  // The historic v1 layout is written independently here because byte compatibility is the requirement.
  const payload = {
    formatVersion: 'emr-signature/1', text: { kind: 'report', findings: '과거 원본\r\n', conclusion: '', recommendation: '  보존  ' },
    patient: { linkId: 'link-1', patientId: 'synthetic-patient-1', assigningAuthority: 'hospital-1' },
    studyId: '1.2.840.99999.1', managingInstitutionId: 'hospital-1', actingInstitutionId: 'hospital-1',
    recordKind: 'report-version', recordId: 'report-1', versionId: 'report-1-v1',
    author: identity('doctor-1'), signer: identity('doctor-1'), identityRegistrationId: 'registration-1',
    action: 'approve-sign', serverTime: '2026-01-03T05:06:07.008Z', previousVersion: null, attachments: [], reason: null,
  };
  const protectedHeader = Buffer.from(JSON.stringify({ alg: 'ES256', kid: k.kid, typ: 'emr-signature+jws' })).toString('base64url');
  const historicBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const encoded = historicBytes.toString('base64url');
  const signature = crypto.sign('sha256', Buffer.from(protectedHeader + '.' + encoded),
    { key: k.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const envelope = { protected: protectedHeader, payload: encoded, signature };
  const result = V.verifyServerEnvelope(envelope, publicPart(k), payload);
  assert.equal(result.signedAt, payload.serverTime);
  assert.deepEqual(result.envelope, envelope);
  assert.deepEqual(S.inspectSignatureEnvelope(result.envelope).payloadBytes, historicBytes);
});

test('T-TIME crypto records its own current signing instant and refuses a supplied timestamp', () => {
  const k = key(), before = Date.now(), result = sign(k), after = Date.now();
  assert.ok(Date.parse(result.signedAt) >= before && Date.parse(result.signedAt) <= after);
  assert.equal(unpack(result).serverTime, result.signedAt);
  assert.throws(() => sign(k, { ...content(), serverTime: '2000-01-01T00:00:00.000Z' }), { code: 'ServerSigningTimeIsObserved' });
});

test('T-BIND invalid v1 source text, missing recommendation and invalid revision cannot produce an envelope', () => {
  const k = key();
  for (const edit of [
    p => { p.text.findings = '\ud800'; }, p => { delete p.text.recommendation; },
    p => { p.action = 'cancel'; p.previousVersion = null; }, p => { p.formatVersion = 'emr-signature/2'; },
  ]) {
    const p = content(); edit(p); assert.throws(() => sign(k, p));
  }
});

test('T-BIND clinical text and immutable attachment references preserve the supplied canonical content', () => {
  const k = key(), p = content();
  p.text = { kind: 'clinical-entry', body: '채택된 임상 기재\r\n정규화 추가 없음' };
  p.action = 'record';
  const result = sign(k, p), expected = { ...p, serverTime: result.signedAt };
  assert.deepEqual(V.verifyServerEnvelope(result.envelope, publicPart(k), expected).payload.text, p.text);
  assert.deepEqual(unpack(result).attachments, p.attachments);
  // C binds the reference; real D canonical mapping and dereferenced bytes await D/B2's production adapters.
});

test('T-KEY distinct generated doctor keys round-trip through encrypted PKCS8 and serialized custody rows', () => {
  const first = key(), second = key('doctor-key-2'), secret = crypto.randomBytes(32);
  assert.notDeepEqual(first.publicKey, second.publicKey);
  const row = C.wrapServerPrivateKey(first.privateKey, first.kid, 'wrap-1', secret);
  assert.equal(row.algorithm, 'aes-256-gcm');
  assert.equal(Buffer.from(row.iv, 'base64url').length, 12);
  assert.equal(Buffer.from(row.tag, 'base64url').length, 16);
  const again = C.wrapServerPrivateKey(first.privateKey, first.kid, 'wrap-1', secret);
  assert.notEqual(row.iv, again.iv);
  assert.notEqual(row.ciphertext, again.ciphertext);
  const restored = C.unwrapServerPrivateKey(clone(row), first.kid, 'wrap-1', secret);
  const signed = C.signServerPayload(content(), first.kid, restored);
  assert.equal(V.verifyServerEnvelope(signed.envelope, publicPart(first)).integrity, 'valid');
  assert.equal(JSON.stringify(row).includes(secret.toString('base64url')), false);
  assert.equal(Object.hasOwn(row, 'privateKey'), false);
});

test('T-KEY absent or mismatched wrapping custody cannot restore a signing key', () => {
  const k = key(), secret = crypto.randomBytes(32), row = C.wrapServerPrivateKey(k.privateKey, k.kid, 'wrap-1', secret);
  assert.throws(() => C.unwrapServerPrivateKey(row, k.kid, 'wrap-1', undefined), { code: 'ServerWrappingKeyRequired' });
  assert.throws(() => C.unwrapServerPrivateKey(row, k.kid, 'wrap-1', crypto.randomBytes(32)));
  assert.throws(() => C.unwrapServerPrivateKey(row, 'wrong-kid', 'wrap-1', secret), { code: 'ServerWrappedKeyMismatch' });
  assert.throws(() => C.unwrapServerPrivateKey(row, k.kid, 'wrong-wrap', secret), { code: 'ServerWrappedKeyMismatch' });
  const other = C.wrapServerPrivateKey(k.privateKey, 'another-kid', 'wrap-1', secret);
  assert.throws(() => C.unwrapServerPrivateKey({ ...row, ciphertext: other.ciphertext, iv: other.iv, tag: other.tag }, k.kid, 'wrap-1', secret));
  for (const edit of [
    r => { r.iv = Buffer.alloc(11).toString('base64url'); }, r => { r.tag = Buffer.alloc(15).toString('base64url'); },
    r => { r.ciphertext = r.ciphertext.slice(0, -4); }, r => { r.algorithm = 'unknown'; },
  ]) {
    const broken = clone(row); edit(broken);
    assert.throws(() => C.unwrapServerPrivateKey(broken, k.kid, 'wrap-1', secret));
  }
});

test('T-KEY historical envelope verification requires only retained public bytes after private material is released', () => {
  let k = key();
  const signed = sign(k), retained = clone({ result: signed, key: publicPart(k) });
  k = null;
  const replacement = key('doctor-key-replacement');
  assert.equal(V.verifyServerEnvelope(retained.result.envelope, retained.key).integrity, 'valid');
  assert.throws(() => V.verifyServerEnvelope(retained.result.envelope, publicPart(replacement)), { code: 'ServerSignatureKeyMismatch' });
  assert.deepEqual(V.verifyServerEnvelope(retained.result.envelope, retained.key).envelope, retained.result.envelope);
  const registration = { ...retained.key, doctor: { identity: identity('doctor-1'), identityRegistrationId: 'registration-1',
    institutionId: 'hospital-1', canSign: true }, status: 'active', registeredAt: retained.result.signedAt, endedAt: null };
  assert.equal(V.verifyRegisteredServerEnvelope(retained.result.envelope, registration).keyAtSigningTime, 'active');
  assert.throws(() => V.verifyRegisteredServerEnvelope(retained.result.envelope, { ...registration, registeredAt: null }));
  assert.throws(() => V.verifyRegisteredServerEnvelope(retained.result.envelope, { ...registration, status: 'revoked' }),
    { code: 'ServerSignatureStatusUnverifiable' });
  assert.throws(() => V.verifyRegisteredServerEnvelope(retained.result.envelope,
    { ...registration, doctor: { ...registration.doctor, canSign: false } }), { code: 'ServerSignatureStatusUnverifiable' });
});

test('T-KEY unsupported curve and public-only keys cannot be used for server signing or wrapping', () => {
  const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const p256 = key();
  for (const bad of [p384.privateKey, p384.publicKey, crypto.createPublicKey({ key: p256.publicKey, format: 'jwk' })]) {
    assert.throws(() => C.signServerPayload(content(), p256.kid, bad), { code: 'ServerSigningKeyRequired' });
    assert.throws(() => C.wrapServerPrivateKey(bad, p256.kid, 'wrap-1', crypto.randomBytes(32)), { code: 'ServerSigningKeyRequired' });
  }
  assert.throws(() => C.wrapServerPrivateKey(p256.privateKey, p256.kid, 'wrap-1', crypto.randomBytes(16)), { code: 'ServerWrappingKeyRequired' });
  assert.throws(() => V.verifyServerEnvelope(sign(p256).envelope,
    { kid: p256.kid, publicKey: p384.publicKey.export({ format: 'jwk' }) }), { code: 'ServerSignaturePublicKeyRequired' });
});
