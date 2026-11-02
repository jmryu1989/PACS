import { PrismaClient } from '@prisma/client';
import { runRetentionWorker } from './worker';

/** Like the member-rights import CLI, own a single connection and always close
 * it. The host's daily invocation owns scheduling, as it does for ops_backup. */
export async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('RetentionDatabaseUrlRequired');
  const db = new PrismaClient();
  try {
    await db.$connect();
    const result = await runRetentionWorker(db);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main().catch(() => {
    // A DB exception can contain connection details. The raw service/DB logs
    // remain the diagnosis source; this is not a durable failure-ledger receipt.
    process.stderr.write('Retention worker failed; no complete destruction receipt.\n');
    process.exitCode = 1;
  });
}
