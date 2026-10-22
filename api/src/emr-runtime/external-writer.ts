import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { FailureJournal as JournalFile, protectedDirectory, syncDirectory } from './journal-file';
import type { WriterRequest } from './coordinator';
import type { CommitBinding, ExpiryCore } from './seal';
import type { PairIdentity, SealedBundleProof } from './state-protocol';
import { parseCommitBinding, parseSealedBundleProof } from './state-protocol';
import * as V4 from './checkpoint-v4';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameLegacy = (a: unknown, b: unknown) => hash(a) === hash(b);
const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value));
const fail = (code: string) => { throw Object.assign(new Error(code), { code }); };
function atomic(file: string, value: unknown): void {
  const temporary = path.join(path.dirname(file), '.tmp-' + randomBytes(12).toString('hex'));
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file); syncDirectory(path.dirname(file));
}
function load(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return null; return fail('SealCorrupt'); }
}
function publishTail(file: string, value: unknown): void {
  if (!fs.existsSync(file)) { atomic(file, value); return; }
  // The already-synced WAL authorizes repair of this exact publication. Keep the
  // directory entry stable: no rename/directory fsync is needed for each receipt.
  // A torn overwrite is repaired only while that WAL publication is incomplete.
  const bytes = Buffer.from(JSON.stringify(value)), fd = fs.openSync(file, 'r+');
  try {
    fs.writeFileSync(fd, bytes); fs.ftruncateSync(fd, bytes.length); fs.fdatasyncSync(fd);
  } finally { fs.closeSync(fd); }
}
export interface BundleReference {
  stream: 'viewing' | 'history'; attemptId: string; sealed: { sequence: number; hash: string };
}
export type BundleAttestation = {
  version: 1; serviceEpoch: string; refs: BundleReference[];
} & ({ phase: 'published'; eventId: string | null; requiredStreams: ('viewing' | 'history')[] } |
  { phase: 'acknowledged'; proofSha256: string });
export interface StateLineage { version: 1; id: string; origin: PairIdentity }
export const samePair = (a: PairIdentity, b: PairIdentity) => a && b && a.instanceId === b.instanceId &&
  a.chains.viewing === b.chains.viewing && a.chains.history === b.chains.history &&
  (['database', 'oid', 'address', 'port'] as const).every(k => a.database[k] === b.database[k]);

/**
 * EMR-B2 (c) v3 private copy (D1656-T07): a captured pair restored as a labelled private copy keeps its origin
 * lineage unchanged while the physical database it is paired with is another one (new oid/address, the same chain
 * identifiers because the chains themselves were restored). Only the trusted restore launcher supplies this mapping,
 * launch-scoped (never persisted, never a wire field): the recovery root admits the copy when the stored origin is
 * exactly `source`, the independently observed database is exactly `target`, and both share the chains. Clients cannot
 * select a namespace: the protocol has no such field and the service reports the target pair as its own.
 */
export interface CopyMapping { source: PairIdentity; target: PairIdentity }
function validPair(value: any): value is PairIdentity {
  return isRecord(value) && keys(value, ['instanceId', 'chains', 'database']) && text(value.instanceId) &&
    keys(value.chains, ['viewing', 'history']) && uuid(value.chains.viewing) && uuid(value.chains.history) &&
    keys(value.database, ['database', 'oid', 'address', 'port']) && text(value.database.database) && integer(value.database.oid, 1) &&
    (value.database.address === null || text(value.database.address)) && (value.database.port === null || integer(value.database.port, 1));
}
export function parseCopyMapping(raw: unknown): CopyMapping {
  const value = raw as any;
  if (!isRecord(value) || !keys(value, ['source', 'target']) || !validPair(value.source) || !validPair(value.target) ||
    value.source.chains.viewing !== value.target.chains.viewing || value.source.chains.history !== value.target.chains.history ||
    samePair(value.source, value.target)) return fail('SealChainMismatch');
  return { source: clone(value.source), target: clone(value.target) };
}
/** The admit-pair value: the observed pair alone, or the observed target with the launch-scoped copy mapping. */
export interface PairAdmission { pair: PairIdentity; copy: CopyMapping | null }
export function pairAdmission(raw: unknown): PairAdmission {
  const value = raw as any;
  if (isRecord(value) && keys(value, ['pair', 'copy'])) {
    const copy = value.copy === null ? null : parseCopyMapping(value.copy);
    if (!validPair(value.pair) || (copy && !samePair(copy.target, value.pair))) return fail('SealChainMismatch');
    return { pair: clone(value.pair), copy };
  }
  if (!validPair(value)) return fail('SealChainMismatch');
  return { pair: clone(value), copy: null };
}
export interface ExternalState {
  version: 3; revision: number; generation: number; tail: any;
  lineage: StateLineage | null; bundles: Record<string, BundleAttestation>;
  intents: Record<string, any>; slots: Record<string, any>; proofs: Record<string, any>;
  terminal: Record<string, any>; retired: Record<string, number>;
}
const maps = ['intents', 'slots', 'proofs', 'terminal', 'retired', 'bundles'] as const;
const isRecord = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (v: any, k: string) => Object.prototype.hasOwnProperty.call(v, k);
const keys = (v: any, names: readonly string[]) => isRecord(v) && Object.keys(v).length === names.length &&
  names.every(k => has(v, k));
const integer = (v: any, min = 0) => Number.isSafeInteger(v) && v >= min;
const sha = (v: any) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const uuid = (v: any) => typeof v === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const text = (v: any) => typeof v === 'string' && v.length > 0 && !v.includes('\0');
const position = (v: any, frontier = false) => keys(v, frontier ? ['chainId', 'sequence', 'hash'] : ['sequence', 'hash']) &&
  integer(v.sequence) && sha(v.hash) && (!frontier || uuid(v.chainId));
function validateTail(tail: any, generation: number, origin?: PairIdentity): void {
  if (!keys(tail, ['streams', 'sealedAt', 'generation']) || !keys(tail.streams, ['viewing', 'history']) ||
    !position(tail.streams.viewing, true) || !position(tail.streams.history, true) ||
    !text(tail.sealedAt) || !Number.isFinite(Date.parse(tail.sealedAt)) ||
    !integer(tail.generation, 1) || tail.generation > generation || origin &&
    ['viewing', 'history'].some(stream => tail.streams[stream].chainId !== origin.chains?.[stream])) return fail('SealCorrupt');
}
function validateAttestation(a: any): void {
  if (!keys(a, a?.phase === 'published' ? ['version', 'phase', 'serviceEpoch', 'refs', 'eventId', 'requiredStreams'] :
    ['version', 'phase', 'serviceEpoch', 'refs', 'proofSha256']) || a.version !== 1 || !uuid(a.serviceEpoch) ||
    !['published', 'acknowledged'].includes(a.phase) || !Array.isArray(a.refs) ||
    !(a.refs.length === 1 || a.refs.length === 2)) return fail('SealCorrupt');
  if (a.refs.some((r, i) => !keys(r, ['stream', 'attemptId', 'sealed']) || r.stream !== (i === 0 ? 'viewing' : 'history') ||
    !text(r.attemptId) || !position(r.sealed) || r.sealed.sequence < 1)) return fail('SealCorrupt');
  if (a.phase === 'published' ? !(a.eventId === null || text(a.eventId)) ||
    !sameLegacy(a.requiredStreams, a.refs.map(r => r.stream)) : !sha(a.proofSha256)) return fail('SealCorrupt');
}
/** A checkpoint can cover old WAL revisions without making malformed complete records valid.
 * Check each stored value independently before deciding whether replay can skip it. */
function validateMapKey(name: typeof maps[number], id: string): void {
  const split = id.indexOf(':'), prefix = id.slice(0, split), rest = id.slice(split + 1);
  if (name === 'retired' ? !['viewing', 'history'].includes(id) : split < 0 || !text(rest) ||
    (name === 'bundles' ? prefix !== 'bundle' : !['viewing', 'history'].includes(prefix)) ||
    name === 'slots' && (!integer(Number(rest), 1) || String(Number(rest)) !== rest)) return fail('SealCorrupt');
}
function validateMapValue(name: typeof maps[number], id: string, value: any, generation: number, origin?: PairIdentity): void {
  validateMapKey(name, id);
  const binding = (value: unknown) => {
    const q = parseCommitBinding(value);
    if (q.generation > generation || origin && q.chainId !== origin.chains?.[q.stream]) return fail('SealCorrupt');
    return q;
  };
  try {
    if (name === 'retired') {
      if (!integer(value) || value > generation) return fail('SealCorrupt');
    } else if (name === 'bundles') {
      if (!id.startsWith('bundle:') || !text(id.slice(7))) return fail('SealCorrupt');
      validateAttestation(value);
    } else if (name === 'intents') {
      if (!keys(value, ['stream', 'attemptId', 'eventId', 'contentSha256', 'bundleId', 'owner']) ||
        !['viewing', 'history'].includes(value.stream) || !text(value.attemptId) || !text(value.bundleId) || !text(value.owner) ||
        !(value.eventId === null || text(value.eventId)) || !sha(value.contentSha256) ||
        id !== value.stream + ':' + value.attemptId) return fail('SealCorrupt');
    } else if (name === 'slots') {
      const q = binding(value);
      if (id !== q.stream + ':' + q.sequence) return fail('SealCorrupt');
    } else if (name === 'proofs') {
      if (!keys(value, ['format', 'binding', 'seal', 'anchor', 'count']) || value.format !== 1 ||
        !isRecord(value.binding) || has(value.binding, 'proofDigest') ||
        !position(value.seal, true) || !position(value.anchor) || !integer(value.count, 1) ||
        value.count > value.anchor.sequence || value.anchor.sequence > value.seal.sequence) return fail('SealCorrupt');
      const q = binding({ ...value.binding, proofDigest: null });
      if (q.kind !== 'expiry' || id !== q.stream + ':' + q.attemptId || value.seal.chainId !== q.chainId ||
        value.seal.sequence + 1 !== q.sequence || value.seal.hash !== q.previousHash) return fail('SealCorrupt');
    } else {
      if (!isRecord(value) || !keys(value, ['phase', 'generation', 'binding',
        ...(has(value, 'owner') ? ['owner'] : []), ...(has(value, 'notFound') ? ['notFound'] : [])]) ||
        !['committed', 'aborted', 'superseded'].includes(value.phase) || !integer(value.generation, 1) ||
        has(value, 'owner') && !text(value.owner) || has(value, 'notFound') &&
        (!keys(value.notFound, ['eventId', 'contentSha256']) || !text(value.notFound.eventId) || !sha(value.notFound.contentSha256)))
        return fail('SealCorrupt');
      const q = binding(value.binding);
      if (id !== q.stream + ':' + q.attemptId || value.generation !== q.generation || value.notFound &&
        (value.notFound.eventId !== (q.eventId ?? `expiry:${q.attemptId}`) || value.notFound.contentSha256 !== q.contentSha256))
        return fail('SealCorrupt');
    }
  } catch { return fail('SealCorrupt'); }
}

/** The acknowledged representation keeps only the information needed to reproduce the
 * original proof and verify a lost-ack retry. Event/bundle/chain/binding fields live once,
 * in the immutable terminals; no access payload is copied into protected evidence. */
export function attestedProof(state: ExternalState, bundleId: string): SealedBundleProof | null {
  const a = state.bundles['bundle:' + bundleId];
  if (!a) return null;
  validateAttestation(a);
  const entries = a.refs.map((r, i) => {
    if (!keys(r, ['stream', 'attemptId', 'sealed']) || r.stream !== (i === 0 ? 'viewing' : 'history') ||
      typeof r.attemptId !== 'string' || !keys(r.sealed, ['sequence', 'hash']) ||
      !integer(r.sealed.sequence, 1) || !sha(r.sealed.hash)) return fail('SealCorrupt');
    const terminal = state.terminal[r.stream + ':' + r.attemptId], b: CommitBinding = terminal?.binding;
    const tail = state.tail?.streams[r.stream];
    if (!b || terminal.phase !== 'committed' || b.stream !== r.stream || b.attemptId !== r.attemptId ||
      b.bundleId !== bundleId || b.chainId !== state.lineage?.origin.chains[r.stream] ||
      !tail || b.chainId !== tail.chainId || !integer(b.sequence, 1) || !integer(b.generation, 1) ||
      b.generation > state.generation || terminal.generation !== b.generation ||
      r.sealed.sequence < b.sequence || r.sealed.sequence > tail.sequence ||
      r.sealed.sequence === b.sequence && r.sealed.hash !== b.hash ||
      r.sealed.sequence === tail.sequence && r.sealed.hash !== tail.hash) return fail('SealCorrupt');
    return { ...b, sealed: { chainId: b.chainId, ...r.sealed } };
  });
  const eventId = entries[0].eventId, requiredStreams = entries.map(e => e.stream);
  if (entries.some(e => e.eventId !== eventId) ||
    eventId === null && (entries.length !== 1 || entries[0].kind !== 'expiry')) return fail('SealCorrupt');
  const proof: SealedBundleProof = { v: 1, serviceEpoch: a.serviceEpoch, eventId, requiredStreams, entries };
  try { parseSealedBundleProof(proof); } catch { return fail('SealCorrupt'); }
  if (a.phase === 'published' ? a.eventId !== eventId || !sameLegacy(a.requiredStreams, requiredStreams) :
    !sha(a.proofSha256) || a.proofSha256 !== hash(proof)) return fail('SealCorrupt');
  return proof;
}
const sameStoredBinding = (a: CommitBinding | Omit<CommitBinding, 'proofDigest'>,
  b: CommitBinding | Omit<CommitBinding, 'proofDigest'>) => a && b &&
  ['stream', 'chainId', 'attemptId', 'bundleId', 'kind', 'eventId', 'sequence', 'previousHash', 'hash', 'contentSha256']
    .every(field => a[field] === b[field]);

/** Identity integrity must be checked before any repair, including journal repair. */
export function validateAttemptIdentities(state: ExternalState): Map<string, CommitBinding> {
    const pending = new Map<string, CommitBinding>();
    const seen = new Set<string>();
    const corrupt = (): never => { return fail('UnsealedEntryUnexplained'); };
    const validBinding = (id: string, q: CommitBinding): boolean => q && ['viewing', 'history'].includes(q.stream) &&
      id === q.stream + ':' + q.attemptId && q.chainId === state.tail?.streams[q.stream]?.chainId &&
      Number.isSafeInteger(q.generation) && q.generation > 0 && q.generation <= state.generation;
    for (const [position, q] of Object.entries(state.slots) as [string, CommitBinding][]) {
      const id = q.stream + ':' + q.attemptId, terminal = state.terminal[id], intent = state.intents[id];
      if (!validBinding(id, q) || position !== q.stream + ':' + q.sequence || seen.has(id)) corrupt();
      seen.add(id);
      if (terminal) {
        // A retained expiry checkpoint aliases its committed record. This is not
        // another live attempt and cannot authorize reserve after recovery.
        if (terminal.phase !== 'committed' || q.kind !== 'expiry' || intent ||
          !sameStoredBinding(q, terminal.binding) || q.generation !== terminal.binding.generation ||
          q.proofDigest !== terminal.binding.proofDigest || q.sequence > state.tail.streams[q.stream].sequence) corrupt();
      } else {
        if (!intent || intent.stream !== q.stream || intent.attemptId !== q.attemptId || intent.bundleId !== q.bundleId ||
          intent.eventId !== q.eventId || intent.contentSha256 !== q.contentSha256 || typeof intent.owner !== 'string' ||
          q.sequence <= state.tail.streams[q.stream].sequence) corrupt();
        pending.set(id, q);
      }
      const core: ExpiryCore | undefined = state.proofs[id];
      if (q.kind === 'expiry') {
        if (!core || core.format !== 1 || !sameStoredBinding(core.binding, q) || core.binding.generation !== q.generation ||
          q.proofDigest !== hash(core) || core.seal.chainId !== q.chainId || core.seal.sequence + 1 !== q.sequence ||
          core.seal.hash !== q.previousHash || core.anchor.sequence > core.seal.sequence ||
          !Number.isSafeInteger(core.count) || core.count < 1 || core.count > core.anchor.sequence) corrupt();
      } else if (core || q.proofDigest !== null) corrupt();
    }
    for (const [id, intent] of Object.entries(state.intents)) {
      if (id !== intent.stream + ':' + intent.attemptId || !pending.has(id) || state.terminal[id]) corrupt();
    }
    for (const id of Object.keys(state.proofs)) {
      if (!seen.has(id)) corrupt();
    }
    for (const [id, terminal] of Object.entries(state.terminal)) {
      const q: CommitBinding = terminal.binding;
      if (!validBinding(id, q) || terminal.generation !== q.generation ||
        !['committed', 'aborted', 'superseded'].includes(terminal.phase) ||
        terminal.phase === 'committed' && q.sequence > state.tail.streams[q.stream].sequence) corrupt();
    }
    return pending;
}
function validate(state: ExternalState): void {
  if (!keys(state, ['version', 'revision', 'generation', 'tail', 'lineage', ...maps]) || state.version !== 3 ||
    !integer(state.revision) || !integer(state.generation) || maps.some(name => !isRecord(state[name]))) return fail('SealCorrupt');
  if (!keys(state.retired, ['viewing', 'history'])) return fail('SealCorrupt');
  for (const name of maps) for (const [id, value] of Object.entries(state[name]))
    validateMapValue(name, id, value, state.generation, state.lineage?.origin);
  if (!state.lineage) {
    if (state.tail || state.revision || state.generation || maps.some(n => n !== 'retired' && Object.keys(state[n]).length))
      return fail('SealCorrupt');
    return;
  }
  if (!integer(state.revision, 1)) return fail('SealCorrupt');
  validateTail(state.tail, state.generation, state.lineage.origin);
  const l = state.lineage, p = l.origin;
  if (!keys(l, ['version', 'id', 'origin']) || l.version !== 1 || !uuid(l.id) ||
    !keys(p, ['instanceId', 'chains', 'database']) || typeof p.instanceId !== 'string' || !p.instanceId ||
    !keys(p.chains, ['viewing', 'history']) || !uuid(p.chains.viewing) || !uuid(p.chains.history) ||
    !keys(p.database, ['database', 'oid', 'address', 'port']) || typeof p.database.database !== 'string' ||
    !integer(p.database.oid, 1) || !(p.database.address === null || typeof p.database.address === 'string') ||
    !(p.database.port === null || integer(p.database.port, 1)) ||
    ['viewing', 'history'].some(s => state.tail?.streams[s]?.chainId !== p.chains[s])) return fail('SealCorrupt');
  validateAttemptIdentities(state);
  for (const id of Object.keys(state.bundles)) {
    if (!id.startsWith('bundle:') || !id.slice(7)) return fail('SealCorrupt');
    attestedProof(state, id.slice(7));
  }
}
interface Envelope { state: ExternalState; publishing: boolean; digest: string }
/** `format` is the explicit entry mode of the owner (state-serve-v3 = 3, state-serve-v4 = 4; default 3): a stored
 * state of the other major format is refused as SealUnsupportedFormat before any journal or lock is created. */
export interface WriterContext { pair?: PairIdentity; copy?: CopyMapping | null; journal?: JournalFile; engine?: Engine; log?: { file: string; ino: number; fd: number }; format?: 3 | 4 }
function readTailFile(file: string): any {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info) return null;
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(info.size);
    let read = 0;
    while (read < bytes.length) {
      const count = fs.readSync(fd, bytes, read, bytes.length - read, read);
      if (!count) return fail('SealCorrupt');
      read += count;
    }
    try { return JSON.parse(bytes.toString('utf8')); } catch { return fail('SealCorrupt'); }
  } finally { fs.closeSync(fd); }
}
function append(file: string, body: any, context: WriterContext): number {
  const line = JSON.stringify({ ...body, digest: hash(body) }) + '\n';
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!context.log || context.log.file !== file || context.log.ino !== info?.ino) {
    if (context.log) fs.closeSync(context.log.fd);
    const fd = fs.openSync(file, 'a', 0o600);
    context.log = { file, fd, ino: fs.lstatSync(file).ino };
  }
  fs.writeFileSync(context.log.fd, line); fs.fdatasyncSync(context.log.fd);
  if (!info) syncDirectory(path.dirname(file));
  return Buffer.byteLength(line);
}
/** The complete WAL records after `offset` (each digest/syntax checked once) and the torn suffix, if any. */
function readWal(file: string, offset: number): { records: any[]; good: number; raw: Buffer } {
  const size = fs.lstatSync(file, { throwIfNoEntry: false })?.size ?? 0;
  if (size < offset) return fail('SealCorrupt');
  if (size === offset) return { records: [], good: 0, raw: Buffer.alloc(0) };
  const raw = Buffer.alloc(size - offset), fd = fs.openSync(file, 'r');
  try {
    let read = 0;
    while (read < raw.length) {
      const n = fs.readSync(fd, raw, read, raw.length - read, offset + read);
      if (!n) return fail('SealCorrupt');
      read += n;
    }
  } finally { fs.closeSync(fd); }
  const good = raw.lastIndexOf(10) + 1, records: any[] = [];
  for (const line of raw.subarray(0, good).toString('utf8').split('\n').slice(0, -1)) {
    let record: any;
    try { record = JSON.parse(line); } catch { return fail('SealCorrupt'); }
    if (!isRecord(record)) return fail('SealCorrupt');
    const { digest, ...body } = record;
    if (hash(body) !== digest) return fail('SealCorrupt');
    if (body.version !== 3) return fail('SealUnsupportedFormat');
    records.push(body);
  }
  return { records, good, raw };
}
/** Preserve a torn WAL suffix durably before shortening the log to its complete records (writer only). */
function quarantineTorn(file: string, raw: Buffer, good: number, offset: number): void {
  const evidence = path.join(path.dirname(file), 'torn-settlement-' + hash(raw.toString('hex')) + '.json');
  if (!fs.existsSync(evidence)) atomic(evidence, { bytes: raw.subarray(good).toString('hex') });
  const fd = fs.openSync(file, 'r+');
  try { fs.ftruncateSync(fd, offset + good); fs.fdatasyncSync(fd); } finally { fs.closeSync(fd); }
}
/** One WAL patch record's structure and the independent validity of every member it carries (no state applied). */
function validateRecordShape(body: any, origin: PairIdentity | undefined): void {
  if (body && isRecord(body.patch) && ('dbBindings' in body.patch || 'dbWitness' in body.patch)) {
    // v4-only facts travel with the record; their own shapes are checked by the v4 commit, the v3 part here.
    const { dbBindings: _b, dbWitness: _w, ...rest } = body.patch;
    return validateRecordShape({ ...body, patch: rest }, origin);
  }
  if (body.published) {
    if (!keys(body, ['version', 'revision', 'published']) || body.published !== true || !integer(body.revision, 1)) fail('SealCorrupt');
    return;
  }
  if (!keys(body, body.publishing ? ['version', 'revision', 'generation', 'patch', 'publishing', 'tail'] :
    ['version', 'revision', 'generation', 'patch', 'publishing']) ||
    typeof body.publishing !== 'boolean' || !isRecord(body.patch) ||
    Object.keys(body.patch).some(n => !maps.includes(n as any) || !isRecord(body.patch[n])) ||
    !integer(body.revision, 1) || !integer(body.generation, 1)) fail('SealCorrupt');
  for (const name of maps) for (const [id, value] of Object.entries(body.patch[name] ?? {})) {
    if (['__proto__', 'constructor', 'prototype'].includes(id)) fail('SealCorrupt');
    validateMapKey(name, id);
    if (value !== null) validateMapValue(name, id, value, body.generation, origin);
  }
  if (body.publishing) validateTail(body.tail, body.generation, origin);
}

// ───────────────────────── the owner's verified view (D1682 items 1, 2, 3, 4, 5) ─────────────────────────
/** A large map as the bounded view of the checkpoint region plus the changes since: lookups by key go to the
 * in-memory change set first, then a small cache, then the navigable file region; whole-map iteration merges both
 * in key order. Values that leave the cache are still on disk or in the change set: nothing is dropped. */
class HistoryMap {
  readonly delta = new Map<string, any>();
  private readonly cache = new Map<string, any>();
  added = 0; removed = 0;
  /** The checkpoint file is opened per access and closed again: no handle outlives an operation, so the file can be
   * replaced by a compaction (or inspected elsewhere) without a lingering descriptor. */
  constructor(readonly name: 'terminal' | 'bundles', readonly file: string, readonly region: MapRegion | null, readonly baseCount: number,
    private readonly cacheLimit = 4096) {}
  private get navigable(): boolean { return !!(this.region && this.region.navigable && this.region.count); }
  get(key: string): any {
    if (this.delta.has(key)) { const v = this.delta.get(key); return v === null ? undefined : v; }
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    if (!this.navigable) return undefined;
    const fd = fs.openSync(this.file, 'r');
    let raw: Buffer | null;
    try { raw = new RegionIndex(fd, this.region!).find(key); } finally { fs.closeSync(fd); }
    if (!raw) return undefined;
    const value = parseRaw(raw);
    if (this.cache.size >= this.cacheLimit) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, value);
    return value;
  }
  set(key: string, value: any): void {
    const before = this.get(key);
    if (value === null) { if (before !== undefined) this.removed++; }
    else if (before === undefined) this.added++;
    this.delta.set(key, value); this.cache.delete(key);
  }
  get count(): number { return this.baseCount + this.added - this.removed; }
  /** Every live member in byte-sorted key order (region ∪ change set, change set wins). */
  *entries(): Generator<[string, any]> {
    for (const [key, value] of this.rawEntries()) yield [key, typeof value === 'string' ? JSON.parse(value) : parseRaw(value)];
  }
  /** The same merge with each member's compact JSON bytes: checkpoint members are copied verbatim (no parse, no
   * re-serialization), change-set members serialized once. What a compaction streams into the next checkpoint. */
  *rawEntries(): Generator<[string, string | Buffer]> {
    const changed = [...this.delta.keys()].sort();
    let c = 0;
    const emitChanged = (through?: string) => { const out: [string, string][] = []; while (c < changed.length && (through === undefined || changed[c] < through)) { const v = this.delta.get(changed[c]); if (v !== null) out.push([changed[c], JSON.stringify(v)]); c++; } return out; };
    if (this.navigable) {
      const fd = fs.openSync(this.file, 'r');
      try {
        for (const [key, raw] of iterateRegionRaw(fd, this.region!)) {
          for (const item of emitChanged(key)) yield item;
          if (c < changed.length && changed[c] === key) { const v = this.delta.get(key); c++; if (v !== null) yield [key, JSON.stringify(v)]; }
          else yield [key, raw];
        }
      } finally { fs.closeSync(fd); }
    }
    for (const item of emitChanged()) yield item;
  }
}
function* iterateRegionRaw(fd: number, region: MapRegion): Generator<[string, Buffer]> {
  if (!region.count || fd < 0) return;
  const reader = new ByteScanner(fd, region.end, region.start);
  for (;;) {
    reader.skipWhitespace();
    if (reader.position >= region.end) return;
    const keyRaw = reader.readValue(64 * 1024);
    if (keyRaw[0] !== QUOTE) fail('SealCorrupt');
    const key = parseRaw(keyRaw);
    reader.skipWhitespace(); reader.expect(COLON); reader.skipWhitespace();
    yield [key, reader.readValue(16 * 1024 * 1024)];
    reader.skipWhitespace();
    if (reader.position >= region.end) return;
    if (reader.next() !== COMMA) fail('SealCorrupt');
  }
}
function* iterateRegion(fd: number, region: MapRegion): Generator<[string, any]> {
  for (const [key, raw] of iterateRegionRaw(fd, region)) yield [key, parseRaw(raw)];
}
interface Pins { checkpoint: { ino: number; size: number } | null; log: { ino: number; size: number } | null; tail: { ino: number; size: number; mtimeMs: number } | null }
/** The owner's verified view: admitted once per incarnation (full streaming validation), then advanced by validated
 * patches; pinned file identities detect any foreign change, which closes admission until a fresh full admission. */
/** The surface the engine needs of a large map: v3 HistoryMap (checkpoint region + change set) or the v4 tree map. */
export interface MemberMap {
  readonly name: 'terminal' | 'bundles'; readonly delta: Map<string, any>; added: number; removed: number;
  get(key: string): any; set(key: string, value: any): void; readonly count: number;
  entries(): Generator<[string, any]>; rawEntries(): Generator<[string, string | Buffer]>;
}
export class Engine {
  readonly file: string; log: string; readonly tailFile: string;
  /** The stored major format this view was admitted from (3: checkpoint + WAL; 4: validated paged root). */
  format: 3 | 4 = 3;
  v4: V4State | null = null;
  head!: { version: 3; revision: number; generation: number; tail: any; lineage: StateLineage | null; retired: Record<string, number> };
  intents: Record<string, any> = {}; slots: Record<string, any> = {}; proofs: Record<string, any> = {};
  terminal!: MemberMap; bundles!: MemberMap;
  readonly slotOf = new Map<string, string>();
  readonly notFound = new Set<string>();
  checkpoint: { digest: string; bytes: number; revision: number; publishing: boolean; navigable: boolean } | null = null;
  walOffset = 0; publishing = false; tainted = false;
  pins: Pins = { checkpoint: null, log: null, tail: null };
  constructor(readonly directory: string) {
    this.file = path.join(directory, 'seal', 'settlement.json');
    this.log = path.join(directory, 'seal', 'settlement.jsonl');
    this.tailFile = path.join(directory, 'seal', 'tail.json');
  }
  close(): void { this.v4?.store.close(); this.v4?.segment.close(); }
  get pristine(): boolean { return !this.head.lineage; }
  pin(): void {
    const stat = (file: string) => fs.lstatSync(file, { throwIfNoEntry: false });
    const c = stat(this.file), l = stat(this.log), t = stat(this.tailFile);
    this.pins = { checkpoint: c ? { ino: c.ino, size: c.size } : null, log: l ? { ino: l.ino, size: l.size } : null,
      tail: t ? { ino: t.ino, size: t.size, mtimeMs: t.mtimeMs } : null };
  }
  /** Whether the pinned identities and sizes are exactly what this owner last observed or wrote. Anything else
   * (replacement, shrink, growth, an uncertain write of our own) retires this view: the files are admitted afresh. */
  unchanged(): boolean {
    if (this.tainted) return false;
    const stat = (file: string) => fs.lstatSync(file, { throwIfNoEntry: false });
    const same = (a: any, b: any) => (!a && !b) || (a && b && a.ino === b.ino && a.size === b.size && (a.mtimeMs === undefined || a.mtimeMs === b.mtimeMs));
    const c = stat(this.file), l = stat(this.log), t = stat(this.tailFile);
    return same(this.pins.checkpoint, c && { ino: c.ino, size: c.size }) && same(this.pins.log, l && { ino: l.ino, size: l.size }) &&
      same(this.pins.tail, t && { ino: t.ino, size: t.size, mtimeMs: t.mtimeMs });
  }
  view(): { revision: number; generation: number; tail: any; lineage: StateLineage | null; retired: Record<string, number>;
    intents: Record<string, any>; slots: Record<string, any>; proofs: Record<string, any>; format: 3 | 4; dbWitness: any } {
    return { revision: this.head.revision, generation: this.head.generation, tail: this.head.tail, lineage: this.head.lineage, retired: this.head.retired,
      intents: this.intents, slots: this.slots, proofs: this.proofs, format: this.format, dbWitness: this.v4 ? clone(this.v4.meta.dbWitness) : null };
  }
  /** The whole logical state as one object: reads of the full history, for inspectors and tests (O(history)). */
  materialize(): ExternalState {
    const state: ExternalState = { version: 3, revision: this.head.revision, generation: this.head.generation, tail: clone(this.head.tail), lineage: clone(this.head.lineage),
      bundles: {}, intents: clone(this.intents), slots: clone(this.slots), proofs: clone(this.proofs), terminal: {}, retired: clone(this.head.retired) };
    // The whole-state object keeps v3's byte-sorted member order whatever the physical order of the map.
    const sorted = (map: MemberMap) => { const items = [...map.entries()]; if (this.format === 4) items.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); return items; };
    for (const [key, value] of sorted(this.terminal)) state.terminal[key] = clone(value);
    for (const [key, value] of sorted(this.bundles)) state.bundles[key] = clone(value);
    return state;
  }
  lookup(map: string, id: string): any {
    if (map === 'terminal') return this.terminal.get(id);
    if (map === 'bundles') return this.bundles.get(id);
    if (map === 'intents' || map === 'slots' || map === 'proofs') return (this as any)[map][id];
    if (map === 'retired') return this.head.retired[id];
    return fail('SealCorrupt');
  }
  /** Apply one validated record to the view, keeping an undo list so a refused closure leaves the view unchanged. */
  apply(body: any, touched: Map<string, Set<string>>, undo: (() => void)[]): void {
    const setMap = (name: string, id: string, value: any) => {
      if (name === 'terminal' || name === 'bundles') {
        const map = name === 'terminal' ? this.terminal : this.bundles;
        const snapshot = { had: map.delta.has(id), value: map.delta.get(id), added: map.added, removed: map.removed, notFound: this.notFound.has(id) };
        undo.push(() => {
          if (snapshot.had) map.delta.set(id, snapshot.value); else map.delta.delete(id);
          map.added = snapshot.added; map.removed = snapshot.removed;
          if (snapshot.notFound) this.notFound.add(id); else this.notFound.delete(id);
        });
        map.set(id, value);
        if (name === 'terminal') { if (value && value.notFound) this.notFound.add(id); else this.notFound.delete(id); }
      } else if (name === 'retired') {
        const before = this.head.retired[id]; undo.push(() => { this.head.retired[id] = before; });
        if (value === null) fail('SealCorrupt'); this.head.retired[id] = value;
      } else {
        const target = (this as any)[name] as Record<string, any>, before = target[id], had = has(target, id);
        undo.push(() => { if (had) target[id] = before; else delete target[id]; });
        if (value === null) delete target[id]; else target[id] = value;
        if (name === 'slots') {
          if (had) { const old = before; if (this.slotOf.get(old.stream + ':' + old.attemptId) === id) { this.slotOf.delete(old.stream + ':' + old.attemptId); undo.push(() => this.slotOf.set(old.stream + ':' + old.attemptId, id)); } }
          if (value !== null) { const k = value.stream + ':' + value.attemptId; undo.push(() => this.slotOf.delete(k)); this.slotOf.set(k, id); }
        }
      }
      let set = touched.get(name); if (!set) touched.set(name, set = new Set()); set.add(id);
    };
    const previous = { revision: this.head.revision, generation: this.head.generation, tail: this.head.tail };
    undo.push(() => { this.head.revision = previous.revision; this.head.generation = previous.generation; this.head.tail = previous.tail; });
    this.head.revision = body.revision; this.head.generation = body.generation;
    for (const name of maps) for (const [id, v] of Object.entries(body.patch[name] ?? {})) setMap(name, id, v);
    if (body.publishing) this.head.tail = body.tail;
  }
  /** The identity closure of the touched records (the per-record subset of validateAttemptIdentities/attestedProof). */
  validateTouched(touched: Map<string, Set<string>>, publishing: boolean): void {
    const corrupt = (): never => fail('UnsealedEntryUnexplained');
    const tailStreams = this.head.tail?.streams;
    if (!tailStreams) { if (touched.size) fail('SealCorrupt'); return; }
    const validBinding = (id: string, q: CommitBinding): boolean => q && ['viewing', 'history'].includes(q.stream) &&
      id === q.stream + ':' + q.attemptId && q.chainId === tailStreams[q.stream]?.chainId &&
      Number.isSafeInteger(q.generation) && q.generation > 0 && q.generation <= this.head.generation;
    const ids = new Set<string>();
    for (const position of touched.get('slots') ?? []) { const q = this.slots[position]; if (q) ids.add(q.stream + ':' + q.attemptId); }
    for (const name of ['intents', 'proofs', 'terminal'] as const) for (const id of touched.get(name) ?? []) ids.add(id);
    // Deleted slots: their former attempt (if still pending) must now be explained by another record.
    for (const id of ids) {
      const position = this.slotOf.get(id), q: CommitBinding | undefined = position ? this.slots[position] : undefined;
      const intent = this.intents[id], terminal = this.terminal.get(id), core: ExpiryCore | undefined = this.proofs[id];
      if (q) {
        if (!validBinding(id, q) || position !== q.stream + ':' + q.sequence) corrupt();
        if (terminal) {
          if (terminal.phase !== 'committed' || q.kind !== 'expiry' || intent || !sameStoredBinding(q, terminal.binding) ||
            q.generation !== terminal.binding.generation || q.proofDigest !== terminal.binding.proofDigest || q.sequence > tailStreams[q.stream].sequence) corrupt();
        } else {
          if (!intent || intent.stream !== q.stream || intent.attemptId !== q.attemptId || intent.bundleId !== q.bundleId ||
            intent.eventId !== q.eventId || intent.contentSha256 !== q.contentSha256 || typeof intent.owner !== 'string' ||
            q.sequence <= tailStreams[q.stream].sequence) corrupt();
        }
        if (q.kind === 'expiry') {
          if (!core || core.format !== 1 || !sameStoredBinding(core.binding, q) || core.binding.generation !== q.generation ||
            q.proofDigest !== hash(core) || core.seal.chainId !== q.chainId || core.seal.sequence + 1 !== q.sequence ||
            core.seal.hash !== q.previousHash || core.anchor.sequence > core.seal.sequence ||
            !Number.isSafeInteger(core.count) || core.count < 1 || core.count > core.anchor.sequence) corrupt();
        } else if (core || q.proofDigest !== null) corrupt();
      } else {
        if (intent) corrupt();           // an intent without its reservation slot
        if (core) corrupt();             // a proof without its slot
      }
      if (terminal) {
        const b: CommitBinding = terminal.binding;
        if (!validBinding(id, b) || terminal.generation !== b.generation || !['committed', 'aborted', 'superseded'].includes(terminal.phase) ||
          terminal.phase === 'committed' && b.sequence > tailStreams[b.stream].sequence) corrupt();
      }
    }
    // A slot's attempt may not be reserved twice: the reverse index is one-to-one with the live slots.
    for (const position of touched.get('slots') ?? []) {
      const q = this.slots[position]; if (!q) continue;
      let count = 0; for (const [, binding] of Object.entries(this.slots)) if (binding.stream === q.stream && binding.attemptId === q.attemptId) count++;
      if (count !== 1) corrupt();
    }
    for (const key of touched.get('bundles') ?? []) {
      const a = this.bundles.get(key);
      if (a === undefined) fail('SealCorrupt');   // attestations are never removed
      attestedProofFrom(id => this.terminal.get(id), this.head, key.slice(7), a);
    }
    if (publishing) {
      // Every slot behind the new frontier must have been retired or retained as an expiry checkpoint.
      for (const [position, q] of Object.entries(this.slots) as [string, CommitBinding][])
        if (q.sequence <= tailStreams[q.stream].sequence && !this.terminal.get(q.stream + ':' + q.attemptId)) corrupt();
    }
  }
}
/** attestedProof over any terminal lookup (the view, a scan, or a materialized state). */
export function attestedProofFrom(terminalOf: (id: string) => any, head: { generation: number; tail: any; lineage: StateLineage | null }, bundleId: string, a: any): SealedBundleProof {
  validateAttestation(a);
  const entries = a.refs.map((r: any, i: number) => {
    if (!keys(r, ['stream', 'attemptId', 'sealed']) || r.stream !== (i === 0 ? 'viewing' : 'history') ||
      typeof r.attemptId !== 'string' || !keys(r.sealed, ['sequence', 'hash']) ||
      !integer(r.sealed.sequence, 1) || !sha(r.sealed.hash)) return fail('SealCorrupt');
    const terminal = terminalOf(r.stream + ':' + r.attemptId), b: CommitBinding = terminal?.binding;
    const tail = head.tail?.streams[r.stream];
    if (!b || terminal.phase !== 'committed' || b.stream !== r.stream || b.attemptId !== r.attemptId ||
      b.bundleId !== bundleId || b.chainId !== head.lineage?.origin.chains[r.stream] ||
      !tail || b.chainId !== tail.chainId || !integer(b.sequence, 1) || !integer(b.generation, 1) ||
      b.generation > head.generation || terminal.generation !== b.generation ||
      r.sealed.sequence < b.sequence || r.sealed.sequence > tail.sequence ||
      r.sealed.sequence === b.sequence && r.sealed.hash !== b.hash ||
      r.sealed.sequence === tail.sequence && r.sealed.hash !== tail.hash) return fail('SealCorrupt');
    return { ...b, sealed: { chainId: b.chainId, ...r.sealed } };
  });
  const eventId = entries[0].eventId, requiredStreams = entries.map((e: any) => e.stream);
  if (entries.some((e: any) => e.eventId !== eventId) ||
    eventId === null && (entries.length !== 1 || entries[0].kind !== 'expiry')) return fail('SealCorrupt');
  const proof: SealedBundleProof = { v: 1, serviceEpoch: a.serviceEpoch, eventId, requiredStreams, entries };
  try { parseSealedBundleProof(proof); } catch { return fail('SealCorrupt'); }
  if (a.phase === 'published' ? a.eventId !== eventId || !sameLegacy(a.requiredStreams, requiredStreams) :
    !sha(a.proofSha256) || a.proofSha256 !== hash(proof)) return fail('SealCorrupt');
  return proof;
}
function delta(before: ExternalState, state: ExternalState): any {
  const patch = {};
  for (const name of maps) {
    const changes = {};
    for (const id of new Set([...Object.keys(before[name]), ...Object.keys(state[name])]))
      if (JSON.stringify(before[name][id]) !== JSON.stringify(state[name][id])) changes[id] = state[name][id] ?? null;
    if (Object.keys(changes).length) patch[name] = changes;
  }
  const publishing = hash(before.tail) !== hash(state.tail);
  return { version: 3, revision: state.revision, generation: state.generation, patch, publishing, ...(publishing ? { tail: state.tail } : {}) };
}

// ───────────────────────────── streaming checkpoint admission (D1682 item 1/6) ─────────────────────────────
/**
 * The same v3 envelope `{"state":{...},"publishing":b,"digest":h}` read as a byte stream: every stored member is
 * validated exactly once with the same rules as `validate()`, the digest is recomputed over the compact serialization
 * (the file may carry line breaks between map members: JSON whitespace, which an unmodified reader ignores and the
 * digest, being over `JSON.stringify(state)`, never contains), and a disposable sparse directory of the large maps is
 * built for bounded navigation. Nothing here is a new authority: the checkpoint bytes and their digest are.
 *
 * Layout written by this module (`navigable`): the large maps (`terminal`, `bundles`) hold one member per line in
 * byte-sorted key order. Old compact layouts (one line, insertion order) are accepted and reported as not navigable.
 */
export interface MemberDirectoryEntry { key: string; offset: number }
export interface MapRegion {
  /** File offset of the first member's opening quote and the offset just past the last member (the closing `}`). */
  start: number; end: number; count: number; bytes: number; sorted: boolean; navigable: boolean;
  directory: MemberDirectoryEntry[];
}
export interface ScanResult {
  file: string; bytes: number; digest: string; publishing: boolean;
  version: 3; revision: number; generation: number; tail: any; lineage: StateLineage | null; retired: Record<string, number>;
  intents: Record<string, any>; slots: Record<string, any>; proofs: Record<string, any>;
  regions: { terminal: MapRegion; bundles: MapRegion };
  pending: Map<string, CommitBinding>;
  counts: { terminal: number; bundles: number; committed: number; aborted: number; superseded: number; acknowledged: number };
  timing: { scanMs: number; joinMs: number; hashMs: number };
  joined: number;
}
export interface ScanOptions {
  pair?: PairIdentity;
  /** Members between two directory entries of a large map (bounded navigation reads at most this many lines). */
  directoryEvery?: number;
  /** How bundle attestations are checked against their terminals: indexed lookups into the terminal region
   * (`lookup`), a disposable external sort/merge join (`merge`), buffered in memory (`memory`, small states only),
   * or not at all (`none`: a measurement of the member pass alone, never an admission). */
  join?: 'lookup' | 'merge' | 'memory' | 'none';
  /** Service-private disposable work directory for the merge join (outside the protected directory). */
  workDirectory?: string;
  /** Called for each large-map member (key, value, file offset) after it validated; used by index builders. */
  onMember?: (map: 'terminal' | 'bundles', key: string, value: any, offset: number) => void;
}
const LF = 10, QUOTE = 34, BACKSLASH = 92, COMMA = 44, COLON = 58, LBRACE = 123, RBRACE = 125, LBRACKET = 91, RBRACKET = 93;
const SCAN_CHUNK = 4 * 1024 * 1024, SMALL_VALUE_LIMIT = 256 * 1024 * 1024;
class ByteScanner {
  private chunk = Buffer.alloc(0); private chunkStart: number; private index = 0;
  private hash: ReturnType<typeof createHash> | null = null; private hashFrom = -1;
  constructor(private readonly fd: number, readonly size: number, start = 0) { this.chunkStart = start; }
  get position(): number { return this.chunkStart + this.index; }
  /** Start digesting the compact bytes (LF stripped) from the current position. */
  beginHash(): void { this.hash = createHash('sha256'); this.hashFrom = this.position; }
  endHash(): string {
    this.flushHash(this.position);
    const digest = this.hash!.digest('hex'); this.hash = null; return digest;
  }
  private flushHash(through: number): void {
    if (!this.hash || through <= this.hashFrom) return;
    const from = this.hashFrom - this.chunkStart, to = through - this.chunkStart;
    const slice = this.chunk.subarray(Math.max(0, from), to);
    // Line breaks between members are the only raw LF bytes (JSON strings escape them): hash the runs between them.
    let at = 0;
    for (;;) {
      const lf = slice.indexOf(LF, at);
      if (lf < 0) { if (at < slice.length) this.hash.update(slice.subarray(at)); break; }
      if (lf > at) this.hash.update(slice.subarray(at, lf));
      at = lf + 1;
    }
    this.hashFrom = through;
  }
  private fill(): boolean {
    if (this.index < this.chunk.length) return true;
    this.flushHash(this.chunkStart + this.chunk.length);
    const next = this.chunkStart + this.chunk.length;
    if (next >= this.size) return false;
    const length = Math.min(SCAN_CHUNK, this.size - next), buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) { const n = fs.readSync(this.fd, buffer, read, length - read, next + read); if (!n) return fail('SealCorrupt'); read += n; }
    this.chunk = buffer; this.chunkStart = next; this.index = 0;
    return true;
  }
  peek(): number { if (!this.fill()) return -1; return this.chunk[this.index]; }
  next(): number { if (!this.fill()) return fail('SealCorrupt'); return this.chunk[this.index++]; }
  skipWhitespace(): void { for (;;) { const b = this.peek(); if (b === 32 || b === LF || b === 9 || b === 13) this.index++; else return; } }
  expect(byte: number): void { if (this.next() !== byte) fail('SealCorrupt'); }
  /** One JSON value's exact bytes (bounded); strings are copied verbatim (escapes untouched). A scalar ends at its
   * terminator (not consumed); a string, object or array ends at its closing delimiter (consumed). */
  readValue(limit = SMALL_VALUE_LIMIT): Buffer {
    const parts: Buffer[] = []; let total = 0;
    let depth = 0, inString = false, escape = false, started = false, done = false;
    for (;;) {
      if (!this.fill()) { if (started && depth === 0 && !inString) break; fail('SealCorrupt'); }
      const chunk = this.chunk; let i = this.index;
      const from = i;
      for (; i < chunk.length; i++) {
        const b = chunk[i];
        if (inString) {
          if (escape) escape = false; else if (b === BACKSLASH) escape = true;
          else if (b === QUOTE) { inString = false; if (depth === 0) { i++; done = true; break; } }
          continue;
        }
        if (b === QUOTE) { inString = true; started = true; continue; }
        if (b === LBRACE || b === LBRACKET) { depth++; started = true; continue; }
        if (b === RBRACE || b === RBRACKET) {
          if (depth === 0) { if (!started) fail('SealCorrupt'); done = true; break; }
          depth--; if (depth === 0) { i++; done = true; break; } continue;
        }
        if (depth === 0) {
          if (b === COMMA || b === COLON || b === 32 || b === LF || b === 13 || b === 9) { if (!started) fail('SealCorrupt'); done = true; break; }
          started = true;
        }
      }
      parts.push(Buffer.from(chunk.subarray(from, i))); total += i - from;
      if (total > limit) fail('SealUnavailable');
      this.index = i;
      if (done) break;
    }
    const raw = Buffer.concat(parts, total);
    if (!raw.length) fail('SealCorrupt');
    return raw;
  }
  /** The remaining bytes (bounded), for the small envelope tail after the state object. */
  readRemainder(limit: number): string {
    const parts: Buffer[] = []; let total = 0;
    while (this.fill()) {
      const piece = this.chunk.subarray(this.index); parts.push(Buffer.from(piece)); total += piece.length; this.index = this.chunk.length;
      if (total > limit) fail('SealCorrupt');
    }
    return Buffer.concat(parts, total).toString('utf8');
  }
}
const parseRaw = (raw: Buffer): any => { try { return JSON.parse(raw.toString('utf8')); } catch { return fail('SealCorrupt'); } };
/** Members of the object whose `{` was just consumed; `big(key)` names the maps streamed member by member. */
function readMembers(scanner: ByteScanner, big: (key: string) => boolean,
  small: (key: string, value: any) => void, member: (map: string, key: string, value: any, offset: number, navigable: boolean) => void,
  region?: (map: string, start: number, end: number) => void): void {
  scanner.skipWhitespace();
  if (scanner.peek() === RBRACE) { scanner.next(); return; }
  for (;;) {
    scanner.skipWhitespace();
    const keyRaw = scanner.readValue(64 * 1024);
    if (keyRaw[0] !== QUOTE) fail('SealCorrupt');
    const key = parseRaw(keyRaw);
    if (typeof key !== 'string') fail('SealCorrupt');
    scanner.skipWhitespace(); scanner.expect(COLON); scanner.skipWhitespace();
    if (big(key)) {
      scanner.expect(LBRACE);
      let previousLf = scanner.peek() === LF;
      scanner.skipWhitespace();
      const start = scanner.position;
      if (scanner.peek() === RBRACE) { scanner.next(); region?.(key, start, start); }
      else for (;;) {
        const offset = scanner.position, navigable = previousLf;
        const memberKeyRaw = scanner.readValue(64 * 1024);
        if (memberKeyRaw[0] !== QUOTE) fail('SealCorrupt');
        const memberKey = parseRaw(memberKeyRaw);
        if (typeof memberKey !== 'string') fail('SealCorrupt');
        scanner.skipWhitespace(); scanner.expect(COLON); scanner.skipWhitespace();
        const valueRaw = scanner.readValue(16 * 1024 * 1024);
        member(key, memberKey, parseRaw(valueRaw), offset, navigable);
        scanner.skipWhitespace();
        const b = scanner.next();
        if (b === RBRACE) { region?.(key, start, scanner.position - 1); break; }
        if (b !== COMMA) fail('SealCorrupt');
        previousLf = scanner.peek() === LF;
        scanner.skipWhitespace();
      }
    } else small(key, parseRaw(scanner.readValue()));
    scanner.skipWhitespace();
    const b = scanner.next();
    if (b === RBRACE) return;
    if (b !== COMMA) fail('SealCorrupt');
  }
}
/** Bounded navigation of a navigable sorted map region: binary search by file offset, reading whole lines. */
export class RegionIndex {
  private readonly probe = Buffer.allocUnsafe(64 * 1024);
  constructor(private readonly fd: number, readonly region: MapRegion) {}
  private lineAt(at: number): { key: string; value: Buffer; start: number; next: number } | null {
    // The line that starts at `at` or the next line boundary after it (lines end with LF; the last ends at region.end).
    const region = this.region;
    let start = at;
    if (at !== region.start) {
      const n = fs.readSync(this.fd, this.probe, 0, Math.min(this.probe.length, region.end - at), at);
      const lf = this.probe.subarray(0, n).indexOf(LF);
      if (lf < 0) return null;
      start = at + lf + 1;
      if (start >= region.end) return null;
    }
    const parts: Buffer[] = []; let position = start, end = -1;
    while (end < 0) {
      const n = fs.readSync(this.fd, this.probe, 0, Math.min(this.probe.length, region.end - position), position);
      if (!n) break;
      const piece = Buffer.from(this.probe.subarray(0, n)), lf = piece.indexOf(LF);
      if (lf >= 0) { parts.push(piece.subarray(0, lf)); end = position + lf + 1; } else { parts.push(piece); position += n; }
      if (position >= region.end && end < 0) end = region.end;
    }
    const line = Buffer.concat(parts);
    const colon = memberKeyEnd(line);
    const key = parseRaw(line.subarray(0, colon));
    let value = line.subarray(colon + 1);
    if (value[value.length - 1] === COMMA) value = value.subarray(0, value.length - 1);
    return { key, value, start, next: end };
  }
  /** The member's raw value or null; O(log window) line reads within the directory bracket. */
  find(key: string): Buffer | null {
    const { directory, start, end, navigable } = this.region;
    if (!navigable || !directory.length || key < directory[0].key) return null;
    let lo = 0, hi = directory.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (directory[mid].key <= key) lo = mid; else hi = mid - 1; }
    let low = directory[lo].offset, high = lo + 1 < directory.length ? directory[lo + 1].offset : end;
    void start;
    for (let guard = 0; guard < 80 && low < high; guard++) {
      const mid = low + ((high - low) >> 1);
      // `low` is always a line start; `mid` may fall inside a line, in which case the next line is probed and, when
      // that lies beyond the bracket, the line starting at `low` itself (reached through the LF before it).
      let row = this.lineAt(mid);
      if (!row || row.start >= high) row = this.lineAt(low === this.region.start ? low : low - 1);
      if (!row || row.start >= high) return null;
      if (row.key === key) return row.value;
      if (row.key < key) low = row.next; else high = row.start;
    }
    return null;
  }
}
function memberKeyEnd(line: Buffer): number {
  // The key is a JSON string at the line start; its closing quote precedes the colon.
  let i = 1, escape = false;
  for (; i < line.length; i++) { const b = line[i]; if (escape) escape = false; else if (b === BACKSLASH) escape = true; else if (b === QUOTE) break; }
  if (line[i + 1] !== COLON) fail('SealCorrupt');
  return i + 1;
}
const bindingOf = (value: any): CommitBinding => parseCommitBinding(value);
/** One streaming pass: envelope, every member, digest, identities and bundle attestations. */
export function scanCheckpoint(file: string, options: ScanOptions = {}): ScanResult {
  const started = performance.now();
  const directoryEvery = options.directoryEvery ?? 4096;
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile()) fail('SealMissing');
  const fd = fs.openSync(file, 'r');
  try {
    const scanner = new ByteScanner(fd, info.size);
    scanner.skipWhitespace(); scanner.expect(LBRACE); scanner.skipWhitespace();
    const first = parseRaw(scanner.readValue(64)); if (first !== 'state') fail('SealCorrupt');
    scanner.skipWhitespace(); scanner.expect(COLON); scanner.skipWhitespace();
    if (scanner.peek() !== LBRACE) fail('SealCorrupt');
    scanner.beginHash(); scanner.next();
    const top: Record<string, any> = {}; const seen = new Set<string>();
    const regions: Record<string, MapRegion> = {};
    const counts = { terminal: 0, bundles: 0, committed: 0, aborted: 0, superseded: 0, acknowledged: 0 };
    let generation = -1, origin: PairIdentity | undefined, tailStreams: any;
    const bufferedBundles: { key: string; value: any; offset: number }[] = [];
    const join = options.join ?? 'lookup';
    let spill: SpillSorter | null = null;
    const small = (key: string, value: any) => {
      if (seen.has(key)) fail('SealCorrupt'); seen.add(key); top[key] = value;
      // Version admission precedes every other check: an unsupported generation is never "corrupt".
      if (key === 'version') { if (value !== 3) fail('SealUnsupportedFormat'); }
      else if (!seen.has('version')) fail(typeof value === 'number' || key === 'tail' ? 'SealUnsupportedFormat' : 'SealCorrupt');
      if (key === 'generation') { if (!integer(value)) fail('SealCorrupt'); generation = value; }
      if (key === 'lineage') { if (value !== null && !(isRecord(value) && validPair(value.origin))) fail('SealCorrupt'); origin = value?.origin; }
      if (key === 'tail' && value !== null) tailStreams = value.streams;
      if (['intents', 'slots', 'proofs', 'retired'].includes(key)) {
        if (!isRecord(value)) fail('SealCorrupt');
        if (generation < 0) fail('SealCorrupt');
        for (const [id, v] of Object.entries(value)) validateMapValue(key as any, id, v, generation, origin);
        if (key === 'retired' && !keys(value, ['viewing', 'history'])) fail('SealCorrupt');
      }
    };
    let last: Record<string, string | null> = { terminal: null, bundles: null };
    const sorted: Record<string, boolean> = { terminal: true, bundles: true }, navigables: Record<string, boolean> = { terminal: true, bundles: true };
    const directories: Record<string, MemberDirectoryEntry[]> = { terminal: [], bundles: [] };
    const member = (map: string, key: string, value: any, offset: number, navigable: boolean) => {
      if (map !== 'terminal' && map !== 'bundles') fail('SealCorrupt');
      if (generation < 0) fail('SealCorrupt');
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('SealCorrupt');
      if (last[map] !== null && !(key > last[map]!)) sorted[map] = false;
      if (last[map] === key) fail('SealCorrupt');
      last[map] = key;
      if (!navigable) navigables[map] = false;
      if (counts[map] % directoryEvery === 0) directories[map].push({ key, offset });
      validateMapValue(map as any, key, value, generation, origin);
      if (map === 'terminal') {
        const q: CommitBinding = value.binding;
        if (!tailStreams || q.chainId !== tailStreams[q.stream]?.chainId || value.phase === 'committed' && q.sequence > tailStreams[q.stream].sequence) fail('UnsealedEntryUnexplained');
        counts.terminal++; counts[value.phase as 'committed' | 'aborted' | 'superseded']++;
        if (join === 'merge' && value.phase === 'committed') spill!.add(q.bundleId + '\u0000' + key, JSON.stringify({ k: key, g: value.generation, b: q }));
      } else {
        counts.bundles++; if (value.phase === 'acknowledged') counts.acknowledged++;
        if (join === 'memory') bufferedBundles.push({ key, value, offset });
      }
      options.onMember?.(map as any, key, value, offset);
    };
    let bundlesPending: { start: number; end: number } | null = null;
    if (join === 'merge') spill = new SpillSorter(options.workDirectory ?? path.join(path.dirname(file), '..', '..'), 'scan-join');
    readMembers(scanner, key => key === 'terminal' || key === 'bundles', small, member, (map, start, end) => {
      regions[map] = { start, end, count: counts[map as 'terminal' | 'bundles'], bytes: end - start, sorted: sorted[map], navigable: navigables[map] && sorted[map], directory: directories[map] };
      if (map === 'bundles') bundlesPending = { start, end };
    });
    const digest = scanner.endHash();
    scanner.skipWhitespace(); scanner.expect(COMMA);
    const envelope = parseRaw(Buffer.from('{' + scanner.readRemainder(4096).trim()));
    if (!keys(envelope, ['publishing', 'digest']) || typeof envelope.publishing !== 'boolean' || envelope.digest !== digest) fail('SealCorrupt');
    const required = ['version', 'revision', 'generation', 'tail', 'lineage', 'bundles', 'intents', 'slots', 'proofs', 'terminal', 'retired'];
    if (!required.every(k => seen.has(k) || regions[k]) || seen.size + Object.keys(regions).length !== required.length) fail('SealCorrupt');
    if (top.version !== 3 || !integer(top.revision) || !integer(top.generation)) fail('SealCorrupt');
    const scanMs = performance.now() - started;
    const state = { version: 3 as const, revision: top.revision, generation: top.generation, tail: top.tail, lineage: top.lineage, retired: top.retired,
      intents: top.intents, slots: top.slots, proofs: top.proofs };
    // The identity closure of the small maps against the (large) terminal map: the same rules as validateAttemptIdentities.
    // A navigable region is searched in place; a compact or unsorted region (a whole-state JSON.stringify, as the
    // initialization and older writers produce - sized to the memory that wrote it) is read once into memory.
    const terminalIndex = new RegionIndex(fd, regions.terminal);
    const terminalMemory = regions.terminal.navigable || !regions.terminal.count ? null : new Map<string, any>();
    if (terminalMemory) forEachMember(fd, regions.terminal, (key, value) => { terminalMemory.set(key, value); });
    const lookup = (id: string): any => {
      if (terminalMemory) return terminalMemory.get(id);
      const raw = terminalIndex.find(id); return raw ? parseRaw(raw) : undefined;
    };
    if (!state.lineage) {
      if (state.tail || state.revision || state.generation || counts.terminal || counts.bundles ||
        Object.keys(state.intents).length || Object.keys(state.slots).length || Object.keys(state.proofs).length) fail('SealCorrupt');
    } else {
      if (!integer(state.revision, 1)) fail('SealCorrupt');
      validateTail(state.tail, state.generation, state.lineage.origin);
      if (options.pair && !samePair(state.lineage.origin, options.pair)) fail('SealChainMismatch');
    }
    const pending = new Map<string, CommitBinding>();
    if (state.lineage) {
      const seenSlots = new Set<string>();
      const corrupt = (): never => fail('UnsealedEntryUnexplained');
      const validBinding = (id: string, q: CommitBinding): boolean => q && ['viewing', 'history'].includes(q.stream) &&
        id === q.stream + ':' + q.attemptId && q.chainId === state.tail.streams[q.stream]?.chainId &&
        Number.isSafeInteger(q.generation) && q.generation > 0 && q.generation <= state.generation;
      for (const [position, q] of Object.entries(state.slots) as [string, CommitBinding][]) {
        const id = q.stream + ':' + q.attemptId, intent = state.intents[id];
        if (!validBinding(id, q) || position !== q.stream + ':' + q.sequence || seenSlots.has(id)) corrupt();
        seenSlots.add(id);
        const terminal = lookup(id);
        if (terminal) {
          if (terminal.phase !== 'committed' || q.kind !== 'expiry' || intent || !sameStoredBinding(q, terminal.binding) ||
            q.generation !== terminal.binding.generation || q.proofDigest !== terminal.binding.proofDigest || q.sequence > state.tail.streams[q.stream].sequence) corrupt();
        } else {
          if (!intent || intent.stream !== q.stream || intent.attemptId !== q.attemptId || intent.bundleId !== q.bundleId ||
            intent.eventId !== q.eventId || intent.contentSha256 !== q.contentSha256 || typeof intent.owner !== 'string' ||
            q.sequence <= state.tail.streams[q.stream].sequence) corrupt();
          pending.set(id, q);
        }
        const core: ExpiryCore | undefined = state.proofs[id];
        if (q.kind === 'expiry') {
          if (!core || core.format !== 1 || !sameStoredBinding(core.binding, q) || core.binding.generation !== q.generation ||
            q.proofDigest !== hash(core) || core.seal.chainId !== q.chainId || core.seal.sequence + 1 !== q.sequence ||
            core.seal.hash !== q.previousHash || core.anchor.sequence > core.seal.sequence ||
            !Number.isSafeInteger(core.count) || core.count < 1 || core.count > core.anchor.sequence) corrupt();
        } else if (core || q.proofDigest !== null) corrupt();
      }
      for (const [id, intent] of Object.entries(state.intents) as [string, any][]) {
        if (id !== intent.stream + ':' + intent.attemptId || !pending.has(id) || lookup(id)) corrupt();
      }
      for (const id of Object.keys(state.proofs)) if (!seenSlots.has(id)) corrupt();
    }
    // Bundle attestations against their terminals: the same checks as attestedProof, by indexed lookup or merge join.
    const joinStarted = performance.now();
    let joined = 0;
    const checkBundle = (key: string, a: any, terminals: (id: string) => any) => {
      const bundleId = key.slice(7);
      const entries = a.refs.map((r: any, i: number) => {
        const terminal = terminals(r.stream + ':' + r.attemptId), b: CommitBinding = terminal?.binding, tail = state.tail?.streams[r.stream];
        if (!b || terminal.phase !== 'committed' || b.stream !== r.stream || b.attemptId !== r.attemptId || b.bundleId !== bundleId ||
          b.chainId !== state.lineage?.origin.chains[r.stream] || !tail || b.chainId !== tail.chainId || !integer(b.sequence, 1) ||
          !integer(b.generation, 1) || b.generation > state.generation || terminal.generation !== b.generation ||
          r.sealed.sequence < b.sequence || r.sealed.sequence > tail.sequence || r.sealed.sequence === b.sequence && r.sealed.hash !== b.hash ||
          r.sealed.sequence === tail.sequence && r.sealed.hash !== tail.hash || i !== (r.stream === 'viewing' ? 0 : 1)) fail('SealCorrupt');
        return { ...b, sealed: { chainId: b.chainId, ...r.sealed } };
      });
      const eventId = entries[0].eventId, requiredStreams = entries.map((e: any) => e.stream);
      if (entries.some((e: any) => e.eventId !== eventId) || eventId === null && (entries.length !== 1 || entries[0].kind !== 'expiry')) fail('SealCorrupt');
      const proof: SealedBundleProof = { v: 1, serviceEpoch: a.serviceEpoch, eventId, requiredStreams, entries };
      try { parseSealedBundleProof(proof); } catch { fail('SealCorrupt'); }
      if (a.phase === 'published' ? a.eventId !== eventId || !sameLegacy(a.requiredStreams, requiredStreams) : a.proofSha256 !== hash(proof)) fail('SealCorrupt');
      joined++;
    };
    if (counts.bundles && join !== 'none') {
      if (join === 'memory') for (const b of bufferedBundles) checkBundle(b.key, b.value, lookup);
      else if (join === 'lookup') {
        const bundleIndex = new RegionIndex(fd, regions.bundles);
        void bundleIndex;
        forEachMember(fd, regions.bundles, (key, value) => checkBundle(key, value, lookup));
      } else {
        // Sort the committed terminals by bundleId once (disposable runs), then walk bundles and terminals together.
        const iterator = spill!.iterate();
        let current = iterator.next();
        forEachMember(fd, regions.bundles, (key, value) => {
          const bundleId = key.slice(7), found = new Map<string, any>();
          while (!current.done && current.value.key.slice(0, current.value.key.indexOf('\u0000')) < bundleId) current = iterator.next();
          while (!current.done && current.value.key.slice(0, current.value.key.indexOf('\u0000')) === bundleId) {
            const row = JSON.parse(current.value.value); found.set(row.k, { phase: 'committed', generation: row.g, binding: row.b });
            current = iterator.next();
          }
          checkBundle(key, value, id => found.get(id));
        });
        spill!.close();
      }
    }
    if (spill) spill.close();
    return { file, bytes: info.size, digest, publishing: envelope.publishing, ...state, regions: { terminal: regions.terminal, bundles: regions.bundles },
      pending, counts, timing: { scanMs, joinMs: performance.now() - joinStarted, hashMs: 0 }, joined };
  } finally { fs.closeSync(fd); }
}
/** Every member of a map region in file order, reading whole lines (navigable) or re-tokenizing (compact). */
export function forEachMember(fd: number, region: MapRegion, callback: (key: string, value: any, offset: number) => void): void {
  if (!region.count) return;
  const reader = new ByteScanner(fd, region.end, region.start);
  for (;;) {
    reader.skipWhitespace();
    if (reader.position >= region.end) return;
    const offset = reader.position;
    const keyRaw = reader.readValue(64 * 1024);
    if (keyRaw[0] !== QUOTE) fail('SealCorrupt');
    const key = parseRaw(keyRaw);
    reader.skipWhitespace(); reader.expect(COLON); reader.skipWhitespace();
    const value = parseRaw(reader.readValue(16 * 1024 * 1024));
    callback(key, value, offset);
    reader.skipWhitespace();
    if (reader.position >= region.end) return;
    if (reader.next() !== COMMA) fail('SealCorrupt');
  }
}
/** A disposable external sorter: in-memory runs spilled as sorted files, merged on iteration. Process-owned, never authority. */
export class SpillSorter {
  private memory: { key: string; value: string }[] = []; private memoryBytes = 0;
  private runs: string[] = [];
  readonly directory: string;
  constructor(base: string, label: string, private readonly budgetBytes = 64 * 1024 * 1024) {
    this.directory = fs.mkdtempSync(path.join(base, `.work-${label}-${process.pid}-`));
  }
  add(key: string, value: string): void {
    this.memory.push({ key, value }); this.memoryBytes += key.length + value.length + 16;
    if (this.memoryBytes >= this.budgetBytes) this.spill();
  }
  private spill(): void {
    if (!this.memory.length) return;
    this.memory.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const file = path.join(this.directory, `run-${this.runs.length}.jsonl`);
    const fd = fs.openSync(file, 'w', 0o600);
    try {
      let buffer = '';
      for (const item of this.memory) { buffer += JSON.stringify([item.key, item.value]) + '\n'; if (buffer.length > 1 << 20) { fs.writeSync(fd, buffer); buffer = ''; } }
      if (buffer) fs.writeSync(fd, buffer);
    } finally { fs.closeSync(fd); }
    this.runs.push(file); this.memory = []; this.memoryBytes = 0;
  }
  *iterate(): Generator<{ key: string; value: string }> {
    this.spill();
    const readers = this.runs.map(file => lineReader(file));
    const heads: ([string, string] | null)[] = readers.map(r => { const n = r.next(); return n.done ? null : JSON.parse(n.value) as [string, string]; });
    for (;;) {
      let best = -1;
      for (let i = 0; i < heads.length; i++) if (heads[i] && (best < 0 || heads[i]![0] < heads[best]![0])) best = i;
      if (best < 0) return;
      const item = heads[best]!;
      const n = readers[best].next(); heads[best] = n.done ? null : JSON.parse(n.value) as [string, string];
      yield { key: item[0], value: item[1] };
    }
  }
  close(): void { try { fs.rmSync(this.directory, { recursive: true, force: true }); } catch { /* disposable */ } }
}
function* lineReader(file: string): Generator<string> {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1 << 20); let carry = ''; let position = 0;
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (!n) break;
      position += n;
      carry += chunk.subarray(0, n).toString('utf8');
      let lf: number;
      while ((lf = carry.indexOf('\n')) >= 0) { yield carry.slice(0, lf); carry = carry.slice(lf + 1); }
    }
    if (carry) yield carry;
  } finally { fs.closeSync(fd); }
}
/**
 * Write a checkpoint in the navigable layout from streamed members: the same v3 envelope and digest, map members one
 * per line in byte-sorted order. `members(map)` must yield sorted (key, compact JSON value) pairs; the caller holds the
 * small maps in memory. Returns the digest and the file size.
 */
export function writeNavigableCheckpoint(file: string, head: { version: 3; revision: number; generation: number; tail: any; lineage: StateLineage | null;
  retired: Record<string, number>; intents: Record<string, any>; slots: Record<string, any>; proofs: Record<string, any> },
  members: (map: 'terminal' | 'bundles') => Iterable<[string, string | Buffer]>, publishing: boolean,
  beforeInstall: () => void = () => {}, directoryEvery = 4096): { digest: string; bytes: number; regions: { terminal: MapRegion; bundles: MapRegion } } {
  const temporary = path.join(path.dirname(file), '.tmp-' + randomBytes(12).toString('hex'));
  const fd = fs.openSync(temporary, 'wx', 0o600);
  const digest = createHash('sha256');
  // `total` is the file offset of the next byte: the writer knows every member's offset, so the regions it returns are
  // exactly what a scan of the written file would index (no second pass over the bytes just written).
  let total = 0, pending: Buffer[] = [], pendingBytes = 0;
  const flush = () => { if (pending.length) { fs.writeSync(fd, pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes)); pending = []; pendingBytes = 0; } };
  // Hashed pieces never contain a raw LF (compact JSON); the member separators' LF is written unhashed.
  const write = (piece: string | Buffer, hashed: boolean) => {
    const buffer = typeof piece === 'string' ? Buffer.from(piece, 'utf8') : piece;
    pending.push(buffer); pendingBytes += buffer.length; total += buffer.length;
    if (hashed) digest.update(buffer);
    if (pendingBytes > 1 << 20) flush();
  };
  const regions: Record<string, MapRegion> = {};
  try {
    write('{"state":', false);
    const headText = JSON.stringify({ version: head.version, revision: head.revision, generation: head.generation, tail: head.tail, lineage: head.lineage,
      retired: head.retired, intents: head.intents, slots: head.slots, proofs: head.proofs });
    write(headText.slice(0, -1), true);
    for (const map of ['terminal', 'bundles'] as const) {
      write(',' + JSON.stringify(map) + ':{', true);
      let count = 0, previous: string | null = null;
      const directory: MemberDirectoryEntry[] = [];
      for (const [key, value] of members(map)) {
        if (previous !== null && !(key > previous)) fail('SealCorrupt');
        previous = key;
        if (count) write(',', true);
        write('\n', false);
        if (count % directoryEvery === 0) directory.push({ key, offset: total });
        write(JSON.stringify(key) + ':', true);
        write(value, true);
        count++;
      }
      if (count) write('\n', false);
      const end = total, start = count ? directory[0].offset : end;
      regions[map] = { start, end, count, bytes: end - start, sorted: true, navigable: true, directory };
      write('}', true);
    }
    write('}', true);
    const hex = digest.digest('hex');
    write(',"publishing":' + String(publishing) + ',"digest":"' + hex + '"}', false);
    flush();
    fs.fsyncSync(fd); fs.closeSync(fd);
    // The caller releases its handles on the previous checkpoint here (a replaced file may not be open on every OS).
    beforeInstall();
    fs.renameSync(temporary, file); syncDirectory(path.dirname(file));
    return { digest: hex, bytes: total, regions: { terminal: regions.terminal, bundles: regions.bundles } };
  } catch (error) { try { fs.closeSync(fd); } catch { /* closed */ } try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ } throw error; }
}

/** The protected directory's structure and file inventory (identities, sizes, stamps): no file content is read. */
function directoryInventory(directory: string): { root: string; inventory: unknown[]; empty: boolean } {
  if (!directory || !path.isAbsolute(directory) || directory.includes('\0')) return fail('SealUnavailable');
  const root = path.resolve(directory), info = fs.lstatSync(root, { throwIfNoEntry: false });
  const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!info?.isDirectory() || info.isSymbolicLink() || !samePath(fs.realpathSync.native(root), root)) return fail('SealUnavailable');
  const inventory: unknown[] = [[info.dev, info.ino, info.uid, info.gid, info.mode]];
  let empty = true;
  // The v4 root keeps its immutable roots, packs, WAL segments, quarantine and scratch under seal/v4/<kind>/ (one
  // level); every other entry of a protected directory is a regular file.
  const walk = (entry: string, child: string, depth: number) => {
    const childInfo = fs.lstatSync(child);
    if (!childInfo.isDirectory() || childInfo.isSymbolicLink() || process.platform === 'linux' &&
      (childInfo.uid !== info.uid || (childInfo.mode & 0o077) !== 0)) return fail('SealUnavailable');
    inventory.push([entry, childInfo.dev, childInfo.ino, childInfo.uid, childInfo.gid, childInfo.mode]);
    for (const name of fs.readdirSync(child).sort()) {
      const file = path.join(child, name), stat = fs.lstatSync(file);
      if (stat.isDirectory() && !stat.isSymbolicLink() && ((entry === 'seal' && name === 'v4') ||
        (entry === 'seal/v4' && ['roots', 'pages', 'wal', 'quarantine', 'tmp'].includes(name)))) { walk(entry + '/' + name, file, depth + 1); continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return fail('SealUnavailable');
      inventory.push([entry, name, stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]);
      if (entry !== 'seal/v4/tmp') empty = false;
    }
  };
  for (const entry of fs.readdirSync(root).sort()) {
    if (entry === 'writer.lock') continue;
    if (!['seal', 'journal', 'expiry-evidence'].includes(entry)) return fail('SealUnsupportedFormat');
    walk(entry, path.join(root, entry), 0);
  }
  return { root, inventory, empty };
}
/**
 * Full admission of a protected directory into a verified view: one streaming validation of the checkpoint (every
 * member once, digest), every complete WAL record validated once and replayed once, the tail checked. `repair`
 * (writer only, under the lifetime fence) quarantines a torn WAL suffix and completes an in-flight tail publication.
 */
function admitEngine(directory: string, pair: PairIdentity | undefined, repair: boolean, format: 3 | 4 = 3): Engine {
  const { root, inventory, empty } = directoryInventory(directory);
  const engine = new Engine(root);
  const file = engine.file, info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info) {
    if (!empty) return fail('SealMissing');
    engine.format = format;
    engine.head = { version: 3, revision: 0, generation: 0, tail: null, lineage: null, retired: { viewing: 0, history: 0 } };
    engine.terminal = new HistoryMap('terminal', file, null, 0); engine.bundles = new HistoryMap('bundles', file, null, 0);
    engine.pin(); (engine as any).inventory = inventory;
    return engine;
  }
  // The stored major format is read from the selector/checkpoint bytes themselves (never inferred from a name, a
  // stamp or the environment); the owner's entry mode must name that format, or admission refuses before anything.
  let selector: { body: V4.SelectorBody; sha256: string } | null = null;
  try { selector = V4.readSelector(file); }
  catch (error: any) {
    if (!(error instanceof V4.V4Error) || error.code !== 'SealUnsupportedFormat' || !/^(v3-checkpoint|selector-size)$/.test(error.detail)) throw translateV4(error);
  }
  if (selector) {
    if (format !== 4) return fail('SealUnsupportedFormat');
    return admitEngineV4(engine, selector, pair, repair, inventory);
  }
  if (format !== 3) return fail('SealUnsupportedFormat');
  // Admission of an unsupported or corrupt checkpoint never repairs anything.
  const scanned = scanCheckpoint(file, { pair, join: info.size < 64 * 1024 * 1024 ? 'lookup' : 'merge' });
  if (!scanned.lineage) return fail('SealMissing');
  const fd = fs.openSync(file, 'r');
  try {
    engine.head = { version: 3, revision: scanned.revision, generation: scanned.generation, tail: scanned.tail, lineage: scanned.lineage, retired: scanned.retired };
    engine.intents = scanned.intents; engine.slots = scanned.slots; engine.proofs = scanned.proofs;
    for (const [position, q] of Object.entries(engine.slots) as [string, CommitBinding][]) engine.slotOf.set(q.stream + ':' + q.attemptId, position);
    const navigable = scanned.regions.terminal.navigable && scanned.regions.bundles.navigable;
    engine.terminal = new HistoryMap('terminal', file, navigable ? scanned.regions.terminal : null, navigable ? scanned.counts.terminal : 0);
    engine.bundles = new HistoryMap('bundles', file, navigable ? scanned.regions.bundles : null, navigable ? scanned.counts.bundles : 0);
    if (!navigable) {
      // An old compact layout: its members live in the change set until the next compaction rewrites them navigably.
      forEachMember(fd, scanned.regions.terminal, (key, value) => { engine.terminal.set(key, value); });
      forEachMember(fd, scanned.regions.bundles, (key, value) => { engine.bundles.set(key, value); });
    } else {
      // Terminals carrying a pending not-found record are few; their identities are needed without a scan.
      forEachMember(fd, scanned.regions.terminal, (key, value) => { if (value.notFound) engine.notFound.add(key); });
    }
    engine.checkpoint = { digest: scanned.digest, bytes: scanned.bytes, revision: scanned.revision, publishing: scanned.publishing, navigable };
    engine.publishing = scanned.publishing;
    // The WAL: complete records after the checkpoint are replayed once; covered records are still shape-checked.
    const { records, good, raw } = readWal(engine.log, 0);
    for (const body of records) {
      validateRecordShape(body, engine.head.lineage?.origin);
      if (body.published) {
        if (body.revision <= engine.checkpoint.revision && !(engine.publishing && body.revision === engine.checkpoint.revision)) continue;
        if (body.revision !== engine.head.revision || !engine.publishing) fail('SealCorrupt');
        engine.publishing = false; continue;
      }
      if (body.revision <= engine.checkpoint.revision) { if (body.generation > engine.head.generation) fail('SealCorrupt'); continue; }
      if (body.revision !== engine.head.revision + 1 || body.generation < engine.head.generation || engine.publishing) fail('SealCorrupt');
      const touched = new Map<string, Set<string>>(), undo: (() => void)[] = [];
      engine.apply(body, touched, undo);
      engine.validateTouched(touched, body.publishing);
      engine.publishing = body.publishing;
    }
    engine.walOffset = good;
    // A torn suffix is not a complete record: the writer preserves and shortens it; an inspector reads past it.
    if (good < raw.length && repair) quarantineTorn(engine.log, raw, good, 0);
    // Pending publication is the only authority for a torn/missing tail. Complete
    // incompatible WAL records must be rejected even when that repair is pending.
    if (!engine.publishing) {
      const tail = readTailFile(engine.tailFile);
      if (!tail) fail('SealMissing');
      if (hash(tail) !== hash(engine.head.tail)) fail('SealTailMismatch');
    }
    engine.pin(); (engine as any).inventory = inventory;
    return engine;
  } finally { fs.closeSync(fd); }
}
/** Read-only admission, also usable by a trusted inspector on a read-only copy: the whole state as one object.
 * Never instantiate the physical journal here: its constructor repairs torn bytes.
 * The caller repeats this check under the lifetime fence before opening any writer. */
export function inspectExternal(directory: string, pair?: PairIdentity, format: 3 | 4 = 3): { state: ExternalState | null; fingerprint: string; format: 3 | 4 } {
  const engine = admitEngine(directory, pair, false, format);
  try {
    if (engine.pristine) return { state: null, fingerprint: hash((engine as any).inventory), format: engine.format };
    const state = engine.materialize();
    return { state, fingerprint: hash([(engine as any).inventory, engine.checkpoint, engine.walOffset, state.revision, state.tail]), format: engine.format };
  } finally { engine.close(); }
}
/** The stored major format of a protected directory from its bytes (null when pristine); refuses nothing else. */
export function storedFormat(directory: string): 3 | 4 | null {
  const file = path.join(path.resolve(directory), 'seal', 'settlement.json');
  if (!fs.existsSync(file)) return null;
  try { return V4.readSelector(file) ? 4 : null; }
  catch (error: any) { if (error instanceof V4.V4Error && error.code === 'SealUnsupportedFormat' && /^(v3-checkpoint|selector-size)$/.test(error.detail)) return 3; throw translateV4(error); }
}
/** The bytes-level identity of a protected directory (inventory, file digests): what an owner compares across the
 * fence acquisition after its one validating admission. */
export function inspectFingerprint(directory: string): string {
  const { root, inventory } = directoryInventory(directory);
  const digests: string[] = [];
  const names = ['settlement.json', 'settlement.jsonl', 'tail.json'];
  // A v4 root: its current WAL segment (named by the selector) is the mutable file an owner compares.
  try { const selector = V4.readSelector(path.join(root, 'seal', 'settlement.json')); if (selector) names.push('v4/wal/' + selector.body.wal.segment + '.jsonl'); } catch { /* not a selector: the v3 files above */ }
  for (const name of names) {
    const file = path.join(root, 'seal', name);
    if (!fs.existsSync(file)) { digests.push('absent'); continue; }
    const h = createHash('sha256'), fd = fs.openSync(file, 'r'), chunk = Buffer.allocUnsafe(SCAN_CHUNK);
    try { let position = 0; for (;;) { const n = fs.readSync(fd, chunk, 0, chunk.length, position); if (!n) break; h.update(chunk.subarray(0, n)); position += n; } }
    finally { fs.closeSync(fd); }
    digests.push(h.digest('hex'));
  }
  return hash([inventory, digests]);
}
const COMPACTION_FLOOR = 4 * 1024 * 1024, COMPACTION_CEILING = 128 * 1024 * 1024;
/** Size-proportional amortization: compact once the WAL has grown to a quarter of the checkpoint, never below 4 MiB
 * and never beyond 128 MiB - the change set the owner keeps in memory until the next compaction is bounded by the
 * WAL it mirrors, not by the history's size (RSS stays bounded at any cardinality; each compaction remains one
 * streaming pass over the whole checkpoint, O(S), which is the measured cost reported for the envelope). */
function compactionDue(engine: Engine): boolean {
  return engine.walOffset >= Math.min(COMPACTION_CEILING, Math.max(COMPACTION_FLOOR, Math.floor((engine.checkpoint?.bytes ?? 0) / 4)));
}
/** Streaming merge of the checkpoint region and the change set into a new navigable checkpoint, then the WAL reset
 * (checkpoint before WAL reset; the owner is single-threaded, so no append can interleave). One pass over the
 * history: unchanged members are copied as their compact bytes, the writer returns the regions of what it wrote, and
 * that checkpoint becomes the owner's base at once (the validated view it was streamed from is unchanged by it). */
function compactEngine(engine: Engine, context: WriterContext): void {
  if (engine.publishing) fail('SealCorrupt');
  const head = { version: 3 as const, revision: engine.head.revision, generation: engine.head.generation, tail: engine.head.tail, lineage: engine.head.lineage,
    retired: engine.head.retired, intents: engine.intents, slots: engine.slots, proofs: engine.proofs };
  // Any failure from the installation on leaves the files the only authority: the view is re-admitted afresh.
  engine.tainted = true;
  const written = writeNavigableCheckpoint(engine.file, head, map => (map === 'terminal' ? engine.terminal : engine.bundles).rawEntries(), false, () => engine.close());
  if (context.log) { try { fs.closeSync(context.log.fd); } catch { /* reopened below */ } context.log = undefined; }
  const fd = fs.openSync(engine.log, 'w', 0o600);
  try { fs.fdatasyncSync(fd); } finally { fs.closeSync(fd); }
  engine.terminal = new HistoryMap('terminal', engine.file, written.regions.terminal, written.regions.terminal.count);
  engine.bundles = new HistoryMap('bundles', engine.file, written.regions.bundles, written.regions.bundles.count);
  engine.checkpoint = { digest: written.digest, bytes: written.bytes, revision: engine.head.revision, publishing: false, navigable: true };
  engine.walOffset = 0; engine.publishing = false;
  engine.pin(); engine.tainted = false;
}
/** Commit one record: validate the touched closure on the view, append it durably, publish the tail if asked. The
 * view is reverted if validation or the append fails; an uncertain write taints the view (fresh admission next). */
function commitRecord(engine: Engine, context: WriterContext, body: any, kind: 'update' | 'reserve'): void {
  if (engine.format === 4) return commitRecordV4(engine, body, kind);
  if (engine.publishing) fail('SealCorrupt');
  validateRecordShape(body, engine.head.lineage?.origin);
  if (body.revision !== engine.head.revision + 1 || body.generation < engine.head.generation) fail('SealCorrupt');
  if (kind === 'reserve' && (body.publishing || body.generation !== engine.head.generation + 1)) fail('SealCorrupt');
  const touched = new Map<string, Set<string>>(), undo: (() => void)[] = [];
  const revert = () => { for (const step of undo.reverse()) step(); };
  try {
    engine.apply(body, touched, undo);
    engine.validateTouched(touched, body.publishing);
  } catch (error) { revert(); throw error; }
  try {
    engine.walOffset += append(engine.log, body, context);
  } catch (error) { revert(); engine.tainted = true; throw error; }
  if (body.publishing) {
    engine.publishing = true;
    try {
      publishTail(engine.tailFile, body.tail);
      engine.walOffset += append(engine.log, { version: 3, revision: body.revision, published: true }, context);
    } catch (error) { engine.tainted = true; throw error; }
    engine.publishing = false;
  }
  engine.pin();
}
// ───────────────────────── KIN-EMR-STATE-V4 owner view (D1691 approval, D1693 order) ─────────────────────────
/** The v4 owner state behind the same Engine view: the admitted validated root, its eight trees, the meta facts, the
 * in-memory pending work and the WAL position the next transition continues from. */
export interface V4State {
  directory: string; store: V4.PackStore; validatorSha256: string;
  rootSha256: string; root: V4.RootBody; trees: Record<number, V4.Tree>;
  meta: { lineage: StateLineage; tail: any; retired: Record<string, number>; validator: any; dbWitness: any; fullCheck: V4.FullCheck; copyProvenance: any };
  pending: Map<string, any>;
  segment: V4.WalSegment; lsn: number; previousSha256: string; walEnd: number; segmentStart: number; segmentTransitions: number; segmentOpenedAt: number;
  /** The periodic complete check in progress (resumable across restarts through its scratch file), if any. */
  sweep: V4Sweep | null;
  /** Discovered corruption: the owner is latched (no further transition) until the operator restores/repairs. */
  latched: V4Latch | null;
}
/** The complete check's progress: the pinned root it checks, the storage cursor (tree, digest) and the DB cursor. */
export interface V4Sweep {
  startedRoot: string; startedAt: string; phase: 'storage' | 'database'; tree: number; from: string | null;
  keys: Record<string, number>; pages: number; db: { stream: string; after: number } | null; dbDone: boolean;
}
export interface V4Latch { code: string; detail: string; at: string; root: string; phase: string; tree: number | null; from: string | null }
const V4_META_KEYS = ['lineage', 'tail', 'retired', 'validator', 'dbWitness', 'fullCheck', 'copyProvenance'] as const;
const V4_ROTATE_BYTES = 64 * 1024 * 1024, V4_ROTATE_TRANSITIONS = 2048, V4_ROTATE_MS = 30_000;
/** The complete-check period (order section 2: a periodic full check within 24 h) and the leaves one step may visit. */
export const V4_FULL_CHECK_MS = 24 * 60 * 60 * 1000, V4_FULL_CHECK_STEP_LEAVES = 256;
const v4Directory = (directory: string) => path.join(directory, 'seal', 'v4');
const sweepFile = (v4: string) => path.join(v4, 'tmp', 'full-check.json');
const latchFile = (v4: string) => path.join(v4, 'tmp', 'latch.json');
function readScratch(file: string): any {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeScratch(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  V4.writeAtomic(file, JSON.stringify(value));
}
/** The repository/image root the validator manifest is read from (dist/emr-runtime in the image, api/src here). */
const appRoot = () => __dirname.split(path.sep).includes('dist') ? path.resolve(__dirname, '..', '..') : path.resolve(__dirname, '..', '..', '..');
function translateV4(error: any): any {
  if (error instanceof V4.V4Error) return Object.assign(new Error(error.code), { code: error.code, detail: error.detail });
  return error;
}
/** A large map backed by a v4 tree: the change set holds this record's members until the transition is durable. */
class V4Map implements MemberMap {
  readonly delta = new Map<string, any>();
  added = 0; removed = 0;
  constructor(readonly name: 'terminal' | 'bundles', public tree: V4.Tree) {}
  get(key: string): any {
    if (this.delta.has(key)) { const v = this.delta.get(key); return v === null ? undefined : v; }
    let raw: string | undefined;
    try { raw = this.tree.get(key); } catch (error) { throw translateV4(error); }
    return raw === undefined ? undefined : JSON.parse(raw);
  }
  set(key: string, value: any): void {
    const before = this.get(key);
    if (value === null) { if (before !== undefined) this.removed++; }
    else if (before === undefined) this.added++;
    this.delta.set(key, value);
  }
  get count(): number { return this.tree.count + this.added - this.removed; }
  *rawEntries(): Generator<[string, string | Buffer]> {
    for (const [key, raw] of this.tree.entries()) { if (this.delta.has(key)) continue; yield [key, raw]; }
    for (const [key, value] of this.delta) if (value !== null) yield [key, JSON.stringify(value)];
  }
  *entries(): Generator<[string, any]> {
    for (const [key, raw] of this.rawEntries()) yield [key, typeof raw === 'string' ? JSON.parse(raw) : parseRaw(raw)];
  }
  committed(tree: V4.Tree): void { this.tree = tree; this.delta.clear(); this.added = 0; this.removed = 0; }
}
/** Meta values: the v3 objects (lineage, tail, retired) keep their v3 member JSON (so the existing tail digest and
 * lineage hash are over the same bytes); the v4 facts (validator, dbWitness, fullCheck, copyProvenance) are J-encoded. */
const V4_META_V3 = new Set(['lineage', 'tail', 'retired']);
const metaRaw = (key: string, value: unknown): string => V4_META_V3.has(key) ? JSON.stringify(value) : V4.canonical(value);
function metaOf(tree: V4.Tree, key: string): any {
  const raw = tree.get(key);
  if (raw === undefined) throw Object.assign(new Error('SealCorrupt'), { code: 'SealCorrupt', detail: 'meta-missing:' + key });
  if (V4_META_V3.has(key)) { try { return JSON.parse(raw); } catch { return fail('SealCorrupt'); } }
  return V4.parseCanonical(raw, 'meta ' + key);
}
function readPrecedingRecord(file: string, offset: number): { sha256: string; lsn: number; record: V4.WalRecord } {
  // The record ending exactly at `offset` (bounded read of at most one control line before it).
  const size = fs.statSync(file).size;
  if (offset < 1 || offset > size) fail('SealCorrupt');
  const start = Math.max(0, offset - V4.CONTROL_MAX_BYTES), fd = fs.openSync(file, 'r'), bytes = Buffer.alloc(offset - start);
  try { let read = 0; while (read < bytes.length) { const n = fs.readSync(fd, bytes, read, bytes.length - read, start + read); if (!n) fail('SealCorrupt'); read += n; } }
  finally { fs.closeSync(fd); }
  if (bytes[bytes.length - 1] !== 10) fail('SealCorrupt');
  const lineStart = bytes.lastIndexOf(10, bytes.length - 2) + 1;
  if (lineStart === 0 && start > 0) fail('SealCorrupt');
  const opened = V4.openEnvelope(V4.DOMAIN.wal, bytes.subarray(lineStart), 'wal');
  const record = V4.validWalRecord(opened.body);
  return { sha256: opened.sha256, lsn: V4.parseDecimal(record.lsn, 'wal'), record };
}
function validDbWitness(value: any): void {
  const ok = isRecord(value) && keys(value, ['version', 'pair', 'lineageSha256', 'streams', 'validationRevision']) && value.version === 1 && validPair(value.pair) &&
    sha(value.lineageSha256) && typeof value.validationRevision === 'string' && /^(0|[1-9][0-9]*)$/.test(value.validationRevision) &&
    keys(value.streams, ['viewing', 'history']) && ['viewing', 'history'].every(s => { const w = value.streams[s];
      return keys(w, ['chainId', 'verifiedThrough', 'retainedStart', 'expiry']) && uuid(w.chainId) && position(w.verifiedThrough) &&
        (w.retainedStart === null || keys(w.retainedStart, ['sequence', 'previousHash']) && integer(w.retainedStart.sequence, 1) && sha(w.retainedStart.previousHash)) &&
        (w.expiry === null || keys(w.expiry, ['attemptKey', 'binding', 'coreSha256', 'deletedThrough', 'anchorHash']) && text(w.expiry.attemptKey) && isRecord(w.expiry.binding) && sha(w.expiry.coreSha256) && integer(w.expiry.deletedThrough, 1) && sha(w.expiry.anchorHash)); });
  if (!ok) fail('SealCorrupt');
}
function validDbBindingValue(key: string, value: any): void {
  if (!keys(value, ['binding', 'entrySha256']) || !(value.entrySha256 === null || sha(value.entrySha256))) fail('SealCorrupt');
  let q: CommitBinding;
  try { q = parseCommitBinding(value.binding); } catch { return fail('SealCorrupt'); }
  if (key !== q.stream + ':' + q.sequence) fail('SealCorrupt');
}
/** Admission of a v4 root: the selector, its root, the WAL suffix after the selector, the meta facts, the validator,
 * the lineage/pair, the tail barrier, the small maps and the pending work; `repair` (the owner) finishes a durable but
 * unselected transition and quarantines a torn suffix. The history itself is not scanned. */
function admitEngineV4(engine: Engine, selector: { body: V4.SelectorBody; sha256: string }, pair: PairIdentity | undefined, repair: boolean, inventory: unknown[]): Engine {
  const refuse = (detail: string): never => { throw Object.assign(new Error('SealCorrupt'), { code: 'SealCorrupt', detail }); };
  try {
    const v4 = v4Directory(engine.directory);
    // A latched root (corruption discovered by a complete check or an on-use validation) is never admitted again
    // until the operator restores or repairs it and removes the latch: no fast path, no silent return to ready.
    const latch = readScratch(latchFile(v4));
    if (latch) throw Object.assign(new Error('SealCorrupt'), { code: 'SealCorrupt', detail: 'latched:' + String(latch.detail ?? ''), latch });
    let rootSha256 = selector.body.rootSha256, root = V4.readRoot(v4, rootSha256);
    if (root.revision !== selector.body.revision) refuse('selector-revision');
    const segmentFile = path.join(V4.walDirectory(v4), selector.body.wal.segment + '.jsonl');
    const offset = V4.parseDecimal(selector.body.wal.offset, 'selector');
    let lsn = V4.parseDecimal(selector.body.wal.lsn, 'selector'), previous = selector.body.wal.previousSha256;
    const preceding = readPrecedingRecord(segmentFile, offset);
    if (preceding.sha256 !== previous || preceding.lsn !== lsn || preceding.record.segment !== selector.body.wal.segment) refuse('wal-preceding');
    const suffix = V4.WalSegment.read(segmentFile, offset);
    let walEnd = offset, outstanding: { record: Extract<V4.WalRecord, { type: 'prepare' }>; sha256: string; lsn: number } | null = null, adoptedEnd: number | null = null;
    for (const item of suffix.records) {
      const r = item.record;
      if (V4.parseDecimal(r.lsn, 'wal') !== lsn + 1 || r.previousSha256 !== previous || r.segment !== selector.body.wal.segment || r.type === 'start') refuse('wal-chain');
      if (r.type === 'prepare') {
        if (outstanding || r.previousRoot !== rootSha256) refuse('wal-prepare');
        outstanding = { record: r, sha256: item.sha256, lsn: lsn + 1 };
      } else if (r.type === 'complete') {
        if (!outstanding || r.prepareLsn !== outstanding.record.lsn || r.nextRoot !== outstanding.record.nextRoot) refuse('wal-complete');
        root = V4.readRoot(v4, r.nextRoot); rootSha256 = r.nextRoot; outstanding = null; adoptedEnd = item.end;
      }
      lsn++; previous = item.sha256; walEnd = item.end;
    }
    const tailFile = engine.tailFile; let tailOnDisk = readTailFile(tailFile);
    if (outstanding && repair) {
      // A durable prepare whose root exists: its tail (before or after) must agree; only the owner completes it. A
      // read-only inspection sees the selected (accepted) root and leaves the completion to the owner.
      const next = V4.readRoot(v4, outstanding.record.nextRoot);
      const tailHash = tailOnDisk ? hash(tailOnDisk) : null;
      if (next.transition.previousRoot !== rootSha256 || !(tailHash === outstanding.record.tailBefore || tailHash === outstanding.record.tailAfter)) refuse('prepare-tail');
      const nextMeta = V4.Tree.open(new V4.PackStore(v4, next.lineageSha256), 1, next.trees[0].ref, V4.parseDecimal(next.trees[0].count, 'root'));
      const nextTail = metaOf(nextMeta, 'tail');
      if (outstanding.record.tailAfter !== null && tailHash !== outstanding.record.tailAfter) { publishTail(tailFile, nextTail); tailOnDisk = readTailFile(tailFile); }
      const segment = new V4.WalSegment(v4, selector.body.wal.segment);
      const complete = segment.append({ format: 'KIN-EMR-WAL', version: 4, segment: segment.segment, lsn: String(lsn + 1), previousSha256: previous, type: 'complete', prepareLsn: outstanding.record.lsn, nextRoot: outstanding.record.nextRoot });
      segment.close();
      lsn++; previous = complete.sha256; walEnd = complete.end; root = next; rootSha256 = outstanding.record.nextRoot; adoptedEnd = complete.end;
    }
    if (suffix.torn && repair) {
      const quarantine = path.join(v4, 'quarantine'); fs.mkdirSync(quarantine, { recursive: true, mode: 0o700 });
      const evidence = path.join(quarantine, selector.body.wal.segment + '-' + walEnd + '.bin');
      const fd = fs.openSync(evidence, 'wx', 0o600); try { fs.writeFileSync(fd, suffix.torn); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } syncDirectory(quarantine);
      fs.truncateSync(segmentFile, walEnd);
    }
    if (adoptedEnd !== null && repair) {
      V4.writeSelector(engine.file, { format: V4.V4_FORMAT, version: 4, layout: 1, rootSha256, revision: root.revision, wal: { segment: selector.body.wal.segment, offset: String(walEnd), lsn: String(lsn), previousSha256: previous } });
    }
    // The root's facts.
    const manifest = V4.loadValidatorManifest(appRoot());
    if (root.validatorSha256 !== manifest.validatorSha256 || root.validatorId !== V4.V4_VALIDATOR_ID) fail('SealUnsupportedFormat');
    const store = new V4.PackStore(v4, root.lineageSha256);
    const trees: Record<number, V4.Tree> = {};
    for (const descriptor of root.trees) trees[descriptor.id] = V4.Tree.open(store, descriptor.id, descriptor.ref, V4.parseDecimal(descriptor.count, 'root'));
    const meta: any = {};
    for (const key of V4_META_KEYS) meta[key] = metaOf(trees[1], key);
    if (trees[1].count !== V4_META_KEYS.length) refuse('meta-count');
    if (V4.lineageSha256(meta.lineage) !== root.lineageSha256 || !isRecord(meta.lineage) || !validPair(meta.lineage.origin)) refuse('lineage');
    if (pair && !samePair(meta.lineage.origin, pair)) fail('SealChainMismatch');
    if (!keys(meta.validator, ['id', 'sha256', 'mode', 'predecessorRoot', 'changedDependencySha256']) || meta.validator.sha256 !== root.validatorSha256 || !['full', 'incremental'].includes(meta.validator.mode)) refuse('meta-validator');
    V4.validFullCheck(meta.fullCheck, 'meta'); if (hash(meta.fullCheck) !== hash(root.fullCheck)) refuse('fullCheck');
    validDbWitness(meta.dbWitness);
    if (!(meta.copyProvenance === null || keys(meta.copyProvenance, ['captureSha256', 'verificationReceiptSha256']))) refuse('copyProvenance');
    const generation = V4.parseDecimal(root.generation, 'root'), revision = V4.parseDecimal(root.revision, 'root');
    validateTail(meta.tail, generation, meta.lineage.origin);
    if (hash(meta.tail) !== root.stateTailSha256) refuse('tail-hash');
    if (!tailOnDisk) fail('SealMissing');
    // An in-flight publication (a durable prepare the owner will complete) is the only authority for a tail ahead of
    // the selected root; a read-only inspection accepts exactly that tail, nothing else.
    if (hash(tailOnDisk) !== hash(meta.tail) && !(outstanding && hash(tailOnDisk) === outstanding.record.tailAfter)) fail('SealTailMismatch');
    if (!keys(meta.retired, ['viewing', 'history']) || !integer(meta.retired.viewing) || !integer(meta.retired.history)) refuse('retired');
    engine.format = 4;
    // The stored meta members stay immutable (the before/after comparison of a commit depends on it); the owner's head
    // works on its own copy of the retired frontiers.
    engine.head = { version: 3, revision, generation, tail: meta.tail, lineage: meta.lineage, retired: { ...meta.retired } };
    for (const [name, id] of [['intents', 2], ['slots', 3], ['proofs', 4]] as const) {
      const target: Record<string, any> = {};
      const items = [...trees[id].entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      for (const [key, raw] of items) { const value = JSON.parse(raw); validateMapValue(name, key, value, generation, meta.lineage.origin); target[key] = value; }
      (engine as any)[name] = target;
    }
    for (const [position, q] of Object.entries(engine.slots) as [string, CommitBinding][]) engine.slotOf.set(q.stream + ':' + q.attemptId, position);
    engine.terminal = new V4Map('terminal', trees[5]); engine.bundles = new V4Map('bundles', trees[6]);
    const pending = new Map<string, any>();
    for (const [key, raw] of trees[7].entries()) {
      const value = V4.parseCanonical(raw, 'pending');
      if (key.startsWith('attempt:')) {
        if (!keys(value, ['kind', 'stateKey', 'slotKey', 'proofKey', 'revision']) || value.kind !== 'attempt' || key !== 'attempt:' + value.stateKey ||
          !engine.intents[value.stateKey] || engine.slotOf.get(value.stateKey) !== value.slotKey) fail('UnsealedEntryUnexplained');
      } else if (key.startsWith('journal:')) {
        if (!keys(value, ['kind', 'stateKey', 'journalId', 'eventId', 'contentSha256', 'revision']) || value.kind !== 'journal-not-found' || key !== 'journal:' + value.stateKey) fail('UnsealedEntryUnexplained');
        engine.notFound.add(value.stateKey);
      } else refuse('pending-key');
      pending.set(key, value);
    }
    // Every live intent has its pending entry (omitted work is a refusal, never derived from the client's map).
    for (const id of Object.keys(engine.intents)) if (!pending.has('attempt:' + id)) fail('UnsealedEntryUnexplained');
    // The identity closure of the small maps against the (large) terminal tree, as every v3 admission performs it.
    const touched = new Map<string, Set<string>>();
    touched.set('slots', new Set(Object.keys(engine.slots))); touched.set('intents', new Set(Object.keys(engine.intents))); touched.set('proofs', new Set(Object.keys(engine.proofs)));
    engine.validateTouched(touched, false);
    const stat = fs.statSync(segmentFile);
    engine.v4 = { directory: v4, store, validatorSha256: manifest.validatorSha256, rootSha256, root, trees, meta, pending,
      segment: new V4.WalSegment(v4, selector.body.wal.segment), lsn, previousSha256: previous, walEnd, segmentStart: 0, segmentTransitions: 0, segmentOpenedAt: stat.mtimeMs,
      sweep: loadSweep(v4), latched: null };
    engine.log = segmentFile;
    engine.checkpoint = { digest: rootSha256, bytes: 0, revision, publishing: false, navigable: true };
    engine.walOffset = walEnd;
    engine.pin(); (engine as any).inventory = inventory;
    return engine;
  } catch (error) { throw translateV4(error); }
}
const treeKeyOrder = (a: { tree: number; key: string }, b: { tree: number; key: string }) => a.tree - b.tree || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
function coverageSha256(descriptors: V4.TreeDescriptor[], meta: any): string {
  return V4.domainHash(V4.DOMAIN.coverage, V4.canonical({ trees: descriptors.filter(d => d.id !== 1), meta: { lineage: meta.lineage, tail: meta.tail, retired: meta.retired, dbWitness: meta.dbWitness, copyProvenance: meta.copyProvenance } }));
}
/** One v4 transition for a validated record: new pages (copy-on-write), the immutable root, WAL prepare, the
 * independent tail when it advances, WAL complete, then the selector; only then is the view advanced. */
function commitRecordV4(engine: Engine, body: any, kind: 'update' | 'reserve'): void {
  const v = engine.v4!;
  if (v.latched) throw Object.assign(new Error('SealCorrupt'), { code: 'SealCorrupt', detail: 'latched:' + v.latched.detail, latch: v.latched });
  validateRecordShape(body, engine.head.lineage?.origin);
  if (body.revision !== engine.head.revision + 1 || body.generation < engine.head.generation) fail('SealCorrupt');
  if (kind === 'reserve' && (body.publishing || body.generation !== engine.head.generation + 1)) fail('SealCorrupt');
  const dbBindings: Record<string, any> = body.patch.dbBindings ?? {}, dbWitness = body.patch.dbWitness;
  for (const [key, value] of Object.entries(dbBindings)) if (value !== null) validDbBindingValue(key, value);
  if (dbWitness !== undefined) validDbWitness(dbWitness);
  const touched = new Map<string, Set<string>>(), undo: (() => void)[] = [];
  const revert = () => { for (const step of undo.reverse()) step(); undo.length = 0; };
  try {
    engine.apply(body, touched, undo);
    engine.validateTouched(touched, body.publishing);
  } catch (error) { revert(); throw error; }
  const revision = body.revision, revisionText = String(revision);
  const writer = new V4.PackWriter(v.store, revision);
  try {
    const treeChanges = new Map<number, Map<string, string | null>>();
    const changeArray: V4.Change[] = [];
    const change = (tree: number, key: string, before: string | undefined, after: string | null, dependencies: { tree: number; key: string }[]) => {
      if (before === undefined && after === null) return;
      if (before !== undefined && after !== null && before === after) return;
      let m = treeChanges.get(tree); if (!m) treeChanges.set(tree, m = new Map()); m.set(key, after);
      const unique = new Map<string, { tree: number; key: string }>(); for (const d of dependencies) unique.set(d.tree + ':' + d.key, d);
      changeArray.push({ tree: tree as V4.TreeId, key, beforeSha256: before === undefined ? null : V4.blobSha256(before), afterSha256: after === null ? null : V4.blobSha256(after), dependencies: [...unique.values()].sort(treeKeyOrder) as { tree: V4.TreeId; key: string }[] });
    };
    const smallBefore = (tree: number, key: string) => v.trees[tree].get(key);
    const slotDeps = (id: string) => { const d: { tree: number; key: string }[] = []; const pos = engine.slotOf.get(id); if (pos) d.push({ tree: 3, key: pos }); if (engine.terminal.get(id)) d.push({ tree: 5, key: id }); return d; };
    for (const [name, tree] of [['intents', 2], ['slots', 3], ['proofs', 4]] as const) {
      for (const id of touched.get(name) ?? []) {
        const after = (engine as any)[name][id] === undefined ? null : JSON.stringify((engine as any)[name][id]);
        const deps = name === 'slots' ? (() => { const stored = v.trees[3].get(id); const q = (engine.slots[id] ?? (stored ? JSON.parse(stored) : undefined)) as CommitBinding | undefined; const k = q ? q.stream + ':' + q.attemptId : null; return k ? [{ tree: 2, key: k }, ...(engine.proofs[k] ? [{ tree: 4, key: k }] : []), ...(engine.terminal.get(k) ? [{ tree: 5, key: k }] : [])] : []; })() : slotDeps(id);
        change(tree, id, smallBefore(tree, id), after, deps);
      }
    }
    for (const [map, tree] of [[engine.terminal, 5], [engine.bundles, 6]] as const) {
      for (const [key, value] of map.delta) {
        const before = v.trees[tree].get(key), after = value === null ? null : JSON.stringify(value);
        const deps = tree === 6 && value ? (value.refs ?? []).map((r: any) => ({ tree: 5, key: r.stream + ':' + r.attemptId })) : slotDeps(key).filter(d => d.tree !== 5);
        change(tree, key, before, after, deps);
      }
    }
    // Pending work: exact and exhaustive for every touched attempt key.
    const ids = new Set<string>();
    for (const position of touched.get('slots') ?? []) { const q = engine.slots[position] ?? (() => { const raw = v.trees[3].get(position); return raw ? JSON.parse(raw) : undefined; })(); if (q) ids.add(q.stream + ':' + q.attemptId); }
    for (const name of ['intents', 'proofs', 'terminal'] as const) for (const id of touched.get(name) ?? []) ids.add(id);
    for (const id of ids) {
      const attemptKey = 'attempt:' + id, journalKey = 'journal:' + id;
      const slot = engine.slotOf.get(id);
      const attempt = engine.intents[id] && slot ? { kind: 'attempt', stateKey: id, slotKey: slot, proofKey: engine.proofs[id] ? id : null, revision: revisionText } : null;
      const before = v.pending.get(attemptKey);
      if (!!attempt !== !!before || (attempt && before && (before.slotKey !== attempt.slotKey || before.proofKey !== attempt.proofKey))) change(7, attemptKey, before ? V4.canonical(before) : undefined, attempt ? V4.canonical(attempt) : null, [{ tree: 2, key: id }, ...(slot ? [{ tree: 3, key: slot }] : [])]);
      const terminal = engine.terminal.get(id);
      const journal = terminal?.notFound ? { kind: 'journal-not-found', stateKey: id, journalId: 'commit-not-found:' + id, eventId: terminal.notFound.eventId, contentSha256: terminal.notFound.contentSha256, revision: revisionText } : null;
      const beforeJournal = v.pending.get(journalKey);
      if (!!journal !== !!beforeJournal || (journal && beforeJournal && hash({ ...beforeJournal, revision: null }) !== hash({ ...journal, revision: null }))) change(7, journalKey, beforeJournal ? V4.canonical(beforeJournal) : undefined, journal ? V4.canonical(journal) : null, [{ tree: 5, key: id }]);
    }
    for (const [key, value] of Object.entries(dbBindings)) change(8, key, v.trees[8].get(key), value === null ? null : V4.canonical(value), [{ tree: 3, key }]);
    const metaAfter: any = { ...v.meta };
    if (body.publishing) metaAfter.tail = body.tail;
    if (body.patch.retired) metaAfter.retired = { ...engine.head.retired };
    if (dbWitness !== undefined) metaAfter.dbWitness = dbWitness;
    for (const key of ['tail', 'retired', 'dbWitness'] as const) {
      const before = metaRaw(key, v.meta[key]), after = metaRaw(key, metaAfter[key]);
      if (before !== after) change(1, key, before, after, []);
    }
    changeArray.sort(treeKeyOrder);
    const changedDependencySha256 = V4.domainHash(V4.DOMAIN.changes, V4.canonical(changeArray));
    metaAfter.validator = { id: V4.V4_VALIDATOR_ID, sha256: v.validatorSha256, mode: 'incremental', predecessorRoot: v.rootSha256, changedDependencySha256 };
    let m1 = treeChanges.get(1); if (!m1) treeChanges.set(1, m1 = new Map());
    m1.set('validator', metaRaw('validator', metaAfter.validator));
    // New pages for every changed tree, then the root naming them.
    const trees: Record<number, V4.Tree> = { ...v.trees };
    for (const [tree, changes] of treeChanges) trees[tree] = v.trees[tree].apply(writer, changes);
    const changesText = V4.canonical(changeArray);
    const transition: V4.Transition = { previousRoot: v.rootSha256, kind: 'patch', changes: Buffer.byteLength(changesText) <= 32768 ? { inline: changeArray } : { overflow: V4.writeBlob(writer, 0, Buffer.from(changesText)) } };
    writer.flush();
    const descriptors = V4.TREE_IDS.map(id => ({ id, count: String(trees[id].count), ref: trees[id].root }));
    const root: V4.RootBody = { format: V4.V4_FORMAT, version: 4, layout: 1, validatorId: V4.V4_VALIDATOR_ID, validatorSha256: v.validatorSha256, revision: revisionText,
      generation: String(body.generation), lineageSha256: v.root.lineageSha256, trees: descriptors, stateTailSha256: hash(metaAfter.tail), transition, fullCheck: v.root.fullCheck };
    const nextRoot = V4.writeRoot(v.directory, root);
    const tailBefore = hash(v.meta.tail), tailAfter = hash(metaAfter.tail);
    const prepare = v.segment.append({ format: 'KIN-EMR-WAL', version: 4, segment: v.segment.segment, lsn: String(v.lsn + 1), previousSha256: v.previousSha256, type: 'prepare',
      previousRoot: v.rootSha256, nextRoot, transitionSha256: V4.domainHash(V4.DOMAIN.changes, V4.canonical(transition)), tailBefore, tailAfter });
    if (body.publishing) publishTail(engine.tailFile, body.tail);
    const complete = v.segment.append({ format: 'KIN-EMR-WAL', version: 4, segment: v.segment.segment, lsn: String(v.lsn + 2), previousSha256: prepare.sha256, type: 'complete', prepareLsn: String(v.lsn + 1), nextRoot });
    V4.writeSelector(engine.file, { format: V4.V4_FORMAT, version: 4, layout: 1, rootSha256: nextRoot, revision: revisionText, wal: { segment: v.segment.segment, offset: String(complete.end), lsn: String(v.lsn + 2), previousSha256: complete.sha256 } });
    // The transition is the accepted root: advance the view.
    v.rootSha256 = nextRoot; v.root = root; v.trees = trees; v.meta = metaAfter;
    for (const [key, raw] of treeChanges.get(7) ?? []) { if (raw === null) v.pending.delete(key); else v.pending.set(key, V4.parseCanonical(raw, 'pending')); }
    (engine.terminal as V4Map).committed(trees[5]); (engine.bundles as V4Map).committed(trees[6]);
    v.lsn += 2; v.previousSha256 = complete.sha256; v.walEnd = complete.end; v.segmentTransitions++;
    engine.checkpoint = { digest: nextRoot, bytes: 0, revision, publishing: false, navigable: true };
    engine.walOffset = complete.end;
    rotateV4(engine);
    engine.pin();
  } catch (error) {
    // Pages, a root or WAL bytes may have reached disk: the files are the only authority until a fresh admission.
    engine.tainted = true; revert();
    try { writer.close(); } catch { /* closing */ }
    throw translateV4(error);
  }
  writer.close();
}
/** Segment retirement: a new segment starts with `start` (its base root), the selector moves to it, the previous
 * segment is closed (retained until its transitions are absorbed by a later full check / GC accounting). */
function rotateV4(engine: Engine): void {
  const v = engine.v4!;
  const bytes = v.walEnd - v.segmentStart, age = Date.now() - v.segmentOpenedAt;
  if (bytes < V4_ROTATE_BYTES && v.segmentTransitions < V4_ROTATE_TRANSITIONS && age < V4_ROTATE_MS) return;
  if (v.segmentTransitions === 0) return;
  const previous = v.segment; previous.close();
  const next = V4.WalSegment.create(v.directory);
  const start = next.append({ format: 'KIN-EMR-WAL', version: 4, segment: next.segment, lsn: String(v.lsn + 1), previousSha256: v.previousSha256, type: 'start', baseRoot: v.rootSha256, previousSegment: { segment: previous.segment, finalSha256: v.previousSha256 } });
  syncDirectory(V4.walDirectory(v.directory));
  V4.writeSelector(engine.file, { format: V4.V4_FORMAT, version: 4, layout: 1, rootSha256: v.rootSha256, revision: v.root.revision, wal: { segment: next.segment, offset: String(start.end), lsn: String(v.lsn + 1), previousSha256: start.sha256 } });
  v.segment = next; v.lsn += 1; v.previousSha256 = start.sha256; v.walEnd = start.end; v.segmentStart = 0; v.segmentTransitions = 0; v.segmentOpenedAt = Date.now();
  engine.log = next.file; engine.walOffset = start.end;
}
/** The fully validated initial root of a pristine v4 pair (empty trees, initial witness, complete coverage). */
function initializeV4(engine: Engine, initialized: ExternalState): void {
  const v4 = v4Directory(engine.directory);
  try {
    for (const name of ['roots', 'pages', 'wal', 'quarantine', 'tmp']) fs.mkdirSync(path.join(v4, name), { recursive: true, mode: 0o700 });
    const lineageSha256 = V4.lineageSha256(initialized.lineage);
    const manifest = V4.loadValidatorManifest(appRoot());
    const store = new V4.PackStore(v4, lineageSha256);
    const writer = new V4.PackWriter(store, 1);
    const trees: Record<number, V4.Tree> = {};
    for (const id of V4.TREE_IDS) trees[id] = V4.Tree.empty(writer, id);
    const origin = initialized.lineage!.origin;
    const dbWitness = { version: 1, pair: origin, lineageSha256, validationRevision: '1',
      streams: Object.fromEntries((['viewing', 'history'] as const).map(s => [s, { chainId: origin.chains[s], verifiedThrough: { sequence: 0, hash: '0'.repeat(64) }, retainedStart: null, expiry: null }])) };
    const meta: any = { lineage: initialized.lineage, tail: initialized.tail, retired: initialized.retired, dbWitness, copyProvenance: null,
      validator: { id: V4.V4_VALIDATOR_ID, sha256: manifest.validatorSha256, mode: 'full', predecessorRoot: null, changedDependencySha256: null } };
    const partial = V4.TREE_IDS.map(id => ({ id, count: '0', ref: trees[id].root }));
    const fullCheck: V4.FullCheck = { checkedRoot: null, coverageSha256: coverageSha256(partial, meta), checkedRevision: '1', validatorSha256: manifest.validatorSha256,
      completedAt: new Date().toISOString(), dbWitnessSha256: V4.domainHash(V4.DOMAIN.witness, V4.canonical(dbWitness)) };
    meta.fullCheck = fullCheck;
    trees[1] = trees[1].apply(writer, new Map(V4_META_KEYS.map(k => [k, metaRaw(k, meta[k])] as [string, string])));
    writer.close();
    const descriptors = V4.TREE_IDS.map(id => ({ id, count: String(trees[id].count), ref: trees[id].root }));
    const root: V4.RootBody = { format: V4.V4_FORMAT, version: 4, layout: 1, validatorId: V4.V4_VALIDATOR_ID, validatorSha256: manifest.validatorSha256, revision: '1', generation: '1',
      lineageSha256, trees: descriptors, stateTailSha256: hash(initialized.tail), transition: { previousRoot: null, kind: 'initialize', changes: null }, fullCheck };
    const rootSha256 = V4.writeRoot(v4, root);
    const segment = V4.WalSegment.create(v4);
    const start = segment.append({ format: 'KIN-EMR-WAL', version: 4, segment: segment.segment, lsn: '1', previousSha256: V4.ZERO64, type: 'start', baseRoot: rootSha256, previousSegment: null });
    const prepare = segment.append({ format: 'KIN-EMR-WAL', version: 4, segment: segment.segment, lsn: '2', previousSha256: start.sha256, type: 'prepare', previousRoot: null, nextRoot: rootSha256, transitionSha256: V4.domainHash(V4.DOMAIN.changes, V4.canonical(root.transition)), tailBefore: null, tailAfter: hash(initialized.tail) });
    publishTail(engine.tailFile, initialized.tail);
    const complete = segment.append({ format: 'KIN-EMR-WAL', version: 4, segment: segment.segment, lsn: '3', previousSha256: prepare.sha256, type: 'complete', prepareLsn: '2', nextRoot: rootSha256 });
    segment.close(); syncDirectory(V4.walDirectory(v4));
    V4.writeSelector(engine.file, { format: V4.V4_FORMAT, version: 4, layout: 1, rootSha256, revision: '1', wal: { segment: segment.segment, offset: String(complete.end), lsn: '3', previousSha256: complete.sha256 } });
    store.close();
  } catch (error) { throw translateV4(error); }
}
/** Bounded reclamation of packs no longer reachable from the selected root (a cooperative slice; the current root,
 * selector root and every page of the open WAL segment's transitions stay pinned). Nothing is rewritten. */
function reclaimV4(engine: Engine, force: boolean): { unlinked: number; retained: number } {
  const v = engine.v4!;
  void force;
  const live = new Set<string>();
  for (const id of V4.TREE_IDS) for (const ref of v.trees[id].pages()) live.add(ref.pack);
  // The previous roots named by the open WAL segment's transitions keep their packs (replay dependencies).
  const read = V4.WalSegment.read(v.segment.file, 0);
  const pinnedRoots = new Set<string>();
  for (const item of read.records) { const r = item.record; if (r.type === 'start') pinnedRoots.add(r.baseRoot); else if (r.type === 'prepare') { if (r.previousRoot) pinnedRoots.add(r.previousRoot); pinnedRoots.add(r.nextRoot); } else pinnedRoots.add(r.nextRoot); }
  // A complete check in progress pins the root it is checking (its pages stay until the sweep ends).
  if (v.sweep) pinnedRoots.add(v.sweep.startedRoot);
  for (const sha of pinnedRoots) {
    if (sha === v.rootSha256) continue;
    let root: V4.RootBody; try { root = V4.readRoot(v.directory, sha); } catch { continue; }
    for (const d of root.trees) for (const ref of V4.Tree.open(v.store, d.id, d.ref, V4.parseDecimal(d.count, 'root')).pages()) live.add(ref.pack);
  }
  let unlinked = 0, retained = 0;
  for (const pack of v.store.listPacks()) {
    if (live.has(pack)) { retained++; continue; }
    const file = v.store.packFile(pack);
    // A pack the current writer may still append to is never a candidate (its last page could be referenced next).
    if (fs.statSync(file).size < V4.PACK_PAGES * V4.PAGE_BYTES && fs.statSync(file).mtimeMs > Date.now() - V4_ROTATE_MS) { retained++; continue; }
    fs.unlinkSync(file); unlinked++;
  }
  if (unlinked) { syncDirectory(v.store.pagesDirectory); v.store.invalidate(); }
  return { unlinked, retained };
}
function v4Status(engine: Engine, now?: string): any {
  const v = engine.v4!;
  // The complete check's age: measured from the last complete sweep; a clock behind that time (rollback) is not
  // a fresh check, it is reported overdue with its reason (no timestamp is ever reset by a partial sweep).
  const at = now !== undefined ? Date.parse(now) : Date.now();
  if (!Number.isFinite(at)) fail('SealCorrupt');
  const completedAt = Date.parse(v.root.fullCheck.completedAt), ageMs = at - completedAt;
  const reason = ageMs < 0 ? 'clock-rollback' : ageMs > V4_FULL_CHECK_MS ? 'age' : null;
  return { format: 4, rootSha256: v.rootSha256, revision: v.root.revision, trees: v.root.trees.map(t => ({ id: t.id, count: t.count })), pending: v.pending.size,
    wal: { segment: v.segment.segment, lsn: v.lsn, bytes: v.walEnd, transitions: v.segmentTransitions }, packs: v.store.listPacks().length,
    fullCheck: { ...v.root.fullCheck, ageMs, overdue: reason !== null, reason, periodMs: V4_FULL_CHECK_MS },
    sweep: v.sweep ? { startedRoot: v.sweep.startedRoot, startedAt: v.sweep.startedAt, phase: v.sweep.phase, tree: v.sweep.tree, keys: { ...v.sweep.keys }, pages: v.sweep.pages, db: v.sweep.db, dbDone: v.sweep.dbDone } : null,
    latched: v.latched, dbWitness: v.meta.dbWitness, cacheBytes: v.store.cachedBytes };
}
// ───────────────────────── periodic complete check (order section 2/4, V4-T10) ─────────────────────────
function loadSweep(v4: string): V4Sweep | null {
  const s = readScratch(sweepFile(v4));
  if (!s || !keys(s, ['startedRoot', 'startedAt', 'phase', 'tree', 'from', 'keys', 'pages', 'db', 'dbDone']) || !sha(s.startedRoot) ||
    !['storage', 'database'].includes(s.phase) || !integer(s.tree, 1) || s.tree > 9 || !(s.from === null || text(s.from)) || !isRecord(s.keys)) return null;
  try { V4.readRoot(v4, s.startedRoot); } catch { return null; }    // the pinned root is gone (never: GC keeps it) -> start over
  return s as V4Sweep;
}
function persistSweep(v: V4State): void { writeScratch(sweepFile(v.directory), v.sweep); }
/** Discovered corruption: persist the latch (the next admission refuses), taint the engine (every later operation
 * re-admits and refuses), and refuse this operation. */
function latchV4(engine: Engine, code: string, detail: string, phase: string, tree: number | null, from: string | null): never {
  const v = engine.v4!;
  const latch: V4Latch = { code, detail, at: new Date().toISOString(), root: v.rootSha256, phase, tree, from };
  try { writeScratch(latchFile(v.directory), latch); } catch { /* the in-memory latch still refuses */ }
  v.latched = latch; engine.tainted = true;
  throw Object.assign(new Error('SealCorrupt'), { code: 'SealCorrupt', detail: 'latched:' + detail, latch });
}
/** The semantic validation of one stored member of tree `id` (what the on-use path validates when it consults it). */
function checkMemberV4(engine: Engine, id: number, key: string, raw: string): void {
  const generation = engine.head.generation, origin = engine.head.lineage?.origin;
  switch (id) {
    case 1: if (!(V4_META_KEYS as readonly string[]).includes(key)) fail('SealCorrupt'); JSON.parse(raw); return;
    case 2: validateMapValue('intents', key, JSON.parse(raw), generation, origin); return;
    case 3: validateMapValue('slots', key, JSON.parse(raw), generation, origin); return;
    case 4: validateMapValue('proofs', key, JSON.parse(raw), generation, origin); return;
    case 5: validateMapValue('terminal', key, JSON.parse(raw), generation, origin); return;
    case 6: validateMapValue('bundles', key, JSON.parse(raw), generation, origin); return;
    case 7: {
      const value = V4.parseCanonical(raw, 'pending');
      if (key.startsWith('attempt:')) { if (!keys(value, ['kind', 'stateKey', 'slotKey', 'proofKey', 'revision']) || value.kind !== 'attempt' || key !== 'attempt:' + value.stateKey) fail('SealCorrupt'); }
      else if (key.startsWith('journal:')) { if (!keys(value, ['kind', 'stateKey', 'journalId', 'eventId', 'contentSha256', 'revision']) || value.kind !== 'journal-not-found' || key !== 'journal:' + value.stateKey) fail('SealCorrupt'); }
      else fail('SealCorrupt');
      return;
    }
    case 8: validDbBindingValue(key, V4.parseCanonical(raw, 'db-binding')); return;
    default: fail('SealCorrupt');
  }
}
/**
 * One bounded step of the complete check (`full-check`): the storage phase walks every tree of the pinned root in
 * digest order (every page verified on use, every member semantically validated, counts reconciled per tree), then the
 * database phase (driven by the seal, which verifies the DB rows against tree 8 and reports its cursor here), then
 * `complete` publishes the new fullCheck fact in a `scrub` transition. Any failure latches the owner at once. The cursor
 * is persisted after every step so an interrupted sweep resumes where it stopped, also across restarts.
 */
function fullCheckV4(engine: Engine, value: any): any {
  const v = engine.v4!;
  if (v.latched) throw Object.assign(new Error('SealCorrupt'), { code: 'SealCorrupt', detail: 'latched:' + v.latched.detail, latch: v.latched });
  const now = typeof value?.now === 'string' ? value.now : new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) fail('SealCorrupt');
  if (!v.sweep) {
    v.sweep = { startedRoot: v.rootSha256, startedAt: now, phase: 'storage', tree: 1, from: null, keys: {}, pages: 0, db: null, dbDone: false };
    persistSweep(v);
  }
  const sweep = v.sweep;
  const summary = () => ({ phase: sweep.phase, tree: sweep.tree, from: sweep.from, keys: { ...sweep.keys }, pages: sweep.pages, db: sweep.db, dbDone: sweep.dbDone, startedRoot: sweep.startedRoot, done: false });
  if (value?.db !== undefined) {
    // The seal's DB cursor (or its completion): recorded, never trusted as a storage result.
    if (sweep.phase !== 'database') fail('SealCorrupt');
    if (value.db === 'done') sweep.dbDone = true;
    else { if (!keys(value.db, ['stream', 'after']) || !['viewing', 'history'].includes(value.db.stream) || !integer(value.db.after, 0)) fail('SealCorrupt'); sweep.db = { stream: value.db.stream, after: value.db.after }; }
    persistSweep(v); return summary();
  }
  if (value?.latch !== undefined) {
    // The seal discovered a DB-side disagreement (a stored row that no longer matches its verified binding).
    latchV4(engine, 'SealCorrupt', String(value.latch), sweep.phase, null, null);
  }
  if (value?.complete === true) {
    if (sweep.phase !== 'database' || !sweep.dbDone) fail('SealCorrupt');
    const checked = V4.readRoot(v.directory, sweep.startedRoot);
    const checkedMeta = V4.Tree.open(v.store, 1, checked.trees[0].ref, V4.parseDecimal(checked.trees[0].count, 'root'));
    const meta: any = {}; for (const key of V4_META_KEYS) meta[key] = metaOf(checkedMeta, key);
    const fullCheck: V4.FullCheck = { checkedRoot: sweep.startedRoot, coverageSha256: coverageSha256(checked.trees, meta), checkedRevision: checked.revision,
      validatorSha256: v.validatorSha256, completedAt: now, dbWitnessSha256: V4.domainHash(V4.DOMAIN.witness, V4.canonical(v.meta.dbWitness)) };
    publishScrubV4(engine, fullCheck);
    v.sweep = null; try { fs.rmSync(sweepFile(v.directory), { force: true }); } catch { /* scratch */ }
    return { ...summary(), done: true, fullCheck };
  }
  if (sweep.phase !== 'storage') return summary();
  const budget = integer(value?.budget, 1) ? Math.min(value.budget, 4096) : V4_FULL_CHECK_STEP_LEAVES;
  const id = sweep.tree;
  try {
    const checked = V4.readRoot(v.directory, sweep.startedRoot);
    const descriptor = checked.trees[id - 1];
    const tree = V4.Tree.open(v.store, id, descriptor.ref, V4.parseDecimal(descriptor.count, 'root'));
    const result = tree.checkFrom(sweep.from, budget, (key, raw) => checkMemberV4(engine, id, key, raw));
    sweep.keys[String(id)] = (sweep.keys[String(id)] ?? 0) + result.keys; sweep.pages += result.pages;
    if (result.done) {
      if (sweep.keys[String(id)] !== tree.count) throw Object.assign(new Error('SealCorrupt'), { code: 'SealCorrupt', detail: 'tree:total' });
      sweep.tree = id + 1; sweep.from = null;
      if (sweep.tree > 8) { sweep.phase = 'database'; sweep.db = null; sweep.dbDone = false; }
    } else sweep.from = result.next;
  } catch (error: any) {
    const translated = translateV4(error);
    latchV4(engine, String(translated?.code ?? 'SealCorrupt'), String(translated?.detail ?? translated?.message ?? 'full-check'), 'storage', id, sweep.from);
  }
  persistSweep(v);
  return summary();
}
/** The fullCheck fact published as its own `scrub` transition (no state change; same revision; the ordinary barriers). */
function publishScrubV4(engine: Engine, fullCheck: V4.FullCheck): void {
  const v = engine.v4!;
  const writer = new V4.PackWriter(v.store, engine.head.revision);
  try {
    const metaAfter = { ...v.meta, fullCheck };
    const trees: Record<number, V4.Tree> = { ...v.trees };
    trees[1] = v.trees[1].apply(writer, new Map([['fullCheck', metaRaw('fullCheck', fullCheck)]]));
    writer.flush();
    const descriptors = V4.TREE_IDS.map(id => ({ id, count: String(trees[id].count), ref: trees[id].root }));
    const transition: V4.Transition = { previousRoot: v.rootSha256, kind: 'scrub', changes: { inline: [] } };
    const root: V4.RootBody = { ...v.root, trees: descriptors, transition, fullCheck };
    const nextRoot = V4.writeRoot(v.directory, root);
    const tailHash = hash(v.meta.tail);
    const prepare = v.segment.append({ format: 'KIN-EMR-WAL', version: 4, segment: v.segment.segment, lsn: String(v.lsn + 1), previousSha256: v.previousSha256, type: 'prepare',
      previousRoot: v.rootSha256, nextRoot, transitionSha256: V4.domainHash(V4.DOMAIN.changes, V4.canonical(transition)), tailBefore: tailHash, tailAfter: tailHash });
    const complete = v.segment.append({ format: 'KIN-EMR-WAL', version: 4, segment: v.segment.segment, lsn: String(v.lsn + 2), previousSha256: prepare.sha256, type: 'complete', prepareLsn: String(v.lsn + 1), nextRoot });
    V4.writeSelector(engine.file, { format: V4.V4_FORMAT, version: 4, layout: 1, rootSha256: nextRoot, revision: root.revision, wal: { segment: v.segment.segment, offset: String(complete.end), lsn: String(v.lsn + 2), previousSha256: complete.sha256 } });
    v.rootSha256 = nextRoot; v.root = root; v.trees = trees; v.meta = metaAfter;
    v.lsn += 2; v.previousSha256 = complete.sha256; v.walEnd = complete.end; v.segmentTransitions++;
    engine.checkpoint = { digest: nextRoot, bytes: 0, revision: engine.head.revision, publishing: false, navigable: true };
    engine.walOffset = complete.end;
    rotateV4(engine);
    engine.pin();
  } catch (error) {
    engine.tainted = true;
    try { writer.close(); } catch { /* closing */ }
    throw translateV4(error);
  }
  writer.close();
}
// ───────────────────────── first conversion v3 -> v4 and lossless export v4 -> v3 (order section 5) ─────────────────────────
export interface ConversionFacts {
  /** The DB witness the caller verified against the database (the pair, the sealed prefixes, the retained starts, the expiry anchors). */
  dbWitness: any;
  /** One verified fact per committed slot `<stream>:<sequence>`: the exact marker binding and the stored entry's digest. */
  dbBindings: Iterable<[string, { binding: CommitBinding; entrySha256: string | null }]>;
}
export interface ConversionReceipt {
  kind: 'import-v3' | 'export-v3'; completedAt: string; validatorSha256: string; lineageSha256: string;
  source: { directory: string; format: 3 | 4; revision: number; generation: number; identity: string; counts: Record<string, number> };
  target: { directory: string; format: 3 | 4; revision: number; identity: string; counts: Record<string, number>; bytes: number };
  verified: { members: number; trees?: Record<string, { keys: number; pages: number }> };
}
const newDirectory = (directory: string) => {
  const info = fs.statSync(directory, { throwIfNoEntry: false });
  if (info && (!info.isDirectory() || fs.readdirSync(directory).length)) fail('SealUnavailable');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
};
const copyTree = (from: string, to: string) => { if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true, errorOnExist: true }); };
/** Stream members sorted by routing digest (then full key) through a disposable spill sorter into a bulk-loaded tree. */
function bulkTree(writer: V4.PackWriter, id: number, scratch: string, members: Iterable<[string, string]>): V4.Tree {
  const sorter = new SpillSorter(scratch, 'tree-' + id);
  try {
    for (const [key, raw] of members) sorter.add(V4.routingDigest(id, key) + '\u0000' + key, raw);
    return V4.Tree.bulk(writer, id, (function* () { for (const item of sorter.iterate()) { const at = item.key.indexOf('\u0000'); yield [item.key.slice(0, at), item.key.slice(at + 1), item.value] as [string, string, string]; } })());
  } finally { sorter.close(); }
}
/** First conversion: a fully validated, quiesced v3 directory streamed into a separate v4 target root with the
 * caller-verified DB facts; the target is fully revalidated (every tree, every source member) before the receipt.
 * The source is never written. */
export function importV3ToV4(source: string, target: string, pair: PairIdentity | undefined, facts: ConversionFacts): ConversionReceipt {
  const engine = admitEngine(source, pair, false, 3);
  try {
    if (engine.pristine) fail('SealMissing');
    if (engine.publishing) fail('SealCorrupt');
    validDbWitness(facts.dbWitness);
    const lineage = engine.head.lineage!, lineageSha256 = V4.lineageSha256(lineage);
    if (!samePair(facts.dbWitness.pair, lineage.origin) || facts.dbWitness.lineageSha256 !== lineageSha256) fail('SealChainMismatch');
    newDirectory(target);
    const v4 = v4Directory(target);
    fs.mkdirSync(path.join(target, 'seal'), { mode: 0o700 });
    for (const name of ['roots', 'pages', 'wal', 'quarantine', 'tmp']) fs.mkdirSync(path.join(v4, name), { recursive: true, mode: 0o700 });
    copyTree(path.join(source, 'journal'), path.join(target, 'journal'));
    copyTree(path.join(source, 'expiry-evidence'), path.join(target, 'expiry-evidence'));
    const manifest = V4.loadValidatorManifest(appRoot());
    const revision = engine.head.revision, revisionText = String(revision);
    const store = new V4.PackStore(v4, lineageSha256), writer = new V4.PackWriter(store, revision), scratch = path.join(v4, 'tmp');
    const trees: Record<number, V4.Tree> = {};
    const small = (map: Record<string, any>): [string, string][] => Object.keys(map).sort().map(k => [k, JSON.stringify(map[k])]);
    trees[2] = bulkTree(writer, 2, scratch, small(engine.intents));
    trees[3] = bulkTree(writer, 3, scratch, small(engine.slots));
    trees[4] = bulkTree(writer, 4, scratch, small(engine.proofs));
    trees[5] = bulkTree(writer, 5, scratch, (function* () { for (const [k, raw] of engine.terminal.rawEntries()) yield [k, typeof raw === 'string' ? raw : raw.toString('utf8')] as [string, string]; })());
    trees[6] = bulkTree(writer, 6, scratch, (function* () { for (const [k, raw] of engine.bundles.rawEntries()) yield [k, typeof raw === 'string' ? raw : raw.toString('utf8')] as [string, string]; })());
    const pending: [string, string][] = [];
    for (const id of Object.keys(engine.intents)) {
      const slotKey = engine.slotOf.get(id); if (!slotKey) fail('UnsealedEntryUnexplained');
      pending.push(['attempt:' + id, V4.canonical({ kind: 'attempt', stateKey: id, slotKey, proofKey: engine.proofs[id] ? id : null, revision: revisionText })]);
    }
    for (const id of engine.notFound) {
      const terminal = engine.terminal.get(id); if (!terminal?.notFound) fail('UnsealedEntryUnexplained');
      pending.push(['journal:' + id, V4.canonical({ kind: 'journal-not-found', stateKey: id, journalId: 'commit-not-found:' + id, eventId: terminal.notFound.eventId, contentSha256: terminal.notFound.contentSha256, revision: revisionText })]);
    }
    trees[7] = bulkTree(writer, 7, scratch, pending);
    trees[8] = bulkTree(writer, 8, scratch, (function* () { for (const [key, value] of facts.dbBindings) { validDbBindingValue(key, value); yield [key, V4.canonical(value)] as [string, string]; } })());
    const meta: any = { lineage, tail: engine.head.tail, retired: engine.head.retired, dbWitness: facts.dbWitness, copyProvenance: null,
      validator: { id: V4.V4_VALIDATOR_ID, sha256: manifest.validatorSha256, mode: 'full', predecessorRoot: null, changedDependencySha256: null } };
    const partial = V4.TREE_IDS.map(id => ({ id, count: id === 1 ? '0' : String(trees[id].count), ref: id === 1 ? trees[2].root : trees[id].root }));
    const fullCheck: V4.FullCheck = { checkedRoot: null, coverageSha256: coverageSha256(partial, meta), checkedRevision: revisionText, validatorSha256: manifest.validatorSha256,
      completedAt: new Date().toISOString(), dbWitnessSha256: V4.domainHash(V4.DOMAIN.witness, V4.canonical(facts.dbWitness)) };
    meta.fullCheck = fullCheck;
    trees[1] = bulkTree(writer, 1, scratch, V4_META_KEYS.map(k => [k, metaRaw(k, meta[k])] as [string, string]));
    writer.close();
    const descriptors = V4.TREE_IDS.map(id => ({ id, count: String(trees[id].count), ref: trees[id].root }));
    const root: V4.RootBody = { format: V4.V4_FORMAT, version: 4, layout: 1, validatorId: V4.V4_VALIDATOR_ID, validatorSha256: manifest.validatorSha256, revision: revisionText,
      generation: String(engine.head.generation), lineageSha256, trees: descriptors, stateTailSha256: hash(engine.head.tail), transition: { previousRoot: null, kind: 'import-v3', changes: null }, fullCheck };
    const rootSha256 = V4.writeRoot(v4, root);
    const segment = V4.WalSegment.create(v4);
    const start = segment.append({ format: 'KIN-EMR-WAL', version: 4, segment: segment.segment, lsn: '1', previousSha256: V4.ZERO64, type: 'start', baseRoot: rootSha256, previousSegment: null });
    const prepare = segment.append({ format: 'KIN-EMR-WAL', version: 4, segment: segment.segment, lsn: '2', previousSha256: start.sha256, type: 'prepare', previousRoot: null, nextRoot: rootSha256, transitionSha256: V4.domainHash(V4.DOMAIN.changes, V4.canonical(root.transition)), tailBefore: null, tailAfter: hash(engine.head.tail) });
    V4.writeAtomic(path.join(target, 'seal', 'tail.json'), JSON.stringify(engine.head.tail));
    const complete = segment.append({ format: 'KIN-EMR-WAL', version: 4, segment: segment.segment, lsn: '3', previousSha256: prepare.sha256, type: 'complete', prepareLsn: '2', nextRoot: rootSha256 });
    segment.close(); syncDirectory(V4.walDirectory(v4));
    V4.writeSelector(path.join(target, 'seal', 'settlement.json'), { format: V4.V4_FORMAT, version: 4, layout: 1, rootSha256, revision: revisionText, wal: { segment: segment.segment, offset: String(complete.end), lsn: '3', previousSha256: complete.sha256 } });
    store.close();
    // Full revalidation of the produced target against the source: every tree, every member, every count.
    const produced = admitEngine(target, pair, false, 4);
    try {
      const checked: Record<string, { keys: number; pages: number }> = {};
      for (const id of V4.TREE_IDS) checked[String(id)] = produced.v4!.trees[id].check();
      let members = 0;
      const same = (a: string, b: string | undefined) => b !== undefined && hash(JSON.parse(a)) === hash(JSON.parse(b));
      for (const [map, id] of [['intents', 2], ['slots', 3], ['proofs', 4]] as const) for (const [k, raw] of small((engine as any)[map])) { if (!same(raw, produced.v4!.trees[id].get(k))) fail('SealCorrupt'); members++; }
      for (const [k, raw] of engine.terminal.rawEntries()) { if (!same(typeof raw === 'string' ? raw : raw.toString('utf8'), produced.v4!.trees[5].get(k))) fail('SealCorrupt'); members++; }
      for (const [k, raw] of engine.bundles.rawEntries()) { if (!same(typeof raw === 'string' ? raw : raw.toString('utf8'), produced.v4!.trees[6].get(k))) fail('SealCorrupt'); members++; }
      if (produced.v4!.trees[5].count !== engine.terminal.count || produced.v4!.trees[6].count !== engine.bundles.count || produced.v4!.trees[7].count !== pending.length) fail('SealCorrupt');
      if (produced.head.revision !== revision || produced.head.generation !== engine.head.generation || hash(produced.head.tail) !== hash(engine.head.tail)) fail('SealCorrupt');
      const bytes = fs.readdirSync(store.pagesDirectory).reduce((n, f) => n + fs.statSync(path.join(store.pagesDirectory, f)).size, 0);
      return { kind: 'import-v3', completedAt: fullCheck.completedAt, validatorSha256: manifest.validatorSha256, lineageSha256,
        source: { directory: source, format: 3, revision, generation: engine.head.generation, identity: engine.checkpoint!.digest, counts: { terminal: engine.terminal.count, bundles: engine.bundles.count, intents: Object.keys(engine.intents).length, slots: Object.keys(engine.slots).length, proofs: Object.keys(engine.proofs).length } },
        target: { directory: target, format: 4, revision, identity: rootSha256, counts: Object.fromEntries(descriptors.map(d => [String(d.id), Number(d.count)])), bytes },
        verified: { members, trees: checked } };
    } finally { produced.close(); }
  } catch (error) { throw translateV4(error); } finally { engine.close(); }
}
/** Lossless export of a v4 root's current logical state into a NEW v3 target (navigable checkpoint, tail, empty WAL),
 * verified with the unchanged v3 reader member by member before the receipt. The v4 source is never written. */
export function exportV4ToV3(source: string, target: string, pair?: PairIdentity): ConversionReceipt {
  const engine = admitEngine(source, pair, false, 4);
  try {
    if (engine.pristine) fail('SealMissing');
    newDirectory(target);
    fs.mkdirSync(path.join(target, 'seal'), { mode: 0o700 });
    copyTree(path.join(source, 'journal'), path.join(target, 'journal'));
    copyTree(path.join(source, 'expiry-evidence'), path.join(target, 'expiry-evidence'));
    const v = engine.v4!;
    const head = { version: 3 as const, revision: engine.head.revision, generation: engine.head.generation, tail: engine.head.tail, lineage: engine.head.lineage,
      retired: engine.head.retired, intents: engine.intents, slots: engine.slots, proofs: engine.proofs };
    // The sort scratch lives beside the target (a protected directory holds only regular files under seal/) and is
    // gone before the produced copy is admitted.
    const scratch = fs.mkdtempSync(target + '.export-');
    const sorted = (id: 5 | 6) => { const s = new SpillSorter(scratch, 'export-' + id); for (const [k, raw] of v.trees[id].entries()) s.add(k, raw); return s; };
    const sorters = { terminal: sorted(5), bundles: sorted(6) };
    let written: { digest: string; bytes: number };
    try {
      const file = path.join(target, 'seal', 'settlement.json');
      written = writeNavigableCheckpoint(file, head, map => (function* () { for (const item of sorters[map].iterate()) yield [item.key, item.value] as [string, string]; })(), false);
    } finally { sorters.terminal.close(); sorters.bundles.close(); try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* disposable */ } }
    {
      V4.writeAtomic(path.join(target, 'seal', 'tail.json'), JSON.stringify(engine.head.tail));
      const fd = fs.openSync(path.join(target, 'seal', 'settlement.jsonl'), 'wx', 0o600); try { fs.fdatasyncSync(fd); } finally { fs.closeSync(fd); }
      syncDirectory(path.join(target, 'seal'));
      const produced = admitEngine(target, pair, false, 3);
      try {
        let members = 0;
        const same = (a: string, b: any) => b !== undefined && hash(JSON.parse(a)) === hash(b);
        for (const id of [2, 3, 4] as const) for (const [k, raw] of v.trees[id].entries()) { if (!same(raw, (produced as any)[({ 2: 'intents', 3: 'slots', 4: 'proofs' })[id]][k])) fail('SealCorrupt'); members++; }
        for (const [k, raw] of v.trees[5].entries()) { if (!same(raw, produced.terminal.get(k))) fail('SealCorrupt'); members++; }
        for (const [k, raw] of v.trees[6].entries()) { if (!same(raw, produced.bundles.get(k))) fail('SealCorrupt'); members++; }
        if (produced.terminal.count !== v.trees[5].count || produced.bundles.count !== v.trees[6].count || produced.head.revision !== engine.head.revision || hash(produced.head.tail) !== hash(engine.head.tail)) fail('SealCorrupt');
        return { kind: 'export-v3', completedAt: new Date().toISOString(), validatorSha256: v.validatorSha256, lineageSha256: v.root.lineageSha256,
          source: { directory: source, format: 4, revision: engine.head.revision, generation: engine.head.generation, identity: v.rootSha256, counts: Object.fromEntries(v.root.trees.map(d => [String(d.id), Number(d.count)])) },
          target: { directory: target, format: 3, revision: engine.head.revision, identity: written.digest, counts: { terminal: produced.terminal.count, bundles: produced.bundles.count, intents: Object.keys(produced.intents).length, slots: Object.keys(produced.slots).length, proofs: Object.keys(produced.proofs).length }, bytes: written.bytes },
          verified: { members } };
      } finally { produced.close(); }
    }
  } catch (error) { throw translateV4(error); } finally { engine.close(); }
}
/** Called only by the lock-owning writer. Tests substitute OS/FS transport, not state transitions. */
export function executeExternal(request: WriterRequest): any {
  const { directory, operation, value } = request, context = request.context ?? {};
  // Admission once per owner incarnation; afterwards only the pinned identities are checked before each operation.
  const admission = operation === 'admit-pair' ? pairAdmission(value) : null;
  let engine = context.engine;
  if (engine && !engine.unchanged()) { engine.close(); engine = context.engine = undefined; }
  if (!engine) engine = context.engine = admitEngine(directory, admission ? admission.copy?.source ?? admission.pair : context.pair, true, context.format ?? 3);
  try {
    const file = engine.file, tailFile = engine.tailFile, log = engine.log;
    if (operation === 'admit-pair') {
      const origin = admission!.copy ? admission!.copy.source : admission!.pair;
      if (admission!.copy && engine.pristine) return fail('SealMissing');
      if (!engine.pristine && !samePair(engine.head.lineage!.origin, origin)) return fail('SealChainMismatch');
      context.pair = clone(origin);
      context.copy = admission!.copy;
      return;
    }
    if (operation.startsWith('journal-')) {
      // The facade may be assembled before initialization, but no journal file or
      // directory is opened until the fenced initialization publishes a checkpoint.
      if (engine.pristine) {
        if (operation === 'journal-load') return { records: [], tornBytes: 0 };
        return fail('SealMissing');
      }
      // The one admitted physical journal: its ID index and loaded offset serve every record/find (no state replay here).
      const journal = context.journal ??= new JournalFile(directory);
      journal.refresh();
      if (operation === 'journal-load') return { records: journal.all(), tornBytes: journal.tornBytes };
      if (operation === 'journal-record') return journal.record(value.id, value.kind, value.body, value.at);
      if (operation === 'journal-find') return journal.find(value);
      return fail('SealCorrupt');
    }
    if (engine.pristine) {
      if (operation === 'read') return engine.materialize();
      if (operation === 'view') return engine.view();
      if (operation !== 'initialize') return fail('SealMissing');
      const initialized: ExternalState = value;
      validate(initialized);
      if (!initialized.lineage || initialized.revision !== 1 || initialized.generation !== 1 ||
        maps.some(n => n !== 'retired' && Object.keys(initialized[n]).length) ||
        ['viewing', 'history'].some(s => initialized.tail.streams[s].sequence !== 0 ||
          initialized.tail.streams[s].hash !== '0'.repeat(64))) return fail('SealCorrupt');
      // The caller holds the exclusive DB fence and has checked both empty chains.
      // Initialization is itself a recoverable tail publication, never an empty-map upgrade.
      protectedDirectory(directory, 'seal');
      if (engine.format === 4) { initializeV4(engine, initialized); engine.close(); context.engine = undefined; return; }
      atomic(file, { state: initialized, publishing: true, digest: hash(initialized) });
      publishTail(tailFile, initialized.tail);
      atomic(file, { state: initialized, publishing: false, digest: hash(initialized) });
      engine.close(); context.engine = undefined;
      return;
    }
    if (operation === 'initialize') return fail('SealCorrupt');
    if (engine.publishing) {
      // The complete durable frontier authorizes only its own in-flight tail publication.
      publishTail(tailFile, engine.head.tail);
      engine.walOffset += append(log, { version: 3, revision: engine.head.revision, published: true }, context);
      engine.publishing = false; engine.pin();
    }
    switch (operation) {
      case 'compact': if (engine.format === 4) { reclaimV4(engine, value?.force === true); return; } if (value?.force === true || compactionDue(engine)) compactEngine(engine, context); return;
      case 'read': return engine.materialize();
      case 'view': return engine.view();
      case 'get': return engine.lookup(value.map, value.id) ?? null;
      case 'slot-of': return engine.slotOf.get(value) ?? null;
      case 'not-found': return [...engine.notFound].map(id => [id, engine.terminal.get(id)?.notFound ?? null]).filter(([, v]) => v);
      case 'v4-status': return engine.format === 4 ? v4Status(engine, value?.now) : null;
      case 'pending': return engine.format === 4 ? [...engine.v4!.pending.entries()].map(([k, v]) => [k, clone(v)]) : null;
      case 'full-check': if (engine.format !== 4) fail('SealUnsupportedFormat'); return fullCheckV4(engine, value);
      case 'db-binding': { if (engine.format !== 4) fail('SealUnsupportedFormat'); const raw = engine.v4!.trees[8].get(String(value)); return raw === undefined ? null : V4.parseCanonical(raw, 'db-binding'); }
      case 'patch': {
        // An explicit patch: only the changed records (null deletes), the next revision, the generation the caller
        // claims, and optionally the new tail (a publication). A v4 owner also takes the verified DB facts
        // (`dbBindings`, `dbWitness`) that belong to the same transition.
        const changes = value.changes ?? {};
        const admitted = engine.format === 4 ? [...maps, 'dbBindings', 'dbWitness'] : [...maps];
        if (!isRecord(changes) || Object.keys(changes).some(n => !admitted.includes(n) || (n === 'dbWitness' ? !isRecord(changes[n]) : !isRecord(changes[n])))) return fail('SealCorrupt');
        const generation = value.generation ?? engine.head.generation;
        const publishing = value.tail !== undefined && value.tail !== null;
        const body: any = { version: 3, revision: engine.head.revision + 1, generation, patch: changes, publishing, ...(publishing ? { tail: value.tail } : {}) };
        commitRecord(engine, context, body, value.kind === 'reserve' ? 'reserve' : 'update');
        if (engine.format !== 4 && publishing && compactionDue(engine)) compactEngine(engine, context);
        return { changed: true, revision: engine.head.revision, generation: engine.head.generation };
      }
      case 'update': case 'reserve': case 'compare-and-set': {
        // Whole-state operations (materialized: inspectors, tests and the compatibility path), validated in full.
        const prior = engine.materialize();
        if (operation === 'compare-and-set' && value.before !== prior.revision) return { changed: false };
        const state: ExternalState = operation === 'compare-and-set' ? clone(value.state) : clone(prior);
        const result = operation === 'compare-and-set' ? undefined : value(state);
        if (operation !== 'compare-and-set') {
          if (hash(state) === hash(prior)) return { changed: false, result: clone(result) };
          state.revision++;
        }
        validate(state);
        if (state.version !== 3 || state.revision !== prior.revision + 1 || state.generation < prior.generation ||
          !sameLegacy(state.lineage, prior.lineage)) return fail('SealCorrupt');
        for (const id of Object.keys(prior.bundles)) {
          if (!state.bundles[id] || !sameLegacy(attestedProof(prior, id.slice(7)), attestedProof(state, id.slice(7))) ||
            prior.bundles[id].phase === 'acknowledged' && state.bundles[id].phase !== 'acknowledged') return fail('SealCorrupt');
        }
        const body = delta(prior, state);
        const reserveKind = operation === 'reserve' || operation === 'compare-and-set' && value.operation === 'reserve';
        commitRecord(engine, context, body, reserveKind ? 'reserve' : 'update');
        if (engine.format !== 4 && body.publishing && compactionDue(engine)) compactEngine(engine, context);
        return { changed: true, result: clone(result) };
      }
      default: return fail('SealCorrupt');
    }
  } catch (error) {
    // A failed write may have reached disk; a tainted view is re-admitted from the files on the next use.
    if (context.engine && context.engine.tainted) { context.engine.close(); context.engine = undefined; }
    throw error;
  }
}
