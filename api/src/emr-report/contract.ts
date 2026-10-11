import { EvidenceFact, ImmutableIdentity, PatientLinkSnapshot, identity, patientLink } from '../emr-contract/access-event';
import type { AccessEvent, CauseKind, WorkContext } from '../emr-contract/access-event';
import type { ResolvedRecord } from '../emr-contract/classification';
import type { RetentionGraph, RetentionRecord } from '../emr-contract/lawful-defaults';
import type { LifecycleOutcome, ReportFacts, RetentionOnlyEvent } from '../emr-contract/report-lifecycle';
import type { VersionReference } from '../emr-contract/signature';
import { choice, freeze, integer, object, sha256, string, utc } from '../emr-contract/validation';
import type { OfflineAccessObservation } from '../emr-signature/native-port';
import type { SignatureEnvelopeV2 } from '../emr-signature/contract';

/**
 * EMR-C1 report flow contracts. Pure planning only: every fact that decides authority comes from a server port
 * (B2 identity/authority snapshot, stored study and report facts, stored retention inputs). C2 implements the ports
 * against the real database and B's protected ledger; nothing here opens a route or a transaction.
 */

/** B2's verified identity and authority snapshot for the current session. Request JSON never supplies these. */
export interface VerifiedActor {
  identity: ImmutableIdentity;
  identityRegistrationId: string;
  kind: 'member' | 'service';
  roles: readonly string[];
  institutionId: string;
  canSign: boolean;
  canCancel: boolean;
  rightsVersion: string;
  sessionState: 'active' | 'ended';
}
export function parseVerifiedActor(input: unknown): Readonly<VerifiedActor> {
  const v = object(input, ['identity', 'identityRegistrationId', 'kind', 'roles', 'institutionId', 'canSign', 'canCancel', 'rightsVersion', 'sessionState']);
  if (!Array.isArray(v.roles) || new Set(v.roles).size !== v.roles.length || typeof v.canSign !== 'boolean' || typeof v.canCancel !== 'boolean')
    throw new Error('Verified authority snapshot required');
  return freeze({ identity: identity(v.identity), identityRegistrationId: string(v.identityRegistrationId), kind: choice(v.kind, ['member', 'service']),
    roles: v.roles.map(r => string(r)), institutionId: string(v.institutionId), canSign: v.canSign, canCancel: v.canCancel,
    rightsVersion: string(v.rightsVersion), sessionState: choice(v.sessionState, ['active', 'ended']) });
}

/** Stored study facts: patient link snapshot, managing institution and the institutions entitled to read it. */
export interface StudyFacts {
  studyId: string; patient: PatientLinkSnapshot; managingInstitutionId: string; readingInstitutionIds: readonly string[];
  assignment: { readerId: string | null; generation: number };
}
export function parseStudyFacts(input: unknown): Readonly<StudyFacts> {
  const v = object(input, ['studyId', 'patient', 'managingInstitutionId', 'readingInstitutionIds', 'assignment']);
  const a = object(v.assignment, ['readerId', 'generation']);
  if (!Array.isArray(v.readingInstitutionIds) || !v.readingInstitutionIds.length) throw new Error('Reading institutions required');
  return freeze({ studyId: string(v.studyId), patient: patientLink(v.patient), managingInstitutionId: string(v.managingInstitutionId),
    readingInstitutionIds: v.readingInstitutionIds.map(i => string(i)), assignment: { readerId: a.readerId === null ? null : string(a.readerId), generation: integer(a.generation) } });
}
/** Institution and role are separate checks (AGENTS §1.4/1.5): admin is not an exception to either. */
export function institutionAllows(actor: VerifiedActor, study: StudyFacts): boolean {
  return study.readingInstitutionIds.includes(actor.institutionId);
}

/** Server-loaded facts only, never request JSON. U5 currently binds a session, not a study: absent a server
 * work-study binding, callers must leave workStudy null. The C2 adapter must not infer it from a client UID. */
export interface ReportWorkContext {
  workStudy: Pick<StudyFacts, 'studyId' | 'patient'> | null;
}

/** D-18 describes observed work; it does not grant access. Reuse the facts loaded for this plan, without another read. */
export function workContextFor(input: ReportWorkContext & {
  actor: VerifiedActor; study: StudyFacts; facts?: Pick<ReportFacts, 'studyId' | 'preliminary'>; cause?: CauseKind;
}): Readonly<WorkContext> | null {
  const { actor, study, facts, workStudy } = input;
  const cause = input.cause ?? 'user-view';
  const context = (basis: WorkContext['basis'], studyId = study.studyId, relatedStudyId: string | null = null) =>
    freeze({ basis, studyId, relatedStudyId, reason: null });
  if (cause === 'service-job') return actor.kind === 'service' ? context('service-job') : null;
  if (cause === 'background-fetch') return context('background-fetch');
  if (actor.kind !== 'member' || !institutionAllows(actor, study)) return null;
  const preliminary = facts?.studyId === study.studyId ? facts.preliminary : null;
  if (study.assignment.readerId === actor.identity.id ||
      preliminary?.authorId === actor.identity.id || preliminary?.reviewerId === actor.identity.id)
    return context('assigned-reading');
  if (workStudy && workStudy.studyId !== study.studyId &&
      workStudy.patient.linkId === study.patient.linkId && workStudy.patient.patientId === study.patient.patientId &&
      workStudy.patient.assigningAuthority === study.patient.assigningAuthority)
    return context('same-patient-comparison', workStudy.studyId, study.studyId);
  return context('worklist');
}

/** A's retention inputs, loaded by C2's store under the retention lock; C never builds them from request data. */
export interface RetainedInputs {
  record: RetentionRecord | null;
  source: ResolvedRecord;
  graph: RetentionGraph | null;
  archive: RetentionOnlyEvent | null;
}
/** Every read carries the unit's stored retention record and the read instant (L5-04). */
export interface RetainedRead { record: RetentionRecord; at: string }

/** Server ingress context supplied by B (trusted proxy context, correlation ID). */
export interface IngressContext { requestId: string; ip: EvidenceFact<{ address: string; source: 'trusted-proxy' }> }

/** A server-side record that an offline event arrived, carrying the reconnect address the offline event never had. */
export interface OfflineReceiptEvent {
  formatVersion: 'emr-offline-receipt/1';
  eventId: string;
  relatedEventId: string;
  receivedAt: string;
  sessionSubject: string;
  ip: { status: 'known'; value: { address: string; source: 'trusted-proxy' } };
}
export type LedgerEntry = Readonly<
  { kind: 'access-v1'; act: '기재' | '추가기재' | '수정' | '열람' | 'none'; event: Readonly<AccessEvent> } |
  { kind: 'offline-observation'; act: '기재' | '추가기재' | '수정' | '열람' | 'none'; event: Readonly<OfflineAccessObservation> } |
  { kind: 'offline-receipt'; act: 'none'; event: Readonly<OfflineReceiptEvent> }
>;

export interface ReportTimes { signedAt: string | null; receivedAt: string; committedAt: string | null; publishedAt: string | null }

/** Authenticated storage evidence of clinical adoption, not a custody-only acknowledgement. */
export interface AdoptedEvent {
  eventId: string; studyId: string; institutionId: string; version: VersionReference; signedAt: string;
  deviceId: string; deviceSequence: number; predecessorEventId: string | null; ancestors: readonly string[];
  receipt: CommitReceipt;
}
export function parseAdoptedEvent(input: unknown): Readonly<AdoptedEvent> {
  const v = object(input, ['eventId', 'studyId', 'institutionId', 'version', 'signedAt', 'deviceId', 'deviceSequence', 'predecessorEventId', 'ancestors', 'receipt']);
  const ref = object(v.version, ['recordId', 'versionId', 'sha256']), receipt = parseCommitReceipt(v.receipt);
  if (!Array.isArray(v.ancestors) || new Set(v.ancestors).size !== v.ancestors.length || v.ancestors.includes(v.eventId) ||
      (v.predecessorEventId !== null && !v.ancestors.includes(v.predecessorEventId)) ||
      receipt.eventId !== v.eventId || receipt.recordId !== ref.recordId || receipt.versionId !== ref.versionId)
    throw new Error('Adoption evidence binding required');
  return freeze({ eventId: string(v.eventId), studyId: string(v.studyId), institutionId: string(v.institutionId),
    version: { recordId: string(ref.recordId), versionId: string(ref.versionId), sha256: sha256(ref.sha256) }, signedAt: utc(v.signedAt),
    deviceId: string(v.deviceId), deviceSequence: integer(v.deviceSequence),
    predecessorEventId: v.predecessorEventId === null ? null : string(v.predecessorEventId), ancestors: v.ancestors.map(x => string(x)), receipt });
}

/**
 * Everything one report event commits in ONE transaction: version + exact signature bytes, report facts, publication
 * reference, retention decision, ledger entries and the idempotency receipt. A store that writes these in separate
 * transactions does not implement this contract.
 */
export interface CommitPlan {
  eventId: string;
  contentDigest: string;
  recordId: string;
  studyId: string;
  expected: { claimGeneration: number; publishedVersionId: string | null; draftRevision: string | null; historyDigest?: string; rightsVersion?: string };
  facts: Readonly<ReportFacts>;
  effects: LifecycleOutcome['effects'];
  version: { ref: VersionReference; action: string; envelope: SignatureEnvelopeV2; signedAt: string } | null;
  draft: { author: string; expectedRevision: string | null; revision: string; text: { findings: string; conclusion: string; recommendation: string } } | null;
  retention: Readonly<RetentionRecord> | null;
  ledger: readonly LedgerEntry[];
  publish: boolean;
  times: ReportTimes;
  adoption?: Omit<AdoptedEvent, 'receipt'>;
}

export interface CommitReceipt {
  eventId: string; contentDigest: string; recordId: string; versionId: string | null;
  committedAt: string; publishedAt: string | null; ledgerReceipts: readonly { eventId: string; durableAt: string }[];
}
export function parseCommitReceipt(input: unknown): Readonly<CommitReceipt> {
  const v = object(input, ['eventId', 'contentDigest', 'recordId', 'versionId', 'committedAt', 'publishedAt', 'ledgerReceipts']);
  if (!Array.isArray(v.ledgerReceipts)) throw new Error('Ledger receipts required');
  return freeze({ eventId: string(v.eventId), contentDigest: sha256(v.contentDigest), recordId: string(v.recordId),
    versionId: v.versionId === null ? null : string(v.versionId), committedAt: utc(v.committedAt), publishedAt: v.publishedAt === null ? null : utc(v.publishedAt),
    ledgerReceipts: v.ledgerReceipts.map(r => { const x = object(r, ['eventId', 'durableAt']); return { eventId: string(x.eventId), durableAt: utc(x.durableAt) }; }) });
}

/** C2 implements this against PostgreSQL + B's ledger in one transaction; a duplicate eventId is rejected atomically. */
export interface ReportStorePort {
  findReceipt(eventId: string): Promise<unknown>;
  commit(plan: Readonly<CommitPlan>): Promise<unknown>;
}
/** B's protected failure path outside the business rollback. */
export interface FailureJournalPort { record(failure: { eventId: string; code: string; at: string }): Promise<{ journalId: string; durableAt: string }> }

/** The answer for any queued/offline event. It never carries another person's draft or a body the caller may not read. */
export interface ReportEventResponse {
  eventId: string;
  status: 'committed' | 'duplicate' | 'conflict' | 'held' | 'refused' | 'failed';
  reason: string | null;
  recoveryRef: string | null;
  currentVersion: VersionReference | null;
  times: ReportTimes;
  adoption?: Readonly<AdoptedEvent> | null;
}
