import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { AccessEvent, AccessStream, AppendOnlyAccessStore, DurableAccessReceipt, StatutoryAct, statutoryAct } from '../emr-contract/access-event';
import { ResolvedRecord } from '../emr-contract/classification';
import { integer, refuse, string, utc } from '../emr-contract/validation';
import { ClauseRow, HoldRow, RequestRow, StoredEntry, OrderFact, parseOrderFact, canonicalPayload, mintDurableReceipt } from './contract';
import { EmrSnapshot, SnapshotRequest, snapshotFromRows } from './context';
import { FailureJournal } from './failure-journal';
import { RawQuery } from './manifest';
import { admitAppend } from './admission';
import { EMR_TX_MAX_WAIT_MS, EMR_TX_TIMEOUT_MS, EMR_APPEND_POOL_SIZE, boundEmrStatements } from './limits';
import { CommitOutcome, judgeSettled, transactionToken, xactOutcome } from './commit-outcome';

export type LedgerFailureCode = 'CommitUnknown' | 'AppendNotCommitted' | 'LedgerRefused' | 'LedgerUnreachable' | 'ResultExpired';
export class LedgerFailure extends Error {
  constructor(readonly code: LedgerFailureCode) { super(code); }
}
export interface AttemptKeys { operationId: string; attemptId: string }
export interface AdmittedOperation extends AttemptKeys { event: Readonly<AccessEvent>; payload: string; act: StatutoryAct }
export interface BusinessReference { kind: string; id: string; version: string | null }
export interface OperationResult {
  operationId: string; eventId: string; outcome: 'pending' | 'committed' | 'negative'; durableAt: string | null;
  result: BusinessReference | null;
  entries: readonly { entryId: string; stream: AccessStream; attemptId: string; expired: boolean }[];
}
export interface ProvisionalAppend { readonly provisional: true; readonly operationId: string; readonly eventId: string }
/** Session/rights producers decide their facts under existing business locks.
 * Call before the effect; null means a conditional write affected no row. */
export type RecordMutation = (event: AccessEvent, effect: () => Promise<BusinessReference | null>) => Promise<BusinessReference | null>;
const options = { maxWait: EMR_TX_MAX_WAIT_MS, timeout: EMR_TX_TIMEOUT_MS };
const toIso = (v: unknown) => utc(v instanceof Date ? v.toISOString() : String(v));
const toDay = (v: unknown) => v instanceof Date ? v.toISOString().slice(0,10) : String(v).slice(0,10);
function entry(row: any): StoredEntry {
  return { entryId: row.entry_id, sequence: Number(row.sequence), stream: row.stream,
    kind: row.stream === 'history' ? 'history' : 'access', statutoryAct: row.statutory_act,
    eventId: row.event_id, payload: row.payload, storedAt: toIso(row.recorded_at) };
}
export function ledgerErrorCode(error: any): string | null {
  return typeof error?.meta?.code === 'string' ? error.meta.code : null;
}
/** SQL bounds each page. No lifetime key map or historical recovery scan. */
export class PrismaLedgerSql {
  constructor(readonly db: RawQuery) {}
  async entriesAfter(after: number, limit: number): Promise<StoredEntry[]> {
    const rows = await this.db.$queryRaw<any[]>`SELECT * FROM emr_access.entries_after(${integer(after)}::bigint, ${integer(limit,1)}::integer)`;
    return rows.map(entry);
  }
  async entryForEvent(stream: AccessStream, eventId: string): Promise<StoredEntry | null> {
    const rows = await this.db.$queryRaw<any[]>`SELECT * FROM emr_access.entry_for_event(${stream}::text, ${eventId}::text)`;
    return rows.length ? entry(rows[0]) : null;
  }
  async accessSeen(issuer: string, subject: string, studyUid: string, since: Date, session: string | null): Promise<boolean> {
    const [row] = await this.db.$queryRaw<{ present: boolean }[]>`
      SELECT emr_access.access_seen(${issuer}::text, ${subject}::text, ${studyUid}::text,
        ${since}::timestamptz, ${session}::text) AS present`;
    return row.present;
  }
  async result(operationId: string): Promise<OperationResult | null> {
    const [row] = await this.db.$queryRaw<{ value: OperationResult | null }[]>`SELECT emr_access.operation_result(${operationId}::uuid) AS value`;
    return row.value;
  }
}
/** Admission commits first. Business SQL, both streams and terminal result then
 * commit on one connection under the lock also used by settlement. */
export class AccessLedgerStore implements AppendOnlyAccessStore {
  readonly sql: PrismaLedgerSql;
  private readonly admitted = new WeakSet<object>();
  private readonly transactions = new WeakMap<object, AdmittedOperation>();
  /** Member ids this process resolved from the database, by issuer and subject (see resolveRequestIdentity). */
  private readonly identities = new Map<string, string>();
  constructor(private readonly db: PrismaClient, readonly journal: FailureJournal,
    private readonly poolSize = (db as PrismaClient & { emrAppendPoolSize?: number }).emrAppendPoolSize ?? EMR_APPEND_POOL_SIZE) {
    this.sql = new PrismaLedgerSql(db);
  }
  async admit(input: AccessEvent, served?: readonly ResolvedRecord[], keys?: AttemptKeys): Promise<AdmittedOperation> {
    return admitAppend(this.db, this.poolSize, () => this.admitSql(input, served, keys));
  }
  private async admitSql(input: AccessEvent, served?: readonly ResolvedRecord[], keys?: AttemptKeys): Promise<AdmittedOperation> {
    const canonical = canonicalPayload(input, served);
    const selected = keys ?? { operationId: randomUUID(), attemptId: randomUUID() };
    const act = statutoryAct(canonical.event, served);
    try {
      const [row] = await this.db.$queryRaw<{ id: string }[]>`
        SELECT emr_access.admit_operation(${selected.operationId}::uuid, ${selected.attemptId}::uuid,
          ${canonical.text}::text, ${act}::text)::text AS id`;
      const operation = Object.freeze({ ...selected, operationId: row.id, event: canonical.event, payload: canonical.text, act });
      this.admitted.add(operation);
      return operation;
    } catch (error) {
      await this.journal.record(ledgerErrorCode(error)?.startsWith('EB') ? 'ledger-refused' : 'ledger-unreachable', canonical.event.eventId, null);
      throw error;
    }
  }
  /** One ordinary producer transaction, including multiple session endings.
   * Admission uses a short separate connection before each effect. The outer
   * transaction already owns an append lane: taking a second lane here could
   * deadlock a saturated pool. Its two connection reserve services admission
   * and settlement. No callback is retried after a lost COMMIT response.
   * failureEvent: an already recorded event whose facts this transaction writes. A failure that no operation of this
   * transaction accounts for (admission capacity, no connection, the callback's own SQL, a lost COMMIT) is journaled
   * against that event, as an operation's failure is against its own: the event's record then shows that facts it
   * names were not written, even if the process ends before a retry (R244-GPT-02). */
  async transactionWithRecords<T>(work: (tx: Prisma.TransactionClient, record: RecordMutation) => Promise<T>,
    transactionOptions = options, failureEvent?: string): Promise<T> {
    const operations: AdmittedOperation[] = [];
    const run = await this.execute(async tx => {
      await boundEmrStatements(tx);
      const record: RecordMutation = async (event, effect) => {
        const operation = await this.admitSql(event);
        operations.push(operation);
        const [locked] = await tx.$queryRaw<{ value: string }[]>`SELECT emr_access.lock_operation(${operation.operationId}::uuid) AS value`;
        if (locked.value !== 'pending') {
          const previous = await new PrismaLedgerSql(tx).result(operation.operationId);
          if (previous?.outcome !== 'committed') throw new LedgerFailure('AppendNotCommitted');
          if (previous.entries.some(row => row.expired)) throw new LedgerFailure('ResultExpired');
          return previous.result;
        }
        const reference = await effect();
        if (reference === null) {
          await tx.$queryRaw`SELECT emr_access.settle_operation(${operation.operationId}::uuid)`;
          return null;
        }
        this.transactions.set(tx, operation);
        try {
          await this.appendInTransaction(tx, operation, reference);
          if (reference.kind === 'AuditLog') await this.recordProjection(tx, event.eventId, integer(Number(reference.id), 1));
        } finally { this.transactions.delete(tx); }
        return reference;
      };
      return work(tx, record);
    }, transactionOptions, true);
    if (run.outcome === 'committed') return run.value as T;
    // Settlement runs on its own judged transaction; what it answers never decides this transaction's outcome.
    const cause = run.outcome === 'unknown' ? 'commit-unknown' : 'business-rollback';
    for (const operation of operations) {
      await this.journal.record(cause, operation.event.eventId, operation.operationId);
      await this.settle(operation.operationId);
    }
    if (failureEvent !== undefined && !operations.length)
      await this.journal.record(run.phase !== 'before' ? cause :
        (run.error as Error | null)?.message === 'EmrAdmissionCapacity' ? 'capacity' : 'ledger-unreachable', string(failureEvent), null);
    if (run.phase !== 'returned') throw run.error;
    throw new LedgerFailure(run.outcome === 'not-committed' ? 'AppendNotCommitted' : 'CommitUnknown');
  }
  /** Recheck current authorization inside callback. Return only the stored
   * result reference: exact retries read that version, never rerun mutation. */
  async transaction(operation: AdmittedOperation, work: (tx: Prisma.TransactionClient) => Promise<BusinessReference | null>): Promise<OperationResult> {
    if (!this.admitted.has(operation)) refuse('AdmittedOperationRequired');
    const run = await this.execute(async tx => {
      await boundEmrStatements(tx);
      const [state] = await tx.$queryRaw<{ value: string }[]>`SELECT emr_access.lock_operation(${operation.operationId}::uuid) AS value`;
      if (state.value !== 'pending') return new PrismaLedgerSql(tx).result(operation.operationId);
      this.transactions.set(tx, operation);
      try {
        const reference = await work(tx);
        await this.appendInTransaction(tx, operation, reference);
        if (reference?.kind === 'AuditLog')
          await this.recordProjection(tx, operation.event.eventId, integer(Number(reference.id), 1));
        return await new PrismaLedgerSql(tx).result(operation.operationId);
      } finally { this.transactions.delete(tx); }
    }, options, true);
    if (run.outcome === 'committed' && run.value) return run.value;
    const callbackFailed = run.phase === 'callback';
    await this.journal.record(callbackFailed || run.outcome === 'not-committed' ? 'business-rollback' : 'commit-unknown',
      operation.event.eventId, operation.operationId);
    // A stored committed result answers an exact retry whatever this attempt did; settle reports it only once its own
    // transaction is judged committed, so its negative is a settled fact, never this attempt's rollback assumed.
    const settled = await this.settle(operation.operationId);
    if (settled?.outcome === 'committed') return settled;
    if (callbackFailed) throw run.error;
    if (run.outcome === 'unknown') throw new LedgerFailure('CommitUnknown');
    if (settled?.outcome === 'negative') throw new LedgerFailure('AppendNotCommitted');
    throw new LedgerFailure('CommitUnknown');
  }
  /**
   * The one way B2 runs a transaction (transactionWithRecords, transaction, settle, identity). The callback's value is
   * this transaction's answer only once PostgreSQL's commit log says its own top-level XID committed: Prisma has resolved
   * a COMMIT that a deferred trigger failed, so neither the promise nor a row read inside the transaction is evidence.
   * The XID is taken as the callback's last statement - after any SET TRANSACTION it opened with - so every transaction,
   * read-only ones included, has one. Its status is read after the transaction settled and after its append lane was
   * released, in a new transaction (judgeSettled): never on the business connection while it holds locks.
   *  - phase 'before'/'callback': no COMMIT was asked for; the error is the original one and nothing is judged;
   *  - phase 'returned': committed, not-committed (aborted) or unknown (in progress, NULL, no token, no answer).
   */
  private async execute<T>(work: (tx: Prisma.TransactionClient) => Promise<T>, transactionOptions: typeof options,
    laned: boolean): Promise<{ phase: 'before' | 'callback' | 'returned'; outcome: CommitOutcome | null; value?: T; error?: unknown }> {
    const run: { phase: 'before' | 'callback' | 'returned'; token: string | null; value?: T; error?: unknown } =
      { phase: 'before', token: null };
    const transaction = () => this.db.$transaction(async tx => {
      run.phase = 'callback';
      run.value = await work(tx);
      run.phase = 'returned';
      run.token = await transactionToken(tx);
      return run.value;
    }, transactionOptions);
    try { await (laned ? admitAppend(this.db, this.poolSize, transaction) : transaction()); }
    catch (caught) { run.error = caught; }
    if (run.phase !== 'returned') return { phase: run.phase, outcome: null, error: run.error };
    const outcome = run.token === null ? 'unknown' : await judgeSettled(this.db, xactOutcome(run.token));
    return { phase: run.phase, outcome, value: run.value, error: run.error };
  }
  async appendInTransaction(tx: Prisma.TransactionClient, operation: AdmittedOperation,
    reference: BusinessReference | null = null): Promise<ProvisionalAppend> {
    if (this.transactions.get(tx) !== operation) refuse('EmrRecordTransactionRefused');
    await tx.$queryRaw`SELECT emr_access.append_operation(${operation.operationId}::uuid, ${operation.attemptId}::uuid,
      ${operation.payload}::text, ${operation.act}::text, ${reference?.kind ?? null}::text,
      ${reference?.id ?? null}::text, ${reference?.version ?? null}::text)`;
    return Object.freeze({ provisional: true, operationId: operation.operationId, eventId: operation.event.eventId });
  }
  async confirm(appended: ProvisionalAppend): Promise<DurableAccessReceipt> {
    const result = await this.lookup(appended.operationId);
    if (!result || result.eventId !== appended.eventId) throw new LedgerFailure('CommitUnknown');
    return this.receipt(result);
  }
  receipt(result: OperationResult): DurableAccessReceipt {
    if (result.outcome !== 'committed' || !result.durableAt) throw new LedgerFailure('AppendNotCommitted');
    if (result.entries.some(e => e.expired)) throw new LedgerFailure('ResultExpired');
    return mintDurableReceipt(result.eventId, new Date(result.durableAt).toISOString());
  }
  async append(input: AccessEvent, served?: readonly ResolvedRecord[], keys?: AttemptKeys): Promise<DurableAccessReceipt> {
    const operation = await this.admit(input, served, keys);
    return this.receipt(await this.transaction(operation, async () => null));
  }
  async lookup(operationId: string): Promise<OperationResult | null> {
    return this.db.$transaction(async tx => {
      await boundEmrStatements(tx);
      const sql = new PrismaLedgerSql(tx);
      // A caller can persist its request before B2 admission commits. Absence
      // is unresolved, as the public port promises; it is not a negative result.
      if (!await sql.result(operationId)) return null;
      await tx.$queryRaw`SELECT emr_access.lock_operation(${operationId}::uuid)`;
      return sql.result(operationId);
    }, options);
  }
  /** The operation's settled result, only from a settlement whose own transaction committed: otherwise UNKNOWN (null),
   * including a lock timeout - never a timed negative, and never a negative that rolled back with its transaction. */
  async settle(operationId: string): Promise<OperationResult | null> {
    const run = await this.execute(async tx => {
      await boundEmrStatements(tx);
      const [row] = await tx.$queryRaw<{ value: OperationResult }[]>`SELECT emr_access.settle_operation(${operationId}::uuid) AS value`;
      return row.value;
    }, options, false);
    return run.outcome === 'committed' ? run.value ?? null : null;
  }
  async recoverPending(): Promise<void> {
    const rows = await this.db.$queryRaw<{ operation_id: string }[]>`SELECT operation_id::text FROM emr_access.pending_operations(128)`;
    for (const row of rows) if (!(await this.settle(row.operation_id))) throw new LedgerFailure('CommitUnknown');
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
        !isDeepStrictEqual(JSON.parse(placed.body), { ...released, release: null })) refuse('HoldReleaseBindingRefused');
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
  /** Bootstrap the verified actor before its first event, with the same bounded
   * admission and transaction options as the request's remaining work.
   * The binding (issuer, subject) -> member id is created once and never changed (resolve_member_identity inserts
   * or keeps; names are never a key), so an id this process already obtained from the database stays that member's
   * id for as long as the database does. A request of an established member therefore takes no append lane here:
   * under a viewer's burst of frames this admission queued 222 ms median per request behind the lanes
   * (R244-02 profile, run e-route-diag-fable-20261027a). A database restored to an older copy requires a restart.
   * The map has no bound of its own: it holds a subset of the database's own identity bindings, which are kept for the
   * database's lifetime, one per verified account or service subject that has acted here (R244-GPT-08). */
  async resolveRequestIdentity(issuer: string, subject: string): Promise<string> {
    const key = JSON.stringify([string(issuer), string(subject)]);
    const established = this.identities.get(key);
    if (established) return established;
    // Cached only once its binding committed: an id from a transaction that rolled back names no member.
    const run = await this.execute(tx => this.resolveIdentity(tx, issuer, subject), options, true);
    if (run.phase !== 'returned') throw run.error;
    if (run.outcome !== 'committed') throw new LedgerFailure(run.outcome === 'not-committed' ? 'AppendNotCommitted' : 'CommitUnknown');
    const id = run.value as string;
    this.identities.set(key, id);
    return id;
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
