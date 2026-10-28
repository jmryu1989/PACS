import { Inject, Injectable, ServiceUnavailableException, BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { EMR_TX_MAX_WAIT_MS, EMR_TX_TIMEOUT_MS, boundEmrStatements } from '../emr-runtime/limits';
import { REQUEST_CONTEXT_SOURCE, RequestContextSource, RequestContextUnavailable } from '../emr-runtime/request-context';
import { DeliveryLease, OwedFacts, StudyImageDeliveryRecorder } from '../image-delivery-record';
import { OrthancService } from '../orthanc.service';
import { PrismaService } from '../prisma.service';
import { ImageCheckDatabase } from './check-db';
import { parseImageRequest, prepareDelivery } from './contract';
import { ImageContextSource } from './context';
import type { ImageProvision } from './context';
import type { ImageManifest } from './manifest';
import { ManifestReuse } from './manifest-reuse';
import { PgImageEvidenceStore } from './store';
import { sendOnlineImage, UnstoredObservation } from './stream';

/** The surface of the study delivery's events when one of E's responses opens it. */
export const ONLINE_IMAGE_SURFACE = 'GET images/dicom-web';
// The kept manifest no longer describes the source or the current study: the next request rebuilds it.
const SOURCE_CHANGED = ['ImageCurrentStudyChanged', 'ImageSourceMismatch', 'ImageSourcePatientChanged', 'ScopeOutsideManifest', 'FrameOutOfManifest'];
const sourceChanged = (error: any) => error instanceof ConflictException || SOURCE_CHANGED.includes(error?.code) ||
  error instanceof AggregateError && error.errors.some(sourceChanged);

@Injectable()
export class OnlineImageService {
  private readonly manifests = new ManifestReuse();
  private readonly evidence: PgImageEvidenceStore;
  /** db: the application connection E's rows are written on. checks: the bounded pool of the per-response check
   * transactions (check-db.ts), apart from that pool and from the ledger's lanes. deliveries: the 열람 record every
   * image route shares (image-delivery-record.ts); it also writes the rows a response could not. */
  constructor(private readonly context: ImageContextSource, private readonly db: PrismaService,
    private readonly orthanc: OrthancService, @Inject(REQUEST_CONTEXT_SOURCE) private readonly requests: RequestContextSource,
    private readonly checks: ImageCheckDatabase, private readonly deliveries: StudyImageDeliveryRecorder) {
    this.evidence = new PgImageEvidenceStore(db);
  }

  async send(request: any, response: ServerResponse, target: string) {
    let image: ReturnType<typeof parseImageRequest>;
    try { image = parseImageRequest(request.method, target); }
    catch { throw new BadRequestException('영상 요청 경로를 확인하세요'); }
    if (!process.env.KIN_EMR_STATE_DIR) throw new ServiceUnavailableException('영상 임시 저장소를 확인할 수 없습니다');
    const abort = new AbortController();
    const stop = () => { if (!response.writableFinished) abort.abort(); };
    request.once('aborted', stop); response.once('close', stop);
    let kept: ImageManifest | undefined, lease: DeliveryLease<ImageProvision> | null = null;
    try {
      const manifest = kept = await this.manifests.manifest(image, () => this.context.manifest(request, image, abort.signal), abort.signal);
      // The request's member identity is resolved once, under its own append admission. Left to the first current()
      // below, it would wait for a lane while that transaction holds one: with as many simultaneous frames as lanes,
      // none proceeds (served CT series, run e-route-green-opus-20261026c). A kept manifest skips the catalog read
      // that used to resolve it first.
      const facts = await this.requests.facts(request);
      const stagingDirectory = join(process.env.KIN_EMR_STATE_DIR, 'image-staging');
      await mkdir(stagingDirectory, { recursive: true });
      // The 열람 record (의료법 제23조④, D1877) is the study delivery of this member session, one pair whichever routes
      // its reads take: the frame reader, the preview and the relay record into the same one (image-delivery-record.ts).
      // A response joins it - opening it, provide-prepared durable, when it is the session's first read of the study -
      // before any source read; a HEAD or a description takes no lease and is answered under no record. The delivery is
      // bound to this manifest's patient, the archive's current revision of the study and this manifest's digest: a
      // delivery of another patient, revision or manifest is never this response's record (R244-GPT-FIX7-01/FIX9-02).
      // The lease's current facts - read once for it, after the revision, on the image check pool - carry E's provision
      // decided on their own transaction (R244-GPT-FIX10-02).
      const held = lease = await this.deliveries.lease(request, ONLINE_IMAGE_SURFACE, target.split('?')[0],
        () => ({ studyUid: manifest.studyUid, patient: manifest.patient, manifest: manifest.sha256,
          provision: (tx, current) => this.context.provision(tx, request, current) }));
      let served = false;
      const unstored: UnstoredObservation[] = [];
      try {
        const result = await sendOnlineImage({ evidence: this.evidence, source: this.orthanc.imageSource(), stagingDirectory }, {
          manifest, delivery: held && { ...held.record, manifestSha256: held.binding.manifest }, requestId: facts.requestId,
          // A row the application connection refused is the delivery's to write (release below).
          unstored: row => unstored.push(row),
          // This response's current access decision before any source read: identity, institution scope, StudyAccess
          // and provision - its lease's (above), or for a response without one (a HEAD) context.ts recheck - each on
          // one bounded transaction of the image check pool (check-db.ts: the same database and role as the ledger's
          // and the application's). A response appends nothing, and the ledger's four append lanes bound append
          // work: with the check inside a lane, four lanes over the check's hold time capped a series at about 27
          // frames/s however the identity was resolved (fix-3 sample a, run e-route-fix3-fable-20261027a). The
          // delivery's opening and closing (the records) keep their lanes. The archive's current study and object
          // identity are compared by the source and the stream.
          prepare: async () => {
            const current = held ? { at: held.current.at, institution: held.current.facts.actor.institutionId, ...held.current.provision }
              : await this.checks.$transaction(async tx => {
                await boundEmrStatements(tx);
                const at = new Date().toISOString();
                const checked = await this.context.recheck(tx, request, manifest, at);
                return { at, institution: checked.actor.institutionId, accountGeneration: checked.accountGeneration, provision: checked.provision };
              }, { maxWait: EMR_TX_MAX_WAIT_MS, timeout: EMR_TX_TIMEOUT_MS });
            return prepareDelivery(manifest, image, { eventId: randomUUID(), ...(held ? { deliveryEventId: held.record.event.eventId } : {}),
              at: current.at, cause: 'background-fetch', opening: null,
              authorization: { studyUid: image.studyUid, institution: current.institution, accountGeneration: current.accountGeneration },
              provision: current.provision });
          },
          response, signal: abort.signal, range: request.headers.range });
        // Served: the image answered whole with a success status (MG-10); a 416 or a cut-short response is not.
        served = result.terminal === 'transfer-ended' && response.statusCode >= 200 && response.statusCode < 300;
        return result;
      } finally {
        // The refused rows are owed by the delivery: written on a ledger transaction of their own, and at the latest on
        // its closing event's - which exists only with them (R244-GPT-02).
        lease?.release(served, unstored.length ? this.owed(unstored) : undefined);
      }
    } catch (error) {
      if (kept && sourceChanged(error)) {
        this.manifests.forget(image.studyUid, kept);
        // The delivery recording the forgotten manifest ends with it; the rebuilt one opens its own.
        lease?.retire();
      }
      // Current identity exists only for a member admission the guard captured. Without one (authentication
      // switched off, or a request that already ended) nothing can be authorized, and no archive byte is read.
      if (error instanceof RequestContextUnavailable && !response.headersSent)
        throw new ServiceUnavailableException({ code: 'ImageRequestContextUnavailable', message: '영상의 현재 접근 권한을 확인할 수 없습니다' });
      throw error;
    } finally { request.off('aborted', stop); response.off('close', stop); }
  }

  /** A response's refused rows as facts of its delivery, each written with its first failure's cause (store.ts retain)
   * and named, when the stop cannot write them, by kind, response and request. */
  private owed(rows: UnstoredObservation[]): OwedFacts {
    return { write: async tx => { for (const row of rows) await this.evidence.retain(tx, row); },
      names: rows.map(row => [row.kind, row.link.eventId, row.link.requestId]) };
  }
}
