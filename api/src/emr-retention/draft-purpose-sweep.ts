import { PrismaClient } from '@prisma/client';
import { composeEmrAdapters } from '../emr-contract/composition';
import { runtimeAdapters } from '../emr-runtime/context';
import { DestructionOutcome, DraftPurposeDisposal, PurposeLedgerFile, purposeLedgerDirectory } from './draft-purpose';

/**
 * CD-09-P dedicated run (`node dist/emr-retention/draft-purpose-sweep.js` in the API image, the API's own credential and
 * ledger directory): destroys every ended private draft work whose deliveries have settled - the recovery for a failed
 * immediate attempt and the resume after a hold is released. The server already destroys right after each end; a daily
 * run is the recovery, never the first attempt.
 *
 * One JSON line: each unit's outcome (only the opaque unit) and the counts. Exit 0 only when every ended work was destroyed,
 * re-applied, already absent or is held by a live legal hold; any refusal, unsettled delivery or error is exit 1.
 */
const SETTLED: readonly DestructionOutcome['outcome'][] = ['destroyed', 'reapplied', 'absent', 'held'];

export async function runDraftPurposeSweep(db: PrismaClient, directory = purposeLedgerDirectory()) {
  const results = await new DraftPurposeDisposal(db, new PurposeLedgerFile(directory)).sweep();
  const counts: Record<string, number> = {};
  for (const result of results) counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
  return { ran: true, results, counts, complete: results.every(r => SETTLED.includes(r.outcome)) };
}

async function main(): Promise<number> {
  const db = new PrismaClient();
  try {
    composeEmrAdapters(runtimeAdapters);
    const report = await runDraftPurposeSweep(db);
    console.log(JSON.stringify(report));
    return report.complete ? 0 : 1;
  } finally { await db.$disconnect(); }
}

if (require.main === module)
  main().then(code => { process.exitCode = code; }, error => {
    console.log(JSON.stringify({ ran: false, error: error?.code ?? error?.name ?? 'Error' }));
    process.exitCode = 1;
  });
