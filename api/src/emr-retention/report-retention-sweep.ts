import { PrismaClient } from '@prisma/client';
import { composeEmrAdapters } from '../emr-contract/composition';
import { runtimeAdapters } from '../emr-runtime/context';
import { REPORT_SETTLED, ReportLedgerFile, ReportRetention, attemptRecords, reportLedgerDirectory } from './report-retention';

/**
 * CD-09-D dedicated run (`node dist/emr-retention/report-retention-sweep.js` in the API image, the API's own credential and
 * ledger directory): destroys every report whose retention ended and re-applies every destruction the ledger completed
 * that this database still holds. The server runs the same sweep after its gate opens; this run is the daily recovery.
 *
 * One JSON line: each unit's outcome (only the opaque unit), the counts, and for every unit left (held or unconfirmed)
 * its due day and whether that day has passed. Exit 0 only when every unit was destroyed, re-applied, already absent, not
 * yet due or held by a recorded reason; an unconfirmed report, a busy study, an unknown or refused attempt is exit 1 -
 * a run that destroyed nothing because it could read nothing is not complete.
 *
 * `--operation <id>`: the records of that one attempt (its started record's operation ID, which an unknown outcome
 * reports), read from the ledger alone; exit 0 when the attempt has a completed or failed record.
 */
export async function runReportRetentionSweep(db: PrismaClient, directory = reportLedgerDirectory()) {
  const results = await new ReportRetention(db, new ReportLedgerFile(directory)).sweep();
  const counts: Record<string, number> = {};
  for (const result of results) counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
  return { ran: true, results, counts, complete: results.every(r => REPORT_SETTLED.includes(r.outcome)) };
}

export function reportRetentionAttempt(operationId: string, directory = reportLedgerDirectory()) {
  const records = attemptRecords(new ReportLedgerFile(directory), operationId);
  return { operationId, records, settled: records.some(r => r.phase !== 'started') };
}

async function main(argv: readonly string[]): Promise<number> {
  const at = argv.indexOf('--operation');
  if (at >= 0) {
    const report = reportRetentionAttempt(argv[at + 1] ?? '');
    console.log(JSON.stringify(report));
    return report.settled ? 0 : 1;
  }
  const db = new PrismaClient();
  try {
    composeEmrAdapters(runtimeAdapters);
    const report = await runReportRetentionSweep(db);
    console.log(JSON.stringify(report));
    return report.complete ? 0 : 1;
  } finally { await db.$disconnect(); }
}

if (require.main === module)
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.log(JSON.stringify({ ran: false, error: error?.code ?? error?.name ?? 'Error' }));
    process.exitCode = 1;
  });
