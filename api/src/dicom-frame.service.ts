/*
 * MG-LOADING (Minhoon P0, 2026-10-27): the viewer's WADO-RS frame reads and the series-strip previews of uncompressed
 * originals, served as byte ranges of the stored file instead of Orthanc's whole-file read (dicom-frame-layout.ts
 * records the measurement). The API reads Orthanc's storage directory read-only (KIN_ORTHANC_STORAGE, the compose
 * mount of the orthanc-db volume) and never writes, lists or deletes there; every object is still located through
 * Orthanc's index, and an object the reader cannot prove uncompressed and intact is relayed to Orthanc unchanged.
 * Authorization is the caller's: the controller runs the same DICOMweb gate nginx's auth_request runs (authzDicom).
 * Response hygiene headers (nosniff, Cache-Control: no-store) are the proxy's and the API middleware's, as for every
 * other API answer.
 */
import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { OrthancService } from './orthanc.service';
import type { RelayTarget } from './orthanc.service';
import { directReadServes, FrameFacts, FrameLayout, frameLayout, frameRange, multipartFrames, pixelDataHeaderMatches,
  previewPng, tagNumber } from './dicom-frame-layout';

const ORTHANC_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Long side of a series-strip preview; the strip shows it at about a hundred pixels. */
const PREVIEW_SIDE = 320;
/** gzip level 1 shrank a 17 MB 16-bit DBT frame 6.7x in ~90 ms; higher levels gained little and cost seconds. */
const GZIP_LEVEL = 1;

export interface FrameRequest {
  studyUid: string; seriesUid: string; sopUid: string; frames: number[];
  accept: string | undefined; acceptEncoding: string | undefined; head: boolean;
  /** Origin the viewer addressed; Content-Location of each part is spelled against it. */
  origin: string;
}

interface StoredObject {
  id: string; uuid: string; facts: FrameFacts; studyUid: string; seriesUid: string;
  /** The layout once the stored file was found, sized and its pixel data header checked; null means relay. */
  layout: FrameLayout | null;
}

@Injectable()
export class DicomFrameService {
  private readonly logger = new Logger('DicomFrame');
  private readonly storage = (process.env.KIN_ORTHANC_STORAGE ?? '').trim();
  private storageState: 'unchecked' | 'ready' | 'absent' = this.storage ? 'unchecked' : 'absent';
  private readonly objects = new Map<string, Promise<StoredObject>>();   // Orthanc id → immutable stored object
  private readonly located = new Map<string, string>();                  // SOP UID → Orthanc id

  constructor(private readonly orthanc: OrthancService) {}

  /** Whether a direct read is possible at all on this installation (the storage mount exists and is readable). */
  async directReads(): Promise<boolean> {
    if (this.storageState === 'unchecked') {
      try { await fs.access(this.storage); this.storageState = 'ready'; }
      catch { this.storageState = 'absent'; this.logger.warn('frame_reader storage=absent path=' + this.storage); }
    }
    return this.storageState === 'ready';
  }

  async serveFrames(request: FrameRequest, target: RelayTarget, signal?: AbortSignal): Promise<void> {
    const path = `/dicom-web/studies/${request.studyUid}/series/${request.seriesUid}/instances/${request.sopUid}/frames/${request.frames.join(',')}`;
    const accept = request.accept || 'multipart/related; type="application/octet-stream"; transfer-syntax=*';
    const object = (await this.directReads()) ? await this.stored(request.sopUid, signal) : null;
    // The URL's hierarchy must be the object's own: a study the caller may read never names another study's object.
    if (object && (object.studyUid !== request.studyUid || object.seriesUid !== request.seriesUid))
      throw new NotFoundException('요청한 검사·시리즈에 그 영상이 없습니다');
    if (!object?.layout || !directReadServes(accept, object.facts.transferSyntax!) ||
        request.frames.some(frame => frameRange(object.layout!, frame) === null)) {
      await this.orthanc.relay(path, accept, target, signal);
      return;
    }
    const layout = object.layout, filePath = this.filePath(object.uuid);
    const locationBase = `${request.origin}/dicom-web/studies/${request.studyUid}/series/${request.seriesUid}/instances/${request.sopUid}`;
    const multipart = multipartFrames(randomUUID() + '-' + randomUUID().slice(0, 23), locationBase, object.facts.transferSyntax!, layout.frameBytes);
    const gzip = /(?:^|,)\s*gzip\s*(?:;|,|$)/i.test(request.acceptEncoding ?? '');
    target.status(200);
    target.setHeader('Content-Type', multipart.contentType);
    target.setHeader('Vary', 'Accept-Encoding');
    if (gzip) target.setHeader('Content-Encoding', 'gzip');
    else target.setHeader('Content-Length', String(multipart.contentLength(request.frames, layout.frameBytes)));
    if (request.head) { target.end(); return; }
    const out = gzip ? createGzip({ level: GZIP_LEVEL }) : target;
    const delivery = gzip ? pipeline(out as any, target as any) : Promise.resolve();
    // A client that goes away mid-stream fails this delivery before the loop below reaches `await delivery`; the
    // loop's own failure is the one reported, and an unobserved rejection here would end the API process (observed
    // 2026-10-27: the viewer page closed during a thumbnail read and the container exited 1).
    delivery.catch(() => {});
    let gone = false;
    const closed = new Promise<void>(resolve => target.once('close', () => { gone = true; resolve(); }));
    // A full buffer is waited out until it drains or the stream is gone; a destroyed stream never drains.
    const settled = (stream: any) => new Promise<void>(resolve => {
      const done = () => { for (const event of ['drain', 'close', 'error']) stream.off(event, done); resolve(); };
      for (const event of ['drain', 'close', 'error']) stream.on(event, done);
    });
    const write = async (chunk: Buffer) => {
      if (gone || (out as any).destroyed) throw new Error('client closed');
      if (!out.write(chunk)) await Promise.race([settled(out), closed]);
      if (gone || (out as any).destroyed) throw new Error('client closed');
    };
    try {
      for (const frame of request.frames) {
        const range = frameRange(layout, frame)!;
        await write(multipart.partHead(frame));
        const source = createReadStream(filePath, { start: range.start, end: range.end, highWaterMark: 1 << 20 });
        await pipeline(source, out as any, { end: false } as any);
        await write(multipart.partTail);
      }
      await write(multipart.closing);
      out.end();
      await delivery;
    } catch (error) {
      if (!gone) this.logger.warn('frame_reader category=stream_failed');
      (out as any).destroy?.(error);
      throw error;
    }
  }

  /** The series strip's preview of one object; Orthanc's renderer answers objects the direct reader does not serve. */
  async servePreview(id: string, target: RelayTarget, signal?: AbortSignal): Promise<void> {
    if (!ORTHANC_ID.test(id)) throw new NotFoundException('영상을 찾을 수 없습니다');
    const object = (await this.directReads()) ? await this.storedById(id, signal) : null;
    let png: Buffer | null = null;
    if (object?.layout) {
      const range = frameRange(object.layout, 1)!;
      const frame = await this.readRange(this.filePath(object.uuid), range.start, range.end);
      png = previewPng(frame, object.facts, { maxSide: PREVIEW_SIDE });
    }
    if (!png) { await this.orthanc.relay(`/instances/${id}/preview`, 'image/png', target, signal); return; }
    target.status(200);
    target.setHeader('Content-Type', 'image/png');
    target.setHeader('Content-Length', String(png.length));
    target.write(png);
    target.end();
  }

  private filePath(uuid: string): string {
    return join(this.storage, uuid.slice(0, 2), uuid.slice(2, 4), uuid);
  }

  private async readRange(filePath: string, start: number, end: number): Promise<Buffer> {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(end - start + 1);
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
        if (!bytesRead) throw new ServiceUnavailableException('원본 영상 파일이 예상보다 짧습니다');
        filled += bytesRead;
      }
      return buffer;
    } finally { await handle.close(); }
  }

  private async stored(sopUid: string, signal?: AbortSignal): Promise<StoredObject> {
    let id = this.located.get(sopUid);
    if (!id) {
      const found = await this.orthanc.lookupInstance(sopUid, signal);
      const instances = Array.isArray(found) ? found.filter(x => x?.Type === 'Instance') : [];
      if (instances.length !== 1 || !ORTHANC_ID.test(instances[0]?.ID)) throw new NotFoundException('영상 원본이 없거나 중복입니다');
      id = instances[0].ID as string;
      if (this.located.size > 20000) this.located.clear();
      this.located.set(sopUid, id);
    }
    return this.storedById(id, signal);
  }

  private storedById(id: string, signal?: AbortSignal): Promise<StoredObject> {
    let pending = this.objects.get(id);
    if (!pending) {
      pending = this.describe(id, signal);
      if (this.objects.size > 5000) this.objects.clear();
      this.objects.set(id, pending);
      // A failed description is not an answer about the object: the next request asks Orthanc again.
      pending.catch(() => { if (this.objects.get(id) === pending) this.objects.delete(id); });
    }
    return pending;
  }

  private async describe(id: string, signal?: AbortSignal): Promise<StoredObject> {
    const { tags, attachment, transferSyntax, pixelDataOffset } = await this.orthanc.frameFacts(id, signal);
    if (!tags || typeof tags !== 'object' || typeof tags.SOPInstanceUID !== 'string' || typeof tags.StudyInstanceUID !== 'string' ||
        typeof tags.SeriesInstanceUID !== 'string') throw new NotFoundException('영상 원본을 확인할 수 없습니다');
    const facts: FrameFacts = {
      transferSyntax: typeof transferSyntax === 'string' && /^[0-9.]{1,64}$/.test(transferSyntax.trim()) ? transferSyntax.trim() : null,
      pixelDataOffset: pixelDataOffset !== null && /^\d{1,15}$/.test(pixelDataOffset.trim()) ? Number(pixelDataOffset.trim()) : null,
      rows: tagNumber(tags.Rows) ?? 0, columns: tagNumber(tags.Columns) ?? 0,
      bitsAllocated: tagNumber(tags.BitsAllocated) ?? 0, samplesPerPixel: tagNumber(tags.SamplesPerPixel) ?? 1,
      numberOfFrames: tags.NumberOfFrames === undefined || tags.NumberOfFrames === null ? 1 : tagNumber(tags.NumberOfFrames) ?? 0,
      planarConfiguration: tags.PlanarConfiguration === undefined || tags.PlanarConfiguration === null ? null : tagNumber(tags.PlanarConfiguration),
      photometric: typeof tags.PhotometricInterpretation === 'string' ? tags.PhotometricInterpretation.trim() : '',
      pixelRepresentation: tagNumber(tags.PixelRepresentation) ?? 0,
      windowCenter: tagNumber(tags.WindowCenter), windowWidth: tagNumber(tags.WindowWidth),
      fileSize: typeof attachment?.UncompressedSize === 'number' ? attachment.UncompressedSize : 0,
      storedSize: typeof attachment?.CompressedSize === 'number' ? attachment.CompressedSize : -1,
    };
    const uuid = typeof attachment?.Uuid === 'string' && UUID.test(attachment.Uuid) ? attachment.Uuid : null;
    let layout = uuid ? frameLayout(facts) : null;
    if (layout) {
      // The stored file itself must agree with the index before any byte of it is served as a frame.
      try {
        const filePath = this.filePath(uuid!);
        const stat = await fs.stat(filePath);
        const header = await this.readRange(filePath, facts.pixelDataOffset!, facts.pixelDataOffset! + layout.headerLength - 1);
        if (stat.size !== facts.fileSize || !pixelDataHeaderMatches(header, layout)) layout = null;
      } catch { layout = null; }
      if (!layout) this.logger.warn('frame_reader category=layout_mismatch');
    }
    return { id, uuid: uuid ?? '', facts, layout, studyUid: tags.StudyInstanceUID, seriesUid: tags.SeriesInstanceUID };
  }
}
