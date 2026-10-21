import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { composeEmrAdapters } from '../emr-contract/composition';
import { refuse } from '../emr-contract/validation';
import { appendPoolConfiguration } from './admission';
import { EmrLedgerClient } from './client';
import { runtimeAdapters } from './context';
import { EMR_STATE_IDENTITIES, databaseIdentity, verifyRuntimeConnection } from './manifest';
import { RemoteLedgerState, RemoteSession } from './remote-state';
import { StateClient } from './state-client';
import { DatabaseIdentity } from './state-protocol';
import { AccessLedgerStore, PrismaLedgerSql } from './store';

/**
 * EMR-B2 (c): the API process's client-only runtime of the access ledger - a library object the launcher drives; it is
 * not a Nest provider and no consumer holds it. The start opens the dedicated EmrLedgerClient (its pool is the store's
 * admission capacity), checks the runtime role (production), reads the ordinary runtime DB's identity and both chain
 * identifiers, opens the one control session of the protected-state service over its fixed IPC endpoint, compares the
 * service's hello (instance, database, chains) with what this process observed itself, composes A once with B's
 * readers and hands the launcher one started store. There is no protected file, mount, fence, recovery, reader
 * credential, service spawn, reconnection or synchronous wait here: a service that is absent, not ready, paired with
 * another database or lost later means closed admission and a bounded end of this process - its supervisor restart is a
 * new process whose own handshake decides again.
 */
export type EmrStartupPhase = 'create' | 'config' | 'connect' | 'role' | 'session' | 'pair' | 'compose' | 'init' | 'listen';

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
interface Configuration { databaseUrl: string; socketPath: string; instanceId: string; verifyRole: boolean }

function configuration(env: Readonly<Record<string, string | undefined>>): Configuration {
  const databaseUrl = env.DATABASE_URL ?? '';
  let parsed: URL;
  try { parsed = new URL(databaseUrl); } catch { refuse('EmrDatabaseUrlRequired'); }
  if (!['postgresql:', 'postgres:'].includes(parsed.protocol)) refuse('EmrDatabaseUrlRequired');
  appendPoolConfiguration(databaseUrl);
  // The API's client endpoint (docker-compose.yml: the read-only IPC volume the service listens in), not the service's
  // own KIN_EMR_API_SOCKET listen path and never a protected-state directory.
  const socketPath = env.KIN_EMR_STATE_SOCKET ?? '';
  if (!socketPath || socketPath.includes('\0') || !path.isAbsolute(socketPath) || path.resolve(socketPath) !== socketPath) refuse('EmrStateSocketRequired');
  const instanceId = env.KIN_EMR_INSTANCE_ID ?? '';
  if (!instanceId || instanceId.includes('\0') || Buffer.byteLength(instanceId) > 256) refuse('EmrStateInstanceRequired');
  // An API that is handed the protected state directory is misdeployed: the service alone mounts it.
  if (env.KIN_EMR_STATE_DIR) refuse('EmrStateDirectoryForbidden');
  return Object.freeze({ databaseUrl, socketPath, instanceId, verifyRole: env.DEPLOYMENT_MODE === 'production' });
}

/**
 * States: cold -> starting -> ready -> stopping -> closed, or starting -> failed, or cold -> stopping -> closed, and
 * ready -> stopping when the control session is lost. Every transition happens without an await in between. A stop
 * requested in any state - before the start too - is recorded before the next step: a start asked for after it is
 * refused before it creates anything, and a start whose wait returns after it ends right there. The release of what
 * the start created is one memoized promise, taken after the step in flight returned.
 */
export class EmrApiClientRuntime {
  private readonly config: Configuration;
  private state: State = 'cold';
  private ledger: AccessLedgerStore | undefined;
  private db: EmrLedgerClient | undefined;
  private client: StateClient | undefined;
  private remote: RemoteLedgerState | undefined;
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private releasing: Promise<void> | undefined;
  private lost = false;
  /** Environment checks only: no connection, no socket, no file, no timer. */
  constructor(env: Readonly<Record<string, string | undefined>>, private readonly onLoss: () => void = () => undefined) {
    try { this.config = configuration(env); }
    catch (error) { throw new EmrStartupFailure('config', error); }
  }
  /** The single start: locked before its first await, so any later call is refused. Ready only after the whole sequence. */
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
  /** The admitted session's facts (service epoch, instance, chains), for diagnostics and the probe; never credentials. */
  session(): RemoteSession | undefined { return this.remote?.session; }
  /** The service's read-only status over the admitted session (the probe's observation of seal, journal and pending counts). */
  status() {
    if (this.state !== 'ready' || !this.remote) refuse('EmrRuntimeNotReady');
    return this.remote.status();
  }
  /** True once the control session to the service was lost: admission is closed for the rest of this process. */
  get serviceLost(): boolean { return this.lost; }
  /** A stop is requested, without releasing anything: recorded at once in every state. */
  interrupt(): void { this.requestStop(); }
  /** The explicit end, once: the start in flight is awaited (it ends at its next step), then the session and the
   * client are released within the launcher's cleanup budget. A release error is not reported here. */
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
      const sql = new PrismaLedgerSql(db);
      const observed: { database: DatabaseIdentity; chains: { viewing: string; history: string } } = {
        database: await databaseIdentity(db), chains: { viewing: (await sql.tail('viewing')).chainId, history: (await sql.tail('history')).chainId } };
      this.proceed();
      phase = 'session';
      const client = this.client = new StateClient({ path: this.config.socketPath, role: 'api',
        ownerUid: EMR_STATE_IDENTITIES.serviceUid, groupId: EMR_STATE_IDENTITIES.apiGroup });
      client.unavailable.addEventListener('abort', () => this.lose(), { once: true });
      const session = await client.openSession(randomUUID());
      this.proceed();
      phase = 'pair';
      // The service's hello is compared with this process's own observation of the ordinary runtime DB: the same
      // deployment instance, the same physical database and both chains. No side is trusted for the other's facts.
      if (session.instanceId !== this.config.instanceId || !samePair(session, observed)) refuse('EmrStatePairMismatch');
      const remote = this.remote = new RemoteLedgerState(client, session, sql);
      const ledger = new AccessLedgerStore(db, sql, remote, undefined, db.emrAppendPoolSize);
      phase = 'compose';
      composeEmrAdapters(runtimeAdapters);
      this.ledger = ledger;
      this.state = 'ready';
    } catch (error) {
      const interrupted = this.state === 'stopping';
      if (!interrupted) this.state = 'failed';
      // The release begins here, once; the start does not wait for it. close() waits for this same release.
      void this.release();
      throw new EmrStartupFailure(phase, error, interrupted);
    }
  }
  /** After every wait of the start: a stop requested meanwhile ends the start here. */
  private proceed(): void {
    if (this.state !== 'starting') refuse('EmrStartupInterrupted');
  }
  /** Connection loss, a fatal protocol fault or a stale epoch: permanent for this process, reported once to the launcher. */
  private lose(): void {
    if (this.lost) return;
    this.lost = true;
    if (this.state === 'ready' || this.state === 'starting') this.state = 'stopping';
    this.onLoss();
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
      const client = this.client, db = this.db;
      if (client) { try { await client.close(); } catch { /* see close() */ } }
      if (db) { try { await db.$disconnect(); } catch { /* see close() */ } }
    })();
  }
}

function samePair(hello: RemoteSession, observed: { database: DatabaseIdentity; chains: { viewing: string; history: string } }): boolean {
  return hello.chains.viewing === observed.chains.viewing && hello.chains.history === observed.chains.history &&
    (['database', 'oid', 'address', 'port'] as const).every(key => hello.database[key] === observed.database[key]);
}
