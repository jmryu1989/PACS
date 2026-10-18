import * as path from 'node:path';
import { composeEmrAdapters } from '../emr-contract/composition';
import { refuse } from '../emr-contract/validation';
import { appendPoolConfiguration } from './admission';
import { EmrLedgerClient } from './client';
import { runtimeAdapters } from './context';
import { StateCoordinator } from './coordinator';
import { FailureJournal } from './failure-journal';
import { verifyRuntimeConnection } from './manifest';
import { AccessSeal } from './seal';
import { AccessLedgerStore, PrismaLedgerSql } from './store';

/**
 * EMR-B2: the one process-lifetime owner of the EMR ledger resources - a library object the launcher (launcher.ts)
 * drives; it is not a Nest provider and no consumer holds it. The start builds one dedicated EmrLedgerClient (its pool
 * is the store's admission capacity), checks the runtime role (production, as before), takes the lifetime writer fence
 * of the state directory (refused while another process owns it, before any recovery), recovers the seal and failure
 * journal once, and composes A once with B's readers. The launcher wraps the started store into the record port Nest
 * receives (record-port.ts); nothing else of the owner is handed on. A failed start is terminal for the process: there
 * is no reset, rebind or fallback, and a supervisor restart is a new process whose own recovery settles what this one
 * left open.
 */
/** The closed start-up phases the launcher reports (manifest.ts startupFailureMessage). */
export type EmrStartupPhase = 'create' | 'config' | 'connect' | 'role' | 'fence' | 'recovery' | 'compose' | 'init' | 'listen';

/** A start that did not complete: the phase it stopped in and what stopped it. Never printed as is - provider errors can
 * carry credential-bearing connection strings; the launcher prints only the closed line of startupFailureMessage.
 * `interrupted`: a stop was requested while the start ran (a stop signal), so the launcher is already ending. */
export class EmrStartupFailure extends Error {
  constructor(readonly phase: EmrStartupPhase, readonly failure: unknown, readonly interrupted = false) {
    super('EmrStartupFailure');
    this.name = 'EmrStartupFailure';
  }
}

type State = 'cold' | 'starting' | 'ready' | 'stopping' | 'closed' | 'failed';
interface Configuration { databaseUrl: string; stateDirectory: string; verifyRole: boolean }

function configuration(env: Readonly<Record<string, string | undefined>>): Configuration {
  const databaseUrl = env.DATABASE_URL ?? '';
  let parsed: URL;
  try { parsed = new URL(databaseUrl); } catch { refuse('EmrDatabaseUrlRequired'); }
  if (!['postgresql:', 'postgres:'].includes(parsed.protocol)) refuse('EmrDatabaseUrlRequired');
  appendPoolConfiguration(databaseUrl);
  const stateDirectory = env.KIN_EMR_STATE_DIR ?? '';
  if (!stateDirectory || stateDirectory.includes('\0') || !path.isAbsolute(stateDirectory)) refuse('EmrStateDirectoryRequired');
  return Object.freeze({ databaseUrl, stateDirectory, verifyRole: env.DEPLOYMENT_MODE === 'production' });
}

/**
 * States: cold -> starting -> ready -> stopping -> closed, or starting -> failed, or cold -> stopping -> closed. Every
 * transition happens without an await in between. A stop requested in any state - before the start too - is recorded
 * before the next step: a start asked for after it is refused before it creates anything, and a start whose wait
 * (connect, role check, recovery) returns after it ends right there: nothing further is created, fenced, recovered or
 * composed. The release of what the start created is one memoized promise, taken after the step in flight returned, so
 * a client whose connect returns late is released exactly once - by the start's own end or by the close, never both.
 */
export class EmrRuntimeOwner {
  private readonly config: Configuration;
  private state: State = 'cold';
  private ledger: AccessLedgerStore | undefined;
  private db: EmrLedgerClient | undefined;
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private releasing: Promise<void> | undefined;

  /** Environment checks only: no connection, no file, no fence, no timer. */
  constructor(env: Readonly<Record<string, string | undefined>>) {
    try { this.config = configuration(env); }
    catch (error) { throw new EmrStartupFailure('config', error); }
  }

  /** The single start: locked before its first await, so any later call - during the start, after ready, after a
   * failure, after a stop was requested or after a close - is refused. Ready only after the whole sequence. */
  async start(): Promise<void> {
    if (this.state !== 'cold') refuse('EmrStartupRepeated');
    this.state = 'starting';
    this.starting = this.run();
    return this.starting;
  }

  /** The started store, for the launcher's record port only; refused before a completed start and once stopping. */
  store(): AccessLedgerStore {
    if (this.state !== 'ready' || !this.ledger) refuse('EmrRuntimeNotReady');
    return this.ledger;
  }

  /**
   * A stop is requested, without releasing anything: recorded at once in every state. A start in flight ends at the
   * step it waits in; a start asked for afterwards is refused; the store is no longer handed out. The release itself
   * is `close()`, which the launcher reaches in its release order after the HTTP drain.
   */
  interrupt(): void { this.requestStop(); }

  /**
   * The explicit end, once: the stop is requested (as `interrupt()` does), the start in flight - if any - is awaited,
   * which ends at its next step, then the client created so far is released. The writer fence is held for the process
   * lifetime and ends with it: no lock file, state or journal is removed or closed here. A release error is not
   * reported: it must not mask the failure that ended the process or print provider text.
   */
  close(): Promise<void> {
    this.requestStop();
    return this.closing ??= this.stop();
  }

  private requestStop(): void {
    if (this.state === 'cold' || this.state === 'starting' || this.state === 'ready') this.state = 'stopping';
  }

  private async run(): Promise<void> {
    let phase: EmrStartupPhase = 'connect';
    try {
      const db = this.db = new EmrLedgerClient(this.config.databaseUrl);
      await db.$connect();
      this.proceed();
      phase = 'role';
      if (this.config.verifyRole) {
        await verifyRuntimeConnection(db);
        this.proceed();
      }
      phase = 'fence';
      const coordinator = new StateCoordinator(this.config.stateDirectory);
      if (!coordinator.holdsWriterFence) refuse('EmrStateOwnerBusy');
      phase = 'recovery';
      const journal = new FailureJournal(this.config.stateDirectory, coordinator);
      const sql = new PrismaLedgerSql(db);
      const seal = new AccessSeal(this.config.stateDirectory, sql, journal);
      const ledger = new AccessLedgerStore(db, sql, seal, journal, db.emrAppendPoolSize);
      await seal.recoverAtStart();
      this.proceed();
      phase = 'compose';
      composeEmrAdapters(runtimeAdapters);
      this.ledger = ledger;
      this.state = 'ready';
    } catch (error) {
      const interrupted = this.state === 'stopping';
      if (!interrupted) this.state = 'failed';
      // The release begins here, once; the start does not wait for it (a disconnect that never ends must not keep the
      // failure from the launcher's line and its bounded exit). close() waits for this same release.
      void this.release();
      throw new EmrStartupFailure(phase, error, interrupted);
    }
  }

  /** After every wait of the start: a stop requested meanwhile ends the start here. */
  private proceed(): void {
    if (this.state !== 'starting') refuse('EmrStartupInterrupted');
  }

  private async stop(): Promise<void> {
    if (this.starting) {
      try { await this.starting; } catch { /* the start reports its own end */ }
    }
    await this.release();
    if (this.state !== 'failed') this.state = 'closed';
  }

  private release(): Promise<void> {
    return this.releasing ??= (async () => {
      const db = this.db;
      if (!db) return;
      try { await db.$disconnect(); } catch { /* see close() */ }
    })();
  }
}
