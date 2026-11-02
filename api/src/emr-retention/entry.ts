import { PrismaClient } from '@prisma/client';
import { composeEmrAdapters } from '../emr-contract/composition';
import { runtimeAdapters } from '../emr-runtime/context';
import { PgRetention } from './pg';
import { refusalCode, runRetentionWorker } from './worker';

/** Phases this entry does not connect yet. Images (Orthanc, derived copies, caches) are CD-09b: until then no run is
 * complete, whatever the PostgreSQL slice destroyed. */
export const OPEN_PHASES = Object.freeze(['image-destruction']);

/** One connection only: H's session record locks must stay on the connection that runs its separately committed steps. */
export function singleConnection(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', '1');
  return parsed.toString();
}

/** Like the member-rights import CLI, own the connection and always close it. The host's daily invocation owns
 * scheduling, as it does for ops_backup. Exit 0 only for a complete run. */
export async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('RetentionDatabaseUrlRequired');
  composeEmrAdapters(runtimeAdapters);
  const db = new PrismaClient({ datasources: { db: { url: singleConnection(process.env.DATABASE_URL) } } });
  try {
    await db.$connect();
    const result = await runRetentionWorker(new PgRetention(db).ports(OPEN_PHASES));
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.status === 'complete' ? 0 : 1;
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main().catch(error => {
    // The raw service/DB logs remain the diagnosis source; this is not a durable failure-ledger receipt.
    process.stderr.write(`Retention worker failed (${refusalCode(error)}); no complete destruction receipt.\n`);
    process.exitCode = 1;
  });
}
