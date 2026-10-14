/*
 * The whole-original download archive of one study (S9-U4p contract §5.2, R3 persistent format).
 *
 * Three pure pieces the download service composes: the canonical preparation manifest (the persisted string whose
 * SHA-256 binds an operation), the exact ZIP32 pre-computation that refuses an oversize archive before byte 1, and a
 * streaming STORE writer that hashes every object while it passes and never closes a short or mismatching archive as
 * a successful ZIP. No Orthanc client, no timers and no database here: the caller supplies one Readable per object,
 * the response as the sink, and hooks for its no-progress timer, lease fencing and per-object checkpoints.
 */
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import type { Readable, Writable } from 'node:stream';

export interface ManifestObjectInput {
  orthancId: string;
  seriesUid: string;
  sopUid: string;
  bytes: number;
  md5: string;
}

export interface ManifestObject extends ManifestObjectInput {
  /** `<series>/<instance>.dcm`, 1-based ordinals zero-padded to at least 3 and 5 digits. */
  path: string;
}

export interface OriginalManifest {
  schemaVersion: 1;
  studyUid: string;
  objects: ManifestObject[];
}

export type ManifestRefusalReason = 'empty' | 'invalid-field' | 'duplicate-sop' | 'duplicate-orthanc-id';

export type CanonicalManifestResult =
  | { ok: true; manifest: OriginalManifest; manifestCanonical: string; manifestSha256: string }
  | { ok: false; code: 'MANIFEST_INCOMPLETE'; reason: ManifestRefusalReason; message: string };

export type StoredManifestResult =
  | { ok: true; manifest: OriginalManifest; manifestCanonical: string; manifestSha256: string }
  | { ok: false; code: 'MANIFEST_STORE_INVALID'; message: string };

export interface ArchiveEntryPlan {
  name: string;
  /** f_i: UTF-8 byte length of the name. */
  nameBytes: number;
  /** s_i: stored payload length (the DICOM object's bytes, or M for manifest.json). */
  size: number;
  localOffset: number;
  /** L_i = 30 + f_i + s_i + 16 (local header, payload, data descriptor with signature). */
  localSize: number;
  /** C_i = 46 + f_i. */
  centralSize: number;
  /** The manifest object this entry carries; null for the final manifest.json. */
  object: ManifestObject | null;
}

export interface ArchivePlan {
  studyUid: string;
  objects: readonly ManifestObject[];
  /** DICOM entries in manifest order, then manifest.json. */
  entries: readonly ArchiveEntryPlan[];
  entryCount: number;
  /** M: exact UTF-8 length of the final manifest.json (each sha256 is 64 hex characters). */
  manifestSize: number;
  centralOffset: number;
  centralSize: number;
  /** T = O + C + 22, the exact byte count the writer produces. */
  totalSize: number;
}

export type ArchiveTooLargeReason =
  | 'too-many-entries' | 'name-too-long' | 'entry-too-large' | 'offset-too-large' | 'central-directory-too-large' | 'archive-too-large';

export type ArchivePlanResult =
  | { ok: true; plan: ArchivePlan }
  | { ok: false; code: 'ARCHIVE_TOO_LARGE'; reason: ArchiveTooLargeReason; message: string };

/** The §5.2 step 4 attempt object shape; sha256/md5 stay null unless the whole object was read and matched. */
export interface ArchiveObjectResult {
  orthancId: string;
  sopUid: string;
  bytesRead: number;
  /** DICOM payload bytes handed to the sink; not proof that anyone received or saved them. */
  bytesSupplied: number;
  sha256: string | null;
  md5: string | null;
  complete: boolean;
}

export interface ArchiveProgress {
  index: number;
  orthancId: string;
  sopUid: string;
  bytesRead: number;
  bytesSupplied: number;
  archiveBytesWritten: number;
}

export type ArchiveStopReason =
  | 'length-mismatch' | 'md5-mismatch' | 'source-error' | 'sink-closed' | 'sink-error' | 'aborted' | 'fenced'
  | 'checkpoint-failed' | 'plan-mismatch' | 'internal-error';

export interface ArchiveWriteResult {
  /** 'finished' only after all T bytes were written and the sink finished; otherwise the sink was destroyed, never ended. */
  state: 'finished' | 'incomplete';
  reason: ArchiveStopReason | null;
  /** SHA-256 of the whole archive; null unless finished (a partial hash is never reported as the archive hash). */
  archiveSha256: string | null;
  /** One row per object the writer started, in manifest order. */
  objects: ArchiveObjectResult[];
  bytesWritten: number;
}

export interface WriteArchiveOptions {
  plan: ArchivePlan;
  /** The stored original bytes of one manifest object (e.g. its Orthanc file stream). */
  source: (object: ManifestObject, index: number) => Readable | Promise<Readable>;
  sink: Writable;
  /** Awaited after each verified object and before the next one starts; a rejection stops the archive (checkpoint). */
  onObjectDone?: (result: ArchiveObjectResult, index: number) => void | Promise<void>;
  /** Called after every payload chunk reaches the sink; the caller's no-progress timer hangs off this. */
  onProgress?: (progress: ArchiveProgress) => void;
  /** Consulted immediately before every sink write; false or a rejection stops the archive (lease fencing). */
  beforeWrite?: () => boolean | Promise<boolean>;
  /** Aborting stops the archive before its next write (cancellation, revoked rights, the caller's timer). */
  signal?: AbortSignal;
}

export const ORIGINAL_ARCHIVE_MANIFEST_NAME = 'manifest.json';

export const ORIGINAL_ARCHIVE_LIMITS = Object.freeze({
  /** Every s_i, local offset, O, C and T must stay strictly below this (no ZIP64, no 0xFFFFFFFF sentinel). */
  uint32Exclusive: 0xffffffff,
  /** N = DICOM objects + manifest.json must stay strictly below this (no 0xFFFF sentinel). */
  entriesExclusive: 65535,
  maxDicomObjects: 65533,
  maxNameBytes: 65535,
});

/** User-facing Korean text (AGENTS §4); ARCHIVE_TOO_LARGE is the contract's sentence. */
export const ORIGINAL_ARCHIVE_MESSAGES = Object.freeze({
  ARCHIVE_TOO_LARGE: '검사 원본 묶음이 내려받기 한도를 넘었습니다.',
  MANIFEST_INCOMPLETE: '검사 원본 목록을 완전하게 만들지 못했습니다. 내려받기는 시작되지 않았습니다.',
  MANIFEST_STORE_INVALID: '저장된 원본 목록이 손상되어 내려받을 수 없습니다. 관리자에게 알려 주세요.',
});

const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
const MD5_HEX = /^[0-9a-f]{32}$/;
const ZERO_SHA256 = '0'.repeat(64);

const visible = (value: unknown): value is string => typeof value === 'string' && VISIBLE_ASCII.test(value);
const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const ascii = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const pad = (ordinal: number, width: number) => String(ordinal).padStart(width, '0');

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

const incomplete = (reason: ManifestRefusalReason): CanonicalManifestResult =>
  ({ ok: false, code: 'MANIFEST_INCOMPLETE', reason, message: ORIGINAL_ARCHIVE_MESSAGES.MANIFEST_INCOMPLETE });

/**
 * The preparation manifest in its persisted form: key order {schemaVersion,studyUid,objects:[{orthancId,seriesUid,
 * sopUid,bytes,md5,path}]}, compact JSON.stringify output (no whitespace, no final LF), objects sorted by
 * (seriesUid, sopUid, orthancId) in ASCII order. An empty set and duplicate SOP or Orthanc IDs are refused.
 */
export function canonicalManifest(studyUid: string, objects: readonly ManifestObjectInput[]): CanonicalManifestResult {
  if (!visible(studyUid) || !Array.isArray(objects)) return incomplete('invalid-field');
  if (objects.length === 0) return incomplete('empty');
  const copies: ManifestObjectInput[] = [];
  for (const o of objects) {
    if (!o || typeof o !== 'object' || !visible(o.orthancId) || !visible(o.seriesUid) || !visible(o.sopUid) ||
        !Number.isSafeInteger(o.bytes) || o.bytes < 0 || typeof o.md5 !== 'string' || !MD5_HEX.test(o.md5))
      return incomplete('invalid-field');
    copies.push({ orthancId: o.orthancId, seriesUid: o.seriesUid, sopUid: o.sopUid, bytes: o.bytes, md5: o.md5 });
  }
  const sops = new Set<string>();
  const ids = new Set<string>();
  for (const o of copies) {
    if (sops.has(o.sopUid)) return incomplete('duplicate-sop');
    if (ids.has(o.orthancId)) return incomplete('duplicate-orthanc-id');
    sops.add(o.sopUid);
    ids.add(o.orthancId);
  }
  copies.sort((a, b) => ascii(a.seriesUid, b.seriesUid) || ascii(a.sopUid, b.sopUid) || ascii(a.orthancId, b.orthancId));
  let series = 0;
  let instance = 0;
  let previous: string | null = null;
  const ordered: ManifestObject[] = copies.map(o => {
    if (o.seriesUid !== previous) {
      series += 1;
      instance = 0;
      previous = o.seriesUid;
    }
    instance += 1;
    return { orthancId: o.orthancId, seriesUid: o.seriesUid, sopUid: o.sopUid, bytes: o.bytes, md5: o.md5, path: `${pad(series, 3)}/${pad(instance, 5)}.dcm` };
  });
  const manifest: OriginalManifest = { schemaVersion: 1, studyUid, objects: ordered };
  const manifestCanonical = JSON.stringify(manifest);
  return { ok: true, manifest: deepFreeze(manifest), manifestCanonical, manifestSha256: sha256Hex(manifestCanonical) };
}

/**
 * A stored manifest is usable only when its SHA-256 matches and it is byte-for-byte the canonical form of its own
 * content; anything else is MANIFEST_STORE_INVALID and is never silently rebuilt.
 */
export function parseCanonicalManifest(manifestCanonical: string, manifestSha256: string): StoredManifestResult {
  const invalid: StoredManifestResult = { ok: false, code: 'MANIFEST_STORE_INVALID', message: ORIGINAL_ARCHIVE_MESSAGES.MANIFEST_STORE_INVALID };
  if (typeof manifestCanonical !== 'string' || typeof manifestSha256 !== 'string' || sha256Hex(manifestCanonical) !== manifestSha256) return invalid;
  let parsed: any;
  try {
    parsed = JSON.parse(manifestCanonical);
  } catch {
    return invalid;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1 || !Array.isArray(parsed.objects)) return invalid;
  const rebuilt = canonicalManifest(parsed.studyUid, parsed.objects.map((o: any) =>
    o && typeof o === 'object' ? { orthancId: o.orthancId, seriesUid: o.seriesUid, sopUid: o.sopUid, bytes: o.bytes, md5: o.md5 } : o));
  if (!rebuilt.ok || rebuilt.manifestCanonical !== manifestCanonical) return invalid;
  return { ok: true, manifest: rebuilt.manifest, manifestCanonical, manifestSha256 };
}

/** §5.2 step 7: the final manifest.json, in preparation order, with the per-object SHA-256 computed while sending. */
function finalManifestText(studyUid: string, objects: readonly ManifestObject[], sha256: readonly string[]) {
  return JSON.stringify({
    schemaVersion: 1,
    studyUid,
    objects: objects.map((o, index) => ({ seriesUid: o.seriesUid, sopUid: o.sopUid, bytes: o.bytes, sha256: sha256[index] })),
  });
}

const tooLarge = (reason: ArchiveTooLargeReason): ArchivePlanResult =>
  ({ ok: false, code: 'ARCHIVE_TOO_LARGE', reason, message: ORIGINAL_ARCHIVE_MESSAGES.ARCHIVE_TOO_LARGE });

/**
 * The exact ZIP32 layout of the archive, computed in BigInt before byte 1 (§5.2 "ZIP32 정확 사전 계산"). The input
 * must be a canonical manifest (from canonicalManifest or parseCanonicalManifest); anything else is a programming error.
 */
export function planArchive(manifest: OriginalManifest): ArchivePlanResult {
  const given = manifest && Array.isArray(manifest.objects) ? manifest.objects : [];
  const check = canonicalManifest(manifest?.studyUid, given.map(o =>
    o && typeof o === 'object' ? { orthancId: o.orthancId, seriesUid: o.seriesUid, sopUid: o.sopUid, bytes: o.bytes, md5: o.md5 } : o));
  if (!check.ok || JSON.stringify(manifest) !== check.manifestCanonical) throw new TypeError('planArchive needs a canonical manifest');
  const { studyUid, objects } = check.manifest;
  const limit = BigInt(ORIGINAL_ARCHIVE_LIMITS.uint32Exclusive);
  const entryCount = objects.length + 1;
  if (entryCount >= ORIGINAL_ARCHIVE_LIMITS.entriesExclusive) return tooLarge('too-many-entries');

  const manifestSize = Buffer.byteLength(finalManifestText(studyUid, objects, objects.map(() => ZERO_SHA256)), 'utf8');
  const layout: { name: string; nameBytes: number; size: bigint; offset: bigint; object: ManifestObject | null }[] = [];
  let offset = 0n;
  let central = 0n;
  for (let index = 0; index < entryCount; index += 1) {
    const object = index < objects.length ? objects[index] : null;
    const name = object ? object.path : ORIGINAL_ARCHIVE_MANIFEST_NAME;
    const nameBytes = Buffer.byteLength(name, 'utf8');
    const size = BigInt(object ? object.bytes : manifestSize);
    if (nameBytes > ORIGINAL_ARCHIVE_LIMITS.maxNameBytes) return tooLarge('name-too-long');
    if (size >= limit) return tooLarge('entry-too-large');
    if (offset >= limit) return tooLarge('offset-too-large');
    layout.push({ name, nameBytes, size, offset, object });
    offset += 30n + BigInt(nameBytes) + size + 16n;
    central += 46n + BigInt(nameBytes);
  }
  const total = offset + central + 22n;
  if (offset >= limit) return tooLarge('offset-too-large');
  if (central >= limit) return tooLarge('central-directory-too-large');
  if (total >= limit) return tooLarge('archive-too-large');

  // Every value is now below 2^32, so Number is exact from here on.
  const entries: ArchiveEntryPlan[] = layout.map(e => ({
    name: e.name,
    nameBytes: e.nameBytes,
    size: Number(e.size),
    localOffset: Number(e.offset),
    localSize: Number(30n + BigInt(e.nameBytes) + e.size + 16n),
    centralSize: 46 + e.nameBytes,
    object: e.object,
  }));
  return {
    ok: true,
    plan: deepFreeze({
      studyUid,
      objects,
      entries,
      entryCount,
      manifestSize,
      centralOffset: Number(offset),
      centralSize: Number(central),
      totalSize: Number(total),
    }),
  };
}

// PKWARE APPNOTE 4.3.7 / 4.3.9 / 4.3.12 / 4.3.16 with the §5.2 fixed choices.
const LOCAL_FILE_HEADER = 0x04034b50;
const DATA_DESCRIPTOR = 0x08074b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const VERSION = 20;
/** Bit 3: sizes and CRC follow in a data descriptor; bit 11: names are UTF-8. */
const FLAGS = 0x0808;
const STORE = 0;
const DOS_TIME = 0x0000;
/** 1980-01-01: ((1980 - 1980) << 9) | (1 << 5) | 1. */
const DOS_DATE = 0x0021;

function localHeader(name: Buffer) {
  const h = Buffer.alloc(30 + name.length);
  h.writeUInt32LE(LOCAL_FILE_HEADER, 0);
  h.writeUInt16LE(VERSION, 4);
  h.writeUInt16LE(FLAGS, 6);
  h.writeUInt16LE(STORE, 8);
  h.writeUInt16LE(DOS_TIME, 10);
  h.writeUInt16LE(DOS_DATE, 12);
  // CRC-32 and both sizes stay zero here: bit 3 puts them in the data descriptor.
  h.writeUInt16LE(name.length, 26);
  name.copy(h, 30);
  return h;
}

function dataDescriptor(crc: number, size: number) {
  const d = Buffer.alloc(16);
  d.writeUInt32LE(DATA_DESCRIPTOR, 0);
  d.writeUInt32LE(crc, 4);
  d.writeUInt32LE(size, 8);
  d.writeUInt32LE(size, 12);
  return d;
}

function centralDirectory(plan: ArchivePlan, crcs: readonly number[]) {
  const out = Buffer.alloc(plan.centralSize);
  let at = 0;
  plan.entries.forEach((entry, index) => {
    const name = Buffer.from(entry.name, 'utf8');
    out.writeUInt32LE(CENTRAL_DIRECTORY_HEADER, at);
    out.writeUInt16LE(VERSION, at + 4); // made by: 2.0, MS-DOS attribute compatibility (external attributes 0)
    out.writeUInt16LE(VERSION, at + 6);
    out.writeUInt16LE(FLAGS, at + 8);
    out.writeUInt16LE(STORE, at + 10);
    out.writeUInt16LE(DOS_TIME, at + 12);
    out.writeUInt16LE(DOS_DATE, at + 14);
    out.writeUInt32LE(crcs[index], at + 16);
    out.writeUInt32LE(entry.size, at + 20);
    out.writeUInt32LE(entry.size, at + 24);
    out.writeUInt16LE(name.length, at + 28);
    // extra, comment, disk number start, internal and external attributes stay zero.
    out.writeUInt32LE(entry.localOffset, at + 42);
    name.copy(out, at + 46);
    at += 46 + name.length;
  });
  return out;
}

function endOfCentralDirectory(plan: ArchivePlan) {
  const e = Buffer.alloc(22);
  e.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  e.writeUInt16LE(plan.entryCount, 8);
  e.writeUInt16LE(plan.entryCount, 10);
  e.writeUInt32LE(plan.centralSize, 12);
  e.writeUInt32LE(plan.centralOffset, 16);
  return e;
}

class Stop {
  reason: ArchiveStopReason;
  constructor(reason: ArchiveStopReason) {
    this.reason = reason;
  }
}

/** Sink events as state, so a client that goes away mid-stream ends the archive instead of hanging it on 'drain'. */
function watchSink(sink: Writable) {
  let failure: ArchiveStopReason | null = null;
  let drained = true;
  let finished = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    const resume = wake;
    wake = null;
    if (resume) resume();
  };
  const listeners: Record<string, () => void> = {
    error: () => {
      if (!failure) failure = 'sink-error';
      notify();
    },
    close: () => {
      if (!finished && !failure) failure = 'sink-closed';
      notify();
    },
    drain: () => {
      drained = true;
      notify();
    },
    finish: () => {
      finished = true;
      notify();
    },
  };
  for (const [event, listener] of Object.entries(listeners)) sink.on(event, listener);
  const until = (ready: () => boolean) => new Promise<void>((resolve, reject) => {
    const check = () => {
      if (ready()) return resolve();
      if (failure) return reject(new Stop(failure));
      wake = check;
    };
    check();
  });
  return {
    failure: () => failure,
    abort: () => {
      if (!failure) failure = 'aborted';
      notify();
    },
    drain: () => {
      drained = false;
      return until(() => drained);
    },
    finish: () => until(() => finished),
    dispose: () => {
      for (const [event, listener] of Object.entries(listeners)) sink.off(event, listener);
    },
  };
}

/**
 * Streams the planned archive into the sink: per object a local header, the stored bytes read at most up to
 * manifest bytes + 1 while CRC-32, MD5 and SHA-256 are computed, then the data descriptor; then manifest.json, the
 * central directory and the end record. A short or long object, an MD5 mismatch, a source or sink failure, an abort,
 * a lost lease or a failed checkpoint stops the archive, destroys the sink without ending it and reports 'incomplete'.
 */
export async function writeArchive(options: WriteArchiveOptions): Promise<ArchiveWriteResult> {
  const { plan, source, sink, onObjectDone, onProgress, beforeWrite, signal } = options;
  const archiveHash = createHash('sha256');
  const objects: ArchiveObjectResult[] = [];
  const crcs: number[] = [];
  let written = 0;
  const watch = watchSink(sink);
  const copy = (r: ArchiveObjectResult): ArchiveObjectResult => ({ ...r });

  const put = async (chunk: Uint8Array) => {
    if (beforeWrite) {
      let allowed: boolean;
      try {
        allowed = await beforeWrite();
      } catch {
        throw new Stop('fenced');
      }
      if (allowed === false) throw new Stop('fenced');
    }
    if (signal?.aborted) throw new Stop('aborted');
    const failure = watch.failure();
    if (failure) throw new Stop(failure);
    if (sink.destroyed || sink.writableEnded) throw new Stop('sink-closed');
    archiveHash.update(chunk);
    written += chunk.length;
    if (!sink.write(chunk)) await watch.drain();
  };

  // An abort must also end a wait on a stalled source or a stalled receiver, not only the next write.
  let current: Readable | null = null;
  const onAbort = () => {
    if (current && typeof current.destroy === 'function' && !current.destroyed) current.destroy();
    watch.abort();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const finishWith = <T>(value: T): T => {
    signal?.removeEventListener('abort', onAbort);
    watch.dispose();
    return value;
  };

  let reason: ArchiveStopReason = 'internal-error';
  try {
    if (!plan || !Array.isArray(plan.entries) || plan.entries.length !== plan.objects.length + 1) throw new Stop('plan-mismatch');
    for (let index = 0; index < plan.objects.length; index += 1) {
      const entry = plan.entries[index];
      const object = entry.object;
      if (!object || written !== entry.localOffset) throw new Stop('plan-mismatch');
      if (signal?.aborted) throw new Stop('aborted');
      const result: ArchiveObjectResult = {
        orthancId: object.orthancId, sopUid: object.sopUid, bytesRead: 0, bytesSupplied: 0, sha256: null, md5: null, complete: false,
      };
      objects.push(result);
      let stream: Readable;
      try {
        stream = await source(object, index);
      } catch {
        throw new Stop(signal?.aborted ? 'aborted' : 'source-error');
      }
      current = stream;
      if (signal?.aborted) onAbort();
      const md5 = createHash('md5');
      const sha256 = createHash('sha256');
      let crc = 0;
      let overLength = false;
      try {
        await put(localHeader(Buffer.from(entry.name, 'utf8')));
        for await (const chunk of stream) {
          if (!(chunk instanceof Uint8Array)) throw new Stop('source-error');
          // Never read past manifest bytes + 1: one byte too many already proves a length mismatch.
          const piece = chunk.subarray(0, Math.min(chunk.length, object.bytes + 1 - result.bytesRead));
          result.bytesRead += piece.length;
          if (result.bytesRead > object.bytes) {
            overLength = true;
            break;
          }
          md5.update(piece);
          sha256.update(piece);
          crc = crc32(piece, crc);
          await put(piece);
          result.bytesSupplied += piece.length;
          if (onProgress) {
            try {
              onProgress({ index, orthancId: object.orthancId, sopUid: object.sopUid, bytesRead: result.bytesRead,
                bytesSupplied: result.bytesSupplied, archiveBytesWritten: written });
            } catch {
              throw new Stop('aborted');
            }
          }
        }
      } catch (error) {
        throw error instanceof Stop ? error : new Stop(signal?.aborted ? 'aborted' : 'source-error');
      } finally {
        current = null;
        if (stream && typeof stream.destroy === 'function' && !stream.destroyed) stream.destroy();
      }
      if (overLength || result.bytesRead !== object.bytes) throw new Stop('length-mismatch');
      const md5Hex = md5.digest('hex');
      if (md5Hex !== object.md5) throw new Stop('md5-mismatch');
      result.sha256 = sha256.digest('hex');
      result.md5 = md5Hex;
      result.complete = true;
      await put(dataDescriptor(crc, object.bytes));
      crcs.push(crc);
      if (onObjectDone) {
        try {
          await onObjectDone(copy(result), index);
        } catch {
          throw new Stop('checkpoint-failed');
        }
      }
    }

    const manifestEntry = plan.entries[plan.objects.length];
    const manifestBytes = Buffer.from(finalManifestText(plan.studyUid, plan.objects, objects.map(o => o.sha256)), 'utf8');
    if (written !== manifestEntry.localOffset || manifestBytes.length !== manifestEntry.size) throw new Stop('plan-mismatch');
    const manifestCrc = crc32(manifestBytes);
    await put(localHeader(Buffer.from(manifestEntry.name, 'utf8')));
    await put(manifestBytes);
    await put(dataDescriptor(manifestCrc, manifestBytes.length));
    crcs.push(manifestCrc);
    if (written !== plan.centralOffset) throw new Stop('plan-mismatch');
    await put(centralDirectory(plan, crcs));
    await put(endOfCentralDirectory(plan));
    if (written !== plan.totalSize) throw new Stop('plan-mismatch');
    if (signal?.aborted) throw new Stop('aborted');
    sink.end();
    await watch.finish();
    return finishWith<ArchiveWriteResult>({
      state: 'finished', reason: null, archiveSha256: archiveHash.digest('hex'), objects: objects.map(copy), bytesWritten: written,
    });
  } catch (error) {
    if (error instanceof Stop) reason = error.reason;
  }
  // Destroy, never end: the receiver must see a broken transfer, not a short archive that looks finished.
  if (!sink.destroyed) sink.destroy();
  return finishWith<ArchiveWriteResult>({ state: 'incomplete', reason, archiveSha256: null, objects: objects.map(copy), bytesWritten: written });
}
