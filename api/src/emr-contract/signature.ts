import { ImmutableIdentity, PatientLinkSnapshot, identity, patientLink } from './access-event';
import { RecordKind, RECORD_CLASSIFICATION } from './classification';
import { choice, freeze, object, sha256, string, utc } from './validation';

export type SignedText = Readonly<
  { kind: 'report'; findings: string; conclusion: string; recommendation: string } |
  { kind: 'clinical-entry'; body: string }
>;
export interface VersionReference { recordId: string; versionId: string; sha256: string }
export interface AttachmentReference extends VersionReference { kind: RecordKind }
export type SignatureAction = 'record' | 'preliminary' | 'approve-sign' | 'amend' | 'addendum' | 'cancel' | 'supplement-sign';
export interface SignaturePayload {
  formatVersion: 'emr-signature/1';
  text: SignedText;
  patient: PatientLinkSnapshot;
  studyId: string;
  managingInstitutionId: string;
  actingInstitutionId: string;
  recordKind: RecordKind;
  recordId: string;
  versionId: string;
  author: ImmutableIdentity;
  signer: ImmutableIdentity;
  identityRegistrationId: string;
  action: SignatureAction;
  serverTime: string;
  previousVersion: VersionReference | null;
  attachments: readonly AttachmentReference[];
  reason: string | null;
}

export function versionReference(input: unknown): VersionReference {
  const v = object(input, ['recordId', 'versionId', 'sha256']);
  return { recordId: string(v.recordId), versionId: string(v.versionId), sha256: sha256(v.sha256) };
}

/** Field order below is format v1. Preserve Unicode scalar sequence, whitespace and array order exactly. */
export function canonicalPayload(input: unknown): Buffer {
  const v = object(input, ['formatVersion', 'text', 'patient', 'studyId', 'managingInstitutionId', 'actingInstitutionId', 'recordKind',
    'recordId', 'versionId', 'author', 'signer', 'identityRegistrationId', 'action', 'serverTime', 'previousVersion', 'attachments', 'reason']);
  if (v.formatVersion !== 'emr-signature/1') throw new Error('Unknown signature format');
  let text: SignedText;
  if (v.text?.kind === 'report') {
    const t = object(v.text, ['kind', 'findings', 'conclusion', 'recommendation']);
    text = { kind: 'report', findings: string(t.findings, true), conclusion: string(t.conclusion, true), recommendation: string(t.recommendation, true) };
  } else {
    const t = object(v.text, ['kind', 'body']);
    text = { kind: choice(t.kind, ['clinical-entry']), body: string(t.body, true) };
  }
  const action = choice(v.action, ['record', 'preliminary', 'approve-sign', 'amend', 'addendum', 'cancel', 'supplement-sign']);
  const previousVersion = v.previousVersion === null ? null : versionReference(v.previousVersion);
  const recordId = string(v.recordId), versionId = string(v.versionId);
  if ((['amend', 'addendum', 'cancel', 'supplement-sign'].includes(action) && previousVersion === null) ||
      (previousVersion && (previousVersion.recordId !== recordId || previousVersion.versionId === versionId))) throw new Error('Invalid previous version');
  if (!Array.isArray(v.attachments)) throw new Error('Attachment references required');
  const attachments: AttachmentReference[] = v.attachments.map(input => {
    const a = object(input, ['kind', 'recordId', 'versionId', 'sha256']);
    return { kind: choice(a.kind, Object.keys(RECORD_CLASSIFICATION) as RecordKind[]), recordId: string(a.recordId), versionId: string(a.versionId), sha256: sha256(a.sha256) };
  });
  const identities = attachments.map(a => JSON.stringify([a.kind, a.recordId, a.versionId]));
  if (new Set(identities).size !== identities.length) throw new Error('Duplicate attachment reference');
  const reason = v.reason === null ? null : string(v.reason, true);
  if (action === 'cancel' && (reason === null || !reason.trim())) throw new Error('Cancellation reason required');
  const payload: SignaturePayload = {
    formatVersion: 'emr-signature/1', text, patient: patientLink(v.patient), studyId: string(v.studyId),
    managingInstitutionId: string(v.managingInstitutionId), actingInstitutionId: string(v.actingInstitutionId),
    recordKind: choice(v.recordKind, Object.keys(RECORD_CLASSIFICATION) as RecordKind[]), recordId, versionId,
    author: identity(v.author), signer: identity(v.signer), identityRegistrationId: string(v.identityRegistrationId), action,
    serverTime: utc(v.serverTime), previousVersion, attachments, reason,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

/** Flattened JWS; protected header and payload are the exact base64url-encoded bytes. */
export interface SignatureEnvelope { protected: string; payload: string; signature: string }
export const SIGNATURE_ALGORITHMS = freeze(['ES256'] as const);
export interface SignatureVerification {
  integrity: 'valid' | 'invalid' | 'unverifiable';
  registeredIdentity: 'matched' | 'mismatch' | 'unverifiable';
  keyAtSigningTime: 'active' | 'inactive' | 'unverifiable';
  compromise: 'not-known' | 'suspected';
}

function base64url(value: unknown): Buffer {
  const s = string(value);
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('Expected unpadded base64url');
  const bytes = Buffer.from(s, 'base64url');
  if (bytes.toString('base64url') !== s) throw new Error('Noncanonical base64url');
  return bytes;
}

/** Structural validation only. Unit C must perform ES256 verification with the registered P-256 public key. */
export function inspectSignatureEnvelope(input: unknown): { keyId: string; payloadBytes: Buffer } {
  const v = object(input, ['protected', 'payload', 'signature']);
  const headerBytes = base64url(v.protected);
  const header = object(JSON.parse(headerBytes.toString('utf8')), ['alg', 'kid', 'typ']);
  choice(header.alg, SIGNATURE_ALGORITHMS);
  const keyId = string(header.kid);
  if (header.typ !== 'emr-signature+jws' || !headerBytes.equals(Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'emr-signature+jws' }), 'utf8')))
    throw new Error('Noncanonical protected header');
  if (base64url(v.signature).length !== 64) throw new Error('ES256 JWS requires 64-byte R || S');
  const payloadBytes = base64url(v.payload);
  if (!payloadBytes.equals(canonicalPayload(JSON.parse(payloadBytes.toString('utf8'))))) throw new Error('Noncanonical payload bytes');
  return { keyId, payloadBytes };
}

export const SIGNATURE_VERIFICATION_CONTRACT = freeze({
  algorithm: 'ES256 only; P-256 registered key; protected kid; no unprotected headers or remote key URLs',
  integrity: 'verify JWS signing input and fixed referenced content hashes; persist exact UTF-8 payload, never rebuild from mutable heads',
  registeredIdentity: 'match signer id + issuer + subject and identityRegistrationId to product-verified identity and signing authority',
  keyAtSigningTime: 'verify ownership and validity interval at signed serverTime from retained registration/rotation/revocation evidence',
  keyHistory: 'rotation gets a new kid; later retirement does not invalidate an earlier active key; retain public keys and compromise intervals',
  atomicity: 'failed signing/verification cannot publish; preserve submitted and later private input',
  addendum: 'new author/signature and immutable references; never overwrite another author addendum',
  encoding: 'JSON fixed property order, UTF-8 no BOM/trailing newline; no Unicode normalization, trim, newline conversion or array sorting; reject lone surrogates',
});
