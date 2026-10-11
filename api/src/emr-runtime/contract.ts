import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import {
  ACCESS_STREAMS, AccessEvent, AccessExpiryCheckpoint, AccessStream, ACCESS_CHAIN_GENESIS, ChainPosition, DurableAccessReceipt,
  AppendOnlyAccessStore, ImmutableIdentity, NON_RECORD_TARGETS, StatutoryAct, parseAccessEvent, provideAfterDurableEvent,
} from '../emr-contract/access-event';
import { RECORD_CLASSIFICATION, ResolvedRecord, OrderFacts, parseOrderFacts, RecordEvent, parseRecordEvent } from '../emr-contract/classification';
import { civilPeriodEnd, validateOrderTransition } from '../emr-contract/lawful-defaults';
import { choice, freeze, integer, object, refuse, sha256, string, utc } from '../emr-contract/validation';

/**
 * B's binding of the A contract to stored facts. Everything here is a pure rule over values the storage adapter read; the
 * adapter itself (store.ts, PrismaLedgerSql) is the only code that talks to the database. The ledger is two streams
 * (A ACCESS_STREAMS, D-1): each is its own chain, read and sealed on its own.
 */

export interface StoredEntry {
  sequence: number; previousHash: string; hash: string; kind: 'access' | 'expiry' | 'history'; statutoryAct: StatutoryAct | null;
  eventId: string | null; payload: string; contentSha256: string; storedAt: string;
}
export interface ChainTail { chainId: string; sequence: number; hash: string }
export interface AppendResult extends ChainTail { previousHash: string; storedAt: string; replay: boolean }
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

/** The SQLSTATE codes schema emr_access raises (migration 20261008120000_emr_b). */
export const LEDGER_ERRORS = freeze({
  EB001: 'EmrStoragePlacementRequired', EB002: 'AccessEventIdConflict', EB003: 'AccessPayloadInvalid',
  EB004: 'RetentionNotElapsed', EB005: 'LegalHoldActive', EB006: 'ExpiryPrefixInvalid', EB007: 'ProjectionWithoutEvent',
} as const);

// ── chain bytes ──

/** Exactly the bytes A's chainEntry hashes, computed over the stored payload text. */
export function entryHash(sequence: number, previousHash: string, payload: string): string {
  return createHash('sha256').update(`{"sequence":${integer(sequence, 1)},"previousHash":"${sha256(previousHash)}","payload":${payload}}`).digest('hex');
}
/** The payload kind of an event entry in each stream (A sealAccessEvent): 'access' in the viewing stream, 'history' in the other. */
export const STREAM_ENTRY_KIND: Readonly<Record<AccessStream, 'access' | 'history'>> = freeze({ viewing: 'access', history: 'history' });
/** The server's canonical text of one access event in one stream: A's parse, then A's payload shape, serialized once. */
export function canonicalPayload(input: unknown, served?: readonly ResolvedRecord[], stream: AccessStream = 'viewing'):
  { event: Readonly<AccessEvent>; text: string; contentSha256: string } {
  const event = parseAccessEvent(input, served);
  const text = JSON.stringify({ kind: STREAM_ENTRY_KIND[choice(stream, ACCESS_STREAMS)], event });
  return freeze({ event, text, contentSha256: createHash('sha256').update(text).digest('hex') });
}
const genesis = (): ChainPosition => ({ sequence: ACCESS_CHAIN_GENESIS.sequence, hash: ACCESS_CHAIN_GENESIS.hash });

/**
 * Stored entries of one stream from `anchor` must reach `expectedTail` with no gap, repeat or changed byte: each entry's
 * hash is recomputed over its stored payload and links to its predecessor; an event entry carries its event ID and its
 * stream's payload kind; a checkpoint (viewing stream only) names a deleted prefix that ends before it. Returns the closed
 * reason of the first violation, or null.
 */
export function chainViolation(anchor: ChainPosition, entries: readonly StoredEntry[], expectedTail: ChainPosition, stream: AccessStream = 'viewing'): string | null {
  choice(stream, ACCESS_STREAMS);
  let previous = { sequence: anchor.sequence, hash: anchor.hash };
  for (const entry of entries) {
    if (entry.sequence !== previous.sequence + 1) return entry.sequence <= previous.sequence ? 'repeated-sequence' : 'missing-entry';
    if (entry.previousHash !== previous.hash) return 'broken-link';
    if (entryHash(entry.sequence, entry.previousHash, entry.payload) !== entry.hash) return 'changed-entry';
    if (createHash('sha256').update(entry.payload).digest('hex') !== entry.contentSha256) return 'changed-entry';
    let payload: any;
    try { payload = JSON.parse(entry.payload); } catch { return 'changed-entry'; }
    if (payload?.kind !== entry.kind) return 'changed-entry';
    if (entry.kind === 'expiry' ? stream !== 'viewing' : entry.kind !== STREAM_ENTRY_KIND[stream]) return 'foreign-stream';
    if (entry.kind !== 'expiry' && payload.event?.eventId !== entry.eventId) return 'changed-entry';
    if (entry.kind === 'expiry') {
      try {
        object(payload, ['kind', 'at', 'deletedThrough', 'deletedCount', 'anchorHash']);
        utc(payload.at); integer(payload.deletedThrough, 1); integer(payload.deletedCount, 1); sha256(payload.anchorHash);
        if (payload.deletedThrough >= entry.sequence || payload.deletedCount > payload.deletedThrough) return 'changed-entry';
      } catch { return 'changed-entry'; }
    }
    previous = { sequence: entry.sequence, hash: entry.hash };
  }
  if (previous.sequence !== expectedTail.sequence) return previous.sequence < expectedTail.sequence ? 'missing-tail' : 'beyond-tail';
  if (previous.hash !== expectedTail.hash) return 'tail-hash';
  return null;
}
/**
 * Where a retained chain may start: the genesis, or exactly after a deleted prefix whose checkpoint is still retained and
 * names that end and its hash. A missing first entry without such a checkpoint is a deletion, not an expiry.
 */
export function retainedAnchor(entries: readonly StoredEntry[]): ChainPosition | null {
  if (!entries.length) return null;
  const first = entries[0];
  if (first.sequence === 1) return first.previousHash === ACCESS_CHAIN_GENESIS.hash ? genesis() : null;
  const anchor = { sequence: first.sequence - 1, hash: first.previousHash };
  const justified = entries.some(e => {
    if (e.kind !== 'expiry') return false;
    try { const p = JSON.parse(e.payload); return p.deletedThrough === anchor.sequence && p.anchorHash === anchor.hash; } catch { return false; }
  });
  return justified ? anchor : null;
}

// ── retention ──

/**
 * B's one access-retention rule (commander D727; legal register 2026-10-09 §5-11, D-1, cross-checked). No deadline is
 * stored with an entry: it is computed only when destruction is considered, here and nowhere else.
 *  - viewing stream: every event ends at the floor - A's classification period for access records
 *    (RECORD_CLASSIFICATION['access-audit'].retention, from A's statutory table) counted from the event's own day (D-21) -
 *    and later only while a legal hold (or another verified legal basis) keeps it. This covers 열람 events, events about no
 *    record, and the floor remainder of every change.
 *  - history stream: a change of EMR records (기재·추가기재·수정) ends with the retention of every record it changed; while a
 *    record's end is unknown it has no end. Unit H destroys it with that record's destruction set; B1 has no such path.
 * The database holds the same floor once (emr_access.access_retention_floor, kept equal by C10 and L05) and binds each
 * event's record targets from its chained payload (emr_access.access_target).
 */
export const ACCESS_RETENTION = freeze({ kind: 'access-audit' as const, years: RECORD_CLASSIFICATION['access-audit'].retention.years });
/** The end of a viewing-stream entry that started at `at` (and of an expiry checkpoint). */
export function accessRetentionFloor(at: string): string {
  return civilPeriodEnd(utc(at), ACCESS_RETENTION.years);
}
/** One EMR record an event is about, as bound in emr_access.access_target (IDs null when the event could not resolve them). */
export interface RecordTarget { index: number; kind: string; recordId: string | null; versionId: string | null }
/** The record targets of a parsed event, in target order: what append_access binds from the same payload. */
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
export function accessDeadline(stream: AccessStream, entry: { occurredAt: string; targets: readonly RecordTarget[] },
  recordEnd: RecordRetentionEnd = RECORD_RETENTION_UNAVAILABLE): string | null {
  if (choice(stream, ACCESS_STREAMS) === 'viewing') return accessRetentionFloor(entry.occurredAt);
  if (!entry.targets.length) return null;
  let deadline: string | null = null;
  for (const target of entry.targets) {
    const end = target.recordId === null ? null : recordEnd(target);
    if (end === null) return null;
    if (deadline === null || utc(end) > deadline) deadline = utc(end);
  }
  return deadline;
}
export interface RetentionRow { sequence: number; hash: string; kind: 'access' | 'expiry'; occurredAt: string; held: boolean }
/**
 * Viewing stream only: the longest retained prefix whose every entry is past its end under the rule above and carries no
 * unreleased hold. Returns the last sequence of that prefix and its hash, or null when the first retained entry may not go.
 * Reading an entry never moves its end: only its own time and holds count. The database re-checks the floor and the holds.
 */
export function planExpiryPrefix(rows: readonly RetentionRow[], now: string): { through: number; hash: string; count: number } | null {
  utc(now);
  let plan: { through: number; hash: string; count: number } | null = null;
  let previous: number | null = null;
  for (const row of rows) {
    if (previous !== null && row.sequence !== previous + 1) refuse('RetentionViewIncomplete');
    previous = row.sequence;
    const deadline = accessDeadline('viewing', { occurredAt: row.occurredAt, targets: [] });
    if (deadline === null || deadline > now || row.held) break;
    plan = { through: row.sequence, hash: row.hash, count: (plan?.count ?? 0) + 1 };
  }
  return plan;
}
/** A's checkpoint payload text for a prefix deleted at `at`. */
export function checkpointPayload(at: string, through: number, count: number, anchorHash: string): string {
  const checkpoint: AccessExpiryCheckpoint = { kind: 'expiry', at: utc(at), deletedThrough: integer(through, 1), deletedCount: integer(count, 1), anchorHash: sha256(anchorHash) };
  return JSON.stringify(checkpoint);
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

// ── durable receipts ──

const durableReceipts = new WeakSet<object>();
/** Store-only: a receipt exists after the event's commit was read back and its position sealed. */
export function mintDurableReceipt(entry: StoredEntry, sealed: ChainPosition): Readonly<DurableAccessReceipt> {
  if (entry.kind !== 'access' || entry.eventId === null || sealed.sequence < entry.sequence) refuse('DurableReceiptRefused');
  const receipt = freeze({ eventId: entry.eventId, durableAt: utc(entry.storedAt) });
  durableReceipts.add(receipt);
  return receipt;
}
export function isDurableReceipt(value: unknown): value is DurableAccessReceipt { return !!value && typeof value === 'object' && durableReceipts.has(value); }
/** A's first-byte rule with B's receipt: nothing of the body before the store's own durable receipt for this event. */
export async function provideAfterReceipt<T>(store: AppendOnlyAccessStore, input: AccessEvent, sendBody: (receipt: DurableAccessReceipt) => Promise<T>): Promise<T> {
  return provideAfterDurableEvent(store, input, async receipt => {
    if (!isDurableReceipt(receipt)) refuse('DurableReceiptRefused');
    return sendBody(receipt);
  });
}
export function parseStoredEntry(value: unknown): StoredEntry {
  const v = object(value, ['sequence', 'previousHash', 'hash', 'kind', 'statutoryAct', 'eventId', 'payload', 'contentSha256', 'storedAt']);
  return { sequence: integer(v.sequence, 1), previousHash: sha256(v.previousHash), hash: sha256(v.hash),
    kind: v.kind === 'access' || v.kind === 'expiry' || v.kind === 'history' ? v.kind : refuse('StoredEntryInvalid'),
    statutoryAct: v.statutoryAct === null ? null : choice(v.statutoryAct, ['기재', '추가기재', '수정', '열람', 'none'] as const),
    eventId: v.eventId === null ? null : string(v.eventId), payload: string(v.payload), contentSha256: sha256(v.contentSha256), storedAt: utc(v.storedAt) };
}
