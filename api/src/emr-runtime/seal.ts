import { createHash } from 'node:crypto';
import { ACCESS_STREAMS, AccessStream, ChainPosition } from '../emr-contract/access-event';
import { integer, refuse } from '../emr-contract/validation';
import { ChainTail, StoredEntry, chainViolation, retainedAnchor } from './contract';
import { FailureJournal } from './failure-journal';
import { ExternalState } from './external-writer';
import type { PrismaLedgerSql } from './store';

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
  private publish(state: ExternalState): boolean {
    const before = state.revision;
    state.revision++;
    try { return this.journal.coordinator.call('compare-and-set', { before, state }).changed; }
    catch (error: any) { throw new SealRefused(/^Seal|^Ledger|^Unsealed/.test(error.code || '') ? error.code : 'SealUnavailable', error.detail); }
  }
  private change<T>(work: (state: ExternalState) => T): T {
    for (;;) { const state = this.load(), result = work(state); if (this.publish(state)) return result; }
  }
  read(): SealState | 'absent' { return this.load().tail ?? 'absent'; }
  recordIntent(stream: AccessStream, attemptId: string, eventId: string | null, contentSha256: string | null, bundleId: string): void {
    this.change(state => {
      const id = key(stream, attemptId), value = { stream, attemptId, eventId, contentSha256, bundleId };
      if (state.intents[id] && !same(state.intents[id], value)) refuse('AccessEventIdConflict');
      if (state.terminal[id]) refuse('AttemptAlreadySettled');
      state.intents[id] = value;
    });
  }

  /** Only called with the stream's DB head lock, after staging the exact row and before COMMIT.
   * Reusing a slot proves that its old reservation's transaction has ended without committing.
   */
  reserve(binding: Omit<CommitBinding, 'generation' | 'proofDigest'>, prefix?: { seal: StreamSeal; anchor: ChainPosition; count: number }): CommitBinding {
    return this.change(state => {
      const id = key(binding.stream, binding.attemptId), position = slot(binding.stream, binding.sequence);
      if (!state.intents[id]) throw new SealRefused('UnsealedEntryUnexplained', 'intent-missing');
      const prior = state.slots[position];
      if (prior?.attemptId === binding.attemptId) return prior;
      if (prior) {
        const old = key(prior.stream, prior.attemptId);
        state.terminal[old] = { phase: 'superseded', generation: prior.generation };
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
      return next;
    });
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
  private async range(sql: PrismaLedgerSql, stream: AccessStream, through: number): Promise<StoredEntry[]> {
    const entries: StoredEntry[] = []; let after = 0;
    while (after < through) {
      const page = await sql.entriesAfter(stream, after, 1000);
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
    const p = JSON.parse(entry.payload);
    if (p.kind !== 'expiry' || p.deletedThrough !== core.anchor.sequence || p.anchorHash !== core.anchor.hash ||
        p.deletedCount !== core.count || core.seal.sequence + 1 !== entry.sequence || core.seal.hash !== entry.previousHash ||
        core.anchor.sequence > core.seal.sequence) return null;
    return core;
  }
  private async explain(sql: PrismaLedgerSql, state: ExternalState, stream: AccessStream, entry: StoredEntry, chainId: string): Promise<void> {
    const q: CommitBinding = state.slots[slot(stream, entry.sequence)];
    const marker = await sql.markerForSlot(stream, entry.sequence);
    if (!q || !marker || !same(q, marker) || q.chainId !== chainId || q.sequence !== entry.sequence || q.eventId !== entry.eventId ||
        q.hash !== entry.hash || q.previousHash !== entry.previousHash || q.contentSha256 !== entry.contentSha256 || q.kind !== entry.kind ||
        ['aborted', 'superseded'].includes(state.terminal[key(stream, q.attemptId)]?.phase) ||
        (entry.kind === 'expiry' && !this.proof(state, entry, chainId)))
      throw new SealRefused('UnsealedEntryUnexplained', `${stream}:${entry.sequence}`);
  }
  private async verify(sql: PrismaLedgerSql, state: ExternalState, stream: AccessStream, tail: ChainTail): Promise<StoredEntry[]> {
    const current = state.tail.streams[stream];
    if (tail.chainId !== current.chainId) throw new SealRefused('SealChainMismatch', stream);
    if (tail.sequence < current.sequence) throw new SealRefused('LedgerBehindSeal', stream);
    const entries = await this.range(sql, stream, tail.sequence), anchor = retainedAnchor(entries);
    if (tail.sequence === 0) {
      if (tail.hash !== current.hash) throw new SealRefused('SealTailMismatch', stream);
      return entries;
    }
    if (!anchor) throw new SealRefused('LedgerChainBroken', 'unjustified-start');
    if (anchor.sequence > current.sequence) throw new SealRefused('SealTailMismatch', stream);
    if (anchor.sequence > 0) {
      const checkpoint = entries.find(e => e.kind === 'expiry' && same(this.proof(state, e, current.chainId)?.anchor, anchor));
      if (!checkpoint) throw new SealRefused('UnsealedEntryUnexplained', 'expiry-anchor');
      await this.explain(sql, state, stream, checkpoint, current.chainId);
    }
    const violation = chainViolation(anchor, entries, tail, stream);
    if (violation) throw new SealRefused('LedgerChainBroken', `${stream}:${violation}`);
    const sealed = entries.find(e => e.sequence === current.sequence) ?? anchor;
    if (sealed.sequence !== current.sequence || sealed.hash !== current.hash) throw new SealRefused('SealTailMismatch', stream);
    return entries;
  }
  /** Positive facts only. An unrelated pending intent is never a receipt prerequisite. */
  async reconcileCommitted(stream: AccessStream, target?: ChainPosition, reader = this.sql, recovering = false): Promise<SealState> {
    for (;;) {
      const state = this.load();
      if (!state.tail) throw new SealRefused('SealMissing');
      let result: {current: StreamSeal; end: ChainPosition; entries: StoredEntry[]; unsealed: StoredEntry[]};
      try { result = await reader.snapshot(async sql => {
        const tail = await sql.tail(stream), entries = await this.verify(sql, state, stream, tail);
        const end = target ?? tail, own = entries.find(e => e.sequence === end.sequence);
        if (end.sequence > tail.sequence || (end.sequence > 0 && (!own || own.hash !== end.hash)))
          throw new SealRefused('SealTailMismatch', 'target');
        const current = state.tail.streams[stream];
        const unsealed = entries.filter(e => e.sequence > current.sequence && e.sequence <= end.sequence);
        for (const entry of unsealed) await this.explain(sql, state, stream, entry, current.chainId);
        return { current, end, entries, unsealed };
      }); } catch(error) {
        // A concurrent expiry may replace the prefix after this frontier was read. Re-read
        // under a new DB snapshot only when the protected writer actually advanced its revision.
        if(this.load().revision!==state.revision)continue;
        throw error;
      }
      if (result.end.sequence > result.current.sequence) {
        if (recovering) this.journal.record(`seal-recovered:${stream}:${result.current.sequence}-${result.end.sequence}`, 'seal-recovered',
          { chainId: result.current.chainId, fromSequence: result.current.sequence, toSequence: result.end.sequence, toHash: result.end.hash });
        state.tail = { streams: { ...state.tail.streams, [stream]: { chainId: result.current.chainId, ...result.end } },
          sealedAt: new Date().toISOString(), generation: ++state.generation };
      }
      for (const entry of result.unsealed) {
        const q = state.slots[slot(stream, entry.sequence)], id = key(stream, q.attemptId);
        state.terminal[id] = { phase: 'committed', generation: q.generation, binding: q };
        delete state.intents[id];
      }
      // The sealed frontier replaces terminal per-event authority. Keep only retained checkpoint lineage and unresolved slots.
      const retained = new Set(result.entries.filter(e => e.kind === 'expiry').map(e => e.sequence));
      for (const [position, q] of Object.entries(state.slots)) {
        if (q.stream !== stream || q.sequence > state.tail.streams[stream].sequence || retained.has(q.sequence)) continue;
        delete state.slots[position]; delete state.proofs[key(stream, q.attemptId)];
        state.retired[stream] = Math.max(state.retired[stream], q.generation);
      }
      for (const [id, t] of Object.entries(state.terminal)) if (id.startsWith(stream + ':') && t.phase !== 'committed' && t.generation <= state.retired[stream]) delete state.terminal[id];
      if (this.publish(state)) return state.tail;
    }
  }
  advance(stream: AccessStream, target: ChainPosition): Promise<SealState> { return this.reconcileCommitted(stream, target); }

  /** A helper may seal and expire a row while its COMMIT response is in flight. This temporary
   * metadata contains no payload and survives until that attempt acknowledges. Another process's
   * startup fences DB transactions, not responses already in flight, so it must retain these bindings.
   */
  committedReceipt(stream: AccessStream, attemptId: string, eventId: string, entry: StoredEntry): SealState | null {
    const state = this.load(), q: CommitBinding = state.terminal[key(stream, attemptId)]?.binding;
    if (!q || q.eventId !== eventId || q.hash !== entry.hash || q.sequence !== entry.sequence ||
        q.contentSha256 !== entry.contentSha256 || q.previousHash !== entry.previousHash ||
        q.chainId !== state.tail.streams[stream].chainId || q.sequence > state.tail.streams[stream].sequence) return null;
    return state.tail;
  }
  acknowledge(stream: AccessStream, attemptId: string): void {
    this.change(state => {
      const id = key(stream, attemptId);
      if (state.terminal[id]?.phase === 'committed') delete state.terminal[id];
    });
  }

  /** Called in the deleting transaction, with its head lock held, before staging deletion. */
  async expiryPrefix(through: number): Promise<{ seal: StreamSeal; anchor: ChainPosition; count: number }> {
    const sql = this.sql;
    await this.reconcileCommitted('viewing', undefined, sql);
    const state = this.load(), tail = await sql.tail('viewing');
    const entries = await this.verify(sql, state, 'viewing', tail), prefix = entries.filter(e => e.sequence <= integer(through, 1));
    const last = prefix[prefix.length - 1];
    if (!last || last.sequence !== through) throw new SealRefused('LedgerChainBroken', 'expiry-prefix');
    return { seal: state.tail.streams.viewing, anchor: { sequence: through, hash: last.hash }, count: prefix.length };
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
      return { seal: this.read() as SealState, streams: counts, recovered: ACCESS_STREAMS.reduce((n, s) => n + counts[s].recovered, 0),
        notCommitted: ACCESS_STREAMS.reduce((n, s) => n + counts[s].notCommitted, 0) };
    });
  }
}
