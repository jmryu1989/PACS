import { refuse } from '../emr-contract/validation';

/**
 * EMR-B2 (c): the API process's registry of its own background work - the tasks providers start outside a request
 * (Auth's rights import, IdP end resumption, session sweep and refresh/tellIdp continuations; ManualSr's recovery
 * timer). The launcher creates it before the Nest root exists and quiesces it at the stop latch: from then on no new
 * task or timer starts, every started task sees its cancellation signal at its next await, and the launcher's drain
 * waits for the started tasks to settle (or the shared cleanup deadline to expire, which the launcher reports as
 * incomplete and exits nonzero). It owns no protected state and reaches no ledger: admission, cancellation and
 * settlement accounting only.
 */
export interface BackgroundTask { readonly name: string; readonly settled: Promise<void> }
export interface BackgroundWork {
  /** The quiesce signal: aborted once the process began to stop. Tasks pass it to their awaited I/O. */
  readonly signal: AbortSignal;
  /** True once no further task or timer may start. */
  readonly quiesced: boolean;
  /** Starts one owned task now, or refuses (`EmrBackgroundQuiesced`) after the quiesce: a refused task never ran. */
  run(name: string, work: (signal: AbortSignal) => Promise<unknown>): BackgroundTask;
  /** Like run, but returns null instead of refusing: for continuations whose caller cannot propagate the refusal. */
  tryRun(name: string, work: (signal: AbortSignal) => Promise<unknown>): BackgroundTask | null;
  /** A timer-started task: the timer is owned (cleared at quiesce) and its callback runs as an owned task. */
  schedule(name: string, delayMs: number, work: (signal: AbortSignal) => Promise<unknown>): () => void;
  /** A repeating owned timer; each tick runs as an owned task unless the previous tick is still running. */
  every(name: string, intervalMs: number, work: (signal: AbortSignal) => Promise<unknown>): () => void;
}
export interface BackgroundWorkControl {
  readonly work: BackgroundWork;
  /** No new tasks or timers; started tasks see the abort signal. Idempotent. */
  quiesce(): void;
  /** The number of started tasks not yet settled. */
  live(): number;
  /** Resolves once every started task settled (at once when none is live); never rejects. */
  drained(): Promise<void>;
  /** Scalars only: for the launcher's one accounting line when a bound was exceeded. */
  accounting(): { started: number; settled: number; refused: number; live: string[] };
}

export function createBackgroundWorkRegistry(): BackgroundWorkControl {
  const latch = new AbortController();
  const tasks = new Map<Promise<void>, string>();
  const timers = new Set<NodeJS.Timeout>();
  const waiting: (() => void)[] = [];
  let started = 0, settled = 0, refused = 0, quiesced = false;
  const wake = () => { if (tasks.size === 0) for (const resolve of waiting.splice(0)) resolve(); };
  function start(name: string, body: (signal: AbortSignal) => Promise<unknown>): BackgroundTask | null {
    if (quiesced) { refused++; return null; }
    started++;
    // The lease exists before the first await of the task; a synchronous throw settles it as well.
    const promise: Promise<void> = Promise.resolve().then(() => body(latch.signal)).then(() => undefined, () => undefined)
      .finally(() => { tasks.delete(promise); settled++; wake(); });
    tasks.set(promise, name);
    return Object.freeze({ name, settled: promise });
  }
  const work: BackgroundWork = Object.freeze({
    get signal() { return latch.signal; },
    get quiesced() { return quiesced; },
    run(name, body) { return start(name, body) ?? refuse('EmrBackgroundQuiesced'); },
    tryRun(name, body) { return start(name, body); },
    schedule(name, delayMs, body) {
      if (quiesced) { refused++; return () => undefined; }
      const timer = setTimeout(() => { timers.delete(timer); start(name, body); }, delayMs);
      timer.unref();
      timers.add(timer);
      return () => { clearTimeout(timer); timers.delete(timer); };
    },
    every(name, intervalMs, body) {
      if (quiesced) { refused++; return () => undefined; }
      let running: BackgroundTask | null = null;
      const timer = setInterval(() => {
        if (running) return;
        running = start(name, async signal => { try { await body(signal); } finally { running = null; } });
      }, intervalMs);
      timer.unref();
      timers.add(timer);
      return () => { clearInterval(timer); timers.delete(timer); };
    },
  });
  return Object.freeze({
    work,
    quiesce() {
      if (quiesced) return;
      quiesced = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      latch.abort(new Error('EmrBackgroundQuiesced'));
    },
    live() { return tasks.size; },
    drained(): Promise<void> { return tasks.size === 0 ? Promise.resolve() : new Promise<void>(resolve => waiting.push(() => resolve())); },
    accounting() { return { started, settled, refused, live: [...tasks.values()] }; },
  });
}

/** The Nest token under which the launcher provides the registry's work handle to actual providers (AppModule.forLaunch). */
export const EMR_BACKGROUND_WORK: unique symbol = Symbol('EmrBackgroundWork');
