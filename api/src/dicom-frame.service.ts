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
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { OrthancService } from './orthanc.service';
import type { RelayTarget } from './orthanc.service';
import { acceptsGzip, directReadServes, FrameFacts, FrameLayout, frameLayout, frameRange, multipartFrames,
  pixelDataHeaderMatches, previewPng, tagNumber } from './dicom-frame-layout';

const ORTHANC_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Long side of a series-strip preview; the strip shows it at about a hundred pixels. */
const PREVIEW_SIDE = 320;
/** gzip level 1 shrank a 17 MB 16-bit DBT frame 6.7x in ~90 ms; higher levels gained little and cost seconds. */
const GZIP_LEVEL = 1;
/** One read of the stored file per chunk; a 17 MB frame is 17 reads, each handed to the response with backpressure. */
const CHUNK_BYTES = 1 << 20;

export interface FrameRequest {
  studyUid: string; seriesUid: string; sopUid: string; frames: number[];
  accept: string | undefined; acceptEncoding: string | undefined; head: boolean;
  /** Origin the viewer addressed; Content-Location of each part is spelled against it. */
  origin: string;
  /**
   * D1880 memory-only preload: the worklist's preload store keeps frames as the gzip bytes this reader produces (7.7x
   * smaller than the frame, fable-design-preload-memory-20261027 §2.2). A browser decodes `Content-Encoding: gzip` before
   * any script sees the body, so the stored form is the gzip stream as the body itself (`application/gzip`) with the
   * multipart type it decodes to in `X-KIN-Part-Type`. A relayed object keeps Orthanc's answer unchanged.
   */
  stored?: boolean;
}

/** The decoded body's media type of a stored-form (preload) frame answer. */
export const PART_TYPE_HEADER = 'X-KIN-Part-Type';

interface StoredObject {
  id: string; uuid: string; facts: FrameFacts; studyUid: string; seriesUid: string;
  /** The layout once the stored file was found, sized and its pixel data header checked; null means relay. */
  layout: FrameLayout | null;
}

/** The stored file ended before the requested range did: the index and the file disagree, so nothing of it is a frame. */
class ShortRead extends Error { constructor() { super('short read'); } }
type FileHandle = Awaited<ReturnType<typeof fs.open>>;

const present = (value: unknown) => value !== undefined && value !== null && value !== '';
/** Functional groups whose attributes the preview pipeline applies (PS3.3 C.7.6.16.2.9 Pixel Value Transformation, C.7.6.16.2.10 Frame VOI LUT). */
const FRAME_GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ['PixelValueTransformationSequence', ['RescaleSlope', 'RescaleIntercept']],
  ['FrameVOILUTSequence', ['WindowCenter', 'WindowWidth', 'VOILUTFunction']],
];

/**
 * The first frame's transforms of an enhanced multi-frame object, from its functional groups (review MG-02): the shared
 * groups apply to every frame and frame 1's per-frame item overrides them; a group that is present replaces the top-level
 * attributes it covers, including those it leaves out (an item without a window means no window, not the top-level one).
 * `{}` for an object without functional groups (the top-level attributes stand), `null` when a group has a shape this
 * reader does not interpret - a malformed sequence, several items, a Modality or VOI LUT table inside a frame group -
 * so that the preview is Orthanc's renderer's rather than a rendering with the transforms silently dropped.
 */
export function firstFrameTransforms(tags: any): Record<string, unknown> | null {
  const shared = tags?.SharedFunctionalGroupsSequence, perFrame = tags?.PerFrameFunctionalGroupsSequence;
  if (!present(shared) && !present(perFrame)) return {};
  const groups: any[] = [];
  for (const sequence of [shared, perFrame]) {
    if (!present(sequence)) continue;
    if (!Array.isArray(sequence)) return null;
    if (!sequence.length) continue;
    const group = sequence[0];
    if (!group || typeof group !== 'object' || Array.isArray(group)) return null;
    groups.push(group);
  }
  const over: Record<string, unknown> = {};
  for (const group of groups) {
    for (const [sequence, keys] of FRAME_GROUPS) {
      const items = group[sequence];
      if (!present(items)) continue;
      if (!Array.isArray(items) || items.length !== 1 || !items[0] || typeof items[0] !== 'object' || Array.isArray(items[0])) return null;
      const item = items[0];
      if (present(item.ModalityLUTSequence) || present(item.VOILUTSequence)) return null;
      for (const key of keys) over[key] = item[key];
    }
  }
  return over;
}

@Injectable()
export class DicomFrameService {
  private readonly logger = new Logger('DicomFrame');
  private readonly storage = (process.env.KIN_ORTHANC_STORAGE ?? '').trim();
  private storageState: 'unchecked' | 'ready' | 'absent' = this.storage ? 'unchecked' : 'absent';
  private readonly objects = new Map<string, Promise<StoredObject>>();   // Orthanc id → immutable stored object
  private readonly located = new Map<string, string>();                  // SOP UID → Orthanc id
  /** Descriptions still being read: who waits for each, and the one cancellation they share. */
  private readonly describing = new Map<string, { borrowers: number; controller: AbortController }>();

  constructor(private readonly orthanc: OrthancService) {}

  /** Whether a direct read is possible at all on this installation (the storage mount exists and is readable). */
  async directReads(): Promise<boolean> {
    if (this.storageState === 'unchecked') {
      try { await fs.access(this.storage); this.storageState = 'ready'; }
      catch { this.storageState = 'absent'; this.logger.warn('frame_reader storage=absent path=' + this.storage); }
    }
    return this.storageState === 'ready';
  }

  /**
   * `signal` is the request's lifetime (the controller aborts it when the client goes away): it ends the index
   * lookups and a relayed Orthanc read; the direct read watches the response itself.
   */
  async serveFrames(request: FrameRequest, target: RelayTarget, signal?: AbortSignal): Promise<void> {
    const path = `/dicom-web/studies/${request.studyUid}/series/${request.seriesUid}/instances/${request.sopUid}/frames/${request.frames.join(',')}`;
    const accept = request.accept || 'multipart/related; type="application/octet-stream"; transfer-syntax=*';
    const object = (await this.directReads()) ? await this.stored(request.sopUid, signal) : null;
    // The URL's hierarchy must be the object's own: a study the caller may read never names another study's object.
    if (object && (object.studyUid !== request.studyUid || object.seriesUid !== request.seriesUid))
      throw new NotFoundException('요청한 검사·시리즈에 그 영상이 없습니다');
    const layout = object?.layout ?? null, filePath = object ? this.filePath(object.uuid) : '';
    // The description was checked against the file once; the file is checked again for this request, since a stored
    // file that has since changed size (replaced, truncated) is no longer the object the index describes.
    if (!layout || !directReadServes(accept, object!.facts.transferSyntax!) ||
        request.frames.some(frame => frameRange(layout, frame) === null) || !(await this.sameFile(object!, filePath))) {
      await this.orthanc.relay(path, accept, target, signal, request.origin);
      return;
    }
    // The file is opened before any header goes out: a file that cannot be opened is Orthanc's to answer.
    let handle: FileHandle | undefined;
    try { handle = await fs.open(filePath, 'r'); }
    catch { this.forget(object!.id); await this.orthanc.relay(path, accept, target, signal, request.origin); return; }
    const locationBase = `${request.origin}/dicom-web/studies/${request.studyUid}/series/${request.seriesUid}/instances/${request.sopUid}`;
    const multipart = multipartFrames(randomUUID() + '-' + randomUUID().slice(0, 23), locationBase, object!.facts.transferSyntax!, layout.frameBytes);
    const gzip = request.stored === true || acceptsGzip(request.acceptEncoding);
    target.status(200);
    if (request.stored) {
      target.setHeader('Content-Type', 'application/gzip');
      target.setHeader(PART_TYPE_HEADER, multipart.contentType);
    } else target.setHeader('Content-Type', multipart.contentType);
    target.setHeader('Vary', 'Accept-Encoding');
    if (gzip && !request.stored) target.setHeader('Content-Encoding', 'gzip');
    else target.setHeader('Content-Length', String(multipart.contentLength(request.frames, layout.frameBytes)));
    if (request.head) { await handle.close().catch(() => {}); target.end(); return; }
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
        // Every byte of the frame is counted: a file that ends early (EOF is not an error to the OS) must not end as
        // a complete part, because a shorter payload would still parse as a frame and display as one.
        for (let position = range.start; position <= range.end;) {
          const wanted = Math.min(CHUNK_BYTES, range.end - position + 1), chunk = Buffer.allocUnsafe(wanted);
          let filled = 0;
          while (filled < wanted) {
            const { bytesRead } = await handle.read(chunk, filled, wanted - filled, position + filled);
            if (!bytesRead) throw new ShortRead();
            filled += bytesRead;
          }
          await write(chunk);
          position += wanted;
        }
        await write(multipart.partTail);
      }
      await write(multipart.closing);
      out.end();
      await delivery;
    } catch (error) {
      if (error instanceof ShortRead) { this.logger.warn('frame_reader category=short_read'); this.forget(object!.id); }
      else if (!gone) this.logger.warn('frame_reader category=stream_failed');
      // Headers are out: the only truthful answer left is an aborted transfer, never a completed multipart body. The
      // gzip stream carries the error into its pipeline (which observes it); the response's socket is just closed.
      if (out !== target) (out as any).destroy?.(error);
      (target as any).destroy?.();
      throw error;
    } finally { await handle.close().catch(() => {}); }
  }

  /** The series strip's preview of one object; Orthanc's renderer answers objects the direct reader does not serve. */
  async servePreview(id: string, target: RelayTarget, signal?: AbortSignal): Promise<void> {
    if (!ORTHANC_ID.test(id)) throw new NotFoundException('영상을 찾을 수 없습니다');
    const object = (await this.directReads()) ? await this.storedById(id, signal) : null;
    let png: Buffer | null = null;
    if (object?.layout) {
      const filePath = this.filePath(object.uuid);
      if (await this.sameFile(object, filePath)) {
        const range = frameRange(object.layout, 1)!;
        png = previewPng(await this.readRange(object.id, filePath, range.start, range.end), object.facts, { maxSide: PREVIEW_SIDE });
      }
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

  /** The stored file is still the one the index describes (same size); otherwise its description is dropped. */
  private async sameFile(object: StoredObject, filePath: string): Promise<boolean> {
    try {
      if ((await fs.stat(filePath)).size === object.facts.fileSize) return true;
    } catch { /* gone or unreadable: not the same file either */ }
    this.logger.warn('frame_reader category=file_changed');
    this.forget(object.id);
    return false;
  }

  private forget(id: string): void { this.objects.delete(id); }

  private async readRange(id: string, filePath: string, start: number, end: number): Promise<Buffer> {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(end - start + 1);
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
        if (!bytesRead) { this.forget(id); throw new ServiceUnavailableException('원본 영상 파일이 예상보다 짧습니다'); }
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

  /**
   * One description per object, shared by every request that needs it while it is being read. Its cancellation is
   * shared as well: the source read stops only when the last request waiting for it has gone (review MG-03: a viewer
   * pane closed while a cold object is described must not fail the other panes reading the same object). A request
   * that leaves early gets its own refusal; the description goes on for the others.
   */
  private storedById(id: string, signal?: AbortSignal): Promise<StoredObject> {
    let pending = this.objects.get(id);
    if (!pending) {
      const owner = { borrowers: 0, controller: new AbortController() };
      const described = this.describe(id, owner.controller.signal);
      pending = described;
      this.describing.set(id, owner);
      described.finally(() => { if (this.describing.get(id) === owner) this.describing.delete(id); }).catch(() => {});
      if (this.objects.size > 5000) this.objects.clear();
      this.objects.set(id, pending);
      // A failed description is not an answer about the object: the next request asks Orthanc again.
      pending.catch(() => { if (this.objects.get(id) === pending) this.objects.delete(id); });
    }
    return this.borrow(id, pending, signal);
  }

  private borrow(id: string, pending: Promise<StoredObject>, signal?: AbortSignal): Promise<StoredObject> {
    const owner = this.describing.get(id);
    if (!signal || !owner) return pending;   // already described, or no lifetime to follow
    owner.borrowers++;
    return new Promise<StoredObject>((resolve, reject) => {
      let left = false;
      const leave = () => {
        if (left) return;
        left = true;
        signal.removeEventListener('abort', onAbort);
        owner.borrowers--;
        if (owner.borrowers === 0 && this.describing.get(id) === owner) {
          // Nobody waits for this description any more: stop the source read and let the next request start afresh.
          owner.controller.abort();
          this.describing.delete(id);
          if (this.objects.get(id) === pending) this.objects.delete(id);
        }
      };
      const onAbort = () => { leave(); reject(new ServiceUnavailableException('영상 요청이 중단되었습니다')); };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(value => { if (!left) { left = true; signal.removeEventListener('abort', onAbort); owner.borrowers--; } resolve(value); },
        error => { if (!left) { left = true; signal.removeEventListener('abort', onAbort); owner.borrowers--; } reject(error); });
    });
  }

  private async describe(id: string, signal?: AbortSignal): Promise<StoredObject> {
    const { tags: indexed, attachment, transferSyntax, pixelDataOffset } = await this.orthanc.frameFacts(id, signal);
    if (!indexed || typeof indexed !== 'object' || typeof indexed.SOPInstanceUID !== 'string' || typeof indexed.StudyInstanceUID !== 'string' ||
        typeof indexed.SeriesInstanceUID !== 'string') throw new NotFoundException('영상 원본을 확인할 수 없습니다');
    // An enhanced multi-frame object keeps the first frame's rescale and window in its functional groups; they replace
    // the top-level attributes, and a group shape this reader does not interpret leaves the preview to Orthanc.
    const transforms = firstFrameTransforms(indexed);
    const tags = transforms ? { ...indexed, ...transforms } : indexed;
    const facts: FrameFacts = {
      unsupportedTransforms: transforms === null,
      transferSyntax: typeof transferSyntax === 'string' && /^[0-9.]{1,64}$/.test(transferSyntax.trim()) ? transferSyntax.trim() : null,
      pixelDataOffset: pixelDataOffset !== null && /^\d{1,15}$/.test(pixelDataOffset.trim()) ? Number(pixelDataOffset.trim()) : null,
      rows: tagNumber(tags.Rows) ?? 0, columns: tagNumber(tags.Columns) ?? 0,
      bitsAllocated: tagNumber(tags.BitsAllocated) ?? 0, samplesPerPixel: tagNumber(tags.SamplesPerPixel) ?? 1,
      numberOfFrames: present(tags.NumberOfFrames) ? tagNumber(tags.NumberOfFrames) ?? 0 : 1,
      planarConfiguration: present(tags.PlanarConfiguration) ? tagNumber(tags.PlanarConfiguration) : null,
      photometric: typeof tags.PhotometricInterpretation === 'string' ? tags.PhotometricInterpretation.trim() : '',
      pixelRepresentation: tagNumber(tags.PixelRepresentation) ?? 0,
      bitsStored: present(tags.BitsStored) ? tagNumber(tags.BitsStored) ?? -1 : null,
      highBit: present(tags.HighBit) ? tagNumber(tags.HighBit) ?? -1 : null,
      rescaleSlope: present(tags.RescaleSlope) ? tagNumber(tags.RescaleSlope) ?? NaN : null,
      rescaleIntercept: present(tags.RescaleIntercept) ? tagNumber(tags.RescaleIntercept) ?? NaN : null,
      modalityLutSequence: present(tags.ModalityLUTSequence),
      windowCenter: tagNumber(tags.WindowCenter), windowWidth: tagNumber(tags.WindowWidth),
      voiLutFunction: typeof tags.VOILUTFunction === 'string' && tags.VOILUTFunction.trim() ? tags.VOILUTFunction.trim() : null,
      voiLutSequence: present(tags.VOILUTSequence),
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
        const header = await this.readRange(id, filePath, facts.pixelDataOffset!, facts.pixelDataOffset! + layout.headerLength - 1);
        if (stat.size !== facts.fileSize || !pixelDataHeaderMatches(header, layout)) layout = null;
      } catch { layout = null; }
      if (!layout) this.logger.warn('frame_reader category=layout_mismatch');
    }
    return { id, uuid: uuid ?? '', facts, layout, studyUid: tags.StudyInstanceUID, seriesUid: tags.SeriesInstanceUID };
  }
}
