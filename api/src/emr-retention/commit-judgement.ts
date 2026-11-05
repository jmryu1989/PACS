import { CommitOutcomeUnknown, DestructionReceipt } from '../emr-contract/lawful-defaults';

/*
 * CD-09-C: the commit judgement every retention unit shares. Each unit's adapter says what it locks and reads for one
 * attempt (the draft purpose unit's three targets: draft-purpose.ts judgeCommit); this module owns the rest - the three
 * outcomes, the new transaction read after the attempt settled with a bounded lock wait, and the answer A's journal gets
 * from them. Neither the attempt's own transaction answer nor an error reading back is evidence: a failed COMMIT has
 * answered as success on the served stack, and an error answering COMMIT does not say nothing committed.
 */

export type CommitOutcome = 'committed' | 'not-committed' | 'unknown';
const OUTCOMES: readonly unknown[] = ['committed', 'not-committed', 'unknown'];

/**
 * `read` runs in a new transaction whose lock wait is the server's 3 s. It first locks a row the attempt's own
 * transaction locked, so it reads only once that transaction has settled. A read that cannot be made - the lock not
 * granted in time, a lost connection, an error answering - and an answer that is none of the three outcomes are unknown.
 */
export async function judgeSettled(db: any, read: (tx: any) => Promise<CommitOutcome>): Promise<CommitOutcome> {
  try {
    const outcome = await db.$transaction(async (tx: any) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      return read(tx);
    }, { maxWait: 5000, timeout: 15000 });
    return OUTCOMES.includes(outcome) ? outcome : 'unknown';
  } catch { return 'unknown'; }
}

/**
 * A destroyer's answer to A's journal from the judgement of its deletion: committed is the receipt (A writes completed),
 * not committed is the confirmed failure it throws (A writes failed at the confirmation time), unknown is
 * CommitOutcomeUnknown (A leaves started for the process that made the attempt to settle).
 */
export function destroyerAnswer(outcome: CommitOutcome, receipt: DestructionReceipt, notCommitted: () => unknown): DestructionReceipt {
  if (outcome === 'committed') return receipt;
  if (outcome === 'not-committed') throw notCommitted();
  throw new CommitOutcomeUnknown();
}
