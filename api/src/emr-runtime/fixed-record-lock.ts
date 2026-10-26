import type { Prisma } from '@prisma/client';

/** Publication, fixed-copy selection and retention share the record boundary.
 * Callers holding several records acquire them in sorted order. */
export async function lockFixedRecord(tx: Pick<Prisma.TransactionClient, '$queryRaw'>, recordId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['emr-fixed-record', recordId])},0))::text`;
}
