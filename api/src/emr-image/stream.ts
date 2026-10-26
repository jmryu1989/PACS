import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { AccessEvent, DurableAccessReceipt } from '../emr-contract/access-event';
import { parseAccessEvent } from '../emr-contract/access-event';
import { freeze, refuse } from '../emr-contract/validation';
import type { EmrRecordPort, EmrRecordTransaction } from '../emr-runtime/record-port';
import { DeliveryUnit, PreparedDelivery, TransferObservation, judgeDelivery } from './contract';
import { ImageManifest, verifiedManifest } from './manifest';

/** E-01/02: a source supplies one selected representation, never an arbitrary URL.
 * The source owns network cancellation until copy resolves. No read transaction
 * survives into network I/O or the HTTP response. */
export interface ImageSource {
  copy(manifest: ImageManifest, prepared: PreparedDelivery, unit: DeliveryUnit,
    write: (bytes: Uint8Array) => Promise<void>, signal: AbortSignal): Promise<{
      contentType: string; transferSyntaxUid: string | null; source: string;
    }>;
}
export interface ImageRepresentation {
  unit: string; sopInstanceUid: string | null; frame: number | null;
  bytes: number; sha256: string; contentType: string; transferSyntaxUid: string | null;
  source: string; representation: DeliveryUnit['part'];
}
/** eventId names this response; deliveryEventId the durable access record (B2) it is provided under. */
export interface ImageResponseManifest {
  formatVersion: 1; eventId: string; deliveryEventId: string; studyUid: string; studyManifestSha256: string;
  request: PreparedDelivery['request'];
  http: { status: number; headers: Readonly<Record<string, string>>; body: boolean;
    range: string | null; plannedBytes: number;
    selections: readonly { unit: string; start: number; end: number }[] };
  representations: readonly ImageRepresentation[]; sha256: string;
}
export interface ImageCopy {
  location: string; kind: 'staging'; eventId: string; unit: string;
  bytes: number | null; sha256: string | null; state: 'present' | 'removed' | 'removal-failed';
}
/** The existing storage owner persists these facts durably before the response's first byte (prepared) and after
 * it ended (transferred, copiesRemoved). It must keep the manifest and observation, not merely a digest. The access
 * record itself is B2's; these rows name it. No in-memory map is a production implementation of this port. */
export interface ImageEvidenceStore {
  prepared(manifest: ImageResponseManifest, source: ImageManifest, copies: readonly ImageCopy[], requestId: string): Promise<void>;
  transferred(eventId: string, observations: readonly TransferObservation[], wire: {
    bytesWritten: number; plannedBytes: number; terminal: 'transfer-ended' | 'transfer-aborted' | 'transfer-unknown';
  }): Promise<void>;
  /** Also called for failed preparation. An incomplete staging file is still a
   * real copy, but never evidence that its image was provided. */
  copiesRemoved(eventId: string, copies: readonly ImageCopy[]): Promise<void>;
}
export interface OnlineImageBoundary {
  records: EmrRecordPort; evidence: ImageEvidenceStore; source: ImageSource; stagingDirectory: string;
}
/** The durable access record a response is provided under: the study delivery's provide-prepared event, its B2
 * receipt and the plan of everything the delivery may carry (delivery.ts). */
export interface OnlineImageDelivery { event: Readonly<AccessEvent>; receipt: DurableAccessReceipt; prepared: PreparedDelivery }
export interface ImageSendResult {
  manifest: ImageResponseManifest; observations: readonly TransferObservation[];
  terminal: 'transfer-ended' | 'transfer-aborted' | 'transfer-unknown';
  copies: readonly ImageCopy[]; observationStored: boolean; observationError: unknown | null;
  bytesWritten: number;
}
type Staged = { path: string; unit: DeliveryUnit; representation: ImageRepresentation };
type Segment = { buffer: Buffer } | { item: Staged; start: number; end: number };

function header(value: string): string {
  if (!value || /[\r\n\x00]/.test(value)) refuse('ImageRepresentationInvalid');
  return value;
}
function ranges(value: string | undefined, length: number): [number, number][] | null {
  if (value === undefined) return null;
  if (!value.startsWith('bytes=')) refuse('ImageRangeInvalid');
  const out: [number, number][] = [];
  for (const part of value.slice(6).split(',')) {
    const match = /^(\d*)-(\d*)$/.exec(part.trim());
    if (!match || !match[1] && !match[2]) refuse('ImageRangeInvalid');
    const a = match[1] ? Number(match[1]) : null, b = match[2] ? Number(match[2]) : null;
    if (a !== null && !Number.isSafeInteger(a) || b !== null && !Number.isSafeInteger(b)) refuse('ImageRangeInvalid');
    if (a !== null && b !== null && b < a) refuse('ImageRangeInvalid');
    const start = a === null ? Math.max(0, length - b) : a;
    const end = a === null || b === null ? length : Math.min(length, b + 1);
    if (start < end && start < length) out.push([start, end]);
  }
  return out;
}
function location(manifest: ImageManifest, unit: DeliveryUnit): string {
  if (unit.sopInstanceUid === null) return `/dicom-web/studies/${manifest.studyUid}`;
  const object = manifest.objects.find(o => o.sopInstanceUid === unit.sopInstanceUid);
  if (!object) refuse('ScopeOutsideManifest');
  return `/dicom-web/studies/${manifest.studyUid}/series/${object.seriesUid}/instances/${object.sopInstanceUid}` +
    (unit.frame === null ? '' : `/frames/${unit.frame}`);
}
function bodyPlan(items: Staged[], manifest: ImageManifest, range: string | undefined, forceMultipart: boolean) {
  if (range !== undefined && items.length !== 1) refuse('ImageRangeRequiresSingleRepresentation');
  const item = items[0], selected = ranges(range, item.representation.bytes);
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'Accept-Ranges': items.length === 1 ? 'bytes' : 'none' };
  if (selected?.length === 0) return { status: 416, headers: { ...headers, 'Content-Range': `bytes */${item.representation.bytes}` }, segments: [] as Segment[], length: 0 };
  const segments: Segment[] = [];
  let status = selected ? 206 : 200;
  if (selected?.length === 1) {
    const [start, end] = selected[0];
    headers['Content-Type'] = item.representation.contentType;
    headers['Content-Range'] = `bytes ${start}-${end - 1}/${item.representation.bytes}`;
    segments.push({ item, start, end });
  } else if (!forceMultipart && items.length === 1 && selected === null) {
    headers['Content-Type'] = item.representation.contentType;
    segments.push({ item, start: 0, end: item.representation.bytes });
  } else {
    const boundary = `kin-${randomUUID()}`;
    headers['Content-Type'] = selected ? `multipart/byteranges; boundary=${boundary}` :
      `multipart/related; type="${item.representation.contentType.split(';')[0]}"; boundary=${boundary}`;
    for (const entry of selected ? selected.map(([start, end]) => ({ item, start, end })) :
      items.map(item => ({ item, start: 0, end: item.representation.bytes }))) {
      const { item, start, end } = entry;
      const extra = selected ? `Content-Range: bytes ${start}-${end - 1}/${item.representation.bytes}\r\n` :
        `Content-Location: ${location(manifest, item.unit)}\r\n`;
      segments.push({ buffer: Buffer.from(`--${boundary}\r\nContent-Type: ${item.representation.contentType}\r\n${extra}\r\n`) },
        entry, { buffer: Buffer.from('\r\n') });
    }
    segments.push({ buffer: Buffer.from(`--${boundary}--\r\n`) });
  }
  const length = segments.reduce((n, s) => n + ('buffer' in s ? s.buffer.length : s.end - s.start), 0);
  if (!Number.isSafeInteger(length)) refuse('ImageLengthInvalid');
  headers['Content-Length'] = String(length);
  return { status, headers, segments, length };
}

/** The study delivery's own record: E's v1 provide-prepared event for this manifest version, naming the study
 * record of every kind the delivery may carry, and a receipt of that same event. */
function checkedDelivery(manifest: ImageManifest, delivery: OnlineImageDelivery) {
  const p = delivery.prepared;
  judgeDelivery([{ prepared: p, observations: [] }]);
  const event = parseAccessEvent(delivery.event);
  if (event.formatVersion !== 1 || p.manifestSha256 !== manifest.sha256 || p.studyUid !== manifest.studyUid ||
      event.eventId !== p.eventId || p.deliveryEventId !== p.eventId || event.action !== 'provide-prepared' || event.result !== 'prepared' ||
      event.managingInstitution.status !== 'known' || event.managingInstitution.value !== manifest.managingInstitution ||
      event.actingInstitution.status !== 'known' || event.actingInstitution.value !== p.receiver.institution ||
      event.cause !== p.cause || delivery.receipt.eventId !== event.eventId) refuse('ImageEventMismatch');
  const kinds = new Set(p.units.map(u => u.recordKind));
  if (!event.targets.length || event.targets.length !== kinds.size) refuse('ImageEventMismatch');
  for (const target of event.targets) {
    if (!('patientLinkSnapshot' in target)) refuse('ImageEventMismatch');
    const { recordId, studyId, versionId, patientLinkSnapshot, kind } = target;
    if (studyId.status !== 'known' || studyId.value !== manifest.studyUid || recordId.status !== 'known' || recordId.value !== manifest.studyUid ||
        versionId.status !== 'known' || versionId.value !== manifest.sha256 || !kinds.delete(kind) ||
        patientLinkSnapshot.status !== 'known' || JSON.stringify(patientLinkSnapshot.value) !== JSON.stringify(manifest.patient)) refuse('ImageEventMismatch');
  }
  return { p, event };
}
/** This response's plan belongs to that delivery: same manifest version, same receiver, units the delivery's
 * record covers (an object of the manifest, of a kind the record names). */
function checkedResponse(manifest: ImageManifest, delivery: PreparedDelivery, p: PreparedDelivery) {
  judgeDelivery([{ prepared: p, observations: [] }]);
  const r = p.receiver, d = delivery.receiver;
  if (p.deliveryEventId !== delivery.eventId || p.eventId === delivery.eventId || p.manifestSha256 !== manifest.sha256 ||
      p.studyUid !== manifest.studyUid || p.managingInstitution !== delivery.managingInstitution || p.cause !== delivery.cause ||
      r.relation !== d.relation || r.institution !== d.institution || r.accountGeneration !== d.accountGeneration ||
      r.openingId !== d.openingId || r.sequence !== d.sequence) refuse('ImageEventMismatch');
  const kinds = new Set(delivery.units.map(u => u.recordKind));
  for (const unit of p.units) {
    if (!kinds.has(unit.recordKind)) refuse('ImageEventMismatch');
    if (unit.sopInstanceUid !== null && !delivery.units.some(u => u.sopInstanceUid === unit.sopInstanceUid)) refuse('ImageEventMismatch');
  }
  return p;
}

/** Check the current caller once on a bounded ledger transaction, stage and hash the exact selected units, store
 * their fixed representation under the delivery's durable record, then write only those same files. A later Orthanc
 * replacement can neither change the body nor borrow its earlier receipt. */
export async function sendOnlineImage(boundary: OnlineImageBoundary, input: {
  manifest: ImageManifest;
  delivery: OnlineImageDelivery;
  /** The current caller's access check for this response, on one bounded transaction before any source read; it
   * returns this response's plan under the delivery's record. */
  prepare(tx: EmrRecordTransaction): Promise<PreparedDelivery>;
  requestId: string;
  response: ServerResponse; signal: AbortSignal; range?: string;
}): Promise<ImageSendResult> {
  const manifest = verifiedManifest(input.manifest);
  const { p: deliveryPlan } = checkedDelivery(manifest, input.delivery);
  const controller = new AbortController(), stop = () => controller.abort();
  const { response } = input;
  let finished = false, directory: string | undefined, saved = false;
  const onClose = () => { if (!finished) stop(); };
  const onFinish = () => { finished = true; };
  input.signal.addEventListener('abort', stop, { once: true });
  response.on('close', onClose); response.on('error', stop); response.on('finish', onFinish);
  if (input.signal.aborted || response.destroyed) stop();
  const signal = controller.signal;
  // Admission can fail synchronously; install no orphaned HTTP listeners then.
  let work: ReturnType<EmrRecordPort['begin']>;
  try { work = boundary.records.begin(); }
  catch (error) {
    input.signal.removeEventListener('abort', stop);
    response.off('close', onClose); response.off('error', stop); response.off('finish', onFinish);
    throw error;
  }
  const copies: ImageCopy[] = [], observations: TransferObservation[] = [], staged: Staged[] = [];
  let responseManifest: ImageResponseManifest;
  let terminal: ImageSendResult['terminal'] = 'transfer-unknown', wireBytes = 0, plannedBytes = 0;
  let observationStored = false, observationError: unknown = null;
  let preparationError: unknown = null;
  let p!: PreparedDelivery;
  try {
    signal.throwIfAborted();
    // No source body is read before the current caller's access check for this response.
    p = checkedResponse(manifest, deliveryPlan, await work.transactionWithRecords(tx => input.prepare(tx)));
    work.end();
    directory = await mkdtemp(join(boundary.stagingDirectory, 'emr-image-'));
    for (const unit of p.units) {
      signal.throwIfAborted();
      const path = join(directory, `${staged.length}.body`), file = await open(path, 'wx');
      const copy: ImageCopy = { location: path, kind: 'staging', eventId: p.eventId, unit: unit.key,
        bytes: null, sha256: null, state: 'present' };
      copies.push(copy);
      const digest = createHash('sha256'); let bytes = 0;
      let source: Awaited<ReturnType<ImageSource['copy']>>;
      try {
        source = await boundary.source.copy(manifest, p, unit, async chunk => {
          signal.throwIfAborted();
          let offset = 0;
          while (offset < chunk.byteLength) {
            const written = await file.write(chunk, offset, chunk.byteLength - offset);
            if (!written.bytesWritten) refuse('ImageStagingFailed');
            offset += written.bytesWritten;
          }
          digest.update(chunk); bytes += chunk.byteLength;
          if (!Number.isSafeInteger(bytes) || unit.expectedBytes !== null && bytes > unit.expectedBytes) refuse('ImageSourceMismatch');
        }, signal);
        signal.throwIfAborted();
      } finally { await file.close(); }
      const sha256 = digest.digest('hex');
      copy.bytes = bytes; copy.sha256 = sha256;
      if (unit.expectedBytes !== null && bytes !== unit.expectedBytes || unit.sha256 !== null && sha256 !== unit.sha256) refuse('ImageSourceMismatch');
      const object = manifest.objects.find(o => o.sopInstanceUid === unit.sopInstanceUid);
      if (unit.part !== 'derived' && source.transferSyntaxUid !== object?.transferSyntaxUid) refuse('ImageSourceMismatch');
      const representation: ImageRepresentation = { unit: unit.key, sopInstanceUid: unit.sopInstanceUid, frame: unit.frame,
        bytes, sha256, contentType: header(source.contentType), transferSyntaxUid: source.transferSyntaxUid,
        source: source.source, representation: unit.part };
      staged.push({ path, unit, representation });
    }
    if (!staged.length) refuse('ScopeOutsideManifest');
    const plan = bodyPlan(staged, manifest, input.range, ['object', 'frames', 'study-retrieve', 'series-retrieve'].includes(p.request.kind));
    plannedBytes = p.body ? plan.length : 0;
    // Store the selected HTTP representation before its first byte. A source
    // digest alone cannot describe a Range response, HEAD or multipart envelope.
    const core = { formatVersion: 1 as const, eventId: p.eventId, deliveryEventId: p.deliveryEventId, studyUid: manifest.studyUid,
      studyManifestSha256: manifest.sha256, request: p.request,
      http: { status: plan.status, headers: plan.headers, body: p.body, range: input.range ?? null, plannedBytes,
        selections: plan.segments.flatMap(s => 'item' in s ? [{ unit: s.item.unit.key, start: s.start, end: s.end }] : []) },
      representations: staged.map(s => s.representation) };
    responseManifest = freeze({ ...core, sha256: createHash('sha256').update(JSON.stringify(core)).digest('hex') });
    signal.throwIfAborted();
    await boundary.evidence.prepared(responseManifest, manifest, copies, input.requestId);
    saved = true;
    signal.throwIfAborted();
    observations.push({ stage: 'provide-prepared', receipt: input.delivery.receipt });
    if (p.body) observations.push(...staged.map(s => ({ stage: 'unit-length' as const, unit: s.unit.key, length: s.representation.bytes })));
    response.statusCode = plan.status;
    for (const [key, value] of Object.entries(plan.headers)) response.setHeader(key, value);
    response.setHeader('X-KIN-Image-Event', p.deliveryEventId);
    response.setHeader('X-KIN-Image-Response', p.eventId);
    response.setHeader('X-KIN-Image-Manifest', responseManifest.sha256);
    const write = (bytes: Buffer): Promise<void> => new Promise((resolve, reject) => {
      if (signal.aborted || response.destroyed) { reject(new Error('ImageTransferAborted')); return; }
      const abort = () => reject(new Error('ImageTransferAborted'));
      signal.addEventListener('abort', abort, { once: true });
      response.write(bytes, error => {
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else { wireBytes += bytes.length; resolve(); }
      });
    });
    if (p.body) for (const segment of plan.segments) {
      if ('buffer' in segment) await write(segment.buffer);
      else if (segment.end > segment.start) {
        let cursor = segment.start;
        const reader = createReadStream(segment.item.path, { start: cursor, end: segment.end - 1, signal });
        for await (const chunk of reader) {
          const data = chunk as Buffer;
          await write(data);
          observations.push({ stage: 'bytes', unit: segment.item.unit.key, start: cursor, end: cursor + data.length,
            verifiedBy: segment.item.unit.sha256 === null ? null : { source: 'store-read', readId: p.eventId,
              sha256: segment.item.representation.sha256 } });
          cursor += data.length;
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new Error('ImageTransferAborted'));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      response.end(() => { signal.removeEventListener('abort', abort); resolve(); });
    });
    terminal = finished ? 'transfer-ended' : 'transfer-unknown';
  } catch (error) {
    if (!saved) { preparationError = error; throw error; }
    terminal = finished ? 'transfer-ended' : 'transfer-aborted';
    if (!response.destroyed) response.destroy();
  } finally {
    try {
      if (saved) {
        // What E observed on its own connection, per response. An unconfirmed process/socket ending is kept as that
        // fact; the delivery's own access record (delivery.ts) is closed from these observations.
        observations.push({ stage: terminal });
        await boundary.evidence.transferred(p.eventId, observations, { bytesWritten: wireBytes, plannedBytes, terminal });
        observationStored = true;
      }
    } catch (error) { observationError = error; }
    finally {
      try {
        if (directory) {
          // This directory was made by this invocation and contains only its
          // staging files. It never names an Orthanc source or a shared cache.
          await rm(directory, { recursive: true });
          for (const copy of copies) copy.state = 'removed';
        }
      } catch (error) {
        for (const copy of copies) copy.state = 'removal-failed';
        observationError ??= error;
      }
      // A failed preparation still accounts for the copies it made, under this response's own ID.
      if (copies.length) try { await boundary.evidence.copiesRemoved(p.eventId, copies); }
      catch (error) { observationError ??= error; }
      work.end();
      input.signal.removeEventListener('abort', stop);
      response.off('close', onClose); response.off('error', stop); response.off('finish', onFinish);
    }
    if (preparationError && observationError) throw new AggregateError([preparationError, observationError], 'ImagePreparationAndCleanupFailed');
  }
  return { manifest: responseManifest, observations, terminal, copies, observationStored, observationError, bytesWritten: wireBytes };
}
