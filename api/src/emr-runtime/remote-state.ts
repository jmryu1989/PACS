import { AccessEvent, AccessStream, DurableAccessReceipt, accessStreams } from '../emr-contract/access-event';
import { ResolvedRecord } from '../emr-contract/classification';
import { ContractError, refuse } from '../emr-contract/validation';
import { StoredEntry, canonicalPayload, mintDurableReceipt } from './contract';
import { JournalKind } from './journal-file';
import { CommitBinding, SealRefused } from './seal';
import { StateClient } from './state-client';
import { BundleIdentity, ClientIdentity, ExpiryPrefix, HelloResult, Reservation, SealedBundleProof, StateOperation,
  StateProtocolError, StateResults, StateValues } from './state-protocol';
import { LedgerAttempt, LedgerFailure, LedgerScope, LedgerState, PrismaLedgerSql, ProvisionalAppend, ledgerErrorCode,
  isConnectionError } from './store';

/**
 * EMR-B2 (c): the API's view of the protected state - only the caller operations of one admitted session over the
 * typed StateClient (hello/begin/reserve/confirm-bundle/lookup-outcome/journal-record/acknowledge/end). Nothing here
 * can start, recover, mount, promote or close the owner: the service alone holds the fence, the files and recovery,
 * and a lost control session is the API's detection point (the client's `unavailable` signal), never a reconnection.
 * The store (store.ts) consumes this through the LedgerState/LedgerScope interface it shares with the B1 local owner.
 */
export interface RemoteSession extends HelloResult { serviceEpoch: string; clientInstanceId: string }

const bindingKeys = ['stream', 'chainId', 'attemptId', 'bundleId', 'kind', 'eventId', 'sequence', 'previousHash', 'hash',
  'contentSha256', 'generation', 'proofDigest'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class RemoteLedgerState implements LedgerState {
  private readonly identity: ClientIdentity;
  /** Exact full-proof acknowledgements this process could not deliver: the service retains their proofs (D1655). */
  unacknowledged = 0;
  constructor(private readonly client: StateClient, readonly session: RemoteSession, private readonly sql: PrismaLedgerSql) {
    this.identity = Object.freeze({ clientInstanceId: session.clientInstanceId, chains: Object.freeze({ ...session.chains }) });
  }
  get unavailable(): AbortSignal { return this.client.unavailable; }
  /** The service's own read-only status (state, chains, sealed frontier, counts): diagnostics and the probe, no authority. */
  status(): Promise<StateResults['status']> {
    return this.client.callAsync('status', null, this.identity);
  }
  /** One live remote scope per unit of recording work; refused once the control session is lost. */
  async begin(workId: string): Promise<LedgerScope> {
    if (this.client.unavailable.aborted) throw new SealRefused('SealUnavailable', 'state-service-lost');
    const { scope } = await this.client.callAsync('begin', workId, this.identity);
    return new RemoteLedgerScope(this.client, this.identity, workId, scope, this.sql, this);
  }
}

export class RemoteLedgerScope implements LedgerScope {
  private ending: Promise<void> | undefined;
  constructor(private readonly client: StateClient, private readonly identity: ClientIdentity, readonly workId: string,
    readonly scope: string, private readonly sql: PrismaLedgerSql, private readonly owner: RemoteLedgerState) {}

  private call<O extends Exclude<StateOperation, 'hello' | 'begin' | 'status'>>(operation: O,
    value: Omit<StateValues[O], 'clientInstanceId' | 'chains' | 'scope'>): Promise<StateResults[O]> {
    return this.client.callAsync(operation, this.workId, { ...this.identity, scope: this.scope, ...value } as StateValues[O]);
  }

  /** The service's durable reservation under the caller's head lock; a typed conflict stays a typed refusal. */
  async reserve(binding: Reservation, prefix: ExpiryPrefix | null = null): Promise<CommitBinding> {
    try { return await this.call('reserve', { binding, prefix }); }
    catch (error) {
      if (error instanceof StateProtocolError && error.code === 'CONFLICT') refuse('AccessEventIdConflict');
      throw error instanceof StateProtocolError ? new SealRefused('SealUnavailable', error.code) : error;
    }
  }

  /**
   * After the caller's COMMIT: the service proves every required stream from storage, seals it and publishes one
   * complete attestation; this process revalidates that proof against its own exact bindings before minting the
   * receipt. A lost or refused reply proves nothing: the service's fenced knowledge is asked once, and anything short
   * of a committed-and-sealed proof or a fenced absence stays unknown - journaled, never a success, never a resend.
   */
  async confirm(appended: ProvisionalAppend): Promise<DurableAccessReceipt> {
    const bundle = bundleOf(appended);
    let proof: SealedBundleProof;
    try { proof = await this.call('confirm-bundle', bundle); }
    catch (error) {
      if (!(error instanceof StateProtocolError)) throw error;
      if (error.code === 'CONFLICT') {
        await this.note(appended.eventId, 'append-rolled-back', 'ledger-refused', bundle.bindings[0].attemptId);
        refuse('DurableReceiptRefused');
      }
      let outcome: StateResults['lookup-outcome'] | null = null;
      try { outcome = await this.call('lookup-outcome', bundle); } catch { outcome = null; }
      if (outcome?.outcome === 'committed-and-sealed') proof = outcome.proof;
      else if (outcome?.outcome === 'fenced-not-committed') {
        await this.note(appended.eventId, 'append-rolled-back', 'ledger-refused', bundle.bindings[0].attemptId);
        throw new LedgerFailure('AppendNotCommitted');
      } else {
        await this.note(appended.eventId, 'ledger-unavailable', 'commit-unknown', bundle.bindings[0].attemptId);
        throw new LedgerFailure('CommitUnknown', error.code);
      }
    }
    verifyProof(appended, bundle, proof);
    const viewing = appended.entries.findIndex(entry => entry.stream === 'viewing');
    const receipt = mintDurableReceipt(storedEntry(appended, viewing), proof.entries[viewing].sealed);
    // Exact full-proof acknowledgement minimizes the retained attestation (D1655). A lost ack keeps the proof;
    // the exact retry is the service's, so a failure here is counted and never turns a proven receipt into an error.
    try { await this.call('acknowledge', { proof, bindings: bundle.bindings }); }
    catch { this.owner.unacknowledged++; }
    return receipt;
  }

  /**
   * A transaction that did not report a commit (store.ts settle): a proven callback rollback journals its own attempt;
   * the service settles the reservation at its next fenced recovery - no client-requested negative retirement. An
   * unknown response is journaled as unknown; absence is never concluded from an empty live read.
   */
  async settle(input: AccessEvent, error: unknown, served?: readonly ResolvedRecord[], rolledBack = false, attempt?: LedgerAttempt): Promise<void> {
    const streams = accessStreams(input, served);
    if (rolledBack) {
      const eventId = canonicalPayload(input, served, streams[0]).event.eventId;
      const cause = error instanceof SealRefused ? 'seal-unavailable' : ledgerErrorCode(error) || error instanceof ContractError ? 'ledger-refused' : isConnectionError(error) ? 'ledger-unreachable' : 'business-rollback';
      await this.note(eventId, 'append-rolled-back', cause, attempt?.attemptId);
      return;
    }
    let eventId = '', unknown = false, other = false;
    for (const stream of streams) {
      const { event, contentSha256 } = canonicalPayload(input, served, stream);
      eventId = event.eventId;
      let stored: StoredEntry | null | undefined;
      try { stored = await this.sql.entryForEvent(stream, eventId); } catch { stored = undefined; }
      if (stored === undefined || (stored && stored.contentSha256 === contentSha256)) unknown = true;
      else if (stored) other = true;
    }
    if (unknown) { await this.note(eventId, 'ledger-unavailable', 'commit-unknown', attempt?.attemptId); return; }
    if (other) { await this.note(eventId, 'append-rolled-back', 'ledger-refused', attempt?.attemptId); return; }
    await this.note(eventId, 'ledger-unavailable', 'commit-unknown', attempt?.attemptId);
  }

  /** Idempotent by id and body on the service's journal; without it there is no surviving record: never a success. */
  private async note(eventId: string, kind: JournalKind, cause: string, attemptId = `unassigned:${eventId}`, stream: AccessStream | 'transaction' = 'transaction'): Promise<void> {
    try { await this.call('journal-record', { id: `${kind}:${stream}:${attemptId}:${cause}`, kind, body: { eventId, cause } }); }
    catch (error) {
      const code = error instanceof StateProtocolError ? error.code : null;
      throw new LedgerFailure('LedgerUnreachable', code === 'CAPACITY' ? 'FailureJournalFull' : 'FailureJournalUnavailable');
    }
  }

  /** The scope's end, once; a lost session has already ended it on the service side. */
  end(): Promise<void> {
    return this.ending ??= this.call('end', {}).then(() => undefined, () => undefined);
  }
}

function bundleOf(appended: ProvisionalAppend): BundleIdentity {
  const bindings = appended.entries.map(entry => entry.binding ?? refuse('DurableReceiptRefused'));
  return { eventId: appended.eventId, requiredStreams: appended.entries.map(entry => entry.stream), bindings };
}
function storedEntry(appended: ProvisionalAppend, index: number): StoredEntry {
  const provisional = appended.entries[index];
  if (!provisional || provisional.stream !== 'viewing') refuse('DurableReceiptRefused');
  return { sequence: provisional.sequence, hash: provisional.hash, previousHash: provisional.previousHash, payload: provisional.payload,
    contentSha256: provisional.contentSha256, storedAt: provisional.storedAt, kind: 'access', eventId: appended.eventId, statutoryAct: null };
}
/** The returned proof is evidence, not authority: every expected stream, binding field and coverage is checked here. */
function verifyProof(appended: ProvisionalAppend, bundle: BundleIdentity, proof: SealedBundleProof): void {
  if (proof.eventId !== appended.eventId || !same(proof.requiredStreams, bundle.requiredStreams) ||
    proof.entries.length !== bundle.bindings.length) refuse('DurableReceiptRefused');
  for (let i = 0; i < bundle.bindings.length; i++) {
    const expected = bundle.bindings[i], actual = proof.entries[i], provisional = appended.entries[i];
    if (bindingKeys.some(key => expected[key] !== actual[key]) || actual.sealed.chainId !== expected.chainId ||
      actual.sealed.sequence < expected.sequence || (actual.sealed.sequence === expected.sequence && actual.sealed.hash !== expected.hash) ||
      provisional.sequence !== expected.sequence || provisional.hash !== expected.hash || provisional.contentSha256 !== expected.contentSha256)
      refuse('DurableReceiptRefused');
  }
}
