import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { ACCESS_STREAMS, AccessEvent, AccessStream, AppendOnlyAccessStore, DurableAccessReceipt,
  ImmutableIdentity, NON_RECORD_TARGETS, StatutoryAct, parseAccessEvent, provideAfterDurableEvent } from '../emr-contract/access-event';
import { RECORD_CLASSIFICATION, ResolvedRecord, OrderFacts, parseOrderFacts, RecordEvent, parseRecordEvent } from '../emr-contract/classification';
import { civilPeriodEnd, validateOrderTransition } from '../emr-contract/lawful-defaults';
import { choice, freeze, object, refuse, string, utc } from '../emr-contract/validation';

export interface StoredEntry {
  entryId: string; sequence: number; stream: AccessStream; kind: 'access' | 'history';
  statutoryAct: StatutoryAct; eventId: string; payload: string; storedAt: string;
}
/** Equality binding for honest transport duplicates; no integrity chain. */
export function canonicalPayload(input: unknown, served?: readonly ResolvedRecord[]) {
  const event = parseAccessEvent(input, served);
  const text = JSON.stringify(event);
  return freeze({ event, text, contentSha256: createHash('sha256').update(text).digest('hex') });
}
export interface HoldRow { holdId: string; phase: 'placed' | 'released'; body: string }
export interface RequestRow { phase: 'received' | 'resolved'; body: string }
export interface ClauseRow { law: string; article: string; publication: string; publishedAt: string; effectiveAt: string }
export interface PlacementRow { relation: string; relkind: string; tablespace: string }
export interface OrderFact {
  recordId: string; eventId: string; previousEventId: string | null; facts: OrderFacts; event: RecordEvent;
}
/** Append-only source/order facts. Source provenance and the original receipt are immutable across operational events. */
export function parseOrderFact(input: unknown, previous?: OrderFact): Readonly<OrderFact> {
  const v = object(input, ['recordId', 'eventId', 'previousEventId', 'facts', 'event']);
  string(v.recordId); string(v.eventId);
  if (v.previousEventId !== null) string(v.previousEventId);
  const facts = parseOrderFacts(v.facts);
  const e = parseRecordEvent(v.event);
  if (e.recordId !== v.recordId || facts.statusEvent.eventId !== v.eventId || facts.statusEvent.at < e.at ||
      facts.procedure?.decision && !facts.procedure.decision.scope.includes(v.recordId)) refuse('OrderEventBindingRefused');
  if (previous) {
    if (previous.recordId !== v.recordId || v.previousEventId !== previous.eventId || e.at < previous.event.at) refuse('OrderEventSequenceRefused');
    if (previous.event.versionId === e.versionId && JSON.stringify(previous.event) !== JSON.stringify(e)) refuse('OrderClinicalVersionImmutable');
    if (previous.event.versionId === e.versionId && (JSON.stringify(previous.facts.examCodes) !== JSON.stringify(facts.examCodes) ||
        previous.facts.requestingClinicianId !== facts.requestingClinicianId)) refuse('OrderClinicalVersionImmutable');
    if (previous.event.versionId !== e.versionId && (e.predecessor?.recordId !== previous.recordId ||
        e.predecessor?.partId !== previous.event.versionId || e.predecessor?.sha256 !== previous.event.sha256)) refuse('OrderHistoryIncomplete');
    validateOrderTransition(previous.facts, facts);
  } else if (v.previousEventId !== null) refuse('OrderHistoryIncomplete');
  return freeze(structuredClone({ ...v, facts })) as Readonly<OrderFact>;
}

export const ACCESS_RETENTION = freeze({ kind: 'access-audit' as const, years: RECORD_CLASSIFICATION['access-audit'].retention.years });
/** The end of a viewing-stream entry that started at `at` (and of an expiry checkpoint). */
export function accessRetentionFloor(at: string): string {
  return civilPeriodEnd(utc(at), ACCESS_RETENTION.years);
}
/** One EMR record an event is about, as bound in emr_access.access_target (IDs null when the event could not resolve them). */
export interface RecordTarget { index: number; kind: string; recordId: string | null; versionId: string | null }
/** The record targets of a parsed event, in target order: what append_operation binds from the same payload. */
export function recordTargets(input: unknown, served?: readonly ResolvedRecord[]): RecordTarget[] {
  const event = parseAccessEvent(input, served);
  return (event.targets as readonly { kind: any; recordId: any; versionId: any }[]).flatMap((target, index) =>
    NON_RECORD_TARGETS.includes(target.kind) ? [] : [{ index, kind: target.kind,
      recordId: target.recordId.status === 'known' ? target.recordId.value : null,
      versionId: target.versionId.status === 'known' ? target.versionId.value : null }]);
}
/** The target record's retention end (the record's own A retention, from unit H), or null when it cannot be established. */
export type RecordRetentionEnd = (target: RecordTarget) => string | null;
/** No record store is composed in B1: no history entry has an end until unit H supplies record ends. */
export const RECORD_RETENTION_UNAVAILABLE: RecordRetentionEnd = () => null;
/** The rule itself: an entry's end in its stream, or null when it has none yet. */
export function accessDeadline(stream: AccessStream, entry: { occurredAt: string; targets: readonly RecordTarget[]; retentionClass?: string },
  recordEnd: RecordRetentionEnd = RECORD_RETENTION_UNAVAILABLE): string | null {
  if (choice(stream, ACCESS_STREAMS) === 'viewing') return entry.retentionClass === 'rights3y' ? civilPeriodEnd(entry.occurredAt, 3) : accessRetentionFloor(entry.occurredAt);
  if (!entry.targets.length) return null;
  let deadline: string | null = accessRetentionFloor(entry.occurredAt);
  for (const target of entry.targets) {
    const end = target.recordId === null ? null : recordEnd(target);
    if (end === null) return null;
    if (deadline === null || utc(end) > deadline) deadline = utc(end);
  }
  return deadline;
}
// ── identity, ingress, credentials ──

const verifiedClaims = new WeakSet<object>();
export interface VerifiedClaims { issuer: string; subject: string; displayName: string | null }
/** Only the authentication verifier (B2: after JWT signature/issuer/audience checks) mints these. */
export function verifiedIdentityClaims(issuer: string, subject: string, displayName: string | null): Readonly<VerifiedClaims> {
  const claims = freeze({ issuer: string(issuer), subject: string(subject), displayName: displayName === null ? null : string(displayName, true) });
  verifiedClaims.add(claims);
  return claims;
}
/**
 * The immutable member identity of verified claims: the internal ID the database bound to exactly this issuer and
 * subject. A display name or e-mail is never a key; unverified input is never promoted to a known identity.
 */
export async function knownIdentity(claims: VerifiedClaims, resolve: (issuer: string, subject: string) => Promise<string>):
  Promise<{ status: 'known'; value: ImmutableIdentity }> {
  if (!claims || !verifiedClaims.has(claims)) refuse('VerifiedIdentityRequired');
  const id = string(await resolve(claims.issuer, claims.subject));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) refuse('IdentityBindingRefused');
  return freeze({ status: 'known' as const, value: { id, issuer: claims.issuer, subject: claims.subject } });
}

/**
 * The client address of a request, as the trusted ingress observed it. The address is known only when the TCP peer is
 * one of the deployment's proxies (which overwrite X-Real-IP) and that header holds one IP; otherwise it is unresolved -
 * a direct caller cannot choose its address with a header. In-process jobs have no client address.
 */
export function ingressAddress(peerAddress: string | null | undefined, headers: Readonly<Record<string, unknown>>, trustedPeers: ReadonlySet<string>):
  { status: 'known'; value: { address: string; source: 'trusted-proxy' } } | { status: 'unresolved'; reason: 'not-observed' } {
  const peer = typeof peerAddress === 'string' ? peerAddress.replace(/^::ffff:/, '') : '';
  const real = headers['x-real-ip'];
  if (!peer || !trustedPeers.has(peer) || typeof real !== 'string' || isIP(real) === 0) return { status: 'unresolved', reason: 'not-observed' };
  return { status: 'known', value: { address: real, source: 'trusted-proxy' } };
}
export const IN_PROCESS_SERVICE = freeze({ status: 'not-applicable' as const, reason: 'in-process-service' as const });

/** Audit link IDs and session references are audit-only values; a request presenting one as a credential is refused. */
export function refuseAuditNamespaceCredential(value: unknown): void {
  if (typeof value !== 'string' || /^(audit|authref):/i.test(value.trim())) refuse('AuditIdentifierIsNotACredential');
}


const durableReceipts = new WeakSet<object>();
/** Called only after successful COMMIT or a settled committed outcome. */
export function mintDurableReceipt(eventId: string, durableAt: string): Readonly<DurableAccessReceipt> {
  const receipt = freeze({ eventId: string(eventId), durableAt: utc(durableAt) });
  durableReceipts.add(receipt);
  return receipt;
}
export function isDurableReceipt(value: unknown): value is DurableAccessReceipt {
  return !!value && typeof value === 'object' && durableReceipts.has(value);
}
export async function provideAfterReceipt<T>(store: AppendOnlyAccessStore, input: AccessEvent,
  sendBody: (receipt: DurableAccessReceipt) => Promise<T>): Promise<T> {
  return provideAfterDurableEvent(store, input, receipt => {
    if (!isDurableReceipt(receipt)) refuse('DurableReceiptRefused');
    return sendBody(receipt);
  });
}
