/*
 * MG-08 (D1877(2), 2026-10-27): the 열람 record of the viewer's image reads that nginx routes to the API's range reader
 * (dicom-frame.controller.ts). 의료법 제23조④ asks for a record of every access to the electronic record; D1877 fixed its
 * grain for images at one pair of access events per study delivery - `provide-prepared` before the first byte,
 * `transfer-ended`/`transfer-aborted` when the delivery ends - not one per frame (one DBT reading is thousands of frame
 * requests). A delivery is the stream of frame and preview reads of one study by one member session; it closes after
 * an idle gap without a read, and the next read opens a new pair. No frame or preview byte leaves before the
 * `provide-prepared` event is durable in the access ledger; a ledger that cannot record answers 503 with no body.
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
export const IMAGE_DELIVERY_UNAVAILABLE = Object.freeze({ code: 'IMAGE_DELIVERY_RECORD_UNAVAILABLE',
  message: '영상 열람 기록을 저장하지 못해 영상을 보낼 수 없습니다. 잠시 후 다시 시도하세요.' });
const CONTEXT_UNAVAILABLE = Object.freeze({ code: 'ImageRequestContextUnavailable', message: '영상의 현재 접근 권한을 확인할 수 없습니다' });

/** Held by one image response of a delivery; released when that response has ended (finished or not). */
export interface DeliveryLease { release(finished: boolean): void }

interface Delivery {
  key: string; studyUid: string;
  /** Resolves once the provide-prepared event is durable; rejects when it could not be recorded. */
  prepared: Promise<Readonly<AccessEventV1>>;
  event: Readonly<AccessEventV1> | null;
  inflight: number; finished: number; unfinished: number;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

const known = <T>(value: T) => ({ status: 'known' as const, value });

@Injectable()
export class StudyImageDeliveryRecorder implements OnModuleDestroy, BeforeApplicationShutdown {
  private readonly logger = new Logger('ImageDelivery');
  private readonly open = new Map<string, Delivery>();
  private shutdown: Promise<unknown> | null = null;
  private readonly idleMs: number;

  constructor(@Inject(EMR_RECORD_PORT) private readonly records: EmrRecordPort,
    @Inject(REQUEST_CONTEXT_SOURCE) private readonly requests: RequestContextSource,
    @Inject(CURRENT_CLINICAL_CONTEXT) private readonly clinical: ClinicalContextSource,
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
    return { release: finished => {
      if (released) return;
      released = true;
      delivery.inflight--;
      if (finished) delivery.finished++; else delivery.unfinished++;
      this.settle(delivery);
    } };
  }

  private start(key: string, request: IncomingMessage, surface: string, studyUid: string): Delivery {
    const delivery: Delivery = { key, studyUid, prepared: null as any, event: null, inflight: 0, finished: 0, unfinished: 0, timer: null, closed: false };
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
    delivery.timer = setTimeout(() => { delivery.timer = null; void this.close(delivery, 'ended'); }, this.idleMs);
    delivery.timer.unref?.();
  }

  /**
   * The terminal event of the pair: `transfer-ended` for a delivery that went quiet after its responses ended (some of
   * them may have been cut by the viewer re-targeting a pane; the delivery as a whole still ended), `transfer-aborted`
   * for one closed while a response was still being sent (shutdown). A delivery whose preparation never succeeded has
   * no event to close.
   */
  private async close(delivery: Delivery, outcome: 'ended' | 'aborted'): Promise<void> {
    if (delivery.closed) return;
    delivery.closed = true;
    if (delivery.timer) { clearTimeout(delivery.timer); delivery.timer = null; }
    if (this.open.get(delivery.key) === delivery) this.open.delete(delivery.key);
    // The work is taken before the first await: at shutdown this runs from onModuleDestroy, while the port still
    // admits work (EmrNestLifecycle closes it in beforeApplicationShutdown, after every onModuleDestroy).
    let work: EmrRecordWork;
    try { work = this.records.begin(); }
    catch (error) {
      this.logger.error(`image_delivery category=terminal_not_recorded outcome=${outcome} ` + (error instanceof Error ? error.message : String(error)));
      return;
    }
    try {
      const event = delivery.event ?? await delivery.prepared.catch(() => null);
      if (!event) return;
      const followup = parseAccessEvent({ ...event, eventId: randomUUID(), occurredAt: new Date().toISOString(),
        action: outcome === 'ended' ? 'transfer-ended' : 'transfer-aborted', result: outcome === 'ended' ? 'succeeded' : 'aborted',
        relatedEventId: event.eventId }) as Readonly<AccessEventV1>;
      await this.append(work, followup);
      this.logger.log(`image_delivery outcome=${outcome} responses=${delivery.finished + delivery.unfinished} unfinished=${delivery.unfinished}`);
    } catch (error) {
      this.logger.error(`image_delivery category=terminal_not_recorded outcome=${outcome} ` + (error instanceof Error ? error.message : String(error)));
    } finally { work.end(); }
  }

  /** Every open delivery ends with the process; one still sending is aborted, a quiet one ended. */
  onModuleDestroy(): void {
    this.shutdown ??= Promise.allSettled([...this.open.values()].map(delivery => this.close(delivery, delivery.inflight > 0 ? 'aborted' : 'ended')));
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.onModuleDestroy();
    await this.shutdown;
  }
}
