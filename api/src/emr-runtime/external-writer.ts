import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { FailureJournal as JournalFile, protectedDirectory, syncDirectory } from './journal-file';
import type { WriterRequest } from './coordinator';
import type { CommitBinding, ExpiryCore } from './seal';
import type { PairIdentity, SealedBundleProof } from './state-protocol';
import { parseCommitBinding, parseSealedBundleProof } from './state-protocol';

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
interface Cached { base: string; offset: number; envelope: Envelope }
export interface WriterContext { pair?: PairIdentity; copy?: CopyMapping | null; tailFile?: { file: string; ino: number; fd: number }; checkpoint?: { stamp: string; envelope: Envelope }; journal?: JournalFile; settlement?: Cached; log?: { file: string; ino: number; fd: number } }
function readTail(file: string, context: WriterContext): any {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info) return null;
  if (!context.tailFile || context.tailFile.file !== file || context.tailFile.ino !== info.ino) {
    if (context.tailFile) fs.closeSync(context.tailFile.fd);
    context.tailFile = { file, ino: info.ino, fd: fs.openSync(file, 'r') };
  }
  const bytes = Buffer.alloc(info.size);
  let read = 0;
  while (read < bytes.length) {
    const count = fs.readSync(context.tailFile.fd, bytes, read, bytes.length - read, read);
    if (!count) return fail('SealCorrupt');
    read += count;
  }
  try { return JSON.parse(bytes.toString('utf8')); } catch { return fail('SealCorrupt'); }
}
function checkpoint(file: string, context: WriterContext): Envelope | null {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info) { context.checkpoint = undefined; return null; }
  // The checkpoint is immutable between atomic compactions. Other writers change
  // its inode or change time; only WAL suffixes are read on ordinary reservations.
  // Tail is deliberately read afresh below to detect its independent rollback.
  const stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  if (context.checkpoint?.stamp !== stamp) context.checkpoint = { stamp, envelope: load(file) };
  return clone(context.checkpoint.envelope);
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
function replay(file: string, cached: Cached, baseRevision: number, repair = true): void {
  const size = fs.lstatSync(file, { throwIfNoEntry: false })?.size ?? 0;
  if (size < cached.offset) return fail('SealCorrupt');
  if (size === cached.offset) return;
  const raw = Buffer.alloc(size - cached.offset), fd = fs.openSync(file, 'r');
  try {
    let read = 0;
    while (read < raw.length) {
      const n = fs.readSync(fd, raw, read, raw.length - read, cached.offset + read);
      if (!n) return fail('SealCorrupt');
      read += n;
    }
  } finally { fs.closeSync(fd); }
  const good = raw.lastIndexOf(10) + 1, envelope = cached.envelope;
  for (const line of raw.subarray(0, good).toString('utf8').split('\n').slice(0, -1)) {
    let record: any;
    try { record = JSON.parse(line); } catch { return fail('SealCorrupt'); }
    if (!isRecord(record)) return fail('SealCorrupt');
    const { digest, ...body } = record;
    if (hash(body) !== digest) return fail('SealCorrupt');
    if (body.version !== 3) return fail('SealUnsupportedFormat');
    if (body.published) {
      if (!keys(body, ['version', 'revision', 'published']) || body.published !== true ||
        !integer(body.revision, 1)) return fail('SealCorrupt');
      if (body.revision <= baseRevision) continue;
      if (body.revision !== envelope.state.revision || !envelope.publishing) return fail('SealCorrupt');
      envelope.publishing = false;
      continue;
    }
    if (!keys(body, body.publishing ? ['version', 'revision', 'generation', 'patch', 'publishing', 'tail'] :
      ['version', 'revision', 'generation', 'patch', 'publishing']) ||
      typeof body.publishing !== 'boolean' || !isRecord(body.patch) ||
      Object.keys(body.patch).some(n => !maps.includes(n as any) || !isRecord(body.patch[n])) ||
      !integer(body.revision, 1) || !integer(body.generation, 1)) return fail('SealCorrupt');
    for (const name of maps) for (const [id, value] of Object.entries(body.patch[name] ?? {})) {
      validateMapKey(name, id);
      if (value !== null) validateMapValue(name, id, value, body.generation, envelope.state.lineage.origin);
    }
    if (body.revision <= baseRevision && body.generation > envelope.state.generation) return fail('SealCorrupt');
    if (body.publishing) validateTail(body.tail, body.generation, envelope.state.lineage.origin);
    if (body.revision <= baseRevision) continue;
    const state = envelope.state;
    if (body.revision !== state.revision + 1 || body.generation < state.generation || envelope.publishing) return fail('SealCorrupt');
    state.revision = body.revision; state.generation = body.generation;
    for (const name of maps) for (const [id, v] of Object.entries(body.patch[name] ?? {})) {
      if (['__proto__', 'constructor', 'prototype'].includes(id)) return fail('SealCorrupt');
      if (v === null) delete state[name][id]; else state[name][id] = v;
    }
    if (body.publishing) state.tail = body.tail;
    validate(state);
    envelope.publishing = body.publishing;
  }
  cached.offset += good;
  if (good < raw.length && repair) {
    // A partial final write was never acknowledged. Preserve its bytes before
    // shortening the log; complete records remain recovery authority.
    const evidence = path.join(path.dirname(file), 'torn-settlement-' + hash(raw.toString('hex')) + '.json');
    if (!fs.existsSync(evidence)) atomic(evidence, { bytes: raw.subarray(good).toString('hex') });
    const fd = fs.openSync(file, 'r+');
    try { fs.ftruncateSync(fd, cached.offset); fs.fdatasyncSync(fd); } finally { fs.closeSync(fd); }
  }
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
    const terminalIndex = new RegionIndex(fd, regions.terminal);
    const lookup = (id: string): any => { const raw = terminalIndex.find(id); return raw ? parseRaw(raw) : undefined; };
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
  members: (map: 'terminal' | 'bundles') => Iterable<[string, string]>, publishing: boolean): { digest: string; bytes: number } {
  const temporary = path.join(path.dirname(file), '.tmp-' + randomBytes(12).toString('hex'));
  const fd = fs.openSync(temporary, 'wx', 0o600);
  const digest = createHash('sha256');
  let bytes = 0, buffer = '';
  const write = (text: string, hashed: boolean) => { buffer += text; if (hashed) digest.update(text.replaceAll('\n', '')); if (buffer.length > 1 << 20) { bytes += Buffer.byteLength(buffer); fs.writeSync(fd, buffer); buffer = ''; } };
  try {
    write('{"state":', false);
    const headText = JSON.stringify({ version: head.version, revision: head.revision, generation: head.generation, tail: head.tail, lineage: head.lineage,
      retired: head.retired, intents: head.intents, slots: head.slots, proofs: head.proofs });
    write(headText.slice(0, -1), true);
    for (const map of ['terminal', 'bundles'] as const) {
      write(',' + JSON.stringify(map) + ':{', true);
      let firstMember = true, previous: string | null = null;
      for (const [key, value] of members(map)) {
        if (previous !== null && !(key > previous)) fail('SealCorrupt');
        previous = key;
        write((firstMember ? '\n' : ',\n') + JSON.stringify(key) + ':' + value, true);
        firstMember = false;
      }
      write((firstMember ? '' : '\n') + '}', true);
    }
    write('}', true);
    const hex = digest.digest('hex');
    write(',"publishing":' + String(publishing) + ',"digest":"' + hex + '"}', false);
    if (buffer) { bytes += Buffer.byteLength(buffer); fs.writeSync(fd, buffer); buffer = ''; }
    fs.fsyncSync(fd); fs.closeSync(fd);
    fs.renameSync(temporary, file); syncDirectory(path.dirname(file));
    return { digest: hex, bytes };
  } catch (error) { try { fs.closeSync(fd); } catch { /* closed */ } try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ } throw error; }
}

/** Read-only admission, also usable by a trusted inspector on a read-only copy.
 * Never instantiate the physical journal here: its constructor repairs torn bytes.
 * The caller repeats this check under the lifetime fence before opening any writer. */
export function inspectExternal(directory: string, pair?: PairIdentity): { state: ExternalState | null; fingerprint: string } {
  if (!directory || !path.isAbsolute(directory) || directory.includes('\0')) return fail('SealUnavailable');
  const root = path.resolve(directory), info = fs.lstatSync(root, { throwIfNoEntry: false });
  const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!info?.isDirectory() || info.isSymbolicLink() || !samePath(fs.realpathSync.native(root), root)) return fail('SealUnavailable');
  const inventory: unknown[] = [[info.dev, info.ino, info.uid, info.gid, info.mode]];
  for (const entry of fs.readdirSync(root).sort()) {
    if (entry === 'writer.lock') continue;
    if (!['seal', 'journal', 'expiry-evidence'].includes(entry)) return fail('SealUnsupportedFormat');
    const child = path.join(root, entry), childInfo = fs.lstatSync(child);
    if (!childInfo.isDirectory() || childInfo.isSymbolicLink() || process.platform === 'linux' &&
      (childInfo.uid !== info.uid || (childInfo.mode & 0o077) !== 0)) return fail('SealUnavailable');
    inventory.push([entry, childInfo.dev, childInfo.ino, childInfo.uid, childInfo.gid, childInfo.mode]);
    for (const name of fs.readdirSync(child).sort()) {
      const file = path.join(child, name), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return fail('SealUnavailable');
      inventory.push([entry, name, stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]);
    }
  }
  const file = path.join(root, 'seal', 'settlement.json'), log = path.join(root, 'seal', 'settlement.jsonl');
  const source: Envelope = load(file);
  if (!source) {
    if (['seal', 'journal', 'expiry-evidence'].some(child => fs.existsSync(path.join(root, child)) &&
      fs.readdirSync(path.join(root, child)).length)) return fail('SealMissing');
    return { state: null, fingerprint: hash(inventory) };
  }
  if (source.state?.version !== 3) return fail('SealUnsupportedFormat');
  if (!keys(source, ['state', 'publishing', 'digest']) || typeof source.publishing !== 'boolean' ||
    source.digest !== hash(source.state)) return fail('SealCorrupt');
  validate(source.state);
  if (!source.state.lineage) return fail('SealMissing');
  if (pair && !samePair(source.state.lineage.origin, pair)) return fail('SealChainMismatch');
  const replayed = { base: source.digest, offset: 0, envelope: clone(source) };
  replay(log, replayed, source.state.revision, false);
  // Pending publication is the only authority for a torn/missing tail. Complete
  // incompatible WAL records must be rejected even when that repair is pending.
  if (!source.publishing && !replayed.envelope.publishing) {
    const tail = load(path.join(root, 'seal', 'tail.json'));
    if (!tail) return fail('SealMissing');
    if (hash(tail) !== hash(replayed.envelope.state.tail)) return fail('SealTailMismatch');
  }
  return { state: replayed.envelope.state, fingerprint: hash([inventory, source, replayed]) };
}
/** Called only by the lock-owning writer. Tests substitute OS/FS transport, not state transitions. */
export function executeExternal(request: WriterRequest): any {
  const { directory, operation, value } = request, context = request.context ?? {};
  try {
  const file = path.join(directory, 'seal', 'settlement.json'), tailFile = path.join(directory, 'seal', 'tail.json');
  const log = path.join(directory, 'seal', 'settlement.jsonl');
  // A private copy is inspected against its stored origin (the mapping's source), never against the target.
  const admission = operation === 'admit-pair' ? pairAdmission(value) : null;
  inspectExternal(directory, admission ? admission.copy?.source ?? admission.pair : context.pair);
  // Version admission precedes even journal-tail repair. Unsupported sources remain
  // available to offline capture, but never become writable merely because maps are empty.
  const source = checkpoint(file, context);
  if (source) {
    if (source.state?.version !== 3) return fail('SealUnsupportedFormat');
    if (!keys(source, ['state', 'publishing', 'digest']) || typeof source.publishing !== 'boolean' ||
      source.digest !== hash(source.state)) return fail('SealCorrupt');
    validate(source.state);
  } else {
    const hasFiles = (child: string) => fs.existsSync(path.join(directory, child)) &&
      fs.readdirSync(path.join(directory, child)).length !== 0;
    if (hasFiles('seal') || hasFiles('journal') || hasFiles('expiry-evidence')) return fail('SealMissing');
  }
  if (operation === 'admit-pair') {
    const origin = admission.copy ? admission.copy.source : admission.pair;
    // A copy mapping needs a stored lineage to map from; a pristine pair has none and takes no mapping.
    if (admission.copy && !source) return fail('SealMissing');
    if (source && !samePair(source.state.lineage?.origin, origin)) return fail('SealChainMismatch');
    if (source) replay(log, { base: source.digest, offset: 0, envelope: clone(source) }, source.state.revision, false);
    context.pair = clone(origin);
    context.copy = admission.copy;
    return;
  }
  if (operation.startsWith('journal-')) {
    // The facade may be assembled before initialization, but no journal file or
    // directory is opened until the fenced initialization publishes a checkpoint.
    if (!source) {
      if (operation === 'journal-load') return { records: [], tornBytes: 0 };
      return fail('SealMissing');
    }
    if (source) replay(log, { base: source.digest, offset: 0, envelope: clone(source) }, source.state.revision, false);
    const journal = context.journal ??= new JournalFile(directory);
    journal.refresh();
    if (operation === 'journal-load') return { records: journal.all(), tornBytes: journal.tornBytes };
    if (operation === 'journal-record') return journal.record(value.id, value.kind, value.body, value.at);
    if (operation === 'journal-find') return journal.find(value);
    return fail('SealCorrupt');
  }
  let envelope = source, tail: any, tailCorrupt = false;
  try { tail = readTail(tailFile, context); } catch { tailCorrupt = true; }
  if (!envelope) {
    if (tailCorrupt) return fail('SealCorrupt');
    const state: ExternalState = { version: 3, revision: 0, generation: 0, tail: null, lineage: null, bundles: {}, intents: {}, slots: {}, proofs: {},
      terminal: {}, retired: { viewing: 0, history: 0 } };
    if (operation === 'read') return state;
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
    atomic(file, { state: initialized, publishing: true, digest: hash(initialized) });
    publishTail(tailFile, initialized.tail);
    atomic(file, { state: initialized, publishing: false, digest: hash(initialized) });
    context.checkpoint = undefined; context.settlement = undefined;
    return;
  }
  if (operation === 'initialize') return fail('SealCorrupt');
  if (envelope.publishing) {
    // The complete durable frontier authorizes only its own in-flight tail publication.
    publishTail(tailFile, envelope.state.tail); tail = envelope.state.tail; tailCorrupt = false;
    envelope.publishing = false; atomic(file, envelope);
  }
  const base = envelope;
  const cached: Cached = context.settlement?.base === base.digest ? context.settlement :
    { base: base.digest, offset: 0, envelope: clone(base) };
  replay(log, cached, base.state.revision);
  envelope = cached.envelope;
  if (envelope.publishing) {
    publishTail(tailFile, envelope.state.tail); tail = envelope.state.tail; tailCorrupt = false;
    cached.offset += append(log, { version: 3, revision: envelope.state.revision, published: true }, context);
    envelope.publishing = false;
  }
  if (tailCorrupt) return fail('SealCorrupt');
  if (hash(tail) !== hash(envelope.state.tail)) return fail(tail === null ? 'SealMissing' : 'SealTailMismatch');
  context.settlement = cached;
  const compact = (force = false) => {
    if (!force && cached.offset < 4 * 1024 * 1024) return;
    atomic(file, { state: envelope.state, publishing: false, digest: hash(envelope.state) });
    const fd = fs.openSync(log, 'w', 0o600);
    try { fs.fdatasyncSync(fd); } finally { fs.closeSync(fd); }
    context.settlement = undefined;
  };
  if (operation === 'compact') { compact(value?.force === true); return; }
  if (operation === 'read') return clone(envelope.state);
  if (!['update', 'reserve', 'compare-and-set'].includes(operation)) return fail('SealCorrupt');
  const prior = envelope.state;
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
  if ((operation === 'reserve' || operation === 'compare-and-set' && value.operation === 'reserve') &&
      (body.publishing || state.generation !== prior.generation + 1)) return fail('SealCorrupt');
  cached.offset += append(log, body, context);
  envelope.state = state;
  if (body.publishing) {
    publishTail(tailFile, state.tail);
    cached.offset += append(log, { version: 3, revision: state.revision, published: true }, context);
  }
  // Compact only after a completed publication, never in the reservation's head-
  // locked durability barrier. Startup also compacts behind the writer fence.
  if (body.publishing) compact();
  // A caller's verification snapshot must not alias the coordinator's live index:
  // another process's WAL suffix can change that index before publication checks it.
  return { changed: true, result: clone(result) };
  } catch (error) {
    // A failed write may have reached disk; reconstruct its outcome on next use.
    context.settlement = undefined;
    throw error;
  }
}
