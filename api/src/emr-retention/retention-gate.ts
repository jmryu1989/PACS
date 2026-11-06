/*
 * CD-09-C: the server's one startup gate over every retention unit (the draft purpose ledger now; a later unit after it).
 *
 * Each unit's adapter owns its ledger file, its anchor, its re-application and its commit judgement. The gate opens the
 * adapters one at a time in the order they were composed, each in its own transactions: one unit's failure never looks
 * like it undid another's commit, and a re-application that committed stays (it is idempotent at the next start). The
 * first adapter that cannot open stops the gate there: the later ones are not opened, no sweep runs, and the server does
 * not listen. Only when every adapter opened does each run its after-open sweep, in the same order; a sweep that reports
 * unsettled work (a held or pending destruction) is a normal open unit, a sweep that throws closes the server.
 * The gate holds no lock of its own: each adapter takes its own.
 */
import type { LedgerRestoration } from './ledger-file';

export interface RetentionAdapter {
  /** The unit's name in the log and in the closure (`draft-purpose`). */
  readonly name: string;
  /** Match the database with the unit's ledger, re-apply and judge. Resolves to a log line; throws (with a code) to close. */
  open(): Promise<string>;
  /** After every adapter opened: the unit's recovery sweep. `unsettled` counts what it left for a later run. */
  afterOpen(): Promise<{ unsettled: number }>;
}

/** The server stays closed: which adapter, its own code (unchanged, the runbook names it), and at which step. */
export class RetentionGateClosed extends Error {
  constructor(readonly adapter: string, readonly code: string, readonly step: 'open' | 'afterOpen', readonly reason: unknown) {
    super(`${adapter} ${code}`);
    this.name = 'RetentionGateClosed';
  }
}

const codeOf = (error: any) => String(error?.code ?? error?.name ?? 'Error');

export class RetentionGate {
  readonly adapters: readonly RetentionAdapter[];
  constructor(adapters: readonly RetentionAdapter[]) {
    if (!adapters.length || new Set(adapters.map(a => a.name)).size !== adapters.length) throw new Error('RetentionGateAdaptersInvalid');
    this.adapters = Object.freeze([...adapters]);
  }

  /** Resolves only when every adapter opened and swept; the caller listens after it. */
  async open(log: Pick<Console, 'log' | 'error'> = console): Promise<void> {
    for (const adapter of this.adapters) {
      let line: string;
      try { line = await adapter.open(); } catch (error) { throw new RetentionGateClosed(adapter.name, codeOf(error), 'open', error); }
      log.log(`[KIN API] Retention ${adapter.name}: ${line}`);
    }
    for (const adapter of this.adapters) {
      let swept: { unsettled: number };
      try { swept = await adapter.afterOpen(); } catch (error) { throw new RetentionGateClosed(adapter.name, codeOf(error), 'afterOpen', error); }
      if (swept.unsettled) log.error(`[KIN API] Retention ${adapter.name}: ${swept.unsettled} ended works not destroyed or not confirmed; its sweep reports them.`);
    }
  }
}

/**
 * The audit row of a ledger file the gate restores from its mirror (ledger-file.ts restoreFromMirror calls this before
 * the file changes). The product's one audit table, as every other recorded event: a system actor, the ledger's ID as
 * the target, the unit and the restoration as the detail. It names no user, study or institution, so no study's audit
 * read selects it and the admin console leaves its action out (admin-audit.ts lists only the actions it shows).
 */
export function recordLedgerRestoration(db: { auditLog: { create(args: { data: { actor: string; action: string; target: string;
    detail: string } }): Promise<unknown> } }, unit: string, restoration: LedgerRestoration): Promise<unknown> {
  return db.auditLog.create({ data: { actor: 'kin.retention', action: 'retention.ledger-restore', target: restoration.ledgerId,
    detail: JSON.stringify({ unit, ...restoration }) } });
}

let composed: RetentionGate | null = null;
/** Server startup composes the gate once; no request or setting changes the list afterwards. */
export function composeRetentionGate(adapters: readonly RetentionAdapter[]): RetentionGate {
  if (composed) throw new Error('RetentionGateAlreadyComposed');
  composed = new RetentionGate(adapters);
  return composed;
}
