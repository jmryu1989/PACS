/*
 * MG-08 (D1877(2), 2026-10-27): the 열람 record of the viewer's image reads that nginx routes to the API's range reader
 * (dicom-frame.controller.ts). 의료법 제23조④ asks for a record of every access to the electronic record; D1877 fixed its
 * grain for images at one pair of access events per study delivery - `provide-prepared` before the first byte,
 * `transfer-ended`/`transfer-aborted` when the delivery ends - not one per frame (one DBT reading is thousands of frame
 * requests). A delivery is the stream of frame and preview reads of one study by one member session; it closes after
 * an idle gap without a read, and the next read opens a new pair. No frame or preview byte leaves before the
 * `provide-prepared` event is durable in the access ledger; a ledger that cannot record answers 503 with no body.
 * The terminal is the honest aggregate of the delivery's responses: `transfer-ended` only when at least one image
 * response was sent to its end, `transfer-aborted` when none was (every read failed or was cut) or the process stops
 * while one is still being sent (review MG-10). A terminal the ledger cannot take at that moment keeps its identity
 * and is retried until it is durable or the process stops; it is never dropped for being late (review MG-09). The
 * stop reserves the ledger work of every terminal it still owes before record admission closes and keeps it until its
 * own last attempt is over, so a delivery whose preparation or last retry is in flight when the process stops still
 * completes its pair, also when the attempt that runs on the reservation first fails (review MG-09, rounds 4-5).
 *
 * The event is the formatVersion 1 image event the images/dicom-web delivery writes (emr-image/service.ts), through the
 * same record port: the study is its target (recordId = study UID, as that delivery names its study-level units) and the
 * archive's own revision of the study is its version. Identity, institution, StudyAccess and the patient link come from
 * the current clinical context (emr-clinical/startup.ts), read on the ledger transaction as every other access record's
 * are; nothing the browser sends is a fact here. The admission itself (institution, StudyAccess, split UID) is the
 * controller's DICOMweb gate and runs before this recorder.
 */
import { HttpException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AccessEventV1 } from './emr-contract/access-event';
import { newAuditLinkId, parseAccessEvent } from './emr-contract/access-event';
import type { ClinicalContextSource } from './emr-clinical/runtime';
import { CURRENT_CLINICAL_CONTEXT } from './emr-clinical/startup';
import { isDurableReceipt } from './emr-runtime/contract';
import { EMR_BACKGROUND_WORK } from './emr-runtime/background-work';
import type { BackgroundWork } from './emr-runtime/background-work';
import { EMR_RECORD_PORT } from './emr-runtime/record-port';
import type { EmrRecordPort, EmrRecordWork } from './emr-runtime/record-port';
import { REQUEST_CONTEXT_SOURCE, RequestContextUnavailable } from './emr-runtime/request-context';
import type { RequestContextSource } from './emr-runtime/request-context';
import { OrthancService } from './orthanc.service';

export const FRAMES_SURFACE = 'GET dicom-web/studies/:study/series/:series/instances/:sop/frames/:frames';
export const PREVIEW_SURFACE = 'GET instances/:id/preview';
export const IMAGE_DELIVERY_IDLE_MS = Symbol('ImageDeliveryIdleMs');
/**
 * A delivery closes after this long without a read of the study. Sized to the slowest measured opening - the eight-pane
 * current-vs-prior layout took 60-80 s to load on the 2-vCPU demo VM (dicom-frame-layout.ts) - with margin, so one
 * opening is one pair rather than several. Re-check before a larger site (D1804 first-site defaults).
 */
export const DEFAULT_IMAGE_DELIVERY_IDLE_MS = 120_000;
/**
 * A terminal the ledger refused or could not take is retried after this long, doubling up to the cap: an outage of
 * seconds costs one retry, one of minutes a few, and the retry traffic of many closed deliveries stays small.
 */
export const TERMINAL_RETRY_MS = 1_000;
export const TERMINAL_RETRY_MAX_MS = 60_000;
export const IMAGE_DELIVERY_UNAVAILABLE = Object.freeze({ code: 'IMAGE_DELIVERY_RECORD_UNAVAILABLE',
  message: '영상 열람 기록을 저장하지 못해 영상을 보낼 수 없습니다. 잠시 후 다시 시도하세요.' });
const CONTEXT_UNAVAILABLE = Object.freeze({ code: 'ImageRequestContextUnavailable', message: '영상의 현재 접근 권한을 확인할 수 없습니다' });

/**
 * Held by one image response of a delivery; released when that response has ended. `served` is whether the response
 * carried an image to its end: one that ended as an error answer (a 503 for a failed source read, a relayed refusal)
 * or was cut short is not an image the person received, whatever the socket saw.
 */
export interface DeliveryLease { release(served: boolean): void }

interface Delivery {
  key: string; studyUid: string;
  /** Resolves once the provide-prepared event is durable; rejects when it could not be recorded. */
  prepared: Promise<Readonly<AccessEventV1>>;
  event: Readonly<AccessEventV1> | null;
  inflight: number; served: number; unserved: number;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  /** The terminal event, built once when the delivery closed; retried as the same fact until the ledger holds it. */
  terminal: Readonly<AccessEventV1> | null;
  attempts: number;
  recording: Promise<void> | null;
  cancelRetry: (() => void) | null;
  /**
   * Ledger work the stop admitted for this delivery's terminal while admission was still open. It stays the
   * delivery's through every attempt of the stop - an attempt that fails on it does not end it - and the stop ends it
   * once its last attempt is over.
   */
  reserved: EmrRecordWork | null;
}

const known = <T>(value: T) => ({ status: 'known' as const, value });

@Injectable()
export class StudyImageDeliveryRecorder implements OnModuleDestroy, BeforeApplicationShutdown {
  private readonly logger = new Logger('ImageDelivery');
  private readonly open = new Map<string, Delivery>();
  /** Closed deliveries whose terminal the ledger does not hold yet. */
  private readonly closing = new Set<Delivery>();
  private shutdown: Promise<unknown> | null = null;
  private stopping = false;
  private readonly idleMs: number;

  constructor(@Inject(EMR_RECORD_PORT) private readonly records: EmrRecordPort,
    @Inject(REQUEST_CONTEXT_SOURCE) private readonly requests: RequestContextSource,
    @Inject(CURRENT_CLINICAL_CONTEXT) private readonly clinical: ClinicalContextSource,
    private readonly orthanc: OrthancService,
    @Inject(EMR_BACKGROUND_WORK) private readonly background: BackgroundWork,
    @Optional() @Inject(IMAGE_DELIVERY_IDLE_MS) idleMs?: number) {
    this.idleMs = typeof idleMs === 'number' && idleMs > 0 ? idleMs : DEFAULT_IMAGE_DELIVERY_IDLE_MS;
  }

  /**
   * The delivery this request belongs to, with its provide-prepared event durable. The first request of a member
   * session for a study records the event; the requests that arrive while it is being recorded wait for the same
   * receipt; later ones find the open delivery. Resolves only after the receipt - the caller sends no byte before.
   */
  async admit(request: IncomingMessage, surface: string, studyUid: string): Promise<DeliveryLease> {
    let delivery: Delivery;
    try {
      // A read admitted after the stop began would belong to a delivery the stop does not close: no pair, so no byte.
      if (this.stopping) throw new ServiceUnavailableException(IMAGE_DELIVERY_UNAVAILABLE);
      const snapshot = this.requests.read(request);
      const key = JSON.stringify([snapshot.issuer, snapshot.subject, snapshot.binding.sessionRef, studyUid]);
      delivery = this.open.get(key) ?? this.start(key, request, surface, studyUid);
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

  private start(key: string, request: IncomingMessage, surface: string, studyUid: string): Delivery {
    const delivery: Delivery = { key, studyUid, prepared: null as any, event: null, inflight: 0, served: 0, unserved: 0, timer: null, closed: false,
      terminal: null, attempts: 0, recording: null, cancelRetry: null, reserved: null };
    delivery.prepared = this.prepare(request, surface, studyUid).then(event => { delivery.event = event; return event; });
    // A delivery that could not be recorded is no delivery: the next read asks the ledger again.
    delivery.prepared.catch(() => { if (this.open.get(key) === delivery) this.open.delete(key); });
    this.open.set(key, delivery);
    return delivery;
  }

  private async prepare(request: IncomingMessage, surface: string, studyUid: string): Promise<Readonly<AccessEventV1>> {
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
      const event = parseAccessEvent({ formatVersion: 1, surface, eventId: randomUUID(),
        userId: known(facts.actor.identity), rolesAtTime: known(facts.actor.roles), actingInstitution: known(facts.actor.institutionId),
        managingInstitution: known(study.managingInstitutionId), occurredAt: at, trustedProxyIp: facts.ip,
        // The viewer reads frames as the person looks and ahead of it; which of the two a request is cannot be told
        // here, so the delivery is recorded as the fetch it is (as images/dicom-web records its deliveries). The
        // person's display is the client's own report, not this event.
        cause: 'background-fetch', context: { basis: 'background-fetch', studyId: studyUid, relatedStudyId: null, reason: null },
        executor: 'member', targets: [{ kind: 'image', patientLinkSnapshot: known(study.patient), studyId: known(studyUid),
          recordId: known(studyUid), versionId: known(`orthanc-study:${revision.id}@${revision.lastUpdate}`) }],
        action: 'provide-prepared', result: 'prepared', requestId: facts.requestId, auditLinkId: newAuditLinkId(), relatedEventId: null }) as Readonly<AccessEventV1>;
      await this.append(work, event);
      return event;
    } finally { work.end(); }
  }

  /** A1's append discipline: a lost COMMIT reply is resolved only through this operation's stored result. */
  private async append(work: EmrRecordWork, event: Readonly<AccessEventV1>): Promise<void> {
    const keys = { operationId: randomUUID(), attemptId: randomUUID() };
    let receipt: unknown;
    try { receipt = await work.append(event, undefined, keys); }
    catch (error) {
      const result = await work.lookup(keys.operationId);
      if (!result || result.outcome !== 'committed' || result.eventId !== event.eventId) throw error;
      receipt = await work.confirm({ provisional: true, operationId: keys.operationId, eventId: event.eventId });
    }
    if (!isDurableReceipt(receipt) || receipt.eventId !== event.eventId) throw new Error('ImageDeliveryReceiptRefused');
  }

  private unavailable(error: unknown): Error {
    // The gate's own refusals keep their answer; a request without a captured admission or a ledger that cannot
    // record is the viewing 503, never a body.
    if (error instanceof HttpException) return error;
    if (error instanceof RequestContextUnavailable) return new ServiceUnavailableException(CONTEXT_UNAVAILABLE);
    this.logger.warn('image_delivery category=record_failed ' + (error instanceof Error ? error.message : String(error)));
    return new ServiceUnavailableException(IMAGE_DELIVERY_UNAVAILABLE);
  }

  /** Nothing in flight: the delivery ends after the idle gap unless another read of the study arrives first. */
  private settle(delivery: Delivery): void {
    if (delivery.closed || delivery.inflight > 0 || delivery.timer) return;
    delivery.timer = setTimeout(() => { delivery.timer = null; void this.close(delivery); }, this.idleMs);
    delivery.timer.unref?.();
  }

  /**
   * The terminal event of the pair, built once: `transfer-ended` for a delivery that went quiet after at least one
   * image response reached its end (others may have been cut by the viewer re-targeting a pane, or refused; the
   * delivery as a whole still provided the study), `transfer-aborted` for one that provided no image at all - every
   * read failed before its body or was cut - or that is closed while a response is still being sent (shutdown).
   * A delivery whose preparation never succeeded has no event to close. The event's time is the close, not the
   * append that eventually holds it.
   */
  private async close(delivery: Delivery): Promise<void> {
    if (delivery.closed) return;
    delivery.closed = true;
    if (delivery.timer) { clearTimeout(delivery.timer); delivery.timer = null; }
    if (this.open.get(delivery.key) === delivery) this.open.delete(delivery.key);
    // Only the shutdown closes a delivery still being prepared; a preparation that then succeeds is closed as well.
    const event = delivery.event ?? await delivery.prepared.catch(() => null);
    if (!event) return;
    const outcome = delivery.inflight === 0 && delivery.served > 0 ? 'ended' : 'aborted';
    delivery.terminal = parseAccessEvent({ ...event, eventId: randomUUID(), occurredAt: new Date().toISOString(),
      action: outcome === 'ended' ? 'transfer-ended' : 'transfer-aborted', result: outcome === 'ended' ? 'succeeded' : 'aborted',
      relatedEventId: event.eventId }) as Readonly<AccessEventV1>;
    this.closing.add(delivery);
    await this.record(delivery);
  }

  /**
   * One attempt at a time to make the terminal durable. The same event is appended on every attempt: the ledger keys
   * operations by event id and content, so an attempt whose COMMIT reply was lost is found, not duplicated. A failed
   * attempt is journaled by the store (B2 failure journal, with this event id) and retried here with backoff through
   * the background registry, whose timers the shutdown clears and whose running tasks it drains before the ledger
   * disconnects. At shutdown no retry is scheduled: the last attempt is the one the stop makes, on the work it reserved.
   */
  private record(delivery: Delivery): Promise<void> {
    if (delivery.recording) return delivery.recording;
    if (delivery.cancelRetry) { delivery.cancelRetry(); delivery.cancelRetry = null; }
    const terminal = delivery.terminal!;
    const attempt = async () => {
      // Work the stop reserved is used first: it was admitted while admission was open, and the port keeps admitted
      // work through its close. It is not ended here - the attempt that runs on it may be the one before the stop's
      // last, and after admission closed no new work could replace it; the stop ends it after that last attempt
      // (review MG-09, round 5). Work taken here, before the first await, is this attempt's alone and ends with it.
      const reserved = delivery.reserved;
      let work: EmrRecordWork;
      if (reserved) work = reserved;
      else {
        try { work = this.records.begin(); }
        catch (error) { this.defer(delivery, error); return; }
      }
      try {
        await this.append(work, terminal);
        this.closing.delete(delivery);
        this.logger.log(`image_delivery outcome=${terminal.action === 'transfer-ended' ? 'ended' : 'aborted'} responses=${delivery.served + delivery.unserved} ` +
          `unserved=${delivery.unserved} attempts=${delivery.attempts + 1}`);
      } catch (error) { this.defer(delivery, error); }
      finally { if (!reserved) work.end(); }
    };
    delivery.recording = attempt().finally(() => { delivery.recording = null; });
    return delivery.recording;
  }

  private defer(delivery: Delivery, error: unknown): void {
    delivery.attempts++;
    const terminal = delivery.terminal!, reason = error instanceof Error ? error.message : String(error);
    const delay = Math.min(TERMINAL_RETRY_MAX_MS, TERMINAL_RETRY_MS * 2 ** Math.min(delivery.attempts - 1, 16));
    if (this.stopping || this.background.quiesced) {
      // No retry timer once the process stops: the stop's own last attempt follows (onModuleDestroy), and what it
      // could not record is reported there with its event ids - this line names one attempt, not the pair's fate.
      this.logger.warn(`image_delivery category=terminal_attempt_failed_at_shutdown action=${terminal.action} event=${terminal.eventId} ` +
        `prepared=${terminal.relatedEventId} attempt=${delivery.attempts} ${reason}`);
      return;
    }
    this.logger.error(`image_delivery category=terminal_not_recorded action=${terminal.action} event=${terminal.eventId} ` +
      `prepared=${terminal.relatedEventId} attempt=${delivery.attempts} retry_ms=${delay} ${reason}`);
    delivery.cancelRetry = this.background.schedule('image-delivery.terminal', delay, () => this.record(delivery));
  }

  /**
   * Every open delivery ends with the process; one still sending is aborted, a quiet one ended. Every terminal still
   * pending gets its last attempt now; one that still fails is logged with its event ids and stays in the store's
   * failure journal - the shutdown does not report it as a complete pair.
   *
   * Nest awaits every onModuleDestroy before any beforeApplicationShutdown, where EmrNestLifecycle closes record
   * admission; the hooks of one module run concurrently, so nothing awaited here may be needed after that close.
   * The ledger work of every terminal this stop may owe - open deliveries, still being prepared or not, and closed
   * ones whose terminal is not durable yet - is therefore admitted synchronously, before the first await; the port
   * keeps admitted work through its close, and the runtime's drain waits for it. The reservation is ended here, once,
   * after the stop's last attempt - whether that attempt used it, an earlier attempt failed on it, or the delivery
   * turned out to owe nothing (its preparation failed, or its in-flight attempt succeeded).
   */
  onModuleDestroy(): void {
    this.stopping = true;
    this.shutdown ??= this.stop();
  }

  private stop(): Promise<void> {
    const owed = new Set<Delivery>([...this.open.values(), ...this.closing]);
    for (const delivery of owed) {
      if (delivery.reserved) continue;
      try { delivery.reserved = this.records.begin(); }
      catch (error) {
        this.logger.warn(`image_delivery category=terminal_work_not_reserved_at_shutdown study=${delivery.studyUid} ` + (error instanceof Error ? error.message : String(error)));
      }
    }
    return (async () => {
      await Promise.allSettled([...this.open.values()].map(delivery => this.close(delivery)));
      // A retry that was mid-flight when the shutdown began settles first; whatever is still pending is attempted once more.
      await Promise.allSettled([...this.closing].map(delivery => delivery.recording ?? Promise.resolve()));
      await Promise.allSettled([...this.closing].map(delivery => this.record(delivery)));
      for (const delivery of owed) if (delivery.reserved) { delivery.reserved.end(); delivery.reserved = null; }
      for (const delivery of this.closing) {
        const terminal = delivery.terminal!;
        this.logger.error(`image_delivery category=terminal_not_recorded_at_shutdown action=${terminal.action} event=${terminal.eventId} ` +
          `prepared=${terminal.relatedEventId} attempts=${delivery.attempts}`);
      }
      if (this.closing.size) this.logger.error(`image_delivery category=terminals_pending_at_shutdown count=${this.closing.size}`);
    })();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.onModuleDestroy();
    await this.shutdown;
  }
}
