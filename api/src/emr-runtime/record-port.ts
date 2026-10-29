import type { Prisma } from '@prisma/client';
import type { AccessEvent, DurableAccessReceipt } from '../emr-contract/access-event';
import type { ResolvedRecord } from '../emr-contract/classification';
import { refuse } from '../emr-contract/validation';
import type { EmrSnapshot, SnapshotRequest } from './context';
import { EMR_PENDING_LIMIT } from './limits';
import type { AccessLedgerStore, AdmittedOperation, AttemptKeys, BusinessReference, OperationResult, ProvisionalAppend, RecordMutation } from './store';

export const EMR_RECORD_PORT = Symbol('EmrRecordPort');
export type EmrRecordTransaction = Prisma.TransactionClient;
export interface EmrRecordWork {
  admit(event: AccessEvent, served?: readonly ResolvedRecord[], keys?: AttemptKeys): Promise<AdmittedOperation>;
  transaction(operation: AdmittedOperation, work: (tx: EmrRecordTransaction) => Promise<BusinessReference | null>): Promise<OperationResult>;
  transactionWithRecords<T>(work: (tx: EmrRecordTransaction, record: RecordMutation) => Promise<T>,
    options?: { maxWait: number; timeout: number }, failureEvent?: string): Promise<T>;
  append(event: AccessEvent, served?: readonly ResolvedRecord[], keys?: AttemptKeys): Promise<DurableAccessReceipt>;
  confirm(appended: ProvisionalAppend): Promise<DurableAccessReceipt>;
  lookup(operationId: string): Promise<OperationResult | null>;
  snapshot(tx: EmrRecordTransaction, scope: object, request: SnapshotRequest): Promise<EmrSnapshot>;
  resolveIdentity(tx: EmrRecordTransaction, issuer: string, subject: string): Promise<string>;
  resolveRequestIdentity(issuer: string, subject: string): Promise<string>;
  end(): void;
}
export interface EmrRecordPort { begin(): EmrRecordWork }
export interface EmrRecordPortControl { close(): void; live(): number; drained(): Promise<void> }

/** In-process request ownership only. Closing admission does not cancel a
 * committed fact; ending a request prevents its later body publication. */
export function createRecordPort(store: AccessLedgerStore): { port: EmrRecordPort; control: EmrRecordPortControl } {
  let closed = false, live = 0;
  const waiting: (() => void)[] = [];
  const port: EmrRecordPort = {
    begin() {
      if (closed) refuse('EmrRecordPortClosed');
      if (live >= EMR_PENDING_LIMIT) refuse('EmrAdmissionCapacity');
      live++;
      let ended = false, leases = 0, retired = false;
      const retire = () => {
        if (!ended || leases || retired) return;
        retired = true;
        if (--live === 0) for (const wake of waiting.splice(0)) wake();
      };
      const run = async <T>(task: () => Promise<T>): Promise<T> => {
        if (ended) refuse('EmrRecordWorkEnded');
        leases++;
        try {
          const value = await task();
          if (ended) refuse('EmrRecordWorkEnded');
          return value;
        } finally { leases--; retire(); }
      };
      return {
        admit: (event, served, keys) => run(() => store.admit(event, served, keys)),
        transaction: (operation, work) => run(() => store.transaction(operation, work)),
        transactionWithRecords: (work, options, failureEvent) => run(() => store.transactionWithRecords(work, options, failureEvent)),
        append: (event, served, keys) => run(() => store.append(event, served, keys)),
        confirm: appended => run(() => store.confirm(appended)),
        lookup: id => run(() => store.lookup(id)),
        snapshot: (tx, scope, request) => run(() => store.snapshot(tx, scope, request)),
        resolveIdentity: (tx, issuer, subject) => run(() => store.resolveIdentity(tx, issuer, subject)),
        resolveRequestIdentity: (issuer, subject) => run(() => store.resolveRequestIdentity(issuer, subject)),
        end() { ended = true; retire(); },
      };
    },
  };
  return { port, control: {
    close() { closed = true; }, live: () => live,
    drained: () => live === 0 ? Promise.resolve() : new Promise(resolve => waiting.push(resolve)),
  } };
}
