import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ACCESS_STREAMS, AccessStream, ChainPosition } from '../emr-contract/access-event';
import { ContractError, choice, integer, object, refuse, sha256, string, utc } from '../emr-contract/validation';
import { ChainTail, StoredEntry, chainViolation, retainedAnchor } from './contract';
import { FailureJournal, protectedDirectory, syncDirectory } from './failure-journal';
import type { PrismaLedgerSql } from './store';

/**
 * The trusted tails outside the database (REQ-EMR-06/19): for each stream of the access ledger (D-1: viewing, history), the
 * last chain position this server has proven committed, kept on the API's protected state volume where no database role can
 * write. Before an append commits, its intent (stream, event ID and content hash) is written here; a stream's seal moves
 * only after the entries up to its new position were read back, re-hashed from the previous seal and each matched to an
 * intent. A commit not yet sealed is therefore found at start and recovered from stored facts; an intent with no stored
 * entry proves that commit never happened. A missing or damaged seal, or a database end behind it, is never replaced by the
 * database's current end - start is refused.
 */
export interface StreamSeal extends ChainPosition { chainId: string }
export interface SealState { streams: Readonly<Record<AccessStream, StreamSeal>>; sealedAt: string }
export type SealRefusal = 'SealMissing' | 'SealCorrupt' | 'SealChainMismatch' | 'LedgerBehindSeal' | 'SealTailMismatch' |
  'LedgerChainBroken' | 'UnsealedEntryUnexplained' | 'SealUnavailable';
export class SealRefused extends Error {
  constructor(readonly code: SealRefusal, readonly detail: string | null = null) { super(detail ? `${code}: ${detail}` : code); this.name = 'SealRefused'; }
}
export interface RecoveryCount { recovered: number; notCommitted: number }
interface ExpiryIntent {
  chainId: string; seal: ChainPosition; anchor: ChainPosition; count: number; checkpointSequence: number;
}
const PAGE = 1000;

function canonical(state: SealState): string {
  return JSON.stringify({ streams: Object.fromEntries(ACCESS_STREAMS.map(s => [s, { chainId: state.streams[s].chainId,
    sequence: state.streams[s].sequence, hash: state.streams[s].hash }])), sealedAt: state.sealedAt });
}
const digest = (state: SealState) => createHash('sha256').update(canonical(state)).digest('hex');
const intentName = (stream: AccessStream, eventId: string) => createHash('sha256').update(`${stream}\0${eventId}`).digest('hex') + '.json';

export class AccessSeal {
  private readonly file: string;
  private readonly pending: string;
  private readonly expiry: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(stateDirectory: string | undefined, private readonly sql: PrismaLedgerSql, private readonly journal: FailureJournal) {
    const dir = protectedDirectory(stateDirectory, 'seal');
    this.file = path.join(dir, 'tail.json');
    this.pending = path.join(dir, 'pending');
    const info = fs.lstatSync(this.pending, { throwIfNoEntry: false });
    if (!info) { fs.mkdirSync(this.pending, { mode: 0o700 }); syncDirectory(dir); }
    else if (!info.isDirectory() || info.isSymbolicLink()) throw new SealRefused('SealUnavailable');
    this.expiry = protectedDirectory(stateDirectory, 'expiry-evidence');
  }

  /** The stored seal of both streams, or 'absent'. A damaged seal is refused, never repaired from the database. */
  read(): SealState | 'absent' {
    let raw: string;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (error: any) {
      if (error?.code === 'ENOENT') return 'absent';
      throw new SealRefused('SealUnavailable');
    }
    try {
      const v = object(JSON.parse(raw), ['format', 'streams', 'sealedAt', 'digest']);
      if (v.format !== 2) throw new Error('format');
      const s = object(v.streams, [...ACCESS_STREAMS]);
      const streams = Object.fromEntries(ACCESS_STREAMS.map(stream => {
        const p = object(s[stream], ['chainId', 'sequence', 'hash']);
        return [stream, Object.freeze({ chainId: string(p.chainId), sequence: integer(p.sequence), hash: sha256(p.hash) })];
      })) as Record<AccessStream, StreamSeal>;
      const state: SealState = { streams: Object.freeze(streams), sealedAt: utc(v.sealedAt) };
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
  private write(state: SealState): void {
    this.writeDurably(this.file, JSON.stringify({ format: 2, ...JSON.parse(canonical(state)), digest: digest(state) }));
  }

  /**
   * Durable before the business transaction commits; a failure here must abort that transaction. Created only if absent
   * (a hard link of a synced temporary file): a resend of the same content finds its own intent, another content under
   * the same event ID in the same stream is refused before it reaches the database and can never replace the first
   * attempt's intent.
   */
  recordIntent(stream: AccessStream, eventId: string, contentSha256: string): void {
    choice(stream, ACCESS_STREAMS);
    const target = path.join(this.pending, intentName(stream, string(eventId)));
    const text = JSON.stringify({ stream, eventId, contentSha256: sha256(contentSha256) });
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
  clearIntent(stream: AccessStream, eventId: string): void {
    try { fs.rmSync(path.join(this.pending, intentName(stream, eventId)), { force: true }); } catch { /* cleared at the next start */ }
  }
  private intents(): Record<AccessStream, Map<string, string>> {
    const found = Object.fromEntries(ACCESS_STREAMS.map(s => [s, new Map<string, string>()])) as Record<AccessStream, Map<string, string>>;
    for (const name of fs.readdirSync(this.pending)) {
      if (name.startsWith('.tmp-')) continue; // an intent never renamed into place was never durable
      try {
        const v = object(JSON.parse(fs.readFileSync(path.join(this.pending, name), 'utf8')), ['stream', 'eventId', 'contentSha256']);
        const stream = choice(v.stream, ACCESS_STREAMS);
        if (intentName(stream, string(v.eventId)) !== name) throw new Error('name');
        found[stream].set(v.eventId, sha256(v.contentSha256));
      } catch { throw new SealRefused('SealCorrupt', 'intent'); }
    }
    return found;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async range(stream: AccessStream, after: number, through: number): Promise<StoredEntry[]> {
    const entries: StoredEntry[] = [];
    while (after < through) {
      const page = await this.sql.entriesAfter(stream, after, Math.min(PAGE, through - after));
      if (!page.length) break;
      for (const entry of page) if (entry.sequence <= through) entries.push(entry);
      const last = page[page.length - 1].sequence;
      if (last <= after) break;
      after = last;
    }
    return entries;
  }

  /** Every unsealed event entry must be one this server recorded an intent for, in its stream, before committing it. */
  private explain(entries: readonly StoredEntry[], intents: Map<string, string>, chainId: string): void {
    for (const entry of entries) {
      if (entry.kind === 'expiry') {
        if (this.expiryProof(entry)?.chainId !== chainId) throw new SealRefused('UnsealedEntryUnexplained', String(entry.sequence));
        continue;
      }
      if (intents.get(entry.eventId!) !== entry.contentSha256) throw new SealRefused('UnsealedEntryUnexplained', String(entry.sequence));
    }
  }

  private expiryProof(entry: StoredEntry): ExpiryIntent | null {
    try {
      const p = object(JSON.parse(entry.payload), ['kind', 'at', 'deletedThrough', 'deletedCount', 'anchorHash']);
      utc(p.at);
      const target = path.join(this.expiry, `${integer(entry.sequence, 1)}-${integer(p.deletedThrough, 1)}-${sha256(p.anchorHash)}.json`);
      if (!fs.existsSync(target)) return null;
      const proof = object(JSON.parse(fs.readFileSync(target, 'utf8')), ['chainId', 'seal', 'anchor', 'count', 'checkpointSequence']);
      const seal = object(proof.seal, ['sequence', 'hash']), anchor = object(proof.anchor, ['sequence', 'hash']);
      string(proof.chainId); integer(seal.sequence); sha256(seal.hash); integer(anchor.sequence, 1); sha256(anchor.hash);
      if (p.kind !== 'expiry' || proof.checkpointSequence !== entry.sequence || seal.sequence + 1 !== entry.sequence ||
          seal.hash !== entry.previousHash || anchor.sequence !== p.deletedThrough || anchor.hash !== p.anchorHash ||
          integer(proof.count, 1) !== p.deletedCount || anchor.sequence > seal.sequence) return null;
      return proof as ExpiryIntent;
    } catch { throw new SealRefused('SealCorrupt', 'expiry-evidence'); }
  }

  /** The database alone cannot justify a deleted prefix, even if it also supplies a valid-looking checkpoint. */
  private verifyRetained(stream: AccessStream, entries: readonly StoredEntry[], current: StreamSeal, tail: ChainTail): void {
    const anchor = retainedAnchor(entries);
    if (!anchor) throw new SealRefused('LedgerChainBroken', `${stream}:unjustified-start`);
    if (anchor.sequence > current.sequence) throw new SealRefused('SealTailMismatch', stream);
    if (anchor.sequence > 0) {
      const proof = entries.filter(e => e.kind === 'expiry').map(e => this.expiryProof(e)).find(p => p &&
        p.chainId === current.chainId && p.anchor.sequence === anchor.sequence && p.anchor.hash === anchor.hash);
      if (!proof) throw new SealRefused('UnsealedEntryUnexplained', 'expiry-anchor');
    }
    const violation = chainViolation(anchor, entries, tail, stream);
    if (violation) throw new SealRefused('LedgerChainBroken', `${stream}:${violation}`);
    const sealed = entries.find(e => e.sequence === current.sequence);
    if (sealed ? sealed.hash !== current.hash : current.sequence !== anchor.sequence || current.hash !== anchor.hash)
      throw new SealRefused('SealTailMismatch', stream);
  }

  /**
   * Retention's external intent, before the deleting transaction commits. The whole retained chain must reach the last
   * trusted seal, which must already cover the prefix. Only positions/hashes/counts survive here, never deleted bodies.
   * The caller must roll back if the returned checkpoint sequence differs (a concurrent append advanced the DB head).
   * An interrupted attempt leaves this harmless evidence; recovery still requires the actual committed checkpoint.
   */
  prepareExpiry(through: number): Promise<{ count: number; checkpointSequence: number }> {
    return this.serial(async () => {
      const state = this.read();
      if (state === 'absent') throw new SealRefused('SealMissing');
      const current = state.streams.viewing, tail = await this.sql.tail('viewing');
      if (tail.chainId !== current.chainId || tail.sequence !== current.sequence || tail.hash !== current.hash)
        throw new SealRefused('SealTailMismatch', 'recover-before-expiry');
      const entries = await this.range('viewing', 0, tail.sequence);
      this.verifyRetained('viewing', entries, current, tail);
      const prefix = entries.filter(e => e.sequence <= integer(through, 1)), last = prefix[prefix.length - 1];
      if (!last || last.sequence !== through) throw new SealRefused('LedgerChainBroken', 'expiry-prefix');
      const proof: ExpiryIntent = { chainId: current.chainId, seal: { sequence: current.sequence, hash: current.hash },
        anchor: { sequence: through, hash: last.hash }, count: prefix.length, checkpointSequence: current.sequence + 1 };
      const target = path.join(this.expiry, `${proof.checkpointSequence}-${through}-${last.hash}.json`);
      const text = JSON.stringify(proof);
      if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') !== text) throw new SealRefused('SealCorrupt', 'expiry-conflict');
      this.writeDurably(target, text);
      return { count: proof.count, checkpointSequence: proof.checkpointSequence };
    });
  }

  /** Move one stream's seal to a committed position, proving every entry between its current seal and it first. */
  advance(stream: AccessStream, target: ChainPosition): Promise<SealState> {
    return this.serial(async () => {
      const state = this.read();
      if (state === 'absent') throw new SealRefused('SealMissing');
      const current = state.streams[choice(stream, ACCESS_STREAMS)];
      if (target.sequence <= current.sequence) return state;
      const entries = await this.range(stream, current.sequence, target.sequence);
      const violation = chainViolation(current, entries, target, stream);
      if (violation) throw new SealRefused('LedgerChainBroken', `${stream}:${violation}`);
      this.explain(entries, this.intents()[stream], current.chainId);
      const next: SealState = { streams: Object.freeze({ ...state.streams, [stream]: Object.freeze({ chainId: current.chainId,
        sequence: target.sequence, hash: target.hash }) }), sealedAt: new Date().toISOString() };
      this.write(next);
      for (const entry of entries) if (entry.eventId) this.clearIntent(stream, entry.eventId);
      return next;
    });
  }

  /**
   * Start-up check and recovery, before any HTTP or job. Each stream's retained chain is verified from its justified start;
   * its seal must lie on it; an unsealed tail is adopted only when every entry in it is explained by an intent; an intent
   * without a stored entry is journaled as a commit that never happened (the client resends the same event ID).
   */
  recover(): Promise<{ seal: SealState; recovered: number; notCommitted: number; streams: Record<AccessStream, RecoveryCount> }> {
    return this.serial(async () => {
      const tails = {} as Record<AccessStream, ChainTail>;
      for (const stream of ACCESS_STREAMS) tails[stream] = await this.sql.tail(stream);
      const intents = this.intents();
      const found = this.read();
      let state: SealState;
      if (found === 'absent') {
        // Only empty chains may start a seal; a missing seal over stored entries is never re-created from the database.
        if (ACCESS_STREAMS.some(s => tails[s].sequence !== 0)) throw new SealRefused('SealMissing');
        state = { streams: Object.freeze(Object.fromEntries(ACCESS_STREAMS.map(s => [s, Object.freeze({ chainId: tails[s].chainId,
          sequence: 0, hash: tails[s].hash })]))) as Record<AccessStream, StreamSeal>, sealedAt: new Date().toISOString() };
        this.write(state);
      } else state = found;
      const counts = {} as Record<AccessStream, RecoveryCount>;
      for (const stream of ACCESS_STREAMS) {
        const tail = tails[stream];
        let current = state.streams[stream];
        if (current.chainId !== tail.chainId) throw new SealRefused('SealChainMismatch', stream);
        if (tail.sequence < current.sequence) throw new SealRefused('LedgerBehindSeal', stream);
        const entries = await this.range(stream, 0, tail.sequence);
        if (tail.sequence > 0) {
          this.verifyRetained(stream, entries, current, tail);
        } else if (current.hash !== tail.hash) throw new SealRefused('SealTailMismatch', stream);
        const unsealed = entries.filter(e => e.sequence > current.sequence);
        this.explain(unsealed, intents[stream], current.chainId);
        let recovered = 0;
        if (unsealed.length) {
          this.journal.record(`seal-recovered:${stream}:${current.sequence}-${tail.sequence}`, 'seal-recovered',
            { chainId: current.chainId, fromSequence: current.sequence, toSequence: tail.sequence, toHash: tail.hash });
          current = Object.freeze({ chainId: current.chainId, sequence: tail.sequence, hash: tail.hash });
          state = { streams: Object.freeze({ ...state.streams, [stream]: current }), sealedAt: new Date().toISOString() };
          this.write(state);
          recovered = unsealed.length;
        }
        let notCommitted = 0;
        for (const [eventId, contentSha256] of intents[stream]) {
          const stored = await this.sql.entryForEvent(stream, eventId);
          if (stored && stored.sequence <= current.sequence) { this.clearIntent(stream, eventId); continue; }
          if (stored) throw new SealRefused('UnsealedEntryUnexplained', `${stream}:${stored.sequence}`);
          this.journal.record(`commit-not-found:${stream}:${eventId}`, 'commit-not-found', { eventId, contentSha256 });
          this.clearIntent(stream, eventId);
          notCommitted++;
        }
        counts[stream] = { recovered, notCommitted };
      }
      return { seal: state, streams: counts,
        recovered: ACCESS_STREAMS.reduce((n, s) => n + counts[s].recovered, 0),
        notCommitted: ACCESS_STREAMS.reduce((n, s) => n + counts[s].notCommitted, 0) };
    });
  }
}
