import { PrismaClient } from '@prisma/client';
import { appendPoolConfiguration } from './admission';

/** EMR business transactions and receipt verification share this dedicated pool.
 * Keep ordinary API reads on PrismaService: its CPU-dependent pool configuration
 * remains unchanged, and those reads cannot consume the verification reserve.
 * The owner connects/disconnects this client with its ledger lifecycle.
 */
export class EmrLedgerClient extends PrismaClient {
  readonly emrAppendPoolSize: number;
  constructor(url: string) {
    const pool = appendPoolConfiguration(url);
    super({ datasources: { db: { url: pool.url } } });
    this.emrAppendPoolSize = pool.poolSize;
  }
}
