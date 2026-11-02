import {
  BatchDisposalAuditStore, DestructionReceipt, DestructionRecord, DisposalRequest, RetentionGraph, RetentionRecord, destroyBatchAtExpiry,
} from '../emr-contract/lawful-defaults';
import type { RawQuery } from '../emr-runtime/manifest';

/** D1794: the existing SQL boundary performs partial database erasure and keeps
 * unknown record histories. It does not certify destruction of backup copies.
 */
export interface LedgerExpiryResult {
  ran: true;
  checkedAt: string;
  deletedEntries: number;
  deletedFailures: number;
  retainedByDutyOrHold: number;
  historyRetainedUnknownLifetime: number;
  complete: true;
}

export async function sweepLedgerExpiry(db: RawQuery): Promise<LedgerExpiryResult> {
  const roles = await db.$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
  if (roles.length !== 1 || roles[0].role !== 'kin_emr_retention') {
    throw new Error('RetentionCredentialRequired');
  }
  // An empty ending map explicitly means "no verified record lifetime supplied",
  // not "no retained records". SQL reports and preserves those histories.
  const rows = await db.$queryRaw<{ result: LedgerExpiryResult }[]>`
    SELECT emr_access.restore_expiry_sweep('{}'::jsonb) AS result`;
  const result = rows.length === 1 ? rows[0].result : null;
  if (!result || result.ran !== true || result.complete !== true ||
      typeof result.checkedAt !== 'string' || !Number.isFinite(Date.parse(result.checkedAt)) ||
      ['deletedEntries', 'deletedFailures', 'retainedByDutyOrHold', 'historyRetainedUnknownLifetime']
        .some(key => !Number.isSafeInteger(result[key]) || result[key] < 0)) {
    throw new Error('RetentionSweepReceiptInvalid');
  }
  return result;
}

/** One source unit as H read it. `due` carries the A record; nothing else is ever handed to a destruction call. */
export interface InventoryUnit {
  recordId: string; disposalUnitId: string;
  status: 'due' | 'retained' | 'held' | 'unsupported'; reason: string | null;
  record: Readonly<RetentionRecord> | null;
}
/** Private drafts end in place: the product's own writers clear the content and keep the revision marker (present=false). */
export interface DraftCheck { live: number; cleared: number; inconsistent: number }
export interface ReconcileResult { resumed: number; abandoned: number; unfinished: number; failures: readonly string[] }
export interface HPorts {
  sweepLedger(): Promise<LedgerExpiryResult>;
  /** Storage time; every journal receipt is compared with it, so the run never uses a host clock ahead of the DB. */
  clock(): Promise<string>;
  reconcile(): Promise<ReconcileResult>;
  inventory(at: string): Promise<{ units: readonly InventoryUnit[]; uncovered: readonly string[]; drafts: DraftCheck }>;
  graphFor(recordIds: readonly string[], at: string): Promise<RetentionGraph>;
  store: BatchDisposalAuditStore;
  destroySet(requests: readonly Readonly<DisposalRequest>[]): Promise<DestructionReceipt>;
  /** Phases this composition does not connect (e.g. images until CD-09b). Any entry keeps the run incomplete. */
  openPhases: readonly string[];
}
export interface RetentionRun {
  status: 'complete' | 'incomplete' | 'failed';
  at: string | null;
  ledger: LedgerExpiryResult;
  reconcile: ReconcileResult;
  statutory: { due: number; destroyed: number; retained: number; held: number; unsupported: Readonly<Record<string, number>>;
    overdue: number; delayReasonMissing: number };
  purpose: DraftCheck | null;
  uncovered: readonly string[];
  open: readonly string[];
  failure: string | null;
}
/** Closed refusal names only (A's codes and the SQL step's own exceptions). A database error text can carry connection
 * details or row values, so anything else is reported as unclassified; the raw logs stay the diagnosis source. */
export function refusalCode(error: unknown): string {
  const own = (error as { code?: unknown })?.code;
  if (typeof own === 'string' && /^[A-Z][A-Za-z]+$/.test(own)) return own;
  const named = /\b((?:Retention|Destruction|Operational|LegalDuty|CompletePrimaryKey|Erasure|Reference|Disposal|Started)[A-Za-z]+)\b/;
  return String((error as Error)?.message ?? '').match(named)?.[1] ?? 'unclassified';
}
const code = refusalCode;

/**
 * One daily run, in the order the order fixes: ledger expiry, reconciliation of interrupted executions (a failed one
 * stops the run: no later set may start before it completes), then statutory destruction of every due unit through A's
 * batch contract (SCC order, one execution per set, the first failed set stops the rest), then the purpose check. The
 * result names counts, reasons and table names only; it is complete only when nothing was unsupported, uncovered,
 * failed or left to an unconnected phase. Exit status follows `status`, never the amount deleted.
 */
export async function runRetentionWorker(ports: HPorts): Promise<RetentionRun> {
  const ledger = await ports.sweepLedger();
  const reconcile = await ports.reconcile();
  const run: RetentionRun = { status: 'failed', at: null, ledger, reconcile,
    statutory: { due: 0, destroyed: 0, retained: 0, held: 0, unsupported: {}, overdue: 0, delayReasonMissing: 0 },
    purpose: null, uncovered: [], open: [...ports.openPhases], failure: null };
  if (reconcile.unfinished) { run.failure = reconcile.failures[0] ?? 'RetentionResumeFailed'; return run; }
  const at = run.at = await ports.clock();
  const inventory = await ports.inventory(at);
  const unsupported: Record<string, number> = {};
  for (const unit of inventory.units) {
    if (unit.status === 'unsupported') unsupported[unit.reason ?? 'unknown'] = (unsupported[unit.reason ?? 'unknown'] ?? 0) + 1;
    else if (unit.status === 'retained') run.statutory.retained++;
    else if (unit.status === 'held') run.statutory.held++;
  }
  run.statutory.unsupported = unsupported;
  run.uncovered = [...inventory.uncovered];
  run.purpose = inventory.drafts;
  const due = inventory.units.filter(u => u.status === 'due');
  run.statutory.due = due.length;
  if (due.length) {
    // Sets completed before a failed set stay completed; count what became durable, not what the batch returned.
    const completed: Readonly<DestructionRecord>[] = [];
    const store: BatchDisposalAuditStore = { ...ports.store, appendCompletedSet: async events => {
      const receipt = await ports.store.appendCompletedSet(events); completed.push(...events); return receipt; } };
    const tally = () => {
      run.statutory.destroyed = completed.length;
      run.statutory.overdue = completed.filter(e => e.timeliness === 'overdue').length;
      // H has no source of a lawful operational delay reason; a late completion is recorded and reported for action.
      run.statutory.delayReasonMissing = completed.filter(e => e.delayReasonStatus === 'missing').length;
    };
    try {
      const graph = await ports.graphFor(due.map(u => u.recordId), at);
      await destroyBatchAtExpiry(store, {
        units: due.map(u => ({ record: u.record!, versionIds: u.record!.parts.map(p => p.partId), justifiedDelay: null })),
        requestedAt: at, graph }, ports.destroySet);
      tally();
    } catch (error) {
      tally();
      run.failure = code(error);
      return run;
    }
  }
  run.status = Object.keys(unsupported).length || run.uncovered.length || inventory.drafts.inconsistent || run.open.length
    ? 'incomplete' : 'complete';
  return run;
}
