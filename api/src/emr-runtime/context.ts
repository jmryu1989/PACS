import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { parseAccessEvent } from '../emr-contract/access-event';
import type { EmrAdapters } from '../emr-contract/composition';
import { freeze, refuse, string } from '../emr-contract/validation';
import { ClauseRow, HoldRow, RequestRow, StoredEntry, OrderFact, parseOrderFact } from './contract';

/**
 * A's readers are synchronous; storage is not. Under the caller's transaction lock B reads every fact an A decision may
 * consult into one immutable snapshot, then runs that decision with the snapshot as its execution context (native
 * AsyncLocalStorage). The readers composed once at server start answer only from the current context: no context, an ID
 * the snapshot did not read, or a snapshot of another transaction is refused - never answered with an empty set or a
 * current-time reconstruction. There is no process-global "current user/transaction" and no per-request composition.
 * Facts B does not store (C's reports and signatures, F's requests to unseal) are explicitly unsupported here.
 */
export interface SnapshotRequest {
  recordIds?: readonly string[]; accessRequestIds?: readonly string[]; correctionRequestIds?: readonly string[];
  clauseIds?: readonly string[]; accessEventIds?: readonly string[]; orderRecordIds?: readonly string[];
}
export interface EmrSnapshot {
  readonly holdListings: ReadonlyMap<string, readonly string[]>;
  readonly holds: ReadonlyMap<string, unknown>;
  readonly accessRequests: ReadonlyMap<string, unknown | null>;
  readonly correctionRequests: ReadonlyMap<string, unknown | null>;
  readonly clauseVersions: ReadonlyMap<string, readonly unknown[]>;
  readonly accessEvents: ReadonlyMap<string, unknown>;
  readonly orderFacts: ReadonlyMap<string, readonly Readonly<OrderFact>[]>;
}
interface Frame { scope: object; snapshot: EmrSnapshot }
const context = new AsyncLocalStorage<Frame>();
const owners = new WeakMap<object, object>();

function json(text: string): unknown { return JSON.parse(text); }
/** A hold's current fact: the release record when one exists (it carries the same basis), else the placement. */
function holdFacts(rows: readonly HoldRow[]): { listing: string[]; facts: Map<string, unknown> } {
  const facts = new Map<string, unknown>();
  for (const row of rows) if (row.phase === 'placed' && !facts.has(row.holdId)) facts.set(row.holdId, json(row.body));
  for (const row of rows) if (row.phase === 'released') {
    if (!facts.has(row.holdId)) refuse('HoldSetIncomplete');
    facts.set(row.holdId, json(row.body));
  }
  return { listing: [...facts.keys()].sort(), facts };
}
function requestFacts(rows: readonly RequestRow[]): unknown | null {
  const resolved = rows.find(r => r.phase === 'resolved'), received = rows.find(r => r.phase === 'received');
  if (resolved && !received) refuse('RequestHistoryIncomplete');
  return resolved ? json(resolved.body) : received ? json(received.body) : null;
}
const clause = (row: ClauseRow) => ({ law: row.law, article: row.article, publication: row.publication, publishedAt: row.publishedAt, effectiveAt: row.effectiveAt });

/** One transaction's identity for its snapshots; created inside that transaction, never shared with another. */
export function transactionScope(): object { return Object.freeze(Object.create(null)); }

/** What the storage adapter read under one transaction for one decision (every requested ID present). */
export interface SnapshotRows {
  holds: ReadonlyMap<string, readonly HoldRow[]>;
  accessRequests: ReadonlyMap<string, readonly RequestRow[]>;
  correctionRequests: ReadonlyMap<string, readonly RequestRow[]>;
  clauseVersions: ReadonlyMap<string, readonly ClauseRow[]>;
  accessEvents: ReadonlyMap<string, StoredEntry | null>;
  orderFacts?: ReadonlyMap<string, readonly Readonly<OrderFact>[]>;
}
/** The immutable snapshot of those rows, bound to the transaction scope they were read in. */
export function snapshotFromRows(scope: object, rows: SnapshotRows): EmrSnapshot {
  const holdListings = new Map<string, readonly string[]>(), holds = new Map<string, unknown>();
  for (const [recordId, found] of rows.holds) {
    const { listing, facts } = holdFacts(found);
    holdListings.set(string(recordId), freeze(listing));
    for (const [id, fact] of facts) holds.set(id, freeze(fact));
  }
  const accessRequests = new Map<string, unknown | null>(), correctionRequests = new Map<string, unknown | null>();
  for (const [id, found] of rows.accessRequests) accessRequests.set(string(id), freeze(requestFacts(found)));
  for (const [id, found] of rows.correctionRequests) correctionRequests.set(string(id), freeze(requestFacts(found)));
  const clauseVersions = new Map<string, readonly unknown[]>();
  for (const [id, found] of rows.clauseVersions) clauseVersions.set(string(id), freeze(found.map(clause)));
  const accessEvents = new Map<string, unknown>();
  for (const [id, entry] of rows.accessEvents) {
    if (!entry || entry.kind !== 'access' || entry.eventId !== id) refuse('AccessRecordRequired');
    accessEvents.set(id, freeze((json(entry.payload) as any).event));
  }
  const orderFacts = new Map<string, readonly Readonly<OrderFact>[]>();
  for (const [id, history] of rows.orderFacts ?? []) {
    const parsed: Readonly<OrderFact>[] = [];
    for (const fact of history) {
      if (fact.recordId !== id) refuse('OrderEventBindingRefused');
      parsed.push(parseOrderFact(fact, parsed[parsed.length - 1]));
    }
    orderFacts.set(id, freeze(parsed));
  }
  const snapshot: EmrSnapshot = Object.freeze({ holdListings, holds, accessRequests, correctionRequests, clauseVersions, accessEvents, orderFacts });
  owners.set(snapshot, scope);
  return snapshot;
}

/** Run a synchronous A decision with this transaction's snapshot as its only reader input. */
export function withSnapshot<T>(scope: object, snapshot: EmrSnapshot, work: () => T): T {
  if (owners.get(snapshot) !== scope) refuse('EmrContextTransactionMismatch');
  const active = context.getStore();
  if (active && active.scope !== scope) refuse('EmrContextTransactionMismatch');
  return context.run(Object.freeze({ scope, snapshot }), work);
}
function snapshot(): EmrSnapshot {
  const frame = context.getStore();
  if (!frame) refuse('EmrContextRequired');
  return frame.snapshot;
}
function read<T>(map: ReadonlyMap<string, T>, id: string): T {
  if (!map.has(id)) refuse('EmrContextRecordMissing');
  return map.get(id) as T;
}

/**
 * The storage adapters B hands to composeEmrAdapters exactly once at server start (unit B2 makes that call in main.ts).
 * Stored records: the ledger's access events (same facts as A's fixed access mapping); anything else is not B's storage.
 */
export const runtimeAdapters: EmrAdapters = Object.freeze({
  stored: Object.freeze({
    load(recordId: string, eventId: string) {
      const orders = snapshot().orderFacts;
      if (orders.has(recordId)) {
        const fact = [...read(orders, recordId)].reverse().find(f => f.event.eventId === eventId);
        if (!fact) refuse('EmrContextRecordMissing');
        return { recordId, model: 'emr_access.order_fact', row: fact.facts, event: fact.event };
      }
      if (recordId !== eventId) refuse('EmrRecordUnsupported');
      const event = parseAccessEvent(read(snapshot().accessEvents, eventId));
      const digest = createHash('sha256').update(JSON.stringify(event)).digest('hex');
      return { recordId, model: 'emr_access.access_entry', row: {}, event: {
        eventId, recordId, versionId: eventId, sha256: digest, contentSha256: digest, at: event.occurredAt,
        act: 'access', signature: null, predecessor: null, components: [], processing: null } };
    },
  }),
  legal: Object.freeze({
    load(holdId: string) { return read(snapshot().holds, holdId); },
    listHolds(recordId: string) { return { recordId, holdIds: [...read(snapshot().holdListings, recordId)], complete: true }; },
    loadAccessRequest(requestId: string) { return read(snapshot().accessRequests, requestId); },
    loadCorrectionRequest(requestId: string) { return read(snapshot().correctionRequests, requestId); },
    loadClauseVersions(clauseId: string) { return read(snapshot().clauseVersions, clauseId) as any; },
  }),
  purpose: Object.freeze({
    load(): unknown { return refuse('EmrRecordUnsupported'); },
    loadSignedResult(): unknown { return refuse('EmrRecordUnsupported'); },
    loadIntentEndingFact(): unknown { return refuse('EmrRecordUnsupported'); },
  }),
  clinical: Object.freeze({
    loadStudy(): unknown { return refuse('EmrRecordUnsupported'); },
    loadReportPatient(): unknown { return refuse('EmrRecordUnsupported'); },
  }),
});
