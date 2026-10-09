import { createHash } from 'node:crypto';
import { choice, freeze, integer, object, refuse, sha256, string, utc } from '../emr-contract/validation';
import { QueueEntry, QueueOwner, parseQueueEntry, parseQueueOwner, queueEntryDigest, sameOwner } from '../emr-signature/native-port';
import { OfflinePolicy, requireOfflinePolicy } from './offline-grant';
import { mayRemoveLocalOriginal } from './retention';
import { AdoptedEvent, parseAdoptedEvent } from './contract';

/**
 * Reference model of the device queue that C-NATIVE implements. A signed approval becomes "pending" only after the
 * durable store acknowledged the exact entry; afterwards it is sent with its original eventId until the server answers.
 * The store port here is the native protected store; an in-memory or localStorage stand-in is never durability evidence.
 */
export type QueueState = 'pending' | 'awaiting-reauth' | 'sent-unknown' | 'committed' | 'conflict' | 'held' | 'refused' | 'corrupt';
export interface DurableQueuePort {
  reserve(bytes: number): Promise<unknown>;
  put(entry: Readonly<QueueEntry>, digest: string): Promise<unknown>;
  list(owner: Readonly<QueueOwner>): Promise<unknown>;
  setState(eventId: string, state: QueueState, evidence: unknown): Promise<void>;
  remove(eventId: string, receipt: unknown): Promise<void>;
  /** Commit evidence outlives the original: kept before removal so dependants still see their predecessor as applied. */
  keepCommitEvidence(eventId: string, receipt: unknown): Promise<void>;
  commitEvidence(owner: Readonly<QueueOwner>): Promise<unknown>;
}
export interface QueueTransport {
  submit(entry: Readonly<QueueEntry>): Promise<unknown>;
  /** Authenticated receipt lookup for a missing predecessor; never manufactures a new chain. */
  findAdoption?(eventId: string, dependent: Readonly<QueueEntry>): Promise<unknown>;
}
export interface QueueControl {
  active(): boolean;
  changed(entry: Readonly<QueueEntry>, state: QueueState, evidence: unknown): void;
}
export interface RetentionReceiptVerifier { verify(receipt: unknown, entry: Readonly<QueueEntry>): boolean }

/**
 * Connection problems are not the end of a session: the work continues and the queue waits. Only U5's session-end
 * signals (401 AUTH_SESSION_ENDED; 403/409 AUTH_SESSION_MISMATCH, the cookie belongs to another login) move the queue to
 * "send after re-authentication", and even then nothing is deleted.
 */
export function classifySessionSignal(signal: unknown): 'continue-offline' | 'awaiting-reauth' {
  const s = (signal && typeof signal === 'object' ? signal : {}) as { kind?: unknown; status?: unknown; code?: unknown };
  const kind = choice(s.kind, ['network', 'timeout', 'http']);
  if (kind === 'http' && s.status === 401 && s.code === 'AUTH_SESSION_ENDED') return 'awaiting-reauth';
  if (kind === 'http' && [403, 409].includes(s.status as number) && s.code === 'AUTH_SESSION_MISMATCH') return 'awaiting-reauth';
  return 'continue-offline';
}

export interface QueueSession { state: 'active' | 'ended'; issuer: string; subject: string; institutionId: string; deviceId: string; osUserId: string }
function parseSession(input: unknown): Readonly<QueueSession> {
  const s = object(input, ['state', 'issuer', 'subject', 'institutionId', 'deviceId', 'osUserId']);
  return freeze({ state: choice(s.state, ['active', 'ended']), issuer: string(s.issuer), subject: string(s.subject), institutionId: string(s.institutionId),
    deviceId: string(s.deviceId), osUserId: string(s.osUserId) });
}
/** Another account on the same device can neither see, send nor re-sign the queue of the clinician who owns it. */
export function queueAccess(owner: QueueOwner, sessionInput: unknown): 'own' | 'other-account' {
  const session = parseSession(sessionInput);
  return sameOwner(owner, { issuer: session.issuer, subject: session.subject, institutionId: session.institutionId, deviceId: session.deviceId, osUserId: session.osUserId })
    ? 'own' : 'other-account';
}

/** Queue space J is reserved before any new image is loaded; without it nothing is loaded and nothing is Offline Ready. */
export async function prepareOfflineWork(store: DurableQueuePort, policyInput: unknown, loadImages: () => Promise<void>): Promise<Readonly<{
  reserved: { reservationId: string; bytes: number } | null; loaded: boolean;
}>> {
  const policy: OfflinePolicy = requireOfflinePolicy(policyInput);
  let reserved: { reservationId: string; bytes: number } | null = null;
  try {
    const r = object(await store.reserve(policy.reserveBytesJ), ['reservationId', 'bytes']);
    if (integer(r.bytes) < policy.reserveBytesJ) throw new Error('Short reservation');
    reserved = { reservationId: string(r.reservationId), bytes: r.bytes };
  } catch { return freeze({ reserved: null, loaded: false }); }
  await loadImages();
  return freeze({ reserved, loaded: true });
}

const codeOf = (error: unknown) => (error as { code?: string })?.code ?? 'StoreWriteFailed';
interface Row { entry: Readonly<QueueEntry> | null; eventId: string; digest: string; state: QueueState; sequence: number; blocked: boolean; evidence: any }

export function createOfflineQueue(options: { store: DurableQueuePort; owner: QueueOwner }) {
  const store = options.store, owner = parseQueueOwner(options.owner);
  const attempts = new Map<string, number>(), committed = new Set<string>();

  function parseDurable(input: unknown, entry: Readonly<QueueEntry>, digest: string) {
    const d = object(input, ['eventId', 'entryId', 'digest', 'durableAt']);
    if (d.eventId !== entry.eventId || sha256(d.digest) !== digest) refuse('DurableReceiptRequired');
    return freeze({ eventId: d.eventId as string, entryId: string(d.entryId), digest: d.digest as string, durableAt: utc(d.durableAt) });
  }

  /** Read back only this owner's area; a row of another owner returned by the store is a store fault, never skipped. */
  async function rows(): Promise<Row[]> {
    const listed = await store.list(owner);
    if (!Array.isArray(listed)) refuse('QueueListingRefused');
    const out: Row[] = listed.map(raw => {
      const r = object(raw, ['entry', 'digest', 'state', ...(Object.prototype.hasOwnProperty.call(raw, 'evidence') ? ['evidence'] : [])]);
      const state = choice(r.state, ['pending', 'awaiting-reauth', 'sent-unknown', 'committed', 'conflict', 'held', 'refused', 'corrupt']);
      let entry: Readonly<QueueEntry> | null = null;
      try { entry = parseQueueEntry(r.entry); } catch { entry = null; }
      if (entry && !sameOwner(entry.owner, owner)) refuse('OwnerMismatch');
      const intact = entry !== null && queueEntryDigest(entry) === r.digest;
      return { entry: intact ? entry : null, eventId: entry?.eventId ?? String((r.entry as any)?.eventId ?? ''), digest: String(r.digest),
        // A damaged row keeps its stored position when readable; an unreadable position blocks everything after the start.
        state: intact ? state : 'corrupt', sequence: entry?.deviceSequence ?? (Number.isSafeInteger((r.entry as any)?.deviceSequence) ? (r.entry as any).deviceSequence : -1), blocked: false, evidence: r.evidence ?? null };
    });
    out.sort((a, b) => a.sequence - b.sequence);
    // Order evidence is broken after a damaged or duplicated entry: later entries wait instead of being sent past it.
    const seen = new Set<number>();
    let broken = false;
    for (const row of out) {
      if (row.state === 'corrupt' || seen.has(row.sequence)) { broken = true; row.state = 'corrupt'; row.entry = null; continue; }
      seen.add(row.sequence);
      if (broken && ['pending', 'sent-unknown', 'awaiting-reauth', 'held'].includes(row.state)) { row.state = 'held'; row.blocked = true; }
    }
    return out;
  }

  async function keptCommits(): Promise<Readonly<AdoptedEvent>[]> {
    const listed = await store.commitEvidence(owner);
    if (!Array.isArray(listed)) refuse('CommitEvidenceRefused');
    return listed.map(parseAdoptedEvent);
  }

  const payloadOf = (entry: Readonly<QueueEntry>) => JSON.parse(Buffer.from(entry.envelope.payload, 'base64url').toString('utf8'));
  function matchesParent(e: Readonly<QueueEntry>, prior: Readonly<AdoptedEvent>) {
    const p = payloadOf(e);
    return prior.eventId === e.predecessorEventId && prior.studyId === e.access.target.studyId && prior.institutionId === e.access.managingInstitutionId &&
      JSON.stringify(prior.version) === JSON.stringify(p.previousVersion) && !prior.ancestors.includes(e.eventId) && prior.eventId !== e.eventId &&
      (prior.deviceId !== e.owner.deviceId || prior.deviceSequence < e.deviceSequence);
  }
  function ownAdoption(input: unknown, entry: Readonly<QueueEntry>) {
    const a = parseAdoptedEvent(input), p = payloadOf(entry);
    const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
    const versionSha = hash(Buffer.from(entry.envelope.payload, 'base64url'));
    const contentDigest = hash(`signed:${versionSha}:${hash(`${entry.envelope.protected}.${entry.envelope.payload}.${entry.envelope.signature}`)}:clinical`);
    if (a.eventId !== entry.eventId || a.studyId !== p.studyId || a.institutionId !== p.managingInstitutionId || a.version.recordId !== p.recordId ||
        a.version.versionId !== p.versionId || a.version.sha256 !== versionSha || a.signedAt !== p.signedAt ||
        a.deviceId !== p.deviceId || a.deviceSequence !== p.deviceSequence || a.predecessorEventId !== p.predecessorEventId ||
        a.receipt.contentDigest !== contentDigest) refuse('ResponseBindingRefused');
    return a;
  }

  return Object.freeze({
    /** Pending only after the durable receipt for this exact entry; a failed or partial write is "not saved". */
    async enqueue(input: unknown): Promise<Readonly<{ status: 'pending-offline'; receipt: { eventId: string; entryId: string; digest: string; durableAt: string } } | { status: 'not-saved'; code: string }>> {
      const entry = parseQueueEntry(input);
      if (!sameOwner(entry.owner, owner)) refuse('OwnerMismatch');
      const digest = queueEntryDigest(entry);
      let receipt: { eventId: string; entryId: string; digest: string; durableAt: string };
      try { receipt = parseDurable(await store.put(entry, digest), entry, digest); }
      catch (error) { return freeze({ status: 'not-saved' as const, code: codeOf(error) }); }
      return freeze({ status: 'pending-offline' as const, receipt });
    },

    /**
     * After a restart: intact entries resume, damaged ones are kept as corrupt (neither sent nor deleted) and entries
     * after them wait. Detecting a silently deleted entry needs the runtime's protected chain (C-NATIVE), not this model.
     */
    async recover(): Promise<readonly { eventId: string; state: QueueState }[]> {
      return freeze((await rows()).map(row => ({ eventId: row.eventId, state: row.state })));
    },

    /**
     * Send in device order with the original eventId. Dependants of an unresolved or conflicting event are held, a
     * connection failure leaves the entry for a retry, and AUTH_SESSION_ENDED pauses everything until re-authentication.
     */
    async send(transport: QueueTransport, sessionInput: unknown, control?: QueueControl): Promise<readonly { eventId: string; state: QueueState; retryable: boolean }[]> {
      const active = () => !control || control.active();
      const session = parseSession(sessionInput);
      if (queueAccess(owner, session) !== 'own') refuse('OwnerMismatch');
      const list = await rows();
      if (!active()) return [];
      const state = new Map(list.map(r => [r.eventId, r.state]));
      const kept = new Map((await keptCommits()).map(a => [a.eventId, a]));
      if (!active()) return [];
      const retry = new Set<string>();
      // Recover the display projection for every intact event first. Display selection never controls dispatch.
      for (const row of list) {
        if (!active()) return [];
        if (row.entry) control?.changed(row.entry, row.state, row.evidence);
      }
      const set = async (eventId: string, next: QueueState, evidence: unknown) => {
        if (!active() || (committed.has(eventId) && next !== 'committed')) return;
        await store.setState(eventId, next, evidence);
        if (!active()) return;
        state.set(eventId, next);
        if (next === 'committed') committed.add(eventId);
        const row = list.find(r => r.eventId === eventId);
        if (row?.entry) control?.changed(row.entry, next, evidence);
      };
      if (session.state === 'ended') {
        for (const row of list) if (['pending', 'sent-unknown'].includes(row.state)) await set(row.eventId, 'awaiting-reauth', null);
        return freeze(list.map(r => ({ eventId: r.eventId, state: state.get(r.eventId)!, retryable: false })));
      }
      const blockedRecords = new Set<string>();
      for (const row of list) {
        if (!active()) break;
        if (!row.entry || row.blocked) continue;
        const record = JSON.stringify([row.entry.access.target.studyId, row.entry.access.target.recordId]);
        if (['conflict', 'refused', 'corrupt'].includes(state.get(row.eventId)!)) { blockedRecords.add(record); continue; }
        if (state.get(row.eventId) === 'committed') continue;
        // Time/evidence holds are not automatically adopted. Technical predecessor holds are reevaluated each pass.
        if (row.state === 'held' && row.evidence?.reason && row.evidence.reason !== 'predecessor-unresolved') { blockedRecords.add(record); continue; }
        if (blockedRecords.has(record)) { await set(row.eventId, 'held', { reason: 'predecessor-unresolved' }); continue; }
        control?.changed(row.entry, state.get(row.eventId)!, row.evidence);
        const predecessor = row.entry.predecessorEventId;
        if (predecessor !== null && !kept.has(predecessor) && !list.some(r => r.eventId === predecessor) && transport.findAdoption) {
          try {
            const found = await transport.findAdoption(predecessor, row.entry);
            if (!active()) break;
            if (found) {
              const prior = parseAdoptedEvent(found);
              if (!matchesParent(row.entry, prior)) refuse('PredecessorBindingRefused');
              await store.keepCommitEvidence(predecessor, prior);
              if (!active()) break;
              kept.set(predecessor, prior);
            }
          } catch { if (!active()) break; }
        }
        if (predecessor !== null && (!kept.has(predecessor) || !matchesParent(row.entry, kept.get(predecessor)!))) {
          await set(row.eventId, 'held', { waitingFor: predecessor, reason: 'predecessor-unresolved' });
          if (!list.some(r => r.eventId === predecessor && ['conflict', 'refused', 'corrupt'].includes(state.get(r.eventId)!))) retry.add(row.eventId);
          blockedRecords.add(record); continue;
        }
        const attempt = (attempts.get(row.eventId) ?? 0) + 1;
        attempts.set(row.eventId, attempt);
        const currentAttempt = () => active() && attempts.get(row.eventId) === attempt && !committed.has(row.eventId);
        let answer: Record<string, any>;
        try { const reply = await transport.submit(row.entry); answer = object(reply, ['eventId', 'status', 'reason', 'recoveryRef', 'currentVersion', 'times', ...(Object.prototype.hasOwnProperty.call(reply, 'adoption') ? ['adoption'] : [])]); }
        catch (signal) {
          if (!currentAttempt()) continue;
          if ((signal as { kind?: string })?.kind && classifySessionSignal(signal) === 'awaiting-reauth') {
            for (const r of list) if (['pending', 'sent-unknown', 'held'].includes(state.get(r.eventId)!)) await set(r.eventId, 'awaiting-reauth', null);
            break;
          }
          // The request may have reached the server; the next attempt resends the same eventId and reads the receipt.
          await set(row.eventId, 'sent-unknown', null);
          retry.add(row.eventId); blockedRecords.add(record);
          continue;
        }
        if (!currentAttempt()) continue;
        if (answer.eventId !== row.eventId) refuse('ResponseBindingRefused');
        const status = choice(answer.status, ['committed', 'duplicate', 'conflict', 'held', 'refused', 'failed']);
        const next: QueueState = status === 'duplicate' ? 'committed' : status === 'failed' ? 'pending' : status;
        if (next === 'committed') {
          try {
            const adopted = ownAdoption(answer.adoption, row.entry);
            await store.keepCommitEvidence(row.eventId, adopted);
            if (!currentAttempt()) continue;
            kept.set(row.eventId, adopted);
          } catch {
            if (!currentAttempt()) continue;
            await set(row.eventId, 'sent-unknown', null); retry.add(row.eventId); blockedRecords.add(record); continue;
          }
        } else {
          blockedRecords.add(record);
          if (next === 'pending' || (next === 'held' && answer.reason === 'predecessor-unresolved')) retry.add(row.eventId);
        }
        await set(row.eventId, next, answer);
      }
      return freeze(list.map(r => ({ eventId: r.eventId, state: state.get(r.eventId)!, retryable: retry.has(r.eventId) })));
    },

    /** Local custody ends only with the server's verified retention receipt for this exact committed entry. */
    async acknowledgeRetention(eventId: string, receipt: unknown, verifier: RetentionReceiptVerifier): Promise<boolean> {
      const row = (await rows()).find(r => r.eventId === string(eventId));
      if (!row || !row.entry || row.state !== 'committed') return false;
      const verified = verifier.verify(receipt, row.entry) === true;
      if (!mayRemoveLocalOriginal('server-retention-receipt', { eventId, verified }, row.entry.eventId)) return false;
      const adoption = (await keptCommits()).find(a => a.eventId === eventId);
      if (!adoption) return false;
      await store.keepCommitEvidence(eventId, adoption);
      await store.remove(eventId, receipt);
      return true;
    },

    /** Cache eviction, logout, grant expiry and draft end: unsent originals stay. Returns what was kept. */
    async evict(cause: 'cache-evicted' | 'logout' | 'grant-expired' | 'draft-purpose-ended'): Promise<readonly string[]> {
      const list = await rows();
      const kept: string[] = [];
      for (const row of list) {
        if (row.entry && mayRemoveLocalOriginal(cause, null, row.entry.eventId)) await store.remove(row.eventId, null);
        else kept.push(row.eventId);
      }
      return freeze(kept);
    },
  });
}
