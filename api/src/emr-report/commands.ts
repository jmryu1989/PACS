import { createHash } from 'node:crypto';
import { AccessAction, ImmutableIdentity, STATUTORY_ACT, newAuditLinkId, parseAccessEvent } from '../emr-contract/access-event';
import { LifecycleActor, LifecycleCommand, ReportFacts, transitionReport, validateReportFacts } from '../emr-contract/report-lifecycle';
import type { AttachmentReference, VersionReference } from '../emr-contract/signature';
import { choice, freeze, integer, object, refuse, string, utc } from '../emr-contract/validation';
import type { SignatureEnvelopeV2, SignaturePayloadV2, VerifiedSignatureV2 } from '../emr-signature/contract';
import { boundaryPosition } from '../emr-signature/time-basis';
import { requireVerifiedV2 } from '../emr-signature/verify';
import { verifiedRecord } from '../emr-contract/classification';
import { retentionState } from '../emr-contract/lawful-defaults';
import {
  CommitPlan, CommitReceipt, FailureJournalPort, IngressContext, LedgerEntry, ReportStorePort, RetainedInputs, StudyFacts, VerifiedActor,
  AdoptedEvent, institutionAllows, parseAdoptedEvent, parseCommitReceipt, parseStudyFacts, parseVerifiedActor,
} from './contract';
import { signedTransition } from './retention';

export type ReportCommandAction = 'start' | 'save' | 'release' | 'preliminary' | 'approve' | 'amend' | 'addendum' | 'cancel' | 'cancel-preliminary';
/** cancel-preliminary: the designated reviewer's reasoned, signed cancellation of a Preliminary (AGENTS §1.3). */
const SIGNED_ACTION = freeze({ preliminary: 'preliminary', approve: 'approve-sign', amend: 'amend', addendum: 'addendum', cancel: 'cancel',
  'cancel-preliminary': 'cancel' } as const);
/** Actions that consume the reader's claim; their signature binds the server claim generation. */
const CLAIM_BOUND: readonly ReportCommandAction[] = freeze(['preliminary', 'approve', 'cancel-preliminary']);
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
  'cancel-preliminary': 'cancel',
});
const SURFACE: Readonly<Record<ReportCommandAction, string>> = freeze({
  start: 'POST studies/:uid/hold', save: 'PUT studies/:uid/report', release: 'POST studies/:uid/release',
  preliminary: 'POST studies/:uid/report/commit', approve: 'POST studies/:uid/report/commit', amend: 'POST studies/:uid/report/commit',
  addendum: 'POST studies/:uid/report/commit', cancel: 'POST studies/:uid/report/commit', 'cancel-preliminary': 'POST studies/:uid/report/commit',
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
  const action = choice<ReportCommandAction>(v.action, ['start', 'save', 'release', 'preliminary', 'approve', 'amend', 'addendum', 'cancel', 'cancel-preliminary']);
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
  /** Offline only: the claim generation of the grant the signature relied on (checked by checkSignatureGrant). */
  grantGeneration?: number | null;
  /** C2 supplies all separately retained/cancelled/reserved versions too, under the same transaction lock. */
  storedVersions?: readonly VersionReference[];
  predecessor?: AdoptedEvent | null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** All three base64url parts: a different signature over the same payload is a different, unverified envelope. */
export const sameEnvelope = (a: SignatureEnvelopeV2 | null, b: SignatureEnvelopeV2) =>
  !!a && a.protected === b.protected && a.payload === b.payload && a.signature === b.signature;
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
/** Identity of the exact envelope (all three parts); part of a signed event's content digest so a resend must be byte-identical. */
export const envelopeDigest = (e: SignatureEnvelopeV2) => digest(`${e.protected}.${e.payload}.${e.signature}`);
/** CAS includes Finalize and non-body clinical history, not just the public head. */
export const reportHistoryDigest = (facts: ReportFacts) => digest(JSON.stringify(facts));

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
  const prepared = prepareSignedCommand(context, command);
  const { sig, p, version, lifecycle, retained } = prepared;
  // A Preliminary cancellation adds no content part: its signed reason is history evidence of the same unit.
  const outcome = command.action === 'cancel-preliminary' ? { ...transitionReport(facts, lifecycle), retention: null }
    : signedTransition(facts, lifecycle, retained);
  if (context.mode === 'online') ledger.push(accessEntry(accessAction, command, ctx, p.versionId, p.signedAt));
  const publish = outcome.effects.includes('publish-immediately');
  return freeze({ eventId: command.eventId, contentDigest: digest(`signed:${sig.versionSha256}:${envelopeDigest(sig.envelope)}:${command.preservation ?? 'clinical'}`),
    recordId: facts.recordId, studyId: study.studyId,
    expected: { claimGeneration: facts.claimGeneration, publishedVersionId: facts.publishedVersion?.versionId ?? null, draftRevision: context.ownDraftRevision,
      historyDigest: reportHistoryDigest(facts), rightsVersion: actor.rightsVersion },
    facts: outcome.facts, effects: outcome.effects, version: { ref: version, action: signedAction, envelope: { ...sig.envelope }, signedAt: p.signedAt },
    draft: null, retention: outcome.retention, ledger, publish, times: { signedAt: p.signedAt, receivedAt, committedAt: null, publishedAt: null },
    adoption: { eventId: p.eventId, studyId: p.studyId, institutionId: p.managingInstitutionId, version, signedAt: p.signedAt,
      deviceId: p.deviceId, deviceSequence: p.deviceSequence, predecessorEventId: p.predecessorEventId,
      ancestors: context.predecessor ? [...context.predecessor.ancestors, context.predecessor.eventId] : [] } });
}

/** Past-event validity is identical before and after Finalize. Current-branch conflicts are classified by reconcile. */
function validatePastEvent(context: PlanContext, sig: Readonly<VerifiedSignatureV2>): void {
  const { facts } = context, p = sig.payload;
  if (sig.time.status !== 'verified') refuse('SignatureTimeUnverified');
  const versions = [...facts.contentHistory.map(h => h.version), facts.bodyVersion, facts.publishedVersion,
    ...facts.addenda.map(a => a.version), facts.cancellation?.version, ...(context.storedVersions ?? [])];
  if (versions.some(v => v?.recordId === p.recordId && v.versionId === p.versionId) ||
      context.retained?.record?.parts.some(part => part.evidence.event.versionId === p.versionId)) refuse('VersionIdReused');
  let predecessorAt: string | null = null;
  if (p.predecessorEventId !== null) {
    if (p.predecessorEventId === p.eventId) refuse('PredecessorBindingRefused');
    if (!context.predecessor) refuse('PredecessorUnresolved');
    let prior: Readonly<AdoptedEvent>;
    try { prior = parseAdoptedEvent(context.predecessor); } catch { refuse('PredecessorBindingRefused'); }
    if (prior.eventId !== p.predecessorEventId || prior.studyId !== p.studyId || prior.institutionId !== p.managingInstitutionId ||
        !same(prior.version, p.previousVersion) || prior.ancestors.includes(p.eventId) ||
        (prior.deviceId === p.deviceId && prior.deviceSequence >= p.deviceSequence) ||
        !facts.contentHistory.some(h => same(h.version, prior.version) && h.at === prior.signedAt && h.use === 'clinical'))
      refuse('PredecessorBindingRefused');
    predecessorAt = prior.signedAt;
  } else if (p.previousVersion !== null) {
    const prior = facts.contentHistory.find(h => same(h.version, p.previousVersion) && h.use === 'clinical');
    if (!prior) refuse('PredecessorBindingRefused');
    predecessorAt = prior.at;
  }
  const lower = [facts.firstApprovedAt, predecessorAt, ...facts.contentHistory.map(h => h.at)].filter((x): x is string => x !== null).sort().pop();
  if (lower && sig.time.interval.earliest < lower)
    refuse(sig.time.interval.latest < lower ? 'EventBeforePredecessor' : 'EventOrderUncertain');
}

/**
 * The validation every signed command shares, also for an offline event that will only be recorded as a past event:
 * the exact verified envelope, verified time and active key, the signed facts against the server's (patient, record,
 * signer, author, base version, claim lineage, draft revision, event), the amend window over the whole time interval,
 * and the stored retention inputs bound to this signed version.
 */
export function prepareSignedCommand(context: PlanContext, input: unknown): Readonly<{
  sig: Readonly<VerifiedSignatureV2>; p: Readonly<SignaturePayloadV2>; version: VersionReference; lifecycle: LifecycleCommand; retained: RetainedInputs;
}> {
  const command = parseReportCommand(input);
  const signedAction = Object.prototype.hasOwnProperty.call(SIGNED_ACTION, command.action) ? SIGNED_ACTION[command.action] : null;
  if (signedAction === null) refuse('SignatureRequired');
  const actor = parseVerifiedActor(context.actor), study = parseStudyFacts(context.study), facts = context.facts;
  validateReportFacts(facts);
  if (actor.sessionState !== 'active') refuse('SessionEnded');
  if (command.recordId !== facts.recordId || facts.studyId !== study.studyId) refuse('RecordBindingRefused');
  const sig = requireVerifiedV2(context.signature);
  if (!sameEnvelope(command.envelope, sig.envelope)) refuse('SignedEnvelopeMismatch');
  if (sig.time.status !== 'verified') refuse('SignatureTimeUnverified');
  if (sig.keyAtSigningTime !== 'active') refuse('SigningKeyInactive');
  if (context.mode === 'online' && sig.payload.grant !== null) refuse('OfflineSignatureRequiresReconcile');
  if (context.mode === 'offline-reconcile' && (sig.payload.grant === null || !Number.isSafeInteger(context.grantGeneration)))
    refuse('OnlineSignatureRequiresConnection');
  if (!actor.canSign) refuse('SigningAuthorityRequired');
  if (!institutionAllows(actor, study) || actor.kind !== 'member' || !actor.roles.includes('radiologist')) refuse('CurrentAuthorityRefused');
  const p = sig.payload;
  if (context.author === null) refuse('AuthorRequired');
  if (command.action === 'cancel-preliminary' && (facts.state !== 'Preliminary' || facts.preliminary?.reviewerId !== actor.identity.id))
    refuse('DesignatedReviewerRequired');
  // Claim-consuming actions sign the server's claim; later actions sign the lineage of the grant they relied on.
  const claimGeneration = CLAIM_BOUND.includes(command.action) || context.mode === 'online' ? facts.claimGeneration : context.grantGeneration;
  bindSignedPayload(p, { recordId: facts.recordId, action: signedAction, eventId: command.eventId, patient: study.patient, studyId: study.studyId,
    managingInstitutionId: study.managingInstitutionId, actingInstitutionId: actor.institutionId, signer: actor.identity,
    identityRegistrationId: actor.identityRegistrationId, author: context.author, previousVersion: expectedPreviousVersion(facts, command.action),
    attachments: context.attachments, claimGeneration, draftRevision: context.ownDraftRevision, reason: command.reason });
  if (command.action === 'amend') {
    if (facts.originalSignerId !== p.signer.id) refuse('AmendSignerRefused');
    // Exclusive end t0+24h (A): the whole uncertainty interval must end before it; touching or crossing it is Addendum-only.
    if (facts.amendUntil === null || boundaryPosition(sig.time.interval, facts.amendUntil) !== 'before') refuse('AmendWindowClosed');
  }
  validatePastEvent(context, sig);
  const version: VersionReference = { recordId: facts.recordId, versionId: p.versionId, sha256: sig.versionSha256 };
  const retained = context.retained;
  if (!retained) refuse('RetainedRecordRequired');
  if (command.action !== 'cancel-preliminary') {
    const e = verifiedRecord(retained.source).event;
    const act = command.preservation === 'correction' || ['amend', 'cancel'].includes(command.action) ? 'correction' : command.action === 'addendum' ? 'additional-entry' : 'entry';
    const previousPart = retained.record?.parts[retained.record.parts.length - 1];
    if (verifiedRecord(retained.source).recordId !== facts.recordId || e.versionId !== p.versionId || e.sha256 !== sig.versionSha256 || e.at !== p.signedAt || e.act !== act ||
        (previousPart && (e.predecessor?.recordId !== facts.recordId || e.predecessor?.partId !== previousPart.partId || e.predecessor?.sha256 !== previousPart.evidence.event.sha256)) ||
        !e.signature || (facts.contentHistory.length > 0) !== (retained.record !== null && retained.graph !== null)) refuse('RetainedRecordRequired');
    if (retained.record) {
      if (retained.record.recordId !== facts.recordId || retained.record.destroyedAt !== null || retained.graph.checkedAt !== p.signedAt)
        refuse('RetainedRecordRequired');
      // Consume A's graph/record validator without inventing a lifecycle transition or exposing a raw append plan.
      retentionState(retained.record, retained.graph, p.signedAt);
    }
  }
  const lifecycleActor: LifecycleActor = { id: actor.identity.id, kind: actor.kind, roles: actor.roles,
    canReadStudy: institutionAllows(actor, study), canSign: actor.canSign, canCancel: actor.canCancel };
  const lifecycle: LifecycleCommand = { action: command.action, actor: lifecycleActor, at: p.signedAt,
    expectedClaimGeneration: command.expectedClaimGeneration, expectedPublishedVersionId: command.expectedPublishedVersionId, version,
    ...(command.reason !== null ? { reason: command.reason } : {}), eventId: command.eventId,
    ...(command.reviewerId !== null ? { reviewerId: command.reviewerId } : {}),
    ...(command.preservation === 'entry' ? { preservationEntry: retained.source } : {}),
    ...(command.preservation === 'correction' ? { preservationCorrection: retained.source } : {}) };
  return Object.freeze({ sig, p, version, lifecycle, retained });
}

/**
 * Tech Note signing (legal register D-3, LR-49/§5-49; wiring into pacs.service saveTechNote is C2). A radiographer's
 * note is a record of their own work: they sign it themselves, and that signature does not stand in for a physician's
 * recording duty. A note written by an administrator only is operational text: it is not signed and no signature is
 * made up for it. Other roles do not write Tech Notes.
 */
export function techNoteSigning(input: VerifiedActor): 'author-signs' | 'unsigned-operational' {
  const actor = parseVerifiedActor(input);
  if (actor.kind !== 'member') refuse('TechNoteAuthorRefused');
  if (actor.roles.includes('technician')) return 'author-signs';
  if (actor.roles.includes('admin')) return 'unsigned-operational';
  return refuse('TechNoteAuthorRefused');
}
export interface TechNoteContext {
  actor: VerifiedActor;
  study: StudyFacts;
  recordId: string;
  /** The stored latest revision of this study's note, or null for the first one. */
  previous: VersionReference | null;
  signature: Readonly<VerifiedSignatureV2> | null;
  receivedAt: string;
  ingress: IngressContext;
}
export function planTechNoteRevision(context: TechNoteContext, input: unknown): Readonly<{
  recordId: string; versionId: string; signing: 'author-signs' | 'unsigned-operational'; clinicalEntry: boolean;
  version: VersionReference | null; envelope: SignatureEnvelopeV2 | null; signedAt: string | null; ledger: readonly LedgerEntry[];
}> {
  const r = object(input, ['versionId', 'text', 'reason', 'eventId', 'envelope']);
  const actor = parseVerifiedActor(context.actor), study = parseStudyFacts(context.study), receivedAt = utc(context.receivedAt);
  const text = string(r.text, true), reason = r.reason === null ? null : string(r.reason), versionId = string(r.versionId), eventId = string(r.eventId);
  if (actor.sessionState !== 'active') refuse('SessionEnded');
  if (!institutionAllows(actor, study)) refuse('InstitutionRefused');
  if (context.previous !== null && (reason === null || !reason.trim())) refuse('RevisionReasonRequired');
  const signing = techNoteSigning(actor);
  const action: AccessAction = context.previous === null ? 'write' : 'modify';
  const occurredAt = (signedAt: string | null) => signedAt ?? receivedAt;
  const entry = (at: string) => {
    const event = parseAccessEvent({ formatVersion: 1, surface: 'POST studies/:uid/tech-note', eventId: `access:${eventId}:${action}`,
      userId: known({ ...actor.identity }), rolesAtTime: known([...actor.roles]), actingInstitution: known(actor.institutionId),
      managingInstitution: known(study.managingInstitutionId), occurredAt: at, trustedProxyIp: context.ingress.ip, cause: 'user-view', executor: 'member',
      targets: [{ kind: 'tech-note', patientLinkSnapshot: known({ ...study.patient }), studyId: known(study.studyId), recordId: known(string(context.recordId)),
        versionId: known(versionId) }], action, result: 'succeeded', requestId: context.ingress.requestId, auditLinkId: newAuditLinkId(), relatedEventId: null });
    return freeze({ kind: 'access-v1' as const, act: STATUTORY_ACT[action], event });
  };
  if (signing === 'unsigned-operational') {
    if (r.envelope !== null || context.signature !== null) refuse('TechNoteSignatureNotApplicable');
    return freeze({ recordId: context.recordId, versionId, signing, clinicalEntry: false, version: null, envelope: null, signedAt: null,
      ledger: [entry(occurredAt(null))] });
  }
  const sig = requireVerifiedV2(context.signature);
  if (!sameEnvelope(r.envelope, sig.envelope)) refuse('SignedEnvelopeMismatch');
  if (sig.time.status !== 'verified') refuse('SignatureTimeUnverified');
  if (sig.keyAtSigningTime !== 'active') refuse('SigningKeyInactive');
  if (!actor.canSign) refuse('SigningAuthorityRequired');
  const p = sig.payload;
  // The signed bytes must be this note: its exact text, this study and record, this author signing for themselves.
  if (p.recordKind !== 'tech-note' || p.recordId !== context.recordId || p.versionId !== versionId || p.eventId !== eventId || p.grant !== null ||
      p.action !== (context.previous === null ? 'record' : 'amend') || p.text.kind !== 'clinical-entry' || p.text.body !== text || p.reason !== reason ||
      JSON.stringify(p.previousVersion) !== JSON.stringify(context.previous) || p.attachments.length !== 0 ||
      !same(p.signer, actor.identity) || !same(p.author, actor.identity) || p.identityRegistrationId !== actor.identityRegistrationId ||
      !same(p.patient, study.patient) || p.studyId !== study.studyId || p.managingInstitutionId !== study.managingInstitutionId ||
      p.actingInstitutionId !== actor.institutionId) refuse('SignedPayloadBindingRefused');
  return freeze({ recordId: context.recordId, versionId, signing, clinicalEntry: true,
    version: { recordId: context.recordId, versionId, sha256: sig.versionSha256 }, envelope: { ...sig.envelope }, signedAt: p.signedAt,
    ledger: [entry(occurredAt(p.signedAt))] });
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
