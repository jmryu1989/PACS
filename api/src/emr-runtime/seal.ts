import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ChainPosition } from '../emr-contract/access-event';
import { ContractError, integer, object, refuse, sha256, string, utc } from '../emr-contract/validation';
import { ChainTail, StoredEntry, chainViolation, retainedAnchor } from './contract';
import { FailureJournal, protectedDirectory, syncDirectory } from './failure-journal';
import type { PrismaLedgerSql } from './store';

/**
 * The trusted tail outside the database (REQ-EMR-06/19): the last chain position this server has proven committed, kept
 * on the API's protected state volume where no database role can write. Before an append commits, its intent (event ID
 * and content hash) is written here; the seal moves only after the entries up to its new position were read back,
 * re-hashed from the previous seal and each matched to an intent. A commit not yet sealed is therefore found at start and
 * recovered from stored facts; an intent with no stored entry proves that commit never happened. A missing or damaged
 * seal, or a database end behind it, is never replaced by the database's current end - start is refused.
 */
export interface SealState extends ChainPosition { chainId: string; sealedAt: string }
export type SealRefusal = 'SealMissing' | 'SealCorrupt' | 'SealChainMismatch' | 'LedgerBehindSeal' | 'SealTailMismatch' |
  'LedgerChainBroken' | 'UnsealedEntryUnexplained' | 'SealUnavailable';
export class SealRefused extends Error {
  constructor(readonly code: SealRefusal, readonly detail: string | null = null) { super(detail ? `${code}: ${detail}` : code); this.name = 'SealRefused'; }
}
const PAGE = 1000;

function digest(state: SealState): string {
  return createHash('sha256').update(JSON.stringify({ chainId: state.chainId, sequence: state.sequence, hash: state.hash, sealedAt: state.sealedAt })).digest('hex');
}
const intentName = (eventId: string) => createHash('sha256').update(eventId).digest('hex') + '.json';

export class AccessSeal {
  private readonly file: string;
  private readonly pending: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(stateDirectory: string | undefined, private readonly sql: PrismaLedgerSql, private readonly journal: FailureJournal) {
    const dir = protectedDirectory(stateDirectory, 'seal');
    this.file = path.join(dir, 'tail.json');
    this.pending = path.join(dir, 'pending');
    const info = fs.lstatSync(this.pending, { throwIfNoEntry: false });
    if (!info) { fs.mkdirSync(this.pending, { mode: 0o700 }); syncDirectory(dir); }
    else if (!info.isDirectory() || info.isSymbolicLink()) throw new SealRefused('SealUnavailable');
  }

  /** The stored seal, or 'absent'. A damaged seal is refused, never repaired from the database. */
  read(): SealState | 'absent' {
    let raw: string;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (error: any) {
      if (error?.code === 'ENOENT') return 'absent';
      throw new SealRefused('SealUnavailable');
    }
    try {
      const v = object(JSON.parse(raw), ['format', 'chainId', 'sequence', 'hash', 'sealedAt', 'digest']);
      if (v.format !== 1) throw new Error('format');
      const state: SealState = { chainId: string(v.chainId), sequence: integer(v.sequence), hash: sha256(v.hash), sealedAt: utc(v.sealedAt) };
      if (digest(state) !== v.digest) throw new Error('digest');
      return state;
    } catch { throw new SealRefused('SealCorrupt'); }
  }

  private writeDurably(target: string, text: string): void {
    const temporary = path.join(path.dirname(target), `.tmp-${randomBytes(8).toString('hex')}`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeSync(fd, text);
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, target);
      syncDirectory(path.dirname(target));
    } catch {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already failing */ }
      try { fs.rmSync(temporary, { force: true }); } catch { /* the target itself was not replaced */ }
      throw new SealRefused('SealUnavailable');
    }
  }
  private write(state: SealState): void { this.writeDurably(this.file, JSON.stringify({ format: 1, ...state, digest: digest(state) })); }

  /**
   * Durable before the business transaction commits; a failure here must abort that transaction. Created only if absent
   * (a hard link of a synced temporary file): a resend of the same content finds its own intent, another content under
   * the same event ID is refused before it reaches the database and can never replace the first attempt's intent.
   */
  recordIntent(eventId: string, contentSha256: string): void {
    const target = path.join(this.pending, intentName(string(eventId)));
    const text = JSON.stringify({ eventId, contentSha256: sha256(contentSha256) });
    const temporary = path.join(this.pending, `.tmp-${randomBytes(8).toString('hex')}`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      try { fs.linkSync(temporary, target); } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
        if (fs.readFileSync(target, 'utf8') !== text) refuse('AccessEventIdConflict');
      }
      syncDirectory(this.pending);
    } catch (error) {
      if (error instanceof ContractError) throw error;
      throw new SealRefused('SealUnavailable');
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already failing */ }
      try { fs.rmSync(temporary, { force: true }); } catch { /* a leftover temporary is ignored at start */ }
    }
  }
  /** The intent of an attempt that is settled (sealed, or proven rolled back). Leftovers are harmless and cleared at start. */
  clearIntent(eventId: string): void {
    try { fs.rmSync(path.join(this.pending, intentName(eventId)), { force: true }); } catch { /* cleared at the next start */ }
  }
  private intents(): Map<string, string> {
    const found = new Map<string, string>();
    for (const name of fs.readdirSync(this.pending)) {
      if (name.startsWith('.tmp-')) continue; // an intent never renamed into place was never durable
      try {
        const v = object(JSON.parse(fs.readFileSync(path.join(this.pending, name), 'utf8')), ['eventId', 'contentSha256']);
        if (intentName(string(v.eventId)) !== name) throw new Error('name');
        found.set(v.eventId, sha256(v.contentSha256));
      } catch { throw new SealRefused('SealCorrupt', 'intent'); }
    }
    return found;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async range(after: number, through: number): Promise<StoredEntry[]> {
    const entries: StoredEntry[] = [];
    while (after < through) {
      const page = await this.sql.entriesAfter(after, Math.min(PAGE, through - after));
      if (!page.length) break;
      for (const entry of page) if (entry.sequence <= through) entries.push(entry);
      const last = page[page.length - 1].sequence;
      if (last <= after) break;
      after = last;
    }
    return entries;
  }

  /** Every unsealed access entry must be one this server recorded an intent for before committing it. */
  private explain(entries: readonly StoredEntry[], intents: Map<string, string>): void {
    for (const entry of entries) {
      if (entry.kind !== 'access') continue; // expiry checkpoints are written by the retention role's own function
      if (intents.get(entry.eventId!) !== entry.contentSha256) throw new SealRefused('UnsealedEntryUnexplained', String(entry.sequence));
    }
  }

  /** Move the seal to a committed position, proving every entry between the current seal and it first. */
  advance(target: ChainPosition): Promise<SealState> {
    return this.serial(async () => {
      const current = this.read();
      if (current === 'absent') throw new SealRefused('SealMissing');
      if (target.sequence <= current.sequence) return current;
      const entries = await this.range(current.sequence, target.sequence);
      const violation = chainViolation(current, entries, target);
      if (violation) throw new SealRefused('LedgerChainBroken', violation);
      this.explain(entries, this.intents());
      const next: SealState = { chainId: current.chainId, sequence: target.sequence, hash: target.hash, sealedAt: new Date().toISOString() };
      this.write(next);
      for (const entry of entries) if (entry.eventId) this.clearIntent(entry.eventId);
      return next;
    });
  }

  /**
   * Start-up check and recovery, before any HTTP or job. The retained chain is verified from its justified start; the
   * seal must lie on it; an unsealed tail is adopted only when every entry in it is explained by an intent; an intent
   * without a stored entry is journaled as a commit that never happened (the client resends the same event ID).
   */
  recover(): Promise<{ seal: SealState; recovered: number; notCommitted: number }> {
    return this.serial(async () => {
      const tail: ChainTail = await this.sql.tail();
      const intents = this.intents();
      const found = this.read();
      let current: SealState;
      if (found === 'absent') {
        // Only an empty chain may start a seal; a missing seal over stored entries is never re-created from the database.
        if (tail.sequence !== 0) throw new SealRefused('SealMissing');
        current = { chainId: tail.chainId, sequence: 0, hash: tail.hash, sealedAt: new Date().toISOString() };
        this.write(current);
      } else current = found;
      if (current.chainId !== tail.chainId) throw new SealRefused('SealChainMismatch');
      if (tail.sequence < current.sequence) throw new SealRefused('LedgerBehindSeal');
      const entries = await this.range(0, tail.sequence);
      if (tail.sequence > 0) {
        const anchor = retainedAnchor(entries);
        if (!anchor) throw new SealRefused('LedgerChainBroken', 'unjustified-start');
        const violation = chainViolation(anchor, entries, tail);
        if (violation) throw new SealRefused('LedgerChainBroken', violation);
        const sealed = entries.find(e => e.sequence === current!.sequence);
        if (sealed ? sealed.hash !== current.hash : current.sequence > anchor.sequence || (current.sequence === anchor.sequence && current.hash !== anchor.hash))
          throw new SealRefused('SealTailMismatch');
      } else if (current.hash !== tail.hash) throw new SealRefused('SealTailMismatch');
      const unsealed = entries.filter(e => e.sequence > current!.sequence);
      this.explain(unsealed, intents);
      let recovered = 0;
      if (unsealed.length) {
        this.journal.record(`seal-recovered:${current.sequence}-${tail.sequence}`, 'seal-recovered',
          { chainId: current.chainId, fromSequence: current.sequence, toSequence: tail.sequence, toHash: tail.hash });
        current = { chainId: current.chainId, sequence: tail.sequence, hash: tail.hash, sealedAt: new Date().toISOString() };
        this.write(current);
        recovered = unsealed.length;
      }
      let notCommitted = 0;
      for (const [eventId, contentSha256] of intents) {
        const stored = await this.sql.entryForEvent(eventId);
        if (stored && stored.sequence <= current.sequence) { this.clearIntent(eventId); continue; }
        if (stored) throw new SealRefused('UnsealedEntryUnexplained', String(stored.sequence));
        this.journal.record(`commit-not-found:${eventId}`, 'commit-not-found', { eventId, contentSha256 });
        this.clearIntent(eventId);
        notCommitted++;
      }
      return { seal: current, recovered, notCommitted };
    });
  }
}
