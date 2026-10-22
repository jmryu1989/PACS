import { createHash, randomUUID } from 'node:crypto';
import { ACCESS_STREAMS, AccessStream, ChainPosition, accessStreams, parseAccessEvent } from '../emr-contract/access-event';
import { integer, refuse } from '../emr-contract/validation';
import { ChainTail, StoredEntry, chainViolation, retainedAnchor, canonicalPayload, entryHash } from './contract';
import { FailureJournal } from './failure-journal';
import { ConversionFacts, CopyMapping, StateLineage, attestedProofFrom, samePair } from './external-writer';
import { lineageSha256 } from './checkpoint-v4';
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
/** The owner's verified view as the seal reads it: the small resident maps by reference (read-only here; every
 * change is an explicit patch), the two large maps by keyed lookup. Revision-bound: a later patch is a new view. */
interface View {
  revision: number; generation: number; tail: SealState | null; lineage: StateLineage | null; retired: Record<string, number>;
  intents: Record<string, any>; slots: Record<string, CommitBinding>; proofs: Record<string, ExpiryCore>;
  /** The stored major format (3 or 4) and, for a v4 root, its persisted DB witness (null otherwise). */
  format: 3 | 4; dbWitness: DbWitness | null;
}
/** Only the changed records (null deletes) and, for a publication, the new tail. A v4 owner also carries the verified
 * DB facts of the same transition: `dbBindings` (one per committed slot) and the advanced `dbWitness`. */
interface Changes { intents?: Record<string, any>; slots?: Record<string, any>; proofs?: Record<string, any>; terminal?: Record<string, any>; bundles?: Record<string, any>; retired?: Record<string, number>;
  dbBindings?: Record<string, { binding: CommitBinding; entrySha256: string | null } | null>; dbWitness?: DbWitness }
/** meta.dbWitness (order section 4.1): the verified sealed prefix per stream, the retained start and the exact expiry
 * anchor the owner validated; part of the same root/transition as its dbBindings, pending closure and tail. */
export interface DbWitness {
  version: 1; pair: PairIdentity; lineageSha256: string; validationRevision: string;
  streams: Record<AccessStream, { chainId: string; verifiedThrough: ChainPosition; retainedStart: { sequence: number; previousHash: string } | null;
    expiry: { attemptKey: string; binding: Omit<CommitBinding, 'proofDigest'>; coreSha256: string; deletedThrough: number; anchorHash: string } | null }>;
}
/** H(KIN-EMR-V4/db-entry, J([stream, sequence, previousHash, hash, kind, statutoryAct, eventId, payload, contentSha256, storedAt])). */
export function dbEntrySha256(stream: AccessStream, entry: StoredEntry): string {
  const canonicalArray = JSON.stringify([stream, entry.sequence, entry.previousHash, entry.hash, entry.kind, entry.statutoryAct, entry.eventId, entry.payload, entry.contentSha256, entry.storedAt]);
  return createHash('sha256').update('KIN-EMR-V4/db-entry', 'ascii').update(Buffer.from([0])).update(canonicalArray, 'utf8').digest('hex');
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
  private call<T = any>(operation: string, value?: any): T {
    try { return this.journal.coordinator.call(operation, value); }
    catch (error: any) {
      if (error instanceof SealRefused || error instanceof StateProtocolError || error.name === 'ContractError') throw error;
      const known = /^Seal|^Ledger|^Unsealed/.test(error.code || '');
      // An unexpected failure (not a seal refusal) keeps its own message as the detail: diagnosable, never a success.
      throw new SealRefused(known ? error.code : 'SealUnavailable', error.detail ?? (known ? null : String(error.message ?? error).slice(0, 200)));
    }
  }
  private view(): View { return this.call('view'); }
  private terminal(id: string): any { return this.call('get', { map: 'terminal', id }) ?? undefined; }
  private bundle(bundleId: string): any { return this.call('get', { map: 'bundles', id: 'bundle:' + bundleId }) ?? undefined; }
  private slotOf(id: string): string | undefined { return this.call('slot-of', id) ?? undefined; }
  /** One durable WAL record of exactly the changed records; `tail` makes it a publication (tail published, completion flushed). */
  private patch(changes: Changes, options: { kind?: 'update' | 'reserve'; generation?: number; tail?: SealState } = {}): void {
    this.call('patch', { changes, kind: options.kind ?? 'update', generation: options.generation, tail: options.tail ?? null });
  }
  read(): SealState | 'absent' { return this.view().tail ?? 'absent'; }
  /** The retained canonical proof of a published bundle from the current view (null when unknown). */
  private proofOf(bundleId: string, view = this.view()): SealedBundleProof | null {
    const a = this.bundle(bundleId);
    if (!a) return null;
    try { return attestedProofFrom(id => this.terminal(id), view, bundleId, a); }
    catch (error: any) { throw new SealRefused(/^Seal|^Unsealed/.test(error.code || '') ? error.code : 'SealCorrupt', error.detail); }
  }

  /** Intent and exact reservation share one durable WAL record under the head lock.
   * EB008 prevents staged SQL from committing before this record is bound. Reusing
   * a slot proves that its old transaction ended without committing.
   * Lookups: terminal K first, then pending K independently of the requested slot, then the destination slot.
   */
  reserve(binding: Omit<CommitBinding, 'generation' | 'proofDigest'>, prefix?: { seal: StreamSeal; anchor: ChainPosition; count: number },
    owner: string = this.journal.coordinator.ownerId, admission?: ReservationAdmission): CommitBinding {
    const origin = admission?.origin ?? this;
    const view = this.view();
    if (!view.tail) throw new SealRefused('SealMissing');
    const id = key(binding.stream, binding.attemptId), position = slot(binding.stream, binding.sequence);
    if (this.terminal(id)) refuse('AttemptAlreadySettled');
    const pendingPosition = this.slotOf(id), pending = pendingPosition ? view.slots[pendingPosition] : undefined, intent = view.intents[id];
    let result: CommitBinding, superseded = false;
    if (pending) {
      if (!intent || intent.owner !== owner || !this.origins.get(origin)?.has(id) ||
        !sameBinding(pending, binding) || !samePrefix(view.proofs[id], prefix)) refuse('AccessEventIdConflict');
      result = pending;
    } else {
      // A live replay uses its original durable proof; only an unseen identity
      // must match the scope's most recently issued expiry prefix.
      if (admission && prefix && !samePrefix(admission.issuedPrefix, prefix)) refuse('AccessEventIdConflict');
      const changes: Changes = { intents: {}, slots: {}, proofs: {}, terminal: {} };
      const owned = { stream: binding.stream, attemptId: binding.attemptId, eventId: binding.eventId, contentSha256: binding.contentSha256, bundleId: binding.bundleId, owner };
      if (intent && !same(intent, owned)) refuse('AccessEventIdConflict');
      if (!intent) changes.intents![id] = owned;
      const prior = view.slots[position];
      if (prior) {
        superseded = true;
        const old = key(prior.stream, prior.attemptId);
        changes.terminal![old] = { phase: 'superseded', generation: prior.generation, binding: prior,
          notFound: { eventId: prior.eventId ?? `expiry:${prior.attemptId}`, contentSha256: prior.contentSha256 } };
        changes.proofs![old] = null; changes.intents![old] = null;
      }
      const generation = view.generation + 1;
      const next = { ...binding, generation, proofDigest: null } as CommitBinding;
      if (prefix) {
        const { proofDigest: _, ...identity } = next;
        const core: ExpiryCore = { format: 1, binding: identity, ...prefix };
        next.proofDigest = digest(core);
        changes.proofs![id] = core;
      }
      changes.slots![position] = next;
      this.patch(changes, { kind: 'reserve', generation });
      result = next;
    }
    const admitted = this.origins.get(origin) ?? new Set<string>();
    admitted.add(id); this.origins.set(origin, admitted);
    if (superseded) this.flushNotFound();
    return result;
  }
  private flushNotFound(): void {
    const pending: [string, any][] = this.call('not-found');
    for (const [id, notFound] of pending) this.journal.record(`commit-not-found:${id}`, 'commit-not-found', notFound);
    if (!pending.length) return;
    const changes: Changes = { terminal: {} };
    for (const [id] of pending) {
      const terminal = this.terminal(id);
      if (!terminal) continue;
      const { notFound: _, ...rest } = terminal;
      changes.terminal![id] = rest;
    }
    if (Object.keys(changes.terminal!).length) this.patch(changes);
  }
  /** A proven callback rollback settles only its own attempt; unknown responses keep their evidence. */
  abort(stream: AccessStream, attemptId: string): void {
    const view = this.view(), id = key(stream, attemptId);
    const position = this.slotOf(id), reservation = position ? view.slots[position] : undefined, terminal = this.terminal(id);
    if (terminal?.phase === 'committed') throw new SealRefused('SealTailMismatch', 'abort-committed');
    if (!reservation && !view.intents[id] && !terminal) return;
    const changes: Changes = { terminal: {}, slots: {}, proofs: {}, intents: {} };
    changes.terminal![id] = { phase: 'aborted', generation: reservation?.generation ?? view.generation, ...(reservation ? { binding: reservation } : {}) };
    if (reservation) changes.slots![slot(stream, reservation.sequence)] = null;
    if (view.proofs[id]) changes.proofs![id] = null;
    if (view.intents[id]) changes.intents![id] = null;
    this.patch(changes);
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
  private proof(view: View, entry: StoredEntry, chainId: string): ExpiryCore | null {
    const q: CommitBinding = view.slots[slot('viewing', entry.sequence)];
    const core: ExpiryCore = q && view.proofs[key('viewing', q.attemptId)];
    if (!core || q.chainId !== chainId || q.kind !== 'expiry' || q.sequence !== entry.sequence || q.hash !== entry.hash ||
        q.previousHash !== entry.previousHash || q.contentSha256 !== entry.contentSha256 || (q.proofDigest !== digest(core) && !(q.attemptId === `legacy:${q.stream}:${q.sequence}` && q.proofDigest === null && q.sequence <= view.retired[q.stream])) ||
        !same(core.binding, (({ proofDigest: _, ...rest }) => rest)(q))) return null;
    let p: any;
    try { p = JSON.parse(entry.payload); } catch { throw new SealRefused('LedgerChainBroken', 'checkpoint-format'); }
    if (p.kind !== 'expiry' || p.deletedThrough !== core.anchor.sequence || p.anchorHash !== core.anchor.hash ||
        p.deletedCount !== core.count || core.seal.sequence + 1 !== entry.sequence || core.seal.hash !== entry.previousHash ||
        core.anchor.sequence > core.seal.sequence) return null;
    return core;
  }
  private async explain(sql: PrismaLedgerSql, view: View, stream: AccessStream, entry: StoredEntry, chainId: string, suppliedMarker?: CommitBinding | null): Promise<void> {
    const q: CommitBinding = view.slots[slot(stream, entry.sequence)];
    const marker = suppliedMarker === undefined ? await sql.markerForSlot(stream, entry.sequence) : suppliedMarker;
    if (!q || !marker || !same(q, marker) || q.chainId !== chainId || q.sequence !== entry.sequence || q.eventId !== entry.eventId ||
        q.hash !== entry.hash || q.previousHash !== entry.previousHash || q.contentSha256 !== entry.contentSha256 || q.kind !== entry.kind ||
        ['aborted', 'superseded'].includes(this.terminal(key(stream, q.attemptId))?.phase) ||
        (entry.kind === 'expiry' && !this.proof(view, entry, chainId)))
      throw new SealRefused('UnsealedEntryUnexplained', `${stream}:${entry.sequence}`);
  }
  private readonly anchors = new Map<AccessStream, string>();
  private readonly retainedStarts = new Map<AccessStream, number>();
  private readonly retainedFirst = new Map<AccessStream, { sequence: number; previousHash: string } | null>();
  private async verify(sql: PrismaLedgerSql, view: View, stream: AccessStream, tail: ChainTail,
    end: ChainPosition = tail, full = false, page?: VerificationPage): Promise<StoredEntry[]> {
    const current = view.tail!.streams[stream];
    if (tail.chainId !== current.chainId) throw new SealRefused('SealChainMismatch', stream);
    if (tail.sequence < current.sequence) throw new SealRefused('LedgerBehindSeal', stream);
    const first = page ? page.first : (await sql.entriesAfter(stream, 0, 1))[0];
    this.retainedStarts.set(stream, first?.sequence ?? 1);
    this.retainedFirst.set(stream, first ? { sequence: first.sequence, previousHash: first.previousHash } : null);
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
      const checkpoint = entries.find(e => e.kind === 'expiry' && same(this.proof(view, e, current.chainId)?.anchor, anchor));
      if (!checkpoint) throw new SealRefused('UnsealedEntryUnexplained', 'expiry-anchor');
      await this.explain(sql, view, stream, checkpoint, current.chainId);
    }
    const sealed = entries.find(e => e.sequence === current.sequence) ?? anchor;
    if (sealed.sequence !== current.sequence || sealed.hash !== current.hash) throw new SealRefused('SealTailMismatch', stream);
    this.anchors.set(stream, anchorKey);
    return entries;
  }
  /** Positive facts only. An unrelated pending intent is never a receipt prerequisite. */
  async reconcileCommitted(stream: AccessStream, target?: ChainPosition, reader = this.sql, recovering = false): Promise<SealState> {
    return (await this.reconcileState(stream, target, reader, recovering)).tail!;
  }
  private async bindSealedTarget(sql: PrismaLedgerSql, view: View, stream: AccessStream, target: ChainPosition): Promise<void> {
    const sealed = view.tail!.streams[stream];
    const tail = await sql.tail(stream);
    if (tail.chainId !== sealed.chainId) throw new SealRefused('SealChainMismatch', stream);
    if (tail.sequence < sealed.sequence) throw new SealRefused('LedgerBehindSeal', stream);
    const entries = await this.range(sql, stream, sealed.sequence, target.sequence - 1), first = entries[0];
    if (!first || first.sequence !== target.sequence || first.hash !== target.hash ||
        chainViolation({ sequence: first.sequence - 1, hash: first.previousHash }, entries, sealed, stream))
      throw new SealRefused('LedgerChainBroken', 'sealed-target');
  }
  private async reconcileState(stream: AccessStream, target?: ChainPosition, reader = this.sql, recovering = false): Promise<View> {
    // Publication reloads the actual verified view, merges exact bindings, and retries
    // if another writer advanced the frontier while SQL verification ran.
    for (;;) {
      const view = this.view();
      if (!view.tail) throw new SealRefused('SealMissing');
      const sealed = view.tail.streams[stream];
      if (target && target.sequence <= sealed.sequence && !recovering) {
        if (target.sequence === sealed.sequence && target.hash !== sealed.hash) throw new SealRefused('SealTailMismatch', 'target');
        try {
          // A new replay cannot borrow another attempt's retained receipt. Only
          // advanceReceipt's exact attempt binding bypasses this DB-byte proof.
          if (sealed.sequence - target.sequence + 1 > EMR_REPLAY_VERIFY_ROWS)
            throw new SealRefused('SealUnavailable', 'replay-verification-limit');
          await reader.snapshot(sql => this.bindSealedTarget(sql, view, stream, target));
        }
        catch (error) {
          if (!same(this.view().tail!.streams[stream], sealed)) continue;
          throw error;
        }
        return view;
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
        const entries = await this.verify(sql, view, stream, tail, requested, recovering, page);
        const own = entries.find(e => e.sequence === requested.sequence);
        if (requested.sequence > tail.sequence || (requested.sequence > sealed.sequence && (!own || own.hash !== requested.hash)))
          throw new SealRefused('SealTailMismatch', 'target');
        const end = requested;
        const current = view.tail!.streams[stream];
        const unsealed = entries.filter(e => e.sequence > current.sequence && e.sequence <= end.sequence);
        const markers = new Map(page?.entries.map(item => [item.entry.sequence, item.marker]));
        for (const entry of unsealed) await this.explain(sql, view, stream, entry, current.chainId, markers.get(entry.sequence));
        return { current, end, entries, unsealed };
        };
        result = complete ? await verifySnapshot(reader, page) : await reader.snapshot(sql => verifySnapshot(sql));
      } catch(error) {
        // A concurrent expiry may replace the prefix after this frontier was read. Re-read
        // under a new DB snapshot only when the protected writer actually advanced its revision.
        if (!same(this.view().tail!.streams[stream], sealed)) continue;
        throw error;
      }
      if (!result.unsealed.length) return view;
      if (recovering) this.journal.record(`seal-recovered:${stream}:${result.current.sequence}-${result.end.sequence}`, 'seal-recovered',
        { chainId: result.current.chainId, fromSequence: result.current.sequence, toSequence: result.end.sequence, toHash: result.end.hash });
      // Settled slots can retire behind the frontier; their terminal identities must
      // remain durable so a delayed reserve cannot allocate the same attempt again.
      const retained = new Set(Object.values(view.slots).filter(q => q.stream === stream && q.kind === 'expiry' &&
        q.sequence >= this.retainedStarts.get(stream)!).map(q => q.sequence));
      // Reservations/intents in other requests can change the global revision during
      // SQL verification. Merge only this verified frontier under the writer lock;
      // a changed frontier (including expiry) still requires a fresh DB snapshot.
      const installed = await this.publish(latest => {
        if (!same(latest.tail!.streams[stream], result.current)) return null;
        const changes: Changes = { terminal: {}, intents: {}, slots: {}, proofs: {}, retired: {} };
        for (const entry of result.unsealed) {
          const position = slot(stream, entry.sequence), q = latest.slots[position];
          const expected = view.slots[position];
          if (!q || !same(q, expected)) throw new SealRefused('UnsealedEntryUnexplained', position);
        }
        const tail: SealState = { streams: { ...latest.tail!.streams, [stream]: { chainId: result.current.chainId, ...result.end } },
          sealedAt: new Date().toISOString(), generation: latest.generation + 1 };
        let expiryWitness: DbWitness['streams'][AccessStream]['expiry'] | undefined;
        for (const entry of result.unsealed) {
          const position = slot(stream, entry.sequence), q = latest.slots[position], id = key(stream, q.attemptId);
          const owner = latest.intents[id]?.owner;
          changes.terminal![id] = { phase: 'committed', generation: q.generation, binding: q, ...(owner !== undefined ? { owner } : {}) };
          if (latest.intents[id]) changes.intents![id] = null;
          if (latest.format === 4) {
            // The verified DB fact of this committed slot and, for an expiry entry, the exact expiry anchor.
            (changes.dbBindings ??= {})[position] = { binding: q, entrySha256: dbEntrySha256(stream, entry) };
            if (q.kind === 'expiry') {
              const core = latest.proofs[id];
              if (!core) throw new SealRefused('UnsealedEntryUnexplained', position);
              const { proofDigest: _, ...binding } = q;
              expiryWitness = { attemptKey: id, binding, coreSha256: digest(core), deletedThrough: core.anchor.sequence, anchorHash: core.anchor.hash };
            }
          }
        }
        if (latest.format === 4) {
          const witness = latest.dbWitness!;
          changes.dbWitness = { ...witness, validationRevision: String(latest.revision + 1),
            streams: { ...witness.streams, [stream]: { ...witness.streams[stream], verifiedThrough: { sequence: result.end.sequence, hash: result.end.hash },
              retainedStart: this.retainedFirst.get(stream) ?? null, ...(expiryWitness ? { expiry: expiryWitness } : {}) } } };
        }
        let retired = latest.retired[stream];
        for (const [position, q] of Object.entries(latest.slots)) {
          if (q.stream !== stream || q.sequence > tail.streams[stream].sequence || retained.has(q.sequence)) continue;
          changes.slots![position] = null; if (latest.proofs[key(stream, q.attemptId)]) changes.proofs![key(stream, q.attemptId)] = null;
          retired = Math.max(retired, q.generation);
        }
        if (retired !== latest.retired[stream]) changes.retired![stream] = retired;
        // Negative attempts also remain terminal. Forgetting one would permit an old RPC to reserve it anew.
        return { changes, tail, generation: tail.generation };
      });
      if (installed) return installed;
    }
  }
  private publications: { install: (latest: View) => { changes: Changes; tail: SealState; generation: number } | null;
    resolve: (view: View | null) => void; reject: (error: unknown) => void }[] | null = null;
  /** Adjacent verified advances are installed in one turn, each as its own durable publication with all three
   * barriers (record, tail, completion). Only already-verified frontiers enter this group; it never waits for an
   * unrelated transaction to commit or acquire a head lock. */
  private publish(install: (latest: View) => { changes: Changes; tail: SealState; generation: number } | null): Promise<View | null> {
    return new Promise((resolve, reject) => {
      const item = { install, resolve, reject };
      if (this.publications) { this.publications.push(item); return; }
      this.publications = [item];
      setImmediate(() => {
        const group = this.publications!; this.publications = null;
        // Each install plans against a staged view that already reflects the earlier installs of this turn; the
        // accepted plans then form one record, one tail publication and one completion flush.
        const live = this.view();
        const staged: View = { ...live, tail: live.tail, retired: { ...live.retired }, intents: { ...live.intents }, slots: { ...live.slots }, proofs: { ...live.proofs }, dbWitness: live.dbWitness };
        const merged: Changes = { terminal: {}, intents: {}, slots: {}, proofs: {}, bundles: {}, retired: {}, dbBindings: {} };
        let tail: SealState | undefined, generation = live.generation, witness: DbWitness | undefined;
        const accepted: typeof group = [];
        for (const entry of group) {
          try {
            const plan = entry.install(staged);
            if (!plan) { entry.resolve(null); continue; }
            for (const name of ['intents', 'slots', 'proofs', 'retired'] as const) for (const [id, value] of Object.entries(plan.changes[name] ?? {})) {
              (merged[name] as any)[id] = value;
              if (name === 'retired') staged.retired[id] = value as number; else if (value === null) delete (staged as any)[name][id]; else (staged as any)[name][id] = value;
            }
            for (const name of ['terminal', 'bundles', 'dbBindings'] as const) for (const [id, value] of Object.entries(plan.changes[name] ?? {})) (merged[name] as any)[id] = value;
            if (plan.changes.dbWitness) { witness = plan.changes.dbWitness; staged.dbWitness = witness; }
            staged.tail = plan.tail; staged.generation = plan.generation; tail = plan.tail; generation = plan.generation;
            accepted.push(entry);
          } catch (error) { entry.reject(error); }
        }
        if (!accepted.length) return;
        try {
          for (const name of Object.keys(merged) as (keyof Changes)[]) if (name !== 'dbWitness' && !Object.keys(merged[name]!).length) delete merged[name];
          if (witness) merged.dbWitness = { ...witness, validationRevision: String(live.revision + 1) };
          this.patch(merged, { generation, tail });
          const after = this.view();
          for (const entry of accepted) entry.resolve(after);
        } catch (error) { for (const entry of accepted) entry.reject(error); }
      });
    });
  }
  private readonly advances = new Map<AccessStream, { target: ChainPosition; resolve: (view: View) => void; reject: (error: unknown) => void }[]>();
  /** Coalesce only requests whose COMMIT already finished. No pending transaction or unrelated
   * intent joins this group, and a newly arriving request never extends an in-flight snapshot.
   */
  async advance(stream: AccessStream, target: ChainPosition): Promise<SealState> {
    return (await this.advanceState(stream, target)).tail!;
  }
  private advanceState(stream: AccessStream, target: ChainPosition): Promise<View> {
    return new Promise((resolve, reject) => {
      const waiting = this.advances.get(stream);
      if (waiting) { waiting.push({ target, resolve, reject }); return; }
      const queue = [{ target, resolve, reject }];
      this.advances.set(stream, queue);
      const drain = async () => {
        while (queue.length) {
          const group = queue.splice(0), through = group.reduce((a, b) => a.sequence >= b.target.sequence ? a : b.target, group[0].target);
          try { const view = await this.reconcileState(stream, through); for (const item of group) item.resolve(view); }
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
    return this.receiptFrom(this.view(), stream, attemptId, eventId, entry);
  }
  /** The same protected view that completed this batch proves its receipts.
   * Returning its exact binding avoids a second lock/read after publication; no
   * cached evidence is reused for a later request or after a failed publication. */
  async advanceReceipt(stream: AccessStream, attemptId: string, eventId: string, entry: StoredEntry): Promise<SealState | null> {
    // A helper can publish after this instance reserved, even while our COMMIT
    // response is delayed. Consult the current protected authority before adding
    // a DB dependency; a cached reservation must not hide an already sealed receipt.
    const current = this.view(), receipt = this.receiptFrom(current, stream, attemptId, eventId, entry);
    if (receipt) return receipt;
    // A replay owns neither a new reservation nor the original receipt attempt.
    // Its caller will read the event and bind its bytes through the sealed tail.
    if (current.slots[slot(stream, entry.sequence)]?.attemptId !== attemptId) return null;
    const view = await this.advanceState(stream, { sequence: entry.sequence, hash: entry.hash });
    return this.receiptFrom(view, stream, attemptId, eventId, entry);
  }
  private receiptFrom(view: View, stream: AccessStream, attemptId: string, eventId: string, entry: StoredEntry): SealState | null {
    const q: CommitBinding = this.terminal(key(stream, attemptId))?.binding;
    if (!q || !view.tail || q.eventId !== eventId || q.hash !== entry.hash || q.sequence !== entry.sequence ||
        q.contentSha256 !== entry.contentSha256 || q.previousHash !== entry.previousHash ||
        q.chainId !== view.tail.streams[stream].chainId || q.sequence > view.tail.streams[stream].sequence) return null;
    return view.tail;
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
    const retained = this.proofOf(bundleId);
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
    // Synchronous owner publication chooses the first winner for concurrent confirms.
    const existing = this.proofOf(bundleId);
    if (existing) return matches(existing);
    const attestation = { version: 1, phase: 'published', serviceEpoch: this.proofEpoch,
      eventId: bundle.eventId, requiredStreams: [...bundle.requiredStreams],
      refs: results.map(r => (r as PromiseFulfilledResult<any>).value) };
    this.patch({ bundles: { ['bundle:' + bundleId]: attestation } });
    return matches(this.proofOf(bundleId)!);
  }

  /** An exact acknowledgement installs the minimal acknowledged representation and drops the live owner linkage in
   * one durable record. The superseded full representation leaves the active WAL/checkpoint at the next amortized
   * compaction (size-proportional), never by a whole-checkpoint rewrite per acknowledgement. */
  acknowledgeBundle(proof: SealedBundleProof, bindings: CommitBinding[]): 'acknowledged' | 'already-acknowledged' {
    const id = bindings[0]?.bundleId, actual = id && this.proofOf(id);
    if (!actual || !same(actual, proof) || !same(actual.entries.map(({ sealed: _, ...b }) => b), bindings))
      throw new StateProtocolError('CONFLICT', 'conflict');
    const previous = this.bundle(id);
    if (previous.phase === 'acknowledged') return 'already-acknowledged';
    const changes: Changes = { bundles: {}, terminal: {} };
    changes.bundles!['bundle:' + id] = { version: 1, phase: 'acknowledged', serviceEpoch: previous.serviceEpoch, refs: previous.refs, proofSha256: digest(actual) };
    // Caller ownership is no longer required after exact full-proof delivery.
    for (const b of bindings) {
      const terminal = this.terminal(key(b.stream, b.attemptId));
      if (terminal && terminal.owner !== undefined) { const { owner: _, ...rest } = terminal; changes.terminal![key(b.stream, b.attemptId)] = rest; }
    }
    this.patch(changes);
    return 'acknowledged';
  }

  /** Called in the deleting transaction, with its head lock held, before staging deletion. */
  async expiryPrefix(through: number): Promise<{ seal: StreamSeal; anchor: ChainPosition; count: number }> {
    const sql = this.sql;
    await this.reconcileCommitted('viewing', undefined, sql);
    const view = this.view();
    integer(through, 1);
    const [first] = await sql.entriesAfter('viewing', 0, 1);
    const [last] = await sql.entriesAfter('viewing', through - 1, 1);
    if (!last || last.sequence !== through) throw new SealRefused('LedgerChainBroken', 'expiry-prefix');
    if (!first || through < first.sequence || through > view.tail!.streams.viewing.sequence) throw new SealRefused('LedgerChainBroken', 'expiry-prefix');
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
    return { seal: view.tail!.streams.viewing, anchor: { sequence: through, hash: last.hash }, count: through - first.sequence + 1 };
  }

  /** The DB facts of a quiesced, fully recovered state for its first v3 -> v4 conversion (order section 5.3): the
   * witness (the sealed prefixes as the database shows them, the retained starts, the exact expiry anchors) and one
   * verified binding per retained committed row, read in pages with their markers, every row's chain and content
   * rechecked. The database must show exactly the sealed frontier: a source that is not quiesced is refused. */
  async conversionFacts(sql: PrismaLedgerSql = this.sql): Promise<ConversionFacts> {
    const view = this.view();
    if (!view.tail || !view.lineage) throw new SealRefused('SealMissing');
    const streams = {} as DbWitness['streams'];
    const dbBindings: [string, { binding: CommitBinding; entrySha256: string | null }][] = [];
    for (const stream of ACCESS_STREAMS) {
      const tail = await sql.tail(stream), sealed = view.tail.streams[stream];
      if (tail.chainId !== sealed.chainId) throw new SealRefused('SealChainMismatch', stream);
      if (tail.sequence !== sealed.sequence || tail.hash !== sealed.hash) throw new SealRefused('SealTailMismatch', 'conversion-' + stream);
      const first = (await sql.entriesAfter(stream, 0, 1))[0];
      const expirySlots = Object.entries(view.slots).filter(([, q]) => q.stream === stream && q.kind === 'expiry').map(([, q]) => q).sort((a, b) => b.sequence - a.sequence);
      let expiry: DbWitness['streams'][AccessStream]['expiry'] = null;
      if (expirySlots.length) {
        const q = expirySlots[0], core = view.proofs[key(stream, q.attemptId)];
        if (!core) throw new SealRefused('UnsealedEntryUnexplained', 'expiry-core');
        const { proofDigest: _, ...binding } = q;
        expiry = { attemptKey: key(stream, q.attemptId), binding, coreSha256: digest(core), deletedThrough: core.anchor.sequence, anchorHash: core.anchor.hash };
      }
      streams[stream] = { chainId: tail.chainId, verifiedThrough: { sequence: sealed.sequence, hash: sealed.hash },
        retainedStart: first ? { sequence: first.sequence, previousHash: first.previousHash } : null, expiry };
      let after = first ? first.sequence - 1 : sealed.sequence, previous: StoredEntry | null = null;
      while (after < sealed.sequence) {
        const page = await sql.verificationPage(stream, after, 1000);
        if (!page.entries.length) throw new SealRefused('LedgerChainBroken', 'conversion-page');
        for (const { entry, marker } of page.entries) {
          if (entry.sequence > sealed.sequence) break;
          if (!marker || marker.sequence !== entry.sequence || entryHash(entry.sequence, entry.previousHash, entry.payload) !== entry.hash ||
            createHash('sha256').update(entry.payload).digest('hex') !== entry.contentSha256 || (previous && (entry.sequence !== previous.sequence + 1 || entry.previousHash !== previous.hash)))
            throw new SealRefused('UnsealedEntryUnexplained', `${stream}:${entry.sequence}`);
          dbBindings.push([slot(stream, entry.sequence), { binding: marker, entrySha256: dbEntrySha256(stream, entry) }]);
          previous = entry;
        }
        const last = page.entries[page.entries.length - 1].entry.sequence;
        if (last <= after) throw new SealRefused('LedgerChainBroken', 'conversion-page');
        after = last;
      }
    }
    return { dbWitness: { version: 1, pair: view.lineage.origin, lineageSha256: lineageSha256(view.lineage), validationRevision: String(view.revision), streams }, dbBindings };
  }

  /** Whether the v4 owner's periodic complete check is due (overdue age, clock rollback) or in progress. */
  fullCheckDue(now: Date = new Date()): boolean {
    if (this.view().format !== 4) return false;
    const status = this.call('v4-status', { now: now.toISOString() });
    return status.sweep !== null || status.fullCheck.overdue === true;
  }
  /**
   * One bounded step of the v4 complete check (order section 2/4, V4-T10): the owner's storage sweep (every page and
   * member of the pinned root), then the database phase here - every retained committed row of both streams, read in
   * pages with its marker, compared with its stored verified binding (tree 8: the exact marker and the entry digest)
   * and the chain continuity - then the owner publishes the new fullCheck fact. A disagreement latches the owner at
   * once (`SealCorrupt`); no partial sweep ever moves the last-complete timestamp. Returns the owner's sweep summary.
   */
  async fullCheckStep(now: Date = new Date(), sql: PrismaLedgerSql = this.sql, budget?: number): Promise<any> {
    if (this.view().format !== 4) throw new SealRefused('SealUnsupportedFormat', 'full-check');
    const at = now.toISOString();
    let step = this.call('full-check', { now: at, ...(budget !== undefined ? { budget } : {}) });
    if (step.phase !== 'database') return step;
    if (!step.dbDone) {
      const witness = this.view().dbWitness;
      const cursor: { stream: AccessStream; after: number } = step.db ?? { stream: 'viewing', after: (witness.streams.viewing.retainedStart?.sequence ?? 1) - 1 };
      const stream = cursor.stream, w = witness.streams[stream];
      const page = await sql.verificationPage(stream, cursor.after, EMR_REPLAY_VERIFY_ROWS);
      let previous: StoredEntry | null = null, last = cursor.after;
      for (const { entry, marker } of page.entries) {
        if (entry.sequence > w.verifiedThrough.sequence) break;
        const stored = this.call('db-binding', slot(stream, entry.sequence));
        const disagreement = !marker || marker.sequence !== entry.sequence || !stored || stored.entrySha256 !== dbEntrySha256(stream, entry) ||
          digest(stored.binding) !== digest(marker) || entryHash(entry.sequence, entry.previousHash, entry.payload) !== entry.hash ||
          createHash('sha256').update(entry.payload).digest('hex') !== entry.contentSha256 ||
          (previous !== null && (entry.sequence !== previous.sequence + 1 || entry.previousHash !== previous.hash)) ||
          (previous === null && cursor.after > 0 && entry.sequence !== cursor.after + 1);
        if (disagreement) { this.call('full-check', { now: at, latch: `${stream}:${entry.sequence}` }); }
        previous = entry; last = entry.sequence;
      }
      const streamDone = last >= w.verifiedThrough.sequence || !page.entries.length || page.entries[page.entries.length - 1].entry.sequence > w.verifiedThrough.sequence;
      if (streamDone && last < w.verifiedThrough.sequence) this.call('full-check', { now: at, latch: `${stream}:missing-rows` });
      if (streamDone && stream === 'viewing') {
        const h = witness.streams.history;
        step = this.call('full-check', { now: at, db: { stream: 'history', after: (h.retainedStart?.sequence ?? 1) - 1 } });
      } else if (streamDone) step = this.call('full-check', { now: at, db: 'done' });
      else step = this.call('full-check', { now: at, db: { stream, after: last } });
      if (!step.dbDone) return step;
    }
    return this.call('full-check', { now: at, complete: true });
  }

  /** The DB exclusive writer fence is held through both positive verification and negative settlement.
   * Every append/expiry must take its shared transaction fence before publishing an intent.
   * (Full-restart recovery cost at the envelope is BLOCKED_DECISION per D1684: this path keeps its original passes.)
   */
  recoverAtStart(pair?: PairIdentity, serviceEpoch?: string, copy: CopyMapping | null = null): Promise<{ seal: SealState; recovered: number; notCommitted: number; streams: Record<AccessStream, RecoveryCount> }> {
    this.origins = new WeakMap();
    if (serviceEpoch) this.proofEpoch = serviceEpoch;
    if (copy && !pair) throw new SealRefused('SealChainMismatch', 'copy-target');
    return this.sql.withWriterFence(async sql => {
      // A private copy (D1656-T07) is admitted against its stored origin through the launch-scoped mapping; the
      // observed pair must be exactly the mapping's target. The origin lineage itself is never rewritten.
      if (pair) this.call('admit-pair', copy ? { pair, copy } : pair);
      if (copy && !samePair(pair!, copy.target)) throw new SealRefused('SealChainMismatch', 'copy-target');
      // Admission validated every stored identity before any journal settlement, publication or compaction.
      this.read();
      const tails = {} as Record<AccessStream, ChainTail>;
      for (const stream of ACCESS_STREAMS) tails[stream] = await sql.tail(stream);
      if (this.read() === 'absent') {
        // A pristine pair: no mapping can apply (there is no stored origin to map from).
        if (copy) throw new SealRefused('SealMissing', 'copy-source');
        if (ACCESS_STREAMS.some(s => tails[s].sequence !== 0)) throw new SealRefused('SealMissing');
        const origin: PairIdentity = pair ?? { instanceId: 'local-owner', database: await sql.identity(),
          chains: { viewing: tails.viewing.chainId, history: tails.history.chainId } };
        const state = { version: 3, revision: 1, generation: 1, tail: { streams: tails, sealedAt: new Date().toISOString(), generation: 1 },
          lineage: { version: 1, id: randomUUID(), origin }, bundles: {}, intents: {}, slots: {}, proofs: {}, terminal: {}, retired: { viewing: 0, history: 0 } };
        this.call('initialize', state);
      }
      const origin = this.view().lineage!.origin, expected = copy ? copy.source : pair;
      if (ACCESS_STREAMS.some(s => origin.chains[s] !== tails[s].chainId) ||
        expected && !samePair(origin, expected) || !expected && !same(origin.database, await sql.identity()))
        throw new SealRefused('SealChainMismatch', 'capture-lineage');
      const counts = {} as Record<AccessStream, RecoveryCount>;
      this.flushNotFound();
      const admitted = this.view();
      if (admitted.format === 4) {
        // A v4 owner restarts from its persisted DB witness: the sealed prefix it names was verified when it was
        // published, so only the DB suffix after it is verified here. A witness that names another pair or chain,
        // or a retained start the chain no longer has, cannot enter the fast path: the full path (anchor change)
        // applies through verify()'s own anchor rule.
        const witness = admitted.dbWitness!;
        if (!samePair(witness.pair, admitted.lineage!.origin)) throw new SealRefused('SealChainMismatch', 'witness-pair');
        for (const stream of ACCESS_STREAMS) {
          const w = witness.streams[stream], sealed = admitted.tail!.streams[stream];
          if (w.chainId !== tails[stream].chainId || w.verifiedThrough.sequence !== sealed.sequence || w.verifiedThrough.hash !== sealed.hash)
            throw new SealRefused('SealTailMismatch', 'witness-' + stream);
          // The anchor the witness vouches for: the fast path reuses it only while the chain's first retained row is the same.
          this.anchors.set(stream, JSON.stringify([w.chainId, w.retainedStart?.sequence ?? 0, w.retainedStart?.previousHash ?? '0'.repeat(64)]));
          this.retainedStarts.set(stream, w.retainedStart?.sequence ?? 1);
        }
      }
      for (const stream of ACCESS_STREAMS) {
        const before = (this.read() as SealState).streams[stream].sequence;
        await this.reconcileCommitted(stream, undefined, sql, admitted.format !== 4);
        let notCommitted = 0;
        for (const intent of Object.values(this.view().intents).filter(i => i.stream === stream)) {
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
      if (admitted.format !== 4) {
        // v3 (retained as it is): one SQL probe per historical aborted terminal over the materialized history.
        for (const terminal of Object.values(this.call('read').terminal) as any[]) {
          if (terminal.phase !== 'aborted' || !terminal.binding) continue;
          const binding: CommitBinding = terminal.binding;
          if (await sql.markerForAttempt(binding.stream, binding.attemptId))
            throw new SealRefused('UnsealedEntryUnexplained', 'aborted-marker');
        }
      } else {
        // v4: historic settled-negative keys are validated authority; only the pending work is resolved. Every
        // intent was settled above (its pending entry leaves with it); what remains pending is a journal obligation.
        for (const [pendingKey, work] of this.call('pending') as [string, any][]) {
          if (pendingKey.startsWith('attempt:')) throw new SealRefused('UnsealedEntryUnexplained', 'pending-unsettled');
          if (!this.journal.find(work.journalId)) throw new SealRefused('UnsealedEntryUnexplained', 'pending-journal');
        }
      }
      // Startup holds the writer fence, never a stream head lock; compaction is amortized, never forced here.
      this.call('compact', { force: false });
      return { seal: this.read() as SealState, streams: counts, recovered: ACCESS_STREAMS.reduce((n, s) => n + counts[s].recovered, 0),
        notCommitted: ACCESS_STREAMS.reduce((n, s) => n + counts[s].notCommitted, 0) };
    });
  }
}
