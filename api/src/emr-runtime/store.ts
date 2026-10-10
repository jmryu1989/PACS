import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  ACCESS_STREAMS, AccessEvent, AccessStream, AppendOnlyAccessStore, DurableAccessReceipt, StatutoryAct, accessStreams, statutoryAct,
} from '../emr-contract/access-event';
import { ResolvedRecord } from '../emr-contract/classification';
import { ContractError, choice, integer, refuse, sha256, string, utc } from '../emr-contract/validation';
import {
  AppendResult, ChainTail, ClauseRow, HoldRow, PlacementRow, RequestRow, RetentionRow, StoredEntry, canonicalPayload, mintDurableReceipt,
  planExpiryPrefix, OrderFact, parseOrderFact,
} from './contract';
import { EmrSnapshot, SnapshotRequest, snapshotFromRows } from './context';
import { FailureJournal, JournalUnavailable } from './failure-journal';
import { RawQuery } from './manifest';
import { AccessSeal, SealRefused, SealState, CommitBinding } from './seal';
import { admitAppend } from './admission';
import { EMR_TX_MAX_WAIT_MS, EMR_TX_TIMEOUT_MS, EMR_RECOVERY_TIMEOUT_MS } from './limits';

/**
 * The protected access ledger store (EMR-B1). A ledger fact commits in the same PostgreSQL transaction as the business
 * change it describes - in every stream A assigns it (D-1: always the viewing stream; also the history stream for a change
 * of a record) - and the receipt that lets a response go out exists only after each entry was read back and its stream's
 * external seal moved over it. Every path that does not end in a receipt leaves its fact in the failure journal or as a
 * pending intent the next start resolves - never a success, never a second original event for the same attempt.
 *
 * A business change and its fact: `withAppendTransaction` does the caller's change and `appendInTransaction(tx, event)`
 * last; after it returns, `confirm(appended)`; when it throws, `settle(event, error)`. `append(event)` is the same for a
 * fact without a business change. All SQL is parameterized Prisma raw calls of the schema's own functions.
 */
export type LedgerFailureCode = 'CommitUnknown' | 'AppendNotCommitted' | 'LedgerRefused' | 'LedgerUnreachable' | 'SealUnavailable';
export class LedgerFailure extends Error {
  constructor(readonly code: LedgerFailureCode, readonly ledgerCode: string | null = null) {
    super(ledgerCode ? `${code}: ${ledgerCode}` : code); this.name = 'LedgerFailure';
  }
}
/** In-transaction positions of an append, one per stream. Not durable and never handed out as a receipt. */
export interface ProvisionalEntry { readonly stream: AccessStream; readonly sequence: number; readonly hash: string; readonly contentSha256: string; readonly attemptId: string; readonly previousHash: string; readonly payload: string; readonly storedAt: string }
export interface ProvisionalAppend { readonly provisional: true; readonly eventId: string; readonly entries: readonly ProvisionalEntry[] }

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
    kind: row.kind === 'access' || row.kind === 'expiry' || row.kind === 'history' ? row.kind : refuse('StoredEntryInvalid'),
    statutoryAct: row.statutory_act === null ? null : choice(row.statutory_act, ['기재', '추가기재', '수정', '열람', 'none'] as const),
    eventId: row.event_id === null ? null : string(row.event_id), payload: string(row.payload),
    contentSha256: sha256(row.content_sha256), storedAt: toIso(row.stored_at) };
}

/** Committed-fact reads of one stream's chain (outside any business transaction): what the seal proves itself against. */
export interface VerificationPage {
  tail: ChainTail;
  first: Pick<StoredEntry, 'sequence' | 'previousHash'> | null;
  entries: { entry: StoredEntry; marker: CommitBinding | null }[];
}
export class PrismaLedgerSql {
  constructor(private readonly db: any, private readonly inSnapshot = false) {}

  async snapshot<T>(work: (sql: PrismaLedgerSql) => Promise<T>): Promise<T> {
    if (this.inSnapshot) return work(this);
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT emr_access.enter_writer()::text`;
      return work(new PrismaLedgerSql(tx, true));
    }, { isolationLevel: 'RepeatableRead', maxWait: EMR_TX_MAX_WAIT_MS, timeout: EMR_TX_TIMEOUT_MS });
  }
  async withWriterFence<T>(work: (sql: PrismaLedgerSql) => Promise<T>): Promise<T> {
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT emr_access.fence_writers()::text`;
      return work(new PrismaLedgerSql(tx, true));
    }, { maxWait: EMR_TX_MAX_WAIT_MS, timeout: EMR_RECOVERY_TIMEOUT_MS });
  }
  private marker(row: any): CommitBinding | null {
    if (!row) return null;
    return { stream: row.stream, chainId: row.chain_id, attemptId: row.attempt_id, bundleId: row.bundle_id, kind: row.kind,
      eventId: row.event_id, sequence: toNumber(row.sequence), previousHash: row.previous_hash, hash: row.hash,
      contentSha256: row.content_sha256, generation: toNumber(row.generation), proofDigest: row.proof_digest };
  }
  async markerForSlot(stream: AccessStream, sequence: number): Promise<CommitBinding | null> {
    const rows = await this.db.$queryRaw`SELECT * FROM emr_access.commit_marker_for_slot(${stream}::text, ${sequence}::bigint)`;
    return this.marker(rows[0]);
  }
  async markerForAttempt(stream: AccessStream, attemptId: string): Promise<CommitBinding | null> {
    const rows = await this.db.$queryRaw`SELECT * FROM emr_access.commit_marker_for_attempt(${stream}::text, ${attemptId}::text)`;
    return this.marker(rows[0]);
  }

  async tail(stream: AccessStream): Promise<ChainTail> {
    const [row] = await this.db.$queryRaw<any[]>`SELECT chain_id::text AS chain_id, sequence, hash FROM emr_access.chain_tail(${choice(stream, ACCESS_STREAMS)}::text)`;
    return { chainId: string(row.chain_id), sequence: toNumber(row.sequence), hash: sha256(row.hash) };
  }
  async entriesAfter(stream: AccessStream, after: number, limit: number): Promise<StoredEntry[]> {
    const rows = await this.db.$queryRaw<any[]>`SELECT * FROM emr_access.entries_after(${choice(stream, ACCESS_STREAMS)}::text, ${integer(after)}::bigint, ${integer(limit, 1)}::integer)`;
    return rows.map(entry);
  }
  /** The same snapshot proves the retained anchor and every fetched row's exact
   * commit marker in one round trip. The page is bounded by the receipt target. */
  async verificationPage(stream: AccessStream, after: number, limit: number): Promise<VerificationPage> {
    const selected = choice(stream, ACCESS_STREAMS);
    const rows = await this.db.$queryRaw<any[]>`SELECT t.chain_id::text AS tail_chain_id,
      t.sequence AS tail_sequence, t.hash AS tail_hash, f.sequence AS first_sequence,
      f.previous_hash AS first_previous_hash, e.*, CASE WHEN m.sequence IS NULL THEN NULL ELSE to_jsonb(m) END AS commit_marker
      FROM emr_access.chain_tail(${selected}::text) t
      LEFT JOIN LATERAL emr_access.entries_after(${selected}::text, 0, 1) f ON true
      LEFT JOIN LATERAL emr_access.entries_after(${selected}::text, ${integer(after)}::bigint, ${integer(limit, 1)}::integer) e ON true
      LEFT JOIN LATERAL emr_access.commit_marker_for_slot(${selected}::text, e.sequence) m ON true
      ORDER BY e.sequence`;
    const head = rows[0];
    return { tail: { chainId: string(head.tail_chain_id), sequence: toNumber(head.tail_sequence), hash: sha256(head.tail_hash) },
      first: head.first_sequence === null ? null : { sequence: toNumber(head.first_sequence), previousHash: sha256(head.first_previous_hash) },
      entries: rows.filter(row => row.sequence !== null).map(row => ({ entry: entry(row), marker: this.marker(row.commit_marker) })) };
  }
  async entryForEvent(stream: AccessStream, eventId: string): Promise<StoredEntry | null> {
    const rows = await this.db.$queryRaw<any[]>`SELECT * FROM emr_access.entry_for_event(${choice(stream, ACCESS_STREAMS)}::text, ${eventId}::text)`;
    return rows.length ? entry(rows[0]) : null;
  }
  async placement(): Promise<PlacementRow[]> {
    return this.db.$queryRaw<PlacementRow[]>`SELECT relation, relkind, tablespace FROM emr_access.storage_placement()`;
  }
}

export class AccessLedgerStore implements AppendOnlyAccessStore {
  private readonly attempts = new WeakMap<object, { attemptId: string; streams: readonly AccessStream[] }>();
  constructor(private readonly db: PrismaClient, readonly sql: PrismaLedgerSql, readonly seal: AccessSeal, readonly journal: FailureJournal) {}

  /** Both standalone and business writers enter before acquiring a connection.
   * Callers include their business change and appendInTransaction in this same
   * callback; confirm remains outside it, after the successful COMMIT. Starting
   * a raw Prisma transaction first would bypass admission and reintroduce the
   * head-lock/pool priority inversion for business writes.
   */
  withAppendTransaction<T>(work: (tx: any) => Promise<T>): Promise<T> {
    return admitAppend(this.db, () => this.db.$transaction(work,
      { maxWait: EMR_TX_MAX_WAIT_MS, timeout: EMR_TX_TIMEOUT_MS }));
  }

  /**
   * Inside the caller's open business transaction, last: A parses the event and names its streams and 의료법 제23조④ act;
   * for each stream the intent is made durable outside the database, then the database appends under that stream's head
   * lock and binds the event's record targets from the same bytes. No deadline is stored (contract.ts accessDeadline
   * computes it when destruction is considered). Any failure here must abort the caller's transaction.
   */
  async appendInTransaction(tx: object, input: AccessEvent, served?: readonly ResolvedRecord[]): Promise<ProvisionalAppend> {
    const act = statutoryAct(input, served), entries: ProvisionalEntry[] = [];
    const attemptId = randomUUID(), bundleId = randomUUID();
    await this.enterWriter(tx);
    this.attempts.set(tx, { attemptId, streams: accessStreams(input, served) });
    let eventId = '';
    for (const stream of accessStreams(input, served)) {
      const { event, text, contentSha256 } = canonicalPayload(input, served, stream);
      eventId = event.eventId;
      await this.seal.recordIntentAsync(stream, attemptId, event.eventId, contentSha256, bundleId);
      let result: AppendResult;
      try { result = await this.appendRow(tx, stream, event.eventId, text, act, attemptId, bundleId); }
      catch (error) { if (ledgerErrorCode(error) === 'EB002') refuse('AccessEventIdConflict'); throw error; }
      if (result.replay) this.seal.abort(stream, attemptId);
      else {
        const binding = this.seal.reserve({ stream, chainId: result.chainId, attemptId, bundleId,
          kind: stream === 'viewing' ? 'access' : 'history', eventId, sequence: result.sequence,
          previousHash: result.previousHash, hash: result.hash, contentSha256 });
        await this.bindCommit(tx, binding);
      }
      entries.push(Object.freeze({ stream, sequence: result.sequence, hash: result.hash, contentSha256, attemptId, previousHash: result.previousHash, payload: text, storedAt: result.storedAt }));
    }
    return Object.freeze({ provisional: true as const, eventId, entries: Object.freeze(entries) });
  }
  async enterWriter(tx: object): Promise<void> {
    await (tx as RawQuery).$queryRaw`SELECT emr_access.enter_writer()::text`;
  }
  async bindCommit(tx: object, binding: CommitBinding): Promise<void> {
    await (tx as RawQuery).$queryRaw`SELECT emr_access.bind_commit(${binding.stream}::text, ${binding.attemptId}::text,
      ${binding.generation}::bigint, ${binding.proofDigest}::text)::text`;
  }

  /** After the caller's commit: prove every entry from storage, seal each stream, and only then mint the receipt. */
  async confirm(appended: ProvisionalAppend): Promise<DurableAccessReceipt> {
    let receipt: DurableAccessReceipt | null = null;
    // Both stream rows already committed atomically. Verify them together so
    // their adjacent protected advances can share one durable publication; the
    // caller still receives nothing until every stream has passed.
    const verified = await Promise.allSettled(appended.entries.map(async provisional => {
      const candidate: StoredEntry = { sequence: provisional.sequence, hash: provisional.hash, previousHash: provisional.previousHash,
        payload: provisional.payload, contentSha256: provisional.contentSha256, storedAt: provisional.storedAt,
        kind: provisional.stream === 'viewing' ? 'access' : 'history', eventId: appended.eventId, statutoryAct: null };
      // Verification already reads the new row and its DB commit marker. Its exact
      // protected binding supplies the receipt without a duplicate event lookup.
      // Replays (whose new attempt owns no binding) still read the original event.
      let covered: SealState | null = null, sealError: unknown;
      try {
        covered = await this.seal.advanceReceipt(provisional.stream, provisional.attemptId, appended.eventId, candidate);
      } catch (error) { sealError = error; }
      if (covered) {
        if (provisional.stream === 'viewing') receipt = mintDurableReceipt(candidate, covered.streams.viewing);
        return;
      }
      let stored: StoredEntry | null;
      try { stored = await this.sql.entryForEvent(provisional.stream, appended.eventId); } catch {
        this.note(appended.eventId, 'ledger-unavailable', 'commit-unknown', provisional.attemptId, provisional.stream);
        throw new LedgerFailure('CommitUnknown');
      }
      if (!stored) {
        covered = this.seal.committedReceipt(provisional.stream, provisional.attemptId, appended.eventId, candidate);
        if (!covered) throw new LedgerFailure('AppendNotCommitted');
        stored = candidate;
      }
      if (stored.sequence !== provisional.sequence || stored.hash !== provisional.hash || stored.contentSha256 !== provisional.contentSha256) refuse('DurableReceiptRefused');
      let sealed: SealState;
      try {
        if (sealError) throw sealError;
        sealed = covered ?? await this.seal.advance(provisional.stream, { sequence: stored.sequence, hash: stored.hash }); } catch (error) {
        // Committed but not sealed: no receipt. The same event resent, or the next start, seals it; nothing is appended twice.
        this.note(appended.eventId, 'ledger-unavailable', 'seal-unavailable', provisional.attemptId, provisional.stream);
        throw error instanceof SealRefused && error.code !== 'SealUnavailable' ? error : new LedgerFailure('SealUnavailable');
      }
      if (provisional.stream === 'viewing') receipt = mintDurableReceipt(stored, sealed.streams.viewing);
    }));
    for (const result of verified) if (result.status === 'rejected') throw result.reason;
    if (!receipt) refuse('DurableReceiptRefused');
    await Promise.all(appended.entries.map(p => this.seal.acknowledge(p.stream, p.attemptId)));
    return receipt;
  }

  /** One standalone ledger fact (a provision before its body, a refusal, an end without a business change). */
  async append(input: AccessEvent, served?: readonly ResolvedRecord[]): Promise<DurableAccessReceipt> {
    let appended: ProvisionalAppend, callbackFailed = false, transaction: object;
    try {
      appended = await this.withAppendTransaction(async tx => {
        transaction = tx;
        try { return await this.appendInTransaction(tx, input, served); }
        catch (error) { callbackFailed = true; throw error; }
      });
    } catch (error) {
      await this.settleTransaction(transaction, input, error, callbackFailed, served);
      throw error;
    }
    return this.confirm(appended);
  }

  /**
   * A transaction that did not report a commit. No stored entry in any of its streams: the attempt rolled back (journal
   * it, drop its intents). Storage unreadable, or this very content stored after all: the commit is unknown to this
   * response (journal it, keep the intents; the resend of the same event ID or the next start settles it) - never a
   * success, never a new event. Another content stored under this ID: this attempt was refused; the first attempt's
   * intents stay.
   */
  async settle(input: AccessEvent, error: unknown, served?: readonly ResolvedRecord[], rolledBack = false, attempt?: {attemptId: string; streams: readonly AccessStream[]}): Promise<void> {
    const streams = accessStreams(input, served);
    if (rolledBack) {
      const eventId = canonicalPayload(input, served, streams[0]).event.eventId;
      const cause = error instanceof SealRefused ? 'seal-unavailable' : ledgerErrorCode(error) || error instanceof ContractError ? 'ledger-refused' : isConnectionError(error) ? 'ledger-unreachable' : 'business-rollback';
      this.note(eventId, 'append-rolled-back', cause, attempt?.attemptId);
      if (attempt) for (const stream of attempt.streams) this.seal.abort(stream, attempt.attemptId);
      return;
    }
    let eventId = '', unknown = false, other = false;
    for (const stream of streams) {
      const { event, contentSha256 } = canonicalPayload(input, served, stream);
      eventId = event.eventId;
      let stored: StoredEntry | null | undefined;
      try { stored = await this.sql.entryForEvent(stream, eventId); } catch { stored = undefined; }
      if (stored === undefined || (stored && stored.contentSha256 === contentSha256)) unknown = true;
      else if (stored) other = true;
    }
    if (unknown) { this.note(eventId, 'ledger-unavailable', 'commit-unknown', attempt?.attemptId); return; }
    if (other) { this.note(eventId, 'append-rolled-back', 'ledger-refused', attempt?.attemptId); return; }
    // The caller may have lost COMMIT's response. Only startup's global writer fence decides absence.
    this.note(eventId, 'ledger-unavailable', 'commit-unknown', attempt?.attemptId);
  }

  /** A caller that observed its callback reject can settle exactly that transaction's own attempt.
   * A failed/unknown COMMIT response never uses this negative path merely because a SELECT is empty.
   */
  async settleTransaction(tx: object, input: AccessEvent, error: unknown, callbackFailed: boolean, served?: readonly ResolvedRecord[]): Promise<void> {
    const attempt = tx && this.attempts.get(tx);
    await this.settle(input, error, served, callbackFailed, attempt);
    if (tx && callbackFailed) this.attempts.delete(tx);
  }

  private note(eventId: string, kind: 'append-rolled-back' | 'ledger-unavailable', cause: string, attemptId = `unassigned:${eventId}`, stream: AccessStream | 'transaction' = 'transaction'): void {
    try { this.journal.record(`${kind}:${stream}:${attemptId}:${cause}`, kind, { eventId, cause }); }
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
    const orderFacts = new Map<string, readonly Readonly<OrderFact>[]>();
    for (const id of request.recordIds ?? []) holds.set(id, await this.holdRows(tx, string(id)));
    for (const id of request.accessRequestIds ?? []) accessRequests.set(id, await this.requestRows(tx, 'access-request', string(id)));
    for (const id of request.correctionRequestIds ?? []) correctionRequests.set(id, await this.requestRows(tx, 'correction-request', string(id)));
    for (const id of request.clauseIds ?? []) clauseVersions.set(id, await this.clauseRows(tx, string(id)));
    for (const id of request.accessEventIds ?? []) accessEvents.set(id, await this.entryRow(tx, string(id)));
    for (const id of request.orderRecordIds ?? []) orderFacts.set(id, await this.orderFacts(tx, string(id)));
    return snapshotFromRows(scope, { holds, accessRequests, correctionRequests, clauseVersions, accessEvents, orderFacts });
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
  /** The SQL reader takes the per-record transaction lock; replays return the original fact, never a new receipt clock. */
  async recordOrderFact(tx: object, input: OrderFact): Promise<Readonly<OrderFact>> {
    const recordId = string(input.recordId), eventId = string(input.eventId);
    const history = await this.orderFacts(tx, recordId), replay = history.find(f => f.eventId === eventId);
    if (replay) {
      if (JSON.stringify(replay) !== JSON.stringify(input)) refuse('OrderEventIdConflict');
      return replay;
    }
    const fact = parseOrderFact(input, history[history.length - 1]);
    const run = tx as RawQuery;
    await run.$queryRaw`SELECT emr_access.record_order_fact(${recordId}::text, ${eventId}::text,
      ${fact.previousEventId}::text, ${JSON.stringify(fact)}::text)::text AS done`;
    return fact;
  }
  async orderFacts(tx: object, recordId: string): Promise<readonly Readonly<OrderFact>[]> {
    const run = tx as RawQuery;
    const rows = await run.$queryRaw<{ body: string }[]>`SELECT body FROM emr_access.order_facts_for(${string(recordId)}::text)`;
    const result: Readonly<OrderFact>[] = [];
    for (const row of rows) result.push(parseOrderFact(JSON.parse(row.body), result[result.length - 1]));
    return Object.freeze(result);
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
  async appendRow(tx: object, stream: AccessStream, eventId: string, payload: string, act: StatutoryAct, attemptId: string, bundleId: string): Promise<AppendResult> {
    const run = tx as RawQuery;
    const [row] = await run.$queryRaw<any[]>`SELECT chain_id::text AS chain_id, sequence, previous_hash, hash, stored_at, replay
      FROM emr_access.append_reserved(${choice(stream, ACCESS_STREAMS)}::text, ${eventId}::text, ${payload}::text, ${act}::text, ${attemptId}::text, ${bundleId}::text)`;
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
    const rows = await run.$queryRaw<any[]>`SELECT * FROM emr_access.entry_for_event('viewing'::text, ${eventId}::text)`;
    return rows.length ? entry(rows[0]) : null;
  }
}

/**
 * The access-ledger retention job for the viewing stream (its own process and credential, kin_emr_retention; never the API
 * runtime). It reads positions, each entry's own time and holds - no payload - and computes each end now with the one rule
 * (contract.ts accessDeadline); the database re-checks the floor and the holds and appends the non-personal checkpoint in
 * the deleting transaction. The history stream is never expired here (unit H). Scheduling it is not part of this unit.
 */
export async function expireAccessPrefix(retention: PrismaClient, seal: AccessSeal, now = new Date().toISOString()):
  Promise<{ deleted: number; checkpointSequence: number; checkpointHash: string } | null> {
  // Recovery may settle absent intents only before writers start. An active append may still commit.
  const rows: RetentionRow[] = [];
  let after = 0;
  for (;;) {
    const page = await retention.$queryRaw<any[]>`SELECT sequence, hash, kind, occurred_at, held FROM emr_access.retention_view(${after}::bigint, 1000)`;
    for (const row of page) rows.push({ sequence: toNumber(row.sequence), hash: sha256(row.hash), kind: row.kind === 'expiry' ? 'expiry' : 'access',
      occurredAt: toIso(row.occurred_at), held: row.held === true });
    if (page.length < 1000) break;
    after = toNumber(page[page.length - 1].sequence);
  }
  const plan = planExpiryPrefix(rows, now);
  if (!plan) return null;
  const through = plan.through, attemptId = randomUUID(), bundleId = randomUUID();
  // Establish the retained anchor before taking the head lock. Under that lock only
  // commits since this frontier need verification; the deletion plan is checked again by SQL.
  await seal.reconcileCommitted('viewing');
  let callbackFailed = false;
  let result: { deleted: number; checkpointSequence: number; checkpointHash: string };
  try {
    result = await retention.$transaction(async tx => {
      try {
        await tx.$queryRaw`SELECT emr_access.enter_writer()::text`;
        await tx.$queryRaw`SELECT emr_access.lock_chain('viewing'::text)::text`;
        const prefix = await seal.expiryPrefix(through);
        seal.recordIntent('viewing', attemptId, null, null, bundleId);
        const [row] = await tx.$queryRaw<any[]>`SELECT * FROM emr_access.expire_reserved(${through}::bigint, ${attemptId}::text, ${bundleId}::text)`;
        const binding = seal.reserve({ stream: 'viewing', chainId: string(row.chain_id), attemptId, bundleId, kind: 'expiry', eventId: null,
          sequence: toNumber(row.checkpoint_sequence), previousHash: sha256(row.previous_hash), hash: sha256(row.checkpoint_hash),
          contentSha256: sha256(row.content_sha256) }, prefix);
        if (toNumber(row.deleted_count) !== prefix.count) refuse('ExpirySnapshotChanged');
        await tx.$queryRaw`SELECT emr_access.bind_commit('viewing'::text, ${attemptId}::text, ${binding.generation}::bigint, ${binding.proofDigest}::text)::text`;
        return { deleted: toNumber(row.deleted_count), checkpointSequence: toNumber(row.checkpoint_sequence), checkpointHash: sha256(row.checkpoint_hash) };
      } catch (error) { callbackFailed = true; throw error; }
    }, { maxWait: EMR_TX_MAX_WAIT_MS, timeout: EMR_TX_TIMEOUT_MS });
  } catch (error) {
    seal.recordExpiryFailure(attemptId, callbackFailed);
    if (callbackFailed) seal.abort('viewing', attemptId);
    throw error;
  }
  await seal.reconcileCommitted('viewing', { sequence: result.checkpointSequence, hash: result.checkpointHash });
  return result;
}
