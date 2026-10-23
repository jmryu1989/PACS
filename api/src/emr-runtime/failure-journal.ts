import { randomUUID } from 'node:crypto';
import type { RawQuery } from './manifest';
import { FailureSpool, JournalRecord } from './journal-file';
export { FailureSpool, JournalRecord, JournalUnavailable } from './journal-file';

/** This client is never the caller's business transaction. */
export class FailureJournal {
  constructor(private readonly db: RawQuery, private readonly spool: FailureSpool) {}
  private async import(record: JournalRecord): Promise<void> {
    await this.db.$queryRaw`SELECT emr_access.record_failure(${record.id}::uuid, ${record.operationId}::uuid,
      ${record.eventId}::text, ${record.at}::timestamptz, ${record.cause}::text)::text`;
  }
  async record(cause: JournalRecord['cause'], eventId: string | null, operationId: string | null): Promise<'database' | 'spool'> {
    const record: JournalRecord = { id: randomUUID(), cause, eventId, operationId, at: new Date().toISOString() };
    try { await this.import(record); return 'database'; }
    catch {
      try { await this.spool.append(record); return 'spool'; }
      catch {
        console.error('[EMR] Failure storage unavailable; no durable failure record was accepted.');
        throw new Error('FailureStorageUnavailable');
      }
    }
  }
  replay(): Promise<number> { return this.spool.replay(record => this.import(record)); }
  close(): Promise<void> { return this.spool.close(); }
}
