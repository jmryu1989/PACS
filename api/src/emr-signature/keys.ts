import { ImmutableIdentity, identity } from '../emr-contract/access-event';
import { KeyStatus, transitionSigningKey } from '../emr-contract/lawful-defaults';
import { choice, freeze, object, refuse, string, utc } from '../emr-contract/validation';
import { base64url } from './canonical-v2';

/**
 * Device keys: one non-exportable key per clinician and managed device, registered online against a verified identity.
 * The server never copies a key and the browser never receives one. History is append-only: a later revocation never
 * invalidates a signature made while the key was active, but no new signature is accepted after it takes effect.
 */
export type KeyEvidenceKind = 'tpm-nonexportable' | 'test-software';
/** Which key evidence the verifier accepts. No default: production lists only TPM evidence, tests name theirs. */
export interface KeyPolicy { acceptedEvidence: readonly KeyEvidenceKind[] }
export function requireKeyPolicy(input: unknown): Readonly<KeyPolicy> {
  let p: Record<string, any>;
  try { p = object(input, ['acceptedEvidence']); } catch { refuse('KeyPolicyRequired'); }
  if (!Array.isArray(p.acceptedEvidence) || !p.acceptedEvidence.length || new Set(p.acceptedEvidence).size !== p.acceptedEvidence.length)
    refuse('KeyPolicyRequired');
  return freeze({ acceptedEvidence: p.acceptedEvidence.map(k => choice(k, ['tpm-nonexportable', 'test-software'])) });
}

export interface PublicKeyJwk { kty: 'EC'; crv: 'P-256'; x: string; y: string }
export interface KeyHistoryEntry { status: KeyStatus; effectiveAt: string; reason: string; actorIds: readonly string[] }
export interface KeyRegistration {
  kid: string; deviceId: string; osUserId: string; publicKey: PublicKeyJwk;
  identity: ImmutableIdentity; identityRegistrationId: string; institutionId: string;
  evidence: { kind: KeyEvidenceKind; evidenceId: string };
  history: readonly KeyHistoryEntry[];
  supersedes: string | null;
}
export interface KeyReader { load(kid: string): unknown }

/** B2-verified clinician facts at registration/recovery time; never taken from the request body. */
export interface VerifiedClinician {
  identity: ImmutableIdentity; identityRegistrationId: string; institutionId: string; canSign: boolean; verifiedAt: string;
}
export function parseVerifiedClinician(input: unknown): Readonly<VerifiedClinician> {
  const v = object(input, ['identity', 'identityRegistrationId', 'institutionId', 'canSign', 'verifiedAt']);
  if (typeof v.canSign !== 'boolean') throw new Error('Signing authority fact required');
  return freeze({ identity: identity(v.identity), identityRegistrationId: string(v.identityRegistrationId), institutionId: string(v.institutionId),
    canSign: v.canSign, verifiedAt: utc(v.verifiedAt) });
}

function publicKey(input: unknown): PublicKeyJwk {
  const k = object(input, ['kty', 'crv', 'x', 'y']);
  if (k.kty !== 'EC' || k.crv !== 'P-256' || base64url(k.x).length !== 32 || base64url(k.y).length !== 32) throw new Error('P-256 public key required');
  return { kty: 'EC', crv: 'P-256', x: k.x, y: k.y };
}

export function parseKeyRegistration(input: unknown, policyInput: KeyPolicy): Readonly<KeyRegistration> {
  const policy = requireKeyPolicy(policyInput);
  const v = object(input, ['kid', 'deviceId', 'osUserId', 'publicKey', 'identity', 'identityRegistrationId', 'institutionId', 'evidence', 'history', 'supersedes']);
  const e = object(v.evidence, ['kind', 'evidenceId']);
  const kind = choice(e.kind, ['tpm-nonexportable', 'test-software']);
  // A test key must never pass as a device key where the policy does not name it.
  if (!policy.acceptedEvidence.includes(kind)) refuse('KeyEvidenceRefused');
  if (!Array.isArray(v.history) || !v.history.length) throw new Error('Key history required');
  const history = v.history.map(h => {
    const x = object(h, ['status', 'effectiveAt', 'reason', 'actorIds']);
    if (!Array.isArray(x.actorIds) || !x.actorIds.length) throw new Error('Key history actors required');
    return { status: choice(x.status, ['active', 'suspended', 'revoked', 'retired']), effectiveAt: utc(x.effectiveAt), reason: string(x.reason),
      actorIds: x.actorIds.map(a => string(a)) };
  });
  if (history[0].status !== 'active') throw new Error('Registration starts active');
  history.forEach((h, i) => {
    if (!i) return;
    const before = history[i - 1];
    if (h.effectiveAt < before.effectiveAt || ['revoked', 'retired'].includes(before.status) && h.status !== 'revoked')
      throw new Error('Terminal key cannot be reactivated');
  });
  return freeze({ kid: string(v.kid), deviceId: string(v.deviceId), osUserId: string(v.osUserId), publicKey: publicKey(v.publicKey),
    identity: identity(v.identity), identityRegistrationId: string(v.identityRegistrationId), institutionId: string(v.institutionId),
    evidence: { kind, evidenceId: string(e.evidenceId) }, history, supersedes: v.supersedes === null ? null : string(v.supersedes) });
}

export function loadKey(reader: KeyReader, kid: string, policy: KeyPolicy): Readonly<KeyRegistration> {
  let raw: unknown;
  try { raw = reader.load(string(kid)); } catch { refuse('KeyUnknown'); }
  if (!raw) refuse('KeyUnknown');
  const reg = parseKeyRegistration(raw, policy);
  if (reg.kid !== kid) refuse('KeyUnknown');
  return reg;
}

export function keyStatusAt(reg: KeyRegistration, at: string): KeyStatus | 'not-registered' {
  utc(at);
  const applicable = reg.history.filter(h => h.effectiveAt <= at);
  return applicable.length ? applicable[applicable.length - 1].status : 'not-registered';
}

export interface DeviceKeyRequest {
  kid: string; deviceId: string; osUserId: string; publicKey: PublicKeyJwk; evidence: { kind: KeyEvidenceKind; evidenceId: string }; at: string; actorId: string;
}
/** Online registration binds the verified clinician, institution and managed device user to a new kid. */
export function registerDeviceKey(request: DeviceKeyRequest, clinician: VerifiedClinician, policy: KeyPolicy, existing: KeyReader): Readonly<KeyRegistration> {
  const r = object(request, ['kid', 'deviceId', 'osUserId', 'publicKey', 'evidence', 'at', 'actorId']);
  const who = parseVerifiedClinician(clinician);
  if (!who.canSign) refuse('SigningAuthorityRequired');
  let used: unknown = null;
  try { used = existing.load(string(r.kid)); } catch { used = null; }
  if (used) refuse('KeyIdReused');
  return parseKeyRegistration({ kid: r.kid, deviceId: r.deviceId, osUserId: r.osUserId, publicKey: r.publicKey, identity: { ...who.identity },
    identityRegistrationId: who.identityRegistrationId, institutionId: who.institutionId, evidence: r.evidence,
    history: [{ status: 'active', effectiveAt: utc(r.at), reason: 'registered', actorIds: [string(r.actorId)] }], supersedes: null }, policy);
}

/** Revocation appends its effective time; earlier history and the public key stay for verifying earlier signatures. */
export function revokeKey(reg: KeyRegistration, change: { at: string; reason: string; actorId: string }, policy: KeyPolicy): Readonly<KeyRegistration> {
  const c = object(change, ['at', 'reason', 'actorId']);
  const current = keyStatusAt(reg, utc(c.at));
  if (current === 'not-registered' || utc(c.at) < reg.history[reg.history.length - 1].effectiveAt) refuse('KeyHistoryOrderRefused');
  return parseKeyRegistration({ ...reg, history: [...reg.history, { status: transitionSigningKey(current, 'revoke'), effectiveAt: c.at,
    reason: string(c.reason), actorIds: [string(c.actorId)] }] }, policy);
}

export interface RecoveryAuthorization {
  at: string; reason: string; clinician: VerifiedClinician; operators: readonly { id: string; authorized: boolean }[];
}
function authorizeRecovery(reg: KeyRegistration, input: RecoveryAuthorization): { at: string; operatorIds: string[] } {
  const a = object(input, ['at', 'reason', 'clinician', 'operators']);
  const who = parseVerifiedClinician(a.clinician);
  string(a.reason); utc(a.at);
  if (!Array.isArray(a.operators)) refuse('RecoveryOperatorsRequired');
  const operators = a.operators.map(o => { const x = object(o, ['id', 'authorized']); return { id: string(x.id), authorized: x.authorized === true }; });
  const ids = operators.map(o => o.id);
  // Two different authorised operators, neither of them the clinician whose key is recovered.
  if (operators.length < 2 || new Set(ids).size !== ids.length || operators.some(o => !o.authorized) || ids.includes(who.identity.id))
    refuse('RecoveryOperatorsRequired');
  if (!who.canSign || who.identity.id !== reg.identity.id || who.identity.issuer !== reg.identity.issuer ||
      who.identity.subject !== reg.identity.subject || who.institutionId !== reg.institutionId || who.verifiedAt > a.at) refuse('RecoveryIdentityRefused');
  return { at: a.at, operatorIds: ids };
}

/**
 * Recovery never re-enables the old key: it is retired (or stays revoked) and a new kid is registered for the same
 * clinician. Existing signatures keep verifying with the old public key.
 */
export function recoverSigningKey(reg: KeyRegistration, authorization: RecoveryAuthorization,
  replacement: Omit<DeviceKeyRequest, 'at' | 'actorId'>, policy: KeyPolicy, existing: KeyReader): Readonly<{ retired: KeyRegistration; replacement: KeyRegistration }> {
  const { at, operatorIds } = authorizeRecovery(reg, authorization);
  const r = object(replacement, ['kid', 'deviceId', 'osUserId', 'publicKey', 'evidence']);
  if (r.kid === reg.kid) refuse('KeyIdReused');
  let used: unknown = null;
  try { used = existing.load(string(r.kid)); } catch { used = null; }
  if (used) refuse('KeyIdReused');
  const current = keyStatusAt(reg, at);
  const retired = ['active', 'suspended'].includes(current) ? parseKeyRegistration({ ...reg, history: [...reg.history,
    { status: transitionSigningKey(current as KeyStatus, 'recover'), effectiveAt: at, reason: 'recovered', actorIds: operatorIds }] }, policy) : reg;
  const next = parseKeyRegistration({ kid: r.kid, deviceId: r.deviceId, osUserId: r.osUserId, publicKey: r.publicKey, identity: { ...reg.identity },
    identityRegistrationId: authorization.clinician.identityRegistrationId, institutionId: reg.institutionId, evidence: r.evidence,
    history: [{ status: 'active', effectiveAt: at, reason: 'recovery', actorIds: operatorIds }], supersedes: reg.kid }, policy);
  return freeze({ retired, replacement: next });
}

/**
 * Restoring access to an encrypted queue is separate from the signing key: the recovered entries keep their original
 * signatures and kid; nothing here makes the old key usable for a new signature.
 */
export function recoverQueueAccess(reg: KeyRegistration, authorization: RecoveryAuthorization): Readonly<{
  kid: string; ownerSubject: string; recoveredAt: string; operatorIds: readonly string[]; newSignatures: 'not-restored';
}> {
  const { at, operatorIds } = authorizeRecovery(reg, authorization);
  return freeze({ kid: reg.kid, ownerSubject: reg.identity.subject, recoveredAt: at, operatorIds, newSignatures: 'not-restored' as const });
}
