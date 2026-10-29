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
 * the current clinical context (emr-clinical/startup.ts), read for every lease on a transaction of the image check pool
 * (emr-image/check-db.ts); nothing the browser sends is a fact here. Admission (institution, StudyAccess, split UID) is
 * the caller's gate and runs before this recorder. This recorder is route-neutral and the only one: every API route that answers image bytes -
 * the frame reader and preview (dicom-frame.controller.ts), the recorded relay (image-relay.controller.ts) and E's image
 * API (emr-image/service.ts) - takes its lease through `lease()`, so the reads of one opening across routes share one
 * pair and one rule decides what counts as a delivery (R244-GPT-FIX6-01/02: E had its own pair and counted a HEAD).
 *
 * A delivery is bound to what its bytes are of (DeliveryBinding, the shared recorder contract of #244): the patient P -
 * E's manifest's, or for the frame reader, preview and relay the one their DICOMweb gate observed in the archive for
 * this very request (`archiveRead`) - and the archive's current revision R of the study, read for every lease, plus E's
 * manifest digest M once an E read joined. A read joins the open delivery of its member session (K) only when P and R
 * are the delivery's and M does not differ; otherwise that delivery is superseded - it ends with its own responses -
 * and the read opens its own. Every lease - an opening or a join - decides on current facts it reads once, after R:
 * identity, institution, StudyAccess and the study's patient, with E's provision on the same transaction; the opening
 * event and E's preparation both take that one result (CurrentDeliveryFacts; R244-GPT-FIX7-01/FIX8-01/FIX9-02/FIX10-02:
 * F attributes a delivery's image rows to the patient its event names, the event names one revision, and an open
 * delivery is not a current fact). The source a route selects is tied to its lease: the frame reader selects its
 * object before the lease reads R and serves it only when it is the binding's patient, and a relay is served only once
 * the archive still holds P and R after Orthanc selected what it answers (DeliveryLease.confirm, R244-GPT-FIX10-01). A
 * read that waited for the opening receipt is served only once the archive still holds P and R after it, and no read
 * is served by a delivery that was retired while it waited (R244-GPT-FIX9-01). Facts a response could not write on its
 * own connection are owed by the delivery and written on the terminal's own transaction at the latest, so a closing
 * event never exists without them (R244-GPT-02, OwedFacts).
 *
 * A terminal the ledger cannot take at that moment keeps its identity and operation and is offered again until it is
 * durable or the process stops; it is never dropped for being late (MG-09). The stop refuses new deliveries from its
 * first moment and reserves the ledger work of every terminal it still owes before record admission closes. A delivery
 * ends at the stop only once its responses have released their leases - the facts they hand over then go with its
 * terminal - within the shutdown's drain allowance; one still sending after it gets no terminal (R244-GPT-FIX8-02). The
 * reserved work is kept until the stop's own last offer is over, so a delivery whose preparation or terminal is in
 * flight when the process stops still gets one more offer, also after an offer that ran on the reservation failed.
 */
import { ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException, Optional,
  ServiceUnavailableException } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AccessEventV1, DurableAccessReceipt, PatientLinkSnapshot } from './emr-contract/access-event';
import { newAuditLinkId, parseAccessEvent } from './emr-contract/access-event';
import type { StudyFacts } from './emr-clinical/contract';
import type { ClinicalContextSource, ClinicalRequestFacts } from './emr-clinical/runtime';
import { CURRENT_CLINICAL_CONTEXT, studyPatientLink } from './emr-clinical/startup';
import { ImageCheckDatabase } from './emr-image/check-db';
import { EMR_BACKGROUND_WORK, backgroundRetryDelayMs } from './emr-runtime/background-work';
import type { BackgroundWork } from './emr-runtime/background-work';
import { isDurableReceipt } from './emr-runtime/contract';
import { EMR_TX_MAX_WAIT_MS, EMR_TX_TIMEOUT_MS, boundEmrStatements } from './emr-runtime/limits';
import { SHUTDOWN_DRAIN_MS } from './emr-runtime/nest-lifecycle';
import { EMR_RECORD_PORT } from './emr-runtime/record-port';
import type { EmrRecordPort, EmrRecordTransaction, EmrRecordWork } from './emr-runtime/record-port';
import { REQUEST_CONTEXT_SOURCE, RequestContextUnavailable } from './emr-runtime/request-context';
import type { RequestContextSource } from './emr-runtime/request-context';
import { OrthancService } from './orthanc.service';
import type { AdmittedStudy } from './pacs/dicom-gateway';

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
const PATIENT_OUTDATED = Object.freeze({ code: 'ImageCurrentStudyChanged', message: '검사의 현재 환자 정보가 바뀌었습니다. 영상을 다시 열어 주세요.' });
/** The read serves another patient than the study's current one (E's manifest is outdated, or the study was corrected
 * after the read's gate looked), or the source its route selected is another patient's: no byte goes out under that
 * record. E rebuilds its manifest on this answer (service.ts). */
export class StudyChanged extends ConflictException { constructor() { super(PATIENT_OUTDATED); } }

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
 * What one image read serves: its study, the patient its bytes are of and, for a route that serves the objects of one
 * verified manifest (E), that manifest's digest. A route that reads the archive as it is (the frame reader, the preview,
 * the relay) has no manifest: its patient is the one its gate observed for the request (`archiveRead`). The archive's
 * revision is not the route's to name; the recorder reads it for every lease. `provision` is what E decides with the
 * lease's current facts on their own transaction (its provision basis and account generation); the other routes have
 * none.
 */
export interface DeliveryTarget<P = null> {
  studyUid: string; patient: PatientLinkSnapshot; manifest: string | null;
  provision?: (tx: EmrRecordTransaction, current: Omit<CurrentDeliveryFacts<null>, 'provision'>) => Promise<P>;
}

/**
 * The current facts one lease decided on, read once after the lease read the archive's revision (I2): who reads
 * (identity, roles, institution, request), the study's current scope and patient, and what the route decided with them
 * on the same transaction (E's provision). The opening event is built from them and E prepares its response from them;
 * neither reads them again, and an open delivery is never a substitute for them.
 */
export interface CurrentDeliveryFacts<P = unknown> {
  readonly at: string;
  readonly facts: ClinicalRequestFacts;
  readonly study: StudyFacts;
  readonly provision: P;
}

/**
 * What a delivery records and serves: the patient, the archive's revision of the study its event names
 * (`orthanc-study:<resource>@<LastUpdate>`), and E's manifest digest once an E read opened or joined it. The digest is a
 * witness of E's bytes, kept in E's own rows, not another name of the revision; a delivery's first one stays.
 */
export interface DeliveryBinding { readonly patient: PatientLinkSnapshot; readonly revision: string; readonly manifest: string | null }

/**
 * The target of a read that serves the archive as it is: the study and the patient the DICOMweb gate observed in the
 * archive for this very request (PacsDicomGateway.authzDicom). A study whose original resources name no patient has no
 * image a record could name.
 */
export function archiveRead(admitted: AdmittedStudy | undefined): DeliveryTarget {
  if (!admitted) throw new ForbiddenException('열람 권한이 없습니다');
  if (!admitted.sourcePatientId) throw new NotFoundException({
    code: 'IMAGE_SOURCE_IDENTITY_UNAVAILABLE',
    message: '원본 검사의 환자 식별자(PatientID)를 확인할 수 없어 영상을 제공할 수 없습니다. 관리자에게 환자 정보 등록·정정을 요청한 후 검사를 다시 열어 주세요.',
  });
  return { studyUid: admitted.studyUid, patient: studyPatientLink(admitted.managingInstitutionId, admitted.sourcePatientId), manifest: null };
}

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
 * the delivery's durable provide-prepared event, for a route that keeps per-response rows naming it (E), `binding`
 * what the delivery records and `current` the facts this lease decided on. `confirm` is for a source selected after the
 * lease read the revision - what a relayed Orthanc answer is of, or an object the frame reader selected again - before
 * a byte of it: true when the archive held the same revision when the lease read it and after the selection, so the
 * selection was of it; false when the same patient's study has a newer revision - the lease then holds that revision's
 * delivery (a new opening durable first), and the route selects its source again, sending nothing it already selected;
 * another patient retires the delivery and is refused (StudyChanged). `retire` ends the delivery for a route that
 * found its binding outdated (E forgetting its manifest): it closes once its responses have, and the next read opens a
 * new one. A lease is released exactly once, when its response has ended: the delivery cannot close before (not even
 * at the stop).
 */
export interface DeliveryLease<P = unknown> {
  readonly record: DeliveryRecord;
  readonly binding: DeliveryBinding;
  readonly current: CurrentDeliveryFacts<P>;
  confirm(): Promise<boolean>;
  release(served: boolean, owed?: OwedFacts): void;
  retire(): void;
}

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
 * The study an image answer was recorded for, on the routes whose path names a stored object rather than its study
 * (`/instances/{id}/...`: a rendering, a document, a preview). The viewer relates such a read to the study it shows, so a
 * new opening of that study reads it live again before what the document still holds of it can show (viewer-preload.js
 * `reenter`). The server's own resolution of the object, the one its record names; the viewer sends it nowhere.
 */
export const RECORDED_STUDY_HEADER = 'X-KIN-Study-UID';
/** The archive revision of the bytes a preload store/check is actually served under. */
export const REVISION_HEADER = 'X-KIN-Study-Revision';

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
  /** What it records: its opening read's patient and revision, and the first manifest an E read served under it. */
  binding: DeliveryBinding;
  /** What the archive held once the opening receipt was durable, for the reads that waited on it (admit()). */
  held: Promise<Held> | null;
  /** Resolves once the provide-prepared event is durable; rejects when it could not be recorded. */
  prepared: Promise<DeliveryRecord>;
  event: Readonly<AccessEventV1> | null;
  inflight: number; served: number; unserved: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Out of `open`: a read of another patient or manifest superseded it, or its route retired it. Closes once nothing is
   * in flight. */
  retired: boolean;
  closed: boolean;
  /** The stop is waiting for it to close (stop()). */
  onClose: (() => void) | null;
  /** Still sending when the stop's drain allowance ended: it gets no terminal (stop()). */
  unsettled: boolean;
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

/** What the archive holds against a delivery's binding: the same, a newer revision of the same patient's study, another patient. */
type Held = 'current' | 'revision' | 'patient';
/** A response's place in a delivery: the delivery, its durable record and the current facts the response decided on. */
interface Place<P> { delivery: Delivery; record: DeliveryRecord; current: CurrentDeliveryFacts<P> }
const known = <T>(value: T) => ({ status: 'known' as const, value });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const samePatient = (a: PatientLinkSnapshot, b: PatientLinkSnapshot) =>
  a.linkId === b.linkId && a.patientId === b.patientId && a.assigningAuthority === b.assigningAuthority;
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

  /** `checks`: the bounded pool of per-response check transactions (emr-image/check-db.ts), on which every lease reads
   * its current facts - not a ledger append lane, which those reads at frame rate would saturate. */
  constructor(@Inject(EMR_RECORD_PORT) private readonly records: EmrRecordPort,
    @Inject(REQUEST_CONTEXT_SOURCE) private readonly requests: RequestContextSource,
    @Inject(CURRENT_CLINICAL_CONTEXT) private readonly clinical: ClinicalContextSource,
    @Inject(EMR_BACKGROUND_WORK) private readonly background: BackgroundWork,
    private readonly orthanc: OrthancService,
    @Optional() @Inject(IMAGE_DELIVERY_IDLE_MS) idleMs: number | undefined,
    private readonly checks: ImageCheckDatabase) {
    this.idleMs = typeof idleMs === 'number' && idleMs > 0 ? idleMs : DEFAULT_IMAGE_DELIVERY_IDLE_MS;
  }

  /**
   * The lease of one response to an image route, or null for a response that delivers no image: a HEAD (no body; Node
   * drops it) and a description (QIDO, DICOMweb metadata, tags; `imageRead`). Neither opens a delivery nor counts in
   * one - a 200 HEAD beside reads that all failed would turn an aborted delivery into a provided one (review INT-01,
   * R244-GPT-FIX6-01). Every image route asks here with its request path, so the rule is this one, not each route's.
   * `target` is what the read serves (its study, the patient the route's gate or manifest names, E's manifest digest);
   * it is only asked for a delivery.
   */
  async lease<P = null>(request: IncomingMessage, surface: string, path: string,
    target: () => DeliveryTarget<P> | Promise<DeliveryTarget<P>>, use: DeliveryUse = readUse(request)): Promise<DeliveryLease<P> | null> {
    if (request.method !== 'GET' || !imageRead(path)) return null;
    return this.admit(request, surface, await target(), use);
  }

  /**
   * The delivery this request belongs to, with its provide-prepared event durable. The first request of a member
   * session for a study and use records the event; the requests that arrive while it is being recorded wait for the same
   * receipt; later ones find the open delivery. Resolves only after the receipt - the caller sends no byte before.
   *
   * Every lease reads the archive's revision of the study now; with the patient the route names (and E's manifest) it
   * is what this read's bytes are of. Then it reads the current facts it decides on (current()) - a join as much as an
   * opening: a study the member may no longer see, or whose patient is no longer the read's, is refused here before
   * any source read, whatever delivery is open (R244-GPT-FIX10-02). A read joins only a delivery recording exactly that
   * patient and revision whose manifest, if it has one, is the read's: any other open one is superseded - retired, it
   * ends with its own responses - and the read opens its own, so no event names a patient or revision other than the
   * one whose bytes it covers (R244-GPT-FIX9-02). A read that waited for an opening receipt had its patient and
   * revision observed before an unbounded wait: it is served only once the archive still holds them after the receipt,
   * and only by a delivery that is still open. A read whose patient is no longer the study's is refused; one whose
   * study only has a newer revision takes the delivery of that revision (R244-GPT-FIX9-01).
   */
  private async admit<P>(request: IncomingMessage, surface: string, target: DeliveryTarget<P>, use: DeliveryUse): Promise<DeliveryLease<P>> {
    let place: Place<P> | null = await this.place(request, surface, target, use), released = false;
    const recorder = this;
    return {
      get record() { return place!.record; },
      get binding() { return place!.delivery.binding; },
      get current() { return place!.current; },
      retire: () => { if (place) this.retire(place.delivery); },
      async confirm() {
        const delivery = place!.delivery, held = await recorder.holds(delivery);
        if (held === 'current') return true;
        recorder.retire(delivery);
        if (held === 'patient') throw new StudyChanged();
        // The same patient's study got a newer revision (images still arriving): what the source selected may be of
        // either, so it is not served. The read gives its place back unserved and takes the lease of the revision the
        // archive holds now; its route selects again under that one.
        place = null;
        recorder.give(delivery, false);
        place = await recorder.place(request, surface, target, use);
        return false;
      },
      release: (served, owed) => {
        if (released || !place) return;
        released = true;
        this.give(place.delivery, served, owed);
      } };
  }

  /** A response gives its place in the delivery back: once, after it ended (DeliveryLease.release). */
  private give(delivery: Delivery, served: boolean, owed?: OwedFacts): void {
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
  }

  /** The admission of admit(): the delivery this read takes its place in, its durable record and the read's current facts. */
  private async place<P>(request: IncomingMessage, surface: string, target: DeliveryTarget<P>, use: DeliveryUse): Promise<Place<P>> {
    for (;;) {
      let key: string, binding: DeliveryBinding, current: CurrentDeliveryFacts<P>, delivery: Delivery | undefined, opened = false;
      try {
        // Another provider's shutdown may still be running while the port admits work; a read let in now would open a
        // delivery the stop has already passed over, a pair without its end. No pair, so no byte.
        if (this.stopping) throw new ServiceUnavailableException(IMAGE_DELIVERY_UNAVAILABLE);
        const snapshot = this.requests.read(request);
        key = JSON.stringify([snapshot.issuer, snapshot.subject, snapshot.binding.sessionRef, target.studyUid, use.kind,
          use.kind === 'view' ? use.opening : null]);
        binding = { patient: target.patient, revision: await this.revision(target.studyUid), manifest: target.manifest };
        // An open delivery of another patient, revision or manifest is outdated by the archive whether or not this read
        // is let in: it is superseded before this read's own decision.
        delivery = this.open.get(key);
        if (delivery && !this.compatible(delivery, binding)) this.retire(delivery);
        current = await this.current(request, target);
        if (this.stopping) throw new ServiceUnavailableException(IMAGE_DELIVERY_UNAVAILABLE);
        delivery = this.open.get(key);
        if (delivery && !this.joins(delivery, binding)) { this.retire(delivery); delivery = undefined; }
        if (!delivery) { delivery = this.start(key, target.studyUid, surface, binding, current, use); opened = true; }
      } catch (error) { throw this.unavailable(error); }
      if (delivery.timer) { clearTimeout(delivery.timer); delivery.timer = null; }
      delivery.inflight++;
      const waited = delivery.event === null;
      let record: DeliveryRecord;
      try { record = await delivery.prepared; }
      catch (error) {
        delivery.inflight--;
        if (delivery.event) this.settle(delivery);
        // Another read's opening found the study's patient changed from the one that read serves; this read's own
        // patient may be the current one, so it opens its own delivery rather than inherit that refusal.
        if (!opened && error instanceof StudyChanged) continue;
        throw this.unavailable(error);
      }
      let held: Held = 'current';
      if (waited && !delivery.retired) {
        // One archive read after the receipt answers for every read that waited on it: they serve the same binding.
        try { held = await (delivery.held ??= this.holds(delivery)); }
        catch (error) { this.drop(delivery); throw this.unavailable(error); }
        if (held !== 'current') this.retire(delivery);
      }
      if (held === 'patient') { this.drop(delivery); throw new StudyChanged(); }
      // Retired while this read waited (superseded, forgotten by E, or just found outdated): no byte under it; the read
      // asks again with the archive as it is now.
      if (delivery.retired || delivery.closed) { this.drop(delivery); continue; }
      return { delivery, record, current };
    }
  }

  /** The archive's revision of the study now, as the delivery's event names it. */
  private async revision(studyUid: string): Promise<string> {
    return revisionId(await this.orthanc.studyRevision(studyUid));
  }

  /**
   * The current facts of one lease, read once after its revision, on one bounded transaction of the check pool:
   * identity, institution scope, StudyAccess and the study's current patient - D's study read, as every clinical route
   * reads it - and E's provision decided from those same facts. A study the member may no longer see is refused with the
   * answer the clinical routes give; one whose current patient is not the one the read serves, as StudyChanged. The
   * opening event and E's preparation take this result; nothing reads it again for them.
   */
  private async current<P>(request: IncomingMessage, target: DeliveryTarget<P>): Promise<CurrentDeliveryFacts<P>> {
    const at = new Date().toISOString();
    return this.checks.$transaction(async tx => {
      await boundEmrStatements(tx);
      const facts = await this.clinical.facts(tx, request);
      if (facts.actor.kind !== 'member') throw new ServiceUnavailableException(CONTEXT_UNAVAILABLE);
      const study = await this.clinical.study(tx, request, target.studyUid);
      if (!samePatient(study.patient, target.patient)) throw new StudyChanged();
      const provision = target.provision ? await target.provision(tx, { at, facts, study }) : null as P;
      return { at, facts, study, provision };
    }, { maxWait: EMR_TX_MAX_WAIT_MS, timeout: EMR_TX_TIMEOUT_MS });
  }

  /**
   * Whether a read of `binding` may join this open delivery: the same patient and revision, and no other manifest. A
   * read of the archive as it is has no manifest and joins on its patient and revision alone, never as a wildcard. The
   * first E read of a delivery a read of the archive opened is found current by that same comparison and registers its
   * manifest; another manifest later supersedes it.
   */
  private joins(delivery: Delivery, binding: DeliveryBinding): boolean {
    if (!this.compatible(delivery, binding)) return false;
    if (delivery.binding.manifest === null && binding.manifest !== null) delivery.binding = { ...delivery.binding, manifest: binding.manifest };
    return true;
  }

  /** joins() without registering the read's manifest. */
  private compatible(delivery: Delivery, binding: DeliveryBinding): boolean {
    const recorded = delivery.binding;
    if (!samePatient(recorded.patient, binding.patient) || recorded.revision !== binding.revision) return false;
    return binding.manifest === null || recorded.manifest === null || recorded.manifest === binding.manifest;
  }

  /**
   * What the archive holds now against what the delivery records: the same, a newer revision of the same patient's
   * study, or another patient. Read from the archive itself, never from the open record (R244-GPT-FIX9-01).
   */
  private async holds(delivery: Delivery): Promise<Held> {
    const [revision, patientId] = await Promise.all([this.revision(delivery.studyUid),
      this.orthanc.studyPatientIdentity(delivery.studyUid)]);
    if (patientId !== delivery.binding.patient.patientId) return 'patient';
    return revision === delivery.binding.revision ? 'current' : 'revision';
  }

  /** A read that will not be served under this delivery gives back the place it took. */
  private drop(delivery: Delivery): void {
    delivery.inflight--;
    this.settle(delivery);
  }

  private start(key: string, studyUid: string, surface: string, binding: DeliveryBinding, current: CurrentDeliveryFacts, use: DeliveryUse): Delivery {
    const delivery: Delivery = { key, studyUid, use, binding, held: null, prepared: null as any, event: null,
      inflight: 0, served: 0, unserved: 0, timer: null, retired: false, closed: false, onClose: null, unsettled: false,
      owed: [], terminal: null, ended: false, attempts: 0, recording: null, reoffer: false, cancelRetry: null, reserved: null };
    delivery.prepared = this.prepare(surface, delivery.studyUid, binding, current, use, key).then(record => { delivery.event = record.event; return record; });
    // A delivery that could not be recorded is no delivery: the next read asks the ledger again; retired, it has nothing
    // to close, and a stop waiting for it has nothing to wait for.
    delivery.prepared.catch(() => {
      if (this.open.get(key) === delivery) this.open.delete(key);
      this.retiring.delete(delivery);
      delivery.closed = true;
      delivery.onClose?.();
    });
    this.open.set(key, delivery);
    return delivery;
  }

  /**
   * The opening event, built from the current facts its lease decided on (current()) and the revision it read - not a
   * second read of either - and made durable.
   */
  private async prepare(surface: string, studyUid: string, binding: DeliveryBinding, { facts, study }: CurrentDeliveryFacts,
    use: DeliveryUse, key: string): Promise<DeliveryRecord> {
    const work = this.records.begin();
    try {
      const at = new Date().toISOString();
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
          recordId: known(studyUid), versionId: known(binding.revision) }],
        action: 'provide-prepared', result: 'prepared', requestId: facts.requestId, auditLinkId: newAuditLinkId(), relatedEventId: root }) as Readonly<AccessEventV1>;
      if (use.kind !== 'view') {
        const prepared = event(false, null);
        return { event: prepared, receipt: await this.append(work, prepared, randomUUID()) };
      }
      // A newer binding may retire this opening's delivery while its root is still being written. Let that attempt
      // settle before asking the ledger for the root; otherwise an invisible/pending root races a second append.
      // A failed attempt is resolved by the same lookup below, not inherited as this delivery's failure.
      await Promise.allSettled([...this.retiring].filter(delivery => delivery.key === key).map(delivery => delivery.prepared));
      for (let attempt = 0; ; attempt++) {
        const operationId = rootOperation(key, attempt);
        const stored = await work.lookup(operationId);
        if (!stored) {
          const root = event(true, null);
          return { event: root, receipt: await this.append(work, root, operationId) };
        }
        if (stored.outcome === 'committed') {
          const continued = event(false, stored.eventId);
          return { event: continued, receipt: await this.append(work, continued, randomUUID()) };
        }
        // An unresolved root must settle before any bytes of this opening can be shown.
        if (stored.outcome !== 'negative') throw new Error('ImageOpeningRootUnsettled');
      }
    } finally { work.end(); }
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
   * one, or any once the process is stopping (the stop waits for it), ends now; one the stop left unsettled never. */
  private settle(delivery: Delivery): void {
    if (delivery.closed || delivery.unsettled || delivery.inflight > 0 || delivery.timer) return;
    if (delivery.retired || this.stopping) { void this.close(delivery); return; }
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
   * Ends the delivery, once nothing is in flight (settle): its terminal is built at once - before any await, so a stop
   * that begins afterwards finds it owed - with what its responses served and handed over. A delivery is closed only
   * after its opening read held a lease, so its preparation has succeeded; one whose preparation failed has no event to
   * close (start()).
   */
  private close(delivery: Delivery): Promise<void> {
    if (delivery.closed) return Promise.resolve();
    delivery.closed = true;
    if (delivery.timer) { clearTimeout(delivery.timer); delivery.timer = null; }
    if (this.open.get(delivery.key) === delivery) this.open.delete(delivery.key);
    this.retiring.delete(delivery);
    delivery.onClose?.();
    if (delivery.event) return this.finish(delivery, delivery.event);
    return delivery.prepared.then(record => this.finish(delivery, record.event), () => undefined);
  }

  /**
   * The terminal event of the pair, built once. `transfer-ended` only when at least one response of the delivery sent
   * its image completely; a delivery whose every response failed, was refused by the source or was cut short is
   * `transfer-aborted` (MG-10). The event's time is the close, not the append that eventually holds it.
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
   * Every open delivery ends with the process once its responses have - a quiet one at once, one still sending when its
   * last response releases its lease, so its terminal says what was served and goes with the facts those responses hand
   * over (R244-GPT-FIX8-02) - and every terminal still owed gets one more offer, with the facts its delivery still owes;
   * one that still fails is logged with its event IDs and stays in the store's failure journal - the stop does not
   * report it as a complete pair - and facts still unwritten are named. The wait for responses still in flight is the
   * shutdown's drain allowance (SHUTDOWN_DRAIN_MS, the rest of its deadline being cleanup); a delivery still sending
   * after it is left without a terminal and logged: what it served and owes is not known, and a closing event is not
   * written on a guess.
   *
   * Nest awaits every onModuleDestroy before any beforeApplicationShutdown, where EmrNestLifecycle closes record
   * admission, and closes the HTTP server only after every beforeApplicationShutdown: responses in flight go on while the
   * stop waits for them. So admission to this recorder closes here, synchronously, and the ledger work of every terminal
   * the stop may owe - open and retired deliveries, prepared or still being prepared, and closed ones not durable yet -
   * is admitted before the first await. The port keeps admitted work through its close and the runtime's drain waits
   * for it. Each reservation is ended once, after the stop's last offer on it, whether that offer used it, an earlier one
   * failed on it, or the delivery turned out to owe nothing.
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
    // Each ends now when nothing is in flight, else at its last release (settle, while stopping).
    const ended = opened.map(delivery => new Promise<void>(resolve => {
      delivery.onClose = resolve;
      if (delivery.timer) { clearTimeout(delivery.timer); delivery.timer = null; }
      this.settle(delivery);
    }));
    return (async () => {
      let allowance: ReturnType<typeof setTimeout>;
      await Promise.race([Promise.all(ended), new Promise<void>(resolve => { allowance = setTimeout(resolve, SHUTDOWN_DRAIN_MS); })]);
      clearTimeout(allowance);
      for (const delivery of opened) if (!delivery.closed) {
        delivery.unsettled = true;
        this.logger.error(`image_delivery category=delivery_unsettled_at_shutdown prepared=${delivery.event?.eventId ?? 'pending'} ` +
          `inflight=${delivery.inflight} served=${delivery.served} unserved=${delivery.unserved}`);
      }
      // An offer already in flight settles first; whatever is still owed is offered once more.
      await Promise.allSettled([...owed].map(delivery => delivery.recording ?? Promise.resolve()));
      await Promise.allSettled([...owed].filter(delivery => (delivery.terminal && !delivery.ended) || delivery.owed.length)
        .map(delivery => this.record(delivery)));
      // A response released after the allowance may still be offering its facts on the reservation: it ends after that.
      await Promise.allSettled([...owed].map(async delivery => {
        const work = delivery.reserved;
        if (!work) return;
        delivery.reserved = null;
        await delivery.recording?.catch(() => undefined);
        work.end();
      }));
      for (const delivery of owed) {
        const prepared = delivery.event?.eventId ?? 'pending';
        if (delivery.terminal && !delivery.ended) this.logger.error(`image_delivery category=terminal_not_recorded_at_shutdown ` +
          `event=${delivery.terminal.event.eventId} prepared=${prepared} attempts=${delivery.attempts}`);
        if (delivery.owed.length) this.logger.error(`image_delivery category=facts_not_written_at_shutdown prepared=${prepared} ` +
          `facts=${JSON.stringify(delivery.owed.map(fact => fact.names))}`);
      }
    })();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.onModuleDestroy();
    await this.shutdown;
  }
}
