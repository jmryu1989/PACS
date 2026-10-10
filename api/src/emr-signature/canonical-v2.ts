import { identity, patientLink } from '../emr-contract/access-event';
import { RECORD_CLASSIFICATION, RecordKind } from '../emr-contract/classification';
import { AttachmentReference, SignedText, versionReference } from '../emr-contract/signature';
import { choice, freeze, integer, object, refuse, sha256, string, utc } from '../emr-contract/validation';
import { SIGNATURE_V2_ACTIONS, SIGNATURE_V2_FIELDS, SIGNATURE_V2_FORMAT, SIGNATURE_V2_TYPE, SignatureEnvelopeV2, SignaturePayloadV2 } from './contract';
import { parseTimeBasis } from './time-basis';

/** U5 draft revision format "<epoch>:<n>"; the signature binds the exact revision the approval was based on. */
const DRAFT_REVISION = /^[^:\s]+:\d+$/;

function signedText(input: unknown): SignedText {
  const kind = (input as any)?.kind;
  if (kind === 'report') {
    const t = object(input, ['kind', 'findings', 'conclusion', 'recommendation']);
    return { kind: 'report', findings: string(t.findings, true), conclusion: string(t.conclusion, true), recommendation: string(t.recommendation, true) };
  }
  const t = object(input, ['kind', 'body']);
  return { kind: choice(t.kind, ['clinical-entry']), body: string(t.body, true) };
}

/** Exact signed bytes for format v2: fixed field order, UTF-8 without BOM, no normalisation of the clinician's text. */
export function canonicalPayloadV2(input: unknown): Buffer {
  const v = object(input, SIGNATURE_V2_FIELDS);
  if (v.formatVersion !== SIGNATURE_V2_FORMAT) throw new Error('Unknown signature format');
  const action = choice(v.action, SIGNATURE_V2_ACTIONS);
  const recordId = string(v.recordId), versionId = string(v.versionId), eventId = string(v.eventId);
  const previousVersion = v.previousVersion === null ? null : versionReference(v.previousVersion);
  if ((['amend', 'addendum', 'cancel'].includes(action) && previousVersion === null) ||
      (previousVersion && (previousVersion.recordId !== recordId || previousVersion.versionId === versionId))) throw new Error('Invalid previous version');
  if (!Array.isArray(v.attachments)) throw new Error('Attachment references required');
  const attachments: AttachmentReference[] = v.attachments.map(a => {
    const x = object(a, ['kind', 'recordId', 'versionId', 'sha256']);
    return { kind: choice(x.kind, Object.keys(RECORD_CLASSIFICATION) as RecordKind[]), recordId: string(x.recordId), versionId: string(x.versionId), sha256: sha256(x.sha256) };
  });
  const keys = attachments.map(a => JSON.stringify([a.kind, a.recordId, a.versionId]));
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate attachment reference');
  const reason = v.reason === null ? null : string(v.reason, true);
  if (action === 'cancel' && (reason === null || !reason.trim())) throw new Error('Cancellation reason required');
  let grant: SignaturePayloadV2['grant'] = null;
  if (v.grant !== null) { const g = object(v.grant, ['grantId', 'digest']); grant = { grantId: string(g.grantId), digest: sha256(g.digest) }; }
  const draftRevision = v.draftRevision === null ? null : string(v.draftRevision);
  if (draftRevision !== null && !DRAFT_REVISION.test(draftRevision)) throw new Error('Invalid draft revision');
  const predecessorEventId = v.predecessorEventId === null ? null : string(v.predecessorEventId);
  if (predecessorEventId === eventId) throw new Error('Event cannot precede itself');
  const payload: SignaturePayloadV2 = {
    formatVersion: SIGNATURE_V2_FORMAT, text: signedText(v.text), patient: patientLink(v.patient),
    managingInstitutionId: string(v.managingInstitutionId), actingInstitutionId: string(v.actingInstitutionId), studyId: string(v.studyId),
    recordKind: choice(v.recordKind, Object.keys(RECORD_CLASSIFICATION) as RecordKind[]), recordId, versionId, previousVersion, attachments,
    author: identity(v.author), signer: identity(v.signer), identityRegistrationId: string(v.identityRegistrationId), action, reason, eventId,
    deviceId: string(v.deviceId), kid: string(v.kid), grant, claimGeneration: integer(v.claimGeneration), draftRevision,
    deviceSequence: integer(v.deviceSequence, 1), predecessorEventId, signedAt: utc(v.signedAt), timeBasis: parseTimeBasis(v.timeBasis),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

export function base64url(value: unknown): Buffer {
  const s = string(value);
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('Expected unpadded base64url');
  const bytes = Buffer.from(s, 'base64url');
  if (bytes.toString('base64url') !== s) throw new Error('Noncanonical base64url');
  return bytes;
}

export function protectedHeaderV2(kid: string): Buffer {
  return Buffer.from(JSON.stringify({ alg: 'ES256', kid: string(kid), typ: SIGNATURE_V2_TYPE }), 'utf8');
}

/**
 * Structure of a v2 envelope: exact protected header (alg, kid, v2 typ), 64-byte R||S, canonical v2 payload and the
 * same kid in header and payload. A v1 header or payload is refused here; v1 is verified through its own format.
 * This is not cryptographic verification (see verify.ts).
 */
export function inspectEnvelopeV2(input: unknown): { kid: string; headerBytes: Buffer; payloadBytes: Buffer; signature: Buffer; payload: Readonly<SignaturePayloadV2> } {
  const v = object(input, ['protected', 'payload', 'signature']) as SignatureEnvelopeV2;
  const headerBytes = base64url(v.protected);
  let header: Record<string, any>;
  try { header = object(JSON.parse(headerBytes.toString('utf8')), ['alg', 'kid', 'typ']); } catch { refuse('SignatureFormatRefused'); }
  if (header.alg !== 'ES256' || header.typ !== SIGNATURE_V2_TYPE || !headerBytes.equals(protectedHeaderV2(header.kid))) refuse('SignatureFormatRefused');
  const signature = base64url(v.signature);
  if (signature.length !== 64) refuse('SignatureFormatRefused');
  const payloadBytes = base64url(v.payload);
  let payload: SignaturePayloadV2;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
    if (!payloadBytes.equals(canonicalPayloadV2(payload))) throw new Error('Noncanonical payload bytes');
  } catch { refuse('SignatureFormatRefused'); }
  if (payload.kid !== header.kid) refuse('SignatureFormatRefused');
  return { kid: header.kid, headerBytes, payloadBytes, signature, payload: freeze(payload) };
}
