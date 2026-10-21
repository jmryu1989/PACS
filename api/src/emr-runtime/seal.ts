import { createHash, randomUUID } from 'node:crypto';
import { ACCESS_STREAMS, AccessStream, ChainPosition, accessStreams, parseAccessEvent } from '../emr-contract/access-event';
import { integer, refuse } from '../emr-contract/validation';
import { ChainTail, StoredEntry, chainViolation, retainedAnchor, canonicalPayload, entryHash } from './contract';
import { FailureJournal } from './failure-journal';
import { ExternalState, attestedProof, samePair, validateAttemptIdentities } from './external-writer';
import { BundleIdentity, PairIdentity, SealedBundleProof, StateProtocolError } from './state-protocol';
import type { PrismaLedgerSql, VerificationPage } from './store';
import { EMR_REPLAY_VERIFY_ROWS } from './limits';

export interface StreamSeal extends ChainPosition { chainId: string }
export interface SealState { streams: Readonly<Record<AccessStream, StreamSeal>>; sealedAt: string; generation: number }
export type SealRefusal = 'SealMissing' | 'SealCorrupt' | 'SealChainMismatch' | 'LedgerBehindSeal' | 'SealTailMismatch' |
  'LedgerChainBroken' | 'UnsealedEntryUnexplained' | 'SealUnavailable' | 'SealUpgradeRequired' | 'SealUnsupportedFormat';
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
const bindingFields = ['stream', 'chainId', 'attemptId', 'bundleId', 'kind', 'eventId', 'sequence',
  'previousHash', 'hash', 'contentSha256'] as const;
const sameBinding = (a: CommitBinding | Omit<CommitBinding, 'generation' | 'proofDigest'>,
  b: CommitBinding | Omit<CommitBinding, 'generation' | 'proofDigest'>) =>
  a && b && bindingFields.every(field => a[field] === b[field]);
const samePrefix = (a: { seal: StreamSeal; anchor: ChainPosition; count: number } | undefined,
  b: { seal: StreamSeal; anchor: ChainPosition; count: number } | undefined) =>
  !a || !b ? a === b : a.seal.chainId === b.seal.chainId && a.seal.sequence === b.seal.sequence &&
    a.seal.hash === b.seal.hash && a.anchor.sequence === b.anchor.sequence && a.anchor.hash === b.anchor.hash && a.count === b.count;

export interface ReservationAdmission {
  /** A service-owned scope object, never a token supplied directly by a caller. */
  origin: object;
  issuedPrefix?: { seal: StreamSeal; anchor: ChainPosition; count: number };
}

/** DB finality is trusted for response-unknown recovery, never described as independent proof.
 * The protected settlement frontier authorizes exact reservations and detects tail-only rollback.
 * Whole DB plus protected-state rollback requires an independent off-host witness (Stage 9).
 */
export class AccessSeal {
  constructor(_directory: string | undefined, private readonly sql: PrismaLedgerSql, private readonly journal: FailureJournal) {}
  private proofEpoch: string = randomUUID();
  // Weak ownership lets ended scopes disappear without forgetting durable identity.
  // A different scope cannot adopt an existing reservation, even for the same client.
  private origins = new WeakMap<object, Set<string>>();
  private attempts(state: ExternalState): Map<string, CommitBinding> {
    return validateAttemptIdentities(state);
  }
  private load(): ExternalState {
    try { return this.journal.coordinator.call('read'); }
    catch (error: any) { throw new SealRefused(/^Seal|^Ledger|^Unsealed/.test(error.code || '') ? error.code : 'SealUnavailable', error.detail); }
  }
  private change<T>(work: (state: ExternalState) => T, operation = 'update'): T {
    try { return this.journal.coordinator.call(operation, work).result; }
    catch (error: any) {
      if (error instanceof SealRefused || error instanceof StateProtocolError || error.name === 'ContractError') throw error;
      throw new SealRefused(/^Seal|^Ledger|^Unsealed/.test(error.code || '') ? error.code : 'SealUnavailable', error.detail);
    }
  }
  read(): SealState | 'absent' { return this.load().tail ?? 'absent'; }
  private addIntent(state: ExternalState, value: { stream: AccessStream; attemptId: string; eventId: string | null; contentSha256: string | null; bundleId: string }, owner: string): void {
    const id = key(value.stream, value.attemptId);
    const owned = { ...value, owner };
    if (state.intents[id] && !same(state.intents[id], owned)) refuse('AccessEventIdConflict');
    if (state.terminal[id]) refuse('AttemptAlreadySettled');
    state.intents[id] = owned;
  }

  /** Intent and exact reservation share one durable WAL record under the head lock.
   * EB008 prevents staged SQL from committing before this record is bound. Reusing
   * a slot proves that its old transaction ended without committing.
   */
  private reservationState: ExternalState | undefined;
  reserve(binding: Omit<CommitBinding, 'generation' | 'proofDigest'>, prefix?: { seal: StreamSeal; anchor: ChainPosition; count: number },
    owner: string = this.journal.coordinator.ownerId, admission?: ReservationAdmission): CommitBinding {
    let superseded = false;
    const origin = admission?.origin ?? this;
    const result = this.change(state => {
      const id = key(binding.stream, binding.attemptId), position = slot(binding.stream, binding.sequence);
      if (state.terminal[id]) refuse('AttemptAlreadySettled');
      const pending = this.attempts(state).get(id), intent = state.intents[id];
      if (pending) {
        if (intent.owner !== owner || !this.origins.get(origin)?.has(id) ||
          !sameBinding(pending, binding) || !samePrefix(state.proofs[id], prefix)) refuse('AccessEventIdConflict');
        return { binding: pending, state };
      }
      // A live replay uses its original durable proof; only an unseen identity
      // must match the scope's most recently issued expiry prefix.
      if (admission && prefix && !samePrefix(admission.issuedPrefix, prefix)) refuse('AccessEventIdConflict');
      if (!intent) this.addIntent(state, { stream: binding.stream, attemptId: binding.attemptId,
        eventId: binding.eventId, contentSha256: binding.contentSha256, bundleId: binding.bundleId }, owner);
      const prior = state.slots[position];
      if (prior) {
        superseded = true;
        const old = key(prior.stream, prior.attemptId);
        state.terminal[old] = { phase: 'superseded', generation: prior.generation, binding: prior,
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
    const admitted = this.origins.get(origin) ?? new Set<string>();
    admitted.add(key(binding.stream, binding.attemptId)); this.origins.set(origin, admitted);
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
      if (!reservation && !state.intents[id] && !state.terminal[id]) return;
      state.terminal[id] = { phase: 'aborted', generation: reservation?.generation ?? state.generation,
        ...(reservation ? { binding: reservation } : {}) };
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
    if (!full && (this.anchors.get(stream) === anchorKey ||
        (current.sequence === 0 && first?.sequence === 1 && first.previousHash === current.hash))) {
      const prefix = page?.entries.map(item => item.entry).filter(entry => entry.sequence <= end.sequence);
      const after = prefix?.length ? prefix[prefix.length - 1].sequence : current.sequence;
      const entries = prefix ? [...prefix, ...(prefix.length && after < end.sequence ? await this.range(sql, stream, end.sequence, after) : [])] :
        await this.range(sql, stream, end.sequence, current.sequence);
      const violation = chainViolation(current, entries, end, stream);
      if (violation) throw new SealRefused('LedgerChainBroken', `${stream}:${violation}`);
      this.anchors.set(stream, anchorKey);
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
          // A new replay cannot borrow another attempt's retained receipt. Only
          // advanceReceipt's exact attempt binding bypasses this DB-byte proof.
          if (sealed.sequence - target.sequence + 1 > EMR_REPLAY_VERIFY_ROWS)
            throw new SealRefused('SealUnavailable', 'replay-verification-limit');
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
      try {
        // A complete page is one PostgreSQL statement: tail, retained anchor,
        // entries and markers share its MVCC snapshot. With an already verified
        // anchor it needs no interactive transaction (BEGIN/fence/COMMIT).
        // A changed anchor or a multi-page range still uses RepeatableRead.
        const page = !recovering && target && target.sequence > sealed.sequence && target.sequence - sealed.sequence <= 1000 ?
          await reader.verificationPage(stream, sealed.sequence, target.sequence - sealed.sequence) : undefined;
        const anchorKey = page && JSON.stringify([page.tail.chainId, page.first?.sequence ?? 0, page.first?.previousHash ?? page.tail.hash]);
        const complete = page && page.entries[page.entries.length - 1]?.entry.sequence === target.sequence &&
          (this.anchors.get(stream) === anchorKey ||
          (sealed.sequence === 0 && page.first?.sequence === 1 && page.first.previousHash === sealed.hash));
        const verifySnapshot = async (sql: PrismaLedgerSql, page?: VerificationPage) => {
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
        };
        result = complete ? await verifySnapshot(reader, page) : await reader.snapshot(sql => verifySnapshot(sql));
      } catch(error) {
        // A concurrent expiry may replace the prefix after this frontier was read. Re-read
        // under a new DB snapshot only when the protected writer actually advanced its revision.
        if (!same(this.load().tail.streams[stream], sealed)) continue;
        throw error;
      }
      if (!result.unsealed.length) { this.reservationState = state; return state; }
      if (recovering) this.journal.record(`seal-recovered:${stream}:${result.current.sequence}-${result.end.sequence}`, 'seal-recovered',
        { chainId: result.current.chainId, fromSequence: result.current.sequence, toSequence: result.end.sequence, toHash: result.end.hash });
      // Settled slots can retire behind the frontier; their terminal identities must
      // remain durable so a delayed reserve cannot allocate the same attempt again.
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
        // Negative attempts also remain terminal. Forgetting one would permit an old RPC to reserve it anew.
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
          const result = this.change(state => {
            return { accepted: group.map(entry => Boolean(entry.install(state))), state };
          });
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

  /** A helper may seal and expire a row while its COMMIT response is in flight.
   * These bindings retain receipt evidence and permanently exclude reuse of a terminal
   * attempt. Neither acknowledgement nor a new process makes that identity available again.
   */
  committedReceipt(stream: AccessStream, attemptId: string, eventId: string, entry: StoredEntry): SealState | null {
    return this.receiptFrom(this.load(), stream, attemptId, eventId, entry);
  }
  /** The same protected snapshot that completed this batch proves its receipts.
   * Returning its exact binding avoids a second lock/read after publication; no
   * cached evidence is reused for a later request or after a failed publication. */
  async advanceReceipt(stream: AccessStream, attemptId: string, eventId: string, entry: StoredEntry): Promise<SealState | null> {
    // A helper can publish after this instance reserved, even while our COMMIT
    // response is delayed. Consult the current protected authority before adding
    // a DB dependency; a cached reservation must not hide an already sealed receipt.
    const current = this.load(), receipt = this.receiptFrom(current, stream, attemptId, eventId, entry);
    if (receipt) return receipt;
    // A replay owns neither a new reservation nor the original receipt attempt.
    // Its caller will read the event and bind its bytes through the sealed tail.
    if (current.slots[slot(stream, entry.sequence)]?.attemptId !== attemptId) return null;
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
  /** The caller verifies the full proof before acknowledging delivery. There is no
   * durable cleanup here: the existing terminal record is also reserve's permanent
   * exclusion authority, including after WAL compaction and service replacement. */
  acknowledge(_stream: AccessStream, _attemptId: string): Promise<void> {
    return Promise.resolve();
  }

  /** Complete publication is pinned once, after the independent SQL classification
   * and every stream's durable seal. Later coverage never changes an earlier proof. */
  async confirmBundle(bundle: BundleIdentity): Promise<SealedBundleProof> {
    const conflict = (): never => { throw new StateProtocolError('CONFLICT', 'conflict'); };
    const unavailable = (): never => { throw new StateProtocolError('UNAVAILABLE', 'unknown'); };
    const bundleId = bundle.bindings[0]?.bundleId;
    if (!bundleId || bundle.bindings.some(b => b.bundleId !== bundleId || b.eventId !== bundle.eventId) ||
      !same(bundle.bindings.map(b => b.stream), bundle.requiredStreams)) return conflict();
    const matches = (proof: SealedBundleProof) => {
      if (proof.eventId !== bundle.eventId || !same(proof.requiredStreams, bundle.requiredStreams) ||
        !same(proof.entries.map(({ sealed: _, ...b }) => b), bundle.bindings)) return conflict();
      return proof;
    };
    const retained = attestedProof(this.load(), bundleId);
    if (retained) return matches(retained);
    const entries = await this.sql.snapshot(async reader => {
      const stored: StoredEntry[] = [];
      let classified: readonly AccessStream[] | undefined;
      for (const binding of bundle.bindings) {
        const marker = await reader.markerForAttempt(binding.stream, binding.attemptId);
        const [row] = await reader.entriesAfter(binding.stream, binding.sequence - 1, 1);
        if (!marker || !row || row.sequence !== binding.sequence) return unavailable();
        if (!same(binding, marker) || row.eventId !== binding.eventId || row.hash !== binding.hash ||
          row.previousHash !== binding.previousHash || row.contentSha256 !== binding.contentSha256 || row.kind !== binding.kind ||
          entryHash(row.sequence, row.previousHash, row.payload) !== row.hash ||
          createHash('sha256').update(row.payload).digest('hex') !== row.contentSha256) return conflict();
        const required = row.kind === 'expiry' ? ['viewing'] as const : accessStreams(parseAccessEvent(JSON.parse(row.payload).event));
        if (row.kind !== 'expiry' &&
          canonicalPayload(parseAccessEvent(JSON.parse(row.payload).event), undefined, binding.stream).text !== row.payload) return conflict();
        if (classified && !same(classified, required)) return conflict();
        classified = required; stored.push(row);
      }
      if (!same(classified, bundle.requiredStreams)) return conflict();
      return stored;
    });
    const results = await Promise.allSettled(bundle.bindings.map(async (binding, i) => {
      const covered = binding.eventId !== null ?
        await this.advanceReceipt(binding.stream, binding.attemptId, binding.eventId, entries[i]) : null;
      const frontier = covered ?? await this.advance(binding.stream, { sequence: binding.sequence, hash: binding.hash });
      return { stream: binding.stream, attemptId: binding.attemptId,
        sealed: { sequence: frontier.streams[binding.stream].sequence, hash: frontier.streams[binding.stream].hash } };
    }));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    return this.change(state => {
      // Synchronous owner publication chooses the first winner for concurrent confirms.
      const existing = attestedProof(state, bundleId);
      if (existing) return matches(existing);
      state.bundles['bundle:' + bundleId] = { version: 1, phase: 'published', serviceEpoch: this.proofEpoch,
        eventId: bundle.eventId, requiredStreams: [...bundle.requiredStreams],
        refs: results.map(r => (r as PromiseFulfilledResult<any>).value) };
      return matches(attestedProof(state, bundleId));
    });
  }

  acknowledgeBundle(proof: SealedBundleProof, bindings: CommitBinding[]): 'acknowledged' | 'already-acknowledged' {
    const result = this.change(state => {
      const id = bindings[0]?.bundleId, actual = id && attestedProof(state, id);
      if (!actual || !same(actual, proof) || !same(actual.entries.map(({ sealed: _, ...b }) => b), bindings))
        throw new StateProtocolError('CONFLICT', 'conflict');
      const previous = state.bundles['bundle:' + id];
      if (previous.phase === 'acknowledged') return 'already-acknowledged' as const;
      state.bundles['bundle:' + id] = { version: 1, phase: 'acknowledged', serviceEpoch: previous.serviceEpoch,
        refs: previous.refs, proofSha256: digest(actual) };
      // Caller ownership is no longer required after exact full-proof delivery.
      for (const b of bindings) delete state.terminal[key(b.stream, b.attemptId)].owner;
      return 'acknowledged' as const;
    });
    // Remove the superseded representation from current WAL/checkpoint as well.
    // A failed compaction returns failure; the same exact ack can finish it later.
    this.journal.coordinator.call('compact', { force: true });
    return result;
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
    // Include never-confirmed COMMITs. This uses only shared reader snapshots and
    // completed publications, never startup's exclusive fence inside a live writer.
    for (const row of await this.range(sql, 'viewing', through, first.sequence - 1)) {
      const required = row.kind === 'expiry' ? ['viewing'] as const : accessStreams(parseAccessEvent(JSON.parse(row.payload).event));
      const bindings: CommitBinding[] = [];
      for (const stream of required) {
        const source = stream === 'viewing' ? row : await sql.entryForEvent(stream, row.eventId);
        const marker = source && await sql.markerForSlot(stream, source.sequence);
        if (!marker) throw new SealRefused('UnsealedEntryUnexplained', 'expiry-bundle');
        bindings.push(marker);
      }
      await this.confirmBundle({ eventId: row.eventId, requiredStreams: [...required], bindings });
    }
    return { seal: state.tail.streams.viewing, anchor: { sequence: through, hash: last.hash }, count: through - first.sequence + 1 };
  }

  /** The DB exclusive writer fence is held through both positive verification and negative settlement.
   * Every append/expiry must take its shared transaction fence before publishing an intent.
   */
  recoverAtStart(pair?: PairIdentity, serviceEpoch?: string): Promise<{ seal: SealState; recovered: number; notCommitted: number; streams: Record<AccessStream, RecoveryCount> }> {
    this.origins = new WeakMap();
    if (serviceEpoch) this.proofEpoch = serviceEpoch;
    return this.sql.withWriterFence(async sql => {
      if (pair) this.journal.coordinator.call('admit-pair', pair);
      this.read();
      // Refuse contradictory identities before journal settlement, publication
      // or compaction can normalize away the evidence.
      this.attempts(this.load());
      const tails = {} as Record<AccessStream, ChainTail>;
      for (const stream of ACCESS_STREAMS) tails[stream] = await sql.tail(stream);
      if (this.read() === 'absent') {
        if (ACCESS_STREAMS.some(s => tails[s].sequence !== 0)) throw new SealRefused('SealMissing');
        const origin: PairIdentity = pair ?? { instanceId: 'local-owner', database: await sql.identity(),
          chains: { viewing: tails.viewing.chainId, history: tails.history.chainId } };
        const state = this.load();
        state.lineage = { version: 1, id: randomUUID(), origin };
        state.tail = { streams: tails, sealedAt: new Date().toISOString(), generation: 1 };
        state.generation = 1; state.revision = 1;
        this.journal.coordinator.call('initialize', state);
      }
      const origin = this.load().lineage.origin;
      if (ACCESS_STREAMS.some(s => origin.chains[s] !== tails[s].chainId) ||
        pair && !samePair(origin, pair) || !pair && !same(origin.database, await sql.identity()))
        throw new SealRefused('SealChainMismatch', 'capture-lineage');
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
      // The exclusive PG fence proves transaction finality, not receipt delivery.
      // Preserve every terminal identity even after exact acknowledgement.
      for (const terminal of Object.values(this.load().terminal)) {
        if (terminal.phase !== 'aborted' || !terminal.binding) continue;
        const binding: CommitBinding = terminal.binding;
        if (await sql.markerForAttempt(binding.stream, binding.attemptId))
          throw new SealRefused('UnsealedEntryUnexplained', 'aborted-marker');
      }
      // Startup holds the writer fence, never a stream head lock.
      this.journal.coordinator.call('compact', { force: Object.values(this.load().bundles).some(a => a.phase === 'acknowledged') });
      return { seal: this.read() as SealState, streams: counts, recovered: ACCESS_STREAMS.reduce((n, s) => n + counts[s].recovered, 0),
        notCommitted: ACCESS_STREAMS.reduce((n, s) => n + counts[s].notCommitted, 0) };
    });
  }
}
