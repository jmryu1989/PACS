import { CommitOutcomeUnknown, DestructionReceipt } from '../emr-contract/lawful-defaults';
import type { CommitOutcome } from '../emr-runtime/commit-outcome';

/*
 * CD-09-C: the commit judgement every retention unit shares. Each unit's adapter says what it locks and reads for one
 * attempt (the draft purpose unit's three targets: draft-purpose.ts judgeCommit); the three outcomes and the bounded
 * read after the attempt settled are emr-runtime/commit-outcome.ts (B2 judges its own transactions with them too), and
 * this module owns the answer A's journal gets from them.
 */

export type { CommitOutcome } from '../emr-runtime/commit-outcome';
export { judgeSettled } from '../emr-runtime/commit-outcome';

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
