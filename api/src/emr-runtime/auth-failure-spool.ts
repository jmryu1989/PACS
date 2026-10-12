import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { freeze, refuse, string, utc } from '../emr-contract/validation';
import { parseAuthFailureObservation } from './contract';
import {
  JournalKind, JournalRecord, JournalUnavailable, RECORD_MAX_BYTES, journalLine, parseBody, parseJournalLine,
  protectedDirectory, quarantineTornTail,
} from './journal-file';

/**
 * Failed sign-in observations (B2R-01, B2R2-01). A refusal is recorded before its ledger event is attempted, so the fact
 * survives a rollback or an outage; once the event has its durable receipt the observation is complete and compaction may
 * drop the pair. Nothing here ever spends B1's lifetime recovery journal, whatever the number of refusals.
 *
 * Two spools: `anonymous` (no verified identity) and `member` (a verified identity, e.g. a suspended member whose provider
 * login still succeeds). A flood of one kind cannot displace the other, and one member holds at most
 * MEMBER_PENDING_PER_IDENTITY unrecovered observations, so a single account cannot exhaust the member spool during a ledger
 * outage. Each admitted observation reserves room for its completion record.
 *
 * IO (B2R2-08): admission is decided in order on the owner's event loop; the bytes go out asynchronously as one append and
 * one fdatasync per batch (group commit) on the libuv pool, and compaction runs in the same serialized queue. A caller's
 * promise resolves only after its record is durable. The owner process is the only writer of a spool.
 */
export const AUTH_SPOOL_MAX_BYTES = 1024 * 1024;
export const MEMBER_PENDING_PER_IDENTITY = 16;
export type AuthSpoolKind = 'anonymous' | 'member';
const DIRECTORY: Record<AuthSpoolKind, string> = { anonymous: 'anonymous-failures', member: 'member-failures' };

interface Waiting {
  record: JournalRecord; line: Buffer; identity: string | null;
  resolve: (record: Readonly<JournalRecord> | null) => void; reject: (error: unknown) => void;
}

/** The identity whose pending observations count against its own limit (verified issuer and subject). */
function identityOf(record: JournalRecord): string | null {
  if (record.kind !== 'auth-failure-observed') return null;
  const who = parseAuthFailureObservation(JSON.parse(String(record.body.observation))).who;
  return who ? `${who.issuer}\n${who.target}` : null;
}

async function syncDirectoryAsync(dir: string): Promise<void> {
  if (process.platform === 'win32') return; // Windows cannot open a directory for fsync; production runs on Linux.
  const handle = await fs.promises.open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export class AuthFailureSpool {
  readonly file: string;
  private readonly directory: string;
  /** Bytes of a torn final line, durably quarantined before the spool is truncated. */
  readonly tornBytes: number;
  private records = new Map<string, Readonly<JournalRecord>>();
  private pendingAuth = new Map<string, Readonly<JournalRecord>>();
  private pendingByIdentity = new Map<string, number>();
  private bytes = 0;
  private archiveBytes = 0;
  private unavailable = false;
  private waiting: Waiting[] = [];
  private draining: Promise<void> | null = null;
  private handle: fs.promises.FileHandle | null = null;

  constructor(stateDirectory: string | undefined, readonly kind: AuthSpoolKind) {
    this.directory = protectedDirectory(stateDirectory, DIRECTORY[kind]);
    this.file = path.join(this.directory, 'failure-journal.jsonl');
    let raw: Buffer = Buffer.alloc(0);
    try { raw = fs.readFileSync(this.file); } catch (error: any) { if (error?.code !== 'ENOENT') throw new JournalUnavailable('FailureJournalUnavailable'); }
    const goodLength = raw.lastIndexOf(10) + 1;
    this.tornBytes = raw.length - goodLength;
    for (const line of raw.subarray(0, goodLength).toString('utf8').split('\n').filter(Boolean)) {
      const record = parseJournalLine(line);
      if (this.records.has(record.id) || !['auth-failure-observed', 'auth-failure-recovered'].includes(record.kind) ||
          (record.kind === 'auth-failure-observed' && (identityOf(record) === null) !== (kind === 'anonymous')))
        throw new JournalUnavailable('FailureJournalCorrupt');
      this.index(freeze(record));
    }
    if (this.tornBytes) quarantineTornTail(this.file, raw, goodLength);
    for (const name of fs.readdirSync(this.directory).filter(n => n.startsWith('torn-'))) {
      const info = fs.lstatSync(path.join(this.directory, name));
      if (!info.isFile() || info.isSymbolicLink()) throw new JournalUnavailable('FailureJournalCorrupt');
      this.archiveBytes += info.size;
    }
    this.bytes = goodLength + this.archiveBytes;
  }

  private index(record: Readonly<JournalRecord>): void {
    this.records.set(record.id, record);
    if (record.kind === 'auth-failure-observed') {
      this.pendingAuth.set(record.id, record);
      const identity = identityOf(record);
      if (identity) this.pendingByIdentity.set(identity, (this.pendingByIdentity.get(identity) ?? 0) + 1);
    } else {
      const observation = this.pendingAuth.get(`auth-failure:${record.body.eventId}`);
      if (!observation) return;
      this.pendingAuth.delete(observation.id);
      const identity = identityOf(observation);
      if (!identity) return;
      const left = (this.pendingByIdentity.get(identity) ?? 1) - 1;
      if (left > 0) this.pendingByIdentity.set(identity, left); else this.pendingByIdentity.delete(identity);
    }
  }

  /** Unrecovered observations for the fenced recovery pass; bounded per call, independent of history. */
  pendingAuthentication(limit = 32): readonly Readonly<JournalRecord>[] {
    const rows: Readonly<JournalRecord>[] = [];
    for (const row of this.pendingAuth.values()) { rows.push(row); if (rows.length >= limit) break; }
    return rows;
  }
  find(id: string): Readonly<JournalRecord> | undefined { return this.records.get(id); }
  holds(eventId: string): boolean { return this.records.has(`auth-failure:${eventId}`); }

  /**
   * Durable before the promise resolves; the same ID and body again is the same record, another body is refused.
   * Resolves null for the completion of an observation that compaction already removed (it was complete).
   */
  record(id: string, kind: JournalKind, body: Record<string, string | number>, at = new Date().toISOString()): Promise<Readonly<JournalRecord> | null> {
    if (this.unavailable) return Promise.reject(new JournalUnavailable('FailureJournalUnavailable'));
    let record: JournalRecord, identity: string | null, line: Buffer;
    try {
      if (kind !== 'auth-failure-observed' && kind !== 'auth-failure-recovered') throw new JournalUnavailable('FailureJournalConflict');
      record = { id: string(id), kind, at: utc(at), body: parseBody(kind, body) };
      identity = identityOf(record);
      if (kind === 'auth-failure-observed' && (identity === null) !== (this.kind === 'anonymous')) throw new JournalUnavailable('FailureJournalConflict');
      line = Buffer.from(journalLine(record));
      if (line.length > RECORD_MAX_BYTES) refuse('FailureJournalRecordTooLarge');
    } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      this.waiting.push({ record, line, identity, resolve, reject });
      this.kick();
    });
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = this.drain().finally(() => { this.draining = null; if (this.waiting.length) this.kick(); });
  }

  private fail(items: Waiting[]): void {
    this.unavailable = true;
    for (const item of [...items, ...this.waiting.splice(0)]) item.reject(new JournalUnavailable('FailureJournalUnavailable'));
  }

  private async drain(): Promise<void> {
    while (this.waiting.length) {
      const batch = this.waiting.splice(0);
      // An unexpected fault must not strand a caller: settle the whole batch (settling twice is a no-op).
      try { await this.admit(batch); } catch { this.fail(batch); return; }
    }
  }

  private async admit(batch: Waiting[]): Promise<void> {
    if (this.unavailable) { this.fail(batch); return; }
    // Only completed pairs are dropped; compact when this batch might not fit beside them.
    const wanted = batch.reduce((sum, item) => sum + item.line.length + (item.record.kind === 'auth-failure-observed' ? RECORD_MAX_BYTES : 0), 0);
    if (this.bytes + this.pendingAuth.size * RECORD_MAX_BYTES + wanted > AUTH_SPOOL_MAX_BYTES && this.records.size > this.pendingAuth.size) {
      try { await this.compact(); } catch { this.fail(batch); return; }
    }
    const staged = new Map<string, Waiting>(), accepted: Waiting[] = [], followers: [Waiting, Waiting][] = [], deferred: Waiting[] = [];
    const perIdentity = new Map(this.pendingByIdentity), completed = new Set<string>();
    let pending = this.pendingAuth.size, bytes = this.bytes, reclaimable = false;
    for (const item of batch) {
      const { record } = item;
      const prior = this.records.get(record.id) ?? staged.get(record.id)?.record;
      if (prior) {
        if (prior.kind !== record.kind || JSON.stringify(prior.body) !== JSON.stringify(record.body)) item.reject(new JournalUnavailable('FailureJournalConflict'));
        else if (this.records.has(record.id)) item.resolve(this.records.get(record.id)!);
        else followers.push([item, staged.get(record.id)!]);
        continue;
      }
      const observed = record.kind === 'auth-failure-observed';
      const target = observed ? '' : `auth-failure:${record.body.eventId}`;
      const open = !observed && !completed.has(target) && (this.pendingAuth.has(target) || staged.has(target));
      if (!observed && !open) {
        // Nothing to complete here: the pair is already complete (and possibly compacted). Writing it would only add bytes.
        if (this.records.has(target) || staged.has(target)) item.reject(new JournalUnavailable('FailureJournalConflict'));
        else item.resolve(null);
        continue;
      }
      const after = pending + (observed ? 1 : -1);
      if (observed && item.identity && (perIdentity.get(item.identity) ?? 0) >= MEMBER_PENDING_PER_IDENTITY) {
        item.reject(Object.assign(new JournalUnavailable('FailureJournalFull'), { detail: 'identity-limit' }));
        continue;
      }
      if (bytes + item.line.length + after * RECORD_MAX_BYTES > AUTH_SPOOL_MAX_BYTES) {
        // A completion staged in this batch frees room only after it is durable; retry after the next compaction.
        if (reclaimable) deferred.push(item);
        else item.reject(Object.assign(new JournalUnavailable('FailureJournalFull'), { detail: 'capacity' }));
        continue;
      }
      staged.set(record.id, item); accepted.push(item);
      bytes += item.line.length; pending = after;
      if (observed && item.identity) perIdentity.set(item.identity, (perIdentity.get(item.identity) ?? 0) + 1);
      if (!observed) {
        completed.add(target); reclaimable = true;
        const identity = identityOf(this.pendingAuth.get(target) ?? staged.get(target)!.record);
        if (identity) perIdentity.set(identity, (perIdentity.get(identity) ?? 1) - 1);
      }
    }
    if (accepted.length) {
      try { await this.append(Buffer.concat(accepted.map(item => item.line))); }
      catch { this.fail([...accepted, ...followers.map(([item]) => item), ...deferred]); return; }
      for (const item of accepted) this.index(freeze(item.record));
      this.bytes = bytes;
      for (const item of accepted) item.resolve(this.records.get(item.record.id)!);
      for (const [item, leader] of followers) item.resolve(this.records.get(leader.record.id)!);
    }
    if (deferred.length) this.waiting.unshift(...deferred);
  }

  private async append(bytes: Buffer): Promise<void> {
    let created = false;
    if (!this.handle) {
      created = !fs.existsSync(this.file);
      this.handle = await fs.promises.open(this.file, 'a', 0o600);
    }
    try {
      await this.handle.appendFile(bytes);
      await this.handle.datasync();
      if (created) await syncDirectoryAsync(this.directory);
    } catch (error) {
      try { await this.handle.close(); } catch { /* the spool is unavailable either way */ }
      this.handle = null;
      throw error;
    }
  }

  /** Keep only unrecovered observations: temporary file, fsync, rename, directory fsync. */
  private async compact(): Promise<void> {
    const retained = [...this.pendingAuth.values()];
    const text = retained.map(journalLine).join('');
    const temporary = this.file + '.tmp-' + randomBytes(8).toString('hex');
    try {
      const out = await fs.promises.open(temporary, 'wx', 0o600);
      try { await out.writeFile(text); await out.sync(); } finally { await out.close(); }
      if (this.handle) { const previous = this.handle; this.handle = null; await previous.close(); }
      await fs.promises.rename(temporary, this.file);
      await syncDirectoryAsync(this.directory);
    } catch {
      try { await fs.promises.rm(temporary, { force: true }); } catch { /* best effort: never the spool itself */ }
      throw new JournalUnavailable('FailureJournalUnavailable');
    }
    this.records = new Map(retained.map(record => [record.id, record]));
    this.bytes = Buffer.byteLength(text) + this.archiveBytes;
  }
}
