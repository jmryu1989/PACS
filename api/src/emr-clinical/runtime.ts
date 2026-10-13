import { AuthorizedResponse, ClinicalResponseSelector, ResponseContext, clinicalResponse } from './response';
import { randomUUID } from 'node:crypto';
import { AccessEvent, AccessEventV1, AccessTarget, DurableAccessReceipt, EvidenceFact, ImmutableIdentity, WorkContext, newAuditLinkId,
  parseAccessEvent, provideAfterDurableEvent } from '../emr-contract/access-event';
import { ContractError, freeze, integer, refuse, string } from '../emr-contract/validation';
import type { ProvisionalAppend } from '../emr-runtime/store';
import { inspectEnvelopeV2 } from '../emr-signature/canonical-v2';
import type { SignatureVerificationPorts } from '../emr-signature/verify';
import { ActorFacts, CLINICAL_SURFACES, ClinicalUnit, READ_ROUTES, StudyFacts, SurfaceSpec } from './contract';
import {
  CommitOutcome, PreparedSr, ReadPlan, RequestIdentity, RequestObservation, WriteInput, commitClinicalWrite, decideRequestOutcome, institutionAdmits, planClinicalRead,
  planClinicalWrite, planManualSrAdoption, planManualSrCleanup, prepareClinicalWrite, provideClinicalReads, reconcileManualSr, recoverClinicalWrite,
} from './records';
import {
  ClinicalServicePort, ClinicalWriteRequest, ClinicalWriteResult,
  ManualSrAdoption, ManualSrAdoptionRequest, SrAdoptionFact, bindClinicalPort, clinicalServices, clinicalRuntime as boundPort,
} from './services';
import { SignedEnvelope, deviceSignaturePort } from './signing';
import { requireClinicalSourceComposition } from './sources';
import {
  ClinicalDatabase, ClinicalFacts, ClinicalLedger, SqlClinicalStore, clinicalSqlState, readSrAdoption, readSrAdoptionRecord, readSrPurposeEnds, unitFromRows,
} from './store';

/**
 * EMR-D: the one server composition of unit D. Server start (B2's main.ts, after B1's ledger and C2's verification ports
 * exist) calls composeClinicalRuntime exactly once, which binds this runtime as the owning services' port (services.ts);
 * they refuse with 503 EMR_CLINICAL_RUNTIME_REQUIRED while nothing is composed - there is no unsigned or unledgered
 * fallback path for a clinical write or for a response that carries clinical text.
 *
 * Every fact comes from a server port: the verified actor, ingress and the carried device signature from B2/C (context),
 * the patient link snapshot and managing institution of the study from C (studies), the key/anchor/policy readers
 * from C (signatures), the ledger from B1. A request body is only the request's own meaning (records.ts refuses claims).
 */

/** B2 (verified authentication context) and C (device signature channel) for one HTTP request. */
export interface ClinicalRequestFacts {
  actor: ActorFacts;
  trustedProxyIp: EvidenceFact<{ address: string; source: 'trusted-proxy' }>;
  requestId: string;
  /** The immutable identity of another member of the same verified issuer (a consultation recipient, an assigned reader). */
  member(subject: string): Promise<ImmutableIdentity>;
  /** The device signature that came with this request, or null. */
  signature: { jws: unknown; osUserId: string } | null;
}
export interface ClinicalContextSource { facts(request: unknown): Promise<ClinicalRequestFacts> }
/** C's clinical study reader: the managing institution and the patient link snapshot of a study, read in `db`. */
export interface ClinicalStudySource { facts(db: ClinicalDatabase, studyId: string): Promise<StudyFacts> }
export interface ClinicalRuntimeParts {
  /** The EMR ledger client (B1 EmrLedgerClient): D's reads and B1's commit transactions share it. */
  db: ClinicalDatabase;
  ledger: ClinicalLedger;
  context: ClinicalContextSource;
  studies: ClinicalStudySource;
  signatures: SignatureVerificationPorts;
  /** Delay before an unknown outcome is recovered in-process; the restart scan covers a dead process. */
  recoveryDelayMs?: number;
}

export type { ClinicalWriteRequest, ClinicalWriteResult };

const known = <T>(value: T) => ({ status: 'known' as const, value });
const sleep = (ms: number) => new Promise<void>(resolve => { const t = setTimeout(resolve, ms); (t as any).unref?.(); });
/** How long a call waits for another call of the same request that is still executing it (its answer is this one's). */
const SETTLE_MS = 5000;
/** Targets per provide-prepared event: one ledger entry holds at most 64 KiB, a target at most about 0.7 KiB. */
const TARGETS_PER_EVENT = 64;

export class ClinicalRuntime implements ClinicalServicePort {
  readonly store: SqlClinicalStore;
  private readonly recovering = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly parts: ClinicalRuntimeParts) {
    this.store = new SqlClinicalStore(parts.db, parts.ledger);
    this.store.onWake(request => this.scheduleRecovery(request));
  }

  private signaturePort() {
    return deviceSignaturePort(this.parts.signatures, originalId => this.store.carriedSignature(originalId));
  }

  /**
   * One clinical write (records.ts commitClinicalWrite) with every server fact bound here. A request already registered is
   * answered by its own stored outcome first (DR3-01): at any later revision of the unit, whatever happened to its parties
   * since, nothing of it is resolved, checked or signed again - only another meaning under its request ID is refused.
   */
  async write(request: unknown, w: ClinicalWriteRequest): Promise<ClinicalWriteResult> {
    const spec: SurfaceSpec = CLINICAL_SURFACES[w.surface];
    if (!spec) refuse('ClinicalSurfaceUnknown');
    const facts = await this.parts.context.facts(request);
    // The service's own row checks ran for the guard's caller; a different verified person never writes through them.
    if (facts.actor.identity.subject !== w.caller?.subject || facts.actor.institutionId !== w.caller?.institutionId) refuse('OwnerChanged');
    const unit = await this.store.unit(string(w.recordId));
    const study = await this.parts.studies.facts(this.parts.db, string(w.studyId));
    const registered = await this.registered(this.identityOf(facts, w, unit, study), unit, w.recordId);
    if (registered) return registered;
    // The atomic register lock elects the sole admission owner before any mutable member/source check.
    // An absent preliminary observation is only a hint: claim() observes again under that lock.
    const identityInput: WriteInput = {
      surface: w.surface, actor: facts.actor, study, unit, body: w.body, content: w.content ?? null, attachments: [], navigation: [],
      recipientId: null, readerId: null, workContext: null,
      ids: { recordId: w.recordId, versionId: randomUUID() }, at: new Date().toISOString(),
    };
    let originalId: string | null = null, outcome: CommitOutcome;
    const port = this.store.port(null as any, null);
    port.admitOrObserve = (identity, _seed, attemptId) => this.store.claim(identity, attemptId, async () => {
      const admitted = w.prepare ? await w.prepare() : null;
      const projection = admitted?.projection ?? (w.admission ? await w.admission() : w.projection);
      const recipientId = w.recipientSubject ? (await facts.member(w.recipientSubject)).id : null;
      const readerId = w.readerSubject ? (await facts.member(w.readerSubject)).id : null;
      const currentUnit = await this.store.unit(w.recordId);
      const currentStudy = await this.parts.studies.facts(this.parts.db, w.studyId);
      const versionId = facts.signature ? inspectEnvelopeV2(facts.signature.jws).payload.versionId : randomUUID();
      const seed: WriteInput = {
        ...identityInput, study: currentStudy, unit: currentUnit,
        content: admitted?.content ?? w.content ?? null, attachments: admitted?.attachments ?? w.attachments ?? [],
        navigation: admitted?.navigation ?? w.navigation ?? [],
        recipientId: spec.record === 'consultation' && currentUnit === null ? recipientId : null,
        readerId: spec.record === 'assignment' ? readerId : null,
        workContext: w.reading ? { kind: 'reading', studyId: study.studyId, referenceId: string(w.reading.referenceId) } : null,
        ids: { recordId: w.recordId, versionId }, at: new Date().toISOString(),
      };
      // No prepared signature means no registration; normal signing can reuse the same request ID.
      let signing = false;
      try { signing = planClinicalWrite(seed).signing !== null; } catch { /* planning seals its own typed refusal after admission */ }
      if (signing && !facts.signature) refuse('SignatureRequired');
      const requestId = (w.body as any)?.[spec.requestField ?? 'requestId'];
      const signature: SignedEnvelope | null = facts.signature ? { jws: facts.signature.jws as any,
        osUserId: facts.signature.osUserId, eventId: string(requestId).toLowerCase() } : null;
      const clinical: ClinicalFacts = { event: { rolesAtTime: [...facts.actor.roles], trustedProxyIp: facts.trustedProxyIp,
        requestId: facts.requestId, reading: !!w.reading }, projection };
      return { seed, facts: clinical, signature };
    }, id => { originalId = id; });
    try {
      outcome = await commitClinicalWrite({ store: port, signature: this.signaturePort() }, identityInput);
    } finally { this.store.release(originalId); }

    // Not this call's original: another call of the same request (a parallel duplicate, a resend while the first still
    // runs) executes it, and its decided result is this call's result as well.
    if (originalId === null && outcome.status === 'unknown') outcome = await this.settle(prepareClinicalWrite(identityInput), outcome);
    return this.answered(prepareClinicalWrite(identityInput), outcome, unit, w.recordId);
  }

  /** The request identity of a write (register key and fingerprint): the body's meaning only, no party or source resolved. */
  private identityOf(facts: ClinicalRequestFacts, w: ClinicalWriteRequest, unit: Readonly<ClinicalUnit> | null, study: StudyFacts): RequestIdentity | null {
    try {
      return prepareClinicalWrite({ surface: w.surface, actor: facts.actor, study, unit, body: w.body, content: w.content ?? null, attachments: [],
        navigation: [...(w.navigation ?? [])], recipientId: null, readerId: null, workContext: null, ids: { recordId: w.recordId, versionId: randomUUID() },
        at: new Date().toISOString() });
    } catch { return null; }   // refused by the full path below, with its journal entry
  }
  /**
   * The stored outcome of a registered request (settled for a bounded time when another call still executes it), or null
   * when the register holds no such request. A register that cannot be read leaves the outcome unknown (the same request
   * again), never a new admission; another meaning under the request ID is refused (RequestIdReused).
   */
  private async registered(identity: RequestIdentity | null, unit: Readonly<ClinicalUnit> | null, recordId: string): Promise<ClinicalWriteResult | null> {
    if (!identity) return null;
    let observed: RequestObservation;
    try { observed = await this.store.observe(identity, randomUUID(), true); }
    catch (error) {
      if (error instanceof ContractError && error.code === 'RequestIdReused') throw error;
      await this.store.noteAttempt({ attemptId: randomUUID(), request: identity, originalId: null, code: 'ObservationUnavailable' }).catch(() => {});
      return freeze({ outcome: freeze({ status: 'unknown' as const, code: 'OutcomeUnknown', retry: 'same-request' as const }), unit, projection: null });
    }
    if (observed.state === 'absent') return null;
    const outcome = await this.settle(identity, decideRequestOutcome(identity, observed, 'observer'));
    if (outcome.status === 'unknown') this.scheduleRecovery(identity);
    return this.answered(identity, outcome, unit, recordId);
  }
  /**
   * A decided outcome with the unit as it now is and the projection facts kept with the committed original (the owning
   * service's own, for an answer bound to that request). Storage that cannot be read now leaves the answer unknown.
   */
  private async answered(identity: RequestIdentity, outcome: CommitOutcome, unit: Readonly<ClinicalUnit> | null, recordId: string): Promise<ClinicalWriteResult> {
    if (outcome.status !== 'committed' && outcome.status !== 'replayed') return freeze({ outcome, unit, projection: null });
    try {
      return freeze({ outcome, unit: await this.store.unit(recordId), projection: await this.store.projectionOf(identity) });
    } catch {
      return freeze({ outcome: freeze({ status: 'unknown' as const, code: 'OutcomeUnknown', retry: 'same-request' as const }), unit, projection: null });
    }
  }

  /** The decided outcome of a request another call is still executing, waited for a bounded time; else `outcome` as it is. */
  private async settle(identity: RequestIdentity, outcome: CommitOutcome): Promise<CommitOutcome> {
    let wait = 50;
    for (let spent = 0; outcome.status === 'unknown' && spent < SETTLE_MS; spent += wait, wait = Math.min(wait * 2, 800)) {
      await new Promise<void>(resolve => setTimeout(resolve, wait));
      try { outcome = decideRequestOutcome(identity, await this.store.observe(identity, randomUUID(), false), 'observer'); }
      catch { return outcome; }
    }
    return outcome;
  }

  /**
   * The stored outcome of a write's request ID when one is registered, else null - before any expensive or locking
   * preparation (the finding's source copy). It never plans, signs or commits.
   */
  async lookup(request: unknown, w: ClinicalWriteRequest): Promise<CommitOutcome | null> {
    const facts = await this.parts.context.facts(request);
    if (facts.actor.identity.subject !== w.caller?.subject || facts.actor.institutionId !== w.caller?.institutionId) refuse('OwnerChanged');
    const study = await this.parts.studies.facts(this.parts.db, string(w.studyId));
    const unit = await this.store.unit(string(w.recordId));
    const input: WriteInput = { surface: w.surface, actor: facts.actor, study, unit, body: w.body, content: w.content ?? null, attachments: [],
      navigation: [...(w.navigation ?? [])], recipientId: null, readerId: null, workContext: null, ids: { recordId: w.recordId, versionId: randomUUID() },
      at: new Date().toISOString() };
    const identity = prepareClinicalWrite(input);
    const observed = await this.store.observe(identity, randomUUID(), true);
    if (observed.state === 'absent') return null;
    return this.settle(identity, decideRequestOutcome(identity, observed, 'observer'));
  }

  /**
   * The server's recovery of one original (never an HTTP retry): restart scan, or an unknown outcome after a delay. The
   * original this recovery took over is released however it ends - committed, sealed, an unavailable store or an
   * exception - so the next recovery can resume it; a write or recovery still executing it in this process is never
   * fenced (the store answers it as an observer).
   */
  async recover(request: RequestIdentity): Promise<CommitOutcome> {
    let acquired: string | null = null;
    try {
      return await recoverClinicalWrite({ store: this.store.recoveryPort(id => { acquired = id; }), signature: this.signaturePort() }, request);
    } finally { this.store.release(acquired); }
  }
  private scheduleRecovery(request: RequestIdentity): void {
    const key = JSON.stringify([request.receiptKey.record, request.receiptKey.actorId, request.receiptKey.requestId]);
    if (this.recovering.has(key)) return;
    this.recovering.add(key);
    void sleep(this.parts.recoveryDelayMs ?? 5000).then(() => this.recover(request)).catch(() => {}).finally(() => this.recovering.delete(key));
  }
  /** Restart scan: every pending original and every committed one whose ledger receipt is not yet durable. */
  async recoverOpen(limit: number = 100): Promise<number> {
    const open = await this.store.openRequests(limit);
    for (const request of open) await this.recover(request).catch(() => {});
    const rows = await this.parts.db.$queryRaw<{ record_id: string }[]>`SELECT * FROM emr_clinical.open_sr_adoptions(${integer(limit, 1)}::integer)`;
    // The adoption stays unconfirmed (never reported as stored) until the next scan or the author's resend confirms it.
    for (const row of rows) await this.confirmedSrAdoption(row.record_id).catch(() => {});
    return open.length + rows.length;
  }
  start(intervalMs = 60000): void {
    if (this.timer) return;
    void this.recoverOpen().catch(() => {});
    this.timer = setInterval(() => { void this.recoverOpen().catch(() => {}); }, intervalMs);
    (this.timer as any).unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** The unit with its whole history in the runtime's own client, or null. */
  unit(recordId: string): Promise<Readonly<ClinicalUnit> | null> { return this.store.unit(recordId); }

  respond(request: unknown, selector: ClinicalResponseSelector, context: ResponseContext): Promise<AuthorizedResponse> {
    return clinicalResponse(this.parts, request, selector, context);
  }

  /**
   * A manual SR store intent: the author's device signature over the exact SOP and DICOM bytes (records.ts
   * planManualSrAdoption), verified by C, then ONE transaction with the adoption, the owning service's intent rows
   * (`project`) and the access event. No signature, no intent: nothing is uploaded. The receipt is null when the
   * adoption committed but B1 could not make its event durable yet (confirmedSrAdoption completes it).
   */
  async adoptManualSr(request: unknown, a: ManualSrAdoptionRequest): Promise<ManualSrAdoption> {
    const facts = await this.parts.context.facts(request);
    // The row's author is a subject of the guard; the adoption's author is the verified immutable identity of that subject.
    if (facts.actor.identity.subject !== a.sr.authorSubject) refuse('ActorPathRefused');
    if (!facts.signature) refuse('SignatureRequired');
    const study = await this.parts.studies.facts(this.parts.db, string(a.studyId));
    const versionId = inspectEnvelopeV2(facts.signature.jws).payload.versionId;
    const { authorSubject: _subject, ...rest } = a.sr;
    const sr: PreparedSr = { ...rest, authorId: facts.actor.identity.id };
    const plan = planManualSrAdoption({ actor: facts.actor, study, sr, versionId, at: new Date().toISOString() });
    const carried: SignedEnvelope = { jws: facts.signature.jws as any, osUserId: facts.signature.osUserId, eventId: a.sr.id };
    const port = deviceSignaturePort(this.parts.signatures, () => carried);
    const signed = await port.sign(plan.signing, { originalId: `manual-sr:${a.sr.id}` }) as SignedEnvelope;
    const evidence = await port.verify(signed, plan.signing);
    const event = parseAccessEvent({ formatVersion: 1, surface: plan.access.route, eventId: `clinical-sr:${a.sr.id}`, userId: known({ ...facts.actor.identity }),
      rolesAtTime: known([...facts.actor.roles]), actingInstitution: known(facts.actor.institutionId), managingInstitution: known(study.managingInstitutionId),
      occurredAt: plan.adoption.at, trustedProxyIp: facts.trustedProxyIp, cause: 'user-view',
      context: { basis: 'worklist', studyId: study.studyId, relatedStudyId: null, reason: null }, executor: 'member',
      targets: [{ kind: 'manual-sr', patientLinkSnapshot: known({ ...study.patient }), studyId: known(study.studyId), recordId: known(a.sr.id),
        versionId: known(versionId) }], action: 'write', result: 'succeeded', requestId: facts.requestId, auditLinkId: newAuditLinkId(), relatedEventId: null } as AccessEventV1);
    const inspected = inspectEnvelopeV2(signed.jws);
    const signature = JSON.stringify({ envelope: signed, evidence, signed: { kid: inspected.kid, signedAt: inspected.payload.signedAt } });
    let appended: ProvisionalAppend, transaction: object, callbackFailed = false;
    try {
      appended = await this.parts.ledger.withAppendTransaction(async tx => {
        transaction = tx;
        try {
          await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
          await tx.$queryRaw`SELECT emr_clinical.adopt_sr(${string(a.sr.id)}::text, ${string(versionId)}::text, ${string(plan.adoption.sha256)}::text,
            ${string(a.sr.bytesSha256)}::text, ${string(a.sr.sopInstanceUid)}::text, ${string(study.studyId)}::text,
            ${string(study.managingInstitutionId)}::text, ${JSON.stringify(plan.adoption)}::text, ${signature}::text,
            ${JSON.stringify(event)}::text)::text AS done`;
          await a.project(tx);
          return await this.parts.ledger.appendInTransaction(tx, event);
        } catch (error) { callbackFailed = true; throw error; }
      });
    } catch (error) {
      try { await this.parts.ledger.settleTransaction(transaction, event, error, callbackFailed); } catch { /* journal only */ }
      // A concurrent store of the same SR committed its signed adoption first: this attempt changed nothing.
      if (clinicalSqlState(error) === 'ED006') return freeze({ adopted: 'earlier' as const, receipt: null });
      throw error;
    }
    let receipt: DurableAccessReceipt | null = null;
    try {
      receipt = await this.parts.ledger.confirm(appended);
      await this.parts.db.$queryRaw`SELECT emr_clinical.confirm_sr(${string(a.sr.id)}::text)::text AS done`;
    } catch { receipt = null; /* committed; confirmedSrAdoption or the restart scan completes it before anything is published */ }
    return freeze({ adopted: 'now' as const, receipt });
  }

  /** The signed adoption of a prepared SR, or null (the reference fact for clean-up and reconciliation). */
  srAdoption(recordId: string) { return readSrAdoption(this.parts.db, recordId); }
  /**
   * The signed adoption, made durable: when its committed access event has no durable receipt yet, the same event is
   * appended again (B1 seals its committed entry; never a second event) and the adoption is confirmed. Null without an
   * adoption; a ledger or storage failure throws - the adoption then stays unconfirmed and nothing may be published.
   */
  async confirmedSrAdoption(recordId: string): Promise<SrAdoptionFact | null> {
    const stored = await readSrAdoptionRecord(this.parts.db, recordId);
    if (!stored) return null;
    if (stored.fact.confirmed) return stored.fact;
    await this.parts.ledger.append(parseAccessEvent(stored.accessEvent) as AccessEvent);
    await this.parts.db.$queryRaw`SELECT emr_clinical.confirm_sr(${string(recordId)}::text)::text AS done`;
    return freeze({ ...stored.fact, confirmed: true });
  }
  /** The prepared SRs among `recordIds` whose purpose end is already recorded. */
  srPurposeEnds(recordIds: readonly string[]): Promise<ReadonlySet<string>> { return readSrPurposeEnds(this.parts.db, recordIds); }
  /** Retained versions that incorporate or cite this record (the reference index). */
  referencesTo(recordId: string) { return this.store.referencesTo(recordId); }
  /** records.ts planManualSrCleanup: which expired copies reach their purpose end (the rest is kept). */
  planSrCleanup(facts: readonly PreparedSr[], at: string) { return planManualSrCleanup(facts, at); }
  /** records.ts reconcileManualSr: whether Orthanc's observation of an attempted SR adopts it. */
  reconcileSr(facts: PreparedSr, observation: unknown) { return reconcileManualSr(facts, observation); }
  /** Legal hold IDs on a record, read through B1's own adapter (D issues no emr_access SQL), for the clean-up's hold check. */
  async holdIds(recordId: string): Promise<readonly string[]> {
    const rows = await this.parts.ledger.holdRows(this.parts.db, string(recordId));
    const released = new Set(rows.filter(r => r.phase === 'released').map(r => r.holdId));
    return [...new Set(rows.filter(r => r.phase === 'placed' && !released.has(r.holdId)).map(r => r.holdId))].sort();
  }
}

let composed: ClinicalRuntime | null = null;
/**
 * Server start only, once (B2's main.ts), after composeEmrAdapters bound A's stored-record reader with D's sources
 * (sources.ts clinicalStoredReader): without it no write could cite what it incorporates, so nothing is composed. A second
 * composition is refused; nothing per request can replace a port. The owning services see the runtime only as their
 * port (services.ts bindClinicalPort).
 */
export function composeClinicalRuntime(parts: ClinicalRuntimeParts): ClinicalRuntime {
  if (composed || boundPort()) refuse('ClinicalRuntimeAlreadyComposed');
  for (const key of ['db', 'ledger', 'context', 'studies', 'signatures'] as const) if (!parts?.[key]) refuse('ClinicalRuntimePartRequired');
  requireClinicalSourceComposition();
  // The set of parts is fixed (a shallow freeze): the clients and stores themselves stay live objects.
  const runtime = new ClinicalRuntime(Object.freeze({ ...parts }) as ClinicalRuntimeParts);
  bindClinicalPort(runtime);
  composed = runtime;
  return composed;
}
export function clinicalRuntime(): ClinicalRuntime {
  if (!composed) refuse('EmrClinicalRuntimeRequired');
  return composed;
}
