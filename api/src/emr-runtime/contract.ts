import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import {
  AccessEvent, AccessExpiryCheckpoint, ACCESS_CHAIN_GENESIS, ChainPosition, DurableAccessReceipt, AppendOnlyAccessStore,
  ImmutableIdentity, accessRetention, parseAccessEvent, provideAfterDurableEvent,
} from '../emr-contract/access-event';
import { ResolvedRecord } from '../emr-contract/classification';
import { retentionDeadline } from '../emr-contract/lawful-defaults';
import { freeze, integer, object, refuse, sha256, string, utc } from '../emr-contract/validation';

/**
 * B's binding of the A contract to stored facts. Everything here is a pure rule over values the storage adapter read; the
 * adapter itself (store.ts, PrismaLedgerSql) is the only code that talks to the database.
 */

export interface StoredEntry {
  sequence: number; previousHash: string; hash: string; kind: 'access' | 'expiry';
  eventId: string | null; payload: string; contentSha256: string; storedAt: string;
}
export interface ChainTail { chainId: string; sequence: number; hash: string }
export interface AppendResult extends ChainTail { previousHash: string; storedAt: string; replay: boolean }
export interface HoldRow { holdId: string; phase: 'placed' | 'released'; body: string }
export interface RequestRow { phase: 'received' | 'resolved'; body: string }
export interface ClauseRow { law: string; article: string; publication: string; publishedAt: string; effectiveAt: string }
export interface PlacementRow { relation: string; relkind: string; tablespace: string }

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
/** The server's canonical text of one access event: A's parse, then A's payload shape, serialized once. */
export function canonicalPayload(input: unknown, served?: readonly ResolvedRecord[]): { event: Readonly<AccessEvent>; text: string; contentSha256: string } {
  const event = parseAccessEvent(input, served);
  const text = JSON.stringify({ kind: 'access', event });
  return freeze({ event, text, contentSha256: createHash('sha256').update(text).digest('hex') });
}
const genesis = (): ChainPosition => ({ sequence: ACCESS_CHAIN_GENESIS.sequence, hash: ACCESS_CHAIN_GENESIS.hash });

/**
 * Stored entries from `anchor` must reach `expectedTail` with no gap, repeat or changed byte: each entry's hash is
 * recomputed over its stored payload and links to its predecessor; access entries carry their event ID; a checkpoint
 * names a deleted prefix that ends before it. Returns the closed reason of the first violation, or null.
 */
export function chainViolation(anchor: ChainPosition, entries: readonly StoredEntry[], expectedTail: ChainPosition): string | null {
  let previous = { sequence: anchor.sequence, hash: anchor.hash };
  for (const entry of entries) {
    if (entry.sequence !== previous.sequence + 1) return entry.sequence <= previous.sequence ? 'repeated-sequence' : 'missing-entry';
    if (entry.previousHash !== previous.hash) return 'broken-link';
    if (entryHash(entry.sequence, entry.previousHash, entry.payload) !== entry.hash) return 'changed-entry';
    if (createHash('sha256').update(entry.payload).digest('hex') !== entry.contentSha256) return 'changed-entry';
    let payload: any;
    try { payload = JSON.parse(entry.payload); } catch { return 'changed-entry'; }
    if (payload?.kind !== entry.kind) return 'changed-entry';
    if (entry.kind === 'access' && payload.event?.eventId !== entry.eventId) return 'changed-entry';
    if (entry.kind === 'expiry' && !(Number.isSafeInteger(payload.deletedThrough) && payload.deletedThrough < entry.sequence)) return 'changed-entry';
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

/** Each access event's own two-year deadline from A (제8조①2). Requires the composed readers and a hold snapshot. */
export function accessExpiry(event: AccessEvent): string {
  return retentionDeadline(accessRetention(event));
}
export interface RetentionRow { sequence: number; hash: string; expiresAt: string; held: boolean }
/**
 * The longest retained prefix whose every entry has passed its own deadline and carries no unreleased hold. Returns the
 * last sequence of that prefix and its hash, or null when the first retained entry may not go. Reading an entry never
 * moves a deadline: deadlines come from the stored expiry of each entry only. The database re-checks the same rule.
 */
export function planExpiryPrefix(rows: readonly RetentionRow[], now: string): { through: number; hash: string; count: number } | null {
  utc(now);
  let plan: { through: number; hash: string; count: number } | null = null;
  let previous: number | null = null;
  for (const row of rows) {
    if (previous !== null && row.sequence !== previous + 1) refuse('RetentionViewIncomplete');
    previous = row.sequence;
    if (utc(row.expiresAt) > now || row.held) break;
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
  const v = object(value, ['sequence', 'previousHash', 'hash', 'kind', 'eventId', 'payload', 'contentSha256', 'storedAt']);
  return { sequence: integer(v.sequence, 1), previousHash: sha256(v.previousHash), hash: sha256(v.hash),
    kind: v.kind === 'access' || v.kind === 'expiry' ? v.kind : refuse('StoredEntryInvalid'),
    eventId: v.eventId === null ? null : string(v.eventId), payload: string(v.payload), contentSha256: sha256(v.contentSha256), storedAt: utc(v.storedAt) };
}
