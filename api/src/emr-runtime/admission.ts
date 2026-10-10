import { EMR_APPEND_LANES, EMR_APPEND_POOL_SIZE, EMR_VERIFY_RESERVE } from './limits';

/** Share an explicit capacity between the Prisma URL and admission. Datasource
 * overrides must pass their capacity to AccessLedgerStore as well. */
export function appendPoolConfiguration(url: string): { url: string; poolSize: number } {
  const parsed = new URL(url);
  const supplied = parsed.searchParams.get('connection_limit');
  const poolSize = supplied === null ? EMR_APPEND_POOL_SIZE : Number(supplied);
  appendLaneCount(poolSize);
  parsed.searchParams.set('connection_limit', String(poolSize));
  return { url: parsed.toString(), poolSize };
}

export function appendLaneCount(poolSize: number): number {
  if (!Number.isSafeInteger(poolSize) || poolSize <= EMR_VERIFY_RESERVE)
    throw new Error('EmrAppendPoolTooSmall');
  return Math.min(EMR_APPEND_LANES, poolSize - EMR_VERIFY_RESERVE);
}

/** All stores using one PrismaClient share FIFO admission. Acquire before BEGIN,
 * release at COMMIT/ROLLBACK, then verify the receipt outside the queue.
 * Head-lock waiters cannot consume the verification reserve. */
const pools = new WeakMap<object, { capacity: number; active: number; waiting: (() => void)[] }>();
export async function admitAppend<T>(client: object, poolSize: number, work: () => Promise<T>): Promise<T> {
  const capacity = appendLaneCount(poolSize);
  let pool = pools.get(client);
  if (!pool) { pool = { capacity, active: 0, waiting: [] }; pools.set(client, pool); }
  if (pool.capacity !== capacity) throw new Error('EmrAppendPoolConfigurationMismatch');
  if (pool.active >= capacity) await new Promise<void>(resolve => pool.waiting.push(resolve));
  else pool.active++;
  try { return await work(); }
  finally {
    const next = pool.waiting.shift();
    if (next) next(); else pool.active--;
  }
}
