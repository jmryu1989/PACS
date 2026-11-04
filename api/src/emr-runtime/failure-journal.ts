import { randomUUID } from 'node:crypto';
import type { RawQuery } from './manifest';
import { FailureSpool, JournalRecord } from './journal-file';
import { bounded } from './commit-outcome';
import { EMR_TX_MAX_WAIT_MS } from './limits';
export { FailureSpool, JournalRecord, JournalUnavailable } from './journal-file';

/**
 * How long a failure waits for the database before it goes to the spool. The journal shares the ledger's client, so the
 * outage that made a commit unknown can leave this query unanswered too (B2-COMMIT F4); a request must still end. Should
 * the database insert land later, replay imports the same failure id again, which record_failure keeps once.
 */
const DATABASE_WAIT_MS = EMR_TX_MAX_WAIT_MS;

/** This client is never the caller's business transaction. */
export class FailureJournal {
  constructor(private readonly db: RawQuery, private readonly spool: FailureSpool) {}
  private async import(record: JournalRecord): Promise<void> {
    await this.db.$queryRaw`SELECT emr_access.record_failure(${record.id}::uuid, ${record.operationId}::uuid,
      ${record.eventId}::text, ${record.at}::timestamptz, ${record.cause}::text)::text`;
  }
  async record(cause: JournalRecord['cause'], eventId: string | null, operationId: string | null): Promise<'database' | 'spool'> {
    const record: JournalRecord = { id: randomUUID(), cause, eventId, operationId, at: new Date().toISOString() };
    const imported = this.import(record).then(() => true, () => false);
    if (await bounded(imported, DATABASE_WAIT_MS, false)) return 'database';
    try { await this.spool.append(record); return 'spool'; }
    catch {
      console.error('[EMR] Failure storage unavailable; no durable failure record was accepted.');
      throw new Error('FailureStorageUnavailable');
    }
  }
  replay(): Promise<number> { return this.spool.replay(record => this.import(record)); }
  close(): Promise<void> { return this.spool.close(); }
}
