import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { choice, freeze, integer, object, refuse, sha256, string, utc } from '../emr-contract/validation';

/**
 * The protected failure journal (REQ-EMR-06/19): facts that a business rollback, a ledger outage or a process crash must
 * not erase - an append about to be committed, an append that rolled back, an unavailable ledger, a recovered seal range.
 * It is a file on the API's protected state volume, outside the database and outside every business transaction: each
 * record is written with fsync before the caller continues, read back in full at start, refused when full, and
 * idempotent by record ID. stdout and memory are never evidence. Bodies hold IDs, hashes and closed causes only - never a
 * cookie, token, proof, password, raw error or request text.
 */
export const JOURNAL_MAX_BYTES = 64 * 1024 * 1024;
const RECORD_MAX_BYTES = 4096;
export const JOURNAL_KINDS = freeze({
  /** A business change whose ledger append rolled back with it: the attempt itself is the surviving fact. */
  'append-rolled-back': ['eventId', 'cause'],
  /** The ledger could not be reached or refused; the operation reported no success. */
  'ledger-unavailable': ['eventId', 'cause'],
  /** At start, an intent journaled before a commit has no stored entry: that commit never happened. */
  'commit-not-found': ['eventId', 'contentSha256'],
  /** At start, committed entries beyond the seal were proven from it and sealed. */
  'seal-recovered': ['chainId', 'fromSequence', 'toSequence', 'toHash'],
} as const);
export type JournalKind = keyof typeof JOURNAL_KINDS;
export const JOURNAL_CAUSES = freeze(['business-rollback', 'ledger-refused', 'ledger-unreachable', 'commit-unknown', 'seal-unavailable'] as const);
export interface JournalRecord { id: string; kind: JournalKind; at: string; body: Readonly<Record<string, string | number>> }

export class JournalUnavailable extends Error {
  constructor(readonly code: 'FailureJournalUnavailable' | 'FailureJournalFull' | 'FailureJournalCorrupt' | 'FailureJournalConflict') {
    super(code); this.name = 'JournalUnavailable';
  }
}

function canonical(record: JournalRecord): string {
  return JSON.stringify({ id: record.id, kind: record.kind, at: record.at, body: record.body });
}
function parseBody(kind: JournalKind, body: unknown): Readonly<Record<string, string | number>> {
  const keys = JOURNAL_KINDS[kind], v = object(body, [...keys]);
  for (const key of keys) {
    if (key === 'fromSequence' || key === 'toSequence') integer(v[key]);
    else if (key === 'contentSha256' || key === 'toHash') sha256(v[key]);
    else if (key === 'cause') choice(v[key], JOURNAL_CAUSES);
    else string(v[key]);
  }
  return freeze({ ...v });
}

/** A directory the deployment created for this purpose: absolute, an existing real directory, not a link or junction. */
export function protectedDirectory(value: string | undefined, child: string): string {
  if (!value || !path.isAbsolute(value) || value.includes('\0')) refuse('EmrStateDirectoryRequired');
  const root = path.resolve(value);
  const info = fs.lstatSync(root, { throwIfNoEntry: false });
  const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!info || !info.isDirectory() || info.isSymbolicLink() || !same(fs.realpathSync.native(root), root)) refuse('EmrStateDirectoryRequired');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) refuse('EmrStateDirectoryExposed');
  const dir = path.join(root, child);
  const existing = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!existing) { fs.mkdirSync(dir, { mode: 0o700 }); syncDirectory(root); }
  else if (!existing.isDirectory() || existing.isSymbolicLink()) refuse('EmrStateDirectoryRequired');
  return dir;
}
export function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return; // Windows cannot open a directory for fsync; production runs on Linux.
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export class FailureJournal {
  private readonly file: string;
  private records = new Map<string, JournalRecord>();
  private bytes = 0;
  /** Bytes of a torn final line from a crash mid-write; kept in the file, never counted as a record. */
  readonly tornBytes: number;

  constructor(stateDirectory: string | undefined) {
    this.file = path.join(protectedDirectory(stateDirectory, 'journal'), 'failure-journal.jsonl');
    let raw = '';
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (error: any) { if (error?.code !== 'ENOENT') throw new JournalUnavailable('FailureJournalUnavailable'); }
    const complete = raw.endsWith('\n') || raw === '' ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1);
    this.tornBytes = Buffer.byteLength(raw) - Buffer.byteLength(complete);
    for (const line of complete.split('\n').filter(Boolean)) {
      let record: JournalRecord;
      try {
        const v = object(JSON.parse(line), ['id', 'kind', 'at', 'body', 'sha256']);
        record = { id: string(v.id), kind: choice(v.kind, Object.keys(JOURNAL_KINDS) as JournalKind[]), at: utc(v.at), body: {} };
        record.body = parseBody(record.kind, v.body);
        if (createHash('sha256').update(canonical(record)).digest('hex') !== v.sha256) throw new Error('digest');
      } catch { throw new JournalUnavailable('FailureJournalCorrupt'); }
      if (this.records.has(record.id)) throw new JournalUnavailable('FailureJournalCorrupt');
      this.records.set(record.id, freeze(record));
    }
    this.bytes = Buffer.byteLength(raw);
    // A torn tail gets its own line end so the next record never joins it.
    if (this.tornBytes) this.write('\n');
  }

  private write(text: string): void {
    let fd: number | undefined;
    try {
      const existed = fs.existsSync(this.file);
      fd = fs.openSync(this.file, 'a', 0o600);
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
      if (!existed) syncDirectory(path.dirname(this.file));
    } catch {
      throw new JournalUnavailable('FailureJournalUnavailable');
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* the record was synced or the write already failed */ }
    }
    this.bytes += Buffer.byteLength(text);
  }

  /** Durable before it returns; the same ID and body again is the same record, another body under that ID is refused. */
  record(id: string, kind: JournalKind, body: Record<string, string | number>, at = new Date().toISOString()): Readonly<JournalRecord> {
    const record: JournalRecord = { id: string(id), kind: choice(kind, Object.keys(JOURNAL_KINDS) as JournalKind[]), at: utc(at), body: parseBody(kind, body) };
    const existing = this.records.get(record.id);
    if (existing) {
      if (existing.kind === record.kind && JSON.stringify(existing.body) === JSON.stringify(record.body)) return existing;
      throw new JournalUnavailable('FailureJournalConflict');
    }
    const text = canonical(record);
    const line = JSON.stringify({ ...JSON.parse(text), sha256: createHash('sha256').update(text).digest('hex') }) + '\n';
    if (Buffer.byteLength(line) > RECORD_MAX_BYTES) refuse('FailureJournalRecordTooLarge');
    if (this.bytes + Buffer.byteLength(line) > JOURNAL_MAX_BYTES) throw new JournalUnavailable('FailureJournalFull');
    this.write(line);
    const frozen = freeze(record);
    this.records.set(record.id, frozen);
    return frozen;
  }

  find(id: string): Readonly<JournalRecord> | undefined { return this.records.get(id); }
  all(): readonly Readonly<JournalRecord>[] { return [...this.records.values()]; }
}
