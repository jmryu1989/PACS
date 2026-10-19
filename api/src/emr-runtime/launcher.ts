import type { DynamicModule, INestApplication, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Server } from 'node:http';
import { ContractError, refuse } from '../emr-contract/validation';
import { EmrRuntimeOwner, EmrStartupFailure, EmrStartupPhase } from './application';
import { EmrStopPhase, startupFailureMessage, stopFailureMessage } from './manifest';
import { createRecordPort, EmrRecordPort, EmrRecordPortControl } from './record-port';
import { installHttpAdmission } from './http-admission';
import { createNestLifecycle } from './nest-lifecycle';

/**
 * EMR-B2 (d): the one launcher of the API process. It alone starts and stops the process: the EMR ledger owner, the Nest
 * application, its init and its HTTP listener are acquired here in this order and released here in the reverse order,
 * under one permanent stop latch that exists before the first resource and is tripped by SIGTERM, SIGINT or a start
 * failure - and by nothing a Nest consumer can reach. main.ts keeps the environment checks and the HTTP composition
 * (parsers, headers, CORS, prefix) and calls this once; Nest's own signal handling (enableShutdownHooks) is not used,
 * so the stop has exactly one command.
 *
 * Start: config -> connect -> role -> fence -> recovery -> compose (the owner) -> create -> init -> listen. The latch is
 * checked after every wait: once tripped, no further phase starts, and the step that was in flight is the one the start
 * ends in. Every resource's cleanup entry is registered before its acquisition, so a connect, create or listen that
 * returns after the stop began is found and released by the stop. The listener is acquired with the latch's signal, so
 * an abort while the bind is pending leaves no listener, no success log and no answered request behind.
 *
 * Stop (one memoized sequence): admission ends at once - no new recording work (the record port refuses), no new
 * connection (the listener closes on the signal), a start in flight ends at its step - then, on every path, the
 * admitted requests and the begun recording work (also a record that a response's finish started, also work an
 * init-time job began before any listener existed) drain: within 10 s while serving, else within the cleanup bound;
 * then the Nest application closes (its destroy and shutdown hooks) and the ledger client is released, within 5 s -
 * the same 5 s that bound the cleanup of a failed or interrupted start. A bound exceeded, or an application close
 * that fails (a destroy hook that throws; the remaining Nest stages still run), prints one closed line naming the
 * phase and the process ends nonzero; otherwise it ends 0 after a signal (also when the step in flight failed after
 * the signal) and 1 after a start that failed on its own. The writer fence is held for the process lifetime and ends
 * with it.
 */
export interface LaunchInput {
  /** The process environment, read for the owner's configuration. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The Nest root for the prepared record port (AppModule.forLaunch): the port is the only EMR object Nest receives. */
  readonly root: (port: EmrRecordPort) => Type<unknown> | DynamicModule;
  /** The application's HTTP composition between create and init. */
  readonly configure: (app: INestApplication) => void;
}

const DRAIN_GRACE_MS = 10000;
const FATAL_CLEANUP_MS = 5000;
const SIGNALS = ['SIGTERM', 'SIGINT'] as const;
type StopSignal = typeof SIGNALS[number];
type StopCause = Readonly<{ kind: 'signal'; signal: StopSignal } | { kind: 'failure' }>;
type ResourceName = 'ledger' | 'app' | 'listener';
interface Resource { readonly name: ResourceName; readonly release: () => Promise<void>; released?: Promise<'done' | 'failed'> }

/** A wall-clock budget shared by consecutive waits: each race resolves 'done' or 'timeout', never rejects. */
function budget(ms: number) {
  const until = Date.now() + ms;
  return {
    race(work: Promise<unknown>): Promise<'done' | 'timeout'> {
      const left = until - Date.now();
      if (left <= 0) return Promise.resolve('timeout');
      return new Promise(resolve => {
        const timer = setTimeout(() => resolve('timeout'), left);
        const settled = () => { clearTimeout(timer); resolve('done'); };
        work.then(settled, settled);
      });
    },
  };
}

/** The listener acquired with the latch's signal: settled on `listening`, `error` or the signal's abort, and the three
 * listeners removed afterwards. Node closes the server on the abort itself, also while the bind is still pending. */
function listen(server: Server, signal: AbortSignal, phase: EmrStartupPhase): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const detach = () => {
      server.removeListener('listening', onListening);
      server.removeListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onListening = () => { detach(); resolve(); };
    const onError = (error: unknown) => { detach(); reject(error); };
    const onAbort = () => { detach(); reject(interrupted(phase)); };
    if (signal.aborted) return onAbort();
    server.once('listening', onListening);
    server.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    server.listen({ port: 3000, host: '0.0.0.0', signal });
  });
}

function interrupted(phase: EmrStartupPhase): EmrStartupFailure {
  return new EmrStartupFailure(phase, new ContractError('EmrStartupInterrupted'), true);
}

let launched = false;

/**
 * Starts the process's one API: resolves once the server listens (the caller may then log); every failure and every
 * stop ends the process here. A second call in the same process is refused.
 */
export async function launchApi(input: LaunchInput): Promise<void> {
  if (launched) refuse('EmrLaunchRepeated');
  launched = true;
  const latch = new AbortController();
  const resources: Resource[] = [];
  let owner: EmrRuntimeOwner | undefined, app: INestApplication | undefined, server: Server | undefined;
  let control: EmrRecordPortControl | undefined, outcome: Promise<void> | undefined;
  let admission: ReturnType<typeof installHttpAdmission> | undefined;
  let lifecycle: ReturnType<typeof createNestLifecycle> | undefined;
  let serving = false, exitCode = 0;

  // The latch: tripped by a signal or a start failure, once; the handlers stay until the process ends and do nothing
  // else. The stop sequence begins at the trip, in the same turn, before anything else can run.
  const trip = (cause: StopCause) => { if (!latch.signal.aborted) latch.abort(cause); };
  for (const signal of SIGNALS) process.on(signal, () => trip({ kind: 'signal', signal }));
  latch.signal.addEventListener('abort', () => { void stop(); }, { once: true });

  const reserve = (name: ResourceName, release: () => Promise<void>) => { resources.push({ name, release }); };
  const check = (phase: EmrStartupPhase) => { if (latch.signal.aborted) throw interrupted(phase); };

  const start = async (): Promise<void> => {
    let phase: EmrStartupPhase = 'config';
    try {
      owner = new EmrRuntimeOwner(input.env);
      const ledger = owner;
      reserve('ledger', () => ledger.close());
      check('connect');
      await ledger.start();
      phase = 'create';
      check(phase);
      const records = createRecordPort(ledger.store());
      control = records.control;
      reserve('app', () => lifecycle?.close(latch.signal.reason?.signal) ?? Promise.resolve());
      const created = await NestFactory.create(input.root(records.port), { rawBody: true, abortOnError: false, bufferLogs: true, autoFlushLogs: false });
      app = created;
      lifecycle = createNestLifecycle(created, latch.signal);
      const listener = server = created.getHttpServer();
      reserve('listener', () => closeListener(listener));
      admission = installHttpAdmission(listener, latch.signal);
      check(phase);
      input.configure(created);
      phase = 'init';
      check(phase);
      await created.init();
      check(phase);
      admission.verifyOwnership();
      lifecycle.verifyOwnership();
      phase = 'listen';
      await listen(listener, latch.signal, phase);
      check(phase);
      created.flushLogs();
      serving = true;
    } catch (error) {
      const failure = error instanceof EmrStartupFailure ? error : new EmrStartupFailure(phase, error);
      console.error('[KIN API] ' + startupFailureMessage(failure.phase, failure.failure));
      // A start that fails on its own ends the process 1; one that was asked to stop ends 0 whether its step returned
      // or failed after that request - the line says which.
      if (!latch.signal.aborted) exitCode = 1;
      trip({ kind: 'failure' });
    }
  };

  /** The listener's release: no new connection, idle connections closed as they become idle (a keep-alive socket must
   * not hold the drain for its own timeout), every admitted request answered. */
  const closeListener = (listener: Server) => new Promise<void>(resolve => {
    const sweep = setInterval(() => listener.closeIdleConnections(), 100);
    listener.close(() => { clearInterval(sweep); resolve(); });
    listener.closeIdleConnections();
  });
  /** Each entry's release runs once; it resolves 'failed' instead of rejecting, so no release masks the line that ended
   * the process and a failed application close is reported as its phase. */
  const release = (entry: Resource) => entry.released ??= new Promise<void>(resolve => resolve(entry.release())).then(() => 'done' as const, () => 'failed' as const);

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => stopping ??= (async () => {
    control?.close();
    owner?.interrupt();
    let unfinished: EmrStopPhase | undefined, fatal: ReturnType<typeof budget> | undefined;
    // The 5 s cleanup bound runs from the stop when the start is still in flight, else from the end of the drain.
    if (!serving && await (fatal = budget(FATAL_CLEANUP_MS)).race(outcome ?? Promise.resolve()) === 'timeout') {
      unfinished = 'start';
      lifecycle?.expire();
    }
    // The drain, on every path: the listener's connections when one was reserved, then every begun recording work -
    // also work an init-time job began before any listener existed - under the 10 s grace while serving, else under
    // the cleanup bound. Only then do the application and the ledger go.
    const listener = resources.find(entry => entry.name === 'listener');
    const drained = (listener ? release(listener) : Promise.resolve('done' as const)).then(() => control?.drained());
    if (await (serving ? budget(DRAIN_GRACE_MS) : (fatal ??= budget(FATAL_CLEANUP_MS))).race(drained) === 'timeout') {
      unfinished ??= 'drain';
      admission?.destroyAll();
    }
    for (const entry of [...resources].reverse()) {
      if (entry.name === 'listener') continue;
      const waited = await (fatal ??= budget(FATAL_CLEANUP_MS)).race(release(entry));
      if (waited === 'timeout') {
        unfinished ??= entry.name;
        lifecycle?.expire();
      } else if (await release(entry) === 'failed') unfinished ??= entry.name;
    }
    if (unfinished) {
      if (lifecycle) console.log('[KIN API] lifecycle accounting: ' + JSON.stringify(lifecycle.accounting()));
      console.error('[KIN API] ' + stopFailureMessage(unfinished));
      exitCode = 1;
    }
    process.exit(exitCode);
  })();

  outcome = start();
  await outcome;
  // A start that did not reach serving is being ended by the stop; the process ends there, never here.
  if (!serving) await new Promise<never>(() => { /* the stop ends the process */ });
}
