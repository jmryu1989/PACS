import { createHash } from 'node:crypto';
import { ImmutableIdentity, identity } from '../emr-contract/access-event';
import { choice, freeze, integer, object, refuse, sha256, string, utc } from '../emr-contract/validation';
import type { VerifiedSignatureV2 } from '../emr-signature/contract';
import { KeyRegistration, keyStatusAt } from '../emr-signature/keys';
import { boundaryPosition } from '../emr-signature/time-basis';
import { requireVerifiedV2 } from '../emr-signature/verify';
import { VerifiedActor, parseVerifiedActor } from './contract';

/**
 * Reviewed product values Q (image bytes), J (reserved original/queue/access-log space), H (guaranteed disconnected
 * hours) and epsilon (time uncertainty). D603 makes their real-device measurement a precondition of activation; until a
 * reviewed set exists the offline flow refuses. There are no defaults (no 0, no unlimited, no 24 h) by design.
 */
export interface OfflinePolicy { imageBytesQ: number; reserveBytesJ: number; disconnectedHoursH: number; epsilonMs: number; reviewRef: string }
export function requireOfflinePolicy(input: unknown): Readonly<OfflinePolicy> {
  let p: Record<string, any>;
  try {
    p = object(input, ['imageBytesQ', 'reserveBytesJ', 'disconnectedHoursH', 'epsilonMs', 'reviewRef']);
    integer(p.imageBytesQ, 1); integer(p.reserveBytesJ, 1); integer(p.disconnectedHoursH, 1); integer(p.epsilonMs); string(p.reviewRef);
  } catch { refuse('OfflinePolicyUnreviewed'); }
  return freeze({ imageBytesQ: p.imageBytesQ, reserveBytesJ: p.reserveBytesJ, disconnectedHoursH: p.disconnectedHoursH, epsilonMs: p.epsilonMs, reviewRef: p.reviewRef });
}

/** What E must have loaded and verified for each selected or comparison study before "Offline Ready". */
export const MANIFEST_PARTS = freeze(['series-sop-frame', 'diagnostic-pixels', 'metadata-calibration', 'derived-objects', 'fixed-report-context',
  'own-draft-revision', 'assignment-generation', 'viewer-decoder-font'] as const);
export interface OfflineManifest {
  manifestId: string;
  studies: readonly { studyId: string; role: 'current' | 'comparison'; parts: readonly { part: string; sha256: string; verifiedSha256: string | null; bytes: number }[] }[];
  requiredComparisonIds: readonly string[];
}
function parseManifest(input: unknown): Readonly<OfflineManifest> {
  const m = object(input, ['manifestId', 'studies', 'requiredComparisonIds']);
  if (!Array.isArray(m.studies) || !Array.isArray(m.requiredComparisonIds)) throw new Error('Manifest lists required');
  return freeze({ manifestId: string(m.manifestId), requiredComparisonIds: m.requiredComparisonIds.map(i => string(i)),
    studies: m.studies.map(s => {
      const x = object(s, ['studyId', 'role', 'parts']);
      if (!Array.isArray(x.parts)) throw new Error('Manifest parts required');
      return { studyId: string(x.studyId), role: choice(x.role, ['current', 'comparison']), parts: x.parts.map(p => {
        const y = object(p, ['part', 'sha256', 'verifiedSha256', 'bytes']);
        return { part: string(y.part), sha256: sha256(y.sha256), verifiedSha256: y.verifiedSha256 === null ? null : sha256(y.verifiedSha256), bytes: integer(y.bytes) };
      }) };
    }) });
}
const digestOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Offline Ready only when every part of every selected and required comparison study is present with a verified hash,
 * the total fits Q and the queue space J was reserved first. Cached HTML or already-displayed pixels are not evidence.
 */
export function offlineReadiness(manifestInput: unknown, policyInput: unknown, reservation: { bytes: number } | null): Readonly<{
  ready: boolean; missing: readonly string[]; manifestDigest: string; studyIds: readonly string[];
}> {
  const policy = requireOfflinePolicy(policyInput), manifest = parseManifest(manifestInput), missing: string[] = [];
  for (const study of manifest.studies) for (const part of MANIFEST_PARTS) {
    const found = study.parts.filter(p => p.part === part);
    if (found.length !== 1) missing.push(`missing:${study.studyId}:${part}`);
    else if (found[0].verifiedSha256 !== found[0].sha256) missing.push(`unverified:${study.studyId}:${part}`);
  }
  for (const id of manifest.requiredComparisonIds) if (!manifest.studies.some(s => s.studyId === id && s.role === 'comparison')) missing.push(`missing-comparison:${id}`);
  if (!manifest.studies.some(s => s.role === 'current')) missing.push('missing-current-study');
  const bytes = manifest.studies.reduce((n, s) => n + s.parts.reduce((m, p) => m + p.bytes, 0), 0);
  if (bytes > policy.imageBytesQ) missing.push('over-image-capacity');
  if (!reservation || !Number.isSafeInteger(reservation.bytes) || reservation.bytes < policy.reserveBytesJ) missing.push('queue-space-not-reserved');
  return freeze({ ready: missing.length === 0, missing, manifestDigest: digestOf(manifest), studyIds: manifest.studies.map(s => s.studyId) });
}

export type GrantAction = 'approve-sign' | 'amend' | 'addendum' | 'read';
export interface OfflineGrant {
  formatVersion: 'emr-offline-grant/1';
  grantId: string;
  clinician: ImmutableIdentity;
  identityRegistrationId: string;
  institutionId: string;
  deviceId: string;
  kid: string;
  studies: readonly { studyId: string; recordId: string; claimGeneration: number; role: 'current' | 'comparison' }[];
  manifestDigest: string;
  actions: readonly GrantAction[];
  issuedAt: string;
  expiresAt: string;
  anchorId: string;
  policy: OfflinePolicy;
}
export function parseGrant(input: unknown): Readonly<OfflineGrant> {
  const g = object(input, ['formatVersion', 'grantId', 'clinician', 'identityRegistrationId', 'institutionId', 'deviceId', 'kid', 'studies', 'manifestDigest',
    'actions', 'issuedAt', 'expiresAt', 'anchorId', 'policy']);
  if (g.formatVersion !== 'emr-offline-grant/1' || !Array.isArray(g.studies) || !g.studies.length || !Array.isArray(g.actions) || !g.actions.length) throw new Error('Grant shape');
  const policy = requireOfflinePolicy(g.policy);
  const grant = { formatVersion: 'emr-offline-grant/1' as const, grantId: string(g.grantId), clinician: identity(g.clinician),
    identityRegistrationId: string(g.identityRegistrationId), institutionId: string(g.institutionId), deviceId: string(g.deviceId), kid: string(g.kid),
    studies: g.studies.map(s => { const x = object(s, ['studyId', 'recordId', 'claimGeneration', 'role']);
      return { studyId: string(x.studyId), recordId: string(x.recordId), claimGeneration: integer(x.claimGeneration), role: choice(x.role, ['current', 'comparison']) }; }),
    manifestDigest: sha256(g.manifestDigest), actions: g.actions.map(a => choice<GrantAction>(a, ['approve-sign', 'amend', 'addendum', 'read'])),
    issuedAt: utc(g.issuedAt), expiresAt: utc(g.expiresAt), anchorId: string(g.anchorId), policy: { ...policy } };
  // A grant is finite: its length is the reviewed H, never longer and never open-ended.
  if (Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt) !== policy.disconnectedHoursH * 3600000) refuse('GrantLengthRefused');
  if (new Set(grant.actions).size !== grant.actions.length) throw new Error('Duplicate grant action');
  return freeze(grant);
}
export const grantDigest = (grant: OfflineGrant) => digestOf(parseGrant(grant));

/** Issued online by the server for a verified clinician, device key and a complete, reserved manifest. */
export function issueOfflineGrant(request: unknown, actorInput: VerifiedActor, key: KeyRegistration, policyInput: unknown,
  readiness: { ready: boolean; manifestDigest: string; studyIds: readonly string[] }): Readonly<{ grant: OfflineGrant; digest: string }> {
  const r = object(request, ['grantId', 'deviceId', 'kid', 'studies', 'actions', 'issuedAt', 'anchorId']);
  const actor = parseVerifiedActor(actorInput), policy = requireOfflinePolicy(policyInput);
  if (actor.sessionState !== 'active' || !actor.canSign || actor.kind !== 'member' || !actor.roles.includes('radiologist')) refuse('GrantAuthorityRefused');
  if (key.kid !== r.kid || key.deviceId !== r.deviceId || key.identity.id !== actor.identity.id || key.identity.issuer !== actor.identity.issuer ||
      key.identity.subject !== actor.identity.subject || key.institutionId !== actor.institutionId || keyStatusAt(key, utc(r.issuedAt)) !== 'active')
    refuse('GrantKeyRefused');
  if (!readiness || readiness.ready !== true || !Array.isArray(readiness.studyIds)) refuse('OfflineNotReady');
  // Only studies whose complete manifest was verified may be granted; anything else is outside the grant.
  if (!Array.isArray(r.studies) || r.studies.some(s => !readiness.studyIds.includes(s?.studyId))) refuse('GrantStudyRefused');
  const expiresAt = new Date(Date.parse(r.issuedAt) + policy.disconnectedHoursH * 3600000).toISOString();
  const grant = parseGrant({ formatVersion: 'emr-offline-grant/1', grantId: r.grantId, clinician: { ...actor.identity },
    identityRegistrationId: actor.identityRegistrationId, institutionId: actor.institutionId, deviceId: r.deviceId, kid: r.kid, studies: r.studies,
    manifestDigest: readiness.manifestDigest, actions: r.actions, issuedAt: r.issuedAt, expiresAt, anchorId: r.anchorId, policy: { ...policy } });
  return freeze({ grant, digest: grantDigest(grant) });
}

export interface GrantReader { load(grantId: string): unknown }
/**
 * The offline signature relied on exactly this stored grant: same clinician, device and key, an allowed action on a
 * granted study at the granted claim generation, and its whole time interval inside the grant's validity.
 */
export function checkSignatureGrant(signature: Readonly<VerifiedSignatureV2>, grants: GrantReader): Readonly<{ grant: OfflineGrant }> {
  const sig = requireVerifiedV2(signature), p = sig.payload;
  if (p.grant === null) refuse('GrantRequired');
  let grant: Readonly<OfflineGrant>;
  try { grant = parseGrant(grants.load(p.grant.grantId)); } catch { refuse('GrantUnknown'); }
  if (grantDigest(grant) !== p.grant.digest) refuse('GrantDigestRefused');
  if (grant.clinician.id !== p.signer.id || grant.clinician.issuer !== p.signer.issuer || grant.clinician.subject !== p.signer.subject ||
      grant.identityRegistrationId !== p.identityRegistrationId || grant.institutionId !== p.actingInstitutionId || grant.deviceId !== p.deviceId ||
      grant.kid !== p.kid) refuse('GrantBindingRefused');
  if (!(grant.actions as readonly string[]).includes(p.action)) refuse('GrantActionRefused');
  const study = grant.studies.find(s => s.studyId === p.studyId && s.recordId === p.recordId && s.role === 'current');
  if (!study) refuse('GrantStudyRefused');
  if (sig.time.status !== 'verified') refuse('GrantTimeUnverified');
  if (boundaryPosition(sig.time.interval, grant.issuedAt) !== 'at-or-after' || boundaryPosition(sig.time.interval, grant.expiresAt) !== 'before')
    refuse('GrantWindowRefused');
  return freeze({ grant });
}

/**
 * What the device may do in each session situation. Expiry, logout and account switch lock reading and new signing,
 * but never delete unsent signed originals; a network outage alone is not an end.
 */
export function offlineAccess(grantInput: unknown, situation: 'online' | 'offline' | 'session-ended' | 'logged-out' | 'account-switched',
  interval: { earliest: string; latest: string }): Readonly<{ read: boolean; sign: boolean; keepUnsent: true }> {
  const grant = parseGrant(grantInput);
  choice(situation, ['online', 'offline', 'session-ended', 'logged-out', 'account-switched']);
  const inside = boundaryPosition(interval, grant.issuedAt) === 'at-or-after' && boundaryPosition(interval, grant.expiresAt) === 'before';
  const usable = inside && ['online', 'offline'].includes(situation);
  return freeze({ read: usable, sign: usable, keepUnsent: true as const });
}
