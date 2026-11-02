import type { RawQuery } from '../emr-runtime/manifest';

/** D1794: the existing SQL boundary performs partial database erasure and keeps
 * unknown record histories. It does not certify destruction of backup copies.
 * Clinical destruction cannot use this connection until its inventory/journal
 * grants and storage adapter are supplied (CD-09 prohibits a migration here).
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

export const UNCONNECTED_PHASES = Object.freeze([
  'record-history-inventory', 'statutory-destruction', 'purpose-end-destruction',
  'destruction-journal-and-reconciliation', 'backup-policy-in-destruction-record',
]);

/** This entry deliberately returns an incomplete run until the forbidden-in-this-
 * unit SQL prerequisites are resolved. Never turn a successful ledger-only sweep
 * into a claim that clinical originals, derivatives or backups were destroyed. */
export async function runRetentionWorker(db: RawQuery) {
  return {
    status: 'incomplete' as const,
    ledger: await sweepLedgerExpiry(db),
    open: UNCONNECTED_PHASES,
  };
}
