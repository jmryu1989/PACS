import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalPayload, inspectSignatureEnvelope, SignatureEnvelope, SignaturePayload } from '../emr-contract/signature';
import { choice, freeze, object, refuse, string, utc } from '../emr-contract/validation';
import type { ServerPublicKey, ServerKeyRegistration, VerifiedServerEnvelope } from './server-contract';

/**
 * Public-only v1 verification. Callers load retained key evidence, not the current replacement key. This does not
 * establish doctor authorization/status or dereference attachments; those checks belong to the accepted read port.
 */
export function verifyServerEnvelope(input: unknown, registeredKey: ServerPublicKey,
  expectedPayload?: SignaturePayload): Readonly<VerifiedServerEnvelope> {
  const inspected = inspectSignatureEnvelope(input);
  const registration = object(registeredKey, ['kid', 'publicKey']);
  if (string(registration.kid) !== inspected.keyId) refuse('ServerSignatureKeyMismatch');
  const jwk = object(registration.publicKey, ['kty', 'crv', 'x', 'y']);
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') refuse('ServerSignaturePublicKeyRequired');
  for (const coordinate of [jwk.x, jwk.y]) {
    const bytes = Buffer.from(string(coordinate), 'base64url');
    if (bytes.length !== 32 || bytes.toString('base64url') !== coordinate) refuse('ServerSignaturePublicKeyRequired');
  }
  const key = createPublicKey({ key: { ...jwk }, format: 'jwk' });
  const envelope = input as SignatureEnvelope;
  if (!verify('sha256', Buffer.from(envelope.protected + '.' + envelope.payload, 'ascii'),
    { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(envelope.signature, 'base64url'))) refuse('ServerSignatureIntegrityInvalid');
  if (expectedPayload !== undefined && !inspected.payloadBytes.equals(canonicalPayload(expectedPayload)))
    refuse('ServerSignatureContentMismatch');
  const payload: SignaturePayload = JSON.parse(inspected.payloadBytes.toString('utf8'));
  return freeze({ kid: inspected.keyId, payload, envelope: { ...envelope }, integrity: 'valid' as const,
    versionSha256: createHash('sha256').update(inspected.payloadBytes).digest('hex'), signedAt: payload.serverTime });
}

/** Historical public evidence, independent of current membership, private keys and wrapping secrets. */
export function verifyRegisteredServerEnvelope(input: unknown, registration: ServerKeyRegistration) {
  const verified = verifyServerEnvelope(input, { kid: registration.kid, publicKey: registration.publicKey });
  const p = verified.payload, doctor = registration.doctor;
  utc(registration.registeredAt);
  choice(registration.status, ['active', 'suspended', 'revoked']);
  if (registration.endedAt !== null) utc(registration.endedAt);
  if (!doctor.canSign || (registration.status !== 'active' && registration.endedAt === null)) refuse('ServerSignatureStatusUnverifiable');
  if (p.signer.id !== doctor.identity.id || p.signer.issuer !== doctor.identity.issuer || p.signer.subject !== doctor.identity.subject ||
      p.identityRegistrationId !== doctor.identityRegistrationId || p.actingInstitutionId !== doctor.institutionId)
    refuse('ServerSignatureRegistrationMismatch');
  // Evidence captured in the committed approval is active at its signing instant. Later status is separate.
  if (p.serverTime < registration.registeredAt || (registration.endedAt !== null && p.serverTime >= registration.endedAt))
    refuse('ServerSignatureKeyInactiveAtSigning');
  return freeze({ ...verified, registeredIdentity: 'matched' as const, keyAtSigningTime: 'active' as const });
}
