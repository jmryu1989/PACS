/*
 * The commit judgement B2 (store.ts) and the retention units (emr-retention/commit-judgement.ts re-exports it) share:
 * the three outcomes, and the new transaction a judgement reads in after the attempt settled, with a bounded lock wait.
 * Neither the attempt's own transaction answer nor an error reading back is evidence: a failed COMMIT has answered as
 * success on the served stack, and an error answering COMMIT does not say nothing committed. It lives here, below both,
 * so that the runtime does not import a retention unit.
 */

export type CommitOutcome = 'committed' | 'not-committed' | 'unknown';
const OUTCOMES: readonly unknown[] = ['committed', 'not-committed', 'unknown'];
const JUDGEMENT = { maxWait: 5000, timeout: 15000 };

/**
 * `work`'s answer, or `fallback` once `ms` passed. Prisma's maxWait/timeout do not end a transaction whose BEGIN never
 * answers on a connection the pool already holds (B2-COMMIT K6, VM run b2c-05b4bec: still waiting after 120 s), so a
 * read that must end gives up here; the abandoned attempt settles on its own and is never retried from this answer.
 */
export async function bounded<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
}

/**
 * `read` runs in a new transaction whose lock wait is the server's 3 s. P's reader first locks a row the attempt's own
 * transaction locked, so it reads only once that transaction has settled; B2's reader (xactOutcome) takes no lock and
 * reads a transaction still in progress as unknown. A read that cannot be made - the lock not granted in time, a lost
 * connection, an error answering, no answer within the transaction's own limits - and an answer that is none of the three
 * outcomes are unknown.
 */
export async function judgeSettled(db: any, read: (tx: any) => Promise<CommitOutcome>): Promise<CommitOutcome> {
  const judged = (async (): Promise<CommitOutcome> => {
    try {
      const outcome = await db.$transaction(async (tx: any) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        return read(tx);
      }, JUDGEMENT);
      return OUTCOMES.includes(outcome) ? outcome : 'unknown';
    } catch { return 'unknown'; }
  })();
  return bounded(judged, JUDGEMENT.maxWait + JUDGEMENT.timeout, 'unknown');
}

/**
 * The full XID of the transaction `tx` runs in, as PostgreSQL's decimal text (xid8 is 64-bit: never a JS number).
 * Asking assigns one to a transaction that has none yet, so every transaction has a status to read afterwards.
 */
export async function transactionToken(tx: any): Promise<string> {
  const [row] = await tx.$queryRaw`SELECT pg_current_xact_id()::text AS token`;
  if (typeof row?.token !== 'string' || !/^[0-9]+$/.test(row.token)) throw new Error('TransactionTokenUnavailable');
  return row.token;
}

/** B2's reader: the commit log's answer for one top-level transaction. In progress, NULL (unknown or too old an XID)
 * and any other answer are unknown. The token is valid only on the primary that issued it, within its request. */
export function xactOutcome(token: string): (tx: any) => Promise<CommitOutcome> {
  return async tx => {
    const [row] = await tx.$queryRaw`SELECT pg_xact_status(${token}::xid8)::text AS status`;
    return row?.status === 'committed' ? 'committed' : row?.status === 'aborted' ? 'not-committed' : 'unknown';
  };
}
