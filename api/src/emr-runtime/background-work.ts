import { refuse } from '../emr-contract/validation';

/** Tracks provider work that can outlive an HTTP request. Quiesce cancels
 * pending I/O and prevents new jobs; the runtime drains existing jobs before
 * disconnecting. This registry stores no ledger state. */
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

/**
 * The delay before retry `attempt` (1-based) of background work that waits on a dependency to come back: 1 s doubling
 * to a 30 s cap. Chosen for the member-rights import after hosted CI run 37564131708 (Keycloak still starting, S7-U5
 * round 4): an outage of seconds costs one quick retry and a long one a retry every 30 s, never a tight loop.
 */
export function backgroundRetryDelayMs(attempt: number): number {
  return Math.min(30000, 1000 * 2 ** Math.min(Math.max(attempt, 1) - 1, 5));
}

/** The runtime supplies the same work registry to its Nest providers. */
export const EMR_BACKGROUND_WORK: unique symbol = Symbol('EmrBackgroundWork');
