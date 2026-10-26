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
export interface ImageResponseManifest {
  formatVersion: 1; eventId: string; studyUid: string; studyManifestSha256: string;
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
/** The existing storage owner persists these facts on the supplied B2 connection.
 * It must keep the manifest and observation, not merely the AccessEvent's digest.
 * No in-memory map is a production implementation of this port. */
export interface ImageEvidenceStore {
  prepared(tx: EmrRecordTransaction, manifest: ImageResponseManifest, source: ImageManifest, copies: readonly ImageCopy[]): Promise<void>;
  transferred(tx: EmrRecordTransaction, eventId: string, observations: readonly TransferObservation[], wire: {
    bytesWritten: number; plannedBytes: number; terminal: 'transfer-ended' | 'transfer-aborted' | 'transfer-unknown';
  }): Promise<void>;
  /** Also called for failed/rolled-back preparation. An incomplete staging file
   * is still a real copy, but never evidence that its image was provided. */
  copiesRemoved(eventId: string, copies: readonly ImageCopy[]): Promise<void>;
}
export interface OnlineImageBoundary {
  records: EmrRecordPort; evidence: ImageEvidenceStore; source: ImageSource; stagingDirectory: string;
  /** Current identity, institution and StudyAccess, locked on this connection.
   * The identity is compared with the original event by the owning context adapter. */
  authorize(tx: EmrRecordTransaction, event: AccessEvent, manifest: ImageManifest): Promise<void>;
}
export interface ImageSendResult {
  manifest: ImageResponseManifest; observations: readonly TransferObservation[];
  terminal: 'transfer-ended' | 'transfer-aborted' | 'transfer-unknown';
  copies: readonly ImageCopy[]; observationStored: boolean; observationError: unknown | null;
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

/** Stage and hash the exact selected units, then commit their manifest together
 * with B2's provide event. The response reads only those same files. A later
 * Orthanc replacement can neither change the body nor borrow its earlier receipt. */
export async function sendOnlineImage(boundary: OnlineImageBoundary, input: {
  manifest: ImageManifest; prepared: PreparedDelivery; event: AccessEvent;
  response: ServerResponse; signal: AbortSignal; range?: string;
}): Promise<ImageSendResult> {
  const manifest = verifiedManifest(input.manifest), p = input.prepared;
  // The existing public judgement validates the prepared capability and ordering.
  judgeDelivery([{ prepared: p, observations: [] }]);
  const event = parseAccessEvent(input.event);
  // Only E's own v1 provide event names the formal PatientLink of every image
  // target. A v2 branch (local-read, offline, auth) is another producer's fact.
  if (event.formatVersion !== 1 ||
      p.manifestSha256 !== manifest.sha256 || p.studyUid !== manifest.studyUid ||
      event.eventId !== p.eventId || event.action !== 'provide-prepared' || event.result !== 'prepared' ||
      event.managingInstitution.status !== 'known' || event.managingInstitution.value !== manifest.managingInstitution ||
      event.actingInstitution.status !== 'known' || event.actingInstitution.value !== p.receiver.institution ||
      event.cause !== p.cause) refuse('ImageEventMismatch');
  const targets = new Set(p.units.map(u => u.sopInstanceUid ?? manifest.studyUid));
  if (event.targets.length !== targets.size) refuse('ImageEventMismatch');
  for (const target of event.targets) {
    if (!('patientLinkSnapshot' in target)) refuse('ImageEventMismatch');
    const { recordId, studyId, versionId, patientLinkSnapshot, kind } = target;
    if (studyId.status !== 'known' || studyId.value !== manifest.studyUid || recordId.status !== 'known' ||
        !targets.delete(recordId.value) || versionId.status !== 'known' || versionId.value !== manifest.sha256 ||
        patientLinkSnapshot.status !== 'known' || JSON.stringify(patientLinkSnapshot.value) !== JSON.stringify(manifest.patient) ||
        !p.units.some(u => (u.sopInstanceUid ?? manifest.studyUid) === recordId.value && u.recordKind === kind)) refuse('ImageEventMismatch');
  }
  const controller = new AbortController(), stop = () => controller.abort();
  const { response } = input;
  let finished = false, directory: string | undefined, saved = false, admitted = false;
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
  let responseManifest: ImageResponseManifest, receipt: DurableAccessReceipt;
  let terminal: ImageSendResult['terminal'] = 'transfer-unknown', wireBytes = 0, plannedBytes = 0;
  let observationStored = false, observationError: unknown = null;
  let preparationError: unknown = null;
  try {
    signal.throwIfAborted();
    // No source body is read before the current caller's first access check.
    await work.transactionWithRecords(tx => boundary.authorize(tx, event, manifest));
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
    const core = { formatVersion: 1 as const, eventId: p.eventId, studyUid: manifest.studyUid,
      studyManifestSha256: manifest.sha256, request: p.request,
      http: { status: plan.status, headers: plan.headers, body: p.body, range: input.range ?? null, plannedBytes,
        selections: plan.segments.flatMap(s => 'item' in s ? [{ unit: s.item.unit.key, start: s.start, end: s.end }] : []) },
      representations: staged.map(s => s.representation) };
    responseManifest = freeze({ ...core, sha256: createHash('sha256').update(JSON.stringify(core)).digest('hex') });
    const operation = await work.admit(event, undefined, { operationId: event.eventId, attemptId: event.eventId });
    admitted = true;
    const result = await work.transaction(operation, async tx => {
      await boundary.authorize(tx, event, manifest);
      signal.throwIfAborted();
      await boundary.evidence.prepared(tx, responseManifest, manifest, copies);
      return { kind: 'emr-image', id: event.eventId, version: responseManifest.sha256 };
    });
    if (result.outcome !== 'committed' || result.result?.kind !== 'emr-image' ||
        result.result.id !== event.eventId || result.result.version !== responseManifest.sha256) refuse('ImageEventMismatch');
    saved = true;
    receipt = await work.confirm({ provisional: true, operationId: operation.operationId, eventId: event.eventId });
    signal.throwIfAborted();
    observations.push({ stage: 'provide-prepared', receipt });
    if (p.body) observations.push(...staged.map(s => ({ stage: 'unit-length' as const, unit: s.unit.key, length: s.representation.bytes })));
    response.statusCode = plan.status;
    for (const [key, value] of Object.entries(plan.headers)) response.setHeader(key, value);
    response.setHeader('X-KIN-Image-Event', p.eventId);
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
        observations.push({ stage: terminal });
        const followup = parseAccessEvent({ ...event, eventId: randomUUID(), relatedEventId: event.eventId,
          action: terminal === 'transfer-ended' ? 'transfer-ended' : 'transfer-aborted',
          result: terminal === 'transfer-ended' ? 'succeeded' : 'aborted', occurredAt: new Date().toISOString() });
        // An unconfirmed process/socket ending has no v1 access action. Persist
        // that fact without claiming an aborted or successful access event.
        await work.transactionWithRecords(async (tx, record) => {
          const persist = async () => {
            await boundary.evidence.transferred(tx, p.eventId, observations, { bytesWritten: wireBytes, plannedBytes, terminal });
            return { kind: 'emr-image', id: p.eventId, version: responseManifest.sha256 };
          };
          if (terminal === 'transfer-unknown') await persist(); else await record(followup, persist);
        });
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
      // COMMIT may be unknown even though the manifest exists. Cleanup is still
      // observed under this same event ID, never by inventing another attempt.
      if (admitted || copies.length) try { await boundary.evidence.copiesRemoved(p.eventId, copies); }
      catch (error) { observationError ??= error; }
      work.end();
      input.signal.removeEventListener('abort', stop);
      response.off('close', onClose); response.off('error', stop); response.off('finish', onFinish);
    }
    if (preparationError && observationError) throw new AggregateError([preparationError, observationError], 'ImagePreparationAndCleanupFailed');
  }
  return { manifest: responseManifest, observations, terminal, copies, observationStored, observationError };
}
