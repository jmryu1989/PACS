import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
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
