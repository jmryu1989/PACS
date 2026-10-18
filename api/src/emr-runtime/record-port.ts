import type { Prisma } from '@prisma/client';
import type { AccessEvent, DurableAccessReceipt } from '../emr-contract/access-event';
import type { ResolvedRecord } from '../emr-contract/classification';
import { refuse } from '../emr-contract/validation';
import type { EmrSnapshot, SnapshotRequest } from './context';
import type { AccessLedgerStore, ProvisionalAppend } from './store';

/**
 * EMR-B2 (d): what a Nest consumer receives of the access ledger - a record port, provided by value under this token
 * from the launcher (AppModule.forLaunch), never a class provider. It carries the operations a consumer records with
 * (a standalone fact, a business transaction with its fact appended inside it, the confirmation or settlement after it,
 * the snapshot an A decision reads under that transaction, the one identity resolution) over the one started
 * AccessLedgerStore and its dedicated client. It carries nothing of the lifetime: no store, client, seal, journal or
 * coordinator, no start, close, recovery or composition - a consumer that is handed the port cannot reach them by a
 * typed member, and the runtime object has no such property either.
 */
export const EMR_RECORD_PORT: unique symbol = Symbol('EmrRecordPort');

/** The business transaction of one record: the dedicated ledger client's interactive transaction, entered through the
 * store's append admission. Business rows and the ledger fact commit together in it; it cannot connect, disconnect or
 * open another transaction. */
export type EmrRecordTransaction = Prisma.TransactionClient;

/**
 * One admitted unit of recording work, a request's recording lifetime as a rule: begun while the process serves, ended
 * by its holder once its last record is written - also a record that a response's finish starts. The launcher's stop
 * refuses new work at once and waits for the begun work to end before the ledger is released (bounded). After `end()`
 * every operation is refused: a work object kept past its end is no way back in.
 */
export interface EmrRecordWork {
  /** One standalone fact (a provision before its body, a refusal, an end without a business change): a durable receipt. */
  append(input: AccessEvent, served?: readonly ResolvedRecord[]): Promise<DurableAccessReceipt>;
  /** The caller's business change and `appendInTransaction` last, in one admitted transaction of the dedicated client. */
  transaction<T>(work: (tx: EmrRecordTransaction) => Promise<T>): Promise<T>;
  appendInTransaction(tx: EmrRecordTransaction, input: AccessEvent, served?: readonly ResolvedRecord[]): Promise<ProvisionalAppend>;
  /** After the transaction committed: the entries proven from storage and sealed, then the receipt. */
  confirm(appended: ProvisionalAppend): Promise<DurableAccessReceipt>;
  /** After the transaction's callback threw or its commit was not reported: its own attempt settled, never a success. */
  settleTransaction(tx: EmrRecordTransaction, input: AccessEvent, error: unknown, callbackFailed: boolean, served?: readonly ResolvedRecord[]): Promise<void>;
  /** A fact whose commit is unknown to this response (no transaction object to settle by): journaled, never a success. */
  settle(input: AccessEvent, error: unknown, served?: readonly ResolvedRecord[]): Promise<void>;
  /** Every fact one A decision may consult, read under the caller's transaction as that transaction's snapshot. */
  snapshot(tx: EmrRecordTransaction, scope: object, request: SnapshotRequest): Promise<EmrSnapshot>;
  /** The immutable member ID of a verified issuer and subject (the request facts of the next unit resolve it here). */
  resolveIdentity(tx: EmrRecordTransaction, issuer: string, subject: string): Promise<string>;
  /** The end of this work; idempotent. */
  end(): void;
}

export interface EmrRecordPort {
  /** Admits one unit of recording work; refused (`EmrRecordPortClosed`) once the process began to stop. */
  begin(): EmrRecordWork;
}

/** The launcher's side of the port: it closes admission when the stop latch trips and waits for the begun work. */
export interface EmrRecordPortControl {
  close(): void;
  live(): number;
  /** Resolves once no begun work is live (at once when none is); never rejects. */
  drained(): Promise<void>;
}

/**
 * The port over the one started store. Each operation of a work object calls that store directly: the same underlying
 * store, client, admission and seal as B1's own `append`, with no copy of state in between. The objects are frozen and
 * have no prototype, so a consumer finds exactly the listed members and nothing else.
 */
export function createRecordPort(store: AccessLedgerStore): { port: EmrRecordPort; control: EmrRecordPortControl } {
  let closed = false, live = 0;
  const waiting: (() => void)[] = [];
  const settle = () => { if (live === 0) for (const wake of waiting.splice(0)) wake(); };
  const port: EmrRecordPort = Object.freeze(Object.assign(Object.create(null), {
    begin(): EmrRecordWork {
      if (closed) refuse('EmrRecordPortClosed');
      let ended = false;
      live++;
      const alive = () => { if (ended) refuse('EmrRecordWorkEnded'); };
      const work: EmrRecordWork = {
        append(input, served) { alive(); return store.append(input, served); },
        transaction(work) { alive(); return store.withAppendTransaction(work); },
        appendInTransaction(tx, input, served) { alive(); return store.appendInTransaction(tx, input, served); },
        confirm(appended) { alive(); return store.confirm(appended); },
        settleTransaction(tx, input, error, callbackFailed, served) { alive(); return store.settleTransaction(tx, input, error, callbackFailed, served); },
        settle(input, error, served) { alive(); return store.settle(input, error, served); },
        snapshot(tx, scope, request) { alive(); return store.snapshot(tx, scope, request); },
        resolveIdentity(tx, issuer, subject) { alive(); return store.resolveIdentity(tx, issuer, subject); },
        end() {
          if (ended) return;
          ended = true;
          live--;
          settle();
        },
      };
      return Object.freeze(Object.assign(Object.create(null), work));
    },
  }));
  const control: EmrRecordPortControl = Object.freeze({
    close(): void { closed = true; },
    live(): number { return live; },
    drained(): Promise<void> { return live === 0 ? Promise.resolve() : new Promise(resolve => waiting.push(resolve)); },
  });
  return { port, control };
}
