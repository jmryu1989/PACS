import { AccessEvent, AppendOnlyAccessStore, DurableAccessReceipt, STATUTORY_ACT, newAuditLinkId, parseAccessEvent, provideAfterDurableEvent } from '../emr-contract/access-event';
import { ReportFacts, RetentionOnlyEvent, ResumeClinicalUseEvent, validateReportFacts } from '../emr-contract/report-lifecycle';
import type { VersionReference } from '../emr-contract/signature';
import { choice, freeze, object, refuse, string, utc } from '../emr-contract/validation';
import { IngressContext, LedgerEntry, StudyFacts, VerifiedActor, institutionAllows, parseStudyFacts, parseVerifiedActor } from './contract';
import { readRetention } from './retention';

/**
 * Report reads. Opening a study requests its own report body automatically (no extra click); the body is sent only
 * after B's durable provide-prepared receipt. Authorising a request is not a read, displaying it is a separate client
 * report, and an acknowledgement is bound to the exact version it acknowledged.
 */
export const READ_SURFACES = freeze({
  reader: 'GET studies/:uid/report/versions',
  clinician: 'GET clinician/studies/:uid/report',
  preview: 'GET studies/:uid/report-preview',
} as const);
export type ReadSurface = keyof typeof READ_SURFACES;

export interface ReadContext {
  actor: VerifiedActor;
  /** The server's existing role decision for this surface (need(), AGENTS §1.5); C keeps no second role table. */
  roleAllowed: boolean;
  study: StudyFacts;
  facts: ReportFacts;
  archive: RetentionOnlyEvent | null;
  resume: ResumeClinicalUseEvent | null;
  /** {record, at}: required on every read (L5-04). */
  retained: unknown;
  ingress: IngressContext;
  now: string;
}

const known = <T>(value: T) => ({ status: 'known' as const, value });
function retainedVersions(facts: ReportFacts): readonly VersionReference[] {
  return facts.contentHistory.map(h => h.version);
}

function event(ctx: ReadContext, surface: string, action: 'provide-prepared' | 'client-shown' | 'explicit-ack' | 'print-opened' | 'print-done',
  version: { recordId: string; versionId: string }, occurredAt: string, relatedEventId: string | null, eventId: string): Readonly<AccessEvent> {
  const kind = surface === READ_SURFACES.preview && action.startsWith('print') ? 'print' : 'report-version';
  return parseAccessEvent({ formatVersion: 1, surface, eventId, userId: known({ ...ctx.actor.identity }), rolesAtTime: known([...ctx.actor.roles]),
    actingInstitution: known(ctx.actor.institutionId), managingInstitution: known(ctx.study.managingInstitutionId), occurredAt,
    trustedProxyIp: ctx.ingress.ip, cause: 'user-view', executor: 'member',
    targets: [{ kind, patientLinkSnapshot: known({ ...ctx.study.patient }), studyId: known(ctx.study.studyId), recordId: known(version.recordId),
      versionId: known(version.versionId) }],
    action, result: action === 'provide-prepared' ? 'prepared' : ['client-shown', 'print-done'].includes(action) ? 'reported' : 'succeeded',
    requestId: ctx.ingress.requestId, auditLinkId: newAuditLinkId(), relatedEventId });
}

export interface ReadPlan { version: VersionReference; surface: string; event: Readonly<AccessEvent>; ledger: LedgerEntry }
/**
 * Decide what one read may serve. Role and institution are checked separately; Preliminary and cancelled-only units have
 * no published body for clinicians; a retention-only unit is not served for ordinary clinical use.
 */
export function planReportRead(context: ReadContext, input: unknown): Readonly<ReadPlan> {
  const r = object(input, ['surface', 'versionId', 'eventId']);
  const surfaceKey = choice(r.surface, Object.keys(READ_SURFACES) as ReadSurface[]);
  const actor = parseVerifiedActor(context.actor), study = parseStudyFacts(context.study), facts = context.facts;
  validateReportFacts(facts);
  if (actor.sessionState !== 'active') refuse('SessionEnded');
  if (facts.studyId !== study.studyId) refuse('RecordBindingRefused');
  if (!institutionAllows(actor, study)) refuse('InstitutionRefused');
  if (context.roleAllowed !== true) refuse('RoleRefused');
  const reader = actor.roles.includes('radiologist');
  const access = readRetention(facts, context.archive, context.resume, context.retained);
  if (!access.ordinaryClinicalAccess) refuse('RetentionOnlyAccessRefused');
  const published = facts.publishedVersion;
  const requested = r.versionId === null ? published : retainedVersions(facts).find(v => v.versionId === string(r.versionId)) ?? null;
  if (requested === null) refuse(published === null ? 'NoPublishedReport' : 'VersionNotRetained');
  // Clinicians see what was published; a Preliminary or a later private draft is never their read.
  if (!reader && (published === null || !['Approved', 'Finalized', 'Cancelled'].includes(facts.state))) refuse('NoPublishedReport');
  const surface = READ_SURFACES[surfaceKey];
  const ev = event({ ...context, actor, study }, surface, 'provide-prepared', requested, utc(context.now), null, string(r.eventId));
  return freeze({ version: { ...requested }, surface, event: ev, ledger: freeze({ kind: 'access-v1' as const, act: STATUTORY_ACT['provide-prepared'], event: ev }) });
}

/** First body byte strictly after the durable receipt for this exact prepared event (A's gate). */
export async function serveReportRead<T>(plan: Readonly<ReadPlan>, ledger: AppendOnlyAccessStore, sendBody: (receipt: DurableAccessReceipt) => Promise<T>): Promise<T> {
  return provideAfterDurableEvent(ledger, plan.event, sendBody);
}

/** The client reported that it displayed the body: a separate event, also for a cache re-display. */
export function displayReported(context: ReadContext, plan: Readonly<ReadPlan>, at: string, eventId: string): Readonly<AccessEvent> {
  return event(context, plan.surface, 'client-shown', plan.version, utc(at), plan.event.eventId, string(eventId));
}

/** List, bootstrap, polling and conflict answers carry state and version references only, never report or draft text. */
export function listProjection(facts: ReportFacts, ownDraftPresent: boolean): Readonly<{
  recordId: string; state: string; publishedVersionId: string | null; amendedAt: string | null; ownDraftPresent: boolean;
}> {
  validateReportFacts(facts);
  const amended = facts.contentHistory.filter(h => h.action === 'amend' && h.use === 'clinical');
  return freeze({ recordId: facts.recordId, state: facts.state, publishedVersionId: facts.publishedVersion?.versionId ?? null,
    amendedAt: amended.length ? amended[amended.length - 1].at : null, ownDraftPresent: ownDraftPresent === true });
}

/**
 * Print/preview observations: the request is pinned to one version; only what was observed is recorded. A returned
 * print dialog is a client report (print-done), never proof that paper came out.
 */
export function printRequested(context: ReadContext, plan: Readonly<ReadPlan>, pinnedVersionId: string, at: string, eventId: string): Readonly<AccessEvent> {
  if (plan.surface !== READ_SURFACES.preview || plan.version.versionId !== string(pinnedVersionId)) refuse('PrintVersionMismatch');
  return event(context, READ_SURFACES.preview, 'print-opened', plan.version, utc(at), plan.event.eventId, string(eventId));
}
export function printReported(context: ReadContext, opened: Readonly<AccessEvent>, outcome: 'dialog-returned' | 'cancelled', at: string, eventId: string):
  Readonly<{ event: Readonly<AccessEvent> | null; physicalOutput: 'not-observed'; outcome: 'dialog-returned' | 'cancelled' }> {
  choice(outcome, ['dialog-returned', 'cancelled']);
  if (opened.action !== 'print-opened') refuse('PrintSequenceRefused');
  const target = opened.targets[0];
  if (target.recordId.status !== 'known' || target.versionId.status !== 'known') refuse('PrintSequenceRefused');
  const version = { recordId: target.recordId.value, versionId: target.versionId.value };
  const ev = outcome === 'cancelled' ? null : event(context, READ_SURFACES.preview, 'print-done', version, utc(at), opened.eventId, string(eventId));
  return freeze({ event: ev, physicalOutput: 'not-observed' as const, outcome });
}

/** An acknowledgement belongs to one version; a newer published version is unacknowledged until acknowledged itself. */
export function acknowledgementState(acks: readonly { versionId: string; at: string; actorId: string }[], published: VersionReference | null): Readonly<{
  current: 'acknowledged' | 'not-acknowledged' | 'nothing-published'; earlierVersions: readonly string[];
}> {
  if (published === null) return freeze({ current: 'nothing-published' as const, earlierVersions: [] });
  const current = acks.some(a => a.versionId === published.versionId) ? 'acknowledged' as const : 'not-acknowledged' as const;
  return freeze({ current, earlierVersions: [...new Set(acks.filter(a => a.versionId !== published.versionId).map(a => a.versionId))] });
}
