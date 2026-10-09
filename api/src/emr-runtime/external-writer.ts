import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { FailureJournal as JournalFile, syncDirectory } from './journal-file';
import type { WriterRequest } from './coordinator';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameLegacy = (a: unknown, b: unknown) => hash(a) === hash(b);
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
export interface ExternalState {
  version: 1 | 2; revision: number; generation: number; tail: any;
  intents: Record<string, any>; slots: Record<string, any>; proofs: Record<string, any>;
  terminal: Record<string, any>; retired: Record<string, number>;
}
interface Envelope { state: ExternalState; publishing: boolean; digest: string }
interface Cached { base: string; offset: number; envelope: Envelope }
export interface WriterContext { tailFile?: { file: string; ino: number; fd: number }; checkpoint?: { stamp: string; envelope: Envelope }; journal?: JournalFile; settlement?: Cached; log?: { file: string; ino: number; fd: number } }
const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value));
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
function replay(file: string, cached: Cached, baseRevision: number): void {
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
  for (const line of raw.subarray(0, good).toString('utf8').split('\n').filter(Boolean)) {
    let record: any;
    try { record = JSON.parse(line); } catch { return fail('SealCorrupt'); }
    const { digest, ...body } = record;
    if (hash(body) !== digest) return fail('SealCorrupt');
    if (body.revision <= baseRevision) continue;
    const state = envelope.state;
    if (body.published) {
      if (body.revision !== state.revision || !envelope.publishing) return fail('SealCorrupt');
      envelope.publishing = false;
      continue;
    }
    if (body.revision !== state.revision + 1 || body.generation < state.generation || envelope.publishing) return fail('SealCorrupt');
    state.revision = body.revision; state.generation = body.generation;
    for (const name of ['intents', 'slots', 'proofs', 'terminal', 'retired']) for (const [id, v] of Object.entries(body.patch[name] ?? {})) {
      if (v === null) delete state[name][id]; else state[name][id] = v;
    }
    if (body.publishing) state.tail = body.tail;
    envelope.publishing = body.publishing;
  }
  cached.offset += good;
  if (good < raw.length) {
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
  for (const name of ['intents', 'slots', 'proofs', 'terminal', 'retired']) {
    const changes = {};
    for (const id of new Set([...Object.keys(before[name]), ...Object.keys(state[name])]))
      if (JSON.stringify(before[name][id]) !== JSON.stringify(state[name][id])) changes[id] = state[name][id] ?? null;
    if (Object.keys(changes).length) patch[name] = changes;
  }
  const publishing = hash(before.tail) !== hash(state.tail);
  return { revision: state.revision, generation: state.generation, patch, publishing, ...(publishing ? { tail: state.tail } : {}) };
}
/** Called only by the lock-owning writer. Tests substitute OS/FS transport, not state transitions. */
export function executeExternal(request: WriterRequest): any {
  const { directory, operation, value } = request, context = request.context ?? {};
  try {
  if (operation.startsWith('journal-')) {
    const journal = context.journal ??= new JournalFile(directory);
    journal.refresh();
    if (operation === 'journal-load') return { records: journal.all(), tornBytes: journal.tornBytes };
    if (operation === 'journal-record') return journal.record(value.id, value.kind, value.body, value.at);
    if (operation === 'journal-find') return journal.find(value);
    return fail('SealCorrupt');
  }
  const file = path.join(directory, 'seal', 'settlement.json'), tailFile = path.join(directory, 'seal', 'tail.json');
  const log = path.join(directory, 'seal', 'settlement.jsonl');
  let envelope = checkpoint(file, context), tail: any, tailCorrupt = false;
  try { tail = readTail(tailFile, context); } catch { tailCorrupt = true; }
  if (operation === 'legacy') {
    if (envelope || !tail || tail.format !== 2) return fail('SealUpgradeRequired');
    const pendingDir=path.join(directory,'seal','pending'),proofDir=path.join(directory,'expiry-evidence');
    const readDirectory=(dir:string) => fs.existsSync(dir) ? fs.readdirSync(dir).filter(n=>!n.startsWith('.tmp-')).map(n=>load(path.join(dir,n))) : [];
    return { tail, intents: readDirectory(pendingDir), proofs: readDirectory(proofDir) };
  }
  if (operation === 'upgrade') {
    if (envelope) return {changed:false};
    if (!sameLegacy(tail,value.legacy)) return fail('SealTailMismatch');
    atomic(file,{state:value.state,publishing:true,digest:hash(value.state)});
    atomic(tailFile,value.state.tail);
    atomic(file,{state:value.state,publishing:false,digest:hash(value.state)});
    return {changed:true};
  }
  if (!envelope) {
    if (tailCorrupt) return fail('SealCorrupt');
    if (tail) return fail('SealUpgradeRequired');
    const state: ExternalState = { version: 2, revision: 0, generation: 0, tail: null, intents: {}, slots: {}, proofs: {},
      terminal: {}, retired: { viewing: 0, history: 0 } };
    envelope = { state, publishing: false, digest: hash(state) };
    atomic(file, envelope);
  }
  if (envelope.digest !== hash(envelope.state) || ![1, 2].includes(envelope.state.version)) return fail('SealCorrupt');
  if (envelope.publishing) {
    // The complete durable frontier authorizes only its own in-flight tail publication.
    publishTail(tailFile, envelope.state.tail); tail = envelope.state.tail; tailCorrupt = false;
    envelope.publishing = false; atomic(file, envelope);
  }
  if (envelope.state.version === 1) {
    // Old writers do not understand the WAL. Make them fail closed before the
    // first log record, while preserving every v1 reservation and proof verbatim.
    envelope.state.version = 2; envelope.digest = hash(envelope.state); atomic(file, envelope);
  }
  const base = envelope;
  const cached: Cached = context.settlement?.base === base.digest ? context.settlement :
    { base: base.digest, offset: 0, envelope: clone(base) };
  replay(log, cached, base.state.revision);
  envelope = cached.envelope;
  if (envelope.publishing) {
    publishTail(tailFile, envelope.state.tail); tail = envelope.state.tail; tailCorrupt = false;
    cached.offset += append(log, { revision: envelope.state.revision, published: true }, context);
    envelope.publishing = false;
  }
  if (tailCorrupt) return fail('SealCorrupt');
  if (hash(tail) !== hash(envelope.state.tail)) return fail(tail === null ? 'SealMissing' : 'SealTailMismatch');
  context.settlement = cached;
  const compact = () => {
    if (cached.offset < 4 * 1024 * 1024) return;
    atomic(file, { state: envelope.state, publishing: false, digest: hash(envelope.state) });
    const fd = fs.openSync(log, 'w', 0o600);
    try { fs.fdatasyncSync(fd); } finally { fs.closeSync(fd); }
    context.settlement = undefined;
  };
  if (operation === 'compact') { compact(); return; }
  if (operation === 'read') return clone(envelope.state);
  if (!['update', 'admit', 'reserve', 'compare-and-set'].includes(operation)) return fail('SealCorrupt');
  const prior = envelope.state;
  if (operation === 'compare-and-set' && value.before !== prior.revision) return { changed: false };
  const state: ExternalState = operation === 'compare-and-set' ? clone(value.state) : clone(prior);
  const result = operation === 'compare-and-set' ? undefined : value(state);
  if (operation !== 'compare-and-set') {
    if (hash(state) === hash(prior)) return { changed: false, result: clone(result) };
    state.revision++;
  }
  if (state.version !== 2 || state.revision !== prior.revision + 1 || state.generation < prior.generation) return fail('SealCorrupt');
  const body = delta(prior, state);
  if (operation === 'reserve' && (body.publishing || state.generation !== prior.generation + 1)) return fail('SealCorrupt');
  cached.offset += append(log, body, context);
  envelope.state = state;
  if (body.publishing) {
    publishTail(tailFile, state.tail);
    cached.offset += append(log, { revision: state.revision, published: true }, context);
  }
  // Only admission before the first head lock may compact during ordinary work.
  // Synchronous expiry intents and supersession settlement can run under that lock;
  // those updates append only. Startup also compacts behind the writer fence.
  if (operation === 'admit') compact();
  // A caller's verification snapshot must not alias the coordinator's live index:
  // another process's WAL suffix can change that index before publication checks it.
  return { changed: true, result: clone(result) };
  } catch (error) {
    // A failed write may have reached disk; reconstruct its outcome on next use.
    context.settlement = undefined;
    throw error;
  }
}
