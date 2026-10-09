import { createHash, createPublicKey, verify as verifyBytes } from 'node:crypto';
import { inspectSignatureEnvelope } from '../emr-contract/signature';
import { freeze, object, refuse, string } from '../emr-contract/validation';
import type { VerifiedSignatureV2 } from './contract';
import { inspectEnvelopeV2 } from './canonical-v2';
import { KeyPolicy, KeyReader, KeyRegistration, keyStatusAt, loadKey } from './keys';
import { AnchorReader, TimePolicy, evaluateTimeBasis } from './time-basis';

/** Server-bound readers and reviewed policies; C2 composes them once from storage, never per request. */
export interface SignatureVerificationPorts { keys: KeyReader; keyPolicy: KeyPolicy; anchors: AnchorReader; timePolicy: TimePolicy }

function es256(reg: KeyRegistration, protectedB64: string, payloadB64: string, signature: Buffer): boolean {
  const key = createPublicKey({ key: { ...reg.publicKey }, format: 'jwk' });
  return verifyBytes('sha256', Buffer.from(protectedB64 + '.' + payloadB64, 'ascii'), { key, dsaEncoding: 'ieee-p1363' }, signature);
}

function sameSigner(reg: KeyRegistration, signer: { id: string; issuer: string; subject: string }, registrationId: string): boolean {
  return reg.identity.id === signer.id && reg.identity.issuer === signer.issuer && reg.identity.subject === signer.subject &&
    reg.identityRegistrationId === registrationId;
}

/** Active over the whole uncertainty interval, not just at one end of it. */
function activeThroughout(reg: KeyRegistration, earliest: string, latest: string): boolean {
  return keyStatusAt(reg, earliest) === 'active' && !reg.history.some(h => h.effectiveAt > earliest && h.effectiveAt <= latest && h.status !== 'active');
}

const verifiedV2 = new WeakSet<object>();
/**
 * Cryptographic and registration verification of a v2 signature. Refuses on any integrity, key or identity mismatch;
 * returns the time evaluation separately so that a held time keeps the original without accepting it as normal.
 */
export function verifySignatureV2(envelope: unknown, ports: SignatureVerificationPorts, context: { osUserId: string }): Readonly<VerifiedSignatureV2> {
  const env = inspectEnvelopeV2(envelope);
  const c = object(context, ['osUserId']);
  const reg = loadKey(ports.keys, env.kid, ports.keyPolicy), p = env.payload;
  if (reg.deviceId !== p.deviceId) refuse('KeyDeviceRefused');
  if (string(c.osUserId) !== reg.osUserId) refuse('KeyOsUserRefused');
  if (!sameSigner(reg, p.signer, p.identityRegistrationId)) refuse('SignerIdentityRefused');
  const e = envelope as { protected: string; payload: string };
  if (!es256(reg, e.protected, e.payload, env.signature)) refuse('SignatureIntegrityRefused');
  const time = evaluateTimeBasis(p.timeBasis, p.signedAt, p.deviceId, ports.anchors, ports.timePolicy);
  const keyAtSigningTime = time.status !== 'verified' ? 'unverifiable' :
    activeThroughout(reg, time.interval.earliest, time.interval.latest) ? 'active' : 'inactive';
  const result = freeze({ kid: env.kid, payload: p, payloadBase64url: e.payload, versionSha256: createHash('sha256').update(env.payloadBytes).digest('hex'),
    integrity: 'valid' as const, registeredIdentity: 'matched' as const, keyAtSigningTime, time, osUserId: c.osUserId }) as Readonly<VerifiedSignatureV2>;
  verifiedV2.add(result);
  return result;
}
/** Only results produced above count; a deserialised or hand-built verdict is not a verification. */
export function requireVerifiedV2(input: VerifiedSignatureV2): Readonly<VerifiedSignatureV2> {
  if (!input || !verifiedV2.has(input)) refuse('VerifiedSignatureRequired');
  return input;
}

/** v1 keeps its exact bytes and server-time semantics; this adds the ES256 check A deferred to C. */
export function verifySignatureV1(envelope: unknown, keys: KeyReader, keyPolicy: KeyPolicy): Readonly<{
  kid: string; payloadBase64url: string; integrity: 'valid'; registeredIdentity: 'matched'; keyAtSigningTime: 'active' | 'inactive';
}> {
  const { keyId, payloadBytes } = inspectSignatureEnvelope(envelope);
  const reg = loadKey(keys, keyId, keyPolicy), payload = JSON.parse(payloadBytes.toString('utf8'));
  if (!sameSigner(reg, payload.signer, payload.identityRegistrationId)) refuse('SignerIdentityRefused');
  const e = envelope as { protected: string; payload: string; signature: string };
  if (!es256(reg, e.protected, e.payload, Buffer.from(e.signature, 'base64url'))) refuse('SignatureIntegrityRefused');
  return freeze({ kid: keyId, payloadBase64url: e.payload, integrity: 'valid' as const, registeredIdentity: 'matched' as const,
    keyAtSigningTime: keyStatusAt(reg, payload.serverTime) === 'active' ? 'active' as const : 'inactive' as const });
}
