import { createHash } from 'node:crypto';
import { AccessAction, ImmutableIdentity, STATUTORY_ACT, newAuditLinkId, parseAccessEvent } from '../emr-contract/access-event';
import { LifecycleActor, LifecycleCommand, ReportFacts, transitionReport, validateReportFacts } from '../emr-contract/report-lifecycle';
import type { AttachmentReference, VersionReference } from '../emr-contract/signature';
import { choice, freeze, integer, object, refuse, string, utc } from '../emr-contract/validation';
import type { SignatureEnvelopeV2, SignaturePayloadV2, VerifiedSignatureV2 } from '../emr-signature/contract';
import { requireVerifiedV2 } from '../emr-signature/verify';
import {
  CommitPlan, CommitReceipt, FailureJournalPort, IngressContext, LedgerEntry, ReportStorePort, RetainedInputs, StudyFacts, VerifiedActor,
  institutionAllows, parseCommitReceipt, parseStudyFacts, parseVerifiedActor,
} from './contract';
import { signedTransition } from './retention';

export type ReportCommandAction = 'start' | 'save' | 'release' | 'preliminary' | 'approve' | 'amend' | 'addendum' | 'cancel';
const SIGNED_ACTION = freeze({ preliminary: 'preliminary', approve: 'approve-sign', amend: 'amend', addendum: 'addendum', cancel: 'cancel' } as const);
/** Every command's access action; null only where no record content is written. Each is a 제23조④ act via STATUTORY_ACT. */
const ACCESS_FOR: Readonly<Record<ReportCommandAction, AccessAction | null>> = freeze({
  start: null,
  save: 'draft-save',
  release: 'release',
  preliminary: 'write',
  approve: 'approve-sign',
  amend: 'amend',
  addendum: 'addendum',
  cancel: 'cancel',
});
const SURFACE: Readonly<Record<ReportCommandAction, string>> = freeze({
  start: 'POST studies/:uid/hold', save: 'PUT studies/:uid/report', release: 'POST studies/:uid/release',
  preliminary: 'POST studies/:uid/report/commit', approve: 'POST studies/:uid/report/commit', amend: 'POST studies/:uid/report/commit',
  addendum: 'POST studies/:uid/report/commit', cancel: 'POST studies/:uid/report/commit',
});

/** The client's request. Identity, roles, institution and "verified" facts are not fields: they come from B2. */
export interface ReportCommand {
  action: ReportCommandAction;
  recordId: string;
  eventId: string;
  expectedClaimGeneration: number;
  expectedPublishedVersionId: string | null;
  draft: { expectedRevision: string | null; revision: string; text: { findings: string; conclusion: string; recommendation: string } } | null;
  reason: string | null;
  reviewerId: string | null;
  preservation: 'entry' | 'correction' | null;
  envelope: SignatureEnvelopeV2 | null;
}
export function parseReportCommand(input: unknown): Readonly<ReportCommand> {
  const v = object(input, ['action', 'recordId', 'eventId', 'expectedClaimGeneration', 'expectedPublishedVersionId', 'draft', 'reason', 'reviewerId', 'preservation', 'envelope']);
  const action = choice(v.action, ['start', 'save', 'release', 'preliminary', 'approve', 'amend', 'addendum', 'cancel']);
  let draft: ReportCommand['draft'] = null;
  if (v.draft !== null) {
    const d = object(v.draft, ['expectedRevision', 'revision', 'text']), t = object(d.text, ['findings', 'conclusion', 'recommendation']);
    draft = { expectedRevision: d.expectedRevision === null ? null : string(d.expectedRevision), revision: string(d.revision),
      text: { findings: string(t.findings, true), conclusion: string(t.conclusion, true), recommendation: string(t.recommendation, true) } };
  }
  if ((action === 'save') !== (draft !== null)) throw new Error('Draft text belongs to save only');
  const signed = Object.prototype.hasOwnProperty.call(SIGNED_ACTION, action);
  if (signed !== (v.envelope !== null)) refuse('SignatureRequired');
  return freeze({ action, recordId: string(v.recordId), eventId: string(v.eventId), expectedClaimGeneration: integer(v.expectedClaimGeneration),
    expectedPublishedVersionId: v.expectedPublishedVersionId === null ? null : string(v.expectedPublishedVersionId), draft,
    reason: v.reason === null ? null : string(v.reason), reviewerId: v.reviewerId === null ? null : string(v.reviewerId),
    preservation: v.preservation === null ? null : choice(v.preservation, ['entry', 'correction']), envelope: v.envelope });
}

/** Server facts for one command; C2 loads them under the report lock. */
export interface PlanContext {
  actor: VerifiedActor;
  study: StudyFacts;
  facts: ReportFacts;
  /** Server-resolved author of the text being signed (the reader who wrote it). */
  author: ImmutableIdentity | null;
  ownDraftRevision: string | null;
  attachments: readonly AttachmentReference[];
  signature: Readonly<VerifiedSignatureV2> | null;
  retained: RetainedInputs | null;
  receivedAt: string;
  ingress: IngressContext;
  mode: 'online' | 'offline-reconcile';
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function expectedPreviousVersion(facts: ReportFacts, action: ReportCommandAction): VersionReference | null {
  if (action === 'amend') return facts.bodyVersion;
  if (action === 'addendum' || action === 'cancel') return facts.publishedVersion;
  const last = facts.contentHistory[facts.contentHistory.length - 1];
  return last ? last.version : null;
}

/** A valid signature is not enough: what it signs must be this study, record, signer, base version and event. */
export function bindSignedPayload(p: Readonly<SignaturePayloadV2>, e: {
  recordId: string; action: string; eventId: string; patient: unknown; studyId: string; managingInstitutionId: string; actingInstitutionId: string;
  signer: ImmutableIdentity; identityRegistrationId: string; author: ImmutableIdentity; previousVersion: VersionReference | null;
  attachments: readonly AttachmentReference[]; claimGeneration: number; draftRevision: string | null; reason: string | null;
}): void {
  const checks: readonly (readonly [boolean, string])[] = [
    [p.recordId === e.recordId, 'recordId'],
    [p.recordKind === 'report-version', 'recordKind'],
    [p.action === e.action, 'action'],
    [p.eventId === e.eventId, 'eventId'],
    [same(p.patient, e.patient), 'patient'],
    [p.studyId === e.studyId, 'studyId'],
    [p.managingInstitutionId === e.managingInstitutionId, 'managingInstitutionId'],
    [p.actingInstitutionId === e.actingInstitutionId, 'actingInstitutionId'],
    [same(p.signer, e.signer) && p.identityRegistrationId === e.identityRegistrationId, 'signer'],
    [same(p.author, e.author), 'author'],
    [same(p.previousVersion, e.previousVersion), 'previousVersion'],
    [same(p.attachments, e.attachments), 'attachments'],
    [p.claimGeneration === e.claimGeneration, 'claimGeneration'],
    [p.draftRevision === e.draftRevision, 'draftRevision'],
    [p.reason === e.reason, 'reason'],
  ];
  if (checks.some(([ok]) => !ok)) refuse('SignedPayloadBindingRefused');
}

const known = <T>(value: T) => ({ status: 'known' as const, value });
function accessEntry(action: AccessAction, command: ReportCommand, ctx: PlanContext, versionId: string, occurredAt: string): LedgerEntry {
  const targetKind = command.action === 'save' ? 'private-draft' : command.action === 'release' ? 'assignment' : 'report-version';
  const event = parseAccessEvent({ formatVersion: 1, surface: SURFACE[command.action], eventId: `access:${command.eventId}:${action}`,
    userId: known({ ...ctx.actor.identity }), rolesAtTime: known([...ctx.actor.roles]), actingInstitution: known(ctx.actor.institutionId),
    managingInstitution: known(ctx.study.managingInstitutionId), occurredAt, trustedProxyIp: ctx.ingress.ip, cause: 'user-view', executor: 'member',
    targets: [{ kind: targetKind, patientLinkSnapshot: known({ ...ctx.study.patient }), studyId: known(ctx.study.studyId), recordId: known(command.recordId),
      versionId: known(versionId) }], action, result: 'succeeded', requestId: ctx.ingress.requestId, auditLinkId: newAuditLinkId(), relatedEventId: null });
  return freeze({ kind: 'access-v1' as const, act: STATUTORY_ACT[action], event });
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Plan one report command against stored facts. Signed actions require a verified v2 signature whose signed facts
 * match the server's; the approval instant is the verified signing time (t0 on first approval), never receivedAt.
 */
export function planReportCommand(context: PlanContext, input: unknown): Readonly<CommitPlan> {
  const command = parseReportCommand(input);
  const actor = parseVerifiedActor(context.actor), study = parseStudyFacts(context.study), facts = context.facts;
  validateReportFacts(facts);
  const receivedAt = utc(context.receivedAt);
  if (actor.sessionState !== 'active') refuse('SessionEnded');
  if (command.recordId !== facts.recordId || facts.studyId !== study.studyId) refuse('RecordBindingRefused');
  const lifecycleActor: LifecycleActor = { id: actor.identity.id, kind: actor.kind, roles: actor.roles,
    canReadStudy: institutionAllows(actor, study), canSign: actor.canSign, canCancel: actor.canCancel };
  const ctx = { ...context, actor, study };
  const accessAction = ACCESS_FOR[command.action];
  const ledger: LedgerEntry[] = [];
  const signedAction = Object.prototype.hasOwnProperty.call(SIGNED_ACTION, command.action) ? SIGNED_ACTION[command.action] : null;
  if (signedAction === null) {
    let draft: CommitPlan['draft'] = null;
    if (command.action === 'save') {
      // The private draft key is (study, author); the author is the session's verified identity, never a field.
      if (command.draft.expectedRevision !== context.ownDraftRevision) refuse('DraftRevisionConflict');
      draft = { author: actor.identity.id, expectedRevision: command.draft.expectedRevision, revision: command.draft.revision, text: { ...command.draft.text } };
    }
    const outcome = transitionReport(facts, { action: command.action, actor: lifecycleActor, at: receivedAt,
      expectedClaimGeneration: command.expectedClaimGeneration, expectedPublishedVersionId: command.expectedPublishedVersionId });
    if (accessAction !== null) ledger.push(accessEntry(accessAction, command, ctx, command.action === 'save' ? command.draft.revision : `claim:${outcome.facts.claimGeneration}`, receivedAt));
    return freeze({ eventId: command.eventId, contentDigest: digest(JSON.stringify(['unsigned', command.action, command.recordId, command.expectedClaimGeneration, draft])),
      recordId: facts.recordId, studyId: study.studyId,
      expected: { claimGeneration: facts.claimGeneration, publishedVersionId: facts.publishedVersion?.versionId ?? null, draftRevision: context.ownDraftRevision },
      facts: outcome.facts, effects: outcome.effects, version: null, draft, retention: null, ledger, publish: false,
      times: { signedAt: null, receivedAt, committedAt: null, publishedAt: null } });
  }
  const sig = requireVerifiedV2(context.signature);
  if (sig.time.status !== 'verified') refuse('SignatureTimeUnverified');
  if (sig.keyAtSigningTime !== 'active') refuse('SigningKeyInactive');
  if (context.mode === 'online' && sig.payload.grant !== null) refuse('OfflineSignatureRequiresReconcile');
  if (context.mode === 'offline-reconcile' && sig.payload.grant === null) refuse('OnlineSignatureRequiresConnection');
  if (command.envelope.payload !== sig.payloadBase64url) refuse('SignedPayloadBindingRefused');
  if (!actor.canSign) refuse('SigningAuthorityRequired');
  const p = sig.payload;
  if (context.author === null) refuse('AuthorRequired');
  bindSignedPayload(p, { recordId: facts.recordId, action: signedAction, eventId: command.eventId, patient: study.patient, studyId: study.studyId,
    managingInstitutionId: study.managingInstitutionId, actingInstitutionId: actor.institutionId, signer: actor.identity,
    identityRegistrationId: actor.identityRegistrationId, author: context.author, previousVersion: expectedPreviousVersion(facts, command.action),
    attachments: context.attachments, claimGeneration: facts.claimGeneration, draftRevision: context.ownDraftRevision, reason: command.reason });
  const version: VersionReference = { recordId: facts.recordId, versionId: p.versionId, sha256: sig.versionSha256 };
  const retained = context.retained;
  if (!retained) refuse('RetainedRecordRequired');
  const lifecycle: LifecycleCommand = { action: command.action, actor: lifecycleActor, at: p.signedAt,
    expectedClaimGeneration: command.expectedClaimGeneration, expectedPublishedVersionId: command.expectedPublishedVersionId, version,
    ...(command.reason !== null ? { reason: command.reason } : {}), eventId: command.eventId,
    ...(command.reviewerId !== null ? { reviewerId: command.reviewerId } : {}),
    ...(command.preservation === 'entry' ? { preservationEntry: retained.source } : {}),
    ...(command.preservation === 'correction' ? { preservationCorrection: retained.source } : {}) };
  const outcome = signedTransition(facts, lifecycle, retained);
  if (context.mode === 'online') ledger.push(accessEntry(accessAction, command, ctx, p.versionId, p.signedAt));
  const publish = outcome.effects.includes('publish-immediately');
  return freeze({ eventId: command.eventId, contentDigest: digest(`signed:${sig.versionSha256}:${command.preservation ?? 'clinical'}`),
    recordId: facts.recordId, studyId: study.studyId,
    expected: { claimGeneration: facts.claimGeneration, publishedVersionId: facts.publishedVersion?.versionId ?? null, draftRevision: context.ownDraftRevision },
    facts: outcome.facts, effects: outcome.effects, version: { ref: version, action: signedAction, envelope: { ...command.envelope }, signedAt: p.signedAt },
    draft: null, retention: outcome.retention, ledger, publish, times: { signedAt: p.signedAt, receivedAt, committedAt: null, publishedAt: null } });
}

export type CommitResult = Readonly<
  { status: 'committed' | 'duplicate'; receipt: Readonly<CommitReceipt> } |
  { status: 'failed'; code: string; journal: { journalId: string; durableAt: string } | null }
>;
/**
 * Idempotent commit: the same eventId with the same content returns the original receipt, the same eventId with other
 * content is a conflict (409). A failed commit is journalled outside the rollback; if the journal also fails the result
 * says so explicitly and is never a success.
 */
export async function executeCommit(plan: Readonly<CommitPlan>, store: ReportStorePort, journal: FailureJournalPort, now: () => string): Promise<CommitResult> {
  const existing = await store.findReceipt(plan.eventId);
  if (existing) {
    const receipt = parseCommitReceipt(existing);
    if (receipt.contentDigest !== plan.contentDigest) refuse('EventIdConflict');
    return freeze({ status: 'duplicate' as const, receipt });
  }
  let failure: string;
  try {
    const receipt = parseCommitReceipt(await store.commit(plan));
    if (receipt.eventId !== plan.eventId || receipt.contentDigest !== plan.contentDigest || receipt.ledgerReceipts.length !== plan.ledger.length ||
        receipt.ledgerReceipts.some((r, i) => r.eventId !== plan.ledger[i].event.eventId) || (plan.publish !== (receipt.publishedAt !== null)))
      refuse('CommitReceiptMismatch');
    return freeze({ status: 'committed' as const, receipt });
  } catch (error) {
    failure = (error as { code?: string })?.code ?? 'CommitFailed';
  }
  if (failure === 'EventIdExists') {
    // A concurrent duplicate won the unique key: answer from what was stored, never by committing again.
    const stored = await store.findReceipt(plan.eventId);
    if (stored) {
      const receipt = parseCommitReceipt(stored);
      if (receipt.contentDigest !== plan.contentDigest) refuse('EventIdConflict');
      return freeze({ status: 'duplicate' as const, receipt });
    }
  }
  try {
    const j = object(await journal.record({ eventId: plan.eventId, code: failure, at: now() }), ['journalId', 'durableAt']);
    return freeze({ status: 'failed' as const, code: failure, journal: { journalId: string(j.journalId), durableAt: utc(j.durableAt) } });
  } catch {
    return freeze({ status: 'failed' as const, code: failure, journal: null });
  }
}
