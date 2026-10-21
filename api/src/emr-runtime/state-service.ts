import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import { createServer, Server } from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { StateCoordinator } from './coordinator';
import { FailureJournal } from './failure-journal';
import { AccessSeal, CommitBinding } from './seal';
import { PrismaLedgerSql } from './store';
import { EMR_STATE_IPC_TIMEOUT_MS, EMR_STATE_MAX_OPERATIONS, EMR_STATE_MAX_SCOPES,
  EMR_STATE_MAX_SESSIONS, EMR_STATE_VERIFY_CONCURRENCY, EMR_DRAIN_TIMEOUT_MS, EMR_CLEANUP_TIMEOUT_MS } from './limits';
import { databaseIdentity, EMR_STATE_IDENTITIES, verifyStateServiceConnection } from './manifest';
import { BundleIdentity, encodeStateFrame, PairIdentity, parseStateRequest, parseStateResponse,
  ExpiryPrefix, SealedBundleProof, StateFrameReader, StateProtocolError, StateRequest, StateResponse, StateRole } from './state-protocol';

interface Session { token: string; role: StateRole; client: string; socket: Socket; live: boolean }
interface Scope {
  session: Session; workId: string; token: string; ending: boolean;
  operations: Set<Promise<unknown>>; ended?: Promise<void>;
  expiryPrefix?: ExpiryPrefix;
}

/** The executable root owns every acquired resource before launching its async acquire.
 * No Nest providers, ordinary API clients or lifecycle replay participate in this process. */
export async function launchStateService(environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  let stopped = false, ready = false, failed = false, stoppedAt = 0;
  let coordinator: StateCoordinator | undefined, db: PrismaClient | undefined, service: ProtectedStateService | undefined;
  const listeners: { server: Server; abort: AbortController }[] = [];
  const tasks = new Set<Promise<unknown>>();
  let wake: () => void;
  const stoppedSignal = new Promise<void>(resolve => { wake = resolve; });
  const latch = () => {
    if (stopped) return;
    stopped = true; stoppedAt = Date.now(); service?.quiesce(); wake();
    // Startup sockets are cancellable even if bind has not delivered its completion yet.
    if (!ready) for (const listener of listeners) listener.abort.abort();
  };
  const signal = () => latch();
  process.on('SIGTERM', signal); process.on('SIGINT', signal);
  const check = () => { if (stopped) refuse('STOPPING'); };
  const own = <T>(work: () => Promise<T>): Promise<T> => {
    const promise = Promise.resolve().then(work);
    tasks.add(promise);
    void promise.then(() => tasks.delete(promise), () => tasks.delete(promise));
    return promise;
  };
  const until = async (promise: Promise<unknown>, deadline: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout>;
    const result = await Promise.race([promise.then(() => true, () => { failed = true; return true; }),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())); })]);
    clearTimeout(timer); return result;
  };
  const startup = own(async () => {
    check();
    if (process.platform !== 'linux' || process.getuid() !== EMR_STATE_IDENTITIES.serviceUid) refuse('FORBIDDEN');
    const directory = environment.KIN_EMR_STATE_DIR, instanceId = environment.KIN_EMR_INSTANCE_ID;
    if (!directory || !instanceId || instanceId.includes('\0') || Buffer.byteLength(instanceId) > 256) refuse('PROTOCOL');
    const endpoints = [
      { file: environment.KIN_EMR_API_SOCKET, group: EMR_STATE_IDENTITIES.apiGroup, role: 'api' as const },
      { file: environment.KIN_EMR_RETENTION_SOCKET, group: EMR_STATE_IDENTITIES.retentionGroup, role: 'retention' as const },
    ];
    if (endpoints[0].file === endpoints[1].file) refuse('PROTOCOL');
    for (const endpoint of endpoints) {
      if (!endpoint.file || !path.isAbsolute(endpoint.file) || endpoint.file.includes('\0') || Buffer.byteLength(endpoint.file) > 107 ||
        path.resolve(endpoint.file) !== endpoint.file) refuse('PROTOCOL');
      const parent = path.dirname(endpoint.file), info = fs.lstatSync(parent);
      if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync.native(parent) !== parent ||
        info.uid !== EMR_STATE_IDENTITIES.serviceUid || info.gid !== endpoint.group || (info.mode & 0o777) !== 0o750 ||
        parent === path.resolve(directory) || parent.startsWith(path.resolve(directory) + path.sep)) refuse('FORBIDDEN');
    }
    check(); coordinator = new StateCoordinator(directory); check();
    const url = new URL(environment.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== 'kin_emr_reader') refuse('FORBIDDEN');
    url.searchParams.set('connection_limit', String(EMR_STATE_VERIFY_CONCURRENCY));
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await db.$connect(); check();
    await verifyStateServiceConnection(db); check();
    const database = await databaseIdentity(db); check();
    const sql = new PrismaLedgerSql(db);
    const viewing = await sql.tail('viewing'); check();
    const history = await sql.tail('history'); check();
    const pair = { instanceId, database, chains: { viewing: viewing.chainId, history: history.chainId } };
    coordinator.call('admit-pair', pair); check();
    const journal = new FailureJournal(directory, coordinator);
    const seal = new AccessSeal(directory, sql, journal);
    service = new ProtectedStateService({ coordinator, journal, sql, seal,
      pair }, () => { failed = true; latch(); });
    for (const endpoint of endpoints) {
      check();
      const prior = fs.lstatSync(endpoint.file, { throwIfNoEntry: false });
      if (prior) {
        if (!prior.isSocket() || prior.uid !== EMR_STATE_IDENTITIES.serviceUid || prior.gid !== endpoint.group) refuse('FORBIDDEN');
        fs.unlinkSync(endpoint.file);
      }
      const abort = new AbortController();
      const server = createServer({ allowHalfOpen: true }, socket => service.accept(endpoint.role, socket));
      listeners.push({ server, abort });
      server.on('error', () => { failed = true; latch(); });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.once('close', () => reject(new StateProtocolError('STOPPING', 'not-started')));
        server.listen({ path: endpoint.file, signal: abort.signal }, () => {
          try {
            check(); fs.chownSync(endpoint.file, EMR_STATE_IDENTITIES.serviceUid, endpoint.group);
            fs.chmodSync(endpoint.file, 0o660); resolve();
          } catch (error) { abort.abort(); reject(error); }
        });
      });
      check();
    }
    await service.start(); check(); ready = true;
    process.stdout.write('EMR_STATE_READY\n');
  });
  void startup.catch(() => { failed = true; latch(); });
  await Promise.race([startup.catch(() => undefined), stoppedSignal]);
  if (!stopped) await stoppedSignal;
  const cleanupStart = stoppedAt + (ready ? EMR_DRAIN_TIMEOUT_MS : 0);
  if (ready && !(await until(service.drained(), cleanupStart))) failed = true;
  const cleanupEnd = (ready ? Date.now() : stoppedAt) + EMR_CLEANUP_TIMEOUT_MS;
  // Stop listeners before cleanup. A delayed bind remains owned by startup until settlement/deadline.
  service?.close();
  for (const listener of listeners) listener.abort.abort();
  if (!(await until(Promise.allSettled([...tasks]), cleanupEnd))) failed = true;
  try { coordinator?.close(); } catch { failed = true; }
  const releases: Promise<unknown>[] = [];
  for (const { server } of listeners) releases.push(new Promise<void>(resolve => server.close(() => resolve())));
  if (db) releases.push(Promise.resolve().then(() => db.$disconnect()));
  const outcomes = Promise.allSettled(releases).then(results => {
    if (results.some(result => result.status === 'rejected')) failed = true;
  });
  if (!(await until(outcomes, cleanupEnd))) failed = true;
  if (service?.incomplete) failed = true;
  // The latch remains installed until the executable exits. There is no in-process restart.
  process.stdout.write(failed ? 'EMR_STATE_INCOMPLETE\n' : 'EMR_STATE_CLOSED\n');
  return failed ? 1 : 0;
}
export interface StateServiceResources {
  coordinator: StateCoordinator; journal: FailureJournal; seal: AccessSeal; sql: PrismaLedgerSql;
  pair: PairIdentity;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const refuse = (code: StateProtocolError['code'], outcome: StateProtocolError['outcome'] = 'not-started'): never => {
  throw new StateProtocolError(code, outcome);
};
const exactBinding = (a: CommitBinding, b: CommitBinding) => a && b &&
  (Object.keys(a) as (keyof CommitBinding)[]).every(k => a[k] === b[k]) && Object.keys(a).length === Object.keys(b).length;

/** Service-local dispatcher. The listening endpoint supplies authority. All data is parsed again
 * here even for a local call; neither a caller-selected method nor a supplied state is executable.
 * PG verification has a separate bound and never holds the reserve/journal dispatch lane.
 */
export class ProtectedStateService {
  readonly serviceEpoch = randomUUID();
  private phase: 'cold' | 'starting' | 'ready' | 'stopping' | 'closed' | 'failed' = 'cold';
  private readonly sessions = new Map<string, Session>();
  private readonly controls = new Map<Socket, Session>();
  private readonly scopes = new Map<string, Scope>();
  private readonly connections = new Set<Socket>();
  private readonly operations = new Set<Promise<unknown>>();
  private verifying = 0;
  private readonly scopeKey = randomBytes(32);
  private scopeSequence = 0n;
  private startup: Promise<void> | undefined;
  private readonly changed = new Set<() => void>();
  private failed = false;
  constructor(private readonly resources: StateServiceResources, private readonly onFailure: () => void = () => {}) {}
  get state(): string { return this.phase; }
  get incomplete(): boolean { return this.failed || this.operations.size !== 0 || this.scopes.size !== 0; }
  private notify(): void { for (const wake of this.changed) wake(); this.changed.clear(); }

  start(): Promise<void> {
    if (this.phase !== 'cold') return Promise.reject(new StateProtocolError('CLOSED', 'not-started'));
    this.phase = 'starting';
    this.startup = (async () => {
      try {
        const recovered = await this.resources.seal.recoverAtStart(this.resources.pair, this.serviceEpoch);
        if (this.phase !== 'starting') refuse('STOPPING');
        if (recovered.seal.streams.viewing.chainId !== this.resources.pair.chains.viewing ||
          recovered.seal.streams.history.chainId !== this.resources.pair.chains.history) refuse('CONFLICT', 'conflict');
        this.phase = 'ready';
      } catch (error) {
        if (this.phase === 'starting') { this.phase = 'failed'; this.failed = true; }
        throw error;
      } finally { this.notify(); }
    })();
    // Startup is part of the same ownership accounting as a dispatched operation.
    this.track(this.startup);
    return this.startup;
  }
  quiesce(): void {
    if (this.phase === 'closed' || this.phase === 'failed') return;
    this.phase = 'stopping'; this.notify();
  }
  private track<T>(promise: Promise<T>, scope?: Scope): Promise<T> {
    this.operations.add(promise); scope?.operations.add(promise);
    const release = () => { this.operations.delete(promise); scope?.operations.delete(promise); this.notify(); };
    void promise.then(release, release);
    return promise;
  }
  async drained(): Promise<void> {
    while (this.operations.size || this.scopes.size) await new Promise<void>(resolve => this.changed.add(resolve));
  }
  /** Called at the common cleanup boundary. Revocation precedes IO handle closure.
   * The root still owns unfinished tasks and the lifetime fence until process exit. */
  close(): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    for (const session of [...this.sessions.values()]) this.loseSession(session);
    for (const socket of this.connections) socket.destroy();
    this.notify();
  }
  private loseSession(session: Session): void {
    if (!session.live) return;
    session.live = false; this.sessions.delete(session.token); this.controls.delete(session.socket);
    for (const scope of this.scopes.values()) if (scope.session === session) void this.endScope(scope);
    this.notify();
  }
  private token(session: Session, workId: string, sequence: string): string {
    return sequence + createHmac('sha256', this.scopeKey).update(`${session.token}:${workId}:${sequence}`).digest('hex').slice(0, 48);
  }
  private scopeId(session: Session, workId: string): string { return session.token + ':' + workId; }
  private endScope(scope: Scope): Promise<void> {
    if (scope.ended) return scope.ended;
    scope.ending = true;
    scope.ended = (async () => {
      // No new operations can enter after ending is latched. A rejected peer does not
      // release another peer's lease or prove that its COMMIT was cancelled.
      await Promise.allSettled([...scope.operations]);
      const id = this.scopeId(scope.session, scope.workId);
      if (this.scopes.get(id) === scope) this.scopes.delete(id);
      this.notify();
    })();
    return scope.ended;
  }

  async dispatch(role: StateRole, raw: unknown, connection: Socket): Promise<StateResponse> {
    const request = parseStateRequest(raw, role);
    try {
      const result = await this.admit(role, request, connection);
      return parseStateResponse({ v: 1, requestId: request.requestId, serviceEpoch: this.serviceEpoch, ok: true, result }, request);
    } catch (error) {
      let fault: StateProtocolError;
      if (error instanceof StateProtocolError) fault = error;
      else if (['AccessEventIdConflict', 'AttemptAlreadySettled', 'FailureJournalConflict'].includes((error as any)?.code))
        fault = new StateProtocolError('CONFLICT', 'conflict');
      else {
        this.failed = true; this.quiesce(); this.onFailure();
        fault = new StateProtocolError((error as any)?.code === 'FailureJournalFull' ? 'CAPACITY' : 'DURABILITY', 'unknown');
      }
      return { v: 1, requestId: request.requestId, serviceEpoch: this.serviceEpoch, ok: false,
        error: { code: fault.code, outcome: fault.outcome } };
    }
  }
  private admit(role: StateRole, request: StateRequest, connection: Socket): Promise<unknown> | unknown {
    if (this.phase === 'cold' || this.phase === 'starting') refuse('NOT_READY');
    if (this.phase === 'closed' || this.phase === 'failed') refuse('CLOSED');
    if (this.operations.size >= EMR_STATE_MAX_OPERATIONS) refuse('OVERLOADED');
    if (request.operation === 'hello') {
      if (this.phase !== 'ready') refuse('STOPPING');
      if (connection.destroyed || this.controls.has(connection)) refuse('SESSION');
      if (this.sessions.size >= EMR_STATE_MAX_SESSIONS) refuse('OVERLOADED');
      const token = randomBytes(32).toString('hex');
      const session: Session = { token, role, client: request.value.clientInstanceId, socket: connection, live: true };
      this.sessions.set(token, session); this.controls.set(connection, session);
      connection.once('close', () => this.loseSession(session));
      connection.once('end', () => this.loseSession(session));
      return { ready: true, session: token, ...this.resources.pair };
    }
    if (request.serviceEpoch !== this.serviceEpoch) refuse('EPOCH');
    const session = this.sessions.get(request.session);
    if (!session?.live || session.role !== role || session.client !== request.value.clientInstanceId) refuse('SESSION');
    if (!same(request.value.chains, this.resources.pair.chains)) refuse('CONFLICT', 'conflict');
    if (request.operation === 'status') {
      const state = this.resources.coordinator.call('read');
      return { state: this.phase, chains: this.resources.pair.chains, sealed: state.tail.streams,
        sessions: this.sessions.size, scopes: this.scopes.size, operations: this.operations.size,
        journalRecords: this.resources.journal.all().length, pending: Object.keys(state.intents).length };
    }
    const id = this.scopeId(session, request.workId);
    let scope = this.scopes.get(id);
    if (request.operation === 'begin') {
      if (this.phase !== 'ready') refuse('STOPPING');
      if (scope?.ending) refuse('SCOPE');
      if (!scope) {
        if (this.scopes.size >= EMR_STATE_MAX_SCOPES) refuse('OVERLOADED');
        scope = { session, workId: request.workId,
          token: this.token(session, request.workId, (++this.scopeSequence).toString(16).padStart(16, '0')),
          ending: false, operations: new Set() };
        this.scopes.set(id, scope);
      }
      return { scope: scope.token };
    }
    if (request.operation === 'end') {
      const token = request.value.scope;
      if (token !== this.token(session, request.workId, token.slice(0, 16))) refuse('SCOPE');
      if (!scope || scope.token !== token) return { status: 'already-ended' };
      const already = scope.ending;
      return this.track(this.endScope(scope).then(() => ({ status: already ? 'already-ended' : 'ended' })));
    }
    if (!scope || scope.token !== request.value.scope || scope.ending) refuse('SCOPE');
    const verifies = ['confirm-bundle', 'lookup-outcome', 'acknowledge', 'expiry-prefix'].includes(request.operation);
    if (verifies && this.verifying >= EMR_STATE_VERIFY_CONCURRENCY) refuse('OVERLOADED');
    if (verifies) this.verifying++;
    // Launch only after admission and attach its lease synchronously, before any await can escape.
    const work = Promise.resolve().then(() => this.execute(request, session, scope)).finally(() => { if (verifies) this.verifying--; });
    return this.track(work, scope);
  }
  private async execute(request: Exclude<StateRequest, { operation: 'hello' | 'begin' | 'status' | 'end' }>, session: Session, scope: Scope): Promise<unknown> {
    const { seal, journal } = this.resources;
    switch (request.operation) {
      case 'reserve':
        if (!session.live || scope.ending || this.phase === 'closed' || this.phase === 'failed') refuse('SCOPE');
        return seal.reserve(request.value.binding, request.value.prefix ?? undefined, session.client, {
          origin: scope, issuedPrefix: scope.expiryPrefix,
        });
      case 'journal-record': return journal.record(request.value.id, request.value.kind, request.value.body);
      case 'journal-find': return journal.find(request.value.id) ?? null;
      case 'confirm-bundle': return this.confirmBundle(request.value);
      case 'lookup-outcome': {
        // Caller journal text, live absence and disconnected scopes are never negative authority.
        if (this.fencedAbsent(request.value.bindings)) return { outcome: 'fenced-not-committed', bindings: request.value.bindings };
        try { return { outcome: 'committed-and-sealed', proof: await this.confirmBundle(request.value) }; }
        catch (error) {
          if (error instanceof StateProtocolError && error.code === 'UNAVAILABLE') return { outcome: 'unresolved' };
          if (error instanceof StateProtocolError && error.code === 'CONFLICT') return { outcome: 'conflict' };
          throw error;
        }
      }
      case 'expiry-prefix': return scope.expiryPrefix = await seal.expiryPrefix(request.value.through);
      case 'acknowledge': return { status: seal.acknowledgeBundle(request.value.proof, request.value.bindings) };
    }
  }
  private fencedAbsent(bindings: CommitBinding[]): boolean {
    const state = this.resources.coordinator.call('read');
    return bindings.every(b => {
      const terminal = state.terminal[b.stream + ':' + b.attemptId];
      // Only recoverAtStart creates an aborted terminal in this service. No remote abort exists.
      return terminal?.phase === 'aborted' && exactBinding(b, terminal.binding);
    });
  }
  private confirmBundle(bundle: BundleIdentity): Promise<SealedBundleProof> {
    return this.resources.seal.confirmBundle(bundle);
  }

  /** Control hello is persistent. Mutation sockets must half-close before dispatch,
   * so delayed extra bytes cannot cause a mutation followed by a framing rejection. */
  accept(role: StateRole, socket: Socket): void {
    if (this.phase === 'closed' || this.connections.size >= EMR_STATE_MAX_OPERATIONS + EMR_STATE_MAX_SESSIONS) { socket.destroy(); return; }
    this.connections.add(socket);
    const reader = new StateFrameReader();
    let request: StateRequest | undefined, dispatched = false, finished = false;
    const timer = setTimeout(() => socket.destroy(), EMR_STATE_IPC_TIMEOUT_MS);
    const send = async () => {
      if (dispatched || !request || socket.destroyed) return;
      dispatched = true;
      try {
        const response = await this.dispatch(role, request, socket);
        if (finished || socket.destroyed) return;
        finished = true; clearTimeout(timer);
        if (request.operation === 'hello' && response.ok) socket.write(encodeStateFrame(response));
        else socket.end(encodeStateFrame(response));
      } catch { socket.destroy(); }
    };
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      clearTimeout(timer); this.connections.delete(socket);
      const session = this.controls.get(socket); if (session) this.loseSession(session);
    });
    socket.on('data', bytes => {
      try {
        if (reader.push(bytes)) {
          request = parseStateRequest(reader.finish(), role);
          if (request.operation === 'hello') void send();
        }
      } catch { socket.destroy(); }
    });
    socket.on('end', () => {
      try {
        if (!request) request = parseStateRequest(reader.finish(), role);
        if (request.operation === 'hello') socket.destroy(); else void send();
      } catch { socket.destroy(); }
    });
  }
}
