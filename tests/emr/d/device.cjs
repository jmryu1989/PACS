'use strict';
/* EMR-D round 2 test-only device (tests/emr/d/server_test.cjs and the live driver tests/emr/d/live_driver.cjs).
 *
 * A stand-in for the author's registered device and C's storage readers: P-256 keys registered through C's own
 * registerDeviceKey with the explicit test key policy (acceptedEvidence ['test-software'], never a product value), server
 * time anchors, and v2 envelopes over a signing request through C's canonicalPayloadV2/protectedHeaderV2 - the exact bytes
 * a device would sign. `K` and `CV` are C's compiled keys and canonical-v2 modules of the code under test.
 * Synthetic data only; nothing here is a product key, anchor, epsilon or policy.
 */
const crypto = require('node:crypto');

const HOUR = 3600000;
const plus = (at, ms) => new Date(Date.parse(at) + ms).toISOString();

module.exports = function device({ K, CV }) {
  const keyRows = new Map(), privateKeys = new Map(), anchorRows = new Map(), exported = new Map();
  const keys = { load: kid => keyRows.get(kid) ?? null,
    holderOf: thumbprint => [...keyRows.values()].find(r => K.jwkThumbprint(r.publicKey) === thumbprint)?.kid ?? null };
  const keyPolicy = Object.freeze({ acceptedEvidence: ['test-software'] });
  const timePolicy = Object.freeze({ epsilonMs: 2000, reviewRef: 'test-only:not-a-product-value' });
  const anchors = { load: id => anchorRows.get(id) ?? null };
  const ports = { keys, keyPolicy, anchors, timePolicy };
  let counter = 0;

  /**
   * Register a device key of a verified clinician (identity, registration, institution) as C's registration does. With
   * `privateJwk` the same key is registered again in a later process (a restart re-verifies earlier signatures).
   */
  function register(identity, identityRegistrationId, institutionId, { kid = 'kid-' + identity.id, deviceId = 'dev-' + identity.id,
    osUserId = 'os-' + identity.id, at = '2026-09-01T00:00:00.000Z', revokedAt = null, privateJwk = null } = {}) {
    const privateKey = privateJwk ? crypto.createPrivateKey({ key: privateJwk, format: 'jwk' }) : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
    exported.set(kid, { identity, identityRegistrationId, institutionId, kid, deviceId, osUserId, at, revokedAt, privateJwk: privateKey.export({ format: 'jwk' }) });
    let reg = K.registerDeviceKey({ kid, deviceId, osUserId, publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
      evidence: { kind: 'test-software', evidenceId: 'evidence-' + kid }, at, actorId: 'registrar-synthetic' },
    { identity, identityRegistrationId, institutionId, canSign: true, verifiedAt: at }, keyPolicy, keys);
    if (revokedAt) reg = K.revokeKey(reg, { at: revokedAt, reason: 'synthetic revocation', actorId: 'registrar-synthetic' }, keyPolicy);
    keyRows.set(kid, reg); privateKeys.set(kid, privateKey);
    return { kid, deviceId, osUserId };
  }

  /** The time evidence a device records: anchored by the server one hour before, same boot unless told otherwise. */
  function basis(signedAt, deviceId, { boot = 'boot-1', signBoot = boot, wall = [], registerAnchor = true } = {}) {
    const anchorId = 'anchor-' + crypto.randomUUID(), serverTime = plus(signedAt, -HOUR), validUntil = plus(serverTime, 48 * HOUR);
    if (registerAnchor) anchorRows.set(anchorId, { anchorId, deviceId, bootId: boot, serverTime, validUntil });
    return { anchorId, anchorServerTime: serverTime, anchorValidUntil: validUntil, anchorBootId: boot, anchorTickMs: 5000, signBootId: signBoot,
      signTickMs: 5000 + HOUR, wallClockEvents: wall, interval: { earliest: plus(signedAt, -timePolicy.epsilonMs), latest: plus(signedAt, timePolicy.epsilonMs) } };
  }

  /**
   * The device's v2 signature over one signing request (records.ts SigningRequest), with the write's request ID as event.
   * `change` alters the signed payload afterwards (an altered text, another version, a grant...) to model a mismatch.
   */
  function sign(request, { kid, eventId, signedAt = new Date().toISOString(), timeBasis = null, change = null, signWith = kid }) {
    const reg = keyRows.get(kid);
    const body = request.content.kind === 'text' ? request.content.body
      : JSON.stringify({ sha256: request.content.sha256, sopInstanceUid: request.content.sopInstanceUid });
    let payload = { formatVersion: 'emr-signature/2', text: { kind: 'clinical-entry', body }, patient: { ...request.patient },
      managingInstitutionId: request.managingInstitutionId, actingInstitutionId: request.actingInstitutionId, studyId: request.studyId,
      recordKind: request.recordKind, recordId: request.recordId, versionId: request.versionId, previousVersion: request.previousVersion,
      attachments: [...request.attachments], author: { ...request.author }, signer: { ...request.signer }, identityRegistrationId: request.identityRegistrationId,
      action: request.action, reason: request.reason, eventId, deviceId: reg.deviceId, kid: reg.kid, grant: null, claimGeneration: 0, draftRevision: null,
      deviceSequence: ++counter, predecessorEventId: null, signedAt, timeBasis: timeBasis ?? basis(signedAt, reg.deviceId) };
    if (change) payload = change(payload);
    const header = CV.protectedHeaderV2(payload.kid).toString('base64url'), bytes = CV.canonicalPayloadV2(payload).toString('base64url');
    const signature = crypto.sign('sha256', Buffer.from(header + '.' + bytes), { key: privateKeys.get(signWith), dsaEncoding: 'ieee-p1363' });
    return { jws: { protected: header, payload: bytes, signature: signature.toString('base64url') }, osUserId: reg.osUserId };
  }

  /** Keys and anchors as JSON for a later process; `restore` registers them again with the same key material. */
  const save = () => ({ keys: [...exported.values()], anchors: [...anchorRows.values()] });
  function restore(saved) {
    for (const k of saved.keys) register(k.identity, k.identityRegistrationId, k.institutionId, k);
    for (const a of saved.anchors) anchorRows.set(a.anchorId, a);
  }

  return { ports, register, basis, sign, keyRows, save, restore };
};
