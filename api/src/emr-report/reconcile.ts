import { createHash } from 'node:crypto';
import { ImmutableIdentity, STATUTORY_ACT } from '../emr-contract/access-event';
import { ReportFacts, reportRetentionAccess, validateReportFacts } from '../emr-contract/report-lifecycle';
import type { AttachmentReference, VersionReference } from '../emr-contract/signature';
import { freeze, refuse, utc } from '../emr-contract/validation';
import type { VerifiedSignatureV2 } from '../emr-signature/contract';
import { QueueEntry, parseQueueEntry } from '../emr-signature/native-port';
import { SignatureVerificationPorts, verifySignatureV2 } from '../emr-signature/verify';
import { CommitResult, envelopeDigest, expectedPreviousVersion, planReportCommand, prepareSignedCommand, reportHistoryDigest } from './commands';
import {
  AdoptedEvent, CommitPlan, IngressContext, LedgerEntry, OfflineReceiptEvent, ReportEventResponse, ReportTimes, RetainedInputs, StudyFacts, VerifiedActor,
  institutionAllows, parseCommitReceipt, parseStudyFacts, parseVerifiedActor,
} from './contract';
import { GrantReader, checkSignatureGrant } from './offline-grant';

/** Server facts for one arriving offline event; C2 reads them under the report lock in the receiving transaction. */
export interface ReconcileContext {
  actor: VerifiedActor;
  study: StudyFacts;
  facts: ReportFacts;
  author: ImmutableIdentity | null;
  ownDraftRevision: string | null;
  attachments: readonly AttachmentReference[];
  retained: RetainedInputs | null;
  receivedAt: string;
  ingress: IngressContext;
  verification: SignatureVerificationPorts;
  grants: GrantReader;
  existingReceipt: unknown | null;
  predecessor: AdoptedEvent | null;
  storedVersions?: readonly VersionReference[];
  existingAdoption?: AdoptedEvent | null;
  /** The signer explicitly chose to adopt the signed original unchanged over a newer draft of their own. */
  adoptDivergedDraft: boolean;
}
export type ConflictKind = 'other-approved' | 'reassigned' | 'parent-cancelled' | 'own-draft-diverged' | 'base-changed';
/** A pre-boundary amend that arrives after Finalized: C2 records it as a past event; state and t0 stay as they are. */
export interface LateAdmission {
  eventId: string; recordId: string; version: VersionReference; signedAt: string; interval: { earliest: string; latest: string };
  keep: { state: 'Finalized'; firstApprovedAt: string; amendUntil: string };
  ledger: readonly LedgerEntry[];
  requires: 'c2-lifecycle-late-event';
  envelope: VerifiedSignatureV2['envelope'];
  predecessor: AdoptedEvent | null;
  retained: RetainedInputs;
  expected: CommitPlan['expected'];
  retentionAccess: ReturnType<typeof reportRetentionAccess>;
}
export type ReconcileDecision = Readonly<
  { kind: 'duplicate'; response: ReportEventResponse } |
  { kind: 'commit'; plan: Readonly<CommitPlan> } |
  { kind: 'admit-late-amend'; admission: Readonly<LateAdmission>; response: ReportEventResponse } |
  { kind: 'conflict'; conflict: ConflictKind; preserved: 'private-original'; allowed: readonly string[]; response: ReportEventResponse } |
  { kind: 'held'; reason: string; response: ReportEventResponse } |
  { kind: 'refused'; code: string; response: ReportEventResponse }
>;

const SIGNED_TO_COMMAND = freeze({ 'approve-sign': 'approve', amend: 'amend', addendum: 'addendum', cancel: 'cancel' } as const);
const versionSha = (entry: QueueEntry) => createHash('sha256').update(Buffer.from(entry.envelope.payload, 'base64url')).digest('hex');
const signedDigest = (entry: QueueEntry) => createHash('sha256').update(`signed:${versionSha(entry)}:${envelopeDigest(entry.envelope)}:clinical`).digest('hex');

/**
 * Decide what the server does with one queued offline event. The server's current state always wins: nothing is
 * overwritten or merged automatically, the signer's original stays preserved privately, and dependants wait.
 * The answer carries references and times only, never a body or another person's draft.
 */
export function reconcileOfflineEvent(context: ReconcileContext, entryInput: unknown): ReconcileDecision {
  const receivedAt = utc(context.receivedAt);
  let entry: Readonly<QueueEntry>;
  try { entry = parseQueueEntry(entryInput); }
  catch (error) { return refused(String((entryInput as any)?.eventId ?? 'unknown'), (error as any)?.code ?? 'MalformedEvent', null, receivedAt, null); }
  const eventId = entry.eventId;
  const actor = parseVerifiedActor(context.actor), study = parseStudyFacts(context.study), facts = context.facts;
  validateReportFacts(facts);
  const visible = institutionAllows(actor, study) && actor.roles.includes('radiologist') ? facts.publishedVersion : null;
  const times = (signedAt: string | null): ReportTimes => ({ signedAt, receivedAt, committedAt: null, publishedAt: null });
  const answer = (status: ReportEventResponse['status'], reason: string | null, signedAt: string | null, recovery: boolean): ReportEventResponse =>
    freeze({ eventId, status, reason, recoveryRef: recovery ? `recovery:${eventId}` : null, currentVersion: visible ? { ...visible } : null, times: times(signedAt) });

  const fail = (code: string, signedAt: string | null) => freeze({ kind: 'refused' as const, code, response: answer('refused', code, signedAt, true) });
  // The submitting session must be the signer's own, live session; an ended session is never revived for sending.
  if (actor.sessionState !== 'active') return fail('SessionEnded', null);
  let sig: Readonly<VerifiedSignatureV2>;
  try { sig = verifySignatureV2(entry.envelope, context.verification, { osUserId: entry.owner.osUserId }); }
  catch (error) { return fail((error as any)?.code ?? 'SignatureRefused', null); }
  const p = sig.payload;
  if (p.signer.id !== actor.identity.id || p.signer.issuer !== actor.identity.issuer || p.signer.subject !== actor.identity.subject) return fail('SubmitterNotSigner', null);
  if (!actor.canSign || !institutionAllows(actor, study) || !actor.roles.includes('radiologist')) return fail('CurrentAuthorityRefused', p.signedAt);
  // A resend is answered from the stored receipt only after the same session, signature and authority checks, and only
  // for the exact original envelope (signed bytes and signature both); anything else under that eventId is a conflict.
  if (context.existingReceipt) {
    const receipt = parseCommitReceipt(context.existingReceipt);
    if (p.recordId !== facts.recordId || p.studyId !== study.studyId || p.managingInstitutionId !== study.managingInstitutionId ||
        p.actingInstitutionId !== actor.institutionId || JSON.stringify(p.patient) !== JSON.stringify(study.patient)) return fail('SignedPayloadBindingRefused', p.signedAt);
    if (receipt.eventId !== eventId || receipt.recordId !== p.recordId || receipt.versionId !== p.versionId || receipt.contentDigest !== signedDigest(entry)) return fail('EventIdConflict', null);
    return freeze({ kind: 'duplicate' as const, response: { ...answer('duplicate', null, p.signedAt, false), adoption: context.existingAdoption ?? null,
      times: { signedAt: p.signedAt, receivedAt, committedAt: receipt.committedAt, publishedAt: receipt.publishedAt } } });
  }
  if (sig.time.status !== 'verified') return freeze({ kind: 'held' as const, reason: `time-${sig.time.reason}`, response: answer('held', `time-${sig.time.reason}`, p.signedAt, true) });
  if (sig.keyAtSigningTime !== 'active') return fail('SigningKeyInactive', p.signedAt);
  let grantGeneration: number;
  try {
    const checked = checkSignatureGrant(sig, context.grants);
    if (checked.grant.policy.epsilonMs !== context.verification.timePolicy.epsilonMs) refuse('GrantPolicyMismatch');
    grantGeneration = checked.generation;
  } catch (error) { return fail((error as any)?.code ?? 'GrantRefused', p.signedAt); }
  if (p.predecessorEventId !== null && !context.predecessor && p.predecessorEventId !== p.eventId)
    return freeze({ kind: 'held' as const, reason: 'predecessor-unresolved', response: answer('held', 'predecessor-unresolved', p.signedAt, true) });

  const conflict = (kind: ConflictKind, allowed: readonly string[]) =>
    freeze({ kind: 'conflict' as const, conflict: kind, preserved: 'private-original' as const, allowed, response: answer('conflict', kind, p.signedAt, true) });
  if (facts.state === 'Cancelled') return conflict('parent-cancelled', ['new-report-unit-from-recovery-copy']);
  let ownDraftRevision = context.ownDraftRevision;
  if (p.action === 'approve-sign') {
    if (facts.firstApprovedAt !== null) return conflict('other-approved', ['addendum-candidate']);
    const claimHeld = facts.claimGeneration === p.claimGeneration && (facts.state === 'In Progress' ? facts.claimantId === p.signer.id :
      facts.state === 'Preliminary' ? facts.preliminary?.reviewerId === p.signer.id : false);
    if (!claimHeld) return conflict('reassigned', ['review-under-current-assignment']);
    if (p.draftRevision !== ownDraftRevision) {
      if (!context.adoptDivergedDraft) return conflict('own-draft-diverged', ['adopt-signed-original', 'sign-new-version']);
      ownDraftRevision = p.draftRevision;
    }
  } else if (!(p.action in SIGNED_TO_COMMAND)) {
    return fail('OfflineActionRefused', p.signedAt);
  } else if (JSON.stringify(p.previousVersion) !== JSON.stringify(expectedPreviousVersion(facts, SIGNED_TO_COMMAND[p.action]))) {
    return conflict('base-changed', ['review-current-version']);
  }
  // An intervening Addendum is a clinical branch even if the body reference stayed the same.
  if (p.action === 'amend' && JSON.stringify(facts.bodyVersion) !== JSON.stringify(facts.publishedVersion))
    return conflict('base-changed', ['review-current-version']);

  const observation: LedgerEntry = freeze({ kind: 'offline-observation' as const, act: STATUTORY_ACT[entry.access.action], event: entry.access });
  if (context.ingress.ip.status !== 'known') refuse('TrustedProxyIpRequired');
  const receiptEvent: OfflineReceiptEvent = { formatVersion: 'emr-offline-receipt/1', eventId: `receipt:${eventId}`, relatedEventId: eventId, receivedAt,
    sessionSubject: actor.identity.subject, ip: { status: 'known', value: { ...context.ingress.ip.value } } };
  const receipt: LedgerEntry = freeze({ kind: 'offline-receipt' as const, act: 'none' as const, event: freeze(receiptEvent) });
  const command = { action: SIGNED_TO_COMMAND[p.action], recordId: facts.recordId, eventId, expectedClaimGeneration: facts.claimGeneration,
    expectedPublishedVersionId: facts.publishedVersion?.versionId ?? null, draft: null, reason: p.reason, reviewerId: null, preservation: null, envelope: { ...entry.envelope } };
  const planContext = { actor, study, facts, author: context.author, ownDraftRevision, attachments: context.attachments, signature: sig,
    retained: context.retained, receivedAt, ingress: context.ingress, mode: 'offline-reconcile' as const, grantGeneration,
    predecessor: context.predecessor, storedVersions: context.storedVersions };
  // The same validation as any signed command runs first, also for an event that will only be recorded as past.
  try { prepareSignedCommand(planContext, command); }
  catch (error) {
    if ((error as any)?.code === 'EventOrderUncertain')
      return freeze({ kind: 'held' as const, reason: 'time-order-uncertain', response: answer('held', 'time-order-uncertain', p.signedAt, true) });
    return refused(eventId, (error as any)?.code ?? 'TransitionRefused', visible, receivedAt, p.signedAt);
  }
  if (p.action === 'amend' && facts.state === 'Finalized') {
    const r = context.retained;
    if (!reportRetentionAccess(facts, r.archive, null, { record: r.record, at: p.signedAt }).ordinaryClinicalAccess)
      return refused(eventId, 'HeldCorrectionAuthorityRequired', visible, receivedAt, p.signedAt);
    const admission: LateAdmission = { eventId, recordId: facts.recordId, version: { recordId: facts.recordId, versionId: p.versionId, sha256: sig.versionSha256 },
      signedAt: p.signedAt, interval: { ...sig.time.interval }, keep: { state: 'Finalized', firstApprovedAt: facts.firstApprovedAt, amendUntil: facts.amendUntil },
      ledger: [observation, receipt], requires: 'c2-lifecycle-late-event', envelope: sig.envelope, predecessor: context.predecessor,
      retained: r, retentionAccess: reportRetentionAccess(facts, r.archive, null, { record: r.record, at: p.signedAt }),
      expected: { claimGeneration: facts.claimGeneration, publishedVersionId: facts.publishedVersion?.versionId ?? null,
        draftRevision: context.ownDraftRevision, historyDigest: reportHistoryDigest(facts), rightsVersion: actor.rightsVersion } };
    return freeze({ kind: 'admit-late-amend' as const, admission, response: answer('held', 'late-amend-admission', p.signedAt, false) });
  }
  let plan: Readonly<CommitPlan>;
  try { plan = planReportCommand(planContext, command); }
  catch (error) { return refused(eventId, (error as any)?.code ?? 'TransitionRefused', visible, receivedAt, p.signedAt); }
  // An explicit adoption binds the signed revision, but the store still compares against the server's current draft.
  return freeze({ kind: 'commit' as const, plan: freeze({ ...plan, expected: { ...plan.expected, draftRevision: context.ownDraftRevision },
    ledger: [...plan.ledger, observation, receipt] }) });
}

/** The answer after the commit attempt: only an actual receipt makes it committed; a journalled failure stays failed. */
export function commitResponse(plan: Readonly<CommitPlan>, result: CommitResult): ReportEventResponse {
  if (result.status === 'failed') return freeze({ eventId: plan.eventId, status: 'failed' as const, reason: result.code, recoveryRef: `recovery:${plan.eventId}`,
    currentVersion: null, times: { ...plan.times } });
  return freeze({ eventId: plan.eventId, status: result.status, reason: null, recoveryRef: null,
    currentVersion: plan.facts.publishedVersion ? { ...plan.facts.publishedVersion } : null,
    times: { signedAt: plan.times.signedAt, receivedAt: plan.times.receivedAt, committedAt: result.receipt.committedAt, publishedAt: result.receipt.publishedAt },
    adoption: plan.adoption ? { ...plan.adoption, receipt: result.receipt } : null });
}

function refused(eventId: string, code: string, visible: VersionReference | null, receivedAt: string, signedAt: string | null): ReconcileDecision {
  return freeze({ kind: 'refused' as const, code, response: { eventId, status: 'refused' as const, reason: code, recoveryRef: `recovery:${eventId}`,
    currentVersion: visible ? { ...visible } : null, times: { signedAt, receivedAt, committedAt: null, publishedAt: null } } });
}
