/*
 * MG-08 (D1877(2), 2026-10-27): the 열람 record of the image bytes the API serves. 의료법 제23조④ asks for a record of
 * every access to the electronic record; D1877 fixed its grain for images at one pair of access events per study
 * delivery - `provide-prepared` before the first byte, `transfer-ended`/`transfer-aborted` when the delivery ends - not
 * one per image request (a worklist preview strip or one viewer opening is tens to thousands of requests). A delivery is
 * the stream of image reads of one study by one member session; it closes after an idle gap without a read, and the next
 * read opens a new pair. No image byte leaves before the `provide-prepared` event is durable in the access ledger; a
 * ledger that cannot record answers 503 with no image byte.
 *
 * The event is the formatVersion 1 image event the images/dicom-web delivery writes (emr-image/service.ts), through the
 * same record port: the study is its target (recordId = study UID, as that delivery names its study-level units) and the
 * archive's own revision of the study is its version. Identity, institution, StudyAccess and the patient link come from
 * the current clinical context (emr-clinical/startup.ts), read on the ledger transaction as every other access record's
 * are; nothing the browser sends is a fact here. Admission (institution, StudyAccess, split UID) is the caller's DICOMweb
 * gate and runs before this recorder. This recorder is route-neutral: every API image route takes its lease here, so the
 * reads of one opening across routes share one pair.
 */
import { HttpException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AccessEventV1 } from './emr-contract/access-event';
import { newAuditLinkId, parseAccessEvent } from './emr-contract/access-event';
import type { ClinicalContextSource } from './emr-clinical/runtime';
import { CURRENT_CLINICAL_CONTEXT } from './emr-clinical/startup';
import { EMR_BACKGROUND_WORK } from './emr-runtime/background-work';
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
/** A terminal event the ledger did not take is offered again after this long (and once more at shutdown). */
export const IMAGE_DELIVERY_TERMINAL_RETRY_MS = 30_000;
export const IMAGE_DELIVERY_UNAVAILABLE = Object.freeze({ code: 'IMAGE_DELIVERY_RECORD_UNAVAILABLE',
  message: '영상 열람 기록을 저장하지 못해 영상을 보낼 수 없습니다. 잠시 후 다시 시도하세요.' });
const CONTEXT_UNAVAILABLE = Object.freeze({ code: 'ImageRequestContextUnavailable', message: '영상의 현재 접근 권한을 확인할 수 없습니다' });

/**
 * Held by one image response of a delivery. `served` is true only for a response that sent its image completely with a
 * success status; an error answer, a relay failure or a response cut short is not a served image (MG-10).
 */
export interface DeliveryLease { release(served: boolean): void }

interface Delivery {
  key: string;
  /** Resolves once the provide-prepared event is durable; rejects when it could not be recorded. */
  prepared: Promise<Readonly<AccessEventV1>>;
  event: Readonly<AccessEventV1> | null;
  inflight: number; served: number; unserved: number;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

/** One closing event. Its identity is fixed once built, so every offer to the ledger is the same operation. */
interface Terminal { event: Readonly<AccessEventV1>; operationId: string; attempt: Promise<boolean> | null }

const known = <T>(value: T) => ({ status: 'known' as const, value });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

@Injectable()
export class StudyImageDeliveryRecorder implements OnModuleDestroy, BeforeApplicationShutdown {
  private readonly logger = new Logger('ImageDelivery');
  private readonly open = new Map<string, Delivery>();
  /** Terminals the ledger has not durably taken yet (MG-09). Kept until it does; never reported as recorded. */
  private readonly unsettled = new Set<Terminal>();
  private cancelRetry: (() => void) | null = null;
  private shutdown: Promise<unknown> | null = null;
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
   * session for a study records the event; the requests that arrive while it is being recorded wait for the same
   * receipt; later ones find the open delivery. Resolves only after the receipt - the caller sends no byte before.
   */
  async admit(request: IncomingMessage, surface: string, studyUid: string): Promise<DeliveryLease> {
    let delivery: Delivery;
    try {
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
    const delivery: Delivery = { key, prepared: null as any, event: null, inflight: 0, served: 0, unserved: 0, timer: null, closed: false };
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
        // Image reads come as the person looks and ahead of it (prefetch, strips); which a request is cannot be told here,
        // so the delivery is recorded as the fetch it is (as images/dicom-web records its deliveries). The person's
        // display is the client's own report, not this event.
        cause: 'background-fetch', context: { basis: 'background-fetch', studyId: studyUid, relatedStudyId: null, reason: null },
        executor: 'member', targets: [{ kind: 'image', patientLinkSnapshot: known(study.patient), studyId: known(studyUid),
          recordId: known(studyUid), versionId: known(`orthanc-study:${revision.id}@${revision.lastUpdate}`) }],
        action: 'provide-prepared', result: 'prepared', requestId: facts.requestId, auditLinkId: newAuditLinkId(), relatedEventId: null }) as Readonly<AccessEventV1>;
      await this.append(work, event, randomUUID());
      return event;
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
    delivery.timer = setTimeout(() => { delivery.timer = null; void this.close(delivery, false); }, this.idleMs);
    delivery.timer.unref?.();
  }

  /**
   * The terminal event of the pair. `transfer-ended` only when at least one response of the delivery sent its image
   * completely; a delivery whose every response failed, was refused by the source or was cut short is
   * `transfer-aborted` (MG-10). At shutdown a delivery still sending is aborted. A delivery whose preparation never
   * succeeded has no event to close.
   */
  private async close(delivery: Delivery, atShutdown: boolean): Promise<void> {
    if (delivery.closed) return;
    delivery.closed = true;
    if (delivery.timer) { clearTimeout(delivery.timer); delivery.timer = null; }
    if (this.open.get(delivery.key) === delivery) this.open.delete(delivery.key);
    // The work is taken before the first await: at shutdown this runs from onModuleDestroy, while the port still
    // admits work (EmrNestLifecycle closes it in beforeApplicationShutdown, after every onModuleDestroy).
    let work: EmrRecordWork | null = null;
    try { work = this.records.begin(); } catch { /* retained below and offered again */ }
    try {
      const event = delivery.event ?? await delivery.prepared.catch(() => null);
      if (!event) return;
      const ended = delivery.served > 0 && !(atShutdown && delivery.inflight > 0);
      const terminal: Terminal = { operationId: randomUUID(), attempt: null,
        event: parseAccessEvent({ ...event, eventId: randomUUID(), occurredAt: new Date().toISOString(),
          action: ended ? 'transfer-ended' : 'transfer-aborted', result: ended ? 'succeeded' : 'aborted',
          relatedEventId: event.eventId }) as Readonly<AccessEventV1> };
      this.unsettled.add(terminal);
      this.logger.log(`image_delivery outcome=${ended ? 'ended' : 'aborted'} served=${delivery.served} unserved=${delivery.unserved} inflight=${delivery.inflight}`);
      if (work) await this.offer(terminal, work);
      else this.retryLater();
    } finally { work?.end(); }
  }

  /** One offer of a retained terminal. True once durable; otherwise it stays retained and a later offer is scheduled. */
  private offer(terminal: Terminal, work: EmrRecordWork): Promise<boolean> {
    if (terminal.attempt) return terminal.attempt;
    terminal.attempt = (async () => {
      try {
        await this.append(work, terminal.event, terminal.operationId);
        this.unsettled.delete(terminal);
        return true;
      } catch (error) {
        // The store has journalled this failed offer under the event ID (ledger-unreachable/refused, commit-unknown).
        this.logger.error(`image_delivery category=terminal_unsettled event=${terminal.event.eventId} ` +
          `prepared=${terminal.event.relatedEventId} ` + message(error));
        this.retryLater();
        return false;
      } finally { terminal.attempt = null; }
    })();
    return terminal.attempt;
  }

  private retryLater(): void {
    if (this.cancelRetry || this.shutdown || !this.unsettled.size) return;
    this.cancelRetry = this.background.schedule('image-delivery-terminal-retry', IMAGE_DELIVERY_TERMINAL_RETRY_MS, async () => {
      this.cancelRetry = null;
      for (const terminal of [...this.unsettled]) {
        let work: EmrRecordWork;
        try { work = this.records.begin(); }
        catch { this.retryLater(); return; }
        try { await this.offer(terminal, work); } finally { work.end(); }
      }
    });
  }

  /**
   * Every open delivery ends with the process (one still sending is aborted, a quiet one closes by what it served), and
   * every retained terminal is offered once more. Each takes its work now, before the port stops admitting.
   */
  onModuleDestroy(): void {
    if (this.shutdown) return;
    this.cancelRetry?.(); this.cancelRetry = null;
    const pending = [...this.unsettled].map(terminal => {
      if (terminal.attempt) return terminal.attempt;
      let work: EmrRecordWork;
      try { work = this.records.begin(); } catch { return Promise.resolve(false); }
      return this.offer(terminal, work).finally(() => work.end());
    });
    const closing = [...this.open.values()].map(delivery => this.close(delivery, true));
    this.shutdown = Promise.allSettled([...pending, ...closing]);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.onModuleDestroy();
    await this.shutdown;
    // What is still retained was not durably taken; its failed offers are in the ledger's failure journal under these IDs.
    for (const terminal of this.unsettled)
      this.logger.error(`image_delivery category=terminal_not_recorded_at_shutdown event=${terminal.event.eventId} prepared=${terminal.event.relatedEventId}`);
  }
}
