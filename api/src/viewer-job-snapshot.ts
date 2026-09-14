import { Prisma } from '@prisma/client';

type Raw = Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>;

// A Job snapshot crosses the database as JSON text. Prisma's query engine parses Json values
// into its own number type before binding or returning them, which moved saved 17-digit
// doubles (for example -0.33113281957650276) by one ULP. PostgreSQL jsonb keeps a number
// token as an exact decimal, and JSON.stringify/JSON.parse are shortest round-trip exact.
export function snapshotText(snapshot: unknown): string {
  const text = JSON.stringify(snapshot);
  if (typeof text !== 'string' || !text.startsWith('{')) throw new Error('viewer job snapshot must be a JSON object');
  return text;
}

export async function writeSnapshot(tx: Raw, id: string, snapshot: unknown): Promise<void> {
  const count = await tx.$executeRaw`UPDATE "ViewerJob" SET "snapshot" = ${snapshotText(snapshot)}::jsonb WHERE "id" = ${id}::uuid`;
  if (count !== 1) throw new Error(`viewer job snapshot write affected ${count} rows`);
}

export async function readSnapshot(tx: Raw, id: string): Promise<any> {
  const rows = await tx.$queryRaw<{ snapshot: unknown }[]>`SELECT "snapshot"::text AS "snapshot" FROM "ViewerJob" WHERE "id" = ${id}::uuid`;
  if (rows.length !== 1 || typeof rows[0].snapshot !== 'string') throw new Error(`viewer job snapshot read returned ${rows.length} rows`);
  return JSON.parse(rows[0].snapshot);
}
