import { resolveAccessRecord } from './composition';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { RECORD_CLASSIFICATION, RecordKind, resolveStoredRecord, ResolvedRecord, verifiedRecord } from './classification';
import { newAccessRetentionRecord } from './lawful-defaults';
import { routeContract, EXTERNAL_SURFACES, INTERNAL_SURFACES, ROUTE_CONTRACTS } from './routes';
import { choice, freeze, integer, object, sha256, string, utc, refuse } from './validation';

export const ACCESS_ACTIONS = freeze({
  write: ['write', 'additional-entry', 'modify', 'approve-sign', 'amend', 'addendum', 'cancel', 'release', 'draft-save', 'clear', 'discard', 'finalize', 'archive', 'resume-clinical-use', 'extend-retention', 'legal-hold', 'lift-legal-hold', 'destroy'],
  read: ['provide-prepared', 'transfer-ended', 'transfer-aborted', 'client-shown', 'explicit-ack'],
  export: ['print-opened', 'print-done', 'pdf', 'copy', 'download', 'disclosure'],
  failure: ['auth-refused', 'permission-refused', 'conflict', 'storage-failed', 'signature-failed'],
} as const);
/** Closed non-patient targets. Everything else requires patient/study/record/version facts on success. */
export const NON_RECORD_TARGETS: readonly RecordKind[] = freeze(['preferences', 'reading-template', 'institution',
  'identity-access', 'authentication-session', 'system-operation']);
export const STATUTORY_ACT = freeze({
  write: '기재', 'additional-entry': '추가기재', modify: '수정', 'approve-sign': '기재', amend: '수정', addendum: '추가기재', cancel: '수정',
  release: 'none', 'draft-save': '기재', clear: '수정', discard: '수정', finalize: 'none', archive: 'none',
  'resume-clinical-use': 'none', 'extend-retention': 'none', 'legal-hold': 'none', 'lift-legal-hold': 'none', destroy: 'none',
  'provide-prepared': '열람', 'transfer-ended': '열람', 'transfer-aborted': '열람', 'client-shown': '열람', 'explicit-ack': '열람',
  'print-opened': '열람', 'print-done': '열람', pdf: '열람', copy: '열람', download: '열람', disclosure: '열람',
  'auth-refused': 'none', 'permission-refused': 'none', conflict: 'none', 'storage-failed': 'none', 'signature-failed': 'none',
} satisfies Record<AccessAction, '기재' | '추가기재' | '수정' | '열람' | 'none'>);
export type AccessAction = typeof ACCESS_ACTIONS[keyof typeof ACCESS_ACTIONS][number];
export type CauseKind = 'user-view' | 'background-fetch' | 'service-job';
export type EvidenceFact<T> = Readonly<
  { status: 'known'; value: T } |
  { status: 'unresolved'; reason: 'not-authenticated' | 'not-resolved' | 'not-observed' } |
  { status: 'not-applicable'; reason: 'non-record-target' | 'in-process-service' }
>;
export interface ImmutableIdentity { id: string; issuer: string; subject: string }
export interface PatientLinkSnapshot { linkId: string; patientId: string; assigningAuthority: string }
export interface AccessTarget {
  kind: RecordKind;
  patientLinkSnapshot: EvidenceFact<PatientLinkSnapshot>;
  studyId: EvidenceFact<string>;
  recordId: EvidenceFact<string>;
  versionId: EvidenceFact<string>;
}
export interface AccessEventV1 {
  formatVersion: 1;
  surface: string;
  eventId: string;
  userId: EvidenceFact<ImmutableIdentity>;
  rolesAtTime: EvidenceFact<readonly string[]>;
  actingInstitution: EvidenceFact<string>;
  managingInstitution: EvidenceFact<string>;
  occurredAt: string;
  trustedProxyIp: EvidenceFact<{ address: string; source: 'trusted-proxy' }>;
  cause: CauseKind;
  /** D-18: the business context the server bound to this access (one-line reason only out of context). */
  context: Readonly<WorkContext>;
  executor: 'member' | 'service' | 'unauthenticated';
  targets: readonly AccessTarget[];
  action: AccessAction;
  result: 'prepared' | 'succeeded' | 'aborted' | 'refused' | 'failed' | 'reported';
  requestId: string;
  auditLinkId: string;
  relatedEventId: string | null;
}

export function identity(value: unknown): ImmutableIdentity {
  const v = object(value, ['id', 'issuer', 'subject']);
  return { id: string(v.id), issuer: string(v.issuer), subject: string(v.subject) };
}
export function patientLink(value: unknown): PatientLinkSnapshot {
  const v = object(value, ['linkId', 'patientId', 'assigningAuthority']);
  return { linkId: string(v.linkId), patientId: string(v.patientId), assigningAuthority: string(v.assigningAuthority) };
}
function fact<T>(input: unknown, parse: (value: unknown) => T): EvidenceFact<T> {
  if (!input || typeof input !== 'object') throw new Error('Evidence fact missing');
  const status = (input as any).status;
  if (status === 'known') { const v = object(input, ['status', 'value']); return { status, value: parse(v.value) }; }
  const v = object(input, ['status', 'reason']);
  if (status === 'unresolved') return { status, reason: choice(v.reason, ['not-authenticated', 'not-resolved', 'not-observed']) };
  if (status === 'not-applicable') return { status, reason: choice(v.reason, ['non-record-target', 'in-process-service']) };
  throw new Error('Unknown evidence status');
}

const actions = Object.values(ACCESS_ACTIONS).flat() as readonly AccessAction[];
const readFollowups: readonly AccessAction[] = ['transfer-ended', 'transfer-aborted', 'client-shown', 'explicit-ack'];
export function accessPersistence(action: AccessAction): 'business-transaction' | 'before-body' | 'independent-failure' | 'independent-followup' {
  choice(action, actions);
  if ((ACCESS_ACTIONS.failure as readonly string[]).includes(action)) return 'independent-failure';
  if (action === 'provide-prepared') return 'before-body';
  if ((ACCESS_ACTIONS.write as readonly string[]).includes(action)) return 'business-transaction';
  return 'independent-followup';
}

/** Generated independently of credentials; auth middleware must never accept this namespace. */
export function newAuditLinkId(): string { return `audit:${randomUUID()}`; }

const servedManifests = new WeakMap<object, readonly ResolvedRecord[]>();
/** On mixed surfaces B supplies the rows actually served, in target order, from its bound storage capability.
 * Rehydrating a persisted mixed event likewise requires its server-verified row manifest.
 * formatVersion 1 keeps its original fields and rules, plus D-18's required work context; 2 is the closed EMR-B branch set below.
 */
export function parseAccessEvent(input: unknown, served?: readonly ResolvedRecord[]): Readonly<AccessEvent> {
  // Read the discriminator without running a getter; the selected parser validates the whole object.
  const version = input && typeof input === 'object' && !Array.isArray(input) ?
    Object.getOwnPropertyDescriptor(input, 'formatVersion')?.value : undefined;
  return version === 2 ? parseAccessEventV2(input, served) : parseAccessEventV1(input, served);
}
function expectedResult(action: AccessAction): AccessEventV1['result'] {
  const failure = accessPersistence(action) === 'independent-failure';
  return action === 'provide-prepared' ? 'prepared' : action === 'transfer-aborted' ? 'aborted' :
    ['auth-refused', 'permission-refused'].includes(action) ? 'refused' : failure ? 'failed' :
    ['client-shown', 'print-done', 'pdf', 'copy'].includes(action) ? 'reported' : 'succeeded';
}
function surfaceKindsOf(surface: string): readonly RecordKind[] {
  return Object.prototype.hasOwnProperty.call(EXTERNAL_SURFACES, surface) ? EXTERNAL_SURFACES[surface] : routeContract(surface).kinds;
}
function parseTargets(input: unknown, surfaceKinds: readonly RecordKind[], manifest: readonly ResolvedRecord[] | undefined, failure: boolean): AccessTarget[] {
  if (!Array.isArray(input)) throw new Error('Actual returned target set required');
  return input.map((target, index) => {
    const t = object(target, ['kind', 'patientLinkSnapshot', 'studyId', 'recordId', 'versionId']);
    const kind = choice(t.kind, Object.keys(RECORD_CLASSIFICATION) as RecordKind[]);
    if (manifest) {
      const source = verifiedRecord(manifest[index]);
      if (!source.kinds.includes(kind)) refuse('AccessTargetBindingRefused');
      if (!NON_RECORD_TARGETS.includes(kind) && (t.recordId?.value !== source.recordId || t.versionId?.value !== source.event.versionId)) refuse('AccessTargetBindingRefused');
    }
    if (!surfaceKinds.includes(kind)) throw new Error('Target kind does not belong to the server route');
    const parsed = { kind, patientLinkSnapshot: fact(t.patientLinkSnapshot, patientLink), studyId: fact(t.studyId, value => string(value)),
      recordId: fact(t.recordId, value => string(value)), versionId: fact(t.versionId, value => string(value)) };
    const facts = [parsed.patientLinkSnapshot, parsed.studyId, parsed.recordId, parsed.versionId];
    if (facts.some(f => f.status === 'not-applicable' && (!NON_RECORD_TARGETS.includes(kind) || f.reason !== 'non-record-target')))
      throw new Error('Patient-bearing record facts cannot be waived');
    if (!failure && facts.some(f => f.status === 'unresolved')) throw new Error('Successful provision requires resolved targets');
    return parsed;
  });
}
function parseAccessEventV1(input: unknown, served?: readonly ResolvedRecord[]): Readonly<AccessEventV1> {
  const v = object(input, ['formatVersion', 'surface', 'eventId', 'userId', 'rolesAtTime', 'actingInstitution', 'managingInstitution', 'occurredAt',
    'trustedProxyIp', 'cause', 'context', 'executor', 'targets', 'action', 'result', 'requestId', 'auditLinkId', 'relatedEventId']);
  if (v.formatVersion !== 1) throw new Error('Unknown access format');
  const surface = string(v.surface);
  const surfaceKinds = surfaceKindsOf(surface);
  const action = choice(v.action, actions);
  const failure = accessPersistence(action) === 'independent-failure';
  const mixed = surfaceKinds.some(k => NON_RECORD_TARGETS.includes(k)) && surfaceKinds.some(k => !NON_RECORD_TARGETS.includes(k));
  const manifest = served ?? servedManifests.get(v);
  if (mixed && !failure && (!manifest || manifest.length !== v.targets?.length)) refuse('ServedRecordManifestRequired');
  const result = choice(v.result, ['prepared', 'succeeded', 'aborted', 'refused', 'failed', 'reported']);
  if (result !== expectedResult(action)) throw new Error('Event result does not describe the observed stage');
  const userId = fact(v.userId, identity);
  const rolesAtTime = fact(v.rolesAtTime, roles => {
    if (!Array.isArray(roles) || !roles.length || new Set(roles).size !== roles.length) throw new Error('Roles missing or duplicated');
    return roles.map(role => string(role));
  });
  const actingInstitution = fact(v.actingInstitution, value => string(value));
  const managingInstitution = fact(v.managingInstitution, value => string(value));
  const trustedProxyIp = fact(v.trustedProxyIp, value => {
    const ip = object(value, ['address', 'source']);
    if (isIP(ip.address) === 0 || ip.source !== 'trusted-proxy') throw new Error('Trusted proxy IP required');
    return { address: ip.address as string, source: 'trusted-proxy' as const };
  });
  const executor = choice(v.executor, ['member', 'service', 'unauthenticated']);
  const cause = choice(v.cause, ['user-view', 'background-fetch', 'service-job']);
  const inProcess = executor === 'service' && cause === 'service-job' && trustedProxyIp.status === 'not-applicable' && trustedProxyIp.reason === 'in-process-service';
  if ((!failure && [userId, rolesAtTime, actingInstitution, managingInstitution].some(f => f.status !== 'known')) ||
      (!failure && trustedProxyIp.status !== 'known' && !inProcess) ||
      (trustedProxyIp.status === 'not-applicable' && !inProcess) ||
      (executor === 'unauthenticated' && (action !== 'auth-refused' || userId.status !== 'unresolved')) ||
      (action === 'auth-refused' && executor !== 'unauthenticated') ||
      (cause === 'service-job' && executor !== 'service')) throw new Error('Unresolved or inconsistent actor context');
  const context = workContext(v.context, cause, action === 'auth-refused');
  const targets = parseTargets(v.targets, surfaceKinds, manifest, failure);
  const auditLinkId = string(v.auditLinkId);
  if (!AUDIT_LINK.test(auditLinkId)) throw new Error('Invalid audit link ID');
  const relatedEventId = v.relatedEventId === null ? null : string(v.relatedEventId);
  if ((readFollowups.includes(action) || action === 'print-done') && relatedEventId === null) throw new Error('Preceding event reference required');
  if (relatedEventId === v.eventId) throw new Error('Event cannot reference itself');
  const parsed = freeze({ formatVersion: 1 as const, surface, eventId: string(v.eventId), userId, rolesAtTime, actingInstitution, managingInstitution,
    occurredAt: utc(v.occurredAt), trustedProxyIp, cause, context, executor, targets, action, result, requestId: string(v.requestId), auditLinkId, relatedEventId });
  if (manifest) servedManifests.set(parsed, Object.freeze([...manifest]));
  return parsed;
}
/**
 * D-18 (legal register / delta map MAP-D18) [PREDICTED-CONSERVATIVE]: every access event names the business context the
 * server observed, bound from the work context - reading an assigned study, comparing a same-patient prior, a clinical
 * request, the worklist, a background fetch for the current work, an in-process job, authentication. Nothing is typed in
 * the normal flow. Only an access outside every context carries one explicit line of reason (break-glass). The context is
 * part of the hashed event and is never a permission: authorization is decided before and apart from it.
 */
export const WORK_CONTEXTS = freeze(['assigned-reading', 'same-patient-comparison', 'clinical-request', 'worklist',
  'background-fetch', 'service-job', 'authentication', 'out-of-context'] as const);
export type WorkContextBasis = typeof WORK_CONTEXTS[number];
export interface WorkContext { basis: WorkContextBasis; studyId: string | null; relatedStudyId: string | null; reason: string | null }
export const OUT_OF_CONTEXT_REASON_MAX = 200;
const MEMBER_CONTEXTS: readonly WorkContextBasis[] = freeze(['assigned-reading', 'same-patient-comparison', 'clinical-request', 'worklist', 'out-of-context']);
function workContext(input: unknown, cause: CauseKind, authentication: boolean): Readonly<WorkContext> {
  const c = object(input, ['basis', 'studyId', 'relatedStudyId', 'reason']);
  const basis = choice(c.basis, WORK_CONTEXTS);
  const studyId = c.studyId === null ? null : string(c.studyId);
  const relatedStudyId = c.relatedStudyId === null ? null : string(c.relatedStudyId);
  const reason = c.reason === null ? null : string(c.reason);
  // The cause and the context name the same fact; an authentication step has its own context.
  const expected: readonly WorkContextBasis[] = cause === 'service-job' ? ['service-job'] : cause === 'background-fetch' ? ['background-fetch'] :
    authentication ? ['authentication'] : MEMBER_CONTEXTS;
  if (!expected.includes(basis)) refuse('WorkContextMismatch');
  if (basis === 'out-of-context') {
    if (reason === null || reason !== reason.trim() || /[\r\n\u2028\u2029]/.test(reason) || reason.length > OUT_OF_CONTEXT_REASON_MAX)
      refuse('OutOfContextReasonRequired');
  } else if (reason !== null) refuse('ReasonOnlyOutOfContext');
  if ((basis === 'assigned-reading' || basis === 'clinical-request') && (studyId === null || relatedStudyId !== null)) refuse('WorkContextStudyRequired');
  if (basis === 'same-patient-comparison' && (studyId === null || relatedStudyId === null || studyId === relatedStudyId)) refuse('WorkContextStudyRequired');
  if (basis !== 'same-patient-comparison' && relatedStudyId !== null) refuse('WorkContextStudyRequired');
  return freeze({ basis, studyId, relatedStudyId, reason });
}
const AUDIT_LINK = /^audit:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ── formatVersion 2 (EMR-B1, D596) ──
// Two closed branches. `online-auth` is a U5 authentication fact; it never names clinical targets and never passes as a
// clinical write. `verified-offline` is a clinical act that happened on a registered device while disconnected; it is
// admitted only through the verification capability composed at server start (none until C ships real key/signature
// verification, so the branch is refused as unsupported). v1 parsing and results are unchanged apart from D-18's context.
export const AUTH_ACTIONS = freeze(['auth.login', 'auth.entry', 'auth.logout', 'auth.session.expired'] as const);
export type AuthAction = typeof AUTH_ACTIONS[number];
/** 의료법 제23조④ 대상 행위가 아니라 접속·인증 사실이다. none은 사건 생략이 아니다. */
export const AUTH_STATUTORY_ACT = freeze({ 'auth.login': 'none', 'auth.entry': 'none', 'auth.logout': 'none', 'auth.session.expired': 'none' } satisfies Record<AuthAction, 'none'>);
export const AUTH_END_CAUSES = freeze({
  'auth.logout': ['logout', 'account-switch', 'reauthentication', 'isolation'],
  'auth.session.expired': ['idle', 'refresh-failed', 'sweep'],
} as const);
export type AuthEndCause = typeof AUTH_END_CAUSES[keyof typeof AUTH_END_CAUSES][number];
export const AUTH_FAILURE_CAUSES = freeze({
  refused: ['provider-error', 'state-mismatch', 'no-code', 'exchange-failed', 'token-invalid', 'idp-session-ended', 'member-isolated', 'rights-pending'],
  failed: ['session-failed', 'storage-failure'],
} as const);
export type AuthFailureCause = typeof AUTH_FAILURE_CAUSES[keyof typeof AUTH_FAILURE_CAUSES][number];
export const REAUTHENTICATION_TRIGGERS = freeze(['logout-unfinished', 'switch-account', 'storage-untrusted', 'record-unreadable', 'register'] as const);
export type ReauthenticationTrigger = typeof REAUTHENTICATION_TRIGGERS[number];
type UnresolvedReason = 'not-authenticated' | 'not-resolved' | 'not-observed' | 'offline';
type NotApplicableReason = 'non-record-target' | 'in-process-service' | 'not-approved';
export type EvidenceFactV2<T> = Readonly<
  { status: 'known'; value: T } |
  { status: 'unresolved'; reason: UnresolvedReason } |
  { status: 'not-applicable'; reason: NotApplicableReason }
>;
export interface AuthContextV2 { endCause: AuthEndCause | null; failureCause: AuthFailureCause | null; trigger: ReauthenticationTrigger | null }
export interface AuthAccessEventV2 {
  formatVersion: 2; branch: 'online-auth';
  surface: string; eventId: string;
  /** The executor: the verified member, the service account of an in-process job, or unresolved before verification. */
  userId: EvidenceFactV2<ImmutableIdentity>;
  /** Confirmed DB rights at the event; an empty array is a confirmed empty set, never "unverified". */
  rolesAtTime: EvidenceFactV2<readonly string[]>;
  rightsVersion: EvidenceFactV2<number>;
  actingInstitution: EvidenceFactV2<string>;
  managingInstitution: EvidenceFactV2<string>;
  occurredAt: string;
  trustedProxyIp: EvidenceFactV2<{ address: string; source: 'trusted-proxy' }>;
  cause: CauseKind;
  /** D-18: 'authentication', or 'service-job' for an in-process sweep. */
  context: Readonly<WorkContext>;
  executor: 'member' | 'service' | 'unauthenticated';
  /** Whose authentication this event is about (the ended member of a sweep, the isolated member of an administrator). */
  affectedIdentity: EvidenceFactV2<ImmutableIdentity>;
  /** A non-credential random reference to the product session; never the session ID, cookie, token or entry proof. */
  session: EvidenceFactV2<string>;
  targets: readonly [];
  action: AuthAction;
  result: 'succeeded' | 'refused' | 'failed';
  auth: Readonly<AuthContextV2>;
  requestId: string; auditLinkId: string; relatedEventId: string | null;
}
export interface OfflineFactsV2 {
  envelopeId: string; deviceId: string; kid: string; preAuthorizationId: string; signedAt: string | null;
  timeBasis: { anchorEventId: string; uncertaintyMs: number }; deviceSequence: number; targetManifestSha256: string;
}
export interface OfflineAccessEventV2 {
  formatVersion: 2; branch: 'verified-offline';
  surface: string;
  /** The device-generated original event ID; a resend carries the same ID and content. */
  eventId: string;
  userId: EvidenceFactV2<ImmutableIdentity>; rolesAtTime: EvidenceFactV2<readonly string[]>;
  actingInstitution: EvidenceFactV2<string>; managingInstitution: EvidenceFactV2<string>;
  /** When the act happened on the device, never the reception time. */
  occurredAt: string;
  /** Always `unresolved: offline`; the reconnecting IP belongs to the related reception event. */
  trustedProxyIp: EvidenceFactV2<{ address: string; source: 'trusted-proxy' }>;
  cause: 'user-view'; executor: 'member';
  /** D-18: the device's work context at the act (or an out-of-context reason). */
  context: Readonly<WorkContext>;
  targets: readonly AccessTarget[];
  action: AccessAction; result: AccessEventV1['result'];
  offline: Readonly<OfflineFactsV2>;
  requestId: string; auditLinkId: string;
  /** The separate online reception event of this original. */
  relatedEventId: string;
}
export type AccessEventV2 = AuthAccessEventV2 | OfflineAccessEventV2;
export type AccessEvent = AccessEventV1 | AccessEventV2;

function factV2<T>(input: unknown, parse: (value: unknown) => T, unresolved: readonly UnresolvedReason[],
  notApplicable: readonly NotApplicableReason[]): EvidenceFactV2<T> {
  if (!input || typeof input !== 'object') throw new Error('Evidence fact missing');
  const status = Object.getOwnPropertyDescriptor(input, 'status')?.value;
  if (status === 'known') { const v = object(input, ['status', 'value']); return { status, value: parse(v.value) }; }
  const v = object(input, ['status', 'reason']);
  if (status === 'unresolved') return { status, reason: choice(v.reason, unresolved) };
  if (status === 'not-applicable') return { status, reason: choice(v.reason, notApplicable) };
  throw new Error('Unknown evidence status');
}
const sameIdentity = (a: EvidenceFactV2<ImmutableIdentity>, b: EvidenceFactV2<ImmutableIdentity>) =>
  a.status === 'known' && b.status === 'known' && a.value.id === b.value.id && a.value.issuer === b.value.issuer && a.value.subject === b.value.subject;
function roleList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || new Set(value).size !== value.length) throw new Error('Roles must be a distinct list');
  return value.map(role => string(role));
}
function proxyAddress(value: unknown) {
  const ip = object(value, ['address', 'source']);
  if (isIP(ip.address) === 0 || ip.source !== 'trusted-proxy') throw new Error('Trusted proxy IP required');
  return { address: ip.address as string, source: 'trusted-proxy' as const };
}
const authRoutes = () => Object.keys(ROUTE_CONTRACTS).filter(r => ROUTE_CONTRACTS[r].operation === 'auth' && ROUTE_CONTRACTS[r].kinds.includes('authentication-session'));
/** Where each authentication fact can be observed; the producer records the actual route or the closed internal surface. */
function authSurfaces(action: AuthAction, endCause: AuthEndCause | null): readonly string[] {
  if (action === 'auth.login') return ['GET auth/callback'];
  if (action === 'auth.entry') return ['POST auth/entry'];
  if (endCause === 'logout') return ['POST auth/logout'];
  if (endCause === 'account-switch' || endCause === 'reauthentication') return authRoutes().filter(r => r !== 'POST auth/entry');
  if (endCause === 'isolation') return Object.keys(ROUTE_CONTRACTS).filter(r => ROUTE_CONTRACTS[r].operation === 'write' && ROUTE_CONTRACTS[r].kinds.includes('identity-access'));
  if (endCause === 'sweep') return Object.keys(INTERNAL_SURFACES).filter(s => INTERNAL_SURFACES[s].kinds.includes('authentication-session'));
  return Object.keys(ROUTE_CONTRACTS); // idle / refresh-failed: the request that observed the end
}
function surfaceCauses(surface: string): readonly CauseKind[] {
  return Object.prototype.hasOwnProperty.call(INTERNAL_SURFACES, surface) ? INTERNAL_SURFACES[surface].causes : routeContract(surface).causes;
}
function parseAccessEventV2(input: unknown, served?: readonly ResolvedRecord[]): Readonly<AccessEventV2> {
  const branch = input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'branch')?.value : undefined;
  if (branch === 'online-auth') return parseAuthEventV2(input);
  if (branch === 'verified-offline') return parseOfflineEventV2(input, served);
  throw new Error('Unknown access format branch');
}
function parseAuthEventV2(input: unknown): Readonly<AuthAccessEventV2> {
  const v = object(input, ['formatVersion', 'branch', 'surface', 'eventId', 'userId', 'rolesAtTime', 'rightsVersion', 'actingInstitution',
    'managingInstitution', 'occurredAt', 'trustedProxyIp', 'cause', 'context', 'executor', 'affectedIdentity', 'session', 'targets', 'action', 'result',
    'auth', 'requestId', 'auditLinkId', 'relatedEventId']);
  const eventId = string(v.eventId);
  if (!UUID4.test(eventId)) throw new Error('Original event ID must be a server-generated UUID');
  const action = choice(v.action, AUTH_ACTIONS);
  const result = choice(v.result, ['succeeded', 'refused', 'failed']);
  const a = object(v.auth, ['endCause', 'failureCause', 'trigger']);
  const endCauses: readonly string[] = action === 'auth.logout' || action === 'auth.session.expired' ? AUTH_END_CAUSES[action] : [];
  const endCause = a.endCause === null ? null : choice(a.endCause, endCauses as readonly AuthEndCause[]);
  const failureCause = a.failureCause === null ? null :
    choice(a.failureCause, [...AUTH_FAILURE_CAUSES.refused, ...AUTH_FAILURE_CAUSES.failed] as readonly AuthFailureCause[]);
  const trigger = a.trigger === null ? null : choice(a.trigger, REAUTHENTICATION_TRIGGERS);
  // Each action names its own outcome: a login is the only refusable/failable authentication, an end always has its cause.
  if (action === 'auth.login') {
    const expected = failureCause === null ? 'succeeded' : (AUTH_FAILURE_CAUSES.refused as readonly string[]).includes(failureCause) ? 'refused' : 'failed';
    if (result !== expected || endCause !== null) throw new Error('Login result must match its failure cause');
  } else if (result !== 'succeeded' || failureCause !== null || (endCauses.length > 0) !== (endCause !== null)) {
    throw new Error('Event result does not describe the observed stage');
  }
  if ((trigger !== null) !== (endCause === 'reauthentication')) throw new Error('A trigger belongs to a reauthentication end only');
  const surface = string(v.surface);
  if (!authSurfaces(action, endCause).includes(surface)) throw new Error('Authentication fact does not belong to this surface');
  const cause = choice(v.cause, ['user-view', 'background-fetch', 'service-job']);
  if (!surfaceCauses(surface).includes(cause)) throw new Error('Cause does not belong to the server surface');
  const context = workContext(v.context, cause, true);
  const executor = choice(v.executor, ['member', 'service', 'unauthenticated']);
  const userId = factV2(v.userId, identity, ['not-authenticated'], []);
  const affectedIdentity = factV2(v.affectedIdentity, identity, ['not-authenticated'], []);
  const rolesAtTime = factV2(v.rolesAtTime, roleList, ['not-authenticated', 'not-resolved'], []);
  const rightsVersion = factV2(v.rightsVersion, value => integer(value, 0), ['not-authenticated', 'not-resolved'], ['in-process-service']);
  const actingInstitution = factV2(v.actingInstitution, value => string(value), ['not-authenticated', 'not-resolved', 'not-observed'], ['not-approved']);
  const managingInstitution = factV2(v.managingInstitution, value => string(value), ['not-resolved'], []);
  const trustedProxyIp = factV2(v.trustedProxyIp, proxyAddress, ['not-observed'], ['in-process-service']);
  const session = factV2(v.session, value => {
    const reference = string(value);
    if (!/^authref:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reference)) throw new Error('Session reference must be a random audit-only reference');
    return reference;
  }, ['not-resolved'], []);
  const succeeded = result === 'succeeded';
  // The executor's own facts, then the affected member. A sweep's service is never the member it ended; an
  // administrator's isolation ends another member; every other end and login is the executor's own.
  let consistent: boolean;
  if (executor === 'unauthenticated') {
    consistent = action === 'auth.login' && !succeeded && cause !== 'service-job' &&
      userId.status === 'unresolved' && affectedIdentity.status === 'unresolved' &&
      [rolesAtTime, rightsVersion, actingInstitution].every(f => f.status === 'unresolved' && f.reason === 'not-authenticated');
  } else if (executor === 'service') {
    consistent = cause === 'service-job' && endCause === 'sweep' && userId.status === 'known' && affectedIdentity.status === 'known' &&
      !sameIdentity(userId, affectedIdentity) && trustedProxyIp.status === 'not-applicable' && rightsVersion.status === 'not-applicable' &&
      rolesAtTime.status === 'known' && actingInstitution.status === 'known';
  } else {
    consistent = cause !== 'service-job' && endCause !== 'sweep' && userId.status === 'known' && affectedIdentity.status === 'known' &&
      trustedProxyIp.status !== 'not-applicable' && rightsVersion.status !== 'not-applicable' &&
      (endCause === 'isolation' ? !sameIdentity(userId, affectedIdentity) : sameIdentity(userId, affectedIdentity));
  }
  if (!consistent) throw new Error('Unresolved or inconsistent actor context');
  if (succeeded && (trustedProxyIp.status === 'unresolved' || [rolesAtTime, rightsVersion].some(f => f.status === 'unresolved') ||
      actingInstitution.status === 'unresolved' || managingInstitution.status !== 'known' || session.status !== 'known'))
    throw new Error('A successful authentication fact requires its observed context');
  if (!succeeded && session.status === 'known') throw new Error('A refused or failed login has no product session');
  if (!Array.isArray(v.targets) || v.targets.length !== 0) throw new Error('Authentication events never name clinical targets');
  const requestId = string(v.requestId), auditLinkId = string(v.auditLinkId);
  if (!AUDIT_LINK.test(auditLinkId)) throw new Error('Invalid audit link ID');
  if (requestId.startsWith('audit:') || requestId.startsWith('authref:') || requestId === eventId) throw new Error('Request correlation must be independent');
  const relatedEventId = v.relatedEventId === null ? null : string(v.relatedEventId);
  if (relatedEventId === eventId) throw new Error('Event cannot reference itself');
  return freeze({ formatVersion: 2 as const, branch: 'online-auth' as const, surface, eventId, userId, rolesAtTime, rightsVersion,
    actingInstitution, managingInstitution, occurredAt: utc(v.occurredAt), trustedProxyIp, cause, context, executor, affectedIdentity, session,
    targets: [] as [], action, result, auth: { endCause, failureCause, trigger }, requestId, auditLinkId, relatedEventId });
}

type OfflineVerifier = Readonly<{ verify(envelopeId: string): unknown }>;
let offlineVerifier: OfflineVerifier | undefined;
/** Server start only, once (B2 composes it beside the readers in main.ts). Until C's real key and signature verification
 * exists nothing composes it, and every offline receipt is refused as unsupported. */
export function composeOfflineReceiptVerifier(verifier: { verify(envelopeId: string): unknown }): void {
  if (offlineVerifier) refuse('OfflineVerifierAlreadyComposed');
  if (!verifier || typeof verifier.verify !== 'function') refuse('OfflineVerifierRequired');
  offlineVerifier = Object.freeze({ verify: verifier.verify.bind(verifier) });
}
const OFFLINE_FACT_KEYS = ['envelopeId', 'deviceId', 'kid', 'preAuthorizationId', 'signedAt', 'timeBasis', 'deviceSequence', 'targetManifestSha256'];
function offlineFacts(value: unknown): Readonly<OfflineFactsV2> {
  const o = object(value, OFFLINE_FACT_KEYS), t = object(o.timeBasis, ['anchorEventId', 'uncertaintyMs']);
  return { envelopeId: string(o.envelopeId), deviceId: string(o.deviceId), kid: string(o.kid), preAuthorizationId: string(o.preAuthorizationId),
    signedAt: o.signedAt === null ? null : utc(o.signedAt), timeBasis: { anchorEventId: string(t.anchorEventId), uncertaintyMs: integer(t.uncertaintyMs, 0) },
    deviceSequence: integer(o.deviceSequence, 1), targetManifestSha256: sha256(o.targetManifestSha256) };
}
function parseOfflineEventV2(input: unknown, served?: readonly ResolvedRecord[]): Readonly<OfflineAccessEventV2> {
  const v = object(input, ['formatVersion', 'branch', 'surface', 'eventId', 'userId', 'rolesAtTime', 'actingInstitution', 'managingInstitution',
    'occurredAt', 'trustedProxyIp', 'cause', 'context', 'executor', 'targets', 'action', 'result', 'offline', 'requestId', 'auditLinkId', 'relatedEventId']);
  // A body flag never admits an offline fact: only the composed verifier's stored result does.
  if (!offlineVerifier) refuse('OfflineVerificationUnsupported');
  const offline = offlineFacts(v.offline);
  let verified: Readonly<OfflineFactsV2>;
  try { verified = offlineFacts(offlineVerifier.verify(offline.envelopeId)); } catch { refuse('OfflineReceiptBindingRefused'); }
  if (JSON.stringify(verified) !== JSON.stringify(offline)) refuse('OfflineReceiptBindingRefused');
  const eventId = string(v.eventId);
  if (!UUID4.test(eventId)) throw new Error('Original event ID must be a UUID');
  const surface = string(v.surface), surfaceKinds = surfaceKindsOf(surface);
  const action = choice(v.action, actions);
  if (action === 'provide-prepared' || accessPersistence(action) === 'independent-failure') throw new Error('An offline original is a performed act');
  const result = choice(v.result, ['prepared', 'succeeded', 'aborted', 'refused', 'failed', 'reported']);
  if (result !== expectedResult(action)) throw new Error('Event result does not describe the observed stage');
  if (v.cause !== 'user-view' || v.executor !== 'member') throw new Error('An offline original is a member act');
  const context = workContext(v.context, 'user-view', false);
  const userId = factV2(v.userId, identity, [], []);
  const rolesAtTime = factV2(v.rolesAtTime, value => { const roles = roleList(value); if (!roles.length) throw new Error('Roles missing'); return roles; }, [], []);
  const actingInstitution = factV2(v.actingInstitution, value => string(value), [], []);
  const managingInstitution = factV2(v.managingInstitution, value => string(value), [], []);
  const trustedProxyIp = factV2(v.trustedProxyIp, proxyAddress, ['offline'], []);
  if (trustedProxyIp.status !== 'unresolved') throw new Error('An offline original has no observed proxy address');
  const mixed = surfaceKinds.some(k => NON_RECORD_TARGETS.includes(k)) && surfaceKinds.some(k => !NON_RECORD_TARGETS.includes(k));
  if (mixed && (!served || served.length !== v.targets?.length)) refuse('ServedRecordManifestRequired');
  const targets = parseTargets(v.targets, surfaceKinds, served, false);
  if (!targets.length) throw new Error('An offline original names its targets');
  const requestId = string(v.requestId), auditLinkId = string(v.auditLinkId), relatedEventId = string(v.relatedEventId);
  if (!AUDIT_LINK.test(auditLinkId)) throw new Error('Invalid audit link ID');
  if (relatedEventId === eventId) throw new Error('The reception is a separate event');
  const occurredAt = utc(v.occurredAt);
  if (offline.signedAt !== null && offline.signedAt !== occurredAt) throw new Error('The signed act and its event time are one fact');
  return freeze({ formatVersion: 2 as const, branch: 'verified-offline' as const, surface, eventId, userId, rolesAtTime, actingInstitution,
    managingInstitution, occurredAt, trustedProxyIp, cause: 'user-view' as const, context, executor: 'member' as const, targets, action, result,
    offline, requestId, auditLinkId, relatedEventId });
}

export interface DurableAccessReceipt { eventId: string; durableAt: string }
/** B seals within append under the store lock. Runtime has INSERT only, never owner/superuser/UPDATE/DELETE.
 * A separate retention-job role removes eligible prefixes only, atomically appending an expiry chain checkpoint.
 */
export interface AppendOnlyAccessStore { append(event: Readonly<AccessEvent>): Promise<DurableAccessReceipt> }

/** 제8조①2: each event's viewing-stream entry has its own two-year clock (the history stream follows the changed record). */
export function accessRetention(input: AccessEvent) { return newAccessRetentionRecord(resolveAccessRecord(input)); }
export function deliveryRetention(source: ResolvedRecord) { return newAccessRetentionRecord(source); }

/** A resolved Promise from enqueue/transaction-start is not a durable receipt. */
export async function provideAfterDurableEvent<T>(store: AppendOnlyAccessStore, input: AccessEvent,
  sendBody: (receipt: DurableAccessReceipt) => Promise<T>): Promise<T> {
  const event = parseAccessEvent(input);
  if (event.action !== 'provide-prepared') throw new Error('Provide-prepared required');
  const receipt = await store.append(event);
  object(receipt, ['eventId', 'durableAt']); utc(receipt.durableAt);
  if (receipt.eventId !== event.eventId) throw new Error('Durability receipt mismatch');
  return sendBody(receipt);
}

export const ACCESS_INVARIANTS = freeze({
  mutation: 'append-only-while-retained; runtime-insert-only-not-owner-or-superuser; no-update-delete',
  store: 'separate-from-business-records; privacy-21.3-segregation-and-medical-23.4-access-store',
  integrity: 'server-sequence-and-previous-hash-in-same-append; trusted-tail-seal-detects-omissions',
  deletion: 'retention-job-only; viewing-stream: expired-prefix-only, atomic-chain-checkpoint-with-nonpersonal-anchor; history-stream: with-the-changed-record-destruction-set-only (H); never-runtime',
  liveVerification: 'B: runtime-update-delete-disable-trigger-denied; tamper-gap-tail-detected; expiry-role-no-unexpired-delete; crash-checkpoint-rollback',
  retention: 'two-streams (D-1): viewing = each-event-floor-2-years, longer-only-under-hold-or-legal-basis; history = changes (기재·추가기재·수정) as-long-as-the-changed-record; no-stored-expiry; no-last-access-reset-or-institution-override',
  retentionBasis: '안전성 확보조치 기준 제8조① 본문(정보주체 제외)·①2; 개인정보 보호법 제3조①②·제21조①',
  expiry: 'destroy-irreversibly-when-the-two-year-security-purpose-ends; no-automatic-longer-retention',
  successfulWrite: 'record, signature, publication reference and access event commit atomically',
  read: 'provide-prepared must be durable before any body bytes; later stages append separate events',
  failure: 'independent transaction or protected failure journal; business rollback cannot erase failure',
  correlation: 'followups retain the prepared event target/version set; ACK never migrates to a new version',
  link: 'random audit-only ID; never a session ID, cookie, bearer token, or authentication credential',
  context: 'D-18: server-bound work context in every event (hashed); one-line reason only out of context; never a permission',
  emptyTargets: 'only an actually empty result or non-record operation; never omitted discovered targets',
  proxy: 'B supplies verified proxy context, never an untrusted forwarded header',
  exports: 'print-done/pdf/copy describe client reports only, not proof of physical output or OS completion',
});

/**
 * D-1 (legal register 2026-10-09 §5-11, commander D727): the access ledger is two streams.
 *  - `viewing`: every access event, kept for its own floor (안전성 확보조치 기준 제8조①, counted from the event; longer only
 *    under a hold or another legal basis). It holds 열람 events, events about no EMR record, and the floor remainder of
 *    every change, so a change made shortly before its record is destroyed stays here for its own floor. An expired
 *    prefix is deleted with a chained checkpoint (`sealAccessExpiry`) behind B's external seal.
 *  - `history`: the change history of EMR records - a succeeded 기재·추가기재·수정 act about at least one record target
 *    (의료법 제23조④, 시행규칙 제16조①2·②) - kept as long as the record it changed and destroyed with that record's
 *    destruction set (unit H). It has no prefix expiry.
 */
export const ACCESS_STREAMS = freeze(['viewing', 'history'] as const);
export type AccessStream = typeof ACCESS_STREAMS[number];
export type StatutoryAct = '기재' | '추가기재' | '수정' | '열람' | 'none';
const CHANGE_ACTS: readonly StatutoryAct[] = freeze(['기재', '추가기재', '수정']);
/** The 의료법 제23조④ act of an event (A's closed tables; authentication acts are none). */
export function statutoryAct(input: unknown, served?: readonly ResolvedRecord[]): StatutoryAct {
  const event = parseAccessEvent(input, served);
  return event.formatVersion === 2 && event.branch === 'online-auth' ? AUTH_STATUTORY_ACT[event.action] :
    STATUTORY_ACT[(event as AccessEventV1 | OfflineAccessEventV2).action];
}
/** The streams an event is recorded in: always the viewing stream; also the history stream when it changed a record. */
export function accessStreams(input: unknown, served?: readonly ResolvedRecord[]): readonly AccessStream[] {
  const event = parseAccessEvent(input, served);
  const changed = CHANGE_ACTS.includes(statutoryAct(event, served)) && event.result === 'succeeded' &&
    (event.targets as readonly AccessTarget[]).some(target => !NON_RECORD_TARGETS.includes(target.kind));
  return changed ? ACCESS_STREAMS : freeze(['viewing'] as const);
}

/** Hash input is the ordered parsed payload plus monotonic position, never caller-supplied chain fields. */
export interface ChainPosition { sequence: number; hash: string }
export interface AccessExpiryCheckpoint { kind: 'expiry'; at: string; deletedThrough: number; deletedCount: number; anchorHash: string }
export interface AccessChainEntry extends ChainPosition {
  previousHash: string;
  payload: { kind: 'access'; event: Readonly<AccessEvent> } | { kind: 'history'; event: Readonly<AccessEvent> } | AccessExpiryCheckpoint;
}
/** Each stream is its own chain from this genesis. */
export const ACCESS_CHAIN_GENESIS: Readonly<ChainPosition> = freeze({ sequence: 0, hash: '0'.repeat(64) });
function chainEntry(previous: ChainPosition, payload: AccessChainEntry['payload']): Readonly<AccessChainEntry> {
  object(previous, ['sequence', 'hash']); integer(previous.sequence); sha256(previous.hash);
  const sequence = integer(previous.sequence + 1, 1), previousHash = previous.hash;
  const hash = createHash('sha256').update(JSON.stringify({ sequence, previousHash, payload })).digest('hex');
  return freeze({ sequence, previousHash, payload, hash });
}
/** The viewing stream's entry keeps the v1 payload kind 'access'; the history stream's is 'history', so an entry can never
 * be moved between the streams unnoticed. Only an event that changed a record may enter the history stream. */
export function sealAccessEvent(previous: ChainPosition, input: AccessEvent, stream: AccessStream = 'viewing'): Readonly<AccessChainEntry> {
  choice(stream, ACCESS_STREAMS);
  const event = parseAccessEvent(input);
  if (stream === 'history' && !accessStreams(event).includes('history')) refuse('HistoryStreamRefused');
  return chainEntry(previous, stream === 'history' ? { kind: 'history', event } : { kind: 'access', event });
}
/** Viewing stream only. Through is the last deleted prefix entry; B checks every entry's end and the legal holds first. */
export function sealAccessExpiry(previous: ChainPosition, through: ChainPosition, deletedCount: number, at: string): Readonly<AccessChainEntry> {
  object(through, ['sequence', 'hash']); integer(through.sequence, 1); integer(deletedCount, 1); sha256(through.hash);
  if (through.sequence > previous.sequence || deletedCount > through.sequence) throw new Error('Invalid expired prefix');
  return chainEntry(previous, { kind: 'expiry', at: utc(at), deletedThrough: through.sequence, deletedCount, anchorHash: through.hash });
}
/** Verification of one stream starts at a sealed anchor and must reach an independently protected expected tail. */
export function verifyAccessChain(anchor: ChainPosition, entries: readonly AccessChainEntry[], expectedTail: ChainPosition,
  stream: AccessStream = 'viewing'): boolean {
  try {
    choice(stream, ACCESS_STREAMS);
    let previous = anchor;
    for (const entry of entries) {
      object(entry, ['sequence', 'previousHash', 'payload', 'hash']);
      let expected: Readonly<AccessChainEntry>;
      if (entry.payload.kind === 'access' || entry.payload.kind === 'history') {
        if ((entry.payload.kind === 'history') !== (stream === 'history')) return false;
        object(entry.payload, ['kind', 'event']); expected = sealAccessEvent(previous, entry.payload.event, stream);
      } else {
        if (stream !== 'viewing') return false;
        const p = object(entry.payload, ['kind', 'at', 'deletedThrough', 'deletedCount', 'anchorHash']); choice(p.kind, ['expiry']);
        expected = sealAccessExpiry(previous, { sequence: p.deletedThrough, hash: p.anchorHash }, p.deletedCount, p.at);
      }
      if (entry.sequence !== expected.sequence || entry.previousHash !== expected.previousHash || entry.hash !== expected.hash) return false;
      previous = { sequence: entry.sequence, hash: entry.hash };
    }
    object(expectedTail, ['sequence', 'hash']); integer(expectedTail.sequence); sha256(expectedTail.hash);
    return previous.sequence === expectedTail.sequence && previous.hash === expectedTail.hash;
  } catch { return false; }
}
