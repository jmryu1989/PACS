import { EvidenceFact, ImmutableIdentity, PatientLinkSnapshot, identity, patientLink } from '../emr-contract/access-event';
import type { AccessEvent, CauseKind, WorkContext } from '../emr-contract/access-event';
import type { ResolvedRecord } from '../emr-contract/classification';
import type { RetentionGraph, RetentionRecord } from '../emr-contract/lawful-defaults';
import type { ReportFacts, RetentionOnlyEvent } from '../emr-contract/report-lifecycle';
import { choice, freeze, integer, object, string } from '../emr-contract/validation';

/**
 * Online report identity, study and read contracts: every fact that decides authority comes from a server port
 * (identity/authority snapshot, stored study and report facts, stored retention inputs).
 * Nothing here opens a route or a transaction.
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

export type LedgerEntry = Readonly<
  { kind: 'access-v1'; act: '기재' | '추가기재' | '수정' | '열람' | 'none'; event: Readonly<AccessEvent> }
>;
