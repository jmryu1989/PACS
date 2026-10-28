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
 * are; nothing the browser sends is a fact here. Admission (institution, StudyAccess, split UID) is the caller's gate and
 * runs before this recorder. This recorder is route-neutral and the only one: every API route that answers image bytes -
 * the frame reader and preview (dicom-frame.controller.ts), the recorded relay (image-relay.controller.ts) and E's image
 * API (emr-image/service.ts) - takes its lease through `lease()`, so the reads of one opening across routes share one
 * pair and one rule decides what counts as a delivery (R244-GPT-FIX6-01/02: E had its own pair and counted a HEAD).
 *
 * A route that serves a fixed manifest (E) binds its reads to it (DeliveryBinding): a delivery is the record of one
 * manifest's patient and version, and a read under another binding never borrows it - the open one is retired and the
 * read opens its own (R244-GPT-FIX7-01: F attributes a delivery's image rows to the patient its event names). Facts a
 * response could not write on its own connection are owed by the delivery and written on the terminal's own
 * transaction at the latest, so a closing event never exists without them (R244-GPT-02, OwedFacts).
 *
 * A terminal the ledger cannot take at that moment keeps its identity and operation and is offered again until it is
 * durable or the process stops; it is never dropped for being late (MG-09). The stop refuses new deliveries from its
 * first moment, reserves the ledger work of every terminal it still owes before record admission closes, and keeps that
 * work until its own last offer is over - so a delivery whose preparation or terminal is in flight when the process
 * stops still gets one more offer, also after an offer that ran on the reservation failed.
 */
import { ConflictException, HttpException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AccessEventV1, AccessTarget, DurableAccessReceipt, PatientLinkSnapshot } from './emr-contract/access-event';
import { newAuditLinkId, parseAccessEvent } from './emr-contract/access-event';
import type { ClinicalContextSource } from './emr-clinical/runtime';
import { CURRENT_CLINICAL_CONTEXT } from './emr-clinical/startup';
import { EMR_BACKGROUND_WORK, backgroundRetryDelayMs } from './emr-runtime/background-work';
import type { BackgroundWork } from './emr-runtime/background-work';
import { isDurableReceipt } from './emr-runtime/contract';
import { EMR_RECORD_PORT } from './emr-runtime/record-port';
import type { EmrRecordPort, EmrRecordTransaction, EmrRecordWork } from './emr-runtime/record-port';
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
// The route's manifest names another patient than the study's current one: E rebuilds it on this answer (service.ts).
const BINDING_OUTDATED = Object.freeze({ code: 'ImageCurrentStudyChanged', message: '검사의 현재 환자 정보가 바뀌었습니다. 영상을 다시 열어 주세요.' });

const UID = '[0-9.]{1,64}';
// QIDO answers and DICOMweb metadata: attributes and BulkDataURIs, never the pixel data itself.
const DICOMWEB_DESCRIPTION = new RegExp(`^/dicom-web/(?:studies|series|instances|studies/${UID}/(?:series|instances|series/${UID}/instances)` +
  `|studies/${UID}(?:/series/${UID}(?:/instances/${UID})?)?/metadata)$`);
// The header reads the print and volume consumers make before their image read: Orthanc's tag dumps leave binary
// values out, and the attachment info is the stored file's size and digest.
const INSTANCE_DESCRIPTION = /^\/instances\/[0-9a-f-]+\/(?:tags|simplified-tags|header|attachments\/dicom\/info)$/;

/**
 * True for a read whose answer carries the stored object's image: pixels, a rendering, an encapsulated document or the
 * whole object. Anything under the two image roots that is not a named description counts, so a representation added
 * later is recorded rather than missed. `path` is the DICOMweb or Orthanc path without its query.
 */
export function imageRead(path: string): boolean {
  if (path.startsWith('/instances/')) return !INSTANCE_DESCRIPTION.test(path);
  if (path.startsWith('/dicom-web/')) return !DICOMWEB_DESCRIPTION.test(path);
  return false;
}

/** The delivery's provide-prepared event and the ledger's durable receipt of it: what a response is provided under. */
export interface DeliveryRecord { event: Readonly<AccessEventV1>; receipt: Readonly<DurableAccessReceipt> }

/**
 * What a route's image bytes are bound to beyond the study, when the route knows it: E serves the objects of one
 * verified manifest, so its reads name that manifest's patient and digest. A route without one (the frame reader, the
 * relay) reads the archive as it is and joins whichever delivery of the study is open.
 */
export interface DeliveryBinding { patient: PatientLinkSnapshot; version: string }

/**
 * Facts a response could not write on its own connection (E's refused observation rows, R244-GPT-02). The delivery owes
 * them: they are written on a ledger transaction as soon as one is offered, and at the latest on the terminal's own
 * transaction - the closing event commits with them or not at all - and are never dropped. `names` identifies them in
 * the stop's report of what it could not write.
 */
export interface OwedFacts { write(tx: EmrRecordTransaction): Promise<void>; readonly names: unknown }

/**
 * Held by one image response of a delivery. `served` is true only for a response that sent its image completely with a
 * success status; an error answer, a relay failure or a response cut short is not a served image (MG-10). `record` is
 * the delivery's durable provide-prepared event, for a route that keeps per-response rows naming it (E), and `binding`
 * the manifest the delivery records, if any. `retire` ends the delivery for a route that found its binding outdated (E
 * forgetting its manifest): it closes once its responses have, and the next read opens a new one.
 */
export interface DeliveryLease {
  readonly record: DeliveryRecord;
  readonly binding: DeliveryBinding | null;
  release(served: boolean, owed?: OwedFacts): void;
  retire(): void;
}

interface Delivery {
  key: string; studyUid: string;
  /** The manifest this delivery records: its opening read's, or the first bound read's it was found current for. */
  binding: DeliveryBinding | null;
  /** The archive's current revision, re-read once when a bound read finds this delivery unbound. */
  revision: Promise<string> | null;
  /** Resolves once the provide-prepared event is durable; rejects when it could not be recorded. */
  prepared: Promise<DeliveryRecord>;
  event: Readonly<AccessEventV1> | null;
  inflight: number; served: number; unserved: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Out of `open`: a read under another binding superseded it, or its route retired it. Closes once nothing is in flight. */
  retired: boolean;
  closed: boolean;
  /** Facts its responses could not write, oldest first; only the offer that wrote them removes them. */
  owed: OwedFacts[];
  /** The closing event and its ledger operation, fixed once built: every offer is the ledger's exact retry. */
  terminal: { event: Readonly<AccessEventV1>; operationId: string } | null;
  /** The terminal is durable. */
  ended: boolean;
  attempts: number;
  recording: Promise<void> | null;
  /** Something new to offer arrived while an offer was running: the running one offers again when it is done. */
  reoffer: boolean;
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
const samePatient = (a: PatientLinkSnapshot, b: PatientLinkSnapshot) =>
  a.linkId === b.linkId && a.patientId === b.patientId && a.assigningAuthority === b.assigningAuthority;
const sameBinding = (a: DeliveryBinding, b: DeliveryBinding) => a.version === b.version && samePatient(a.patient, b.patient);
const revisionId = (revision: { id: string; lastUpdate: string }) => `orthanc-study:${revision.id}@${revision.lastUpdate}`;
/** The ledger settled an append as not recorded (B2 settles a rolled-back operation negative): its event ID can never
 * commit, so the next offer is a new event. */
class AppendRefused extends Error {
  constructor(reason: unknown) { super('ImageDeliveryAppendRefused: ' + message(reason)); }
}

@Injectable()
export class StudyImageDeliveryRecorder implements OnModuleDestroy, BeforeApplicationShutdown {
  private readonly logger = new Logger('ImageDelivery');
  private readonly open = new Map<string, Delivery>();
  /** Retired deliveries whose responses are still running. */
  private readonly retiring = new Set<Delivery>();
  /** Closed deliveries that still owe the ledger their terminal or facts. Never reported as recorded. */
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
   * The lease of one response to an image route, or null for a response that delivers no image: a HEAD (no body; Node
   * drops it) and a description (QIDO, DICOMweb metadata, tags; `imageRead`). Neither opens a delivery nor counts in
   * one - a 200 HEAD beside reads that all failed would turn an aborted delivery into a provided one (review INT-01,
   * R244-GPT-FIX6-01). Every image route asks here with its request path, so the rule is this one, not each route's.
   * `study` names the study the route's gate has just resolved; it is only asked for a delivery. `binding` is the
   * manifest a route serving one (E) delivers from.
   */
  async lease(request: IncomingMessage, surface: string, path: string, study: () => string | Promise<string>,
    binding: DeliveryBinding | null = null): Promise<DeliveryLease | null> {
    if (request.method !== 'GET' || !imageRead(path)) return null;
    return this.admit(request, surface, await study(), binding);
  }

  /**
   * The delivery this request belongs to, with its provide-prepared event durable. The first request of a member
   * session for a study records the event; the requests that arrive while it is being recorded wait for the same
   * receipt; later ones find the open delivery. Resolves only after the receipt - the caller sends no byte before. A
   * bound read never joins a delivery of another manifest: that one is retired - it ends with its own responses - and
   * the read opens its own, so no event names a patient or version other than the one whose bytes it covers.
   */
  private async admit(request: IncomingMessage, surface: string, studyUid: string, binding: DeliveryBinding | null): Promise<DeliveryLease> {
    for (;;) {
      let delivery: Delivery;
      try {
        // Another provider's shutdown may still be running while the port admits work; a read let in now would open a
        // delivery the stop has already passed over, a pair without its end. No pair, so no byte.
        if (this.stopping) throw new ServiceUnavailableException(IMAGE_DELIVERY_UNAVAILABLE);
        const snapshot = this.requests.read(request);
        const key = JSON.stringify([snapshot.issuer, snapshot.subject, snapshot.binding.sessionRef, studyUid]);
        const current = this.open.get(key);
        if (current && binding && current.binding && !sameBinding(current.binding, binding)) this.retire(current);
        delivery = this.open.get(key) ?? this.start(key, request, surface, studyUid, binding);
      } catch (error) { throw this.unavailable(error); }
      if (delivery.timer) { clearTimeout(delivery.timer); delivery.timer = null; }
      delivery.inflight++;
      let record: DeliveryRecord, bound: boolean;
      try {
        record = await delivery.prepared;
        bound = binding === null || await this.bind(delivery, binding);
      } catch (error) {
        delivery.inflight--;
        if (delivery.event) this.settle(delivery);
        throw this.unavailable(error);
      }
      if (!bound) {
        this.retire(delivery);
        delivery.inflight--;
        this.settle(delivery);
        continue;
      }
      let released = false;
      return { record, binding: delivery.binding, retire: () => this.retire(delivery), release: (served, owed) => {
        if (released) return;
        released = true;
        // Owed before this release can close the delivery: its terminal is then written with them.
        if (owed) delivery.owed.push(owed);
        delivery.inflight--;
        if (served) delivery.served++; else delivery.unserved++;
        this.settle(delivery);
        // Every response of a delivery that owes facts offers them again (they wait for no later trigger).
        if (delivery.owed.length) {
          if (delivery.closed) this.closing.add(delivery);
          void this.record(delivery);
        }
      } };
    }
  }

  private start(key: string, request: IncomingMessage, surface: string, studyUid: string, binding: DeliveryBinding | null): Delivery {
    const delivery: Delivery = { key, studyUid, binding, revision: null, prepared: null as any, event: null, inflight: 0,
      served: 0, unserved: 0, timer: null, retired: false, closed: false, owed: [], terminal: null, ended: false, attempts: 0,
      recording: null, reoffer: false, cancelRetry: null, reserved: null };
    delivery.prepared = this.prepare(request, surface, studyUid, binding).then(record => { delivery.event = record.event; return record; });
    // A delivery that could not be recorded is no delivery: the next read asks the ledger again.
    delivery.prepared.catch(() => { if (this.open.get(key) === delivery) this.open.delete(key); });
    this.open.set(key, delivery);
    return delivery;
  }

  private async prepare(request: IncomingMessage, surface: string, studyUid: string, binding: DeliveryBinding | null): Promise<DeliveryRecord> {
    const work = this.records.begin();
    try {
      const at = new Date().toISOString();
      // Current identity, institution, StudyAccess and the study's patient are read on the ledger's transaction, as the
      // images/dicom-web delivery reads them (ProductionImageContext.current); a study the member may not see is refused
      // here with the same answer the clinical routes give.
      const { facts, study } = await work.transactionWithRecords(async tx => ({
        facts: await this.clinical.facts(tx, request), study: await this.clinical.study(tx, request, studyUid) }));
      if (facts.actor.kind !== 'member') throw new ServiceUnavailableException(CONTEXT_UNAVAILABLE);
      // A manifest naming another patient than the study's current one is outdated: no record is opened for its bytes.
      if (binding && !samePatient(study.patient, binding.patient)) throw new ConflictException(BINDING_OUTDATED);
      const revision = await this.orthanc.studyRevision(studyUid);
      const event = parseAccessEvent({ formatVersion: 1, surface, eventId: randomUUID(),
        userId: known(facts.actor.identity), rolesAtTime: known(facts.actor.roles), actingInstitution: known(facts.actor.institutionId),
        managingInstitution: known(study.managingInstitutionId), occurredAt: at, trustedProxyIp: facts.ip,
        // Image reads come as the person looks and ahead of it (prefetch, strips); which a request is cannot be told here,
        // so the delivery is recorded as the fetch it is (as images/dicom-web records its deliveries). The person's
        // display is the client's own report, not this event.
        cause: 'background-fetch', context: { basis: 'background-fetch', studyId: studyUid, relatedStudyId: null, reason: null },
        executor: 'member', targets: [{ kind: 'image', patientLinkSnapshot: known(study.patient), studyId: known(studyUid),
          recordId: known(studyUid), versionId: known(revisionId(revision)) }],
        action: 'provide-prepared', result: 'prepared', requestId: facts.requestId, auditLinkId: newAuditLinkId(), relatedEventId: null }) as Readonly<AccessEventV1>;
      return { event, receipt: await this.append(work, event, randomUUID()) };
    } finally { work.end(); }
  }

  /**
   * Whether a read bound to `binding` may be served under this prepared delivery. An unbound one - opened by a route
   * that reads the archive as it is - becomes this binding's when its record names the binding's patient and the
   * archive's revision it names is still the current one (one re-read per delivery, shared by the reads that wait on
   * it); otherwise the read opens its own.
   */
  private async bind(delivery: Delivery, binding: DeliveryBinding): Promise<boolean> {
    if (!delivery.binding) {
      const target = delivery.event.targets.find((t): t is AccessTarget => t.kind === 'image');
      const patient = target?.patientLinkSnapshot, version = target?.versionId;
      if (patient?.status !== 'known' || version?.status !== 'known' || !samePatient(patient.value, binding.patient)) return false;
      const revision = delivery.revision ??= this.orthanc.studyRevision(delivery.studyUid).then(revisionId);
      let current: string;
      try { current = await revision; }
      catch (error) { if (delivery.revision === revision) delivery.revision = null; throw error; }
      if (current !== version.value) return false;
      delivery.binding ??= binding;
    }
    return sameBinding(delivery.binding, binding);
  }

  /**
   * A1's append discipline with a caller-fixed operation: a lost COMMIT reply is resolved only through that operation's
   * stored result. Offering the same event under the same operation again is the ledger's exact retry (one operation per
   * event ID), so a terminal can be offered until it is taken without ever becoming two records. `facts` are written as
   * the operation's own effect, on its transaction: B2 commits them with the entry or neither, and journals a failed
   * write against this event. An operation B2 settled as not recorded can never commit; that is AppendRefused.
   */
  private async append(work: EmrRecordWork, event: Readonly<AccessEventV1>, operationId: string,
    facts: readonly OwedFacts[] = []): Promise<Readonly<DurableAccessReceipt>> {
    let receipt: unknown;
    try {
      if (!facts.length) receipt = await work.append(event, undefined, { operationId, attemptId: randomUUID() });
      else {
        const operation = await work.admit(event, undefined, { operationId, attemptId: randomUUID() });
        await work.transaction(operation, async tx => { for (const fact of facts) await fact.write(tx); return null; });
        receipt = await work.confirm({ provisional: true, operationId: operation.operationId, eventId: event.eventId });
      }
    } catch (error) {
      const result = await work.lookup(operationId);
      if (result?.outcome === 'negative' && result.eventId === event.eventId) throw new AppendRefused(error);
      if (!result || result.outcome !== 'committed' || result.eventId !== event.eventId) throw error;
      receipt = await work.confirm({ provisional: true, operationId, eventId: event.eventId });
    }
    if (!isDurableReceipt(receipt) || receipt.eventId !== event.eventId) throw new Error('ImageDeliveryReceiptRefused');
    return receipt;
  }

  private unavailable(error: unknown): Error {
    // The gate's own refusals keep their answer; a request without a captured admission or a ledger that cannot
    // record is the viewing 503, never a body.
    if (error instanceof HttpException) return error;
    if (error instanceof RequestContextUnavailable) return new ServiceUnavailableException(CONTEXT_UNAVAILABLE);
    this.logger.warn('image_delivery category=record_failed ' + message(error));
    return new ServiceUnavailableException(IMAGE_DELIVERY_UNAVAILABLE);
  }

  /** Nothing in flight: the delivery ends after the idle gap unless another read of the study arrives first; a retired
   * one ends now. */
  private settle(delivery: Delivery): void {
    if (delivery.closed || delivery.inflight > 0 || delivery.timer) return;
    if (delivery.retired) { void this.close(delivery); return; }
    delivery.timer = setTimeout(() => { delivery.timer = null; void this.close(delivery); }, this.idleMs);
    delivery.timer.unref?.();
  }

  /** No later read joins the delivery; it ends once its responses have. */
  private retire(delivery: Delivery): void {
    if (delivery.retired || delivery.closed) return;
    delivery.retired = true;
    if (this.open.get(delivery.key) === delivery) this.open.delete(delivery.key);
    this.retiring.add(delivery);
    if (delivery.timer) { clearTimeout(delivery.timer); delivery.timer = null; }
    this.settle(delivery);
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
    this.retiring.delete(delivery);
    if (delivery.event) return this.finish(delivery, delivery.event);
    return delivery.prepared.then(record => this.finish(delivery, record.event), () => undefined);
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
   * One ledger offer at a time of what the delivery owes; something that arrives while one runs is offered when it is
   * done.
   */
  private record(delivery: Delivery): Promise<void> {
    if (delivery.recording) { delivery.reoffer = true; return delivery.recording; }
    delivery.recording = (async () => {
      do { delivery.reoffer = false; await this.offer(delivery); } while (delivery.reoffer);
    })().finally(() => { delivery.recording = null; });
    return delivery.recording;
  }

  /**
   * Once the delivery is closed: its terminal, on one transaction with the facts it still owes - the closing event
   * commits with them or not at all (R244-GPT-02). Before: the facts alone, on a transaction of their own that B2
   * journals against the delivery's record when it fails. A failed terminal is offered again later (at shutdown the next
   * offer is the stop's own); facts whose own offer failed wait for the next response's offer or the terminal's. A failed
   * offer is journalled by the store under the event ID (ledger-unreachable/refused, commit-unknown, business-rollback).
   */
  private async offer(delivery: Delivery): Promise<void> {
    if (delivery.cancelRetry) { delivery.cancelRetry(); delivery.cancelRetry = null; }
    const terminal = delivery.ended ? null : delivery.terminal;
    const facts = delivery.owed.slice();
    if (!terminal && !facts.length) return;
    // Work the stop reserved is used first: it was admitted while admission was open and the port keeps admitted work
    // through its close. It is not ended here - after admission closed nothing could replace it for the stop's last
    // offer; the stop ends it. Work taken here, before the first await, is this offer's alone and ends with it.
    const reserved = delivery.reserved;
    let work: EmrRecordWork;
    if (reserved) work = reserved;
    else {
      try { work = this.records.begin(); }
      catch (error) { this.unrecorded(delivery, terminal, error); return; }
    }
    try {
      if (terminal) {
        await this.append(work, terminal.event, terminal.operationId, facts);
        delivery.ended = true;
        this.logger.log(`image_delivery outcome=${terminal.event.action === 'transfer-ended' ? 'ended' : 'aborted'} ` +
          `served=${delivery.served} unserved=${delivery.unserved} attempts=${delivery.attempts + 1}`);
      } else await work.transactionWithRecords(async tx => { for (const fact of facts) await fact.write(tx); }, undefined, delivery.event.eventId);
      delivery.owed.splice(0, facts.length);
      if (delivery.ended && !delivery.owed.length) this.closing.delete(delivery);
    } catch (error) { this.unrecorded(delivery, terminal, error); }
    finally { if (!reserved) work.end(); }
  }

  private unrecorded(delivery: Delivery, terminal: Delivery['terminal'], error: unknown): void {
    if (!terminal) {
      // B2 journaled the failure against the delivery's record; the facts stay owed, and are named here.
      this.logger.warn(`image_delivery category=facts_held prepared=${delivery.event.eventId} ` +
        `facts=${JSON.stringify(delivery.owed.map(fact => fact.names))} ${message(error)}`);
      return;
    }
    // A refused terminal's event can never commit; its close is offered again as a new event of the same pair.
    if (error instanceof AppendRefused) delivery.terminal = { operationId: randomUUID(),
      event: parseAccessEvent({ ...terminal.event, eventId: randomUUID() }) as Readonly<AccessEventV1> };
    this.defer(delivery, error);
  }

  private defer(delivery: Delivery, error: unknown): void {
    delivery.attempts++;
    const { event } = delivery.terminal!;
    if (this.stopping || this.background.quiesced) {
      // No timer once the process stops: the stop's own last offer follows, and what it could not record is reported
      // there - this line names one offer, not the pair's fate.
      this.logger.warn(`image_delivery category=terminal_attempt_failed_at_shutdown event=${event.eventId} ` +
        `prepared=${event.relatedEventId} attempt=${delivery.attempts} facts=${JSON.stringify(delivery.owed.map(fact => fact.names))} ${message(error)}`);
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
   * every terminal still owed gets one more offer, with the facts its delivery still owes; one that still fails is
   * logged with its event IDs and stays in the store's failure journal - the stop does not report it as a complete pair
   * - and facts still unwritten are named.
   *
   * Nest awaits every onModuleDestroy before any beforeApplicationShutdown, where EmrNestLifecycle closes record
   * admission. So admission to this recorder closes here, synchronously, and the ledger work of every terminal the stop
   * may owe - open and retired deliveries, prepared or still being prepared, and closed ones not durable yet - is
   * admitted before the first await. The port keeps admitted work through its close and the runtime's drain waits for
   * it. Each reservation is ended once, after the stop's last offer, whether that offer used it, an earlier one failed
   * on it, or the delivery turned out to owe nothing.
   */
  onModuleDestroy(): void {
    this.stopping = true;
    this.shutdown ??= this.stop();
  }

  private stop(): Promise<void> {
    const opened = [...this.open.values(), ...this.retiring];
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
        if (!delivery.ended) this.logger.error(`image_delivery category=terminal_not_recorded_at_shutdown event=${event.eventId} ` +
          `prepared=${event.relatedEventId} attempts=${delivery.attempts}`);
        if (delivery.owed.length) this.logger.error(`image_delivery category=facts_not_written_at_shutdown prepared=${event.relatedEventId} ` +
          `facts=${JSON.stringify(delivery.owed.map(fact => fact.names))}`);
      }
    })();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.onModuleDestroy();
    await this.shutdown;
  }
}

