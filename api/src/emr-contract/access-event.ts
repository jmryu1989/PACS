import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { RECORD_CLASSIFICATION, RecordKind, resolveStoredRecord, ResolvedRecord, verifiedRecord, bindStoredRecordReader } from './classification';
import { newAccessRetentionRecord } from './lawful-defaults';
import { routeContract, EXTERNAL_SURFACES } from './routes';
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
export interface AccessEvent {
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
 */
export function parseAccessEvent(input: unknown, served?: readonly ResolvedRecord[]): Readonly<AccessEvent> {
  const v = object(input, ['formatVersion', 'surface', 'eventId', 'userId', 'rolesAtTime', 'actingInstitution', 'managingInstitution', 'occurredAt',
    'trustedProxyIp', 'cause', 'executor', 'targets', 'action', 'result', 'requestId', 'auditLinkId', 'relatedEventId']);
  if (v.formatVersion !== 1) throw new Error('Unknown access format');
  const surface = string(v.surface);
  const surfaceKinds: readonly RecordKind[] = Object.prototype.hasOwnProperty.call(EXTERNAL_SURFACES, surface) ? EXTERNAL_SURFACES[surface] : routeContract(surface).kinds;
  const action = choice(v.action, actions);
  const failure = accessPersistence(action) === 'independent-failure';
  const mixed = surfaceKinds.some(k => NON_RECORD_TARGETS.includes(k)) && surfaceKinds.some(k => !NON_RECORD_TARGETS.includes(k));
  const manifest = served ?? servedManifests.get(v);
  if (mixed && !failure && (!manifest || manifest.length !== v.targets?.length)) refuse('ServedRecordManifestRequired');
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
  const inProcess = executor === 'service' && cause === 'service-job' && trustedProxyIp.status === 'not-applicable' && trustedProxyIp.reason === 'in-process-service';
  if ((!failure && [userId, rolesAtTime, actingInstitution, managingInstitution].some(f => f.status !== 'known')) ||
      (!failure && trustedProxyIp.status !== 'known' && !inProcess) ||
      (trustedProxyIp.status === 'not-applicable' && !inProcess) ||
      (executor === 'unauthenticated' && (action !== 'auth-refused' || userId.status !== 'unresolved')) ||
      (action === 'auth-refused' && executor !== 'unauthenticated') ||
      (cause === 'service-job' && executor !== 'service')) throw new Error('Unresolved or inconsistent actor context');
  if (!Array.isArray(v.targets)) throw new Error('Actual returned target set required');
  const targets: AccessTarget[] = v.targets.map((target, index) => {
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
  const auditLinkId = string(v.auditLinkId);
  if (!/^audit:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(auditLinkId)) throw new Error('Invalid audit link ID');
  const relatedEventId = v.relatedEventId === null ? null : string(v.relatedEventId);
  if ((readFollowups.includes(action) || action === 'print-done') && relatedEventId === null) throw new Error('Preceding event reference required');
  if (relatedEventId === v.eventId) throw new Error('Event cannot reference itself');
  const parsed = freeze({ formatVersion: 1 as const, surface, eventId: string(v.eventId), userId, rolesAtTime, actingInstitution, managingInstitution,
    occurredAt: utc(v.occurredAt), trustedProxyIp, cause, executor, targets, action, result, requestId: string(v.requestId), auditLinkId, relatedEventId });
  if (manifest) servedManifests.set(parsed, Object.freeze([...manifest]));
  return parsed;
}

export interface DurableAccessReceipt { eventId: string; durableAt: string }
/** B seals within append under the store lock. Runtime has INSERT only, never owner/superuser/UPDATE/DELETE.
 * A separate retention-job role removes eligible prefixes only, atomically appending an expiry chain checkpoint.
 */
export interface AppendOnlyAccessStore { append(event: Readonly<AccessEvent>): Promise<DurableAccessReceipt> }

// One module-owned adapter, with a fixed model and event mapping. No per-call reader/model injection.
const accessRows = new Map<string, AccessEvent>();
const accessReader = bindStoredRecordReader({ load(recordId, eventId) {
  const event = accessRows.get(eventId);
  if (!event || recordId !== event.eventId) refuse('AccessRecordRequired');
  const digest = createHash('sha256').update(JSON.stringify(event)).digest('hex');
  return { recordId, model: 'AuditLog', row: {}, event: {
    eventId, recordId, versionId: eventId, sha256: digest, contentSha256: digest, at: event.occurredAt,
    act: 'access', signature: null, predecessor: null, components: [], processing: null,
  } };
} });
/** 제8조①2: this sensitive-data system retains each staff/service access event for two years from occurrence. */
export function accessRetention(input: AccessEvent) {
  const event = parseAccessEvent(input);
  accessRows.set(event.eventId, event);
  try { return newAccessRetentionRecord(resolveStoredRecord(accessReader, event.eventId, event.eventId)); }
  finally { accessRows.delete(event.eventId); }
}
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
  deletion: 'retention-job-only; expired-prefix-only; atomic-chain-checkpoint-with-nonpersonal-anchor; never-runtime',
  liveVerification: 'B: runtime-update-delete-disable-trigger-denied; tamper-gap-tail-detected; expiry-role-no-unexpired-delete; crash-checkpoint-rollback',
  retention: 'each-event-2-years; independent-of-source-record; no-last-access-reset-or-institution-override',
  retentionBasis: '안전성 확보조치 기준 제8조① 본문(정보주체 제외)·①2; 개인정보 보호법 제3조①②·제21조①',
  expiry: 'destroy-irreversibly-when-the-two-year-security-purpose-ends; no-automatic-longer-retention',
  successfulWrite: 'record, signature, publication reference and access event commit atomically',
  read: 'provide-prepared must be durable before any body bytes; later stages append separate events',
  failure: 'independent transaction or protected failure journal; business rollback cannot erase failure',
  correlation: 'followups retain the prepared event target/version set; ACK never migrates to a new version',
  link: 'random audit-only ID; never a session ID, cookie, bearer token, or authentication credential',
  emptyTargets: 'only an actually empty result or non-record operation; never omitted discovered targets',
  proxy: 'G supplies verified proxy context, never an untrusted forwarded header',
  exports: 'print-done/pdf/copy describe client reports only, not proof of physical output or OS completion',
});

/** Hash input is the ordered parsed payload plus monotonic position, never caller-supplied chain fields. */
export interface ChainPosition { sequence: number; hash: string }
export interface AccessExpiryCheckpoint { kind: 'expiry'; at: string; deletedThrough: number; deletedCount: number; anchorHash: string }
export interface AccessChainEntry extends ChainPosition {
  previousHash: string; payload: { kind: 'access'; event: Readonly<AccessEvent> } | AccessExpiryCheckpoint;
}
export const ACCESS_CHAIN_GENESIS: Readonly<ChainPosition> = freeze({ sequence: 0, hash: '0'.repeat(64) });
function chainEntry(previous: ChainPosition, payload: AccessChainEntry['payload']): Readonly<AccessChainEntry> {
  object(previous, ['sequence', 'hash']); integer(previous.sequence); sha256(previous.hash);
  const sequence = integer(previous.sequence + 1, 1), previousHash = previous.hash;
  const hash = createHash('sha256').update(JSON.stringify({ sequence, previousHash, payload })).digest('hex');
  return freeze({ sequence, previousHash, payload, hash });
}
export function sealAccessEvent(previous: ChainPosition, input: AccessEvent): Readonly<AccessChainEntry> {
  return chainEntry(previous, { kind: 'access', event: parseAccessEvent(input) });
}
/** Through is the last deleted prefix entry; B checks every event's deadline and legal holds before invoking. */
export function sealAccessExpiry(previous: ChainPosition, through: ChainPosition, deletedCount: number, at: string): Readonly<AccessChainEntry> {
  object(through, ['sequence', 'hash']); integer(through.sequence, 1); integer(deletedCount, 1); sha256(through.hash);
  if (through.sequence > previous.sequence || deletedCount > through.sequence) throw new Error('Invalid expired prefix');
  return chainEntry(previous, { kind: 'expiry', at: utc(at), deletedThrough: through.sequence, deletedCount, anchorHash: through.hash });
}
/** Verification starts at a sealed prefix anchor and must reach an independently protected expected tail. */
export function verifyAccessChain(anchor: ChainPosition, entries: readonly AccessChainEntry[], expectedTail: ChainPosition): boolean {
  try {
    let previous = anchor;
    for (const entry of entries) {
      object(entry, ['sequence', 'previousHash', 'payload', 'hash']);
      let expected: Readonly<AccessChainEntry>;
      if (entry.payload.kind === 'access') {
        object(entry.payload, ['kind', 'event']); expected = sealAccessEvent(previous, entry.payload.event);
      } else {
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
