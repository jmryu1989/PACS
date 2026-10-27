import type { AccessEvent, DurableAccessReceipt } from '../emr-contract/access-event';
import { refuse } from '../emr-contract/validation';
import type { BackgroundWork } from '../emr-runtime/background-work';
import type { PreparedDelivery } from './contract';
import type { UnstoredObservation } from './stream';

/**
 * A study delivery is one access record for one requester's continuous viewing of one study manifest version.
 *
 * 의료법 제23조④ requires a separate 접속기록 when an electronic medical record is 열람된 (viewed): the article names the
 * record and the act, not a transport unit, and 시행규칙 제16조② (this snapshot) details only 추가기재·수정 records. The
 * viewer fetches one study as hundreds of frame responses within seconds. Recording every HTTP response as its own B2
 * access event (admission, append and terminal event per frame) held the ledger's four append lanes about 230 ms per
 * frame (run e-route-diag2-opus-20261026a) and a 200-slice CT took about twice the direct load time (R244-02). Here the
 * record is the delivery: B2 holds one provide-prepared event for the study, durable before any response's first byte,
 * and one terminal event when the delivery closes; each response keeps its exact representation, transport and copy
 * facts in E's own tables, naming that event. No fact is dropped: who, when, from where, which patient and study at
 * which manifest version, what was done, and per response what was sent and whether it ended. A row the store refused
 * on a response's own path is kept by the delivery and written on the delivery's ledger transaction when it closes,
 * before the terminal event, so the terminal event is appended only with every response's facts retained.
 *
 * The key is the requester's identity, rights, session, address and the manifest digest, so a changed account, another
 * session or another manifest version is another record. A delivery closes after a short idle period, after a bounded
 * age, at shutdown, and when a response finds the current facts changed. Every response still checks the requester's
 * current access on a bounded transaction before its first byte (the application connection: a response appends
 * nothing, and the ledger's lanes bound append work, service.ts); only the record it is written under is shared.
 */
export interface OpenedDelivery<T> {
  event: Readonly<AccessEvent>; receipt: DurableAccessReceipt; prepared: PreparedDelivery; facts: T;
}
export type ResponseEnd = 'transfer-ended' | 'transfer-aborted' | 'transfer-unknown' | 'not-sent';
export interface DeliveryOutcome {
  responses: number; ended: number; aborted: number; unknown: number; notSent: number; bytesWritten: number;
  /** Rows of this delivery's responses that the store refused; the close hook retains them with the terminal event. */
  unstored: readonly UnstoredObservation[];
  openedAt: string; closedAt: string;
}
export type DeliveryClosing = 'transfer-ended' | 'transfer-aborted' | null;
export interface DeliveryLease<T> {
  readonly delivery: OpenedDelivery<T>;
  /** This response is over: what E observed on its own connection, how many body bytes it wrote, and which of its
   * rows the store refused (kept until the delivery closes). */
  end(terminal: ResponseEnd, bytesWritten: number, unstored?: readonly UnstoredObservation[]): void;
  /** The current facts no longer match this record: no later response joins it; it closes once its responses end. */
  retire(): void;
}
export interface DeliveryHooks<T, R> {
  /** The study's provide-prepared event, durable (B2 receipt) before the first response of this delivery is prepared. */
  open(key: string, opener: R): Promise<OpenedDelivery<T>>;
  /** The delivery's terminal event (null: no v1 access action describes it; E's rows hold the facts), and the retention
   * of the outcome's unstored rows. */
  close(delivery: OpenedDelivery<T>, outcome: DeliveryOutcome, closing: DeliveryClosing): Promise<void>;
}
/** idle: the pause after which a viewing is over. In the served run e-route-diag-fable-20261027a (synthetic 200-slice
 * CT, 405 responses, five records) the largest gap between consecutive frame requests inside one viewer opening was
 * 0.68 s (p99 0.44 s, median 14 ms) and separate openings were 6 s or more apart; the GET and HEAD of one request pair
 * were 2.1 s apart and are one viewing (tests/e2e/test_image_route.py route_01). 3 s sits above the first and below the
 * second. maxAge: a bound on how long one pre-read authorization covers source reads; the longest opening observed in
 * those runs took 19.4 s (e-route-before-fable-20261027a), so 60 s re-reads the current study about three times less
 * often than a viewing lasts. Neither is a user or Minhoon decision; a first-site observation replaces them. */
export const DELIVERY_IDLE_MS = 3000;
export const DELIVERY_MAX_AGE_MS = 60000;

/** The terminal event of a delivery, from what E observed. An unconfirmed ending has no v1 access action (as for a
 * single response): the ledger then holds the prepared record and E's rows hold the observations. A delivery without a
 * completed transfer is aborted, not ended. */
export function deliveryClosing(outcome: Pick<DeliveryOutcome, 'ended' | 'aborted' | 'unknown'>): DeliveryClosing {
  if (outcome.aborted > 0) return 'transfer-aborted';
  if (outcome.unknown > 0) return null;
  return outcome.ended > 0 ? 'transfer-ended' : 'transfer-aborted';
}

interface Entry<T> {
  key: string; delivery: OpenedDelivery<T>; openedMs: number; openedAt: string;
  state: 'open' | 'retiring' | 'closing' | 'closed'; inFlight: number;
  tally: { responses: number; ended: number; aborted: number; unknown: number; notSent: number; bytesWritten: number; unstored: UnstoredObservation[] };
  cancelIdle: () => void; closed: Promise<void> | null;
}

export class ImageDeliveries<T, R> {
  private readonly current = new Map<string, Entry<T>>();
  private readonly opening = new Map<string, Promise<Entry<T>>>();
  private readonly live = new Set<Entry<T>>();
  private stopping = false;

  constructor(private readonly background: BackgroundWork, private readonly hooks: DeliveryHooks<T, R>,
    private readonly limits = { idleMs: DELIVERY_IDLE_MS, maxAgeMs: DELIVERY_MAX_AGE_MS }) {}

  /** The open delivery of `key`, or a new one opened with this request's own facts. An opening another request
   * started is joined; if it fails for that requester (aborted, refused) this request opens its own. */
  async join(key: string, opener: R, signal: AbortSignal): Promise<DeliveryLease<T>> {
    if (this.stopping) refuse('ImageDeliveryStopping');
    let entry: Entry<T> | undefined, joined: Promise<Entry<T>> | undefined;
    // A delivery can close between its lookup and this request's lease (its idle timer fired meanwhile): then look again.
    for (let attempt = 0; attempt < 4 && !entry; attempt++) {
      const kept = this.current.get(key);
      if (kept && (kept.state !== 'open' || Date.now() - kept.openedMs > this.limits.maxAgeMs)) this.retire(kept);
      else if (kept) { entry = kept; break; }
      const pending = this.opening.get(key);
      if (pending && pending !== joined) {
        joined = pending;
        try {
          const opened = await abortable(pending, signal);
          if (opened.state === 'open') entry = opened;
          continue;
        } catch (error) {
          if (signal.aborted) throw error;
        }
      }
      signal.throwIfAborted();
      const run = this.hooks.open(key, opener).then(delivery => this.admit(key, delivery));
      this.opening.set(key, run);
      try { entry = await run; }
      finally { if (this.opening.get(key) === run) this.opening.delete(key); }
      if (entry.state !== 'open') entry = undefined;
    }
    if (!entry) refuse('ImageDeliveryUnavailable');
    entry.inFlight++;
    entry.cancelIdle();
    let ended = false;
    const target = entry;
    return {
      delivery: target.delivery,
      end: (terminal, bytesWritten, unstored = []) => {
        if (ended) return;
        ended = true;
        const t = target.tally;
        t.responses++; t.bytesWritten += bytesWritten; t.unstored.push(...unstored);
        if (terminal === 'transfer-ended') t.ended++; else if (terminal === 'transfer-aborted') t.aborted++;
        else if (terminal === 'transfer-unknown') t.unknown++; else t.notSent++;
        target.inFlight--;
        if (target.inFlight > 0) return;
        if (target.state !== 'open' || this.stopping || this.background.quiesced) void this.close(target);
        else target.cancelIdle = this.background.schedule('emr-image-delivery-close', this.limits.idleMs, () => this.close(target));
      },
      retire: () => this.retire(target),
    };
  }

  /** At shutdown: close every idle delivery now; one with responses in flight closes when they end. */
  async closeAll(): Promise<void> {
    this.stopping = true;
    const closing: Promise<void>[] = [];
    for (const entry of [...this.live]) {
      entry.cancelIdle();
      if (entry.inFlight === 0) closing.push(this.close(entry));
    }
    await Promise.all(closing);
  }

  private admit(key: string, delivery: OpenedDelivery<T>): Entry<T> {
    const entry: Entry<T> = { key, delivery, openedMs: Date.now(), openedAt: new Date().toISOString(), state: 'open', inFlight: 0,
      tally: { responses: 0, ended: 0, aborted: 0, unknown: 0, notSent: 0, bytesWritten: 0, unstored: [] }, cancelIdle: () => undefined, closed: null };
    const previous = this.current.get(key);
    if (previous) this.retire(previous);
    this.current.set(key, entry);
    this.live.add(entry);
    return entry;
  }

  private retire(entry: Entry<T>): void {
    if (this.current.get(entry.key) === entry) this.current.delete(entry.key);
    if (entry.state !== 'open') return;
    entry.state = 'retiring';
    entry.cancelIdle();
    if (entry.inFlight === 0) void this.close(entry);
  }

  private close(entry: Entry<T>): Promise<void> {
    if (entry.closed) return entry.closed;
    if (this.current.get(entry.key) === entry) this.current.delete(entry.key);
    entry.state = 'closing';
    entry.cancelIdle();
    const outcome: DeliveryOutcome = { ...entry.tally, openedAt: entry.openedAt, closedAt: new Date().toISOString() };
    entry.closed = this.hooks.close(entry.delivery, outcome, deliveryClosing(outcome))
      .catch(error => { console.error('[EMR-E] image delivery close failed', error?.code ?? error?.message ?? error); })
      .finally(() => { entry.state = 'closed'; this.live.delete(entry); });
    return entry.closed;
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    promise.then(value => { signal.removeEventListener('abort', stop); resolve(value); },
      error => { signal.removeEventListener('abort', stop); reject(error); });
  });
}
