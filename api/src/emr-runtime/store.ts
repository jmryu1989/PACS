import { PrismaClient } from '@prisma/client';
import { AccessEvent, AppendOnlyAccessStore, DurableAccessReceipt } from '../emr-contract/access-event';
import { ResolvedRecord } from '../emr-contract/classification';
import { ContractError, integer, refuse, sha256, string, utc } from '../emr-contract/validation';
import {
  AppendResult, ChainTail, ClauseRow, HoldRow, PlacementRow, RECORD_RETENTION_UNAVAILABLE, RecordRetentionEnd, RecordTarget,
  RequestRow, RetentionRow, StoredEntry, canonicalPayload, mintDurableReceipt, planExpiryPrefix,
} from './contract';
import { EmrSnapshot, SnapshotRequest, snapshotFromRows } from './context';
import { FailureJournal, JournalUnavailable } from './failure-journal';
import { RawQuery } from './manifest';
import { AccessSeal, SealRefused } from './seal';

/**
 * The protected access ledger store (EMR-B1). A ledger fact commits in the same PostgreSQL transaction as the business
 * change it describes; the receipt that lets a response go out exists only after that commit was read back and the
 * external seal moved over it. Every path that does not end in a receipt leaves its fact in the failure journal or as a
 * pending intent the next start resolves - never a success, never a second original event for the same attempt.
 *
 * A business change and its fact: the caller's own `$transaction` does the change and `appendInTransaction(tx, event)`
 * last; after it returns, `confirm(appended)`; when it throws, `settle(event, error)`. `append(event)` is the same for a
 * fact without a business change. All SQL is parameterized Prisma raw calls of the schema's own functions.
 */
export type LedgerFailureCode = 'CommitUnknown' | 'AppendNotCommitted' | 'LedgerRefused' | 'LedgerUnreachable' | 'SealUnavailable';
export class LedgerFailure extends Error {
  constructor(readonly code: LedgerFailureCode, readonly ledgerCode: string | null = null) {
    super(ledgerCode ? `${code}: ${ledgerCode}` : code); this.name = 'LedgerFailure';
  }
}
/** In-transaction position of an append. It is not durable and is never handed out as a receipt. */
export interface ProvisionalAppend { readonly provisional: true; readonly eventId: string; readonly sequence: number; readonly hash: string; readonly contentSha256: string }

/** The SQLSTATE a schema emr_access function raised, read from Prisma's raw-query error. */
export function ledgerErrorCode(error: unknown): string | null {
  const code = (error as any)?.meta?.code;
  if (typeof code === 'string' && /^EB\d{3}$/.test(code)) return code;
  const match = /\bCode: `(EB\d{3})`/.exec(String((error as any)?.message ?? ''));
  return match ? match[1] : null;
}
function isConnectionError(error: unknown): boolean {
  const code = (error as any)?.code;
  return typeof code === 'string' && ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(code);
}

const toNumber = (value: unknown) => integer(typeof value === 'bigint' ? Number(value) : value);
const toIso = (value: unknown) => utc(value instanceof Date ? value.toISOString() : value);
const toDay = (value: unknown) => (value instanceof Date ? value.toISOString() : string(value)).slice(0, 10);
function entry(row: any): StoredEntry {
  return { sequence: toNumber(row.sequence), previousHash: sha256(row.previous_hash), hash: sha256(row.hash),
    kind: row.kind === 'access' || row.kind === 'expiry' ? row.kind : refuse('StoredEntryInvalid'),
    eventId: row.event_id === null ? null : string(row.event_id), payload: string(row.payload),
    contentSha256: sha256(row.content_sha256), storedAt: toIso(row.stored_at) };
}

/** Committed-fact reads of the chain (outside any business transaction): what the seal proves itself against. */
export class PrismaLedgerSql {
  constructor(private readonly db: PrismaClient) {}

  async tail(): Promise<ChainTail> {
    const [row] = await this.db.$queryRaw<any[]>`SELECT chain_id::text AS chain_id, sequence, hash FROM emr_access.chain_tail()`;
    return { chainId: string(row.chain_id), sequence: toNumber(row.sequence), hash: sha256(row.hash) };
  }
  async entriesAfter(after: number, limit: number): Promise<StoredEntry[]> {
    const rows = await this.db.$queryRaw<any[]>`SELECT * FROM emr_access.entries_after(${integer(after)}::bigint, ${integer(limit, 1)}::integer)`;
    return rows.map(entry);
  }
  async entryForEvent(eventId: string): Promise<StoredEntry | null> {
    const rows = await this.db.$queryRaw<any[]>`SELECT * FROM emr_access.entry_for_event(${eventId}::text)`;
    return rows.length ? entry(rows[0]) : null;
  }
  async placement(): Promise<PlacementRow[]> {
    return this.db.$queryRaw<PlacementRow[]>`SELECT relation, relkind, tablespace FROM emr_access.storage_placement()`;
  }
}

export class AccessLedgerStore implements AppendOnlyAccessStore {
  constructor(private readonly db: PrismaClient, readonly sql: PrismaLedgerSql, readonly seal: AccessSeal, readonly journal: FailureJournal) {}

  /**
   * Inside the caller's open business transaction, last: A parses the event, the intent is made durable outside the
   * database, then the database appends under the chain-head lock and binds the event's record targets from the same
   * bytes. No deadline is stored (contract.ts accessDeadline computes it when destruction is considered). Any failure
   * here must abort the caller's transaction.
   */
  async appendInTransaction(tx: object, input: AccessEvent, served?: readonly ResolvedRecord[]): Promise<ProvisionalAppend> {
    const { event, text, contentSha256 } = canonicalPayload(input, served);
    this.seal.recordIntent(event.eventId, contentSha256);
    const result: AppendResult = await this.appendRow(tx, event.eventId, text);
    return Object.freeze({ provisional: true as const, eventId: event.eventId, sequence: result.sequence, hash: result.hash, contentSha256 });
  }

  /** After the caller's commit: prove it from storage, seal it, and only then mint the receipt. */
  async confirm(appended: ProvisionalAppend): Promise<DurableAccessReceipt> {
    let stored: StoredEntry | null;
    try { stored = await this.sql.entryForEvent(appended.eventId); } catch {
      this.note(appended.eventId, 'ledger-unavailable', 'commit-unknown');
      throw new LedgerFailure('CommitUnknown');
    }
    if (!stored) throw new LedgerFailure('AppendNotCommitted');
    if (stored.sequence !== appended.sequence || stored.hash !== appended.hash || stored.contentSha256 !== appended.contentSha256) refuse('DurableReceiptRefused');
    let sealed;
    try { sealed = await this.seal.advance({ sequence: stored.sequence, hash: stored.hash }); } catch (error) {
      // Committed but not sealed: no receipt. The same event resent, or the next start, seals it; nothing is appended twice.
      this.note(appended.eventId, 'ledger-unavailable', 'seal-unavailable');
      throw error instanceof SealRefused && error.code !== 'SealUnavailable' ? error : new LedgerFailure('SealUnavailable');
    }
    return mintDurableReceipt(stored, sealed);
  }

  /** One standalone ledger fact (a provision before its body, a refusal, an end without a business change). */
  async append(input: AccessEvent, served?: readonly ResolvedRecord[]): Promise<DurableAccessReceipt> {
    let appended: ProvisionalAppend;
    try {
      appended = await this.db.$transaction(tx => this.appendInTransaction(tx, input, served), { timeout: 15000, maxWait: 10000 });
    } catch (error) {
      await this.settle(input, error, served);
      throw error;
    }
    return this.confirm(appended);
  }

  /**
   * A transaction that did not report a commit. No stored entry: the attempt rolled back (journal it, drop its intent).
   * Storage unreadable, or this very content stored after all: the commit is unknown to this response (journal it, keep
   * the intent; the resend of the same event ID or the next start settles it) - never a success, never a new event.
   * Another content stored under this ID: this attempt was refused; the first attempt's intent stays.
   */
  async settle(input: AccessEvent, error: unknown, served?: readonly ResolvedRecord[]): Promise<void> {
    const { event, contentSha256 } = canonicalPayload(input, served);
    const eventId = event.eventId;
    let stored: StoredEntry | null | undefined;
    try { stored = await this.sql.entryForEvent(eventId); } catch { stored = undefined; }
    if (stored === undefined || (stored && stored.contentSha256 === contentSha256)) { this.note(eventId, 'ledger-unavailable', 'commit-unknown'); return; }
    if (stored) { this.note(eventId, 'append-rolled-back', 'ledger-refused'); return; }
    const cause = error instanceof SealRefused ? 'seal-unavailable' : ledgerErrorCode(error) ? 'ledger-refused' :
      isConnectionError(error) ? 'ledger-unreachable' : 'business-rollback';
    this.note(eventId, 'append-rolled-back', cause);
    if (!(error instanceof ContractError && error.code === 'AccessEventIdConflict')) this.seal.clearIntent(eventId);
  }

  private note(eventId: string, kind: 'append-rolled-back' | 'ledger-unavailable', cause: string): void {
    try { this.journal.record(`${kind}:${eventId}:${cause}`, kind, { eventId, cause }); }
    catch (error) {
      // Without the journal there is no surviving record of this failure: surface that, never a success.
      if (error instanceof JournalUnavailable) throw new LedgerFailure('LedgerUnreachable', error.code);
      throw error;
    }
  }

  /** Every fact one A decision may consult, read under the caller's transaction, as that transaction's snapshot. */
  async snapshot(tx: object, scope: object, request: SnapshotRequest): Promise<EmrSnapshot> {
    const holds = new Map<string, HoldRow[]>(), accessRequests = new Map<string, RequestRow[]>(), correctionRequests = new Map<string, RequestRow[]>();
    const clauseVersions = new Map<string, ClauseRow[]>(), accessEvents = new Map<string, StoredEntry | null>();
    for (const id of request.recordIds ?? []) holds.set(id, await this.holdRows(tx, string(id)));
    for (const id of request.accessRequestIds ?? []) accessRequests.set(id, await this.requestRows(tx, 'access-request', string(id)));
    for (const id of request.correctionRequestIds ?? []) correctionRequests.set(id, await this.requestRows(tx, 'correction-request', string(id)));
    for (const id of request.clauseIds ?? []) clauseVersions.set(id, await this.clauseRows(tx, string(id)));
    for (const id of request.accessEventIds ?? []) accessEvents.set(id, await this.entryRow(tx, string(id)));
    return snapshotFromRows(scope, { holds, accessRequests, correctionRequests, clauseVersions, accessEvents });
  }

  // ── legal-duty facts (append-only; A validates them when they are read back) ──
  async recordHold(tx: object, hold: { holdId: string; recordId: string; release: unknown }): Promise<void> {
    if (hold.release !== null) refuse('HoldReleaseBindingRefused');
    await this.placeHoldRow(tx, string(hold.holdId), string(hold.recordId), JSON.stringify(hold));
  }
  /** The release record carries the placement's exact facts with its release; anything else is refused before storage. */
  async recordHoldRelease(tx: object, released: { holdId: string; recordId: string; release: unknown }): Promise<void> {
    const rows = await this.holdRows(tx, string(released.recordId));
    const placed = rows.find(r => r.holdId === released.holdId && r.phase === 'placed');
    if (!placed || released.release === null || typeof released.release !== 'object' ||
        placed.body !== JSON.stringify({ ...released, release: null })) refuse('HoldReleaseBindingRefused');
    await this.releaseHoldRow(tx, string(released.holdId), JSON.stringify(released));
  }
  async recordDutyRequest(tx: object, kind: 'access-request' | 'correction-request', facts: { requestId: string; resolution: unknown }): Promise<void> {
    const phase = facts.resolution === null ? 'received' : 'resolved';
    await this.dutyRequestRow(tx, kind, string(facts.requestId), phase, JSON.stringify(facts));
  }
  /** The immutable internal member ID of a verified issuer and subject (created once; names are never a key). */
  async resolveIdentity(tx: object, issuer: string, subject: string): Promise<string> {
    const run = tx as RawQuery;
    const [row] = await run.$queryRaw<any[]>`SELECT emr_access.resolve_member_identity(${string(issuer)}::text, ${string(subject)}::text)::text AS id`;
    return string(row.id);
  }
  /** The one legacy AuditLog row projecting an original event (unit B2), in the same transaction as both. */
  async recordProjection(tx: object, eventId: string, auditLogId: number): Promise<void> {
    const run = tx as RawQuery;
    await run.$queryRaw`SELECT emr_access.record_projection(${string(eventId)}::text, ${integer(auditLogId, 1)}::integer)::text AS done`;
  }

  // ── the schema functions under the caller's transaction (each value bound as a parameter) ──
  async appendRow(tx: object, eventId: string, payload: string): Promise<AppendResult> {
    const run = tx as RawQuery;
    const [row] = await run.$queryRaw<any[]>`SELECT chain_id::text AS chain_id, sequence, previous_hash, hash, stored_at, replay
      FROM emr_access.append_access(${eventId}::text, ${payload}::text)`;
    return { chainId: string(row.chain_id), sequence: toNumber(row.sequence), previousHash: sha256(row.previous_hash), hash: sha256(row.hash),
      storedAt: toIso(row.stored_at), replay: row.replay === true };
  }
  async holdRows(tx: object, recordId: string): Promise<HoldRow[]> {
    const run = tx as RawQuery;
    const rows = await run.$queryRaw<any[]>`SELECT hold_id, phase, body FROM emr_access.holds_for(${recordId}::text)`;
    return rows.map(r => ({ holdId: string(r.hold_id), phase: r.phase === 'released' ? 'released' : 'placed', body: string(r.body) }));
  }
  async placeHoldRow(tx: object, holdId: string, recordId: string, body: string): Promise<void> {
    const run = tx as RawQuery;
    await run.$queryRaw`SELECT emr_access.place_hold(${holdId}::text, ${recordId}::text, ${body}::text)::text AS done`;
  }
  async releaseHoldRow(tx: object, holdId: string, body: string): Promise<void> {
    const run = tx as RawQuery;
    await run.$queryRaw`SELECT emr_access.release_hold(${holdId}::text, ${body}::text)::text AS done`;
  }
  async requestRows(tx: object, kind: 'access-request' | 'correction-request', requestId: string): Promise<RequestRow[]> {
    const run = tx as RawQuery;
    const rows = await run.$queryRaw<any[]>`SELECT phase, body FROM emr_access.duty_requests(${kind}::text, ${requestId}::text)`;
    return rows.map(r => ({ phase: r.phase === 'resolved' ? 'resolved' : 'received', body: string(r.body) }));
  }
  async dutyRequestRow(tx: object, kind: 'access-request' | 'correction-request', requestId: string, phase: 'received' | 'resolved', body: string): Promise<void> {
    const run = tx as RawQuery;
    await run.$queryRaw`SELECT emr_access.record_duty_request(${kind}::text, ${requestId}::text, ${phase}::text, ${body}::text)::text AS done`;
  }
  async clauseRows(tx: object, clauseId: string): Promise<ClauseRow[]> {
    const run = tx as RawQuery;
    const rows = await run.$queryRaw<any[]>`SELECT law, article, publication, published_at, effective_at FROM emr_access.clause_versions(${clauseId}::text)`;
    return rows.map(r => ({ law: string(r.law), article: string(r.article), publication: string(r.publication),
      publishedAt: toDay(r.published_at), effectiveAt: toDay(r.effective_at) }));
  }
  async entryRow(tx: object, eventId: string): Promise<StoredEntry | null> {
    const run = tx as RawQuery;
    const rows = await run.$queryRaw<any[]>`SELECT * FROM emr_access.entry_for_event(${eventId}::text)`;
    return rows.length ? entry(rows[0]) : null;
  }
}

function boundTargets(value: unknown): RecordTarget[] {
  if (!Array.isArray(value)) refuse('RetentionViewIncomplete');
  return (value as any[]).map(t => ({ index: integer(t.index), kind: string(t.kind),
    recordId: t.recordId === null ? null : string(t.recordId), versionId: t.versionId === null ? null : string(t.versionId) }));
}
/**
 * The access-ledger retention job (its own process and credential, kin_emr_retention; never the API runtime). It reads
 * positions, each entry's own time, its bound record targets and holds - no payload - and computes each end now, with the
 * one rule (contract.ts accessDeadline) and the record retention ends it is given (none in B1: record-bound entries stay).
 * The database re-checks the floor, the record binding and the holds and appends the non-personal checkpoint in the
 * deleting transaction. Scheduling it is not part of this unit.
 */
export async function expireAccessPrefix(retention: RawQuery, now = new Date().toISOString(), recordEnd: RecordRetentionEnd = RECORD_RETENTION_UNAVAILABLE):
  Promise<{ deleted: number; checkpointSequence: number; checkpointHash: string } | null> {
  const rows: RetentionRow[] = [];
  let after = 0;
  for (;;) {
    const page = await retention.$queryRaw<any[]>`SELECT sequence, hash, kind, occurred_at, targets, held FROM emr_access.retention_view(${after}::bigint, 1000)`;
    for (const row of page) rows.push({ sequence: toNumber(row.sequence), hash: sha256(row.hash), kind: row.kind === 'expiry' ? 'expiry' : 'access',
      occurredAt: toIso(row.occurred_at), targets: boundTargets(row.targets), held: row.held === true });
    if (page.length < 1000) break;
    after = toNumber(page[page.length - 1].sequence);
  }
  const plan = planExpiryPrefix(rows, now, recordEnd);
  if (!plan) return null;
  const through = plan.through;
  const [row] = await retention.$queryRaw<any[]>`SELECT deleted_count, checkpoint_sequence, checkpoint_hash FROM emr_access.expire_prefix(${through}::bigint)`;
  return { deleted: toNumber(row.deleted_count), checkpointSequence: toNumber(row.checkpoint_sequence), checkpointHash: sha256(row.checkpoint_hash) };
}
