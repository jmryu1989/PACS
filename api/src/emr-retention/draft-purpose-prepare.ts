import { PrismaClient } from '@prisma/client';
import { prepareLedgerAdoption } from './draft-purpose';

/**
 * CD-09-P first start of a server that already has drafts (`node dist/emr-retention/draft-purpose-prepare.js` in the API
 * image, the API's own credential and ledger directory), run once **before** the P migration. Without it the first
 * start of such a server stays closed (PurposeLedgerInitializationRequired): the product cannot tell those drafts from
 * a restored copy of a server that already destroyed some of them. The procedure that keeps whole-server copies taken
 * before the first start out of use is docs/ops/release-tools-runbook.md (Draft purpose ledger: first start).
 *
 * One JSON line; exit 0 only when the adoption record was written.
 */
async function main(): Promise<number> {
  const db = new PrismaClient();
  try {
    const adoption = await prepareLedgerAdoption(db);
    console.log(JSON.stringify({ prepared: true, state: adoption.state }));
    return 0;
  } finally { await db.$disconnect(); }
}

if (require.main === module)
  main().then(code => { process.exitCode = code; }, error => {
    console.log(JSON.stringify({ prepared: false, error: error?.code ?? error?.name ?? 'Error' }));
    process.exitCode = 1;
  });
