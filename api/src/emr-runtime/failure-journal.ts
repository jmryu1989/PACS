import { randomUUID } from 'node:crypto';
import type { AccessEventV1, EvidenceFact } from '../emr-contract/access-event';
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

/**
 * A 열람 (provide) record that B2 judged not committed or could not judge, while its body was sent anyway (B2-COMMIT
 * B6 as reduced 2026-11-05). B2's failure journal holds this event's id, operation, time and cause; its operation row
 * keeps the actor and content only as hashes. This line keeps who, what, when and the result readable for the operator
 * (no administrator alert path exists). The patient link is left out: the study, record and version name the target.
 */
export function logUnrecordedProvide(event: Pick<AccessEventV1, 'eventId' | 'requestId' | 'surface' | 'userId' | 'occurredAt' | 'action' | 'targets'>,
  result: 'not-recorded' | 'unknown'): void {
  const fact = (f: EvidenceFact<unknown> | undefined) => f?.status === 'known' ? f.value : null;
  console.warn('[EMR] access record ' + result + ': ' + JSON.stringify({ eventId: event.eventId, requestId: event.requestId,
    surface: event.surface, user: fact(event.userId), at: event.occurredAt, action: event.action,
    targets: event.targets.map(t => ({ kind: t.kind, studyId: fact(t.studyId), recordId: fact(t.recordId), versionId: fact(t.versionId) })) }));
}
