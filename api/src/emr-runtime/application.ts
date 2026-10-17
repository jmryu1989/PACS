import { BeforeApplicationShutdown, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { isIP } from 'node:net';
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
 * EMR-B2-BASE: the one process-lifetime owner of the EMR ledger resources. main.ts awaits `start` once, after Nest built the
 * module graph and before any init hook or listener: one dedicated EmrLedgerClient (its pool is the store's admission
 * capacity), the runtime-role check, the lifetime writer fence of the state directory, the start-up recovery of the seal
 * and failure journal, then A's single composition. Every later consumer (authentication facts, Module A, C2, I-B2)
 * receives these resources through `requireResources()`; none creates a second client, fence, journal, seal or recovery,
 * and none composes A. A failed start is terminal for the process: there is no reset, rebind or fallback, and a supervisor
 * restart is a new process whose own recovery settles what this one left open.
 */
export interface EmrStartupResources {
  readonly db: EmrLedgerClient;
  readonly ledger: AccessLedgerStore;
  /** B's readers before A binds them: what a clinical factory wraps. Not a reset or rebind capability. */
  readonly adapters: Readonly<EmrAdapters>;
}
export interface EmrClinicalLifecycle {
  checkReady(): Promise<void>;
  start(): void;
  stop(): void | Promise<void>;
}
export interface PreparedClinicalStartup {
  readonly adapters: Readonly<EmrAdapters>;
  compose(): EmrClinicalLifecycle;
  dispose(): void | Promise<void>;
}
export type EmrStartupPlan =
  | Readonly<{ mode: 'base' }>
  | Readonly<{
      mode: 'clinical';
      prepare(parts: Readonly<EmrStartupResources>): Promise<PreparedClinicalStartup>;
    }>;

/** The closed start-up phases main.ts reports (manifest.ts startupFailureMessage). */
export type EmrStartupPhase = 'create' | 'config' | 'connect' | 'role' | 'fence' | 'recovery' | 'compose' | 'clinical' | 'init' | 'listen';

/** A start that did not complete: the phase it stopped in and what stopped it. Never printed as is - provider errors can
 * carry credential-bearing connection strings; main.ts prints only the closed line of startupFailureMessage. */
export class EmrStartupFailure extends Error {
  constructor(readonly phase: EmrStartupPhase, readonly failure: unknown) {
    super('EmrStartupFailure');
    this.name = 'EmrStartupFailure';
  }
}

type State = 'new' | 'preparing' | 'ready' | 'failed' | 'stopped';
interface Owned {
  db?: EmrLedgerClient;
  dispose?: () => void | Promise<void>;
  lifecycle?: EmrClinicalLifecycle;
}
interface Configuration { databaseUrl: string; stateDirectory: string; proxyHost: string; verifyRole: boolean }

/** A peer address that may be trusted as the deployment's proxy: an IP that is neither loopback nor unspecified. */
export function trustablePeer(address: unknown): boolean {
  if (typeof address !== 'string') return false;
  const value = address.replace(/^::ffff:/i, '');
  const family = isIP(value);
  if (family === 4) return !value.startsWith('127.') && !value.startsWith('0.');
  if (family === 6) return !['::1', '::', '0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0'].includes(value.toLowerCase());
  return false;
}
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
/** A deployment-set proxy: one host name or one IP literal - never a range, a wildcard, loopback or the unspecified address. */
function proxyHost(value: string | undefined): string {
  const host = (value ?? '').trim();
  if (!host) refuse('EmrProxyHostRequired');
  const literal = isIP(host) !== 0;
  if (literal ? !trustablePeer(host) : (host.length > 253 || !host.split('.').every(label => HOST_LABEL.test(label))
      || host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost'))) refuse('EmrProxyHostInvalid');
  return host;
}
function configuration(env: Readonly<Record<string, string | undefined>>): Configuration {
  const databaseUrl = env.DATABASE_URL ?? '';
  let parsed: URL;
  try { parsed = new URL(databaseUrl); } catch { refuse('EmrDatabaseUrlRequired'); }
  if (!['postgresql:', 'postgres:'].includes(parsed.protocol)) refuse('EmrDatabaseUrlRequired');
  appendPoolConfiguration(databaseUrl);
  const stateDirectory = env.KIN_EMR_STATE_DIR ?? '';
  if (!stateDirectory || stateDirectory.includes('\0') || !path.isAbsolute(stateDirectory)) refuse('EmrStateDirectoryRequired');
  return Object.freeze({ databaseUrl, stateDirectory, proxyHost: proxyHost(env.KIN_EMR_PROXY_HOST),
    verifyRole: env.DEPLOYMENT_MODE === 'production' });
}

@Injectable()
export class EmrApplicationRuntime implements BeforeApplicationShutdown, OnApplicationShutdown {
  /** The deployment's proxy host (KIN_EMR_PROXY_HOST), checked here so a wrong value stops the start, not a request. */
  readonly trustedProxyHost: string;
  private readonly config: Configuration;
  private state: State = 'new';
  private resources: Readonly<EmrStartupResources> | undefined;
  private readonly owned: Owned = {};
  private background: Promise<void> | undefined;
  private released: Promise<void> | undefined;

  /** Environment checks only: no connection, no file, no fence, no timer. A refusal stops NestFactory.create. */
  constructor() {
    try { this.config = configuration(process.env); }
    catch (error) { throw new EmrStartupFailure('config', error); }
    this.trustedProxyHost = this.config.proxyHost;
  }

  /**
   * The single start: state is locked before the first await, so a concurrent or later call - while preparing, after
   * ready, after a failure or after shutdown - is refused. Order: dedicated client and connect, runtime-role check
   * (production, as before), lifetime fence (refused while another process owns it, before any recovery), journal and
   * seal recovery, then A composed once with B's readers (base) or the clinical factory's readers, and only then the
   * clinical lifecycle (compose once, readiness awaited, start once). Ready only after all of it.
   */
  async start(plan: EmrStartupPlan): Promise<void> {
    if (this.state !== 'new') refuse('EmrStartupRepeated');
    this.state = 'preparing';
    let phase: EmrStartupPhase = 'config';
    try {
      const clinical = startupPlan(plan);
      if (clinical && typeof clinical.prepare !== 'function') { phase = 'clinical'; refuse('EmrClinicalFactoryRequired'); }
      const db = this.owned.db = new EmrLedgerClient(this.config.databaseUrl);
      phase = 'connect';
      await db.$connect();
      phase = 'role';
      if (this.config.verifyRole) await verifyRuntimeConnection(db);
      phase = 'fence';
      const coordinator = new StateCoordinator(this.config.stateDirectory);
      if (!coordinator.holdsWriterFence) refuse('EmrStateOwnerBusy');
      phase = 'recovery';
      const journal = new FailureJournal(this.config.stateDirectory, coordinator);
      const sql = new PrismaLedgerSql(db);
      const seal = new AccessSeal(this.config.stateDirectory, sql, journal);
      const ledger = new AccessLedgerStore(db, sql, seal, journal, db.emrAppendPoolSize);
      await seal.recoverAtStart();
      const resources: Readonly<EmrStartupResources> = Object.freeze({ db, ledger, adapters: runtimeAdapters });
      let adapters: Readonly<EmrAdapters> = runtimeAdapters;
      let prepared: PreparedClinicalStartup | undefined;
      if (clinical) {
        phase = 'clinical';
        prepared = await clinical.prepare(resources);
        if (prepared && typeof prepared.dispose === 'function') this.owned.dispose = prepared.dispose.bind(prepared);
        if (!prepared || typeof prepared.compose !== 'function' || !prepared.adapters || typeof prepared.adapters !== 'object')
          refuse('EmrClinicalPreparedInvalid');
        adapters = prepared.adapters;
      }
      phase = 'compose';
      composeEmrAdapters(adapters);
      if (prepared) {
        phase = 'clinical';
        const lifecycle = prepared.compose();
        if (!lifecycle || ['checkReady', 'start', 'stop'].some(name => typeof lifecycle[name] !== 'function'))
          refuse('EmrClinicalLifecycleInvalid');
        await lifecycle.checkReady();
        this.owned.lifecycle = lifecycle;
        lifecycle.start();
      }
      // A shutdown that began while this start awaited (SIGTERM during start-up) has released what it found: never ready.
      if (this.state !== 'preparing') refuse('EmrStartupInterrupted');
      this.resources = resources;
      this.state = 'ready';
    } catch (error) {
      this.state = 'failed';
      throw new EmrStartupFailure(phase, error);
    }
  }

  /** The started resources, the same frozen bundle every time; refused before a completed start and after shutdown. */
  requireResources(): Readonly<EmrStartupResources> {
    if (this.state !== 'ready' || !this.resources) refuse('EmrRuntimeNotReady');
    return this.resources;
  }

  /** Nest calls this before it closes the HTTP server: background work stops first (the clinical lifecycle, once). */
  beforeApplicationShutdown(): Promise<void> {
    return this.background ??= this.stopBackground();
  }

  /**
   * Nest calls this after the HTTP server drained its requests (never before, unlike a disconnect in onModuleDestroy):
   * background stop if it did not happen, then the clinical parts' dispose, then the dedicated client's disconnect - each
   * only for what this start created, once. The fence ends with the process; no state, journal or fence is removed.
   * A cleanup error is not reported: it must not mask the failure that ended the process or print provider text.
   */
  onApplicationShutdown(): Promise<void> {
    return this.released ??= this.release();
  }

  private async stopBackground(): Promise<void> {
    const lifecycle = this.owned.lifecycle;
    if (!lifecycle) return;
    try { await lifecycle.stop(); } catch { /* the release below still runs; see onApplicationShutdown */ }
  }

  private async release(): Promise<void> {
    if (this.state !== 'failed') this.state = 'stopped';
    await this.beforeApplicationShutdown();
    if (this.owned.dispose) {
      try { await this.owned.dispose(); } catch { /* see onApplicationShutdown */ }
    }
    if (this.owned.db) {
      try { await this.owned.db.$disconnect(); } catch { /* see onApplicationShutdown */ }
    }
  }
}

/** The explicit plan main.ts passes: base, or clinical with its factory. No environment flag or module probe selects it. */
function startupPlan(plan: EmrStartupPlan): Extract<EmrStartupPlan, { mode: 'clinical' }> | null {
  if (plan?.mode === 'base') return null;
  if (plan?.mode !== 'clinical') refuse('EmrStartupPlanInvalid');
  return plan;
}
