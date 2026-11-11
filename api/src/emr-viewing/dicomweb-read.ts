import { EventEmitter } from 'node:events';
import { Logger, StreamableFile } from '@nestjs/common';
import { pipeline } from 'node:stream/promises';
import type { PrismaService } from '../prisma.service';
import type { OrthancService, RelayTarget } from '../orthanc.service';
import type { AdmittedStudy } from '../pacs/dicom-gateway';
import type { RequestContextSource } from '../emr-runtime/request-context';
import { PrismaLedgerSql } from '../emr-runtime/store';
import { DEFAULT_IMAGE_DELIVERY_IDLE_MS } from '../image-delivery-record';
import { consumerSource } from './consumer-read';
import { LocalReadResponse, SerializedLocalReadBody } from './local-read';
import { ViewingRecordService } from './viewing-record.service';
import { NO_HIDDEN, withoutHidden } from '../study-attachment';

/** CD10-CONTRACT-3: the added metadata reads share one study read with existing consumers. */
export class DicomwebReadRecorder {
  private readonly logger = new Logger(DicomwebReadRecorder.name);
  private readonly seen = new Map<string, { ready: Promise<void>; timer: ReturnType<typeof setTimeout> | null }>();
  private readonly sessions = new Map<string, { start: Date; timer: ReturnType<typeof setTimeout> | null }>();
  constructor(private readonly db: PrismaService, private readonly requests: RequestContextSource,
    private readonly viewing: ViewingRecordService, private readonly idleMs = DEFAULT_IMAGE_DELIVERY_IDLE_MS) {}

  async relay(req: any, res: any, orthanc: OrthancService, uri: string, origin: string,
    study: AdmittedStudy, signal: AbortSignal): Promise<void> {
    // Buffer descriptions only. The existing Orthanc transport preserves public BulkDataURIs and cancellation;
    // pixel streams continue through the image recorder without buffering here.
    const chunks: Buffer[] = [], headers = new Map<string, string>();
    let status = 200;
    const target: RelayTarget = Object.assign(new EventEmitter(), {
      status(code: number) { status = code; },
      setHeader(name: string, value: string) { headers.set(name, value); },
      write(chunk: Uint8Array) { chunks.push(Buffer.from(chunk)); return true; }, end() {},
    });
    await orthanc.relay(uri, String(req.headers?.accept ?? '*/*'), target, signal, origin);
    let bytes = Buffer.concat(chunks);
    let prepared: StreamableFile | null = null;
    if (req.method === 'GET' && status === 200 && bytes.length) {
      let json = bytes.toString('utf8'), body = JSON.parse(json);
      // FC-076: a withdrawn attachment (or one never confirmed stored) leaves the series and instance lists and the
      // metadata. Only then is the answer reserialized; otherwise Orthanc's own representation passes unchanged.
      const kept = withoutHidden(body, study.hidden ?? NO_HIDDEN);
      if (kept !== body) {
        body = kept; json = JSON.stringify(kept); bytes = Buffer.from(json, 'utf8');
        for (const name of [...headers.keys()]) if (name.toLowerCase() === 'content-length') headers.delete(name);
      }
      // An empty query result discloses no record. Never reserialize the successful Orthanc representation.
      if (Array.isArray(body) && body.length) prepared = await this.record(req, res, study, json);
    }
    signal.throwIfAborted();
    res.status(status);
    for (const [name, value] of headers) res.setHeader(name, value);
    if (prepared) await pipeline(prepared.getStream(), res);
    else res.end(bytes);
  }

  private async record(req: any, res: any, study: AdmittedStudy, json: string): Promise<StreamableFile | null> {
    const facts = this.requests.read(req);
    const session = JSON.stringify([facts.issuer, facts.subject, facts.binding.sessionRef ?? ['bearer', study.studyUid]]);
    let observed = this.sessions.get(session);
    if (!observed) this.sessions.set(session, observed = { start: new Date(), timer: null });
    if (observed.timer) clearTimeout(observed.timer);
    observed.timer = setTimeout(() => this.sessions.delete(session), this.idleMs);
    observed.timer.unref?.();
    const key = JSON.stringify([session, study.studyUid]);
    let entry = this.seen.get(key);
    let body: StreamableFile | null = null;
    if (!entry) {
      const start = observed.start;
      entry = { ready: this.prepare(req, res, study, json, start).then(prepared => { body = prepared; }), timer: null };
      const held = entry;
      this.seen.set(key, held);
      void held.ready.catch(() => { if (this.seen.get(key) === held) this.seen.delete(key); });
    }
    if (entry.timer) clearTimeout(entry.timer);
    const held = entry;
    // Start the idle gap after recording settles; concurrent requests wait for the same durable receipt.
    await held.ready;
    if (held.timer) clearTimeout(held.timer);
    held.timer = setTimeout(() => { if (this.seen.get(key) === held) this.seen.delete(key); }, this.idleMs);
    held.timer.unref?.();
    return body;
  }

  private async prepare(req: any, res: any, study: AdmittedStudy, json: string, firstSeen: Date): Promise<StreamableFile | null> {
    const facts = this.requests.read(req);
    const auth = req.sid ? await this.db.authSession.findUnique({ where: { sid: req.sid }, select: { createdAt: true } }) : null;
    const start = auth?.createdAt ?? firstSeen;
    if (await new PrismaLedgerSql(this.db).accessSeen(facts.issuer, facts.subject, study.studyUid,
      start, facts.binding.sessionRef)) return null;
    const source = consumerSource('study-metadata', study.studyUid, study.managingInstitutionId,
      study.studyUid, null, [], { sourcePatientId: study.sourcePatientId, sourceInstitution: null });
    const prepared = await this.viewing.prepare(req, res,
      new LocalReadResponse(new SerializedLocalReadBody(json), [source]));
    void prepared.settled.catch(() => this.logger.error('Local read follow-up did not settle; consult the ledger failure record.'));
    return prepared.body;
  }
}
