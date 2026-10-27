import { Inject, Injectable, ServiceUnavailableException, BadRequestException, ConflictException } from '@nestjs/common';
import type { BeforeApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { AccessEvent } from '../emr-contract/access-event';
import { newAuditLinkId, parseAccessEvent } from '../emr-contract/access-event';
import { refuse } from '../emr-contract/validation';
import { BackgroundWork, EMR_BACKGROUND_WORK } from '../emr-runtime/background-work';
import { EMR_RECORD_PORT, EmrRecordPort, EmrRecordTransaction, EmrRecordWork } from '../emr-runtime/record-port';
import { REQUEST_CONTEXT_SOURCE, RequestContextSource, RequestFacts } from '../emr-runtime/request-context';
import { OrthancService } from '../orthanc.service';
import { PrismaService } from '../prisma.service';
import { ImageRequest, parseImageRequest, prepareDelivery } from './contract';
import { CurrentImageFacts, ImageContextSource } from './context';
import { DeliveryClosing, DeliveryOutcome, ImageDeliveries, OpenedDelivery, ResponseEnd } from './delivery';
import type { ImageManifest } from './manifest';
import { ManifestReuse } from './manifest-reuse';
import { PgImageEvidenceStore } from './store';
import { sendOnlineImage, UnstoredObservation } from './stream';

const known = <T>(value: T) => ({ status: 'known' as const, value });
// The kept manifest no longer describes the source or the current study: the next request rebuilds it.
const SOURCE_CHANGED = ['ImageCurrentStudyChanged', 'ImageSourceMismatch', 'ImageSourcePatientChanged', 'ScopeOutsideManifest', 'FrameOutOfManifest'];
const sourceChanged = (error: any) => error instanceof ConflictException || SOURCE_CHANGED.includes(error?.code) ||
  error instanceof AggregateError && error.errors.some(sourceChanged);

/** What a delivery was opened with, kept to compare every later response's current facts against it. */
interface DeliveryFacts { facts: CurrentImageFacts; work: EmrRecordWork }
interface Opener { request: any; manifest: ImageManifest; facts: RequestFacts }

function sameAuthority(current: CurrentImageFacts, opened: CurrentImageFacts, manifest: ImageManifest): boolean {
  return current.actor.identity.id === opened.actor.identity.id && current.actor.identity.issuer === opened.actor.identity.issuer &&
    current.actor.identity.subject === opened.actor.identity.subject &&
    current.actor.institutionId === opened.actor.institutionId && current.accountGeneration === opened.accountGeneration &&
    current.actor.roles.length === opened.actor.roles.length && current.actor.roles.every(role => opened.actor.roles.includes(role)) &&
    current.provision.deliverable && current.provision.studyUid === manifest.studyUid &&
    current.provision.managingInstitution === manifest.managingInstitution && current.provision.recipient === opened.provision.recipient &&
    current.provision.relation === opened.provision.relation && current.provision.basisId === opened.provision.basisId &&
    current.provision.agreementId === opened.provision.agreementId;
}

@Injectable()
export class OnlineImageService implements BeforeApplicationShutdown {
  private readonly manifests = new ManifestReuse();
  private readonly deliveries: ImageDeliveries<DeliveryFacts, Opener>;
  private readonly evidence: PgImageEvidenceStore;
  constructor(@Inject(EMR_RECORD_PORT) private readonly records: EmrRecordPort,
    private readonly context: ImageContextSource, private readonly db: PrismaService,
    private readonly orthanc: OrthancService, @Inject(REQUEST_CONTEXT_SOURCE) private readonly requests: RequestContextSource,
    @Inject(EMR_BACKGROUND_WORK) background: BackgroundWork) {
    this.evidence = new PgImageEvidenceStore(db);
    this.deliveries = new ImageDeliveries<DeliveryFacts, Opener>(background, {
      open: (_key, opener) => this.openDelivery(opener),
      close: (delivery, outcome, closing) => this.closeDelivery(delivery, outcome, closing),
    });
  }

  /** Idle deliveries close now; one with responses in flight closes when they end, before the ledger drains. Rows an
   * earlier closing could not retain get one more transaction here; what still fails is reported with its delivery. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.deliveries.closeAll();
    await this.retainPending();
    for (const entry of this.unretained) console.error('[EMR-E] image observations not retained at shutdown', JSON.stringify({
      deliveryEventId: entry.deliveryEventId, responses: entry.rows.map(row => [row.kind, row.link.eventId, row.link.requestId]) }));
  }

  async send(request: any, response: ServerResponse, target: string) {
    let image: ReturnType<typeof parseImageRequest>;
    try { image = parseImageRequest(request.method, target); }
    catch { throw new BadRequestException('영상 요청 경로를 확인하세요'); }
    if (!process.env.KIN_EMR_STATE_DIR) throw new ServiceUnavailableException('영상 임시 저장소를 확인할 수 없습니다');
    const abort = new AbortController();
    const stop = () => { if (!response.writableFinished) abort.abort(); };
    request.once('aborted', stop); response.once('close', stop);
    let kept: ImageManifest | undefined;
    try {
      const manifest = kept = await this.manifests.manifest(image, () => this.context.manifest(request, image, abort.signal), abort.signal);
      // The request's member identity is resolved once, under its own append admission. Left to the first current()
      // below, it would wait for a lane while that transaction holds one: with as many simultaneous frames as lanes,
      // none proceeds (served CT series, run e-route-green-opus-20261026c). A kept manifest skips the catalog read
      // that used to resolve it first.
      const facts = await this.requests.facts(request);
      const stagingDirectory = join(process.env.KIN_EMR_STATE_DIR, 'image-staging');
      await mkdir(stagingDirectory, { recursive: true });
      // One access record per requester, rights, session, address and manifest version (delivery.ts).
      const key = JSON.stringify([facts.actor.id, facts.actor.issuer, facts.actor.subject, facts.institution, facts.rightsVersion,
        [...facts.roles].sort(), facts.binding.method, facts.binding.sessionRef, facts.ingress, manifest.sha256]);
      const lease = await this.deliveries.join(key, { request, manifest, facts }, abort.signal);
      let end: ResponseEnd = 'not-sent', bytesWritten = 0;
      const unstored: UnstoredObservation[] = [];
      try {
        const result = await sendOnlineImage({ records: this.records, evidence: this.evidence,
          source: this.orthanc.imageSource(), stagingDirectory }, {
          manifest, delivery: lease.delivery, requestId: facts.requestId,
          // A row the application connection refused goes to the delivery, which writes it when it closes.
          unstored: row => unstored.push(row),
          // This response's current access check, on its own bounded ledger transaction, before any source read:
          // identity, institution scope, StudyAccess and provision (context.ts recheck); the archive's current
          // patient identity of the object is compared by the source and the stream outside the lane.
          prepare: async (tx: EmrRecordTransaction) => {
            const at = new Date().toISOString();
            let current: CurrentImageFacts;
            try { current = await this.context.recheck(tx, request, manifest, at); }
            catch (error) { lease.retire(); throw error; }
            if (!sameAuthority(current, lease.delivery.facts.facts, manifest)) { lease.retire(); refuse('ImageAuthorityChanged'); }
            return prepareDelivery(manifest, image, { eventId: randomUUID(), deliveryEventId: lease.delivery.event.eventId, at,
              cause: 'background-fetch', opening: null,
              authorization: { studyUid: image.studyUid, institution: current.actor.institutionId, accountGeneration: current.accountGeneration },
              provision: current.provision });
          },
          response, signal: abort.signal, range: request.headers.range });
        end = result.terminal; bytesWritten = result.bytesWritten;
        return result;
      } finally { lease.end(end, bytesWritten, unstored); }
    } catch (error) {
      if (kept && sourceChanged(error)) this.manifests.forget(image.studyUid, kept);
      throw error;
    } finally { request.off('aborted', stop); response.off('close', stop); }
  }

  /** The study delivery's access record: E's provide-prepared event for the whole manifest version, admitted,
   * committed with the opener's current access check on the same transaction, and confirmed durable, before any
   * response of the delivery is prepared. The same admission/transaction/confirmation that each frame used to take. */
  private async openDelivery({ request, manifest, facts }: Opener): Promise<OpenedDelivery<DeliveryFacts>> {
    const work = this.records.begin();
    try {
      const at = new Date().toISOString(), eventId = randomUUID();
      const study: ImageRequest = parseImageRequest('GET', `/dicom-web/studies/${manifest.studyUid}`);
      let current!: CurrentImageFacts, prepared!: ReturnType<typeof prepareDelivery>;
      // The first access check is also the pre-read authorization of this delivery's source reads.
      await work.transactionWithRecords(async tx => {
        current = await this.context.current(tx, request, manifest, at);
        prepared = prepareDelivery(manifest, study, { eventId, at, cause: 'background-fetch', opening: null,
          authorization: { studyUid: manifest.studyUid, institution: current.actor.institutionId, accountGeneration: current.accountGeneration },
          provision: current.provision });
      });
      // One target per record kind the delivery may carry, naming the study and this manifest version. The manifest
      // body (kept once, emr_image.source_manifest) lists every object; a B2 payload is bounded and cannot.
      const kinds = [...new Set(prepared.units.map(unit => unit.recordKind))];
      const event = parseAccessEvent({ formatVersion: 1, surface: `GET images/dicom-web`, eventId,
        userId: known(current.actor.identity), rolesAtTime: known(current.actor.roles), actingInstitution: known(current.actor.institutionId),
        managingInstitution: known(manifest.managingInstitution), occurredAt: at, trustedProxyIp: current.ip,
        cause: 'background-fetch', context: { basis: 'background-fetch', studyId: null, relatedStudyId: null, reason: null },
        executor: 'member', targets: kinds.map(kind => ({ kind, patientLinkSnapshot: known(manifest.patient),
          studyId: known(manifest.studyUid), recordId: known(manifest.studyUid), versionId: known(manifest.sha256) })),
        action: 'provide-prepared', result: 'prepared', requestId: facts.requestId, auditLinkId: newAuditLinkId(), relatedEventId: null });
      const operation = await work.admit(event, undefined, { operationId: eventId, attemptId: eventId });
      const result = await work.transaction(operation, async tx => {
        const again = await this.context.current(tx, request, manifest, new Date().toISOString());
        if (!sameAuthority(again, current, manifest)) refuse('ImageAuthorityChanged');
        return { kind: 'emr-image', id: eventId, version: manifest.sha256 };
      });
      if (result.outcome !== 'committed' || result.result?.kind !== 'emr-image' || result.result.id !== eventId ||
          result.result.version !== manifest.sha256) refuse('ImageEventMismatch');
      const receipt = await work.confirm({ provisional: true, operationId: operation.operationId, eventId });
      return { event, receipt, prepared, facts: { facts: current, work } };
    } catch (error) {
      work.end();
      throw error;
    }
  }

  /** The delivery's terminal event, related to its provide-prepared event, from what E observed on its responses.
   * Rows of its responses that the application connection refused are written as the effect of that terminal
   * operation, on its ledger transaction: the terminal event exists only if every response's facts are retained, and
   * a retention failure is the admitted operation's own rollback (B2 journals it against the terminal event, whose
   * payload names the delivery), not a silently closed record (R244-GPT-02). A delivery whose ending has no v1 action
   * retains its rows on a ledger transaction of its own. Rows a closing could not retain stay with this service and
   * are retried before the next close and at shutdown (retainPending): the entry is retired, the facts are not. */
  private async closeDelivery(delivery: OpenedDelivery<DeliveryFacts>, outcome: DeliveryOutcome, closing: DeliveryClosing): Promise<void> {
    const { work } = delivery.facts;
    try {
      await this.retainPending();
      const rows = [...outcome.unstored];
      if (closing === null && !rows.length) return;
      const followup: AccessEvent | null = closing === null ? null : parseAccessEvent({ ...delivery.event, eventId: randomUUID(),
        relatedEventId: delivery.event.eventId, action: closing, result: closing === 'transfer-ended' ? 'succeeded' : 'aborted',
        occurredAt: new Date().toISOString() });
      try {
        await work.transactionWithRecords(async (tx, record) => {
          const retain = async () => { for (const row of rows) await this.evidence.retain(tx, row); };
          if (!followup) return retain();
          await record(followup, async () => {
            await retain();
            return { kind: 'emr-image', id: delivery.event.eventId, version: delivery.prepared.manifestSha256 };
          });
        });
      } catch (error) {
        if (rows.length) this.keepUnretained(delivery.event.eventId, rows, error);
        throw error;
      }
    } finally { work.end(); }
  }

  /** Rows of closed deliveries that no closing transaction has retained yet, oldest first. Bounded: a store that
   * refuses for longer than this holds is reported, not swallowed into memory. */
  private readonly unretained: { deliveryEventId: string; rows: UnstoredObservation[] }[] = [];
  private static readonly UNRETAINED_LIMIT = 1024;
  private keepUnretained(deliveryEventId: string, rows: UnstoredObservation[], error: unknown): void {
    this.unretained.push({ deliveryEventId, rows });
    let held = this.unretained.reduce((n, entry) => n + entry.rows.length, 0);
    while (held > OnlineImageService.UNRETAINED_LIMIT && this.unretained.length > 1) {
      const dropped = this.unretained.shift()!;
      held -= dropped.rows.length;
      console.error('[EMR-E] image observations dropped: retention refused beyond the held bound', JSON.stringify({
        deliveryEventId: dropped.deliveryEventId, responses: dropped.rows.map(row => [row.kind, row.link.eventId, row.link.requestId]) }));
    }
    console.error('[EMR-E] image observations held for a later retention', JSON.stringify({ deliveryEventId, rows: rows.length,
      cause: (error as any)?.code ?? (error as any)?.message ?? String(error) }));
  }
  /** One ledger transaction per held delivery; what still fails stays held, in order. */
  private async retainPending(): Promise<void> {
    const held = this.unretained.splice(0);
    for (const entry of held) {
      try {
        const work = this.records.begin();
        try { await work.transactionWithRecords(async tx => { for (const row of entry.rows) await this.evidence.retain(tx, row); }); }
        finally { work.end(); }
      } catch { this.unretained.push(entry); }
    }
  }
}
