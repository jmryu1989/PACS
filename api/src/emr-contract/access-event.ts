import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { RECORD_CLASSIFICATION, RecordKind } from './classification';
import { choice, freeze, object, string, utc } from './validation';

export const ACCESS_ACTIONS = freeze({
  write: ['write', 'additional-entry', 'modify', 'approve-sign', 'amend', 'addendum', 'cancel', 'release', 'draft-save', 'clear', 'discard'],
  read: ['provide-prepared', 'transfer-ended', 'transfer-aborted', 'client-shown', 'explicit-ack'],
  export: ['print-opened', 'print-done', 'pdf', 'copy', 'download', 'disclosure'],
  failure: ['auth-refused', 'permission-refused', 'conflict', 'storage-failed', 'signature-failed'],
} as const);
export type AccessAction = typeof ACCESS_ACTIONS[keyof typeof ACCESS_ACTIONS][number];
export type CauseKind = 'user-view' | 'background-fetch' | 'service-job';
export type EvidenceFact<T> = Readonly<
  { status: 'known'; value: T } |
  { status: 'unresolved'; reason: 'not-authenticated' | 'not-resolved' | 'not-observed' } |
  { status: 'not-applicable'; reason: string }
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
export interface AccessEvent {
  formatVersion: 1;
  eventId: string;
  userId: EvidenceFact<ImmutableIdentity>;
  rolesAtTime: EvidenceFact<readonly string[]>;
  actingInstitution: EvidenceFact<string>;
  managingInstitution: EvidenceFact<string>;
  occurredAt: string;
  trustedProxyIp: EvidenceFact<{ address: string; source: 'trusted-proxy' }>;
  cause: CauseKind;
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
  if (status === 'not-applicable') return { status, reason: string(v.reason) };
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

export function parseAccessEvent(input: unknown): Readonly<AccessEvent> {
  const v = object(input, ['formatVersion', 'eventId', 'userId', 'rolesAtTime', 'actingInstitution', 'managingInstitution', 'occurredAt',
    'trustedProxyIp', 'cause', 'executor', 'targets', 'action', 'result', 'requestId', 'auditLinkId', 'relatedEventId']);
  if (v.formatVersion !== 1) throw new Error('Unknown access format');
  const action = choice(v.action, actions);
  const failure = accessPersistence(action) === 'independent-failure';
  const result = choice(v.result, ['prepared', 'succeeded', 'aborted', 'refused', 'failed', 'reported']);
  const expected = action === 'provide-prepared' ? 'prepared' : action === 'transfer-aborted' ? 'aborted' :
    ['auth-refused', 'permission-refused'].includes(action) ? 'refused' : failure ? 'failed' :
    ['client-shown', 'print-done', 'pdf', 'copy'].includes(action) ? 'reported' : 'succeeded';
  if (result !== expected) throw new Error('Event result does not describe the observed stage');
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
  if ((!failure && [userId, rolesAtTime, actingInstitution, managingInstitution, trustedProxyIp].some(f => f.status !== 'known')) ||
      (executor === 'unauthenticated' && (action !== 'auth-refused' || userId.status !== 'unresolved')) ||
      (action === 'auth-refused' && executor !== 'unauthenticated') ||
      (cause === 'service-job' && executor !== 'service')) throw new Error('Unresolved or inconsistent actor context');
  if (!Array.isArray(v.targets)) throw new Error('Actual returned target set required');
  const targets: AccessTarget[] = v.targets.map(target => {
    const t = object(target, ['kind', 'patientLinkSnapshot', 'studyId', 'recordId', 'versionId']);
    const kind = choice(t.kind, Object.keys(RECORD_CLASSIFICATION) as RecordKind[]);
    const parsed = { kind, patientLinkSnapshot: fact(t.patientLinkSnapshot, patientLink), studyId: fact(t.studyId, value => string(value)),
      recordId: fact(t.recordId, value => string(value)), versionId: fact(t.versionId, value => string(value)) };
    if (!failure && Object.values(parsed).some(f => typeof f === 'object' && f.status === 'unresolved'))
      throw new Error('Successful provision requires resolved targets');
    return parsed;
  });
  const auditLinkId = string(v.auditLinkId);
  if (!/^audit:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(auditLinkId)) throw new Error('Invalid audit link ID');
  const relatedEventId = v.relatedEventId === null ? null : string(v.relatedEventId);
  if ((readFollowups.includes(action) || action === 'print-done') && relatedEventId === null) throw new Error('Preceding event reference required');
  if (relatedEventId === v.eventId) throw new Error('Event cannot reference itself');
  return freeze({ formatVersion: 1, eventId: string(v.eventId), userId, rolesAtTime, actingInstitution, managingInstitution,
    occurredAt: utc(v.occurredAt), trustedProxyIp, cause, executor, targets, action, result, requestId: string(v.requestId), auditLinkId, relatedEventId });
}

export interface DurableAccessReceipt { eventId: string; durableAt: string }
/** B must implement durable append; there is intentionally no update/delete API. */
export interface AppendOnlyAccessStore { append(event: Readonly<AccessEvent>): Promise<DurableAccessReceipt> }

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
  mutation: 'append-only',
  successfulWrite: 'record, signature, publication reference and access event commit atomically',
  read: 'provide-prepared must be durable before any body bytes; later stages append separate events',
  failure: 'independent transaction or protected failure journal; business rollback cannot erase failure',
  correlation: 'followups retain the prepared event target/version set; ACK never migrates to a new version',
  link: 'random audit-only ID; never a session ID, cookie, bearer token, or authentication credential',
  emptyTargets: 'only an actually empty result or non-record operation; never omitted discovered targets',
  proxy: 'G supplies verified proxy context, never an untrusted forwarded header',
  exports: 'print-done/pdf/copy describe client reports only, not proof of physical output or OS completion',
});
