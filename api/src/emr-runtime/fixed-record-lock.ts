import type { Prisma } from '@prisma/client';

/** Publication, fixed-copy selection and retention share the record boundary.
 * Callers holding several records acquire them in sorted order. */
export async function lockFixedRecord(tx: Pick<Prisma.TransactionClient, '$queryRaw'>, recordId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['emr-fixed-record', recordId])},0))::text`;
}

/** Acquire the complete set before any clinical row or signing lock. Sorting
 * once also makes reciprocal source/target writes share the same first lock. */
export async function lockFixedRecords(tx: Pick<Prisma.TransactionClient, '$queryRaw'>, recordIds: readonly string[]): Promise<void> {
  for (const recordId of [...new Set(recordIds)].sort()) await lockFixedRecord(tx, recordId);
}
