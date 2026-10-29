import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/** Connections for E's per-response check transactions (service.ts prepare). The served viewer keeps about twenty
 * frames in flight and a check holds its connection for the reads of one bounded transaction, well under 200 ms, so
 * eight connections serve more checks per second than the archive serves frames. */
export const EMR_IMAGE_CHECK_POOL_SIZE = 8;

/** The same database and role as the application connection, with a bound of its own. */
export function checkPoolUrl(url: string, size = EMR_IMAGE_CHECK_POOL_SIZE): string {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', String(size));
  return parsed.toString();
}

/**
 * The connection pool of E's per-response check transactions: the application's database and role (DATABASE_URL),
 * bounded apart from the application pool and from the ledger's append pool.
 *
 * A check is one interactive transaction (identity, session and rights rows, StudyState, StudyAccess, the FOR SHARE
 * scope) and D's scope read issues reads outside that transaction on the application pool (the StudyAccess policy
 * snapshot before its locks). Run on the application pool itself, a burst of frames held every one of its connections
 * in a check transaction while each check waited for a connection for those reads: on the two-CPU VM (pool 5) every
 * frame response then failed with Prisma's pool timeout (run e-route-fix3-fable-20261027b). Run inside the ledger's
 * append lanes, four lanes over the check's hold time capped a series at about 27 frames/s (run
 * e-route-fix3-fable-20261027a). A pool of its own has neither bound: the application pool stays free for the reads a
 * check makes outside its transaction and for E's own rows, and the ledger's lanes carry records only.
 */
@Injectable()
export class ImageCheckDatabase extends PrismaClient implements OnApplicationShutdown {
  constructor() {
    super(process.env.DATABASE_URL ? { datasources: { db: { url: checkPoolUrl(process.env.DATABASE_URL) } } } : {});
  }
  async onApplicationShutdown() { await this.$disconnect(); }
}
