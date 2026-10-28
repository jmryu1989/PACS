import { Inject, Injectable, ServiceUnavailableException, BadRequestException, ConflictException } from '@nestjs/common';
import type { BeforeApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { EMR_TX_MAX_WAIT_MS, EMR_TX_TIMEOUT_MS, boundEmrStatements } from '../emr-runtime/limits';
import { EMR_RECORD_PORT, EmrRecordPort, EmrRecordWork } from '../emr-runtime/record-port';
import { REQUEST_CONTEXT_SOURCE, RequestContextSource, RequestContextUnavailable } from '../emr-runtime/request-context';
import { StudyImageDeliveryRecorder } from '../image-delivery-record';
import { OrthancService } from '../orthanc.service';
import { PrismaService } from '../prisma.service';
import { ImageCheckDatabase } from './check-db';
import { parseImageRequest, prepareDelivery } from './contract';
import { ImageContextSource } from './context';
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

/** A response's rows that no transaction has retained yet, with the delivery record they name. */
interface Unretained { deliveryEventId: string; rows: UnstoredObservation[] }

@Injectable()
export class OnlineImageService implements BeforeApplicationShutdown {
  private readonly manifests = new ManifestReuse();
  private readonly evidence: PgImageEvidenceStore;
  /** db: the application connection E's rows are written on. checks: the bounded pool of the per-response check
   * transactions (check-db.ts), apart from that pool and from the ledger's lanes. deliveries: the 열람 record every
   * image route shares (image-delivery-record.ts). */
  constructor(@Inject(EMR_RECORD_PORT) private readonly records: EmrRecordPort,
    private readonly context: ImageContextSource, private readonly db: PrismaService,
    private readonly orthanc: OrthancService, @Inject(REQUEST_CONTEXT_SOURCE) private readonly requests: RequestContextSource,
    private readonly checks: ImageCheckDatabase, private readonly deliveries: StudyImageDeliveryRecorder) {
    this.evidence = new PgImageEvidenceStore(db);
  }

  /** Rows still held get one more transaction if the record port still admits work: Nest runs the ledger's own
   * shutdown hook beside this one and it closes the port, so usually it does not. What is still held is named here; its
   * failure is already journaled against its delivery (retainPending). The deliveries themselves end with their
   * recorder's own shutdown. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.retaining;
    if (this.unretained.length) await this.offer();
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
      // The 열람 record (의료법 제23조④, D1877) is the study delivery of this member session, one pair whichever routes
      // its reads take: the frame reader, the preview and the relay record into the same one (image-delivery-record.ts).
      // A response joins it - opening it, provide-prepared durable, when it is the session's first read of the study -
      // before any source read; a HEAD or a description takes no lease and is answered under no record.
      const lease = await this.deliveries.lease(request, ONLINE_IMAGE_SURFACE, target.split('?')[0], () => manifest.studyUid);
      let served = false;
      const unstored: UnstoredObservation[] = [];
      try {
        const result = await sendOnlineImage({ evidence: this.evidence, source: this.orthanc.imageSource(), stagingDirectory }, {
          manifest, delivery: lease?.record ?? null, requestId: facts.requestId,
          // A row the application connection refused is kept and retained on a ledger transaction after the response.
          unstored: row => unstored.push(row),
          // This response's current access check before any source read: identity, institution scope, StudyAccess
          // and provision (context.ts recheck), on one bounded transaction of E's own check pool (check-db.ts: the
          // same database and role as the ledger's and the application's). A response appends nothing, and the
          // ledger's four append lanes bound append work: with the check inside a lane, four lanes over the check's
          // hold time capped a series at about 27 frames/s however the identity was resolved (fix-3 sample a, run
          // e-route-fix3-fable-20261027a). The delivery's opening and closing (the records) keep their lanes. The
          // archive's current study and object identity are compared by the source and the stream.
          prepare: async () => this.checks.$transaction(async tx => {
            await boundEmrStatements(tx);
            const at = new Date().toISOString();
            const current = await this.context.recheck(tx, request, manifest, at);
            return prepareDelivery(manifest, image, { eventId: randomUUID(), ...(lease ? { deliveryEventId: lease.record.event.eventId } : {}),
              at, cause: 'background-fetch', opening: null,
              authorization: { studyUid: image.studyUid, institution: current.actor.institutionId, accountGeneration: current.accountGeneration },
              provision: current.provision });
          }, { maxWait: EMR_TX_MAX_WAIT_MS, timeout: EMR_TX_TIMEOUT_MS }),
          response, signal: abort.signal, range: request.headers.range });
        // Served: the image answered whole with a success status (MG-10); a 416 or a cut-short response is not.
        served = result.terminal === 'transfer-ended' && response.statusCode >= 200 && response.statusCode < 300;
        return result;
      } finally {
        lease?.release(served);
        if (unstored.length) this.hold([{ deliveryEventId: unstored[0].link.deliveryEventId, rows: unstored }], unstored[0].error, false);
        if (this.unretained.length) void this.offer();
      }
    } catch (error) {
      if (kept && sourceChanged(error)) this.manifests.forget(image.studyUid, kept);
      // Current identity exists only for a member admission the guard captured. Without one (authentication
      // switched off, or a request that already ended) nothing can be authorized, and no archive byte is read.
      if (error instanceof RequestContextUnavailable && !response.headersSent)
        throw new ServiceUnavailableException({ code: 'ImageRequestContextUnavailable', message: '영상의 현재 접근 권한을 확인할 수 없습니다' });
      throw error;
    } finally { request.off('aborted', stop); response.off('close', stop); }
  }

  /** Rows of responses that no transaction has retained yet, oldest first. No count bounds them: no decision sets one
   * (R244-GPT-08), and dropping an entry would lose facts of a viewing the record already names. An entry leaves only
   * when a transaction retains it or, at shutdown, when it is named on stderr (its failure is already journaled against
   * its delivery). */
  private readonly unretained: Unretained[] = [];
  private retaining: Promise<void> | null = null;
  /** Entries a response could not write join the end; entries a retry could not retain return to the front, ahead of
   * any a concurrent response added meanwhile. */
  private hold(entries: Unretained[], error: unknown, retried: boolean): void {
    if (retried) this.unretained.unshift(...entries); else this.unretained.push(...entries);
    console.error('[EMR-E] image observations held for a later retention', JSON.stringify({
      deliveries: entries.map(entry => [entry.deliveryEventId, entry.rows.length]), cause: (error as any)?.code ?? (error as any)?.message ?? String(error) }));
  }
  /** One offer at a time of every held entry, on ledger work of its own: after each response while any is held, and
   * at shutdown. A port that admits no more work leaves them held. */
  private offer(): Promise<void> {
    this.retaining ??= (async () => {
      let work: EmrRecordWork;
      try { work = this.records.begin(); } catch { return; }
      try { while (await this.retainPending(work) && this.unretained.length); }
      finally { work.end(); }
    })().catch(error => { console.error('[EMR-E] image observation retention failed', (error as any)?.message ?? String(error)); })
      .finally(() => { this.retaining = null; });
    return this.retaining;
  }
  /** One ledger transaction per held entry, oldest first, written with the first failure's cause (store.ts retain); B2
   * journals a failure against that entry's delivery record. The first failure ends the pass and the rest stay held in
   * order: with the database unreachable, each further attempt would only wait out its own connection timeout. */
  private async retainPending(work: EmrRecordWork): Promise<boolean> {
    const held = this.unretained.splice(0);
    while (held.length) {
      const entry = held[0];
      try {
        await work.transactionWithRecords(async tx => { for (const row of entry.rows) await this.evidence.retain(tx, row); },
          undefined, entry.deliveryEventId);
      } catch (error) { this.hold(held, error, true); return false; }
      held.shift();
    }
    return true;
  }
}
