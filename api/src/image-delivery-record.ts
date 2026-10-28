/*
 * MG-08 (D1877(2), 2026-10-27): the 열람 record of the image bytes the API serves. 의료법 제23조④ asks for a record of
 * every access to the electronic record; D1877 fixed its grain for images at one pair of access events per study
 * delivery - `provide-prepared` before the first byte, `transfer-ended`/`transfer-aborted` when the delivery ends - not
 * one per image request (a worklist preview strip or one viewer opening is tens to thousands of requests). A delivery is
 * the stream of image reads of one study by one member session for one use (`DeliveryUse`: a viewer's opening, the memory
 * preload, other fetches); it closes after an idle gap without a read, and the next read opens a new pair. No image byte leaves before the `provide-prepared` event is durable in the access ledger; a
 * ledger that cannot record answers 503 with no image byte.
 *
 * An opening is not a delivery (opening contract consult-preload-opening-contract-20261029, D1880 "each open still
 * records 열람"). The viewer names each new entry into a study - a new document, a reload, a patient tab entered again,
 * a back/forward return - with its own opening ID (`X-KIN-View-Opening`); the idle gap or the read's `view` marker never
 * stood for that. Each opening has exactly one root: the first committed `user-view` provide-prepared of the opening.
 * The idle gap retires the delivery, not the opening, so a later read of the same opening is a delivery of its own whose
 * `background-fetch` provide-prepared refers to that root - one root per opening, one pair per delivery. The root's
 * ledger operation is derived from the opening, so the ledger itself, not this process's memory, says whether the root
 * exists: a delivery after the gap, a retry after a lost COMMIT reply, or a restart never adds a second root.
 *
 * The event is the formatVersion 1 image event the images/dicom-web delivery writes (emr-image/service.ts), through the
 * same record port: the study is its target (recordId = study UID, as that delivery names its study-level units) and the
 * archive's own revision of the study is its version. Identity, institution, StudyAccess and the patient link come from
 * the current clinical context (emr-clinical/startup.ts), read on the ledger transaction as every other access record's
 * are; nothing the browser sends is a fact here. Admission (institution, StudyAccess, split UID) is the caller's DICOMweb
 * gate and runs before this recorder. This recorder is route-neutral: every API image route takes its lease here, so the
 * reads of one opening across routes share one pair.
 *
 * A terminal the ledger cannot take at that moment keeps its identity and operation and is offered again until it is
 * durable or the process stops; it is never dropped for being late (MG-09). The stop refuses new deliveries from its
 * first moment, reserves the ledger work of every terminal it still owes before record admission closes, and keeps that
 * work until its own last offer is over - so a delivery whose preparation or terminal is in flight when the process
 * stops still gets one more offer, also after an offer that ran on the reservation failed.
 */
import { HttpException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AccessEventV1 } from './emr-contract/access-event';
import { newAuditLinkId, parseAccessEvent } from './emr-contract/access-event';
import type { ClinicalContextSource } from './emr-clinical/runtime';
import { CURRENT_CLINICAL_CONTEXT } from './emr-clinical/startup';
import { EMR_BACKGROUND_WORK, backgroundRetryDelayMs } from './emr-runtime/background-work';
import type { BackgroundWork } from './emr-runtime/background-work';
import { isDurableReceipt } from './emr-runtime/contract';
import { EMR_RECORD_PORT } from './emr-runtime/record-port';
import type { EmrRecordPort, EmrRecordWork } from './emr-runtime/record-port';
import { REQUEST_CONTEXT_SOURCE, RequestContextUnavailable } from './emr-runtime/request-context';
import type { RequestContextSource } from './emr-runtime/request-context';
import { OrthancService } from './orthanc.service';

export const IMAGE_DELIVERY_IDLE_MS = Symbol('ImageDeliveryIdleMs');
/**
 * A delivery closes after this long without a read of the study. Sized to the slowest measured opening - the eight-pane
 * current-vs-prior layout took 60-80 s to load on the 2-vCPU demo VM (MG-LOADING) - with margin, so one opening is one
 * pair rather than several. Re-check before a larger site (D1804 first-site defaults).
 */
export const DEFAULT_IMAGE_DELIVERY_IDLE_MS = 120_000;
export const IMAGE_DELIVERY_UNAVAILABLE = Object.freeze({ code: 'IMAGE_DELIVERY_RECORD_UNAVAILABLE',
  message: '영상 열람 기록을 저장하지 못해 영상을 보낼 수 없습니다. 잠시 후 다시 시도하세요.' });
const CONTEXT_UNAVAILABLE = Object.freeze({ code: 'ImageRequestContextUnavailable', message: '영상의 현재 접근 권한을 확인할 수 없습니다' });

/**
 * Held by one image response of a delivery. `served` is true only for a response that sent its image completely with a
 * success status; an error answer, a relay failure or a response cut short is not a served image (MG-10).
 */
export interface DeliveryLease { release(served: boolean): void }

/**
 * What a read is for, which decides the delivery it joins. `view`: the viewer reads it to show the study for the opening
 * it names; the reads of one opening share its delivery, and another opening - also by the same session, inside the
 * idle gap - never joins it. `preload`: the worklist's memory preload reads it ahead of any opening; a preload that is
 * never opened is a transfer, not an opening (D1880). `fetch`: any other image read (worklist thumbnails, report and
 * print reads); a background-fetch delivery of its own, never part of an opening because one happens to be open.
 */
export type DeliveryUse = { kind: 'view'; opening: string } | { kind: 'preload' } | { kind: 'fetch' };
export const PRELOAD_USE: DeliveryUse = Object.freeze({ kind: 'preload' });
export const FETCH_USE: DeliveryUse = Object.freeze({ kind: 'fetch' });

/**
 * The header with which the viewer names the opening its image read belongs to (viewer-preload.js). The value is an
 * opaque correlation the viewer keeps in its document's memory: it separates one entry from the next, it is no
 * credential and no fact about the reader - identity, session, institution and access are the server's own.
 */
export const VIEW_OPENING_HEADER = 'X-KIN-View-Opening';
const OPENING_ID = /^[A-Za-z0-9-]{8,64}$/;
export function readUse(request: IncomingMessage): DeliveryUse {
  const opening = String(request.headers?.['x-kin-view-opening'] ?? '').trim();
  return OPENING_ID.test(opening) ? { kind: 'view', opening } : FETCH_USE;
}

/**
 * The ledger operation of an opening's root, attempt `attempt`. Derived from the opening (member, session, study,
 * opening ID), so whether the root exists is the ledger's answer - after the opening's delivery closed, after a lost
 * COMMIT reply, after a restart. The ledger binds one event to one operation and keeps a negative outcome final, so an
 * attempt the ledger settled negative is offered again as the next attempt.
 */
function rootOperation(opening: string, attempt: number): string {
  const h = createHash('sha256').update(`kin-image-opening-root\n${opening}\n${attempt}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 + (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface Delivery {
  key: string; studyUid: string; use: DeliveryUse;
  /** Resolves once the provide-prepared event is durable; rejects when it could not be recorded. */
  prepared: Promise<Readonly<AccessEventV1>>;
  event: Readonly<AccessEventV1> | null;
  inflight: number; served: number; unserved: number;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  /** The closing event and its ledger operation, fixed once built: every offer is the ledger's exact retry. */
  terminal: { event: Readonly<AccessEventV1>; operationId: string } | null;
  attempts: number;
  recording: Promise<void> | null;
  cancelRetry: (() => void) | null;
  /**
   * Ledger work the stop admitted for this delivery's terminal while admission was still open. It stays the
   * delivery's through every offer of the stop - an offer that fails on it does not end it - and the stop ends it once,
   * after its last offer.
   */
  reserved: EmrRecordWork | null;
}

const known = <T>(value: T) => ({ status: 'known' as const, value });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

@Injectable()
export class StudyImageDeliveryRecorder implements OnModuleDestroy, BeforeApplicationShutdown {
  private readonly logger = new Logger('ImageDelivery');
  private readonly open = new Map<string, Delivery>();
  /** Closed deliveries whose terminal the ledger has not durably taken yet. Never reported as recorded. */
  private readonly closing = new Set<Delivery>();
  private stopping = false;
  private shutdown: Promise<void> | null = null;
  private readonly idleMs: number;

  constructor(@Inject(EMR_RECORD_PORT) private readonly records: EmrRecordPort,
    @Inject(REQUEST_CONTEXT_SOURCE) private readonly requests: RequestContextSource,
    @Inject(CURRENT_CLINICAL_CONTEXT) private readonly clinical: ClinicalContextSource,
    @Inject(EMR_BACKGROUND_WORK) private readonly background: BackgroundWork,
    private readonly orthanc: OrthancService,
    @Optional() @Inject(IMAGE_DELIVERY_IDLE_MS) idleMs?: number) {
    this.idleMs = typeof idleMs === 'number' && idleMs > 0 ? idleMs : DEFAULT_IMAGE_DELIVERY_IDLE_MS;
  }

  /**
   * The delivery this request belongs to, with its provide-prepared event durable. The first request of a member
   * session for a study and use - for a viewer's read, its opening - records the event; the requests that arrive while
   * it is being recorded wait for the same receipt; later ones find the open delivery. Resolves only after the receipt -
   * the caller sends no byte before.
   */
  async admit(request: IncomingMessage, surface: string, studyUid: string, use: DeliveryUse = FETCH_USE): Promise<DeliveryLease> {
    let delivery: Delivery;
    try {
      // Another provider's shutdown may still be running while the port admits work; a read let in now would open a
      // delivery the stop has already passed over, a pair without its end. No pair, so no byte.
      if (this.stopping) throw new ServiceUnavailableException(IMAGE_DELIVERY_UNAVAILABLE);
      const snapshot = this.requests.read(request);
      const key = JSON.stringify([snapshot.issuer, snapshot.subject, snapshot.binding.sessionRef, studyUid, use.kind,
        use.kind === 'view' ? use.opening : null]);
      delivery = this.open.get(key) ?? this.start(key, use, request, surface, studyUid);
    } catch (error) { throw this.unavailable(error); }
    if (delivery.timer) { clearTimeout(delivery.timer); delivery.timer = null; }
    delivery.inflight++;
    try { await delivery.prepared; }
    catch (error) {
      delivery.inflight--;
      throw this.unavailable(error);
    }
    let released = false;
    return { release: served => {
      if (released) return;
      released = true;
      delivery.inflight--;
      if (served) delivery.served++; else delivery.unserved++;
      this.settle(delivery);
    } };
  }

  private start(key: string, use: DeliveryUse, request: IncomingMessage, surface: string, studyUid: string): Delivery {
    const delivery: Delivery = { key, studyUid, use, prepared: null as any, event: null, inflight: 0, served: 0, unserved: 0,
      timer: null, closed: false, terminal: null, attempts: 0, recording: null, cancelRetry: null, reserved: null };
    delivery.prepared = this.prepare(request, surface, studyUid, use, key).then(event => { delivery.event = event; return event; });
    // A delivery that could not be recorded is no delivery: the next read asks the ledger again.
    delivery.prepared.catch(() => { if (this.open.get(key) === delivery) this.open.delete(key); });
    this.open.set(key, delivery);
    return delivery;
  }

  private async prepare(request: IncomingMessage, surface: string, studyUid: string, use: DeliveryUse, key: string): Promise<Readonly<AccessEventV1>> {
    const work = this.records.begin();
    try {
      const at = new Date().toISOString();
      // Current identity, institution, StudyAccess and the study's patient are read on the ledger's transaction, as the
      // images/dicom-web delivery reads them (ProductionImageContext.current); a study the member may not see is refused
      // here with the same answer the clinical routes give.
      const { facts, study } = await work.transactionWithRecords(async tx => ({
        facts: await this.clinical.facts(tx, request), study: await this.clinical.study(tx, request, studyUid) }));
      if (facts.actor.kind !== 'member') throw new ServiceUnavailableException(CONTEXT_UNAVAILABLE);
      const revision = await this.orthanc.studyRevision(studyUid);
      const event = (opening: boolean, root: string | null) => parseAccessEvent({ formatVersion: 1, surface, eventId: randomUUID(),
        userId: known(facts.actor.identity), rolesAtTime: known(facts.actor.roles), actingInstitution: known(facts.actor.institutionId),
        managingInstitution: known(study.managingInstitutionId), occurredAt: at, trustedProxyIp: facts.ip,
        // The opening's root is the 열람 of the study (D1880: recorded when the study is opened, also when its bytes then
        // come from the preload memory); it is opened from the reading worklist. Every other delivery - a later one of the
        // same opening, worklist thumbnails, report reads, the memory preload - is recorded as the fetch it is (as
        // images/dicom-web records its deliveries), a later one of an opening referring to the opening's root.
        ...(opening
          ? { cause: 'user-view', context: { basis: 'worklist', studyId: studyUid, relatedStudyId: null, reason: null } }
          : { cause: 'background-fetch', context: { basis: 'background-fetch', studyId: studyUid, relatedStudyId: null, reason: null } }),
        executor: 'member', targets: [{ kind: 'image', patientLinkSnapshot: known(study.patient), studyId: known(studyUid),
          recordId: known(studyUid), versionId: known(`orthanc-study:${revision.id}@${revision.lastUpdate}`) }],
        action: 'provide-prepared', result: 'prepared', requestId: facts.requestId, auditLinkId: newAuditLinkId(), relatedEventId: root }) as Readonly<AccessEventV1>;
      if (use.kind !== 'view') {
        const prepared = event(false, null);
        await this.append(work, prepared, randomUUID());
        return prepared;
      }
      for (let attempt = 0; ; attempt++) {
        const operationId = rootOperation(key, attempt);
        const stored = await work.lookup(operationId);
        if (!stored) {
          const root = event(true, null);
          await this.append(work, root, operationId);
          return root;
        }
        if (stored.outcome === 'committed') {
          const continued = event(false, stored.eventId);
          await this.append(work, continued, randomUUID());
          return continued;
        }
        // Not settled yet (an offer whose outcome the ledger has not decided): nothing is shown before it is.
        if (stored.outcome !== 'negative') throw new Error('ImageOpeningRootUnsettled');
      }
    } finally { work.end(); }
  }

  /**
   * A1's append discipline with a caller-fixed operation: a lost COMMIT reply is resolved only through that operation's
   * stored result. Offering the same event under the same operation again is the ledger's exact retry (one operation per
   * event ID), so a terminal can be offered until it is taken without ever becoming two records.
   */
  private async append(work: EmrRecordWork, event: Readonly<AccessEventV1>, operationId: string): Promise<void> {
    let receipt: unknown;
    try { receipt = await work.append(event, undefined, { operationId, attemptId: randomUUID() }); }
    catch (error) {
      const result = await work.lookup(operationId);
      if (!result || result.outcome !== 'committed' || result.eventId !== event.eventId) throw error;
      receipt = await work.confirm({ provisional: true, operationId, eventId: event.eventId });
    }
    if (!isDurableReceipt(receipt) || receipt.eventId !== event.eventId) throw new Error('ImageDeliveryReceiptRefused');
  }

  private unavailable(error: unknown): Error {
    // The gate's own refusals keep their answer; a request without a captured admission or a ledger that cannot
    // record is the viewing 503, never a body.
    if (error instanceof HttpException) return error;
    if (error instanceof RequestContextUnavailable) return new ServiceUnavailableException(CONTEXT_UNAVAILABLE);
    this.logger.warn('image_delivery category=record_failed ' + message(error));
    return new ServiceUnavailableException(IMAGE_DELIVERY_UNAVAILABLE);
  }

  /** Nothing in flight: the delivery ends after the idle gap unless another read of the study arrives first. */
  private settle(delivery: Delivery): void {
    if (delivery.closed || delivery.inflight > 0 || delivery.timer) return;
    delivery.timer = setTimeout(() => { delivery.timer = null; void this.close(delivery); }, this.idleMs);
    delivery.timer.unref?.();
  }

  /**
   * Ends the delivery. A prepared one gets its terminal at once - before any await, so a stop that begins afterwards
   * finds it owed; only the stop closes a delivery still being prepared, and that one is closed when its preparation
   * succeeds. A delivery whose preparation never succeeded has no event to close.
   */
  private close(delivery: Delivery): Promise<void> {
    if (delivery.closed) return Promise.resolve();
    delivery.closed = true;
    if (delivery.timer) { clearTimeout(delivery.timer); delivery.timer = null; }
    if (this.open.get(delivery.key) === delivery) this.open.delete(delivery.key);
    if (delivery.event) return this.finish(delivery, delivery.event);
    return delivery.prepared.then(event => this.finish(delivery, event), () => undefined);
  }

  /**
   * The terminal event of the pair, built once. `transfer-ended` only when at least one response of the delivery sent
   * its image completely and none is still sending; a delivery whose every response failed, was refused by the source or
   * was cut short, or that the stop closes while a response is still being sent, is `transfer-aborted` (MG-10). The
   * event's time is the close, not the append that eventually holds it.
   */
  private finish(delivery: Delivery, prepared: Readonly<AccessEventV1>): Promise<void> {
    const ended = delivery.inflight === 0 && delivery.served > 0;
    delivery.terminal = { operationId: randomUUID(),
      event: parseAccessEvent({ ...prepared, eventId: randomUUID(), occurredAt: new Date().toISOString(),
        action: ended ? 'transfer-ended' : 'transfer-aborted', result: ended ? 'succeeded' : 'aborted',
        relatedEventId: prepared.eventId }) as Readonly<AccessEventV1> };
    this.closing.add(delivery);
    return this.record(delivery);
  }

  /**
   * One offer at a time of the retained terminal. A failed offer is journalled by the store under the event ID
   * (ledger-unreachable/refused, commit-unknown) and the terminal is offered again later; at shutdown the next offer is
   * the stop's own.
   */
  private record(delivery: Delivery): Promise<void> {
    if (delivery.recording) return delivery.recording;
    if (delivery.cancelRetry) { delivery.cancelRetry(); delivery.cancelRetry = null; }
    const terminal = delivery.terminal!;
    const attempt = async () => {
      // Work the stop reserved is used first: it was admitted while admission was open and the port keeps admitted work
      // through its close. It is not ended here - after admission closed nothing could replace it for the stop's last
      // offer; the stop ends it. Work taken here, before the first await, is this offer's alone and ends with it.
      const reserved = delivery.reserved;
      let work: EmrRecordWork;
      if (reserved) work = reserved;
      else {
        try { work = this.records.begin(); }
        catch (error) { this.defer(delivery, error); return; }
      }
      try {
        await this.append(work, terminal.event, terminal.operationId);
        this.closing.delete(delivery);
        this.logger.log(`image_delivery outcome=${terminal.event.action === 'transfer-ended' ? 'ended' : 'aborted'} ` +
          `served=${delivery.served} unserved=${delivery.unserved} attempts=${delivery.attempts + 1}`);
      } catch (error) { this.defer(delivery, error); }
      finally { if (!reserved) work.end(); }
    };
    delivery.recording = attempt().finally(() => { delivery.recording = null; });
    return delivery.recording;
  }

  private defer(delivery: Delivery, error: unknown): void {
    delivery.attempts++;
    const { event } = delivery.terminal!;
    if (this.stopping || this.background.quiesced) {
      // No timer once the process stops: the stop's own last offer follows, and what it could not record is reported
      // there - this line names one offer, not the pair's fate.
      this.logger.warn(`image_delivery category=terminal_attempt_failed_at_shutdown event=${event.eventId} ` +
        `prepared=${event.relatedEventId} attempt=${delivery.attempts} ${message(error)}`);
      return;
    }
    // The API's schedule for background work waiting on a dependency to return (emr-runtime/background-work.ts).
    const delay = backgroundRetryDelayMs(delivery.attempts);
    this.logger.error(`image_delivery category=terminal_unsettled event=${event.eventId} prepared=${event.relatedEventId} ` +
      `attempt=${delivery.attempts} retry_ms=${delay} ${message(error)}`);
    delivery.cancelRetry = this.background.schedule('image-delivery.terminal', delay, () => this.record(delivery));
  }

  /**
   * Every open delivery ends with the process (one still sending is aborted, a quiet one closes by what it served), and
   * every terminal still owed gets one more offer; one that still fails is logged with its event IDs and stays in the
   * store's failure journal - the stop does not report it as a complete pair.
   *
   * Nest awaits every onModuleDestroy before any beforeApplicationShutdown, where EmrNestLifecycle closes record
   * admission. So admission to this recorder closes here, synchronously, and the ledger work of every terminal the stop
   * may owe - open deliveries, prepared or still being prepared, and closed ones not durable yet - is admitted before
   * the first await. The port keeps admitted work through its close and the runtime's drain waits for it. Each
   * reservation is ended once, after the stop's last offer, whether that offer used it, an earlier one failed on it, or
   * the delivery turned out to owe nothing.
   */
  onModuleDestroy(): void {
    this.stopping = true;
    this.shutdown ??= this.stop();
  }

  private stop(): Promise<void> {
    const opened = [...this.open.values()];
    const owed = new Set<Delivery>([...opened, ...this.closing]);
    for (const delivery of owed) {
      // The stop makes the next offer itself; a pending retry timer would only race it.
      if (delivery.cancelRetry) { delivery.cancelRetry(); delivery.cancelRetry = null; }
      try { delivery.reserved = this.records.begin(); }
      catch (error) { this.logger.warn(`image_delivery category=terminal_work_not_reserved_at_shutdown study=${delivery.studyUid} ${message(error)}`); }
    }
    const closed = opened.map(delivery => this.close(delivery));
    return (async () => {
      await Promise.allSettled(closed);
      // An offer already in flight when the stop began settles first; whatever is still owed is offered once more.
      await Promise.allSettled([...this.closing].map(delivery => delivery.recording ?? Promise.resolve()));
      await Promise.allSettled([...this.closing].map(delivery => this.record(delivery)));
      for (const delivery of owed) if (delivery.reserved) { delivery.reserved.end(); delivery.reserved = null; }
      for (const delivery of this.closing) {
        const { event } = delivery.terminal!;
        this.logger.error(`image_delivery category=terminal_not_recorded_at_shutdown event=${event.eventId} ` +
          `prepared=${event.relatedEventId} attempts=${delivery.attempts}`);
      }
    })();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.onModuleDestroy();
    await this.shutdown;
  }
}
