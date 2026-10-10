import { createHash } from 'node:crypto';
import { ACCESS_STREAMS, AccessStream, ChainPosition } from '../emr-contract/access-event';
import { integer, refuse } from '../emr-contract/validation';
import { ChainTail, StoredEntry, chainViolation, retainedAnchor } from './contract';
import { FailureJournal } from './failure-journal';
import { ExternalState } from './external-writer';
import type { PrismaLedgerSql, VerificationPage } from './store';

export interface StreamSeal extends ChainPosition { chainId: string }
export interface SealState { streams: Readonly<Record<AccessStream, StreamSeal>>; sealedAt: string; generation: number }
export type SealRefusal = 'SealMissing' | 'SealCorrupt' | 'SealChainMismatch' | 'LedgerBehindSeal' | 'SealTailMismatch' |
  'LedgerChainBroken' | 'UnsealedEntryUnexplained' | 'SealUnavailable' | 'SealUpgradeRequired';
export class SealRefused extends Error {
  constructor(readonly code: SealRefusal, readonly detail: string | null = null) { super(detail ? `${code}: ${detail}` : code); this.name = 'SealRefused'; }
}
export interface RecoveryCount { recovered: number; notCommitted: number }
export interface CommitBinding {
  stream: AccessStream; chainId: string; attemptId: string; bundleId: string; kind: string; eventId: string | null;
  sequence: number; previousHash: string; hash: string; contentSha256: string; generation: number; proofDigest: string | null;
}
export interface ExpiryCore {
  format: 1; binding: Omit<CommitBinding, 'proofDigest'>; seal: StreamSeal; anchor: ChainPosition; count: number;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const slot = (stream: AccessStream, sequence: number) => `${stream}:${sequence}`;
const key = (stream: AccessStream, attempt: string) => `${stream}:${attempt}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** DB finality is trusted for response-unknown recovery, never described as independent proof.
 * The protected settlement frontier authorizes exact reservations and detects tail-only rollback.
 * Whole DB plus protected-state rollback requires an independent off-host witness (Stage 9).
 */
export class AccessSeal {
  constructor(_directory: string | undefined, private readonly sql: PrismaLedgerSql, private readonly journal: FailureJournal) {}
  private load(): ExternalState {
    try { return this.journal.coordinator.call('read'); }
    catch (error: any) { throw new SealRefused(/^Seal|^Ledger|^Unsealed/.test(error.code || '') ? error.code : 'SealUnavailable', error.detail); }
  }
  private change<T>(work: (state: ExternalState) => T, operation = 'update'): T {
    try { return this.journal.coordinator.call(operation, work).result; }
    catch (error: any) {
      if (error instanceof SealRefused || error.name === 'ContractError') throw error;
      throw new SealRefused(/^Seal|^Ledger|^Unsealed/.test(error.code || '') ? error.code : 'SealUnavailable', error.detail);
    }
  }
  read(): SealState | 'absent' { return this.load().tail ?? 'absent'; }
  recordIntent(stream: AccessStream, attemptId: string, eventId: string | null, contentSha256: string | null, bundleId: string): void {
    this.change(state => this.addIntent(state, { stream, attemptId, eventId, contentSha256, bundleId }));
    this.acknowledgements.clear();
  }
  private addIntent(state: ExternalState, value: { stream: AccessStream; attemptId: string; eventId: string | null; contentSha256: string | null; bundleId: string }): void {
    this.forgetAcknowledged(state);
    const id = key(value.stream, value.attemptId);
    const owned = { ...value, owner: this.journal.coordinator.ownerId };
    if (state.intents[id] && !same(state.intents[id], owned)) refuse('AccessEventIdConflict');
    if (state.terminal[id]) refuse('AttemptAlreadySettled');
    state.intents[id] = owned;
  }
  private intents: { value: Parameters<AccessSeal['addIntent']>[1]; resolve: () => void; reject: (error: unknown) => void }[] | null = null;
  /** Group admitted intents before any head lock. Every waiter already holds its shared DB
   * writer fence, and none may stage a row until this one durable publication completes.
   */
  recordIntentAsync(stream: AccessStream, attemptId: string, eventId: string | null, contentSha256: string | null, bundleId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const item = { value: { stream, attemptId, eventId, contentSha256, bundleId }, resolve, reject };
      if (this.intents) { this.intents.push(item); return; }
      this.intents = [item];
      // Coalesce the current turn without imposing a fixed delay on isolated requests.
      void Promise.resolve().then(() => {
        const group = this.intents; this.intents = null;
        try {
          this.change(state => { for (const entry of group) this.addIntent(state, entry.value); }, 'admit');
          this.acknowledgements.clear();
          for (const entry of group) entry.resolve();
        } catch (error) { for (const entry of group) entry.reject(error); }
      });
    });
  }

  /** Only called with the stream's DB head lock, after staging the exact row and before COMMIT.
   * Reusing a slot proves that its old reservation's transaction has ended without committing.
   */
  private reservationState: ExternalState | undefined;
  reserve(binding: Omit<CommitBinding, 'generation' | 'proofDigest'>, prefix?: { seal: StreamSeal; anchor: ChainPosition; count: number }): CommitBinding {
    let superseded = false;
    const result = this.change(state => {
      const id = key(binding.stream, binding.attemptId), position = slot(binding.stream, binding.sequence);
      if (!state.intents[id]) throw new SealRefused('UnsealedEntryUnexplained', 'intent-missing');
      const prior = state.slots[position];
      if (prior?.attemptId === binding.attemptId) return { binding: prior, state };
      if (prior) {
        superseded = true;
        const old = key(prior.stream, prior.attemptId);
        state.terminal[old] = { phase: 'superseded', generation: prior.generation,
          notFound: { eventId: prior.eventId ?? `expiry:${prior.attemptId}`, contentSha256: prior.contentSha256 } };
        delete state.proofs[old]; delete state.intents[old];
      }
      const next = { ...binding, generation: ++state.generation, proofDigest: null } as CommitBinding;
      if (prefix) {
        const { proofDigest: _, ...identity } = next;
        const core: ExpiryCore = { format: 1, binding: identity, ...prefix };
        next.proofDigest = digest(core);
        state.proofs[id] = core;
      }
      state.slots[position] = next;
      return { binding: next, state };
    }, 'reserve');
    this.reservationState = result.state;
    if (superseded) this.flushNotFound();
    return result.binding;
  }
  private flushNotFound(): void {
    const pending = Object.entries(this.load().terminal).filter(([, t]) => t.notFound);
    for (const [id, t] of pending) this.journal.record(`commit-not-found:${id}`, 'commit-not-found', t.notFound);
    if (pending.length) this.change(state => { for (const [id] of pending) if (state.terminal[id]) delete state.terminal[id].notFound; });
  }
  /** A proven callback rollback settles only its own attempt; unknown responses keep their evidence. */
  abort(stream: AccessStream, attemptId: string): void {
    this.change(state => {
      const id = key(stream, attemptId), reservation = Object.values(state.slots).find(q => key(q.stream, q.attemptId) === id);
      if (state.terminal[id]?.phase === 'committed') throw new SealRefused('SealTailMismatch', 'abort-committed');
      state.terminal[id] = { phase: 'aborted', generation: reservation?.generation ?? state.generation };
      if (reservation) delete state.slots[slot(stream, reservation.sequence)];
      delete state.proofs[id]; delete state.intents[id];
    });
  }
  recordExpiryFailure(attemptId: string, rolledBack: boolean): void {
    const kind = rolledBack ? 'append-rolled-back' : 'ledger-unavailable';
    this.journal.record(`${kind}:viewing:${attemptId}`, kind,
      { eventId: `expiry:${attemptId}`, cause: rolledBack ? 'ledger-refused' : 'commit-unknown' });
  }
  private async range(sql: PrismaLedgerSql, stream: AccessStream, through: number, after = 0): Promise<StoredEntry[]> {
    const entries: StoredEntry[] = [];
    while (after < through) {
      const page = await sql.entriesAfter(stream, after, Math.min(1000, through - after));
      if (!page.length) break;
      entries.push(...page.filter(e => e.sequence <= through));
      const last = page[page.length - 1].sequence;
      if (last <= after) throw new SealRefused('LedgerChainBroken');
      after = last;
    }
    return entries;
  }
  private proof(state: ExternalState, entry: StoredEntry, chainId: string): ExpiryCore | null {
    const q: CommitBinding = state.slots[slot('viewing', entry.sequence)];
    const core: ExpiryCore = q && state.proofs[key('viewing', q.attemptId)];
    if (!core || q.chainId !== chainId || q.kind !== 'expiry' || q.sequence !== entry.sequence || q.hash !== entry.hash ||
        q.previousHash !== entry.previousHash || q.contentSha256 !== entry.contentSha256 || (q.proofDigest !== digest(core) && !(q.attemptId === `legacy:${q.stream}:${q.sequence}` && q.proofDigest === null && q.sequence <= state.retired[q.stream])) ||
        !same(core.binding, (({ proofDigest: _, ...rest }) => rest)(q))) return null;
    let p: any;
    try { p = JSON.parse(entry.payload); } catch { throw new SealRefused('LedgerChainBroken', 'checkpoint-format'); }
    if (p.kind !== 'expiry' || p.deletedThrough !== core.anchor.sequence || p.anchorHash !== core.anchor.hash ||
        p.deletedCount !== core.count || core.seal.sequence + 1 !== entry.sequence || core.seal.hash !== entry.previousHash ||
        core.anchor.sequence > core.seal.sequence) return null;
    return core;
  }
  private async explain(sql: PrismaLedgerSql, state: ExternalState, stream: AccessStream, entry: StoredEntry, chainId: string, suppliedMarker?: CommitBinding | null): Promise<void> {
    const q: CommitBinding = state.slots[slot(stream, entry.sequence)];
    const marker = suppliedMarker === undefined ? await sql.markerForSlot(stream, entry.sequence) : suppliedMarker;
    if (!q || !marker || !same(q, marker) || q.chainId !== chainId || q.sequence !== entry.sequence || q.eventId !== entry.eventId ||
        q.hash !== entry.hash || q.previousHash !== entry.previousHash || q.contentSha256 !== entry.contentSha256 || q.kind !== entry.kind ||
        ['aborted', 'superseded'].includes(state.terminal[key(stream, q.attemptId)]?.phase) ||
        (entry.kind === 'expiry' && !this.proof(state, entry, chainId)))
      throw new SealRefused('UnsealedEntryUnexplained', `${stream}:${entry.sequence}`);
  }
  private readonly anchors = new Map<AccessStream, string>();
  private readonly retainedStarts = new Map<AccessStream, number>();
  private async verify(sql: PrismaLedgerSql, state: ExternalState, stream: AccessStream, tail: ChainTail,
    end: ChainPosition = tail, full = false, page?: VerificationPage): Promise<StoredEntry[]> {
    const current = state.tail.streams[stream];
    if (tail.chainId !== current.chainId) throw new SealRefused('SealChainMismatch', stream);
    if (tail.sequence < current.sequence) throw new SealRefused('LedgerBehindSeal', stream);
    const first = page ? page.first : (await sql.entriesAfter(stream, 0, 1))[0];
    this.retainedStarts.set(stream, first?.sequence ?? 1);
    const anchorKey = JSON.stringify([tail.chainId, first?.sequence ?? 0, first?.previousHash ?? tail.hash]);
    if (!full && this.anchors.get(stream) === anchorKey) {
      const prefix = page?.entries.map(item => item.entry).filter(entry => entry.sequence <= end.sequence);
      const after = prefix?.length ? prefix[prefix.length - 1].sequence : current.sequence;
      const entries = prefix ? [...prefix, ...(prefix.length && after < end.sequence ? await this.range(sql, stream, end.sequence, after) : [])] :
        await this.range(sql, stream, end.sequence, current.sequence);
      const violation = chainViolation(current, entries, end, stream);
      if (violation) throw new SealRefused('LedgerChainBroken', `${stream}:${violation}`);
      return entries;
    }
    const entries = await this.range(sql, stream, tail.sequence), anchor = retainedAnchor(entries);
    if (tail.sequence === 0) {
      if (tail.hash !== current.hash) throw new SealRefused('SealTailMismatch', stream);
      this.anchors.set(stream, anchorKey);
      return entries;
    }
    if (!anchor) throw new SealRefused('LedgerChainBroken', 'unjustified-start');
    if (anchor.sequence > current.sequence) throw new SealRefused('SealTailMismatch', stream);
    // Check checkpoint shape before interpreting its proof or consulting a DB marker.
    const violation = chainViolation(anchor, entries, tail, stream);
    if (violation) throw new SealRefused('LedgerChainBroken', `${stream}:${violation}`);
    if (anchor.sequence > 0) {
      const checkpoint = entries.find(e => e.kind === 'expiry' && same(this.proof(state, e, current.chainId)?.anchor, anchor));
      if (!checkpoint) throw new SealRefused('UnsealedEntryUnexplained', 'expiry-anchor');
      await this.explain(sql, state, stream, checkpoint, current.chainId);
    }
    const sealed = entries.find(e => e.sequence === current.sequence) ?? anchor;
    if (sealed.sequence !== current.sequence || sealed.hash !== current.hash) throw new SealRefused('SealTailMismatch', stream);
    this.anchors.set(stream, anchorKey);
    return entries;
  }
  /** Positive facts only. An unrelated pending intent is never a receipt prerequisite. */
  async reconcileCommitted(stream: AccessStream, target?: ChainPosition, reader = this.sql, recovering = false): Promise<SealState> {
    return (await this.reconcileState(stream, target, reader, recovering)).tail;
  }
  private recentlyVerified(state: ExternalState, stream: AccessStream, target: ChainPosition): boolean {
    const sealed = state.tail.streams[stream];
    // A retained receipt has an exact protected binding, including
    // when retention already removed its row. Other replays must prove the DB
    // bytes through the external seal; a DB event lookup alone is not authority.
    return Object.values(state.terminal).some(t => t.phase === 'committed' &&
      t.binding.stream === stream && t.binding.chainId === sealed.chainId &&
      t.binding.sequence === target.sequence && t.binding.hash === target.hash);
  }
  private async bindSealedTarget(sql: PrismaLedgerSql, state: ExternalState, stream: AccessStream, target: ChainPosition): Promise<void> {
    const sealed = state.tail.streams[stream];
    const tail = await sql.tail(stream);
    if (tail.chainId !== sealed.chainId) throw new SealRefused('SealChainMismatch', stream);
    if (tail.sequence < sealed.sequence) throw new SealRefused('LedgerBehindSeal', stream);
    const entries = await this.range(sql, stream, sealed.sequence, target.sequence - 1), first = entries[0];
    if (!first || first.sequence !== target.sequence || first.hash !== target.hash ||
        chainViolation({ sequence: first.sequence - 1, hash: first.previousHash }, entries, sealed, stream))
      throw new SealRefused('LedgerChainBroken', 'sealed-target');
  }
  private async reconcileState(stream: AccessStream, target?: ChainPosition, reader = this.sql, recovering = false): Promise<ExternalState> {
    // A reservation already read and durably updated this protected frontier under
    // the head lock. It is a sufficient starting point for verifying its own new
    // target. Publication still reloads and validates the actual protected files,
    // merges exact bindings, and retries if another writer advanced the frontier.
    const basis = this.reservationState;
    let useBasis = !recovering && target && basis?.tail && target.sequence > basis.tail.streams[stream].sequence &&
      basis.slots[slot(stream, target.sequence)]?.hash === target.hash;
    for (;;) {
      const state = useBasis ? basis : this.load(); useBasis = false;
      if (!state.tail) throw new SealRefused('SealMissing');
      const sealed = state.tail.streams[stream];
      if (target && target.sequence <= sealed.sequence && !recovering) {
        if (target.sequence === sealed.sequence && target.hash !== sealed.hash) throw new SealRefused('SealTailMismatch', 'target');
        try {
          // An exact protected binding has already proved this position. Opening
          // an otherwise empty SQL snapshot would add a DB availability dependency
          // and pool contention to a receipt whose authority is already durable.
          if (!this.recentlyVerified(state, stream, target))
            await reader.snapshot(sql => this.bindSealedTarget(sql, state, stream, target));
        }
        catch (error) {
          if (!same(this.load().tail.streams[stream], sealed)) continue;
          throw error;
        }
        this.reservationState = state;
        return state;
      }
      let result: {current: StreamSeal; end: ChainPosition; entries: StoredEntry[]; unsealed: StoredEntry[]};
      try { result = await reader.snapshot(async sql => {
        const page = !recovering && target && target.sequence > sealed.sequence ?
          await sql.verificationPage(stream, sealed.sequence, Math.min(1000, target.sequence - sealed.sequence)) : undefined;
        const tail = page?.tail ?? await sql.tail(stream);
        // Freeze an omitted target at this snapshot, including across retries.
        target ??= { sequence: tail.sequence, hash: tail.hash };
        const requested = target;
        const entries = await this.verify(sql, state, stream, tail, requested, recovering, page);
        const own = entries.find(e => e.sequence === requested.sequence);
        if (requested.sequence > tail.sequence || (requested.sequence > sealed.sequence && (!own || own.hash !== requested.hash)))
          throw new SealRefused('SealTailMismatch', 'target');
        const end = requested;
        const current = state.tail.streams[stream];
        const unsealed = entries.filter(e => e.sequence > current.sequence && e.sequence <= end.sequence);
        const markers = new Map(page?.entries.map(item => [item.entry.sequence, item.marker]));
        for (const entry of unsealed) await this.explain(sql, state, stream, entry, current.chainId, markers.get(entry.sequence));
        return { current, end, entries, unsealed };
      }); } catch(error) {
        // A concurrent expiry may replace the prefix after this frontier was read. Re-read
        // under a new DB snapshot only when the protected writer actually advanced its revision.
        if (!same(this.load().tail.streams[stream], sealed)) continue;
        throw error;
      }
      if (!result.unsealed.length) { this.reservationState = state; return state; }
      if (recovering) this.journal.record(`seal-recovered:${stream}:${result.current.sequence}-${result.end.sequence}`, 'seal-recovered',
        { chainId: result.current.chainId, fromSequence: result.current.sequence, toSequence: result.end.sequence, toHash: result.end.hash });
      // The sealed frontier replaces terminal per-event authority. Keep only retained checkpoint lineage and unresolved slots.
      const retained = new Set(Object.values(state.slots).filter(q => q.stream === stream && q.kind === 'expiry' &&
        q.sequence >= this.retainedStarts.get(stream)).map(q => q.sequence));
      // Reservations/intents in other requests can change the global revision during
      // SQL verification. Merge only this verified frontier under the writer lock;
      // a changed frontier (including expiry) still requires a fresh DB snapshot.
      const installed = await this.publish(latest => {
        if (!same(latest.tail.streams[stream], result.current)) return null;
        for (const entry of result.unsealed) {
          const position = slot(stream, entry.sequence), q = latest.slots[position];
          const expected = state.slots[position];
          if (!q || !same(q, expected)) throw new SealRefused('UnsealedEntryUnexplained', position);
        }
        latest.tail = { streams: { ...latest.tail.streams, [stream]: { chainId: result.current.chainId, ...result.end } },
          sealedAt: new Date().toISOString(), generation: ++latest.generation };
        for (const entry of result.unsealed) {
          const position = slot(stream, entry.sequence), q = latest.slots[position], id = key(stream, q.attemptId);
          latest.terminal[id] = { phase: 'committed', generation: q.generation, binding: q, owner: latest.intents[id]?.owner };
          delete latest.intents[id];
        }
        for (const [position, q] of Object.entries(latest.slots)) {
          if (q.stream !== stream || q.sequence > latest.tail.streams[stream].sequence || retained.has(q.sequence)) continue;
          delete latest.slots[position]; delete latest.proofs[key(stream, q.attemptId)];
          latest.retired[stream] = Math.max(latest.retired[stream], q.generation);
        }
        for (const [id, t] of Object.entries(latest.terminal)) if (id.startsWith(stream + ':') && t.phase !== 'committed' && !t.notFound && t.generation <= latest.retired[stream]) delete latest.terminal[id];
        return latest;
      });
      if (installed) { this.reservationState = installed; return installed; }
    }
  }
  private publications: { install: (state: ExternalState) => ExternalState | null;
    resolve: (state: ExternalState | null) => void; reject: (error: unknown) => void }[] | null = null;
  /** Adjacent verified advances share one WAL/tail publication. Keep all three
   * durability barriers: removing the completion barrier would let a later torn
   * or rolled-back completed tail masquerade as a crash awaiting repair.
   * Only already-verified frontiers enter this group; it never waits for an
   * unrelated transaction to commit or acquire a head lock. */
  private publish(install: (state: ExternalState) => ExternalState | null): Promise<ExternalState | null> {
    return new Promise((resolve, reject) => {
      const item = { install, resolve, reject };
      if (this.publications) { this.publications.push(item); return; }
      this.publications = [item];
      setImmediate(() => {
        const group = this.publications; this.publications = null;
        try {
          const result = this.change(state => ({ accepted: group.map(entry => Boolean(entry.install(state))), state }));
          for (let i = 0; i < group.length; i++) group[i].resolve(result.accepted[i] ? result.state : null);
        } catch (error) { for (const entry of group) entry.reject(error); }
      });
    });
  }
  private readonly advances = new Map<AccessStream, { target: ChainPosition; resolve: (state: ExternalState) => void; reject: (error: unknown) => void }[]>();
  /** Coalesce only requests whose COMMIT already finished. No pending transaction or unrelated
   * intent joins this group, and a newly arriving request never extends an in-flight snapshot.
   */
  async advance(stream: AccessStream, target: ChainPosition): Promise<SealState> {
    return (await this.advanceState(stream, target)).tail;
  }
  private advanceState(stream: AccessStream, target: ChainPosition): Promise<ExternalState> {
    return new Promise((resolve, reject) => {
      const waiting = this.advances.get(stream);
      if (waiting) { waiting.push({ target, resolve, reject }); return; }
      const queue = [{ target, resolve, reject }];
      this.advances.set(stream, queue);
      const drain = async () => {
        while (queue.length) {
          const group = queue.splice(0), through = group.reduce((a, b) => a.sequence >= b.target.sequence ? a : b.target, group[0].target);
          try { const state = await this.reconcileState(stream, through); for (const item of group) item.resolve(state); }
          catch (error) { for (const item of group) item.reject(error); }
        }
        this.advances.delete(stream);
      };
      void Promise.resolve().then(drain);
    });
  }

  /** A helper may seal and expire a row while its COMMIT response is in flight. This temporary
   * metadata contains no payload and survives until that attempt acknowledges. Another process's
   * startup fences DB transactions, not responses already in flight, so it must retain these bindings.
   */
  committedReceipt(stream: AccessStream, attemptId: string, eventId: string, entry: StoredEntry): SealState | null {
    return this.receiptFrom(this.load(), stream, attemptId, eventId, entry);
  }
  /** The same protected snapshot that completed this batch proves its receipts.
   * Returning its exact binding avoids a second lock/read after publication; no
   * cached evidence is reused for a later request or after a failed publication. */
  async advanceReceipt(stream: AccessStream, attemptId: string, eventId: string, entry: StoredEntry): Promise<SealState | null> {
    const state = await this.advanceState(stream, { sequence: entry.sequence, hash: entry.hash });
    return this.receiptFrom(state, stream, attemptId, eventId, entry);
  }
  private receiptFrom(state: ExternalState, stream: AccessStream, attemptId: string, eventId: string, entry: StoredEntry): SealState | null {
    const q: CommitBinding = state.terminal[key(stream, attemptId)]?.binding;
    if (!q || q.eventId !== eventId || q.hash !== entry.hash || q.sequence !== entry.sequence ||
        q.contentSha256 !== entry.contentSha256 || q.previousHash !== entry.previousHash ||
        q.chainId !== state.tail.streams[stream].chainId || q.sequence > state.tail.streams[stream].sequence) return null;
    return state.tail;
  }
  private readonly acknowledgements = new Set<string>();
  /** Cleanup is not receipt authority. Fold acknowledged bindings into the next
   * intent publication; a crash before that is swept by the fenced startup once
   * this process's ownership lock has closed. At most the last receipt group waits. */
  acknowledge(stream: AccessStream, attemptId: string): Promise<void> {
    this.acknowledgements.add(key(stream, attemptId));
    return Promise.resolve();
  }
  private forgetAcknowledged(state: ExternalState): void {
    for (const id of this.acknowledgements) {
      if (state.terminal[id]?.phase === 'committed') delete state.terminal[id];
    }
  }

  /** Called in the deleting transaction, with its head lock held, before staging deletion. */
  async expiryPrefix(through: number): Promise<{ seal: StreamSeal; anchor: ChainPosition; count: number }> {
    const sql = this.sql;
    await this.reconcileCommitted('viewing', undefined, sql);
    const state = this.load();
    integer(through, 1);
    const [first] = await sql.entriesAfter('viewing', 0, 1);
    const [last] = await sql.entriesAfter('viewing', through - 1, 1);
    if (!last || last.sequence !== through) throw new SealRefused('LedgerChainBroken', 'expiry-prefix');
    if (!first || through < first.sequence || through > state.tail.streams.viewing.sequence) throw new SealRefused('LedgerChainBroken', 'expiry-prefix');
    return { seal: state.tail.streams.viewing, anchor: { sequence: through, hash: last.hash }, count: through - first.sequence + 1 };
  }

  private async upgradeAtStart(sql: PrismaLedgerSql): Promise<void> {
    const legacy = this.journal.coordinator.call('legacy'), tail=legacy.tail;
    const canonical={streams:Object.fromEntries(ACCESS_STREAMS.map(stream=>[stream,{chainId:tail.streams[stream].chainId,
      sequence:tail.streams[stream].sequence,hash:tail.streams[stream].hash}])),sealedAt:tail.sealedAt};
    if (digest(canonical)!==tail.digest) throw new SealRefused('SealCorrupt','legacy');
    const generation=Math.max(...ACCESS_STREAMS.map(s=>tail.streams[s].sequence))+1;
    const state:ExternalState={version:1,revision:1,generation,tail:{...canonical,generation},intents:{},slots:{},proofs:{},terminal:{},retired:{viewing:0,history:0}};
    for(const stream of ACCESS_STREAMS){
      const actual=await sql.tail(stream),current=tail.streams[stream];
      if(actual.chainId!==current.chainId||actual.sequence!==current.sequence||actual.hash!==current.hash)
        throw new SealRefused('SealTailMismatch','legacy-must-be-fully-sealed');
      const entries=await this.range(sql,stream,actual.sequence),anchor=retainedAnchor(entries);
      if(actual.sequence && (!anchor||chainViolation(anchor,entries,actual,stream)))throw new SealRefused('LedgerChainBroken','legacy');
      for(const entry of entries.filter(e=>e.kind==='expiry')){
        const body=JSON.parse(entry.payload),old=legacy.proofs.find(p=>p.chainId===current.chainId&&p.checkpointSequence===entry.sequence&&
          p.seal.sequence+1===entry.sequence&&p.seal.hash===entry.previousHash&&p.anchor.sequence===body.deletedThrough&&
          p.anchor.hash===body.anchorHash&&p.count===body.deletedCount&&p.anchor.sequence<=p.seal.sequence);
        if(!old)throw new SealRefused('UnsealedEntryUnexplained','legacy-prefix');
        const marker=await sql.markerForSlot(stream,entry.sequence);
        if(!marker||marker.attemptId!==`legacy:${stream}:${entry.sequence}`||marker.hash!==entry.hash||marker.contentSha256!==entry.contentSha256)
          throw new SealRefused('UnsealedEntryUnexplained','legacy-marker');
        // Immutable v2 checkpoint bytes are already sealed. The converted proof retains that authority;
        // its DB marker has no proof digest, so upgraded checkpoints are identified separately below.
        const {proofDigest:_,...binding}=marker;
        const core:ExpiryCore={format:1,binding,seal:{chainId:current.chainId,...old.seal},anchor:old.anchor,count:old.count};
        state.slots[slot(stream,entry.sequence)]=marker;state.proofs[key(stream,marker.attemptId)]=core;
      }
      if(anchor?.sequence>0&&!entries.some(e=>e.kind==='expiry'&&same(state.proofs[key(stream,`legacy:${stream}:${e.sequence}`)]?.anchor,anchor)))
        throw new SealRefused('UnsealedEntryUnexplained','legacy-anchor');
      state.retired[stream]=current.sequence;
    }
    for(const intent of legacy.intents){
      if(!ACCESS_STREAMS.includes(intent.stream)||typeof intent.eventId!=='string')throw new SealRefused('SealCorrupt','legacy-intent');
      const entry=await sql.entryForEvent(intent.stream,intent.eventId);
      if(entry&&entry.contentSha256!==intent.contentSha256)throw new SealRefused('UnsealedEntryUnexplained','legacy-intent');
      if(!entry)this.journal.record(`legacy-not-found:${intent.stream}:${intent.eventId}`,'commit-not-found',
        {eventId:intent.eventId,contentSha256:intent.contentSha256});
    }
    this.journal.coordinator.call('upgrade',{legacy:tail,state});
  }

  /** The DB exclusive writer fence is held through both positive verification and negative settlement.
   * Every append/expiry must take its shared transaction fence before publishing an intent.
   */
  recoverAtStart(): Promise<{ seal: SealState; recovered: number; notCommitted: number; streams: Record<AccessStream, RecoveryCount> }> {
    return this.sql.withWriterFence(async sql => {
      try { this.read(); } catch(error:any) { if(error.code!=='SealUpgradeRequired')throw error; await this.upgradeAtStart(sql); }
      const tails = {} as Record<AccessStream, ChainTail>;
      for (const stream of ACCESS_STREAMS) tails[stream] = await sql.tail(stream);
      if (this.read() === 'absent') {
        if (ACCESS_STREAMS.some(s => tails[s].sequence !== 0)) throw new SealRefused('SealMissing');
        this.change(state => { if (!state.tail) state.tail = { streams: tails, sealedAt: new Date().toISOString(), generation: ++state.generation }; });
      }
      const counts = {} as Record<AccessStream, RecoveryCount>;
      this.flushNotFound();
      for (const stream of ACCESS_STREAMS) {
        const before = (this.read() as SealState).streams[stream].sequence;
        await this.reconcileCommitted(stream, undefined, sql, true);
        let notCommitted = 0;
        for (const intent of Object.values(this.load().intents).filter(i => i.stream === stream)) {
          const marker = await sql.markerForAttempt(stream, intent.attemptId);
          if (marker) throw new SealRefused('UnsealedEntryUnexplained', 'unsettled-marker');
          this.journal.record(`commit-not-found:${stream}:${intent.attemptId}`, 'commit-not-found',
            { eventId: intent.eventId ?? `expiry:${intent.attemptId}`, contentSha256: intent.contentSha256 ?? digest(intent) });
          this.abort(stream, intent.attemptId); notCommitted++;
        }
        counts[stream] = { recovered: tails[stream].sequence - before, notCommitted };
      }
      const retired = Object.entries(this.load().terminal).filter(([, t]) => t.phase === 'committed' &&
        (!t.owner || !this.journal.coordinator.ownerAlive(t.owner))).map(([id]) => id);
      if (retired.length) this.change(state => { for (const id of retired) {
        const t = state.terminal[id];
        if (t?.phase === 'committed' && t.binding.sequence <= state.tail.streams[t.binding.stream].sequence) delete state.terminal[id];
      } });
      // Startup holds the writer fence, never a stream head lock.
      this.journal.coordinator.call('compact');
      return { seal: this.read() as SealState, streams: counts, recovered: ACCESS_STREAMS.reduce((n, s) => n + counts[s].recovered, 0),
        notCommitted: ACCESS_STREAMS.reduce((n, s) => n + counts[s].notCommitted, 0) };
    });
  }
}
