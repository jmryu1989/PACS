import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import * as path from 'node:path';
import { composeEmrAdapters } from '../emr-contract/composition';
import type { EmrAdapters } from '../emr-contract/composition';
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
 * EMR-B2-BASE: the one process-lifetime owner of the EMR ledger resources, a library object that main.ts starts and ends
 * explicitly; Nest only holds it (EmrApplicationRuntime below) and forwards its own shutdown. The start builds one
 * dedicated EmrLedgerClient (its pool is the store's admission capacity), checks the runtime role (production, as before),
 * takes the lifetime writer fence of the state directory (refused while another process owns it, before any recovery),
 * recovers the seal and failure journal once, and composes A once with B's readers. Later consumers receive the started
 * resources through `requireResources()` only - no consumer creates a client, fence, journal or seal, recovers, or
 * composes A. Authentication does not own any of it. A failed start is terminal for the process: there is no reset,
 * rebind or fallback, and a supervisor restart is a new process whose own recovery settles what this one left open.
 */
export interface EmrStartupResources {
  readonly db: EmrLedgerClient;
  readonly ledger: AccessLedgerStore;
  /** B's readers as A was composed with them. Not a reset or rebind capability. */
  readonly adapters: Readonly<EmrAdapters>;
}

/** The closed start-up phases main.ts reports (manifest.ts startupFailureMessage). */
export type EmrStartupPhase = 'create' | 'config' | 'connect' | 'role' | 'fence' | 'recovery' | 'compose' | 'init' | 'listen';

/** A start that did not complete: the phase it stopped in and what stopped it. Never printed as is - provider errors can
 * carry credential-bearing connection strings; main.ts prints only the closed line of startupFailureMessage.
 * `interrupted`: a close was requested while the start ran (a stop signal), so the launcher is already ending. */
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
 * States: cold -> starting -> ready -> stopping -> closed, or starting -> failed. Every transition happens without an
 * await in between, so a close that arrives while the start waits (connect, role check, recovery) is seen by the start
 * right after that wait: nothing further is created, fenced, recovered or composed, the start begins the one release of
 * what it created and rejects, and the close finishes only after that release. The close never releases under a step in
 * flight, so a client whose connect returns late is released exactly once.
 */
export class EmrRuntimeOwner {
  private readonly config: Configuration;
  private state: State = 'cold';
  private resources: Readonly<EmrStartupResources> | undefined;
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
   * failure or after a close - is refused. Ready only after the whole sequence. */
  async start(): Promise<void> {
    if (this.state !== 'cold') refuse('EmrStartupRepeated');
    this.state = 'starting';
    this.starting = this.run();
    return this.starting;
  }

  /** The started resources, the same frozen bundle every time; refused before a completed start and once closing. */
  requireResources(): Readonly<EmrStartupResources> {
    if (this.state !== 'ready' || !this.resources) refuse('EmrRuntimeNotReady');
    return this.resources;
  }

  /**
   * The explicit end, once (main.ts's failure path and Nest's shutdown both reach this one promise). During a start: the
   * stop is requested and the start is awaited, which ends at its next step, then its client's release. After ready: the
   * client is released - Nest calls this after the HTTP server drained its requests. The writer fence is held for the
   * process lifetime and ends with it: no lock file, state or journal is removed or closed here. A release error is not
   * reported: it must not mask the failure that ended the process or print provider text.
   */
  close(): Promise<void> {
    return this.closing ??= this.stop();
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
      this.resources = Object.freeze({ db, ledger, adapters: runtimeAdapters });
      this.state = 'ready';
    } catch (error) {
      const interrupted = this.state === 'stopping';
      if (!interrupted) this.state = 'failed';
      // The release begins here, once; the start does not wait for it (a disconnect that never ends must not keep the
      // failure from main.ts's line and its bounded exit). close() waits for this same release.
      void this.release();
      throw new EmrStartupFailure(phase, error, interrupted);
    }
  }

  /** After every wait of the start: a close requested meanwhile ends the start here. */
  private proceed(): void {
    if (this.state !== 'starting') refuse('EmrStartupInterrupted');
  }

  private async stop(): Promise<void> {
    if (this.state === 'starting') {
      this.state = 'stopping';
      try { await this.starting; } catch { /* the start reports its own end */ }
    } else if (this.state === 'ready') {
      this.state = 'stopping';
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

/**
 * Nest's view of the owner: one per application, created with the module graph (environment checks only), started by
 * main.ts before any init hook or listener, and closed by Nest's shutdown after the HTTP server drained (or by main.ts's
 * failure path). It adds no behaviour of its own.
 */
@Injectable()
export class EmrApplicationRuntime implements OnApplicationShutdown {
  private readonly owner: EmrRuntimeOwner;
  constructor() { this.owner = new EmrRuntimeOwner(process.env); }
  start(): Promise<void> { return this.owner.start(); }
  requireResources(): Readonly<EmrStartupResources> { return this.owner.requireResources(); }
  close(): Promise<void> { return this.owner.close(); }
  onApplicationShutdown(): Promise<void> { return this.owner.close(); }
}
