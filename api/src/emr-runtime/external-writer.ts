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
export interface ExternalState {
  version: 1; revision: number; generation: number; tail: any;
  intents: Record<string, any>; slots: Record<string, any>; proofs: Record<string, any>;
  terminal: Record<string, any>; retired: Record<string, number>;
}
/** Called only by the lock-owning subprocess. Tests substitute the OS/FS transport, not the state transitions. */
export function executeExternal(request: WriterRequest): any {
  const { directory, operation, value } = request;
  if (operation.startsWith('journal-')) {
    const journal = new JournalFile(directory);
    if (operation === 'journal-load') return { records: journal.all(), tornBytes: journal.tornBytes };
    if (operation === 'journal-record') return journal.record(value.id, value.kind, value.body, value.at);
    return fail('SealCorrupt');
  }
  const file = path.join(directory, 'seal', 'settlement.json'), tailFile = path.join(directory, 'seal', 'tail.json');
  let envelope = load(file), tail = load(tailFile);
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
    if (tail) return fail('SealUpgradeRequired');
    envelope = { state: { version: 1, revision: 0, generation: 0, tail: null, intents: {}, slots: {}, proofs: {},
      terminal: {}, retired: { viewing: 0, history: 0 } }, publishing: false };
    envelope.digest = hash(envelope.state);
  }
  if (envelope.digest !== hash(envelope.state) || envelope.state.version !== 1) return fail('SealCorrupt');
  if (envelope.publishing) {
    // The complete durable frontier authorizes only its own in-flight tail publication.
    atomic(tailFile, envelope.state.tail); tail = envelope.state.tail;
    envelope.publishing = false; atomic(file, envelope);
  }
  if (hash(tail) !== hash(envelope.state.tail)) return fail(tail === null ? 'SealMissing' : 'SealTailMismatch');
  if (operation === 'read') return envelope.state;
  if (operation !== 'compare-and-set') return fail('SealCorrupt');
  if (value.before !== envelope.state.revision) return { changed: false };
  const state: ExternalState = value.state;
  if (state.revision !== value.before + 1 || state.generation < envelope.state.generation) return fail('SealCorrupt');
  const publishing = hash(tail) !== hash(state.tail);
  atomic(file, { state, publishing, digest: hash(state) });
  if (publishing) {
    atomic(tailFile, state.tail);
    atomic(file, { state, publishing: false, digest: hash(state) });
  }
  return { changed: true };
}

if (require.main === module) {
  try { process.stdout.write(JSON.stringify({ value: executeExternal(JSON.parse(fs.readFileSync(0, 'utf8'))) })); }
  catch (error: any) { process.stdout.write(JSON.stringify({ error: /^(Seal|FailureJournal|EmrState)/.test(error.code || '') ? error.code : 'SealUnavailable', detail: error.detail || null })); }
}
